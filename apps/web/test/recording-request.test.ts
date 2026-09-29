import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingErrorCode,recordingRequest} from '../src/recording-request.ts';

test('recording request bounds stalled headers and aborts transport',async()=>{
 const original=globalThis.fetch;let aborted=false;
 globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'));},{once:true}));
 try{await assert.rejects(recordingRequest('/synthetic',{},new AbortController().signal,async response=>response.json(),20),/超时/);assert.equal(aborted,true);}finally{globalThis.fetch=original;}
});
test('recording errors accept only a bounded structured code and cancel oversized bodies',async()=>{
 assert.equal(await recordingErrorCode(new Response(JSON.stringify({error:{code:'PIXEL_ARCHIVE_DISABLED'}}),{headers:{'Content-Type':'application/json'}})),'PIXEL_ARCHIVE_DISABLED');
 assert.equal(await recordingErrorCode(new Response(JSON.stringify({error:{code:'lowercase'}}))),undefined);
 let cancelled=false;const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(3000));},cancel(){cancelled=true;}});
 assert.equal(await recordingErrorCode(new Response(body),4096),undefined);assert.equal(cancelled,true);
});
test('recording deadline includes body consumption and preserves parent cancellation',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(_url,options)=>new Response(new ReadableStream({start(controller){options!.signal!.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true});}}));
 try{
  await assert.rejects(recordingRequest('/synthetic',{},new AbortController().signal,async response=>response.json(),20),/超时/);
  const parent=new AbortController();const pending=recordingRequest('/synthetic',{},parent.signal,async response=>response.json(),1000);parent.abort();
  await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');
 }finally{globalThis.fetch=original;}
});

const pixelTrack='/api/v1/calls/00000000-0000-4000-8000-000000000900/recordings/remote_original?source=pixel';
const pixelDownload=pixelTrack+'&disposition=attachment';
const verificationOptions={credentials:'include' as const,headers:{Range:'bytes=0-0'}};
const downloadOptions={credentials:'include' as const,cache:'no-store' as const};
const busy=()=>new Response(JSON.stringify({error:{code:'RECORDING_VERIFICATION_BUSY'}}),{status:503,headers:{'Content-Type':'application/json'}});

test('exact Pixel verification busy response recovers within two bounded retries and preserves Range',async()=>{
 const original=globalThis.fetch,calls:RequestInit[]=[];let attempt=0;
 globalThis.fetch=async(_url,options)=>{calls.push(options!);return attempt++<2?busy():new Response(new Uint8Array([0]),{status:206});};
 try{
  assert.equal(await recordingRequest(pixelTrack,verificationOptions,new AbortController().signal,async response=>response.status,1000,[1,1]),206);
  assert.equal(calls.length,3);assert.ok(calls.every(options=>new Headers(options.headers).get('Range')==='bytes=0-0'));
 }finally{globalThis.fetch=original;}
});

test('busy retry cap returns the third response to the original consumer',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return busy();};
 try{
  const code=await recordingRequest(pixelTrack,verificationOptions,new AbortController().signal,recordingErrorCode,1000,[1,1]);
  assert.equal(code,'RECORDING_VERIFICATION_BUSY');assert.equal(calls,3);
 }finally{globalThis.fetch=original;}
});

test('nonbusy 503 and nonverification requests never retry',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{code:'MEDIA_NODE_UNAVAILABLE'}}),{status:503});};
 try{
  assert.equal(await recordingRequest(pixelTrack,verificationOptions,new AbortController().signal,recordingErrorCode,1000,[1,1]),'MEDIA_NODE_UNAVAILABLE');
  assert.equal(await recordingRequest(pixelTrack,{headers:{Range:'bytes=0-1'}},new AbortController().signal,async response=>response.status,1000,[1,1]),503);
  assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});

test('parent abort during busy backoff stops before another fetch',async()=>{
 const original=globalThis.fetch,parent=new AbortController();let calls=0;
 globalThis.fetch=async()=>{calls++;return busy();};
 try{
  const pending=recordingRequest(pixelTrack,verificationOptions,parent.signal,async response=>response.status,1000,[100,100]);
  await new Promise(resolve=>setTimeout(resolve,5));parent.abort();
  await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});

test('pixel attachment downloads retry verification busy without sending Range',async()=>{
 const original=globalThis.fetch,calls:RequestInit[]=[];let attempt=0;
 globalThis.fetch=async(_url,options)=>{calls.push(options!);return attempt++<2?busy():new Response(new Uint8Array([1,2,3]),{status:200,headers:{'Content-Disposition':'attachment; filename="call.wav"'}});};
 try{
  const bytes=await recordingRequest(pixelDownload,downloadOptions,new AbortController().signal,async response=>(await response.arrayBuffer()).byteLength,1000,[1,1]);
  assert.equal(bytes,3);assert.equal(calls.length,3);assert.ok(calls.every(options=>!new Headers(options.headers).has('Range')));
 }finally{globalThis.fetch=original;}
});
test('oversized single-chunk verification error is cancelled without retry or allocation',async()=>{
 const original=globalThis.fetch;let calls=0,cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}});
 globalThis.fetch=async()=>{calls++;return new Response(body,{status:503,headers:{'Content-Type':'application/json'}});};
 try{
  const result=await recordingRequest(pixelTrack,verificationOptions,new AbortController().signal,async response=>({status:response.status,bytes:(await response.arrayBuffer()).byteLength}),1000,[1,1]);
  assert.deepEqual(result,{status:503,bytes:0});assert.equal(calls,1);assert.equal(cancelled,true);
 }finally{globalThis.fetch=original;}
});

test('mp3 export keeps the verification busy retry',async()=>{
 const original=globalThis.fetch,calls:RequestInit[]=[];let attempt=0;
 globalThis.fetch=async(_url,options)=>{calls.push(options!);return attempt++<1?busy():new Response(new Uint8Array([1,2]),{status:200});};
 try{
  const bytes=await recordingRequest(pixelDownload+'&format=mp3',downloadOptions,new AbortController().signal,async response=>(await response.arrayBuffer()).byteLength,1000,[1,1]);
  assert.equal(bytes,2);assert.equal(calls.length,2);
 }finally{globalThis.fetch=original;}
});
