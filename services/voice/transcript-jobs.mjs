import {createHash, randomUUID} from 'node:crypto';

const SHA256_RE = /^[0-9a-f]{64}$/;

export const RECORDING_FORMATS = Object.freeze({
  1: Object.freeze({
    tracks: Object.freeze({
      remote_original: Object.freeze({name: 'remote_original.ogg', mediaType: 'audio/ogg', formatVersion: 1, speaker: 'remote'}),
      caller_original: Object.freeze({name: 'caller_original.ogg', mediaType: 'audio/ogg', formatVersion: 1, speaker: 'vodog_user'}),
    }),
    auxiliary: Object.freeze({
      timeline: Object.freeze({name: 'timeline.jsonl', mediaType: 'application/x-ndjson', formatVersion: 1}),
    }),
  }),
});

export class TranscriptJobError extends Error {
  constructor(code, message, {retryable = false, cause} = {}) {
    super(message, {cause});
    this.name = 'TranscriptJobError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Production implementations persist jobs and apply complete/fail with lease-token CAS. */
export class TranscriptJobRepository {
  async enqueue(_job) { throw new Error('Not implemented'); }
  async claim(_leaseRequest) { throw new Error('Not implemented'); }
  async complete(_completion) { throw new Error('Not implemented'); }
  async fail(_failure) { throw new Error('Not implemented'); }
  async get(_jobId) { throw new Error('Not implemented'); }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TranscriptJobError('INVALID_INPUT', `${field} is required`);
  return value.trim();
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function iso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TranscriptJobError('INVALID_INPUT', `${field} must be a valid date`);
  return date.toISOString();
}

export function normalizeRecordingManifest(manifest, expectedCallId) {
  if (!manifest || typeof manifest !== 'object') throw new TranscriptJobError('INVALID_MANIFEST', 'Recording manifest is required');
  const callId = requireString(manifest.callId, 'manifest.callId');
  if (expectedCallId && callId !== expectedCallId) throw new TranscriptJobError('INVALID_MANIFEST', 'Recording manifest callId does not match the job');
  if (!Number.isSafeInteger(manifest.version)) throw new TranscriptJobError('INVALID_MANIFEST', 'Recording manifest version must be an integer');
  if (typeof manifest.complete !== 'boolean') throw new TranscriptJobError('INVALID_MANIFEST', 'Recording manifest complete must be a boolean');
  if ((manifest.nodeId !== undefined && (typeof manifest.nodeId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(manifest.nodeId))) ||
      (manifest.mediaEpoch !== undefined && (!Number.isSafeInteger(manifest.mediaEpoch) || manifest.mediaEpoch < 1))) {
    throw new TranscriptJobError('INVALID_MANIFEST', 'Recording manifest routing metadata is invalid');
  }
  const format = RECORDING_FORMATS[manifest.version];
  if (!format) throw new TranscriptJobError('UNSUPPORTED_RECORDING_FORMAT', `Recording manifest version ${manifest.version} is not supported`);
  if (!Array.isArray(manifest.artifacts)) throw new TranscriptJobError('INVALID_MANIFEST', 'Recording manifest artifacts must be an array');

  const byName = new Map();
  for (const artifact of manifest.artifacts) {
    const name = requireString(artifact?.name, 'artifact.name');
    if (byName.has(name)) throw new TranscriptJobError('INVALID_MANIFEST', `Duplicate recording artifact ${name}`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new TranscriptJobError('INVALID_MANIFEST', `${name} has invalid bytes`);
    if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) throw new TranscriptJobError('INVALID_MANIFEST', `${name} has invalid sha256`);
    byName.set(name, {name, bytes: artifact.bytes, sha256: artifact.sha256});
  }

  const expectedNames = new Set([
    ...Object.values(format.tracks).map(({name}) => name),
    ...Object.values(format.auxiliary).map(({name}) => name),
  ]);
  if (byName.size !== expectedNames.size || [...byName.keys()].some((name) => !expectedNames.has(name))) {
    throw new TranscriptJobError('INVALID_MANIFEST', `Recording manifest v${manifest.version} must contain exactly ${[...expectedNames].join(', ')}`);
  }
  const tracks = Object.entries(format.tracks).map(([track, metadata]) => {
    const artifact = byName.get(metadata.name);
    if (!artifact) throw new TranscriptJobError('INVALID_MANIFEST', `Recording manifest is missing ${metadata.name}`);
    return {...metadata, track, bytes: artifact.bytes, sha256: artifact.sha256};
  });

  const artifacts = [
    ...tracks.map(({track, name, mediaType, formatVersion, bytes, sha256}) => ({kind: 'track', track, name, mediaType, formatVersion, bytes, sha256})),
    ...Object.entries(format.auxiliary).map(([role, metadata]) => {
      const artifact = byName.get(metadata.name);
      if (!artifact) throw new TranscriptJobError('INVALID_MANIFEST', `Recording manifest is missing ${metadata.name}`);
      return {kind: 'auxiliary', role, ...metadata, bytes: artifact.bytes, sha256: artifact.sha256};
    }),
  ];

  const fingerprintInput = {
    version: manifest.version,
    callId,
    ...(manifest.nodeId === undefined ? {} : {nodeId: manifest.nodeId}),
    ...(manifest.mediaEpoch === undefined ? {} : {mediaEpoch: manifest.mediaEpoch}),
    finalizedAt: iso(manifest.finalizedAt, 'manifest.finalizedAt'),
    complete: manifest.complete,
    artifacts,
  };
  return {
    version: manifest.version,
    callId,
    finalizedAt: iso(manifest.finalizedAt, 'manifest.finalizedAt'),
    complete: manifest.complete,
    tracks, artifacts,
    fingerprint: createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex'),
  };
}

function normalizeTranscription(result, track) {
  if (!result || typeof result !== 'object') throw new TranscriptJobError('PROVIDER_INVALID_RESULT', 'Transcription provider returned an invalid result', {retryable: true});
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (!text) throw new TranscriptJobError('PROVIDER_EMPTY_RESULT', 'Transcription provider returned no text', {retryable: true});
  const rawSegments = result.segments === undefined ? [{text}] : result.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) throw new TranscriptJobError('PROVIDER_INVALID_RESULT', 'Transcription segments are invalid', {retryable: true});
  const segments = rawSegments.map((segment) => {
    const segmentText = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!segmentText) throw new TranscriptJobError('PROVIDER_INVALID_RESULT', 'A transcription segment has no text', {retryable: true});
    const normalized = {track: track.track, speaker: track.speaker, text: segmentText};
    if (segment.startMs !== undefined) {
      if (!Number.isFinite(segment.startMs) || segment.startMs < 0) throw new TranscriptJobError('PROVIDER_INVALID_RESULT', 'A segment has an invalid startMs', {retryable: true});
      normalized.startMs = segment.startMs;
    }
    if (segment.endMs !== undefined) {
      if (!Number.isFinite(segment.endMs) || segment.endMs < (normalized.startMs ?? 0)) throw new TranscriptJobError('PROVIDER_INVALID_RESULT', 'A segment has an invalid endMs', {retryable: true});
      normalized.endMs = segment.endMs;
    }
    return normalized;
  });
  return {
    text,
    segments,
    provider: typeof result.provider === 'string' && result.provider ? result.provider : 'injected',
    model: typeof result.model === 'string' && result.model ? result.model : null,
    version: typeof result.version === 'string' && result.version ? result.version : (result.model ?? null),
  };
}

function normalizeClassification(result) {
  const value = typeof result === 'string' ? result : result?.classification;
  const classification = ['advertising', 'not_advertising', 'unknown'].includes(value) ? value : 'unknown';
  const summary = typeof result?.summary === 'string' && result.summary.trim() ? result.summary.trim() : null;
  const actionItems = Array.isArray(result?.actionItems)
    ? result.actionItems.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 50)
    : [];
  return {classification, includeInReports: classification !== 'advertising', summary, actionItems};
}

function integrityError(message) {
  return new TranscriptJobError('RECORDING_INTEGRITY_FAILED', message, {retryable: false});
}

export class TranscriptJobProcessor {
  constructor({repository, recordingSource, transcribe, classifyTranscript = async () => ({classification: 'unknown'}), clock = () => new Date(), leaseMs = 60_000, maxAttempts = 4, baseRetryMs = 1_000}) {
    const repositoryMethods = ['enqueue', 'claim', 'complete', 'fail', 'get'];
    if (!repositoryMethods.every((method) => typeof repository?.[method] === 'function') || typeof recordingSource?.readTrack !== 'function' || typeof transcribe !== 'function') {
      throw new TypeError('TranscriptJobRepository, recordingSource.readTrack, and transcribe are required');
    }
    Object.assign(this, {repository, recordingSource, transcribe, classifyTranscript, clock, leaseMs, maxAttempts, baseRetryMs});
  }

  async enqueue({jobId = randomUUID(), callId, snapshotOwnerId, manifest}) {
    callId = requireString(callId, 'callId');
    snapshotOwnerId = requireString(snapshotOwnerId, 'snapshotOwnerId');
    const recording = normalizeRecordingManifest(manifest, callId);
    return this.repository.enqueue({
      jobId: requireString(jobId, 'jobId'), callId, snapshotOwnerId,
      manifest: clone(manifest), manifestFingerprint: recording.fingerprint,
      recording: clone(recording), createdAt: this.clock().toISOString(),
    });
  }

  async processNext() {
    const claimedAt = this.clock();
    const job = await this.repository.claim({now: claimedAt, leaseMs: this.leaseMs});
    if (!job) return {status: 'idle'};
    try {
      const recording = normalizeRecordingManifest(job.manifest, job.callId);
      if (recording.fingerprint !== job.manifestFingerprint) throw integrityError('Recording manifest changed after enqueue');
      const transcripts = [];
      for (const track of recording.tracks) {
        if (track.bytes === 0) continue;
        const bytes = await this.recordingSource.readTrack({
          callId: job.callId, snapshotOwnerId: job.snapshotOwnerId,
          manifestFingerprint: job.manifestFingerprint, track: track.track,
          name: track.name, mediaType: track.mediaType, formatVersion: track.formatVersion,
          expectedBytes: track.bytes, expectedSha256: track.sha256,
        });
        if (!Buffer.isBuffer(bytes)) throw integrityError(`${track.name} was not returned as bytes`);
        if (bytes.length !== track.bytes) throw integrityError(`${track.name} byte length does not match its manifest`);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== track.sha256) throw integrityError(`${track.name} sha256 does not match its manifest`);
        const response = await this.transcribe(bytes, {
          callId: job.callId, snapshotOwnerId: job.snapshotOwnerId,
          manifestFingerprint: job.manifestFingerprint, track: track.track,
          mediaType: track.mediaType, formatVersion: track.formatVersion,
        });
        transcripts.push({track, result: normalizeTranscription(response, track)});
      }
      if (transcripts.length === 0) throw new TranscriptJobError('EMPTY_RECORDING', 'Recording has no audio bytes to transcribe');
      const segments = transcripts.flatMap(({result}) => result.segments);
      const text = transcripts.map(({track, result}) => `${track.speaker}: ${result.text}`).join('\n');
      const report = normalizeClassification(await this.classifyTranscript({callId: job.callId, snapshotOwnerId: job.snapshotOwnerId, text, segments: clone(segments)}));
      const completedAt = this.clock();
      const result = {
        callId: job.callId, snapshotOwnerId: job.snapshotOwnerId,
        manifestFingerprint: job.manifestFingerprint,
        recording: {
          manifestVersion: recording.version, complete: recording.complete,
          tracks: recording.tracks.map(({track, name, mediaType, formatVersion, bytes, sha256}) => ({track, name, mediaType, formatVersion, bytes, sha256})),
        },
        text, segments,
        providers: transcripts.map(({track, result}) => ({track: track.track, provider: result.provider, model: result.model, version: result.version})),
        advertisingClassification: report.classification,
        includeInReports: report.includeInReports,
        summary: report.summary,
        actionItems: report.actionItems,
        completedAt: completedAt.toISOString(),
      };
      const applied = await this.repository.complete({jobId: job.jobId, leaseToken: job.leaseToken, now: completedAt, result});
      return applied ? {status: 'succeeded', jobId: job.jobId, result} : {status: 'stale_lease', jobId: job.jobId};
    } catch (error) {
      const now = this.clock();
      const retryable = error?.retryable !== false && job.attempts < this.maxAttempts;
      const nextAttemptAt = retryable ? new Date(now.getTime() + this.baseRetryMs * 2 ** (job.attempts - 1)) : null;
      const applied = await this.repository.fail({
        jobId: job.jobId, leaseToken: job.leaseToken, now,
        terminal: !retryable, nextAttemptAt,
        error: {code: error?.code ?? 'TRANSCRIPTION_FAILED', message: String(error?.message ?? error).slice(0, 500)},
      });
      return applied ? {status: retryable ? 'retry' : 'failed', jobId: job.jobId} : {status: 'stale_lease', jobId: job.jobId};
    }
  }
}

/** Test fake for the durable TranscriptJobRepository contract. */
export class InMemoryTranscriptJobRepository extends TranscriptJobRepository {
  #jobs = new Map();

  constructor() {
    super();
  }

  async enqueue(input) {
    const duplicate = [...this.#jobs.values()].find((job) => job.callId === input.callId && job.snapshotOwnerId === input.snapshotOwnerId && job.manifestFingerprint === input.manifestFingerprint);
    if (duplicate) return clone(duplicate);
    if (this.#jobs.has(input.jobId)) throw new TranscriptJobError('DUPLICATE_JOB_ID', 'Transcript jobId already exists');
    const job = {...clone(input), status: 'queued', attempts: 0, nextAttemptAt: input.createdAt, leaseToken: null, leaseUntil: null, result: null, error: null};
    this.#jobs.set(job.jobId, job);
    return clone(job);
  }

  async claim({now, leaseMs}) {
    const timestamp = now.getTime();
    const eligible = [...this.#jobs.values()].find((job) =>
      (job.status === 'queued' || (job.status === 'retry' && new Date(job.nextAttemptAt).getTime() <= timestamp)) ||
      (job.status === 'running' && new Date(job.leaseUntil).getTime() <= timestamp));
    if (!eligible) return null;
    eligible.status = 'running';
    eligible.attempts += 1;
    eligible.leaseToken = randomUUID();
    eligible.leaseUntil = new Date(timestamp + leaseMs).toISOString();
    return clone(eligible);
  }

  #ownsLease(jobId, leaseToken, now) {
    const job = this.#jobs.get(jobId);
    return job && job.status === 'running' && job.leaseToken === leaseToken && new Date(job.leaseUntil).getTime() > now.getTime() ? job : null;
  }

  async complete({jobId, leaseToken, now, result}) {
    const job = this.#ownsLease(jobId, leaseToken, now);
    if (!job) return false;
    Object.assign(job, {status: 'succeeded', result: clone(result), completedAt: now.toISOString(), leaseToken: null, leaseUntil: null, error: null});
    return true;
  }

  async fail({jobId, leaseToken, now, terminal, nextAttemptAt, error}) {
    const job = this.#ownsLease(jobId, leaseToken, now);
    if (!job) return false;
    Object.assign(job, {
      status: terminal ? 'failed' : 'retry', error: clone(error),
      nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
      failedAt: terminal ? now.toISOString() : null,
      leaseToken: null, leaseUntil: null,
    });
    return true;
  }

  async get(jobId) {
    return clone(this.#jobs.get(jobId) ?? null);
  }
}
