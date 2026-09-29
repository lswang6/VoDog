/** Explicit external-provider probe using generated speech and an isolated disposable local DB. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {hashPassword} from '../src/security.js';
import {createTranscriptionRuntime} from '../src/transcription/runtime.js';

if(process.env.CC_SYNTHETIC_TRANSCRIPTION_PROBE!=='true')throw new Error('Explicit synthetic provider probe flag is required');
const dbName=`vodog_synthetic_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:'postgresql:///postgres',max:1});
const databaseUrl=`postgresql:///${dbName}`; // Never use .env DATABASE_URL.
let db:pg.Pool|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
let runtime:ReturnType<typeof createTranscriptionRuntime>|undefined;
const fixtureDir=process.env.TRANSCRIPTION_PROBE_FIXTURE_DIR || './fixtures';
const outputDir=process.env.TRANSCRIPTION_PROBE_OUTPUT_DIR || './probe-output';
const dir=await mkdtemp(join(tmpdir(),'vodog-synthetic-'));
const evidence:Record<string,unknown>={testedAt:new Date().toISOString(),syntheticOnly:true,status:'running'};
try{
 await admin.query(`CREATE DATABASE ${dbName}`);
 db=new pg.Pool({connectionString:databaseUrl,max:5});
 for(const file of ['schema.sql','transcription/schema.sql'])await db.query(await readFile(new URL('../src/'+file,import.meta.url),'utf8'));
 const password=randomUUID();
 const owner=(await db.query(`INSERT INTO users(email,password_hash) VALUES('synthetic-owner@example.test',$1) RETURNING id`,[await hashPassword(password)])).rows[0].id;
 const gateway=(await db.query(`INSERT INTO gateways(name) VALUES('Synthetic probe - no phone') RETURNING id`)).rows[0].id;
 const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label) VALUES($1,0,$2,'Synthetic SIM') RETURNING id`,[gateway,owner])).rows[0].id;
 const watermark=new Date(Date.now()-60_000).toISOString();
 const callId=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,started_at,ended_at,recording_status,media_node_id,media_epoch)
 VALUES($1,$2,$3,'incoming','ended',1,'normal',now()-interval '10 seconds',now(),'pending','relay-primary',1) RETURNING id`,[gateway,sim,owner])).rows[0].id;
 const callDir=join(dir,callId);await mkdir(callDir,{mode:0o700});
 const audio=await readFile(join(fixtureDir,'synthetic.ogg'));
 const callerAudio=await readFile(join(fixtureDir,'synthetic-caller.ogg'));
 assert.notDeepEqual(audio,callerAudio,'Probe tracks must be distinct');
 const files=[{name:'remote_original.ogg',data:audio},{name:'caller_original.ogg',data:callerAudio},{name:'timeline.jsonl',data:Buffer.from('{}\n')}];
 for(const file of files)await writeFile(join(callDir,file.name),file.data,{mode:0o600});
 const manifest={version:1,callId,nodeId:'relay-primary',mediaEpoch:1,complete:true,finalizedAt:new Date().toISOString(),artifacts:files.map(file=>({name:file.name,bytes:file.data.length,sha256:createHash('sha256').update(file.data).digest('hex')}))};
 evidence.inputArtifacts=manifest.artifacts;
 await writeFile(join(callDir,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
 const config=loadConfig({DATABASE_URL:databaseUrl,COOKIE_SECRET:randomUUID(),RECORDING_ROOT:dir,
  TRANSCRIPTION_ENABLED:'true',TRANSCRIPTION_ENABLED_AT:watermark,TRANSCRIPTION_API_KEY:process.env.TRANSCRIPTION_API_KEY,TRANSCRIPTION_MODEL:process.env.TRANSCRIPTION_MODEL,
  TRANSCRIPTION_BASE_URL:process.env.TRANSCRIPTION_BASE_URL,TRANSCRIPTION_FALLBACK_MODEL:process.env.TRANSCRIPTION_FALLBACK_MODEL,
  REPORT_AI_BASE_URL:process.env.REPORT_AI_BASE_URL,REPORT_AI_API_KEY:process.env.REPORT_AI_API_KEY,REPORT_AI_MODEL:process.env.REPORT_AI_MODEL});
 runtime=createTranscriptionRuntime(db,config);
 const tick=await runtime.tickOnce();evidence.tick=tick;
 assert.equal((await db.query('SELECT recording_status FROM call_records WHERE id=$1',[callId])).rows[0].recording_status,'ready');
 const job=(await db.query('SELECT state,error_code,result FROM transcript_jobs WHERE call_id=$1',[callId])).rows[0];
 assert.equal(job?.state,'succeeded',job?.error_code??'Job did not succeed');
 evidence.enrichment=job.result.enrichment; evidence.providers=job.result.providers;
 assert.match(job.result.text,/回电/);assert.match(job.result.text,/安装/);
 assert.match(job.result.text,/remote:.*网关测试/);
 assert.match(job.result.text,/vodog_user:.*好的/);
 assert.ok(job.result.summary?.length,'Missing classification summary');
 assert.ok(job.result.actionItems?.length,'Missing action items');
 assert.equal(job.result.enrichment?.provider,'openai-compatible');
 assert.equal(job.result.enrichment?.error,null);
 app=await buildApp(db,config);
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'synthetic-owner@example.test',password,platform:'android'}});
 assert.equal(login.statusCode,200);
 const token=login.json().token;
 const report=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=7d&timeZone=Asia%2FTaipei',headers:{authorization:'Bearer '+token}});
 assert.equal(report.statusCode,200);assert.equal(report.json().items.length,1);
 const transcript=await app.inject({method:'GET',url:`/api/v1/calls/${callId}/transcript`,headers:{authorization:'Bearer '+token}});
 assert.equal(transcript.statusCode,200);assert.equal(transcript.json().transcript.status,'succeeded');
 Object.assign(evidence,{status:'passed',transcript:job.result.text,summary:job.result.summary,actionItems:job.result.actionItems,classification:job.result.advertisingClassification,providers:job.result.providers,enrichment:job.result.enrichment,reportItems:report.json().items.length});
}catch(error){Object.assign(evidence,{status:'failed',error:error instanceof Error?error.message:'unknown'});process.exitCode=1;}
finally{
 const cleanupErrors:string[]=[];
 const clean=async(name:string,operation:()=>Promise<unknown>)=>{try{await operation();}catch{cleanupErrors.push(name);process.exitCode=1;}};
 await clean('runtime',async()=>runtime?.stop());
 await clean('app',async()=>app?.close());
 await clean('pool',async()=>db?.end());
 await clean('database',()=>admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
 await clean('admin-pool',()=>admin.end());
 await clean('temporary-audio',()=>rm(dir,{recursive:true,force:true}));
 evidence.cleanupErrors=cleanupErrors;
 if(cleanupErrors.length)evidence.status='cleanup_failed';
 const evidenceText=JSON.stringify(evidence,null,2);
 const stamp=String(evidence.testedAt).replace(/[^0-9TZ]/g,'');
 await mkdir(outputDir,{recursive:true,mode:0o700});
 await writeFile(join(outputDir,`transcription-e2e-synthetic-${stamp}.json`),evidenceText,{mode:0o600});

 console.log(JSON.stringify(evidence));
}
