import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
import {WebCallLivenessWorker} from '../src/web-call-liveness.js';
import {renewWebCallLease,WebCallLivenessError} from '../src/web-call-liveness.js';
import {MediaCloseWorker} from '../src/media-close-worker.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');
let db:Db,app:FastifyInstance,userId:string,otherUserId:string,webSessionId:string,otherWebSessionId:string,gatewayId:string,simId:string,nativeToken:string,webCookie:string;
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'web-liveness-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'web-liveness-media-secret-at-least-32-characters',TURN_SECRET:'web-liveness-turn-secret-at-least-32-characters',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,WEB_CALL_LIVENESS_ENABLED:true,COMMAND_REPLAY_HORIZON_ENABLED:false};
const origin={'origin':config.PUBLIC_ORIGIN};
const protocol={'x-vodog-call-protocol':'web-liveness-v1'};

before(async()=>{
 db=createDb(databaseUrl);await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
 await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
 const hash=await hashPassword('correct horse battery staple');
 userId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('web-owner@example.test',$1)RETURNING id`,[hash])).rows[0].id;
 otherUserId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('other-web-owner@example.test',$1)RETURNING id`,[hash])).rows[0].id;
 const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('web-gateway',true,true,true,now())RETURNING id,device_epoch`)).rows[0];gatewayId=gateway.id;
 simId=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'web-sim',true,$3)RETURNING id`,[gatewayId,userId,tokenHash('web-liveness-sim-fingerprint')])).rows[0].id;
 await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[simId]);
 await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),0,0,false,'[]',now())`,[gatewayId,gateway.device_epoch]);
 app=await buildApp(db,config);
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:origin,payload:{username:'web-owner@example.test',password:'correct horse battery staple',platform:'web'}});assert.equal(login.statusCode,200,login.body);webCookie=login.headers['set-cookie']!.split(';')[0]!;
 webSessionId=(await db.query(`SELECT id FROM sessions WHERE user_id=$1 AND client_type='web' ORDER BY created_at DESC LIMIT 1`,[userId])).rows[0].id;
 otherWebSessionId=(await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at)VALUES($1,$2,'web','web',now()+interval '12 hours')RETURNING id`,[otherUserId,tokenHash('other-web-session-token-with-enough-entropy')])).rows[0].id;
 const native=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'web-owner@example.test',password:'correct horse battery staple',platform:'android'}});nativeToken=native.json().token;
});
after(async()=>{if(app)await app.close();if(db)await db.end();});

async function directWebCall(name:string,sessionId=webSessionId){
 const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES($1,true,true,true,now())RETURNING id,device_epoch`,[name])).rows[0];
 const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id`,[gateway.id,userId,`${name}-sim`,tokenHash(`${name}-sim-fingerprint`)])).rows[0];
 const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,originating_session_id)VALUES($1,$2,$3,'outgoing','+15550999','outgoing_pending',$4,'normal',$5)RETURNING id,media_epoch`,[gateway.id,sim.id,userId,gateway.device_epoch,sessionId])).rows[0];
 await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[gateway.id,call.id,gateway.device_epoch]);
 await db.query(`INSERT INTO web_call_liveness_leases(call_id,session_id,media_epoch,expires_at)VALUES($1,$2,$3,now()-interval '1 second')`,[call.id,sessionId,call.media_epoch]);
 return{callId:call.id,gatewayId:gateway.id};
}

test('web outbound atomically creates an exact-session lease and native outbound never does',async()=>{
 const before=await db.query(`SELECT (SELECT count(*)::int FROM call_records) calls,(SELECT count(*)::int FROM commands) commands,(SELECT count(*)::int FROM gateway_call_locks) locks,(SELECT count(*)::int FROM web_call_liveness_leases) leases,(SELECT count(*)::int FROM idempotency_requests) idempotency`);
 const oldWeb=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...origin,cookie:webCookie,'idempotency-key':'old-web-must-upgrade'},payload:{simId,remoteNumber:'+15550100'}});assert.equal(oldWeb.statusCode,409,oldWeb.body);assert.equal(oldWeb.json().error.code,'CLIENT_UPGRADE_REQUIRED');
 const after=await db.query(`SELECT (SELECT count(*)::int FROM call_records) calls,(SELECT count(*)::int FROM commands) commands,(SELECT count(*)::int FROM gateway_call_locks) locks,(SELECT count(*)::int FROM web_call_liveness_leases) leases,(SELECT count(*)::int FROM idempotency_requests) idempotency`);assert.deepEqual(after.rows[0],before.rows[0]);
 const web=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...origin,...protocol,cookie:webCookie,'idempotency-key':'web-liveness-outbound'},payload:{simId,remoteNumber:'+15550101'}});assert.equal(web.statusCode,202,web.body);
 assert.equal(web.json().liveness.mediaEpoch,1);assert.equal(web.json().liveness.revision,1);
 const lease=await db.query(`SELECT lease.session_id,session.client_type,session.platform FROM web_call_liveness_leases lease JOIN sessions session ON session.id=lease.session_id WHERE call_id=$1`,[web.json().call.id]);assert.deepEqual(lease.rows[0],{session_id:lease.rows[0].session_id,client_type:'web',platform:'web'});
 const renewed=await app.inject({method:'PUT',url:`/api/v1/calls/${web.json().call.id}/liveness`,headers:{...origin,cookie:webCookie},payload:{mediaEpoch:1,expectedRevision:1}});assert.equal(renewed.statusCode,200,renewed.body);assert.equal(renewed.json().liveness.revision,2);
 const replay=await app.inject({method:'PUT',url:`/api/v1/calls/${web.json().call.id}/liveness`,headers:{...origin,cookie:webCookie},payload:{mediaEpoch:1,expectedRevision:1}});assert.equal(replay.statusCode,409,replay.body);assert.equal(replay.json().error.code,'CALL_LIVENESS_CONFLICT');
 const nativeRenew=await app.inject({method:'PUT',url:`/api/v1/calls/${web.json().call.id}/liveness`,headers:{authorization:`Bearer ${nativeToken}`},payload:{mediaEpoch:1,expectedRevision:2}});assert.equal(nativeRenew.statusCode,404,nativeRenew.body);
 const nativeGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('native-gateway',true,true,true,now())RETURNING id,device_epoch`)).rows[0];
 const nativeSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'native-sim',true,$3)RETURNING id`,[nativeGateway.id,userId,tokenHash('native-liveness-sim-fingerprint')])).rows[0].id;
 await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[nativeSim]);
 await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),0,0,false,'[]',now())`,[nativeGateway.id,nativeGateway.device_epoch]);
 const nativeCall=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{authorization:`Bearer ${nativeToken}`,'idempotency-key':'native-no-liveness'},payload:{simId:nativeSim,remoteNumber:'+15550102'}});assert.equal(nativeCall.statusCode,202,nativeCall.body);assert.equal(nativeCall.json().liveness,null);
 assert.equal((await db.query(`SELECT count(*)::int n FROM web_call_liveness_leases WHERE call_id=$1`,[nativeCall.json().call.id])).rows[0].n,0);

 const incomingGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('incoming-web-gateway',true,true,true,now())RETURNING id,device_epoch`)).rows[0];
 const incomingSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'incoming-web-sim',true,$3)RETURNING id`,[incomingGateway.id,userId,tokenHash('incoming-web-sim-fingerprint')])).rows[0].id;
 await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[incomingSim]);
 const incomingId=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,device_call_id)VALUES($1,$2,$3,'incoming','+15550105','incoming_ringing',$4,'normal','incoming-device-call')RETURNING id`,[incomingGateway.id,incomingSim,userId,incomingGateway.device_epoch])).rows[0].id;
 await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[incomingGateway.id,incomingId,incomingGateway.device_epoch]);
 const oldClaim=await app.inject({method:'POST',url:`/api/v1/calls/${incomingId}/claim`,headers:{...origin,cookie:webCookie},payload:{platform:'web',deviceName:'Old Web'}});assert.equal(oldClaim.statusCode,409,oldClaim.body);assert.equal(oldClaim.json().error.code,'CLIENT_UPGRADE_REQUIRED');
 assert.deepEqual((await db.query(`SELECT state,claimed_by_session_id FROM call_records WHERE id=$1`,[incomingId])).rows[0],{state:'incoming_ringing',claimed_by_session_id:null});assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1`,[incomingId])).rows[0].n,0);assert.equal((await db.query(`SELECT count(*)::int n FROM web_call_liveness_leases WHERE call_id=$1`,[incomingId])).rows[0].n,0);
 const claim=await app.inject({method:'POST',url:`/api/v1/calls/${incomingId}/claim`,headers:{...origin,...protocol,cookie:webCookie},payload:{platform:'web',deviceName:'Web test'}});assert.equal(claim.statusCode,200,claim.body);assert.equal(claim.json().liveness.revision,1);
 assert.equal((await db.query(`SELECT count(*)::int n FROM web_call_liveness_leases WHERE call_id=$1`,[incomingId])).rows[0].n,1);
 // The dial was handed to the gateway, so expiry keeps the hangup path (an undelivered dial is cancelled instead).
 await db.query(`UPDATE commands SET delivered_at=now() WHERE call_id=$1 AND kind='dial'`,[web.json().call.id]);
 const closes:string[]=[];await db.query(`UPDATE web_call_liveness_leases SET expires_at=now()-interval '1 second' WHERE call_id=$1`,[web.json().call.id]);
 const worker=new WebCallLivenessWorker(db,{enabled:true,batch:1,onMediaClose:async id=>{closes.push(id);}});
 assert.equal(await worker.tickOnce(),1);let state=(await db.query(`SELECT state FROM call_records WHERE id=$1`,[web.json().call.id])).rows[0].state;assert.equal(state,'ending');
 assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[web.json().call.id])).rows[0].n,1);assert.deepEqual(closes,[]);
 assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[web.json().call.id])).rows[0].n,1);
 assert.equal((await db.query(`SELECT close_mode FROM media_close_jobs WHERE call_id=$1`,[web.json().call.id])).rows[0].close_mode,'wait_terminal');
 const lateEnd=await app.inject({method:'POST',url:`/api/v1/calls/${web.json().call.id}/end`,headers:{...origin,cookie:webCookie},payload:{onlyIfCurrentSessionOwner:true}});assert.equal(lateEnd.statusCode,202,lateEnd.body);
 assert.equal((await db.query(`SELECT state FROM web_call_liveness_leases WHERE call_id=$1`,[web.json().call.id])).rows[0].state,'expired');
 await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE call_id=$1 AND kind='hangup'`,[web.json().call.id]);
 await db.query(`UPDATE web_call_liveness_leases SET next_attempt_at=now() WHERE call_id=$1`,[web.json().call.id]);
 assert.equal(await worker.tickOnce(),1);assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[web.json().call.id])).rows[0].n,1);
 state=(await db.query(`SELECT state FROM call_records WHERE id=$1`,[web.json().call.id])).rows[0].state;assert.equal(state,'ending');
 assert.equal((await db.query(`SELECT state FROM web_call_liveness_leases WHERE call_id=$1`,[web.json().call.id])).rows[0].state,'closed');
 assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[web.json().call.id])).rows[0].n,1);

 const activeGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('normal-end-gateway',true,true,true,now())RETURNING id,device_epoch`)).rows[0];
 const activeSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'normal-end-sim',true,$3)RETURNING id`,[activeGateway.id,userId,tokenHash('normal-end-sim-fingerprint')])).rows[0].id;
 await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[activeSim]);await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),0,0,false,'[]',now())`,[activeGateway.id,activeGateway.device_epoch]);
 const normal=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...origin,...protocol,cookie:webCookie,'idempotency-key':'web-normal-end'},payload:{simId:activeSim,remoteNumber:'+15550103'}});assert.equal(normal.statusCode,202,normal.body);
 await db.query(`UPDATE commands SET delivered_at=now() WHERE call_id=$1 AND kind='dial'`,[normal.json().call.id]);
 const ended=await app.inject({method:'POST',url:`/api/v1/calls/${normal.json().call.id}/end`,headers:{...origin,cookie:webCookie},payload:{onlyIfCurrentSessionOwner:true}});assert.equal(ended.statusCode,202,ended.body);
 assert.equal((await db.query(`SELECT state FROM web_call_liveness_leases WHERE call_id=$1`,[normal.json().call.id])).rows[0].state,'expired');
 assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[normal.json().call.id])).rows[0].n,1);
 await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE call_id=$1 AND kind='hangup'`,[normal.json().call.id]);await db.query(`UPDATE web_call_liveness_leases SET next_attempt_at=now() WHERE call_id=$1`,[normal.json().call.id]);
 const normalDeadline=(await db.query(`SELECT next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[normal.json().call.id])).rows[0].next_attempt_at;
 assert.equal(await worker.tickOnce(),1);assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[normal.json().call.id])).rows[0].n,1);
 assert.deepEqual(closes,[]);
 assert.equal((await db.query(`SELECT next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[normal.json().call.id])).rows[0].next_attempt_at.getTime(),normalDeadline.getTime());

 const recoveredGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('epoch-recovery-gateway',true,true,true,now())RETURNING id,device_epoch`)).rows[0];
 const recoveredSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'epoch-recovery-sim',true,$3)RETURNING id`,[recoveredGateway.id,userId,tokenHash('epoch-recovery-sim-fingerprint')])).rows[0].id;
 await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[recoveredSim]);await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),0,0,false,'[]',now())`,[recoveredGateway.id,recoveredGateway.device_epoch]);
 const recovered=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...origin,...protocol,cookie:webCookie,'idempotency-key':'web-epoch-recovery'},payload:{simId:recoveredSim,remoteNumber:'+15550104'}});assert.equal(recovered.statusCode,202,recovered.body);const recoveredId=recovered.json().call.id;
 await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[recoveredId]);const terminalDetail=await app.inject({method:'GET',url:`/api/v1/calls/${recoveredId}`,headers:{cookie:webCookie}});assert.equal(terminalDetail.statusCode,200,terminalDetail.body);assert.equal(terminalDetail.json().liveness,null);await db.query(`UPDATE call_records SET state='outgoing_pending',ended_at=NULL WHERE id=$1`,[recoveredId]);
 await db.query(`UPDATE call_records SET device_call_id='device-call-old-epoch' WHERE id=$1`,[recoveredId]);await db.query(`UPDATE gateways SET device_epoch=device_epoch+1,last_seen_at=now() WHERE id=$1`,[recoveredGateway.id]);
 const newEpoch=Number((await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`,[recoveredGateway.id])).rows[0].device_epoch);
 await db.query(`UPDATE gateway_telecom_snapshots SET generation=$2,calls=$3,observed_at=now(),updated_at=now() WHERE gateway_id=$1`,[recoveredGateway.id,newEpoch,JSON.stringify([{callId:recoveredId,deviceCallId:'device-call-old-epoch',simId:recoveredSim,direction:'outgoing',state:'active'}])]);
 await db.query(`UPDATE web_call_liveness_leases SET expires_at=now()-interval '1 second' WHERE call_id=$1`,[recoveredId]);
 assert.equal(await worker.tickOnce(),1);const adopted=(await db.query(`SELECT call.generation,lock.generation lock_generation FROM call_records call JOIN gateway_call_locks lock ON lock.call_id=call.id WHERE call.id=$1`,[recoveredId])).rows[0];assert.equal(Number(adopted.generation),newEpoch);assert.equal(Number(adopted.lock_generation),newEpoch);
 assert.equal(Number((await db.query(`SELECT generation FROM commands WHERE call_id=$1 AND kind='hangup' ORDER BY sequence DESC LIMIT 1`,[recoveredId])).rows[0].generation),newEpoch);
});

test('two expiry workers and a boundary heartbeat have one CAS winner and one hangup',async()=>{
 const fixture=await directWebCall('worker-race');let closes=0;
 const first=new WebCallLivenessWorker(db,{enabled:true,batch:10,onMediaClose:async()=>{closes++;}}),second=new WebCallLivenessWorker(db,{enabled:true,batch:10,onMediaClose:async()=>{closes++;}});
 const heartbeat=renewWebCallLease(db,{callId:fixture.callId,sessionId:webSessionId,clientType:'web',platform:'web',mediaEpoch:1,expectedRevision:1});
 const [renewed,...ticks]=await Promise.allSettled([heartbeat,first.tickOnce(),second.tickOnce()]);
 assert.equal(renewed.status,'rejected');assert.ok(renewed.status==='rejected'&&renewed.reason instanceof WebCallLivenessError);
 assert.equal(ticks.filter(result=>result.status==='fulfilled'&&result.value===1).length,1);
 assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[fixture.callId])).rows[0].n,1);assert.equal(closes,0);
 assert.equal((await db.query(`SELECT close_mode FROM media_close_jobs WHERE call_id=$1`,[fixture.callId])).rows[0].close_mode,'wait_terminal');
 assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[fixture.callId])).rows[0].n,1);
});

test('explicit end keeps its terminal wait deadline and liveness cannot regress timeout unknown',async()=>{
 const fixture=await directWebCall('cross-worker-normal-end');
 const ended=await app.inject({method:'POST',url:`/api/v1/calls/${fixture.callId}/end`,headers:{...origin,cookie:webCookie},payload:{onlyIfCurrentSessionOwner:true}});assert.equal(ended.statusCode,202,ended.body);
 const original=(await db.query(`SELECT close_mode,next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[fixture.callId])).rows[0];assert.equal(original.close_mode,'wait_terminal');
 let prematureCloses=0;const liveness=new WebCallLivenessWorker(db,{enabled:true,onMediaClose:async()=>{prematureCloses++;}});
 await db.query(`UPDATE web_call_liveness_leases SET next_attempt_at=now() WHERE call_id=$1`,[fixture.callId]);
 assert.equal(await liveness.tickOnce(),1);assert.equal(prematureCloses,0);
 const preserved=(await db.query(`SELECT close_mode,next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[fixture.callId])).rows[0];assert.equal(preserved.close_mode,'wait_terminal');assert.equal(preserved.next_attempt_at.getTime(),original.next_attempt_at.getTime());

 await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE call_id=$1 AND kind='hangup'`,[fixture.callId]);
 await db.query(`UPDATE media_close_jobs SET next_attempt_at=now() WHERE call_id=$1`,[fixture.callId]);
 let terminalTimeoutCloses=0;const mediaClose=new MediaCloseWorker(db,{close:async()=>{terminalTimeoutCloses++;}},{concurrency:1});
 assert.equal(await mediaClose.tickOnce(),1);assert.equal(terminalTimeoutCloses,1);
 assert.deepEqual((await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[fixture.callId])).rows[0],{state:'unknown',failure_reason:'hangup_terminal_unconfirmed'});

 await db.query(`UPDATE web_call_liveness_leases SET state='expired',next_attempt_at=now() WHERE call_id=$1`,[fixture.callId]);
 assert.equal(await liveness.tickOnce(),1);assert.equal(prematureCloses,0);
 assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[fixture.callId])).rows[0].state,'unknown');
 assert.equal((await db.query(`SELECT state FROM web_call_liveness_leases WHERE call_id=$1`,[fixture.callId])).rows[0].state,'closed');
 assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[fixture.callId])).rows[0].n,1);
});

test('claim lease failure rolls back claim and command, and invalid principals cannot renew',async()=>{
 const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('claim-rollback',true,true,true,now())RETURNING id,device_epoch`)).rows[0];
 const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'claim-rollback-sim',true,$3)RETURNING id`,[gateway.id,userId,tokenHash('claim-rollback-sim-fingerprint')])).rows[0];
 const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,device_call_id)VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'normal','claim-rollback-device')RETURNING id,media_epoch`,[gateway.id,sim.id,userId,gateway.device_epoch])).rows[0];
 await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[gateway.id,call.id,gateway.device_epoch]);
 await db.query(`INSERT INTO web_call_liveness_leases(call_id,session_id,media_epoch,expires_at)VALUES($1,$2,$3,now()+interval '15 seconds')`,[call.id,otherWebSessionId,call.media_epoch]);
 const claim=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/claim`,headers:{...origin,...protocol,cookie:webCookie},payload:{platform:'web'}});assert.equal(claim.statusCode,500,claim.body);
 const unchanged=(await db.query(`SELECT state,claimed_by_session_id FROM call_records WHERE id=$1`,[call.id])).rows[0];assert.deepEqual(unchanged,{state:'incoming_ringing',claimed_by_session_id:null});
 assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[call.id])).rows[0].n,0);

 const leaseCall=await directWebCall('renew-fences');await db.query(`UPDATE web_call_liveness_leases SET expires_at=now()+interval '15 seconds' WHERE call_id=$1`,[leaseCall.callId]);
 await assert.rejects(renewWebCallLease(db,{callId:leaseCall.callId,sessionId:otherWebSessionId,clientType:'web',platform:'web',mediaEpoch:1,expectedRevision:1}),error=>error instanceof WebCallLivenessError&&error.status===404);
 await assert.rejects(renewWebCallLease(db,{callId:leaseCall.callId,sessionId:webSessionId,clientType:'web',platform:'web',mediaEpoch:2,expectedRevision:1}),error=>error instanceof WebCallLivenessError&&error.status===409);
 await db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`,[webSessionId]);
 await assert.rejects(renewWebCallLease(db,{callId:leaseCall.callId,sessionId:webSessionId,clientType:'web',platform:'web',mediaEpoch:1,expectedRevision:1}),error=>error instanceof WebCallLivenessError&&error.status===409);
});

test('liveness expiry of a web call whose dial was never delivered cancels the dial and ends the call',async()=>{
 const {callId,gatewayId:gw}=await directWebCall('undelivered-dial-liveness');
 const epoch=Number((await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`,[gw])).rows[0].device_epoch);
 await db.query(`UPDATE gateways SET command_sequence=1 WHERE id=$1`,[gw]);
 const dialId=(await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)VALUES($1,$2,$3,1,'dial',$4,now()+interval '30 seconds')RETURNING id`,[gw,callId,epoch,JSON.stringify({callId,simId:null,remoteNumber:'+15550999'})])).rows[0].id;
 const closes:string[]=[];const worker=new WebCallLivenessWorker(db,{enabled:true,batch:10,onMediaClose:async id=>{closes.push(id);}});
 let ticks=0;while(!closes.includes(callId)&&ticks++<10)await worker.tickOnce();
 assert.deepEqual((await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[callId])).rows[0],{state:'ended',failure_reason:'web_liveness_expired'});
 assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[callId])).rows[0].n,0);
 assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='hangup'`,[callId])).rows[0].n,0);
 const dial=(await db.query(`SELECT status,expires_at<=now() expired FROM commands WHERE id=$1`,[dialId])).rows[0];assert.deepEqual(dial,{status:'pending',expired:true});
 assert.equal((await db.query(`SELECT state FROM web_call_liveness_leases WHERE call_id=$1`,[callId])).rows[0].state,'closed');
});
