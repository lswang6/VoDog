import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import {CALL_DELETE_IN_USE_MESSAGE, CALL_DELETE_PROMPT, CONVERSATION_DELETE_AND_BLOCK_PROMPT, CONVERSATION_DELETE_PROMPT} from '../src/confirm-copy.ts';
import type {Call, Sim} from '../src/call-history-panel.tsx';
import type {MessageThread, ThreadMessage} from '../src/message-threads.ts';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
/**
 * Exact labels, never `includes`: 删除 / 确认删除 / 删除对话 / 删除并屏蔽 / 删除所选（N） all contain one another,
 * and 删除并屏蔽 also contains 屏蔽.
 */
function findButton(renderer: ReactTestRenderer, label: string) {
  const found = renderer.root.findAll(node => node.type === 'button' && collectText(node).trim() === label);
  assert.ok(found.length, `no button labelled ${label}`);
  return found[0]!;
}
function hasButton(renderer: ReactTestRenderer, label: string): boolean {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).trim() === label).length > 0;
}
function bubbles(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => node.type === 'article' && String(node.props.className).includes('message-bubble'));
}
function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

let server: ViteDevServer | undefined;
async function load<T>(entry: string): Promise<T> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule(entry)) as T;
}
after(async () => {
  await server?.close();
  server = undefined;
});

type Recorded = {path: string; body?: unknown; method?: string};
function recorder(answer: (request: Recorded) => unknown = () => ({})) {
  const seen: Recorded[] = [];
  const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
    const entry = {path: requestPath, body, method};
    seen.push(entry);
    return answer(entry) as T;
  };
  return {seen, request};
}

test('记录行的第四个动作是两步确认的删除，确认后 onDelete 只跑一次', async () => {
  const {HistoryCallActions} = await load<typeof import('../src/history-call-actions.tsx')>('/src/history-call-actions.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    let deletes = 0;
    await act(async () => {
      renderer = create(
        React.createElement(HistoryCallActions, {
          remoteNumber: '2025550111',
          simId: 'sim-1',
          mediaLive: false,
          busy: false,
          onRedial: () => {},
          onSms: () => {},
          onBlock: () => {},
          onDelete: () => {
            deletes += 1;
          },
        }),
      );
    });
    assert.equal(findButton(renderer!, '删除').props.className, 'passkey hangup');

    await act(async () => {
      findButton(renderer!, '删除').props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), new RegExp(CALL_DELETE_PROMPT), '第一步只是问，不是删');
    assert.equal(deletes, 0);
    assert.equal(hasButton(renderer!, '回拨'), false, '确认卡片顶掉整排按钮，误点不了别的动作');

    await act(async () => {
      findButton(renderer!, '取消').props.onClick();
    });
    assert.equal(deletes, 0, '取消什么也不做');
    assert.equal(hasButton(renderer!, '回拨'), true);

    await act(async () => {
      findButton(renderer!, '删除').props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.equal(deletes, 1, '确认恰好删一次');
    assert.equal(hasButton(renderer!, '回拨'), true, '确认后回到普通的一排动作');

    // 屏蔽 and 删除 share one confirm slot: 屏蔽 must still ask its own question.
    await act(async () => {
      findButton(renderer!, '屏蔽').props.onClick();
    });
    assert.doesNotMatch(collectText(renderer!.toJSON()), new RegExp(CALL_DELETE_PROMPT));
    assert.equal(hasButton(renderer!, '确认屏蔽'), true);

    renderer!.unmount();
    // A surface that cannot delete (无 onDelete) keeps the S22 three-button row exactly as it was.
    await act(async () => {
      renderer = create(
        React.createElement(HistoryCallActions, {
          remoteNumber: '2025550111',
          simId: 'sim-1',
          mediaLive: false,
          busy: false,
          onRedial: () => {},
          onSms: () => {},
          onBlock: () => {},
        }),
      );
    });
    assert.equal(hasButton(renderer!, '删除'), false);
  } finally {
    renderer?.unmount();
  }
});

test('deleteCallRecord 发出 DELETE /calls/:id，并把 409 CALL_IN_USE 翻成可读的一句话', async () => {
  const {deleteCallRecord} = await load<typeof import('../src/history-actions.ts')>('/src/history-actions.ts');
  const {seen, request} = recorder();
  await deleteCallRecord(request, 'call-1');
  assert.deepEqual(seen, [{path: '/calls/call-1', body: undefined, method: 'DELETE'}]);

  const inUse = async <T,>(): Promise<T> => {
    throw Object.assign(new Error('通话记录仍在使用'), {status: 409, code: 'CALL_IN_USE'});
  };
  await assert.rejects(() => deleteCallRecord(inUse, 'call-1'), {message: CALL_DELETE_IN_USE_MESSAGE});

  const byCodeOnly = async <T,>(): Promise<T> => {
    throw Object.assign(new Error('x'), {status: 400, code: 'CALL_IN_USE'});
  };
  await assert.rejects(() => deleteCallRecord(byCodeOnly, 'call-1'), {message: CALL_DELETE_IN_USE_MESSAGE});

  // Anything else is the server's own message: a 404 must not read as "还在通话中".
  const gone = async <T,>(): Promise<T> => {
    throw Object.assign(new Error('通话不存在'), {status: 404, code: 'NOT_FOUND'});
  };
  await assert.rejects(() => deleteCallRecord(gone, 'call-1'), {message: '通话不存在'});
});

const sims: Sim[] = [
  {
    id: 'sim-1',
    label: '家庭卡',
    phoneLabel: '2025550116',
    gatewayId: 'gw-abcdef12',
    timeZone: 'Asia/Shanghai',
    settings: {mode: 'normal', version: 1, timeoutSeconds: 45, appliedVersion: 1},
  },
];
const calls: Call[] = [
  {
    id: 'call-1',
    simId: 'sim-1',
    direction: 'incoming',
    remoteNumber: '2025550117',
    state: 'ended',
    startedAt: '2026-09-12T01:30:00.000Z',
    gatewayTimeZone: 'Asia/Shanghai',
  },
];

test('通话记录 里删除一行：发出 DELETE /calls/:id，随后这一页被重新读取', async () => {
  const {CallHistoryPanel} = await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const {deleteCallRecord} = await load<typeof import('../src/history-actions.ts')>('/src/history-actions.ts');
  let renderer: ReactTestRenderer | undefined;
  try {
    const {seen, request} = recorder(entry => (entry.path.startsWith('/calls?') ? {items: calls, total: 1, totalPages: 1} : {items: []}));
    const actions: string[] = [];
    const element = (reloadToken: number) =>
      React.createElement(CallHistoryPanel, {
        request,
        simId: '',
        sims,
        busy: false,
        reloadToken,
        onHistoryAction: async (call, action) => {
          actions.push(action);
          if (action === 'delete') await deleteCallRecord(request, call.id);
        },
      });
    await act(async () => {
      renderer = create(element(0));
    });
    await act(async () => {
      await flush();
    });
    const pages = () => seen.filter(entry => entry.path.startsWith('/calls?')).length;
    assert.equal(pages(), 1);

    await act(async () => {
      findButton(renderer!, '删除').props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), new RegExp(CALL_DELETE_PROMPT));
    assert.equal(seen.some(entry => entry.method === 'DELETE'), false, '光是问还没有删');

    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.deepEqual(actions, ['delete']);
    assert.deepEqual(
      seen.filter(entry => entry.method === 'DELETE'),
      [{path: '/calls/call-1', body: undefined, method: 'DELETE'}],
    );
    const before = pages();

    // main.tsx 删除成功后 setContactsEpoch，reloadToken 前进一格——这一页必须重新读一次。
    await act(async () => {
      renderer!.update(element(1));
      await flush();
    });
    assert.equal(pages(), before + 1, '删除后列表重新读一页');
    assert.equal(seen.filter(entry => entry.path.startsWith('/calls?')).at(-1)!.path, '/calls?page=1&pageSize=50&includeBlocked=true');
  } finally {
    renderer?.unmount();
  }
});

const thread: ThreadMessage[] = [
  {
    id: 'sms-1',
    simId: 'sim-1',
    direction: 'incoming',
    remoteNumber: '2025550110',
    conversationAddress: '+12025550110',
    body: '在吗',
    state: 'received',
    createdAt: '2026-09-12T01:00:00.000Z',
  },
  {
    id: 'sms-2',
    simId: 'sim-1',
    direction: 'outgoing',
    remoteNumber: '2025550110',
    conversationAddress: '+12025550110',
    body: '在的',
    state: 'sent',
    createdAt: '2026-09-12T01:01:00.000Z',
  },
];

async function openConversation(
  props: Record<string, unknown>,
): Promise<ReactTestRenderer> {
  const {Messages} = await load<typeof import('../src/messages.tsx')>('/src/messages.tsx');
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(Messages, {
        messages: thread,
        simId: 'sim-1',
        simLabel: '家庭卡',
        online: true,
        busy: false,
        onSend: async () => {},
        ...props,
      } as never),
    );
  });
  const row = renderer!.root.findAll(node => node.type === 'button' && String(node.props.className || '').includes('thread-row'))[0]!;
  await act(async () => {
    row.props.onClick();
  });
  return renderer!;
}

test('短信选择模式：逐条点选、全选、清空，删除所选发出正是这些 id', async () => {
  const {deleteMessages} = await load<typeof import('../src/message-threads.ts')>('/src/message-threads.ts');
  const {seen, request} = recorder();
  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await openConversation({
      onDeleteMessages: async (ids: string[]) => {
        await deleteMessages(request, ids);
        return true;
      },
    });
    assert.equal(hasButton(renderer, '选择'), true);
    assert.equal(bubbles(renderer).length, 2);
    assert.equal(bubbles(renderer)[0]!.props.role, undefined, '平时气泡不是可选项');

    await act(async () => {
      findButton(renderer!, '选择').props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), /已选 0 条/);
    assert.equal(findButton(renderer, '删除所选（0）').props.disabled, true, '一条没选时删不了');
    assert.equal(bubbles(renderer)[0]!.props.role, 'checkbox');

    await act(async () => {
      bubbles(renderer!)[1]!.props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), /已选 1 条/);
    assert.equal(String(bubbles(renderer)[1]!.props.className).includes('selected'), true);
    assert.equal(String(bubbles(renderer)[0]!.props.className).includes('selected'), false);
    assert.equal(renderer.root.findAll(node => node.type === 'input' && node.props.className === 'message-select').length, 2);

    // 再点一次是取消选中，不是删第二遍。
    await act(async () => {
      bubbles(renderer!)[1]!.props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), /已选 0 条/);

    await act(async () => {
      findButton(renderer!, '全选').props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), /已选 2 条/);
    await act(async () => {
      findButton(renderer!, '清空').props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), /已选 0 条/);

    await act(async () => {
      bubbles(renderer!)[0]!.props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '删除所选（1）').props.onClick();
    });
    assert.equal(seen.length, 0, '确认前不发请求');
    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.deepEqual(seen, [{path: '/sms/delete', body: {ids: ['sms-1']}, method: undefined}]);
    // 只删了一条，人还留在这段对话里，选择模式退出。
    assert.equal(hasButton(renderer, '选择'), true);
    assert.equal(hasButton(renderer, '删除所选（1）'), false);
  } finally {
    renderer?.unmount();
  }
});

test('删除对话发出 {simId, conversationAddress}，删除并屏蔽先 /blocklist 再 /sms/threads/delete', async () => {
  const {deleteThread} = await load<typeof import('../src/message-threads.ts')>('/src/message-threads.ts');
  let renderer: ReactTestRenderer | undefined;
  try {
    const plain = recorder();
    const threads: MessageThread[] = [];
    renderer = await openConversation({
      onDeleteThread: async (target: MessageThread, block: boolean) => {
        threads.push(target);
        await deleteThread(plain.request, target, block);
        return true;
      },
    });
    await act(async () => {
      findButton(renderer!, '删除对话').props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), new RegExp(CONVERSATION_DELETE_PROMPT));
    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.deepEqual(plain.seen, [
      {path: '/sms/threads/delete', body: {simId: 'sim-1', conversationAddress: '+12025550110'}, method: undefined},
    ]);
    assert.equal(threads[0]!.remoteNumber, '2025550110');
    // 整段删掉之后回到列表。
    assert.equal(String(renderer.root.findAll(node => node.type === 'section')[0]!.props.className).includes('has-conversation'), false);
    assert.match(collectText(renderer.toJSON()), /选择一段对话/);
    renderer.unmount();

    const blocked = recorder();
    renderer = await openConversation({
      onDeleteThread: async (target: MessageThread, block: boolean) => {
        await deleteThread(blocked.request, target, block);
        return true;
      },
    });
    await act(async () => {
      findButton(renderer!, '删除并屏蔽').props.onClick();
    });
    assert.match(collectText(renderer.toJSON()), new RegExp(CONVERSATION_DELETE_AND_BLOCK_PROMPT));
    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.deepEqual(
      blocked.seen.map(entry => entry.path),
      ['/blocklist', '/sms/threads/delete'],
      '先屏蔽再删：屏蔽失败时短信还在，可以重来',
    );
    // 屏蔽用线程的原始号码，删除用服务端归一化过的线程键（S30 §1.3）。
    assert.deepEqual(blocked.seen[0]!.body, {remoteNumber: '2025550110', scope: 'sms'});
    assert.deepEqual(blocked.seen[1]!.body, {simId: 'sim-1', conversationAddress: '+12025550110'});
  } finally {
    renderer?.unmount();
  }
});

test('删除失败时留在原地：对话不关、选择不清', async () => {
  let renderer: ReactTestRenderer | undefined;
  try {
    renderer = await openConversation({
      onDeleteMessages: async () => false,
      onDeleteThread: async () => false,
    });
    await act(async () => {
      findButton(renderer!, '删除并屏蔽').props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.equal(String(renderer.root.findAll(node => node.type === 'section')[0]!.props.className).includes('has-conversation'), true);
    assert.equal(hasButton(renderer, '删除对话'), true, '失败后确认卡片收起，动作行回来');

    await act(async () => {
      findButton(renderer!, '选择').props.onClick();
    });
    await act(async () => {
      bubbles(renderer!)[0]!.props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '删除所选（1）').props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '确认删除').props.onClick();
      await flush();
    });
    assert.match(collectText(renderer.toJSON()), /已选 1 条/, '失败时选中的那条还选着，可以直接重试');
  } finally {
    renderer?.unmount();
  }
});

test('换一段对话会清掉上一段的选择', async () => {
  const {Messages} = await load<typeof import('../src/messages.tsx')>('/src/messages.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    const other: ThreadMessage = {
      id: 'sms-3',
      simId: 'sim-1',
      direction: 'incoming',
      remoteNumber: '2025550112',
      conversationAddress: '+12025550112',
      body: '你好',
      state: 'received',
      createdAt: '2026-09-12T02:00:00.000Z',
    };
    await act(async () => {
      renderer = create(
        React.createElement(Messages, {
          messages: [...thread, other],
          simId: 'sim-1',
          simLabel: '家庭卡',
          online: true,
          busy: false,
          onSend: async () => {},
          onDeleteMessages: async () => true,
          onDeleteThread: async () => true,
        } as never),
      );
    });
    const rows = () => renderer!.root.findAll(node => node.type === 'button' && String(node.props.className || '').includes('thread-row'));
    await act(async () => {
      rows()[1]!.props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '选择').props.onClick();
    });
    await act(async () => {
      bubbles(renderer!)[0]!.props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), /已选 1 条/);
    await act(async () => {
      rows()[0]!.props.onClick();
    });
    assert.equal(hasButton(renderer!, '选择'), true, '新对话从非选择模式开始');
    assert.doesNotMatch(collectText(renderer!.toJSON()), /已选/);
  } finally {
    renderer?.unmount();
  }
});
