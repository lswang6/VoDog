import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import test from 'node:test';
import type {RecordingManifest, RecordingSource, RecordingTrack} from '../recording-store.js';
import {createGeminiTranscriptionProvider, createOpenAICompatibleTranscriptionProvider} from './provider.js';
import {retryAfterPolicy, TranscriptionProviderHttpError} from './provider-error.js';
import {RegistryRecordingReader, TranscriptRecordingReaderError} from './reader.js';
import {freezeRecordingManifest, type TrackReadRequest} from './worker.js';

const callId = '00000000-0000-4000-8000-000000000001';
const ownerId = '00000000-0000-4000-8000-000000000002';
const remote = Buffer.from('OggS remote production-adapter test'.padEnd(256, '.'));
const caller = Buffer.from('OggS caller production-adapter test'.padEnd(256, '.'));
const timeline = Buffer.from('{}\n');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifest = (): RecordingManifest => ({
  version: 1, callId, finalizedAt: '2026-09-09T00:00:00.000Z', complete: true,
  artifacts: [
    {name: 'remote_original.ogg', bytes: remote.length, sha256: sha(remote)},
    {name: 'caller_original.ogg', bytes: caller.length, sha256: sha(caller)},
    {name: 'timeline.jsonl', bytes: timeline.length, sha256: sha(timeline)},
  ],
});

function context(signal = new AbortController().signal) {
  return {callId, snapshotOwnerId: ownerId, manifestFingerprint: 'a'.repeat(64), track: 'remote_original', mediaType: 'audio/ogg', formatVersion: 1, signal};
}

test('Gemini provider matches the verified WACLI generateContent request and returns metadata', async () => {
  let requestBody: any;
  const provider = createGeminiTranscriptionProvider({
    apiKey: 'test-key-not-a-secret', model: 'gemini-test',
    fetcher: async (input, init) => {
      assert.equal(String(input), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
      assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'test-key-not-a-secret');
      assert.equal(init?.redirect, 'error');
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({modelVersion: 'gemini-test-202609', candidates: [{content: {role: 'model', parts: [{audioTranscription: {
        speakerLabel: 'spk_1', words: [
          {word: 'Hello', startOffset: '0.100s', endOffset: '0.450s'},
          {word: 'world', startOffset: '0.500s', endOffset: '0.850s'},
        ],
      }}]}, finishReason: 'STOP'}]}), {status: 200, headers: {'content-type': 'application/json'}});
    },
  });
  const result = await provider.transcribe(remote, context());
  assert.deepEqual(requestBody.contents, [{role: 'user', parts: [{inline_data: {mime_type: 'audio/ogg', data: remote.toString('base64')}}]}]);
  assert.deepEqual(requestBody.generationConfig, {audioTranscriptionConfig: {wordTimestamp: true, diarization: true}});
  assert.deepEqual(result, {text: 'Hello world', segments: [
    {text: 'Hello world', startMs: 100, endMs: 850},
  ], provider: 'google-gemini', model: 'gemini-test', version: 'gemini-test-202609'});
  assert.deepEqual(await provider.classify!({callId, snapshotOwnerId: ownerId, text: result.text, segments: [], signal: new AbortController().signal}), {classification: 'unknown', summary: null, actionItems: []});
});

test('Gemini provider groups word annotations into readable utterance segments', async () => {
  const provider = createGeminiTranscriptionProvider({
    apiKey: 'test-key', model: 'gemini-test',
    fetcher: async () => Response.json({candidates: [{finishReason: 'STOP', content: {parts: [{audioTranscription: {speakerLabel: 'spk_1', words: [
      {word: '尊', startOffset: '3.0s', endOffset: '3.2s'},
      {word: '敬', startOffset: '3.2s', endOffset: '3.4s'},
      {word: '的', startOffset: '3.4s', endOffset: '3.6s'},
      {word: '客', startOffset: '3.6s', endOffset: '3.8s'},
      {word: '户', startOffset: '3.8s', endOffset: '4.0s'},
      {word: '，', startOffset: '4.0s', endOffset: '4.1s'},
      {word: '欢迎', startOffset: '4.1s', endOffset: '4.5s'},
      {word: '致电', startOffset: '4.5s', endOffset: '4.9s'},
      {word: '中国电信', startOffset: '4.9s', endOffset: '5.6s'},
      {word: '。', startOffset: '5.6s', endOffset: '5.7s'},
      {word: '人工', startOffset: '8.0s', endOffset: '8.4s'},
      {word: '服务', startOffset: '8.4s', endOffset: '8.9s'},
      {word: '。', startOffset: '8.9s', endOffset: '9.0s'},
    ]}}]}}]}),
  });
  const result = await provider.transcribe(remote, context());
  assert.deepEqual(result.segments, [
    {text: '尊敬的客户，欢迎致电中国电信。', startMs: 3000, endMs: 5700},
    {text: '人工服务。', startMs: 8000, endMs: 9000},
  ]);
});

test('Gemini provider keeps legacy text compatibility and rejects ambiguous or blocked responses', async () => {
  const response = (value: unknown) => async () => Response.json(value);
  const legacy = createGeminiTranscriptionProvider({apiKey: 'test-key', model: 'gemini-test',
    fetcher: response({candidates: [{content: {parts: [{text: '原语言转录'}]}, finishReason: 'STOP'}]})});
  assert.equal((await legacy.transcribe(remote, context())).text, '原语言转录');

  for (const value of [
    {candidates: [{content: {parts: [{text: ''}]}}]},
    {candidates: [{content: {parts: [{audioTranscription: {speakerLabel: 'spk_1', words: []}}]}, finishReason: 'STOP'}]},
    {candidates: [{finishReason: 'SAFETY'}]},
    {promptFeedback: {blockReason: 'SAFETY'}, candidates: [{content: {parts: [{text: 'must not pass'}]}, finishReason: 'STOP'}]},
    {promptFeedback: {blockReason: 1}, candidates: [{content: {parts: [{text: 'must not pass'}]}, finishReason: 'STOP'}]},
    {candidates: [{content: {parts: [{text: 'first'}]}, finishReason: 'STOP'}, {content: {parts: [{text: 'second'}]}, finishReason: 'STOP'}]},
    {candidates: [{content: {parts: [{text: 'must not pass'}]}, finishReason: 'STOP', safetyRatings: {blocked: false}}]},
    {candidates: [{content: {parts: [{audioTranscription: {speakerLabel: 'spk_1', words: [{word: ' ', startOffset: '0.1s', endOffset: '0.2s'}]}}]}, finishReason: 'STOP'}]},
    {candidates: [{content: {parts: [{audioTranscription: {speakerLabel: 'spk_1', words: [{word: 'bad', startOffset: 'soon', endOffset: '0.2s'}]}}]}, finishReason: 'STOP'}]},
    {candidates: [{content: {parts: [{audioTranscription: {speakerLabel: 'spk_1', words: [{word: 'backward', startOffset: '0.5s', endOffset: '0.2s'}]}}]}, finishReason: 'STOP'}]},
    {candidates: [{content: {parts: [{text: 'must not pass'}]}, finishReason: 'STOP', safetyRatings: [{blocked: true}]}]},
  ]) {
    const provider = createGeminiTranscriptionProvider({apiKey: 'test-key', fetcher: response(value)});
    await assert.rejects(provider.transcribe(remote, context()), /no transcription|blocked|unusable|invalid prompt feedback|invalid word annotations/);
  }
});

test('Gemini provider rejects invalid/oversized input before fetch and bounds operation time', async () => {
  let fetches = 0;
  const provider = createGeminiTranscriptionProvider({apiKey: 'test-key', timeoutMs: 10, fetcher: async (_input, init) => {
    fetches++;
    return new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), {once: true});
    });
  }});
  await assert.rejects(provider.transcribe(Buffer.from('not ogg'), context()), /manifest v1 Ogg/);
  await assert.rejects(provider.transcribe(Buffer.alloc(20 * 1024 * 1024 + 1), context()), /20 MiB/);
  assert.equal(fetches, 0);
  await assert.rejects(provider.transcribe(remote, context()), /aborted/);
  assert.equal(fetches, 1);
});

test('Gemini provider uses only bounded success JSON and exposes an injected classifier', async () => {
  let classified = false;
  const provider = createGeminiTranscriptionProvider({
    apiKey: 'test-key',
    fetcher: async () => new Response('x', {status: 200, headers: {'content-length': String(1024 * 1024 + 1)}}),
    classifier: async ({text, signal}) => { classified = true; assert.equal(text, 'text'); assert.equal(signal.aborted, false); return {classification: 'advertising', summary: '摘要', actionItems: []}; },
  });
  await assert.rejects(provider.transcribe(remote, context()), /too large/);
  assert.deepEqual(await provider.classify!({callId, snapshotOwnerId: ownerId, text: 'text', segments: [], signal: new AbortController().signal}), {classification: 'advertising', summary: '摘要', actionItems: []});
  assert.equal(classified, true);
});

test('Gemini provider classifies 429 without retaining the error body and bounds Retry-After', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"message":"must-not-be-persisted"}}')); },
    cancel() { cancelled = true; },
  });
  const provider = createGeminiTranscriptionProvider({
    apiKey: 'test-key', clock: () => new Date('2026-09-10T00:00:00.000Z'),
    fetcher: async () => new Response(body, {status: 429, headers: {'retry-after': '90'}}),
  });
  await assert.rejects(provider.transcribe(remote, context()), (error: any) => {
    assert.ok(error instanceof TranscriptionProviderHttpError);
    assert.equal(error.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 90_000);
    assert.equal(error.message, 'Transcription provider HTTP 429');
    assert.doesNotMatch(error.message, /must-not-be-persisted/);
    return true;
  });
  assert.equal(cancelled, true);
});

test('Retry-After accepts bounded delay seconds or HTTP dates and defers excessive values', () => {
  const now = Date.parse('2026-09-10T00:00:00.000Z');
  assert.deepEqual(retryAfterPolicy('12', now), {delayMs: 12_000, exceedsAutomaticWindow: false});
  assert.deepEqual(retryAfterPolicy('Thu, 10 Sep 2026 00:02:00 GMT', now), {delayMs: 120_000, exceedsAutomaticWindow: false});
  assert.deepEqual(retryAfterPolicy('0', now), {delayMs: 0, exceedsAutomaticWindow: false});
  assert.deepEqual(retryAfterPolicy('9999999999999999', now), {exceedsAutomaticWindow: true});
  assert.deepEqual(retryAfterPolicy('999999999', now), {exceedsAutomaticWindow: true});
  assert.deepEqual(retryAfterPolicy('1'.repeat(129), now), {exceedsAutomaticWindow: true});
  assert.deepEqual(retryAfterPolicy('not-a-delay', now), {exceedsAutomaticWindow: false});
});

test('Gemini provider defers 429 beyond the bounded automatic retry window', async () => {
  for (const retryAfter of ['901', 'Thu, 10 Sep 2026 00:15:01 GMT']) {
    const provider = createGeminiTranscriptionProvider({
      apiKey: 'test-key', clock: () => new Date('2026-09-10T00:00:00.000Z'),
      fetcher: async () => new Response(null, {status: 429, headers: {'retry-after': retryAfter}}),
    });
    await assert.rejects(provider.transcribe(remote, context()), (error: any) => {
      assert.ok(error instanceof TranscriptionProviderHttpError);
      assert.equal(error.code, 'PROVIDER_RATE_LIMITED_DEFERRED');
      assert.equal(error.retryable, false);
      assert.equal(error.retryAfterMs, undefined);
      assert.match(error.message, /exceeds the automatic retry window/);
      return true;
    });
  }
});

test('Gemini provider marks non-retryable HTTP failures without reading their bodies', async () => {
  const provider = createGeminiTranscriptionProvider({apiKey: 'test-key', fetcher: async () => new Response('private provider detail', {status: 400})});
  await assert.rejects(provider.transcribe(remote, context()), (error: any) => {
    assert.ok(error instanceof TranscriptionProviderHttpError);
    assert.equal(error.code, 'PROVIDER_HTTP_ERROR');
    assert.equal(error.retryable, false);
    assert.equal(error.message, 'Transcription provider HTTP 400');
    return true;
  });
});

const base = 'https://transcribe.example.test/v1';
const options = {baseURL: base, apiKey: 'test-key-not-a-secret', model: 'compatible-test'};
/** Pixel's canonical 16 kHz mono 16-bit WAV: 640 payload bytes is exactly 20 ms. */
function wav() {
  const value = Buffer.alloc(684);
  value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(16_000, 24);
  value.writeUInt32LE(32_000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write('data', 36); value.writeUInt32LE(value.length - 44, 40);
  return value;
}
const pixelWav = wav();
const wavContext = (signal = new AbortController().signal) => ({...context(signal), mediaType: 'audio/wav', formatVersion: 3, track: 'caller_original'});
const withoutAttempts = ({attempts, ...rest}: any) => rest;
const chatResponse = (content: string, extra: Record<string, unknown> = {}) =>
  Response.json({model: 'compatible-test-202609', choices: [{finish_reason: 'stop', message: {role: 'assistant', content, reasoning_content: 'ignored thinking'}, ...extra}]});

test('OpenAI-compatible provider posts one chat completion with the audio and keeps strict JSON segments', async () => {
  let requestBody: any;
  const provider = createOpenAICompatibleTranscriptionProvider({
    ...options,
    fetcher: async (input, init) => {
      assert.equal(String(input), 'https://transcribe.example.test/v1/chat/completions');
      assert.equal((init?.headers as Record<string, string>)['Authorization'], 'Bearer test-key-not-a-secret');
      assert.equal(init?.redirect, 'error');
      requestBody = JSON.parse(String(init?.body));
      return chatResponse(JSON.stringify({segments: [
        {startMs: 320, endMs: 1_900, text: '你好，请问是张先生吗？'},
        {startMs: 2_400, endMs: 3_050, text: '是的。'},
      ]}));
    },
  });
  const result = await provider.transcribe(remote, context());
  assert.equal(requestBody.model, 'compatible-test');
  assert.equal(requestBody.max_tokens, 8_192);
  // The verified request shape carried no `temperature`; it is only sent when configured.
  assert.equal('temperature' in requestBody, false);
  assert.equal(requestBody.messages.length, 1);
  assert.equal(requestBody.messages[0].role, 'user');
  assert.equal(requestBody.messages[0].content[0].type, 'text');
  assert.match(requestBody.messages[0].content[0].text, /逐字转写[\s\S]*segments/);
  assert.deepEqual(requestBody.messages[0].content[1], {type: 'input_audio', input_audio: {data: remote.toString('base64'), format: 'ogg'}});
  assert.deepEqual(withoutAttempts(result), {
    text: '你好，请问是张先生吗？是的。',
    segments: [{text: '你好，请问是张先生吗？', startMs: 320, endMs: 1_900}, {text: '是的。', startMs: 2_400, endMs: 3_050}],
    provider: 'openai-compatible', model: 'compatible-test', version: 'compatible-test-202609',
  });
  assert.equal((result as any).attempts.length, 1);
  assert.equal((result as any).attempts[0].model, 'compatible-test');
  assert.equal((result as any).attempts[0].prompt, 'json');
  assert.equal((result as any).attempts[0].status, 200);
  assert.ok(Number.isFinite((result as any).attempts[0].ms));
  assert.deepEqual(await provider.classify!({callId, snapshotOwnerId: ownerId, text: result.text, segments: [], signal: new AbortController().signal}), {classification: 'unknown', summary: null, actionItems: []});
});

test('OpenAI-compatible provider maps WAV input, unwraps one JSON fence, and reads the version header', async () => {
  let requestBody: any;
  const provider = createOpenAICompatibleTranscriptionProvider({
    ...options,
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({choices: [{message: {content: '```json\n{"segments":[{"startMs":0,"endMs":20,"text":"喂"}]}\n```'}}]}),
        {status: 200, headers: {'content-type': 'application/json', 'x-model-version': 'compatible-test-header'}});
    },
  });
  const result = await provider.transcribe(pixelWav, wavContext());
  assert.equal(requestBody.messages[0].content[1].input_audio.format, 'wav');
  assert.equal(requestBody.messages[0].content[1].input_audio.data, pixelWav.toString('base64'));
  assert.deepEqual(withoutAttempts(result), {text: '喂', segments: [{text: '喂', startMs: 0, endMs: 20}], provider: 'openai-compatible', model: 'compatible-test', version: 'compatible-test-header'});
});

test('OpenAI-compatible provider falls back to one segment when the model answers in prose', async () => {
  const prose = '喂，你好，我这边是物业客服。';
  const ogg = createOpenAICompatibleTranscriptionProvider({...options, fetcher: async () => chatResponse(prose)});
  assert.deepEqual(withoutAttempts(await ogg.transcribe(remote, context())), {
    text: prose, segments: [{text: prose, startMs: 0}],
    provider: 'openai-compatible', model: 'compatible-test', version: 'compatible-test-202609',
  });
  // Only the fixed-rate Pixel WAV has a length the server can derive without decoding the audio.
  const pcm = createOpenAICompatibleTranscriptionProvider({...options, fetcher: async () => chatResponse(prose)});
  assert.deepEqual((await pcm.transcribe(pixelWav, wavContext())).segments, [{text: prose, startMs: 0, endMs: 20}]);
  // Content parts are the other shape a compatible server may return.
  const parts = createOpenAICompatibleTranscriptionProvider({...options,
    fetcher: async () => Response.json({choices: [{message: {content: [{type: 'text', text: '喂，'}, {type: 'text', text: '你好。'}]}}]})});
  assert.equal((await parts.transcribe(remote, context())).text, '喂，你好。');
});

test('OpenAI-compatible provider keeps salvaged words but never stores a half-kept JSON envelope', async () => {
  const invalid = (value: unknown) => createOpenAICompatibleTranscriptionProvider({...options, fetcher: async () => chatResponse(JSON.stringify(value))});
  for (const value of [
    {segments: [{startMs: '0', endMs: 900, text: '第一句'}, {startMs: 900, endMs: 1_800, text: '第二句'}]},
    {segments: [{startMs: 900, endMs: 100, text: '第一句'}, {startMs: 1_000, endMs: 1_800, text: '第二句'}]},
    {segments: [{startMs: 900, endMs: 1_800, text: '第二句'}, {startMs: 0, endMs: 500, text: '第一句'}]},
    {segments: [{startMs: 0, endMs: 900, text: '第一句'}, {startMs: 900, endMs: 90 * 60 * 60 * 1_000, text: '第二句'}]},
  ]) {
    const result = await invalid(value).transcribe(remote, context());
    assert.doesNotMatch(result.text, /segments|startMs/);
    assert.equal(result.segments?.length, 1);
    assert.equal(result.segments?.[0]?.startMs, 0);
  }
  // A different JSON shape keeps its words too, and still never its envelope.
  const flat = await invalid({text: '喂，你好。'}).transcribe(remote, context());
  assert.deepEqual(flat.segments, [{text: '喂，你好。', startMs: 0}]);
  // An unknown extra key is tolerated: the contract is the `segments` array, not the whole object.
  const extra = await invalid({segments: [{startMs: 0, endMs: 900, text: '第一句'}], note: 'ignored'}).transcribe(remote, context());
  assert.deepEqual(extra.segments, [{text: '第一句', startMs: 0, endMs: 900}]);
  // S78: the prompt's explicit no-speech answer is a result, not an error; the worker skips that track.
  const noSpeech = await invalid({segments: []}).transcribe(remote, context());
  assert.equal(noSpeech.text, ''); assert.deepEqual(noSpeech.segments, []);
  for (const empty of [{segments: [{startMs: 0, endMs: 1, text: '   '}]}, '   ']) {
    const provider = createOpenAICompatibleTranscriptionProvider({...options,
      fetcher: async () => chatResponse(typeof empty === 'string' ? empty : JSON.stringify(empty))});
    await assert.rejects(provider.transcribe(remote, context()), /no transcription/);
  }
});

test('OpenAI-compatible provider rejects truncated, unusable, ambiguous and oversized responses', async () => {
  const answer = (value: unknown, init?: ResponseInit) => createOpenAICompatibleTranscriptionProvider({...options,
    fetcher: async () => value instanceof Response ? value : Response.json(value, init)});
  await assert.rejects(answer({choices: [{finish_reason: 'length', message: {content: '半句话'}}]}).transcribe(remote, context()), /truncated/);
  await assert.rejects(answer({choices: [{finish_reason: 'content_filter', message: {content: '半句话'}}]}).transcribe(remote, context()), /unusable choice/);
  await assert.rejects(answer({choices: []}).transcribe(remote, context()), /no transcription/);
  await assert.rejects(answer({choices: [{message: {content: '一'}}, {message: {content: '二'}}]}).transcribe(remote, context()), /no transcription/);
  await assert.rejects(answer({choices: [{message: {content: 42}}]}).transcribe(remote, context()), /no transcription/);
  await assert.rejects(answer(new Response('x', {status: 200, headers: {'content-length': String(1024 * 1024 + 1)}})).transcribe(remote, context()), /too large/);
  await assert.rejects(answer(new Response('not json', {status: 200})).transcribe(remote, context()), /invalid JSON/);
});

test('OpenAI-compatible provider reuses the shared 429, HTTP error and input rules', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"message":"must-not-be-persisted"}}')); },
    cancel() { cancelled = true; },
  });
  const limited = createOpenAICompatibleTranscriptionProvider({...options, clock: () => new Date('2026-09-10T00:00:00.000Z'),
    fetcher: async () => new Response(body, {status: 429, headers: {'retry-after': '90'}})});
  await assert.rejects(limited.transcribe(remote, context()), (error: any) => {
    assert.ok(error instanceof TranscriptionProviderHttpError);
    assert.equal(error.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(error.retryAfterMs, 90_000);
    assert.doesNotMatch(error.message, /must-not-be-persisted/);
    return true;
  });
  assert.equal(cancelled, true);

  const deferred = createOpenAICompatibleTranscriptionProvider({...options, clock: () => new Date('2026-09-10T00:00:00.000Z'),
    fetcher: async () => new Response(null, {status: 429, headers: {'retry-after': '901'}})});
  await assert.rejects(deferred.transcribe(remote, context()), (error: any) => error.code === 'PROVIDER_RATE_LIMITED_DEFERRED' && error.retryable === false);

  const rejected = createOpenAICompatibleTranscriptionProvider({...options, fetcher: async () => new Response('private provider detail', {status: 400})});
  await assert.rejects(rejected.transcribe(remote, context()), (error: any) => {
    assert.ok(error instanceof TranscriptionProviderHttpError);
    assert.equal(error.code, 'PROVIDER_HTTP_ERROR');
    assert.equal(error.retryable, false);
    assert.equal(error.message, 'Transcription provider HTTP 400');
    return true;
  });

  let fetches = 0;
  const guarded = createOpenAICompatibleTranscriptionProvider({...options, timeoutMs: 10, fetcher: async (_input, init) => {
    fetches++;
    return new Promise((_resolve, reject) => { (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), {once: true}); });
  }});
  await assert.rejects(guarded.transcribe(Buffer.from('not ogg'), context()), /manifest v1 Ogg/);
  await assert.rejects(guarded.transcribe(Buffer.alloc(20 * 1024 * 1024 + 1), context()), /20 MiB/);
  await assert.rejects(guarded.transcribe(pixelWav, context()), /manifest v1 Ogg/);
  assert.equal(fetches, 0);
  // Each attempt has its own timeout, so a hung server costs both plans and then stops.
  await assert.rejects(guarded.transcribe(remote, context()), /attempt timed out/);
  assert.equal(fetches, 2);
  // A caller that cancels stops immediately, without spending the next plan.
  const stopping = new AbortController();
  const stopped = guarded.transcribe(remote, context(stopping.signal));
  stopping.abort(new Error('worker stopping'));
  await assert.rejects(stopped, /aborted|worker stopping/);
  assert.equal(fetches, 3);
});

test('OpenAI-compatible provider answers a stalled attempt with the plain prompt, then the fallback model', async () => {
  const sent: Array<{model: string; prompt: string}> = [];
  const record = (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({model: body.model, prompt: body.messages[0].content[0].text});
    assert.equal(body.messages[0].content[1].input_audio.format, 'ogg');
  };
  // The proxy's 60 s nginx cut looks like one 504 and the very next request succeeds.
  const gatewayTimeout = createOpenAICompatibleTranscriptionProvider({...options, fetcher: async (_input, init) => {
    record(init);
    return sent.length === 1 ? new Response('<html>504 Gateway Time-out</html>', {status: 504}) : chatResponse('喂，你好。\n请问是张先生吗？');
  }});
  const recovered = await gatewayTimeout.transcribe(remote, context());
  assert.equal(recovered.text, '喂，你好。请问是张先生吗？');
  assert.deepEqual(recovered.segments, [{text: '喂，你好。'}, {text: '请问是张先生吗？'}]);
  assert.deepEqual((recovered as any).attempts.map((attempt: any) => [attempt.model, attempt.prompt, attempt.status]),
    [['compatible-test', 'json', 504], ['compatible-test', 'plain', 200]]);
  assert.match(sent[0]!.prompt, /segments/);
  assert.match(sent[1]!.prompt, /只输出文字/);
  assert.doesNotMatch(sent[1]!.prompt, /segments/);

  // A hung connection, then an exhausted account, then the second model in the pool.
  const models: string[] = [];
  const exhausted = createOpenAICompatibleTranscriptionProvider({...options, fallbackModel: 'fallback-test', timeoutMs: 20,
    fetcher: async (_input, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      if (models.length === 1) return new Promise<Response>((_resolve, reject) => { (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), {once: true}); });
      if (models.length === 2) return new Response(null, {status: 502});
      return chatResponse(JSON.stringify({segments: [{startMs: 0, endMs: 500, text: '你好'}]}));
    }});
  const fellBack = await exhausted.transcribe(remote, context());
  assert.deepEqual(models, ['compatible-test', 'compatible-test', 'fallback-test']);
  assert.equal(fellBack.model, 'fallback-test');
  assert.deepEqual(fellBack.segments, [{text: '你好', startMs: 0, endMs: 500}]);
  assert.deepEqual((fellBack as any).attempts.map((attempt: any) => [attempt.model, attempt.prompt, attempt.status]),
    [['compatible-test', 'json', 'timeout'], ['compatible-test', 'plain', 502], ['fallback-test', 'json', 200]]);

  // A transport failure is a stall too.
  let transport = 0;
  const network = createOpenAICompatibleTranscriptionProvider({...options, fetcher: async () => {
    transport++;
    if (transport === 1) throw new TypeError('fetch failed');
    return chatResponse('喂。');
  }});
  assert.equal((await network.transcribe(remote, context())).text, '喂。');
  assert.equal(transport, 2);
});

test('OpenAI-compatible provider never spends a second attempt on rate limits or client errors', async () => {
  for (const status of [429, 400, 401, 404]) {
    let requests = 0;
    const provider = createOpenAICompatibleTranscriptionProvider({...options, fallbackModel: 'fallback-test',
      clock: () => new Date('2026-09-10T00:00:00.000Z'),
      fetcher: async () => { requests++; return new Response(null, {status, ...(status === 429 ? {headers: {'retry-after': '90'}} : {})}); }});
    await assert.rejects(provider.transcribe(remote, context()), (error: any) => {
      assert.ok(error instanceof TranscriptionProviderHttpError);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(requests, 1);
  }
  // A bad body is an answer, not a stall: it is not worth a second upload either.
  let answers = 0;
  const malformed = createOpenAICompatibleTranscriptionProvider({...options, fallbackModel: 'fallback-test',
    fetcher: async () => { answers++; return chatResponse('{"segments":[{"startMs":0,"endMs":1,"text":"  "}]}'); }});
  await assert.rejects(malformed.transcribe(remote, context()), /no transcription/);
  assert.equal(answers, 1);

  // All three stalled: the last error is what the worker sees, with its retry semantics intact.
  let stalls = 0;
  const exhausted = createOpenAICompatibleTranscriptionProvider({...options, fallbackModel: 'fallback-test',
    fetcher: async () => { stalls++; return new Response(null, {status: stalls === 3 ? 503 : 504}); }});
  await assert.rejects(exhausted.transcribe(remote, context()), (error: any) => {
    assert.ok(error instanceof TranscriptionProviderHttpError);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(stalls, 3);
});

test('OpenAI-compatible provider requires a fixed credential-free HTTPS base and an explicit model', () => {
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, baseURL: 'http://transcribe.example.test/v1'}), /HTTPS/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, baseURL: 'https://user:pass@transcribe.example.test/v1'}), /HTTPS/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, baseURL: 'https://transcribe.example.test/v1?key=leak'}), /HTTPS/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, baseURL: 'not a url'}), /base URL is invalid/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, model: ''}), /model is invalid/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, apiKey: ' '}), /not configured/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, maxTokens: 0}), /token limit is invalid/);
  assert.throws(() => createOpenAICompatibleTranscriptionProvider({...options, timeoutMs: 200_000}), /timeout is invalid/);
});

class FakeSource implements RecordingSource {
  opens = 0;
  constructor(private readonly value: RecordingManifest = manifest(), private readonly bytes: Buffer = remote) {}
  async manifest() { return this.value; }
  async openTrack(_callId: string, _track: RecordingTrack) {
    this.opens++;
    return {stream: Readable.from([this.bytes]), size: this.bytes.length, sha256: sha(this.bytes), complete: true, start: 0, end: this.bytes.length - 1, partial: false};
  }
}

function request(overrides: Partial<TrackReadRequest> = {}): TrackReadRequest {
  const frozen = freezeRecordingManifest(manifest(), callId);
  return {
    callId, snapshotOwnerId: ownerId, manifestFingerprint: frozen.fingerprint,
    track: 'remote_original', name: 'remote_original.ogg', mediaType: 'audio/ogg', formatVersion: 1,
    expectedBytes: remote.length, expectedSha256: sha(remote), signal: new AbortController().signal,
    ...overrides,
  };
}

test('registry reader fences immutable owner/node/epoch and verifies full Ogg bytes', async () => {
  const routedManifest = {...manifest(), nodeId: 'gz1', mediaEpoch: 7};
  const source = new FakeSource(routedManifest);
  const fixed: unknown[] = [];
  const db = {query: async () => ({rowCount: 1, rows: [{media_node_id: 'gz1', media_epoch: '7'}]})};
  const reader = new RegistryRecordingReader(db as never, (value) => { fixed.push(value); return source; });
  assert.deepEqual(await reader.readTrack(request({manifestFingerprint: freezeRecordingManifest(routedManifest, callId).fingerprint})), remote);
  assert.deepEqual(fixed, [{nodeId: 'gz1', mediaEpoch: 7}]);
  assert.equal(source.opens, 1);
});

test('registry reader rejects owner, limit, fingerprint, and Ogg mismatches before provider', async () => {
  let resolutions = 0;
  const missingOwner = new RegistryRecordingReader({query: async () => ({rowCount: 0, rows: []})} as never, () => { resolutions++; return new FakeSource(); });
  await assert.rejects(missingOwner.readTrack(request()), (error: any) => error.code === 'CALL_OWNER_MISMATCH');
  assert.equal(resolutions, 0);

  let dbQueries = 0;
  const oversized = new RegistryRecordingReader({query: async () => { dbQueries++; return {rowCount: 1, rows: []}; }} as never, () => new FakeSource());
  await assert.rejects(oversized.readTrack(request({expectedBytes: 20 * 1024 * 1024 + 1})), (error: any) => error.code === 'RECORDING_TOO_LARGE');
  assert.equal(dbQueries, 0);

  const db = {query: async () => ({rowCount: 1, rows: [{media_node_id: 'relay-primary', media_epoch: 1}]})};
  const wrongFingerprint = new FakeSource();
  await assert.rejects(new RegistryRecordingReader(db as never, () => wrongFingerprint).readTrack(request({manifestFingerprint: 'b'.repeat(64)})), (error: any) => error.code === 'RECORDING_CONTRACT_MISMATCH');
  assert.equal(wrongFingerprint.opens, 0);

  const badBytes = Buffer.from('BAD! same-shape');
  const badManifest = manifest();
  badManifest.artifacts[0] = {name: 'remote_original.ogg', bytes: badBytes.length, sha256: sha(badBytes)};
  const badSource = new FakeSource(badManifest, badBytes);
  const badRequest = request({manifestFingerprint: freezeRecordingManifest(badManifest, callId).fingerprint, expectedBytes: badBytes.length, expectedSha256: sha(badBytes)});
  await assert.rejects(new RegistryRecordingReader(db as never, () => badSource).readTrack(badRequest), (error: any) => error instanceof TranscriptRecordingReaderError && error.code === 'RECORDING_CONTRACT_MISMATCH');
});

test('registry reader honors cancellation before any database or source I/O', async () => {
  const controller = new AbortController(); controller.abort();
  let queries = 0;
  const reader = new RegistryRecordingReader({query: async () => { queries++; return {rowCount: 1, rows: []}; }} as never, () => new FakeSource());
  await assert.rejects(reader.readTrack(request({signal: controller.signal})), (error: any) => error.code === 'ABORTED');
  assert.equal(queries, 0);
});
