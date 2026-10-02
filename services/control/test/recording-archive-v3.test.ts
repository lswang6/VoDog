import assert from "node:assert/strict";
import test from "node:test";
import { parsePixelRecordingDescriptor } from "../src/recording-archive.js";

const base = {
  source: "pixel" as const,
  version: 3 as const,
  archiveId: "11111111-1111-4111-8111-111111111111",
  callId: "22222222-2222-4222-8222-222222222222",
  manifestSha256: "a".repeat(64),
  archiveComplete: true as const,
  captureComplete: false,
  startedAt: "2026-09-10T00:00:00.000Z",
  endedAt: "2026-09-10T00:01:00.000Z",
  tracks: [
    { track: "remote_original" as const, sourceRole: "original_capture" as const, mediaType: "audio/wav" as const,
      bytes: 684, sha256: "b".repeat(64), captureComplete: true, gapCount: 0, droppedFrames: 0 },
    { track: "caller_original" as const, sourceRole: "original_capture" as const, mediaType: "audio/wav" as const,
      bytes: 684, sha256: "c".repeat(64), captureComplete: false, gapCount: 1, droppedFrames: 1 },
  ],
  derivedTracks: [
    { track: "caller_playout" as const, sourceRole: "derived_playout" as const, mediaType: "audio/wav" as const,
      bytes: 1324, sha256: "d".repeat(64), playoutComplete: true, gapCount: 0, recoveryFrames: 1 },
  ],
  timeline: { mediaType: "application/x-ndjson" as const, bytes: 123, sha256: "e".repeat(64) },
};

test("v3 descriptor preserves original and derived source roles", () => {
  const parsed = parsePixelRecordingDescriptor(base);
  assert.equal(parsed.captureComplete, false);
  assert.equal(parsed.tracks[1].sourceRole, "original_capture");
  assert.equal(parsed.derivedTracks?.[0].sourceRole, "derived_playout");
});

test("descriptor rejects duplicate originals, promoted completeness, and v2 derived data", () => {
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, tracks: [base.tracks[0], base.tracks[0]], captureComplete: true }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, captureComplete: true }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, version: 2 }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, endedAt: "2026-09-09T23:59:00.000Z" }));
});

test("v2 descriptor remains valid without a derived track", () => {
  const { derivedTracks: _derivedTracks, ...v2 } = base;
  const parsed = parsePixelRecordingDescriptor({ ...v2, version: 2 });
  assert.equal(parsed.version, 2);
  assert.equal(parsed.derivedTracks, undefined);
});

test("S94 descriptor accepts archiveVersion 4 with exactly one uplink and only both together", () => {
  const { derivedTracks: _derivedTracks, ...v2 } = base;
  const uplinkTracks = [{ track: "caller_uplink" as const, sourceRole: "uplink_capture" as const, mediaType: "audio/wav" as const,
    bytes: 684, sha256: "f".repeat(64), captureComplete: false, gapCount: 2, droppedFrames: 0 }];
  const parsed = parsePixelRecordingDescriptor({ ...v2, version: 2, archiveVersion: 4, uplinkTracks });
  assert.equal(parsed.archiveVersion, 4);
  assert.equal(parsed.uplinkTracks?.[0].track, "caller_uplink");
  assert.equal(parsePixelRecordingDescriptor({ ...base, archiveVersion: 4, uplinkTracks }).version, 3);
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, archiveVersion: 4 }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, uplinkTracks }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, archiveVersion: 4, uplinkTracks: [...uplinkTracks, ...uplinkTracks] }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, version: 4, archiveVersion: 4, uplinkTracks }));
  assert.throws(() => parsePixelRecordingDescriptor({ ...base, archiveVersion: 4, uplinkTracks: [{ ...uplinkTracks[0], track: "caller_original" }] }));
});
