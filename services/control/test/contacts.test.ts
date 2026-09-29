import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
import {normalizeContactName} from '../src/contacts/repository.js';
import {phoneCandidateKeys} from '../src/phone-address.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'contacts-test-cookie-secret-at-least-32-chars',
  GATEWAY_ONLINE_SECONDS:30,PORT:3399,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',
  MEDIA_SECRET:'contacts-test-media-secret-at-least-32-chars',TURN_SECRET:'contacts-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};

let db:Db,app:FastifyInstance,ownerId:string,strangerId:string,gatewayId:string,simId:string,token:string,strangerToken:string;
const auth=(value:string)=>({authorization:`Bearer ${value}`});
const password='correct horse battery staple';

before(async()=>{
  db=createDb(databaseUrl!);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  const hash=await hashPassword(password);
  ownerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('contacts-owner@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  strangerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('contacts-stranger@example.test',$1)RETURNING id`,[hash])).rows[0].id;
  gatewayId=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('contacts-gateway',true,true,true,true,now())RETURNING id`)).rows[0].id;
  simId=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,'SIM',true,$3,'CN')RETURNING id`,
    [gatewayId,ownerId,tokenHash('contacts-sim-fingerprint')])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[simId]);
  app=await buildApp(db,config);
  const login=async(email:string)=>{
    const response=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
    assert.equal(response.statusCode,200,response.body);
    return response.json().token as string;
  };
  token=await login('contacts-owner@example.test');
  strangerToken=await login('contacts-stranger@example.test');
});
after(async()=>{await app.close();await db.end();});

const create=(payload:unknown,as=token)=>app.inject({method:'POST',url:'/api/v1/contacts',headers:auth(as),payload});

test('name normalization is trim, whitespace collapse and casefold',()=>{
  assert.equal(normalizeContactName('  Zhang   San  '),'zhang san');
  assert.equal(normalizeContactName('ZHANG\tSAN'),'zhang san');
  assert.equal(normalizeContactName(null),'');
});

test('lookup keys stay symmetric with the blocklist matcher and never key emergency numbers',()=>{
  // A national blocklist key must still match an E.164 incoming number and vice versa.
  assert.ok(phoneCandidateKeys('+8618600000001','CN').includes('18600000001'));
  assert.ok(phoneCandidateKeys('18600000001','CN').includes('8618600000001'));
  assert.ok(phoneCandidateKeys('18600000001','CN').includes('+8618600000001'));
  assert.deepEqual(phoneCandidateKeys('112','CN'),[]);
  assert.deepEqual(phoneCandidateKeys('911'),[]);
  assert.deepEqual(phoneCandidateKeys('not-a-number','CN'),[]);
});

test('contacts are owner isolated, need a phone or email, and expose the frozen DTO shape',async()=>{
  const anonymous=await app.inject({method:'GET',url:'/api/v1/contacts'});
  assert.equal(anonymous.statusCode,401);
  const empty=await app.inject({method:'GET',url:'/api/v1/contacts',headers:auth(token)});
  assert.deepEqual(empty.json(),{items:[]});
  const naked=await create({displayName:'No Channels'});
  assert.equal(naked.statusCode,400,naked.body);
  assert.equal(naked.json().error.code,'INVALID_REQUEST');
  const created=await create({displayName:'张三',givenName:'三',familyName:'张',organization:'Clima',notes:'vip',
    phones:[{rawNumber:'186 0000 0001',label:'mobile'}],emails:[{address:'a@b.c',label:'home'}],
    addresses:[{formatted:'Somewhere 1',label:'home',city:'Shenzhen'}]});
  assert.equal(created.statusCode,201,created.body);
  const item=created.json().item;
  assert.deepEqual(Object.keys(item).sort(),['addresses','blocked','blockedEntryId','createdAt','displayName','emails','familyName','givenName','id','notes','organization','phones','source','sourceContactId','sourceDeviceId','updatedAt','version'].sort());
  assert.equal(item.version,1);
  assert.equal(item.source,'manual');
  assert.equal(item.blocked,false);
  assert.equal(item.blockedEntryId,null);
  assert.deepEqual(Object.keys(item.phones[0]).sort(),['blocked','blockedEntryId','canonicalKey','e164','id','isPrimary','label','rawNumber'].sort());
  assert.deepEqual(item.phones.map((phone:any)=>[phone.rawNumber,phone.canonicalKey,phone.e164,phone.isPrimary,phone.blocked,phone.blockedEntryId]),[['186 0000 0001','+8618600000001','+8618600000001',true,false,null]]);
  assert.equal(item.emails[0].address,'a@b.c');
  assert.equal(item.addresses[0].city,'Shenzhen');
  const foreign=await app.inject({method:'GET',url:`/api/v1/contacts/${item.id}`,headers:auth(strangerToken)});
  assert.equal(foreign.statusCode,404);
  const strangerList=await app.inject({method:'GET',url:'/api/v1/contacts',headers:auth(strangerToken)});
  assert.deepEqual(strangerList.json(),{items:[]});
});

test('create is idempotent per key, replace swaps all three child arrays, and delete is soft',async()=>{
  const key='contacts-idempotency-key-0001';
  const first=await app.inject({method:'POST',url:'/api/v1/contacts',headers:{...auth(token),'idempotency-key':key},payload:{displayName:'Idem One',phones:[{rawNumber:'13800001234'}]}});
  assert.equal(first.statusCode,201,first.body);
  const replay=await app.inject({method:'POST',url:'/api/v1/contacts',headers:{...auth(token),'idempotency-key':key},payload:{displayName:'Idem One',phones:[{rawNumber:'13800001234'}]}});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().item.id,first.json().item.id);
  const conflict=await app.inject({method:'POST',url:'/api/v1/contacts',headers:{...auth(token),'idempotency-key':key},payload:{displayName:'Idem Two',phones:[{rawNumber:'13800001234'}]}});
  assert.equal(conflict.statusCode,409,conflict.body);
  assert.equal(conflict.json().error.code,'IDEMPOTENCY_CONFLICT');
  // The header is optional here, unlike the call and SMS mutations.
  const noHeader=await create({displayName:'No Header',phones:[{rawNumber:'13800138001'}]});
  assert.equal(noHeader.statusCode,201,noHeader.body);
  const malformed=await app.inject({method:'POST',url:'/api/v1/contacts',headers:{...auth(token),'idempotency-key':'short'},payload:{displayName:'Bad',phones:[{rawNumber:'13800138002'}]}});
  assert.equal(malformed.statusCode,400,malformed.body);

  const id=first.json().item.id;
  const replaced=await app.inject({method:'PUT',url:`/api/v1/contacts/${id}`,headers:auth(token),
    payload:{displayName:'Idem Renamed',phones:[{rawNumber:'13900139000'}],emails:[{address:'x@y.z'}],expectedVersion:first.json().item.version}});
  assert.equal(replaced.statusCode,200,replaced.body);
  assert.equal(replaced.json().item.version,2);
  assert.equal(replaced.json().item.displayName,'Idem Renamed');
  assert.deepEqual(replaced.json().item.phones.map((phone:any)=>phone.rawNumber),['13900139000']);
  assert.equal(replaced.json().item.emails.length,1);

  const added=await app.inject({method:'POST',url:`/api/v1/contacts/${id}/phones`,headers:auth(token),payload:{rawNumber:'13700137000',label:'work'}});
  assert.equal(added.statusCode,200,added.body);
  assert.equal(added.json().item.phones.length,2);
  const again=await app.inject({method:'POST',url:`/api/v1/contacts/${id}/phones`,headers:auth(token),payload:{rawNumber:'+8613700137000'}});
  assert.equal(again.statusCode,200,again.body);
  assert.equal(again.json().item.phones.length,2,'the same number in another spelling is not a second row');

  const removed=await app.inject({method:'DELETE',url:`/api/v1/contacts/${id}?expectedVersion=${again.json().item.version}`,headers:auth(token)});
  assert.equal(removed.statusCode,204,removed.body);
  assert.equal((await db.query(`SELECT deleted_at FROM contacts WHERE id=$1`,[id])).rows[0].deleted_at!==null,true);
  const gone=await app.inject({method:'GET',url:`/api/v1/contacts/${id}`,headers:auth(token)});
  assert.equal(gone.statusCode,404);
  const missing=await app.inject({method:'DELETE',url:`/api/v1/contacts/${id}?expectedVersion=${again.json().item.version}`,headers:auth(token)});
  assert.equal(missing.statusCode,404);
});

test('contact replacement and deletion require owner-scoped CAS and concurrent writers cannot overwrite',async()=>{
  const created=await create({displayName:'CAS Original',phones:[{rawNumber:'13800138888'}]});
  const item=created.json().item;
  const missing=await app.inject({method:'PUT',url:`/api/v1/contacts/${item.id}`,headers:auth(token),
    payload:{displayName:'No version',phones:[{rawNumber:'13800138888'}]}});
  assert.equal(missing.statusCode,428,missing.body);
  assert.equal(missing.json().error.code,'CONTACT_VERSION_REQUIRED');
  const payload=(displayName:string)=>({displayName,phones:[{rawNumber:'13800138888'}],expectedVersion:item.version});
  const contenders=await Promise.all([
    app.inject({method:'PUT',url:`/api/v1/contacts/${item.id}`,headers:auth(token),payload:payload('CAS Winner A')}),
    app.inject({method:'PUT',url:`/api/v1/contacts/${item.id}`,headers:auth(token),payload:payload('CAS Winner B')}),
  ]);
  assert.deepEqual(contenders.map(response=>response.statusCode).sort(),[200,409]);
  const winner=contenders.find(response=>response.statusCode===200)!;
  const conflict=contenders.find(response=>response.statusCode===409)!;
  assert.equal(winner.json().item.version,2);
  assert.equal(conflict.json().error.code,'CONTACT_VERSION_CONFLICT');
  assert.equal(conflict.json().error.details.currentVersion,2);
  const stored=(await db.query(`SELECT display_name,version FROM contacts WHERE id=$1`,[item.id])).rows[0];
  assert.equal(Number(stored.version),2);
  assert.equal(stored.display_name,winner.json().item.displayName);
  const missingDelete=await app.inject({method:'DELETE',url:`/api/v1/contacts/${item.id}`,headers:auth(token)});
  assert.equal(missingDelete.statusCode,428,missingDelete.body);
  const staleDelete=await app.inject({method:'DELETE',url:`/api/v1/contacts/${item.id}?expectedVersion=1`,headers:auth(token)});
  assert.equal(staleDelete.statusCode,409,staleDelete.body);
  assert.equal(staleDelete.json().error.details.currentVersion,2);
  const foreign=await app.inject({method:'DELETE',url:`/api/v1/contacts/${item.id}?expectedVersion=2`,headers:auth(strangerToken)});
  assert.equal(foreign.statusCode,404,foreign.body);
  const removed=await app.inject({method:'DELETE',url:`/api/v1/contacts/${item.id}?expectedVersion=2`,headers:auth(token)});
  assert.equal(removed.statusCode,204,removed.body);
});

test('search matches normalized name and number substrings and lookup resolves any spelling',async()=>{
  await create({displayName:'Search Target',phones:[{rawNumber:'15012345678'}]});
  const byName=await app.inject({method:'GET',url:'/api/v1/contacts?query=search%20target',headers:auth(token)});
  assert.equal(byName.json().items.length,1);
  const byNumber=await app.inject({method:'GET',url:'/api/v1/contacts?query=1501234',headers:auth(token)});
  assert.equal(byNumber.json().items.length,1);
  const none=await app.inject({method:'GET',url:'/api/v1/contacts?query=nobody-here',headers:auth(token)});
  assert.deepEqual(none.json(),{items:[]});
  const lookup=await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=%2B8615012345678',headers:auth(token)});
  assert.equal(lookup.statusCode,200,lookup.body);
  assert.equal(lookup.json().item.displayName,'Search Target');
  const miss=await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=15599999999',headers:auth(token)});
  assert.equal(miss.json().item,null);
  const strangerLookup=await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=15012345678',headers:auth(strangerToken)});
  assert.equal(strangerLookup.json().item,null);
});

test('import updates by source identity, merges by name plus shared number, and stays idempotent',async()=>{
  const payload={source:'ios' as const,sourceDeviceId:'iphone-1',contacts:[
    {sourceContactId:'c1',displayName:'李四',phones:[{rawNumber:'13011110000'}]},
    // Same person twice in one request: collapsed on canonical key + normalized name.
    {sourceContactId:'c1',displayName:'李四',phones:[{rawNumber:'+8613011110000'}]},
    {displayName:'王五',phones:[{rawNumber:'13022220000'}],emails:[{address:'wang@example.test'}]},
  ]};
  const first=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),payload});
  assert.equal(first.statusCode,200,first.body);
  assert.deepEqual(first.json(),{total:3,created:2,updated:0,merged:0,skipped:1,phonesSkipped:0});

  // A second identical submission creates nothing: the source hit updates, the rest merge.
  const second=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),payload});
  assert.equal(second.statusCode,200,second.body);
  assert.deepEqual(second.json(),{total:3,created:0,updated:1,merged:1,skipped:1,phonesSkipped:0});
  assert.equal((await db.query(`SELECT count(*)::int n FROM contacts WHERE owner_user_id=$1 AND normalized_name='李四' AND deleted_at IS NULL`,[ownerId])).rows[0].n,1);

  // Emergency numbers and undialable strings count as skipped phones; an entry left with no usable
  // channel at all is skipped whole.
  const noisy=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),payload:{source:'web_csv' as const,contacts:[
    {displayName:'Emergency',phones:[{rawNumber:'112'}],emails:[{address:'e@example.test'}]},
    {displayName:'Nothing Usable',phones:[{rawNumber:'not a number'}]},
    {displayName:'   ',phones:[{rawNumber:'13044440000'}]},
  ]}});
  assert.deepEqual(noisy.json(),{total:3,created:1,updated:0,merged:0,skipped:2,phonesSkipped:2});

  // Same name, no shared number: still a new contact (same name / different person).
  const namesake=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),
    payload:{source:'web_csv' as const,contacts:[{displayName:'王五',phones:[{rawNumber:'13099990000'}]}]}});
  assert.deepEqual(namesake.json(),{total:1,created:1,updated:0,merged:0,skipped:0,phonesSkipped:0});
  assert.equal((await db.query(`SELECT count(*)::int n FROM contacts WHERE owner_user_id=$1 AND normalized_name='王五' AND deleted_at IS NULL`,[ownerId])).rows[0].n,2);

  // Merge tops missing channels up instead of replacing them.
  const merged=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),
    payload:{source:'web_vcard' as const,contacts:[{displayName:'王五',phones:[{rawNumber:'13022220000'},{rawNumber:'13033330000'}]}]}});
  assert.deepEqual(merged.json(),{total:1,created:0,updated:0,merged:1,skipped:0,phonesSkipped:0});
  const wang=(await db.query(`SELECT c.id FROM contacts c JOIN contact_phones p ON p.contact_id=c.id
    WHERE c.owner_user_id=$1 AND p.canonical_key='+8613022220000' AND c.deleted_at IS NULL`,[ownerId])).rows[0];
  assert.equal((await db.query(`SELECT count(*)::int n FROM contact_phones WHERE contact_id=$1`,[wang.id])).rows[0].n,2);
  assert.equal((await db.query(`SELECT count(*)::int n FROM contact_emails WHERE contact_id=$1`,[wang.id])).rows[0].n,1,'the merge kept the existing email');

  const strangerSees=await app.inject({method:'GET',url:'/api/v1/contacts',headers:auth(strangerToken)});
  assert.deepEqual(strangerSees.json(),{items:[]});
});

test('import refuses more than 2000 entries and accepts a body larger than the default 1 MB limit',async()=>{
  const tooMany={source:'android' as const,contacts:Array.from({length:2001},(_value,index)=>({displayName:`Bulk ${index}`,phones:[{rawNumber:`1300000${String(index).padStart(4,'0')}`}]}))};
  const rejected=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),payload:tooMany});
  assert.equal(rejected.statusCode,400,rejected.body);
  assert.equal(rejected.json().error.code,'INVALID_REQUEST');
  // Fastify's default bodyLimit is 1 MB; the frozen contract allows 4 MB on this route only.
  const bulky={source:'android' as const,contacts:Array.from({length:700},(_value,index)=>({
    displayName:`Bulky ${index}`,notes:'x'.repeat(1900),phones:[{rawNumber:`1311111${String(index).padStart(4,'0')}`}]}))};
  assert.ok(Buffer.byteLength(JSON.stringify(bulky))>1024*1024,'fixture must exceed the default limit');
  const accepted=await app.inject({method:'POST',url:'/api/v1/contacts/import',headers:auth(token),payload:bulky});
  assert.equal(accepted.statusCode,200,accepted.body.slice(0,200));
  assert.equal(accepted.json().created,700);
});

test('call and SMS pages carry contact and block annotation without loading the address book',async()=>{
  await create({displayName:'Annotated Caller',phones:[{rawNumber:'+8613500135000'}]});
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,ended_at)
    VALUES($1,$2,$3,'incoming','13500135000','ended',1,'normal',now())RETURNING id`,[gatewayId,simId,ownerId])).rows[0];
  await db.query(`INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)
    VALUES($1,$2,$3,'incoming','13500135000','hello','delivered',1)`,[gatewayId,simId,ownerId]);
  const calls=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  const annotated=calls.json().items.find((row:any)=>row.id===call.id);
  assert.equal(annotated.contactName,'Annotated Caller');
  assert.equal(annotated.blocked,false);
  assert.equal(annotated.blockedEntryId,null);
  const detail=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token)});
  assert.equal(detail.json().call.contactName,'Annotated Caller');
  const sms=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)});
  assert.equal(sms.json().items[0].contactName,'Annotated Caller');
  assert.equal(sms.json().items[0].contactId,annotated.contactId);

  // Blocking the E.164 spelling must still annotate a national-format call row.
  const blocked=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'+8613500135000'}});
  assert.equal(blocked.statusCode,201,blocked.body);
  // The row stays in the default history and simply carries the flag (S21 §F).
  const withBlocked=await app.inject({method:'GET',url:'/api/v1/calls',headers:auth(token)});
  const blockedRow=withBlocked.json().items.find((row:any)=>row.id===call.id);
  assert.ok(blockedRow,'blocking a number does not hide its history');
  assert.equal(blockedRow.blocked,true);
  assert.equal(blockedRow.blockedEntryId,blocked.json().item.id);
  const blockedDetail=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token)});
  assert.equal(blockedDetail.statusCode,200,blockedDetail.body);
  assert.equal(blockedDetail.json().call.blockedEntryId,blocked.json().item.id);
  // S66: a call-list entry never marks an SMS row; only the SMS list does, with its own entry id.
  const callOnlySms=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)});
  assert.equal(callOnlySms.json().items[0].blocked,false);
  const smsBlocked=await app.inject({method:'POST',url:'/api/v1/blocklist',headers:auth(token),payload:{remoteNumber:'+8613500135000',scope:'sms'}});
  assert.equal(smsBlocked.statusCode,201,smsBlocked.body);
  assert.notEqual(smsBlocked.json().item.id,blocked.json().item.id);
  const blockedSms=await app.inject({method:'GET',url:'/api/v1/sms',headers:auth(token)});
  assert.equal(blockedSms.json().items[0].blocked,true);
  assert.equal(blockedSms.json().items[0].blockedEntryId,smsBlocked.json().item.id);
  const callStillCallEntry=await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth(token)});
  assert.equal(callStillCallEntry.json().call.blockedEntryId,blocked.json().item.id);
  const list=await app.inject({method:'GET',url:'/api/v1/blocklist',headers:auth(token)});
  const entry=list.json().items.find((row:any)=>row.id===blocked.json().item.id);
  assert.equal(entry.contactName,'Annotated Caller');
  assert.equal(entry.blocked,true);
  const card=await app.inject({method:'GET',url:'/api/v1/contacts?query=Annotated',headers:auth(token)});
  const cardItem=card.json().items[0];
  assert.equal(cardItem.blocked,true,'the contact card shows the block state too');
  assert.equal(cardItem.blockedEntryId,blocked.json().item.id,'and carries the entry id for the unblock action');
  assert.deepEqual(cardItem.phones.map((phone:any)=>[phone.blocked,phone.blockedEntryId]),[[true,blocked.json().item.id]]);

  // A second, unblocked number on the same contact stays unblocked at the phone level.
  const added=await app.inject({method:'POST',url:`/api/v1/contacts/${cardItem.id}/phones`,headers:auth(token),payload:{rawNumber:'13600136000'}});
  assert.equal(added.statusCode,200,added.body);
  const perPhone=added.json().item.phones;
  assert.deepEqual(perPhone.map((phone:any)=>phone.blocked),[true,false]);
  assert.equal(added.json().item.blockedEntryId,blocked.json().item.id);

  await app.inject({method:'DELETE',url:`/api/v1/blocklist/${blocked.json().item.id}`,headers:auth(token)});
  const cleared=await app.inject({method:'GET',url:'/api/v1/contacts?query=Annotated',headers:auth(token)});
  assert.equal(cleared.json().items[0].blocked,false);
  assert.equal(cleared.json().items[0].blockedEntryId,null);
});
