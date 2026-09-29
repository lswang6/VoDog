import type {PoolClient} from 'pg';
import {replayDigest} from './replay-horizon.js';
export type ReplayMigrationRequest={intentId:string;generation:number;serverSequence:number;localProof:{idle:boolean;pendingAcks:number;pendingEvents:number;pendingCommands:number;unknownExecutions:number}};
export type ReplayMigrationReceipt={intentId:string;gatewayId:string;fromGeneration:number;toGeneration:number;fromSequence:number;firstSequence:1;proofDigest:string};
export type MigrationBlocker={code:string;count:number};

/** Caller owns transaction; gateway lock serializes every allocator against this CAS. */
export async function coordinateReplayMigration(c:PoolClient,gatewayId:string,input:ReplayMigrationRequest,mode:'preflight'|'commit',enabled:boolean){
 const gateway=(await c.query('SELECT device_epoch,command_sequence FROM gateways WHERE id=$1 FOR UPDATE',[gatewayId])).rows[0];
 const inputDigest=replayDigest({gatewayId,...input});
 let intent=(await c.query('SELECT * FROM gateway_command_replay_migrations WHERE gateway_id=$1 AND intent_id=$2',[gatewayId,input.intentId])).rows[0];
 const blocked=(code:string)=>({eligible:false,blockers:[{code,count:1}],receipt:undefined as ReplayMigrationReceipt|undefined});
 if(intent&&intent.input_digest!==inputDigest)return blocked('intent_payload_conflict');
 if(intent?.state==='committed'){
  if(Number(gateway?.device_epoch)!==Number(intent.receipt?.toGeneration))return blocked('committed_epoch_mismatch');
  if(intent.confirmed_at!=null)return blocked('migration_already_completed');
  return{eligible:true,blockers:[] as MigrationBlocker[],receipt:intent.receipt as ReplayMigrationReceipt};
 }
 if(!intent&&mode==='commit')return blocked('preflight_intent_required');
 if(!intent&&!enabled)return blocked('migration_disabled');
 if(!intent){
  const count=Number((await c.query("SELECT count(*) FROM gateway_command_replay_migrations WHERE gateway_id=$1 AND from_generation=$2 AND state='prepared'",[gatewayId,Number(gateway.device_epoch)])).rows[0].count);
  if(count>=4)return blocked('intent_capacity_reached');
  if(input.generation!==Number(gateway.device_epoch))return blocked('epoch_changed');
 }
 if(!intent){
  await c.query(`INSERT INTO gateway_command_replay_migrations(gateway_id,intent_id,from_generation,from_sequence,input_digest,input)VALUES($1,$2,$3,$4,$5,$6)`,[gatewayId,input.intentId,input.generation,input.serverSequence,inputDigest,JSON.stringify(input)]);
 }
 const blockers:MigrationBlocker[]=[];
 const add=(code:string,count:number)=>{if(count>0)blockers.push({code,count});};
 add('migration_disabled',enabled?0:1);
 add('epoch_changed',Number(gateway?.device_epoch)===input.generation?0:1);
 add('allocator_changed',Number(gateway?.command_sequence)===input.serverSequence?0:1);
 add('local_not_idle',input.localProof.idle?0:1);
 add('local_pending_acks',input.localProof.pendingAcks);add('local_pending_events',input.localProof.pendingEvents);
 add('local_pending_commands',input.localProof.pendingCommands);add('local_unknown_executions',input.localProof.unknownExecutions);
 const counts=(await c.query(`SELECT
  (SELECT count(*) FROM call_records WHERE gateway_id=$1 AND state NOT IN ('ended','failed')) calls,
  (SELECT count(*) FROM sms_messages WHERE gateway_id=$1 AND direction='outgoing' AND state NOT IN ('delivered','failed')) sms,
  (SELECT count(*) FROM commands WHERE gateway_id=$1 AND generation=$2 AND status='pending') commands,
  (SELECT count(*) FROM gateway_call_locks WHERE gateway_id=$1) locks,
  (SELECT count(*) FROM media_close_jobs job JOIN call_records call ON call.id=job.call_id WHERE call.gateway_id=$1 AND job.completed_at IS NULL) cleanup,
  (SELECT count(*) FROM gateway_command_replay_migrations WHERE gateway_id=$1 AND state='committed' AND confirmed_at IS NULL) migration_pending,
  (SELECT count(*) FROM gateway_command_replay_horizons WHERE gateway_id=$1 AND generation=$2 AND (state='quarantined' OR proposed_revision<>committed_revision)) horizons`,[gatewayId,input.generation])).rows[0];
 for(const key of ['calls','sms','commands','locks','cleanup','horizons','migration_pending'])add(`server_${key}`,Number(counts[key]));
 const snapshot=(await c.query(`SELECT 1 FROM gateway_telecom_snapshots WHERE gateway_id=$1 AND generation=$2 AND NOT local_busy AND calls='[]'::jsonb AND updated_at>now()-interval '30 seconds'`,[gatewayId,input.generation])).rowCount;
 add('fresh_idle_snapshot_required',snapshot?0:1);
 await c.query('UPDATE gateway_command_replay_migrations SET last_blockers=$3,checked_at=now() WHERE gateway_id=$1 AND intent_id=$2',[gatewayId,input.intentId,JSON.stringify(blockers)]);
 if(blockers.length||mode==='preflight')return{eligible:blockers.length===0,blockers,receipt:undefined as ReplayMigrationReceipt|undefined};
 const base={intentId:input.intentId,gatewayId,fromGeneration:input.generation,toGeneration:input.generation+1,fromSequence:input.serverSequence,firstSequence:1 as const};
 const receipt:ReplayMigrationReceipt={...base,proofDigest:replayDigest({...base,inputDigest})};
 // Migration requires zero non-terminal calls, and the media-ready debounce must never
 // delay teardown for a gateway whose readiness was cleared outside a heartbeat.
 const changed=await c.query(`UPDATE gateways SET device_epoch=$3,command_sequence=0,telephony_ready=false,sms_ready=false,media_ready=false,
   media_unready_since=COALESCE(media_unready_since,now()),media_unready_heartbeats=GREATEST(media_unready_heartbeats,3)
   WHERE id=$1 AND device_epoch=$2 AND command_sequence=$4`,[gatewayId,input.generation,receipt.toGeneration,input.serverSequence]);
 if(changed.rowCount!==1)throw new Error('replay migration CAS lost under gateway lock');
 await c.query(`UPDATE gateway_command_replay_migrations SET state='committed',receipt=$3,committed_at=now() WHERE gateway_id=$1 AND intent_id=$2 AND state='prepared'`,[gatewayId,input.intentId,JSON.stringify(receipt)]);
 // Credentials, SIM ownership/settings, all business history and old execution evidence remain intact.
 return{eligible:true,blockers,receipt};
}

export async function completeReplayMigration(c:PoolClient,gatewayId:string,input:{intentId:string;generation:number;proofDigest:string}){
 const gateway=(await c.query('SELECT device_epoch,command_sequence FROM gateways WHERE id=$1 FOR UPDATE',[gatewayId])).rows[0];
 const intent=(await c.query('SELECT state,receipt,confirmed_at FROM gateway_command_replay_migrations WHERE gateway_id=$1 AND intent_id=$2',[gatewayId,input.intentId])).rows[0];
 if(intent?.state!=='committed'||Number(gateway?.device_epoch)!==input.generation||intent.receipt?.toGeneration!==input.generation||intent.receipt?.proofDigest!==input.proofDigest)
  return{completed:false,blockers:[{code:'completion_proof_mismatch',count:1}]};
 if(intent.confirmed_at!=null&&Number(gateway.command_sequence)>0)
  return{completed:false,blockers:[{code:'completed_epoch_progressed',count:1}]};
 await c.query('UPDATE gateway_command_replay_migrations SET confirmed_at=COALESCE(confirmed_at,now()) WHERE gateway_id=$1 AND intent_id=$2',[gatewayId,input.intentId]);
 return{completed:true,blockers:[]};
}
