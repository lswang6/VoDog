import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createDb} from '../src/db.js';
import {coordinateReplayHorizon,commandReplayFingerprint,loadReplayEvidence,type GatewayReplayState} from '../src/replay-horizon.js';
const url=process.env.REPLAY_TEST_DATABASE_URL;
const db=url?createDb(url):undefined;
before(async()=>{if(db){await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await db.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));}});
after(async()=>{await db?.end();});
async function fixture(commandSequence=3){const g=(await db!.query("INSERT INTO gateways(name,command_sequence)VALUES('replay-test',$1)RETURNING id,device_epoch",[commandSequence])).rows[0];return {gatewayId:g.id,generation:Number(g.device_epoch)};}
function initial(g:{gatewayId:string;generation:number}):GatewayReplayState{return {...g,blockingFloor:1,preparedRevision:0,preparedDigest:'',committedFloor:1,committedRevision:0,committedDigest:''};}
async function coordinate(input:Parameters<typeof coordinateReplayHorizon>[1]){const c=await db!.connect();try{await c.query('BEGIN');const out=await coordinateReplayHorizon(c,input);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
type Gateway={gatewayId:string;generation:number};
// One insert for every S29 evidence shape: any kind, any business identity, receipt bound to the row.
async function insertCommand(g:Gateway,input:{sequence:number;kind:string;status:'acked'|'rejected'|'expired';result:Record<string,unknown>;callId?:string|null;smsId?:string|null;simId?:string|null;payload?:Record<string,unknown>;receipt?:boolean}){
 const row=(await db!.query("INSERT INTO commands(gateway_id,generation,sequence,kind,call_id,sms_id,sim_id,payload,expires_at,status,result)VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10)RETURNING *",
  [g.gatewayId,g.generation,input.sequence,input.kind,input.callId??null,input.smsId??null,input.simId??null,JSON.stringify(input.payload??{}),input.status,JSON.stringify(input.result)])).rows[0];
 if(input.receipt!==false)await db!.query('INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result)VALUES($1,$2,$3,$4)',[row.id,commandReplayFingerprint(row,g.gatewayId),input.status,JSON.stringify(input.result)]);
 return row;
}
async function evidence(g:Gateway,from=1){const c=await db!.connect();try{return await loadReplayEvidence(c,g.gatewayId,g.generation,from);}finally{c.release();}}
async function owner(g:Gateway){return (await db!.query("INSERT INTO users(email,password_hash)VALUES($1,'test-only')RETURNING id",[`${g.gatewayId}@test.invalid`])).rows[0].id;}
async function idleSnapshot(g:Gateway,updatedAt='now()'){
 await db!.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,reported_sequence,local_busy,calls,observed_at,updated_at)VALUES($1,$2,gen_random_uuid(),3,false,'[]',now(),${updatedAt})`,[g.gatewayId,g.generation]);
}
async function command(g:Gateway,seq:number,receipt=true,reason='control_disabled'){const result={phase:'not_executed',reason};const row=(await db!.query("INSERT INTO commands(gateway_id,generation,sequence,kind,payload,expires_at,status,result)VALUES($1,$2,$3,'apply_sim_settings','{}',now(),'rejected',$4)RETURNING *",[g.gatewayId,g.generation,seq,JSON.stringify(result)])).rows[0];if(receipt)await db!.query('INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result)VALUES($1,$2,$3,$4)',[row.id,commandReplayFingerprint(row,g.gatewayId),'rejected',JSON.stringify(result)]);return row;}
test('durable three step handshake retries exact proofs and preserves interval across concurrent workers',{skip:!db},async()=>{const g=await fixture();await command(g,1);await command(g,2);const device=initial(g);const [a,b]=await Promise.all([coordinate({...g,device}),coordinate({...g,device})]);assert.deepEqual(a,b);assert.equal(a.proposal?.retireBeforeSequence,3);const p=a.proposal!;const prepared={...device,blockingFloor:3,preparedRevision:p.revision,preparedDigest:p.proofDigest};const committed=await coordinate({...g,device:prepared});assert.deepEqual(committed.committed,p);assert.deepEqual(await coordinate({...g,device:prepared}),committed);assert.deepEqual(await coordinate({...g,device:{...prepared,committedFloor:3,committedRevision:p.revision,committedDigest:p.proofDigest}}),{quarantined:false});});
test('legacy ACK and missing integer halt prefix despite higher ACK',{skip:!db},async()=>{const g=await fixture();await command(g,1,false);await command(g,3);assert.deepEqual(await coordinate({...g,device:initial(g)}),{quarantined:false});const c=await db!.connect();try{assert.equal((await loadReplayEvidence(c,g.gatewayId,g.generation,1))[0].safe,false);}finally{c.release();}});
test('missing state and stale restore quarantine durably',{skip:!db},async()=>{const g=await fixture();assert.equal((await coordinate(g)).quarantined,true);assert.equal((await coordinate({...g,device:initial(g)})).quarantined,true);const h=await fixture();const ahead={...initial(h),blockingFloor:4,preparedRevision:1,preparedDigest:'ahead'};assert.equal((await coordinate({...h,device:ahead})).quarantined,true);});
test('disabled flag never generates a new proposal',{skip:!db},async()=>{const g=await fixture();await command(g,1);assert.deepEqual(await coordinate({...g,device:initial(g),allowProposal:false}),{quarantined:false});});
test('unrecognized intermediate prepared tuple is never trusted',{skip:!db},async()=>{const g=await fixture();await command(g,1);await command(g,2);await coordinate({...g,device:initial(g)});assert.equal((await coordinate({...g,device:{...initial(g),blockingFloor:2}})).quarantined,true);});
test('real call SMS settings interval waits for Telecom terminal proof and SMS delivery',{skip:!db},async()=>{
 const g=await fixture();const owner=(await db!.query("INSERT INTO users(email,password_hash)VALUES($1,'test-only')RETURNING id",[`${g.gatewayId}@test.invalid`])).rows[0].id;
 const sim=(await db!.query("INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'test')RETURNING id",[g.gatewayId])).rows[0].id;
 const call=(await db!.query("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','ended',$4,'normal')RETURNING id",[g.gatewayId,sim,owner,g.generation])).rows[0].id;
 const sms=(await db!.query("INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)VALUES($1,$2,$3,'outgoing','test','test','sent',$4)RETURNING id",[g.gatewayId,sim,owner,g.generation])).rows[0].id;
 for(const [sequence,kind,callId,smsId] of [[1,'dial',call,null],[2,'send_sms',null,sms]] as const){
  const row=(await db!.query("INSERT INTO commands(gateway_id,generation,sequence,kind,call_id,sms_id,payload,expires_at,status,result)VALUES($1,$2,$3,$4,$5,$6,'{}',now(),'acked','{\"phase\":\"submitted\"}')RETURNING *",[g.gatewayId,g.generation,sequence,kind,callId,smsId])).rows[0];
  await db!.query('INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result)VALUES($1,$2,$3,$4)',[row.id,commandReplayFingerprint(row,g.gatewayId),'acked',JSON.stringify(row.result)]);
 }
 await command(g,3);
 assert.deepEqual(await coordinate({...g,device:initial(g)}),{quarantined:false});
 await db!.query("INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),3,false,'[]',now())",[g.gatewayId,g.generation]);
 const c=await db!.connect();try{let evidence=await loadReplayEvidence(c,g.gatewayId,g.generation,1);assert.deepEqual(evidence.map(r=>r.safe),[true,false,true]);
 await db!.query("UPDATE sms_messages SET state='delivered' WHERE id=$1",[sms]);evidence=await loadReplayEvidence(c,g.gatewayId,g.generation,1);assert.deepEqual(evidence.map(r=>r.safe),[true,true,true]);
 await db!.query('INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)',[g.gatewayId,call,g.generation]);assert.equal((await loadReplayEvidence(c,g.gatewayId,g.generation,1))[0].safe,false);
 }finally{c.release();}
});
test('S31 v2 receipt dispositions preserve normal call SMS and settings retirement',{skip:!db},async()=>{
 const g=await fixture(5),user=await owner(g);
 const sim=(await db!.query("INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'v2')RETURNING id",[g.gatewayId])).rows[0].id;
 const call=(await db!.query("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','ended',$4,'normal')RETURNING id",[g.gatewayId,sim,user,g.generation])).rows[0].id;
 const sms=(await db!.query("INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)VALUES($1,$2,$3,'outgoing','test','test','delivered',$4)RETURNING id",[g.gatewayId,sim,user,g.generation])).rows[0].id;
 await db!.query('INSERT INTO sim_settings(sim_id,version,applied_version,applied_assignment_version,applied_generation)VALUES($1,1,1,1,$2)',[sim,g.generation]);
 for(const [sequence,kind] of [[1,'dial'],[2,'answer'],[3,'hangup']] as const)
  await insertCommand(g,{sequence,kind,status:'acked',callId:call,result:{phase:'submitted'}});
 await insertCommand(g,{sequence:4,kind:'send_sms',status:'acked',smsId:sms,payload:{smsId:sms},result:{phase:'submitted'}});
 await insertCommand(g,{sequence:5,kind:'apply_sim_settings',status:'acked',simId:sim,
  payload:{settingsVersion:1,assignmentVersion:1},result:{appliedVersion:1,assignmentVersion:1}});
 await idleSnapshot(g);
 await db!.query(`UPDATE gateway_command_replay_receipts receipt SET result=jsonb_build_object(
   '_receiptVersion',2,'result',cmd.result,'sideEffectDisposition','effect_committed') FROM commands cmd WHERE receipt.command_id=cmd.id AND cmd.gateway_id=$1`,[g.gatewayId]);
 assert.deepEqual((await evidence(g)).map(row=>[row.kind,row.ackDisposition,row.safe]),[
  ['dial','accepted',true],['answer','accepted',true],['hangup','accepted',true],
  ['send_sms','accepted',true],['apply_sim_settings','accepted',true],
 ]);
 const proposal=(await coordinate({...g,device:initial(g),protocolVersion:2})).proposal!;
 assert.equal(proposal.retireBeforeSequence,6);assert.deepEqual(proposal.finalizedProofs,[]);
});
test('S31 an effect-started receipt never becomes not_executed from its result phase',{skip:!db},async()=>{
 const g=await fixture(1),user=await owner(g);
 const sim=(await db!.query("INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'post-marker')RETURNING id",[g.gatewayId])).rows[0].id;
 const call=(await db!.query("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','ended',$4,'normal')RETURNING id",[g.gatewayId,sim,user,g.generation])).rows[0].id;
 const cmd=await insertCommand(g,{sequence:1,kind:'hangup',status:'rejected',callId:call,result:{phase:'not_executed',reason:'call_not_found'}});
 await idleSnapshot(g);
 await db!.query(`UPDATE gateway_command_replay_receipts SET result=$2 WHERE command_id=$1`,[cmd.id,JSON.stringify({_receiptVersion:2,result:cmd.result,sideEffectDisposition:'effect_started'})]);
 assert.deepEqual((await evidence(g)).map(row=>[row.ackDisposition,row.safe]),[['unknown',false]]);
 assert.deepEqual(await coordinate({...g,device:initial(g),protocolVersion:2}),{quarantined:false});
});
test('partial restore with horizon ahead of allocator quarantines',{skip:!db},async()=>{
 const g=await fixture();await command(g,1);const device=initial(g);const p=(await coordinate({...g,device})).proposal!;
 await db!.query('UPDATE gateways SET command_sequence=0 WHERE id=$1',[g.gatewayId]);
 assert.equal((await coordinate({...g,device:{...device,blockingFloor:p.retireBeforeSequence,preparedRevision:p.revision,preparedDigest:p.proofDigest}})).quarantined,true);
 assert.equal((await db!.query('SELECT quarantine_reason FROM gateway_command_replay_horizons WHERE gateway_id=$1',[g.gatewayId])).rows[0].quarantine_reason,'allocator_restore_mismatch');
});
// S29 §2.2 (a): the three pre-execution gateway refusals added to `safeNoEffectReasons`. All of them
// happen before `markEffectStarted`, so a bound ACK plus a terminal call row is the whole proof.
test('S29 pre-execution refusals retire call and settings commands',{skip:!db},async()=>{
 const g=await fixture();const user=await owner(g);
 const sim=(await db!.query("INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'test')RETURNING id",[g.gatewayId])).rows[0].id;
 const call=(await db!.query("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','ended',$4,'normal')RETURNING id",[g.gatewayId,sim,user,g.generation])).rows[0].id;
 await insertCommand(g,{sequence:1,kind:'hangup',status:'rejected',callId:call,result:{phase:'not_executed',reason:'call_not_found'}});
 await insertCommand(g,{sequence:2,kind:'hangup',status:'rejected',callId:call,result:{phase:'not_executed',reason:'call_already_ended'}});
 await command(g,3,true,'ai_unavailable');
 assert.deepEqual((await evidence(g)).map(r=>[r.ackDisposition,r.safe]),[['not_executed',true],['not_executed',true],['not_executed',true]]);
 assert.equal((await coordinate({...g,device:initial(g)})).proposal?.retireBeforeSequence,4);
 // A lock still blocks: the refusal proves no new side effect, not that the call is finished.
 await db!.query('INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,$3)',[g.gatewayId,call,g.generation]);
 assert.equal((await evidence(g))[0].safe,false);
});
// S29 §2.2 (b): retention deleted the call row. `call_id` is NULL and only a current-generation idle
// Telecom snapshot observed no earlier than the command can still prove the device is not busy.
test('S29 a purged call retires only behind a fresh idle Telecom snapshot',{skip:!db},async()=>{
 const proven=await fixture();
 await insertCommand(proven,{sequence:1,kind:'dial',status:'acked',callId:null,result:{phase:'submitted'}});
 await idleSnapshot(proven);
 assert.deepEqual((await evidence(proven)).map(r=>[r.businessTerminal,r.safe]),[['purged',true]]);
 assert.equal((await coordinate({...proven,device:initial(proven)})).proposal?.retireBeforeSequence,2);
 const unproven=await fixture();
 await insertCommand(unproven,{sequence:1,kind:'dial',status:'acked',callId:null,result:{phase:'submitted'}});
 assert.deepEqual((await evidence(unproven)).map(r=>[r.businessTerminal,r.safe]),[['purged',false]]);
 const stale=await fixture();
 await insertCommand(stale,{sequence:1,kind:'dial',status:'acked',callId:null,result:{phase:'submitted'}});
 await idleSnapshot(stale,"now()-interval '1 hour'");
 assert.deepEqual((await evidence(stale)).map(r=>[r.businessTerminal,r.safe]),[['purged',false]]);
 assert.deepEqual(await coordinate({...stale,device:initial(stale)}),{quarantined:false});
});
// S29 §2.2 (c): the SMS row is gone. The payload still carries the same `smsId`, so the fingerprint is
// unchanged and the bound ACK alone retires the command.
test('S29 a purged SMS retires on its bound ACK alone',{skip:!db},async()=>{
 const g=await fixture();
 await insertCommand(g,{sequence:1,kind:'send_sms',status:'acked',smsId:null,payload:{smsId:crypto.randomUUID(),body:'purged'},result:{phase:'submitted'}});
 assert.deepEqual((await evidence(g)).map(r=>[r.ackDisposition,r.businessTerminal,r.safe]),[['accepted','purged',true]]);
 assert.equal((await coordinate({...g,device:initial(g)})).proposal?.retireBeforeSequence,2);
});
// S36 C2: a DTMF tone has no durable business row at all, so the bound ACK is the whole proof and the
// floor keeps moving. Without this branch the first dtmf command would stall the horizon forever.
test('S36 a dtmf command retires on its bound ACK alone',{skip:!db},async()=>{
 const g=await fixture(2);
 await insertCommand(g,{sequence:1,kind:'dtmf',status:'acked',payload:{digits:'1*#'},result:{phase:'submitted'}});
 await insertCommand(g,{sequence:2,kind:'dtmf',status:'acked',payload:{digits:'2'},result:{phase:'submitted'},receipt:false});
 assert.deepEqual((await evidence(g)).map(r=>[r.ackDisposition,r.businessTerminal,r.safe]),[['accepted','n/a',true],['unknown','n/a',false]]);
 assert.equal((await coordinate({...g,device:initial(g)})).proposal?.retireBeforeSequence,2);
 // The heartbeat sweep finalized an undelivered tone: no receipt exists and none ever will, so the
 // floor keeps moving instead of stalling on a row nobody can ever prove.
 await db!.query("UPDATE commands SET status='expired',result='{\"reason\":\"expired\"}' WHERE gateway_id=$1 AND sequence=2",[g.gatewayId]);
 assert.deepEqual((await evidence(g,2)).map(r=>[r.ackDisposition,r.businessTerminal,r.safe]),[['unknown','expired',true]]);
});
// S36 C2: the gateway refuses a tone with invalid_digits / no_call / command_expired, and Control's own
// heartbeat sweep expires an undelivered one. All four retire, and none of them may ever produce a
// finalizedProof: the gateway only accepts finalized proofs for dial/answer and apply_sim_settings and
// quarantines on any other kind.
test('S36 every dtmf refusal retires and none is ever server-finalized',{skip:!db},async()=>{
 const g=await fixture(5);
 for(const [sequence,reason] of [[1,'invalid_digits'],[2,'no_call'],[3,'command_expired']] as const)
  await insertCommand(g,{sequence,kind:'dtmf',status:'rejected',payload:{digits:'1'},result:{phase:'not_executed',reason}});
 await insertCommand(g,{sequence:4,kind:'dtmf',status:'expired',payload:{digits:'1'},result:{reason:'expired'},receipt:false});
 const started=await insertCommand(g,{sequence:5,kind:'dtmf',status:'rejected',payload:{digits:'1'},result:{phase:'not_executed',reason:'invalid_digits'}});
 await db!.query('UPDATE gateway_command_replay_receipts SET result=$2 WHERE command_id=$1',
  [started.id,JSON.stringify({_receiptVersion:2,result:started.result,sideEffectDisposition:'effect_started'})]);
 assert.deepEqual((await evidence(g)).map(r=>[r.ackDisposition,r.businessTerminal,r.safe]),[
  ['unknown','n/a',true],['unknown','n/a',true],['not_executed','n/a',true],['unknown','expired',true],['unknown','n/a',false],
 ],'only command_expired is a cross-kind safe reason; the other two ride on the bound not_executed ACK, and a v2 effect_started still blocks');
 const proposal=(await coordinate({...g,device:initial(g),protocolVersion:2})).proposal!;
 assert.equal(proposal.retireBeforeSequence,5);
 assert.deepEqual(proposal.kindCounts,{dtmf:4});
 assert.deepEqual(proposal.finalizedProofs,[],'a finalizedProof naming kind dtmf would quarantine the gateway');
});
// S29 §2.2: Control's own finalizations never produce a receipt, so they stay `unknown` (S30 fixes the
// gateway side). This pins the behaviour the release notes must not claim is fixed.
test('S29 a server-side finalization without a receipt stays unknown',{skip:!db},async()=>{
 const g=await fixture();
 await insertCommand(g,{sequence:1,kind:'dial',status:'rejected',callId:null,receipt:false,result:{reason:'media_capability_withdrawn'}});
 assert.deepEqual((await evidence(g)).map(r=>[r.ackDisposition,r.safe]),[['unknown',false]]);
 assert.deepEqual(await coordinate({...g,device:initial(g)}),{quarantined:false});
});
test('S31 v2 proposes exact server-finalized proofs while v1 stays at the old safe floor',{skip:!db},async()=>{
 const old=await fixture(2);
 await insertCommand(old,{sequence:1,kind:'dial',status:'rejected',callId:null,receipt:false,result:{reason:'media_capability_withdrawn'}});
 await command(old,2);
 assert.deepEqual(await coordinate({...old,device:initial(old),protocolVersion:1}),{quarantined:false});

 const modern=await fixture(2);
 const finalized=await insertCommand(modern,{sequence:1,kind:'dial',status:'rejected',callId:null,receipt:false,result:{reason:'media_capability_withdrawn'}});
 await command(modern,2);
 const proposed=await coordinate({...modern,device:initial(modern),protocolVersion:2});
 assert.equal(proposed.proposal?.retireBeforeSequence,3);
 assert.equal(proposed.proposal?.protocolVersion,2);
 assert.deepEqual(proposed.proposal?.finalizedProofs?.map(p=>[p.sequence,p.commandId,p.kind,p.serverReason]),
  [[1,finalized.id,'dial','media_capability_withdrawn']]);
});
test('S31 typed local blocker withdraws exactly and auto-recovers after the device accepts withdrawal',{skip:!db},async()=>{
 const g=await fixture(1);
 await insertCommand(g,{sequence:1,kind:'dial',status:'rejected',callId:null,receipt:false,result:{reason:'media_capability_withdrawn'}});
 const proposal=(await coordinate({...g,device:initial(g),protocolVersion:2})).proposal!;
 const blocked={...initial(g),preparedRevision:proposal.revision,preparedDigest:proposal.proofDigest,
  disposition:'local_blocked' as const,rejectionReason:'horizon_local_blocker'};
 const withdrawal=await coordinate({...g,device:blocked,protocolVersion:2});
 assert.equal(withdrawal.blocked,true);assert.deepEqual(withdrawal.withdrawn,proposal);
 assert.deepEqual(await coordinate({...g,device:initial(g),protocolVersion:2}),{quarantined:false});
 const recovered=(await db!.query('SELECT proposed_floor,proposed_revision,committed_floor,committed_revision,quarantine_reason FROM gateway_command_replay_horizons WHERE gateway_id=$1 AND generation=$2',[g.gatewayId,g.generation])).rows[0];
 assert.deepEqual(recovered,{proposed_floor:'1',proposed_revision:'0',committed_floor:'1',committed_revision:'0',quarantine_reason:null});
 assert.equal((await coordinate({...g,device:initial(g),protocolVersion:2})).proposal?.revision,proposal.revision);
});
// S29 §2.2 (e): an ACKed settings command whose versions a later command overwrote is still applied.
test('S29 superseded settings versions are applied, a foreign generation and a rejection are not',{skip:!db},async()=>{
 const g=await fixture();
 const sim=(await db!.query("INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,'test')RETURNING id",[g.gatewayId])).rows[0].id;
 await db!.query('INSERT INTO sim_settings(sim_id,version,applied_version,applied_assignment_version,applied_generation)VALUES($1,5,5,3,$2)',[sim,g.generation]);
 const payload={simId:sim,mode:'normal',timeoutSeconds:45,settingsVersion:2,assignmentVersion:3};
 await insertCommand(g,{sequence:1,kind:'apply_sim_settings',status:'acked',simId:sim,payload,result:{simId:sim,appliedVersion:2,assignmentVersion:3}});
 assert.deepEqual((await evidence(g)).map(r=>[r.businessTerminal,r.safe]),[['superseded',true]]);
 await db!.query('UPDATE sim_settings SET applied_version=2 WHERE sim_id=$1',[sim]);
 assert.deepEqual((await evidence(g)).map(r=>[r.businessTerminal,r.safe]),[['applied',true]]);
 await db!.query('UPDATE sim_settings SET applied_version=5,applied_generation=$2 WHERE sim_id=$1',[sim,g.generation+1]);
 assert.deepEqual((await evidence(g)).map(r=>[r.businessTerminal,r.safe]),[['not_applied',false]]);
 await db!.query('UPDATE sim_settings SET applied_generation=$2,applied_version=NULL,applied_assignment_version=NULL WHERE sim_id=$1',[sim,g.generation]);
 assert.deepEqual((await evidence(g)).map(r=>[r.businessTerminal,r.safe]),[['not_applied',false]]);
 // S09 §4.4 is unchanged: a rejected settings command is only safe for a whitelisted no-effect reason.
 const rejected=await fixture();
 await command(rejected,1,true,'settings_version_stale');
 assert.deepEqual((await evidence(rejected)).map(r=>[r.ackDisposition,r.safe]),[['unknown',false]]);
});
// S29 §2.2 rollback runbook: withdrawing a proposal must leave Control able to re-propose, never
// quarantine a device that is still sitting on the committed state.
test('S29 a withdrawn proposal re-proposes and never quarantines the device',{skip:!db},async()=>{
 const g=await fixture();await command(g,1);const device=initial(g);
 const proposal=(await coordinate({...g,device})).proposal!;
 assert.equal(proposal.revision,1);
 await db!.query(`BEGIN;
   UPDATE gateway_command_replay_horizons SET proposed_floor=committed_floor,proposed_revision=committed_revision,proposed_digest=committed_digest
     WHERE gateway_id='${g.gatewayId}' AND generation=${g.generation};
   DELETE FROM gateway_command_replay_audits WHERE gateway_id='${g.gatewayId}' AND generation=${g.generation} AND revision=${proposal.revision};
   COMMIT;`);
 assert.deepEqual(await coordinate({...g,device,allowProposal:false}),{quarantined:false});
 const horizon=(await db!.query('SELECT proposed_floor,proposed_revision,committed_floor,state FROM gateway_command_replay_horizons WHERE gateway_id=$1',[g.gatewayId])).rows[0];
 assert.deepEqual(horizon,{proposed_floor:'1',proposed_revision:'0',committed_floor:'1',state:'ready'});
 // The same evidence rebuilds the identical revision 1 proof, so the device sees no new identity.
 assert.deepEqual((await coordinate({...g,device})).proposal,proposal);
});
