import { EventEmitter } from 'node:events';
import { pcmConstants } from './pcm-pipeline.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/**
 * S23 决策 2: the same pairing the gateway enforces (GatewayMediaSignaling) and Control's
 * MediaBridgeClient generates. A TLS request that comes back with a plain UDP relay URL would
 * silently keep the leg on the lossy cross-border UDP path, so the mismatch is a hard failure.
 */
const TURN_URL = Object.freeze({
  udp: /^turn:[A-Za-z0-9.-]+:\d+\?transport=udp$/,
  tls: /^turns:[A-Za-z0-9.-]+:\d+\?transport=tcp$/,
});

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Media connection aborted');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(value, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => finish(abortError(signal));
    const finish = (error, result) => {
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(result => finish(null, result), error => finish(error));
  });
}

/** A relay candidate is identified by its SDP attribute, not by a non-standard `type` field. */
export function isRelayCandidate(candidate) {
  const value = typeof candidate === 'string' ? candidate : candidate?.candidate;
  return typeof value === 'string' && / typ relay(\s|$)/.test(value);
}

/**
 * S22 决策 1, ported from the iOS `MediaRelayGatheringPolicy`. Measured on relay-primary: the first relay
 * candidate arrives in 117-204 ms and `iceGatheringState` NEVER reaches `complete` (lo / ens3 /
 * tailscale0 keep the agent gathering), so waiting for completion delayed every offer by the full
 * 12 s cap — long after Control had revoked the run. The offer now goes out as soon as one relay
 * candidate has been stable for a short settle window. `complete` remains an early exit, and the cap
 * is the last resort: proceed with whatever relay candidates exist, fail only when there are none.
 *
 * The handlers must be attached BEFORE `setLocalDescription`, or the ~120 ms candidate is missed.
 */
export function watchRelayGathering(pc, signal, { settleMs = 1_000, capMs = 12_000 } = {}) {
  let relayCandidates = 0;
  let finished = false;
  let resolve, reject, settleTimer, capTimer;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  // A caller that throws before awaiting must not turn a later cancellation into an unhandled rejection.
  promise.catch(() => {});
  const previousCandidate = pc.onicecandidate;
  const previousState = pc.onicegatheringstatechange;
  const finish = error => {
    if (finished) return;
    finished = true;
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    signal?.removeEventListener('abort', abort);
    pc.onicecandidate = previousCandidate ?? null;
    pc.onicegatheringstatechange = previousState ?? null;
    error ? reject(error) : resolve({ relayCandidates });
  };
  const abort = () => finish(abortError(signal));
  pc.onicecandidate = event => {
    previousCandidate?.(event);
    if (!event?.candidate || !isRelayCandidate(event.candidate)) return;
    relayCandidates += 1;
    if (settleTimer) return;
    settleTimer = setTimeout(() => finish(), settleMs);
    settleTimer.unref?.();
  };
  pc.onicegatheringstatechange = event => {
    previousState?.(event);
    if (pc.iceGatheringState === 'complete') finish();
  };
  capTimer = setTimeout(() => finish(relayCandidates ? undefined : new Error('ICE gathering produced no relay candidate')), capMs);
  capTimer.unref?.();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  if (pc.iceGatheringState === 'complete') finish();
  return { promise, cancel: () => finish(new Error('ICE gathering cancelled')), relayCandidates: () => relayCandidates };
}

function waitForConnected(pc, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Media connection aborted'));
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('WebRTC connection timed out')), timeoutMs);
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Media connection aborted'));
    const previous = pc.onconnectionstatechange;
    const finish = error => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      pc.onconnectionstatechange = previous ?? null;
      error ? reject(error) : resolve();
    };
    pc.onconnectionstatechange = event => {
      previous?.(event);
      if (pc.connectionState === 'connected') finish();
      else if (['failed', 'closed'].includes(pc.connectionState)) finish(new Error(`WebRTC connection ${pc.connectionState}`));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function pcmSamples(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== pcmConstants.PCM16K_10MS_BYTES) throw new Error('WebRTC source requires exactly 10 ms PCM16 at 16 kHz');
  const samples = new Int16Array(160);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2);
  return samples;
}

/** S20 D1 bitrate, shared with Web/iOS/Android. */
export const OPUS_MAX_AVERAGE_BITRATE = 32000;
/** S70: both gateways decode at ≤16 kHz, so stay wideband; separate so it rolls back alone (S20 invariant 5). */
export const OPUS_WIDEBAND_LIMIT = 'maxplaybackrate=16000;sprop-maxcapturerate=16000';
/** No `usedtx`: DTX silence breaks the Pixel playout buffer (S20 D1). */
export const OPUS_FMTP_PARAMETERS = `minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=${OPUS_MAX_AVERAGE_BITRATE};${OPUS_WIDEBAND_LIMIT}`;

/** Replaces (or inserts) the Opus fmtp line with the shared contract; SDP without Opus is returned untouched. Same as Web `rewriteOpusOffer`. */
export function rewriteOpusOffer(sdp) {
  if (typeof sdp !== 'string') return sdp;
  const lines = sdp.split('\n');
  const rtpIndex = lines.findIndex(line => /^a=rtpmap:\d+ opus\/48000(?:\/\d+)?\r?$/i.test(line));
  if (rtpIndex < 0) return sdp;
  const payload = /^a=rtpmap:(\d+)/.exec(lines[rtpIndex])[1];
  const line = `a=fmtp:${payload} ${OPUS_FMTP_PARAMETERS}${lines[rtpIndex].endsWith('\r') ? '\r' : ''}`;
  const fmtpIndex = lines.findIndex(candidate => candidate.startsWith(`a=fmtp:${payload} `));
  if (fmtpIndex >= 0) lines[fmtpIndex] = line; else lines.splice(rtpIndex + 1, 0, line);
  return lines.join('\n');
}

/** How long a `disconnected` ICE state may last before the peer is declared faulted (S25 决策 10). */
export const DISCONNECT_GRACE_MS = 10_000;

/** S73f: inbound audio RTP absent this long is a media gap (the gateway leg is down), not a silent caller. */
export const INBOUND_RTP_GAP_MS = 2_000;

/** A headless WebRTC client-role peer; it never receives a Control user token. */
export class ClientMediaPeer extends EventEmitter {
  constructor({ wrtc, pc, source, sourceTrack, sink, callId, mediaNodeId, mediaEpoch, signal, disconnectGraceMs = DISCONNECT_GRACE_MS, inboundRtpPollMs = 50,
    inboundRtpWatchMs = 250, inboundRtpGapMs = INBOUND_RTP_GAP_MS }) {
    super();
    Object.assign(this, { wrtc, pc, source, sourceTrack, sink, callId, mediaNodeId, mediaEpoch, disconnectGraceMs });
    this.closed = false;
    this.faulted = false;
    this.disconnectTimer = null;
    // S70d: the sink emits silence as soon as the track exists, so `pcm` proves nothing. The bridge
    // only writes our track once the gateway data channel delivers audio, so the first received RTP
    // packet is the proof that path is open. Emitted once as `inboundRtp`; polling stops on close.
    // S73f: polling continues (every `inboundRtpWatchMs`) after that first packet. The bridge keeps
    // the room while the gateway leg rejoins (S73) but forwards nothing, so a packet count that stops
    // growing for `inboundRtpGapMs` is `mediaGap` ({ sinceMs }), and growth after it `mediaResumed` ({ gapMs }).
    this.inboundRtpTimer = null;
    if (typeof pc.getStats === 'function') {
      let packets = 0, lastPacketAtMs = 0, inGap = false;
      const poll = async () => {
        this.inboundRtpTimer = null;
        let total = 0;
        try {
          (await pc.getStats()).forEach(report => {
            if (report.type === 'inbound-rtp' && (report.kind ?? report.mediaType) === 'audio') total += report.packetsReceived ?? 0;
          });
        } catch {}
        if (this.closed) return;
        const now = Date.now();
        if (total > packets) {
          if (!lastPacketAtMs) this.emit('inboundRtp');
          else if (inGap) { inGap = false; this.emit('mediaResumed', { gapMs: now - lastPacketAtMs }); }
          packets = total; lastPacketAtMs = now;
        } else if (lastPacketAtMs && !inGap && now - lastPacketAtMs > inboundRtpGapMs) {
          inGap = true; this.emit('mediaGap', { sinceMs: now - lastPacketAtMs });
        }
        this.inboundRtpTimer = setTimeout(poll, lastPacketAtMs ? inboundRtpWatchMs : inboundRtpPollMs);
        this.inboundRtpTimer.unref?.();
      };
      this.inboundRtpTimer = setTimeout(poll, inboundRtpPollMs);
      this.inboundRtpTimer.unref?.();
    }
    this.abort = () => this.close();
    signal?.addEventListener('abort', this.abort, { once: true });
    this.removeAbortListener = () => signal?.removeEventListener('abort', this.abort);
    // S25 决策 10: `disconnected` is libwebrtc's *transient* state (a few missed ICE checks); the
    // 2026-09-12 calls through the tunnel hit it 20-50 s in and were hung up at once. Give the pair
    // a bounded chance to come back; only `failed`/`closed`, or a grace period that expires, fault.
    // Every fault carries an ICE pair snapshot so the post-mortem does not depend on the bridge.
    const fault = async state => {
      if (this.closed || this.faulted) return;
      this.faulted = true;
      const error = new Error(`WebRTC connection ${state}`);
      error.iceStats = await this.iceSnapshot();
      this.emit('fault', error);
    };
    pc.onconnectionstatechange = () => {
      if (this.closed || this.faulted) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        // Only a recovery from `disconnected` is worth a notice; the first connected transition is not.
        if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; this.emit('reconnected'); }
        return;
      }
      if (state === 'failed' || state === 'closed') { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; void fault(state); return; }
      if (state === 'disconnected' && !this.disconnectTimer) {
        this.emit('disconnected');
        this.disconnectTimer = setTimeout(() => { this.disconnectTimer = null; void fault('disconnected'); }, this.disconnectGraceMs);
        this.disconnectTimer.unref?.();
      }
    };
    if (signal?.aborted) {
      this.close();
      throw abortError(signal);
    }
  }

  static async connect({ wrtc, signaling, callId, transport = 'udp', signal, timeoutMs = 20_000, allowNonRelayForTest = false,
    relaySettleMs = 1_000, gatheringCapMs = 12_000 }) {
    if (!UUID.test(callId)) throw new Error('Invalid call ID');
    if (transport !== 'udp' && transport !== 'tls') throw new Error('Media transport must be udp or tls');
    if (!wrtc?.RTCPeerConnection || !wrtc?.nonstandard?.RTCAudioSource || !wrtc?.nonstandard?.RTCAudioSink) throw new Error('WebRTC programmatic audio is unavailable');
    throwIfAborted(signal);
    if (allowNonRelayForTest && process.env.NODE_ENV !== 'test') throw new Error('Non-relay ICE is test-only');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error('Invalid media connection timeout');
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error('Media connection timed out')), timeoutMs);
    const operationSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let pc, source, sourceTrack, sink, peer, gathering;
    try {
      const options = await abortable(signaling.options(callId, transport, operationSignal), operationSignal);
      if (!allowNonRelayForTest && options.iceTransportPolicy !== 'relay') throw new Error('Relay-only ICE is required');
      if (!allowNonRelayForTest && (!Array.isArray(options.iceServers) || options.iceServers.length !== 1)) throw new Error('Exactly one TURN server is required');
      if (!allowNonRelayForTest) {
        const urls = options.iceServers.flatMap(server => Array.isArray(server?.urls) ? server.urls : [server?.urls]);
        if (urls.length !== 1) throw new Error('Exactly one TURN URL is required');
        if (!TURN_URL[transport].test(urls[0])) throw new Error('TURN URL does not match the requested transport');
      }
      pc = new wrtc.RTCPeerConnection({ iceServers: options.iceServers, iceTransportPolicy: options.iceTransportPolicy });
      source = new wrtc.nonstandard.RTCAudioSource();
      sourceTrack = source.createTrack();
      pc.addTrack(sourceTrack);
      pc.ontrack = event => {
        if (sink || event.track?.kind !== 'audio') return;
        sink = new wrtc.nonstandard.RTCAudioSink(event.track);
        sink.ondata = data => {
          if (!peer || peer.closed) return;
          if (data.bitsPerSample !== 16 || data.channelCount !== 1 || ![16_000, 48_000].includes(data.sampleRate)) {
            peer.emit('fault', new Error('Unsupported WebRTC PCM format'));
            return;
          }
          const samples = data.samples;
          const pcm = Buffer.allocUnsafe(samples.length * 2);
          for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
          peer.emit('pcm', { pcm, sampleRate: data.sampleRate, numberOfFrames: data.numberOfFrames });
        };
        if (peer) peer.sink = sink;
      };
      // Attached before setLocalDescription: gathering starts there and the first relay candidate
      // can arrive within ~120 ms.
      gathering = watchRelayGathering(pc, operationSignal, { settleMs: relaySettleMs, capMs: Math.min(timeoutMs, gatheringCapMs) });
      const offer = await abortable(pc.createOffer(), operationSignal);
      // S70: the fmtp is fixed before setLocalDescription, so the encoder and the SDP sent to the bridge agree.
      await abortable(pc.setLocalDescription({ type: offer.type, sdp: rewriteOpusOffer(offer.sdp) }), operationSignal);
      await gathering.promise;
      const answer = await abortable(signaling.offer(callId, { type: 'offer', sdp: pc.localDescription.sdp }, operationSignal), operationSignal);
      if (answer?.type !== 'answer' || typeof answer.sdp !== 'string' || Buffer.byteLength(answer.sdp) > 128 * 1024) throw new Error('Invalid media answer');
      await abortable(pc.setRemoteDescription(answer), operationSignal);
      await waitForConnected(pc, operationSignal, timeoutMs);
      throwIfAborted(operationSignal);
      peer = new ClientMediaPeer({ wrtc, pc, source, sourceTrack, sink, callId, mediaNodeId: options.mediaNodeId, mediaEpoch: options.mediaEpoch, signal: operationSignal });
      return peer;
    } catch (error) {
      try { gathering?.cancel(); } catch {}
      try { sink?.stop(); } catch {}
      try { sourceTrack.stop(); } catch {}
      try { pc.close(); } catch {}
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  writePcm16k10ms(pcm) {
    if (this.closed) throw new Error('Media peer is closed');
    this.source.onData({ samples: pcmSamples(pcm), sampleRate: 16_000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 160 });
  }

  /**
   * Bounded ICE forensics for the selected candidate pair: types, protocols, RTT, byte counts and
   * how long ago the last packet arrived. Numbers only; no address or credential ever leaves here.
   */
  async iceSnapshot() {
    const out = { connectionState: this.pc.connectionState, iceConnectionState: this.pc.iceConnectionState ?? null };
    try {
      const stats = await Promise.race([this.pc.getStats(), new Promise(resolve => setTimeout(resolve, 1_000, null))]);
      if (!stats) return out;
      const byId = new Map(); stats.forEach(report => byId.set(report.id, report));
      let pair = null;
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && (report.selected || report.nominated) && report.state === 'succeeded' && (!pair || (report.bytesSent ?? 0) > (pair.bytesSent ?? 0))) pair = report;
      });
      if (!pair) stats.forEach(report => { if (report.type === 'candidate-pair' && (!pair || (report.bytesSent ?? 0) > (pair.bytesSent ?? 0))) pair = report; });
      if (pair) {
        const local = byId.get(pair.localCandidateId), remote = byId.get(pair.remoteCandidateId);
        out.pair = {
          state: pair.state, local: `${local?.candidateType ?? '?'}/${local?.protocol ?? '?'}/${local?.relayProtocol ?? '-'}`, remote: `${remote?.candidateType ?? '?'}/${remote?.protocol ?? '?'}`,
          rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
          bytesSent: pair.bytesSent ?? null, bytesReceived: pair.bytesReceived ?? null,
          requestsSent: pair.requestsSent ?? null, responsesReceived: pair.responsesReceived ?? null,
          consentRequestsSent: pair.consentRequestsSent ?? null,
          sinceLastPacketReceivedMs: pair.lastPacketReceivedTimestamp ? Math.max(0, Math.round(Date.now() - pair.lastPacketReceivedTimestamp)) : null,
          sinceLastPacketSentMs: pair.lastPacketSentTimestamp ? Math.max(0, Math.round(Date.now() - pair.lastPacketSentTimestamp)) : null,
        };
      }
      let pairs = 0; stats.forEach(report => { if (report.type === 'candidate-pair') pairs++; }); out.candidatePairs = pairs;
    } catch {}
    return out;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
    clearTimeout(this.inboundRtpTimer); this.inboundRtpTimer = null;
    this.removeAbortListener?.();
    this.pc.onconnectionstatechange = null;
    try { this.sink?.stop(); } catch {}
    try { this.sourceTrack.stop(); } catch {}
    try { this.pc.close(); } catch {}
    this.emit('closed');
  }
}

export async function loadWrtc() {
  const module = await import('@roamhq/wrtc');
  return module.default ?? module;
}
