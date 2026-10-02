import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {Call, Sim} from '../src/call-history-panel.tsx';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).includes(label))[0]!;
}
function rows(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => node.type === 'article' && String(node.props.className).includes('call-record'));
}
function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
/** The search box debounces by 250 ms, exactly like 报告 and 通讯录. */
function settleDebounce() {
  return new Promise<void>(resolve => setTimeout(resolve, 320));
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
    contactName: '张三',
    state: 'ended',
    startedAt: '2026-09-12T01:30:00.000Z',
    answeredAt: '2026-09-12T01:30:05.000Z',
    endedAt: '2026-09-12T01:30:53.000Z',
    gatewayTimeZone: 'Asia/Shanghai',
  },
  {
    id: 'call-2',
    simId: 'sim-1',
    direction: 'outgoing',
    remoteNumber: '2025550111',
    state: 'ended',
    startedAt: '2026-09-12T02:00:00.000Z',
    gatewayTimeZone: 'Asia/Shanghai',
  },
];

/** Only `/calls?…` is this panel's business; a row's 录音/转录/AI 对话 sections ask for their own things. */
function historyPaths(paths: readonly string[]): string[] {
  return paths.filter(requestPath => requestPath.startsWith('/calls?'));
}
function stub(paths: string[], body: (requestPath: string) => unknown) {
  return async <T,>(requestPath: string): Promise<T> => {
    paths.push(requestPath);
    if (!requestPath.startsWith('/calls?')) return {items: []} as T;
    return body(requestPath) as T;
  };
}

test('通话记录 asks for a server page, with the search and the SIM as query parameters', async () => {
  const {callHistoryQueryPath} = await load<typeof import('../src/call-history-panel.tsx')>(
    '/src/call-history-panel.tsx',
  );
  assert.equal(callHistoryQueryPath({page: 1, pageSize: 50}), '/calls?page=1&pageSize=50&includeBlocked=true');
  assert.equal(
    callHistoryQueryPath({page: 4, pageSize: 200, query: '  张三 ', simId: 'sim-1'}),
    '/calls?page=4&pageSize=200&includeBlocked=true&query=%E5%BC%A0%E4%B8%89&simId=sim-1',
  );
  assert.equal(
    callHistoryQueryPath({page: 2, pageSize: 100, query: '   ', simId: ''}),
    '/calls?page=2&pageSize=100&includeBlocked=true',
    'a blank box and an unset SIM add nothing',
  );
});

test('通话记录 renders the same rows, pages through the server and keeps 每页/跳转 on page 1 when a filter moves', async () => {
  const {CallHistoryPanel} = await load<typeof import('../src/call-history-panel.tsx')>(
    '/src/call-history-panel.tsx',
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = stub(paths, () => ({items: calls, page: 1, pageSize: 50, total: 137, totalPages: 3}));
    await act(async () => {
      renderer = create(
        React.createElement(CallHistoryPanel, {request, simId: 'sim-1', sims, sessionUsername: '小王', busy: false}),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(historyPaths(paths), ['/calls?page=1&pageSize=50&includeBlocked=true&simId=sim-1']);
    assert.equal(rows(renderer!).length, 2);
    const tree = collectText(renderer!.toJSON());
    // S95 row: the contact name is the title and the number leads the second line (both stay visible).
    const first = rows(renderer!)[0]!;
    assert.equal(collectText(first.findByType('strong')), '张三');
    assert.match(collectText(first), /2025550117呼入 · 已结束 · 48 秒/);
    assert.match(tree, /第 1 \/ 3 页 · 共 137 条/);

    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=2&pageSize=50&includeBlocked=true&simId=sim-1');

    await act(async () => {
      findButton(renderer!, '末页').props.onClick();
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=3&pageSize=50&includeBlocked=true&simId=sim-1');

    // 跳转到 any page, clamped to the last one.
    await act(async () => {
      renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'number')[0]!
        .props.onChange({target: {value: '1'}});
    });
    await act(async () => {
      renderer!.root.findByType('form').props.onSubmit({preventDefault: () => {}});
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=1&pageSize=50&includeBlocked=true&simId=sim-1');

    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
      await flush();
    });
    const before = historyPaths(paths).length;
    await act(async () => {
      renderer!.root.findByType('select').props.onChange({target: {value: '200'}});
      await flush();
    });
    assert.equal(historyPaths(paths).length, before + 1, '每页 costs one request, not two');
    assert.equal(historyPaths(paths).at(-1), '/calls?page=1&pageSize=200&includeBlocked=true&simId=sim-1');
  } finally {
    renderer?.unmount();
  }
});

test('搜索 goes back to page 1, and so does a new 号码 selection', async () => {
  const {CallHistoryPanel} = await load<typeof import('../src/call-history-panel.tsx')>(
    '/src/call-history-panel.tsx',
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = stub(paths, () => ({items: calls, page: 1, pageSize: 50, total: 137, totalPages: 3}));
    const element = (simId: string) =>
      React.createElement(CallHistoryPanel, {request, simId, sims, sessionUsername: '小王', busy: false});
    await act(async () => {
      renderer = create(element('sim-1'));
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      findButton(renderer!, '末页').props.onClick();
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=3&pageSize=50&includeBlocked=true&simId=sim-1');

    const search = renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'search')[0]!;
    assert.equal(search.props.placeholder, '搜索姓名或号码');
    let before = historyPaths(paths).length;
    await act(async () => {
      search.props.onChange({target: {value: '张三'}});
    });
    await act(async () => {
      await settleDebounce();
      await flush();
    });
    assert.equal(historyPaths(paths).length, before + 1, 'one request per pause in typing');
    assert.equal(
      historyPaths(paths).at(-1),
      '/calls?page=1&pageSize=50&includeBlocked=true&query=%E5%BC%A0%E4%B8%89&simId=sim-1',
      '搜索 re-enters the list at page 1',
    );

    await act(async () => {
      findButton(renderer!, '末页').props.onClick();
      await flush();
    });
    before = historyPaths(paths).length;
    await act(async () => {
      renderer!.update(element('sim-2'));
      await flush();
    });
    assert.equal(historyPaths(paths).length, before + 1, 'a new SIM costs one request, not two');
    assert.equal(
      historyPaths(paths).at(-1),
      '/calls?page=1&pageSize=50&includeBlocked=true&query=%E5%BC%A0%E4%B8%89&simId=sim-2',
    );
    assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'SIM 范围').length, 0, 'S64: no in-panel SIM selector; the 记录 SIM strip scopes it');
    // S64 全部 SIM 卡: '' drops the simId parameter.
    await act(async () => {
      renderer!.update(element(''));
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=1&pageSize=50&includeBlocked=true&query=%E5%BC%A0%E4%B8%89');
  } finally {
    renderer?.unmount();
  }
});

test('a reload keeps the page, and a pre-S28 {items} answer hides the pager but still shows the rows', async () => {
  const {CallHistoryPanel} = await load<typeof import('../src/call-history-panel.tsx')>(
    '/src/call-history-panel.tsx',
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = stub(paths, () => ({items: calls, page: 2, pageSize: 50, total: 137, totalPages: 3}));
    const element = (reloadToken: number) =>
      React.createElement(CallHistoryPanel, {request, simId: 'sim-1', sims, busy: false, reloadToken});
    await act(async () => {
      renderer = create(element(0));
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=2&pageSize=50&includeBlocked=true&simId=sim-1');
    await act(async () => {
      renderer!.update(element(1));
      await flush();
    });
    assert.equal(historyPaths(paths).at(-1), '/calls?page=2&pageSize=50&includeBlocked=true&simId=sim-1',
      '屏蔽/解除 reloads the page the reader is on, it does not throw them back to page 1');
    renderer!.unmount();

    paths.length = 0;
    await act(async () => {
      renderer = create(
        React.createElement(CallHistoryPanel, {
          request: stub(paths, () => ({items: calls})),
          simId: 'sim-1',
          sims,
          busy: false,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.equal(historyPaths(paths).length, 1);
    assert.equal(renderer!.root.findAll(node => node.props?.className === 'pager').length, 0, 'no pager');
    assert.equal(rows(renderer!).length, 2, 'the rows still render');
  } finally {
    renderer?.unmount();
  }
});

test('a call row is reachable from the keyboard and Enter opens its contact card',async()=>{
  const {CallHistoryPanel}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  let renderer:ReactTestRenderer|undefined;const opened:string[]=[];
  try{
    await act(async()=>{
      renderer=create(React.createElement(CallHistoryPanel,{
        request:stub([],()=>({items:[calls[0]]})),simId:'sim-1',sims,busy:false,
        onOpenCard:call=>opened.push(call.id),
      }));
      await flush();
    });
    const row=rows(renderer!)[0]!;
    assert.equal(row.props.tabIndex,0);
    assert.match(row.props['aria-label'],/按回车打开联系人卡片/);
    assert.match(row.props['aria-label'],/2025550117 · 张三/,'the accessible name keeps 号码 · 姓名 from S21 §F');
    let prevented=false;
    await act(async()=>row.props.onKeyDown({key:'Enter',target:row,currentTarget:row,preventDefault:()=>{prevented=true;}}));
    assert.equal(prevented,true);
    assert.deepEqual(opened,['call-1']);
  }finally{renderer?.unmount();}
});

test('S38：手机直拨与忙线冲突的行有自己的文字，手机通话不给结束按钮',async()=>{
  const {CallList}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const outgoing=calls[1]!;
  const s38:Call[]=[
    {...outgoing,id:'call-pixel',state:'active',originatingPlatform:'pixel'},
    {...outgoing,id:'call-rejected',direction:'incoming',state:'failed',failureReason:'busy_auto_rejected',conflictDisposition:'rejected'},
    {...outgoing,id:'call-ai',direction:'incoming',answeredByPlatform:'ai',conflictDisposition:'ai_answered'},
    {...outgoing,id:'call-web',state:'active',claimedByCurrentSession:true},
  ];
  let renderer:ReactTestRenderer|undefined;
  try{
    await act(async()=>{
      renderer=create(React.createElement(CallList,{calls:s38,sims,sessionUsername:'小王',busy:false,onAction:async()=>{}}));
    });
    const text=collectText(renderer!.toJSON());
    assert.match(text,/发起：通过手机拨打/);
    assert.match(text,/呼入 · 忙线未接/);
    assert.match(text,/忙线 AI 代接/);
    const endButtons=renderer!.root.findAll(node=>node.type==='button'&&collectText(node).includes('结束通话'));
    assert.equal(endButtons.length,1,'只有本会话的网页通话可结束；手机直拨的通话没有结束按钮');
  }finally{renderer?.unmount();}
});

test('S38b：被拦截的来电带 ⃠ 标记与拦截来源文字，未被拦截的行不受影响',async()=>{
  const {CallList}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const incoming=calls[0]!;
  const marks=(renderer:ReactTestRenderer)=>
    renderer.root.findAll(node=>node.props?.className==='blocked-mark').length;
  let renderer:ReactTestRenderer|undefined;
  try{
    await act(async()=>{
      renderer=create(React.createElement(CallList,{calls,sims,sessionUsername:'小王',busy:false}));
    });
    assert.equal(marks(renderer!),0,'普通通话没有拦截标记');
    renderer!.unmount();
    const intercepted:Call[]=[
      {...incoming,id:'call-phone',state:'failed',failureReason:'number_blocked',blockedSource:'phone',answeredAt:undefined,endedAt:undefined},
      {...incoming,id:'call-legacy',state:'failed',failureReason:'number_blocked',blockedSource:null,answeredAt:undefined,endedAt:undefined},
    ];
    await act(async()=>{
      renderer=create(React.createElement(CallList,{calls:intercepted,sims,sessionUsername:'小王',busy:false}));
    });
    assert.equal(marks(renderer!),2,'两行都带 ⃠ 标记，即使号码并不在屏蔽名单上');
    const text=collectText(renderer!.toJSON());
    assert.match(text,/手机自动拦截/);
    assert.match(text,/已拦截/,'没有 blockedSource 的旧记录退回到「已拦截」');
  }finally{renderer?.unmount();}
});

test('未接来电：只有没接起、已结束或失败、未被拦截的来电，行里显示红色「未接来电」',async()=>{
 const {missedIncomingCall,CallList}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
 const incoming=calls[0]!,missed={...incoming,answeredAt:undefined};
 assert.equal(missedIncomingCall(incoming),false,'接起的来电');
 assert.equal(missedIncomingCall(missed),true);
 assert.equal(missedIncomingCall({...missed,state:'failed'}),true);
 assert.equal(missedIncomingCall({...missed,state:'failed',failureReason:'number_blocked'}),false);
 assert.equal(missedIncomingCall(calls[1]!),false,'没接通的呼出');
 assert.equal(missedIncomingCall({...missed,state:'incoming_ringing'}),false);
 let renderer:ReactTestRenderer|undefined;
 try{
  await act(async()=>{renderer=create(React.createElement(CallList,{calls:[missed,incoming],sims,busy:false}));});
  const marked=renderer!.root.findAll(node=>node.type==='small'&&node.props.className==='missed');
  assert.equal(marked.length,1);
  assert.equal(collectText(marked[0]),'呼入 · 未接来电');
  assert.match(collectText(rows(renderer!)[0]),/家庭卡/,'未接来电仍显示被叫的卡（名称优先）');
 }finally{renderer?.unmount();}
});

test('S58: row owner shows platform labels, never raw ids',async()=>{
 const {callRowOwner}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
 const base={id:'c',direction:'outgoing',state:'ended',startedAt:'2026-09-24T00:00:00Z',simId:'s'} as any;
 assert.equal(callRowOwner({...base,originatingPlatform:'macos'}),'Mac 端');
 assert.equal(callRowOwner({...base,direction:'incoming',answeredByPlatform:'ios'}),'iPhone 端');
 assert.equal(callRowOwner({...base,originatingPlatform:'pixel',gatewayKind:'dji4g'}),'通过 DJI 4G 模组拨打');
 assert.equal(callRowOwner({...base,originatingPlatform:'some_new_platform'}),undefined,'S95b §C: an unknown platform id is not shown raw');
});

test('a background reload leaves the pager usable, and AI 对话 is an on-demand toggle only on AI-answered rows', async () => {
  const {CallHistoryPanel} = await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    let hang = false;
    const aiCalls = [{...calls[0]!, answeredByPlatform: 'ai'}, calls[1]!];
    const request = stub(paths, () => hang ? new Promise(() => {}) : {items: aiCalls, total: 137, totalPages: 3});
    const element = (reloadToken: number) => React.createElement(CallHistoryPanel, {request, simId: 'sim-1', sims, busy: false, reloadToken});
    await act(async () => { renderer = create(element(0)); });
    await act(async () => { await flush(); });
    hang = true;
    await act(async () => { renderer!.update(element(1)); await flush(); });
    assert.equal(findButton(renderer!, '下一页').props.disabled, false, 'an in-flight refresh must not swallow the click');
    assert.equal(paths.filter(p => p.endsWith('/ai-transcript')).length, 0, 'nothing fetched before the toggle is opened');
    const toggles = renderer!.root.findAll(node => node.type === 'button' && collectText(node) === 'AI 对话');
    assert.equal(toggles.length, 1, 'only the AI-answered row offers AI 对话');
    await act(async () => { toggles[0]!.props.onClick(); await flush(); });
    assert.deepEqual(paths.filter(p => p.endsWith('/ai-transcript')), ['/calls/call-1/ai-transcript']);
  } finally {
    renderer?.unmount();
  }
});

test('搜索/页码/每页 survive a remount through sessionStorage, and a stale page lands on the last page without an empty list', async () => {
  const {CallHistoryPanel} = await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const store = new Map<string, string>([['k', JSON.stringify({search: '张三', page: 3, pageSize: 100, simId: 'sim-1'})], ['bad', '{"page":-2,"pageSize":7}']]);
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }}});
  const paths: string[] = [];
  const texts: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    // The saved page 3 is past the end now (2 pages): the list must go straight to page 2, never through "还没有通话记录".
    const request = stub(paths, requestPath => {
      if (renderer) texts.push(collectText(renderer.toJSON()));
      return {items: requestPath.includes('page=2') ? calls : [], total: 150, totalPages: 2};
    });
    await act(async () => { renderer = create(React.createElement(CallHistoryPanel, {request, simId: 'sim-1', sims, storageKey: 'k'})); });
    await act(async () => { await flush(); });
    await act(async () => { await flush(); });
    assert.deepEqual(historyPaths(paths).slice(0, 2), [
      '/calls?page=3&pageSize=100&includeBlocked=true&query=%E5%BC%A0%E4%B8%89&simId=sim-1',
      '/calls?page=2&pageSize=100&includeBlocked=true&query=%E5%BC%A0%E4%B8%89&simId=sim-1',
    ]);
    assert.equal(texts.some(text => text.includes('还没有通话记录')), false);
    assert.equal(rows(renderer!).length, 2);
    assert.deepEqual(JSON.parse(store.get('k')!), {search: '张三', page: 2, pageSize: 100, simId: 'sim-1'});
    await act(async () => renderer!.unmount());
    renderer = undefined;

    // Another SIM keeps the search and page size but starts on page 1; junk values fall back to defaults.
    paths.length = 0;
    await act(async () => { renderer = create(React.createElement(CallHistoryPanel, {request, simId: 'sim-2', sims, storageKey: 'k'})); });
    assert.equal(historyPaths(paths)[0], '/calls?page=1&pageSize=100&includeBlocked=true&query=%E5%BC%A0%E4%B8%89&simId=sim-2');
    await act(async () => renderer!.unmount());
    paths.length = 0;
    await act(async () => { renderer = create(React.createElement(CallHistoryPanel, {request, simId: 'sim-1', sims, storageKey: 'bad'})); });
    assert.equal(historyPaths(paths)[0], '/calls?page=1&pageSize=50&includeBlocked=true&simId=sim-1');
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    if (prior) Object.defineProperty(globalThis, 'sessionStorage', prior);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('S72：内部通话行写「内部通话 A → B」，振铃写「来自 A（内部）」，未接不算未接来电，本机接听写网关本机',async()=>{
  const {CallList,missedIncomingCall}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const base=calls[0]!;
  const rows:Call[]=[
    {...base,id:'int-ended',direction:'incoming',state:'ended',answeredAt:undefined,internal:true,peerSimLabel:'联通186'},
    {...base,id:'int-ring',direction:'incoming',state:'incoming_ringing',answeredAt:undefined,internal:true,peerSimLabel:'联通186'},
    {...base,id:'dev',direction:'incoming',state:'ended',answeredAt:base.startedAt,answeredByPlatform:'device'},
  ];
  assert.equal(missedIncomingCall(rows[0]!),false);
  let renderer:ReactTestRenderer|undefined;
  try{
    await act(async()=>{renderer=create(React.createElement(CallList,{calls:rows,sims,busy:false,onAction:async()=>{}}));});
    const text=collectText(renderer!.toJSON());
    assert.match(text,/内部通话 联通186 → 家庭卡/);
    assert.match(text,/来自 联通186（内部）/);
    assert.doesNotMatch(text,/未接来电/);
    assert.match(text,/接听：网关本机/);
  }finally{renderer?.unmount();}
});

test('S81：未接听的振铃行显示被叫 SIM，DTO simLabel 优先，其次名称、号码',async()=>{
  const {CallList}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const ring:Call={...calls[0]!,id:'ring',state:'incoming_ringing',answeredAt:undefined,endedAt:undefined};
  const simText=async(call:Call,list:Sim[])=>{
    let renderer:ReactTestRenderer|undefined;
    try{
      await act(async()=>{renderer=create(React.createElement(CallList,{calls:[call],sims:list,busy:false,onAction:async()=>{}}));});
      assert.ok(findButton(renderer!,'接听'),'振铃行有接听按钮');
      const small=renderer!.root.findAll(node=>node.type==='small'&&node.props.className==='call-record-sim');
      return small.length?collectText(small[0]):'';
    }finally{renderer?.unmount();}
  };
  assert.match(await simText({...ring,simLabel:'工作卡'},sims),/^工作卡 · /);
  assert.match(await simText(ring,sims),/^家庭卡 · /);
  assert.match(await simText(ring,[{...sims[0]!,label:''}]),/^2025550116 · /);
  assert.equal(await simText({...ring,simLabel:'工作卡'},[]),'工作卡','SIM 列表未加载时仍显示 DTO simLabel');
});

test('S95：记录按网关时区分组为 今天 / 昨天 / 本周 / 日期，方向图标只看现有字段',async()=>{
  const {callDateGroup,callDirectionKind,relativeCallTime}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const now=new Date('2026-09-17T04:00:00.000Z'); // 周四 12:00 Asia/Shanghai
  const zone='Asia/Shanghai';
  assert.equal(callDateGroup('2026-09-16T16:30:00.000Z',zone,now),'今天','00:30 local is already today');
  assert.equal(callDateGroup('2026-09-16T15:30:00.000Z',zone,now),'昨天');
  assert.equal(callDateGroup('2026-09-14T02:00:00.000Z',zone,now),'本周','周一 belongs to this week');
  assert.equal(callDateGroup('2026-09-13T02:00:00.000Z',zone,now),'9月13日','周日 is last week');
  assert.equal(callDateGroup('2025-12-31T02:00:00.000Z',zone,now),'2025年12月31日');
  assert.equal(relativeCallTime('2026-09-17T01:05:00.000Z',zone,now),'今天 09:05');
  assert.equal(relativeCallTime('2026-09-16T12:16:00.000Z',zone,now),'昨天 20:16');
  assert.equal(relativeCallTime('2026-09-15T02:21:00.000Z',zone,now),'周二 10:21');
  assert.equal(relativeCallTime('2026-09-13T02:00:00.000Z',zone,now),'9/13');
  const base=calls[0]!;
  assert.equal(callDirectionKind(base),'incoming');
  assert.equal(callDirectionKind(calls[1]!),'outgoing');
  assert.equal(callDirectionKind({...base,answeredAt:undefined}),'missed');
  assert.equal(callDirectionKind({...base,answeredByPlatform:'ai'}),'ai');
  assert.equal(callDirectionKind({...base,state:'failed',failureReason:'number_blocked',answeredAt:undefined}),'blocked');
  assert.equal(callDirectionKind({...base,blocked:true}),'incoming','a number blocked later keeps the direction icon');
  assert.equal(callDirectionKind({...calls[1]!,state:'failed'}),'outgoing','a failed call is not a blocked call');
});

test('S95 宽屏：列表行不挂录音/转录，选中后详情面板打开，并只在详情里拉取 AI 对话',async()=>{
  const {CallHistoryPanel}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  const priorFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:404});
  Object.defineProperty(globalThis,'matchMedia',{configurable:true,value:()=>({matches:true,addEventListener(){},removeEventListener(){}})});
  let renderer:ReactTestRenderer|undefined;const paths:string[]=[];const opened:string[]=[];
  try{
    const id='33000000-0000-4000-8000-000000000001';
    const aiCalls=[{...calls[0]!,id,answeredByPlatform:'ai'},calls[1]!];
    await act(async()=>{renderer=create(React.createElement(CallHistoryPanel,{request:stub(paths,()=>({items:aiCalls,total:2,totalPages:1})),simId:'sim-1',sims,busy:false,onOpenCall:call=>opened.push(call.id)}));});
    await act(async()=>{await flush();});
    assert.equal(renderer!.root.findAll(node=>node.props?.className==='records-detail-pane').length,1);
    assert.equal(renderer!.root.findAll(node=>node.props?.className==='record-media-actions').length,0,'rows carry no media sections in the wide layout');
    assert.equal(renderer!.root.findAll(node=>node.type==='button'&&/AI 对话/.test(collectText(node))).length,0);
    await act(async()=>{const row=rows(renderer!)[0]!;row.props.onKeyDown({key:'Enter',target:row,currentTarget:row,preventDefault(){}});await flush();});
    assert.equal(rows(renderer!)[0]!.props['aria-current'],'true');
    assert.deepEqual(opened,[id]);
    assert.equal(renderer!.root.findAll(node=>node.type==='button'&&collectText(node)==='收起 AI 对话').length,1);
    assert.ok(paths.includes(`/calls/${id}/ai-transcript`),'the detail pane opens the AI transcript on select');
  }finally{
    renderer?.unmount();
    Reflect.deleteProperty(globalThis,'matchMedia');
    globalThis.fetch=priorFetch;
  }
});

test('S95b §C：未知状态不显示原始枚举',async()=>{
  const {CallList}=await load<typeof import('../src/call-history-panel.tsx')>('/src/call-history-panel.tsx');
  let renderer:ReactTestRenderer|undefined;
  try{
    await act(async()=>{renderer=create(React.createElement(CallList,{calls:[{...calls[1]!,state:'weird_internal_state'}],sims,busy:false}));});
    const text=collectText(renderer!.toJSON());
    assert.doesNotMatch(text,/weird_internal_state/);
    assert.match(text,/呼出 · 状态待核实/);
  }finally{renderer?.unmount();}
});
