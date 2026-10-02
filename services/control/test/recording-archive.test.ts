import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { registerRecordingArchiveRoutes } from "../src/recording-archive.js";
import { createDb, type Db } from "../src/db.js";
import { tokenHash } from "../src/security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database",
  );
const run = promisify(execFile);
let db: Db, app: FastifyInstance, root: string, validator: string;
let owner: string,
  other: string,
  gateway: string,
  sim: string,
  callId: string,
  deviceToken: string,
  otherDeviceToken: string,
  binding: any;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function wav() {
  const value = Buffer.alloc(44 + 640);
  value.write("RIFF", 0);
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(16000, 24);
  value.writeUInt32LE(32000, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(640, 40);
  return value;
}
const config = (
  archiveRoot: string,
  validatorPath: string,
  overrides: Record<string, unknown> = {},
) => ({
  DATABASE_URL: databaseUrl!,
  PUBLIC_ORIGIN: "https://vodog.test",
  RP_ID: "vodog.test",
  COOKIE_SECRET: "archive-test-cookie-secret-at-least-32-characters",
  GATEWAY_ONLINE_SECONDS: 30,
  PORT: 3199,
  AI_ENABLED: false,
  AI_WORKER_READY: false,
  MEDIA_DEFAULT_NODE_ID: "relay-primary",
  MEDIA_SECRET: "archive-test-media-secret-at-least-32-chars",
  TURN_SECRET: "archive-test-turn-secret-at-least-32-chars",
  TRANSCRIPTION_ENABLED: false,
  TRANSCRIPTION_SCAN_INTERVAL_SECONDS: 5,
  TRANSCRIPTION_SCAN_BATCH: 2,
  PIXEL_ARCHIVE_ENABLED: true,
  PIXEL_ARCHIVE_ROOT: archiveRoot,
  PIXEL_ARCHIVE_VALIDATOR_PATH: validatorPath,
  WEB_CALL_LIVENESS_ENABLED: false,
  FCM_ENABLED: false,
  ...overrides,
});

function archiveFixture() {
  const original = wav(),
    remote = gzipSync(original, { mtime: 0 } as any),
    caller = gzipSync(original, { mtime: 0 } as any),
    timelineOriginal = Buffer.from('{"event":"start","timestampUs":0}\n'),
    timeline = gzipSync(timelineOriginal, { mtime: 0 } as any);
  return {
    original,
    remote,
    caller,
    timelineOriginal,
    timeline,
    body: {
      version: 2,
      captureBinding: {
        id: binding.id,
        deviceCallId: binding.deviceCallId,
        telecomCreationTimeMillis: binding.telecomCreationTimeMillis,
        captureGeneration: binding.captureGeneration,
      },
      startedAt: "2026-09-10T09:00:00.000+08:00",
      endedAt: "2026-09-10T09:01:00.000+08:00",
      terminalState: "ended",
      tracks: [
        {
          track: "remote_original",
          objectName: "remote_original.wav.gz",
          mediaType: "audio/wav",
          pcm: {
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            encoding: "pcm_s16le",
          },
          compressedBytes: remote.length,
          compressedSha256: sha(remote),
          originalBytes: original.length,
          originalSha256: sha(original),
          pcmBytes: 640,
          gapCount: 0,
          droppedFrames: 0,
          captureComplete: true,
        },
        {
          track: "caller_original",
          objectName: "caller_original.wav.gz",
          mediaType: "audio/wav",
          pcm: {
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            encoding: "pcm_s16le",
          },
          compressedBytes: caller.length,
          compressedSha256: sha(caller),
          originalBytes: original.length,
          originalSha256: sha(original),
          pcmBytes: 640,
          gapCount: 1,
          droppedFrames: 1,
          captureComplete: false,
        },
      ],
      timeline: {
        objectName: "timeline.jsonl.gz",
        mediaType: "application/x-ndjson",
        compressedBytes: timeline.length,
        compressedSha256: sha(timeline),
        originalBytes: timelineOriginal.length,
        originalSha256: sha(timelineOriginal),
      },
      sessionStats: { networkSendDrops: 1 },
    },
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vodog-pixel-archive-"));
  validator = join(root, "recording-archive-validator");
  await run("go", ["build", "-o", validator, "."], {
    cwd: fileURLToPath(
      new URL("../../recording-archive-validator", import.meta.url),
    ),
  });
  db = createDb(databaseUrl);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await db.query(
    await readFile(
      fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
      "utf8",
    ),
  );
  owner = (
    await db.query(
      `INSERT INTO users(email,password_hash)VALUES('archive-owner@test','x')RETURNING id`,
    )
  ).rows[0].id;
  other = (
    await db.query(
      `INSERT INTO users(email,password_hash)VALUES('archive-other@test','x')RETURNING id`,
    )
  ).rows[0].id;
  gateway = (
    await db.query(
      `INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES('archive-gateway',true,true,true,now())RETURNING id`,
    )
  ).rows[0].id;
  sim = (
    await db.query(
      `INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,'Archive SIM',true,$3)RETURNING id`,
      [gateway, owner, tokenHash("archive-sim-fingerprint")],
    )
  ).rows[0].id;
  callId = (
    await db.query(
      `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,device_call_id,media_node_id,answered_at)VALUES($1,$2,$3,'incoming','active',1,'normal','device-call-stable','relay-primary',now())RETURNING id`,
      [gateway, sim, owner],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,1,$2,1,0,true,$3,now())`,
    [
      gateway,
      randomUUID(),
      JSON.stringify([
        {
          callId,
          deviceCallId: "device-call-stable",
          simId: sim,
          direction: "incoming",
          state: "active",
        },
      ]),
    ],
  );
  deviceToken = `archive-device-${randomUUID()}`;
  otherDeviceToken = `other-device-${randomUUID()}`;
  const otherGateway = (
    await db.query(
      `INSERT INTO gateways(name)VALUES('other-archive-gateway')RETURNING id`,
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'archive'),($3,$4,'other')`,
    [
      gateway,
      tokenHash(deviceToken),
      otherGateway,
      tokenHash(otherDeviceToken),
    ],
  );
  for (const [id, user, access] of [
    [randomUUID(), owner, "owner-archive-token"],
    [randomUUID(), other, "other-archive-token"],
  ])
    await db.query(
      `INSERT INTO sessions(id,user_id,access_hash,client_type,platform,access_expires_at)VALUES($1,$2,$3,'native','android',now()+interval '1 hour')`,
      [id, user, tokenHash(access)],
    );
  app = await buildApp(db, config(root, validator) as any);
});
after(async () => {
  await app?.close();
  await db?.end();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Fault injection wraps only transaction clients; normal pool queries stay unchanged. */
async function buildFaultApp(shouldFail: (sql: string) => boolean) {
  const injected = new Proxy(db, {
    get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, member) {
            if (member === "query") return (...args: any[]) => {
              const sql = typeof args[0] === "string" ? args[0] : args[0].text;
              if (shouldFail(sql)) throw new Error("synthetic database failure after filesystem write");
              return (connection.query as any)(...args);
            };
            const value = Reflect.get(connection, member);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return buildApp(injected, config(root, validator) as any);
}

test("capture binding freezes active call identity and rejects a later epoch replay", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/media/options`,
    headers: bearer(deviceToken),
    payload: {
      transport: "udp",
      capture: {
        deviceCallId: "device-call-stable",
        telecomCreationTimeMillis: 1789000000000,
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  binding = response.json().captureBinding;
  assert.equal(binding.captureGeneration, 1);
  assert.equal(binding.deviceCallId, "device-call-stable");
  const replay = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/media/options`,
    headers: bearer(deviceToken),
    payload: {
      transport: "udp",
      capture: {
        deviceCallId: "device-call-stable",
        telecomCreationTimeMillis: 1789000000000,
      },
    },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().captureBinding.id, binding.id);
  await db.query(
    `UPDATE gateways SET device_epoch=2,last_seen_at=now() WHERE id=$1`,
    [gateway],
  );
  await db.query(`UPDATE call_records SET generation=2 WHERE id=$1`, [callId]);
  await db.query(
    `UPDATE gateway_telecom_snapshots SET generation=2,snapshot_id=$2,snapshot_sequence=2,observed_at=now() WHERE gateway_id=$1`,
    [gateway, randomUUID()],
  );
  const stale = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/media/options`,
    headers: bearer(deviceToken),
    payload: {
      transport: "udp",
      capture: {
        deviceCallId: "device-call-stable",
        telecomCreationTimeMillis: 1789000000000,
      },
    },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, "CAPTURE_BINDING_CONFLICT");
});

test("archive initialization enforces configured size and disk reservations", async () => {
  await db.query(
    `UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1`,
    [callId],
  );
  const { body } = archiveFixture();
  const oddPcm = structuredClone(body);
  oddPcm.tracks[0].pcmBytes = 639;
  oddPcm.tracks[0].originalBytes = 683;
  const invalidPcm = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: bearer(deviceToken),
    payload: oddPcm,
  });
  assert.equal(invalidPcm.statusCode, 400, invalidPcm.body);
  const oversized = await buildApp(
    db,
    config(root, validator, { PIXEL_ARCHIVE_MAX_BYTES_PER_ARCHIVE: 1 }) as any,
  );
  try {
    const response = await oversized.inject({
      method: "POST",
      url: `/api/v1/gateway/calls/${callId}/recording-archives`,
      headers: bearer(deviceToken),
      payload: body,
    });
    assert.equal(response.statusCode, 413, response.body);
    assert.equal(response.json().error.code, "PIXEL_ARCHIVE_TOO_LARGE");
  } finally {
    await oversized.close();
  }
  const noGatewayQuota = await buildApp(
    db,
    config(root, validator, { PIXEL_ARCHIVE_MAX_BYTES_PER_GATEWAY: 1 }) as any,
  );
  try {
    const response = await noGatewayQuota.inject({
      method: "POST",
      url: `/api/v1/gateway/calls/${callId}/recording-archives`,
      headers: bearer(deviceToken),
      payload: body,
    });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(response.json().error.code, "PIXEL_ARCHIVE_QUOTA_EXCEEDED");
  } finally {
    await noGatewayQuota.close();
  }
  const lowDisk = await buildApp(
    db,
    config(root, validator, {
      PIXEL_ARCHIVE_MIN_FREE_BYTES: Number.MAX_SAFE_INTEGER,
    }) as any,
  );
  try {
    const response = await lowDisk.inject({
      method: "POST",
      url: `/api/v1/gateway/calls/${callId}/recording-archives`,
      headers: bearer(deviceToken),
      payload: body,
    });
    assert.equal(response.statusCode, 507, response.body);
    assert.equal(response.json().error.code, "PIXEL_ARCHIVE_STORAGE_LOW");
    assert.equal(
      Number(
        (
          await db.query(
            `SELECT count(*) count FROM pixel_recording_archives WHERE call_id=$1`,
            [callId],
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    await lowDisk.close();
  }
});

test("device resumes exact chunks, finalizes through strict validator, and owner reads one-byte Range", async () => {
  const { original, remote, caller, timeline, body } = archiveFixture();
  const forbidden = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: bearer(otherDeviceToken),
    payload: body,
  });
  assert.equal(forbidden.statusCode, 404, forbidden.body);
  const init = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: bearer(deviceToken),
    payload: body,
  });
  assert.equal(init.statusCode, 200, init.body);
  const uploadId = init.json().upload.id;
  const exactReplay = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/calls/${callId}/recording-archives`,
    headers: bearer(deviceToken),
    payload: body,
  });
  assert.equal(exactReplay.statusCode, 200);
  assert.equal(exactReplay.json().upload.id, uploadId);
  await db.query(
    `DELETE FROM pixel_recording_upload_objects WHERE archive_id=$1 AND object_name='timeline.jsonl.gz'`,
    [uploadId],
  );
  const missingObject = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`,
    headers: bearer(deviceToken),
  });
  assert.equal(missingObject.statusCode, 422, missingObject.body);
  assert.equal(missingObject.json().error.code, "ARCHIVE_INVALID");
  await db.query(
    `UPDATE pixel_recording_archives SET state='uploading',failure_code=NULL WHERE id=$1`,
    [uploadId],
  );
  await db.query(
    `INSERT INTO pixel_recording_upload_objects(archive_id,object_name,kind,compressed_bytes,compressed_sha256,original_bytes,original_sha256)
     VALUES($1,'timeline.jsonl.gz','timeline',$2,$3,$4,$5)`,
    [
      uploadId,
      body.timeline.compressedBytes,
      body.timeline.compressedSha256,
      body.timeline.originalBytes,
      body.timeline.originalSha256,
    ],
  );
  for (const [name, data] of [
    ["remote_original.wav.gz", remote],
    ["caller_original.wav.gz", caller],
    ["timeline.jsonl.gz", timeline],
  ] as const) {
    if (name === "remote_original.wav.gz") {
      const skipped = data.subarray(1),
        response = await app.inject({
          method: "PUT",
          url: `/api/v1/gateway/recording-archives/${uploadId}/objects/${name}`,
          headers: {
            ...bearer(deviceToken),
            "content-type": "application/octet-stream",
            "content-range": `bytes 1-${data.length - 1}/${data.length}`,
            digest: `sha-256=${createHash("sha256").update(skipped).digest("base64")}`,
          },
          payload: skipped,
        });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "ARCHIVE_OFFSET_MISMATCH");
      assert.equal(response.json().error.details.committedOffset, 0);
    }
    const headers = {
      ...bearer(deviceToken),
      "content-type": "application/octet-stream",
      "content-range": `bytes 0-${data.length - 1}/${data.length}`,
      digest: `sha-256=${createHash("sha256").update(data).digest("base64")}`,
    };
    const request = {
      method: "PUT" as const,
      url: `/api/v1/gateway/recording-archives/${uploadId}/objects/${name}`,
      headers, payload: data,
    };
    if (name === "remote_original.wav.gz") {
      let failures = 0, chunkWritten = false;
      const fault = await buildFaultApp(sql => {
        if (sql.startsWith("UPDATE pixel_recording_upload_objects SET committed_offset=")) chunkWritten = true;
        return chunkWritten && sql === "COMMIT" && failures++ === 0;
      });
      try {
        const response = await fault.inject(request);
        assert.equal(response.statusCode, 500);
        const row = (await db.query(
          "SELECT committed_offset FROM pixel_recording_upload_objects WHERE archive_id=$1 AND object_name=$2",
          [uploadId, name],
        )).rows[0];
        assert.equal(Number(row.committed_offset), 0, "failed commit must not advance watermark");
        const part = join(root, callId, uploadId, `${name}.part`);
        assert.deepEqual(await readFile(part), data, "failure occurred after bytes were written");
        await writeFile(part, Buffer.concat([data, Buffer.from("uncommitted-tail")]));
      } finally { await fault.close(); }
    }
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    for (const response of responses) assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await readFile(join(root, callId, uploadId, `${name}.part`)), data,
      "concurrent replay and recovery must produce exactly one object without trailing bytes");
    if (name === "remote_original.wav.gz") {
      const altered = Buffer.from(data);
      altered[altered.length - 1] ^= 0xff;
      const conflict = await app.inject({
        method: "PUT",
        url: `/api/v1/gateway/recording-archives/${uploadId}/objects/${name}`,
        headers: {
          ...headers,
          digest: `sha-256=${createHash("sha256").update(altered).digest("base64")}`,
        },
        payload: altered,
      });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(conflict.json().error.code, "ARCHIVE_CHUNK_CONFLICT");
    }
  }
  const archiveLock = await db.connect();
  await archiveLock.query(`SELECT pg_advisory_lock(hashtext($1))`, [
    `pixel-archive:${uploadId}`,
  ]);
  try {
    const sameArchiveBusy = await app.inject({
      method: "POST",
      url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`,
      headers: bearer(deviceToken),
    });
    assert.equal(sameArchiveBusy.statusCode, 503, sameArchiveBusy.body);
    assert.equal(
      sameArchiveBusy.json().error.code,
      "PIXEL_ARCHIVE_FINALIZE_BUSY",
    );
  } finally {
    await archiveLock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
      `pixel-archive:${uploadId}`,
    ]);
    archiveLock.release();
  }
  const capacity = await db.connect();
  await capacity.query(
    `SELECT pg_advisory_lock(hashtext('pixel-recording-archive-finalize'),0)`,
  );
  try {
    const busyFinalize = await app.inject({
      method: "POST",
      url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`,
      headers: bearer(deviceToken),
    });
    assert.equal(busyFinalize.statusCode, 503, busyFinalize.body);
    assert.equal(busyFinalize.json().error.code, "PIXEL_ARCHIVE_FINALIZE_BUSY");
    assert.equal(
      (
        await db.query(
          `SELECT state FROM pixel_recording_archives WHERE id=$1`,
          [uploadId],
        )
      ).rows[0].state,
      "uploading",
    );
  } finally {
    await capacity.query(
      `SELECT pg_advisory_unlock(hashtext('pixel-recording-archive-finalize'),0)`,
    );
    capacity.release();
  }
  let completionFailures = 0;
  const finalizeFault = await buildFaultApp(sql =>
    sql.startsWith("UPDATE pixel_recording_archives SET state='complete'") && completionFailures++ === 0);
  try {
    const response = await finalizeFault.inject({
      method: "POST", url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`,
      headers: bearer(deviceToken),
    });
    assert.equal(response.statusCode, 503, response.body);
    const published = JSON.parse((await readFile(join(root, callId, uploadId, "manifest.json"))).toString());
    assert.equal(published.archiveId, uploadId, "failure occurred after manifest publication");
    // S94 golden: a v2 publication keeps exactly the pre-v4 key set.
    assert.deepEqual(Object.keys(published), ["source", "version", "archiveId", "callId", "manifestSha256",
      "archiveComplete", "captureComplete", "startedAt", "endedAt", "tracks", "timeline"]);
    assert.equal((await db.query("SELECT state FROM pixel_recording_archives WHERE id=$1", [uploadId])).rows[0].state, "uploading");
    const hidden = await app.inject({method:"GET", url:`/api/v1/calls/${callId}/recordings?source=pixel`, headers:bearer("owner-archive-token")});
    assert.equal(hidden.statusCode, 200, hidden.body);
    assert.equal(hidden.json().recording, null, "published files alone must not make archive readable");
  } finally { await finalizeFault.close(); }
  const finalized = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`,
    headers: bearer(deviceToken),
  });
  const finalizedReplay = await app.inject({
    method: "POST",
    url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`,
    headers: bearer(deviceToken),
  });
  for (const response of [finalized, finalizedReplay]) {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().archive.source, "pixel");
  }
  const anonymous = await app.inject({
    method: "GET",
    url: `/api/v1/calls/${callId}/recordings?source=pixel`,
  });
  assert.equal(anonymous.statusCode, 401);
  const cross = await app.inject({
    method: "GET",
    url: `/api/v1/calls/${callId}/recordings?source=pixel`,
    headers: bearer("other-archive-token"),
  });
  assert.equal(cross.statusCode, 404);
  const owned = await app.inject({
    method: "GET",
    url: `/api/v1/calls/${callId}/recordings?source=pixel`,
    headers: bearer("owner-archive-token"),
  });
  assert.equal(owned.statusCode, 200, owned.body);
  assert.equal(owned.json().recording.captureComplete, false);
  assert.equal(owned.json().recording.manifestSha256.length, 64);
  assert.deepEqual(owned.json().recording.tracks.map((track: any) => track.sourceRole),
    ["original_capture", "original_capture"]);
  assert.equal(owned.json().recording.tracks[0].durationMs, 20);
  assert.equal(owned.json().recording.tracks[1].durationMs, 20);
  assert.equal(owned.json().recording.startedAt, "2026-09-10T01:00:00.000Z");
  assert.equal(owned.json().recording.endedAt, "2026-09-10T01:01:00.000Z");
  const v2ManifestPath = join(root, callId, uploadId, "manifest.json");
  const normalizedV2Manifest = JSON.parse((await readFile(v2ManifestPath)).toString("utf8"));
  const legacyV2Manifest = { ...normalizedV2Manifest };
  delete legacyV2Manifest.manifestSha256;
  legacyV2Manifest.tracks = legacyV2Manifest.tracks.map(({ sourceRole: _sourceRole, ...track }: any) => track);
  await writeFile(v2ManifestPath, JSON.stringify(legacyV2Manifest));
  const legacyV2Read = await app.inject({
    method: "GET",
    url: `/api/v1/calls/${callId}/recordings?source=pixel`,
    headers: bearer("owner-archive-token"),
  });
  assert.equal(legacyV2Read.statusCode, 200, legacyV2Read.body);
  assert.equal(legacyV2Read.json().recording.manifestSha256, normalizedV2Manifest.manifestSha256);
  assert.equal(legacyV2Read.json().recording.tracks[0].sourceRole, "original_capture");
  await writeFile(v2ManifestPath, JSON.stringify(normalizedV2Manifest));
  const range = await app.inject({
    method: "GET",
    url: `/api/v1/calls/${callId}/recordings/remote_original?source=pixel`,
    headers: { ...bearer("owner-archive-token"), range: "bytes=0-0" },
  });
  assert.equal(range.statusCode, 206, range.body);
  assert.equal(range.rawPayload.length, 1);
  assert.equal(range.headers["content-range"], `bytes 0-0/${original.length}`);
  assert.equal(range.headers.etag, `"${sha(original)}"`);
  const downloadUrl = `/api/v1/calls/${callId}/recordings/remote_original?source=pixel&disposition=attachment`;
  const download = await app.inject({
    method: "GET",
    url: downloadUrl,
    headers: { ...bearer("owner-archive-token"), range: "bytes=0-0" },
  });
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, original);
  assert.equal(download.headers["content-type"], "audio/wav");
  assert.equal(download.headers["content-disposition"], `attachment; filename="call-${callId}-pixel-remote_original.wav"`);
  assert.equal(download.headers["accept-ranges"], undefined);
  const otherDownload = await app.inject({ method: "GET", url: downloadUrl, headers: bearer("other-archive-token") });
  assert.equal(otherDownload.statusCode, 404);

  const archiveDir = join(root, callId, uploadId);
  const manifestPath = join(archiveDir, "manifest.json");
  const originalManifest = await readFile(manifestPath);
  const changedManifest = JSON.parse(originalManifest.toString("utf8"));
  changedManifest.endedAt = "2026-09-10T01:02:00.000Z";
  await writeFile(manifestPath, JSON.stringify(changedManifest));
  try {
    const changedPublishedFacts = await app.inject({
      method: "GET",
      url: `/api/v1/calls/${callId}/recordings?source=pixel`,
      headers: bearer("owner-archive-token"),
    });
    assert.equal(
      changedPublishedFacts.statusCode,
      503,
      changedPublishedFacts.body,
    );
  } finally {
    await writeFile(manifestPath, originalManifest);
  }

  await db.query(
    `UPDATE pixel_recording_upload_objects SET original_sha256=$3 WHERE archive_id=$1 AND object_name=$2`,
    [uploadId, "remote_original.wav.gz", "b".repeat(64)],
  );
  try {
    const changedDatabaseFacts = await app.inject({
      method: "GET",
      url: `/api/v1/calls/${callId}/recordings?source=pixel`,
      headers: bearer("owner-archive-token"),
    });
    assert.equal(
      changedDatabaseFacts.statusCode,
      503,
      changedDatabaseFacts.body,
    );
  } finally {
    await db.query(
      `UPDATE pixel_recording_upload_objects SET original_sha256=$3 WHERE archive_id=$1 AND object_name=$2`,
      [uploadId, "remote_original.wav.gz", sha(original)],
    );
  }

  const realManifestPath = join(archiveDir, "manifest.real.json");
  await rename(manifestPath, realManifestPath);
  await symlink("manifest.real.json", manifestPath);
  try {
    const linkedManifest = await app.inject({
      method: "GET",
      url: `/api/v1/calls/${callId}/recordings?source=pixel`,
      headers: bearer("owner-archive-token"),
    });
    assert.equal(linkedManifest.statusCode, 503, linkedManifest.body);
  } finally {
    await unlink(manifestPath);
    await rename(realManifestPath, manifestPath);
  }

  const realArchiveDir = `${archiveDir}.real`;
  await rename(archiveDir, realArchiveDir);
  await symlink(`${uploadId}.real`, archiveDir);
  try {
    const linkedDirectory = await app.inject({
      method: "GET",
      url: `/api/v1/calls/${callId}/recordings?source=pixel`,
      headers: bearer("owner-archive-token"),
    });
    assert.equal(linkedDirectory.statusCode, 503, linkedDirectory.body);
  } finally {
    await unlink(archiveDir);
    await rename(realArchiveDir, archiveDir);
  }

  const defaultV1 = await app.inject({
    method: "GET",
    url: `/api/v1/calls/${callId}/recordings`,
    headers: bearer("owner-archive-token"),
  });
  assert.notEqual(defaultV1.json().recording?.source, "pixel");
});

test("missing validator fails closed before changing archive state", async () => {
  const disabled = await buildApp(
    db,
    config(join(root, "other-root"), join(root, "missing-validator")) as any,
  );
  try {
    const archive = (
      await db.query(
        `SELECT id,state FROM pixel_recording_archives WHERE call_id=$1`,
        [callId],
      )
    ).rows[0];
    await db.query(
      `UPDATE pixel_recording_archives SET state='uploading' WHERE id=$1`,
      [archive.id],
    );
    const response = await disabled.inject({
      method: "POST",
      url: `/api/v1/gateway/recording-archives/${archive.id}/finalize`,
      headers: bearer(deviceToken),
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(
      response.json().error.code,
      "PIXEL_ARCHIVE_VALIDATOR_UNAVAILABLE",
    );
    assert.equal(
      (
        await db.query(
          `SELECT state FROM pixel_recording_archives WHERE id=$1`,
          [archive.id],
        )
      ).rows[0].state,
      "uploading",
    );
  } finally {
    await disabled.close();
  }
});

test("v3 archives four immutable objects and authorizes separate derived playback", async () => {
  await db.query(`DELETE FROM pixel_recording_archives WHERE call_id=$1`, [callId]);
  const fixture = archiveFixture();
  const { droppedFrames: _drops, captureComplete: _complete, ...originalFacts } = fixture.body.tracks[1];
  const body = { ...fixture.body, version: 3, derivedTracks: [{ ...originalFacts,
    track: "caller_playout", objectName: "caller_playout.wav.gz", sourceRole: "derived_playout",
    gapCount: 0, recoveryFrames: 1, playoutComplete: true,
  }] };
  const url = `/api/v1/gateway/calls/${callId}/recording-archives`;
  const v2Reservation = fixture.body.tracks.reduce((total, item) => total + item.compressedBytes + item.originalBytes, 0)
    + fixture.body.timeline.compressedBytes + fixture.body.timeline.originalBytes;
  const limited = await buildApp(db, config(root, validator, { PIXEL_ARCHIVE_MAX_BYTES_PER_ARCHIVE: v2Reservation }) as any);
  try {
    const exceeded = await limited.inject({ method: "POST", url, headers: bearer(deviceToken), payload: body });
    assert.equal(exceeded.statusCode, 413, exceeded.body);
  } finally { await limited.close(); }
  const init = await app.inject({ method: "POST", url, headers: bearer(deviceToken), payload: body });
  assert.equal(init.statusCode, 200, init.body);
  const uploadId = init.json().upload.id;
  assert.equal(init.json().upload.objects.length, 4);
  const changed = structuredClone(body);
  changed.derivedTracks[0].recoveryFrames++;
  const conflict = await app.inject({ method: "POST", url, headers: bearer(deviceToken), payload: changed });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const downgrade = await app.inject({ method: "POST", url, headers: bearer(deviceToken), payload: { ...body, version: 2 } });
  assert.equal(downgrade.statusCode, 400, downgrade.body);
  for (const [name, data] of [
    ["remote_original.wav.gz", fixture.remote], ["caller_original.wav.gz", fixture.caller],
    ["caller_playout.wav.gz", fixture.caller], ["timeline.jsonl.gz", fixture.timeline],
  ] as const) {
    const request = { method: "PUT" as const, url: `/api/v1/gateway/recording-archives/${uploadId}/objects/${name}`,
      headers: { ...bearer(deviceToken), "content-type": "application/octet-stream",
        "content-range": `bytes 0-${data.length - 1}/${data.length}`,
        digest: `sha-256=${createHash("sha256").update(data).digest("base64")}` }, payload: data };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 200, replay.body);
  }
  const finalized = await app.inject({ method: "POST", url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`, headers: bearer(deviceToken) });
  assert.equal(finalized.statusCode, 200, finalized.body);
  assert.equal(finalized.json().archive.version, 3);
  const descriptor = await app.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings?source=pixel`, headers: bearer("owner-archive-token") });
  assert.equal(descriptor.statusCode, 200, descriptor.body);
  assert.equal(descriptor.json().recording.captureComplete, false);
  assert.equal(descriptor.json().recording.tracks[0].durationMs, 20);
  assert.equal(descriptor.json().recording.tracks[1].durationMs, 20);
  assert.equal(descriptor.json().recording.derivedTracks[0].sourceRole, "derived_playout");
  assert.equal(descriptor.json().recording.derivedTracks[0].durationMs, 20);
  const playbackUrl = `/api/v1/calls/${callId}/recordings/caller_playout?source=pixel`;
  const playback = await app.inject({ method: "GET", url: playbackUrl, headers: { ...bearer("owner-archive-token"), range: "bytes=0-43" } });
  assert.equal(playback.statusCode, 206, playback.body);
  assert.deepEqual(playback.rawPayload, fixture.original.subarray(0, 44));
  const denied = await app.inject({ method: "GET", url: playbackUrl, headers: bearer("other-archive-token") });
  assert.equal(denied.statusCode, 404, denied.body);
  const defaultSource = await app.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings/caller_playout`, headers: bearer("owner-archive-token") });
  assert.equal(defaultSource.statusCode, 404, defaultSource.body);
  const manifestPath = join(root, callId, uploadId, "manifest.json");
  const immutable = await readFile(manifestPath, "utf8");
  // S94 golden: a v3 publication keeps exactly the pre-v4 key set, so published fingerprints stay valid.
  assert.deepEqual(Object.keys(JSON.parse(immutable)), ["source", "version", "archiveId", "callId", "manifestSha256",
    "archiveComplete", "captureComplete", "startedAt", "endedAt", "tracks", "derivedTracks", "timeline"]);
  assert.equal(descriptor.json().recording.archiveVersion, undefined);
  assert.equal(descriptor.json().recording.uplinkTracks, undefined);
  try {
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(immutable), captureSource: "promoted_derived" }));
    const tampered = await app.inject({ method: "GET", url: playbackUrl, headers: bearer("owner-archive-token") });
    assert.equal(tampered.statusCode, 503, tampered.body);
  } finally { await writeFile(manifestPath, immutable); }
});

function uplinkWav() {
  const value = wav();
  for (let offset = 44; offset < value.length; offset += 2) value.writeInt16LE(((offset * 37) % 2000) - 1000, offset);
  return value;
}
async function putObjects(target: FastifyInstance, uploadId: string, objects: (readonly [string, Buffer])[]) {
  for (const [name, data] of objects) {
    const put = await target.inject({ method: "PUT", url: `/api/v1/gateway/recording-archives/${uploadId}/objects/${name}`,
      headers: { ...bearer(deviceToken), "content-type": "application/octet-stream",
        "content-range": `bytes 0-${data.length - 1}/${data.length}`,
        digest: `sha-256=${createHash("sha256").update(data).digest("base64")}` }, payload: data });
    assert.equal(put.statusCode, 200, put.body);
  }
}

test("v4 archives the owner uplink beside unchanged v2-shaped tracks and serves it to pixel readers only", async () => {
  await db.query(`DELETE FROM pixel_recording_archives WHERE call_id=$1`, [callId]);
  const fixture = archiveFixture();
  const uplinkOriginal = uplinkWav(), uplink = gzipSync(uplinkOriginal, { mtime: 0 } as any);
  const timelineOriginal = Buffer.from('{"event":"start","timestampUs":0}\n' +
    '{"event":"frame","track":"caller_uplink","timestampUs":0,"sourceTimestampUs":1000,"fileOffset":44,"sampleCount":320}\n' +
    '{"event":"gap","track":"caller_uplink","timestampUs":20000,"durationUs":20000}\n' +
    '{"event":"stop","state":"ended"}\n');
  const timeline = gzipSync(timelineOriginal, { mtime: 0 } as any);
  const uplinkEntry = { track: "caller_uplink", sourceRole: "uplink_capture", objectName: "caller_uplink.wav.gz",
    mediaType: "audio/wav", pcm: fixture.body.tracks[0].pcm,
    compressedBytes: uplink.length, compressedSha256: sha(uplink),
    originalBytes: uplinkOriginal.length, originalSha256: sha(uplinkOriginal),
    pcmBytes: 640, gapCount: 1, droppedFrames: 0, captureComplete: false };
  const body = { ...fixture.body, version: 4, uplinkTracks: [uplinkEntry], timeline: { ...fixture.body.timeline,
    compressedBytes: timeline.length, compressedSha256: sha(timeline),
    originalBytes: timelineOriginal.length, originalSha256: sha(timelineOriginal) } };
  const url = `/api/v1/gateway/calls/${callId}/recording-archives`;
  for (const invalid of [
    { ...body, uplinkTracks: undefined },
    { ...body, uplinkTracks: [] },
    { ...body, uplinkTracks: [uplinkEntry, uplinkEntry] },
    { ...body, uplinkTracks: [{ ...uplinkEntry, objectName: "caller_original.wav.gz" }] },
    { ...body, uplinkTracks: [{ ...uplinkEntry, sourceRole: "original_capture" }] },
    { ...body, uplinkTracks: [{ ...uplinkEntry, extra: true }] },
    { ...body, derivedTracks: [] },
    { ...body, version: 3 },
  ]) {
    const rejected = await app.inject({ method: "POST", url, headers: bearer(deviceToken), payload: invalid });
    assert.equal(rejected.statusCode, 400, rejected.body);
  }
  const init = await app.inject({ method: "POST", url, headers: bearer(deviceToken), payload: body });
  assert.equal(init.statusCode, 200, init.body);
  const uploadId = init.json().upload.id;
  assert.deepEqual(init.json().upload.objects.map((item: any) => item.name).sort(),
    ["caller_original.wav.gz", "caller_uplink.wav.gz", "remote_original.wav.gz", "timeline.jsonl.gz"]);
  await putObjects(app, uploadId, [["remote_original.wav.gz", fixture.remote], ["caller_original.wav.gz", fixture.caller],
    ["caller_uplink.wav.gz", uplink], ["timeline.jsonl.gz", timeline]]);
  const finalized = await app.inject({ method: "POST", url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`, headers: bearer(deviceToken) });
  assert.equal(finalized.statusCode, 200, finalized.body);
  assert.equal(finalized.json().archive.version, 4);
  const replayed = await app.inject({ method: "POST", url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`, headers: bearer(deviceToken) });
  assert.equal(replayed.json().archive.version, 4);
  const descriptor = await app.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings?source=pixel`, headers: bearer("owner-archive-token") });
  assert.equal(descriptor.statusCode, 200, descriptor.body);
  const recording = descriptor.json().recording;
  assert.equal(recording.version, 2);
  assert.equal(recording.archiveVersion, 4);
  assert.equal(recording.derivedTracks, undefined);
  assert.deepEqual(recording.tracks.map((item: any) => item.track), ["remote_original", "caller_original"]);
  // Uplink completeness never feeds the archive-level flag; caller_original's own `false` does here.
  assert.equal(recording.captureComplete, false);
  assert.deepEqual(recording.uplinkTracks, [{ track: "caller_uplink", sourceRole: "uplink_capture", mediaType: "audio/wav",
    bytes: uplinkOriginal.length, sha256: sha(uplinkOriginal), captureComplete: false, gapCount: 1, droppedFrames: 0, durationMs: 20 }]);
  const published = JSON.parse(await readFile(join(root, callId, uploadId, "manifest.json"), "utf8"));
  assert.equal(published.uplinkTracks[0].durationMs, undefined);
  const trackUrl = `/api/v1/calls/${callId}/recordings/caller_uplink`;
  const playback = await app.inject({ method: "GET", url: `${trackUrl}?source=pixel`, headers: bearer("owner-archive-token") });
  assert.equal(playback.statusCode, 200, playback.body);
  assert.deepEqual(playback.rawPayload, uplinkOriginal);
  assert.equal((await app.inject({ method: "GET", url: trackUrl, headers: bearer("owner-archive-token") })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `${trackUrl}?source=pixel`, headers: bearer("other-archive-token") })).statusCode, 404);
  // The conversation mix must take caller_uplink: with caller_original unreadable it still succeeds.
  const callerPath = join(root, callId, uploadId, "caller_original.wav");
  const callerBytes = await readFile(callerPath);
  const cacheDir = await mkdtemp(join(tmpdir(), "vodog-v4-mp3-"));
  const mixer = await buildApp(db, config(root, validator, { RECORDING_MP3_CACHE_DIR: cacheDir }) as any);
  try {
    await writeFile(callerPath, Buffer.alloc(callerBytes.length));
    const mixed = await mixer.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings/conversation?source=pixel&format=mp3`, headers: bearer("owner-archive-token") });
    assert.equal(mixed.statusCode, 200, mixed.body);
    const uplinkMp3 = await mixer.inject({ method: "GET", url: `${trackUrl}?source=pixel&format=mp3`, headers: bearer("owner-archive-token") });
    assert.equal(uplinkMp3.statusCode, 200, uplinkMp3.body);
    const corrupted = await mixer.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings/caller_original?source=pixel&format=mp3`, headers: bearer("owner-archive-token") });
    assert.equal(corrupted.statusCode, 503, corrupted.body);
  } finally {
    await writeFile(callerPath, callerBytes);
    await mixer.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("v4 with derived playout archives five objects and publishes version 3 plus the uplink", async () => {
  await db.query(`DELETE FROM pixel_recording_archives WHERE call_id=$1`, [callId]);
  const fixture = archiveFixture();
  const uplinkOriginal = uplinkWav(), uplink = gzipSync(uplinkOriginal, { mtime: 0 } as any);
  const { droppedFrames: _drops, captureComplete: _complete, ...originalFacts } = fixture.body.tracks[1];
  const body = { ...fixture.body, version: 4,
    derivedTracks: [{ ...originalFacts, track: "caller_playout", objectName: "caller_playout.wav.gz", sourceRole: "derived_playout",
      gapCount: 0, recoveryFrames: 1, playoutComplete: true }],
    uplinkTracks: [{ ...originalFacts, track: "caller_uplink", objectName: "caller_uplink.wav.gz", sourceRole: "uplink_capture",
      compressedBytes: uplink.length, compressedSha256: sha(uplink), originalBytes: uplinkOriginal.length, originalSha256: sha(uplinkOriginal),
      gapCount: 0, droppedFrames: 0, captureComplete: true }] };
  const init = await app.inject({ method: "POST", url: `/api/v1/gateway/calls/${callId}/recording-archives`, headers: bearer(deviceToken), payload: body });
  assert.equal(init.statusCode, 200, init.body);
  const uploadId = init.json().upload.id;
  assert.equal(init.json().upload.objects.length, 5);
  await putObjects(app, uploadId, [["remote_original.wav.gz", fixture.remote], ["caller_original.wav.gz", fixture.caller],
    ["caller_playout.wav.gz", fixture.caller], ["caller_uplink.wav.gz", uplink], ["timeline.jsonl.gz", fixture.timeline]]);
  const finalized = await app.inject({ method: "POST", url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`, headers: bearer(deviceToken) });
  assert.equal(finalized.statusCode, 200, finalized.body);
  assert.equal(finalized.json().archive.version, 4);
  const recording = (await app.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings?source=pixel`, headers: bearer("owner-archive-token") })).json().recording;
  assert.equal(recording.version, 3);
  assert.equal(recording.archiveVersion, 4);
  assert.equal(recording.derivedTracks.length, 1);
  assert.equal(recording.derivedTracks[0].durationMs, 20);
  assert.equal(recording.uplinkTracks[0].durationMs, 20);
  assert.equal(recording.uplinkTracks[0].captureComplete, true);
  assert.equal(recording.captureComplete, false);
  const playout = await app.inject({ method: "GET", url: `/api/v1/calls/${callId}/recordings/caller_playout?source=pixel`, headers: bearer("owner-archive-token") });
  assert.equal(playout.statusCode, 200, playout.body);
});

test("v4 timeline frames for the uplink are rejected when the archive has no uplink object", async () => {
  await db.query(`DELETE FROM pixel_recording_archives WHERE call_id=$1`, [callId]);
  const fixture = archiveFixture();
  const timelineOriginal = Buffer.from('{"event":"start","timestampUs":0}\n' +
    '{"event":"frame","track":"caller_uplink","timestampUs":0,"sourceTimestampUs":1000,"fileOffset":44,"sampleCount":320}\n');
  const timeline = gzipSync(timelineOriginal, { mtime: 0 } as any);
  const body = { ...fixture.body, timeline: { ...fixture.body.timeline, compressedBytes: timeline.length, compressedSha256: sha(timeline),
    originalBytes: timelineOriginal.length, originalSha256: sha(timelineOriginal) } };
  const init = await app.inject({ method: "POST", url: `/api/v1/gateway/calls/${callId}/recording-archives`, headers: bearer(deviceToken), payload: body });
  assert.equal(init.statusCode, 200, init.body);
  const uploadId = init.json().upload.id;
  await putObjects(app, uploadId, [["remote_original.wav.gz", fixture.remote], ["caller_original.wav.gz", fixture.caller], ["timeline.jsonl.gz", timeline]]);
  const finalized = await app.inject({ method: "POST", url: `/api/v1/gateway/recording-archives/${uploadId}/finalize`, headers: bearer(deviceToken) });
  assert.equal(finalized.statusCode, 422, finalized.body);
});

// The chunk PUT now validates in one transaction, writes the file with no transaction
// open, and commits the watermark with a compare-and-set. A writer that lost the race
// must not advance the watermark.
test("a chunk whose committed offset moved while it was written is rejected without advancing the watermark", async () => {
  const chunk = gzipSync(Buffer.from("cas-miss-timeline-payload\n"));
  const casCall = (await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,ended_at)
     VALUES($1,$2,$3,'incoming','ended',1,'normal',now())RETURNING id`, [gateway, sim, owner])).rows[0].id;
  const casBinding = (await db.query(
    `INSERT INTO recording_capture_bindings(call_id,gateway_id,snapshot_owner_id,device_call_id,telecom_creation_time_millis,capture_generation,media_node_id,media_epoch)
     VALUES($1,$2,$3,'cas-miss-device-call',1,1,'relay-primary',1)RETURNING id`, [casCall, gateway, owner])).rows[0].id;
  const casArchive = (await db.query(
    `INSERT INTO pixel_recording_archives(call_id,capture_binding_id,gateway_id,snapshot_owner_id,client_manifest_sha256,client_manifest)
     VALUES($1,$2,$3,$4,$5,'{}'::jsonb)RETURNING id`, [casCall, casBinding, gateway, owner, "0".repeat(64)])).rows[0].id;
  await db.query(
    `INSERT INTO pixel_recording_upload_objects(archive_id,object_name,kind,compressed_bytes,compressed_sha256,original_bytes,original_sha256)
     VALUES($1,'timeline.jsonl.gz','timeline',$2,$3,3,$4)`, [casArchive, chunk.length, sha(chunk), sha(Buffer.from("{}\n"))]);
  const seam = Fastify();
  seam.setErrorHandler((error: any, _request, reply) =>
    reply.code(error.status ?? 500).send({ error: { code: error.code ?? "INTERNAL_ERROR", message: error.message, details: error.details } }));
  registerRecordingArchiveRoutes(seam, db, {
    enabled: true, root, validatorPath: validator,
    requireGateway: () => ({ gatewayId: gateway }),
    requireUser: () => ({ userId: owner }),
    fail: (status, code, message, details) => { throw Object.assign(new Error(message), { status, code, details }); },
    // A competing writer commits a different offset after the bytes are on disk.
    onChunkWritten: async (uploadId, objectName) => {
      await db.query(`UPDATE pixel_recording_upload_objects SET committed_offset=1,updated_at=now() WHERE archive_id=$1 AND object_name=$2`, [uploadId, objectName]);
    },
  });
  await seam.ready();
  try {
    const lost = await seam.inject({
      method: "PUT",
      url: `/api/v1/gateway/recording-archives/${casArchive}/objects/timeline.jsonl.gz`,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${chunk.length - 1}/${chunk.length}`,
        digest: `sha-256=${createHash("sha256").update(chunk).digest("base64")}`,
      },
      payload: chunk,
    });
    assert.equal(lost.statusCode, 409, lost.body);
    assert.equal(lost.json().error.code, "ARCHIVE_OFFSET_MISMATCH");
    assert.equal(lost.json().error.details.committedOffset, 1);
    const row = (await db.query(
      `SELECT committed_offset,state FROM pixel_recording_upload_objects WHERE archive_id=$1`, [casArchive])).rows[0];
    assert.equal(Number(row.committed_offset), 1, "a lost CAS must not advance the watermark");
    assert.equal(row.state, "uploading");
  } finally { await seam.close(); }
});
