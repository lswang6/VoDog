import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_ATTEMPT_LIMIT,
  AuthAttemptLimiter,
  crowdsecAuthFailLine,
  emitCrowdsecAuthFail,
  sanitizeClientIp,
  usernameHashForLog,
} from '../src/auth-attempts.js';

test('crowdsec auth fail line never includes username or password material', () => {
  const username = 'owner@example.test';
  const line = crowdsecAuthFailLine({ip: '203.0.113.9', type: 'password', username});
  assert.match(line, /^crowdsec_auth_fail service=vodog-auth type=password ip=203\.0\.113\.9 username_hash=[0-9a-f]{16}\n$/);
  assert.equal(line.includes(username), false);
  assert.equal(line.includes('username='), false);
  assert.equal(line.includes('password='), false);
  assert.equal(usernameHashForLog(username), usernameHashForLog('OWNER@example.test'));
});

test('client IP is constrained to address characters', () => {
  assert.equal(sanitizeClientIp('2001:db8::1'), '2001:db8::1');
  assert.equal(sanitizeClientIp('192.0.2.21; rm -rf /'), 'unknown');
  assert.equal(sanitizeClientIp(''), 'unknown');
});

test('auth limiter keeps the 5-per-15-minute gate', () => {
  let now = 1_000;
  const limiter = new AuthAttemptLimiter(new Map(), () => now);
  for (let i = 0; i < AUTH_ATTEMPT_LIMIT; i++) limiter.recordFailure('192.0.2.1', 'user@example.test');
  assert.equal(limiter.blocked('192.0.2.1', 'user@example.test'), true);
  assert.equal(limiter.blocked('192.0.2.1', 'other@example.test'), false);
  now += 15 * 60_000 + 1;
  assert.equal(limiter.blocked('192.0.2.1', 'user@example.test'), false);
});

test('emitCrowdsecAuthFail writes the parseable line', () => {
  const chunks: string[] = [];
  emitCrowdsecAuthFail({ip: '198.51.100.7', type: 'passkey', username: 'a@b.test'}, (chunk) => chunks.push(chunk));
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /type=passkey/);
  assert.equal(chunks[0].includes('a@b.test'), false);
});
