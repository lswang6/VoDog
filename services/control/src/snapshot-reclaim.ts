import type {PoolClient} from 'pg';
import {observeAiCallState} from './ai-runs/repository.js';

/** Repeated device-reported absence (previous snapshot to current snapshot) required before a stale lock is reclaimed. */
export const STALE_LOCK_ABSENCE_MS=2*60_000;
/** Minimum age of a device-level call lock before repeated absence may reclaim it (journal-loss path). */
export const STALE_LOCK_MIN_AGE_SQL='5 minutes';
/**
 * Never-bound idle reclaim: repeated same-epoch idle plus a short lock age. Does not shrink the
 * 5-minute path. S20 D6 widened it from iOS-only to every originating platform; the evidence is
 * platform independent (repeated absence, no device call ID, no live command, epoch fenced).
 */
export const NEVER_BOUND_IDLE_LOCK_MIN_AGE_SQL='30 seconds';

export type SnapshotReclaimReason=
 |'device_snapshot_confirmed_absent'
 |'device_snapshot_confirmed_never_started'
 |'device_snapshot_stale_lock_reclaimed';

export const USER_HIDDEN_RECLAIM_REASONS = new Set<string>([
 'device_snapshot_confirmed_absent',
 'device_snapshot_confirmed_never_started',
 'device_snapshot_stale_lock_reclaimed',
]);

export type SnapshotLockRow={
 call_id:string;
 lock_generation:string|number;
 lock_is_old:boolean;
 lock_is_idle_old:boolean;
 direction:string;
 state:string;
 device_call_id:string|null;
 call_generation:string|number;
 answered_at:Date|string|null;
 recording_status:string|null;
 originating_platform:string|null;
 last_sequence:string|number;
 pending_commands:string|number;
};

export function callWasConnected(lock:{answered_at:unknown;state:string;recording_status:string|null|undefined}):boolean{
 return lock.answered_at!=null
  ||lock.state==='active'
  ||lock.state==='ending'
  ||(lock.recording_status!=null&&lock.recording_status!=='none');
}

export async function applyTerminalReclaim(
 c:PoolClient,
 callId:string,
 lock:{answered_at:unknown;state:string;recording_status:string|null|undefined},
 reason:SnapshotReclaimReason,
):Promise<'ended'|'failed'>{
 const connected=callWasConnected(lock);
 const nextState=connected?'ended':'failed';
 const overwrite=!connected&&reason==='device_snapshot_confirmed_never_started';
 const coalesce=!connected&&!overwrite;
 await c.query(
  `UPDATE call_records SET state=$2::call_state,ended_at=COALESCE(ended_at,now()),
     failure_reason=CASE
       WHEN $3 THEN $5
       WHEN $4 THEN COALESCE(failure_reason,$5)
       ELSE failure_reason
     END,
     gateway_time_zone=COALESCE(gateway_time_zone,(SELECT time_zone FROM gateways WHERE id=call_records.gateway_id))
   WHERE id=$1 AND state NOT IN ('ended','failed')`,
  [callId,nextState,overwrite,coalesce,reason],
 );
 await observeAiCallState(c,callId,nextState);
 return nextState;
}

export async function loadGatewayCallLocks(c:PoolClient,gatewayId:string):Promise<SnapshotLockRow[]>{
 const locks=await c.query(
  `SELECT l.call_id,l.generation lock_generation,
     l.acquired_at<=now()-interval '${STALE_LOCK_MIN_AGE_SQL}' lock_is_old,
     l.acquired_at<=now()-interval '${NEVER_BOUND_IDLE_LOCK_MIN_AGE_SQL}' lock_is_idle_old,
     c.direction,c.state,c.device_call_id,c.generation call_generation,c.answered_at,
     c.recording_status,c.originating_platform,
     COALESCE((SELECT max(sequence) FROM commands cmd WHERE cmd.call_id=c.id),0) last_sequence,
     COALESCE((SELECT count(*) FROM commands cmd WHERE cmd.call_id=c.id AND cmd.status='pending' AND cmd.expires_at>now()),0) pending_commands
   FROM gateway_call_locks l JOIN call_records c ON c.id=l.call_id WHERE l.gateway_id=$1 FOR UPDATE OF l,c`,
  [gatewayId],
 );
 return locks.rows as SnapshotLockRow[];
}

async function snapshotConfirmedNeverStarted(
 c:PoolClient,
 locked:SnapshotLockRow,
 input:{
  gatewayId:string;
  generation:number;
  reportedSequence:number;
  observedAt:string;
  localBusy:boolean;
  callsEmpty:boolean;
 },
):Promise<boolean>{
 if(
  !input.callsEmpty||
  input.localBusy||
  locked.direction!=='outgoing'||
  locked.state!=='unknown'||
  locked.device_call_id!==null||
  locked.answered_at!==null||
  Number(locked.lock_generation)!==input.generation||
  Number(locked.call_generation)!==input.generation||
  Number(locked.last_sequence)>input.reportedSequence
 )return false;
 const commandEvidence=await c.query(
  `SELECT gateway_id,generation,kind,status,sequence,result,
          expires_at<=now() expired_at_database_time,
          $2::timestamptz>expires_at observed_after_expiry,
          $2::timestamptz>=now()-interval '30 seconds' AND
            $2::timestamptz<=now()+interval '5 seconds' observation_is_fresh
   FROM commands WHERE call_id=$1 ORDER BY sequence`,
  [locked.call_id,input.observedAt],
 );
 const commands=commandEvidence.rows;
 const hasDial=commands.some((command:{kind:string})=>command.kind==='dial');
 return commands.length>0&&hasDial&&commands.every((command:{
  kind:string;status:string;gateway_id:string;generation:string|number;sequence:string|number;
  result:Record<string,unknown>|null;expired_at_database_time:boolean;observed_after_expiry:boolean;observation_is_fresh:boolean;
 })=>{
  const result=command.result??{};
  const phase=result.phase;
  const reason=typeof result.reason==='string'?result.reason:null;
  const allowedPhase=phase===undefined||phase===null||phase==='not_executed'||phase==='rejected';
  const allowedRejection=
   (command.kind==='dial'&&reason==='media_capability_withdrawn')||
   (['dial','hangup'].includes(command.kind)&&reason==='command_expired'&&phase==='not_executed')||
   (command.kind==='hangup'&&reason==='call_not_found');
  return(
   command.status==='rejected'&&
   command.gateway_id===input.gatewayId&&
   Number(command.generation)===input.generation&&
   allowedRejection&&
   allowedPhase&&
   Number(command.sequence)<=input.reportedSequence&&
   command.expired_at_database_time===true&&
   command.observed_after_expiry===true&&
   command.observation_is_fresh===true
  );
 });
}

async function releaseLock(
 c:PoolClient,
 locked:SnapshotLockRow,
 reason:SnapshotReclaimReason,
 reportedSequence:number,
 rejectPending:boolean,
):Promise<void>{
 await applyTerminalReclaim(c,locked.call_id,locked,reason);
 if(rejectPending){
  await c.query(
   `UPDATE commands SET status='rejected',result=jsonb_build_object('reason',$3::text)
    WHERE call_id=$1 AND status='pending' AND sequence<=$2`,
   [locked.call_id,reportedSequence,reason],
  );
 }
 await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[locked.call_id]);
}

export async function reclaimAbsentGatewayLocks(
 c:PoolClient,
 input:{
  gatewayId:string;
  generation:number;
  reportedSequence:number;
  observedAt:string;
  localBusy:boolean;
  callsEmpty:boolean;
  matchedCallIds:Set<string>;
  confirmedAbsentCallIds:Set<string>;
  previousAbsenceSample:boolean;
 },
):Promise<string[]>{
 const locks=await loadGatewayCallLocks(c,input.gatewayId);
 const releasedCallIds:string[]=[];
 for(const locked of locks){
  if(input.matchedCallIds.has(locked.call_id))continue;
  const explicitlyAbsent=input.confirmedAbsentCallIds.has(locked.call_id);
  const neverStarted=explicitlyAbsent?false:await snapshotConfirmedNeverStarted(c,locked,input);
  const livePending=Number(locked.pending_commands)>0;
  const sameEpoch=
   Number(locked.lock_generation)===input.generation&&
   Number(locked.call_generation)===input.generation;
  if(!explicitlyAbsent&&!neverStarted){
   const idleNow=input.callsEmpty&&input.localBusy===false&&!livePending&&sameEpoch&&input.previousAbsenceSample;
   const staleLockReclaim=idleNow&&locked.lock_is_old===true;
   // Platform independent since S20 D6: a never-bound lock that the device keeps reporting as idle
   // is the same evidence whether the dial came from iOS, Android, or the web.
   const neverBoundIdleReclaim=
    idleNow&&
    locked.device_call_id===null&&
    locked.lock_is_idle_old===true;
   if(!staleLockReclaim&&!neverBoundIdleReclaim)continue;
   await releaseLock(c,locked,'device_snapshot_stale_lock_reclaimed',input.reportedSequence,false);
   releasedCallIds.push(locked.call_id);
   continue;
  }
  // Live unexpired commands pin the lock. Expired leftover dial/hangup must not.
  if(livePending)continue;
  // Sequence guard, except confirmed-absent with nothing live in flight may release behind the watermark.
  if(Number(locked.last_sequence)>input.reportedSequence&&!explicitlyAbsent)continue;
  const reason:SnapshotReclaimReason=neverStarted
   ?'device_snapshot_confirmed_never_started'
   :'device_snapshot_confirmed_absent';
  await releaseLock(c,locked,reason,input.reportedSequence,true);
  releasedCallIds.push(locked.call_id);
 }
 return releasedCallIds;
}
