import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import Fastify, {type FastifyRequest} from 'fastify';
import pg from 'pg';
import {PostgresTranscriptJobRepository} from './repository.js';
import {registerTranscriptionRoutes} from './routes.js';
import {TranscriptionWorker} from './worker.js';

const {Pool} = pg;
const databaseName = `vodog_transcription_test_${process.pid}_${Date.now()}`;
const admin = new Pool({connectionString: 'postgresql:///postgres', max: 1});
let db: pg.Pool;

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('PostgreSQL transcription repository, worker, and owner routes', async (t) => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  db = new Pool({connectionString: `postgresql:///${databaseName}`, max: 6});
  t.after(async () => {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });
  await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));

  const owner1 = (await db.query(`INSERT INTO users(email,password_hash) VALUES('transcript-one@example.test','x') RETURNING id`)).rows[0].id;
  const owner2 = (await db.query(`INSERT INTO users(email,password_hash) VALUES('transcript-two@example.test','x') RETURNING id`)).rows[0].id;
  const gateway = (await db.query(`INSERT INTO gateways(name) VALUES('transcript-test') RETURNING id`)).rows[0].id;
  const sim = (await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label) VALUES($1,0,$2,'SIM 1') RETURNING id`, [gateway, owner1])).rows[0].id;
  const makeCall = async (ownerId = owner1, startedAt = new Date()) => (await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,started_at,ended_at,recording_status)
     VALUES($1,$2,$3,'incoming','ended',1,'normal',$4,$4,'complete') RETURNING id`, [gateway, sim, ownerId, startedAt])).rows[0].id as string;

  const remote = Buffer.from('OggS remote test'.padEnd(256, '.'));
  const caller = Buffer.from('OggS caller test'.padEnd(256, '.'));
  const timeline = Buffer.from('{}\n');
  const buildManifest = (callId: string) => ({
    version: 1, callId, finalizedAt: new Date().toISOString(), complete: true,
    artifacts: [
      {name: 'remote_original.ogg', bytes: remote.length, sha256: sha(remote)},
      {name: 'caller_original.ogg', bytes: caller.length, sha256: sha(caller)},
      {name: 'timeline.jsonl', bytes: timeline.length, sha256: sha(timeline)},
    ],
  });

  await t.test('enqueue is idempotent and only one concurrent claimant wins', async () => {
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const disabledReads: unknown[] = [];
    const disabled = new TranscriptionWorker(repository, {
      reader: {readTrack: async (input) => { disabledReads.push(input); return remote; }},
      provider: {transcribe: async () => { throw new Error('disabled worker invoked provider'); }},
    });
    assert.equal(await disabled.tickOnce(), 'disabled');
    assert.equal(disabledReads.length, 0);

    const worker = new TranscriptionWorker(repository, {reader: {readTrack: async () => remote}});
    const frozenManifest = buildManifest(callId);
    const first = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: frozenManifest});
    const duplicate = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: frozenManifest});
    assert.equal(first.id, duplicate.id);
    await assert.rejects(worker.enqueueCall({callId, snapshotOwnerId: owner2, manifest: frozenManifest}), /OWNER_MISMATCH/);
    const [a, b] = await Promise.all([repository.claim({leaseMs: 10_000}), repository.claim({leaseMs: 10_000})]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  await t.test('expired lease cannot overwrite a replacement worker result or failure', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const worker = new TranscriptionWorker(repository, {reader: {readTrack: async () => remote}});
    const queued = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    const stale = (await repository.claim({leaseMs: 10_000}))!;
    await db.query(`UPDATE transcript_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [queued.id]);
    const current = (await repository.claim({leaseMs: 10_000}))!;
    assert.notEqual(stale.leaseToken, current.leaseToken);
    assert.equal(await repository.renewLease({jobId: queued.id, leaseToken: stale.leaseToken!, leaseMs: 10_000}), false);
    assert.equal(await repository.renewLease({jobId: queued.id, leaseToken: current.leaseToken!, leaseMs: 10_000}), true);
    assert.equal(await repository.complete({jobId: queued.id, leaseToken: stale.leaseToken!, result: {stale: true}}), false);
    assert.equal(await repository.fail({jobId: queued.id, leaseToken: stale.leaseToken!, terminal: true, nextAttemptAt: null, errorCode: 'STALE', errorMessage: 'stale'}), false);
    assert.equal(await repository.complete({jobId: queued.id, leaseToken: current.leaseToken!, result: {current: true}}), true);
    assert.deepEqual((await repository.get(queued.id))!.result, {current: true});
  });

  await t.test('enabled worker verifies frozen bytes and stores real provider metadata', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    const reads: any[] = [];
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => { reads.push(request); return request.track === 'remote_original' ? remote : caller; }},
      provider: {
        transcribe: async (_bytes, context) => ({text: context.track === 'remote_original' ? '客户内容' : '坐席内容', provider: 'local-fake', model: 'test-model', version: 'v1'}),
        classify: async () => ({
          classification: 'not_advertising', summary: '真实分类器摘要', actionItems: ['回电'],
          provider: 'openai-compatible', model: 'report-model', version: 'report-model-v1', enrichmentError: null,
        }),
      },
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'succeeded');
    const stored = (await repository.get(job.id))!;
    assert.equal((stored.result as any).providers[0].version, 'v1');
    assert.equal((stored.result as any).summary, '真实分类器摘要');
    assert.deepEqual((stored.result as any).enrichment, {
      provider: 'openai-compatible', model: 'report-model', version: 'report-model-v1', error: null,
    });
    assert.equal(reads.length, 2);
    assert.ok(reads.every((read) => read.snapshotOwnerId === owner1 && read.mediaType === 'audio/ogg'));
  });

  await t.test('classification failure preserves successful ASR without retranscription', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    let transcriptions = 0;
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {
        transcribe: async (_bytes, context) => { transcriptions++; return {text: context.track, provider: 'local-fake', model: 'asr-model'}; },
        classify: async () => ({
          classification: 'unknown', summary: null, actionItems: [],
          provider: 'openai-compatible', model: 'report-model', version: null,
          enrichmentError: {code: 'CLASSIFIER_HTTP_ERROR', message: 'Classifier HTTP 503'},
        }),
      },
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'succeeded');
    assert.equal(transcriptions, 2);
    const stored = (await repository.get(job.id))!;
    assert.equal((stored.result as any).advertisingClassification, 'unknown');
    assert.equal((stored.result as any).summary, null);
    assert.deepEqual((stored.result as any).actionItems, []);
    assert.deepEqual((stored.result as any).enrichment, {
      provider: 'openai-compatible', model: 'report-model', version: null,
      error: {code: 'CLASSIFIER_HTTP_ERROR', message: 'Classifier HTTP 503'},
    });
    assert.equal(await worker.tickOnce(), 'idle');
    assert.equal(transcriptions, 2);
  });

  await t.test('20 MiB manifest limit is enforced before Reader I/O', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const oversized = buildManifest(callId);
    oversized.artifacts[0] = {name: 'remote_original.ogg', bytes: 20 * 1024 * 1024 + 1, sha256: 'a'.repeat(64)};
    let reads = 0, providerCalls = 0;
    const worker = new TranscriptionWorker(repository, {
      enabled: true, reader: {readTrack: async () => { reads++; return remote; }},
      provider: {transcribe: async () => { providerCalls++; return {text: 'unexpected'}; }},
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: oversized});
    assert.equal(await worker.tickOnce(), 'failed');
    assert.equal(reads, 0); assert.equal(providerCalls, 0);
    assert.equal((await repository.get(job.id))!.errorCode, 'RECORDING_TOO_LARGE');
  });

  await t.test('provider timeout aborts, releases to retry, and persisted errors stay bounded', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    let aborted = false;
    const worker = new TranscriptionWorker(repository, {
      enabled: true, providerTimeoutMs: 10, leaseGraceMs: 100,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {transcribe: async (_bytes, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => { aborted = true; reject(new Error('x'.repeat(2_000))); }, {once: true});
      })},
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'retry');
    assert.equal(aborted, true);
    const stored = (await repository.get(job.id))!;
    assert.equal(stored.errorCode, 'OPERATION_TIMEOUT');
    assert.ok((stored.errorMessage?.length ?? 0) <= 500);
    await db.query('UPDATE transcript_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1', [job.id]);
    const retryLease = (await repository.claim({leaseMs: 10_000}))!;
    assert.equal(await repository.fail({jobId: job.id, leaseToken: retryLease.leaseToken!, terminal: true, nextAttemptAt: null, errorCode: 'PROVIDER_ERROR', errorMessage: 'x'.repeat(2_000)}), true);
    assert.equal((await repository.get(job.id))!.errorMessage?.length, 500);
  });

  await t.test('S23 决策 6: a deferred rate limit hands the attempt back to the job', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const job = await repository.enqueue({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId), manifestFingerprint: 'c'.repeat(64)});
    const limited = (await repository.claim({leaseMs: 10_000}))!;
    assert.equal(limited.attempts, 1);
    const nextAttemptAt = new Date(Date.now() + 90_000);
    assert.equal(await repository.fail({jobId: job.id, leaseToken: limited.leaseToken!, terminal: false, nextAttemptAt,
      errorCode: 'PROVIDER_RATE_LIMITED', errorMessage: 'Transcription provider HTTP 429', countAttempt: false}), true);
    const deferred = (await repository.get(job.id))!;
    assert.equal(deferred.state, 'retry');
    assert.equal(deferred.attempts, 0);
    assert.equal(deferred.nextAttemptAt.toISOString(), nextAttemptAt.toISOString());
    // A real failure on the next claim still spends its attempt.
    await db.query('UPDATE transcript_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1', [job.id]);
    const real = (await repository.claim({leaseMs: 10_000}))!;
    assert.equal(real.attempts, 1);
    assert.equal(await repository.fail({jobId: job.id, leaseToken: real.leaseToken!, terminal: false, nextAttemptAt,
      errorCode: 'PROVIDER_HTTP_ERROR', errorMessage: 'Transcription provider HTTP 503'}), true);
    assert.equal((await repository.get(job.id))!.attempts, 1);
  });

  await t.test('runtime cancellation aborts the current provider operation and safely requeues', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    let providerAborted = false;
    let providerStarted!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const worker = new TranscriptionWorker(repository, {
      enabled: true, providerTimeoutMs: 10_000,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {transcribe: async (_bytes, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => { providerAborted = true; reject(new Error('runtime stopped')); }, {once: true});
        providerStarted();
      })},
    });
    await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    const controller = new AbortController();
    const running = worker.tickOnce(controller.signal);
    // Cancel the active provider, not the preceding database claim on a busy host.
    await Promise.race([started, running.then(() => { throw new Error('worker ended before provider started'); })]);
    controller.abort();
    assert.equal(await running, 'retry');
    assert.equal(providerAborted, true);
  });

  await t.test('transcript and report routes enforce immutable owner and reuse the voice calendar function', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const reportCallId = await makeCall(owner1, new Date());
    const reportWorker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {
        transcribe: async () => ({text: '报告内容', provider: 'local-fake', version: 'v1'}),
        classify: async () => ({classification: 'not_advertising', summary: '真实分类器摘要', actionItems: ['回电']}),
      },
    });
    await reportWorker.enqueueCall({callId: reportCallId, snapshotOwnerId: owner1, manifest: buildManifest(reportCallId)});
    assert.equal(await reportWorker.tickOnce(), 'succeeded');
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof RouteError) return reply.code(error.status).send({error: {code: error.code, message: error.message}});
      return reply.send(error);
    });
    const voiceModuleUrl = new URL('../../../voice/report-window.mjs', import.meta.url).href;
    const voice = await import(voiceModuleUrl) as {reportWindow(input: any): any};
    registerTranscriptionRoutes(app, db, {
      requireUser: (request: FastifyRequest) => {
        const userId = request.headers['x-test-user'];
        if (typeof userId !== 'string') throw new RouteError(401, 'UNAUTHENTICATED', 'Authentication required');
        return {userId};
      },
      mutationOrigin: () => { throw new Error('GET routes must not invoke mutationOrigin'); },
      fail: (status, code, message, details) => { throw new RouteError(status, code, message, details); },
      reportWindow: voice.reportWindow,
      now: () => new Date(),
    });
    const owned = reportCallId;
    const ownTranscript = await app.inject({method: 'GET', url: `/api/v1/calls/${owned}/transcript`, headers: {'x-test-user': owner1}});
    assert.equal(ownTranscript.statusCode, 200, ownTranscript.body);
    assert.equal(ownTranscript.json().transcript.result.summary, '真实分类器摘要');
    const crossOwner = await app.inject({method: 'GET', url: `/api/v1/calls/${owned}/transcript`, headers: {'x-test-user': owner2}});
    assert.equal(crossOwner.statusCode, 404, crossOwner.body);
    const report = await app.inject({method: 'GET', url: '/api/v1/reports/calls?period=7d&timeZone=America%2FNew_York', headers: {'x-test-user': owner1}});
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.json().items.some((item: any) => item.callId === owned), true);
    const otherReport = await app.inject({method: 'GET', url: '/api/v1/reports/calls?period=7d&timeZone=America%2FNew_York', headers: {'x-test-user': owner2}});
    assert.deepEqual(otherReport.json().items, []);
    await app.close();
  });
  await t.test('an empty recording falls back to the realtime AI transcript instead of the provider', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    const header = Buffer.alloc(95); // a bare Ogg page header: the media node saw no RTP at all
    const emptyManifest = {
      version: 1, callId, finalizedAt: new Date().toISOString(), complete: false,
      artifacts: [
        {name: 'remote_original.ogg', bytes: header.length, sha256: sha(header)},
        {name: 'caller_original.ogg', bytes: header.length, sha256: sha(header)},
        {name: 'timeline.jsonl', bytes: 0, sha256: sha(Buffer.alloc(0))},
      ],
    };
    let transcriptions = 0, classifiedText = '';
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async () => { throw new Error('an empty track must never be read'); }},
      provider: {
        transcribe: async () => { transcriptions++; return {text: 'never', provider: 'local-fake'}; },
        classify: async ({text}) => { classifiedText = text; return {
          classification: 'advertising', category: 'insurance', blockRecommended: false, reason: '保险销售',
          summary: '推销重疾险', actionItems: ['考虑屏蔽'], provider: 'openai-compatible', model: 'report-model', version: null, enrichmentError: null}; },
      },
      aiTranscripts: async (input) => {
        assert.equal(input.callId, callId);
        assert.equal(input.snapshotOwnerId, owner1);
        return [{role: 'ai', text: '您好，这里是 AI 助理', at: '2026-09-11T14:00:00.000Z'},
          {role: 'caller', text: '我想了解重疾险', at: '2026-09-11T14:00:05.000Z'}];
      },
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: emptyManifest});
    assert.equal(await worker.tickOnce(), 'succeeded');
    assert.equal(transcriptions, 0, 'a header-only track must never reach the paid provider');
    const result = (await repository.get(job.id))!.result as any;
    assert.equal(result.recording.source, 'ai_realtime_transcript');
    assert.equal(result.recording.complete, false);
    assert.equal(result.text, 'AI: 您好，这里是 AI 助理\n来电: 我想了解重疾险');
    assert.equal(classifiedText, result.text);
    assert.deepEqual(result.segments.map((segment: any) => [segment.track, segment.speaker, segment.text]),
      [['ai_realtime_transcript', 'ai', '您好，这里是 AI 助理'], ['ai_realtime_transcript', 'remote', '我想了解重疾险']]);
    assert.deepEqual(result.providers, []);
    // The server derives the block decision from the category, never from the model's own flag.
    assert.equal(result.blockCategory, 'insurance');
    assert.equal(result.blockRecommended, true);
    assert.equal(result.blockReason, '保险销售');
    assert.equal(result.classifierVersion, 2);
    assert.equal(result.summary, '推销重疾险');
  });

  await t.test('an empty recording with no AI conversation fails terminally with RECORDING_EMPTY', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    const header = Buffer.alloc(44); // a WAV header with no samples
    let transcriptions = 0;
    const worker = new TranscriptionWorker(repository, {
      enabled: true, maxAttempts: 4,
      reader: {readTrack: async () => header},
      provider: {transcribe: async () => { transcriptions++; return {text: 'never', provider: 'local-fake'}; }},
      aiTranscripts: async () => [],
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: {
      version: 1, callId, finalizedAt: new Date().toISOString(), complete: true,
      artifacts: [
        {name: 'remote_original.ogg', bytes: 44, sha256: sha(header)},
        {name: 'caller_original.ogg', bytes: 44, sha256: sha(header)},
        {name: 'timeline.jsonl', bytes: 0, sha256: sha(Buffer.alloc(0))},
      ],
    }});
    assert.equal(await worker.tickOnce(), 'failed');
    assert.equal(transcriptions, 0);
    const stored = (await repository.get(job.id))!;
    assert.equal(stored.state, 'failed');
    assert.equal(stored.errorCode, 'RECORDING_EMPTY');
    assert.equal(stored.errorMessage, '录音为空或采集失败');
  });
});
