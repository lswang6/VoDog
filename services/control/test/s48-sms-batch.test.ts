import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test,{before,after} from 'node:test';
import {buildApp} from '../src/app.js';
import {createDb} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.includes('test'))throw new Error('isolated TEST_DATABASE_URL required');
const db=createDb(url);let app:Awaited<ReturnType<typeof buildApp>>,owner:string,other:string,token:string;
const config={DATABASE_URL:url,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-only-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,TRANSCRIPTION_ENABLED:false,COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};
const auth=(t:string)=>({authorization:`Bearer ${t}`});
before(async()=>{
 await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
 await db.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));
 await db.query(await readFile(new URL('../src/transcription/schema.sql',import.meta.url),'utf8'));
 const hash=await hashPassword('correct horse battery staple');
 owner=(await db.query(`INSERT INTO users(email,password_hash) VALUES('s48@example.test',$1) RETURNING id`,[hash])).rows[0].id;
 other=(await db.query(`INSERT INTO users(email,password_hash) VALUES('s48-other@example.test',$1) RETURNING id`,[hash])).rows[0].id;
 app=await buildApp(db,config);
 const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'s48@example.test',password:'correct horse battery staple',platform:'android'}});assert.equal(r.statusCode,200,r.body);token=r.json().token;
});
after(async()=>{await app?.close();await db.end();});
async function fixture(){
 const g=(await db.query(`INSERT INTO gateways(name,control_enabled,sms_ready,telephony_ready,media_ready,last_seen_at) VALUES('s48',true,true,true,true,now()) RETURNING *`)).rows[0];
 const sims=[];for(let slot=0;slot<2;slot++)sims.push((await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso) VALUES($1,$2,$3,'s48',true,$4,'CN') RETURNING id`,[g.id,slot,owner,crypto.randomUUID()])).rows[0].id);
 const device=crypto.randomUUID();await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label) VALUES($1,$2,'s48')`,[g.id,tokenHash(device)]);
 return {id:g.id,sims,device,epoch:Number(g.device_epoch)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const batch=(f:Fixture,recipients=['13800001234','13900139000'],key=crypto.randomUUID(),slot=0)=>app.inject({method:'POST',url:'/api/v1/sms/batch',headers:{...auth(token),'idempotency-key':key},payload:{simId:f.sims[slot],recipients,body:'test'}});
async function heartbeat(f:Fixture){const r=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.device),payload:{controlEnabled:true,reportedSequence:0,capabilities:{smsReady:true,telephonyReady:true,mediaReady:true}}});assert.equal(r.statusCode,200,r.body);return r.json().commands as any[];}
const smsCommands=async(f:Fixture)=>(await heartbeat(f)).filter(x=>x.kind==='send_sms');
async function ack(f:Fixture,id:string,extra:any={}){const r=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${id}/ack`,headers:auth(f.device),payload:{generation:f.epoch,status:'acked',result:{phase:'submitted'},...extra}});assert.equal(r.statusCode,200,r.body);return r;}
const due=(f:Fixture)=>db.query(`UPDATE gateway_sms_pacing SET next_release_at=clock_timestamp()-interval '1 second' WHERE gateway_id=$1`,[f.id]);
const count=async(f:Fixture)=>Number((await db.query(`SELECT count(*) FROM commands WHERE gateway_id=$1 AND kind='send_sms'`,[f.id])).rows[0].count);
async function terminal(f:Fixture,id:string,state='sent'){const r=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${id}/events`,headers:auth(f.device),payload:{eventId:crypto.randomUUID(),generation:f.epoch,state}});assert.equal(r.statusCode,200,r.body);}

test('atomic validation, owner checks and canonical deduplication preserve first order',async()=>{
 const f=await fixture();
 for(const recipients of [[],Array(101).fill('13800001234'),['13800001234','bad'],['  ']])assert.equal((await batch(f,recipients)).statusCode,400);
 await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[f.sims[0],other]);assert.equal((await batch(f)).statusCode,404);
 assert.equal(await count(f),0);assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1`,[f.id])).rows[0].n,0);
 await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[f.sims[0],owner]);
 const r=await batch(f,[' 13800001234 ','+86 138-0000-1234','13900139000']);assert.equal(r.statusCode,202,r.body);
 assert.deepEqual(r.json().items.map((x:any)=>x.remoteNumber),['+8613800001234','+8613900139000']);assert.equal(r.json().intervalSeconds,5);assert.equal(await count(f),1);
});
test('concurrent idempotency replay/conflict and replay survives SMS deletion',async()=>{
 const f=await fixture(),key=crypto.randomUUID();const results=await Promise.all([batch(f,undefined,key),batch(f,undefined,key)]);
 assert.deepEqual(results.map(x=>x.statusCode).sort(),[200,202]);assert.deepEqual(results[0].json(),results[1].json());
 assert.equal((await batch(f,['10086'],key)).statusCode,409);
 const first=results[0].json();await db.query(`DELETE FROM sms_messages WHERE id=ANY($1::uuid[])`,[first.items.map((x:any)=>x.id)]);
 const replay=await batch(f,undefined,key);assert.equal(replay.statusCode,410,replay.body);assert.equal(replay.json().error.code,'SMS_BATCH_DELETED');assert.equal(await count(f),1);
});
test('gateway-wide concurrent batches and legacy single share ACK spacing, restart and no catchup',async()=>{
 const f=await fixture();const r=await Promise.all([batch(f),batch(f,['10086','10010'],crypto.randomUUID(),1)]);assert.ok(r.every(x=>x.statusCode===202));assert.equal(await count(f),1);
 const first=(await smsCommands(f))[0];assert.equal((await smsCommands(f))[0].id,first.id);
 const single=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.sims[0],remoteNumber:'10000',body:'single'}});assert.equal(single.statusCode,202,single.body);assert.equal(single.json().command,null);
 await ack(f,first.id);assert.deepEqual(await smsCommands(f),[]);
 const pace=(await db.query(`SELECT next_release_at-clock_timestamp() gap FROM gateway_sms_pacing WHERE gateway_id=$1`,[f.id])).rows[0];assert.ok(pace.gap.seconds>=4);
 await app.close();app=await buildApp(db,config);assert.deepEqual(await smsCommands(f),[]);
 await due(f);await db.query(`UPDATE gateways SET last_seen_at=now()-interval '1 hour' WHERE id=$1`,[f.id]);
 const next=(await smsCommands(f))[0];assert.ok(next);assert.notEqual(next.id,first.id);assert.equal(await count(f),2);assert.equal((await smsCommands(f))[0].id,next.id);
 const ttl=(await db.query(`SELECT extract(epoch FROM expires_at-created_at) ttl FROM commands WHERE id=$1`,[next.id])).rows[0];assert.ok(Number(ttl.ttl)>=119);
});
test('unknown execution ACK blocks visibly and terminal bound outcome releases at observed plus five',async()=>{
 const f=await fixture();const queued=(await batch(f)).json();const first=(await smsCommands(f))[0];
 await ack(f,first.id,{status:'rejected',sideEffectDisposition:'unknown',result:{phase:'unknown',reason:'execution_unknown'}});await due(f);
 assert.deepEqual(await smsCommands(f),[]);assert.equal(await count(f),1);
 const waiting=(await db.query(`SELECT state,failure_reason FROM sms_messages WHERE id=$1`,[queued.items[1].id])).rows[0];assert.equal(waiting.state,'queued');assert.equal(waiting.failure_reason,'sms_gateway_execution_unresolved');
 await terminal(f,queued.items[0].id);assert.deepEqual(await smsCommands(f),[]);await due(f);assert.equal((await smsCommands(f)).length,1);assert.equal(await count(f),2);
});
test('expired exposed command remains unknown; late ACK then cooldown; never exposed expiry safely fails',async()=>{
 const f=await fixture();const queued=(await batch(f)).json();const first=(await smsCommands(f))[0];await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[first.id]);
 assert.deepEqual(await smsCommands(f),[]);assert.equal(await count(f),1);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[queued.items[0].id])).rows[0].state,'unknown');
 await ack(f,first.id);assert.deepEqual(await smsCommands(f),[]);await due(f);assert.equal((await smsCommands(f)).length,1);
 const g=await fixture();const unsent=(await batch(g)).json();await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE gateway_id=$1 AND kind='send_sms'`,[g.id]);assert.equal((await smsCommands(g)).length,1);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[unsent.items[0].id])).rows[0].state,'failed');
});
test('route or epoch changes fail unreleased rows, exposed epoch ambiguity remains visible',async()=>{
 for(const change of ['owner','epoch','version']){
  const f=await fixture(),queued=(await batch(f)).json();await smsCommands(f);
  if(change==='owner')await db.query(`UPDATE sims SET owner_user_id=$2,version=version+1 WHERE id=$1`,[f.sims[0],other]);
  if(change==='epoch')await db.query(`UPDATE gateways SET device_epoch=device_epoch+1 WHERE id=$1`,[f.id]);
  if(change==='version')await db.query(`UPDATE sims SET version=version+1 WHERE id=$1`,[f.sims[0]]);
  await heartbeat(f);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[queued.items[1].id])).rows[0].state,'failed');assert.equal(await count(f),1);
 }
});
test('SIM note CAS does not invalidate pending SMS route',async()=>{
 const f=await fixture(),queued=(await batch(f)).json();const first=(await smsCommands(f))[0];
 const r=await app.inject({method:'PUT',url:`/api/v1/sims/${f.sims[0]}`,headers:auth(token),payload:{label:'changed label',expectedVersion:1}});assert.equal(r.statusCode,200,r.body);
 await ack(f,first.id);await due(f);assert.equal((await smsCommands(f))[0].smsId,queued.items[1].id);
});
test('legacy multi-command upgrade obeys cooldown and does not hold call commands',async()=>{
 const f=await fixture();const ids=[];
 for(let i=1;i<=2;i++)ids.push((await db.query(`INSERT INTO commands(gateway_id,generation,sequence,kind,payload,expires_at) VALUES($1,$2,$3,'send_sms','{}',now()+interval '2 minutes') RETURNING id`,[f.id,f.epoch,i])).rows[0].id);
 await db.query(`UPDATE gateways SET command_sequence=2 WHERE id=$1`,[f.id]);assert.equal((await smsCommands(f))[0].id,ids[0]);await ack(f,ids[0]);assert.deepEqual(await smsCommands(f),[]);
 await db.query(`INSERT INTO commands(gateway_id,generation,sequence,kind,payload,expires_at) VALUES($1,$2,3,'hangup','{}',now()+interval '2 minutes')`,[f.id,f.epoch]);assert.ok((await heartbeat(f)).some(x=>x.kind==='hangup'));
 await due(f);assert.equal((await smsCommands(f))[0].id,ids[1]);
});

test('known no-effect ACK and terminal failure recover safely without a replacement command',async()=>{
 const f=await fixture(),queued=(await batch(f)).json(),first=(await smsCommands(f))[0];
 await ack(f,first.id,{status:'rejected',sideEffectDisposition:'not_executed',result:{phase:'not_executed',reason:'send_sms_permission_missing'}});
 assert.deepEqual(await smsCommands(f),[]);await due(f);const next=(await smsCommands(f))[0];assert.equal(next.smsId,queued.items[1].id);assert.equal(await count(f),2);
 const g=await fixture(),messages=(await batch(g)).json(),cmd=(await smsCommands(g))[0];
 await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[cmd.id]);await heartbeat(g);await terminal(g,messages.items[0].id,'failed');
 assert.deepEqual(await smsCommands(g),[]);await due(g);assert.equal((await smsCommands(g))[0].smsId,messages.items[1].id);assert.equal(await count(g),2);
});
test('epoch rotation before first heartbeat fails only old unsent work and permits a new batch',async()=>{
 const f=await fixture(),old=(await batch(f)).json();await db.query(`UPDATE gateways SET device_epoch=device_epoch+1 WHERE id=$1`,[f.id]);f.epoch++;
 assert.deepEqual(await smsCommands(f),[]);assert.ok((await db.query(`SELECT state FROM sms_messages WHERE id=ANY($1::uuid[])`,[old.items.map((x:any)=>x.id)])).rows.every(x=>x.state==='failed'));
 const r=await batch(f,['10086']);assert.equal(r.statusCode,202,r.body);assert.equal((await smsCommands(f))[0].smsId,r.json().items[0].id);
});
test('late bound ACK after server route rejection is accepted once and cooldown preserved',async()=>{
 const {commandReplayFingerprint}=await import('../src/replay-horizon.js');
 const f=await fixture(),queued=(await batch(f)).json(),first=(await smsCommands(f))[0];
 const cmd=(await db.query(`SELECT * FROM commands WHERE id=$1`,[first.id])).rows[0];
 await db.query(`UPDATE commands SET status='rejected',result='{"reason":"sim_route_changed"}' WHERE id=$1`,[first.id]);
 const extra={replayEvidence:{sequence:Number(cmd.sequence),fingerprint:commandReplayFingerprint(cmd,f.id)},sideEffectDisposition:'effect_committed'};
 await ack(f,first.id,extra);const before=(await db.query(`SELECT next_release_at FROM gateway_sms_pacing WHERE gateway_id=$1`,[f.id])).rows[0].next_release_at;
 const replay=await ack(f,first.id,extra);assert.equal(replay.json().command.replayed,true);assert.deepEqual((await db.query(`SELECT next_release_at FROM gateway_sms_pacing WHERE gateway_id=$1`,[f.id])).rows[0].next_release_at,before);
 assert.deepEqual(await smsCommands(f),[]);await due(f);assert.equal((await smsCommands(f))[0].smsId,queued.items[1].id);
});
test('partial deletion returns 410 without changing any queue, batch or command counts',async()=>{
 const f=await fixture(),key=crypto.randomUUID(),r=(await batch(f,undefined,key)).json();
 await db.query(`DELETE FROM sms_messages WHERE id=$1`,[r.items[1].id]);
 const counts=async()=>(await db.query(`SELECT (SELECT count(*) FROM sms_messages WHERE gateway_id=$1) messages,(SELECT count(*) FROM sms_dispatch_queue WHERE gateway_id=$1) queue,(SELECT count(*) FROM commands WHERE gateway_id=$1) commands,(SELECT count(*) FROM sms_batches WHERE id=$2) batches`,[f.id,r.batchId])).rows[0];
 const before=await counts();assert.equal((await batch(f,undefined,key)).statusCode,410);assert.deepEqual(await counts(),before);
});
