import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import Fastify, {type FastifyRequest} from 'fastify';
import pg from 'pg';
import {registerAdminGatewayReportRoutes} from '../src/admin-gateway-reports.js';

const {Pool} = pg;
const {reportWindow} = await import('../../voice/report-window.mjs');
const databaseName = `vodog_admin_gateway_reports_${process.pid}_${Date.now()}`;
const adminDb = new Pool({connectionString: 'postgresql:///postgres', max: 1});

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

test('admin gateway AI report route', async (t) => {
  await adminDb.query(`CREATE DATABASE ${databaseName}`);
  const db = new Pool({connectionString: `postgresql:///${databaseName}`, max: 5});
  t.after(async () => {
    await db.end();
    await adminDb.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminDb.end();
  });
  await db.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../src/transcription/schema.sql', import.meta.url), 'utf8'));

  const admin = await user('report-admin@example.test', 'admin');
  const owner1 = await user('historical-owner@example.test', 'user');
  const owner2 = await user('new-owner@example.test', 'user');
  const gateway1 = await gateway('Pixel gateway');
  const gateway2 = await gateway('Other gateway');
  const sim1 = await sim(gateway1, owner1, 0, 'Physical SIM');
  const sim2 = await sim(gateway2, owner2, 0, 'Other SIM');

  let currentTime = new Date('2024-03-11T16:00:00.000Z');
  const app = Fastify();
  const fail = (status: number, code: string, message: string): never => { throw new RouteError(status, code, message); };
  registerAdminGatewayReportRoutes(app, db, {
    requireAdmin(request: FastifyRequest) {
      if (request.headers['x-role'] !== 'admin') fail(403, 'FORBIDDEN', 'Administrator required');
      return {userId: String(request.headers['x-user'])};
    },
    fail,
    reportWindow,
    cursorSecret: 'test-admin-gateway-report-secret-32-bytes-long',
    cursorTtlMs: 1_000,
    now: () => new Date(currentTime),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RouteError) return reply.code(error.status).send({error: {code: error.code, message: error.message}});
    if (error.name === 'ZodError') return reply.code(400).send({error: {code: 'INVALID_REQUEST', message: 'Invalid request'}});
    return reply.code(500).send({error: {code: 'INTERNAL', message: 'Internal error'}});
  });
  await app.ready();
  t.after(() => app.close());

  const headers = {'x-role': 'admin', 'x-user': admin};
  const reportUrl = (gatewayId: string, extra = '') =>
    `/api/v1/admin/gateways/${gatewayId}/reports/calls?period=7d&timeZone=America%2FNew_York&answeredBy=ai&limit=100${extra}`;

  const untranslated = await call(gateway1, sim1, owner1, '2024-03-10T12:00:00Z', 'ai', 'ai', '+1 (415) 555-1768');
  const summarized = await call(gateway1, sim1, owner1, '2024-03-09T12:00:00Z', 'ai', 'timeout_ai', '+886 912 345 678');
  await transcript(summarized, owner1, 'succeeded', {
    text: 'FULL TRANSCRIPT MUST NOT LEAVE THIS ROUTE',
    summary: '客户要求明天回电', actionItems: ['安排回电'],
    advertisingClassification: 'not_advertising', includeInReports: true,
  });
  const advertising = await call(gateway1, sim1, owner1, '2024-03-08T12:00:00Z', 'ai', 'ai', '+1 212 555 0000');
  await transcript(advertising, owner1, 'succeeded', {
    text: 'advertising body', summary: '广告', actionItems: [],
    advertisingClassification: 'advertising', includeInReports: false,
  });
  const failedTranscript = await call(gateway1, sim1, owner1, '2024-03-08T13:00:00Z', 'ai', 'ai', '+1 212 555 3333');
  await transcript(failedTranscript, owner1, 'failed');
  const human = await call(gateway1, sim1, owner1, '2024-03-07T12:00:00Z', 'android', 'ai', '+1 650 555 1111');
  const otherGatewayAi = await call(gateway2, sim2, owner2, '2024-03-10T13:00:00Z', 'ai', 'ai', '+1 650 555 2222');
  await db.query('UPDATE sims SET owner_user_id=$2,version=version+1 WHERE id=$1', [sim1, owner2]);

  await t.test('ordinary users are rejected before report data is read', async () => {
    const response = await app.inject({method: 'GET', url: reportUrl(gateway1), headers: {'x-role': 'user', 'x-user': owner1}});
    assert.equal(response.statusCode, 403);
  });

  await t.test('AI filter, gateway isolation, historical owner, masking and redaction are enforced', async () => {
    const response = await app.inject({method: 'GET', url: reportUrl(gateway1), headers});
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    const ids = body.items.map((item: any) => item.callId);
    assert.ok(ids.includes(untranslated));
    assert.ok(ids.includes(summarized));
    assert.ok(ids.includes(failedTranscript));
    assert.ok(!ids.includes(advertising));
    assert.ok(!ids.includes(human));
    assert.ok(!ids.includes(otherGatewayAi));
    const pending = body.items.find((item: any) => item.callId === untranslated);
    assert.equal(pending.transcriptStatus, 'not_started');
    assert.equal(body.items.find((item: any) => item.callId === failedTranscript).transcriptStatus, 'failed');
    const item = body.items.find((value: any) => value.callId === summarized);
    assert.equal(item.gatewayTimeZone, 'Asia/Shanghai');
    assert.deepEqual(item.historicalOwner, {id: owner1, username: 'historical-owner@example.test'});
    assert.equal(item.remoteNumberMasked, '••••5678');
    assert.equal(item.summary, '客户要求明天回电');
    assert.deepEqual(item.actionItems, ['安排回电']);
    assert.equal(item.answeredByPlatform, 'ai');
    assert.equal(item.modeSnapshot, 'timeout_ai');
    assert.ok(!('callUrl' in item));
    assert.ok(!('transcriptUrl' in item));
    assert.ok(!('recordingUrl' in item));
    assert.ok(!response.body.includes('FULL TRANSCRIPT'));
    assert.ok(!response.body.includes('+886 912 345 678'));

    const audit = await db.query(`SELECT actor_user_id,resource_id,details FROM audit_events
      WHERE action='gateway.ai_reports.read' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.rows[0].actor_user_id, admin);
    assert.equal(audit.rows[0].resource_id, gateway1);
    assert.deepEqual(audit.rows[0].details, {period: '7d', resultCount: body.items.length});
    assert.ok(!JSON.stringify(audit.rows[0].details).includes('客户'));
  });

  await t.test('same timestamp pagination is stable and cursor is query bound', async () => {
    const pageGateway = await gateway('Pagination gateway');
    const pageSim = await sim(pageGateway, owner1, 0, 'Page SIM');
    const at = '2024-03-10T15:00:00Z';
    const expected = [
      await call(pageGateway, pageSim, owner1, at, 'ai', 'ai', '+1 555 000 0001'),
      await call(pageGateway, pageSim, owner1, at, 'ai', 'ai', '+1 555 000 0002'),
      await call(pageGateway, pageSim, owner1, at, 'ai', 'ai', '+1 555 000 0003'),
    ];
    const base = `/api/v1/admin/gateways/${pageGateway}/reports/calls?period=7d&timeZone=Asia%2FTaipei&answeredBy=ai&limit=2`;
    const first = await app.inject({method: 'GET', url: base, headers});
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = first.json();
    assert.equal(firstBody.items.length, 2);
    assert.ok(firstBody.nextCursor);
    const second = await app.inject({method: 'GET', url: `${base}&cursor=${encodeURIComponent(firstBody.nextCursor)}`, headers});
    assert.equal(second.statusCode, 200, second.body);
    const secondBody = second.json();
    assert.equal(secondBody.items.length, 1);
    const seen = [...firstBody.items, ...secondBody.items].map((item: any) => item.callId);
    assert.deepEqual(new Set(seen), new Set(expected));

    // Tamper with a character that carries significant bits. The final base64url character of a
    // 32-byte HMAC encodes only two, so editing the last character often decoded to the identical
    // signature and let the tampered cursor verify (an intermittent false pass).
    const [cursorPayload, cursorSignature] = firstBody.nextCursor.split('.');
    const tampered = `${cursorPayload}.${cursorSignature.startsWith('A') ? 'B' : 'A'}${cursorSignature.slice(1)}`;
    const badSignature = await app.inject({method: 'GET', url: `${base}&cursor=${encodeURIComponent(tampered)}`, headers});
    assert.equal(badSignature.statusCode, 400);
    assert.equal(badSignature.json().error.code, 'INVALID_CURSOR');
    const wrongPeriod = await app.inject({
      method: 'GET',
      url: `${base.replace('period=7d', 'period=1m')}&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      headers,
    });
    assert.equal(wrongPeriod.statusCode, 400);
    assert.equal(wrongPeriod.json().error.code, 'INVALID_CURSOR');

    currentTime = new Date(currentTime.getTime() + 2_000);
    const expired = await app.inject({method: 'GET', url: `${base}&cursor=${encodeURIComponent(firstBody.nextCursor)}`, headers});
    assert.equal(expired.statusCode, 400);
    assert.equal(expired.json().error.code, 'INVALID_CURSOR');
    currentTime = new Date('2024-03-11T16:00:00.000Z');
  });

  await t.test('adjacent PostgreSQL microseconds paginate without loss or duplication', async () => {
    const microGateway = await gateway('Microsecond gateway');
    const microSim = await sim(microGateway, owner1, 0, 'Microsecond SIM');
    const expected = [
      await call(microGateway, microSim, owner1, '2024-03-10T15:00:00.123456Z', 'ai', 'ai', '+1 555 000 0011'),
      await call(microGateway, microSim, owner1, '2024-03-10T15:00:00.123455Z', 'ai', 'ai', '+1 555 000 0012'),
      await call(microGateway, microSim, owner1, '2024-03-10T15:00:00.123454Z', 'ai', 'ai', '+1 555 000 0013'),
    ];
    const base = `/api/v1/admin/gateways/${microGateway}/reports/calls?period=7d&timeZone=Asia%2FTaipei&answeredBy=ai&limit=1`;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.inject({
        method: 'GET',
        url: cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.items.length, 1);
      seen.push(body.items[0].callId);
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, expected.length);
  });

  await t.test('all four periods reuse the calendar window and freeze DST boundaries', async () => {
    for (const period of ['7d', '1m', '6m', '1y']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/gateways/${gateway1}/reports/calls?period=${period}&timeZone=America%2FNew_York&answeredBy=ai`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().window.period, period);
      assert.equal(response.json().window.toExclusive, currentTime.toISOString());
    }
    const dst = (await app.inject({method: 'GET', url: reportUrl(gateway1), headers})).json().window;
    assert.equal((Date.parse(dst.toExclusive) - Date.parse(dst.fromInclusive)) / 3_600_000, 167);
  });

  await t.test('limit defaults to 25 and rejects values above 100', async () => {
    const limitGateway = await gateway('Limit gateway');
    const limitSim = await sim(limitGateway, owner1, 0, 'Limit SIM');
    for (let index = 0; index < 26; index++) {
      await call(limitGateway, limitSim, owner1, `2024-03-10T10:${String(index).padStart(2, '0')}:00Z`, 'ai', 'ai', `+1 555 100 ${String(index).padStart(4, '0')}`);
    }
    const base = `/api/v1/admin/gateways/${limitGateway}/reports/calls?period=7d&timeZone=Asia%2FTaipei&answeredBy=ai`;
    const defaultPage = await app.inject({method: 'GET', url: base, headers});
    assert.equal(defaultPage.statusCode, 200, defaultPage.body);
    assert.equal(defaultPage.json().items.length, 25);
    assert.ok(defaultPage.json().nextCursor);
    const oversized = await app.inject({method: 'GET', url: `${base}&limit=101`, headers});
    assert.equal(oversized.statusCode, 400);
  });

  async function user(email: string, role: 'admin' | 'user') {
    return (await db.query(`INSERT INTO users(email,password_hash,role) VALUES($1,'x',$2) RETURNING id`, [email, role])).rows[0].id as string;
  }
  async function gateway(name: string) {
    return (await db.query('INSERT INTO gateways(name) VALUES($1) RETURNING id', [name])).rows[0].id as string;
  }
  async function sim(gatewayId: string, ownerId: string, slot: number, label: string) {
    return (await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)
      VALUES($1,$2,$3,$4,true) RETURNING id`, [gatewayId, slot, ownerId, label])).rows[0].id as string;
  }
  async function call(
    gatewayId: string, simId: string, ownerId: string, startedAt: string,
    answeredBy: string, mode: string, remoteNumber: string,
  ) {
    return (await db.query(`INSERT INTO call_records(
        gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,started_at,answered_at,ended_at,
        answered_by_platform,mode_snapshot,recording_status,gateway_time_zone)
      VALUES($1,$2,$3,'incoming',$4,'ended',1,$5,$5,$5,$6,$7,'complete','Asia/Shanghai') RETURNING id`,
    [gatewayId, simId, ownerId, remoteNumber, startedAt, answeredBy, mode])).rows[0].id as string;
  }
  async function transcript(callId: string, ownerId: string, state: 'succeeded' | 'failed', result?: object) {
    await db.query(`INSERT INTO transcript_jobs(
        id,call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,error_code,error_message,completed_at)
      VALUES($1,$2,$3,'{}',$4,$5,$6,$7,$8,$9)`, [
      randomUUID(), callId, ownerId, 'a'.repeat(64), state, result ? JSON.stringify(result) : null,
      state === 'failed' ? 'FAILED' : null, state === 'failed' ? 'failed' : null, state === 'succeeded' ? currentTime : null,
    ]);
  }
});
