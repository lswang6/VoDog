import type {QueryResult} from 'pg';
import {tx,type Db} from '../db.js';
import {AiRunError,assertLeaseOrJustEnded} from './repository.js';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};

export const AI_TRANSCRIPT_MAX_BATCH=200;
export const AI_TRANSCRIPT_MAX_TEXT=16_384;
export type TranscriptItem={role:'ai'|'caller';sequence:number;text:string;at:string};

/**
 * S21 §E. `sequence` is one monotonic counter per run across BOTH roles, matching
 * `UNIQUE(run_id,sequence)`; a replayed batch is silently absorbed rather than rejected, because the
 * Voice worker posts best-effort and must never turn a transcript hiccup into a dropped call.
 *
 * S27 失败记录 6: the worker flushes its last batch only after the call is already `ended`, so this is
 * the one endpoint that accepts a just-expired lease — see `assertLeaseOrJustEnded`.
 *
 * S94b 死锁: the INSERT's two FK checks take `FOR KEY SHARE` on `ai_call_runs` and then `call_records`
 * (RI trigger name order), the reverse of every hangup/reconciler path (gateway → call → run, all
 * `FOR UPDATE`). So the parents are locked here explicitly in the canonical order, call before run,
 * and the whole batch runs in `tx`, which re-runs it on 40P01/40001. A retry cannot duplicate: the
 * victim attempt is fully rolled back and `ON CONFLICT (run_id,sequence) DO NOTHING` absorbs the rest.
 */
export function storeAiTranscript(
 db:Db,
 input:{runId:string;instanceId:string;bootId:string;token:string;items:TranscriptItem[]},
):Promise<{accepted:true;stored:number}>{
 return tx(db,c=>appendAiTranscript(c,input),'ai.transcript');
}

/** Caller owns the transaction (`storeAiTranscript`); without one the row locks are released per statement. */
export async function appendAiTranscript(
 db:Queryable,
 input:{runId:string;instanceId:string;bootId:string;token:string;items:TranscriptItem[]},
):Promise<{accepted:true;stored:number}>{
 // `call_id` never changes for a run, so the unlocked read only finds which call row to lock first.
 const target=(await db.query(`SELECT call_id FROM ai_call_runs WHERE id=$1`,[input.runId])).rows[0];
 if(!target)throw new AiRunError(404,'AI_RUN_NOT_FOUND','AI run was not found');
 await db.query(`SELECT 1 FROM call_records WHERE id=$1 FOR KEY SHARE`,[target.call_id]);
 const run=(await db.query(`SELECT id,call_id,state,ended_at,lease_owner,lease_boot_id,lease_hash,lease_until FROM ai_call_runs WHERE id=$1 FOR KEY SHARE`,[input.runId])).rows[0];
 if(!run)throw new AiRunError(404,'AI_RUN_NOT_FOUND','AI run was not found');
 assertLeaseOrJustEnded(run,input);
 if(!input.items.length)return {accepted:true,stored:0};
 const q=await db.query(
  `INSERT INTO ai_run_transcripts(run_id,call_id,role,sequence,text,at)
   SELECT $1,$2,item.role,item.sequence,item.text,item.at
   FROM jsonb_to_recordset($3::jsonb) AS item(role text,sequence int,text text,at timestamptz)
   ON CONFLICT (run_id,sequence) DO NOTHING
   RETURNING id`,
  [run.id,run.call_id,JSON.stringify(input.items.map(item=>({...item,text:item.text.slice(0,AI_TRANSCRIPT_MAX_TEXT)})))],
 );
 return {accepted:true,stored:q.rowCount??0};
}

/** Owner-scoped read; the call's snapshot owner is the only principal allowed to see it. */
export async function readCallTranscript(db:Queryable,ownerUserId:string,callId:string):Promise<{role:'ai'|'caller';text:string;at:Date}[]|null>{
 const call=await db.query(`SELECT id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,[callId,ownerUserId]);
 if(!call.rowCount)return null;
 const q=await db.query(`SELECT role,text,at FROM ai_run_transcripts WHERE call_id=$1 ORDER BY sequence,id`,[callId]);
 return q.rows.map(row=>({role:row.role,text:row.text,at:row.at}));
}

/**
 * S22 decision 6 fallback source. When the recording itself carries no audio, an AI-answered call
 * still has this realtime transcript, and a report built from it beats no report at all. Owner
 * scoped exactly like `readCallTranscript`, because the transcript job carries the frozen owner.
 */
export async function readAiTranscriptLines(db:Queryable,input:{callId:string;snapshotOwnerId:string}):Promise<{role:'ai'|'caller';text:string;at:string}[]>{
 const q=await db.query(
  `SELECT t.role,t.text,t.at FROM ai_run_transcripts t
     JOIN call_records c ON c.id=t.call_id AND c.snapshot_owner_id=$2
   WHERE t.call_id=$1 ORDER BY t.sequence,t.id`,
  [input.callId,input.snapshotOwnerId],
 );
 return q.rows.map(row=>({role:row.role,text:row.text,at:row.at instanceof Date?row.at.toISOString():String(row.at)}));
}

/** Cheap existence probe for the enqueue gate; covered by `ai_run_transcripts_call_idx`. */
export async function hasAiTranscript(db:Queryable,callId:string):Promise<boolean>{
 return Boolean((await db.query(`SELECT 1 FROM ai_run_transcripts WHERE call_id=$1 LIMIT 1`,[callId])).rowCount);
}
