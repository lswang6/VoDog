import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import test from 'node:test';
import {allZeroPcmEvidence, noVoiceEvidence} from './audio-format.js';
import {RegistryRecordingReader, type PixelTranscriptSource} from './reader.js';
import {freezeRecordingManifest, TranscriptionWorker, type AiTranscriptLine, type RecordingReader} from './worker.js';
import type {PixelRecordingDescriptor} from '../recording-archive.js';

const callId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const trackIds = ['remote_original', 'caller_original'] as const;
type Track = typeof trackIds[number];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function wav(sampleCount = 410_880): Buffer {
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

function speech(): Buffer {
  const bytes = wav();
  // Deterministic non-silent PCM fixture; ASR itself is injected, never networked.
  for (let offset = 44; offset < bytes.length; offset += 2) bytes.writeInt16LE(offset % 4 ? -8000 : 8000, offset);
  return bytes;
}

function recording(remote: Buffer, caller: Buffer, version: 2 | 3 = 2, captureComplete = true) {
  const bodies: Record<Track, Buffer> = {remote_original: remote, caller_original: caller};
  const manifest: PixelRecordingDescriptor = {
    source: 'pixel', version, archiveId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', callId,
    manifestSha256: 'a'.repeat(64), archiveComplete: true, captureComplete,
    startedAt: '2026-09-20T06:34:46.000Z', endedAt: '2026-09-20T06:35:11.680Z',
    tracks: trackIds.map(track => ({track, sourceRole: 'original_capture', mediaType: 'audio/wav',
      bytes: bodies[track].length, sha256: sha(bodies[track]), captureComplete,
      gapCount: captureComplete ? 0 : 1, droppedFrames: captureComplete ? 0 : 2})),
    ...(version === 3 ? {derivedTracks: [{track: 'caller_playout' as const, sourceRole: 'derived_playout' as const,
      mediaType: 'audio/wav' as const, bytes: remote.length, sha256: sha(remote),
      playoutComplete: true, gapCount: 0, recoveryFrames: 1}]} : {}),
    timeline: {mediaType: 'application/x-ndjson', bytes: 3, sha256: sha(Buffer.from('{}\n'))},
  };
  return {manifest, bodies};
}

/** A tone burst of `ms` at `dbfs`, starting at `atMs`, over the line floor. */
function burst(bytes: Buffer, atMs: number, ms: number, dbfs: number): Buffer {
  const amplitude = Math.round(32768 * 10 ** (dbfs / 20) * Math.SQRT2);
  for (let i = 0; i < ms * 16; i++) bytes.writeInt16LE(Math.round(amplitude * Math.sin(i / 3)), 44 + (atMs * 16 + i) * 2);
  return bytes;
}

async function run(fixture: ReturnType<typeof recording>, options: {reader?: RecordingReader; aiLines?: AiTranscriptLine[]; answer?: (track: string) => {text: string; segments?: []}} = {}) {
  let result: any, failure: any, claimed = false, aiReads = 0;
  const providerTracks: string[] = [], classified: Array<{text: string; segments: unknown[]}> = [];
  const fingerprint = freezeRecordingManifest(fixture.manifest, callId).fingerprint;
  const originalManifest = structuredClone(fixture.manifest);
  const repository = {
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return {id: 'test-job', callId, snapshotOwnerId: ownerId, manifest: fixture.manifest,
        manifestFingerprint: fingerprint, leaseToken: 'test-lease', attempts: 1};
    },
    renewLease: async () => true,
    complete: async (input: any) => { result = input.result; return true; },
    fail: async (input: any) => { failure = input; return true; },
  };
  const source: PixelTranscriptSource = {
    manifest: async () => fixture.manifest,
    openTrack: async (_id, track) => {
      assert.ok(trackIds.includes(track as Track), 'derived audio must not be read');
      const bytes = fixture.bodies[track as Track];
      return {stream: Readable.from([bytes]), size: bytes.length, sha256: sha(bytes),
        complete: true, partial: false, start: 0, end: bytes.length - 1};
    },
  };
  const db = {query: async () => ({rowCount: 1, rows: [{media_node_id: 'relay-primary', media_epoch: 1}]})};
  const reader = options.reader ?? new RegistryRecordingReader(db as never, () => { throw new Error('source swap'); }, source);
  const worker = new TranscriptionWorker(repository as never, {enabled: true, reader,
    provider: {
      transcribe: async (bytes, context) => {
        providerTracks.push(context.track);
        assert.deepEqual(bytes, fixture.bodies[context.track as Track]);
        return options.answer?.(context.track) ?? {text: `${context.track} verified words`, provider: 'synthetic', model: 'test'};
      },
      classify: async ({text, segments}) => { classified.push({text, segments}); return {classification: 'not_advertising'}; },
    },
    aiTranscripts: async input => {
      assert.deepEqual(input, {callId, snapshotOwnerId: ownerId});
      aiReads++;
      return options.aiLines ?? [];
    },
  });
  const outcome = await worker.tickOnce();
  assert.deepEqual(fixture.manifest, originalManifest, 'never rewrite original capture facts');
  return {outcome, result, failure, providerTracks, classified, aiReads, fingerprint};
}

test('all-zero proof scans valid v2/v3 PCM only, never header-only, malformed or other formats', () => {
  const silent = wav();
  for (const version of [2, 3]) assert.deepEqual(allZeroPcmEvidence(silent, 'audio/wav', version), {
    reason: 'all_zero_pcm', detector: 'pcm16_all_zero_v1', sampleCount: 410_880, durationMs: 25_680,
  });
  assert.equal(allZeroPcmEvidence(wav(0), 'audio/wav', 2), null);
  assert.equal(allZeroPcmEvidence(silent, 'audio/wav', 1), null);
  assert.equal(allZeroPcmEvidence(Buffer.from('OggS'.padEnd(256, '\0')), 'audio/ogg', 1), null);
  const malformed = [silent.subarray(0, 43), silent.subarray(0, silent.length - 1), Buffer.concat([silent, Buffer.alloc(2)])];
  for (const [offset, value] of [[20, 3], [22, 2], [24, 8000], [32, 4], [34, 8]] as const) {
    const bad = Buffer.from(silent); bad.writeUInt16LE(value, offset); malformed.push(bad);
  }
  const wrongDataLength = Buffer.from(silent); wrongDataLength.writeUInt32LE(0, 40); malformed.push(wrongDataLength);
  for (const offset of [0, 8, 12, 36]) {
    const highBitMagic = Buffer.from(silent); highBitMagic[offset] = highBitMagic[offset]! | 0x80;
    malformed.push(highBitMagic);
  }
  for (const bad of malformed) assert.equal(allZeroPcmEvidence(bad, 'audio/wav', 2), null);
});

test('one nonzero sample anywhere, including either final byte, is never silence', () => {
  for (const offset of [44, 44 + 320, 44 + 410_879 * 2]) {
    for (const amplitude of [1, -1, 256, -256]) {
      const quiet = wav(); quiet.writeInt16LE(amplitude, offset);
      assert.equal(allZeroPcmEvidence(quiet, 'audio/wav', 2), null);
    }
  }
});

test('per-track silence skips only that provider call and preserves valid text, hashes and capture facts', async () => {
  for (const version of [2, 3] as const) for (const silentTrack of trackIds) {
    const keptTrack = silentTrack === 'caller_original' ? 'remote_original' : 'caller_original';
    const fixture = recording(silentTrack === 'remote_original' ? wav() : speech(),
      silentTrack === 'caller_original' ? wav() : speech(), version);
    const output = await run(fixture);
    assert.equal(output.outcome, 'succeeded');
    assert.deepEqual(output.providerTracks, [keptTrack]);
    assert.equal(output.aiReads, 0);
    assert.equal(output.classified.length, 1);
    assert.equal(output.classified[0]!.text, `${keptTrack === 'remote_original' ? 'remote' : 'vodog_user'}: ${keptTrack} verified words`);
    assert.deepEqual(output.classified[0]!.segments, output.result.segments);
    assert.deepEqual(output.result.segments.map((s: any) => s.track), [keptTrack]);
    assert.deepEqual(output.result.providers.map((p: any) => p.track), [keptTrack]);
    assert.equal(output.result.manifestFingerprint, output.fingerprint);
    assert.equal(output.result.recording.manifestSha256, fixture.manifest.manifestSha256);
    assert.equal(output.result.recording.archiveId, fixture.manifest.archiveId);
    assert.equal(output.result.recording.complete, false);
    assert.equal(output.result.recording.captureComplete, true);
    assert.equal(output.result.recording.archiveComplete, true);
    assert.deepEqual(output.result.recording.tracks.map((t: any) => [t.track, t.bytes, t.sha256]),
      fixture.manifest.tracks.map(t => [t.track, t.bytes, t.sha256]));
    assert.deepEqual(output.result.recording.skippedTracks, [{track: silentTrack, reason: 'all_zero_pcm',
      detector: 'pcm16_all_zero_v1', sampleCount: 410_880, durationMs: 25_680}]);
  }
});

test('both silent tracks fail RECORDING_EMPTY terminally without ASR or classification', async () => {
  const output = await run(recording(wav(), wav()));
  assert.equal(output.outcome, 'failed');
  assert.equal(output.result, undefined);
  assert.deepEqual(output.providerTracks, []); assert.deepEqual(output.classified, []);
  assert.equal(output.failure.errorCode, 'RECORDING_EMPTY');
  assert.equal(output.failure.terminal, true); assert.equal(output.failure.nextAttemptAt, null);
  assert.match(output.failure.errorMessage, /remote_original: all_zero_pcm/);
  assert.match(output.failure.errorMessage, /caller_original: all_zero_pcm/);
});

test('both silent tracks retain explicitly labelled AI fallback and skip evidence', async () => {
  const output = await run(recording(wav(), wav(), 3), {
    aiLines: [{role: 'caller', text: '真实的实时转写', at: '2026-09-20T06:34:47.000Z'}],
  });
  assert.equal(output.outcome, 'succeeded'); assert.deepEqual(output.providerTracks, []);
  assert.equal(output.result.recording.source, 'ai_realtime_transcript');
  assert.equal(output.result.recording.complete, false);
  assert.equal(output.result.recording.skippedTracks.length, 2);
  assert.deepEqual(output.result.providers, []);
  assert.equal(output.classified[0]!.text, '来电: 真实的实时转写');
  assert.equal(output.result.segments[0].track, 'ai_realtime_transcript');
});

test('all-zero bytes with a corrupt expected hash fail integrity before silence handling or fallback', async () => {
  const fixture = recording(wav(), speech());
  fixture.manifest.tracks[0]!.sha256 = 'f'.repeat(64);
  // Bypass the real reader's independent integrity gate to exercise the worker gate itself.
  const output = await run(fixture, {reader: {readTrack: async request => fixture.bodies[request.track as Track]}});
  assert.equal(output.outcome, 'failed');
  assert.equal(output.failure.errorCode, 'RECORDING_INTEGRITY_FAILED');
  assert.equal(output.failure.terminal, true);
  assert.deepEqual(output.providerTracks, []); assert.deepEqual(output.classified, []);
  assert.equal(output.aiReads, 0);
});

test('SHA-matching malformed WAV is rejected, never labelled silent or sent to a provider', async () => {
  const bad = wav(); bad.writeUInt16LE(2, 22);
  const fixture = recording(bad, speech());
  const output = await run(fixture, {reader: {readTrack: async request => fixture.bodies[request.track as Track]}});
  assert.equal(output.outcome, 'failed'); assert.equal(output.failure.errorCode, 'RECORDING_INTEGRITY_FAILED');
  assert.deepEqual(output.providerTracks, []); assert.deepEqual(output.classified, []);
  assert.equal(output.aiReads, 0);
});

test('S78: nonzero but voiceless tracks (one sample, line floor, key clicks) are no_voice_activity', () => {
  const oneSample = wav(); oneSample.writeInt16LE(1, oneSample.length - 2);
  const floor = burst(wav(), 0, 25_000, -80);
  // 164c6633 shape: isolated ≤100 ms pops up to -20 dBFS.
  const clicks = [4300, 6100, 8000, 8400].reduce((bytes, at) => burst(bytes, at, 100, -20), burst(wav(), 0, 25_000, -80));
  for (const track of [oneSample, floor, clicks]) {
    const evidence = noVoiceEvidence(track, 'audio/wav', 3);
    assert.equal(evidence?.reason, 'no_voice_activity');
    assert.ok(evidence!.longestVoicedMs < 160);
  }
  assert.equal(noVoiceEvidence(wav(0), 'audio/wav', 3), null);
  assert.equal(noVoiceEvidence(Buffer.from('OggS'.padEnd(256, '\0')), 'audio/ogg', 1), null);
  // Quiet but sustained speech (a short 喂 at -45 dBFS) is voice.
  assert.equal(noVoiceEvidence(burst(wav(), 3000, 200, -45), 'audio/wav', 3), null);
  assert.equal(noVoiceEvidence(speech(), 'audio/wav', 3), null);
});

test('S78: a voiceless caller track is skipped with evidence; the remote track is still transcribed', async () => {
  const clicks = burst(burst(wav(), 0, 25_000, -80), 4300, 100, -20);
  const output = await run(recording(speech(), clicks, 3));
  assert.equal(output.outcome, 'succeeded'); assert.deepEqual(output.providerTracks, ['remote_original']);
  assert.equal(output.result.recording.skippedTracks[0].track, 'caller_original');
  assert.equal(output.result.recording.skippedTracks[0].reason, 'no_voice_activity');
  assert.doesNotMatch(output.result.text, /vodog_user/);
});

test('S78: the provider\'s explicit no-speech answer skips that track instead of failing the job', async () => {
  const output = await run(recording(speech(), speech(), 3), {
    answer: track => track === 'caller_original' ? {text: '', segments: []} : undefined as never,
  });
  assert.equal(output.outcome, 'succeeded'); assert.deepEqual(output.providerTracks, trackIds);
  assert.deepEqual(output.result.recording.skippedTracks, [{track: 'caller_original', reason: 'provider_no_speech'}]);
  assert.deepEqual(output.result.segments.map((s: any) => s.track), ['remote_original']);
});

test('quiet sustained PCM reaches ASR and does not reduce complete capture coverage', async () => {
  const quiet = burst(wav(), 1000, 400, -45);
  for (const captureComplete of [true, false]) {
    const output = await run(recording(quiet, speech(), 3, captureComplete));
    assert.equal(output.outcome, 'succeeded'); assert.deepEqual(output.providerTracks, trackIds);
    assert.equal(output.result.recording.complete, captureComplete);
    assert.equal(output.result.recording.captureComplete, captureComplete);
    assert.deepEqual(output.result.recording.skippedTracks, []);
    assert.equal(output.classified[0]!.segments.length, 2);
  }
});
