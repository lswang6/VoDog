import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

export class RecordingFileVerificationBusyError extends Error {
  constructor(message = "Recording file verification capacity is busy") {
    super(message);
    this.name = "RecordingFileVerificationBusyError";
  }
}

export class RecordingFileVerificationError extends Error {
  constructor(message = "Recording file integrity verification failed") {
    super(message);
    this.name = "RecordingFileVerificationError";
  }
}

type FileFacts = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type CacheEntry = {
  promise: Promise<void>;
  expiresAt: number;
  inFlight: boolean;
};

export type RecordingFileHash = (
  file: FileHandle,
  timeoutMs: number,
) => Promise<string>;

export type RecordingFileVerifierOptions = {
  maxEntries?: number;
  ttlMs?: number;
  maxConcurrentHashes?: number;
  hashTimeoutMs?: number;
  now?: () => number;
  hash?: RecordingFileHash;
};

const factsKey = (facts: FileFacts, expectedSha256: string) =>
  [
    facts.dev,
    facts.ino,
    facts.size,
    facts.mtimeNs,
    facts.ctimeNs,
    expectedSha256,
  ].join(":");

async function fileFacts(file: FileHandle): Promise<FileFacts> {
  const value = await file.stat({ bigint: true });
  if (!value.isFile()) throw new RecordingFileVerificationError();
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

const sameFacts = (a: FileFacts, b: FileFacts) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

export const hashRecordingFile: RecordingFileHash = async (file, timeoutMs) => {
  const hash = createHash("sha256");
  const stream = file.createReadStream({ autoClose: false, start: 0 });
  const timeout = setTimeout(
    () => stream.destroy(new RecordingFileVerificationBusyError("Recording file verification timed out")),
    timeoutMs,
  );
  timeout.unref();
  try {
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Bounds expensive immutable-file verification. HTTP cancellation does not cancel a
 * shared hash: another consumer may still need it, while the two-slot deadline keeps
 * the retained file handle and stream bounded.
 */
export class RecordingFileVerifier {
  private readonly cache = new Map<string, CacheEntry>();
  private activeHashes = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxConcurrentHashes: number;
  private readonly hashTimeoutMs: number;
  private readonly now: () => number;
  private readonly hash: RecordingFileHash;

  constructor(options: RecordingFileVerifierOptions = {}) {
    this.maxEntries = options.maxEntries ?? 128;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxConcurrentHashes = options.maxConcurrentHashes ?? 2;
    this.hashTimeoutMs = options.hashTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.hash = options.hash ?? hashRecordingFile;
    if (
      this.maxEntries < 1 ||
      this.ttlMs < 1 ||
      this.maxConcurrentHashes < 1 ||
      this.hashTimeoutMs < 1
    )
      throw new Error("Invalid recording verifier limits");
  }

  async verify(file: FileHandle, expectedSha256: string): Promise<void> {
    const before = await fileFacts(file);
    const key = factsKey(before, expectedSha256);
    this.prune();
    let entry = this.cache.get(key);
    if (!entry) {
      if (this.activeHashes >= this.maxConcurrentHashes)
        throw new RecordingFileVerificationBusyError();
      this.makeRoom();
      this.activeHashes += 1;
      const promise = (async () => {
        const actual = await this.hash(file, this.hashTimeoutMs);
        const after = await fileFacts(file);
        if (!sameFacts(before, after) || actual !== expectedSha256)
          throw new RecordingFileVerificationError();
      })();
      entry = { promise, expiresAt: Number.POSITIVE_INFINITY, inFlight: true };
      this.cache.set(key, entry);
      void promise.then(
        () => {
          entry!.inFlight = false;
          entry!.expiresAt = this.now() + this.ttlMs;
          this.activeHashes -= 1;
        },
        () => {
          if (this.cache.get(key) === entry) this.cache.delete(key);
          this.activeHashes -= 1;
        },
      );
    }
    await entry.promise;
    const after = await fileFacts(file);
    if (!sameFacts(before, after)) throw new RecordingFileVerificationError();
  }

  private prune() {
    const now = this.now();
    for (const [key, entry] of this.cache)
      if (!entry.inFlight && entry.expiresAt <= now) this.cache.delete(key);
  }

  private makeRoom() {
    while (this.cache.size >= this.maxEntries) {
      const completed = [...this.cache].find(([, entry]) => !entry.inFlight);
      if (!completed) throw new RecordingFileVerificationBusyError();
      this.cache.delete(completed[0]);
    }
  }
}
