import {releaseSms,observeSmsAck} from "./sms-pacing.js";
import {isEmergencyServiceNumber,smsAddress} from "./phone-address.js";
import {
  blocklistItemDto,
  blocklistKeysOverlap,
  bumpOwnerBlocklistRevision,
  canonicalBlocklistKey,
  countOwnerInterceptions,
  gatewayNumberBlocklist,
  loadOwnerBlockedNumbers,
  loadBlockedCandidates,
  loadOwnerInterceptions,
  ownerBlocksRemote,
  phoneBlocklistSyncMode,
  recordSmsInterception,
} from "./blocklist.js";
import { pageEnvelope, pageOffset, pageQueryShape } from "./pagination.js";
import {
  annotateNumbers,
  EMPTY_NUMBER_ANNOTATION,
  normalizeContactName,
  normalizePhone,
  ownerCountryIso,
  type NumberAnnotation,
} from "./contacts/repository.js";
import {registerContactRoutes} from "./contacts/routes.js";
import {
  consumeDesiredPower,
  GATEWAY_STANDBY_HARD_CAP_MS,
  GatewayPowerError,
  listGatewayPower,
  readGatewayPower,
  recordStandby,
  requestGatewayPower,
} from "./gateway-power.js";
import {appendAiTranscript,readCallTranscript} from "./ai-runs/transcripts.js";
import {reclaimAbsentGatewayLocks,STALE_LOCK_ABSENCE_MS,USER_HIDDEN_RECLAIM_REASONS} from "./snapshot-reclaim.js";
import { passkeyOrigins } from "./config.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PoolClient } from "pg";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { safeRollback, withClient, type Db } from "./db.js";
import { MediaNodeNotFoundError, MediaNodeRegistry } from "./media-node-registry.js";
import { MediaBridgeError } from "./media-client.js";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ApnsClient } from "./apns.js";
import { PushWorker } from "./push-worker.js";
import { registerPushRoutes } from "./push-routes.js";
import { MediaCloseWorker } from "./media-close-worker.js";
import {
  RecordingStore,
  RemoteRecordingStore,
  RecordingStoreError,
  recordingTracks,
  type RecordingTrack,
} from "./recording-store.js";
import { deleteCallRecord } from "./call-deletion.js";
import {
  opaqueToken,
  requestFingerprint,
  tokenHash,
  verifyPassword,
} from "./security.js";
import {AuthAttemptLimiter, emitCrowdsecAuthFail} from "./auth-attempts.js";
import {verifyTurnstileToken} from "./turnstile.js";
import {registerTranscriptionRoutes} from './transcription/routes.js';
import {assertIanaTimeZone,loadReportDayWindow,loadReportWindow} from './report-window.js';
import {createHash,createHmac} from 'node:crypto';
import {registerAdminGatewayReportRoutes} from './admin-gateway-reports.js';
import {MediaProbeCoordinator,registerMediaProbeRoutes} from './media-probe-routes.js';
import {MediaQualityProbeCoordinator} from './media-quality-probes.js';
import {registerMediaQualityProbeRoutes} from './media-quality-probe-routes.js';
import {closeWebCallLease,createInitialWebCallLease,isWebCallPrincipal,markWebCallLeaseForCleanup,readWebCallLease,renewWebCallLease,WebCallLivenessError,WebCallLivenessWorker} from './web-call-liveness.js';
import {createFcmAccessTokenProvider} from './fcm-credentials.js';
import {FcmClient} from './fcm.js';
import {AndroidPushWorker} from './android-push-worker.js';
import {BadgeWorker,PENDING_CALL,visibleCall,registerBadgeRoutes} from './badges.js';
import {registerAiRunRoutes} from './ai-runs/routes.js';
import {registerVoiceProviderRoutes} from './ai-runs/voice-providers.js';
import {AiRunReconciler} from './ai-runs/reconciler.js';
import {aiWorkerAvailable,createAiRunForIncoming,markHumanWinner,observeAiAnswerAck,observeAiCallState} from './ai-runs/repository.js';
import {markSessionCallsForRevokedCleanup,RevokedCallCleanupWorker} from './session-revoked-cleanup.js';
import {ensureCaptureBinding,PixelRecordingArchiveReader,registerRecordingArchiveRoutes,type CaptureInput} from './recording-archive.js';
import {RecordingFileVerificationBusyError} from './recording-file-verifier.js';
import {coordinateReplayMigration,completeReplayMigration} from './replay-migration.js';
import {coordinateReplayHorizon,commandReplayFingerprint,replayDigest,replayProposalStallTracker} from './replay-horizon.js';
import {clientPlatformLabel,normalizeAaguid,toPasskeyItem} from './passkey-metadata.js';
import {CommandDoorbell,hasDeliverableCommand} from './command-doorbell.js';
import {cancelUndeliveredDial} from './dial-cancel.js';
import {diag,errorReason,heartbeatGapThresholdMs,HttpRollup,requestLevel,shouldLogRequest,smsFailed,takeDiagTokens,throttled,workerError} from './diag.js';

type User = { id: string; username: string; role: "admin" | "user" };
type Principal =
  | {
      kind: "user";
      user: User;
      sessionId: string;
      authMode: "cookie" | "bearer";
      clientType: "web" | "native";
      platform: "web" | "ios" | "android" | "macos" | null;
    }
  | { kind: "device"; gatewayId: string };
declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    /** S36b D3: the error code this request replied with — `onResponse` cannot read the payload. */
    diagCode?: string;
  }
  interface FastifyInstance {
    commandDoorbell: CommandDoorbell;
  }
}
/** S20 D4 contract: the doorbell may never hold a gateway request longer than this. */
const DOORBELL_HARD_CAP_MS = 8000;
/** S36b D3: the gateway's steady heartbeat cadence (GatewayConnectionTracker.NORMAL_POLL_MS). */
const GATEWAY_HEARTBEAT_EXPECTED_MS = 2000;
/** S42 决策 2: how long every other client still has to beat the AI after the owner reports a busy device. */
const OWNER_BUSY_AI_GRACE_SECONDS = 5;
/** S36b D3: the gateway row as it was before a heartbeat applied — what a flip is measured against. */
type GatewayHeartbeatPrev = { control_enabled: boolean; telephony_ready: boolean; sms_ready: boolean; media_ready: boolean; last_seen_at: string | null };

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
const fail = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): never => {
  throw new ApiError(status, code, message, details);
};
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  return value;
}
const sameJsonPayload = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
const WEB_CALL_PROTOCOL = "web-liveness-v1";
const outboundCallNumber = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Invalid call destination")
  .transform((value) => value.trim())
  .refine(
    (value) => /^(?:\+[1-9][0-9]{1,14}|[0-9]{3,15})$/.test(value),
    "Invalid call destination",
  )
  .refine((value) => value !== "112" && value !== "911", "Emergency calls are not supported");
function requireWebCallProtocol(req:FastifyRequest,p:Extract<Principal,{kind:"user"}>,config:Config){
  if(config.WEB_CALL_LIVENESS_ENABLED&&isWebCallPrincipal(p)&&req.headers["x-vodog-call-protocol"]!==WEB_CALL_PROTOCOL)
    fail(409,"CLIENT_UPGRADE_REQUIRED","请刷新 VoDog 后再拨打或接听电话");
}
type RegistrationVerification = Awaited<
  ReturnType<typeof verifyRegistrationResponse>
>;
type AuthenticationVerification = Awaited<
  ReturnType<typeof verifyAuthenticationResponse>
>;
function assertRegistrationVerified(
  value: RegistrationVerification | undefined,
): asserts value is Extract<RegistrationVerification, { verified: true }> {
  if (!value?.verified)
    fail(
      400,
      "PASSKEY_VERIFICATION_FAILED",
      "Passkey registration could not be verified",
    );
}
function assertAuthenticationVerified(
  value: AuthenticationVerification | undefined,
): asserts value is AuthenticationVerification {
  if (!value?.verified)
    fail(
      400,
      "PASSKEY_VERIFICATION_FAILED",
      "Passkey authentication could not be verified",
    );
}
const userJson = (u: User) => ({
  id: u.id,
  username: u.username,
  role: u.role,
});
const loginAttempts = new AuthAttemptLimiter();
function rejectAuthAttempts(ip: string | undefined, username: string, type: "password" | "passkey") {
  if (loginAttempts.blocked(ip, username)) {
    emitCrowdsecAuthFail({ip, type, username});
    fail(429, "RATE_LIMITED", "Too many login attempts");
  }
}
function recordAuthFailure(ip: string | undefined, username: string, type: "password" | "passkey") {
  loginAttempts.recordFailure(ip, username);
  emitCrowdsecAuthFail({ip, type, username});
}

/**
 * Enforces the Cloudflare Turnstile challenge on the pre-authentication endpoints. The check runs after the rate
 * limiter so a blocked client is rejected before any upstream call, and regardless of platform so web, iOS and
 * Android logins are all covered. When Turnstile is disabled the token is simply ignored.
 */
async function requireTurnstile(config: Config, req: FastifyRequest, token: string | undefined) {
  if (!config.TURNSTILE_ENABLED) return;
  if (!token) fail(400, "TURNSTILE_REQUIRED", "请先完成人机验证");
  const verification = await verifyTurnstileToken(token, req.ip, {
    secret: config.TURNSTILE_SECRET_KEY!,
    ...(turnstileHostname(config) ? {expectedHostname: turnstileHostname(config)!} : {}),
  });
  if (!verification.success) {
    req.log.warn({code: verification.error, codes: verification.codes}, "turnstile verification failed");
    fail(403, "TURNSTILE_FAILED", "人机验证未通过，请刷新后重试");
  }
}

function turnstileHostname(config: Config): string | null {
  try { return new URL(config.PUBLIC_ORIGIN).hostname; } catch { return null; }
}

/**
 * A deadlock victim (40P01) and a serialization failure (40001) leave the transaction fully rolled
 * back, so re-running the closure is safe: every `tx` closure here is pure database work — the
 * doorbell is rung after the commit (S20 D4), media/push calls never run inside one, and every
 * accumulator a closure mutates is declared inside it. Retry only when the ROLLBACK itself
 * succeeded; a failed rollback marks the client broken and the state is unknown.
 */
export async function tx<T>(db: Db, fn: (c: PoolClient) => Promise<T>, label = "tx"): Promise<T> {
  return withClient(db, async (c) => {
    for (let attempt = 1; ; attempt++) {
      await c.query("BEGIN");
      try {
        const value = await fn(c);
        await c.query("COMMIT");
        return value;
      } catch (e) {
        const rollbackFailed = await safeRollback(c);
        const code = (e as { code?: unknown } | null)?.code;
        if (attempt >= 3 || rollbackFailed || (code !== "40P01" && code !== "40001")) throw e;
        diag(db, "db.deadlock_retry", { label, code, attempt }, { level: "warn" });
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
      }
    }
  });
}

function requireUser(
  req: FastifyRequest,
): Extract<Principal, { kind: "user" }> {
  if (req.principal?.kind !== "user")
    fail(401, "UNAUTHENTICATED", "Authentication required");
  return req.principal as Extract<Principal, { kind: "user" }>;
}
function requireDevice(
  req: FastifyRequest,
): Extract<Principal, { kind: "device" }> {
  if (req.principal?.kind !== "device")
    fail(401, "DEVICE_UNAUTHENTICATED", "Device authentication required");
  return req.principal as Extract<Principal, { kind: "device" }>;
}
function requireAdmin(req: FastifyRequest) {
  const p = requireUser(req);
  if (p.user.role !== "admin")
    fail(403, "FORBIDDEN", "Administrator access required");
  return p;
}
function mutationOrigin(req: FastifyRequest, config: Config) {
  if (
    req.principal?.kind === "user" &&
    req.principal.authMode === "cookie" &&
    req.headers.origin !== config.PUBLIC_ORIGIN
  )
    fail(
      403,
      "ORIGIN_REJECTED",
      "Cookie-authenticated changes require the configured origin",
    );
}
function idemKey(req: FastifyRequest): string {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 200)
    fail(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required",
    );
  return key as string;
}
function online(lastSeen: Date | null, enabled: boolean, config: Config) {
  return (
    enabled &&
    !!lastSeen &&
    Date.now() - lastSeen.getTime() <= config.GATEWAY_ONLINE_SECONDS * 1000
  );
}

async function settingsAvailability(db:Db,config: Config) {
  if (!config.AI_ENABLED)
    return { availableModes: ["normal"], aiUnavailableCode: "AI_DISABLED", aiUnavailableReason: "AI 接听尚未开放" };
  if (!config.AI_WORKER_READY || !config.AI_INTERNAL_TOKEN || !await aiWorkerAvailable(db))
    return { availableModes: ["normal"], aiUnavailableCode: "AI_WORKER_UNAVAILABLE", aiUnavailableReason: "AI 接听服务尚未就绪" };
  return { availableModes: ["normal", "ai", "timeout_ai"] };
}

function settingsDto(r: any, availability:Awaited<ReturnType<typeof settingsAvailability>>) {
  return {
    mode: r.mode,
    timeoutSeconds: r.timeout_seconds,
    version: Number(r.settings_version ?? r.version),
    appliedVersion:
      (r.applied_version === null || r.applied_version === undefined)
        ? null
        : Number(r.applied_version),
    ...availability,
  };
}

export async function buildApp(
  db: Db,
  config: Config,
): Promise<FastifyInstance> {
  const reportWindow=await loadReportWindow(),reportDayWindow=await loadReportDayWindow();
  const media = MediaNodeRegistry.fromConfig(config);
  if(config.MEDIA_RELAY_NODE_ID&&!media?.nodeIds().includes(config.MEDIA_RELAY_NODE_ID))throw new Error('MEDIA_RELAY_NODE_ID is not a configured media node');
  if(config.MEDIA_PREFERRED_NODE_ID&&!media?.nodeIds().includes(config.MEDIA_PREFERRED_NODE_ID))throw new Error('MEDIA_PREFERRED_NODE_ID is not a configured media node');
  const probeNodes=media?.qualityProbeNodes()??[];
  const mediaProbes=probeNodes.length?new MediaQualityProbeCoordinator({nodes:probeNodes,defaultNodeId:media!.defaultNodeId,enabled:config.MEDIA_QUALITY_PROBES_ENABLED===true}):null;
  const recordings = config.RECORDING_ROOT
    ? new RecordingStore(config.RECORDING_ROOT)
    : null;
  const pixelRecordings=config.PIXEL_ARCHIVE_ENABLED&&config.PIXEL_ARCHIVE_ROOT?new PixelRecordingArchiveReader(db,config.PIXEL_ARCHIVE_ROOT):null;
  const mediaCloseWorker=media?new MediaCloseWorker(db,media,{gatewayOfflineSeconds:config.GATEWAY_ONLINE_SECONDS}):null;
  // S20 D4: every command insert rings this after its own transaction committed; a suspended gateway
  // request then returns immediately instead of waiting for the next heartbeat.
  const commandDoorbell=new CommandDoorbell();
  // S21 §D: a separate waiter table for the standby beacon. It must never share the command
  // doorbell's 8 s cap or its per-gateway slot — an OFF gateway holds one request of its own.
  const standbyDoorbell=new CommandDoorbell();
  const rawDoorbellMaxHoldMs=Number(config.GATEWAY_COMMAND_DOORBELL_MAX_MS??0);
  const doorbellMaxHoldMs=Number.isFinite(rawDoorbellMaxHoldMs)?Math.min(DOORBELL_HARD_CAP_MS,Math.max(0,Math.trunc(rawDoorbellMaxHoldMs))):0;
  const rawStandbyMaxHoldMs=Number(config.GATEWAY_STANDBY_MAX_HOLD_MS??GATEWAY_STANDBY_HARD_CAP_MS);
  const standbyMaxHoldMs=Number.isFinite(rawStandbyMaxHoldMs)?Math.min(GATEWAY_STANDBY_HARD_CAP_MS,Math.max(0,Math.trunc(rawStandbyMaxHoldMs))):GATEWAY_STANDBY_HARD_CAP_MS;
  const ringDoorbell=(gatewayId:string|null|undefined)=>{if(gatewayId)commandDoorbell.notify(gatewayId);};
  const aiRunReconciler=new AiRunReconciler(db,{onlineSeconds:config.GATEWAY_ONLINE_SECONDS,onMediaClose:callId=>requestMediaClose(db,media,callId),onCommandInserted:ringDoorbell});
  const revokedCallCleanupWorker=new RevokedCallCleanupWorker(db,{onlineSeconds:config.GATEWAY_ONLINE_SECONDS,onMediaClose:callId=>requestMediaClose(db,media,callId),onCommandInserted:ringDoorbell});
  const webCallLivenessWorker=new WebCallLivenessWorker(db,{enabled:config.WEB_CALL_LIVENESS_ENABLED,gatewayOnlineSeconds:config.GATEWAY_ONLINE_SECONDS,onMediaClose:callId=>requestMediaClose(db,media,callId),onCommandInserted:ringDoorbell});
  const app = Fastify({
    // Errors were invisible in production while the logger defaulted to off (S36 C3). Per-request
    // lines are now the `http.request` diag row's job (with `reqId`), so journald keeps warn and
    // above by default — 400k info lines a day on a 1 GB box. LOG_ERRORS=1 brings request lines back.
    logger: { level: process.env.LOG_ERRORS === "1" ? "info" : "warn" },
    trustProxy: true,
    genReqId: () => opaqueToken(12),
  });
  const apnsClient = config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_KEY_PATH
    ? new ApnsClient(config.APNS_KEY_ID, config.APNS_TEAM_ID, await readFile(config.APNS_KEY_PATH, "utf8")) : null;
  const pushWorker = apnsClient ? new PushWorker(db, apnsClient, config.GATEWAY_ONLINE_SECONDS) : null;
  let androidPushWorker:AndroidPushWorker|null=null,fcmClient:FcmClient|null=null;
  if(config.FCM_ENABLED){
    if(!config.FCM_PROJECT_ID||!config.FCM_CREDENTIALS_PATH)throw new Error('FCM requires project ID and credentials path');
    const accessTokens=await createFcmAccessTokenProvider(config.FCM_PROJECT_ID,config.FCM_CREDENTIALS_PATH);
    fcmClient=new FcmClient(config.FCM_PROJECT_ID,accessTokens,undefined,config.FCM_PUSH_REMOTE_NUMBER);
    androidPushWorker=new AndroidPushWorker(db,fcmClient,{onlineSeconds:config.GATEWAY_ONLINE_SECONDS});
  }
  const badgeWorker=new BadgeWorker(db,{apns:apnsClient,fcm:fcmClient},{enabled:config.BADGE_PUSH_ENABLED});
  app.addHook("onReady",async()=>{badgeWorker.start();});
  app.addHook("onClose",async()=>{await badgeWorker.stop();});
  // A ringing call wakes the push workers now instead of on their next 1 s poll.
  const kickPush=()=>{void pushWorker?.tick().catch(()=>{});void androidPushWorker?.tickOnce().catch(()=>{});};
  app.decorate("commandDoorbell",commandDoorbell);
  app.addHook("onClose",async()=>{commandDoorbell.closeAll();standbyDoorbell.closeAll();});
  app.addHook("onReady", async()=>{pushWorker?.start();});
  app.addHook("onClose", async()=>{await pushWorker?.stop();});
  app.addHook("onReady",async()=>{androidPushWorker?.start();});
  app.addHook("onClose",async()=>{await androidPushWorker?.stop();});
  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(helmet, { contentSecurityPolicy: false });
  app.addHook("onReady",async()=>{mediaCloseWorker?.start();});
  app.addHook("onClose",async()=>{await mediaCloseWorker?.stop();});
  app.addHook("onReady",async()=>{webCallLivenessWorker.start();});
  app.addHook("onClose",async()=>{await webCallLivenessWorker.stop();});
  app.addHook("onReady",async()=>{aiRunReconciler.start();});
  app.addHook("onClose",async()=>{await aiRunReconciler.stop();});
  app.addHook("onReady",async()=>{revokedCallCleanupWorker.start();});
  app.addHook("onClose",async()=>{await revokedCallCleanupWorker.stop();});
  // S22: one bounded, idempotent pass. Fire and forget — a search key is never worth delaying
  // readiness or failing startup for, and the process may close while it is still running.
  app.addHook("onReady",async()=>{void backfillCallCanonicalKeys(db,message=>app.log.info(message)).catch(error=>workerError(db,'canonical_key_backfill',error));});
  // S69: successful user GETs are summarised every 5 min instead of one row each.
  const httpRollup=new HttpRollup();
  const rollupTimer=setInterval(()=>{void httpRollup.flush(db);},300_000);rollupTimer.unref();
  app.addHook("onClose",async()=>{clearInterval(rollupTimer);await httpRollup.flush(db);});

  app.setErrorHandler((err, req, reply) => {
    // S36b D3: `onResponse` never sees the payload, so every branch below stashes the code it is
    // about to send on the request; the `http.request` diagnostic reads it from there.
    if (err instanceof ApiError) {
      req.diagCode = err.code;
      return reply.code(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          requestId: req.id,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      });
    }
    if (err instanceof ZodError) {
      req.diagCode = "INVALID_REQUEST";
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          requestId: req.id,
          details: err.issues,
        },
      });
    }
    const fastifyStatus = (err as { statusCode?: number }).statusCode;
    if (fastifyStatus && fastifyStatus >= 400 && fastifyStatus < 500) {
      req.diagCode = "INVALID_REQUEST";
      return reply.code(fastifyStatus).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request could not be parsed",
          requestId: req.id,
        },
      });
    }
    req.diagCode = "INTERNAL_ERROR";
    // Structured and bounded: never the body, headers, or query string.
    req.log.error({
      method: req.method,
      route: req.routeOptions?.url ?? null,
      statusCode: 500,
      code: (err as { code?: unknown }).code ?? null,
      name: (err as Error).name,
      msg: (err as Error).message,
      reqId: req.id,
    });
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId: req.id,
      },
    });
  });

  // S69 (replaces S36b D3's "every user request"): a row per request only for non-GET user
  // requests, failures and slow calls; a successful user GET joins the 5-minute `http.rollup`. A
  // successful gateway heartbeat, doorbell or ack poll matches nothing and costs no query — the
  // predicate runs before any database work, and the insert itself is fire-and-forget.
  app.addHook("onResponse", async (req, reply) => {
    try {
      const p = req.principal;
      const route = req.routeOptions?.url ?? null;
      const ms = Math.round(reply.elapsedTime);
      const disposition = shouldLogRequest({ userRequest: p?.kind === "user", method: req.method, route, status: reply.statusCode, ms });
      if (!disposition) return;
      const header = req.headers["x-diag-source"];
      const source =
        typeof header === "string" ? header.slice(0, 16)
        : p?.kind === "device" ? "gateway"
        : p?.kind === "user" ? p.platform ?? "user"
        : "anon";
      if (disposition === "rollup" && p?.kind === "user") {
        const rawInstall = req.headers["x-diag-install"];
        const installId = typeof rawInstall === "string" && rawInstall.trim() ? rawInstall.trim().slice(0, 64) : null;
        httpRollup.add({ client: installId ?? p.sessionId, platform: source, method: req.method, route: route ?? "", userId: p.user.id, sessionId: p.sessionId, installId }, ms, reply.statusCode);
        return;
      }
      diag(
        db,
        "http.request",
        {
          method: req.method,
          route,
          status: reply.statusCode,
          ms,
          code: req.diagCode ?? null,
          reqId: req.id,
          sessionId: p?.kind === "user" ? p.sessionId : null,
          gatewayId: p?.kind === "device" ? p.gatewayId : null,
          source,
          // Never the address itself: enough to tell two clients apart, not enough to locate one.
          ipHash: req.ip ? createHash("sha256").update(req.ip).digest("hex").slice(0, 12) : null,
        },
        {
          userId: p?.kind === "user" ? p.user.id : null,
          level: requestLevel({ method: req.method, status: reply.statusCode, code: req.diagCode ?? null }),
        },
      );
    } catch { /* a diagnostic never breaks a response */ }
  });

  // S36b D3: refusing a call because the Pixel was not there is itself the diagnostic. Every caller
  // already holds the gateway row, so the id and how stale its last heartbeat was travel with the
  // refusal — that is what separates a dead radio from a gateway app that stopped heartbeating.
  const failGatewayOffline = (
    row: { gateway_id: string; last_seen_at: Date | null; control_enabled: boolean },
    target: { callId?: string | null; userId?: string | null } = {},
  ) => {
    diag(db, "gateway.offline_seen", {
      gatewayId: row.gateway_id,
      lastSeenAgeMs: row.last_seen_at ? Date.now() - new Date(row.last_seen_at).getTime() : null,
      controlEnabled: row.control_enabled,
    }, { ...target, level: "warn" });
    fail(503, "GATEWAY_OFFLINE", "Gateway is offline or locally disabled");
  };

  app.addHook("preHandler", async (req) => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const cookieToken = req.cookies.cc_session;
    const raw = bearer ?? cookieToken;
    if (!raw) return;
    const hash = tokenHash(raw);
    const s = await db.query(
      `SELECT s.id session_id,s.platform,s.client_type,u.id,u.email username,u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.access_hash=$1 AND s.revoked_at IS NULL AND s.access_expires_at>now()`,
      [hash],
    );
    if (s.rowCount) {
      const r = s.rows[0];
      req.principal = {
        kind: "user",
        sessionId: r.session_id,
        platform: r.platform,
        authMode: bearer ? "bearer" : "cookie",
        clientType: r.client_type,
        user: { id: r.id, username: r.username, role: r.role },
      };
      return;
    }
    if (bearer) {
      const d = await db.query(
        `UPDATE device_credentials SET last_used_at=now() WHERE secret_hash=$1 AND revoked_at IS NULL RETURNING gateway_id`,
        [hash],
      );
      if (d.rowCount)
        req.principal = { kind: "device", gatewayId: d.rows[0].gateway_id };
    }
  });

  const loginBody = z.object({
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
    platform: z.enum(["web", "ios", "android", "macos"]),
    deviceName: z.string().max(120).optional(),
    turnstileToken: z.string().min(1).max(4096).optional(),
  });
  // Public pre-login configuration: clients render the Turnstile widget only when the control service requires it.
  app.get("/api/v1/auth/config", async () => ({
    turnstile: { enabled: config.TURNSTILE_ENABLED === true, siteKey: config.TURNSTILE_ENABLED === true ? config.TURNSTILE_SITE_KEY! : null },
  }));
  app.post("/api/v1/auth/login", async (req, reply) => {
    const b = loginBody.parse(req.body);
    const username = b.username.trim().toLowerCase();
    if (b.platform === "web" && req.headers.origin !== config.PUBLIC_ORIGIN)
      fail(403, "ORIGIN_REJECTED", "Web login requires the configured origin");
    rejectAuthAttempts(req.ip, username, "password");
    await requireTurnstile(config, req, b.turnstileToken);
    const q = await db.query(
      `SELECT id,email username,password_hash,role FROM users WHERE email=$1`,
      [username],
    );
    const valid =
      q.rowCount === 1 &&
      (await verifyPassword(b.password, q.rows[0].password_hash));
    if (!valid) {
      recordAuthFailure(req.ip, username, "password");
      fail(401, "INVALID_CREDENTIALS", "Invalid username or password");
    }
    loginAttempts.clear(req.ip, username);
    const u: User = q.rows[0];
    const access = opaqueToken(),
      refresh = b.platform === "web" ? null : opaqueToken();
    const ttl = b.platform === "web" ? "12 hours" : "15 minutes";
    const s = await db.query(
      `INSERT INTO sessions(user_id,access_hash,refresh_hash,client_type,platform,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+$6::interval,CASE WHEN $3::text IS NULL THEN NULL ELSE now()+interval '30 days' END) RETURNING access_expires_at`,
      [
        u.id,
        tokenHash(access),
        refresh ? tokenHash(refresh) : null,
        b.platform === "web" ? "web" : "native",
        b.platform,
        ttl,
      ],
    );
    if (b.platform === "web") {
      reply.setCookie("cc_session", access, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/api/v1",
        maxAge: 12 * 60 * 60,
      });
      return { user: userJson(u) };
    }
    return {
      user: userJson(u),
      token: access,
      refreshToken: refresh,
      expiresAt: s.rows[0].access_expires_at,
    };
  });
  app.post("/api/v1/auth/refresh", async (req) => {
    const b = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    const access = opaqueToken(),
      refresh = opaqueToken();
    const q = await db.query(
      `UPDATE sessions SET access_hash=$1,refresh_hash=$2,access_expires_at=now()+interval '15 minutes',refresh_expires_at=now()+interval '30 days'
      WHERE refresh_hash=$3 AND revoked_at IS NULL AND refresh_expires_at>now() RETURNING access_expires_at`,
      [tokenHash(access), tokenHash(refresh), tokenHash(b.refreshToken)],
    );
    if (!q.rowCount)
      fail(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
    return {
      token: access,
      refreshToken: refresh,
      expiresAt: q.rows[0].access_expires_at,
    };
  });
  app.post("/api/v1/auth/logout", async (req, reply) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const callIds=await markSessionCallsForRevokedCleanup(db,p.sessionId);
    await Promise.all(callIds.map(callId=>requestMediaClose(db,media,callId)));
    reply.clearCookie("cc_session", { path: "/api/v1" });
    return reply.code(204).send();
  });
  app.get("/api/v1/auth/me", async (req) => ({
    user: userJson(requireUser(req).user),
  }));

  app.get("/api/v1/sims", async (req) => {
    const p = requireUser(req);
    const availability=await settingsAvailability(db,config);
    const q = await db.query(
      `SELECT s.id,s.gateway_id,s.slot_index,s.label,s.phone_label,s.country_iso,s.embedded,s.version,s.device_present,s.assignment_pending,g.last_seen_at,g.control_enabled,
      g.telephony_ready,g.sms_ready,g.media_ready,g.time_zone,g.kind gateway_kind,
      st.mode,st.timeout_seconds,st.version settings_version,st.applied_version FROM sims s JOIN gateways g ON g.id=s.gateway_id
      JOIN sim_settings st ON st.sim_id=s.id WHERE s.owner_user_id=$1 ORDER BY s.slot_index NULLS LAST, s.id`,
      [p.user.id],
    );
    return {
      items: q.rows.map((r) => ({
        id: r.id,
        gatewayId: r.gateway_id,
        slotIndex: r.slot_index,
        label: r.label,
        phoneLabel: r.phone_label,
        countryIso: r.country_iso,
        embedded: r.embedded,
        telephonyReady: r.telephony_ready,
        smsReady: r.sms_ready,
        mediaReady: r.media_ready,
        timeZone: r.time_zone,
        gatewayKind: r.gateway_kind,
        version: Number(r.version),
        present: r.device_present,
        assignmentPending: r.assignment_pending,
        online:
          r.device_present &&
          !r.assignment_pending &&
          online(r.last_seen_at, r.control_enabled, config),
        settings: settingsDto(r, availability),
      })),
    };
  });
  app.put("/api/v1/sims/:simId", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { simId } = z.object({ simId: z.uuid() }).parse(req.params);
    const b = z
      .object({
        label: z.string().min(1).max(80).optional(),
        phoneLabel: z.string().min(1).max(80).nullable().optional(),
        expectedVersion: z.number().int().positive(),
      })
      .refine((value) => value.label !== undefined || value.phoneLabel !== undefined, {
        message: "label or phoneLabel is required",
      })
      .parse(req.body);
    return tx(db, async (c) => {
      const target=(await c.query(`SELECT gateway_id FROM sims WHERE id=$1 AND owner_user_id=$2`,[simId,p.user.id])).rows[0];
      if(!target)fail(404,'NOT_FOUND','SIM not found');
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[target.gateway_id]);
      const current = await c.query(
        `SELECT id,gateway_id,slot_index,label,phone_label,country_iso,embedded,version,device_present,assignment_pending
         FROM sims WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
        [simId, p.user.id],
      );
      if (!current.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      if (Number(current.rows[0].version) !== b.expectedVersion)
        fail(409, "VERSION_CONFLICT", "SIM changed on another client", {
          currentVersion: Number(current.rows[0].version),
        });
      const label = b.label !== undefined ? b.label : current.rows[0].label;
      const phoneLabel = b.phoneLabel !== undefined ? b.phoneLabel : current.rows[0].phone_label;
      const updated = (
        await c.query(
          `UPDATE sims SET label=$2,phone_label=$3,version=version+1 WHERE id=$1
           RETURNING id,gateway_id,slot_index,label,phone_label,country_iso,embedded,version,device_present,assignment_pending`,
          [simId, label, phoneLabel],
        )
      ).rows[0];
      // Notes share the SIM CAS version, but do not invalidate an unchanged queued route.
      await c.query(`UPDATE sms_dispatch_queue q SET assignment_version=$3 FROM sms_messages m
        WHERE q.sms_id=m.id AND m.sim_id=$1 AND q.assignment_version=$2`,[simId,current.rows[0].version,updated.version]);
      await c.query(
        `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)
         VALUES($1,'sim.notes.update','sim',$2,$3)`,
        [p.user.id, simId, JSON.stringify({label, phoneLabel, version: Number(updated.version)})],
      );
      return {
        sim: {
          id: updated.id,
          gatewayId: updated.gateway_id,
          slotIndex: updated.slot_index,
          label: updated.label,
          phoneLabel: updated.phone_label,
          countryIso: updated.country_iso,
          embedded: updated.embedded,
          version: Number(updated.version),
          present: updated.device_present,
          assignmentPending: updated.assignment_pending,
        },
      };
    });
  });
  app.put("/api/v1/sims/:simId/settings", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { simId } = z.object({ simId: z.uuid() }).parse(req.params);
    const b = z
      .object({
        mode: z.enum(["normal", "ai", "timeout_ai"]),
        timeoutSeconds: z.number().int().min(10).max(120),
        expectedVersion: z.number().int().positive(),
      })
      .parse(req.body);
    const availability = await settingsAvailability(db,config);
    if (!availability.availableModes.includes(b.mode))
      fail(409, "AI_UNAVAILABLE", availability.aiUnavailableReason ?? "AI 接听当前不可用", {
        aiUnavailableCode: availability.aiUnavailableCode,
      });
    let doorbellGatewayId: string | null = null;
    const settingsResult = await tx(db, async (c) => {
      const target = await c.query(
        `SELECT gateway_id FROM sims WHERE id=$1 AND (owner_user_id=$2 OR $3='admin')`,
        [simId, p.user.id, p.user.role],
      );
      if (!target.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      const gateway = await c.query(
        `SELECT device_epoch,command_sequence FROM gateways WHERE id=$1 FOR UPDATE`,
        [target.rows[0].gateway_id],
      );
      const current = await c.query(
        `SELECT s.gateway_id,s.owner_user_id,s.version assignment_version,s.device_present,s.assignment_pending,
                st.mode,st.timeout_seconds,st.version settings_version,st.applied_version
         FROM sims s JOIN sim_settings st ON st.sim_id=s.id
         WHERE s.id=$1 AND (s.owner_user_id=$2 OR $3='admin') FOR UPDATE OF s,st`,
        [simId, p.user.id, p.user.role],
      );
      if (!current.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      if (Number(current.rows[0].settings_version) !== b.expectedVersion)
        fail(409, "VERSION_CONFLICT", "Settings changed on another client", {
          currentVersion: Number(current.rows[0].settings_version),
        });
      const updated = (await c.query(
        `UPDATE sim_settings SET mode=$2,timeout_seconds=$3,version=version+1,updated_at=now()
         WHERE sim_id=$1 RETURNING mode,timeout_seconds,version settings_version,applied_version`,
        [simId, b.mode, b.timeoutSeconds],
      )).rows[0];
      await c.query(
        `UPDATE commands SET status='rejected',result='{"reason":"settings_superseded"}'
         WHERE gateway_id=$1 AND sim_id=$2 AND kind='apply_sim_settings' AND status='pending'`,
        [current.rows[0].gateway_id, simId],
      );
      const sequence = Number(gateway.rows[0].command_sequence) + 1;
      await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [
        current.rows[0].gateway_id,
        sequence,
      ]);
      const command = (await c.query(
        `INSERT INTO commands(gateway_id,sim_id,generation,sequence,kind,payload,expires_at)
         VALUES($1,$2,$3,$4,'apply_sim_settings',$5,now()+interval '24 hours')
         RETURNING id,sim_id,generation,sequence,expires_at`,
        [
          current.rows[0].gateway_id,
          simId,
          Number(gateway.rows[0].device_epoch),
          sequence,
          JSON.stringify({
            simId,
            mode: b.mode,
            timeoutSeconds: b.timeoutSeconds,
            settingsVersion: Number(updated.settings_version),
            assignmentVersion: Number(current.rows[0].assignment_version),
          }),
        ],
      )).rows[0];
      doorbellGatewayId = current.rows[0].gateway_id;
      await c.query(
        `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)
         VALUES($1,'sim.settings.update','sim',$2,$3)`,
        [p.user.id, simId, JSON.stringify({mode: b.mode, timeoutSeconds: b.timeoutSeconds,
          settingsVersion: Number(updated.settings_version), assignmentVersion: Number(current.rows[0].assignment_version)})],
      );
      return { settings: settingsDto(updated, availability), command: commandDto(command) };
    });
    ringDoorbell(doorbellGatewayId);
    return settingsResult;
  });

  app.get("/api/v1/calls", async (req) => {
    const p = requireUser(req);
    const { limit, includeBlocked, query, before, beforeId, simId, page, pageSize } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        // S21 §B: intercepted calls belong in /blocklist/interceptions, not in the main history.
        includeBlocked: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
        // S22 全部通话搜索: same parameter name as the contacts route. An empty string is a cleared
        // search box, not a bad request. `before` is the page cursor; `beforeId` is optional because
        // the frozen contract only names `before` — without it the comparison degrades to a strict
        // `started_at <` and can only skip, never duplicate.
        query: z.string().trim().max(64).optional(),
        before: z.coerce.date().optional(),
        beforeId: z.uuid().optional(),
        // S28: the web client used to filter by SIM after the fact, which silently lies once the
        // history is paged — the predicate has to reach the WHERE clause, in both modes.
        simId: z.uuid().optional(),
        ...pageQueryShape,
      })
      .parse(req.query);
    if (page !== undefined && (before !== undefined || beforeId !== undefined))
      fail(400, "INVALID_REQUEST", "page cannot be combined with before or beforeId");
    const search = (query ? query.replace(/[%_\\]/g, "") : "") || null;
    // One fragment, two queries: the page and its count can never disagree about what is filtered.
    // $8 is the session (S72), $9 LIMIT and $10 OFFSET, so the count reuses the leading parameters untouched.
    const where = `WHERE c.snapshot_owner_id=$1 AND ($2::boolean OR c.failure_reason IS DISTINCT FROM 'number_blocked')
        AND ($3::timestamptz IS NULL OR (c.started_at,c.id)<($3::timestamptz,COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)))
        AND ($5::text IS NULL OR c.remote_number ILIKE '%'||$5||'%' OR EXISTS(
          SELECT 1 FROM contact_phones cp JOIN contacts ct ON ct.id=cp.contact_id AND ct.deleted_at IS NULL
          WHERE cp.owner_user_id=$1 AND cp.canonical_key=c.remote_canonical_key AND ct.normalized_name LIKE '%'||$6||'%'))
        AND ($7::uuid IS NULL OR c.sim_id=$7) AND ${visibleCall("$8")}`;
    const filters = [p.user.id, includeBlocked, before ?? null, beforeId ?? null, search,
      search ? normalizeContactName(search) : null, simId ?? null, p.sessionId];
    const [q, counted] = await Promise.all([
      db.query(
        // One LEFT JOIN carries the occupancy lock for the whole page; never a per-row lookup.
        `SELECT c.id,c.sim_id,c.direction,c.remote_number,c.state,c.started_at,c.answered_at,c.ended_at,c.originating_platform,c.answered_by_platform,c.answered_by_device,c.failure_reason,c.conflict_disposition,c.blocked_source,c.recording_status,c.claimed_by_session_id,c.originating_session_id,c.gateway_time_zone,c.mode_snapshot,c.ai_run_id,c.ai_trigger_at,c.internal_call,c.peer_call_id,c.peer_sim_id,${PEER_SIM_LABEL},${SIM_LABEL},run.state ai_run_state,s.country_iso sim_country_iso,gk.kind gateway_kind,lock.acquired_at lock_acquired_at,(${PENDING_CALL}) unseen
      FROM call_records c LEFT JOIN sims s ON s.id=c.sim_id LEFT JOIN gateways gk ON gk.id=s.gateway_id LEFT JOIN gateway_call_locks lock ON lock.call_id=c.id
        LEFT JOIN ai_call_runs run ON run.id=c.ai_run_id
      ${where}
      ORDER BY c.started_at DESC,c.id DESC LIMIT $9${page === undefined ? "" : " OFFSET $10"}`,
        page === undefined
          ? [...filters, limit]
          : [...filters, pageSize, pageOffset(page, pageSize)],
      ),
      // A legacy caller never pays for the count: /calls is polled every 1–2 s by the dashboard.
      page === undefined
        ? null
        : db.query(`SELECT count(*)::int total FROM call_records c ${where}`, filters),
    ]);
    // S21 §F supersedes the S17 behaviour: a call from a blocked number stays in the history and
    // renders a block icon from `blocked`. Only the interception rows are excluded by default.
    const rows = q.rows;
    const annotations = await annotateNumbers(
      db,
      p.user.id,
      rows.map((row) => ({ remoteNumber: row.remote_number, countryIso: row.sim_country_iso })),
      "call",
    );
    return {
      items: rows.map((row, index) => sessionCallDto(row, p.sessionId, annotations[index])),
      ...(page === undefined ? {} : pageEnvelope(page, pageSize, counted!.rows[0].total)),
    };
  });
  app.get("/api/v1/calls/:id", async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const q = await db.query(
      `SELECT c.*,${PEER_SIM_LABEL},${SIM_LABEL},run.state ai_run_state,s.country_iso sim_country_iso,gk.kind gateway_kind,lock.acquired_at lock_acquired_at,(${PENDING_CALL}) unseen FROM call_records c
       LEFT JOIN sims s ON s.id=c.sim_id LEFT JOIN gateways gk ON gk.id=s.gateway_id LEFT JOIN gateway_call_locks lock ON lock.call_id=c.id
       LEFT JOIN ai_call_runs run ON run.id=c.ai_run_id
       WHERE c.id=$1 AND c.snapshot_owner_id=$2`,
      [id, p.user.id],
    );
    // S21 §F: the snapshot owner is the only gate. A blocked number no longer hides its own call
    // detail; the row carries `blocked`/`blockedEntryId` so the card can offer "unblock".
    if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
    const liveness=config.WEB_CALL_LIVENESS_ENABLED&&isWebCallPrincipal(p)?await readWebCallLease(db,id,p.sessionId):null;
    const [annotation] = await annotateNumbers(db, p.user.id, [
      { remoteNumber: q.rows[0].remote_number, countryIso: q.rows[0].sim_country_iso },
    ], "call");
    return { call: sessionCallDto(q.rows[0], p.sessionId, annotation), liveness };
  });
  // S21 §E: the realtime AI transcript of one call, owner isolated.
  app.get("/api/v1/calls/:id/ai-transcript", async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const items = await readCallTranscript(db, p.user.id, id);
    if (!items) fail(404, "NOT_FOUND", "Call not found");
    return { items };
  });
  // S30 §1.1: the user deletes one of their own records. No idempotency key — DELETE is idempotent
  // by construction and the second attempt is an honest 404.
  app.delete("/api/v1/calls/:id", async (req, reply) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const result = await deleteCallRecord(
      db,
      {
        // Roots, not the readers: PIXEL_ARCHIVE_ROOT still holds bytes after the feature flag is off.
        recordingRoot: config.RECORDING_ROOT ?? null,
        pixelArchiveRoot: config.PIXEL_ARCHIVE_ROOT ?? null,
        recordingBackupRoot: config.RECORDING_BACKUP_ROOT ?? null,
        nodes: media,
        log: req.log,
      },
      { callId: id, ownerId: p.user.id },
    );
    if (result.outcome === "not_found") fail(404, "NOT_FOUND", "Call not found");
    if (result.outcome === "in_use")
      fail(409, "CALL_IN_USE", "Call is still in progress or being processed");
    return reply.code(204).send();
  });
  app.put("/api/v1/calls/:id/liveness",async req=>{
    const p=requireUser(req);mutationOrigin(req,config);
    const {id}=z.object({id:z.uuid()}).parse(req.params);
    const body=z.object({mediaEpoch:z.number().int().positive(),expectedRevision:z.number().int().positive()}).parse(req.body);
    if(!config.WEB_CALL_LIVENESS_ENABLED)fail(404,"NOT_FOUND","Call liveness lease not found");
    try{return{liveness:await renewWebCallLease(db,{callId:id,sessionId:p.sessionId,clientType:p.clientType,platform:p.platform,...body})};}
    catch(error){if(error instanceof WebCallLivenessError)fail(error.status,error.code,error.message);throw error;}
  });
  app.post("/api/v1/calls/outbound", async (req, reply) => {
    const startedAt = Date.now();
    const p = requireUser(req);
    if (!p.platform)
      fail(
        401,
        "SESSION_UPGRADE_REQUIRED",
        "Sign in again before starting a call",
      );
    mutationOrigin(req, config);
    requireWebCallProtocol(req,p,config);
    const key = idemKey(req);
    const b = z
      .object({ simId: z.uuid(), remoteNumber: outboundCallNumber })
      .parse(req.body);
    let doorbellGatewayId: string | null = null;
    const result = await tx(db, async (c) => {
      const currentSession=await c.query(`SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND access_expires_at>now() FOR UPDATE`,[p.sessionId,p.user.id]);
      if(!currentSession.rowCount)fail(401,'SESSION_REVOKED','Session is no longer valid');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `${p.user.id}:call.outbound:${key}`,
      ]);
      const fp = requestFingerprint(b);
      const prior = await c.query(
        `SELECT request_hash,resource_id FROM idempotency_requests WHERE user_id=$1 AND operation='call.outbound' AND idem_key=$2`,
        [p.user.id, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== fp)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used with different parameters",
          );
        const old = await c.query(`SELECT * FROM call_records WHERE id=$1`, [
          prior.rows[0].resource_id,
        ]);
        const liveness=await readWebCallLease(c,old.rows[0].id,p.sessionId);
        return { call: await mutationCallDto(c, old.rows[0]), command: null, liveness, replayed: true };
      }
      const target = await c.query(
        `SELECT gateway_id FROM sims WHERE id=$1 AND owner_user_id=$2`,
        [b.simId, p.user.id],
      );
      if (!target.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [
        target.rows[0].gateway_id,
      ]);
      const sim = await c.query(
        `SELECT s.*,g.last_seen_at,g.control_enabled,g.telephony_ready,g.media_ready,g.device_epoch,g.command_sequence,g.time_zone,st.mode FROM sims s JOIN gateways g ON g.id=s.gateway_id JOIN sim_settings st ON st.sim_id=s.id WHERE s.id=$1 AND s.owner_user_id=$2 AND s.device_present AND NOT s.assignment_pending`,
        [b.simId, p.user.id],
      );
      if (!sim.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      const s = sim.rows[0];
      const remoteKey = await callCanonicalKeyFor(c, p.user.id, b.remoteNumber, s.country_iso);
      // S72 B1/D5: dialing one of the owner's own hosted SIMs is an internal call; two cards in one
      // device cannot reach each other, so that is refused before anything is dialed.
      const peerSim = await ownerSimByKey(c, p.user.id, remoteKey, s.id);
      if (peerSim && peerSim.gateway_id === s.gateway_id)
        fail(409, "SAME_DEVICE_INTERNAL", "同一设备上的两张卡不能互打");
      if (!online(s.last_seen_at, s.control_enabled, config))
        failGatewayOffline(s, { userId: p.user.id });
      if (!s.telephony_ready)
        fail(
          503,
          "GATEWAY_NOT_READY",
          "Gateway telephony capability is not ready",
        );
      if (!media || !s.media_ready)
        fail(503, "MEDIA_UNAVAILABLE", "Call media is not configured or ready");
      if (
        (
          await c.query(
            `SELECT 1 FROM gateway_call_locks WHERE gateway_id=$1`,
            [s.gateway_id],
          )
        ).rowCount
      )
        fail(409, "GATEWAY_BUSY", "Gateway already has a cellular call");
      const telecom = await c.query(
        `SELECT generation,local_busy FROM gateway_telecom_snapshots WHERE gateway_id=$1`,
        [s.gateway_id],
      );
      if (
        !telecom.rowCount ||
        Number(telecom.rows[0].generation) !== Number(s.device_epoch)
      )
        fail(
          409,
          "TELECOM_STATE_UNKNOWN",
          "Gateway Telecom state has not been verified for this device epoch",
        );
      if (telecom.rows[0].local_busy)
        fail(409, "GATEWAY_BUSY", "Gateway has a local cellular call");
      const generation = Number(s.device_epoch),
        sequence = Number(s.command_sequence) + 1;
      await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [
        s.gateway_id,
        sequence,
      ]);
      const call = (
        await c.query(
          `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,originating_session_id,originating_platform,gateway_time_zone,remote_canonical_key,internal_call,peer_sim_id)
        VALUES($1,$2,$3,'outgoing',$4,'outgoing_pending',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            s.gateway_id,
            s.id,
            p.user.id,
            b.remoteNumber,
            generation,
            s.mode,
            p.sessionId,
            p.platform,
            s.time_zone,
            remoteKey,
            !!peerSim,
            peerSim?.id ?? null,
          ],
        )
      ).rows[0];
      await c.query(
        `INSERT INTO gateway_call_locks(gateway_id,call_id,generation) VALUES($1,$2,$3)`,
        [s.gateway_id, call.id, generation],
      );
      const command = (
        await c.query(
          `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at) VALUES($1,$2,$3,$4,'dial',$5,now()+interval '30 seconds') RETURNING id,call_id,generation,sequence,expires_at`,
          [
            s.gateway_id,
            call.id,
            generation,
            sequence,
            JSON.stringify({ callId: call.id, simId: s.id, remoteNumber: b.remoteNumber }),
          ],
        )
      ).rows[0];
      doorbellGatewayId = s.gateway_id;
      await c.query(
        `INSERT INTO idempotency_requests VALUES($1,'call.outbound',$2,$3,'call',$4,now())`,
        [p.user.id, key, fp, call.id],
      );
      const liveness=await createInitialWebCallLease(c,config.WEB_CALL_LIVENESS_ENABLED,p,call);
      return {
        call: await mutationCallDto(c, call),
        command: commandDto(command),
        liveness,
        replayed: false,
      };
    });
    // Committed: ring the doorbell so the dial reaches the gateway without waiting for the next poll.
    ringDoorbell(doorbellGatewayId);
    const code = result.replayed ? 200 : 202;
    diag(db, "call.outbound", { ms: Date.now() - startedAt, code, platform: p.platform }, { callId: result.call.id, userId: p.user.id });
    return reply
      .code(code)
      .send({ call: result.call, command: result.command, liveness: result.liveness });
  });
  app.post("/api/v1/calls/:id/claim", async (req) => {
    const startedAt = Date.now();
    const p = requireUser(req);
    mutationOrigin(req, config);
    requireWebCallProtocol(req,p,config);
    if (!p.platform) fail(401, "SESSION_UPGRADE_REQUIRED", "Sign in again before answering a call");
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z
      .object({
        platform: z.enum(["web", "ios", "android", "macos"]),
        deviceName: z.string().max(120).optional(),
      })
      .parse(req.body);
    let doorbellGatewayId: string | null = null;
    const value = await tx(db, async (c) => {
      const currentSession=await c.query(`SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND access_expires_at>now() FOR UPDATE`,[p.sessionId,p.user.id]);
      if(!currentSession.rowCount)fail(401,'SESSION_REVOKED','Session is no longer valid');
      const target = await c.query(
        `SELECT gateway_id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,
        [id, p.user.id],
      );
      if (!target.rowCount) fail(404, "NOT_FOUND", "Call not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [
        target.rows[0].gateway_id,
      ]);
      const q = await c.query(
        `SELECT c.*,g.device_epoch,g.command_sequence,g.last_seen_at,g.control_enabled,g.telephony_ready,g.media_ready FROM call_records c JOIN gateways g ON g.id=c.gateway_id WHERE c.id=$1 AND c.snapshot_owner_id=$2 FOR UPDATE OF c`,
        [id, p.user.id],
      );
      if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
      const call = q.rows[0];
      if (call.claimed_by_session_id === p.sessionId &&
          ["connecting", "active"].includes(call.state)) {
        const liveness=await readWebCallLease(c,call.id,p.sessionId);
        return { call: { ...await mutationCallDto(c, call), claimedByCurrentSession: true }, liveness, replayed: true };
      }
      // S72 B4: the session dialing an internal call cannot pick up its own other leg.
      if (call.peer_call_id && (await c.query(
        `SELECT 1 FROM call_records WHERE id=$1 AND originating_session_id=$2`, [call.peer_call_id, p.sessionId])).rowCount)
        fail(409, "OWN_OUTGOING_CALL", "这是你正在拨出的通话");
      if (call.state !== "incoming_ringing")
        fail(409, "ALREADY_CLAIMED", "Call is no longer available");
      if (!online(call.last_seen_at, call.control_enabled, config))
        failGatewayOffline(call, { callId: call.id, userId: p.user.id });
      if (!call.telephony_ready)
        fail(
          503,
          "GATEWAY_NOT_READY",
          "Gateway telephony capability is not ready",
        );
      if (!media || !call.media_ready)
        fail(503, "MEDIA_UNAVAILABLE", "Call media is not configured or ready");
      const generation = Number(call.device_epoch),
        sequence = Number(call.command_sequence) + 1;
      await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [
        call.gateway_id,
        sequence,
      ]);
      await c.query(
        `UPDATE call_records SET state='connecting',claimed_by_session_id=$2,answered_by_platform=$3,answered_by_device=$4,generation=$5 WHERE id=$1`,
        [id, p.sessionId, p.platform, b.deviceName ?? null, generation],
      );
      await c.query(
        `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at) VALUES($1,$2,$3,$4,'answer',$5,now()+interval '15 seconds')`,
        [
          call.gateway_id,
          id,
          generation,
          sequence,
          JSON.stringify({ callId: id, deviceCallId: call.device_call_id }),
        ],
      );
      doorbellGatewayId = call.gateway_id;
      await markHumanWinner(c,id);
      const updated = (
        await c.query(`SELECT * FROM call_records WHERE id=$1`, [id])
      ).rows[0];
      const liveness=await createInitialWebCallLease(c,config.WEB_CALL_LIVENESS_ENABLED,p,updated);
      return { call: { ...await mutationCallDto(c, updated), claimedByCurrentSession: true }, liveness, replayed: false };
    });
    ringDoorbell(doorbellGatewayId);
    diag(db, "call.claim", { ms: Date.now() - startedAt, replayed: value.replayed, platform: p.platform }, { callId: value.call.id, userId: p.user.id });
    return value;
  });
  /**
   * S42 决策 1/2/3: the owner's own client is busy on another call, so this ringing call cannot be
   * picked up there. AI takes it `OWNER_BUSY_AI_GRACE_SECONDS` later — the run is a `timeout_ai` one
   * while the SIM's own mode is left untouched, so the call keeps ringing on every other client and
   * any of them still wins the race. Every other state is a silent 200: this is a push-handling path
   * and a race must never surface as an error there.
   */
  app.post("/api/v1/calls/:id/owner-busy",async req=>{
    const startedAt=Date.now();
    const p=requireUser(req);
    mutationOrigin(req,config);
    const {id}=z.object({id:z.uuid()}).parse(req.params);
    // 验收 3 reads this diag row in production: without the provider, `aiScheduled:false` from "no live
    // worker" and from "the call was no longer ringing" look identical.
    let aiSkippedProvider: string | null = null;
    const aiScheduled=await tx(db,async c=>{
      const target=await c.query(`SELECT gateway_id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,[id,p.user.id]);
      if(!target.rowCount)fail(404,"NOT_FOUND","Call not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[target.rows[0].gateway_id]);
      const q=await c.query(`SELECT c.*,s.version assignment_version,st.timeout_seconds,st.version settings_version
        FROM call_records c JOIN sims s ON s.id=c.sim_id LEFT JOIN sim_settings st ON st.sim_id=s.id
        WHERE c.id=$1 AND c.snapshot_owner_id=$2 FOR UPDATE OF c`,[id,p.user.id]);
      if(!q.rowCount)fail(404,"NOT_FOUND","Call not found");
      const call=q.rows[0];
      // S72 B3: an internal call always rings as 人工; the owner being busy never hands it to AI.
      if(!config.BUSY_CONFLICT_ENABLED||call.direction!=="incoming"||call.state!=="incoming_ringing"||call.ai_run_id||call.internal_call)return false;
      const run=await createAiRunForIncoming(c,{
        enabled:config.AI_ENABLED&&config.AI_WORKER_READY&&Boolean(config.AI_INTERNAL_TOKEN),
        callId:call.id,gatewayId:call.gateway_id,ownerId:call.snapshot_owner_id,deviceGeneration:Number(call.generation),
        mediaEpoch:Number(call.media_epoch),mode:"timeout_ai",settingsVersion:Number(call.settings_version??1),
        assignmentVersion:Number(call.assignment_version),timeoutSeconds:Number(call.timeout_seconds??45),
        observedAt:new Date().toISOString(),triggerSeconds:OWNER_BUSY_AI_GRACE_SECONDS,
        onProviderUnavailable:({provider})=>{aiSkippedProvider=provider;}});
      return Boolean(run);
    });
    diag(db,"call.owner_busy",{ms:Date.now()-startedAt,aiScheduled,platform:p.platform,
      ...(aiSkippedProvider?{aiSkipped:"provider_unavailable",voiceProvider:aiSkippedProvider}:{})},{callId:id,userId:p.user.id});
    return {aiScheduled};
  });
  app.post("/api/v1/calls/:id/end", async (req, reply) => {
    const startedAt = Date.now();
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const options = z.object({ onlyIfCurrentSessionOwner: z.boolean().optional(),onlyIfRinging:z.boolean().optional() }).parse(req.body ?? {});
    let doorbellGatewayId: string | null = null;
    let cancelledDialId: string | null = null;
    const value = await tx(db, async (c) => {
      cancelledDialId = null;
      const target = await c.query(
        `SELECT gateway_id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,
        [id, p.user.id],
      );
      if (!target.rowCount) fail(404, "NOT_FOUND", "Call not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [
        target.rows[0].gateway_id,
      ]);
      const q = await c.query(
        `SELECT c.*,g.device_epoch,g.command_sequence,g.last_seen_at,g.control_enabled,g.telephony_ready FROM call_records c JOIN gateways g ON g.id=c.gateway_id WHERE c.id=$1 AND c.snapshot_owner_id=$2 FOR UPDATE OF c`,
        [id, p.user.id],
      );
      if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
      const call = q.rows[0];
      // S38: a call the user dialed on the Pixel itself is not executed through Control; there is no
      // session, no lock and no hangup command that could end it from here.
      if (call.originating_platform === "pixel")
        fail(409, "CALL_NOT_CONTROLLABLE", "This call was dialed on the phone itself");
      if(options.onlyIfRinging&&(call.state!=="incoming_ringing"||call.claimed_by_session_id!==null))
        fail(409,"CALL_NOT_RINGING","Call is no longer waiting to be answered");
      if (options.onlyIfCurrentSessionOwner &&
          (call.direction === "incoming" ? call.claimed_by_session_id : call.originating_session_id) !== p.sessionId)
        fail(409, "CALL_NOT_SESSION_OWNER", "This session does not own call execution");
      if (call.state === "ended" || call.state === "failed")
        {await closeWebCallLease(c,id);return { call: await mutationCallDto(c, call), command: null };}
      if (call.state === "ending") {
        const cmd = await c.query(
          `SELECT id,generation,sequence,expires_at FROM commands WHERE call_id=$1 AND kind='hangup' ORDER BY created_at DESC LIMIT 1`,
          [id],
        );
        if(cmd.rowCount)await scheduleNormalMediaClose(c,call,cmd.rows[0]);
        await markWebCallLeaseForCleanup(c,id,cmd.rowCount?cmd.rows[0]:null);return {
          call: await mutationCallDto(c, call),
          command: cmd.rowCount ? commandDto(cmd.rows[0]) : null,
        };
      }
      // The gateway has not been handed the dial yet (e.g. held until telephonyReady): cancel it here
      // instead of racing a hangup ahead of it. Checked before `online` — an offline gateway is the
      // likeliest holder of an undelivered dial.
      cancelledDialId = await cancelUndeliveredDial(c, id, null);
      if (cancelledDialId) {
        await closeWebCallLease(c, id);
        const ended = (await c.query(`SELECT * FROM call_records WHERE id=$1`, [id])).rows[0];
        return { call: await mutationCallDto(c, ended), command: null };
      }
      if (!online(call.last_seen_at, call.control_enabled, config))
        failGatewayOffline(call, { callId: id, userId: p.user.id });
      const generation = Number(call.device_epoch),
        sequence = Number(call.command_sequence) + 1;
      await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [
        call.gateway_id,
        sequence,
      ]);
      const updated = (
        await c.query(
          `UPDATE call_records SET state='ending',generation=$2 WHERE id=$1 RETURNING *`,
          [id, generation],
        )
      ).rows[0];
      const cmd = (
        await c.query(
          `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at) VALUES($1,$2,$3,$4,'hangup',$5,now()+interval '15 seconds') RETURNING id,call_id,generation,sequence,expires_at`,
          [
            call.gateway_id,
            id,
            generation,
            sequence,
            JSON.stringify({ callId: id, deviceCallId: call.device_call_id }),
          ],
        )
      ).rows[0];
      doorbellGatewayId = call.gateway_id;
      await scheduleNormalMediaClose(c,updated,cmd);
      await markWebCallLeaseForCleanup(c,id,cmd);
      return { call: await mutationCallDto(c, updated), command: commandDto(cmd) };
    });
    ringDoorbell(doorbellGatewayId);
    if (cancelledDialId) {
      diag(db, "call.dial_cancelled", { commandId: cancelledDialId }, { callId: id, userId: p.user.id });
      await requestMediaClose(db, media, id);
    }
    diag(db, "call.end", { ms: Date.now() - startedAt, state: value.call.state, commanded: value.command !== null, platform: p.platform, sessionId: p.sessionId }, { callId: id, userId: p.user.id });
    return reply.code(202).send(value);
  });
  // S36 C2: in-call DTMF. Same ownership and locking as `/end`; one short-lived command per request.
  // `call_id` stays NULL on purpose: a populated one would let the heartbeat's media-capability sweep
  // reject the row server-side with no bound ACK, which the replay horizon cannot prove safe.
  app.post("/api/v1/calls/:id/dtmf", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    // Deploy gate: an older gateway rejects a replay proposal that counts a `dtmf`, which would
    // withdraw its capabilities and stop every call on it. Off until the new APK is everywhere.
    if (!config.CALL_DTMF_ENABLED) fail(501, "DTMF_UNAVAILABLE", "拨号音发送当前不可用");
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ digits: z.string().regex(/^[0-9*#]{1,32}$/) }).parse(req.body);
    const startedAt = Date.now();
    let doorbellGatewayId: string | null = null;
    const value = await tx(db, async (c) => {
      const target = await c.query(
        `SELECT gateway_id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,
        [id, p.user.id],
      );
      if (!target.rowCount) fail(404, "NOT_FOUND", "Call not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [target.rows[0].gateway_id]);
      const q = await c.query(
        `SELECT c.*,g.device_epoch,g.command_sequence,g.last_seen_at,g.control_enabled,g.telephony_ready FROM call_records c JOIN gateways g ON g.id=c.gateway_id WHERE c.id=$1 AND c.snapshot_owner_id=$2 FOR UPDATE OF c`,
        [id, p.user.id],
      );
      if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
      const call = q.rows[0];
      if (call.state !== "active")
        fail(409, "CALL_NOT_ACTIVE", "Call is not connected");
      if (!online(call.last_seen_at, call.control_enabled, config))
        failGatewayOffline(call, { callId: id, userId: p.user.id });
      if (!call.telephony_ready)
        fail(503, "GATEWAY_NOT_READY", "Gateway telephony capability is not ready");
      const sequence = Number(call.command_sequence) + 1;
      await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [call.gateway_id, sequence]);
      const cmd = (
        await c.query(
          `INSERT INTO commands(gateway_id,sim_id,generation,sequence,kind,payload,expires_at)
           VALUES($1,$2,$3,$4,'dtmf',$5,now()+interval '20 seconds') RETURNING id`,
          [
            call.gateway_id,
            call.sim_id,
            Number(call.device_epoch),
            sequence,
            JSON.stringify({ callId: id, deviceCallId: call.device_call_id, digits: b.digits }),
          ],
        )
      ).rows[0];
      doorbellGatewayId = call.gateway_id;
      return { ok: true as const, commandId: String(cmd.id) };
    });
    ringDoorbell(doorbellGatewayId);
    // Never the digits themselves: they can be a PIN or a card number. Only how many, and how long.
    diag(db, "call.dtmf", { ms: Date.now() - startedAt, digitCount: b.digits.length }, { callId: id, userId: p.user.id });
    return value;
  });

  // S36 C3: structured diagnostics. Source and device come from the authenticated principal, never
  // from the body. A malformed item is dropped instead of failing the batch — a client is never
  // blocked on log hygiene — and 256 KiB per request is enforced as a route body limit.
  const diagItem = z.object({
    ts: z.string().datetime({ offset: true }),
    level: z.enum(["debug", "info", "warn", "error"]),
    event: z.string().min(1).max(120),
    callId: z.uuid().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    // S69: the version that recorded the event, not the one uploading it.
    appVersion: z.string().max(64).optional(),
  });
  app.post("/api/v1/diag/events", { bodyLimit: 262144 }, async (req) => {
    let source = "", device = "", userId: string | null = null;
    if (req.principal?.kind === "user") {
      source = z.enum(["ios", "android", "macos", "web"]).parse(req.headers["x-diag-source"]);
      device = req.principal.sessionId;
      userId = req.principal.user.id;
    } else if (req.principal?.kind === "device") {
      source = "gateway";
      device = req.principal.gatewayId;
    } else fail(401, "UNAUTHENTICATED", "Authentication required");
    // S36b D1: one install id per app install, so a device is followable across sessions and logins.
    const rawInstall = req.headers["x-diag-install"];
    const installId = typeof rawInstall === "string" && rawInstall.trim() ? rawInstall.trim().slice(0, 64) : null;
    const valid = (Array.isArray(req.body) ? req.body : [])
      .slice(0, 200)
      .map((value) => diagItem.safeParse(value))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .filter((item) => JSON.stringify(item.fields ?? {}).length <= 4096);
    // S69: 600 events a minute per install (else per session / gateway); the rest is dropped.
    // S75: device clock skew, one value per batch; absent, non-finite or beyond a day is NULL.
    const sentAt = Number(req.headers["x-diag-sent-at"] ?? NaN);
    const offset = Math.round(Date.now() - sentAt);
    const clockOffsetMs = Number.isFinite(offset) && Math.abs(offset) <= 86_400_000 ? offset : null;
    const bucketKey = installId ? `install:${installId}` : `device:${device}`;
    const items = valid.slice(0, takeDiagTokens(bucketKey, valid.length));
    const dropped = valid.length - items.length;
    if (dropped && throttled(`diag.throttled:${bucketKey}`))
      diag(db, "diag.throttled", { installId, device, source, dropped }, { userId, level: "warn" });
    if (items.length)
      await db.query(
        `INSERT INTO diag_events(ts,source,device,user_id,call_id,level,event,fields,install_id,app_version,clock_offset_ms) VALUES ` +
          items.map((_, i) => `(${Array.from({ length: 11 }, (_, n) => `$${i * 11 + n + 1}`).join(",")})`).join(","),
        items.flatMap((item) => [item.ts, source, device, userId, item.callId ?? null, item.level, item.event, JSON.stringify(item.fields ?? {}), installId, item.appVersion ?? null, clockOffsetMs]),
      );
    return { accepted: items.length, dropped };
  });
  app.get("/api/v1/diag/events", async (req, reply) => {
    const p = requireUser(req);
    const q = z
      .object({
        since: z.string().datetime({ offset: true }).optional(),
        until: z.string().datetime({ offset: true }).optional(),
        source: z.enum(["ios", "android", "macos", "web", "gateway", "control"]).optional(),
        callId: z.uuid().optional(),
        event: z.string().max(120).optional(),
        // S36b D3: follow one install, one device or one user across the timeline. `userId` needs no
        // admin branch — a non-admin is already scoped to their own rows and simply gets nothing.
        installId: z.string().max(64).optional(),
        device: z.string().max(120).optional(),
        userId: z.uuid().optional(),
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(2000),
      })
      .parse(req.query);
    const rows = await db.query(
      `SELECT ts,received_at,source,device,install_id,user_id,call_id,level,event,fields,clock_offset_ms FROM diag_events
       WHERE ($1::boolean OR user_id=$2) AND ($3::timestamptz IS NULL OR ts>=$3) AND ($4::timestamptz IS NULL OR ts<=$4)
         AND ($5::text IS NULL OR source=$5) AND ($6::uuid IS NULL OR call_id=$6) AND ($7::text IS NULL OR event=$7)
         AND ($9::text IS NULL OR install_id=$9) AND ($10::text IS NULL OR device=$10)
         AND ($11::uuid IS NULL OR user_id=$11) AND ($12::text IS NULL OR level=$12)
       ORDER BY ts LIMIT $8`,
      [p.user.role === "admin", p.user.id, q.since ?? null, q.until ?? null, q.source ?? null, q.callId ?? null, q.event ?? null, q.limit,
       q.installId ?? null, q.device ?? null, q.userId ?? null, q.level ?? null],
    );
    reply.type("application/x-ndjson").header("Cache-Control", "private, no-store");
    return rows.rows.map((row) => JSON.stringify(row) + "\n").join("");
  });
  // S36b D3: the first thing an AI should read — who reported anything at all in the window, when
  // they were last seen, and how many of those rows were warnings or errors. One grouped scan of
  // the (source,device,ts) index; the detail then comes from `/diag/events` with these filters.
  app.get("/api/v1/diag/summary", async (req) => {
    requireAdmin(req);
    const q = z.object({ since: z.string().datetime({ offset: true }).optional() }).parse(req.query);
    const since = q.since ?? new Date(Date.now() - 86_400_000).toISOString();
    const rows = await db.query(
      `SELECT source,device,max(install_id) install_id,count(*)::int events,
              count(*) FILTER (WHERE level='warn')::int warnings,
              count(*) FILTER (WHERE level='error')::int errors,
              min(ts) first_seen,max(ts) last_seen,max(user_id::text) user_id
       FROM diag_events WHERE ts>=$1 GROUP BY source,device ORDER BY max(ts) DESC LIMIT 500`,
      [since],
    );
    return { since, devices: rows.rows };
  });

  app.get("/api/v1/sms", async (req) => {
    const p = requireUser(req);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);
    const q = await db.query(
      `SELECT m.*,s.country_iso sim_country_iso FROM sms_messages m LEFT JOIN sims s ON s.id=m.sim_id WHERE m.snapshot_owner_id=$1 ORDER BY m.created_at DESC LIMIT $2`,
      [p.user.id, limit],
    );
    // S21 §F: threads from a blocked number stay visible and carry the block flag. Newly blocked
    // messages never reach `sms_messages` at all, so nothing needs hiding here.
    const rows = q.rows;
    const annotations = await annotateNumbers(
      db,
      p.user.id,
      rows.map((row) => ({ remoteNumber: row.remote_number, countryIso: row.sim_country_iso })),
      "sms",
    );
    return { items: rows.map((row, index) => smsDto(row, annotations[index])) };
  });
  app.post("/api/v1/sms/batch", async (req,reply) => {
    const p=requireUser(req);mutationOrigin(req,config);const key=idemKey(req);
    const b=z.object({simId:z.uuid(),recipients:z.array(z.string().min(1).max(64)).min(1).max(100),body:z.string().min(1).max(5000)}).strict().parse(req.body);
    let doorbellGatewayId:string|null=null;
    const value=await tx(db,async c=>{
      if(!(await c.query(`SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND access_expires_at>now() FOR UPDATE`,[p.sessionId,p.user.id])).rowCount)
        fail(401,'SESSION_REVOKED','Session is no longer valid');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${p.user.id}:sms.batch:${key}`]);
      const prior=(await c.query(`SELECT i.request_hash,b.* FROM idempotency_requests i JOIN sms_batches b ON b.id=i.resource_id
        WHERE i.user_id=$1 AND i.operation='sms.batch' AND i.idem_key=$2`,[p.user.id,key])).rows[0];
      const target=(await c.query(`SELECT * FROM sims WHERE id=$1 AND owner_user_id=$2`,[b.simId,p.user.id])).rows[0];
      if(!prior&&!target)fail(404,'NOT_FOUND','SIM not found');
      const recipients:string[]=[];const seen=new Set<string>();
      for(const raw of b.recipients){
        const address=smsAddress(raw,prior?prior.country_iso:target.country_iso);
        if(!address.canReply||!address.replyNumber)fail(400,'INVALID_REQUEST','Invalid SMS recipient');
        const identity=address.conversationAddress.replace(/^\+/,'');
        if(!seen.has(identity)){seen.add(identity);recipients.push(address.replyNumber!);}
      }
      const fp=requestFingerprint({simId:b.simId,recipients,body:b.body});
      if(prior){
        if(prior.request_hash!==fp)fail(409,'IDEMPOTENCY_CONFLICT','Idempotency key was used with different parameters');
        const rows=(await c.query(`SELECT m.* FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,position)
          JOIN sms_messages m ON m.id=ids.id AND m.snapshot_owner_id=$2 ORDER BY ids.position`,[prior.sms_ids,p.user.id])).rows;
        if(rows.length!==prior.sms_ids.length)fail(410,'SMS_BATCH_DELETED','This batch was accepted, but one or more messages have been deleted');
        const items=rows.map(row=>smsDto(row));
        return {batchId:prior.id,intervalSeconds:5,items,replayed:true};
      }
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[target.gateway_id]);
      const current=(await c.query(`SELECT s.*,g.last_seen_at,g.control_enabled,g.sms_ready,g.device_epoch FROM sims s JOIN gateways g ON g.id=s.gateway_id
        WHERE s.id=$1 AND s.owner_user_id=$2 AND s.device_present AND NOT s.assignment_pending FOR UPDATE OF s`,[b.simId,p.user.id])).rows[0];
      if(!current||current.gateway_id!==target.gateway_id)fail(404,'NOT_FOUND','SIM not found');
      if(!online(current.last_seen_at,current.control_enabled,config))failGatewayOffline(current,{userId:p.user.id});
      if(!current.sms_ready)fail(503,'GATEWAY_NOT_READY','Gateway SMS capability is not ready');
      const batch=(await c.query(`INSERT INTO sms_batches(owner_user_id,sim_id,country_iso) VALUES($1,$2,$3) RETURNING id`,[p.user.id,b.simId,target.country_iso])).rows[0];
      const items=[];
      for(const number of recipients){
        const sms=(await c.query(`INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)
          VALUES($1,$2,$3,'outgoing',$4,$5,'queued',$6) RETURNING *`,[current.gateway_id,b.simId,p.user.id,number,b.body,current.device_epoch])).rows[0];
        await c.query(`INSERT INTO sms_dispatch_queue(sms_id,gateway_id,assignment_version,batch_id) VALUES($1,$2,$3,$4)`,[sms.id,current.gateway_id,current.version,batch.id]);
        items.push(smsDto(sms));
      }
      await c.query(`UPDATE sms_batches SET sms_ids=$2 WHERE id=$1`,[batch.id,items.map(item=>item.id)]);
      await c.query(`INSERT INTO idempotency_requests VALUES($1,'sms.batch',$2,$3,'sms_batch',$4,now())`,[p.user.id,key,fp,batch.id]);
      await releaseSms(c,current.gateway_id,config.GATEWAY_ONLINE_SECONDS);doorbellGatewayId=current.gateway_id;
      return {batchId:batch.id,intervalSeconds:5,items,replayed:false};
    });
    ringDoorbell(doorbellGatewayId);
    const {replayed,...response}=value;return reply.code(replayed?200:202).send(response);
  });

  app.post("/api/v1/sms/outbound", async (req, reply) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const key = idemKey(req);
    const b = z
      .object({
        simId: z.uuid(),
        remoteNumber: z.string().min(1).max(64),
        body: z.string().min(1).max(5000),
      })
      .parse(req.body);
    let doorbellGatewayId: string | null = null;
    const value = await tx(db, async (c) => {
      const currentSession=await c.query(`SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND access_expires_at>now() FOR UPDATE`,[p.sessionId,p.user.id]);
      if(!currentSession.rowCount)fail(401,'SESSION_REVOKED','Session is no longer valid');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `${p.user.id}:sms.outbound:${key}`,
      ]);
      const fp = requestFingerprint(b);
      const prior = await c.query(
        `SELECT request_hash,resource_id FROM idempotency_requests WHERE user_id=$1 AND operation='sms.outbound' AND idem_key=$2`,
        [p.user.id, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== fp)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used with different parameters",
          );
        const old = await c.query(`SELECT * FROM sms_messages WHERE id=$1`, [
          prior.rows[0].resource_id,
        ]);
        return { sms: smsDto(old.rows[0]), command: null, replayed: true };
      }
      const target = await c.query(
        `SELECT gateway_id FROM sims WHERE id=$1 AND owner_user_id=$2`,
        [b.simId, p.user.id],
      );
      if (!target.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [
        target.rows[0].gateway_id,
      ]);
      const sim = await c.query(
        `SELECT s.*,g.last_seen_at,g.control_enabled,g.sms_ready,g.device_epoch,g.command_sequence FROM sims s JOIN gateways g ON g.id=s.gateway_id WHERE s.id=$1 AND s.owner_user_id=$2 AND s.device_present AND NOT s.assignment_pending`,
        [b.simId, p.user.id],
      );
      if (!sim.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      const s = sim.rows[0];
      if (!online(s.last_seen_at, s.control_enabled, config))
        failGatewayOffline(s, { userId: p.user.id });
      if (!s.sms_ready)
        fail(
          503,
          "GATEWAY_NOT_READY",
          "Gateway SMS capability is not ready",
        );
      const generation = Number(s.device_epoch);
      const sms = (await c.query(
        `INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)VALUES($1,$2,$3,'outgoing',$4,$5,'queued',$6)RETURNING *`,
        [s.gateway_id,s.id,p.user.id,b.remoteNumber,b.body,generation])).rows[0];
      await c.query(`INSERT INTO sms_dispatch_queue(sms_id,gateway_id,assignment_version) VALUES($1,$2,$3)`,[sms.id,s.gateway_id,s.version]);
      const command=await releaseSms(c,s.gateway_id,config.GATEWAY_ONLINE_SECONDS);
      doorbellGatewayId = s.gateway_id;
      await c.query(
        `INSERT INTO idempotency_requests VALUES($1,'sms.outbound',$2,$3,'sms',$4,now())`,
        [p.user.id, key, fp, sms.id],
      );
      return {
        sms: smsDto(sms),
        command: command?.sms_id===sms.id ? commandDto(command) : null,
        replayed: false,
      };
    });
    ringDoorbell(doorbellGatewayId);
    return reply
      .code(value.replayed ? 200 : 202)
      .send({ sms: value.sms, command: value.command });
  });

  // S30 §1.2/§1.3. `queued`/`sending` are the only genuinely in-flight states: a command is still
  // out on the device holding that row's id, so the row stays and is reported as skipped.
  const SMS_IN_FLIGHT = new Set(["queued", "sending"]);
  async function deleteOwnedSms(client: PoolClient, ownerId: string, rows: {id: string; state: string}[]) {
    const skipped: {id: string; reason: "in_flight"}[] = [];
    const deletable: string[] = [];
    for (const row of rows) {
      if (SMS_IN_FLIGHT.has(row.state)) skipped.push({ id: row.id, reason: "in_flight" });
      else deletable.push(row.id);
    }
    const deleted = deletable.length
      ? (await client.query(`DELETE FROM sms_messages WHERE id=ANY($1::uuid[]) AND snapshot_owner_id=$2`, [deletable, ownerId])).rowCount ?? 0
      : 0;
    return { deleted, skipped };
  }
  app.post("/api/v1/sms/delete", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const b = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).parse(req.body);
    const ids = [...new Set(b.ids)];
    return tx(db, async (c) => {
      const owned = await c.query(
        `SELECT id,state::text state FROM sms_messages WHERE id=ANY($1::uuid[]) AND snapshot_owner_id=$2 FOR UPDATE`,
        [ids, p.user.id],
      );
      const byId = new Map<string, string>(owned.rows.map((row) => [row.id, row.state]));
      // Another owner's id and an id that never existed are indistinguishable to the caller by design.
      const missing = ids.filter((id) => !byId.has(id)).map((id) => ({ id, reason: "not_found" as const }));
      const { deleted, skipped } = await deleteOwnedSms(c, p.user.id, owned.rows);
      return { deleted, skipped: [...missing, ...skipped] };
    });
  });
  app.post("/api/v1/sms/threads/delete", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const b = z.object({ simId: z.uuid(), conversationAddress: z.string().min(1).max(64) }).parse(req.body);
    const deleteThread=()=>tx(db, async (c) => {
      // Freeze one deletion snapshot, then lock it in bounded pages. Rows committed after this
      // transaction's snapshot form a new thread generation and are intentionally left visible.
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await c.query("SET LOCAL statement_timeout='15s'");
      const sim = await c.query(`SELECT country_iso FROM sims WHERE id=$1 AND owner_user_id=$2`, [b.simId, p.user.id]);
      if (!sim.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      // Both sides go through the same grouping rule the DTO uses, so '13800000000' and
      // '+8613800000000' on a CN SIM are one thread. `sms_messages` stores no thread key.
      const countryIso = sim.rows[0].country_iso;
      const key = smsAddress(b.conversationAddress, countryIso).conversationAddress;
      let cursorCreatedAt: string | null = null;
      let cursorId: string | null = null;
      let deleted = 0;
      const skipped: { id: string; reason: "in_flight"; }[] = [];
      for (;;) {
        const page:{rowCount:number|null;rows:{id:string;remote_number:string;state:string;cursor_created_at:string}[]} = await c.query(
          `SELECT id,remote_number,state::text state,created_at::text cursor_created_at FROM sms_messages
             WHERE sim_id=$1 AND snapshot_owner_id=$2
               AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
             ORDER BY created_at DESC,id DESC LIMIT 500 FOR UPDATE`,
          [b.simId, p.user.id, cursorCreatedAt, cursorId],
        );
        if (!page.rowCount) break;
        const matched = page.rows.filter((row) => smsAddress(row.remote_number, countryIso).conversationAddress === key);
        const result = await deleteOwnedSms(c, p.user.id, matched);
        deleted += result.deleted;
        skipped.push(...result.skipped);
        const tail = page.rows[page.rows.length - 1]!;
        cursorCreatedAt = tail.cursor_created_at;
        cursorId = tail.id;
        if (page.rows.length < 500) break;
      }
      return { deleted, skipped };
    });
    for(let attempt=1;attempt<=3;attempt++){
      try{return await deleteThread();}
      catch(error){
        if((error as {code?:unknown})?.code!=='40001')throw error;
        if(attempt===3)fail(409,'SMS_DELETE_CONFLICT','SMS state changed during deletion; retry');
      }
    }
    throw new Error('unreachable');
  });

  const blocklistScopeSchema = z.enum(["call", "sms"]).default("call");
  app.get("/api/v1/blocklist", async (req) => {
    const p = requireUser(req);
    // S66: two lists; an old client that sends no scope sees the call list.
    const { scope } = z.object({ scope: blocklistScopeSchema }).parse(req.query);
    const items = await loadOwnerBlockedNumbers(db, p.user.id, scope);
    // S69: contacts only — `blocked` is overwritten below, and the O(N²) match was the p50 ~1 s.
    const annotations = await annotateNumbers(db, p.user.id, items.map((item) => ({ remoteNumber: item.remote_number })), null);
    return {
      items: items.map((item, index) => ({
        ...blocklistItemDto(item),
        contactId: annotations[index]?.contactId ?? null,
        contactName: annotations[index]?.contactName ?? null,
        blocked: true,
        blockedEntryId: item.id,
      })),
    };
  });
  /**
   * S21 §B: the "intercept and record" feed. Blocked calls come from `call_records`
   * (`failure_reason='number_blocked'`, owner snapshot isolated), blocked SMS from
   * `sms_interceptions`; the body preview is capped at 160 characters for the list.
   */
  app.get("/api/v1/blocklist/interceptions", async (req) => {
    const p = requireUser(req);
    // S28: this feed has no cursor, so `page` has nothing to conflict with — it simply takes over
    // from `limit`, which is ignored while a page is asked for.
    const { limit, page, pageSize, kind, simId } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100), ...pageQueryShape, kind: z.enum(["all", "call", "sms"]).default("all"), simId: z.uuid().optional() })
      .parse(req.query);
    const [rows, total] = await Promise.all([
      loadOwnerInterceptions(db, p.user.id, page === undefined ? limit : pageSize,
        page === undefined ? undefined : pageOffset(page, pageSize), kind, simId),
      page === undefined ? null : countOwnerInterceptions(db, p.user.id, kind, simId),
    ]);
    // S66: a blocked call points at its call-list entry, an intercepted SMS at its SMS-list entry.
    const annotate = (scope: "call" | "sms") => annotateNumbers(
      db,
      p.user.id,
      rows.map((row) => ({ remoteNumber: row.remote_number, countryIso: row.sim_country_iso })),
      scope,
    );
    const [callAnnotations, smsAnnotations] = await Promise.all([
      rows.some((row) => row.kind !== "sms") ? annotate("call") : [],
      rows.some((row) => row.kind === "sms") ? annotate("sms") : [],
    ]);
    const annotations = rows.map((row, index) => (row.kind === "sms" ? smsAnnotations : callAnnotations)[index]);
    return {
      items: rows.map((row, index) => ({
        id: row.id,
        kind: row.kind,
        simId: row.sim_id,
        simLabel: row.sim_label,
        gatewayTimeZone: row.gateway_time_zone,
        remoteNumber: row.remote_number,
        contactId: annotations[index]?.contactId ?? null,
        contactName: annotations[index]?.contactName ?? null,
        occurredAt: row.occurred_at,
        bodyPreview: row.body === null || row.body === undefined ? null : String(row.body).slice(0, 160),
        blockedEntryId: annotations[index]?.blockedEntryId ?? null,
        source: row.source,
      })),
      ...(page === undefined ? {} : pageEnvelope(page, pageSize, total!)),
    };
  });
  app.post("/api/v1/blocklist", async (req, reply) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const b = z
      .object({
        remoteNumber: z.string().min(1).max(64),
        sourceCallId: z.uuid().optional(),
        scope: blocklistScopeSchema,
      })
      .parse(req.body);
    if (isEmergencyServiceNumber(b.remoteNumber))
      fail(400, "INVALID_REQUEST", "Emergency numbers cannot be blocked");
    const canonicalKey = canonicalBlocklistKey(b.remoteNumber);
    if (!canonicalKey) fail(400, "INVALID_REQUEST", "A dialable number is required");
    const value = await tx(db, async (c) => {
      if (b.sourceCallId) {
        const source = await c.query(
          `SELECT id FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,
          [b.sourceCallId, p.user.id],
        );
        if (!source.rowCount) fail(404, "NOT_FOUND", "Call not found");
      }
      // S55: an entry already listed in an equivalent CN spelling is the same block, not a new row.
      const equivalent = (await loadBlockedCandidates(c, p.user.id, b.scope, [canonicalKey!]))
        .find((row) => blocklistKeysOverlap([canonicalKey!], [row.canonical_key]));
      if (equivalent) {
        const existing = await c.query(
          `SELECT id,owner_user_id,canonical_key,remote_number,source_call_id,source,scope,created_at
           FROM owner_blocked_numbers WHERE id=$1`,
          [equivalent.id],
        );
        return { created: false, item: existing.rows[0] };
      }
      const inserted = await c.query(
        `INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,source_call_id,scope)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_user_id,scope,canonical_key) DO NOTHING
         RETURNING id,owner_user_id,canonical_key,remote_number,source_call_id,source,scope,created_at`,
        [p.user.id, canonicalKey, b.remoteNumber, b.sourceCallId ?? null, b.scope],
      );
      if (inserted.rowCount) {
        await bumpOwnerBlocklistRevision(c, p.user.id);
        return { created: true, item: inserted.rows[0] };
      }
      const existing = await c.query(
        `SELECT id,owner_user_id,canonical_key,remote_number,source_call_id,source,scope,created_at
         FROM owner_blocked_numbers WHERE owner_user_id=$1 AND scope=$2 AND canonical_key=$3`,
        [p.user.id, b.scope, canonicalKey],
      );
      return { created: false, item: existing.rows[0] };
    });
    return reply.code(value.created ? 201 : 200).send({ item: blocklistItemDto(value.item) });
  });
  app.delete("/api/v1/blocklist/:id", async (req, reply) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await tx(db, async (c) => {
      const q = await c.query(
        `DELETE FROM owner_blocked_numbers WHERE id=$1 AND owner_user_id=$2 RETURNING id`,
        [id, p.user.id],
      );
      if (!q.rowCount) fail(404, "NOT_FOUND", "Blocked number not found");
      await bumpOwnerBlocklistRevision(c, p.user.id);
    });
    return reply.code(204).send();
  });
  /**
   * S21 §D user-facing half of the remote switch. Authorization is admin OR owner of any SIM on
   * that gateway; a user who owns nothing there gets 404, never a membership oracle.
   */
  const powerPrincipal = (req: FastifyRequest) => {
    const principal = requireUser(req);
    return { userId: principal.user.id, isAdmin: principal.user.role === "admin" };
  };
  app.get("/api/v1/gateways/power", async (req) => ({
    items: await listGatewayPower(db, powerPrincipal(req), config.GATEWAY_ONLINE_SECONDS),
  }));
  app.get("/api/v1/gateways/:id/power", async (req) => {
    const principal = powerPrincipal(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const item = await readGatewayPower(db, principal, id, config.GATEWAY_ONLINE_SECONDS);
    if (!item) fail(404, "NOT_FOUND", "Gateway not found");
    return { item };
  });
  app.post("/api/v1/gateways/:id/power", async (req, reply) => {
    const principal = powerPrincipal(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { desired } = z.object({ desired: z.enum(["on", "off"]) }).parse(req.body);
    let value;
    try {
      value = await tx(db, (c) => requestGatewayPower(c, principal, id, desired, config.GATEWAY_ONLINE_SECONDS));
    } catch (error) {
      if (error instanceof GatewayPowerError) fail(error.status, error.code, error.message);
      throw error;
    }
    // Ring after the transaction committed, exactly like the command doorbell.
    if (value.written && desired === "on") standbyDoorbell.notify(id);
    return reply.code(value.written ? 202 : 200).send({ item: value.item });
  });
  registerContactRoutes(app, db, {
    requireUser: (request) => ({ userId: requireUser(request).user.id }),
    mutationOrigin: (request) => mutationOrigin(request, config),
    fail,
    tx: (fn) => tx(db, fn),
    requestFingerprint,
  });
  registerPushRoutes(app, db, (req) => {
    const principal = requireUser(req); mutationOrigin(req, config);
    return {userId:principal.user.id, sessionId:principal.sessionId, platform:principal.platform};
  });
  registerBadgeRoutes(app, db, (req, mutation) => {
    const principal = requireUser(req); if (mutation) mutationOrigin(req, config);
    return principal.user.id;
  });
  registerPasskeyRoutes(app, db, config);
  registerAdminRoutes(app, db, config);
  registerAdminGatewayReportRoutes(app, db, {
    requireAdmin: (request) => ({userId: requireAdmin(request).user.id}),
    fail, reportWindow,
    cursorSecret: createHmac('sha256', config.COOKIE_SECRET).update('vodog:admin-ai-reports:cursor:v1').digest(),
  });
  registerMediaProbeRoutes(app,mediaProbes,{
    requireUser:(request)=>{const principal=requireUser(request);return{userId:principal.user.id,sessionId:principal.sessionId};},
    requireGateway:async(request)=>{const principal=requireDevice(request);const current=await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`,[principal.gatewayId]);if(!current.rowCount)fail(401,'DEVICE_UNAUTHENTICATED','Device authentication required');return{gatewayId:principal.gatewayId,deviceEpoch:Number(current.rows[0].device_epoch)};},
    mutationOrigin:(request)=>mutationOrigin(request,config),
    subjectHash:(value)=>createHmac('sha256',config.COOKIE_SECRET).update(`vodog:media-probe:${value}`).digest('base64url').slice(0,32),
    fail:(status,code,message)=>fail(status,code,message),
  });
  registerMediaQualityProbeRoutes(app,mediaProbes,{
    requireUser:(request)=>{const principal=requireUser(request);return{userId:principal.user.id,sessionId:principal.sessionId};},
    requireGateway:async(request)=>{const principal=requireDevice(request);const current=await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`,[principal.gatewayId]);if(!current.rowCount)fail(401,'DEVICE_UNAUTHENTICATED','Device authentication required');return{gatewayId:principal.gatewayId,deviceEpoch:Number(current.rows[0].device_epoch)};},
    mutationOrigin:(request)=>mutationOrigin(request,config),
    subjectHash:(value)=>createHmac('sha256',config.COOKIE_SECRET).update(`vodog:media-quality:${value}`).digest('base64url').slice(0,32),
    fail:(status,code,message)=>fail(status,code,message),
  });
  registerMediaRoutes(app, db, config, media,mediaProbes);
  registerAiRunRoutes(app,db,config,media,fail,callId=>requestMediaClose(db,media,callId),ringDoorbell);
  registerVoiceProviderRoutes(app,db,config,{
    requireUser:(request)=>({userId:requireUser(request).user.id}),
    mutationOrigin:(request)=>mutationOrigin(request,config),
    fail:(status,code,message,details)=>fail(status,code,message,details),
  });
  registerRecordingRoutes(app, db, recordings, media,pixelRecordings,config.RECORDING_MP3_CACHE_DIR??null);
  registerRecordingArchiveRoutes(app,db,{
    enabled:config.PIXEL_ARCHIVE_ENABLED,root:config.PIXEL_ARCHIVE_ROOT,validatorPath:config.PIXEL_ARCHIVE_VALIDATOR_PATH,
    maxBytesPerArchive:config.PIXEL_ARCHIVE_MAX_BYTES_PER_ARCHIVE,maxBytesPerGateway:config.PIXEL_ARCHIVE_MAX_BYTES_PER_GATEWAY,
    maxBytesPerOwner:config.PIXEL_ARCHIVE_MAX_BYTES_PER_OWNER,maxPendingPerGateway:config.PIXEL_ARCHIVE_MAX_PENDING_PER_GATEWAY,
    minFreeBytes:config.PIXEL_ARCHIVE_MIN_FREE_BYTES,finalizeConcurrency:config.PIXEL_ARCHIVE_FINALIZE_CONCURRENCY,
    requireGateway:(request)=>({gatewayId:requireDevice(request).gatewayId}),
    requireUser:(request)=>({userId:requireUser(request).user.id}),fail,
    onArchived:(callId)=>{if(pixelRecordings&&config.RECORDING_MP3_CACHE_DIR)void pretranscodePixelRecording(db,pixelRecordings,config.RECORDING_MP3_CACHE_DIR,callId);},
  });
  registerTranscriptionRoutes(app,db,{
    requireUser:(request)=>{const principal=requireUser(request);return{userId:principal.user.id,sessionId:principal.sessionId};},
    mutationOrigin:(request)=>mutationOrigin(request,config),
    fail:(status,code,message,details)=>fail(status,code,message,details),
    reportWindow,reportDayWindow,
  });
  registerGatewayRoutes(app, db, config, media, commandDoorbell, doorbellMaxHoldMs, standbyDoorbell, standbyMaxHoldMs, kickPush);
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

function sessionCallDto(r: any, sessionId: string, annotation: NumberAnnotation = EMPTY_NUMBER_ANNOTATION) {
  const owner = r.direction === "incoming" ? r.claimed_by_session_id : r.originating_session_id;
  return { ...callDto(r, annotation), claimedByCurrentSession: owner === sessionId, occupancy: occupancyDto(r, sessionId) };
}

/**
 * S20 D6 additive occupancy contract. Only the two owner-scoped read routes carry it, because they
 * are the only queries that join `gateway_call_locks`; every caller there is already the snapshot
 * owner, so `canRelease` reduces to "the call is not terminal".
 */
/**
 * S22 全部通话搜索. The stored key uses exactly the canonicalization `contact_phones.canonical_key`
 * uses (E.164 when the number parses for the SIM country, otherwise the digits key), so a contact
 * name search is one index equality instead of a per-row TS expansion. Non-dialable and emergency
 * numbers stay NULL and simply do not participate in name search.
 */
function callCanonicalKey(remoteNumber: unknown, countryIso: string) {
  const rawNumber = typeof remoteNumber === "string" ? remoteNumber.trim() : "";
  if (!rawNumber) return null;
  return normalizePhone({rawNumber}, countryIso)?.canonicalKey ?? null;
}

/**
 * The SIM's own country when the device reported one, otherwise the owner's country — exactly the
 * fallback `contacts` uses. Without it a national-format number on a SIM with no `country_iso`
 * would be keyed '18600000001' while its contact is keyed '+8618600000001', and the name search
 * would silently miss.
 */
async function callCanonicalKeyFor(db: Db | PoolClient, ownerUserId: string, remoteNumber: unknown, countryIso: unknown) {
  if (!(typeof remoteNumber === "string" && remoteNumber.trim())) return null;
  const iso = typeof countryIso === "string" && /^[A-Za-z]{2}$/.test(countryIso)
    ? countryIso.toUpperCase() : await ownerCountryIso(db, ownerUserId);
  return callCanonicalKey(remoteNumber, iso);
}

/**
 * S71: a cellular device reaches relay-primary coturn through the relay-secondary tunnel; same TURN credential, room node unchanged.
 * The relay URL fronts only MEDIA_RELAY_NODE_ID's coturn, so rooms on any other node keep their own TURN URL.
 * Shared by the gateway and client media-options routes; an absent `relay` leaves the response untouched.
 */
function relayNodeFor(config:Config,body:{relay?:boolean;transport:string}) {
  return body.relay===true&&body.transport==="tls"&&config.MEDIA_RELAY_TURN_TLS_URL&&config.MEDIA_RELAY_TURN_HOSTNAME?config.MEDIA_RELAY_NODE_ID:undefined;
}
function relayIce<S extends {username:string;credential:string}>(config:Config,iceServers:S[],body:{relay?:boolean;transport:string},nodeId:string) {
  const applied=nodeId===relayNodeFor(config,body);
  const relayUrl=config.MEDIA_RELAY_TURN_TLS_URL,relayHostname=config.MEDIA_RELAY_TURN_HOSTNAME;
  return {
    iceServers:applied?iceServers.map(s=>({urls:[relayUrl!],hostname:relayHostname!,username:s.username,credential:s.credential})):iceServers,
    relayField:body.relay===undefined?{}:{relay:applied},
  };
}

/**
 * S72 A3: an incoming call the gateway reports ACTIVE while still ringing with nobody's claim was
 * answered on the gateway device itself (Pixel dialer / Mac module window). The caller then moves the
 * state to `active`, which ends ringing everywhere else; a pending AI run loses the race.
 */
async function markDeviceAnswer(c: PoolClient, callId: string) {
  const answered = await c.query(
    `UPDATE call_records SET answered_by_platform='device' WHERE id=$1 AND direction='incoming' AND state='incoming_ringing'
       AND claimed_by_session_id IS NULL AND answered_by_platform IS NULL RETURNING id`,
    [callId],
  );
  if (answered.rowCount) await markHumanWinner(c, callId);
}

/** S72 B1: the owner's other present hosted SIM whose own number has S55 key `key`, if any. */
async function ownerSimByKey(c: Db | PoolClient, ownerUserId: string, key: string | null, excludeSimId: string) {
  if (!key) return null;
  const sims = (await c.query(
    `SELECT id,gateway_id,phone_label,country_iso FROM sims WHERE owner_user_id=$1 AND device_present AND phone_label IS NOT NULL AND id<>$2`,
    [ownerUserId, excludeSimId],
  )).rows;
  for (const sim of sims)
    if ((await callCanonicalKeyFor(c, ownerUserId, sim.phone_label, sim.country_iso)) === key)
      return sim as { id: string; gateway_id: string };
  return null;
}

/**
 * One bounded pass over the rows that predate the column. Batches of 200 walk a `(started_at,id)`
 * cursor instead of re-selecting `key IS NULL`, because a non-dialable number legitimately stays
 * NULL and a `WHERE key IS NULL` loop would never terminate on it.
 */
export async function backfillCallCanonicalKeys(db: Db, log: (message: string) => void) {
  const batch = 200;
  let cursor: {startedAt: Date; id: string} | null = null;
  let updated = 0;
  const ownerIso = new Map<string, string>();
  for (let page = 0; page < 500; page++) {
    const rows = await db.query(
      `SELECT c.id,c.started_at,c.remote_number,c.snapshot_owner_id,s.country_iso FROM call_records c LEFT JOIN sims s ON s.id=c.sim_id
       WHERE c.remote_canonical_key IS NULL AND c.remote_number IS NOT NULL
         AND ($1::timestamptz IS NULL OR (c.started_at,c.id)>($1::timestamptz,$2::uuid))
       ORDER BY c.started_at,c.id LIMIT $3`,
      [cursor?.startedAt ?? null, cursor?.id ?? null, batch],
    );
    if (!rows.rowCount) break;
    const last = rows.rows[rows.rows.length - 1] as {started_at: Date; id: string};
    cursor = {startedAt: last.started_at, id: last.id};
    for (const row of rows.rows) {
      const iso = typeof row.country_iso === "string" && /^[A-Za-z]{2}$/.test(row.country_iso)
        ? row.country_iso.toUpperCase()
        : ownerIso.get(row.snapshot_owner_id) ?? ownerIso.set(row.snapshot_owner_id, await ownerCountryIso(db, row.snapshot_owner_id)).get(row.snapshot_owner_id)!;
      const key = callCanonicalKey(row.remote_number, iso);
      if (!key) continue;
      const applied = await db.query(
        `UPDATE call_records SET remote_canonical_key=$2 WHERE id=$1 AND remote_canonical_key IS NULL`,
        [row.id, key],
      );
      updated += applied.rowCount ?? 0;
    }
    if ((rows.rowCount ?? 0) < batch) break;
  }
  if (updated) log(`backfilled ${updated} call_records.remote_canonical_key rows`);
}

/**
 * S22 decision 4. `aiHandling` is the single suppression fact the three clients read. Write paths
 * (claim/end/outbound) hand `callDto` a row without the `ai_call_runs` join, so an unknown run state
 * is treated as live: a call that still carries `ai_run_id` while ringing is AI's.
 */
function aiHandling(r: any) {
  return r.ai_run_id != null && r.state === "incoming_ringing" && !["lost_race", "failed_before_answer"].includes(r.ai_run_state);
}
function occupancyDto(r: any, sessionId: string) {
  const terminal = r.state === "ended" || r.state === "failed";
  const holdsLock = !terminal && r.lock_acquired_at != null;
  return {
    holdsLock,
    lockedSince: holdsLock ? new Date(r.lock_acquired_at).toISOString() : null,
    occupantPlatform: (r.answered_by_platform ?? r.originating_platform) || null,
    occupantDevice: r.answered_by_device ?? null,
    isCurrentSession: r.originating_session_id === sessionId || r.claimed_by_session_id === sessionId,
    // A human must not be able to hang up the call the AI is answering, and S38: a call dialed on
    // the Pixel itself has no Control-side execution to release.
    canRelease: !terminal && !(r.mode_snapshot === "ai" && aiHandling(r)) && r.originating_platform !== "pixel",
  };
}

/**
 * S21 §A: `contactId/contactName/blocked/blockedEntryId` are resolved per page by
 * `annotateNumbers`, never by the client and never by loading the owner's whole address book.
 * Write paths pass the empty annotation; the three fields are contractually optional/nullable.
 */
// S58: dial/claim/end build their DTO from a bare call_records row; this adds the sim → gateway
// kind the list/detail reads join, so a mutation response never downgrades a DJI 4G call to 'pixel'.
async function mutationCallDto(c: PoolClient, r: any) {
  // S67c: unseen re-reads the row through the shared PENDING_CALL rule (same transaction, so it sees this mutation).
  const extra = await c.query(`SELECT (SELECT g.kind FROM sims s JOIN gateways g ON g.id=s.gateway_id WHERE s.id=$1) kind,
    (SELECT ${PENDING_CALL} FROM call_records c WHERE c.id=$2) unseen,
    (SELECT COALESCE(NULLIF(ps.label,''),ps.phone_label) FROM sims ps WHERE ps.id=$3) peer_sim_label,
    (SELECT COALESCE(NULLIF(cs.label,''),cs.phone_label) FROM sims cs WHERE cs.id=$1) sim_label`, [r.sim_id, r.id, r.peer_sim_id ?? null]);
  return callDto({ ...r, gateway_kind: extra.rows[0]?.kind ?? null, unseen: extra.rows[0]?.unseen, peer_sim_label: extra.rows[0]?.peer_sim_label, sim_label: extra.rows[0]?.sim_label });
}

/** S72: the other leg's SIM label (label, else its number); needs `c` = call_records. */
const PEER_SIM_LABEL = `(SELECT COALESCE(NULLIF(ps.label,''),ps.phone_label) FROM sims ps WHERE ps.id=c.peer_sim_id) peer_sim_label`;
/** S81: the called/calling hosted SIM's label (label, else its number); needs `c` = call_records. */
const SIM_LABEL = `(SELECT COALESCE(NULLIF(cs.label,''),cs.phone_label) FROM sims cs WHERE cs.id=c.sim_id) sim_label`;

function callDto(r: any, annotation: NumberAnnotation = EMPTY_NUMBER_ANNOTATION) {
  return {
    ...annotation,
    id: r.id,
    simId: r.sim_id,
    direction: r.direction,
    remoteNumber: r.remote_number,
    state: r.state,
    startedAt: r.started_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
    originatingPlatform:r.originating_platform,
    answeredByPlatform: r.answered_by_platform,
    answeredByDevice:r.answered_by_device,
    failureReason: USER_HIDDEN_RECLAIM_REASONS.has(r.failure_reason) ? null : r.failure_reason,
    recordingStatus: r.recording_status,
    gatewayTimeZone: r.gateway_time_zone,
    // S58: display-only hardware label via sim → gateway (list/detail join it, mutations use mutationCallDto).
    gatewayKind: r.gateway_kind ?? null,
    // S38: why this call was not offered the normal way. NULL for every pre-S38 row.
    conflictDisposition: r.conflict_disposition ?? null,
    // S38b: which side blocked a `number_blocked` row ('phone' | 'gateway' | 'control'), for the row label.
    blockedSource: r.blocked_source ?? null,
    // S22 decision 4 contract: suppress = answerMode==='ai' && aiHandling.
    answerMode: r.mode_snapshot ?? null,
    aiHandling: aiHandling(r),
    aiTriggerAt: r.ai_trigger_at ?? null,
    // S67c: row-level PENDING_CALL (badges.ts); rows read without the column (gateway report) are false.
    unseen: r.unseen === true,
    // S72: own hosted SIM ↔ own hosted SIM; peerSim is the other leg's SIM (caller for incoming, callee for outgoing).
    internal: r.internal_call === true,
    peerCallId: r.peer_call_id ?? null,
    peerSimId: r.peer_sim_id ?? null,
    peerSimLabel: r.peer_sim_label ?? null,
    // S81: this call's own SIM label, only when known (rows read without the column omit it).
    ...(r.sim_label ? { simLabel: r.sim_label } : {}),
  };
}
function smsDto(r: any, annotation: NumberAnnotation = EMPTY_NUMBER_ANNOTATION) {
  return {
    ...annotation,
    ...smsAddress(r.remote_number,r.sim_country_iso),
    id: r.id,
    simId: r.sim_id,
    direction: r.direction,
    remoteNumber: r.remote_number,
    body: r.body,
    state: r.state,
    missingParts: r.missing_parts,
    createdAt: r.created_at,
    receivedAt: r.received_at,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    failureReason: r.failure_reason,
    // S67c: same rule as the /badges SMS count.
    unread: r.direction === "incoming" && r.read_at == null,
  };
}
function commandDto(r: any) {
  return {
    id: r.id,
    ...(r.call_id ? { callId: r.call_id } : {}),
    ...(r.sim_id ? { simId: r.sim_id } : {}),
    generation: Number(r.generation),
    sequence: Number(r.sequence),
    expiresAt: r.expires_at,
  };
}

function mapRecordingError(error: unknown): never {
  if (error instanceof RecordingFileVerificationBusyError)
    return fail(503, "RECORDING_VERIFICATION_BUSY", "Recording verification capacity is busy");
  if (!(error instanceof RecordingStoreError)) throw error;
  if (error.code === "INVALID_RECORDING_PATH")
    return fail(400, error.code, "Recording path is invalid");
  if (error.code === "RECORDING_UNAVAILABLE")
    return fail(404, error.code, "Recording is unavailable");
  if (error.code === "RECORDING_CORRUPT")
    return fail(503, error.code, "Recording failed integrity verification");
  return fail(416, error.code, "Requested byte range is not satisfiable", {
    size: error.size,
  });
}

// S36 C4: MP3 export. ffmpeg is the heaviest thing this box ever runs, so transcodes are serialised
// on one promise chain and every result is cached per track; a queued twin finds the file and exits.
// ponytail: one global chain, per-track queues only if exports ever become concurrent enough to matter.
let mp3Chain: Promise<unknown> = Promise.resolve();
function failTranscode(db: Db, error: unknown, stderr = ""): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof RecordingStoreError) mapRecordingError(error);
  diag(db, "recording.transcode_failed", { error: String((error as Error)?.message ?? error).slice(0, 200), stderr }, { level: "error" });
  return fail(503, "RECORDING_TRANSCODE_FAILED", "Recording could not be transcoded");
}
async function runFfmpeg(db: Db, args: string[], pipe?: (proc: ReturnType<typeof spawn>) => Promise<void>) {
  const proc = spawn("ffmpeg", args, { stdio: ["pipe","pipe","pipe"] });
  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-600); });
  try {
    await Promise.race([once(proc, "spawn"), once(proc, "error").then(([error]) => { throw error; })]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      fail(501, "RECORDING_TRANSCODE_UNAVAILABLE", "MP3 transcoding is not available");
    throw error;
  }
  try {
    await Promise.all([
      ...(pipe ? [pipe(proc)] : []),
      once(proc, "close").then(([code]) => { if (code !== 0) throw new Error(`ffmpeg exited ${code}`); }),
    ]);
  } catch (error) {
    proc.kill("SIGKILL");
    failTranscode(db, error, stderr);
  }
}
async function transcodeMp3(db: Db, cacheDir: string, target: string, open: () => Promise<{stream: Readable}>) {
  await mkdir(cacheDir, { recursive: true });
  const temp = `${target}.${opaqueToken(8)}.part`;
  let opened: {stream: Readable} | undefined;
  try {
    // Output goes to a file, not pipe:1: ffmpeg can only write the Xing/VBR header when it can seek
    // back, and without it players estimate the duration from bitrate (a 22 s track read as 28 s).
    await runFfmpeg(db, ["-hide_banner","-loglevel","error","-i","pipe:0","-codec:a","libmp3lame","-q:a","5","-f","mp3","-y",temp], async (proc) => {
      // The remote store's stream is already flowing (its idle-timeout `data` listener starts it), so it
      // must be piped in the same tick it is opened: any await in between drops the Ogg header pages.
      opened = await open();
      await pipeline(opened.stream, proc.stdin!);
    });
    await rename(temp, target);
  } finally {
    opened?.stream.destroy();
    await unlink(temp).catch(() => {});
  }
}
// S36 C4: the `conversation` export mixes both original tracks into one file. ffmpeg needs seekable
// inputs for two of them, so each track is spooled into the cache dir first. `-itsoffset` cannot
// align them (amix mixes by sample position, not PTS — verified: the offset input stayed unshifted),
// so the track that started later is delayed inside the filter graph instead.
async function mixMp3(db: Db, cacheDir: string, target: string, open: (track: RecordingTrack) => Promise<{stream: Readable}>, offsetMs: number | null) {
  await mkdir(cacheDir, { recursive: true });
  const token = opaqueToken(8);
  const temp = `${target}.${token}.part`, caller = `${target}.${token}.caller`, remote = `${target}.${token}.remote`;
  try {
    try {
      for (const [track, path] of [["caller_original", caller], ["remote_original", remote]] as const) {
        // Same-tick pipe, for the reason transcodeMp3 documents.
        const opened = await open(track);
        await pipeline(opened.stream, createWriteStream(path));
      }
    } catch (error) { failTranscode(db, error); }
    // Without a timeline the spooled files are measured instead: both tracks stop at hangup, so
    // their real decoded durations align them by the end.
    const offset = offsetMs ?? ((await probeDurationMs(caller)) - (await probeDurationMs(remote)));
    // caller is input 0 and remote input 1; the skew delays whichever direction started later.
    const delay = Math.round(Math.abs(offset));
    const filter = offset >= 0
      ? `[1:a]adelay=${delay}:all=1[d];[0:a][d]amix=inputs=2:duration=longest:normalize=0`
      : `[0:a]adelay=${delay}:all=1[d];[d][1:a]amix=inputs=2:duration=longest:normalize=0`;
    await runFfmpeg(db, ["-hide_banner","-loglevel","error","-nostdin","-i",caller,"-i",remote,"-filter_complex",filter,"-codec:a","libmp3lame","-q:a","5","-f","mp3",temp]);
    await rename(temp, target);
  } finally {
    await Promise.all([temp, caller, remote].map((path) => unlink(path).catch(() => {})));
  }
}
/** Decoded length of a spooled track, in ms; an absent or unreadable ffprobe measures nothing. */
async function probeDurationMs(path: string) {
  const proc = spawn("ffprobe", ["-v","error","-show_entries","format=duration","-of","csv=p=0",path], { stdio: ["ignore","pipe","pipe"] });
  let out = "";
  proc.stdout!.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(0, 64); });
  proc.stderr!.resume();
  const [code] = await Promise.race([once(proc, "close"), once(proc, "error").then(() => [null])]);
  const seconds = Number(out.trim());
  return code === 0 && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
// S36 C4: the exact start skew comes from the media node's timeline, which only the local store can
// read. `null` means unknown — the mix then falls back to measuring the spooled files.
async function conversationOffsetMs(store: RecordingStore | RemoteRecordingStore | PixelRecordingArchiveReader, callId: string) {
  const manifest = await store.manifest(callId) ?? fail(404, "NOT_FOUND", "Recording not found");
  for (const track of recordingTracks) {
    const item = "artifacts" in manifest
      ? manifest.artifacts.find((artifact) => artifact.name === `${track}.ogg`)
      : manifest.tracks.find((entry) => entry.track === track);
    if (!item?.bytes) fail(404, "NOT_FOUND", "Recording track not found");
  }
  const timelineBytes = "artifacts" in manifest ? manifest.artifacts.find((artifact) => artifact.name === "timeline.jsonl")?.bytes ?? 0 : 0;
  return store instanceof RecordingStore ? store.firstPacketSkewMs(callId, timelineBytes) : null;
}
/**
 * Pre-builds the per-track mp3 exports once a Pixel archive completes, into the same cache files the
 * GET …/recordings/:track?format=mp3 route serves (cachedMp3 skips existing ones and serializes the
 * ffmpeg runs). Best effort: a failure is one diag row and the export still transcodes on demand.
 */
export async function pretranscodePixelRecording(
  db: Db,
  reader: Pick<PixelRecordingArchiveReader, "manifest" | "openTrack">,
  cacheDir: string,
  callId: string,
  transcode = transcodeMp3,
) {
  let track = "";
  try {
    const manifest = await reader.manifest(callId);
    for (const item of manifest?.tracks ?? []) {
      track = item.track;
      await cachedMp3(cacheDir, `${callId}-pixel-${item.track}`, (target) =>
        transcode(db, cacheDir, target, () => reader.openTrack(callId, item.track)));
    }
  } catch (error) {
    diag(db, "recording.pretranscode_failed", { track, reason: errorReason(error) }, { callId, level: "warn" });
  }
}
function cachedMp3(cacheDir: string, key: string, build: (target: string) => Promise<void>) {
  const target = join(cacheDir, `${key}.mp3`);
  const cached = async () => {
    const hit = await stat(target).catch(() => null);
    return hit?.isFile() ? { path: target, size: hit.size } : null;
  };
  const transcode = async () => {
    // A twin queued behind the transcode that produced this file finds it here and exits.
    const done = await cached();
    if (done) return done;
    await build(target);
    return { path: target, size: (await stat(target)).size };
  };
  return cached().then((hit) => {
    if (hit) return hit;
    const run = mp3Chain.then(transcode, transcode);
    mp3Chain = run.catch(() => {});
    return run;
  });
}

function registerRecordingRoutes(
  app: FastifyInstance,
  db: Db,
  store: RecordingStore | null,
  media:MediaNodeRegistry|null,
  pixel:PixelRecordingArchiveReader|null,
  mp3CacheDir: string | null,
) {
  async function authorize(req: FastifyRequest, callId: string) {
    const p = requireUser(req);
    const owned = await db.query(
      `SELECT COALESCE(media_node_id,'relay-primary') media_node_id,media_epoch FROM call_records WHERE id=$1 AND snapshot_owner_id=$2`,
      [callId, p.user.id],
    );
    if (!owned.rowCount) fail(404, "NOT_FOUND", "Call not found");
    return owned.rows[0] as {media_node_id:string;media_epoch:string};
  }
  function requireStore(call:{media_node_id:string;media_epoch:string}) {
    if(call.media_node_id==='relay-primary'){
      if(store)return store;
      fail(
        503,
        "RECORDING_NOT_CONFIGURED",
        "Recording storage is not configured",
      );
    }
    if(!media)fail(503,"RECORDING_NOT_CONFIGURED","Recording storage is not configured");
    const registry=media as MediaNodeRegistry;
    let baseUrl:string|undefined,secret='';
    try{baseUrl=registry.recordingBaseUrl(call.media_node_id);secret=registry.recordingSecret(call.media_node_id);}catch{fail(503,"RECORDING_NODE_UNAVAILABLE","Recording node is not configured");}
    if(!baseUrl)fail(503,"RECORDING_NODE_UNAVAILABLE","Recording node does not expose internal recordings");
    return new RemoteRecordingStore(baseUrl as string,secret,call.media_node_id,Number(call.media_epoch));
  }

  app.get("/api/v1/calls/:id/recordings", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const {source}=z.object({source:z.enum(['media_node','pixel']).default('media_node')}).parse(req.query);
    const call=await authorize(req, id);
    reply.header("Cache-Control", "private, no-store");
    try {
      if(source==='pixel'){
        const selected=pixel??fail(503,'PIXEL_ARCHIVE_DISABLED','Pixel recording archive is not enabled');
        return {recording:await selected.manifest(id)};
      }
      const manifest=await requireStore(call).manifest(id);
      return {recording:manifest?{...manifest,nodeId:call.media_node_id,mediaEpoch:Number(call.media_epoch)}:null};
    } catch (error) {
      mapRecordingError(error);
    }
  });

  app.get("/api/v1/calls/:id/recordings/:track", async (req, reply) => {
    const { id, track } = z
      .object({ id: z.uuid(), track: z.enum([...recordingTracks, "caller_playout", "conversation"]) })
      .parse(req.params);
    const {source,disposition,format}=z.object({
      source:z.enum(['media_node','pixel']).default('media_node'),
      disposition:z.enum(['attachment']).optional(),
      format:z.enum(['mp3']).optional(),
    }).parse(req.query);
    const call=await authorize(req, id);
    if (source !== "pixel" && track === "caller_playout") fail(404, "NOT_FOUND", "Recording track not found");
    // S36 C4: `conversation` is a virtual track — it exists only as the mixed mp3 export.
    if (track === "conversation" && format !== "mp3") fail(400, "INVALID_RECORDING_PATH", "Recording path is invalid");
    const attachment = disposition === "attachment";
    let destroyStream: (() => void) | undefined;
    const destroyOnAbort = () => destroyStream?.();
    const destroyOnPrematureClose = () => {
      if (!reply.raw.writableEnded) destroyStream?.();
    };
    req.raw.once("aborted", destroyOnAbort);
    reply.raw.once("close", destroyOnPrematureClose);
    let opened;
    let mp3: {path: string; size: number} | undefined;
    try {
      const selected=source==='pixel'?(pixel??fail(503,'PIXEL_ARCHIVE_DISABLED','Pixel recording archive is not enabled')):requireStore(call);
      // S36 C4: an mp3 export is a whole-file transcode served from cache — no byte range, and never
      // the source ETag, because the bytes are not the stored ones.
      if (format === "mp3") {
        const cacheDir = mp3CacheDir ?? fail(501, "RECORDING_TRANSCODE_UNAVAILABLE", "MP3 transcoding is not available");
        mp3 = await cachedMp3(cacheDir, `${id}-${source}-${track}`, async (target) => {
          if (track !== "conversation") return transcodeMp3(db, cacheDir, target, () => selected.openTrack(id, track as RecordingTrack));
          const offset = await conversationOffsetMs(selected, id);
          return mixMp3(db, cacheDir, target, (part) => selected.openTrack(id, part), offset);
        });
      } else opened = await selected.openTrack(
        id,
        track as RecordingTrack,
        attachment ? undefined : typeof req.headers.range === "string" ? req.headers.range : undefined,
      );
    } catch (error) {
      req.raw.off("aborted", destroyOnAbort);
      reply.raw.off("close", destroyOnPrematureClose);
      if (
        error instanceof RecordingStoreError &&
        error.code === "RANGE_NOT_SATISFIABLE"
      )
        reply.header("Content-Range", `bytes */${error.size ?? 0}`);
      mapRecordingError(error);
    }
    const stream = mp3 ? createReadStream(mp3.path) : opened!.stream;
    destroyStream = () => stream.destroy();
    if (req.raw.aborted || reply.raw.destroyed) {
      stream.destroy();
      req.raw.off("aborted", destroyOnAbort);
      reply.raw.off("close", destroyOnPrematureClose);
      return reply;
    }
    stream.once("close", () => {
      req.raw.off("aborted", destroyOnAbort);
      reply.raw.off("close", destroyOnPrematureClose);
    });
    const ext = mp3 ? "mp3" : source === "pixel" ? "wav" : "ogg";
    reply
      .type(mp3 ? "audio/mpeg" : source==='pixel' ? "audio/wav" : "audio/ogg")
      .header("Cache-Control", "private, no-store")
      .header("Content-Length", mp3 ? mp3.size : opened!.end - opened!.start + 1);
    if (!mp3) reply.header("ETag", `"${opened!.sha256}"`);
    if (attachment) {
      reply.header(
        "Content-Disposition",
        mp3 ? `attachment; filename="${id}-${track}.mp3"` : `attachment; filename="call-${id}-${source}-${track}.${ext}"`,
      );
    } else if (!mp3) {
      reply.header("Accept-Ranges", "bytes");
      if (opened!.partial)
        reply
          .code(206)
          .header(
            "Content-Range",
            `bytes ${opened!.start}-${opened!.end}/${opened!.size}`,
          );
    }
    return reply.send(stream);
  });
}

function registerPasskeyRoutes(app: FastifyInstance, db: Db, config: Config) {
  app.post("/api/v1/passkeys/register/options", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const keys = await db.query(
      `SELECT encode(id,'base64') id,transports FROM passkeys WHERE user_id=$1`,
      [p.user.id],
    );
    const options = await generateRegistrationOptions({
      rpName: "VoDog",
      rpID: config.RP_ID,
      userName: p.user.username,
      userID: new TextEncoder().encode(p.user.id),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      excludeCredentials: keys.rows.map((r) => ({
        id: Buffer.from(r.id, "base64").toString("base64url"),
        transports: r.transports ?? undefined,
      })),
    });
    const q = await db.query(
      `INSERT INTO webauthn_challenges(user_id,purpose,challenge,expires_at)VALUES($1,'register',$2,now()+interval '5 minutes')RETURNING id`,
      [p.user.id, options.challenge],
    );
    return { challengeId: q.rows[0].id, options };
  });
  app.post("/api/v1/passkeys/register/verify", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const b = z
      .object({ challengeId: z.uuid(), response: z.any() })
      .parse(req.body);
    const challenge = await consumeChallenge(
      db,
      b.challengeId,
      "register",
      p.user.id,
    );
    let verification:
      | Awaited<ReturnType<typeof verifyRegistrationResponse>>
      | undefined;
    try {
      verification = await verifyRegistrationResponse({
        response: b.response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: passkeyOrigins(config),
        expectedRPID: config.RP_ID,
        requireUserVerification: true,
      });
    } catch {
      fail(
        400,
        "PASSKEY_VERIFICATION_FAILED",
        "Passkey registration could not be verified",
      );
    }
    assertRegistrationVerified(verification);
    const info = verification.registrationInfo;
    await db.query(
      `INSERT INTO passkeys(id,user_id,public_key,counter,device_type,backed_up,transports,aaguid,authenticator_attachment,client_platform,label)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)`,
      [
        Buffer.from(info.credential.id, "base64url"),
        p.user.id,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        info.credentialDeviceType,
        info.credentialBackedUp,
        info.credential.transports ?? (b.response as RegistrationResponseJSON).response?.transports ?? null,
        normalizeAaguid(info.aaguid),
        (b.response as {authenticatorAttachment?: string}).authenticatorAttachment ?? null,
        clientPlatformLabel(p.platform, req.headers["user-agent"]),
      ],
    );
    return { verified: true };
  });
  app.post("/api/v1/passkeys/authenticate/options", async (req) => {
    const b = z.object({ username: z.string().min(1), turnstileToken: z.string().min(1).max(4096).optional() }).parse(req.body);
    const username = b.username.trim().toLowerCase();
    rejectAuthAttempts(req.ip, username, "passkey");
    // S22 decision 11: passkey sign-in requires neither a password nor a solved Turnstile. The flow
    // is still rate limited per IP+username, and the signature plus the one-shot challenge remain the
    // real gate. `turnstileToken` stays accepted (and ignored) so old clients keep working.
    void b.turnstileToken;
    const u = await db.query(`SELECT id FROM users WHERE email=$1`, [username]);
    if (!u.rowCount) {
      recordAuthFailure(req.ip, username, "passkey");
      fail(404, "NOT_FOUND", "Account or passkey not found");
    }
    const keys = await db.query(
      `SELECT encode(id,'base64') id,transports FROM passkeys WHERE user_id=$1`,
      [u.rows[0].id],
    );
    if (!keys.rowCount) {
      recordAuthFailure(req.ip, username, "passkey");
      fail(404, "NOT_FOUND", "Account or passkey not found");
    }
    const options = await generateAuthenticationOptions({
      rpID: config.RP_ID,
      userVerification: "required",
      allowCredentials: keys.rows.map((r) => ({
        id: Buffer.from(r.id, "base64").toString("base64url"),
        transports: r.transports ?? undefined,
      })),
    });
    const q = await db.query(
      `INSERT INTO webauthn_challenges(user_id,purpose,challenge,expires_at)VALUES($1,'authenticate',$2,now()+interval '5 minutes')RETURNING id`,
      [u.rows[0].id, options.challenge],
    );
    return { challengeId: q.rows[0].id, options };
  });
  app.post("/api/v1/passkeys/authenticate/verify", async (req, reply) => {
    const b = z
      .object({
        challengeId: z.uuid(),
        response: z.any(),
        platform: z.enum(["web", "ios", "android", "macos"]),
      })
      .parse(req.body);
    if (b.platform === "web" && req.headers.origin !== config.PUBLIC_ORIGIN)
      fail(
        403,
        "ORIGIN_REJECTED",
        "Web passkey login requires the configured origin",
      );
    const challengeRow = await db.query(
      `SELECT user_id FROM webauthn_challenges WHERE id=$1`,
      [b.challengeId],
    );
    if (!challengeRow.rowCount) {
      emitCrowdsecAuthFail({ip: req.ip, type: "passkey"});
      fail(400, "CHALLENGE_INVALID", "Challenge is invalid");
    }
    const userId = challengeRow.rows[0].user_id;
    const username = String(
      (await db.query(`SELECT email FROM users WHERE id=$1`, [userId])).rows[0]?.email ?? "",
    ).trim().toLowerCase();
    if (username) rejectAuthAttempts(req.ip, username, "passkey");
    const challenge = await consumeChallenge(
      db,
      b.challengeId,
      "authenticate",
      userId,
    );
    const credId = Buffer.from(String(b.response.id), "base64url");
    const k = await db.query(
      `SELECT p.*,u.email username,u.role FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.user_id=$2`,
      [credId, userId],
    );
    if (!k.rowCount) {
      if (username) recordAuthFailure(req.ip, username, "passkey");
      else emitCrowdsecAuthFail({ip: req.ip, type: "passkey"});
      fail(
        400,
        "PASSKEY_VERIFICATION_FAILED",
        "Passkey authentication could not be verified",
      );
    }
    const row = k.rows[0];
    let verification:
      | Awaited<ReturnType<typeof verifyAuthenticationResponse>>
      | undefined;
    try {
      verification = await verifyAuthenticationResponse({
        response: b.response as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: passkeyOrigins(config),
        expectedRPID: config.RP_ID,
        requireUserVerification: true,
        credential: {
          id: Buffer.from(row.id).toString("base64url"),
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: row.transports ?? undefined,
        },
      });
    } catch {
      recordAuthFailure(req.ip, row.username, "passkey");
      fail(
        400,
        "PASSKEY_VERIFICATION_FAILED",
        "Passkey authentication could not be verified",
      );
    }
    if (!verification?.verified) {
      recordAuthFailure(req.ip, row.username, "passkey");
    }
    assertAuthenticationVerified(verification);
    loginAttempts.clear(req.ip, row.username);
    await db.query(`UPDATE passkeys SET counter=$2,last_used_at=now() WHERE id=$1`, [
      credId,
      verification.authenticationInfo.newCounter,
    ]);
    const access = opaqueToken(),
      refresh = b.platform === "web" ? null : opaqueToken();
    const s = await db.query(
      `INSERT INTO sessions(user_id,access_hash,refresh_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,$2,$3,$4,$5,now()+$6::interval,CASE WHEN $3::text IS NULL THEN NULL ELSE now()+interval '30 days' END)RETURNING access_expires_at,id`,
      [
        userId,
        tokenHash(access),
        refresh ? tokenHash(refresh) : null,
        b.platform === "web" ? "web" : "native",
        b.platform,
        b.platform === "web" ? "12 hours" : "15 minutes",
      ],
    );
    if (b.platform === "web")
      reply.setCookie("cc_session", access, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/api/v1",
        maxAge: 12 * 60 * 60,
      });
    return {
      user: { id: userId, username: row.username, role: row.role },
      ...(b.platform === "web"
        ? {}
        : {
            token: access,
            refreshToken: refresh,
            expiresAt: s.rows[0].access_expires_at,
          }),
    };
  });
  app.get("/api/v1/passkeys", async (req) => {
    const p = requireUser(req);
    const keys = await db.query(
      `SELECT encode(id,'base64') id,created_at,device_type,backed_up,transports,label,aaguid,client_platform,authenticator_attachment,last_used_at
       FROM passkeys WHERE user_id=$1 ORDER BY created_at,id`,
      [p.user.id],
    );
    return { items: keys.rows.map(toPasskeyItem) };
  });
  app.patch("/api/v1/passkeys/:id", async (req) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.string().min(1).max(512) }).parse(req.params);
    const { label } = z.object({ label: z.string().trim().min(1).max(64) }).parse(req.body);
    const credId = decodePasskeyId(id);
    if (!credId) fail(400, "INVALID_REQUEST", "Passkey id is not valid base64url");
    const renamed = await db.query(
      `UPDATE passkeys SET label=$3 WHERE id=$1 AND user_id=$2 RETURNING *`,
      [credId, p.user.id, label],
    );
    if (!renamed.rowCount) fail(404, "NOT_FOUND", "Passkey not found");
    return { item: toPasskeyItem(renamed.rows[0]) };
  });
  app.delete("/api/v1/passkeys/:id", async (req, reply) => {
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.string().min(1).max(512) }).parse(req.params);
    const credId = decodePasskeyId(id);
    if (!credId) fail(400, "INVALID_REQUEST", "Passkey id is not valid base64url");
    const deleted = await db.query(`DELETE FROM passkeys WHERE id=$1 AND user_id=$2`, [credId, p.user.id]);
    if (!deleted.rowCount) fail(404, "NOT_FOUND", "Passkey not found");
    return reply.code(204).send();
  });
}
function decodePasskeyId(id: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length % 4 === 1) return null;
  const credId = Buffer.from(id, "base64url");
  if (!credId.length) return null;
  if (credId.toString("base64url") !== id.replace(/=+$/, "")) return null;
  return credId;
}
async function consumeChallenge(
  db: Db,
  id: string,
  purpose: string,
  userId: string,
) {
  return tx(db, async (c) => {
    const q = await c.query(
      `UPDATE webauthn_challenges SET consumed_at=now() WHERE id=$1 AND purpose=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING challenge`,
      [id, purpose, userId],
    );
    if (!q.rowCount)
      fail(
        400,
        "CHALLENGE_INVALID",
        "Challenge is expired, consumed, or invalid",
      );
    return q.rows[0].challenge as string;
  });
}

async function authorizeUserMedia(
  db: Db,
  config:Config,
  p: Extract<Principal, { kind: "user" }>,
  callId: string,
  media: MediaNodeRegistry,
  mediaProbes:MediaProbeCoordinator|null,
  preferredNodeId?: string,
  networkGeneration?:string,
  relayNodeId?:string,
) {
  return tx(db,async c=>{
  const q = await c.query(
    `SELECT c.id,c.gateway_id,c.direction,c.state,c.generation,c.originating_session_id,c.claimed_by_session_id,g.device_epoch,g.media_ready,g.control_enabled,g.last_seen_at,
      c.media_node_id,c.media_epoch,
      EXISTS(SELECT 1 FROM sessions winner WHERE winner.id=$3 AND winner.revoked_at IS NULL AND winner.access_expires_at>now()) session_valid
     FROM call_records c JOIN gateways g ON g.id=c.gateway_id WHERE c.id=$1 AND c.snapshot_owner_id=$2 FOR UPDATE OF c`,
    [callId, p.user.id,p.sessionId],
  );
  if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
  const call = q.rows[0];
  // S40: a media/options 503 was invisible from Control's side. Written through the pool, never `c`,
  // because `fail()` throws and rolls this transaction back.
  if (!call.media_ready) {
    diag(db,"media.unavailable",{role:"user",reason:"gateway_media_not_ready",gatewayId:call.gateway_id},{callId,userId:p.user.id,level:"warn"});
    fail(503, "MEDIA_UNAVAILABLE", "Gateway media is not ready");
  }
  if(!online(call.last_seen_at,call.control_enabled,config)){
    diag(db,"media.unavailable",{role:"user",reason:"gateway_offline",gatewayId:call.gateway_id},{callId,userId:p.user.id,level:"warn"});
    fail(503,"GATEWAY_OFFLINE","Gateway is offline or locally disabled");
  }
  if(!call.session_valid) fail(409,"MEDIA_REVOKED","The winning session was revoked or expired");
  if (
    Number(call.generation) !== Number(call.device_epoch) ||
    ["ending", "ended", "failed", "unknown"].includes(call.state)
  )
    fail(409, "MEDIA_REVOKED", "Call media authorization is no longer valid");
  const winner =
    call.direction === "outgoing"
      ? call.originating_session_id
      : call.claimed_by_session_id;
  if (winner !== p.sessionId)
    fail(403, "MEDIA_NOT_WINNER", "This session does not own call media");
  let nodeId:string;
  // S73b: the env-preferred human-call node (relay-secondary: all users are in China) wins unless fresh probe
  // evidence from either end shows it failing; missing/stale evidence counts as not failed. A relay
  // client with no usable evidence also lands there instead of MEDIA_PROBE_REQUIRED / no common node,
  // because its tunnel path is not what the direct probes measure.
  const envPreferred=config.MEDIA_PREFERRED_NODE_ID,preferredOk=!!envPreferred&&(!preferredNodeId||preferredNodeId===envPreferred);
  const userKey=`user:${p.sessionId}`,gatewayKey=`gateway:${call.gateway_id}:${call.device_epoch}`;
  const relayFallback=preferredOk&&!!relayNodeId;
  // The relay fallback still honours the gateway: if it sees the preferred node failing, the relay node (S72b) is used.
  const relayTarget=()=>mediaProbes?.nodeFailed(gatewayKey,envPreferred!)?relayNodeId!:envPreferred!;
  // S75: which branch picked the node, remembered for the later media.offer row.
  let pick:NodePick;
  if(call.media_node_id){nodeId=selectMediaNode(media,call.media_node_id,preferredNodeId);pick=nodePicks.get(callId)??{nodeReason:"fixed",candidates:[nodeId]};}
  else if(preferredOk&&!mediaProbes?.nodeFailed(userKey,envPreferred!,networkGeneration)&&!mediaProbes?.nodeFailed(gatewayKey,envPreferred!)){nodeId=selectMediaNode(media,null,envPreferred);pick={nodeReason:"preferred",candidates:[envPreferred!]};}
  // S72b (only without a preferred node): a client in relay mode reaches the relay node through the tunnel,
  // so its own direct probe (which may fail on 4G) does not pick the room; the relay node does, unless it asked for another.
  else if(!envPreferred&&mediaProbes&&relayNodeId&&(!preferredNodeId||preferredNodeId===relayNodeId)){nodeId=selectMediaNode(media,null,relayNodeId);pick={nodeReason:"relay",candidates:[relayNodeId]};}
  else if(mediaProbes){
    const generation=networkGeneration??(relayFallback?undefined:fail(409,'MEDIA_PROBE_REQUIRED','Current network probe results are required before media authorization'));
    let selection;
    if(generation)try{selection=mediaProbes.select({userSubjectKey:userKey,clientNetworkGeneration:generation,gatewaySubjectKey:gatewayKey});}
    catch(error){if(error instanceof Error&&'code'in error&&error.code==='PROBE_OPTIONS_REQUIRED'){if(!relayFallback)fail(409,'MEDIA_PROBE_REQUIRED','Current network probe results are required before media authorization');}else throw error;}
    const selected=selection?.nodeId??(relayFallback?relayTarget():fail(503,'MEDIA_NODE_UNAVAILABLE','No media node is currently reachable by both endpoints'));
    if(preferredNodeId&&preferredNodeId!==selected)fail(409,'MEDIA_NODE_MISMATCH','Requested media node does not match current probe selection');
    nodeId=selected;pick={nodeReason:selection?.nodeId?selection.reason:"relay_fallback",candidates:selection?.nodeId?media.probeNodes().map(n=>n.id):[envPreferred!,relayNodeId!]};
  }else{nodeId=selectMediaNode(media,call.media_node_id,preferredNodeId);pick={nodeReason:preferredNodeId?"requested":"default",candidates:[nodeId]};}
  if(!call.media_node_id){if(nodePicks.size>10_000)nodePicks.clear();nodePicks.set(callId,pick);}
  call.nodeReason=pick.nodeReason;call.candidates=pick.candidates;
  if(!call.media_node_id)await c.query(`UPDATE call_records SET media_node_id=$2,recording_status=CASE WHEN recording_status='none' THEN 'pending' ELSE recording_status END WHERE id=$1 AND media_node_id IS NULL`,[callId,nodeId]);
  call.media_node_id=nodeId;
  return call;
  });
}
async function authorizeGatewayMedia(
  db: Db,
  config:Config,
  gatewayId: string,
  callId: string,
  media:MediaNodeRegistry,
  mediaProbes:MediaProbeCoordinator|null,
  preferredNodeId?:string,
  capture?:CaptureInput,
  earlyMediaOnly=false,
) {
  return tx(db,async c=>{
  // Lock order: gateway row first, exactly like every command-issuing transaction (dial, hangup,
  // telecom snapshot, ack). `ensureCaptureBinding` inserts a row whose FK takes KEY SHARE on this
  // gateway, so taking the call row first inverted the order against the snapshot POST (which holds
  // the gateway and then locks the call) — 2026-09-18 deadlock (40P01) on media/options.
  await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[gatewayId]);
  // S22 (R5 §Q7.4): the gateway's own media leg reads the same 3-heartbeat / 15-second debounce as
  // the AI audio authority and the human call path. A bare `g.media_ready` here let one unready
  // heartbeat refuse options/offer with 503 and, on the post-offer recheck, close the bridge room
  // that the AI leg was already using.
  const q = await c.query(
    `SELECT c.id,c.state,c.direction,c.generation,c.snapshot_owner_id,c.device_call_id,c.media_node_id,c.media_epoch,c.originating_session_id,c.claimed_by_session_id,g.device_epoch,g.control_enabled,g.last_seen_at,
       (g.media_ready OR (g.media_unready_heartbeats<3 AND (g.media_unready_since IS NULL OR g.media_unready_since>now()-interval '15 seconds'))) media_ready
     FROM call_records c JOIN gateways g ON g.id=c.gateway_id WHERE c.id=$1 AND c.gateway_id=$2 FOR UPDATE OF c`,
    [callId, gatewayId],
  );
  if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
  const call = q.rows[0];
  // S56: a capture-less options request is only an unanswered outgoing call's early-media leg.
  // A terminal call falls through to MEDIA_REVOKED below: an early leg racing a hangup is not a missing capture.
  if(earlyMediaOnly&&!["ending","ended","failed","unknown"].includes(call.state)&&
    !(config.EARLY_MEDIA_ENABLED&&call.direction==="outgoing"&&["outgoing_pending","connecting"].includes(call.state)))
    fail(409,"CAPTURE_BINDING_REQUIRED","Gateway must provide a durable recording capture identity");
  if (!call.media_ready) {
    diag(db,"media.unavailable",{role:"gateway",reason:"gateway_media_not_ready",gatewayId},{callId,level:"warn"});
    fail(503, "MEDIA_UNAVAILABLE", "Gateway media is not ready");
  }
  if(!online(call.last_seen_at,call.control_enabled,config)){
    diag(db,"media.unavailable",{role:"gateway",reason:"gateway_offline",gatewayId},{callId,level:"warn"});
    fail(503,"GATEWAY_OFFLINE","Gateway is offline or locally disabled");
  }
  if (
    Number(call.generation) !== Number(call.device_epoch) ||
    ["ending", "ended", "failed", "unknown"].includes(call.state)
  )
    fail(409, "MEDIA_REVOKED", "Call media authorization is no longer valid");
  // S73f: a winning client that went offline before its own options left the gateway on 409 until its
  // options timeouts hung up the cellular call. With a preferred node the client's S73b branch would pick
  // it anyway unless an end's evidence shows it failing, so the gateway may fix it now under the same checks
  // (the winner's latest evidence of any network generation counts). A ringing call is never fixed here
  // (the AI commit pins its own node); otherwise, or when the gateway asked for another node, keep the 409.
  const envPreferred=config.MEDIA_PREFERRED_NODE_ID,winner=call.direction==="outgoing"?call.originating_session_id:call.claimed_by_session_id;
  const gatewayPreferred=!!mediaProbes&&!call.media_node_id&&!!envPreferred&&call.state!=="incoming_ringing"&&(!preferredNodeId||preferredNodeId===envPreferred)&&
    !mediaProbes.nodeFailed(`gateway:${gatewayId}:${call.device_epoch}`,envPreferred)&&!(winner&&mediaProbes.nodeFailed(`user:${winner}`,envPreferred));
  if(mediaProbes&&!call.media_node_id&&!gatewayPreferred)fail(409,'MEDIA_NODE_PENDING','Winning client must select the call media node first');
  const nodeId=selectMediaNode(media,call.media_node_id,gatewayPreferred?envPreferred:preferredNodeId);
  // S75: the client's later "fixed" branch reports why the node was fixed before it arrived.
  if(gatewayPreferred){if(nodePicks.size>10_000)nodePicks.clear();nodePicks.set(callId,{nodeReason:"gateway_preferred",candidates:[nodeId]});}
  if(!call.media_node_id)await c.query(`UPDATE call_records SET media_node_id=$2,recording_status=CASE WHEN recording_status='none' THEN 'pending' ELSE recording_status END WHERE id=$1 AND media_node_id IS NULL`,[callId,nodeId]);
  call.media_node_id=nodeId;
  if(capture)call.captureBinding=await ensureCaptureBinding(c,{enabled:config.PIXEL_ARCHIVE_ENABLED,gatewayId,call,capture,onlineSeconds:config.GATEWAY_ONLINE_SECONDS,fail});
  return call;
  },"gateway.media.authorize");
}
// S75: in-process only — after a Control restart an already-fixed call reports "fixed".
// ponytail: whole-map reset past 10k calls, same as the diag token buckets.
type NodePick={nodeReason:string;candidates:string[]};
const nodePicks=new Map<string,NodePick>();
function selectMediaNode(media:MediaNodeRegistry,current:string|null|undefined,preferred?:string){
  if(current){
    if(preferred&&current!==preferred)fail(409,"MEDIA_NODE_MISMATCH","Call media is fixed to another node");
    try{media.client(current);}catch(error){if(error instanceof MediaNodeNotFoundError)fail(503,"MEDIA_NODE_UNAVAILABLE","Call media node is not configured");throw error;}
    return current;
  }
  try{return media.choose(preferred);}catch(error){if(error instanceof MediaNodeNotFoundError)fail(400,"MEDIA_NODE_INVALID","Requested media node is not configured");throw error;}
}
async function requestMediaClose(
  db: Db,
  media: MediaNodeRegistry | null,
  callId: string,
) {
  const assigned=await db.query(`SELECT COALESCE(media_node_id,'relay-primary') node_id,media_epoch FROM call_records WHERE id=$1`,[callId]);
  if(!assigned.rowCount)return;
  const nodeId=assigned.rows[0].node_id as string,mediaEpoch=Number(assigned.rows[0].media_epoch);
  try {
    if (!media) throw new Error("media_not_configured");
    await media.close(callId,nodeId,mediaEpoch);
    await db.query(`DELETE FROM media_close_jobs WHERE call_id=$1`,[callId]);
  } catch (error) {
    await db.query(
      `INSERT INTO media_close_jobs(call_id,node_id,media_epoch,close_mode,attempts,last_error,next_attempt_at,updated_at)VALUES($1,$2,$3,'force',1,$4,now()+interval '30 seconds',now()) ON CONFLICT(call_id) DO UPDATE SET node_id=excluded.node_id,media_epoch=excluded.media_epoch,close_mode='force',attempts=media_close_jobs.attempts+1,last_error=excluded.last_error,next_attempt_at=excluded.next_attempt_at,completed_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now()`,
      [callId,nodeId,mediaEpoch,"media_close_failed"],
    );
  }
}
async function scheduleNormalMediaClose(c:PoolClient,call:any,command:any){
  await c.query(`INSERT INTO media_close_jobs(call_id,node_id,media_epoch,close_mode,attempts,last_error,next_attempt_at,updated_at)
    VALUES($1,COALESCE($2,'relay-primary'),$3,'wait_terminal',0,NULL,$4::timestamptz+interval '5 seconds',now())
    ON CONFLICT(call_id) DO UPDATE SET node_id=excluded.node_id,media_epoch=excluded.media_epoch,close_mode=CASE WHEN media_close_jobs.close_mode='force' THEN 'force' ELSE 'wait_terminal' END,
      next_attempt_at=CASE WHEN media_close_jobs.close_mode='force' THEN LEAST(media_close_jobs.next_attempt_at,excluded.next_attempt_at) ELSE excluded.next_attempt_at END,updated_at=now()`,
    [call.id,call.media_node_id,Number(call.media_epoch),command.expires_at]);
}
function requireMediaBridge(media:MediaNodeRegistry|null):MediaNodeRegistry {
  if(!media) fail(503,"MEDIA_UNAVAILABLE","Call media is not configured");
  return media as MediaNodeRegistry;
}
function registerMediaRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  media: MediaNodeRegistry | null,
  mediaProbes:MediaProbeCoordinator|null,
) {
  const offerBody = z.object({
    type: z.literal("offer"),
    sdp: z
      .string()
      .min(1)
      .max(120 * 1024),
  });
  app.post("/api/v1/calls/:id/media/options", async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body=z.object({transport:z.enum(["udp","tls"]).default("udp"),relay:z.boolean().optional(),nodeId:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),networkGeneration:z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/).optional()}).default({transport:"udp"}).parse(req.body);
    const bridge=requireMediaBridge(media);
    const call=await authorizeUserMedia(db,config,p,id,bridge,mediaProbes,body.nodeId,body.networkGeneration,relayNodeFor(config,body));
    const ice=relayIce(config,bridge.iceServers(call.media_node_id,body.transport),body,call.media_node_id);
    return {mediaNodeId:call.media_node_id,mediaEpoch:Number(call.media_epoch),iceServers:ice.iceServers,iceTransportPolicy:"relay",...ice.relayField};
  });
  app.post("/api/v1/calls/:id/media/offer", async (req) => {
    const startedAt = Date.now();
    const p = requireUser(req);
    mutationOrigin(req, config);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const offer = offerBody.parse(req.body);
    const bridge=requireMediaBridge(media);
    const call=await authorizeUserMedia(db,config,p,id,bridge,mediaProbes);
    let answer;
    try {
      // S75c: authorizeUserMedia admits only the call's winner session, the client leg's sole owner,
      // so its re-offer replaces the leg even if the bridge still sees the abandoned one Connected.
      answer = await bridge.offer(call.media_node_id,id,"client",offer,Number(call.media_epoch),true);
      // S36 C3: offer -> answer round trip against the media node, the client-side media latency.
      diag(db,"media.offer",{ms:Date.now()-startedAt,nodeId:call.media_node_id,nodeReason:call.nodeReason,candidates:call.candidates},{callId:id,userId:p.user.id});
    } catch (error) {
      // The 503 below hides which side refused; the bridge status (or the transport error) is kept here.
      diag(db,"media.offer_failed",{stage:"bridge_offer",ms:Date.now()-startedAt,nodeId:call.media_node_id,
        bridgeStatus:error instanceof MediaBridgeError?error.status:null,
        reason:error instanceof MediaBridgeError?null:`${(error as Error)?.name}: ${String((error as Error)?.message)}`.slice(0,200)},
        {callId:id,userId:p.user.id,level:"warn"});
      fail(
        503,
        "MEDIA_BRIDGE_UNAVAILABLE",
        "Media bridge did not accept the offer",
      );
    }
    try {
      await authorizeUserMedia(db,config,p,id,bridge,mediaProbes,call.media_node_id);
    } catch (error) {
      await requestMediaClose(db,bridge,id);
      throw error;
    }
    return answer;
  });
  app.post("/api/v1/gateway/calls/:callId/media/options", async (req) => {
    const p = requireDevice(req);
    const { callId } = z.object({ callId: z.uuid() }).parse(req.params);
    const body=z.object({transport:z.enum(["udp","tls"]).default("udp"),relay:z.boolean().optional(),nodeId:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),capture:z.object({deviceCallId:z.string().min(1).max(200),telecomCreationTimeMillis:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).optional()}).default({transport:"udp"}).parse(req.body);
    const earlyMediaOnly=config.PIXEL_ARCHIVE_ENABLED&&!body.capture;
    if(earlyMediaOnly&&!config.EARLY_MEDIA_ENABLED)fail(409,"CAPTURE_BINDING_REQUIRED","Gateway must provide a durable recording capture identity");
    const bridge=requireMediaBridge(media);
    let call;
    try {
      call=await authorizeGatewayMedia(db,config,p.gatewayId,callId,bridge,mediaProbes,body.nodeId,body.capture,earlyMediaOnly);
    } catch (error) {
      logGatewayMediaFailure(req,"options",callId,error);
      throw error;
    }
    const ice=relayIce(config,bridge.iceServers(call.media_node_id,body.transport),body,call.media_node_id);
    return {mediaNodeId:call.media_node_id,mediaEpoch:Number(call.media_epoch),...(call.captureBinding?{captureBinding:call.captureBinding}:{}),
      iceServers:ice.iceServers,iceTransportPolicy:"relay",...ice.relayField};
  });
  app.post("/api/v1/gateway/calls/:callId/media/offer", async (req) => {
    const p = requireDevice(req);
    const { callId } = z.object({ callId: z.uuid() }).parse(req.params);
    const offer = offerBody.parse(req.body);
    const bridge=requireMediaBridge(media);
    let call;
    try {
      call=await authorizeGatewayMedia(db,config,p.gatewayId,callId,bridge,mediaProbes);
    } catch (error) {
      logGatewayMediaFailure(req,"offer_authorize",callId,error);
      throw error;
    }
    let answer;
    try {
      // S75c: the call's own gateway (authorizeGatewayMedia) always owns the gateway leg.
      answer = await bridge.offer(call.media_node_id,callId,"gateway",offer,Number(call.media_epoch),true);
    } catch (error) {
      logGatewayMediaFailure(req,"bridge_offer",callId,error);
      fail(
        503,
        "MEDIA_BRIDGE_UNAVAILABLE",
        "Media bridge did not accept the offer",
      );
    }
    try {
      await authorizeGatewayMedia(db,config,p.gatewayId,callId,bridge,mediaProbes,call.media_node_id);
    } catch (error) {
      logGatewayMediaFailure(req,"offer_recheck",callId,error);
      await requestMediaClose(db, bridge, callId);
      throw error;
    }
    return answer;
  });
}

/** S22 forensics: the gateway only logs "setup_failed", so the refusing side and its code must be visible here. */
function logGatewayMediaFailure(req:{log:{warn:(obj:Record<string,unknown>,msg:string)=>void;info:(obj:Record<string,unknown>,msg:string)=>void}},stage:string,callId:string,error:unknown){
  const e=error as {status?:unknown;code?:unknown;message?:unknown};
  // S69: MEDIA_NODE_PENDING is the normal race with the winning client, not a failure.
  (e?.code==="MEDIA_NODE_PENDING"?req.log.info.bind(req.log):req.log.warn.bind(req.log))({
    stage,callId,
    status:typeof e?.status==="number"?e.status:undefined,
    code:typeof e?.code==="string"?e.code:undefined,
    bridgeStatus:error instanceof MediaBridgeError?error.status:undefined,
    message:typeof e?.message==="string"?e.message.slice(0,200):undefined,
  },"gateway_media_setup_failed");
}

function registerAdminRoutes(app: FastifyInstance, db: Db, config: Config) {
  app.get("/api/v1/admin/users", async (req) => {
    requireAdmin(req);
    const q = await db.query(
      `SELECT id,email username,role,created_at FROM users ORDER BY email`,
    );
    return {
      items: q.rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        createdAt: r.created_at,
      })),
    };
  });
  app.get("/api/v1/admin/gateways", async (req) => {
    requireAdmin(req);
    const q = await db.query(
      `SELECT id,name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at,device_epoch,command_sequence,time_zone,kind FROM gateways ORDER BY name`,
    );
    return {
      items: q.rows.map((r) => ({
        id: r.id,
        name: r.name,
        controlEnabled: r.control_enabled,
        telephonyReady: r.telephony_ready,
        smsReady: r.sms_ready,
        mediaReady: r.media_ready,
        lastSeenAt: r.last_seen_at,
        deviceEpoch: Number(r.device_epoch),
        serverSequence: Number(r.command_sequence),
        timeZone: r.time_zone,
        kind: r.kind,
      })),
    };
  });
  app.get("/api/v1/admin/sims", async (req) => {
    requireAdmin(req);
    const availability=await settingsAvailability(db,config);
    const q = await db.query(
      `SELECT s.id,s.gateway_id,s.slot_index,s.owner_user_id,s.label,s.phone_label,s.country_iso,s.embedded,s.version,s.assignment_pending,s.device_present,
              st.mode,st.timeout_seconds,st.version settings_version,st.applied_version
       FROM sims s JOIN sim_settings st ON st.sim_id=s.id ORDER BY s.gateway_id,s.slot_index`,
    );
    return {
      items: q.rows.map((r) => ({
        id: r.id,
        gatewayId: r.gateway_id,
        slotIndex: r.slot_index,
        ownerUserId: r.owner_user_id,
        label: r.label,
        phoneLabel: r.phone_label,
        countryIso: r.country_iso,
        embedded: r.embedded,
        version: Number(r.version),
        assignmentPending: r.assignment_pending,
        present: r.device_present,
        settings: settingsDto(r, availability),
      })),
    };
  });
  app.post("/api/v1/admin/gateways", async (req, reply) => {
    const p = requireAdmin(req);
    mutationOrigin(req, config);
    const b = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const q = await db.query(
      `INSERT INTO gateways(name)VALUES($1)RETURNING id,name,control_enabled`,
      [b.name],
    );
    await db.query(
      `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id)VALUES($1,'gateway.create','gateway',$2)`,
      [p.user.id, q.rows[0].id],
    );
    return reply.code(201).send({
      gateway: {
        id: q.rows[0].id,
        name: q.rows[0].name,
        online: false,
        controlEnabled: false,
      },
    });
  });
  app.delete("/api/v1/admin/gateways/:gatewayId", async (req, reply) => {
    const p = requireAdmin(req);
    mutationOrigin(req, config);
    const { gatewayId } = z.object({ gatewayId: z.uuid() }).parse(req.params);
    await tx(db, async (c) => {
      const locked = await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [gatewayId]);
      if (!locked.rowCount) fail(404, "NOT_FOUND", "Gateway not found");
      const inUse = await c.query(
        `SELECT (
           EXISTS(SELECT 1 FROM call_records WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM gateway_call_locks WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM commands WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM media_close_jobs j JOIN call_records cr ON cr.id=j.call_id WHERE cr.gateway_id=$1 AND j.completed_at IS NULL) OR
           EXISTS(SELECT 1 FROM sms_messages WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM ai_call_runs WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM recording_capture_bindings WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM pixel_recording_archives WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM gateway_command_replay_horizons WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM gateway_command_replay_audits WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM gateway_command_replay_migrations WHERE gateway_id=$1) OR
           EXISTS(SELECT 1 FROM gateway_command_replay_receipts r JOIN commands cmd ON cmd.id=r.command_id WHERE cmd.gateway_id=$1)
         ) in_use`,
        [gatewayId],
      );
      if (inUse.rows[0].in_use)
        fail(409, "GATEWAY_IN_USE", "Gateway still has calls, commands, or replay history");
      await c.query(
        `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id)VALUES($1,'gateway.delete','gateway',$2)`,
        [p.user.id, gatewayId],
      );
      await c.query(`DELETE FROM gateways WHERE id=$1`, [gatewayId]);
    });
    return reply.code(204).send();
  });
  app.post(
    "/api/v1/admin/gateways/:gatewayId/pairing-codes",
    async (req, reply) => {
      const p = requireAdmin(req);
      mutationOrigin(req, config);
      const { gatewayId } = z.object({ gatewayId: z.uuid() }).parse(req.params);
      const exists = await db.query(`SELECT 1 FROM gateways WHERE id=$1`, [
        gatewayId,
      ]);
      if (!exists.rowCount) fail(404, "NOT_FOUND", "Gateway not found");
      const code = opaqueToken(24);
      const q = await db.query(
        `INSERT INTO device_pairing_codes(gateway_id,code_hash,expires_at,created_by)VALUES($1,$2,now()+interval '10 minutes',$3)RETURNING id,expires_at`,
        [gatewayId, tokenHash(code), p.user.id],
      );
      return reply.code(201).send({
        pairingCode: {
          id: q.rows[0].id,
          code,
          expiresAt: q.rows[0].expires_at,
        },
      });
    },
  );
  app.put("/api/v1/admin/sims/:simId/owner", async (req) => {
    const p = requireAdmin(req);
    mutationOrigin(req, config);
    const { simId } = z.object({ simId: z.uuid() }).parse(req.params);
    const b = z
      .object({
        ownerUserId: z.uuid().nullable(),
        expectedVersion: z.number().int().positive(),
      })
      .parse(req.body);
    return tx(db, async (c) => {
      const target = await c.query(`SELECT gateway_id FROM sims WHERE id=$1`, [
        simId,
      ]);
      if (!target.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [
        target.rows[0].gateway_id,
      ]);
      const locked = await c.query(
        `SELECT s.*,EXISTS(SELECT 1 FROM gateway_call_locks l WHERE l.gateway_id=s.gateway_id) busy FROM sims s WHERE s.id=$1 FOR UPDATE`,
        [simId],
      );
      if (!locked.rowCount) fail(404, "NOT_FOUND", "SIM not found");
      if (!locked.rows[0].device_present)
        fail(409, "SIM_ABSENT", "Cannot assign an absent SIM");
      if (locked.rows[0].busy)
        fail(
          409,
          "GATEWAY_BUSY",
          "Ownership cannot change during an active or uncertain call",
        );
      const q = await c.query(
        `UPDATE sims SET owner_user_id=$2,assignment_pending=false,version=version+1 WHERE id=$1 AND version=$3 RETURNING id,owner_user_id,version`,
        [simId, b.ownerUserId, b.expectedVersion],
      );
      if (!q.rowCount)
        fail(
          409,
          "VERSION_CONFLICT",
          "SIM assignment changed on another client",
        );
      await c.query(
        `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)VALUES($1,'sim.owner.update','sim',$2,$3)`,
        [
          p.user.id,
          simId,
          JSON.stringify({
            previousOwnerUserId: locked.rows[0].owner_user_id,
            ownerUserId: b.ownerUserId,
          }),
        ],
      );
      return {
        sim: {
          id: q.rows[0].id,
          ownerUserId: q.rows[0].owner_user_id,
          version: Number(q.rows[0].version),
        },
      };
    });
  });
}

function registerGatewayRoutes(
  app: FastifyInstance,
  db: Db,
  config:Config,
  media: MediaNodeRegistry | null,
  commandDoorbell: CommandDoorbell,
  doorbellMaxHoldMs: number,
  standbyDoorbell: CommandDoorbell,
  standbyMaxHoldMs: number,
  kickPush: () => void,
) {
  const ringDoorbell=(gatewayId:string|null|undefined)=>{if(gatewayId)commandDoorbell.notify(gatewayId);};
  // S29 §2.2: in-memory only. Counts consecutive heartbeats in which the same replay proposal is
  // re-offered to a device that has not moved its blocking floor, so a gateway that refuses the
  // range (S30) shows up in the log instead of stalling the horizon silently forever.
  const replayProposalStalls=replayProposalStallTracker();
  // S69: last 20 heartbeat intervals per gateway, for the adaptive `gateway.heartbeat_gap` threshold.
  const heartbeatIntervals=new Map<string,number[]>();
  const powerResultBody=z.object({
    desired:z.enum(["on","off"]),
    ok:z.boolean(),
    reason:z.string().max(120).nullish(),
    at:z.string().refine((v)=>Number.isFinite(Date.parse(v)),"Invalid at"),
  });
  /**
   * S21 §D standby beacon. The single controlled exception to "OFF means zero outbound
   * connections": device credentials only, no telephony/SIM/media payload, and `last_seen_at` is
   * never touched so the phone cannot appear online while its control switch is off.
   */
  app.post("/api/v1/gateway/standby", async (req, reply) => {
    const p = requireDevice(req);
    const b = z
      .object({
        holdMs: z.number().int().min(0).max(GATEWAY_STANDBY_HARD_CAP_MS).optional(),
        remotePowerAllowed: z.boolean(),
        lastPowerResult: powerResultBody.optional(),
      })
      .parse(req.body);
    await recordStandby(db, p.gatewayId, {
      remotePowerAllowed: b.remotePowerAllowed,
      lastPowerResult: b.lastPowerResult ? { ...b.lastPowerResult, reason: b.lastPowerResult.reason ?? null } : null,
    });
    // Registration strictly precedes the consume attempt, exactly like the command doorbell: an
    // intent written between the read and the wait still wakes this request.
    const waiter = standbyDoorbell.listen(p.gatewayId);
    try {
      // Consume-on-delivery: taking the intent clears it, so a gateway whose enable gate refuses
      // cannot hot-loop on the same request.
      if (await consumeDesiredPower(db, p.gatewayId, "on")) return { desiredPower: "on", heldMs: 0 };
      const hold = Math.min(b.holdMs ?? standbyMaxHoldMs, standbyMaxHoldMs);
      if (hold <= 0) return { desiredPower: null, heldMs: 0 };
      const startedAt = Date.now();
      const woken = await waiter.wait(hold, reply.raw, req.raw.socket);
      const desiredPower = woken && (await consumeDesiredPower(db, p.gatewayId, "on")) ? "on" : null;
      return { desiredPower, heldMs: Date.now() - startedAt };
    } finally {
      waiter.dispose();
    }
  });
  app.post("/api/v1/gateway/pair", async (req, reply) => {
    const b = z
      .object({ code: z.string().min(20), label: z.string().min(1).max(120) })
      .parse(req.body);
    const secret = opaqueToken();
    const value = await tx(db, async (c) => {
      const q = await c.query(
        `UPDATE device_pairing_codes SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING gateway_id`,
        [tokenHash(b.code)],
      );
      if (!q.rowCount)
        fail(
          400,
          "PAIRING_CODE_INVALID",
          "Pairing code is expired, consumed, or invalid",
        );
      const gatewayId = q.rows[0].gateway_id;
      const openCalls = await c.query(
        `SELECT id FROM call_records WHERE gateway_id=$1 AND state NOT IN ('ended','failed')`,
        [gatewayId],
      );
      const g = await c.query(
        `UPDATE gateways SET device_epoch=device_epoch+1,command_sequence=0,control_enabled=false,telephony_ready=false,sms_ready=false,media_ready=false,last_seen_at=NULL WHERE id=$1 RETURNING device_epoch`,
        [gatewayId],
      );
      await c.query(
        `UPDATE device_credentials SET revoked_at=now() WHERE gateway_id=$1 AND revoked_at IS NULL`,
        [gatewayId],
      );
      await c.query(
        `UPDATE commands SET status='rejected',result='{"reason":"device_repaired"}' WHERE gateway_id=$1 AND status='pending'`,
        [gatewayId],
      );
      await c.query(
        `INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,
        [gatewayId, tokenHash(secret), b.label],
      );
      return {
        gatewayId,
        deviceEpoch: Number(g.rows[0].device_epoch),
        closeCallIds: openCalls.rows.map((row) => row.id as string),
      };
    });
    await Promise.all(
      value.closeCallIds.map((callId) => requestMediaClose(db, media, callId)),
    );
    return reply.code(201).send({
      deviceToken: secret,
      gateway: { id: value.gatewayId, deviceEpoch: value.deviceEpoch },
    });
  });
  app.post("/api/v1/gateway/sims/sync", async (req) => {
    const p = requireDevice(req);
    const b = z
      .object({
        items: z
          .array(
            z.object({
              slotIndex: z.number().int().min(0).max(7),
              subscriptionId: z.number().int().nullable(),
              phoneAccountHandle: z.string().max(500).nullable(),
              iccidFingerprint: z.string().min(16).max(256),
              countryIso: z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).nullable().optional(),
              embedded: z.boolean().nullable().optional(),
              legacyIccidFingerprint: z.string().min(16).max(256).optional(),
              phoneNumber: z.string().regex(/^\+?[0-9]{3,20}$/).optional(),
            }),
          )
          .max(8),
      })
      .superRefine((value, ctx) => {
        const seenSlots = new Set<number>();
        const seenFingerprints = new Set<string>();
        value.items.forEach((item, index) => {
          if (seenSlots.has(item.slotIndex))
            ctx.addIssue({
              code: "custom",
              path: ["items", index, "slotIndex"],
              message: "Duplicate slotIndex in one snapshot",
            });
          if (seenFingerprints.has(item.iccidFingerprint))
            ctx.addIssue({
              code: "custom",
              path: ["items", index, "iccidFingerprint"],
              message: "Duplicate iccidFingerprint in one snapshot",
            });
          seenSlots.add(item.slotIndex);
          seenFingerprints.add(item.iccidFingerprint);
        });
      })
      .parse(req.body);
    return tx(db, async (c) => {
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [
        p.gatewayId,
      ]);
      const busy = !!(
        await c.query(`SELECT 1 FROM gateway_call_locks WHERE gateway_id=$1`, [
          p.gatewayId,
        ])
      ).rowCount;
      const existing = await c.query(
        `SELECT * FROM sims WHERE gateway_id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      const rows = [...existing.rows];
      const byProtectedHash = new Map(
        rows
          .filter((row) => !!row.protected_iccid_hash)
          .map((row) => [row.protected_iccid_hash as string, row]),
      );
      const targets = [];
      const createdIds = new Set<string>();
      const movedFrom = new Map<string, any>();
      for (const reported of b.items) {
        const protectedHash = tokenHash(reported.iccidFingerprint);
        let row = byProtectedHash.get(protectedHash);
        if (!row) {
          // S65: the same physical SIM moved here from another gateway; the row follows the card.
          // ponytail: locks the other gateway's row without its gateway lock; two gateways swapping cards in the same instant can deadlock (Postgres aborts one, the gateway resyncs).
          const other = (await c.query(`SELECT * FROM sims WHERE protected_iccid_hash=$1 AND gateway_id<>$2 FOR UPDATE`, [protectedHash, p.gatewayId])).rows[0];
          if (other) { row = other; movedFrom.set(other.id, other); byProtectedHash.set(protectedHash, other); }
        }
        const legacyHash = reported.legacyIccidFingerprint ? tokenHash(reported.legacyIccidFingerprint) : null;
        const legacy = !row && legacyHash ? byProtectedHash.get(legacyHash) : undefined;
        if (legacy) {
          // S65: Pixel moved from its per-device HMAC to the portable ICCID digest; rehash in place, keep id/owner/settings.
          await c.query(`UPDATE sims SET protected_iccid_hash=$2 WHERE id=$1`, [legacy.id, protectedHash]);
          legacy.protected_iccid_hash = protectedHash;
          byProtectedHash.delete(legacyHash!);
          byProtectedHash.set(protectedHash, legacy);
          row = legacy;
        }
        if (!row) {
          row = (
            await c.query(
              `INSERT INTO sims(gateway_id,slot_index,label,protected_iccid_hash,country_iso,embedded,device_present)
               VALUES($1,NULL,$2,$3,$4,$5,false) RETURNING *`,
              [p.gatewayId, `SIM ${reported.slotIndex + 1}`, protectedHash, reported.countryIso ?? null, reported.embedded ?? null],
            )
          ).rows[0];
          await c.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`, [row.id]);
          rows.push(row);
          byProtectedHash.set(protectedHash, row);
          createdIds.add(row.id);
        }
        targets.push({ reported, protectedHash, row });
      }
      const targetById = new Map(targets.map((target) => [target.row.id as string, target]));
      const omittedIds: string[] = [];
      const changedExistingIds: string[] = [];
      for (const row of rows) {
        if (!row.device_present) continue;
        const target = targetById.get(row.id);
        if (!target) omittedIds.push(row.id);
        else if (
          row.slot_index !== target.reported.slotIndex ||
          row.subscription_id !== target.reported.subscriptionId ||
          row.phone_account_handle !== target.reported.phoneAccountHandle
        ) changedExistingIds.push(row.id);
      }
      const deactivateIds = [...omittedIds, ...changedExistingIds];
      if (deactivateIds.length) {
        // Clear every changing route before activating any target. This makes a
        // two-profile slot swap compatible with the partial active-slot index.
        await c.query(
          `UPDATE sims SET device_present=false,slot_index=NULL,subscription_id=NULL,phone_account_handle=NULL
           WHERE id=ANY($1::uuid[])`,
          [deactivateIds],
        );
      }
      if (omittedIds.length) {
        await c.query(`UPDATE sims SET version=version+1 WHERE id=ANY($1::uuid[])`, [omittedIds]);
      }
      const items = [];
      const routeChangedIds = new Set(changedExistingIds);
      for (const target of targets) {
        const current = target.row;
        const moved = movedFrom.has(current.id);
        const routeChanged = !createdIds.has(current.id) && (
          moved || !current.device_present ||
          current.slot_index !== target.reported.slotIndex ||
          current.subscription_id !== target.reported.subscriptionId ||
          current.phone_account_handle !== target.reported.phoneAccountHandle
        );
        const metadataChanged = !createdIds.has(current.id) && (
          current.country_iso !== (target.reported.countryIso ?? null) ||
          current.embedded !== (target.reported.embedded ?? null)
        );
        const active = (
          await c.query(
            `UPDATE sims SET slot_index=$2,subscription_id=$3,phone_account_handle=$4,country_iso=$5,embedded=$6,device_present=true,
                    version=version+CASE WHEN $7 THEN 1 ELSE 0 END,gateway_id=$8,
                    phone_label=CASE WHEN COALESCE(phone_label,'')='' THEN COALESCE($9,phone_label) ELSE phone_label END
             WHERE id=$1 RETURNING id,label,version,assignment_pending,owner_user_id`,
            [
              current.id,
              target.reported.slotIndex,
              target.reported.subscriptionId,
              target.reported.phoneAccountHandle,
              target.reported.countryIso ?? null,
              target.reported.embedded ?? null,
              routeChanged || metadataChanged,
              p.gatewayId,
              target.reported.phoneNumber ?? null,
            ],
          )
        ).rows[0];
        if (routeChanged) {
          routeChangedIds.add(current.id);
          await c.query(
            `INSERT INTO audit_events(action,resource_type,resource_id,details)
             VALUES('sim.route.changed','sim',$1,$2)`,
            [current.id, JSON.stringify({ previousSlotIndex: current.slot_index, slotIndex: target.reported.slotIndex, activeCallLockRetained: busy })],
          );
        }
        // ponytail: if the old gateway still reports the card present, the latest report wins.
        if (moved)
          await c.query(
            `INSERT INTO audit_events(action,resource_type,resource_id,details)
             VALUES('sim.gateway.moved','sim',$1,$2)`,
            [current.id, JSON.stringify({ fromGatewayId: current.gateway_id, toGatewayId: p.gatewayId, previousDevicePresent: current.device_present })],
          );
        if (moved) diag(db, "sim.moved", { simId: current.id, fromGatewayId: current.gateway_id, toGatewayId: p.gatewayId });
        items.push({
          id: active.id,
          slotIndex: target.reported.slotIndex,
          subscriptionId: target.reported.subscriptionId,
          phoneAccountHandle: target.reported.phoneAccountHandle,
          countryIso: target.reported.countryIso ?? null,
          embedded: target.reported.embedded ?? null,
          label: active.label,
          version: Number(active.version),
          assignmentVersion: Number(active.version),
          present: true,
          assignmentPending: active.assignment_pending,
          needsOwnerAssignment: !active.owner_user_id || active.assignment_pending,
          routable: !!active.owner_user_id && !active.assignment_pending,
          iccidFingerprint: target.reported.iccidFingerprint,
        });
      }
      const affectedIds = [...new Set([...omittedIds, ...routeChangedIds])];
      if (affectedIds.length) {
        await c.query(
          `UPDATE commands SET status='rejected',result='{"reason":"sim_route_changed"}'
           WHERE sim_id=ANY($1::uuid[]) AND status='pending'
             AND kind IN ('dial','answer','send_sms','apply_sim_settings')`,
          [affectedIds],
        );
        await c.query(
          `UPDATE commands cmd SET status='rejected',result='{"reason":"sim_route_changed"}' FROM call_records call WHERE cmd.call_id=call.id AND call.sim_id=ANY($1::uuid[]) AND cmd.status='pending' AND cmd.kind IN ('dial','answer')`,
          [affectedIds],
        );
        await c.query(
          `UPDATE commands cmd SET status='rejected',result='{"reason":"sim_route_changed"}' FROM sms_messages sms WHERE cmd.sms_id=sms.id AND sms.sim_id=ANY($1::uuid[]) AND cmd.status='pending' AND cmd.kind='send_sms'`,
          [affectedIds],
        );
        await c.query(
          `UPDATE call_records SET state='unknown',failure_reason='sim_route_changed_during_pending_command' WHERE sim_id=ANY($1::uuid[]) AND state='outgoing_pending'`,
          [affectedIds],
        );
        await c.query(
          `UPDATE sms_messages m SET state=CASE WHEN EXISTS(SELECT 1 FROM sms_dispatch_queue q WHERE q.sms_id=m.id AND q.released_at IS NULL) THEN 'failed'::sms_state ELSE 'unknown'::sms_state END,failure_reason='sim_route_changed_during_pending_command' WHERE sim_id=ANY($1::uuid[]) AND state IN ('queued','sending') RETURNING id`,
          [affectedIds],
        ).then(async (r) => { await smsFailed(c, r.rows.map((row) => row.id)); });
      }
      return { items };
    });
  });
  app.post("/api/v1/gateway/calls/incoming", async (req, reply) => {
    const startedAt = Date.now();
    const p = requireDevice(req);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        deviceCallId: z.string().min(1).max(200),
        simId: z.uuid(),
        remoteNumber: z.string().max(64).nullable().optional(),
        observedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), "Invalid observedAt"),
        // S21 §B: the gateway already rejected this call locally. Control records it and stops there.
        blockedLocally: z.boolean().optional(),
        // S38: the Pixel's own screening app hung up before the gateway ever saw the call. Only
        // meaningful together with `blockedLocally`; everything else is the S21 §B path.
        blockSource: z.literal("phone").optional(),
        // S86: label of the third-party screening app that blocked it; the number joins the call blocklist.
        screeningApp: z.string().trim().min(1).max(64).optional(),
      })
      .parse(req.body);
    const fingerprint = requestFingerprint(b);
    let doorbellGatewayId: string | null = null;
    // S24 决策 3: set when the owner's AI voice provider has no live worker. The call then rings
    // normally; the skip is only observable here, in device_events and in the warn log below.
    let aiSkippedProvider: string | null = null;
    const value = await tx(db, async (c) => {
      const gateway = await c.query(
        `SELECT device_epoch,command_sequence FROM gateways WHERE id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      if (Number(gateway.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");

      // The one place that turns "Control decided to drop this call" into a device command:
      // the Control-side block (S21 §B) and the S38 busy auto-reject issue the identical hangup.
      const queueHangup = async (callId: string) => {
        const sequence = Number(gateway.rows[0].command_sequence) + 1;
        await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [p.gatewayId, sequence]);
        await c.query(
          `INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at)
           VALUES($1,$2,$3,$4,'hangup',$5,now()+interval '15 seconds')`,
          [p.gatewayId, callId, b.generation, sequence, JSON.stringify({ callId, deviceCallId: b.deviceCallId })],
        );
        doorbellGatewayId = p.gatewayId;
      };
      const prior = await c.query(
        `SELECT event_type,resource_id,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        const saved = prior.rows[0];
        if (
          saved.event_type !== "call.incoming" ||
          saved.payload?.requestFingerprint !== fingerprint
        )
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        const response = saved.payload.response as {
          disposition: "offer_to_owner" | "local_only" | "dropped_blocked" | "rejected_busy";
          callId?: string;
        };
        const call = response.callId && response.disposition !== "dropped_blocked"
          ? (
              await c.query(
                `SELECT * FROM call_records WHERE id=$1 AND gateway_id=$2`,
                [response.callId, p.gatewayId],
              )
            ).rows[0]
          : undefined;
        return { replayed: true, disposition: response.disposition, call };
      }

      const sim = await c.query(
        `SELECT s.*,st.mode,st.timeout_seconds,st.version settings_version FROM sims s LEFT JOIN sim_settings st ON st.sim_id=s.id
         WHERE s.id=$1 AND s.gateway_id=$2 AND s.device_present AND NOT s.assignment_pending FOR UPDATE OF s`,
        [b.simId, p.gatewayId],
      );
      // S21 §B: `blockedLocally` is the gateway reporting a call it already rejected itself. It is
      // terminal at creation — no device lock, no pending command, no hangup, no push, no AI run,
      // and no snapshot reconciliation — so Control must not re-derive the decision here.
      const blockedLocally = b.blockedLocally === true;
      // The owner's live calls, read once: S72 finds this call's other leg here (an internal call) and
      // S38 decides the busy conflict from the rest. S71b: the owner's own outgoing call to *this* SIM
      // is recognised by its callee SIM, its callee being this SIM's number, or (SIM number unknown)
      // by the caller ID here being the dialing SIM's number — all compared as S55 keys. A matching
      // outgoing leg is never a busy conflict; it is linked only when it is on another gateway and
      // not linked yet (same device is still rejected as busy below; D5 stops client-dialed ones).
      let busyOwner: boolean | null = null;
      let peerLeg: any = null, linkReason = "";
      const replayedCall = !!(await c.query(
        `SELECT 1 FROM call_records WHERE gateway_id=$1 AND generation=$2 AND device_call_id=$3`,
        [p.gatewayId, b.generation, b.deviceCallId],
      )).rowCount;
      if (!blockedLocally && !replayedCall && sim.rowCount && sim.rows[0].owner_user_id) {
        const s = sim.rows[0];
        const ownKey = await callCanonicalKeyFor(c, s.owner_user_id, s.phone_label, s.country_iso);
        const callerKey = await callCanonicalKeyFor(c, s.owner_user_id, b.remoteNumber ?? null, s.country_iso);
        const liveCalls = (
          await c.query(
            `SELECT cr.id,cr.sim_id,cr.gateway_id,cr.direction,cr.state,cr.remote_canonical_key,cr.peer_call_id,cr.peer_sim_id,cr.answered_by_platform,os.phone_label,os.country_iso
             FROM call_records cr LEFT JOIN sims os ON os.id=cr.sim_id
             WHERE cr.snapshot_owner_id=$1 AND cr.state IN ('outgoing_pending','connecting','active','ending')
             ORDER BY cr.started_at DESC`,
            [s.owner_user_id],
          )
        ).rows;
        for (const r of liveCalls) {
          const match = r.direction !== "outgoing" ? "" : r.peer_sim_id === s.id ? "callee_sim"
            : ownKey && r.remote_canonical_key === ownKey ? "callee_number"
            : callerKey && (await callCanonicalKeyFor(c, s.owner_user_id, r.phone_label, r.country_iso)) === callerKey ? "caller_id" : "";
          if (match) {
            if (!peerLeg && !r.peer_call_id && r.state !== "ending") { peerLeg = r; linkReason = match; }
            continue;
          }
          // S38 忙线冲突: an AI-answered call never counts — AI hands the SIM back by itself.
          if (config.BUSY_CONFLICT_ENABLED && r.answered_by_platform !== "ai")
            busyOwner = busyOwner === true || r.gateway_id === p.gatewayId;
        }
      }
      const internal = !!peerLeg;
      // S72: both legs point at each other. The outgoing side is claimed first so two incoming
      // reports can never both link to it.
      const linkPeer = async (callId: string) => {
        if (!peerLeg) return;
        const linked = await c.query(
          `UPDATE call_records SET internal_call=true,peer_call_id=$2,peer_sim_id=COALESCE(peer_sim_id,$3) WHERE id=$1 AND peer_call_id IS NULL RETURNING id`,
          [peerLeg.id, callId, b.simId],
        );
        if (!linked.rowCount) return;
        await c.query(`UPDATE call_records SET peer_call_id=$2 WHERE id=$1`, [callId, peerLeg.id]);
        // S75: one row per leg. Inside the transaction on purpose: a deadlock retry may repeat it, harmlessly.
        diag(db, "call.internal_linked", { peerCallId: peerLeg.id, reason: linkReason }, { callId });
        diag(db, "call.internal_linked", { peerCallId: callId, reason: linkReason }, { callId: peerLeg.id });
      };
      if (sim.rowCount && sim.rows[0].owner_user_id && (blockedLocally ||
        // S72 B3: an internal call never goes through the owner's call blocklist.
        (!internal && await ownerBlocksRemote(c, sim.rows[0].owner_user_id, "call", b.remoteNumber ?? null, sim.rows[0].country_iso)))) {
        const existingBlocked = await c.query(
          `SELECT * FROM call_records WHERE gateway_id=$1 AND generation=$2 AND device_call_id=$3`,
          [p.gatewayId, b.generation, b.deviceCallId],
        );
        let call = existingBlocked.rows[0];
        if (!call) {
          call = (
            await c.query(
              `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,device_call_id,observed_at,started_at,ended_at,failure_reason,blocked_source,gateway_time_zone,remote_canonical_key)
               VALUES($1,$2,$3,'incoming',$4,'failed',$5,$6,$7,$8,$8,$8,'number_blocked',$9,(SELECT time_zone FROM gateways WHERE id=$1),$10) RETURNING *`,
              [
                p.gatewayId,
                sim.rows[0].id,
                sim.rows[0].owner_user_id,
                b.remoteNumber ?? null,
                b.generation,
                sim.rows[0].mode ?? "normal",
                b.deviceCallId,
                b.observedAt,
                blockedLocally ? b.blockSource ?? "gateway" : "control",
                await callCanonicalKeyFor(c, sim.rows[0].owner_user_id, b.remoteNumber ?? null, sim.rows[0].country_iso),
              ],
            )
          ).rows[0];
          // The device already hung up on its own; issuing a hangup would race a call that no
          // longer exists and burn a command sequence for nothing.
          if (!blockedLocally) await queueHangup(call.id);
          // S86: equivalence dedupe as in POST /api/v1/blocklist; emergency numbers have no key.
          const screenKey = blockedLocally && b.screeningApp && config.SCREENING_APP_AUTO_BLOCK_ENABLED
            ? canonicalBlocklistKey(b.remoteNumber) : null;
          const owner = sim.rows[0].owner_user_id;
          if (screenKey) {
            const listed = (await loadBlockedCandidates(c, owner, "call", [screenKey]))
              .some((row) => blocklistKeysOverlap([screenKey], [row.canonical_key]));
            const inserted = !listed && !!(await c.query(
              `INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,source,source_gateway_id,source_call_id,scope)
               VALUES($1,$2,$3,'phone',$4,$5,'call') ON CONFLICT(owner_user_id,scope,canonical_key) DO NOTHING`,
              [owner, screenKey, b.remoteNumber, p.gatewayId, call.id],
            )).rowCount;
            if (inserted) await bumpOwnerBlocklistRevision(c, owner);
            diag(db, "blocklist.screening_auto_add", { inserted, screeningApp: b.screeningApp }, { callId: call.id, userId: owner });
          }
        }
        await c.query(
          `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
           VALUES($1,$2,'call.incoming',$3,$4)`,
          [
            p.gatewayId,
            b.eventId,
            call.id,
            JSON.stringify({
              requestFingerprint: fingerprint,
              response: { disposition: "dropped_blocked", callId: call.id },
            }),
          ],
        );
        return { replayed: false, disposition: "dropped_blocked" as const, call: undefined };
      }
      if (blockedLocally) {
        // No owner to show it to: the report is still idempotent, but nothing is persisted about
        // the number, exactly like the unassigned-SIM path.
        await c.query(
          `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
           VALUES($1,$2,'call.incoming',$1,$3)`,
          [p.gatewayId, b.eventId, JSON.stringify({ requestFingerprint: fingerprint, response: { disposition: "dropped_blocked" } })],
        );
        return { replayed: false, disposition: "dropped_blocked" as const, call: undefined };
      }
      const existingCall = await c.query(
        `SELECT * FROM call_records WHERE gateway_id=$1 AND generation=$2 AND device_call_id=$3`,
        [p.gatewayId, b.generation, b.deviceCallId],
      );
      const hasServerCall = !!(
        await c.query(`SELECT 1 FROM gateway_call_locks WHERE gateway_id=$1`, [
          p.gatewayId,
        ])
      ).rowCount;
      // S22 forensics (2026-09-11 17:51 UTC): the gateway snapshots on every heartbeat, and a snapshot
      // taken between Telecom NEW and the InCallService bind carries `localBusy=true` with no journaled
      // call, i.e. the very call that is about to be reported here. Treating that as "busy with another
      // local call" silently downgraded an AI 即接 call to local_only. The device is only busy for this
      // decision when its last snapshot lists a *different* device call; a busy flag without any listed
      // call is the transient pre-bind state (or this call itself once journaled).
      const lastTelecom = (
        await c.query(
          `SELECT local_busy,calls FROM gateway_telecom_snapshots WHERE gateway_id=$1 AND generation=$2`,
          [p.gatewayId, b.generation],
        )
      ).rows[0];
      const telecomBusy =
        !!lastTelecom &&
        lastTelecom.local_busy === true &&
        Array.isArray(lastTelecom.calls) &&
        lastTelecom.calls.some(
          (reported: any) =>
            typeof reported?.deviceCallId === "string" && reported.deviceCallId !== b.deviceCallId,
        );
      // S38 忙线冲突: `busyOwner` (computed above) is NULL when the owner has no other human call,
      // true when at least one of them is on this very Pixel.
      // Same Pixel (this call cannot ring anyway) -> auto-reject and record it. Another Pixel ->
      // AI answers this one temporarily; the SIM's own mode is never written, so it reverts by itself.
      const busyReject =
        config.BUSY_CONFLICT_ENABLED &&
        !existingCall.rowCount &&
        !!sim.rowCount &&
        !!sim.rows[0].owner_user_id &&
        (busyOwner === true || hasServerCall || telecomBusy);
      // S72 D6: an internal call is never handed to AI for the owner being busy elsewhere.
      const busyAi = !busyReject && busyOwner === false && !internal;
      if (busyReject) {
        const s = sim.rows[0];
        const call = (
          await c.query(
            `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,device_call_id,observed_at,started_at,ended_at,failure_reason,conflict_disposition,gateway_time_zone,remote_canonical_key,internal_call,peer_sim_id)
             VALUES($1,$2,$3,'incoming',$4,'failed',$5,$6,$7,$8,$8,$8,'busy_auto_rejected','rejected',(SELECT time_zone FROM gateways WHERE id=$1),$9,$10,$11) RETURNING *`,
            [
              p.gatewayId,
              s.id,
              s.owner_user_id,
              b.remoteNumber ?? null,
              b.generation,
              internal ? "normal" : s.mode ?? "normal",
              b.deviceCallId,
              b.observedAt,
              await callCanonicalKeyFor(c, s.owner_user_id, b.remoteNumber ?? null, s.country_iso),
              internal,
              peerLeg?.sim_id ?? null,
            ],
          )
        ).rows[0];
        // A device-dialed call between two cards of this very Pixel (D5 stops client-dialed ones).
        await linkPeer(call.id);
        await queueHangup(call.id);
        await c.query(
          `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
           VALUES($1,$2,'call.incoming',$3,$4)`,
          [p.gatewayId, b.eventId, call.id,
            JSON.stringify({ requestFingerprint: fingerprint, response: { disposition: "rejected_busy", callId: call.id } })],
        );
        return { replayed: false, disposition: "rejected_busy" as const, call };
      }
      const localOnly =
        !existingCall.rowCount &&
        (!sim.rowCount || !sim.rows[0].owner_user_id || hasServerCall || telecomBusy);
      let call: any = existingCall.rows[0];
      if (
        call &&
        (call.sim_id !== b.simId || call.remote_number !== (b.remoteNumber ?? null))
      )
        fail(409, "DEVICE_CALL_MISMATCH", "Device call identity changed within one epoch");
      // S38 异机忙线: this call is answered by AI whatever the SIM says, so the mode snapshot the
      // run is built from is 'ai' rather than the SIM's own mode.
      let busyAiRejected = false;
      if (!localOnly && !call) {
        const s = sim.rows[0];
        // S72 D6: an internal call rings as 人工 whatever the SIM's mode, so no AI run is created.
        const mode = internal ? "normal" : busyAi ? "ai" : s.mode ?? "normal";
        call = (
          await c.query(
            `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,device_call_id,observed_at,started_at,gateway_time_zone,remote_canonical_key,conflict_disposition,internal_call,peer_sim_id)
             VALUES($1,$2,$3,'incoming',$4,'incoming_ringing',$5,$6,$7,$8,$8,(SELECT time_zone FROM gateways WHERE id=$1),$9,$10,$11,$12) RETURNING *`,
            [
              p.gatewayId,
              s.id,
              s.owner_user_id,
              b.remoteNumber ?? null,
              b.generation,
              mode,
              b.deviceCallId,
              b.observedAt,
              await callCanonicalKeyFor(c, s.owner_user_id, b.remoteNumber ?? null, s.country_iso),
              busyAi ? "ai_answered" : null,
              internal,
              peerLeg?.sim_id ?? null,
            ],
          )
        ).rows[0];
        await linkPeer(call.id);
        if (peerLeg) call = (await c.query(`SELECT * FROM call_records WHERE id=$1`, [call.id])).rows[0];
        await c.query(
          `INSERT INTO gateway_call_locks(gateway_id,call_id,generation) VALUES($1,$2,$3)`,
          [p.gatewayId, call.id, b.generation],
        );
        const run=await createAiRunForIncoming(c,{
          enabled:config.AI_ENABLED&&config.AI_WORKER_READY&&Boolean(config.AI_INTERNAL_TOKEN),
          callId:call.id,gatewayId:p.gatewayId,ownerId:s.owner_user_id,deviceGeneration:b.generation,
          mediaEpoch:Number(call.media_epoch),mode,settingsVersion:Number(s.settings_version??1),
          assignmentVersion:Number(s.version),timeoutSeconds:Number(s.timeout_seconds??45),observedAt:b.observedAt,
          onProviderUnavailable:({provider})=>{aiSkippedProvider=provider;},
        });
        // AI off or no live worker: ringing this Pixel would collide with the call the owner is on,
        // so the cross-gateway case degrades to the same auto-reject as the same-gateway one.
        if(busyAi&&!run){
          busyAiRejected = true;
          await c.query(
            `UPDATE call_records SET state='failed',failure_reason='busy_auto_rejected',conflict_disposition='rejected',ended_at=$2 WHERE id=$1`,
            [call.id, b.observedAt],
          );
          await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[call.id]);
          await queueHangup(call.id);
        }
        if(run||busyAiRejected)call=(await c.query(`SELECT * FROM call_records WHERE id=$1`,[call.id])).rows[0];
      }
      if (localOnly)
        await c.query(
          `INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)
           VALUES($1,$2,$3,0,0,true,'[]',$4)
           ON CONFLICT(gateway_id) DO UPDATE SET generation=excluded.generation,snapshot_id=excluded.snapshot_id,
             snapshot_sequence=CASE WHEN gateway_telecom_snapshots.generation=excluded.generation THEN gateway_telecom_snapshots.snapshot_sequence ELSE 0 END,
             reported_sequence=CASE WHEN gateway_telecom_snapshots.generation=excluded.generation THEN gateway_telecom_snapshots.reported_sequence ELSE 0 END,
             local_busy=true,calls=CASE WHEN gateway_telecom_snapshots.generation=excluded.generation THEN gateway_telecom_snapshots.calls ELSE '[]'::jsonb END,
             observed_at=GREATEST(gateway_telecom_snapshots.observed_at,excluded.observed_at),updated_at=now()`,
          [p.gatewayId, b.generation, b.eventId, b.observedAt],
        );
      const disposition = busyAiRejected ? "rejected_busy" : localOnly ? "local_only" : "offer_to_owner";
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
         VALUES($1,$2,'call.incoming',$3,$4)`,
        [
          p.gatewayId,
          b.eventId,
          call?.id ?? p.gatewayId,
          JSON.stringify({
            requestFingerprint: fingerprint,
            response: { disposition, ...(call ? { callId: call.id } : {}),
              // Additive: the replay path reads only `disposition`/`callId`.
              ...(aiSkippedProvider ? { aiSkipped: "provider_unavailable", voiceProvider: aiSkippedProvider } : {}) },
          }),
        ],
      );
      return { replayed: false, disposition, call };
    });
    if (aiSkippedProvider)
      req.log.warn(
        { gatewayId: p.gatewayId, callId: value.call?.id, provider: aiSkippedProvider },
        "ai_run_skipped provider_unavailable",
      );
    ringDoorbell(doorbellGatewayId);
    if (!value.replayed) {
      if (value.call?.state === "incoming_ringing") kickPush();
      // Never the number: which Pixel, what Control decided, and how long the report took.
      diag(db, "call.incoming", {
        direction: "incoming", gatewayId: p.gatewayId, disposition: value.disposition,
        blocked: value.disposition === "dropped_blocked", ms: Date.now() - startedAt,
      }, { callId: value.call?.id ?? null });
    }
    return reply.code(value.replayed ? 200 : value.call ? 201 : 202).send({
      accepted: true,
      replayed: value.replayed,
      disposition: value.disposition,
      ...(value.call ? { call: callDto(value.call) } : {}),
    });
  });

  // S38 通过手机拨打: a call the user dialed on the Pixel's own dialer. The gateway never executes
  // it, so Control only mirrors what Telecom reports — a record, a lock when the gateway is free,
  // and nothing else. With the flag off the report is still idempotent, it just creates no record.
  app.post("/api/v1/gateway/calls/outgoing-observed", async (req, reply) => {
    const p = requireDevice(req);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        deviceCallId: z.string().min(1).max(200),
        simId: z.uuid(),
        remoteNumber: z.string().max(64).nullable().optional(),
        observedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), "Invalid observedAt"),
        telecomState: z.enum(["dialing", "active", "ended"]),
      })
      .parse(req.body);
    const fingerprint = requestFingerprint(b);
    const value = await tx(db, async (c) => {
      const gateway = await c.query(`SELECT device_epoch FROM gateways WHERE id=$1 FOR UPDATE`, [p.gatewayId]);
      if (Number(gateway.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");
      const prior = await c.query(
        `SELECT event_type,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        if (
          prior.rows[0].event_type !== "call.outgoing_observed" ||
          prior.rows[0].payload?.requestFingerprint !== fingerprint
        )
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        return { replayed: true, callId: (prior.rows[0].payload.response?.callId ?? null) as string | null };
      }
      const sim = await c.query(
        `SELECT s.*,st.mode FROM sims s LEFT JOIN sim_settings st ON st.sim_id=s.id
         WHERE s.id=$1 AND s.gateway_id=$2 AND s.device_present AND NOT s.assignment_pending FOR UPDATE OF s`,
        [b.simId, p.gatewayId],
      );
      let callId: string | null = null;
      if (config.PIXEL_ORIGINATED_CALLS_ENABLED && sim.rowCount && sim.rows[0].owner_user_id) {
        const s = sim.rows[0];
        const state = b.telecomState === "active" ? "active" : b.telecomState === "ended" ? "ended" : "connecting";
        // `calls_gateway_device_call_idx` is unique: a gateway that restarts before it recorded the
        // report as done re-sends the same device call under a fresh event ID.
        const existing = await c.query(
          `SELECT id,state FROM call_records WHERE gateway_id=$1 AND generation=$2 AND device_call_id=$3`,
          [p.gatewayId, b.generation, b.deviceCallId],
        );
        // S72 B1: dialing one of the owner's own hosted SIMs on the device itself is an internal call too.
        const remoteKey = existing.rowCount ? null : await callCanonicalKeyFor(c, s.owner_user_id, b.remoteNumber ?? null, s.country_iso);
        const peerSim = existing.rowCount ? null : await ownerSimByKey(c, s.owner_user_id, remoteKey, s.id);
        callId =
          existing.rows[0]?.id ??
          (
            await c.query(
              `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,originating_platform,device_call_id,observed_at,started_at,answered_at,ended_at,gateway_time_zone,remote_canonical_key,internal_call,peer_sim_id)
               VALUES($1,$2,$3,'outgoing',$4,$5::call_state,$6,$7,'pixel',$8,$9,$9,$10,$11,(SELECT time_zone FROM gateways WHERE id=$1),$12,$13,$14) RETURNING id`,
              [
                p.gatewayId,
                s.id,
                s.owner_user_id,
                b.remoteNumber ?? null,
                state,
                b.generation,
                s.mode ?? "normal",
                b.deviceCallId,
                b.observedAt,
                state === "active" ? b.observedAt : null,
                state === "ended" ? b.observedAt : null,
                remoteKey,
                !!peerSim,
                peerSim?.id ?? null,
              ],
            )
          ).rows[0].id;
        // S72: the callee gateway may have reported the other (incoming) leg first — link it now.
        // Matched by the callee SIM, or by that leg's caller ID being this SIM's own number.
        if (!existing.rowCount) {
          const ownKey = await callCanonicalKeyFor(c, s.owner_user_id, s.phone_label, s.country_iso);
          const leg = (await c.query(
            `SELECT id,sim_id,CASE WHEN sim_id=$3::uuid AND ($4::text IS NULL OR remote_canonical_key IS NULL OR remote_canonical_key=$4) THEN 'callee_sim' ELSE 'caller_id' END link_reason
               FROM call_records WHERE snapshot_owner_id=$1 AND direction='incoming' AND peer_call_id IS NULL AND sim_id<>$2
               AND state IN ('incoming_ringing','connecting','active','ending')
               AND ((sim_id=$3::uuid AND ($4::text IS NULL OR remote_canonical_key IS NULL OR remote_canonical_key=$4)) OR remote_canonical_key=$4)
             ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
            [s.owner_user_id, s.id, peerSim?.id ?? null, ownKey],
          )).rows[0];
          if (leg) {
            await c.query(`UPDATE call_records SET internal_call=true,peer_call_id=$2,peer_sim_id=COALESCE(peer_sim_id,$3) WHERE id=$1`, [leg.id, callId, s.id]);
            await c.query(`UPDATE call_records SET internal_call=true,peer_call_id=$2,peer_sim_id=COALESCE(peer_sim_id,$3) WHERE id=$1`, [callId, leg.id, leg.sim_id]);
            diag(db, "call.internal_linked", { peerCallId: leg.id, reason: leg.link_reason }, { callId });
            diag(db, "call.internal_linked", { peerCallId: callId, reason: leg.link_reason }, { callId: leg.id });
          }
        }
        // `gateway_id` is the primary key: the lock is this gateway's single cellular slot. A call
        // that already owns it (or one Control itself placed) keeps it. The record's own state
        // decides, not the report's: a re-send for a call the snapshot already closed must not relock.
        const recordState = existing.rows[0]?.state ?? state;
        if (!["ended", "failed"].includes(recordState))
          await c.query(
            `INSERT INTO gateway_call_locks(gateway_id,call_id,generation) VALUES($1,$2,$3) ON CONFLICT(gateway_id) DO NOTHING`,
            [p.gatewayId, callId, b.generation],
          );
      }
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
         VALUES($1,$2,'call.outgoing_observed',$3,$4)`,
        [p.gatewayId, b.eventId, callId ?? p.gatewayId, JSON.stringify({ requestFingerprint: fingerprint, response: { callId } })],
      );
      return { replayed: false, callId };
    });
    return reply
      .code(value.replayed ? 200 : value.callId ? 201 : 202)
      .send({ accepted: true, replayed: value.replayed, callId: value.callId });
  });
  // S38: the passive recorder's counterpart to `media/options` — a Pixel-dialed call has no WebRTC
  // leg, so it pins the media node here and gets the same capture binding the archive upload needs.
  app.post("/api/v1/gateway/calls/:callId/capture-binding", async (req) => {
    const p = requireDevice(req);
    const { callId } = z.object({ callId: z.uuid() }).parse(req.params);
    const capture = z
      .object({
        deviceCallId: z.string().min(1).max(200),
        telecomCreationTimeMillis: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .parse(req.body);
    if (!(config.PIXEL_ORIGINATED_CALLS_ENABLED || config.EARLY_MEDIA_ENABLED) || !config.PIXEL_ARCHIVE_ENABLED)
      fail(503, "CAPTURE_DISABLED", "Pixel-originated recording capture is not enabled");
    const bridge = requireMediaBridge(media);
    return tx(db, async (c) => {
      // Same lock order as every other gateway transaction: gateway row first, then the call. The
      // capture binding this route inserts takes a KEY SHARE on the gateway through its FK.
      await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`, [p.gatewayId]);
      const q = await c.query(
        `SELECT c.*,g.device_epoch FROM call_records c JOIN gateways g ON g.id=c.gateway_id
         WHERE c.id=$1 AND c.gateway_id=$2 FOR UPDATE OF c`,
        [callId, p.gatewayId],
      );
      if (!q.rowCount) fail(404, "NOT_FOUND", "Call not found");
      const call = q.rows[0];
      // S56: an early-media outgoing call asks here once ACTIVE; its media node is already pinned.
      const pixelCall = config.PIXEL_ORIGINATED_CALLS_ENABLED && call.originating_platform === "pixel";
      const earlyMediaCall = config.EARLY_MEDIA_ENABLED && call.direction === "outgoing";
      if (!(pixelCall || earlyMediaCall) || call.state !== "active")
        fail(409, "CAPTURE_NOT_ACTIVE", "Recording capture requires an active call dialed on the phone");
      const nodeId = call.media_node_id ?? bridge.defaultNodeId;
      if (!call.media_node_id)
        await c.query(
          `UPDATE call_records SET media_node_id=$2,recording_status=CASE WHEN recording_status='none' THEN 'pending' ELSE recording_status END WHERE id=$1`,
          [callId, nodeId],
        );
      call.media_node_id = nodeId;
      return {
        captureBinding: await ensureCaptureBinding(c, {
          enabled: true, gatewayId: p.gatewayId, call, capture, onlineSeconds: config.GATEWAY_ONLINE_SECONDS, fail,
        }),
      };
    }, "gateway.media.capture");
  });
  app.post("/api/v1/gateway/sms/incoming", async (req, reply) => {
    const p = requireDevice(req);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        simId: z.uuid(),
        assignmentVersion: z.number().int().positive(),
        remoteNumber: z.string().min(1).max(64),
        body: z.string().min(1).max(5000),
        receivedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), "Invalid receivedAt"),
        // S21 §B: the gateway dropped this message locally but still forwards it for the record.
        blockedLocally: z.boolean().optional(),
        // S84: CellDock re-sends a partial long SMS under the same key as later parts arrive.
        multipartKey: z.string().min(1).max(128).optional(),
        missingParts: z.boolean().optional(),
      })
      .parse(req.body);
    const fingerprint = requestFingerprint(b);
    let merged = false;
    const value = await tx(db, async (c) => {
      merged = false;
      const gateway = await c.query(
        `SELECT device_epoch FROM gateways WHERE id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      if (Number(gateway.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");

      const prior = await c.query(
        `SELECT event_type,resource_id,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        const saved = prior.rows[0];
        if (
          saved.event_type !== "sms.incoming" ||
          saved.payload?.requestFingerprint !== fingerprint
        )
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        const response = saved.payload.response as {
          disposition: "stored_for_owner" | "local_only" | "dropped_blocked";
          smsId?: string;
        };
        return { replayed: true, ...response };
      }

      const sim = await c.query(
        `SELECT id,owner_user_id,version,country_iso FROM sims
         WHERE id=$1 AND gateway_id=$2 AND device_present AND NOT assignment_pending FOR UPDATE`,
        [b.simId, p.gatewayId],
      );
      // S21 §B: a blocked message never reaches `sms_messages`, but the owner still gets a record
      // of it (with the body) in `sms_interceptions`. `device_events` bookkeeping is unchanged.
      // S66: Control's SMS-list match decides; `blockedLocally` is only a hint for `source`. A message
      // an old gateway dropped by its call list is stored below like any other incoming SMS.
      const smsBlockedLocally = b.blockedLocally === true;
      if (
        sim.rowCount &&
        sim.rows[0].owner_user_id &&
        await ownerBlocksRemote(c, sim.rows[0].owner_user_id, "sms", b.remoteNumber, sim.rows[0].country_iso)
      ) {
        const response = { disposition: "dropped_blocked" as const };
        await recordSmsInterception(c, {
          ownerUserId: sim.rows[0].owner_user_id,
          simId: sim.rows[0].id,
          gatewayId: p.gatewayId,
          remoteNumber: b.remoteNumber,
          body: b.body,
          receivedAt: b.receivedAt,
          source: smsBlockedLocally ? "gateway" : "control",
        });
        await c.query(
          `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
           VALUES($1,$2,'sms.incoming',$3,$4)`,
          [p.gatewayId, b.eventId, p.gatewayId, JSON.stringify({ requestFingerprint: fingerprint, response })],
        );
        return { replayed: false, ...response };
      }
      let smsId: string | undefined;
      if (
        sim.rowCount &&
        sim.rows[0].owner_user_id &&
        Number(sim.rows[0].version) === b.assignmentVersion
      ) {
        // S84: 50 min < CellDock's 60 min give-up, so a part arriving after that starts a new row.
        // Measured from Control's first store (device_events), not created_at = SMSC receivedAt.
        const partial = b.multipartKey
          ? await c.query(
              `SELECT m.id FROM sms_messages m
               WHERE m.gateway_id=$1 AND m.sim_id=$2 AND m.remote_number=$3 AND m.multipart_reference=$4
                 AND m.direction='incoming' AND m.missing_parts
                 AND (SELECT min(e.created_at) FROM device_events e
                      WHERE e.resource_id=m.id AND e.event_type='sms.incoming') > now() - interval '50 minutes'
               ORDER BY m.created_at DESC LIMIT 1 FOR UPDATE`,
              [p.gatewayId, b.simId, b.remoteNumber, b.multipartKey],
            )
          : undefined;
        if (partial?.rowCount) {
          smsId = partial.rows[0].id as string;
          await c.query(`UPDATE sms_messages SET body=$2, missing_parts=$3 WHERE id=$1`, [
            smsId,
            b.body,
            b.missingParts ?? false,
          ]);
          merged = true;
        } else {
          const sms = (
            await c.query(
              `INSERT INTO sms_messages(
                 gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation,
                 delivered_at,received_at,created_at,multipart_reference,missing_parts
               ) VALUES($1,$2,$3,'incoming',$4,$5,'delivered',$6,$7,$7,$7,$8,$9) RETURNING id`,
              [
                p.gatewayId,
                b.simId,
                sim.rows[0].owner_user_id,
                b.remoteNumber,
                b.body,
                b.generation,
                b.receivedAt,
                b.multipartKey ?? null,
                b.missingParts ?? false,
              ],
            )
          ).rows[0];
          smsId = sms.id;
        }
      }
      const disposition = smsId ? "stored_for_owner" : "local_only";
      const response = { disposition, ...(smsId ? { smsId } : {}) };
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
         VALUES($1,$2,'sms.incoming',$3,$4)`,
        [
          p.gatewayId,
          b.eventId,
          smsId ?? p.gatewayId,
          JSON.stringify({ requestFingerprint: fingerprint, response }),
        ],
      );
      return { replayed: false, ...response };
    });
    return reply
      .code(value.replayed || merged ? 200 : value.smsId ? 201 : 202)
      .send({ accepted: true, ...value });
  });

  app.post("/api/v1/gateway/sms/outgoing-observed", async (req, reply) => {
    const p = requireDevice(req);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        simId: z.uuid(),
        assignmentVersion: z.number().int().positive(),
        remoteNumber: z.string().min(1).max(64),
        body: z.string().min(1).max(5000),
        sentAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), "Invalid sentAt"),
      })
      .parse(req.body);
    const fingerprint = requestFingerprint(b);
    const value = await tx(db, async (c) => {
      const gateway = await c.query(
        `SELECT device_epoch FROM gateways WHERE id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      if (Number(gateway.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");

      const prior = await c.query(
        `SELECT event_type,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        const saved = prior.rows[0];
        if (
          saved.event_type !== "sms.outgoing_observed" ||
          saved.payload?.requestFingerprint !== fingerprint
        )
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        const response = saved.payload.response as {
          disposition: "stored_for_owner" | "local_only";
          smsId?: string;
        };
        return { replayed: true, ...response };
      }

      const sim = await c.query(
        `SELECT id,owner_user_id,version FROM sims
         WHERE id=$1 AND gateway_id=$2 AND device_present AND NOT assignment_pending FOR UPDATE`,
        [b.simId, p.gatewayId],
      );
      let smsId: string | undefined;
      if (
        config.SMS_OUTGOING_OBSERVED_ENABLED &&
        sim.rowCount &&
        sim.rows[0].owner_user_id &&
        Number(sim.rows[0].version) === b.assignmentVersion
      ) {
        smsId = (
          await c.query(
            `INSERT INTO sms_messages(
               gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation,
               sent_at,created_at
             ) VALUES($1,$2,$3,'outgoing',$4,$5,'sent',$6,$7,$7) RETURNING id`,
            [
              p.gatewayId,
              b.simId,
              sim.rows[0].owner_user_id,
              b.remoteNumber,
              b.body,
              b.generation,
              b.sentAt,
            ],
          )
        ).rows[0].id;
      }
      const response = smsId
        ? { disposition: "stored_for_owner" as const, smsId }
        : { disposition: "local_only" as const };
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
         VALUES($1,$2,'sms.outgoing_observed',$3,$4)`,
        [
          p.gatewayId,
          b.eventId,
          smsId ?? p.gatewayId,
          JSON.stringify({ requestFingerprint: fingerprint, response }),
        ],
      );
      return { replayed: false, ...response };
    });
    return reply
      .code(value.replayed ? 200 : value.smsId ? 201 : 202)
      .send({ accepted: true, ...value });
  });

  /**
   * S55: the Pixel's own system blocklist changed. The phone list is device-wide, so a change applies
   * to every owner with a present, assigned SIM on this gateway (the heartbeat's own predicate). A
   * number already listed in any CN spelling is a no-op add; a remove deletes the owner's entry in
   * any spelling and from any source. Counts are per reported number, not per owner row.
   */
  app.post("/api/v1/gateway/blocklist/phone-changes", async (req, reply) => {
    const p = requireDevice(req);
    const phoneNumber = z.string().min(1).max(64);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        adds: z.array(phoneNumber).max(500),
        removes: z.array(phoneNumber).max(500),
        observedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), "Invalid observedAt"),
      })
      .parse(req.body);
    if (phoneBlocklistSyncMode(config) !== "on")
      fail(409, "PHONE_SYNC_DISABLED", "Phone blocklist sync is not enabled");
    const fingerprint = requestFingerprint(b);
    const value = await tx(db, async (c) => {
      // S43 lock order: the gateway row first, then blocklist rows, then revisions in owner order.
      const gateway = await c.query(`SELECT device_epoch FROM gateways WHERE id=$1 FOR UPDATE`, [p.gatewayId]);
      if (Number(gateway.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");
      const prior = await c.query(
        `SELECT event_type,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        const saved = prior.rows[0];
        if (saved.event_type !== "blocklist.phone_changes" || saved.payload?.requestFingerprint !== fingerprint)
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        return { replayed: true, ...(saved.payload.response as { added: number; removed: number; rejected: number }), owners: null };
      }
      let rejected = 0;
      const keyed = (list: string[]) => {
        const out = new Map<string, string>();
        for (const raw of list) {
          const key = canonicalBlocklistKey(raw);
          if (!key) { rejected++; continue; }
          if (!out.has(key)) out.set(key, raw.trim());
        }
        return out;
      };
      const removes = keyed(b.removes);
      const adds = keyed(b.adds);
      const owners = (
        await c.query(
          `SELECT DISTINCT owner_user_id FROM sims
           WHERE gateway_id=$1 AND owner_user_id IS NOT NULL AND device_present AND NOT assignment_pending
           ORDER BY owner_user_id`,
          [p.gatewayId],
        )
      ).rows.map((row: { owner_user_id: string }) => row.owner_user_id);
      const removedKeys = new Set<string>();
      const addedKeys = new Set<string>();
      const changedOwners: string[] = [];
      // S66: the phone's system blocklist blocks calls and SMS alike, so a phone-side change applies to both lists.
      for (const owner of owners) {
        let changed = false;
        for (const scope of ["call", "sms"] as const) {
          let candidates = await loadBlockedCandidates(c, owner, scope, [...removes.keys(), ...adds.keys()]);
          const deleteIds = new Set<string>();
          for (const key of removes.keys())
            for (const row of candidates)
              if (blocklistKeysOverlap([key], [row.canonical_key])) { deleteIds.add(row.id); removedKeys.add(key); }
          if (deleteIds.size)
            await c.query(`DELETE FROM owner_blocked_numbers WHERE id=ANY($1::uuid[])`, [[...deleteIds]]);
          candidates = candidates.filter((row) => !deleteIds.has(row.id));
          const insertKeys: string[] = [];
          const insertNumbers: string[] = [];
          for (const [key, raw] of adds) {
            const listed = [...candidates.map((row) => row.canonical_key), ...insertKeys];
            if (blocklistKeysOverlap([key], listed)) continue;
            insertKeys.push(key);
            insertNumbers.push(raw);
          }
          const inserted = insertKeys.length
            ? await c.query(
                `INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,source,source_gateway_id,scope)
                 SELECT $1,k,n,'phone',$4,$5 FROM unnest($2::text[],$3::text[]) AS t(k,n)
                 ON CONFLICT(owner_user_id,scope,canonical_key) DO NOTHING RETURNING canonical_key`,
                [owner, insertKeys, insertNumbers, p.gatewayId, scope],
              )
            : { rowCount: 0, rows: [] };
          for (const row of inserted.rows as { canonical_key: string }[]) addedKeys.add(row.canonical_key);
          if (deleteIds.size || inserted.rowCount) changed = true;
        }
        if (changed) changedOwners.push(owner);
      }
      for (const owner of changedOwners) await bumpOwnerBlocklistRevision(c, owner);
      const response = { added: addedKeys.size, removed: removedKeys.size, rejected };
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
         VALUES($1,$2,'blocklist.phone_changes',$1,$3)`,
        [p.gatewayId, b.eventId, JSON.stringify({ requestFingerprint: fingerprint, response })],
      );
      return { replayed: false, ...response, owners: owners.length };
    }, "blocklist.phone_changes");
    const { owners, ...body } = value;
    if (!value.replayed)
      diag(db, "blocklist.phone_changes", { gatewayId: p.gatewayId, added: body.added, removed: body.removed, rejected: body.rejected, owners });
    return reply.code(value.replayed ? 200 : 201).send({ accepted: true, ...body });
  });

  app.post("/api/v1/gateway/telecom/snapshot", async (req) => {
    const p = requireDevice(req);
    const b = z
      .object({
        snapshotId: z.uuid(),
        snapshotSequence: z.number().int().positive(),
        generation: z.number().int().positive(),
        reportedSequence: z.number().int().nonnegative(),
        localBusy: z.boolean(),
        confirmedAbsentCallIds: z.array(z.uuid()).max(16),
        calls: z
          .array(
            z.object({
              callId: z.uuid().optional(),
              deviceCallId: z.string().min(1).max(200),
              simId: z.uuid().nullable().optional(),
              direction: z.enum(["incoming", "outgoing"]),
              state: z.enum(["ringing", "dialing", "active"]),
            }),
          )
          .max(16),
        observedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), "Invalid observedAt"),
      })
      .superRefine((value, ctx) => {
        const deviceIds = new Set<string>();
        const callIds = new Set<string>();
        if (new Set(value.confirmedAbsentCallIds).size !== value.confirmedAbsentCallIds.length)
          ctx.addIssue({ code: "custom", path: ["confirmedAbsentCallIds"], message: "Duplicate confirmed absent call ID" });
        value.calls.forEach((call, index) => {
          if (deviceIds.has(call.deviceCallId))
            ctx.addIssue({ code: "custom", path: ["calls", index, "deviceCallId"], message: "Duplicate deviceCallId" });
          deviceIds.add(call.deviceCallId);
          if (call.callId && callIds.has(call.callId))
            ctx.addIssue({ code: "custom", path: ["calls", index, "callId"], message: "Duplicate callId" });
          if (call.callId) callIds.add(call.callId);
        });
      })
      .parse(req.body);
    const fingerprint = requestFingerprint(b);
    const value = await tx(db, async (c) => {
      const gateway = await c.query(
        `SELECT device_epoch,command_sequence FROM gateways WHERE id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      if (Number(gateway.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");
      if (b.reportedSequence > Number(gateway.rows[0].command_sequence))
        fail(409, "SEQUENCE_AHEAD", "Reported command sequence was never issued");
      const prior = await c.query(
        `SELECT event_type,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.snapshotId],
      );
      if (prior.rowCount) {
        if (
          prior.rows[0].event_type !== "telecom.snapshot" ||
          prior.rows[0].payload?.requestFingerprint !== fingerprint
        )
          fail(409, "EVENT_ID_REUSED", "Snapshot ID was reused with different parameters");
        const stored = prior.rows[0].payload.response ?? {};
        return {
          ...stored,
          replayed: true,
          closeCallIds: [] as string[],
          releasedCallIds: Array.isArray(stored.releasedCallIds) ? stored.releasedCallIds : [],
        };
      }
      const lastSnapshot = await c.query(
        `SELECT generation,snapshot_sequence,reported_sequence,local_busy,calls,observed_at FROM gateway_telecom_snapshots WHERE gateway_id=$1`,
        [p.gatewayId],
      );
      if (
        lastSnapshot.rowCount &&
        Number(lastSnapshot.rows[0].generation) === b.generation &&
        (Number(lastSnapshot.rows[0].snapshot_sequence) >= b.snapshotSequence ||
          Number(lastSnapshot.rows[0].reported_sequence) > b.reportedSequence)
      )
        fail(409, "STALE_SNAPSHOT", "Telecom snapshot is older than the accepted state");

      const matched = new Set<string>();
      const confirmedAbsent = new Set(b.confirmedAbsentCallIds);
      let unmanagedBusy = b.localBusy;
      // A single snapshot sample can miss a live call (transient Telecom read), so a stale-lock reclaim additionally
      // requires the previous accepted snapshot for the same epoch to have shown no device call for at least two
      // minutes. Together with "no pending command" and the lock age this is repeated, epoch-fenced absence evidence.
      const priorSnapshot = lastSnapshot.rowCount ? lastSnapshot.rows[0] : null;
      const priorSnapshotObservedAt = priorSnapshot ? Date.parse(String(priorSnapshot.observed_at)) : Number.NaN;
      const snapshotObservedAt = Date.parse(b.observedAt);
      // The gateway snapshots on every heartbeat, so "the previous accepted snapshot" is seconds old, not minutes.
      // Absence is therefore proven by an older accepted absence sample (or a genuinely long gap), never by wall-clock
      // spacing between two back-to-back heartbeats.
      const previousAbsenceSample = Boolean(priorSnapshot) &&
        Number(priorSnapshot.generation) === b.generation &&
        priorSnapshot.local_busy === false &&
        Array.isArray(priorSnapshot.calls) &&
        priorSnapshot.calls.length === 0 &&
        (Number(priorSnapshot.snapshot_sequence) < b.snapshotSequence ||
          (Number.isFinite(priorSnapshotObservedAt) &&
            snapshotObservedAt - priorSnapshotObservedAt >= STALE_LOCK_ABSENCE_MS));
      for (const reported of b.calls) {
        const known = await c.query(
          `SELECT * FROM call_records WHERE gateway_id=$1 AND generation=$2 AND
           (($3::uuid IS NOT NULL AND id=$3::uuid) OR device_call_id=$4) FOR UPDATE`,
          [p.gatewayId, b.generation, reported.callId ?? null, reported.deviceCallId],
        );
        if ((known.rowCount ?? 0) > 1)
          fail(409, "DEVICE_CALL_MISMATCH", "Call identity maps to multiple records");
        if (!known.rowCount) {
          unmanagedBusy = true;
          continue;
        }
        const call = known.rows[0];
        // S21 §B: a locally blocked call is terminal at creation and outside reconciliation. Ignore
        // any late snapshot item for it entirely — not even the unmanaged-busy flag.
        if (call.failure_reason === "number_blocked") continue;
        if (call.device_call_id && call.device_call_id !== reported.deviceCallId)
          fail(409, "DEVICE_CALL_MISMATCH", "Call identity changed within one epoch");
        if (
          call.direction !== reported.direction ||
          (reported.simId && call.sim_id !== reported.simId)
        )
          fail(409, "DEVICE_CALL_MISMATCH", "Snapshot call metadata does not match the server record");
        if (["ended", "failed"].includes(call.state)) {
          unmanagedBusy = true;
          continue;
        }
        const nextState =
          reported.state === "active"
            ? "active"
            : reported.state === "ringing"
              ? "incoming_ringing"
              : "connecting";
        if (nextState === "active") await markDeviceAnswer(c, call.id);
        await c.query(
          `UPDATE call_records SET device_call_id=COALESCE(device_call_id,$2),
             state=CASE
               WHEN state IN ('ending','ended','failed') THEN state
               WHEN $3='active' THEN 'active'::call_state
               WHEN $3='incoming_ringing' AND state IN ('incoming_ringing','unknown') THEN 'incoming_ringing'::call_state
               WHEN $3='connecting' AND state IN ('outgoing_pending','connecting','unknown') THEN 'connecting'::call_state
               ELSE state END,
             answered_at=CASE WHEN $3='active' THEN COALESCE(answered_at,now()) ELSE answered_at END
           WHERE id=$1`,
          [call.id, reported.deviceCallId, nextState],
        );
        if (nextState === "active") await observeAiCallState(c, call.id, "active");
        matched.add(call.id);
      }

      // S38: a Pixel-dialed call only holds the gateway lock when it was free; the lock-less ones are
      // outside `reclaimAbsentGatewayLocks`, so the device's own confirmed absence closes them here.
      // Their ids are echoed back as released so the gateway prunes its journal row like any other.
      const pixelClosed: string[] = confirmedAbsent.size
        ? (
            await c.query(
              `UPDATE call_records SET state=(CASE WHEN answered_at IS NOT NULL THEN 'ended' ELSE 'failed' END)::call_state,
                 ended_at=COALESCE(ended_at,$3::timestamptz)
               WHERE id=ANY($2::uuid[]) AND gateway_id=$1 AND originating_platform='pixel'
                 AND state NOT IN ('ended','failed')
                 AND NOT EXISTS(SELECT 1 FROM gateway_call_locks l WHERE l.call_id=call_records.id) RETURNING id`,
              [p.gatewayId, [...confirmedAbsent], b.observedAt],
            )
          ).rows.map((row) => row.id as string)
        : [];
      const closeCallIds = await reclaimAbsentGatewayLocks(c, {
        gatewayId: p.gatewayId,
        generation: b.generation,
        reportedSequence: b.reportedSequence,
        observedAt: b.observedAt,
        localBusy: b.localBusy,
        callsEmpty: b.calls.length === 0,
        matchedCallIds: matched,
        confirmedAbsentCallIds: confirmedAbsent,
        previousAbsenceSample,
      });
      await c.query(
        `INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(gateway_id) DO UPDATE SET generation=excluded.generation,snapshot_id=excluded.snapshot_id,
           snapshot_sequence=excluded.snapshot_sequence,reported_sequence=excluded.reported_sequence,
           local_busy=excluded.local_busy,calls=excluded.calls,
           observed_at=excluded.observed_at,updated_at=now()`,
        [p.gatewayId, b.generation, b.snapshotId, b.snapshotSequence, b.reportedSequence, unmanagedBusy, JSON.stringify(b.calls), b.observedAt],
      );
      const remaining = await c.query(
        `SELECT bool_or(c.state='unknown') has_unknown,count(*)::int count
         FROM gateway_call_locks l JOIN call_records c ON c.id=l.call_id WHERE l.gateway_id=$1`,
        [p.gatewayId],
      );
      const busyState = unmanagedBusy
        ? "busy"
        : remaining.rows[0].has_unknown
          ? "unknown"
          : remaining.rows[0].count > 0
            ? "busy"
            : "idle";
      const response = { accepted: true, busyState, releasedCallIds: [...closeCallIds, ...pixelClosed] };
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)
         VALUES($1,$2,'telecom.snapshot',$1,$3)`,
        [p.gatewayId, b.snapshotId, JSON.stringify({ requestFingerprint: fingerprint, response })],
      );
      return { ...response, replayed: false, closeCallIds };
    });
    await Promise.all(value.closeCallIds.map((callId: string) => requestMediaClose(db, media, callId)));
    // S39 §决策1: the CallLog purge queue rides the heartbeat instead of becoming a command kind, so
    // an older gateway simply ignores an unknown field. Read after the transaction: it is unrelated to
    // the snapshot's own `device_events` fingerprint, and the replayed branch must carry it too.
    const callLogPurges = config.CALL_LOG_PURGE_ENABLED
      ? (
          await db.query(
            `SELECT id,call_id,device_call_id,remote_number,direction,started_at,ended_at
               FROM call_log_purges
              WHERE gateway_id=$1 AND acked_at IS NULL AND created_at > now()-interval '7 days'
              ORDER BY created_at LIMIT 20`,
            [p.gatewayId],
          )
        ).rows.map((row) => ({
          purgeId: row.id,
          callId: row.call_id,
          deviceCallId: row.device_call_id,
          remoteNumber: row.remote_number,
          direction: row.direction,
          startedAt: row.started_at,
          endedAt: row.ended_at,
        }))
      : null;
    return {
      accepted: value.accepted,
      replayed: value.replayed,
      deviceEpoch: b.generation,
      busyState: value.busyState,
      releasedCallIds: value.releasedCallIds ?? [],
      ...(callLogPurges ? { callLogPurges } : {}),
    };
  });
  // S39: the gateway reports what its CallLog purge actually did. Gateway-scoped and one-shot; a
  // purge it could not perform (permission denied) is never acked and re-sent until the 7-day prune.
  app.post("/api/v1/gateway/call-log-purges/ack", async (req) => {
    const p = requireDevice(req);
    const b = z
      .object({
        acks: z
          .array(
            z.object({
              purgeId: z.uuid(),
              status: z.enum(["deleted", "not_found"]),
              deletedRows: z.number().int().nonnegative(),
            }),
          )
          .max(50),
      })
      .parse(req.body);
    let acked = 0;
    for (const ack of b.acks)
      acked += (
        await db.query(
          `UPDATE call_log_purges SET acked_at=now(),ack_status=$3,ack_deleted_rows=$4
            WHERE id=$1 AND gateway_id=$2 AND acked_at IS NULL`,
          [ack.purgeId, p.gatewayId, ack.status, ack.deletedRows],
        )
      ).rowCount ?? 0;
    return { accepted: true, acked };
  });
  for(const mode of ['preflight','commit'] as const)app.post(`/api/v1/gateway/replay-migration/${mode}`,async(req)=>{
    const p=requireDevice(req);
    const input=z.object({intentId:z.uuid(),generation:z.number().int().positive(),serverSequence:z.number().int().nonnegative(),
      localProof:z.object({idle:z.boolean(),pendingAcks:z.number().int().nonnegative(),pendingEvents:z.number().int().nonnegative(),pendingCommands:z.number().int().nonnegative(),unknownExecutions:z.number().int().nonnegative()})}).parse(req.body);
    return tx(db,c=>coordinateReplayMigration(c,p.gatewayId,input,mode,config.COMMAND_REPLAY_MIGRATION_ENABLED===true));
  });
  app.post('/api/v1/gateway/replay-migration/complete',async(req)=>{
    const p=requireDevice(req);
    const input=z.object({intentId:z.uuid(),generation:z.number().int().positive(),proofDigest:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).parse(req.body);
    return tx(db,c=>completeReplayMigration(c,p.gatewayId,input));
  });
  app.post("/api/v1/gateway/heartbeat", async (req) => {
    const heartbeatStartedAt = Date.now();
    const p = requireDevice(req);
    const b = z
      .object({
        controlEnabled: z.boolean(),
        reportedSequence: z.number().int().nonnegative(),
        capabilities: z.object({
          telephonyReady: z.boolean(),
          smsReady: z.boolean().default(false),
          mediaReady: z.boolean(),
          commandReconciliationReady: z.boolean().default(false),
          commandReplayHorizonVersion: z.literal(1).optional(),
          commandReplayFinalizedProofVersion: z.literal(1).optional(),
        }),
        replayHorizonState: z.object({
          gatewayId:z.uuid(),generation:z.number().int().positive(),blockingFloor:z.number().int().positive(),
          preparedRevision:z.number().int().nonnegative(),preparedDigest:z.string().max(128),
          committedFloor:z.number().int().positive(),committedRevision:z.number().int().nonnegative(),committedDigest:z.string().max(128),
          disposition:z.enum(['ready','local_blocked','quarantined']).optional(),rejectionReason:z.string().max(80).optional(),
        }).optional(),
        timeZone: z.string().min(1).max(100).optional(),
        // S21 §D. The schema is intentionally not `.strict()`, so an old gateway that omits these
        // and a new gateway talking to an old Control both stay on the 200 path.
        remotePowerAllowed: z.boolean().optional(),
        lastPowerResult: powerResultBody.optional(),
        // S41 decision 5: the blocklist version the gateway already applied. Omitted by an old
        // gateway, which keeps getting the full list.
        numberBlocklistVersion: z.number().int().nonnegative().optional(),
        // S36b D3: the gateway may piggyback its periodic device snapshot here instead of spending a
        // separate diag POST. Deliberately `unknown`: an unexpected shape is dropped, never a 400 —
        // a heartbeat that carries a bad snapshot still has commands to deliver.
        deviceStatus: z.unknown().optional(),
        // S58: display-only hardware kind; omitted by an old gateway, which keeps the stored value.
        kind: z.enum(['pixel','dji4g']).optional(),
      })
      .parse(req.body);
    if (b.timeZone !== undefined) {
      try { assertIanaTimeZone(b.timeZone); }
      catch { fail(400, "INVALID_TIME_ZONE", "A valid IANA time zone is required"); }
    }
    // S36b D3: the pre-update capabilities and last_seen_at, read in the same statement so a flip
    // and a missed beat are both observable without a second round trip.
    let prev:GatewayHeartbeatPrev|null=null;
    const state=await tx(db,async c=>{
      const g=await c.query(
        // SET expressions read the pre-update row, so `media_ready` below is the previous value.
        `WITH prev AS (SELECT control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at FROM gateways WHERE id=$1)
         UPDATE gateways SET control_enabled=$2,telephony_ready=$3,sms_ready=$4,media_ready=$5,last_seen_at=now(),
           media_unready_since=CASE WHEN $5 THEN NULL WHEN media_ready THEN now() ELSE COALESCE(media_unready_since,now()) END,
           media_unready_heartbeats=CASE WHEN $5 THEN 0 WHEN media_ready THEN 1 ELSE media_unready_heartbeats+1 END,
           -- S22 decision 2: telephony gets the same 3-beat / 15 s counters, because a released audio
           -- handoff drops telephonyReady and mediaReady together (R1 §1.2).
           telephony_unready_since=CASE WHEN $3 THEN NULL WHEN telephony_ready THEN now() ELSE COALESCE(telephony_unready_since,now()) END,
           telephony_unready_heartbeats=CASE WHEN $3 THEN 0 WHEN telephony_ready THEN 1 ELSE telephony_unready_heartbeats+1 END,
           time_zone=COALESCE($6::text,time_zone),
           remote_power_allowed=COALESCE($7::boolean,remote_power_allowed),
           last_power_result=COALESCE($8::jsonb,last_power_result),
           kind=COALESCE($9::text,kind) WHERE id=$1
         RETURNING device_epoch,command_sequence,media_unready_since,media_unready_heartbeats,(SELECT row_to_json(p) FROM prev p) prev`,
        [
          p.gatewayId,
          b.controlEnabled,
          b.controlEnabled && b.capabilities.telephonyReady,
          b.controlEnabled && b.capabilities.smsReady,
          b.controlEnabled && b.capabilities.mediaReady,
          b.timeZone ?? null,
          b.remotePowerAllowed ?? null,
          b.lastPowerResult ? JSON.stringify({ ...b.lastPowerResult, reason: b.lastPowerResult.reason ?? null }) : null,
          b.kind ?? null,
        ],
      );
      const epoch=Number(g.rows[0].device_epoch);
      prev=g.rows[0].prev??null;
      // S21 §D: only `off` travels on the heartbeat (a gateway that heartbeats is already on) and it
      // is consumed on delivery inside this transaction, which already holds the gateway row lock.
      const desiredPower=await consumeDesiredPower(c,p.gatewayId,'off')?'off' as const:null;
      const numberBlocklist=await gatewayNumberBlocklist(c,p.gatewayId,b.numberBlocklistVersion);
      const migrationPending=(await c.query(`SELECT 1 FROM gateway_command_replay_migrations WHERE gateway_id=$1 AND state='committed' AND confirmed_at IS NULL`,[p.gatewayId])).rowCount!==0;
      if(migrationPending){
        await c.query(`UPDATE gateways SET telephony_ready=false,sms_ready=false,media_ready=false,
          media_unready_since=COALESCE(media_unready_since,now()),media_unready_heartbeats=GREATEST(media_unready_heartbeats,3),
          telephony_unready_since=COALESCE(telephony_unready_since,now()),telephony_unready_heartbeats=GREATEST(telephony_unready_heartbeats,3) WHERE id=$1`,[p.gatewayId]);
        return{epoch,sequence:Number(g.rows[0].command_sequence),commands:[],closeCallIds:[],horizon:undefined,migrationPending:true,numberBlocklist,desiredPower};
      }
      let sequence=Number(g.rows[0].command_sequence);
      let closeCallIds:string[]=[];
      if(!b.controlEnabled||!b.capabilities.mediaReady){
        // Pending media authorization is always withdrawn immediately.
        const rejected=await c.query(`UPDATE commands cmd SET status='rejected',result='{"reason":"media_capability_withdrawn"}' FROM call_records call WHERE cmd.call_id=call.id AND call.gateway_id=$1 AND cmd.status='pending' AND cmd.kind<>'hangup'`,[p.gatewayId]);
        // S18 decision 1: the Telecom snapshot stays authoritative. A call that already
        // pinned a media node survives a transient mediaReady=false; only a control
        // shutdown, a call without a media node, or a sustained withdrawal ends it.
        const calls=await c.query(`UPDATE call_records call SET state='unknown',failure_reason='media_capability_withdrawn'
          FROM gateways gateway WHERE gateway.id=call.gateway_id AND call.gateway_id=$1 AND call.state NOT IN ('ending','ended','failed','unknown')
            AND ($2::boolean OR (call.answered_by_platform IS DISTINCT FROM 'device' AND (call.media_node_id IS NULL OR gateway.media_unready_heartbeats>=3
              OR gateway.media_unready_since<=now()-interval '15 seconds'))) RETURNING call.id`,[p.gatewayId,!b.controlEnabled]);
        closeCallIds=calls.rows.map(row=>row.id);
        // S40: the withdrawal that killed a live call left no Control-side trace. Only when it
        // actually did something — a healthy unready beat that rejects and closes nothing stays quiet.
        if((rejected.rowCount??0)>0||closeCallIds.length)
          diag(db,'gateway.media_withdrawn',{gatewayId:p.gatewayId,controlEnabled:b.controlEnabled,mediaReady:b.capabilities.mediaReady,
            telephonyReady:b.capabilities.telephonyReady,rejectedCommands:rejected.rowCount??0,calls:closeCallIds.length,
            unreadyBeats:Number(g.rows[0].media_unready_heartbeats)},
            {callId:closeCallIds[0]??null,level:closeCallIds.length?'warn':'info'});
      }
      // S36 C2: dtmf has no reconciliation or retry path, so an undelivered one would sit `pending`
      // forever and hold the replay floor down. Finalize it the way settings commands are finalized.
      await c.query(
        `UPDATE commands SET status='expired',result='{"reason":"expired"}'
         WHERE gateway_id=$1 AND kind='dtmf' AND status='pending' AND expires_at<=now()`,
        [p.gatewayId],
      );
      // Desired settings are durable state. Re-create a fenced command when a
      // command expired, a SIM assignment changed, or the device epoch rotated.
      // This also delivers the initial default `normal` settings after pairing.
      if (b.controlEnabled) {
        await c.query(
          `UPDATE commands SET status='expired',result='{"reason":"expired"}'
           WHERE gateway_id=$1 AND kind='apply_sim_settings' AND status='pending' AND expires_at<=now()`,
          [p.gatewayId],
        );
        const desired = await c.query(
          `SELECT s.id sim_id,s.version assignment_version,st.mode,st.timeout_seconds,
                  st.version settings_version,st.applied_version,st.applied_assignment_version,st.applied_generation
           FROM sims s JOIN sim_settings st ON st.sim_id=s.id
           WHERE s.gateway_id=$1 AND s.owner_user_id IS NOT NULL AND s.device_present AND NOT s.assignment_pending
             AND (st.applied_version IS DISTINCT FROM st.version
               OR st.applied_assignment_version IS DISTINCT FROM s.version
               OR st.applied_generation IS DISTINCT FROM $2::bigint)
           ORDER BY s.slot_index FOR UPDATE OF s,st`,
          [p.gatewayId, epoch],
        );
        for (const setting of desired.rows) {
          const payload = {
            simId: setting.sim_id,
            mode: setting.mode,
            timeoutSeconds: setting.timeout_seconds,
            settingsVersion: Number(setting.settings_version),
            assignmentVersion: Number(setting.assignment_version),
          };
          const pending = await c.query(
            `SELECT id FROM commands
             WHERE gateway_id=$1 AND sim_id=$2 AND kind='apply_sim_settings' AND status='pending'
               AND generation=$3 AND expires_at>now() AND payload=$4::jsonb
             LIMIT 1`,
            [p.gatewayId, setting.sim_id, epoch, JSON.stringify(payload)],
          );
          if (pending.rowCount) continue;
          // S22 decision 8: the device explicitly refused this exact generation+payload and never
          // executed it. Re-sending it every heartbeat is what produced 1254 rejected rows in two
          // hours; back off for 60 s. `result->>'phase'` separates a device refusal from Control's
          // own `settings_superseded`, so legitimate version catch-up is unaffected.
          const refused = await c.query(
            `SELECT id FROM commands
             WHERE gateway_id=$1 AND sim_id=$2 AND kind='apply_sim_settings' AND status='rejected'
               AND generation=$3 AND payload=$4::jsonb AND result->>'phase'='not_executed'
               AND created_at>now()-interval '60 seconds'
             LIMIT 1`,
            [p.gatewayId, setting.sim_id, epoch, JSON.stringify(payload)],
          );
          if (refused.rowCount) continue;
          await c.query(
            `UPDATE commands SET status='rejected',result='{"reason":"settings_superseded"}'
             WHERE gateway_id=$1 AND sim_id=$2 AND kind='apply_sim_settings' AND status='pending'`,
            [p.gatewayId, setting.sim_id],
          );
          sequence += 1;
          await c.query(
            `INSERT INTO commands(gateway_id,sim_id,generation,sequence,kind,payload,expires_at)
             VALUES($1,$2,$3,$4,'apply_sim_settings',$5,now()+interval '24 hours')`,
            [p.gatewayId, setting.sim_id, epoch, sequence, JSON.stringify(payload)],
          );
        }
        if (sequence !== Number(g.rows[0].command_sequence))
          await c.query(`UPDATE gateways SET command_sequence=$2 WHERE id=$1`, [p.gatewayId, sequence]);
      }
      const persistedHorizon=(await c.query(`SELECT * FROM gateway_command_replay_horizons WHERE gateway_id=$1 AND generation=$2`,[p.gatewayId,epoch])).rows[0];
      const horizonRequired=Boolean(persistedHorizon)||b.replayHorizonState!==undefined;
      const replayProtocol=b.capabilities.commandReplayHorizonVersion;
      const horizon=(config.COMMAND_REPLAY_HORIZON_ENABLED&&replayProtocol!==undefined)||horizonRequired
        ?await coordinateReplayHorizon(c,{gatewayId:p.gatewayId,generation:epoch,device:replayProtocol!==undefined?b.replayHorizonState:undefined,
          allowProposal:config.COMMAND_REPLAY_HORIZON_ENABLED&&replayProtocol!==undefined,
          protocolVersion:b.capabilities.commandReplayFinalizedProofVersion===1?2:1})
        :undefined;
      const horizonNegotiated=config.COMMAND_REPLAY_HORIZON_ENABLED&&replayProtocol!==undefined;
      const deliveryFloor=Math.max(Number(persistedHorizon?.committed_floor??1),b.replayHorizonState?.blockingFloor??1);
      if(horizon?.quarantined||horizon?.blocked)await c.query(`UPDATE gateways SET telephony_ready=false,sms_ready=false,media_ready=false,
        media_unready_since=COALESCE(media_unready_since,now()),media_unready_heartbeats=GREATEST(media_unready_heartbeats,3),
          telephony_unready_since=COALESCE(telephony_unready_since,now()),telephony_unready_heartbeats=GREATEST(telephony_unready_heartbeats,3) WHERE id=$1`,[p.gatewayId]);
      if(b.controlEnabled&&!horizon?.quarantined&&!horizon?.blocked){
        await releaseSms(c,p.gatewayId,config.GATEWAY_ONLINE_SECONDS);
        sequence=Number((await c.query(`SELECT command_sequence FROM gateways WHERE id=$1`,[p.gatewayId])).rows[0].command_sequence);
      }
      const q=b.controlEnabled&&!horizon?.quarantined&&!horizon?.blocked?await c.query(
        `SELECT id,call_id,sms_id,sim_id,kind,payload,generation,sequence,expires_at,
                (expires_at<=now() AND call_id IS NOT NULL) reconciliation_only
         FROM commands
         WHERE gateway_id=$1 AND generation=$2 AND sequence >= $7 AND (
           (status='pending' AND ((expires_at>now() AND ((kind='send_sms' AND $3 AND id=(SELECT command_id FROM gateway_sms_pacing WHERE gateway_id=$1)) OR (kind='apply_sim_settings') OR kind='hangup'
             OR (kind NOT IN ('send_sms','apply_sim_settings','hangup') AND $4)))
             OR ($5 AND expires_at<=now() AND call_id IS NOT NULL AND kind IN ('dial','answer','hangup'))))
           OR ($5 AND status='expired' AND result='{"reason":"expired"}'::jsonb
             AND expires_at<=now() AND call_id IS NOT NULL AND kind IN ('dial','answer','hangup') AND sequence>$6)
         )
         ORDER BY sequence LIMIT 100`,
        [p.gatewayId,epoch,b.capabilities.smsReady,b.capabilities.telephonyReady,b.capabilities.commandReconciliationReady,b.reportedSequence,deliveryFloor],
      ):{rows:[]};
      await c.query(`UPDATE sms_dispatch_queue SET first_delivery_at=COALESCE(first_delivery_at,clock_timestamp()) WHERE command_id=ANY($1::uuid[])`,[q.rows.filter((row:any)=>row.kind==='send_sms').map((row:any)=>row.id)]);
      // Hangup-before-delivery: `/end` only cancels a dial no heartbeat has handed out for execution.
      const executableDials=q.rows.filter((row:any)=>row.kind==='dial'&&!row.reconciliation_only).map((row:any)=>row.id);
      if(executableDials.length)await c.query(`UPDATE commands SET delivered_at=clock_timestamp() WHERE id=ANY($1::uuid[]) AND delivered_at IS NULL`,[executableDials]);
      return{epoch,sequence,commands:q.rows,closeCallIds,horizon,numberBlocklist,desiredPower,
        replayCommitted:{floor:Number(persistedHorizon?.committed_floor??1),revision:Number(persistedHorizon?.committed_revision??0)}};
    });
    await Promise.all(state.closeCallIds.map(callId=>requestMediaClose(db,media,callId)));
    // S36b D3: emitted after the transaction, so a rolled-back heartbeat files nothing. `gateway.state`
    // only on an actual flip — a steady 2 s beat must not write a row per beat — and the gap is what
    // makes a Doze window or a dead radio visible after the fact.
    if(prev){
      const before=prev as GatewayHeartbeatPrev;
      const flips=([['controlEnabled',before.control_enabled,b.controlEnabled],
        ['telephonyReady',before.telephony_ready,b.controlEnabled&&b.capabilities.telephonyReady],
        ['smsReady',before.sms_ready,b.controlEnabled&&b.capabilities.smsReady],
        ['mediaReady',before.media_ready,b.controlEnabled&&b.capabilities.mediaReady]] as const)
        .filter(([,was,now])=>was!==now);
      if(flips.length)diag(db,'gateway.state',
        {gatewayId:p.gatewayId,...Object.fromEntries(flips.map(([key,was,now])=>[key,{was,now}]))},
        {level:flips.some(([,,now])=>!now)?'warn':'info'});
      const gapMs=before.last_seen_at?Date.now()-new Date(before.last_seen_at).getTime():null;
      if(gapMs!==null){
        const recent=heartbeatIntervals.get(p.gatewayId)??[];
        const thresholdMs=heartbeatGapThresholdMs(recent);
        if(gapMs>thresholdMs)
          diag(db,'gateway.heartbeat_gap',{gatewayId:p.gatewayId,gapMs,thresholdMs,samples:recent.length},{level:'warn'});
        recent.push(gapMs);if(recent.length>20)recent.shift();heartbeatIntervals.set(p.gatewayId,recent);
      }
    }
    // The piggybacked snapshot is stored verbatim under the gateway's own id, so it reads exactly
    // like one the gateway had POSTed to /diag/events. A junk shape is dropped, never a 400.
    if(b.deviceStatus&&typeof b.deviceStatus==='object'&&!Array.isArray(b.deviceStatus)&&JSON.stringify(b.deviceStatus).length<=4096)
      diag(db,'device.status',b.deviceStatus as Record<string,unknown>,{source:'gateway',device:p.gatewayId});
    // S29 §2.2: a returned proposal means `coordinateReplayHorizon` did not commit this heartbeat, so
    // the committed tuple read before it is still current. Observing after the transaction keeps the
    // counter out of a rolled-back attempt; it is pure bookkeeping and never changes the response.
    const stalledProposal=state.horizon?.proposal;
    const stalledHeartbeats=replayProposalStalls.observe({gatewayId:p.gatewayId,generation:state.epoch,
      proposedRevision:stalledProposal?stalledProposal.revision:(state.replayCommitted?.revision??0),
      committedRevision:state.replayCommitted?.revision??0,
      deviceBlockingFloor:b.replayHorizonState?.blockingFloor,committedFloor:state.replayCommitted?.floor??1});
    if(stalledProposal&&stalledHeartbeats>0&&stalledHeartbeats%replayProposalStalls.threshold===0)
      req.log.warn({gatewayId:p.gatewayId,generation:state.epoch,revision:stalledProposal.revision,heartbeats:stalledHeartbeats,msg:'replay_proposal_stalled'});
    const heartbeatMs=Date.now()-heartbeatStartedAt;
    if(heartbeatMs>5000)req.log.warn({gatewayId:p.gatewayId,elapsedMs:heartbeatMs,msg:'slow gateway heartbeat'});
    return {
      gateway: {
        id: p.gatewayId,
        deviceEpoch: state.epoch,
        serverSequence: state.sequence,
      },
      // S55: the mode rides on every answer, the version-match `items:[]` short circuit included.
      numberBlocklist: { ...state.numberBlocklist, phoneSync: phoneBlocklistSyncMode(config) },
      // S56: every answer, like `phoneSync`; the gateway follows it at runtime.
      earlyMedia: config.EARLY_MEDIA_ENABLED,
      // S21 §D: null unless a remote OFF was pending; it is already consumed when this is `off`.
      desiredPower: state.desiredPower ?? null,
      // 0 means the long poll is off; the gateway's doorbell coroutine only runs above 0.
      commandDoorbell: { maxHoldMs: doorbellMaxHoldMs },
      commands: state.commands.map((r) => ({
        id: r.id,
        ...(r.call_id ? { callId: r.call_id } : {}),
        ...(r.sms_id ? { smsId: r.sms_id } : {}),
        ...(r.sim_id ? { simId: r.sim_id } : {}),
        kind: r.kind,
        payload: r.sms_id ? { ...r.payload, smsId: r.sms_id } : r.payload,
        generation: Number(r.generation),
        sequence: Number(r.sequence),
        expiresAt: r.expires_at,
        reconciliationOnly: Boolean(r.reconciliation_only),
      })),
      ...(state.migrationPending?{replayMigrationPending:true}:{}),
      ...(state.horizon?.proposal?{replayHorizon:{phase:'proposed',...state.horizon.proposal}}:{}),
      ...(state.horizon?.committed?{replayHorizon:{phase:'control_committed',...state.horizon.committed}}:{}),
      ...(state.horizon?.withdrawn?{replayHorizon:{phase:'control_withdrawn',...state.horizon.withdrawn}}:{}),
      ...(state.horizon?.quarantined?{replayHorizon:{phase:'quarantined'}}:{}),
    };
  });
  // S20 D4 command doorbell: one suspended request per gateway, woken by any committed command insert.
  // Device authentication is identical to the heartbeat (gateway device principal).
  app.post("/api/v1/gateway/commands/doorbell", async (req, reply) => {
    const p = requireDevice(req);
    const { holdMs } = z.object({ holdMs: z.number().int().min(0).max(DOORBELL_HARD_CAP_MS) }).parse(req.body);
    if (doorbellMaxHoldMs <= 0) return { wake: false, heldMs: 0 };
    // Registration strictly precedes the read: a command committed in between still wakes this waiter.
    const waiter = commandDoorbell.listen(p.gatewayId);
    try {
      if (await hasDeliverableCommand(db, p.gatewayId)) return { wake: true, heldMs: 0 };
      const startedAt = Date.now();
      // Nothing is held here: no transaction, no checked-out pg client, just a timer and a listener.
      const hold = Math.min(holdMs, doorbellMaxHoldMs);
      const wake = await waiter.wait(hold, reply.raw, req.raw.socket);
      const heldMs = Date.now() - startedAt;
      // An empty poll that simply timed out is the design (124k rows/week); only a wake, a hold past
      // the 8 s cap, or an early non-wake exit (superseded waiter, closed socket) is worth a row.
      if (wake || heldMs > 9000 || heldMs + 500 < hold) diag(db, "gateway.doorbell", { heldMs, wake, gatewayId: p.gatewayId });
      return { wake, heldMs };
    } finally {
      waiter.dispose();
    }
  });
  app.post("/api/v1/gateway/commands/:commandId/ack", async (req) => {
    const p = requireDevice(req);
    const { commandId } = z.object({ commandId: z.uuid() }).parse(req.params);
    const b = z
      .object({
        generation: z.number().int().positive(),
        status: z.enum(["acked", "rejected"]),
        replayEvidence:z.object({sequence:z.number().int().positive(),fingerprint:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).optional(),
        sideEffectDisposition:z.enum(['not_executed','effect_started','effect_committed','unknown']).optional(),
        result: z.record(z.string(), z.unknown()).optional(),
        telecomState: z
          .enum([
            "RINGING",
            "DIALING",
            "ACTIVE",
            "DISCONNECTED",
            "FAILED",
            "UNKNOWN",
          ])
          .optional(),
      })
      .parse(req.body);
    if((b.sideEffectDisposition==='effect_committed'&&b.status!=='acked')||
       (['effect_started','unknown'] as const).includes(b.sideEffectDisposition as any)&&b.status!=='rejected')
      fail(400,'INVALID_SIDE_EFFECT_DISPOSITION','ACK status conflicts with the durable side-effect disposition');
    const value = await tx(db, async (c) => {
      const q = await c.query(
        `SELECT cmd.*,(cmd.expires_at<=now()) server_expired,g.device_epoch FROM commands cmd JOIN gateways g ON g.id=cmd.gateway_id WHERE cmd.id=$1 AND cmd.gateway_id=$2 FOR UPDATE OF cmd,g`,
        [commandId, p.gatewayId],
      );
      if (!q.rowCount) fail(404, "NOT_FOUND", "Command not found");
      const cmd = q.rows[0];
      let closeCallId: string | null = null;
      if (
        Number(cmd.generation) !== b.generation ||
        Number(cmd.device_epoch) !== b.generation
      )
        fail(409, "FENCE_REJECTED", "Command generation is stale");
      if(b.replayEvidence&&(b.replayEvidence.sequence!==Number(cmd.sequence)||b.replayEvidence.fingerprint!==commandReplayFingerprint(cmd,p.gatewayId)))
        fail(409,"REPLAY_EVIDENCE_MISMATCH","ACK identity does not match immutable command");
      const recordReplayReceipt=async(result:unknown)=>{
        if(!b.replayEvidence)return;
        const receiptResult=b.sideEffectDisposition===undefined?result:{_receiptVersion:2,result,sideEffectDisposition:b.sideEffectDisposition};
        await c.query(`INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result)VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[cmd.id,b.replayEvidence.fingerprint,b.status,JSON.stringify(receiptResult)]);
      };
      // S29 §2.2: no `cmd.call_id !== null` condition. Retention nulls `call_id` on a purged call and
      // the kind check already limits this to call commands; requiring the row would leave every
      // expired command of a deleted call without a receipt, i.e. blocking the replay horizon forever.
      const serverSmsBeforeDeviceAck=cmd.kind==='send_sms'&&b.replayEvidence!==undefined&&
        ['expired','rejected'].includes(cmd.status)&&Object.keys(cmd.result??{}).length===1&&
        ['sim_route_changed','expired'].includes(String(cmd.result?.reason))&&
        !(await c.query(`SELECT 1 FROM gateway_command_replay_receipts WHERE command_id=$1`,[cmd.id])).rowCount;
      const serverExpiredBeforeDeviceAck = serverSmsBeforeDeviceAck ||
        cmd.status === "expired" &&
        ["dial", "answer", "hangup"].includes(cmd.kind) &&
        cmd.server_expired === true &&
        cmd.result !== null &&
        typeof cmd.result === "object" &&
        !Array.isArray(cmd.result) &&
        Object.keys(cmd.result).length === 1 &&
        cmd.result.reason === "expired" &&
        b.status === "rejected" &&
        b.telecomState === undefined &&
        b.result?.phase === "not_executed" &&
        b.result?.reason === "command_expired" &&
        b.result?.executedAt == null &&
        b.result?.deviceCallId == null;
      if (cmd.status !== "pending") {
        if (!serverExpiredBeforeDeviceAck && cmd.status !== b.status)
          fail(409, "ACK_CONFLICT", "Command was already finalized with a different status");
        if (!serverExpiredBeforeDeviceAck) {
          // The first reconciliation ACK preserves server expiry metadata. It is
          // not part of the device's immutable ACK, and must not poison retries.
          const acceptedDeviceResult={...(cmd.result??{})};
          if(acceptedDeviceResult.serverFinalization)
            delete acceptedDeviceResult.serverFinalization;
          if(b.replayEvidence&&replayDigest(acceptedDeviceResult)!==replayDigest(b.result??{}))
            fail(409,"ACK_CONFLICT","Bound ACK result differs from accepted result");
          await recordReplayReceipt(cmd.result??{});
          return { command: { id: cmd.id, status: cmd.status, replayed: true } };
        }
      }
      const late = new Date(cmd.expires_at).getTime() < Date.now();
      const result = serverExpiredBeforeDeviceAck
        ? {
            ...(b.result ?? {}),
            serverFinalization: {
              status: cmd.status,
              result: cmd.result ?? null,
              expiresAt: new Date(cmd.expires_at).toISOString(),
            },
          }
        : b.result ?? {};
      await c.query(`UPDATE commands SET status=$2,result=$3 WHERE id=$1`, [
        cmd.id,
        b.status,
        JSON.stringify(result),
      ]);
      await recordReplayReceipt(result);
      if (cmd.call_id) {
        const current = (await c.query(`SELECT state,answered_at FROM call_records WHERE id=$1 FOR UPDATE`, [cmd.call_id])).rows[0];
        const aiAck = cmd.kind === "answer"
          ? await observeAiAnswerAck(c,{callId:cmd.call_id,commandId:cmd.id,status:b.status,telecomState:b.telecomState,generation:b.generation,onlineSeconds:config.GATEWAY_ONLINE_SECONDS})
          : {handled:false,restoredRinging:false};
        const rejection = b.status === "rejected" || b.telecomState === "FAILED";
        const explicitUnknown = b.telecomState === "UNKNOWN" || b.result?.phase === "unknown" ||
          ["execution_unknown", "side_effect_unknown"].includes(String(b.result?.reason ?? ""));
        const idempotentEndedHangup = cmd.kind === "hangup" && b.status === "rejected" &&
          b.telecomState === undefined && b.result?.reason === "call_already_ended" &&
          b.result?.phase === "not_executed" && current?.answered_at != null && current?.state !== "failed";
        // A rejected answer/hangup does not prove that the physical call has ended.
        // The narrow exception is an answered call for which the device explicitly says
        // hangup was not executed because Telecom had already ended it.
        const uncertain = b.telecomState !== "DISCONNECTED" && (explicitUnknown ||
          (rejection && (cmd.kind !== "dial" || current?.state !== "outgoing_pending")));
        if (aiAck.restoredRinging) {
          // A current-epoch fresh Telecom snapshot proves the answer had no side effect.
          // The original AI run is terminal and can never retry; humans may still claim.
        } else if (idempotentEndedHangup) {
          closeCallId = cmd.call_id;
          await c.query(
            `UPDATE call_records SET state='ended',ended_at=COALESCE(ended_at,now()),failure_reason=NULL,
             gateway_time_zone=COALESCE(gateway_time_zone,(SELECT time_zone FROM gateways WHERE id=call_records.gateway_id))
             WHERE id=$1 AND state NOT IN ('ended','failed')`,
            [cmd.call_id],
          );
          await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`, [
            cmd.call_id,
          ]);
        } else if (uncertain) {
          closeCallId = cmd.call_id;
          await c.query(
            `UPDATE call_records SET state='unknown',failure_reason=$2 WHERE id=$1 AND state NOT IN ('ended','failed')`,
            [cmd.call_id, String(b.result?.reason ?? "execution_unknown")],
          );
          // Keep the gateway lock until a real Telecom end observation reconciles it.
        } else if (rejection && b.telecomState !== "DISCONNECTED") {
          closeCallId = cmd.call_id;
          await c.query(
            `UPDATE call_records SET state='failed',failure_reason=$2,ended_at=now(),
             gateway_time_zone=COALESCE(gateway_time_zone,(SELECT time_zone FROM gateways WHERE id=call_records.gateway_id))
             WHERE id=$1 AND state NOT IN ('ended','failed')`,
            [cmd.call_id, String(b.result?.reason ?? "device_rejected")],
          );
          await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`, [
            cmd.call_id,
          ]);
        } else if (b.telecomState === "ACTIVE") {
          await c.query(
            `UPDATE call_records SET state='active',answered_at=COALESCE(answered_at,now()) WHERE id=$1 AND state NOT IN ('ending','ended','failed')`,
            [cmd.call_id],
          );
        } else if (b.telecomState === "DISCONNECTED") {
          closeCallId = cmd.call_id;
          await c.query(
            `UPDATE call_records SET state='ended',ended_at=now(),
             gateway_time_zone=COALESCE(gateway_time_zone,(SELECT time_zone FROM gateways WHERE id=call_records.gateway_id))
             WHERE id=$1 AND state NOT IN ('ended','failed')`,
            [cmd.call_id],
          );
          await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`, [
            cmd.call_id,
          ]);
        } else if (cmd.kind === "dial") {
          await c.query(
            `UPDATE call_records SET state='connecting' WHERE id=$1 AND state IN ('outgoing_pending','incoming_ringing','connecting')`,
            [cmd.call_id],
          );
        }
        if (!aiAck.restoredRinging && idempotentEndedHangup) await observeAiCallState(c,cmd.call_id,"ended");
        else if (!aiAck.restoredRinging && b.telecomState === "ACTIVE") await observeAiCallState(c,cmd.call_id,"active");
        else if (!aiAck.restoredRinging && b.telecomState === "DISCONNECTED") await observeAiCallState(c,cmd.call_id,"ended");
        else if (!aiAck.restoredRinging && uncertain) await observeAiCallState(c,cmd.call_id,"unknown");
      }
      if (cmd.kind === "send_sms") {
        await c.query(`UPDATE sms_dispatch_queue SET first_delivery_at=COALESCE(first_delivery_at,clock_timestamp()) WHERE command_id=$1`,[cmd.id]);
        const unknown=b.sideEffectDisposition==='unknown'||b.sideEffectDisposition==='effect_started'||
          b.result?.phase==='unknown'||['execution_unknown','side_effect_unknown'].includes(String(b.result?.reason??''));
        const noEffect=b.sideEffectDisposition==='not_executed'||b.result?.phase==='not_executed';
        if(!unknown&&(b.status==='acked'||noEffect))await observeSmsAck(c,p.gatewayId,cmd.id);
      }
      if (cmd.sms_id) {
        if (b.status === "acked")
          await c.query(
            `UPDATE sms_messages SET state='sending' WHERE id=$1 AND state='queued'`,
            [cmd.sms_id],
          );
        else {
          const reason = String(b.result?.reason ?? "device_rejected");
          const uncertain = reason === "execution_unknown" || reason === "side_effect_unknown" || b.sideEffectDisposition==='unknown' || b.sideEffectDisposition==='effect_started' || b.result?.phase==='unknown' || (b.sideEffectDisposition!=='not_executed'&&b.result?.phase!=='not_executed');
          await c.query(
            `UPDATE sms_messages SET state=$2::sms_state,failure_reason=$3
             WHERE id=$1 AND state IN ('queued','sending') RETURNING id`,
            [cmd.sms_id, uncertain ? "unknown" : "failed", reason],
          ).then(async (r) => { await smsFailed(c, r.rows.map((row) => row.id)); });
        }
      }
      if (cmd.kind === "apply_sim_settings" && cmd.sim_id && b.status === "acked") {
        const payload = cmd.payload as {
          simId?: string;
          settingsVersion?: number;
          assignmentVersion?: number;
        };
        const result = b.result as {
          simId?: unknown;
          appliedVersion?: unknown;
          assignmentVersion?: unknown;
        } | undefined;
        const settingsVersion = Number(payload.settingsVersion);
        const assignmentVersion = Number(payload.assignmentVersion);
        if (
          payload.simId === cmd.sim_id &&
          Number.isSafeInteger(settingsVersion) && settingsVersion > 0 &&
          Number.isSafeInteger(assignmentVersion) && assignmentVersion > 0 &&
          result !== undefined && result.simId === cmd.sim_id &&
          Number(result.appliedVersion) === settingsVersion &&
          Number(result.assignmentVersion) === assignmentVersion
        ) {
          await c.query(
            `UPDATE sim_settings st
             SET applied_version=$3,applied_assignment_version=$4,applied_generation=$5
             FROM sims s
             WHERE st.sim_id=$1 AND s.id=st.sim_id AND s.gateway_id=$2
               AND s.owner_user_id IS NOT NULL AND s.device_present AND NOT s.assignment_pending
               AND s.version=$4 AND st.version=$3`,
            [
              cmd.sim_id,
              cmd.gateway_id,
              settingsVersion,
              assignmentVersion,
              Number(cmd.generation),
            ],
          );
        }
      }
      return { command: { id: cmd.id, status: b.status, replayed: false, late }, closeCallId,
        ack: { kind: String(cmd.kind), createdAt: String(cmd.created_at), callId: (cmd.call_id as string | null) ?? null } };
    });
    if (value.closeCallId)
      await requestMediaClose(db, media, value.closeCallId);
    // S36 C3: insert -> device ACK latency, the one number that says whether a command reached the phone.
    if (value.ack)
      diag(db, "command.ack", { kind: value.ack.kind, status: b.status, ms: Date.now() - new Date(value.ack.createdAt).getTime() }, { callId: value.ack.callId });
    return { command: value.command };
  });
  app.post("/api/v1/gateway/calls/:callId/events", async (req) => {
    const p = requireDevice(req);
    const { callId } = z.object({ callId: z.uuid() }).parse(req.params);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        state: z.enum(["connecting", "active", "ended", "failed", "unknown"]),
        failureReason: z.string().max(500).optional(),
      })
      .parse(req.body);
    const value = await tx(db, async (c) => {
      const g = await c.query(
        `SELECT device_epoch FROM gateways WHERE id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      if (Number(g.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");
      const fingerprint = requestFingerprint(b);
      const prior = await c.query(
        `SELECT event_type,resource_id,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        const saved = prior.rows[0];
        const savedFingerprint = saved.payload?.requestFingerprint;
        if (
          saved.event_type !== "call.state" ||
          saved.resource_id !== callId ||
          (savedFingerprint
            ? savedFingerprint !== fingerprint
            : !sameJsonPayload(saved.payload, b))
        )
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        return { accepted: true, replayed: true };
      }
      const call = await c.query(
        `SELECT state FROM call_records WHERE id=$1 AND gateway_id=$2 FOR UPDATE`,
        [callId, p.gatewayId],
      );
      if (!call.rowCount) fail(404, "NOT_FOUND", "Call not found");
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)VALUES($1,$2,'call.state',$3,$4)`,
        [p.gatewayId, b.eventId, callId, JSON.stringify({ requestFingerprint: fingerprint })],
      );
      if (b.state === "active") await markDeviceAnswer(c, callId);
      if (b.state === "active")
        await c.query(
          `UPDATE call_records SET state='active',answered_at=COALESCE(answered_at,now()) WHERE id=$1 AND state NOT IN ('ending','ended','failed')`,
          [callId],
        );
      else if (b.state === "ended" || b.state === "failed") {
        await c.query(
          `UPDATE call_records SET state=$2::call_state,ended_at=COALESCE(ended_at,now()),failure_reason=COALESCE($3,failure_reason),
           gateway_time_zone=COALESCE(gateway_time_zone,(SELECT time_zone FROM gateways WHERE id=call_records.gateway_id))
           WHERE id=$1 AND (state NOT IN ('ended','failed') OR state=$2::call_state)`,
          [callId, b.state, b.failureReason ?? null],
        );
        await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`, [
          callId,
        ]);
      } else
        await c.query(
          `UPDATE call_records SET state=$2::call_state,failure_reason=COALESCE($3,failure_reason) WHERE id=$1 AND
           (($2='connecting' AND state IN ('incoming_ringing','outgoing_pending','connecting')) OR
            ($2='unknown' AND state NOT IN ('ended','failed')))`,
          [callId, b.state, b.failureReason ?? null],
        );
      if (["active", "ended", "failed", "unknown"].includes(b.state))
        await observeAiCallState(c, callId, b.state as "active" | "ended" | "failed" | "unknown");
      return { accepted: true, replayed: false };
    });
    if ((b.state === "ended" || b.state === "failed") && !value.replayed)
      await requestMediaClose(db, media, callId);
    return value;
  });
  app.post("/api/v1/gateway/sms/:smsId/events", async (req) => {
    const p = requireDevice(req);
    const { smsId } = z.object({ smsId: z.uuid() }).parse(req.params);
    const b = z
      .object({
        eventId: z.uuid(),
        generation: z.number().int().positive(),
        state: z.enum(["sending", "sent", "delivered", "failed", "unknown"]),
        failureReason: z.string().max(500).optional(),
      })
      .parse(req.body);
    return tx(db, async (c) => {
      const g = await c.query(
        `SELECT device_epoch FROM gateways WHERE id=$1 FOR UPDATE`,
        [p.gatewayId],
      );
      if (Number(g.rows[0].device_epoch) !== b.generation)
        fail(409, "FENCE_REJECTED", "Device epoch is stale");
      const fingerprint = requestFingerprint(b);
      const prior = await c.query(
        `SELECT event_type,resource_id,payload FROM device_events WHERE gateway_id=$1 AND event_id=$2`,
        [p.gatewayId, b.eventId],
      );
      if (prior.rowCount) {
        const saved = prior.rows[0];
        const savedFingerprint = saved.payload?.requestFingerprint;
        if (
          saved.event_type !== "sms.state" ||
          saved.resource_id !== smsId ||
          (savedFingerprint
            ? savedFingerprint !== fingerprint
            : !sameJsonPayload(saved.payload, b))
        )
          fail(409, "EVENT_ID_REUSED", "Event ID was reused with different parameters");
        return { accepted: true, replayed: true };
      }
      const exists = await c.query(
        `SELECT 1 FROM sms_messages WHERE id=$1 AND gateway_id=$2 FOR UPDATE`,
        [smsId, p.gatewayId],
      );
      if (!exists.rowCount) {
        const deleted = await c.query(
          `SELECT gateway_generation FROM sms_deletion_tombstones WHERE sms_id=$1 AND gateway_id=$2 FOR UPDATE`,
          [smsId, p.gatewayId],
        );
        if (!deleted.rowCount) fail(404, "NOT_FOUND", "SMS not found");
        if (Number(deleted.rows[0].gateway_generation) !== b.generation)
          fail(409, "DELETION_GENERATION_MISMATCH", "Deleted SMS belongs to another gateway generation");
        await c.query(
          `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)VALUES($1,$2,'sms.state',$3,$4)`,
          [p.gatewayId, b.eventId, smsId, JSON.stringify({ requestFingerprint: fingerprint })],
        );
        return { accepted: true, replayed: false, ignored: true };
      }
      await c.query(
        `INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload)VALUES($1,$2,'sms.state',$3,$4)`,
        [p.gatewayId, b.eventId, smsId, JSON.stringify({ requestFingerprint: fingerprint })],
      );
      const q = await c.query(
        `UPDATE sms_messages SET state=$3::sms_state,sent_at=CASE WHEN $3 IN ('sent','delivered') THEN COALESCE(sent_at,now()) ELSE sent_at END,delivered_at=CASE WHEN $3='delivered' THEN COALESCE(delivered_at,now()) ELSE delivered_at END,failure_reason=CASE WHEN $3 IN ('sent','delivered') THEN NULL ELSE COALESCE($4,failure_reason) END
         WHERE id=$1 AND gateway_id=$2 AND
         (($3='sending' AND state IN ('queued','sending')) OR
          ($3='sent' AND state IN ('queued','sending','sent','unknown')) OR
          ($3='delivered' AND state IN ('queued','sending','sent','delivered','unknown')) OR
          ($3 IN ('failed','unknown') AND state IN ('queued','sending','unknown'))) RETURNING id`,
        [smsId, p.gatewayId, b.state, b.failureReason ?? null],
      );
      if (q.rowCount && (b.state === "failed" || b.state === "unknown")) await smsFailed(c, [smsId]);
      if(['sent','delivered','failed'].includes(b.state)){
        const active=(await c.query(`SELECT cmd.id FROM gateway_sms_pacing pace JOIN commands cmd ON cmd.id=pace.command_id
          WHERE pace.gateway_id=$1 AND cmd.sms_id=$2 AND cmd.generation=$3`,[p.gatewayId,smsId,b.generation])).rows[0];
        if(active)await observeSmsAck(c,p.gatewayId,active.id);
      }
      if (!q.rowCount) {
        // Existing terminal or later state: accept the event without regressing it.
      }
      return { accepted: true, replayed: false };
    });
  });
}
