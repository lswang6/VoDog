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
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'closure-test-cookie-secret-at-least-32-chars',
  GATEWAY_ONLINE_SECONDS:30,PORT:3499,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',
  MEDIA_SECRET:'closure-test-media-secret-at-least-32-chars',TURN_SECRET:'closure-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};

let db:Db,app:FastifyInstance,ownerId:string,gatewayId:string,simId:string,deviceEpoch:number,assignmentVersion:number;
let token:string,deviceToken:string;
const auth=(value:string)=>({authorization:`Bearer ${value}`});
const password='correct horse battery staple';

before(async()=>{
  db=createDb(databaseUrl!);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const hash=await hashPassword(password);
  ownerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('closure-owner@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at,time_zone)VALUES('closure-gateway',true,true,true,true,now(),'Asia/Shanghai')RETURNING id,device_epoch`)).rows[0];
  gatewayId=gateway.id;deviceEpoch=Number(gateway.device_epoch);
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,'SIM',true,$3,'CN')RETURNING id,version`,
    [gatewayId,ownerId,tokenHash('closure-sim-fingerprint')])).rows[0];
  simId=sim.id;assignmentVersion=Number(sim.version);
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[simId]);
  deviceToken='closure-device-token-with-enough-entropy-1';
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'closure')`,[gatewayId,tokenHash(deviceToken)]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),1,0,false,'[]',now())`,[gatewayId,deviceEpoch]);
  app=await buildApp(db,config);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'closure-owner@example.test',password,platform:'android'}});
  assert.equal(login.statusCode,200,login.body);
  token=login.json().token;
});
after(async()=>{await app.close();await db.end();});

let snapshotSequence=1;

test('a gateway-blocked call is terminal at creation: no lock, no command, no hangup, no AI run',async()=>{
  const deviceCallId='locally-blocked-call';
  const payload={eventId:crypto.randomUUID(),generation:deviceEpoch,deviceCallId,simId,remoteNumber:'+8618600000001',
    observedAt:new Date().toISOString(),blockedLocally:true};
  const reported=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),payload});
  assert.equal(reported.statusCode,202,reported.body);
  assert.equal(reported.json().disposition,'dropped_blocked');
  assert.equal(reported.json().call,undefined);
  const row=(await db.query(`SELECT state,failure_reason,blocked_source,ended_at,snapshot_owner_id FROM call_records WHERE gateway_id=$1 AND device_call_id=$2`,[gatewayId,deviceCallId])).rows[0];
  assert.equal(row.state,'failed');
  assert.equal(row.failure_reason,'number_blocked');
  assert.equal(row.blocked_source,'gateway');
  assert.ok(row.ended_at,'the row is terminal at creation');
  assert.equal(row.snapshot_owner_id,ownerId);
  assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE gateway_id=$1`,[gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE gateway_id=$1`,[gatewayId])).rows[0].n,0,'no hangup: the device already rejected the call');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE gateway_id=$1`,[gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM push_deliveries`)).rows[0].n,0);

  // Replay under the same eventId is idempotent and still creates nothing.
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),payload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().disposition,'dropped_blocked');
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1 AND device_call_id=$2`,[gatewayId,deviceCallId])).rows[0].n,1);

  // A late snapshot item for the same deviceCallId is ignored entirely, including the busy flag.
  snapshotSequence++;
  const callId=(await db.query(`SELECT id FROM call_records WHERE gateway_id=$1 AND device_call_id=$2`,[gatewayId,deviceCallId])).rows[0].id;
  const snapshot=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(deviceToken),payload:{
    snapshotId:crypto.randomUUID(),snapshotSequence,generation:deviceEpoch,reportedSequence:0,localBusy:false,
    confirmedAbsentCallIds:[],calls:[{callId,deviceCallId,simId,direction:'incoming',state:'ringing'}],observedAt:new Date().toISOString()}});
  assert.equal(snapshot.statusCode,200,snapshot.body);
  assert.equal(snapshot.json().busyState,'idle','an intercepted call never marks the gateway busy');
  const unchanged=(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.deepEqual(unchanged,{state:'failed',failure_reason:'number_blocked'});
});

test('a Control-detected block still issues the hangup and records source=control',async()=>{
  const created=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'18600000001'}});
  assert.equal(created.statusCode,201,created.body);
  const deviceCallId='control-blocked-call';
  const reported=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),payload:{
    eventId:crypto.randomUUID(),generation:deviceEpoch,deviceCallId,simId,remoteNumber:'+8618600000001',observedAt:new Date().toISOString()}});
  assert.equal(reported.statusCode,202,reported.body);
  const row=(await db.query(`SELECT blocked_source FROM call_records WHERE gateway_id=$1 AND device_call_id=$2`,[gatewayId,deviceCallId])).rows[0];
  assert.equal(row.blocked_source,'control');
  const commands=(await db.query(`SELECT kind FROM commands WHERE gateway_id=$1`,[gatewayId])).rows.map((value:{kind:string})=>value.kind);
  assert.deepEqual(commands,['hangup'],'the device did not hang up itself, so Control must');
});

test('blocked SMS is recorded with its body on both the gateway and the Control path',async()=>{
  // S66: only the SMS list intercepts SMS.
  for(const remoteNumber of ['13500000001','18600000001']){
    const listed=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber,scope:'sms'}});
    assert.equal(listed.statusCode,201,listed.body);
  }
  const receivedAt=new Date().toISOString();
  const locally=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(deviceToken),payload:{
    eventId:crypto.randomUUID(),generation:deviceEpoch,simId,assignmentVersion,remoteNumber:'13500000001',
    body:'locally dropped',receivedAt,blockedLocally:true}});
  assert.equal(locally.statusCode,202,locally.body);
  assert.equal(locally.json().disposition,'dropped_blocked');
  const control=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(deviceToken),payload:{
    eventId:crypto.randomUUID(),generation:deviceEpoch,simId,assignmentVersion,remoteNumber:'18600000001',
    body:'control dropped',receivedAt:new Date().toISOString()}});
  assert.equal(control.statusCode,202,control.body);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1`,[gatewayId])).rows[0].n,0,'blocked SMS never reaches sms_messages');
  const stored=(await db.query(`SELECT remote_number,body,source FROM sms_interceptions WHERE owner_user_id=$1 ORDER BY received_at`,[ownerId])).rows;
  assert.deepEqual(stored.map((row:any)=>[row.body,row.source]),[['locally dropped','gateway'],['control dropped','control']]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM device_events WHERE gateway_id=$1 AND event_type='sms.incoming'`,[gatewayId])).rows[0].n,2);

  // The message key is a content hash, so a retry under a fresh eventId does not double-record.
  const retried=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(deviceToken),payload:{
    eventId:crypto.randomUUID(),generation:deviceEpoch,simId,assignmentVersion,remoteNumber:'13500000001',
    body:'locally dropped',receivedAt,blockedLocally:true}});
  assert.equal(retried.statusCode,202,retried.body);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_interceptions WHERE owner_user_id=$1`,[ownerId])).rows[0].n,2);
});

test('the interception feed unifies both kinds, is owner isolated, and previews SMS bodies',async()=>{
  const anonymous=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions'});
  assert.equal(anonymous.statusCode,401);
  const feed=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(token)});
  assert.equal(feed.statusCode,200,feed.body);
  const items=feed.json().items;
  assert.equal(items.length,4,'two intercepted calls and two intercepted messages');
  assert.deepEqual([...new Set(items.map((item:any)=>item.kind))].sort(),['call','sms']);
  for(const item of items){
    assert.deepEqual(Object.keys(item).sort(),['blockedEntryId','bodyPreview','contactId','contactName','gatewayTimeZone','id','kind','occurredAt','remoteNumber','simId','simLabel','source'].sort());
    assert.equal(item.simId,simId);
    assert.equal(item.simLabel,'SIM');
    assert.equal(item.gatewayTimeZone,'Asia/Shanghai');
  }
  const sms=items.find((item:any)=>item.bodyPreview==='control dropped');
  assert.equal(sms.kind,'sms');
  assert.equal(sms.source,'control');
  assert.ok(items.find((item:any)=>item.kind==='call'&&item.source==='gateway'));
  assert.equal(items.find((item:any)=>item.kind==='call').bodyPreview,null);
  // 18600000001 is on the blocklist, so its rows carry the entry id for the "unblock" action.
  assert.ok(items.some((item:any)=>item.blockedEntryId!==null));

  // A second SIM keeps its own label/time zone. History stays with its snapshot
  // owner, but a later transfer must not disclose the new owner's private label.
  const secondGateway=(await db.query(`INSERT INTO gateways(name,time_zone)VALUES('closure-second-gateway','Asia/Tokyo')RETURNING id`)).rows[0].id;
  const secondSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)
    VALUES($1,0,$2,'旅行 SIM',true,$3,'JP')RETURNING id`,[secondGateway,ownerId,tokenHash('closure-second-sim')])).rows[0].id;
  await db.query(`INSERT INTO sms_interceptions(owner_user_id,sim_id,gateway_id,remote_number,canonical_key,body,message_key,received_at,source)
    VALUES($1,$2,$3,'09012345678','819012345678','second sim','second-sim-interception',now(),'gateway')`,[ownerId,secondSim,secondGateway]);
  const twoSims=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(token)});
  const secondRow=twoSims.json().items.find((item:any)=>item.bodyPreview==='second sim');
  assert.equal(secondRow.simLabel,'旅行 SIM');
  assert.equal(secondRow.gatewayTimeZone,'Asia/Tokyo');
  await db.query(`UPDATE sims SET owner_user_id=NULL WHERE id=$1`,[secondSim]);
  const afterTransfer=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(token)});
  const transferred=afterTransfer.json().items.find((item:any)=>item.bodyPreview==='second sim');
  assert.equal(transferred.simLabel,null);
  assert.equal(transferred.gatewayTimeZone,'Asia/Tokyo');
  await db.query(`DELETE FROM sms_interceptions WHERE message_key='second-sim-interception'`);
  await db.query(`DELETE FROM sims WHERE id=$1`,[secondSim]);
  await db.query(`DELETE FROM gateways WHERE id=$1`,[secondGateway]);

  assert.equal((await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'13500000009',scope:'sms'}})).statusCode,201);
  const longBody='x'.repeat(400);
  await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(deviceToken),payload:{
    eventId:crypto.randomUUID(),generation:deviceEpoch,simId,assignmentVersion,remoteNumber:'13500000009',
    body:longBody,receivedAt:new Date().toISOString(),blockedLocally:true}});
  const trimmed=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(token)});
  assert.equal(trimmed.json().items.find((item:any)=>item.remoteNumber==='13500000009').bodyPreview.length,160);
});

test('the call history hides intercepted rows until includeBlocked is asked for',async()=>{
  const hidden=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  assert.equal(hidden.statusCode,200,hidden.body);
  assert.equal(hidden.json().items.some((item:any)=>item.failureReason==='number_blocked'),false);
  const shown=await app.inject({method:'GET',url:'/api/v1/calls?includeBlocked=true',headers:auth(token)});
  assert.equal(shown.json().items.filter((item:any)=>item.failureReason==='number_blocked').length,2);
  // Still excluded after the number is unblocked: the row is interception history, not call history.
  for(const scope of ['call','sms'])
    for(const entry of (await app.inject({method:'GET',url:`/api/v1/blocklist?scope=${scope}`,headers:auth(token)})).json().items)
      await app.inject({method:'DELETE',url:`/api/v1/blocklist/${entry.id}`,headers:auth(token)});
  const afterUnblock=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  assert.equal(afterUnblock.json().items.some((item:any)=>item.failureReason==='number_blocked'),false);
  const feed=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(token)});
  assert.equal(feed.json().items.every((item:any)=>item.blockedEntryId===null),true,'unblocking clears the entry id but keeps the record');
});

test('S28: the interception feed offset pages over both halves, counted in closed form',async()=>{
  // A dedicated owner so `total` means exactly "the rows this test inserted".
  const hash=await hashPassword(password);
  const pagingOwner=(await db.query(`INSERT INTO users(email,password_hash)VALUES('interceptions-paging@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  const stranger=(await db.query(`INSERT INTO users(email,password_hash)VALUES('interceptions-stranger@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  const fixture=async(ownerUserId:string,label:string)=>{
    const g=(await db.query(`INSERT INTO gateways(name,control_enabled,last_seen_at)VALUES($1,true,now())RETURNING id,device_epoch`,[label])).rows[0];
    const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,protected_iccid_hash)VALUES($1,0,$2,$3,$4)RETURNING id`,
      [g.id,ownerUserId,`${label} SIM`,tokenHash(`${label}-fingerprint`)])).rows[0];
    return {gatewayId:g.id as string,simId:sim.id as string,deviceEpoch:Number(g.device_epoch)};
  };
  const mine=await fixture(pagingOwner,'interceptions-paging');
  const theirs=await fixture(stranger,'interceptions-stranger');
  const login=async(email:string)=>{
    const response=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
    assert.equal(response.statusCode,200,response.body);
    return response.json().token as string;
  };
  const pagingToken=await login('interceptions-paging@example.test');
  const blockedCall=async(owner:string,place:{gatewayId:string;simId:string;deviceEpoch:number},remote:string,at:Date)=>
    (await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,started_at,ended_at,failure_reason,blocked_source)
      VALUES($1,$2,$3,'incoming',$4,'failed',$5,'normal',$6,$6,'number_blocked','gateway') RETURNING id`,
      [place.gatewayId,place.simId,owner,remote,place.deviceEpoch,at])).rows[0].id as string;
  const blockedSms=async(owner:string,place:{gatewayId:string;simId:string},remote:string,at:Date,key:string)=>
    (await db.query(`INSERT INTO sms_interceptions(owner_user_id,sim_id,gateway_id,remote_number,canonical_key,body,message_key,received_at,source)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7,'control') RETURNING id`,
      [owner,place.simId,place.gatewayId,remote,`intercepted ${key}`,key,at])).rows[0].id as string;
  // 120 rows on distinct timestamps, the two halves interleaved: slot 0 is the newest.
  // The `id DESC` tie-break only reorders rows that share an exact occurred_at, which none do here;
  // what it buys is a total order, without which an OFFSET could repeat or skip a row.
  const base=Date.parse('2025-06-01T00:00:00.000Z');
  const expected:string[]=[];
  for(let slot=0;slot<120;slot+=1){
    const at=new Date(base-slot*60_000);
    expected.push(slot%2===0
      ? await blockedCall(pagingOwner,mine,`+1555600${String(slot).padStart(3,'0')}`,at)
      : await blockedSms(pagingOwner,mine,`+1555601${String(slot).padStart(3,'0')}`,at,`paging-${slot}`));
  }
  for(let slot=0;slot<5;slot+=1){
    const at=new Date(base-slot*60_000);
    await blockedCall(stranger,theirs,`+1555602${String(slot).padStart(3,'0')}`,at);
    await blockedSms(stranger,theirs,`+1555603${String(slot).padStart(3,'0')}`,at,`stranger-${slot}`);
  }

  const page=async(search:string)=>{
    const response=await app.inject({method:'GET',url:`/api/v1/blocklist/interceptions?${search}`,headers:auth(pagingToken)});
    assert.equal(response.statusCode,200,response.body);
    return response.json() as {items:any[];page:number;pageSize:number;total:number;totalPages:number};
  };
  const first=await page('page=1&pageSize=50');
  assert.deepEqual(Object.keys(first).sort(),['items','page','pageSize','total','totalPages']);
  assert.equal(first.items.length,50);
  assert.equal(first.page,1);assert.equal(first.pageSize,50);
  assert.equal(first.total,120,'60 blocked calls plus 60 blocked messages, the stranger excluded');
  assert.equal(first.totalPages,3);
  assert.equal(first.items[0].id,expected[0],'the first page opens on the newest interception');
  const second=await page('page=2&pageSize=50');
  const third=await page('page=3&pageSize=50');
  assert.equal(third.items.length,20);
  assert.deepEqual([...first.items,...second.items,...third.items].map((item:any)=>item.id),expected,
    'the three pages are disjoint, ordered, and cover every row exactly once');
  assert.deepEqual([...new Set(first.items.map((item:any)=>item.kind))].sort(),['call','sms'],'a page spans both halves');
  const past=await page('page=4&pageSize=50');
  assert.deepEqual(past.items,[]);
  assert.equal(past.total,120);assert.equal(past.totalPages,3);assert.equal(past.page,4);
  assert.equal((await page('page=1')).pageSize,50);
  assert.equal((await page('page=1&pageSize=200')).totalPages,1);
  // `limit` belongs to the legacy call; while a page is asked for it is simply not consulted.
  assert.equal((await page('page=1&pageSize=50&limit=1')).items.length,50);

  // S47: filtering must precede LIMIT/OFFSET, not trim each mixed page afterward.
  assert.deepEqual(await page('page=1&pageSize=50&kind=all'),first);
  for(const kind of ['call','sms'] as const){
    const filteredIds=expected.filter((_,index)=>index%2===(kind==='call'?0:1));
    const filteredFirst=await page(`page=1&pageSize=50&kind=${kind}`);
    const filteredSecond=await page(`page=2&pageSize=50&kind=${kind}`);
    assert.equal(filteredFirst.items.length,50);
    assert.equal(filteredSecond.items.length,10);
    for(const result of [filteredFirst,filteredSecond]){
      assert.equal(result.total,60);
      assert.equal(result.totalPages,2);
      assert.ok(result.items.every(item=>item.kind===kind));
    }
    assert.deepEqual([...filteredFirst.items,...filteredSecond.items].map(item=>item.id),filteredIds);
    assert.deepEqual(filteredFirst.items[0],first.items.find(item=>item.kind===kind),
      'classification preserves the DTO and annotations');
    const filteredPast=await page(`page=3&pageSize=50&kind=${kind}`);
    assert.deepEqual(filteredPast.items,[]);
    assert.equal(filteredPast.total,60);
    const filteredLegacy=await page(`limit=7&kind=${kind}`);
    assert.deepEqual(Object.keys(filteredLegacy),['items']);
    assert.deepEqual(filteredLegacy.items.map(item=>item.id),filteredIds.slice(0,7));
  }

  const rejected=async(search:string)=>{
    const response=await app.inject({method:'GET',url:`/api/v1/blocklist/interceptions?${search}`,headers:auth(pagingToken)});
    assert.equal(response.statusCode,400,response.body);
    assert.equal(response.json().error.code,'INVALID_REQUEST');
  };
  await rejected('page=1&pageSize=25');
  await rejected('page=0');
  for(const kind of ['invalid','CALL','','call&kind=sms']){
    await rejected(`page=1&kind=${kind}`);
    await rejected(`kind=${kind}`);
  }
  await rejected('page=1&pageSize=51');

  // S64: the SIM filter is applied before paging and totals; another owner's SIM yields nothing.
  const simPage=await page(`page=1&pageSize=50&kind=call&simId=${mine.simId}`);
  assert.equal(simPage.total,60);
  assert.deepEqual(simPage.items.map(item=>item.id),expected.filter((_,index)=>index%2===0).slice(0,50));
  assert.deepEqual(await page(`page=1&pageSize=50&simId=${mine.simId}`),first);
  const foreignSim=await page(`page=1&pageSize=50&simId=${theirs.simId}`);
  assert.equal(foreignSim.total,0);assert.deepEqual(foreignSim.items,[]);
  assert.deepEqual((await page(`limit=7&simId=${theirs.simId}`)).items,[]);
  await rejected('simId=not-a-uuid');

  // Legacy: no `page`, so the envelope is exactly the one item list it has always been.
  const legacy=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions?limit=200',headers:auth(pagingToken)});
  assert.deepEqual(Object.keys(legacy.json()),['items'],'a legacy caller sees no paging keys at all');
  assert.deepEqual(legacy.json().items.map((item:any)=>item.id),expected);
  assert.deepEqual(await page('limit=200&kind=all'),legacy.json());

  // Owner isolation holds in paged mode: the stranger counts and sees only their own ten rows.
  const strangerPage=await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions?page=1&pageSize=50',headers:auth(await login('interceptions-stranger@example.test'))});
  assert.equal(strangerPage.json().total,10);
  assert.equal(strangerPage.json().items.some((item:any)=>expected.includes(item.id)),false);
  const strangerToken=await login('interceptions-stranger@example.test');
  for(const kind of ['call','sms']){
    const response=await app.inject({method:'GET',url:`/api/v1/blocklist/interceptions?page=1&pageSize=50&kind=${kind}`,headers:auth(strangerToken)});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().total,5);
    assert.equal(response.json().items.length,5);
    assert.ok(response.json().items.every((item:any)=>item.kind===kind&&!expected.includes(item.id)));
  }

});
