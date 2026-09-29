import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {MediaBridgeClient,MediaBridgeError} from '../src/media-client.js';
test('bridge uses single-use signed grants and surfaces failure', async()=>{
 const key='x'.repeat(40),turn='t'.repeat(40),id='11111111-1111-1111-1111-111111111111';
 const nonces=new Set<string>();let failure=false;
 const server=createServer(async(req,res)=>{
  if(failure){res.writeHead(409).end();return;}
  const [raw,sig]=req.headers.authorization!.slice(7).split('.');
  assert.equal(sig,createHmac('sha256',key).update(raw).digest('base64url'));
  const grant=JSON.parse(Buffer.from(raw,'base64url').toString());
  assert.equal(grant.callId,id);assert.equal(grant.role,'client');assert.equal(grant.mediaEpoch,3);assert.ok(grant.exp>Date.now()/1000);assert.ok(grant.exp<Date.now()/1000+120);assert.ok(!nonces.has(grant.nonce));nonces.add(grant.nonce);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({type:'answer',sdp:'answer-sdp'}));
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(16881,'127.0.0.1',resolve);});
 try {
  const client=new MediaBridgeClient(key,turn);
  assert.equal((await client.offer(id,'client',{type:'offer',sdp:'test'},3)).sdp,'answer-sdp');
  await client.offer(id,'client',{type:'offer',sdp:'test'},3);assert.equal(nonces.size,2);
  const ice=client.iceServers()[0];assert.equal(ice.credential,createHmac('sha1',turn).update(ice.username).digest('base64'));
  await assert.rejects(()=>client.offer('../escape','client',{type:'offer',sdp:'test'}));
  failure=true;await assert.rejects(()=>client.offer(id,'client',{type:'offer',sdp:'test'}),(e:unknown)=>e instanceof MediaBridgeError&&e.status===409);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
