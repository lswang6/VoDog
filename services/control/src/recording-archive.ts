import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { diag, errorReason } from "./diag.js";
import { markClientBroken, safeRollback, withClient, type Db } from "./db.js";
import { callDeletionDetails, readCallDeletionProof } from "./deletion-proof.js";
import {
  recordingByteRange,
  RecordingStoreError,
  type RecordingTrack,
} from "./recording-store.js";
import {
  RecordingFileVerificationBusyError,
  RecordingFileVerificationError,
  RecordingFileVerifier,
} from "./recording-file-verifier.js";

const executeFile = promisify(execFile);
class InvalidArchive extends Error {}
class ValidatorUnavailable extends Error {}
const uuid = z.uuid(),
  sha = z.string().regex(/^[0-9a-f]{64}$/),
  safePositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const objectNames = [
  "remote_original.wav.gz",
  "caller_original.wav.gz",
  "timeline.jsonl.gz",
  "caller_playout.wav.gz",
  "caller_uplink.wav.gz",
] as const;
type ObjectName = (typeof objectNames)[number];
const captureInput = z.object({
  deviceCallId: z.string().min(1).max(200),
  telecomCreationTimeMillis: safePositive,
});
export type CaptureInput = z.infer<typeof captureInput>;
export type CaptureBinding = {
  id: string;
  callId: string;
  deviceCallId: string;
  telecomCreationTimeMillis: number;
  captureGeneration: number;
  mediaNodeId: string;
  mediaEpoch: number;
  createdAt: string;
};

const originalTrack = z
  .object({
    track: z.enum(["remote_original", "caller_original"]),
    objectName: z.enum(["remote_original.wav.gz", "caller_original.wav.gz"]),
    mediaType: z.literal("audio/wav"),
    pcm: z.object({
      sampleRate: z.literal(16000),
      channels: z.literal(1),
      bitsPerSample: z.literal(16),
      encoding: z.literal("pcm_s16le"),
    }),
    compressedBytes: safePositive.max(512 * 1024 * 1024),
    compressedSha256: sha,
    originalBytes: safePositive.max(512 * 1024 * 1024),
    originalSha256: sha,
    pcmBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024),
    gapCount: z.number().int().nonnegative(),
    droppedFrames: z.number().int().nonnegative(),
    captureComplete: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.objectName !== `${value.track}.wav.gz`)
      ctx.addIssue({
        code: "custom",
        path: ["objectName"],
        message: "Track object name does not match track",
      });
    if (value.originalBytes !== value.pcmBytes + 44)
      ctx.addIssue({
        code: "custom",
        path: ["originalBytes"],
        message: "WAV byte count does not match PCM byte count",
      });
    if (value.pcmBytes % 2 !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["pcmBytes"],
        message: "PCM byte count must contain complete 16-bit samples",
      });
  });
// S94: owner-side VOICE_UPLINK capture. Same facts as an original track, its own role, never in `tracks`.
const uplinkTrack = z
  .object({
    track: z.literal("caller_uplink"),
    sourceRole: z.literal("uplink_capture"),
    objectName: z.literal("caller_uplink.wav.gz"),
    mediaType: z.literal("audio/wav"),
    pcm: z.object({
      sampleRate: z.literal(16000),
      channels: z.literal(1),
      bitsPerSample: z.literal(16),
      encoding: z.literal("pcm_s16le"),
    }),
    compressedBytes: safePositive.max(512 * 1024 * 1024),
    compressedSha256: sha,
    originalBytes: safePositive.max(512 * 1024 * 1024),
    originalSha256: sha,
    pcmBytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
    gapCount: z.number().int().nonnegative(),
    droppedFrames: z.number().int().nonnegative(),
    captureComplete: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.originalBytes !== value.pcmBytes + 44)
      ctx.addIssue({ code: "custom", path: ["originalBytes"], message: "WAV byte count does not match PCM byte count" });
    if (value.pcmBytes % 2 !== 0)
      ctx.addIssue({ code: "custom", path: ["pcmBytes"], message: "PCM byte count must contain complete 16-bit samples" });
  });
const timeline = z.object({
  objectName: z.literal("timeline.jsonl.gz"),
  mediaType: z.literal("application/x-ndjson"),
  compressedBytes: safePositive.max(32 * 1024 * 1024),
  compressedSha256: sha,
  originalBytes: safePositive.max(32 * 1024 * 1024),
  originalSha256: sha,
});
const derivedTrack = z
  .object({
    track: z.literal("caller_playout"),
    sourceRole: z.literal("derived_playout"),
    objectName: z.literal("caller_playout.wav.gz"),
    mediaType: z.literal("audio/wav"),
    pcm: z.object({
      sampleRate: z.literal(16000),
      channels: z.literal(1),
      bitsPerSample: z.literal(16),
      encoding: z.literal("pcm_s16le"),
    }),
    compressedBytes: safePositive.max(512 * 1024 * 1024),
    compressedSha256: sha,
    originalBytes: safePositive.max(512 * 1024 * 1024),
    originalSha256: sha,
    pcmBytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
    gapCount: z.number().int().nonnegative(),
    recoveryFrames: z.number().int().nonnegative(),
    playoutComplete: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.originalBytes !== value.pcmBytes + 44)
      ctx.addIssue({ code: "custom", path: ["originalBytes"], message: "WAV byte count does not match PCM byte count" });
    if (value.pcmBytes % 2 !== 0)
      ctx.addIssue({ code: "custom", path: ["pcmBytes"], message: "PCM byte count must contain complete 16-bit samples" });
  });
const manifestBase = z.object({
    captureBinding: z.object({
      id: uuid,
      deviceCallId: z.string().min(1).max(200),
      telecomCreationTimeMillis: safePositive,
      captureGeneration: safePositive,
    }),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    terminalState: z.enum([
      "ended",
      "failed",
      "incomplete",
      "recovered_incomplete",
    ]),
    tracks: z.array(originalTrack).length(2),
    timeline,
    sessionStats: z
      .object({
        networkSendDrops: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        remotePacketDrops: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        injectionDrops: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        transportMissingPackets: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict()
      .default({}),
  });
const manifestInput = z
  .discriminatedUnion("version", [
    manifestBase.extend({ version: z.literal(2) }).strict(),
    manifestBase.extend({ version: z.literal(3), derivedTracks: z.array(derivedTrack).length(1) }).strict(),
    // S94: derived playout stays optional (absent = none; `[]` is rejected), the uplink is exactly one.
    manifestBase.extend({
      version: z.literal(4),
      derivedTracks: z.array(derivedTrack).length(1).optional(),
      uplinkTracks: z.array(uplinkTrack).length(1),
    }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (new Set(value.tracks.map((item) => item.track)).size !== 2)
      ctx.addIssue({
        code: "custom",
        path: ["tracks"],
        message: "Both fixed tracks are required exactly once",
      });
    if (Date.parse(value.endedAt) < Date.parse(value.startedAt))
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "endedAt precedes startedAt",
      });
  });
type ManifestInput = z.infer<typeof manifestInput>;
const pixelDescriptor = z.object({
  source: z.literal("pixel"),
  version: z.union([z.literal(2), z.literal(3)]),
  archiveId: uuid,
  callId: uuid,
  manifestSha256: sha,
  archiveComplete: z.literal(true),
  captureComplete: z.boolean(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  tracks: z
    .array(
      z.object({
        track: z.enum(["remote_original", "caller_original"]),
        sourceRole: z.literal("original_capture"),
        mediaType: z.literal("audio/wav"),
        bytes: safePositive,
        sha256: sha,
        captureComplete: z.boolean(),
        gapCount: z.number().int().nonnegative(),
        droppedFrames: z.number().int().nonnegative(),
      }),
    )
    .length(2),
  derivedTracks: z.array(z.object({
    track: z.literal("caller_playout"),
    sourceRole: z.literal("derived_playout"),
    mediaType: z.literal("audio/wav"),
    bytes: safePositive,
    sha256: sha,
    playoutComplete: z.boolean(),
    gapCount: z.number().int().nonnegative(),
    recoveryFrames: z.number().int().nonnegative(),
  })).length(1).optional(),
  // S94: v4 archives only. `version` stays 2/3 and `tracks` stays the two originals so every
  // released decoder keeps reading them; these two keys are present together or not at all.
  archiveVersion: z.literal(4).optional(),
  uplinkTracks: z.array(z.object({
    track: z.literal("caller_uplink"),
    sourceRole: z.literal("uplink_capture"),
    mediaType: z.literal("audio/wav"),
    bytes: safePositive,
    sha256: sha,
    captureComplete: z.boolean(),
    gapCount: z.number().int().nonnegative(),
    droppedFrames: z.number().int().nonnegative(),
  })).length(1).optional(),
  timeline: z.object({
    mediaType: z.literal("application/x-ndjson"),
    bytes: safePositive,
    sha256: sha,
  }),
}).superRefine((value, ctx) => {
  if ((value.archiveVersion === undefined) !== (value.uplinkTracks === undefined))
    ctx.addIssue({ code: "custom", path: ["uplinkTracks"], message: "Uplink tracks and archiveVersion must appear together" });
  if ((value.version === 2) !== (value.derivedTracks === undefined))
    ctx.addIssue({ code: "custom", path: ["derivedTracks"], message: "Derived tracks must match manifest version" });
  if (new Set(value.tracks.map((item) => item.track)).size !== 2)
    ctx.addIssue({ code: "custom", path: ["tracks"], message: "Both original tracks are required exactly once" });
  if (value.captureComplete !== value.tracks.every((item) => item.captureComplete))
    ctx.addIssue({ code: "custom", path: ["captureComplete"], message: "Capture completeness must come only from original tracks" });
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt))
    ctx.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt precedes startedAt" });
});
export type PixelRecordingDescriptor = z.infer<typeof pixelDescriptor>;
export type PixelTrack = RecordingTrack | "caller_playout" | "caller_uplink";
export function parsePixelRecordingDescriptor(value: unknown): PixelRecordingDescriptor {
  return pixelDescriptor.parse(value);
}

export type ArchiveRouteDeps = {
  enabled: boolean;
  root?: string;
  validatorPath?: string;
  maxBytesPerArchive?: number;
  maxBytesPerGateway?: number;
  maxBytesPerOwner?: number;
  maxPendingPerGateway?: number;
  minFreeBytes?: number;
  finalizeConcurrency?: number;
  requireGateway(request: FastifyRequest): { gatewayId: string };
  requireUser(request: FastifyRequest): { userId: string };
  fail(status: number, code: string, message: string, details?: unknown): never;
  /** Fire and forget after a finalize answers `complete` (a replayed finalize too); must not throw. */
  onArchived?(callId: string): void;
  /** Test seam: runs after a chunk is on disk and before the committed-offset CAS. */
  onChunkWritten?(uploadId: string, objectName: string): Promise<void>;
};

const defaultLimits = {
  maxBytesPerArchive: 2415919104,
  maxBytesPerGateway: 21474836480,
  maxBytesPerOwner: 10737418240,
  maxPendingPerGateway: 2,
  minFreeBytes: 1073741824,
  finalizeConcurrency: 1,
};

function archiveLimits(deps: ArchiveRouteDeps) {
  return {
    maxBytesPerArchive:
      deps.maxBytesPerArchive ?? defaultLimits.maxBytesPerArchive,
    maxBytesPerGateway:
      deps.maxBytesPerGateway ?? defaultLimits.maxBytesPerGateway,
    maxBytesPerOwner: deps.maxBytesPerOwner ?? defaultLimits.maxBytesPerOwner,
    maxPendingPerGateway:
      deps.maxPendingPerGateway ?? defaultLimits.maxPendingPerGateway,
    minFreeBytes: deps.minFreeBytes ?? defaultLimits.minFreeBytes,
    finalizeConcurrency:
      deps.finalizeConcurrency ?? defaultLimits.finalizeConcurrency,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const bindingDto = (r: any): CaptureBinding => ({
  id: r.id,
  callId: r.call_id,
  deviceCallId: r.device_call_id,
  telecomCreationTimeMillis: Number(r.telecom_creation_time_millis),
  captureGeneration: Number(r.capture_generation),
  mediaNodeId: r.media_node_id,
  mediaEpoch: Number(r.media_epoch),
  createdAt: new Date(r.created_at).toISOString(),
});

/** Must be called inside the current gateway media authorization transaction after its node is fixed. */
export async function ensureCaptureBinding(
  c: PoolClient,
  input: {
    enabled: boolean;
    gatewayId: string;
    call: any;
    capture?: unknown;
    onlineSeconds: number;
    fail: ArchiveRouteDeps["fail"];
  },
): Promise<CaptureBinding | undefined> {
  if (!input.enabled) return undefined;
  const capture = captureInput.safeParse(input.capture);
  if (!capture.success)
    input.fail(
      409,
      "CAPTURE_BINDING_REQUIRED",
      "Gateway must provide a durable recording capture identity",
    );
  const call = input.call;
  if (!call.device_call_id || call.device_call_id !== capture.data.deviceCallId)
    input.fail(
      409,
      "CAPTURE_BINDING_CONFLICT",
      "Capture device call does not match the authorized call",
    );
  if (call.state !== "active")
    input.fail(
      409,
      "CAPTURE_NOT_ACTIVE",
      "Recording capture requires a confirmed active call",
    );
  const snapshot = await c.query(
    `SELECT calls,observed_at>=now()-$3::int*interval '1 second' fresh FROM gateway_telecom_snapshots WHERE gateway_id=$1 AND generation=$2 FOR UPDATE`,
    [input.gatewayId, Number(call.device_epoch), input.onlineSeconds],
  );
  const matches =
    snapshot.rowCount && snapshot.rows[0].fresh
      ? (snapshot.rows[0].calls as any[]).filter(
          (item) =>
            item.callId === call.id &&
            item.deviceCallId === capture.data.deviceCallId &&
            item.state === "active",
        )
      : [];
  if (matches.length !== 1)
    input.fail(
      409,
      "CAPTURE_NOT_CONFIRMED",
      "A fresh unique active Telecom call is required",
    );
  const inserted = await c.query(
    `INSERT INTO recording_capture_bindings(call_id,gateway_id,snapshot_owner_id,device_call_id,telecom_creation_time_millis,capture_generation,media_node_id,media_epoch)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(call_id) DO NOTHING RETURNING *`,
    [
      call.id,
      input.gatewayId,
      call.snapshot_owner_id,
      capture.data.deviceCallId,
      capture.data.telecomCreationTimeMillis,
      Number(call.device_epoch),
      call.media_node_id,
      Number(call.media_epoch),
    ],
  );
  const row =
    inserted.rows[0] ??
    (
      await c.query(
        `SELECT * FROM recording_capture_bindings WHERE call_id=$1 FOR UPDATE`,
        [call.id],
      )
    ).rows[0];
  if (
    !row ||
    row.gateway_id !== input.gatewayId ||
    row.device_call_id !== capture.data.deviceCallId ||
    Number(row.telecom_creation_time_millis) !==
      capture.data.telecomCreationTimeMillis ||
    Number(row.capture_generation) !== Number(call.device_epoch) ||
    row.media_node_id !== call.media_node_id ||
    Number(row.media_epoch) !== Number(call.media_epoch)
  )
    input.fail(
      409,
      "CAPTURE_BINDING_CONFLICT",
      "This call already has a different recording capture",
    );
  return bindingDto(row);
}

function archiveDto(r: any, objects: any[]) {
  return {
    id: r.id,
    state: r.state,
    manifestSha256: r.client_manifest_sha256,
    objects: objects.map((o) => ({
      name: o.object_name,
      committedOffset: Number(o.committed_offset),
      expectedBytes: Number(o.compressed_bytes),
      state: o.state,
    })),
  };
}
function objectMetadata(body: ManifestInput) {
  return [
    ...body.tracks.map((item) => ({
      name: item.objectName,
      kind: "wav",
      compressedBytes: item.compressedBytes,
      compressedSha256: item.compressedSha256,
      originalBytes: item.originalBytes,
      originalSha256: item.originalSha256,
    })),
    ...(body.version === 2 ? [] : [...(body.derivedTracks ?? []), ...(body.version === 4 ? body.uplinkTracks : [])].map((item) => ({
      name: item.objectName,
      kind: "wav",
      compressedBytes: item.compressedBytes,
      compressedSha256: item.compressedSha256,
      originalBytes: item.originalBytes,
      originalSha256: item.originalSha256,
    }))),
    {
      name: body.timeline.objectName,
      kind: "timeline",
      compressedBytes: body.timeline.compressedBytes,
      compressedSha256: body.timeline.compressedSha256,
      originalBytes: body.timeline.originalBytes,
      originalSha256: body.timeline.originalSha256,
    },
  ];
}
function frozenManifest(archive: any): ManifestInput {
  const parsed = manifestInput.safeParse(archive.client_manifest);
  if (!parsed.success) throw new InvalidArchive("stored manifest is invalid");
  const normalized: ManifestInput = {
    ...parsed.data,
    startedAt: new Date(parsed.data.startedAt).toISOString(),
    endedAt: new Date(parsed.data.endedAt).toISOString(),
  };
  if (fingerprint(normalized) !== archive.client_manifest_sha256)
    throw new InvalidArchive("stored manifest fingerprint mismatch");
  return normalized;
}
function exactObjectFacts(body: ManifestInput, objects: any[]) {
  const expected = objectMetadata(body);
  if (objects.length !== expected.length)
    throw new InvalidArchive("recording object count mismatch");
  for (const item of expected) {
    const row = objects.find(
      (candidate) => candidate.object_name === item.name,
    );
    if (
      !row ||
      row.kind !== item.kind ||
      Number(row.compressed_bytes) !== item.compressedBytes ||
      row.compressed_sha256 !== item.compressedSha256 ||
      Number(row.original_bytes) !== item.originalBytes ||
      row.original_sha256 !== item.originalSha256
    )
      throw new InvalidArchive("recording object metadata mismatch");
  }
}
function expectedPixelDescriptor(
  archive: any,
  body: ManifestInput,
): PixelRecordingDescriptor {
  return {
    source: "pixel",
    version: body.version !== 2 && body.derivedTracks ? 3 : 2,
    archiveId: archive.id,
    callId: archive.call_id,
    manifestSha256: archive.client_manifest_sha256,
    archiveComplete: true,
    captureComplete: body.tracks.every((item) => item.captureComplete),
    startedAt: body.startedAt,
    endedAt: body.endedAt,
    tracks: body.tracks.map((item) => ({
      track: item.track,
      sourceRole: "original_capture" as const,
      mediaType: "audio/wav",
      bytes: item.originalBytes,
      sha256: item.originalSha256,
      captureComplete: item.captureComplete,
      gapCount: item.gapCount,
      droppedFrames: item.droppedFrames,
    })),
    ...(body.version !== 2 && body.derivedTracks ? { derivedTracks: body.derivedTracks.map((item) => ({
      track: item.track,
      sourceRole: item.sourceRole,
      mediaType: item.mediaType,
      bytes: item.originalBytes,
      sha256: item.originalSha256,
      playoutComplete: item.playoutComplete,
      gapCount: item.gapCount,
      recoveryFrames: item.recoveryFrames,
    })) } : {}),
    ...(body.version === 4 ? { archiveVersion: 4 as const, uplinkTracks: body.uplinkTracks.map((item) => ({
      track: item.track,
      sourceRole: item.sourceRole,
      mediaType: item.mediaType,
      bytes: item.originalBytes,
      sha256: item.originalSha256,
      captureComplete: item.captureComplete,
      gapCount: item.gapCount,
      droppedFrames: item.droppedFrames,
    })) } : {}),
    timeline: {
      mediaType: "application/x-ndjson",
      bytes: body.timeline.originalBytes,
      sha256: body.timeline.originalSha256,
    },
  };
}

/** Response-only PCM duration. Must never enter expectedPixelDescriptor or published fingerprint. */
function withPixelDurationMs(
  expected: PixelRecordingDescriptor,
  body: ManifestInput,
): PixelRecordingDescriptor {
  const pcmByTrack = new Map(body.tracks.map((item) => [item.track, item.pcmBytes] as const));
  const tracks = expected.tracks.map((track) => ({
    ...track,
    durationMs: Math.floor((pcmByTrack.get(track.track) ?? 0) / 32),
  }));
  const withDuration = <T extends { track: string }>(items: T[], source: { track: string; pcmBytes: number }[]) =>
    items.map((track) => ({
      ...track,
      durationMs: Math.floor((source.find((item) => item.track === track.track)?.pcmBytes ?? 0) / 32),
    }));
  const derived = body.version === 2 ? undefined : body.derivedTracks;
  return {
    ...expected,
    tracks,
    ...(expected.derivedTracks && derived ? { derivedTracks: withDuration(expected.derivedTracks, derived) } : {}),
    ...(expected.uplinkTracks && body.version === 4 ? { uplinkTracks: withDuration(expected.uplinkTracks, body.uplinkTracks) } : {}),
  };
}
async function fsyncDir(path: string) {
  const d = await open(path, constants.O_RDONLY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
async function assertDirectory(path: string) {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink())
    throw new RecordingStoreError("RECORDING_CORRUPT");
}
async function availableBytes(root: string, fail: ArchiveRouteDeps["fail"]) {
  try {
    const value = await statfs(root, { bigint: true });
    return value.bavail * value.bsize;
  } catch {
    fail(
      503,
      "PIXEL_ARCHIVE_STORAGE_UNAVAILABLE",
      "Recording archive storage is unavailable",
    );
  }
}
function requireAvailableBytes(
  available: bigint,
  requiredBytes: number | bigint,
  fail: ArchiveRouteDeps["fail"],
) {
  const required =
    typeof requiredBytes === "bigint" ? requiredBytes : BigInt(requiredBytes);
  if (available < required)
    fail(
      507,
      "PIXEL_ARCHIVE_STORAGE_LOW",
      "Recording archive storage is below its reserved free-space limit",
    );
}
async function requireFreeBytes(
  root: string,
  requiredBytes: number | bigint,
  fail: ArchiveRouteDeps["fail"],
) {
  requireAvailableBytes(await availableBytes(root, fail), requiredBytes, fail);
}
async function assertArchiveDir(
  root: string,
  callId: string,
  archiveId: string,
) {
  const callDir = join(root, callId),
    archiveDir = join(callDir, archiveId);
  await assertDirectory(root);
  await assertDirectory(callDir);
  await assertDirectory(archiveDir);
  return archiveDir;
}
async function ensureArchiveDir(
  root: string,
  callId: string,
  archiveId: string,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root);
  const callDir = join(root, callId);
  let created = false;
  try {
    await mkdir(callDir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(callDir);
  if (created) await fsyncDir(root);
  const archiveDir = join(callDir, archiveId);
  created = false;
  try {
    await mkdir(archiveDir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(archiveDir);
  if (created) await fsyncDir(callDir);
  await fsyncDir(archiveDir);
  return archiveDir;
}
async function hashFile(path: string) {
  const h = createHash("sha256"),
    f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of f.createReadStream({ autoClose: false }))
      h.update(chunk);
  } finally {
    await f.close();
  }
  return h.digest("hex");
}

export function registerRecordingArchiveRoutes(
  app: FastifyInstance,
  db: Db,
  deps: ArchiveRouteDeps,
) {
  // One writer per archive object at a time, so chunk file I/O needs no open transaction.
  const objectWrites = new Map<string, Promise<void>>();
  const serializeObjectWrite = <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = objectWrites.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    objectWrites.set(key, tail);
    void tail.then(() => {
      if (objectWrites.get(key) === tail) objectWrites.delete(key);
    });
    return result;
  };
  const unavailable = () => {
    if (!deps.enabled)
      deps.fail(
        503,
        "PIXEL_ARCHIVE_DISABLED",
        "Pixel recording archive is not enabled",
      );
    if (!deps.root || !deps.validatorPath)
      deps.fail(
        503,
        "PIXEL_ARCHIVE_NOT_CONFIGURED",
        "Pixel recording archive is not configured",
      );
    return { root: deps.root!, validator: deps.validatorPath! };
  };
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post("/api/v1/gateway/calls/:callId/recording-archives", async (req) => {
    const { gatewayId } = deps.requireGateway(req),
      { callId } = z.object({ callId: uuid }).parse(req.params),
      parsedBody = manifestInput.parse(req.body),
      body: ManifestInput = {
        ...parsedBody,
        startedAt: new Date(parsedBody.startedAt).toISOString(),
        endedAt: new Date(parsedBody.endedAt).toISOString(),
      };
    const deleted = await readCallDeletionProof(db, {
      callId,
      gatewayId,
      gatewayGeneration: body.captureBinding.captureGeneration,
    });
    if (deleted)
      deps.fail(410, "CALL_DELETED", "Call was durably deleted", callDeletionDetails(deleted));
    const liveIdentity = await db.query(
      `SELECT 1 FROM recording_capture_bindings
        WHERE id=$1 AND call_id=$2 AND gateway_id=$3`,
      [body.captureBinding.id, callId, gatewayId],
    );
    if (!liveIdentity.rowCount)
      deps.fail(404, "NOT_FOUND", "Recording capture binding was not found");
    const cfg = unavailable(),
      manifestSha = fingerprint(body),
      limits = archiveLimits(deps),
      requestedBytes = objectMetadata(body).reduce(
        (total, item) => total + item.compressedBytes + item.originalBytes,
        0,
      );
    if (requestedBytes > limits.maxBytesPerArchive)
      deps.fail(
        413,
        "PIXEL_ARCHIVE_TOO_LARGE",
        "Recording archive exceeds the configured per-archive limit",
      );
    await mkdir(cfg.root, { recursive: true, mode: 0o700 });
    await assertDirectory(cfg.root);
    // Measured before BEGIN so the transaction never waits on statfs. The reserved
    // bytes it is compared against are still read inside the budget lock; a concurrent
    // archive admitted in that window can over-admit by at most its own size.
    const freeBytes = await availableBytes(cfg.root, deps.fail);
    const newArchiveDirs: { callId: string; archiveId: string }[] = [];
    const created = await withClient(db, async (c) => {
     try {
      await c.query("BEGIN");
      await c.query(
        `SELECT pg_advisory_xact_lock(hashtext('pixel-recording-archive-budget'))`,
      );
      const binding = (
        await c.query(
          `SELECT b.*,call.state FROM recording_capture_bindings b JOIN call_records call ON call.id=b.call_id WHERE b.id=$1 AND b.call_id=$2 AND b.gateway_id=$3 FOR UPDATE OF b`,
          [body.captureBinding.id, callId, gatewayId],
        )
      ).rows[0];
      if (!binding)
        deps.fail(404, "NOT_FOUND", "Recording capture binding was not found");
      if (!["ended", "failed"].includes(binding.state))
        deps.fail(409, "CALL_NOT_TERMINAL", "Call is not terminal");
      if (
        binding.device_call_id !== body.captureBinding.deviceCallId ||
        Number(binding.telecom_creation_time_millis) !==
          body.captureBinding.telecomCreationTimeMillis ||
        Number(binding.capture_generation) !==
          body.captureBinding.captureGeneration
      )
        deps.fail(
          409,
          "CAPTURE_BINDING_CONFLICT",
          "Recording capture binding does not match",
        );
      const prior = await c.query(
        `SELECT * FROM pixel_recording_archives WHERE call_id=$1 FOR UPDATE`,
        [callId],
      );
      let archive: any;
      if (prior.rowCount) {
        archive = prior.rows[0];
        if (
          archive.gateway_id !== gatewayId ||
          archive.capture_binding_id !== binding.id ||
          archive.client_manifest_sha256 !== manifestSha
        )
          deps.fail(
            409,
            "ARCHIVE_MANIFEST_CONFLICT",
            "This call already has another recording archive",
          );
      } else {
        const usage = (
          await c.query(
            `SELECT
               COALESCE(sum(o.compressed_bytes+o.original_bytes) FILTER(WHERE a.gateway_id=$1),0) gateway_bytes,
               COALESCE(sum(o.compressed_bytes+o.original_bytes) FILTER(WHERE a.snapshot_owner_id=$2),0) owner_bytes,
               COALESCE(sum(GREATEST(o.compressed_bytes-o.committed_offset,0)+o.original_bytes)
                 FILTER(WHERE a.state IN('uploading','verifying')),0) reserved_bytes,
               count(DISTINCT a.id) FILTER(WHERE a.gateway_id=$1 AND a.state IN('uploading','verifying')) pending_gateway
             FROM pixel_recording_archives a
             JOIN pixel_recording_upload_objects o ON o.archive_id=a.id`,
            [gatewayId, binding.snapshot_owner_id],
          )
        ).rows[0];
        if (
          Number(usage.gateway_bytes) + requestedBytes >
            limits.maxBytesPerGateway ||
          Number(usage.owner_bytes) + requestedBytes > limits.maxBytesPerOwner
        )
          deps.fail(
            429,
            "PIXEL_ARCHIVE_QUOTA_EXCEEDED",
            "Recording archive storage quota is exhausted",
          );
        if (Number(usage.pending_gateway) >= limits.maxPendingPerGateway)
          deps.fail(
            429,
            "PIXEL_ARCHIVE_CONCURRENCY_LIMIT",
            "Gateway has too many unfinished recording archives",
          );
        requireAvailableBytes(
          freeBytes,
          BigInt(limits.minFreeBytes) +
            BigInt(usage.reserved_bytes) +
            BigInt(requestedBytes),
          deps.fail,
        );
        archive = (
          await c.query(
            `INSERT INTO pixel_recording_archives(call_id,capture_binding_id,gateway_id,snapshot_owner_id,client_manifest_sha256,client_manifest)VALUES($1,$2,$3,$4,$5,$6)RETURNING *`,
            [
              callId,
              binding.id,
              gatewayId,
              binding.snapshot_owner_id,
              manifestSha,
              JSON.stringify(body),
            ],
          )
        ).rows[0];
        for (const item of objectMetadata(body))
          await c.query(
            `INSERT INTO pixel_recording_upload_objects(archive_id,object_name,kind,compressed_bytes,compressed_sha256,original_bytes,original_sha256)VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              archive.id,
              item.name,
              item.kind,
              item.compressedBytes,
              item.compressedSha256,
              item.originalBytes,
              item.originalSha256,
            ],
          );
        newArchiveDirs.push({ callId, archiveId: archive.id });
      }
      const objects = (
        await c.query(
          `SELECT * FROM pixel_recording_upload_objects WHERE archive_id=$1 ORDER BY object_name`,
          [archive.id],
        )
      ).rows;
      await c.query("COMMIT");
      return { upload: archiveDto(archive, objects) };
     } catch (error) {
      await safeRollback(c);
      throw error;
     }
    });
    for (const dir of newArchiveDirs)
      await ensureArchiveDir(cfg.root, dir.callId, dir.archiveId);
    return created;
  });
  app.get("/api/v1/gateway/recording-archives/:uploadId", async (req) => {
    const { gatewayId } = deps.requireGateway(req);
    const { uploadId } = z.object({ uploadId: uuid }).parse(req.params);
    const query = z.object({
      callId: uuid.optional(),
      generation: z.coerce.number().int().positive().optional(),
    }).strict().parse(req.query);
    if ((query.callId === undefined) !== (query.generation === undefined))
      deps.fail(400, "INVALID_REQUEST", "Call identity and generation must be supplied together");
    const q = await db.query(
      `SELECT * FROM pixel_recording_archives WHERE id=$1 AND gateway_id=$2`,
      [uploadId, gatewayId],
    );
    if (!q.rowCount && query.callId && query.generation) {
      const deleted = await readCallDeletionProof(db, {
        callId: query.callId,
        archiveId: uploadId,
        gatewayId,
        gatewayGeneration: query.generation,
      });
      if (deleted)
        deps.fail(410, "CALL_DELETED", "Call was durably deleted", callDeletionDetails(deleted));
    }
    if (!q.rowCount)
      deps.fail(404, "NOT_FOUND", "Recording upload was not found");
    unavailable();
    const objects = (
      await db.query(
        `SELECT * FROM pixel_recording_upload_objects WHERE archive_id=$1 ORDER BY object_name`,
        [uploadId],
      )
    ).rows;
    return { upload: archiveDto(q.rows[0], objects) };
  });
  app.put(
    "/api/v1/gateway/recording-archives/:uploadId/objects/:objectName",
    { bodyLimit: 1024 * 1024 },
    async (req) => {
      const { gatewayId } = deps.requireGateway(req),
        cfg = unavailable(),
        limits = archiveLimits(deps),
        { uploadId, objectName } = z
          .object({ uploadId: uuid, objectName: z.enum(objectNames) })
          .parse(req.params),
        body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 1)
        deps.fail(
          400,
          "INVALID_ARCHIVE_CHUNK",
          "A non-empty binary chunk is required",
        );
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          String(req.headers["content-range"] ?? ""),
        ),
        digest = /^sha-256=([A-Za-z0-9+/]{43}=)$/.exec(
          String(req.headers.digest ?? ""),
        );
      if (!range || !digest)
        deps.fail(
          400,
          "INVALID_ARCHIVE_CHUNK",
          "Content-Range and SHA-256 Digest are required",
        );
      const start = Number(range[1]),
        end = Number(range[2]),
        total = Number(range[3]);
      if (
        ![start, end, total].every(Number.isSafeInteger) ||
        end - start + 1 !== body.length
      )
        deps.fail(
          400,
          "INVALID_ARCHIVE_CHUNK",
          "Chunk range does not match body",
        );
      const actual = createHash("sha256").update(body).digest("base64");
      if (actual !== digest[1])
        deps.fail(
          422,
          "ARCHIVE_CHUNK_DIGEST_MISMATCH",
          "Chunk digest does not match body",
        );
      // Serialized per object, so the watermark read below is fresh for this process and
      // the stale-tail truncate cannot discard bytes another request already committed.
      // Across processes tx2's compare-and-set is the guard; only one control instance
      // writes an archive root.
      return serializeObjectWrite(`${uploadId}:${objectName}`, async () => {
      // tx1 only reads and validates, then the client goes back to the pool: no
      // transaction may stay open across file I/O, which is exactly the idle-in-transaction
      // shape Postgres killed in production.
      const o = await withClient(db, async (c) => {
       try {
        await c.query("BEGIN");
        const q = await c.query(
          `SELECT a.call_id,a.gateway_id,a.state archive_state,o.* FROM pixel_recording_upload_objects o JOIN pixel_recording_archives a ON a.id=o.archive_id WHERE o.archive_id=$1 AND o.object_name=$2 FOR UPDATE OF o,a`,
          [uploadId, objectName],
        );
        if (!q.rowCount || q.rows[0].gateway_id !== gatewayId)
          deps.fail(404, "NOT_FOUND", "Recording upload was not found");
        const row = q.rows[0];
        if (row.archive_state !== "uploading")
          deps.fail(
            409,
            "ARCHIVE_NOT_UPLOADABLE",
            "Recording archive is not accepting chunks",
          );
        if (total !== Number(row.compressed_bytes) || end >= total)
          deps.fail(
            409,
            "ARCHIVE_SIZE_MISMATCH",
            "Chunk total does not match archive manifest",
          );
        await c.query("COMMIT");
        return row;
       } catch (error) {
        await safeRollback(c);
        throw error;
       }
      });
      const committed = Number(o.committed_offset);
      const path = join(cfg.root, o.call_id, uploadId, `${objectName}.part`);
        await ensureArchiveDir(cfg.root, o.call_id, uploadId);
        let existed = true;
        try {
          await stat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            existed = false;
          else throw error;
        }
        let wrote = false;
        const f = await open(
          path,
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const s = await f.stat();
          if (s.size > committed) {
            await f.truncate(committed);
            await f.sync();
          }
          if (s.size < committed)
            deps.fail(
              503,
              "ARCHIVE_STORAGE_CORRUPT",
              "Archive file is shorter than committed offset",
            );
          if (start > committed)
            deps.fail(
              409,
              "ARCHIVE_OFFSET_MISMATCH",
              "Chunk starts after committed offset",
              { committedOffset: committed },
            );
          if (start < committed) {
            if (end >= committed)
              deps.fail(
                409,
                "ARCHIVE_CHUNK_CONFLICT",
                "Chunk overlaps committed boundary",
              );
            const existing = Buffer.alloc(body.length);
            const read = await f.read(existing, 0, existing.length, start);
            if (read.bytesRead !== body.length || !existing.equals(body))
              deps.fail(
                409,
                "ARCHIVE_CHUNK_CONFLICT",
                "Previously committed chunk differs",
              );
          } else {
            await requireFreeBytes(
              cfg.root,
              limits.minFreeBytes + body.length,
              deps.fail,
            );
            let written = 0;
            while (written < body.length) {
              const result = await f.write(
                body,
                written,
                body.length - written,
                start + written,
              );
              if (!result.bytesWritten) throw new Error("short archive write");
              written += result.bytesWritten;
            }
            await f.sync();
            if (!existed) await fsyncDir(dirname(path));
            wrote = true;
          }
        } finally {
          await f.close();
        }
        if (wrote) {
          await deps.onChunkWritten?.(uploadId, objectName);
          // tx2: compare-and-set the watermark that tx1 read. A lost race leaves the
          // bytes on disk and the watermark untouched, which the next PUT recovers from.
          await withClient(db, async (c) => {
           try {
            await c.query("BEGIN");
            const advanced = await c.query(
              `UPDATE pixel_recording_upload_objects SET committed_offset=$3,state=CASE WHEN $3=compressed_bytes THEN 'uploaded' ELSE 'uploading' END,updated_at=now()
               WHERE archive_id=$1 AND object_name=$2 AND committed_offset=$4`,
              [uploadId, objectName, end + 1, committed],
            );
            if (!advanced.rowCount) {
              const current = (
                await c.query(
                  `SELECT committed_offset FROM pixel_recording_upload_objects WHERE archive_id=$1 AND object_name=$2`,
                  [uploadId, objectName],
                )
              ).rows[0];
              deps.fail(
                409,
                "ARCHIVE_OFFSET_MISMATCH",
                "Committed offset moved while the chunk was being written",
                { committedOffset: Number(current?.committed_offset ?? committed) },
              );
            }
            await c.query("COMMIT");
           } catch (error) {
            await safeRollback(c);
            throw error;
           }
          });
        }
        const row = (
          await db.query(
            `SELECT * FROM pixel_recording_upload_objects WHERE archive_id=$1 AND object_name=$2`,
            [uploadId, objectName],
          )
        ).rows[0];
        return {
          object: {
            name: row.object_name,
            committedOffset: Number(row.committed_offset),
            expectedBytes: Number(row.compressed_bytes),
            state: row.state,
          },
        };
      });
    },
  );
  app.post(
    "/api/v1/gateway/recording-archives/:uploadId/finalize",
    async (req) => {
      const { gatewayId } = deps.requireGateway(req),
        cfg = unavailable(),
        { uploadId } = z.object({ uploadId: uuid }).parse(req.params),
        limits = archiveLimits(deps);
      try {
        await access(cfg.validator, constants.X_OK);
      } catch {
        deps.fail(
          503,
          "PIXEL_ARCHIVE_VALIDATOR_UNAVAILABLE",
          "Recording archive validator is unavailable",
        );
      }
      const result = await withClient(db, async (c) => {
      let advisoryLocked = false;
      let archiveCallId: string | null = null;
      let finalizeSlot: number | undefined;
      try {
        const uploadLock = await c.query(
          `SELECT pg_try_advisory_lock(hashtext($1)) acquired`,
          [`pixel-archive:${uploadId}`],
        );
        if (!uploadLock.rows[0].acquired)
          deps.fail(
            503,
            "PIXEL_ARCHIVE_FINALIZE_BUSY",
            "Recording archive validation is already running",
          );
        advisoryLocked = true;
        const q = await c.query(
          `SELECT * FROM pixel_recording_archives WHERE id=$1 AND gateway_id=$2`,
          [uploadId, gatewayId],
        );
        if (!q.rowCount)
          deps.fail(404, "NOT_FOUND", "Recording upload was not found");
        const archive = q.rows[0];
        archiveCallId = archive.call_id;
        if (archive.state === "complete")
          return {
            archive: {
              id: archive.id,
              callId: archive.call_id,
              source: "pixel",
              version: frozenManifest(archive).version,
              state: "complete",
              completedAt: archive.completed_at,
              manifestSha256: archive.client_manifest_sha256,
            },
          };
        if (archive.state === "rejected")
          deps.fail(422, "ARCHIVE_REJECTED", "Recording archive was rejected");
        const objects = (
          await c.query(
            `SELECT * FROM pixel_recording_upload_objects WHERE archive_id=$1 ORDER BY object_name`,
            [uploadId],
          )
        ).rows;
        let body: ManifestInput;
        try {
          body = frozenManifest(archive);
          exactObjectFacts(body, objects);
        } catch (error) {
          if (error instanceof InvalidArchive) {
            await c.query(
              `UPDATE pixel_recording_archives SET state='rejected',failure_code='archive_metadata_invalid',updated_at=now() WHERE id=$1`,
              [uploadId],
            );
            throw Object.assign(error, { archiveValidation: true });
          }
          throw error;
        }
        if (
          objects.some(
            (o) => Number(o.committed_offset) !== Number(o.compressed_bytes),
          )
        )
          deps.fail(
            409,
            "ARCHIVE_INCOMPLETE",
            "Recording archive upload is incomplete",
          );
        for (let slot = 0; slot < limits.finalizeConcurrency; slot++) {
          const acquired = await c.query(
            `SELECT pg_try_advisory_lock(hashtext('pixel-recording-archive-finalize'),$1) acquired`,
            [slot],
          );
          if (acquired.rows[0].acquired) {
            finalizeSlot = slot;
            break;
          }
        }
        if (finalizeSlot === undefined)
          deps.fail(
            503,
            "PIXEL_ARCHIVE_FINALIZE_BUSY",
            "Recording archive validation capacity is busy",
          );
        await requireFreeBytes(
          cfg.root,
          BigInt(limits.minFreeBytes) +
            objects.reduce(
              (total, object) => total + BigInt(object.original_bytes),
              0n,
            ),
          deps.fail,
        );
        await c.query(
          `UPDATE pixel_recording_archives SET state='verifying',updated_at=now() WHERE id=$1`,
          [uploadId],
        );
        const dir = await assertArchiveDir(cfg.root, archive.call_id, uploadId);
        try {
          for (const o of objects) {
            const part = join(dir, `${o.object_name}.part`);
            if (
              (await stat(part)).size !== Number(o.compressed_bytes) ||
              (await hashFile(part)) !== o.compressed_sha256
            )
              throw new InvalidArchive("compressed object mismatch");
            const output = join(
              dir,
              o.kind === "wav" ? o.object_name.slice(0, -3) : "timeline.jsonl",
            );
            const temp = `${output}.verify.tmp`;
            await rm(temp, { force: true });
            let stdout: string;
            const remoteBytes = objects.find(
              (candidate) => candidate.object_name === "remote_original.wav.gz",
            )?.original_bytes;
            const callerBytes = objects.find(
              (candidate) => candidate.object_name === "caller_original.wav.gz",
            )?.original_bytes;
            const playoutBytes = objects.find(
              (candidate) => candidate.object_name === "caller_playout.wav.gz",
            )?.original_bytes;
            const uplinkBytes = objects.find(
              (candidate) => candidate.object_name === "caller_uplink.wav.gz",
            )?.original_bytes;
            try {
              ({ stdout } = await executeFile(
                cfg.validator,
                [
                  "--root",
                  cfg.root,
                  "--input",
                  part,
                  "--output",
                  temp,
                  "--kind",
                  o.kind,
                  "--max-output",
                  String(o.original_bytes),
                  ...(o.kind === "timeline"
                    ? [
                        "--remote-bytes",
                        String(remoteBytes),
                        "--caller-bytes",
                        String(callerBytes),
                        ...(playoutBytes === undefined ? [] : ["--playout-bytes", String(playoutBytes)]),
                        ...(uplinkBytes === undefined ? [] : ["--uplink-bytes", String(uplinkBytes)]),
                      ]
                    : []),
                ],
                { timeout: 120000, maxBuffer: 65536, windowsHide: true },
              ));
            } catch (error) {
              if (Number((error as NodeJS.ErrnoException).code) === 2)
                throw new InvalidArchive("validator rejected archive");
              throw new ValidatorUnavailable("validator execution failed");
            }
            let result;
            try {
              result = z
                .object({ originalBytes: safePositive, originalSha256: sha })
                .parse(JSON.parse(stdout));
            } catch {
              throw new ValidatorUnavailable(
                "validator returned invalid result",
              );
            }
            if (
              result.originalBytes !== Number(o.original_bytes) ||
              result.originalSha256 !== o.original_sha256
            )
              throw new InvalidArchive("original object mismatch");
            await rename(temp, output);
          }
          const manifest = expectedPixelDescriptor(archive, body);
          const tmp = join(dir, "manifest.json.tmp"),
            final = join(dir, "manifest.json"),
            mf = await open(
              tmp,
              constants.O_CREAT |
                constants.O_TRUNC |
                constants.O_WRONLY |
                constants.O_NOFOLLOW,
              0o600,
            );
          try {
            await mf.writeFile(JSON.stringify(manifest));
            await mf.sync();
          } finally {
            await mf.close();
          }
          await rename(tmp, final);
          await fsyncDir(dir);
          await c.query(
            `UPDATE pixel_recording_upload_objects SET state='verified',updated_at=now() WHERE archive_id=$1`,
            [uploadId],
          );
          const done = (
            await c.query(
              `UPDATE pixel_recording_archives SET state='complete',completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
              [uploadId],
            )
          ).rows[0];
          return {
            archive: {
              id: done.id,
              callId: done.call_id,
              source: "pixel",
              version: body.version,
              state: "complete",
              completedAt: done.completed_at,
              manifestSha256: done.client_manifest_sha256,
            },
          };
        } catch (error) {
          if (error instanceof InvalidArchive) {
            await c.query(
              `UPDATE pixel_recording_archives SET state='rejected',failure_code='archive_validation_failed',updated_at=now() WHERE id=$1`,
              [uploadId],
            );
            throw Object.assign(error, { archiveValidation: true });
          }
          await c.query(
            `UPDATE pixel_recording_archives SET state='uploading',failure_code='archive_validator_unavailable',updated_at=now() WHERE id=$1`,
            [uploadId],
          );
          throw Object.assign(error as Error, { archiveTransient: true });
        }
      } catch (error) {
        // S69: next to the stored failure_code, a diag row the logs can find by call.
        if ((error as any).archiveValidation || (error as any).archiveTransient)
          diag(db, "recording.archive_failed", {
            callId: archiveCallId,
            stage: (error as any).archiveValidation ? "validation" : "validator",
            reason: errorReason(error),
          }, { callId: archiveCallId, level: "warn" });
        if ((error as any).archiveValidation)
          deps.fail(
            422,
            "ARCHIVE_INVALID",
            "Recording archive validation failed",
          );
        if ((error as any).archiveTransient)
          deps.fail(
            503,
            "PIXEL_ARCHIVE_VALIDATOR_UNAVAILABLE",
            "Recording archive validator is unavailable",
          );
        throw error;
      } finally {
        let releaseError: Error | undefined;
        if (finalizeSlot !== undefined) {
          try {
            await c.query(
              `SELECT pg_advisory_unlock(hashtext('pixel-recording-archive-finalize'),$1)`,
              [finalizeSlot],
            );
          } catch (error) {
            releaseError =
              error instanceof Error
                ? error
                : new Error("archive finalize slot unlock failed");
          }
        }
        if (advisoryLocked) {
          try {
            await c.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
              `pixel-archive:${uploadId}`,
            ]);
          } catch (error) {
            releaseError ??=
              error instanceof Error
                ? error
                : new Error("archive advisory unlock failed");
          }
        }
        if (releaseError) markClientBroken(c, releaseError);
      }
      });
      deps.onArchived?.(result.archive.callId);
      return result;
    },
  );
}

/** Caller must enforce immutable snapshot-owner authorization before using this reader. */
export class PixelRecordingArchiveReader {
  private readonly verifier: RecordingFileVerifier;
  constructor(
    private readonly db: Db,
    private readonly root: string,
    verifier?: RecordingFileVerifier,
  ) {
    this.verifier = verifier ?? new RecordingFileVerifier();
  }
  async manifest(callId: string): Promise<PixelRecordingDescriptor | null> {
    const q = await this.db.query(
      `SELECT * FROM pixel_recording_archives WHERE call_id=$1 AND state='complete'`,
      [callId],
    );
    if (!q.rowCount) return null;
    try {
      const archive = q.rows[0];
      const body = frozenManifest(archive);
      const objects = (
        await this.db.query(
          `SELECT * FROM pixel_recording_upload_objects WHERE archive_id=$1 ORDER BY object_name`,
          [archive.id],
        )
      ).rows;
      exactObjectFacts(body, objects);
      if (objects.some((object) => object.state !== "verified"))
        throw new InvalidArchive("recording object is not verified");
      const expected = expectedPixelDescriptor(archive, body);
      const dir = await assertArchiveDir(this.root, callId, archive.id),
        file = await open(
          join(dir, "manifest.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      try {
        const s = await file.stat();
        if (!s.isFile() || s.size > 65536) throw new Error("manifest size");
        const published = JSON.parse(await file.readFile("utf8"));
        const parsed = pixelDescriptor.safeParse(published);
        const legacyV2Expected = expected.version === 2 ? {
          ...expected,
          manifestSha256: undefined,
          tracks: expected.tracks.map(({ sourceRole: _sourceRole, ...track }) => track),
        } : undefined;
        if (legacyV2Expected) delete (legacyV2Expected as any).manifestSha256;
        const exactPublished = parsed.success && fingerprint(published) === fingerprint(expected);
        const exactLegacyV2 = legacyV2Expected !== undefined &&
          fingerprint(published) === fingerprint(legacyV2Expected);
        if (
          (!exactPublished && !exactLegacyV2) ||
          published.callId !== callId ||
          published.archiveId !== archive.id
        )
          throw new Error("manifest mismatch");
        return withPixelDurationMs(expected, body);
      } finally {
        await file.close();
      }
    } catch {
      throw new RecordingStoreError("RECORDING_CORRUPT");
    }
  }
  async openTrack(callId: string, track: PixelTrack, rangeHeader?: string) {
    const manifest = await this.manifest(callId);
    if (!manifest) throw new RecordingStoreError("RECORDING_UNAVAILABLE");
    const artifact = [...manifest.tracks, ...(manifest.derivedTracks ?? []), ...(manifest.uplinkTracks ?? [])]
      .find((item) => item.track === track);
    if (!artifact) throw new RecordingStoreError("RECORDING_UNAVAILABLE");
    const range = recordingByteRange(rangeHeader, artifact.bytes);
    const path = join(this.root, callId, manifest.archiveId, `${track}.wav`);
    let file: FileHandle | undefined = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const s = await file.stat();
      if (!s.isFile() || s.size !== artifact.bytes)
        throw new RecordingStoreError("RECORDING_CORRUPT");
      await this.verifier.verify(file, artifact.sha256);
      const stream = file.createReadStream({
        start: range.start,
        end: range.end,
        autoClose: true,
      });
      file = undefined;
      return {
        stream: stream as Readable,
        size: artifact.bytes,
        sha256: artifact.sha256,
        complete: "captureComplete" in artifact ? artifact.captureComplete : artifact.playoutComplete,
        ...range,
      };
    } catch (error) {
      if (error instanceof RecordingFileVerificationBusyError) throw error;
      if (error instanceof RecordingFileVerificationError)
        throw new RecordingStoreError("RECORDING_CORRUPT");
      if (error instanceof RecordingStoreError) throw error;
      throw new RecordingStoreError("RECORDING_CORRUPT");
    } finally {
      await file?.close();
    }
  }
}
