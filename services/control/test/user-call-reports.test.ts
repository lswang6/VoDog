import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import Fastify, {type FastifyRequest} from 'fastify';
import pg from 'pg';
import {ZodError} from 'zod';
import {reportDayWindow, reportWindow} from '../../voice/report-window.mjs';
import {PostgresTranscriptJobRepository} from '../src/transcription/repository.js';
import {registerTranscriptionRoutes} from '../src/transcription/routes.js';
import {TranscriptionWorker} from '../src/transcription/worker.js';

const {Pool} = pg;
const databaseName = `vodog_user_reports_${process.pid}_${Date.now()}`;
const admin = new Pool({connectionString: 'postgresql:///postgres', max: 1});
const anchor = new Date('2024-03-31T04:00:00.000Z');

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

test('user call reports list every call in the window and enforce all calendar-window SQL boundaries', async (t) => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const db = new Pool({connectionString: `postgresql:///${databaseName}`, max: 4});
  t.after(async () => {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });
  await db.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../src/transcription/schema.sql', import.meta.url), 'utf8'));

  const ownerId = (await db.query("INSERT INTO users(email,password_hash)VALUES('user-report@example.test','unused')RETURNING id")).rows[0].id;
  const gatewayId = (await db.query("INSERT INTO gateways(name)VALUES('user-report-gateway')RETURNING id")).rows[0].id;
  const simId = (await db.query("INSERT INTO sims(gateway_id,slot_index,owner_user_id,label)VALUES($1,0,$2,'Report SIM')RETURNING id", [gatewayId, ownerId])).rows[0].id;

  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RouteError) return reply.code(error.status).send({error: {code: error.code, message: error.message}});
    // Mirrors app.ts: a query-shape rejection is a 400 INVALID_REQUEST, never a 500.
    if (error instanceof ZodError) return reply.code(400).send({error: {code: 'INVALID_REQUEST', message: 'Request validation failed'}});
    return reply.send(error);
  });
  registerTranscriptionRoutes(app, db, {
    requireUser(request: FastifyRequest) {
      if (request.headers.authorization !== 'Bearer report-owner') throw new RouteError(401, 'UNAUTHENTICATED', 'Authentication required');
      return {userId: ownerId};
    },
    mutationOrigin() { throw new Error('report GET invoked a mutation guard'); },
    fail(status, code, message) { throw new RouteError(status, code, message); },
    reportWindow,
    reportDayWindow,
    now: () => anchor,
  });
  await app.ready();
  t.after(() => app.close());

  const insertCall = async (startedAt: Date, options: {remoteNumber?: string; canonicalKey?: string} = {}) => (await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,started_at,ended_at,recording_status,remote_number,remote_canonical_key)
     VALUES($1,$2,$3,'incoming','ended',1,'normal',$4,$4,'complete',$5,$6) RETURNING id`,
    [gatewayId, simId, ownerId, startedAt, options.remoteNumber ?? null, options.canonicalKey ?? null],
  )).rows[0].id as string;
  const insertSucceeded = async (callId: string) => db.query(
    `INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,completed_at)
     VALUES($1,$2,'{}',$3,'succeeded',$4,clock_timestamp())`,
    [callId, ownerId, createHash('sha256').update(callId).digest('hex'), JSON.stringify({
      text: '边界通话', segments: [], providers: [], advertisingClassification: 'not_advertising',
      includeInReports: true, summary: '边界摘要', actionItems: [],
    })],
  );
  const report = async (search: string) => {
    const response = await app.inject({
      method: 'GET', url: `/api/v1/reports/calls?timeZone=Asia%2FTaipei${search.includes('limit=') ? '' : '&limit=200'}&${search}`,
      headers: {authorization: 'Bearer report-owner'},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    return response.json() as {window: any; items: any[]};
  };
  const reportIds = async (period: '7d' | '1m' | '6m' | '1y') => {
    const body = await report(`period=${period}`);
    assert.equal(body.window.period, period);
    return new Set<string>(body.items.map((item) => item.callId));
  };

  await t.test('an advertising call is reported with a block recommendation instead of being hidden', async () => {
    const callId = await insertCall(new Date(anchor.getTime() - 60_000));
    const remote = Buffer.from('OggS remote advertising'.padEnd(256, '.'));
    const caller = Buffer.from('OggS caller advertising'.padEnd(256, '.'));
    const timeline = Buffer.from('{}\n');
    const artifact = (name: string, bytes: Buffer) => ({name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
    const manifest = {version: 1 as const, callId, finalizedAt: anchor.toISOString(), complete: true, artifacts: [
      artifact('remote_original.ogg', remote), artifact('caller_original.ogg', caller), artifact('timeline.jsonl', timeline),
    ]};
    const repository = new PostgresTranscriptJobRepository(db);
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {
        transcribe: async () => ({text: '促销来电', provider: 'fixture-asr', model: 'fixture-v1'}),
        classify: async () => ({classification: 'advertising', category: 'telemarketing', blockRecommended: false,
          reason: '电话推销', summary: '促销', actionItems: ['考虑屏蔽']}),
      },
      clock: () => anchor,
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: ownerId, manifest});
    assert.equal(await worker.tickOnce(), 'succeeded');
    const persisted = await repository.get(job.id);
    assert.equal((persisted?.result as any).advertisingClassification, 'advertising');
    assert.equal((persisted?.result as any).includeInReports, false, 'the legacy field is kept for older clients');
    // The server re-derives blockRecommended from the category and never trusts the model's value.
    assert.equal((persisted?.result as any).blockCategory, 'telemarketing');
    assert.equal((persisted?.result as any).blockRecommended, true);
    assert.equal((persisted?.result as any).blockReason, '电话推销');
    assert.equal((persisted?.result as any).classifierVersion, 2);

    const transcript = await app.inject({method: 'GET', url: `/api/v1/calls/${callId}/transcript`, headers: {authorization: 'Bearer report-owner'}});
    assert.equal(transcript.statusCode, 200, transcript.body);
    assert.equal(transcript.json().transcript.result.text.includes('促销来电'), true);
    const item = (await report('period=7d')).items.find((row) => row.callId === callId);
    assert.ok(item, 'S22: every call in the window is reported, advertising included');
    assert.equal(item.transcriptState, 'succeeded');
    assert.equal(item.blockRecommended, true);
    assert.equal(item.blockCategory, 'telemarketing');
    assert.equal(item.blockReason, '电话推销');
    assert.equal(item.classification, 'advertising');
    assert.deepEqual(item.actionItems, ['考虑屏蔽']);
    assert.equal(item.summary, '促销');
    assert.equal(item.answerMode, 'normal');
    assert.equal(item.gatewayKind, 'pixel', 'S58: the report item carries the gateway hardware kind');
    await db.query(`UPDATE gateways SET kind='dji4g' WHERE id=$1`, [gatewayId]);
    try {
      assert.equal((await report('period=7d')).items.find((row) => row.callId === callId)?.gatewayKind, 'dji4g');
    } finally {
      await db.query(`UPDATE gateways SET kind='pixel' WHERE id=$1`, [gatewayId]);
    }
    assert.equal(item.hasAiTranscript, false);
    assert.equal(item.transcriptError, null);
    assert.equal(item.aiTranscriptUrl, `/api/v1/calls/${callId}/ai-transcript`);
    assert.equal(item.blocked, false);
    assert.equal(item.contactName, null);
  });

  await t.test('each period includes its lower boundary and excludes its upper boundary', async () => {
    for (const period of ['7d', '1m', '6m', '1y'] as const) {
      const window = reportWindow({period, anchor, timeZone: 'Asia/Taipei', disambiguation: 'compatible'});
      const fixtures = {
        before: await insertCall(new Date(window.fromInclusive.getTime() - 1)),
        lower: await insertCall(window.fromInclusive),
        upperInside: await insertCall(new Date(window.toExclusive.getTime() - 1)),
        upper: await insertCall(window.toExclusive),
      };
      await Promise.all(Object.values(fixtures).map(insertSucceeded));
      const ids = await reportIds(period);
      assert.equal(ids.has(fixtures.before), false, `${period} included a call before fromInclusive`);
      assert.equal(ids.has(fixtures.lower), true, `${period} excluded fromInclusive`);
      assert.equal(ids.has(fixtures.upperInside), true, `${period} excluded the last in-window millisecond`);
      assert.equal(ids.has(fixtures.upper), false, `${period} included toExclusive`);
    }
  });
  await t.test('every call in the window is reported whatever its transcript state, except interceptions', async () => {
    await db.query('DELETE FROM call_records');
    const at = new Date(anchor.getTime() - 60_000);
    const succeeded = await insertCall(at); await insertSucceeded(succeeded);
    const queued = await insertCall(at);
    await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state)
      VALUES($1,$2,'{}',$3,'queued')`, [queued, ownerId, createHash('sha256').update(`${queued}-queued`).digest('hex')]);
    const failed = await insertCall(at);
    await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,error_code,error_message,completed_at)
      VALUES($1,$2,'{}',$3,'failed','RECORDING_EMPTY','录音为空或采集失败',clock_timestamp())`,
      [failed, ownerId, createHash('sha256').update(`${failed}-failed`).digest('hex')]);
    const none = await insertCall(at);
    const intercepted = await insertCall(at);
    await db.query(`UPDATE call_records SET failure_reason='number_blocked' WHERE id=$1`, [intercepted]);
    const items = (await report('period=7d')).items;
    const byId = new Map<string, any>(items.map((item) => [item.callId, item]));
    assert.equal(byId.has(intercepted), false, 'interception rows belong to the blocklist tab');
    assert.equal(byId.get(succeeded).transcriptState, 'succeeded');
    assert.equal(byId.get(queued).transcriptState, 'queued');
    assert.equal(byId.get(failed).transcriptState, 'failed');
    assert.deepEqual(byId.get(failed).transcriptError, {code: 'RECORDING_EMPTY'});
    assert.equal(byId.get(failed).summary, null);
    assert.equal(byId.get(none).transcriptState, 'none');
    assert.equal(byId.get(none).transcriptError, null);
    // A row written before classifier v2 has no category key and must render as unclassified.
    assert.equal(byId.get(succeeded).blockRecommended, null);
    assert.equal(byId.get(succeeded).blockCategory, null);
    assert.equal(byId.get(succeeded).blockReason, null);
    assert.equal(byId.get(succeeded).classification, 'not_advertising');
  });

  await t.test('explicit calendar days win over the period and are validated as a pair', async () => {
    await db.query('DELETE FROM call_records');
    // Asia/Taipei wall days: 2024-03-29 10:00 and 2024-03-31 10:00 local.
    const early = await insertCall(new Date('2024-03-29T02:00:00.000Z'));
    const late = await insertCall(new Date('2024-03-31T02:00:00.000Z'));
    const single = await report('from=2024-03-29&to=2024-03-29&period=1y');
    assert.deepEqual(single.items.map((item) => item.callId), [early]);
    assert.equal(single.window.period, undefined, 'an explicit range is not a period');
    assert.equal(single.window.fromInclusive, reportDayWindow({from: '2024-03-29', to: '2024-03-29', timeZone: 'Asia/Taipei', disambiguation: 'compatible'}).fromInclusive.toISOString());
    const both = await report('from=2024-03-29&to=2024-03-31');
    assert.deepEqual(both.items.map((item) => item.callId), [late, early]);
    const inverted = await app.inject({method: 'GET', url: '/api/v1/reports/calls?timeZone=Asia%2FTaipei&from=2024-03-31&to=2024-03-29', headers: {authorization: 'Bearer report-owner'}});
    assert.equal(inverted.statusCode, 400, inverted.body);
    assert.equal(inverted.json().error.code, 'INVALID_REPORT_RANGE');
    const halfOpen = await app.inject({method: 'GET', url: '/api/v1/reports/calls?timeZone=Asia%2FTaipei&from=2024-03-29', headers: {authorization: 'Bearer report-owner'}});
    assert.equal(halfOpen.statusCode, 400, halfOpen.body);
    assert.equal(halfOpen.json().error.code, 'INVALID_REPORT_RANGE');
    const badZone = await app.inject({method: 'GET', url: '/api/v1/reports/calls?timeZone=Asia%2FBeijing&from=2024-03-29&to=2024-03-29', headers: {authorization: 'Bearer report-owner'}});
    assert.equal(badZone.statusCode, 400, badZone.body);
    assert.equal(badZone.json().error.code, 'INVALID_TIME_ZONE');
  });

  await t.test('report search spans the number, the contact name, the transcript and the AI conversation', async () => {
    await db.query('DELETE FROM call_records');
    const at = new Date(anchor.getTime() - 60_000);
    const byNumber = await insertCall(at, {remoteNumber: '+19995550001'});
    const byContact = await insertCall(at, {remoteNumber: '+8613900000001', canonicalKey: '+8613900000001'});
    const contactId = (await db.query(`INSERT INTO contacts(owner_user_id,display_name,normalized_name,source)VALUES($1,'李四 家电','李四 家电','manual')RETURNING id`, [ownerId])).rows[0].id;
    await db.query(`INSERT INTO contact_phones(contact_id,owner_user_id,raw_number,canonical_key,is_primary)VALUES($1,$2,'+8613900000001','+8613900000001',true)`, [contactId, ownerId]);
    const bySummary = await insertCall(at);
    await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,completed_at)
      VALUES($1,$2,'{}',$3,'succeeded',$4,clock_timestamp())`, [bySummary, ownerId, createHash('sha256').update(`${bySummary}-summary`).digest('hex'),
      JSON.stringify({text: '坐席: 空调维修上门', summary: '预约空调维修', actionItems: [], advertisingClassification: 'not_advertising', includeInReports: true})]);
    const byAi = await insertCall(at);
    const runId = (await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at)
      VALUES($1,$2,$3,1,1,'ai',1,1,45,now())RETURNING id`, [byAi, gatewayId, ownerId])).rows[0].id;
    await db.query(`INSERT INTO ai_run_transcripts(run_id,call_id,role,sequence,text,at)VALUES($1,$2,'caller',0,'我要退订这个服务',now())`, [runId, byAi]);
    const ids = async (query: string) => (await report(`period=7d&query=${encodeURIComponent(query)}`)).items.map((item) => item.callId);
    assert.deepEqual(await ids('9995550001'), [byNumber]);
    assert.deepEqual(await ids('李四'), [byContact]);
    assert.deepEqual(await ids('预约空调'), [bySummary]);
    assert.deepEqual(await ids('空调维修上门'), [bySummary]);
    assert.deepEqual(await ids('退订这个服务'), [byAi]);
    // The contact annotation travels with the row, so the card can render a name and a block state.
    const annotated = (await report('period=7d')).items.find((item) => item.callId === byContact);
    assert.equal(annotated.contactName, '李四 家电');
    assert.equal(annotated.contactId, contactId);
    assert.equal(annotated.blocked, false);
    assert.equal((await report('period=7d')).items.find((item) => item.callId === byAi).hasAiTranscript, true);
    // A LIKE wildcard in the query is data, not syntax.
    assert.deepEqual(await ids('李%四'), [byContact]);
    // A cleared search box is an unfiltered window, never a 400.
    assert.equal((await report('period=7d&query=')).items.length, (await report('period=7d')).items.length);
    // The cursor pages strictly backwards without repeating the anchor row.
    const first = await report('period=7d&limit=1');
    assert.equal(first.items.length, 1);
    const second = await report(`period=7d&limit=1&before=${encodeURIComponent(new Date(first.items[0].startedAt).toISOString())}&beforeId=${first.items[0].callId}`);
    assert.notEqual(second.items[0]?.callId, first.items[0].callId);
  });

  await t.test('S28: report offset pages are opt-in, counted, SIM filtered, and keep the legacy envelope', async () => {
    await db.query('DELETE FROM call_records');
    const otherSimId = (await db.query(
      "INSERT INTO sims(gateway_id,slot_index,owner_user_id,label)VALUES($1,1,$2,'Report SIM 2')RETURNING id", [gatewayId, ownerId])).rows[0].id as string;
    const strangerId = (await db.query("INSERT INTO users(email,password_hash)VALUES('report-stranger@example.test','unused')RETURNING id")).rows[0].id as string;
    const strangerSimId = (await db.query(
      "INSERT INTO sims(gateway_id,slot_index,owner_user_id,label)VALUES($1,2,$2,'Stranger SIM')RETURNING id", [gatewayId, strangerId])).rows[0].id as string;
    const insert = async (owner: string, sim: string, remote: string, startedAt: Date) => (await db.query(
      `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,started_at,ended_at,recording_status,remote_number)
       VALUES($1,$2,$3,'incoming','ended',1,'normal',$4,$4,'complete',$5) RETURNING id`,
      [gatewayId, sim, owner, startedAt, remote])).rows[0].id as string;
    // Asia/Taipei calendar days 2024-03-16 .. 2024-03-25, comfortably inside the requested range.
    const base = Date.parse('2024-03-25T02:00:00.000Z');
    const expected: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      const onOther = index % 3 === 0;   // 40 rows
      const searchable = index % 4 === 0; // 30 rows match `query=555777`
      expected.push(await insert(ownerId, onOther ? otherSimId : simId,
        `+1555${searchable ? '777' : '900'}${String(index).padStart(3, '0')}`, new Date(base - index * 3_600_000)));
    }
    for (let index = 0; index < 5; index += 1) {
      await insert(strangerId, strangerSimId, `+1555777${String(index).padStart(3, '0')}`, new Date(base - index * 3_600_000));
    }
    const range = 'timeZone=Asia%2FTaipei&from=2024-03-10&to=2024-03-26';
    const paged = async (search: string) => {
      const response = await app.inject({method: 'GET', url: `/api/v1/reports/calls?${range}&${search}`, headers: {authorization: 'Bearer report-owner'}});
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store', 'a page is still private and uncached');
      return response.json() as {window: any; items: any[]; page: number; pageSize: number; total: number; totalPages: number};
    };
    const first = await paged('page=1&pageSize=50');
    // The resolved window stays in the envelope: a paged report client still renders the range.
    assert.deepEqual(Object.keys(first).sort(), ['items', 'page', 'pageSize', 'total', 'totalPages', 'window']);
    assert.equal(first.items.length, 50);
    assert.equal(first.page, 1); assert.equal(first.pageSize, 50);
    assert.equal(first.total, 120, "the stranger's rows are neither paged nor counted");
    assert.equal(first.totalPages, 3);
    assert.equal(first.items[0].callId, expected[0], 'the first page opens on the newest call');
    const second = await paged('page=2&pageSize=50');
    const third = await paged('page=3&pageSize=50');
    assert.equal(third.items.length, 20);
    assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.callId), expected);
    const past = await paged('page=4&pageSize=50');
    assert.deepEqual(past.items, []);
    assert.equal(past.total, 120); assert.equal(past.totalPages, 3); assert.equal(past.page, 4);
    assert.equal((await paged('page=1')).pageSize, 50);
    assert.equal((await paged('page=1&pageSize=200')).totalPages, 1);

    const rejected = async (search: string, code = 'INVALID_REQUEST') => {
      const response = await app.inject({method: 'GET', url: `/api/v1/reports/calls?${range}&${search}`, headers: {authorization: 'Bearer report-owner'}});
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, code);
    };
    await rejected('page=1&pageSize=25');
    await rejected('page=0');
    await rejected('page=1&pageSize=51');
    await rejected(`page=1&before=${encodeURIComponent(new Date(base).toISOString())}`);
    await rejected(`page=1&beforeId=${expected[0]}`);
    await rejected('simId=not-a-uuid');

    // Legacy: no `page`, so the envelope is the S22 one and the cursor still pages backwards.
    const legacy = await app.inject({method: 'GET', url: `/api/v1/reports/calls?${range}&limit=200`, headers: {authorization: 'Bearer report-owner'}});
    assert.deepEqual(Object.keys(legacy.json()), ['window', 'items'], 'a legacy caller sees no paging keys at all');
    assert.deepEqual(legacy.json().items.map((item: any) => item.callId), expected);
    const cursor = await app.inject({method: 'GET',
      url: `/api/v1/reports/calls?${range}&limit=200&before=${encodeURIComponent(new Date(base - 99 * 3_600_000).toISOString())}&beforeId=${expected[99]}`,
      headers: {authorization: 'Bearer report-owner'}});
    assert.deepEqual(cursor.json().items.map((item: any) => item.callId), expected.slice(100));

    const searched = await paged('page=1&pageSize=50&query=555777');
    assert.equal(searched.total, 30); assert.equal(searched.totalPages, 1);
    assert.deepEqual(searched.items.map((item) => item.callId), expected.filter((_, index) => index % 4 === 0));
    const bySim = await paged(`page=1&pageSize=50&simId=${otherSimId}`);
    assert.equal(bySim.total, 40); assert.equal(bySim.totalPages, 1);
    assert.deepEqual(bySim.items.map((item) => item.callId), expected.filter((_, index) => index % 3 === 0));
    const legacyBySim = await app.inject({method: 'GET', url: `/api/v1/reports/calls?${range}&limit=200&simId=${otherSimId}`, headers: {authorization: 'Bearer report-owner'}});
    assert.deepEqual(legacyBySim.json().items.map((item: any) => item.callId), expected.filter((_, index) => index % 3 === 0));
    assert.deepEqual(Object.keys(legacyBySim.json()), ['window', 'items']);
    const both = await paged(`page=1&pageSize=50&simId=${otherSimId}&query=555777`);
    assert.equal(both.total, 10, 'index divisible by 12');
    assert.deepEqual(both.items.map((item) => item.callId), expected.filter((_, index) => index % 12 === 0));
    // Interceptions stay out of the report in paged mode too, count included.
    await db.query("UPDATE call_records SET failure_reason='number_blocked' WHERE id=ANY($1)", [expected.slice(0, 3)]);
    const withoutBlocked = await paged('page=1&pageSize=50');
    assert.equal(withoutBlocked.total, 117);
    assert.equal(withoutBlocked.items[0].callId, expected[3]);
    await db.query('DELETE FROM call_records');
  });
});
