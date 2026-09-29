import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import {enqueueSmsBatch} from '../src/sms-send.ts';
import type {ApiRequest} from '../src/contacts.ts';
import {callErrorMessage} from '../src/media-policy.ts';

/** Execute the actual main api transport without mounting the app or connecting to any server. */
async function mainTransport(fetch: typeof globalThis.fetch): Promise<ApiRequest> {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = parsed.statements.filter(statement =>
    (ts.isFunctionDeclaration(statement) && statement.name?.text === 'api') ||
    (ts.isClassDeclaration(statement) && statement.name?.text === 'ApiFailure'));
  assert.equal(declarations.length, 2, 'transport and its error class must come from actual main source');
  const script = ts.transpileModule(declarations.map(node => node.getText(parsed)).join('\n'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
  }).outputText;
  return new Function('fetch', 'browserSessionGeneration', 'expireBrowserSession', 'diag', 'callErrorMessage', `${script};return api;`)(
    fetch, () => 0, () => {}, {log() {}}, callErrorMessage,
  ) as ApiRequest;
}

test('actual main transport sends strict batch JSON with header-only stable key after 503', async () => {
  const wires: {url: string; options: RequestInit}[] = [];
  const request = await mainTransport(async (url, options) => {
    wires.push({url: String(url), options: options!});
    const body = JSON.parse(options!.body as string);
    // Match the real route strict object boundary: no idempotencyKey field is accepted.
    assert.deepEqual(Object.keys(body).sort(), ['body', 'recipients', 'simId']);
    assert.deepEqual(body, {simId: '550e8400-e29b-41d4-a716-446655440000', recipients: ['10086', '10010'], body: 'hello'});
    assert.ok(new Headers(options!.headers).get('Idempotency-Key'));
    return wires.length === 1
      ? new Response(JSON.stringify({error: {code: 'UNAVAILABLE', message: 'retry later'}}), {status: 503})
      : new Response(JSON.stringify({batchId: 'batch', intervalSeconds: 5, items: [{id: '1'}, {id: '2'}]}), {status: 202});
  });
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
  const send = {request, storage, account: 'wire-account', simId: '550e8400-e29b-41d4-a716-446655440000', recipients: ['10086', '10010'], body: 'hello'};
  await assert.rejects(enqueueSmsBatch(send), /retry later/);
  const result = await enqueueSmsBatch(send);
  assert.equal(result.batchId, 'batch');
  assert.equal(wires.length, 2);
  assert.equal(wires[0].url, '/api/v1/sms/batch');
  assert.equal(wires[0].options.method, 'POST');
  assert.equal(wires[0].options.credentials, 'include');
  assert.equal(wires[0].options.body, wires[1].options.body);
  assert.equal(new Headers(wires[0].options.headers).get('Idempotency-Key'), new Headers(wires[1].options.headers).get('Idempotency-Key'));
});

test('existing single SMS body/header transport remains unchanged', async () => {
  let wire!: RequestInit;
  const request = await mainTransport(async (_url, options) => {wire = options!;return new Response('{}');});
  const body = {simId: 'sim', remoteNumber: '10086', body: 'single', idempotencyKey: 'existing-key'};
  await request('/sms/outbound', body);
  assert.deepEqual(JSON.parse(wire.body as string), body);
  assert.equal(new Headers(wire.headers).get('Idempotency-Key'), 'existing-key');
});
