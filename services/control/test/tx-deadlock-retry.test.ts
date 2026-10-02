import assert from 'node:assert/strict';
import test from 'node:test';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {tx} from '../src/app.js';
import {storeAiTranscript} from '../src/ai-runs/transcripts.js';
import {authorizeAiMedia,claimAiRun,commitAiAnswer,failAiRun,markAiMediaFailure} from '../src/ai-runs/repository.js';
import {AiRunReconciler} from '../src/ai-runs/reconciler.js';
import type {Db} from '../src/db.js';

/**
 * 2026-09-18: `POST /api/v1/gateway/calls/:id/media/options` returned 500 on a Postgres deadlock
 * (40P01) and the gateway withdrew the call's media. A deadlock victim is fully rolled back, so
 * `tx` re-runs the closure. No database here — the point is the wrapper, not Postgres.
 */
function fakeDb() {
  const statements: string[] = [];
  const diagEvents: unknown[][] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return {rowCount: 0, rows: []};
    },
    on: () => undefined,
    removeListener: () => undefined,
    release: () => undefined,
  };
  const db = {
    connect: async () => client as unknown as PoolClient,
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('diag_events')) diagEvents.push(params);
      return {rowCount: 1, rows: []};
    },
  } as unknown as Db;
  return {db, statements, diagEvents};
}

const sqlError = (code: string) => Object.assign(new Error(`synthetic ${code}`), {code});

test('tx retries a deadlock victim once and commits the second attempt', async () => {
  const {db, statements, diagEvents} = fakeDb();
  let attempts = 0;
  const value = await tx(db, async () => {
    attempts += 1;
    if (attempts === 1) throw sqlError('40P01');
    return 'ok';
  }, 'gateway.media.authorize');
  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
  assert.equal(statements.filter((s) => s === 'BEGIN').length, 2);
  assert.equal(statements.filter((s) => s === 'ROLLBACK').length, 1);
  assert.equal(statements.filter((s) => s === 'COMMIT').length, 1);
  // Production has to be able to count how often this fires.
  assert.equal(diagEvents.length, 1);
  assert.match(String(diagEvents[0]?.[6]), /db\.deadlock_retry|gateway\.media\.authorize/);
});

test('tx retries a serialization failure too', async () => {
  const {db} = fakeDb();
  let attempts = 0;
  await tx(db, async () => {
    attempts += 1;
    if (attempts < 3) throw sqlError('40001');
  });
  assert.equal(attempts, 3);
});

test('tx rethrows a non-retryable error without a second attempt', async () => {
  const {db, statements, diagEvents} = fakeDb();
  let attempts = 0;
  await assert.rejects(
    tx(db, async () => {
      attempts += 1;
      throw sqlError('23505');
    }),
    /synthetic 23505/,
  );
  assert.equal(attempts, 1);
  assert.equal(statements.filter((s) => s === 'BEGIN').length, 1);
  assert.equal(diagEvents.length, 0);
});

test('tx gives up after three attempts', async () => {
  const {db} = fakeDb();
  let attempts = 0;
  await assert.rejects(
    tx(db, async () => {
      attempts += 1;
      throw sqlError('40P01');
    }),
    /synthetic 40P01/,
  );
  assert.equal(attempts, 3);
});

/**
 * S94b: the Voice worker's transcript upload raced a hangup and returned 500 on 40P01. The batch now
 * runs in `tx`; a deadlock on the INSERT re-runs the whole read-lock-insert closure once and the
 * worker sees the normal 200 body, with the stored count of the attempt that committed.
 */
test('storeAiTranscript retries a deadlock victim on the transcript insert', async () => {
  const token = 'transcript-lease-token-at-least-32-characters';
  const runId = '00000000-0000-4000-8000-0000000000a1', callId = '00000000-0000-4000-8000-0000000000a2';
  const identity = {instanceId: '00000000-0000-4000-8000-000000000011', bootId: '00000000-0000-4000-8000-000000000012'};
  const statements: string[] = [];
  const diagEvents: unknown[][] = [];
  let inserts = 0;
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith('SELECT call_id FROM ai_call_runs')) return {rowCount: 1, rows: [{call_id: callId}]};
      if (sql.includes('FROM ai_call_runs WHERE id=$1 FOR KEY SHARE')) return {rowCount: 1, rows: [{
        id: runId, call_id: callId, state: 'active', ended_at: null, lease_owner: identity.instanceId, lease_boot_id: identity.bootId,
        lease_hash: createHash('sha256').update(token).digest('hex'), lease_until: new Date(Date.now() + 60_000),
      }]};
      if (sql.includes('INSERT INTO ai_run_transcripts')) {
        inserts += 1;
        if (inserts === 1) throw sqlError('40P01');
        return {rowCount: 2, rows: [{id: 'a'}, {id: 'b'}]};
      }
      return {rowCount: 1, rows: []};
    },
    on: () => undefined,
    removeListener: () => undefined,
    release: () => undefined,
  };
  const db = {
    connect: async () => client as unknown as PoolClient,
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('diag_events')) diagEvents.push(params);
      return {rowCount: 1, rows: []};
    },
  } as unknown as Db;
  const at = new Date().toISOString();
  const value = await storeAiTranscript(db, {runId, token, ...identity, items: [
    {role: 'caller', sequence: 0, text: '运单号', at}, {role: 'ai', sequence: 1, text: '好的', at},
  ]});
  assert.deepEqual(value, {accepted: true, stored: 2});
  assert.equal(inserts, 2);
  assert.equal(statements.filter((s) => s === 'BEGIN').length, 2);
  assert.equal(statements.filter((s) => s === 'ROLLBACK').length, 1);
  assert.equal(statements.filter((s) => s === 'COMMIT').length, 1);
  // Canonical order inside each attempt: call lock strictly before run lock, both before the insert.
  const firstAttempt = statements.slice(0, statements.indexOf('ROLLBACK'));
  const callLock = firstAttempt.findIndex((s) => s.includes('FROM call_records WHERE id=$1 FOR KEY SHARE'));
  const runLock = firstAttempt.findIndex((s) => s.includes('FROM ai_call_runs WHERE id=$1 FOR KEY SHARE'));
  const insert = firstAttempt.findIndex((s) => s.includes('INSERT INTO ai_run_transcripts'));
  assert.ok(callLock >= 0 && callLock < runLock && runLock < insert, firstAttempt.join('\n'));
  assert.equal(diagEvents.length, 1);
  assert.match(JSON.stringify(diagEvents[0]), /db\.deadlock_retry/);
  assert.match(JSON.stringify(diagEvents[0]), /ai\.transcript/);
});

/**
 * S94d: every AI-run mutation transaction runs in `tx`. A scripted client answers by SQL substring
 * (first match wins) and throws one 40P01 on the first statement matching `failOn`.
 */
const aiIds = {runId: '00000000-0000-4000-8000-0000000000b1', callId: '00000000-0000-4000-8000-0000000000b2',
  gatewayId: '00000000-0000-4000-8000-0000000000b3', instanceId: '00000000-0000-4000-8000-000000000021',
  bootId: '00000000-0000-4000-8000-000000000022', token: 'ai-run-lease-token-at-least-32-characters!'};
const leased = {id: aiIds.runId, call_id: aiIds.callId, lease_owner: aiIds.instanceId, lease_boot_id: aiIds.bootId,
  lease_hash: createHash('sha256').update(aiIds.token).digest('hex'), lease_until: new Date(Date.now() + 60_000),
  device_generation: 1, media_epoch: 1, attempts: 1, answer_command_id: null, media_attempted_at: null};
const lease = {runId: aiIds.runId, instanceId: aiIds.instanceId, bootId: aiIds.bootId, token: aiIds.token};

function scriptedDb(routes: Array<[string, unknown[]]>, failOn: string | null, pool: Array<[string, unknown[]]> = []) {
  const statements: string[] = [];
  const diagEvents: unknown[][] = [];
  let failed = false;
  const answer = (table: Array<[string, unknown[]]>, sql: string) => {
    const rows = table.find(([key]) => sql.includes(key))?.[1] ?? [];
    return {rowCount: rows.length, rows};
  };
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (failOn && !failed && sql.includes(failOn)) {failed = true; throw sqlError('40P01');}
      return answer(routes, sql);
    },
    on: () => undefined,
    removeListener: () => undefined,
    release: () => undefined,
  };
  const db = {
    connect: async () => client as unknown as PoolClient,
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('diag_events')) {diagEvents.push(params); return {rowCount: 1, rows: []};}
      if (sql.includes('SELECT gateway_id,call_id FROM ai_call_runs')) return {rowCount: 1, rows: [{gateway_id: aiIds.gatewayId, call_id: aiIds.callId}]};
      return answer(pool, sql);
    },
  } as unknown as Db;
  const count = (s: string) => statements.filter((x) => x === s).length;
  return {db, statements, diagEvents, count, injected: () => failed};
}

function assertRetried(h: ReturnType<typeof scriptedDb>, label: string) {
  assert.ok(h.injected(), 'the 40P01 was injected');
  assert.equal(h.count('BEGIN'), 2);
  assert.equal(h.count('ROLLBACK'), 1);
  assert.equal(h.count('COMMIT'), 1);
  assert.equal(h.diagEvents.length, 1);
  assert.match(JSON.stringify(h.diagEvents[0]), /db\.deadlock_retry/);
  assert.match(JSON.stringify(h.diagEvents[0]), new RegExp(label.replace(/\./g, '\\.')));
}

test('claimAiRun retries a deadlock victim on the preparing update', async () => {
  const h = scriptedDb([
    ['FROM ai_worker_instances', [{}]],
    ['WHERE lease_owner=$1', []],
    ['SELECT run.* FROM ai_call_runs run', [{id: aiIds.runId}]],
    ["UPDATE ai_call_runs SET state='preparing'", [{...leased, state: 'preparing', mode_snapshot: 'ai', trigger_at: new Date()}]],
  ], "UPDATE ai_call_runs SET state='preparing'");
  const value = await claimAiRun(h.db, {enabled: true, instanceId: aiIds.instanceId, bootId: aiIds.bootId});
  assert.equal(value?.run.id, aiIds.runId);
  assert.equal(typeof value?.leaseToken, 'string');
  assertRetried(h, 'ai.claim');
});

test('commitAiAnswer retries a deadlock victim on the gateway lock', async () => {
  const h = scriptedDb([
    ['FROM gateways WHERE id=$1 FOR UPDATE', [{id: aiIds.gatewayId}]],
    ['FROM call_records call JOIN sims', [{id: aiIds.callId, ai_run_id: aiIds.runId}]],
    ['FROM ai_call_runs WHERE id=$1 FOR UPDATE', [{...leased, state: 'answer_committed', answer_command_id: 'cmd-1'}]],
    ['FROM ai_worker_instances', [{}]],
    ['FROM commands WHERE id=$1', [{id: 'cmd-1', generation: 1, sequence: 7, expires_at: null}]],
  ], 'FROM gateways WHERE id=$1 FOR UPDATE');
  const value = await commitAiAnswer(h.db, {enabled: true, ...lease, onlineSeconds: 30, nodeId: 'relay-primary'});
  assert.equal(value.replayed, true);
  assert.equal(value.run.id, aiIds.runId);
  assert.deepEqual(value.command, {id: 'cmd-1', generation: 1, sequence: 7, expires_at: null});
  assert.deepEqual(Object.keys(value).sort(), ['command', 'replayed', 'run'], 'no internal discriminant leaks');
  assertRetried(h, 'ai.commit_answer');
});

/** The lost_race state change is committed and the worker still gets the same 409. */
test('commitAiAnswer lost_race commits the state change and then answers 409', async () => {
  const h = scriptedDb([
    ['FROM gateways WHERE id=$1 FOR UPDATE', [{id: aiIds.gatewayId}]],
    ['FROM call_records call JOIN sims', [{id: aiIds.callId, ai_run_id: aiIds.runId, state: 'active'}]],
    ['FROM ai_call_runs WHERE id=$1 FOR UPDATE', [{...leased, state: 'preparing'}]],
    ['FROM ai_worker_instances', [{}]],
  ], null);
  await assert.rejects(commitAiAnswer(h.db, {enabled: true, ...lease, onlineSeconds: 30, nodeId: 'relay-primary'}), (error: any) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'AI_LOST_RACE');
    assert.equal(error.message, 'Another endpoint already handled this call');
    return true;
  });
  assert.equal(h.count('BEGIN'), 1);
  assert.equal(h.count('ROLLBACK'), 0);
  assert.equal(h.count('COMMIT'), 1);
  const lost = h.statements.findIndex((s) => s.includes("UPDATE ai_call_runs SET state='lost_race'"));
  assert.ok(lost >= 0 && lost < h.statements.indexOf('COMMIT'), h.statements.join('\n'));
  assert.equal(h.diagEvents.length, 0);
});

test('failAiRun retries a deadlock victim on the run update', async () => {
  const h = scriptedDb([
    ['FROM gateways WHERE id=$1 FOR UPDATE', [{id: aiIds.gatewayId}]],
    ['FROM call_records WHERE id=$1 FOR UPDATE', [{id: aiIds.callId, state: 'incoming_ringing'}]],
    ['FROM ai_call_runs WHERE id=$1 FOR UPDATE', [{...leased, state: 'preparing'}]],
  ], 'UPDATE ai_call_runs SET state=$2');
  assert.deepEqual(await failAiRun(h.db, {...lease, code: 'provider_error'}), {accepted: true});
  assertRetried(h, 'ai.fail');
});

test('authorizeAiMedia retries a deadlock victim on the media-attempted update', async () => {
  const h = scriptedDb([
    ['FROM gateways WHERE id=$1 FOR UPDATE', [{id: aiIds.gatewayId, control_enabled: true, media_ready_debounced: true,
      telephony_ready_debounced: true, last_seen_at: new Date(), device_epoch: 1}]],
    ['FROM call_records WHERE id=$1 FOR UPDATE', [{id: aiIds.callId, ai_run_id: aiIds.runId, answered_by_platform: 'ai', state: 'active',
      generation: 1, media_epoch: 1, media_node_id: 'relay-primary'}]],
    ['FROM ai_call_runs WHERE id=$1 FOR UPDATE', [{...leased, state: 'active'}]],
    ['FROM ai_worker_instances', [{}]],
  ], 'UPDATE ai_call_runs SET media_attempted_at');
  const value = await authorizeAiMedia(h.db, {...lease, onlineSeconds: 30, markAttempted: true});
  assert.deepEqual(value, {callId: aiIds.callId, nodeId: 'relay-primary', mediaEpoch: 1, state: 'active'});
  assertRetried(h, 'ai.media.authorize');
});

test('markAiMediaFailure retries a deadlock victim on the call update', async () => {
  const h = scriptedDb([
    ['FROM gateways WHERE id=$1 FOR UPDATE', [{id: aiIds.gatewayId}]],
    ['FROM call_records WHERE id=$1 FOR UPDATE', [{id: aiIds.callId, state: 'active'}]],
    ['FROM ai_call_runs WHERE id=$1 FOR UPDATE', [{...leased, state: 'active', answer_command_id: 'cmd-1'}]],
  ], 'UPDATE call_records SET state=CASE');
  assert.deepEqual(await markAiMediaFailure(h.db, aiIds.runId, 'ai_media_offer_failed'), {callId: aiIds.callId});
  assertRetried(h, 'ai.media.failure');
});

/** The media close runs after the commit, once, even though the transaction ran twice. */
test('AiRunReconciler retries a deadlock victim and closes media once', async () => {
  const h = scriptedDb([
    ['FROM gateways WHERE id=$1 FOR UPDATE', [{id: aiIds.gatewayId}]],
    ['FROM call_records WHERE id=$1 FOR UPDATE', [{id: aiIds.callId, state: 'ended'}]],
    ['FROM ai_call_runs WHERE id=$1 FOR UPDATE', [{...leased, state: 'ending', retry_due: true, media_attempted_at: new Date()}]],
  ], "UPDATE ai_call_runs SET state='ended'", [['SELECT id FROM ai_call_runs WHERE', [{id: aiIds.runId}]]]);
  const closes: string[] = [];
  const reconciler = new AiRunReconciler(h.db, {intervalMs: 60_000, onMediaClose: async (callId) => {closes.push(callId);}});
  assert.equal(await reconciler.tickOnce(), 1);
  assert.deepEqual(closes, [aiIds.callId]);
  assertRetried(h, 'ai.reconcile');
});
