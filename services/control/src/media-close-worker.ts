import { randomUUID } from 'node:crypto';
import { safeRollback, withClient, type Db } from './db.js';
import { MediaBridgeClient } from './media-client.js';
import { diag, errorReason, workerError } from './diag.js';
type MediaCloser=MediaBridgeClient|{close(callId:string,nodeId:string,mediaEpoch:number):Promise<void>};
type Job={callId:string;nodeId:string;mediaEpoch:number;attempts:number;closeMode:'force'|'wait_terminal'};
export type MediaCloseWorkerOptions={intervalMs?:number;concurrency?:number;leaseSeconds?:number;gatewayOfflineSeconds?:number};

export class MediaCloseWorker {
  private readonly owner=randomUUID();
  private readonly intervalMs:number;
  private readonly concurrency:number;
  private readonly leaseSeconds:number;
  private readonly gatewayOfflineSeconds:number;
  private timer:NodeJS.Timeout|null=null;
  private running:Promise<void>|null=null;
  private stopped=true;

  constructor(private readonly db:Db,private readonly media:MediaCloser,options:MediaCloseWorkerOptions={}){
    this.intervalMs=Math.max(250,options.intervalMs??5000);
    this.concurrency=Math.min(8,Math.max(1,options.concurrency??4));
    this.leaseSeconds=Math.min(300,Math.max(10,options.leaseSeconds??30));
    this.gatewayOfflineSeconds=Math.min(600,Math.max(10,options.gatewayOfflineSeconds??45));
  }

  start(){
    if(!this.stopped)return;
    this.stopped=false;
    this.schedule(0);
  }
  async stop(){
    this.stopped=true;
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    await this.running;
  }
  private schedule(delay:number){
    if(this.stopped)return;
    this.timer=setTimeout(()=>{
      this.timer=null;
      this.running=this.tickOnce().then(()=>undefined,error=>workerError(this.db,'media_close',error)).finally(()=>{
        this.running=null;
        this.schedule(this.intervalMs);
      });
    },delay);
    this.timer.unref();
  }
  async tickOnce():Promise<number>{
    await this.enqueueRevokedCalls();
    const jobs=await this.claim();
    await Promise.all(jobs.map(job=>this.process(job)));
    return jobs.length;
  }
  private async enqueueRevokedCalls(){
    return withClient(this.db,async client=>{
     try{
      await client.query('BEGIN');
      // S18 decision 1: control shutdown and gateway offline stay immediate; a withdrawn
      // mediaReady only ends a call that never pinned a media node or whose withdrawal
      // has been sustained (>=3 heartbeats or >=15 s). S72b: a call answered on the gateway device
      // itself has no remote media, so mediaReady never ends it.
      const calls=await client.query(`UPDATE call_records call SET state='unknown',failure_reason='gateway_media_unavailable'
        FROM gateways gateway WHERE call.gateway_id=gateway.id AND call.state NOT IN ('ending','ended','failed','unknown')
        AND call.originating_platform IS DISTINCT FROM 'pixel'
        AND (NOT gateway.control_enabled OR gateway.last_seen_at IS NULL OR gateway.last_seen_at<now()-$1::int*interval '1 second'
          OR (NOT gateway.media_ready AND call.answered_by_platform IS DISTINCT FROM 'device' AND (call.media_node_id IS NULL OR gateway.media_unready_heartbeats>=3
            OR gateway.media_unready_since<=now()-interval '15 seconds'))) RETURNING call.id`,[this.gatewayOfflineSeconds]);
      if(calls.rowCount)await client.query(`INSERT INTO media_close_jobs(call_id,node_id,media_epoch,next_attempt_at)
        SELECT id,COALESCE(media_node_id,'relay-primary'),media_epoch,now() FROM call_records WHERE id=ANY($1::uuid[])
        ON CONFLICT(call_id) DO NOTHING`,[calls.rows.map(row=>row.id)]);
      await client.query('COMMIT');
     }catch(error){await safeRollback(client);throw error;}
    });
  }
  private async claim():Promise<Job[]>{
    return withClient(this.db,async client=>{
     try{
      await client.query('BEGIN');
      const selected=await client.query(`SELECT call_id,node_id,media_epoch,attempts,close_mode FROM media_close_jobs
        WHERE completed_at IS NULL AND COALESCE(next_attempt_at,now())<=now() AND (lease_until IS NULL OR lease_until<now())
        ORDER BY COALESCE(next_attempt_at,'epoch'::timestamptz),updated_at FOR UPDATE SKIP LOCKED LIMIT $1`,[this.concurrency]);
      if(selected.rowCount){
        await client.query(`UPDATE media_close_jobs SET lease_owner=$1,lease_until=now()+$2::int*interval '1 second',updated_at=now()
          WHERE call_id=ANY($3::uuid[])`,[this.owner,this.leaseSeconds,selected.rows.map(row=>row.call_id)]);
      }
      await client.query('COMMIT');
      return selected.rows.map(row=>({callId:row.call_id,nodeId:row.node_id,mediaEpoch:Number(row.media_epoch),attempts:Number(row.attempts),closeMode:row.close_mode}));
     }catch(error){await safeRollback(client);throw error;}
    });
  }
  private async process(job:Job){
    try{
      if(!await this.prepareClose(job))return;
      if(this.media instanceof MediaBridgeClient)await this.media.close(job.callId,job.mediaEpoch);
      else await this.media.close(job.callId,job.nodeId,job.mediaEpoch);
      await this.db.query(`DELETE FROM media_close_jobs WHERE call_id=$1 AND lease_owner=$2`,[job.callId,this.owner]);
    }catch(error){
      const nextAttempt=job.attempts+1;
      diag(this.db,'media.close_failed',{reason:errorReason(error),attempt:nextAttempt},{callId:job.callId,level:'warn'});
      const backoffSeconds=Math.min(3600,5*2**Math.min(nextAttempt-1,10));
      await this.db.query(`UPDATE media_close_jobs SET attempts=$3,last_error='media_close_failed',next_attempt_at=now()+$4::int*interval '1 second',lease_owner=NULL,lease_until=NULL,completed_at=NULL,updated_at=now()
        WHERE call_id=$1 AND lease_owner=$2`,[job.callId,this.owner,nextAttempt,backoffSeconds]);
    }
  }
  private async prepareClose(job:Job):Promise<boolean>{
    if(job.closeMode!=='wait_terminal')return true;
    const lookup=await this.db.query(`SELECT gateway_id FROM call_records WHERE id=$1`,[job.callId]);
    if(!lookup.rowCount)return false;
    return withClient(this.db,async client=>{
     try{
      await client.query('BEGIN');
      await client.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[lookup.rows[0].gateway_id]);
      const call=(await client.query(`SELECT state FROM call_records WHERE id=$1 FOR UPDATE`,[job.callId])).rows[0];
      const current=(await client.query(`SELECT close_mode,lease_owner,next_attempt_at<=now() due FROM media_close_jobs WHERE call_id=$1 FOR UPDATE`,[job.callId])).rows[0];
      if(!call||!current||current.lease_owner!==this.owner){await client.query('ROLLBACK');return false;}
      if(!current.due){
        await client.query(`UPDATE media_close_jobs SET lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE call_id=$1 AND lease_owner=$2`,[job.callId,this.owner]);
        await client.query('COMMIT');return false;
      }
      if(current.close_mode==='wait_terminal'){
        await client.query(`UPDATE commands SET status='expired',result=COALESCE(result,'{"reason":"expired"}'::jsonb)
          WHERE call_id=$1 AND kind='hangup' AND status='pending' AND expires_at<=now()`,[job.callId]);
        if(!['ended','failed'].includes(call.state))await client.query(`UPDATE call_records SET state='unknown',failure_reason='hangup_terminal_unconfirmed'
          WHERE id=$1 AND state NOT IN ('ended','failed')`,[job.callId]);
        await client.query(`UPDATE media_close_jobs SET close_mode='force',last_error=CASE WHEN $2 THEN last_error ELSE 'hangup_terminal_unconfirmed' END,updated_at=now()
          WHERE call_id=$1 AND lease_owner=$3`,[job.callId,['ended','failed'].includes(call.state),this.owner]);
      }
      await client.query('COMMIT');return true;
     }catch(error){await safeRollback(client);throw error;}
    });
  }
}
