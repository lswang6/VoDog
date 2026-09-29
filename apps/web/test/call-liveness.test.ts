import test from 'node:test';
import assert from 'node:assert/strict';
import {WebCallLiveness,type CallLivenessAPI,type CallLivenessSnapshot} from '../src/call-liveness.ts';

const initial:CallLivenessSnapshot={mediaEpoch:1,revision:1,expiresAt:'2099-01-01T00:00:00.000Z'};
const wait=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

test('heartbeat starts immediately, advances CAS revision, and stops cleanly',async()=>{
 const bodies:unknown[]=[];let calls=0,lost=0;
 const api:CallLivenessAPI=async<T>(_path,body)=>{calls++;bodies.push(body);return{liveness:{...initial,revision:calls+1}} as T;};
 const lease=new WebCallLiveness(()=>{lost++;},5);lease.start('call-1',initial,api);
 await wait(2);assert.equal(calls,1);assert.deepEqual(bodies[0],{mediaEpoch:1,expectedRevision:1});
 await wait(7);assert.ok(calls>=2);assert.deepEqual(bodies[1],{mediaEpoch:1,expectedRevision:2});
 lease.stop();const stoppedAt=calls;await wait(8);assert.equal(calls,stoppedAt);assert.equal(lost,0);
});

test('lost heartbeat response reconciles owner detail before the next CAS',async()=>{
 const bodies:unknown[]=[];let requests=0;
 const api:CallLivenessAPI=async<T>(path,body)=>{
  requests++;if(path.endsWith('/liveness')){bodies.push(body);if(bodies.length===1)throw new Error('response lost');return{liveness:{...initial,revision:3}} as T;}
  return{liveness:{...initial,revision:2}} as T;
 };
 const lease=new WebCallLiveness(()=>assert.fail('lease should reconcile'),8);lease.start('call-1',initial,api);
 await wait(3);assert.equal(requests,2);assert.deepEqual(bodies[0],{mediaEpoch:1,expectedRevision:1});
 await wait(10);assert.deepEqual(bodies[1],{mediaEpoch:1,expectedRevision:2});lease.stop();
});

test('missing owner lease after heartbeat failure stops once and aborts future work',async()=>{
 let lost=0,requests=0;
 const api:CallLivenessAPI=async<T>(path)=>{requests++;if(path.endsWith('/liveness'))throw new Error('network');return{liveness:null} as T;};
 const lease=new WebCallLiveness((_id,message)=>{lost++;assert.match(message,/安全结束/);},5);lease.start('call-1',initial,api);
 await wait(4);assert.equal(requests,2);assert.equal(lost,1);assert.equal(lease.callId,null);
 await wait(8);assert.equal(requests,2);assert.equal(lost,1);
});

test('S73 unreachable Control retries until the local lease expires, then stops once',async()=>{
 let lost=0,requests=0;const lease=new WebCallLiveness(()=>{lost++;},5);
 const api:CallLivenessAPI=async()=>{requests++;throw new Error('offline');};
 lease.start('call-1',{...initial,expiresAt:new Date(Date.now()+500).toISOString()},api);
 await wait(20);assert.equal(requests,2);assert.equal(lost,0);assert.equal(lease.callId,'call-1');
 await wait(1200);assert.equal(lost,1);assert.equal(lease.callId,null);
});
