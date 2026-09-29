import {createHash,randomBytes} from 'node:crypto';
import type {PoolClient,QueryResult} from 'pg';
import {safeRollback,withClient,type Db} from '../db.js';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};
export const AI_PROTOCOL='voice-run-v1';
export const AI_LEASE_SECONDS=10;
/**
 * S27 失败记录 6: the Voice worker's last transcript batch is flushed after Control has already seen
 * the hangup, so an `ended` run keeps its lease identity this long and that one late POST can still be
 * authenticated. 只用于 transcript 补交，其它接口仍然要求活着的租约。
 */
export const AI_TRANSCRIPT_GRACE_MS=60_000;
/** S24 决策 3: matches the `users.ai_voice_provider` / `ai_call_runs.voice_provider` column default. */
export const DEFAULT_VOICE_PROVIDER='xai';
export type AiRunState='pending'|'preparing'|'answer_committed'|'awaiting_active'|'active'|'ending'|'reconcile_unknown'|'ended'|'failed_before_answer'|'lost_race';

export class AiRunError extends Error{
  // S75: AI_LEASE_LOST carries which check failed; the route layer files `ai.lease_lost`.
  constructor(readonly status:number,readonly code:string,message:string,readonly lease?:{runId?:string;check:string;runState?:string}){super(message);}
}

const leaseHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const leaseToken=()=>randomBytes(32).toString('base64url');

/**
 * S22 decision 2. The AI audio authority reads the SAME 3-heartbeat / 15-second debounce the human
 * call path already uses (app.ts heartbeat). A NULL `*_unready_since` means "currently ready", so the
 * fallback is mandatory: a bare comparison yields NULL, not true. `control_enabled` and
 * `last_seen_at` freshness stay strict.
 */
const capabilityReady=(alias:string,capability:'media'|'telephony')=>
 `(${alias}.${capability}_ready OR (${alias}.${capability}_unready_heartbeats<3
   AND (${alias}.${capability}_unready_since IS NULL OR ${alias}.${capability}_unready_since>now()-interval '15 seconds')))`;
const DEBOUNCED_CAPABILITIES=`${capabilityReady('gateways','media')} media_ready_debounced,${capabilityReady('gateways','telephony')} telephony_ready_debounced`;

/**
 * S22 decision 5. A pre-effect AI failure hands the call back to normal ringing instead of leaving it
 * silently owned by a dead run: clearing `ai_run_id` re-opens the push workers' suppression predicate
 * within one tick, so the caller hears a late ring rather than nothing at all.
 */
export async function releaseRingingCall(db:Queryable,input:{callId:string;runId:string;reason:string}){
 await db.query(`UPDATE call_records SET ai_run_id=NULL,failure_reason=COALESCE(failure_reason,$3)
   WHERE id=$1 AND ai_run_id=$2 AND state='incoming_ringing'`,[input.callId,input.runId,input.reason]);
}

/**
 * S24 决策 3. `providers` is republished on every beat, so a worker that is restarted with a different
 * provider set corrects the advertisement within one heartbeat. An *omitted* field means xAI, which is
 * exactly what every pre-S24 worker can do; an *empty* array means the worker can instantiate nothing
 * (its provider config is missing), so it stays online for zero providers and no call is routed to it.
 */
export async function heartbeatAiWorker(db:Queryable,input:{instanceId:string;bootId:string;protocol:string;capacity:number;providers?:string[]}){
  if(input.protocol!==AI_PROTOCOL||input.capacity!==1)throw new AiRunError(409,'AI_PROTOCOL_MISMATCH','Voice worker protocol is not supported');
  const providers=input.providers===undefined?[DEFAULT_VOICE_PROVIDER]:[...new Set(input.providers)];
  const row=(await db.query(`INSERT INTO ai_worker_instances(instance_id,boot_id,protocol,capacity,expires_at,providers)
    VALUES($1,$2,$3,1,now()+interval '15 seconds',$4::text[])
    ON CONFLICT(instance_id) DO UPDATE SET boot_id=excluded.boot_id,protocol=excluded.protocol,capacity=1,
      expires_at=excluded.expires_at,providers=excluded.providers,updated_at=now()
    RETURNING expires_at,providers`,[input.instanceId,input.bootId,input.protocol,providers])).rows[0];
  return{expiresAt:row.expires_at,providers:row.providers as string[]};
}

/** With a provider id: only a worker that advertises that provider counts as available. */
export async function aiWorkerAvailable(db:Queryable,provider?:string):Promise<boolean>{
  const q=provider===undefined
    ?await db.query(`SELECT 1 FROM ai_worker_instances WHERE protocol=$1 AND capacity=1 AND expires_at>now() LIMIT 1`,[AI_PROTOCOL])
    :await db.query(`SELECT 1 FROM ai_worker_instances WHERE protocol=$1 AND capacity=1 AND expires_at>now() AND $2=ANY(providers) LIMIT 1`,[AI_PROTOCOL,provider]);
  return Boolean(q.rowCount);
}

export async function createAiRunForIncoming(c:PoolClient,input:{enabled:boolean;callId:string;gatewayId:string;ownerId:string;deviceGeneration:number;mediaEpoch:number;mode:string;settingsVersion:number;assignmentVersion:number;timeoutSeconds:number;observedAt:string;
  /** S42 决策 2: an owner-busy run is not driven by the SIM's timeout at all — it fires this many
   * seconds from NOW (the call has already been ringing when the report lands), and the grace can be
   * shorter than the 10 s floor `timeout_seconds_snapshot` is allowed to hold. That column keeps the
   * SIM's own frozen setting, exactly like every other run; `trigger_at` is what actually governs. */
  triggerSeconds?:number;
  /** S24 决策 3: rung when the owner's provider has no live worker, so the caller can log the skip. */
  onProviderUnavailable?:(info:{provider:string})=>void}){
  if(!input.enabled||!['ai','timeout_ai'].includes(input.mode))return null;
  // The same literal as the column default; the owner row always exists (sims.owner_user_id is a FK).
  const provider=((await c.query(`SELECT ai_voice_provider FROM users WHERE id=$1`,[input.ownerId])).rows[0]?.ai_voice_provider as string|undefined)??DEFAULT_VOICE_PROVIDER;
  if(!await aiWorkerAvailable(c,provider)){
    // No run at all, exactly like `AI_ENABLED=false`: the call keeps `ai_run_id IS NULL` and rings on
    // the three clients instead of being owned by a run no worker can execute.
    input.onProviderUnavailable?.({provider});
    return null;
  }
  const run=(await c.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,
      settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at,voice_provider)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
      CASE WHEN $6='ai' THEN now() WHEN $12::int IS NOT NULL THEN now()+$12::int*interval '1 second'
        ELSE LEAST(now(),$10::timestamptz)+$9::int*interval '1 second' END,$11)
    ON CONFLICT(call_id) DO NOTHING RETURNING *`,[
      input.callId,input.gatewayId,input.ownerId,input.deviceGeneration,input.mediaEpoch,input.mode,input.settingsVersion,
      input.assignmentVersion,input.timeoutSeconds,input.observedAt,provider,input.triggerSeconds??null,
    ])).rows[0];
  if(!run)return null;
  await c.query(`UPDATE call_records SET settings_version_snapshot=$2,assignment_version_snapshot=$3,
    timeout_seconds_snapshot=$4,ai_trigger_at=$5,ai_run_id=$6 WHERE id=$1`,[
      input.callId,input.settingsVersion,input.assignmentVersion,input.timeoutSeconds,run.trigger_at,run.id,
    ]);
  return run;
}

export async function claimAiRun(db:Db,input:{enabled:boolean;instanceId:string;bootId:string;prewarmSeconds?:number}){
  if(!input.enabled)return null;
  return withClient(db,async c=>{
   try{
    await c.query('BEGIN');
    const worker=await c.query(`SELECT 1 FROM ai_worker_instances WHERE instance_id=$1 AND boot_id=$2 AND protocol=$3 AND expires_at>now() FOR UPDATE`,[input.instanceId,input.bootId,AI_PROTOCOL]);
    if(!worker.rowCount)throw new AiRunError(409,'AI_WORKER_STALE','Voice worker heartbeat is stale');
    const occupied=await c.query(`SELECT 1 FROM ai_call_runs WHERE lease_owner=$1 AND lease_boot_id=$2 AND lease_until>now()
      AND state IN ('preparing','answer_committed','awaiting_active','active') LIMIT 1`,[input.instanceId,input.bootId]);
    if(occupied.rowCount){await c.query('COMMIT');return null;}
    const q=await c.query(`SELECT run.* FROM ai_call_runs run JOIN call_records call ON call.id=run.call_id
      WHERE run.state='pending' AND run.attempts<3 AND COALESCE(run.next_attempt_at,run.trigger_at)<=now()+$1::int*interval '1 second'
        AND call.state='incoming_ringing' AND call.ai_run_id=run.id
      ORDER BY COALESCE(run.next_attempt_at,run.trigger_at),run.id FOR UPDATE OF run SKIP LOCKED LIMIT 1`,[Math.min(60,Math.max(0,input.prewarmSeconds??30))]);
    if(!q.rowCount){await c.query('COMMIT');return null;}
    const token=leaseToken(),row=(await c.query(`UPDATE ai_call_runs SET state='preparing',attempts=attempts+1,
      lease_owner=$2,lease_boot_id=$3,lease_hash=$4,lease_until=now()+$5::int*interval '1 second',updated_at=now()
      WHERE id=$1 RETURNING *`,[q.rows[0].id,input.instanceId,input.bootId,leaseHash(token),AI_LEASE_SECONDS])).rows[0];
    await c.query('COMMIT');
    return{run:runDto(row),leaseToken:token,leaseExpiresAt:row.lease_until};
   }catch(error){await safeRollback(c);throw error;}
  });
}

export async function renewAiLease(db:Queryable,input:{runId:string;instanceId:string;bootId:string;token:string}){
  const q=await db.query(`UPDATE ai_call_runs run SET lease_until=now()+$5::int*interval '1 second',updated_at=now()
    FROM ai_worker_instances worker WHERE run.id=$1 AND run.lease_owner=$2 AND run.lease_boot_id=$3 AND run.lease_hash=$4
      AND run.lease_until>now() AND run.state IN ('preparing','answer_committed','awaiting_active','active')
      AND worker.instance_id=$2 AND worker.boot_id=$3 AND worker.protocol=$6 AND worker.expires_at>now()
    RETURNING run.state,run.lease_until`,[input.runId,input.instanceId,input.bootId,leaseHash(input.token),AI_LEASE_SECONDS,AI_PROTOCOL]);
  if(!q.rowCount)throw new AiRunError(409,'AI_LEASE_LOST','AI run lease is expired or has changed',{runId:input.runId,check:'not_updated'});
  return{state:q.rows[0].state as AiRunState,leaseExpiresAt:q.rows[0].lease_until};
}

export async function commitAiAnswer(db:Db,input:{enabled:boolean;runId:string;instanceId:string;bootId:string;token:string;onlineSeconds:number;nodeId:string}){
  if(!input.enabled)throw new AiRunError(503,'AI_DISABLED','AI answering is disabled');
  const target=await db.query(`SELECT gateway_id,call_id FROM ai_call_runs WHERE id=$1`,[input.runId]);
  if(!target.rowCount)throw new AiRunError(404,'AI_RUN_NOT_FOUND','AI run was not found');
  return withClient(db,async c=>{
   try{
    await c.query('BEGIN');
    const gateway=(await c.query(`SELECT *,${DEBOUNCED_CAPABILITIES} FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id])).rows[0];
    const call=(await c.query(`SELECT call.*,sim.owner_user_id,sim.version assignment_version,sim.device_present,sim.assignment_pending
      FROM call_records call JOIN sims sim ON sim.id=call.sim_id WHERE call.id=$1 FOR UPDATE OF call,sim`,[target.rows[0].call_id])).rows[0];
    const run=(await c.query(`SELECT * FROM ai_call_runs WHERE id=$1 FOR UPDATE`,[input.runId])).rows[0];
    if(!run||call?.ai_run_id!==run.id)throw new AiRunError(409,'AI_LOST_RACE','AI run no longer owns this incoming call');
    assertLease(run,input);
    await assertWorker(c,input);
    if(run.answer_command_id){const command=(await c.query(`SELECT id,generation,sequence,expires_at FROM commands WHERE id=$1`,[run.answer_command_id])).rows[0];await c.query('COMMIT');return{run:runDto(run),command,replayed:true};}
    if(run.state!=='preparing'||call.state!=='incoming_ringing'){
      await c.query(`UPDATE ai_call_runs SET state='lost_race',lease_hash=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND answer_command_id IS NULL`,[run.id]);
      await c.query('COMMIT');throw new AiRunError(409,'AI_LOST_RACE','Another endpoint already handled this call');
    }
    if(new Date(run.trigger_at).getTime()>Date.now())throw new AiRunError(409,'AI_TRIGGER_NOT_DUE','AI answer timeout has not elapsed');
    const gatewayReady=gateway.control_enabled&&gateway.telephony_ready_debounced&&gateway.media_ready_debounced&&gateway.last_seen_at&&Date.now()-new Date(gateway.last_seen_at).getTime()<=input.onlineSeconds*1000;
    if(!gatewayReady||Number(gateway.device_epoch)!==Number(run.device_generation)||Number(call.generation)!==Number(run.device_generation))throw new AiRunError(409,'AI_GATEWAY_UNAVAILABLE','Gateway state is not safe for AI answering');
    if(!call.device_present||call.assignment_pending||call.owner_user_id!==run.snapshot_owner_id||Number(call.assignment_version)!==Number(run.assignment_version_snapshot))throw new AiRunError(409,'AI_ASSIGNMENT_CHANGED','SIM assignment changed after the call arrived');
    const lock=await c.query(`SELECT 1 FROM gateway_call_locks WHERE gateway_id=$1 AND call_id=$2 AND generation=$3`,[gateway.id,call.id,run.device_generation]);
    if(!lock.rowCount)throw new AiRunError(409,'AI_CALL_LOCK_LOST','Gateway call lock no longer matches');
    const snapshot=await c.query(`SELECT calls,observed_at>=now()-$3::int*interval '1 second' fresh FROM gateway_telecom_snapshots
      WHERE gateway_id=$1 AND generation=$2 FOR UPDATE`,[gateway.id,run.device_generation,input.onlineSeconds]);
    const ringing=snapshot.rowCount&&snapshot.rows[0].fresh&&(snapshot.rows[0].calls as any[]).some(item=>item.callId===call.id&&item.deviceCallId===call.device_call_id&&item.state==='ringing');
    if(!ringing)throw new AiRunError(409,'AI_RINGING_NOT_CONFIRMED','Current Telecom state does not confirm this ringing call');
    if(call.media_node_id&&call.media_node_id!==input.nodeId)throw new AiRunError(409,'AI_MEDIA_NODE_MISMATCH','Call media is fixed to another node');
    const sequence=Number(gateway.command_sequence)+1;
    await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`,[gateway.id,sequence]);
    await c.query(`UPDATE call_records SET state='connecting',claimed_by_session_id=NULL,answered_by_platform='ai',answered_by_device='AI',
      generation=$2,media_node_id=COALESCE(media_node_id,$3),conflict_disposition=COALESCE(conflict_disposition,$4),
      recording_status=CASE WHEN recording_status='none' THEN 'pending' ELSE recording_status END WHERE id=$1`,[call.id,run.device_generation,input.nodeId,
      // S42 决策 4: the 忙线 AI 代接 label is written when the AI actually answers, never at run creation —
      // a human who beats the 5 s grace must not leave the call labelled as AI-answered. A `timeout_ai`
      // run on a SIM whose own mode snapshot is 'normal' can only come from `/owner-busy`; the S38
      // cross-gateway case already wrote its label at creation (mode 'ai') and COALESCE keeps it.
      run.mode_snapshot==='timeout_ai'&&call.mode_snapshot==='normal'?'ai_answered':null]);
    const command=(await c.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)
      VALUES($1,$2,$3,$4,'answer',$5,now()+interval '15 seconds') RETURNING id,generation,sequence,expires_at`,[
      // S22 decision 9: the gateway needs to know an AI leg is answering so it can widen its audio
      // prebuffer wait. The human claim payload is unchanged.
      gateway.id,call.id,run.device_generation,sequence,JSON.stringify({callId:call.id,deviceCallId:call.device_call_id,answeredBy:'ai'}),
    ])).rows[0];
    const updated=(await c.query(`UPDATE ai_call_runs SET state='answer_committed',answer_command_id=$2,updated_at=now() WHERE id=$1 RETURNING *`,[run.id,command.id])).rows[0];
    await c.query('COMMIT');return{run:runDto(updated),command,replayed:false};
   }catch(error){await safeRollback(c);throw error;}
  });
}

export async function markHumanWinner(c:PoolClient,callId:string){
  await c.query(`UPDATE ai_call_runs SET state='lost_race',lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now()
    WHERE call_id=$1 AND state IN ('pending','preparing') AND answer_command_id IS NULL`,[callId]);
}

export async function observeAiCallState(c:PoolClient,callId:string,state:'active'|'ended'|'failed'|'unknown'){
  if(state==='active')await c.query(`UPDATE ai_call_runs run SET state=CASE WHEN lease_until>now() THEN 'active' ELSE 'reconcile_unknown' END,
      activated_at=COALESCE(activated_at,now()),cleanup_required=COALESCE(lease_until<=now(),true),updated_at=now()
    FROM call_records call WHERE run.call_id=$1 AND call.id=run.call_id AND call.ai_run_id=run.id AND call.answered_by_platform='ai'
      AND run.state IN ('answer_committed','awaiting_active','active','reconcile_unknown')`,[callId]);
  // S27 失败记录 6: the worker's last transcript flush arrives after the hangup; the identity stays so
  // that flush can still be authenticated for a grace window (`assertLeaseOrJustEnded`). 只清 lease_until,
  // 租约立刻失效, 但 owner/boot_id/hash 留着当凭据。
  else if(state==='ended'||state==='failed')await c.query(`UPDATE ai_call_runs SET state='ended',ended_at=COALESCE(ended_at,now()),cleanup_required=false,
      lease_until=NULL,updated_at=now() WHERE call_id=$1 AND state NOT IN ('ended','failed_before_answer','lost_race')`,[callId]);
  else await c.query(`UPDATE ai_call_runs SET state='reconcile_unknown',cleanup_required=true,lease_hash=NULL,lease_until=NULL,updated_at=now()
    WHERE call_id=$1 AND answer_command_id IS NOT NULL AND state NOT IN ('ended')`,[callId]);
}

export async function observeAiAnswerAck(c:PoolClient,input:{callId:string;commandId:string;status:'acked'|'rejected';telecomState?:string;generation:number;onlineSeconds:number}){
  const run=(await c.query(`SELECT * FROM ai_call_runs WHERE call_id=$1 AND answer_command_id=$2 FOR UPDATE`,[input.callId,input.commandId])).rows[0];
  if(!run)return{handled:false,restoredRinging:false};
  if(input.status==='acked'){
    await c.query(`UPDATE ai_call_runs SET state=CASE WHEN state='answer_committed' THEN 'awaiting_active' ELSE state END,updated_at=now() WHERE id=$1`,[run.id]);
    return{handled:false,restoredRinging:false};
  }
  let restored=false;
  if(input.telecomState==='RINGING'){
    const call=(await c.query(`SELECT gateway_id,device_call_id,generation FROM call_records WHERE id=$1`,[input.callId])).rows[0];
    const snapshot=await c.query(`SELECT calls,observed_at>=now()-$3::int*interval '1 second' fresh FROM gateway_telecom_snapshots WHERE gateway_id=$1 AND generation=$2`,[call.gateway_id,input.generation,input.onlineSeconds]);
    restored=Boolean(snapshot.rowCount&&snapshot.rows[0].fresh&&(snapshot.rows[0].calls as any[]).some(item=>item.callId===input.callId&&item.deviceCallId===call.device_call_id&&item.state==='ringing'));
  }
  if(restored){
    await c.query(`UPDATE call_records SET state='incoming_ringing',answered_by_platform=NULL,answered_by_device=NULL,ai_run_id=NULL,failure_reason='ai_answer_rejected' WHERE id=$1 AND state='connecting'`,[input.callId]);
    await c.query(`UPDATE ai_call_runs SET state='failed_before_answer',failure_code='answer_rejected_ringing_confirmed',lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now() WHERE id=$1`,[run.id]);
    return{handled:true,restoredRinging:true};
  }
  await c.query(`UPDATE ai_call_runs SET state='reconcile_unknown',cleanup_required=true,failure_code='answer_execution_unknown',lease_hash=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,[run.id]);
  return{handled:false,restoredRinging:false};
}

export async function readAiRun(db:Queryable,input:{runId:string;instanceId:string;bootId:string;token:string;onlineSeconds:number}){
  const q=await db.query(`SELECT run.*,call.state call_state,call.ai_run_id,call.answered_by_platform,call.media_node_id call_media_node_id,
      call.media_epoch call_media_epoch,call.generation call_generation,gateway.device_epoch,gateway.control_enabled,gateway.last_seen_at,
      ${capabilityReady('gateway','media')} media_ready_debounced,${capabilityReady('gateway','telephony')} telephony_ready_debounced,
      EXISTS(SELECT 1 FROM ai_worker_instances worker WHERE worker.instance_id=$2 AND worker.boot_id=$3 AND worker.protocol=$4 AND worker.expires_at>now()) worker_healthy
    FROM ai_call_runs run JOIN call_records call ON call.id=run.call_id JOIN gateways gateway ON gateway.id=run.gateway_id WHERE run.id=$1`,[input.runId,input.instanceId,input.bootId,AI_PROTOCOL]);
  if(!q.rowCount)throw new AiRunError(404,'AI_RUN_NOT_FOUND','AI run was not found');
  const row=q.rows[0];assertLease(row,input);
  const gatewayReady=row.control_enabled&&row.telephony_ready_debounced&&row.media_ready_debounced&&row.last_seen_at&&Date.now()-new Date(row.last_seen_at).getTime()<=input.onlineSeconds*1000;
  const audioAllowed=row.state==='active'&&row.call_state==='active'&&row.ai_run_id===row.id&&row.answered_by_platform==='ai'&&
    Number(row.call_generation)===Number(row.device_generation)&&Number(row.device_epoch)===Number(row.device_generation)&&
    Number(row.call_media_epoch)===Number(row.media_epoch)&&Boolean(gatewayReady)&&Boolean(row.worker_healthy);
  return{run:runDto(row),callState:row.call_state,audioAllowed};
}

export async function failAiRun(db:Db,input:{runId:string;instanceId:string;bootId:string;token:string;code:string}){
  const target=await db.query(`SELECT gateway_id,call_id FROM ai_call_runs WHERE id=$1`,[input.runId]);
  if(!target.rowCount)throw new AiRunError(404,'AI_RUN_NOT_FOUND','AI run was not found');
  return withClient(db,async c=>{
   try{
    await c.query('BEGIN');
    await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id]);
    const call=(await c.query(`SELECT * FROM call_records WHERE id=$1 FOR UPDATE`,[target.rows[0].call_id])).rows[0];
    const run=(await c.query(`SELECT * FROM ai_call_runs WHERE id=$1 FOR UPDATE`,[input.runId])).rows[0];assertLease(run,input);
    if(!run.answer_command_id&&!run.media_attempted_at){
      const retry=Number(run.attempts)<3&&call.state==='incoming_ringing';
      await c.query(`UPDATE ai_call_runs SET state=$2,next_attempt_at=CASE WHEN $2='pending' THEN now()+interval '2 seconds' ELSE NULL END,
        failure_code=$3,lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,updated_at=now() WHERE id=$1`,[run.id,retry?'pending':'failed_before_answer',input.code]);
      // Retries exhausted: the run is terminal before any side effect, so give the call back to the
      // three clients as a normal ring instead of letting it die silently (S22 decision 5).
      if(!retry)await releaseRingingCall(c,{callId:call.id,runId:run.id,reason:input.code});
    }else{
      await c.query(`UPDATE call_records SET state=CASE WHEN state IN ('ended','failed') THEN state ELSE 'ending'::call_state END,
        failure_reason=COALESCE(failure_reason,$2) WHERE id=$1`,[call.id,input.code]);
      await c.query(`UPDATE ai_call_runs SET state=CASE WHEN state='ended' THEN state ELSE 'ending' END,cleanup_required=true,failure_code=$2,
        lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1`,[run.id,input.code]);
    }
    await c.query('COMMIT');return{accepted:true};
   }catch(error){await safeRollback(c);throw error;}
  });
}

export async function authorizeAiMedia(db:Db,input:{runId:string;instanceId:string;bootId:string;token:string;onlineSeconds:number;markAttempted?:boolean}){
  const target=await db.query(`SELECT gateway_id,call_id FROM ai_call_runs WHERE id=$1`,[input.runId]);
  if(!target.rowCount)throw new AiRunError(404,'AI_RUN_NOT_FOUND','AI run was not found');
  return withClient(db,async c=>{
   try{
    await c.query('BEGIN');
    const gateway=(await c.query(`SELECT *,${DEBOUNCED_CAPABILITIES} FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id])).rows[0];
    const call=(await c.query(`SELECT * FROM call_records WHERE id=$1 FOR UPDATE`,[target.rows[0].call_id])).rows[0];
    const run=(await c.query(`SELECT * FROM ai_call_runs WHERE id=$1 FOR UPDATE`,[input.runId])).rows[0];
    assertLease(run,input);
    await assertWorker(c,input);
    if(call.ai_run_id!==run.id||call.answered_by_platform!=='ai'||!['answer_committed','awaiting_active','active'].includes(run.state)||!['connecting','active'].includes(call.state))throw new AiRunError(409,'AI_MEDIA_REVOKED','AI run no longer owns call media');
    const online=gateway.control_enabled&&gateway.media_ready_debounced&&gateway.telephony_ready_debounced&&gateway.last_seen_at&&Date.now()-new Date(gateway.last_seen_at).getTime()<=input.onlineSeconds*1000;
    if(!online||Number(gateway.device_epoch)!==Number(run.device_generation)||Number(call.generation)!==Number(run.device_generation)||Number(call.media_epoch)!==Number(run.media_epoch)||!call.media_node_id)throw new AiRunError(409,'AI_MEDIA_REVOKED','AI media generation is no longer valid');
    if(input.markAttempted){
      if(run.media_attempted_at)throw new AiRunError(409,'AI_MEDIA_ALREADY_ATTEMPTED','AI media offer was already attempted');
      await c.query(`UPDATE ai_call_runs SET media_attempted_at=now(),updated_at=now() WHERE id=$1 AND media_attempted_at IS NULL`,[run.id]);
    }
    await c.query('COMMIT');
    return{callId:call.id,nodeId:call.media_node_id as string,mediaEpoch:Number(call.media_epoch),state:run.state as AiRunState};
   }catch(error){await safeRollback(c);throw error;}
  });
}

export async function markAiMediaFailure(db:Db,runId:string,code:string){
  const target=await db.query(`SELECT gateway_id,call_id FROM ai_call_runs WHERE id=$1`,[runId]);if(!target.rowCount)return null;
  return withClient(db,async c=>{
   try{
    await c.query('BEGIN');
    await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id]);
    const call=(await c.query(`SELECT * FROM call_records WHERE id=$1 FOR UPDATE`,[target.rows[0].call_id])).rows[0];
    const run=(await c.query(`SELECT * FROM ai_call_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];
    if(!run||!call){await c.query('ROLLBACK');return null;}
    if(run.answer_command_id||run.media_attempted_at){
      await c.query(`UPDATE call_records SET state=CASE WHEN state IN ('ended','failed') THEN state ELSE 'ending'::call_state END,
        failure_reason=COALESCE(failure_reason,$2) WHERE id=$1`,[call.id,code]);
      await c.query(`UPDATE ai_call_runs SET state=CASE WHEN state='ended' THEN state ELSE 'ending' END,cleanup_required=true,
        failure_code=$2,lease_hash=NULL,lease_until=NULL,lease_owner=NULL,lease_boot_id=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1`,[run.id,code]);
    }
    await c.query('COMMIT');return{callId:call.id};
   }catch(error){await safeRollback(c);throw error;}
  });
}

export function assertLease(row:any,input:{runId?:string;instanceId:string;bootId:string;token:string}){
  const check=!row?'missing':row.lease_owner!==input.instanceId?'owner':row.lease_boot_id!==input.bootId?'boot':row.lease_hash!==leaseHash(input.token)?'token'
    :!row.lease_until||new Date(row.lease_until).getTime()<=Date.now()?'expired':null;
  if(check)throw new AiRunError(409,'AI_LEASE_LOST','AI run lease is expired or has changed',{runId:row?.id??input.runId,check,runState:row?.state});
}

/**
 * S27 失败记录 6. Transcript-only relaxation: a run that Control just moved to `ended` has no live
 * lease any more, but it still carries the identity of the worker that held it, so the last batch the
 * worker was still buffering at hangup is authenticated instead of lost. 其它接口（commit/read/fail/
 * media）继续用 `assertLease`, 因为 worker 正是靠 `readAiRun` 的 409 才知道通话已经结束。
 */
export function assertLeaseOrJustEnded(row:any,input:{instanceId:string;bootId:string;token:string},graceMs=AI_TRANSCRIPT_GRACE_MS){
  try{assertLease(row,input);}catch(error){
    if(!(row&&row.state==='ended'&&row.ended_at&&Date.now()-new Date(row.ended_at).getTime()<=graceMs&&
      row.lease_owner===input.instanceId&&row.lease_boot_id===input.bootId&&row.lease_hash===leaseHash(input.token)))throw error;
  }
}

async function assertWorker(db:Queryable,input:{instanceId:string;bootId:string}){
  const q=await db.query(`SELECT 1 FROM ai_worker_instances WHERE instance_id=$1 AND boot_id=$2 AND protocol=$3 AND expires_at>now()`,[input.instanceId,input.bootId,AI_PROTOCOL]);
  if(!q.rowCount)throw new AiRunError(409,'AI_WORKER_STALE','Voice worker heartbeat is stale');
}

function runDto(row:any){return{id:row.id,callId:row.call_id,mode:row.mode_snapshot,triggerAt:row.trigger_at,deviceGeneration:Number(row.device_generation),mediaEpoch:Number(row.media_epoch),state:row.state,
  // S24 决策 3: the worker instantiates this adapter, so the claim/read response must carry the run's
  // frozen choice rather than whatever the owner has selected right now.
  voiceProvider:(row.voice_provider as string|undefined)??DEFAULT_VOICE_PROVIDER,
  mediaNodeId:row.media_node_id??row.call_media_node_id??undefined};}
