import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {MediaNodeRegistry} from '../media-node-registry.js';
import {RemoteRecordingStore, type RecordingSource, type RecordingTrack} from '../recording-store.js';
import {freezeRecordingManifest, type RecordingReader, type TrackReadRequest} from './worker.js';
import type {PixelRecordingArchiveReader} from '../recording-archive.js';
import {validTranscriptionAudio} from './audio-format.js';
import {MAX_WAV_TRACK_BYTES} from './wav-chunks.js';

const MAX_OGG_TRACK_BYTES = 20 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class TranscriptRecordingReaderError extends Error {
  constructor(public readonly code: 'CALL_OWNER_MISMATCH' | 'RECORDING_UNAVAILABLE' | 'RECORDING_CONTRACT_MISMATCH' | 'RECORDING_TOO_LARGE' | 'ABORTED', message: string) { super(message); }
}

export type RecordingSourceResolver = (fixed: {nodeId: string; mediaEpoch: number}) => RecordingSource;
export type PixelTranscriptSource = Pick<PixelRecordingArchiveReader, 'manifest' | 'openTrack'>;

export function createRecordingSourceResolver(localSource: RecordingSource | null, registry: MediaNodeRegistry | null): RecordingSourceResolver {
  const cache = new Map<string, RecordingSource>();
  return ({nodeId, mediaEpoch}) => {
    if (nodeId === 'relay-primary' && localSource) return localSource;
    const key = `${nodeId}:${mediaEpoch}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (!registry) throw new TranscriptRecordingReaderError('RECORDING_UNAVAILABLE', 'Recording node registry is not configured');
    const baseUrl = registry.recordingBaseUrl(nodeId);
    if (!baseUrl) throw new TranscriptRecordingReaderError('RECORDING_UNAVAILABLE', 'Fixed media node does not expose recordings');
    const source = new RemoteRecordingStore(baseUrl, registry.recordingSecret(nodeId), nodeId, mediaEpoch);
    cache.set(key, source);
    return source;
  };
}

export class RegistryRecordingReader implements RecordingReader {
  constructor(private readonly db: Pick<Pool, 'query'>, private readonly resolveSource: RecordingSourceResolver,
    private readonly pixelSource?: PixelTranscriptSource) {}

  async readTrack(request: TrackReadRequest): Promise<Buffer> {
    throwIfAborted(request.signal);
    const pixel = request.source === 'pixel';
    // Pixel WAV beyond the provider cap is chunked by the worker; Ogg is still sent whole.
    const maxTrackBytes = pixel ? MAX_WAV_TRACK_BYTES : MAX_OGG_TRACK_BYTES;
    if (!Number.isSafeInteger(request.expectedBytes) || request.expectedBytes < 1 || request.expectedBytes > maxTrackBytes) {
      throw new TranscriptRecordingReaderError('RECORDING_TOO_LARGE', `Recording track must be between 1 byte and ${maxTrackBytes / 1024 / 1024} MiB`);
    }
    const formatMatches = pixel
      ? request.mediaType === 'audio/wav' && [2, 3].includes(request.formatVersion) && typeof request.archiveId === 'string'
      : (request.source === undefined || request.source === 'media') && request.mediaType === 'audio/ogg' && request.formatVersion === 1 && request.archiveId === undefined;
    if (!SHA256_RE.test(request.expectedSha256) || !formatMatches ||
        !['remote_original', 'caller_original'].includes(request.track) || request.name !== `${request.track}.${pixel ? 'wav' : 'ogg'}`) {
      throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Recording track request does not match its frozen source format');
    }
    const call = await this.db.query(`SELECT COALESCE(media_node_id,'relay-primary') media_node_id,media_epoch
      FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`, [request.callId, request.snapshotOwnerId]);
    if (!call.rowCount) throw new TranscriptRecordingReaderError('CALL_OWNER_MISMATCH', 'Call does not belong to the frozen owner');
    throwIfAborted(request.signal);
    const nodeId = call.rows[0].media_node_id as string;
    const mediaEpoch = Number(call.rows[0].media_epoch);
    if (!pixel && (!Number.isSafeInteger(mediaEpoch) || mediaEpoch < 1)) throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Call media epoch is invalid');
    const source = pixel ? this.pixelSource : this.resolveSource({nodeId, mediaEpoch});
    if (!source) throw new TranscriptRecordingReaderError('RECORDING_UNAVAILABLE', 'Frozen Pixel recording source is not enabled');
    const manifest = await source.manifest(request.callId);
    if (!manifest) throw new TranscriptRecordingReaderError('RECORDING_UNAVAILABLE', 'Recording manifest is unavailable');
    if (manifest.version === 1 ? pixel || (manifest.nodeId ?? 'relay-primary') !== nodeId || (manifest.mediaEpoch ?? 1) !== mediaEpoch
      : !pixel || manifest.archiveId !== request.archiveId) {
      throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Recording manifest does not match the fixed call node and epoch');
    }
    const frozen = freezeRecordingManifest(manifest, request.callId);
    const track = frozen.tracks.find((item) => item.track === request.track);
    if (frozen.fingerprint !== request.manifestFingerprint || !track || track.name !== request.name ||
        track.mediaType !== request.mediaType || track.formatVersion !== request.formatVersion ||
        track.bytes !== request.expectedBytes || track.sha256 !== request.expectedSha256) {
      throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Recording source no longer matches the frozen manifest');
    }
    throwIfAborted(request.signal);
    const opened = await source.openTrack(request.callId, request.track as RecordingTrack);
    if (opened.partial || opened.size !== request.expectedBytes || opened.sha256 !== request.expectedSha256) {
      opened.stream.destroy();
      throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Opened recording metadata does not match the frozen manifest');
    }
    // One allocation of the verified length: no chunk list plus concat copy (2×) for a long track.
    const bytes = Buffer.allocUnsafe(request.expectedBytes);
    let size = 0;
    const abort = () => opened.stream.destroy(new TranscriptRecordingReaderError('ABORTED', 'Recording read was cancelled'));
    request.signal.addEventListener('abort', abort, {once: true});
    try {
      for await (const value of opened.stream) {
        throwIfAborted(request.signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (size + chunk.length > request.expectedBytes) {
          opened.stream.destroy();
          throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Recording stream exceeded its frozen byte length');
        }
        chunk.copy(bytes, size);
        size += chunk.length;
      }
    } catch (error) {
      if (request.signal.aborted) throw new TranscriptRecordingReaderError('ABORTED', 'Recording read was cancelled');
      throw error;
    } finally {
      request.signal.removeEventListener('abort', abort);
    }
    if (size !== request.expectedBytes || !validTranscriptionAudio(bytes, request.mediaType, request.formatVersion) || createHash('sha256').update(bytes).digest('hex') !== request.expectedSha256) {
      throw new TranscriptRecordingReaderError('RECORDING_CONTRACT_MISMATCH', 'Recording bytes failed format or SHA-256 validation');
    }
    return bytes;
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new TranscriptRecordingReaderError('ABORTED', 'Recording read was cancelled');
}
