import {randomUUID} from 'node:crypto';
import type {PoolClient,QueryResult} from 'pg';
import {safeRollback,withClient,type Db} from './db.js';
import {diag,workerError} from './diag.js';
import {cancelUndeliveredDial} from './dial-cancel.js';

export const WEB_CALL_LIVENESS_TTL_SECONDS=15;
export type WebCallLivenessDto={mediaEpoch:number;revision:number;expiresAt:Date};
type Queryable={query:(text:string,values?:unknown[])=>Promise<QueryResult<any>>};
type WebPrincipal={sessionId:string;clientType:'web'|'native';platform:'web'|'ios'|'android'|'macos'|null};

export class WebCallLivenessError extends Error{
 constructor(readonly status:number,readonly code:string,message:string){super(message);}
}

const dto=(row:any):WebCallLivenessDto=>({mediaEpoch:Number(row.media_epoch),revision:Number(row.revision),expiresAt:row.expires_at});
export const isWebCallPrincipal=(p:WebPrincipal)=>p.clientType==='web'&&p.platform==='web';

export async function createInitialWebCallLease(c:PoolClient,enabled:boolean,p:WebPrincipal,call:{id:string;media_epoch:unknown}):Promise<WebCallLivenessDto|null>{
 if(!enabled||!isWebCallPrincipal(p))return null;
 const q=await c.query(`INSERT INTO web_call_liveness_leases(call_id,session_id,media_epoch,expires_at)
   SELECT $1,s.id,$3,now()+$4::int*interval '1 second' FROM sessions s
   WHERE s.id=$2 AND s.client_type='web' AND s.platform='web' AND s.revoked_at IS NULL AND s.access_expires_at>now()
   ON CONFLICT(call_id) DO NOTHING RETURNING media_epoch,revision,expires_at`,[call.id,p.sessionId,Number(call.media_epoch),WEB_CALL_LIVENESS_TTL_SECONDS]);
 if(q.rowCount)return dto(q.rows[0]);
 const existing=await readWebCallLease(c,call.id,p.sessionId);
 if(existing)return existing;
 throw new Error('Web call liveness lease could not be created for the authenticated session');
}

export async function readWebCallLease(db:Queryable,callId:string,sessionId:string):Promise<WebCallLivenessDto|null>{
 const q=await db.query(`SELECT lease.media_epoch,lease.revision,lease.expires_at FROM web_call_liveness_leases lease
   JOIN call_records call ON call.id=lease.call_id JOIN sessions session ON session.id=lease.session_id
   WHERE lease.call_id=$1 AND lease.session_id=$2 AND lease.state='active' AND lease.expires_at>now()
     AND lease.media_epoch=call.media_epoch
     AND (CASE WHEN call.direction='incoming' THEN call.claimed_by_session_id ELSE call.originating_session_id END)=lease.session_id
     AND call.state IN ('outgoing_pending','connecting','active')
     AND session.client_type='web' AND session.platform='web' AND session.revoked_at IS NULL AND session.access_expires_at>now()`,[callId,sessionId]);
 return q.rowCount?dto(q.rows[0]):null;
}

export async function closeWebCallLease(c:PoolClient,callId:string):Promise<void>{
 await c.query(`UPDATE web_call_liveness_leases SET state='closed',updated_at=now() WHERE call_id=$1 AND state<>'closed'`,[callId]);
}

export async function markWebCallLeaseForCleanup(c:PoolClient,callId:string,command?:{id:string;expires_at:unknown}|null):Promise<void>{
 await c.query(`UPDATE web_call_liveness_leases SET state='expired',expired_at=COALESCE(expired_at,now()),revision=revision+1,
   last_command_id=COALESCE($2,last_command_id),next_attempt_at=COALESCE($3::timestamptz,next_attempt_at,now()),updated_at=now()
   WHERE call_id=$1 AND state<>'closed'`,[callId,command?.id??null,command?.expires_at??null]);
}

export async function renewWebCallLease(db:Db,input:{callId:string;sessionId:string;clientType:'web'|'native';platform:'web'|'ios'|'android'|'macos'|null;mediaEpoch:number;expectedRevision:number}):Promise<WebCallLivenessDto>{
 if(input.clientType!=='web'||input.platform!=='web')throw new WebCallLivenessError(404,'NOT_FOUND','Call liveness lease not found');
 const q=await db.query(`UPDATE web_call_liveness_leases lease SET revision=lease.revision+1,
     expires_at=now()+$5::int*interval '1 second',updated_at=now()
   FROM call_records call,sessions session
   WHERE lease.call_id=$1 AND lease.session_id=$2 AND lease.media_epoch=$3 AND lease.revision=$4
     AND lease.state='active' AND lease.expires_at>now()
     AND call.id=lease.call_id AND call.media_epoch=lease.media_epoch
     AND (CASE WHEN call.direction='incoming' THEN call.claimed_by_session_id ELSE call.originating_session_id END)=lease.session_id
     AND call.state IN ('outgoing_pending','connecting','active')
     AND session.id=lease.session_id AND session.client_type='web' AND session.platform='web'
     AND session.revoked_at IS NULL AND session.access_expires_at>now()
   RETURNING lease.media_epoch,lease.revision,lease.expires_at`,[input.callId,input.sessionId,input.mediaEpoch,input.expectedRevision,WEB_CALL_LIVENESS_TTL_SECONDS]);
 if(q.rowCount)return dto(q.rows[0]);
 const visible=await db.query(`SELECT 1 FROM call_records WHERE id=$1 AND snapshot_owner_id=(SELECT user_id FROM sessions WHERE id=$2)`,[input.callId,input.sessionId]);
 if(!visible.rowCount)throw new WebCallLivenessError(404,'NOT_FOUND','Call liveness lease not found');
 throw new WebCallLivenessError(409,'CALL_LIVENESS_CONFLICT','Call liveness lease is expired or has changed');
}

type ExpiryResult={callId:string;closeMedia:boolean;notifyGatewayId?:string};
export type WebCallLivenessWorkerOptions={enabled:boolean;intervalMs?:number;batch?:number;gatewayOnlineSeconds?:number;onMediaClose?:(callId:string)=>Promise<void>;
 /** S20 D4: rung after the inserting transaction committed, never inside it. */
 onCommandInserted?:(gatewayId:string)=>void};

export class WebCallLivenessWorker{
 private timer:NodeJS.Timeout|null=null;
 private running:Promise<void>|null=null;
 private stopped=true;
 private readonly intervalMs:number;
 private readonly batch:number;
 private readonly gatewayOnlineSeconds:number;
 private readonly onMediaClose:(callId:string)=>Promise<void>;
 private readonly onCommandInserted?:(gatewayId:string)=>void;
 constructor(private readonly db:Db,private readonly options:WebCallLivenessWorkerOptions){
  this.intervalMs=Math.max(250,options.intervalMs??1000);this.batch=Math.min(100,Math.max(1,options.batch??20));this.gatewayOnlineSeconds=Math.min(300,Math.max(5,options.gatewayOnlineSeconds??30));
  this.onMediaClose=options.onMediaClose??(async()=>{});
  this.onCommandInserted=options.onCommandInserted;
 }
 start(){if(!this.options.enabled||!this.stopped)return;this.stopped=false;this.schedule(0);}
 async stop(){this.stopped=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}await this.running;}
 private schedule(delay:number){if(this.stopped)return;this.timer=setTimeout(()=>{this.timer=null;this.running=this.tickOnce().then(()=>undefined,error=>workerError(this.db,'web_call_liveness',error)).finally(()=>{this.running=null;this.schedule(this.intervalMs);});},delay);this.timer.unref();}
 async tickOnce():Promise<number>{
  if(!this.options.enabled)return 0;
  const due=await this.db.query(`SELECT call_id,revision FROM web_call_liveness_leases
    WHERE (state='active' AND expires_at<=now()) OR (state='expired' AND next_attempt_at<=now())
    ORDER BY COALESCE(next_attempt_at,expires_at),call_id LIMIT $1`,[this.batch]);
  let processed=0;
  for(const candidate of due.rows){const result=await this.process(candidate.call_id,Number(candidate.revision));if(result){processed++;if(result.notifyGatewayId)this.onCommandInserted?.(result.notifyGatewayId);if(result.closeMedia)await this.onMediaClose(result.callId).catch(error=>workerError(this.db,'web_call_liveness.media_close',error));}}
  return processed;
 }
 private async process(callId:string,revision:number):Promise<ExpiryResult|null>{
  const lookup=await this.db.query(`SELECT call.gateway_id FROM web_call_liveness_leases lease JOIN call_records call ON call.id=lease.call_id WHERE lease.call_id=$1`,[callId]);
  if(!lookup.rowCount)return null;
  let insertedGatewayId:string|null=null;
  return withClient(this.db,async c=>{
   try{
   await c.query('BEGIN');
   await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[lookup.rows[0].gateway_id]);
   const q=await c.query(`SELECT lease.*,lease.expires_at<=now() expires_due,call.gateway_id,call.direction,call.state call_state,call.generation,call.media_epoch call_media_epoch,call.media_node_id,
       call.claimed_by_session_id,call.originating_session_id,call.device_call_id,gateway.device_epoch,gateway.command_sequence,
       session.client_type lease_client_type,session.platform lease_platform,
       gateway.control_enabled AND gateway.telephony_ready AND gateway.last_seen_at>=now()-$2::int*interval '1 second' gateway_ready
     FROM web_call_liveness_leases lease JOIN call_records call ON call.id=lease.call_id JOIN gateways gateway ON gateway.id=call.gateway_id
     JOIN sessions session ON session.id=lease.session_id
     WHERE lease.call_id=$1 FOR UPDATE OF call,lease`,[callId,this.gatewayOnlineSeconds]);
   if(!q.rowCount||Number(q.rows[0].revision)!==revision){await c.query('ROLLBACK');return null;}
   const row=q.rows[0],owner=row.direction==='incoming'?row.claimed_by_session_id:row.originating_session_id;
   if(['ending','ended','failed','unknown'].includes(row.call_state)||owner!==row.session_id||Number(row.media_epoch)!==Number(row.call_media_epoch)||row.lease_client_type!=='web'||row.lease_platform!=='web'){
    await c.query(`UPDATE web_call_liveness_leases SET state='closed',updated_at=now() WHERE call_id=$1 AND revision=$2`,[callId,revision]);
    await c.query('COMMIT');return{callId,closeMedia:false};
   }
   // The dial never reached the gateway: end the call here rather than queue a hangup it would overtake.
   const cancelledDial=await cancelUndeliveredDial(c,callId,'web_liveness_expired');
   if(cancelledDial){
    await closeWebCallLease(c,callId);
    await c.query('COMMIT');
    diag(this.db,'call.dial_cancelled',{commandId:cancelledDial},{callId});
    return{callId,closeMedia:true};
   }
   const initiallyActive=row.state==='active';
   if(initiallyActive&&!row.expires_due){await c.query('ROLLBACK');return null;}
   if(!initiallyActive&&row.state!=='expired'){await c.query('ROLLBACK');return null;}
   if(Number(row.generation)!==Number(row.device_epoch)){
    const snapshot=await c.query(`SELECT generation,calls,observed_at>=now()-$2::int*interval '1 second' snapshot_fresh FROM gateway_telecom_snapshots WHERE gateway_id=$1 FOR UPDATE`,[row.gateway_id,this.gatewayOnlineSeconds]);
    const recent=snapshot.rowCount&&Number(snapshot.rows[0].generation)===Number(row.device_epoch)&&snapshot.rows[0].snapshot_fresh;
    const matches=recent&&row.device_call_id?(snapshot.rows[0].calls as any[]).filter(call=>call.callId===callId&&call.deviceCallId===row.device_call_id):[];
    if(matches.length!==1){
     await c.query(`UPDATE web_call_liveness_leases SET state='expired',expired_at=COALESCE(expired_at,now()),revision=revision+1,
       next_attempt_at=now()+interval '5 seconds',updated_at=now() WHERE call_id=$1 AND revision=$2`,[callId,revision]);
     await c.query('COMMIT');return{callId,closeMedia:true};
    }
    await c.query(`UPDATE commands SET status='rejected',result='{"reason":"superseded_device_epoch"}' WHERE call_id=$1 AND status='pending'`,[callId]);
    await c.query(`UPDATE call_records SET generation=$2 WHERE id=$1`,[callId,Number(row.device_epoch)]);
    await c.query(`UPDATE gateway_call_locks SET generation=$2 WHERE call_id=$1`,[callId,Number(row.device_epoch)]);
    row.generation=row.device_epoch;
   }
   const pending=await c.query(`SELECT id,expires_at,expires_at>now() command_live FROM commands WHERE call_id=$1 AND kind='hangup' AND status='pending' ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,[callId]);
   if(pending.rowCount&&!pending.rows[0].command_live)await c.query(`UPDATE commands SET status='expired',result='{"reason":"expired"}' WHERE id=$1 AND status='pending'`,[pending.rows[0].id]);
   const hasLive=Boolean(pending.rowCount&&pending.rows[0].command_live);
   let commandId:string|null=hasLive?pending.rows[0].id:null;
   let commandExpiresAt:unknown=hasLive?pending.rows[0].expires_at:null;
   let sequence=Number(row.command_sequence);
   const gatewayReady=Boolean(row.gateway_ready);
   if(!hasLive&&(initiallyActive||gatewayReady)){
    sequence+=1;await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[row.gateway_id,sequence]);
    const command=(await c.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)
      VALUES($1,$2,$3,$4,'hangup',$5,now()+interval '15 seconds') RETURNING id,expires_at`,[row.gateway_id,callId,Number(row.generation),sequence,JSON.stringify({callId,deviceCallId:row.device_call_id})])).rows[0];
    commandId=command.id;commandExpiresAt=command.expires_at;insertedGatewayId=row.gateway_id;
   }
   await c.query(`UPDATE call_records SET state='ending',failure_reason=COALESCE(failure_reason,'web_liveness_expired')
     WHERE id=$1 AND state IN ('outgoing_pending','incoming_ringing','connecting','active')`,[callId]);
   if(commandId&&commandExpiresAt)await c.query(`INSERT INTO media_close_jobs(call_id,node_id,media_epoch,close_mode,attempts,last_error,next_attempt_at,updated_at)
     VALUES($1,COALESCE($2,'relay-primary'),$3,'wait_terminal',0,NULL,$4::timestamptz+interval '5 seconds',now())
     ON CONFLICT(call_id) DO UPDATE SET node_id=excluded.node_id,media_epoch=excluded.media_epoch,
       close_mode=CASE WHEN media_close_jobs.close_mode='force' THEN 'force' ELSE 'wait_terminal' END,
       next_attempt_at=LEAST(media_close_jobs.next_attempt_at,excluded.next_attempt_at),updated_at=now()`,
     [callId,row.media_node_id,Number(row.call_media_epoch),commandExpiresAt]);
   const attempts=Number(row.attempts)+(commandId&&!hasLive?1:0),backoff=Math.min(60,5*2**Math.min(attempts,4));
   const updated=await c.query(`UPDATE web_call_liveness_leases SET state='expired',expired_at=COALESCE(expired_at,now()),revision=revision+1,
     attempts=$3,last_command_id=$4,next_attempt_at=now()+$5::int*interval '1 second',updated_at=now()
     WHERE call_id=$1 AND revision=$2 RETURNING call_id`,[callId,revision,attempts,commandId,backoff]);
   if(!updated.rowCount)throw new Error('Web call liveness CAS lost while rows were locked');
   await c.query('COMMIT');return{callId,closeMedia:false,...(insertedGatewayId?{notifyGatewayId:insertedGatewayId}:{})};
   }catch(error){await safeRollback(c);throw error;}
  });
 }
}
