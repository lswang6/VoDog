import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pretranscodePixelRecording } from "../src/app.js";
import { errorReason, throttled } from "../src/diag.js";
import { PushWorker } from "../src/push-worker.js";
import type { Db } from "../src/db.js";

function fakeDb(failNonDiag = false) {
  const diags: { event: string; fields: any; callId: unknown; level: unknown }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO diag_events")) {
        diags.push({ event: params[5] as string, fields: JSON.parse(params[6] as string), callId: params[3], level: params[4] });
        return { rows: [], rowCount: 1 };
      }
      if (failNonDiag) throw Object.assign(new Error("boom 13800000000"), { code: "57P01" });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;
  return { db, diags };
}
const callId = "11111111-2222-4333-8444-555555555555";
const reader = {
  manifest: async () => ({ tracks: [{ track: "remote_original" }, { track: "caller_original" }] }) as any,
  openTrack: async () => ({ stream: Readable.from([]) }) as any,
};

test("a completed Pixel archive pre-builds each track's mp3 into the route's cache path once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-mp3-"));
  try {
    const { db, diags } = fakeDb();
    const targets: string[] = [];
    const transcode = async (_db: Db, _dir: string, target: string) => { targets.push(target); await writeFile(target, "mp3"); };
    await pretranscodePixelRecording(db, reader, dir, callId, transcode);
    assert.deepEqual(targets, [join(dir, `${callId}-pixel-remote_original.mp3`), join(dir, `${callId}-pixel-caller_original.mp3`)]);
    await pretranscodePixelRecording(db, reader, dir, callId, transcode);
    assert.equal(targets.length, 2, "cached files are skipped");
    assert.equal(diags.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed pre-transcode is one warn diag row and never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-mp3-"));
  try {
    const { db, diags } = fakeDb();
    await pretranscodePixelRecording(db, reader, dir, callId, async () => { throw Object.assign(new Error(`/srv/${callId}.wav`), { code: "FFMPEG_FAILED" }); });
    assert.equal(diags.length, 1);
    assert.deepEqual(diags[0], { event: "recording.pretranscode_failed", fields: { track: "remote_original", reason: "Error:FFMPEG_FAILED" }, callId, level: "warn" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("throttled allows one hit per window and errorReason drops the message", () => {
  assert.equal(throttled("t", 60_000, 1_000), true);
  assert.equal(throttled("t", 60_000, 30_000), false);
  assert.equal(throttled("t", 60_000, 61_001), true);
  assert.equal(errorReason(Object.assign(new Error("secret 13800000000"), { code: "E1" })), "Error:E1");
});

test("a failing push worker run files one rate-limited push.worker_error row and still rejects", async () => {
  const { db, diags } = fakeDb(true);
  const worker = new PushWorker(db, { sendIncoming: async () => ({}) } as any);
  await assert.rejects(worker.tick());
  await assert.rejects(worker.tick());
  assert.deepEqual(diags.map((d) => [d.event, d.fields, d.level]), [["push.worker_error", { worker: "apns", reason: "Error:57P01" }, "warn"]]);
});
