import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {Db} from './db.js';
import type {ApnsClient} from './apns.js';
import type {FcmClient} from './fcm.js';
import {diag,errorReason,throttled} from './diag.js';

/** S67 rule 1: an ended, unblocked incoming call nobody has looked at that was missed or that AI actually answered. */
export const PENDING_CALL=`c.direction='incoming' AND c.state IN ('ended','failed') AND c.seen_at IS NULL
 AND NOT c.internal_call AND c.failure_reason IS DISTINCT FROM 'number_blocked'
 AND (c.answered_at IS NULL OR c.conflict_disposition='ai_answered'
  OR EXISTS(SELECT 1 FROM ai_call_runs r WHERE r.call_id=c.id AND r.state NOT IN ('pending','preparing','failed_before_answer','lost_race')))`;
/**
 * S72 D7, `session` = SQL placeholder of the requesting session. Terminal: an internal call is one row,
 * its incoming leg (the outgoing leg hides while that leg exists; no FK, so EXISTS). Live: every
 * session keeps the outgoing leg (the dialer's media tracks it), and the incoming leg is hidden only
 * from the session dialing its peer, so that session never rings for its own call.
 */
export const visibleCall=(session:string)=>`(CASE WHEN c.state IN ('ended','failed')
 THEN NOT (c.internal_call AND c.direction='outgoing' AND EXISTS(SELECT 1 FROM call_records pc WHERE pc.id=c.peer_call_id))
 ELSE NOT (c.internal_call AND c.direction='incoming' AND EXISTS(SELECT 1 FROM call_records pc WHERE pc.id=c.peer_call_id AND pc.originating_session_id=${session}::uuid)) END)`;
const UNREAD_SMS=`m.direction='incoming' AND m.read_at IS NULL`;
const COUNTS=`SELECT c.sim_id,count(*)::int calls,0 sms FROM call_records c WHERE c.snapshot_owner_id=$1 AND ${PENDING_CALL} GROUP BY c.sim_id
 UNION ALL SELECT m.sim_id,0,count(*)::int FROM sms_messages m WHERE m.snapshot_owner_id=$1 AND ${UNREAD_SMS} GROUP BY m.sim_id`;

export async function readBadges(db:Db,ownerId:string){
  const rows=(await db.query(`SELECT sim_id,sum(calls)::int calls,sum(sms)::int sms FROM (${COUNTS}) x GROUP BY sim_id ORDER BY sim_id`,[ownerId])).rows;
  const sims=rows.map(row=>({simId:row.sim_id as string,calls:row.calls as number,sms:row.sms as number}));
  return {calls:sims.reduce((n,s)=>n+s.calls,0),sms:sims.reduce((n,s)=>n+s.sms,0),sims};
}

/** `auth(req,mutation)` returns the session user id; only mutations run the cookie origin check. */
export function registerBadgeRoutes(app:FastifyInstance,db:Db,auth:(request:FastifyRequest,mutation:boolean)=>string){
  app.get('/api/v1/badges',async req=>readBadges(db,auth(req,false)));
  app.post('/api/v1/calls/:id/seen',async (req,reply)=>{
    const ownerId=auth(req,true);const {id}=z.object({id:z.uuid()}).parse(req.params);
    // Idempotent: only a pending row gets seen_at; any other own row is a no-op 204.
    const result=await db.query(`UPDATE call_records c SET seen_at=CASE WHEN ${PENDING_CALL} THEN now() ELSE c.seen_at END WHERE c.id=$1 AND c.snapshot_owner_id=$2`,[id,ownerId]);
    if(!result.rowCount)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Call not found'}});
    return reply.code(204).send();
  });
  app.post('/api/v1/sms/read',async req=>{
    const ownerId=auth(req,true);const {ids}=z.object({ids:z.array(z.uuid()).min(1).max(500)}).parse(req.body);
    const result=await db.query(`UPDATE sms_messages m SET read_at=now() WHERE m.id=ANY($1::uuid[]) AND m.snapshot_owner_id=$2 AND ${UNREAD_SMS}`,[[...new Set(ids)],ownerId]);
    return {updated:result.rowCount??0};
  });
}

type Senders={apns?:Pick<ApnsClient,'sendBadge'>|null;fcm?:Pick<FcmClient,'sendBadge'>|null};
export class BadgeWorker {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<number>;
  constructor(private db:Db,private senders:Senders,private options:{enabled:boolean;intervalMs?:number;batchSize?:number}){}
  start(){if(this.timer||!this.options.enabled)return;this.timer=setInterval(()=>{void this.tickOnce().catch(()=>{});},this.options.intervalMs??5000);this.timer.unref();}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running;}
  tickOnce():Promise<number>{
    if(!this.options.enabled)return Promise.resolve(0);
    if(this.running)return this.running;
    this.running=this.run().catch(error=>{if(throttled('push.worker_error:badge'))diag(this.db,'push.worker_error',{worker:'badge',reason:errorReason(error)},{level:'warn'});throw error;}).finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async run(){
    const ios=!!this.senders.apns,android=!!this.senders.fcm;
    if(!ios&&!android)return 0;
    // Same session gate as the call pushes: a revoked login gets no counts.
    const rows=(await this.db.query(`SELECT * FROM (SELECT p.id,p.platform,p.environment,p.apns_token,p.fcm_token,p.badge_sent,k.calls,k.sms,
       (CASE WHEN p.badge_calls THEN k.calls ELSE 0 END)+(CASE WHEN p.badge_sms THEN k.sms ELSE 0 END) value
      FROM push_registrations p JOIN sessions s ON s.id=p.session_id
      CROSS JOIN LATERAL (SELECT COALESCE(sum(calls),0)::int calls,COALESCE(sum(sms),0)::int sms FROM (${COUNTS.replaceAll('$1','p.user_id')}) x) k
      WHERE p.disabled_at IS NULL AND s.revoked_at IS NULL AND s.refresh_expires_at>now()
      AND (p.badge_calls OR p.badge_sms OR COALESCE(p.badge_sent,0)<>0)
      AND (p.badge_retry_at IS NULL OR p.badge_retry_at<=now())
      AND ((p.platform='ios' AND p.apns_token IS NOT NULL AND $1) OR (p.platform='android' AND p.fcm_token IS NOT NULL AND $2))) r
      WHERE r.value IS DISTINCT FROM r.badge_sent ORDER BY r.id LIMIT $3`,[ios,android,this.options.batchSize??50])).rows;
    await Promise.all(rows.map(row=>this.deliver(row)));
    return rows.length;
  }
  private async deliver(row:any){
    let ok=false,status=0,reason:string|null=null,cleared=false;
    try{
      if(row.platform==='ios'){
        const result=await this.senders.apns!.sendBadge({token:row.apns_token,environment:row.environment,badge:row.value});
        ok=result.status===200;status=result.status;reason=result.reason??null;
        if(result.status===410||result.reason==='BadDeviceToken'||result.reason==='DeviceTokenNotForTopic'){cleared=true;await this.db.query('UPDATE push_registrations SET apns_token=NULL,updated_at=now() WHERE id=$1 AND apns_token=$2',[row.id,row.apns_token]);}
      }else{
        const result=await this.senders.fcm!.sendBadge({token:row.fcm_token,notificationId:randomUUID(),badge:row.value,calls:row.calls,sms:row.sms});
        ok=result.status>=200&&result.status<300;status=result.status;reason=result.reason??null;
        if(result.reason==='UNREGISTERED'){cleared=true;await this.db.query('UPDATE push_registrations SET fcm_token=NULL,updated_at=now() WHERE id=$1 AND fcm_token=$2',[row.id,row.fcm_token]);}
      }
    }catch(error){reason??=errorReason(error);}
    // S69: a failed badge push and a dead token are visible, not silent.
    if(cleared)diag(this.db,'badge.token_cleared',{platform:row.platform,registrationId:row.id});
    if(!ok&&throttled(`badge.send_failed:${row.platform}`))diag(this.db,'badge.send_failed',{platform:row.platform,status,reason,registrationId:row.id},{level:'warn'});
    await this.db.query(ok?'UPDATE push_registrations SET badge_sent=$2,badge_retry_at=NULL WHERE id=$1':`UPDATE push_registrations SET badge_retry_at=now()+interval '60 seconds' WHERE id=$1`,ok?[row.id,row.value]:[row.id]);
  }
}
