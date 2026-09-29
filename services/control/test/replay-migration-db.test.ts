import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createDb} from '../src/db.js';
import {coordinateReplayMigration,completeReplayMigration,type ReplayMigrationRequest} from '../src/replay-migration.js';
const db=process.env.REPLAY_MIGRATION_TEST_DATABASE_URL?createDb(process.env.REPLAY_MIGRATION_TEST_DATABASE_URL):undefined;
before(async()=>{if(db){await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await db.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));}});
after(async()=>db?.end());
async function fixture(){const gateway=(await db!.query("INSERT INTO gateways(name,command_sequence)VALUES('migration-test',41)RETURNING id,device_epoch")).rows[0];const user=(await db!.query("INSERT INTO users(email,password_hash)VALUES($1,'test')RETURNING id",[`${gateway.id}@test.invalid`])).rows[0].id;
 const sim=(await db!.query("INSERT INTO sims(gateway_id,slot_index,label,owner_user_id)VALUES($1,0,'test',$2)RETURNING id",[gateway.id,user])).rows[0].id;
 await db!.query('INSERT INTO sim_settings(sim_id)VALUES($1)',[sim]);await db!.query("INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,'test')",[gateway.id,`token-${gateway.id}`]);
 await db!.query("INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),41,false,'[]',now())",[gateway.id,gateway.device_epoch]);
 const input:ReplayMigrationRequest={intentId:randomUUID(),generation:Number(gateway.device_epoch),serverSequence:41,localProof:{idle:true,pendingAcks:0,pendingEvents:0,pendingCommands:0,unknownExecutions:0}};
 return{gatewayId:gateway.id,user,sim,input};}
async function run(gatewayId:string,input:ReplayMigrationRequest,mode:'preflight'|'commit',enabled=true,rollback=false){const c=await db!.connect();try{await c.query('BEGIN');const result=await coordinateReplayMigration(c,gatewayId,input,mode,enabled);await c.query(rollback?'ROLLBACK':'COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
test('preflight is read-only for epoch and commit receipt survives duplicate competing requests',{skip:!db},async()=>{const f=await fixture();assert.equal((await run(f.gatewayId,f.input,'preflight')).eligible,true);assert.equal(Number((await db!.query('SELECT device_epoch FROM gateways WHERE id=$1',[f.gatewayId])).rows[0].device_epoch),f.input.generation);
 const [a,b]=await Promise.all([run(f.gatewayId,f.input,'commit'),run(f.gatewayId,f.input,'commit')]);assert.deepEqual(a,b);assert.equal(a.receipt?.toGeneration,f.input.generation+1);
 assert.deepEqual(await run(f.gatewayId,f.input,'commit'),a);
 assert.deepEqual(await run(f.gatewayId,f.input,'preflight',false),a);
 assert.equal((await db!.query('SELECT secret_hash,revoked_at FROM device_credentials WHERE gateway_id=$1',[f.gatewayId])).rows[0].secret_hash,`token-${f.gatewayId}`);
 assert.equal((await db!.query('SELECT owner_user_id FROM sims WHERE id=$1',[f.sim])).rows[0].owner_user_id,f.user);assert.equal((await db!.query('SELECT mode FROM sim_settings WHERE sim_id=$1',[f.sim])).rows[0].mode,'normal');
 assert.equal(Number((await db!.query('SELECT command_sequence FROM gateways WHERE id=$1',[f.gatewayId])).rows[0].command_sequence),0);
});
test('server crash before transaction commit keeps old epoch and exact intent retries',{skip:!db},async()=>{const f=await fixture();await run(f.gatewayId,f.input,'preflight');const lost=await run(f.gatewayId,f.input,'commit',true,true);assert.equal(Number((await db!.query('SELECT device_epoch FROM gateways WHERE id=$1',[f.gatewayId])).rows[0].device_epoch),f.input.generation);assert.deepEqual(await run(f.gatewayId,f.input,'commit'),lost);});
test('sent SMS and missing fresh snapshot block transition without epoch mutation',{skip:!db},async()=>{const f=await fixture();await db!.query("INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state)VALUES($1,$2,$3,'outgoing','test','test','sent')",[f.gatewayId,f.sim,f.user]);await db!.query("UPDATE gateway_telecom_snapshots SET updated_at=now()-interval '2 minutes' WHERE gateway_id=$1",[f.gatewayId]);const result=await run(f.gatewayId,f.input,'preflight');assert.equal(result.eligible,false);assert.deepEqual(result.blockers.map(b=>b.code),['server_sms','fresh_idle_snapshot_required']);assert.equal((await run(f.gatewayId,f.input,'commit')).eligible,false);assert.equal(Number((await db!.query('SELECT device_epoch FROM gateways WHERE id=$1',[f.gatewayId])).rows[0].device_epoch),f.input.generation);});
test('missing intent, changed payload, changed allocator and disabled feature never rotate',{skip:!db},async()=>{const f=await fixture();assert.equal((await run(f.gatewayId,f.input,'commit')).blockers[0].code,'preflight_intent_required');assert.equal((await run(f.gatewayId,f.input,'preflight',false)).blockers[0].code,'migration_disabled');await run(f.gatewayId,f.input,'preflight');assert.equal((await run(f.gatewayId,{...f.input,serverSequence:42},'preflight')).blockers[0].code,'intent_payload_conflict');await db!.query('UPDATE gateways SET command_sequence=42 WHERE id=$1',[f.gatewayId]);assert.equal((await run(f.gatewayId,f.input,'commit')).blockers[0].code,'allocator_changed');});
test('committed receipt cannot repair a partially restored or superseded epoch silently',{skip:!db},async()=>{const f=await fixture();await run(f.gatewayId,f.input,'preflight');await run(f.gatewayId,f.input,'commit');await db!.query('UPDATE gateways SET device_epoch=$2 WHERE id=$1',[f.gatewayId,f.input.generation]);assert.equal((await run(f.gatewayId,f.input,'commit')).blockers[0].code,'committed_epoch_mismatch');});
test('disabled random intents do not allocate rows and prepared intents have a hard per-epoch cap',{skip:!db},async()=>{const f=await fixture();for(let i=0;i<10;i++)await run(f.gatewayId,{...f.input,intentId:randomUUID()},'preflight',false);assert.equal((await db!.query('SELECT count(*) FROM gateway_command_replay_migrations WHERE gateway_id=$1',[f.gatewayId])).rows[0].count,'0');for(let i=0;i<4;i++)assert.equal((await run(f.gatewayId,{...f.input,intentId:randomUUID()},'preflight')).eligible,true);assert.equal((await run(f.gatewayId,f.input,'preflight')).blockers[0].code,'intent_capacity_reached');});

test('confirmed migration cannot reenroll a stale old runtime or restore an empty progressed ledger',{skip:!db},async()=>{
 const f=await fixture();await run(f.gatewayId,f.input,'preflight');const receipt=(await run(f.gatewayId,f.input,'commit')).receipt!;
 const complete=async()=>{const c=await db!.connect();try{await c.query('BEGIN');const result=await completeReplayMigration(c,f.gatewayId,{intentId:receipt.intentId,generation:receipt.toGeneration,proofDigest:receipt.proofDigest});await c.query('COMMIT');return result;}finally{c.release();}};
 assert.equal((await complete()).completed,true);assert.equal((await complete()).completed,true);
 assert.equal((await run(f.gatewayId,f.input,'preflight')).blockers[0].code,'migration_already_completed');
 assert.equal((await run(f.gatewayId,f.input,'commit')).receipt,undefined);
 await db!.query('UPDATE gateways SET command_sequence=1 WHERE id=$1',[f.gatewayId]);
 assert.equal((await complete()).blockers[0].code,'completed_epoch_progressed');
});
