import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const serviceToken='s72-internal-test-token-at-least-32-characters';
// The two S38 flags are on for the suite and flipped off inside the tests that assert the rollback
// behaviour; `buildApp` closes over this very object and every handler reads it per request.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s72-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3372,
  AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s72-test-media-secret-at-least-32-chars',TURN_SECRET:'s72-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  BUSY_CONFLICT_ENABLED:true,PIXEL_ORIGINATED_CALLS_ENABLED:true,PIXEL_ARCHIVE_ENABLED:true};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const internal={authorization:`Bearer ${serviceToken}`};
const password='correct horse battery staple';

/** A private owner per test: `ownerBusy` is account-wide, so a leftover call elsewhere would leak in. */
async function userFixture(label:string){
  const email=`${label}@example.test`;
  const id=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id as string;
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
  assert.equal(login.statusCode,200,login.body);
  return {id,token:login.json().token as string};
}
async function gatewayFixture(ownerUserId:string|null,label:string){
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id,version`,[g.id,ownerUserId,`${label} SIM`,tokenHash(`${label}-fingerprint-value`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  return {gatewayId:g.id as string,simId:sim.id as string,deviceEpoch:Number(g.device_epoch),deviceToken:token};
}
type Fixture=Awaited<ReturnType<typeof gatewayFixture>>;
const incoming=(f:Fixture,deviceCallId:string,extra:Record<string,unknown>={})=>app.inject({
  method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(f.deviceToken),
  payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId,simId:f.simId,remoteNumber:'+15550100',observedAt:new Date().toISOString(),...extra},
});
const sequences=new Map<string,number>();
function snapshot(f:Fixture,body:{localBusy:boolean;calls?:unknown[];confirmedAbsentCallIds?:string[]}){
  const next=(sequences.get(f.gatewayId)??0)+1;sequences.set(f.gatewayId,next);
  return app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(f.deviceToken),
    payload:{snapshotId:crypto.randomUUID(),snapshotSequence:next,generation:f.deviceEpoch,reportedSequence:0,
      localBusy:body.localBusy,confirmedAbsentCallIds:body.confirmedAbsentCallIds??[],calls:body.calls??[],
      observedAt:new Date(Date.now()+next*1000).toISOString()}});
}
const row=async(callId:string)=>(await db.query(`SELECT * FROM call_records WHERE id=$1`,[callId])).rows[0];
// S75: `call.internal_linked` is fire and forget: one row per leg, each pointing at the other.
async function linkedRows(callId:string,peerCallId:string,reason?:string){
  for(const [leg,peer] of [[callId,peerCallId],[peerCallId,callId]]){
    let rows:any[]=[];
    for(let i=0;i<40&&!rows.length;i++){rows=(await db.query(`SELECT fields FROM diag_events WHERE event='call.internal_linked' AND call_id=$1`,[leg])).rows;if(!rows.length)await new Promise(r=>setTimeout(r,50));}
    assert.equal(rows.length,1);assert.equal(rows[0].fields.peerCallId,peer);assert.ok(rows[0].fields.reason);
    if(reason)assert.equal(rows[0].fields.reason,reason);
  }
}
const hasLock=async(callId:string)=>Boolean((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount);
const pendingHangups=async(callId:string)=>Number((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup' AND status='pending'`,[callId])).rows[0].n);
const workerHeartbeat=async(instanceId:string,bootId:string)=>{
  const r=await app.inject({method:'POST',url:'/internal/v1/ai/workers/heartbeat',headers:internal,payload:{instanceId,bootId,protocol:'voice-run-v1',capacity:1}});
  assert.equal(r.statusCode,200,r.body);
};
// S42: one live Voice worker per test, so a `aiScheduled:false` can only come from the guard under test.
async function liveWorker(){
  const identity={instanceId:crypto.randomUUID(),bootId:crypto.randomUUID()};
  await workerHeartbeat(identity.instanceId,identity.bootId);
  return identity;
}
const ownerBusy=(token:string,callId:string)=>app.inject({method:'POST',url:`/api/v1/calls/${callId}/owner-busy`,headers:auth(token),payload:{}});
const runRow=async(callId:string)=>(await db.query(`SELECT * FROM ai_call_runs WHERE call_id=$1`,[callId])).rows[0];
const claimRun=async(identity:{instanceId:string;bootId:string})=>{
  const r=await app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:identity});
  assert.equal(r.statusCode,200,r.body);return r.json().run as any;
};
const commitAnswer=(run:any,identity:{instanceId:string;bootId:string})=>app.inject({method:'POST',
  url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:{...internal,'x-ai-lease-token':run.leaseToken},payload:identity});
/** `commitAiAnswer` refuses an answer before the grace elapsed; the tests do not sleep 5 seconds. */
const expireGrace=(callId:string)=>db.query(`UPDATE ai_call_runs SET trigger_at=now()-interval '1 second' WHERE call_id=$1`,[callId]);

import { AndroidPushWorker } from '../src/android-push-worker.js';
import { PushWorker } from '../src/push-worker.js';
import { TranscriptionRuntime } from '../src/transcription/runtime.js';

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

const setNumber=(simId:string,phone:string,label?:string)=>db.query(`UPDATE sims SET country_iso='CN',phone_label=$2,label=COALESCE($3,label) WHERE id=$1`,[simId,phone,label??null]);
const dial=(token:string,simId:string,remoteNumber:string)=>app.inject({method:'POST',url:'/api/v1/calls/outbound',
  headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId,remoteNumber}});
const sessionOf=async(token:string)=>(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(token)])).rows[0]?.id as string|undefined;
const loginAgain=async(email:string)=>{
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'ios'}});
  assert.equal(r.statusCode,200,r.body);return r.json().token as string;
};
/** Two gateways of one owner: 186 on A (dialer), 133 on B (callee). */
async function pair(label:string){
  const owner=await userFixture(label);
  const a=await gatewayFixture(owner.id,`${label}-a`),b=await gatewayFixture(owner.id,`${label}-b`);
  await setNumber(a.simId,'+8618600000001','Test SIM A');await setNumber(b.simId,'13300000002','Test SIM B');
  return {owner,a,b};
}

test('S72: two cards in one device cannot dial each other (409 SAME_DEVICE_INTERNAL)',async()=>{
  const owner=await userFixture('s72-same');
  const a=await gatewayFixture(owner.id,'s72-same');
  const second=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,1,$2,'slot2',true,$3)RETURNING id`,[a.gatewayId,owner.id,tokenHash('s72-same-2')])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[second]);
  await setNumber(a.simId,'+8618600000001');await setNumber(second,'13300000002');
  const r=await dial(owner.token,a.simId,'+8613300000002');
  assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error.code,'SAME_DEVICE_INTERNAL');
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE snapshot_owner_id=$1`,[owner.id])).rows[0].n,0);
});

test('S72: cross-gateway internal call links both legs, rings as 人工, skips blocklist, spares the dialing session',async()=>{
  const {owner,a,b}=await pair('s72-cross');
  await db.query(`UPDATE sim_settings SET mode='ai' WHERE sim_id=$1`,[b.simId]);
  await liveWorker();
  // The owner blocked his own 186 number: an internal call must still ring.
  const blocked=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:{...auth(owner.token),origin:'https://vodog.test'},payload:{remoteNumber:'+8618600000001'}});
  assert.ok([200,201].includes(blocked.statusCode),blocked.body);
  const out=await dial(owner.token,a.simId,'13300000002');
  assert.equal(out.statusCode,202,out.body);
  const outCall=out.json().call;
  assert.equal(outCall.internal,true);assert.equal(outCall.peerSimId,b.simId);assert.equal(outCall.peerSimLabel,'Test SIM B');

  const inc=await incoming(b,'s72-cross-in',{remoteNumber:'18600000001'});
  assert.equal(inc.statusCode,201,inc.body);assert.equal(inc.json().disposition,'offer_to_owner');
  const inRow=await row(inc.json().call.id),outRow=await row(outCall.id);
  assert.equal(inRow.state,'incoming_ringing');assert.equal(inRow.mode_snapshot,'normal');assert.equal(inRow.ai_run_id,null);
  assert.equal(inRow.internal_call,true);assert.equal(inRow.peer_call_id,outCall.id);assert.equal(inRow.peer_sim_id,a.simId);
  assert.equal(outRow.peer_call_id,inRow.id);
  await linkedRows(inRow.id,outCall.id,'callee_sim');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[inRow.id])).rows[0].n,0);

  // Pushes: the dialing (android) session gets nothing; a second iOS/Android login of the owner does.
  const dialer=(await sessionOf(owner.token))!;
  const otherToken=await loginAgain(`s72-cross@example.test`),other=(await sessionOf(otherToken))!;
  assert.ok(dialer&&other);
  for(const [session,label] of [[dialer,'dialer'],[other,'other']] as const){
    await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,fcm_token)
      VALUES($1,$2,$3,'android',NULL,'org.vodog',$4,$5)`,[crypto.randomUUID(),owner.id,session,label,`fcm-${label}-${'x'.repeat(40)}`]);
    await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,device_name,voip_token)
      VALUES($1,$2,$3,'ios','development',$4,$5)`,[crypto.randomUUID(),owner.id,session,label,'ab'.repeat(32)]);
  }
  const fcm:any[]=[];await new AndroidPushWorker(db,{send:async(push:any)=>{fcm.push(push);return{status:200};}}).tickOnce();
  const fcmIn=fcm.filter(p=>p.callId===inRow.id);
  assert.equal(fcmIn.length,1);assert.ok(fcmIn[0].token.startsWith('fcm-other'));
  // FCM stays byte-compatible (old Android clients drop unknown keys): no S72 keys there.
  assert.equal(fcmIn[0].internal,undefined);assert.equal(fcmIn[0].peerSimLabel,undefined);assert.equal(fcmIn[0].simLabel,undefined);
  const apns:any[]=[];const pw=new PushWorker(db,{sendIncoming:async(push:any)=>{apns.push(push);return{status:200};}});
  await pw.tick();await pw.tick();
  const apnsIn=apns.filter(p=>p.callId===inRow.id);
  assert.equal(apnsIn.length,1);assert.equal(apnsIn[0].internal,true);assert.equal(apnsIn[0].peerSimLabel,'Test SIM A');assert.equal(apnsIn[0].simLabel,'Test SIM B','S81: the called SIM');
  const delivered=(await db.query(`SELECT session_id FROM push_deliveries WHERE call_id=$1`,[inRow.id])).rows.map(r=>r.session_id);
  assert.deepEqual(delivered,[other]);

  // Claim: the dialing session is refused; owner-busy never schedules AI.
  const own=await app.inject({method:'POST',url:`/api/v1/calls/${inRow.id}/claim`,headers:auth(owner.token),payload:{platform:'android'}});
  assert.equal(own.statusCode,409,own.body);assert.equal(own.json().error.code,'OWN_OUTGOING_CALL');
  const busy=await ownerBusy(otherToken,inRow.id);
  assert.equal(busy.statusCode,200,busy.body);assert.deepEqual(busy.json(),{aiScheduled:false});

  // Live: the dialer sees only its outgoing leg; every other session also sees the incoming leg ringing.
  const ids=async(token:string)=>(await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)})).json().items as any[];
  assert.deepEqual((await ids(owner.token)).map(c=>c.id),[outCall.id]);
  const otherLive=await ids(otherToken);
  assert.deepEqual(otherLive.map(c=>c.id).sort(),[inRow.id,outCall.id].sort());
  const ringing=otherLive.find(c=>c.id===inRow.id);
  assert.equal(ringing.state,'incoming_ringing');assert.equal(ringing.internal,true);
  assert.equal(ringing.peerSimLabel,'Test SIM A');assert.equal(ringing.simLabel,'Test SIM B');assert.equal(ringing.peerCallId,outCall.id);
  const detail=await app.inject({method:'GET',url:`/api/v1/calls/${outCall.id}`,headers:auth(owner.token)});
  assert.equal(detail.statusCode,200);assert.equal(detail.json().call.internal,true);
  // S81: GET /calls/:id (polled by Android while ringing) carries this leg's own SIM label.
  const ringingDetail=await app.inject({method:'GET',url:`/api/v1/calls/${inRow.id}`,headers:auth(otherToken)});
  assert.equal(ringingDetail.statusCode,200);assert.equal(ringingDetail.json().call.simLabel,'Test SIM B');
  assert.equal(detail.json().call.simLabel,'Test SIM A');assert.equal(outCall.simLabel,'Test SIM A','mutation DTO too');

  // Missed internal call: no badge, not unseen.
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=ANY($1::uuid[])`,[[inRow.id,outCall.id]]);
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=ANY($1::uuid[])`,[[inRow.id,outCall.id]]);
  // Terminal: merged into the incoming leg for every session.
  assert.deepEqual((await ids(owner.token)).map(c=>c.id),[inRow.id]);
  assert.deepEqual((await ids(otherToken)).map(c=>c.id),[inRow.id]);
  const badges=(await app.inject({method:'GET',url:'/api/v1/badges',headers:auth(owner.token)})).json();
  assert.equal(badges.calls,0);
  const reports=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=7d&timeZone=Asia/Shanghai',headers:auth(owner.token)});
  assert.equal(reports.statusCode,200,reports.body);
  const items=reports.json().items;
  assert.deepEqual(items.map((i:any)=>i.callId),[inRow.id]);assert.equal(items[0].internal,true);assert.equal(items[0].unseen,false);

  // Deleting the incoming leg brings the outgoing leg back (no FK, dangling peer = no peer).
  await db.query(`DELETE FROM call_records WHERE id=$1`,[inRow.id]);
  const after=(await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(owner.token)})).json().items;
  assert.deepEqual(after.map((c:any)=>c.id),[outCall.id]);
});

test('S72: a device-dialed internal call backfills the link when the incoming leg came first',async()=>{
  const {owner,a,b}=await pair('s72-observed');
  const inc=await incoming(b,'s72-obs-in',{remoteNumber:'18600000001'});
  assert.equal(inc.statusCode,201,inc.body);
  const inId=inc.json().call.id as string;
  assert.equal((await row(inId)).internal_call,false);
  const obs=await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(a.deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:a.deviceEpoch,deviceCallId:'s72-obs-out',simId:a.simId,remoteNumber:'13300000002',observedAt:new Date().toISOString(),telecomState:'dialing'}});
  assert.ok(obs.statusCode<300,obs.body);
  const outId=(await db.query(`SELECT id FROM call_records WHERE gateway_id=$1 AND device_call_id='s72-obs-out'`,[a.gatewayId])).rows[0].id;
  const inRow=await row(inId),outRow=await row(outId);
  assert.equal(outRow.internal_call,true);assert.equal(outRow.peer_sim_id,b.simId);assert.equal(outRow.peer_call_id,inId);
  assert.equal(inRow.internal_call,true);assert.equal(inRow.peer_call_id,outId);assert.equal(inRow.peer_sim_id,a.simId);
  await linkedRows(outId,inId);
  void owner;
});

test('S72: device-observed dial first, then the incoming leg links via the dialing SIM',async()=>{
  const {a,b}=await pair('s72-observed2');
  await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(a.deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:a.deviceEpoch,deviceCallId:'s72-obs2-out',simId:a.simId,remoteNumber:'+8613300000002',observedAt:new Date().toISOString(),telecomState:'dialing'}});
  const inc=await incoming(b,'s72-obs2-in',{remoteNumber:'+8618600000001'});
  assert.equal(inc.statusCode,201,inc.body);
  const inRow=await row(inc.json().call.id);
  assert.equal(inRow.internal_call,true);assert.ok(inRow.peer_call_id);
  assert.equal((await row(inRow.peer_call_id)).peer_call_id,inRow.id);
});

test('S72: answering on the gateway device itself records answered_by_platform=device',async()=>{
  const owner=await userFixture('s72-device');
  const f=await gatewayFixture(owner.id,'s72-device');
  await db.query(`UPDATE sim_settings SET mode='timeout_ai' WHERE sim_id=$1`,[f.simId]);
  await liveWorker();
  const inc=await incoming(f,'s72-device-in');
  const callId=inc.json().call.id as string;
  assert.ok((await row(callId)).ai_run_id,'timeout_ai run expected');
  const r=await snapshot(f,{localBusy:true,calls:[{callId,deviceCallId:'s72-device-in',simId:f.simId,direction:'incoming',state:'active'}]});
  assert.equal(r.statusCode,200,r.body);
  const stored=await row(callId);
  assert.equal(stored.state,'active');assert.equal(stored.answered_by_platform,'device');
  assert.equal((await runRow(callId)).state,'lost_race');
  // A claimed call keeps its claimer.
  const f2=await gatewayFixture(owner.id,'s72-device-2');
  const inc2=await incoming(f2,'s72-device-2');const id2=inc2.json().call.id as string;
  const claim=await app.inject({method:'POST',url:`/api/v1/calls/${id2}/claim`,headers:auth(owner.token),payload:{platform:'android'}});
  assert.equal(claim.statusCode,200,claim.body);
  await snapshot(f2,{localBusy:true,calls:[{callId:id2,deviceCallId:'s72-device-2',simId:f2.simId,direction:'incoming',state:'active'}]});
  assert.equal((await row(id2)).answered_by_platform,'android');
  // Same rule through the per-call state event path.
  const f3=await gatewayFixture(owner.id,'s72-device-3');
  const id3=(await incoming(f3,'s72-device-3')).json().call.id as string;
  const ev=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${id3}/events`,headers:auth(f3.deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:f3.deviceEpoch,state:'active'}});
  assert.equal(ev.statusCode,200,ev.body);
  const r3=await row(id3);assert.equal(r3.state,'active');assert.equal(r3.answered_by_platform,'device');
});

test('S72 D8: transcription skips the internal outgoing leg',async()=>{
  const {owner,a,b}=await pair('s72-transcript');
  const ins=async(g:Fixture,dir:string,internal:boolean)=>(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,started_at,answered_at,ended_at,recording_status,internal_call)
    VALUES($1,$2,$3,$4,'ended',1,'normal',now(),now(),now(),'pending',$5)RETURNING id`,[g.gatewayId,g.simId,owner.id,dir,internal])).rows[0].id as string;
  const outId=await ins(a,'outgoing',true),inId=await ins(b,'incoming',true),plainOut=await ins(a,'outgoing',false);
  const asked:string[]=[];
  const runtime=new TranscriptionRuntime({enabled:true,db:db as never,enabledAt:new Date(Date.now()-60_000),scanBatch:10,
    worker:{enqueueCall:async()=>undefined,tickOnce:async()=>'idle'},resolveSource:()=>{throw new Error('unused');},
    pixelSource:{manifest:async(callId:string)=>{asked.push(callId);return null;}} as never});
  await runtime.tickOnce();
  assert.ok(asked.includes(inId));assert.ok(asked.includes(plainOut));assert.ok(!asked.includes(outId));
});
