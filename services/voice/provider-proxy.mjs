import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { transferableBytes } from './pcm-pipeline.mjs';

const THREAD_URL = new URL('./provider-thread.mjs', import.meta.url);
/** One second of PCM16 mono at 16 kHz. A transport bound, identical for every provider. */
const MAX_PCM_BYTES_PER_APPEND = 32_000;
/** The thread exits itself after `stop`; this is only the guard against one that cannot. */
const TERMINATE_GRACE_MS = 500;
/**
 * relay-primary is a 2 vCPU / 1 GB host and the unit caps the service at 384 MB. V8 heap flags on the
 * command line are process-global, so the main isolate's `--max-semi-space-size=32` would apply to
 * this thread too unless `resourceLimits` overrides it. The thread only ever holds one WebSocket,
 * one JSON frame and one audio delta at a time.
 */
const THREAD_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 });

/**
 * S24 决策 2 — the main-thread half of the provider thread boundary.
 *
 * Presents exactly the surface `VoiceWorker`, `RealtimeAudioBridge` and `TranscriptCollector`
 * already consume from `XaiVoiceAgent`: methods start / stop / greet / appendAudio / interrupt /
 * requestInputTranscription, the `outputGeneration` property, and the events audio / flushAudio /
 * completed / fault / notice / closed / transcript / speechStarted / response.
 *
 * Ordering across a `MessagePort` is preserved, so the generation fence that decides which audio
 * the caller hears survives the move: every message from the thread carries the agent's current
 * `outputGeneration`, and it is applied before the event is re-emitted here.
 */
export class ThreadedVoiceAgent extends EventEmitter {
  /** `port` replaces the spawned thread in tests; `provider`/`config` are used otherwise. */
  constructor({ provider, config, port, resourceLimits = THREAD_LIMITS } = {}) {
    super();
    Object.assign(this, { provider, config, injectedPort: port ?? null, resourceLimits });
    this.state = 'idle';
    this.sequence = -1;
    this.outputGeneration = 0;
    this.greeted = false;
    this.closedEmitted = false;
    // R7 §2(d): the provider thread's own isolate reports its GC here; `run_closed` logs it beside
    // the main thread's so a stall can be attributed to the right heap.
    this.providerGc = null;
  }

  async start({ signal } = {}) {
    if (this.state !== 'idle') throw new Error('Agent already started');
    if (signal?.aborted) {
      this.state = 'closed';
      throw signal.reason instanceof Error ? signal.reason : new Error('AI setup aborted');
    }
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      this.resolveSetup = resolve;
      this.rejectSetup = reject;
      try { this.openPort(); }
      catch (error) { this.state = 'closed'; this.rejectSetup = undefined; this.resolveSetup = undefined; reject(error); return; }
      const abort = () => this.stop(signal.reason instanceof Error ? signal.reason : new Error('AI setup aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      this.removeAbortListener = () => signal?.removeEventListener('abort', abort);
      this.post({ t: 'start' });
    });
  }

  openPort() {
    if (this.injectedPort) { this.port = this.injectedPort; this.bindPort(this.port); this.port.start?.(); return; }
    // `execArgv: []` keeps CLI module flags out of the thread; the V8 heap caps come from
    // `resourceLimits`, which is the only knob that is per-isolate rather than per-process.
    const thread = new Worker(THREAD_URL, {
      workerData: { kind: 'voice-provider', provider: this.provider, config: this.config },
      execArgv: [], resourceLimits: this.resourceLimits, stdin: false,
    });
    this.thread = thread;
    // Deliberately left referenced: a live thread keeps this process alive so that `stop()`'s
    // termination guard is guaranteed to run, and `stop()` is on every path out of a run.
    thread.on('error', error => this.onThreadFailure(error));
    thread.on('exit', code => this.onThreadExit(code));
    this.port = thread;
    this.bindPort(thread);
  }

  bindPort(port) { this.onPortMessage = message => this.receive(message); port.on('message', this.onPortMessage); }

  post(message, transfer) {
    if (this.state === 'closed' || !this.port) return false;
    try { this.port.postMessage(message, transfer); return true; }
    catch { return false; }
  }

  receive(message) {
    // A stopped session still accepts the thread's parting garbage-collection totals: they are
    // written into `run_closed`, which happens after the agent has already been stopped.
    if (this.state === 'closed') { if (message?.t === 'gc') this.providerGc = message.gc ?? null; return; }
    // The thread is authoritative for the playback generation while the session is live.
    if (this.state !== 'closed' && Number.isSafeInteger(message?.gen)) this.outputGeneration = message.gen;
    switch (message?.t) {
      case 'started': {
        if (this.state !== 'connecting') return;
        this.state = 'ready';
        const settle = this.resolveSetup;
        this.resolveSetup = undefined; this.rejectSetup = undefined;
        settle?.(message.info ?? null);
        return;
      }
      case 'startFailed': return void this.stop(new Error(message.message || 'AI setup failed'));
      case 'gc': this.providerGc = message.gc ?? null; return;
      case 'pcm':
        // `Buffer.from(arrayBuffer)` is a view, not a copy: the bytes were moved, never cloned.
        return void this.emit('audio', { pcm: Buffer.from(message.pcm), sampleRate: message.sampleRate, responseId: message.responseId, generation: message.generation });
      case 'ev': {
        if (message.name === 'fault') {
          const error = new Error(String(message.payload?.message ?? 'AI provider error').slice(0, 500));
          if (typeof message.payload?.name === 'string') error.name = message.payload.name;
          if (typeof message.payload?.code === 'string') error.code = message.payload.code;
          this.emit('fault', error); return;
        }
        // S27 决策 13: `closed` carries a payload now — `{reason:'ended_by_provider'}` after the
        // provider's own `end_call` — and the worker reads it to tell an expected end from a
        // disconnect. Dropping it here would turn every AI-ended call into `provider_disconnected`.
        if (message.name === 'closed') { if (this.closedEmitted) return; this.closedEmitted = true; this.emit('closed', message.payload ?? {}); return; }
        this.emit(message.name, message.payload ?? {});
        return;
      }
      default: return;
    }
  }

  /** A thread that dies mid-call is a provider that disconnected; the run ends the same way. */
  onThreadFailure(error) {
    if (this.state === 'closed') return;
    this.emit('fault', error instanceof Error ? new Error(String(error.message).slice(0, 500)) : new Error('AI provider thread failed'));
    this.stop(new Error('AI provider thread failed'));
  }

  onThreadExit() {
    clearTimeout(this.terminateTimer);
    this.stop(new Error('AI provider thread exited'));
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    // A thread that exited without the adapter's own `closed` has no reason to report: the payload
    // stays the ordinary `{}`, which the worker reads as a disconnect.
    this.emit('closed', { reason: 'thread_exit' });
  }

  settleSetupFailure(error) {
    const settle = this.rejectSetup;
    this.resolveSetup = undefined; this.rejectSetup = undefined;
    settle?.(error);
  }

  greet() {
    if (this.greeted || this.state !== 'ready') return false;
    this.greeted = true;
    // The provider's own refusal still arrives as the adapter's `greeting_failed` notice; only the
    // synchronous "the socket rejected the write" answer cannot cross a port, and no caller reads it.
    return this.post({ t: 'greet' });
  }

  appendAudio(pcm, { sampleRate = 16_000, sequence } = {}) {
    // Kept synchronous and local so the audio bridge's own try/catch still sees a bad batch as a
    // fault at the moment it pushes it, exactly as it did before the adapter moved off-thread.
    if (this.state !== 'ready') throw new Error('AI not ready');
    if (sampleRate !== 16_000 || pcm.length % 2 || pcm.length > MAX_PCM_BYTES_PER_APPEND) throw new Error('Expected at most one second of PCM16 mono at 16 kHz');
    if (!Number.isInteger(sequence) || sequence <= this.sequence) throw new Error('Audio sequence must increase');
    this.sequence = sequence;
    const bytes = transferableBytes(pcm);
    this.post({ t: 'audio', pcm: bytes, sampleRate, sequence }, [bytes]);
  }

  /** The generation is advanced by the thread's own `flushAudio`, never guessed here. */
  interrupt({ sendCancel = true } = {}) { this.post({ t: 'interrupt', sendCancel }); }

  requestInputTranscription() { this.post({ t: 'transcription' }); }

  stop(reason = new Error('AI stopped during setup')) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.settleSetupFailure(reason instanceof Error ? reason : new Error('AI stopped during setup'));
    this.removeAbortListener?.(); this.removeAbortListener = undefined;
    // Fence playback here rather than waiting for the thread's own `flushAudio`: the port may well
    // close before that message is delivered, and a stale generation is audio the caller can hear.
    this.outputGeneration++;
    this.emit('flushAudio', { generation: this.outputGeneration });
    try { this.port?.postMessage({ t: 'stop' }); } catch {}
    if (!this.thread) {
      // Tests own the injected port's lifetime; leaving it open here would keep `node --test` alive.
      if (this.injectedPort) { try { this.injectedPort.close(); } catch {} }
      return;
    }
    // The message listener deliberately stays attached until the thread exits, so the thread's
    // final GC totals still land before `run_closed` is written.
    clearTimeout(this.terminateTimer);
    this.terminateTimer = setTimeout(() => { void this.thread.terminate().catch(() => {}); }, TERMINATE_GRACE_MS);
    this.terminateTimer.unref?.();
  }
}
