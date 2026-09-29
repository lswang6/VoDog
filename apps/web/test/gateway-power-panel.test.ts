import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {GatewayPowerDto} from '../src/gateway-power.ts';

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
  return (await server.ssrLoadModule('/src/gateway-power-panel.tsx')) as typeof import('../src/gateway-power-panel.tsx');
}
after(async () => {
  await server?.close();
  server = undefined;
});

const items: GatewayPowerDto[] = [
  {
    gatewayId: 'gw-on',
    name: '家里的 Pixel',
    controlEnabled: true,
    online: true,
    remotePowerAllowed: true,
    lastPowerResult: {desired: 'on', ok: true, at: '2026-09-11T11:00:00.000Z'},
  },
  {
    gatewayId: 'gw-standby',
    name: '备用 Pixel',
    controlEnabled: false,
    online: false,
    standbyOnline: true,
    remotePowerAllowed: true,
    lastPowerResult: {desired: 'off', ok: false, reason: 'call_in_progress', at: '2026-09-11T10:00:00.000Z'},
  },
  // An old gateway that never reported the new columns at all.
  {gatewayId: 'gw-old', name: '旧 Pixel'},
];

test('the 网关 section names each state, reports the last remote attempt and switches power', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; body?: unknown}[] = [];
    const request = async <T,>(requestPath: string, body?: unknown): Promise<T> => {
      calls.push({path: requestPath, body});
      if (requestPath === '/gateways/power') return {items} as T;
      if (requestPath === '/gateways/gw-standby/power') return {item: {...items[1]!, desiredPower: 'on', desiredPowerRequestedAt: new Date().toISOString()}} as T;
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(GatewayPowerPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
          intervalMs: 100_000,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const rows = () => renderer!.root.findAll(node => node.type === 'article');
    assert.equal(rows().length, 3);

    const online = collectText(rows()[0]!.props.children);
    assert.match(online, /家里的 Pixel/);
    assert.match(online, /在线/);
    assert.match(online, /远程开启已允许/);
    assert.match(online, /远程开启已成功/);

    const standby = collectText(rows()[1]!.props.children);
    assert.match(standby, /待命中/);
    assert.match(standby, /远程关闭未成功：网关上正在通话，已忽略关闭请求/);

    const old = collectText(rows()[2]!.props.children);
    assert.match(old, /离线/);
    assert.match(old, /远程开启未允许（需在网关设备上打开）/);

    const switches = renderer!.root.findAll(node => node.props?.role === 'switch');
    assert.deepEqual(switches.map(node => node.props['aria-checked']), [true, false, false]);
    assert.deepEqual(switches.map(node => node.props.disabled), [false, false, true], 'a gateway that never allowed remote power cannot be switched');
    assert.deepEqual(switches.map(node => collectText(node)), ['关闭网关总控', '开启网关总控', '开启网关总控']);
    assert.match(switches[0]!.props.className,/\bhangup\b/,'closing gateway control uses the destructive action treatment');
    assert.doesNotMatch(switches[1]!.props.className,/\bhangup\b/,'turning gateway control on remains an ordinary action');
    assert.equal(switches[0]!.props['aria-label'], '网关总控 家里的 Pixel');

    const reads = calls.length;
    await act(async () => {
      switches[0]!.props.onClick();
    });
    assert.equal(calls.length, reads, 'closing only opens the confirmation and sends no request');
    assert.match(collectText(renderer!.toJSON()), /关闭 家里的 Pixel 的网关总控/);
    const confirmOff = renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '确认关闭')[0]!;
    assert.match(confirmOff.props.className, /\bhangup\b/, 'the destructive confirmation stays red');
    await act(async () => {
      renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '取消')[0]!.props.onClick();
    });
    assert.equal(calls.length, reads, 'cancel sends no request');

    await act(async () => {
      switches[1]!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(calls[reads], {path: '/gateways/gw-standby/power', body: {desired: 'on'}});
    assert.equal(calls[reads + 1]!.path, '/gateways/power', 'the view refreshes right after the request');
  } finally {
    renderer?.unmount();
  }
});

test('a 409 from the power route is shown as a Chinese sentence', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(requestPath: string): Promise<T> => {
      if (requestPath === '/gateways/power') return {items: [items[0]!]} as T;
      throw Object.assign(new Error('gateway is in use'), {status: 409, code: 'GATEWAY_IN_USE'});
    };
    await act(async () => {
      renderer = create(
        React.createElement(GatewayPowerPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
          intervalMs: 100_000,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      renderer!.root.findAll(node => node.props?.role === 'switch')[0]!.props.onClick();
    });
    assert.doesNotMatch(collectText(renderer!.toJSON()), /网关正在通话中/, 'opening confirmation has not submitted');
    await act(async () => {
      renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '确认关闭')[0]!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /网关正在通话中，暂时无法远程关闭。/);
    assert.doesNotMatch(collectText(renderer!.toJSON()), /gateway is in use/, 'the raw server text is replaced');
  } finally {
    renderer?.unmount();
  }
});

test('a Control without the power routes reports a missing feature, not a failure', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => {
      throw Object.assign(new Error('请求失败 (404)'), {status: 404, code: 'HTTP_404'});
    };
    await act(async () => {
      renderer = create(
        React.createElement(GatewayPowerPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
          intervalMs: 100_000,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /此服务器尚未启用远程开关。/);
    assert.equal(renderer!.root.findAll(node => node.props?.role === 'alert').length, 0, 'a missing route raises no alert');
  } finally {
    renderer?.unmount();
  }
});

test('an older in-flight power read cannot overwrite an accepted pending OFF request', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let resolveStale!: (value: {items: GatewayPowerDto[]}) => void;
  const stale = new Promise<{items: GatewayPowerDto[]}>(resolve => { resolveStale = resolve; });
  const pending = {...items[0]!, desiredPower: 'off', desiredPowerRequestedAt: new Date().toISOString()};
  const request = async <T,>(requestPath: string): Promise<T> => {
    if (requestPath === '/gateways/power') {
      reads++;
      if (reads === 1) return {items: [items[0]!]} as T;
      if (reads === 2) return stale as Promise<T>;
      throw new Error('temporary gateway refresh failure');
    }
    if (requestPath === '/gateways/gw-on/power') return {item: pending} as T;
    throw new Error(`unexpected ${requestPath}`);
  };
  const view = (reloadToken: number) => React.createElement(GatewayPowerPanel, {
    busy: false, reloadToken, intervalMs: 100_000, request,
    run: async (action: () => Promise<void>) => { await action(); return true; },
  });
  try {
    await act(async () => { renderer = create(view(0)); });
    await act(async () => { await flush(); });
    await act(async () => { renderer!.update(view(1)); });
    await act(async () => renderer!.root.findByProps({role: 'switch'}).props.onClick());
    await act(async () => renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '确认关闭')[0]!.props.onClick());
    await act(async () => { await flush(); await flush(); });
    resolveStale({items: [items[0]!]});
    await act(async () => { await stale; await flush(); });
    assert.match(collectText(renderer!.toJSON()), /正在关闭…/);
    assert.match(collectText(renderer!.toJSON()), /temporary gateway refresh failure/);
    assert.equal(renderer!.root.findByProps({role: 'switch'}).props.disabled, true, 'the accepted pending action cannot be submitted twice');
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('a slow power read spanning multiple polling ticks is coalesced and eventually applied', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let resolveRead!: (value: {items: GatewayPowerDto[]}) => void;
  const slowRead = new Promise<{items: GatewayPowerDto[]}>(resolve => { resolveRead = resolve; });
  const request = async <T,>(requestPath: string): Promise<T> => {
    assert.equal(requestPath, '/gateways/power');
    reads++;
    return slowRead as Promise<T>;
  };
  try {
    await act(async () => {
      renderer = create(React.createElement(GatewayPowerPanel, {
        busy: false,
        request,
        intervalMs: 25,
        run: async (action: () => Promise<void>) => { await action(); return true; },
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 65)); });
    assert.equal(reads, 1, 'two polling ticks must await the existing read instead of invalidating it');
    await act(async () => { resolveRead({items: [items[0]!]}); await slowRead; await flush(); });
    assert.match(collectText(renderer!.toJSON()), /家里的 Pixel/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('changing the request lifecycle starts a fresh read and ignores the old account response', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let resolveOld!: (value: {items: GatewayPowerDto[]}) => void;
  const oldRead = new Promise<{items: GatewayPowerDto[]}>(resolve => { resolveOld = resolve; });
  const oldRequest = async <T,>(): Promise<T> => oldRead as Promise<T>;
  const newItem = {...items[0]!, gatewayId: 'gw-new-account', name: '新账号 Pixel'};
  const newRequest = async <T,>(requestPath: string): Promise<T> => {
    assert.equal(requestPath, '/gateways/power');
    return {items: [newItem]} as T;
  };
  const view = (request: typeof oldRequest) => React.createElement(GatewayPowerPanel, {
    busy: false, request, intervalMs: 100_000,
    run: async (action: () => Promise<void>) => { await action(); return true; },
  });
  try {
    await act(async () => { renderer = create(view(oldRequest)); });
    await act(async () => { renderer!.update(view(newRequest)); await flush(); });
    assert.match(collectText(renderer!.toJSON()), /新账号 Pixel/);
    resolveOld({items: [items[0]!]});
    await act(async () => { await oldRead; await flush(); });
    assert.match(collectText(renderer!.toJSON()), /新账号 Pixel/);
    assert.doesNotMatch(collectText(renderer!.toJSON()), /家里的 Pixel/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

test('an accepted power response after unmount does not refresh or update the retired panel', async () => {
  const {GatewayPowerPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  let reads = 0;
  let resolvePower!: (value: {item: GatewayPowerDto}) => void;
  const powerResponse = new Promise<{item: GatewayPowerDto}>(resolve => { resolvePower = resolve; });
  const request = async <T,>(requestPath: string): Promise<T> => {
    if (requestPath === '/gateways/power') { reads++; return {items: [items[0]!]} as T; }
    if (requestPath === '/gateways/gw-on/power') return powerResponse as Promise<T>;
    throw new Error(`unexpected ${requestPath}`);
  };
  await act(async () => {
    renderer = create(React.createElement(GatewayPowerPanel, {
      busy: false, request, intervalMs: 100_000,
      run: async (action: () => Promise<void>) => { await action(); return true; },
    }));
  });
  await act(async () => { await flush(); });
  await act(async () => renderer!.root.findByProps({role: 'switch'}).props.onClick());
  await act(async () => renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '确认关闭')[0]!.props.onClick());
  await act(async () => renderer!.unmount());
  resolvePower({item: {...items[0]!, desiredPower: 'off'}});
  await powerResponse;
  await flush();
  assert.equal(reads, 1, 'the retired request lifecycle must not issue a post-acceptance GET');
});
