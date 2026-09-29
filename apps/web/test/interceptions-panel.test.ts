import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {InterceptionItem, InterceptionRow} from '../src/interceptions.ts';

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

const items: InterceptionItem[] = [
  {
    id: 'i-1',
    kind: 'call',
    simId: 'sim-1',
    remoteNumber: '2025550117',
    contactId: 'c-1',
    contactName: '张三',
    occurredAt: '2026-09-11T09:00:00.000Z',
    blockedEntryId: 'entry-1',
    source: 'gateway',
  },
  {
    id: 'i-2',
    kind: 'sms',
    simId: 'sim-1',
    remoteNumber: '202 555 0198',
    occurredAt: '2026-09-11T10:30:00.000Z',
    bodyPreview: '【某商城】双十一大促\n点击领取优惠券',
    blockedEntryId: 'entry-2',
    source: 'control',
  },
];

test('拦截记录 lists kind, number·name, time and the SMS preview, and opens the card on click', async () => {
  const {InterceptionsPanel} = await load<typeof import('../src/interceptions-panel.tsx')>(
    '/src/interceptions-panel.tsx',
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    const opened: InterceptionRow[] = [];
    const request = async <T,>(requestPath: string): Promise<T> => {
      assert.equal(requestPath, '/blocklist/interceptions?page=1&pageSize=50&kind=all');
      return {items} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(InterceptionsPanel, {
          request,
          busy: false,
          timeZone: 'Asia/Shanghai',
          sims: [{id: 'sim-1', phoneLabel: '上海工作卡', timeZone: 'Asia/Shanghai'}],
          onOpenRow: row => opened.push(row),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const rows = renderer!.root.findAll(node => node.props?.className === 'record interception-row');
    assert.equal(rows.length, 2);
    // Newest first, regardless of the order the server used.
    assert.match(collectText(rows[0]!), /202 555 0198/);
    assert.match(collectText(rows[0]!), /短信/);
    assert.match(collectText(rows[0]!), /服务器拦截/);
    assert.match(collectText(rows[0]!), /【某商城】双十一大促 点击领取优惠券/, 'the preview is one line');
    assert.match(collectText(rows[1]!), /2025550117 · 张三/);
    assert.match(collectText(rows[1]!), /来电/);
    assert.match(collectText(rows[1]!), /网关拦截/);
    assert.match(collectText(rows[1]!), /上海工作卡/, 'the row identifies its own SIM instead of the selected SIM');
    assert.deepEqual(
      renderer!.root.findAllByType('time').map(node => node.props.dateTime),
      ['2026-09-11T10:30:00.000Z', '2026-09-11T09:00:00.000Z'],
      'timestamps stay machine readable',
    );
    assert.equal(rows[1]!.props['aria-label'], '来电 2025550117 · 张三');

    await act(async () => {
      rows[1]!.props.onClick();
    });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.blockedEntryId, 'entry-1', 'the card gets the entry it needs to unblock');
    assert.equal(opened[0]!.remoteNumber, '2025550117');
    assert.equal(opened[0]!.simId, 'sim-1');
  } finally {
    renderer?.unmount();
  }
});

test('拦截记录 pages through the server, and a legacy {items} answer hides the pager but keeps the rows', async () => {
  const {InterceptionsPanel, interceptionsQueryPath} = await load<typeof import('../src/interceptions-panel.tsx')>(
    '/src/interceptions-panel.tsx',
  );
  assert.equal(interceptionsQueryPath({page: 3, pageSize: 200}), '/blocklist/interceptions?page=3&pageSize=200&kind=all');
  assert.equal(interceptionsQueryPath({page: 1, pageSize: 50, kind: 'sms', simId: ''}), '/blocklist/interceptions?page=1&pageSize=50&kind=sms');
  assert.equal(interceptionsQueryPath({page: 1, pageSize: 50, simId: 'sim 1'}), '/blocklist/interceptions?page=1&pageSize=50&kind=all&simId=sim%201');

  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = async <T,>(requestPath: string): Promise<T> => {
      paths.push(requestPath);
      return {items, page: 1, pageSize: 50, total: 137, totalPages: 3} as T;
    };
    await act(async () => {
      renderer = create(React.createElement(InterceptionsPanel, {request, busy: false, timeZone: 'Asia/Shanghai'}));
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(paths.filter(path => path.includes('/interceptions')), ['/blocklist/interceptions?page=1&pageSize=50&kind=all']);
    assert.ok(paths.includes('/blocklist?scope=call') && paths.includes('/blocklist?scope=sms'), 'both current blocklists are independently refreshed');
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 3 页 · 共 137 条/);

    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
      await flush();
    });
    assert.equal(paths.filter(path => path.includes('/interceptions')).at(-1), '/blocklist/interceptions?page=2&pageSize=50&kind=all');

    await act(async () => {
      renderer!.root.findByType('select').props.onChange({target: {value: '200'}});
      await flush();
    });
    assert.equal(paths.filter(path => path.includes('/interceptions')).at(-1), '/blocklist/interceptions?page=1&pageSize=200&kind=all', '每页 resets to the first page');
    renderer!.unmount();

    paths.length = 0;
    await act(async () => {
      renderer = create(
        React.createElement(InterceptionsPanel, {
          request: async <T,>(requestPath: string): Promise<T> => {
            paths.push(requestPath);
            return {items} as T;
          },
          busy: false,
          timeZone: 'Asia/Shanghai',
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.equal(paths.filter(path => path.includes('/interceptions')).length, 1, 'the pre-S28 interception route is asked once');
    assert.equal(renderer!.root.findAll(node => node.props?.className === 'pager').length, 0, 'no pager');
    assert.equal(renderer!.root.findAll(node => node.props?.className === 'record interception-row').length, 2);
  } finally {
    renderer?.unmount();
  }
});

test('S64: the 记录 SIM scope goes to the server, filters an old Control client-side, and sends the list back to page 1', async () => {
  const {InterceptionsPanel} = await load<typeof import('../src/interceptions-panel.tsx')>('/src/interceptions-panel.tsx');
  const paths: string[] = [];
  const request = async <T,>(requestPath: string): Promise<T> => { paths.push(requestPath); return {items, total: 137, totalPages: 3} as T; };
  const element = (simId: string) => React.createElement(InterceptionsPanel, {request, busy: false, simId});
  const listed = () => paths.filter(path => path.includes('/interceptions'));
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(element('')); await flush(); });
    assert.equal(listed().at(-1), '/blocklist/interceptions?page=1&pageSize=50&kind=all');
    await act(async () => { findButton(renderer!, '下一页').props.onClick(); await flush(); });
    const before = listed().length;
    await act(async () => { renderer!.update(element('sim-2')); await flush(); });
    assert.equal(listed().length, before + 1, 'a new SIM costs one request, not two');
    assert.equal(listed().at(-1), '/blocklist/interceptions?page=1&pageSize=50&kind=all&simId=sim-2');
    assert.equal(renderer!.root.findAll(node => node.props?.className === 'record interception-row').length, 0, 'sim-1 rows from an old Control are hidden');
  } finally {
    renderer?.unmount();
  }
});

test('the current blocklist directly unblocks a number with no contact or call row', async () => {
  const {InterceptionsPanel} = await load<typeof import('../src/interceptions-panel.tsx')>('/src/interceptions-panel.tsx');
  const seen: {path:string;method?:string}[]=[];
  let changed=0;
  const request=async<T,>(requestPath:string,_body?:unknown,method?:string):Promise<T>=>{
    seen.push({path:requestPath,method});
    if(requestPath==='/blocklist?scope=call')return {items:[{id:'blocked-only',remoteNumber:'2025550127'}]} as T;
    return {items:[],page:1,pageSize:50,total:0,totalPages:1} as T;
  };
  let renderer:ReactTestRenderer|undefined;
  try{
    await act(async()=>{renderer=create(React.createElement(InterceptionsPanel,{request,busy:false,onChanged:()=>changed++}));await flush();});
    assert.match(findButton(renderer!,'解除屏蔽').props.className,/\bhangup\b/);
    await act(async()=>findButton(renderer!,'解除屏蔽').props.onClick());
    await act(async()=>{findButton(renderer!,'确认解除').props.onClick();await flush();});
    assert.ok(seen.some(entry=>entry.path==='/blocklist/blocked-only'&&entry.method==='DELETE'));
    assert.equal(changed,1);
  }finally{renderer?.unmount();}
});

test('an empty or missing interception route reads as "nothing was intercepted", not as a failure', async () => {
  const {InterceptionsPanel} = await load<typeof import('../src/interceptions-panel.tsx')>(
    '/src/interceptions-panel.tsx',
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        React.createElement(InterceptionsPanel, {
          request: async <T,>(): Promise<T> => {
            throw Object.assign(new Error('请求失败 (404)'), {status: 404, code: 'HTTP_404'});
          },
          busy: false,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /此服务器尚未启用拦截记录。/);
    assert.equal(renderer!.root.findAll(node => node.props?.role === 'alert').length, 0);
  } finally {
    renderer?.unmount();
  }
});

test('the AI 对话 block only appears when the call actually has a live transcript', async () => {
  const {AiTranscript} = await load<typeof import('../src/ai-transcript.tsx')>('/src/ai-transcript.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = async <T,>(requestPath: string): Promise<T> => {
      paths.push(requestPath);
      if (requestPath.includes('call-ai')) {
        return {
          items: [
            {role: 'ai', text: '你好，我是 AI 助理，请问有什么可以帮您？', at: '2026-09-11T09:00:01.000Z'},
            {role: 'caller', text: '我想问一下快递', at: '2026-09-11T09:00:06.000Z'},
            {role: 'ai', text: '   '},
          ],
        } as T;
      }
      return {items: []} as T;
    };

    await act(async () => {
      renderer = create(React.createElement(AiTranscript, {callId: 'call-ai', request}));
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /AI 对话/);
    assert.match(text, /AI 助理/);
    assert.match(text, /你好，我是 AI 助理/);
    assert.match(text, /对方/);
    assert.match(text, /我想问一下快递/);
    assert.equal(renderer!.root.findAllByType('p').length, 3, 'a blank line is dropped, the footnote stays');
    renderer!.unmount();

    await act(async () => {
      renderer = create(React.createElement(AiTranscript, {callId: 'call-plain', request}));
    });
    await act(async () => {
      await flush();
    });
    assert.equal(renderer!.toJSON(), null, 'a normal call renders nothing at all');
    renderer!.unmount();

    paths.length = 0;
    await act(async () => {
      renderer = create(React.createElement(AiTranscript, {callId: 'call-ringing', request, settled: false}));
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(paths, [], 'a call still in progress is not polled');
    assert.equal(renderer!.toJSON(), null);
  } finally {
    renderer?.unmount();
  }
});

test('a missing ai-transcript route is silent', async () => {
  const {AiTranscript, aiTranscriptRoleLabel} = await load<typeof import('../src/ai-transcript.tsx')>(
    '/src/ai-transcript.tsx',
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    assert.equal(aiTranscriptRoleLabel('ai'), 'AI 助理');
    assert.equal(aiTranscriptRoleLabel('caller'), '对方');
    assert.equal(aiTranscriptRoleLabel(undefined), '通话');
    await act(async () => {
      renderer = create(
        React.createElement(AiTranscript, {
          callId: 'call-1',
          request: async <T,>(): Promise<T> => {
            throw Object.assign(new Error('请求失败 (404)'), {status: 404});
          },
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.equal(renderer!.toJSON(), null);
  } finally {
    renderer?.unmount();
  }
});


test('S47 shared blocklist is collapsed and searchable; kind filters retain phone interceptions and paging', async () => {
  const {InterceptionsPanel} = await load<typeof import('../src/interceptions-panel.tsx')>('/src/interceptions-panel.tsx');
  const paths: string[] = [];
  const phone = {...items[0]!, id: 'phone', source: 'phone'};
  const request = async <T,>(url: string): Promise<T> => {
    paths.push(url);
    const kind = new URL(url, 'http://fixture.invalid').searchParams.get('kind');
    return (url === '/blocklist?scope=sms' ? {items: []} : url === '/blocklist?scope=call' ? {items: [
      {id: 'one', remoteNumber: '+1 202-555-0111', contactName: '联系人'},
      {id: 'two', remoteNumber: '2025550127'},
    ]} : {items: [...items, phone].filter(item => kind === 'all' || item.kind === kind), total: kind === 'all' ? 137 : kind === 'call' ? 100 : 37, totalPages: kind === 'all' ? 3 : kind === 'call' ? 2 : 1}) as T;
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {renderer = create(React.createElement(InterceptionsPanel, {request, busy: false})); await flush();});
    const manager = renderer!.root.findByType('details');
    assert.ok(!manager.props.open, 'native disclosure starts collapsed');
    assert.match(collectText(manager.findByType('summary')), /管理已屏蔽号码（来电 2 · 短信 0）/);
    const search = manager.findByType('input');
    assert.equal(search.props.type, 'search');
    await act(async () => search.props.onChange({target: {value: '2025550111'}}));
    const blockedRows = () => manager.findAll(node => node.props.className === 'record blocklist-row');
    assert.equal(blockedRows().length, 1);
    assert.match(collectText(blockedRows()[0]), /联系人/);
    await act(async () => search.props.onChange({target: {value: '999'}}));
    assert.equal(blockedRows().length, 0);
    assert.match(collectText(manager), /没有匹配/);
    await act(async () => search.props.onChange({target: {value: ''}}));
    assert.equal(blockedRows().length, 2);
    const rows = () => renderer!.root.findAll(node => node.props.className === 'record interception-row');
    assert.equal(rows().length, 3);
    assert.match(collectText(rows()), /手机自动拦截/);
    const filters = renderer!.root.findByProps({'aria-label': '拦截类型'}).findAllByType('button');
    await act(async () => filters[1]!.props.onClick());
    assert.equal(rows().length, 2);
    assert.match(collectText(rows()), /手机自动拦截/);
    await act(async () => filters[2]!.props.onClick());
    assert.equal(rows().length, 1);
    assert.match(collectText(rows()), /服务器拦截/);
    await act(async () => filters[0]!.props.onClick());
    assert.equal(rows().length, 3);
    assert.deepEqual(filters.map(button => button.props['aria-pressed']), [true, false, false]);
    assert.equal(paths.length, 6, 'search stays local; each kind change requests server-filtered records');
    assert.ok(paths[3]!.endsWith('&kind=call'));
    assert.ok(paths[4]!.endsWith('&kind=sms'));
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 3 页 · 共 137 条/);
  } finally {
    await act(async () => renderer?.unmount());
  }
});


test('S47 server kind filtering finds a later-page phone interception on page one with filtered counts', async () => {
  const {InterceptionsPanel} = await load<typeof import('../src/interceptions-panel.tsx')>('/src/interceptions-panel.tsx');
  const phone: InterceptionItem = {
    id: 'phone-later-page', kind: 'call', remoteNumber: '2025550126',
    occurredAt: '2026-09-10T00:00:00Z', source: 'phone', blockedEntryId: null,
  };
  const paths: string[] = [];
  const request = async <T,>(url: string): Promise<T> => {
    if (url.startsWith('/blocklist?')) return {items: []} as T;
    paths.push(url);
    const params = new URL(url, 'http://fixture.invalid').searchParams;
    if (params.get('kind') === 'call') return {items: [phone], total: 1, totalPages: 1} as T;
    if (params.get('kind') === 'sms') return {items: [items[1]], total: 50, totalPages: 1} as T;
    return {items: params.get('page') === '2' ? [phone] : [items[1]], total: 51, totalPages: 2} as T;
  };
  let renderer: ReactTestRenderer | undefined;
  const opened: InterceptionRow[] = [];
  try {
    await act(async () => {renderer = create(React.createElement(InterceptionsPanel, {request, busy: false, onOpenRow: row => opened.push(row)})); await flush();});
    assert.doesNotMatch(collectText(renderer!.toJSON()), /手机自动拦截/);
    await act(async () => {findButton(renderer!, '下一页').props.onClick(); await flush();});
    assert.match(collectText(renderer!.toJSON()), /第 2 \/ 2 页 · 共 51 条/);
    const filters = renderer!.root.findByProps({'aria-label': '拦截类型'}).findAllByType('button');
    await act(async () => {filters[1]!.props.onClick(); await flush();});
    assert.equal(paths.at(-1), '/blocklist/interceptions?page=1&pageSize=50&kind=call');
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 1 页 · 共 1 条/);
    const row = renderer!.root.findByProps({className: 'record interception-row'});
    assert.match(collectText(row), /手机自动拦截/);
    assert.match(collectText(row), /2025550126/);
    await act(async () => row.props.onClick());
    assert.equal(opened[0]!.blockedEntryId, null);
    assert.equal(opened[0]!.sourceLabel, '手机自动拦截');
    await act(async () => {filters[2]!.props.onClick(); await flush();});
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 1 页 · 共 50 条/);
    assert.doesNotMatch(collectText(renderer!.toJSON()), /手机自动拦截/);
    await act(async () => {filters[0]!.props.onClick(); await flush();});
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 2 页 · 共 51 条/);
    await act(async () => {filters[1]!.props.onClick(); await flush();});
    assert.match(collectText(renderer!.toJSON()), /手机自动拦截/);
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 1 页 · 共 1 条/);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
