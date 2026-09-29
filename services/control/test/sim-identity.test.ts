import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { tokenHash } from '../src/security.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedDatabaseUrl.hostname) || !parsedDatabaseUrl.pathname.includes('test')) {
  throw new Error('SIM identity tests refuse any non-local or non-test database');
}

const config = {
  DATABASE_URL: databaseUrl,
  PUBLIC_ORIGIN: 'https://vodog.test',
  RP_ID: 'vodog.test',
  COOKIE_SECRET: 'test-only-cookie-secret-at-least-32-characters',
  GATEWAY_ONLINE_SECONDS: 30,
  PORT: 3199,
  AI_ENABLED: false,
  AI_WORKER_READY: false,
  MEDIA_DEFAULT_NODE_ID: 'relay-primary',
  MEDIA_SECRET: 'test-media-secret-at-least-32-characters',
  TURN_SECRET: 'test-turn-secret-at-least-32-characters',
  TRANSCRIPTION_ENABLED: false,
  TRANSCRIPTION_SCAN_INTERVAL_SECONDS: 5,
  TRANSCRIPTION_SCAN_BATCH: 2,
};

const FINGERPRINT_A = 'stable-profile-a-fingerprint-value';
const FINGERPRINT_B = 'stable-profile-b-fingerprint-value';
const FINGERPRINT_C = 'new-profile-c-fingerprint-value';

let db: Db;
let app: FastifyInstance;
let gatewayId: string;
let ownerA: string;
let ownerB: string;
let simA: string;
let simB: string;
let deviceToken: string;
const ownerAccessToken = 'sim-owner-access-token-with-sufficient-entropy';
const adminAccessToken = 'sim-admin-access-token-with-sufficient-entropy';

const auth = () => ({ authorization: `Bearer ${deviceToken}` });
const reported = (slotIndex: number, subscriptionId: number, fingerprint: string, embedded = false) => ({
  slotIndex,
  subscriptionId,
  phoneAccountHandle: `protected-account-${subscriptionId}`,
  iccidFingerprint: fingerprint,
  countryIso: 'cn',
  embedded,
});

before(async () => {
  db = createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql', import.meta.url)), 'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql', import.meta.url)), 'utf8'));
  ownerA = (await db.query(`INSERT INTO users(email,password_hash) VALUES('sim-owner-a@example.test','unused-test-hash') RETURNING id`)).rows[0].id;
  ownerB = (await db.query(`INSERT INTO users(email,password_hash) VALUES('sim-owner-b@example.test','unused-test-hash') RETURNING id`)).rows[0].id;
  const adminId = (await db.query(`INSERT INTO users(email,password_hash,role) VALUES('sim-admin@example.test','unused-test-hash','admin') RETURNING id`)).rows[0].id;
  await db.query(
    `INSERT INTO sessions(user_id,access_hash,client_type,access_expires_at,platform)
     VALUES($1,$2,'native',now()+interval '1 hour','android'),($3,$4,'native',now()+interval '1 hour','android')`,
    [ownerA, tokenHash(ownerAccessToken), adminId, tokenHash(adminAccessToken)],
  );
  gatewayId = (await db.query(`INSERT INTO gateways(name,control_enabled) VALUES('sim-identity-test',false) RETURNING id`)).rows[0].id;
  simA = (await db.query(
    `INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,protected_iccid_hash,subscription_id,phone_account_handle,device_present)
     VALUES($1,0,$2,'Profile A',$3,10,'protected-account-10',true) RETURNING id`,
    [gatewayId, ownerA, tokenHash(FINGERPRINT_A)],
  )).rows[0].id;
  simB = (await db.query(
    `INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,protected_iccid_hash,subscription_id,phone_account_handle,device_present)
     VALUES($1,1,$2,'Profile B',$3,20,'protected-account-20',true) RETURNING id`,
    [gatewayId, ownerB, tokenHash(FINGERPRINT_B)],
  )).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id) VALUES($1),($2)`, [simA, simB]);
  deviceToken = `sim-identity-device-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label) VALUES($1,$2,'test')`, [gatewayId, tokenHash(deviceToken)]);
  app = await buildApp(db, config);
});

after(async () => {
  if (app) await app.close();
  await db.end();
});

test('stable identities exchange slots without changing SIM IDs or owners', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(1, 11, FINGERPRINT_A), reported(0, 21, FINGERPRINT_B)] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const byFingerprint = new Map(response.json().items.map((item: any) => [item.iccidFingerprint, item]));
  assert.equal((byFingerprint.get(FINGERPRINT_A) as any).id, simA);
  assert.equal((byFingerprint.get(FINGERPRINT_B) as any).id, simB);
  const rows = await db.query(`SELECT id,slot_index,owner_user_id,device_present FROM sims WHERE gateway_id=$1 ORDER BY id`, [gatewayId]);
  const a = rows.rows.find((row) => row.id === simA);
  const b = rows.rows.find((row) => row.id === simB);
  assert.deepEqual({ slot: a.slot_index, owner: a.owner_user_id, present: a.device_present }, { slot: 1, owner: ownerA, present: true });
  assert.deepEqual({ slot: b.slot_index, owner: b.owner_user_id, present: b.device_present }, { slot: 0, owner: ownerB, present: true });
});

test('inactive profile reactivates in another slot with the same identity and owner', async () => {
  const omit = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 21, FINGERPRINT_B)] },
  });
  assert.equal(omit.statusCode, 200, omit.body);
  const inactive = (await db.query(`SELECT slot_index,owner_user_id,device_present FROM sims WHERE id=$1`, [simA])).rows[0];
  assert.deepEqual(inactive, { slot_index: null, owner_user_id: ownerA, device_present: false });
  const epoch = Number((await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`, [gatewayId])).rows[0].device_epoch);
  const staleCommand = (await db.query(
    `INSERT INTO commands(gateway_id,sim_id,generation,sequence,kind,payload,expires_at)
     VALUES($1,$2,$3,90,'apply_sim_settings','{}',now()+interval '1 hour') RETURNING id`,
    [gatewayId, simA, epoch],
  )).rows[0].id;

  const restore = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 12, FINGERPRINT_A), reported(1, 22, FINGERPRINT_B)] },
  });
  assert.equal(restore.statusCode, 200, restore.body);
  const restored = restore.json().items.find((item: any) => item.iccidFingerprint === FINGERPRINT_A);
  assert.equal(restored.id, simA);
  assert.equal((await db.query(`SELECT owner_user_id FROM sims WHERE id=$1`, [simA])).rows[0].owner_user_id, ownerA);
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`, [staleCommand])).rows[0].status, 'rejected');
});

test('new profile in a reused slot cannot inherit the previous owner', async () => {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 30, FINGERPRINT_C, true), reported(1, 22, FINGERPRINT_B)] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const created = response.json().items.find((item: any) => item.iccidFingerprint === FINGERPRINT_C);
  assert.notEqual(created.id, simA);
  assert.equal(created.needsOwnerAssignment, true);
  assert.equal(created.countryIso, 'CN');
  assert.equal(created.embedded, true);
  const rows = await db.query(`SELECT id,slot_index,owner_user_id,device_present FROM sims WHERE id=ANY($1::uuid[])`, [[simA, created.id]]);
  const old = rows.rows.find((row) => row.id === simA);
  const next = rows.rows.find((row) => row.id === created.id);
  assert.deepEqual({ slot: old.slot_index, owner: old.owner_user_id, present: old.device_present }, { slot: null, owner: ownerA, present: false });
  assert.deepEqual({ slot: next.slot_index, owner: next.owner_user_id, present: next.device_present }, { slot: 0, owner: null, present: true });

  const ownerDto = await app.inject({ method: 'GET', url: '/api/v1/sims', headers: { authorization: `Bearer ${ownerAccessToken}` } });
  assert.equal(ownerDto.statusCode, 200, ownerDto.body);
  const historical = ownerDto.json().items.find((item: any) => item.id === simA);
  assert.equal(historical.slotIndex, null);
  assert.equal(historical.countryIso, 'CN');
  assert.equal(historical.embedded, false);
  const adminDto = await app.inject({ method: 'GET', url: '/api/v1/admin/sims', headers: { authorization: `Bearer ${adminAccessToken}` } });
  assert.equal(adminDto.statusCode, 200, adminDto.body);
  const adminCreated = adminDto.json().items.find((item: any) => item.id === created.id);
  assert.equal(adminCreated.countryIso, 'CN');
  assert.equal(adminCreated.embedded, true);
});

test('one missing or duplicate fingerprint rejects the whole snapshot without changing routes', async () => {
  const before = await db.query(`SELECT id,slot_index,device_present,version FROM sims WHERE gateway_id=$1 ORDER BY id`, [gatewayId]);
  const missing = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 30, FINGERPRINT_C), { slotIndex: 1, subscriptionId: 40, phoneAccountHandle: null }] },
  });
  assert.equal(missing.statusCode, 400, missing.body);
  const duplicate = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 30, FINGERPRINT_C), reported(1, 31, FINGERPRINT_C)] },
  });
  assert.equal(duplicate.statusCode, 400, duplicate.body);
  const after = await db.query(`SELECT id,slot_index,device_present,version FROM sims WHERE gateway_id=$1 ORDER BY id`, [gatewayId]);
  assert.deepEqual(after.rows, before.rows);
});

test('route change rejects route-dependent work but retains active call lock and pending hangup', async () => {
  const epoch = Number((await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`, [gatewayId])).rows[0].device_epoch);
  const originatingSessionId = (await db.query(
    `SELECT id FROM sessions WHERE access_hash=$1`,
    [tokenHash(ownerAccessToken)],
  )).rows[0].id;
  const callId = (await db.query(
    `INSERT INTO call_records(
       gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,
       originating_session_id,originating_platform,answered_at
     ) VALUES($1,$2,$3,'outgoing','active',$4,'normal',$5,'android',now()) RETURNING id`,
    [gatewayId, simB, ownerB, epoch, originatingSessionId],
  )).rows[0].id;
  await db.query(`INSERT INTO gateway_call_locks(gateway_id,call_id,generation) VALUES($1,$2,$3)`, [gatewayId, callId, epoch]);
  const commandId = (await db.query(
    `INSERT INTO commands(gateway_id,call_id,sim_id,generation,sequence,kind,payload,expires_at)
     VALUES($1,$2,$3,$4,1,'answer','{}',now()+interval '1 hour') RETURNING id`,
    [gatewayId, callId, simB, epoch],
  )).rows[0].id;
  const hangupId = (await db.query(
    `INSERT INTO commands(gateway_id,call_id,sim_id,generation,sequence,kind,payload,expires_at)
     VALUES($1,$2,$3,$4,2,'hangup','{}',now()+interval '1 hour') RETURNING id`,
    [gatewayId, callId, simB, epoch],
  )).rows[0].id;

  const response = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 30, FINGERPRINT_C), reported(2, 23, FINGERPRINT_B)] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const command = (await db.query(`SELECT status,result FROM commands WHERE id=$1`, [commandId])).rows[0];
  assert.deepEqual(command, { status: 'rejected', result: { reason: 'sim_route_changed' } });
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`, [hangupId])).rows[0].status, 'pending');
  assert.deepEqual(
    (await db.query(`SELECT state,failure_reason FROM call_records WHERE id=$1`, [callId])).rows[0],
    { state: 'active', failure_reason: null },
  );
  assert.equal((await db.query(`SELECT count(*)::int count FROM gateway_call_locks WHERE call_id=$1`, [callId])).rows[0].count, 1);
});

test('schema migration makes an active legacy row without a fingerprint unroutable exactly once', async () => {
  const legacyId = (await db.query(
    `INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,subscription_id,phone_account_handle,device_present)
     VALUES($1,3,$2,'Legacy unverified',303,'legacy-account',true) RETURNING id,version`,
    [gatewayId, ownerA],
  )).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id) VALUES($1)`, [legacyId.id]);
  const schema = await readFile(fileURLToPath(new URL('../src/schema.sql', import.meta.url)), 'utf8');
  await db.query(schema);
  const migrated = (await db.query(
    `SELECT slot_index,subscription_id,phone_account_handle,device_present,owner_user_id,version FROM sims WHERE id=$1`,
    [legacyId.id],
  )).rows[0];
  assert.deepEqual(migrated, {
    slot_index: null,
    subscription_id: null,
    phone_account_handle: null,
    device_present: false,
    owner_user_id: ownerA,
    version: String(Number(legacyId.version) + 1),
  });
  await db.query(schema);
  assert.equal((await db.query(`SELECT version FROM sims WHERE id=$1`, [legacyId.id])).rows[0].version, migrated.version);
});

test('S65 same fingerprint on another gateway moves the row and keeps identity, owner, label and settings', async () => {
  const gatewayB = (await db.query(`INSERT INTO gateways(name,control_enabled) VALUES('sim-identity-test-b',false) RETURNING id`)).rows[0].id;
  const tokenB = `sim-identity-device-b-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label) VALUES($1,$2,'test-b')`, [gatewayB, tokenHash(tokenB)]);
  const authB = { authorization: `Bearer ${tokenB}` };
  await db.query(`UPDATE sims SET label='Portable A',phone_label='+8613300000000' WHERE id=$1`, [simA]);
  await db.query(`UPDATE sim_settings SET mode='ai',timeout_seconds=30 WHERE sim_id=$1`, [simA]);
  const epoch = Number((await db.query(`SELECT device_epoch FROM gateways WHERE id=$1`, [gatewayId])).rows[0].device_epoch);
  const stale = (await db.query(
    `INSERT INTO commands(gateway_id,sim_id,generation,sequence,kind,payload,expires_at)
     VALUES($1,$2,$3,91,'dial','{}',now()+interval '1 hour') RETURNING id`,
    [gatewayId, simA, epoch],
  )).rows[0].id;
  // Old gateway still reports the card present: the latest report (gateway B) wins.
  const stillPresent = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 30, FINGERPRINT_C), reported(2, 23, FINGERPRINT_B), reported(1, 12, FINGERPRINT_A)] },
  });
  assert.equal(stillPresent.statusCode, 200, stillPresent.body);
  const before = (await db.query(`SELECT version FROM sims WHERE id=$1`, [simA])).rows[0].version;

  const moved = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: authB,
    payload: { items: [{ ...reported(0, 50, FINGERPRINT_A), phoneNumber: '+8613311111111' }] },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().items[0].id, simA);
  const row = (await db.query(`SELECT gateway_id,owner_user_id,label,phone_label,slot_index,device_present,version FROM sims WHERE id=$1`, [simA])).rows[0];
  assert.deepEqual(row, { gateway_id: gatewayB, owner_user_id: ownerA, label: 'Portable A', phone_label: '+8613300000000', slot_index: 0, device_present: true, version: String(Number(before) + 1) });
  assert.deepEqual((await db.query(`SELECT mode,timeout_seconds FROM sim_settings WHERE sim_id=$1`, [simA])).rows[0], { mode: 'ai', timeout_seconds: 30 });
  assert.equal((await db.query(`SELECT count(*)::int count FROM sims WHERE gateway_id=$1 AND protected_iccid_hash=$2`, [gatewayId, tokenHash(FINGERPRINT_A)])).rows[0].count, 0);
  assert.deepEqual((await db.query(`SELECT status,result FROM commands WHERE id=$1`, [stale])).rows[0], { status: 'rejected', result: { reason: 'sim_route_changed' } });
  const audit = (await db.query(`SELECT details FROM audit_events WHERE action='sim.gateway.moved' AND resource_id=$1`, [simA])).rows[0].details;
  assert.equal(audit.fromGatewayId, gatewayId);
  assert.equal(audit.toGatewayId, gatewayB);
  assert.equal(audit.previousDevicePresent, true);
  const oldGateway = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: auth(),
    payload: { items: [reported(0, 30, FINGERPRINT_C), reported(2, 23, FINGERPRINT_B)] },
  });
  assert.equal(oldGateway.statusCode, 200, oldGateway.body);
  assert.equal((await db.query(`SELECT gateway_id FROM sims WHERE id=$1`, [simA])).rows[0].gateway_id, gatewayB);

  // Legacy per-device fingerprint rewrites the hash in place on this gateway.
  const legacyId = (await db.query(
    `INSERT INTO sims(gateway_id,owner_user_id,label,protected_iccid_hash) VALUES($1,$2,'Legacy Pixel',$3) RETURNING id,version`,
    [gatewayB, ownerB, tokenHash('pixel-hmac-legacy-fingerprint')],
  )).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id) VALUES($1)`, [legacyId.id]);
  const rehash = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: authB,
    payload: { items: [reported(0, 50, FINGERPRINT_A), { ...reported(1, 51, 'portable-iccid-digest-value'), legacyIccidFingerprint: 'pixel-hmac-legacy-fingerprint', phoneNumber: '13322222222' }] },
  });
  assert.equal(rehash.statusCode, 200, rehash.body);
  const rehashed = rehash.json().items.find((item: any) => item.iccidFingerprint === 'portable-iccid-digest-value');
  assert.equal(rehashed.id, legacyId.id);
  assert.deepEqual(
    (await db.query(`SELECT owner_user_id,protected_iccid_hash,phone_label FROM sims WHERE id=$1`, [legacyId.id])).rows[0],
    { owner_user_id: ownerB, protected_iccid_hash: tokenHash('portable-iccid-digest-value'), phone_label: '13322222222' },
  );

  // A later different phoneNumber never overwrites a filled phone_label.
  const again = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: authB,
    payload: { items: [reported(0, 50, FINGERPRINT_A), { ...reported(1, 51, 'portable-iccid-digest-value'), phoneNumber: '13399999999' }] },
  });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await db.query(`SELECT phone_label FROM sims WHERE id=$1`, [legacyId.id])).rows[0].phone_label, '13322222222');
  const bad = await app.inject({
    method: 'POST', url: '/api/v1/gateway/sims/sync', headers: authB,
    payload: { items: [{ ...reported(0, 50, FINGERPRINT_A), phoneNumber: 'not-a-number' }] },
  });
  assert.equal(bad.statusCode, 400, bad.body);
});
