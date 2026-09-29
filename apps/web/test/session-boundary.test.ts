import test from 'node:test';
import assert from 'node:assert/strict';
import {audioOwnership} from '../src/audio-ownership.ts';
import {broadcastSessionChange,browserSessionGeneration,expireBrowserSession,listenForSessionInvalidation} from '../src/session-boundary.ts';

test('old 401 cannot invalidate a newer login; current expiry closes playback synchronously',()=>{
 const target=new EventTarget();Object.defineProperty(globalThis,'window',{value:target,configurable:true});
 const writes:string[]=[];Object.defineProperty(globalThis,'localStorage',{value:{setItem(_key:string,value:string){writes.push(value);}},configurable:true});
 let invalidations=0,stops=0;
 const unlisten=listenForSessionInvalidation(()=>{invalidations++;}),unregister=audioOwnership.registerPlayer(()=>{stops++;});
 const old=browserSessionGeneration();broadcastSessionChange();const afterChange=stops;
 expireBrowserSession(old);assert.equal(invalidations,0);assert.equal(stops,afterChange);
 expireBrowserSession(browserSessionGeneration());assert.equal(invalidations,1);assert.ok(stops>afterChange);
 assert.ok(writes.every(value=>Object.keys(JSON.parse(value)).sort().join(',')==='at,nonce'));
 unlisten();unregister();delete (globalThis as any).window;delete (globalThis as any).localStorage;
});
test('another tab change clears audio and auth; unrelated storage events do not',()=>{
 const target=new EventTarget();Object.defineProperty(globalThis,'window',{value:target,configurable:true});
 let invalidations=0,stops=0;const before=browserSessionGeneration();
 const unlisten=listenForSessionInvalidation(()=>{invalidations++;}),unregister=audioOwnership.registerPlayer(()=>{stops++;});
 const emit=(key:string,newValue:string)=>target.dispatchEvent(Object.assign(new Event('storage'),{key,newValue}));
 emit('unrelated','{}');emit('vodog-session-change-v1','bad JSON');assert.equal(invalidations,0);
 emit('vodog-session-change-v1',JSON.stringify({nonce:'different-tab',at:Date.now()}));
 assert.equal(invalidations,1);assert.equal(stops,1);assert.equal(browserSessionGeneration(),before+1);
 unlisten();unregister();delete (globalThis as any).window;
});

test('failed login preserves other tabs; successful login and explicit logout broadcast',async()=>{
 const {mutateBrowserSession}=await import('../src/session-boundary.ts');
 Object.defineProperty(globalThis,'navigator',{value:{},configurable:true});
 const writes:string[]=[];Object.defineProperty(globalThis,'localStorage',{value:{setItem(_key:string,value:string){writes.push(value);}},configurable:true});
 let stops=0;const unregister=audioOwnership.registerPlayer(()=>{stops++;});
 const before=browserSessionGeneration();
 await assert.rejects(mutateBrowserSession('login',async()=>{throw new Error('bad password');}));
 assert.equal(writes.length,0);assert.equal(stops,0);assert.equal(browserSessionGeneration(),before);
 await mutateBrowserSession('login',async()=>({user:'synthetic'}));
 assert.equal(writes.length,1);assert.equal(stops,1);
 await assert.rejects(mutateBrowserSession('logout',async()=>{throw new Error('offline');}));
 assert.equal(writes.length,2);assert.equal(stops,2);
 unregister();delete (globalThis as any).navigator;delete (globalThis as any).localStorage;
});

test('a cookie mutation queued behind a newer session is rejected before making a request',async()=>{
 const {mutateBrowserSession}=await import('../src/session-boundary.ts');
 let run:(()=>Promise<unknown>)|undefined;
 Object.defineProperty(globalThis,'navigator',{value:{locks:{request:(_name:string,action:()=>Promise<unknown>)=>{run=action;return new Promise(()=>{});}}},configurable:true});
 let requests=0;void mutateBrowserSession('login',async()=>{requests++;});
 broadcastSessionChange();await assert.rejects(run!());assert.equal(requests,0);
 delete (globalThis as any).navigator;
});
