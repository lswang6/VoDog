/**
 * Throwaway diagnostic probe (NOT in the deploy manifest — see infra/deploy-voice-relay-secondary.py
 * RUNTIME_FILES — and never ships). Sibling of xai-probe.mjs: same raw `ws` session, same
 * timestamped logging, one fresh session per scenario, no files written.
 *
 * Question: does the REAL xAI Space agent accept a client-declared function tool `end_call`
 * on a realtime session, and what is the exact event shape that carries the call?
 *
 * Usage: node xai-tool-probe.mjs <dry|T1|T2|T3|T4>
 *   T1 tool-declared     — production's session.update + tools:[end_call] + tool_choice:'auto'
 *   T2 control-no-tool   — production's session.update byte-for-byte (tools: [])
 *   T3 tool-required     — T1, plus session.update {tool_choice:'required'} at the opener's done
 *   T4 alt-shapes        — T1 plus alternative tool encodings, each with its own event_id
 *
 * Both T1/T2/T3 stream a Chinese sales pitch (/tmp/sales-16k.wav) at real-time pace after the
 * Space agent's opener finishes, then keep sending silence so server VAD can end the turn.
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { xaiConfig, xaiRealtimeUrl } from './providers/xai.mjs';

const SCENARIO = (process.argv[2] || 'T1').trim();
const WAV_PATH = process.argv[3] || process.env.VOICE_PROBE_WAV_PATH || './fixtures/synthetic-16k.wav';
const SCENARIOS = new Set(['dry', 'T1', 'T2', 'T3', 'T4']);
if (!SCENARIOS.has(SCENARIO)) { console.error(`unknown scenario ${SCENARIO}`); process.exit(2); }

const cfg = xaiConfig(process.env);
const url = xaiRealtimeUrl(cfg);

// turnDetection() is not exported from providers/xai.mjs — rebuilt byte-for-byte here.
const turnDetection = {
  type: 'server_vad',
  ...(cfg.vadThreshold === undefined ? {} : { threshold: cfg.vadThreshold }),
  ...(cfg.vadPrefixMs === undefined ? {} : { prefix_padding_ms: cfg.vadPrefixMs }),
  ...(cfg.vadSilenceMs === undefined ? {} : { silence_duration_ms: cfg.vadSilenceMs }),
};

/** The OpenAI Realtime function-tool shape (flat `name`/`parameters` beside `type:'function'`). */
const END_CALL_TOOL = {
  type: 'function',
  name: 'end_call',
  description: '在礼貌道别之后调用，用于挂断本次电话',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', enum: ['sales_refused', 'info_collected', 'abusive', 'other'] } },
    required: ['reason'],
  },
};
/** Chat-completions nesting, for T4 only. */
const END_CALL_NESTED = { type: 'function', function: { name: END_CALL_TOOL.name, description: END_CALL_TOOL.description, parameters: END_CALL_TOOL.parameters } };

const PLAN = {
  dry: { tools: [END_CALL_TOOL], toolChoice: 'auto' },
  T1: { tools: [END_CALL_TOOL], toolChoice: 'auto' },
  T2: { tools: [], toolChoice: undefined },                       // production, byte-for-byte
  T3: { tools: [END_CALL_TOOL], toolChoice: 'auto', requiredAtOpenerDone: true },
  T4: { tools: [END_CALL_TOOL], toolChoice: 'auto', altShapes: true },
}[SCENARIO];

/**
 * Agent mode omits `instructions` — sending it replaces the Space agent's own prompt
 * (providers/xai.mjs, MODEL_INSTRUCTIONS; probe S6). `cfg.instructions` is never set by env.
 */
const sessionBlock = ({ tools, toolChoice }) => ({
  ...(cfg.voice ? { voice: cfg.voice } : {}),
  turn_detection: turnDetection,
  tools,
  ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  audio: {
    input: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
    output: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
  },
});

const PRODUCTION_SESSION = sessionBlock({ tools: [], toolChoice: undefined });
const INITIAL_SESSION_UPDATE = { type: 'session.update', event_id: 'probe-initial', session: sessionBlock(PLAN) };

const TRANSCRIPTION_UPDATE = {
  type: 'session.update',
  event_id: 'cc-transcription-probe',
  session: {
    audio: { input: { transcription: { model: cfg.transcriptionModel ?? 'whisper-1' } } },
    input_audio_transcription: { model: cfg.transcriptionModel ?? 'whisper-1' },
  },
};

console.log(`# scenario=${SCENARIO}`);
console.log(`# url=${url}`);
console.log(`# realtimePort=${cfg.realtimePort ?? '(unset, 443)'} agentId=${cfg.agentId ?? '(none)'} model=${cfg.model ?? '(none)'}`);
console.log(`# turn_detection=${JSON.stringify(turnDetection)}`);
console.log(`# PRODUCTION session block (providers/xai.mjs start(), agent mode)=${JSON.stringify(PRODUCTION_SESSION)}`);
console.log(`# PROBE     session block=${JSON.stringify(INITIAL_SESSION_UPDATE.session)}`);
console.log(`# DIFF vs production: tools=${JSON.stringify(PLAN.tools)} tool_choice=${JSON.stringify(PLAN.toolChoice ?? null)}`);
console.log(`# transcription session.update=${JSON.stringify(TRANSCRIPTION_UPDATE)}`);
console.log(`# wav=${WAV_PATH}`);

/** Only 16 kHz mono PCM16 — the spec the worker actually feeds the adapter (doubao-smoke.mjs). */
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

let PITCH = Buffer.alloc(0);
if (SCENARIO !== 'dry') {
  PITCH = wavPcm16k(WAV_PATH);
  console.log(`# pitch pcm bytes=${PITCH.length} (~${(PITCH.length / 32_000).toFixed(2)}s)`);
}

if (SCENARIO === 'dry') { console.log('# dry run: no socket opened'); process.exit(0); }

const HARD_CAP_MS = 37_000;
const FAILSAFE_MS = 43_000;
const CHUNK = 3_200;              // 100 ms of PCM16 @ 16 kHz
const SILENCE = Buffer.alloc(CHUNK);

let t0 = Date.now();
const ms = () => Date.now() - t0;
const pad = v => String(v).padStart(6, ' ');
const log = (dir, text) => console.log(`[+${pad(ms())}ms] ${dir} ${text}`);
const trunc = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s);

const responses = new Map();
const acct = id => {
  if (!responses.has(id)) responses.set(id, { createdMs: null, doneMs: null, doneStatus: null, audioBytes: 0, audioDeltas: 0, transcript: '', outputTypes: [], functionCalls: [] });
  return responses.get(id);
};

const state = {
  sessionUpdatedCount: 0,
  sessionUpdatedMs: null,
  toolsEcho: [],            // one entry per session.updated: what `session.tools` looked like
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
  toolEvents: [],           // every event whose raw JSON mentions a tool / function call
  functionCalls: new Map(), // call_id -> {name, args, viaTypes[]}
  outputSent: [],
  resentTools: false,
  eventTypeCounts: new Map(),
};

const timers = [];
const after = (delay, fn) => { const t = setTimeout(fn, delay); timers.push(t); return t; };

function send(obj, note = '') {
  try {
    ws.send(JSON.stringify(obj));
    if (obj.type !== 'input_audio_buffer.append') log('->', `${JSON.stringify(obj)}${note ? ` ${note}` : ''}`);
  } catch (error) {
    log('->', `SEND FAILED ${String(error?.message ?? error)}`);
  }
}

/** Appends are logged one line per second, never per 100 ms — 10 s of base64 would bury the log. */
function sendAppend(pcm, kind) {
  const first = state.appendsSent === 0;
  try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })); }
  catch (error) { log('->', `APPEND FAILED ${String(error?.message ?? error)}`); return; }
  state.appendsSent += 1;
  state.appendBytes += pcm.length;
  if (kind === 'silence') state.silenceAppends += 1;
  if (first || state.appendsSent % 10 === 0) log('->', `input_audio_buffer.append(${kind}) n=${state.appendsSent} bytes=${pcm.length} totalBytes=${state.appendBytes} bufferedAmount=${ws.bufferedAmount}`);
}

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.realtimePort === undefined ? {} : { Host: 'api.x.ai' }) },
  handshakeTimeout: 12_000,
  maxPayload: 2 * 1024 * 1024,
});

ws.on('upgrade', res => { t0 = Date.now(); log('##', `handshake ${res.statusCode}`); });
ws.on('open', () => { t0 = Date.now(); log('##', 'socket open'); send(INITIAL_SESSION_UPDATE); });

const TOOLISH = /function_call|tool_call|"tools"|tool_choice|end_call/i;

ws.on('message', raw => {
  let e;
  const text = raw.toString();
  try { e = JSON.parse(text); } catch { log('<-', `NON-JSON ${trunc(text, 200)}`); return; }
  const type = e.type;
  state.eventTypeCounts.set(type, (state.eventTypeCounts.get(type) ?? 0) + 1);
  const rid = e.response?.id ?? e.response_id ?? null;
  const head = `${type} event_id=${e.event_id ?? '-'} response_id=${rid ?? '-'} item_id=${e.item_id ?? '-'}`;

  // Anything mentioning a tool or a function call is logged in full, whatever its type.
  const toolish = TOOLISH.test(text) && type !== 'session.updated';
  if (toolish) {
    state.toolEvents.push({ atMs: ms(), type, raw: text.slice(0, 4_000) });
    log('<-', `${head} TOOLISH FULL=${trunc(text, 3_000)}`);
    captureFunctionCall(e);
    // fall through so accounting below still runs
  }

  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const bytes = typeof e.delta === 'string' ? Buffer.from(e.delta, 'base64').length : 0;
    const a = acct(rid ?? '(no-id)');
    a.audioBytes += bytes; a.audioDeltas += 1;
    if (a.audioDeltas === 1 || a.audioDeltas % 10 === 0) log('<-', `${head} audioBytes=${bytes} total=${a.audioBytes} deltas=${a.audioDeltas}`);
    return;
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
    acct(rid ?? '(no-id)').transcript += String(e.delta ?? '');
    return;
  }
  if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
    log('<-', `${head} transcriptDone=${JSON.stringify(String(e.transcript ?? ''))}`);
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
    log('<-', `${head} status=${e.response?.status ?? '-'} FULL=${trunc(text, 600)}`);
    return;
  }
  if (type === 'response.done') {
    const a = acct(rid ?? '(no-id)');
    a.doneMs = ms();
    a.doneStatus = e.response?.status ?? null;
    for (const out of e.response?.output ?? []) {
      a.outputTypes.push(out?.type ?? '(no type)');
      if (out?.type === 'function_call') a.functionCalls.push({ name: out.name, call_id: out.call_id, arguments: out.arguments });
    }
    if (!toolish) log('<-', `${head} status=${a.doneStatus} outputTypes=${JSON.stringify(a.outputTypes)} FULL=${trunc(text, 4_000)}`);
    onResponseDone(rid, a.doneStatus);
    return;
  }
  if (type === 'error') {
    state.errors.push({ atMs: ms(), raw: text.slice(0, 2_000) });
    log('<-', `${head} ERROR FULL=${trunc(text, 2_000)}`);
    return;
  }
  if (type === 'session.updated') {
    state.sessionUpdatedCount += 1;
    if (state.sessionUpdatedMs === null) state.sessionUpdatedMs = ms();
    const tools = e.session?.tools;
    const choice = e.session?.tool_choice;
    state.toolsEcho.push(tools === undefined ? '(absent)' : JSON.stringify(tools));
    state.toolChoiceEcho.push(choice === undefined ? '(absent)' : JSON.stringify(choice));
    log('<-', `${head} n=${state.sessionUpdatedCount} ECHO session.tools=${trunc(state.toolsEcho.at(-1), 1_500)} session.tool_choice=${state.toolChoiceEcho.at(-1)}`);
    log('<-', `${head} n=${state.sessionUpdatedCount} FULL=${trunc(text, 4_000)}`);
    if (state.sessionUpdatedCount === 1) {
      send(TRANSCRIPTION_UPDATE, '(requestInputTranscription — production sends this)');
      if (PLAN.altShapes) sendAltShapes();
    }
    if (state.sessionUpdatedCount === 2 && PLAN.tools.length && (tools === undefined || (Array.isArray(tools) && tools.length === 0))) {
      // FINDING, not a silent fix: the production transcription update cleared the tools.
      state.resentTools = true;
      log('##', 'session.updated n=2 shows tools CLEARED by the transcription update — re-sending tools once');
      send({ type: 'session.update', event_id: 'probe-retools', session: { tools: PLAN.tools, ...(PLAN.toolChoice === undefined ? {} : { tool_choice: PLAN.toolChoice }) } });
    }
    return;
  }
  if (!toolish) log('<-', `${head} ${trunc(text, 300)}`);
});

/** T4 only: alternative encodings, each tagged so the refusal is attributable. */
function sendAltShapes() {
  after(300, () => send({ type: 'session.update', event_id: 'probe-alt-nested-fn', session: { tools: [END_CALL_NESTED] } }, '(alt: chat-completions nesting)'));
  after(900, () => send({ type: 'session.update', event_id: 'probe-alt-toplevel', tools: [END_CALL_TOOL], session: {} }, '(alt: tools at the event top level)'));
  after(1_500, () => send({ type: 'session.update', event_id: 'probe-alt-choice-required', session: { tools: [END_CALL_TOOL], tool_choice: 'required' } }, '(alt: tool_choice required)'));
}

/** call_id / name / arguments, from whichever shape the provider actually uses. */
function captureFunctionCall(e) {
  const candidates = [];
  if (e.call_id || e.name || e.arguments) candidates.push({ call_id: e.call_id, name: e.name, args: e.arguments, via: e.type });
  if (e.item && (e.item.type === 'function_call' || e.item.call_id)) candidates.push({ call_id: e.item.call_id, name: e.item.name, args: e.item.arguments, via: `${e.type}:item` });
  for (const out of e.response?.output ?? []) if (out?.type === 'function_call') candidates.push({ call_id: out.call_id, name: out.name, args: out.arguments, via: `${e.type}:response.output` });
  for (const c of candidates) {
    if (!c.call_id) continue;
    const existing = state.functionCalls.get(c.call_id) ?? { name: c.name, args: c.args, viaTypes: [] };
    existing.viaTypes.push(c.via);
    if (c.name) existing.name = c.name;
    if (typeof c.args === 'string' && c.args.length >= String(existing.args ?? '').length) existing.args = c.args;
    state.functionCalls.set(c.call_id, existing);
  }
  // Reply exactly once per call_id, at the moment the arguments are complete.
  const complete = e.type === 'response.function_call_arguments.done' || (e.type === 'response.output_item.done' && e.item?.type === 'function_call')
    || (e.type === 'response.done' && (e.response?.output ?? []).some(o => o?.type === 'function_call'));
  if (!complete) return;
  for (const [callId, info] of state.functionCalls) {
    if (state.outputSent.includes(callId)) continue;
    state.outputSent.push(callId);
    log('##', `replying with function_call_output for call_id=${callId} name=${info.name} arguments=${JSON.stringify(info.args ?? null)} (NO response.create)`);
    send({ type: 'conversation.item.create', event_id: `probe-fnout-${state.outputSent.length}`, item: { type: 'function_call_output', call_id: callId, output: '{"ok":true}' } });
  }
}

function onResponseDone(rid, status) {
  if (rid && rid === state.openerId && state.openerDoneMs === null) {
    state.openerDoneMs = ms();
    log('##', `opener response.done status=${status} — starting the sales pitch`);
    if (PLAN.requiredAtOpenerDone) send({ type: 'session.update', event_id: 'probe-required', session: { tool_choice: 'required' } }, '(T3: force a tool call for the next turn)');
    startPitch();
  }
}

/** Real-time pace, 100 ms per chunk, exactly like the adapter's uplink. */
function startPitch() {
  if (state.pitchStartedMs !== null) return;
  state.pitchStartedMs = ms();
  const startedAt = Date.now();
  let offset = 0;
  const step = () => {
    if (ws.readyState !== 1) return;
    if (offset >= PITCH.length) {
      if (state.pitchDoneMs === null) { state.pitchDoneMs = ms(); log('##', `pitch fully sent (${state.appendsSent} appends, ${state.appendBytes} bytes) — switching to silence`); }
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

// The opener normally ends in ~3 s; never let a missing response.done cost the whole session.
after(12_000, () => { if (state.pitchStartedMs === null) { log('##', 'no opener response.done within 12s — starting the pitch anyway'); startPitch(); } });

ws.on('error', error => { log('##', `SOCKET ERROR ${String(error?.message ?? error)}`); finish(1); });
ws.on('close', (code, reason) => { log('##', `socket close code=${code} reason=${trunc(String(reason ?? ''), 120)}`); finish(0); });

after(HARD_CAP_MS, () => { log('##', `hard cap ${HARD_CAP_MS}ms reached, closing`); try { ws.close(); } catch { /* already gone */ } after(1_500, () => finish(0)); });
setTimeout(() => { console.log('# failsafe exit'); process.exit(1); }, FAILSAFE_MS).unref();

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  for (const t of timers) clearTimeout(t);
  summary();
  setTimeout(() => process.exit(code), 100).unref();
}

function summary() {
  console.log('');
  console.log(`===== SUMMARY scenario=${SCENARIO} =====`);
  console.log(`toolsDeclared=${PLAN.tools.length} toolChoice=${JSON.stringify(PLAN.toolChoice ?? null)} resentToolsAfterTranscriptionUpdate=${state.resentTools}`);
  console.log(`session.updated count=${state.sessionUpdatedCount} first=+${state.sessionUpdatedMs}ms`);
  state.toolsEcho.forEach((t, i) => console.log(`  echo[${i + 1}] session.tools=${trunc(t, 1_200)} tool_choice=${state.toolChoiceEcho[i]}`));
  console.log(`errors=${state.errors.length}`);
  for (const e of state.errors) console.log(`  error@+${e.atMs}ms ${trunc(e.raw, 1_200)}`);
  console.log(`opener=${state.openerId ?? '(none)'} openerDone=+${state.openerDoneMs}ms pitchStart=+${state.pitchStartedMs}ms pitchDone=+${state.pitchDoneMs}ms appends=${state.appendsSent} (silence=${state.silenceAppends})`);
  console.log(`callerTranscripts=${JSON.stringify(state.callerTranscripts)}`);
  console.log(`functionCalls=${state.functionCalls.size} outputSentFor=${JSON.stringify(state.outputSent)}`);
  for (const [id, info] of state.functionCalls) console.log(`  call_id=${id} name=${info.name} arguments=${JSON.stringify(info.args ?? null)} carriedBy=${JSON.stringify(info.viaTypes)}`);
  console.log(`toolishEvents=${state.toolEvents.length}`);
  for (const t of state.toolEvents) console.log(`  toolish@+${t.atMs}ms type=${t.type} raw=${trunc(t.raw, 1_500)}`);
  console.log(`eventTypeCounts=${JSON.stringify(Object.fromEntries(state.eventTypeCounts))}`);
  for (const [id, a] of responses) {
    console.log(JSON.stringify({
      responseId: id,
      isOpener: id === state.openerId,
      createdMs: a.createdMs,
      doneMs: a.doneMs,
      doneStatus: a.doneStatus,
      audioDeltas: a.audioDeltas,
      audioBytes: a.audioBytes,
      outputTypes: a.outputTypes,
      functionCalls: a.functionCalls,
      transcript: a.transcript,
    }));
  }
  console.log('===== END SUMMARY =====');
}
