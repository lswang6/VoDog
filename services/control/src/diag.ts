import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Db } from "./db.js";

const device = hostname().slice(0, 120) || "control";

/**
 * S69: Control's own rows carry the short SHA-256 of the running `app.js` — the same hash the
 * deploy scripts and the docs quote. Under tsx (tests, dev) it is the hash of `app.ts`.
 */
export const CONTROL_VERSION = (() => {
  try {
    const file = new URL(import.meta.url.endsWith(".ts") ? "./app.ts" : "./app.js", import.meta.url);
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 8);
  } catch {
    return "unknown";
  }
})();

/**
 * S36 C3: one structured diagnostic row. Fire and forget on purpose — a diagnostic must never delay
 * or fail the request it describes, and the table is dropped wholesale by retention after 30 days.
 * S36b D3: `source`/`device`/`level` are overridable so Control can also file a row on behalf of a
 * gateway (the heartbeat's `deviceStatus` piggyback) and mark a failed request as an error.
 */
export function diag(
  db: Db,
  event: string,
  fields: Record<string, unknown> = {},
  target: {
    callId?: string | null;
    userId?: string | null;
    source?: string;
    device?: string;
    level?: "debug" | "info" | "warn" | "error";
  } = {},
) {
  const source = target.source ?? "control";
  return db
    .query(
      `INSERT INTO diag_events(ts,source,device,user_id,call_id,level,event,fields,app_version)
       VALUES(now(),$1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        source,
        (target.device ?? device).slice(0, 120),
        target.userId ?? null,
        target.callId ?? null,
        target.level ?? "info",
        event.slice(0, 120),
        JSON.stringify(fields),
        // A row filed on a gateway's behalf is not Control's version.
        source === "control" ? CONTROL_VERSION : null,
      ],
    )
    .then(() => undefined, (error) => {
      // Still fire and forget, but a dead diag table must not go unnoticed: one line a minute.
      if (throttled("diag.insert_failed")) console.warn(`diag insert failed (${event}): ${errorReason(error)}`);
    });
}

const lastAt = new Map<string, number>();
/** True at most once per `ms` for `key` — rate-limits a repeating failure to one log row/line. */
export function throttled(key: string, ms = 60_000, now = Date.now()) {
  if (now - (lastAt.get(key) ?? -Infinity) < ms) return false;
  lastAt.set(key, now);
  return true;
}

/** Error name and code only: messages can carry SQL, URLs or numbers that a diag row must not. */
export function errorReason(error: unknown) {
  const e = error as { name?: unknown; code?: unknown; status?: unknown } | null;
  const code = e?.code ?? e?.status;
  return `${typeof e?.name === "string" ? e.name : typeof error}${code != null ? `:${String(code)}` : ""}`.slice(0, 120);
}

/** S69: a background worker swallowed an error; one warn row per worker per minute. */
export function workerError(db: Db, worker: string, error: unknown) {
  if (throttled(`worker.error:${worker}`)) diag(db, "worker.error", { worker, reason: errorReason(error) }, { level: "warn" });
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
/**
 * S69: `sms.failed` for SMS rows that just turned failed/unknown. Written on the caller's own
 * transaction client, so a rolled-back or retried transaction files nothing extra; the savepoint
 * keeps a failed diagnostic from aborting the business transaction. No rows, no query.
 */
export async function smsFailed(c: Queryable, smsIds: string[]) {
  if (!smsIds.length) return;
  try {
    await c.query("SAVEPOINT s69_sms_diag");
    await c.query(
      `INSERT INTO diag_events(ts,source,device,user_id,level,event,fields,app_version)
       SELECT now(),'control',$1,m.snapshot_owner_id,'warn','sms.failed',jsonb_build_object('smsId',m.id,'simId',m.sim_id,
         'gatewayId',m.gateway_id,'toNumber',m.remote_number,'state',m.state,'reason',m.failure_reason,
         'queueAgeMs',floor(extract(epoch FROM clock_timestamp()-m.created_at)*1000)::bigint),$3
       FROM sms_messages m WHERE m.id=ANY($2::uuid[])`,
      [device, smsIds, CONTROL_VERSION],
    );
    await c.query("RELEASE SAVEPOINT s69_sms_diag");
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s69_sms_diag").catch(() => undefined);
  }
}

/**
 * S69: 600 events a minute per install (or session / gateway), with a 2500 burst so one post-outage
 * replay (client spool 2000 + ring 500, drained in a single flush) is never cut short — clients treat
 * a 200 as delivered and would lose the tail. Anything past the burst is dropped. Returns how many of `n` fit.
 */
const buckets = new Map<string, { tokens: number; at: number }>();
export function takeDiagTokens(key: string, n: number, now = Date.now(), perMinute = 600, burst = 2500) {
  // ponytail: whole-map reset past 10k keys; an LRU if installs ever reach that.
  if (buckets.size > 10_000) buckets.clear();
  const b = buckets.get(key) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) * perMinute) / 60_000);
  b.at = now;
  const taken = Math.max(0, Math.min(n, Math.floor(b.tokens)));
  b.tokens -= taken;
  buckets.set(key, b);
  return taken;
}

/** S69: `gateway.heartbeat_gap` fires past max(3 × median of the last 20 intervals, 15 s). */
export function heartbeatGapThresholdMs(intervals: number[]) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  return Math.max(3 * median, 15_000);
}

/**
 * S69: per-request levels. A code that the design produces on purpose (feature off, a normal race,
 * an expired session polling) is info; any other 5xx is error, any other 4xx warn.
 */
const EXPECTED_CODES = new Set(["MEDIA_QUALITY_UNAVAILABLE", "MEDIA_NODE_PENDING", "CAPTURE_NOT_ACTIVE", "CAPTURE_NOT_CONFIRMED", "CALL_NOT_TERMINAL"]);
export function requestLevel(input: { method: string; status: number; code: string | null }) {
  if (input.status < 400) return "info" as const;
  if (input.code && EXPECTED_CODES.has(input.code)) return "info" as const;
  if (input.status === 401 && input.method === "GET") return "info" as const;
  return input.status >= 500 ? ("error" as const) : ("warn" as const);
}

/**
 * S69 (replaces S36b "every user request"): a row per request only for non-GET user requests,
 * failures and slow calls. A successful, not-slow user GET goes to the 5-minute `http.rollup`.
 * Anything else — a healthy gateway heartbeat, doorbell or ack poll — costs nothing.
 * Pure so a test can pin the rules without having to produce a slow response.
 */
export function shouldLogRequest(input: { userRequest: boolean; method: string; route: string | null; status: number; ms: number }): "row" | "rollup" | null {
  if (input.status >= 400 || input.ms > (SLOW_MS[input.route ?? ""] ?? 1000)) return "row";
  if (!input.userRequest || input.route === "/api/v1/diag/events") return null;
  return input.method === "GET" ? "rollup" : "row";
}
// The doorbell is a designed long poll (held up to its 8 s hard cap) and the heartbeat is the
// gateway's steady beat: only a failure or a hold past that is worth a row (123k/week otherwise).
const SLOW_MS: Record<string, number> = {
  "/api/v1/gateway/commands/doorbell": 9000,
  "/api/v1/gateway/heartbeat": 2000,
};

type RollupKey = { client: string; platform: string; method: string; route: string; userId: string | null; sessionId: string; installId: string | null };
/**
 * S69: in-memory 5-minute summary of successful user GETs, one `http.rollup` row per
 * (install or session, platform, method, route). A restart loses the last < 5 min.
 */
export class HttpRollup {
  private buckets = new Map<string, RollupKey & { ms: number[]; statuses: Record<string, number> }>();
  add(key: RollupKey, ms: number, status: number) {
    const id = [key.client, key.platform, key.method, key.route].join("\u0000");
    let b = this.buckets.get(id);
    if (!b) this.buckets.set(id, (b = { ...key, ms: [], statuses: {} }));
    b.ms.push(ms);
    b.statuses[status] = (b.statuses[status] ?? 0) + 1;
  }
  /** One awaited multi-row insert, so a flush on close lands before the pool ends. */
  async flush(db: Db) {
    const rows = [...this.buckets.values()];
    this.buckets.clear();
    if (!rows.length) return;
    const pct = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    try {
      await db.query(
        `INSERT INTO diag_events(ts,source,device,user_id,level,event,fields,install_id,app_version) VALUES ` +
          rows.map((_, i) => `(now(),'control',$${i * 5 + 1},$${i * 5 + 2},'info','http.rollup',$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`).join(","),
        rows.flatMap((r) => {
          const s = r.ms.sort((a, b) => a - b);
          return [device, r.userId, JSON.stringify({
            route: r.route, method: r.method, platform: r.platform, count: s.length,
            p50Ms: pct(s, 0.5), p95Ms: pct(s, 0.95), maxMs: s[s.length - 1], statuses: r.statuses,
            sessionId: r.sessionId, installId: r.installId,
          }), r.installId, CONTROL_VERSION];
        }),
      );
    } catch (error) {
      if (throttled("diag.insert_failed")) console.warn(`diag insert failed (http.rollup): ${errorReason(error)}`);
    }
  }
}
