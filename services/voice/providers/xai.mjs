import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { backpressureCheck } from './backpressure.mjs';

const MAX_PROVIDER_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PCM_BYTES_PER_APPEND = 32_000;
const MAX_BEST_EFFORT_IDS = 20;
const BEST_EFFORT_WINDOW_MS = 5_000;
// Providers disagree about optional session fields; a refusal of an optional
// extra must never kill a live call, but it must stop excusing later errors.
const BEST_EFFORT_REJECTION = /unimplemented|unsupported|not supported|unknown (field|parameter)|invalid_?value/i;
const bestEffortIds = event => [event.event_id, event.error?.event_id].filter(id => typeof id === 'string');

/**
 * S27（2026-09-12 真实探针）: model mode only. In **agent** mode this field REPLACES the Space
 * agent's own prompt — probe S6 (identical to S4 except `instructions` is omitted) keeps the
 * configured persona, while S1/S2/S4/S5 make the agent introduce itself as「我是AI助理」/「Grok」,
 * which is exactly what real calls said today (「我这边是AI助理」「我其实没有实体办公室」). No env key
 * supplies instructions (`XAI_ENV_KEYS`, and `infra/deploy-voice-relay-secondary.py`'s key gates), so agent
 * mode leaves the field out of `session.update` entirely and the Space agent keeps its own prompt.
 */
const MODEL_INSTRUCTIONS = '请用中文简洁接听电话，说明你是AI助理。';

/**
 * S27（2026-09-12 真实探针）: bounds on the agent-mode opener hold (see `greet()`). The real opener
 * is 316,668 bytes in 10 deltas, so both bounds are far out of reach; they exist so a provider that
 * never stops talking cannot grow this buffer without limit inside the provider thread's 48 MB
 * old-space cap. The byte bound is deliberately BELOW `GenerationPlaybackQueue`'s 1,920,000-byte
 * ceiling (3000 × 640 B, audio-bridge.mjs), so a hold released in one burst can never overflow the
 * playback queue — releasing is never allowed to become a new way to drop audio.
 */
const MAX_OPENER_HOLD_BYTES = 1024 * 1024;
const MAX_OPENER_HOLD_EVENTS = 200;
/** Cancelled-on-sight responses whose events are dropped; bounded like `cancelledResponses`. */
const MAX_STRAY_RESPONSES = 20;

/**
 * S27 决策 13（2026-09-12 真实探针 /tmp/xai-tool-probe-T1.log:18）: the Space agent's OWN baseline
 * `session.updated` carries `turn_detection: {type:'server_vad', idle_timeout_ms:5000,
 * end_call_after_idle_reminder_count:2}`. Our `session.update` REPLACES that object wholesale, so
 * sending only `{type:'server_vad', …}` silently deletes the agent's idle handling — the「超过 15 秒
 * 不说话就挂断」rule its own prompt promises. Agent mode therefore re-sends both fields verbatim;
 * the same probe shows unknown fields are accepted and echoed back. Model mode has no Space agent
 * behind it and stays byte-for-byte what production already runs.
 */
const AGENT_IDLE_TIMEOUT_MS = 5_000;
const AGENT_END_CALL_AFTER_IDLE_REMINDER_COUNT = 2;

/**
 * S27 决策 14（2026-09-12 in-image A/B on relay-secondary）: how long before `triggerAt` the worker may open
 * this session. A Space-agent session that receives no uplink audio does not survive a prewarm: the
 * idle turn fires at ~17 s and, now that the agent's own `end_call` tool is back, hangs up instead
 * of speaking, and xAI closes the WebSocket. The unmodified `tools: []` image died the same way at
 * ~20 s, so this is the provider's rule and not something this change introduced — but a claim may
 * prewarm up to 30 s before `timeout_ai`, so the session must not be opened at claim time. 8 s sits
 * comfortably inside that ~17 s budget and still leaves room for the handshake plus the
 * `session.updated` round trip (1.6–1.9 s measured in-image). Model mode has no Space agent and no
 * such idle rule, so it carries no lead and keeps opening at claim time.
 */
const AGENT_PREWARM_LEAD_MS = 8_000;

/**
 * S27 决策 16（2026-09-12 in-image probe）: the caller's short Chinese kept coming back from xAI's
 * transcription as English —「Billing.」「Uh, just a second」「It's」「Bye-bye.」— because nothing on the
 * wire ever said what language the caller speaks. The probe sent `language` beside the model in
 * both shapes the adapter already uses and xAI echoed it back unchanged
 * (`input_audio_transcription {"model":"whisper-1","language":"zh"}`, same nested under
 * `audio.input.transcription`) with no `error` event, so the hint is accepted.
 *
 * Agent mode defaults to `zh` because that is the language every production call is in; model mode
 * has no deployed caller and keeps today's payload. `XAI_TRANSCRIPTION_LANGUAGE` overrides it in
 * either mode, and setting the key to an empty value removes the hint entirely. The update carrying
 * it is the tagged best-effort one, so a provider that later stops accepting it makes a notice, not
 * a failed call.
 */
const AGENT_TRANSCRIPTION_LANGUAGE = 'zh';
const TRANSCRIPTION_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/**
 * S23 决策 4: builds the `turn_detection` object for the initial session.update. With nothing
 * configured it is byte-for-byte the `{type:'server_vad'}` the provider has always accepted.
 * The values come from startup configuration and are re-checked here so a programmatic caller
 * cannot put a malformed number on the wire; `0` is a legitimate value for both millisecond
 * fields and for the threshold, so presence is tested, never truthiness.
 * S27 决策 13: `agentMode` appends the Space agent's own two idle fields (see the constants above).
 */
function turnDetection({ vadThreshold, vadPrefixMs, vadSilenceMs, agentMode = false } = {}) {
  const bounded = (value, name, max, integer) => {
    if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    type: 'server_vad',
    ...(vadThreshold === undefined ? {} : { threshold: bounded(vadThreshold, 'VAD threshold', 1, false) }),
    ...(vadPrefixMs === undefined ? {} : { prefix_padding_ms: bounded(vadPrefixMs, 'VAD prefix padding', 5_000, true) }),
    ...(vadSilenceMs === undefined ? {} : { silence_duration_ms: bounded(vadSilenceMs, 'VAD silence duration', 5_000, true) }),
    ...(agentMode ? { idle_timeout_ms: AGENT_IDLE_TIMEOUT_MS, end_call_after_idle_reminder_count: AGENT_END_CALL_AFTER_IDLE_REMINDER_COUNT } : {}),
  };
}

/** The provider hostname is fixed: it is what the TLS certificate is checked against. */
const XAI_HOST = 'api.x.ai';
const REALTIME_PORT_ERROR = 'XAI_REALTIME_PORT must be an integer between 1 and 65535';

/**
 * S25 决策 6: re-checked here, not only at startup, so a programmatic caller cannot put a
 * malformed port on the wire — that would silently open the TLS session to another endpoint.
 */
function checkedPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(REALTIME_PORT_ERROR);
  return value;
}

/**
 * S25 决策 6: on relay-secondary the container resolves `api.x.ai` to loopback (`--add-host`), where the
 * sing-box tunnel (`vodog-voice-tunnel`) listens on 16890 and carries the TCP stream through
 * relay-primary to the real api.x.ai:443 (TLS stays end-to-end). Only the *port* moves:
 * the hostname stays `api.x.ai`, which is what `ws` uses for SNI and certificate verification
 * (see the S25 section of README.md), so validation stays strict and is never disabled.
 * With `realtimePort` unset the URL is byte-for-byte the one production already uses.
 */
export function xaiRealtimeUrl({ agentId, model, realtimePort } = {}) {
  if (agentId && model) throw new Error('Configure either an xAI Space agent or a realtime model, not both');
  if (agentId && !/^[A-Za-z0-9._-]{1,128}$/.test(agentId)) throw new Error('Invalid xAI agentId');
  if (model && !/^[A-Za-z0-9._-]{1,128}$/.test(model)) throw new Error('Invalid xAI model');
  const authority = realtimePort === undefined ? XAI_HOST : `${XAI_HOST}:${checkedPort(realtimePort)}`;
  if (agentId) return `wss://${authority}/v1/realtime?agent_id=${encodeURIComponent(agentId)}`;
  if (model) return `wss://${authority}/v1/realtime?model=${encodeURIComponent(model)}`;
  throw new Error('An xAI agentId or pinned model is required');
}

/**
 * Transport adapter only. Cellular answering and recording ownership belong to
 * Control and the gateway. Space agents use agent_id; public realtime models use
 * model. They are deliberately separate startup configurations.
 */
export class XaiVoiceAgent extends EventEmitter {
  constructor({
    apiKey,
    agentId,
    model,
    voice,
    // S27: undefined in agent mode (see MODEL_INSTRUCTIONS) unless a caller explicitly supplies one.
    instructions,
    // S22 决策 3: an instruction, never a script. The Space agent owns its own opener; hard-coding
    // one here is what made every production call start with the provider's default greeting.
    // S27: model mode only — agent mode never sends a `response.create` (see `greet()`).
    greeting = '通话已接通，请用你的开场白问候来电者',
    transcriptionModel = 'whisper-1',
    // S27 决策 16: optional caller-language hint (see AGENT_TRANSCRIPTION_LANGUAGE). Undefined
    // leaves `requestInputTranscription()`'s payload byte-for-byte what it has always sent.
    transcriptionLanguage,
    // S23 决策 4: xAI's Voice Agent API is OpenAI Realtime compatible, so `turn_detection` takes
    // `threshold`, `prefix_padding_ms` and `silence_duration_ms` beside `type` (xAI defaults
    // 0.5 / 300 / 200). All three are undefined unless configured, and an undefined one is left
    // out of the payload entirely so the provider keeps applying its own default.
    vadThreshold,
    vadPrefixMs,
    vadSilenceMs,
    // S25 决策 6: only set when xAI is reached through relay-primary's forwarder; see `xaiRealtimeUrl`.
    realtimePort,
    socketFactory = (url, options) => new WebSocket(url, options),
  }) {
    super();
    if (transcriptionLanguage !== undefined && !TRANSCRIPTION_LANGUAGE_PATTERN.test(String(transcriptionLanguage))) throw new Error('Invalid xAI transcription language');
    Object.assign(this, { apiKey, agentId, model, voice, greeting, transcriptionModel, transcriptionLanguage, realtimePort, socketFactory });
    // Omitted from the payload when undefined, which is what agent mode leaves it at.
    this.instructions = instructions ?? (agentId ? undefined : MODEL_INSTRUCTIONS);
    this.turnDetection = turnDetection({ vadThreshold, vadPrefixMs, vadSilenceMs, agentMode: Boolean(agentId) });
    this.state = 'idle';
    this.sequence = -1;
    this.outputGeneration = 0;
    this.cancelledResponses = new Set();
    this.responseGenerations = new Map();
    this.closedEmitted = false;
    this.bestEffortEventIds = new Set();
    this.greeted = false;
    this.pendingGreetResponse = false;
    // S27（2026-09-12 真实探针）: agent-mode opener hold-and-release; the rationale is in `greet()`.
    // Model mode never holds, so it starts already released.
    this.openerResponseId = undefined;
    this.openerHeld = [];
    this.openerHeldBytes = 0;
    this.openerReleased = !agentId;
    this.openerHoldOverflowed = false;
    this.strayResponses = new Set();
    // S27 决策 13（2026-09-12 探针 T1）：Space agent 调用过它自己的 `end_call` 工具。此后服务端注入
    // `function_call_output {"status":"ending_call"}` 并在约 1.5 s 后关掉 WebSocket，而道别的最后
    // 约 1 秒还排在播放队列里——`stop()` 与 `closed` 都要按"这是预期的收尾"处理。
    this.endCallRequested = false;
    // S27（2026-09-12 真实来电修正）：一段上行拥塞的起点与"已通知过"，判据见 backpressure.mjs。
    this.backpressureSinceMs = undefined;
    this.backpressureNotified = false;
    this.droppedAppends = 0;
  }

  async start({ signal } = {}) {
    if (this.state !== 'idle') throw new Error('Agent already started');
    if (!this.apiKey) throw new Error('AI is not configured');
    const url = xaiRealtimeUrl(this);
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      this.rejectSetup = reject;
      const abort = () => this.stop(signal.reason instanceof Error ? signal.reason : new Error('AI setup aborted'));
      if (signal?.aborted) {
        this.state = 'closed';
        this.rejectSetup = undefined;
        reject(signal.reason instanceof Error ? signal.reason : new Error('AI setup aborted'));
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.removeAbortListener = () => signal?.removeEventListener('abort', abort);
      let ws;
      try {
        ws = this.socketFactory(url, {
          // Node appends `:port` to the Host header whenever the port is not the scheme default,
          // so a forwarded connection would announce `Host: api.x.ai:16890` to xAI's own edge —
          // a value no direct client ever sends. Pin it to the hostname instead. Unset port keeps
          // the header block exactly `{Authorization}`, which is what production sends today.
          headers: { Authorization: `Bearer ${this.apiKey}`, ...(this.realtimePort === undefined ? {} : { Host: XAI_HOST }) },
          handshakeTimeout: 12_000,
          maxPayload: MAX_PROVIDER_MESSAGE_BYTES,
        });
        this.socket = ws;
      } catch (error) {
        this.state = 'closed';
        this.rejectSetup = undefined;
        this.removeAbortListener?.();
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error('AI setup timeout'));
        this.stop();
      }, 15_000);
      this.setupTimer = timer;
      ws.on('open', () => {
        if (this.state !== 'connecting') return;
        try {
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              ...(this.voice ? { voice: this.voice } : {}),
              // S27: present in model mode, absent in agent mode — sending it there replaces the
              // Space agent's own prompt (see MODEL_INSTRUCTIONS).
              ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
              turn_detection: this.turnDetection,
              // S27 决策 13（2026-09-12 探针 T1）: agent mode sends NO `tools` key at all. The Space
              // agent declares its own `end_call` server-side (probe echo[1]), and `tools: []`
              // replaces that list with an empty one — the agent then has no way to hang up and
              // every call ran to a timer. Model mode has no such list to protect and keeps
              // `tools: []` byte-for-byte.
              ...(this.agentId ? {} : { tools: [] }),
              audio: {
                input: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
                output: { format: { type: 'audio/pcm', rate: 16_000 }, transport: 'json' },
              },
            },
          }));
        } catch (error) {
          this.emit('fault', error);
          this.stop();
        }
      });
      ws.on('message', raw => this.onProviderMessage(raw, resolve, reject));
      ws.on('error', error => {
        if (this.state === 'closed') return;
        clearTimeout(timer);
        reject(error);
        // S27 决策 15（真实通话 c3734597，2026-09-12 13:55 UTC）: after the agent's own `end_call`
        // xAI drops the socket, and `ws` reports that teardown as an `error` **before** `close`.
        // Raising a fault there made the worker `stop('provider_failed')`, which tore the bridge
        // down while the drain was still running — generation 2 `clearedBytes` 27840, i.e. 0.87 s
        // of the goodbye the caller never heard, and the run was filed as a provider failure.
        // An expected end is not a fault: stop quietly and let `close` emit `ended_by_provider`.
        if (!this.endCallRequested) this.emit('fault', error);
        this.stop();
      });
      ws.on('close', code => {
        clearTimeout(timer);
        this.stop();
        if (!this.closedEmitted) {
          this.closedEmitted = true;
          // S27 决策 13: `closed` always carries an object. `{}` is an ordinary close (the worker
          // still reports `provider_disconnected`); after the agent's own `end_call` this close is
          // the expected end of the call and the worker must let the goodbye finish playing.
          // S69: the numeric close code only (never the close reason text) for `provider_disconnected`.
          this.emit('closed', { ...(this.endCallRequested ? { reason: 'ended_by_provider' } : {}), ...(Number.isInteger(code) ? { closeCode: code } : {}) });
        }
      });
    });
  }

  onProviderMessage(raw, resolve, reject) {
    if (this.state === 'closed') return;
    if (Buffer.byteLength(raw) > MAX_PROVIDER_MESSAGE_BYTES) {
      this.emit('fault', new Error('Provider message exceeded limit'));
      this.stop();
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch {
      this.emit('fault', new Error('Invalid provider JSON'));
      this.stop();
      return;
    }
    if (event.type === 'session.updated') {
      // An acknowledged update ends the best-effort window: a later error is fatal again.
      if (this.state !== 'connecting') { this.forgetBestEffort(); return; }
      clearTimeout(this.setupTimer);
      this.rejectSetup = undefined;
      this.state = 'ready';
      resolve({ mode: this.agentId ? 'space-agent' : 'model', model: this.model ?? null });
      this.requestInputTranscription();
    }
    if (event.type === 'response.created') {
      const responseId = event.response?.id;
      if (typeof responseId === 'string' && responseId.length <= 256) {
        if (!this.openerReleased) {
          // Agent mode, before `greet()` releases: the FIRST response is the Space agent's opener
          // and its audio/transcript are held, not dropped (probe S1 — it starts 0–1 ms after the
          // first `session.updated` and its transcript is exactly the greeting we want).
          // Any OTHER response here is the idle-timeout turn: with no uplink audio xAI commits an
          // empty user item at ~15 s and the agent says「抱歉，我无法接听电话…」(probe S1/S2). Cancel
          // it on sight and drop everything it produces, so it never advances a playback
          // generation and never reaches the transcript.
          if (this.openerResponseId === undefined) this.openerResponseId = responseId;
          else if (responseId !== this.openerResponseId) { this.cancelStrayResponse(responseId); return; }
        }
        // Model mode: the first response created after greet() is the greeting. Everything the
        // session started saying on its own before it belongs to the muted pre-activation session:
        // fence it here, or the caller hears the provider's opener and ours back to back.
        // (Agent mode never arms this: `greet()` sends no `response.create` there.)
        if (this.pendingGreetResponse) {
          this.pendingGreetResponse = false;
          if (responseId !== this.responseId) this.interrupt({ sendCancel: false });
        }
        this.responseId = responseId;
        this.responseGenerations.set(responseId, this.outputGeneration);
        if (this.responseGenerations.size > 100) this.responseGenerations.delete(this.responseGenerations.keys().next().value);
        this.emit('response', responseId);
      }
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      // xAI server VAD cancels its response automatically. Locally advance the
      // playback generation immediately; a manual response.cancel here can race
      // the provider's automatic cancellation and produce a recoverable error.
      this.interrupt({ sendCancel: false });
      this.emit('speechStarted');
    }
    if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') {
      const responseId = event.response_id;
      if (typeof event.delta !== 'string' || event.delta.length > MAX_PROVIDER_MESSAGE_BYTES * 2) return;
      if (responseId && this.strayResponses.has(responseId)) return;
      if (responseId && this.cancelledResponses.has(responseId)) return;
      // Held instead of played: the audio gate is still closed, and these bytes are the start of
      // the one opening line the caller must hear (see `greet()`). The generation is assigned at
      // release, never here, because the bridge may have advanced it in the meantime.
      if (this.holdsOpener(responseId)) { this.holdOpenerEvent({ kind: 'audio', pcm: Buffer.from(event.delta, 'base64') }); return; }
      // JSON transport is intentional: every playable delta must carry the
      // response identity needed by the local barge-in generation fence.
      const generation = responseId ? this.responseGenerations.get(responseId) : undefined;
      if (generation !== this.outputGeneration || this.state !== 'ready') return;
      this.emit('audio', { pcm: Buffer.from(event.delta, 'base64'), sampleRate: 16_000, responseId, generation });
    }
    if (event.type === 'response.output_audio_transcript.delta' || event.type === 'response.audio_transcript.delta') {
      const responseId = event.response_id;
      if (typeof event.delta !== 'string' || (responseId && this.strayResponses.has(responseId))) return;
      const payload = { text: event.delta.slice(0, 16_384), final: false, responseId };
      // The collector stamps `at` when it receives the first delta of a response, so a held
      // opener is timestamped at release — which is when the caller actually hears it.
      // `response.output_audio_transcript.done` needs no case of its own here: this adapter has
      // never emitted anything for it (the collector assembles the deltas), so holding it is
      // vacuous and adding a handler would duplicate the whole sentence into the transcript.
      if (this.holdsOpener(responseId)) { this.holdOpenerEvent({ kind: 'transcript', payload }); return; }
      this.emit('transcript', payload);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.emit('transcript', { text: String(event.transcript ?? '').slice(0, 16_384), final: true, speaker: 'caller' });
    }
    if (event.type === 'conversation.item.input_audio_transcription.updated') {
      this.emit('transcript', { text: String(event.transcript ?? '').slice(0, 16_384), final: false, cumulative: true, speaker: 'caller' });
    }
    if (event.type === 'response.done') {
      const responseId = event.response?.id;
      if (responseId && this.strayResponses.has(responseId)) return;
      const payload = { status: event.response?.status, responseId,
        current: Boolean(responseId && responseId === this.responseId && !this.cancelledResponses.has(responseId)) };
      if (this.holdsOpener(responseId)) {
        // `current` is the wire truth at arrival; only the generation is decided at release.
        this.holdOpenerEvent({ kind: 'completed', payload });
        if (responseId === this.responseId) this.responseId = undefined;
        return;
      }
      this.emit('completed', { ...payload, generation: this.responseGenerations.get(responseId) });
      if (!responseId || responseId === this.responseId) this.responseId = undefined;
    }
    if (event.type === 'response.function_call_arguments.done') {
      // S27 决策 13（2026-09-12 探针 T1）: the Space agent's own `end_call`. The wire shape is flat —
      // top-level `name` / `call_id` / `arguments` / `item_id` / `response_id` — and it arrives in
      // the SAME response as the spoken goodbye. The same call is also carried by
      // `response.function_call_arguments.delta`, `response.output_item.added/done` and
      // `conversation.item.added`; none of those has a handler here, so they are ignored and this
      // one event is the single trigger. The server injects its own
      // `function_call_output {"status":"ending_call"}` and closes the socket ~1.5 s later, so we
      // send neither a `function_call_output` (redundant) nor a `response.create` (it would make
      // the agent say one more thing after the goodbye).
      const responseId = typeof event.response_id === 'string' ? event.response_id : undefined;
      // A cancelled-on-sight idle turn calls `end_call` too — its prompt says so — and that turn's
      // output is dropped whole. A prewarming run that was never answered must not be reported as
      // "the AI said goodbye".
      if (responseId && this.strayResponses.has(responseId)) return;
      if (event.name === 'end_call' && !this.endCallRequested) {
        this.endCallRequested = true;
        this.emit('notice', { kind: 'end_call' });
      }
    }
    if (event.type === 'error') {
      const message = String(event.error?.message ?? 'AI provider error').slice(0, 500);
      // Setup errors stay fatal; only a rejected optional extra is swallowed.
      if (this.state === 'ready' && this.isBestEffortRejection(event, message)) {
        for (const id of bestEffortIds(event)) this.bestEffortEventIds.delete(id);
        this.emit('notice', { kind: 'best_effort_rejected', message });
        return;
      }
      const error = new Error(message);
      clearTimeout(this.setupTimer);
      reject(error);
      this.emit('fault', error);
      this.stop();
    }
  }

  /** Tags one optional client event so that its refusal becomes a notice, not a fault. */
  tagBestEffort(kind) {
    const id = `cc-${kind}-${randomUUID()}`;
    this.bestEffortEventIds.add(id);
    while (this.bestEffortEventIds.size > MAX_BEST_EFFORT_IDS) this.bestEffortEventIds.delete(this.bestEffortEventIds.values().next().value);
    clearTimeout(this.bestEffortTimer);
    this.bestEffortTimer = setTimeout(() => this.bestEffortEventIds.clear(), BEST_EFFORT_WINDOW_MS);
    this.bestEffortTimer.unref?.();
    return id;
  }

  /** Optional session extras are tagged so their refusal cannot end a live call. */
  requestInputTranscription() {
    if (this.state !== 'ready') return;
    const id = this.tagBestEffort('transcription');
    // S27 决策 16: the caller-language hint rides this same update, in both shapes, exactly as the
    // in-image probe sent it. Absent unless configured (see AGENT_TRANSCRIPTION_LANGUAGE).
    const transcription = { model: this.transcriptionModel, ...(this.transcriptionLanguage ? { language: this.transcriptionLanguage } : {}) };
    try {
      // Nested and flat keys: providers accept one or the other and ignore the rest.
      this.socket.send(JSON.stringify({
        type: 'session.update',
        event_id: id,
        session: {
          audio: { input: { transcription } },
          input_audio_transcription: transcription,
        },
      }));
    } catch (error) {
      this.bestEffortEventIds.delete(id);
      this.emit('notice', { kind: 'best_effort_failed', message: String(error?.message ?? error).slice(0, 500) });
    }
  }

  isBestEffortRejection(event, message) {
    // Providers echo the client event ID either at the top level or inside error.
    if (bestEffortIds(event).some(id => this.bestEffortEventIds.has(id))) return true;
    if (!this.bestEffortEventIds.size || event.response_id || event.error?.response_id) return false;
    return BEST_EFFORT_REJECTION.test(`${event.error?.code ?? ''} ${message}`);
  }

  forgetBestEffort() {
    this.bestEffortEventIds.clear();
    clearTimeout(this.bestEffortTimer);
    this.bestEffortTimer = undefined;
  }

  /** True while this response's events belong to the opener being held (agent mode, pre-release). */
  holdsOpener(responseId) {
    return !this.openerReleased && Boolean(responseId) && responseId === this.openerResponseId;
  }

  /**
   * Buffers one opener event in wire order. The bounds only exist so that a provider which never
   * stops talking cannot grow this buffer without limit; the real opener is ~316 KB in 10 deltas,
   * so an overflow means something is wrong and is reported once, never as a fault.
   */
  holdOpenerEvent(item) {
    this.openerHeld.push(item);
    if (item.kind === 'audio') this.openerHeldBytes += item.pcm.length;
    let overflowed = false;
    while (this.openerHeld.length > MAX_OPENER_HOLD_EVENTS || this.openerHeldBytes > MAX_OPENER_HOLD_BYTES) {
      const oldest = this.openerHeld.shift();
      if (oldest?.kind === 'audio') this.openerHeldBytes -= oldest.pcm.length;
      overflowed = true;
    }
    if (overflowed && !this.openerHoldOverflowed) {
      this.openerHoldOverflowed = true;
      this.emit('notice', { kind: 'opener_hold_overflow' });
    }
  }

  /**
   * Plays out what was held and switches to pass-through for the rest of that response: activation
   * can land mid-opener, in which case the first half is released here and the live deltas that
   * follow are emitted normally.
   */
  releaseOpener() {
    this.openerReleased = true;
    const held = this.openerHeld;
    this.openerHeld = [];
    this.openerHeldBytes = 0;
    const responseId = this.openerResponseId;
    if (!responseId) return;
    // Re-tag before emitting anything: the opener was created in an earlier generation, and both
    // the released half and the live deltas that follow are fenced against `outputGeneration`.
    // They must carry the generation the bridge is playing now, or the second half is dropped.
    if (this.responseGenerations.has(responseId)) this.responseGenerations.set(responseId, this.outputGeneration);
    // A barge-in (or a stop) already cut this response: releasing it now would play audio the
    // caller talked over.
    if (this.cancelledResponses.has(responseId)) return;
    for (const item of held) {
      if (item.kind === 'audio') this.emit('audio', { pcm: item.pcm, sampleRate: 16_000, responseId, generation: this.outputGeneration });
      else if (item.kind === 'transcript') this.emit('transcript', item.payload);
      else this.emit('completed', { ...item.payload, generation: this.responseGenerations.get(responseId) });
    }
  }

  /**
   * Probe S4/S6 (2026-09-12): a bare `response.cancel` sent at a response's `response.created` ends
   * it cleanly — `response.done status=cancelled`, zero audio bytes, ~300 ms, and no `error` event.
   * Deliberately untagged, like `interrupt()`'s: the probes never saw the provider answer it.
   */
  cancelStrayResponse(responseId) {
    this.strayResponses.add(responseId);
    while (this.strayResponses.size > MAX_STRAY_RESPONSES) this.strayResponses.delete(this.strayResponses.values().next().value);
    try { this.socket.send(JSON.stringify({ type: 'response.cancel' })); }
    catch (error) { this.emit('notice', { kind: 'stray_cancel_failed', message: String(error?.message ?? error).slice(0, 500) }); }
  }

  /**
   * At most one opening line, and never before Control opens the audio gate.
   *
   * **Agent mode (production).** The Space agent starts an opener of its own 0–1 ms after the first
   * `session.updated`, long before Control may open that gate, and probe S1 (2026-09-12, real Space
   * agent) showed that opener IS the greeting we want:「您好！我是 VoDog AI 助理，代用户接听电话…」, 316 KB /
   * 9.9 s of PCM16 delivered within ~2.75 s. It is therefore held from its `response.created` and
   * released here, so the caller hears it from the first sample and its transcript is recorded.
   *
   * No `response.create` is sent in this mode. The comment that used to stand here — "the provider
   * cancels its in-flight response when a new response.create arrives (S21 xai-smoke)" — was false:
   * probes S2 and S3 showed a `response.create` sent while the opener is in flight, or after it
   * completed, is SILENTLY DROPPED (no error, no `response.created`, nothing), so `greet()` has been
   * a no-op on the wire in every real call. Cancelling first and creating afterwards does produce a
   * response (S4/S5), but a persona-driven ad-lib rather than the configured opener, so that path is
   * not wanted either.
   *
   * **Model mode.** Unchanged S21 behaviour: one tagged `response.create` carrying the greeting
   * instruction, with no manual cancel, and the fence at its `response.created` discarding whatever
   * the session had started on its own. Fencing waits for the provider to actually start the
   * greeting: if the request is refused, the session's own opener keeps playing instead of leaving
   * the caller in silence.
   */
  greet() {
    if (this.greeted || this.state !== 'ready') return false;
    if (this.agentId) {
      this.greeted = true;
      this.releaseOpener();
      return true;
    }
    try {
      this.socket.send(JSON.stringify({ type: 'response.create', event_id: this.tagBestEffort('greeting'), response: { instructions: this.greeting } }));
      this.greeted = true;
      this.pendingGreetResponse = true;
      return true;
    } catch (error) {
      this.emit('notice', { kind: 'greeting_failed', message: String(error?.message ?? error).slice(0, 500) });
      return false;
    }
  }

  /**
   * S27（2026-09-12 真实来电修正）：上行背压是软条件，判据与三个阈值来自 backpressure.mjs，
   * 与豆包共用一份——同名的 `provider_notice` 必须在两条链路上代表同一件事。
   *
   * 这里没有节拍器：每次 `appendAudio` 直接发，上行是恒定速率（约每 100 ms 一批），所以
   * "持续多久"就用相邻两次 `appendAudio` 之间的墙钟量，不额外挂定时器（多一个定时器就是多一处
   * 通话结束后还在跑的东西）。软线以上这一批直接丢掉、不发也不抛：`sequence` 照样推进，
   * 因为它是防重放的单调计数器，不是"发出去了几批"；抛异常会被 audio-bridge.mjs:84 的 try/catch
   * 变成 fault，那正是这次要去掉的行为——旧规则就是这样在第 34 秒掐断了一通正常通话（失败记录 4）。
   * xAI 这条链路跨境走 sing-box 隧道，暴露程度只会更高。
   */
  appendAudio(pcm, { sampleRate = 16_000, sequence } = {}) {
    if (this.state !== 'ready') throw new Error('AI not ready');
    if (sampleRate !== 16_000 || pcm.length % 2 || pcm.length > MAX_PCM_BYTES_PER_APPEND) throw new Error('Expected at most one second of PCM16 mono at 16 kHz');
    if (!Number.isInteger(sequence) || sequence <= this.sequence) throw new Error('Audio sequence must increase');
    this.sequence = sequence;
    const pressure = backpressureCheck({ bufferedAmount: this.socket.bufferedAmount, now: Date.now(), sinceMs: this.backpressureSinceMs, notified: this.backpressureNotified });
    if (pressure.action !== 'send') {
      this.backpressureSinceMs = pressure.sinceMs;
      // 只在进程内计数：`run_closed` 只摊开 bridge.stats()，而线上 worker 拿到的是
      // ThreadedVoiceAgent 代理，适配器自己的字段过不了 MessagePort（豆包的 droppedPackets 同样
      // 没有出口）。丢包在日志里的可见信号是 `provider_notice` 那几条。
      this.droppedAppends++;
      if (pressure.notify) { this.backpressureNotified = true; this.emit('notice', { kind: 'input_backpressure' }); }
      if (pressure.action === 'fatal') {
        this.emit('notice', { kind: 'input_backpressure_fatal' });
        this.emit('fault', new Error('AI audio backpressure'));
        this.stop();
      }
      return;
    }
    if (pressure.cleared) {
      this.backpressureSinceMs = undefined;
      this.backpressureNotified = false;
      this.emit('notice', { kind: 'input_backpressure_cleared' });
    }
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
  }

  interrupt({ sendCancel = true } = {}) {
    const responseId = this.responseId;
    if (responseId) {
      this.cancelledResponses.add(responseId);
      if (this.cancelledResponses.size > 100) this.cancelledResponses.delete(this.cancelledResponses.values().next().value);
      if (sendCancel && this.state === 'ready') this.socket.send(JSON.stringify({ type: 'response.cancel' }));
    }
    this.outputGeneration++;
    this.emit('flushAudio', { generation: this.outputGeneration });
  }

  stop(reason = new Error('AI stopped during setup')) {
    if (this.state === 'closed') return;
    clearTimeout(this.setupTimer);
    this.forgetBestEffort();
    // A run that ends before the audio gate opened takes the held opener with it: nothing may be
    // emitted after `stop()`, and the buffer must not outlive the session inside the thread.
    this.openerHeld = [];
    this.openerHeldBytes = 0;
    this.state = 'closed';
    this.rejectSetup?.(reason instanceof Error ? reason : new Error('AI stopped during setup'));
    this.rejectSetup = undefined;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    // S27 决策 13: after the agent's own `end_call` the server closes the socket ~1.5 s later while
    // the last second of the goodbye is still queued in the bridge. Advancing the generation here
    // means `GenerationPlaybackQueue.advanceGeneration()` → `clear()`, which is exactly the audio
    // the caller has not heard yet. The hangup is the worker's, after `whenPlaybackDrained()`.
    if (!this.endCallRequested) {
      this.outputGeneration++;
      this.emit('flushAudio', { generation: this.outputGeneration });
    }
    if (this.socket?.readyState === 1) this.socket.close();
    else this.socket?.terminate?.();
  }
}

/**
 * S23 决策 4: optional xAI server-VAD endpointing. Unset keys are left out of `session.update`
 * entirely, so the provider keeps its own defaults (threshold 0.5 / prefix 300 ms / silence 200 ms)
 * and the payload stays byte-for-byte what production already runs. A misconfigured endpointing
 * is worse than none, so a malformed value fails startup instead of being silently ignored.
 */
export function vadSettings(env = {}) {
  const fields = [
    ['VOICE_VAD_THRESHOLD', 'vadThreshold', /^\d+(?:\.\d+)?$/, 1],
    ['VOICE_VAD_PREFIX_MS', 'vadPrefixMs', /^\d{1,5}$/, 5_000],
    ['VOICE_VAD_SILENCE_MS', 'vadSilenceMs', /^\d{1,5}$/, 5_000],
  ];
  const settings = {};
  for (const [name, key, pattern, max] of fields) {
    const raw = env[name] === undefined || env[name] === null ? '' : String(env[name]).trim();
    if (raw === '') continue;
    // The pattern, not Number(), is what rejects '-1', '1e-1' and 'NaN' before the range check.
    const value = pattern.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value > max) throw new Error(`${name} must be a number between 0 and ${max}`);
    settings[key] = value;
  }
  return settings;
}

/**
 * S24 决策 3: the keys this provider reads, and nothing else. `availableProviders()` answers
 * "may this worker announce xai to Control" with presence only — a malformed value still has to
 * fail startup inside `xaiConfig`, never silently disable the provider.
 */
export const XAI_ENV_KEYS = Object.freeze(['XAI_API_KEY', 'XAI_AGENT_ID', 'XAI_REALTIME_MODEL', 'XAI_REALTIME_PORT', 'XAI_VOICE',
  'XAI_GREETING', 'XAI_TRANSCRIPTION_MODEL', 'XAI_TRANSCRIPTION_LANGUAGE', 'VOICE_VAD_THRESHOLD', 'VOICE_VAD_PREFIX_MS', 'VOICE_VAD_SILENCE_MS']);

/**
 * S27 决策 16: the caller-language hint. Unset means the agent-mode default; a key that is present
 * but empty means "send no hint at all", which is how it is switched off from the env file without
 * a code change. A malformed tag fails startup rather than being silently dropped.
 */
export function xaiTranscriptionLanguage(env = {}, { agentMode = false } = {}) {
  const configured = env.XAI_TRANSCRIPTION_LANGUAGE;
  if (configured === undefined || configured === null) return agentMode ? { transcriptionLanguage: AGENT_TRANSCRIPTION_LANGUAGE } : {};
  const raw = String(configured).trim();
  if (raw === '') return {};
  if (!TRANSCRIPTION_LANGUAGE_PATTERN.test(raw)) throw new Error('XAI_TRANSCRIPTION_LANGUAGE must be a language tag such as zh or zh-CN');
  return { transcriptionLanguage: raw };
}

/**
 * S25 决策 6: the optional forwarding port, parsed once at startup. Unset means "reach api.x.ai
 * directly on 443" and leaves the URL untouched. A malformed value fails the service instead of
 * being ignored: silently falling back to 443 on relay-secondary — which cannot reach api.x.ai at all —
 * would look like an outage with no configuration error anywhere in the logs. The regex is what
 * rejects `+443`, `443.0`, `0x1bb` and ` `; `Number()` alone would accept all of them.
 */
export function xaiRealtimePort(env = {}) {
  const raw = env.XAI_REALTIME_PORT === undefined || env.XAI_REALTIME_PORT === null ? '' : String(env.XAI_REALTIME_PORT).trim();
  if (raw === '') return {};
  if (!/^\d{1,5}$/.test(raw)) throw new Error(REALTIME_PORT_ERROR);
  return { realtimePort: checkedPort(Number.parseInt(raw, 10)) };
}

export function xaiConfigured(env = {}) {
  return Boolean(env.XAI_API_KEY) && Boolean(env.XAI_AGENT_ID || env.XAI_REALTIME_MODEL);
}

/**
 * Startup-time configuration for one xAI session, validated once. The returned object is plain
 * structured-cloneable data on purpose: it crosses the `worker_threads` boundary in `workerData`.
 */
export function xaiConfig(env = {}) {
  const config = {
    apiKey: env.XAI_API_KEY,
    agentId: env.XAI_AGENT_ID || undefined,
    model: env.XAI_REALTIME_MODEL || undefined,
    voice: env.XAI_VOICE || undefined,
    ...(env.XAI_GREETING ? { greeting: env.XAI_GREETING } : {}),
    ...(env.XAI_TRANSCRIPTION_MODEL ? { transcriptionModel: env.XAI_TRANSCRIPTION_MODEL } : {}),
    ...xaiTranscriptionLanguage(env, { agentMode: Boolean(env.XAI_AGENT_ID) }),
    ...xaiRealtimePort(env),
    ...vadSettings(env),
  };
  if (!config.apiKey) throw new Error('XAI_API_KEY is required');
  // S27 决策 14: read by the worker off `agent.config`, agent mode only (see AGENT_PREWARM_LEAD_MS).
  // The adapter itself never looks at it; it is startup data that rides into the provider thread.
  if (config.agentId) config.prewarmLeadMs = AGENT_PREWARM_LEAD_MS;
  // Fails startup on a malformed agent/model pair exactly as server.mjs used to.
  xaiRealtimeUrl(config);
  return config;
}
