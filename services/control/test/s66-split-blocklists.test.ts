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
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s66-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3398,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s66-test-media-secret-at-least-32-chars',TURN_SECRET:'s66-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  PHONE_BLOCKLIST_SYNC_ENABLED:true,PHONE_BLOCKLIST_SYNC_DRY_RUN:false};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const password='correct horse battery staple';
const schemaSql=()=>readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8');

async function fixture(label:string){
  const email=`${label}@example.test`;
  const ownerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id as string;
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
  assert.equal(login.statusCode,200,login.body);
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,'SIM',true,$3,'CN')RETURNING id,version`,
    [g.id,ownerId,tokenHash(`${label}-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const deviceToken=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(deviceToken),label]);
  return {ownerId,token:login.json().token as string,gatewayId:g.id as string,deviceEpoch:Number(g.device_epoch),deviceToken,simId:sim.id as string,assignmentVersion:Number(sim.version)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const addEntry=(f:Fixture,remoteNumber:string,scope?:string)=>app.inject({method:'POST',url:'/api/v1/blocklist',
  headers:{...auth(f.token),origin:'https://vodog.test'},payload:{remoteNumber,...(scope?{scope}:{})}});
const list=(f:Fixture,query='')=>app.inject({method:'GET',url:`/api/v1/blocklist${query}`,headers:auth(f.token)});
const incomingSms=(f:Fixture,remoteNumber:string,body:string,extra:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(f.deviceToken),
  payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,simId:f.simId,assignmentVersion:f.assignmentVersion,remoteNumber,body,receivedAt:new Date().toISOString(),...extra}});
const incomingCall=(f:Fixture,remoteNumber:string)=>app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(f.deviceToken),
  payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId:`s66-${crypto.randomUUID()}`,simId:f.simId,remoteNumber,observedAt:new Date().toISOString()}});
const scoped=async(owner:string)=>(await db.query(`SELECT scope,canonical_key,source FROM owner_blocked_numbers WHERE owner_user_id=$1 ORDER BY scope,canonical_key`,[owner])).rows;

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await schemaSql());
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

test('S66 schema: pre-S66 rows become the call list and re-running the schema twice keeps them',async()=>{
  const owner=(await db.query(`INSERT INTO users(email,password_hash)VALUES('s66-legacy@example.test','x')RETURNING id`)).rows[0].id;
  // Rebuild the pre-S66 table shape (no scope, old unique) holding rows, then migrate twice.
  await db.query(`ALTER TABLE owner_blocked_numbers DROP CONSTRAINT owner_blocked_numbers_owner_scope_canonical_key_key`);
  await db.query(`ALTER TABLE owner_blocked_numbers DROP COLUMN scope`);
  await db.query(`ALTER TABLE owner_blocked_numbers ADD CONSTRAINT owner_blocked_numbers_owner_user_id_canonical_key_key UNIQUE(owner_user_id,canonical_key)`);
  await db.query(`INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number)VALUES($1,'862195559','+862195559'),($1,'13900000001','13900000001')`,[owner]);
  await db.query(await schemaSql());
  await db.query(await schemaSql());
  assert.deepEqual((await scoped(owner)).map(row=>[row.scope,row.canonical_key]),[['call','13900000001'],['call','862195559']]);
  await db.query(`INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,scope)VALUES($1,'862195559','+862195559','sms')`,[owner]);
  await assert.rejects(db.query(`INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,scope)VALUES($1,'862195559','x','sms')`,[owner]),/owner_blocked_numbers_owner_scope_canonical_key_key/);
  await assert.rejects(db.query(`INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,scope)VALUES($1,'1','1','both')`,[owner]),/owner_blocked_numbers_scope_check/);
  const index=await db.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid='owner_blocked_numbers'::regclass AND contype='u'`);
  assert.equal(index.rows[0].n,1,'only the (owner, scope, key) unique remains');
});

test('S66 API: POST/GET per scope, per-scope equivalence dedupe, 400 on a bad scope',async()=>{
  const f=await fixture('s66-api');
  const call=await addEntry(f,'+862195559');
  assert.equal(call.statusCode,201,call.body);
  assert.equal(call.json().item.scope,'call','scope defaults to call');
  const sms=await addEntry(f,'+862195559','sms');
  assert.equal(sms.statusCode,201,sms.body);
  assert.equal(sms.json().item.scope,'sms');
  assert.notEqual(sms.json().item.id,call.json().item.id);
  // An equivalent spelling dedupes within its own list only.
  const again=await addEntry(f,'95559','sms');
  assert.equal(again.statusCode,200,again.body);
  assert.equal(again.json().item.id,sms.json().item.id);
  assert.equal((await addEntry(f,'95559','call')).json().item.id,call.json().item.id);
  const smsOnly=await addEntry(f,'13700000001','sms');
  assert.equal(smsOnly.statusCode,201,smsOnly.body);

  const defaults=await list(f);
  assert.equal(defaults.statusCode,200,defaults.body);
  assert.deepEqual(defaults.json().items.map((item:any)=>[item.remoteNumber,item.scope,item.blockedEntryId]),[['+862195559','call',call.json().item.id]]);
  assert.deepEqual((await list(f,'?scope=call')).json(),defaults.json());
  assert.deepEqual((await list(f,'?scope=sms')).json().items.map((item:any)=>[item.remoteNumber,item.scope]),[['+862195559','sms'],['13700000001','sms']]);
  assert.equal((await list(f,'?scope=all')).statusCode,400);
  assert.equal((await addEntry(f,'13700000002','both')).statusCode,400);

  // DELETE by id removes one list's row only.
  const revision=async()=>Number((await db.query(`SELECT version FROM owner_blocklist_revisions WHERE owner_user_id=$1`,[f.ownerId])).rows[0].version);
  const beforeDelete=await revision();
  assert.equal((await app.inject({method:'DELETE',url:`/api/v1/blocklist/${sms.json().item.id}`,headers:{...auth(f.token),origin:'https://vodog.test'}})).statusCode,204);
  assert.equal(await revision(),beforeDelete+1);
  assert.equal((await list(f)).json().items.length,1);
});

test('S66 decisions: SMS uses only the SMS list (blockedLocally is a hint), calls only the call list',async()=>{
  const f=await fixture('s66-decide');
  assert.equal((await addEntry(f,'+862195559')).statusCode,201);
  // (1) call-listed only: stored normally, even when an old gateway dropped it locally.
  for(const blockedLocally of [undefined,true]){
    const response=await incomingSms(f,'95559',`bank ${blockedLocally}`,blockedLocally?{blockedLocally}:{});
    assert.equal(response.statusCode,201,response.body);
    assert.equal(response.json().disposition,'stored_for_owner');
    assert.ok(response.json().smsId);
  }
  const replayPayload={eventId:crypto.randomUUID(),generation:f.deviceEpoch,simId:f.simId,assignmentVersion:f.assignmentVersion,
    remoteNumber:'95559',body:'retried report',receivedAt:new Date().toISOString(),blockedLocally:true};
  const first=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(f.deviceToken),payload:replayPayload});
  assert.equal(first.statusCode,201,first.body);
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(f.deviceToken),payload:replayPayload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().smsId,first.json().smsId);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,3);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_interceptions WHERE gateway_id=$1`,[f.gatewayId])).rows[0].n,0);
  const smsRows=(await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(f.token)})).json().items;
  assert.ok(smsRows.every((item:any)=>item.blocked===false),'the call list does not flag SMS rows');

  // (2) SMS-listed: intercepted; source follows the hint.
  const smsEntry=await addEntry(f,'13700000009','sms');
  for(const [blockedLocally,source] of [[true,'gateway'],[false,'control']] as const){
    const response=await incomingSms(f,'+8613700000009',`spam ${source}`,{blockedLocally});
    assert.equal(response.statusCode,202,response.body);
    assert.equal(response.json().disposition,'dropped_blocked');
    assert.equal((await db.query(`SELECT source FROM sms_interceptions WHERE body=$1`,[`spam ${source}`])).rows[0].source,source);
  }
  // A call from an SMS-only number rings normally; the call-listed number is still rejected.
  const ring=await incomingCall(f,'13700000009');
  assert.equal(ring.statusCode,201,ring.body);
  assert.equal(ring.json().disposition,'offer_to_owner');
  const rejected=await incomingCall(f,'95559');
  assert.equal(rejected.statusCode,202,rejected.body);
  assert.equal(rejected.json().disposition,'dropped_blocked');

  // Interception feed: SMS rows point at the SMS entry, call rows at the call entry.
  const feed=(await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth(f.token)})).json().items;
  const callEntry=(await list(f)).json().items[0].id;
  assert.ok(feed.filter((item:any)=>item.kind==='sms').every((item:any)=>item.blockedEntryId===smsEntry.json().item.id));
  assert.deepEqual(feed.filter((item:any)=>item.kind==='call').map((item:any)=>item.blockedEntryId),[callEntry]);
});

test('S66 heartbeat: numbers is the call list, smsNumbers the SMS list; any change bumps the one version',async()=>{
  const f=await fixture('s66-beat');
  const beat=(version?:number)=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),
    payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true},...(version===undefined?{}:{numberBlocklistVersion:version})}});
  await addEntry(f,'13900000001');
  await addEntry(f,'13900000002','sms');
  const first=(await beat()).json().numberBlocklist;
  const item=first.items.find((row:any)=>row.simId===f.simId);
  assert.deepEqual(item.numbers.sort(),['+8613900000001','13900000001']);
  assert.deepEqual(item.smsNumbers.sort(),['+8613900000002','13900000002']);
  await addEntry(f,'13900000003','sms');
  const second=(await beat(first.version)).json().numberBlocklist;
  assert.equal(second.version,first.version+1,'an SMS-list change bumps the shared version');
  assert.ok(second.items[0].smsNumbers.includes('13900000003'));
  assert.deepEqual((await beat(second.version)).json().numberBlocklist.items,[]);
});

test('S66 phone changes: adds land in both lists, removes clear both',async()=>{
  const f=await fixture('s66-phone');
  await addEntry(f,'13900000020');
  const change=(body:{adds?:string[];removes?:string[]})=>app.inject({method:'POST',url:'/api/v1/gateway/blocklist/phone-changes',headers:auth(f.deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,adds:body.adds??[],removes:body.removes??[],observedAt:new Date().toISOString()}});
  const added=await change({adds:['+8613900000021','+8613900000020']});
  assert.equal(added.statusCode,201,added.body);
  // 13900000020 was already on the call list, but is new to the SMS list.
  assert.deepEqual(added.json(),{accepted:true,replayed:false,added:2,removed:0,rejected:0});
  assert.deepEqual((await scoped(f.ownerId)).map(row=>[row.scope,row.canonical_key,row.source]),[
    ['call','13900000020','client'],['call','8613900000021','phone'],['sms','8613900000020','phone'],['sms','8613900000021','phone']]);
  const removed=await change({removes:['13900000020','13900000021']});
  assert.deepEqual(removed.json(),{accepted:true,replayed:false,added:0,removed:2,rejected:0});
  assert.deepEqual(await scoped(f.ownerId),[]);
});
