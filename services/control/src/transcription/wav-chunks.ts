/**
 * Long Pixel calls: canonical PCM WAV (16 kHz mono PCM16 = 32 000 B/s) passes the 20 MiB provider
 * input cap at ~10.9 min. Such a track is cut into canonical WAV pieces that each pass
 * `validTranscriptionAudio` unchanged and are transcribed one after another.
 */
const HEADER_BYTES = 44;
const BYTES_PER_MS = 32;
const FRAME_BYTES = 20 * BYTES_PER_MS;
/** Hard cap for one Pixel WAV track (~52 min). The whole track is held once in memory for SHA and
 * silence checks. ponytail: 1× in-memory ceiling; spool to a temp file if calls outgrow it. */
export const MAX_WAV_TRACK_BYTES = 96 * 1024 * 1024;
/** 5 min = 9.6 MB raw / 12.8 MB base64: well inside the proxy's 60 s cut and the 8192-token answer. */
export const WAV_CHUNK_MAX_MS = 5 * 60_000;

export type WavChunk = {startMs: number; bytes: Buffer};

/** Canonical 44-byte header around a PCM slice, same layout `validTranscriptionAudio` requires. */
function canonicalWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Splits a verified canonical WAV into pieces of at most `maxMs`, each cut at the quietest 20 ms
 * frame within the last `searchMs` before the limit so a boundary rarely lands mid-word. */
export function splitCanonicalWav(wav: Buffer, maxMs = WAV_CHUNK_MAX_MS, searchMs = 10_000): WavChunk[] {
  const pcm = wav.subarray(HEADER_BYTES);
  const maxBytes = Math.floor(maxMs / 20) * FRAME_BYTES, searchBytes = Math.floor(searchMs / 20) * FRAME_BYTES;
  if (maxBytes < FRAME_BYTES * 2) throw new Error('WAV chunk length is too short');
  const chunks: WavChunk[] = [];
  let start = 0;
  while (pcm.length - start > maxBytes) {
    const limit = start + maxBytes;
    let cut = limit, quietest = Infinity;
    for (let frame = Math.max(start + FRAME_BYTES, limit - searchBytes); frame + FRAME_BYTES <= limit; frame += FRAME_BYTES) {
      let energy = 0;
      for (let offset = frame; offset < frame + FRAME_BYTES; offset += 2) energy += Math.abs(pcm.readInt16LE(offset));
      if (energy < quietest) { quietest = energy; cut = frame; }
    }
    chunks.push({startMs: start / BYTES_PER_MS, bytes: canonicalWav(pcm.subarray(start, cut))});
    start = cut;
  }
  chunks.push({startMs: start / BYTES_PER_MS, bytes: canonicalWav(pcm.subarray(start))});
  return chunks;
}
