import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

// S30 §1: deleting a call record and deleting SMS are first-class user operations. Everything here
// is owner-scoped and every "in use" clause of §1.1 is proven one clause at a time — a 409 test that
// trips two guards at once proves nothing about either.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');

const PASSWORD = 'correct horse battery staple';
const config = {
  DATABASE_URL: databaseUrl, PUBLIC_ORIGIN: 'https://vodog.test', RP_ID: 'vodog.test',
  COOKIE_SECRET: 'test-only-cookie-secret-at-least-32-characters', GATEWAY_ONLINE_SECONDS: 30, PORT: 3198,
  AI_ENABLED: false, AI_WORKER_READY: false, MEDIA_DEFAULT_NODE_ID: 'relay-primary',
  MEDIA_SECRET: 'test-media-secret-at-least-32-characters', TURN_SECRET: 'test-turn-secret-at-least-32-characters',
  TRANSCRIPTION_ENABLED: false, TRANSCRIPTION_SCAN_INTERVAL_SECONDS: 5, TRANSCRIPTION_SCAN_BATCH: 2,
  COMMAND_REPLAY_HORIZON_ENABLED: false, COMMAND_REPLAY_MIGRATION_ENABLED: false,
};

let db: Db, app: FastifyInstance;
let owner: string, stranger: string;
let ownerToken: string, strangerToken: string;
let ownerGateway: Fixture, strangerGateway: Fixture;

type Fixture = {gatewayId: string; simId: string; deviceEpoch: number; deviceToken: string};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function login(username: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: PASSWORD, platform: 'android' } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().token as string;
}
async function gatewayFixture(ownerUserId: string, label: string): Promise<Fixture> {
  const g = (await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`, [label])).rows[0];
  const sim = (await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,country_iso,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,'CN',true,$4)RETURNING id`, [g.id, ownerUserId, `${label} SIM`, tokenHash(`${label}-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`, [sim.id]);
  const token = `${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`, [g.id, tokenHash(token), label]);
  return { gatewayId: g.id, simId: sim.id, deviceEpoch: Number(g.device_epoch), deviceToken: token };
}

const HOURS_AGO = () => new Date(Date.now() - 2 * 3600_000);
async function makeCall(options: {as?: Fixture; ownerId?: string; state?: string; endedAt?: Date; mediaNodeId?: string; remoteNumber?: string} = {}) {
  const fixture = options.as ?? ownerGateway;
  const endedAt = options.endedAt ?? HOURS_AGO();
  return (await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,started_at,answered_at,ended_at,media_node_id,recording_status,gateway_time_zone)
     VALUES($1,$2,$3,'incoming',$4,$5::call_state,$6,'normal',$7,$7,$8,$9,'ready','Asia/Shanghai') RETURNING id`,
    [fixture.gatewayId, fixture.simId, options.ownerId ?? owner, options.remoteNumber ?? '+15550000',
     options.state ?? 'ended', fixture.deviceEpoch, HOURS_AGO(), endedAt, options.mediaNodeId ?? null],
  )).rows[0].id as string;
}
async function captureBinding(callId: string, fixture: Fixture = ownerGateway) {
  return (await db.query(
    `INSERT INTO recording_capture_bindings(call_id,gateway_id,snapshot_owner_id,device_call_id,telecom_creation_time_millis,capture_generation,media_node_id,media_epoch)
     VALUES($1,$2,$3,$4,$5,1,'relay-primary',1) RETURNING id`,
    [callId, fixture.gatewayId, owner, `device-${callId}`, Date.now()],
  )).rows[0].id as string;
}
async function pixelArchive(callId: string, bindingId: string, state: string, fixture: Fixture = ownerGateway) {
  await db.query(
    `INSERT INTO pixel_recording_archives(call_id,capture_binding_id,gateway_id,snapshot_owner_id,client_manifest_sha256,client_manifest,state)
     VALUES($1,$2,$3,$4,$5,'{}',$6)`,
    [callId, bindingId, fixture.gatewayId, owner, 'a'.repeat(64), state],
  );
}
async function deletionArchiveManifest(callId: string) {
  const binding = (await db.query(
    `SELECT id,device_call_id,telecom_creation_time_millis,capture_generation
       FROM recording_capture_bindings WHERE call_id=$1`,
    [callId],
  )).rows[0];
  const track = (name: 'remote_original' | 'caller_original', objectName: string) => ({
    track: name, objectName, mediaType: 'audio/wav',
    pcm: { sampleRate: 16000, channels: 1, bitsPerSample: 16, encoding: 'pcm_s16le' },
    compressedBytes: 1, compressedSha256: 'a'.repeat(64), originalBytes: 44,
    originalSha256: 'b'.repeat(64), pcmBytes: 0, gapCount: 1, droppedFrames: 1,
    captureComplete: false,
  });
  return {
    version: 2,
    captureBinding: {
      id: binding.id,
      deviceCallId: binding.device_call_id,
      telecomCreationTimeMillis: Number(binding.telecom_creation_time_millis),
      captureGeneration: Number(binding.capture_generation),
    },
    startedAt: '2026-09-10T00:00:00.000Z', endedAt: '2026-09-10T00:01:00.000Z',
    terminalState: 'ended',
    tracks: [track('remote_original', 'remote_original.wav.gz'), track('caller_original', 'caller_original.wav.gz')],
    timeline: {
      objectName: 'timeline.jsonl.gz', mediaType: 'application/x-ndjson', compressedBytes: 1,
      compressedSha256: 'c'.repeat(64), originalBytes: 1, originalSha256: 'd'.repeat(64),
    },
    sessionStats: {},
  };
}
const callExists = async (id: string) => Number((await db.query('SELECT 1 FROM call_records WHERE id=$1', [id])).rowCount) === 1;
const remoteState = async (id: string) => (await db.query(
  'SELECT media_node_id,remote_recording_state,remote_attempts FROM call_deletion_tombstones WHERE call_id=$1', [id],
)).rows[0];
const remove = (id: string, token = ownerToken) => app.inject({ method: 'DELETE', url: `/api/v1/calls/${id}`, headers: auth(token) });

before(async () => {
  db = createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql', import.meta.url)), 'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql', import.meta.url)), 'utf8'));
  const passwordHash = await hashPassword(PASSWORD);
  owner = (await db.query(`INSERT INTO users(email,password_hash)VALUES('deleter@example.test',$1)RETURNING id`, [passwordHash])).rows[0].id;
  stranger = (await db.query(`INSERT INTO users(email,password_hash)VALUES('stranger@example.test',$1)RETURNING id`, [passwordHash])).rows[0].id;
  app = await buildApp(db, config as never);
  ownerToken = await login('deleter@example.test');
  strangerToken = await login('stranger@example.test');
  ownerGateway = await gatewayFixture(owner, 'delete-owner');
  strangerGateway = await gatewayFixture(stranger, 'delete-stranger');
});
after(async () => { await app.close(); await db.end(); });

test('deleting a call takes its cascades, its report entry and its recording routes with it', async () => {
  const callId = await makeCall({ remoteNumber: '+15558801' });
  // The production shape of an AI call: call_records.ai_run_id points back at the run whose call_id
  // cascades. The two foreign keys form a cycle, so this is the case that would break first.
  const runId = (await db.query(
    `INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at,state)
     VALUES($1,$2,$3,$4,1,'ai',1,1,45,now(),'ended') RETURNING id`,
    [callId, ownerGateway.gatewayId, owner, ownerGateway.deviceEpoch],
  )).rows[0].id;
  await db.query(`UPDATE call_records SET ai_run_id=$2 WHERE id=$1`, [callId, runId]);
  await db.query(
    `INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,completed_at)VALUES($1,$2,'{}',$3,'succeeded',$4,now())`,
    [callId, owner, 'b'.repeat(64), JSON.stringify({ includeInReports: true, advertisingClassification: 'not_advertising', summary: '删除测试', actionItems: [] })],
  );
  const commandId = (await db.query(
    `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status)VALUES($1,$2,$3,9001,'dial','{}',now()+interval '1 hour','acked')RETURNING id`,
    [ownerGateway.gatewayId, callId, ownerGateway.deviceEpoch],
  )).rows[0].id;
  const binding = await captureBinding(callId);
  await pixelArchive(callId, binding, 'complete');

  const reportUrl = '/api/v1/reports/calls?period=1m&timeZone=Asia%2FShanghai';
  const before = await app.inject({ method: 'GET', url: reportUrl, headers: auth(ownerToken) });
  assert.equal(before.statusCode, 200, before.body);
  assert.ok(before.json().items.some((item: {callId: string}) => item.callId === callId));

  const deleted = await remove(callId);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal(deleted.body, '');

  assert.equal(await callExists(callId), false);
  assert.equal((await db.query('SELECT 1 FROM call_deletion_tombstones WHERE call_id=$1', [callId])).rowCount, 1);
  assert.equal((await db.query('SELECT 1 FROM ai_call_runs WHERE id=$1', [runId])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM transcript_jobs WHERE call_id=$1', [callId])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM recording_capture_bindings WHERE call_id=$1', [callId])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM pixel_recording_archives WHERE call_id=$1', [callId])).rowCount, 0);
  // S29 §2.1: the replay ledger keeps the command, only the call identity is nulled.
  assert.deepEqual((await db.query('SELECT call_id,status FROM commands WHERE id=$1', [commandId])).rows[0], { call_id: null, status: 'acked' });
  const after = await app.inject({ method: 'GET', url: reportUrl, headers: auth(ownerToken) });
  assert.ok(!after.json().items.some((item: {callId: string}) => item.callId === callId));

  // Every read path for a deleted id is an owner-scoped 404, never a 500 or a leaked store error.
  for (const url of [`/api/v1/calls/${callId}`, `/api/v1/calls/${callId}/recordings`, `/api/v1/calls/${callId}/recordings?source=pixel`, `/api/v1/calls/${callId}/transcript`, `/api/v1/calls/${callId}/ai-transcript`]) {
    const gone = await app.inject({ method: 'GET', url, headers: auth(ownerToken) });
    assert.equal(gone.statusCode, 404, `${url} -> ${gone.body}`);
    assert.equal(gone.json().error.code, 'NOT_FOUND');
  }
  const again = await remove(callId);
  assert.equal(again.statusCode, 404, again.body);
});

test('direct retention deletion leaves a scoped complete archive proof for initialize and status', async () => {
  const callId = await makeCall();
  const bindingId = await captureBinding(callId);
  await pixelArchive(callId, bindingId, 'complete');
  const archiveId = (await db.query('SELECT id FROM pixel_recording_archives WHERE call_id=$1', [callId])).rows[0].id;
  for (const [name, kind] of [
    ['remote_original.wav.gz', 'wav'], ['caller_original.wav.gz', 'wav'], ['timeline.jsonl.gz', 'timeline'],
  ] as const) {
    await db.query(
      `INSERT INTO pixel_recording_upload_objects(
         archive_id,object_name,kind,compressed_bytes,compressed_sha256,original_bytes,original_sha256,committed_offset,state
       ) VALUES($1,$2,$3,1,$4,1,$5,1,'verified')`,
      [archiveId, name, kind, 'a'.repeat(64), 'b'.repeat(64)],
    );
  }
  const manifest = await deletionArchiveManifest(callId);

  // This is the same direct DELETE shape used by infra/retention.py; the trigger is the contract.
  assert.equal((await db.query('DELETE FROM call_records WHERE id=$1', [callId])).rowCount, 1);
  const tombstone = (await db.query(
    `SELECT gateway_id,gateway_generation,archive_id,previously_verified,previously_complete
       FROM call_deletion_tombstones WHERE call_id=$1`, [callId],
  )).rows[0];
  assert.deepEqual(tombstone, {
    gateway_id: ownerGateway.gatewayId, gateway_generation: '1', archive_id: archiveId,
    previously_verified: true, previously_complete: true,
  });

  const expectedDeletion = {
    callId, gatewayGeneration: 1,
    archive: { previouslyVerified: true, previouslyComplete: true },
  };
  const initialize = await app.inject({
    method: 'POST', url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: auth(ownerGateway.deviceToken), payload: manifest,
  });
  assert.equal(initialize.statusCode, 410, initialize.body);
  assert.equal(initialize.json().error.code, 'CALL_DELETED');
  assert.deepEqual(initialize.json().error.details.deletion, expectedDeletion);

  const status = await app.inject({
    method: 'GET',
    url: `/api/v1/gateway/recording-archives/${archiveId}?callId=${callId}&generation=1`,
    headers: auth(ownerGateway.deviceToken),
  });
  assert.equal(status.statusCode, 410, status.body);
  assert.deepEqual(status.json().error.details.deletion, expectedDeletion);

  const foreign = await app.inject({
    method: 'POST', url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: auth(strangerGateway.deviceToken), payload: manifest,
  });
  assert.equal(foreign.statusCode, 404, foreign.body);
  const wrongGeneration = structuredClone(manifest);
  wrongGeneration.captureBinding.captureGeneration = 2;
  const stale = await app.inject({
    method: 'POST', url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: auth(ownerGateway.deviceToken), payload: wrongGeneration,
  });
  assert.equal(stale.statusCode, 404, stale.body);
  const unknown = await app.inject({
    method: 'GET',
    url: `/api/v1/gateway/recording-archives/${crypto.randomUUID()}?callId=${crypto.randomUUID()}&generation=1`,
    headers: auth(ownerGateway.deviceToken),
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
});

test('call deletion is owner scoped, uuid shaped and origin guarded', async () => {
  const foreign = await makeCall({ as: strangerGateway, ownerId: stranger });
  const denied = await remove(foreign);
  assert.equal(denied.statusCode, 404, denied.body);
  assert.equal(denied.json().error.code, 'NOT_FOUND');
  assert.equal(await callExists(foreign), true);

  const malformed = await app.inject({ method: 'DELETE', url: '/api/v1/calls/not-a-uuid', headers: auth(ownerToken) });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(malformed.json().error.code, 'INVALID_REQUEST');

  const mine = await makeCall();
  const anonymous = await app.inject({ method: 'DELETE', url: `/api/v1/calls/${mine}` });
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  const web = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'deleter@example.test', password: PASSWORD, platform: 'web' }, headers: { origin: config.PUBLIC_ORIGIN } });
  assert.equal(web.statusCode, 200, web.body);
  const cookie = String(web.headers['set-cookie']).split(';')[0];
  const csrf = await app.inject({ method: 'DELETE', url: `/api/v1/calls/${mine}`, headers: { cookie } });
  assert.equal(csrf.statusCode, 403, csrf.body);
  assert.equal(csrf.json().error.code, 'ORIGIN_REJECTED');
  assert.equal(await callExists(mine), true);
  const allowed = await app.inject({ method: 'DELETE', url: `/api/v1/calls/${mine}`, headers: { cookie, origin: config.PUBLIC_ORIGIN } });
  assert.equal(allowed.statusCode, 204, allowed.body);
});

test('every in-use clause refuses the deletion on its own and releases it once cleared', async () => {
  // Each case starts from a call that is eligible in every other respect, so the 409 can only come
  // from the clause under test, and the follow-up 204 proves the clause was the only thing holding it.
  const cases: {name: string; block: (callId: string) => Promise<void>; clear: (callId: string) => Promise<void>}[] = [
    {
      name: 'call is still active',
      block: async (id) => { await db.query(`UPDATE call_records SET state='active',ended_at=NULL WHERE id=$1`, [id]); },
      clear: async (id) => { await db.query(`UPDATE call_records SET state='ended',ended_at=now()-interval '2 hours' WHERE id=$1`, [id]); },
    },
    {
      name: 'gateway still holds the call lock',
      block: async (id) => {
        const lockGateway = await gatewayFixture(owner, `lock-${id.slice(0, 8)}`);
        await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,1)`, [lockGateway.gatewayId, id]);
      },
      clear: async (id) => { await db.query('DELETE FROM gateway_call_locks WHERE call_id=$1', [id]); },
    },
    {
      name: 'a command is still pending',
      block: async (id) => { await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status)VALUES($1,$2,$3,$4,'hangup','{}',now()+interval '1 hour','pending')`, [ownerGateway.gatewayId, id, ownerGateway.deviceEpoch, Date.now() % 100000]); },
      clear: async (id) => { await db.query(`UPDATE commands SET status='expired' WHERE call_id=$1`, [id]); },
    },
    {
      name: 'a media close job has not completed',
      block: async (id) => { await db.query(`INSERT INTO media_close_jobs(call_id)VALUES($1)`, [id]); },
      clear: async (id) => { await db.query(`UPDATE media_close_jobs SET completed_at=now() WHERE call_id=$1`, [id]); },
    },
    {
      name: 'a pixel archive is still uploading',
      block: async (id) => { await pixelArchive(id, await captureBinding(id), 'uploading'); },
      clear: async (id) => { await db.query(`UPDATE pixel_recording_archives SET state='complete' WHERE call_id=$1`, [id]); },
    },
    {
      name: 'an AI run has not settled',
      block: async (id) => {
        await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at,state)
          VALUES($1,$2,$3,$4,1,'ai',1,1,45,now(),'active')`, [id, ownerGateway.gatewayId, owner, ownerGateway.deviceEpoch]);
      },
      clear: async (id) => { await db.query(`UPDATE ai_call_runs SET state='ended' WHERE call_id=$1`, [id]); },
    },
    {
      name: 'a transcript job is running',
      block: async (id) => {
        await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,lease_token,lease_until)
          VALUES($1,$2,'{}',$3,'running',gen_random_uuid(),now()+interval '1 minute')`, [id, owner, 'c'.repeat(64)]);
      },
      clear: async (id) => { await db.query(`UPDATE transcript_jobs SET state='retry',lease_token=NULL,lease_until=NULL WHERE call_id=$1`, [id]); },
    },
    {
      // S30 §1.1's new clause: hung up moments ago with a capture binding and no archive row means
      // the Pixel has not started its upload yet.
      name: 'a fresh capture binding has no archive yet',
      block: async (id) => { await db.query(`UPDATE call_records SET ended_at=now() WHERE id=$1`, [id]); await captureBinding(id); },
      clear: async (id) => { await db.query(`UPDATE call_records SET ended_at=now()-interval '11 minutes' WHERE id=$1`, [id]); },
    },
  ];
  for (const item of cases) {
    const callId = await makeCall();
    await item.block(callId);
    const refused = await remove(callId);
    assert.equal(refused.statusCode, 409, `${item.name}: ${refused.body}`);
    assert.equal(refused.json().error.code, 'CALL_IN_USE');
    assert.equal(await callExists(callId), true, item.name);
    await item.clear(callId);
    const released = await remove(callId);
    assert.equal(released.statusCode, 204, `${item.name} after clearing: ${released.body}`);
  }
  // The 10-minute window is not a blanket ban on bindings: an archive row of any state other than
  // uploading/verifying means the upload already started, so a just-ended call is deletable.
  const archived = await makeCall({ endedAt: new Date() });
  await pixelArchive(archived, await captureBinding(archived), 'complete');
  const archivedDelete = await remove(archived);
  assert.equal(archivedDelete.statusCode, 204, archivedDelete.body);
  // ...and a just-ended call with no binding at all was never in the clause to begin with.
  const unbound = await makeCall({ endedAt: new Date() });
  const unboundDelete = await remove(unbound);
  assert.equal(unboundDelete.statusCode, 204, unboundDelete.body);
});

test('deletion reclaims the local recording and pixel archive directories after the row is gone', async () => {
  const recordingRoot = await mkdtemp(join(tmpdir(), 'cc-s30-recordings-'));
  const pixelRoot = await mkdtemp(join(tmpdir(), 'cc-s30-pixel-'));
  // PIXEL_ARCHIVE_ENABLED stays false here on purpose: bytes outlive the feature flag, so the root
  // being configured is what decides whether they are reclaimed.
  const fileApp = await buildApp(db, { ...config, RECORDING_ROOT: recordingRoot, PIXEL_ARCHIVE_ROOT: pixelRoot } as never);
  try {
    const callId = await makeCall();
    const neighbour = await makeCall();
    for (const root of [recordingRoot, pixelRoot]) {
      await mkdir(join(root, callId));
      await writeFile(join(root, callId, 'manifest.json'), '{"version":1}');
      await mkdir(join(root, neighbour));
    }
    const deleted = await fileApp.inject({ method: 'DELETE', url: `/api/v1/calls/${callId}`, headers: auth(ownerToken) });
    assert.equal(deleted.statusCode, 204, deleted.body);
    for (const root of [recordingRoot, pixelRoot]) {
      await assert.rejects(() => stat(join(root, callId)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      assert.ok((await stat(join(root, neighbour))).isDirectory(), 'another call directory must survive');
    }
    // A call that never produced files is still a clean 204: a missing directory is not a failure.
    const noFiles = await makeCall();
    const second = await fileApp.inject({ method: 'DELETE', url: `/api/v1/calls/${noFiles}`, headers: auth(ownerToken) });
    assert.equal(second.statusCode, 204, second.body);
  } finally {
    await fileApp.close();
    await rm(recordingRoot, { recursive: true, force: true });
    await rm(pixelRoot, { recursive: true, force: true });
  }
});

test('a remote media node is asked to delete with the shared signature, and its failure never undoes the 204', async () => {
  const secret = 'secondary-media-secret-for-deletion-at-least-32-characters';
  const seen: {method: string; url: string; authorized: boolean}[] = [];
  let status = 204;
  const server = createServer((req, res) => {
    const timestamp = req.headers['x-cc-timestamp'] as string, nonce = req.headers['x-cc-nonce'] as string;
    // Mirrors services/media authorizeRecordingRequest: method and an empty Range line are both part
    // of the canonical string, so a GET signature can never be replayed as a DELETE.
    const canonical = `${req.method}\n${req.url}\n${timestamp}\n${nonce}\n`;
    const expected = createHmac('sha256', secret).update(canonical).digest('base64url');
    const authorized = req.headers['x-cc-signature'] === expected
      && nonce?.length >= 20 && Math.abs(Number(timestamp) - Date.now() / 1000) <= 30
      && req.headers.range === undefined;
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorized });
    res.writeHead(authorized ? status : 401).end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server');
  const nodes = [{
    id: 'relay-secondary', controlBaseUrl: `http://127.0.0.1:${address.port}`, recordingBaseUrl: `http://127.0.0.1:${address.port}`,
    turnUdpUrl: 'turn:relay-secondary.example.test:16801?transport=udp', turnTlsUrl: 'turns:relay-secondary.example.test:16802?transport=tcp',
    mediaSecret: secret, turnSecret: 'secondary-turn-secret-for-deletion-at-least-32-characters',
  }];
  const remoteApp = await buildApp(db, { ...config, MEDIA_NODES_JSON: JSON.stringify(nodes) } as never);
  try {
    const remoteCall = await makeCall({ mediaNodeId: 'relay-secondary' });
    const deleted = await remoteApp.inject({ method: 'DELETE', url: `/api/v1/calls/${remoteCall}`, headers: auth(ownerToken) });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.deepEqual(seen, [{ method: 'DELETE', url: `/internal/recordings/${remoteCall}`, authorized: true }]);
    assert.equal(await callExists(remoteCall), false);
    // S39 §B: the attempt's outcome is durable, because retention retries from the tombstone.
    assert.deepEqual(await remoteState(remoteCall), { media_node_id: 'relay-secondary', remote_recording_state: 'deleted', remote_attempts: 1 });

    status = 500;
    const failing = await makeCall({ mediaNodeId: 'relay-secondary' });
    const stillDeleted = await remoteApp.inject({ method: 'DELETE', url: `/api/v1/calls/${failing}`, headers: auth(ownerToken) });
    assert.equal(stillDeleted.statusCode, 204, stillDeleted.body);
    assert.equal(await callExists(failing), false, 'a refused remote reclaim must not resurrect the row');
    assert.equal(seen.length, 2);
    // A refusal stays `pending`, never `failed`: `failed` is retention's verdict after its ceiling.
    assert.deepEqual(await remoteState(failing), { media_node_id: 'relay-secondary', remote_recording_state: 'pending', remote_attempts: 1 });

    // A local call never calls out at all.
    const localCall = await makeCall({ mediaNodeId: 'relay-primary' });
    const local = await remoteApp.inject({ method: 'DELETE', url: `/api/v1/calls/${localCall}`, headers: auth(ownerToken) });
    assert.equal(local.statusCode, 204, local.body);
    assert.equal(seen.length, 2);
    assert.deepEqual(await remoteState(localCall), { media_node_id: 'relay-primary', remote_recording_state: 'skipped', remote_attempts: 1 });
  } finally {
    await remoteApp.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// S39 §5: the hourly relay-secondary→relay-primary mirror is a second copy of the same bytes, reclaimed in the request
// instead of waiting up to 25 h for retention's orphan sweep.
test('S39 deletion reclaims every per-node directory under the recording backup root', async () => {
  const backupRoot = await mkdtemp(join(tmpdir(), 'cc-s39-backups-'));
  const backupApp = await buildApp(db, { ...config, RECORDING_BACKUP_ROOT: backupRoot } as never);
  try {
    const callId = await makeCall();
    const neighbour = await makeCall();
    for (const node of ['relay-secondary', 'relay-primary']) {
      await mkdir(join(backupRoot, node, callId), { recursive: true });
      await writeFile(join(backupRoot, node, callId, 'part-000.ogg'), 'bytes');
      await mkdir(join(backupRoot, node, neighbour), { recursive: true });
    }
    // The replicate job stages into dot-prefixed directories; those are not media nodes.
    await mkdir(join(backupRoot, '.staging', callId), { recursive: true });

    const deleted = await backupApp.inject({ method: 'DELETE', url: `/api/v1/calls/${callId}`, headers: auth(ownerToken) });
    assert.equal(deleted.statusCode, 204, deleted.body);
    for (const node of ['relay-secondary', 'relay-primary']) {
      await assert.rejects(() => stat(join(backupRoot, node, callId)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      assert.ok((await stat(join(backupRoot, node, neighbour))).isDirectory(), 'another call mirror must survive');
    }
    assert.ok((await stat(join(backupRoot, '.staging', callId))).isDirectory(), 'a dot-prefixed staging directory is not a node');

    // A mirror root that does not exist at all is not a deletion failure.
    const missingRootApp = await buildApp(db, { ...config, RECORDING_BACKUP_ROOT: join(backupRoot, 'absent') } as never);
    try {
      const other = await makeCall();
      const second = await missingRootApp.inject({ method: 'DELETE', url: `/api/v1/calls/${other}`, headers: auth(ownerToken) });
      assert.equal(second.statusCode, 204, second.body);
    } finally { await missingRootApp.close(); }
  } finally {
    await backupApp.close();
    await rm(backupRoot, { recursive: true, force: true });
  }
});

const snapshotPayload = (f: Fixture, sequence: number) => ({
  snapshotId: crypto.randomUUID(), snapshotSequence: sequence, generation: f.deviceEpoch,
  reportedSequence: 0, localBusy: false, confirmedAbsentCallIds: [], calls: [],
  observedAt: new Date(Date.now() + sequence * 1000).toISOString(),
});
const snapshot = (target: FastifyInstance, f: Fixture, payload: ReturnType<typeof snapshotPayload>) =>
  target.inject({ method: 'POST', url: '/api/v1/gateway/telecom/snapshot', headers: auth(f.deviceToken), payload });

// S39 §决策1: the purge queue rides the heartbeat response instead of becoming a command kind.
test('S39 the call-log purge queue is written on delete, sent only behind the flag, and acked once', async () => {
  const f = await gatewayFixture(owner, 's39-purge');
  const endedAt = new Date(Date.now() - 3_500_000);
  const callId = await makeCall({ as: f, endedAt, remoteNumber: '+8613800000039' });
  await db.query(`UPDATE call_records SET device_call_id='calllog:4211' WHERE id=$1`, [callId]);
  assert.equal((await remove(callId)).statusCode, 204);

  // The number and the time window are the CallLog match key, so they are the row's whole point.
  const queued = (await db.query(
    `SELECT id,gateway_id,device_call_id,remote_number,direction,started_at,ended_at,acked_at,ack_status
       FROM call_log_purges WHERE call_id=$1`, [callId],
  )).rows[0];
  assert.equal(queued.gateway_id, f.gatewayId);
  assert.equal(queued.device_call_id, 'calllog:4211');
  assert.equal(queued.remote_number, '+8613800000039');
  assert.equal(queued.direction, 'incoming');
  assert.equal(new Date(queued.ended_at).getTime(), endedAt.getTime());
  assert.ok(new Date(queued.started_at).getTime() < endedAt.getTime());
  assert.equal(queued.acked_at, null);

  const off = await snapshot(app, f, snapshotPayload(f, 1));
  assert.equal(off.statusCode, 200, off.body);
  assert.equal('callLogPurges' in off.json(), false, 'the flag being off must leave the field out entirely');

  const purgeApp = await buildApp(db, { ...config, CALL_LOG_PURGE_ENABLED: true } as never);
  try {
    // A queue row past the 7-day window is never sent even before the trigger gets to prune it.
    const stale = (await db.query(
      `INSERT INTO call_log_purges(gateway_id,call_id,remote_number,created_at)
       VALUES($1,gen_random_uuid(),'+8613800000098',now()-interval '8 days') RETURNING id`, [f.gatewayId],
    )).rows[0].id;
    const payload = snapshotPayload(f, 2);
    const on = await snapshot(purgeApp, f, payload);
    assert.equal(on.statusCode, 200, on.body);
    assert.deepEqual(on.json().callLogPurges, [{
      purgeId: queued.id, callId, deviceCallId: 'calllog:4211', remoteNumber: '+8613800000039',
      direction: 'incoming', startedAt: new Date(queued.started_at).toISOString(), endedAt: endedAt.toISOString(),
    }]);

    // The replayed branch answers from the stored snapshot response but must still carry the queue.
    const replayed = await snapshot(purgeApp, f, payload);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(replayed.json().replayed, true);
    assert.deepEqual(replayed.json().callLogPurges.map((p: {purgeId: string}) => p.purgeId), [queued.id]);

    // Another gateway's device token can neither ack nor learn that the row exists.
    const foreign = await purgeApp.inject({
      method: 'POST', url: '/api/v1/gateway/call-log-purges/ack', headers: auth(ownerGateway.deviceToken),
      payload: { acks: [{ purgeId: queued.id, status: 'deleted', deletedRows: 1 }] },
    });
    assert.equal(foreign.statusCode, 200, foreign.body);
    assert.deepEqual(foreign.json(), { accepted: true, acked: 0 });
    assert.equal((await db.query('SELECT acked_at FROM call_log_purges WHERE id=$1', [queued.id])).rows[0].acked_at, null);

    const acked = await purgeApp.inject({
      method: 'POST', url: '/api/v1/gateway/call-log-purges/ack', headers: auth(f.deviceToken),
      payload: { acks: [{ purgeId: queued.id, status: 'deleted', deletedRows: 1 }] },
    });
    assert.equal(acked.statusCode, 200, acked.body);
    assert.deepEqual(acked.json(), { accepted: true, acked: 1 });
    assert.deepEqual(
      (await db.query('SELECT ack_status,ack_deleted_rows FROM call_log_purges WHERE id=$1', [queued.id])).rows[0],
      { ack_status: 'deleted', ack_deleted_rows: 1 },
    );

    // Acking twice is not an error and does not move the recorded result.
    const again = await purgeApp.inject({
      method: 'POST', url: '/api/v1/gateway/call-log-purges/ack', headers: auth(f.deviceToken),
      payload: { acks: [{ purgeId: queued.id, status: 'not_found', deletedRows: 0 }] },
    });
    assert.deepEqual(again.json(), { accepted: true, acked: 0 });

    const after = await snapshot(purgeApp, f, snapshotPayload(f, 3));
    assert.equal(after.statusCode, 200, after.body);
    assert.deepEqual(after.json().callLogPurges, []);
    await db.query('DELETE FROM call_log_purges WHERE id=$1', [stale]);
  } finally { await purgeApp.close(); }
});

// S39 §决策2: the queue carries a number, so a 7-day ceiling is part of the contract, not hygiene.
test('S39 the deletion trigger prunes call-log purges older than seven days', async () => {
  const [stale, fresh] = (await db.query(
    `INSERT INTO call_log_purges(gateway_id,call_id,remote_number,created_at)
     SELECT gen_random_uuid(),gen_random_uuid(),'+8613800000097',now()-age
       FROM unnest(ARRAY[interval '8 days',interval '6 days']) age RETURNING id`,
  )).rows.map((row) => row.id);
  assert.equal((await db.query('DELETE FROM call_records WHERE id=$1', [await makeCall()])).rowCount, 1);
  assert.equal((await db.query('SELECT 1 FROM call_log_purges WHERE id=$1', [stale])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM call_log_purges WHERE id=$1', [fresh])).rowCount, 1);
  await db.query('DELETE FROM call_log_purges WHERE id=$1', [fresh]);
});

// The queue deliberately has no foreign key on gateway_id: the deletion evidence of a gateway must
// never be what blocks removing that gateway.
test('S39 a gateway that owned ended calls can still be deleted, and its purge queue outlives it', async () => {
  const f = await gatewayFixture(owner, 's39-gateway-gone');
  const callId = await makeCall({ as: f });
  assert.equal((await remove(callId)).statusCode, 204);
  assert.equal((await db.query('DELETE FROM gateways WHERE id=$1', [f.gatewayId])).rowCount, 1);
  assert.equal((await db.query('SELECT gateway_id FROM call_log_purges WHERE call_id=$1', [callId])).rows[0].gateway_id, f.gatewayId);
  assert.equal((await db.query('SELECT gateway_id FROM call_deletion_tombstones WHERE call_id=$1', [callId])).rows[0].gateway_id, f.gatewayId);
});

async function insertSms(options: {as?: Fixture; ownerId?: string; remoteNumber: string; state: string; direction?: 'incoming' | 'outgoing'}) {
  const fixture = options.as ?? ownerGateway;
  return (await db.query(
    `INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)
     VALUES($1,$2,$3,$4,$5,'测试短信',$6::sms_state,$7) RETURNING id`,
    [fixture.gatewayId, fixture.simId, options.ownerId ?? owner, options.direction ?? 'incoming', options.remoteNumber, options.state, fixture.deviceEpoch],
  )).rows[0].id as string;
}
const smsExists = async (id: string) => Number((await db.query('SELECT 1 FROM sms_messages WHERE id=$1', [id])).rowCount) === 1;

test('selected SMS deletion removes only the owner rows that are not in flight', async () => {
  const delivered = await insertSms({ remoteNumber: '+8613800000001', state: 'delivered' });
  const failed = await insertSms({ remoteNumber: '+8613800000001', state: 'failed', direction: 'outgoing' });
  const queued = await insertSms({ remoteNumber: '+8613800000001', state: 'queued', direction: 'outgoing' });
  const sending = await insertSms({ remoteNumber: '+8613800000001', state: 'sending', direction: 'outgoing' });
  const foreign = await insertSms({ as: strangerGateway, ownerId: stranger, remoteNumber: '+8613800000009', state: 'delivered' });
  const absent = crypto.randomUUID();

  const response = await app.inject({
    method: 'POST', url: '/api/v1/sms/delete', headers: auth(ownerToken),
    payload: { ids: [delivered, failed, queued, sending, foreign, absent, delivered] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().deleted, 2);
  const skipped = [...response.json().skipped].sort((a: {id: string}, b: {id: string}) => a.id.localeCompare(b.id));
  assert.deepEqual(skipped, [
    { id: foreign, reason: 'not_found' }, { id: absent, reason: 'not_found' },
    { id: queued, reason: 'in_flight' }, { id: sending, reason: 'in_flight' },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(await smsExists(delivered), false);
  assert.equal(await smsExists(failed), false);
  assert.equal(await smsExists(queued), true);
  assert.equal(await smsExists(sending), true);
  assert.equal(await smsExists(foreign), true, "another owner's message must survive a guessed id");

  for (const payload of [{ ids: [] }, { ids: ['not-a-uuid'] }, { ids: Array.from({ length: 501 }, () => crypto.randomUUID()) }, {}]) {
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/sms/delete', headers: auth(ownerToken), payload });
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload).slice(0, 40));
    assert.equal(invalid.json().error.code, 'INVALID_REQUEST');
  }
  const anonymous = await app.inject({ method: 'POST', url: '/api/v1/sms/delete', payload: { ids: [crypto.randomUUID()] } });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
});

test('thread deletion normalizes both sides of the conversation key and never crosses SIMs', async () => {
  const other = await gatewayFixture(owner, 'delete-owner-second-sim');
  // The same person, written two ways on a CN SIM, is one thread; sms_messages stores no thread key.
  const national = await insertSms({ remoteNumber: '13800000000', state: 'delivered' });
  const international = await insertSms({ remoteNumber: '+8613800000000', state: 'sent', direction: 'outgoing' });
  const spaced = await insertSms({ remoteNumber: '138 0000 0000', state: 'delivered' });
  const inFlight = await insertSms({ remoteNumber: '+8613800000000', state: 'queued', direction: 'outgoing' });
  const neighbour = await insertSms({ remoteNumber: '13900000000', state: 'delivered' });
  const sameNumberOtherSim = await insertSms({ as: other, remoteNumber: '13800000000', state: 'delivered' });

  const response = await app.inject({
    method: 'POST', url: '/api/v1/sms/threads/delete', headers: auth(ownerToken),
    payload: { simId: ownerGateway.simId, conversationAddress: '13800000000' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().deleted, 3);
  assert.deepEqual(response.json().skipped, [{ id: inFlight, reason: 'in_flight' }]);
  for (const id of [national, international, spaced]) assert.equal(await smsExists(id), false);
  assert.equal(await smsExists(inFlight), true);
  assert.equal(await smsExists(neighbour), true, 'a different number on the same SIM must survive');
  assert.equal(await smsExists(sameNumberOtherSim), true, 'the same number on another SIM is another thread');

  // The E.164 spelling of the request key reaches exactly the same thread.
  const reopened = await insertSms({ remoteNumber: '13800000000', state: 'delivered' });
  const byE164 = await app.inject({
    method: 'POST', url: '/api/v1/sms/threads/delete', headers: auth(ownerToken),
    payload: { simId: ownerGateway.simId, conversationAddress: '+8613800000000' },
  });
  assert.equal(byE164.statusCode, 200, byE164.body);
  assert.equal(byE164.json().deleted, 1);
  assert.equal(await smsExists(reopened), false);
  assert.equal(await smsExists(inFlight), true);

  // An empty thread is still a 200: DELETE is idempotent and a second confirmation is not an error.
  const empty = await app.inject({ method: 'POST', url: '/api/v1/sms/threads/delete', headers: auth(ownerToken), payload: { simId: ownerGateway.simId, conversationAddress: '+8613800000000' } });
  assert.deepEqual(empty.json(), { deleted: 0, skipped: [{ id: inFlight, reason: 'in_flight' }] });

  const foreignSim = await app.inject({ method: 'POST', url: '/api/v1/sms/threads/delete', headers: auth(ownerToken), payload: { simId: strangerGateway.simId, conversationAddress: '+8613800000009' } });
  assert.equal(foreignSim.statusCode, 404, foreignSim.body);
  assert.equal(foreignSim.json().error.code, 'NOT_FOUND');
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/sms/threads/delete', headers: auth(ownerToken), payload: { simId: 'nope', conversationAddress: '' } });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(invalid.json().error.code, 'INVALID_REQUEST');
  await db.query('DELETE FROM sms_messages WHERE id=$1', [inFlight]);
});

test('thread deletion pages past 5000 newer messages and preserves in-flight and foreign rows', async () => {
  const target = '+8613700000000';
  const inserted = await db.query(
    `INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation,created_at)
     SELECT $1,$2,$3,'incoming',CASE WHEN n>5000 THEN $4 ELSE '+8613600000000' END,'bulk history',
       (CASE WHEN n=5002 THEN 'queued' ELSE 'delivered' END)::sms_state,$5,now()-(n*interval '1 second')
     FROM generate_series(1,5003) n RETURNING id,remote_number,state::text state`,
    [ownerGateway.gatewayId,ownerGateway.simId,owner,target,ownerGateway.deviceEpoch],
  );
  const targetRows=inserted.rows.filter(row=>row.remote_number===target);
  assert.equal(targetRows.length,3);
  const foreign=await insertSms({as:strangerGateway,ownerId:stranger,remoteNumber:target,state:'delivered'});
  const response=await app.inject({method:'POST',url:'/api/v1/sms/threads/delete',headers:auth(ownerToken),
    payload:{simId:ownerGateway.simId,conversationAddress:'13700000000'}});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().deleted,2);
  const queued=targetRows.find(row=>row.state==='queued')!;
  assert.deepEqual(response.json().skipped,[{id:queued.id,reason:'in_flight'}]);
  assert.equal(await smsExists(queued.id),true);
  assert.equal(await smsExists(foreign),true,'the same normalized address owned by another user must survive');
  const deletedIds=targetRows.filter(row=>row.state==='delivered').map(row=>row.id);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_deletion_tombstones WHERE sms_id=ANY($1::uuid[])`,[deletedIds])).rows[0].n,2);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE snapshot_owner_id=$1 AND remote_number=$2`,[owner,target])).rows[0].n,1);
  await db.query(`DELETE FROM sms_messages WHERE snapshot_owner_id=$1 AND body='bulk history'`,[owner]);
  await db.query('DELETE FROM sms_messages WHERE id=$1',[foreign]);
});

test('thread deletion keeps microsecond precision across a 500-row boundary', async () => {
  const target='+8613500000000';
  const inserted=await db.query(
    `INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation,created_at)
     SELECT $1,$2,$3,'incoming',$4,'microsecond cursor',
       (CASE WHEN n=501 THEN 'sending' ELSE 'delivered' END)::sms_state,$5,
       '2026-09-13 12:34:56.123000+00'::timestamptz+(n*interval '1 microsecond')
     FROM generate_series(1,1001) n RETURNING id,state::text state`,
    [ownerGateway.gatewayId,ownerGateway.simId,owner,target,ownerGateway.deviceEpoch],
  );
  const response=await app.inject({method:'POST',url:'/api/v1/sms/threads/delete',headers:auth(ownerToken),
    payload:{simId:ownerGateway.simId,conversationAddress:'13500000000'}});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().deleted,1000);
  const sending=inserted.rows.find(row=>row.state==='sending')!;
  assert.deepEqual(response.json().skipped,[{id:sending.id,reason:'in_flight'}]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE body='microsecond cursor'`)).rows[0].n,1);
  await db.query('DELETE FROM sms_messages WHERE id=$1',[sending.id]);
});

test('thread deletion retries serialization failures as whole transactions', async () => {
  const smsId=await insertSms({remoteNumber:'+8613400000000',state:'delivered'});
  await db.query(`UPDATE sms_messages SET body='retry serialization' WHERE id=$1`,[smsId]);
  await db.query(`
    CREATE SEQUENCE s32_sms_retry_sequence;
    CREATE FUNCTION s32_sms_retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.body='retry serialization' AND nextval('s32_sms_retry_sequence')<=2
      THEN RAISE EXCEPTION 'synthetic serialization conflict' USING ERRCODE='40001';
      END IF;
      RETURN OLD;
    END $$;
    CREATE TRIGGER a_s32_sms_retry_failure BEFORE DELETE ON sms_messages
      FOR EACH ROW EXECUTE FUNCTION s32_sms_retry_failure();
  `);
  try{
    const response=await app.inject({method:'POST',url:'/api/v1/sms/threads/delete',headers:auth(ownerToken),
      payload:{simId:ownerGateway.simId,conversationAddress:'13400000000'}});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{deleted:1,skipped:[]});
    assert.equal(await smsExists(smsId),false);
    assert.equal((await db.query(`SELECT count(*)::int n FROM sms_deletion_tombstones WHERE sms_id=$1`,[smsId])).rows[0].n,1);
    assert.equal((await db.query(`SELECT last_value::int n FROM s32_sms_retry_sequence`)).rows[0].n,3);
  }finally{
    await db.query('DROP TRIGGER IF EXISTS a_s32_sms_retry_failure ON sms_messages');
    await db.query('DROP FUNCTION IF EXISTS s32_sms_retry_failure()');
    await db.query('DROP SEQUENCE IF EXISTS s32_sms_retry_sequence');
  }
});

test('a valid late SMS state event is deduplicated against its tombstone without resurrecting content', async () => {
  const smsId = await insertSms({ remoteNumber: '+8613800000002', state: 'sent', direction: 'outgoing' });
  const deleted = await app.inject({ method: 'POST', url: '/api/v1/sms/delete', headers: auth(ownerToken), payload: { ids: [smsId] } });
  assert.equal(deleted.json().deleted, 1);
  const eventId = crypto.randomUUID();
  const event = await app.inject({
    method: 'POST', url: `/api/v1/gateway/sms/${smsId}/events`, headers: auth(ownerGateway.deviceToken),
    payload: { eventId, generation: ownerGateway.deviceEpoch, state: 'delivered' },
  });
  assert.equal(event.statusCode, 200, event.body);
  assert.deepEqual(event.json(), { accepted: true, replayed: false, ignored: true });
  const replay = await app.inject({
    method: 'POST', url: `/api/v1/gateway/sms/${smsId}/events`, headers: auth(ownerGateway.deviceToken),
    payload: { eventId, generation: ownerGateway.deviceEpoch, state: 'delivered' },
  });
  assert.deepEqual(replay.json(), { accepted: true, replayed: true });
  assert.equal((await db.query('SELECT 1 FROM sms_messages WHERE id=$1', [smsId])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM device_events WHERE gateway_id=$1 AND event_id=$2', [ownerGateway.gatewayId, eventId])).rowCount, 1);

  const unknown = await app.inject({
    method: 'POST', url: `/api/v1/gateway/sms/${crypto.randomUUID()}/events`, headers: auth(ownerGateway.deviceToken),
    payload: { eventId: crypto.randomUUID(), generation: ownerGateway.deviceEpoch, state: 'delivered' },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);

  const foreignSms = await insertSms({
    as: strangerGateway, ownerId: stranger, remoteNumber: '+8613800000099', state: 'sent', direction: 'outgoing',
  });
  const foreignDeleted = await app.inject({
    method: 'POST', url: '/api/v1/sms/delete', headers: auth(strangerToken), payload: { ids: [foreignSms] },
  });
  assert.equal(foreignDeleted.json().deleted, 1);
  const foreignEvent = await app.inject({
    method: 'POST', url: `/api/v1/gateway/sms/${foreignSms}/events`, headers: auth(ownerGateway.deviceToken),
    payload: { eventId: crypto.randomUUID(), generation: ownerGateway.deviceEpoch, state: 'delivered' },
  });
  assert.equal(foreignEvent.statusCode, 404, foreignEvent.body);
  await db.query('UPDATE gateways SET device_epoch=device_epoch+1 WHERE id=$1', [ownerGateway.gatewayId]);
  const mismatch = await app.inject({
    method: 'POST', url: `/api/v1/gateway/sms/${smsId}/events`, headers: auth(ownerGateway.deviceToken),
    payload: { eventId: crypto.randomUUID(), generation: ownerGateway.deviceEpoch + 1, state: 'delivered' },
  });
  assert.equal(mismatch.statusCode, 409, mismatch.body);
  assert.equal(mismatch.json().error.code, 'DELETION_GENERATION_MISMATCH');
  await db.query('UPDATE gateways SET device_epoch=device_epoch-1 WHERE id=$1', [ownerGateway.gatewayId]);
});
