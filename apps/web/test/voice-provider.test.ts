import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VOICE_PROVIDER_FOOTER,
  voiceProviderAvailability,
  voiceProviderDisabledReason,
  voiceProviderErrorMessage,
  voiceProviderLabel,
  voiceProviderList,
  voiceProviderSelectable,
  voiceProviderSelected,
  voiceProviderShouldSubmit,
  voiceProviderStatusLabel,
  type VoiceProviderDto,
} from '../src/voice-provider.ts';

/**
 * S24 决策 3. iOS (`S24ClientPolicyTests.swift`) 是参考实现；这里逐条对齐同样的断言，Android 的
 * `S24ClientPolicyTest.kt` 同理。
 */
const ready: VoiceProviderDto = {id: 'xai', label: 'xAI Grok', configured: true, online: true};
const unconfigured: VoiceProviderDto = {id: 'doubao', label: '豆包', configured: false, online: false};

test('the contract response parses into a list and a selection', () => {
  const list = voiceProviderList({items: [ready, unconfigured], selected: 'xai'});
  assert.equal(list.selected, 'xai');
  assert.deepEqual(list.items, [ready, unconfigured]);
});

test('a missing or partial payload reads as an empty, unselected list', () => {
  assert.deepEqual(voiceProviderList(undefined), {items: [], selected: '', configVersion: 1});
  assert.deepEqual(voiceProviderList({}), {items: [], selected: '', configVersion: 1});
  assert.deepEqual(voiceProviderList({items: [], selected: null}), {items: [], selected: '', configVersion: 1});
  // Entries without an id cannot be rendered as a radio at all.
  assert.deepEqual(voiceProviderList({items: [{id: ''} as VoiceProviderDto]}), {items: [], selected: '', configVersion: 1});
});

test('missing flags decode as 未配置 rather than as selectable', () => {
  const partial: VoiceProviderDto = {id: 'xai'};
  assert.equal(voiceProviderAvailability(partial), 'not_configured');
  assert.equal(voiceProviderStatusLabel(partial), '未配置');
  assert.equal(voiceProviderSelectable(partial), false);
});

test('the two flags map to exactly three labels', () => {
  assert.equal(voiceProviderStatusLabel(ready), '可用');
  assert.equal(voiceProviderStatusLabel({...ready, online: false}), '服务离线');
  assert.equal(voiceProviderStatusLabel(unconfigured), '未配置');
});

test('未配置 outranks 服务离线 even when a worker announces the provider', () => {
  const announced = {...unconfigured, online: true};
  assert.equal(voiceProviderAvailability(announced), 'not_configured');
  assert.equal(voiceProviderStatusLabel(announced), '未配置');
  assert.equal(voiceProviderSelectable(announced), false);
});

test('an unavailable row carries its reason as a subtitle', () => {
  assert.equal(voiceProviderDisabledReason(ready), '');
  assert.equal(voiceProviderDisabledReason(unconfigured), '服务器未配置这个语音服务');
  assert.equal(voiceProviderDisabledReason({...ready, online: false}), '语音服务当前离线，暂时无法切换');
});

test('a blank label falls back to the id', () => {
  assert.equal(voiceProviderLabel(ready), 'xAI Grok');
  assert.equal(voiceProviderLabel({id: 'xai', label: '   '}), 'xai');
  assert.equal(voiceProviderLabel({id: 'xai'}), 'xai');
});

test('the selected provider keeps its checkmark even while it is offline', () => {
  const offline = {...ready, online: false};
  assert.equal(voiceProviderSelected(offline, 'xai'), true, '服务器上的选择仍然是它');
  assert.equal(voiceProviderSelectable(offline), false, '但这一行不能点');
  assert.equal(voiceProviderShouldSubmit(offline, 'xai'), false);
});

test('no checkmark when the server sends no selection', () => {
  assert.equal(voiceProviderSelected(ready, ''), false);
  assert.equal(voiceProviderSelected(ready, null), false);
  assert.equal(voiceProviderSelected(ready, undefined), false);
});

test('tapping the current selection is a no-op', () => {
  assert.equal(voiceProviderShouldSubmit(ready, 'xai'), false, '不重复写审计');
  assert.equal(voiceProviderShouldSubmit({...unconfigured, configured: true, online: true}, 'xai'), true);
  assert.equal(voiceProviderShouldSubmit(ready, ''), true);
});

test('unavailable rows never submit', () => {
  assert.equal(voiceProviderShouldSubmit(unconfigured, 'xai'), false);
  assert.equal(voiceProviderShouldSubmit({...unconfigured, configured: true}, 'xai'), false);
});

test('the server message is shown first and the code is only a fallback', () => {
  assert.equal(
    voiceProviderErrorMessage('PROVIDER_UNAVAILABLE', '豆包尚未配置，无法切换。'),
    '豆包尚未配置，无法切换。',
  );
  assert.equal(
    voiceProviderErrorMessage('PROVIDER_UNAVAILABLE', '  '),
    '这个语音服务当前不可用（未配置或服务离线），已保留原来的选择。',
  );
  assert.equal(voiceProviderErrorMessage('', ''), '切换语音服务失败，请稍后重试。');
  assert.equal(voiceProviderErrorMessage(null, null), '切换语音服务失败，请稍后重试。');
});

test('the footer explains what the switch affects', () => {
  assert.equal(VOICE_PROVIDER_FOOTER, '切换只影响之后的 AI 即接 / 超时代接来电。');
});
