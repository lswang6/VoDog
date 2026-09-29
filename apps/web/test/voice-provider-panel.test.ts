import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {VoiceProviderListDto} from '../src/voice-provider.ts';

/**
 * S24 决策 3 的设置页分组，用假响应驱动：状态标签、禁用逻辑、立即 PUT、409 恢复原选择、老 Control 隐藏。
 */
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
  return (await server.ssrLoadModule('/src/voice-provider-panel.tsx')) as typeof import('../src/voice-provider-panel.tsx');
}
after(async () => {
  await server?.close();
  server = undefined;
});

/** The contract sample from the S24 spec, plus a configured-but-offline third provider. */
const listed: VoiceProviderListDto = {
  items: [
    {id: 'xai', label: 'xAI Grok', configured: true, online: true},
    {id: 'doubao', label: '豆包', configured: false, online: false},
    {id: 'other', label: '备用供应商', configured: true, online: false},
  ],
  selected: 'xai',
};

/** The page-wide action wrapper `main.tsx` hands every settings panel. */
const run = async (action: () => Promise<void>) => {
  await action();
  return true;
};

const radios = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(node => node.type === 'input' && node.props?.type === 'radio');

test('每一项显示标签与状态，不可用的禁用并说明原因', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; body?: unknown; method?: string}[] = [];
    const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
      calls.push({path: requestPath, body, method});
      return listed as T;
    };
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request}));
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(calls, [{path: '/ai/voice-providers', body: undefined, method: undefined}]);

    const text = collectText(renderer!.toJSON());
    assert.match(text, /AI 语音服务/);
    assert.match(text, /xAI Grok/);
    assert.match(text, /可用/);
    assert.match(text, /豆包/);
    assert.match(text, /未配置/);
    assert.match(text, /服务器未配置这个语音服务/);
    assert.match(text, /备用供应商/);
    assert.match(text, /服务离线/);
    assert.match(text, /语音服务当前离线，暂时无法切换/);
    assert.match(text, /切换只影响之后的 AI 即接 \/ 超时代接来电。/);

    const checks = renderer!.root.findAllByProps({className: 'voice-provider-check'});
    assert.equal(checks.length, 1, 'only configured online providers receive the availability check');
    assert.equal(checks[0]!.props['aria-hidden'], 'true', 'the existing status text supplies the accessible label');

    const inputs = radios(renderer!);
    assert.deepEqual(inputs.map(node => node.props.checked), [true, false, false]);
    assert.deepEqual(
      inputs.map(node => node.props.disabled),
      [false, true, true],
      '未配置与服务离线都不能选',
    );
    assert.deepEqual(inputs.map(node => node.props.name), ['voice-provider', 'voice-provider', 'voice-provider']);
  } finally {
    renderer?.unmount();
  }
});

test('点可用项立刻 PUT，并用返回值刷新', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const switched: VoiceProviderListDto = {
      items: [
        {id: 'xai', label: 'xAI Grok', configured: true, online: true},
        {id: 'doubao', label: '豆包', configured: true, online: true},
      ],
      selected: 'doubao',
    };
    const calls: {path: string; body?: unknown; method?: string}[] = [];
    const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
      calls.push({path: requestPath, body, method});
      if (requestPath === '/ai/voice-providers') {
        return {items: switched.items, selected: 'xai'} as T;
      }
      return switched as T;
    };
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request}));
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      radios(renderer!)[1]!.props.onChange();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(calls[1], {path: '/ai/voice-provider', body: {provider: 'doubao', expectedVersion: 1}, method: 'PUT'});
    assert.deepEqual(radios(renderer!).map(node => node.props.checked), [false, true]);

    // 再点已经选中的那一项：不重复写审计。
    const before = calls.length;
    await act(async () => {
      radios(renderer!)[1]!.props.onChange();
      await flush();
    });
    assert.equal(calls.length, before, '当前选择不再发请求');
  } finally {
    renderer?.unmount();
  }
});

test('页面已有动作在飞时 run 直接拒绝，勾与禁用状态都不能被改动', async () => {
  // `run` in main.tsx returns false *without calling the action* when another action is in flight.
  // Nothing optimistic may happen outside it, or the panel would stay disabled with the wrong 勾.
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const available: VoiceProviderListDto = {
      items: [
        {id: 'xai', label: 'xAI Grok', configured: true, online: true},
        {id: 'doubao', label: '豆包', configured: true, online: true},
      ],
      selected: 'xai',
    };
    const calls: string[] = [];
    const request = async <T,>(requestPath: string): Promise<T> => {
      calls.push(requestPath);
      return available as T;
    };
    const refusingRun = async () => false;
    await act(async () => {
      renderer = create(
        React.createElement(VoiceProviderPanel, {busy: false, run: refusingRun, request}),
      );
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      radios(renderer!)[1]!.props.onChange();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(calls, ['/ai/voice-providers'], '没有发出 PUT');
    assert.deepEqual(radios(renderer!).map(node => node.props.checked), [true, false], '勾没有动');
    assert.deepEqual(
      radios(renderer!).map(node => node.props.disabled),
      [false, false],
      '没有被卡在 pending 状态',
    );
  } finally {
    renderer?.unmount();
  }
});

test('409 显示服务端 message 并恢复原选择', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const available: VoiceProviderListDto = {
      items: [
        {id: 'xai', label: 'xAI Grok', configured: true, online: true},
        {id: 'doubao', label: '豆包', configured: true, online: true},
      ],
      selected: 'xai',
    };
    const request = async <T,>(requestPath: string): Promise<T> => {
      if (requestPath === '/ai/voice-providers') return available as T;
      throw Object.assign(new Error('豆包语音服务当前离线。'), {status: 409, code: 'PROVIDER_UNAVAILABLE'});
    };
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request}));
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      radios(renderer!)[1]!.props.onChange();
    });
    await act(async () => {
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /豆包语音服务当前离线。/);
    assert.equal(renderer!.root.findAll(node => node.props?.role === 'alert').length, 1);
    assert.deepEqual(radios(renderer!).map(node => node.props.checked), [true, false], '勾回到原来的选择');
  } finally {
    renderer?.unmount();
  }
});

test('provider version conflict reloads current selection, preserves the explanation, and always clears pending', async () => {
  const {VoiceProviderPanel} = await harness();
  const items = [
    {id: 'xai', label: 'xAI Grok', configured: true, online: true},
    {id: 'doubao', label: '豆包', configured: true, online: true},
  ];
  let gets = 0;
  const seen: {path: string; body?: unknown}[] = [];
  const request = async <T,>(requestPath: string, body?: unknown): Promise<T> => {
    seen.push({path: requestPath, body});
    if (requestPath === '/ai/voice-providers') {
      gets++;
      return {items, selected: gets === 1 ? 'xai' : 'doubao', configVersion: gets === 1 ? 3 : 4} as T;
    }
    throw Object.assign(new Error('stale'), {status: 409, code: 'PROVIDER_VERSION_CONFLICT'});
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request}));
      await flush();
    });
    await act(async () => {
      radios(renderer!)[1]!.props.onChange();
      await flush();
      await flush();
    });
    assert.deepEqual(seen.find(entry => entry.path === '/ai/voice-provider')?.body, {provider: 'doubao', expectedVersion: 3});
    assert.equal(gets, 2, 'the conflict performs one fresh GET');
    assert.match(collectText(renderer!.toJSON()), /已在其他设备更新/);
    assert.deepEqual(radios(renderer!).map(node => node.props.checked), [false, true]);
    assert.deepEqual(radios(renderer!).map(node => node.props.disabled), [true, true], 'a stale choice stays blocked after pending clears');
    assert.match(collectText(renderer!.toJSON()), /刚才尝试选择「豆包」未写入/);
    await act(async () => {
      renderer!.root.findAll(node => node.type === 'button' && collectText(node).includes('重新读取并确认当前选择'))[0]!.props.onClick();
      await flush();
    });
    assert.equal(gets, 3, 'only explicit acknowledgement unlocks the current version');
    assert.deepEqual(radios(renderer!).map(node => node.props.disabled), [false, false]);
  } finally {
    renderer?.unmount();
  }
});

test('老 Control 的 404 让整个分组消失', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => {
      throw Object.assign(new Error('请求失败 (404)'), {status: 404, code: 'HTTP_404'});
    };
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request}));
    });
    await act(async () => {
      await flush();
    });
    assert.equal(renderer!.toJSON(), null, '没有这个接口时不显示分组');
  } finally {
    renderer?.unmount();
  }
});

test('其它读取失败仍然显示错误，而不是静默隐藏', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => {
      throw Object.assign(new Error('请求失败 (503)'), {status: 503, code: 'HTTP_503'});
    };
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request}));
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /请求失败 \(503\)/);
    assert.match(text, /AI 语音服务/);
  } finally {
    renderer?.unmount();
  }
});

test('慢读取跨过多个轮询周期时合并为一个请求，并在完成后应用', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let resolveRead!: (value: VoiceProviderListDto) => void;
  const slowRead = new Promise<VoiceProviderListDto>(resolve => { resolveRead = resolve; });
  const request = async <T,>(requestPath: string): Promise<T> => {
    assert.equal(requestPath, '/ai/voice-providers');
    reads++;
    return slowRead as Promise<T>;
  };
  try {
    await act(async () => {
      renderer = create(React.createElement(VoiceProviderPanel, {
        busy: false,
        run,
        request,
        intervalMs: 25,
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 65)); });
    assert.equal(reads, 1, '两个轮询周期复用尚未完成的读取，不会令慢结果永远过期');

    await act(async () => {
      resolveRead(listed);
      await slowRead;
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /xAI Grok/);
    assert.deepEqual(radios(renderer!).map(node => node.props.checked), [true, false, false]);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('写入前的慢读取晚返回时不能覆盖已接受的新选择', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let resolveStale!: (value: VoiceProviderListDto) => void;
  const staleRead = new Promise<VoiceProviderListDto>(resolve => { resolveStale = resolve; });
  const items = [
    {id: 'xai', label: 'xAI Grok', configured: true, online: true},
    {id: 'doubao', label: '豆包', configured: true, online: true},
  ];
  const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
    if (requestPath === '/ai/voice-providers') {
      reads++;
      if (reads === 1) return {items, selected: 'xai', configVersion: 7} as T;
      return staleRead as Promise<T>;
    }
    assert.equal(requestPath, '/ai/voice-provider');
    assert.equal(method, 'PUT');
    assert.deepEqual(body, {provider: 'doubao', expectedVersion: 7});
    return {items, selected: 'doubao', configVersion: 8} as T;
  };
  const view = (reloadToken: number) => React.createElement(VoiceProviderPanel, {
    busy: false,
    run,
    request,
    reloadToken,
    intervalMs: 100_000,
  });
  try {
    await act(async () => { renderer = create(view(0)); });
    await act(async () => { await flush(); });
    await act(async () => { renderer!.update(view(1)); });
    assert.equal(reads, 2, '显式刷新已开始较慢的旧读取');

    await act(async () => {
      radios(renderer!)[1]!.props.onChange();
      await flush();
    });
    assert.deepEqual(radios(renderer!).map(node => node.props.checked), [false, true]);

    resolveStale({items, selected: 'xai', configVersion: 7});
    await act(async () => { await staleRead; await flush(); });
    assert.deepEqual(
      radios(renderer!).map(node => node.props.checked),
      [false, true],
      '写入前快照即使最后返回也不能恢复旧勾选',
    );
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});


test('S47 availability check follows availability, not the selected radio', async () => {
  const {VoiceProviderPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => ({...listed, selected: 'other'}) as T;
    await act(async () => {renderer = create(React.createElement(VoiceProviderPanel, {busy: false, run, request})); await flush();});
    const rows = renderer!.root.findAllByProps({className: 'voice-provider-row'});
    assert.equal(rows[0]!.findAllByProps({className: 'voice-provider-check'}).length, 1);
    assert.equal(rows[0]!.findByType('input').props.checked, false);
    assert.equal(rows[2]!.findAllByProps({className: 'voice-provider-check'}).length, 0);
    assert.equal(rows[2]!.findByType('input').props.checked, true);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
