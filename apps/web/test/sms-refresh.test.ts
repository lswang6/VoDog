import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {ThreadMessage} from '../src/message-threads.ts';

function textOf(node: ReactTestRenderer['root'] | ReturnType<ReactTestRenderer['root']['findAll']>[number]): string {
  const children = node.props.children;
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (!Array.isArray(children)) return children ? String(children) : '';
  return children.map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return child?.props ? textOf(child) : '';
  }).join('');
}

let server: ViteDevServer | undefined;
async function loadMessages() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  server ||= await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule('/src/messages.tsx')) as typeof import('../src/messages.tsx');
}

after(async () => {
  await server?.close();
  server = undefined;
});

test('a refreshed outgoing sent row appears in the correct SIM thread without a local send callback', async () => {
  const {Messages} = await loadMessages();
  const incoming: ThreadMessage = {
    id: 'incoming-before-refresh', simId: 'sim-a', direction: 'incoming', remoteNumber: '1001298',
    conversationAddress: '1001298', body: '旧消息', state: 'received', createdAt: '2026-09-21T06:40:00.000Z',
  };
  const otherSim: ThreadMessage = {
    id: 'other-sim', simId: 'sim-b', direction: 'outgoing', remoteNumber: '1001298',
    conversationAddress: '1001298', body: '错误 SIM', state: 'sent', createdAt: '2026-09-21T06:50:00.000Z',
  };
  const refreshed: ThreadMessage & {sentAt: string} = {
    id: 'pixel-observed', simId: 'sim-a', direction: 'outgoing', remoteNumber: '1001298',
    conversationAddress: '1001298', body: '1', state: 'sent',
    createdAt: '2026-09-21T06:41:42.544Z', sentAt: '2026-09-21T06:41:42.544Z',
  };
  let localSendCallbacks = 0;
  const props = (messages: ThreadMessage[]) => ({
    messages, simId: 'sim-a', simLabel: '号码 A', online: true, busy: false, timeZone: 'UTC', account: 'refresh-test',
    onSend: async () => { localSendCallbacks++; },
    onSent: async () => { localSendCallbacks++; },
  });

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Messages, props([incoming, otherSim]))); });
    const threadRow = renderer!.root.findAll(node => node.type === 'button' && String(node.props.className || '').includes('thread-row'))[0]!;
    assert.doesNotMatch(textOf(threadRow), /错误 SIM/, 'the selected SIM must own the visible thread');
    await act(async () => { threadRow.props.onClick(); });

    await act(async () => {
      renderer!.update(React.createElement(Messages, props([incoming, otherSim, refreshed])));
    });

    assert.equal(localSendCallbacks, 0, 'prop refresh alone must surface the server row');
    const rows = renderer!.root.findAll(node => node.type === 'button' && String(node.props.className || '').includes('thread-row'));
    assert.equal(rows.length, 1);
    assert.match(textOf(rows[0]!), /1/);
    assert.match(textOf(rows[0]!), /已发送/);
    assert.doesNotMatch(textOf(rows[0]!), /错误 SIM/);

    const bubbles = renderer!.root.findAll(node => node.type === 'article' && String(node.props.className || '').includes('message-bubble'));
    assert.deepEqual(bubbles.map(bubble => bubble.findByType('p').props.children), ['旧消息', '1'], 'the refreshed row follows chronological order');
    assert.match(bubbles[0]!.props.className, /incoming/);
    assert.match(bubbles[1]!.props.className, /outgoing/);
    assert.match(textOf(bubbles[1]!), /已发送/);
    assert.equal(bubbles[1]!.findByType('small').props.children[0], '2026-09-21 06:41');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
  }
});
