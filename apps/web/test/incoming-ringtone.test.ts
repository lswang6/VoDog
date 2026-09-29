import assert from 'node:assert/strict';
import test from 'node:test';
import {IncomingRingtone,RING_FREQUENCIES} from '../src/incoming-ringtone.ts';

class FakeParam{
 readonly values:number[]=[];
 setValueAtTime(value:number){this.values.push(value);}
 linearRampToValueAtTime(value:number){this.values.push(value);}
}
class FakeOscillator{
 type='sine';
 frequency=new FakeParam();
 started=false;
 stopped=false;
 onended:((this:FakeOscillator,ev:Event)=>void)|null=null;
 connect(){return this;}
 disconnect(){return this;}
 start(){this.started=true;}
 stop(){this.stopped=true;this.onended?.(new Event('ended'));}
}
class FakeGain{
 gain=new FakeParam();
 connected=false;
 disconnected=false;
 connect(){this.connected=true;return this;}
 disconnect(){this.disconnected=true;return this;}
}
class FakeAudioContext{
 state:'running'|'suspended'='running';
 currentTime=0;
 destination={};
 resumeCount=0;
 oscillators:FakeOscillator[]=[];
 createOscillator(){const oscillator=new FakeOscillator();this.oscillators.push(oscillator);return oscillator;}
 createGain(){return new FakeGain();}
 resume(){this.resumeCount++;if(this.state==='suspended')this.state='running';return Promise.resolve();}
}
class BlockedAudioContext extends FakeAudioContext{
 state:'running'|'suspended'='suspended';
 override resume(){this.resumeCount++;return Promise.resolve();}
}

function flush(){return new Promise(resolve=>setImmediate(resolve));}

test('start plays 440+480 Hz and stop is idempotent',async()=>{
 const ringtone=new IncomingRingtone(FakeAudioContext as unknown as new()=>AudioContext);
 assert.equal(ringtone.supported,true);
 assert.equal(ringtone.isRinging,false);
 ringtone.start();
 await flush();
 assert.equal(ringtone.isRinging,true);
 assert.equal(ringtone.needsUnlock,false);
 ringtone.start();
 await flush();
 assert.equal(ringtone.isRinging,true);
 const context=(ringtone as unknown as {context:FakeAudioContext}).context;
 assert.ok(context);
 assert.equal(context.oscillators.length,2);
 assert.deepEqual(context.oscillators.map(oscillator=>oscillator.frequency.values[0]),RING_FREQUENCIES);
 assert.ok(context.oscillators.every(oscillator=>oscillator.started));
 ringtone.stop();
 ringtone.stop();
 assert.equal(ringtone.isRinging,false);
 assert.ok(context.oscillators.every(oscillator=>oscillator.stopped));
});

test('start is a no-op when muted, disabled, or unsupported',async()=>{
 const unsupported=new IncomingRingtone(null);
 unsupported.start();
 await flush();
 assert.equal(unsupported.supported,false);
 assert.equal(unsupported.isRinging,false);

 const muted=new IncomingRingtone(FakeAudioContext as unknown as new()=>AudioContext);
 muted.setMuted(true);
 muted.start();
 await flush();
 assert.equal(muted.isRinging,false);
 muted.setMuted(false);
 muted.start();
 await flush();
 assert.equal(muted.isRinging,true);
 muted.setMuted(true);
 assert.equal(muted.isRinging,false);
 muted.stop();

 const disabled=new IncomingRingtone(FakeAudioContext as unknown as new()=>AudioContext);
 disabled.setEnabled(false);
 disabled.start();
 await flush();
 assert.equal(disabled.isRinging,false);
 disabled.setEnabled(true);
 disabled.start();
 await flush();
 assert.equal(disabled.isRinging,true);
 disabled.stop();
});

test('a suspended context sets needsUnlock and unlock retries start',async()=>{
 const ringtone=new IncomingRingtone(BlockedAudioContext as unknown as new()=>AudioContext);
 let ticks=0;
 const unsubscribe=ringtone.subscribe(()=>{ticks++;});
 ringtone.start();
 await flush();
 assert.equal(ringtone.isRinging,false);
 assert.equal(ringtone.needsUnlock,true);
 assert.ok(ticks>=1);
 ringtone.unlock();
 await flush();
 assert.equal(ringtone.isRinging,false);
 assert.equal(ringtone.needsUnlock,true);
 unsubscribe();
 ringtone.stop();
 assert.equal(ringtone.needsUnlock,false);

 const unlockable=new IncomingRingtone(FakeAudioContext as unknown as new()=>AudioContext);
 const contextHolder=unlockable as unknown as {context:FakeAudioContext|null};
 unlockable.start();
 await flush();
 assert.equal(unlockable.isRinging,true);
 contextHolder.context!.state='suspended';
 unlockable.unlock();
 await flush();
 assert.equal(contextHolder.context!.state,'running');
 assert.equal(contextHolder.context!.resumeCount>=1,true);
 unlockable.stop();
});

test('unlock after a blocked start begins ringing once the context can resume',async()=>{
 const ringtone=new IncomingRingtone(FakeAudioContext as unknown as new()=>AudioContext);
 const holder=ringtone as unknown as {context:FakeAudioContext|null};
 const context=new FakeAudioContext();
 context.state='suspended';
 context.resume=()=>{context.resumeCount++;return Promise.resolve();};
 holder.context=context;
 ringtone.start();
 await flush();
 assert.equal(ringtone.isRinging,false);
 assert.equal(ringtone.needsUnlock,true);
 context.resume=()=>{context.resumeCount++;context.state='running';return Promise.resolve();};
 ringtone.unlock();
 await flush();
 assert.equal(ringtone.isRinging,true);
 assert.equal(ringtone.needsUnlock,false);
 ringtone.stop();
});

test('an AI-answered incoming call never starts the ringtone (S22 决策 4)',async()=>{
 const {audibleRingingCall}=await import('../src/call-occupancy.ts');
 const ringtone=new IncomingRingtone(FakeAudioContext as unknown as new()=>AudioContext);
 // Exactly the predicate main.tsx feeds the ringtone effect.
 const apply=(calls:{id:string;simId:string;state:string;startedAt:string;answerMode?:string;aiHandling?:boolean}[])=>{
  if(!audibleRingingCall(calls))ringtone.stop();else ringtone.start();
 };
 const ringing=(overrides:Record<string,unknown>={})=>({id:'call-1',simId:'sim-1',state:'incoming_ringing',startedAt:'2026-09-12T01:00:00.000Z',...overrides});

 apply([ringing({answerMode:'ai',aiHandling:true})]);
 await flush();
 assert.equal(ringtone.isRinging,false,'AI 即接的来电不响铃');

 apply([ringing({answerMode:'timeout_ai',aiHandling:true})]);
 await flush();
 assert.equal(ringtone.isRinging,true,'超时代接在 AI 接管前照常响铃');

 apply([ringing({answerMode:'ai',aiHandling:true})]);
 await flush();
 assert.equal(ringtone.isRinging,false,'AI 接管后停铃');

 apply([ringing({id:'call-2'})]);
 await flush();
 assert.equal(ringtone.isRinging,true,'普通来电不受影响');
 ringtone.stop();
});
