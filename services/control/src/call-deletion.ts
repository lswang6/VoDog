import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { safeRollback, withClient, type Db } from './db.js';
import { recordingRequestHeaders } from './recording-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The node whose recordings live in this process's own RECORDING_ROOT, same rule as registerRecordingRoutes. */
export const LOCAL_MEDIA_NODE_ID = 'relay-primary';
const REMOTE_DELETE_TIMEOUT_MS = 15_000;

/**
 * S30 §1.1 eligibility. Deliberately *not* the retention policy: there is no "older than one hour"
 * clause, because a user deleting their own record is not the bounded reclaim job. Every other guard
 * is the same set as infra/retention.py CALL_GUARDS, plus the transcript and fresh-binding clauses.
 */
const AI_RUN_BUSY = ['pending', 'preparing', 'answer_committed', 'awaiting_active', 'active', 'ending', 'reconcile_unknown'] as const;
const PIXEL_ARCHIVE_BUSY = ['uploading', 'verifying'] as const;
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');
const DELETABLE_PREDICATE = `
  c.state IN ('ended','failed')
  AND NOT EXISTS (SELECT 1 FROM gateway_call_locks l WHERE l.call_id=c.id)
  AND NOT EXISTS (SELECT 1 FROM commands m WHERE m.call_id=c.id AND m.status='pending')
  AND NOT EXISTS (SELECT 1 FROM media_close_jobs j WHERE j.call_id=c.id AND j.completed_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM pixel_recording_archives p WHERE p.call_id=c.id AND p.state IN (${list(PIXEL_ARCHIVE_BUSY)}))
  AND NOT EXISTS (SELECT 1 FROM ai_call_runs a WHERE a.call_id=c.id AND a.state IN (${list(AI_RUN_BUSY)}))
  AND NOT EXISTS (SELECT 1 FROM transcript_jobs t WHERE t.call_id=c.id AND t.state='running')
  -- Just hung up with a capture binding and no archive row yet: the Pixel has not started its
  -- upload, so deleting now would leave the gateway retrying initialize against a missing call.
  AND NOT (
    EXISTS (SELECT 1 FROM recording_capture_bindings b WHERE b.call_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM pixel_recording_archives p2 WHERE p2.call_id=c.id)
    AND COALESCE(c.ended_at,c.started_at) > now() - interval '10 minutes'
  )`;

export type RemoteRecordingDeletion = 'deleted' | 'unsupported' | 'failed' | 'skipped';
export type CallDeletionFiles = { localRemoved: number; remote: RemoteRecordingDeletion };
export type CallDeletionResult =
  | { outcome: 'deleted'; files: CallDeletionFiles }
  | { outcome: 'not_found' }
  | { outcome: 'in_use' };

export interface CallDeletionLog {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}
export interface CallDeletionRecordingNodes {
  recordingBaseUrl(nodeId: string): string | undefined;
  recordingSecret(nodeId: string): string;
}
export interface CallDeletionDeps {
  /** Local media-node recordings root; when unset nothing local is reclaimed. */
  recordingRoot?: string | null;
  /** Pixel archive root; independent of PIXEL_ARCHIVE_ENABLED because old uploads outlive the flag. */
  pixelArchiveRoot?: string | null;
  /** S39 §5: parent of the per-node recording mirrors, `<root>/<nodeId>/<callId>`. */
  recordingBackupRoot?: string | null;
  nodes?: CallDeletionRecordingNodes | null;
  log?: CallDeletionLog | null;
  fetchImpl?: typeof fetch;
}

/**
 * Deletes one call record the user owns, then reclaims its bytes.
 *
 * The row is the contract: the single `DELETE` cascades every dependent table and nulls the replay
 * ledger's `commands.call_id` (S29 §2.1). File reclamation happens *after* the commit and can never
 * turn a committed deletion into an error — a failure is logged and reported in `files`. The caller
 * still awaits it, so a slow media node delays the 204 by up to the 15 s remote timeout.
 */
export async function deleteCallRecord(
  db: Db,
  deps: CallDeletionDeps,
  { callId, ownerId }: { callId: string; ownerId: string },
): Promise<CallDeletionResult> {
  if (!UUID.test(callId)) return { outcome: 'not_found' };
  const committed = await withClient(db, async (c) => {
    await c.query('BEGIN');
    try {
      // Existence and eligibility are decided inside one transaction so a 404 can never be reported
      // for a row that a concurrent writer merely made temporarily ineligible.
      const owned = await c.query(
        `SELECT COALESCE(media_node_id,'${LOCAL_MEDIA_NODE_ID}') media_node_id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2 FOR UPDATE`,
        [callId, ownerId],
      );
      if (!owned.rowCount) { await c.query('COMMIT'); return null; }
      const deleted = await c.query(
        `DELETE FROM call_records c WHERE c.id=$1 AND c.snapshot_owner_id=$2 AND ${DELETABLE_PREDICATE}`,
        [callId, ownerId],
      );
      await c.query('COMMIT');
      return deleted.rowCount ? { mediaNodeId: String(owned.rows[0].media_node_id) } : false;
    } catch (error) {
      await safeRollback(c);
      throw error;
    }
  });
  if (committed === null) return { outcome: 'not_found' };
  if (committed === false) return { outcome: 'in_use' };
  const files = await reclaimCallFiles(deps, callId, committed.mediaNodeId);
  // S39 §B: the single remote attempt's outcome is the retry queue infra/retention.py drains. A
  // refusal is recorded as `pending`, never `failed`, so it stays a candidate; `failed` is retention's
  // own verdict after its attempt ceiling. Losing this write only costs a retry, never the 204.
  try {
    await db.query(
      `UPDATE call_deletion_tombstones SET remote_recording_state=$2,remote_attempts=remote_attempts+1,
         remote_last_attempt_at=now() WHERE call_id=$1`,
      [callId, files.remote === 'failed' ? 'pending' : files.remote],
    );
  } catch (error) {
    deps.log?.warn({ callId, error: (error as Error)?.message }, 'remote recording deletion state was not recorded');
  }
  return { outcome: 'deleted', files };
}

async function reclaimCallFiles(deps: CallDeletionDeps, callId: string, mediaNodeId: string): Promise<CallDeletionFiles> {
  let localRemoved = 0;
  for (const root of [deps.recordingRoot, deps.pixelArchiveRoot, ...(await backupNodeRoots(deps))]) {
    if (!root) continue;
    if (await removeCallDirectory(deps, root, callId)) localRemoved += 1;
  }
  return { localRemoved, remote: await deleteRemoteRecording(deps, callId, mediaNodeId) };
}

/**
 * The mirror is laid out per media node, so every `<recordingBackupRoot>/<node>` is a recording root
 * in its own right and gets the same safety checks.
 * ponytail: races the hourly replicate job — a copy started before the row died can land afterwards.
 * Accepted: retention's orphan sweep collects it within a day, and a lock here would be a new
 * cross-process protocol for a once-a-day stray directory.
 */
async function backupNodeRoots(deps: CallDeletionDeps): Promise<string[]> {
  if (!deps.recordingBackupRoot) return [];
  try {
    const top = await lstat(deps.recordingBackupRoot);
    if (!top.isDirectory() || top.isSymbolicLink()) {
      deps.log?.warn({ root: deps.recordingBackupRoot }, 'call deletion refused an unsafe recording backup root');
      return [];
    }
    return (await readdir(deps.recordingBackupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(deps.recordingBackupRoot!, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT')
      deps.log?.warn({ root: deps.recordingBackupRoot, code: (error as NodeJS.ErrnoException)?.code }, 'call deletion could not list the recording backup root');
    return [];
  }
}

async function removeCallDirectory(deps: CallDeletionDeps, root: string, callId: string): Promise<boolean> {
  const dir = join(root, callId);
  try {
    const [rootStat, dirStat] = await Promise.all([lstat(root), lstat(dir)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      deps.log?.warn({ callId, dir }, 'call deletion refused an unsafe recording path');
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    deps.log?.warn({ callId, dir, code: (error as NodeJS.ErrnoException)?.code }, 'call deletion could not stat a recording directory');
    return false;
  }
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    deps.log?.warn({ callId, dir, code: (error as NodeJS.ErrnoException)?.code }, 'call deletion could not remove a recording directory');
    return false;
  }
}

/**
 * Asks a remote media node to drop the finalized directory it owns. The signature is the same
 * canonical string services/media authorizes GET reads with, with the method swapped and an empty
 * Range line — see services/media/recording_http.go recordingCanonicalString.
 */
async function deleteRemoteRecording(deps: CallDeletionDeps, callId: string, mediaNodeId: string): Promise<RemoteRecordingDeletion> {
  if (mediaNodeId === LOCAL_MEDIA_NODE_ID || !deps.nodes) return 'skipped';
  let baseUrl: string | undefined, secret = '';
  try {
    baseUrl = deps.nodes.recordingBaseUrl(mediaNodeId);
    secret = deps.nodes.recordingSecret(mediaNodeId);
  } catch {
    // An unconfigured node is not a failure of this deletion: retention's orphan sweep collects it.
    deps.log?.info({ callId, mediaNodeId }, 'call deletion skipped an unconfigured media node');
    return 'skipped';
  }
  if (!baseUrl || !secret) return 'skipped';
  const path = `/internal/recordings/${callId}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), REMOTE_DELETE_TIMEOUT_MS);
  const send = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(baseUrl + path, {
      method: 'DELETE',
      headers: recordingRequestHeaders(secret, 'DELETE', path),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    deps.log?.warn({ callId, mediaNodeId, error: (error as Error)?.message }, 'remote recording deletion did not reach the media node');
    return 'failed';
  } finally { clearTimeout(timer); }
  try { await response.body?.cancel(); } catch { /* the status is authoritative */ }
  if (response.status === 200 || response.status === 202 || response.status === 204) return 'deleted';
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    deps.log?.info({ callId, mediaNodeId, status: response.status }, 'media node does not support remote recording deletion');
    return 'unsupported';
  }
  deps.log?.warn({ callId, mediaNodeId, status: response.status }, 'remote recording deletion was refused');
  return 'failed';
}
