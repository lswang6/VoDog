import {createHash} from 'node:crypto';
import {PostgresTranscriptJobRepository, type TranscriptJob} from './repository.js';
import {parsePixelRecordingDescriptor, type PixelRecordingDescriptor} from '../recording-archive.js';
import {maxTranscriptionRetryDelayMs, minRateLimitRetryDelayMs, TranscriptionProviderHttpError} from './provider-error.js';
import {allZeroPcmEvidence, noVoiceEvidence, validTranscriptionAudio, type AllZeroPcmEvidence, type NoVoiceEvidence} from './audio-format.js';
import {MAX_WAV_TRACK_BYTES, splitCanonicalWav} from './wav-chunks.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PROVIDER_INPUT_BYTES = 20 * 1024 * 1024;
/** S23 决策 6: how long a job may keep being deferred by provider rate limits before it is failed. */
const RATE_LIMIT_DEFERRAL_WINDOW_MS = 2 * 60 * 60 * 1_000;
const TRACKS = [
  {track: 'remote_original', name: 'remote_original.ogg', mediaType: 'audio/ogg', formatVersion: 1, speaker: 'remote'},
  {track: 'caller_original', name: 'caller_original.ogg', mediaType: 'audio/ogg', formatVersion: 1, speaker: 'vodog_user'},
] as const;
const TIMELINE = {kind: 'auxiliary', role: 'timeline', name: 'timeline.jsonl', mediaType: 'application/x-ndjson', formatVersion: 1} as const;

type Artifact = {name: string; bytes: number; sha256: string};
type Manifest = {version: 1; callId: string; nodeId?: string; mediaEpoch?: number; finalizedAt: string; complete: boolean; artifacts: Artifact[]};
type TrackMetadata = {track: 'remote_original' | 'caller_original' | 'caller_uplink'; name: string; mediaType: string; formatVersion: number; speaker: string};
export type FrozenRecording = {manifest: Manifest | PixelRecordingDescriptor; fingerprint: string; tracks: Array<Artifact & TrackMetadata>};
export type TrackReadRequest = {
  callId: string; snapshotOwnerId: string; manifestFingerprint: string; track: string; name: string;
  mediaType: string; formatVersion: number; expectedBytes: number; expectedSha256: string;
  source?: 'media' | 'pixel'; archiveId?: string;
  signal: AbortSignal;
};
export interface RecordingReader { readTrack(request: TrackReadRequest): Promise<Buffer>; }
/** S23 决策 5: one row per provider attempt, stored inside `transcript_jobs.result` (jsonb, no DDL). */
export type TranscriptionAttempt = {model: string; prompt: string; status: number | string; ms: number};
export type TranscriptionResult = {text: string; segments?: Array<{text: string; startMs?: number; endMs?: number}>; provider?: string; model?: string; version?: string; attempts?: TranscriptionAttempt[]};
export type TranscriptClassificationResult = {
  classification?: 'advertising' | 'not_advertising' | 'unknown' | string;
  category?: string;
  blockRecommended?: boolean;
  reason?: string | null;
  summary?: string | null;
  actionItems?: string[];
  provider?: string;
  model?: string;
  version?: string | null;
  enrichmentError?: {code: string; message: string} | null;
};
/** S22 classifier v2. `none` and `unknown` are the only two values that do not recommend a block. */
export const BLOCK_CATEGORIES = ['telemarketing', 'advertising', 'loan', 'insurance', 'wealth_management', 'trademark',
  'legal', 'real_estate', 'car_sales', 'other_sales', 'none', 'unknown'] as const;
export const CLASSIFIER_VERSION = 2;
/** The server never trusts the model's own `blockRecommended`; it re-derives it from the category. */
export const blockRecommendedFor = (category: string) => BLOCK_CATEGORIES.includes(category as never) && category !== 'none' && category !== 'unknown';
/** A WAV header alone is 44 bytes and a bare Ogg page header about 95: below that there is no audio,
 * and sending it to a paid provider is what produced the production `HTTP 400` (S22 决策 6). */
const EMPTY_TRACK_BYTES: Record<string, number> = {'audio/wav': 44, 'audio/ogg': 100};
export const emptyAudioTrack = (track: {mediaType: string; bytes: number}) => track.bytes <= (EMPTY_TRACK_BYTES[track.mediaType] ?? 0);
export type AiTranscriptLine = {role: 'ai' | 'caller'; text: string; at: string};
const AI_ROLE_LABEL: Record<string, string> = {ai: 'AI', caller: '来电'};
export interface TranscriptionProvider {
  transcribe(bytes: Buffer, context: Omit<TrackReadRequest, 'name' | 'expectedBytes' | 'expectedSha256'>): Promise<TranscriptionResult>;
  classify?(input: {callId: string; snapshotOwnerId: string; text: string; segments: unknown[]; signal: AbortSignal}): Promise<TranscriptClassificationResult>;
}

export class TranscriptionWorkerError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}

export function freezeRecordingManifest(value: unknown, callId: string): FrozenRecording {
  if ((value as {source?: unknown})?.source === 'pixel') {
    let pixel: PixelRecordingDescriptor;
    try { pixel = parsePixelRecordingDescriptor(value); }
    catch { throw new TranscriptionWorkerError('INVALID_MANIFEST', 'Pixel recording descriptor is invalid'); }
    if (pixel.callId !== callId) throw new TranscriptionWorkerError('INVALID_MANIFEST', 'Pixel recording call identity does not match');
    // Hash every reviewed field, including unselected derived tracks, timeline, gaps and identity.
    // Sort object keys to make DB jsonb's key order immaterial on job reload.
    const fingerprint = createHash('sha256').update(canonicalJson(pixel)).digest('hex');
    // S94: an archive with the owner-side uplink capture transcribes that track for the caller side,
    // so an owner who picked up on the phone is in the transcript; segments are labelled honestly.
    const uplink = pixel.uplinkTracks?.[0];
    const tracks = TRACKS.map((track) => {
      const artifact = (uplink && track.track === 'caller_original' ? uplink : pixel.tracks.find((item) => item.track === track.track))!;
      return {...track, track: artifact.track, name: `${artifact.track}.wav`, mediaType: 'audio/wav', formatVersion: pixel.version,
        bytes: artifact.bytes, sha256: artifact.sha256};
    });
    return {manifest: pixel, fingerprint, tracks};
  }
  const manifest = value as Partial<Manifest>;
  if (!manifest || manifest.version !== 1 || manifest.callId !== callId || typeof manifest.complete !== 'boolean' ||
      typeof manifest.finalizedAt !== 'string' || !Number.isFinite(Date.parse(manifest.finalizedAt)) || !Array.isArray(manifest.artifacts)) {
    throw new TranscriptionWorkerError('INVALID_MANIFEST', 'Recording manifest v1 is invalid');
  }
  if ((manifest.nodeId !== undefined && (typeof manifest.nodeId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(manifest.nodeId))) ||
      (manifest.mediaEpoch !== undefined && (!Number.isSafeInteger(manifest.mediaEpoch) || manifest.mediaEpoch < 1))) {
    throw new TranscriptionWorkerError('INVALID_MANIFEST', 'Recording manifest routing metadata is invalid');
  }
  const byName = new Map<string, Artifact>();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.name !== 'string' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256) || byName.has(artifact.name)) {
      throw new TranscriptionWorkerError('INVALID_MANIFEST', 'Recording manifest artifact is invalid');
    }
    byName.set(artifact.name, artifact);
  }
  const expected = new Set<string>([...TRACKS.map((track) => track.name), TIMELINE.name]);
  if (byName.size !== expected.size || [...byName.keys()].some((name) => !expected.has(name))) throw new TranscriptionWorkerError('INVALID_MANIFEST', 'Recording manifest v1 must contain both Ogg tracks and timeline.jsonl');
  const tracks = TRACKS.map((track) => ({...track, ...byName.get(track.name)!}));
  const artifacts = [
    ...tracks.map(({track, name, mediaType, formatVersion, bytes, sha256}) => ({kind: 'track', track, name, mediaType, formatVersion, bytes, sha256})),
    {...TIMELINE, ...byName.get(TIMELINE.name)!},
  ];
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 1, callId,
    ...(manifest.nodeId === undefined ? {} : {nodeId: manifest.nodeId}),
    ...(manifest.mediaEpoch === undefined ? {} : {mediaEpoch: manifest.mediaEpoch}),
    finalizedAt: manifest.finalizedAt, complete: manifest.complete, artifacts,
  })).digest('hex');
  return {manifest: manifest as Manifest, fingerprint, tracks};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  return JSON.stringify(value);
}

function normalizedResult(result: TranscriptionResult, track: FrozenRecording['tracks'][number]) {
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!text) throw new TranscriptionWorkerError('PROVIDER_EMPTY_RESULT', 'Transcription provider returned no text', true);
  const source = result.segments ?? [{text}];
  if (!Array.isArray(source) || source.length === 0) throw new TranscriptionWorkerError('PROVIDER_INVALID_RESULT', 'Transcription provider returned invalid segments', true);
  const segments = source.map((segment) => {
    const value = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!value || (segment.startMs !== undefined && (!Number.isFinite(segment.startMs) || segment.startMs < 0)) ||
        (segment.endMs !== undefined && (!Number.isFinite(segment.endMs) || segment.endMs < (segment.startMs ?? 0)))) {
      throw new TranscriptionWorkerError('PROVIDER_INVALID_RESULT', 'Transcription provider returned an invalid segment', true);
    }
    return {track: track.track, speaker: track.speaker, text: value,
      ...(segment.startMs === undefined ? {} : {startMs: segment.startMs}),
      ...(segment.endMs === undefined ? {} : {endMs: segment.endMs})};
  });
  // Provider attempt diagnostics are bounded here because they end up in the stored result document.
  const attempts = (Array.isArray(result.attempts) ? result.attempts : []).slice(0, 5).map((attempt) => ({
    model: String(attempt?.model ?? '').slice(0, 120),
    prompt: String(attempt?.prompt ?? '').slice(0, 16),
    status: typeof attempt?.status === 'number' && Number.isFinite(attempt.status) ? attempt.status : String(attempt?.status ?? '').slice(0, 32),
    ms: Number.isFinite(attempt?.ms) ? Math.max(0, Math.round(attempt!.ms)) : 0,
  }));
  return {text, segments, provider: result.provider || 'injected', model: result.model || null, version: result.version || result.model || null,
    ...(attempts.length ? {attempts} : {})};
}

/** Transcribes WAV pieces in order and merges them into one track result: timestamps are shifted to
 * the track timeline, a piece with no speech is skipped, and only an all-empty track is an error. */
export async function chunkedResult(chunks: Array<{startMs: number; bytes: Buffer}>,
  transcribe: (audio: Buffer) => Promise<TranscriptionResult>, track: FrozenRecording['tracks'][number]) {
  const parts: Array<ReturnType<typeof normalizedResult>> = [];
  for (const chunk of chunks) {
    const raw = await transcribe(chunk.bytes);
    if (typeof raw?.text !== 'string' || !raw.text.trim()) continue;
    const part = normalizedResult(raw, track);
    parts.push({...part, segments: part.segments.map((segment) => ({...segment,
      ...(segment.startMs === undefined ? {} : {startMs: segment.startMs + chunk.startMs}),
      ...(segment.endMs === undefined ? {} : {endMs: segment.endMs + chunk.startMs})}))});
  }
  if (!parts.length) throw new TranscriptionWorkerError('PROVIDER_EMPTY_RESULT', 'Transcription provider returned no text', true);
  const attempts = parts.flatMap((part) => part.attempts ?? []).slice(0, 20);
  return {...parts[0]!, text: parts.map((part) => part.text).join('\n'), segments: parts.flatMap((part) => part.segments),
    ...(attempts.length ? {attempts} : {})};
}

export class TranscriptionWorker {
  constructor(private readonly repository: PostgresTranscriptJobRepository, private readonly options: {
    reader: RecordingReader; provider?: TranscriptionProvider; enabled?: boolean; leaseMs?: number; maxAttempts?: number;
    baseRetryMs?: number; clock?: () => Date; readerTimeoutMs?: number; providerTimeoutMs?: number; leaseGraceMs?: number;
    rateLimitWindowMs?: number;
    random?: () => number;
    /** S22 decision 6: realtime AI transcript fallback for a call whose recording has no audio. */
    aiTranscripts?: (input: {callId: string; snapshotOwnerId: string}) => Promise<AiTranscriptLine[]>;
  }) {}

  async enqueueCall(input: {callId: string; snapshotOwnerId: string; manifest: unknown}) {
    const frozen = freezeRecordingManifest(input.manifest, input.callId);
    return this.repository.enqueue({...input, manifest: frozen.manifest, manifestFingerprint: frozen.fingerprint});
  }

  async tickOnce(signal?: AbortSignal): Promise<'disabled' | 'idle' | 'succeeded' | 'retry' | 'failed' | 'stale_lease'> {
    if (!this.options.enabled || !this.options.provider) return 'disabled';
    if (signal?.aborted) return 'idle';
    const readerTimeoutMs = this.options.readerTimeoutMs ?? 30_000;
    const leaseGraceMs = this.options.leaseGraceMs ?? 15_000;
    const job = await this.repository.claim({leaseMs: Math.max(this.options.leaseMs ?? 60_000, readerTimeoutMs + leaseGraceMs)});
    if (!job) return 'idle';
    try {
      const result = await this.process(job, this.options.provider, signal);
      return await this.repository.complete({jobId: job.id, leaseToken: job.leaseToken!, result}) ? 'succeeded' : 'stale_lease';
    } catch (error) {
      const attempts = job.attempts;
      const maxAttempts = this.options.maxAttempts ?? 4;
      const retryable = error instanceof TranscriptionProviderHttpError
        ? error.retryable
        : !(error instanceof TranscriptionWorkerError) || error.retryable;
      const now = (this.options.clock ?? (() => new Date()))();
      // S23 决策 6. A quota 429 is the provider's state, not this job's: it is deferred by `Retry-After`
      // without spending an attempt, so a recovered quota still finds the job queued. The only ceiling
      // is wall clock — after `rateLimitWindowMs` from enqueue the job is failed like any other.
      const rateLimited = error instanceof TranscriptionProviderHttpError && error.code === 'PROVIDER_RATE_LIMITED';
      const createdAtMs = job.createdAt instanceof Date ? job.createdAt.getTime() : Number.NaN;
      const deferredMs = Number.isFinite(createdAtMs) ? now.getTime() - createdAtMs : 0;
      const shouldRetry = rateLimited
        ? deferredMs < (this.options.rateLimitWindowMs ?? RATE_LIMIT_DEFERRAL_WINDOW_MS)
        : retryable && attempts < maxAttempts;
      const nextAttemptAt = shouldRetry ? new Date(now.getTime() + retryDelayMs({
        attempts, baseRetryMs: error instanceof TranscriptionProviderHttpError && error.status === 429
          ? Math.max(this.options.baseRetryMs ?? 1_000, minRateLimitRetryDelayMs)
          : this.options.baseRetryMs ?? 1_000,
        // Without a `Retry-After` header the attempt giveback would leave the exponent at its floor and
        // re-upload the same audio every ~33 s for the whole window; half the time already deferred
        // grows the wait instead, still bounded by `maxTranscriptionRetryDelayMs`.
        retryAfterMs: rateLimited
          ? (error as TranscriptionProviderHttpError).retryAfterMs ?? Math.floor(deferredMs / 2)
          : error instanceof TranscriptionProviderHttpError ? error.retryAfterMs : undefined,
        random: this.options.random ?? Math.random,
      })) : null;
      const applied = await this.repository.fail({
        jobId: job.id, leaseToken: job.leaseToken!, terminal: !shouldRetry, nextAttemptAt, countAttempt: !rateLimited,
        errorCode: error instanceof TranscriptionWorkerError || error instanceof TranscriptionProviderHttpError ? error.code : 'TRANSCRIPTION_FAILED',
        errorMessage: String((error as Error)?.message ?? error).slice(0, 500),
      });
      return applied ? (shouldRetry ? 'retry' : 'failed') : 'stale_lease';
    }
  }

  private async process(job: TranscriptJob, provider: TranscriptionProvider, signal?: AbortSignal) {
    const frozen = freezeRecordingManifest(job.manifest, job.callId);
    if (frozen.fingerprint !== job.manifestFingerprint) throw new TranscriptionWorkerError('RECORDING_INTEGRITY_FAILED', 'Frozen recording manifest fingerprint changed');
    if (frozen.tracks.some((track) => track.bytes > (track.mediaType === 'audio/wav' ? MAX_WAV_TRACK_BYTES : MAX_PROVIDER_INPUT_BYTES))) {
      throw new TranscriptionWorkerError('RECORDING_TOO_LARGE', 'A recording track exceeds the transcription input limit');
    }
    const transcripts = [];
    const skippedTracks: Array<(AllZeroPcmEvidence | NoVoiceEvidence | {reason: 'provider_no_speech'}) & {track: string}> = [];
    for (const track of frozen.tracks) {
      // S22 决策 6: a header-sized track is not audio. Skipping it here is what keeps the 44-byte
      // Pixel WAV of a failed capture away from the provider.
      if (emptyAudioTrack(track)) continue;
      const readerTimeoutMs = this.options.readerTimeoutMs ?? 30_000;
      await this.requireLease(job, readerTimeoutMs);
      const requestWithoutSignal = {
        callId: job.callId, snapshotOwnerId: job.snapshotOwnerId, manifestFingerprint: job.manifestFingerprint,
        track: track.track, name: track.name, mediaType: track.mediaType, formatVersion: track.formatVersion,
        expectedBytes: track.bytes, expectedSha256: track.sha256,
        ...(frozen.manifest.version === 1 ? {} : {source: 'pixel' as const, archiveId: frozen.manifest.archiveId}),
      };
      const bytes = await withTimeout((operationSignal) => this.options.reader.readTrack({...requestWithoutSignal, signal: operationSignal}), readerTimeoutMs, 'Recording read timed out', signal);
      if (!Buffer.isBuffer(bytes) || bytes.length !== track.bytes || createHash('sha256').update(bytes).digest('hex') !== track.sha256) {
        throw new TranscriptionWorkerError('RECORDING_INTEGRITY_FAILED', `${track.name} does not match the frozen manifest`);
      }
      if (track.mediaType === 'audio/wav' && !validTranscriptionAudio(bytes, track.mediaType, track.formatVersion)) {
        throw new TranscriptionWorkerError('RECORDING_INTEGRITY_FAILED', `${track.name} is not canonical Pixel PCM WAV`);
      }
      // S49: integrity comes first. A full-length all-zero capture must never reach ASR,
      // while even one nonzero PCM sample (however quiet) retains the normal path.
      // S78: nonzero but voiceless (line floor, key clicks) is skipped too — the provider invents dialogue for it.
      const silence = allZeroPcmEvidence(bytes, track.mediaType, track.formatVersion) ?? noVoiceEvidence(bytes, track.mediaType, track.formatVersion);
      if (silence) {
        skippedTracks.push({track: track.track, ...silence});
        continue;
      }
      const providerTimeoutMs = this.options.providerTimeoutMs ?? 120_000;
      const transcribe = async (audio: Buffer) => {
        await this.requireLease(job, providerTimeoutMs);
        return withTimeout((operationSignal) => provider.transcribe(audio, {
          callId: requestWithoutSignal.callId, snapshotOwnerId: requestWithoutSignal.snapshotOwnerId,
          manifestFingerprint: requestWithoutSignal.manifestFingerprint, track: requestWithoutSignal.track,
          mediaType: requestWithoutSignal.mediaType, formatVersion: requestWithoutSignal.formatVersion, signal: operationSignal,
          source: requestWithoutSignal.source, archiveId: requestWithoutSignal.archiveId,
        }), providerTimeoutMs, 'Transcription provider timed out', signal);
      };
      // Under the provider cap the track goes whole, exactly as before; only a long Pixel WAV is chunked.
      if (track.mediaType === 'audio/wav' && bytes.length > MAX_PROVIDER_INPUT_BYTES) {
        transcripts.push({track, result: await chunkedResult(splitCanonicalWav(bytes), transcribe, track)});
        continue;
      }
      const raw = await transcribe(bytes);
      // S78: the provider's explicit "no speech" (`{"segments":[]}`) skips the track; any other empty answer still retries.
      if (raw?.text === '' && Array.isArray(raw.segments) && raw.segments.length === 0) {
        skippedTracks.push({track: track.track, reason: 'provider_no_speech'});
        continue;
      }
      const result = normalizedResult(raw, track);
      transcripts.push({track, result});
    }
    // No usable audio: retain the explicitly labelled realtime AI fallback. Without it,
    // header-only or proven all-zero captures are terminal; the original recording stays intact.
    const aiLines = transcripts.length || !this.options.aiTranscripts ? [] :
      (await this.options.aiTranscripts({callId: job.callId, snapshotOwnerId: job.snapshotOwnerId}))
        .filter((line) => typeof line?.text === 'string' && line.text.trim());
    if (!transcripts.length && !aiLines.length) throw new TranscriptionWorkerError('RECORDING_EMPTY', skippedTracks.length
      ? `录音为空、PCM 全零或没有人声（${skippedTracks.map((skipped) => `${skipped.track}: ${skipped.reason}`).join(', ')}）`
      : '录音为空或采集失败');
    const fromAi = !transcripts.length;
    const segments = fromAi
      ? aiLines.map((line) => ({track: 'ai_realtime_transcript', speaker: line.role === 'ai' ? 'ai' : 'remote', text: line.text.trim(), at: line.at}))
      : transcripts.flatMap(({result}) => result.segments);
    const text = fromAi
      ? aiLines.map((line) => `${AI_ROLE_LABEL[line.role] ?? line.role}: ${line.text.trim()}`).join('\n')
      : transcripts.map(({track, result}) => `${track.speaker}: ${result.text}`).join('\n');
    let classified: TranscriptClassificationResult = {};
    if (provider.classify) {
      const providerTimeoutMs = this.options.providerTimeoutMs ?? 120_000;
      await this.requireLease(job, providerTimeoutMs);
      try {
        classified = await withTimeout((operationSignal) => provider.classify!({callId: job.callId, snapshotOwnerId: job.snapshotOwnerId, text, segments, signal: operationSignal}), providerTimeoutMs, 'Transcript classification timed out', signal);
      } catch {
        classified = {
          classification: 'unknown', summary: null, actionItems: [],
          enrichmentError: {code: 'CLASSIFIER_FAILED', message: 'Transcript enrichment failed'},
        };
      }
    }
    const classification = ['advertising', 'not_advertising', 'unknown'].includes(classified.classification ?? '') ? classified.classification! : 'unknown';
    // S22 classifier v2: the category is the fact, `blockRecommended` is derived from it here and
    // never taken from the model. `reason` is a short Chinese label shown on the report card.
    const blockCategory = BLOCK_CATEGORIES.includes((classified.category ?? '') as never) ? classified.category! : 'unknown';
    const blockRecommended = blockRecommendedFor(blockCategory);
    const blockReason = typeof classified.reason === 'string' && classified.reason.trim() ? classified.reason.trim().slice(0, 12) : null;
    const summary = typeof classified.summary === 'string' && classified.summary.trim() ? classified.summary.trim() : null;
    const actionItems = Array.isArray(classified.actionItems) ? classified.actionItems.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 50) : [];
    await this.requireLease(job, this.options.leaseGraceMs ?? 15_000);
    return {
      callId: job.callId, snapshotOwnerId: job.snapshotOwnerId, manifestFingerprint: job.manifestFingerprint,
      recording: {manifestVersion: frozen.manifest.version,
        source: fromAi ? 'ai_realtime_transcript' : frozen.manifest.version === 1 ? 'media' : 'pixel',
        // Transcript coverage must not claim both original tracks when one was skipped.
        // Preserve the archive's independent capture facts below without rewriting the manifest.
        complete: !fromAi && transcripts.length === frozen.tracks.length &&
          (frozen.manifest.version === 1 ? frozen.manifest.complete : frozen.manifest.captureComplete),
        ...(frozen.manifest.version === 1 ? {} : {archiveId: frozen.manifest.archiveId,
          manifestSha256: frozen.manifest.manifestSha256,
          archiveComplete: frozen.manifest.archiveComplete, captureComplete: frozen.manifest.captureComplete,
          selectionPolicy: 'original_capture_only', timebase: 'per_track_capture',
          capture: frozen.manifest.tracks.map(({track, captureComplete, gapCount, droppedFrames}) => ({track, captureComplete, gapCount, droppedFrames}))}),
        tracks: frozen.tracks.map(({track, name, mediaType, formatVersion, bytes, sha256}) => ({track, name, mediaType, formatVersion, bytes, sha256})),
        skippedTracks},
      text, segments,
      providers: transcripts.map(({track, result}) => ({track: track.track, provider: result.provider, model: result.model, version: result.version,
        ...('attempts' in result ? {attempts: result.attempts} : {})})),
      enrichment: classified.provider && classified.model ? {
        provider: classified.provider,
        model: classified.model,
        version: typeof classified.version === 'string' && classified.version.trim() ? classified.version.trim() : null,
        error: classified.enrichmentError && typeof classified.enrichmentError.code === 'string' && typeof classified.enrichmentError.message === 'string'
          ? {code: classified.enrichmentError.code.slice(0, 80), message: classified.enrichmentError.message.slice(0, 500)} : null,
      } : null,
      advertisingClassification: classification, includeInReports: classification !== 'advertising', summary, actionItems,
      blockCategory, blockRecommended, blockReason, classifierVersion: CLASSIFIER_VERSION,
      completedAt: (this.options.clock ?? (() => new Date()))().toISOString(),
    };
  }

  private async requireLease(job: TranscriptJob, operationTimeoutMs: number) {
    const renewed = await this.repository.renewLease({
      jobId: job.id, leaseToken: job.leaseToken!, leaseMs: operationTimeoutMs + (this.options.leaseGraceMs ?? 15_000),
    });
    if (!renewed) throw new TranscriptionWorkerError('STALE_LEASE', 'Transcript job lease is no longer owned');
  }
}

function retryDelayMs(input: {attempts: number; baseRetryMs: number; retryAfterMs?: number; random: () => number}) {
  const exponent = Math.max(0, Math.min(input.attempts - 1, 20));
  const exponential = Math.min(maxTranscriptionRetryDelayMs, input.baseRetryMs * 2 ** exponent);
  const floor = Math.min(maxTranscriptionRetryDelayMs, Math.max(exponential, input.retryAfterMs ?? 0));
  const random = input.random();
  const unit = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0;
  return Math.min(maxTranscriptionRetryDelayMs, Math.ceil(floor + floor * 0.2 * unit));
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const parentAbort = () => {
    controller.abort(parent?.reason);
    rejectAbort?.(new TranscriptionWorkerError('OPERATION_ABORTED', 'Transcript worker is stopping', true));
  };
  if (parent?.aborted) parentAbort(); else parent?.addEventListener('abort', parentAbort, {once: true});
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => { rejectAbort = reject; if (parent?.aborted) parentAbort(); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TranscriptionWorkerError('OPERATION_TIMEOUT', message, true));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', parentAbort);
  }
}
