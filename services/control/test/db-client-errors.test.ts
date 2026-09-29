import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDb, safeRollback, withClient } from '../src/db.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl) throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');

// Production crashed three times in one night because a checked-out client emitted
// `error` ("terminating connection due to idle-in-transaction timeout", 25P03) with no
// listener. Reaching the end of these tests is the proof the process survives it.
test('a connection Postgres terminates mid-checkout rejects the caller, never exits, and is destroyed not recycled',async()=>{
  const db=createDb(databaseUrl);
  const poolErrors:unknown[]=[];db.on('error',error=>poolErrors.push(error));
  try{
    await db.query('SELECT 1');
    assert.equal(db.totalCount,1);
    await assert.rejects(withClient(db,async c=>{
      await c.query('BEGIN');
      await c.query(`SET LOCAL idle_in_transaction_session_timeout='50ms'`);
      await delay(400);
      await c.query('SELECT 1');
    }),(error:unknown)=>{
      const e=error as {code?:string;message?:string};
      return e.code==='25P03'||/terminat|not queryable/i.test(String(e.message));
    });
    assert.equal(db.totalCount,0,'a killed connection must be destroyed, not returned to the pool');
    assert.equal(db.idleCount,0);
    assert.equal((await db.query('SELECT 1 ok')).rowCount,1,'the pool still serves new work');
  } finally { await db.end(); }
  assert.ok(poolErrors.every(error=>error instanceof Error));
});

test('safeRollback swallows a rollback on a dead connection and still destroys it',async()=>{
  const db=createDb(databaseUrl);
  try{
    let rollbackError:Error|undefined;
    await withClient(db,async c=>{
      await c.query('BEGIN');
      await c.query(`SET LOCAL idle_in_transaction_session_timeout='50ms'`);
      await delay(400);
      rollbackError=await safeRollback(c);
    });
    assert.ok(rollbackError instanceof Error,'rollback on a terminated connection reports its own failure');
    assert.equal(db.totalCount,0,'a failed rollback leaves unknown state, so the client is destroyed');
  } finally { await db.end(); }
});

test('withClient destroys a client whose rollback fails and keeps the original error',async()=>{
  const db=createDb(databaseUrl);
  try{
    await assert.rejects(withClient(db,async c=>{
      await c.query('BEGIN');
      await c.query(`SET LOCAL idle_in_transaction_session_timeout='50ms'`);
      await delay(400);
      await safeRollback(c);
      throw new Error('original failure wins');
    }),/original failure wins/);
    assert.equal(db.totalCount,0);
  } finally { await db.end(); }
});
