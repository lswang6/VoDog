import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}

let server: ViteDevServer | undefined;
after(async () => {
  await server?.close();
  server = undefined;
});

test('S55: a blocked number reported by the Pixel itself carries the 手机屏蔽 label', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const {BlocklistPanel} = (await server.ssrLoadModule('/src/blocklist-panel.tsx')) as typeof import('../src/blocklist-panel.tsx');
  const request = async <T,>(requestPath: string): Promise<T> => {
    if (requestPath === '/blocklist?scope=sms') return {items: []} as T;
    assert.equal(requestPath, '/blocklist?scope=call');
    return {items: [
      {id: 'e-1', remoteNumber: '+12025550122', source: 'phone'},
      {id: 'e-2', remoteNumber: '2025550117', source: 'client'},
      {id: 'e-3', remoteNumber: '10086'},
    ]} as T;
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(BlocklistPanel, {request, busy: false, intervalMs: 0}));
    });
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    const rows = renderer!.root.findAll(node => node.props?.className === 'record blocklist-row');
    assert.equal(rows.length, 3);
    assert.match(collectText(rows[0]!), /手机屏蔽/);
    assert.doesNotMatch(collectText(rows[1]!), /手机屏蔽/);
    assert.doesNotMatch(collectText(rows[2]!), /手机屏蔽/, 'an older Control without source shows no label');
  } finally {
    renderer?.unmount();
  }
});

test('S66: 来电 / 短信 are two lists with both counts; unblock deletes from the active list and names it', async () => {
  const {BlocklistPanel} = (await server!.ssrLoadModule('/src/blocklist-panel.tsx')) as typeof import('../src/blocklist-panel.tsx');
  const seen: string[] = [];
  const lists: Record<string, {id: string; remoteNumber: string; scope: string}[]> = {
    call: [{id: 'c-1', remoteNumber: '+12025550121', scope: 'call'}, {id: 'c-2', remoteNumber: '10086', scope: 'call'}],
    sms: [{id: 's-1', remoteNumber: '95559', scope: 'sms'}],
  };
  const request = async <T,>(requestPath: string, _body?: unknown, method?: string): Promise<T> => {
    seen.push(`${method || 'GET'} ${requestPath}`);
    const scope = new URL(requestPath, 'http://x.invalid').searchParams.get('scope');
    if (!method && scope) return {items: lists[scope]} as T;
    if (method === 'DELETE' && requestPath === '/blocklist/s-1') { lists.sms = []; return {} as T; }
    throw new Error(`unexpected ${method || 'GET'} ${requestPath}`);
  };
  const button = (label: string) => renderer!.root.findAll(node => node.type === 'button' && collectText(node) === label)[0]!;
  const rows = () => renderer!.root.findAll(node => node.props?.className === 'record blocklist-row');
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(BlocklistPanel, {request, busy: false, intervalMs: 0})); });
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.match(collectText(renderer!.root.findByType('summary')), /管理已屏蔽号码（来电 2 · 短信 1）/);
    assert.deepEqual(seen.sort(), ['GET /blocklist?scope=call', 'GET /blocklist?scope=sms']);
    assert.equal(rows().length, 2, '来电 is the default list');
    const switcher = renderer!.root.findByProps({'aria-label': '屏蔽名单'}).findAllByType('button');
    assert.deepEqual(switcher.map(node => collectText(node)), ['来电', '短信']);
    await act(async () => switcher[1]!.props.onClick());
    assert.equal(rows().length, 1);
    assert.match(collectText(rows()[0]), /95559/);
    await act(async () => button('解除屏蔽').props.onClick());
    assert.match(collectText(renderer!.toJSON()), /从短信黑名单解除 95559？/);
    await act(async () => { button('确认解除').props.onClick(); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.ok(seen.includes('DELETE /blocklist/s-1'));
    assert.match(collectText(renderer!.toJSON()), /短信黑名单目前没有号码/);
    assert.match(collectText(renderer!.root.findByType('summary')), /来电 2 · 短信 0/);
  } finally {
    renderer?.unmount();
  }
});
