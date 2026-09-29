const PCM16K_10MS_BYTES = 320;
const PCM16K_20MS_BYTES = 640;

function pcmBufferToSamples(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length % 2 !== 0) throw new Error('PCM16LE must contain complete samples');
  const result = new Int16Array(buffer.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = buffer.readInt16LE(i * 2);
  return result;
}

function samplesToPcmBuffer(samples) {
  const result = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), i * 2);
  return result;
}

function lowPassTaps(length = 63, cutoffCyclesPerSample = 0.145) {
  const middle = (length - 1) / 2;
  const taps = new Float64Array(length);
  let sum = 0;
  for (let n = 0; n < length; n++) {
    const x = n - middle;
    const sinc = x === 0 ? 2 * cutoffCyclesPerSample : Math.sin(2 * Math.PI * cutoffCyclesPerSample * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (length - 1));
    taps[n] = sinc * window;
    sum += taps[n];
  }
  for (let n = 0; n < taps.length; n++) taps[n] /= sum;
  return taps;
}

/** Stateful 48 kHz to 16 kHz PCM16 mono conversion with an anti-alias FIR. */
export class Pcm16kResampler {
  constructor() {
    this.taps = lowPassTaps();
    this.history = new Float64Array(this.taps.length);
    this.cursor = 0;
    this.phase = 0;
  }

  process(pcm, sampleRate) {
    const input = pcmBufferToSamples(pcm);
    if (sampleRate === 16_000) return Buffer.from(pcm);
    if (sampleRate !== 48_000) throw new Error('Only 16 kHz or 48 kHz mono PCM is supported');
    const output = [];
    for (const sample of input) {
      this.history[this.cursor] = sample;
      this.cursor = (this.cursor + 1) % this.history.length;
      if (this.phase === 0) {
        let value = 0;
        for (let tap = 0; tap < this.taps.length; tap++) {
          const index = (this.cursor - 1 - tap + this.history.length) % this.history.length;
          value += this.history[index] * this.taps[tap];
        }
        output.push(value);
      }
      this.phase = (this.phase + 1) % 3;
    }
    return samplesToPcmBuffer(output);
  }
}

/**
 * S27 决策 5: stateful 24 kHz → 16 kHz PCM16 mono conversion, for a provider whose output rate is
 * fixed at 24 kHz while everything downstream of `agent.on('audio')` assumes 16 kHz — the playback
 * queue slices by byte count and never reads `sampleRate`, so an unconverted delta would play about
 * 1.5× too fast with nothing in the logs to say why.
 *
 * The ratio is 2/3: zero-stuff by 2 to an intermediate 48 kHz, low-pass, then decimate by 3. That
 * is the same ~7 kHz cutoff `Pcm16kResampler` already needs for 48 → 16, so the identical 63-tap
 * Hamming sinc is reused; the ×2 gain compensates the energy lost to the inserted zeros. The FIR
 * history, the decimation phase and the up-sampling are all carried across chunks, so a delta split
 * at any byte boundary produces the same samples as one contiguous buffer and nothing is dropped.
 *
 * Runs inside the provider thread (48 MB old-space cap): one Float64Array per delta, sized exactly,
 * and no growing buffer is kept between calls.
 */
export class Pcm24kTo16kResampler {
  constructor() {
    this.taps = lowPassTaps();
    this.history = new Float64Array(this.taps.length);
    this.cursor = 0;
    this.phase = 0;
  }

  process(pcm) {
    return this.resample(pcmBufferToSamples(pcm));
  }

  /**
   * S70: 32-bit LE float [-1,1] in, resampled in the float domain and quantized to int16 once at the
   * end (was: quantize to int16, filter, quantize again). Out-of-range values clamp, NaN/∞ become 0.
   */
  processFloat32(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length % 4 !== 0) throw new Error('f32le must contain complete samples');
    const input = new Float64Array(bytes.length >>> 2);
    for (let i = 0; i < input.length; i++) {
      const value = bytes.readFloatLE(i * 4);
      input[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) * 32_767 : 0;
    }
    return this.resample(input);
  }

  resample(input) {
    // Two intermediate samples per input sample, one output for every third of them.
    const output = new Float64Array(Math.ceil((input.length * 2 + 2) / 3));
    let count = 0;
    for (const sample of input) {
      for (let up = 0; up < 2; up++) {
        this.history[this.cursor] = up === 0 ? sample * 2 : 0;
        this.cursor = (this.cursor + 1) % this.history.length;
        if (this.phase === 0) {
          let value = 0;
          for (let tap = 0; tap < this.taps.length; tap++) {
            const index = (this.cursor - 1 - tap + this.history.length) % this.history.length;
            value += this.history[index] * this.taps[tap];
          }
          output[count++] = value;
        }
        this.phase = (this.phase + 1) % 3;
      }
    }
    return samplesToPcmBuffer(output.subarray(0, count));
  }
}

/** Reframes arbitrary PCM chunks into monotonic 20 ms provider frames. */
export class Pcm20msFramer {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.sequence = 0;
    this.nextCapturedAtUs = null;
  }

  push(pcm16k, capturedAtUs) {
    if (!Buffer.isBuffer(pcm16k) || pcm16k.length % 2) throw new Error('PCM16LE must contain complete samples');
    if (!Number.isSafeInteger(capturedAtUs) || capturedAtUs < 0) throw new Error('capturedAtUs must be monotonic');
    if (this.nextCapturedAtUs === null) this.nextCapturedAtUs = capturedAtUs;
    this.pending = Buffer.concat([this.pending, pcm16k]);
    const frames = [];
    while (this.pending.length >= PCM16K_20MS_BYTES) {
      const pcm = this.pending.subarray(0, PCM16K_20MS_BYTES);
      this.pending = this.pending.subarray(PCM16K_20MS_BYTES);
      frames.push({
        sequence: this.sequence++,
        capturedAtUs: this.nextCapturedAtUs,
        durationMs: 20,
        sampleRate: 16_000,
        pcm16le: Buffer.from(pcm),
      });
      this.nextCapturedAtUs += 20_000;
    }
    return frames;
  }

  reset() {
    this.pending = Buffer.alloc(0);
    this.nextCapturedAtUs = null;
  }
}

/** Batches five verified 20 ms frames into the provider's recommended 100 ms append. */
export class ProviderInputBatcher {
  constructor({ maxFrames = 25 } = {}) {
    if (!Number.isInteger(maxFrames) || maxFrames < 5 || maxFrames > 50) throw new Error('Invalid provider input bound');
    this.maxFrames = maxFrames;
    this.frames = [];
    this.droppedFrames = 0;
    this.lastSequence = -1;
  }

  push(frame) {
    if (frame.durationMs !== 20 || frame.sampleRate !== 16_000 || frame.pcm16le?.length !== PCM16K_20MS_BYTES) throw new Error('Expected one 20 ms PCM16 16 kHz frame');
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= this.lastSequence) throw new Error('PCM frame sequence must increase');
    this.lastSequence = frame.sequence;
    this.frames.push(frame);
    while (this.frames.length > this.maxFrames) {
      this.frames.shift();
      this.droppedFrames++;
    }
    if (this.frames.length < 5) return null;
    const batch = this.frames.splice(0, 5);
    return {
      sequence: batch.at(-1).sequence,
      firstCapturedAtUs: batch[0].capturedAtUs,
      pcm16le: Buffer.concat(batch.map(item => item.pcm16le)),
    };
  }

  reset() {
    this.frames.length = 0;
    this.lastSequence = -1;
  }
}

/** Strict ACTIVE gate plus a bounded generation-fenced playback queue. */
export class GenerationPlaybackQueue {
  // 60 seconds. A provider may deliver a whole reply as one burst, and the Space
  // agent's own opener arrives that way at every session start (~4.8 s at 16 kHz).
  // The bound exists to cap memory (1.9 MB), never to end a call: going past it
  // drops the newest chunk and reports it, because a caller who hears a clipped
  // sentence is still in a working call.
  constructor({ maxFrames = 3_000, onOverflow = () => {} } = {}) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 6_000) throw new Error('Invalid playback bound');
    this.maxFrames = maxFrames;
    this.onOverflow = typeof onOverflow === 'function' ? onOverflow : () => {};
    this.overflowNotified = new Set();
    this.active = false;
    this.generation = 0;
    this.pendingBytes = Buffer.alloc(0);
    this.frames = [];
    this.half = null;
    this.droppedFrames = 0;
    this.staleChunks = 0;
    this.inactiveChunks = 0;
    this.accounting = new Map();
  }

  account(generation = this.generation) {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid audio generation');
    if (!this.accounting.has(generation)) {
      this.accounting.set(generation, { generation, receivedBytes: 0, enqueuedBytes: 0, playedBytes: 0,
        clearedBytes: 0, tailPaddingBytes: 0, inactiveBytes: 0, staleBytes: 0, overflowBytes: 0 });
      if (this.accounting.size > 100) {
        const oldest = [...this.accounting.keys()].find(key => key !== this.generation && key !== generation);
        this.accounting.delete(oldest);
      }
    }
    return this.accounting.get(generation);
  }

  queuedBytes() {
    return this.frames.length * PCM16K_20MS_BYTES + (this.half?.length ?? 0) + this.pendingBytes.length;
  }

  setActive(active) {
    this.active = Boolean(active);
    if (!this.active) this.clear();
  }

  advanceGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) throw new Error('Playback generation must increase');
    this.clear();
    this.generation = generation;
  }

  enqueue(pcm16k, generation) {
    if (!Buffer.isBuffer(pcm16k) || pcm16k.length % 2) throw new Error('PCM16LE must contain complete samples');
    const stats = this.account(generation);
    stats.receivedBytes += pcm16k.length;
    if (!this.active) { this.inactiveChunks++; stats.inactiveBytes += pcm16k.length; return false; }
    if (generation !== this.generation) { this.staleChunks++; stats.staleBytes += pcm16k.length; return false; }
    if (this.queuedBytes() + pcm16k.length > this.maxFrames * PCM16K_20MS_BYTES) {
      // Drop the newest chunk: what is already queued is the start of the phrase
      // the caller is listening to. One report per generation keeps a runaway
      // provider from turning into a log flood.
      stats.overflowBytes += pcm16k.length;
      this.droppedFrames += Math.ceil(pcm16k.length / PCM16K_20MS_BYTES);
      if (!this.overflowNotified.has(this.generation)) {
        this.overflowNotified.add(this.generation);
        if (this.overflowNotified.size > 100) this.overflowNotified.delete(this.overflowNotified.values().next().value);
        this.onOverflow({ generation: this.generation, droppedBytes: pcm16k.length, queuedBytes: this.queuedBytes(), maxFrames: this.maxFrames });
      }
      return false;
    }
    stats.enqueuedBytes += pcm16k.length;
    this.pendingBytes = Buffer.concat([this.pendingBytes, pcm16k]);
    while (this.pendingBytes.length >= PCM16K_20MS_BYTES) {
      this.frames.push(Buffer.from(this.pendingBytes.subarray(0, PCM16K_20MS_BYTES)));
      this.pendingBytes = this.pendingBytes.subarray(PCM16K_20MS_BYTES);
    }
    return true;
  }

  finishGeneration(generation) {
    if (!this.active || generation !== this.generation || !this.pendingBytes.length) return;
    const padding = PCM16K_20MS_BYTES - this.pendingBytes.length;
    // At most one partial frame is padded; no provider samples are discarded.
    this.frames.push(Buffer.concat([this.pendingBytes, Buffer.alloc(padding)]));
    this.account().tailPaddingBytes += padding;
    this.pendingBytes = Buffer.alloc(0);
  }

  take10ms() {
    if (!this.active) return null;
    let result;
    if (this.half) {
      result = this.half;
      this.half = null;
    } else {
      const frame = this.frames.shift();
      if (!frame) return null;
      result = frame.subarray(0, PCM16K_10MS_BYTES);
      this.half = frame.subarray(PCM16K_10MS_BYTES);
    }
    this.account().playedBytes += result.length;
    return result;
  }

  clear() {
    this.account().clearedBytes += this.queuedBytes();
    this.pendingBytes = Buffer.alloc(0);
    this.frames.length = 0;
    this.half = null;
  }

  stats() {
    return { queuedFrames: this.frames.length + (this.half ? 0.5 : 0), queuedBytes: this.queuedBytes(),
      droppedFrames: this.droppedFrames, staleChunks: this.staleChunks, inactiveChunks: this.inactiveChunks,
      generations: [...this.accounting.values()].map(value => ({...value})) };
  }
}

export const pcmConstants = { PCM16K_10MS_BYTES, PCM16K_20MS_BYTES };

/**
 * S24 决策 2: hand PCM to another thread without copying the allocator's slab with it.
 * Node pools small `Buffer`s (`Buffer.concat` of 3.2 kB, `Buffer.from(base64)` of a delta) inside a
 * shared 8 kB `ArrayBuffer`; transferring that pooled backing store would detach every other live
 * view of the same pool. Only a buffer that owns its whole backing store may be transferred as is;
 * anything else is copied out first, which is still one copy — the same one structured clone would
 * have made — and never a use-after-detach.
 */
export function transferableBytes(view) {
  if (!ArrayBuffer.isView(view)) throw new Error('Expected a typed array view of PCM bytes');
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
