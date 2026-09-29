import assert from 'node:assert/strict';
import test from 'node:test';
import {assertIanaTimeZone} from '../src/report-window.js';

test('heartbeat IANA check accepts Area/City zones and rejects offsets and Asia/Beijing', () => {
  assert.doesNotThrow(() => assertIanaTimeZone('Asia/Shanghai'));
  assert.doesNotThrow(() => assertIanaTimeZone('Asia/Taipei'));
  assert.doesNotThrow(() => assertIanaTimeZone('America/New_York'));
  for (const zone of ['Asia/Beijing', 'asia/beijing', '+08:00', '-08:00', 'UTC', 'GMT', 'UTC+08:00']) {
    assert.throws(() => assertIanaTimeZone(zone), RangeError);
  }
});
