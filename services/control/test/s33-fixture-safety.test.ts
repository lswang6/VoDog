import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLoopbackListen,
  assertSafeS33DatabaseUrl,
  assertSafeS33WebOrigin,
  S33_DATABASE_NAME,
  S33_WEB_ORIGIN,
} from "../../../infra/s33-fixture-safety.js";

test("S33 fixture accepts only its exact loopback disposable database", () => {
  assert.equal(
    assertSafeS33DatabaseUrl(`postgresql://127.0.0.1:5432/${S33_DATABASE_NAME}`).hostname,
    "127.0.0.1",
  );
  assert.equal(
    assertSafeS33DatabaseUrl(`postgres://localhost/${S33_DATABASE_NAME}`).hostname,
    "localhost",
  );
  for (const url of [
    "postgresql://db.example.test/vodog_s33_ui_test",
    "postgresql://127.0.0.1/vodog_s33_root_test",
    "postgresql://127.0.0.1/vodog",
    "https://127.0.0.1/vodog_s33_ui_test",
    "postgresql://127.0.0.1/vodog_s33_ui_test?host=remote.example",
    "postgresql://127.0.0.1/vodog_s33_ui_test?database=production",
    "postgresql://127.0.0.1/vodog_s33_ui_test?dbname=production",
    "postgresql://127.0.0.1/vodog_s33_ui_test#production",
  ]) assert.throws(() => assertSafeS33DatabaseUrl(url));
});

test("S33 fixture has a frozen loopback listener", () => {
  assert.doesNotThrow(() => assertLoopbackListen("127.0.0.1", 16880));
  assert.throws(() => assertLoopbackListen("0.0.0.0", 16880));
  assert.throws(() => assertLoopbackListen("127.0.0.1", 3100));
});

test("S33 fixture accepts only the exact local Web origin", () => {
  assert.equal(assertSafeS33WebOrigin(S33_WEB_ORIGIN).origin, S33_WEB_ORIGIN);
  for (const origin of [
    "http://localhost:4183",
    "http://127.0.0.1:4185",
    "http://0.0.0.0:4183",
    "https://127.0.0.1:4183",
    "http://127.0.0.1:4183/extra",
    "http://127.0.0.1:4183?redirect=http://example.test",
    "http://user@127.0.0.1:4183",
  ]) assert.throws(() => assertSafeS33WebOrigin(origin));
});
