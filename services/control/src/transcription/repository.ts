import type {Pool, PoolClient} from 'pg';
import {safeRollback, withClient} from '../db.js';
import {diag} from '../diag.js';

export type TranscriptJobState = 'queued' | 'running' | 'retry' | 'succeeded' | 'failed';
export type TranscriptJob = {
  id: string; callId: string; snapshotOwnerId: string; manifest: unknown; manifestFingerprint: string;
  state: TranscriptJobState; attempts: number; nextAttemptAt: Date; leaseToken: string | null;
  leaseUntil: Date | null; result: unknown | null; errorCode: string | null; errorMessage: string | null;
  createdAt: Date; updatedAt: Date; completedAt: Date | null;
};

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

function rowToJob(row: any): TranscriptJob {
  return {
    id: row.id, callId: row.call_id, snapshotOwnerId: row.snapshot_owner_id,
    manifest: row.manifest, manifestFingerprint: row.manifest_fingerprint,
    state: row.state, attempts: Number(row.attempts), nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token, leaseUntil: row.lease_until, result: row.result,
    errorCode: row.error_code, errorMessage: row.error_message,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}

export class PostgresTranscriptJobRepository {
  constructor(private readonly db: Pool) {}

  async enqueue(input: {callId: string; snapshotOwnerId: string; manifest: unknown; manifestFingerprint: string}): Promise<TranscriptJob> {
    const result = await this.db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint)
      SELECT call.id,$2,$3::jsonb,$4 FROM call_records call WHERE call.id=$1 AND call.snapshot_owner_id=$2
      ON CONFLICT(call_id,snapshot_owner_id,manifest_fingerprint) DO UPDATE SET updated_at=transcript_jobs.updated_at
      RETURNING *`, [input.callId, input.snapshotOwnerId, JSON.stringify(input.manifest), input.manifestFingerprint]);
    if (!result.rowCount) throw new Error('TRANSCRIPT_CALL_OWNER_MISMATCH');
    return rowToJob(result.rows[0]);
  }

  async claim({leaseMs}: {leaseMs: number}): Promise<TranscriptJob | null> {
    return withClient(this.db, async (client) => {
     try {
      await client.query('BEGIN');
      const result = await client.query(`WITH candidate AS (
          SELECT id FROM transcript_jobs
          WHERE ((state IN ('queued','retry') AND next_attempt_at<=clock_timestamp())
             OR (state='running' AND lease_until<=clock_timestamp()))
          ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE transcript_jobs job SET state='running',attempts=job.attempts+1,
          lease_token=gen_random_uuid(),lease_until=clock_timestamp()+$1::double precision*interval '1 millisecond',
          updated_at=clock_timestamp(),error_code=NULL,error_message=NULL
        FROM candidate WHERE job.id=candidate.id RETURNING job.*`, [leaseMs]);
      await client.query('COMMIT');
      return result.rowCount ? rowToJob(result.rows[0]) : null;
     } catch (error) {
      await safeRollback(client);
      throw error;
     }
    });
  }

  async complete(input: {jobId: string; leaseToken: string; result: unknown}): Promise<boolean> {
    const result = await this.db.query(`UPDATE transcript_jobs SET state='succeeded',result=$3::jsonb,
      completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code=NULL,error_message=NULL
      WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [input.jobId, input.leaseToken, JSON.stringify(input.result)]);
    return result.rowCount === 1;
  }

  async renewLease(input: {jobId: string; leaseToken: string; leaseMs: number}): Promise<boolean> {
    const result = await this.db.query(`UPDATE transcript_jobs SET
      lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp()
      WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [input.jobId, input.leaseToken, input.leaseMs]);
    return result.rowCount === 1;
  }

  /**
   * `countAttempt: false` gives the attempt back (S23 决策 6): a provider quota 429 says nothing about
   * this job, so it must not consume the retry budget a real failure needs, nor inflate the backoff
   * exponent past the point where `Retry-After` still decides when the job runs again.
   */
  async fail(input: {jobId: string; leaseToken: string; terminal: boolean; nextAttemptAt: Date | null; errorCode: string; errorMessage: string; countAttempt?: boolean}): Promise<boolean> {
    const result = await this.db.query(`UPDATE transcript_jobs SET state=CASE WHEN $3 THEN 'failed' ELSE 'retry' END,
      next_attempt_at=CASE WHEN $3 THEN next_attempt_at ELSE $4 END,error_code=$5,error_message=$6,
      attempts=CASE WHEN $7 THEN attempts ELSE GREATEST(attempts-1,0) END,
      completed_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING call_id`,
      [input.jobId, input.leaseToken, input.terminal, input.nextAttemptAt, input.errorCode, input.errorMessage.slice(0, 500), input.countAttempt !== false]);
    // S69: a terminal failure is a diag row next to the stored error code (never the message: it can quote the provider).
    if (input.terminal && result.rowCount === 1)
      diag(this.db, 'transcription.failed', {callId: result.rows[0].call_id, stage: 'transcribe', reason: input.errorCode}, {callId: result.rows[0].call_id, level: 'warn'});
    return result.rowCount === 1;
  }

  async get(jobId: string, queryable: Queryable = this.db): Promise<TranscriptJob | null> {
    const result = await queryable.query('SELECT * FROM transcript_jobs WHERE id=$1', [jobId]);
    return result.rowCount ? rowToJob(result.rows[0]) : null;
  }
}

