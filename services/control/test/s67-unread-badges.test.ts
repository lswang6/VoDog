import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import {ZodError} from 'zod';
import type {Db} from '../src/db.js';
import {registerPushRoutes} from '../src/push-routes.js';
import {BadgeWorker,registerBadgeRoutes} from '../src/badges.js';
import {FcmClient} from '../src/fcm.js';
import {ApnsClient} from '../src/apns.js';
import {createServer,connect} from 'node:http2';
import {buildApp} from '../src/app.js';
import {hashPassword} from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated PostgreSQL database');
const schema='s67_badges_'+crypto.randomBytes(8).toString('hex'),legacy=schema+'_legacy';
const admin=new pg.Pool({connectionString:databaseUrl,max:2});
const db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:5}) as Db;
const legacyDb=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${legacy}`,max:2}) as Db;
const app=Fastify();let schemaSql='',user1:string,user2:string,session1:string,session2:string,iosSession:string;

async function seedUsers(target:Db){
  const u1=(await target.query("INSERT INTO users(email,password_hash)VALUES('badge-one@example.test','x')RETURNING id")).rows[0].id;
  const u2=(await target.query("INSERT INTO users(email,password_hash)VALUES('badge-two@example.test','x')RETURNING id")).rows[0].id;
  const session=(platform:string,user:string,tag:string)=>target.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,$2,'native',$3,now()+interval '1 hour',now()+interval '1 day')RETURNING id`,[user,tag,platform]).then(r=>r.rows[0].id as string);
  return {u1,u2,s1:await session('android',u1,'a'),s2:await session('android',u2,'b'),si:await session('ios',u1,'c')};
}
async function sim(target:Db,owner:string,label:string){
  const gateway=(await target.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES($1,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const s=(await target.query("INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,$3,true)RETURNING id",[gateway.id,owner,label])).rows[0];
  return {gatewayId:gateway.id as string,epoch:gateway.device_epoch,simId:s.id as string,owner};
}
type Sim=Awaited<ReturnType<typeof sim>>;
async function call(s:Sim,o:{direction?:string;state?:string;answered?:boolean;failure?:string|null;disposition?:string|null;run?:{mode:string;state:string}}={},target:Db=db){
  const id=(await target.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,answered_at,ended_at,failure_reason,conflict_disposition)
    VALUES($1,$2,$3,$4,$5::call_state,$6,'normal',CASE WHEN $7 THEN now() END,now(),$8,$9)RETURNING id`,
    [s.gatewayId,s.simId,s.owner,o.direction??'incoming',o.state??'ended',s.epoch,o.answered??false,o.failure??null,o.disposition??null])).rows[0].id as string;
  if(o.run)await target.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at,state)
    VALUES($1,$2,$3,$4,1,$5,1,1,45,now(),$6)`,[id,s.gatewayId,s.owner,s.epoch,o.run.mode,o.run.state]);
  return id;
}
const sms=(s:Sim,direction='incoming',target:Db=db)=>target.query(`INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)
  VALUES($1,$2,$3,$4,'+15550001','hi','delivered',$5)RETURNING id`,[s.gatewayId,s.simId,s.owner,direction,s.epoch]).then(r=>r.rows[0].id as string);
const as=(user:string,session=session1,platform='android')=>({'x-user':user,'x-session':session,'x-platform':platform});
const badges=async(user=user1)=>(await app.inject({method:'GET',url:'/api/v1/badges',headers:as(user)})).json();

before(async()=>{
  schemaSql=await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8');
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`CREATE SCHEMA ${legacy}`);
  await db.query(schemaSql);
  ({u1:user1,u2:user2,s1:session1,s2:session2,si:iosSession}=await seedUsers(db));
  const auth=(req:any)=>({userId:String(req.headers['x-user']),sessionId:String(req.headers['x-session']),platform:String(req.headers['x-platform'])});
  app.setErrorHandler((error,_request,reply)=>error instanceof ZodError?reply.code(400).send({error:{code:'INVALID_REQUEST'}}):reply.send(error));
  registerPushRoutes(app,db,auth);registerBadgeRoutes(app,db,req=>auth(req).userId);
  await app.ready();
});
after(async()=>{await app.close();await db.end();await legacyDb.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.query(`DROP SCHEMA ${legacy} CASCADE`);await admin.end();});

test('S67 schema backfills existing rows as seen/read, leaves new rows NULL and reapplies as a no-op',async()=>{
  const marker=schemaSql.indexOf('-- S67');assert.ok(marker>0);
  await legacyDb.query(schemaSql.slice(0,marker));
  const {u1}=await seedUsers(legacyDb);const s=await sim(legacyDb,u1,'legacy');
  const oldCall=await call(s,{},legacyDb),oldSms=await sms(s,'incoming',legacyDb);
  await legacyDb.query(schemaSql);
  const newCall=await call(s,{},legacyDb),newSms=await sms(s,'incoming',legacyDb);
  const seen=async()=>(await legacyDb.query(`SELECT id,seen_at FROM call_records UNION ALL SELECT id,read_at FROM sms_messages`)).rows;
  const first=new Map((await seen()).map(r=>[r.id,r.seen_at]));
  assert.ok(first.get(oldCall));assert.ok(first.get(oldSms));assert.equal(first.get(newCall),null);assert.equal(first.get(newSms),null);
  await legacyDb.query(schemaSql);
  assert.deepEqual(new Map((await seen()).map(r=>[r.id,r.seen_at])),first);
  const defaults=(await legacyDb.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('seen_at','read_at') AND column_default IS NOT NULL`,[legacy])).rows[0].n;
  assert.equal(defaults,0);
});

test('GET /badges counts missed and AI-answered incoming calls, unread incoming SMS, per SIM and per owner',async()=>{
  const a=await sim(db,user1,'badge-a'),b=await sim(db,user1,'badge-b'),other=await sim(db,user2,'badge-other');
  await call(a);                                                               // missed: counts
  await call(a,{answered:true});                                               // human answered: no
  await call(a,{failure:'number_blocked'});                                    // blocked: no
  await call(a,{answered:true,run:{mode:'ai',state:'ended'}});                 // AI answered: counts
  await call(b,{answered:true,run:{mode:'timeout_ai',state:'reconcile_unknown'}}); // timeout AI: counts
  await call(b,{answered:true,run:{mode:'timeout_ai',state:'failed_before_answer'}}); // AI lost, human answered: no
  await call(b,{answered:true,disposition:'ai_answered'});                     // busy-conflict AI: counts
  await call(a,{direction:'outgoing'});await call(a,{state:'incoming_ringing'});// outgoing / live: no
  await call(other);await sms(other);                                          // other owner: no
  await sms(a);await sms(a);await sms(b,'outgoing');
  const body=await badges();
  assert.deepEqual(body,{calls:4,sms:2,sims:[{simId:a.simId,calls:2,sms:2},{simId:b.simId,calls:2,sms:0}].sort((x,y)=>x.simId<y.simId?-1:1)});
  assert.deepEqual(await badges(user2),{calls:1,sms:1,sims:[{simId:other.simId,calls:1,sms:1}]});
});

test('POST /calls/:id/seen decrements once, is idempotent and 404s for another owner',async()=>{
  const s=await sim(db,user1,'seen');const before=(await badges()).calls;
  const id=await call(s),answered=await call(s,{answered:true});
  assert.equal((await badges()).calls,before+1);
  assert.equal((await app.inject({method:'POST',url:`/api/v1/calls/${id}/seen`,headers:as(user2,session2)})).statusCode,404);
  assert.equal((await badges()).calls,before+1);
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:`/api/v1/calls/${id}/seen`,headers:as(user1)})).statusCode,204);
  assert.equal((await badges()).calls,before);
  assert.equal((await app.inject({method:'POST',url:`/api/v1/calls/${answered}/seen`,headers:as(user1)})).statusCode,204);
  assert.equal((await db.query('SELECT seen_at FROM call_records WHERE id=$1',[answered])).rows[0].seen_at,null,'a non-pending row is left alone');
  assert.equal((await app.inject({method:'POST',url:`/api/v1/calls/${crypto.randomUUID()}/seen`,headers:as(user1)})).statusCode,404);
});

test('POST /sms/read only marks own unread incoming rows and validates 1-500 ids',async()=>{
  const mine=await sim(db,user1,'read'),theirs=await sim(db,user2,'read-other');
  const a=await sms(mine),b=await sms(mine),out=await sms(mine,'outgoing'),foreign=await sms(theirs);
  const read=(ids:unknown,user=user1)=>app.inject({method:'POST',url:'/api/v1/sms/read',headers:as(user),payload:{ids}});
  assert.deepEqual((await read([a,out,foreign,a])).json(),{updated:1});
  assert.deepEqual((await read([a,b])).json(),{updated:1});
  assert.equal((await db.query('SELECT read_at FROM sms_messages WHERE id=$1',[foreign])).rows[0].read_at,null);
  assert.equal((await read([])).statusCode,400);
  assert.equal((await read(Array.from({length:501},()=>crypto.randomUUID()))).statusCode,400);
  assert.equal((await read(['not-a-uuid'])).statusCode,400);
  assert.deepEqual((await read(Array.from({length:500},()=>crypto.randomUUID()))).json(),{updated:0});
});

test('registration PUT keeps badge choices when the field is absent',async()=>{
  const installationId=crypto.randomUUID(),url=`/api/v1/push/registrations/${installationId}`,fcmToken='badge-fcm-'+crypto.randomBytes(32).toString('base64url');
  const put=(badge?:object)=>app.inject({method:'PUT',url,headers:as(user1),payload:{platform:'android',packageName:'org.vodog',deviceName:'Pixel',fcmToken,...(badge?{badge}:{})}});
  const row=async()=>(await db.query('SELECT badge_calls,badge_sms FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0];
  assert.equal((await put()).statusCode,200);assert.deepEqual(await row(),{badge_calls:false,badge_sms:false});
  await put({calls:true,sms:false});assert.deepEqual(await row(),{badge_calls:true,badge_sms:false});
  await put();assert.deepEqual(await row(),{badge_calls:true,badge_sms:false});
  const iosId=crypto.randomUUID(),iosUrl=`/api/v1/push/registrations/${iosId}`;
  const iosPut=(badge?:object)=>app.inject({method:'PUT',url:iosUrl,headers:as(user1,iosSession,'ios'),payload:{platform:'ios',bundleId:'org.vodog',environment:'production',deviceName:'iPhone',apnsToken:'b'.repeat(64),...(badge?{badge}:{})}});
  assert.equal((await iosPut({calls:false,sms:true})).statusCode,200);await iosPut();
  assert.deepEqual((await db.query('SELECT badge_calls,badge_sms FROM push_registrations WHERE installation_id=$1',[iosId])).rows[0],{badge_calls:false,badge_sms:true});
  assert.equal((await put({calls:'yes',sms:true} as any)).statusCode,400);
  await db.query('UPDATE push_registrations SET disabled_at=now() WHERE installation_id=ANY($1::uuid[])',[[installationId,iosId]]);
});

test('badge worker pushes on change only, backs off on failure, honours badge_calls/badge_sms and the flag',async()=>{
  await db.query("UPDATE call_records SET seen_at=now()");await db.query("UPDATE sms_messages SET read_at=now()");
  await db.query('UPDATE push_registrations SET disabled_at=now()');
  const s=await sim(db,user1,'worker');
  const android=(await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,package_name,device_name,fcm_token,badge_calls,badge_sms)
    VALUES($1,$2,$3,'android','org.vodog','Pixel',$4,true,false)RETURNING id`,[crypto.randomUUID(),user1,session1,'fcm-'+crypto.randomBytes(32).toString('base64url')])).rows[0].id;
  const ios=(await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,device_name,apns_token,badge_calls,badge_sms)
    VALUES($1,$2,$3,'ios','development','iPhone',$4,true,true)RETURNING id`,[crypto.randomUUID(),user1,iosSession,'c'.repeat(64)])).rows[0].id;
  const fcm:any[]=[],apns:any[]=[];let apnsStatus=200;
  const senders={fcm:{sendBadge:async(p:any)=>{fcm.push(p);return {status:200};}},apns:{sendBadge:async(p:any)=>{apns.push(p);return {status:apnsStatus};}}};
  const off=new BadgeWorker(db,senders,{enabled:false});await call(s);await sms(s);
  assert.equal(await off.tickOnce(),0);assert.equal(fcm.length+apns.length,0);
  const worker=new BadgeWorker(db,senders,{enabled:true});
  assert.equal(await worker.tickOnce(),2);
  assert.equal(fcm.length,1);assert.equal(fcm[0].badge,1,'calls only');assert.equal(fcm[0].calls,1);assert.equal(fcm[0].sms,1);
  assert.equal(apns.length,1);assert.equal(apns[0].badge,2);assert.equal(apns[0].environment,'development');
  assert.equal(await worker.tickOnce(),0,'unchanged value is not re-sent');
  apnsStatus=500;await sms(s);
  assert.equal(await worker.tickOnce(),1,'the sms-only change reaches iOS only');assert.equal(apns.at(-1).badge,3);
  const failed=(await db.query('SELECT badge_sent,badge_retry_at>now()+interval \'50 seconds\' backoff FROM push_registrations WHERE id=$1',[ios])).rows[0];
  assert.deepEqual(failed,{badge_sent:2,backoff:true});
  assert.equal(await worker.tickOnce(),0,'no retry before badge_retry_at');
  apnsStatus=410;await db.query('UPDATE push_registrations SET badge_retry_at=now()-interval \'1 second\' WHERE id=$1',[ios]);
  await worker.tickOnce();assert.equal((await db.query('SELECT apns_token FROM push_registrations WHERE id=$1',[ios])).rows[0].apns_token,null,'410 drops the regular token');
  await db.query('UPDATE push_registrations SET badge_calls=false WHERE id=$1',[android]);
  await worker.tickOnce();assert.equal(fcm.at(-1).badge,0,'turning the badge off clears the icon once');
  const n=fcm.length;assert.equal(await worker.tickOnce(),0);assert.equal(fcm.length,n);
  assert.equal((await db.query('SELECT badge_sent FROM push_registrations WHERE id=$1',[android])).rows[0].badge_sent,0);
});

test('badge push payloads: APNs alert topic with aps.badge only, FCM normal-priority collapsed data',async()=>{
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const server=createServer();let received:any;
  server.on('stream',(stream,headers)=>{let raw='';stream.setEncoding('utf8');stream.on('data',c=>raw+=c);stream.on('end',()=>{received={headers,body:JSON.parse(raw)};stream.respond({':status':200});stream.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address() as any;
    const client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,url=>{assert.equal(url,'https://api.push.apple.com');return connect('http://127.0.0.1:'+address.port);});
    assert.equal((await client.sendBadge({token:'d'.repeat(64),environment:'production',badge:7})).status,200);
    assert.equal(received.headers['apns-topic'],'org.vodog');assert.equal(received.headers['apns-push-type'],'alert');
    assert.equal(received.headers['apns-priority'],'10');assert.equal(received.headers['apns-collapse-id'],'badge');
    assert.deepEqual(received.body,{aps:{badge:7}});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  let request:any;const fcm=new FcmClient('vodog-example',{getAccessToken:async()=>'t'},async(_url,init)=>{request=init;return new Response('{}',{status:200});});
  const notificationId=crypto.randomUUID();
  await fcm.sendBadge({token:'fcm-'+'x'.repeat(40),notificationId,badge:3,calls:1,sms:2});
  const message=JSON.parse(request.body).message;
  assert.deepEqual(message.data,{version:'1',event:'badge.update',notificationId,badge:'3',calls:'1',sms:'2'});
  assert.deepEqual(message.android,{priority:'NORMAL',ttl:'86400s',collapse_key:'badge'});assert.equal(message.notification,undefined);
});

test('S67c: GET /calls, /calls/:id carry unseen and GET /sms carries unread from the same rules as /badges',async()=>{
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  const full=await buildApp(db,{DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
    COOKIE_SECRET:'s67c-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
    MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s67c-test-media-secret-at-least-32-chars',TURN_SECRET:'s67c-test-turn-secret-at-least-32-chars',
    TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
    COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false} as never);
  try{
    const password='correct horse battery staple';
    const owner=(await db.query(`INSERT INTO users(email,password_hash)VALUES('s67c@example.test',$1)RETURNING id`,[await hashPassword(password)])).rows[0].id as string;
    const login=await full.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'s67c@example.test',password,platform:'android'}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:`Bearer ${login.json().token}`},s=await sim(db,owner,'s67c');
    const missed=await call(s),human=await call(s,{answered:true}),out=await call(s,{direction:'outgoing'}),ai=await call(s,{answered:true,run:{mode:'ai',state:'ended'}});
    const list=async()=>new Map<string,boolean>((await full.inject({method:'GET',url:'/api/v1/calls',headers})).json().items.map((c:any)=>[c.id,c.unseen]));
    const detail=async(id:string)=>(await full.inject({method:'GET',url:`/api/v1/calls/${id}`,headers})).json().call.unseen;
    assert.deepEqual(await list(),new Map([[missed,true],[human,false],[out,false],[ai,true]]));
    assert.equal(await detail(missed),true);assert.equal(await detail(human),false);
    assert.equal((await full.inject({method:'POST',url:`/api/v1/calls/${missed}/seen`,headers:{...headers,origin:'https://vodog.test'}})).statusCode,204);
    assert.equal(await detail(missed),false);assert.equal((await list()).get(missed),false);assert.equal((await list()).get(ai),true);
    const reports=new Map<string,boolean>((await full.inject({method:'GET',url:'/api/v1/reports/calls?period=1m&timeZone=Asia%2FShanghai',headers})).json().items.map((r:any)=>[r.callId,r.unseen]));
    assert.equal(reports.get(missed),false);assert.equal(reports.get(ai),true);assert.equal(reports.get(human),false);
    const inbound=await sms(s),outbound=await sms(s,'outgoing');
    const smsList=async()=>new Map<string,boolean>((await full.inject({method:'GET',url:'/api/v1/sms',headers})).json().items.map((m:any)=>[m.id,m.unread]));
    assert.deepEqual(await smsList(),new Map([[inbound,true],[outbound,false]]));
    assert.deepEqual((await full.inject({method:'POST',url:'/api/v1/sms/read',headers:{...headers,origin:'https://vodog.test'},payload:{ids:[inbound,outbound]}})).json(),{updated:1});
    assert.deepEqual(await smsList(),new Map([[inbound,false],[outbound,false]]));
  }finally{await full.close();}
});
