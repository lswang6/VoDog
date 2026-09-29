import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import {gatewayCalendarDate, shiftCalendarDate} from '../src/gateway-time.ts';
import {CONTACT_BLOCK_PROMPT} from '../src/contacts.ts';
import type {ReportItem} from '../src/reports.tsx';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).includes(label))[0];
}
function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
/** The search box debounces by 250 ms, exactly like 通讯录. */
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

const ZONE = 'Asia/Shanghai';
const items: ReportItem[] = [
  {
    callId: 'call-ad',
    startedAt: '2026-09-12T01:30:00.000Z',
    answeredAt: '2026-09-12T01:30:05.000Z',
    endedAt: '2026-09-12T01:30:53.000Z',
    direction: 'incoming',
    remoteNumber: '2025550117',
    contactName: '张三',
    blocked: false,
    sim: {id: 'sim-1', label: '家庭卡', slotIndex: 0},
    gatewayTimeZone: ZONE,
    answerMode: 'ai',
    answeredByPlatform: 'ai',
    recordingStatus: 'complete',
    transcriptState: 'succeeded',
    summary: '来电推销重疾险，用户已明确拒绝。',
    actionItems: ['本周内回电确认是否需要保单'],
    classification: 'advertising',
    blockRecommended: true,
    blockCategory: 'insurance',
    blockReason: '保险销售',
    hasAiTranscript: true,
  },
  {
    callId: 'call-legacy',
    startedAt: '2026-09-12T02:00:00.000Z',
    answeredAt: null,
    endedAt: '2026-09-12T02:00:20.000Z',
    direction: 'incoming',
    remoteNumber: '2025550111',
    sim: {id: 'sim-1', label: '家庭卡', slotIndex: 0},
    gatewayTimeZone: ZONE,
    answerMode: 'normal',
    transcriptState: 'none',
    summary: null,
    actionItems: [],
    blockRecommended: null,
    blockReason: null,
    hasAiTranscript: false,
  },
  {
    callId: 'call-blocked',
    startedAt: '2026-09-12T03:00:00.000Z',
    answeredAt: '2026-09-12T03:00:02.000Z',
    endedAt: '2026-09-12T03:02:12.000Z',
    direction: 'outgoing',
    remoteNumber: '2025550198',
    blocked: true,
    blockedEntryId: 'entry-9',
    sim: {id: 'sim-1', label: '家庭卡', slotIndex: 0},
    gatewayTimeZone: ZONE,
    answerMode: 'normal',
    answeredByPlatform: 'web',
    transcriptState: 'running',
    summary: null,
    actionItems: [],
    blockRecommended: false,
    hasAiTranscript: false,
  },
  {
    callId: 'call-failed',
    startedAt: '2026-09-12T04:00:00.000Z',
    answeredAt: '2026-09-12T04:00:40.000Z',
    endedAt: '2026-09-12T04:01:10.000Z',
    direction: 'incoming',
    remoteNumber: '2025550119',
    sim: {id: 'sim-1', label: '家庭卡', slotIndex: 0},
    gatewayTimeZone: ZONE,
    answerMode: 'timeout_ai',
    answeredByPlatform: 'ai',
    transcriptState: 'failed',
    transcriptError: {code: 'RECORDING_EMPTY'},
    summary: null,
    actionItems: [],
    blockRecommended: null,
    hasAiTranscript: false,
  },
  {
    callId: 'call-other-sim',
    startedAt: '2026-09-12T05:00:00.000Z',
    direction: 'incoming',
    remoteNumber: '2025550115',
    sim: {id: 'sim-2', label: '工作卡', slotIndex: 1},
    gatewayTimeZone: ZONE,
    answerMode: 'normal',
    transcriptState: 'none',
    actionItems: [],
    blockRecommended: null,
  },
];

test('报告 windows and the request path are built from calendar days in the gateway zone', async () => {
  const {reportWindowRange, reportQueryPath, REPORT_PRESETS} = await load<typeof import('../src/reports.tsx')>(
    '/src/reports.tsx',
  );
  assert.deepEqual(REPORT_PRESETS.map(([value]) => value), ['today', '7d', '30d', 'custom']);
  assert.deepEqual(REPORT_PRESETS.map(([, label]) => label), ['今天', '7 天', '30 天', '自定义']);

  assert.deepEqual(reportWindowRange('today', '2026-09-12'), {from: '2026-09-12', to: '2026-09-12'});
  assert.deepEqual(reportWindowRange('7d', '2026-09-12'), {from: '2026-09-06', to: '2026-09-12'},
    '7 天 is an inclusive seven-day window ending today');
  assert.deepEqual(reportWindowRange('30d', '2026-09-12'), {from: '2026-08-14', to: '2026-09-12'});
  assert.deepEqual(reportWindowRange('7d', '2026-03-03'), {from: '2026-02-25', to: '2026-03-03'},
    'day arithmetic crosses a month boundary');
  assert.equal(reportWindowRange('custom', '2026-09-12'), null, '自定义 keeps whatever the two date inputs hold');

  assert.equal(
    reportQueryPath({timeZone: ZONE, from: '2026-09-06', to: '2026-09-12'}),
    '/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12',
  );
  assert.equal(
    reportQueryPath({timeZone: ZONE, from: '2026-09-06', to: '2026-09-12', query: '  张三 '}),
    '/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&query=%E5%BC%A0%E4%B8%89',
  );
  assert.doesNotMatch(reportQueryPath({timeZone: ZONE, from: '2026-09-06', to: '2026-09-12'}), /period=/,
    'S22 sends from/to; period stays server-side compatibility only');
  assert.equal(
    reportQueryPath({timeZone: ZONE, from: '2026-09-06', to: '2026-09-12', page: 2, pageSize: 100, query: '张三', simId: 'sim-1'}),
    '/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&page=2&pageSize=100&query=%E5%BC%A0%E4%B8%89&simId=sim-1',
    'S28 appends page/pageSize and the SIM filter',
  );
  assert.doesNotMatch(
    reportQueryPath({timeZone: ZONE, from: '2026-09-06', to: '2026-09-12', simId: 'sim-1'}),
    /page=/,
    'the pure helper only pages when it is given a page',
  );
});

test('接听方式, 时长 and the summary placeholders read from the report item', async () => {
  const {answerModeLabel, transcriptPlaceholder, reportDisplayName, callDurationLabel, talkDuration} =
    await load<typeof import('../src/reports.tsx')>('/src/reports.tsx');

  assert.equal(answerModeLabel({answerMode: 'ai', answeredByPlatform: 'ai', answeredAt: 'x'}), 'AI 接听');
  assert.equal(answerModeLabel({answerMode: 'timeout_ai', answeredByPlatform: 'ai', answeredAt: 'x'}), '超时 AI');
  assert.equal(answerModeLabel({answerMode: 'normal', answeredByPlatform: 'web', answeredAt: 'x'}), '真人');
  assert.equal(answerModeLabel({answerMode: 'timeout_ai', answeredByPlatform: 'ios', answeredAt: 'x'}), '真人',
    'a human who grabbed a timeout_ai call answered it');
  assert.equal(answerModeLabel({answerMode: 'ai', answeredByPlatform: 'ai', answeredAt: null}), '未接');
  assert.equal(answerModeLabel({answerMode: 'normal', answeredAt: null}), '未接');

  assert.equal(transcriptPlaceholder('none'), '无转录：录音为空');
  assert.equal(transcriptPlaceholder('queued'), '转录处理中…');
  assert.equal(transcriptPlaceholder('running'), '转录处理中…');
  assert.equal(transcriptPlaceholder('retry'), '转录处理中…');
  assert.equal(transcriptPlaceholder('failed'), '转录失败，原始录音仍可查看');
  assert.equal(transcriptPlaceholder('succeeded'), null);
  assert.equal(transcriptPlaceholder(undefined), null, 'an older Control has no transcriptState');

  assert.equal(reportDisplayName({remoteNumber: '2025550117', contactName: '张三'}), '张三 · 2025550117');
  assert.equal(reportDisplayName({remoteNumber: '2025550117'}), '2025550117');
  assert.equal(reportDisplayName({remoteNumber: null, contactName: null}), '未知号码');
  // S72：内部通话与忙线未接、设备本机接听。
  assert.equal(reportDisplayName({remoteNumber: '133', internal: true, direction: 'incoming', peerSimLabel: '联通186', sim: {id: 's', label: '电信133'}}), '内部通话 联通186 → 电信133');
  assert.equal(answerModeLabel({answeredAt: null, internal: true}), '未接通');
  assert.equal(answerModeLabel({answeredAt: null, failureReason: 'busy_auto_rejected'}), '忙线未接');
  assert.equal(answerModeLabel({answeredAt: 'x', answeredByPlatform: 'device'}), '网关本机');
  assert.equal(callDurationLabel({answeredAt: '2026-09-12T01:30:05.000Z', endedAt: '2026-09-12T01:30:53.000Z'}), '通话 48 秒');
  assert.equal(callDurationLabel({answeredAt: '2026-09-12T03:00:02.000Z', endedAt: '2026-09-12T03:02:12.000Z'}), '通话 2 分 10 秒');
  assert.equal(callDurationLabel({answeredAt: null, endedAt: '2026-09-12T02:00:20.000Z'}), '未接通');
  assert.equal(callDurationLabel({answeredAt: '2026-09-12T03:00:00.000Z', endedAt: '2026-09-12T03:02:05.000Z'}), '通话 2 分 05 秒');
  assert.equal(talkDuration({answeredAt: '2026-09-12T03:00:00.000Z', endedAt: '2026-09-12T03:01:00.000Z'}), '1 分 00 秒');
  assert.equal(talkDuration({answeredAt: '2026-09-12T03:00:05.000Z', endedAt: '2026-09-12T03:00:00.000Z'}), '0 秒');
  assert.equal(talkDuration({answeredAt: undefined, endedAt: '2026-09-12T03:00:00.000Z'}), null);
});

test('报告卡片 marks 推荐拦截/未分类, states the transcript, and filters by the selected SIM', async () => {
  const {CallReports} = await load<typeof import('../src/reports.tsx')>('/src/reports.tsx');
  const paths: string[] = [];
  const request = async <T,>(requestPath: string): Promise<T> => {
    paths.push(requestPath);
    return {items} as T;
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CallReports, {simId: 'sim-1', timeZone: ZONE, request, busy: false}));
    });
    await act(async () => {
      await flush();
    });

    const today = gatewayCalendarDate(new Date(), ZONE);
    assert.deepEqual(paths, [
      `/reports/calls?timeZone=Asia%2FShanghai&from=${shiftCalendarDate(today, -6)}&to=${today}&page=1&pageSize=50&simId=sim-1`,
    ], '7 天 is the default window');

    const tree = collectText(renderer!.toJSON());
    assert.match(tree, /张三 · 2025550117/, '第一行是 姓名 · 号码');
    assert.match(tree, /家庭卡 · 呼入 · 通话 48 秒 · AI 接听/);
    assert.match(tree, /推荐拦截/);
    assert.match(tree, /保险销售/);
    assert.match(tree, /来电推销重疾险/);
    assert.match(tree, /本周内回电确认是否需要保单/);
    assert.match(tree, /未分类/, 'a historical row without a category says 未分类');
    assert.match(tree, /无转录：录音为空/);
    assert.match(tree, /转录处理中…/);
    assert.match(tree, /转录失败，原始录音仍可查看/);
    assert.match(tree, /已屏蔽/, 'an already blocked number shows the static pill');
    assert.match(tree, /超时 AI/);
    assert.match(tree, /未接/);
    assert.doesNotMatch(tree, /不纳入报告/, 'S22 决策 10 removed the advertising exclusion copy');
    assert.doesNotMatch(tree, /2025550115/, 'another SIM is filtered out exactly as before');

    const cards = renderer!.root.findAll(node => node.type === 'article' && String(node.props.className).includes('report-card'));
    assert.equal(cards.length, 4);
    const blockedCard = cards.find(card => String(card.props.id) === 'call-report-call-blocked')!;
    assert.equal(
      blockedCard.findAll(node => node.type === 'button' && collectText(node) === '屏蔽').length,
      0,
      'a blocked number offers no 屏蔽 button',
    );
    assert.equal(
      renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '屏蔽').length,
      3,
    );
    // Same order as a 通话记录 row: 回拨 → 发短信 → 更多 → 查看录音 → 查看转录.
    const adCard = cards.find(card => String(card.props.id) === 'call-report-call-ad')!;
    const order = adCard.findAll(node => node.type === 'button' || node.type === 'summary').map(node => collectText(node));
    assert.deepEqual(order.slice(0, 3), ['回拨', '发短信', '更多']);
    assert.equal(order.includes('屏蔽'), true);
    assert.match(order.slice(4).join('|'), /录音.*\|查看转录$/);
  } finally {
    renderer?.unmount();
  }
});

test('预设与搜索重新请求，屏蔽 posts {remoteNumber, sourceCallId} and marks the card 已屏蔽', async () => {
  const {CallReports} = await load<typeof import('../src/reports.tsx')>('/src/reports.tsx');
  const requests: {path: string; body?: unknown}[] = [];
  let changed = 0;
  const sms: string[] = [];
  // A real Control answers the reload with the number already blocked; the stub mirrors that.
  const blockedNumbers = new Set<string>();
  const request = async <T,>(requestPath: string, body?: unknown): Promise<T> => {
    requests.push({path: requestPath, body});
    if (requestPath === '/blocklist') {
      blockedNumbers.add(String((body as {remoteNumber?: string}).remoteNumber));
      return {item: {id: 'entry-new'}} as T;
    }
    return {items: items.map(item => ({...item, blocked: item.blocked || blockedNumbers.has(item.remoteNumber || '')}))} as T;
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CallReports, {
        simId: 'sim-1',
        timeZone: ZONE,
        request,
        busy: false,
        onSms: (item: ReportItem) => {sms.push(item.callId);},
        onChanged: () => {changed += 1;},
      }));
    });
    await act(async () => {
      await flush();
    });
    const today = gatewayCalendarDate(new Date(), ZONE);

    await act(async () => {
      findButton(renderer!, '今天').props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(requests.at(-1)!.path, `/reports/calls?timeZone=Asia%2FShanghai&from=${today}&to=${today}&page=1&pageSize=50&simId=sim-1`);

    await act(async () => {
      findButton(renderer!, '自定义').props.onClick();
    });
    const dateInputs = renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'date');
    assert.equal(dateInputs.length, 2, '自定义 shows a from and a to date input');
    await act(async () => {
      dateInputs[0]!.props.onChange({target: {value: '2026-09-01'}});
    });
    await act(async () => {
      await flush();
    });
    assert.equal(requests.at(-1)!.path, `/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-01&to=${today}&page=1&pageSize=50&simId=sim-1`);

    const search = renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'search')[0]!;
    assert.equal(search.props.placeholder, '搜索姓名或号码');
    await act(async () => {
      search.props.onChange({target: {value: '张三'}});
    });
    await act(async () => {
      await settleDebounce();
      await flush();
    });
    assert.equal(
      requests.at(-1)!.path,
      `/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-01&to=${today}&page=1&pageSize=50&query=%E5%BC%A0%E4%B8%89&simId=sim-1`,
      'one request per pause in typing, with the query appended',
    );

    await act(async () => {
      findButton(renderer!, '发短信').props.onClick();
    });
    assert.deepEqual(sms, ['call-ad'], '发短信 hands the report item to the page, like 回拨');

    const before = requests.length;
    await act(async () => {
      findButton(renderer!, '屏蔽').props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), new RegExp(CONTACT_BLOCK_PROMPT.slice(0, 6)));
    assert.match(collectText(renderer!.toJSON()), /屏蔽此号码的来电？/);
    await act(async () => {
      findButton(renderer!, '确认屏蔽').props.onClick();
      await flush();
    });
    assert.deepEqual(requests[before], {path: '/blocklist', body: {remoteNumber: '2025550117', sourceCallId: 'call-ad', scope: 'call'}});
    assert.equal(changed, 1, 'the rest of the 记录 tab reloads through onChanged');
    assert.equal(requests.length > before + 1, true, 'the report list reloads after 屏蔽');

    const adCard = renderer!.root.findAll(node => node.type === 'article' && String(node.props.id) === 'call-report-call-ad')[0]!;
    assert.match(collectText(adCard), /已屏蔽/);
    assert.equal(adCard.findAll(node => node.type === 'button' && collectText(node) === '屏蔽').length, 0);
  } finally {
    renderer?.unmount();
  }
});

test('报告 pages through the server, resets to page 1 on every filter change, and hides the pager on a legacy server', async () => {
  const {CallReports} = await load<typeof import('../src/reports.tsx')>('/src/reports.tsx');
  const paths: string[] = [];
  let paged = true;
  const request = async <T,>(requestPath: string): Promise<T> => {
    paths.push(requestPath);
    return (paged ? {items, page: 1, pageSize: 50, total: 137, totalPages: 3} : {items}) as T;
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CallReports, {simId: 'sim-1', timeZone: ZONE, request, busy: false}));
    });
    await act(async () => {
      await flush();
    });
    const today = gatewayCalendarDate(new Date(), ZONE);
    const window7d = `from=${shiftCalendarDate(today, -6)}&to=${today}`;
    assert.equal(paths.length, 1, 'the first render asks exactly once');
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 3 页 · 共 137 条/);

    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
      await flush();
    });
    assert.equal(
      paths.at(-1),
      `/reports/calls?timeZone=Asia%2FShanghai&${window7d}&page=2&pageSize=50&simId=sim-1`,
    );

    // 末页 then a preset: the window changes, so the list must re-enter at page 1 with a single request.
    await act(async () => {
      findButton(renderer!, '末页').props.onClick();
      await flush();
    });
    assert.match(paths.at(-1)!, /&page=3&pageSize=50&simId=sim-1$/);
    const before = paths.length;
    await act(async () => {
      findButton(renderer!, '今天').props.onClick();
      await flush();
    });
    assert.equal(paths.length, before + 1, 'a filter change costs one request, not two');
    assert.equal(
      paths.at(-1),
      `/reports/calls?timeZone=Asia%2FShanghai&from=${today}&to=${today}&page=1&pageSize=50&simId=sim-1`,
    );

    // 每页 also restarts at page 1.
    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
      await flush();
    });
    await act(async () => {
      renderer!.root.findByType('select').props.onChange({target: {value: '100'}});
      await flush();
    });
    assert.equal(
      paths.at(-1),
      `/reports/calls?timeZone=Asia%2FShanghai&from=${today}&to=${today}&page=1&pageSize=100&simId=sim-1`,
    );
    renderer!.unmount();

    paged = false;
    paths.length = 0;
    await act(async () => {
      renderer = create(React.createElement(CallReports, {simId: 'sim-1', timeZone: ZONE, request, busy: false}));
    });
    await act(async () => {
      await flush();
    });
    assert.equal(renderer!.root.findAll(node => node.props?.className === 'pager').length, 0,
      'a pre-S28 Control answers {items} and gets no pager');
    assert.equal(
      renderer!.root.findAll(node => node.type === 'article' && String(node.props.className).includes('report-card')).length,
      4,
      'the rows still render',
    );
  } finally {
    renderer?.unmount();
  }
});
