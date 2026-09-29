import {randomUUID} from 'node:crypto';
import type {Db} from './db.js';
import type {FcmClient,FcmEvent} from './fcm.js';
import {annotateNumbers} from './contacts/repository.js';
import {diag,errorReason,throttled} from './diag.js';

export class AndroidPushWorker {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<number>;
  constructor(private db:Db,private sender:Pick<FcmClient,'send'>,private options:{onlineSeconds?:number;intervalMs?:number;batchSize?:number}={}){}
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tickOnce().catch(()=>{});},this.options.intervalMs??1000);this.timer.unref();}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running;}
  tickOnce():Promise<number>{if(this.running)return this.running;this.running=this.run().catch(error=>{if(throttled('push.worker_error:fcm'))diag(this.db,'push.worker_error',{worker:'fcm',reason:errorReason(error)},{level:'warn'});throw error;}).finally(()=>{this.running=undefined;});return this.running;}
  private async run(){
    const online=this.options.onlineSeconds??30,batch=this.options.batchSize??4;
    if(online<5||online>300||batch<1||batch>16)throw new Error('Invalid Android push worker bounds');
    await this.db.query(`INSERT INTO android_push_deliveries(call_id,registration_id,session_id,event)
      SELECT c.id,p.id,p.session_id,'call.incoming' FROM call_records c JOIN gateways g ON g.id=c.gateway_id
      JOIN push_registrations p ON p.user_id=c.snapshot_owner_id JOIN sessions s ON s.id=p.session_id
      -- S22 decision 4: an ai-mode call owned by a live AI run never rings any client.
      WHERE c.state='incoming_ringing' AND NOT (c.mode_snapshot='ai' AND c.ai_run_id IS NOT NULL) AND c.started_at>now()-interval '2 minutes' AND p.platform='android' AND p.disabled_at IS NULL AND p.fcm_token IS NOT NULL
      AND s.revoked_at IS NULL AND s.refresh_expires_at>now() AND g.control_enabled AND g.telephony_ready AND g.media_ready
      -- S72 B4: an internal call never rings the session that is dialing its other leg.
      AND NOT EXISTS(SELECT 1 FROM call_records oc WHERE oc.id=c.peer_call_id AND oc.originating_session_id=p.session_id)
      AND g.last_seen_at>now()-($1::text||' seconds')::interval ON CONFLICT DO NOTHING`,[online]);
    await this.db.query(`INSERT INTO android_push_deliveries(call_id,registration_id,session_id,event)
      SELECT incoming.call_id,incoming.registration_id,incoming.session_id,'call.cancelled' FROM android_push_deliveries incoming
      JOIN call_records c ON c.id=incoming.call_id WHERE incoming.event='call.incoming' AND (incoming.state='delivered' OR incoming.attempts>0) AND c.state<>'incoming_ringing'
      ON CONFLICT DO NOTHING`);
    await this.db.query(`UPDATE android_push_deliveries d SET state='cancelled',last_error='call_no_longer_ringing',updated_at=now()
      FROM call_records c WHERE d.call_id=c.id AND d.event='call.incoming' AND d.state='pending' AND c.state<>'incoming_ringing'`);
    const lease=randomUUID();
    const jobs=await this.db.query(`WITH ready AS (SELECT id FROM android_push_deliveries WHERE state='pending' AND next_attempt_at<=now()
      AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
      UPDATE android_push_deliveries d SET lease_id=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1,updated_at=now()
      FROM ready WHERE d.id=ready.id RETURNING d.*`,[lease,batch]);
    await Promise.all(jobs.rows.map(job=>this.deliver(job)));
    return jobs.rowCount??0;
  }
  private async deliver(job:any){
    const common=`p.id=$2 AND p.session_id=$3 AND p.platform='android' AND p.package_name='org.vodog' AND p.disabled_at IS NULL AND p.fcm_token IS NOT NULL
      AND s.revoked_at IS NULL AND s.refresh_expires_at>now() AND c.snapshot_owner_id=p.user_id`;
    const event=job.event as FcmEvent;
    const condition=event==='call.incoming'
      ? `c.state='incoming_ringing' AND NOT (c.mode_snapshot='ai' AND c.ai_run_id IS NOT NULL) AND c.started_at>now()-interval '2 minutes' AND g.control_enabled AND g.telephony_ready AND g.media_ready AND g.last_seen_at>now()-($4::text||' seconds')::interval`
      : `c.state<>'incoming_ringing'`;
    const params=event==='call.incoming'
      ? [job.call_id,job.registration_id,job.session_id,this.options.onlineSeconds??30]
      : [job.call_id,job.registration_id,job.session_id];
    const row=(await this.db.query(`SELECT p.fcm_token,c.remote_number,c.snapshot_owner_id,sim.country_iso
      FROM push_registrations p JOIN sessions s ON s.id=p.session_id
      JOIN call_records c ON c.id=$1 JOIN gateways g ON g.id=c.gateway_id
      LEFT JOIN sims sim ON sim.id=c.sim_id WHERE ${common} AND ${condition}`,
      params)).rows[0];
    if(!row){await this.finish(job,'cancelled','destination_or_call_inactive');return;}
    // S21 §A: the incoming-call notification title uses the owner's own contact name when known.
    const contactName=event==='call.incoming'
      ? await annotateNumbers(this.db,row.snapshot_owner_id,[{remoteNumber:row.remote_number,countryIso:row.country_iso}],'call')
          .then(([annotation])=>annotation?.contactName??null).catch(()=>null)
      : null;
    try{
      const result=await this.sender.send({token:row.fcm_token,event,callId:job.call_id,notificationId:job.id,contactName,remoteNumber:event==='call.incoming'?row.remote_number:null});
      if(result.status>=200&&result.status<300){await this.finish(job,'delivered',null);return;}
      if(result.reason==='UNREGISTERED')await this.db.query('UPDATE push_registrations SET fcm_token=NULL,updated_at=now() WHERE id=$1 AND fcm_token=$2',[job.registration_id,row.fcm_token]);
      const retry=(result.status===401||result.status===429||result.status>=500)&&job.attempts<3;
      await this.finish(job,retry?'pending':'failed',`FCM_${result.status}_${result.reason??'REJECTED'}`);
    }catch{await this.finish(job,job.attempts<3?'pending':'failed','FCM_CONNECTION_FAILED');}
  }
  private async finish(job:any,state:'pending'|'delivered'|'failed'|'cancelled',error:string|null){
    // S36 C3: queued -> delivered/failed latency for the FCM push that wakes an Android client.
    if(state==='delivered'||state==='failed')diag(this.db,'push.fcm',{platform:'android',state,event:job.event,ms:Date.now()-new Date(job.created_at).getTime(),attempt:Number(job.attempts),reason:error},{callId:job.call_id,level:state==='failed'?'warn':'info'});
    const delay=Math.min(60,5*Math.pow(2,Math.max(0,Number(job.attempts)-1)));
    await this.db.query(`UPDATE android_push_deliveries SET state=$3,last_error=$4,lease_id=NULL,lease_until=NULL,
      next_attempt_at=now()+($5::text||' seconds')::interval,updated_at=now() WHERE id=$1 AND lease_id=$2`,[job.id,job.lease_id,state,error,delay]);
  }
}
