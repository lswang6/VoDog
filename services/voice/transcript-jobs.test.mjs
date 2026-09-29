import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {InMemoryTranscriptJobRepository, TranscriptJobError, TranscriptJobProcessor, normalizeRecordingManifest} from './transcript-jobs.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const remote = Buffer.from('OggS remote audio');
const caller = Buffer.from('OggS caller audio');
const timeline = Buffer.from('{}\n');

function manifest(overrides = {}) {
  return {
    version: 1, callId: 'call-1', finalizedAt: '2026-09-09T12:00:00.000Z', complete: true,
    artifacts: [
      {name: 'remote_original.ogg', bytes: remote.length, sha256: hash(remote)},
      {name: 'caller_original.ogg', bytes: caller.length, sha256: hash(caller)},
      {name: 'timeline.jsonl', bytes: timeline.length, sha256: hash(timeline)},
    ], ...overrides,
  };
}

function clock(initial = '2026-09-09T12:00:00.000Z') {
  let now = new Date(initial);
  return {now: () => new Date(now), advance: (ms) => { now = new Date(now.getTime() + ms); }};
}

function source({tamperTrack} = {}) {
  const calls = [];
  return {
    calls,
    async readTrack(request) {
      calls.push(request);
      if (request.track === tamperTrack) return Buffer.from('tampered');
      return request.track === 'remote_original' ? remote : caller;
    },
  };
}

test('processes both immutable Ogg tracks and defaults unknown calls into reports', async () => {
  const repository = new InMemoryTranscriptJobRepository();
  const recordingSource = source();
  const providerCalls = [];
  const processor = new TranscriptJobProcessor({
    repository, recordingSource,
    transcribe: async (bytes, context) => {
      providerCalls.push({bytes, context});
      return {text: context.track === 'remote_original' ? '客户讲话' : '坐席讲话', provider: 'fake', model: 'fake-v1', version: '2026-09'};
    },
  });
  const queued = await processor.enqueue({jobId: 'job-1', callId: 'call-1', snapshotOwnerId: 'owner-1', manifest: manifest()});
  const outcome = await processor.processNext();
  const stored = await repository.get(queued.jobId);

  assert.equal(outcome.status, 'succeeded');
  assert.equal(stored.status, 'succeeded');
  assert.equal(stored.result.advertisingClassification, 'unknown');
  assert.equal(stored.result.includeInReports, true);
  assert.deepEqual(stored.result.segments.map(({track, speaker}) => ({track, speaker})), [
    {track: 'remote_original', speaker: 'remote'},
    {track: 'caller_original', speaker: 'vodog_user'},
  ]);
  assert.deepEqual(providerCalls.map(({context}) => [context.track, context.mediaType, context.formatVersion]), [
    ['remote_original', 'audio/ogg', 1], ['caller_original', 'audio/ogg', 1],
  ]);
  assert.ok(recordingSource.calls.every((request) => request.snapshotOwnerId === 'owner-1' && request.expectedSha256));
});

test('only an explicit advertising classification excludes a call', async () => {
  for (const [classification, expected] of [['advertising', false], ['not_advertising', true], ['unexpected', true]]) {
    const repository = new InMemoryTranscriptJobRepository();
    const processor = new TranscriptJobProcessor({
      repository, recordingSource: source(),
      transcribe: async () => ({text: '内容'}), classifyTranscript: async () => ({classification}),
    });
    await processor.enqueue({jobId: `job-${classification}`, callId: 'call-1', snapshotOwnerId: 'owner-1', manifest: manifest()});
    const result = await processor.processNext();
    assert.equal(result.result.includeInReports, expected);
    assert.equal(result.result.advertisingClassification, classification === 'unexpected' ? 'unknown' : classification);
  }
});

test('retries provider failures with the same frozen job and succeeds later', async () => {
  const repository = new InMemoryTranscriptJobRepository();
  const time = clock();
  let failures = 1;
  const processor = new TranscriptJobProcessor({
    repository, recordingSource: source(), clock: time.now, baseRetryMs: 100,
    transcribe: async () => {
      if (failures-- > 0) throw new TranscriptJobError('PROVIDER_UNAVAILABLE', 'temporary', {retryable: true});
      return {text: '成功'};
    },
  });
  await processor.enqueue({jobId: 'job-retry', callId: 'call-1', snapshotOwnerId: 'owner-1', manifest: manifest()});
  assert.equal((await processor.processNext()).status, 'retry');
  assert.equal((await processor.processNext()).status, 'idle');
  time.advance(100);
  assert.equal((await processor.processNext()).status, 'succeeded');
  assert.equal((await repository.get('job-retry')).attempts, 2);
});

test('recording integrity failure is terminal and provider is never called', async () => {
  const repository = new InMemoryTranscriptJobRepository();
  let providerCalls = 0;
  const processor = new TranscriptJobProcessor({repository, recordingSource: source({tamperTrack: 'remote_original'}), transcribe: async () => { providerCalls++; }});
  await processor.enqueue({jobId: 'job-tampered', callId: 'call-1', snapshotOwnerId: 'owner-1', manifest: manifest()});
  assert.equal((await processor.processNext()).status, 'failed');
  const stored = await repository.get('job-tampered');
  assert.equal(stored.error.code, 'RECORDING_INTEGRITY_FAILED');
  assert.equal(providerCalls, 0);
});

test('deduplicates the same owner and frozen manifest', async () => {
  const repository = new InMemoryTranscriptJobRepository();
  const processor = new TranscriptJobProcessor({repository, recordingSource: source(), transcribe: async () => ({text: '内容'})});
  const first = await processor.enqueue({jobId: 'job-first', callId: 'call-1', snapshotOwnerId: 'owner-1', manifest: manifest()});
  const second = await processor.enqueue({jobId: 'job-second', callId: 'call-1', snapshotOwnerId: 'owner-1', manifest: manifest()});
  assert.equal(first.jobId, 'job-first');
  assert.equal(second.jobId, 'job-first');
});

test('expired workers cannot complete or fail over a newer lease', async () => {
  const repository = new InMemoryTranscriptJobRepository();
  await repository.enqueue({jobId: 'lease-job', callId: 'call-1', snapshotOwnerId: 'owner-1', manifestFingerprint: 'f', manifest: {}, createdAt: '2026-09-09T00:00:00.000Z'});
  const first = await repository.claim({now: new Date('2026-09-09T00:00:00.000Z'), leaseMs: 1_000});
  const second = await repository.claim({now: new Date('2026-09-09T00:00:02.000Z'), leaseMs: 1_000});
  assert.notEqual(first.leaseToken, second.leaseToken);
  assert.equal(await repository.complete({jobId: 'lease-job', leaseToken: first.leaseToken, now: new Date('2026-09-09T00:00:02.100Z'), result: {stale: true}}), false);
  assert.equal(await repository.fail({jobId: 'lease-job', leaseToken: first.leaseToken, now: new Date('2026-09-09T00:00:02.100Z'), terminal: true, error: {code: 'STALE'}}), false);
  assert.equal(await repository.complete({jobId: 'lease-job', leaseToken: second.leaseToken, now: new Date('2026-09-09T00:00:02.500Z'), result: {current: true}}), true);
  assert.deepEqual((await repository.get('lease-job')).result, {current: true});
});

test('format selection is versioned and never infers future WAV metadata', () => {
  const normalized = normalizeRecordingManifest(manifest(), 'call-1');
  assert.deepEqual(normalized.tracks.map(({name, mediaType, formatVersion}) => ({name, mediaType, formatVersion})), [
    {name: 'remote_original.ogg', mediaType: 'audio/ogg', formatVersion: 1},
    {name: 'caller_original.ogg', mediaType: 'audio/ogg', formatVersion: 1},
  ]);
  assert.throws(() => normalizeRecordingManifest(manifest({version: 2}), 'call-1'), {code: 'UNSUPPORTED_RECORDING_FORMAT'});
});

test('the frozen fingerprint covers timeline metadata and rejects a partial v1 manifest', () => {
  const original = normalizeRecordingManifest(manifest(), 'call-1');
  const changedTimeline = manifest();
  changedTimeline.artifacts[2] = {name: 'timeline.jsonl', bytes: 1, sha256: hash(Buffer.from('x'))};
  assert.notEqual(normalizeRecordingManifest(changedTimeline, 'call-1').fingerprint, original.fingerprint);
  assert.throws(() => normalizeRecordingManifest({...manifest(), artifacts: manifest().artifacts.slice(0, 2)}, 'call-1'), {code: 'INVALID_MANIFEST'});
  assert.throws(() => normalizeRecordingManifest(manifest({version: '1'}), 'call-1'), {code: 'INVALID_MANIFEST'});
  assert.throws(() => normalizeRecordingManifest(manifest({complete: 'false'}), 'call-1'), {code: 'INVALID_MANIFEST'});
});
