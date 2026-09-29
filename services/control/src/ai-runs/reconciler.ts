import type {PoolClient} from 'pg';
import {safeRollback,withClient,type Db} from '../db.js';
import {releaseRingingCall} from './repository.js';
import {workerError} from '../diag.js';

export type AiRunReconcilerOptions={intervalMs?:number;batch?:number;onlineSeconds?:number;onMediaClose?:(callId:string)=>Promise<void>;beforeProcess?:(runId:string)=>Promise<void>;
  /** S20 D4: rung after the inserting transaction committed, never inside it. */
  onCommandInserted?:(gatewayId:string)=>void};

export class AiRunReconciler{
  private timer:NodeJS.Timeout|null=null;
  private running:Promise<void>|null=null;
  private stopped=true;
  private readonly intervalMs:number;
  private readonly batch:number;
  private readonly onlineSeconds:number;
  private readonly onMediaClose:(callId:string)=>Promise<void>;
  private readonly beforeProcess?:(runId:string)=>Promise<void>;
  private readonly onCommandInserted?:(gatewayId:string)=>void;
  constructor(private readonly db:Db,options:AiRunReconcilerOptions={}){
    this.intervalMs=Math.max(250,options.intervalMs??1000);
    this.batch=Math.min(50,Math.max(1,options.batch??10));
    this.onlineSeconds=Math.min(300,Math.max(5,options.onlineSeconds??30));
    this.onMediaClose=options.onMediaClose??(async()=>{});
    this.beforeProcess=options.beforeProcess;
    this.onCommandInserted=options.onCommandInserted;
  }
  start(){if(!this.stopped)return;this.stopped=false;this.schedule(0);}
  async stop(){this.stopped=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}await this.running;}
  private schedule(delay:number){if(this.stopped)return;this.timer=setTimeout(()=>{this.timer=null;this.running=this.tickOnce().then(()=>undefined,error=>workerError(this.db,'ai_run_reconciler',error)).finally(()=>{this.running=null;this.schedule(this.intervalMs);});},delay);this.timer.unref();}
  async tickOnce():Promise<number>{
    // Cleanup states are intentionally scanned regardless of AI feature flags.
    const due=await this.db.query(`SELECT id FROM ai_call_runs WHERE
      (state='preparing' AND lease_until<=now() AND COALESCE(next_attempt_at,lease_until)<=now()) OR
      (state IN ('answer_committed','awaiting_active','active') AND lease_until<=now() AND COALESCE(next_attempt_at,lease_until)<=now()) OR
      (state IN ('ending','reconcile_unknown') AND COALESCE(next_attempt_at,now())<=now()) OR
      -- S22 decision 5: a run nobody ever claimed (dead Voice worker) suppresses ringing forever.
      (state='pending' AND COALESCE(next_attempt_at,trigger_at)<=now()-interval '15 seconds')
      ORDER BY COALESCE(next_attempt_at,lease_until,trigger_at),id LIMIT $1`,[this.batch]);
    let count=0;
    for(const row of due.rows){
      try{
        await this.beforeProcess?.(row.id);
        const result=await this.process(row.id);if(result){count++;
          // The hangup is durable at this point; waking the gateway now skips a poll interval.
          if(result.notifyGatewayId)this.onCommandInserted?.(result.notifyGatewayId);
          if(result.closeMedia)await this.onMediaClose(result.callId).catch(error=>workerError(this.db,'ai_run_reconciler.media_close',error));}
      }catch(error){
        workerError(this.db,'ai_run_reconciler',error);
        await this.db.query(`UPDATE ai_call_runs SET failure_code='reconciler_error',next_attempt_at=now()+interval '5 seconds',updated_at=now()
          WHERE id=$1 AND state IN ('pending','preparing','answer_committed','awaiting_active','active','ending','reconcile_unknown')`,[row.id]).catch(error=>workerError(this.db,'ai_run_reconciler.mark',error));
      }
    }
    return count;
  }
  private async process(runId:string):Promise<{callId:string;closeMedia:boolean;notifyGatewayId?:string}|null>{
    const target=await this.db.query(`SELECT gateway_id,call_id FROM ai_call_runs WHERE id=$1`,[runId]);
    if(!target.rowCount)return null;
    let insertedGatewayId:string|null=null;
    return withClient(this.db,async c=>{
     try{
      await c.query('BEGIN');
      const gateway=(await c.query(`SELECT * FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id])).rows[0];
      const call=(await c.query(`SELECT * FROM call_records WHERE id=$1 FOR UPDATE`,[target.rows[0].call_id])).rows[0];
      const run=(await c.query(`SELECT *,lease_until<=now() lease_due,COALESCE(next_attempt_at,lease_until,now())<=now() retry_due,
        COALESCE(next_attempt_at,trigger_at)<=now()-interval '15 seconds' pending_stale FROM ai_call_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];
      if(!run||!call){await c.query('ROLLBACK');return null;}
      const due=(run.state==='preparing'&&run.lease_due&&run.retry_due)||
        (['answer_committed','awaiting_active','active'].includes(run.state)&&run.lease_due&&run.retry_due)||
        (['ending','reconcile_unknown'].includes(run.state)&&run.retry_due)||
        (run.state==='pending'&&run.pending_stale);
      if(!due){await c.query('ROLLBACK');return null;}
      if(['ended','failed'].includes(call.state)){
        // S27 失败记录 6: the worker's last transcript flush arrives after the hangup; the identity stays
        // so that flush can still be authenticated for a grace window (`assertLeaseOrJustEnded`).
        await c.query(`UPDATE ai_call_runs SET state='ended',ended_at=COALESCE(ended_at,now()),cleanup_required=false,
          lease_until=NULL,updated_at=now() WHERE id=$1`,[run.id]);
        await c.query('COMMIT');return{callId:call.id,closeMedia:Boolean(run.media_attempted_at)};
      }
      // S22 decision 5: a `pending` run that no worker ever claimed is terminal, and the call goes
      // back to normal ringing. A late ring beats a silently dropped customer call.
      if(run.state==='pending'){
        await c.query(`UPDATE ai_call_runs SET state='lost_race',next_attempt_at=NULL,failure_code='worker_unavailable',
          lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now() WHERE id=$1`,[run.id]);
        await releaseRingingCall(c,{callId:call.id,runId:run.id,reason:'ai_worker_unavailable'});
        await c.query('COMMIT');return{callId:call.id,closeMedia:false};
      }
      if(run.state==='preparing'&&run.lease_until&&new Date(run.lease_until).getTime()<=Date.now()&&!run.answer_command_id&&!run.media_attempted_at){
        const next=call.state==='incoming_ringing'&&Number(run.attempts)<3?'pending':'lost_race';
        await c.query(`UPDATE ai_call_runs SET state=$2,next_attempt_at=CASE WHEN $2='pending' THEN now()+interval '2 seconds' ELSE NULL END,
          failure_code='lease_expired_before_answer',lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now() WHERE id=$1`,[run.id,next]);
        // Only the terminal branch releases the call: a `pending` retry still needs `call.ai_run_id`
        // to point at this run, or `claimAiRun` would never see it again.
        if(next==='lost_race')await releaseRingingCall(c,{callId:call.id,runId:run.id,reason:'lease_expired_before_answer'});
        await c.query('COMMIT');return{callId:call.id,closeMedia:false};
      }
      const postEffect=Boolean(run.answer_command_id||run.media_attempted_at||['answer_committed','awaiting_active','active','ending','reconcile_unknown'].includes(run.state));
      if(!postEffect){await c.query('ROLLBACK');return null;}
      const online=gateway.control_enabled&&gateway.telephony_ready&&gateway.last_seen_at&&Date.now()-new Date(gateway.last_seen_at).getTime()<=this.onlineSeconds*1000;
      const snapshot=await c.query(`SELECT generation,calls,observed_at>=now()-$3::int*interval '1 second' fresh FROM gateway_telecom_snapshots WHERE gateway_id=$1 AND generation=$2 FOR UPDATE`,[gateway.id,gateway.device_epoch,this.onlineSeconds]);
      const present=Boolean(call.device_call_id&&snapshot.rowCount&&snapshot.rows[0].fresh&&(snapshot.rows[0].calls as any[]).filter(item=>item.callId===call.id&&item.deviceCallId===call.device_call_id).length===1);
      let commandId=run.hangup_command_id as string|null;
      if(online&&present){
        if(Number(call.generation)!==Number(gateway.device_epoch)){
          await c.query(`UPDATE commands SET status='rejected',result='{"reason":"superseded_device_epoch"}' WHERE call_id=$1 AND status='pending'`,[call.id]);
          await c.query(`UPDATE call_records SET generation=$2 WHERE id=$1`,[call.id,gateway.device_epoch]);
          await c.query(`UPDATE gateway_call_locks SET generation=$2 WHERE call_id=$1`,[call.id,gateway.device_epoch]);
        }
        const pending=await c.query(`SELECT id FROM commands WHERE call_id=$1 AND kind='hangup' AND status='pending' AND expires_at>now() ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,[call.id]);
        if(pending.rowCount)commandId=pending.rows[0].id;
        else{
          await c.query(`UPDATE commands SET status='expired',result='{"reason":"expired"}' WHERE call_id=$1 AND kind='hangup' AND status='pending' AND expires_at<=now()`,[call.id]);
          const sequence=Number(gateway.command_sequence)+1;
          await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[gateway.id,sequence]);
          commandId=(await c.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)
            VALUES($1,$2,$3,$4,'hangup',$5,now()+interval '15 seconds') RETURNING id`,[
              gateway.id,call.id,gateway.device_epoch,sequence,JSON.stringify({callId:call.id,deviceCallId:call.device_call_id}),
            ])).rows[0].id;
          insertedGatewayId=gateway.id;
        }
        await c.query(`UPDATE call_records SET state='ending',generation=$2,failure_reason=COALESCE(failure_reason,'ai_worker_unavailable') WHERE id=$1`,[call.id,gateway.device_epoch]);
        await c.query(`UPDATE ai_call_runs SET state='ending',cleanup_required=true,hangup_command_id=$2,next_attempt_at=now()+interval '5 seconds',
          lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now() WHERE id=$1`,[run.id,commandId]);
      }else{
        await c.query(`UPDATE call_records SET state='unknown',failure_reason=COALESCE(failure_reason,'ai_cleanup_waiting_for_telecom') WHERE id=$1 AND state NOT IN ('ended','failed')`,[call.id]);
        await c.query(`UPDATE ai_call_runs SET state='reconcile_unknown',cleanup_required=true,next_attempt_at=now()+interval '5 seconds',
          lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now() WHERE id=$1`,[run.id]);
      }
      await c.query('COMMIT');return{callId:call.id,closeMedia:Boolean(run.media_attempted_at),...(insertedGatewayId?{notifyGatewayId:insertedGatewayId}:{})};
     }catch(error){await safeRollback(c);throw error;}
    });
  }
}
