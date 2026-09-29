import test from 'node:test';
import assert from 'node:assert/strict';
import {DashboardRefreshCoordinator,dashboardRefreshIntervalMs,IDLE_DASHBOARD_REFRESH_MS,SETTLING_DASHBOARD_REFRESH_MS} from '../src/dashboard-refresh.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

test('calls update even when another dashboard resource fails', async () => {
  const applied: string[] = [];
  const sims = deferred<{items: never[]}>(), messages = deferred<{items: never[]}>();
  const refresh = new DashboardRefreshCoordinator({
    epoch: () => 1,
    loadSims: () => sims.promise,
    loadCalls: async () => ({items: [{id: 'call-1', state: 'unknown'}]}),
    loadMessages: () => messages.promise,
    applySims: () => applied.push('sims'),
    applyCalls: value => applied.push(value.items[0].state),
    applyMessages: () => applied.push('messages'),
  });
  const pending = refresh.request();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(applied, ['unknown']);
  sims.reject(new Error('sims offline'));
  messages.resolve({items: []});
  await assert.rejects(pending, /sims offline/);
});

test('old response cannot overwrite logout or the next session', async () => {
  let epoch = 1;
  const oldCalls = deferred<{items: {state: string}[]}>();
  let callLoads = 0;
  const applied: string[] = [];
  const refresh = new DashboardRefreshCoordinator({
    epoch: () => epoch,
    loadSims: async () => ({items: []}),
    loadCalls: () => ++callLoads === 1 ? oldCalls.promise : Promise.resolve({items: [{state: 'unknown'}]}),
    loadMessages: async () => ({items: []}),
    applySims: () => applied.push('sims'),
    applyCalls: value => applied.push(value.items[0]?.state ?? 'empty'),
    applyMessages: () => applied.push('messages'),
  });
  const old = refresh.request();
  epoch++;
  refresh.invalidate();
  const next = refresh.request();
  oldCalls.resolve({items: [{state: 'ending'}]});
  await Promise.all([old, next]);
  assert.equal(callLoads, 2);
  assert.deepEqual(applied, ['sims', 'unknown', 'messages']);
});

test('switching accounts then focusing cannot surface the old sessions request error', async () => {
  let epoch = 1, loads = 0;
  const oldCalls = deferred<{items: {state: string}[]}>();
  const applied: string[] = [];
  const refresh = new DashboardRefreshCoordinator({
    epoch: () => epoch,
    loadSims: async () => ({items: []}),
    loadCalls: () => ++loads === 1 ? oldCalls.promise : Promise.resolve({items: [{state: 'unknown'}]}),
    loadMessages: async () => ({items: []}),
    applySims: () => undefined,
    applyCalls: value => applied.push(value.items[0]?.state ?? 'empty'),
    applyMessages: () => undefined,
  });
  const oldSession = refresh.request();
  epoch++;
  refresh.invalidate();
  const focusedNewSession = refresh.request();
  oldCalls.reject(new Error('old session disconnected'));
  await assert.doesNotReject(focusedNewSession);
  await assert.doesNotReject(oldSession);
  assert.equal(loads, 2);
  assert.deepEqual(applied, ['unknown']);
});

test('focus visible and online bursts share one in-flight request and one queued refresh', async () => {
  const first = deferred<{items: never[]}>();
  let loads = 0;
  const refresh = new DashboardRefreshCoordinator({
    epoch: () => 1,
    loadSims: async () => ({items: []}),
    loadCalls: () => ++loads === 1 ? first.promise : Promise.resolve({items: []}),
    loadMessages: async () => ({items: []}),
    applySims: () => undefined,
    applyCalls: () => undefined,
    applyMessages: () => undefined,
  });
  const focus = refresh.request();
  const visible = refresh.request();
  const online = refresh.request();
  assert.strictEqual(focus, visible);
  assert.strictEqual(focus, online);
  first.resolve({items: []});
  await Promise.all([focus, visible, online]);
  assert.equal(loads, 2);
});

test('a call that is still being set up polls every second', () => {
  assert.equal(SETTLING_DASHBOARD_REFRESH_MS, 1000);
  for (const state of ['outgoing_pending', 'incoming_ringing', 'connecting', 'ending']) {
    assert.equal(
      dashboardRefreshIntervalMs([{state: 'ended'}, {state}]),
      SETTLING_DASHBOARD_REFRESH_MS,
      `${state} must poll fast`,
    );
  }
});

test('idle, talking and finished calls stay on the two second poll', () => {
  assert.equal(IDLE_DASHBOARD_REFRESH_MS, 2000);
  assert.equal(dashboardRefreshIntervalMs([]), IDLE_DASHBOARD_REFRESH_MS);
  assert.equal(dashboardRefreshIntervalMs([{state: 'active'}]), IDLE_DASHBOARD_REFRESH_MS);
  assert.equal(dashboardRefreshIntervalMs([{state: 'ended'}, {state: 'failed'}]), IDLE_DASHBOARD_REFRESH_MS);
  assert.equal(dashboardRefreshIntervalMs([{state: 'unknown'}]), IDLE_DASHBOARD_REFRESH_MS, 'an unresolved record cannot pin the fast cadence');
});
