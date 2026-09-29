import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {Pool} from 'pg';
import {loadConfig} from '../src/config.js';
import {createDb,type Db} from '../src/db.js';
import type {RecordingManifest,RecordingSource,RecordingTrack} from '../src/recording-store.js';
import {RegistryRecordingReader,type RecordingSourceResolver} from '../src/transcription/reader.js';
import {PostgresTranscriptJobRepository} from '../src/transcription/repository.js';
import {createTranscriptionRuntime,TranscriptionRuntime} from '../src/transcription/runtime.js';
import {TranscriptionWorker,type TranscriptionProvider} from '../src/transcription/worker.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');
let db:Db,ownerId:string,gatewayId:string,simId:string;

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  ownerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('runtime-owner@example.test','unused')RETURNING id`)).rows[0].id;
  gatewayId=(await db.query(`INSERT INTO gateways(name)VALUES('runtime-gateway')RETURNING id`)).rows[0].id;
  simId=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label)VALUES($1,0,$2,'runtime-sim')RETURNING id`,[gatewayId,ownerId])).rows[0].id;
});
after(async()=>{await db.end();});

async function endedCall(endedAt:string,status='ready'){
  return (await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at,recording_status,media_node_id,media_epoch)
    VALUES($1,$2,$3,'incoming','ended',1,'normal',$4,$5,'relay-secondary',7) RETURNING id`,[gatewayId,simId,ownerId,endedAt,status])).rows[0].id as string;
}
function recording(callId:string):{manifest:RecordingManifest;source:RecordingSource}{
  const remote=Buffer.from('OggSremote'.padEnd(256,'.')),caller=Buffer.from('OggScaller'.padEnd(256,'.')),timeline=Buffer.from('{}\n');
  const artifact=(name:string,value:Buffer)=>({name,bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')});
  const manifest:RecordingManifest={version:1,callId,nodeId:'relay-secondary',mediaEpoch:7,finalizedAt:'2026-09-09T02:00:00.000Z',complete:true,artifacts:[artifact('remote_original.ogg',remote),artifact('caller_original.ogg',caller),artifact('timeline.jsonl',timeline)]};
  const values={remote_original:remote,caller_original:caller};
  return {manifest,source:{
    async manifest(requested){assert.equal(requested,callId);return manifest;},
    async openTrack(requested,track:RecordingTrack){assert.equal(requested,callId);const value=values[track];return{stream:Readable.from(value),size:value.length,sha256:createHash('sha256').update(value).digest('hex'),complete:true,start:0,end:value.length-1,partial:false};},
  }};
}

test('disabled runtime performs no database, queue, provider, or recording IO',async()=>{
  let io=0;
  const inaccessibleDb={connect:async()=>{io++;throw new Error('unexpected DB IO');}} as unknown as Pool;
  const runtime=new TranscriptionRuntime({enabled:false,db:inaccessibleDb,
    worker:{enqueueCall:async()=>{io++;},tickOnce:async()=>{io++;return'idle';}},resolveSource:()=>{io++;throw new Error('unexpected recording IO');},enabledAt:new Date()});
  assert.equal(await runtime.tickOnce(),'disabled');runtime.start();await new Promise(resolve=>setTimeout(resolve,300));await runtime.stop();assert.equal(io,0);
  const configured=createTranscriptionRuntime(inaccessibleDb,loadConfig({DATABASE_URL:databaseUrl,COOKIE_SECRET:'disabled-runtime-cookie-secret-32-bytes',TRANSCRIPTION_ENABLED:'false'}));
  configured.start();assert.equal(await configured.tickOnce(),'disabled');await configured.stop();assert.equal(io,0);
});

test('report classifier configuration fails closed when partial and stays inert while disabled',async()=>{
  let io=0;
  const inaccessibleDb={connect:async()=>{io++;throw new Error('unexpected DB IO');}} as unknown as Pool;
  const base={DATABASE_URL:databaseUrl,COOKIE_SECRET:'report-config-test-cookie-secret-32-bytes',TRANSCRIPTION_API_KEY:'synthetic-key',TRANSCRIPTION_ENABLED_AT:'2026-09-09T00:00:00Z'};
  const partial={...base,REPORT_AI_BASE_URL:'https://example.test/v1'};
  const disabled=createTranscriptionRuntime(inaccessibleDb,loadConfig({...partial,TRANSCRIPTION_ENABLED:'false'}));
  assert.equal(await disabled.tickOnce(),'disabled');
  assert.throws(()=>createTranscriptionRuntime(inaccessibleDb,loadConfig({...partial,TRANSCRIPTION_ENABLED:'true'})),/requires REPORT_AI/);
  assert.throws(()=>createTranscriptionRuntime(inaccessibleDb,loadConfig({...partial,TRANSCRIPTION_ENABLED:'true',REPORT_AI_API_KEY:'synthetic-key',REPORT_AI_MODEL:'synthetic-model',REPORT_AI_BASE_URL:'http://example.test/v1'})),/HTTPS/);
  assert.equal(io,0);
});

test('S23 决策 5: TRANSCRIPTION_BASE_URL selects the OpenAI-compatible provider and fails closed',async()=>{
  let io=0;
  const inaccessibleDb={connect:async()=>{io++;throw new Error('unexpected DB IO');}} as unknown as Pool;
  const base={DATABASE_URL:databaseUrl,COOKIE_SECRET:'transcription-base-url-cookie-secret-32-bytes',
    TRANSCRIPTION_ENABLED:'true',TRANSCRIPTION_ENABLED_AT:'2026-09-09T00:00:00Z',TRANSCRIPTION_API_KEY:'synthetic-key'};
  // An empty value is the same as an absent one, so removing the key from app.env is a complete rollback.
  assert.ok(createTranscriptionRuntime(inaccessibleDb,loadConfig({...base,TRANSCRIPTION_BASE_URL:''})) instanceof TranscriptionRuntime);
  assert.throws(()=>createTranscriptionRuntime(inaccessibleDb,loadConfig({...base,TRANSCRIPTION_BASE_URL:'https://transcribe.example.test/v1'})),/requires TRANSCRIPTION_MODEL/);
  assert.throws(()=>createTranscriptionRuntime(inaccessibleDb,loadConfig({...base,TRANSCRIPTION_BASE_URL:'http://transcribe.example.test/v1',TRANSCRIPTION_MODEL:'compatible-test'})),/HTTPS/);
  assert.ok(createTranscriptionRuntime(inaccessibleDb,loadConfig({...base,TRANSCRIPTION_BASE_URL:'https://transcribe.example.test/v1',TRANSCRIPTION_MODEL:'compatible-test'})) instanceof TranscriptionRuntime);
  // The optional pool fallback model is accepted and, like the base URL, empty means absent.
  const fallback={...base,TRANSCRIPTION_BASE_URL:'https://transcribe.example.test/v1',TRANSCRIPTION_MODEL:'compatible-test'};
  assert.ok(createTranscriptionRuntime(inaccessibleDb,loadConfig({...fallback,TRANSCRIPTION_FALLBACK_MODEL:'fallback-test'})) instanceof TranscriptionRuntime);
  assert.ok(createTranscriptionRuntime(inaccessibleDb,loadConfig({...fallback,TRANSCRIPTION_FALLBACK_MODEL:''})) instanceof TranscriptionRuntime);
  assert.throws(()=>createTranscriptionRuntime(inaccessibleDb,loadConfig({...fallback,TRANSCRIPTION_FALLBACK_MODEL:'x'.repeat(121)})),/TRANSCRIPTION_FALLBACK_MODEL|too big|at most/);
  assert.equal(io,0);
});

test('scanner honors activation watermark and frozen node, persists once, and recovers queued work after restart',async()=>{
  const watermark=new Date('2026-09-09T01:00:00.000Z');
  const old=await endedCall('2026-09-09T00:59:59.000Z');
  const incomplete=await endedCall('2026-09-09T01:00:01.000Z');const incompleteRecording=recording(incomplete);incompleteRecording.manifest.complete=false;
  const unavailable=await endedCall('2026-09-09T01:00:02.000Z');
  const eligible=await endedCall('2026-09-09T01:00:03.000Z','pending');
  const unready=await endedCall('2026-09-09T01:00:04.000Z','none');
  const recordings=new Map([[eligible,recording(eligible)],[incomplete,incompleteRecording]]);const resolved:Array<{nodeId:string;mediaEpoch:number}>=[];
  const sharedSource:RecordingSource={
    async manifest(callId){return recordings.get(callId)?.manifest??null;},
    async openTrack(callId,track){const entry=recordings.get(callId);if(!entry)throw new Error('recording unavailable');return entry.source.openTrack(callId,track);},
  };
  const resolver:RecordingSourceResolver=fixed=>{resolved.push(fixed);return sharedSource;};
  const repository=new PostgresTranscriptJobRepository(db),reader=new RegistryRecordingReader(db,resolver);
  const provider:TranscriptionProvider={async transcribe(bytes,context){assert.equal(context.signal.aborted,false);return{text:`read-${bytes.length}`,provider:'test'};}};
  const worker=new TranscriptionWorker(repository,{enabled:true,reader,provider,maxAttempts:2});
  const runtime=new TranscriptionRuntime({enabled:true,db,worker,resolveSource:resolver,enabledAt:watermark,scanBatch:2});
  const first=await runtime.tickOnce();assert.deepEqual(first,{scanned:2,enqueued:0,worker:'idle'});
  const second=await runtime.tickOnce();assert.deepEqual(second,{scanned:1,enqueued:1,worker:'succeeded'});
  assert.ok(resolved.every(value=>value.nodeId==='relay-secondary'&&value.mediaEpoch===7));
  let rows=(await db.query(`SELECT call_id,state,attempts FROM transcript_jobs ORDER BY created_at`)).rows;
  assert.deepEqual(rows.map(row=>[row.call_id,row.state,Number(row.attempts)]),[[eligible,'succeeded',1]]);
  assert.equal((await db.query('SELECT recording_status FROM call_records WHERE id=$1',[eligible])).rows[0].recording_status,'ready');
  assert.equal((await runtime.tickOnce() as any).enqueued,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM transcript_jobs WHERE call_id IN($1,$2,$3,$4)`,[old,unready,incomplete,unavailable])).rows[0].n,0);

  const recovery=await endedCall('2026-09-09T01:00:03.000Z');const recoveryRecording=recording(recovery);recordings.set(recovery,recoveryRecording);
  await worker.enqueueCall({callId:recovery,snapshotOwnerId:ownerId,manifest:recoveryRecording.manifest});
  const restartedWorker=new TranscriptionWorker(repository,{enabled:true,reader:new RegistryRecordingReader(db,resolver),provider,maxAttempts:2});
  const restarted=new TranscriptionRuntime({enabled:true,db,worker:restartedWorker,resolveSource:resolver,enabledAt:watermark,scanBatch:10});
  assert.equal((await restarted.tickOnce() as any).worker,'succeeded');
  rows=(await db.query(`SELECT state,attempts FROM transcript_jobs WHERE call_id=$1`,[recovery])).rows;assert.deepEqual(rows,[{state:'succeeded',attempts:1}]);
});

test('advisory lease enforces one process-wide worker and stop aborts and awaits the active tick',async()=>{
  let enteredResolve!:()=>void;const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});let ticks=0;
  const blockingWorker={enqueueCall:async()=>undefined,tickOnce:async(signal?:AbortSignal)=>{ticks++;enteredResolve();await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return'retry';}};
  const future=new Date('2099-01-01T00:00:00.000Z'),unused=()=>{throw new Error('unexpected source');};
  const first=new TranscriptionRuntime({enabled:true,db,worker:blockingWorker,resolveSource:unused,enabledAt:future,intervalMs:250});first.start();await entered;
  const second=new TranscriptionRuntime({enabled:true,db,worker:{enqueueCall:async()=>undefined,tickOnce:async()=>{throw new Error('concurrent worker');}},resolveSource:unused,enabledAt:future});
  assert.equal(await second.tickOnce(),'busy');await second.stop();
  await first.stop();assert.equal(ticks,1);await new Promise(resolve=>setTimeout(resolve,300));assert.equal(ticks,1);
});

test('stop is bounded and destroys a database client that arrives after cancellation',async()=>{
  let resolveConnect!:(client:unknown)=>void;const connect=new Promise<unknown>(resolve=>{resolveConnect=resolve;});
  let released:unknown;
  const runtime=new TranscriptionRuntime({enabled:true,db:{connect:()=>connect} as unknown as Pool,
    worker:{enqueueCall:async()=>undefined,tickOnce:async()=> 'idle'},resolveSource:()=>{throw new Error('unexpected source');},
    enabledAt:new Date(),intervalMs:10_000,discoveryTimeoutMs:5_000,stopTimeoutMs:50});
  runtime.start();await new Promise(resolve=>setTimeout(resolve,10));
  const started=Date.now();await runtime.stop();assert.ok(Date.now()-started<250);
  resolveConnect({release:(error?:unknown)=>{released=error;}});await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(released instanceof Error);
});

test('a never-settling advisory lock is destroyed immediately on stop and never scans',async()=>{
  const lock=new Promise<unknown>(()=>undefined);
  let queries=0,released:unknown;
  const client={query:()=>{queries++;return lock;},release:(error?:unknown)=>{released=error;}};
  const runtime=new TranscriptionRuntime({enabled:true,db:{connect:async()=>client} as unknown as Pool,
    worker:{enqueueCall:async()=>undefined,tickOnce:async()=> 'idle'},resolveSource:()=>{throw new Error('unexpected source');},
    enabledAt:new Date(),intervalMs:10_000,discoveryTimeoutMs:5_000,stopTimeoutMs:50});
  runtime.start();while(queries===0)await new Promise(resolve=>setTimeout(resolve,1));await runtime.stop();
  assert.equal(queries,1);assert.ok(released instanceof Error);
});

test('a manifest that completes after stop cannot enqueue work',async()=>{
  let resolveManifest!:(value:RecordingManifest)=>void;const manifest=new Promise<RecordingManifest>(resolve=>{resolveManifest=resolve;});
  let manifestRequested=false,enqueued=0,unlocked=0;
  const callId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const client={
    query:async(sql:string)=>{
      if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};
      if(sql.includes('pg_advisory_unlock')){unlocked++;return{rows:[{unlocked:true}]};}
      return{rowCount:1,rows:[{id:callId,snapshot_owner_id:'owner',media_node_id:'relay-secondary',media_epoch:7,ended_at:new Date()}]};
    },
    release:()=>undefined,
  };
  const runtime=new TranscriptionRuntime({enabled:true,db:{connect:async()=>client} as unknown as Pool,
    worker:{enqueueCall:async()=>{enqueued++;},tickOnce:async()=> 'idle'},
    resolveSource:()=>({manifest:async()=>{manifestRequested=true;return manifest;},openTrack:async()=>{throw new Error('unused');}}),
    enabledAt:new Date(0),intervalMs:10_000,discoveryTimeoutMs:5_000,stopTimeoutMs:50});
  runtime.start();while(!manifestRequested)await new Promise(resolve=>setTimeout(resolve,1));await runtime.stop();
  resolveManifest(recording(callId).manifest);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(enqueued,0);assert.equal(unlocked,1);
});

test('start-stop-start cannot revive the previous scheduler generation',async()=>{
  let releaseFirst!:()=>void;const firstWorker=new Promise<void>(resolve=>{releaseFirst=resolve;});
  let connects=0,ticks=0;
  const client={query:async(sql:string)=>sql.includes('pg_try_advisory_lock')?{rows:[{locked:true}]}:
    sql.includes('pg_advisory_unlock')?{rows:[{unlocked:true}]}:{rowCount:0,rows:[]},release:()=>undefined};
  const runtime=new TranscriptionRuntime({enabled:true,db:{connect:async()=>{connects++;return client;}} as unknown as Pool,
    worker:{enqueueCall:async()=>undefined,tickOnce:async()=>{ticks++;if(ticks===1)await firstWorker;return'idle';}},
    resolveSource:()=>{throw new Error('unexpected source');},enabledAt:new Date(),intervalMs:250,stopTimeoutMs:25});
  runtime.start();while(ticks===0)await new Promise(resolve=>setTimeout(resolve,1));await runtime.stop();runtime.start();
  releaseFirst();await new Promise(resolve=>setTimeout(resolve,620));await runtime.stop();
  assert.ok(ticks>=2);assert.ok(connects<=4,`stale scheduler created extra scans: ${connects}`);
});

test('database pool has bounded connection, query, statement and idle transaction waits',async()=>{
  const pool=createDb(databaseUrl) as Db & {options:Record<string,unknown>};
  assert.equal(pool.options.connectionTimeoutMillis,5_000);
  assert.equal(pool.options.query_timeout,15_000);
  assert.equal(pool.options.statement_timeout,15_000);
  assert.equal(pool.options.idle_in_transaction_session_timeout,15_000);
  await pool.end();
});

function emptyMediaManifest(callId:string):RecordingManifest{
  // Two bare Ogg page headers and a zero-byte timeline: the media node saw no RTP at all.
  const header=Buffer.alloc(95),timeline=Buffer.alloc(0);
  const artifact=(name:string,value:Buffer)=>({name,bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')});
  return {version:1,callId,nodeId:'relay-secondary',mediaEpoch:7,finalizedAt:'2026-09-09T03:00:00.000Z',complete:false,
    artifacts:[artifact('remote_original.ogg',header),artifact('caller_original.ogg',header),artifact('timeline.jsonl',timeline)]};
}
function emptyPixelDescriptor(callId:string){
  // 44 bytes is a WAV header with no samples: the Pixel capture failed its prebuffer.
  return {source:'pixel' as const,version:2 as const,archiveId:randomUUID(),callId,manifestSha256:'a'.repeat(64),
    archiveComplete:true,captureComplete:false,startedAt:'2026-09-09T03:00:00.000Z',endedAt:'2026-09-09T03:00:04.000Z',
    tracks:(['remote_original','caller_original'] as const).map(track=>({track,sourceRole:'original_capture' as const,
      mediaType:'audio/wav' as const,bytes:44,sha256:'b'.repeat(64),captureComplete:false,gapCount:0,droppedFrames:0})),
    timeline:{mediaType:'application/x-ndjson' as const,bytes:32,sha256:'c'.repeat(64)}};
}

test('the enqueue gate chooses the source once: a complete media copy, the AI transcript, or one terminal job',async()=>{
  const watermark=new Date('2026-09-09T03:00:00.000Z');
  const handover=await endedCall('2026-09-09T03:00:01.000Z','pending');
  const terminal=await endedCall('2026-09-09T03:00:02.000Z','pending');
  const aiCall=await endedCall('2026-09-09T03:00:03.000Z','pending');
  const mediaManifests=new Map<string,RecordingManifest>([
    [handover,recording(handover).manifest],[terminal,emptyMediaManifest(terminal)],[aiCall,emptyMediaManifest(aiCall)],
  ]);
  const pixelManifests=new Map<string,ReturnType<typeof emptyPixelDescriptor>>();
  for(const id of [handover,terminal,aiCall])pixelManifests.set(id,emptyPixelDescriptor(id));
  const runId=(await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,
      settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
    VALUES($1,$2,$3,1,7,'ai',1,1,45,now()) RETURNING id`,[aiCall,gatewayId,ownerId])).rows[0].id;
  await db.query(`INSERT INTO ai_run_transcripts(run_id,call_id,role,sequence,text,at)VALUES($1,$2,'ai',0,'您好，这里是 AI 助理',now())`,[runId,aiCall]);
  const enqueued:Array<{callId:string;manifest:any}>=[];
  const runtime=new TranscriptionRuntime({enabled:true,db,scanBatch:10,enabledAt:watermark,
    worker:{enqueueCall:async(input:any)=>{enqueued.push(input);},tickOnce:async()=>'idle'},
    resolveSource:()=>({manifest:async(callId:string)=>mediaManifests.get(callId)??null,openTrack:async()=>{throw new Error('unused');}}) as any,
    pixelSource:{manifest:async(callId:string)=>pixelManifests.get(callId)??null,openTrack:async()=>{throw new Error('unused');}} as any});
  await runtime.tickOnce();
  assert.deepEqual(enqueued.map(item=>[item.callId,item.manifest.version,item.manifest.source??'media']),
    [[handover,1,'media'],[aiCall,2,'pixel']]);
  const job=(await db.query(`SELECT state,error_code,error_message,result FROM transcript_jobs WHERE call_id=$1`,[terminal])).rows[0];
  assert.deepEqual([job.state,job.error_code,job.error_message,job.result],['failed','RECORDING_EMPTY','录音为空或采集失败',null]);
  // The terminal row is what takes the call out of the scan set for good.
  enqueued.length=0;
  await runtime.tickOnce();
  assert.equal(enqueued.some(item=>item.callId===terminal),false);
  assert.equal((await db.query(`SELECT count(*)::int n FROM transcript_jobs WHERE call_id=$1`,[terminal])).rows[0].n,1);
});

test('a Pixel capture that is still uploading or still holds audio is never written off as empty',async()=>{
  const watermark=new Date('2026-09-09T04:00:00.000Z');
  const uploading=await endedCall('2026-09-09T04:00:01.000Z','pending');
  const partial=await endedCall('2026-09-09T04:00:02.000Z','pending');
  const finalizing=await endedCall('2026-09-09T04:00:03.000Z','pending');
  const pixelManifests=new Map<string,any>([
    [uploading,{...emptyPixelDescriptor(uploading),archiveComplete:false}],
    [partial,{...emptyPixelDescriptor(partial),tracks:emptyPixelDescriptor(partial).tracks.map(track=>({...track,bytes:64_000}))}],
    [finalizing,emptyPixelDescriptor(finalizing)],
  ]);
  const finalizingMedia={...emptyMediaManifest(finalizing),artifacts:emptyMediaManifest(finalizing).artifacts.map(artifact=>
    artifact.name==='timeline.jsonl'?{...artifact,bytes:12}:{...artifact,bytes:48_000})};
  const enqueued:Array<{callId:string;manifest:any}>=[];
  const runtime=new TranscriptionRuntime({enabled:true,db,scanBatch:10,enabledAt:watermark,
    worker:{enqueueCall:async(input:any)=>{enqueued.push(input);},tickOnce:async()=>'idle'},
    resolveSource:()=>({manifest:async(callId:string)=>callId===finalizing?finalizingMedia:null,openTrack:async()=>{throw new Error('unused');}}) as any,
    pixelSource:{manifest:async(callId:string)=>pixelManifests.get(callId)??null,openTrack:async()=>{throw new Error('unused');}} as any});
  await runtime.tickOnce();
  // Only the partial capture has audio worth transcribing; the other two are retried next scan.
  assert.deepEqual(enqueued.map(item=>item.callId),[partial]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM transcript_jobs WHERE call_id IN($1,$2)`,[uploading,finalizing])).rows[0].n,0);
});
