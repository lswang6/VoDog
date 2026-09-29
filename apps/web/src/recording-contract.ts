export type RecordingSource = 'media_node' | 'pixel';
export type OriginalRecordingTrack = 'remote_original' | 'caller_original';
export type DerivedRecordingTrack = 'caller_playout';
/** S36 C4: `conversation` 是虚拟轨——服务端把双方声音时间对齐后混成一条 mp3，没有对应的归档描述。 */
export type VirtualRecordingTrack = 'conversation';
export type RecordingTrack = OriginalRecordingTrack | DerivedRecordingTrack | VirtualRecordingTrack;
export type TrackDescriptor = {
 id: OriginalRecordingTrack; sourceRole: 'original_capture'; mediaType: 'audio/ogg' | 'audio/wav'; bytes: number;
 sha256: string; captureComplete: boolean | null; gapCount: number; droppedFrames: number;
 durationMs?: number;
};
export type DerivedTrackDescriptor = {
 id: DerivedRecordingTrack; sourceRole: 'derived_playout'; mediaType: 'audio/wav'; bytes: number;
 sha256: string; playoutComplete: boolean; gapCount: number; recoveryFrames: number;
 durationMs?: number;
};
export type RecordingDescriptor = {
 source: RecordingSource; version: 1 | 2 | 3; callId: string; archiveId?: string;
 manifestSha256?: string;
 archiveComplete: boolean; captureComplete: boolean | null; finalizedAt: string;
 tracks: TrackDescriptor[]; derivedTracks: DerivedTrackDescriptor[];
};
const originalTrackIds: OriginalRecordingTrack[] = ['remote_original', 'caller_original'];
const trackIds: RecordingTrack[] = [...originalTrackIds, 'caller_playout', 'conversation'];
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const invalid = () => new Error('录音信息与所选副本不一致，请稍后重试。');
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
 return value as Record<string, unknown>;
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid();
 return value;
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function sha(value: unknown): string { if (typeof value !== 'string' || !hash.test(value)) throw invalid(); return value; }
function date(value: unknown): string {
 if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid();
 return value;
}
function optionalDurationMs(value: unknown): number | undefined {
 if (value === undefined) return undefined;
 return count(value);
}
/** Source/version are an explicit contract. Never interpret a legacy Ogg response as Pixel WAV. */
export function parseRecording(value: unknown, source: RecordingSource, callId: string): RecordingDescriptor | null {
 if (value === null) return null;
 const raw = object(value);
 if (raw.callId !== callId || !uuid.test(callId)) throw invalid();
 if (source === 'media_node') {
  if (raw.version !== 1 || (raw.source !== undefined && raw.source !== 'media_node')) throw invalid();
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length !== 3) throw invalid();
  const artifacts = raw.artifacts.map(object);
  if (new Set(artifacts.map(a => a.name)).size !== 3 ||
      artifacts.some(a => !['remote_original.ogg', 'caller_original.ogg', 'timeline.jsonl'].includes(String(a.name)))) throw invalid();
  artifacts.forEach(a => { count(a.bytes, 512 * 1024 * 1024); sha(a.sha256); });
  const complete = flag(raw.complete);
  return {source, version: 1, callId, archiveComplete: complete, captureComplete: null,
   finalizedAt: date(raw.finalizedAt), tracks: originalTrackIds.map(id => {
    const artifact = artifacts.find(a => a.name === `${id}.ogg`)!;
    return {id, sourceRole: 'original_capture', mediaType: 'audio/ogg', bytes: count(artifact.bytes), sha256: sha(artifact.sha256),
     captureComplete: null, gapCount: 0, droppedFrames: 0, durationMs: optionalDurationMs(artifact.durationMs)};
   }), derivedTracks: []};
 }
 if (raw.source !== 'pixel' || (raw.version !== 2 && raw.version !== 3) || typeof raw.archiveId !== 'string' || !uuid.test(raw.archiveId)) throw invalid();
 const manifestSha256 = sha(raw.manifestSha256);
 if (!Array.isArray(raw.tracks) || raw.tracks.length !== 2) throw invalid();
 const entries = raw.tracks.map(object);
 if (new Set(entries.map(t => t.track)).size !== 2 || entries.some(t => !originalTrackIds.includes(t.track as OriginalRecordingTrack))) throw invalid();
 const tracks = entries.map(t => {
  if (t.sourceRole !== 'original_capture' || t.mediaType !== 'audio/wav') throw invalid();
  const bytes = count(t.bytes, 1024 * 1024 * 1024);
  if (bytes < 44) throw invalid();
  return {id: t.track as OriginalRecordingTrack, sourceRole: 'original_capture' as const, mediaType: 'audio/wav' as const, bytes, sha256: sha(t.sha256),
   captureComplete: flag(t.captureComplete), gapCount: count(t.gapCount), droppedFrames: count(t.droppedFrames), durationMs: optionalDurationMs(t.durationMs)};
 });
 let derivedTracks: DerivedTrackDescriptor[] = [];
 if (raw.version === 2) {
  if (raw.derivedTracks !== undefined) throw invalid();
 } else {
  if (!Array.isArray(raw.derivedTracks) || raw.derivedTracks.length !== 1) throw invalid();
  const derived = object(raw.derivedTracks[0]);
  if (derived.track !== 'caller_playout' || derived.sourceRole !== 'derived_playout' || derived.mediaType !== 'audio/wav') throw invalid();
  const bytes = count(derived.bytes, 1024 * 1024 * 1024);
  if (bytes < 44) throw invalid();
  derivedTracks = [{id: 'caller_playout', sourceRole: 'derived_playout', mediaType: 'audio/wav', bytes,
   sha256: sha(derived.sha256), playoutComplete: flag(derived.playoutComplete), gapCount: count(derived.gapCount),
   recoveryFrames: count(derived.recoveryFrames), durationMs: optionalDurationMs(derived.durationMs)}];
 }
 const timeline = object(raw.timeline);
 if (timeline.mediaType !== 'application/x-ndjson') throw invalid();
 if (count(timeline.bytes, 1024 * 1024 * 1024) < 1) throw invalid();
 sha(timeline.sha256);
 const startedAt = date(raw.startedAt), endedAt = date(raw.endedAt);
 if (Date.parse(endedAt) < Date.parse(startedAt)) throw invalid();
 const archiveComplete = flag(raw.archiveComplete), captureComplete = flag(raw.captureComplete);
 if (!archiveComplete || captureComplete !== tracks.every(t => t.captureComplete)) throw invalid();
 return {source, version: raw.version, callId, archiveId: raw.archiveId, manifestSha256, archiveComplete, captureComplete,
  finalizedAt: endedAt, tracks, derivedTracks};
}
/** S36 C4: `format=mp3` 只用于导出下载；播放 URL 不带 format，保持原始编码。 */
export function recordingUrl(callId: string, source: RecordingSource, track?: RecordingTrack, disposition?: 'attachment', format?: 'mp3'): string {
 if (!uuid.test(callId) || !['media_node', 'pixel'].includes(source) || (track !== undefined && !trackIds.includes(track)) ||
     (track === 'caller_playout' && source !== 'pixel') || (track === 'conversation' && format !== 'mp3') || (disposition === 'attachment' && !track) ||
     (format !== undefined && (format !== 'mp3' || disposition !== 'attachment'))) throw invalid();
 const query = disposition === 'attachment' ? `source=${source}&disposition=attachment` : `source=${source}`;
 return `/api/v1/calls/${encodeURIComponent(callId)}/recordings${track ? `/${track}` : ''}?${query}${format ? `&format=${format}` : ''}`;
}
const attachmentName = /^(?:call-)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-(?:(?:media_node|pixel)-)?(?:remote_original|caller_original|caller_playout|conversation)\.(?:ogg|wav|mp3)$/i;
/** S36 C4: 导出 mp3 时文件名必须是 .mp3；服务端的 `<callId>-<track>.mp3` 没有 `call-`/来源前缀，也要认。 */
export function recordingAttachmentFilename(callId: string, source: RecordingSource, track: RecordingTrack, header?: string | null, format?: 'mp3'): string {
 const ext = format === 'mp3' ? 'mp3' : source === 'pixel' ? 'wav' : 'ogg';
 const fallback = track === 'conversation' ? `${callId}-conversation.mp3` : `call-${callId}-${source}-${track}.${ext}`;
 const quoted = typeof header === 'string' ? /filename="([^"]+)"/i.exec(header)?.[1] : undefined;
 return quoted && attachmentName.test(quoted) ? quoted : fallback;
}
/** Verify the one-byte preflight before exposing a WAV URL to the native browser player. */
export function verifyPixelTrackHeaders(status: number, headers: Headers, track: TrackDescriptor | DerivedTrackDescriptor): void {
 if (headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'audio/wav' ||
     headers.get('ETag') !== `"${track.sha256}"` || headers.get('Accept-Ranges')?.toLowerCase() !== 'bytes') throw invalid();
 if (status === 206 && headers.get('Content-Range') === `bytes 0-0/${track.bytes}` && headers.get('Content-Length') === '1') return;
 // A server may legally ignore Range. Cancel its body immediately; never buffer a full recording here.
 if (status === 200 && headers.get('Content-Length') === String(track.bytes)) return;
 throw invalid();
}
