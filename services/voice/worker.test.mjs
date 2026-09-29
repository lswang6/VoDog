import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceWorker, controlHealth, logLevel } from './worker.mjs';
import { VoiceControlClient } from './control-client.mjs';
import { defaultProvider, jsonLogger, maxCallSeconds, mediaTransport, vadSettings, workerNodeId, xaiRealtimePort } from './server.mjs';

const run = () => ({ id: '11111111-1111-4111-8111-111111111111', callId: '22222222-2222-4222-8222-222222222222',
  leaseToken: 'a'.repeat(43), triggerAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 10_000).toISOString() });
class Agent extends EventEmitter { greets = 0; async start() { this.ready = true; } greet() { this.greets++; return true; } stop() { this.stopped = true; } }
class Peer extends EventEmitter { close() { this.closed = true; } }
class Bridge extends EventEmitter {
  constructor() { super(); this.history = []; }
  start() { this.started = true; } setActive(value) { this.history.push(value); if (value) this.emit('active'); }
  close() { this.closed = true; } stats() { return { active: false, queuedBytes: this.queuedBytes ?? 0 }; }
  // S27 决策 6 (c): the real bridge resolves this once the caller has heard everything queued.
  // S27 决策 14: the end-of-call rule itself lives in `audio-bridge.mjs` and is tested against the
  // real queue in pcm-pipeline.test.mjs; here only the options the worker hands it are recorded.
  async whenPlaybackDrained(options) { this.drained = (this.drained ?? 0) + 1; this.drainOptions = options; return true; }
}
function setup(overrides = {}) {
  const agent = new Agent(), peer = new Peer(), bridge = new Bridge(), calls = [], posts = [], logs = [];
  const control = {
    heartbeat: async () => {}, claim: async () => null,
    renew: async () => ({ leaseExpiresAt: new Date(Date.now() + 10_000).toISOString() }),
    commit: async () => { calls.push('commit'); }, signaling: () => ({}),
    read: async () => ({ run: { state: 'awaiting_active' }, callState: 'connecting', audioAllowed: false }),
    fail: async (_run, code) => { calls.push(`fail:${code}`); },
    transcript: async (_run, items) => { posts.push(...items); }, ...overrides.control,
  };
  const worker = new VoiceWorker({ control, createAgent: () => agent, connectPeer: async () => { calls.push('offer'); return peer; }, createBridge: () => bridge,
    // S27 决策 15: the production hangup tail is a real second of wall clock; tests that are not
    // about it opt out, and the one that is passes its own value.
    renewMs: 100, pollMs: 5, heartbeatMs: 100, idleMs: 10, aiEndTailMs: 0, heapRestartMb: 0, log: record => logs.push(record), ...overrides, ...(overrides.control ? { control } : {}) });
  return { worker, agent, peer, bridge, control, calls, posts, logs };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); } assert.fail('Condition was not reached'); }
/** One 10 ms caller frame exactly as `ClientMediaPeer` emits it once the gateway channel carries audio. */
const callerFrame = () => ({ pcm: Buffer.alloc(320), sampleRate: 16_000, numberOfFrames: 160 });

test('ACK alone keeps audio silent; actual ACTIVE opens it; normal provider completion keeps the call alive', async () => {
  const s = setup(); const task = s.worker.execute(run());
  await until(() => s.bridge.started); assert.equal(s.bridge.history.includes(true), false);
  s.control.read = async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true });
  await until(() => s.bridge.history.includes(true));
  s.agent.emit('completed', { status: 'completed', current: true }); assert.equal(s.bridge.closed, undefined);
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task; assert.equal(s.bridge.closed, true); assert.equal(s.agent.stopped, true); assert.equal(s.peer.closed, true);
  assert.deepEqual(s.calls, ['commit', 'offer']); assert.equal(s.worker.activeAbort, null);
});
test('provider preparation failure cannot create an answer or offer', async () => {
  const s = setup(); s.agent.start = async () => { throw new Error('provider rejected'); };
  await s.worker.execute(run()); assert.deepEqual(s.calls, ['fail:worker_run_failed']); assert.equal(s.agent.stopped, true);
});
test('human winner during prewarm cancels provider without sending answer or media', async () => {
  const s = setup({ renewMs: 5, control: { renew: async () => { throw new Error('lease lost'); } } });
  await s.worker.execute({ ...run(), triggerAt: new Date(Date.now() + 30_000).toISOString() });
  assert.deepEqual(s.calls, ['fail:lease_renew_failed']); assert.equal(s.agent.stopped, true);
});
test('authority read failure after active immediately fences output and requests durable cleanup', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run()); await until(() => s.bridge.history.includes(true));
  s.control.read = async () => { throw new Error('disconnected'); }; await task;
  assert.equal(s.bridge.history.at(-1), false); assert.equal(s.bridge.closed, true);
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:authority_read_failed']);
});
test('local lease deadline aborts an in-flight provider even if renewal has stalled', async () => {
  const s = setup({ renewMs: 10_000, leaseMarginMs: 1 });
  s.agent.start = async ({ signal }) => { await once(signal, 'abort'); throw signal.reason; };
  await s.worker.execute({ ...run(), leaseExpiresAt: new Date(Date.now() + 25).toISOString() });
  assert.deepEqual(s.calls, ['fail:lease_deadline']); assert.equal(s.agent.stopped, true);
});
test('shutdown during media negotiation aborts peer construction and never retries its offer', async () => {
  let constructing = false;
  const s = setup({ connectPeer: async ({ signal }) => { constructing = true; await once(signal, 'abort'); throw signal.reason; } });
  const task = s.worker.execute(run()); await until(() => constructing); await s.worker.stop(); await task;
  assert.deepEqual(s.calls, ['commit', 'fail:worker_shutdown']); assert.equal(s.agent.stopped, true); assert.equal(s.worker.activeAbort, null);
});
test('one worker refuses concurrent runs', async () => {
  const s = setup(); const task = s.worker.execute(run()); await until(() => s.bridge.started);
  await assert.rejects(s.worker.execute(run()), /capacity/); await s.worker.stop(); await task;
});
test('missing ACTIVE times out even while lease renewal remains healthy', async () => {
  const s = setup({ activationTimeoutMs: 20, renewMs: 5 }); await s.worker.execute(run());
  assert.equal(s.bridge.history.includes(true), false); assert.deepEqual(s.calls, ['commit', 'offer', 'fail:telecom_active_timeout']);
});
test('an ACTIVE run without audio authority never starts playback', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: false }) } });
  await s.worker.execute(run()); assert.equal(s.bridge.history.includes(true), false); assert.equal(s.calls.at(-1), 'fail:audio_authority_revoked');
});
test('disabled Control yields no provider or media IO and shutdown joins idle heartbeat', async () => {
  const s = setup({ heartbeatMs: 10, idleMs: 5 }); let heartbeats = 0, claims = 0;
  s.control.heartbeat = async () => { heartbeats++; }; s.control.claim = async () => { claims++; return null; };
  const task = s.worker.start(); await until(() => claims >= 2); await s.worker.stop(); await task;
  assert.ok(heartbeats > 0); assert.equal(s.agent.ready, undefined); assert.deepEqual(s.calls, []);
});
test('Control transport uses independent service+lease identity, loopback and no redirects', async () => {
  const requests = []; const client = new VoiceControlClient({ baseUrl: 'http://127.0.0.1:3100', token: 'service'.repeat(8), instanceId: run().id,
    fetcher: async (url, options) => { requests.push({ url, ...options }); return new Response(JSON.stringify({ lease: { leaseExpiresAt: run().leaseExpiresAt } })); } });
  await client.renew(run()); const request = requests[0];
  assert.equal(request.redirect, 'error'); assert.equal(request.headers.Authorization, `Bearer ${'service'.repeat(8)}`);
  assert.equal(request.headers['X-AI-Lease-Token'], run().leaseToken); assert.equal(request.method, 'PUT');
  assert.equal(JSON.parse(request.body).instanceId, run().id);
  for (const baseUrl of ['http://localhost:3100', 'http://example.com', 'http://127.0.0.1:3100/redirect', 'http://user@127.0.0.1:3100',
    'https://example.com/internal', 'https://example.com?x=1', 'https://user@example.com', 'ftp://127.0.0.1:3100'])
    assert.throws(() => new VoiceControlClient({ baseUrl, token: 'service'.repeat(8), instanceId: run().id }), /loopback/);
});
test('S25: a remote worker may reach Control over HTTPS, and only over HTTPS', async () => {
  const requests = []; const client = new VoiceControlClient({ baseUrl: 'https://vodog.example.com', token: 'service'.repeat(8), instanceId: run().id,
    fetcher: async (url, options) => { requests.push({ url, ...options }); return new Response(null, { status: 204 }); } });
  await client.heartbeat();
  assert.equal(requests[0].url, 'https://vodog.example.com/internal/v1/ai/workers/heartbeat');
  // The forwarded hop must keep every property the loopback hop had: no redirect following, the
  // service token in Authorization, and a bounded per-request deadline.
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[0].headers.Authorization, `Bearer ${'service'.repeat(8)}`);
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.equal(new VoiceControlClient({ baseUrl: 'https://vodog.example.com/', token: 'service'.repeat(8), instanceId: run().id }).baseUrl,
    'https://vodog.example.com');
});
test('Control error messages are bounded and never echo upstream secrets', async () => {
  const options = { baseUrl: 'http://127.0.0.1:3100', token: 'service'.repeat(8), instanceId: run().id };
  const client = new VoiceControlClient({ ...options, fetcher: async () => new Response(JSON.stringify({ error: { code: 'AI_LEASE_LOST', message: 'secret-value' } }), { status: 409 }) });
  await assert.rejects(client.read(run()), error => error.code === 'AI_LEASE_LOST' && !error.message.includes('secret-value'));
  const large = new VoiceControlClient({ ...options, fetcher: async () => new Response('x'.repeat(200 * 1024)) });
  await assert.rejects(large.read(run()), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('the greeting waits for real audio authority, is sent once, and its transcript reaches Control', async () => {
  const s = setup(); const task = s.worker.execute(run());
  await until(() => s.bridge.started); assert.equal(s.agent.greets, 0);
  s.control.read = async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true });
  await until(() => s.bridge.history.includes(true)); assert.equal(s.agent.greets, 0);
  // S25 决策 8: authority opens the gate, the caller's first RTP packet releases the greeting.
  s.peer.emit('inboundRtp');
  await until(() => s.agent.greets === 1);
  s.agent.emit('transcript', { text: '你好', final: false, responseId: 'r1' });
  s.agent.emit('completed', { responseId: 'r1' });
  s.agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  await delay(20); assert.equal(s.agent.greets, 1);
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
  assert.deepEqual(s.posts.map(item => [item.role, item.sequence, item.text]), [['ai', 0, '你好'], ['caller', 1, '我要退款']]);
  assert.deepEqual(s.logs.at(-1).transcripts, { sent: 2, dropped: 0, failed: 0, pending: 0, merged: 0 });
});
test('a best-effort provider notice is logged instead of failing the run', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run()); await until(() => s.bridge.history.includes(true));
  s.agent.emit('notice', { kind: 'best_effort_rejected', message: 'unimplemented' });
  await until(() => s.logs.some(record => record.event === 'provider_notice'));
  assert.equal(s.logs.find(record => record.event === 'provider_notice').kind, 'best_effort_rejected');
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await task;
  assert.deepEqual(s.calls, ['commit', 'offer']);
});
test('a playback overflow notice from the bridge is logged instead of failing the run', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run()); await until(() => s.bridge.history.includes(true));
  s.bridge.emit('notice', { kind: 'playback_overflow', generation: 0, droppedBytes: 640 });
  await until(() => s.logs.some(record => record.event === 'provider_notice'));
  assert.equal(s.logs.find(record => record.event === 'provider_notice').kind, 'playback_overflow');
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await task;
  assert.deepEqual(s.calls, ['commit', 'offer']);
});
test('a lease Control has already cleared is reported as the call ending, not as a broken read', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run()); await until(() => s.bridge.history.includes(true));
  s.control.read = async () => { throw Object.assign(new Error('Control AI_LEASE_LOST (409)'), { status: 409, code: 'AI_LEASE_LOST' }); };
  await task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:call_terminal']);
  assert.equal(s.logs.at(-1).reason, 'call_terminal');
});
test('the maximum call duration starts at activation and hangs up through Control', async () => {
  const s = setup({ maxCallSeconds: 0.05, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  await s.worker.execute(run());
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_max_call_seconds']);
  assert.equal(s.bridge.closed, true); assert.equal(s.agent.stopped, true);
});
test('a run that never activates is never cut short by the maximum call duration', async () => {
  const s = setup({ maxCallSeconds: 0.02, activationTimeoutMs: 60 }); await s.worker.execute(run());
  assert.equal(s.calls.at(-1), 'fail:telecom_active_timeout'); assert.equal(s.agent.greets, 0);
});
test('transcripts are flushed before the run is failed and its lease is cleared', async () => {
  const order = [];
  const s = setup({ activationTimeoutMs: 20, createTranscripts: () => ({
    attach() {}, detach() {}, start() {}, stats: () => ({ sent: 0, dropped: 0, failed: 0, pending: 0 }),
    close: async () => { await delay(10); order.push('close'); } }) });
  s.control.fail = async (_run, code) => { order.push(`fail:${code}`); };
  await s.worker.execute(run());
  assert.deepEqual(order, ['close', 'fail:telecom_active_timeout']);
});

test('the transcript route carries the frozen Control contract', async () => {
  const requests = []; const client = new VoiceControlClient({ baseUrl: 'http://127.0.0.1:3100', token: 'service'.repeat(8), instanceId: run().id,
    fetcher: async (url, options) => { requests.push({ url, ...options }); return new Response(JSON.stringify({ accepted: true, stored: 1 })); } });
  const items = [{ role: 'ai', sequence: 0, text: '你好', at: new Date().toISOString() }];
  assert.deepEqual(await client.transcript(run(), items), { accepted: true, stored: 1 });
  assert.equal(requests[0].url, `http://127.0.0.1:3100/internal/v1/ai/runs/${run().id}/transcript`);
  assert.equal(requests[0].headers['X-AI-Lease-Token'], run().leaseToken);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.instanceId, run().id); assert.deepEqual(body.items, items);
});
test('the maximum call duration is validated at startup instead of silently defaulted', () => {
  assert.equal(maxCallSeconds(undefined), 600); assert.equal(maxCallSeconds(''), 600); assert.equal(maxCallSeconds('900'), 900);
  for (const value of ['59', '3601', '600s', '-1', '6e2']) assert.throws(() => maxCallSeconds(value), /AI_MAX_CALL_SECONDS/);
});
test('S23: the media transport is validated at startup and reaches the media connection', async () => {
  assert.equal(mediaTransport(undefined), 'udp'); assert.equal(mediaTransport(''), 'udp');
  assert.equal(mediaTransport('tls'), 'tls'); assert.equal(mediaTransport(' udp '), 'udp');
  for (const value of ['tcp', 'TLS', 'udp,tls', '1']) assert.throws(() => mediaTransport(value), /VOICE_MEDIA_TRANSPORT/);
  const s = setup({ mediaTransport: 'tls', control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const seen = [];
  s.worker.connectPeer = async options => { seen.push(options.transport); return s.peer; };
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
  assert.deepEqual(seen, ['tls'], 'the configured transport never reached ClientMediaPeer.connect');
  assert.equal(setup().worker.mediaTransport, 'udp', 'the default must stay the UDP relay');
});

test('S23: the endpointing settings are optional, validated at startup, and absent by default', () => {
  assert.deepEqual(vadSettings({}), {}, 'production default must send no turn_detection field at all');
  assert.deepEqual(vadSettings({ VOICE_VAD_THRESHOLD: '', VOICE_VAD_PREFIX_MS: '  ' }), {}, 'an empty key is the rollback path');
  assert.deepEqual(vadSettings({ VOICE_VAD_SILENCE_MS: '800' }), { vadSilenceMs: 800 }, 'one key alone must be enough');
  assert.deepEqual(vadSettings({ VOICE_VAD_THRESHOLD: '0.5', VOICE_VAD_PREFIX_MS: '300', VOICE_VAD_SILENCE_MS: '0' }),
    { vadThreshold: 0.5, vadPrefixMs: 300, vadSilenceMs: 0 });
  for (const env of [{ VOICE_VAD_THRESHOLD: '1.5' }, { VOICE_VAD_THRESHOLD: '-0.1' }, { VOICE_VAD_THRESHOLD: '1e-1' },
    { VOICE_VAD_THRESHOLD: 'high' }, { VOICE_VAD_PREFIX_MS: '300.5' }, { VOICE_VAD_SILENCE_MS: '99999' }])
    assert.throws(() => vadSettings(env), /VOICE_VAD_/);
});

test('the run emits one structured event per fact, in order, and ends on the revocation reason', async () => {
  const s = setup({ control: {
    signaling: () => ({ options: async () => ({ mediaNodeId: 'relay-primary', mediaEpoch: 3 }), offer: async () => ({ type: 'answer', sdp: 'answer' }) }),
    read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }),
  } });
  s.worker.connectPeer = async ({ signaling }) => { await signaling.options(); await signaling.offer(); return s.peer; };
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.control.read = async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: false });
  await task;
  assert.deepEqual(s.logs.map(entry => entry.event),
    ['answer_committed', 'media_options', 'media_offer_posted', 'peer_connected', 'activated', 'revoked', 'run_closed']);
  const options = s.logs.find(entry => entry.event === 'media_options');
  assert.equal(options.mediaNodeId, 'relay-primary'); assert.equal(options.mediaEpoch, 3);
  const revoked = s.logs.find(entry => entry.event === 'revoked');
  assert.deepEqual([revoked.runState, revoked.callState, revoked.audioAllowed, revoked.reason],
    ['active', 'active', false, 'authority_revoked_while_active']);
  assert.equal(s.logs.at(-1).event, 'run_closed');
});

test('a claim is announced before any answer and an unclaimed idle loop announces nothing', async () => {
  const s = setup({ heartbeatMs: 10, idleMs: 5 });
  let claimed = false;
  s.control.claim = async () => { if (claimed) return null; claimed = true; return run(); };
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  const task = s.worker.start();
  await until(() => s.logs.some(entry => entry.event === 'run_closed'));
  await s.worker.stop(); await task;
  assert.equal(s.logs[0].event, 'run_claimed');
  assert.equal(s.logs[0].callId, run().callId);
  assert.ok(s.logs.findIndex(entry => entry.event === 'answer_committed') > 0);
});

test('an opener the agent speaks before activation is dropped instead of stored as call history', async () => {
  const s = setup(); const task = s.worker.execute(run());
  await until(() => s.bridge.started);
  // The Space agent greets itself as soon as the session opens; the bridge is still muted, so the
  // caller never heard this and it must not become a transcript line.
  s.agent.emit('transcript', { text: '我是默认开场白', final: false, responseId: 'pre' });
  s.agent.emit('completed', { responseId: 'pre' });
  s.agent.emit('transcript', { text: '来电者还没被接通', final: true, speaker: 'caller' });
  s.control.read = async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true });
  await until(() => s.bridge.history.includes(true));
  s.agent.emit('transcript', { text: '您好，这里是 AI 助理', final: false, responseId: 'post' });
  s.agent.emit('completed', { responseId: 'post' });
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
  assert.deepEqual(s.posts.map(item => item.text), ['您好，这里是 AI 助理']);
});

test('S24: garbage-collection pauses are reported per run beside the event-loop delay', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }) } });
  s.worker.gc = { count: 9, totalMs: 1, maxMs: 1 };
  await s.worker.execute(run());
  const closed = s.logs.find(entry => entry.event === 'run_closed');
  // Reset at the start of the run: the previous call's pauses must never be charged to this one.
  assert.equal(closed.gc.count < 9, true, 'gc counters were not reset for the new run');
  for (const key of ['count', 'totalMs', 'maxMs']) assert.equal(Number.isFinite(closed.gc[key]), true);
  assert.equal(Number.isFinite(closed.eventLoopMs.p99), true);
});

test('S24: the claim decides the provider and an unbuildable one ends the run without answering', async () => {
  const asked = [];
  const s = setup({ createAgent: options => { asked.push(options?.provider); return new Agent(); },
    control: { read: async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }) } });
  await s.worker.execute({ ...run(), voiceProvider: 'doubao' });
  assert.deepEqual(asked, ['doubao'], 'the run claim, not the worker default, names the provider');
  assert.deepEqual(s.calls, ['commit', 'offer']);

  // No provider on the claim keeps the worker's configured default.
  const fallback = setup({ createAgent: options => { asked.push(options?.provider); return new Agent(); }, defaultProvider: 'xai',
    control: { read: async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }) } });
  await fallback.worker.execute(run());
  assert.equal(asked.at(-1), 'xai');

  // A provider this worker cannot build never answers; Control falls back to an ordinary ring.
  const missing = setup({ createAgent: () => { throw Object.assign(new Error('nope'), { code: 'provider_unavailable' }); } });
  await missing.worker.execute({ ...run(), voiceProvider: 'doubao' });
  assert.deepEqual(missing.calls, ['fail:provider_unavailable']);

  const malformed = setup({ createAgent: () => new Agent() });
  await malformed.worker.execute({ ...run(), voiceProvider: 'Doubao Realtime' });
  assert.deepEqual(malformed.calls, ['fail:provider_unavailable']);
});

test('S24: the heartbeat announces exactly the providers this worker can serve', async () => {
  const bodies = [];
  const options = { baseUrl: 'http://127.0.0.1:3100', token: 'service'.repeat(8), instanceId: run().id,
    fetcher: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('null'); } };
  await new VoiceControlClient({ ...options, providers: ['xai'] }).heartbeat();
  assert.deepEqual(bodies[0], { instanceId: run().id, bootId: bodies[0].bootId, protocol: 'voice-run-v1', capacity: 1, providers: ['xai'] });
  await new VoiceControlClient(options).heartbeat();
  assert.deepEqual(bodies[1].providers, [], 'an unconfigured worker must announce nothing, not a default');
  for (const providers of [['xAI'], ['a b'], [''], ['x'.repeat(33)], [1], 'xai', Array(17).fill('xai')])
    assert.throws(() => new VoiceControlClient({ ...options, providers }), /announced voice providers/);
});

/** A run that reached ACTIVE, which is the only state the S27 timers are armed in. */
async function activated(overrides = {}) {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) }, ...overrides });
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  return { ...s, task };
}

test('S27: the maximum call length comes from the provider that answers the call, not from one global', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) }, maxCallSeconds: 600 });
  // The already-parsed startup configuration rides on the agent; doubao carries 180 s, xAI none.
  s.agent.config = { maxCallSeconds: 0.05, silenceHangupSeconds: 0 };
  await s.worker.execute(run());
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_max_call_seconds']);
  const activation = s.logs.find(record => record.event === 'activated');
  assert.deepEqual([activation.maxCallSeconds, activation.silenceHangupSeconds], [0.05, 0]);
});

test('S27: a provider without limits of its own keeps the worker-wide maximum', async () => {
  const s = await activated({ maxCallSeconds: 0.05 });
  await s.task;
  assert.equal(s.calls.at(-1), 'fail:ai_max_call_seconds');
  assert.equal(s.logs.find(record => record.event === 'activated').maxCallSeconds, 0.05);
});

test('S27: a caller who stops talking after the AI finished a turn is hung up, and speech disarms it', async () => {
  // Seconds are integers in the real configuration; 50 ms only keeps the test from waiting 15 s.
  // The configuration is read when the agent is created, so it has to be set before `execute`.
  const armed = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  armed.agent.config = { silenceHangupSeconds: 0.05 };
  const task = armed.worker.execute(run());
  await until(() => armed.bridge.history.includes(true));
  // Only a turn the caller actually heard arms it: `current`, after the audio gate. A stale
  // generation's completion is not one the caller is listening to.
  armed.agent.emit('completed', { status: 'completed', current: false });
  await delay(80);
  assert.equal(armed.calls.includes('fail:caller_silence_timeout'), false);
  // An interrupted (cancelled) current turn arms it too: the AI stopped talking either way, and a
  // barge-in that the model never answers must not run to the 3-minute cap.
  armed.agent.emit('completed', { status: 'cancelled', current: true });
  await task;
  assert.deepEqual(armed.calls, ['commit', 'offer', 'fail:caller_silence_timeout']);
  assert.deepEqual(armed.logs.find(record => record.event === 'silence_hangup'), { event: 'silence_hangup', runId: run().id, seconds: 0.05 });
});

test('S27: the silence timer is disarmed the moment the caller starts speaking', async () => {
  const s = await activated();
  s.agent.emit('completed', { status: 'completed', current: true });
  s.agent.emit('speechStarted');
  await delay(80);
  assert.equal(s.calls.includes('fail:caller_silence_timeout'), false);
  await s.worker.stop(); await s.task;
});

test('S27: silence hangup stays off for a provider that does not configure it', async () => {
  const s = await activated();
  s.agent.emit('completed', { status: 'completed', current: true });
  await delay(60);
  assert.equal(s.calls.includes('fail:caller_silence_timeout'), false);
  await s.worker.stop(); await s.task;
});

test('S27: an AI that says goodbye hangs up only after the caller has heard it', async () => {
  const s = await activated();
  s.agent.emit('notice', { kind: 'exit_intent' });
  await s.task;
  assert.equal(s.bridge.drained, 1, 'the goodbye was cut off mid-sentence');
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
  assert.equal(s.logs.some(record => record.event === 'provider_notice' && record.kind === 'exit_intent'), true);
  assert.equal(s.logs.some(record => record.event === 'ai_ended_call'), true);
});

test('S27: the end_call tool ends the run exactly like the exit intent, and only once', async () => {
  const s = await activated();
  s.agent.emit('notice', { kind: 'end_call' });
  s.agent.emit('notice', { kind: 'end_call' });
  await s.task;
  assert.equal(s.bridge.drained, 1);
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
  // S27 决策 14: the hangup uses the end-of-call rule, not "wait for an empty queue" — an
  // unanswered `end_call` never completes its turn, so the plain predicate always hit the bound.
  assert.deepEqual(s.bridge.drainOptions, { timeoutMs: 15_000, minMs: 3_000, quietMs: 1_500 });
});

// S27 决策 15 (real call c3734597, 2026-09-12 13:55 UTC): the provider reported its own socket
// teardown as an error 1.2 s after `end_call`, the run was filed `provider_failed`, and tearing the
// bridge down under the drain discarded 27840 bytes — 0.87 s of the goodbye the caller never heard.
test('S27 决策 15: a provider fault after its own end_call never turns the hangup into a failure', async () => {
  const s = await activated();
  s.agent.emit('notice', { kind: 'end_call' });
  s.agent.emit('fault', new Error('read ECONNRESET'));
  s.agent.emit('closed', { reason: 'ended_by_provider' });
  await s.task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
  assert.equal(s.logs.some(record => record.event === 'provider_fault_after_end_call'), true);
  assert.equal(s.calls.includes('fail:provider_failed'), false);
});

test('S27 决策 15: a provider fault with no hangup in flight still ends the run as a failed provider', async () => {
  const s = await activated();
  s.agent.emit('fault', new Error('read ECONNRESET'));
  await s.task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:provider_failed']);
  assert.equal(s.logs.some(record => record.event === 'provider_fault_after_end_call'), false);
});

// S27 决策 15 (real call 3a271664): the queue played every byte it received and the goodbye was
// still heard as clipped — the gateway leg and the Pixel's playout buffer hold the tail.
test('S27 决策 15: the hangup holds a tail after the queue drains so the far end can play it out', async () => {
  const s = await activated({ aiEndTailMs: 150 });
  const noticeAt = Date.now();
  s.agent.emit('notice', { kind: 'end_call' });
  await s.task;
  const elapsed = Date.now() - noticeAt;
  assert.ok(elapsed >= 150, `hung up after ${elapsed} ms, before the 150 ms tail had elapsed`);
  assert.equal(s.logs.find(record => record.event === 'ai_ended_call')?.tailMs, 150);
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
});

// S27 决策 14 (2026-09-12 in-image A/B): xAI kills a silent Space-agent session at ~17 s, so a run
// claimed 30 s before `timeout_ai` used to lose the provider before the call was ever answered.
test('S27 决策 14: a Space-agent session waits for the prewarm lead instead of opening at claim', async () => {
  const s = setup();
  s.agent.config = { prewarmLeadMs: 200 };
  let startedAt = null;
  s.agent.start = async () => { startedAt = Date.now(); s.agent.ready = true; };
  const triggerAt = Date.now() + 500;
  const task = s.worker.execute({ ...run(), triggerAt: new Date(triggerAt).toISOString() });
  await delay(120);
  assert.equal(startedAt, null, 'a session opened at claim is dead before the answer');
  await until(() => startedAt !== null);
  assert.ok(startedAt >= triggerAt - 200 - 60 && startedAt <= triggerAt, `opened ${triggerAt - startedAt} ms before triggerAt`);
  const deferred = s.logs.find(record => record.event === 'provider_start_deferred');
  assert.equal(deferred?.leadMs, 200);
  await s.worker.stop(); await task;
});

test('S27 决策 14: a provider that carries no prewarm lead still opens its session at claim time', async () => {
  const s = setup();
  let startedAt = null;
  s.agent.start = async () => { startedAt = Date.now(); s.agent.ready = true; };
  const claimedAt = Date.now();
  const task = s.worker.execute({ ...run(), triggerAt: new Date(claimedAt + 500).toISOString() });
  await until(() => startedAt !== null);
  assert.ok(startedAt - claimedAt < 150, 'Doubao mutes its own session and prewarms exactly as before');
  assert.equal(s.logs.some(record => record.event === 'provider_start_deferred'), false);
  await s.worker.stop(); await task;
});

test('S27 决策 14: an abort during the prewarm wait never opens a provider session', async () => {
  const s = setup();
  s.agent.config = { prewarmLeadMs: 200 };
  let starts = 0;
  s.agent.start = async () => { starts++; };
  const task = s.worker.execute({ ...run(), triggerAt: new Date(Date.now() + 5_000).toISOString() });
  await until(() => s.logs.some(record => record.event === 'provider_start_deferred'));
  await s.worker.stop(); await task;
  assert.equal(starts, 0);
  assert.deepEqual(s.calls, ['fail:worker_shutdown'], 'no answer, no media, and the lease is released');
  assert.equal(s.worker.activeAbort, null);
});

// S27 决策 13（2026-09-12 探针 T1）: the xAI Space agent hangs up by calling its own `end_call`; the
// server then injects `{"status":"ending_call"}` and closes the WebSocket ~1.5 s later, while about
// a second of the goodbye is still queued in the bridge. Reporting that close as
// `provider_disconnected` both mislabelled the run and tore the bridge down mid-sentence.
test('S27 决策 13: a provider that closes after its own end_call ends the run as an AI hangup, never a disconnect', async () => {
  const s = await activated();
  let releaseDrain;
  s.bridge.whenPlaybackDrained = () => {
    s.bridge.drained = (s.bridge.drained ?? 0) + 1;
    return new Promise(resolve => { releaseDrain = () => resolve(true); });
  };
  s.agent.emit('notice', { kind: 'end_call' });
  await until(() => s.bridge.drained === 1);
  s.agent.emit('closed', { reason: 'ended_by_provider' });
  await delay(30);
  assert.equal(s.calls.includes('fail:provider_disconnected'), false);
  assert.equal(s.bridge.closed, undefined, 'the caller is still hearing the goodbye');
  releaseDrain();
  await s.task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
  assert.equal(s.logs.some(record => record.event === 'provider_closed_after_end_call' && record.expected === true), true);
});

test('S27 决策 13: an ended_by_provider close with no notice behind it still drains before hanging up', async () => {
  const s = await activated();
  s.agent.emit('closed', { reason: 'ended_by_provider' });
  await s.task;
  assert.equal(s.bridge.drained, 1);
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
});

test('S27 决策 13: a provider that simply disconnects is still reported as one', async () => {
  const s = await activated();
  s.agent.emit('closed', {});
  await s.task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:provider_disconnected']);
  assert.equal(s.logs.some(record => record.event === 'provider_closed_after_end_call'), false);
});

test('S27: an ordinary provider notice never ends the call', async () => {
  const s = await activated();
  s.agent.emit('notice', { kind: 'input_backlog' });
  s.agent.emit('notice', { kind: 'transcription_failed' });
  await delay(30);
  assert.equal(s.bridge.drained, undefined);
  assert.equal(s.calls.includes('fail:ai_ended_call'), false);
  await s.worker.stop(); await s.task;
});

test('S24: the default provider is validated against what is actually configured at startup', () => {
  const configured = ['xai'];
  assert.equal(defaultProvider(undefined, configured), 'xai');
  assert.equal(defaultProvider('', configured), 'xai');
  assert.equal(defaultProvider(' xai ', configured), 'xai');
  assert.throws(() => defaultProvider('XAI', configured), /VOICE_PROVIDER/);
  // S27: `doubao` is a registered provider now, so the "named but not available here" case needs
  // an id that is genuinely not in the registry; the registered-but-unconfigured case is next.
  assert.throws(() => defaultProvider('unknown_provider', configured), /not configured/);
  assert.throws(() => defaultProvider('doubao', configured), /not configured/);
  assert.equal(defaultProvider('doubao', ['xai', 'doubao']), 'doubao');
  assert.throws(() => defaultProvider('xai', []), /not configured/);
});

test('S25: the xAI forwarding port is optional, validated at startup, and absent by default', () => {
  assert.deepEqual(xaiRealtimePort({}), {});
  assert.deepEqual(xaiRealtimePort({ XAI_REALTIME_PORT: '' }), {});
  assert.deepEqual(xaiRealtimePort({ XAI_REALTIME_PORT: ' 16890 ' }), { realtimePort: 16890 });
  assert.deepEqual(xaiRealtimePort({ XAI_REALTIME_PORT: '443' }), { realtimePort: 443 });
  // `Number()` would accept every one of these; the regex is the layer that does not.
  for (const value of ['0', '65536', '99999', '-1', '443.0', '+443', '0x1bb', '1e3', 'https', '443 443'])
    assert.throws(() => xaiRealtimePort({ XAI_REALTIME_PORT: value }), /XAI_REALTIME_PORT/);
});

test('log lines carry ts, nodeId and the callId learned for their runId', () => {
  const lines = [];
  const log = jsonLogger({ nodeId: 'relay-secondary', write: line => lines.push(line), now: () => new Date(Date.UTC(2026, 8, 27, 1, 2, 3, 45)) });
  log({ event: 'media_gap', runId: 'r1', sinceMs: 5 });
  log({ event: 'run_claimed', runId: 'r1', callId: 'c1' });
  log({ event: 'media_gap', runId: 'r1', sinceMs: 5 });
  log({ event: 'provider_notice', runId: 'r1', kind: 'x' });
  log({ event: 'run_closed', runId: 'r1', callId: 'c1', reason: 'terminal' });
  log({ event: 'media_gap', runId: 'r1', sinceMs: 5 });
  const parsed = lines.map(line => { assert.ok(line.endsWith('\n')); return JSON.parse(line); });
  assert.deepEqual(Object.keys(parsed[2]), ['ts', 'level', 'event', 'nodeId', 'callId', 'runId', 'sinceMs']);
  assert.deepEqual(parsed[2], { ts: '2026-09-27T01:02:03.045Z', level: 'warn', event: 'media_gap', nodeId: 'relay-secondary', callId: 'c1', runId: 'r1', sinceMs: 5 });
  assert.deepEqual(Object.keys(parsed[3]).slice(0, 4), ['ts', 'level', 'event', 'kind']);
  assert.equal(parsed[3].callId, 'c1');
  assert.equal('callId' in parsed[0], false);
  assert.equal('callId' in parsed[5], false);
  const bare = [];
  jsonLogger({ write: line => bare.push(JSON.parse(line)) })({ event: 'worker_idle' });
  assert.equal('nodeId' in bare[0], false);
});

test('S25: the node id is optional, validated at startup, and only ever rides the heartbeat', async () => {
  assert.equal(workerNodeId(undefined), undefined);
  assert.equal(workerNodeId(''), undefined);
  assert.equal(workerNodeId(' relay-secondary '), 'relay-secondary');
  for (const value of ['RELAY-SECONDARY', '2gz', 'gz 200m', 'gz.200m', 'g'.repeat(33)]) assert.throws(() => workerNodeId(value), /VOICE_NODE_ID/);

  const bodies = [];
  const options = { baseUrl: 'https://vodog.example.com', token: 'service'.repeat(8), instanceId: run().id,
    fetcher: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('null'); } };
  const client = new VoiceControlClient({ ...options, providers: ['xai'], nodeId: 'relay-secondary' });
  await client.heartbeat();
  assert.deepEqual(bodies[0], { instanceId: run().id, bootId: bodies[0].bootId, protocol: 'voice-run-v1', capacity: 1, providers: ['xai'], nodeId: 'relay-secondary' });
  await client.claim();
  assert.deepEqual(bodies[1], { instanceId: run().id, bootId: bodies[0].bootId }, 'the frozen claim body must not grow a node id');

  // Unset stays byte-for-byte the body Control has always received.
  await new VoiceControlClient({ ...options, providers: ['xai'] }).heartbeat();
  assert.deepEqual(Object.keys(bodies[2]).includes('nodeId'), false);
  for (const nodeId of ['RELAY-SECONDARY', '', 'gz 200m', 7]) assert.throws(() => new VoiceControlClient({ ...options, nodeId }), /worker node id/);
});

test('S25/S70d: the greeting waits for the first inbound RTP packet and is spoken exactly once', async () => {
  // A wait long enough that only inbound RTP can release the greeting in this test.
  const s = setup({ greetingWaitMs: 5_000, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  // Audio authority alone is not proof that the gateway data channel carries audio; the bridge
  // discards every AI frame sent before it opens, which is how callers lost the opening words.
  await delay(20);
  assert.equal(s.agent.greets, 0, 'the greeting must not be sent while the channel is still opening');
  // S70d: the sink emits silence frames before any RTP arrives; they must not release the greeting.
  for (let i = 0; i < 5; i++) s.peer.emit('pcm', callerFrame());
  await delay(20);
  assert.equal(s.agent.greets, 0, 'pcm frames alone must not release the greeting');
  s.peer.emit('inboundRtp');
  await until(() => s.agent.greets === 1);
  s.peer.emit('inboundRtp');
  for (let i = 0; i < 5; i++) s.peer.emit('pcm', callerFrame());
  await delay(20);
  assert.equal(s.agent.greets, 1, 'later caller audio must never produce a second greeting');
  const greetings = s.logs.filter(entry => entry.event === 'greeting_sent');
  assert.equal(greetings.length, 1);
  assert.equal(greetings[0].trigger, 'first_inbound_rtp');
  assert.equal(greetings[0].runId, run().id);
  assert.equal(Number.isFinite(greetings[0].waitedMs) && greetings[0].waitedMs >= 0, true);
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
});

test('S25: a silent caller is still greeted when the wait expires', async () => {
  const s = setup({ greetingWaitMs: 25, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run());
  await until(() => s.agent.greets === 1);
  const sent = s.logs.find(entry => entry.event === 'greeting_sent');
  assert.equal(sent.trigger, 'timeout');
  assert.equal(sent.waitedMs >= 20, true, 'the timeout greeting must report the real wait');
  // The RTP that finally arrives must not repeat the opening line.
  s.peer.emit('inboundRtp');
  await delay(10);
  assert.equal(s.agent.greets, 1);
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
});

test('S25: a run that ends before the greeting is released never greets', async () => {
  // Never activated: the wait never starts, so ACTIVE remains the only gate.
  const never = setup({ activationTimeoutMs: 20, greetingWaitMs: 1 });
  await never.worker.execute(run());
  assert.equal(never.agent.greets, 0);
  assert.equal(never.logs.some(entry => entry.event === 'greeting_sent'), false);
  assert.equal(never.calls.at(-1), 'fail:telecom_active_timeout');

  // Activated, then the call ends inside the wait window: the pending timer must not speak into a
  // closed run, and nothing may be logged for it.
  const s = setup({ greetingWaitMs: 40, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
  await delay(60);
  assert.equal(s.agent.greets, 0);
  assert.equal(s.logs.some(entry => entry.event === 'greeting_sent'), false);
  assert.equal(s.logs.at(-1).event, 'run_closed');
});

test('S25: a media peer closed by an ending call is reported as the call ending, not as a media fault', async () => {
  // The authority poll is deliberately slow here: the reason must come from the media fault's own
  // Control read, exactly as it does in production where the bridge closes the leg first.
  const s = setup({ pollMs: 1_000, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.control.read = async () => ({ run: { state: 'active' }, callState: 'ending', audioAllowed: true });
  s.peer.emit('fault', new Error('WebRTC connection closed'));
  await task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:call_terminal']);
  assert.equal(s.logs.at(-1).reason, 'call_terminal');
});

test('S25: a media peer that closes while the call is still live remains a media fault', async () => {
  const s = setup({ pollMs: 1_000, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.peer.emit('fault', new Error('WebRTC connection failed'));
  await task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:media_failed']);
  assert.equal(s.logs.at(-1).reason, 'media_failed');

  // A Control read that fails cannot exonerate the media path: the pessimistic reason stands.
  const blind = setup({ pollMs: 1_000, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const second = blind.worker.execute(run());
  await until(() => blind.bridge.history.includes(true));
  blind.control.read = async () => { throw new Error('disconnected'); };
  blind.bridge.emit('fault', new Error('PCM pipeline failed'));
  await second;
  assert.deepEqual(blind.calls, ['commit', 'offer', 'fail:media_failed']);
});

// S27 决策 16 (real call c421d601, 2026-09-12 14:24 UTC): the caller kept talking after the
// provider closed, the uplink throw surfaced as a bridge fault, and `media_failed` ended the run
// 0.1 s later — 1.7 s of the goodbye was cleared before the drain and the tail could run.
test('S27 决策 16: a media fault after end_call never ends the run as media_failed', async () => {
  const s = await activated();
  s.agent.emit('notice', { kind: 'end_call' });
  s.bridge.emit('fault', new Error('AI not ready'));
  await s.task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:ai_ended_call']);
  assert.equal(s.logs.some(record => record.event === 'media_fault_after_end_call'), true);
  assert.equal(s.logs.some(record => record.event === 'media_fault'), false);
});

test('S27 决策 16: a media fault with no AI hangup in flight still ends the run as media_failed', async () => {
  const s = await activated();
  s.bridge.emit('fault', new Error('peer is gone'));
  await s.task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:media_failed']);
  assert.equal(s.logs.some(record => record.event === 'media_fault_after_end_call'), false);
});

test('heap self-heal: run_closed reports memory, and a heap still over the limit after gc restarts between calls', async () => {
  const MB = 1_048_576; let heap = 50 * MB, gcs = 0; const exits = [];
  let claimed = false;
  const s = setup({ heapRestartMb: 120, memoryUsage: () => ({ heapUsed: heap, rss: 200 * MB }), forceGc: () => { gcs++; }, exit: code => exits.push(code),
    control: { claim: async () => { if (claimed) return null; claimed = true; return run(); },
      read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
  const task = s.worker.start();
  await until(() => s.bridge.history.includes(true));
  heap = 150 * MB; // grows mid-call: must never exit while the run is active
  await delay(30); assert.deepEqual(exits, []); assert.equal(gcs, 0);
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false });
  await task;
  const closed = s.logs.find(entry => entry.event === 'run_closed');
  assert.deepEqual([closed.heapUsedMb, closed.rssMb], [150, 200]);
  assert.deepEqual(s.logs.at(-1), { event: 'worker_restart', reason: 'heap', heapMb: 150, limitMb: 120 });
  assert.equal(gcs, 1); assert.deepEqual(exits, [0]); assert.equal(s.worker.shutdown.signal.aborted, true);
});
test('heap self-heal: an idle worker restarts too, but not when gc brings the heap back under the limit', async () => {
  const MB = 1_048_576; let heap = 130 * MB; const exits = [];
  const s = setup({ heapRestartMb: 120, memoryUsage: () => ({ heapUsed: heap, rss: heap }), forceGc: () => { heap = 60 * MB; }, exit: code => exits.push(code) });
  const task = s.worker.start(); await delay(40);
  assert.deepEqual(exits, []); assert.equal(s.logs.some(entry => entry.event === 'worker_restart'), false);
  s.worker.forceGc = () => {}; heap = 130 * MB; await task;
  assert.deepEqual(exits, [0]); assert.equal(s.logs.at(-1).heapMb, 130);
});
test('control_unavailable names the error and the phase it came from', async () => {
  const s = setup({ control: { claim: async () => { throw new TypeError('fetch failed'); } } });
  const task = s.worker.start(); await until(() => s.logs.some(entry => entry.event === 'control_unavailable'));
  await s.worker.stop(); await task;
  assert.deepEqual(s.logs.find(entry => entry.event === 'control_unavailable'), { event: 'control_unavailable', phase: 'claim', errorName: 'TypeError', message: 'fetch failed' });
});
test('a greeting the agent refuses or throws on is logged as greet_failed, never as greeting_sent', async () => {
  for (const greet of [() => false, () => { throw new Error('port closed'); }]) {
    const s = setup({ greetingWaitMs: 0, control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) } });
    s.agent.greet = greet; const task = s.worker.execute(run());
    await until(() => s.logs.some(entry => entry.event === 'greet_failed'));
    s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await task;
    assert.equal(s.logs.some(entry => entry.event === 'greeting_sent'), false);
    assert.match(s.logs.find(entry => entry.event === 'greet_failed').message, /greet_refused|port closed/);
  }
});
test('a provider send failure notice is logged as its own event, not as a provider_notice', async () => {
  const s = setup(); const task = s.worker.execute(run()); await until(() => s.bridge.started);
  s.agent.emit('notice', { kind: 'provider_send_failed', message: 'WebSocket is not open' });
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await task;
  assert.ok(s.logs.some(entry => entry.event === 'provider_send_failed' && entry.message === 'WebSocket is not open'));
  assert.equal(s.logs.some(entry => entry.kind === 'provider_send_failed'), false);
});

test('S69: control_unavailable is logged once per outage and control_recovered once when it ends, per phase', () => {
  const logs = []; let now = 1_000;
  const note = controlHealth(record => logs.push(record), () => now);
  note('claim', Object.assign(new Error('Control X (502)'), { code: 'X' })); now += 500;
  note('claim', new Error('again')); note('claim', new Error('again'));
  note('heartbeat'); // a working heartbeat must not end the claim outage
  assert.deepEqual(logs.map(entry => entry.event), ['control_unavailable']);
  assert.deepEqual([logs[0].phase, logs[0].errorName, logs[0].code], ['claim', 'Error', 'X']);
  now += 1_500; note('claim');
  assert.deepEqual(logs.at(-1), { event: 'control_recovered', phase: 'claim', failures: 3, outageMs: 2_000 });
  note('claim'); assert.equal(logs.length, 2, 'a healthy phase logs nothing');
});

test('S69: a failing claim loop logs one control_unavailable, not one per retry', async () => {
  const s = setup({ control: { claim: async () => { throw new TypeError('fetch failed'); } } });
  const task = s.worker.start(); await delay(80); await s.worker.stop(); await task;
  assert.equal(s.logs.filter(entry => entry.event === 'control_unavailable').length, 1);
});

test('S69: log levels', () => {
  assert.equal(logLevel({ event: 'provider_notice', kind: 'input_backpressure_fatal' }), 'error');
  assert.equal(logLevel({ event: 'provider_notice', kind: 'socket_error' }), 'error');
  assert.equal(logLevel({ event: 'provider_notice', kind: 'setup_timeout' }), 'error');
  assert.equal(logLevel({ event: 'worker_run_failed' }), 'error');
  assert.equal(logLevel({ event: 'control_unavailable' }), 'warn');
  assert.equal(logLevel({ event: 'run_closed', reason: 'terminal' }), 'info');
  assert.equal(logLevel({ event: 'run_closed', reason: 'media_failed' }), 'warn');
  assert.equal(logLevel({ event: 'run_claimed' }), 'info');
});

test('S69: run_closed carries call, provider, barge-ins and the last authority read', async () => {
  const s = await activated();
  s.agent.emit('speechStarted'); s.agent.emit('speechStarted');
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await s.task;
  const closed = s.logs.find(entry => entry.event === 'run_closed');
  assert.deepEqual([closed.callId, closed.provider, closed.bargeIns, closed.greeted, closed.callState, closed.runState], [run().callId, 'xai', 2, false, 'ended', 'ended']);
  assert.ok(closed.durationMs >= 0);
});

test('S69: a provider disconnect logs its close code and a fault logs name and code, never the message', async () => {
  const d = await activated();
  d.agent.emit('closed', { closeCode: 1006 }); await d.task;
  assert.deepEqual(d.logs.find(entry => entry.event === 'provider_disconnected'), { event: 'provider_disconnected', runId: run().id, provider: 'xai', closeCode: 1006, reason: 'socket_closed' });
  const f = await activated();
  f.agent.emit('fault', Object.assign(new Error('secret provider text'), { code: 'quota_exceeded' })); await f.task;
  assert.deepEqual(f.logs.find(entry => entry.event === 'provider_fault'), { event: 'provider_fault', runId: run().id, provider: 'xai', errorName: 'Error', code: 'quota_exceeded' });
  // Our own teardown closes the provider too; that must not read as a disconnect.
  const n = await activated();
  n.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await n.task;
  n.agent.emit('closed', {});
  assert.equal(n.logs.some(entry => entry.event === 'provider_disconnected'), false);
});

test('S69: an idle worker reports heap and uptime; heartbeat failure logs once per streak', async () => {
  let beats = 0;
  const s = setup({ idleReportMs: 20, uptime: () => 7200, memoryUsage: () => ({ heapUsed: 50 * 1_048_576, rss: 90 * 1_048_576 }), heartbeatMs: 5,
    control: { heartbeat: async () => { if (++beats > 1) throw Object.assign(new Error('Control X (503)'), { name: 'ControlError', code: 'X' }); } } });
  const task = s.worker.start(); await delay(80); await s.worker.stop(); await task;
  assert.deepEqual(s.logs.find(entry => entry.event === 'worker_idle'), { event: 'worker_idle', heapMb: 50, rssMb: 90, uptimeH: 2 });
  const failed = s.logs.filter(entry => entry.event === 'heartbeat_failed');
  assert.deepEqual(failed, [{ event: 'heartbeat_failed', errorName: 'ControlError', code: 'X', runAborted: false }]);
});

test('S69: media_disconnected carries the ICE snapshot and media_reconnected the outage length', async () => {
  const s = await activated();
  s.peer.iceSnapshot = async () => ({ connectionState: 'disconnected' });
  s.peer.emit('disconnected'); await until(() => s.logs.some(entry => entry.event === 'media_disconnected'));
  s.peer.emit('reconnected');
  s.control.read = async () => ({ run: { state: 'ended' }, callState: 'ended', audioAllowed: false }); await s.task;
  assert.deepEqual(s.logs.find(entry => entry.event === 'media_disconnected').iceSnapshot, { connectionState: 'disconnected' });
  assert.ok(Number.isInteger(s.logs.find(entry => entry.event === 'media_reconnected').downMs));
});

test('S73f: silence with caller RTP flowing still hangs up; a media gap pauses it and resuming restarts it from zero', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) }, mediaGapHangupMs: 10_000 });
  s.agent.config = { silenceHangupSeconds: 0.08 };
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.peer.emit('inboundRtp');
  s.agent.emit('completed', { status: 'completed', current: true });
  await delay(40);
  // The gateway leg drops: RTP stops. The 80 ms silence rule must not fire during the gap.
  s.peer.emit('mediaGap', { sinceMs: 20 });
  await delay(150);
  assert.equal(s.calls.some(call => call.startsWith('fail:')), false, 'a media gap is not a silent caller');
  s.peer.emit('mediaResumed', { gapMs: 170 });
  assert.deepEqual(s.logs.find(record => record.event === 'media_resumed'), { event: 'media_resumed', runId: run().id, gapMs: 170 });
  // Restarted from zero: not yet at 50 ms, fired by the full 80 ms after resume.
  await delay(50);
  assert.equal(s.calls.some(call => call.startsWith('fail:')), false);
  await task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:caller_silence_timeout']);
  assert.equal(s.logs.some(record => record.event === 'media_gap_hangup'), false);
});

test('S73f: a media gap longer than the rejoin window ends the run as media_lost', async () => {
  const s = setup({ control: { read: async () => ({ run: { state: 'active' }, callState: 'active', audioAllowed: true }) }, mediaGapHangupMs: 60 });
  s.agent.config = { silenceHangupSeconds: 0.03 };
  const task = s.worker.execute(run());
  await until(() => s.bridge.history.includes(true));
  s.peer.emit('inboundRtp');
  s.peer.emit('mediaGap', { sinceMs: 20 });
  // A turn completing during the gap must not arm the silence timer either.
  s.agent.emit('completed', { status: 'completed', current: true });
  await task;
  assert.deepEqual(s.calls, ['commit', 'offer', 'fail:media_lost']);
  assert.deepEqual(s.logs.find(record => record.event === 'media_gap_hangup'), { event: 'media_gap_hangup', runId: run().id, gapMs: 60 });
  assert.equal(s.logs.find(record => record.event === 'run_closed').reason, 'media_lost');
  assert.equal(s.logs.some(record => record.event === 'silence_hangup'), false);
});
