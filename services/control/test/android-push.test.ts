import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type {Db} from '../src/db.js';
import {registerPushRoutes} from '../src/push-routes.js';
import {AndroidPushWorker} from '../src/android-push-worker.js';
import {FcmClient} from '../src/fcm.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated PostgreSQL database');
const schema='android_push_'+crypto.randomBytes(8).toString('hex');
const admin=new pg.Pool({connectionString:databaseUrl,max:2});
const db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:5}) as Db;
let app=Fastify(),user1:string,user2:string,session1:string,session2:string;

before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  user1=(await db.query("INSERT INTO users(email,password_hash)VALUES('android-one@example.test','x')RETURNING id")).rows[0].id;
  user2=(await db.query("INSERT INTO users(email,password_hash)VALUES('android-two@example.test','x')RETURNING id")).rows[0].id;
  session1=(await db.query("INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,'a','native','android',now()+interval '1 hour',now()+interval '1 day')RETURNING id",[user1])).rows[0].id;
  session2=(await db.query("INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,'b','native','android',now()+interval '1 hour',now()+interval '1 day')RETURNING id",[user2])).rows[0].id;
  registerPushRoutes(app,db,request=>({userId:String(request.headers['x-user']),sessionId:String(request.headers['x-session']),platform:String(request.headers['x-platform'])}));
  await app.ready();
});
after(async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
const headers=(userId=user1,sessionId=session1,platform='android')=>({'x-user':userId,'x-session':sessionId,'x-platform':platform});

test('Android registration is session-bound, hides tokens, and clears cross-account/platform credentials',async()=>{
  const installationId=crypto.randomUUID(),url=`/api/v1/push/registrations/${installationId}`,token='opaque-fcm-token-'+crypto.randomBytes(32).toString('base64url');
  const created=await app.inject({method:'PUT',url,headers:headers(),payload:{platform:'android',packageName:'org.vodog',deviceName:'Pixel client',fcmToken:token}});
  assert.equal(created.statusCode,200,created.body);assert.equal(created.json().registration.fcmEnabled,true);assert.equal(created.body.includes(token),false);
  const wrongSession=await app.inject({method:'PUT',url,headers:headers(user1,session1,'ios'),payload:{platform:'android',packageName:'org.vodog',deviceName:'Pixel client',fcmToken:token}});assert.equal(wrongSession.statusCode,403);
  const reboundToken='replacement-'+crypto.randomBytes(32).toString('base64url');
  const rebound=await app.inject({method:'PUT',url,headers:headers(user2,session2),payload:{platform:'android',packageName:'org.vodog',deviceName:'Other account',fcmToken:reboundToken}});assert.equal(rebound.statusCode,200,rebound.body);
  const row=(await db.query('SELECT user_id,session_id,platform,package_name,fcm_token,apns_token,voip_token FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0];
  assert.equal(row.user_id,user2);assert.equal(row.session_id,session2);assert.equal(row.platform,'android');assert.equal(row.fcm_token,reboundToken);assert.equal(row.apns_token,null);assert.equal(row.voip_token,null);
  await app.inject({method:'DELETE',url,headers:headers(user1,session1)});assert.equal((await db.query('SELECT disabled_at FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0].disabled_at,null);
  await app.inject({method:'DELETE',url,headers:headers(user2,session2)});const disabled=(await db.query('SELECT disabled_at,fcm_token FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0];assert.ok(disabled.disabled_at);assert.equal(disabled.fcm_token,null);
});

async function fixture(label:string,owner=user1,overrides:{ready?:boolean;session?:string}={}){
  const ready=overrides.ready??true,session=overrides.session??session1;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES($1,true,$2,$2,now())RETURNING id,device_epoch`,[label,ready])).rows[0];
  const sim=(await db.query("INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,$3,true)RETURNING id",[gateway.id,owner,label])).rows[0];
  const registration=(await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,fcm_token)
    VALUES($1,$2,$3,'android',NULL,'org.vodog',$4,$5)RETURNING id`,[crypto.randomUUID(),owner,session,label,'fcm-'+crypto.randomBytes(32).toString('base64url')])).rows[0];
  const call=(await db.query("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'normal')RETURNING id",[gateway.id,sim.id,owner,gateway.device_epoch])).rows[0];
  return {gateway,sim,registration,call};
}
const clearPushFixtures=async()=>{await db.query('UPDATE push_registrations SET disabled_at=now(),fcm_token=NULL');await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE state='incoming_ringing'");};

test('worker sends one owner/session ready incoming then one cancellation after ringing ends',async()=>{
  await clearPushFixtures();
  const f=await fixture('android-push-flow'),sent:any[]=[];const sender={send:async(push:any)=>{sent.push(push);return {status:200};}};
  const first=new AndroidPushWorker(db,sender),second=new AndroidPushWorker(db,sender);
  const counts=await Promise.all([first.tickOnce(),second.tickOnce()]);assert.equal(counts[0]+counts[1],1);assert.equal(sent.length,1);assert.equal(sent[0].event,'call.incoming');assert.equal(sent[0].callId,f.call.id);
  await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1",[f.call.id]);
  await first.tickOnce();assert.equal(sent.length,2);assert.equal(sent[1].event,'call.cancelled');assert.equal(sent[1].callId,f.call.id);assert.notEqual(sent[1].notificationId,sent[0].notificationId);
  await first.tickOnce();assert.equal(sent.length,2);
  const events=await db.query('SELECT event,state FROM android_push_deliveries WHERE call_id=$1 ORDER BY event',[f.call.id]);assert.deepEqual(events.rows,[{event:'call.cancelled',state:'delivered'},{event:'call.incoming',state:'delivered'}]);
});

test('worker fails closed for unready gateway and revoked session, and clears UNREGISTERED token',async()=>{
  await clearPushFixtures();
  const unready=await fixture('android-push-unready',user1,{ready:false});const sent:any[]=[];const worker=new AndroidPushWorker(db,{send:async(push:any)=>{sent.push(push);return {status:404,reason:'UNREGISTERED'};}});
  assert.equal(await worker.tickOnce(),0);assert.equal(sent.length,0);assert.equal((await db.query('SELECT 1 FROM android_push_deliveries WHERE call_id=$1',[unready.call.id])).rowCount,0);
  const otherToken='other-'+crypto.randomBytes(32).toString('base64url');await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,fcm_token) VALUES($1,$2,$3,'android',NULL,'org.vodog','other owner',$4)`,[crypto.randomUUID(),user2,session2,otherToken]);
  const ready=await fixture('android-push-unregistered');await worker.tickOnce();assert.equal(sent.length,2);assert.ok(sent.every(push=>push.callId===ready.call.id&&push.token!==otherToken));assert.equal((await db.query('SELECT fcm_token FROM push_registrations WHERE id=$1',[ready.registration.id])).rows[0].fcm_token,null);
  const revoked=await fixture('android-push-revoked');await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[session1]);await worker.tickOnce();assert.equal((await db.query('SELECT 1 FROM android_push_deliveries WHERE call_id=$1',[revoked.call.id])).rowCount,0);
  await db.query('UPDATE sessions SET revoked_at=NULL WHERE id=$1',[session1]);
});

test('attempted incoming with a lost response still gets cancellation after ringing ends',async()=>{
  await clearPushFixtures();
  const f=await fixture('android-push-lost-response'),events:string[]=[];let first=true;
  const worker=new AndroidPushWorker(db,{send:async(push:any)=>{events.push(push.event);if(first){first=false;throw new Error('response lost');}return {status:200};}});
  await worker.tickOnce();assert.deepEqual(events,['call.incoming']);
  const incoming=(await db.query("SELECT state,attempts FROM android_push_deliveries WHERE call_id=$1 AND event='call.incoming'",[f.call.id])).rows[0];assert.equal(incoming.state,'pending');assert.equal(incoming.attempts,1);
  await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1",[f.call.id]);
  await worker.tickOnce();assert.deepEqual(events,['call.incoming','call.cancelled']);
  assert.equal((await db.query("SELECT state FROM android_push_deliveries WHERE call_id=$1 AND event='call.cancelled'",[f.call.id])).rows[0].state,'delivered');
});

test('call ending while an incoming delivery is leased is reconciled with cancellation',async()=>{
  await clearPushFixtures();
  const f=await fixture('android-push-end-race');let entered!:()=>void,release!:()=>void;const seen=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);const events:string[]=[];
  const worker=new AndroidPushWorker(db,{send:async(push:any)=>{events.push(push.event);if(push.event==='call.incoming'){entered();await hold;}return {status:200};}});
  const tick=worker.tickOnce();await seen;await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1",[f.call.id]);release();await tick;
  await worker.tickOnce();assert.deepEqual(events,['call.incoming','call.cancelled']);
  const rows=await db.query('SELECT event,state FROM android_push_deliveries WHERE call_id=$1 ORDER BY event',[f.call.id]);assert.deepEqual(rows.rows,[{event:'call.cancelled',state:'delivered'},{event:'call.incoming',state:'delivered'}]);
});

test('FCM client sends high-priority data only and parses UNREGISTERED without leaking token',async()=>{
  const token='device-token-'+crypto.randomBytes(32).toString('base64url'),callId=crypto.randomUUID(),notificationId=crypto.randomUUID();let request:any;
  const credentials={getAccessToken:async()=> 'access-token-value'};
  const client=new FcmClient('vodog-example',credentials,async(url,init)=>{request={url,init};return new Response(JSON.stringify({name:'projects/x/messages/y'}),{status:200});});
  assert.deepEqual(await client.send({token,event:'call.incoming',callId,notificationId}),{status:200});
  assert.equal(request.url,'https://fcm.googleapis.com/v1/projects/vodog-example/messages:send');assert.equal(request.init.headers.authorization,'Bearer access-token-value');
  const body=JSON.parse(request.init.body);assert.deepEqual(body.message.data,{version:'1',event:'call.incoming',callId,notificationId});assert.equal(body.message.android.priority,'HIGH');assert.equal(JSON.stringify(body).includes('remoteNumber'),false);assert.equal(body.message.notification,undefined);
  const rejected=new FcmClient('vodog-example',credentials,async()=>new Response(JSON.stringify({error:{status:'NOT_FOUND',details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}}),{status:404}));
  assert.deepEqual(await rejected.send({token,event:'call.cancelled',callId,notificationId}),{status:404,reason:'UNREGISTERED'});
});

test('the FCM data map gains only a top-level contactName and nothing else',async()=>{
  const token='device-token-'+crypto.randomBytes(32).toString('base64url'),callId=crypto.randomUUID(),notificationId=crypto.randomUUID();
  let request:any;
  const client=new FcmClient('vodog-example',{getAccessToken:async()=>'access-token-value'},async(_url,init)=>{request={init};return new Response(JSON.stringify({name:'projects/x/messages/y'}),{status:200});});
  // The Android client drops any incoming push carrying an unexpected data key, so the payload may
  // gain exactly one: `contactName`, as a top-level string in `message.data`.
  await client.send({token,event:'call.incoming',callId,notificationId,contactName:'  张三  '});
  const withName=JSON.parse(request.init.body).message.data;
  assert.deepEqual(Object.keys(withName).sort(),['callId','contactName','event','notificationId','version']);
  assert.equal(withName.contactName,'张三');
  assert.equal(JSON.stringify(request.init.body).includes('remoteNumber'),false);
  await client.send({token,event:'call.incoming',callId,notificationId,contactName:null});
  assert.deepEqual(JSON.parse(request.init.body).message.data,{version:'1',event:'call.incoming',callId,notificationId},'an unknown caller keeps the old payload exactly');
  await client.send({token,event:'call.cancelled',callId,notificationId});
  assert.deepEqual(JSON.parse(request.init.body).message.data,{version:'1',event:'call.cancelled',callId,notificationId});
});

test('S36 C1: the FCM number key travels only when FCM_PUSH_REMOTE_NUMBER is on',async()=>{
  const token='device-token-'+crypto.randomBytes(32).toString('base64url'),callId=crypto.randomUUID(),notificationId=crypto.randomUUID();
  let request:any;
  const fetcher=async(_url:string,init:any)=>{request={init};return new Response(JSON.stringify({name:'projects/x/messages/y'}),{status:200});};
  const push={token,event:'call.incoming' as const,callId,notificationId,contactName:'张三',remoteNumber:' +15551234567\n'};
  // Default off: an APK without `remoteNumber` in its allow-list drops the whole push, so the key
  // may only appear once the shipped client accepts it.
  await new FcmClient('vodog-example',{getAccessToken:async()=>'access-token-value'},fetcher as any).send(push);
  assert.deepEqual(Object.keys(JSON.parse(request.init.body).message.data).sort(),['callId','contactName','event','notificationId','version']);
  await new FcmClient('vodog-example',{getAccessToken:async()=>'access-token-value'},fetcher as any,true).send(push);
  const enabled=JSON.parse(request.init.body).message.data;
  assert.deepEqual(Object.keys(enabled).sort(),['callId','contactName','event','notificationId','remoteNumber','version']);
  assert.equal(enabled.remoteNumber,'+15551234567');
  await new FcmClient('vodog-example',{getAccessToken:async()=>'access-token-value'},fetcher as any,true).send({...push,remoteNumber:null});
  assert.deepEqual(Object.keys(JSON.parse(request.init.body).message.data).sort(),['callId','contactName','event','notificationId','version'],'an unknown number is omitted');
});

test('an AI-owned ringing call is never queued for FCM and rings again once the run releases it',async()=>{
  await clearPushFixtures();
  const f=await fixture('android-ai-suppression');
  const runId=(await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
    VALUES($1,$2,$3,$4,1,'ai',1,1,45,now()) RETURNING id`,[f.call.id,f.gateway.id,user1,f.gateway.device_epoch])).rows[0].id;
  await db.query(`UPDATE call_records SET mode_snapshot='ai',ai_run_id=$2 WHERE id=$1`,[f.call.id,runId]);
  const sent:any[]=[];const sender={send:async(push:any)=>{sent.push(push);return {status:200};}};
  const worker=new AndroidPushWorker(db,sender);
  assert.equal(await worker.tickOnce(),0);
  assert.equal(sent.length,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM android_push_deliveries WHERE call_id=$1',[f.call.id])).rows[0].n,0);
  // A row queued before the AI run owned the call is still refused at delivery authorization.
  await db.query(`INSERT INTO android_push_deliveries(call_id,registration_id,session_id,event)VALUES($1,$2,$3,'call.incoming')`,[f.call.id,f.registration.id,session1]);
  assert.equal(await worker.tickOnce(),1);
  assert.equal(sent.length,0);
  assert.equal((await db.query(`SELECT state FROM android_push_deliveries WHERE call_id=$1 AND event='call.incoming'`,[f.call.id])).rows[0].state,'cancelled');
  // S22 decision 5: clearing ai_run_id hands the still-ringing call back to the normal ring path.
  await db.query(`DELETE FROM android_push_deliveries WHERE call_id=$1`,[f.call.id]);
  await db.query(`UPDATE call_records SET ai_run_id=NULL WHERE id=$1`,[f.call.id]);
  await worker.tickOnce();
  assert.deepEqual(sent.map(push=>push.event),['call.incoming']);
  await db.query(`DELETE FROM android_push_deliveries WHERE call_id=$1`,[f.call.id]);
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[f.call.id]);
});
