import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {ThreadMessage} from '../src/message-threads.ts';

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

let server: ViteDevServer | undefined;
async function harness() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const {SmsCompose} = (await server.ssrLoadModule('/src/messages.tsx')) as typeof import('../src/messages.tsx');
  return {SmsCompose};
}
after(async () => {
  await server?.close();
  server = undefined;
});

const base = {
  simId: 'sim-1',
  simLabel: '号码 1',
  online: true,
  busy: false,
  timeZone: null,
  onClose: () => {},
};

test('SmsCompose shows a matching thread history and sends to the fixed number', async () => {
  const {SmsCompose} = await harness();
  const messages: ThreadMessage[] = [
    {id: 'm1', simId: 'sim-1', direction: 'outgoing', number: '2025550117', remoteNumber: '2025550117', body: '你好', state: 'sent', createdAt: '2026-09-15T10:00:00Z'},
    {id: 'm2', simId: 'sim-1', direction: 'incoming', number: '2025550117', remoteNumber: '2025550117', body: '收到', state: 'received', createdAt: '2026-09-15T10:01:00Z'},
  ];
  const sent: [string, string][] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        React.createElement(SmsCompose, {
          ...base,
          messages,
          remoteNumber: '2025550117',
          contactName: '张三',
          onSend: async (number, body) => {
            sent.push([number, body]);
          },
        }),
      );
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /张三/);
    assert.match(text, /你好/);
    assert.match(text, /收到/);
    assert.doesNotMatch(text, /还没有聊天记录/);

    const area = renderer!.root.findAll(node => node.type === 'textarea')[0]!;
    await act(async () => {
      area.props.onChange({target: {value: '再见'}});
    });
    await act(async () => {
      renderer!.root.findByType('form').props.onSubmit({preventDefault() {}});
      await flush();
    });
    assert.deepEqual(sent, [['2025550117', '再见']]);
  } finally {
    renderer?.unmount();
  }
});

test('SmsCompose shows the empty state when there is no history', async () => {
  const {SmsCompose} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(SmsCompose, {...base, messages: [], remoteNumber: '2025550117'}));
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /还没有聊天记录/);
  } finally {
    renderer?.unmount();
  }
});

test('SmsCompose exposes modal semantics and a focusable dialog root', async () => {
  const {SmsCompose} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(SmsCompose, {
        ...base,
        messages: [],
        remoteNumber: '2025550117',
        onSend: async () => {},
      }));
      await flush();
    });
    const dialog = renderer!.root.findAll(node => node.type === 'section' && node.props.className === 'sms-compose')[0]!;
    assert.equal(dialog.props.role, 'dialog');
    assert.equal(dialog.props['aria-modal'], 'true');
    assert.equal(dialog.props.tabIndex, -1);
    assert.equal(renderer!.root.findByProps({'aria-label': '关闭短信窗口'}).type, 'button');
  } finally {
    renderer?.unmount();
  }
});

test('SmsCompose contains delayed handoff focus, cancels StrictMode restore, and restores only usable targets', async () => {
  const {SmsCompose} = await harness();
  const saved = new Map(['document', 'window', 'HTMLElement', 'Node'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Set<(event: {target: FocusNode}) => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let active: FocusNode;
  class FocusNode {
    isConnected = true;
    offsetParent: object | null = {};
    disabled = false;
    children: FocusNode[] = [];
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string) { return selector === ':disabled' && this.disabled; }
    focus() {
      if (!this.isConnected || this.disabled || this.offsetParent === null) return;
      active = this;
      for (const listener of listeners) listener({target: this});
    }
    querySelectorAll() { return this.children.filter(child => !child.disabled); }
    scrollIntoView() {}
  }
  const body = new FocusNode(), opener = new FocusNode(), panel = new FocusNode();
  const close = new FocusNode(), area = new FocusNode(), fallback = new FocusNode();
  const hidden = new FocusNode(); hidden.offsetParent = null;
  const disabled = new FocusNode(); disabled.disabled = true;
  panel.children = [close, area]; active = opener;
  const documentMock = {
    body, get activeElement() { return active; },
    addEventListener(_name: string, callback: (event: {target: FocusNode}) => void) { listeners.add(callback); },
    removeEventListener(_name: string, callback: (event: {target: FocusNode}) => void) { listeners.delete(callback); },
    querySelectorAll() { return [hidden, disabled, fallback]; },
  };
  const windowMock = {
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const drain = () => { const queued = [...timers.values()]; timers.clear(); queued.forEach(callback => callback()); };
  for (const [key, value] of Object.entries({document: documentMock, window: windowMock, HTMLElement: FocusNode, Node: FocusNode})) {
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  }
  let renderer: ReactTestRenderer | undefined;
  let closed = 0;
  const mount = async () => {
    panel.isConnected = true;
    await act(async () => {
      renderer = create(React.createElement(React.StrictMode, {}, React.createElement(SmsCompose, {
        ...base, messages: [], remoteNumber: '2025550117', onSend: async () => {}, onClose: () => { closed++; },
      })), {createNodeMock: element => element.type === 'section' ? panel : new FocusNode()});
    });
  };
  try {
    await mount();
    assert.equal(active, panel);
    assert.equal(timers.size, 0, 'StrictMode replay must cancel old close restoration');
    windowMock.setTimeout(() => opener.focus()); drain();
    assert.equal(active, panel, 'late contact-dialog restoration cannot leave focus on background');
    const dialog = renderer!.root.findByProps({className: 'sms-compose'});
    const tab = (shiftKey = false) => {
      let prevented = false;
      dialog.props.onKeyDown({key: 'Tab', shiftKey, currentTarget: panel, preventDefault() { prevented = true; }});
      assert.equal(prevented, true);
    };
    tab(); assert.equal(active, close);
    tab(true); assert.equal(active, area);
    tab(); assert.equal(active, close);
    let stopped = false;
    dialog.props.onKeyDown({key: 'Escape', stopPropagation() { stopped = true; }});
    assert.equal(stopped, true); assert.equal(closed, 1);
    opener.isConnected = false;
    await act(async () => { renderer!.unmount(); }); renderer = undefined;
    panel.isConnected = false; active = body;
    assert.equal(listeners.size, 0);
    drain(); assert.equal(active, fallback, 'skip detached opener and hidden/disabled fallback targets');
    await mount();
    await act(async () => { renderer!.unmount(); }); renderer = undefined;
    panel.isConnected = false;
    const nextDialog = new FocusNode(); nextDialog.focus(); drain();
    assert.equal(active, nextDialog, 'closing SMS must not steal focus from its replacement');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    timers.clear();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
