import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HISTORY_ACTION_COPY,
  canBlock,
  canRedial,
  canSendSMS,
  isEmergencyServiceNumber,
  normalizedDialNumber,
} from '../src/history-actions.ts';
import {CONTACT_BLOCK_PROMPT} from '../src/contacts.ts';

test('history row actions disable when remote or SIM is missing and when media is live', () => {
  assert.equal(canRedial(undefined, 'sim', false), false);
  assert.equal(canRedial('2025550111', undefined, false), false);
  assert.equal(canRedial('2025550111', 'sim', true), false);
  assert.equal(canRedial('2025550111', 'sim', false), true);
  assert.equal(canSendSMS(undefined, 'sim'), false);
  assert.equal(canSendSMS('2025550111', 'sim'), true);
  assert.equal(canBlock(undefined), false);
  assert.equal(canBlock('112'), false);
  assert.equal(canBlock('911'), false);
  assert.equal(canBlock('2025550111'), true);
  assert.equal(HISTORY_ACTION_COPY.redial, '回拨');
  assert.equal(HISTORY_ACTION_COPY.sms, '发短信');
  // S22 决策 10: one verb, 屏蔽, and the confirmation is the 联系人卡片's own prompt.
  assert.equal(HISTORY_ACTION_COPY.block, '屏蔽');
  assert.equal(HISTORY_ACTION_COPY.blockNow, '立即屏蔽');
  assert.equal(HISTORY_ACTION_COPY.blocked, '已屏蔽');
  assert.equal(HISTORY_ACTION_COPY.blockConfirm, '确认屏蔽');
  assert.equal(HISTORY_ACTION_COPY.blockPrompt, CONTACT_BLOCK_PROMPT);
  assert.match(HISTORY_ACTION_COPY.blockPrompt, /^屏蔽此号码的来电？/);
  assert.doesNotMatch(Object.values(HISTORY_ACTION_COPY).join(' '), /拉黑/);
});

test('dial number normalization keeps service digits and rejects emergency block', () => {
  assert.equal(normalizedDialNumber(' +1 202-555-0111 '), '+12025550111');
  assert.equal(isEmergencyServiceNumber('112'), true);
  assert.equal(isEmergencyServiceNumber('+911'), true);
  assert.equal(isEmergencyServiceNumber('2025550111'), false);
});
