import {createHmac, timingSafeEqual} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

type Period = '7d' | '1m' | '6m' | '1y';
type AdminIdentity = {userId: string};
type ReportWindow = {
  fromInclusive: Date;
  toExclusive: Date;
  period: string;
  timeZone: string;
  disambiguation: string;
};

export type AdminGatewayReportDependencies = {
  requireAdmin(request: FastifyRequest): AdminIdentity;
  fail(status: number, code: string, message: string, details?: unknown): never;
  reportWindow(input: {
    period: Period;
    anchor: Date;
    timeZone: string;
    disambiguation: 'compatible';
  }): ReportWindow;
  cursorSecret: string | Buffer;
  now?: () => Date;
  cursorTtlMs?: number;
};

type CursorPayload = {
  v: 1;
  gatewayId: string;
  period: Period;
  timeZone: string;
  answeredBy: 'ai';
  limit: number;
  fromInclusive: string;
  toExclusive: string;
  lastStartedAt: string;
  lastId: string;
  expiresAt: number;
};

const querySchema = z.object({
  period: z.enum(['7d', '1m', '6m', '1y']),
  timeZone: z.string().min(1).max(100),
  answeredBy: z.literal('ai'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(4096).optional(),
}).strict();

const cursorSchema = z.object({
  v: z.literal(1),
  gatewayId: z.uuid(),
  period: z.enum(['7d', '1m', '6m', '1y']),
  timeZone: z.string().min(1).max(100),
  answeredBy: z.literal('ai'),
  limit: z.number().int().min(1).max(100),
  fromInclusive: z.iso.datetime({offset: true}),
  toExclusive: z.iso.datetime({offset: true}),
  lastStartedAt: z.iso.datetime({offset: true}),
  lastId: z.uuid(),
  expiresAt: z.number().int().positive(),
}).strict();

export function registerAdminGatewayReportRoutes(
  app: FastifyInstance,
  db: Pool,
  dependencies: AdminGatewayReportDependencies,
) {
  const secret = Buffer.isBuffer(dependencies.cursorSecret)
    ? Buffer.from(dependencies.cursorSecret)
    : Buffer.from(dependencies.cursorSecret, 'utf8');
  if (secret.length < 32) throw new Error('Admin gateway report cursor secret must be at least 32 bytes');
  const now = dependencies.now ?? (() => new Date());
  const cursorTtlMs = dependencies.cursorTtlMs ?? 15 * 60_000;
  if (!Number.isInteger(cursorTtlMs) || cursorTtlMs < 1_000 || cursorTtlMs > 24 * 60 * 60_000) {
    throw new Error('Admin gateway report cursor TTL is invalid');
  }

  app.get('/api/v1/admin/gateways/:gatewayId/reports/calls', async (request, reply) => {
    const identity = dependencies.requireAdmin(request);
    const {gatewayId} = z.object({gatewayId: z.uuid()}).parse(request.params);
    const query = querySchema.parse(request.query);
    const requestNow = now();
    if (!Number.isFinite(requestNow.getTime())) throw new Error('Admin gateway report clock is invalid');

    const gateway = await db.query('SELECT 1 FROM gateways WHERE id=$1', [gatewayId]);
    if (!gateway.rowCount) dependencies.fail(404, 'NOT_FOUND', 'Gateway not found');

    let window: {fromInclusive: Date; toExclusive: Date};
    let boundary: {startedAt: string; id: string} | null = null;
    let expiresAt: number;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, secret, requestNow, dependencies.fail);
      if (cursor.gatewayId !== gatewayId || cursor.period !== query.period || cursor.timeZone !== query.timeZone ||
          cursor.answeredBy !== query.answeredBy || cursor.limit !== query.limit) {
        dependencies.fail(400, 'INVALID_CURSOR', 'Cursor does not match this report query');
      }
      window = {fromInclusive: new Date(cursor.fromInclusive), toExclusive: new Date(cursor.toExclusive)};
      boundary = {startedAt: cursor.lastStartedAt, id: cursor.lastId};
      expiresAt = cursor.expiresAt;
    } else {
      let calculated: ReportWindow;
      try {
        calculated = dependencies.reportWindow({
          period: query.period,
          anchor: requestNow,
          timeZone: query.timeZone,
          disambiguation: 'compatible',
        });
      } catch {
        dependencies.fail(400, 'INVALID_TIME_ZONE', 'A valid IANA time zone is required');
      }
      window = {fromInclusive: calculated!.fromInclusive, toExclusive: calculated!.toExclusive};
      expiresAt = requestNow.getTime() + cursorTtlMs;
    }
    if (!Number.isFinite(window.fromInclusive.getTime()) || !Number.isFinite(window.toExclusive.getTime()) ||
        window.fromInclusive >= window.toExclusive || window.toExclusive > requestNow) {
      dependencies.fail(400, 'INVALID_CURSOR', 'Cursor contains an invalid report window');
    }

    const values: unknown[] = [gatewayId, window.fromInclusive, window.toExclusive, query.limit + 1];
    let boundarySql = '';
    if (boundary) {
      values.push(boundary.startedAt, boundary.id);
      boundarySql = `AND (c.started_at,c.id) < ($5::timestamptz,$6::uuid)`;
    }
    const result = await db.query(`SELECT c.id call_id,c.remote_number,c.started_at,c.answered_at,c.ended_at,c.gateway_time_zone,
        to_char(c.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') started_at_cursor,
        c.state,c.mode_snapshot,c.answered_by_platform,c.recording_status,
        s.id sim_id,s.label sim_label,s.slot_index,
        owner.id owner_id,owner.email owner_username,
        transcript.state transcript_state,transcript.result transcript_result,transcript.completed_at transcript_completed_at
      FROM call_records c
      JOIN sims s ON s.id=c.sim_id
      JOIN users owner ON owner.id=c.snapshot_owner_id
      LEFT JOIN LATERAL (
        SELECT state,result,completed_at FROM transcript_jobs
        WHERE call_id=c.id AND snapshot_owner_id=c.snapshot_owner_id
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) transcript ON true
      WHERE c.gateway_id=$1 AND c.started_at >= $2 AND c.started_at < $3
        AND c.answered_by_platform='ai'
        AND COALESCE(transcript.result->>'advertisingClassification','unknown') <> 'advertising'
        ${boundarySql}
      ORDER BY c.started_at DESC,c.id DESC
      LIMIT $4`, values);

    const pageRows = result.rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    const nextCursor = result.rows.length > query.limit && last ? encodeCursor({
      v: 1,
      gatewayId,
      period: query.period,
      timeZone: query.timeZone,
      answeredBy: 'ai',
      limit: query.limit,
      fromInclusive: window.fromInclusive.toISOString(),
      toExclusive: window.toExclusive.toISOString(),
      lastStartedAt: last.started_at_cursor,
      lastId: last.call_id,
      expiresAt,
    }, secret) : null;

    await db.query(
      `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)
       VALUES($1,'gateway.ai_reports.read','gateway',$2,$3::jsonb)`,
      [identity.userId, gatewayId, JSON.stringify({period: query.period, resultCount: pageRows.length})],
    );
    reply.header('Cache-Control', 'private, no-store');
    return {
      window: {
        period: query.period,
        timeZone: query.timeZone,
        fromInclusive: window.fromInclusive,
        toExclusive: window.toExclusive,
      },
      items: pageRows.map(reportItem),
      nextCursor,
    };
  });
}

function reportItem(row: any) {
  const result = row.transcript_state === 'succeeded' && row.transcript_result && typeof row.transcript_result === 'object'
    ? row.transcript_result : null;
  const classification = result?.advertisingClassification === 'not_advertising' ? 'not_advertising' : 'unknown';
  return {
    callId: row.call_id,
    sim: {id: row.sim_id, label: row.sim_label, slotIndex: Number(row.slot_index)},
    historicalOwner: {id: row.owner_id, username: row.owner_username},
    remoteNumberMasked: maskNumber(row.remote_number),
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    gatewayTimeZone: row.gateway_time_zone,
    state: row.state,
    modeSnapshot: row.mode_snapshot,
    answeredByPlatform: 'ai',
    transcriptStatus: row.transcript_state ?? 'not_started',
    summary: typeof result?.summary === 'string' ? result.summary : null,
    actionItems: Array.isArray(result?.actionItems) && result.actionItems.every((item: unknown) => typeof item === 'string')
      ? result.actionItems : [],
    recordingStatus: row.recording_status,
    advertisingClassification: classification,
    transcriptCompletedAt: row.transcript_completed_at,
  };
}

function maskNumber(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
}

function encodeCursor(payload: CursorPayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function decodeCursor(
  value: string,
  secret: Buffer,
  currentTime: Date,
  fail: AdminGatewayReportDependencies['fail'],
): CursorPayload {
  try {
    const pieces = value.split('.');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new Error('shape');
    const expected = createHmac('sha256', secret).update(pieces[0]).digest();
    const supplied = Buffer.from(pieces[1], 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('signature');
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')));
    if (cursor.expiresAt <= currentTime.getTime()) throw new Error('expired');
    return cursor;
  } catch {
    fail(400, 'INVALID_CURSOR', 'Cursor is invalid or expired');
  }
}
