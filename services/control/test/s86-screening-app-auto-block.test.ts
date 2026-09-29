import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';
import { canonicalBlocklistKey } from '../src/blocklist.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const serviceToken='s86-internal-test-token-at-least-32-characters';
// S86: `buildApp` closes over this object, so the kill-switch test flips it in place.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s86-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3398,
  AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s86-test-media-secret-at-least-32-chars',TURN_SECRET:'s86-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  BUSY_CONFLICT_ENABLED:true,PIXEL_ORIGINATED_CALLS_ENABLED:true,PIXEL_ARCHIVE_ENABLED:true,
  SCREENING_APP_AUTO_BLOCK_ENABLED:true};

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
const screened={blockedLocally:true,blockSource:'phone',remoteNumber:'13300000003',screeningApp:'拦截猫'};
const callRows=async(owner:string)=>(await db.query(`SELECT canonical_key,source,source_gateway_id,source_call_id,scope FROM owner_blocked_numbers WHERE owner_user_id=$1`,[owner])).rows;
const revision=async(owner:string)=>Number((await db.query(`SELECT version FROM owner_blocklist_revisions WHERE owner_user_id=$1`,[owner])).rows[0]?.version??0);

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

test('S86: a screening-app block joins the call blocklist once, replays change nothing',async()=>{
  const owner=await userFixture('s86-add');
  const f=await gatewayFixture(owner.id,'s86-add');
  const payload={eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId:'calllog:1',simId:f.simId,observedAt:new Date().toISOString(),...screened};
  const first=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(f.deviceToken),payload});
  assert.equal(first.statusCode,202,first.body);
  const callId=(await db.query(`SELECT id FROM call_records WHERE gateway_id=$1`,[f.gatewayId])).rows[0].id;
  const rows=await callRows(owner.id);
  assert.deepEqual(rows,[{canonical_key:canonicalBlocklistKey('13300000003'),source:'phone',source_gateway_id:f.gatewayId,source_call_id:callId,scope:'call'}]);
  assert.equal(await revision(owner.id),1);
  // Same event replayed, then the same device call under a fresh event id.
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(f.deviceToken),payload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal((await incoming(f,'calllog:1',screened)).statusCode,202);
  assert.equal((await callRows(owner.id)).length,1);
  assert.equal(await revision(owner.id),1);
});

test('S86: an equivalent CN spelling already listed is not added again',async()=>{
  const owner=await userFixture('s86-equiv');
  const f=await gatewayFixture(owner.id,'s86-equiv');
  await db.query(`INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,scope)VALUES($1,$2,'+8613300000003','call')`,[owner.id,canonicalBlocklistKey('+8613300000003')]);
  assert.equal((await incoming(f,'calllog:2',screened)).statusCode,202);
  assert.equal((await callRows(owner.id)).length,1);
  assert.equal(await revision(owner.id),0);
});

test('S86: no screeningApp, or the kill switch off, adds nothing',async()=>{
  const owner=await userFixture('s86-none');
  const f=await gatewayFixture(owner.id,'s86-none');
  assert.equal((await incoming(f,'calllog:3',{...screened,screeningApp:undefined})).statusCode,202);
  (config as any).SCREENING_APP_AUTO_BLOCK_ENABLED=false;
  try{assert.equal((await incoming(f,'calllog:4',screened)).statusCode,202);}
  finally{(config as any).SCREENING_APP_AUTO_BLOCK_ENABLED=true;}
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,2);
  assert.equal((await callRows(owner.id)).length,0);
  assert.equal(await revision(owner.id),0);
});
