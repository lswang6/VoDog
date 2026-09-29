import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RecordingFileVerificationBusyError,
  RecordingFileVerificationError,
  RecordingFileVerifier,
  hashRecordingFile,
} from "../src/recording-file-verifier.js";

const sha = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function fixture(contents: string[]) {
  const root = await mkdtemp(join(tmpdir(), "cc-recording-verifier-"));
  const paths = contents.map((_, index) => join(root, `track-${index}.wav`));
  await Promise.all(paths.map((path, index) => writeFile(path, contents[index]!)));
  return { root, paths, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("same immutable file facts share one hash and each caller keeps its own handle", async () => {
  const f = await fixture(["stable-recording"]), gate = deferred<void>(), started = deferred<void>();
  let hashes = 0;
  const verifier = new RecordingFileVerifier({
    hash: async (file, timeout) => {
      hashes += 1;
      started.resolve();
      await gate.promise;
      return hashRecordingFile(file, timeout);
    },
  });
  const first = await open(f.paths[0]!, constants.O_RDONLY),
    second = await open(f.paths[0]!, constants.O_RDONLY);
  try {
    const a = verifier.verify(first, sha(Buffer.from("stable-recording"))),
      b = verifier.verify(second, sha(Buffer.from("stable-recording")));
    await started.promise;
    assert.equal(hashes, 1);
    gate.resolve();
    await Promise.all([a, b]);
    assert.equal((await first.stat()).size, 16);
    assert.equal((await second.stat()).size, 16);
  } finally {
    await first.close(); await second.close(); await f.cleanup();
  }
});

test("two distinct hashes consume both slots and a third fails without queuing", async () => {
  const f = await fixture(["one", "two", "three"]), gate = deferred<void>(), bothStarted = deferred<void>();
  let hashes = 0;
  const verifier = new RecordingFileVerifier({
    maxConcurrentHashes: 2,
    hash: async (file, timeout) => {
      hashes += 1;
      if (hashes === 2) bothStarted.resolve();
      await gate.promise;
      return hashRecordingFile(file, timeout);
    },
  });
  const handles = await Promise.all(f.paths.map((path) => open(path, constants.O_RDONLY)));
  try {
    const first = verifier.verify(handles[0]!, sha(Buffer.from("one"))),
      second = verifier.verify(handles[1]!, sha(Buffer.from("two")));
    await bothStarted.promise;
    await assert.rejects(
      verifier.verify(handles[2]!, sha(Buffer.from("three"))),
      RecordingFileVerificationBusyError,
    );
    assert.equal(hashes, 2);
    gate.resolve();
    await Promise.all([first, second]);
  } finally {
    await Promise.all(handles.map((handle) => handle.close())); await f.cleanup();
  }
});

test("metadata changing during hash fails closed and failures are never cached", async () => {
  const f = await fixture(["before"]), expected = sha(Buffer.from("before"));
  let hashes = 0;
  const verifier = new RecordingFileVerifier({
    hash: async (file, timeout) => {
      hashes += 1;
      if (hashes === 1) await writeFile(f.paths[0]!, "changed-after-stat");
      return hashRecordingFile(file, timeout);
    },
  });
  const first = await open(f.paths[0]!, constants.O_RDONLY);
  try {
    await assert.rejects(verifier.verify(first, expected), RecordingFileVerificationError);
  } finally { await first.close(); }
  await writeFile(f.paths[0]!, "before");
  const second = await open(f.paths[0]!, constants.O_RDONLY);
  try {
    await verifier.verify(second, expected);
    assert.equal(hashes, 2);
  } finally { await second.close(); await f.cleanup(); }
});

test("cache is bound to expected SHA, expires, and evicts completed entries at its bound", async () => {
  const f = await fixture(["first", "second", "third"]);
  let now = 1_000, hashes = 0;
  const verifier = new RecordingFileVerifier({
    maxEntries: 2,
    ttlMs: 30,
    now: () => now,
    hash: async (file, timeout) => { hashes += 1; return hashRecordingFile(file, timeout); },
  });
  async function verify(index: number, value: string, expected = sha(Buffer.from(value))) {
    const file = await open(f.paths[index]!, constants.O_RDONLY);
    try { await verifier.verify(file, expected); } finally { await file.close(); }
  }
  try {
    await verify(0, "first");
    await verify(0, "first");
    assert.equal(hashes, 1);
    await assert.rejects(verify(0, "first", "0".repeat(64)), RecordingFileVerificationError);
    assert.equal(hashes, 2, "a different expected SHA must not reuse the successful entry");
    await verify(1, "second");
    await verify(2, "third");
    await verify(0, "first");
    assert.equal(hashes, 5, "the bounded cache must evict a completed old entry");
    now += 31;
    await verify(0, "first");
    assert.equal(hashes, 6, "expired verification must be repeated");
  } finally { await f.cleanup(); }
});
