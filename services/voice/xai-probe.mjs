/**
 * Throwaway diagnostic probe (NOT in the deploy manifest, never ships).
 * Captures the raw xAI realtime event sequence around the Space agent's spontaneous
 * opener and our greet() request. One fresh session per scenario, <= 25 s, no files written.
 *
 * Usage: node xai-probe.mjs <dry|S1|S2|S3|S4|S5>
 */
import WebSocket from 'ws';
import { xaiConfig, xaiRealtimeUrl } from './providers/xai.mjs';

const SCENARIO = (process.argv[2] || 'S1').trim();
// S6 is the de-confound for S4/S5: identical to S4 except the initial session.update omits
// `instructions`, so the Space agent keeps its own persona. One variable changed, nothing else.
const SCENARIOS = new Set(['dry', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
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

const INITIAL_SESSION_UPDATE = {
  type: 'session.update',
  session: {
    ...(cfg.voice ? { voice: cfg.voice } : {}),
    ...(SCENARIO === 'S6' ? {} : { instructions: cfg.instructions ?? '请用中文简洁接听电话，说明你是AI助理。' }),
    turn_detection: turnDetection,
    tools: [],
    audio: {
      input: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
      output: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
    },
  },
};

const TRANSCRIPTION_EVENT_ID = 'cc-transcription-probe';
const TRANSCRIPTION_UPDATE = {
  type: 'session.update',
  event_id: TRANSCRIPTION_EVENT_ID,
  session: {
    audio: { input: { transcription: { model: cfg.transcriptionModel ?? 'whisper-1' } } },
    input_audio_transcription: { model: cfg.transcriptionModel ?? 'whisper-1' },
  },
};

const GREETING_TEXT = cfg.greeting ?? '通话已接通，请用你的开场白问候来电者';
const GREET_CREATE = { type: 'response.create', event_id: 'probe-greeting', response: { instructions: GREETING_TEXT } };
const BARE_CREATE = { type: 'response.create', event_id: 'probe-bare' };
const INSTRUCTED_CREATE = { type: 'response.create', event_id: 'probe-instructed', response: { instructions: '请用你的开场白问候来电者' } };

const redactedUrl = url;
console.log(`# scenario=${SCENARIO}`);
console.log(`# url=${redactedUrl}`);
console.log(`# realtimePort=${cfg.realtimePort ?? '(unset, 443)'} agentId=${cfg.agentId ?? '(none)'} model=${cfg.model ?? '(none)'}`);
console.log(`# turn_detection=${JSON.stringify(turnDetection)}`);
console.log(`# initial session.update=${JSON.stringify(INITIAL_SESSION_UPDATE)}`);
console.log(`# transcription session.update=${JSON.stringify(TRANSCRIPTION_UPDATE)}`);
console.log(`# greeting create=${JSON.stringify(GREET_CREATE)}`);

if (SCENARIO === 'dry') { console.log('# dry run: no socket opened'); process.exit(0); }

let t0 = Date.now();
const ms = () => Date.now() - t0;
const pad = v => String(v).padStart(6, ' ');
const log = (dir, text) => console.log(`[+${pad(ms())}ms] ${dir} ${text}`);
const trunc = (s, n = 400) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s);

// Per-response accounting: the discriminating measurement.
const responses = new Map();
const acct = id => {
  if (!responses.has(id)) responses.set(id, { createdMs: null, firstAudioMs: null, lastAudioMs: null, audioBytes: 0, audioDeltas: 0, bytesAfterMark: 0, transcript: '', doneMs: null, doneStatus: null, doneDetails: null, doneTranscripts: [] });
  return responses.get(id);
};
let markLabel = null;          // set when we send the probe request; bytes after it are attributed
let markAtMs = null;
let openerId = null;
let openerDoneAt = null;
let sessionUpdatedMs = null;
let sessionUpdatedCount = 0;
const timers = [];
const after = (delay, fn) => { const t = setTimeout(fn, delay); timers.push(t); return t; };

function send(obj, note = '') {
  try {
    ws.send(JSON.stringify(obj));
    log('->', `${JSON.stringify(obj)}${note ? ` ${note}` : ''}`);
  } catch (error) {
    log('->', `SEND FAILED ${String(error?.message ?? error)}`);
  }
}

function mark(label) { markLabel = label; markAtMs = ms(); }

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.realtimePort === undefined ? {} : { Host: 'api.x.ai' }) },
  handshakeTimeout: 12_000,
  maxPayload: 2 * 1024 * 1024,
});

ws.on('upgrade', res => { t0 = Date.now(); log('##', `handshake ${res.statusCode}`); });
ws.on('open', () => { t0 = Date.now(); log('##', 'socket open'); send(INITIAL_SESSION_UPDATE); });

ws.on('message', raw => {
  let e;
  const text = raw.toString();
  try { e = JSON.parse(text); } catch { log('<-', `NON-JSON ${trunc(text, 200)}`); return; }
  const type = e.type;
  const rid = e.response?.id ?? e.response_id ?? null;
  const head = `${type} event_id=${e.event_id ?? '-'} response_id=${rid ?? '-'} item_id=${e.item_id ?? '-'}`;

  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const bytes = typeof e.delta === 'string' ? Buffer.from(e.delta, 'base64').length : 0;
    const a = acct(rid ?? '(no-id)');
    if (a.firstAudioMs === null) a.firstAudioMs = ms();
    a.lastAudioMs = ms();
    a.audioBytes += bytes;
    a.audioDeltas += 1;
    if (markAtMs !== null) a.bytesAfterMark += bytes;
    log('<-', `${head} audioBytes=${bytes} total=${a.audioBytes}${markLabel ? ` afterMark(${markLabel})=${a.bytesAfterMark}` : ''}`);
    return;
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
    const a = acct(rid ?? '(no-id)');
    a.transcript += String(e.delta ?? '');
    log('<-', `${head} transcriptDelta=${JSON.stringify(String(e.delta ?? ''))}`);
    return;
  }
  if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
    log('<-', `${head} transcriptDone=${JSON.stringify(String(e.transcript ?? ''))}`);
    return;
  }
  if (type === 'response.created') {
    const a = acct(rid ?? '(no-id)');
    a.createdMs = ms();
    a.sinceSessionUpdated = sessionUpdatedMs === null ? null : a.createdMs - sessionUpdatedMs;
    log('<-', `${head} status=${e.response?.status ?? '-'} sinceSessionUpdated=${a.sinceSessionUpdated}ms FULL=${trunc(JSON.stringify(e), 600)}`);
    onResponseCreated(rid);
    return;
  }
  if (type === 'response.done') {
    const a = acct(rid ?? '(no-id)');
    a.doneMs = ms();
    a.doneStatus = e.response?.status ?? null;
    a.doneDetails = e.response?.status_details ?? null;
    for (const out of e.response?.output ?? []) {
      for (const c of out.content ?? []) if (c.transcript) a.doneTranscripts.push(c.transcript);
    }
    log('<-', `${head} status=${a.doneStatus} FULL=${trunc(JSON.stringify(e), 2000)}`);
    onResponseDone(rid, a.doneStatus);
    return;
  }
  if (type === 'error') { log('<-', `${head} ERROR FULL=${trunc(JSON.stringify(e), 1500)}`); return; }
  if (type === 'session.updated') {
    sessionUpdatedCount += 1;
    if (sessionUpdatedMs === null) sessionUpdatedMs = ms();
    log('<-', `${head} n=${sessionUpdatedCount} FULL=${trunc(JSON.stringify(e), 900)}`);
    if (sessionUpdatedCount === 1) send(TRANSCRIPTION_UPDATE, '(requestInputTranscription)');
    return;
  }
  log('<-', `${head} ${trunc(JSON.stringify(e), 300)}`);
});

function onResponseCreated(rid) {
  if (!rid || openerId) return;
  openerId = rid;
  log('##', `opener response.created id=${openerId}`);
  if (SCENARIO === 'S2') {
    after(1500, () => { mark('greet'); log('##', 'sending greeting 1500ms after opener response.created'); send(GREET_CREATE); });
  }
  if (SCENARIO === 'S4' || SCENARIO === 'S5' || SCENARIO === 'S6') {
    mark('cancel');
    log('##', 'sending response.cancel immediately at opener response.created');
    send({ type: 'response.cancel' });
    after(3000, () => {
      mark(SCENARIO === 'S5' ? 'instructed-create' : 'bare-create');
      log('##', `sending second create 3000ms after cancel (${SCENARIO})`);
      send(SCENARIO === 'S5' ? INSTRUCTED_CREATE : BARE_CREATE);
    });
  }
}

function onResponseDone(rid, status) {
  if (rid && openerId && rid === openerId && openerDoneAt === null) {
    openerDoneAt = ms();
    log('##', `opener response.done status=${status}`);
    if (SCENARIO === 'S3') {
      after(1000, () => { mark('greet'); log('##', 'sending greeting 1000ms after opener response.done'); send(GREET_CREATE); });
    }
  }
}

ws.on('error', error => { log('##', `SOCKET ERROR ${String(error?.message ?? error)}`); finish(1); });
ws.on('close', (code, reason) => { log('##', `socket close code=${code} reason=${trunc(String(reason ?? ''), 120)}`); finish(0); });

after(22_000, () => { log('##', 'hard cap 22s reached, closing'); try { ws.close(); } catch { /* already gone */ } after(2_000, () => finish(0)); });
setTimeout(() => { console.log('# failsafe exit'); process.exit(1); }, 30_000).unref();

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
  console.log(`session.updated(first) at +${sessionUpdatedMs}ms, count=${sessionUpdatedCount}`);
  console.log(`opener response id=${openerId ?? '(NONE — agent produced no spontaneous response within the window)'}`);
  for (const [id, a] of responses) {
    console.log(JSON.stringify({
      responseId: id,
      isOpener: id === openerId,
      createdMs: a.createdMs,
      createdAfterSessionUpdatedMs: a.sinceSessionUpdated ?? null,
      firstAudioMs: a.firstAudioMs,
      lastAudioMs: a.lastAudioMs,
      audioDeltas: a.audioDeltas,
      audioBytes: a.audioBytes,
      bytesAfterMark: a.bytesAfterMark,
      markLabel,
      markAtMs,
      doneMs: a.doneMs,
      doneStatus: a.doneStatus,
      doneDetails: a.doneDetails,
      transcriptDeltas: a.transcript,
      transcriptFromDone: a.doneTranscripts,
    }));
  }
  console.log('===== END SUMMARY =====');
}
