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
// `buildApp` closes over this object; tests flip EARLY_MEDIA_ENABLED per case.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s56-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s56-test-media-secret-at-least-32-chars',TURN_SECRET:'s56-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  PIXEL_ORIGINATED_CALLS_ENABLED:false,PIXEL_ARCHIVE_ENABLED:true,EARLY_MEDIA_ENABLED:false};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

async function fixture(label:string){
  const owner=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[`${label}@example.test`,await hashPassword('correct horse battery staple')])).rows[0].id as string;
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id`,[g.id,owner,`${label} SIM`,tokenHash(`${label}-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  const call=async(direction:string,state:string,deviceCallId:string)=>(await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,originating_platform,device_call_id,media_node_id,started_at,answered_at)
     VALUES($1,$2,$3,$4,'10086',$5,$6,'normal','web',$7,'relay-primary',now(),$8) RETURNING id`,[g.id,sim.id,owner,direction,state,g.device_epoch,deviceCallId,state==='active'?new Date():null])).rows[0].id as string;
  return {gatewayId:g.id as string,token,call};
}
const withEarly=async(on:boolean,fn:()=>Promise<void>)=>{(config as any).EARLY_MEDIA_ENABLED=on;try{await fn();}finally{(config as any).EARLY_MEDIA_ENABLED=false;}};
const options=(token:string,callId:string)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/media/options`,headers:auth(token),payload:{transport:'udp'}});
const bind=(token:string,callId:string,deviceCallId:string)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(token),
  payload:{deviceCallId,telecomCreationTimeMillis:1758000000000}});

test('S56: capture-less media/options only for an unanswered outgoing call while the flag is on',async()=>{
  const f=await fixture('s56-options');
  const out=await f.call('outgoing','connecting','telecom-1');
  const pending=await f.call('outgoing','outgoing_pending','telecom-2');
  const inc=await f.call('incoming','connecting','telecom-3');
  const active=await f.call('outgoing','active','telecom-4');
  const off=await options(f.token,out);
  assert.equal(off.statusCode,409,off.body);assert.equal(off.json().error.code,'CAPTURE_BINDING_REQUIRED');
  await withEarly(true,async()=>{
    for(const id of [out,pending]){
      const ok=await options(f.token,id);
      assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().mediaNodeId,'relay-primary');assert.equal(ok.json().captureBinding,undefined);
    }
    for(const id of [inc,active]){
      const refused=await options(f.token,id);
      assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_BINDING_REQUIRED');
    }
    // An early leg racing the hangup reads as revoked, not as a missing capture identity.
    const ending=await f.call('outgoing','ending','telecom-5');
    const revoked=await options(f.token,ending);
    assert.equal(revoked.statusCode,409,revoked.body);assert.equal(revoked.json().error.code,'MEDIA_REVOKED');
  });
});

test('S56: capture-binding serves an active Control-placed outgoing call only while the flag is on',async()=>{
  const f=await fixture('s56-capture');
  const callId=await f.call('outgoing','connecting','telecom-10');
  const off=await bind(f.token,callId,'telecom-10');
  assert.equal(off.statusCode,503,off.body);assert.equal(off.json().error.code,'CAPTURE_DISABLED');
  await withEarly(true,async()=>{
    const early=await bind(f.token,callId,'telecom-10');
    assert.equal(early.statusCode,409,early.body);assert.equal(early.json().error.code,'CAPTURE_NOT_ACTIVE');
    await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[callId]);
    await db.query(`UPDATE gateway_telecom_snapshots SET calls=$2::jsonb,observed_at=now() WHERE gateway_id=$1`,
      [f.gatewayId,JSON.stringify([{callId,deviceCallId:'telecom-10',state:'active'}])]);
    const bound=await bind(f.token,callId,'telecom-10');
    assert.equal(bound.statusCode,200,bound.body);
    assert.equal(bound.json().captureBinding.callId,callId);assert.equal(bound.json().captureBinding.mediaNodeId,'relay-primary');
    const inc=await f.call('incoming','active','telecom-11');
    const refused=await bind(f.token,inc,'telecom-11');
    assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_NOT_ACTIVE');
  });
});

test('S56: every heartbeat answer carries earlyMedia',async()=>{
  const f=await fixture('s56-heartbeat');
  const beat=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.token),
    payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  const off=await beat();assert.equal(off.statusCode,200,off.body);assert.equal(off.json().earlyMedia,false);
  await withEarly(true,async()=>{const on=await beat();assert.equal(on.statusCode,200,on.body);assert.equal(on.json().earlyMedia,true);});
});
