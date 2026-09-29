/**
 * Throwaway diagnostic probe (NOT in the deploy manifest — infra/deploy-voice-relay-secondary.py's
 * RUNTIME_FILES is an explicit tuple, so this file never ships). Sibling of xai-tool-probe.mjs:
 * same raw `ws` session, same timestamped logging, one fresh session per scenario.
 *
 * Question (S27, 2026-09-12): with the Space agent's OWN server-side `end_call` restored, the
 * goodbye the worker receives is truncated at the source — the caller hears
 *「不好意思，我们对保险不感兴」 and the last syllable「趣」is missing (65 KB ≈ 2.0 s for 14 chars).
 * Hypothesis: executing `end_call` server-side stops TTS before the final chunk. Counter-test:
 * declare a CLIENT tool `hang_up` instead, which replaces the Space's own tool list, and see
 * whether the same refusal comes back longer (and whether the server still closes the socket).
 *
 * Usage: node xai-hangup-probe.mjs <dry|H0|H1|H2|H3> [wavPath]
 *   H0 server-end-call — today's production session.update byte-for-byte (NO `tools` key)
 *   H1 client-hang-up  — production + tools:[hang_up] + tool_choice:'auto' (Space's end_call gone)
 *   H2 client-end-call — production + tools:[end_call(our description)] + tool_choice:'auto'
 *   H3 tail-phrase     — production + EXACTLY the tools block S27 决策 17 ships in
 *                        providers/xai.mjs (AGENT_END_CALL_TOOL + tool_choice:'auto'). H0/H1 and
 *                        the user's listening proved xAI never synthesises the last syllable of a
 *                        turn that also carries a function call, whatever the tool is called; H3
 *                        tests the only remaining lever — making that syllable belong to a fixed
 *                        sacrificial tail phrase instead of to the substance of the goodbye.
 *
 * Every scenario streams a Chinese sales pitch at real-time pace once the opener finishes, then
 * silence, and writes the PCM of the FIRST audio-bearing response (the opener) and of the LAST one
 * (the refusal) as 16 kHz mono WAV files to $PROBE_OUT_DIR (default /out, a mounted host dir).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { xaiConfig, xaiRealtimeUrl } from './providers/xai.mjs';

const SCENARIO = (process.argv[2] || 'H0').trim();
const WAV_PATH = process.argv[3] || process.env.VOICE_PROBE_WAV_PATH || './fixtures/synthetic-16k.wav';
const OUT_DIR = process.env.PROBE_OUT_DIR || '/out';
const SCENARIOS = new Set(['dry', 'H0', 'H1', 'H2', 'H3']);
if (!SCENARIOS.has(SCENARIO)) { console.error(`unknown scenario ${SCENARIO}`); process.exit(2); }

const cfg = xaiConfig(process.env);
const url = xaiRealtimeUrl(cfg);
const agentMode = Boolean(cfg.agentId);

/**
 * providers/xai.mjs `turnDetection()` is not exported — rebuilt here field for field, INCLUDING the
 * two agent-mode idle fields (S27 决策 13). Leaving them out changes behaviour (the agent's own
 * 「15 秒不说话就挂断」rule), so this is not cosmetic.
 */
const AGENT_IDLE_TIMEOUT_MS = 5_000;
const AGENT_END_CALL_AFTER_IDLE_REMINDER_COUNT = 2;
const turnDetection = {
  type: 'server_vad',
  ...(cfg.vadThreshold === undefined ? {} : { threshold: cfg.vadThreshold }),
  ...(cfg.vadPrefixMs === undefined ? {} : { prefix_padding_ms: cfg.vadPrefixMs }),
  ...(cfg.vadSilenceMs === undefined ? {} : { silence_duration_ms: cfg.vadSilenceMs }),
  ...(agentMode ? { idle_timeout_ms: AGENT_IDLE_TIMEOUT_MS, end_call_after_idle_reminder_count: AGENT_END_CALL_AFTER_IDLE_REMINDER_COUNT } : {}),
};

const TOOL_PARAMETERS = {
  type: 'object',
  properties: { reason: { type: 'string', enum: ['sales_refused', 'info_collected', 'abusive', 'other'] } },
  required: ['reason'],
};
const TOOL_DESCRIPTION = '在礼貌道别之后调用，用于挂断本次电话。调用后通话由系统挂断。';
/** The OpenAI Realtime function-tool shape (flat `name`/`parameters` beside `type:'function'`). */
const HANG_UP_TOOL = { type: 'function', name: 'hang_up', description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS };
const END_CALL_TOOL = { type: 'function', name: 'end_call', description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS };

/**
 * H3: byte-for-byte the `AGENT_END_CALL_TOOL` of providers/xai.mjs (S27 决策 17). Duplicated here on
 * purpose — this probe runs inside the RELEASED image, whose providers/xai.mjs predates the constant
 * and does not export it; importing a missing name would be a link-time SyntaxError. `node -e`
 * against the working tree confirms the two are identical before every run.
 */
const AGENT_GOODBYE_TAIL = '再见，祝您顺利。';
const AGENT_END_CALL_TOOL = {
  type: 'function',
  name: 'end_call',
  description: `挂断本次电话。适用：来电目的已处理完毕；推销/广告类来电已礼貌拒绝；对方超过 15 秒没有说话；通话超过 3 分钟。调用规则：必须先把道别说完整，而且道别的最后一句固定是"${AGENT_GOODBYE_TAIL}"，说完这句再调用本工具；调用本身会挂断，不要再说明或播报挂断。`,
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', enum: ['sales_refused', 'info_collected', 'idle', 'max_duration', 'abusive', 'other'] } },
    required: ['reason'],
  },
};

const PLAN = {
  dry: { tools: undefined, toolChoice: undefined },
  H0: { tools: undefined, toolChoice: undefined },   // production, byte-for-byte: NO tools key
  H1: { tools: [HANG_UP_TOOL], toolChoice: 'auto' },
  H2: { tools: [END_CALL_TOOL], toolChoice: 'auto' },
  H3: { tools: [AGENT_END_CALL_TOOL], toolChoice: 'auto' },
}[SCENARIO];

/**
 * Agent mode omits `instructions` — sending it replaces the Space agent's own prompt
 * (providers/xai.mjs, MODEL_INSTRUCTIONS; probe S6). `cfg.instructions` is never set by env.
 * Key order matches providers/xai.mjs `start()` exactly.
 */
const sessionBlock = ({ tools, toolChoice }) => ({
  ...(cfg.voice ? { voice: cfg.voice } : {}),
  turn_detection: turnDetection,
  ...(tools === undefined ? {} : { tools }),
  ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  audio: {
    input: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
    output: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
  },
});

/** No `event_id`: production's initial session.update carries none. */
const PRODUCTION_SESSION_UPDATE = { type: 'session.update', session: sessionBlock({ tools: undefined, toolChoice: undefined }) };
const INITIAL_SESSION_UPDATE = { type: 'session.update', session: sessionBlock(PLAN) };

/** providers/xai.mjs `requestInputTranscription()`, including the S27 决策 16 language hint. */
const transcription = { model: cfg.transcriptionModel ?? 'whisper-1', ...(cfg.transcriptionLanguage ? { language: cfg.transcriptionLanguage } : {}) };
const TRANSCRIPTION_UPDATE = {
  type: 'session.update',
  event_id: 'cc-transcription-probe',
  session: { audio: { input: { transcription } }, input_audio_transcription: transcription },
};

console.log(`# scenario=${SCENARIO} outDir=${OUT_DIR}`);
console.log(`# realtimePort=${cfg.realtimePort ?? '(unset, 443)'} agentMode=${agentMode} model=${cfg.model ?? '(none)'} voice=${cfg.voice ?? '(none)'}`);
console.log(`# turn_detection=${JSON.stringify(turnDetection)}`);
console.log(`# PRODUCTION session.update (providers/xai.mjs start(), agent mode)=${JSON.stringify(PRODUCTION_SESSION_UPDATE)}`);
console.log(`# PROBE      session.update=${JSON.stringify(INITIAL_SESSION_UPDATE)}`);
console.log(`# DIFF vs production: tools=${JSON.stringify(PLAN.tools ?? '(key absent)')} tool_choice=${JSON.stringify(PLAN.toolChoice ?? '(key absent)')}`);
if (SCENARIO === 'H3') console.log(`# H3 goodbye tail phrase=${JSON.stringify(AGENT_GOODBYE_TAIL)} — the refusal transcript must END with it`);
console.log(`# transcription session.update=${JSON.stringify(TRANSCRIPTION_UPDATE)}`);
console.log(`# wav=${WAV_PATH}`);

/** Only 16 kHz mono PCM16 — the spec the worker actually feeds the adapter. */
function wavPcm16k(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WAVE') throw new Error('WAV must be a RIFF/WAVE file');
  let offset = 12, format = null, data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString();
    const size = bytes.readUInt32LE(offset + 4);
    const body = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') format = { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV is missing its fmt or data chunk');
  if (format.tag !== 1 || format.channels !== 1 || format.rate !== 16_000 || format.bits !== 16) throw new Error('WAV must be 16 kHz mono PCM16');
  return data.subarray(0, data.length - (data.length % 2));
}

/** 44-byte canonical header, mono PCM16. */
function wavFile(pcm, rate = 16_000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Where the voiced part of an utterance ends. 20 ms RMS windows, threshold 3% of the loudest
 * window: a sentence that was stopped mid-syllable ends with ~no trailing silence, a sentence that
 * finished normally ends with a decay plus some. `voicedMs` is what to divide by the character
 * count — raw bytes include whatever silence the provider padded with.
 */
function voiceProfile(pcm) {
  const WINDOW = 320; // 20 ms @ 16 kHz
  const windows = [];
  for (let i = 0; i + WINDOW * 2 <= pcm.length; i += WINDOW * 2) {
    let sum = 0;
    for (let s = 0; s < WINDOW; s++) { const v = pcm.readInt16LE(i + s * 2); sum += v * v; }
    windows.push(Math.sqrt(sum / WINDOW));
  }
  if (!windows.length) return { totalMs: 0, voicedStartMs: null, voicedEndMs: null, voicedMs: 0, trailingSilenceMs: 0, peakRms: 0, tailRms: 0 };
  const peak = Math.max(...windows);
  const threshold = peak * 0.03;
  let first = null, last = null;
  windows.forEach((rms, i) => { if (rms > threshold) { if (first === null) first = i; last = i; } });
  const totalMs = windows.length * 20;
  const voicedStartMs = first === null ? null : first * 20;
  const voicedEndMs = last === null ? null : (last + 1) * 20;
  // The RMS of the final 100 ms actually delivered: a hard cut leaves it near the peak.
  const tail = windows.slice(-5);
  const tailRms = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  return {
    totalMs,
    voicedStartMs,
    voicedEndMs,
    voicedMs: first === null ? 0 : voicedEndMs - voicedStartMs,
    trailingSilenceMs: last === null ? totalMs : totalMs - voicedEndMs,
    peakRms: Math.round(peak),
    tailRms: Math.round(tailRms),
    tailPeakRatio: peak ? Number((tailRms / peak).toFixed(3)) : 0,
  };
}

let PITCH = Buffer.alloc(0);
if (SCENARIO !== 'dry') {
  PITCH = wavPcm16k(WAV_PATH);
  console.log(`# pitch pcm bytes=${PITCH.length} (~${(PITCH.length / 32_000).toFixed(2)}s)`);
}

if (SCENARIO === 'dry') {
  // Self-test of the WAV writer and the voiced-tail analysis, with no socket opened.
  const pcm = wavPcm16k(WAV_PATH);
  const path = `${OUT_DIR}/dry-selftest.wav`;
  writeFileSync(path, wavFile(pcm));
  console.log(`# dry run: no socket opened; wrote ${path} (${pcm.length} pcm bytes)`);
  console.log(`# dry voiceProfile(pitch)=${JSON.stringify(voiceProfile(pcm))}`);
  process.exit(0);
}

const HARD_CAP_MS = 34_000;
const FAILSAFE_MS = 39_000;
const CHUNK = 3_200;              // 100 ms of PCM16 @ 16 kHz
const SILENCE = Buffer.alloc(CHUNK);
/** How long to wait for the server to inject its own output / close before we answer the call. */
const CLIENT_OUTPUT_DELAY_MS = 2_500;
/** How long to watch for a follow-up response after our own function_call_output. */
const FOLLOW_UP_WINDOW_MS = 3_500;

let t0 = Date.now();
const ms = () => Date.now() - t0;
const pad = v => String(v).padStart(6, ' ');
const log = (dir, text) => console.log(`[+${pad(ms())}ms] ${dir} ${text}`);
const trunc = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s);

const responses = new Map();
const order = [];
const acct = id => {
  if (!responses.has(id)) {
    responses.set(id, {
      createdMs: null, doneMs: null, doneStatus: null, audioBytes: 0, audioDeltas: 0,
      firstAudioMs: null, lastAudioMs: null, audioDoneMs: null, chunks: [],
      transcript: '', transcriptDone: null, outputTypes: [], itemStatuses: [], functionCalls: [], itemsAdded: [],
    });
    order.push(id);
  }
  return responses.get(id);
};

const state = {
  sessionUpdatedCount: 0,
  toolsEcho: [],
  toolChoiceEcho: [],
  openerId: null,
  openerDoneMs: null,
  pitchStartedMs: null,
  pitchDoneMs: null,
  appendsSent: 0,
  appendBytes: 0,
  silenceAppends: 0,
  callerTranscripts: [],
  errors: [],
  timeline: [],
  functionCalls: new Map(),   // call_id -> {name, args, viaTypes[], atMs}
  serverInjectedOutputs: [],  // the server's own function_call_output items
  outputSent: [],
  resentTools: false,
  closeMs: null,
  closeCode: null,
  socketErrorMs: null,
  eventTypeCounts: new Map(),
  filesWritten: [],
};

const timers = [];
const after = (delay, fn) => { const t = setTimeout(fn, delay); timers.push(t); return t; };
const mark = (what, note = '') => { state.timeline.push({ atMs: ms(), what, note }); };

function send(obj, note = '') {
  try {
    ws.send(JSON.stringify(obj));
    if (obj.type !== 'input_audio_buffer.append') log('->', `${JSON.stringify(obj)}${note ? ` ${note}` : ''}`);
  } catch (error) {
    log('->', `SEND FAILED ${String(error?.message ?? error)}`);
  }
}

function sendAppend(pcm, kind) {
  const first = state.appendsSent === 0;
  try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })); }
  catch (error) { log('->', `APPEND FAILED ${String(error?.message ?? error)}`); return; }
  state.appendsSent += 1;
  state.appendBytes += pcm.length;
  if (kind === 'silence') state.silenceAppends += 1;
  if (first || state.appendsSent % 20 === 0) log('->', `append(${kind}) n=${state.appendsSent} totalBytes=${state.appendBytes} buffered=${ws.bufferedAmount}`);
}

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.realtimePort === undefined ? {} : { Host: 'api.x.ai' }) },
  handshakeTimeout: 12_000,
  maxPayload: 2 * 1024 * 1024,
});

ws.on('upgrade', res => { t0 = Date.now(); log('##', `handshake ${res.statusCode}`); mark('handshake', String(res.statusCode)); });
ws.on('open', () => { t0 = Date.now(); log('##', 'socket open'); mark('open'); send(INITIAL_SESSION_UPDATE); });

const TOOLISH = /function_call|tool_call|"tools"|tool_choice|end_call|hang_up|ending_call/i;

ws.on('message', raw => {
  let e;
  const text = raw.toString();
  try { e = JSON.parse(text); } catch { log('<-', `NON-JSON ${trunc(text, 200)}`); return; }
  const type = e.type;
  state.eventTypeCounts.set(type, (state.eventTypeCounts.get(type) ?? 0) + 1);
  const rid = e.response?.id ?? e.response_id ?? null;
  const head = `${type} event_id=${e.event_id ?? '-'} response_id=${rid ?? '-'} item_id=${e.item_id ?? '-'}`;

  // Anything mentioning a tool, a function call or the server's own ending marker is logged whole.
  const toolish = TOOLISH.test(text) && type !== 'session.updated';
  if (toolish) {
    log('<-', `${head} TOOLISH FULL=${trunc(text, 3_000)}`);
    mark(type, trunc(text, 200));
    captureFunctionCall(e);
    captureServerInjectedOutput(e);
    // fall through so the accounting below still runs
  }

  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const buf = typeof e.delta === 'string' ? Buffer.from(e.delta, 'base64') : Buffer.alloc(0);
    const a = acct(rid ?? '(no-id)');
    a.audioBytes += buf.length; a.audioDeltas += 1; a.chunks.push(buf);
    if (a.firstAudioMs === null) { a.firstAudioMs = ms(); mark('firstAudioDelta', rid ?? '-'); }
    a.lastAudioMs = ms();
    if (a.audioDeltas === 1 || a.audioDeltas % 20 === 0) log('<-', `${head} audioBytes=${buf.length} total=${a.audioBytes} deltas=${a.audioDeltas}`);
    return;
  }
  if (type === 'response.output_audio.done' || type === 'response.audio.done') {
    acct(rid ?? '(no-id)').audioDoneMs = ms();
    log('<-', `${head} audioDone total=${acct(rid ?? '(no-id)').audioBytes}`);
    mark('outputAudioDone', rid ?? '-');
    return;
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
    acct(rid ?? '(no-id)').transcript += String(e.delta ?? '');
    return;
  }
  if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
    acct(rid ?? '(no-id)').transcriptDone = String(e.transcript ?? '');
    log('<-', `${head} transcriptDone=${JSON.stringify(String(e.transcript ?? ''))}`);
    mark('transcriptDone', JSON.stringify(String(e.transcript ?? '')));
    return;
  }
  if (type === 'conversation.item.input_audio_transcription.completed' || type === 'conversation.item.input_audio_transcription.updated') {
    const t = String(e.transcript ?? '');
    state.callerTranscripts.push({ atMs: ms(), type, text: t.slice(0, 400) });
    log('<-', `${head} callerTranscript=${JSON.stringify(trunc(t, 400))}`);
    return;
  }
  if (type === 'response.created') {
    const a = acct(rid ?? '(no-id)');
    a.createdMs = ms();
    if (!state.openerId) { state.openerId = rid; log('##', `opener response.created id=${rid}`); }
    log('<-', `${head} status=${e.response?.status ?? '-'}`);
    mark('response.created', rid ?? '-');
    return;
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const a = acct(rid ?? '(no-id)');
    a.itemsAdded.push({ atMs: ms(), phase: type.endsWith('.added') ? 'added' : 'done', itemType: e.item?.type ?? '-', name: e.item?.name ?? undefined, status: e.item?.status ?? undefined });
    if (!toolish) log('<-', `${head} item=${JSON.stringify({ type: e.item?.type, status: e.item?.status })}`);
    mark(type, `${e.item?.type ?? '-'}${e.item?.name ? `:${e.item.name}` : ''} status=${e.item?.status ?? '-'}`);
    return;
  }
  if (type === 'response.done') {
    const a = acct(rid ?? '(no-id)');
    a.doneMs = ms();
    a.doneStatus = e.response?.status ?? null;
    for (const out of e.response?.output ?? []) {
      a.outputTypes.push(out?.type ?? '(no type)');
      a.itemStatuses.push({ type: out?.type ?? '-', status: out?.status ?? '-', name: out?.name ?? undefined });
      if (out?.type === 'function_call') a.functionCalls.push({ name: out.name, call_id: out.call_id, arguments: out.arguments });
    }
    if (!toolish) log('<-', `${head} status=${a.doneStatus} items=${JSON.stringify(a.itemStatuses)} FULL=${trunc(text, 2_500)}`);
    mark('response.done', `${rid} status=${a.doneStatus} items=${JSON.stringify(a.itemStatuses)}`);
    onResponseDone(rid, a.doneStatus);
    return;
  }
  if (type === 'error') {
    state.errors.push({ atMs: ms(), raw: text.slice(0, 2_000) });
    log('<-', `${head} ERROR FULL=${trunc(text, 2_000)}`);
    mark('error', trunc(text, 200));
    return;
  }
  if (type === 'session.updated') {
    state.sessionUpdatedCount += 1;
    const tools = e.session?.tools;
    const choice = e.session?.tool_choice;
    const names = Array.isArray(tools) ? tools.map(t => t?.name ?? t?.function?.name ?? '(unnamed)') : '(absent)';
    state.toolsEcho.push(tools === undefined ? '(absent)' : JSON.stringify(tools));
    state.toolChoiceEcho.push(choice === undefined ? '(absent)' : JSON.stringify(choice));
    log('<-', `${head} n=${state.sessionUpdatedCount} ECHO toolNames=${JSON.stringify(names)} tool_choice=${state.toolChoiceEcho.at(-1)}`);
    log('<-', `${head} n=${state.sessionUpdatedCount} FULL=${trunc(text, 3_000)}`);
    mark('session.updated', `n=${state.sessionUpdatedCount} toolNames=${JSON.stringify(names)}`);
    if (state.sessionUpdatedCount === 1) send(TRANSCRIPTION_UPDATE, '(requestInputTranscription — production sends this)');
    if (state.sessionUpdatedCount === 2 && PLAN.tools && (tools === undefined || (Array.isArray(tools) && tools.length === 0))) {
      // FINDING, not a silent fix: the production transcription update cleared the tools.
      state.resentTools = true;
      log('##', 'session.updated n=2 shows tools CLEARED by the transcription update — re-sending tools once');
      send({ type: 'session.update', event_id: 'probe-retools', session: { tools: PLAN.tools, tool_choice: PLAN.toolChoice } });
    }
    return;
  }
  if (!toolish) log('<-', `${head} ${trunc(text, 300)}`);
});

/** call_id / name / arguments, from whichever shape the provider actually uses. */
function captureFunctionCall(e) {
  const candidates = [];
  if (e.call_id || e.name || e.arguments) candidates.push({ call_id: e.call_id, name: e.name, args: e.arguments, via: e.type });
  if (e.item && (e.item.type === 'function_call' || e.item.call_id)) candidates.push({ call_id: e.item.call_id, name: e.item.name, args: e.item.arguments, via: `${e.type}:item` });
  for (const out of e.response?.output ?? []) if (out?.type === 'function_call') candidates.push({ call_id: out.call_id, name: out.name, args: out.arguments, via: `${e.type}:response.output` });
  for (const c of candidates) {
    if (!c.call_id) continue;
    const existing = state.functionCalls.get(c.call_id) ?? { name: c.name, args: c.args, viaTypes: [], atMs: ms() };
    existing.viaTypes.push(c.via);
    if (c.name) existing.name = c.name;
    if (typeof c.args === 'string' && c.args.length >= String(existing.args ?? '').length) existing.args = c.args;
    state.functionCalls.set(c.call_id, existing);
  }
  if (e.type === 'response.function_call_arguments.done') {
    mark('function_call_arguments.done', `name=${e.name} call_id=${e.call_id}`);
    // H1/H2: the server may not execute a client tool. Give it CLIENT_OUTPUT_DELAY_MS to inject its
    // own output or close, then answer the call ourselves and watch for a follow-up.
    if (PLAN.tools) scheduleClientOutput(e.call_id);
  }
}

/** The server's own `function_call_output {"status":"ending_call"}` — H0's signature. */
function captureServerInjectedOutput(e) {
  const item = e.item;
  if (!item || item.type !== 'function_call_output') return;
  if (state.outputSent.includes(item.call_id) && e.type !== 'conversation.item.created') {
    // our own echo back; still record it, tagged
    state.serverInjectedOutputs.push({ atMs: ms(), type: e.type, call_id: item.call_id, output: String(item.output ?? '').slice(0, 400), ours: true });
    return;
  }
  const ours = state.outputSent.includes(item.call_id);
  state.serverInjectedOutputs.push({ atMs: ms(), type: e.type, call_id: item.call_id, output: String(item.output ?? '').slice(0, 400), ours });
  log('##', `${ours ? 'ECHO of OUR' : 'SERVER-INJECTED'} function_call_output call_id=${item.call_id} output=${JSON.stringify(String(item.output ?? ''))}`);
  mark(ours ? 'ourFunctionCallOutputEcho' : 'serverInjectedFunctionCallOutput', String(item.output ?? '').slice(0, 120));
}

function scheduleClientOutput(callId) {
  if (!callId || state.outputSent.includes(callId)) return;
  after(CLIENT_OUTPUT_DELAY_MS, () => {
    if (ws.readyState !== 1) { log('##', `socket already closed ${CLIENT_OUTPUT_DELAY_MS}ms after the call — server executed the tool itself`); return; }
    if (state.serverInjectedOutputs.some(o => !o.ours)) { log('##', 'server injected its own function_call_output — not replying'); return; }
    if (state.outputSent.includes(callId)) return;
    state.outputSent.push(callId);
    log('##', `no server output and socket still open — replying with function_call_output for call_id=${callId} (NO response.create)`);
    send({ type: 'conversation.item.create', event_id: 'probe-fnout', item: { type: 'function_call_output', call_id: callId, output: '{"ok":true}' } });
    after(FOLLOW_UP_WINDOW_MS, () => {
      log('##', `follow-up window over (${FOLLOW_UP_WINDOW_MS}ms after our output) — closing the socket ourselves`);
      mark('probeClosedSocket');
      try { ws.close(); } catch { /* already gone */ }
      after(1_500, () => finish(0));
    });
  });
}

function onResponseDone(rid, status) {
  if (rid && rid === state.openerId && state.openerDoneMs === null) {
    state.openerDoneMs = ms();
    log('##', `opener response.done status=${status} — starting the sales pitch`);
    startPitch();
  }
}

/** Real-time pace, 100 ms per chunk, exactly like the adapter's uplink. */
function startPitch() {
  if (state.pitchStartedMs !== null) return;
  state.pitchStartedMs = ms();
  mark('pitchStart');
  const startedAt = Date.now();
  let offset = 0;
  const step = () => {
    if (ws.readyState !== 1) return;
    if (offset >= PITCH.length) {
      if (state.pitchDoneMs === null) { state.pitchDoneMs = ms(); log('##', `pitch fully sent (${state.appendsSent} appends) — switching to silence`); mark('pitchDone'); }
      sendAppend(SILENCE, 'silence');
    } else {
      sendAppend(Buffer.from(PITCH.subarray(offset, offset + CHUNK)), 'pitch');
      offset += CHUNK;
    }
    const n = state.appendsSent;
    after(Math.max(0, startedAt + (n + 1) * 100 - Date.now()), step);
  };
  step();
}

after(12_000, () => { if (state.pitchStartedMs === null) { log('##', 'no opener response.done within 12s — starting the pitch anyway'); startPitch(); } });

// S27 决策 15: `ws` reports the server's own teardown as an `error` BEFORE `close`. Never let that
// end the run here, or the close code and its timing — the whole point of H0 — never get logged.
ws.on('error', error => { state.socketErrorMs = ms(); log('##', `SOCKET ERROR ${String(error?.message ?? error)}`); mark('socketError', String(error?.message ?? error).slice(0, 120)); after(2_000, () => finish(0)); });
ws.on('close', (code, reason) => {
  state.closeMs = ms(); state.closeCode = code;
  log('##', `socket close code=${code} reason=${trunc(String(reason ?? ''), 120)}`);
  mark('socketClose', `code=${code}`);
  after(300, () => finish(0));
});

after(HARD_CAP_MS, () => { log('##', `hard cap ${HARD_CAP_MS}ms reached, closing`); try { ws.close(); } catch { /* already gone */ } after(1_500, () => finish(0)); });
setTimeout(() => { console.log('# failsafe exit'); finish(1); setTimeout(() => process.exit(1), 200).unref(); }, FAILSAFE_MS).unref();

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  for (const t of timers) clearTimeout(t);
  try { writeWavs(); } catch (error) { console.log(`# WAV WRITE FAILED ${String(error?.message ?? error)}`); }
  summary();
  setTimeout(() => process.exit(code), 100).unref();
}

/** Opener = first audio-bearing response, goodbye = last one. Both are written; nothing is trimmed. */
function writeWavs() {
  const withAudio = order.filter(id => (responses.get(id)?.audioBytes ?? 0) > 0);
  const label = (id, i) => (i === 0 ? 'opener' : i === withAudio.length - 1 ? 'goodbye' : `r${i}`);
  withAudio.forEach((id, i) => {
    const a = responses.get(id);
    const pcm = Buffer.concat(a.chunks);
    const path = `${OUT_DIR}/${SCENARIO}-${label(id, i)}.wav`;
    writeFileSync(path, wavFile(pcm));
    a.wavPath = path;
    a.profile = voiceProfile(pcm);
    state.filesWritten.push({ path, responseId: id, pcmBytes: pcm.length });
    console.log(`# wrote ${path} pcmBytes=${pcm.length} (~${(pcm.length / 32_000).toFixed(2)}s)`);
  });
}

function charCount(text) {
  const all = [...String(text ?? '')].length;
  const stripped = [...String(text ?? '').replace(/[\s，。！？、,.!?；;：:"'「」“”…—～~]/g, '')].length;
  return { all, stripped };
}

function summary() {
  console.log('');
  console.log(`===== SUMMARY scenario=${SCENARIO} =====`);
  console.log(`toolsDeclared=${JSON.stringify(PLAN.tools ? PLAN.tools.map(t => t.name) : '(key absent)')} toolChoice=${JSON.stringify(PLAN.toolChoice ?? '(absent)')} resentToolsAfterTranscriptionUpdate=${state.resentTools}`);
  console.log(`session.updated count=${state.sessionUpdatedCount}`);
  state.toolsEcho.forEach((t, i) => console.log(`  echo[${i + 1}] session.tools=${trunc(t, 1_200)} tool_choice=${state.toolChoiceEcho[i]}`));
  console.log(`errors=${state.errors.length}`);
  for (const e of state.errors) console.log(`  error@+${e.atMs}ms ${trunc(e.raw, 1_200)}`);
  console.log(`opener=${state.openerId ?? '(none)'} openerDone=+${state.openerDoneMs}ms pitchStart=+${state.pitchStartedMs}ms pitchDone=+${state.pitchDoneMs}ms appends=${state.appendsSent} (silence=${state.silenceAppends})`);
  console.log(`callerTranscripts=${JSON.stringify(state.callerTranscripts)}`);
  console.log(`socketErrorMs=${state.socketErrorMs} closeMs=${state.closeMs} closeCode=${state.closeCode} probeClosedItself=${state.timeline.some(t => t.what === 'probeClosedSocket')}`);
  console.log(`functionCalls=${state.functionCalls.size} weAnsweredCallIds=${JSON.stringify(state.outputSent)}`);
  for (const [id, info] of state.functionCalls) console.log(`  call_id=${id} name=${info.name} arguments=${JSON.stringify(info.args ?? null)} firstSeen=+${info.atMs}ms carriedBy=${JSON.stringify(info.viaTypes)}`);
  console.log(`functionCallOutputs=${JSON.stringify(state.serverInjectedOutputs)}`);
  console.log('--- TIMELINE ---');
  for (const t of state.timeline) console.log(`  +${pad(t.atMs)}ms ${t.what}${t.note ? ` ${trunc(t.note, 220)}` : ''}`);
  console.log('--- RESPONSES ---');
  for (const id of order) {
    const a = responses.get(id);
    const text = a.transcriptDone ?? a.transcript;
    const chars = charCount(text);
    const profile = a.profile ?? (a.chunks.length ? voiceProfile(Buffer.concat(a.chunks)) : null);
    console.log(JSON.stringify({
      responseId: id,
      isOpener: id === state.openerId,
      createdMs: a.createdMs,
      firstAudioMs: a.firstAudioMs,
      lastAudioMs: a.lastAudioMs,
      audioDoneMs: a.audioDoneMs,
      doneMs: a.doneMs,
      doneStatus: a.doneStatus,
      audioDeltas: a.audioDeltas,
      audioBytes: a.audioBytes,
      audioMs: Math.round(a.audioBytes / 32),
      itemStatuses: a.itemStatuses,
      itemsAdded: a.itemsAdded,
      functionCalls: a.functionCalls,
      transcript: text,
      chars,
      bytesPerChar: chars.stripped ? Math.round(a.audioBytes / chars.stripped) : null,
      msPerChar: chars.stripped ? Math.round(a.audioBytes / 32 / chars.stripped) : null,
      voicedMsPerChar: chars.stripped && profile ? Math.round(profile.voicedMs / chars.stripped) : null,
      profile,
      wav: a.wavPath ?? null,
    }));
  }
  console.log(`eventTypeCounts=${JSON.stringify(Object.fromEntries(state.eventTypeCounts))}`);
  console.log(`filesWritten=${JSON.stringify(state.filesWritten)}`);
  console.log('===== END SUMMARY =====');
}
