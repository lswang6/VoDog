import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { backfillCallCanonicalKeys, buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { CONTROL_VERSION, heartbeatGapThresholdMs, requestLevel, shouldLogRequest } from '../src/diag.js';
import { hashPassword, tokenHash } from '../src/security.js';
import { MediaCloseWorker } from '../src/media-close-worker.js';
import type { MediaBridgeClient } from '../src/media-client.js';
import { MediaNodeRegistry } from '../src/media-node-registry.js';
import { PushWorker } from '../src/push-worker.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl) throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');
let db:Db, app:FastifyInstance;
let user1:string,user2:string,admin:string,gateway:string,sim1:string,sim2:string;
let token1:string,token2:string,adminToken:string,deviceToken:string;
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-only-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'test-media-secret-at-least-32-characters',TURN_SECRET:'test-turn-secret-at-least-32-characters',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,CALL_DTMF_ENABLED:true,SMS_OUTGOING_OBSERVED_ENABLED:true};

async function login(username:string,password:string){const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password,platform:'android'}});assert.equal(r.statusCode,200,r.body);return r.json().token as string;}
const auth=(token:string)=>({authorization:`Bearer ${token}`});
// A dial the gateway was handed for execution; `/end` then keeps the hangup path (undelivered dials are cancelled).
const markDialDelivered=(callId:string)=>db.query(`UPDATE commands SET delivered_at=now() WHERE call_id=$1 AND kind='dial'`,[callId]);
async function gatewayFixture(ownerUserId:string|null,label:string){
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id,version`,[g.id,ownerUserId,`${label} SIM`,tokenHash(`${label}-fingerprint-value`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  return {gatewayId:g.id,simId:sim.id,assignmentVersion:Number(sim.version),deviceEpoch:Number(g.device_epoch),deviceToken:token};
}

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  const passwordHash=await hashPassword('correct horse battery staple');
  user1=(await db.query(`INSERT INTO users(email,password_hash)VALUES('one@example.test',$1)RETURNING id`,[passwordHash])).rows[0].id;
  user2=(await db.query(`INSERT INTO users(email,password_hash)VALUES('two@example.test',$1)RETURNING id`,[passwordHash])).rows[0].id;
  admin=(await db.query(`INSERT INTO users(email,password_hash,role)VALUES('admin@example.test',$1,'admin')RETURNING id`,[passwordHash])).rows[0].id;
  gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('real-test-gateway',true,true,true,true,now())RETURNING id`,[])).rows[0].id;
  sim1=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'SIM 1',true,$3)RETURNING id`,[gateway,user1,tokenHash('snapshot-fingerprint-slot0')])).rows[0].id;
  sim2=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,1,$2,'SIM 2',true,$3)RETURNING id`,[gateway,user2,tokenHash('snapshot-fingerprint-slot1')])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1),($2)`,[sim1,sim2]);
  deviceToken='device-test-token-with-sufficient-entropy-123';
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'test')`,[gateway,tokenHash(deviceToken)]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at) SELECT id,device_epoch,gen_random_uuid(),0,0,false,'[]',now() FROM gateways WHERE id=$1`,[gateway]);
  app=await buildApp(db,config);
  token1=await login('one@example.test','correct horse battery staple');token2=await login('two@example.test','correct horse battery staple');adminToken=await login('admin@example.test','correct horse battery staple');
});
after(async()=>{await app.close();await db.end();});

test('authentication returns native bearer identity and rejects web login CSRF',async()=>{
  const me=await app.inject({method:'GET',url:'/api/v1/auth/me',headers:auth(token1)});assert.equal(me.statusCode,200);assert.deepEqual(me.json().user,{id:user1,username:'one@example.test',role:'user'});
  const web=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'web'},headers:{origin:'https://evil.test'}});assert.equal(web.statusCode,403);assert.equal(web.json().error.code,'ORIGIN_REJECTED');
});

test('turnstile gating advertises its site key and rejects pre-auth requests without a token',async()=>{
  const open=await app.inject({method:'GET',url:'/api/v1/auth/config'});
  assert.equal(open.statusCode,200);
  assert.deepEqual(open.json(),{turnstile:{enabled:false,siteKey:null}});
  const guarded=await buildApp(db,{...config,TURNSTILE_ENABLED:true,TURNSTILE_SITE_KEY:'1x00000000000000000000AA',TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA'});
  try{
    const advertised=await guarded.inject({method:'GET',url:'/api/v1/auth/config'});
    assert.deepEqual(advertised.json(),{turnstile:{enabled:true,siteKey:'1x00000000000000000000AA'}});
    const login=await guarded.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'android'}});
    assert.equal(login.statusCode,400,login.body);assert.equal(login.json().error.code,'TURNSTILE_REQUIRED');
    const webLogin=await guarded.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'web'},headers:{origin:config.PUBLIC_ORIGIN}});
    assert.equal(webLogin.statusCode,400,webLogin.body);assert.equal(webLogin.json().error.code,'TURNSTILE_REQUIRED');
    // S22 decision 11: passkey sign-in never demands a Turnstile token. With Turnstile enabled and no
    // token at all the request walks straight past the challenge into the account/passkey lookup,
    // which is the only thing that may reject it (this account has no registered passkey).
    const passkey=await guarded.inject({method:'POST',url:'/api/v1/passkeys/authenticate/options',payload:{username:'one@example.test'}});
    assert.equal(passkey.statusCode,404,passkey.body);assert.equal(passkey.json().error.code,'NOT_FOUND');
    // Neither step of the passkey flow consumes a Turnstile token; verify stays gated by the
    // challenge and signature instead of demanding a widget challenge.
    const verify=await guarded.inject({method:'POST',url:'/api/v1/passkeys/authenticate/verify',payload:{challengeId:'00000000-0000-4000-8000-000000000000',response:{},platform:'android'}});
    assert.equal(verify.statusCode,400,verify.body);assert.equal(verify.json().error.code,'CHALLENGE_INVALID');
    // The default (Turnstile off) app still logs in without any token.
    const stillOpen=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'android'}});
    assert.equal(stillOpen.statusCode,200,stillOpen.body);
  }finally{await guarded.close();}
});

test('logout accepts the native empty request and malformed empty JSON stays a parser 400',async()=>{
  const native=await login('two@example.test','correct horse battery staple');
  const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:auth(native)});assert.equal(logout.statusCode,204,logout.body);
  const revoked=await app.inject({method:'GET',url:'/api/v1/auth/me',headers:auth(native)});assert.equal(revoked.statusCode,401);
  const malformed=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{...auth(token2),'content-type':'application/json'},payload:''});assert.equal(malformed.statusCode,400,malformed.body);assert.equal(malformed.json().error.code,'INVALID_REQUEST');
});

test('SIM, call, and SMS collections are isolated by owner snapshot',async()=>{
  const a=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(token1)});assert.deepEqual(a.json().items.map((x:any)=>x.id),[sim1]);
  assert.equal(a.json().items[0].gatewayName,'real-test-gateway','S91: /sims carries gateways.name');
  const b=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(token2)});assert.deepEqual(b.json().items.map((x:any)=>x.id),[sim2]);
  await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at)VALUES($1,$2,$3,'incoming','ended',1,'normal',now())`,[gateway,sim1,user1]);
  await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[sim1,user2]);
  const oldOwner=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token1)});const newOwner=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token2)});assert.equal(oldOwner.json().items.length,1);assert.equal(newOwner.json().items.length,0);
  await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[sim1,user1]);
});

test('call detail requires authentication and its immutable snapshot owner can read terminal state',async()=>{
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at)VALUES($1,$2,$3,'incoming','ended',1,'normal',now()) RETURNING id`,[gateway,sim1,user1])).rows[0];
  const anonymous=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`});assert.equal(anonymous.statusCode,401,anonymous.body);
  const other=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token2)});assert.equal(other.statusCode,404,other.body);
  const owner=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token1)});assert.equal(owner.statusCode,200,owner.body);assert.equal(owner.json().call.id,call.id);assert.equal(owner.json().call.state,'ended');
});

test('offline gateways reject outbound work instead of fabricating progress',async()=>{
  await db.query(`UPDATE gateways SET control_enabled=false WHERE id=$1`,[gateway]);
  const r=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'offline-call-0001'},payload:{simId:sim1,remoteNumber:'+15550001'}});assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'GATEWAY_OFFLINE');
  await db.query(`UPDATE gateways SET control_enabled=true,last_seen_at=now() WHERE id=$1`,[gateway]);
});

test('outbound calls canonicalize supported service, local, and E.164 destinations before persistence and idempotency',async()=>{
  const userToken=await login('one@example.test','correct horse battery staple');
  for(const [label,input,canonical] of [
    ['service','  10000  ','10000'],
    ['local','13800001234','13800001234'],
    ['e164','+8613800001234','+8613800001234'],
  ] as const){
    const fixture=await gatewayFixture(user1,`outbound-number-${label}`),key=`outbound-number-${label}`;
    const first=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':key},payload:{simId:fixture.simId,remoteNumber:input}});
    assert.equal(first.statusCode,202,first.body);
    const callId=first.json().call.id as string;
    const stored=(await db.query(`SELECT c.remote_number,cmd.payload FROM call_records c JOIN commands cmd ON cmd.call_id=c.id AND cmd.kind='dial' WHERE c.id=$1`,[callId])).rows[0];
    assert.equal(stored.remote_number,canonical);assert.equal(stored.payload.remoteNumber,canonical);
    assert.equal(first.json().call.gatewayKind,'pixel','S58: the dial response carries the gateway kind');
    const replay=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':key},payload:{simId:fixture.simId,remoteNumber:canonical}});
    assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().call.id,callId);assert.equal(replay.json().call.gatewayKind,'pixel');assert.equal(replay.json().command,null);
    await db.query(`DELETE FROM idempotency_requests WHERE resource_id=$1`,[callId]);
    await db.query(`DELETE FROM commands WHERE call_id=$1`,[callId]);
    await db.query(`DELETE FROM call_records WHERE id=$1`,[callId]);
  }
});

test('invalid and globally blocked outbound destinations create no call, command, idempotency row, or lock',async()=>{
  const fixture=await gatewayFixture(user1,'outbound-number-invalid');
  const userToken=await login('one@example.test','correct horse battery staple');
  const invalid=['*#06#','tel:10000','100\u000000','10 000','100-00','100,00','100;00','service','++8613800001234','+0123','12','112','911','１００００'];
  for(const [index,remoteNumber] of invalid.entries()){
    const response=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':`outbound-number-invalid-${index}`},payload:{simId:fixture.simId,remoteNumber}});
    assert.equal(response.statusCode,400,`${JSON.stringify(remoteNumber)}: ${response.body}`);assert.equal(response.json().error.code,'INVALID_REQUEST');
  }
  assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM idempotency_requests i JOIN call_records c ON c.id=i.resource_id WHERE c.gateway_id=$1 AND i.operation='call.outbound'`,[fixture.gatewayId])).rows[0].n,0);
});

test('gateway-wide lock permits only one concurrent outbound call across SIMs',async()=>{
  await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[sim2,user1]);
  const [a,b]=await Promise.all([
    app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'race-call-sim1'},payload:{simId:sim1,remoteNumber:'+15550101'}}),
    app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'race-call-sim2'},payload:{simId:sim2,remoteNumber:'+15550102'}}),
  ]);assert.deepEqual([a.statusCode,b.statusCode].sort(),[202,409]);assert.equal([a,b].find(x=>x.statusCode===409)!.json().error.code,'GATEWAY_BUSY');
});

test('same SMS idempotency key concurrently creates one resource',async()=>{
  const request={method:'POST' as const,url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'same-sms-request'},payload:{simId:sim1,remoteNumber:'+15550201',body:'你好'}};
  const [a,b]=await Promise.all([app.inject(request),app.inject(request)]);assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,202]);assert.equal(a.json().sms.id,b.json().sms.id);const count=await db.query(`SELECT count(*)::int n FROM sms_messages WHERE id=$1`,[a.json().sms.id]);assert.equal(count.rows[0].n,1);
});

test('command sequence does not invalidate an earlier command in same device epoch',async()=>{
  const dial=(await db.query(`SELECT id,generation,sequence,call_id FROM commands WHERE kind='dial' ORDER BY sequence LIMIT 1`)).rows[0];
  const later=(await db.query(`SELECT sequence FROM commands WHERE kind='send_sms' ORDER BY sequence DESC LIMIT 1`)).rows[0];assert.ok(Number(later.sequence)>Number(dial.sequence));
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${dial.id}/ack`,headers:auth(deviceToken),payload:{generation:Number(dial.generation),status:'acked',telecomState:'DIALING'}});assert.equal(ack.statusCode,200,ack.body);
  const active=await db.query(`SELECT state,answered_at FROM call_records WHERE id=$1`,[dial.call_id]);assert.equal(active.rows[0].state,'connecting');assert.equal(active.rows[0].answered_at,null);
  const event=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${dial.call_id}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:Number(dial.generation),state:'active'}});assert.equal(event.statusCode,200,event.body);
  const answered=await db.query(`SELECT state,answered_at FROM call_records WHERE id=$1`,[dial.call_id]);assert.equal(answered.rows[0].state,'active');assert.ok(answered.rows[0].answered_at);
  const late=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${dial.call_id}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:Number(dial.generation),state:'connecting'}});assert.equal(late.statusCode,200);const stillActive=await db.query(`SELECT state FROM call_records WHERE id=$1`,[dial.call_id]);assert.equal(stillActive.rows[0].state,'active');
});

test('media grants are limited to the exact winning session and matching gateway epoch',async()=>{
  const fakeAi=await app.inject({method:'POST',url:`/api/v1/calls/${crypto.randomUUID()}/claim`,headers:auth(token1),payload:{platform:'ai'}});assert.equal(fakeAi.statusCode,400);assert.equal(fakeAi.json().error.code,'INVALID_REQUEST');
  const call=(await db.query(`SELECT c.id,c.originating_session_id,c.originating_platform FROM call_records c JOIN commands cmd ON cmd.call_id=c.id WHERE cmd.kind='dial' ORDER BY cmd.sequence LIMIT 1`)).rows[0];assert.ok(call.originating_session_id);assert.equal(call.originating_platform,'android');
  const options=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:auth(token1)});assert.equal(options.statusCode,200,options.body);assert.equal(options.json().iceTransportPolicy,'relay');assert.ok(options.json().iceServers[0].credential);assert.equal(options.json().iceServers[0].urls.length,1);assert.match(options.json().iceServers[0].urls[0],/transport=udp/);
  const anotherSession=await login('one@example.test','correct horse battery staple');
  const loser=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:auth(anotherSession)});assert.equal(loser.statusCode,403);assert.equal(loser.json().error.code,'MEDIA_NOT_WINNER');
  const otherOwner=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:auth(token2)});assert.equal(otherOwner.statusCode,404);
  const gatewayOptions=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/media/options`,headers:auth(deviceToken),payload:{transport:'tls'}});assert.equal(gatewayOptions.statusCode,200,gatewayOptions.body);assert.equal(gatewayOptions.json().iceServers[0].urls.length,1);assert.match(gatewayOptions.json().iceServers[0].urls[0],/^turns:/);
  // S71 relay matrix: relay × transport × configured. Only relay:true+tls+configured swaps the URL and adds hostname.
  const gopts=(payload:object)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/media/options`,headers:auth(deviceToken),payload});
  const direct=gatewayOptions.json();assert.equal('relay' in direct,false);assert.equal('hostname' in direct.iceServers[0],false);
  const cfg=config as Record<string,unknown>;
  for(const configured of [false,true]){
    if(configured){cfg.MEDIA_RELAY_TURN_TLS_URL='turns:203.0.113.20:16801?transport=tcp';cfg.MEDIA_RELAY_TURN_HOSTNAME='vodog.example.com';cfg.MEDIA_RELAY_NODE_ID='relay-primary';}
    for(const transport of ['udp','tls'] as const)for(const relay of [undefined,false,true]){
      const r=await gopts({transport,...(relay===undefined?{}:{relay})});assert.equal(r.statusCode,200,r.body);const j=r.json();
      const applied=configured&&relay===true&&transport==='tls';
      assert.deepEqual(Object.keys(j),['mediaNodeId','mediaEpoch','iceServers','iceTransportPolicy',...(relay===undefined?[]:['relay'])],JSON.stringify({configured,transport,relay}));
      if(relay!==undefined)assert.equal(j.relay,applied);
      assert.equal(j.iceServers.length,1);const s=j.iceServers[0];
      assert.match(s.username,/^\d+:vodog-[0-9a-f]{16}$/);assert.equal(s.credential,createHmac('sha1',config.TURN_SECRET).update(s.username).digest('base64'));
      if(applied)assert.deepEqual({urls:s.urls,hostname:s.hostname,keys:Object.keys(s)},{urls:['turns:203.0.113.20:16801?transport=tcp'],hostname:'vodog.example.com',keys:['urls','hostname','username','credential']});
      else{assert.deepEqual(Object.keys(s),['urls','username','credential']);assert.deepEqual(s.urls,transport==='tls'?direct.iceServers[0].urls:[s.urls[0]]);assert.match(s.urls[0],transport==='tls'?/^turns:/:/^turn:.*transport=udp$/);}
    }
  }
  const badRelay=await gopts({transport:'tls',relay:'yes'});assert.equal(badRelay.statusCode,400,badRelay.body);
  // S72b: the client route follows the identical rule; absent relay stays byte-identical to today.
  const copts=(payload:object)=>app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:auth(token1),payload});
  for(const configured of [false,true]){
    if(configured){cfg.MEDIA_RELAY_TURN_TLS_URL='turns:203.0.113.20:16801?transport=tcp';cfg.MEDIA_RELAY_TURN_HOSTNAME='vodog.example.com';cfg.MEDIA_RELAY_NODE_ID='relay-primary';}
    else{delete cfg.MEDIA_RELAY_TURN_TLS_URL;delete cfg.MEDIA_RELAY_TURN_HOSTNAME;delete cfg.MEDIA_RELAY_NODE_ID;}
    for(const transport of ['udp','tls'] as const){
      const plain=await copts({transport});assert.equal(plain.statusCode,200,plain.body);
      for(const relay of [undefined,false,true]){
        const r=await copts({transport,...(relay===undefined?{}:{relay})});assert.equal(r.statusCode,200,r.body);const j=r.json();
        const applied=configured&&relay===true&&transport==='tls';
        assert.deepEqual(Object.keys(j),['mediaNodeId','mediaEpoch','iceServers','iceTransportPolicy',...(relay===undefined?[]:['relay'])],JSON.stringify({configured,transport,relay}));
        if(relay!==undefined)assert.equal(j.relay,applied);
        const s=j.iceServers[0];assert.equal(j.iceServers.length,1);
        if(applied)assert.deepEqual({urls:s.urls,hostname:s.hostname,keys:Object.keys(s)},{urls:['turns:203.0.113.20:16801?transport=tcp'],hostname:'vodog.example.com',keys:['urls','hostname','username','credential']});
        else{assert.deepEqual(Object.keys(s),['urls','username','credential']);assert.deepEqual(s.urls,plain.json().iceServers[0].urls);}
      }
    }
  }
  const badClientRelay=await copts({transport:'tls',relay:'yes'});assert.equal(badClientRelay.statusCode,400,badClientRelay.body);
  delete cfg.MEDIA_RELAY_TURN_TLS_URL;delete cfg.MEDIA_RELAY_TURN_HOSTNAME;delete cfg.MEDIA_RELAY_NODE_ID;
  await db.query(`UPDATE gateways SET control_enabled=false WHERE id=$1`,[gateway]);const offlineGrant=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/media/options`,headers:auth(deviceToken)});assert.equal(offlineGrant.statusCode,503);assert.equal(offlineGrant.json().error.code,'GATEWAY_OFFLINE');await db.query(`UPDATE gateways SET control_enabled=true,last_seen_at=now() WHERE id=$1`,[gateway]);

  let bridgeDown=false;const grants:any[]=[];
  const server=createServer((req,res)=>{if(req.url==='/offer'){grants.push(JSON.parse(Buffer.from(req.headers.authorization!.slice(7).split('.')[0]!,'base64url').toString()));if(bridgeDown){res.writeHead(502).end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'answer',sdp:'v=0\r\n'}));return;}res.writeHead(404).end();});await new Promise<void>(resolve=>server.listen(16881,'127.0.0.1',resolve));
  try{
    const userOffer=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/offer`,headers:auth(token1),payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(userOffer.statusCode,200,userOffer.body);assert.deepEqual(userOffer.json(),{type:'answer',sdp:'v=0\r\n'});
    const gatewayOffer=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/media/offer`,headers:auth(deviceToken),payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(gatewayOffer.statusCode,200,gatewayOffer.body);
    // S75c: the winner session and the call's gateway own their legs (replace:true); nobody else reaches the bridge.
    assert.deepEqual(grants.map(g=>[g.role,g.replace]),[['client',true],['gateway',true]]);
    const loserOffer=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/offer`,headers:auth(anotherSession),payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(loserOffer.statusCode,403,loserOffer.body);assert.equal(loserOffer.json().error.code,'MEDIA_NOT_WINNER');
    const otherUserOffer=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/offer`,headers:auth(token2),payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(otherUserOffer.statusCode,404,otherUserOffer.body);
    assert.equal(grants.length,2);
    bridgeDown=true;
    const refused=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/offer`,headers:auth(token1),payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(refused.statusCode,503,refused.body);assert.equal(refused.json().error.code,'MEDIA_BRIDGE_UNAVAILABLE');
    const failed=(await untilRows(`SELECT level,fields FROM diag_events WHERE event='media.offer_failed' AND call_id=$1`,[call.id],'the media.offer_failed row'))[0];
    assert.equal(failed.level,'warn');assert.equal(failed.fields.bridgeStatus,502);assert.equal(failed.fields.stage,'bridge_offer');assert.equal(failed.fields.reason,null);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}

  await db.query(`UPDATE gateways SET device_epoch=device_epoch+1 WHERE id=$1`,[gateway]);
  const stale=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:auth(token1)});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'MEDIA_REVOKED');
  await db.query(`UPDATE gateways SET device_epoch=device_epoch-1 WHERE id=$1`,[gateway]);
});

test('a call fixes both roles, close, and retries to one configured media node',async()=>{
  const fixture=await gatewayFixture(user1,'media-node-routing');let offers=0,closes=0,failClose=true;
  const nodeServer=createServer(async(req,res)=>{if(req.url==='/offer'){const grant=JSON.parse(Buffer.from(req.headers.authorization!.slice(7).split('.')[0]!,'base64url').toString());assert.equal(grant.mediaEpoch,1);offers++;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({type:'answer',sdp:'v=0\r\n'}));return;}if(req.url?.startsWith('/close/')){assert.equal(req.headers['x-media-epoch'],'1');closes++;res.writeHead(failClose?503:204).end();return;}res.writeHead(404).end();});
  await new Promise<void>((resolve,reject)=>{nodeServer.once('error',reject);nodeServer.listen(0,'127.0.0.1',resolve)});const address=nodeServer.address();if(!address||typeof address==='string')throw new Error('server');
  const nodes=JSON.stringify([{id:'relay-secondary',controlBaseUrl:`http://127.0.0.1:${address.port}`,turnUdpUrl:'turn:relay-secondary.example.test:3478?transport=udp',turnTlsUrl:'turns:relay-secondary.example.test:5349?transport=tcp',mediaSecret:'secondary-media-secret-at-least-32-characters',turnSecret:'secondary-turn-secret-at-least-32-characters'}]);
  const relayConfig={MEDIA_RELAY_TURN_TLS_URL:'turns:203.0.113.20:16801?transport=tcp',MEDIA_RELAY_TURN_HOSTNAME:'vodog.example.com',MEDIA_RELAY_NODE_ID:'relay-primary'};
  await assert.rejects(buildApp(db,{...config,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-secondary',...relayConfig,MEDIA_RELAY_NODE_ID:'nope'}),/MEDIA_RELAY_NODE_ID/);
  await assert.rejects(buildApp(db,{...config,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-secondary',MEDIA_PREFERRED_NODE_ID:'nope'}),/MEDIA_PREFERRED_NODE_ID/);
  const routed=await buildApp(db,{...config,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-secondary',...relayConfig});
  try{
    const call=await routed.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'media-node-routing-call'},payload:{simId:fixture.simId,remoteNumber:'+15557001'}});assert.equal(call.statusCode,202,call.body);const id=call.json().call.id;
    const client=await routed.inject({method:'POST',url:`/api/v1/calls/${id}/media/options`,headers:auth(token1),payload:{transport:'udp',nodeId:'relay-secondary'}});assert.equal(client.statusCode,200,client.body);assert.equal(client.json().mediaNodeId,'relay-secondary');assert.equal(client.json().mediaEpoch,1);assert.match(client.json().iceServers[0].urls[0],/^turn:relay-secondary\./);
    const wrong=await routed.inject({method:'POST',url:`/api/v1/gateway/calls/${id}/media/options`,headers:auth(fixture.deviceToken),payload:{nodeId:'relay-primary'}});assert.equal(wrong.statusCode,409,wrong.body);assert.equal(wrong.json().error.code,'MEDIA_NODE_MISMATCH');
    const gateway=await routed.inject({method:'POST',url:`/api/v1/gateway/calls/${id}/media/options`,headers:auth(fixture.deviceToken)});assert.equal(gateway.statusCode,200,gateway.body);assert.equal(gateway.json().mediaNodeId,'relay-secondary');
    // S71: relay fronts relay-primary only; a gz room keeps gz's own TURN URL even when the gateway asks for relay.
    const gzRelay=await routed.inject({method:'POST',url:`/api/v1/gateway/calls/${id}/media/options`,headers:auth(fixture.deviceToken),payload:{transport:'tls',relay:true}});assert.equal(gzRelay.statusCode,200,gzRelay.body);assert.equal(gzRelay.json().relay,false);assert.deepEqual(gzRelay.json().iceServers[0].urls,['turns:relay-secondary.example.test:5349?transport=tcp']);assert.equal('hostname' in gzRelay.json().iceServers[0],false);
    const offer=await routed.inject({method:'POST',url:`/api/v1/calls/${id}/media/offer`,headers:auth(token1),payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(offer.statusCode,200,offer.body);assert.equal(offers,1);
    // S75: the offer row names the branch that picked the node at media/options time, not "fixed".
    const offerRow=(await untilRows(`SELECT fields FROM diag_events WHERE event='media.offer' AND call_id=$1`,[id],'the media.offer row'))[0];
    assert.equal(offerRow.fields.nodeReason,'requested');assert.deepEqual(offerRow.fields.candidates,['relay-secondary']);
    const fixed=(await db.query(`SELECT media_node_id,media_epoch,recording_status FROM call_records WHERE id=$1`,[id])).rows[0];assert.deepEqual(fixed,{media_node_id:'relay-secondary',media_epoch:'1',recording_status:'pending'});
    const changedDefault=await buildApp(db,{...config,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-primary'});try{const stable=await changedDefault.inject({method:'POST',url:`/api/v1/calls/${id}/media/options`,headers:auth(token1)});assert.equal(stable.statusCode,200,stable.body);assert.equal(stable.json().mediaNodeId,'relay-secondary');}finally{await changedDefault.close();}
    await markDialDelivered(id);
    const ended=await routed.inject({method:'POST',url:`/api/v1/calls/${id}/end`,headers:auth(token1),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(ended.statusCode,202,ended.body);assert.equal(closes,0);assert.equal(ended.json().call.gatewayKind,'pixel');const queued=(await db.query(`SELECT node_id,media_epoch,close_mode FROM media_close_jobs WHERE call_id=$1`,[id])).rows[0];assert.deepEqual(queued,{node_id:'relay-secondary',media_epoch:'1',close_mode:'wait_terminal'});
    const endRow=(await untilRows(`SELECT fields FROM diag_events WHERE event='call.end' AND call_id=$1`,[id],'the call.end row'))[0];
    assert.ok(endRow.fields.platform);assert.ok(endRow.fields.sessionId);
    const submitted=await routed.inject({method:'POST',url:`/api/v1/gateway/commands/${ended.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',telecomState:'ACTIVE',result:{phase:'submitted'}}});assert.equal(submitted.statusCode,200,submitted.body);assert.equal(closes,0);
    const eventId=crypto.randomUUID(),terminalPayload={eventId,generation:fixture.deviceEpoch,state:'ended'};
    const terminal=await routed.inject({method:'POST',url:`/api/v1/gateway/calls/${id}/events`,headers:auth(fixture.deviceToken),payload:terminalPayload});assert.equal(terminal.statusCode,200,terminal.body);assert.equal(closes,1);
    const replay=await routed.inject({method:'POST',url:`/api/v1/gateway/calls/${id}/events`,headers:auth(fixture.deviceToken),payload:terminalPayload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);assert.equal(closes,1);
    failClose=false;await db.query(`UPDATE media_close_jobs SET next_attempt_at=now() WHERE call_id=$1`,[id]);const registry=MediaNodeRegistry.fromConfig({...config,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-primary'})!;const worker=new MediaCloseWorker(db,registry,{concurrency:1});assert.equal(await worker.tickOnce(),1);assert.equal(closes,2);assert.equal((await db.query(`SELECT count(*)::int n FROM media_close_jobs WHERE call_id=$1`,[id])).rows[0].n,0);
  }finally{await routed.close();await new Promise<void>((resolve,reject)=>nodeServer.close(error=>error?reject(error):resolve()));}
});

test('SMS delivery state never regresses on a late device event',async()=>{
  const row=(await db.query(`SELECT id,generation FROM sms_messages ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const delivered=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${row.id}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:Number(row.generation),state:'delivered'}});assert.equal(delivered.statusCode,200,delivered.body);
  const late=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${row.id}/events`,headers:auth(deviceToken),payload:{eventId:crypto.randomUUID(),generation:Number(row.generation),state:'sent'}});assert.equal(late.statusCode,200,late.body);
  const final=await db.query(`SELECT state,delivered_at FROM sms_messages WHERE id=$1`,[row.id]);assert.equal(final.rows[0].state,'delivered');assert.ok(final.rows[0].delivered_at);
});

test('SMS commands expose both IDs, late ACK once advances only to sending, and broadcasts finalize delivery',async()=>{
  const fixture=await gatewayFixture(user1,'sms-execution');
  const queued=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'sms-execution-contract'},payload:{simId:fixture.simId,remoteNumber:'+15556001',body:'execute once'}});assert.equal(queued.statusCode,202,queued.body);
  const command=queued.json().command,smsId=queued.json().sms.id;
  await db.query(`UPDATE commands SET payload=payload-'smsId' WHERE id=$1`,[command.id]);
  const heartbeat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});assert.equal(heartbeat.statusCode,200,heartbeat.body);
  const wire=heartbeat.json().commands.find((item:any)=>item.id===command.id);assert.equal(wire.smsId,smsId);assert.equal(wire.payload.smsId,smsId);assert.equal(wire.payload.simId,fixture.simId);assert.equal(wire.payload.body,'execute once');
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[command.id]);
  const ackPayload={generation:fixture.deviceEpoch,status:'acked',result:{phase:'submitted',parts:'1',executedAt:new Date().toISOString()}};
  const late=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:ackPayload});assert.equal(late.statusCode,200,late.body);assert.equal(late.json().command.late,true);assert.equal(late.json().command.replayed,false);
  const sending=(await db.query(`SELECT state,sent_at,delivered_at FROM sms_messages WHERE id=$1`,[smsId])).rows[0];assert.equal(sending.state,'sending');assert.equal(sending.sent_at,null);assert.equal(sending.delivered_at,null);
  const replay=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:ackPayload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().command.replayed,true);
  const sent=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${smsId}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'sent'}});assert.equal(sent.statusCode,200,sent.body);
  const delivered=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${smsId}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'delivered'}});assert.equal(delivered.statusCode,200,delivered.body);
  const final=(await db.query(`SELECT state,sent_at,delivered_at FROM sms_messages WHERE id=$1`,[smsId])).rows[0];assert.equal(final.state,'delivered');assert.ok(final.sent_at);assert.ok(final.delivered_at);
});

test('late SMS rejection safely terminates known and unknown execution outcomes',async()=>{
  const fixture=await gatewayFixture(user1,'sms-late-reject');
  const queue=async(key:string,number:string)=>app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':key},payload:{simId:fixture.simId,remoteNumber:number,body:'do not retry'}});
  const heartbeat=async()=>{
    const response=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
    assert.equal(response.statusCode,200,response.body);
    return response.json().commands.filter((command:any)=>command.kind==='send_sms');
  };
  const dispatchAfterCooldown=async(smsId:string)=>{
    assert.deepEqual(await heartbeat(),[],'the next SMS must remain held during the observed execution cooldown');
    assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE sms_id=$1`,[smsId])).rows[0].n,0);
    await db.query(`UPDATE gateway_sms_pacing SET next_release_at=now()-interval '1 second' WHERE gateway_id=$1`,[fixture.gatewayId]);
    const commands=await heartbeat();assert.equal(commands.length,1);assert.equal(commands[0].smsId,smsId);
    return commands[0];
  };
  const uncertain=await queue('sms-late-uncertain','+15556002');assert.equal(uncertain.statusCode,202,uncertain.body);
  const uncertainCommand=(await heartbeat())[0];assert.equal(uncertainCommand.id,uncertain.json().command.id);
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[uncertain.json().command.id]);
  const unknown=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${uncertain.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'rejected',result:{reason:'execution_unknown'}}});assert.equal(unknown.statusCode,200,unknown.body);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[uncertain.json().sms.id])).rows[0].state,'unknown');
  const actualSent=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${uncertain.json().sms.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'sent'}});assert.equal(actualSent.statusCode,200,actualSent.body);let resolved=(await db.query(`SELECT state,failure_reason FROM sms_messages WHERE id=$1`,[uncertain.json().sms.id])).rows[0];assert.equal(resolved.state,'sent');assert.equal(resolved.failure_reason,null);
  const lateFailure=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${uncertain.json().sms.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'failed',failureReason:'late_generic_failure'}});assert.equal(lateFailure.statusCode,200,lateFailure.body);resolved=(await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[uncertain.json().sms.id])).rows[0];assert.equal(resolved.state,'sent');
  const actualDelivered=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${uncertain.json().sms.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'delivered'}});assert.equal(actualDelivered.statusCode,200,actualDelivered.body);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[uncertain.json().sms.id])).rows[0].state,'delivered');
  const definite=await queue('sms-late-definite','+15556003');assert.equal(definite.statusCode,202,definite.body);
  assert.equal(definite.json().command,null);
  const definiteCommand=await dispatchAfterCooldown(definite.json().sms.id);
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[definiteCommand.id]);
  const failed=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${definiteCommand.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'rejected',sideEffectDisposition:'not_executed',result:{phase:'not_executed',reason:'permission_denied'}}});assert.equal(failed.statusCode,200,failed.body);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[definite.json().sms.id])).rows[0].state,'failed');
  const uncertainFailure=await queue('sms-unknown-then-failed','+15556008');assert.equal(uncertainFailure.statusCode,202,uncertainFailure.body);assert.equal(uncertainFailure.json().command,null);
  const uncertainFailureCommand=await dispatchAfterCooldown(uncertainFailure.json().sms.id);
  const rejected=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${uncertainFailureCommand.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'rejected',result:{reason:'side_effect_unknown'}}});assert.equal(rejected.statusCode,200,rejected.body);assert.equal((await db.query(`SELECT state FROM sms_messages WHERE id=$1`,[uncertainFailure.json().sms.id])).rows[0].state,'unknown');
  const actualFailed=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${uncertainFailure.json().sms.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'failed',failureReason:'radio_failure'}});assert.equal(actualFailed.statusCode,200,actualFailed.body);assert.equal((await db.query(`SELECT state,failure_reason FROM sms_messages WHERE id=$1`,[uncertainFailure.json().sms.id])).rows[0].state,'failed');
  const pending=await db.query(`SELECT count(*)::int n FROM commands WHERE id=ANY($1::uuid[]) AND status='pending'`,[[uncertain.json().command.id,definiteCommand.id,uncertainFailureCommand.id]]);assert.equal(pending.rows[0].n,0);
});

test('incoming SMS snapshots its owner, stores one complete message, and rejects event payload reuse',async()=>{
  const fixture=await gatewayFixture(user1,'incoming-sms-owner');
  const payload={eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'+15556004',body:'complete assembled message',receivedAt:new Date().toISOString()};
  const [a,b]=await Promise.all([
    app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload}),
    app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload}),
  ]);assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,201]);const first=[a,b].find(item=>item.statusCode===201)!;const replay=[a,b].find(item=>item.statusCode===200)!;assert.equal(first.json().disposition,'stored_for_owner');assert.equal(first.json().smsId,replay.json().smsId);assert.equal(replay.json().replayed,true);
  const collision=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload:{...payload,body:'different'}});assert.equal(collision.statusCode,409,collision.body);assert.equal(collision.json().error.code,'EVENT_ID_REUSED');
  const stored=(await db.query(`SELECT * FROM sms_messages WHERE id=$1`,[first.json().smsId])).rows[0];assert.equal(stored.snapshot_owner_id,user1);assert.equal(stored.direction,'incoming');assert.equal(stored.state,'delivered');assert.equal(stored.body,payload.body);assert.equal(new Date(stored.received_at).toISOString(),payload.receivedAt);
  await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[fixture.simId,user2]);
  const oldOwner=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token1)}),newOwner=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token2)});assert.ok(oldOwner.json().items.some((item:any)=>item.id===first.json().smsId));assert.ok(!newOwner.json().items.some((item:any)=>item.id===first.json().smsId));
});

test('S84 incoming long SMS parts under one multipartKey update the partial row within 50 minutes',async()=>{
  const fixture=await gatewayFixture(user1,'incoming-sms-multipart');
  const receivedAt=new Date(Date.now()-5_000).toISOString();
  const send=(body:string,extra:Record<string,unknown>,eventId:string=crypto.randomUUID())=>app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload:{eventId,generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'+15556010',body,receivedAt,...extra}});
  const row=async(id:string)=>(await db.query(`SELECT body,missing_parts,multipart_reference,received_at,created_at,read_at FROM sms_messages WHERE id=$1`,[id])).rows[0];
  const firstEvent=crypto.randomUUID();
  const first=await send('part one [missing]',{multipartKey:'k1',missingParts:true},firstEvent);assert.equal(first.statusCode,201,first.body);const id=first.json().smsId;
  const before=await row(id);assert.equal(before.missing_parts,true);assert.equal(before.multipart_reference,'k1');
  const secondEvent=crypto.randomUUID();
  const second=await send('part one part two',{multipartKey:'k1',missingParts:false},secondEvent);assert.equal(second.statusCode,200,second.body);assert.deepEqual(second.json(),{accepted:true,replayed:false,disposition:'stored_for_owner',smsId:id});
  const after=await row(id);assert.equal(after.body,'part one part two');assert.equal(after.missing_parts,false);assert.equal(after.received_at.toISOString(),before.received_at.toISOString());assert.equal(after.created_at.toISOString(),before.created_at.toISOString());assert.equal(after.read_at,before.read_at);
  const replay=await send('part one part two',{multipartKey:'k1',missingParts:false},secondEvent);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);assert.equal(replay.json().smsId,id);
  const firstReplay=await send('part one [missing]',{multipartKey:'k1',missingParts:true},firstEvent);assert.equal(firstReplay.json().replayed,true);assert.equal((await row(id)).body,'part one part two');
  const complete=await send('late part',{multipartKey:'k1',missingParts:true});assert.equal(complete.statusCode,201,complete.body);assert.notEqual(complete.json().smsId,id);
  await db.query(`UPDATE device_events SET created_at=now()-interval '51 minutes' WHERE resource_id=$1`,[complete.json().smsId]);
  const stale=await send('later part',{multipartKey:'k1',missingParts:false});assert.equal(stale.statusCode,201,stale.body);assert.notEqual(stale.json().smsId,complete.json().smsId);assert.equal((await row(complete.json().smsId)).body,'late part');
  const queuedAt=new Date(Date.now()-2*3600_000).toISOString();
  const queued=await send('queued [missing]',{multipartKey:'k2',missingParts:true,receivedAt:queuedAt});assert.equal(queued.statusCode,201,queued.body);
  const queuedRest=await send('queued complete',{multipartKey:'k2',missingParts:false,receivedAt:queuedAt});assert.equal(queuedRest.statusCode,200,queuedRest.body);assert.equal(queuedRest.json().smsId,queued.json().smsId);assert.equal((await row(queued.json().smsId)).body,'queued complete');
  const plain=await send('no key',{});assert.equal(plain.statusCode,201,plain.body);const plainRow=await row(plain.json().smsId);assert.equal(plainRow.multipart_reference,null);assert.equal(plainRow.missing_parts,false);
});

test('unroutable incoming SMS stays local without persisting body and SIM sync reports routing permission',async()=>{
  const assigned=await gatewayFixture(user1,'sms-routable');
  const assignedSync=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(assigned.deviceToken),payload:{items:[{slotIndex:0,subscriptionId:10,phoneAccountHandle:'phone-account-10',iccidFingerprint:'sms-routable-fingerprint-value'}]}});assert.equal(assignedSync.statusCode,200,assignedSync.body);assert.equal(assignedSync.json().items[0].routable,true);
  assert.equal(assignedSync.json().items[0].assignmentVersion,assignedSync.json().items[0].version);
  const local=await gatewayFixture(null,'sms-local-only');
  const localSync=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(local.deviceToken),payload:{items:[{slotIndex:0,subscriptionId:11,phoneAccountHandle:'phone-account-11',iccidFingerprint:'sms-local-only-fingerprint-value'}]}});assert.equal(localSync.statusCode,200,localSync.body);assert.equal(localSync.json().items[0].routable,false);
  const body='private local-only body';const eventId=crypto.randomUUID();
  const response=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(local.deviceToken),payload:{eventId,generation:local.deviceEpoch,simId:local.simId,assignmentVersion:local.assignmentVersion,remoteNumber:'+15556005',body,receivedAt:new Date().toISOString()}});assert.equal(response.statusCode,202,response.body);assert.deepEqual(response.json(),{accepted:true,replayed:false,disposition:'local_only'});assert.equal(response.body.includes(body),false);
  const stored=await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1 AND direction='incoming'`,[local.gatewayId]);assert.equal(stored.rows[0].n,0);
  const event=(await db.query(`SELECT payload::text payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[local.gatewayId,eventId])).rows[0];assert.equal(event.payload.includes(body),false);
  const stale=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(local.deviceToken),payload:{eventId:crypto.randomUUID(),generation:local.deviceEpoch+1,simId:local.simId,assignmentVersion:local.assignmentVersion,remoteNumber:'+15556005',body,receivedAt:new Date().toISOString()}});assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error.code,'FENCE_REJECTED');
  const unknown=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(local.deviceToken),payload:{eventId:crypto.randomUUID(),generation:local.deviceEpoch,simId:crypto.randomUUID(),assignmentVersion:1,remoteNumber:'+15556005',body,receivedAt:new Date().toISOString()}});assert.equal(unknown.statusCode,202,unknown.body);assert.equal(unknown.json().disposition,'local_only');
});

test('observed outgoing SMS stores the owner snapshot and is idempotent by gateway event id',async()=>{
  const fixture=await gatewayFixture(user1,'outgoing-sms-observed');
  const sentAt=new Date().toISOString();
  const payload={eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'1001298',body:'1',sentAt};
  const unauthenticated=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',payload});assert.equal(unauthenticated.statusCode,401,unauthenticated.body);
  const [a,b]=await Promise.all([
    app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload}),
    app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload}),
  ]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,201]);
  const first=[a,b].find(item=>item.statusCode===201)!;const replay=[a,b].find(item=>item.statusCode===200)!;
  assert.deepEqual(first.json(),{accepted:true,replayed:false,disposition:'stored_for_owner',smsId:first.json().smsId});
  assert.deepEqual(replay.json(),{accepted:true,replayed:true,disposition:'stored_for_owner',smsId:first.json().smsId});
  const stored=(await db.query(`SELECT * FROM sms_messages WHERE id=$1`,[first.json().smsId])).rows[0];
  assert.equal(stored.snapshot_owner_id,user1);assert.equal(stored.direction,'outgoing');assert.equal(stored.state,'sent');assert.equal(Number(stored.generation),fixture.deviceEpoch);assert.equal(stored.remote_number,payload.remoteNumber);assert.equal(stored.body,payload.body);assert.equal(new Date(stored.sent_at).toISOString(),sentAt);assert.equal(new Date(stored.created_at).toISOString(),sentAt);assert.equal(stored.received_at,null);assert.equal(stored.delivered_at,null);
  const event=(await db.query(`SELECT event_type,resource_id FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[fixture.gatewayId,payload.eventId])).rows[0];assert.equal(event.event_type,'sms.outgoing_observed');assert.equal(event.resource_id,first.json().smsId);
  const collision=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload:{...payload,body:'different'}});assert.equal(collision.statusCode,409,collision.body);assert.equal(collision.json().error.code,'EVENT_ID_REUSED');
});

test('observed outgoing SMS rejects a stale generation and keeps stale assignment versions local only',async()=>{
  const fixture=await gatewayFixture(user1,'outgoing-sms-stale');
  const base={simId:fixture.simId,remoteNumber:'+15556009',body:'manual reply',sentAt:new Date().toISOString()};
  const staleGeneration=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload:{...base,eventId:crypto.randomUUID(),generation:fixture.deviceEpoch+1,assignmentVersion:fixture.assignmentVersion}});assert.equal(staleGeneration.statusCode,409,staleGeneration.body);assert.equal(staleGeneration.json().error.code,'FENCE_REJECTED');
  const eventId=crypto.randomUUID();
  const staleVersion=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload:{...base,eventId,generation:fixture.deviceEpoch,assignmentVersion:fixture.assignmentVersion+1}});assert.equal(staleVersion.statusCode,202,staleVersion.body);assert.deepEqual(staleVersion.json(),{accepted:true,replayed:false,disposition:'local_only'});
  const stored=await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1 AND direction='outgoing' AND body=$2`,[fixture.gatewayId,base.body]);assert.equal(stored.rows[0].n,0);
  const event=(await db.query(`SELECT event_type,payload::text payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[fixture.gatewayId,eventId])).rows[0];assert.equal(event.event_type,'sms.outgoing_observed');assert.equal(event.payload.includes(base.body),false);
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload:{...base,eventId,generation:fixture.deviceEpoch,assignmentVersion:fixture.assignmentVersion+1}});assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),{accepted:true,replayed:true,disposition:'local_only'});
});

test('observed outgoing SMS for a SIM not bound to this gateway stays local only and replays',async()=>{
  const fixture=await gatewayFixture(user1,'outgoing-sms-unknown-sim');const body='unbound sim body';const eventId=crypto.randomUUID();
  const payload={eventId,generation:fixture.deviceEpoch,simId:crypto.randomUUID(),assignmentVersion:1,remoteNumber:'+15556010',body,sentAt:new Date().toISOString()};
  const first=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload});assert.equal(first.statusCode,202,first.body);assert.deepEqual(first.json(),{accepted:true,replayed:false,disposition:'local_only'});
  const stored=await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1 AND direction='outgoing'`,[fixture.gatewayId]);assert.equal(stored.rows[0].n,0);
  const event=(await db.query(`SELECT event_type,payload::text payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[fixture.gatewayId,eventId])).rows[0];assert.equal(event.event_type,'sms.outgoing_observed');assert.equal(event.payload.includes(body),false);
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload});assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),{accepted:true,replayed:true,disposition:'local_only'});
});

test('SMS_OUTGOING_OBSERVED_ENABLED=false fences and journals the report but keeps it local only',async()=>{
  const fixture=await gatewayFixture(user1,'outgoing-sms-flag-off');const eventId=crypto.randomUUID();
  const payload={eventId,generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'+15556011',body:'flag off',sentAt:new Date().toISOString()};
  config.SMS_OUTGOING_OBSERVED_ENABLED=false;
  try{
    const stale=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload:{...payload,eventId:crypto.randomUUID(),generation:fixture.deviceEpoch+1}});assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error.code,'FENCE_REJECTED');
    const first=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload});assert.equal(first.statusCode,202,first.body);assert.deepEqual(first.json(),{accepted:true,replayed:false,disposition:'local_only'});
    const stored=await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1 AND direction='outgoing'`,[fixture.gatewayId]);assert.equal(stored.rows[0].n,0);
    const event=await db.query(`SELECT event_type FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[fixture.gatewayId,eventId]);assert.equal(event.rows[0].event_type,'sms.outgoing_observed');
    const replay=await app.inject({method:'POST',url:'/api/v1/gateway/sms/outgoing-observed',headers:auth(fixture.deviceToken),payload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
  }finally{config.SMS_OUTGOING_OBSERVED_ENABLED=true;}
});

test('an offline incoming SMS receipt cannot move to a newly assigned owner',async()=>{
  const fixture=await gatewayFixture(user1,'sms-assignment-fence');const body='belongs to assignment version one';const eventId=crypto.randomUUID();
  const reassigned=await app.inject({method:'PUT',url:`/api/v1/admin/sims/${fixture.simId}/owner`,headers:auth(adminToken),payload:{ownerUserId:user2,expectedVersion:fixture.assignmentVersion}});assert.equal(reassigned.statusCode,200,reassigned.body);assert.ok(reassigned.json().sim.version>fixture.assignmentVersion);
  const delayed=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload:{eventId,generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'+15556009',body,receivedAt:new Date(Date.now()-60_000).toISOString()}});assert.equal(delayed.statusCode,202,delayed.body);assert.deepEqual(delayed.json(),{accepted:true,replayed:false,disposition:'local_only'});assert.equal(delayed.body.includes(body),false);
  const count=await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1 AND direction='incoming'`,[fixture.gatewayId]);assert.equal(count.rows[0].n,0);
  const persisted=(await db.query(`SELECT payload::text payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[fixture.gatewayId,eventId])).rows[0];assert.equal(persisted.payload.includes(body),false);
  const newOwner=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token2)});assert.ok(!newOwner.json().items.some((item:any)=>item.body===body));
});

test('call and SMS state event IDs cannot be reused with a different payload',async()=>{
  const fixture=await gatewayFixture(user1,'state-event-collision');
  const call=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'call-state-event-collision'},payload:{simId:fixture.simId,remoteNumber:'+15556006'}});assert.equal(call.statusCode,202,call.body);
  const callEventId=crypto.randomUUID();const active=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.json().call.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:callEventId,generation:fixture.deviceEpoch,state:'active'}});assert.equal(active.statusCode,200,active.body);
  const callCollision=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.json().call.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:callEventId,generation:fixture.deviceEpoch,state:'ended'}});assert.equal(callCollision.statusCode,409,callCollision.body);assert.equal(callCollision.json().error.code,'EVENT_ID_REUSED');
  const sms=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'sms-state-event-collision'},payload:{simId:fixture.simId,remoteNumber:'+15556007',body:'state collision'}});assert.equal(sms.statusCode,202,sms.body);
  const smsEventId=crypto.randomUUID();const sent=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${sms.json().sms.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:smsEventId,generation:fixture.deviceEpoch,state:'sent'}});assert.equal(sent.statusCode,200,sent.body);
  const smsCollision=await app.inject({method:'POST',url:`/api/v1/gateway/sms/${sms.json().sms.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:smsEventId,generation:fixture.deviceEpoch,state:'delivered'}});assert.equal(smsCollision.statusCode,409,smsCollision.body);assert.equal(smsCollision.json().error.code,'EVENT_ID_REUSED');
});

test('settings use CAS and fail closed when AI is unavailable',async()=>{
  const listed=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(token1)});const listedSettings=listed.json().items.find((item:any)=>item.id===sim1).settings;
  assert.deepEqual(listedSettings.availableModes,['normal']);assert.equal(listedSettings.aiUnavailableCode,'AI_DISABLED');assert.equal(listedSettings.aiUnavailableReason,'AI 接听尚未开放');
  const ai=await app.inject({method:'PUT',url:`/api/v1/sims/${sim1}/settings`,headers:auth(token1),payload:{mode:'ai',timeoutSeconds:45,expectedVersion:1}});assert.equal(ai.statusCode,409);assert.equal(ai.json().error.code,'AI_UNAVAILABLE');
  const first=await app.inject({method:'PUT',url:`/api/v1/sims/${sim1}/settings`,headers:auth(token1),payload:{mode:'normal',timeoutSeconds:60,expectedVersion:1}});assert.equal(first.statusCode,200);assert.equal(first.json().settings.version,2);
  assert.equal(first.json().settings.appliedVersion,null);assert.equal(first.json().command.simId,sim1);
  const command=(await db.query(`SELECT kind,payload,status FROM commands WHERE id=$1`,[first.json().command.id])).rows[0];assert.equal(command.kind,'apply_sim_settings');assert.equal(command.status,'pending');assert.deepEqual(command.payload,{simId:sim1,mode:'normal',timeoutSeconds:60,settingsVersion:2,assignmentVersion:1});
  const heartbeat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}}});assert.equal(heartbeat.statusCode,200,heartbeat.body);assert.ok(heartbeat.json().commands.some((item:any)=>item.id===first.json().command.id&&item.kind==='apply_sim_settings'));
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${first.json().command.id}/ack`,headers:auth(deviceToken),payload:{generation:first.json().command.generation,status:'acked',result:{simId:sim1,appliedVersion:2,assignmentVersion:1}}});assert.equal(ack.statusCode,200,ack.body);const applied=(await db.query(`SELECT applied_version,applied_assignment_version,applied_generation FROM sim_settings WHERE sim_id=$1`,[sim1])).rows[0];assert.deepEqual(applied,{applied_version:'2',applied_assignment_version:'1',applied_generation:'1'});
  const stale=await app.inject({method:'PUT',url:`/api/v1/sims/${sim1}/settings`,headers:auth(token1),payload:{mode:'normal',timeoutSeconds:70,expectedVersion:1}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'VERSION_CONFLICT');
  const adminList=await app.inject({method:'GET',url:'/api/v1/admin/sims',headers:auth(adminToken)});
  const ownerList=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(token1)});
  assert.equal(adminList.statusCode,200);
  assert.deepEqual(adminList.json().items.find((item:any)=>item.id===sim1).settings,ownerList.json().items.find((item:any)=>item.id===sim1).settings);
  const audit=(await db.query(`SELECT actor_user_id,details FROM audit_events WHERE resource_id=$1 AND action='sim.settings.update'`,[sim1])).rows;
  assert.deepEqual(audit,[{actor_user_id:user1,details:{mode:'normal',timeoutSeconds:60,settingsVersion:2,assignmentVersion:1}}]);
});

test('integrated gateway AI reports use actual admin authentication and a private empty response',async()=>{
  const url=`/api/v1/admin/gateways/${gateway}/reports/calls?period=7d&timeZone=Asia%2FTaipei&answeredBy=ai`;
  assert.equal((await app.inject({method:'GET',url})).statusCode,401);
  assert.equal((await app.inject({method:'GET',url,headers:auth(token1)})).statusCode,403);
  const result=await app.inject({method:'GET',url,headers:auth(adminToken)});
  assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json().items,[]);
  assert.equal(result.headers['cache-control'],'private, no-store');
});

test('settings ACK cannot cross assignment or desired-version fences',async()=>{
  const fixture=await gatewayFixture(user1,'settings-fence');
  const first=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}/settings`,headers:auth(token1),payload:{mode:'normal',timeoutSeconds:50,expectedVersion:1}});assert.equal(first.statusCode,200,first.body);
  await db.query(`UPDATE sims SET version=version+1 WHERE id=$1`,[fixture.simId]);
  const staleAssignment=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${first.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',result:{simId:fixture.simId,appliedVersion:2,assignmentVersion:fixture.assignmentVersion}}});assert.equal(staleAssignment.statusCode,200,staleAssignment.body);
  assert.equal((await db.query(`SELECT applied_version FROM sim_settings WHERE sim_id=$1`,[fixture.simId])).rows[0].applied_version,null);

  const second=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}/settings`,headers:auth(token1),payload:{mode:'normal',timeoutSeconds:55,expectedVersion:2}});assert.equal(second.statusCode,200,second.body);
  await db.query(`UPDATE sim_settings SET version=version+1 WHERE sim_id=$1`,[fixture.simId]);
  const staleDesired=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${second.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',result:{simId:fixture.simId,appliedVersion:3,assignmentVersion:fixture.assignmentVersion+1}}});assert.equal(staleDesired.statusCode,200,staleDesired.body);
  assert.equal((await db.query(`SELECT applied_version FROM sim_settings WHERE sim_id=$1`,[fixture.simId])).rows[0].applied_version,null);
});

test('AI modes require both product enablement and explicit worker readiness',async()=>{
  const fixture=await gatewayFixture(user1,'ai-settings-capability');
  const workerMissing=await buildApp(db,{...config,AI_ENABLED:true,AI_WORKER_READY:false});
  try{
    const list=await workerMissing.inject({method:'GET',url:'/api/v1/sims',headers:auth(token1)});const settings=list.json().items.find((item:any)=>item.id===fixture.simId).settings;
    assert.deepEqual(settings.availableModes,['normal']);assert.equal(settings.aiUnavailableCode,'AI_WORKER_UNAVAILABLE');assert.equal(settings.aiUnavailableReason,'AI 接听服务尚未就绪');
    const blocked=await workerMissing.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}/settings`,headers:auth(token1),payload:{mode:'ai',timeoutSeconds:45,expectedVersion:1}});assert.equal(blocked.statusCode,409,blocked.body);
  }finally{await workerMissing.close();}
  await db.query(`INSERT INTO ai_worker_instances(instance_id,boot_id,protocol,capacity,expires_at)VALUES(gen_random_uuid(),gen_random_uuid(),'voice-run-v1',1,now()+interval '15 seconds')`);
  const ready=await buildApp(db,{...config,AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:'control-test-ai-token-at-least-32-characters'});
  try{
    const list=await ready.inject({method:'GET',url:'/api/v1/sims',headers:auth(token1)});const settings=list.json().items.find((item:any)=>item.id===fixture.simId).settings;
    assert.deepEqual(settings.availableModes,['normal','ai','timeout_ai']);assert.equal(settings.aiUnavailableReason,undefined);
    const accepted=await ready.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}/settings`,headers:auth(token1),payload:{mode:'ai',timeoutSeconds:45,expectedVersion:1}});assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().settings.mode,'ai');assert.equal(accepted.json().settings.appliedVersion,null);
  }finally{await ready.close();}
});

test('heartbeat durably reconciles initial, expired, and new-epoch SIM settings',async()=>{
  const fixture=await gatewayFixture(user1,'settings-reconcile');
  const heartbeat=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}}});
  const initial=await heartbeat();assert.equal(initial.statusCode,200,initial.body);
  const first=initial.json().commands.find((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId);assert.ok(first);assert.deepEqual(first.payload,{simId:fixture.simId,mode:'normal',timeoutSeconds:45,settingsVersion:1,assignmentVersion:fixture.assignmentVersion});
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[first.id]);
  const retried=await heartbeat();assert.equal(retried.statusCode,200,retried.body);const second=retried.json().commands.find((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId);assert.ok(second);assert.notEqual(second.id,first.id);assert.ok(second.sequence>first.sequence);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${second.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',result:{simId:fixture.simId,appliedVersion:1,assignmentVersion:fixture.assignmentVersion}}});assert.equal(ack.statusCode,200,ack.body);
  const settled=await heartbeat();assert.equal(settled.statusCode,200,settled.body);assert.ok(!settled.json().commands.some((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId));
  await db.query(`UPDATE gateways SET device_epoch=device_epoch+1,command_sequence=0 WHERE id=$1`,[fixture.gatewayId]);
  const rotated=await heartbeat();assert.equal(rotated.statusCode,200,rotated.body);const third=rotated.json().commands.find((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId);assert.ok(third);assert.equal(third.generation,fixture.deviceEpoch+1);assert.equal(third.sequence,1);
});

test('a device refusal without execution backs settings off for 60 s instead of one command per heartbeat',async()=>{
  const fixture=await gatewayFixture(user1,'settings-refusal-backoff');
  const heartbeat=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}}});
  const initial=await heartbeat();assert.equal(initial.statusCode,200,initial.body);
  const command=initial.json().commands.find((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId);assert.ok(command);
  const refused=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'rejected',result:{phase:'not_executed',reason:'ai_unavailable'}}});assert.equal(refused.statusCode,200,refused.body);
  for(let beat=0;beat<3;beat++){
    const quiet=await heartbeat();assert.equal(quiet.statusCode,200,quiet.body);
    assert.equal(quiet.json().commands.some((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId),false);
  }
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE gateway_id=$1 AND kind='apply_sim_settings'`,[fixture.gatewayId])).rows[0].n,1);
  // The backoff is time bounded, never permanent.
  await db.query(`UPDATE commands SET created_at=now()-interval '61 seconds' WHERE gateway_id=$1 AND kind='apply_sim_settings'`,[fixture.gatewayId]);
  const resumed=await heartbeat();assert.equal(resumed.statusCode,200,resumed.body);
  const retry=resumed.json().commands.find((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId);assert.ok(retry);assert.notEqual(retry.id,command.id);
  // Control's own supersede marker carries no `phase`, so a legitimate version bump is never muted.
  await db.query(`UPDATE commands SET status='rejected',result='{"reason":"settings_superseded"}' WHERE id=$1`,[retry.id]);
  const superseded=await heartbeat();assert.equal(superseded.statusCode,200,superseded.body);
  assert.ok(superseded.json().commands.some((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId&&item.id!==retry.id));
});

test('an AI-owned ringing call never reaches APNs and rings again once the run releases it',async()=>{
  const {PushWorker}=await import('../src/push-worker.js');
  await db.query("UPDATE call_records SET state='ended' WHERE state='incoming_ringing'");
  const fixture=await gatewayFixture(user1,'ai-push-suppression');
  const session=(await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,$2,'native','ios',now()+interval '15 minutes',now()+interval '1 day') RETURNING id`,[user1,tokenHash(crypto.randomUUID())])).rows[0].id;
  const registration=(await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,environment,device_name,voip_token)VALUES($1,$2,$3,'development','AI push fixture',$4) RETURNING id`,[crypto.randomUUID(),user1,session,'d'.repeat(64)])).rows[0].id;
  const callId=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'ai') RETURNING id`,[fixture.gatewayId,fixture.simId,user1,fixture.deviceEpoch])).rows[0].id;
  const runId=(await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
    VALUES($1,$2,$3,$4,1,'ai',1,1,45,now()) RETURNING id`,[callId,fixture.gatewayId,user1,fixture.deviceEpoch])).rows[0].id;
  await db.query(`UPDATE call_records SET ai_run_id=$2 WHERE id=$1`,[callId,runId]);
  const sent:string[]=[];const worker=new PushWorker(db,{sendIncoming:async(push:any)=>{sent.push(push.callId);return {status:200};}});
  await worker.tick();
  assert.deepEqual(sent,[]);
  assert.equal((await db.query('SELECT count(*)::int n FROM push_deliveries WHERE call_id=$1',[callId])).rows[0].n,0);
  // A row queued before the run existed is still refused at delivery authorization.
  await db.query('INSERT INTO push_deliveries(call_id,registration_id,session_id)VALUES($1,$2,$3)',[callId,registration,session]);
  await worker.tick();
  assert.deepEqual(sent,[]);
  assert.equal((await db.query('SELECT state FROM push_deliveries WHERE call_id=$1',[callId])).rows[0].state,'cancelled');
  // S22 decision 5: releasing the run restores a normal ring for the same still-ringing call.
  await db.query(`UPDATE call_records SET ai_run_id=NULL,failure_reason='ai_worker_unavailable' WHERE id=$1`,[callId]);
  await db.query(`DELETE FROM push_deliveries WHERE call_id=$1`,[callId]);
  await worker.tick();
  assert.deepEqual(sent,[callId]);
  const dto=await app.inject({method:'GET',url:`/api/v1/calls/${callId}`,headers:auth(token1)});
  assert.equal(dto.statusCode,200,dto.body);
  assert.equal(dto.json().call.answerMode,'ai');assert.equal(dto.json().call.aiHandling,false);assert.equal(dto.json().call.occupancy.canRelease,true);
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[callId]);
  await db.query(`UPDATE push_registrations SET disabled_at=now(),voip_token=NULL WHERE id=$1`,[registration]);
});

test('the call DTO exposes the AI suppression contract and refuses human release while AI answers',async()=>{
  const fixture=await gatewayFixture(user1,'ai-dto-suppression');
  const callId=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ai_trigger_at)VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'ai',now()) RETURNING id`,[fixture.gatewayId,fixture.simId,user1,fixture.deviceEpoch])).rows[0].id;
  const runId=(await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
    VALUES($1,$2,$3,$4,1,'ai',1,1,45,now()) RETURNING id`,[callId,fixture.gatewayId,user1,fixture.deviceEpoch])).rows[0].id;
  await db.query(`UPDATE call_records SET ai_run_id=$2 WHERE id=$1`,[callId,runId]);
  const detail=await app.inject({method:'GET',url:`/api/v1/calls/${callId}`,headers:auth(token1)});assert.equal(detail.statusCode,200,detail.body);
  assert.equal(detail.json().call.answerMode,'ai');assert.equal(detail.json().call.aiHandling,true);assert.ok(detail.json().call.aiTriggerAt);
  assert.equal(detail.json().call.occupancy.canRelease,false);
  const list=await app.inject({method:'GET',url:'/api/v1/calls?limit=100',headers:auth(token1)});assert.equal(list.statusCode,200,list.body);
  const listed=list.json().items.find((item:any)=>item.id===callId);assert.ok(listed);assert.equal(listed.aiHandling,true);assert.equal(listed.occupancy.canRelease,false);
  // A terminal run stops suppressing immediately, without waiting for the call row to change.
  await db.query(`UPDATE ai_call_runs SET state='lost_race' WHERE id=$1`,[runId]);
  const released=await app.inject({method:'GET',url:`/api/v1/calls/${callId}`,headers:auth(token1)});
  assert.equal(released.json().call.aiHandling,false);assert.equal(released.json().call.occupancy.canRelease,true);
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[callId]);
});

test('call history search matches numbers and contact names, pages with a cursor, and backfills legacy rows',async()=>{
  const fixture=await gatewayFixture(user1,'call-search');
  const contact=await app.inject({method:'POST',url:'/api/v1/contacts',headers:auth(token1),payload:{displayName:'张三 Sales',phones:[{rawNumber:'+8618600000001'}]}});
  assert.ok(contact.statusCode<300,contact.body);
  // Rows written before the column existed carry no key; the search must degrade, never fail.
  const legacy=async(remote:string,minutesAgo:number)=>(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,started_at)
    VALUES($1,$2,$3,'incoming',$4,'ended',$5,'normal',now()-($6::text||' minutes')::interval) RETURNING id`,[fixture.gatewayId,fixture.simId,user1,remote,fixture.deviceEpoch,minutesAgo])).rows[0].id as string;
  const named=await legacy('+8618600000001',3);
  const older=await legacy('+19998880001',2);
  const newer=await legacy('+19998880002',1);
  assert.equal((await db.query('SELECT remote_canonical_key FROM call_records WHERE id=$1',[named])).rows[0].remote_canonical_key,null);
  const byNumber=await app.inject({method:'GET',url:'/api/v1/calls?query=99988800',headers:auth(token1)});assert.equal(byNumber.statusCode,200,byNumber.body);
  assert.deepEqual(byNumber.json().items.map((item:any)=>item.id),[newer,older]);
  const beforeBackfill=await app.inject({method:'GET',url:`/api/v1/calls?query=${encodeURIComponent('张三')}`,headers:auth(token1)});
  assert.deepEqual(beforeBackfill.json().items.map((item:any)=>item.id),[]);
  await backfillCallCanonicalKeys(db,()=>{});
  assert.equal((await db.query('SELECT remote_canonical_key FROM call_records WHERE id=$1',[named])).rows[0].remote_canonical_key,'+8618600000001');
  const byName=await app.inject({method:'GET',url:`/api/v1/calls?query=${encodeURIComponent('张三')}`,headers:auth(token1)});
  assert.deepEqual(byName.json().items.map((item:any)=>item.id),[named]);
  const page=await app.inject({method:'GET',url:'/api/v1/calls?query=99988800&limit=1',headers:auth(token1)});
  assert.deepEqual(page.json().items.map((item:any)=>item.id),[newer]);
  const next=await app.inject({method:'GET',url:`/api/v1/calls?query=99988800&limit=1&before=${encodeURIComponent(new Date(page.json().items[0].startedAt).toISOString())}`,headers:auth(token1)});
  assert.deepEqual(next.json().items.map((item:any)=>item.id),[older]);
  // A LIKE wildcard inside the query text is stripped: it can neither widen the match nor break it.
  const stripped=await app.inject({method:'GET',url:`/api/v1/calls?query=${encodeURIComponent('张%三')}`,headers:auth(token1)});
  assert.deepEqual(stripped.json().items.map((item:any)=>item.id),[named]);
  // A cleared search box sends an empty value; that is an unfiltered page, never a 400.
  const cleared=await app.inject({method:'GET',url:'/api/v1/calls?query=&limit=3',headers:auth(token1)});
  assert.equal(cleared.statusCode,200,cleared.body);
  const unfiltered=await app.inject({method:'GET',url:'/api/v1/calls?limit=3',headers:auth(token1)});
  assert.deepEqual(cleared.json().items.map((item:any)=>item.id),unfiltered.json().items.map((item:any)=>item.id));
  // A national-format number on a SIM without a reported country still keys like its contact does.
  const national=await legacy('18600000001',4);
  await backfillCallCanonicalKeys(db,()=>{});
  assert.equal((await db.query('SELECT remote_canonical_key FROM call_records WHERE id=$1',[national])).rows[0].remote_canonical_key,'+8618600000001');
  const bothByName=await app.inject({method:'GET',url:`/api/v1/calls?query=${encodeURIComponent('张三')}`,headers:auth(token1)});
  assert.deepEqual(bothByName.json().items.map((item:any)=>item.id).sort(),[named,national].sort());
});

test('S28: /calls offset pages are opt-in, counted, SIM filtered, and leave the legacy envelope alone',async()=>{
  // A dedicated owner so `total` means exactly "the rows this test inserted".
  const passwordHash=await hashPassword('correct horse battery staple');
  const owner=(await db.query(`INSERT INTO users(email,password_hash)VALUES('calls-paging@example.test',$1)RETURNING id`,[passwordHash])).rows[0].id;
  const stranger=(await db.query(`INSERT INTO users(email,password_hash)VALUES('calls-paging-stranger@example.test',$1)RETURNING id`,[passwordHash])).rows[0].id;
  const ownerToken=await login('calls-paging@example.test','correct horse battery staple');
  const primary=await gatewayFixture(owner,'calls-paging-primary');
  const secondary=await gatewayFixture(owner,'calls-paging-secondary');
  const elsewhere=await gatewayFixture(stranger,'calls-paging-stranger');
  const insert=async(ownerUserId:string,fixture:{gatewayId:string;simId:string;deviceEpoch:number},remote:string,startedAt:Date)=>
    (await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,started_at)
      VALUES($1,$2,$3,'incoming',$4,'ended',$5,'normal',$6) RETURNING id`,
      [fixture.gatewayId,fixture.simId,ownerUserId,remote,fixture.deviceEpoch,startedAt])).rows[0].id as string;
  const base=Date.parse('2025-05-01T00:00:00.000Z');
  const expected:string[]=[];
  for(let index=0;index<120;index+=1){
    // index 0 is the newest row, so `expected` is already in the route's ORDER BY order.
    const onSecondary=index%3===0;      // 40 rows
    const searchable=index%4===0;       // 30 rows match `query=555777`
    expected.push(await insert(owner,onSecondary?secondary:primary,
      `+1555${searchable?'777':'900'}${String(index).padStart(3,'0')}`,new Date(base-index*60_000)));
  }
  // Another owner's rows sit in the same window and must never be paged or counted here.
  for(let index=0;index<5;index+=1)await insert(stranger,elsewhere,`+1555777${String(index).padStart(3,'0')}`,new Date(base-index*60_000));

  const page=async(search:string)=>{
    const response=await app.inject({method:'GET',url:`/api/v1/calls?${search}`,headers:auth(ownerToken)});
    assert.equal(response.statusCode,200,response.body);
    return response.json() as {items:any[];page:number;pageSize:number;total:number;totalPages:number};
  };
  const first=await page('page=1&pageSize=50');
  assert.deepEqual(Object.keys(first).sort(),['items','page','pageSize','total','totalPages']);
  assert.equal(first.items.length,50);
  assert.equal(first.page,1);assert.equal(first.pageSize,50);
  assert.equal(first.total,120,'the stranger rows are neither paged nor counted');
  assert.equal(first.totalPages,3);
  assert.equal(first.items[0].id,expected[0],'the first page opens on the newest call');
  const second=await page('page=2&pageSize=50');
  const third=await page('page=3&pageSize=50');
  assert.equal(third.items.length,20,'the last page is the remainder, not a padded page');
  assert.deepEqual([...first.items,...second.items,...third.items].map((item:any)=>item.id),expected,
    'the three pages are disjoint, ordered, and cover every row exactly once');
  // A page past the end is an empty page with honest totals, never a 404 and never a clamp.
  const past=await page('page=4&pageSize=50');
  assert.deepEqual(past.items,[]);
  assert.equal(past.total,120);assert.equal(past.totalPages,3);assert.equal(past.page,4);
  // The default page size is 50 and the two other sizes are the whole permitted set.
  assert.equal((await page('page=1')).pageSize,50);
  assert.equal((await page('page=1&pageSize=100')).items.length,100);
  assert.equal((await page('page=1&pageSize=200')).totalPages,1);

  const rejected=async(search:string)=>{
    const response=await app.inject({method:'GET',url:`/api/v1/calls?${search}`,headers:auth(ownerToken)});
    assert.equal(response.statusCode,400,response.body);
    assert.equal(response.json().error.code,'INVALID_REQUEST');
  };
  await rejected('page=1&pageSize=25');
  await rejected('page=0');
  await rejected('page=1&pageSize=51');
  await rejected(`page=1&before=${encodeURIComponent(new Date(base).toISOString())}`);
  await rejected(`page=1&beforeId=${expected[0]}`);
  await rejected('simId=not-a-uuid');

  // Legacy: no `page`, so the envelope is exactly what it was and the cursor still works.
  const legacyResponse=await app.inject({method:'GET',url:'/api/v1/calls?limit=100',headers:auth(ownerToken)});
  assert.deepEqual(Object.keys(legacyResponse.json()),['items'],'a legacy caller sees no paging keys at all');
  assert.deepEqual(legacyResponse.json().items.map((item:any)=>item.id),expected.slice(0,100));
  const cursor=await app.inject({method:'GET',
    url:`/api/v1/calls?limit=100&before=${encodeURIComponent(new Date(base-99*60_000).toISOString())}&beforeId=${expected[99]}`,
    headers:auth(ownerToken)});
  assert.deepEqual(cursor.json().items.map((item:any)=>item.id),expected.slice(100));

  // Search composes with the page: it narrows the total, not just the visible slice.
  const searched=await page('page=1&pageSize=50&query=555777');
  assert.equal(searched.total,30);assert.equal(searched.totalPages,1);assert.equal(searched.items.length,30);
  assert.deepEqual(searched.items.map((item:any)=>item.id),expected.filter((_,index)=>index%4===0));

  // The SIM filter narrows both modes identically — the web client used to do this after the cut.
  const bySim=await page(`page=1&pageSize=50&simId=${secondary.simId}`);
  assert.equal(bySim.total,40);assert.equal(bySim.totalPages,1);
  assert.deepEqual(bySim.items.map((item:any)=>item.id),expected.filter((_,index)=>index%3===0));
  const legacyBySim=await app.inject({method:'GET',url:`/api/v1/calls?limit=100&simId=${secondary.simId}`,headers:auth(ownerToken)});
  assert.deepEqual(legacyBySim.json().items.map((item:any)=>item.id),expected.filter((_,index)=>index%3===0));
  assert.deepEqual(Object.keys(legacyBySim.json()),['items']);
  // Two filters at once still agree between the page and its count.
  const both=await page(`page=1&pageSize=50&simId=${secondary.simId}&query=555777`);
  assert.equal(both.total,10,'index divisible by 12');
  assert.deepEqual(both.items.map((item:any)=>item.id),expected.filter((_,index)=>index%12===0));
  // Owner isolation holds in paged mode: the stranger's own page never sees these rows.
  const strangerToken=await login('calls-paging-stranger@example.test','correct horse battery staple');
  const strangerPage=await app.inject({method:'GET',url:'/api/v1/calls?page=1&pageSize=50',headers:auth(strangerToken)});
  assert.equal(strangerPage.json().total,5);
  assert.equal(strangerPage.json().items.some((item:any)=>expected.includes(item.id)),false);
});

test('settings ACK result must prove the exact applied payload',async()=>{
  const fixture=await gatewayFixture(user1,'settings-ack-proof');
  const heartbeat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}}});assert.equal(heartbeat.statusCode,200,heartbeat.body);const command=heartbeat.json().commands.find((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId);assert.ok(command);
  const incomplete=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',result:{simId:fixture.simId}}});assert.equal(incomplete.statusCode,200,incomplete.body);
  assert.equal((await db.query(`SELECT applied_version FROM sim_settings WHERE sim_id=$1`,[fixture.simId])).rows[0].applied_version,null);
  const retry=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}}});assert.equal(retry.statusCode,200,retry.body);assert.ok(retry.json().commands.some((item:any)=>item.kind==='apply_sim_settings'&&item.simId===fixture.simId&&item.id!==command.id));
});

test('reported capabilities gate telephony commands',async()=>{
  const down=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}}});assert.equal(down.statusCode,200,down.body);
  const blocked=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'not-ready-sms'},payload:{simId:sim1,remoteNumber:'+15550301',body:'test'}});assert.equal(blocked.statusCode,503);assert.equal(blocked.json().error.code,'GATEWAY_NOT_READY');
  const up=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});assert.equal(up.statusCode,200);
});

test('smsReady permits SMS without opening calls and defaults closed when omitted',async()=>{
  const fixture=await gatewayFixture(user1,'sms-only-capability');
  const smsOnly=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:true,mediaReady:false}}});assert.equal(smsOnly.statusCode,200,smsOnly.body);
  const sms=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'sms-only-capability-send'},payload:{simId:fixture.simId,remoteNumber:'+15556010',body:'sms stays available'}});assert.equal(sms.statusCode,202,sms.body);
  const call=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'sms-only-capability-call'},payload:{simId:fixture.simId,remoteNumber:'+15556011'}});assert.equal(call.statusCode,503,call.body);assert.equal(call.json().error.code,'GATEWAY_NOT_READY');
  const omitted=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,mediaReady:true}}});assert.equal(omitted.statusCode,200,omitted.body);
  const closed=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'sms-missing-capability'},payload:{simId:fixture.simId,remoteNumber:'+15556012',body:'must stay closed'}});assert.equal(closed.statusCode,503,closed.body);assert.equal(closed.json().error.code,'GATEWAY_NOT_READY');
});

test('a reported cross-capability sequence cannot starve an older pending SMS command',async()=>{
  const fixture=await gatewayFixture(user1,'cross-capability-sequence');
  const sms=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'older-pending-sms'},payload:{simId:fixture.simId,remoteNumber:'+15556013',body:'deliver after capability returns'}});assert.equal(sms.statusCode,202,sms.body);
  const call=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'newer-call-command'},payload:{simId:fixture.simId,remoteNumber:'+15556014'}});assert.equal(call.statusCode,202,call.body);assert.ok(call.json().command.sequence>sms.json().command.sequence);
  const callsOnly=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:false,mediaReady:true}}});assert.equal(callsOnly.statusCode,200,callsOnly.body);assert.deepEqual(callsOnly.json().commands.filter((item:any)=>item.kind!=='apply_sim_settings').map((item:any)=>item.id),[call.json().command.id]);
  const callAck=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${call.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',telecomState:'DIALING'}});assert.equal(callAck.statusCode,200,callAck.body);
  const smsRestored=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:call.json().command.sequence,capabilities:{telephonyReady:false,smsReady:true,mediaReady:true}}});assert.equal(smsRestored.statusCode,200,smsRestored.body);assert.deepEqual(smsRestored.json().commands.filter((item:any)=>item.kind!=='apply_sim_settings').map((item:any)=>item.id),[sms.json().command.id]);
  const smsAck=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${sms.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',result:{phase:'submitted',parts:'1',executedAt:new Date().toISOString()}}});assert.equal(smsAck.statusCode,200,smsAck.body);
  const gone=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:call.json().command.sequence,capabilities:{telephonyReady:false,smsReady:true,mediaReady:true}}});assert.equal(gone.statusCode,200,gone.body);assert.ok(!gone.json().commands.some((item:any)=>item.id===sms.json().command.id));
});

test('S36 C3: diag ingest takes both principals, drops junk items, and never invents a source',async()=>{
  const fixture=await gatewayFixture(user1,'diag-ingest');
  const userToken=await login('one@example.test','correct horse battery staple');
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','ended',1,'normal')RETURNING id`,[fixture.gatewayId,fixture.simId,user1])).rows[0].id;
  const ts=new Date().toISOString();
  const anonymous=await app.inject({method:'POST',url:'/api/v1/diag/events',payload:[{ts,level:'info',event:'x'}]});
  assert.equal(anonymous.statusCode,401,anonymous.body);
  const noHeader=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:auth(userToken),payload:[{ts,level:'info',event:'x'}]});
  assert.equal(noHeader.statusCode,400,noHeader.body);assert.equal(noHeader.json().error.code,'INVALID_REQUEST');
  const badHeader=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...auth(userToken),'x-diag-source':'gateway'},payload:[{ts,level:'info',event:'x'}]});
  assert.equal(badHeader.statusCode,400,badHeader.body);
  const accepted=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...auth(userToken),'x-diag-source':'ios','x-diag-sent-at':String(Date.now()-1000)},payload:[
    {ts,level:'info',event:'dial.tap',callId:call,fields:{ms:12,seq:1}},
    {ts,level:'nope',event:'dropped'},{ts,level:'info'},{ts,level:'info',event:'big',fields:{blob:'x'.repeat(5000)}},'not-an-object',
  ]});
  assert.equal(accepted.statusCode,200,accepted.body);assert.deepEqual(accepted.json(),{accepted:1,dropped:0});
  const stored=(await db.query(`SELECT source,device,user_id,call_id,level,event,fields,clock_offset_ms FROM diag_events WHERE event='dial.tap'`)).rows[0];
  // S75: receive time − X-Diag-Sent-At; the device clock here runs 1 s behind.
  assert.ok(stored.clock_offset_ms>=1000&&stored.clock_offset_ms<5000,String(stored.clock_offset_ms));
  const listed=await app.inject({method:'GET',url:`/api/v1/diag/events?callId=${call}`,headers:auth(userToken)});
  assert.equal(JSON.parse(listed.body.trim().split('\n')[0]).clock_offset_ms,stored.clock_offset_ms);
  assert.equal(stored.source,'ios');assert.equal(stored.user_id,user1);assert.equal(stored.call_id,call);assert.equal(stored.level,'info');
  assert.deepEqual(stored.fields,{ms:12,seq:1});assert.ok(stored.device);
  const fromGateway=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...auth(fixture.deviceToken),'x-diag-sent-at':String(Date.now()-2*86_400_000)},payload:[{ts,level:'warn',event:'heartbeat.gap',fields:{ms:9000}}]});
  assert.equal(fromGateway.statusCode,200,fromGateway.body);assert.deepEqual(fromGateway.json(),{accepted:1,dropped:0});
  const gatewayRow=(await db.query(`SELECT source,device,user_id,clock_offset_ms FROM diag_events WHERE event='heartbeat.gap'`)).rows[0];
  assert.equal(gatewayRow.clock_offset_ms,null,'an offset beyond one day is not trusted');
  assert.equal(gatewayRow.source,'gateway');assert.equal(gatewayRow.device,fixture.gatewayId);assert.equal(gatewayRow.user_id,null);
});

test('S54: a macos login is a native session and may post and filter macos diag events',async()=>{
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'macos',deviceName:'Mac mini'}});
  assert.equal(r.statusCode,200,r.body);
  const body=r.json();assert.equal(typeof body.token,'string');assert.equal(typeof body.refreshToken,'string');assert.equal(r.headers['set-cookie'],undefined);
  const session=(await db.query(`SELECT client_type,platform,access_expires_at-now() access_ttl,refresh_expires_at-now() refresh_ttl FROM sessions WHERE platform='macos' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.equal(session.client_type,'native');assert.equal(session.platform,'macos');
  assert.ok(session.access_ttl.minutes<=15&&!session.access_ttl.hours,JSON.stringify(session.access_ttl));assert.ok(session.refresh_ttl.days>=29,JSON.stringify(session.refresh_ttl));
  const refreshed=await app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refreshToken:body.refreshToken}});
  assert.equal(refreshed.statusCode,200,refreshed.body);
  const ts=new Date().toISOString();
  const posted=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...auth(refreshed.json().token),'x-diag-source':'macos'},payload:[{ts,level:'info',event:'s54.mac'}]});
  assert.equal(posted.statusCode,200,posted.body);assert.deepEqual(posted.json(),{accepted:1,dropped:0});
  const read=await app.inject({method:'GET',url:'/api/v1/diag/events?source=macos&event=s54.mac',headers:auth(refreshed.json().token)});
  assert.equal(read.statusCode,200,read.body);assert.match(read.body,/"source":"macos"/);
  const push=await app.inject({method:'PUT',url:'/api/v1/push/registrations/00000000-0000-4000-8000-000000000054',headers:auth(refreshed.json().token),payload:{platform:'macos'}});
  assert.equal(push.statusCode,400,push.body);
});

test('S93: a refresh token replaced by rotation stays redeemable until the new access token is used',async()=>{
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'ios',deviceName:'iPhone'}});
  assert.equal(login.statusCode,200,login.body);
  const first=login.json().refreshToken;
  const refresh=(refreshToken:string)=>app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refreshToken}});
  const lost=await refresh(first);assert.equal(lost.statusCode,200,lost.body);
  // The app died before saving `lost`: the old refresh token still works and yields a fresh pair.
  const retried=await refresh(first);assert.equal(retried.statusCode,200,retried.body);
  assert.notEqual(retried.json().token,lost.json().token);
  assert.equal((await refresh(lost.json().refreshToken)).statusCode,401,'the undelivered pair is superseded');
  const me=await app.inject({method:'GET',url:'/api/v1/auth/me',headers:auth(retried.json().token)});
  assert.equal(me.statusCode,200,me.body);
  assert.equal((await refresh(first)).statusCode,401,'grace ends once the new access token is used');
  // A normal rotation keeps the same grace for the token it replaced.
  const next=await refresh(retried.json().refreshToken);assert.equal(next.statusCode,200,next.body);
  assert.equal((await refresh(retried.json().refreshToken)).statusCode,200);
});

test('S36 C3: diag read is ndjson ordered by ts and scoped to the caller unless admin',async()=>{
  await db.query(`DELETE FROM diag_events`);
  const older=new Date(Date.now()-60_000).toISOString(),middle=new Date(Date.now()-30_000).toISOString(),newer=new Date().toISOString();
  await db.query(`INSERT INTO diag_events(ts,source,device,user_id,level,event,fields)VALUES
    ($1,'web','session-a',$4,'info','second','{}'),($2,'ios','session-b',$4,'info','first','{}'),($3,'android','session-c',$5,'error','other','{}')`,
    [newer,older,middle,user1,user2]);
  const mine=await app.inject({method:'GET',url:'/api/v1/diag/events',headers:auth(token1)});
  assert.equal(mine.statusCode,200,mine.body);assert.ok(String(mine.headers['content-type']).startsWith('application/x-ndjson'),String(mine.headers['content-type']));
  // S36b D3: neighbouring tests leave fire-and-forget `http.request` rows that can land after this
  // test's DELETE, so the seeded events are asserted with those filtered out, not the whole table.
  const seeded=(body:string)=>body.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(line=>line.event!=='http.request');
  assert.deepEqual(seeded(mine.body).map(line=>line.event),['first','second'],'ascending by ts and only this user');
  const filtered=await app.inject({method:'GET',url:`/api/v1/diag/events?source=ios&since=${encodeURIComponent(older)}`,headers:auth(token1)});
  assert.deepEqual(seeded(filtered.body).map(line=>line.event),['first']);
  const admins=await app.inject({method:'GET',url:'/api/v1/diag/events',headers:auth(adminToken)});
  assert.deepEqual(seeded(admins.body).map(line=>line.event),['first','other','second'],'admin sees every user, still ts ascending');
  const bounded=await app.inject({method:'GET',url:'/api/v1/diag/events?limit=9999',headers:auth(token1)});
  assert.equal(bounded.statusCode,400,bounded.body);
});

// S36b D3: the `http.request` insert is fire-and-forget, so every assertion on one polls.
async function untilRows(sql:string,params:unknown[],what:string){
  for(let attempt=0;attempt<40;attempt++){
    const rows=(await db.query(sql,params)).rows;
    if(rows.length)return rows;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('S69: http.request logs failures, slow calls and user writes; user GETs roll up; a healthy gateway poll costs nothing',async()=>{
  await db.query(`DELETE FROM diag_events`);
  const fixture=await gatewayFixture(user1,'http-request-hook');
  const ok=await app.inject({method:'GET',url:'/api/v1/auth/me',headers:auth(token1)});assert.equal(ok.statusCode,200,ok.body);
  const denied=await app.inject({method:'GET',url:'/api/v1/diag/events'});assert.equal(denied.statusCode,401,denied.body);
  const failed=(await untilRows(`SELECT level,fields,app_version FROM diag_events WHERE event='http.request' AND (fields->>'status')::int=401`,[],'the 401 row'))[0];
  assert.equal(failed.level,'info','a GET 401 is an expired session polling');assert.equal(failed.fields.code,'UNAUTHENTICATED');assert.equal(failed.fields.source,'anon');
  assert.equal(failed.app_version,CONTROL_VERSION);assert.match(CONTROL_VERSION,/^[0-9a-f]{8}$/);
  assert.equal((await db.query(`SELECT 1 FROM diag_events WHERE event='http.request' AND fields->>'route'='/api/v1/auth/me'`)).rowCount,0,'a successful user GET is not a row of its own');
  const beat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  assert.equal(beat.statusCode,200,beat.body);
  assert.equal((await db.query(`SELECT 1 FROM diag_events WHERE event='http.request' AND fields->>'route'='/api/v1/gateway/heartbeat'`)).rowCount,0,'a healthy gateway poll costs nothing');
  const R=(userRequest:boolean,method:string,route:string,status:number,ms:number)=>shouldLogRequest({userRequest,method,route,status,ms});
  assert.equal(R(true,'GET','/api/v1/calls',200,40),'rollup');
  assert.equal(R(true,'GET','/api/v1/calls',200,1500),'row','a slow user GET is still a row');
  assert.equal(R(true,'GET','/api/v1/calls',500,40),'row');
  assert.equal(R(true,'POST','/api/v1/calls/outbound',202,40),'row','a user write is a row');
  assert.equal(R(true,'POST','/api/v1/diag/events',200,20),null,'the ingest never logs its own upload');
  assert.equal(R(false,'POST','/api/v1/gateway/ack',200,1500),'row','slow is always logged');
  assert.equal(R(false,'POST','/api/v1/gateway/heartbeat',200,1500),null,'a heartbeat under 2 s is normal');
  assert.equal(R(false,'POST','/api/v1/gateway/heartbeat',200,2500),'row');
  assert.equal(R(false,'GET','/api/v1/gateway/commands/doorbell',200,8000),null,'a full doorbell hold is the design');
  assert.equal(R(false,'GET','/api/v1/gateway/commands/doorbell',200,9500),'row');
  assert.equal(R(false,'GET','/api/v1/gateway/commands/doorbell',409,5),'row','a failed poll is always logged');
  // S69 levels: codes the design produces on purpose are info; everything else keeps warn/error.
  assert.equal(requestLevel({method:'POST',status:503,code:'MEDIA_QUALITY_UNAVAILABLE'}),'info');
  for(const code of ['MEDIA_NODE_PENDING','CAPTURE_NOT_ACTIVE','CAPTURE_NOT_CONFIRMED','CALL_NOT_TERMINAL'])assert.equal(requestLevel({method:'POST',status:409,code}),'info',code);
  assert.equal(requestLevel({method:'GET',status:401,code:'UNAUTHENTICATED'}),'info');
  assert.equal(requestLevel({method:'POST',status:401,code:'UNAUTHENTICATED'}),'warn','a failed write is still a warning');
  assert.equal(requestLevel({method:'POST',status:409,code:'EVENT_ID_REUSED'}),'warn');
  assert.equal(requestLevel({method:'GET',status:503,code:'GATEWAY_OFFLINE'}),'error');
  // An unmatched path has no route template, so nothing of the raw url (or its query) is stored.
  const missing=await app.inject({method:'GET',url:'/nope?secret=1'});assert.equal(missing.statusCode,404,missing.body);
  const notFound=(await untilRows(`SELECT fields FROM diag_events WHERE event='http.request' AND (fields->>'status')::int=404`,[],'the 404 row'))[0];
  assert.equal(notFound.fields.route,null,JSON.stringify(notFound.fields));
});

test('S69: successful user GETs become one http.rollup row per install and route, flushed on close',async()=>{
  await db.query(`DELETE FROM diag_events WHERE event='http.rollup'`);
  const local=await buildApp(db,config);
  try{
    for(let i=0;i<3;i++){const r=await local.inject({method:'GET',url:'/api/v1/auth/me',headers:{...auth(token1),'x-diag-source':'macos','x-diag-install':'install-rollup'}});assert.equal(r.statusCode,200,r.body);}
    const other=await local.inject({method:'GET',url:'/api/v1/auth/me',headers:auth(token1)});assert.equal(other.statusCode,200,other.body);
  }finally{await local.close();}
  const rows=(await db.query(`SELECT install_id,user_id,level,fields,app_version FROM diag_events WHERE event='http.rollup' ORDER BY install_id NULLS LAST`)).rows;
  assert.equal(rows.length,2,JSON.stringify(rows));
  const [mac,plain]=rows;
  assert.equal(mac.install_id,'install-rollup');assert.equal(mac.user_id,user1);assert.equal(mac.level,'info');assert.equal(mac.app_version,CONTROL_VERSION);
  assert.equal(mac.fields.route,'/api/v1/auth/me');assert.equal(mac.fields.method,'GET');assert.equal(mac.fields.platform,'macos');
  assert.equal(mac.fields.count,3);assert.deepEqual(mac.fields.statuses,{200:3});
  assert.ok(mac.fields.p50Ms<=mac.fields.p95Ms&&mac.fields.p95Ms<=mac.fields.maxMs,JSON.stringify(mac.fields));
  assert.equal(plain.install_id,null);assert.equal(plain.fields.count,1);assert.ok(plain.fields.sessionId);
});

test('S36b D3: a refusal because the gateway is offline records the gateway and how stale it was',async()=>{
  await db.query(`DELETE FROM diag_events`);
  const fixture=await gatewayFixture(user1,'offline-seen');
  await db.query(`UPDATE gateways SET last_seen_at=now()-interval '10 minutes' WHERE id=$1`,[fixture.gatewayId]);
  const refused=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'offline-seen-outbound'},payload:{simId:fixture.simId,remoteNumber:'+15557101'}});
  assert.equal(refused.statusCode,503,refused.body);assert.equal(refused.json().error.code,'GATEWAY_OFFLINE');
  const seen=(await untilRows(`SELECT level,user_id,fields FROM diag_events WHERE event='gateway.offline_seen'`,[],'the offline refusal'))[0];
  assert.equal(seen.level,'warn');assert.equal(seen.user_id,user1);assert.equal(seen.fields.gatewayId,fixture.gatewayId);
  assert.ok(seen.fields.lastSeenAgeMs>500_000,JSON.stringify(seen.fields));assert.equal(seen.fields.controlEnabled,true);
});

test('S36b D3: the install header is stored and the admin summary groups by source and device',async()=>{
  await db.query(`DELETE FROM diag_events`);
  const ts=new Date().toISOString();
  const posted=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...auth(token1),'x-diag-source':'android','x-diag-install':'install-7f3a'},
    payload:[{ts,level:'error',event:'app.crash',fields:{where:'CallScreen'}}]});
  assert.equal(posted.statusCode,200,posted.body);assert.deepEqual(posted.json(),{accepted:1,dropped:0});
  const stored=(await db.query(`SELECT install_id,source,device,level FROM diag_events WHERE event='app.crash'`)).rows[0];
  assert.equal(stored.install_id,'install-7f3a');assert.equal(stored.source,'android');assert.equal(stored.level,'error');
  const byInstall=await app.inject({method:'GET',url:'/api/v1/diag/events?installId=install-7f3a&level=error',headers:auth(token1)});
  assert.deepEqual(byInstall.body.trim().split('\n').map(line=>JSON.parse(line).event),['app.crash']);
  const other=await app.inject({method:'GET',url:'/api/v1/diag/events?installId=install-nope',headers:auth(token1)});
  assert.equal(other.body.trim(),'','an unknown install matches nothing');
  const forbidden=await app.inject({method:'GET',url:'/api/v1/diag/summary',headers:auth(token1)});
  assert.equal(forbidden.statusCode,403,forbidden.body);assert.equal(forbidden.json().error.code,'FORBIDDEN');
  const summary=await app.inject({method:'GET',url:'/api/v1/diag/summary',headers:auth(adminToken)});
  assert.equal(summary.statusCode,200,summary.body);
  const android=summary.json().devices.find((row:any)=>row.source==='android'&&row.install_id==='install-7f3a');
  assert.ok(android,summary.body);assert.equal(android.device,stored.device);assert.ok(android.events>=1);assert.ok(android.errors>=1);assert.ok(android.last_seen);
  const windowed=await app.inject({method:'GET',url:`/api/v1/diag/summary?since=${encodeURIComponent(new Date(Date.now()+3_600_000).toISOString())}`,headers:auth(adminToken)});
  assert.deepEqual(windowed.json().devices,[],'the window is honoured');
});

test('S69: diag ingest stores each event appVersion and throttles an install past 600 a minute',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now); // Keep the burst assertion independent of database latency.
  await db.query(`DELETE FROM diag_events`);
  const ts=new Date().toISOString();
  const headers={...auth(token1),'x-diag-source':'ios','x-diag-install':'install-s69-throttle'};
  const first=await app.inject({method:'POST',url:'/api/v1/diag/events',headers,payload:[{ts,level:'info',event:'s69.versioned',appVersion:'1.0(51)'},{ts,level:'info',event:'s69.unversioned'}]});
  assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json(),{accepted:2,dropped:0});
  const versions=(await db.query(`SELECT event,app_version FROM diag_events WHERE event LIKE 's69.%' ORDER BY event`)).rows;
  assert.deepEqual(versions,[{event:'s69.unversioned',app_version:null},{event:'s69.versioned',app_version:'1.0(51)'}]);
  const batch=Array.from({length:200},()=>({ts,level:'debug',event:'s69.flood'}));
  let accepted=0,dropped=0;
  for(let i=0;i<14;i++){const r=await app.inject({method:'POST',url:'/api/v1/diag/events',headers,payload:batch});assert.equal(r.statusCode,200,r.body);accepted+=r.json().accepted;dropped+=r.json().dropped;}
  assert.equal(accepted,2498,'2500 burst (a full spool + ring replay), two already spent');assert.equal(dropped,302);
  assert.equal((await db.query(`SELECT count(*)::int n FROM diag_events WHERE event='s69.flood'`)).rows[0].n,2498);
  const throttledRow=(await untilRows(`SELECT level,fields FROM diag_events WHERE event='diag.throttled'`,[],'the throttle row'));
  assert.equal(throttledRow.length,1,'one row a minute, not one per dropped batch');assert.equal(throttledRow[0].level,'warn');
  assert.equal(throttledRow[0].fields.installId,'install-s69-throttle');assert.ok(throttledRow[0].fields.dropped>0);
  // Another install has its own bucket.
  const other=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...headers,'x-diag-install':'install-s69-other'},payload:[{ts,level:'info',event:'s69.other'}]});
  assert.deepEqual(other.json(),{accepted:1,dropped:0});
});

test('S69: the heartbeat gap threshold is max(3 x median of recent intervals, 15 s)',()=>{
  assert.equal(heartbeatGapThresholdMs([]),15_000,'no history: the floor');
  assert.equal(heartbeatGapThresholdMs(Array(20).fill(2000)),15_000,'a 2 s beat stays at the floor');
  assert.equal(heartbeatGapThresholdMs([...Array(15).fill(10_000),...Array(5).fill(600_000)]),30_000,'a few long gaps do not move the median');
  assert.equal(heartbeatGapThresholdMs(Array(20).fill(30_000)),90_000,'a slow 4G gateway gets a proportional threshold');
});

test('S36b D3: a heartbeat records capability flips, missed beats and a piggybacked device status',async()=>{
  await db.query(`DELETE FROM diag_events`);
  const fixture=await gatewayFixture(user1,'heartbeat-diag');
  const ready={controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}};
  assert.equal((await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:ready})).statusCode,200);
  assert.equal((await db.query(`SELECT 1 FROM diag_events WHERE event='gateway.state'`)).rowCount,0,'a steady beat writes nothing');
  await db.query(`UPDATE gateways SET last_seen_at=now()-interval '5 minutes' WHERE id=$1`,[fixture.gatewayId]);
  const lost=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{...ready,capabilities:{...ready.capabilities,telephonyReady:false},deviceStatus:{battery:{level:41,charging:false},doze:true,network:{transport:'cellular'}}}});
  assert.equal(lost.statusCode,200,lost.body);
  const flip=(await untilRows(`SELECT level,fields FROM diag_events WHERE event='gateway.state'`,[],'the capability flip'))[0];
  assert.equal(flip.level,'warn');assert.equal(flip.fields.gatewayId,fixture.gatewayId);
  assert.deepEqual(flip.fields.telephonyReady,{was:true,now:false});assert.equal(flip.fields.mediaReady,undefined,'only what actually flipped');
  const gap=(await untilRows(`SELECT fields FROM diag_events WHERE event='gateway.heartbeat_gap'`,[],'the missed beats'))[0];
  assert.ok(gap.fields.gapMs>gap.fields.thresholdMs&&gap.fields.thresholdMs>=15_000,JSON.stringify(gap.fields));assert.equal(gap.fields.gatewayId,fixture.gatewayId);
  const status=(await untilRows(`SELECT source,device,fields FROM diag_events WHERE event='device.status'`,[],'the piggybacked snapshot'))[0];
  assert.equal(status.source,'gateway');assert.equal(status.device,fixture.gatewayId);assert.equal(status.fields.doze,true);
  const junk=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{...ready,deviceStatus:'not-an-object',somethingNew:1}});
  assert.equal(junk.statusCode,200,junk.body);
  assert.equal((await db.query(`SELECT count(*)::int n FROM diag_events WHERE event='device.status'`)).rows[0].n,1,'a junk snapshot is dropped, never a 400');
});

test('S36 C2: DTMF queues one 20 s command for the owner of a connected call only',async()=>{
  const fixture=await gatewayFixture(user1,'dtmf-in-call');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},payload:{simId:fixture.simId,remoteNumber:'+15556036'}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string,deviceCallId=crypto.randomUUID();
  // The deploy gate answers before anything else: an old gateway must never see a dtmf command.
  const gated=await buildApp(db,{...config,CALL_DTMF_ENABLED:false});
  try{
    const off=await gated.inject({method:'POST',url:`/api/v1/calls/${callId}/dtmf`,headers:auth(userToken),payload:{digits:'1'}});
    assert.equal(off.statusCode,501,off.body);assert.equal(off.json().error.code,'DTMF_UNAVAILABLE');
  }finally{await gated.close();}
  const ringing=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/dtmf`,headers:auth(userToken),payload:{digits:'1'}});
  assert.equal(ringing.statusCode,409,ringing.body);assert.equal(ringing.json().error.code,'CALL_NOT_ACTIVE');
  await db.query(`UPDATE call_records SET state='active',answered_at=now(),device_call_id=$2 WHERE id=$1`,[callId,deviceCallId]);
  const bad=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/dtmf`,headers:auth(userToken),payload:{digits:'12a'}});
  assert.equal(bad.statusCode,400,bad.body);assert.equal(bad.json().error.code,'INVALID_REQUEST');
  const sent=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/dtmf`,headers:auth(userToken),payload:{digits:'1*#'}});
  assert.equal(sent.statusCode,200,sent.body);assert.equal(sent.json().ok,true);
  const row=(await db.query(`SELECT kind,sim_id,call_id,generation,sequence,payload,status,expires_at<=now()+interval '20 seconds' bounded FROM commands WHERE id=$1`,[sent.json().commandId])).rows[0];
  assert.equal(row.kind,'dtmf');assert.equal(row.sim_id,fixture.simId);assert.equal(row.call_id,null);assert.equal(row.status,'pending');assert.equal(row.bounded,true);
  assert.deepEqual(row.payload,{callId,deviceCallId,digits:'1*#'});
  assert.equal(Number(row.sequence),Number((await db.query(`SELECT command_sequence FROM gateways WHERE id=$1`,[fixture.gatewayId])).rows[0].command_sequence));
  const stranger=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/dtmf`,headers:auth(token2),payload:{digits:'1'}});
  assert.equal(stranger.statusCode,404,stranger.body);
  const delivered=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  assert.equal(delivered.statusCode,200,delivered.body);
  assert.ok(delivered.json().commands.some((command:{id:string})=>command.id===sent.json().commandId),'the heartbeat delivers dtmf on telephony_ready');
  // An undelivered dtmf must not sit `pending` past its TTL: that row would hold the replay floor down.
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[sent.json().commandId]);
  const swept=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  assert.equal(swept.statusCode,200,swept.body);
  const finalized=(await db.query(`SELECT status,result FROM commands WHERE id=$1`,[sent.json().commandId])).rows[0];
  assert.deepEqual([finalized.status,finalized.result],['expired',{reason:'expired'}]);
  assert.equal(swept.json().commands.some((command:{id:string})=>command.id===sent.json().commandId),false,'an expired dtmf is never redelivered');
});

test('pending hangup survives capability withdrawal but OFF and epoch fences still block delivery',async()=>{
  const fixture=await gatewayFixture(user1,'hangup-after-capability-withdrawal');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({
    method:'POST',url:'/api/v1/calls/outbound',
    headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},
    payload:{simId:fixture.simId,remoteNumber:'+15556031'},
  });
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string;
  const deviceCallId=crypto.randomUUID();
  await db.query(`UPDATE call_records SET state='active',answered_at=now(),device_call_id=$2 WHERE id=$1`,[callId,deviceCallId]);
  await db.query(`UPDATE gateways SET telephony_ready=false WHERE id=$1`,[fixture.gatewayId]);
  const ended=await app.inject({
    method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(userToken),
    payload:{onlyIfCurrentSessionOwner:true},
  });
  assert.equal(ended.statusCode,202,ended.body);
  const hangupId=ended.json().command.id as string;
  const extraSequence=Number(ended.json().command.sequence)+1;
  await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,extraSequence]);
  const answerId=(await db.query(
    `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)
     VALUES($1,$2,$3,$4,'answer',$5,now()+interval '1 minute') RETURNING id`,
    [fixture.gatewayId,callId,fixture.deviceEpoch,extraSequence,JSON.stringify({callId,deviceCallId})],
  )).rows[0].id;

  const withdrawn=await app.inject({
    method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}},
  });
  assert.equal(withdrawn.statusCode,200,withdrawn.body);
  const callCommands=withdrawn.json().commands.filter((command:any)=>command.kind!=='apply_sim_settings');
  assert.deepEqual(callCommands.map((command:any)=>command.id),[hangupId]);
  assert.equal(callCommands[0].generation,fixture.deviceEpoch);
  assert.deepEqual(callCommands[0].payload,{callId,deviceCallId});
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`,[answerId])).rows[0].status,'rejected');
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`,[started.json().command.id])).rows[0].status,'rejected');

  const off=await app.inject({
    method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:false,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}},
  });
  assert.equal(off.statusCode,200,off.body);
  assert.deepEqual(off.json().commands,[]);
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`,[hangupId])).rows[0].status,'pending');

  await db.query(`UPDATE gateways SET device_epoch=device_epoch+1,control_enabled=true,last_seen_at=now() WHERE id=$1`,[fixture.gatewayId]);
  const rotated=await app.inject({
    method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:false}},
  });
  assert.equal(rotated.statusCode,200,rotated.body);
  assert.ok(!rotated.json().commands.some((command:any)=>command.id===hangupId));
});

test('ending while capability is withdrawn never targets an unrelated device call',async()=>{
  const fixture=await gatewayFixture(user1,'hangup-without-device-identity');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':'hangup-without-device-identity-call'},payload:{simId:fixture.simId,remoteNumber:'+15556032'}});assert.equal(started.statusCode,202,started.body);
  await db.query(`UPDATE gateways SET telephony_ready=false WHERE id=$1`,[fixture.gatewayId]);await markDialDelivered(started.json().call.id);
  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${started.json().call.id}/end`,headers:auth(userToken),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(ended.statusCode,202,ended.body);
  assert.deepEqual((await db.query(`SELECT payload FROM commands WHERE id=$1`,[ended.json().command.id])).rows[0].payload,{callId:started.json().call.id,deviceCallId:null});
  const heartbeat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:true}}});assert.equal(heartbeat.statusCode,200,heartbeat.body);
  const hangup=heartbeat.json().commands.find((command:any)=>command.id===ended.json().command.id);assert.ok(hangup);assert.equal(hangup.payload.deviceCallId,null);
});

const withdrawMedia=(deviceToken:string,mediaReady=false)=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(deviceToken),
  payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:false,mediaReady}}});
async function mediaBoundCall(label:string,remoteNumber:string){
  const fixture=await gatewayFixture(user1,label);
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':`${label}-call`},payload:{simId:fixture.simId,remoteNumber}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string;
  await db.query(`UPDATE call_records SET state='active',answered_at=now(),media_node_id='relay-primary' WHERE id=$1`,[callId]);
  return {fixture,callId,commandId:started.json().command.id as string};
}
const callState=async(callId:string)=>(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[callId])).rows[0];
const debounceState=async(gatewayId:string)=>(await db.query(`SELECT media_unready_heartbeats,media_unready_since FROM gateways WHERE id=$1`,[gatewayId])).rows[0];

test('S18 decision 1: a media-bound call survives two withdrawn mediaReady heartbeats and ends on the third while pending dial is rejected at once',async()=>{
  const {fixture,callId,commandId}=await mediaBoundCall('media-debounce-count','+15558001');
  const first=await withdrawMedia(fixture.deviceToken);assert.equal(first.statusCode,200,first.body);
  assert.equal((await db.query(`SELECT status,result FROM commands WHERE id=$1`,[commandId])).rows[0].status,'rejected');
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  const after=await debounceState(fixture.gatewayId);assert.equal(after.media_unready_heartbeats,1);assert.ok(after.media_unready_since);
  const second=await withdrawMedia(fixture.deviceToken);assert.equal(second.statusCode,200,second.body);
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  assert.equal((await debounceState(fixture.gatewayId)).media_unready_heartbeats,2);
  const third=await withdrawMedia(fixture.deviceToken);assert.equal(third.statusCode,200,third.body);
  assert.deepEqual(await callState(callId),{state:'unknown',failure_reason:'media_capability_withdrawn'});
});

test('S18 decision 1: a mediaReady heartbeat resets the debounce and a withdrawal older than 15 seconds ends the media-bound call',async()=>{
  const {fixture,callId}=await mediaBoundCall('media-debounce-time','+15558002');
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  assert.equal((await withdrawMedia(fixture.deviceToken,true)).statusCode,200);
  assert.deepEqual(await debounceState(fixture.gatewayId),{media_unready_heartbeats:0,media_unready_since:null});
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  assert.equal((await debounceState(fixture.gatewayId)).media_unready_heartbeats,1);
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  await db.query(`UPDATE gateways SET media_unready_since=now()-interval '20 seconds' WHERE id=$1`,[fixture.gatewayId]);
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  assert.equal((await debounceState(fixture.gatewayId)).media_unready_heartbeats,2);
  assert.deepEqual(await callState(callId),{state:'unknown',failure_reason:'media_capability_withdrawn'});
});

test('S18 decision 1: a call that never pinned a media node is still ended by the first withdrawn heartbeat',async()=>{
  const fixture=await gatewayFixture(user1,'media-debounce-unbound');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'media-debounce-unbound-call'},payload:{simId:fixture.simId,remoteNumber:'+15558003'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string;
  await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[callId]);
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  assert.deepEqual(await callState(callId),{state:'unknown',failure_reason:'media_capability_withdrawn'});
});

test('S72b: a call answered on the gateway device survives withdrawn mediaReady heartbeats and the close worker, not a control shutdown',async()=>{
  const fixture=await gatewayFixture(user1,'media-device-answer');
  const insert=async()=>(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,answered_at,answered_by_platform)
    SELECT $1,$2,$3,'incoming','active',device_epoch,'normal',now(),'device' FROM gateways WHERE id=$1 RETURNING id`,[fixture.gatewayId,fixture.simId,user1])).rows[0].id as string;
  const callId=await insert();
  for(let beat=0;beat<4;beat++)assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  await db.query(`UPDATE gateways SET media_unready_since=now()-interval '20 seconds' WHERE id=$1`,[fixture.gatewayId]);
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  await new MediaCloseWorker(db,{close:async()=>undefined},{concurrency:4,gatewayOfflineSeconds:30}).tickOnce();
  assert.deepEqual(await callState(callId),{state:'active',failure_reason:null});
  const off=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:false,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:false,mediaReady:true}}});
  assert.equal(off.statusCode,200,off.body);
  assert.deepEqual(await callState(callId),{state:'unknown',failure_reason:'media_capability_withdrawn'});
  // diag() is fire-and-forget; let this row land before the S40 test clears diag_events.
  await untilRows(`SELECT 1 FROM diag_events WHERE event='gateway.media_withdrawn' AND call_id=$1`,[callId],'the control-off withdrawal');
});

test('S18 decision 1: a control shutdown still ends a media-bound call immediately',async()=>{
  const {fixture,callId}=await mediaBoundCall('media-debounce-control-off','+15558004');
  const off=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:false,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:false,mediaReady:true}}});
  assert.equal(off.statusCode,200,off.body);
  assert.deepEqual(await callState(callId),{state:'unknown',failure_reason:'media_capability_withdrawn'});
});

test('S40: Control files a diag row for a media withdrawal and for the media/options 503 both legs then get',async()=>{
  await db.query(`DELETE FROM diag_events`);
  const {fixture,callId}=await mediaBoundCall('media-withdraw-diag','+15558009');
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  const first=(await untilRows(`SELECT level,call_id,fields FROM diag_events WHERE event='gateway.media_withdrawn'`,[],'the withdrawal'))[0];
  assert.equal(first.level,'info');assert.equal(first.call_id,null,'nothing was closed yet');
  assert.deepEqual([first.fields.gatewayId,first.fields.rejectedCommands,first.fields.calls,first.fields.mediaReady],[fixture.gatewayId,1,0,false]);
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  assert.equal((await withdrawMedia(fixture.deviceToken)).statusCode,200);
  const closed=(await untilRows(`SELECT level,fields FROM diag_events WHERE event='gateway.media_withdrawn' AND call_id=$1`,[callId],'the closed call'))[0];
  assert.equal(closed.level,'warn');assert.equal(closed.fields.calls,1);assert.equal(closed.fields.unreadyBeats,3);
  assert.equal((await db.query(`SELECT count(*)::int n FROM diag_events WHERE event='gateway.media_withdrawn'`)).rows[0].n,2,'the beat that changed nothing stays quiet');
  const refused=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/media/options`,headers:auth(fixture.deviceToken),payload:{transport:'udp'}});
  assert.equal(refused.statusCode,503,refused.body);assert.equal(refused.json().error.code,'MEDIA_UNAVAILABLE');
  const gatewayLeg=(await untilRows(`SELECT level,call_id,user_id,fields FROM diag_events WHERE event='media.unavailable'`,[],'the gateway refusal'))[0];
  assert.equal(gatewayLeg.level,'warn');assert.equal(gatewayLeg.call_id,callId);assert.equal(gatewayLeg.user_id,null);
  assert.deepEqual([gatewayLeg.fields.role,gatewayLeg.fields.reason],['gateway','gateway_media_not_ready']);
  // The incident was the user leg: its retry must be attributable to the user who saw the failure.
  const retry=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/media/options`,
    headers:auth(await login('one@example.test','correct horse battery staple')),payload:{transport:'udp'}});
  assert.equal(retry.statusCode,503,retry.body);assert.equal(retry.json().error.code,'MEDIA_UNAVAILABLE');
  const userLeg=(await untilRows(`SELECT user_id,fields FROM diag_events WHERE event='media.unavailable' AND fields->>'role'='user'`,[],'the user refusal'))[0];
  assert.equal(userLeg.user_id,user1);assert.equal(userLeg.fields.reason,'gateway_media_not_ready');
});

test('S18 decision 1: the media close worker mirrors the mediaReady debounce and keeps offline teardown immediate',async()=>{
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at,media_unready_since,media_unready_heartbeats)
    VALUES('debounce-worker',true,true,false,now(),now(),1)RETURNING id,device_epoch`)).rows[0];
  const s=(await db.query(`INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'debounce sim')RETURNING id`,[g.id])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[s]);
  const insertCall=async(nodeId:string|null)=>(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,answered_at,media_node_id)
    VALUES($1,$2,$3,'incoming','active',$4,'normal',now(),$5)RETURNING id`,[g.id,s,user1,g.device_epoch,nodeId])).rows[0].id as string;
  const bound=await insertCall('relay-primary'),unbound=await insertCall(null);
  const worker=new MediaCloseWorker(db,{close:async()=>undefined},{concurrency:4,gatewayOfflineSeconds:30});
  await worker.tickOnce();
  assert.deepEqual(await callState(bound),{state:'active',failure_reason:null});
  assert.deepEqual(await callState(unbound),{state:'unknown',failure_reason:'gateway_media_unavailable'});
  await db.query(`UPDATE gateways SET media_unready_heartbeats=3 WHERE id=$1`,[g.id]);
  await worker.tickOnce();
  assert.deepEqual(await callState(bound),{state:'unknown',failure_reason:'gateway_media_unavailable'});
});

test('expired current-epoch call commands are delivered only for journal reconciliation before idle snapshot cleanup',async()=>{
  const fixture=await gatewayFixture(user1,'expired-call-reconciliation');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({
    method:'POST',url:'/api/v1/calls/outbound',
    headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},
    payload:{simId:fixture.simId,remoteNumber:'+15556041'},
  });
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string;
  const dialId=started.json().command.id as string;
  const dialSequence=Number(started.json().command.sequence);
  const hangupSequence=dialSequence+1;
  await db.query(`UPDATE call_records SET state='unknown',failure_reason='call_not_found' WHERE id=$1`,[callId]);
  await db.query(`UPDATE commands SET expires_at=now()-interval '10 seconds' WHERE id=$1`,[dialId]);
  await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,hangupSequence]);
  await db.query(
    `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)
     VALUES($1,$2,$3,$4,'hangup',$5,now()-interval '5 seconds','rejected','{"reason":"call_not_found","phase":"not_executed"}')`,
    [fixture.gatewayId,callId,fixture.deviceEpoch,hangupSequence,JSON.stringify({callId,deviceCallId:null})],
  );
  const sms=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},payload:{simId:fixture.simId,remoteNumber:'+15556042',body:'expired sms must not replay'}});
  assert.equal(sms.statusCode,202,sms.body);
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[sms.json().command.id]);

  const legacyHeartbeat=await app.inject({
    method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:true,reportedSequence:hangupSequence,capabilities:{telephonyReady:false,smsReady:false,mediaReady:true}},
  });
  assert.equal(legacyHeartbeat.statusCode,200,legacyHeartbeat.body);
  assert.ok(!legacyHeartbeat.json().commands.some((command:any)=>command.id===dialId));
  const heartbeat=await app.inject({
    method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:true,reportedSequence:hangupSequence,capabilities:{telephonyReady:false,smsReady:false,mediaReady:true,commandReconciliationReady:true}},
  });
  assert.equal(heartbeat.statusCode,200,heartbeat.body);
  const delivered=heartbeat.json().commands.filter((command:any)=>command.kind!=='apply_sim_settings');
  assert.deepEqual(delivered.map((command:any)=>command.id),[dialId]);
  assert.equal(delivered[0].reconciliationOnly,true);
  assert.ok(!heartbeat.json().commands.some((command:any)=>command.id===sms.json().command.id));

  const ack=await app.inject({
    method:'POST',url:`/api/v1/gateway/commands/${dialId}/ack`,headers:auth(fixture.deviceToken),
    payload:{generation:fixture.deviceEpoch,status:'rejected',result:{phase:'not_executed',reason:'command_expired'}},
  });
  assert.equal(ack.statusCode,200,ack.body);assert.equal(ack.json().command.late,true);
  assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[callId])).rows[0].state,'unknown');
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);

  const observedAt=new Date().toISOString();
  const snapshot=await app.inject({
    method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),
    payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:hangupSequence,localBusy:false,confirmedAbsentCallIds:[],calls:[],observedAt},
  });
  assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().busyState,'idle');
  const state=(await db.query(`SELECT state,failure_reason,ended_at FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.equal(state.state,'failed');assert.equal(state.failure_reason,'device_snapshot_confirmed_never_started');assert.ok(state.ended_at);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,0);
});

test('server-expired call commands accept only exact no-effect device ACKs and let the snapshot watermark advance',async()=>{
  const fixture=await gatewayFixture(user1,'server-expired-device-ack');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},payload:{simId:fixture.simId,remoteNumber:'+15556044'}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string,dialSequence=Number(started.json().command.sequence),lastSequence=dialSequence+2;
  await db.query(`UPDATE call_records SET state='unknown',failure_reason='hangup_terminal_unconfirmed' WHERE id=$1`,[callId]);
  await db.query(`UPDATE commands SET status='rejected',result='{"reason":"media_capability_withdrawn"}',expires_at=now()-interval '12 seconds' WHERE id=$1`,[started.json().command.id]);
  await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,lastSequence]);
  const inserted=await db.query(
    `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result) VALUES
       ($1,$2,$3,$4,'hangup',$6,now()-interval '8 seconds','expired','{"reason":"expired"}'),
       ($1,$2,$3,$5,'hangup',$6,now()-interval '5 seconds','expired','{"reason":"expired"}') RETURNING id,sequence,expires_at`,
    [fixture.gatewayId,callId,fixture.deviceEpoch,dialSequence+1,lastSequence,JSON.stringify({callId,deviceCallId:null})],
  );
  const exactAck={generation:fixture.deviceEpoch,status:'rejected' as const,result:{phase:'not_executed',reason:'command_expired'}};
  const commands=inserted.rows.sort((a,b)=>Number(a.sequence)-Number(b.sequence));
  for(const command of commands.slice(0,1)){
    const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:exactAck});
    assert.equal(ack.statusCode,200,ack.body);assert.equal(ack.json().command.late,true);assert.equal(ack.json().command.replayed,false);
    const stored=(await db.query(`SELECT status,result,expires_at FROM commands WHERE id=$1`,[command.id])).rows[0];
    assert.equal(stored.status,'rejected');assert.equal(stored.result.phase,'not_executed');assert.equal(stored.result.reason,'command_expired');
    assert.deepEqual(stored.result.serverFinalization,{status:'expired',result:{reason:'expired'},expiresAt:new Date(stored.expires_at).toISOString()});
  }
  const heartbeat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:Number(commands[0].sequence),capabilities:{telephonyReady:false,smsReady:false,mediaReady:true,commandReconciliationReady:true}}});
  assert.equal(heartbeat.statusCode,200,heartbeat.body);
  const replayCommand=heartbeat.json().commands.filter((command:any)=>command.kind!=='apply_sim_settings');
  assert.deepEqual(replayCommand.map((command:any)=>command.id),[commands[1].id]);assert.equal(replayCommand[0].reconciliationOnly,true);
  const secondAck=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${commands[1].id}/ack`,headers:auth(fixture.deviceToken),payload:exactAck});
  assert.equal(secondAck.statusCode,200,secondAck.body);assert.equal(secondAck.json().command.replayed,false);
  const replay=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${commands[0].id}/ack`,headers:auth(fixture.deviceToken),payload:exactAck});
  assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().command.replayed,true);
  const {commandReplayFingerprint}=await import('../src/replay-horizon.js');
  const boundCommand=(await db.query('SELECT * FROM commands WHERE id=$1',[commands[0].id])).rows[0];
  const boundRetry=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${commands[0].id}/ack`,headers:auth(fixture.deviceToken),payload:{...exactAck,replayEvidence:{sequence:Number(boundCommand.sequence),fingerprint:commandReplayFingerprint(boundCommand,fixture.gatewayId)}}});
  assert.equal(boundRetry.statusCode,200,boundRetry.body);assert.equal(boundRetry.json().command.replayed,true);
  assert.equal((await db.query('SELECT 1 FROM gateway_command_replay_receipts WHERE command_id=$1',[commands[0].id])).rowCount,1);
  const executedAfterNoEffect=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${commands[0].id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'acked',telecomState:'ACTIVE',result:{phase:'submitted'}}});
  assert.equal(executedAfterNoEffect.statusCode,409,executedAfterNoEffect.body);assert.equal(executedAfterNoEffect.json().error.code,'ACK_CONFLICT');
  assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[callId])).rows[0].state,'unknown');
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);

  const snapshot=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:lastSequence,localBusy:false,confirmedAbsentCallIds:[],calls:[],observedAt:new Date().toISOString()}});
  assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().busyState,'idle');
  const terminal=(await db.query(`SELECT state,failure_reason,ended_at FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.equal(terminal.state,'failed');assert.equal(terminal.failure_reason,'device_snapshot_confirmed_never_started');assert.ok(terminal.ended_at);
  assert.equal((await db.query(`SELECT reported_sequence FROM gateway_telecom_snapshots WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].reported_sequence,lastSequence.toString());
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,0);
});

test('server-expired command ACK exception rejects unknown, executed, incomplete, stale, and non-call evidence',async()=>{
  async function rejectedCase(label:string,payload:Record<string,unknown>,options:{generationOffset?:number;callCommand?:boolean;kind?:string;serverReason?:string;futureExpiry?:boolean;serverExtra?:Record<string,unknown>}={}){
    const fixture=await gatewayFixture(user1,`expired-ack-${label}`);
    const userToken=await login('one@example.test','correct horse battery staple');
    const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},payload:{simId:fixture.simId,remoteNumber:'+15556045'}});assert.equal(started.statusCode,202,started.body);
    const callId=started.json().call.id as string,sequence=Number(started.json().command.sequence)+1;
    await db.query(`UPDATE call_records SET state='unknown',failure_reason='hangup_terminal_unconfirmed' WHERE id=$1`,[callId]);
    await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,sequence]);
    const serverResult={reason:options.serverReason??'expired',...(options.serverExtra??{})};
    const command=(await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES($1,$2,$3,$4,$8,$5,CASE WHEN $6 THEN now()+interval '5 seconds' ELSE now()-interval '5 seconds' END,'expired',$7::jsonb)RETURNING id`,[fixture.gatewayId,options.callCommand===false?null:callId,fixture.deviceEpoch,sequence,JSON.stringify({callId,deviceCallId:null}),options.futureExpiry??false,JSON.stringify(serverResult),options.kind??'hangup'])).rows[0];
    const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch+(options.generationOffset??0),...payload}});
    assert.equal(ack.statusCode,409,`${label}: ${ack.body}`);assert.ok(['ACK_CONFLICT','FENCE_REJECTED'].includes(ack.json().error.code));
    assert.deepEqual((await db.query(`SELECT status,result FROM commands WHERE id=$1`,[command.id])).rows[0],{status:'expired',result:serverResult});
    assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[callId])).rows[0].state,'unknown');
    assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);
  }
  await rejectedCase('executed',{status:'acked',telecomState:'ACTIVE',result:{phase:'submitted'}});
  await rejectedCase('unknown',{status:'rejected',telecomState:'UNKNOWN',result:{phase:'unknown',reason:'execution_unknown'}});
  for(const telecomState of ['ACTIVE','DIALING','UNKNOWN','DISCONNECTED']) await rejectedCase(`telecom-${telecomState.toLowerCase()}`,{status:'rejected',telecomState,result:{phase:'not_executed',reason:'command_expired'}});
  await rejectedCase('missing-phase',{status:'rejected',result:{reason:'command_expired'}});
  await rejectedCase('executed-at',{status:'rejected',result:{phase:'not_executed',reason:'command_expired',executedAt:new Date().toISOString()}});
  await rejectedCase('device-call-id',{status:'rejected',result:{phase:'not_executed',reason:'command_expired',deviceCallId:'physical-call'}});
  await rejectedCase('wrong-device-reason',{status:'rejected',result:{phase:'not_executed',reason:'call_not_found'}});
  await rejectedCase('wrong-server-reason',{status:'rejected',result:{phase:'not_executed',reason:'command_expired'}},{serverReason:'superseded'});
  await rejectedCase('stale-generation',{status:'rejected',result:{phase:'not_executed',reason:'command_expired'}},{generationOffset:1});
  // S29 §2.2 replaced the old `non-call` case: a NULL `call_id` is now retention, not a wrong command,
  // and the kind check is what still keeps SMS and settings commands out of the exception.
  await rejectedCase('non-call-kind',{status:'rejected',result:{phase:'not_executed',reason:'command_expired'}},{kind:'send_sms',callCommand:false});
  await rejectedCase('not-yet-expired',{status:'rejected',result:{phase:'not_executed',reason:'command_expired'}},{futureExpiry:true});
  await rejectedCase('unrecognized-server-audit',{status:'rejected',result:{phase:'not_executed',reason:'command_expired'}},{serverExtra:{deviceResult:'unknown'}});
});

// S29 §2.2: retention deleted the call row, so `commands.call_id` is NULL. The reconciliation ACK is the
// only way this sequence can ever get a receipt; refusing it would pin the replay horizon forever.
test('S29: a server-expired call command still accepts its no-effect ACK after its call row was purged',async()=>{
  const fixture=await gatewayFixture(user1,'s29-purged-call-expired-ack');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},payload:{simId:fixture.simId,remoteNumber:'+15556046'}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string,sequence=Number(started.json().command.sequence)+1;
  await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,sequence]);
  const command=(await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES($1,$2,$3,$4,'hangup',$5,now()-interval '5 seconds','expired','{"reason":"expired"}')RETURNING *`,[fixture.gatewayId,callId,fixture.deviceEpoch,sequence,JSON.stringify({callId,deviceCallId:null})])).rows[0];
  const {commandReplayFingerprint}=await import('../src/replay-horizon.js');
  const fingerprint=commandReplayFingerprint(command,fixture.gatewayId);
  await db.query(`DELETE FROM call_records WHERE id=$1`,[callId]);
  assert.equal((await db.query(`SELECT call_id FROM commands WHERE id=$1`,[command.id])).rows[0].call_id,null);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'rejected',result:{phase:'not_executed',reason:'command_expired'},replayEvidence:{sequence,fingerprint}}});
  assert.equal(ack.statusCode,200,ack.body);assert.equal(ack.json().command.replayed,false);assert.equal(ack.json().command.late,true);
  const stored=(await db.query(`SELECT status,result,expires_at FROM commands WHERE id=$1`,[command.id])).rows[0];
  assert.equal(stored.status,'rejected');assert.equal(stored.result.reason,'command_expired');
  assert.deepEqual(stored.result.serverFinalization,{status:'expired',result:{reason:'expired'},expiresAt:new Date(stored.expires_at).toISOString()});
  assert.equal((await db.query(`SELECT fingerprint FROM gateway_command_replay_receipts WHERE command_id=$1`,[command.id])).rows[0].fingerprint,fingerprint);
  // The fingerprint never depended on `call_id`, so the retry after the purge is still the same identity.
  assert.equal(commandReplayFingerprint((await db.query(`SELECT * FROM commands WHERE id=$1`,[command.id])).rows[0],fixture.gatewayId),fingerprint);
});

test('an expired command journal replay reporting ACTIVE restores the call and retains its hardware lock',async()=>{
  const fixture=await gatewayFixture(user1,'expired-call-submitted-replay');
  const userToken=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({
    method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':crypto.randomUUID()},
    payload:{simId:fixture.simId,remoteNumber:'+15556043'},
  });
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string,dialId=started.json().command.id as string;
  await db.query(`UPDATE call_records SET state='unknown',failure_reason='execution_unknown' WHERE id=$1`,[callId]);
  await db.query(`UPDATE commands SET expires_at=now()-interval '10 seconds' WHERE id=$1`,[dialId]);
  const heartbeat=await app.inject({
    method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),
    payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:false,smsReady:false,mediaReady:true,commandReconciliationReady:true}},
  });
  assert.equal(heartbeat.statusCode,200,heartbeat.body);
  assert.equal(heartbeat.json().commands.find((command:any)=>command.id===dialId)?.reconciliationOnly,true);
  const ack=await app.inject({
    method:'POST',url:`/api/v1/gateway/commands/${dialId}/ack`,headers:auth(fixture.deviceToken),
    payload:{generation:fixture.deviceEpoch,status:'acked',telecomState:'ACTIVE',result:{phase:'submitted',deviceCallId:'durable-device-call'}},
  });
  assert.equal(ack.statusCode,200,ack.body);assert.equal(ack.json().command.late,true);
  const state=(await db.query(`SELECT state,answered_at FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.equal(state.state,'active');assert.ok(state.answered_at);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);
});

test('incoming call snapshots its owner, is replay-safe, isolated, and epoch fenced',async()=>{
  const fixture=await gatewayFixture(user1,'incoming-owner');
  const eventId=crypto.randomUUID();
  const payload={eventId,generation:fixture.deviceEpoch,deviceCallId:'telecom-call-owner-1',simId:fixture.simId,remoteNumber:null,observedAt:new Date().toISOString()};
  const first=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload});assert.equal(first.statusCode,201,first.body);assert.equal(first.json().disposition,'offer_to_owner');assert.equal(first.json().replayed,false);const callId=first.json().call.id;
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().call.id,callId);assert.equal(replay.json().replayed,true);
  const collision=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{...payload,remoteNumber:'+15551234'}});assert.equal(collision.statusCode,409);assert.equal(collision.json().error.code,'EVENT_ID_REUSED');
  const stale=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{...payload,eventId:crypto.randomUUID(),deviceCallId:'stale-call',generation:fixture.deviceEpoch+1}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'FENCE_REJECTED');
  await db.query(`UPDATE sims SET owner_user_id=$2 WHERE id=$1`,[fixture.simId,user2]);
  const owner=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token1)});const other=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token2)});assert.ok(owner.json().items.some((x:any)=>x.id===callId));assert.ok(!other.json().items.some((x:any)=>x.id===callId));
  const count=await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1 AND device_call_id=$2`,[fixture.gatewayId,payload.deviceCallId]);assert.equal(count.rows[0].n,1);
  const incomingDiag=await untilRows(`SELECT fields FROM diag_events WHERE event='call.incoming' AND call_id=$1`,[callId],'the call.incoming row');
  assert.equal(incomingDiag.length,1,'a replay files no second row');
  assert.equal(incomingDiag[0].fields.gatewayId,fixture.gatewayId);assert.equal(incomingDiag[0].fields.blocked,false);assert.equal(incomingDiag[0].fields.disposition,'offer_to_owner');assert.equal(typeof incomingDiag[0].fields.ms,'number');
  assert.ok(!JSON.stringify(incomingDiag[0].fields).includes('+1555'),'never the number');
});

test('a ringing incoming call wakes the APNs push worker at once instead of on its 1 s poll',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cc-apns-'));const keyPath=join(dir,'key.p8');
  await writeFile(keyPath,generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}));
  const {start,tick}=PushWorker.prototype;let ticks=0;
  PushWorker.prototype.start=function(){};PushWorker.prototype.tick=async function(){ticks++;};
  const pushApp=await buildApp(db,{...config,APNS_KEY_ID:'ABCDEFGHIJ',APNS_TEAM_ID:'ABCDEFGHIJ',APNS_KEY_PATH:keyPath} as never);
  try{
    const fixture=await gatewayFixture(user1,'incoming-push-kick');
    const r=await pushApp.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'push-kick-call',simId:fixture.simId,remoteNumber:null,observedAt:new Date().toISOString()}});
    assert.equal(r.statusCode,201,r.body);assert.equal(r.json().call.state,'incoming_ringing');
    assert.equal(ticks,1,'the route itself ran one push pass (the interval timer is stubbed out)');
  }finally{PushWorker.prototype.start=start;PushWorker.prototype.tick=tick;await pushApp.close();await rm(dir,{recursive:true,force:true});}
});

test('owner blocklist is isolated, idempotent, and enforced on inbound call and SMS',async()=>{
  const fixture=await gatewayFixture(user1,'blocklist-owner');
  const other=await gatewayFixture(user2,'blocklist-other');
  const token=await login('one@example.test','correct horse battery staple');
  const otherToken=await login('two@example.test','correct horse battery staple');
  await db.query(`UPDATE sims SET country_iso='CN' WHERE id=$1`,[fixture.simId]);
  const sourceCall=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,ended_at)VALUES($1,$2,$3,'incoming','18600000001','ended',1,'normal',now()) RETURNING id`,[fixture.gatewayId,fixture.simId,user1])).rows[0];
  const sourceSms=(await db.query(`INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)VALUES($1,$2,$3,'incoming','18600000001','historical thread','delivered',1) RETURNING id`,[fixture.gatewayId,fixture.simId,user1])).rows[0];
  const foreignCall=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,ended_at)VALUES($1,$2,$3,'incoming','+15558888','ended',1,'normal',now()) RETURNING id`,[other.gatewayId,other.simId,user2])).rows[0];
  const anonymous=await app.inject({method:'GET',url:'/api/v1/blocklist'});assert.equal(anonymous.statusCode,401);
  const empty=await app.inject({method:'GET',url:'/api/v1/blocklist',headers:auth(token)});assert.deepEqual(empty.json(),{items:[]});
  const emergency=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'112'}});assert.equal(emergency.statusCode,400);assert.equal(emergency.json().error.code,'INVALID_REQUEST');
  const stolenSource=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'18600000001',sourceCallId:foreignCall.id}});assert.equal(stolenSource.statusCode,404);
  const created=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'18600000001',sourceCallId:sourceCall.id}});assert.equal(created.statusCode,201,created.body);
  assert.equal(created.json().item.remoteNumber,'18600000001');
  assert.equal(created.json().item.sourceCallId,sourceCall.id);
  const again=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'18600000001'}});assert.equal(again.statusCode,200,again.body);assert.equal(again.json().item.id,created.json().item.id);
  const otherAdd=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(otherToken),payload:{remoteNumber:'18600000001'}});assert.equal(otherAdd.statusCode,201,otherAdd.body);assert.notEqual(otherAdd.json().item.id,created.json().item.id);
  const listed=await app.inject({method:'GET',url:'/api/v1/blocklist',headers:auth(token)});assert.equal(listed.json().items.length,1);assert.equal(listed.json().items[0].canonical_key,undefined);
  // S21 §F supersedes the S17 hiding: blocking a number keeps its history visible and flags it, so
  // the three clients can render the block icon and offer "unblock" from the row itself.
  const stillListed=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  const flaggedCall=stillListed.json().items.find((item:any)=>item.id===sourceCall.id);
  assert.ok(flaggedCall,'a blocked number no longer hides its past calls');
  assert.equal(flaggedCall.blocked,true);
  assert.equal(flaggedCall.blockedEntryId,created.json().item.id);
  const flaggedDetail=await app.inject({method:'GET',url:`/api/v1/calls/${sourceCall.id}`,headers:auth(token)});
  assert.equal(flaggedDetail.statusCode,200,flaggedDetail.body);
  assert.equal(flaggedDetail.json().call.blocked,true);
  const flaggedSms=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)});
  const flaggedThread=flaggedSms.json().items.find((item:any)=>item.id===sourceSms.id);
  assert.ok(flaggedThread,'and keeps the existing SMS thread visible');
  // S66: a call-list entry does not flag the SMS thread.
  assert.equal(flaggedThread.blocked,false);
  assert.equal(flaggedThread.blockedEntryId,null);
  const otherSeesOwn=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(otherToken)});assert.ok(otherSeesOwn.json().items.some((item:any)=>item.id===foreignCall.id));

  const incoming=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'blocked-device-call',simId:fixture.simId,remoteNumber:'+8618600000001',observedAt:new Date().toISOString()}});
  assert.equal(incoming.statusCode,202,incoming.body);assert.equal(incoming.json().disposition,'dropped_blocked');assert.equal(incoming.json().call,undefined);
  const blockedCall=(await db.query(`SELECT state,failure_reason FROM call_records WHERE gateway_id=$1 AND device_call_id='blocked-device-call'`,[fixture.gatewayId])).rows[0];
  assert.deepEqual(blockedCall,{state:'failed',failure_reason:'number_blocked'});
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE gateway_id=$1`,[fixture.gatewayId])).rowCount,0);
  assert.equal((await db.query(`SELECT 1 FROM ai_call_runs WHERE gateway_id=$1`,[fixture.gatewayId])).rowCount,0);
  const hangup=(await db.query(`SELECT kind,payload FROM commands WHERE gateway_id=$1 AND kind='hangup'`,[fixture.gatewayId])).rows[0];
  assert.equal(hangup.kind,'hangup');
  assert.equal(hangup.payload.deviceCallId,'blocked-device-call');
  const kinds=(await db.query(`SELECT DISTINCT kind FROM commands WHERE gateway_id=$1`,[fixture.gatewayId])).rows.map((row:{kind:string})=>row.kind).sort();
  assert.deepEqual(kinds,['hangup']);
  const listedAfter=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});assert.ok(!listedAfter.json().items.some((item:any)=>item.failureReason==='number_blocked'));

  // S66: the call list never intercepts SMS; only the SMS list does.
  const callListedSms=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'18600000001',body:'call list only',receivedAt:new Date().toISOString()}});
  assert.equal(callListedSms.statusCode,201,callListedSms.body);assert.equal(callListedSms.json().disposition,'stored_for_owner');
  const smsEntry=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'18600000001',scope:'sms'}});
  assert.equal(smsEntry.statusCode,201,smsEntry.body);assert.equal(smsEntry.json().item.scope,'sms');
  const smsFlagged=(await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)})).json().items.find((item:any)=>item.id===sourceSms.id);
  assert.equal(smsFlagged.blocked,true);assert.equal(smsFlagged.blockedEntryId,smsEntry.json().item.id);
  const sms=await app.inject({method:'POST',url:'/api/v1/gateway/sms/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,simId:fixture.simId,assignmentVersion:fixture.assignmentVersion,remoteNumber:'18600000001',body:'blocked',receivedAt:new Date().toISOString()}});
  assert.equal(sms.statusCode,202,sms.body);assert.equal(sms.json().disposition,'dropped_blocked');
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE gateway_id=$1 AND body='blocked'`,[fixture.gatewayId])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM sms_messages WHERE id=$1`,[sourceSms.id])).rows[0].n,1);

  const roommate=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,1,$2,'roommate',true,$3) RETURNING id`,[fixture.gatewayId,user2,tokenHash('blocklist-roommate-fingerprint')])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[roommate.id]);
  // S55: the roommate's own entry ('18600000001') now matches the +86 spelling without a SIM country.
  const roommateBlocked=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'other-owner-own-block',simId:roommate.id,remoteNumber:'+8618600000001',observedAt:new Date().toISOString()}});
  assert.equal(roommateBlocked.statusCode,202,roommateBlocked.body);assert.equal(roommateBlocked.json().disposition,'dropped_blocked');
  // Without it, the first owner's entry for the same number never reaches the roommate's SIM.
  await db.query(`DELETE FROM owner_blocked_numbers WHERE id=$1`,[otherAdd.json().item.id]);
  const otherIncoming=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'other-owner-same-gateway',simId:roommate.id,remoteNumber:'+8618600000001',observedAt:new Date().toISOString()}});
  assert.equal(otherIncoming.statusCode,201,otherIncoming.body);assert.equal(otherIncoming.json().disposition,'offer_to_owner');

  const heartbeat=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  assert.equal(heartbeat.statusCode,200,heartbeat.body);
  assert.ok(heartbeat.json().numberBlocklist);
  assert.ok(heartbeat.json().numberBlocklist.version>=1);
  const simItem=heartbeat.json().numberBlocklist.items.find((item:any)=>item.simId===fixture.simId);
  assert.ok(simItem.numbers.includes('18600000001'));
  assert.ok(simItem.smsNumbers.includes('18600000001'));
  assert.ok(!heartbeat.json().commands.some((command:any)=>command.kind==='number_blocklist'||command.kind==='apply_blocklist'));
  // S41 decision 5: a gateway that already applied this version gets the version back with no numbers;
  // any other value (and the omitted field above) still gets the full list.
  const knownVersion=heartbeat.json().numberBlocklist.version;
  const shortCircuit=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true},numberBlocklistVersion:knownVersion}});
  assert.equal(shortCircuit.statusCode,200,shortCircuit.body);
  assert.deepEqual(shortCircuit.json().numberBlocklist,{version:knownVersion,items:[],phoneSync:'off'});
  const stale=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true},numberBlocklistVersion:knownVersion+1}});
  assert.equal(stale.json().numberBlocklist.version,knownVersion);
  assert.ok(stale.json().numberBlocklist.items.find((item:any)=>item.simId===fixture.simId).numbers.includes('18600000001'));

  const crossDelete=await app.inject({method:'DELETE',url:`/api/v1/blocklist/${created.json().item.id}`,headers:auth(otherToken)});assert.equal(crossDelete.statusCode,404);
  assert.equal((await db.query(`SELECT 1 FROM owner_blocked_numbers WHERE id=$1`,[created.json().item.id])).rowCount,1);
  const removed=await app.inject({method:'DELETE',url:`/api/v1/blocklist/${created.json().item.id}`,headers:auth(token)});assert.equal(removed.statusCode,204,removed.body);
  // Unblocking only clears the flag; the rows were visible throughout.
  const visible=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  const unflagged=visible.json().items.find((item:any)=>item.id===sourceCall.id);
  assert.ok(unflagged);assert.equal(unflagged.blocked,false);assert.equal(unflagged.blockedEntryId,null);
  // Removing the call entry leaves the SMS entry (and its flag) in place.
  const stillSmsBlocked=(await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)})).json().items.find((item:any)=>item.id===sourceSms.id);
  assert.equal(stillSmsBlocked.blocked,true);
  assert.equal((await app.inject({method:'DELETE',url:`/api/v1/blocklist/${smsEntry.json().item.id}`,headers:auth(token)})).statusCode,204);
  const visibleSms=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)});
  const unflaggedSms=visibleSms.json().items.find((item:any)=>item.id===sourceSms.id);
  assert.ok(unflaggedSms);assert.equal(unflaggedSms.blocked,false);
  // The interception row stays out of the main history regardless of the blocklist state.
  const history=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  assert.ok(!history.json().items.some((item:any)=>item.failureReason==='number_blocked'));
  const withIntercepted=await app.inject({method:'GET',url:'/api/v1/calls?includeBlocked=true',headers:auth(token)});
  assert.ok(withIntercepted.json().items.some((item:any)=>item.failureReason==='number_blocked'));
});

test('unassigned incoming calls stay local without leaking call or owner data',async()=>{
  const fixture=await gatewayFixture(null,'incoming-unassigned');
  const response=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'local-only-call',simId:fixture.simId,remoteNumber:'+15550000',observedAt:new Date().toISOString()}});assert.equal(response.statusCode,202,response.body);assert.deepEqual(response.json(),{accepted:true,replayed:false,disposition:'local_only'});assert.ok(!response.body.includes('+15550000'));
  const state=await db.query(`SELECT local_busy FROM gateway_telecom_snapshots WHERE gateway_id=$1`,[fixture.gatewayId]);assert.equal(state.rows[0].local_busy,true);
  const calls=await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId]);assert.equal(calls.rows[0].n,0);
});

test('incoming report and outbound reservation serialize on one gateway lock',async()=>{
  const fixture=await gatewayFixture(user1,'incoming-race');
  const [incoming,outbound]=await Promise.all([
    app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'race-device-call',simId:fixture.simId,remoteNumber:'+15552001',observedAt:new Date().toISOString()}}),
    app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'incoming-outbound-race'},payload:{simId:fixture.simId,remoteNumber:'+15552002'}}),
  ]);
  assert.ok([[201,409],[202,202]].some(pair=>pair[0]===incoming.statusCode&&pair[1]===outbound.statusCode),`${incoming.statusCode}/${outbound.statusCode}: ${incoming.body} ${outbound.body}`);
  const rows=await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId]);assert.equal(rows.rows[0].n,1);
  const locks=await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE gateway_id=$1`,[fixture.gatewayId]);assert.equal(locks.rows[0].n,1);
});

test('local Telecom busy blocks calls while SMS remains available',async()=>{
  const fixture=await gatewayFixture(user1,'local-busy');
  const snapshot=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:0,localBusy:true,confirmedAbsentCallIds:[],calls:[],observedAt:new Date(Date.now()+1000).toISOString()}});assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().busyState,'busy');
  const call=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'local-busy-call'},payload:{simId:fixture.simId,remoteNumber:'+15553001'}});assert.equal(call.statusCode,409,call.body);assert.equal(call.json().error.code,'GATEWAY_BUSY');
  const sms=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'local-busy-sms'},payload:{simId:fixture.simId,remoteNumber:'+15553002',body:'still allowed'}});assert.equal(sms.statusCode,202,sms.body);
});

test('S22: a busy snapshot without a listed call does not downgrade the incoming call it precedes',async()=>{
  const fixture=await gatewayFixture(user1,'prebind-busy');
  // Heartbeat snapshot taken between Telecom NEW and the InCallService bind: system busy, nothing journaled yet.
  const snapshot=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:0,localBusy:true,confirmedAbsentCallIds:[],calls:[],observedAt:new Date().toISOString()}});assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().busyState,'busy');
  const incoming=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'prebind-call',simId:fixture.simId,remoteNumber:'+15554001',observedAt:new Date().toISOString()}});assert.equal(incoming.statusCode,201,incoming.body);assert.equal(incoming.json().disposition,'offer_to_owner');
  const rows=await db.query(`SELECT state FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId]);assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].state,'incoming_ringing');
});

test('S22: one unready heartbeat does not refuse the gateway media leg; three do',async()=>{
  const fixture=await gatewayFixture(user1,'media-debounce');
  const incoming=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'debounce-call',simId:fixture.simId,remoteNumber:'+15554003',observedAt:new Date().toISOString()}});assert.equal(incoming.statusCode,201,incoming.body);
  const callId=incoming.json().call.id as string;
  await db.query(`UPDATE call_records SET state='active',answered_at=now(),media_node_id='relay-primary' WHERE id=$1`,[callId]);
  const heartbeat=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:false}}});
  assert.equal((await heartbeat()).statusCode,200);
  const tolerated=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/media/options`,headers:auth(fixture.deviceToken),payload:{transport:'udp'}});
  assert.equal(tolerated.statusCode,200,tolerated.body);assert.equal(tolerated.json().iceTransportPolicy,'relay');
  assert.equal((await heartbeat()).statusCode,200);assert.equal((await heartbeat()).statusCode,200);
  const refused=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/media/options`,headers:auth(fixture.deviceToken),payload:{transport:'udp'}});
  assert.equal(refused.statusCode,503,refused.body);assert.equal(refused.json().error.code,'MEDIA_UNAVAILABLE');
});

test('S22: a snapshot listing a different unmanaged device call still keeps a new incoming call local',async()=>{
  const fixture=await gatewayFixture(user1,'other-call-busy');
  const snapshot=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:0,localBusy:true,confirmedAbsentCallIds:[],calls:[{deviceCallId:'personal-call',simId:fixture.simId,direction:'outgoing',state:'active'}],observedAt:new Date().toISOString()}});assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().busyState,'busy');
  const incoming=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,deviceCallId:'second-call',simId:fixture.simId,remoteNumber:'+15554002',observedAt:new Date().toISOString()}});assert.equal(incoming.statusCode,202,incoming.body);assert.equal(incoming.json().disposition,'local_only');
  const rows=await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId]);assert.equal(rows.rows[0].n,0);
});

test('unknown call lock survives heartbeat and an incomplete snapshot until execution is verified',async()=>{
  const fixture=await gatewayFixture(user1,'unknown-reconcile');
  const dial=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'unknown-initial-call'},payload:{simId:fixture.simId,remoteNumber:'+15554001'}});assert.equal(dial.statusCode,202,dial.body);const sequence=dial.json().command.sequence;
  const down=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:false,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});assert.equal(down.statusCode,200,down.body);const forcedOff=(await db.query(`SELECT telephony_ready,sms_ready,media_ready FROM gateways WHERE id=$1`,[fixture.gatewayId])).rows[0];assert.deepEqual(forcedOff,{telephony_ready:false,sms_ready:false,media_ready:false});
  const up=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});assert.equal(up.statusCode,200,up.body);
  const observedAt=new Date(Date.now()+1000).toISOString();
  const incompletePayload={snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:sequence,localBusy:false,confirmedAbsentCallIds:[],calls:[],observedAt};
  const incomplete=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:incompletePayload});assert.equal(incomplete.statusCode,200,incomplete.body);assert.equal(incomplete.json().busyState,'unknown');
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:incompletePayload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
  const nonMonotonic=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{...incompletePayload,snapshotId:crypto.randomUUID()}});assert.equal(nonMonotonic.statusCode,409);assert.equal(nonMonotonic.json().error.code,'STALE_SNAPSHOT');
  const blocked=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'unknown-still-blocked'},payload:{simId:fixture.simId,remoteNumber:'+15554002'}});assert.equal(blocked.statusCode,409,blocked.body);assert.equal(blocked.json().error.code,'GATEWAY_BUSY');
  const verified=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:2,generation:fixture.deviceEpoch,reportedSequence:sequence,localBusy:false,confirmedAbsentCallIds:[dial.json().call.id],calls:[],observedAt:new Date(Date.now()+2000).toISOString()}});assert.equal(verified.statusCode,200,verified.body);assert.equal(verified.json().busyState,'idle');
  const state=await db.query(`SELECT state FROM call_records WHERE id=$1`,[dial.json().call.id]);assert.equal(state.rows[0].state,'failed');const lock=await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[dial.json().call.id]);assert.equal(lock.rowCount,0);
  const allowed=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'unknown-now-cleared'},payload:{simId:fixture.simId,remoteNumber:'+15554003'}});assert.equal(allowed.statusCode,202,allowed.body);
});

test('fresh idle snapshot converges a never-bound outgoing call after its proven non-executing commands expire',async()=>{
  const fixture=await gatewayFixture(user1,'never-bound-idle');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'never-bound-idle-call'},payload:{simId:fixture.simId,remoteNumber:'+15554004'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id,dialSequence=started.json().command.sequence,firstHangupSequence=dialSequence+1,lastHangupSequence=dialSequence+4;
  await db.query(`UPDATE call_records SET state='unknown',failure_reason='media_capability_withdrawn' WHERE id=$1`,[callId]);
  await db.query(`UPDATE commands SET status='rejected',result='{"reason":"media_capability_withdrawn"}',expires_at=now()-interval '10 seconds' WHERE id=$1`,[started.json().command.id]);
  await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,lastHangupSequence]);
  await db.query(
    `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result) VALUES
       ($1,$2,$3,$4,'hangup',$7,now()-interval '9 seconds','rejected','{"reason":"command_expired","phase":"not_executed"}'),
       ($1,$2,$3,$5,'hangup',$7,now()-interval '7 seconds','rejected','{"reason":"call_not_found","phase":"not_executed"}'),
       ($1,$2,$3,$6,'hangup',$7,now()-interval '5 seconds','rejected','{"reason":"call_not_found","phase":"rejected"}')`,
    [fixture.gatewayId,callId,fixture.deviceEpoch,firstHangupSequence,firstHangupSequence+1,lastHangupSequence,JSON.stringify({callId,deviceCallId:null})],
  );

  const snapshot=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:lastHangupSequence,localBusy:false,confirmedAbsentCallIds:[],calls:[],observedAt:new Date().toISOString()}});
  assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().busyState,'idle');
  const state=(await db.query(`SELECT state,failure_reason,device_call_id FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.deepEqual(state,{state:'failed',failure_reason:'device_snapshot_confirmed_never_started',device_call_id:null});
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,0);
});

test('never-bound reconciliation preserves locks without fresh post-expiry idle and exact command evidence',async()=>{
  async function incident(label:string,options:{localBusy?:boolean;observedAt?:string;reportedSequence?:'dial';futureHangup?:boolean;dialReason?:string;deviceCallId?:string;phase?:unknown;hangupStatus?:'rejected'|'acked';hangupReason?:string;hangupPhase?:unknown;commandGenerationOffset?:number;wrongGateway?:boolean;answered?:boolean}) {
    const fixture=await gatewayFixture(user1,label);
    const token=await login('one@example.test','correct horse battery staple');
    const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':`${label}-call`},payload:{simId:fixture.simId,remoteNumber:'+15554005'}});assert.equal(started.statusCode,202,started.body);
    const callId=started.json().call.id,dialSequence=started.json().command.sequence,hangupSequence=dialSequence+1;
    await db.query(`UPDATE call_records SET state='unknown',failure_reason='media_capability_withdrawn',device_call_id=$2,answered_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1`,[callId,options.deviceCallId??null,options.answered??false]);
    const dialResult:Record<string,unknown>={reason:options.dialReason??'media_capability_withdrawn'};
    if(Object.hasOwn(options,'phase')) dialResult.phase=options.phase;
    await db.query(`UPDATE commands SET status='rejected',result=$2::jsonb,expires_at=now()-interval '10 seconds' WHERE id=$1`,[started.json().command.id,JSON.stringify(dialResult)]);
    await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,hangupSequence]);
    const commandGatewayId=options.wrongGateway?(await db.query(`INSERT INTO gateways(name)VALUES($1)RETURNING id`,[`${label}-wrong-command-gateway`])).rows[0].id:fixture.gatewayId;
    await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES($1,$2,$3,$4,'hangup',$5,CASE WHEN $6 THEN now()+interval '10 seconds' ELSE now()-interval '5 seconds' END,$7,$8::jsonb)`,[commandGatewayId,callId,fixture.deviceEpoch+(options.commandGenerationOffset??0),hangupSequence,JSON.stringify({callId,deviceCallId:null}),options.futureHangup??false,options.hangupStatus??'rejected',JSON.stringify({reason:options.hangupReason??'call_not_found',...(Object.hasOwn(options,'hangupPhase')?{phase:options.hangupPhase}:{})})]);
    const response=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:options.reportedSequence==='dial'?dialSequence:hangupSequence,localBusy:options.localBusy??false,confirmedAbsentCallIds:[],calls:[],observedAt:options.observedAt??new Date().toISOString()}});
    assert.equal(response.statusCode,200,response.body);assert.notEqual(response.json().busyState,'idle');
    assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[callId])).rows[0].state,'unknown');
    assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);
  }
  await incident('never-bound-busy',{localBusy:true});
  await incident('never-bound-stale-observation',{observedAt:new Date(Date.now()-60_000).toISOString()});
  await incident('never-bound-old-watermark',{reportedSequence:'dial'});
  await incident('never-bound-command-in-flight',{futureHangup:true});
  await incident('never-bound-unknown-effect',{dialReason:'execution_unknown'});
  await incident('never-bound-dial-expired-without-phase',{dialReason:'command_expired'});
  await incident('never-bound-dial-expired-submitted',{dialReason:'command_expired',phase:'submitted'});
  await incident('never-bound-already-bound',{deviceCallId:'existing-device-call'});
  await incident('never-bound-invalid-phase',{phase:'retrying'});
  await incident('never-bound-hangup-submitted',{hangupReason:'command_expired',hangupPhase:'submitted'});
  await incident('never-bound-hangup-unknown',{hangupReason:'execution_unknown',hangupPhase:'unknown'});
  await incident('never-bound-hangup-acked',{hangupStatus:'acked',hangupReason:'command_expired',hangupPhase:'not_executed'});
  await incident('never-bound-command-old-epoch',{commandGenerationOffset:1});
  await incident('never-bound-command-wrong-gateway',{wrongGateway:true});
  await incident('never-bound-was-answered',{answered:true});
});

test('device-confirmed absence releases the lock even when the confirming snapshot lags the last command sequence',async()=>{
  const fixture=await gatewayFixture(user1,'absence-behind-watermark');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'absence-behind-watermark-call'},payload:{simId:fixture.simId,remoteNumber:'+15554012'}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id,dialSequence=started.json().command.sequence;
  const deviceCallId='96ec2ec2-90a6-4a49-8723-3407f045ca49';
  await db.query(`UPDATE call_records SET state='unknown',device_call_id=$2,failure_reason='command_expired' WHERE id=$1`,[callId,deviceCallId]);
  // The dial was submitted and two later hangups were rejected, so the call's last sequence is ahead of the sequence
  // the device had reported when it confirmed the call gone. Nothing is pending, so absence is authoritative.
  const hangupA=dialSequence+1,hangupB=dialSequence+2;
  await db.query(`UPDATE commands SET status='acked',result='{"phase":"submitted"}'::jsonb WHERE id=$1`,[started.json().command.id]);
  await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES
    ($1,$2,$3,$4,'hangup',$5,now()-interval '5 seconds','rejected','{"reason":"call_not_found","phase":"not_executed"}'),
    ($1,$2,$3,$6,'hangup',$5,now()-interval '5 seconds','rejected','{"reason":"command_expired","phase":"not_executed"}')`,
    [fixture.gatewayId,callId,fixture.deviceEpoch,hangupA,JSON.stringify({callId,deviceCallId:null}),hangupB]);
  await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,hangupB]);
  const snapshot=await app.inject({
    method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),
    payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:dialSequence,localBusy:false,confirmedAbsentCallIds:[callId],calls:[],observedAt:new Date().toISOString()},
  });
  assert.equal(snapshot.statusCode,200,snapshot.body);
  const row=(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[callId])).rows[0];
  // The recorded failure reason is preserved; what matters is that the stranded call is settled and its lock released.
  assert.equal(row.state,'failed');
  assert.equal(row.failure_reason,'command_expired');
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,0);
});

test('a device lock is reclaimed only after repeated epoch-fenced absence with no command in flight',async()=>{
  async function staleScenario(label:string,options:{priorObservedAt?:string;priorBusy?:boolean;dropPrior?:boolean;lockAge:string;deviceCallId?:string},expectReclaimed:boolean){
    const fixture=await gatewayFixture(user1,label);
    const token=await login('one@example.test','correct horse battery staple');
    const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':`${label}-call`},payload:{simId:fixture.simId,remoteNumber:'+15554011'}});
    assert.equal(started.statusCode,202,started.body);
    const callId=started.json().call.id,dialSequence=started.json().command.sequence;
    // The device answered, then lost its journal binding: no command is in flight and the call never became terminal.
    await db.query(`UPDATE call_records SET state='unknown',answered_at=now(),device_call_id=$2 WHERE id=$1`,[callId,options.deviceCallId??null]);
    await db.query(`DELETE FROM commands WHERE call_id=$1`,[callId]);
    await db.query(`UPDATE gateway_call_locks SET acquired_at=now()-interval '${options.lockAge}' WHERE call_id=$1`,[callId]);
    if(options.dropPrior)await db.query(`DELETE FROM gateway_telecom_snapshots WHERE gateway_id=$1`,[fixture.gatewayId]);
    else await db.query(`UPDATE gateway_telecom_snapshots SET observed_at=$2::timestamptz,calls='[]'::jsonb,local_busy=$3,snapshot_sequence=1 WHERE gateway_id=$1`,[fixture.gatewayId,options.priorObservedAt??new Date(Date.now()-30_000).toISOString(),options.priorBusy??false]);
    const response=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:2,generation:fixture.deviceEpoch,reportedSequence:dialSequence,localBusy:false,confirmedAbsentCallIds:[],calls:[],observedAt:new Date().toISOString()}});
    assert.equal(response.statusCode,200,response.body);
    const row=(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[callId])).rows[0];
    const lock=await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId]);
    if(expectReclaimed){
      assert.equal(response.json().busyState,'idle');
      assert.deepEqual(response.json().releasedCallIds,[callId]);
      // answered_at is set, so reclaim settles ended and does not stamp an internal snapshot reason.
      assert.deepEqual(row,{state:'ended',failure_reason:null});
      assert.equal(lock.rowCount,0);
    }else{
      assert.notEqual(response.json().busyState,'idle');
      assert.deepEqual(response.json().releasedCallIds,[]);
      assert.equal(row.state,'unknown');
      assert.equal(lock.rowCount,1);
    }
  }
  // The gateway snapshots on every heartbeat, so an older accepted absence sample plus an aged lock with no pending
  // command is exactly what a stranded lock looks like in production.
  await staleScenario('stale-lock-reclaimed',{lockAge:'10 minutes'},true);
  // A long gap between two absence samples also proves sustained absence even when sequences are unavailable.
  await staleScenario('stale-lock-long-gap',{priorObservedAt:new Date(Date.now()-10*60_000).toISOString(),lockAge:'10 minutes'},true);
  // Without any earlier absence sample there is nothing to corroborate the lock being stranded.
  await staleScenario('stale-lock-no-prior-sample',{dropPrior:true,lockAge:'10 minutes'},false);
  // An earlier snapshot that reported the device busy blocks the reclaim even with an aged lock.
  await staleScenario('stale-lock-prior-busy',{priorBusy:true,lockAge:'10 minutes'},false);
  // A lock younger than the 30 s never-bound window is never reclaimed by either path.
  await staleScenario('stale-lock-young',{lockAge:'10 seconds'},false);
  // Still bound to a Telecom call, so only the five-minute path applies and an aged lock under it stays.
  await staleScenario('stale-lock-bound-under-five-minutes',{lockAge:'1 minute',deviceCallId:'still-bound'},false);
});

test('never-bound idle reclaim covers every platform and needs repeated same-epoch idle, 30s lock age, and no live pending command',async()=>{
  async function idleReclaim(label:string,options:{lockAge:string;dropPrior?:boolean;platform?:'ios'|'android'|'web';deviceCallId?:string|null;pendingHangup?:boolean;expiredHangup?:boolean;recording?:boolean;reservationBound?:boolean},expectReclaimed:boolean){
    const fixture=await gatewayFixture(user1,label);
    const token=await login('one@example.test','correct horse battery staple');
    const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':`${label}-call`},payload:{simId:fixture.simId,remoteNumber:'+15554021'}});
    assert.equal(started.statusCode,202,started.body);
    const callId=started.json().call.id,dialSequence=started.json().command.sequence;
    await db.query(`UPDATE call_records SET state='unknown',originating_platform=$2,device_call_id=$3,recording_status=CASE WHEN $4 THEN 'complete' ELSE recording_status END WHERE id=$1`,[callId,options.platform??'ios',options.deviceCallId??null,options.recording??false]);
    await db.query(`DELETE FROM commands WHERE call_id=$1`,[callId]);
    await db.query(`UPDATE gateway_call_locks SET acquired_at=now()-interval '${options.lockAge}' WHERE call_id=$1`,[callId]);
    if(options.pendingHangup||options.expiredHangup){
      await db.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[fixture.gatewayId,dialSequence+1]);
      await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status)VALUES($1,$2,$3,$4,'hangup',$5,CASE WHEN $6 THEN now()-interval '5 seconds' ELSE now()+interval '15 seconds' END,'pending')`,[fixture.gatewayId,callId,fixture.deviceEpoch,dialSequence+1,JSON.stringify({callId,deviceCallId:null}),options.expiredHangup??false]);
    }
    if(options.dropPrior)await db.query(`DELETE FROM gateway_telecom_snapshots WHERE gateway_id=$1`,[fixture.gatewayId]);
    else await db.query(`UPDATE gateway_telecom_snapshots SET observed_at=now()-interval '30 seconds',calls='[]'::jsonb,local_busy=false,snapshot_sequence=1 WHERE gateway_id=$1`,[fixture.gatewayId]);
    // The gateway may still adopt a late Telecom call for OUTGOING_BINDING_GRACE_SECONDS after the dial; once it has,
    // the reservation shows up in the snapshot as a live outgoing call carrying the server call ID.
    const snapshotCalls=options.reservationBound
      ?[{callId,deviceCallId:`${label}-telecom`,simId:fixture.simId,direction:'outgoing',state:'dialing'}]
      :[];
    const response=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:2,generation:fixture.deviceEpoch,reportedSequence:dialSequence,localBusy:snapshotCalls.length>0,confirmedAbsentCallIds:[],calls:snapshotCalls,observedAt:new Date().toISOString()}});
    assert.equal(response.statusCode,200,response.body);
    const lock=await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId]);
    if(expectReclaimed){
      assert.equal(response.json().busyState,'idle');
      assert.deepEqual(response.json().releasedCallIds,[callId]);
      assert.equal(lock.rowCount,0);
    }else{
      assert.notEqual(response.json().busyState,'idle');
      assert.deepEqual(response.json().releasedCallIds,[]);
      assert.equal(lock.rowCount,1);
    }
    return callId;
  }
  const reclaimed=await idleReclaim('ios-idle-reclaimed',{lockAge:'45 seconds'},true);
  const reclaimedRow=(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[reclaimed])).rows[0];
  assert.deepEqual(reclaimedRow,{state:'failed',failure_reason:'device_snapshot_stale_lock_reclaimed'});
  const listed=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(await login('one@example.test','correct horse battery staple'))});
  assert.equal(listed.statusCode,200,listed.body);
  assert.equal(listed.json().items.find((item:{id:string})=>item.id===reclaimed)?.failureReason,null);
  await idleReclaim('ios-idle-single-sample',{lockAge:'45 seconds',dropPrior:true},false);
  await idleReclaim('ios-idle-young',{lockAge:'5 seconds'},false);
  // S20 D6: the evidence is platform independent, so Android and web dials release on the same terms as iOS.
  const android=await idleReclaim('android-idle-30s',{lockAge:'45 seconds',platform:'android'},true);
  assert.deepEqual((await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[android])).rows[0],{state:'failed',failure_reason:'device_snapshot_stale_lock_reclaimed'});
  const web=await idleReclaim('web-idle-30s',{lockAge:'45 seconds',platform:'web'},true);
  assert.deepEqual((await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[web])).rows[0],{state:'failed',failure_reason:'device_snapshot_stale_lock_reclaimed'});
  // Counter-case: the gateway is still inside its 180 s dial binding window and the snapshot carries that
  // reservation, so the lock is the device's, not a stranded one, and must survive.
  const reserved=await idleReclaim('android-idle-dial-reservation',{lockAge:'45 seconds',platform:'android',reservationBound:true},false);
  const reservedRow=(await db.query(`SELECT state,device_call_id FROM call_records WHERE id=$1`,[reserved])).rows[0];
  assert.deepEqual(reservedRow,{state:'connecting',device_call_id:'android-idle-dial-reservation-telecom'});
  await idleReclaim('ios-idle-bound',{lockAge:'45 seconds',deviceCallId:'still-bound'},false);
  await idleReclaim('ios-idle-live-hangup',{lockAge:'45 seconds',pendingHangup:true},false);
  const expired=await idleReclaim('ios-idle-expired-hangup',{lockAge:'45 seconds',expiredHangup:true},true);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[expired])).rowCount,0);
  const recorded=await idleReclaim('ios-idle-recording',{lockAge:'45 seconds',recording:true},true);
  assert.deepEqual((await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[recorded])).rows[0],{state:'ended',failure_reason:null});
});

test('confirmed-absent snapshot releases after hangup ACK call_not_found not_executed with null deviceCallId',async()=>{
  const fixture=await gatewayFixture(user1,'hangup-null-absent');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'hangup-null-absent-call'},payload:{simId:fixture.simId,remoteNumber:'+15554022'}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id;
  await db.query(`UPDATE commands SET status='rejected',result='{"reason":"call_not_found","phase":"not_executed"}'::jsonb,expires_at=now()-interval '1 second' WHERE id=$1`,[started.json().command.id]);
  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});
  assert.equal(ended.statusCode,202,ended.body);
  assert.deepEqual((await db.query(`SELECT payload FROM commands WHERE id=$1`,[ended.json().command.id])).rows[0].payload,{callId,deviceCallId:null});
  const blocked=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload:{snapshotId:crypto.randomUUID(),snapshotSequence:1,generation:fixture.deviceEpoch,reportedSequence:ended.json().command.sequence,localBusy:false,confirmedAbsentCallIds:[callId],calls:[],observedAt:new Date().toISOString()}});
  assert.equal(blocked.statusCode,200,blocked.body);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);
  assert.deepEqual(blocked.json().releasedCallIds,[]);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${ended.json().command.id}/ack`,headers:auth(fixture.deviceToken),payload:{generation:fixture.deviceEpoch,status:'rejected',result:{phase:'not_executed',reason:'call_not_found'}}});
  assert.equal(ack.statusCode,200,ack.body);
  const snapshotId=crypto.randomUUID();
  const observedAt=new Date().toISOString();
  const payload={snapshotId,snapshotSequence:2,generation:fixture.deviceEpoch,reportedSequence:ended.json().command.sequence,localBusy:false,confirmedAbsentCallIds:[callId],calls:[],observedAt};
  const released=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload});
  assert.equal(released.statusCode,200,released.body);
  assert.equal(released.json().busyState,'idle');
  assert.deepEqual(released.json().releasedCallIds,[callId]);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,0);
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/telecom/snapshot',headers:auth(fixture.deviceToken),payload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().replayed,true);
  assert.deepEqual(replay.json().releasedCallIds,[callId]);
  const stored=await db.query(`SELECT payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,[fixture.gatewayId,snapshotId]);
  assert.deepEqual(stored.rows[0].payload.response.releasedCallIds,[callId]);
});

test('recording routes enforce snapshot owner and stream exact private byte ranges',async()=>{
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at,recording_status)VALUES($1,$2,$3,'incoming','ended',1,'normal',now(),'ready')RETURNING id`,[gateway,sim1,user1])).rows[0];
  const root=await mkdtemp(join(tmpdir(),'cc-control-recording-'));const dir=join(root,call.id);await mkdir(dir);
  const contents:Record<string,Buffer>={
    'remote_original.ogg':Buffer.from('OggS-remote-audio-bytes'.padEnd(256,'.')),
    'caller_original.ogg':Buffer.from('OggS-caller-audio-bytes'.padEnd(256,'.')),
    'timeline.jsonl':Buffer.from('{\"direction\":\"remote_original\",\"durationMs\":20}\n{\"direction\":\"caller_original\",\"durationMs\":15}\n{\"direction\":\"remote_original\",\"durationMs\":10}\n'),
  };
  const artifacts=[];
  for(const [name,content] of Object.entries(contents)){await writeFile(join(dir,name),content);artifacts.push({name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});}
  const manifest={version:1,callId:call.id,finalizedAt:new Date().toISOString(),complete:true,artifacts};await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  const recordingApp=await buildApp(db,{...config,RECORDING_ROOT:root});
  try{
    const metadata=await recordingApp.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings`,headers:auth(token1)});assert.equal(metadata.statusCode,200,metadata.body);assert.equal(metadata.headers['cache-control'],'private, no-store');assert.equal(metadata.json().recording.callId,call.id);assert.equal(metadata.json().recording.complete,true);
    const byName=Object.fromEntries(metadata.json().recording.artifacts.map((item:any)=>[item.name,item]));
    assert.equal(byName['remote_original.ogg'].durationMs,30);assert.equal(byName['caller_original.ogg'].durationMs,15);assert.equal(byName['timeline.jsonl'].durationMs,undefined);
    const isolated=await recordingApp.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings`,headers:auth(token2)});assert.equal(isolated.statusCode,404);assert.equal(isolated.json().error.code,'NOT_FOUND');
    const full=await recordingApp.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings/remote_original`,headers:auth(token1)});assert.equal(full.statusCode,200,full.body);assert.deepEqual(full.rawPayload,contents['remote_original.ogg']);assert.equal(full.headers['content-type'],'audio/ogg');assert.equal(full.headers['cache-control'],'private, no-store');assert.equal(full.headers['accept-ranges'],'bytes');assert.equal(full.headers.etag,`"${artifacts[0].sha256}"`);
    const range=await recordingApp.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings/caller_original`,headers:{...auth(token1),range:'bytes=5-10'}});assert.equal(range.statusCode,206,range.body);assert.deepEqual(range.rawPayload,contents['caller_original.ogg'].subarray(5,11));assert.equal(range.headers['content-range'],`bytes 5-10/${contents['caller_original.ogg'].length}`);
    const invalid=await recordingApp.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings/caller_original`,headers:{...auth(token1),range:'bytes=999-'}});assert.equal(invalid.statusCode,416,invalid.body);assert.equal(invalid.headers['content-range'],`bytes */${contents['caller_original.ogg'].length}`);assert.equal(invalid.json().error.code,'RANGE_NOT_SATISFIABLE');
    const downloadUrl=`/api/v1/calls/${call.id}/recordings/remote_original?disposition=attachment`;
    const download=await recordingApp.inject({method:'GET',url:downloadUrl,headers:{...auth(token1),range:'bytes=0-0'}});assert.equal(download.statusCode,200,download.body);assert.deepEqual(download.rawPayload,contents['remote_original.ogg']);assert.equal(download.headers['content-disposition'],`attachment; filename="call-${call.id}-media_node-remote_original.ogg"`);assert.equal(download.headers['cache-control'],'private, no-store');assert.equal(download.headers['accept-ranges'],undefined);
    const otherDownload=await recordingApp.inject({method:'GET',url:downloadUrl,headers:auth(token2)});assert.equal(otherDownload.statusCode,404);assert.equal(otherDownload.json().error.code,'NOT_FOUND');
    const anonDownload=await recordingApp.inject({method:'GET',url:downloadUrl});assert.equal(anonDownload.statusCode,401);
    const playout=await recordingApp.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings/caller_playout?disposition=attachment`,headers:auth(token1)});assert.equal(playout.statusCode,404);
    // S36 C4: without a cache directory configured the export stays on its 501.
    const mp3=await recordingApp.inject({method:'GET',url:`${downloadUrl}&format=mp3`,headers:auth(token1)});assert.equal(mp3.statusCode,501,mp3.body);assert.equal(mp3.json().error.code,'RECORDING_TRANSCODE_UNAVAILABLE');
    const mp3Other=await recordingApp.inject({method:'GET',url:`${downloadUrl}&format=mp3`,headers:auth(token2)});assert.equal(mp3Other.statusCode,404);assert.equal(mp3Other.json().error.code,'NOT_FOUND');
    const noRoot=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings`,headers:auth(token1)});assert.equal(noRoot.statusCode,503,noRoot.body);assert.equal(noRoot.json().error.code,'RECORDING_NOT_CONFIGURED');
  }finally{await recordingApp.close();await rm(root,{recursive:true,force:true});}
});

test('S36 C4: mp3 export transcodes once, caches the result and serves it as audio/mpeg',async()=>{
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at,recording_status)VALUES($1,$2,$3,'incoming','ended',1,'normal',now(),'ready')RETURNING id`,[gateway,sim1,user1])).rows[0];
  const root=await mkdtemp(join(tmpdir(),'cc-control-mp3-'));const dir=join(root,call.id);await mkdir(dir);
  const audio=Buffer.from('OggS-remote-audio-bytes'.padEnd(512,'.'));
  const files:Record<string,Buffer>={'remote_original.ogg':audio,'caller_original.ogg':Buffer.from('OggS-caller'.padEnd(64,'.')),'timeline.jsonl':Buffer.from('{"direction":"remote_original","durationMs":20}\n')};
  const artifacts=[];
  for(const [name,content] of Object.entries(files)){await writeFile(join(dir,name),content);artifacts.push({name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});}
  await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,callId:call.id,finalizedAt:new Date().toISOString(),complete:true,artifacts}));
  // A stand-in ffmpeg that copies stdin to stdout and records every invocation, so the test pins
  // "transcoded exactly once" without depending on a real ffmpeg being installed on this machine.
  const binDir=await mkdtemp(join(tmpdir(),'cc-control-ffmpeg-'));const spawns=join(binDir,'spawns');
  // The output path is ffmpeg's last argument (a file, so the Xing/VBR header can be written).
  await writeFile(join(binDir,'ffmpeg'),`#!/bin/sh\necho spawn >> ${spawns}\nfor a; do :; done\nexec /bin/cat > "$a"\n`,{mode:0o755});
  const cacheDir=join(root,'mp3-cache');
  const originalPath=process.env.PATH;
  process.env.PATH=binDir;
  const mp3App=await buildApp(db,{...config,RECORDING_ROOT:root,RECORDING_MP3_CACHE_DIR:cacheDir});
  try{
    const url=`/api/v1/calls/${call.id}/recordings/remote_original?disposition=attachment&format=mp3`;
    const first=await mp3App.inject({method:'GET',url,headers:auth(token1)});
    assert.equal(first.statusCode,200,first.body);
    assert.equal(first.headers['content-type'],'audio/mpeg');
    assert.equal(first.headers['content-disposition'],`attachment; filename="${call.id}-remote_original.mp3"`);
    assert.equal(first.headers['content-length'],String(audio.length));
    assert.equal(first.headers.etag,undefined,'the source ETag never describes transcoded bytes');
    assert.deepEqual(first.rawPayload,audio);
    const second=await mp3App.inject({method:'GET',url,headers:auth(token1)});
    assert.equal(second.statusCode,200,second.body);assert.deepEqual(second.rawPayload,audio);
    assert.equal((await readFile(spawns,'utf8')).trim().split('\n').length,1,'the cached file is served without spawning ffmpeg again');
    assert.equal((await readFile(join(cacheDir,`${call.id}-media_node-remote_original.mp3`))).length,audio.length);
    const stranger=await mp3App.inject({method:'GET',url,headers:auth(token2)});assert.equal(stranger.statusCode,404);
    // No ffmpeg on PATH keeps the documented 501 instead of a truncated download.
    process.env.PATH=join(binDir,'absent');
    const missing=await mp3App.inject({method:'GET',url:`/api/v1/calls/${call.id}/recordings/caller_original?disposition=attachment&format=mp3`,headers:auth(token1)});
    assert.equal(missing.statusCode,501,missing.body);assert.equal(missing.json().error.code,'RECORDING_TRANSCODE_UNAVAILABLE');
  }finally{
    process.env.PATH=originalPath;
    await mp3App.close();await rm(root,{recursive:true,force:true});await rm(binDir,{recursive:true,force:true});
  }
});

test('S36 C4: the conversation export mixes both tracks and delays whichever one started later',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cc-control-conversation-'));const cacheDir=join(root,'mp3-cache');
  // A stand-in ffmpeg that records its arguments and writes the output file named by the last one.
  const binDir=await mkdtemp(join(tmpdir(),'cc-control-mixer-'));const args=join(binDir,'args'),probes=join(binDir,'probes');
  await writeFile(join(binDir,'ffmpeg'),`#!/bin/sh\nprintf '%s\\n' "$*" >> ${args}\nfor last do :; done\nprintf mixed > "$last"\n`,{mode:0o755});
  // A stand-in ffprobe: the spooled tracks are 0.100 s (caller) and 0.300 s (remote).
  await writeFile(join(binDir,'ffprobe'),`#!/bin/sh\nfor last do :; done\nprintf '%s\\n' "$last" >> ${probes}\ncase "$last" in\n*.caller) printf '0.100\\n';;\n*.remote) printf '0.300\\n';;\nesac\n`,{mode:0o755});
  const makeCall=async(timeline:string,caller=Buffer.from('OggS-caller'.padEnd(48,'.')))=>{
    const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at,recording_status)VALUES($1,$2,$3,'incoming','ended',1,'normal',now(),'ready')RETURNING id`,[gateway,sim1,user1])).rows[0];
    const dir=join(root,call.id);await mkdir(dir);
    const files:Record<string,Buffer>={'remote_original.ogg':Buffer.from('OggS-remote'.padEnd(64,'.')),'caller_original.ogg':caller,'timeline.jsonl':Buffer.from(timeline)};
    const artifacts=[];
    for(const [name,content] of Object.entries(files)){await writeFile(join(dir,name),content);artifacts.push({name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});}
    await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,callId:call.id,finalizedAt:new Date().toISOString(),complete:true,artifacts}));
    return call.id as string;
  };
  // The timeline's first packet per direction is the exact skew: remote arrives 240 ms after caller.
  const aligned=await makeCall('{"direction":"caller_original","sequence":1,"receivedElapsedUs":10000,"durationMs":20}\n{"direction":"remote_original","sequence":1,"receivedElapsedUs":250000,"durationMs":20}\n');
  // No receive times: both tracks stop at hangup, so the measured durations align them by the end.
  const endAligned=await makeCall('{"direction":"caller_original","durationMs":100}\n{"direction":"remote_original","durationMs":300}\n');
  const empty=await makeCall('{"direction":"remote_original","durationMs":20}\n',Buffer.alloc(0));
  const originalPath=process.env.PATH;
  process.env.PATH=binDir;
  const mixApp=await buildApp(db,{...config,RECORDING_ROOT:root,RECORDING_MP3_CACHE_DIR:cacheDir});
  const url=(id:string)=>`/api/v1/calls/${id}/recordings/conversation?disposition=attachment&format=mp3`;
  try{
    const first=await mixApp.inject({method:'GET',url:url(aligned),headers:auth(token1)});
    assert.equal(first.statusCode,200,first.body);
    assert.equal(first.headers['content-type'],'audio/mpeg');
    assert.equal(first.headers['content-disposition'],`attachment; filename="${aligned}-conversation.mp3"`);
    assert.equal(first.headers['content-length'],'5');
    assert.equal(first.rawPayload.toString(),'mixed');
    assert.equal((await readFile(join(cacheDir,`${aligned}-media_node-conversation.mp3`),'utf8')),'mixed');
    const cached=await mixApp.inject({method:'GET',url:url(aligned),headers:auth(token1)});
    assert.equal(cached.statusCode,200,cached.body);
    const fallback=await mixApp.inject({method:'GET',url:url(endAligned),headers:auth(token1)});
    assert.equal(fallback.statusCode,200,fallback.body);
    const invocations=(await readFile(args,'utf8')).trim().split('\n');
    assert.equal(invocations.length,2,'the cached mix is served without spawning ffmpeg again');
    // caller is input 0 and remote input 1; the later direction is delayed inside the filter graph.
    assert.match(invocations[0],/-i \S+\.caller -i \S+\.remote -filter_complex \[1:a\]adelay=240:all=1\[d\];\[0:a\]\[d\]amix=inputs=2:duration=longest:normalize=0 /);
    assert.match(invocations[1],/-i \S+\.caller -i \S+\.remote -filter_complex \[0:a\]adelay=200:all=1\[d\];\[d\]\[1:a\]amix=inputs=2:duration=longest:normalize=0 /);
    // Only the call without usable receive times is measured: the timeline stays the first source.
    assert.equal((await readFile(probes,'utf8')).trim().split('\n').length,2);
    const silent=await mixApp.inject({method:'GET',url:url(empty),headers:auth(token1)});
    assert.equal(silent.statusCode,404,silent.body);assert.equal(silent.json().error.code,'NOT_FOUND');
    const stranger=await mixApp.inject({method:'GET',url:url(aligned),headers:auth(token2)});assert.equal(stranger.statusCode,404);
    // The virtual track exists only as an mp3 export.
    const raw=await mixApp.inject({method:'GET',url:`/api/v1/calls/${aligned}/recordings/conversation?disposition=attachment`,headers:auth(token1)});
    assert.equal(raw.statusCode,400,raw.body);assert.equal(raw.json().error.code,'INVALID_RECORDING_PATH');
  }finally{
    process.env.PATH=originalPath;
    await mixApp.close();await rm(root,{recursive:true,force:true});await rm(binDir,{recursive:true,force:true});
  }
});

test('main app transcript and calendar-report routes use real auth and owner snapshots',async()=>{
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,started_at,ended_at,recording_status,gateway_time_zone)VALUES($1,$2,$3,'incoming','+15558001','ended',1,'normal',now()-interval '1 hour',now(),'ready','Asia/Shanghai')RETURNING id`,[gateway,sim1,user1])).rows[0];
  const anonymous=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}/transcript`});assert.equal(anonymous.statusCode,401,anonymous.body);assert.equal(anonymous.json().error.code,'UNAUTHENTICATED');
  const empty=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}/transcript`,headers:auth(token1)});assert.equal(empty.statusCode,200,empty.body);assert.equal(empty.headers['cache-control'],'private, no-store');assert.equal(empty.json().transcript,null);
  const hidden=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}/transcript`,headers:auth(token2)});assert.equal(hidden.statusCode,404,hidden.body);
  const result={includeInReports:true,advertisingClassification:'not_advertising',summary:'客户要求回电',actionItems:['回电']};await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,completed_at)VALUES($1,$2,'{}',$3,'succeeded',$4,now())`,[call.id,user1,'a'.repeat(64),JSON.stringify(result)]);
  const transcript=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}/transcript`,headers:auth(token1)});assert.equal(transcript.statusCode,200,transcript.body);assert.equal(transcript.json().transcript.result.summary,'客户要求回电');
  const report=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=1m&timeZone=Asia%2FTaipei',headers:auth(token1)});assert.equal(report.statusCode,200,report.body);assert.equal(report.headers['cache-control'],'private, no-store');assert.equal(report.json().window.period,'1m');assert.equal(report.json().window.timeZone,'Asia/Taipei');const reportItem=report.json().items.find((item:any)=>item.callId===call.id);assert.ok(reportItem);assert.equal(reportItem.gatewayTimeZone,'Asia/Shanghai');
  const isolated=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=1m&timeZone=Asia%2FTaipei',headers:auth(token2)});assert.equal(isolated.statusCode,200,isolated.body);assert.ok(!isolated.json().items.some((item:any)=>item.callId===call.id));
  const invalid=await app.inject({method:'GET',url:'/api/v1/reports/calls?period=7d&timeZone=Not%2FAZone',headers:auth(token1)});assert.equal(invalid.statusCode,400,invalid.body);assert.equal(invalid.json().error.code,'INVALID_TIME_ZONE');
});

test('passkey challenge is consumed once even when verification fails',async()=>{
  const options=await app.inject({method:'POST',url:'/api/v1/passkeys/register/options',headers:auth(token1)});assert.equal(options.statusCode,200,options.body);const payload={challengeId:options.json().challengeId,response:{id:'bogus',rawId:'bogus',type:'public-key',response:{clientDataJSON:'x',attestationObject:'x'}}};
  const first=await app.inject({method:'POST',url:'/api/v1/passkeys/register/verify',headers:auth(token1),payload});assert.equal(first.statusCode,400);assert.equal(first.json().error.code,'PASSKEY_VERIFICATION_FAILED');
  const replay=await app.inject({method:'POST',url:'/api/v1/passkeys/register/verify',headers:auth(token1),payload});assert.equal(replay.statusCode,400);assert.equal(replay.json().error.code,'CHALLENGE_INVALID');
});

test('passkey list and delete are isolated per user and require mutation origin',async()=>{
  const one=Buffer.from('passkey-owner-one-credential');
  const two=Buffer.from('passkey-owner-two-credential');
  await db.query(`INSERT INTO passkeys(id,user_id,public_key,counter,device_type,backed_up,transports,aaguid,client_platform,authenticator_attachment)
    VALUES($1,$2,$3,7,'singleDevice',false,ARRAY['internal'],'fbfc3007-154e-4ecc-8c0b-6e020557d7bd','Chrome on macOS','platform'),($4,$5,$3,1,'multiDevice',true,NULL,NULL,NULL,NULL)`,[one,user1,Buffer.from('public-key-bytes'),two,user2]);
  const anonymous=await app.inject({method:'GET',url:'/api/v1/passkeys'});assert.equal(anonymous.statusCode,401);
  const listed=await app.inject({method:'GET',url:'/api/v1/passkeys',headers:auth(token1)});assert.equal(listed.statusCode,200,listed.body);
  assert.deepEqual(listed.json().items.map((item:any)=>item.id),[one.toString('base64url')]);
  assert.equal(listed.json().items[0].deviceType,'singleDevice');
  assert.equal(listed.json().items[0].backedUp,false);
  assert.deepEqual(listed.json().items[0].transports,['internal']);
  assert.equal(listed.json().items[0].public_key,undefined);
  assert.equal(listed.json().items[0].counter,undefined);
  assert.equal(listed.json().items[0].aaguid,'fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
  assert.equal(listed.json().items[0].clientPlatform,'Chrome on macOS');
  assert.equal(listed.json().items[0].authenticatorAttachment,'platform');
  assert.equal(listed.json().items[0].label,null);
  assert.equal(listed.json().items[0].lastUsedAt,null);
  assert.equal(listed.json().items[0].displayName,'iCloud 钥匙串');
  assert.ok(listed.json().items[0].createdAt);
  const otherList=await app.inject({method:'GET',url:'/api/v1/passkeys',headers:auth(token2)});assert.deepEqual(otherList.json().items.map((item:any)=>item.id),[two.toString('base64url')]);
  const cross=await app.inject({method:'DELETE',url:`/api/v1/passkeys/${two.toString('base64url')}`,headers:auth(token1)});assert.equal(cross.statusCode,404);assert.equal(cross.json().error.code,'NOT_FOUND');
  assert.equal((await db.query(`SELECT 1 FROM passkeys WHERE id=$1`,[two])).rowCount,1);
  const malformed=await app.inject({method:'DELETE',url:'/api/v1/passkeys/!!!',headers:auth(token1)});assert.equal(malformed.statusCode,400);assert.equal(malformed.json().error.code,'INVALID_REQUEST');
  const web=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'web'},headers:{origin:config.PUBLIC_ORIGIN}});assert.equal(web.statusCode,200,web.body);
  const cookie=String(web.headers['set-cookie']).split(';')[0];
  const csrf=await app.inject({method:'DELETE',url:`/api/v1/passkeys/${one.toString('base64url')}`,headers:{cookie}});assert.equal(csrf.statusCode,403);assert.equal(csrf.json().error.code,'ORIGIN_REJECTED');
  const removed=await app.inject({method:'DELETE',url:`/api/v1/passkeys/${one.toString('base64url')}`,headers:auth(token1)});assert.equal(removed.statusCode,204,removed.body);assert.equal(removed.body,'');
  const empty=await app.inject({method:'GET',url:'/api/v1/passkeys',headers:auth(token1)});assert.deepEqual(empty.json().items,[]);
  const again=await app.inject({method:'DELETE',url:`/api/v1/passkeys/${one.toString('base64url')}`,headers:auth(token1)});assert.equal(again.statusCode,404);assert.equal(again.json().error.code,'NOT_FOUND');
  assert.equal((await db.query(`SELECT 1 FROM passkeys WHERE id=$1`,[two])).rowCount,1);
});

test('passkey rename trims and bounds the label, stays user isolated, and requires mutation origin',async()=>{
  const mine=Buffer.from('passkey-rename-owner-one'),other=Buffer.from('passkey-rename-owner-two');
  await db.query(`INSERT INTO passkeys(id,user_id,public_key,counter,device_type,backed_up,client_platform)
    VALUES($1,$2,$3,1,'multiDevice',true,'iOS App'),($4,$5,$3,1,'multiDevice',true,NULL)`,[mine,user1,Buffer.from('public-key-bytes'),other,user2]);
  const url=`/api/v1/passkeys/${mine.toString('base64url')}`;
  const item=(response:any)=>response.json().items.find((row:any)=>row.id===mine.toString('base64url'));
  assert.equal(item(await app.inject({method:'GET',url:'/api/v1/passkeys',headers:auth(token1)})).displayName,'iOS App');
  const renamed=await app.inject({method:'PATCH',url,headers:auth(token1),payload:{label:'  办公 iPhone  '}});
  assert.equal(renamed.statusCode,200,renamed.body);
  assert.equal(renamed.json().item.label,'办公 iPhone');assert.equal(renamed.json().item.displayName,'办公 iPhone');
  assert.equal(renamed.json().item.id,mine.toString('base64url'));assert.equal(renamed.json().item.public_key,undefined);assert.equal(renamed.json().item.counter,undefined);
  assert.equal((await db.query(`SELECT label FROM passkeys WHERE id=$1`,[mine])).rows[0].label,'办公 iPhone');
  assert.equal(item(await app.inject({method:'GET',url:'/api/v1/passkeys',headers:auth(token1)})).displayName,'办公 iPhone');
  for(const label of ['   ','x'.repeat(65)]){
    const invalid=await app.inject({method:'PATCH',url,headers:auth(token1),payload:{label}});
    assert.equal(invalid.statusCode,400,invalid.body);assert.equal(invalid.json().error.code,'INVALID_REQUEST');
  }
  const exact=await app.inject({method:'PATCH',url,headers:auth(token1),payload:{label:'y'.repeat(64)}});assert.equal(exact.statusCode,200,exact.body);assert.equal(exact.json().item.label,'y'.repeat(64));
  const cross=await app.inject({method:'PATCH',url:`/api/v1/passkeys/${other.toString('base64url')}`,headers:auth(token1),payload:{label:'stolen'}});assert.equal(cross.statusCode,404);assert.equal(cross.json().error.code,'NOT_FOUND');
  assert.equal((await db.query(`SELECT label FROM passkeys WHERE id=$1`,[other])).rows[0].label,null);
  const malformed=await app.inject({method:'PATCH',url:'/api/v1/passkeys/!!!',headers:auth(token1),payload:{label:'nope'}});assert.equal(malformed.statusCode,400);assert.equal(malformed.json().error.code,'INVALID_REQUEST');
  const anonymous=await app.inject({method:'PATCH',url,payload:{label:'nope'}});assert.equal(anonymous.statusCode,401);
  const web=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'one@example.test',password:'correct horse battery staple',platform:'web'},headers:{origin:config.PUBLIC_ORIGIN}});assert.equal(web.statusCode,200,web.body);
  const csrf=await app.inject({method:'PATCH',url,headers:{cookie:String(web.headers['set-cookie']).split(';')[0]},payload:{label:'csrf'}});assert.equal(csrf.statusCode,403);assert.equal(csrf.json().error.code,'ORIGIN_REJECTED');
  const deleted=await app.inject({method:'DELETE',url,headers:auth(token1)});assert.equal(deleted.statusCode,204,deleted.body);
  const gone=await app.inject({method:'PATCH',url,headers:auth(token1),payload:{label:'gone'}});assert.equal(gone.statusCode,404);
  await db.query(`DELETE FROM passkeys WHERE id=$1`,[other]);
});

test('admin gateway delete is refuse-only and cascades only pairing leftovers',async()=>{
  const created=await app.inject({method:'POST',url:'/api/v1/admin/gateways',headers:auth(adminToken),payload:{name:'delete-unused'}});assert.equal(created.statusCode,201,created.body);
  const unusedId=created.json().gateway.id as string;
  const deleted=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${unusedId}`,headers:auth(adminToken)});assert.equal(deleted.statusCode,204,deleted.body);assert.equal(deleted.body,'');
  assert.equal((await db.query(`SELECT 1 FROM gateways WHERE id=$1`,[unusedId])).rowCount,0);
  const audit=await db.query(`SELECT action,resource_type,resource_id FROM audit_events WHERE resource_id=$1 AND action='gateway.delete'`,[unusedId]);assert.equal(audit.rowCount,1);

  const pairing=await app.inject({method:'POST',url:'/api/v1/admin/gateways',headers:auth(adminToken),payload:{name:'delete-pairing'}});const pairingId=pairing.json().gateway.id as string;
  const code=await app.inject({method:'POST',url:`/api/v1/admin/gateways/${pairingId}/pairing-codes`,headers:auth(adminToken)});assert.equal(code.statusCode,201,code.body);
  const pairingDelete=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${pairingId}`,headers:auth(adminToken)});assert.equal(pairingDelete.statusCode,204,pairingDelete.body);
  assert.equal((await db.query(`SELECT 1 FROM gateways WHERE id=$1`,[pairingId])).rowCount,0);
  assert.equal((await db.query(`SELECT 1 FROM device_pairing_codes WHERE gateway_id=$1`,[pairingId])).rowCount,0);

  const leftover=await gatewayFixture(null,'delete-credentials');
  const leftoverDelete=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${leftover.gatewayId}`,headers:auth(adminToken)});assert.equal(leftoverDelete.statusCode,204,leftoverDelete.body);
  assert.equal((await db.query(`SELECT 1 FROM gateways WHERE id=$1`,[leftover.gatewayId])).rowCount,0);
  assert.equal((await db.query(`SELECT 1 FROM device_credentials WHERE gateway_id=$1`,[leftover.gatewayId])).rowCount,0);
  assert.equal((await db.query(`SELECT 1 FROM sims WHERE gateway_id=$1`,[leftover.gatewayId])).rowCount,0);

  const unknown=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${crypto.randomUUID()}`,headers:auth(adminToken)});assert.equal(unknown.statusCode,404);assert.equal(unknown.json().error.code,'NOT_FOUND');
  const forbidden=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${crypto.randomUUID()}`,headers:auth(token1)});assert.equal(forbidden.statusCode,403);assert.equal(forbidden.json().error.code,'FORBIDDEN');
  const webAdmin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin@example.test',password:'correct horse battery staple',platform:'web'},headers:{origin:config.PUBLIC_ORIGIN}});assert.equal(webAdmin.statusCode,200,webAdmin.body);
  const cookie=String(webAdmin.headers['set-cookie']).split(';')[0];
  const csrf=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${crypto.randomUUID()}`,headers:{cookie}});assert.equal(csrf.statusCode,403);assert.equal(csrf.json().error.code,'ORIGIN_REJECTED');

  async function refuse(label:string,setup:(gatewayId:string)=>Promise<void>){
    const fixture=await gatewayFixture(user1,label);
    await setup(fixture.gatewayId);
    const before={
      gateways:(await db.query(`SELECT count(*)::int n FROM gateways WHERE id=$1`,[fixture.gatewayId])).rows[0].n,
      calls:(await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,
      commands:(await db.query(`SELECT count(*)::int n FROM commands WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,
      horizons:(await db.query(`SELECT count(*)::int n FROM gateway_command_replay_horizons WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,
    };
    const response=await app.inject({method:'DELETE',url:`/api/v1/admin/gateways/${fixture.gatewayId}`,headers:auth(adminToken)});
    assert.equal(response.statusCode,409,`${label}: ${response.body}`);assert.equal(response.json().error.code,'GATEWAY_IN_USE');
    assert.equal((await db.query(`SELECT count(*)::int n FROM gateways WHERE id=$1`,[fixture.gatewayId])).rows[0].n,before.gateways);
    assert.equal((await db.query(`SELECT count(*)::int n FROM call_records WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,before.calls);
    assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,before.commands);
    assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_command_replay_horizons WHERE gateway_id=$1`,[fixture.gatewayId])).rows[0].n,before.horizons);
  }
  await refuse('delete-open-call',async gatewayId=>{
    const sim=(await db.query(`SELECT id FROM sims WHERE gateway_id=$1`,[gatewayId])).rows[0].id;
    await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','outgoing_pending',1,'normal')`,[gatewayId,sim,user1]);
  });
  await refuse('delete-lock',async gatewayId=>{
    const sim=(await db.query(`SELECT id FROM sims WHERE gateway_id=$1`,[gatewayId])).rows[0].id;
    const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','unknown',1,'normal') RETURNING id`,[gatewayId,sim,user1])).rows[0].id;
    await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,1)`,[gatewayId,call]);
  });
  await refuse('delete-pending-command',async gatewayId=>{
    const sim=(await db.query(`SELECT id FROM sims WHERE gateway_id=$1`,[gatewayId])).rows[0].id;
    await db.query(`INSERT INTO commands(gateway_id,sim_id,generation,sequence,kind,payload,expires_at)VALUES($1,$2,1,1,'apply_sim_settings','{}',now()+interval '1 hour')`,[gatewayId,sim]);
  });
  await refuse('delete-ended-history',async gatewayId=>{
    const sim=(await db.query(`SELECT id FROM sims WHERE gateway_id=$1`,[gatewayId])).rows[0].id;
    await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at)VALUES($1,$2,$3,'incoming','ended',1,'normal',now())`,[gatewayId,sim,user1]);
  });
  await refuse('delete-horizon',async gatewayId=>{
    await db.query(`INSERT INTO gateway_command_replay_horizons(gateway_id,generation,proposed_floor,proposed_revision,proposed_digest,committed_floor,committed_revision,committed_digest)VALUES($1,1,1,0,'',1,0,'')`,[gatewayId]);
  });
});

test('admin pairing code is one-time and rotates device epoch',async()=>{
  const g=await app.inject({method:'POST',url:'/api/v1/admin/gateways',headers:auth(adminToken),payload:{name:'pair-test'}});assert.equal(g.statusCode,201,g.body);const gid=g.json().gateway.id;
  const c=await app.inject({method:'POST',url:`/api/v1/admin/gateways/${gid}/pairing-codes`,headers:auth(adminToken)});assert.equal(c.statusCode,201,c.body);const code=c.json().pairingCode.code;
  const pair=await app.inject({method:'POST',url:'/api/v1/gateway/pair',payload:{code,label:'Pixel'}});assert.equal(pair.statusCode,201,pair.body);assert.ok(pair.json().deviceToken);assert.equal(pair.json().gateway.deviceEpoch,2);
  const synced=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(pair.json().deviceToken),payload:{items:[{slotIndex:0,subscriptionId:7,phoneAccountHandle:'phone-account-7',iccidFingerprint:'device-protected-fingerprint-a'}]}});assert.equal(synced.statusCode,200,synced.body);assert.equal(synced.json().items[0].needsOwnerAssignment,true);
  const changed=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(pair.json().deviceToken),payload:{items:[{slotIndex:0,subscriptionId:8,phoneAccountHandle:'phone-account-8',iccidFingerprint:'device-protected-fingerprint-b'}]}});assert.equal(changed.statusCode,200,changed.body);assert.notEqual(changed.json().items[0].id,synced.json().items[0].id);assert.equal(changed.json().items[0].needsOwnerAssignment,true);
  const adminSims=await app.inject({method:'GET',url:'/api/v1/admin/sims',headers:auth(adminToken)});assert.equal(adminSims.statusCode,200);assert.ok(adminSims.json().items.some((x:any)=>x.gatewayId===gid&&x.ownerUserId===null));
  const replay=await app.inject({method:'POST',url:'/api/v1/gateway/pair',payload:{code,label:'Pixel'}});assert.equal(replay.statusCode,400);assert.equal(replay.json().error.code,'PAIRING_CODE_INVALID');
});

test('SIM snapshot rejects duplicate slots, disables omitted profiles, and isolates a replacement identity',async()=>{
  const duplicate=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(deviceToken),payload:{items:[
    {slotIndex:0,subscriptionId:1,phoneAccountHandle:'a',iccidFingerprint:'snapshot-fingerprint-slot0'},
    {slotIndex:0,subscriptionId:2,phoneAccountHandle:'b',iccidFingerprint:'snapshot-fingerprint-slot0'},
  ]}});assert.equal(duplicate.statusCode,400);assert.equal(duplicate.json().error.code,'INVALID_REQUEST');
  const before=await db.query(`SELECT device_present FROM sims WHERE id=$1`,[sim2]);assert.equal(before.rows[0].device_present,true);

  const omit=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(deviceToken),payload:{items:[{slotIndex:0,subscriptionId:1,phoneAccountHandle:'a',iccidFingerprint:'snapshot-fingerprint-slot0'}]}});assert.equal(omit.statusCode,200,omit.body);
  const absent=await db.query(`SELECT device_present,subscription_id,phone_account_handle,version FROM sims WHERE id=$1`,[sim2]);assert.equal(absent.rows[0].device_present,false);assert.equal(absent.rows[0].subscription_id,null);assert.equal(absent.rows[0].phone_account_handle,null);
  const denied=await app.inject({method:'POST',url:'/api/v1/sms/outbound',headers:{...auth(token1),'idempotency-key':'absent-sim-send'},payload:{simId:sim2,remoteNumber:'+15550901',body:'must not queue'}});assert.equal(denied.statusCode,404);
  const assign=await app.inject({method:'PUT',url:`/api/v1/admin/sims/${sim2}/owner`,headers:auth(adminToken),payload:{ownerUserId:user2,expectedVersion:Number(absent.rows[0].version)}});assert.equal(assign.statusCode,409);assert.equal(assign.json().error.code,'SIM_ABSENT');

  const replacement=await app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(deviceToken),payload:{items:[{slotIndex:0,subscriptionId:3,phoneAccountHandle:'replacement',iccidFingerprint:'replacement-fingerprint-slot0'}]}});assert.equal(replacement.statusCode,200,replacement.body);assert.equal(replacement.json().items[0].needsOwnerAssignment,true);assert.notEqual(replacement.json().items[0].id,sim1);const replaced=await db.query(`SELECT owner_user_id,assignment_pending,device_present,slot_index FROM sims WHERE id=$1`,[sim1]);assert.equal(replaced.rows[0].owner_user_id,user1);assert.equal(replaced.rows[0].assignment_pending,false);assert.equal(replaced.rows[0].device_present,false);assert.equal(replaced.rows[0].slot_index,null);
});

test('gateway lock serializes snapshot omission against outbound reservation',async()=>{
  const raceGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,last_seen_at)VALUES('snapshot-race',true,true,now())RETURNING id`)).rows[0].id;
  const raceSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'race sim',true,$3)RETURNING id`,[raceGateway,user1,tokenHash('race-fingerprint-slot0')])).rows[0].id;await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[raceSim]);
  const raceDevice='race-device-token-with-sufficient-entropy';await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'race')`,[raceGateway,tokenHash(raceDevice)]);
  const [sync,reserve]=await Promise.all([
    app.inject({method:'POST',url:'/api/v1/gateway/sims/sync',headers:auth(raceDevice),payload:{items:[]}}),
    app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'snapshot-call-race'},payload:{simId:raceSim,remoteNumber:'+15550902'}}),
  ]);assert.equal(sync.statusCode,200,sync.body);assert.ok([202,404].includes(reserve.statusCode),reserve.body);
  const final=await db.query(`SELECT device_present FROM sims WHERE id=$1`,[raceSim]);assert.equal(final.rows[0].device_present,false);
  const pending=await db.query(`SELECT count(*)::int n FROM commands cmd JOIN call_records call ON call.id=cmd.call_id WHERE call.sim_id=$1 AND cmd.status='pending'`,[raceSim]);assert.equal(pending.rows[0].n,0);
  if(reserve.statusCode===202){const call=await db.query(`SELECT state FROM call_records WHERE id=$1`,[reserve.json().call.id]);assert.equal(call.rows[0].state,'unknown');}
});

test('media is disabled without secrets and normal end schedules bounded terminal wait',async()=>{
  const closeGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('media-close',true,true,true,now())RETURNING id,device_epoch`)).rows[0];
  const closeSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,'close sim',true)RETURNING id`,[closeGateway.id,user1])).rows[0].id;await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[closeSim]);
  const session=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(token1)])).rows[0].id;
  const closeCall=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,originating_session_id,originating_platform,answered_at)VALUES($1,$2,$3,'outgoing','active',$4,'normal',$5,'android',now())RETURNING id`,[closeGateway.id,closeSim,user1,closeGateway.device_epoch,session])).rows[0].id;await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[closeGateway.id,closeCall,closeGateway.device_epoch]);
  const disabled=await buildApp(db,{...config,MEDIA_SECRET:undefined,TURN_SECRET:undefined});try{const noGrant=await disabled.inject({method:'POST',url:`/api/v1/calls/${closeCall}/media/options`,headers:auth(token1)});assert.equal(noGrant.statusCode,503);assert.equal(noGrant.json().error.code,'MEDIA_UNAVAILABLE');const noDial=await disabled.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token1),'idempotency-key':'media-disabled-dial'},payload:{simId:closeSim,remoteNumber:'+15550903'}});assert.equal(noDial.statusCode,503);assert.equal(noDial.json().error.code,'MEDIA_UNAVAILABLE');}finally{await disabled.close();}

  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${closeCall}/end`,headers:auth(token1)});assert.equal(ended.statusCode,202,ended.body);
  const job=await db.query(`SELECT close_mode,attempts,last_error,completed_at,next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[closeCall]);assert.equal(job.rows[0].close_mode,'wait_terminal');assert.equal(job.rows[0].attempts,0);assert.equal(job.rows[0].last_error,null);assert.equal(job.rows[0].completed_at,null);assert.ok(job.rows[0].next_attempt_at);
  const revoked=await app.inject({method:'POST',url:`/api/v1/calls/${closeCall}/media/options`,headers:auth(token1)});assert.equal(revoked.statusCode,409);assert.equal(revoked.json().error.code,'MEDIA_REVOKED');
  // This test owns the scheduled close job. Leaving it behind makes a later one-slot
  // worker test timing-dependent once the terminal-wait deadline becomes due.
  await db.query(`DELETE FROM media_close_jobs WHERE call_id=$1`,[closeCall]);
});

test('normal end timeout force-closes media but keeps the call unknown and gateway locked',async()=>{
  const fixture=await gatewayFixture(user1,'normal-end-timeout');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'normal-end-timeout-call'},payload:{simId:fixture.simId,remoteNumber:'+15557002'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id;
  await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[callId]);
  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(ended.statusCode,202,ended.body);
  await db.query(`UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`,[ended.json().command.id]);
  await db.query(`UPDATE media_close_jobs SET next_attempt_at=now() WHERE call_id=$1`,[callId]);
  let closes=0;const worker=new MediaCloseWorker(db,{close:async()=>{closes++;}},{concurrency:1});
  assert.equal(await worker.tickOnce(),1);assert.equal(closes,1);
  const call=(await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[callId])).rows[0];assert.deepEqual(call,{state:'unknown',failure_reason:'hangup_terminal_unconfirmed'});
  assert.equal((await db.query(`SELECT count(*)::int n FROM gateway_call_locks WHERE call_id=$1`,[callId])).rows[0].n,1);
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`,[ended.json().command.id])).rows[0].status,'expired');
});

test('replayed normal end cannot downgrade or delay an existing force close',async()=>{
  const fixture=await gatewayFixture(user1,'normal-end-force-preserved');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'normal-end-force-preserved-call'},payload:{simId:fixture.simId,remoteNumber:'+15557003'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id;await markDialDelivered(callId);
  const first=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(first.statusCode,202,first.body);
  await db.query(`UPDATE media_close_jobs SET close_mode='force',next_attempt_at=now()-interval '1 second' WHERE call_id=$1`,[callId]);
  const before=new Date((await db.query(`SELECT next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[callId])).rows[0].next_attempt_at).getTime();
  const replay=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().command.id,first.json().command.id);
  const after=(await db.query(`SELECT close_mode,next_attempt_at FROM media_close_jobs WHERE call_id=$1`,[callId])).rows[0];assert.equal(after.close_mode,'force');assert.ok(new Date(after.next_attempt_at).getTime()<=before);
  await db.query(`DELETE FROM media_close_jobs WHERE call_id=$1`,[callId]);
});

test('normal end replay moving the deadline wins against a worker that selected the old deadline',async()=>{
  const fixture=await gatewayFixture(user1,'normal-end-deadline-race');
  const token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':'normal-end-deadline-race-call'},payload:{simId:fixture.simId,remoteNumber:'+15557004'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id;await markDialDelivered(callId);
  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token)});assert.equal(ended.statusCode,202,ended.body);
  await db.query(`UPDATE media_close_jobs SET next_attempt_at=now() WHERE call_id=$1`,[callId]);
  const blocker=await db.connect();await blocker.query('BEGIN');await blocker.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[fixture.gatewayId]);
  let closes=0;const worker=new MediaCloseWorker(db,{close:async()=>{closes++;}},{concurrency:1});const ticking=worker.tickOnce();let blockerCommitted=false;
  try{
    let claimed=false;for(let attempt=0;attempt<100;attempt++){const row=(await db.query(`SELECT lease_owner FROM media_close_jobs WHERE call_id=$1`,[callId])).rows[0];if(row?.lease_owner){claimed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(claimed,true);
    await db.query(`UPDATE media_close_jobs SET next_attempt_at=now()+interval '1 minute' WHERE call_id=$1`,[callId]);
    await blocker.query('COMMIT');blockerCommitted=true;
  }finally{if(!blockerCommitted)await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
  assert.equal(await ticking,1);assert.equal(closes,0);
  const job=(await db.query(`SELECT lease_owner,lease_until,next_attempt_at>now() deferred FROM media_close_jobs WHERE call_id=$1`,[callId])).rows[0];assert.equal(job.lease_owner,null);assert.equal(job.lease_until,null);assert.equal(job.deferred,true);
  assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[callId])).rows[0].state,'ending');
  await db.query(`DELETE FROM media_close_jobs WHERE call_id=$1`,[callId]);
});

test('media close worker survives failure and competing workers remove the job once',async()=>{
  const g=(await db.query(`INSERT INTO gateways(name)VALUES('worker-test')RETURNING id,device_epoch`)).rows[0];
  const s=(await db.query(`INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'worker sim')RETURNING id`,[g.id])).rows[0].id;await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[s]);
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at)VALUES($1,$2,$3,'outgoing','ended',$4,'normal',now())RETURNING id`,[g.id,s,user1,g.device_epoch])).rows[0].id;
  await db.query(`INSERT INTO media_close_jobs(call_id,next_attempt_at)VALUES($1,now())`,[call]);
  let closes=0;let failFirst=true;const closedCallIds:string[]=[];const fake={close:async(callId:string)=>{closes++;closedCallIds.push(callId);if(failFirst){failFirst=false;throw new Error('secret-bearing detail must not persist');}}} as unknown as MediaBridgeClient;
  const first=new MediaCloseWorker(db,fake,{concurrency:1,leaseSeconds:10});assert.equal(await first.tickOnce(),1);const failed=await db.query(`SELECT attempts,last_error,lease_owner,lease_until FROM media_close_jobs WHERE call_id=$1`,[call]);assert.equal(failed.rows[0].attempts,1);assert.equal(failed.rows[0].last_error,'media_close_failed');assert.equal(failed.rows[0].lease_owner,null);assert.equal(failed.rows[0].lease_until,null);
  await db.query(`UPDATE media_close_jobs SET next_attempt_at=now() WHERE call_id=$1`,[call]);const a=new MediaCloseWorker(db,fake,{concurrency:1}),b=new MediaCloseWorker(db,fake,{concurrency:1});const claimed=await Promise.all([a.tickOnce(),b.tickOnce()]);assert.equal(claimed[0]+claimed[1],1);assert.equal(closes,2);const gone=await db.query(`SELECT 1 FROM media_close_jobs WHERE call_id=$1`,[call]);assert.equal(gone.rowCount,0);
  const staleGateway=(await db.query(`INSERT INTO gateways(name,control_enabled,media_ready,last_seen_at)VALUES('stale-media',true,true,now()-interval '2 minutes')RETURNING id,device_epoch`)).rows[0];const staleSim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'stale sim')RETURNING id`,[staleGateway.id])).rows[0].id;await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[staleSim]);const staleCall=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,answered_at)VALUES($1,$2,$3,'incoming','active',$4,'normal',now())RETURNING id`,[staleGateway.id,staleSim,user1,staleGateway.device_epoch])).rows[0].id;const staleWorker=new MediaCloseWorker(db,fake,{concurrency:1,gatewayOfflineSeconds:10});assert.equal(await staleWorker.tickOnce(),1);const staleState=await db.query(`SELECT state FROM call_records WHERE id=$1`,[staleCall]);assert.equal(staleState.rows[0].state,'unknown');let staleJob=await db.query(`SELECT 1 FROM media_close_jobs WHERE call_id=$1`,[staleCall]);
  // A one-slot worker may legitimately spend its first batch on older close work left by
  // this integration suite. Promote this job for the next batch and still require that
  // the exact stale call is closed and its durable job is removed.
  if(staleJob.rowCount){await db.query(`UPDATE media_close_jobs SET next_attempt_at='-infinity'::timestamptz WHERE call_id=$1`,[staleCall]);assert.equal(await staleWorker.tickOnce(),1);}
  assert.ok(closedCallIds.includes(staleCall));staleJob=await db.query(`SELECT 1 FROM media_close_jobs WHERE call_id=$1`,[staleCall]);assert.equal(staleJob.rowCount,0);
});

test('logout revokes an in-flight offer, closes media, and leaves call unknown',async()=>{
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('logout-media',true,true,true,now())RETURNING id,device_epoch`)).rows[0];const s=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,'logout sim',true)RETURNING id`,[g.id,user1])).rows[0].id;await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[s]);const session=(await db.query(`SELECT id FROM sessions WHERE access_hash=$1`,[tokenHash(token1)])).rows[0].id;const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,originating_session_id,originating_platform,answered_at)VALUES($1,$2,$3,'outgoing','active',$4,'normal',$5,'android',now())RETURNING id`,[g.id,s,user1,g.device_epoch,session])).rows[0].id;await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)`,[g.id,call,g.device_epoch]);
  let offerSeen!:()=>void,release!:()=>void;const seen=new Promise<void>(resolve=>offerSeen=resolve),released=new Promise<void>(resolve=>release=resolve);let closes=0;const server=createServer(async(req,res)=>{if(req.url==='/offer'){offerSeen();await released;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'answer',sdp:'v=0\r\n'}));return;}if(req.url===`/close/${call}`){closes++;res.writeHead(204).end();return;}res.writeHead(404).end();});await new Promise<void>(resolve=>server.listen(16881,'127.0.0.1',resolve));try{const offerPromise=app.inject({method:'POST',url:`/api/v1/calls/${call}/media/offer`,headers:auth(token1),payload:{type:'offer',sdp:'v=0\r\n'}});await seen;const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:auth(token1)});assert.equal(logout.statusCode,204,logout.body);release();const offer=await offerPromise;assert.equal(offer.statusCode,409,offer.body);assert.equal(offer.json().error.code,'MEDIA_REVOKED');}finally{release();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  const state=await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`,[call]);assert.equal(state.rows[0].state,'unknown');assert.equal(state.rows[0].failure_reason,'session_revoked');assert.ok(closes>=2);
});

test('push destinations bind to the current native session and do not retain another account tokens',async()=>{
  const iosLogin=async(username:string)=>{const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password:'correct horse battery staple',platform:'ios'}});assert.equal(r.statusCode,200);return r.json().token as string;};
  const first=await iosLogin('one@example.test'),second=await iosLogin('two@example.test');
  const installationId=crypto.randomUUID(),path=`/api/v1/push/registrations/${installationId}`;
  const body={platform:'ios',bundleId:'org.vodog',environment:'development',deviceName:'Fixture iPhone'};
  const created=await app.inject({method:'PUT',url:path,headers:auth(first),payload:{...body,voipToken:'a'.repeat(64)}});assert.equal(created.statusCode,200,created.body);assert.equal(created.json().registration.voipEnabled,true);assert.equal(created.body.includes('a'.repeat(64)),false);
  const preserved=await app.inject({method:'PUT',url:path,headers:auth(first),payload:{...body,apnsToken:'b'.repeat(64)}});assert.equal(preserved.json().registration.voipEnabled,true);assert.equal(preserved.json().registration.apnsEnabled,true);
  const rebound=await app.inject({method:'PUT',url:path,headers:auth(second),payload:body});assert.equal(rebound.statusCode,200,rebound.body);assert.equal(rebound.json().registration.voipEnabled,false);assert.equal(rebound.json().registration.apnsEnabled,false);
  await app.inject({method:'DELETE',url:path,headers:auth(first)});
  const binding=(await db.query('SELECT user_id,disabled_at FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0];assert.equal(binding.user_id,user2);assert.equal(binding.disabled_at,null);
  const ready=await app.inject({method:'PUT',url:path,headers:auth(second),payload:{...body,voipToken:'a'.repeat(64)}});assert.equal(ready.statusCode,200);
  const other=crypto.randomUUID();await app.inject({method:'PUT',url:`/api/v1/push/registrations/${other}`,headers:auth(second),payload:{...body,voipToken:'a'.repeat(64)}});
  const cleared=(await db.query('SELECT voip_token FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0];assert.equal(cleared.voip_token,null);
  const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:auth(second)});assert.equal(logout.statusCode,204);
  const eligible=await db.query(`SELECT p.id FROM push_registrations p JOIN sessions s ON s.id=p.session_id WHERE p.installation_id=$1 AND p.disabled_at IS NULL AND s.revoked_at IS NULL AND s.refresh_expires_at>now()`,[other]);assert.equal(eligible.rowCount,0);
  const stale=await app.inject({method:'PUT',url:path,headers:auth(second),payload:body});assert.equal(stale.statusCode,401);
  const wrongTopic=await app.inject({method:'PUT',url:path,headers:auth(first),payload:{...body,bundleId:'org.example.otherapp'}});assert.equal(wrongTopic.statusCode,400);
});

test('push worker retries once per leased delivery and cancels revoked or ended destinations',async()=>{
  const {PushWorker}=await import('../src/push-worker.js');
  await db.query("UPDATE call_records SET state='ended' WHERE state='incoming_ringing'");
  const fixture=await gatewayFixture(user1,'push-worker-fixture');
  const session=(await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,$2,'native','ios',now()+interval '15 minutes',now()+interval '1 day') RETURNING id`,[user1,tokenHash(crypto.randomUUID())])).rows[0].id;
  const registration=(await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,environment,device_name,voip_token)VALUES($1,$2,$3,'development','Push fixture',$4) RETURNING id`,[crypto.randomUUID(),user1,session,'c'.repeat(64)])).rows[0].id;
  const makeCall=async()=> (await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'incoming','incoming_ringing',1,'normal') RETURNING id`,[fixture.gatewayId,fixture.simId,user1])).rows[0].id;
  const callId=await makeCall();const sent:string[]=[];let status=503;
  const sender={sendIncoming:async(push:any)=>{sent.push(push.callId);return {status};}};
  const first=new PushWorker(db,sender),second=new PushWorker(db,sender);
  await first.tick();assert.deepEqual(sent,[callId]);
  await db.query('UPDATE push_deliveries SET next_attempt_at=now() WHERE call_id=$1',[callId]);status=200;
  await Promise.all([first.tick(),second.tick()]);assert.deepEqual(sent,[callId,callId]);
  assert.equal((await db.query('SELECT state FROM push_deliveries WHERE call_id=$1',[callId])).rows[0].state,'delivered');
  const cancelled=await makeCall();await db.query('INSERT INTO push_deliveries(call_id,registration_id,session_id)VALUES($1,$2,$3)',[cancelled,registration,session]);
  await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[session]);await first.tick();
  assert.equal(sent.length,2);assert.equal((await db.query('SELECT state FROM push_deliveries WHERE call_id=$1',[cancelled])).rows[0].state,'cancelled');
});


test('incoming claim response is atomic, session-bound and replayable after a lost response', {timeout:15000}, async()=>{
  const fixture=await gatewayFixture(user1,'claim-replay');
  const winnerToken=await login('one@example.test','correct horse battery staple');
  const otherToken=await login('one@example.test','correct horse battery staple');
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,device_call_id)VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'normal',$5) RETURNING id`,[fixture.gatewayId,fixture.simId,user1,fixture.deviceEpoch,crypto.randomUUID()])).rows[0];
  const request={method:'POST' as const,url:`/api/v1/calls/${call.id}/claim`,headers:auth(winnerToken),payload:{platform:'ios',deviceName:'test device'}};
  const [first,replay]=await Promise.all([app.inject(request),app.inject(request)]);
  for(const response of [first,replay]) { assert.equal(response.statusCode,200,response.body);assert.equal(response.json().call.claimedByCurrentSession,true);assert.equal(response.json().call.state,'connecting');assert.equal(response.json().call.answeredByPlatform,'android'); }
  assert.deepEqual([first.json().replayed,replay.json().replayed].sort(),[false,true]);
  const count=await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[call.id]);assert.equal(count.rows[0].n,1);
  const losingClaim=await app.inject({...request,headers:auth(otherToken)});assert.equal(losingClaim.statusCode,409,losingClaim.body);
  const winnerDetail=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(winnerToken)});assert.equal(winnerDetail.json().call.claimedByCurrentSession,true);
  const otherDetail=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(otherToken)});assert.equal(otherDetail.json().call.claimedByCurrentSession,false);
  const losingEnd=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/end`,headers:auth(otherToken),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(losingEnd.statusCode,409,losingEnd.body);assert.equal(losingEnd.json().error.code,'CALL_NOT_SESSION_OWNER');
  assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[call.id])).rows[0].state,'connecting');
  await db.query(`UPDATE gateways SET control_enabled=false WHERE id=$1`,[fixture.gatewayId]);
  const uncertainRetry=await app.inject(request);assert.equal(uncertainRetry.statusCode,200,uncertainRetry.body);assert.equal(uncertainRetry.json().replayed,true);
  await db.query(`UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,[call.id]);
  const staleRetry=await app.inject(request);assert.equal(staleRetry.statusCode,409,staleRetry.body);
  const finalCount=await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1`,[call.id]);assert.equal(finalCount.rows[0].n,1);
});

test('unknown dial acknowledgement retains hardware lock until an actual end observation',async()=>{
  const f=await gatewayFixture(user1,'unknown-dial-ack'),token=await login('one@example.test','correct horse battery staple');
  const outbound=()=>app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556021'}});
  const started=await outbound();assert.equal(started.statusCode,202,started.body);const {call,command}=started.json();
  const request={method:'POST' as const,url:`/api/v1/gateway/commands/${command.id}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'rejected',telecomState:'UNKNOWN',result:{phase:'unknown',reason:'execution_unknown'}}};
  const unknown=await app.inject(request);assert.equal(unknown.statusCode,200,unknown.body);
  assert.equal((await db.query('SELECT state FROM call_records WHERE id=$1',[call.id])).rows[0].state,'unknown');assert.equal((await db.query('SELECT 1 FROM gateway_call_locks WHERE call_id=$1',[call.id])).rowCount,1);
  assert.equal((await app.inject(request)).json().command.replayed,true);assert.equal((await outbound()).statusCode,409);
  const ended=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/events`,headers:auth(f.deviceToken),payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,state:'ended'}});assert.equal(ended.statusCode,200,ended.body);assert.equal((await db.query('SELECT 1 FROM gateway_call_locks WHERE call_id=$1',[call.id])).rowCount,0);
});

test('rejected hangup retains lock and late active observations cannot cancel pending hangup',async()=>{
  const f=await gatewayFixture(user1,'rejected-hangup'),token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556022'}});assert.equal(started.statusCode,202,started.body);const call=started.json().call;
  await db.query("UPDATE call_records SET state='active',answered_at=now() WHERE id=$1",[call.id]);
  const end=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(end.statusCode,202,end.body);
  const active=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/events`,headers:auth(f.deviceToken),payload:{eventId:crypto.randomUUID(),generation:f.deviceEpoch,state:'active'}});assert.equal(active.statusCode,200,active.body);assert.equal((await db.query('SELECT state FROM call_records WHERE id=$1',[call.id])).rows[0].state,'ending');
  const rejected=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${end.json().command.id}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'rejected',result:{reason:'call_not_actionable'}}});assert.equal(rejected.statusCode,200,rejected.body);
  assert.equal((await db.query('SELECT state FROM call_records WHERE id=$1',[call.id])).rows[0].state,'unknown');assert.equal((await db.query('SELECT 1 FROM gateway_call_locks WHERE call_id=$1',[call.id])).rowCount,1);
});

test('answered call treats device-confirmed already-ended hangup as idempotent end',async()=>{
  const f=await gatewayFixture(user1,'already-ended-hangup'),token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556033'}});assert.equal(started.statusCode,202,started.body);const call=started.json().call;
  await db.query("UPDATE call_records SET state='active',answered_at=now(),device_call_id='device-ended-call' WHERE id=$1",[call.id]);
  const end=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(end.statusCode,202,end.body);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${end.json().command.id}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'rejected',result:{reason:'call_already_ended',phase:'not_executed'}}});assert.equal(ack.statusCode,200,ack.body);
  const terminal=(await db.query('SELECT state,failure_reason,ended_at FROM call_records WHERE id=$1',[call.id])).rows[0];
  assert.equal(terminal.state,'ended');assert.equal(terminal.failure_reason,null);assert.ok(terminal.ended_at);
  assert.equal((await db.query('SELECT 1 FROM gateway_call_locks WHERE call_id=$1',[call.id])).rowCount,0);
  assert.deepEqual((await db.query('SELECT status,result FROM commands WHERE id=$1',[end.json().command.id])).rows[0],{status:'rejected',result:{reason:'call_already_ended',phase:'not_executed'}});
});

test('already-ended hangup remains fail closed without answered-call evidence',async()=>{
  const f=await gatewayFixture(user1,'unanswered-already-ended-hangup'),token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556034'}});assert.equal(started.statusCode,202,started.body);const call=started.json().call;await markDialDelivered(call.id);
  const end=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(end.statusCode,202,end.body);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${end.json().command.id}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'rejected',result:{reason:'call_already_ended',phase:'not_executed'}}});assert.equal(ack.statusCode,200,ack.body);
  const uncertain=(await db.query('SELECT state,failure_reason,ended_at FROM call_records WHERE id=$1',[call.id])).rows[0];
  assert.equal(uncertain.state,'unknown');assert.equal(uncertain.failure_reason,'call_already_ended');assert.equal(uncertain.ended_at,null);
  assert.equal((await db.query('SELECT 1 FROM gateway_call_locks WHERE call_id=$1',[call.id])).rowCount,1);
});

test('answered call keeps ambiguous already-ended hangup result fail closed',async()=>{
  const f=await gatewayFixture(user1,'ambiguous-already-ended-hangup'),token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556035'}});assert.equal(started.statusCode,202,started.body);const call=started.json().call;
  await db.query("UPDATE call_records SET state='active',answered_at=now() WHERE id=$1",[call.id]);
  const end=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});assert.equal(end.statusCode,202,end.body);
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${end.json().command.id}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'rejected',result:{reason:'call_already_ended',phase:'unknown'}}});assert.equal(ack.statusCode,200,ack.body);
  const uncertain=(await db.query('SELECT state,failure_reason,ended_at FROM call_records WHERE id=$1',[call.id])).rows[0];
  assert.equal(uncertain.state,'unknown');assert.equal(uncertain.failure_reason,'call_already_ended');assert.equal(uncertain.ended_at,null);
  assert.equal((await db.query('SELECT 1 FROM gateway_call_locks WHERE call_id=$1',[call.id])).rowCount,1);
});


test('call list and detail expose session execution ownership for incoming and outgoing without leaking session IDs',async()=>{
  const f=await gatewayFixture(user1,'session-ownership-reads');
  const owner=await login('one@example.test','correct horse battery staple');
  const other=await login('one@example.test','correct horse battery staple');
  const session=(await db.query('SELECT id FROM sessions WHERE access_hash=$1',[tokenHash(owner)])).rows[0].id;
  for(const direction of ['incoming','outgoing']) {
    const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,claimed_by_session_id,originating_session_id,originating_platform,answered_at) VALUES($1,$2,$3,$4,'active',$5,'normal',$6,$7,$8,now()) RETURNING id`,[f.gatewayId,f.simId,user1,direction,f.deviceEpoch,direction==='incoming'?session:null,direction==='outgoing'?session:null,direction==='outgoing'?'android':null])).rows[0];
    for(const [token,expected] of [[owner,true],[other,false]] as const) {
      const list=await app.inject({method:'GET',url:'/api/v1/calls?limit=100',headers:auth(token)});
      const detail=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token)});
      assert.equal(list.statusCode,200,list.body);assert.equal(detail.statusCode,200,detail.body);
      for(const row of [list.json().items.find((x:any)=>x.id===call.id),detail.json().call]) {
        assert.ok(row);assert.equal(row.claimedByCurrentSession,expected);
        assert.equal(JSON.stringify(row).includes(session),false);
      }
    }
    const unauthorized=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token2)});assert.equal(unauthorized.statusCode,404);
    await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1",[call.id]);
  }
});

test('replay horizon heartbeat quarantines capability loss even after feature flag is disabled',async()=>{
 const f=await gatewayFixture(user1,'replay-quarantine');
 config.COMMAND_REPLAY_HORIZON_ENABLED=true;
 const payload={controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true,commandReplayHorizonVersion:1},replayHorizonState:{gatewayId:f.gatewayId,generation:f.deviceEpoch,blockingFloor:1,preparedRevision:0,preparedDigest:'',committedFloor:1,committedRevision:0,committedDigest:''}};
 try {
  const first=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload});assert.equal(first.statusCode,200,first.body);
  config.COMMAND_REPLAY_HORIZON_ENABLED=false;
  const second=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  assert.equal(second.statusCode,200,second.body);assert.equal(second.json().replayHorizon.phase,'quarantined');assert.deepEqual(second.json().commands,[]);
  const row=(await db.query('SELECT telephony_ready,sms_ready,media_ready FROM gateways WHERE id=$1',[f.gatewayId])).rows[0];assert.deepEqual(row,{telephony_ready:false,sms_ready:false,media_ready:false});
 }finally{config.COMMAND_REPLAY_HORIZON_ENABLED=false;}
});

test('replay ACK receipt binds immutable wire identity and refuses conflicting retry evidence',async()=>{
 const {commandReplayFingerprint}=await import('../src/replay-horizon.js');
 const f=await gatewayFixture(user1,'replay-bound-ack');
 await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
 const cmd=(await db.query("SELECT * FROM commands WHERE gateway_id=$1 AND kind='apply_sim_settings' ORDER BY sequence LIMIT 1",[f.gatewayId])).rows[0];
 const payload={generation:f.deviceEpoch,status:'acked',result:{simId:f.simId,appliedVersion:Number(cmd.payload.settingsVersion),assignmentVersion:f.assignmentVersion},replayEvidence:{sequence:Number(cmd.sequence),fingerprint:'x'.repeat(43)}};
 const ack=()=>app.inject({method:'POST',url:`/api/v1/gateway/commands/${cmd.id}/ack`,headers:auth(f.deviceToken),payload});
 assert.equal((await ack()).statusCode,409);
 payload.replayEvidence.fingerprint=commandReplayFingerprint(cmd,f.gatewayId);
 const accepted=await ack();assert.equal(accepted.statusCode,200,accepted.body);assert.equal((await ack()).statusCode,200);
 assert.equal((await db.query('SELECT fingerprint FROM gateway_command_replay_receipts WHERE command_id=$1',[cmd.id])).rows[0].fingerprint,payload.replayEvidence.fingerprint);
 payload.result.appliedVersion+=1;assert.equal((await ack()).statusCode,409);
});

test('authenticated replay heartbeat completes proposed prepared committed handshake',async()=>{
 const {commandReplayFingerprint}=await import('../src/replay-horizon.js');const f=await gatewayFixture(user1,'replay-real-handshake');
 config.COMMAND_REPLAY_HORIZON_ENABLED=true;
 const state={gatewayId:f.gatewayId,generation:f.deviceEpoch,blockingFloor:1,preparedRevision:0,preparedDigest:'',committedFloor:1,committedRevision:0,committedDigest:''};
 const heartbeat=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true,commandReplayHorizonVersion:1},replayHorizonState:state}});
 try{
  const first=await heartbeat();assert.equal(first.statusCode,200,first.body);
  const cmd=(await db.query("SELECT * FROM commands WHERE gateway_id=$1 AND kind='apply_sim_settings' ORDER BY sequence LIMIT 1",[f.gatewayId])).rows[0];
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${cmd.id}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'acked',result:{simId:f.simId,appliedVersion:Number(cmd.payload.settingsVersion),assignmentVersion:f.assignmentVersion},replayEvidence:{sequence:Number(cmd.sequence),fingerprint:commandReplayFingerprint(cmd,f.gatewayId)}}});assert.equal(ack.statusCode,200,ack.body);
  const proposed=await heartbeat();assert.equal(proposed.statusCode,200,proposed.body);const p=proposed.json().replayHorizon;assert.equal(p.phase,'proposed');assert.equal(p.retireBeforeSequence,2);
  Object.assign(state,{blockingFloor:p.retireBeforeSequence,preparedRevision:p.revision,preparedDigest:p.proofDigest});
  const committed=await heartbeat();assert.equal(committed.statusCode,200,committed.body);assert.deepEqual(committed.json().replayHorizon,{...p,phase:'control_committed'});assert.deepEqual(committed.json().commands,[]);
  Object.assign(state,{committedFloor:p.retireBeforeSequence,committedRevision:p.revision,committedDigest:p.proofDigest});
  const done=await heartbeat();assert.equal(done.statusCode,200,done.body);assert.equal(done.json().replayHorizon,undefined);assert.deepEqual(done.json().commands,[]);
 }finally{config.COMMAND_REPLAY_HORIZON_ENABLED=false;}
});

test('device migration preflight and commit preserve credential and SIM settings behind explicit flag',async()=>{
 const f=await gatewayFixture(user1,'migration-routes');
 const payload={intentId:crypto.randomUUID(),generation:f.deviceEpoch,serverSequence:0,localProof:{idle:true,pendingAcks:0,pendingEvents:0,pendingCommands:0,unknownExecutions:0}};
 const post=(phase:string)=>app.inject({method:'POST',url:`/api/v1/gateway/replay-migration/${phase}`,headers:auth(f.deviceToken),payload});
 const disabled=await post('preflight');assert.equal(disabled.statusCode,200,disabled.body);assert.equal(disabled.json().eligible,false);assert.equal(disabled.json().blockers[0].code,'migration_disabled');
 config.COMMAND_REPLAY_MIGRATION_ENABLED=true;
 try{
  assert.equal((await post('preflight')).json().eligible,true);
  const committed=await post('commit');assert.equal(committed.statusCode,200,committed.body);assert.equal(committed.json().receipt.toGeneration,f.deviceEpoch+1);assert.deepEqual((await post('commit')).json(),committed.json());
  config.COMMAND_REPLAY_MIGRATION_ENABLED=false;
  const heartbeatRequest=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  const waiting=await heartbeatRequest();assert.equal(waiting.statusCode,200,waiting.body);assert.equal(waiting.json().replayMigrationPending,true);assert.equal(waiting.json().gateway.serverSequence,0);assert.deepEqual(waiting.json().commands,[]);
  const receipt=committed.json().receipt;
  const complete=(generation:number)=>app.inject({method:'POST',url:'/api/v1/gateway/replay-migration/complete',headers:auth(f.deviceToken),payload:{intentId:receipt.intentId,generation,proofDigest:receipt.proofDigest}});
  assert.equal((await complete(f.deviceEpoch)).json().completed,false);
  assert.equal((await complete(f.deviceEpoch+1)).json().completed,true);assert.equal((await complete(f.deviceEpoch+1)).json().completed,true);
  const heartbeat=await heartbeatRequest();assert.equal(heartbeat.statusCode,200,heartbeat.body);assert.equal(heartbeat.json().gateway.deviceEpoch,f.deviceEpoch+1);assert.equal(heartbeat.json().commands[0].kind,'apply_sim_settings');
  assert.equal((await db.query('SELECT owner_user_id FROM sims WHERE id=$1',[f.simId])).rows[0].owner_user_id,user1);
 }finally{config.COMMAND_REPLAY_MIGRATION_ENABLED=false;}
});

test('heartbeat refreshes live SIM IANA while call snapshots stay frozen and hangup backfills a missing zone',async()=>{
  const fixture=await gatewayFixture(user1,'gateway-tz');
  const userToken=await login('one@example.test','correct horse battery staple');
  const adminAuth=await login('admin@example.test','correct horse battery staple');
  const caps={telephonyReady:true,smsReady:true,mediaReady:true};
  const heartbeat=(timeZone?:string)=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:caps,...(timeZone===undefined?{}:{timeZone})}});
  for(const zone of ['Asia/Beijing','+08:00','-08:00','UTC','GMT']){
    const rejected=await heartbeat(zone);assert.equal(rejected.statusCode,400,`${zone}: ${rejected.body}`);assert.equal(rejected.json().error.code,'INVALID_TIME_ZONE');
  }
  const shanghai=await heartbeat('Asia/Shanghai');assert.equal(shanghai.statusCode,200,shanghai.body);
  const sims=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(userToken)});assert.equal(sims.statusCode,200,sims.body);assert.equal(sims.json().items.find((item:any)=>item.id===fixture.simId).timeZone,'Asia/Shanghai');
  const adminGateways=await app.inject({method:'GET',url:'/api/v1/admin/gateways',headers:auth(adminAuth)});assert.equal(adminGateways.statusCode,200,adminGateways.body);assert.equal(adminGateways.json().items.find((item:any)=>item.id===fixture.gatewayId).timeZone,'Asia/Shanghai');
  const first=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':'tz-snapshot-first'},payload:{simId:fixture.simId,remoteNumber:'+15559001'}});assert.equal(first.statusCode,202,first.body);assert.equal(first.json().call.gatewayTimeZone,'Asia/Shanghai');
  const taipei=await heartbeat('Asia/Taipei');assert.equal(taipei.statusCode,200,taipei.body);
  const live=await app.inject({method:'GET',url:'/api/v1/sims',headers:auth(userToken)});assert.equal(live.statusCode,200,live.body);assert.equal(live.json().items.find((item:any)=>item.id===fixture.simId).timeZone,'Asia/Taipei');
  const frozen=await app.inject({method:'GET',url:`/api/v1/calls/${first.json().call.id}`,headers:auth(userToken)});assert.equal(frozen.json().call.gatewayTimeZone,'Asia/Shanghai');
  const listed=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(userToken)});assert.equal(listed.json().items.find((item:any)=>item.id===first.json().call.id).gatewayTimeZone,'Asia/Shanghai');
  const closeFirst=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${first.json().call.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'ended'}});assert.equal(closeFirst.statusCode,200,closeFirst.body);
  await db.query(`UPDATE gateways SET time_zone=NULL WHERE id=$1`,[fixture.gatewayId]);
  const missing=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':'tz-snapshot-missing'},payload:{simId:fixture.simId,remoteNumber:'+15559002'}});assert.equal(missing.statusCode,202,missing.body);assert.equal(missing.json().call.gatewayTimeZone,null);
  await db.query(`UPDATE gateways SET time_zone='Asia/Taipei' WHERE id=$1`,[fixture.gatewayId]);
  const ended=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${missing.json().call.id}/events`,headers:auth(fixture.deviceToken),payload:{eventId:crypto.randomUUID(),generation:fixture.deviceEpoch,state:'ended'}});assert.equal(ended.statusCode,200,ended.body);
  const backfilled=await app.inject({method:'GET',url:`/api/v1/calls/${missing.json().call.id}`,headers:auth(userToken)});assert.equal(backfilled.json().call.gatewayTimeZone,'Asia/Taipei');
});

test('SIM notes CAS updates labels without rewriting the identity hash',async()=>{
  const fixture=await gatewayFixture(user1,'sim-notes');
  const userToken=await login('one@example.test','correct horse battery staple');
  const otherToken=await login('two@example.test','correct horse battery staple');
  const before=(await db.query(`SELECT protected_iccid_hash,version,label,phone_label FROM sims WHERE id=$1`,[fixture.simId])).rows[0];
  const anonymous=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}`,payload:{label:'Desk phone',expectedVersion:Number(before.version)}});assert.equal(anonymous.statusCode,401);
  const isolated=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}`,headers:auth(otherToken),payload:{label:'Desk phone',expectedVersion:Number(before.version)}});assert.equal(isolated.statusCode,404);assert.equal(isolated.json().error.code,'NOT_FOUND');
  const updated=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}`,headers:auth(userToken),payload:{label:'Desk phone',phoneLabel:'13800001234',expectedVersion:Number(before.version)}});assert.equal(updated.statusCode,200,updated.body);
  assert.equal(updated.json().sim.id,fixture.simId);assert.equal(updated.json().sim.label,'Desk phone');assert.equal(updated.json().sim.phoneLabel,'13800001234');assert.equal(updated.json().sim.version,Number(before.version)+1);
  const conflict=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}`,headers:auth(userToken),payload:{label:'Stale',expectedVersion:Number(before.version)}});assert.equal(conflict.statusCode,409,conflict.body);assert.equal(conflict.json().error.code,'VERSION_CONFLICT');assert.equal(conflict.json().error.details.currentVersion,Number(before.version)+1);
  const cleared=await app.inject({method:'PUT',url:`/api/v1/sims/${fixture.simId}`,headers:auth(userToken),payload:{phoneLabel:null,expectedVersion:Number(before.version)+1}});assert.equal(cleared.statusCode,200,cleared.body);assert.equal(cleared.json().sim.phoneLabel,null);assert.equal(cleared.json().sim.label,'Desk phone');
  const after=(await db.query(`SELECT protected_iccid_hash,label,phone_label FROM sims WHERE id=$1`,[fixture.simId])).rows[0];
  assert.equal(after.protected_iccid_hash,before.protected_iccid_hash);assert.equal(after.label,'Desk phone');assert.equal(after.phone_label,null);
});

test('call occupancy DTO reports the gateway lock, its occupant, and the release affordance',async()=>{
  const fixture=await gatewayFixture(user1,'occupancy-dto');
  const owner=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(owner),'idempotency-key':'occupancy-dto-call'},payload:{simId:fixture.simId,remoteNumber:'+15554090'}});
  assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string;
  const occupancyOf=async(token:string)=>{
    const listed=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
    assert.equal(listed.statusCode,200,listed.body);
    const item=listed.json().items.find((row:{id:string})=>row.id===callId);
    assert.ok(item,'the owner must still see the occupying call');
    const detail=await app.inject({method:'GET',url:`/api/v1/calls/${callId}`,headers:auth(token)});
    assert.equal(detail.statusCode,200,detail.body);
    // The single-call route carries the identical additive field.
    assert.deepEqual(detail.json().call.occupancy,item.occupancy);
    return item.occupancy;
  };
  const acquiredAt=(await db.query(`SELECT acquired_at FROM gateway_call_locks WHERE call_id=$1`,[callId])).rows[0].acquired_at;
  const occupying=await occupancyOf(owner);
  assert.deepEqual(Object.keys(occupying).sort(),['canRelease','holdsLock','isCurrentSession','lockedSince','occupantDevice','occupantPlatform']);
  assert.deepEqual(occupying,{holdsLock:true,lockedSince:new Date(acquiredAt).toISOString(),occupantPlatform:'android',occupantDevice:null,isCurrentSession:true,canRelease:true});
  // Another session of the same owner may still release it; it is simply not the executing session.
  const sibling=await login('one@example.test','correct horse battery staple');
  assert.deepEqual(await occupancyOf(sibling),{...occupying,isCurrentSession:false});
  // The answering endpoint wins over the originating platform, and AI answers surface as 'ai'.
  await db.query(`UPDATE call_records SET answered_by_platform='ios',answered_by_device='办公 iPhone' WHERE id=$1`,[callId]);
  assert.deepEqual(await occupancyOf(owner),{...occupying,occupantPlatform:'ios',occupantDevice:'办公 iPhone'});
  await db.query(`UPDATE call_records SET answered_by_platform='ai',answered_by_device='AI' WHERE id=$1`,[callId]);
  assert.equal((await occupancyOf(owner)).occupantPlatform,'ai');
  // A terminal call never claims the lock and can no longer be released, even if a lock row lingers.
  await db.query(`UPDATE call_records SET state='failed',ended_at=now() WHERE id=$1`,[callId]);
  assert.deepEqual(await occupancyOf(owner),{holdsLock:false,lockedSince:null,occupantPlatform:'ai',occupantDevice:'AI',isCurrentSession:true,canRelease:false});
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);
  // A call without any lock row reports an unoccupied, still releasable live call.
  await db.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[callId]);
  await db.query(`UPDATE call_records SET state='unknown',ended_at=NULL WHERE id=$1`,[callId]);
  assert.deepEqual(await occupancyOf(owner),{holdsLock:false,lockedSince:null,occupantPlatform:'ai',occupantDevice:'AI',isCurrentSession:true,canRelease:true});
});

// Hangup before the dial is delivered: the gateway must never place the call.
test('ending an outgoing call whose dial was never delivered cancels the dial instead of racing a hangup',async()=>{
  const f=await gatewayFixture(user1,'dial-cancelled-before-delivery'),token=await login('one@example.test','correct horse battery staple');
  const heartbeat=(caps:Record<string,boolean>,reportedSequence=0)=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload:{controlEnabled:true,reportedSequence,capabilities:{smsReady:false,mediaReady:true,...caps}}});
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556090'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string,dialId=started.json().command.id as string;
  // Held: telephony is not ready, so the dial is not handed out.
  const held=await heartbeat({telephonyReady:false});assert.equal(held.statusCode,200,held.body);assert.ok(!held.json().commands.some((c:any)=>c.id===dialId));
  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});
  assert.equal(ended.statusCode,202,ended.body);assert.equal(ended.json().command,null);assert.equal(ended.json().call.state,'ended');
  const call=(await db.query(`SELECT state,failure_reason,ended_at FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.equal(call.state,'ended');assert.equal(call.failure_reason,null);assert.ok(call.ended_at);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,0);
  assert.deepEqual((await db.query(`SELECT kind FROM commands WHERE call_id=$1`,[callId])).rows.map(r=>r.kind),['dial']);
  await untilRows(`SELECT 1 FROM diag_events WHERE event='call.dial_cancelled' AND call_id=$1 AND fields->>'commandId'=$2`,[callId,dialId],'the call.dial_cancelled row');
  // Replay of /end is idempotent on the ended call.
  const again=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token)});assert.equal(again.statusCode,202,again.body);assert.equal(again.json().command,null);
  // Telephony comes back: the dial is never offered for execution.
  const ready=await heartbeat({telephonyReady:true});assert.equal(ready.statusCode,200,ready.body);assert.ok(!ready.json().commands.some((c:any)=>c.id===dialId));
  assert.equal((await db.query(`SELECT delivered_at FROM commands WHERE id=$1`,[dialId])).rows[0].delivered_at,null);
  // A reconciliation-capable gateway only sees it reconciliationOnly, rejects it without effect,
  // and that bound ACK retires it from the replay horizon.
  const reconcile=await heartbeat({telephonyReady:true,commandReconciliationReady:true});assert.equal(reconcile.statusCode,200,reconcile.body);
  const offered=reconcile.json().commands.find((c:any)=>c.id===dialId);assert.ok(offered);assert.equal(offered.reconciliationOnly,true);
  const {commandReplayFingerprint,loadReplayEvidence}=await import('../src/replay-horizon.js');
  const row=(await db.query(`SELECT * FROM commands WHERE id=$1`,[dialId])).rows[0];
  const ack=await app.inject({method:'POST',url:`/api/v1/gateway/commands/${dialId}/ack`,headers:auth(f.deviceToken),payload:{generation:f.deviceEpoch,status:'rejected',result:{phase:'not_executed',reason:'command_expired'},replayEvidence:{sequence:Number(row.sequence),fingerprint:commandReplayFingerprint(row,f.gatewayId)}}});
  assert.equal(ack.statusCode,200,ack.body);
  assert.equal((await db.query(`SELECT state FROM call_records WHERE id=$1`,[callId])).rows[0].state,'ended');
  // The test app has no media bridge, so the close is parked as a job; a real close completes it.
  await db.query(`DELETE FROM media_close_jobs WHERE call_id=$1`,[callId]);
  const client=await db.connect();
  try{
    const evidence=await loadReplayEvidence(client,f.gatewayId,f.deviceEpoch,Number(row.sequence),1);
    assert.equal(evidence[0].id,dialId);assert.equal(evidence[0].ackDisposition,'not_executed');assert.equal(evidence[0].safe,true);
  }finally{client.release();}
});

test('ending an outgoing call whose dial was delivered keeps the hangup path unchanged',async()=>{
  const f=await gatewayFixture(user1,'dial-delivered-then-end'),token=await login('one@example.test','correct horse battery staple');
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{simId:f.simId,remoteNumber:'+15556091'}});assert.equal(started.statusCode,202,started.body);
  const callId=started.json().call.id as string,dialId=started.json().command.id as string;
  const hb=await app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.deviceToken),payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:false,mediaReady:true}}});
  assert.equal(hb.statusCode,200,hb.body);assert.equal(hb.json().commands.find((c:any)=>c.id===dialId)?.reconciliationOnly,false);
  assert.ok((await db.query(`SELECT delivered_at FROM commands WHERE id=$1`,[dialId])).rows[0].delivered_at);
  const ended=await app.inject({method:'POST',url:`/api/v1/calls/${callId}/end`,headers:auth(token),payload:{onlyIfCurrentSessionOwner:true}});
  assert.equal(ended.statusCode,202,ended.body);assert.equal(ended.json().call.state,'ending');
  assert.deepEqual((await db.query(`SELECT kind,status FROM commands WHERE id=$1`,[ended.json().command.id])).rows[0],{kind:'hangup',status:'pending'});
  assert.equal((await db.query(`SELECT status,expires_at>now() live FROM commands WHERE id=$1`,[dialId])).rows[0].live,true);
  assert.equal((await db.query(`SELECT 1 FROM gateway_call_locks WHERE call_id=$1`,[callId])).rowCount,1);
  await db.query(`DELETE FROM media_close_jobs WHERE call_id=$1`,[callId]);
});
