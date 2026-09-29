import {randomUUID} from 'node:crypto';
import type {Db} from './db.js';
import type {ApnsClient} from './apns.js';
import {annotateNumbers} from './contacts/repository.js';
import {diag,errorReason,throttled} from './diag.js';
export class PushWorker {
 private timer?:ReturnType<typeof setInterval>;
 private running?:Promise<void>;
 constructor(private db:Db,private sender:Pick<ApnsClient,'sendIncoming'>,private onlineSeconds=30){}
 start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{});},1000);this.timer.unref();}
 async stop(){clearInterval(this.timer);this.timer=undefined;await this.running;}
 tick():Promise<void>{if(this.running)return this.running;this.running=this.run().catch(error=>{if(throttled('push.worker_error:apns'))diag(this.db,'push.worker_error',{worker:'apns',reason:errorReason(error)},{level:'warn'});throw error;}).finally(()=>{this.running=undefined;});return this.running;}
 private async run(){
  await this.db.query(`INSERT INTO push_deliveries(call_id,registration_id,session_id)
   SELECT c.id,p.id,p.session_id FROM call_records c JOIN gateways g ON g.id=c.gateway_id
   JOIN push_registrations p ON p.user_id=c.snapshot_owner_id JOIN sessions s ON s.id=p.session_id
   -- S22 decision 4: an ai-mode call owned by a live AI run never rings any client.
   WHERE c.state='incoming_ringing' AND NOT (c.mode_snapshot='ai' AND c.ai_run_id IS NOT NULL) AND c.started_at>now()-interval '2 minutes' AND p.disabled_at IS NULL AND p.voip_token IS NOT NULL
   AND s.revoked_at IS NULL AND s.refresh_expires_at>now() AND g.control_enabled AND g.telephony_ready AND g.media_ready
   -- S72 B4: an internal call never rings the session that is dialing its other leg.
   AND NOT EXISTS(SELECT 1 FROM call_records oc WHERE oc.id=c.peer_call_id AND oc.originating_session_id=p.session_id)
   AND g.last_seen_at>now()-($1::text||' seconds')::interval ON CONFLICT DO NOTHING`,[this.onlineSeconds]);
  const jobs=await this.db.query(`WITH ready AS (SELECT id FROM push_deliveries WHERE state='pending' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 4 FOR UPDATE SKIP LOCKED)
   UPDATE push_deliveries d SET lease_id=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM ready WHERE d.id=ready.id RETURNING d.*`,[randomUUID()]);
  await Promise.all(jobs.rows.map(job=>this.deliver(job)));
 }
 private async deliver(job:any){
  const row=(await this.db.query(`SELECT p.voip_token,p.environment,c.remote_number,c.snapshot_owner_id,sim.country_iso,c.internal_call,
   (SELECT COALESCE(NULLIF(ps.label,''),ps.phone_label) FROM sims ps WHERE ps.id=c.peer_sim_id) peer_sim_label,COALESCE(NULLIF(sim.label,''),sim.phone_label) sim_label
   FROM push_registrations p JOIN sessions s ON s.id=p.session_id
   JOIN call_records c ON c.id=$1 AND c.snapshot_owner_id=p.user_id JOIN gateways g ON g.id=c.gateway_id
   LEFT JOIN sims sim ON sim.id=c.sim_id
   WHERE p.id=$2 AND p.session_id=$3 AND p.disabled_at IS NULL AND p.voip_token IS NOT NULL
   AND s.revoked_at IS NULL AND s.refresh_expires_at>now() AND c.state='incoming_ringing' AND NOT (c.mode_snapshot='ai' AND c.ai_run_id IS NOT NULL)
   AND c.started_at>now()-interval '2 minutes' AND g.control_enabled AND g.telephony_ready AND g.media_ready
   AND g.last_seen_at>now()-($4::text||' seconds')::interval`,[job.call_id,job.registration_id,job.session_id,this.onlineSeconds])).rows[0];
  if(!row){await this.finish(job,'cancelled','destination_or_call_inactive');return;}
  // S21 §A: the caller's own address-book name so CallKit can show it. Never the number itself.
  const contactName=await annotateNumbers(this.db,row.snapshot_owner_id,[{remoteNumber:row.remote_number,countryIso:row.country_iso}],'call')
   .then(([annotation])=>annotation?.contactName??null).catch(()=>null);
  try{
   const result=await this.sender.sendIncoming({token:row.voip_token,environment:row.environment,callId:job.call_id,notificationId:job.id,contactName,remoteNumber:row.remote_number,internal:row.internal_call===true,peerSimLabel:row.peer_sim_label??null,simLabel:row.sim_label??null});
   if(result.status===200){await this.finish(job,'delivered',null);return;}
   if(result.status===410||result.reason==='BadDeviceToken'||result.reason==='DeviceTokenNotForTopic')await this.db.query('UPDATE push_registrations SET voip_token=NULL,updated_at=now() WHERE id=$1 AND voip_token=$2 AND environment=$3',[job.registration_id,row.voip_token,row.environment]);
   const retry=(result.status===429||result.status>=500)&&job.attempts<3;
   await this.finish(job,retry?'pending':'failed',`APNS_${result.status}_${result.reason??'rejected'}`);
  }catch{await this.finish(job,job.attempts<3?'pending':'failed','APNS_CONNECTION_FAILED');}
 }
 private async finish(job:any,state:string,error:string|null){
  // S36 C3: queued -> delivered/failed latency for the VoIP push that wakes an iPhone.
  if(state==='delivered'||state==='failed')diag(this.db,'push.apns',{platform:'ios',state,ms:Date.now()-new Date(job.created_at).getTime(),attempt:Number(job.attempts),reason:error},{callId:job.call_id,level:state==='failed'?'warn':'info'});
  await this.db.query(`UPDATE push_deliveries SET state=$3,last_error=$4,lease_id=NULL,lease_until=NULL,next_attempt_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1 AND lease_id=$2`,[job.id,job.lease_id,state,error]);
 }
}
