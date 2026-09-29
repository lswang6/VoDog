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
  const value = node as {children?: unknown[]; props?: {children?: unknown}};
  return textOf(value.children ?? value.props?.children);
}
function flush() { return new Promise<void>(resolve => setImmediate(resolve)); }
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && textOf(node).trim() === label)[0]!;
}

let server: ViteDevServer | undefined;
async function load<T>(entry: string): Promise<T> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return await server.ssrLoadModule(entry) as T;
}
after(async () => {
  await server?.close();
  delete (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT;
});

const missing = Object.assign(new Error('gone'), {status: 404});

test('an independently opened transcript closes after its by-ID check returns 404', async () => {
  const {CallTranscript} = await load<typeof import('../src/reports.tsx')>('/src/reports.tsx');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({transcript: null}), {status: 200, headers: {'content-type': 'application/json'}});
  const calls: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CallTranscript, {
        callId: 'gone-transcript',
        request: async <T,>(requestPath: string): Promise<T> => { calls.push(requestPath); throw missing; },
      }));
    });
    await act(async () => { button(renderer!, '查看转录').props.onClick(); await flush(); });
    assert.deepEqual(calls, ['/calls/gone-transcript']);
    assert.ok(button(renderer!, '查看转录'));
    assert.match(textOf(renderer!.toJSON()), /此通话已在其他设备删除，详情已关闭/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.fetch = previousFetch;
  }
});

test('a recording by-ID 404 closes the panel and disposes its audio ownership', async () => {
  const {CallRecording} = await load<typeof import('../src/recording.tsx')>('/src/recording.tsx');
  const {audioOwnership} = await load<typeof import('../src/audio-ownership.ts')>('/src/audio-ownership.ts');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {status: 404, headers: {'content-type': 'application/json'}});
  const calls: string[] = [];
  let disposed = 0;
  const unregister = audioOwnership.registerPlayer(() => { disposed++; });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CallRecording, {
        callId: '00000000-0000-4000-8000-000000000900',
        request: async <T,>(requestPath: string): Promise<T> => { calls.push(requestPath); throw missing; },
      }));
    });
    await act(async () => { button(renderer!, '查看录音').props.onClick(); await flush(); });
    assert.deepEqual(calls, ['/calls/00000000-0000-4000-8000-000000000900']);
    assert.ok(disposed >= 1, 'the deleted call releases every registered recording player');
    assert.ok(button(renderer!, '查看录音'));
    assert.match(textOf(renderer!.toJSON()), /此通话已在其他设备删除，详情已关闭/);
  } finally {
    unregister();
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.fetch = previousFetch;
  }
});
