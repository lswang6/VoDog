import assert from 'node:assert/strict';
import test from 'node:test';
import type {QueryResult} from 'pg';
import {countOwnerInterceptions,loadOwnerInterceptions} from '../src/blocklist.js';

test('S47: SQL excludes the other kind before paging and counting; default all stays compatible',async()=>{
  const queries:{sql:string;params?:unknown[]}[]=[];
  const db={query:async(sql:string,params?:unknown[])=>{
    queries.push({sql,params});
    return {rows:[{total:'60'}]} as QueryResult<any>;
  }};
  for(const offset of [undefined,50]){
    await loadOwnerInterceptions(db,'owner',50,offset);
    const legacy=queries.at(-1)!;
    await loadOwnerInterceptions(db,'owner',50,offset,'all');
    assert.deepEqual(queries.at(-1),legacy);
    assert.deepEqual(legacy.params,offset===undefined?['owner',50]:['owner',50,offset]);
    for(const kind of ['call','sms'] as const){
      await loadOwnerInterceptions(db,'owner',50,offset,kind);
      const query=queries.at(-1)!;
      assert.deepEqual(query.params,legacy.params);
      const [calls,sms]=query.sql.split('UNION ALL');
      assert.equal(calls.includes('AND false'),kind==='sms');
      assert.equal(sms.includes('AND false'),kind==='call');
      assert.match(calls,/c.snapshot_owner_id=\$1 AND c.failure_reason='number_blocked'/);
      assert.match(sms,/i.owner_user_id=\$1/);
      assert.ok(query.sql.indexOf('AND false')<query.sql.indexOf('LIMIT $2'));
      assert.match(query.sql,/ORDER BY occurred_at DESC,id DESC LIMIT \$2/);
    }
  }
  await countOwnerInterceptions(db,'owner');
  const legacyCount=queries.at(-1)!;
  await countOwnerInterceptions(db,'owner','all');
  assert.deepEqual(queries.at(-1),legacyCount);
  for(const kind of ['call','sms'] as const){
    assert.equal(await countOwnerInterceptions(db,'owner',kind),60);
    const query=queries.at(-1)!;
    assert.deepEqual(query.params,['owner']);
    const [calls,sms]=query.sql.split('+');
    assert.equal(calls.includes('AND false'),kind==='sms');
    assert.equal(sms.includes('AND false'),kind==='call');
    assert.match(calls,/snapshot_owner_id=\$1 AND failure_reason='number_blocked'/);
    assert.match(sms,/owner_user_id=\$1/);
  }
});
test('S64: simId filters both halves before paging and counting as the last parameter',async()=>{
  const queries:{sql:string;params?:unknown[]}[]=[];
  const db={query:async(sql:string,params?:unknown[])=>{
    queries.push({sql,params});
    return {rows:[{total:'7'}]} as QueryResult<any>;
  }};
  for(const offset of [undefined,50]){
    await loadOwnerInterceptions(db,'owner',50,offset,'call');
    const legacy=queries.at(-1)!;
    await loadOwnerInterceptions(db,'owner',50,offset,'call',undefined);
    assert.deepEqual(queries.at(-1),legacy,'an absent simId keeps the legacy SQL and parameters');
    assert.ok(!legacy.sql.includes('sim_id=$'));
    await loadOwnerInterceptions(db,'owner',50,offset,'call','sim');
    const query=queries.at(-1)!;
    const n=offset===undefined?3:4;
    assert.deepEqual(query.params,[...legacy.params!,'sim']);
    const [calls,sms]=query.sql.split('UNION ALL');
    assert.match(calls,new RegExp(`c\\.failure_reason='number_blocked' AND c\\.sim_id=\\$${n}\\)`));
    assert.match(sms,new RegExp(`i\\.owner_user_id=\\$1 AND false AND i\\.sim_id=\\$${n}\\)`));
    assert.ok(query.sql.lastIndexOf(`sim_id=$${n}`)<query.sql.indexOf('ORDER BY'));
  }
  await countOwnerInterceptions(db,'owner','sms');
  const legacyCount=queries.at(-1)!;
  assert.deepEqual(legacyCount.params,['owner']);
  assert.ok(!legacyCount.sql.includes('sim_id'));
  assert.equal(await countOwnerInterceptions(db,'owner','sms','sim'),7);
  const query=queries.at(-1)!;
  assert.deepEqual(query.params,['owner','sim']);
  const [calls,sms]=query.sql.split('+');
  assert.match(calls,/AND false AND sim_id=\$2\)/);
  assert.match(sms,/owner_user_id=\$1 AND sim_id=\$2\)/);
});
