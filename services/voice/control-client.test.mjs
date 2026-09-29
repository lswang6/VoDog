import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { VoiceControlClient } from './control-client.mjs';

const options = () => ({ token: 'service'.repeat(8), instanceId: randomUUID() });

test('Control requires HTTPS off loopback', () => {
  for (const baseUrl of ['http://127.0.0.1:16880', 'http://[::1]:16880', 'https://control.example.com']) {
    assert.equal(new VoiceControlClient({ baseUrl, ...options() }).baseUrl, new URL(baseUrl).origin);
  }
  for (const baseUrl of ['http://192.0.2.31:16880', 'http://192.0.2.32:16880', 'http://192.0.2.22:16880', 'http://127.0.0.1:16880/x', 'http://user@127.0.0.1:16880']) {
    assert.throws(() => new VoiceControlClient({ baseUrl, ...options() }), /loopback/, baseUrl);
  }
});
