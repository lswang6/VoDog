import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';

type Listener = () => void;
class FakeScript {
  dataset: Record<string, string> = {};
  src = '';
  async = false;
  defer = false;
  removed = false;
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  remove() { this.removed = true; }
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return textOf(record.children ?? record.props?.children);
}
function flush() { return new Promise<void>(resolve => setImmediate(resolve)); }

let vite: ViteDevServer | undefined;
async function turnstileModule() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!vite) vite = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await vite.ssrLoadModule('/src/turnstile.tsx')) as typeof import('../src/turnstile.tsx');
}
after(async () => { await vite?.close(); });

function installBrowser() {
  let current: FakeScript | null = null;
  const documentFake = {
    head: {appendChild(script: FakeScript) { current = script; }},
    createElement() { return new FakeScript(); },
    querySelector() { return current && !current.removed ? current : null; },
  };
  Object.assign(globalThis, {document: documentFake, window: {}});
  return {
    script: () => current,
    setApi(api: unknown) { (globalThis as {window: {turnstile?: unknown}}).window.turnstile = api; },
    clearApi() { delete (globalThis as {window: {turnstile?: unknown}}).window.turnstile; },
    cleanup() { delete (globalThis as {document?: unknown}).document; delete (globalThis as {window?: unknown}).window; },
  };
}

test('script errors, missing initialization and a permanently pending load fail visibly and remain retryable', async () => {
  const browser = installBrowser();
  const {loadTurnstile, retryTurnstileLoader} = await turnstileModule();
  try {
    retryTurnstileLoader();
    await assert.rejects(loadTurnstile(5), /加载超时/);
    assert.equal(browser.script()?.removed, true);

    retryTurnstileLoader();
    const failed = loadTurnstile(50);
    browser.script()!.dispatch('error');
    await assert.rejects(failed, /加载失败/);

    retryTurnstileLoader();
    const uninitialized = loadTurnstile(50);
    browser.script()!.dispatch('load');
    await assert.rejects(uninitialized, /未能初始化/);

    retryTurnstileLoader();
    const api = {render: () => 'widget', remove: () => {}, reset: () => {}};
    const recovered = loadTurnstile(50);
    browser.setApi(api);
    browser.script()!.dispatch('load');
    assert.equal(await recovered, api);
  } finally {
    retryTurnstileLoader();
    browser.cleanup();
  }
});

test('widget exposes load and render failures, clears expired tokens, and ignores callbacks from an old challenge', async () => {
  const browser = installBrowser();
  const {TurnstileWidget, retryTurnstileLoader} = await turnstileModule();
  let renderer: ReactTestRenderer | undefined;
  const tokens: Array<string | null> = [];
  let replaced = 0;
  try {
    retryTurnstileLoader();
    await act(async () => {
      renderer = create(React.createElement(TurnstileWidget, {siteKey: 'site-key', resetKey: 0, onToken: (token: string | null) => tokens.push(token)}), {
        createNodeMock: () => ({replaceChildren() { replaced++; }}),
      });
      await flush();
    });
    browser.script()!.dispatch('error');
    await act(flush);
    assert.match(textOf(renderer!.toJSON()), /人机验证加载失败/);
    const loadRetry = renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '重新加载人机验证')[0]!;

    let renderMode: 'throw' | 'sync' | 'async' = 'throw';
    const callbacks: Array<Record<string, (...args: string[]) => void>> = [];
    const removed: string[] = [];
    browser.setApi({
      render: (_container: unknown, options: Record<string, (...args: string[]) => void>) => {
        callbacks.push(options);
        if (renderMode === 'throw') throw new Error('render failed');
        if (renderMode === 'sync') options.callback('sync-token');
        return `widget-${callbacks.length}`;
      },
      remove: (id: string) => { removed.push(id); },
      reset: () => {},
    });
    await act(async () => { loadRetry.props.onClick(); await flush(); });
    assert.match(textOf(renderer!.toJSON()), /render failed/);
    assert.equal(replaced > 0, true, 'a partial render is cleared before retry');

    renderMode = 'sync';
    const renderRetry = renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '重新加载人机验证')[0]!;
    await act(async () => { renderRetry.props.onClick(); await flush(); });
    assert.match(textOf(renderer!.toJSON()), /人机验证已完成/);
    assert.equal(tokens.at(-1), 'sync-token', 'a synchronous callback is not overwritten by ready state');

    const verifiedCallbacks = callbacks.at(-1)!;
    await act(async () => verifiedCallbacks['expired-callback']());
    assert.equal(tokens.at(-1), null);
    assert.match(textOf(renderer!.toJSON()), /已过期/);

    renderMode = 'async';
    const challengeRetry = renderer!.root.findAll(node => node.type === 'button' && textOf(node) === '重新加载人机验证')[0]!;
    await act(async () => { challengeRetry.props.onClick(); await flush(); });
    const currentCallbacks = callbacks.at(-1)!;
    await act(async () => verifiedCallbacks.callback('stale-token'));
    assert.notEqual(tokens.at(-1), 'stale-token');
    await act(async () => currentCallbacks.callback('fresh-token'));
    assert.equal(tokens.at(-1), 'fresh-token');
    assert.equal(removed.length > 0, true, 'retry removes the preceding widget');
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    retryTurnstileLoader();
    browser.cleanup();
  }
});
