import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {Sim} from '../src/call-history-panel.tsx';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}

let server: ViteDevServer | undefined;
async function harness() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule('/src/main.tsx')) as typeof import('../src/main.tsx');
}
after(async () => {
  await server?.close();
  server = undefined;
});

const assigned: Sim = {
  id: 'sim-1',
  gatewayId: 'gateway-1',
  label: '家庭卡',
  phoneLabel: '+1 202 555 0123',
  online: true,
  settings: {mode: 'normal', version: 1, timeoutSeconds: 45, appliedVersion: 1},
};

test('SIM 初始失败可重试，失败刷新保留快照，只有成功空结果才显示未分配', async () => {
  const {SimSelector} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let retries = 0;
  const view = (status: 'loading' | 'ready' | 'error', sims: Sim[] = []) => React.createElement(SimSelector, {
    sims,
    selectedId: sims[0]?.id || '',
    status,
    busy: false,
    onSelect: () => {},
    onRetry: () => { retries++; },
  });
  try {
    await act(async () => { renderer = create(view('loading')); });
    assert.match(collectText(renderer!.toJSON()), /正在读取 SIM/);
    assert.doesNotMatch(collectText(renderer!.toJSON()), /还没有分配的 SIM/);

    await act(async () => { renderer!.update(view('error')); });
    let text = collectText(renderer!.toJSON());
    assert.match(text, /暂时无法读取 SIM 信息，请重试/);
    assert.doesNotMatch(text, /还没有分配的 SIM/);
    const retry = renderer!.root.findByProps({children: '重试读取 SIM'});
    await act(async () => { retry.props.onClick(); });
    assert.equal(retries, 1, '错误态提供可执行的读取重试');

    await act(async () => { renderer!.update(view('error', [assigned])); });
    text = collectText(renderer!.toJSON());
    assert.match(text, /家庭卡/);
    assert.match(text, /SIM 刷新失败，已保留上次读取的号码/);
    assert.doesNotMatch(text, /还没有分配的 SIM/);

    await act(async () => { renderer!.update(view('ready')); });
    text = collectText(renderer!.toJSON());
    assert.match(text, /还没有分配的 SIM/);
    assert.doesNotMatch(text, /暂时无法读取 SIM 信息|重试读取 SIM/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('SIM 状态圆点跟随在线状态而不是 SIM 序号', async () => {
  const {SimSelector} = await harness();
  const offline: Sim = {...assigned, id: 'sim-2', label: '备用卡', online: false};
  const notPresent: Sim = {...assigned, id: 'sim-3', label: '未待机卡', online: true, present: false};
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(SimSelector, {
        sims: [assigned, offline, notPresent],
        selectedId: assigned.id,
        status: 'ready',
        busy: false,
        onSelect: () => {},
        onRetry: () => {},
      }));
    });
    const dots = renderer!.root.findAll(node => typeof node.props.className === 'string' && node.props.className.includes('sim-dot'));
    assert.equal(dots.length, 3);
    assert.match(dots[0]!.props.className, /\bonline\b/);
    assert.match(dots[1]!.props.className, /\boffline\b/);
    assert.match(dots[2]!.props.className, /\boffline\b/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('S64 记录：allLabel 在最左加「全部 SIM 卡」，selectedId 为空时选中，点击回传空 id', async () => {
  const {SimSelector} = await harness();
  const picked: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(SimSelector, {sims: [assigned], selectedId: '', allLabel: '全部 SIM 卡', status: 'ready', busy: false, onSelect: id => picked.push(id), onRetry: () => {}}));
    });
    const buttons = renderer!.root.findAllByType('button');
    assert.equal(buttons.length, 2);
    assert.match(collectText(buttons[0]!), /^全部 SIM 卡/);
    assert.equal(buttons[0]!.props.className, 'selected');
    assert.equal(buttons[1]!.props.className, '');
    buttons[0]!.props.onClick({currentTarget: {scrollIntoView: () => {}}});
    assert.deepEqual(picked, ['']);
    await act(async () => { renderer!.update(React.createElement(SimSelector, {sims: [assigned], selectedId: assigned.id, status: 'ready', busy: false, onSelect: () => {}, onRetry: () => {}})); });
    assert.equal(renderer!.root.findAllByType('button').length, 1, 'no allLabel: SIM chips only');
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});
