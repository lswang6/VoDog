import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import test from 'node:test';
import {freezeRecordingManifest, TranscriptionWorker, type TrackReadRequest} from './worker.js';
import {RegistryRecordingReader, type PixelTranscriptSource} from './reader.js';
import {createGeminiTranscriptionProvider} from './provider.js';
import {maxTranscriptionRetryDelayMs,TranscriptionProviderHttpError} from './provider-error.js';
import {validTranscriptionAudio} from './audio-format.js';
import type {PixelRecordingDescriptor} from '../recording-archive.js';

const callId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function wav(){
  // S78: 200 ms of tone — a single nonzero sample is now (correctly) a voiceless track.
  const b=Buffer.alloc(44+3200*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let o=44;o<b.length;o+=2)b.writeInt16LE(o%4?-8000:8000,o);return b;
}
const bytes=wav();
export function descriptor(version:2|3=3):PixelRecordingDescriptor {
  return {source:'pixel',version,archiveId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',callId,manifestSha256:'a'.repeat(64),
    archiveComplete:true,captureComplete:false,startedAt:'2026-09-10T00:00:00.000Z',endedAt:'2026-09-10T00:00:10.000Z',
    tracks:['remote_original','caller_original'].map((track,i)=>({track:track as 'remote_original'|'caller_original',sourceRole:'original_capture',mediaType:'audio/wav',bytes:bytes.length,sha256:sha(bytes),captureComplete:i===0,gapCount:i,droppedFrames:i})),
    ...(version===3?{derivedTracks:[{track:'caller_playout' as const,sourceRole:'derived_playout' as const,mediaType:'audio/wav' as const,bytes:bytes.length,sha256:sha(bytes),playoutComplete:true,gapCount:0,recoveryFrames:1}]}:{}),
    timeline:{mediaType:'application/x-ndjson',bytes:100,sha256:'b'.repeat(64)}};
}
function request(m=descriptor()):TrackReadRequest {
  return {callId,snapshotOwnerId:owner,source:'pixel',archiveId:m.archiveId,manifestFingerprint:freezeRecordingManifest(m,callId).fingerprint,
    track:'remote_original',name:'remote_original.wav',mediaType:'audio/wav',formatVersion:m.version,
    expectedBytes:bytes.length,expectedSha256:sha(bytes),signal:new AbortController().signal};
}
function source(m=descriptor(),body=bytes):PixelTranscriptSource {
  return {manifest:async()=>m,openTrack:async()=>({stream:Readable.from([body]),size:body.length,sha256:sha(body),complete:false,start:0,end:body.length-1,partial:false})};
}
const db={query:async()=>({rowCount:1,rows:[{media_node_id:'relay-secondary',media_epoch:9}]})};
const unused=()=>{throw new Error('must not switch frozen Pixel job to media node');};

test('v2/v3 fingerprints retain archive identity, original gaps and unselected derived metadata',()=>{
  for(const version of [2,3] as const){
    const m=descriptor(version),f=freezeRecordingManifest(m,callId);
    assert.deepEqual(f.tracks.map(t=>[t.track,t.name,t.formatVersion]),[['remote_original','remote_original.wav',version],['caller_original','caller_original.wav',version]]);
    assert.equal(f.fingerprint,freezeRecordingManifest(JSON.parse(JSON.stringify(m)),callId).fingerprint);
    const reordered=Object.fromEntries(Object.entries(m).reverse());assert.equal(f.fingerprint,freezeRecordingManifest(reordered,callId).fingerprint);
    const changed=structuredClone(m);changed.archiveId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';assert.notEqual(f.fingerprint,freezeRecordingManifest(changed,callId).fingerprint);
    if(version===3){const derived=structuredClone(m);derived.derivedTracks![0]!.recoveryFrames++;assert.notEqual(f.fingerprint,freezeRecordingManifest(derived,callId).fingerprint);}
    assert.throws(()=>freezeRecordingManifest(m,owner),/identity/);
  }
});

test('Pixel reader authorizes frozen owner before source IO and never falls back to Ogg',async()=>{
  let reads=0;const archived=source();const counted={...archived,manifest:async()=>{reads++;return descriptor();}};
  const denied=new RegistryRecordingReader({query:async()=>({rowCount:0,rows:[]})} as never,unused,counted);
  await assert.rejects(denied.readTrack(request()),(e:any)=>e.code==='CALL_OWNER_MISMATCH');assert.equal(reads,0);
  assert.deepEqual(await new RegistryRecordingReader(db as never,unused,counted).readTrack(request()),bytes);
  await assert.rejects(new RegistryRecordingReader(db as never,unused).readTrack(request()),(e:any)=>e.code==='RECORDING_UNAVAILABLE');
});

test('Pixel reader rejects changed archive, gaps, swapped bytes, and derived requests',async()=>{
  const m=descriptor();const changed=structuredClone(m);changed.tracks[1]!.gapCount++;
  await assert.rejects(new RegistryRecordingReader(db as never,unused,source(changed)).readTrack(request(m)),(e:any)=>e.code==='RECORDING_CONTRACT_MISMATCH');
  const other=structuredClone(m);other.archiveId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await assert.rejects(new RegistryRecordingReader(db as never,unused,source(other)).readTrack(request(m)),(e:any)=>e.code==='RECORDING_CONTRACT_MISMATCH');
  const bad=Buffer.from(bytes);bad[44]=bad[44]!^1;
  await assert.rejects(new RegistryRecordingReader(db as never,unused,source(m,bad)).readTrack(request(m)),(e:any)=>e.code==='RECORDING_CONTRACT_MISMATCH');
  await assert.rejects(new RegistryRecordingReader(db as never,unused,source(m)).readTrack({...request(m),track:'caller_playout',name:'caller_playout.wav'}),(e:any)=>e.code==='RECORDING_CONTRACT_MISMATCH');
});

test('WAV provider sends real MIME and rejects wrong PCM, lengths and labels before network',async()=>{
  let calls=0;const provider=createGeminiTranscriptionProvider({apiKey:'synthetic-key',fetcher:async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.contents[0].parts[0].inline_data.mime_type,'audio/wav');
    return Response.json({candidates:[{content:{parts:[{audioTranscription:{speakerLabel:'spk_1',words:[
      {word:'测试转录',startOffset:'0.100s',endOffset:'0.500s'},
    ]}}]},finishReason:'STOP'}]});}});
  assert.equal((await provider.transcribe(bytes,request())).text,'测试转录');
  const stereo=Buffer.from(bytes);stereo.writeUInt16LE(2,22);assert.equal(validTranscriptionAudio(stereo,'audio/wav',3),false);
  await assert.rejects(provider.transcribe(stereo,request()),/PCM WAV/);
  await assert.rejects(provider.transcribe(bytes.subarray(0,bytes.length-2),request()),/PCM WAV/);
  await assert.rejects(provider.transcribe(bytes,{...request(),mediaType:'audio/ogg',formatVersion:1}),/PCM WAV/);
  assert.equal(calls,1);
});

test('worker persists source and original incompleteness; derived track is not duplicated as a speaker',async()=>{
  const manifest=descriptor();let result:any;let done=false;const requests:TrackReadRequest[]=[];
  const repository={claim:async()=>done?null:{id:'job',callId,snapshotOwnerId:owner,manifest,manifestFingerprint:freezeRecordingManifest(manifest,callId).fingerprint,leaseToken:'lease',attempts:1},
    renewLease:async()=>true,complete:async(input:any)=>{result=input.result;done=true;return true;},fail:async(input:any)=>{throw new Error(JSON.stringify(input));}};
  const worker=new TranscriptionWorker(repository as never,{enabled:true,reader:{readTrack:async r=>{requests.push(r);return bytes;}},provider:{transcribe:async()=>({text:'原声转录'})}});
  assert.equal(await worker.tickOnce(),'succeeded');assert.equal(requests.length,2);assert.ok(requests.every(r=>r.source==='pixel'&&r.archiveId===manifest.archiveId));
  assert.equal(result.recording.manifestVersion,3);assert.equal(result.recording.source,'pixel');assert.equal(result.recording.complete,false);
  assert.equal(result.recording.archiveComplete,true);assert.equal(result.recording.selectionPolicy,'original_capture_only');
  assert.equal(result.recording.capture[1].gapCount,1);assert.equal(result.segments.length,2);assert.equal(await worker.tickOnce(),'idle');
});

const rateLimitClock=new Date('2026-09-10T00:00:00.000Z');
async function rateLimitedTick(input:{retryAfterMs?:number;attempts?:number;createdAt?:Date;automaticRetry?:boolean;status?:number}){
  const manifest=descriptor();let failure:any;
  const repository={claim:async()=>({id:'job',callId,snapshotOwnerId:owner,manifest,manifestFingerprint:freezeRecordingManifest(manifest,callId).fingerprint,
      leaseToken:'lease',attempts:input.attempts??1,createdAt:input.createdAt??rateLimitClock}),
    renewLease:async()=>true,complete:async()=>{throw new Error('unexpected completion');},fail:async(value:any)=>{failure=value;return true;}};
  const worker=new TranscriptionWorker(repository as never,{enabled:true,clock:()=>rateLimitClock,random:()=>0.5,reader:{readTrack:async()=>bytes},
    provider:{transcribe:async()=>{throw new TranscriptionProviderHttpError(input.status??429,input.retryAfterMs,input.automaticRetry??true);}}});
  const outcome=await worker.tickOnce();
  return {outcome,failure};
}

test('worker honors bounded 429 Retry-After with additive jitter and a conservative fallback',async()=>{
  const headerDelay=await rateLimitedTick({retryAfterMs:90_000});
  assert.equal(headerDelay.outcome,'retry');
  assert.equal(headerDelay.failure.errorCode,'PROVIDER_RATE_LIMITED');
  assert.equal(headerDelay.failure.errorMessage,'Transcription provider HTTP 429');
  assert.equal(headerDelay.failure.nextAttemptAt.toISOString(),'2026-09-10T00:01:39.000Z');
  const fallback=await rateLimitedTick({});
  assert.equal(fallback.failure.nextAttemptAt.toISOString(),'2026-09-10T00:00:33.000Z');
});

test('S23 决策 6: a 429 is deferred without spending an attempt until the two hour window closes',async()=>{
  // At the four attempt ceiling a 429 used to end the job. Quota is the provider's state, so the job
  // stays queued instead, and the attempt is handed back so the ceiling never creeps up on 429s alone.
  const ceiling=await rateLimitedTick({retryAfterMs:90_000,attempts:4,createdAt:new Date('2026-09-09T22:30:00.000Z')});
  assert.equal(ceiling.outcome,'retry');
  assert.equal(ceiling.failure.terminal,false);
  assert.equal(ceiling.failure.countAttempt,false);
  assert.ok(ceiling.failure.nextAttemptAt>rateLimitClock&&ceiling.failure.nextAttemptAt.getTime()-rateLimitClock.getTime()<=maxTranscriptionRetryDelayMs);
  // Because the attempt is handed back, a job deferred all window long still schedules on Retry-After.
  const late=await rateLimitedTick({retryAfterMs:90_000,createdAt:new Date('2026-09-09T22:06:00.000Z')});
  assert.equal(late.outcome,'retry');
  assert.equal(late.failure.nextAttemptAt.toISOString(),'2026-09-10T00:01:39.000Z');

  // A server that sends no Retry-After must not be re-asked every 33 s for two hours: the wait grows
  // with the time already deferred and stops at the shared 15 minute ceiling.
  const headerless=await rateLimitedTick({createdAt:new Date('2026-09-09T23:30:00.000Z')});
  assert.equal(headerless.outcome,'retry');
  assert.equal(headerless.failure.nextAttemptAt.getTime()-rateLimitClock.getTime(),maxTranscriptionRetryDelayMs);

  const expired=await rateLimitedTick({retryAfterMs:90_000,createdAt:new Date('2026-09-09T21:59:59.000Z')});
  assert.equal(expired.outcome,'failed');
  assert.equal(expired.failure.terminal,true);
  assert.equal(expired.failure.nextAttemptAt,null);
  assert.equal(expired.failure.errorCode,'PROVIDER_RATE_LIMITED');

  // Every other retryable failure still spends its attempt and still stops at the ceiling.
  const serverError=await rateLimitedTick({status:503,attempts:4});
  assert.equal(serverError.outcome,'failed');
  assert.equal(serverError.failure.terminal,true);
  assert.equal(serverError.failure.countAttempt,true);
  assert.equal((await rateLimitedTick({status:503,attempts:1})).outcome,'retry');
});

test('worker does not retry a 429 whose Retry-After exceeds the automatic window',async()=>{
  const failure=await rateLimitedTick({automaticRetry:false,createdAt:rateLimitClock});
  assert.equal(failure.outcome,'failed');
  assert.equal(failure.failure.terminal,true);assert.equal(failure.failure.nextAttemptAt,null);
  assert.equal(failure.failure.errorCode,'PROVIDER_RATE_LIMITED_DEFERRED');
  assert.equal(failure.failure.countAttempt,true);
});

test('verified Pixel discovery waits for upload, then persists one source job across restart',async(t)=>{
  const {default:pg}=await import('pg');const {readFile}=await import('node:fs/promises');
  const {PostgresTranscriptJobRepository}=await import('./repository.js');const {TranscriptionRuntime}=await import('./runtime.js');
  const admin=new pg.Pool({connectionString:'postgresql:///postgres',max:1});
  const name=`vodog_pixel_transcript_${process.pid}_${Date.now()}`;let localDb:InstanceType<typeof pg.Pool>|undefined;
  t.after(async()=>{await localDb?.end();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();});
  await admin.query(`CREATE DATABASE ${name}`);localDb=new pg.Pool({connectionString:`postgresql:///${name}`});
  await localDb.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  await localDb.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const user=(await localDb.query("INSERT INTO users(email,password_hash)VALUES('pixel-transcript@example.test','test')RETURNING id")).rows[0].id;
  const gateway=(await localDb.query("INSERT INTO gateways(name)VALUES('pixel-transcript')RETURNING id")).rows[0].id;
  const sim=(await localDb.query("INSERT INTO sims(gateway_id,slot_index,owner_user_id,label)VALUES($1,0,$2,'SIM')RETURNING id",[gateway,user])).rows[0].id;
  await localDb.query("INSERT INTO call_records(id,gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at,recording_status,media_node_id,media_epoch)VALUES($1,$2,$3,$4,'incoming','ended',1,'normal','2026-09-10T00:00:10Z','pending','relay-secondary',9)",[callId,gateway,sim,user]);
  let uploaded=false,mediaReads=0,transcribes=0;
  const archive:PixelTranscriptSource={...source(),manifest:async()=>uploaded?descriptor():null};
  const resolver=()=>{mediaReads++;throw new Error('must wait for verified Pixel archive');};
  const repository=new PostgresTranscriptJobRepository(localDb);
  const worker=new TranscriptionWorker(repository,{enabled:true,reader:new RegistryRecordingReader(localDb,resolver,archive),provider:{transcribe:async()=>{transcribes++;return{text:'真实形状PCM的隔离转录'};}}});
  const options={enabled:true,db:localDb,worker,resolveSource:resolver,pixelSource:archive,enabledAt:new Date('2026-09-10T00:00:00Z'),scanBatch:10};
  const runtime=new TranscriptionRuntime(options);
  assert.deepEqual(await runtime.tickOnce(),{scanned:1,enqueued:0,worker:'idle'});assert.equal(mediaReads,0);assert.equal(transcribes,0);
  uploaded=true;assert.deepEqual(await runtime.tickOnce(),{scanned:1,enqueued:1,worker:'succeeded'});
  assert.equal(transcribes,2);assert.equal(mediaReads,0);
  const restart=new TranscriptionRuntime(options);assert.equal((await restart.tickOnce() as any).enqueued,0);
  const rows=(await localDb.query('SELECT state,result FROM transcript_jobs')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].state,'succeeded');assert.equal(rows[0].result.recording.source,'pixel');
  assert.equal(rows[0].result.recording.complete,false);assert.equal(rows[0].result.recording.manifestVersion,3);
  const duplicate=await worker.enqueueCall({callId,snapshotOwnerId:user,manifest:descriptor()});assert.equal(duplicate.state,'succeeded');
  await runtime.stop();await restart.stop();
});
