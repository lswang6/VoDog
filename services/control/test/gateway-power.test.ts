import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
import {loadConfig} from '../src/config.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'power-test-cookie-secret-at-least-32-chars',
  GATEWAY_ONLINE_SECONDS:30,PORT:3599,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',
  MEDIA_SECRET:'power-test-media-secret-at-least-32-chars',TURN_SECRET:'power-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,GATEWAY_STANDBY_MAX_HOLD_MS:400};

let db:Db,app:FastifyInstance,ownerId:string,strangerId:string,adminId:string,gatewayId:string,simId:string,deviceEpoch:number;
let token:string,strangerToken:string,adminToken:string,deviceToken:string;
const auth=(value:string)=>({authorization:`Bearer ${value}`});
const password='correct horse battery staple';
const heartbeat=(payload:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(deviceToken),
  payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true},...payload}});

before(async()=>{
  db=createDb(databaseUrl!);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const hash=await hashPassword(password);
  ownerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('power-owner@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  strangerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('power-stranger@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  adminId=(await db.query(`INSERT INTO users(email,password_hash,role)VALUES('power-admin@example.test',$1,'admin')RETURNING id`,[hash])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('power-gateway',true,true,true,true,now())RETURNING id,device_epoch`)).rows[0];
  gatewayId=gateway.id;deviceEpoch=Number(gateway.device_epoch);
  simId=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,'SIM',true,$3,'CN')RETURNING id`,
    [gatewayId,ownerId,tokenHash('power-sim-fingerprint')])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[simId]);
  deviceToken='power-device-token-with-enough-entropy-01';
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'power')`,[gatewayId,tokenHash(deviceToken)]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),1,0,false,'[]',now())`,[gatewayId,deviceEpoch]);
  app=await buildApp(db,config);
  const login=async(email:string)=>{
    const response=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
    assert.equal(response.statusCode,200,response.body);
    return response.json().token as string;
  };
  token=await login('power-owner@example.test');
  strangerToken=await login('power-stranger@example.test');
  adminToken=await login('power-admin@example.test');
});
after(async()=>{await app.close();await db.end();});

/** Local OFF with the standby beacon allowed. */
async function standby(payload:Record<string,unknown>={}){
  return app.inject({method:'POST',url:'/api/v1/gateway/standby',headers:auth(deviceToken),
    payload:{holdMs:0,remotePowerAllowed:true,...payload}});
}

test('the standby hold ceiling is bounded to 20 s and defaults to it',()=>{
  const base={DATABASE_URL:'postgres://x/test',COOKIE_SECRET:'a'.repeat(32)};
  assert.equal(loadConfig({...base} as NodeJS.ProcessEnv).GATEWAY_STANDBY_MAX_HOLD_MS,20000);
  assert.equal(loadConfig({...base,GATEWAY_STANDBY_MAX_HOLD_MS:'5000'} as NodeJS.ProcessEnv).GATEWAY_STANDBY_MAX_HOLD_MS,5000);
  assert.throws(()=>loadConfig({...base,GATEWAY_STANDBY_MAX_HOLD_MS:'20001'} as NodeJS.ProcessEnv));
});

test('standby needs device credentials, clears controlEnabled, and never counts as online',async()=>{
  const asUser=await app.inject({method:'POST',url:'/api/v1/gateway/standby',headers:auth(token),payload:{holdMs:0,remotePowerAllowed:true}});
  assert.equal(asUser.statusCode,401,asUser.body);
  assert.equal(asUser.json().error.code,'DEVICE_UNAUTHENTICATED');
  const before=(await db.query(`SELECT last_seen_at FROM gateways WHERE id=$1`,[gatewayId])).rows[0].last_seen_at;
  const response=await standby();
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json(),{desiredPower:null,heldMs:0});
  const row=(await db.query(`SELECT control_enabled,standby_seen_at,remote_power_allowed,last_seen_at FROM gateways WHERE id=$1`,[gatewayId])).rows[0];
  assert.equal(row.control_enabled,false,'a local OFF never sends a final heartbeat, so standby clears the flag');
  assert.equal(row.remote_power_allowed,true);
  assert.ok(row.standby_seen_at);
  assert.deepEqual(row.last_seen_at,before,'the beacon must not make an OFF phone look online');
  const view=await app.inject({method:'GET',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token)});
  assert.equal(view.json().item.online,false);
  assert.equal(view.json().item.standbyOnline,true);
});

test('the power DTO shape is frozen and visibility is admin or SIM owner',async()=>{
  const mine=await app.inject({method:'GET',url:'/api/v1/gateways/power',headers:auth(token)});
  assert.equal(mine.statusCode,200,mine.body);
  assert.equal(mine.json().items.length,1);
  assert.deepEqual(Object.keys(mine.json().items[0]).sort(),['controlEnabled','desiredPower','desiredPowerRequestedAt','gatewayId','kind','lastPowerResult','lastSeenAt','name','occupied','online','remotePowerAllowed','standbyOnline','standbySeenAt'].sort());
  const stranger=await app.inject({method:'GET',url:'/api/v1/gateways/power',headers:auth(strangerToken)});
  assert.deepEqual(stranger.json(),{items:[]});
  const strangerDetail=await app.inject({method:'GET',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(strangerToken)});
  assert.equal(strangerDetail.statusCode,404,'a non-owner learns nothing, not even that the gateway exists');
  const admin=await app.inject({method:'GET',url:'/api/v1/gateways/power',headers:auth(adminToken)});
  assert.equal(admin.json().items.length,1);
  const strangerWrite=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(strangerToken),payload:{desired:'on'}});
  assert.equal(strangerWrite.statusCode,404,strangerWrite.body);
  const anonymous=await app.inject({method:'GET',url:'/api/v1/gateways/power'});
  assert.equal(anonymous.statusCode,401);
});

test('remote ON is refused without permission, refused when the beacon is stale, and consumed once',async()=>{
  await db.query(`UPDATE gateways SET remote_power_allowed=false WHERE id=$1`,[gatewayId]);
  const forbidden=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'on'}});
  assert.equal(forbidden.statusCode,409,forbidden.body);
  assert.equal(forbidden.json().error.code,'GATEWAY_REMOTE_POWER_NOT_ALLOWED');

  await db.query(`UPDATE gateways SET remote_power_allowed=true,control_enabled=false,standby_seen_at=now()-interval '90 seconds' WHERE id=$1`,[gatewayId]);
  const stale=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'on'}});
  assert.equal(stale.statusCode,409,stale.body);
  assert.equal(stale.json().error.code,'GATEWAY_STANDBY_OFFLINE');

  await standby();
  const accepted=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'on'}});
  assert.equal(accepted.statusCode,202,accepted.body);
  assert.equal(accepted.json().item.desiredPower,'on');
  // Consume on delivery: the first standby poll takes it and the next one sees nothing, so a
  // gateway whose enable gate refuses cannot hot-loop on the same intent.
  const delivered=await standby();
  assert.equal(delivered.json().desiredPower,'on');
  const second=await standby();
  assert.equal(second.json().desiredPower,null);
  assert.equal((await db.query(`SELECT desired_power FROM gateways WHERE id=$1`,[gatewayId])).rows[0].desired_power,null);
});

test('an unclaimed power intent expires after two minutes',async()=>{
  await standby();
  const accepted=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'on'}});
  assert.equal(accepted.statusCode,202,accepted.body);
  await db.query(`UPDATE gateways SET desired_power_requested_at=now()-interval '3 minutes' WHERE id=$1`,[gatewayId]);
  const view=await app.inject({method:'GET',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token)});
  assert.equal(view.json().item.desiredPower,null,'an expired intent reads as absent');
  const late=await standby();
  assert.equal(late.json().desiredPower,null,'and is never delivered');
  await db.query(`UPDATE gateways SET desired_power=NULL,desired_power_requested_at=NULL WHERE id=$1`,[gatewayId]);
});

test('a suspended standby request wakes on the intent instead of waiting out its hold',async()=>{
  await standby();
  const started=Date.now();
  const held=standby({holdMs:400});
  await new Promise(resolve=>setTimeout(resolve,60));
  const accepted=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'on'}});
  assert.equal(accepted.statusCode,202,accepted.body);
  const response=await held;
  assert.equal(response.json().desiredPower,'on');
  assert.ok(Date.now()-started<380,'the waiter was rung, it did not time out');
});

test('the last power result travels on standby and on the heartbeat',async()=>{
  const at=new Date().toISOString();
  await standby({lastPowerResult:{desired:'on',ok:false,reason:'battery_optimised',at}});
  const afterStandby=await app.inject({method:'GET',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token)});
  assert.deepEqual(afterStandby.json().item.lastPowerResult,{desired:'on',ok:false,reason:'battery_optimised',at});
  const beat=await heartbeat({remotePowerAllowed:true,lastPowerResult:{desired:'on',ok:true,at}});
  assert.equal(beat.statusCode,200,beat.body);
  const afterHeartbeat=await app.inject({method:'GET',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token)});
  assert.deepEqual(afterHeartbeat.json().item.lastPowerResult,{desired:'on',ok:true,reason:null,at});
  // A fresh write clears the stale result so the UI never shows last round's failure.
  await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'off'}});
  const cleared=await app.inject({method:'GET',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token)});
  assert.equal(cleared.json().item.lastPowerResult,null);
});

test('remote OFF rides the heartbeat, is consumed on delivery, and refuses an occupied gateway',async()=>{
  const delivered=await heartbeat();
  assert.equal(delivered.statusCode,200,delivered.body);
  assert.equal(delivered.json().desiredPower,'off');
  const again=await heartbeat();
  assert.equal(again.json().desiredPower,null);

  // An old gateway that sends neither new field still gets a 200, and a new one talking to it
  // sees `desiredPower` as an additive field.
  assert.ok('desiredPower' in again.json());

  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,answered_at)
    VALUES($1,$2,$3,'incoming','active',$4,'normal',now())RETURNING id`,[gatewayId,simId,ownerId,deviceEpoch])).rows[0];
  await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[gatewayId,call.id,deviceEpoch]);
  const busy=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'off'}});
  assert.equal(busy.statusCode,409,busy.body);
  assert.equal(busy.json().error.code,'GATEWAY_IN_USE');
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[call.id]);
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[call.id]);

  // Already ON: a redundant remote ON is idempotent and writes nothing.
  const redundant=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'on'}});
  assert.equal(redundant.statusCode,200,redundant.body);
  assert.equal(redundant.json().item.online,true);
  assert.equal((await db.query(`SELECT desired_power FROM gateways WHERE id=$1`,[gatewayId])).rows[0].desired_power,null);

  await db.query(`UPDATE gateways SET control_enabled=false WHERE id=$1`,[gatewayId]);
  const offline=await app.inject({method:'POST',url:`/api/v1/gateways/${gatewayId}/power`,headers:auth(token),payload:{desired:'off'}});
  assert.equal(offline.statusCode,409,offline.body);
  assert.equal(offline.json().error.code,'GATEWAY_OFFLINE');
});

test('S58: heartbeat kind updates gateways.kind and surfaces on sims, calls, admin gateways and power',async()=>{
  const kindOf=async()=>(await db.query(`SELECT kind FROM gateways WHERE id=$1`,[gatewayId])).rows[0].kind;
  assert.equal(await kindOf(),'pixel','the column defaults to pixel');
  const bad=await heartbeat({kind:'nokia'});
  assert.equal(bad.statusCode,400,bad.body);
  assert.equal(await kindOf(),'pixel');
  const callId=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,started_at,ended_at)
    VALUES($1,$2,$3,'incoming','10086','ended',$4,'normal',now(),now())RETURNING id`,[gatewayId,simId,ownerId,deviceEpoch])).rows[0].id;
  try{
    const dji=await heartbeat({kind:'dji4g'});
    assert.equal(dji.statusCode,200,dji.body);
    assert.equal(await kindOf(),'dji4g');
    const omitted=await heartbeat();
    assert.equal(omitted.statusCode,200,omitted.body);
    assert.equal(await kindOf(),'dji4g','an old gateway that omits kind keeps the stored value');
    const sims=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(token)});
    assert.equal(sims.statusCode,200,sims.body);
    assert.equal(sims.json().items[0].gatewayKind,'dji4g');
    const calls=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
    assert.equal(calls.statusCode,200,calls.body);
    const byId=new Map(calls.json().items.map((item:any)=>[item.id,item]));
    assert.equal((byId.get(callId) as any).gatewayKind,'dji4g');
    const detail=await app.inject({method:'GET',url:`/api/v1/calls/${callId}`,headers:auth(token)});
    assert.equal(detail.json().call.gatewayKind,'dji4g');
    const admin=await app.inject({method:'GET',url:'/api/v1/admin/gateways',headers:auth(adminToken)});
    assert.equal(admin.statusCode,200,admin.body);
    assert.equal(admin.json().items.find((item:any)=>item.id===gatewayId).kind,'dji4g');
    const power=await app.inject({method:'GET',url:'/api/v1/gateways/power',headers:auth(token)});
    assert.equal(power.json().items[0].kind,'dji4g');
    const back=await heartbeat({kind:'pixel'});
    assert.equal(back.statusCode,200,back.body);
    assert.equal(await kindOf(),'pixel');
  }finally{
    await db.query(`DELETE FROM call_records WHERE id=$1`,[callId]);
    await db.query(`UPDATE gateways SET kind='pixel' WHERE id=$1`,[gatewayId]);
  }
});
