import assert from 'node:assert/strict';
import test from 'node:test';
import {DialTone,DTMF_FREQUENCIES,dtmfToneFrequencies} from '../src/dial-tone.ts';

test('dialpad keys map to the standard DTMF frequency pairs', () => {
 assert.deepEqual(dtmfToneFrequencies('1'),[697,1209]);
 assert.deepEqual(dtmfToneFrequencies('5'),[770,1336]);
 assert.deepEqual(dtmfToneFrequencies('0'),[941,1336]);
 assert.deepEqual(dtmfToneFrequencies('*'),[941,1209]);
 assert.deepEqual(dtmfToneFrequencies('#'),[941,1477]);
 assert.equal(Object.keys(DTMF_FREQUENCIES).length,12);
});

test('keys without a DTMF pair stay silent', () => {
 for (const key of ['+','','x','12']) assert.equal(dtmfToneFrequencies(key),null);
 const tone = new DialTone();
 assert.equal(tone.play('+'),false);
 assert.equal(tone.play('1'),false);
});

test('a muted dial tone never plays', () => {
 const tone = new DialTone();
 tone.setEnabled(false);
 assert.equal(tone.play('7'),false);
 assert.equal(tone.supported,false);
});
