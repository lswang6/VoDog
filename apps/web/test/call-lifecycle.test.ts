import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CallAttemptScope,claimedByThisSession,claimWithReconciliation,CurrentSessionCallEnd,sendDtmfDigit} from '../src/call-lifecycle.ts';
import {OutboundAttempt} from '../src/outbound-attempt.ts';

test('automatic end always uses the exact-session ownership guard',async()=>{
  const requests:{path:string;body:unknown}[]=[];
  const ender=new CurrentSessionCallEnd(async(path,body)=>{requests.push({path,body});return {call:{state:'ending'}};},[0]);
  await ender.end('call/id');
  assert.deepEqual(requests,[{path:'/calls/call%2Fid/end',body:{onlyIfCurrentSessionOwner:true}}]);
});

test('concurrent cleanup is deduplicated and a released response stops retries',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let requests=0;
  const ender=new CurrentSessionCallEnd(async()=>{requests++;await gate;return {call:{state:'ending'}};},[0,0]);
  const first=ender.end('call-1'),second=ender.end('call-1');
  assert.strictEqual(first,second);
  release();await Promise.all([first,second]);
  assert.equal(requests,1);
});

test('transient failure retries but ownership conflict is a safe terminal no-op',async()=>{
  let transient=0;
  const retrying=new CurrentSessionCallEnd(async()=>{transient++;if(transient===1)throw new Error('offline');return {call:{state:'ended'}};},[0,0]);
  await retrying.end('call-1');
  assert.equal(transient,2);

  let conflicts=0;
  const rejected=new CurrentSessionCallEnd(async()=>{conflicts++;throw Object.assign(new Error('not owner'),{status:409});},[0,0,0]);
  await rejected.end('call-2');
  assert.equal(conflicts,1);
});

test('media starts only for this sessions successful claim',()=>{
  assert.equal(claimedByThisSession({claimedByCurrentSession:true,state:'connecting'}),true);
  assert.equal(claimedByThisSession({claimedByCurrentSession:true,state:'active'}),true);
  assert.equal(claimedByThisSession({claimedByCurrentSession:false,state:'connecting'}),false);
  assert.equal(claimedByThisSession({state:'connecting'}),false);
  assert.equal(claimedByThisSession({claimedByCurrentSession:true,state:'ended'}),false);
});

test('ambiguous call attempt scope survives reload but rotates at a new login',()=>{
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}};
  const ids=Array.from(['session-a','session-b']);
  const first=new CallAttemptScope(storage,()=>ids.shift()!);
  const key=first.attemptKey('alice');
  assert.equal(new CallAttemptScope(storage).attemptKey('alice'),key);
  first.rotate();
  assert.notEqual(first.attemptKey('alice'),key);
  first.clear('alice');
  assert.equal(values.size,0);
});

test('uncertain outbound call reuses one key until the server response is confirmed',async()=>{
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}};
  const scope=new CallAttemptScope(storage,()=> 'session-a').attemptKey('alice');
  const payload={simId:'sim-a',remoteNumber:'+12025550100'};
  const firstAttempt=new OutboundAttempt(storage,scope);
  const first=await firstAttempt.key(payload);
  const retried=await new OutboundAttempt(storage,scope).key(payload);
  assert.equal(retried,first);
  assert.ok(!storage.getItem(scope)!.includes(payload.remoteNumber));
  firstAttempt.confirmed(first);
  assert.notEqual(await firstAttempt.key(payload),first);
});


test('lost successful claim response reconciles ownership without a second answer',async()=>{
  let claims=0;
  const result=await claimWithReconciliation(async()=>{claims++;throw new TypeError('network');},async()=>({call:{state:'connecting',claimedByCurrentSession:true}}));
  assert.equal(claims,1);assert.equal(claimedByThisSession(result.call),true);
});
test('lost uncommitted claim response retries only a still ringing call',async()=>{
  let claims=0;
  const result=await claimWithReconciliation(async()=>{if(++claims===1)throw new TypeError('network');return {call:{state:'connecting',claimedByCurrentSession:true}};},async()=>({call:{state:'incoming_ringing',claimedByCurrentSession:false}}));
  assert.equal(claims,2);assert.equal(claimedByThisSession(result.call),true);
});
test('another session winner or definite conflict cannot become this session claim',async()=>{
  let claims=0,reads=0;
  await assert.rejects(claimWithReconciliation(async()=>{claims++;throw new TypeError('network');},async()=>{reads++;return {call:{state:'connecting',claimedByCurrentSession:false}};}));
  assert.equal(claims,1);assert.equal(reads,1);
  await assert.rejects(claimWithReconciliation(async()=>{throw {status:409};},async()=>{reads++;return {call:{state:'connecting',claimedByCurrentSession:true}};}));
  assert.equal(reads,1);
});

test('a call the AI is answering offers neither 接听 nor 拒接',async()=>{
  const {aiSuppressed,offersAnswerControls}=await import('../src/call-occupancy.ts');
  const {mayEndCall}=await import('../src/media-policy.ts');
  const aiCall={id:'call-ai',simId:'sim-1',state:'incoming_ringing',startedAt:'2026-09-12T01:00:00.000Z',answerMode:'ai',aiHandling:true};
  const humanCall={...aiCall,id:'call-human',answerMode:'normal',aiHandling:false};

  assert.equal(offersAnswerControls(aiCall),false);
  // main.tsx gates 拒接 on `!suppressed && mayEndCall(...)`; the raw policy still says a ringing call is endable.
  assert.equal(mayEndCall(aiCall,null),true);
  assert.equal(!aiSuppressed(aiCall)&&mayEndCall(aiCall,null),false,'拒接 is hidden for the AI call');
  assert.equal(offersAnswerControls(humanCall),true);
  assert.equal(!aiSuppressed(humanCall)&&mayEndCall(humanCall,null),true);
});

test('an in-call key posts exactly one digit to the call\'s dtmf route',async()=>{
  const sent:{path:string;body:unknown;method:string;options:{timeoutMs:number}}[]=[];
  const ok=await sendDtmfDigit(async(path,body,method,options)=>{sent.push({path,body,method,options});return {ok:true};},'call/id','#');
  assert.equal(ok,true);
  assert.deepEqual(sent,[{path:'/calls/call%2Fid/dtmf',body:{digits:'#'},method:'POST',options:{timeoutMs:4000}}]);
});

test('anything that is not a DTMF key — the long-pressed plus above all — is never sent',async()=>{
  let calls=0;
  const request=async()=>{calls++;return {};};
  for(const key of ['+','','12','a','０'])assert.equal(await sendDtmfDigit(request,'a2b',key),false);
  assert.equal(calls,0);
});
