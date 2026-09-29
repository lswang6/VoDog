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
function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
function turns(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    node => node.type === 'p' && String(node.props.className || '').split(' ').includes('ai-turn'),
  );
}

let server: ViteDevServer | undefined;
async function harness() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const {AiTranscript} = (await server.ssrLoadModule('/src/ai-transcript.tsx')) as typeof import('../src/ai-transcript.tsx');
  return {AiTranscript};
}
after(async () => {
  await server?.close();
  server = undefined;
});

test('AI 对话 renders one paragraph per turn, tagged by role and readable as a dialogue', async () => {
  const {AiTranscript} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = async <T,>(requestPath: string): Promise<T> => {
      paths.push(requestPath);
      // The third turn is blank: the worker writes empty deltas that must never become an empty bubble.
      return {items: [{role: 'ai', text: '您好'}, {role: 'caller', text: '你好'}, {role: 'ai', text: ''}]} as T;
    };
    await act(async () => {
      renderer = create(React.createElement(AiTranscript, {callId: 'call-1', request}));
    });
    await act(async () => {
      await flush();
    });

    assert.deepEqual(paths, ['/calls/call-1/ai-transcript']);
    const root = renderer!.toJSON() as {type: string; props: {className?: string}} | null;
    assert.ok(root && !Array.isArray(root), 'the block renders a single root node');
    assert.equal(root!.type, 'div');
    assert.equal(
      root!.props.className,
      'ai-transcript',
      'main.tsx opens the contact card unless the click landed inside .ai-transcript',
    );
    assert.equal(collectText(renderer!.root.findByType('h3')).trim(), 'AI 对话');

    const shown = turns(renderer!);
    assert.equal(shown.length, 2, 'a turn with no text is dropped rather than rendered blank');
    // The role is carried by the label text; the border colour only repeats it.
    assert.equal(shown[0]!.props.className, 'ai-turn ai-turn-ai');
    assert.equal(collectText(shown[0]!.findByType('strong')).trim(), 'AI 助理');
    assert.match(collectText(shown[0]!), /您好/);
    assert.equal(shown[1]!.props.className, 'ai-turn ai-turn-caller');
    assert.equal(collectText(shown[1]!.findByType('strong')).trim(), '对方');
    assert.match(collectText(shown[1]!), /你好/);

    const notes = renderer!.root.findAll(node => node.type === 'p' && node.props.className === 'note');
    assert.equal(notes.length, 1, 'the trailing note stays outside the turns');
    assert.match(collectText(notes[0]!), /实时对话记录/);
  } finally {
    renderer?.unmount();
  }
});

test('a call with no AI transcript renders nothing at all', async () => {
  const {AiTranscript} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => ({items: []}) as T;
    await act(async () => {
      renderer = create(React.createElement(AiTranscript, {callId: 'call-2', request}));
    });
    await act(async () => {
      await flush();
    });
    assert.equal(renderer!.toJSON(), null);
    assert.equal(turns(renderer!).length, 0);
  } finally {
    renderer?.unmount();
  }
});

test('an unknown role still gets a turn, labelled 通话', async () => {
  const {AiTranscript} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => ({items: [{role: 'system', text: '通话已接通'}]}) as T;
    await act(async () => {
      renderer = create(React.createElement(AiTranscript, {callId: 'call-3', request}));
    });
    await act(async () => {
      await flush();
    });
    const shown = turns(renderer!);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.props.className, 'ai-turn ai-turn-other');
    assert.equal(collectText(shown[0]!.findByType('strong')).trim(), '通话');
  } finally {
    renderer?.unmount();
  }
});
