import assert from 'node:assert/strict';
import test from 'node:test';
import type {PoolClient} from 'pg';
import {tx} from '../src/app.js';
import type {Db} from '../src/db.js';

/**
 * 2026-09-18: `POST /api/v1/gateway/calls/:id/media/options` returned 500 on a Postgres deadlock
 * (40P01) and the gateway withdrew the call's media. A deadlock victim is fully rolled back, so
 * `tx` re-runs the closure. No database here — the point is the wrapper, not Postgres.
 */
function fakeDb() {
  const statements: string[] = [];
  const diagEvents: unknown[][] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return {rowCount: 0, rows: []};
    },
    on: () => undefined,
    removeListener: () => undefined,
    release: () => undefined,
  };
  const db = {
    connect: async () => client as unknown as PoolClient,
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('diag_events')) diagEvents.push(params);
      return {rowCount: 1, rows: []};
    },
  } as unknown as Db;
  return {db, statements, diagEvents};
}

const sqlError = (code: string) => Object.assign(new Error(`synthetic ${code}`), {code});

test('tx retries a deadlock victim once and commits the second attempt', async () => {
  const {db, statements, diagEvents} = fakeDb();
  let attempts = 0;
  const value = await tx(db, async () => {
    attempts += 1;
    if (attempts === 1) throw sqlError('40P01');
    return 'ok';
  }, 'gateway.media.authorize');
  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
  assert.equal(statements.filter((s) => s === 'BEGIN').length, 2);
  assert.equal(statements.filter((s) => s === 'ROLLBACK').length, 1);
  assert.equal(statements.filter((s) => s === 'COMMIT').length, 1);
  // Production has to be able to count how often this fires.
  assert.equal(diagEvents.length, 1);
  assert.match(String(diagEvents[0]?.[6]), /db\.deadlock_retry|gateway\.media\.authorize/);
});

test('tx retries a serialization failure too', async () => {
  const {db} = fakeDb();
  let attempts = 0;
  await tx(db, async () => {
    attempts += 1;
    if (attempts < 3) throw sqlError('40001');
  });
  assert.equal(attempts, 3);
});

test('tx rethrows a non-retryable error without a second attempt', async () => {
  const {db, statements, diagEvents} = fakeDb();
  let attempts = 0;
  await assert.rejects(
    tx(db, async () => {
      attempts += 1;
      throw sqlError('23505');
    }),
    /synthetic 23505/,
  );
  assert.equal(attempts, 1);
  assert.equal(statements.filter((s) => s === 'BEGIN').length, 1);
  assert.equal(diagEvents.length, 0);
});

test('tx gives up after three attempts', async () => {
  const {db} = fakeDb();
  let attempts = 0;
  await assert.rejects(
    tx(db, async () => {
      attempts += 1;
      throw sqlError('40P01');
    }),
    /synthetic 40P01/,
  );
  assert.equal(attempts, 3);
});
