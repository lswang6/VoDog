import test from 'node:test';
import assert from 'node:assert/strict';
import {Diag, fetchErrorType, type DiagEvent} from '../src/diag.ts';

type Post = {path: string; body: DiagEvent[]; options: {keepalive?: boolean; diagSource?: boolean}};
function recorder(fail = 0) {
  const posts: Post[] = [];
  let remaining = fail;
  const api = async (path: string, body: unknown, _method: string, options: Post['options']) => {
    posts.push({path, body: body as DiagEvent[], options});
    if (remaining-- > 0) throw new Error('offline');
    return {accepted: (body as DiagEvent[]).length};
  };
  return {posts, api};
}
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {map.set(key, value);},
    removeItem: (key: string) => {map.delete(key);},
  };
}
/** 把电池 / 麦克风权限这类异步采集跑完。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('nothing is posted before login', async () => {
  const {posts, api} = recorder();
  const diag = new Diag({});
  diag.start(api);
  diag.log('dial.request', {code: 'ok'}, 'c1');
  assert.equal(diag.pending, 2, 'client.context + dial.request');
  await diag.stop();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/diag/events');
  assert.equal(posts[0].options.keepalive, true);
  assert.equal(posts[0].options.diagSource, true);
  const dialed = posts[0].body.find(event => event.event === 'dial.request')!;
  assert.deepEqual(dialed.fields, {code: 'ok', seq: 2});
  assert.equal(dialed.callId, 'c1');
  assert.equal(dialed.level, 'info');
  assert.equal(dialed.appVersion, 'dev', 'S69: every event carries a top-level appVersion');
  assert.deepEqual(posts[0].body.map(event => event.event), ['client.context', 'dial.request', 'client.snapshot']);
  // stop 之后不再发请求：事件进登录前缓冲。
  diag.log('dial.request', {});
  await diag.flush();
  assert.equal(posts.length, 1);
  assert.equal(diag.pending, 1);
});

test('S69: events before login are buffered (bounded, no requests) and go out with the first batch after login', async () => {
  const {posts, api} = recorder();
  const diag = new Diag({});
  diag.log('app.error', {where: 'window', message: 'early'});
  for (let index = 0; index < 150; index++) diag.log('api.error', {path: `/p${index}`, code: 0, errorType: 'offline'});
  await diag.flush();
  assert.equal(posts.length, 0, 'no request while logged out');
  assert.equal(diag.pending, 100, 'pre-login buffer is capped at 100, newest kept');
  diag.start(api);
  await diag.flush();
  assert.equal(posts.length, 1, 'buffered events flush right after login');
  const events = posts[0].body.map(event => event.event);
  assert.equal(events.filter(event => event === 'api.error').length, 100);
  assert.equal(posts[0].body.find(event => event.event === 'api.error')!.fields.path, '/p50');
  await diag.stop();
});

test('S69: fetch rejection errorType — timeout, offline, other; external abort is not logged', () => {
  assert.equal(fetchErrorType(true, false, true), null);
  assert.equal(fetchErrorType(true, true, false), null);
  assert.equal(fetchErrorType(false, true, true), 'timeout');
  assert.equal(fetchErrorType(false, false, false), 'offline');
  assert.equal(fetchErrorType(false, false, true), 'other');
  assert.equal(fetchErrorType(false, false, undefined), 'other');
});

test('S69: ui.error_shown is warn and merges the same (screen, message) within 60 s', async () => {
  const {posts, api} = recorder();
  const diag = new Diag({});
  diag.start(api);
  diag.uiError('通话', 'banner', '请求失败');
  diag.uiError('通话', 'connection', '连接暂时中断');
  diag.uiError('通话', 'banner', '请求失败');
  diag.uiError('短信', 'banner', '请求失败');
  diag.uiError('通话', 'banner', '');
  diag.uiError('通话', 'banner', 'signal is aborted without reason'); // 取消类不记
  await diag.flush();
  const shown = posts[0].body.filter(event => event.event === 'ui.error_shown');
  assert.equal(shown.length, 3);
  assert.deepEqual(shown[0].fields, {screen: '通话', site: 'banner', message: '请求失败', seq: 2, repeat: 2});
  assert.ok(shown.every(event => event.level === 'warn'));
  diag.log('audio.session', {ok: false});
  diag.log('audio.session', {ok: true});
  await diag.flush();
  assert.deepEqual(posts[1].body.filter(event => event.event === 'audio.session').map(event => event.level), ['warn', 'info'], 'ok:false is at least warn');
  await diag.stop();
});

test('S69: app.visibility logs hidden, and visible only after more than 60 s hidden', async () => {
  const {posts, api} = recorder();
  const doc = {visibilityState: 'visible', listener: undefined as undefined | (() => void),
    addEventListener(_type: string, listener: () => void) {this.listener = listener;}, removeEventListener() {}};
  const diag = new Diag({document: doc as never});
  diag.start(api);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    doc.visibilityState = 'hidden'; doc.listener!();
    now += 5_000; doc.visibilityState = 'visible'; doc.listener!();
    doc.visibilityState = 'hidden'; doc.listener!();
    now += 61_000; doc.visibilityState = 'visible'; doc.listener!();
  } finally {Date.now = realNow;}
  await diag.flush(); // the hidden-triggered flush is still in flight
  await diag.stop();
  const states = posts.flatMap(post => post.body).filter(event => event.event === 'app.visibility').map(event => [event.fields.state, event.fields.hiddenS]);
  assert.deepEqual(states, [['hidden', undefined], ['hidden', undefined], ['visible', 61]]);
});

test('the ring stays bounded, keeps the newest events and numbers them monotonically', async () => {
  const {posts, api} = recorder();
  const diag = new Diag({});
  diag.start(api);
  for (let index = 0; index < 700; index++) diag.log('media.ice', {index});
  // 满 50 条会自动冲刷；冲刷取走 200 条，剩下的仍然不能超过 500。
  assert.ok(diag.pending <= 500, `pending=${diag.pending}`);
  await diag.flush(); // 第一次冲刷还在途中，等它落地
  await diag.stop();
  const seqs = posts.flatMap(post => post.body.map(event => event.fields.seq as number));
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
  assert.ok(posts.every(post => post.body.length <= 200));
  // 环形缓冲挤掉的条数会记在下一条快照的 seqDropped 里，不再静默丢。
  const snapshot = posts.at(-1)!.body.at(-1)!;
  assert.equal(snapshot.event, 'client.snapshot', '每批的最后一条都是快照');
  assert.ok((snapshot.fields.seqDropped as number) > 0, `seqDropped=${snapshot.fields.seqDropped}`);
});

test('a failed upload is retried exactly once and then queued for the next flush', async () => {
  const storage = fakeStorage();
  const {posts, api} = recorder(9);
  const diag = new Diag({localStorage: storage});
  diag.start(api);
  diag.log('media.failed', {message: 'x'}, 'c2');
  assert.equal(posts.length, 0);
  await diag.flush();
  assert.equal(posts.length, 2, '一次原始请求 + 一次重试');
  assert.equal(posts[0].body.find(event => event.event === 'media.failed')!.level, 'error', 'media.failed 记为 error');
  assert.equal(diag.pending, 3, '整批转入积压队列（含快照），环形缓冲空出来继续收新事件');
  assert.ok(storage.map.has('cc.diag.pending'), '同时落盘，页面现在关掉也不丢');
  await diag.stop();
  assert.equal(posts.length, 4, '下一次冲刷先重发积压的那一批');
});

test('S36b D1: client.context 与 client.snapshot 带上浏览器、网络和通话现场', async () => {
  const {posts, api} = recorder();
  const storage = fakeStorage();
  const permission = {state: 'prompt'};
  const diag = new Diag({
    navigator: {
      userAgent: 'Mozilla/5.0 Test', language: 'zh-CN',
      userAgentData: {brands: [{brand: 'Chromium', version: '140'}], platform: 'macOS', mobile: false},
      connection: {type: 'wifi', effectiveType: '4g', downlink: 9.2, rtt: 50, saveData: false},
      permissions: {query: async () => permission},
      getBattery: async () => ({level: 0.42, charging: true}),
    },
    localStorage: storage,
    Notification: {permission: 'denied'},
    performance: {memory: {usedJSHeapSize: 33 * 1048576}},
    document: {visibilityState: 'visible'},
  });
  diag.start(api);
  await settle();
  diag.setCall('call-1', 'connected');
  diag.log('dial.request', {code: 'ok'}, 'call-1');
  await diag.flush();
  const sent = posts[0].body;
  const contexts = sent.filter(event => event.event === 'client.context');
  assert.equal(contexts.length, 2, '启动时一条，麦克风权限读到之后值变了再一条');
  assert.equal(contexts[0].fields.micPermission, undefined, '权限还没读到就先不写这个字段');
  assert.deepEqual(contexts[1].fields, {
    platform: 'web', appVersion: 'dev', userAgent: 'Mozilla/5.0 Test',
    uaBrands: 'Chromium 140', uaPlatform: 'macOS', mobile: false,
    locale: 'zh-CN', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notificationPermission: 'denied', micPermission: 'prompt', installId: diag.installId, seq: 2,
  });
  assert.equal(storage.map.get('cc.diag.install'), diag.installId, 'installId 持久化，跨会话是同一台设备');
  const snapshot = sent.find(event => event.event === 'client.snapshot')!;
  assert.equal(snapshot.callId, 'call-1', '快照挂在通话上，按 call_id 拉时间线能看到设备现场');
  assert.deepEqual(snapshot.fields.network, {type: 'wifi', effectiveType: '4g', downlink: 9.2, rtt: 50, saveData: false});
  assert.deepEqual(snapshot.fields.battery, {level: 0.42, charging: true});
  assert.equal(snapshot.fields.memoryMB, 33);
  assert.equal(snapshot.fields.appState, 'fg');
  assert.equal(snapshot.fields.inCall, true);
  assert.equal(snapshot.fields.mediaState, 'connected');
  assert.equal(snapshot.fields.seqDropped, 0);
  assert.equal(typeof snapshot.fields.uptimeS, 'number');
  // 采集点各自兜底：navigator 什么都没有也只是少几个字段。
  const bare = new Diag({});
  bare.start(recorder().api);
  await bare.stop();
  assert.equal(bare.pending, 0);
  await diag.stop();
});

test('S36b D1: 上报失败的事件落盘，下次启动先补传', async () => {
  const storage = fakeStorage();
  const env = {localStorage: storage};
  const failing = recorder(9); // 整场离线
  const first = new Diag(env);
  first.start(failing.api);
  first.log('dial.request', {code: 'GATEWAY_OFFLINE'}, 'call-9');
  await first.flush();
  assert.equal(failing.posts.length, 2, '原始请求 + 一次重试');
  await first.stop();
  const saved = JSON.parse(storage.map.get('cc.diag.pending')!) as DiagEvent[];
  assert.deepEqual(saved.map(event => event.event),
    ['client.context', 'dial.request', 'client.snapshot', 'client.snapshot'],
    '连续两次失败的批次互相叠加，不是后一批覆盖前一批');

  const online = recorder();
  const next = new Diag(env);
  next.start(online.api); // 有积压就立刻补传
  await next.flush();
  assert.equal(online.posts.length, 1);
  assert.deepEqual(online.posts[0].body.map(event => event.event),
    ['client.context', 'dial.request', 'client.snapshot', 'client.snapshot', 'client.context', 'client.snapshot'],
    '上次会话的四条排在这次的新事件前面');
  assert.equal(online.posts[0].body[1].callId, 'call-9', '落盘再取回不丢 callId');
  assert.equal(storage.map.has('cc.diag.pending'), false, '补传成功后清掉，不会重复上报');
  await next.stop();
});

test('S36b D1: 没接住的异常和 Promise 拒绝都汇成 app.error', async () => {
  const {posts, api} = recorder();
  const listeners = new Map<string, (event: unknown) => void>();
  const diag = new Diag({window: {
    addEventListener: ((type: string, listener: (event: unknown) => void) => {listeners.set(type, listener);}) as never,
    removeEventListener: ((type: string) => {listeners.delete(type);}) as never,
  }});
  diag.listen();
  diag.start(api);
  listeners.get('error')!({message: 'boom', filename: 'index.js', lineno: 42});
  listeners.get('unhandledrejection')!({reason: Object.assign(new Error('网络断开'), {code: 'NETWORK'})});
  await diag.stop();
  const errors = posts[0].body.filter(event => event.event === 'app.error');
  assert.deepEqual(errors.map(event => event.level), ['error', 'error']);
  assert.deepEqual(errors[0].fields, {where: 'window', message: 'boom', source: 'index.js', line: 42, seq: 2});
  assert.deepEqual(errors[1].fields, {where: 'unhandledrejection', message: '网络断开', code: 'NETWORK', seq: 3});
  assert.equal(listeners.has('error'), true, 'S69: 错误监听挂整个页面生命周期，登出后照样收（进缓冲）');
});

test('S36b D1: 同一个 api.error 在 60 秒内合并成一条并记 repeat', async () => {
  const {posts, api} = recorder();
  const diag = new Diag({});
  diag.start(api);
  for (let index = 0; index < 3; index++) diag.log('api.error', {path: '/calls', code: 503, serverCode: 'GATEWAY_OFFLINE'});
  diag.log('api.error', {path: '/calls', code: 500});
  assert.equal(diag.pending, 3, 'client.context + 合并后的一条 + 另一个 code 一条');
  await diag.flush();
  const errors = posts[0].body.filter(event => event.event === 'api.error');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].fields.repeat, 3, 'repeat 含第一条');
  assert.equal(errors[0].fields.serverCode, 'GATEWAY_OFFLINE');
  assert.equal(errors[0].level, 'warn', 'S69: api.error 永远不是 error');
  assert.equal(errors[1].fields.repeat, undefined, '换了 code 就是另一条');
  // 已经发出去的那条改不动了，重新开一条，而不是把 repeat 加到上不去的事件上。
  diag.log('api.error', {path: '/calls', code: 503, serverCode: 'GATEWAY_OFFLINE'});
  await diag.flush();
  const again = posts[1].body.filter(event => event.event === 'api.error');
  assert.equal(again.length, 1);
  assert.equal(again[0].fields.repeat, undefined);
  await diag.stop();
});

test('a 401 pauses flushing without retry, keeps events, and resumes on the next session start', async () => {
  const posts: DiagEvent[][] = [];
  let status = 401;
  const api = async (_path: string, body: unknown) => {
    posts.push(body as DiagEvent[]);
    if (status === 401) throw Object.assign(new Error('unauthorized'), {status: 401});
    return {};
  };
  const storage = fakeStorage();
  const diag = new Diag({localStorage: storage});
  diag.start(api);
  diag.log('dial.request', {code: 'ok'});
  await diag.flush();
  assert.equal(posts.length, 1, '401 is not retried');
  const kept = diag.pending;
  assert.ok(kept >= 2);
  diag.log('media.ice', {state: 'checking'});
  await diag.flush();
  await diag.flush();
  assert.equal(posts.length, 1, 'paused: no further posts');
  assert.equal(diag.pending, kept + 1);
  assert.ok(storage.map.get('cc.diag.pending'), 'paused events are persisted');
  status = 200;
  await diag.stop();
  assert.equal(posts.length, 1, 'stop while paused does not post');
  diag.start(api);
  await diag.flush();
  assert.equal(posts.length, 2, 'new session flushes again');
  assert.ok(posts[1].some(event => event.event === 'dial.request'));
  await diag.stop();
});

test('S75: every POST (retry and backlog replay included) carries its own send-time diagSentAt', async () => {
  const {posts, api} = recorder(2);
  const storage = fakeStorage();
  const diag = new Diag({localStorage: storage});
  diag.start(api);
  const before = Date.now();
  await diag.stop(); // 两次都失败 → 落盘
  const replay = new Diag({localStorage: storage});
  replay.start(api);
  await replay.stop();
  assert.equal(posts.length, 3);
  for (const post of posts) {
    const sentAt = (post.options as {diagSentAt?: number}).diagSentAt!;
    assert.ok(Number.isFinite(sentAt) && sentAt >= before && sentAt <= Date.now());
  }
});

test('S75: offline → network.offline (warn) buffered; online → network.online {offlineMs} and flush', async () => {
  const posts: Post[] = [];
  let up = false;
  const api = async (path: string, body: unknown, _method: string, options: Post['options']) => {
    if (!up) throw new Error('offline');
    posts.push({path, body: body as DiagEvent[], options});
    return {};
  };
  const listeners = new Map<string, () => void>();
  const diag = new Diag({window: {addEventListener: ((type: string, listener: () => void) => {listeners.set(type, listener);}) as never}});
  diag.listen();
  diag.listen(); // 只挂一次
  diag.start(api);
  await diag.flush(); // client.context：断网，进积压
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    listeners.get('offline')!();
    now += 7_000;
    up = true;
    listeners.get('online')!();
  } finally {Date.now = realNow;}
  await settle();
  assert.equal(posts.length, 1, 'online 立刻冲刷，不等 60 秒定时器');
  const offline = posts[0].body.find(event => event.event === 'network.offline')!;
  const online = posts[0].body.find(event => event.event === 'network.online')!;
  assert.equal(offline.level, 'warn');
  assert.equal(online.level, 'info');
  assert.equal(online.fields.offlineMs, 7_000);
  await diag.stop();
});
