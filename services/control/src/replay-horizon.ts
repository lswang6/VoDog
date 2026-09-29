import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';

export type ReplayCommandEvidence={
 id:string; sequence:number; kind:string; fingerprint:string;
 ackDisposition:'accepted'|'not_executed'|'unknown'; businessTerminal:string; safe:boolean;
 serverFinalizedReason?:'media_capability_withdrawn'|'settings_superseded';
};
export type ReplayFinalizedProof={
 generation:number;sequence:number;commandId:string;fingerprint:string;kind:string;
 serverStatus:'rejected';serverReason:'media_capability_withdrawn'|'settings_superseded';entryDigest:string;
};
export type ReplayProposal={
 gatewayId:string; generation:number; fromInclusive:number; retireBeforeSequence:number;
 revision:number; proofDigest:string; commandCount:number; kindCounts:Record<string,number>;
 protocolVersion?:2;finalizedProofs?:ReplayFinalizedProof[];
};
export type GatewayReplayState={
 gatewayId:string; generation:number; blockingFloor:number; preparedRevision:number;
 preparedDigest:string; committedFloor:number; committedRevision:number; committedDigest:string;
 disposition?:'ready'|'local_blocked'|'quarantined';rejectionReason?:string;
};

function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>)
  .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
 return value;
}
export function replayDigest(value:unknown):string{return createHash('sha256').update(JSON.stringify(canonical(value))).digest('base64url');}

function finalizedProofBase(value:Omit<ReplayFinalizedProof,'entryDigest'>){return value;}
export function replayFinalizedProof(value:Omit<ReplayFinalizedProof,'entryDigest'>):ReplayFinalizedProof{
 return{...value,entryDigest:replayDigest(finalizedProofBase(value))};
}
export function replayProposalWireDigest(value:Omit<ReplayProposal,'proofDigest'>):string{
 return replayDigest({protocolVersion:2,gatewayId:value.gatewayId,generation:value.generation,
  fromInclusive:value.fromInclusive,retireBeforeSequence:value.retireBeforeSequence,revision:value.revision,
  commandCount:value.commandCount,kindCounts:value.kindCounts,finalizedProofs:value.finalizedProofs??[]});
}

export function continuousSafePrefix(fromInclusive:number,rows:ReplayCommandEvidence[]):number{
 let next=fromInclusive;
 for(const row of rows){
  if(row.sequence!==next||!row.safe)break;
  next+=1;
 }
 return next;
}

// Every member is a gateway refusal raised *before* the execution entry point (`validate()` runs
// ahead of `markEffectStarted`; the legacy `GatewaySettings` path refuses outright), so the command
// provably had no side effect. S29 §2.2 forbids ever adding a post-effect rejection here: the
// uppercase `TELECOM_*` reasons, `PHONE_ACCOUNT_NOT_UNIQUE`, `call_target_mismatch`,
// `cellular_adapter_disabled`, `invalid_sms_command` and any `settings_*` reason stay out.
const safeNoEffectReasons=new Set(['command_expired','control_disabled','generation_mismatch','fence_rejected','assignment_mismatch','sim_not_routable','sms_execution_not_approved','send_sms_permission_missing','call_execution_not_approved','audio_handoff_not_ready','remote_number_invalid','call_not_found','call_already_ended','ai_unavailable']);
export function commandReplayFingerprint(command:any,gatewayId:string):string {
 return replayDigest({id:command.id,gatewayId,generation:Number(command.generation),sequence:Number(command.sequence),kind:command.kind,payload:command.sms_id?{...command.payload,smsId:command.sms_id}:command.payload});
}
function resultReason(result:unknown):string|undefined{return result&&typeof result==='object'&&typeof (result as any).reason==='string'?(result as any).reason:undefined;}
function resultPhase(result:unknown):string|undefined{return result&&typeof result==='object'&&typeof (result as any).phase==='string'?(result as any).phase:undefined;}
function exactServerFinalization(kind:string,status:string,result:unknown):ReplayCommandEvidence['serverFinalizedReason']{
 if(status!=='rejected'||!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==1)return undefined;
 const reason=resultReason(result);
 if(reason==='media_capability_withdrawn'&&['dial','answer'].includes(kind))return reason;
 if(reason==='settings_superseded'&&kind==='apply_sim_settings')return reason;
 return undefined;
}

export async function loadReplayEvidence(c:PoolClient,gatewayId:string,generation:number,fromInclusive:number,limit=256):Promise<ReplayCommandEvidence[]>{
 const q=await c.query(`SELECT cmd.id,cmd.sequence,cmd.kind,cmd.payload,cmd.status,cmd.result,cmd.call_id,cmd.sms_id,cmd.sim_id,cmd.generation,receipt.fingerprint ack_fingerprint,receipt.result ack_result,receipt.status ack_status,
   (snapshot.generation=cmd.generation AND NOT snapshot.local_busy AND snapshot.calls='[]'::jsonb AND snapshot.updated_at>=cmd.created_at) terminal_snapshot,
   call.state call_state,(lock.call_id IS NOT NULL) call_locked,(close_job.call_id IS NOT NULL AND close_job.completed_at IS NULL) close_pending,
   sms.state sms_state,settings.applied_version,settings.applied_assignment_version,settings.applied_generation
  FROM commands cmd
  JOIN gateways gateway ON gateway.id=cmd.gateway_id AND gateway.device_epoch=cmd.generation AND cmd.sequence<=gateway.command_sequence
  LEFT JOIN gateway_command_replay_receipts receipt ON receipt.command_id=cmd.id
  LEFT JOIN gateway_telecom_snapshots snapshot ON snapshot.gateway_id=cmd.gateway_id
  LEFT JOIN call_records call ON call.id=cmd.call_id
  LEFT JOIN gateway_call_locks lock ON lock.call_id=cmd.call_id
  LEFT JOIN media_close_jobs close_job ON close_job.call_id=cmd.call_id
  LEFT JOIN sms_messages sms ON sms.id=cmd.sms_id
  LEFT JOIN sim_settings settings ON settings.sim_id=cmd.sim_id
  WHERE cmd.gateway_id=$1 AND cmd.generation=$2 AND cmd.sequence >= $3
  ORDER BY cmd.sequence LIMIT $4`,[gatewayId,generation,fromInclusive,limit]);
 return q.rows.map(row=>{
  const sequence=Number(row.sequence),kind=String(row.kind),status=String(row.status),reason=resultReason(row.result),phase=resultPhase(row.result);
  const fingerprint=commandReplayFingerprint(row,gatewayId);
  const receiptV2=row.ack_result?._receiptVersion===2&&row.ack_result?.result&&typeof row.ack_result.result==='object';
  const acceptedAckResult=receiptV2?row.ack_result.result:row.ack_result;
  const boundAck=row.ack_fingerprint===fingerprint&&row.ack_status===status&&replayDigest(acceptedAckResult)===replayDigest(row.result);
  let ackDisposition:'accepted'|'not_executed'|'unknown'='unknown',businessTerminal='unknown',safe=false;
  const receiptDisposition=receiptV2?row.ack_result.sideEffectDisposition:undefined;
  if(boundAck&&receiptDisposition==='not_executed')ackDisposition='not_executed';
  else if(boundAck&&receiptDisposition==='effect_committed'&&status==='acked')ackDisposition='accepted';
  else if(boundAck&&['effect_started','unknown'].includes(receiptDisposition))ackDisposition='unknown';
  else if(boundAck&&status==='acked'&&!['unknown','side_effect_unknown','rejected_after_effect'].includes(phase??'')&&!['execution_unknown','side_effect_unknown'].includes(reason??''))ackDisposition='accepted';
  else if(boundAck&&status==='rejected'&&phase==='not_executed'&&reason&&safeNoEffectReasons.has(reason))ackDisposition='not_executed';
  if(kind==='send_sms'){
   // S29 §2.2: retention deleted the SMS row (`ON DELETE SET NULL`). The command, its bound ACK and
   // the fingerprint are untouched (the payload already carries the same `smsId`), so a bound ACK is
   // the whole proof; there is no live row left to reach a business terminal state.
   if(row.sms_id===null){businessTerminal='purged';safe=ackDisposition!=='unknown';}
   else{
    businessTerminal=row.sms_state??'missing';
    safe=ackDisposition!=='unknown'&&(ackDisposition==='not_executed'||['delivered','failed'].includes(businessTerminal));
   }
  }else if(kind==='apply_sim_settings'){
   const payload=row.payload??{};
   // S29 §2.2: a later settings command may have overwritten `applied_*`; an ACKed command whose
   // versions were superseded is still applied. NULL means never applied — `Number(null)` is 0 and
   // would compare as a real version, so the null check comes first.
   const appliedVersion=row.applied_version==null?null:Number(row.applied_version);
   const appliedAssignment=row.applied_assignment_version==null?null:Number(row.applied_assignment_version);
   const wantVersion=Number(payload.settingsVersion),wantAssignment=Number(payload.assignmentVersion);
   const applied=appliedVersion!==null&&appliedAssignment!==null&&Number(row.applied_generation)===generation&&
    Number.isFinite(wantVersion)&&Number.isFinite(wantAssignment)&&appliedVersion>=wantVersion&&appliedAssignment>=wantAssignment;
   businessTerminal=!applied?'not_applied':appliedVersion===wantVersion&&appliedAssignment===wantAssignment?'applied':'superseded';
   safe=ackDisposition!=='unknown'&&(ackDisposition==='not_executed'||applied);
  }else if(kind==='dtmf'){
   // S36 C2: a DTMF tone leaves no durable row anywhere — nothing records "the digit played" — so the
   // bound ACK is the whole proof, exactly like a send_sms whose message row retention purged. A tone
   // Control itself finalized as expired without any receipt was never delivered and has no retry or
   // reconciliation path, so nothing is left to prove: the heartbeat sweep's finalization retires it.
   const serverExpired=status!=='pending'&&reason==='expired'&&row.ack_fingerprint===null;
   // A legacy (v1) receipt carries no disposition, and only `command_expired` of the gateway's dtmf
   // refusals (`invalid_digits`, `no_call`, `command_expired`) is in the cross-kind
   // `safeNoEffectReasons`. For dtmf the bound ACK's own `not_executed` phase is proof enough
   // whatever the reason: the tone never played and none of them has durable state to reconcile.
   // Scoped to this branch on purpose — `safeNoEffectReasons` stays untouched for every other kind,
   // and a v2 disposition still wins (an `effect_started` receipt is never talked into not_executed).
   const boundNotExecuted=receiptDisposition===undefined&&boundAck&&status==='rejected'&&phase==='not_executed';
   businessTerminal=serverExpired?'expired':'n/a';
   safe=ackDisposition!=='unknown'||serverExpired||boundNotExecuted;
  }else if(['dial','answer','hangup'].includes(kind)){
   // S29 §2.2: retention deleted the call row (`ON DELETE SET NULL`; writes are never NULL). No live
   // state is left to prove the call ended, so a current-generation idle Telecom snapshot observed no
   // earlier than the command replaces it. Lock and close-job joins are empty once the call is gone.
   if(row.call_id===null){
    businessTerminal='purged';
    safe=ackDisposition!=='unknown'&&!row.call_locked&&!row.close_pending&&row.terminal_snapshot===true;
   }else{
    businessTerminal=row.call_state??'missing';
    safe=ackDisposition!=='unknown'&&!row.call_locked&&!row.close_pending&&
     ['ended','failed'].includes(businessTerminal)&&(ackDisposition==='not_executed'||row.terminal_snapshot===true);
   }
  }
  return{id:String(row.id),sequence,kind,fingerprint,ackDisposition,businessTerminal,safe,
   serverFinalizedReason:exactServerFinalization(kind,status,row.result)};
 });
}

// S29 §2.2 detection. A gateway that refuses a proposal (`GatewayReplayHorizonStore.apply()` throws
// instead of quarantining, S30) keeps its blocking floor at the committed floor while Control keeps
// re-offering the same revision. Counting is per gateway+generation with the revision in the value,
// so a new revision (or an accepted one) drops the entry instead of leaking one key per revision.
export type ReplayProposalStallObservation={gatewayId:string;generation:number;proposedRevision:number;committedRevision:number;deviceBlockingFloor?:number;committedFloor:number};
export function replayProposalStallTracker(threshold=Number(process.env.REPLAY_PROPOSAL_STALL_HEARTBEATS??30)||30){
 const counts=new Map<string,{revision:number;count:number}>();
 return {
  threshold,
  observe(o:ReplayProposalStallObservation):number{
   const key=`${o.gatewayId}:${o.generation}`;
   if(!(o.proposedRevision>o.committedRevision)||o.deviceBlockingFloor!==o.committedFloor){counts.delete(key);return 0;}
   const prior=counts.get(key),count=prior&&prior.revision===o.proposedRevision?prior.count+1:1;
   counts.set(key,{revision:o.proposedRevision,count});
   return count;
  },
  size():number{return counts.size;},
 };
}

/** Controlled recovery after the gateway has accepted Control's withdrawal and returned to its
 * exact committed tuple. It cannot alter a floor, proof, audit, or permanent quarantine. */
export async function recoverReplayProposalBlock(c:PoolClient,gatewayId:string,generation:number):Promise<boolean>{
 const q=await c.query(`UPDATE gateway_command_replay_horizons SET quarantine_reason=NULL,updated_at=now()
  WHERE gateway_id=$1 AND generation=$2 AND state='ready' AND proposed_floor=committed_floor
    AND proposed_revision=committed_revision AND proposed_digest=committed_digest
    AND quarantine_reason LIKE 'device_local_blocker:%'`,[gatewayId,generation]);
 return q.rowCount===1;
}

function samePrepared(device:GatewayReplayState,proposal:any):boolean{return device.blockingFloor===Number(proposal.proposed_floor)&&device.preparedRevision===Number(proposal.proposed_revision)&&device.preparedDigest===proposal.proposed_digest;}
function sameCommitted(device:GatewayReplayState,row:any):boolean{return device.committedFloor===Number(row.committed_floor)&&device.committedRevision===Number(row.committed_revision)&&device.committedDigest===(row.committed_digest??'');}

export async function coordinateReplayHorizon(c:PoolClient,input:{gatewayId:string;generation:number;device?:GatewayReplayState;allowProposal?:boolean;protocolVersion?:1|2}):Promise<{proposal?:ReplayProposal;committed?:ReplayProposal;withdrawn?:ReplayProposal;quarantined:boolean;blocked?:boolean}>{
 const {gatewayId,generation,device}=input;
 let h=(await c.query(`SELECT * FROM gateway_command_replay_horizons WHERE gateway_id=$1 AND generation=$2 FOR UPDATE`,[gatewayId,generation])).rows[0];
 if(!h){await c.query(`INSERT INTO gateway_command_replay_horizons(gateway_id,generation)VALUES($1,$2) ON CONFLICT DO NOTHING`,[gatewayId,generation]);h=(await c.query(`SELECT * FROM gateway_command_replay_horizons WHERE gateway_id=$1 AND generation=$2 FOR UPDATE`,[gatewayId,generation])).rows[0];}
 const quarantine=async(reason:string)=>{await c.query(`UPDATE gateway_command_replay_horizons SET state='quarantined',quarantine_reason=$3,updated_at=now() WHERE gateway_id=$1 AND generation=$2`,[gatewayId,generation,reason]);return{quarantined:true as const};};
 if(h.state==='quarantined'||device?.disposition==='quarantined')return{quarantined:true};
 const serverBlocked=h.state==='ready'&&String(h.quarantine_reason??'').startsWith('device_local_blocker:');
 const allocator=(await c.query('SELECT device_epoch,command_sequence FROM gateways WHERE id=$1',[gatewayId])).rows[0];
 if(!allocator||Number(allocator.device_epoch)!==generation||Number(h.proposed_floor)>Number(allocator.command_sequence)+1)
  return quarantine('allocator_restore_mismatch');
 if(!device)return quarantine('missing_device_state');
 if(device){
  if(device.disposition==='local_blocked'){
   const exactRejection=Number(h.proposed_revision)>Number(h.committed_revision)&&
    device.blockingFloor===Number(h.committed_floor)&&device.preparedRevision===Number(h.proposed_revision)&&
    device.preparedDigest===h.proposed_digest;
   if(!exactRejection)return quarantine('unrecognized_local_blocker');
   const audit=(await c.query(`SELECT proof FROM gateway_command_replay_audits WHERE gateway_id=$1 AND generation=$2 AND revision=$3`,[gatewayId,generation,h.proposed_revision])).rows[0]?.proof;
   if(!audit)return quarantine('missing_rejected_audit');
   await c.query(`UPDATE gateway_command_replay_horizons SET quarantine_reason=$3,updated_at=now() WHERE gateway_id=$1 AND generation=$2`,
    [gatewayId,generation,`device_local_blocker:${String(device.rejectionReason??'unknown').slice(0,48)}`]);
   return{withdrawn:audit as ReplayProposal,quarantined:false,blocked:true};
  }
  if(serverBlocked){
   const recovered=device.blockingFloor===Number(h.committed_floor)&&device.preparedRevision===Number(h.committed_revision)&&
    device.preparedDigest===(h.committed_digest??'')&&device.committedFloor===Number(h.committed_floor)&&sameCommitted(device,h);
   if(!recovered)return{quarantined:false,blocked:true};
   await c.query(`UPDATE gateway_command_replay_horizons SET proposed_floor=committed_floor,proposed_revision=committed_revision,
     proposed_digest=committed_digest,updated_at=now() WHERE gateway_id=$1 AND generation=$2`,[gatewayId,generation]);
   // The gateway accepted the exact withdrawal and is back on the committed tuple. Leaving the
   // device_local_blocker marker behind would force every later heartbeat to advertise all
   // capabilities as unavailable even though the replay fence is healthy again.
   if(await recoverReplayProposalBlock(c,gatewayId,generation))return{quarantined:false};
   return{quarantined:false,blocked:true};
  }
  if(device.committedFloor>device.blockingFloor||device.committedRevision>device.preparedRevision)return quarantine('invalid_device_state');
  const atCommitted=device.blockingFloor===Number(h.committed_floor)&&device.preparedRevision===Number(h.committed_revision)&&device.preparedDigest===(h.committed_digest??'');
  if(!atCommitted&&!samePrepared(device,h))return quarantine('unrecognized_prepared_state');
  if(device.gatewayId!==gatewayId||device.generation!==generation)return quarantine('identity_mismatch');
  if(device.blockingFloor<Number(h.committed_floor))return quarantine('floor_rollback');
  if(device.blockingFloor>Number(h.proposed_floor)||device.committedFloor>Number(h.committed_floor))return quarantine('gateway_floor_ahead');
  if(device.committedFloor===Number(h.committed_floor)&&!sameCommitted(device,h))return quarantine('committed_proof_mismatch');
  if(device.blockingFloor===Number(h.proposed_floor)&&Number(h.proposed_revision)>0&&!samePrepared(device,h))return quarantine('prepared_proof_mismatch');
  if(Number(h.proposed_revision)>Number(h.committed_revision)&&samePrepared(device,h)){
   await c.query(`UPDATE gateway_command_replay_horizons SET committed_floor=proposed_floor,committed_revision=proposed_revision,committed_digest=proposed_digest,updated_at=now() WHERE gateway_id=$1 AND generation=$2`,[gatewayId,generation]);
   h={...h,committed_floor:h.proposed_floor,committed_revision:h.proposed_revision,committed_digest:h.proposed_digest};
  }
 }
 const committedFloor=Number(h.committed_floor),proposedFloor=Number(h.proposed_floor);
 if(Number(h.proposed_revision)>0&&Number(h.proposed_revision)===Number(h.committed_revision)&&
   (!device||!sameCommitted(device,h))){
  const audit=(await c.query(`SELECT proof FROM gateway_command_replay_audits WHERE gateway_id=$1 AND generation=$2 AND revision=$3`,[gatewayId,generation,h.committed_revision])).rows[0]?.proof;
  if(audit)return{committed:audit as ReplayProposal,quarantined:false};
  return quarantine('missing_committed_audit');
 }
 if(Number(h.proposed_revision)>Number(h.committed_revision)){
  const audit=(await c.query(`SELECT proof FROM gateway_command_replay_audits WHERE gateway_id=$1 AND generation=$2 AND revision=$3`,[gatewayId,generation,h.proposed_revision])).rows[0]?.proof;
  return audit?{proposal:audit as ReplayProposal,quarantined:false}:quarantine('missing_proposed_audit');
 }
 if(input.allowProposal===false)return{quarantined:false};
 if(serverBlocked)return{quarantined:false,blocked:true};
 const evidence=await loadReplayEvidence(c,gatewayId,generation,committedFloor);
 const v2=input.protocolVersion===2;
 const floor=continuousSafePrefix(committedFloor,evidence.map(row=>({...row,safe:row.safe||(v2&&row.serverFinalizedReason!==undefined)})));
 if(floor===committedFloor)return{quarantined:false};
 const covered=evidence.filter(row=>row.sequence>=committedFloor&&row.sequence<floor);
 const revision=Number(h.committed_revision)+1,kindCounts:Record<string,number>={};covered.forEach(row=>kindCounts[row.kind]=(kindCounts[row.kind]??0)+1);
 const finalizedProofs=v2?covered.filter(row=>!row.safe&&row.serverFinalizedReason).map(row=>replayFinalizedProof({
  generation,sequence:row.sequence,commandId:row.id,fingerprint:row.fingerprint,kind:row.kind,
  serverStatus:'rejected',serverReason:row.serverFinalizedReason!,
 })):[];
 const wireBase={gatewayId,generation,fromInclusive:committedFloor,retireBeforeSequence:floor,revision,commandCount:covered.length,kindCounts,
  ...(v2?{protocolVersion:2 as const,finalizedProofs}: {})};
 const proofBase={...wireBase,commands:covered};
 const proposal:ReplayProposal={...wireBase,proofDigest:v2?replayProposalWireDigest(wireBase):replayDigest(proofBase)};
 const inserted=await c.query(`INSERT INTO gateway_command_replay_audits(gateway_id,generation,revision,from_inclusive,retire_before_sequence,proof_digest,proof,evidence)VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[gatewayId,generation,revision,committedFloor,floor,proposal.proofDigest,JSON.stringify(proposal),JSON.stringify(covered)]);
 if(inserted.rowCount===0){
  const prior=(await c.query(`SELECT proof_digest,proof FROM gateway_command_replay_audits WHERE gateway_id=$1 AND generation=$2 AND revision=$3`,[gatewayId,generation,revision])).rows[0];
  if(!prior||prior.proof_digest!==proposal.proofDigest||replayDigest(prior.proof)!==replayDigest(proposal))return quarantine('rejected_revision_collision');
 }
 await c.query(`UPDATE gateway_command_replay_horizons SET proposed_floor=$3,proposed_revision=$4,proposed_digest=$5,updated_at=now() WHERE gateway_id=$1 AND generation=$2`,[gatewayId,generation,floor,revision,proposal.proofDigest]);
 return{proposal,quarantined:false};
}
