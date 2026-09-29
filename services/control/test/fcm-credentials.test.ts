import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFcmAccessTokenProvider, serviceAccountTokenProvider } from '../src/fcm-credentials.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { type: 'service_account', project_id: 'vodog-test',
  client_email: 'sender@vodog-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const response = () => new Response(JSON.stringify({ access_token: 'safe-test-token-123456', token_type: 'Bearer', expires_in: 3600 }));

test('FCM signs correct scoped assertion, shares refresh, caches then refreshes', async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const provider = serviceAccountTokenProvider('vodog-test', credentials, (async (url, init) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init?.redirect, 'error');
    const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
    const [header, payload, signature] = assertion.split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature!, 'base64url')), true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.aud, url);
    assert.equal(claims.exp - claims.iat, 3600);
    return response();
  }) as typeof fetch, () => now);
  await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
  assert.equal(calls, 1);
  await provider.getAccessToken();
  assert.equal(calls, 1);
  now += 3_541_000;
  await provider.getAccessToken();
  assert.equal(calls, 2);
});

test('cancelling one FCM waiter preserves another delivery refresh', async () => {
  let release!: (value: Response) => void;
  const provider = serviceAccountTokenProvider('vodog-test', credentials,
    (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch);
  const controller = new AbortController();
  const first = provider.getAccessToken(controller.signal);
  const second = provider.getAccessToken();
  controller.abort();
  await assert.rejects(first, /cancelled/);
  release(response());
  assert.equal(await second, 'safe-test-token-123456');
});

test('FCM rejects wrong project and sanitizes remote errors without caching failures', async () => {
  assert.throws(() => serviceAccountTokenProvider('wrong-project', credentials), /identity/);
  let attempts = 0;
  const provider = serviceAccountTokenProvider('vodog-test', credentials, (async () => {
    if (++attempts === 1) throw new Error('sensitive-token-value');
    return response();
  }) as typeof fetch);
  await assert.rejects(provider.getAccessToken(), error => String(error) === 'Error: FCM OAuth token refresh failed');
  assert.equal(await provider.getAccessToken(), 'safe-test-token-123456');
});

test('FCM rejects malformed, oversized and redirect responses', async () => {
  for (const bad of [
    () => new Response(JSON.stringify({ access_token: 'bad\r\nvalue', token_type: 'Bearer', expires_in: 3600 })),
    () => new Response('x'.repeat(17000)),
    () => new Response('', { status: 302, headers: { location: 'https://untrusted.example/' } }),
  ]) {
    const provider = serviceAccountTokenProvider('vodog-test', credentials, (async () => bad()) as typeof fetch);
    await assert.rejects(provider.getAccessToken(), /refresh failed/);
  }
});

test('FCM private-file loader rejects permissive modes and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-fcm-test-'));
  const path = join(directory, 'credentials.json');
  try {
    await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
    assert.ok(await createFcmAccessTokenProvider('vodog-test', path));
    await chmod(path, 0o644);
    await assert.rejects(createFcmAccessTokenProvider('vodog-test', path), /private regular file/);
    await chmod(path, 0o600);
    await symlink(path, join(directory, 'alias.json'));
    await assert.rejects(createFcmAccessTokenProvider('vodog-test', join(directory, 'alias.json')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
