import type {PoolClient} from 'pg';
import {smsFailed} from './diag.js';

/** Caller holds the gateway row lock. No timer or process-local state is authoritative. */
export async function releaseSms(c:PoolClient,gatewayId:string,onlineSeconds:number) {
  const g=(await c.query(`SELECT *,last_seen_at>clock_timestamp()-$2*interval '1 second' online FROM gateways WHERE id=$1 FOR UPDATE`,[gatewayId,onlineSeconds])).rows[0];
  await c.query(`INSERT INTO gateway_sms_pacing(gateway_id) VALUES($1) ON CONFLICT DO NOTHING`,[gatewayId]);
  const pace=(await c.query(`SELECT *,next_release_at<=clock_timestamp() due FROM gateway_sms_pacing WHERE gateway_id=$1`,[gatewayId])).rows[0];
  await c.query(`UPDATE sms_messages m SET state='failed',failure_reason='sms_route_changed_before_release'
    FROM sms_dispatch_queue q,sims s WHERE q.sms_id=m.id AND s.id=m.sim_id AND q.gateway_id=$1
    AND q.released_at IS NULL AND m.state='queued' AND
    (s.owner_user_id IS DISTINCT FROM m.snapshot_owner_id OR s.gateway_id<>q.gateway_id OR s.version<>q.assignment_version
     OR m.generation<>$2 OR NOT s.device_present OR s.assignment_pending) RETURNING m.id`,[gatewayId,g.device_epoch]).then(r=>smsFailed(c,r.rows.map(row=>row.id)));
  if(pace.command_id){
    const active=(await c.query(`SELECT cmd.*,q.first_delivery_at,q.sms_id queued_sms_id,
      (s.owner_user_id IS DISTINCT FROM m.snapshot_owner_id OR s.gateway_id<>cmd.gateway_id OR s.version<>q.assignment_version OR NOT s.device_present OR s.assignment_pending) route_changed
      FROM commands cmd LEFT JOIN sms_dispatch_queue q ON q.command_id=cmd.id
      LEFT JOIN sms_messages m ON m.id=cmd.sms_id LEFT JOIN sims s ON s.id=m.sim_id WHERE cmd.id=$1`,[pace.command_id])).rows[0];
    const invalid=active&&(active.route_changed||Number(active.generation)!==Number(g.device_epoch)||new Date(active.expires_at).getTime()<=Date.now()||active.status!=='pending');
    if(active?.route_changed)await c.query(`UPDATE commands SET status='rejected',result='{"reason":"sim_route_changed"}' WHERE id=$1 AND status='pending'`,[active.id]);
    if(invalid&&active.queued_sms_id&&active.first_delivery_at===null){
      // This queue was created by S48 and no heartbeat ever exposed its command.
      await c.query(`UPDATE commands SET status='expired',result='{"reason":"expired"}' WHERE id=$1 AND status='pending'`,[active.id]);
      await c.query(`UPDATE sms_messages SET state='failed',failure_reason='sms_not_dispatched' WHERE id=$1 AND state IN ('queued','sending') RETURNING id`,[active.sms_id]).then(r=>smsFailed(c,r.rows.map(x=>x.id)));
      await c.query(`UPDATE gateway_sms_pacing SET command_id=NULL WHERE gateway_id=$1`,[gatewayId]);
      pace.command_id=null;
    }else if(invalid){
      await c.query(`UPDATE sms_messages SET state='unknown',failure_reason='sms_execution_unresolved' WHERE id=$1 AND state IN ('queued','sending') RETURNING id`,[active.sms_id]).then(r=>smsFailed(c,r.rows.map(x=>x.id)));
    }
    if(pace.command_id&&(!active||invalid))await c.query(`UPDATE sms_messages m SET failure_reason='sms_gateway_execution_unresolved'
      FROM sms_dispatch_queue q WHERE q.sms_id=m.id AND q.gateway_id=$1 AND q.released_at IS NULL AND m.state='queued'`,[gatewayId]);
  }
    // Expiry without execution evidence is not permission to retry or release another SMS.
    // Retain the command identity even when retention eventually removes its command row.
    if(pace.command_id||!pace.due||!g.online||!g.control_enabled||!g.sms_ready)return null;
    const legacy=(await c.query(`SELECT id,generation,expires_at>clock_timestamp() live FROM commands WHERE gateway_id=$1 AND kind='send_sms' AND status='pending' AND sms_execution_observed_at IS NULL ORDER BY sequence LIMIT 1`,[gatewayId])).rows[0];
    if(legacy){
      // Adopt only the oldest existing command; old/expired ambiguity holds delivery safely.
      await c.query(`UPDATE gateway_sms_pacing SET command_id=$2 WHERE gateway_id=$1`,[gatewayId,legacy.id]);
      return null;
    }
  const queued=await c.query(`SELECT q.*,m.snapshot_owner_id,m.sim_id,m.remote_number,m.body,m.generation,m.state,
      s.owner_user_id,s.gateway_id current_gateway,s.version,s.device_present,s.assignment_pending
    FROM sms_dispatch_queue q JOIN sms_messages m ON m.id=q.sms_id JOIN sims s ON s.id=m.sim_id
    WHERE q.gateway_id=$1 AND q.released_at IS NULL ORDER BY q.ordinal FOR UPDATE OF m,s`,[gatewayId]);
  for(const row of queued.rows){
    if(row.state!=='queued'||row.owner_user_id!==row.snapshot_owner_id||row.current_gateway!==gatewayId||
       Number(row.version)!==Number(row.assignment_version)||Number(row.generation)!==Number(g.device_epoch)||!row.device_present||row.assignment_pending){
      await c.query(`UPDATE sms_messages SET state='failed',failure_reason='sms_route_changed_before_release' WHERE id=$1 AND state='queued' RETURNING id`,[row.sms_id]).then(r=>smsFailed(c,r.rows.map(x=>x.id)));
      await c.query(`UPDATE sms_dispatch_queue SET released_at=clock_timestamp() WHERE sms_id=$1`,[row.sms_id]);
      continue;
    }
    await c.query(`UPDATE sms_messages SET failure_reason=NULL WHERE id=$1`,[row.sms_id]);
    const sequence=(await c.query(`UPDATE gateways SET command_sequence=command_sequence+1 WHERE id=$1 RETURNING command_sequence`,[gatewayId])).rows[0].command_sequence;
    const command=(await c.query(`INSERT INTO commands(gateway_id,sim_id,sms_id,generation,sequence,kind,payload,expires_at)
      VALUES($1,$2,$3,$4,$5,'send_sms',$6,clock_timestamp()+interval '2 minutes') RETURNING id,sms_id,generation,sequence,expires_at`,
      [gatewayId,row.sim_id,row.sms_id,g.device_epoch,sequence,JSON.stringify({smsId:row.sms_id,simId:row.sim_id,remoteNumber:row.remote_number,body:row.body})])).rows[0];
    await c.query(`UPDATE sms_dispatch_queue SET released_at=clock_timestamp(),command_id=$2 WHERE sms_id=$1`,[row.sms_id,command.id]);
    await c.query(`UPDATE gateway_sms_pacing SET command_id=$2 WHERE gateway_id=$1`,[gatewayId,command.id]);
    return command;
  }
  return null;
}

/** Called only for the first accepted execution ACK, while holding the gateway lock. */
export async function observeSmsAck(c:PoolClient,gatewayId:string,commandId:string){
  await c.query(`UPDATE commands SET sms_execution_observed_at=COALESCE(sms_execution_observed_at,clock_timestamp()) WHERE id=$1 AND gateway_id=$2`,[commandId,gatewayId]);
  await c.query(`INSERT INTO gateway_sms_pacing(gateway_id,next_release_at) VALUES($1,clock_timestamp()+interval '5 seconds')
    ON CONFLICT(gateway_id) DO UPDATE SET next_release_at=clock_timestamp()+interval '5 seconds',
    command_id=CASE WHEN gateway_sms_pacing.command_id=$2 THEN NULL ELSE gateway_sms_pacing.command_id END`,[gatewayId,commandId]);
}
