import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptSettingsMutation} from '../src/settings-mutations.ts';

test('an accepted settings write returns its authoritative CAS snapshot when the follow-up dashboard read fails', async () => {
  const refreshFailure = new Error('temporary GET /sims failure');
  const reported: unknown[] = [];
  const accepted = await acceptSettingsMutation(
    async () => ({version: 8, label: '已保存名称'}),
    async () => { throw refreshFailure; },
    error => reported.push(error),
  );
  assert.deepEqual(accepted, {version: 8, label: '已保存名称'});
  assert.deepEqual(reported, [refreshFailure]);
});
