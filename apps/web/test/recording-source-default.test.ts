import test from 'node:test';
import assert from 'node:assert/strict';
import {preferPixelSource,serverRecordingLabel} from '../src/recording-contract.ts';

test('S94b default recording source and label', () => {
  assert.equal(preferPixelSource({}), false);
  assert.equal(preferPixelSource({originatingPlatform:'web',ownerJoinedLocal:false}), false);
  assert.equal(preferPixelSource({originatingPlatform:'pixel'}), true);
  assert.equal(preferPixelSource({originatingPlatform:'ios',ownerJoinedLocal:true}), true);
  assert.equal(serverRecordingLabel(), '服务器录音');
  assert.equal(serverRecordingLabel(true), '服务器录音（不含本机接入）');
});
