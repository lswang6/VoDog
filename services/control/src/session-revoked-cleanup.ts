import {safeRollback,withClient,type Db} from './db.js';
import {diag,workerError} from './diag.js';
import {cancelUndeliveredDial} from './dial-cancel.js';

export async function markSessionCallsForRevokedCleanup(db:Db,sessionId:string):Promise<string[]>{
 return withClient(db,async c=>{
  try{
  await c.query('BEGIN');
  await c.query(`UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1`,[sessionId]);
  const gateways=await c.query(`SELECT DISTINCT gateway_id FROM call_records WHERE (originating_session_id=$1 OR claimed_by_session_id=$1) AND state NOT IN ('ended','failed') ORDER BY gateway_id`,[sessionId]);
  const ids:string[]=[];
  for(const gateway of gateways.rows){
   await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[gateway.gateway_id]);
   const calls=await c.query(`SELECT id,state FROM call_records WHERE gateway_id=$1 AND (originating_session_id=$2 OR claimed_by_session_id=$2) AND state NOT IN ('ended','failed') ORDER BY id FOR UPDATE`,[gateway.gateway_id,sessionId]);
   for(const call of calls.rows){
    await c.query(`UPDATE commands SET status='rejected',result='{"reason":"session_revoked_before_execution"}' WHERE call_id=$1 AND status='pending' AND kind IN ('dial','answer')`,[call.id]);
    await c.query(`UPDATE call_records SET state=CASE WHEN state='ending' THEN state ELSE 'unknown'::call_state END,failure_reason=COALESCE(failure_reason,'session_revoked') WHERE id=$1`,[call.id]);
    await c.query(`INSERT INTO session_revoked_call_cleanups(call_id,session_id,next_attempt_at) VALUES($1,$2,now())
      ON CONFLICT(call_id) DO UPDATE SET session_id=excluded.session_id,state='pending',next_attempt_at=LEAST(session_revoked_call_cleanups.next_attempt_at,now()),updated_at=now()`,[call.id,sessionId]);
    ids.push(call.id);
   }
  }
  await c.query('COMMIT');return ids;
  }catch(error){await safeRollback(c);throw error;}
 });
}

export type RevokedCallCleanupWorkerOptions={intervalMs?:number;batch?:number;onlineSeconds?:number;onMediaClose?:(callId:string)=>Promise<void>;
 /** S20 D4: rung after the inserting transaction committed, never inside it. */
 onCommandInserted?:(gatewayId:string)=>void};

export class RevokedCallCleanupWorker{
 private timer:NodeJS.Timeout|null=null;private running:Promise<void>|null=null;private stopped=true;
 private readonly intervalMs:number;private readonly batch:number;private readonly onlineSeconds:number;private readonly onMediaClose:(callId:string)=>Promise<void>;private readonly onCommandInserted?:(gatewayId:string)=>void;
 constructor(private readonly db:Db,options:RevokedCallCleanupWorkerOptions={}){this.intervalMs=Math.max(250,options.intervalMs??1000);this.batch=Math.min(100,Math.max(1,options.batch??20));this.onlineSeconds=Math.min(300,Math.max(5,options.onlineSeconds??30));this.onMediaClose=options.onMediaClose??(async()=>{});this.onCommandInserted=options.onCommandInserted;}
 start(){if(!this.stopped)return;this.stopped=false;this.schedule(0);}
 async stop(){this.stopped=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}await this.running;}
 private schedule(delay:number){if(this.stopped)return;this.timer=setTimeout(()=>{this.timer=null;this.running=this.tickOnce().then(()=>undefined,error=>workerError(this.db,'session_revoked_cleanup',error)).finally(()=>{this.running=null;this.schedule(this.intervalMs);});},delay);this.timer.unref();}
 async tickOnce(){
  const due=await this.db.query(`SELECT call_id FROM session_revoked_call_cleanups WHERE state='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at,call_id LIMIT $1`,[this.batch]);let count=0;
  for(const row of due.rows){try{const result=await this.process(row.call_id);if(result){count++;if(result.notifyGatewayId)this.onCommandInserted?.(result.notifyGatewayId);if(result.closeMedia)await this.onMediaClose(result.callId).catch(error=>workerError(this.db,'session_revoked_cleanup.media_close',error));}}catch(error){workerError(this.db,'session_revoked_cleanup',error);await this.db.query(`UPDATE session_revoked_call_cleanups SET attempts=attempts+1,last_error='cleanup_error',next_attempt_at=now()+interval '5 seconds',updated_at=now() WHERE call_id=$1 AND state='pending'`,[row.call_id]).catch(()=>{});}}
  return count;
 }
 private async process(callId:string):Promise<{callId:string;closeMedia:boolean;notifyGatewayId?:string}|null>{
  const target=await this.db.query(`SELECT call.gateway_id FROM session_revoked_call_cleanups job JOIN call_records call ON call.id=job.call_id WHERE job.call_id=$1`,[callId]);if(!target.rowCount)return null;
  let insertedGatewayId:string|null=null;
  return withClient(this.db,async c=>{
   try{
   await c.query('BEGIN');
   const gateway=(await c.query(`SELECT * FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id])).rows[0];
   const call=(await c.query(`SELECT * FROM call_records WHERE id=$1 FOR UPDATE`,[callId])).rows[0];
   const job=(await c.query(`SELECT * FROM session_revoked_call_cleanups WHERE call_id=$1 FOR UPDATE`,[callId])).rows[0];
   if(!job||job.state!=='pending'||new Date(job.next_attempt_at).getTime()>Date.now()){await c.query('ROLLBACK');return null;}
   if(!call||['ended','failed'].includes(call.state)){
    await c.query(`UPDATE session_revoked_call_cleanups SET state='done',updated_at=now() WHERE call_id=$1`,[callId]);await c.query('COMMIT');return{callId,closeMedia:true};
   }
   const ownerSession=call.direction==='incoming'?call.claimed_by_session_id:call.originating_session_id;
   const revoked=await c.query(`SELECT 1 FROM sessions WHERE id=$1 AND revoked_at IS NOT NULL`,[job.session_id]);
   if(ownerSession!==job.session_id||!revoked.rowCount){await c.query(`UPDATE session_revoked_call_cleanups SET state='done',last_error='ownership_changed',updated_at=now() WHERE call_id=$1`,[callId]);await c.query('COMMIT');return{callId,closeMedia:false};}
   const cancelledDial=await cancelUndeliveredDial(c,call.id,'session_revoked');
   if(cancelledDial){
    await c.query(`UPDATE session_revoked_call_cleanups SET state='done',updated_at=now() WHERE call_id=$1`,[callId]);
    await c.query('COMMIT');
    diag(this.db,'call.dial_cancelled',{commandId:cancelledDial},{callId});
    return{callId,closeMedia:true};
   }
   const snapshot=await c.query(`SELECT generation,calls,observed_at>=now()-$2::int*interval '1 second' fresh FROM gateway_telecom_snapshots WHERE gateway_id=$1 FOR UPDATE`,[gateway.id,this.onlineSeconds]);
   const exact=snapshot.rowCount&&snapshot.rows[0].fresh&&Number(snapshot.rows[0].generation)===Number(gateway.device_epoch)&&call.device_call_id&&(snapshot.rows[0].calls as any[]).filter(item=>item.callId===call.id&&item.deviceCallId===call.device_call_id).length===1;
   const ready=gateway.control_enabled&&gateway.telephony_ready&&gateway.last_seen_at&&Date.now()-new Date(gateway.last_seen_at).getTime()<=this.onlineSeconds*1000;
   if(Number(call.generation)!==Number(gateway.device_epoch)&&exact){
    await c.query(`UPDATE commands SET status='rejected',result='{"reason":"superseded_device_epoch"}' WHERE call_id=$1 AND status='pending'`,[call.id]);
    await c.query(`UPDATE call_records SET generation=$2 WHERE id=$1`,[call.id,gateway.device_epoch]);await c.query(`UPDATE gateway_call_locks SET generation=$2 WHERE call_id=$1`,[call.id,gateway.device_epoch]);call.generation=gateway.device_epoch;
   }
   const pending=await c.query(`SELECT id,expires_at>now() live FROM commands WHERE call_id=$1 AND kind='hangup' AND status='pending' ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,[call.id]);
   if(pending.rowCount&&!pending.rows[0].live)await c.query(`UPDATE commands SET status='expired',result='{"reason":"expired"}' WHERE id=$1`,[pending.rows[0].id]);
   let commandId=pending.rowCount&&pending.rows[0].live?pending.rows[0].id:null;
   if(!commandId&&ready&&exact){const sequence=Number(gateway.command_sequence)+1;await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[gateway.id,sequence]);commandId=(await c.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)VALUES($1,$2,$3,$4,'hangup',$5,now()+interval '15 seconds')RETURNING id`,[gateway.id,call.id,gateway.device_epoch,sequence,JSON.stringify({callId:call.id,deviceCallId:call.device_call_id})])).rows[0].id;insertedGatewayId=gateway.id;}
   const attempts=Number(job.attempts)+(commandId&&!(pending.rowCount&&pending.rows[0].live)?1:0),backoff=Math.min(60,5*2**Math.min(attempts,4));
   await c.query(`UPDATE call_records SET state=CASE WHEN $2::uuid IS NULL THEN 'unknown'::call_state ELSE 'ending'::call_state END,failure_reason=COALESCE(failure_reason,'session_revoked') WHERE id=$1`,[call.id,commandId]);
   await c.query(`UPDATE session_revoked_call_cleanups SET attempts=$2,last_command_id=$3,last_error=CASE WHEN $3::uuid IS NULL THEN 'telecom_not_confirmed' ELSE NULL END,next_attempt_at=now()+$4::int*interval '1 second',updated_at=now() WHERE call_id=$1`,[call.id,attempts,commandId,backoff]);
   await c.query('COMMIT');return{callId,closeMedia:true,...(insertedGatewayId?{notifyGatewayId:insertedGatewayId}:{})};
   }catch(error){await safeRollback(c);throw error;}
  });
 }
}
