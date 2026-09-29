import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESIRED_POWER_EXPIRY_MS,
  GATEWAY_POWER_REFRESH_MS,
  gatewayPowerErrorMessage,
  gatewayPowerPending,
  gatewayPowerPendingLabel,
  gatewayPowerStatus,
  gatewayPowerStatusLabel,
  gatewayPowerToggle,
  lastPowerResultText,
  powerResultReasonText,
  remotePowerAllowedLabel,
  type GatewayPowerDto,
} from '../src/gateway-power.ts';

const now = Date.parse('2026-09-11T12:00:00.000Z');
const base: GatewayPowerDto = {gatewayId: 'gw-1', name: '家里的 Pixel', remotePowerAllowed: true};

test('online, standby and offline are three distinct states', () => {
  assert.equal(gatewayPowerStatus({...base, online: true, standbyOnline: false}), 'online');
  assert.equal(gatewayPowerStatusLabel({...base, online: true}), '在线');
  assert.equal(gatewayPowerStatusLabel({...base, online: false, standbyOnline: true}), '待命中');
  assert.equal(gatewayPowerStatusLabel({...base, online: true, standbyOnline: true}), '在线', 'a heartbeat outranks the beacon');
  assert.equal(gatewayPowerStatusLabel(base), '离线');
  assert.equal(gatewayPowerStatusLabel({gatewayId: 'gw-2'}), '离线', 'an old server sends no flags at all');
  assert.equal(remotePowerAllowedLabel({...base, remotePowerAllowed: true}), '远程开启已允许');
  assert.equal(remotePowerAllowedLabel({gatewayId: 'gw-2'}), '远程开启未允许（需在网关设备上打开）');
  assert.equal(GATEWAY_POWER_REFRESH_MS, 5000);
});

test('a queued power request expires after two minutes', () => {
  const requested = new Date(now - 30_000).toISOString();
  assert.equal(gatewayPowerPending({...base, desiredPower: 'on', desiredPowerRequestedAt: requested}, now), true);
  assert.equal(gatewayPowerPendingLabel({...base, desiredPower: 'on', desiredPowerRequestedAt: requested}, now), '正在开启…');
  assert.equal(gatewayPowerPendingLabel({...base, desiredPower: 'off', desiredPowerRequestedAt: requested}, now), '正在关闭…');
  const stale = new Date(now - DESIRED_POWER_EXPIRY_MS - 1000).toISOString();
  assert.equal(gatewayPowerPending({...base, desiredPower: 'on', desiredPowerRequestedAt: stale}, now), false);
  assert.equal(gatewayPowerPendingLabel({...base, desiredPower: 'on', desiredPowerRequestedAt: stale}, now), '');
  assert.equal(gatewayPowerPending({...base, desiredPower: null}, now), false);
  assert.equal(gatewayPowerPending({...base, desiredPower: 'on'}, now), true, 'a missing timestamp still counts as queued');
});

test('409 codes map to Chinese sentences and anything else keeps the server message', () => {
  assert.equal(
    gatewayPowerErrorMessage('GATEWAY_REMOTE_POWER_NOT_ALLOWED'),
    '需要先在网关设备上打开“允许远程开启（待命）”。',
  );
  assert.equal(gatewayPowerErrorMessage('GATEWAY_STANDBY_OFFLINE'), '网关未在待命，无法远程开启；请在网关设备上开启网关。');
  assert.equal(gatewayPowerErrorMessage('GATEWAY_OFFLINE'), '网关当前不在线，无法远程关闭。');
  assert.equal(gatewayPowerErrorMessage('GATEWAY_IN_USE'), '网关正在通话中，暂时无法远程关闭。');
  assert.equal(gatewayPowerErrorMessage('HTTP_500', '请求失败 (500)'), '请求失败 (500)');
  assert.equal(gatewayPowerErrorMessage(undefined), '操作失败');
});

test('the last remote attempt is reported with its reason', () => {
  assert.equal(lastPowerResultText({desired: 'on', ok: true, at: '2026-09-11T11:00:00.000Z'}), '远程开启已成功');
  assert.equal(lastPowerResultText({desired: 'off', ok: false, reason: 'call_in_progress'}), '远程关闭未成功：网关上正在通话，已忽略关闭请求');
  assert.equal(lastPowerResultText({desired: 'on', ok: false, reason: 'weird_reason'}), '远程开启未成功：weird_reason');
  assert.equal(lastPowerResultText({desired: 'off', ok: false}), '远程关闭未成功');
  assert.equal(lastPowerResultText(null), '');
  assert.equal(lastPowerResultText(undefined), '');
  assert.equal(lastPowerResultText({}), '');
  assert.equal(powerResultReasonText(null), '');
});

test('the 网关总控 switch only offers requests that can succeed', () => {
  const offlineAllowed = gatewayPowerToggle({...base, standbyOnline: true}, now);
  assert.deepEqual(
    {desired: offlineAllowed.desired, checked: offlineAllowed.checked, disabled: offlineAllowed.disabled},
    {desired: 'on', checked: false, disabled: false},
  );

  const noBeacon = gatewayPowerToggle({...base, standbyOnline: false}, now);
  assert.equal(noBeacon.disabled, true);
  assert.equal(noBeacon.hint, '网关未在待命，无法远程开启。');

  const notAllowed = gatewayPowerToggle({gatewayId: 'gw-3', online: true}, now);
  assert.equal(notAllowed.disabled, true);
  assert.equal(notAllowed.hint, '远程开启未允许（需在网关设备上打开）');

  const online = gatewayPowerToggle({...base, online: true}, now);
  assert.deepEqual({desired: online.desired, checked: online.checked, disabled: online.disabled}, {
    desired: 'off',
    checked: true,
    disabled: false,
  });

  const busy = gatewayPowerToggle({...base, online: true, occupied: true}, now);
  assert.equal(busy.disabled, true);
  assert.equal(busy.hint, '通话进行中，暂不可远程关闭。');

  const pending = gatewayPowerToggle(
    {...base, standbyOnline: true, desiredPower: 'on', desiredPowerRequestedAt: new Date(now - 5000).toISOString()},
    now,
  );
  assert.equal(pending.disabled, true);
  assert.equal(pending.hint, '正在开启…');
});
