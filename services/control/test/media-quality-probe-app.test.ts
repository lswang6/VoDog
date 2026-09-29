import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import {createDb} from '../src/db.js';
import {tokenHash} from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');

test('quality routes require current HTTPS generation and exact session or gateway epoch',async()=>{
  const db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const user=(await db.query(`INSERT INTO users(email,password_hash)VALUES('probe-owner@example.test','unused-test-password-hash')RETURNING id`)).rows[0].id;
  const access='probe-user-access-token-with-entropy';
  const session=(await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at)VALUES($1,$2,'native','android',now()+interval '1 hour')RETURNING id`,[user,tokenHash(access)])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,media_ready,last_seen_at)VALUES('probe-gateway',true,true,now())RETURNING id,device_epoch`)).rows[0];
  const device='probe-device-token-with-sufficient-entropy';await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'probe')`,[gateway.id,tokenHash(device)]);
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,'probe SIM',true)RETURNING id`,[gateway.id,user])).rows[0].id;
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,originating_session_id,originating_platform)VALUES($1,$2,$3,'outgoing','connecting',$4,'normal',$5,'android')RETURNING id`,[gateway.id,sim,user,gateway.device_epoch,session])).rows[0];
  const nodes=JSON.stringify([
    {id:'relay-primary',controlBaseUrl:'http://127.0.0.1:16881',probeUrl:'https://relay-primary-media.example/probe',turnUdpUrl:'turn:relay-primary.example:3478?transport=udp',turnTlsUrl:'turns:relay-primary.example:5349?transport=tcp',mediaSecret:'relay-primary-media-secret-at-least-32-characters',turnSecret:'relay-primary-turn-secret-at-least-32-characters'},
    {id:'relay-secondary',controlBaseUrl:'http://127.0.0.1:16882',probeUrl:'https://relay-secondary-media.example/probe',turnUdpUrl:'turn:relay-secondary.example:3478?transport=udp',turnTlsUrl:'turns:relay-secondary.example:5349?transport=tcp',mediaSecret:'secondary-media-secret-at-least-32-characters',turnSecret:'secondary-turn-secret-at-least-32-characters'},
  ]);
  const app=await buildApp(db,{DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_QUALITY_PROBES_ENABLED:true,TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2});
  const userHeaders={authorization:`Bearer ${access}`},gatewayHeaders={authorization:`Bearer ${device}`};
  try{
    const opts='/api/v1/media/quality-probes/options',gopts='/api/v1/gateway/media/quality-probes/options';
    const req=(url:string,headers:Record<string,string>,networkGeneration:string)=>app.inject({method:'POST',url,headers,payload:{networkGeneration}});
    assert.equal((await req(opts,{},'wifi:1')).statusCode,401);
    assert.equal((await req(gopts,userHeaders,'wifi:1')).statusCode,401);
    assert.equal((await req(opts,userHeaders,'wifi:1')).statusCode,409);
    await req('/api/v1/media/probes/options',userHeaders,'wifi:1');
    const granted=await req(opts,userHeaders,'wifi:1');assert.equal(granted.statusCode,200,granted.body);
    const claim=JSON.parse(Buffer.from(granted.json().nodes[0].grant.split('.')[0],'base64url').toString());assert.equal(claim.role,'client');assert.equal(claim.callId,undefined);
    await req('/api/v1/media/probes/options',userHeaders,'wifi:2');
    assert.equal((await req(opts,userHeaders,'wifi:1')).statusCode,409);
    assert.equal((await req(opts,userHeaders,'wifi:2')).statusCode,200);
    await req('/api/v1/gateway/media/probes/options',gatewayHeaders,'cell:99');
    assert.equal((await req(gopts,gatewayHeaders,'cell:99')).statusCode,200);
    await db.query(`UPDATE gateways SET device_epoch=device_epoch+1 WHERE id=$1`,[gateway.id]);
    assert.equal((await req(gopts,gatewayHeaders,'cell:99')).statusCode,409);
    const otherAccess='quality-other-session-access';await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at)VALUES($1,$2,'native','ios',now()+interval '1 hour')`,[user,tokenHash(otherAccess)]);
    assert.equal((await req(opts,{authorization:`Bearer ${otherAccess}`},'wifi:2')).statusCode,409);
    await db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`,[session]);
    assert.equal((await req(opts,userHeaders,'wifi:2')).statusCode,401);
    assert.equal((await db.query('SELECT count(*) n FROM call_records')).rows[0].n,'1');
  }finally{await app.close();await db.end();}
});
