import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { annotateNumbers } from '../src/contacts/repository.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
// `buildApp` closes over this object and the route reads the mode per request, so tests flip it in place.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s55-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s55-test-media-secret-at-least-32-chars',TURN_SECRET:'s55-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  PHONE_BLOCKLIST_SYNC_ENABLED:true,PHONE_BLOCKLIST_SYNC_DRY_RUN:false};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const password='correct horse battery staple';
const schemaSql=()=>readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8');

async function userFixture(label:string){
  const email=`${label}@example.test`;
  const id=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id as string;
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
  assert.equal(login.statusCode,200,login.body);
  return {id,token:login.json().token as string};
}
/** One gateway with a SIM per listed owner; `absentOwner` holds a SIM that is not present. */
async function gatewayFixture(label:string,owners:string[],absentOwner?:string){
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const simIds:string[]=[];
  for(const [slot,owner] of [...owners,absentOwner].entries()){
    if(!owner)continue;
    const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,$2,$3,$4,$5,$6)RETURNING id`,
      [g.id,slot,owner,`${label} SIM ${slot}`,owner!==absentOwner,tokenHash(`${label}-${slot}-fingerprint`)])).rows[0];
    await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
    simIds.push(sim.id);
  }
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  return {gatewayId:g.id as string,deviceEpoch:Number(g.device_epoch),deviceToken:token,simIds};
}
type Gateway=Awaited<ReturnType<typeof gatewayFixture>>;
const phoneChanges=(g:Gateway,body:{adds?:string[];removes?:string[];eventId?:string;generation?:number;observedAt?:string})=>app.inject({
  method:'POST',url:'/api/v1/gateway/blocklist/phone-changes',headers:auth(g.deviceToken),
  payload:{eventId:body.eventId??crypto.randomUUID(),generation:body.generation??g.deviceEpoch,adds:body.adds??[],removes:body.removes??[],observedAt:body.observedAt??new Date().toISOString()},
});
const heartbeat=(g:Gateway,numberBlocklistVersion?:number)=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(g.deviceToken),
  payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true},
    ...(numberBlocklistVersion===undefined?{}:{numberBlocklistVersion})}});
// S66: phone changes land in both lists; `entries` reads one of them (the call list unless told).
const entries=async(owner:string,scope:'call'|'sms'='call')=>(await db.query(
  `SELECT canonical_key,remote_number,source,source_gateway_id FROM owner_blocked_numbers WHERE owner_user_id=$1 AND scope=$2 ORDER BY canonical_key`,[owner,scope])).rows;
const revision=async(owner:string)=>Number((await db.query(`SELECT version FROM owner_blocklist_revisions WHERE owner_user_id=$1`,[owner])).rows[0]?.version??0);
const block=async(owner:string,remote:string)=>db.query(
  `INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number)VALUES($1,$2,$2)`,[owner,remote.replace(/^\+/,'')]);
function setMode(enabled:boolean,dryRun:boolean){config.PHONE_BLOCKLIST_SYNC_ENABLED=enabled;config.PHONE_BLOCKLIST_SYNC_DRY_RUN=dryRun;}

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  // S55: the schema is compatible-additive, so applying it twice must succeed and change nothing.
  await db.query(await schemaSql());
  await db.query(await schemaSql());
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

test('S55 schema: source defaults to client, rejects unknown values, and the gateway FK nulls on delete',async()=>{
  await db.query(await schemaSql());
  const owner=await userFixture('s55-schema');
  const g=await gatewayFixture('s55-schema',[owner.id]);
  await block(owner.id,'13900000001');
  assert.deepEqual((await entries(owner.id)).map(row=>row.source),['client']);
  await assert.rejects(db.query(`UPDATE owner_blocked_numbers SET source='web' WHERE owner_user_id=$1`,[owner.id]),/owner_blocked_numbers_source_check/);
  await db.query(`UPDATE owner_blocked_numbers SET source='phone',source_gateway_id=$2 WHERE owner_user_id=$1`,[owner.id,g.gatewayId]);
  await db.query(`DELETE FROM device_credentials WHERE gateway_id=$1`,[g.gatewayId]);
  await db.query(`DELETE FROM sims WHERE gateway_id=$1`,[g.gatewayId]);
  await db.query(`DELETE FROM gateways WHERE id=$1`,[g.gatewayId]);
  assert.deepEqual((await entries(owner.id)).map(row=>[row.source,row.source_gateway_id]),[['phone',null]]);
});

test('S55: the route answers 409 PHONE_SYNC_DISABLED unless phoneSync is on, and heartbeat carries the mode',async()=>{
  const owner=await userFixture('s55-modes');
  const g=await gatewayFixture('s55-modes',[owner.id]);
  await block(owner.id,'13900000002');
  try{
    for(const [enabled,dryRun,mode] of [[false,false,'off'],[false,true,'off'],[true,true,'dry_run'],[true,false,'on']] as const){
      setMode(enabled,dryRun);
      const beat=await heartbeat(g);
      assert.equal(beat.statusCode,200,beat.body);
      assert.equal(beat.json().numberBlocklist.phoneSync,mode);
      // The version-match short circuit still carries the mode.
      const version=beat.json().numberBlocklist.version;
      const short=await heartbeat(g,version);
      assert.deepEqual(short.json().numberBlocklist,{version,items:[],phoneSync:mode});
      const response=await phoneChanges(g,{adds:['13900000003']});
      if(mode==='on'){assert.equal(response.statusCode,201,response.body);continue;}
      assert.equal(response.statusCode,409,response.body);
      assert.equal(response.json().error?.code??response.json().code,'PHONE_SYNC_DISABLED');
    }
    // No gateway SIM at all still reports the mode.
    const empty=await gatewayFixture('s55-modes-empty',[]);
    assert.deepEqual((await heartbeat(empty)).json().numberBlocklist,{version:0,items:[],phoneSync:'on'});
  }finally{setMode(true,false);}
  assert.deepEqual((await entries(owner.id)).map(row=>row.canonical_key),['13900000002','13900000003']);
  assert.deepEqual((await entries(owner.id,'sms')).map(row=>row.canonical_key),['13900000003']);
});

test('S55: adds and removes apply to every present owner, bump revisions, and replay exactly',async()=>{
  const a=await userFixture('s55-owner-a'),b=await userFixture('s55-owner-b'),absent=await userFixture('s55-owner-absent');
  const g=await gatewayFixture('s55-multi',[a.id,b.id],absent.id);
  await block(a.id,'13900000010');
  await block(b.id,'13900000010');
  const before={a:await revision(a.id),b:await revision(b.id),absent:await revision(absent.id)};
  const eventId=crypto.randomUUID();
  const payload={eventId,observedAt:new Date().toISOString(),adds:['+8613900000011','112','13900000011'],removes:['13900000010','911']};
  const first=await phoneChanges(g,payload);
  assert.equal(first.statusCode,201,first.body);
  // Per reported number: 13900000011 once (its two spellings are one number), 13900000010 once, two emergency rejects.
  assert.deepEqual(first.json(),{accepted:true,replayed:false,added:1,removed:1,rejected:2});
  for(const owner of [a.id,b.id])for(const scope of ['call','sms'] as const){
    assert.deepEqual(await entries(owner,scope),[{canonical_key:'8613900000011',remote_number:'+8613900000011',source:'phone',source_gateway_id:g.gatewayId}]);
  }
  assert.deepEqual(await entries(absent.id),[]);
  assert.equal(await revision(a.id),before.a+1);
  assert.equal(await revision(b.id),before.b+1);
  assert.equal(await revision(absent.id),before.absent);

  const replay=await phoneChanges(g,payload);
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),{accepted:true,replayed:true,added:1,removed:1,rejected:2});
  assert.equal(await revision(a.id),before.a+1);
  const reused=await phoneChanges(g,{...payload,adds:['13900000012']});
  assert.equal(reused.statusCode,409,reused.body);
  assert.match(reused.body,/EVENT_ID_REUSED/);
  const stale=await phoneChanges(g,{adds:['13900000013'],generation:g.deviceEpoch+1});
  assert.equal(stale.statusCode,409,stale.body);
  assert.match(stale.body,/FENCE_REJECTED/);
  assert.equal((await entries(a.id)).length,1);

  // Nothing changed: no revision bump.
  const noop=await phoneChanges(g,{adds:['13900000011'],removes:['13900000099']});
  assert.deepEqual(noop.json(),{accepted:true,replayed:false,added:0,removed:0,rejected:0});
  assert.equal(await revision(a.id),before.a+1);

  const listed=await app.inject({method:'GET',url:'/api/v1/blocklist',headers:auth(a.token)});
  assert.equal(listed.statusCode,200,listed.body);
  assert.deepEqual(listed.json().items.map((item:any)=>[item.remoteNumber,item.source]),[['+8613900000011','phone']]);
  const created=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:{...auth(a.token),origin:'https://vodog.test'},payload:{remoteNumber:'13900000014'}});
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.json().item.source,'client');
  const diag=await db.query(`SELECT fields FROM diag_events WHERE event='blocklist.phone_changes' AND fields->>'gatewayId'=$1 ORDER BY ts`,[g.gatewayId]);
  assert.deepEqual(diag.rows[0]?.fields,{gatewayId:g.gatewayId,added:1,removed:1,rejected:2,owners:2});
});

test('S55: CN spellings are one number for phone adds, phone removes and incoming matching',async()=>{
  const owner=await userFixture('s55-cn');
  const g=await gatewayFixture('s55-cn',[owner.id]);
  for(const key of ['075595501','10101196','10105501','075583765432'])await block(owner.id,key);
  const added=await phoneChanges(g,{adds:['+8675595501','+8610101196','+8610105501','+85295008']});
  assert.equal(added.statusCode,201,added.body);
  // S66: only 85295008 is new to the call list, but all four are new to the (empty) SMS list.
  assert.deepEqual(added.json(),{accepted:true,replayed:false,added:4,removed:0,rejected:0});
  assert.deepEqual((await entries(owner.id)).map(row=>[row.canonical_key,row.source]),
    [['075583765432','client'],['075595501','client'],['10101196','client'],['10105501','client'],['85295008','phone']]);
  assert.deepEqual((await entries(owner.id,'sms')).map(row=>[row.canonical_key,row.source]),
    [['85295008','phone'],['8610101196','phone'],['8610105501','phone'],['8675595501','phone']]);

  // Incoming matching, annotations included: a service code behind an area code equals the bare code.
  const annotated=await annotateNumbers(db,owner.id,[{remoteNumber:'95501'},{remoteNumber:'+8675595501'},{remoteNumber:'83765432'},
    {remoteNumber:'95008'},{remoteNumber:'+8675583765432'},{remoteNumber:'91234567'}],'call');
  assert.deepEqual(annotated.map(row=>row.blocked),[true,true,false,true,true,false]);
  const call=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(g.deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:g.deviceEpoch,deviceCallId:'s55-service-call',simId:g.simIds[0],remoteNumber:'95501',observedAt:new Date().toISOString()}});
  assert.equal(call.statusCode,202,call.body);
  assert.equal(call.json().disposition,'dropped_blocked');

  const removed=await phoneChanges(g,{removes:['+8675595501','+8610105501']});
  assert.deepEqual(removed.json(),{accepted:true,replayed:false,added:0,removed:2,rejected:0});
  assert.deepEqual((await entries(owner.id)).map(row=>row.canonical_key),['075583765432','10101196','85295008']);
  assert.deepEqual((await entries(owner.id,'sms')).map(row=>row.canonical_key),['85295008','8610101196']);
});

test('S55: a client add of an equivalent CN spelling returns the existing entry',async()=>{
  const owner=await userFixture('s55-client-dedupe');
  await block(owner.id,'075595501');
  const existing=(await db.query(`SELECT id FROM owner_blocked_numbers WHERE owner_user_id=$1`,[owner.id])).rows[0].id;
  const before=await revision(owner.id);
  const again=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:{...auth(owner.token),origin:'https://vodog.test'},payload:{remoteNumber:'+8675595501'}});
  assert.equal(again.statusCode,200,again.body);
  assert.equal(again.json().item.id,existing);
  assert.equal(again.json().item.remoteNumber,'075595501');
  assert.equal(await revision(owner.id),before);
  assert.deepEqual((await entries(owner.id)).map(row=>row.canonical_key),['075595501']);
});
