import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import test from 'node:test';
import {validTranscriptionAudio} from './audio-format.js';
import {RegistryRecordingReader, type PixelTranscriptSource} from './reader.js';
import {splitCanonicalWav} from './wav-chunks.js';
import {freezeRecordingManifest, TranscriptionWorker} from './worker.js';
import type {PixelRecordingDescriptor} from '../recording-archive.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Canonical 16 kHz mono PCM16 WAV of `ms`, loud everywhere except silent 20 ms frames at `quietAtMs`. */
function speechWav(ms: number, quietAtMs: number[] = []): Buffer {
  const samples = ms * 16, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let offset = 44; offset < bytes.length; offset += 2) bytes.writeInt16LE(offset % 4 ? -8000 : 8000, offset);
  for (const at of quietAtMs) bytes.fill(0, 44 + at * 32, 44 + (at + 20) * 32);
  return bytes;
}

test('long canonical WAV splits into valid pieces cut on the quietest frame, covering every sample in order', () => {
  // 13 s, 5 s pieces, 2 s search window: quiet frames at 4.2 s and 8.8 s are inside the windows.
  const source = speechWav(13_000, [4_200, 8_800]);
  const chunks = splitCanonicalWav(source, 5_000, 2_000);
  assert.deepEqual(chunks.map((chunk) => chunk.startMs), [0, 4_200, 8_800]);
  for (const chunk of chunks) {
    assert.ok(validTranscriptionAudio(chunk.bytes, 'audio/wav', 2));
    assert.ok(chunk.bytes.length - 44 <= 5_000 * 32);
  }
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => chunk.bytes.subarray(44))), source.subarray(44));
  // Without any quiet frame the cut falls at the limit's search window start, still ≤ max and lossless.
  const flat = speechWav(12_000), flatChunks = splitCanonicalWav(flat, 5_000, 2_000);
  assert.ok(flatChunks.every((chunk) => chunk.bytes.length - 44 <= 5_000 * 32 && validTranscriptionAudio(chunk.bytes, 'audio/wav', 3)));
  assert.deepEqual(Buffer.concat(flatChunks.map((chunk) => chunk.bytes.subarray(44))), flat.subarray(44));
  // At or under the limit: one piece, byte-identical to the source.
  assert.deepEqual(splitCanonicalWav(speechWav(5_000), 5_000, 2_000).map((chunk) => chunk.bytes), [speechWav(5_000)]);
});

test('a Pixel track over 20 MiB is transcribed in timed pieces and merged; a short track still goes whole', async () => {
  const callId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  // 12 min remote (23 MB > 20 MiB) and a 3 s caller track.
  const bodies = {remote_original: speechWav(12 * 60_000), caller_original: speechWav(3_000)};
  const manifest: PixelRecordingDescriptor = {
    source: 'pixel', version: 2, archiveId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', callId,
    manifestSha256: 'a'.repeat(64), archiveComplete: true, captureComplete: true,
    startedAt: '2026-09-20T06:00:00.000Z', endedAt: '2026-09-20T06:12:00.000Z',
    tracks: (['remote_original', 'caller_original'] as const).map((track) => ({track, sourceRole: 'original_capture', mediaType: 'audio/wav',
      bytes: bodies[track].length, sha256: sha(bodies[track]), captureComplete: true, gapCount: 0, droppedFrames: 0})),
    timeline: {mediaType: 'application/x-ndjson', bytes: 3, sha256: sha(Buffer.from('{}\n'))},
  };
  let result: any, failure: any, claimed = false;
  const repository = {
    claim: async () => claimed ? null : (claimed = true, {id: 'job', callId, snapshotOwnerId: ownerId, manifest,
      manifestFingerprint: freezeRecordingManifest(manifest, callId).fingerprint, leaseToken: 'lease', attempts: 1}),
    renewLease: async () => true,
    complete: async (input: any) => { result = input.result; return true; },
    fail: async (input: any) => { failure = input; return true; },
  };
  const source: PixelTranscriptSource = {
    manifest: async () => manifest,
    openTrack: async (_id, track) => {
      const bytes = bodies[track as keyof typeof bodies];
      return {stream: Readable.from([bytes]), size: bytes.length, sha256: sha(bytes), complete: true, partial: false, start: 0, end: bytes.length - 1};
    },
  };
  const db = {query: async () => ({rowCount: 1, rows: [{media_node_id: 'relay-primary', media_epoch: 1}]})};
  const sent: Array<{track: string; bytes: number}> = [];
  let piece = 0;
  const worker = new TranscriptionWorker(repository as never, {enabled: true,
    reader: new RegistryRecordingReader(db as never, () => { throw new Error('media source unused'); }, source),
    provider: {
      transcribe: async (bytes, context) => {
        assert.ok(bytes.length <= 20 * 1024 * 1024 && validTranscriptionAudio(bytes, context.mediaType, context.formatVersion));
        sent.push({track: context.track, bytes: bytes.length});
        if (context.track === 'caller_original') return {text: 'caller whole', provider: 'synthetic', model: 'test'};
        const index = piece++;
        // The second piece has no speech; it must not fail the track.
        if (index === 1) return {text: '', provider: 'synthetic', model: 'test'};
        return {text: `part ${index}`, segments: [{text: `part ${index}`, startMs: 1_000, endMs: 2_000}], provider: 'synthetic', model: 'test'};
      },
    },
  });
  assert.equal(await worker.tickOnce(), 'succeeded', JSON.stringify(failure ?? null));
  // 12 min in ≤5 min pieces = 3 remote requests, caller sent whole and byte-identical.
  assert.equal(sent.filter((item) => item.track === 'remote_original').length, 3);
  assert.deepEqual(sent.filter((item) => item.track === 'caller_original'), [{track: 'caller_original', bytes: bodies.caller_original.length}]);
  const remote = result.segments.filter((segment: any) => segment.track === 'remote_original');
  assert.deepEqual(remote.map((segment: any) => segment.text), ['part 0', 'part 2']);
  assert.equal(remote[0].startMs, 1_000);
  // Uniform audio cuts at each search window's first frame: 290 s, then 580 s. The third piece's
  // 1 s segment lands at 580 s + 1 s on the track timeline.
  assert.equal(remote[1].startMs, 581_000);
  assert.equal(remote[1].endMs - remote[1].startMs, 1_000);
  assert.match(result.text, /remote: part 0\npart 2/);
  assert.equal(result.recording.complete, true);
});
