import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { GenerationPlaybackQueue, Pcm16kResampler, Pcm20msFramer, ProviderInputBatcher, pcmConstants } from './pcm-pipeline.mjs';

const SILENCE_10MS = Buffer.alloc(pcmConstants.PCM16K_10MS_BYTES);
const PACE_FRAME_US = 10_000;
/** 50 ms: enough to absorb ordinary timer lateness, small enough never to flood the encoder. */
const PACE_MAX_CATCHUP_FRAMES = 5;

/**
 * Couples an already-authorized WebRTC client peer to a realtime PCM provider.
 * It has no call-control authority: setActive(true) must come from authoritative
 * Telecom reconciliation by the future Control worker.
 */
export class RealtimeAudioBridge extends EventEmitter {
  constructor({ agent, peer, nowUs = () => Number(process.hrtime.bigint() / 1000n), paceNowUs = () => Number(process.hrtime.bigint() / 1000n), tickMs = 5, playbackMaxFrames = 3_000 }) {
    super();
    this.agent = agent;
    this.peer = peer;
    this.nowUs = nowUs;
    // Pacing has its own monotonic clock: `nowUs` also stamps caller frames and tests drive it per call.
    this.paceNowUs = paceNowUs;
    this.tickMs = tickMs;
    this.resampler = new Pcm16kResampler();
    this.framer = new Pcm20msFramer();
    this.input = new ProviderInputBatcher({ maxFrames: 25 });
    // Providers emit far faster than wall clock: a whole reply, and the Space agent's
    // own session opener, arrive as one burst. Hold a full minute of it. An overflow is
    // reported as a notice and never as a fault: losing audio must not lose the call.
    this.playback = new GenerationPlaybackQueue({
      maxFrames: playbackMaxFrames,
      onOverflow: detail => this.emit('notice', { kind: 'playback_overflow', ...detail }),
    });
    if (Number.isSafeInteger(agent.outputGeneration) && agent.outputGeneration > 0) {
      this.playback.advanceGeneration(agent.outputGeneration);
    }
    this.closed = false;
    this.started = false;
    this.active = false;
    this.onPeerPcm = data => this.handlePeerPcm(data);
    // S27 决策 14: when the provider last handed us audio. `whenPlaybackDrained`'s end-of-call rule
    // reads it to decide that the provider has stopped sending; `undefined` means "never".
    this.lastAgentAudioAtMs = undefined;
    this.onAgentAudio = data => {
      this.lastAgentAudioAtMs = Date.now();
      try { this.playback.enqueue(data.pcm, data.generation); }
      catch (error) { this.emit('fault', error); }
    };
    this.onAgentFlush = data => {
      if (data.generation > this.playback.generation) this.playback.advanceGeneration(data.generation);
    };
    this.onAgentCompleted = data => {
      if (data.current && data.status === 'completed') this.playback.finishGeneration(data.generation);
    };
    /**
     * S27 决策 16（真实通话 c421d601, 2026-09-12 14:24 UTC）: the provider hangs up first and the
     * caller keeps talking. Every uplink batch then hit the adapter's `AI not ready` guard, the
     * throw became a bridge `fault`, and the worker read that as `media_failed` — it ended the run
     * 0.1 s later, before the drain and the tail, and 55040 bytes (1.7 s) of the goodbye were
     * cleared. Uplink has nowhere to go once the session is gone, so it is dropped and counted;
     * playback keeps pacing, because that is precisely what still has to reach the caller.
     */
    this.agentClosed = false;
    this.upDroppedAfterAgentClosed = 0;
    this.onAgentClosed = () => { this.agentClosed = true; };
    // The provider's own faults stop being this bridge's business once it has closed: after that
    // they are the teardown talking, and the worker already has them on the `agent` fault path.
    this.onAgentFault = error => { if (!this.agentClosed) this.emit('fault', error); };
    this.onFault = error => this.emit('fault', error);
  }

  start() {
    if (this.closed || this.started) throw new Error('Audio bridge cannot be started');
    this.started = true;
    this.peer.on('pcm', this.onPeerPcm);
    this.peer.on('fault', this.onFault);
    this.agent.on('audio', this.onAgentAudio);
    this.agent.on('flushAudio', this.onAgentFlush);
    this.agent.on('fault', this.onAgentFault);
    this.agent.on('closed', this.onAgentClosed);
    this.agent.on('completed', this.onAgentCompleted);
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  setActive(active) {
    if (this.closed) return;
    this.active = Boolean(active);
    this.playback.setActive(this.active);
    if (!this.active) {
      this.framer.reset();
      this.resampler = new Pcm16kResampler();
      this.input.reset();
    }
  }

  handlePeerPcm({ pcm, sampleRate }) {
    if (this.closed || !this.active) return;
    // S27 决策 16: the session is gone; these bytes have nowhere to go. Forwarding them only
    // produces the adapter's `AI not ready` throw, which used to end the run as `media_failed`
    // while the caller was still listening to the goodbye.
    if (this.agentClosed) { this.upDroppedAfterAgentClosed++; return; }
    try {
      const pcm16k = this.resampler.process(pcm, sampleRate);
      for (const frame of this.framer.push(pcm16k, this.nowUs())) {
        const batch = this.input.push(frame);
        if (batch) this.agent.appendAudio(batch.pcm16le, { sampleRate: 16_000, sequence: batch.sequence });
      }
    } catch (error) {
      this.emit('fault', error);
    }
  }

  tick() {
    if (this.closed) return;
    try {
      // WebRTC needs a paced source track before gateway ACTIVE so negotiation and
      // gateway prebuffer can complete. Inactive/stale AI output is replaced by silence.
      //
      // S22 forensics: the RTP timestamp advances 10 ms per frame pushed, not per wall-clock
      // millisecond, and a 10 ms setInterval on a busy 1 GB host fires late (about every 14 ms
      // in production). One frame per tick therefore streamed at ~70% of real time: the media
      // bridge measured the AI audio 10–21 s behind its own timestamps and the gateway dropped
      // the late frames (1300 dropped / 1427 gaps in one call). Pace by the monotonic clock
      // instead: push exactly the frames the clock says are due, at most PACE_MAX_CATCHUP_FRAMES.
      //
      // S23 决策 3: the tick period is now 5 ms, half a frame, so most ticks have nothing due.
      // There is deliberately NO "at least one frame per tick" floor: a floor only matches real
      // time while the timer period equals the 10 ms frame length, and at 5 ms it would stream at
      // twice real time (0 due, forced 1, every tick). Liveness — the ~100 silent frames a second
      // the gateway prebuffer needs before ACTIVE — comes from the clock itself, not from the
      // timer: one second of paceNowUs always makes 100 frames due, however often tick() runs.
      const now = this.paceNowUs();
      if (this.paceOriginUs === undefined) { this.paceOriginUs = now; this.pacedFrames = 0; }
      const dueFrames = Math.floor((now - this.paceOriginUs) / PACE_FRAME_US) - this.pacedFrames;
      let frames = Math.max(0, dueFrames);
      if (frames > PACE_MAX_CATCHUP_FRAMES) {
        // A stall longer than the catch-up window is absorbed as delay, never as a burst that
        // would flood the encoder: rebase the origin so the excess is forgotten.
        this.paceOriginUs += (frames - PACE_MAX_CATCHUP_FRAMES) * PACE_FRAME_US;
        frames = PACE_MAX_CATCHUP_FRAMES;
        this.paceStalls = (this.paceStalls ?? 0) + 1;
      }
      for (let i = 0; i < frames; i++) {
        this.peer.writePcm16k10ms(this.playback.take10ms() ?? SILENCE_10MS);
        this.pacedFrames += 1;
      }
      if (frames > 1) this.paceCatchupFrames = (this.paceCatchupFrames ?? 0) + frames - 1;
    } catch (error) {
      this.emit('fault', error);
    }
  }

  /**
   * S27 决策 6: resolves once nothing is left to play. The AI's "I am hanging up now" arrives as a
   * notice at the moment the provider finished *sending* the goodbye, while the caller is still
   * hearing it — the playback queue is paced at real time and may hold several seconds. Hanging up
   * then would cut the sentence off. A closed or inactive bridge is already drained: it will never
   * play those bytes to anyone. The timeout is a bound, never a promise that the queue emptied.
   *
   * S27 决策 14 — the **end-of-call** rule, used only when `quietMs`/`minMs` are supplied (every
   * other caller keeps the predicate above byte for byte). "The queue is empty" is the wrong
   * question at a hangup, for two reasons measured in-image on 2026-09-12:
   *   - `end_call` is when the provider *decided* to hang up, not when its goodbye is on the wire.
   *     Doubao streams the goodbye text and the tool call first and only starts delivering the
   *     matching TTS ~2.7 s later, so the queue is momentarily empty in the middle of the goodbye.
   *     `minMs` is the floor that covers that gap.
   *   - an unanswered `end_call` never gets a `response.output_audio.done`, so `finishGeneration()`
   *     is never called and the last partial frame (< 640 B) stays in `pendingBytes` forever —
   *     unplayable, but counted by `queuedBytes()`. Waiting for zero therefore always ran to the
   *     15 s bound and left the caller ~6 s of silence. A sub-frame remainder *is* drained.
   * Together: everything the provider sent has been paced out (`< one frame` left), it has sent
   * nothing for `quietMs`, and at least `minMs` has passed since the hangup was decided.
   */
  async whenPlaybackDrained({ timeoutMs = 15_000, pollMs = 20, quietMs, minMs } = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(0, timeoutMs);
    const endOfCall = quietMs !== undefined || minMs !== undefined;
    const floor = startedAt + Math.max(0, minMs ?? 0);
    const quiet = Math.max(0, quietMs ?? 0);
    const drained = () => {
      if (!endOfCall) return this.playback.queuedBytes() === 0;
      const now = Date.now();
      if (now < floor) return false;
      if (this.playback.queuedBytes() >= pcmConstants.PCM16K_20MS_BYTES) return false;
      // Audio that arrived before the hangup was decided cannot make the link look quiet earlier
      // than the floor: the quiet window opens at `floor` at the earliest.
      return now >= Math.max(this.lastAgentAudioAtMs ?? 0, floor) + quiet;
    };
    while (!this.closed && this.active && !drained()) {
      if (Date.now() >= deadline) return false;
      await delay(Math.max(1, pollMs));
    }
    return true;
  }

  stats() {
    return { active: this.active, inputDroppedFrames: this.input.droppedFrames, upDroppedAfterAgentClosed: this.upDroppedAfterAgentClosed,
      pacedFrames: this.pacedFrames ?? 0, paceCatchupFrames: this.paceCatchupFrames ?? 0, paceStalls: this.paceStalls ?? 0,
      ...this.playback.stats() };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.peer.off('pcm', this.onPeerPcm);
    this.peer.off('fault', this.onFault);
    this.agent.off('audio', this.onAgentAudio);
    this.agent.off('flushAudio', this.onAgentFlush);
    this.agent.off('fault', this.onAgentFault);
    this.agent.off('closed', this.onAgentClosed);
    this.agent.off('completed', this.onAgentCompleted);
    // Fence injection first; then tear down network/provider resources.
    this.playback.setActive(false);
    this.peer.close();
    this.agent.stop();
  }
}
