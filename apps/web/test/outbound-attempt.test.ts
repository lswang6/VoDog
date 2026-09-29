import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OutboundAttempt} from '../src/outbound-attempt.ts';
function store(){const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)},removeItem:(k:string)=>{values.delete(k)}};}
test('uncertain send survives reload with one key, without persisting the message',async()=>{const storage=store(),payload={simId:'sim-a',remoteNumber:'+12025550114',body:'private message'};const first=await new OutboundAttempt(storage,'user-a:sms').key(payload);const retried=await new OutboundAttempt(storage,'user-a:sms').key(payload);assert.equal(first,retried);const saved=storage.getItem('user-a:sms')!;assert.ok(!saved.includes(payload.body));assert.ok(!saved.includes(payload.remoteNumber));});
test('account or changed payload is a separate intent and stale confirmation cannot clear it',async()=>{const storage=store(),attempt=new OutboundAttempt(storage,'user-a:sms');const first=await attempt.key({body:'one'}),next=await attempt.key({body:'two'});assert.notEqual(first,next);attempt.confirmed(first);assert.equal(await attempt.key({body:'two'}),next);assert.notEqual(await new OutboundAttempt(storage,'user-b:sms').key({body:'two'}),next);attempt.confirmed(next);assert.notEqual(await attempt.key({body:'two'}),next);});
test('concurrent retry shares one durable key, storage failure stops before a network intent',async()=>{const storage=store(),attempt=new OutboundAttempt(storage,'user-a:sms');const keys=await Promise.all(Array.from({length:12},()=>attempt.key({body:'one'})));assert.equal(new Set(keys).size,1);const broken={...storage,setItem:()=>{throw new Error('storage unavailable')}};await assert.rejects(new OutboundAttempt(broken,'user-b:sms').key({body:'two'}),/storage unavailable/);});
test('switching SIM or conversation preserves every ambiguous intent instead of replacing its key',async()=>{
 const storage=store(),attempt=new OutboundAttempt(storage,'user:sms');
 const a={simId:'pixel1',remoteNumber:'1768',body:'hello'},b={...a,simId:'pixel2'};
 const first=await attempt.key(a),second=await attempt.key(b);
 assert.equal(await new OutboundAttempt(storage,'user:sms').key(a),first);
 attempt.confirmed(second);assert.equal(await attempt.key(a),first);
});
test('legacy pending intent survives migration and malformed state fails closed',async()=>{
 const storage=store(),payload={body:'old'};
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))),n=>n.toString(16).padStart(2,'0')).join('');
 const key=crypto.randomUUID();storage.setItem('legacy',JSON.stringify({digest,key}));
 const attempt=new OutboundAttempt(storage,'legacy');await attempt.key({body:'new'});assert.equal(await attempt.key(payload),key);
 storage.setItem('bad','{}');await assert.rejects(new OutboundAttempt(storage,'bad').key(payload));
});
