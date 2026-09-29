import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTERCEPTION_PREVIEW_LIMIT,
  interceptionKindLabel,
  interceptionPreview,
  interceptionRow,
  interceptionSourceLabel,
  interceptionTitle,
  sortInterceptions,
  type InterceptionItem,
} from '../src/interceptions.ts';

const call: InterceptionItem = {
  id: 'i-1',
  kind: 'call',
  simId: 'sim-1',
  remoteNumber: '2025550117',
  contactId: 'c-1',
  contactName: '张三',
  occurredAt: '2026-09-11T10:00:00.000Z',
  bodyPreview: null,
  blockedEntryId: 'entry-1',
  source: 'gateway',
};

test('an intercepted call row names the kind, the number and the contact', () => {
  const row = interceptionRow(call);
  assert.equal(row.kindLabel, '来电');
  assert.equal(row.title, '2025550117 · 张三');
  assert.equal(row.preview, '');
  assert.equal(row.sourceLabel, '网关拦截');
  assert.equal(row.blocked, true);
  assert.equal(row.blockedEntryId, 'entry-1');
  assert.equal(row.contactId, 'c-1');
  assert.equal(row.simId, 'sim-1');
  assert.equal(row.occurredAt, '2026-09-11T10:00:00.000Z');
});

test('an intercepted SMS shows a single-line preview capped at the contract length', () => {
  const long = '促'.repeat(INTERCEPTION_PREVIEW_LIMIT + 40);
  const row = interceptionRow({
    ...call,
    id: 'i-2',
    kind: 'sms',
    contactName: null,
    contactId: null,
    source: 'control',
    bodyPreview: `  优惠\n 活动 \t${long}`,
  });
  assert.equal(row.kindLabel, '短信');
  assert.equal(row.title, '2025550117', 'an unknown number shows without a name');
  assert.equal(row.sourceLabel, '服务器拦截');
  assert.equal(row.preview.startsWith('优惠 活动 促'), true, 'newlines and tabs collapse to single spaces');
  assert.equal(row.preview.length, INTERCEPTION_PREVIEW_LIMIT + 1, 'an over-long body is truncated with an ellipsis');
  assert.equal(row.preview.endsWith('…'), true);
  assert.equal(row.blocked, false, 'S66: an SMS entry id never reaches the call-scoped card');
  assert.equal(row.blockedEntryId, null);
});

test('an interception without an entry id still renders but cannot offer 解除屏蔽', () => {
  const row = interceptionRow({
    id: 'i-3',
    kind: 'call',
    occurredAt: '2026-09-10T00:00:00.000Z',
    remoteNumber: '',
    blockedEntryId: null,
  });
  assert.equal(row.title, '未知号码');
  assert.equal(row.blocked, false);
  assert.equal(row.blockedEntryId, null);
  assert.equal(row.remoteNumber, '');
  assert.equal(row.sourceLabel, '', 'an old server that omits the source shows no badge');
  // S38：拦截猫在手机上直接挡下的来电/短信。
  assert.equal(interceptionSourceLabel('phone'), '手机自动拦截');
  assert.equal(interceptionKindLabel('mystery'), '拦截');
  assert.equal(interceptionSourceLabel(undefined), '');
  assert.equal(interceptionTitle({id: 'x', kind: 'sms', occurredAt: '', remoteNumber: '400', contactName: '推销'}), '400 · 推销');
});

test('interceptions are shown newest first even when the response is unsorted', () => {
  const items: InterceptionItem[] = [
    {id: 'b', kind: 'sms', occurredAt: '2026-09-09T00:00:00.000Z'},
    {id: 'a', kind: 'call', occurredAt: '2026-09-11T00:00:00.000Z'},
    {id: 'c', kind: 'call', occurredAt: '2026-09-11T00:00:00.000Z'},
  ];
  assert.deepEqual(sortInterceptions(items).map(item => item.id), ['a', 'c', 'b']);
  assert.deepEqual(items.map(item => item.id), ['b', 'a', 'c'], 'the input list is not mutated');
  assert.deepEqual(sortInterceptions([]), []);
});
