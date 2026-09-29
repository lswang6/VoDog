import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return textOf(record.children ?? record.props?.children);
}
function flush() { return new Promise<void>(resolve => setImmediate(resolve)); }

let vite: ViteDevServer | undefined;
async function module<T>(url: string): Promise<T> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!vite) vite = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return await vite.ssrLoadModule(url) as T;
}
after(async () => { await vite?.close(); });

test('the settings overview exposes role, current browser connection and one refresh-all action without a SIM', async () => {
  const {SettingsOverview, accountRoleLabel} = await module<typeof import('../src/settings-overview.tsx')>('/src/settings-overview.tsx');
  assert.equal(accountRoleLabel('admin'), '管理员');
  assert.equal(accountRoleLabel('user'), '用户');
  assert.equal(accountRoleLabel('owner'), '暂不可用');
  assert.equal(accountRoleLabel(), '暂不可用');
  let refreshes = 0;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(SettingsOverview, {
        username: 'owner@s33.test', role: 'admin', sims: [], busy: false,
        refreshStatus: '上次成功结果已保留。', onRefresh: () => { refreshes++; },
      }));
    });
    const rendered = textOf(renderer!.toJSON());
    assert.match(rendered, /角色管理员/);
    assert.match(rendered, /当前会话Web 浏览器 · 此设备/);
    assert.match(rendered, /目前没有在线号码/);
    const refresh = renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '刷新全部设置')[0]!;
    await act(async () => refresh.props.onClick());
    assert.equal(refreshes, 1);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('settings blocklist removes an accepted unblock immediately and keeps it removed when the follow-up read fails', async () => {
  const {BlocklistPanel} = await module<typeof import('../src/blocklist-panel.tsx')>('/src/blocklist-panel.tsx');
  let reads = 0;
  let deletes = 0;
  let changed = 0;
  let resolveStale!: (value: {items: {id: string; remoteNumber: string; createdAt: string}[]}) => void;
  const stale = new Promise<{items: {id: string; remoteNumber: string; createdAt: string}[]}>(resolve => { resolveStale = resolve; });
  const blocked = {id: 'blocked-1', remoteNumber: '+12025550101', createdAt: '2026-09-12T01:02:00.000Z'};
  const request = async <T,>(requestPath: string, _body?: unknown, method?: string): Promise<T> => {
    if (requestPath === '/blocklist?scope=sms' && method === undefined) return {items: []} as T;
    if (requestPath === '/blocklist?scope=call' && method === undefined) {
      reads++;
      if (reads === 1) return {items: [blocked]} as T;
      if (reads === 2) return stale as Promise<T>;
      throw new Error('temporary blocklist read failure');
    }
    if (requestPath === '/blocklist/blocked-1' && method === 'DELETE') { deletes++; return {} as T; }
    throw new Error(`unexpected ${method || 'GET'} ${requestPath}`);
  };
  let renderer: ReactTestRenderer | undefined;
  const view = (reloadToken: number) => React.createElement(BlocklistPanel, {request, busy: false, reloadToken, intervalMs: 100_000, onChanged: () => { changed++; }});
  try {
    await act(async () => { renderer = create(view(0)); });
    await act(async () => { await flush(); });
    assert.match(textOf(renderer!.toJSON()), /屏蔽于/);
    assert.equal(renderer!.root.findByType('time').props.dateTime, blocked.createdAt);
    await act(async () => { renderer!.update(view(1)); });
    await act(async () => renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '解除屏蔽')[0]!.props.onClick());
    assert.equal(deletes, 0, 'the red action first opens a confirmation');
    await act(async () => renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '确认解除')[0]!.props.onClick());
    await act(async () => { await flush(); await flush(); });
    resolveStale({items: [blocked]});
    await act(async () => { await stale; await flush(); });
    assert.equal(deletes, 1);
    assert.equal(changed, 1);
    assert.doesNotMatch(textOf(renderer!.toJSON()), /\+12025550101/, 'the accepted deletion cannot be submitted again');
    assert.match(textOf(renderer!.toJSON()), /已解除屏蔽，但名单暂未刷新/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('a slow blocklist read spanning multiple polling ticks is coalesced and eventually applied', async () => {
  const {BlocklistPanel} = await module<typeof import('../src/blocklist-panel.tsx')>('/src/blocklist-panel.tsx');
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let resolveRead!: (value: {items: {id: string; remoteNumber: string}[]}) => void;
  const slowRead = new Promise<{items: {id: string; remoteNumber: string}[]}>(resolve => { resolveRead = resolve; });
  const request = async <T,>(requestPath: string): Promise<T> => {
    if (requestPath === '/blocklist?scope=sms') return {items: []} as T;
    assert.equal(requestPath, '/blocklist?scope=call');
    reads++;
    return slowRead as Promise<T>;
  };
  try {
    await act(async () => {
      renderer = create(React.createElement(BlocklistPanel, {request, busy: false, intervalMs: 25}));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 65)); });
    assert.equal(reads, 1, 'two polling ticks must await the existing read instead of invalidating it');
    await act(async () => { resolveRead({items: [{id: 'slow', remoteNumber: '+12025550102'}]}); await slowRead; await flush(); });
    assert.match(textOf(renderer!.toJSON()), /\+12025550102/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('blocklist request lifecycle changes do not await or apply the old account response', async () => {
  const {BlocklistPanel} = await module<typeof import('../src/blocklist-panel.tsx')>('/src/blocklist-panel.tsx');
  let renderer: ReactTestRenderer | undefined;
  let resolveOld!: (value: {items: {id: string; remoteNumber: string}[]}) => void;
  const oldRead = new Promise<{items: {id: string; remoteNumber: string}[]}>(resolve => { resolveOld = resolve; });
  const oldRequest = async <T,>(): Promise<T> => oldRead as Promise<T>;
  const newRequest = async <T,>(requestPath: string): Promise<T> => {
    if (requestPath === '/blocklist?scope=sms') return {items: []} as T;
    assert.equal(requestPath, '/blocklist?scope=call');
    return {items: [{id: 'new-account', remoteNumber: '+12025550104'}]} as T;
  };
  const view = (request: typeof oldRequest) => React.createElement(BlocklistPanel, {request, busy: false, intervalMs: 100_000});
  try {
    await act(async () => { renderer = create(view(oldRequest)); });
    await act(async () => { renderer!.update(view(newRequest)); await flush(); });
    assert.match(textOf(renderer!.toJSON()), /\+12025550104/);
    resolveOld({items: [{id: 'old-account', remoteNumber: '+12025550105'}]});
    await act(async () => { await oldRead; await flush(); });
    assert.match(textOf(renderer!.toJSON()), /\+12025550104/);
    assert.doesNotMatch(textOf(renderer!.toJSON()), /\+12025550105/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('an accepted unblock after unmount does not refresh or notify the retired panel', async () => {
  const {BlocklistPanel} = await module<typeof import('../src/blocklist-panel.tsx')>('/src/blocklist-panel.tsx');
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let changed = 0;
  let resolveDelete!: () => void;
  const deletion = new Promise<void>(resolve => { resolveDelete = resolve; });
  const request = async <T,>(requestPath: string, _body?: unknown, method?: string): Promise<T> => {
    if (requestPath === '/blocklist?scope=sms' && method === undefined) return {items: []} as T;
    if (requestPath === '/blocklist?scope=call' && method === undefined) {
      reads++;
      return {items: [{id: 'retired', remoteNumber: '+12025550103'}]} as T;
    }
    if (requestPath === '/blocklist/retired' && method === 'DELETE') {
      await deletion;
      return {} as T;
    }
    throw new Error(`unexpected ${method || 'GET'} ${requestPath}`);
  };
  await act(async () => {
    renderer = create(React.createElement(BlocklistPanel, {request, busy: false, intervalMs: 100_000, onChanged: () => { changed++; }}));
  });
  await act(async () => { await flush(); });
  await act(async () => renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '解除屏蔽')[0]!.props.onClick());
  await act(async () => renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '确认解除')[0]!.props.onClick());
  await act(async () => renderer!.unmount());
  resolveDelete();
  await deletion;
  await flush();
  assert.equal(reads, 1, 'the retired request lifecycle must not issue a post-acceptance GET');
  assert.equal(changed, 0, 'the retired panel must not notify the new account tree');
});
