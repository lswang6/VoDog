import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
import {AiRunReconciler} from '../src/ai-runs/reconciler.js';
import {RevokedCallCleanupWorker} from '../src/session-revoked-cleanup.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const serviceToken='ai-internal-test-token-at-least-32-characters';
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'ai-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3299,COMMAND_REPLAY_HORIZON_ENABLED:false,
  AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,AI_MEDIA_NODE_ID:'relay-primary',MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'ai-test-media-secret-at-least-32-chars',TURN_SECRET:'ai-test-turn-secret-at-least-32-chars',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2};
let db:Db,app:FastifyInstance,userId:string,simId:string,gatewayId:string,deviceToken:string,userToken:string,deviceEpoch:number,assignmentVersion:number;
let mediaServer:Server,mediaOfferCount=0,mediaCloseCount=0,lastMediaGrant:any=null;
let mediaOfferHook:(()=>Promise<void>)|null=null;
const worker={instanceId:'00000000-0000-4000-8000-000000000011',bootId:'00000000-0000-4000-8000-000000000012'};
const internal={authorization:`Bearer ${serviceToken}`};
const auth=(token:string)=>({authorization:`Bearer ${token}`});

before(async()=>{
  mediaServer=createServer((req,res)=>{if(req.method==='POST'&&req.url==='/offer'){mediaOfferCount++;lastMediaGrant=JSON.parse(Buffer.from(req.headers.authorization!.slice(7).split('.')[0]!,'base64url').toString());req.resume();req.on('end',async()=>{await mediaOfferHook?.();mediaOfferHook=null;res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'answer',sdp:'test-answer'}));});return;}if(req.method==='POST'&&req.url?.startsWith('/close/')){mediaCloseCount++;req.resume();res.statusCode=204;res.end();return;}res.statusCode=404;res.end();});
  await new Promise<void>((resolve,reject)=>{mediaServer.once('error',reject);mediaServer.listen(0,'127.0.0.1',()=>resolve());});
  const address=mediaServer.address();if(!address||typeof address==='string')throw new Error('media test server did not bind');
  (config as any).MEDIA_NODES_JSON=JSON.stringify([{id:'relay-primary',controlBaseUrl:`http://127.0.0.1:${address.port}`,turnUdpUrl:'turn:turn.test:16801?transport=udp',turnTlsUrl:'turns:turn.test:16802?transport=tcp',mediaSecret:'ai-test-media-secret-at-least-32-chars',turnSecret:'ai-test-turn-secret-at-least-32-chars'}]);
  db=createDb(databaseUrl);await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  const password=await hashPassword('correct horse battery staple');
  userId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('ai-owner@example.test',$1)RETURNING id`,[password])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('ai-gateway',true,true,true,true,now())RETURNING id,device_epoch`)).rows[0];gatewayId=gateway.id;deviceEpoch=Number(gateway.device_epoch);
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'AI SIM',true,$3)RETURNING id,version`,[gatewayId,userId,tokenHash('ai-sim-stable-fingerprint')])).rows[0];simId=sim.id;assignmentVersion=Number(sim.version);
  await db.query(`INSERT INTO sim_settings(sim_id,mode,timeout_seconds)VALUES($1,'ai',45)`,[simId]);
  deviceToken='ai-device-token-at-least-32-characters';await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'ai-test')`,[gatewayId,tokenHash(deviceToken)]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),1,0,false,'[]',now())`,[gatewayId,deviceEpoch]);
  app=await buildApp(db,config);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ai-owner@example.test',password:'correct horse battery staple',platform:'android'}});assert.equal(login.statusCode,200,login.body);userToken=login.json().token;
});
after(async()=>{await app.close();await db.end();await new Promise<void>((resolve,reject)=>mediaServer.close(error=>error?reject(error):resolve()));});

async function heartbeat(identity=worker){const response=await app.inject({method:'POST',url:'/internal/v1/ai/workers/heartbeat',headers:internal,payload:{...identity,protocol:'voice-run-v1',capacity:1}});assert.equal(response.statusCode,200,response.body);}
async function incoming(deviceCallId=crypto.randomUUID()){
  const eventId=crypto.randomUUID(),observedAt=new Date().toISOString();
  const response=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),payload:{eventId,generation:deviceEpoch,deviceCallId,simId,remoteNumber:'+15550176',observedAt}});assert.equal(response.statusCode,201,response.body);
  return{callId:response.json().call.id,eventId,deviceCallId,observedAt,payload:{eventId,generation:deviceEpoch,deviceCallId,simId,remoteNumber:'+15550176',observedAt}};
}
let snapshotSequence=1;
async function snapshot(call:{callId:string;deviceCallId:string},state:'ringing'|'dialing'|'active'='ringing',observedAt=new Date().toISOString()){
  snapshotSequence++;
  const response=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence,generation:deviceEpoch,reportedSequence:0,localBusy:true,confirmedAbsentCallIds:[],calls:[{callId:call.callId,deviceCallId:call.deviceCallId,simId,direction:'incoming',state}],observedAt}});assert.equal(response.statusCode,200,response.body);
}
async function claimRun(identity=worker){const response=await app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:identity});assert.equal(response.statusCode,200,response.body);return response.json().run;}
const leaseHeaders=(token:string)=>({...internal,'x-ai-lease-token':token});
// S94b: list, detail and report must agree on ownerJoinedLocal.
async function ownerJoinedLocalViews(callId:string){
  const list=await app.inject({method:'GET',url:'/api/v1/calls?limit=100',headers:auth(userToken)});assert.equal(list.statusCode,200,list.body);
  const detail=await app.inject({method:'GET',url:`/api/v1/calls/${callId}`,headers:auth(userToken)});assert.equal(detail.statusCode,200,detail.body);
  const report=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=7d&timeZone=UTC',headers:auth(userToken)});assert.equal(report.statusCode,200,report.body);
  return[list.json().items.find((c:any)=>c.id===callId)?.ownerJoinedLocal,detail.json().call.ownerJoinedLocal,report.json().items.find((c:any)=>c.callId===callId)?.ownerJoinedLocal];
}
async function cleanupCall(callId:string){
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[callId]);
  await db.query(`UPDATE ai_call_runs SET state='ended',ended_at=COALESCE(ended_at,now()),lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL WHERE call_id=$1`,[callId]);
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[callId]);
  await db.query(`UPDATE gateway_telecom_snapshots SET local_busy=false,calls='[]',observed_at=now() WHERE gateway_id=$1`,[gatewayId]);
}
async function waitForBlockedQuery(fragment:string){
  for(let attempt=0;attempt<100;attempt++){
    const q=await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE $1 LIMIT 1`,[`%${fragment}%`]);if(q.rowCount)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`query did not block at test barrier: ${fragment}`);
}

test('internal identity is mandatory and dynamic heartbeat gates advertised AI modes',async()=>{
  const denied=await app.inject({method:'POST',url:'/internal/v1/ai/workers/heartbeat',headers:{authorization:'Bearer wrong'},payload:{...worker,protocol:'voice-run-v1',capacity:1}});assert.equal(denied.statusCode,401);assert.equal(denied.json().error.code,'AI_SERVICE_UNAUTHENTICATED');
  const beforeHeartbeat=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(userToken)});assert.deepEqual(beforeHeartbeat.json().items[0].settings.availableModes,['normal']);
  await heartbeat();const ready=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(userToken)});assert.deepEqual(ready.json().items[0].settings.availableModes,['normal','ai','timeout_ai']);
});

test('incoming freezes settings and assignment once and exact replay creates no second run',async()=>{
  const call=await incoming();const replay=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),payload:call.payload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().call.id,call.callId);
  const row=(await db.query(`SELECT mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,ai_run_id FROM call_records WHERE id=$1`,[call.callId])).rows[0];
  assert.equal(row.mode_snapshot,'ai');assert.equal(Number(row.settings_version_snapshot),1);assert.equal(Number(row.assignment_version_snapshot),assignmentVersion);assert.equal(Number(row.timeout_seconds_snapshot),45);assert.ok(row.ai_run_id);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[call.callId])).rows[0].n,1);
  await cleanupCall(call.callId);
});

test('one worker lease wins, renew is CAS fenced, and pre-answer expiry never answers',async()=>{
  const call=await incoming();const second={instanceId:'00000000-0000-4000-8000-000000000021',bootId:'00000000-0000-4000-8000-000000000022'};await heartbeat(second);
  const [a,b]=await Promise.all([app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:worker}),app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:second})]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,204]);const run=[a,b].find(value=>value.statusCode===200)!.json().run,identity=a.statusCode===200?worker:second;
  const wrong=await app.inject({method:'PUT',url:`/internal/v1/ai/runs/${run.id}/lease`,headers:leaseHeaders('wrong-token-that-is-long-enough-000000'),payload:identity});assert.equal(wrong.statusCode,409);assert.equal(wrong.json().error.code,'AI_LEASE_LOST');
  await db.query(`UPDATE ai_call_runs SET lease_until=now()-interval '1 second' WHERE id=$1`,[run.id]);const reconciler=new AiRunReconciler(db,{intervalMs:60_000});assert.equal(await reconciler.tickOnce(),1);
  const state=(await db.query(`SELECT state,answer_command_id FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0];assert.equal(state.state,'pending');assert.equal(state.answer_command_id,null);
  await cleanupCall(call.callId);
});

test('commit response replay cannot create a second answer and ACK alone never opens audio',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const request={method:'POST' as const,url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker};
  const first=await app.inject(request);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().replayed,false);
  const replay=await app.inject(request);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);assert.equal(replay.json().command.id,first.json().command.id);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[call.callId])).rows[0].n,1);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${first.json().command.id}/ack`,headers:auth(deviceToken),payload:{generation:deviceEpoch,status:'acked'}});assert.equal(ack.statusCode,200,ack.body);
  const pending=await app.inject({method:'GET',url:`/internal/v1/ai/runs/${run.id}?instanceId=${worker.instanceId}&bootId=${worker.bootId}`,headers:leaseHeaders(run.leaseToken)});assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().audioAllowed,false);assert.equal(pending.json().run.state,'awaiting_active');
  const active=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'active'}});assert.equal(active.statusCode,200,active.body);
  const status=await app.inject({method:'GET',url:`/internal/v1/ai/runs/${run.id}?instanceId=${worker.instanceId}&bootId=${worker.bootId}`,headers:leaseHeaders(run.leaseToken)});assert.equal(status.statusCode,200,status.body);assert.equal(status.json().audioAllowed,true);assert.equal(status.json().run.state,'active');
  await cleanupCall(call.callId);
});

test('rejected AI answer restores ringing only with fresh current-epoch proof and never retries that run',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  await snapshot(call,'ringing');const rejected=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${committed.json().command.id}/ack`,headers:auth(deviceToken),payload:{generation:deviceEpoch,status:'rejected',telecomState:'RINGING',result:{reason:'not_executed'}}});assert.equal(rejected.statusCode,200,rejected.body);
  const restored=(await db.query(`SELECT state,answered_by_platform,ai_run_id FROM call_records WHERE id=$1`,[call.callId])).rows[0];assert.equal(restored.state,'incoming_ringing');assert.equal(restored.answered_by_platform,null);assert.equal(restored.ai_run_id,null);
  assert.equal((await db.query(`SELECT state FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0].state,'failed_before_answer');
  const human=await app.inject({method:'POST',url:`/api/v1/calls/${call.callId}/claim`,headers:auth(userToken),payload:{platform:'android',deviceName:'human'}});assert.equal(human.statusCode,200,human.body);assert.equal(human.json().call.gatewayKind,'pixel');
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[call.callId])).rows[0].n,2);
  await cleanupCall(call.callId);
});

test('onlyIfRinging decline races atomically and never hangs up a human winner',async()=>{
  for(let index=0;index<10;index++){
    const call=await incoming();await snapshot(call);
    const [claim,decline]=await Promise.all([
      app.inject({method:'POST',url:`/api/v1/calls/${call.callId}/claim`,headers:auth(userToken),payload:{platform:'android',deviceName:'winner'}}),
      app.inject({method:'POST',url:`/api/v1/calls/${call.callId}/end`,headers:auth(userToken),payload:{onlyIfRinging:true}}),
    ]);
    assert.equal([claim.statusCode,decline.statusCode].filter(code=>code===409).length,1,`${claim.body} ${decline.body}`);
    const kinds=(await db.query(`SELECT kind FROM commands WHERE call_id=$1 ORDER BY sequence`,[call.callId])).rows.map(row=>row.kind);
    if(claim.statusCode===200){assert.equal(decline.json().error.code,'CALL_NOT_RINGING');assert.deepEqual(kinds,['answer']);assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[call.callId])).rows[0].state,'connecting');}
    else{assert.equal(claim.json().error.code,'ALREADY_CLAIMED');assert.equal(decline.statusCode,202,decline.body);assert.deepEqual(kinds,['hangup']);}
    await cleanupCall(call.callId);
  }
});

test('post-answer failure remains cleanup-eligible when feature flags are off and keeps the busy lock',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  const failed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/fail`,headers:leaseHeaders(run.leaseToken),payload:{...worker,code:'provider_disconnected'}});assert.equal(failed.statusCode,200,failed.body);
  const reconciler=new AiRunReconciler(db,{intervalMs:60_000,onlineSeconds:30});assert.equal(await reconciler.tickOnce(),1);
  const state=(await db.query(`SELECT call.state,run.state run_state,run.hangup_command_id FROM call_records call JOIN ai_call_runs run ON run.call_id=call.id WHERE call.id=$1`,[call.callId])).rows[0];assert.equal(state.state,'ending');assert.equal(state.run_state,'ending');assert.ok(state.hangup_command_id);
  assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[call.callId])).rows[0].n,1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[call.callId])).rows[0].n,1);
  await cleanupCall(call.callId);
});

test('AI cleanup follows a fresh exact call across a device epoch without reviving AI authority',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  const failed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/fail`,headers:leaseHeaders(run.leaseToken),payload:{...worker,code:'worker_disconnected'}});assert.equal(failed.statusCode,200,failed.body);
  const nextEpoch=deviceEpoch+1;
  await db.query(`UPDATE gateways SET device_epoch=$2,last_seen_at=now(),control_enabled=true,telephony_ready=true WHERE id=$1`,[gatewayId,nextEpoch]);
  await db.query(`UPDATE gateway_telecom_snapshots SET generation=$2,snapshot_id=gen_random_uuid(),snapshot_sequence=1,calls=$3,local_busy=true,observed_at=now() WHERE gateway_id=$1`,[gatewayId,nextEpoch,JSON.stringify([{callId:call.callId,deviceCallId:call.deviceCallId,simId,direction:'incoming',state:'active'}])]);
  const reconciler=new AiRunReconciler(db,{intervalMs:60_000,onlineSeconds:30});assert.equal(await reconciler.tickOnce(),1);
  const state=(await db.query(`SELECT call.generation,lock.generation lock_generation,run.device_generation,run.state,cmd.generation command_generation
    FROM call_records call JOIN gateway_call_locks lock ON lock.call_id=call.id JOIN ai_call_runs run ON run.call_id=call.id JOIN commands cmd ON cmd.id=run.hangup_command_id WHERE call.id=$1`,[call.callId])).rows[0];
  assert.equal(Number(state.generation),nextEpoch);assert.equal(Number(state.lock_generation),nextEpoch);assert.equal(Number(state.command_generation),nextEpoch);assert.equal(Number(state.device_generation),deviceEpoch);assert.equal(state.state,'ending');
  await cleanupCall(call.callId);await db.query(`UPDATE gateways SET device_epoch=$2 WHERE id=$1`,[gatewayId,deviceEpoch]);
});

test('AI media offer is single-attempt and a replay closes media and enters cleanup',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  const options=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/media/options`,headers:leaseHeaders(run.leaseToken),payload:{...worker,transport:'udp'}});assert.equal(options.statusCode,200,options.body);assert.equal(options.json().mediaNodeId,'relay-primary');assert.equal(options.json().iceTransportPolicy,'relay');assert.equal(options.json().iceServers.length,1);
  const initialOffers=mediaOfferCount,initialCloses=mediaCloseCount;
  const offerPayload={...worker,type:'offer',sdp:'test-offer'};
  const first=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/media/offer`,headers:leaseHeaders(run.leaseToken),payload:offerPayload});assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json(),{type:'answer',sdp:'test-answer'});assert.equal(lastMediaGrant.role,'client');assert.equal('replace' in lastMediaGrant,false);assert.equal(mediaOfferCount,initialOffers+1);
  let offerRows:any[]=[];for(let i=0;i<40&&!offerRows.length;i++){offerRows=(await db.query(`SELECT call_id,fields FROM diag_events WHERE event='media.offer' AND fields->>'runId'=$1`,[run.id])).rows;if(!offerRows.length)await new Promise(r=>setTimeout(r,50));}
  assert.equal(offerRows.length,1);assert.equal(offerRows[0].call_id,call.callId);assert.equal(offerRows[0].fields.leg,'ai');assert.equal(offerRows[0].fields.nodeId,'relay-primary');assert.ok(offerRows[0].fields.nodeReason);
  const replay=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/media/offer`,headers:leaseHeaders(run.leaseToken),payload:offerPayload});assert.equal(replay.statusCode,409,replay.body);assert.equal(replay.json().error.code,'AI_MEDIA_ALREADY_ATTEMPTED');assert.equal(mediaOfferCount,initialOffers+1);assert.equal(mediaCloseCount,initialCloses+1);
  const state=(await db.query(`SELECT call.state,run.state run_state,run.cleanup_required FROM call_records call JOIN ai_call_runs run ON run.call_id=call.id WHERE call.id=$1`,[call.callId])).rows[0];assert.equal(state.state,'ending');assert.equal(state.run_state,'ending');assert.equal(state.cleanup_required,true);
  await cleanupCall(call.callId);
});

test('AI media offer closes the bridge when authority is lost during signaling',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  const initialOffers=mediaOfferCount,initialCloses=mediaCloseCount;mediaOfferHook=async()=>{await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[call.callId]);};
  const offer=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/media/offer`,headers:leaseHeaders(run.leaseToken),payload:{...worker,type:'offer',sdp:'race-offer'}});
  assert.equal(offer.statusCode,409,offer.body);assert.equal(offer.json().error.code,'AI_MEDIA_REVOKED');assert.equal(mediaOfferCount,initialOffers+1);assert.equal(mediaCloseCount,initialCloses+1);
  assert.equal((await db.query(`SELECT cleanup_required FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0].cleanup_required,true);await cleanupCall(call.callId);
});

test('one worker boot cannot hold two live leases across concurrent claims',async()=>{
  await heartbeat();const first=await incoming();
  const secondGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('ai-gateway-2',true,true,true,true,now())RETURNING id,device_epoch`)).rows[0];
  const secondSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'AI SIM 2',true,$3)RETURNING id,version`,[secondGateway.id,userId,tokenHash('ai-sim-second-fingerprint')])).rows[0];
  const secondCall=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,device_call_id,observed_at,started_at,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,ai_trigger_at)
    VALUES($1,$2,$3,'incoming','+15550177','incoming_ringing',$4,'ai','second-device-call',now(),now(),1,$5,45,now()) RETURNING id`,[secondGateway.id,secondSim.id,userId,secondGateway.device_epoch,secondSim.version])).rows[0];
  const secondRun=(await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
    VALUES($1,$2,$3,$4,1,'ai',1,$5,45,now()) RETURNING id`,[secondCall.id,secondGateway.id,userId,secondGateway.device_epoch,secondSim.version])).rows[0];
  await db.query(`UPDATE call_records SET ai_run_id=$2 WHERE id=$1`,[secondCall.id,secondRun.id]);
  const [a,b]=await Promise.all([
    app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:worker}),
    app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:worker}),
  ]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,204]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE lease_owner=$1 AND lease_boot_id=$2 AND lease_until>now()`,[worker.instanceId,worker.bootId])).rows[0].n,1);
  await cleanupCall(first.callId);await cleanupCall(secondCall.id);
});

test('worker heartbeat expiry revokes audio and boot replacement fences answer commit',async()=>{
  await heartbeat();const activeCall=await incoming();await snapshot(activeCall);const activeRun=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${activeRun.id}/commit-answer`,headers:leaseHeaders(activeRun.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[activeCall.callId]);await db.query(`UPDATE ai_call_runs SET state='active' WHERE id=$1`,[activeRun.id]);
  await db.query(`UPDATE ai_worker_instances SET expires_at=now()-interval '1 second' WHERE instance_id=$1`,[worker.instanceId]);
  const staleAudio=await app.inject({method:'GET',url:`/internal/v1/ai/runs/${activeRun.id}?instanceId=${worker.instanceId}&bootId=${worker.bootId}`,headers:leaseHeaders(activeRun.leaseToken)});assert.equal(staleAudio.statusCode,200,staleAudio.body);assert.equal(staleAudio.json().audioAllowed,false);
  await cleanupCall(activeCall.callId);

  await heartbeat();const fencedCall=await incoming();await snapshot(fencedCall);const fencedRun=await claimRun();
  const replacement={instanceId:worker.instanceId,bootId:'00000000-0000-4000-8000-000000000099'};await heartbeat(replacement);
  const fenced=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${fencedRun.id}/commit-answer`,headers:leaseHeaders(fencedRun.leaseToken),payload:worker});assert.equal(fenced.statusCode,409,fenced.body);assert.equal(fenced.json().error.code,'AI_WORKER_STALE');
  await cleanupCall(fencedCall.callId);await heartbeat();
});

test('reconciler rechecks due state after selection and does not clean a renewed lease',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[call.callId]);await db.query(`UPDATE ai_call_runs SET state='active',lease_until=now()-interval '1 second',next_attempt_at=NULL WHERE id=$1`,[run.id]);
  const reconciler=new AiRunReconciler(db,{intervalMs:60_000,beforeProcess:async selected=>{if(selected===run.id)await db.query(`UPDATE ai_call_runs SET lease_until=now()+interval '10 seconds' WHERE id=$1`,[selected]);}});
  assert.equal(await reconciler.tickOnce(),0);
  const state=(await db.query(`SELECT state,hangup_command_id,failure_code FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0];assert.equal(state.state,'active');assert.equal(state.hangup_command_id,null);assert.equal(state.failure_code,null);
  await cleanupCall(call.callId);
});

test('reconciler persists one row error and continues later due work',async()=>{
  const ids:string[]=[];
  for(let index=0;index<2;index++){
    const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[`reconcile-gateway-${index}`])).rows[0];
    const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id,version`,[gateway.id,userId,`reconcile-sim-${index}`,tokenHash(`reconcile-sim-${index}`)])).rows[0];
    const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,device_call_id,observed_at,started_at,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,ai_trigger_at)
      VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'ai',$5,now(),now(),1,$6,45,now()) RETURNING id`,[gateway.id,sim.id,userId,gateway.device_epoch,`reconcile-call-${index}`,sim.version])).rows[0];
    const run=(await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
      VALUES($1,$2,$3,$4,1,'ai',1,$5,45,now()) RETURNING id`,[call.id,gateway.id,userId,gateway.device_epoch,sim.version])).rows[0];
    await db.query(`UPDATE call_records SET ai_run_id=$2 WHERE id=$1`,[call.id,run.id]);ids.push(run.id);
  }
  await db.query(`UPDATE ai_call_runs SET state='preparing',attempts=1,lease_owner=$2,lease_boot_id=$3,lease_hash='expired-hash',lease_until=now()-interval '2 seconds',next_attempt_at=now()-interval '10 seconds' WHERE id=ANY($1::uuid[])`,[ids,worker.instanceId,worker.bootId]);
  const reconciler=new AiRunReconciler(db,{intervalMs:60_000,batch:10,beforeProcess:async selected=>{if(selected===ids[0])throw new Error('deterministic test failure');}});
  assert.equal(await reconciler.tickOnce(),1);
  const rows=(await db.query(`SELECT id,state,failure_code,next_attempt_at>now() delayed FROM ai_call_runs WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)`,[ids])).rows;
  assert.equal(rows[0].state,'preparing');assert.equal(rows[0].failure_code,'reconciler_error');assert.equal(rows[0].delayed,true);
  assert.equal(rows[1].state,'pending');assert.equal(rows[1].failure_code,'lease_expired_before_answer');
  for(const id of ids){const callId=(await db.query(`SELECT call_id FROM ai_call_runs WHERE id=$1`,[id])).rows[0].call_id;await cleanupCall(callId);}
});

test('native logout preserves live hangup and durably retries after offline expiry',async()=>{
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ai-owner@example.test',password:'correct horse battery staple',platform:'android'}});assert.equal(login.statusCode,200,login.body);const token=login.json().token;
  const session=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(token)])).rows[0].id;
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,originating_session_id,originating_platform,device_call_id,answered_at)
    VALUES($1,$2,$3,'outgoing','active',$4,'normal',$5,'android','logout-device-call',now()) RETURNING id`,[gatewayId,simId,userId,deviceEpoch,session])).rows[0];
  await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[gatewayId,call.id,deviceEpoch]);
  const sequence=Number((await db.query(`UPDATE gateways SET command_sequence=command_sequence+1,last_seen_at=now()-interval '1 hour' WHERE id=$1 RETURNING command_sequence`,[gatewayId])).rows[0].command_sequence);
  const existing=(await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)VALUES($1,$2,$3,$4,'hangup',$5,now()+interval '15 seconds')RETURNING id`,[gatewayId,call.id,deviceEpoch,sequence,JSON.stringify({callId:call.id,deviceCallId:'logout-device-call'})])).rows[0].id;
  await db.query(`UPDATE gateway_telecom_snapshots SET generation=$2,calls=$3,local_busy=true,observed_at=now() WHERE gateway_id=$1`,[gatewayId,deviceEpoch,JSON.stringify([{callId:call.id,deviceCallId:'logout-device-call',simId,direction:'outgoing',state:'active'}])]);
  const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:auth(token)});assert.equal(logout.statusCode,204,logout.body);
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`,[existing])).rows[0].status,'pending');
  assert.equal((await db.query(`SELECT state FROM session_revoked_call_cleanups WHERE call_id=$1`,[call.id])).rows[0].state,'pending');
  const workerCleanup=new RevokedCallCleanupWorker(db,{intervalMs:60_000,onlineSeconds:30});
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[existing]);assert.equal(await workerCleanup.tickOnce(),1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[call.id])).rows[0].n,1);
  await db.query(`UPDATE gateways SET last_seen_at=now(),control_enabled=true,telephony_ready=true WHERE id=$1`,[gatewayId]);await db.query(`UPDATE gateway_telecom_snapshots SET observed_at=now() WHERE gateway_id=$1`,[gatewayId]);await db.query(`UPDATE session_revoked_call_cleanups SET next_attempt_at=now() WHERE call_id=$1`,[call.id]);
  assert.equal(await workerCleanup.tickOnce(),1);const commands=await db.query(`SELECT status FROM commands WHERE call_id=$1 AND kind='hangup' ORDER BY sequence`,[call.id]);assert.deepEqual(commands.rows.map(row=>row.status),['expired','pending']);
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[call.id]);await db.query(`UPDATE session_revoked_call_cleanups SET next_attempt_at=now() WHERE call_id=$1`,[call.id]);assert.equal(await workerCleanup.tickOnce(),1);assert.equal((await db.query(`SELECT state FROM session_revoked_call_cleanups WHERE call_id=$1`,[call.id])).rows[0].state,'done');
  await cleanupCall(call.id);
});

test('session row serializes logout against outbound in both transaction orders',async()=>{
  await db.query(`UPDATE gateways SET last_seen_at=now(),control_enabled=true,telephony_ready=true,media_ready=true WHERE id=$1`,[gatewayId]);await db.query(`UPDATE gateway_telecom_snapshots SET generation=$2,local_busy=false,calls='[]',observed_at=now() WHERE gateway_id=$1`,[gatewayId,deviceEpoch]);
  const firstLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ai-owner@example.test',password:'correct horse battery staple',platform:'android'}});const firstToken=firstLogin.json().token,firstSession=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(firstToken)])).rows[0].id;
  const sessionLock=await db.connect();await sessionLock.query('BEGIN');await sessionLock.query(`SELECT id FROM sessions WHERE id=$1 FOR UPDATE`,[firstSession]);
  const blockedOutbound=app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(firstToken),'idempotency-key':crypto.randomUUID()},payload:{simId,remoteNumber:'+15550101'}});
  await waitForBlockedQuery('SELECT 1 FROM sessions WHERE id=');await sessionLock.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`,[firstSession]);await sessionLock.query('COMMIT');sessionLock.release();
  const denied=await blockedOutbound;assert.equal(denied.statusCode,401,denied.body);assert.equal(denied.json().error.code,'SESSION_REVOKED');
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE originating_session_id=$1`,[firstSession])).rows[0].n,0);

  const secondLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ai-owner@example.test',password:'correct horse battery staple',platform:'android'}});const secondToken=secondLogin.json().token,secondSession=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(secondToken)])).rows[0].id;
  const gatewayLock=await db.connect();await gatewayLock.query('BEGIN');await gatewayLock.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[gatewayId]);
  const winningOutbound=app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(secondToken),'idempotency-key':crypto.randomUUID()},payload:{simId,remoteNumber:'+15550102'}});
  await waitForBlockedQuery('SELECT id FROM gateways WHERE id=');const logout=app.inject({method:'POST',url:'/api/v1/auth/logout',headers:auth(secondToken)});
  await gatewayLock.query('COMMIT');gatewayLock.release();
  const created=await winningOutbound;assert.equal(created.statusCode,202,created.body);const loggedOut=await logout;assert.equal(loggedOut.statusCode,204,loggedOut.body);
  const callId=created.json().call.id;assert.equal((await db.query(`SELECT count(*)::int n FROM session_revoked_call_cleanups WHERE call_id=$1 AND session_id=$2 AND state='pending'`,[callId,secondSession])).rows[0].n,1);
  await cleanupCall(callId);
});

test('session row serializes logout against incoming claim in both transaction orders',async()=>{
  const firstCall=await incoming();await snapshot(firstCall);
  const firstLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ai-owner@example.test',password:'correct horse battery staple',platform:'android'}});const firstToken=firstLogin.json().token,firstSession=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(firstToken)])).rows[0].id;
  const sessionLock=await db.connect();await sessionLock.query('BEGIN');await sessionLock.query(`SELECT id FROM sessions WHERE id=$1 FOR UPDATE`,[firstSession]);
  const blockedClaim=app.inject({method:'POST',url:`/api/v1/calls/${firstCall.callId}/claim`,headers:auth(firstToken),payload:{platform:'android',deviceName:'late claimant'}});
  await waitForBlockedQuery('SELECT 1 FROM sessions WHERE id=');await sessionLock.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`,[firstSession]);await sessionLock.query('COMMIT');sessionLock.release();
  const denied=await blockedClaim;assert.equal(denied.statusCode,401,denied.body);assert.equal(denied.json().error.code,'SESSION_REVOKED');assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[firstCall.callId])).rows[0].n,0);await cleanupCall(firstCall.callId);

  const secondCall=await incoming();await snapshot(secondCall);const secondLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ai-owner@example.test',password:'correct horse battery staple',platform:'android'}});const secondToken=secondLogin.json().token,secondSession=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(secondToken)])).rows[0].id;
  const gatewayLock=await db.connect();await gatewayLock.query('BEGIN');await gatewayLock.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[gatewayId]);
  const winningClaim=app.inject({method:'POST',url:`/api/v1/calls/${secondCall.callId}/claim`,headers:auth(secondToken),payload:{platform:'android',deviceName:'winner'}});
  await waitForBlockedQuery('SELECT id FROM gateways WHERE id=');const logout=app.inject({method:'POST',url:'/api/v1/auth/logout',headers:auth(secondToken)});await gatewayLock.query('COMMIT');gatewayLock.release();
  const claimed=await winningClaim;assert.equal(claimed.statusCode,200,claimed.body);const loggedOut=await logout;assert.equal(loggedOut.statusCode,204,loggedOut.body);
  assert.equal((await db.query(`SELECT count(*)::int n FROM session_revoked_call_cleanups WHERE call_id=$1 AND session_id=$2 AND state='pending'`,[secondCall.callId,secondSession])).rows[0].n,1);await cleanupCall(secondCall.callId);
});

test('the realtime transcript needs the service token and the run lease, and replays without duplicating',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const at=new Date().toISOString();
  const items=[{role:'ai',sequence:0,text:'你好，我是 AI 助理',at},{role:'caller',sequence:1,text:'我找王先生',at}];
  const url=`/internal/v1/ai/runs/${run.id}/transcript`;
  const noService=await app.inject({method:'POST',url,headers:{authorization:'Bearer wrong','x-ai-lease-token':run.leaseToken},payload:{...worker,items}});
  assert.equal(noService.statusCode,401);assert.equal(noService.json().error.code,'AI_SERVICE_UNAUTHENTICATED');
  const noLease=await app.inject({method:'POST',url,headers:internal,payload:{...worker,items}});
  assert.equal(noLease.statusCode,401);assert.equal(noLease.json().error.code,'AI_LEASE_REQUIRED');
  const wrongLease=await app.inject({method:'POST',url,headers:leaseHeaders('wrong-token-that-is-long-enough-000000'),payload:{...worker,items}});
  assert.equal(wrongLease.statusCode,409);assert.equal(wrongLease.json().error.code,'AI_LEASE_LOST');

  const stored=await app.inject({method:'POST',url,headers:leaseHeaders(run.leaseToken),payload:{...worker,items}});
  assert.equal(stored.statusCode,200,stored.body);
  assert.deepEqual(stored.json(),{accepted:true,stored:2});
  // The sequence is one monotonic counter across both roles, so a replayed batch is absorbed.
  const replay=await app.inject({method:'POST',url,headers:leaseHeaders(run.leaseToken),payload:{...worker,items}});
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),{accepted:true,stored:0});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_run_transcripts WHERE run_id=$1`,[run.id])).rows[0].n,2);
  const badRole=await app.inject({method:'POST',url,headers:leaseHeaders(run.leaseToken),payload:{...worker,items:[{role:'system',sequence:2,text:'x',at}]}});
  assert.equal(badRole.statusCode,400,badRole.body);
  const empty=await app.inject({method:'POST',url,headers:leaseHeaders(run.leaseToken),payload:{...worker,items:[]}});
  assert.equal(empty.statusCode,400,empty.body);

  const owner=await app.inject({method:'GET',url:`/api/v1/calls/${call.callId}/ai-transcript`,headers:auth(userToken)});
  assert.equal(owner.statusCode,200,owner.body);
  assert.deepEqual(owner.json().items.map((item:any)=>[item.role,item.text]),[['ai','你好，我是 AI 助理'],['caller','我找王先生']]);
  const anonymous=await app.inject({method:'GET',url:`/api/v1/calls/${call.callId}/ai-transcript`});
  assert.equal(anonymous.statusCode,401);
  const unknown=await app.inject({method:'GET',url:`/api/v1/calls/${crypto.randomUUID()}/ai-transcript`,headers:auth(userToken)});
  assert.equal(unknown.statusCode,404);
  await cleanupCall(call.callId);
});

/**
 * S27 失败记录 6. The Voice worker flushes its last transcript batch in its `finally` block, i.e. after
 * Control has already observed the hangup. Both hangup paths therefore keep the lease identity.
 */
test('the caller hangup keeps the run identity so the worker last transcript batch still lands',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  // The real hangup path, not raw SQL: the gateway call-events route runs `observeAiCallState(...,'ended')`.
  const hangup=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'ended'}});
  assert.equal(hangup.statusCode,200,hangup.body);
  const row=(await db.query(`SELECT state,ended_at,lease_owner,lease_boot_id,lease_hash,lease_until FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0];
  assert.equal(row.state,'ended');assert.ok(row.ended_at,'the grace predicate needs ended_at');assert.equal(row.lease_until,null,'the lease itself must be dead immediately');
  assert.equal(row.lease_owner,worker.instanceId);assert.equal(row.lease_boot_id,worker.bootId);assert.ok(row.lease_hash);
  // Only the transcript endpoint is relaxed: the worker still learns the call is over from this 409.
  const read=await app.inject({method:'GET',url:`/internal/v1/ai/runs/${run.id}?instanceId=${worker.instanceId}&bootId=${worker.bootId}`,headers:leaseHeaders(run.leaseToken)});
  assert.equal(read.statusCode,409,read.body);assert.equal(read.json().error.code,'AI_LEASE_LOST');
  const at=new Date().toISOString();
  const tail=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/transcript`,headers:leaseHeaders(run.leaseToken),
    payload:{...worker,items:[{role:'caller',sequence:0,text:'运单号是 SF1234567890',at},{role:'ai',sequence:1,text:'好的，我记下了',at}]}});
  assert.equal(tail.statusCode,200,tail.body);assert.deepEqual(tail.json(),{accepted:true,stored:2});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_run_transcripts WHERE run_id=$1`,[run.id])).rows[0].n,2);
  // A kept identity must never read as a live lease: the claim path only ever counts `lease_until>now()`.
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE lease_owner=$1 AND lease_boot_id=$2 AND lease_until>now()`,[worker.instanceId,worker.bootId])).rows[0].n,0);
  const owner=await app.inject({method:'GET',url:`/api/v1/calls/${call.callId}/ai-transcript`,headers:auth(userToken)});
  assert.deepEqual(owner.json().items.map((item:any)=>item.role),['caller','ai']);
  await cleanupCall(call.callId);
});

test('the reconciler hangup path keeps the same identity and accepts the late batch too',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  // The reconciler only selects a `preparing` run once its lease is due, so expire it before the tick.
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[call.callId]);
  await db.query(`UPDATE ai_call_runs SET lease_until=now()-interval '1 second' WHERE id=$1`,[run.id]);
  const reconciler=new AiRunReconciler(db,{intervalMs:60_000,onlineSeconds:30});assert.equal(await reconciler.tickOnce(),1);
  const row=(await db.query(`SELECT state,ended_at,lease_owner,lease_boot_id,lease_until FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0];
  assert.equal(row.state,'ended');assert.ok(row.ended_at);assert.equal(row.lease_until,null);
  assert.equal(row.lease_owner,worker.instanceId);assert.equal(row.lease_boot_id,worker.bootId);
  const at=new Date().toISOString();
  const tail=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/transcript`,headers:leaseHeaders(run.leaseToken),payload:{...worker,items:[{role:'ai',sequence:0,text:'再见',at}]}});
  assert.equal(tail.statusCode,200,tail.body);assert.deepEqual(tail.json(),{accepted:true,stored:1});
  await cleanupCall(call.callId);
});

/**
 * S94b 死锁. The late transcript batch used to INSERT outside any transaction, so its FK checks took
 * `FOR KEY SHARE` on the run and then the call — the reverse of the hangup/reconciler order
 * (gateway → call → run, `FOR UPDATE`). Hold the first two locks of that order, let the batch block,
 * then take the run lock: in the canonical order the batch simply waits, it never deadlocks.
 */
test('a late transcript batch waits behind a hangup that holds gateway and call locks instead of deadlocking',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const hangup=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'ended'}});
  assert.equal(hangup.statusCode,200,hangup.body);
  const holder=await db.connect();
  try{
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[gatewayId]);
    await holder.query(`SELECT id FROM call_records WHERE id=$1 FOR UPDATE`,[call.callId]);
    const at=new Date().toISOString();
    const tail=app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/transcript`,headers:leaseHeaders(run.leaseToken),payload:{...worker,items:[{role:'ai',sequence:0,text:'再见',at}]}});
    // Either the explicit call lock (fixed order) or the INSERT's FK check (old order) must be waiting on us.
    let blocked=false;
    for(let attempt=0;attempt<200&&!blocked;attempt++){
      blocked=Boolean((await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
        AND (query ILIKE '%FROM call_records WHERE id=$1 FOR KEY SHARE%' OR query ILIKE '%INSERT INTO ai_run_transcripts%') LIMIT 1`)).rowCount);
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(blocked,'the transcript batch never blocked on the held call lock');
    // The hangup path's third lock. With the old run→call order this is where Postgres reported 40P01.
    await holder.query(`SELECT id FROM ai_call_runs WHERE id=$1 FOR UPDATE`,[run.id]);
    await holder.query('COMMIT');
    const response=await tail;
    assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{accepted:true,stored:1});
    // diag is fire-and-forget; give a retry's row time to land so a hidden deadlock cannot pass as a 200.
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal((await db.query(`SELECT count(*)::int n FROM diag_events WHERE event='db.deadlock_retry' AND fields->>'label'='ai.transcript'`)).rows[0].n,0,'the canonical order must not need the retry');
  }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await cleanupCall(call.callId);}
});

test('the transcript grace window closes after 60 s and never accepts another worker identity',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const hangup=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'ended'}});
  assert.equal(hangup.statusCode,200,hangup.body);
  const at=new Date().toISOString(),url=`/internal/v1/ai/runs/${run.id}/transcript`,items=[{role:'caller',sequence:0,text:'迟到的尾巴',at}];
  const wrongToken=await app.inject({method:'POST',url,headers:leaseHeaders('wrong-token-that-is-long-enough-000000'),payload:{...worker,items}});
  assert.equal(wrongToken.statusCode,409,wrongToken.body);assert.equal(wrongToken.json().error.code,'AI_LEASE_LOST');
  const stranger=await app.inject({method:'POST',url,headers:leaseHeaders(run.leaseToken),payload:{instanceId:'00000000-0000-4000-8000-000000000031',bootId:worker.bootId,items}});
  assert.equal(stranger.statusCode,409,stranger.body);assert.equal(stranger.json().error.code,'AI_LEASE_LOST');
  // S75: each refusal files ai.lease_lost naming the failed check, with the call already ended.
  for(const check of ['token','owner']){
    let rows:any[]=[];
    for(let i=0;i<40&&!rows.length;i++){rows=(await db.query(`SELECT call_id,level,fields FROM diag_events WHERE event='ai.lease_lost' AND fields->>'runId'=$1 AND fields->>'check'=$2`,[run.id,check])).rows;if(!rows.length)await new Promise(r=>setTimeout(r,50));}
    assert.equal(rows.length,1,check);assert.equal(rows[0].call_id,call.callId);assert.equal(rows[0].level,'warn');
    assert.equal(rows[0].fields.callState,'ended');assert.ok(rows[0].fields.runState);assert.equal(JSON.stringify(rows[0].fields).includes(run.leaseToken),false);
  }
  await db.query(`UPDATE ai_call_runs SET ended_at=now()-interval '2 minutes' WHERE id=$1`,[run.id]);
  const expired=await app.inject({method:'POST',url,headers:leaseHeaders(run.leaseToken),payload:{...worker,items}});
  assert.equal(expired.statusCode,409,expired.body);assert.equal(expired.json().error.code,'AI_LEASE_LOST');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_run_transcripts WHERE run_id=$1`,[run.id])).rows[0].n,0);
  await cleanupCall(call.callId);
});

test('a single unready heartbeat never revokes AI audio authority; three beats or a sustained 15 s does',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  // S22 decision 9: the gateway learns an AI leg is answering so it can widen its audio prebuffer.
  assert.deepEqual((await db.query(`SELECT payload FROM commands WHERE id=$1`,[committed.json().command.id])).rows[0].payload,
    {callId:call.callId,deviceCallId:call.deviceCallId,answeredBy:'ai'});
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${committed.json().command.id}/ack`,headers:auth(deviceToken),payload:{generation:deviceEpoch,status:'acked'}});assert.equal(ack.statusCode,200,ack.body);
  const active=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'active'}});assert.equal(active.statusCode,200,active.body);
  const read=async()=>{
    const response=await app.inject({method:'GET',url:`/internal/v1/ai/runs/${run.id}?instanceId=${worker.instanceId}&bootId=${worker.bootId}`,headers:leaseHeaders(run.leaseToken)});
    assert.equal(response.statusCode,200,response.body);return response.json().audioAllowed;
  };
  const media=async(request:{ready:boolean;since:string|null;beats:number})=>db.query(
    `UPDATE gateways SET media_ready=$2,media_unready_since=$3::timestamptz,media_unready_heartbeats=$4 WHERE id=$1`,[gatewayId,request.ready,request.since,request.beats]);
  const telephony=async(request:{ready:boolean;since:string|null;beats:number})=>db.query(
    `UPDATE gateways SET telephony_ready=$2,telephony_unready_since=$3::timestamptz,telephony_unready_heartbeats=$4 WHERE id=$1`,[gatewayId,request.ready,request.since,request.beats]);
  assert.equal(await read(),true);
  await media({ready:false,since:new Date().toISOString(),beats:1});
  assert.equal(await read(),true,'one unready media beat must not revoke authority');
  await media({ready:false,since:new Date().toISOString(),beats:3});
  assert.equal(await read(),false,'three consecutive unready media beats revoke authority');
  await media({ready:false,since:new Date(Date.now()-16_000).toISOString(),beats:1});
  assert.equal(await read(),false,'a sustained 15 s media withdrawal revokes authority');
  await media({ready:true,since:null,beats:0});
  assert.equal(await read(),true);
  await telephony({ready:false,since:new Date().toISOString(),beats:1});
  assert.equal(await read(),true,'one unready telephony beat must not revoke authority');
  await telephony({ready:false,since:new Date().toISOString(),beats:3});
  assert.equal(await read(),false,'three consecutive unready telephony beats revoke authority');
  await telephony({ready:false,since:null,beats:0});
  assert.equal(await read(),true,'a NULL unready marker means ready, never NULL');
  // control_enabled and heartbeat freshness stay strict, with no tolerance window at all.
  await db.query(`UPDATE gateways SET control_enabled=false WHERE id=$1`,[gatewayId]);
  assert.equal(await read(),false);
  await db.query(`UPDATE gateways SET control_enabled=true,telephony_ready=true,media_ready=true,last_seen_at=now(),
    media_unready_since=NULL,media_unready_heartbeats=0,telephony_unready_since=NULL,telephony_unready_heartbeats=0 WHERE id=$1`,[gatewayId]);
  await cleanupCall(call.callId);
});

test('a Telecom ACTIVE snapshot after the lease is gone marks cleanup instead of failing with a NULL',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  // reconcile_unknown clears lease_until; `cleanup_required` is NOT NULL, so a bare comparison
  // rolled the whole telecom snapshot back with a 500 and blinded Control to the call.
  await db.query(`UPDATE ai_call_runs SET state='reconcile_unknown',cleanup_required=false,lease_until=NULL,lease_hash=NULL WHERE id=$1`,[run.id]);
  const observed=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'active'}});
  assert.equal(observed.statusCode,200,observed.body);
  const row=(await db.query(`SELECT state,cleanup_required FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0];
  assert.equal(row.state,'reconcile_unknown');assert.equal(row.cleanup_required,true);
  await cleanupCall(call.callId);
});

test('a pending run no worker ever claimed is reconciled to lost_race and the call rings normally again',async()=>{
  await heartbeat();const call=await incoming();
  const fresh=new AiRunReconciler(db,{intervalMs:60_000});
  assert.equal(await fresh.tickOnce(),0,'a fresh pending run is not stale yet');
  await db.query(`UPDATE ai_call_runs SET trigger_at=now()-interval '20 seconds' WHERE call_id=$1`,[call.callId]);
  assert.equal(await fresh.tickOnce(),1);
  const run=(await db.query(`SELECT state,failure_code FROM ai_call_runs WHERE call_id=$1`,[call.callId])).rows[0];
  assert.equal(run.state,'lost_race');assert.equal(run.failure_code,'worker_unavailable');
  const restored=(await db.query(`SELECT state,ai_run_id,failure_reason FROM call_records WHERE id=$1`,[call.callId])).rows[0];
  assert.equal(restored.state,'incoming_ringing');assert.equal(restored.ai_run_id,null);assert.equal(restored.failure_reason,'ai_worker_unavailable');
  const dto=await app.inject({method:'GET',url:`/api/v1/calls/${call.callId}`,headers:auth(userToken)});
  assert.equal(dto.json().call.aiHandling,false);assert.equal(dto.json().call.occupancy.canRelease,true);
  assert.equal(await fresh.tickOnce(),0,'a terminal run is not rescanned');
  await cleanupCall(call.callId);
});

test('exhausting pre-answer retries hands the still ringing call back to the three clients',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);
  for(let attempt=1;attempt<=3;attempt++){
    const run=await claimRun();
    const failed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/fail`,headers:leaseHeaders(run.leaseToken),payload:{...worker,code:'provider_disconnected'}});
    assert.equal(failed.statusCode,200,failed.body);
    const state=(await db.query(`SELECT state,attempts FROM ai_call_runs WHERE call_id=$1`,[call.callId])).rows[0];
    assert.equal(Number(state.attempts),attempt);
    assert.equal(state.state,attempt<3?'pending':'failed_before_answer');
    const owned=(await db.query(`SELECT ai_run_id FROM call_records WHERE id=$1`,[call.callId])).rows[0].ai_run_id;
    // A retryable failure must keep the pointer, or claimAiRun would never see the run again.
    assert.equal(owned!==null,attempt<3);
    if(attempt<3)await db.query(`UPDATE ai_call_runs SET next_attempt_at=now() WHERE call_id=$1`,[call.callId]);
  }
  const call2=(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[call.callId])).rows[0];
  assert.equal(call2.state,'incoming_ringing');assert.equal(call2.failure_reason,'provider_disconnected');
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[call.callId])).rows[0].n,0);
  await cleanupCall(call.callId);
});

test('commit-answer and media authorization tolerate the same single unready heartbeat',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  await db.query(`UPDATE gateways SET media_ready=false,media_unready_since=now(),media_unready_heartbeats=1 WHERE id=$1`,[gatewayId]);
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});
  assert.equal(committed.statusCode,200,committed.body);
  const options=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/media/options`,headers:leaseHeaders(run.leaseToken),payload:{...worker,transport:'udp'}});
  assert.equal(options.statusCode,200,options.body);
  await db.query(`UPDATE gateways SET media_unready_heartbeats=3 WHERE id=$1`,[gatewayId]);
  const revoked=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/media/options`,headers:leaseHeaders(run.leaseToken),payload:{...worker,transport:'udp'}});
  assert.equal(revoked.statusCode,409,revoked.body);assert.equal(revoked.json().error.code,'AI_MEDIA_REVOKED');
  await db.query(`UPDATE gateways SET media_ready=true,media_unready_since=NULL,media_unready_heartbeats=0 WHERE id=$1`,[gatewayId]);
  await cleanupCall(call.callId);
});

test('S94 owner-joined ends the AI run as owner_joined, keeps the call active, and is replay-safe',async()=>{
  await heartbeat();const call=await incoming();await snapshot(call);const run=await claimRun();
  const committed=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/commit-answer`,headers:leaseHeaders(run.leaseToken),payload:worker});assert.equal(committed.statusCode,200,committed.body);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${committed.json().command.id}/ack`,headers:auth(deviceToken),payload:{generation:deviceEpoch,status:'acked'}});assert.equal(ack.statusCode,200,ack.body);
  const active=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.callId}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:deviceEpoch,state:'active'}});assert.equal(active.statusCode,200,active.body);
  await snapshot(call,'active');
  const url=`/api/v1/gateway/calls/${call.callId}/owner-joined`;
  const payload={eventId:crypto.randomUUID(),generation:deviceEpoch,deviceCallId:call.deviceCallId,telecomCreationTimeMillis:1_790_000_000_000};
  const stale=await app.inject({method:'POST',url,headers:auth(deviceToken),payload:{...payload,generation:deviceEpoch+1}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'FENCE_REJECTED');
  const wrongDevice=await app.inject({method:'POST',url,headers:auth(deviceToken),payload:{...payload,eventId:crypto.randomUUID(),deviceCallId:'other-device-call'}});assert.equal(wrongDevice.statusCode,409);assert.equal(wrongDevice.json().error.code,'DEVICE_CALL_MISMATCH');
  for(const transient of ['connecting','unknown']){
    await db.query(`UPDATE call_records SET state=$2::call_state WHERE id=$1`,[call.callId,transient]);
    const pending=await app.inject({method:'POST',url,headers:auth(deviceToken),payload});assert.equal(pending.statusCode,503,pending.body);assert.equal(pending.json().error.code,'CALL_STATE_PENDING');
  }
  assert.equal((await db.query(`SELECT count(*)::int n FROM device_events WHERE event_id=$1`,[payload.eventId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT state FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0].state,'active');
  await db.query(`UPDATE call_records SET state='active' WHERE id=$1`,[call.callId]);
  const closesBefore=mediaCloseCount;
  // Same eventId as the 503 attempts: it re-evaluates now that the call is active.
  const first=await app.inject({method:'POST',url,headers:auth(deviceToken),payload});assert.equal(first.statusCode,200,first.body);
  assert.deepEqual(first.json(),{accepted:true,alreadyEnded:false});assert.equal(mediaCloseCount,closesBefore+1);
  const replay=await app.inject({method:'POST',url,headers:auth(deviceToken),payload});assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),first.json());
  assert.equal(mediaCloseCount,closesBefore+1);
  const reused=await app.inject({method:'POST',url,headers:auth(deviceToken),payload:{...payload,telecomCreationTimeMillis:payload.telecomCreationTimeMillis+1}});assert.equal(reused.statusCode,409);assert.equal(reused.json().error.code,'EVENT_ID_REUSED');
  const again=await app.inject({method:'POST',url,headers:auth(deviceToken),payload:{...payload,eventId:crypto.randomUUID()}});assert.equal(again.statusCode,200,again.body);assert.deepEqual(again.json(),{accepted:true,alreadyEnded:true});
  const row=(await db.query(`SELECT run.state,run.failure_code,run.lease_until,run.lease_owner,run.cleanup_required,run.ended_at,call.state call_state
    FROM ai_call_runs run JOIN call_records call ON call.id=run.call_id WHERE run.id=$1`,[run.id])).rows[0];
  assert.equal(row.state,'ended');assert.equal(row.failure_code,'owner_joined');assert.equal(row.lease_until,null);assert.equal(row.lease_owner,worker.instanceId);
  assert.equal(row.cleanup_required,false);assert.ok(row.ended_at);assert.equal(row.call_state,'active');
  let diagRows=0;for(let i=0;i<50&&!diagRows;i++){diagRows=(await db.query(`SELECT count(*)::int n FROM diag_events WHERE call_id=$1 AND event='call.owner_joined_local'`,[call.callId])).rows[0].n;if(!diagRows)await new Promise(r=>setTimeout(r,20));}
  assert.equal(diagRows,1);
  assert.deepEqual(await ownerJoinedLocalViews(call.callId),[true,true,true]);
  // Voice learns from its next read; its late fail report cannot push the call into `ending`.
  const read=await app.inject({method:'GET',url:`/internal/v1/ai/runs/${run.id}?instanceId=${worker.instanceId}&bootId=${worker.bootId}`,headers:leaseHeaders(run.leaseToken)});assert.equal(read.statusCode,409,read.body);
  const lateFail=await app.inject({method:'POST',url:`/internal/v1/ai/runs/${run.id}/fail`,headers:leaseHeaders(run.leaseToken),payload:{...worker,code:'media_lost'}});assert.equal(lateFail.statusCode,409,lateFail.body);
  // Neither the reconciler nor the revoked-session cleanup nor later Telecom snapshots touch the call.
  assert.equal(await new AiRunReconciler(db,{intervalMs:60_000,onlineSeconds:30}).tickOnce(),0);
  // Earlier tests may leave unrelated revoked-session jobs due; only this call must stay untargeted.
  await new RevokedCallCleanupWorker(db,{intervalMs:60_000,onlineSeconds:30}).tickOnce();
  assert.equal((await db.query(`SELECT count(*)::int n FROM session_revoked_call_cleanups WHERE call_id=$1`,[call.callId])).rows[0].n,0);
  await snapshot(call,'active');
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[call.callId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[call.callId])).rows[0].state,'active');
  assert.equal((await db.query(`SELECT state FROM ai_call_runs WHERE id=$1`,[run.id])).rows[0].state,'ended');
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[call.callId]);
  const ended=await app.inject({method:'POST',url,headers:auth(deviceToken),payload:{...payload,eventId:crypto.randomUUID()}});assert.equal(ended.statusCode,409);assert.equal(ended.json().error.code,'CALL_NOT_ACTIVE');
  await cleanupCall(call.callId);
});

test('S94 owner-joined checks the capture binding creation time and refuses calls AI never answered',async()=>{
  const call=await incoming();await snapshot(call,'active');
  await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[call.callId]);
  const url=`/api/v1/gateway/calls/${call.callId}/owner-joined`;
  const payload={eventId:crypto.randomUUID(),generation:deviceEpoch,deviceCallId:call.deviceCallId,telecomCreationTimeMillis:42};
  await db.query(`UPDATE call_records SET answered_by_platform='device',ai_run_id=NULL WHERE id=$1`,[call.callId]);
  const human=await app.inject({method:'POST',url,headers:auth(deviceToken),payload});assert.equal(human.statusCode,409);assert.equal(human.json().error.code,'CALL_NOT_AI_ANSWERED');
  assert.deepEqual(await ownerJoinedLocalViews(call.callId),[false,false,false]);
  await db.query(`INSERT INTO recording_capture_bindings(call_id,gateway_id,snapshot_owner_id,device_call_id,telecom_creation_time_millis,capture_generation,media_node_id,media_epoch)
    SELECT id,gateway_id,snapshot_owner_id,device_call_id,41,$2,'relay-primary',1 FROM call_records WHERE id=$1`,[call.callId,deviceEpoch]);
  const mismatch=await app.inject({method:'POST',url,headers:auth(deviceToken),payload:{...payload,eventId:crypto.randomUUID()}});assert.equal(mismatch.statusCode,409);assert.equal(mismatch.json().error.code,'DEVICE_CALL_MISMATCH');
  await cleanupCall(call.callId);
});
