import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { validatedControlBaseUrl } from './media-client.js';

export const recordingTracks = ['remote_original', 'caller_original'] as const;
export type RecordingTrack = typeof recordingTracks[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const artifactSchema = z.object({
  name: z.enum(['remote_original.ogg', 'caller_original.ogg', 'timeline.jsonl']),
  bytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationMs: z.number().int().nonnegative().optional(),
});
const TIMELINE_DURATION_MAX_BYTES = 32 * 1024 * 1024;
const manifestSchema = z.object({
  version: z.literal(1), callId: z.string().regex(uuid), finalizedAt: z.string().datetime(),
  nodeId: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  mediaEpoch: z.number().int().positive().optional(),
  complete: z.boolean(), artifacts: z.array(artifactSchema).length(3),
}).refine(value => new Set(value.artifacts.map(a => a.name)).size === 3);
export type RecordingManifest = z.infer<typeof manifestSchema>;
export type OpenedRecordingTrack = {stream:Readable;size:number;sha256:string;complete:boolean;start:number;end:number;partial:boolean};
export interface RecordingSource {
  manifest(callId: string): Promise<RecordingManifest | null>;
  openTrack(callId: string, track: RecordingTrack, rangeHeader?: string): Promise<OpenedRecordingTrack>;
}
export class RecordingStoreError extends Error {
  constructor(public readonly code: 'INVALID_RECORDING_PATH' | 'RECORDING_UNAVAILABLE' | 'RECORDING_CORRUPT' | 'RANGE_NOT_SATISFIABLE', public readonly size?: number) { super(code); }
}

export function recordingByteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new RecordingStoreError('RANGE_NOT_SATISFIABLE', size);
  const suffix = !match[1];
  const first = Number(match[1]), last = Number(match[2]);
  if (![first, last].every(Number.isSafeInteger) || (suffix && last === 0)) throw new RecordingStoreError('RANGE_NOT_SATISFIABLE', size);
  const start = suffix ? Math.max(0, size - last) : first;
  const end = suffix || !match[2] ? size - 1 : Math.min(last, size - 1);
  if (start >= size || start > end) throw new RecordingStoreError('RANGE_NOT_SATISFIABLE', size);
  return { start, end, partial: true };
}

function isOriginalDirection(value: unknown): value is RecordingTrack {
  return value === 'remote_original' || value === 'caller_original';
}

/** Serve-time Ogg duration from timeline packet durationMs. Never derived from byte length. */
async function timelineTrackDurationMs(dir: string, artifacts: RecordingManifest['artifacts']): Promise<Partial<Record<RecordingTrack, number>> | undefined> {
  const timeline = artifacts.find((item) => item.name === 'timeline.jsonl');
  if (!timeline || timeline.bytes < 1 || timeline.bytes > TIMELINE_DURATION_MAX_BYTES) return;
  let file: FileHandle | undefined;
  try {
    file = await open(join(dir, 'timeline.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== timeline.bytes) return;
    const text = await file.readFile('utf8');
    const sums = new Map<RecordingTrack, number>();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      const direction = (parsed as {direction?: unknown}).direction;
      const durationMs = (parsed as {durationMs?: unknown}).durationMs;
      if (!isOriginalDirection(direction) || !Number.isInteger(durationMs) || (durationMs as number) < 0) continue;
      const next = (sums.get(direction) ?? 0) + (durationMs as number);
      if (next > Number.MAX_SAFE_INTEGER) return;
      sums.set(direction, next);
    }
    if (!sums.size) return;
    return Object.fromEntries(sums) as Partial<Record<RecordingTrack, number>>;
  } catch {
    return;
  } finally { await file?.close(); }
}

async function withTimelineDurations(dir: string, manifest: RecordingManifest): Promise<RecordingManifest> {
  const durations = await timelineTrackDurationMs(dir, manifest.artifacts);
  if (!durations) return manifest;
  return {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact) => {
      if (artifact.name === 'remote_original.ogg' && durations.remote_original !== undefined)
        return { ...artifact, durationMs: durations.remote_original };
      if (artifact.name === 'caller_original.ogg' && durations.caller_original !== undefined)
        return { ...artifact, durationMs: durations.caller_original };
      return artifact;
    }),
  };
}

/** The caller must authorize the call's immutable owner before using this store. */
export class RecordingStore {
  constructor(private readonly root: string) {}

  private async directory(callId: string) {
    if (!uuid.test(callId)) throw new RecordingStoreError('INVALID_RECORDING_PATH');
    try {
      const root = await realpath(this.root);
      const dir = join(root, callId);
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RecordingStoreError('INVALID_RECORDING_PATH');
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async manifest(callId: string): Promise<RecordingManifest | null> {
    const dir = await this.directory(callId);
    if (!dir) return null;
    let file: FileHandle | undefined;
    try {
      file = await open(join(dir, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new RecordingStoreError('RECORDING_CORRUPT');
      const result = manifestSchema.safeParse(JSON.parse(await file.readFile('utf8')));
      if (!result.success || result.data.callId !== callId) throw new RecordingStoreError('RECORDING_CORRUPT');
      return withTimelineDurations(dir, result.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof RecordingStoreError) throw error;
      throw new RecordingStoreError('RECORDING_CORRUPT');
    } finally { await file?.close(); }
  }

  /**
   * S36 C4: milliseconds by which `remote_original` starts after `caller_original`, from the first
   * packet each direction received on the node's shared clock. Negative when the caller starts later.
   * Only the local store can read it — a media node's internal API serves the manifest and the two
   * tracks, not `timeline.jsonl`.
   */
  async firstPacketSkewMs(callId: string, timelineBytes: number): Promise<number | null> {
    if (timelineBytes < 1 || timelineBytes > TIMELINE_DURATION_MAX_BYTES) return null;
    const dir = await this.directory(callId);
    if (!dir) return null;
    let file: FileHandle | undefined;
    try {
      file = await open(join(dir, 'timeline.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== timelineBytes) return null;
      const first = new Map<RecordingTrack, number>();
      for (const line of (await file.readFile('utf8')).split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { return null; }
        const direction = (parsed as {direction?: unknown})?.direction;
        const elapsedUs = (parsed as {receivedElapsedUs?: unknown})?.receivedElapsedUs;
        if (!isOriginalDirection(direction) || typeof elapsedUs !== 'number' || !Number.isFinite(elapsedUs) || first.has(direction)) continue;
        first.set(direction, elapsedUs);
        if (first.size === 2) break;
      }
      const remote = first.get('remote_original'), caller = first.get('caller_original');
      return remote === undefined || caller === undefined ? null : Math.round((remote - caller) / 1000);
    } catch {
      return null;
    } finally { await file?.close(); }
  }

  async openTrack(callId: string, track: RecordingTrack, rangeHeader?: string) {
    if (!recordingTracks.includes(track)) throw new RecordingStoreError('INVALID_RECORDING_PATH');
    const manifest = await this.manifest(callId);
    if (!manifest) throw new RecordingStoreError('RECORDING_UNAVAILABLE');
    const artifact = manifest.artifacts.find(a => a.name === `${track}.ogg`)!;
    if (artifact.bytes === 0) throw new RecordingStoreError('RECORDING_UNAVAILABLE');
    const range = recordingByteRange(rangeHeader, artifact.bytes);
    const dir = await this.directory(callId);
    if (!dir) throw new RecordingStoreError('RECORDING_UNAVAILABLE');
    let file: FileHandle | undefined;
    try {
      file = await open(join(dir, artifact.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== artifact.bytes) throw new RecordingStoreError('RECORDING_CORRUPT');
      const hash = createHash('sha256');
      // Verify final bytes without buffering the recording in control-service memory.
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
      if (hash.digest('hex') !== artifact.sha256) throw new RecordingStoreError('RECORDING_CORRUPT');
      const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: true });
      file = undefined; // stream owns and closes the file descriptor, including aborts.
      return { stream, size: artifact.bytes, sha256: artifact.sha256, complete: manifest.complete, ...range };
    } catch (error) {
      if (error instanceof RecordingStoreError) throw error;
      throw new RecordingStoreError('RECORDING_CORRUPT');
    } finally { await file?.close(); }
  }
}

/**
 * The signed contract shared with `services/media` `recordingCanonicalString` and
 * `infra/retention.py` `recording_delete_canonical`: `{METHOD}\n{path}\n{timestamp}\n{nonce}\n{Range}`.
 * The method is part of the canonical string, so a GET signature can never authorize a DELETE; the
 * Range line is always present and is empty for every request that carries no Range header.
 */
export function recordingRequestHeaders(secret:string,method:'GET'|'DELETE',path:string,range=''){
  const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(18).toString('base64url');
  const canonical=`${method}\n${path}\n${timestamp}\n${nonce}\n${range}`;
  return {'X-CC-Timestamp':timestamp,'X-CC-Nonce':nonce,'X-CC-Signature':createHmac('sha256',secret).update(canonical).digest('base64url'),...(range?{Range:range}:{})};
}

/** Reads immutable recordings from one configured media node over its internal API. */
export class RemoteRecordingStore implements RecordingSource {
  private readonly baseUrl:string;
  constructor(baseUrl:string,private readonly secret:string,private readonly nodeId:string,private readonly mediaEpoch:number){
    if(secret.length<32)throw new Error('Remote recording source is not configured');
    this.baseUrl=validatedControlBaseUrl(baseUrl);
  }
  private headers(path:string,range='',method:'GET'|'DELETE'='GET'){
    return recordingRequestHeaders(this.secret,method,path,range);
  }
  async manifest(callId:string){
    if(!uuid.test(callId))throw new RecordingStoreError('INVALID_RECORDING_PATH');
    const path=`/internal/recordings/${callId}/manifest`;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);let response:Response;
    try{response=await fetch(this.baseUrl+path,{headers:this.headers(path),signal:controller.signal,redirect:'error'});}catch{throw new RecordingStoreError('RECORDING_UNAVAILABLE');}finally{clearTimeout(timer);}
    if(response.status===404){await cancelBody(response);return null;}
    if(!response.ok){await cancelBody(response);throw new RecordingStoreError('RECORDING_UNAVAILABLE');}
    const length=Number(response.headers.get('content-length')??'0');
    if(length>65536){await cancelBody(response);throw new RecordingStoreError('RECORDING_CORRUPT');}
    let parsed;
    try{parsed=manifestSchema.safeParse(JSON.parse((await readBoundedBody(response,65536)).toString('utf8')));}catch{throw new RecordingStoreError('RECORDING_CORRUPT');}
    if(!parsed.success||parsed.data.callId!==callId||parsed.data.nodeId!==this.nodeId||parsed.data.mediaEpoch!==this.mediaEpoch)throw new RecordingStoreError('RECORDING_CORRUPT');
    return parsed.data;
  }
  async openTrack(callId:string,track:RecordingTrack,rangeHeader?:string){
    if(!recordingTracks.includes(track))throw new RecordingStoreError('INVALID_RECORDING_PATH');
    const manifest=await this.manifest(callId);if(!manifest)throw new RecordingStoreError('RECORDING_UNAVAILABLE');
    const artifact=manifest.artifacts.find(item=>item.name===`${track}.ogg`)!;if(!artifact.bytes)throw new RecordingStoreError('RECORDING_UNAVAILABLE');
    const range=recordingByteRange(rangeHeader,artifact.bytes),rangeValue=range.partial?`bytes=${range.start}-${range.end}`:'';
    const path=`/internal/recordings/${callId}/tracks/${track}`;
    const controller=new AbortController(),headerTimer=setTimeout(()=>controller.abort(),15000);let response:Response;
    try{response=await fetch(this.baseUrl+path,{headers:this.headers(path,rangeValue),signal:controller.signal,redirect:'error'});}catch{throw new RecordingStoreError('RECORDING_UNAVAILABLE');}finally{clearTimeout(headerTimer);}
    if(response.status===416){await cancelBody(response);throw new RecordingStoreError('RANGE_NOT_SATISFIABLE',artifact.bytes);}
    if(response.status!==(range.partial?206:200)||!response.body){await cancelBody(response);throw new RecordingStoreError('RECORDING_UNAVAILABLE');}
    const expectedBytes=range.end-range.start+1;
    if(Number(response.headers.get('content-length'))!==expectedBytes||response.headers.get('etag')!==`"${artifact.sha256}"`){await cancelBody(response);throw new RecordingStoreError('RECORDING_CORRUPT');}
    if(range.partial&&response.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${artifact.bytes}`){await cancelBody(response);throw new RecordingStoreError('RECORDING_CORRUPT');}
    const stream=Readable.fromWeb(response.body as never);
    let idleTimer:NodeJS.Timeout;const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>{controller.abort();stream.destroy(new Error('Remote recording stream idle timeout'));},30000);idleTimer.unref();};resetIdle();stream.on('data',resetIdle);stream.once('close',()=>{clearTimeout(idleTimer);controller.abort();});stream.once('end',()=>clearTimeout(idleTimer));
    return {stream,size:artifact.bytes,sha256:artifact.sha256,complete:manifest.complete,...range};
  }
}

async function cancelBody(response:Response){try{await response.body?.cancel();}catch{/* rejection path remains authoritative */}}
async function readBoundedBody(response:Response,maxBytes:number){
  if(!response.body)throw new Error('missing body');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(value){size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('body too large');}chunks.push(value);}}}finally{reader.releaseLock();}
  return Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),size);
}
