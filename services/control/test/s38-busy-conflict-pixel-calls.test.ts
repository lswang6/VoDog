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
const serviceToken='s38-internal-test-token-at-least-32-characters';
// The two S38 flags are on for the suite and flipped off inside the tests that assert the rollback
// behaviour; `buildApp` closes over this very object and every handler reads it per request.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s38-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
  AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s38-test-media-secret-at-least-32-chars',TURN_SECRET:'s38-test-turn-secret-at-least-32-chars',
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

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

test('S38: a call the phone screened itself is recorded as a phone interception and stays out of the history',async()=>{
  const owner=await userFixture('s38-phone-blocked');
  const f=await gatewayFixture(owner.id,'s38-phone-blocked');
  const response=await incoming(f,'calllog:488',{blockedLocally:true,blockSource:'phone'});
  assert.equal(response.statusCode,202,response.body);
  assert.equal(response.json().disposition,'dropped_blocked');
  assert.equal(response.json().call,undefined);
  const stored=(await db.query(`SELECT state,failure_reason,blocked_source FROM call_records WHERE gateway_id=$1`,[f.gatewayId])).rows[0];
  assert.deepEqual(stored,{state:'failed',failure_reason:'number_blocked',blocked_source:'phone'});
  // Terminal at creation, exactly like the S21 §B gateway-local block: no lock, no hangup.
  assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,0);

  const feed=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(owner.token)});
  assert.equal(feed.statusCode,200,feed.body);
  const item=feed.json().items.find((entry:any)=>entry.kind==='call');
  assert.ok(item,'the phone interception is missing from the feed');
  assert.equal(item.source,'phone');
  const history=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(owner.token)});
  assert.equal(history.json().items.length,0);
});

test('S38: a second call on the busy Pixel is auto-rejected, and only while the flag is on',async()=>{
  const owner=await userFixture('s38-busy-same');
  const f=await gatewayFixture(owner.id,'s38-busy-same');
  // The owner is on another call on this very Pixel, journaled but unmanaged (a personal call).
  const busy=await snapshot(f,{localBusy:true,calls:[{deviceCallId:'personal-call',simId:f.simId,direction:'outgoing',state:'active'}]});
  assert.equal(busy.statusCode,200,busy.body);

  const rejected=await incoming(f,'second-call');
  assert.equal(rejected.statusCode,201,rejected.body);
  assert.equal(rejected.json().disposition,'rejected_busy');
  const callId=rejected.json().call.id as string;
  assert.equal(rejected.json().call.conflictDisposition,'rejected');
  const stored=await row(callId);
  assert.equal(stored.state,'failed');
  assert.equal(stored.failure_reason,'busy_auto_rejected');
  assert.equal(stored.conflict_disposition,'rejected');
  assert.ok(stored.ended_at);
  assert.equal(await hasLock(callId),false);
  assert.equal(await pendingHangups(callId),1);

  const listed=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(owner.token)});
  const shown=listed.json().items.find((entry:any)=>entry.id===callId);
  assert.ok(shown,'busy_auto_rejected must stay visible in the history');
  assert.equal(shown.failureReason,'busy_auto_rejected');
  assert.equal(shown.conflictDisposition,'rejected');

  (config as any).BUSY_CONFLICT_ENABLED=false;
  try{
    const legacy=await incoming(f,'third-call');
    assert.equal(legacy.statusCode,202,legacy.body);
    assert.equal(legacy.json().disposition,'local_only');
    assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,1);
  }finally{(config as any).BUSY_CONFLICT_ENABLED=true;}
});

test('S38: a call on another Pixel of the same account is answered by AI, and auto-rejected when AI cannot',async()=>{
  const owner=await userFixture('s38-busy-cross');
  const a=await gatewayFixture(owner.id,'s38-busy-cross-a');
  const b=await gatewayFixture(owner.id,'s38-busy-cross-b');
  // A human call in progress on Pixel A. The SIM on Pixel B keeps its 'normal' mode throughout.
  await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,answered_by_platform,answered_at,started_at)
     VALUES($1,$2,$3,'incoming','+15550001','active',$4,'normal','web',now(),now())`,
    [a.gatewayId,a.simId,owner.id,a.deviceEpoch],
  );
  const worker={instanceId:'00000000-0000-4000-8000-0000000000a1',bootId:'00000000-0000-4000-8000-0000000000a2'};
  await workerHeartbeat(worker.instanceId,worker.bootId);

  const aiAnswered=await incoming(b,'cross-gateway-call');
  assert.equal(aiAnswered.statusCode,201,aiAnswered.body);
  assert.equal(aiAnswered.json().disposition,'offer_to_owner');
  const aiCallId=aiAnswered.json().call.id as string;
  const aiRow=await row(aiCallId);
  assert.equal(aiRow.mode_snapshot,'ai');
  assert.equal(aiRow.conflict_disposition,'ai_answered');
  assert.ok(aiRow.ai_run_id,'the temporary AI answer needs a run');
  assert.equal(aiAnswered.json().call.conflictDisposition,'ai_answered');
  assert.equal((await db.query(`SELECT mode FROM sim_settings WHERE sim_id=$1`,[b.simId])).rows[0].mode,'normal');

  // Free Pixel B again, then take the AI worker away: the same conflict must now auto-reject.
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[aiCallId]);
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[aiCallId]);
  await db.query(`UPDATE ai_worker_instances SET expires_at=now()-interval '1 second' WHERE instance_id=$1`,[worker.instanceId]);

  const fellBack=await incoming(b,'cross-gateway-no-ai');
  assert.equal(fellBack.statusCode,201,fellBack.body);
  assert.equal(fellBack.json().disposition,'rejected_busy');
  const rejectedId=fellBack.json().call.id as string;
  const rejectedRow=await row(rejectedId);
  assert.equal(rejectedRow.state,'failed');
  assert.equal(rejectedRow.failure_reason,'busy_auto_rejected');
  assert.equal(rejectedRow.conflict_disposition,'rejected');
  assert.equal(await hasLock(rejectedId),false);
  assert.equal(await pendingHangups(rejectedId),1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[rejectedId])).rows[0].n,0);

  // The 报告 tab renders the same wording from the same two facts.
  const report=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=7d&timeZone=UTC',headers:auth(owner.token)});
  assert.equal(report.statusCode,200,report.body);
  const reported=report.json().items.find((entry:any)=>entry.callId===aiCallId);
  assert.ok(reported,'the AI-answered conflict call is missing from the report');
  assert.equal(reported.conflictDisposition,'ai_answered');
  assert.equal(reported.originatingPlatform,null);
});

test('S38: a call dialed on the Pixel becomes a record, follows the snapshot and closes on confirmed absence',async()=>{
  const owner=await userFixture('s38-pixel-dial');
  const f=await gatewayFixture(owner.id,'s38-pixel-dial');
  const payload={eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId:'telecom-77',simId:f.simId,
    remoteNumber:'10010',observedAt:new Date().toISOString(),telecomState:'dialing'};
  const observed=await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(f.deviceToken),payload});
  assert.equal(observed.statusCode,201,observed.body);
  const callId=observed.json().callId as string;
  assert.ok(callId);
  const created=await row(callId);
  assert.equal(created.direction,'outgoing');
  assert.equal(created.originating_platform,'pixel');
  assert.equal(created.originating_session_id,null);
  assert.equal(created.state,'connecting');
  assert.equal(created.device_call_id,'telecom-77');
  assert.equal(await hasLock(callId),true);

  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(f.deviceToken),payload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),{accepted:true,replayed:true,callId});
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,1);

  const active=await snapshot(f,{localBusy:true,calls:[{callId,deviceCallId:'telecom-77',simId:f.simId,direction:'outgoing',state:'active'}]});
  assert.equal(active.statusCode,200,active.body);
  assert.equal((await row(callId)).state,'active');

  // Lock-less pixel rows are outside `reclaimAbsentGatewayLocks`; the snapshot route closes them itself.
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[callId]);
  const gone=await snapshot(f,{localBusy:false,confirmedAbsentCallIds:[callId]});
  assert.equal(gone.statusCode,200,gone.body);
  const closed=await row(callId);
  assert.equal(closed.state,'ended');
  assert.ok(closed.ended_at);
  assert.equal(closed.failure_reason,null);

  // A gateway that restarts with a stale journal re-sends the same device call under a fresh event
  // ID: the unique device-call index must hand back the closed record, and never relock it.
  const resent=await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(f.deviceToken),
    payload:{...payload,eventId:crypto.randomUUID(),telecomState:'active'}});
  assert.equal(resent.statusCode,201,resent.body);
  assert.equal(resent.json().callId,callId);
  assert.equal(await hasLock(callId),false);
  assert.equal((await row(callId)).state,'ended');

  const report=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=7d&timeZone=UTC',headers:auth(owner.token)});
  assert.equal(report.statusCode,200,report.body);
  const reported=report.json().items.find((entry:any)=>entry.callId===callId);
  assert.ok(reported,'the Pixel-dialed call is missing from the report');
  // The single-track rule on the report card reads exactly this field.
  assert.equal(reported.originatingPlatform,'pixel');
  assert.equal(reported.conflictDisposition,null);

  // The owner cannot hang up a call Control never placed, and the occupancy says so.
  const end=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(owner.token),payload:{}});
  assert.equal(end.statusCode,409,end.body);
  assert.equal(end.json().error.code,'CALL_NOT_CONTROLLABLE');

  (config as any).PIXEL_ORIGINATED_CALLS_ENABLED=false;
  try{
    const off=await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(f.deviceToken),
      payload:{...payload,eventId:crypto.randomUUID(),deviceCallId:'telecom-78'}});
    assert.equal(off.statusCode,202,off.body);
    assert.deepEqual(off.json(),{accepted:true,replayed:false,callId:null});
    assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,1);
  }finally{(config as any).PIXEL_ORIGINATED_CALLS_ENABLED=true;}
});

test('S38: capture binding is issued for an active Pixel-dialed call and refused otherwise',async()=>{
  const owner=await userFixture('s38-capture');
  const f=await gatewayFixture(owner.id,'s38-capture');
  const observed=await app.inject({method:'POST',url:'/api/v1/gateway/calls/outgoing-observed',headers:auth(f.deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId:'telecom-90',simId:f.simId,
      remoteNumber:'10010',observedAt:new Date().toISOString(),telecomState:'active'}});
  assert.equal(observed.statusCode,201,observed.body);
  const callId=observed.json().callId as string;
  assert.equal((await row(callId)).state,'active');
  // `ensureCaptureBinding` demands a fresh snapshot naming exactly this active call.
  const seen=await snapshot(f,{localBusy:true,calls:[{callId,deviceCallId:'telecom-90',simId:f.simId,direction:'outgoing',state:'active'}]});
  assert.equal(seen.statusCode,200,seen.body);

  const bound=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(f.deviceToken),
    payload:{deviceCallId:'telecom-90',telecomCreationTimeMillis:1758000000000}});
  assert.equal(bound.statusCode,200,bound.body);
  const binding=bound.json().captureBinding;
  assert.equal(binding.callId,callId);
  assert.equal(binding.deviceCallId,'telecom-90');
  assert.equal(binding.mediaNodeId,'relay-primary');
  const pinned=await row(callId);
  assert.equal(pinned.media_node_id,'relay-primary');
  assert.equal(pinned.recording_status,'pending');
  // Idempotent: the recorder asks again after a restart and must get the same binding.
  const again=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(f.deviceToken),
    payload:{deviceCallId:'telecom-90',telecomCreationTimeMillis:1758000000000}});
  assert.equal(again.statusCode,200,again.body);
  assert.equal(again.json().captureBinding.id,binding.id);

  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[callId]);
  const stale=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(f.deviceToken),
    payload:{deviceCallId:'telecom-90',telecomCreationTimeMillis:1758000000000}});
  assert.equal(stale.statusCode,409,stale.body);
  assert.equal(stale.json().error.code,'CAPTURE_NOT_ACTIVE');

  // A call Control placed is not a passive-capture subject, whatever its state.
  const control=(await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,originating_platform,device_call_id,answered_at,started_at)
     VALUES($1,$2,$3,'outgoing','10086','active',$4,'normal','web','telecom-91',now(),now()) RETURNING id`,
    [f.gatewayId,f.simId,owner.id,f.deviceEpoch],
  )).rows[0].id as string;
  const refused=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${control}/capture-binding`,headers:auth(f.deviceToken),
    payload:{deviceCallId:'telecom-91',telecomCreationTimeMillis:1758000000001}});
  assert.equal(refused.statusCode,409,refused.body);
  assert.equal(refused.json().error.code,'CAPTURE_NOT_ACTIVE');

  (config as any).PIXEL_ORIGINATED_CALLS_ENABLED=false;
  try{
    const off=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(f.deviceToken),
      payload:{deviceCallId:'telecom-90',telecomCreationTimeMillis:1758000000000}});
    assert.equal(off.statusCode,503,off.body);
    assert.equal(off.json().error.code,'CAPTURE_DISABLED');
  }finally{(config as any).PIXEL_ORIGINATED_CALLS_ENABLED=true;}
});

test('S42: 机主设备占线上报排一个 5 秒后的 AI run，幂等，AI 真接通后才记为 ai_answered',async()=>{
  const owner=await userFixture('s42-owner-busy');
  const f=await gatewayFixture(owner.id,'s42-owner-busy');
  const identity=await liveWorker();
  // The call has been ringing for 20 s when the iPhone reports it is on another call: the grace must
  // run from now, not from `observedAt`, or it would already be spent.
  const ringing=await incoming(f,'s42-busy-call',{observedAt:new Date(Date.now()-20_000).toISOString()});
  assert.equal(ringing.statusCode,201,ringing.body);
  const callId=ringing.json().call.id as string;
  const created=await row(callId);
  assert.equal(created.mode_snapshot,'normal');
  assert.equal(created.ai_run_id,null,'a normal SIM never schedules AI by itself');

  const reported=await ownerBusy(owner.token,callId);
  assert.equal(reported.statusCode,200,reported.body);
  assert.deepEqual(reported.json(),{aiScheduled:true});
  const scheduled=await row(callId);
  assert.ok(scheduled.ai_run_id);
  assert.equal(scheduled.mode_snapshot,'normal','the SIM mode snapshot is never rewritten');
  assert.equal(scheduled.conflict_disposition,null,'the label waits for the AI to actually answer');
  // `timeout_seconds_snapshot` keeps the SIM's own frozen setting (its CHECK floor is 10); the 5 s
  // grace lives in `trigger_at`, which is what both the worker claim and the commit read.
  assert.equal(Number(scheduled.timeout_seconds_snapshot),45);
  const delay=Number((await db.query(`SELECT EXTRACT(EPOCH FROM ai_trigger_at-now()) d FROM call_records WHERE id=$1`,[callId])).rows[0].d);
  assert.ok(delay>4&&delay<=5.1,`AI must trigger ~5 s from now, got ${delay}`);
  const run=await runRow(callId);
  assert.equal(run.mode_snapshot,'timeout_ai');
  assert.equal(run.state,'pending');

  // A retried push handler reports the same call again: idempotent, no second run.
  const again=await ownerBusy(owner.token,callId);
  assert.equal(again.statusCode,200,again.body);
  assert.deepEqual(again.json(),{aiScheduled:false});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[callId])).rows[0].n,1);

  // The AI wins the grace: only now does the call carry the 忙线 AI 代接 label.
  await snapshot(f,{localBusy:true,calls:[{callId,deviceCallId:'s42-busy-call',simId:f.simId,direction:'incoming',state:'ringing'}]});
  const claimed=await claimRun(identity);
  assert.equal(claimed.callId,callId);
  await expireGrace(callId);
  const committed=await commitAnswer(claimed,identity);
  assert.equal(committed.statusCode,200,committed.body);
  const answered=await row(callId);
  assert.equal(answered.answered_by_platform,'ai');
  assert.equal(answered.conflict_disposition,'ai_answered');

  const listed=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(owner.token)});
  const shown=listed.json().items.find((entry:any)=>entry.id===callId);
  assert.equal(shown.conflictDisposition,'ai_answered');
  assert.equal(shown.answerMode,'normal','a normal-mode call must stay unsuppressed on the three clients');
});

test('S42: 忙线上报只对本人的响铃来电生效，其余一律 200 空操作',async()=>{
  const owner=await userFixture('s42-guards');
  const stranger=await userFixture('s42-stranger');
  const f=await gatewayFixture(owner.id,'s42-guards');
  await liveWorker();
  const ringing=await incoming(f,'s42-guard-call');
  assert.equal(ringing.statusCode,201,ringing.body);
  const callId=ringing.json().call.id as string;

  // Another account sees the same 404 the claim / end routes give.
  const denied=await ownerBusy(stranger.token,callId);
  assert.equal(denied.statusCode,404,denied.body);
  assert.equal(denied.json().error.code,'NOT_FOUND');

  (config as any).BUSY_CONFLICT_ENABLED=false;
  try{
    const off=await ownerBusy(owner.token,callId);
    assert.equal(off.statusCode,200,off.body);
    assert.deepEqual(off.json(),{aiScheduled:false});
  }finally{(config as any).BUSY_CONFLICT_ENABLED=true;}
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[callId])).rows[0].n,0);

  // A race the push handler cannot see: the call is already over by the time the report lands.
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[callId]);
  const late=await ownerBusy(owner.token,callId);
  assert.equal(late.statusCode,200,late.body);
  assert.deepEqual(late.json(),{aiScheduled:false});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[callId])).rows[0].n,0);
  assert.equal((await row(callId)).conflict_disposition,null);
});

test('S42: 宽限内人工抢接后 AI 提交被 409 挡住，通话不记 ai_answered',async()=>{
  const owner=await userFixture('s42-race');
  const f=await gatewayFixture(owner.id,'s42-race');
  const identity=await liveWorker();
  const ringing=await incoming(f,'s42-race-call');
  assert.equal(ringing.statusCode,201,ringing.body);
  const callId=ringing.json().call.id as string;
  assert.equal((await ownerBusy(owner.token,callId)).json().aiScheduled,true);
  await snapshot(f,{localBusy:true,calls:[{callId,deviceCallId:'s42-race-call',simId:f.simId,direction:'incoming',state:'ringing'}]});
  const claimed=await claimRun(identity);

  // The owner's other client picks up inside the 5 s grace.
  const human=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/claim`,headers:auth(owner.token),payload:{platform:'android',deviceName:'另一台设备'}});
  assert.equal(human.statusCode,200,human.body);
  await expireGrace(callId);
  const lost=await commitAnswer(claimed,identity);
  // The S22 symmetry is unchanged: `markHumanWinner` voids the lease inside the claim transaction, so
  // the worker is refused at the lease gate (the same 409 family as AI_LOST_RACE) and never answers.
  assert.equal(lost.statusCode,409,lost.body);
  assert.equal(lost.json().error.code,'AI_LEASE_LOST');
  const answered=await row(callId);
  assert.equal(answered.answered_by_platform,'android');
  assert.equal(answered.conflict_disposition,null,'a human winner must never be labelled as AI-answered');
  assert.equal((await runRow(callId)).state,'lost_race');
});

test('S42: 普通 timeout_ai SIM 的 AI 接听不写 conflict_disposition',async()=>{
  const owner=await userFixture('s42-plain-timeout');
  const f=await gatewayFixture(owner.id,'s42-plain-timeout');
  await db.query(`UPDATE sim_settings SET mode='timeout_ai' WHERE sim_id=$1`,[f.simId]);
  const identity=await liveWorker();
  const ringing=await incoming(f,'s42-plain-call');
  assert.equal(ringing.statusCode,201,ringing.body);
  const callId=ringing.json().call.id as string;
  assert.equal((await row(callId)).mode_snapshot,'timeout_ai');
  assert.equal((await runRow(callId)).mode_snapshot,'timeout_ai');

  await snapshot(f,{localBusy:true,calls:[{callId,deviceCallId:'s42-plain-call',simId:f.simId,direction:'incoming',state:'ringing'}]});
  await expireGrace(callId);
  const committed=await commitAnswer(await claimRun(identity),identity);
  assert.equal(committed.statusCode,200,committed.body);
  const answered=await row(callId);
  assert.equal(answered.answered_by_platform,'ai');
  assert.equal(answered.conflict_disposition,null,'an ordinary timeout_ai answer is not a busy conflict');
});

test('S38: the owner dialing his own SIM on another Pixel is not a busy conflict (either number format)',async()=>{
  const owner=await userFixture('s38-self-dial');
  const a=await gatewayFixture(owner.id,'s38-self-dial-a');
  const b=await gatewayFixture(owner.id,'s38-self-dial-b');
  await db.query(`UPDATE sims SET country_iso='CN',phone_label=$2 WHERE id=$1`,[a.simId,'+8618600000001']);
  await db.query(`UPDATE sims SET country_iso='CN',phone_label=$2 WHERE id=$1`,[b.simId,'13300000002']);
  await liveWorker();
  const outgoing=async(remote:string,key:string|null)=>(await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,remote_canonical_key,state,generation,mode_snapshot,started_at)
     VALUES($1,$2,$3,'outgoing',$4,$5,'connecting',$6,'normal',now()) RETURNING id`,
    [a.gatewayId,a.simId,owner.id,remote,key,a.deviceEpoch])).rows[0].id as string;
  const free=async(...ids:string[])=>{
    await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=ANY($1::uuid[])`,[ids]);
    await db.query(`DELETE FROM gateway_call_locks WHERE call_id=ANY($1::uuid[])`,[ids]);
  };

  // Callee key matches B's own number (national phone_label vs +86 dialed).
  const leg1=await outgoing('+8613300000002','+8613300000002');
  const r1=await incoming(b,'self-dial-1',{remoteNumber:'+8618600000001'});
  assert.equal(r1.statusCode,201,r1.body);
  assert.equal(r1.json().disposition,'offer_to_owner');
  const row1=await row(r1.json().call.id);
  assert.equal(row1.mode_snapshot,'normal');
  assert.equal(row1.conflict_disposition,null);
  await free(leg1,r1.json().call.id);

  // B's number unknown: the national caller ID matches A's +86 number instead.
  await db.query(`UPDATE sims SET phone_label=NULL WHERE id=$1`,[b.simId]);
  const leg2=await outgoing('13300000002','+8613300000002');
  const r2=await incoming(b,'self-dial-2',{remoteNumber:'18600000001'});
  assert.equal(r2.statusCode,201,r2.body);
  assert.equal(r2.json().disposition,'offer_to_owner');
  assert.equal((await row(r2.json().call.id)).conflict_disposition,null);
  await free(leg2,r2.json().call.id);

  // An unrelated owner call on A still makes B's incoming call AI-answered.
  await db.query(`UPDATE sims SET phone_label='13300000002' WHERE id=$1`,[b.simId]);
  await outgoing('+8613800000000','+8613800000000');
  const r3=await incoming(b,'self-dial-3',{remoteNumber:'+8615900000000'});
  assert.equal(r3.statusCode,201,r3.body);
  const row3=await row(r3.json().call.id);
  assert.equal(row3.mode_snapshot,'ai');
  assert.equal(row3.conflict_disposition,'ai_answered');
});
