import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { XaiVoiceAgent } from './providers/xai.mjs';
import { availableProviders, createVoiceAgent, providerConfig } from './providers/index.mjs';
import { serveVoiceAgent } from './provider-thread.mjs';
import { ThreadedVoiceAgent } from './provider-proxy.mjs';
import { transferableBytes } from './pcm-pipeline.mjs';

/** The same fake socket the adapter's own suite uses: the adapter is unchanged by the move. */
class Socket extends EventEmitter { readyState = 1; bufferedAmount = 0; sent = []; send(s) { this.sent.push(JSON.parse(s)); } close() { this.readyState = 3; this.emit('close'); } }

async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(2); } assert.fail('Condition was not reached'); }

/**
 * A live session across a real `MessagePort` pair, with the real adapter on the far side and a
 * fake provider socket behind it. This is the whole protocol without the cost of a thread; the
 * spawned-thread path gets its own test below.
 */
async function session({ release = true, ...overrides } = {}) {
  const socket = new Socket();
  const agent = new XaiVoiceAgent({ apiKey: 'test', agentId: 'test', socketFactory: () => socket, ...overrides });
  const channel = new MessageChannel();
  serveVoiceAgent(channel.port2, agent);
  const proxy = new ThreadedVoiceAgent({ port: channel.port1 });
  const events = [];
  for (const name of ['audio', 'flushAudio', 'completed', 'notice', 'transcript', 'speechStarted', 'response', 'closed', 'fault']) {
    proxy.on(name, payload => events.push({ name, payload }));
  }
  const started = proxy.start();
  await until(() => agent.state === 'connecting' && socket.listenerCount('open') > 0);
  socket.emit('open');
  socket.emit('message', Buffer.from('{"type":"session.updated"}'));
  const info = await started;
  // S27: in agent mode the adapter holds the Space agent's opener until greet() releases it, so a
  // test that is not about the hold releases here — in agent mode that puts nothing on the wire.
  if (release) { proxy.greet(); await until(() => agent.greeted); }
  return { socket, agent, proxy, events, info, channel };
}

test('S24: the proxied agent keeps the adapter event contract, its payload fields and its generation', async () => {
  const { socket, proxy, events } = await session();
  assert.deepEqual(proxy.outputGeneration, 0);
  assert.equal(proxy.state, 'ready');

  socket.emit('message', Buffer.from('{"type":"response.created","response":{"id":"r1"}}'));
  socket.emit('message', Buffer.from(`{"type":"response.output_audio.delta","response_id":"r1","delta":"${Buffer.alloc(640, 7).toString('base64')}"}`));
  socket.emit('message', Buffer.from('{"type":"response.output_audio_transcript.delta","delta":"你好","response_id":"r1"}'));
  socket.emit('message', Buffer.from('{"type":"response.done","response":{"id":"r1","status":"completed"}}'));
  await until(() => events.filter(e => e.name === 'completed').length === 1);

  const audio = events.find(e => e.name === 'audio').payload;
  assert.equal(Buffer.isBuffer(audio.pcm), true);
  assert.equal(audio.pcm.length, 640);
  assert.equal(audio.pcm[0], 7);
  assert.deepEqual([audio.sampleRate, audio.responseId, audio.generation], [16_000, 'r1', 0]);
  assert.deepEqual(events.find(e => e.name === 'transcript').payload, { text: '你好', final: false, responseId: 'r1' });
  assert.deepEqual(events.find(e => e.name === 'response').payload, 'r1');
  const completed = events.find(e => e.name === 'completed').payload;
  assert.deepEqual([completed.status, completed.responseId, completed.generation, completed.current], ['completed', 'r1', 0, true]);

  // Server VAD advances the provider's generation; the proxy's copy must already be current when
  // the bridge reads it, because that number is the fence deciding what the caller hears.
  socket.emit('message', Buffer.from('{"type":"input_audio_buffer.speech_started"}'));
  await until(() => events.some(e => e.name === 'speechStarted'));
  assert.equal(proxy.outputGeneration, 1);
  assert.equal(events.find(e => e.name === 'flushAudio').payload.generation, 1);
  proxy.stop();
});

test('S24: caller PCM reaches the provider through the port and pooled buffers are never detached', async () => {
  const { socket, proxy } = await session();
  // A 5×20 ms batch is 3200 bytes, which Node allocates inside its shared 8 kB buffer pool.
  const batch = Buffer.concat([Buffer.alloc(640, 1), Buffer.alloc(640, 2), Buffer.alloc(640, 3), Buffer.alloc(640, 4), Buffer.alloc(640, 5)]);
  assert.ok(batch.byteOffset !== 0 || batch.buffer.byteLength !== batch.byteLength, 'expected a pooled buffer for this regression');
  const neighbour = Buffer.allocUnsafe(64).fill(9);
  proxy.appendAudio(batch, { sampleRate: 16_000, sequence: 4 });
  await until(() => socket.sent.some(event => event.type === 'input_audio_buffer.append'));
  const sent = Buffer.from(socket.sent.at(-1).audio, 'base64');
  assert.equal(sent.length, 3200);
  assert.deepEqual([sent[0], sent[640], sent[3199]], [1, 2, 5]);
  // Transferring the pool's backing store would have detached every other view of it.
  assert.equal(batch.buffer.byteLength > 0, true);
  assert.equal(batch[0], 1);
  assert.equal(neighbour[0], 9);
  proxy.stop();
});

test('S24: transferableBytes copies a pooled view and moves a buffer that owns its store', () => {
  // Only `allocUnsafe`/`concat`/`from(base64)` take slices of the shared 8 kB pool; `Buffer.alloc`
  // owns its store. Both shapes reach the port, so both are pinned here.
  const pooled = Buffer.allocUnsafe(640).fill(1);
  assert.ok(pooled.byteOffset !== 0 || pooled.buffer.byteLength !== 640, 'expected a pooled buffer for this regression');
  assert.notEqual(transferableBytes(pooled), pooled.buffer);
  assert.equal(transferableBytes(pooled).byteLength, 640);
  assert.equal(Buffer.from(transferableBytes(pooled))[0], 1);
  const owned = Buffer.alloc(640);
  assert.equal(transferableBytes(owned), owned.buffer);
  assert.throws(() => transferableBytes('not bytes'), /typed array/);
});

test('S24: appendAudio still rejects a replayed sequence and a closed session synchronously', async () => {
  const { proxy } = await session();
  proxy.appendAudio(Buffer.alloc(640), { sequence: 0 });
  assert.throws(() => proxy.appendAudio(Buffer.alloc(640), { sequence: 0 }), /sequence/);
  assert.throws(() => proxy.appendAudio(Buffer.alloc(640), { sequence: 1, sampleRate: 24_000 }), /PCM16/);
  proxy.stop();
  assert.throws(() => proxy.appendAudio(Buffer.alloc(640), { sequence: 2 }), /not ready/);
});

test('S24: a provider fault inside the thread becomes a fault on the main thread, with no provider text in a log', async () => {
  const { socket, proxy, events } = await session();
  socket.emit('message', Buffer.from('{"type":"error","error":{"message":"provider exploded"}}'));
  await until(() => events.some(e => e.name === 'fault'));
  const fault = events.find(e => e.name === 'fault').payload;
  assert.equal(fault instanceof Error, true);
  assert.equal(fault.message, 'provider exploded');
  proxy.stop();
});

test('S24/S27: greet crosses the port once, releases the held opener, and stop fences playback without waiting for the thread', async () => {
  const { socket, proxy, events } = await session({ release: false });
  // S27: agent mode sends no `response.create` (xAI silently drops it — probe S2/S3). What crosses
  // the port is the release itself: the held opener comes back as ordinary audio/transcript events.
  socket.emit('message', Buffer.from('{"type":"response.created","response":{"id":"opener"}}'));
  socket.emit('message', Buffer.from(`{"type":"response.output_audio.delta","response_id":"opener","delta":"${Buffer.alloc(640, 7).toString('base64')}"}`));
  await until(() => events.some(e => e.name === 'response'));
  await delay(20);
  assert.equal(events.some(e => e.name === 'audio'), false, 'nothing may play before the audio gate opens');
  assert.equal(proxy.greet(), true);
  assert.equal(proxy.greet(), false);
  await until(() => events.some(e => e.name === 'audio'));
  assert.equal(socket.sent.some(event => event.type === 'response.create'), false);
  const released = events.find(e => e.name === 'audio').payload;
  assert.deepEqual([released.pcm.length, released.pcm[0], released.responseId, released.generation], [640, 7, 'opener', 0]);
  const before = proxy.outputGeneration;
  proxy.stop();
  assert.equal(proxy.outputGeneration, before + 1);
  assert.equal(events.filter(e => e.name === 'flushAudio').at(-1).payload.generation, before + 1);
});

test('S24: aborting setup settles once and never opens a session', async () => {
  const controller = new AbortController();
  controller.abort(new Error('lease lost'));
  const proxy = new ThreadedVoiceAgent({ port: new MessageChannel().port1 });
  await assert.rejects(proxy.start({ signal: controller.signal }), /lease lost/);
  assert.equal(proxy.state, 'closed');
});

test('S24: an abort during setup rejects with the lease reason and stops the provider', async () => {
  const socket = new Socket();
  const agent = new XaiVoiceAgent({ apiKey: 'test', agentId: 'test', socketFactory: () => socket });
  const channel = new MessageChannel();
  serveVoiceAgent(channel.port2, agent);
  const proxy = new ThreadedVoiceAgent({ port: channel.port1 });
  const controller = new AbortController();
  const started = proxy.start({ signal: controller.signal });
  await until(() => agent.state === 'connecting');
  controller.abort(new Error('lease lost'));
  await assert.rejects(started, /lease lost/);
  await until(() => agent.state === 'closed');
});

test('S24: a real provider thread reports its own startup refusal and then exits', async () => {
  // The one test that pays for a thread: it proves the entry point, workerData and resourceLimits
  // wiring, which a MessageChannel cannot.
  const proxy = new ThreadedVoiceAgent({ provider: 'xai', config: { apiKey: '', agentId: 'test' } });
  let closed = 0;
  proxy.on('closed', () => closed++);
  proxy.on('fault', () => {});
  await assert.rejects(proxy.start(), /not configured/);
  await once(proxy.thread, 'exit');
  assert.equal(proxy.state, 'closed');
  assert.equal(closed, 1);
});

test('S24: a provider thread that dies mid-session ends the run as a disconnected provider', async () => {
  const channel = new MessageChannel();
  const socket = new Socket();
  const agent = new XaiVoiceAgent({ apiKey: 'test', agentId: 'test', socketFactory: () => socket });
  serveVoiceAgent(channel.port2, agent);
  const proxy = new ThreadedVoiceAgent({ port: channel.port1 });
  const started = proxy.start();
  await until(() => agent.state === 'connecting');
  socket.emit('open'); socket.emit('message', Buffer.from('{"type":"session.updated"}'));
  await started;
  let closed = 0;
  proxy.on('closed', () => closed++);
  // The adapter's own socket close is what the worker turns into `provider_disconnected`.
  socket.close();
  await until(() => closed === 1);
  proxy.stop();
});

test('S24: the registry answers configured, unconfigured and unknown providers', () => {
  assert.deepEqual(availableProviders({ XAI_API_KEY: 'k', XAI_AGENT_ID: 'a' }), ['xai']);
  assert.deepEqual(availableProviders({ XAI_API_KEY: 'k' }), []);
  assert.deepEqual(availableProviders({}), []);
  const config = providerConfig({ provider: 'xai', env: { XAI_API_KEY: 'k', XAI_AGENT_ID: 'a', XAI_VOICE: 'eve', VOICE_VAD_SILENCE_MS: '250' } });
  // S27 决策 14/16: agent mode also carries the prewarm lead the worker reads off `agent.config`,
  // and the caller-language hint the tagged transcription update sends.
  assert.deepEqual(config, { apiKey: 'k', agentId: 'a', model: undefined, voice: 'eve', vadSilenceMs: 250,
    transcriptionLanguage: 'zh', prewarmLeadMs: 8_000 });
  assert.equal('prewarmLeadMs' in providerConfig({ provider: 'xai', env: { XAI_API_KEY: 'k', XAI_REALTIME_MODEL: 'm' } }), false, 'model mode has no Space agent idle rule');
  // Structured-cloneable on purpose: this object is what crosses into the provider thread.
  assert.deepEqual(structuredClone(config), config);
  // S27: `doubao` is in the registry now, so the unknown-id case needs an id that really is not.
  for (const provider of ['unknown_provider', 'XAI', '', 'a'.repeat(40), undefined, { toString: () => 'xai' }]) {
    assert.throws(() => providerConfig({ provider, env: { XAI_API_KEY: 'k', XAI_AGENT_ID: 'a' } }), error => error.code === 'provider_unavailable');
  }
  // Registered but unconfigured reports the same way an unknown id does: nothing leaks either way.
  assert.throws(() => providerConfig({ provider: 'doubao', env: { XAI_API_KEY: 'k', XAI_AGENT_ID: 'a' } }), error => error.code === 'provider_unavailable');
  assert.throws(() => providerConfig({ provider: 'xai', env: { XAI_API_KEY: 'k' } }), error => error.code === 'provider_unavailable');
  assert.throws(() => providerConfig({ provider: 'xai', env: { XAI_API_KEY: 'k', XAI_AGENT_ID: 'a', VOICE_VAD_PREFIX_MS: 'soon' } }), /VOICE_VAD_PREFIX_MS/);
  const agent = createVoiceAgent({ provider: 'xai', env: { XAI_API_KEY: 'k', XAI_AGENT_ID: 'a' }, overrides: { socketFactory: () => new Socket() } });
  assert.equal(agent instanceof XaiVoiceAgent, true);
  agent.stop();
});

test('S24: the provider thread reports its own GC totals so a stall can be charged to one heap', async () => {
  const socket = new Socket();
  const agent = new XaiVoiceAgent({ apiKey: 'test', agentId: 'test', socketFactory: () => socket });
  const channel = new MessageChannel();
  serveVoiceAgent(channel.port2, agent, { gcReportMs: 5 });
  const proxy = new ThreadedVoiceAgent({ port: channel.port1 });
  const started = proxy.start();
  await until(() => agent.state === 'connecting');
  socket.emit('open'); socket.emit('message', Buffer.from('{"type":"session.updated"}'));
  await started;
  // A `gc` PerformanceObserver only sees its own isolate, so this number can never come from the
  // main thread's observer; it has to travel across the port.
  await until(() => proxy.providerGc !== null);
  for (const key of ['count', 'totalMs', 'maxMs']) assert.equal(Number.isFinite(proxy.providerGc[key]), true);
  proxy.stop();
  channel.port2.close();
});

// S27 决策 13: `closed` carries a payload now. The worker reads `reason: 'ended_by_provider'` to
// tell "the AI hung up and the goodbye is still playing" from "the provider dropped the socket";
// if the proxy swallowed it, every AI-ended call would be logged as `provider_disconnected`.
test('S27 决策 13: the closed payload crosses the port, and no flush follows the end_call notice', async () => {
  const { socket, proxy, events } = await session();
  socket.emit('message', Buffer.from('{"type":"response.created","response":{"id":"r1"}}'));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done',
    response_id: 'r1', item_id: 'i1', call_id: 'call-1-0', name: 'end_call', arguments: '{"reason":"sales_refused"}' })));
  await until(() => events.some(e => e.name === 'notice' && e.payload?.kind === 'end_call'));
  const noticeAt = events.findIndex(e => e.name === 'notice' && e.payload?.kind === 'end_call');
  socket.close();
  await until(() => events.some(e => e.name === 'closed'));
  assert.deepEqual(events.find(e => e.name === 'closed').payload, { reason: 'ended_by_provider' });
  assert.deepEqual(events.slice(noticeAt).filter(e => e.name === 'flushAudio'), [], 'a flush clears the queued goodbye');
  proxy.stop();
});

test('S27 决策 13: an ordinary close crosses the port as an empty payload', async () => {
  const { socket, proxy, events } = await session();
  socket.close();
  await until(() => events.some(e => e.name === 'closed'));
  assert.deepEqual(events.find(e => e.name === 'closed').payload, {});
  assert.equal(events.some(e => e.name === 'flushAudio'), true, 'an ordinary close still fences playback');
  proxy.stop();
});
