/** Only formats emitted by the reviewed recording writers are accepted. */
export function validTranscriptionAudio(bytes: Buffer, mediaType: string, version: number): boolean {
  if (mediaType === 'audio/ogg' && version === 1) return bytes.subarray(0, 4).toString('ascii') === 'OggS';
  if (mediaType !== 'audio/wav' || (version !== 2 && version !== 3) || bytes.length < 44) return false;
  // Pixel's canonical PCM writer has exactly one 16-byte fmt chunk and one data chunk.
  // Do not accept headers claiming compressed/other PCM or trailing data under a WAV label.
  // latin1 preserves high bits; Node's ascii decoding would accept corrupted magic bytes.
  return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString('latin1', 8, 12) === 'WAVE' && bytes.toString('latin1', 12, 16) === 'fmt ' &&
    bytes.readUInt32LE(16) === 16 && bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt32LE(24) === 16_000 && bytes.readUInt32LE(28) === 32_000 &&
    bytes.readUInt16LE(32) === 2 && bytes.readUInt16LE(34) === 16 &&
    bytes.toString('latin1', 36, 40) === 'data' && bytes.readUInt32LE(40) === bytes.length - 44 &&
    (bytes.length - 44) % 2 === 0;
}

export type AllZeroPcmEvidence = {
  reason: 'all_zero_pcm'; detector: 'pcm16_all_zero_v1'; sampleCount: number; durationMs: number;
};

export type NoVoiceEvidence = {
  reason: 'no_voice_activity'; detector: 'pcm16_voiced_run_v1'; sampleCount: number; durationMs: number; longestVoicedMs: number;
};

const VOICE_FRAME_SAMPLES = 320; // 20 ms at 16 kHz
/** -50 dBFS mean-square per frame. Measured 2026-09-27: phone speech runs well above it, the line floor sits at -80…-90. */
const VOICE_FRAME_ENERGY = (32768 * 10 ** (-50 / 20)) ** 2 * VOICE_FRAME_SAMPLES;
/** S78: a spoken syllable keeps energy for ≥160 ms; key clicks and line pops last ≤100 ms.
 * Measured on 25 archived caller tracks: every hallucinated transcript came from a track whose longest
 * run was ≤100 ms, the shortest real utterance ran 300 ms. */
export const MIN_VOICED_RUN_MS = 160;

/** Proof that a PCM track holds no speech: no run of ≥160 ms of 20 ms frames above -50 dBFS.
 * ASR models answer such tracks with invented dialogue, so they never reach the provider. Call only after verifying the source SHA. */
export function noVoiceEvidence(bytes: Buffer, mediaType: string, version: number): NoVoiceEvidence | null {
  if (mediaType !== 'audio/wav' || !validTranscriptionAudio(bytes, mediaType, version) || bytes.length === 44) return null;
  const frameBytes = VOICE_FRAME_SAMPLES * 2, needFrames = MIN_VOICED_RUN_MS / 20;
  let run = 0, longest = 0;
  for (let frame = 44; frame + frameBytes <= bytes.length; frame += frameBytes) {
    let energy = 0;
    for (let offset = frame; offset < frame + frameBytes; offset += 2) { const sample = bytes.readInt16LE(offset); energy += sample * sample; }
    run = energy > VOICE_FRAME_ENERGY ? run + 1 : 0;
    if (run > longest) longest = run;
    if (longest >= needFrames) return null;
  }
  const sampleCount = (bytes.length - 44) / 2;
  return {reason: 'no_voice_activity', detector: 'pcm16_voiced_run_v1', sampleCount, durationMs: sampleCount / 16, longestVoicedMs: longest * 20};
}

/** Proof of digital silence, not a voice/volume threshold. Call only after verifying the source SHA. */
export function allZeroPcmEvidence(bytes: Buffer, mediaType: string, version: number): AllZeroPcmEvidence | null {
  if (mediaType !== 'audio/wav' || !validTranscriptionAudio(bytes, mediaType, version) || bytes.length === 44) return null;
  // In signed PCM16, a sample is zero iff both bytes are zero. Inspect the entire data chunk.
  for (let offset = 44; offset < bytes.length; offset++) {
    if (bytes[offset] !== 0) return null;
  }
  const sampleCount = (bytes.length - 44) / 2;
  return {reason: 'all_zero_pcm', detector: 'pcm16_all_zero_v1', sampleCount, durationMs: sampleCount / 16};
}
