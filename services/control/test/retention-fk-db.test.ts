import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createDb} from '../src/db.js';
import {commandReplayFingerprint,loadReplayEvidence} from '../src/replay-horizon.js';
// S29 §2.1: deleting a call or an SMS is a supported operation. Every foreign key that used to make it
// a four-step manual dance is asserted here, together with the invariant that pays for it: the replay
// ledger (commands, receipts, horizons, audits) and the wire fingerprint never move.
const url=process.env.TEST_DATABASE_URL;
const db=url?createDb(url):undefined;
before(async()=>{if(db){await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await db.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));}});
after(async()=>{await db?.end();});
const one=async(sql:string,params:unknown[]=[])=>(await db!.query(sql,params)).rows[0];
const count=async(sql:string,params:unknown[]=[])=>Number((await db!.query(sql,params)).rowCount);

async function fixture(label:string){
 const user=(await one("INSERT INTO users(email,password_hash)VALUES($1,'test-only')RETURNING id",[`${label}@test.invalid`])).id;
 const session=(await one("INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,$2,'native','android',now()+interval '1 hour',now()+interval '1 day')RETURNING id",[user,`${label}-access`])).id;
 const gateway=await one("INSERT INTO gateways(name,command_sequence)VALUES($1,8)RETURNING id,device_epoch",[label]);
 const sim=(await one("INSERT INTO sims(gateway_id,slot_index,label)VALUES($1,0,$2)RETURNING id",[gateway.id,label])).id;
 return {user,session,gatewayId:gateway.id,generation:Number(gateway.device_epoch),simId:sim,label};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function evidence(f:Fixture){const c=await db!.connect();try{return await loadReplayEvidence(c,f.gatewayId,f.generation,1);}finally{c.release();}}
async function registration(f:Fixture,platform:'ios'|'android'){
 return (await one(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,fcm_token)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)RETURNING id`,
  [f.user,f.session,platform,platform==='ios'?'production':null,platform==='android'?'org.vodog':null,`${f.label} ${platform}`,
   platform==='android'?`fcm-${f.label}`:null])).id;
}
async function command(f:Fixture,input:{sequence:number;kind:string;callId?:string|null;smsId?:string|null;payload:Record<string,unknown>}){
 const row=await one(`INSERT INTO commands(gateway_id,generation,sequence,kind,call_id,sms_id,payload,expires_at,status,result)
   VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour','acked','{"phase":"submitted"}')RETURNING *`,
  [f.gatewayId,f.generation,input.sequence,input.kind,input.callId??null,input.smsId??null,JSON.stringify(input.payload)]);
 await db!.query('INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result)VALUES($1,$2,$3,$4)',
  [row.id,commandReplayFingerprint(row,f.gatewayId),'acked',JSON.stringify(row.result)]);
 return row;
}

test('S29 deleting a call keeps the replay ledger, nulls command identity, and cascades only push delivery',{skip:!db},async()=>{
 const f=await fixture('retention-call');
 const call=(await one("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,remote_number)VALUES($1,$2,$3,'incoming','ended',$4,'normal','+15556100')RETURNING id",[f.gatewayId,f.simId,f.user,f.generation])).id;
 const dial=await command(f,{sequence:1,kind:'dial',callId:call,payload:{callId:call,deviceCallId:null}});
 const fingerprint=commandReplayFingerprint(dial,f.gatewayId);
 await db!.query('INSERT INTO push_deliveries(call_id,registration_id,session_id)VALUES($1,$2,$3)',[call,await registration(f,'ios'),f.session]);
 await db!.query("INSERT INTO android_push_deliveries(call_id,registration_id,session_id,event)VALUES($1,$2,$3,'call.incoming')",[call,await registration(f,'android'),f.session]);
 const blocked=(await one("INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,source_call_id)VALUES($1,'15556100','+15556100',$2)RETURNING id",[f.user,call])).id;
 await db!.query("INSERT INTO gateway_command_replay_horizons(gateway_id,generation,proposed_floor,proposed_revision,proposed_digest,committed_floor,committed_revision,committed_digest)VALUES($1,$2,2,1,'digest-1',2,1,'digest-1')",[f.gatewayId,f.generation]);
 await db!.query("INSERT INTO gateway_command_replay_audits(gateway_id,generation,revision,from_inclusive,retire_before_sequence,proof_digest,proof,evidence)VALUES($1,$2,1,1,2,'digest-1','{}','[]')",[f.gatewayId,f.generation]);

 // The whole point of S29: one statement, no manual pre-deletes, and the receipt's RESTRICT holds.
 assert.equal(await count('DELETE FROM call_records WHERE id=$1',[call]),1);

 const survivor=await one('SELECT * FROM commands WHERE id=$1',[dial.id]);
 assert.equal(survivor.call_id,null);
 assert.equal(commandReplayFingerprint(survivor,f.gatewayId),fingerprint);
 assert.equal((await one('SELECT fingerprint FROM gateway_command_replay_receipts WHERE command_id=$1',[dial.id])).fingerprint,fingerprint);
 assert.equal(await count('SELECT 1 FROM push_deliveries WHERE call_id=$1',[call]),0);
 assert.equal(await count('SELECT 1 FROM android_push_deliveries WHERE call_id=$1',[call]),0);
 assert.deepEqual(await one('SELECT source_call_id FROM owner_blocked_numbers WHERE id=$1',[blocked]),{source_call_id:null});
 assert.deepEqual(await one('SELECT committed_floor,committed_revision,committed_digest,state FROM gateway_command_replay_horizons WHERE gateway_id=$1 AND generation=$2',[f.gatewayId,f.generation]),
  {committed_floor:'2',committed_revision:'1',committed_digest:'digest-1',state:'ready'});
 assert.equal(await count('SELECT 1 FROM gateway_command_replay_audits WHERE gateway_id=$1 AND generation=$2',[f.gatewayId,f.generation]),1);
 // S29 §2.2 is the other half of the deal: the purged command still binds its ACK and retires behind a
 // fresh idle Telecom snapshot, instead of reading `missing` and blocking the floor forever.
 assert.deepEqual((await evidence(f)).map(r=>[r.businessTerminal,r.safe]),[['purged',false]]);
 await db!.query("INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,gen_random_uuid(),1,false,'[]',now())",[f.gatewayId,f.generation]);
 assert.deepEqual((await evidence(f)).map(r=>[r.ackDisposition,r.businessTerminal,r.safe]),[['accepted','purged',true]]);
});

test('S29 deleting an SMS nulls sms_id without moving the wire fingerprint',{skip:!db},async()=>{
 const f=await fixture('retention-sms');
 const sms=(await one("INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)VALUES($1,$2,$3,'outgoing','+15556101','测试 body','delivered',$4)RETURNING id",[f.gatewayId,f.simId,f.user,f.generation])).id;
 // The payload carries the same `smsId` the fingerprint folds in, which is what makes the null safe.
 const send=await command(f,{sequence:1,kind:'send_sms',smsId:sms,payload:{smsId:sms,simId:f.simId,remoteNumber:'+15556101',body:'测试 body'}});
 const fingerprint=commandReplayFingerprint(send,f.gatewayId);

 assert.equal(await count('DELETE FROM sms_messages WHERE id=$1',[sms]),1);

 const survivor=await one('SELECT * FROM commands WHERE id=$1',[send.id]);
 assert.equal(survivor.sms_id,null);
 assert.equal(commandReplayFingerprint(survivor,f.gatewayId),fingerprint);
 assert.equal((await one('SELECT fingerprint,status FROM gateway_command_replay_receipts WHERE command_id=$1',[send.id])).fingerprint,fingerprint);
 // The receipt was written while `sms_id` was still set, so this proves the ACK still binds afterwards.
 assert.deepEqual((await evidence(f)).map(r=>[r.ackDisposition,r.businessTerminal,r.safe]),[['accepted','purged',true]]);
});

test('S29 the replay receipt still refuses to let a command be deleted out from under it',{skip:!db},async()=>{
 const f=await fixture('retention-restrict');
 const call=(await one("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot)VALUES($1,$2,$3,'outgoing','ended',$4,'normal')RETURNING id",[f.gatewayId,f.simId,f.user,f.generation])).id;
 const dial=await command(f,{sequence:1,kind:'dial',callId:call,payload:{callId:call}});
 await assert.rejects(db!.query('DELETE FROM commands WHERE id=$1',[dial.id]),/violates foreign key constraint/);
 assert.equal(await count('SELECT 1 FROM commands WHERE id=$1',[dial.id]),1);
});
