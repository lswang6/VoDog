import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const baseConfig={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'doorbell-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
  AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'doorbell-media-secret-at-least-32-characters',
  TURN_SECRET:'doorbell-turn-secret-at-least-32-characters',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,
  TRANSCRIPTION_SCAN_BATCH:2,COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};

let db:Db;
let closedApp:FastifyInstance,openApp:FastifyInstance,cappedApp:FastifyInstance;
let userId:string,userToken:string;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const heartbeatPayload={controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}};

type Fixture={gatewayId:string;simId:string;deviceEpoch:number;deviceToken:string};
async function gatewayFixture(label:string):Promise<Fixture>{
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id`,[gateway.id,userId,`${label} SIM`,tokenHash(`${label}-sim-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const deviceToken=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[gateway.id,tokenHash(deviceToken),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),0,0,false,'[]',now())`,[gateway.id,gateway.device_epoch]);
  return {gatewayId:gateway.id,simId:sim.id,deviceEpoch:Number(gateway.device_epoch),deviceToken};
}
async function dial(app:FastifyInstance,fixture:Fixture,label:string){
  const started=await app.inject({method:'POST',url:'/api/v1/calls/outbound',headers:{...auth(userToken),'idempotency-key':`${label}-dial`},payload:{simId:fixture.simId,remoteNumber:'+15557000'}});
  assert.equal(started.statusCode,202,started.body);
  return started.json().call.id as string;
}
const doorbell=(app:FastifyInstance,fixture:Fixture,holdMs:number)=>
  app.inject({method:'POST',url:'/api/v1/gateway/commands/doorbell',headers:auth(fixture.deviceToken),payload:{holdMs}});
const sleep=(ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms);});

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  userId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('doorbell@example.test',$1)RETURNING id`,[await hashPassword('correct horse battery staple')])).rows[0].id;
  closedApp=await buildApp(db,baseConfig as never);
  openApp=await buildApp(db,{...baseConfig,GATEWAY_COMMAND_DOORBELL_MAX_MS:4000} as never);
  cappedApp=await buildApp(db,{...baseConfig,GATEWAY_COMMAND_DOORBELL_MAX_MS:200} as never);
  const login=await closedApp.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'doorbell@example.test',password:'correct horse battery staple',platform:'android'}});
  assert.equal(login.statusCode,200,login.body);
  userToken=login.json().token;
});
after(async()=>{await Promise.all([closedApp.close(),openApp.close(),cappedApp.close()]);await db.end();});

test('config rejects an out-of-range doorbell ceiling and defaults to disabled',async()=>{
  const env={DATABASE_URL:'postgres://localhost:5432/x',COOKIE_SECRET:'a'.repeat(32)};
  assert.equal(loadConfig(env as never).GATEWAY_COMMAND_DOORBELL_MAX_MS,0);
  assert.equal(loadConfig({...env,GATEWAY_COMMAND_DOORBELL_MAX_MS:'8000'} as never).GATEWAY_COMMAND_DOORBELL_MAX_MS,8000);
  for(const invalid of ['8001','-1','1.5','abc'])
    assert.throws(()=>loadConfig({...env,GATEWAY_COMMAND_DOORBELL_MAX_MS:invalid} as never),`${invalid} must be rejected`);
});

test('a disabled doorbell answers immediately, advertises maxHoldMs 0, and never registers a waiter',async()=>{
  const fixture=await gatewayFixture('doorbell-closed');
  const heartbeat=await closedApp.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:heartbeatPayload});
  assert.equal(heartbeat.statusCode,200,heartbeat.body);
  assert.deepEqual(heartbeat.json().commandDoorbell,{maxHoldMs:0});
  const startedAt=Date.now();
  const response=await doorbell(closedApp,fixture,8000);
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json(),{wake:false,heldMs:0});
  assert.ok(Date.now()-startedAt<1000,'a disabled doorbell must not hold the request');
  assert.equal(closedApp.commandDoorbell.waiterCount(),0);
});

test('an enabled doorbell advertises its ceiling and requires the gateway device principal',async()=>{
  const fixture=await gatewayFixture('doorbell-auth');
  const heartbeat=await openApp.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(fixture.deviceToken),payload:heartbeatPayload});
  assert.equal(heartbeat.statusCode,200,heartbeat.body);
  assert.deepEqual(heartbeat.json().commandDoorbell,{maxHoldMs:4000});
  const anonymous=await openApp.inject({method:'POST',url:'/api/v1/gateway/commands/doorbell',payload:{holdMs:10}});
  assert.equal(anonymous.statusCode,401,anonymous.body);
  assert.equal(anonymous.json().error.code,'DEVICE_UNAUTHENTICATED');
  const asUser=await openApp.inject({method:'POST',url:'/api/v1/gateway/commands/doorbell',headers:auth(userToken),payload:{holdMs:10}});
  assert.equal(asUser.statusCode,401,asUser.body);
  for(const holdMs of [-1,8001,'100']){
    const invalid=await openApp.inject({method:'POST',url:'/api/v1/gateway/commands/doorbell',headers:auth(fixture.deviceToken),payload:{holdMs}});
    assert.equal(invalid.statusCode,400,invalid.body);
    assert.equal(invalid.json().error.code,'INVALID_REQUEST');
  }
  assert.equal(openApp.commandDoorbell.waiterCount(),0);
});

test('a command already waiting for delivery wakes the doorbell without holding the request',async()=>{
  const fixture=await gatewayFixture('doorbell-pending');
  await dial(openApp,fixture,'doorbell-pending');
  const response=await doorbell(openApp,fixture,4000);
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json(),{wake:true,heldMs:0});
  assert.equal(openApp.commandDoorbell.waiterCount(),0);
  // An expired command is heartbeat reconciliation material only and must not ring the doorbell.
  await db.query(`UPDATE commands SET expires_at=now()-interval '5 seconds' WHERE gateway_id=$1`,[fixture.gatewayId]);
  const stale=await doorbell(openApp,fixture,50);
  assert.equal(stale.json().wake,false);
});

test('a dial inserted while the doorbell waits wakes it within tens of milliseconds',async()=>{
  const fixture=await gatewayFixture('doorbell-wake');
  const pending=doorbell(openApp,fixture,4000);
  await sleep(50);
  assert.equal(openApp.commandDoorbell.waiterCount(fixture.gatewayId),1);
  await dial(openApp,fixture,'doorbell-wake');
  const response=await pending;
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().wake,true);
  assert.ok(response.json().heldMs<1000,`woken by the insert, not the timeout: ${response.json().heldMs}ms`);
  assert.equal(openApp.commandDoorbell.waiterCount(),0);
  let rows=0;for(let i=0;i<40&&!rows;i++){rows=(await db.query(`SELECT 1 FROM diag_events WHERE event='gateway.doorbell' AND fields->>'gatewayId'=$1 AND (fields->>'wake')::boolean`,[fixture.gatewayId])).rowCount??0;if(!rows)await sleep(50);}
  assert.equal(rows,1,'a wake files one gateway.doorbell row');
});

test('an idle doorbell times out at the requested hold and clamps to the server ceiling',async()=>{
  const fixture=await gatewayFixture('doorbell-timeout');
  const response=await doorbell(openApp,fixture,300);
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().wake,false);
  assert.ok(response.json().heldMs>=280&&response.json().heldMs<2000,`held about 300ms, got ${response.json().heldMs}ms`);
  const capped=await doorbell(cappedApp,fixture,8000);
  assert.equal(capped.json().wake,false);
  assert.ok(capped.json().heldMs>=180&&capped.json().heldMs<2000,`clamped to the 200ms ceiling, got ${capped.json().heldMs}ms`);
  await sleep(200);
  assert.equal((await db.query(`SELECT 1 FROM diag_events WHERE event='gateway.doorbell' AND fields->>'gatewayId'=$1`,[fixture.gatewayId])).rowCount,0,'an empty poll that timed out files nothing');
  assert.equal(openApp.commandDoorbell.waiterCount(),0);
  assert.equal(cappedApp.commandDoorbell.waiterCount(),0);
});

test('the waiter table keeps at most one suspended request per gateway',async()=>{
  const fixture=await gatewayFixture('doorbell-bounded');
  const first=doorbell(openApp,fixture,4000);
  await sleep(50);
  assert.equal(openApp.commandDoorbell.waiterCount(fixture.gatewayId),1);
  const second=doorbell(openApp,fixture,300);
  const firstResponse=await first;
  assert.equal(firstResponse.json().wake,false,'the older waiter is ended when a newer request arrives');
  assert.ok(firstResponse.json().heldMs<1000);
  assert.equal(openApp.commandDoorbell.waiterCount(fixture.gatewayId),1);
  assert.equal((await second).json().wake,false);
  assert.equal(openApp.commandDoorbell.waiterCount(),0);
});

test('an aborted doorbell request releases its listener and timer',async()=>{
  const fixture=await gatewayFixture('doorbell-abort');
  // light-my-request has no socket, so only a real listener can be aborted mid-hold.
  // The server stays up until after(); openApp.close() shuts it down.
  await openApp.listen({port:0,host:'127.0.0.1'});
  {
    const address=openApp.server.address();
    assert.ok(address&&typeof address!=='string','the doorbell test server must bind a port');
    const body=JSON.stringify({holdMs:4000});
    const aborted=new Promise<void>(resolve=>{
      const req=httpRequest({host:'127.0.0.1',port:address.port,method:'POST',path:'/api/v1/gateway/commands/doorbell',
        headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),authorization:`Bearer ${fixture.deviceToken}`}},()=>{});
      req.on('error',()=>{});
      req.end(body);
      setTimeout(()=>{req.destroy();resolve();},150);
    });
    await aborted;
    for(let attempt=0;attempt<50&&openApp.commandDoorbell.waiterCount(fixture.gatewayId)!==0;attempt++)await sleep(20);
    assert.equal(openApp.commandDoorbell.waiterCount(fixture.gatewayId),0,'an aborted request must not leave a waiter behind');
    // The abandoned waiter also stops blocking later requests for the same gateway.
    const after=await doorbell(openApp,fixture,50);
    assert.equal(after.json().wake,false);
  }
});
