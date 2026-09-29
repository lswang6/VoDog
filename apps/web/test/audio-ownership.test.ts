import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioOwnership} from '../src/audio-ownership.ts';

test('a call stops all recording resources and blocks newly mounted players',()=>{
 const owner=new AudioOwnership();let stopped=0;
 owner.registerPlayer(()=>{stopped++;});owner.registerPlayer(()=>{throw new Error('broken player');});owner.registerPlayer(()=>{stopped++;});
 const call=owner.beginCall();assert.equal(stopped,2);assert.equal(owner.isCallActive(),true);
 const remove=owner.registerPlayer(()=>{stopped++;});assert.equal(stopped,3);remove();
 owner.endCall(call);assert.equal(owner.isCallActive(),false);
});
test('late cleanup for an old call cannot release a newer audio owner',()=>{
 const owner=new AudioOwnership();const old=owner.beginCall(),current=owner.beginCall();
 owner.endCall(old);owner.endCall(old);assert.equal(owner.isCallActive(),true);
 owner.endCall(current);assert.equal(owner.isCallActive(),false);
});
test('unmounted playback cannot be touched by a later session or call boundary',()=>{
 const owner=new AudioOwnership();let stopped=0;
 const unregister=owner.registerPlayer(()=>{stopped++;});unregister();owner.stopRecordings();owner.beginCall();assert.equal(stopped,0);
});
