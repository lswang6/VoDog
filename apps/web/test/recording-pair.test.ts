import assert from 'node:assert/strict';import test from 'node:test';
import {pairContractDurationSeconds,RecordingPairController,recordingPairIdentity,type PairAudio,type PairState} from '../src/recording-pair.ts';
import type {TrackDescriptor} from '../src/recording-contract.ts';
class AudioFake extends EventTarget implements PairAudio{
 currentTime=0;duration=10;ended=false;readyState=4;plays=0;pauses=0;pending=false;
 async play(){this.plays++;if(this.pending)await new Promise<void>(()=>{});}pause(){this.pauses++;}emit(name:string){this.dispatchEvent(new Event(name));}
}
test('paired playback pauses both while buffering and resumes only after both tracks can play',async()=>{
 const a=new AudioFake(),b=new AudioFake(),states:PairState[]=[];const pair=new RecordingPairController([a,b],state=>states.push(state));pair.play();await Promise.resolve();assert.equal(a.plays,1);assert.equal(b.plays,1);
 b.readyState=2;b.emit('waiting');assert.equal(a.pauses,1);assert.equal(states.at(-1)!.buffering,true);
 a.emit('canplay');assert.equal(a.plays,1);b.readyState=3;b.emit('canplay');await Promise.resolve();assert.equal(a.plays,2);assert.equal(b.plays,2);pair.dispose();
});
test('shorter track ending does not stop the longer tail and completion uses max duration',async()=>{
 const a=new AudioFake(),b=new AudioFake(),states:PairState[]=[];a.duration=4;b.duration=9;const pair=new RecordingPairController([a,b],state=>states.push(state));pair.play();await Promise.resolve();
 a.currentTime=4;a.ended=true;a.emit('ended');assert.equal(states.at(-1)!.playing,true);assert.equal(b.pauses,0);assert.equal(states.at(-1)!.duration,9);
 b.currentTime=9;b.ended=true;b.emit('ended');assert.equal(states.at(-1)!.playing,false);pair.dispose();
});
test('seek bounds each original independently and dispose fences late play completion',async()=>{
 let release!:()=>void;class PendingAudio extends AudioFake{override play(){this.plays++;return new Promise<void>(resolve=>{release=resolve;});}}
 const a=new PendingAudio(),b=new AudioFake();a.duration=3;b.duration=8;const pair=new RecordingPairController([a,b],()=>{});pair.seek(6);assert.equal(a.currentTime,3);assert.equal(b.currentTime,6);pair.seek(0);pair.play();pair.dispose();release();await Promise.resolve();assert.ok(a.pauses>=1);assert.ok(b.pauses>=1);
});
test('a stale play promise cannot pause a newer buffering recovery',async()=>{
 const releases:(()=>void)[]=[];class DeferredAudio extends AudioFake{override play(){this.plays++;return new Promise<void>(resolve=>releases.push(resolve));}}
 const a=new DeferredAudio(),b=new AudioFake();const pair=new RecordingPairController([a,b],()=>{});pair.play();a.emit('waiting');const paused=a.pauses;a.readyState=3;b.readyState=3;a.emit('canplay');assert.equal(a.plays,2);
 releases[0]();await Promise.resolve();await Promise.resolve();assert.equal(a.pauses,paused);releases[1]();await Promise.resolve();pair.dispose();
});
test('completed pair rewinds for replay and seek preserves active playback',async()=>{
 const a=new AudioFake(),b=new AudioFake();a.duration=4;b.duration=8;a.currentTime=4;b.currentTime=8;a.ended=b.ended=true;const states:PairState[]=[];const pair=new RecordingPairController([a,b],state=>states.push(state));pair.play();await Promise.resolve();assert.equal(a.currentTime,0);assert.equal(b.currentTime,0);assert.equal(a.plays,1);assert.equal(b.plays,1);
 a.ended=b.ended=false;pair.seek(2);await Promise.resolve();assert.equal(states.at(-1)!.playing,true);assert.equal(a.currentTime,2);assert.equal(b.currentTime,2);assert.equal(a.plays,2);assert.equal(b.plays,2);pair.dispose();
});
test('seeking back while the longer tail plays restarts the previously ended short track',async()=>{
 const a=new AudioFake(),b=new AudioFake();a.duration=4;b.duration=9;const pair=new RecordingPairController([a,b],()=>{});pair.play();await Promise.resolve();a.currentTime=4;a.ended=true;a.emit('ended');b.currentTime=6;
 const shortPlays=a.plays;pair.seek(2);await Promise.resolve();assert.equal(a.currentTime,2);assert.equal(b.currentTime,2);assert.equal(a.plays,shortPlays+1);pair.dispose();
});
test('contract duration seeds pair state before play and Infinity metadata cannot zero it',()=>{
 const a=new AudioFake(),b=new AudioFake(),states:PairState[]=[];
 a.duration=Number.POSITIVE_INFINITY;b.duration=Number.NaN;
 const pair=new RecordingPairController([a,b],state=>states.push(state),12.5);
 assert.equal(pair.state().duration,12.5);
 a.emit('durationchange');assert.equal(states.at(-1)!.duration,12.5);
 a.duration=11;b.duration=13;a.emit('loadedmetadata');
 assert.equal(states.at(-1)!.duration,13);
 pair.dispose();
 const remote:TrackDescriptor={id:'remote_original',sourceRole:'original_capture',mediaType:'audio/ogg',bytes:100,sha256:'a'.repeat(64),captureComplete:null,gapCount:0,droppedFrames:0,durationMs:12500};
 const caller:TrackDescriptor={id:'caller_original',sourceRole:'original_capture',mediaType:'audio/ogg',bytes:80,sha256:'b'.repeat(64),captureComplete:null,gapCount:0,droppedFrames:0,durationMs:8000};
 assert.equal(pairContractDurationSeconds([remote,caller]),12.5);
});
test('pair identity follows source and immutable content instead of descriptor references',()=>{
 const remote:TrackDescriptor={id:'remote_original',sourceRole:'original_capture',mediaType:'audio/wav',bytes:48044,sha256:'a'.repeat(64),captureComplete:true,gapCount:0,droppedFrames:0};
 const caller:TrackDescriptor={id:'caller_original',sourceRole:'original_capture',mediaType:'audio/wav',bytes:50044,sha256:'b'.repeat(64),captureComplete:true,gapCount:0,droppedFrames:0};
 const callId='00000000-0000-4000-8000-000000000900',identity=recordingPairIdentity(callId,'pixel',[remote,caller]);
 assert.equal(recordingPairIdentity(callId,'pixel',[{...remote},{...caller}]),identity);
 assert.notEqual(recordingPairIdentity(callId,'pixel',[{...remote,sha256:'c'.repeat(64)},caller]),identity);
 assert.notEqual(recordingPairIdentity(callId,'media_node',[remote,caller]),identity);
 assert.notEqual(recordingPairIdentity(callId,'pixel',[{...remote,captureComplete:false,gapCount:1},caller]),identity);
});
