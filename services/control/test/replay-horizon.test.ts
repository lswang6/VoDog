import assert from 'node:assert/strict';
import test from 'node:test';
import {continuousSafePrefix,replayDigest,replayFinalizedProof,replayProposalStallTracker,replayProposalWireDigest,type ReplayCommandEvidence} from '../src/replay-horizon.js';
const row=(sequence:number,safe=true,kind='dial'):ReplayCommandEvidence=>({id:`id-${sequence}`,sequence,kind,fingerprint:`fp-${sequence}`,ackDisposition:safe?'accepted':'unknown',businessTerminal:safe?'ended':'unknown',safe});
test('continuous prefix stops at a hole and never treats a later ACK as proof',()=>assert.equal(continuousSafePrefix(15,[row(16)]),15));
test('mixed call SMS and settings share one sequence and any blocker stops all later work',()=>assert.equal(continuousSafePrefix(1,[row(1,true,'dial'),row(2,false,'send_sms'),row(3,true,'apply_sim_settings')]),2));
test('prefix can advance over an exact contiguous safe interval',()=>assert.equal(continuousSafePrefix(7,[row(7),row(8),row(9)]),10));
test('proof digest is canonical but changes with identity or evidence',()=>{
 assert.equal(replayDigest({b:2,a:1}),replayDigest({a:1,b:2}));
 assert.notEqual(replayDigest({gatewayId:'a',generation:2}),replayDigest({gatewayId:'a',generation:3}));
});
test('v2 digest binds every exact finalized identity and rejects self-consistent entry forgery',()=>{
 const entry=replayFinalizedProof({generation:3,sequence:24,commandId:'00000000-0000-4000-8000-000000000024',
  fingerprint:'f'.repeat(43),kind:'dial',serverStatus:'rejected',serverReason:'media_capability_withdrawn'});
 const wire={protocolVersion:2 as const,gatewayId:'00000000-0000-4000-8000-000000000001',generation:3,fromInclusive:24,
  retireBeforeSequence:25,revision:5,commandCount:1,kindCounts:{dial:1},finalizedProofs:[entry]};
 const digest=replayProposalWireDigest(wire);
 assert.equal(entry.entryDigest,'rDsiw6EYQqHbh0f8UAC8f5dASEpCjmsVeSFnUcOdiFc');
 assert.equal(digest,'eeDRjNNYJ8DMQeUs9R6lZVsmpTrd9V1jFZQQ3jivdPo');
 assert.notEqual(digest,replayProposalWireDigest({...wire,finalizedProofs:[{...entry,commandId:'00000000-0000-4000-8000-000000000099'}]}));
 assert.notEqual(digest,replayProposalWireDigest({...wire,kindCounts:{answer:1}}));
});
test('S29: a re-offered proposal counts only while the device floor never moves, and resets on progress',()=>{
 const tracker=replayProposalStallTracker(3);
 const stalled={gatewayId:'g1',generation:3,proposedRevision:7,committedRevision:6,deviceBlockingFloor:24,committedFloor:24};
 assert.deepEqual([1,2,3,4,5,6].map(()=>tracker.observe(stalled)),[1,2,3,4,5,6]);
 // The threshold and every multiple of it is what the heartbeat logs on.
 assert.deepEqual([1,2,3,4,5,6].filter(count=>count%tracker.threshold===0),[3,6]);
 // A new revision restarts the count instead of leaking one entry per revision.
 assert.equal(tracker.observe({...stalled,proposedRevision:8}),1);
 assert.equal(tracker.size(),1);
 // The device accepted the range: the floor moved, so the next stall starts from scratch.
 assert.equal(tracker.observe({...stalled,proposedRevision:8,deviceBlockingFloor:40}),0);
 assert.equal(tracker.size(),0);
 assert.equal(tracker.observe({...stalled,proposedRevision:8}),1);
 // Committed (no outstanding proposal) also clears it, and a gateway without horizon state never counts.
 assert.equal(tracker.observe({...stalled,proposedRevision:8,committedRevision:8}),0);
 assert.equal(tracker.observe({...stalled,deviceBlockingFloor:undefined}),0);
 assert.equal(replayProposalStallTracker().threshold,30);
});
test('wire fingerprint fixture matches Android including SMS identity Unicode and nested keys',async()=>{
 const {commandReplayFingerprint}=await import('../src/replay-horizon.js');
 assert.equal(commandReplayFingerprint({id:'00000000-0000-0000-0000-000000000001',generation:2,sequence:3,kind:'send_sms',sms_id:'00000000-0000-0000-0000-000000000002',payload:{body:'测试 / newline\n',nested:{z:true,a:null},simId:'00000000-0000-0000-0000-000000000003'}},'00000000-0000-0000-0000-000000000004'),'c7kTEi-26T9H54aJkU9-0Tl1qbFisGaFNcUnstqWepA');
});
