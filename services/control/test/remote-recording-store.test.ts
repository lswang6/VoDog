import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,createHmac} from 'node:crypto';
import {RemoteRecordingStore,RecordingStoreError} from '../src/recording-store.js';

test('remote recording source authenticates fixed Range reads and validates immutable metadata',async()=>{
  const secret='remote-recording-test-secret-at-least-32-bytes',id='11111111-1111-1111-1111-111111111111',bytes=Buffer.from('remote-audio-bytes'),sha=createHash('sha256').update(bytes).digest('hex');let corrupt=false;
  const manifest={version:1,callId:id,nodeId:'relay-secondary',mediaEpoch:1,finalizedAt:new Date().toISOString(),complete:true,artifacts:[{name:'remote_original.ogg',bytes:bytes.length,sha256:sha},{name:'caller_original.ogg',bytes:bytes.length,sha256:sha},{name:'timeline.jsonl',bytes:1,sha256:'0'.repeat(64)}]};
  const server=createServer((req,res)=>{
    const timestamp=req.headers['x-cc-timestamp'] as string,nonce=req.headers['x-cc-nonce'] as string,range=(req.headers.range??'') as string,signature=req.headers['x-cc-signature'];
    const expected=createHmac('sha256',secret).update(`GET\n${req.url}\n${timestamp}\n${nonce}\n${range}`).digest('base64url');assert.equal(signature,expected);assert.ok(Math.abs(Number(timestamp)-Date.now()/1000)<31);
    if(req.url?.endsWith('/manifest')){const body=Buffer.from(JSON.stringify(manifest));res.writeHead(200,{'content-type':'application/json','content-length':body.length});res.end(body);return;}
    if(req.url?.endsWith('/tracks/remote_original')){assert.equal(range,'bytes=2-7');const body=bytes.subarray(2,8);res.writeHead(206,{'content-type':'audio/ogg','content-length':body.length,'content-range':`bytes 2-7/${bytes.length}`,etag:`"${corrupt?'f'.repeat(64):sha}"`});res.end(body);return;}
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const address=server.address();if(!address||typeof address==='string')throw new Error('server');
  try{const store=new RemoteRecordingStore(`http://127.0.0.1:${address.port}`,secret,'relay-secondary',1);const opened=await store.openTrack(id,'remote_original','bytes=2-7');const chunks=[];for await(const chunk of opened.stream)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes.subarray(2,8));corrupt=true;await assert.rejects(()=>store.openTrack(id,'remote_original','bytes=2-7'),(error:unknown)=>error instanceof RecordingStoreError&&error.code==='RECORDING_CORRUPT');}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('remote recording bounds a manifest without Content-Length and cancels rejected tracks',async()=>{
  const secret='remote-recording-cancel-secret-at-least-32-bytes',id='22222222-2222-2222-2222-222222222222',sha='a'.repeat(64);let oversized=true,trackClosedResolve!:()=>void;const trackClosed=new Promise<void>(resolve=>trackClosedResolve=resolve);
  const manifest={version:1,callId:id,nodeId:'relay-secondary',mediaEpoch:1,finalizedAt:new Date().toISOString(),complete:true,artifacts:[{name:'remote_original.ogg',bytes:10,sha256:sha},{name:'caller_original.ogg',bytes:10,sha256:sha},{name:'timeline.jsonl',bytes:1,sha256:'0'.repeat(64)}]};
  const server=createServer((req,res)=>{
    if(req.url?.endsWith('/manifest')){res.writeHead(200,{'content-type':'application/json'});if(oversized){res.write(Buffer.alloc(70_000,120));res.end();}else res.end(JSON.stringify(manifest));return;}
    if(req.url?.endsWith('/tracks/remote_original')){res.on('close',trackClosedResolve);res.writeHead(503,{'content-type':'text/plain'});res.write('rejected');const timer=setInterval(()=>res.write('x'),10);res.on('close',()=>clearInterval(timer));return;}
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const address=server.address();if(!address||typeof address==='string')throw new Error('server');const store=new RemoteRecordingStore(`http://127.0.0.1:${address.port}`,secret,'relay-secondary',1);
  try{await assert.rejects(()=>store.manifest(id),(error:unknown)=>error instanceof RecordingStoreError&&error.code==='RECORDING_CORRUPT');oversized=false;await assert.rejects(()=>store.openTrack(id,'remote_original','bytes=0-9'),(error:unknown)=>error instanceof RecordingStoreError&&error.code==='RECORDING_UNAVAILABLE');await Promise.race([trackClosed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('rejected response body was not cancelled')),1000))]);}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
