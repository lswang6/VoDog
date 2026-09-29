import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import { createDb, type Db } from '../src/db.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl) throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');
const run=promisify(execFile);
const helper=fileURLToPath(new URL('../../../infra/control_code_recovery_gate.py',import.meta.url));
let db:Db;

async function gateSql(callId:string){
  const program=[
    'import importlib.util, sys',
    'spec=importlib.util.spec_from_file_location("control_code_recovery_gate",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(module.quiescence_query(sys.argv[2]))',
  ].join(';');
  return (await run('python3',['-c',program,helper,callId])).stdout;
}

async function gateCount(callId:string){
  const row=(await db.query(await gateSql(callId))).rows[0];
  return Number(Object.values(row)[0]);
}

async function expiredAckGateSql(evidence:Record<string,unknown>){
  const program=[
    'import importlib.util, json, sys',
    'spec=importlib.util.spec_from_file_location("control_code_recovery_gate",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(module.quiescence_query(expired_ack_evidence=json.loads(sys.argv[2])))',
  ].join(';');
  return (await run('python3',['-c',program,helper,JSON.stringify(evidence)])).stdout;
}

async function expiredAckGateCount(evidence:Record<string,unknown>){
  const row=(await db.query(await expiredAckGateSql(evidence))).rows[0];
  return Number(Object.values(row)[0]);
}

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
});

after(async()=>{await db.end();});

test('deployment recovery gate permits only exact expired non-executing call evidence',async()=>{
  const user=(await db.query(`INSERT INTO users(email,password_hash)VALUES('gate@example.test','test')RETURNING id`)).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,device_epoch)VALUES('gate',2)RETURNING id`)).rows[0].id;
  const sim=(await db.query(`INSERT INTO sims(gateway_id,owner_user_id,label)VALUES($1,$2,'gate SIM')RETURNING id`,[gateway,user])).rows[0].id;
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,failure_reason)VALUES($1,$2,$3,'outgoing','unknown',2,'normal','media_capability_withdrawn')RETURNING id`,[gateway,sim,user])).rows[0].id;
  await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,2)`,[gateway,call]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,2,gen_random_uuid(),1,3,false,'[]',now())`,[gateway]);
  await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES
    ($1,$2,2,1,'dial','{}',now()-interval '10 seconds','rejected','{"reason":"media_capability_withdrawn"}'),
    ($1,$2,2,2,'hangup','{}',now()-interval '8 seconds','rejected','{"reason":"command_expired","phase":"not_executed"}'),
    ($1,$2,2,3,'hangup','{}',now()-interval '6 seconds','rejected','{"reason":"call_not_found","phase":"not_executed"}')`,[gateway,call]);

  assert.equal(await gateCount(call),0);
  assert.ok(await gateCount(crypto.randomUUID())>0,'a different UUID must not exempt the locked call');

  await db.query(`UPDATE commands SET result='{"reason":"command_expired","phase":"not_executed"}' WHERE call_id=$1 AND sequence=1`,[call]);
  assert.equal(await gateCount(call),0,'an expired non-executing dial is also safe read-only evidence');
  await db.query(`UPDATE commands SET result='{"reason":"media_capability_withdrawn"}' WHERE call_id=$1 AND sequence=1`,[call]);

  await db.query(`UPDATE commands SET result='{"reason":"command_expired","phase":"submitted"}' WHERE call_id=$1 AND sequence=2`,[call]);
  assert.ok(await gateCount(call)>0,'submitted hangup evidence must retain the gate');

  await db.query(`UPDATE commands SET result='{"reason":"command_expired"}' WHERE call_id=$1 AND sequence=2`,[call]);
  assert.ok(await gateCount(call)>0,'command_expired without exact not_executed must retain the gate');

  await db.query(`UPDATE commands SET result='{"reason":"command_expired","phase":"not_executed"}',expires_at=now()+interval '10 seconds' WHERE call_id=$1 AND sequence=2`,[call]);
  assert.ok(await gateCount(call)>0,'unexpired command evidence must retain the gate');

  await db.query(`UPDATE commands SET expires_at=now()-interval '8 seconds',status='acked' WHERE call_id=$1 AND sequence=2`,[call]);
  assert.ok(await gateCount(call)>0,'acked command evidence must retain the gate');
});

test('deployment recovery helper rejects a non-UUID exemption target',async()=>{
  await assert.rejects(gateSql('not-a-uuid'));
});

test('expired ACK outbox deployment gate executes the exact contiguous evidence manifest',async()=>{
  await db.query(`DELETE FROM gateway_call_locks; UPDATE call_records SET state='failed',ended_at=now() WHERE state='unknown'`);
  const user=(await db.query(`INSERT INTO users(email,password_hash)VALUES('expired-gate@example.test','test')RETURNING id`)).rows[0].id;
  const gateway=(await db.query(`INSERT INTO gateways(name,device_epoch,command_sequence)VALUES('expired-gate',2,29)RETURNING id`)).rows[0].id;
  const sim=(await db.query(`INSERT INTO sims(gateway_id,owner_user_id,label)VALUES($1,$2,'expired gate SIM')RETURNING id`,[gateway,user])).rows[0].id;
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,failure_reason)VALUES($1,$2,$3,'outgoing','unknown',2,'normal','hangup_terminal_unconfirmed')RETURNING id`,[gateway,sim,user])).rows[0].id;
  await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation)VALUES($1,$2,2)`,[gateway,call]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,2,gen_random_uuid(),1,26,false,'[]',now())`,[gateway]);
  const commands=[
    {id:crypto.randomUUID(),sequence:27,kind:'dial',serverStatus:'rejected',serverReason:'media_capability_withdrawn',deviceAck:null},
    {id:crypto.randomUUID(),sequence:28,kind:'hangup',serverStatus:'expired',serverReason:'expired',deviceAck:{generation:2,status:'rejected',telecomState:null,executedAt:null,deviceCallId:null,phase:'not_executed',reason:'command_expired',attemptCount:23,lastFailureCode:'http_4xx'}},
    {id:crypto.randomUUID(),sequence:29,kind:'hangup',serverStatus:'expired',serverReason:'expired',deviceAck:null},
  ];
  for(const command of commands) await db.query(`INSERT INTO commands(id,gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES($1,$2,$3,2,$4,$5,'{}',now()-interval '5 seconds',$6,jsonb_build_object('reason',$7::text))`,[command.id,gateway,call,command.sequence,command.kind,command.serverStatus,command.serverReason]);
  const evidence={schemaVersion:1,callId:call,generation:2,reportedSequence:26,commands};
  assert.equal(await expiredAckGateCount(evidence),0);
  await db.query(`UPDATE commands SET result='{"reason":"execution_unknown"}' WHERE id=$1`,[commands[2].id]);
  assert.ok(await expiredAckGateCount(evidence)>0,'a drifted server command must retain the deployment gate');
  await db.query(`UPDATE commands SET result='{"reason":"expired"}' WHERE id=$1`,[commands[2].id]);
  await db.query(`UPDATE commands SET call_id=NULL WHERE id=$1`,[commands[2].id]);
  assert.ok(await expiredAckGateCount(evidence)>0,'a null call binding must retain the deployment gate');
  await db.query(`UPDATE commands SET call_id=$2 WHERE id=$1`,[commands[2].id,call]);
  await db.query(`UPDATE commands SET result=NULL WHERE id=$1`,[commands[2].id]);
  assert.ok(await expiredAckGateCount(evidence)>0,'a null command result must retain the deployment gate');
  await db.query(`UPDATE commands SET result='{"reason":"expired"}' WHERE id=$1`,[commands[2].id]);
  await db.query(`UPDATE gateway_telecom_snapshots SET reported_sequence=27 WHERE gateway_id=$1`,[gateway]);
  assert.ok(await expiredAckGateCount(evidence)>0,'a different live watermark must retain the deployment gate');
  await db.query(`UPDATE gateway_telecom_snapshots SET reported_sequence=26 WHERE gateway_id=$1`,[gateway]);
  await db.query(`INSERT INTO commands(gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,result)VALUES($1,$2,2,25,'dial','{}',now()-interval '1 minute','acked','{"phase":"submitted"}')`,[gateway,call]);
  assert.ok(await expiredAckGateCount(evidence)>0,'an earlier executed command for the call must retain the deployment gate');
  await assert.rejects(expiredAckGateSql({...evidence,commands:commands.map((item,index)=>index===1?{...item,deviceAck:null}:item)}));
  await assert.rejects(expiredAckGateSql({...evidence,commands:commands.map((item,index)=>index===0?{...item,sequence:true}:item)}));
});
