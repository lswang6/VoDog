import type {Pool,PoolClient} from 'pg';
import type {Config} from '../config.js';
import {attachClientErrorListener,takeClientError} from '../db.js';
import {workerError} from '../diag.js';
import {MediaNodeRegistry} from '../media-node-registry.js';
import {RecordingStore,type RecordingSource,type RecordingManifest} from '../recording-store.js';
import {createGeminiTranscriptionProvider,createOpenAICompatibleTranscriptionProvider} from './provider.js';
import {createOpenAICompatibleTranscriptClassifier} from './classifier.js';
import {createRecordingSourceResolver,RegistryRecordingReader,type RecordingSourceResolver,type PixelTranscriptSource} from './reader.js';
import {PixelRecordingArchiveReader,type PixelRecordingDescriptor} from '../recording-archive.js';
import {hasAiTranscript,readAiTranscriptLines} from '../ai-runs/transcripts.js';
import {PostgresTranscriptJobRepository} from './repository.js';
import {TranscriptionWorker,freezeRecordingManifest} from './worker.js';

type WorkerLike={enqueueCall(input:{callId:string;snapshotOwnerId:string;manifest:unknown}):Promise<unknown>;tickOnce(signal?:AbortSignal):Promise<string>};
export type TranscriptionRuntimeOptions={
  enabled:boolean;db?:Pool;worker?:WorkerLike;resolveSource?:RecordingSourceResolver;enabledAt?:Date;
  intervalMs?:number;scanBatch?:number;discoveryTimeoutMs?:number;stopTimeoutMs?:number;
  pixelSource?:PixelTranscriptSource;
};
export type TranscriptionTickResult='disabled'|'busy'|{scanned:number;enqueued:number;worker:string};
const LOCK_KEY='vodog:transcription-runtime:v1';

export class TranscriptionRuntime {
  private timer:NodeJS.Timeout|null=null;
  private running:Promise<void>|null=null;
  private stopped=true;
  private controller=new AbortController();
  private activeOperation:Promise<TranscriptionTickResult>|null=null;
  private generation=0;
  private cursor:{endedAt:Date;id:string}|null=null;
  private readonly intervalMs:number;
  private readonly scanBatch:number;
  private readonly discoveryTimeoutMs:number;
  private readonly stopTimeoutMs:number;
  constructor(private readonly options:TranscriptionRuntimeOptions){
    this.intervalMs=Math.max(250,options.intervalMs??5000);this.scanBatch=Math.min(10,Math.max(1,options.scanBatch??2));
    this.discoveryTimeoutMs=Math.max(100,options.discoveryTimeoutMs??20_000);
    this.stopTimeoutMs=Math.max(25,options.stopTimeoutMs??2_000);
    if(options.enabled&&(!options.db||!options.worker||!options.resolveSource||!options.enabledAt||!Number.isFinite(options.enabledAt.getTime())))throw new Error('Enabled transcription runtime is not fully configured');
  }
  start(){if(!this.options.enabled||!this.stopped)return;this.stopped=false;this.controller=new AbortController();const generation=++this.generation;this.schedule(0,generation);}
  async stop(){
    this.stopped=true;this.generation++;this.controller.abort();if(this.timer){clearTimeout(this.timer);this.timer=null;}
    const cleanup=this.activeOperation;
    if(cleanup)await Promise.race([cleanup.then(()=>undefined,()=>undefined),delay(this.stopTimeoutMs)]);
  }
  private schedule(delay:number,generation:number){
    if(this.stopped||generation!==this.generation)return;
    this.timer=setTimeout(()=>{
      this.timer=null;
      this.running=this.tickOnce().then(()=>undefined,error=>{if(this.options.db)workerError(this.options.db,'transcription_runtime',error);}).finally(()=>{
        this.running=null;this.schedule(this.intervalMs,generation);
      });
    },delay);this.timer.unref();
  }
  async tickOnce():Promise<TranscriptionTickResult>{
    if(!this.options.enabled)return'disabled';
    if(this.activeOperation)return'busy';
    const signal=this.controller.signal;
    if(signal.aborted)return{scanned:0,enqueued:0,worker:'stopped'};
    const operation=this.performTick(signal);this.activeOperation=operation;
    operation.then(()=>{if(this.activeOperation===operation)this.activeOperation=null;},()=>{if(this.activeOperation===operation)this.activeOperation=null;});
    return raceAbort(operation,signal,{scanned:0,enqueued:0,worker:'stopped'});
  }

  private async performTick(signal:AbortSignal):Promise<TranscriptionTickResult>{
    const db=this.options.db!,pendingClient=db.connect();let client:PoolClient;
    try{client=await bounded(pendingClient,signal,this.discoveryTimeoutMs,'database connection');}
    catch(error){pendingClient.then(late=>late.release(asError(error)),()=>undefined);throw error;}
    let locked=false,released=false;
    // The advisory lease is session scoped, so this client stays checked out for the whole
    // tick; without a listener a connection Postgres kills would crash the process.
    const detach=attachClientErrorListener(client);
    const release=(error?:Error)=>{if(released)return;released=true;detach();client.release(error??takeClientError(client));};
    try{
      const lockQuery=client.query(`SELECT pg_try_advisory_lock(hashtext($1)) locked`,[LOCK_KEY]);
      let lock;
      try{lock=await bounded(lockQuery,signal,this.discoveryTimeoutMs,'advisory lock');}
      catch(error){release(asError(error));lockQuery.catch(()=>undefined);throw error;}
      locked=lock.rows[0]?.locked===true;
      if(signal.aborted){release(new Error('transcription runtime stopped after advisory lock'));return{scanned:0,enqueued:0,worker:'stopped'};}
      if(!locked)return'busy';
      const candidateQuery=client.query(`SELECT c.id,c.snapshot_owner_id,COALESCE(c.media_node_id,'relay-primary') media_node_id,c.media_epoch,c.ended_at
        FROM call_records c WHERE c.state='ended' AND c.ended_at IS NOT NULL AND c.ended_at >= $1
          AND c.recording_status IN ('pending','ready','complete')
          AND NOT (c.internal_call AND c.direction='outgoing')
          AND NOT EXISTS(SELECT 1 FROM transcript_jobs j WHERE j.call_id=c.id AND j.snapshot_owner_id=c.snapshot_owner_id)
          AND ($3::timestamptz IS NULL OR (c.ended_at,c.id)>($3::timestamptz,$4::uuid))
        ORDER BY c.ended_at,c.id LIMIT $2`,[this.options.enabledAt,this.scanBatch,this.cursor?.endedAt??null,this.cursor?.id??null]);
      let candidates;
      try{candidates=await bounded(candidateQuery,signal,this.discoveryTimeoutMs,'candidate scan');}
      catch(error){release(asError(error));candidateQuery.catch(()=>undefined);throw error;}
      if(signal.aborted){release(new Error('transcription runtime stopped after candidate scan'));return{scanned:0,enqueued:0,worker:'stopped'};}
      if(!candidates.rowCount&&this.cursor){
        this.cursor=null;
        const wrapQuery=client.query(`SELECT c.id,c.snapshot_owner_id,COALESCE(c.media_node_id,'relay-primary') media_node_id,c.media_epoch,c.ended_at
        FROM call_records c WHERE c.state='ended' AND c.ended_at IS NOT NULL AND c.ended_at >= $1
          AND c.recording_status IN ('pending','ready','complete')
          AND NOT (c.internal_call AND c.direction='outgoing')
          AND NOT EXISTS(SELECT 1 FROM transcript_jobs j WHERE j.call_id=c.id AND j.snapshot_owner_id=c.snapshot_owner_id)
        ORDER BY c.ended_at,c.id LIMIT $2`,[this.options.enabledAt,this.scanBatch]);
        try{candidates=await bounded(wrapQuery,signal,this.discoveryTimeoutMs,'candidate wrap scan');}
        catch(error){release(asError(error));wrapQuery.catch(()=>undefined);throw error;}
        if(signal.aborted){release(new Error('transcription runtime stopped after candidate wrap scan'));return{scanned:0,enqueued:0,worker:'stopped'};}
      }
      let enqueued=0;
      for(const call of candidates.rows){
        this.cursor={endedAt:call.ended_at,id:call.id};
        if(signal.aborted)break;
        try{
          const nodeId=call.media_node_id as string,mediaEpoch=Number(call.media_epoch);
          // S22 决策 6. The source is chosen ONCE, here, and the frozen job never switches it later:
          // a retry must never silently swap the audio under an already fingerprinted job. What
          // changed is only which copy may be chosen at this moment — a Pixel archive that finished
          // uploading but captured nothing (`captureComplete=false`) may hand over to a complete
          // media-node copy of the same call instead of blocking the report forever.
          const source=this.options.pixelSource??this.options.resolveSource!({nodeId,mediaEpoch});
          const manifest=await bounded<RecordingManifest|PixelRecordingDescriptor|null>(source.manifest(call.id),signal,this.discoveryTimeoutMs,'recording manifest');if(!manifest)continue;
          if(signal.aborted)break;
          let selected:RecordingManifest|PixelRecordingDescriptor|null=null;
          if(manifest.version===1){
            if((manifest.nodeId??'relay-primary')!==nodeId||(manifest.mediaEpoch??1)!==mediaEpoch)continue;
            if(manifest.complete)selected=manifest;
            else if(!emptyMediaRecording(manifest))continue;// still finalizing: try again next scan
          }else{
            if(!this.options.pixelSource||!manifest.archiveComplete)continue;
            // A Pixel archive is terminal once uploaded: waiting changes nothing. A partial capture
            // that still holds real audio is transcribed as before — the media node is consulted
            // ONLY when the verified Pixel copy is worthless, so a usable copy is never swapped.
            if(manifest.captureComplete||!emptyPixelRecording(manifest))selected=manifest;
            else{
              const fallback=await this.mediaNodeManifest(call.id,nodeId,mediaEpoch,signal);
              if(fallback&&fallback.complete)selected=fallback;
              else if(fallback&&!emptyMediaRecording(fallback))continue;// the media copy may still finalize
            }
          }
          if(!selected){
            // No copy carries audio at all. An AI-answered call still has its realtime transcript, so
            // enqueue and let the worker classify that; anything else gets ONE terminal job so this
            // call stops being rescanned on every tick.
            if(await bounded(hasAiTranscript(client,call.id),signal,this.discoveryTimeoutMs,'ai transcript probe'))selected=manifest;
            else{await this.recordEmptyRecording(client,call,manifest,signal);continue;}
          }
          freezeRecordingManifest(selected,call.id);
          const readyUpdate=client.query(`UPDATE call_records SET recording_status='ready'
            WHERE id=$1 AND snapshot_owner_id=$2 AND media_node_id=$3 AND media_epoch=$4
              AND state='ended' AND recording_status='pending'`,[call.id,call.snapshot_owner_id,nodeId,mediaEpoch]);
          try{await bounded(readyUpdate,signal,this.discoveryTimeoutMs,'recording readiness');}
          catch(error){release(asError(error));readyUpdate.catch(()=>undefined);throw error;}
          if(signal.aborted)break;
          await this.options.worker!.enqueueCall({callId:call.id,snapshotOwnerId:call.snapshot_owner_id,manifest:selected});enqueued++;
        }catch(error){if(released)throw error;/* unavailable recording retries on the next bounded scan */}
      }
      const worker=signal.aborted?'stopped':await this.options.worker!.tickOnce(signal);
      return{scanned:candidates.rowCount??0,enqueued,worker};
    }finally{
      if(!released&&!locked)release();
      else if(!released){
        const unlockQuery=client.query(`SELECT pg_advisory_unlock(hashtext($1)) unlocked`,[LOCK_KEY]);
        try{
          const result=await bounded(unlockQuery,undefined,this.discoveryTimeoutMs,'advisory unlock');
          release(result.rows[0]?.unlocked===true?undefined:new Error('transcription advisory unlock failed'));
        }catch(error){release(asError(error));unlockQuery.catch(()=>undefined);}
      }
    }
  }

  /** The media-node copy of the same call. Read only to choose the source at enqueue time. */
  private async mediaNodeManifest(callId:string,nodeId:string,mediaEpoch:number,signal:AbortSignal):Promise<RecordingManifest|null>{
    if(!this.options.resolveSource)return null;
    try{
      const manifest=await bounded<RecordingManifest|PixelRecordingDescriptor|null>(
        this.options.resolveSource({nodeId,mediaEpoch}).manifest(callId),signal,this.discoveryTimeoutMs,'media node manifest');
      if(!manifest||manifest.version!==1)return null;
      return (manifest.nodeId??'relay-primary')===nodeId&&(manifest.mediaEpoch??1)===mediaEpoch?manifest:null;
    }catch{return null;}
  }

  /**
   * One terminal job for a call whose recording will never produce audio. Without it the candidate
   * scan (`NOT EXISTS transcript_jobs`) re-reads the same manifest on every tick forever, and the
   * client is left staring at `recording_status='pending'` with no explanation.
   */
  private async recordEmptyRecording(client:PoolClient,call:{id:string;snapshot_owner_id:string},
    manifest:RecordingManifest|PixelRecordingDescriptor,signal:AbortSignal){
    let fingerprint:string;
    try{fingerprint=freezeRecordingManifest(manifest,call.id).fingerprint;}catch{return;}
    const insert=client.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,error_code,error_message,completed_at)
      SELECT c.id,$2,$3::jsonb,$4,'failed','RECORDING_EMPTY',$5,clock_timestamp() FROM call_records c
      WHERE c.id=$1 AND c.snapshot_owner_id=$2
      ON CONFLICT(call_id,snapshot_owner_id,manifest_fingerprint) DO NOTHING`,
      [call.id,call.snapshot_owner_id,JSON.stringify(manifest),fingerprint,'录音为空或采集失败']);
    await bounded(insert,signal,this.discoveryTimeoutMs,'terminal empty recording');
  }
}

/**
 * S22 决策 6 emptiness thresholds. A finalized media-node recording of a call with zero RTP is two
 * ~95 byte Ogg headers and a zero byte timeline; a failed Pixel capture is two 44 byte WAV headers.
 * Anything above those is real audio that may still be finalizing, so it is waited for, not dropped.
 */
const EMPTY_OGG_BYTES=100,EMPTY_WAV_BYTES=44;
export function emptyMediaRecording(manifest:RecordingManifest):boolean{
  const artifact=(name:string)=>manifest.artifacts.find(item=>item.name===name);
  const tracks=['remote_original.ogg','caller_original.ogg'].map(artifact);
  const timeline=artifact('timeline.jsonl');
  return tracks.every(track=>!track||track.bytes<=EMPTY_OGG_BYTES)||timeline?.bytes===0;
}
export function emptyPixelRecording(descriptor:PixelRecordingDescriptor):boolean{
  return descriptor.tracks.every(track=>track.bytes<=EMPTY_WAV_BYTES);
}

class RuntimeTimeoutError extends Error{constructor(label:string){super(`${label} timed out`);this.name='RuntimeTimeoutError';}}
function asError(value:unknown){return value instanceof Error?value:new Error('transcription runtime operation failed');}
function delay(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}
async function bounded<T>(operation:Promise<T>,signal:AbortSignal|undefined,timeoutMs:number,label:string):Promise<T>{
  if(signal?.aborted)throw signal.reason??new Error('transcription runtime stopped');
  let timer:NodeJS.Timeout|undefined,onAbort:(()=>void)|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RuntimeTimeoutError(label)),timeoutMs);timer.unref();});
  const aborted=signal?new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason??new Error('transcription runtime stopped'));signal.addEventListener('abort',onAbort,{once:true});}):new Promise<never>(()=>undefined);
  try{return await Promise.race([operation,timeout,aborted]);}
  finally{if(timer)clearTimeout(timer);if(signal&&onAbort)signal.removeEventListener('abort',onAbort);}
}
async function raceAbort<T>(operation:Promise<T>,signal:AbortSignal,abortedValue:T):Promise<T>{
  if(signal.aborted)return abortedValue;
  let onAbort!:()=>void;
  const aborted=new Promise<T>(resolve=>{onAbort=()=>resolve(abortedValue);signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([operation,aborted]);}finally{signal.removeEventListener('abort',onAbort);}
}

export function createTranscriptionRuntime(db:Pool,config:Config):TranscriptionRuntime{
  if(!config.TRANSCRIPTION_ENABLED)return new TranscriptionRuntime({enabled:false});
  if(!config.TRANSCRIPTION_ENABLED_AT||!config.TRANSCRIPTION_API_KEY)throw new Error('Enabled transcription requires TRANSCRIPTION_ENABLED_AT and TRANSCRIPTION_API_KEY');
  const registry=MediaNodeRegistry.fromConfig(config),local:RecordingSource|null=config.RECORDING_ROOT?new RecordingStore(config.RECORDING_ROOT):null;
  const resolveSource=createRecordingSourceResolver(local,registry);
  if(config.PIXEL_ARCHIVE_ENABLED&&!config.PIXEL_ARCHIVE_ROOT)throw new Error('Pixel transcription source requires PIXEL_ARCHIVE_ROOT');
  const pixelSource=config.PIXEL_ARCHIVE_ENABLED?new PixelRecordingArchiveReader(db,config.PIXEL_ARCHIVE_ROOT!):undefined;
  const reader=new RegistryRecordingReader(db,resolveSource,pixelSource),repository=new PostgresTranscriptJobRepository(db);
  const reportFields=[config.REPORT_AI_BASE_URL,config.REPORT_AI_API_KEY,config.REPORT_AI_MODEL];
  if(reportFields.some(Boolean)&&!reportFields.every(Boolean))throw new Error('Report classification requires REPORT_AI_BASE_URL, REPORT_AI_API_KEY and REPORT_AI_MODEL together');
  const classifier=reportFields.every(Boolean)?createOpenAICompatibleTranscriptClassifier({baseURL:config.REPORT_AI_BASE_URL!,apiKey:config.REPORT_AI_API_KEY!,model:config.REPORT_AI_MODEL!}):undefined;
  // S23 决策 5. A configured base URL is the whole switch: the OpenAI-compatible server needs an
  // explicit model (its catalogue does not contain the native Gemini default), so it fails closed.
  if(config.TRANSCRIPTION_BASE_URL&&!config.TRANSCRIPTION_MODEL)throw new Error('OpenAI-compatible transcription requires TRANSCRIPTION_MODEL');
  const provider=config.TRANSCRIPTION_BASE_URL
    ?createOpenAICompatibleTranscriptionProvider({baseURL:config.TRANSCRIPTION_BASE_URL,apiKey:config.TRANSCRIPTION_API_KEY,model:config.TRANSCRIPTION_MODEL!,fallbackModel:config.TRANSCRIPTION_FALLBACK_MODEL,classifier})
    :createGeminiTranscriptionProvider({apiKey:config.TRANSCRIPTION_API_KEY,model:config.TRANSCRIPTION_MODEL,classifier});
  // The compatible provider may spend three 65 s attempts inside one call, so its outer bound is
  // widened from the default 120 s; the lease is renewed against the same number before each call.
  const worker=new TranscriptionWorker(repository,{enabled:true,reader,provider,maxAttempts:4,
    ...(config.TRANSCRIPTION_BASE_URL?{providerTimeoutMs:210_000}:{}),
    aiTranscripts:input=>readAiTranscriptLines(db,input)});
  return new TranscriptionRuntime({enabled:true,db,worker,resolveSource,pixelSource,enabledAt:new Date(config.TRANSCRIPTION_ENABLED_AT),intervalMs:config.TRANSCRIPTION_SCAN_INTERVAL_SECONDS*1000,scanBatch:config.TRANSCRIPTION_SCAN_BATCH});
}
