import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://localhost/disposable-only",
  PUBLIC_ORIGIN: "https://vodog.test",
  RP_ID: "vodog.test",
  COOKIE_SECRET: "archive-config-test-secret-at-least-32-characters",
};

test("Pixel archive is disabled with bounded storage and finalize defaults", () => {
  const config = loadConfig(base);
  assert.equal(config.PIXEL_ARCHIVE_ENABLED, false);
  assert.equal(config.PIXEL_ARCHIVE_MAX_PENDING_PER_GATEWAY, 2);
  assert.equal(config.PIXEL_ARCHIVE_FINALIZE_CONCURRENCY, 1);
  assert.ok(config.PIXEL_ARCHIVE_MIN_FREE_BYTES > 0);
  assert.ok(
    config.PIXEL_ARCHIVE_MAX_BYTES_PER_OWNER <
      config.PIXEL_ARCHIVE_MAX_BYTES_PER_GATEWAY,
  );
});

test("enabled Pixel archive requires fixed absolute storage and validator paths", () => {
  assert.throws(() => loadConfig({ ...base, PIXEL_ARCHIVE_ENABLED: "true" }));
  assert.throws(() =>
    loadConfig({
      ...base,
      PIXEL_ARCHIVE_ENABLED: "true",
      PIXEL_ARCHIVE_ROOT: "relative/archive",
      PIXEL_ARCHIVE_VALIDATOR_PATH: "/fixed/validator",
    }),
  );
  assert.doesNotThrow(() =>
    loadConfig({
      ...base,
      PIXEL_ARCHIVE_ENABLED: "true",
      PIXEL_ARCHIVE_ROOT: "/fixed/archive",
      PIXEL_ARCHIVE_VALIDATOR_PATH: "/fixed/validator",
    }),
  );
});
