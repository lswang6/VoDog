import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {annotateNumbers, normalizeContactName} from '../contacts/repository.js';
import {pageEnvelope, pageOffset, pageQueryShape} from '../pagination.js';
import {PENDING_CALL,visibleCall} from '../badges.js';

type UserIdentity = {userId: string; sessionId?: string};
type WindowResult = {fromInclusive: Date; toExclusive: Date; period: string; timeZone: string; disambiguation: string};
type DayWindowResult = {fromInclusive: Date; toExclusive: Date; timeZone: string; disambiguation: string};
type RouteDependencies = {
  requireUser(request: FastifyRequest): UserIdentity;
  mutationOrigin(request: FastifyRequest): void;
  fail(status: number, code: string, message: string, details?: unknown): never;
  reportWindow(input: {period: '7d' | '1m' | '6m' | '1y'; anchor: Date; timeZone: string; disambiguation: 'compatible'}): WindowResult;
  /** S22: absent on an old caller, in which case only the relative `period` window is offered. */
  reportDayWindow?(input: {from: string; to: string; timeZone: string; disambiguation: 'compatible'}): DayWindowResult;
  now?: () => Date;
};

function transcriptDto(row: any) {
  return {
    id: row.id, callId: row.call_id, status: row.state, attempts: Number(row.attempts),
    nextAttemptAt: row.state === 'retry' ? row.next_attempt_at : null,
    error: row.error_code ? {code: row.error_code, message: row.error_message} : null,
    result: row.state === 'succeeded' ? row.result : null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}

export function registerTranscriptionRoutes(app: FastifyInstance, db: Pool, dependencies: RouteDependencies) {
  // There are currently no HTTP mutations here. A future retry/enqueue route must call this injected guard.
  void dependencies.mutationOrigin;

  app.get('/api/v1/calls/:id/transcript', async (request, reply) => {
    const identity = dependencies.requireUser(request);
    const {id} = z.object({id: z.uuid()}).parse(request.params);
    const call = await db.query('SELECT 1 FROM call_records WHERE id=$1 AND snapshot_owner_id=$2', [id, identity.userId]);
    if (!call.rowCount) dependencies.fail(404, 'NOT_FOUND', 'Call not found');
    const job = await db.query(`SELECT * FROM transcript_jobs WHERE call_id=$1 AND snapshot_owner_id=$2
      ORDER BY created_at DESC,id DESC LIMIT 1`, [id, identity.userId]);
    reply.header('Cache-Control', 'private, no-store');
    return {transcript: job.rowCount ? transcriptDto(job.rows[0]) : null};
  });

  /**
   * S22 报告 Tab. Every call in the window is a report row — the transcript is an attribute of the
   * call, not its admission ticket. Only interception rows are excluded, exactly like `GET /calls`.
   * `from/to` (owner-zone calendar days, inclusive) win over the legacy relative `period`.
   */
  app.get('/api/v1/reports/calls', async (request, reply) => {
    const identity = dependencies.requireUser(request);
    const parameters = z.object({
      period: z.enum(['7d', '1m', '6m', '1y']).default('7d'),
      timeZone: z.string().min(1).max(100),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // An empty string is a cleared search box, not a bad request.
      query: z.string().trim().max(64).optional(),
      // Defaulting to the maximum keeps an S21 client that never sends `limit` seeing its whole
      // window; the bound is what stops an unbounded page, not the default.
      limit: z.coerce.number().int().min(1).max(200).default(200),
      before: z.coerce.date().optional(),
      beforeId: z.uuid().optional(),
      // S28: the SIM filter belongs in the WHERE clause, not in the client — a page that was
      // filtered after it was cut shows the wrong rows and the wrong total.
      simId: z.uuid().optional(),
      ...pageQueryShape,
    }).parse(request.query);
    if (parameters.page !== undefined && (parameters.before !== undefined || parameters.beforeId !== undefined)) {
      dependencies.fail(400, 'INVALID_REQUEST', 'page cannot be combined with before or beforeId');
    }
    const explicitDays = parameters.from !== undefined || parameters.to !== undefined;
    if (explicitDays && (parameters.from === undefined || parameters.to === undefined)) {
      dependencies.fail(400, 'INVALID_REPORT_RANGE', 'A report date range needs both from and to');
    }
    let window: WindowResult | DayWindowResult;
    try {
      window = explicitDays && dependencies.reportDayWindow
        ? dependencies.reportDayWindow({from: parameters.from!, to: parameters.to!, timeZone: parameters.timeZone, disambiguation: 'compatible'})
        : dependencies.reportWindow({period: parameters.period, timeZone: parameters.timeZone, anchor: (dependencies.now ?? (() => new Date()))(), disambiguation: 'compatible'});
    } catch (error) {
      const message = String((error as Error).message);
      if (explicitDays && !/Invalid IANA/.test(message)) dependencies.fail(400, 'INVALID_REPORT_RANGE', 'A report date range must be two calendar days, from on or before to', {message});
      dependencies.fail(400, 'INVALID_TIME_ZONE', 'A valid IANA time zone is required', {message});
    }
    const search = (parameters.query ? parameters.query.replace(/[%_\\]/g, '') : '') || null;
    // The count must see the same FROM as the page: the `query` predicate reads the LATERAL
    // transcript and the AI transcript EXISTS, and the inner `JOIN sims` is what drops a call whose
    // SIM row is gone. $9 is the session (S72), $10 LIMIT and $11 OFFSET, so the count reuses the leading parameters.
    const from = `FROM call_records c
      JOIN sims s ON s.id=c.sim_id
      LEFT JOIN gateways g ON g.id=s.gateway_id
      LEFT JOIN sims ps ON ps.id=c.peer_sim_id
      LEFT JOIN LATERAL (
        SELECT state,result,completed_at,error_code FROM transcript_jobs
        WHERE call_id=c.id AND snapshot_owner_id=$1
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) j ON true
      WHERE c.snapshot_owner_id=$1 AND c.started_at >= $2 AND c.started_at < $3
        AND c.failure_reason IS DISTINCT FROM 'number_blocked' AND ${visibleCall('$9')}
        AND ($4::timestamptz IS NULL OR (c.started_at,c.id)<($4::timestamptz,COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'::uuid)))
        AND ($6::text IS NULL OR c.remote_number ILIKE '%'||$6||'%'
          OR (j.result->>'text') ILIKE '%'||$6||'%' OR (j.result->>'summary') ILIKE '%'||$6||'%'
          OR EXISTS(SELECT 1 FROM ai_run_transcripts t WHERE t.call_id=c.id AND t.text ILIKE '%'||$6||'%')
          OR EXISTS(SELECT 1 FROM contact_phones p JOIN contacts ct ON ct.id=p.contact_id AND ct.deleted_at IS NULL
            WHERE p.owner_user_id=$1 AND p.canonical_key=c.remote_canonical_key AND ct.normalized_name LIKE '%'||$7||'%'))
        AND ($8::uuid IS NULL OR s.id=$8)`;
    const filters = [identity.userId, window!.fromInclusive, window!.toExclusive,
      parameters.before ?? null, parameters.beforeId ?? null, search, search ? normalizeContactName(search) : null,
      parameters.simId ?? null, identity.sessionId ?? null];
    const [result, counted] = await Promise.all([
      db.query(`SELECT c.id call_id,c.started_at,c.answered_at,c.ended_at,c.direction,c.remote_number,c.recording_status,
        c.gateway_time_zone,c.mode_snapshot,c.answered_by_platform,c.originating_platform,c.conflict_disposition,s.id sim_id,s.label sim_label,s.slot_index,s.country_iso sim_country_iso,g.kind gateway_kind,
        c.internal_call,c.peer_call_id,c.peer_sim_id,COALESCE(NULLIF(ps.label,''),ps.phone_label) peer_sim_label,
        j.state job_state,j.result,j.completed_at,j.error_code,
        EXISTS(SELECT 1 FROM ai_run_transcripts t WHERE t.call_id=c.id) has_ai_transcript,
        (${PENDING_CALL}) unseen
      ${from}
      ORDER BY c.started_at DESC,c.id DESC LIMIT $10${parameters.page === undefined ? '' : ' OFFSET $11'}`,
        parameters.page === undefined
          ? [...filters, parameters.limit]
          : [...filters, parameters.pageSize, pageOffset(parameters.page, parameters.pageSize)]),
      parameters.page === undefined ? null : db.query(`SELECT count(*)::int total ${from}`, filters),
    ]);
    const annotations = await annotateNumbers(db, identity.userId,
      result.rows.map((row) => ({remoteNumber: row.remote_number, countryIso: row.sim_country_iso})), 'call');
    reply.header('Cache-Control', 'private, no-store');
    return {
      window: {
        ...(explicitDays ? {} : {period: parameters.period}),
        timeZone: parameters.timeZone, fromInclusive: window!.fromInclusive, toExclusive: window!.toExclusive,
      },
      items: result.rows.map((row, index) => {
        const succeeded = row.job_state === 'succeeded';
        // Rows written before classifier v2 simply have no category key; they render as 未分类
        // instead of being back-filled with a guess.
        const classified = succeeded && typeof row.result?.blockCategory === 'string';
        return {
          ...annotations[index],
          callId: row.call_id, startedAt: row.started_at, answeredAt: row.answered_at, endedAt: row.ended_at,
          direction: row.direction, remoteNumber: row.remote_number,
          sim: {id: row.sim_id, label: row.sim_label, slotIndex: Number(row.slot_index)},
          gatewayTimeZone: row.gateway_time_zone, answerMode: row.mode_snapshot, answeredByPlatform: row.answered_by_platform,
          // S38: the report card's recording sheet needs both — 'pixel' means one real track
          // (`caller_original` is silence), and the conflict says why AI answered a 人工 SIM.
          originatingPlatform: row.originating_platform, conflictDisposition: row.conflict_disposition ?? null,
          // S58: the recording sheet labels a DJI 4G call's device track by the gateway's hardware.
          gatewayKind: row.gateway_kind ?? null,
          // S72: internal call (own hosted SIM ↔ own hosted SIM) and the other leg's SIM.
          internal: row.internal_call === true, peerCallId: row.peer_call_id ?? null, peerSimId: row.peer_sim_id ?? null, peerSimLabel: row.peer_sim_label ?? null,
          recordingStatus: row.recording_status,
          transcriptState: row.job_state ?? 'none',
          transcriptError: row.error_code && !succeeded ? {code: row.error_code} : null,
          summary: succeeded && typeof row.result?.summary === 'string' ? row.result.summary : null,
          actionItems: succeeded && Array.isArray(row.result?.actionItems) ? row.result.actionItems : [],
          classification: succeeded ? row.result?.advertisingClassification ?? 'unknown' : null,
          blockRecommended: classified ? row.result.blockRecommended === true : null,
          blockCategory: classified ? row.result.blockCategory : null,
          blockReason: classified && typeof row.result.blockReason === 'string' ? row.result.blockReason : null,
          hasAiTranscript: row.has_ai_transcript === true,
          // S67c: same PENDING_CALL rule as call rows, so report cards can show the unread dot.
          unseen: row.unseen === true,
          transcriptCompletedAt: row.completed_at,
          callUrl: `/api/v1/calls/${row.call_id}`,
          transcriptUrl: `/api/v1/calls/${row.call_id}/transcript`,
          recordingUrl: `/api/v1/calls/${row.call_id}/recordings`,
          aiTranscriptUrl: `/api/v1/calls/${row.call_id}/ai-transcript`,
        };
      }),
      ...(parameters.page === undefined ? {} : pageEnvelope(parameters.page, parameters.pageSize, counted!.rows[0].total)),
    };
  });
}
