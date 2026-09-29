import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { loadConfig, passkeyOrigins } from '../src/config.js';

const androidOrigin = `android:apk-key-hash:${'A'.repeat(43)}`;
const base = { DATABASE_URL: 'unused-test-database', COOKIE_SECRET: 'test-only-cookie-secret-at-least-32-characters', PUBLIC_ORIGIN: 'https://vodog.test', RP_ID: 'vodog.test' };
function assertion(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  const id = randomBytes(32).toString('base64url');
  const challenge = randomBytes(32).toString('base64url');
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
  const authenticator = Buffer.alloc(37);
  createHash('sha256').update(base.RP_ID).digest().copy(authenticator);
  authenticator[32] = 5; // UP and UV, synthetic authenticator for verifier regression only.
  authenticator.writeUInt32BE(1, 33);
  const signature = sign('sha256', Buffer.concat([authenticator, createHash('sha256').update(client).digest()]), privateKey);
  return {
    response: { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: authenticator.toString('base64url'), signature: signature.toString('base64url'),
    } },
    credential: { id, publicKey: key, counter: 0 }, expectedChallenge: challenge, expectedRPID: base.RP_ID, requireUserVerification: true,
  };
}

test('only explicitly configured Android signing origins can authenticate', async () => {
  const config = loadConfig({ ...base, ANDROID_PASSKEY_ORIGINS: androidOrigin });
  for (const origin of [base.PUBLIC_ORIGIN, androidOrigin]) {
    const result = await verifyAuthenticationResponse({ ...assertion(origin), expectedOrigin: passkeyOrigins(config) });
    assert.equal(result.verified, true);
    assert.equal(result.authenticationInfo.userVerified, true);
  }
  await assert.rejects(verifyAuthenticationResponse({ ...assertion(`android:apk-key-hash:${'B'.repeat(43)}`), expectedOrigin: passkeyOrigins(config) }), /origin/i);
  await assert.rejects(verifyAuthenticationResponse({ ...assertion(androidOrigin), expectedOrigin: passkeyOrigins(loadConfig(base)) }), /origin/i);
});

test('Android signing origin configuration rejects web origins, wildcard and malformed hashes', () => {
  for (const value of ['*', 'https://evil.test', 'android:apk-key-hash:short', `${androidOrigin},https://evil.test`]) {
    assert.throws(() => loadConfig({ ...base, ANDROID_PASSKEY_ORIGINS: value }));
  }
});
