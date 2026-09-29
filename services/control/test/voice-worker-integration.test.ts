import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import {createDb} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
import {VoiceControlClient} from '../../voice/control-client.mjs';
import {VoiceWorker} from '../../voice/worker.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const until=async(predicate:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('integration condition was not reached');};
class Agent extends EventEmitter{async start(){return;}stop(){this.emit('stopped');}}
class Peer extends EventEmitter{close(){this.emit('closed');}}
class Bridge extends EventEmitter{history:boolean[]=[];start(){}setActive(value:boolean){this.history.push(value);}close(){}stats(){return{history:this.history};}}

test('real HTTP Control gates a VoiceWorker on device ACTIVE and terminal state',async()=>{
 const db=createDb(databaseUrl);let app:any;
 try{
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const user=(await db.query(`INSERT INTO users(email,password_hash)VALUES('voice-http@example.test',$1)RETURNING id`,[await hashPassword('correct horse battery staple')])).rows[0];
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('voice-http-gateway',true,true,true,true,now())RETURNING id,device_epoch`)).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'voice-http-sim',true,$3)RETURNING id,version`,[gateway.id,user.id,tokenHash('voice-http-sim-fingerprint')])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id,mode,timeout_seconds)VALUES($1,'ai',45)`,[sim.id]);
  const deviceToken='voice-http-device-token-at-least-32-characters';await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'voice-http')`,[gateway.id,tokenHash(deviceToken)]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),1,0,false,'[]',now())`,[gateway.id,gateway.device_epoch]);
  const internalToken='voice-http-internal-token-at-least-32-chars';
  app=await buildApp(db,{DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'voice-http-cookie-secret-at-least-32-chars',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:internalToken,AI_MEDIA_NODE_ID:'relay-primary',MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'voice-http-media-secret-at-least-32-chars',TURN_SECRET:'voice-http-turn-secret-at-least-32-chars',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,WEB_CALL_LIVENESS_ENABLED:false,FCM_ENABLED:false});
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Fastify did not bind');
  const instanceId='10000000-0000-4000-8000-000000000001',bootId='10000000-0000-4000-8000-000000000002';// S24 决策 3: an explicitly empty `providers` means "this worker can instantiate nothing", so a real
// worker that expects to answer must announce what it has. The default xAI owner only gets a run when
// some live heartbeat advertises xAI.
const control=new VoiceControlClient({baseUrl:`http://127.0.0.1:${address.port}`,token:internalToken,instanceId,bootId,providers:['xai']});await control.heartbeat();
  const observedAt=new Date().toISOString(),deviceCallId='voice-http-device-call';const incoming=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:{authorization:`Bearer ${deviceToken}`},payload:{eventId:crypto.randomUUID(),generation:Number(gateway.device_epoch),deviceCallId,simId:sim.id,remoteNumber:'+15550123',observedAt}});assert.equal(incoming.statusCode,201,incoming.body);const callId=incoming.json().call.id;
  await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:{authorization:`Bearer ${deviceToken}`},payload:{snapshotId:crypto.randomUUID(),snapshotSequence:2,generation:Number(gateway.device_epoch),reportedSequence:0,localBusy:true,confirmedAbsentCallIds:[],calls:[{callId,deviceCallId,simId:sim.id,direction:'incoming',state:'ringing'}],observedAt:new Date().toISOString()}});
  const run=await control.claim();assert.ok(run);
  const bridge=new Bridge();const worker=new VoiceWorker({control,wrtc:{},createAgent:()=>new Agent(),connectPeer:async()=>new Peer(),createBridge:()=>bridge,renewMs:100,pollMs:10,idleMs:10});const execution=worker.execute(run);
  await until(async()=>Boolean((await db.query(`SELECT answer_command_id FROM ai_call_runs WHERE id=$1 AND answer_command_id IS NOT NULL`,[run.id])).rowCount));
  await until(()=>bridge.history.length>0);assert.equal(bridge.history.includes(true),false);
  const command=(await db.query(`SELECT answer_command_id FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0].answer_command_id;
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command}/ack`,headers:{authorization:`Bearer ${deviceToken}`},payload:{generation:Number(gateway.device_epoch),status:'acked'}});assert.equal(ack.statusCode,200,ack.body);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(bridge.history.includes(true),false);
  const active=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/events`,headers:{authorization:`Bearer ${deviceToken}`},payload:{eventId:crypto.randomUUID(),generation:Number(gateway.device_epoch),state:'active'}});assert.equal(active.statusCode,200,active.body);await until(()=>bridge.history.includes(true));
  const ended=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/events`,headers:{authorization:`Bearer ${deviceToken}`},payload:{eventId:crypto.randomUUID(),generation:Number(gateway.device_epoch),state:'ended'}});assert.equal(ended.statusCode,200,ended.body);await execution;
  assert.equal((await db.query(`SELECT state FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0].state,'ended');assert.equal(bridge.history.at(-1),false);
 }finally{if(app)await app.close();await db.end();}
});
