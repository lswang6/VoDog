import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { ClientMediaPeer } from './webrtc-media.mjs';
import { RealtimeAudioBridge } from './audio-bridge.mjs';
import { TranscriptCollector } from './transcript-log.mjs';
import { PROVIDER_ID_PATTERN, providerUnavailable } from './providers/index.mjs';
import { ThreadedVoiceAgent } from './provider-proxy.mjs';

const terminal = new Set(['ended', 'failed_before_answer', 'lost_race', 'ending', 'reconcile_unknown']);
const wait = (ms, signal) => delay(Math.max(0, ms), undefined, { signal });
const fault = code => Object.assign(new Error(code), { code });
/** S69: the error's class and machine code only — never its message, which may carry provider text. */
const errorFields = error => ({ errorName: String(error?.name ?? 'Error').slice(0, 64), ...(error?.code != null ? { code: String(error.code).slice(0, 80) } : {}) });

/** S69: every JSON log line carries a level. A provider notice is judged by its kind. */
const ERROR_EVENTS = new Set(['socket_error', 'setup_timeout', 'worker_run_failed']);
const WARN_EVENTS = new Set(['control_unavailable', 'heartbeat_failed', 'lease_renew_failed', 'control_fail_report_failed', 'provider_disconnected', 'provider_fault',
  'media_fault', 'media_disconnected', 'greet_failed', 'provider_send_failed', 'revoked', 'worker_restart', 'message_too_large', 'invalid_json', 'message_handler_error',
  'session_create_send_failed', 'greeting_failed', 'transcription_failed', 'playback_overflow', 'input_backlog', 'input_backpressure', 'media_gap', 'media_gap_hangup']);
/** Run endings that are an ordinary call finishing; anything else is a failed run. */
const NORMAL_RUN_ENDS = new Set(['terminal', 'call_terminal', 'ai_ended_call', 'caller_silence_timeout', 'ai_max_call_seconds', 'worker_shutdown', 'run_finished']);
export function logLevel(record) {
  if (record?.level) return record.level;
  const name = String(record?.event === 'provider_notice' ? record?.kind : record?.event ?? '');
  if (name.endsWith('_fatal') || ERROR_EVENTS.has(name)) return 'error';
  if (name === 'run_closed') return record.reason === 'worker_run_failed' ? 'error' : NORMAL_RUN_ENDS.has(record.reason) ? 'info' : 'warn';
  return WARN_EVENTS.has(name) ? 'warn' : 'info';
}

/**
 * S69: `control_unavailable` once when a Control phase starts failing and `control_recovered` once
 * when it answers again — never a line per retry. Each phase keeps its own state so a heartbeat
 * that works cannot mark a still-failing claim as recovered (and flap).
 */
export function controlHealth(log, now = Date.now) {
  const down = new Map();
  return (phase, error) => {
    const state = down.get(phase);
    if (error) {
      if (state) { state.failures += 1; return; }
      down.set(phase, { failures: 1, since: now() });
      log({ event: 'control_unavailable', phase, ...errorFields(error), message: String(error?.message ?? '').slice(0, 200) });
    } else if (state) {
      down.delete(phase);
      log({ event: 'control_recovered', phase, failures: state.failures, outageMs: now() - state.since });
    }
  };
}
/**
 * S25 决策 8: the same terminal judgement the authority poll makes, plus `ending`. It is used only
 * when the media peer has already closed: the media bridge tears the worker's leg down while the
 * call is still `ending` in Control, so at that moment `ending` means "the call is over", not
 * "still running". The poll itself deliberately keeps its narrower test — an `ending` call that
 * still has audio authority is a call this worker keeps serving.
 */
const callEnded = state => terminal.has(state?.run?.state) || ['ended', 'failed', 'ending'].includes(state?.callState);

/**
 * S27 决策 14 (2026-09-12 in-image probes on relay-secondary): the end-of-call drain, handed to
 * `RealtimeAudioBridge.whenPlaybackDrained` — the rule itself, and why these three numbers, are
 * documented there. In short: `end_call` is the moment the provider decided to hang up, Doubao's
 * matching TTS arrives ~2.7 s later, and an unanswered `end_call` never completes the turn, so
 * "wait for an empty queue" ran to the 15 s bound and left the caller about six seconds of silence.
 */
const AI_END_DRAIN_MIN_MS = 3_000;
const AI_END_DRAIN_QUIET_MS = 1_500;
const AI_END_DRAIN_TIMEOUT_MS = 15_000;

/**
 * S27 决策 15（真实通话 3a271664，2026-09-12 13:56 UTC）: an empty playback queue is not the caller
 * having heard the goodbye. That run paced out every byte it received (played 610880 == received)
 * and still hung up on a sentence the user heard as clipped: the bridge only hands 10 ms frames to
 * the peer, and the gateway leg plus the Pixel's own playout buffer (up to ~64 × 10 ms on an AI
 * call) hold several hundred milliseconds more, while the hangup itself is immediate. Keep the
 * media path alive for one more second — the bridge streams silence through it, which is exactly
 * what lets those buffers play out.
 */
const AI_END_TAIL_MS = 1_000;

/**
 * S73f（AI 通话 ac245fbe，2026-09-26 15:38 UTC）: the bridge keeps the room for 60 s while the
 * gateway leg rejoins (S73 D2, media `defaultRejoinWindow`). A gap in caller RTP is therefore not a
 * silent caller: the silence timer is paused for the gap and the run only ends as `media_lost` once
 * no caller RTP has arrived for this long.
 */
export const MEDIA_GAP_HANGUP_MS = 60_000;

/** One process, one leased call. Control remains the only cellular authority. */
export class VoiceWorker {
  constructor({ control, wrtc, provider, defaultProvider = 'xai',
    // S24 决策 2/3: the provider session runs in its own thread, and S24 决策 3 lets the claim pick
    // which provider that is. A provider this worker cannot build is `provider_unavailable`.
    createAgent = ({ provider: id }) => new ThreadedVoiceAgent({ provider: id, config: provider }),
    connectPeer = options => ClientMediaPeer.connect({ wrtc, ...options }),
    createBridge = options => new RealtimeAudioBridge(options),
    createTranscripts = options => new TranscriptCollector(options),
    heartbeatMs = 5_000, renewMs = 3_000, pollMs = 250, idleMs = 1_000, leaseMarginMs = 1_000, activationTimeoutMs = 45_000, maxCallSeconds = 600, mediaTransport = 'udp',
    // S25 决策 8: how long the greeting waits for proof that the gateway's data channel is open
    // before it is sent anyway. A silent caller must still be greeted.
    // S70e: the fallback only fires when no RTP ever arrives (a silent caller still sends RTP, the
    // gateway streams the downlink continuously). 6 s clipped greetings when the gateway leg took
    // longer (S37 allows 45 s); aligned with that window.
    greetingWaitMs = 45_000,
    // S27 决策 15: how long the media path is kept alive after the playback queue drains, so the
    // gateway and the Pixel can play out what they are still holding (see AI_END_TAIL_MS).
    aiEndTailMs = AI_END_TAIL_MS,
    mediaGapHangupMs = MEDIA_GAP_HANGUP_MS,
    // 2026-09-21 relay-secondary heap OOM mid-uptime: restart between calls once the heap stays above this
    // (MB); docker `unless-stopped` brings the process back. Never while a run is active.
    heapRestartMb = 120, memoryUsage = () => process.memoryUsage(), forceGc = () => globalThis.gc?.(), exit = code => process.exit(code),
    // S69: how often an idle worker reports its heap (`worker_idle`).
    idleReportMs = 3_600_000, uptime = () => process.uptime(),
    log = () => {} }) {
    Object.assign(this, { control, defaultProvider, createAgent, connectPeer, createBridge, createTranscripts, heartbeatMs, renewMs, pollMs, idleMs, leaseMarginMs, activationTimeoutMs, maxCallSeconds, mediaTransport, greetingWaitMs, aiEndTailMs, mediaGapHangupMs, heapRestartMb, memoryUsage, forceGc, exit, idleReportMs, uptime, log });
    this.controlHealth = controlHealth(record => this.log(record));
    // S23 forensics: the 10 ms/5 ms pacing timer only keeps real time when the event loop is
    // responsive; report its delay per run so stalls are visible next to paceStalls.
    this.loopDelay = (() => { try { const h = monitorEventLoopDelay({ resolution: 5 }); h.enable(); return h; } catch { return null; } })();
    // S24 决策 2: an event-loop p99 of 57–72 ms on relay-primary is either scheduling or a stop-the-world
    // pause, and the two need different fixes. Report garbage collection beside the delay so the
    // next call's evidence says which one it was.
    this.gc = { count: 0, totalMs: 0, maxMs: 0 };
    this.gcObserver = (() => {
      try {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            this.gc.count += 1;
            this.gc.totalMs += entry.duration;
            if (entry.duration > this.gc.maxMs) this.gc.maxMs = entry.duration;
          }
        });
        observer.observe({ entryTypes: ['gc'] });
        return observer;
      } catch { return null; }
    })();
    this.shutdown = new AbortController(); this.activeAbort = null; this.running = null;
  }
  start() { if (this.running || this.shutdown.signal.aborted) throw new Error('Worker already started or stopped'); this.running = this.loop(); return this.running; }
  async stop() { this.activeAbort?.abort(fault('worker_shutdown')); this.shutdown.abort(); await this.running; try { this.gcObserver?.disconnect(); } catch {} }
  async loop() {
    const signal = this.shutdown.signal;
    let heartbeatReady = false, heartbeatFailing = false, lastIdleReport = Date.now();
    const heartbeat = (async () => { while (!signal.aborted) {
      try { await this.control.heartbeat(signal); heartbeatReady = true; heartbeatFailing = false; this.controlHealth('heartbeat'); } catch (error) {
        if (signal.aborted) break;
        heartbeatReady = false;
        this.controlHealth('heartbeat', error);
        // One line per failure streak; `runAborted` is the case that used to be silent.
        if (!heartbeatFailing) this.log({ event: 'heartbeat_failed', ...errorFields(error), runAborted: Boolean(this.activeAbort) });
        heartbeatFailing = true;
        this.activeAbort?.abort(fault('worker_heartbeat_failed'));
      }
      try { await wait(this.heartbeatMs, signal); } catch { break; }
    } })();
    let restart = false;
    try { while (!signal.aborted) {
      let phase = 'claim';
      try {
        const run = heartbeatReady ? await this.control.claim(signal) : null;
        if (heartbeatReady) this.controlHealth('claim');
        if (run) { phase = 'execute'; this.log({ event: 'run_claimed', runId: run.id, callId: run.callId, triggerAt: run.triggerAt, provider: providerOf(run, this.defaultProvider) }); await this.execute(run); this.controlHealth('execute'); lastIdleReport = Date.now(); }
        else if (Date.now() - lastIdleReport >= this.idleReportMs) { lastIdleReport = Date.now(); this.logIdle(); }
      } catch (error) { if (!signal.aborted) this.controlHealth(phase, error); }
      // Checked after every run and on every idle pass, so a quiet worker heals too.
      if (this.heapOverLimit()) { restart = true; this.shutdown.abort(); break; }
      try { await wait(this.idleMs, signal); } catch { break; }
    } } finally { await heartbeat; }
    if (restart) { try { this.gcObserver?.disconnect(); } catch {} this.exit(0); }
  }
  logIdle() {
    let memory = {};
    try { const usage = this.memoryUsage(); memory = { heapMb: Math.round(usage.heapUsed / 1_048_576), rssMb: Math.round(usage.rss / 1_048_576) }; } catch {}
    let uptimeH = null; try { uptimeH = Math.round(this.uptime() / 360) / 10; } catch {}
    this.log({ event: 'worker_idle', ...memory, uptimeH });
  }
  heapMb() { try { return Math.round(this.memoryUsage().heapUsed / 1_048_576); } catch { return 0; } }
  /** Only between runs: `activeAbort` is set for the whole of `execute`. */
  heapOverLimit() {
    if (this.activeAbort || !(this.heapRestartMb > 0) || this.heapMb() <= this.heapRestartMb) return false;
    try { this.forceGc(); } catch {}
    const heapMb = this.heapMb();
    if (heapMb <= this.heapRestartMb) return false;
    this.log({ event: 'worker_restart', reason: 'heap', heapMb, limitMb: this.heapRestartMb });
    return true;
  }
  async execute(run) {
    if (this.activeAbort) throw new Error('Voice capacity is one');
    const abort = new AbortController(); this.activeAbort = abort;
    try { this.loopDelay?.reset(); } catch {}
    this.gc = { count: 0, totalMs: 0, maxMs: 0 };
    const signal = AbortSignal.any([abort.signal, this.shutdown.signal]);
    let agent, peer, bridge, collector, leaseTimer, activationTimer, maxCallTimer, greetTimer, silenceTimer, mediaLostTimer, renewTask, monitorTask, mediaFaultTask, aiEndTask,
      finished = false, failure = null, enabledOnce = false, greeted = false, callerAudioSeen = false, activatedAtMs = 0, leaseExpiresAtMs = 0,
      // S27 决策 15: the AI has decided to hang up. Set before `aiEndTask` exists so a fault racing
      // the notice across the port cannot be mistaken for a broken provider.
      aiEndInFlight = false,
      // S27 决策 6: 两条 AI 自己做不到的规则（最长 3 分钟、对方 15 秒不说话就挂断），由 worker
      // 用计时器兜底。秒数来自供应商配置，豆包各 180/15，xAI 仍用全局的 AI_MAX_CALL_SECONDS/关闭。
      maxCallSecondsForRun = this.maxCallSeconds, silenceHangupSeconds = 0,
      // S69 run_closed fields: the provider this run used, caller speech starts (barge-ins), and the
      // last authority read so the closing line says what Control thought of the call.
      providerId = null, bargeIns = 0, lastState = null, disconnectedAtMs = 0,
      // S73f: `silenceArmed` is whether the caller-silence rule applies right now (AI finished a
      // turn, caller has not spoken since); `mediaGap` whether caller RTP has stopped arriving.
      silenceArmed = false, mediaGap = false;
    const stopOutput = () => { try { bridge?.setActive(false); bridge?.close(); } catch {} try { peer?.close(); } catch {} try { agent?.stop(); } catch {} };
    const stop = code => { if (!signal.aborted) { failure = code; abort.abort(fault(code)); } };
    const onAbort = () => stopOutput(); signal.addEventListener('abort', onAbort, { once: true });
    const lease = expiresAt => {
      // Control is on this same host/clock. Convert its wall-clock expiration
      // to a monotonic timer once; never schedule beyond one ten-second lease.
      const remaining = Math.min(10_000, Date.parse(expiresAt) - Date.now()) - this.leaseMarginMs;
      if (!Number.isFinite(remaining) || remaining <= 0) throw fault('lease_deadline_invalid');
      leaseExpiresAtMs = Date.parse(expiresAt);
      clearTimeout(leaseTimer); leaseTimer = setTimeout(() => stop('lease_deadline'), remaining);
    };
    // S27 决策 6 (c) / 决策 13: 「AI 说完再见了」的收尾。挂断要等来电者真的听完那句话——通知是在
    // 供应商**发完**音频时到的，播放队列还按实时节奏在放，此刻挂断等于把句子切一半。
    const endAfterPlayback = kind => {
      if (aiEndTask || signal.aborted) return;
      aiEndInFlight = true;
      aiEndTask = (async () => {
        try { await bridge?.whenPlaybackDrained({ timeoutMs: AI_END_DRAIN_TIMEOUT_MS, minMs: AI_END_DRAIN_MIN_MS, quietMs: AI_END_DRAIN_QUIET_MS }); } catch {}
        // S27 决策 15: the queue reading empty is not the caller having heard it (see AI_END_TAIL_MS).
        try { await wait(this.aiEndTailMs, signal); } catch {}
        this.log({ event: 'ai_ended_call', runId: run.id, kind, tailMs: this.aiEndTailMs });
        stop('ai_ended_call');
      })();
    };
    // S27 决策 13（2026-09-12 探针 T1）: a provider that closed because IT ended the call is not a
    // disconnect. The xAI Space agent injects its own `function_call_output {"status":"ending_call"}`
    // and closes the WebSocket ~1.5 s after `response.done`, while the last second of the goodbye is
    // still queued in the bridge; Doubao may close on its own after an unanswered `end_call` too.
    // `stop('provider_disconnected')` here would both mislabel the run in `ai_call_runs.failure_code`
    // and tear the bridge down at once, cutting the goodbye off — the exact thing 决策 6 (c) exists
    // to prevent. Let `aiEndTask` (drain, then `stop('ai_ended_call')`) finish instead; if the close
    // arrives without one ever having started, start it here so the run cannot hang to the 3-minute cap.
    const onProviderClosed = payload => {
      const expected = payload?.reason === 'ended_by_provider';
      if (!expected && !aiEndTask) {
        // Our own teardown closes the provider too; only a close that ends a live run is a disconnect.
        // `reason` is a fixed label, never the WebSocket close text.
        if (!signal.aborted) this.log({ event: 'provider_disconnected', runId: run.id, provider: providerId, closeCode: Number.isInteger(payload?.closeCode) ? payload.closeCode : null, reason: typeof payload?.reason === 'string' ? payload.reason.slice(0, 32) : 'socket_closed' });
        stop('provider_disconnected'); return;
      }
      if (expected) aiEndInFlight = true;
      this.log({ event: 'provider_closed_after_end_call', runId: run.id, expected });
      endAfterPlayback('provider_closed');
    };
    // S27 决策 15（真实通话 c3734597）: belt and braces for the adapter-side suppression. A provider
    // that has already said it is hanging up may still report its own socket teardown as an error;
    // `stop('provider_failed')` there aborts the run, which tears the bridge down under the drain
    // and discards the tail of the goodbye. A fault with no hangup in flight is still a failed run.
    const onProviderFault = error => {
      if (!aiEndTask && !aiEndInFlight) {
        if (!signal.aborted) this.log({ event: 'provider_fault', runId: run.id, provider: providerId, ...errorFields(error) });
        stop('provider_failed'); return;
      }
      this.log({ event: 'provider_fault_after_end_call', runId: run.id });
    };
    // S25 决策 8: the media bridge closes this worker's leg while the call is being torn down, and
    // that arrives before the 250 ms authority poll sees `ended`. Reporting every closed peer as
    // `media_failed` therefore mislabelled ordinary hangups in `ai_call_runs.failure_code`. Ask
    // Control exactly once — bounded by the Control client's own request timeout, so a genuine
    // media failure is delayed by one read and never longer — and only then choose the reason.
    // A read that fails keeps the pessimistic answer: an unverifiable close is still a fault.
    const onMediaFault = error => {
      if (mediaFaultTask || signal.aborted) return;
      // S27 决策 16（真实通话 c421d601）: belt and braces for the bridge-side gate. While the AI's own
      // hangup is in flight the media leg is being torn down by design; ending the run here as
      // `media_failed` is what cut 1.7 s off the goodbye, 0.1 s before the drain and the tail.
      if (aiEndTask || aiEndInFlight) {
        this.log({ event: 'media_fault_after_end_call', runId: run.id, message: String(error?.message ?? '').slice(0, 80) });
        return;
      }
      // S25 决策 10: the peer attaches its ICE pair snapshot; log it before the reason is decided.
      this.log({ event: 'media_fault', runId: run.id, message: String(error?.message ?? '').slice(0, 80), ice: error?.iceStats ?? null });
      mediaFaultTask = (async () => {
        let code = 'media_failed';
        try { if (callEnded(await this.control.read(run, signal))) code = 'call_terminal'; } catch {}
        stop(code);
      })();
    };
    // S25 决策 8: the greeting is what the caller must hear first, and until the gateway's data
    // channel is open the bridge discards every AI frame sent to it (197 of 342 frames, 4–7 s, on
    // the 2026-09-12 calls) — the caller lost the opening words. The gateway forwards caller audio
    // over that same channel, so the first received RTP packet is proof the path carries audio
    // (S70d: not the first `pcm` frame — the sink emits silence before any RTP arrives). Greet
    // then, or after `greetingWaitMs` at the latest (no RTP at all: the leg never carried audio).
    const sendGreeting = trigger => {
      if (greeted || signal.aborted) return;
      greeted = true; clearTimeout(greetTimer);
      const waitedMs = Math.max(0, Date.now() - activatedAtMs);
      try {
        if (agent.greet() === false) throw new Error('greet_refused');
        this.log({ event: 'greeting_sent', runId: run.id, waitedMs, trigger });
      } catch (error) { this.log({ event: 'greet_failed', runId: run.id, waitedMs, trigger, message: String(error?.message ?? '').slice(0, 80) }); }
    };
    const onInboundRtp = () => { callerAudioSeen = true; if (enabledOnce) sendGreeting('first_inbound_rtp'); };
    // Only the fixed notice kind: logs must never carry provider error text.
    const onProviderNotice = notice => {
      const kind = String(notice?.kind ?? 'unknown').slice(0, 64);
      // The adapter's own local send error (never provider text); it reports it once per run.
      if (kind === 'provider_send_failed') { this.log({ event: 'provider_send_failed', runId: run.id, message: String(notice?.message ?? '').slice(0, 80) }); return; }
      this.log({ event: 'provider_notice', runId: run.id, kind });
      // S27 决策 6 (c): 「AI 说完再见了」，收尾逻辑在 `endAfterPlayback`。
      if (kind !== 'exit_intent' && kind !== 'end_call') return;
      endAfterPlayback(kind);
    };
    // S27 决策 6 (b): 静音挂断。AI 一轮说完（含开场白）就武装，来电者一开口就解除。
    // 只看 `current`（这轮是来电者正在听的那轮），不看 `status`：被打断（cancelled）的一轮同样
    // 算"AI 停下来了"——否则打断之后模型若不再作答，计时器永远不会重新武装，只能等 3 分钟上限。
    // `enabledOnce` 是必须的：音频权限开放之前那些回复来电者根本没听到。
    const onAgentCompleted = data => {
      if (!enabledOnce || silenceHangupSeconds <= 0 || signal.aborted) return;
      if (data?.current !== true) return;
      clearTimeout(silenceTimer);
      // 队列里还没放完的音频先折算成毫秒（16 kHz PCM16 = 32 字节/ms）：15 秒要从来电者
      // 有可能开口的那一刻算起，而不是从供应商发完最后一个包算起。
      let pendingMs = 0;
      try { pendingMs = Math.min(60_000, Math.round((bridge?.stats()?.queuedBytes ?? 0) / 32)); } catch {}
      silenceArmed = true;
      if (!mediaGap) armSilence(silenceHangupSeconds * 1_000 + pendingMs);
    };
    const armSilence = ms => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        this.log({ event: 'silence_hangup', runId: run.id, seconds: silenceHangupSeconds });
        stop('caller_silence_timeout');
      }, ms);
    };
    const onSpeechStarted = () => { bargeIns += 1; silenceArmed = false; clearTimeout(silenceTimer); silenceTimer = undefined; };
    // S73f: no caller RTP is not a silent caller — pause the silence rule, bound the gap instead.
    const onMediaGap = ({ sinceMs = 0 } = {}) => {
      if (mediaGap || signal.aborted) return;
      mediaGap = true; clearTimeout(silenceTimer); silenceTimer = undefined;
      this.log({ event: 'media_gap', runId: run.id, sinceMs });
      mediaLostTimer = setTimeout(() => {
        this.log({ event: 'media_gap_hangup', runId: run.id, gapMs: this.mediaGapHangupMs });
        stop('media_lost');
      }, Math.max(0, this.mediaGapHangupMs - sinceMs));
    };
    const onMediaResumed = ({ gapMs = null } = {}) => {
      if (!mediaGap || signal.aborted) return;
      mediaGap = false; clearTimeout(mediaLostTimer); mediaLostTimer = undefined;
      this.log({ event: 'media_resumed', runId: run.id, gapMs });
      // The caller may only now hear the AI again: the silence rule starts over from zero.
      if (silenceArmed) armSilence(silenceHangupSeconds * 1_000);
    };
    // The only audio gate: Pixel reported ACTIVE and Control still allows audio.
    // The greeting's wait and the maximum call duration both start here, never at claim.
    const activate = () => {
      bridge.setActive(true);
      if (enabledOnce) return;
      enabledOnce = true;
      activatedAtMs = Date.now();
      // Only what the agent says after this point belongs to the call: anything it said while the
      // bridge was muted was never heard by the caller and must not reach the transcript.
      try { collector?.setRecording?.(true); } catch {}
      this.log({ event: 'activated', runId: run.id, callId: run.callId, maxCallSeconds: maxCallSecondsForRun, silenceHangupSeconds });
      // Caller audio that already reached this worker proves the channel was open before ACTIVE.
      if (callerAudioSeen) sendGreeting('first_inbound_rtp');
      else greetTimer = setTimeout(() => sendGreeting('timeout'), this.greetingWaitMs);
      // The hangup cap still starts here, at the audio gate, not at the greeting.
      maxCallTimer = setTimeout(() => stop('ai_max_call_seconds'), maxCallSecondsForRun * 1_000);
    };
    try {
      signal.throwIfAborted(); lease(run.leaseExpiresAt);
      renewTask = (async () => { while (!signal.aborted) {
        try { await wait(this.renewMs, signal); const result = await this.control.renew(run, signal); signal.throwIfAborted(); lease(result.leaseExpiresAt); }
        catch (error) { if (!signal.aborted) { this.log({ event: 'lease_renew_failed', runId: run.id, ...errorFields(error) }); stop('lease_renew_failed'); } break; }
      } })();
      // S24 决策 3: the claim decides the provider; a run that names one this worker cannot build
      // ends as `provider_unavailable` through the existing failure path, which is what lets
      // Control fall back to an ordinary ring (S22 决策 5).
      providerId = providerOf(run, this.defaultProvider);
      if (!providerId) throw providerUnavailable();
      agent = this.createAgent({ provider: providerId }); agent.on('fault', onProviderFault); agent.on('closed', onProviderClosed); agent.on('notice', onProviderNotice);
      agent.on('completed', onAgentCompleted); agent.on('speechStarted', onSpeechStarted);
      // S27 决策 6 (a)/(b): the already-parsed startup configuration is on the proxy synchronously —
      // no thread round trip. A provider that carries no limits of its own keeps the worker's.
      maxCallSecondsForRun = agent.config?.maxCallSeconds ?? this.maxCallSeconds;
      silenceHangupSeconds = agent.config?.silenceHangupSeconds ?? 0;
      // Claim may prewarm 30 seconds before timeout_ai. No answer or media IO yet.
      const trigger = Date.parse(run.triggerAt); if (!Number.isFinite(trigger)) throw fault('invalid_trigger');
      // S27 决策 14 (2026-09-12 in-image A/B): a provider may refuse to hold an idle session open
      // for the whole prewarm. xAI kills a Space-agent session that receives no uplink audio after
      // ~17 s — its idle turn calls the Space agent's own `end_call` and the server closes the
      // socket (the old `tools: []` build died the same way at ~20 s, so this is the provider's
      // rule, not ours), which a 30 s prewarm turns into `provider_disconnected` before the call is
      // even answered. Such a provider carries a `prewarmLeadMs` and its session is opened that
      // long before `triggerAt` instead of at claim time. Doubao keeps its own session alive with
      // `input_audio_mute.commit` and carries none, so it prewarms exactly as before.
      const prewarmLeadMs = agent.config?.prewarmLeadMs;
      if (Number.isFinite(prewarmLeadMs) && prewarmLeadMs > 0) {
        const waitMs = trigger - prewarmLeadMs - Date.now();
        if (waitMs > 0) {
          this.log({ event: 'provider_start_deferred', runId: run.id, waitMs: Math.round(waitMs), leadMs: prewarmLeadMs });
          try { await wait(waitMs, signal); } catch {}
          signal.throwIfAborted();
        }
      }
      await agent.start({ signal }); signal.throwIfAborted();
      collector = this.createTranscripts({ post: items => this.control.transcript(run, items, AbortSignal.timeout(3_000)), recording: false });
      collector.attach(agent); collector.start();
      await wait(Math.max(0, trigger - Date.now()), signal);
      await this.control.commit(run, signal); signal.throwIfAborted();
      this.log({ event: 'answer_committed', runId: run.id, callId: run.callId });
      activationTimer = setTimeout(() => stop('telecom_active_timeout'), this.activationTimeoutMs);
      // Start observing before ICE; authority loss aborts setup as well as playback.
      let latestAudioAllowed = false;
      monitorTask = (async () => { while (!signal.aborted) {
        try {
          const state = await this.control.read(run, signal); signal.throwIfAborted();
          lastState = state;
          if (terminal.has(state.run?.state) || ['ended', 'failed'].includes(state.callState)) { finished = true; abort.abort(fault('call_terminal')); break; }
          latestAudioAllowed = state.audioAllowed === true;
          if (latestAudioAllowed) clearTimeout(activationTimer);
          const revoked = reason => this.log({ event: 'revoked', runId: run.id, runState: state.run?.state ?? null,
            callState: state.callState ?? null, audioAllowed: latestAudioAllowed, reason });
          if (!latestAudioAllowed && (state.run?.state === 'active' || state.callState === 'unknown')) { revoked('authority_revoked_while_active'); stop('audio_authority_revoked'); break; }
          if (enabledOnce && !latestAudioAllowed) { revoked('authority_revoked_after_activation'); stop('audio_authority_revoked'); break; }
          if (bridge) { if (latestAudioAllowed) activate(); else bridge.setActive(false); }
          await wait(this.pollMs, signal);
        } catch (error) {
          // Control clears the run lease in the same transaction that moves the call to a
          // terminal state, so a lease Control refuses while this worker still holds a valid
          // one means the call ended under the poll, not that the authority read broke.
          if (!signal.aborted) stop(['AI_LEASE_LOST', 'AI_RUN_NOT_FOUND'].includes(error?.code) && Date.now() < leaseExpiresAtMs ? 'call_terminal' : 'authority_read_failed');
          break;
        }
      } })();
      // media_options / media_offer_posted are observed here rather than inside the media module, so
      // the transport stays free of logging concerns and the run identity stays in one place.
      const signaling = this.control.signaling(run);
      const observed = {
        ...signaling,
        options: async (...args) => {
          const value = await signaling.options(...args);
          this.log({ event: 'media_options', runId: run.id, mediaNodeId: value?.mediaNodeId ?? null, mediaEpoch: value?.mediaEpoch ?? null, transport: this.mediaTransport });
          return value;
        },
        offer: async (...args) => {
          const answer = await signaling.offer(...args);
          this.log({ event: 'media_offer_posted', runId: run.id });
          return answer;
        },
      };
      peer = await this.connectPeer({ signaling: observed, callId: run.callId, transport: this.mediaTransport, signal }); signal.throwIfAborted();
      this.log({ event: 'peer_connected', runId: run.id, callId: run.callId });
      peer.on('fault', onMediaFault);
      peer.on('disconnected', async () => {
        disconnectedAtMs = Date.now();
        let iceSnapshot = null; try { iceSnapshot = await peer.iceSnapshot?.() ?? null; } catch {}
        this.log({ event: 'media_disconnected', runId: run.id, iceSnapshot });
      });
      peer.on('reconnected', () => this.log({ event: 'media_reconnected', runId: run.id, downMs: disconnectedAtMs ? Date.now() - disconnectedAtMs : null }));
      // One shot: the peer emits `inboundRtp` once, when the first caller RTP packet is counted.
      peer.once('inboundRtp', onInboundRtp);
      peer.on('mediaGap', onMediaGap); peer.on('mediaResumed', onMediaResumed);
      // Playback overflow and other bridge notices take the provider notice path: a report, never a hangup.
      bridge = this.createBridge({ agent, peer }); bridge.on('fault', onMediaFault); bridge.on('notice', onProviderNotice); bridge.start();
      if (latestAudioAllowed) activate(); else bridge.setActive(false);
      await monitorTask;
    } catch (error) {
      if (!finished && !failure) {
        failure = /^[a-z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'worker_run_failed';
        if (failure === 'worker_run_failed') this.log({ event: 'worker_run_failed', runId: run.id, ...errorFields(error) });
      }
    }
    finally {
      if (!signal.aborted) abort.abort(fault(failure ?? 'run_finished'));
      stopOutput(); clearTimeout(leaseTimer); clearTimeout(activationTimer); clearTimeout(maxCallTimer); clearTimeout(greetTimer); clearTimeout(silenceTimer); clearTimeout(mediaLostTimer);
      // `aiEndTask` is bounded by the drained bridge, which `stopOutput()` has already closed.
      await Promise.allSettled([renewTask, monitorTask, mediaFaultTask, aiEndTask].filter(Boolean));
      agent?.off('fault', onProviderFault); agent?.off('closed', onProviderClosed); agent?.off('notice', onProviderNotice); agent?.off('completed', onAgentCompleted); agent?.off('speechStarted', onSpeechStarted); peer?.off('fault', onMediaFault); peer?.off('inboundRtp', onInboundRtp); peer?.off('mediaGap', onMediaGap); peer?.off('mediaResumed', onMediaResumed); bridge?.off('fault', onMediaFault); bridge?.off('notice', onProviderNotice);
      // Last transcript flush. S27 失败记录 6: Control keeps the run's lease identity for 60 s after it
      // moves the run to `ended`, so this batch is still authenticated even when the caller hung up
      // first; for a worker-initiated failure it simply runs before `fail()` clears the identity.
      if (collector) { collector.detach(agent); await collector.close().catch(() => {}); }
      signal.removeEventListener('abort', onAbort);
      // Never retry answer/offer. If this notification fails, Control's durable
      // lease reconciler owns the remaining physical hangup and media cleanup.
      if (!finished) await this.control.fail(run, failure ?? 'worker_shutdown', AbortSignal.timeout(3_000)).catch(error => this.log({ event: 'control_fail_report_failed', runId: run.id, ...errorFields(error) }));
      let memory = {};
      try { const usage = this.memoryUsage(); memory = { heapUsedMb: Math.round(usage.heapUsed / 1_048_576), rssMb: Math.round(usage.rss / 1_048_576) }; } catch {}
      this.log({ event: 'run_closed', runId: run.id, callId: run.callId, provider: providerId, reason: finished ? 'terminal' : failure ?? 'worker_shutdown',
        // durationMs counts from the audio gate (activation); 0 means the caller never heard the AI.
        durationMs: activatedAtMs ? Date.now() - activatedAtMs : 0, greeted, bargeIns, callState: lastState?.callState ?? null, runState: lastState?.run?.state ?? null, ...memory, ...(bridge ? { audio: bridge.stats() } : {}), ...(collector ? { transcripts: collector.stats() } : {}), ...(this.loopDelay ? { eventLoopMs: eventLoopSummary(this.loopDelay) } : {}), ...(this.gcObserver ? { gc: gcSummary(this.gc) } : {}),
        // R7 §2(d): `gc` is this thread's — the one that paces audio. `providerGc` is the provider
        // thread's own isolate, so a stall can be charged to the heap that caused it.
        ...(agent?.providerGc ? { providerGc: agent.providerGc } : {}) });
      this.activeAbort = null;
    }
  }
}

/** Event-loop delay percentiles in milliseconds for the run that just ended (histogram values are nanoseconds). */
function eventLoopSummary(histogram) {
  const ms = value => Math.round(value / 1e6 * 10) / 10;
  try { return { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max) }; }
  catch { return null; }
}

/** Garbage-collection pauses on this thread for the run that just ended (entry durations are milliseconds). */
function gcSummary({ count, totalMs, maxMs }) {
  const ms = value => Math.round(value * 10) / 10;
  return { count, totalMs: ms(totalMs), maxMs: ms(maxMs) };
}

/**
 * The provider id for one run: whatever the claim named, else this worker's configured default.
 * `null` means the claim named something that is not a provider id at all, which is reported the
 * same way an unconfigured provider is.
 */
function providerOf(run, fallback) {
  const claimed = run?.voiceProvider;
  if (claimed === undefined || claimed === null || claimed === '') return PROVIDER_ID_PATTERN.test(fallback ?? '') ? fallback : null;
  return typeof claimed === 'string' && PROVIDER_ID_PATTERN.test(claimed) ? claimed : null;
}
