import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import {createDb} from '../src/db.js';
import {tokenHash} from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');

test('buildApp fixes a call only after current session and gateway-epoch probes agree',async()=>{
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
  const app=await buildApp(db,{DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-primary',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2});
  const userHeaders={authorization:`Bearer ${access}`},gatewayHeaders={authorization:`Bearer ${device}`};
  try{
    const gatewayEarly=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/media/options`,headers:gatewayHeaders});assert.equal(gatewayEarly.statusCode,409,gatewayEarly.body);assert.equal(gatewayEarly.json().error.code,'MEDIA_NODE_PENDING');
    const userEarly=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:userHeaders,payload:{networkGeneration:'wifi:1'}});assert.equal(userEarly.statusCode,409,userEarly.body);assert.equal(userEarly.json().error.code,'MEDIA_PROBE_REQUIRED');
    await app.inject({method:'POST',url:'/api/v1/media/probes/options',headers:userHeaders,payload:{networkGeneration:'wifi:1'}});
    await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:userHeaders,payload:{networkGeneration:'wifi:1',samples:[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:180},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:190},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:50},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:60}]}});
    await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/options',headers:gatewayHeaders,payload:{networkGeneration:'cell:1'}});
    await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/results',headers:gatewayHeaders,payload:{networkGeneration:'cell:1',samples:[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:120},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:130},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:80},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:90}]}});
    await db.query(`UPDATE gateways SET device_epoch=device_epoch+1 WHERE id=$1`,[gateway.id]);
    const oldEpoch=await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/results',headers:gatewayHeaders,payload:{networkGeneration:'cell:1',samples:[{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:1}]}});assert.equal(oldEpoch.statusCode,409,oldEpoch.body);assert.equal(oldEpoch.json().error.code,'PROBE_OPTIONS_REQUIRED');
    await db.query(`UPDATE gateways SET device_epoch=device_epoch-1 WHERE id=$1`,[gateway.id]);
    const selected=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/media/options`,headers:userHeaders,payload:{networkGeneration:'wifi:1'}});assert.equal(selected.statusCode,200,selected.body);assert.equal(selected.json().mediaNodeId,'relay-secondary');assert.match(selected.json().iceServers[0].urls[0],/^turn:relay-secondary\./);
    const fixed=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call.id}/media/options`,headers:gatewayHeaders});assert.equal(fixed.statusCode,200,fixed.body);assert.equal(fixed.json().mediaNodeId,'relay-secondary');
    assert.equal((await db.query(`SELECT media_node_id FROM call_records WHERE id=$1`,[call.id])).rows[0].media_node_id,'relay-secondary');
  }finally{await app.close();await db.end();}
});

test('S72b: a client in relay mode gets the relay node without its own probe; relay off keeps probe selection',async()=>{
  const db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const user=(await db.query(`INSERT INTO users(email,password_hash)VALUES('relay-owner@example.test','unused-test-password-hash')RETURNING id`)).rows[0].id;
  const access='relay-user-access-token-with-entropy';
  const session=(await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at)VALUES($1,$2,'native','android',now()+interval '1 hour')RETURNING id`,[user,tokenHash(access)])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,media_ready,last_seen_at)VALUES('relay-gateway',true,true,now())RETURNING id,device_epoch`)).rows[0];
  const device='relay-device-token-with-sufficient-entropy';await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'relay')`,[gateway.id,tokenHash(device)]);
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,'relay SIM',true)RETURNING id`,[gateway.id,user])).rows[0].id;
  const newCall=async()=>(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,originating_session_id,originating_platform)VALUES($1,$2,$3,'outgoing','connecting',$4,'normal',$5,'android')RETURNING id`,[gateway.id,sim,user,gateway.device_epoch,session])).rows[0].id as string;
  const nodes=JSON.stringify([
    {id:'relay-primary',controlBaseUrl:'http://127.0.0.1:16881',probeUrl:'https://relay-primary-media.example/probe',turnUdpUrl:'turn:relay-primary.example:3478?transport=udp',turnTlsUrl:'turns:relay-primary.example:5349?transport=tcp',mediaSecret:'relay-primary-media-secret-at-least-32-characters',turnSecret:'relay-primary-turn-secret-at-least-32-characters'},
    {id:'relay-secondary',controlBaseUrl:'http://127.0.0.1:16882',probeUrl:'https://relay-secondary-media.example/probe',turnUdpUrl:'turn:relay-secondary.example:3478?transport=udp',turnTlsUrl:'turns:relay-secondary.example:5349?transport=tcp',mediaSecret:'secondary-media-secret-at-least-32-characters',turnSecret:'secondary-turn-secret-at-least-32-characters'},
  ]);
  const app=await buildApp(db,{DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-primary',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
    MEDIA_RELAY_TURN_TLS_URL:'turns:203.0.113.20:16803?transport=tcp',MEDIA_RELAY_TURN_HOSTNAME:'vodog.example.com',MEDIA_RELAY_NODE_ID:'relay-primary'} as never);
  const userHeaders={authorization:`Bearer ${access}`},gatewayHeaders={authorization:`Bearer ${device}`};
  const opts=(id:string,payload:object)=>app.inject({method:'POST',url:`/api/v1/calls/${id}/media/options`,headers:userHeaders,payload});
  try{
    // 4G: the client's direct probe to relay-primary failed; gz is reachable by both ends.
    await app.inject({method:'POST',url:'/api/v1/media/probes/options',headers:userHeaders,payload:{networkGeneration:'cell:9'}});
    await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:userHeaders,payload:{networkGeneration:'cell:9',samples:[{nodeId:'relay-primary',outcome:'timeout'},{nodeId:'relay-primary',outcome:'timeout'},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:50},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:60}]}});
    await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/options',headers:gatewayHeaders,payload:{networkGeneration:'cell:1'}});
    await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/results',headers:gatewayHeaders,payload:{networkGeneration:'cell:1',samples:[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:120},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:130},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:80},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:90}]}});
    const relayed=await newCall();
    const r=await opts(relayed,{transport:'tls',relay:true});assert.equal(r.statusCode,200,r.body);
    assert.equal(r.json().mediaNodeId,'relay-primary');assert.equal(r.json().relay,true);
    assert.deepEqual(r.json().iceServers[0].urls,['turns:203.0.113.20:16803?transport=tcp']);assert.equal(r.json().iceServers[0].hostname,'vodog.example.com');
    // relay over udp, or relay:false, is today's probe selection.
    for(const payload of [{transport:'udp',relay:true,networkGeneration:'cell:9'},{transport:'tls',relay:false,networkGeneration:'cell:9'},{transport:'tls',networkGeneration:'cell:9'}]){
      const id=await newCall();const plain=await opts(id,payload);assert.equal(plain.statusCode,200,plain.body);
      assert.equal(plain.json().mediaNodeId,'relay-secondary',JSON.stringify(payload));assert.equal(plain.json().relay,'relay' in payload?false:undefined);
    }
    // Relay with an explicit other node keeps the probe path (and its requirement).
    const other=await opts(await newCall(),{transport:'tls',relay:true,nodeId:'relay-secondary'});assert.equal(other.statusCode,409,other.body);assert.equal(other.json().error.code,'MEDIA_PROBE_REQUIRED');
  }finally{await app.close();await db.end();}
});

test('S73b: MEDIA_PREFERRED_NODE_ID wins unless either end sees it failing; relay clients follow it and relay reflects the ICE returned',async()=>{
  const db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const user=(await db.query(`INSERT INTO users(email,password_hash)VALUES('pref-owner@example.test','unused-test-password-hash')RETURNING id`)).rows[0].id;
  const access='pref-user-access-token-with-entropy';
  const session=(await db.query(`INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at)VALUES($1,$2,'native','android',now()+interval '1 hour')RETURNING id`,[user,tokenHash(access)])).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,media_ready,last_seen_at)VALUES('pref-gateway',true,true,now())RETURNING id,device_epoch`)).rows[0];
  const device='pref-device-token-with-sufficient-entropy';await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'pref')`,[gateway.id,tokenHash(device)]);
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,'pref SIM',true)RETURNING id`,[gateway.id,user])).rows[0].id;
  const newCall=async()=>(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,originating_session_id,originating_platform)VALUES($1,$2,$3,'outgoing','connecting',$4,'normal',$5,'android')RETURNING id`,[gateway.id,sim,user,gateway.device_epoch,session])).rows[0].id as string;
  // S73f: gz answers offers so the media.offer diag row (nodeReason) can be read.
  const secondaryNode=createServer((req,res)=>{if(req.url==='/offer'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({type:'answer',sdp:'v=0\r\n'}));return;}res.writeHead(404).end();});
  await new Promise<void>(resolve=>secondaryNode.listen(0,'127.0.0.1',resolve));const secondaryPort=(secondaryNode.address() as {port:number}).port;
  const nodes=JSON.stringify([
    {id:'relay-primary',controlBaseUrl:'http://127.0.0.1:16881',probeUrl:'https://relay-primary-media.example/probe',turnUdpUrl:'turn:relay-primary.example:3478?transport=udp',turnTlsUrl:'turns:relay-primary.example:5349?transport=tcp',mediaSecret:'relay-primary-media-secret-at-least-32-characters',turnSecret:'relay-primary-turn-secret-at-least-32-characters'},
    {id:'relay-secondary',controlBaseUrl:`http://127.0.0.1:${secondaryPort}`,probeUrl:'https://relay-secondary-media.example/probe',turnUdpUrl:'turn:relay-secondary.example:3478?transport=udp',turnTlsUrl:'turns:relay-secondary.example:5349?transport=tcp',mediaSecret:'secondary-media-secret-at-least-32-characters',turnSecret:'secondary-turn-secret-at-least-32-characters'},
  ]);
  const app=await buildApp(db,{DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_NODES_JSON:nodes,MEDIA_DEFAULT_NODE_ID:'relay-primary',TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
    MEDIA_RELAY_TURN_TLS_URL:'turns:203.0.113.20:16803?transport=tcp',MEDIA_RELAY_TURN_HOSTNAME:'vodog.example.com',MEDIA_RELAY_NODE_ID:'relay-primary',MEDIA_PREFERRED_NODE_ID:'relay-secondary'} as never);
  const userHeaders={authorization:`Bearer ${access}`},gatewayHeaders={authorization:`Bearer ${device}`};
  const opts=async(payload:object)=>{const r=await app.inject({method:'POST',url:`/api/v1/calls/${await newCall()}/media/options`,headers:userHeaders,payload});assert.equal(r.statusCode,200,r.body);return r.json();};
  const clientProbe=async(generation:string,samples:object[])=>{
    await app.inject({method:'POST',url:'/api/v1/media/probes/options',headers:userHeaders,payload:{networkGeneration:generation}});
    const r=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:userHeaders,payload:{networkGeneration:generation,samples}});assert.equal(r.statusCode,200,r.body);};
  const gatewayProbe=async(samples:object[])=>{const r=await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/results',headers:gatewayHeaders,payload:{networkGeneration:'cell:1',samples}});assert.equal(r.statusCode,200,r.body);};
  const ok=(nodeId:string,ms:number)=>({nodeId,outcome:'ok',httpsRttMs:ms}),bad=(nodeId:string)=>({nodeId,outcome:'timeout'});
  const relayIce=(j:any)=>{assert.equal(j.relay,true);assert.deepEqual(j.iceServers[0].urls,['turns:203.0.113.20:16803?transport=tcp']);assert.equal(j.iceServers[0].hostname,'vodog.example.com');};
  const secondaryIce=(j:any,tls:boolean)=>{assert.deepEqual(j.iceServers[0].urls,[tls?'turns:relay-secondary.example:5349?transport=tcp':'turn:relay-secondary.example:3478?transport=udp']);assert.equal('hostname' in j.iceServers[0],false);};
  try{
    // No gateway evidence and no client evidence: nothing failed, so the preferred node (a relay client without a generation too).
    const bare=await opts({networkGeneration:'wifi:0'});assert.equal(bare.mediaNodeId,'relay-secondary');assert.equal('relay' in bare,false);secondaryIce(bare,false);
    const bareRelay=await opts({transport:'tls',relay:true});assert.equal(bareRelay.mediaNodeId,'relay-secondary');assert.equal(bareRelay.relay,false);secondaryIce(bareRelay,true);
    await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/options',headers:gatewayHeaders,payload:{networkGeneration:'cell:1'}});
    await gatewayProbe([ok('relay-primary',120),ok('relay-primary',130),ok('relay-secondary',80),ok('relay-secondary',90)]);
    // RTT ranking would pick relay-primary; the preferred node still wins while both ends reach it.
    await clientProbe('wifi:a',[ok('relay-primary',20),ok('relay-primary',25),ok('relay-secondary',150),ok('relay-secondary',160)]);
    const preferred=await opts({networkGeneration:'wifi:a'});assert.equal(preferred.mediaNodeId,'relay-secondary');secondaryIce(preferred,false);
    const relayOnPreferred=await opts({transport:'tls',relay:true,networkGeneration:'wifi:a'});assert.equal(relayOnPreferred.mediaNodeId,'relay-secondary');assert.equal(relayOnPreferred.relay,false);secondaryIce(relayOnPreferred,true);
    // S73f: the winner went offline before its own options; the gateway fixes the preferred node instead of MEDIA_NODE_PENDING,
    // and the client (relay or not) later takes the fixed branch with the gateway's reason on its media.offer row.
    const gatewayPost=(call:string,payload?:object)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${call}/media/options`,headers:gatewayHeaders,...(payload?{payload}:{})});
    const early=await newCall();const gFirst=await gatewayPost(early);assert.equal(gFirst.statusCode,200,gFirst.body);assert.equal(gFirst.json().mediaNodeId,'relay-secondary');
    assert.equal((await db.query(`SELECT media_node_id FROM call_records WHERE id=$1`,[early])).rows[0].media_node_id,'relay-secondary');
    const late=await app.inject({method:'POST',url:`/api/v1/calls/${early}/media/options`,headers:userHeaders,payload:{transport:'tls',relay:true}});assert.equal(late.statusCode,200,late.body);assert.equal(late.json().mediaNodeId,'relay-secondary');assert.equal(late.json().relay,false);secondaryIce(late.json(),true);
    const lateOffer=await app.inject({method:'POST',url:`/api/v1/calls/${early}/media/offer`,headers:userHeaders,payload:{type:'offer',sdp:'v=0\r\n'}});assert.equal(lateOffer.statusCode,200,lateOffer.body);
    let offerRow;for(let i=0;i<40&&!offerRow;i++){offerRow=(await db.query(`SELECT fields FROM diag_events WHERE event='media.offer' AND call_id=$1`,[early])).rows[0];if(!offerRow)await new Promise(r=>setTimeout(r,25));}
    assert.equal(offerRow?.fields.nodeReason,'gateway_preferred');assert.deepEqual(offerRow?.fields.candidates,['relay-secondary']);
    // A gateway asking for another node, or a ringing call (AI commit pins its own node), keeps the 409.
    const askedOther=await gatewayPost(await newCall(),{nodeId:'relay-primary'});assert.equal(askedOther.statusCode,409,askedOther.body);assert.equal(askedOther.json().error.code,'MEDIA_NODE_PENDING');
    const ringing=await newCall();await db.query(`UPDATE call_records SET direction='incoming',state='incoming_ringing',originating_session_id=NULL WHERE id=$1`,[ringing]);
    const gRinging=await gatewayPost(ringing);assert.equal(gRinging.statusCode,409,gRinging.body);assert.equal(gRinging.json().error.code,'MEDIA_NODE_PENDING');
    // A client explicitly asking for another node keeps probe selection (relay-primary wins on RTT here).
    const asked=await opts({networkGeneration:'wifi:a',nodeId:'relay-primary'});assert.equal(asked.mediaNodeId,'relay-primary');
    // Client evidence without samples for the preferred node is not a failure.
    await clientProbe('wifi:c',[ok('relay-primary',20),ok('relay-primary',25)]);
    assert.equal((await opts({networkGeneration:'wifi:c'})).mediaNodeId,'relay-secondary');
    // The client sees the preferred node failing: existing selection (relay-primary); a relay client landing on relay-primary gets relay ICE.
    await clientProbe('wifi:b',[ok('relay-primary',20),ok('relay-primary',25),bad('relay-secondary'),bad('relay-secondary'),bad('relay-secondary')]);
    assert.equal((await opts({networkGeneration:'wifi:b'})).mediaNodeId,'relay-primary');
    // S73f: the winner's latest evidence shows the preferred node failing: the gateway still waits for the client.
    const userFails=await gatewayPost(await newCall());assert.equal(userFails.statusCode,409,userFails.body);assert.equal(userFails.json().error.code,'MEDIA_NODE_PENDING');
    const relayOnPrimary=await opts({transport:'tls',relay:true,networkGeneration:'wifi:b'});assert.equal(relayOnPrimary.mediaNodeId,'relay-primary');relayIce(relayOnPrimary);
    // The gateway sees the preferred node failing: existing selection even though the client reaches it.
    await gatewayProbe([bad('relay-secondary'),bad('relay-secondary'),bad('relay-secondary')]);
    await clientProbe('wifi:a',[ok('relay-primary',200),ok('relay-primary',210),ok('relay-secondary',20),ok('relay-secondary',25)]);
    assert.equal((await opts({networkGeneration:'wifi:a'})).mediaNodeId,'relay-primary');
    // S73f: the gateway's own evidence shows the preferred node failing: 409 as before.
    const gatewayFails=await gatewayPost(await newCall());assert.equal(gatewayFails.statusCode,409,gatewayFails.body);assert.equal(gatewayFails.json().error.code,'MEDIA_NODE_PENDING');
    // A relay client with no usable evidence falls back to the relay node when the gateway cannot reach the preferred one.
    const relayNoProbe=await opts({transport:'tls',relay:true});assert.equal(relayNoProbe.mediaNodeId,'relay-primary');relayIce(relayNoProbe);
    // The fixed node's gateway leg follows the same relay semantics.
    const call=await newCall();await app.inject({method:'POST',url:`/api/v1/calls/${call}/media/options`,headers:userHeaders,payload:{networkGeneration:'wifi:a'}});
    const g=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${call}/media/options`,headers:gatewayHeaders,payload:{transport:'tls',relay:true}});assert.equal(g.statusCode,200,g.body);assert.equal(g.json().mediaNodeId,'relay-primary');relayIce(g.json());
  }finally{await app.close();await db.end();secondaryNode.close();}
});
