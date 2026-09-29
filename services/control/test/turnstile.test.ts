import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { verifyTurnstileToken } from '../src/turnstile.js';

const base = {
  DATABASE_URL: 'unused-test-database',
  COOKIE_SECRET: 'test-only-cookie-secret-at-least-32-characters',
  PUBLIC_ORIGIN: 'https://vodog.test',
  RP_ID: 'vodog.test',
};
const secret = '0x4AAAAAAAtest-secret-key-0000000000';
// Cloudflare's documented "always passes" test secret; the widget test key is 1x00000000000000000000AA.
const alwaysPasses = '1x0000000000000000000000000000000AA';

test('Turnstile stays off by default and requires both keys when enabled', () => {
  assert.equal(loadConfig(base).TURNSTILE_ENABLED, false);
  assert.equal(loadConfig({ ...base, TURNSTILE_ENABLED: 'false', TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' }).TURNSTILE_ENABLED, false);
  assert.throws(() => loadConfig({ ...base, TURNSTILE_ENABLED: 'true', TURNSTILE_SECRET_KEY: secret }), /TURNSTILE_SITE_KEY/);
  assert.throws(() => loadConfig({ ...base, TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }), /TURNSTILE_SECRET_KEY/);
  const enabled = loadConfig({ ...base, TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: secret });
  assert.equal(enabled.TURNSTILE_ENABLED, true);
  assert.equal(enabled.TURNSTILE_SITE_KEY, '1x00000000000000000000AA');
});

test('siteverify posts the documented form body and accepts a successful challenge', async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const result = await verifyTurnstileToken('token-abc', '203.0.113.7', {
    secret,
    fetcher: async (input, init) => {
      request = { url: String(input), init: init! };
      return Response.json({ success: true, hostname: 'vodog.test', action: '' });
    },
  });
  assert.deepEqual(result, { success: true });
  assert.equal(request?.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(request?.init.method, 'POST');
  assert.equal(request?.init.redirect, 'error');
  const body = new URLSearchParams(String(request?.init.body));
  assert.equal(body.get('secret'), secret);
  assert.equal(body.get('response'), 'token-abc');
  assert.equal(body.get('remoteip'), '203.0.113.7');
});

test('siteverify rejects a used, failed or missing token without leaking the secret', async () => {
  const failed = await verifyTurnstileToken('spent', undefined, {
    secret,
    fetcher: async () => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
  });
  assert.deepEqual(failed, { success: false, error: 'verification-failed', codes: ['timeout-or-duplicate'] });
  assert.equal(JSON.stringify(failed).includes(secret), false);

  for (const token of [undefined, null, '', '   ', 42, 'x'.repeat(4_097)]) {
    let called = false;
    const result = await verifyTurnstileToken(token, undefined, { secret, fetcher: async () => { called = true; return Response.json({ success: true }); } });
    assert.equal(result.success, false);
    assert.equal(called, false, 'invalid input must never reach Cloudflare');
  }
});

test('siteverify fails closed on upstream errors, hostname or action mismatch and timeouts', async () => {
  const upstream = await verifyTurnstileToken('token', undefined, { secret, fetcher: async () => new Response('nope', { status: 502 }) });
  assert.deepEqual(upstream, { success: false, error: 'upstream-502' });

  const hostname = await verifyTurnstileToken('token', undefined, { secret, expectedHostname: 'vodog.test', fetcher: async () => Response.json({ success: true, hostname: 'evil.test' }) });
  assert.deepEqual(hostname, { success: false, error: 'hostname-mismatch' });

  const action = await verifyTurnstileToken('token', undefined, { secret, expectedAction: 'login', fetcher: async () => Response.json({ success: true, hostname: 'vodog.test', action: 'other' }) });
  assert.deepEqual(action, { success: false, error: 'action-mismatch' });

  const unreachable = await verifyTurnstileToken('token', undefined, { secret, fetcher: async () => { throw new Error('socket hang up'); } });
  assert.deepEqual(unreachable, { success: false, error: 'unreachable' });

  const timedOut = await verifyTurnstileToken('token', undefined, { secret, fetcher: async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; } });
  assert.deepEqual(timedOut, { success: false, error: 'timeout' });

  const unconfigured = await verifyTurnstileToken('token', undefined, { secret: '' });
  assert.deepEqual(unconfigured, { success: false, error: 'turnstile-not-configured' });

  // The documented always-passes test secret only changes Cloudflare's answer, never local validation.
  const documented = await verifyTurnstileToken('token', undefined, { secret: alwaysPasses, fetcher: async () => Response.json({ success: true, hostname: 'vodog.test' }) });
  assert.deepEqual(documented, { success: true });
});
