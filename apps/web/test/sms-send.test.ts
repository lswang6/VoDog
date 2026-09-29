import assert from 'node:assert/strict';
import test from 'node:test';
import {enqueueSmsBatch} from '../src/sms-send.ts';
const storage=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};};
const accepted={batchId:'batch',intervalSeconds:5,items:[{id:'a',simId:'s',body:'hello',state:'queued',direction:'outgoing',createdAt:''}]};
const base={account:'a',simId:'s',recipients:['10086','10010'],body:'hello'};
test('uncertain retries preserve key and payload; accepted refresh failure remains success',async()=>{
 const bodies:any[]=[];let fail=true;const store=storage();
 const request=async(_path:string,body:any,_method?:string,options?:any)=>{bodies.push({body,...options});if(fail)throw new Error('timeout');return accepted;};
 await assert.rejects(enqueueSmsBatch({...base,storage:store,request:request as any}));
 fail=false;let count=0;
 await enqueueSmsBatch({...base,storage:store,request:request as any,onSent:()=>{count++;throw new Error('refresh');}});
 assert.deepEqual(bodies[0],bodies[1]);assert.equal(count,1);
 await enqueueSmsBatch({...base,storage:store,request:request as any});assert.notEqual(bodies[1].idempotencyKey,bodies[2].idempotencyKey);
});
test('account boundary during digest prevents POST; late result does not refresh new account',async()=>{
 let current=true;let posts=0;let refreshed=0;
 const pending=enqueueSmsBatch({...base,storage:storage(),isCurrent:()=>current,request:async()=>{posts++;return accepted as any;}});
 current=false;await assert.rejects(pending,/登录状态/);assert.equal(posts,0);
 current=true;
 await enqueueSmsBatch({...base,storage:storage(),isCurrent:()=>current,request:async()=>{current=false;return accepted as any;},onSent:()=>{refreshed++;}});
 assert.equal(refreshed,0);
});
test('changed body uses a new attempt; malformed response retains original key',async()=>{
 const bodies:any[]=[];const store=storage();const request=async(_:string,body:any,_method?:string,options?:any)=>{bodies.push({body,...options});return {} as any;};
 await assert.rejects(enqueueSmsBatch({...base,storage:store,request}));
 await assert.rejects(enqueueSmsBatch({...base,storage:store,request}));
 await assert.rejects(enqueueSmsBatch({...base,body:'changed',storage:store,request}));
 assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);assert.notEqual(bodies[1].idempotencyKey,bodies[2].idempotencyKey);
});
