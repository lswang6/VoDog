import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const serviceToken='voice-provider-internal-token-at-least-32-chars';
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'voice-provider-cookie-secret-at-least-32-chars',
  GATEWAY_ONLINE_SECONDS:30,PORT:3399,COMMAND_REPLAY_HORIZON_ENABLED:false,AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,
  // S24 决策 3: two configured providers so `configured` and `online` can disagree in both directions.
  AI_VOICE_PROVIDERS:'xai,doubao',MEDIA_DEFAULT_NODE_ID:'relay-primary',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  WEB_CALL_LIVENESS_ENABLED:false,FCM_ENABLED:false};
let db:Db,app:FastifyInstance,userId:string,simId:string,gatewayId:string,deviceToken:string,userToken:string,deviceEpoch:number;
const xaiWorker={instanceId:'00000000-0000-4000-8000-0000000000a1',bootId:'00000000-0000-4000-8000-0000000000a2'};
const doubaoWorker={instanceId:'00000000-0000-4000-8000-0000000000b1',bootId:'00000000-0000-4000-8000-0000000000b2'};
const internal={authorization:`Bearer ${serviceToken}`};
const auth=(token:string)=>({authorization:`Bearer ${token}`});

before(async()=>{
  db=createDb(databaseUrl);await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const password=await hashPassword('correct horse battery staple');
  userId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('voice-provider-owner@example.test',$1)RETURNING id`,[password])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('provider-gateway',true,true,true,true,now())RETURNING id,device_epoch`)).rows[0];
  gatewayId=gateway.id;deviceEpoch=Number(gateway.device_epoch);
  simId=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'provider SIM',true,$3)RETURNING id`,[gatewayId,userId,tokenHash('provider-sim-stable-fingerprint')])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id,mode,timeout_seconds)VALUES($1,'ai',45)`,[simId]);
  deviceToken='provider-device-token-at-least-32-characters';
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'provider-test')`,[gatewayId,tokenHash(deviceToken)]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),1,0,false,'[]',now())`,[gatewayId,deviceEpoch]);
  app=await buildApp(db,config as any);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'voice-provider-owner@example.test',password:'correct horse battery staple',platform:'android'}});
  assert.equal(login.statusCode,200,login.body);userToken=login.json().token;
});
after(async()=>{await app.close();await db.end();});

async function heartbeat(identity:{instanceId:string;bootId:string},providers?:string[]){
  const response=await app.inject({method:'POST',url:'/internal/v1/ai/workers/heartbeat',headers:internal,
    payload:{...identity,protocol:'voice-run-v1',capacity:1,...(providers?{providers}:{})}});
  return response;
}
const expireWorker=(identity:{instanceId:string})=>db.query(`UPDATE ai_worker_instances SET expires_at=now()-interval '1 second' WHERE instance_id=$1`,[identity.instanceId]);
async function incoming(deviceCallId=crypto.randomUUID()){
  const eventId=crypto.randomUUID(),observedAt=new Date().toISOString();
  const response=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),
    payload:{eventId,generation:deviceEpoch,deviceCallId,simId,remoteNumber:'+15550188',observedAt}});
  assert.equal(response.statusCode,201,response.body);
  return{callId:response.json().call.id,eventId};
}
async function cleanupCall(callId:string){
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[callId]);
  await db.query(`UPDATE ai_call_runs SET state='ended',ended_at=COALESCE(ended_at,now()),lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL WHERE call_id=$1`,[callId]);
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[callId]);
  await db.query(`UPDATE gateway_telecom_snapshots SET local_busy=false,calls='[]',observed_at=now() WHERE gateway_id=$1`,[gatewayId]);
}
const providersOf=async(identity:{instanceId:string})=>(await db.query(`SELECT providers FROM ai_worker_instances WHERE instance_id=$1`,[identity.instanceId])).rows[0]?.providers as string[]|undefined;
const listProviders=async()=>{
  const response=await app.inject({method:'GET',url:'/api/v1/ai/voice-providers',headers:auth(userToken)});
  assert.equal(response.statusCode,200,response.body);return response.json();
};
const putProvider=async(provider:unknown,expectedVersion?:number)=>{
  const version=expectedVersion??(await listProviders()).configVersion;
  return app.inject({method:'PUT',url:'/api/v1/ai/voice-provider',headers:auth(userToken),payload:{provider,expectedVersion:version}});
};

test('a heartbeat publishes the providers it can instantiate and an omitted field still means xAI',async()=>{
  const legacy=await heartbeat(xaiWorker);assert.equal(legacy.statusCode,200,legacy.body);
  assert.deepEqual(legacy.json().worker.providers,['xai']);
  assert.deepEqual(await providersOf(xaiWorker),['xai']);
  const republished=await heartbeat(xaiWorker,['xai','doubao']);assert.equal(republished.statusCode,200,republished.body);
  assert.deepEqual(await providersOf(xaiWorker),['xai','doubao']);
  // A restart that drops a provider must narrow the advertisement on the very next beat.
  await heartbeat(xaiWorker,['xai']);assert.deepEqual(await providersOf(xaiWorker),['xai']);
  const malformed=await heartbeat(xaiWorker,['Doubao!']);assert.equal(malformed.statusCode,400,malformed.body);
  assert.deepEqual(await providersOf(xaiWorker),['xai']);
  // An explicitly empty list is NOT the pre-S24 "unspecified" case: the worker is telling us it can
  // instantiate nothing, so it must stay online for zero providers rather than be credited with xAI.
  const empty=await heartbeat(xaiWorker,[]);assert.equal(empty.statusCode,200,empty.body);
  assert.deepEqual(empty.json().worker.providers,[]);
  assert.deepEqual(await providersOf(xaiWorker),[]);
  assert.deepEqual((await listProviders()).items.map((item:any)=>item.online),[false,false]);
  await heartbeat(xaiWorker,['xai']);assert.deepEqual(await providersOf(xaiWorker),['xai']);
});

test('the list reports configured and online independently and always contains the selection',async()=>{
  await heartbeat(xaiWorker,['xai']);await expireWorker(doubaoWorker);
  const configured=await listProviders();
  assert.equal(configured.selected,'xai');
  assert.equal(configured.configVersion,1);
  assert.deepEqual(configured.items,[
    {id:'xai',label:'xAI Grok',configured:true,online:true},
    {id:'doubao',label:'豆包',configured:true,online:false},
  ]);
  await heartbeat(doubaoWorker,['doubao']);
  assert.deepEqual((await listProviders()).items.find((item:any)=>item.id==='doubao'),{id:'doubao',label:'豆包',configured:true,online:true});
  // A provider that was removed from AI_VOICE_PROVIDERS after someone selected it stays visible,
  // marked not configured, so the three clients never show a different provider as selected.
  await db.query(`UPDATE users SET ai_voice_provider='legacy_vendor' WHERE id=$1`,[userId]);
  const orphan=await listProviders();
  assert.equal(orphan.selected,'legacy_vendor');
  assert.deepEqual(orphan.items.at(-1),{id:'legacy_vendor',label:'legacy_vendor',configured:false,online:false});
  await db.query(`UPDATE users SET ai_voice_provider='xai' WHERE id=$1`,[userId]);
  const anonymous=await app.inject({method:'GET',url:'/api/v1/ai/voice-providers'});assert.equal(anonymous.statusCode,401,anonymous.body);
});

test('switching needs a configured and online provider and writes one audit record',async()=>{
  await heartbeat(xaiWorker,['xai']);await expireWorker(doubaoWorker);
  const missingVersion=await app.inject({method:'PUT',url:'/api/v1/ai/voice-provider',headers:auth(userToken),payload:{provider:'xai'}});
  assert.equal(missingVersion.statusCode,428,missingVersion.body);assert.equal(missingVersion.json().error.code,'PROVIDER_VERSION_REQUIRED');
  const offline=await putProvider('doubao');
  assert.equal(offline.statusCode,409,offline.body);assert.equal(offline.json().error.code,'PROVIDER_UNAVAILABLE');
  assert.match(offline.json().error.message,/离线/);assert.equal(offline.json().error.details.reason,'offline');
  const unconfigured=await putProvider('legacy_vendor');
  assert.equal(unconfigured.statusCode,409,unconfigured.body);assert.equal(unconfigured.json().error.code,'PROVIDER_UNAVAILABLE');
  assert.match(unconfigured.json().error.message,/未配置/);assert.equal(unconfigured.json().error.details.reason,'not_configured');
  const malformed=await putProvider('Doubao!');assert.equal(malformed.statusCode,400,malformed.body);
  assert.equal((await db.query(`SELECT ai_voice_provider FROM users WHERE id=$1`,[userId])).rows[0].ai_voice_provider,'xai');
  await heartbeat(doubaoWorker,['doubao']);
  const accepted=await putProvider('doubao');assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal(accepted.json().selected,'doubao');
  assert.equal(accepted.json().configVersion,2);
  assert.deepEqual(accepted.json().items.map((item:any)=>item.id),['xai','doubao']);
  assert.equal((await db.query(`SELECT ai_voice_provider FROM users WHERE id=$1`,[userId])).rows[0].ai_voice_provider,'doubao');
  const audit=(await db.query(`SELECT details FROM audit_events WHERE actor_user_id=$1 AND action='ai.voice_provider.update' ORDER BY id DESC LIMIT 1`,[userId])).rows[0];
  assert.deepEqual(audit.details,{from:'xai',to:'doubao'});
  assert.equal((await db.query(`SELECT count(*)::int n FROM audit_events WHERE action='ai.voice_provider.update'`)).rows[0].n,1);
  const back=await putProvider('xai');assert.equal(back.statusCode,200,back.body);assert.equal(back.json().selected,'xai');
  assert.equal(back.json().configVersion,3);
  const contenders=await Promise.all([putProvider('xai',3),putProvider('doubao',3)]);
  assert.deepEqual(contenders.map(response=>response.statusCode).sort(),[200,409]);
  const conflict=contenders.find(response=>response.statusCode===409)!;
  assert.equal(conflict.json().error.code,'PROVIDER_VERSION_CONFLICT');
  assert.equal(conflict.json().error.details.currentVersion,4);
  const restored=await putProvider('xai');assert.equal(restored.statusCode,200,restored.body);
  assert.equal(restored.json().selected,'xai');assert.equal(restored.json().configVersion,5);
});

test('an incoming call freezes the selection and the claim response carries it',async()=>{
  await heartbeat(xaiWorker,['xai']);await heartbeat(doubaoWorker,['doubao']);
  const first=await incoming();
  assert.equal((await db.query(`SELECT voice_provider FROM ai_call_runs WHERE call_id=$1`,[first.callId])).rows[0].voice_provider,'xai');
  const claimed=await app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:xaiWorker});
  assert.equal(claimed.statusCode,200,claimed.body);assert.equal(claimed.json().run.voiceProvider,'xai');
  await cleanupCall(first.callId);
  // Switching now must not re-target the run that was already frozen, only the next call.
  assert.equal((await putProvider('doubao')).statusCode,200);
  const second=await incoming();
  assert.equal((await db.query(`SELECT voice_provider FROM ai_call_runs WHERE call_id=$1`,[second.callId])).rows[0].voice_provider,'doubao');
  assert.equal((await db.query(`SELECT voice_provider FROM ai_call_runs WHERE call_id=$1`,[first.callId])).rows[0].voice_provider,'xai');
  await cleanupCall(second.callId);
});

test('an owner whose provider has no live worker gets a normal ring instead of an unrunnable run',async()=>{
  await heartbeat(xaiWorker,['xai']);await heartbeat(doubaoWorker,['doubao']);
  assert.equal((await putProvider('doubao')).statusCode,200);
  // Only the selected provider goes away: a fresh xAI worker proves the skip is provider specific
  // rather than the pre-S24 "no worker at all" case.
  await expireWorker(doubaoWorker);
  const skipped=await incoming();
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[skipped.callId])).rows[0].n,0);
  const call=(await db.query(`SELECT state,mode_snapshot,ai_run_id,failure_reason FROM call_records WHERE id=$1`,[skipped.callId])).rows[0];
  assert.equal(call.state,'incoming_ringing');assert.equal(call.mode_snapshot,'ai');assert.equal(call.ai_run_id,null);assert.equal(call.failure_reason,null);
  // The exact suppression predicate both push workers use must still select this call.
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records c WHERE c.id=$1 AND c.state='incoming_ringing'
    AND NOT (c.mode_snapshot='ai' AND c.ai_run_id IS NOT NULL)`,[skipped.callId])).rows[0].n,1);
  const event=(await db.query(`SELECT payload->'response' response FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[gatewayId,skipped.eventId])).rows[0];
  assert.equal(event.response.disposition,'offer_to_owner');
  assert.equal(event.response.aiSkipped,'provider_unavailable');
  assert.equal(event.response.voiceProvider,'doubao');
  const nothingToClaim=await app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:xaiWorker});
  assert.equal(nothingToClaim.statusCode,204,nothingToClaim.body);
  await cleanupCall(skipped.callId);
  // The very next call is answered again as soon as the provider comes back.
  await heartbeat(doubaoWorker,['doubao']);
  const restored=await incoming();
  assert.equal((await db.query(`SELECT voice_provider FROM ai_call_runs WHERE call_id=$1`,[restored.callId])).rows[0].voice_provider,'doubao');
  await cleanupCall(restored.callId);
  assert.equal((await putProvider('xai')).statusCode,200);
});
