import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DOUBAO_ENV_KEYS, DoubaoVoiceAgent, doubaoConfig, doubaoConfigured, doubaoFaultKind, doubaoRealtimeUrl, float32ToPcm16 } from './providers/doubao.mjs';
import { availableProviders, createVoiceAgent, providerConfig, providerLabel } from './providers/index.mjs';

/** The same fake socket the xAI suite uses; `socketFactory` is the adapter's only injection point. */
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; this.emit('close'); }
}

/** A live session: open the socket, answer `session.create` with `session.created`. */
async function ready(options = {}) {
  const socket = new Socket();
  const agent = new DoubaoVoiceAgent({ apiKey: 'test', instructions: '你是一名沉着、专业的个人助理秘书。', socketFactory: () => socket, ...options });
  const started = agent.start();
  socket.emit('open');
  socket.emit('message', Buffer.from('{"type":"session.created","event_id":"event_1","session":{"id":"dlg_1"}}'));
  const info = await started;
  return { agent, socket, info };
}
const typesOf = socket => socket.sent.map(event => event.type);
const appendsOf = socket => socket.sent.filter(event => event.type === 'input_audio_buffer.append');

test('S27: session.create carries the frozen protocol shape and the session is muted the moment it opens', async () => {
  const { agent, socket, info } = await ready({ voice: 'zh_female_zhixingnv_uranus_bigtts', speed: 10, loudness: -5 });
  const create = socket.sent[0];
  assert.equal(create.type, 'session.create');
  assert.match(create.event_id, /^evt_\d+$/);
  assert.equal(create.session.model, '1.2.6.1');
  assert.equal(create.session.instructions, '你是一名沉着、专业的个人助理秘书。');
  assert.deepEqual(create.session.audio.input.format, { type: 'pcm', rate: 16_000 });
  assert.deepEqual(create.session.audio.output.format, { type: 'pcm', rate: 24_000 });
  assert.equal(create.session.audio.output.voice, 'zh_female_zhixingnv_uranus_bigtts');
  assert.deepEqual([create.session.audio.output.speed, create.session.audio.output.loudness], [10, -5]);
  assert.equal(create.session.tools, undefined, 'the end_call tool is off by default');
  assert.deepEqual(create.extension.asr, {});
  assert.deepEqual(create.extension.tts, {});
  assert.deepEqual(create.extension.dialog.extra, { strict_audit: true, enable_user_query_exit: true });
  // The worker prewarms up to 30 s before the caller says anything; without the mute the server
  // times out waiting for an upstream audio frame and then never answers.
  assert.equal(socket.sent[1].type, 'input_audio_mute.commit');
  assert.deepEqual(info, { provider: 'doubao', sessionId: 'dlg_1', model: '1.2.6.1' });
  assert.equal(agent.sessionId, 'dlg_1');
  agent.stop();
});

test('S27: optional tuning stays out of the payload and the end_call tool is declared only when enabled', async () => {
  const plain = await ready();
  assert.equal('speed' in plain.socket.sent[0].session.audio.output, false);
  assert.equal('loudness' in plain.socket.sent[0].session.audio.output, false);
  plain.agent.stop();
  const tooled = await ready({ endCallTool: true, strictAudit: false, exitIntent: false });
  const [tool] = tooled.socket.sent[0].session.tools;
  assert.equal(tool.name, 'end_call');
  assert.equal(tool.type, 'function');
  assert.deepEqual(tool.parameters.required, ['reason']);
  assert.deepEqual(tool.parameters.properties.reason.enum, ['sales_refused', 'info_collected', 'abusive', 'other']);
  assert.deepEqual(tooled.socket.sent[0].extension.dialog.extra, { strict_audit: false, enable_user_query_exit: false });
  tooled.agent.stop();
});

test('S27: the greeting is one speech_text_buffer.commit and never repeats', async () => {
  const { agent, socket } = await ready({ greeting: '您好！我是 VoDog AI 助理，代用户接听电话。' });
  assert.equal(agent.greet(), true);
  assert.equal(agent.greet(), false);
  const greetings = socket.sent.filter(event => event.type === 'speech_text_buffer.commit');
  assert.equal(greetings.length, 1);
  assert.equal(greetings[0].text, '您好！我是 VoDog AI 助理，代用户接听电话。');
  agent.stop();
});

test('S27: caller audio is unmuted once and paced as 20 ms packets instead of one 100 ms burst', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  agent.appendAudio(Buffer.alloc(3_200, 3), { sequence: 4 });
  // The batch is queued, not sent: a burst of five packets is what the provider calls "too fast".
  assert.equal(socket.sent.at(-1).type, 'input_audio_unmute.commit');
  assert.equal(appendsOf(socket).length, 0);
  t.mock.timers.tick(20); assert.equal(appendsOf(socket).length, 1);
  t.mock.timers.tick(20); assert.equal(appendsOf(socket).length, 2);
  t.mock.timers.tick(60); assert.equal(appendsOf(socket).length, 5);
  for (const append of appendsOf(socket)) assert.equal(Buffer.from(append.audio, 'base64').length, 640);
  assert.equal(Buffer.concat(appendsOf(socket).map(a => Buffer.from(a.audio, 'base64'))).equals(Buffer.alloc(3_200, 3)), true);
  // A second batch does not re-send the unmute, and the pacer restarts on its own.
  agent.appendAudio(Buffer.alloc(3_200, 4), { sequence: 9 });
  assert.equal(socket.sent.filter(event => event.type === 'input_audio_unmute.commit').length, 1);
  t.mock.timers.tick(100);
  assert.equal(appendsOf(socket).length, 10);
  agent.stop();
});

test('S27: a backlog past one second drops the oldest packets and reports it once', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  for (let i = 0; i < 12; i++) agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 + i * 5 });
  assert.equal(agent.queue.length, 50);
  assert.equal(agent.droppedPackets, 10);
  assert.deepEqual(notices, ['input_backlog']);
  assert.equal(appendsOf(socket).length, 0);
  agent.stop();
  assert.equal(agent.queue.length, 0);
});

test('S27: a late pacer catches up at three packets a tick, never faster and never by dropping', async () => {
  const { agent, socket } = await ready();
  for (let i = 0; i < 4; i++) agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 + i * 5 });
  assert.equal(agent.queue.length, 20);
  // A 250 ms event-loop stall: the packets that were due during it are still owed. Sending one per
  // tick from here would leave the upstream permanently 250 ms late (in and out are both 5 packets
  // per 100 ms, so the backlog would never drain) — the caller's words reach the model late for the
  // rest of the call. Sending them all at once is what the provider calls "too fast".
  agent.nextSendAtMs = Date.now() - 250;
  for (let tick = 1; tick <= 4; tick++) {
    agent.drainAudio();
    assert.equal(appendsOf(socket).length, tick * 3, `tick ${tick} sent more than the catch-up bound`);
  }
  agent.drainAudio();
  const sent = appendsOf(socket).length;
  assert.ok(sent >= 13 && sent <= 14, `caught up to ${sent} packets`);
  agent.drainAudio();
  assert.equal(appendsOf(socket).length, sent, 'a caught-up pacer must not run ahead of real time');
  assert.equal(sent + agent.queue.length, 20, 'a stall must never lose caller audio');
  agent.stop();
});

test('S27: appendAudio keeps the same boundaries as every other provider', async () => {
  const { agent } = await ready();
  agent.appendAudio(Buffer.alloc(640), { sequence: 0 });
  assert.throws(() => agent.appendAudio(Buffer.alloc(640), { sequence: 0 }), /sequence/);
  assert.throws(() => agent.appendAudio(Buffer.alloc(640), { sequence: 1, sampleRate: 24_000 }), /PCM16/);
  assert.throws(() => agent.appendAudio(Buffer.alloc(641), { sequence: 1 }), /PCM16/);
  assert.throws(() => agent.appendAudio(Buffer.alloc(32_002), { sequence: 1 }), /PCM16/);
  agent.stop();
  assert.throws(() => agent.appendAudio(Buffer.alloc(640), { sequence: 2 }), /not ready/);
});

test('S27: 24 kHz output is resampled to the 16 kHz the playback queue assumes', async () => {
  const { agent, socket } = await ready({ outputFormat: 's16le' });
  const audio = [];
  agent.on('audio', event => audio.push(event));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"","tts_type":""}'));
  // 100 ms at 24 kHz = 2400 samples; at 16 kHz the same 100 ms is 1600 samples / 3200 bytes.
  const delta = Buffer.alloc(4_800).toString('base64');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta })));
  assert.equal(audio.length, 1);
  assert.equal(audio[0].pcm.length, 3_200);
  assert.equal(audio[0].sampleRate, 16_000);
  assert.deepEqual([audio[0].responseId, audio[0].generation], ['resp_1', 0]);
  agent.stop();
});

test('S27: an audio delta that splits a sample carries the odd byte into the next one', async () => {
  const { agent, socket } = await ready({ outputFormat: 's16le' });
  const audio = [];
  agent.on('audio', event => audio.push(event));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  // The provider is streaming bytes, not samples; a throw here would kill the provider thread.
  const first = Buffer.alloc(4_801, 1), second = Buffer.alloc(4_799, 1);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: first.toString('base64') })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: second.toString('base64') })));
  assert.equal(agent.state, 'ready');
  // 9600 bytes of 24 kHz in, 6400 bytes of 16 kHz out, and not one byte of the stream discarded.
  assert.equal(audio.reduce((total, event) => total + event.pcm.length, 0), 6_400);
  agent.stop();
});

test('S27: an error that arrives after session.close is the provider tidying up, not a fault', async () => {
  const { agent, socket } = await ready();
  const notices = [], faults = [];
  let closed = 0;
  agent.on('notice', notice => notices.push(notice.kind));
  agent.on('fault', error => faults.push(error));
  agent.on('closed', () => closed++);
  agent.stop();
  // Observed on relay-secondary 2026-09-12: `55000000 rpc error … the stream is done` lands ~300 ms after
  // our session.close and ~immediately before session.closed. Failing the run on it would turn
  // every clean hangup into a provider fault.
  socket.emit('message', Buffer.from('{"type":"error","error":{"code":"55000000","type":"Internal Server Error","message":"rpc error: code = 13 desc = the stream is done"}}'));
  assert.deepEqual([faults.length, closed], [0, 0], 'the close handshake must still be waiting');
  assert.deepEqual(notices, ['error_after_close']);
  socket.emit('message', Buffer.from('{"type":"session.closed"}'));
  assert.deepEqual([closed, agent.sessionClosedAck, faults.length], [1, true, 0]);
});

test('S27: the transcript contract is one caller final and one assistant final per response', async () => {
  const { agent, socket } = await ready();
  const transcripts = [], notices = [];
  agent.on('transcript', event => transcripts.push(event));
  agent.on('notice', notice => notices.push(notice.kind));
  // Real server shape (probe 2026-09-12): cumulative deltas, then `completed` with the text in `text`.
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"我是"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"我是顺丰"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.completed","item_id":"i1","text":"我是顺丰快递"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"好的"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"，我记下了"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.done","response_id":"resp_1","text":"好的，我记下了。"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.failed","error":{"code":"audio_unintelligible"}}'));
  assert.deepEqual(transcripts, [
    { text: '我是顺丰快递', final: true, speaker: 'caller' },
    { text: '好的，我记下了。', final: true, responseId: 'resp_1' },
  ]);
  // A phrase the provider could not transcribe is a report, never a hangup.
  assert.deepEqual(notices, ['transcription_failed']);
  agent.stop();
});

test('S27: barge-in cancels the response, fences playback atomically and drops the late audio', async () => {
  const { agent, socket } = await ready();
  const events = [];
  for (const name of ['audio', 'flushAudio', 'speechStarted', 'completed', 'response']) agent.on(name, payload => events.push({ name, payload }));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"resp_1"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started","item_id":"item_1"}'));
  assert.equal(socket.sent.at(-1).type, 'response.cancel');
  assert.equal(agent.outputGeneration, 1);
  // The generation bump and the flush are one step: the playback fence would otherwise misalign.
  const order = events.map(event => event.name);
  assert.deepEqual(order, ['response', 'flushAudio', 'speechStarted']);
  assert.deepEqual(events[1].payload, { generation: 1 });
  socket.emit('message', Buffer.from('{"type":"response.output_audio.delta","response_id":"resp_1","delta":"AAAAAAAA"}'));
  assert.equal(events.filter(event => event.name === 'audio').length, 0);
  socket.emit('message', Buffer.from('{"type":"response.canceled","event_id":"event_17"}'));
  const completed = events.find(event => event.name === 'completed').payload;
  assert.deepEqual(completed, { status: 'cancelled', responseId: 'resp_1', generation: 0, current: false });
  agent.stop();
});

test('S27: barge-in stays silent when nothing is playing, and DOUBAO_BARGE_IN=off disables it', async () => {
  const idle = await ready();
  let speech = 0, flushes = 0;
  idle.agent.on('speechStarted', () => speech++);
  idle.agent.on('flushAudio', () => flushes++);
  idle.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  assert.deepEqual([speech, flushes, idle.agent.outputGeneration], [1, 0, 0]);
  assert.equal(idle.socket.sent.some(event => event.type === 'response.cancel'), false);
  idle.agent.stop();

  const off = await ready({ bargeIn: 'off' });
  off.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  let started = 0;
  off.agent.on('speechStarted', () => started++);
  off.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  assert.equal(off.socket.sent.some(event => event.type === 'response.cancel'), false);
  assert.deepEqual([started, off.agent.outputGeneration], [1, 0]);
  off.agent.stop();
});

test('S27: a finished response completes first and only then reports the exit intent', async () => {
  const { agent, socket } = await ready();
  const order = [];
  agent.on('completed', payload => order.push(['completed', payload]));
  agent.on('notice', notice => order.push(['notice', notice.kind]));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":""}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.done","question_id":"q1","response_id":"resp_1","status_code":"20000002"}'));
  assert.deepEqual(order.map(entry => entry[0]), ['completed', 'notice']);
  assert.deepEqual(order[0][1], { status: 'completed', responseId: 'resp_1', generation: 0, current: true });
  assert.equal(order[1][1], 'exit_intent');
  // `response.done` is usage accounting, not a call event.
  socket.emit('message', Buffer.from('{"type":"response.done"}'));
  assert.equal(order.length, 2);
  agent.stop();
});

test('S27: the exit intent stays quiet when DOUBAO_EXIT_INTENT is off', async () => {
  const { agent, socket } = await ready({ exitIntent: false });
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.done","response_id":"resp_1","status_code":"20000002"}'));
  assert.deepEqual(notices, []);
  agent.stop();
});

// S27 决策 12（2026-09-12 真实通话 + /tmp/doubao-endcall-check.mjs）: replying `{"ok":true}` to
// `end_call` makes the model append a narration（"已结束通话。"/"（已挂断）"）to the SAME response and
// the TTS voices it — a real caller heard「已挂断」. Not replying keeps the full goodbye audio (7.6 s
// measured) and produces no narration, but the server then never sends `response.output_text.done`
// for that response, so the goodbye has to be finalised from the buffer here or it never reaches
// the call record.
test('S27 决策 12: end_call is not answered, the goodbye is finalised from the buffer, and the notice comes last', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const order = [];
  agent.on('notice', notice => order.push(['notice', notice.kind]));
  agent.on('transcript', event => order.push(['transcript', event]));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_1', delta: '好的，' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_1', delta: '再见。\n' })));
  const before = socket.sent.length;
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'end_call', arguments: '{"reason":"sales_refused"}' }],
  })));
  assert.equal(socket.sent.length, before, 'a tool reply is what makes the model narrate the hangup out loud');
  assert.deepEqual(order, [
    ['transcript', { text: '好的，再见。', final: true, responseId: 'resp_1' }],
    ['notice', 'end_call'],
  ]);
  assert.equal(agent.endCallRequested, true);
  // The server may never send it, but if it does the goodbye must not land in the record twice.
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_text.done', response_id: 'resp_1', text: '好的，再见。\n' })));
  assert.equal(order.length, 2, 'a late output_text.done for the same response is ignored');
  agent.stop();
});

test('S27 决策 12: a tool that is not end_call is still answered by call_id', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ id: 'item_1', type: 'function_call', call_id: 'call_2', name: 'lookup_order', arguments: '{}' }],
  })));
  const reply = socket.sent.at(-1);
  assert.equal(reply.type, 'conversation.item.create');
  assert.deepEqual(reply.items, [{ call_id: 'call_2', role: 'tool', content: [{ type: 'input_text', text: '{"ok":true}' }] }]);
  assert.deepEqual(notices, []);
  assert.equal(agent.endCallRequested, false);
  agent.stop();
});

// S27 决策 13: without an answer the server keeps the turn open and may drop the socket on its own.
// That close must not fence playback — the goodbye is still in the bridge's queue — and it must say
// so, or `worker.mjs` reports `provider_disconnected` for a call the AI ended on purpose.
test('S27 决策 13: after end_call a server close keeps the queued goodbye and reports ended_by_provider', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const flushes = [], closed = [];
  agent.on('flushAudio', event => flushes.push(event));
  agent.on('closed', payload => closed.push(payload));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ call_id: 'call_1', name: 'end_call', arguments: '{"reason":"sales_refused"}' }],
  })));
  socket.close();
  assert.deepEqual(flushes, [], 'a flush here clears the audio the caller has not heard yet');
  assert.deepEqual(closed, [{ reason: 'ended_by_provider' }]);
  assert.equal(agent.outputGeneration, 0);
});

test('S27 决策 13: an ordinary close still fences playback and carries an empty reason', async () => {
  const { agent, socket } = await ready();
  const flushes = [], closed = [];
  agent.on('flushAudio', event => flushes.push(event));
  agent.on('closed', payload => closed.push(payload));
  socket.close();
  assert.deepEqual(flushes, [{ generation: 1 }]);
  assert.deepEqual(closed, [{}]);
});

test('S27: provider errors are classified, reported as a kind and never carry the payload into a log', async () => {
  assert.equal(doubaoFaultKind('42000020'), 'doubao_request_rejected');
  assert.equal(doubaoFaultKind('45000003'), 'doubao_idle_timeout');
  assert.equal(doubaoFaultKind('55000001'), 'doubao_server_error');
  assert.equal(doubaoFaultKind('50700000'), 'doubao_server_error');
  assert.equal(doubaoFaultKind(undefined), 'doubao_error');
  for (const [code, kind] of [['42000020', 'doubao_request_rejected'], ['45000003', 'doubao_idle_timeout'], ['55000001', 'doubao_server_error']]) {
    const { agent, socket } = await ready();
    const notices = [], faults = [];
    agent.on('notice', notice => notices.push(notice.kind));
    agent.on('fault', error => faults.push(error));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', error: { code, message: 'x'.repeat(900) } })));
    assert.deepEqual(notices, [kind]);
    assert.equal(faults[0].code, kind);
    assert.ok(faults[0].message.length <= 200 + kind.length + 2);
    assert.equal(agent.state, 'closed');
  }
});

test('S27: stop() says goodbye and waits for session.closed before dropping the socket', async () => {
  const { agent, socket } = await ready();
  let closed = 0;
  agent.on('closed', () => closed++);
  agent.stop();
  // R11 §6.2: dropping the WebSocket without this handshake is recorded as 55000001 ContextCanceled.
  assert.equal(socket.sent.at(-1).type, 'session.close');
  assert.equal(socket.readyState, 1);
  assert.deepEqual([closed, agent.outputGeneration], [0, 1]);
  socket.emit('message', Buffer.from('{"type":"session.closed"}'));
  assert.equal(socket.readyState, 3);
  assert.deepEqual([closed, agent.sessionClosedAck], [1, true]);
  agent.stop();
  assert.equal(closed, 1);
});

test('S27: a server that never answers session.closed still ends the session on the bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, socket } = await ready();
  let closed = 0;
  agent.on('closed', () => closed++);
  agent.stop();
  assert.equal(closed, 0);
  t.mock.timers.tick(2_000);
  assert.deepEqual([closed, socket.readyState, agent.sessionClosedAck], [1, 3, false]);
});

test('S27: a socket that dies mid-session closes once and never waits for a reply that cannot come', async () => {
  const { agent, socket } = await ready();
  let closed = 0;
  agent.on('closed', () => closed++);
  socket.close();
  assert.deepEqual([closed, agent.state], [1, 'closed']);
  // Aborting setup before a session exists must not put session.close on a socket with no session.
  const controller = new AbortController();
  const early = new Socket();
  const agentTwo = new DoubaoVoiceAgent({ apiKey: 'test', instructions: 'x', socketFactory: () => early });
  const started = agentTwo.start({ signal: controller.signal });
  controller.abort(new Error('lease lost'));
  await assert.rejects(started, /lease lost/);
  assert.equal(early.sent.some(event => event.type === 'session.close'), false);
});

test('S27: the endpoint is fixed, overridable only by a wss URL or a loopback test server', () => {
  assert.equal(doubaoRealtimeUrl(), 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  assert.equal(doubaoRealtimeUrl(''), 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  assert.equal(doubaoRealtimeUrl('wss://example.test/duplex'), 'wss://example.test/duplex');
  assert.equal(doubaoRealtimeUrl('ws://127.0.0.1:9001/duplex'), 'ws://127.0.0.1:9001/duplex');
  for (const value of ['http://openspeech.bytedance.com', 'ws://openspeech.bytedance.com', 'openspeech.bytedance.com', 'wss://', 'ws://192.0.2.21:9001'])
    assert.throws(() => doubaoRealtimeUrl(value), /DOUBAO_REALTIME_URL/);
});

test('S27: the API key is the only thing that decides whether this worker announces doubao', () => {
  assert.equal(doubaoConfigured({}), false);
  assert.equal(doubaoConfigured({ DOUBAO_API_KEY: '' }), false);
  assert.equal(doubaoConfigured({ DOUBAO_API_KEY: 'k' }), true);
  assert.deepEqual(availableProviders({ DOUBAO_API_KEY: 'k' }), ['doubao']);
  assert.deepEqual(availableProviders({ XAI_API_KEY: 'k', XAI_AGENT_ID: 'a', DOUBAO_API_KEY: 'k' }), ['xai', 'doubao']);
  assert.deepEqual(availableProviders({ XAI_API_KEY: 'k', XAI_AGENT_ID: 'a' }), ['xai']);
  assert.equal(providerLabel('doubao'), '豆包');
  // Known but unconfigured is reported exactly like an unknown id, and must stay that way.
  assert.throws(() => providerConfig({ provider: 'doubao', env: { XAI_API_KEY: 'k' } }), error => error.code === 'provider_unavailable');
});

test('S27: the startup parse produces structured-cloneable defaults and refuses every malformed value', () => {
  const config = providerConfig({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k' } });
  assert.equal(config.apiKey, 'k');
  assert.equal(config.model, '1.2.6.1');
  assert.equal(config.voice, 'zh_female_vv_jupiter_bigtts');
  assert.equal(config.greeting.startsWith('您好！我是 VoDog AI 助理，代用户接听电话'), true);
  assert.deepEqual([config.strictAudit, config.exitIntent, config.endCallTool, config.bargeIn], [true, true, false, 'cancel']);
  assert.deepEqual([config.maxCallSeconds, config.silenceHangupSeconds], [180, 15]);
  assert.equal('speed' in config, false);
  assert.equal('loudness' in config, false);
  assert.equal('realtimeUrl' in config, false);
  // The persona ships with the image, not in --env-file: docker env files cannot hold it.
  assert.match(config.instructions, /VoDog AI 电话助理/);
  assert.match(config.instructions, /不要编造用户的身份/);
  // Structured-cloneable on purpose: this object is what crosses into the provider thread.
  assert.deepEqual(structuredClone(config), config);

  const tuned = providerConfig({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', DOUBAO_SPEED: '20', DOUBAO_LOUDNESS: '-50',
    DOUBAO_MAX_CALL_SECONDS: '60', DOUBAO_SILENCE_HANGUP_SECONDS: '0', DOUBAO_STRICT_AUDIT: 'false', DOUBAO_END_CALL_TOOL: 'true',
    DOUBAO_BARGE_IN: 'off', DOUBAO_VOICE: 'zh_female_zhixingnv_uranus_bigtts', DOUBAO_GREETING: '您好' } });
  assert.deepEqual([tuned.speed, tuned.loudness, tuned.maxCallSeconds, tuned.silenceHangupSeconds], [20, -50, 60, 0]);
  assert.deepEqual([tuned.strictAudit, tuned.endCallTool, tuned.bargeIn, tuned.greeting], [false, true, 'off', '您好']);

  const bad = {
    DOUBAO_MAX_CALL_SECONDS: ['59', '3601', '180.0', '1e2', 'soon', '+180'],
    DOUBAO_SILENCE_HANGUP_SECONDS: ['-1', '121', 'never'],
    DOUBAO_SPEED: ['-51', '101', 'fast'],
    DOUBAO_LOUDNESS: ['-51', '101', ''.padEnd(3, 'x')],
    DOUBAO_STRICT_AUDIT: ['yes', '1', 'maybe'],
    DOUBAO_EXIT_INTENT: ['on'],
    DOUBAO_END_CALL_TOOL: ['maybe'],
    DOUBAO_BARGE_IN: ['loud', 'OFF'],
    DOUBAO_VOICE: ['bad voice', 'a'.repeat(129)],
    DOUBAO_MODEL: ['bad/model', 'a'.repeat(65)],
    DOUBAO_REALTIME_URL: ['http://openspeech.bytedance.com', 'nope'],
    DOUBAO_INSTRUCTIONS_FILE: ['prompts/does-not-exist.md', '/nonexistent/persona.md'],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.throws(() => providerConfig({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', [key]: value } }),
        error => new RegExp(key).test(error.message), `${key}=${value} was accepted`);
    }
  }
  assert.throws(() => doubaoConfig({}), /DOUBAO_API_KEY/);
  // Surrounding whitespace is trimmed on purpose: `secrets/voice.env` is written line by line and
  // docker's --env-file does no unquoting, so a stray space must not fail the service.
  const trimmed = doubaoConfig({ DOUBAO_API_KEY: ' k ', DOUBAO_STRICT_AUDIT: ' TRUE ', DOUBAO_BARGE_IN: ' off ', DOUBAO_MAX_CALL_SECONDS: ' 120 ' });
  assert.deepEqual([trimmed.apiKey, trimmed.strictAudit, trimmed.bargeIn, trimmed.maxCallSeconds], ['k', true, 'off', 120]);
  assert.equal(DOUBAO_ENV_KEYS.includes('DOUBAO_API_KEY'), true);
  assert.equal(DOUBAO_ENV_KEYS.every(key => key.startsWith('DOUBAO_')), true);
});

test('S27: the registry builds the real adapter from the parsed configuration', async () => {
  const socket = new Socket();
  const seen = [];
  const agent = createVoiceAgent({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', DOUBAO_VOICE: 'zh_female_vv_uranus_bigtts' },
    overrides: { socketFactory: (url, options) => { seen.push({ url, options }); return socket; } } });
  assert.equal(agent instanceof DoubaoVoiceAgent, true);
  const started = agent.start();
  socket.emit('open');
  socket.emit('message', Buffer.from('{"type":"session.created","session":{"id":"dlg_1"}}'));
  await started;
  assert.equal(seen[0].url, 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  // R11 §1: the request header block is exactly one field, and nothing here weakens TLS.
  assert.deepEqual(seen[0].options.headers, { 'X-Api-Key': 'k' });
  assert.deepEqual(Object.keys(seen[0].options).sort(), ['handshakeTimeout', 'headers', 'maxPayload']);
  assert.equal(socket.sent[0].session.audio.output.voice, 'zh_female_vv_uranus_bigtts');
  assert.equal(typesOf(socket).includes('input_audio_mute.commit'), true);
  agent.stop();
});

// 2026-09-12 real-call finding: the server streams 32-bit little-endian floats in [-1, 1], not the
// int16 the documentation states. Decoding them as int16 is white-noise-like garbage (zero-crossing
// rate 0.47 per sample, full-scale peaks) — exactly the "robot noise" heard on the first three calls.
test('S27: output deltas are float32 by default and become PCM16 before resampling, across split samples', async () => {
  const { agent, socket } = await ready();
  const audio = [];
  agent.on('audio', event => audio.push(event));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  // 2400 float samples (100 ms at 24 kHz) of a 1 kHz sine at 0.5 amplitude.
  const floats = Buffer.alloc(2_400 * 4);
  for (let i = 0; i < 2_400; i++) floats.writeFloatLE(0.5 * Math.sin(2 * Math.PI * 1_000 * i / 24_000), i * 4);
  // Split at a byte offset that is not a multiple of 4: the remainder must carry over, nothing lost.
  const first = floats.subarray(0, 4_806), second = floats.subarray(4_806);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: first.toString('base64') })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: second.toString('base64') })));
  const pcm = Buffer.concat(audio.map(event => event.pcm));
  assert.equal(pcm.length, 3_200, '100 ms at 16 kHz');
  assert.equal(audio[0].sampleRate, 16_000);
  let peak = 0, crossings = 0, previous = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    peak = Math.max(peak, Math.abs(sample));
    if (i > 0 && (sample < 0) !== (previous < 0)) crossings++;
    previous = sample;
  }
  // 0.5 of full scale, allowing for the FIR's transition band; 1 kHz over 100 ms crosses zero ~200 times.
  assert.ok(peak > 12_000 && peak < 18_000, `peak ${peak}`);
  assert.ok(crossings > 170 && crossings < 230, `crossings ${crossings}`);
  agent.stop();
});

test('S27: float32 samples outside [-1, 1] or non-finite are clamped, never full-scale bursts', () => {
  const bytes = Buffer.alloc(16);
  bytes.writeFloatLE(2.5, 0); bytes.writeFloatLE(-7, 4); bytes.writeFloatLE(Number.NaN, 8); bytes.writeFloatLE(0.25, 12);
  const pcm = float32ToPcm16(bytes);
  assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4), pcm.readInt16LE(6)], [32_767, -32_767, 0, 8_192]);
});

test('S27: a caller utterance without a completed event is finalised from the last cumulative delta when the model answers', async () => {
  const { agent, socket } = await ready();
  const transcripts = [];
  agent.on('transcript', event => transcripts.push(event));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"你好"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"你好我是快递"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"好的"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1","tts_type":"default"}'));
  assert.deepEqual(transcripts, [{ text: '你好我是快递', final: true, speaker: 'caller' }]);
  // The documented `transcript` field is still honoured when it is the only one present.
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.completed","item_id":"i2","transcript":"单号一二三"}'));
  assert.deepEqual(transcripts.at(-1), { text: '单号一二三', final: true, speaker: 'caller' });
  agent.stop();
});

test('S27: the greeting reaches the transcript once, as the assistant final of its own response', async () => {
  const { agent, socket } = await ready({ greeting: '您好！我是 VoDog AI 助理，代用户接听电话。' });
  const transcripts = [];
  agent.on('transcript', event => transcripts.push(event));
  agent.greet();
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"","tts_type":"chat_tts_text"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.done","question_id":"q1","response_id":""}'));
  // A later chat turn is not the greeting even though nothing else changed.
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q2","response_id":"resp_2","tts_type":"default"}'));
  assert.deepEqual(transcripts, [{ text: '您好！我是 VoDog AI 助理，代用户接听电话。', final: true, responseId: 'q1' }]);
  agent.stop();
});

// 2026-09-12 real call: a congestion episode 34 s into an otherwise good Doubao call tripped the
// old `bufferedAmount > 64 KB` guard, which faulted immediately and ended the call
// (`provider_failed`). Upstream congestion must cost the caller audio, never the call.
test('S27: transient upstream backpressure drops audio and keeps the call, and recovers on its own', async () => {
  const { agent, socket } = await ready();
  const notices = [], faults = [];
  agent.on('notice', notice => notices.push(notice.kind));
  agent.on('fault', error => faults.push(error));
  agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 });
  socket.bufferedAmount = 200_000;
  agent.drainAudio();
  agent.drainAudio();
  assert.deepEqual(faults, [], 'a congested second is not a failed call');
  assert.equal(agent.state, 'ready');
  assert.deepEqual(notices, ['input_backpressure'], 'one notice per episode, not one per tick');
  assert.equal(appendsOf(socket).length, 0, 'nothing is pushed into a full send buffer');
  // The link drains: the pacer re-times instead of dumping the backlog in one burst.
  socket.bufferedAmount = 0;
  agent.drainAudio();
  assert.deepEqual(notices, ['input_backpressure', 'input_backpressure_cleared']);
  assert.equal(appendsOf(socket).length, 1, 'back to one packet per 20 ms tick');
  agent.stop();
});

test('S27: backpressure that never clears is a real fault, bounded in time and in bytes', async () => {
  const sustained = await ready();
  const faults = [], kinds = [];
  sustained.agent.on('fault', error => faults.push(error));
  sustained.agent.on('notice', notice => kinds.push(notice.kind));
  sustained.agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 });
  sustained.socket.bufferedAmount = 200_000;
  sustained.agent.drainAudio();
  assert.deepEqual(faults, []);
  // Five seconds of a send buffer that never drains: the link is gone, end the run the normal way.
  sustained.agent.backpressureSinceMs = Date.now() - 5_000;
  sustained.agent.drainAudio();
  assert.equal(faults.length, 1);
  assert.deepEqual(kinds, ['input_backpressure', 'input_backpressure_fatal']);
  assert.equal(sustained.agent.state, 'closed');

  // A buffer past the hard ceiling does not wait out the five seconds.
  const burst = await ready();
  const burstFaults = [];
  burst.agent.on('fault', error => burstFaults.push(error));
  burst.agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 });
  burst.socket.bufferedAmount = 600_000;
  burst.agent.drainAudio();
  assert.equal(burstFaults.length, 1, 'half a megabyte queued is not a transient hiccup');
  assert.equal(burst.agent.state, 'closed');
});

// S27 决策 15（与 xAI 真实通话 c3734597 同源）: `ws` 先报 `error` 再报 `close`，那一声 fault 会被
// worker 当成 `provider_failed`，在收尾 drain 还没跑完时把桥拆掉，来电者听到的再见被切掉一截。
test('S27 决策 15: a socket error after end_call is the expected end, not a fault', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const faults = [], closed = [], flushes = [];
  agent.on('fault', error => faults.push(error));
  agent.on('closed', payload => closed.push(payload));
  agent.on('flushAudio', event => flushes.push(event));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ call_id: 'call_1', name: 'end_call', arguments: '{"reason":"sales_refused"}' }],
  })));
  socket.emit('error', new Error('read ECONNRESET'));
  socket.close();
  assert.deepEqual(faults, [], 'an expected teardown must not end the run as a provider failure');
  assert.deepEqual(closed, [{ reason: 'ended_by_provider' }]);
  assert.deepEqual(flushes, [], 'and the goodbye still queued in the bridge is not cleared');
  assert.equal(agent.state, 'closed');
});

test('S27 决策 15: a socket error with no end_call behind it is still a fault', async () => {
  const { agent, socket } = await ready();
  const faults = [], notices = [];
  agent.on('fault', error => faults.push(error));
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('error', new Error('read ECONNRESET'));
  assert.equal(faults.length, 1);
  assert.deepEqual(notices, ['socket_error']);
  assert.equal(agent.state, 'closed');
});

test('a failed socket send is reported once per session as provider_send_failed', async () => {
  const { agent, socket } = await ready(); const notices = [];
  agent.on('notice', notice => notices.push(notice));
  socket.send = () => { throw new Error('WebSocket is not open: readyState 2'); };
  assert.equal(agent.sendEvent({ type: 'x' }), false); assert.equal(agent.sendEvent({ type: 'y' }), false);
  assert.deepEqual(notices, [{ kind: 'provider_send_failed', message: 'WebSocket is not open: readyState 2' }]);
  agent.stop();
});
