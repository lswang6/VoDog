/**
 * S36 C3 + S36b D1：浏览器端结构化诊断。
 *
 * 环形缓冲 ≤500 条；每 60 秒、满 50 条、页面隐藏或卸载时上报一次，失败重试一次。
 * 重试仍失败的整批转入积压队列并写进 localStorage（连同缓冲共 ≤2000 条），下次冲刷或下次启动先补传；
 * 积压与环形缓冲分开，所以一次断网只会丢最旧的（记 diag.dropped），绝不堵住新事件。
 * S69：未登录（未 start / stop 之后）时事件进环形缓冲，上限 100 条，不发任何请求；登录后随首批上报。
 * 诊断永远不能阻塞或拖慢一通电话。每条事件带顶层 appVersion（构建时的 版本+提交短哈希）。
 */
declare const __APP_VERSION__: string;

type DiagOptions = {timeoutMs?: number; keepalive?: boolean; diagSource?: boolean; diagSentAt?: number};
type DiagAPI = (path: string, body: unknown, method: string, options: DiagOptions) => Promise<unknown>;
export type DiagEvent = {ts: string; level: 'info' | 'warn' | 'error'; appVersion?: string; event: string; callId?: string; fields: Record<string, unknown>};
/** 只声明真正读到的字段，测试直接塞一个对象字面量就能当浏览器用。 */
export type DiagEnv = {
  navigator?: {
    userAgent?: string;
    language?: string;
    userAgentData?: {brands?: {brand: string; version: string}[]; platform?: string; mobile?: boolean};
    connection?: {type?: string; effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean};
    permissions?: {query: (descriptor: {name: string}) => Promise<{state: string; onchange?: unknown}>};
    getBattery?: () => Promise<{level?: number; charging?: boolean}>;
  };
  localStorage?: {getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void};
  document?: {visibilityState?: string; addEventListener?: (type: string, listener: never) => void; removeEventListener?: (type: string, listener: never) => void};
  window?: {addEventListener?: (type: string, listener: never) => void; removeEventListener?: (type: string, listener: never) => void};
  performance?: {memory?: {usedJSHeapSize?: number}};
  Notification?: {permission?: string};
};

const RING_MAX = 500, FLUSH_AT = 50, FLUSH_MS = 60_000, BATCH_MAX = 200;
const STORE_MAX = 2000, STORE_KEY = 'cc.diag.pending', INSTALL_KEY = 'cc.diag.install', COLLAPSE_MS = 60_000;
const PRELOGIN_MAX = 100, HIDDEN_LOG_MS = 60_000;
const loadedAt = Date.now();
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** 每个采集点都包起来：读不到就少一个字段，绝不让诊断炸掉页面。 */
function probe<T>(read: () => T): T | undefined {try {return read();} catch {return undefined;}}
const compact = <T extends Record<string, unknown>>(source: T): T =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as T;
const text = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value).slice(0, 300);
/** S69 合并键：api.error 按 (path, code, errorType)，ui.error_shown 按 (screen, message)。 */
const collapseKey = (event: string, fields: Record<string, unknown>): string | undefined =>
  event === 'api.error' ? `api|${String(fields.path)}|${String(fields.code)}|${String(fields.errorType ?? '')}`
    : event === 'ui.error_shown' ? `ui|${String(fields.screen)}|${String(fields.message)}` : undefined;

/**
 * S69：fetch 被拒时的 errorType。外部主动取消返回 null（不记）；我们自己的超时计时器触发 = timeout。
 */
export function fetchErrorType(externalAborted: boolean, timedOut: boolean, online: boolean | undefined): 'timeout' | 'offline' | 'other' | null {
  if (externalAborted) return null;
  if (timedOut) return 'timeout';
  return online === false ? 'offline' : 'other';
}

/** S69 级别：api.error / ui.error_shown / network.offline（S75）永远 warn；其余 *.failed / *.error 为 error；ok:false 至少 warn。 */
function diagLevel(event: string, fields: Record<string, unknown>): DiagEvent['level'] {
  if (event === 'api.error' || event === 'ui.error_shown' || event === 'network.offline') return 'warn';
  if (/\.(failed|error)$/.test(event)) return 'error';
  return fields.ok === false ? 'warn' : 'info';
}

export class Diag {
  private ring: DiagEvent[] = [];
  /** 上次会话没发出去的事件，比新事件先上报。 */
  private backlog: DiagEvent[] = [];
  private seq = 0;
  private dropped = 0;
  private api?: DiagAPI;
  private timer?: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  private persisted = false;
  /** 上报收到 401（会话已失效）后不再冲刷，直到下一次 start()（登录/登出等会话边界由 main.tsx 转成 stop/start）。 */
  private unauthorized = false;
  private install?: string;
  private battery?: {level?: number; charging?: boolean};
  private micPermission?: string;
  private lastContext = '';
  private callId?: string;
  private mediaState?: string;
  private recent = new Map<string, {at: number; entry: DiagEvent}>();
  private hiddenAt?: number;
  private offlineAt?: number;
  private listening = false;
  private readonly env: DiagEnv;
  constructor(env: DiagEnv = globalThis as unknown as DiagEnv) {this.env = env;}
  /** 隐藏时先记一条再冲刷，顺序反了这条事件就要等下一次会话才上得去。S69：回到前台只在隐藏超过 60 秒时记。 */
  private readonly visibility = () => {
    if (this.env.document?.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      this.log('app.visibility', {state: 'hidden'});
      void this.flush();
    } else if (this.env.document?.visibilityState === 'visible') {
      const hiddenMs = this.hiddenAt === undefined ? 0 : Date.now() - this.hiddenAt;
      this.hiddenAt = undefined;
      if (hiddenMs > HIDDEN_LOG_MS) this.log('app.visibility', {state: 'visible', hiddenS: Math.round(hiddenMs / 1000)});
    }
  };
  private readonly leaving = () => {void this.flush();};
  /** S75：断网只进缓冲（此时发不出去），恢复后记时长并立刻冲刷。 */
  private readonly offline = () => {this.offlineAt ??= Date.now(); this.log('network.offline', {}, this.callId);};
  private readonly online = () => {
    const offlineMs = this.offlineAt === undefined ? undefined : Date.now() - this.offlineAt;
    this.offlineAt = undefined;
    this.log('network.online', compact({offlineMs}), this.callId);
    void this.flush();
  };
  private readonly uncaught = (event: {message?: string; filename?: string; lineno?: number; error?: {stack?: string}}) => {
    this.log('app.error', compact({where: 'window', message: text(event?.message ?? event?.error?.stack), source: event?.filename, line: event?.lineno}));
  };
  private readonly rejected = (event: {reason?: unknown}) => {
    const reason = event?.reason as {message?: string; code?: unknown} | undefined;
    this.log('app.error', compact({
      where: 'unhandledrejection',
      message: text(reason?.message ?? reason),
      code: typeof reason?.code === 'string' ? reason.code : undefined,
    }));
  };
  /** 每个安装一个 UUID，存 localStorage，随 X-Diag-Install 头上报，跨会话追同一台设备。 */
  get installId(): string {
    if (this.install) return this.install;
    const storage = probe(() => this.env.localStorage); // 隐私模式下光是读这个属性都可能抛
    const id = probe(() => storage?.getItem(INSTALL_KEY)) || probe(() => globalThis.crypto?.randomUUID?.()) ||
      `web-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    probe(() => storage?.setItem(INSTALL_KEY, id));
    this.install = id;
    return id;
  }
  /** S69：main.tsx 最先调用；错误监听挂一次、挂整个页面生命周期，登录前的错误进缓冲。 */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.env.window?.addEventListener?.('error', this.uncaught as never);
    this.env.window?.addEventListener?.('unhandledrejection', this.rejected as never);
    this.env.window?.addEventListener?.('offline', this.offline as never);
    this.env.window?.addEventListener?.('online', this.online as never);
  }
  /** S69 ui.error_shown：用户看得见的错误提示；同 (screen, message) 60 秒内合并。 */
  uiError(screen: string, site: string, message: string, code?: string): void {
    // 取消类（浏览器 AbortError 文案均含 abort）不记。
    if (message && !/abort/i.test(message)) this.log('ui.error_shown', compact({screen, site, message: text(message), code}));
  }
  start(api: DiagAPI): void {
    if (this.api) return;
    this.api = api;
    this.unauthorized = false;
    const buffered = this.ring.length; // 登录前缓冲的事件
    this.timer = setInterval(() => {void this.flush();}, FLUSH_MS);
    this.restore();
    const doc = this.env.document, win = this.env.window;
    doc?.addEventListener?.('visibilitychange', this.visibility as never);
    win?.addEventListener?.('pagehide', this.leaving as never);
    this.listen();
    probe(() => void this.env.navigator?.getBattery?.().then(status => {this.battery = status;}).catch(() => {}));
    probe(() => void this.env.navigator?.permissions?.query({name: 'microphone'}).then(status => {
      const note = () => {this.micPermission = status.state; this.emitContext();};
      (status as {onchange?: unknown}).onchange = note;
      note();
    }).catch(() => {}));
    this.emitContext();
    if (this.backlog.length || buffered) void this.flush();
  }
  stop(): Promise<void> {
    const flushing = this.flush();
    this.api = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.lastContext = '';
    const doc = this.env.document, win = this.env.window;
    doc?.removeEventListener?.('visibilitychange', this.visibility as never);
    win?.removeEventListener?.('pagehide', this.leaving as never);
    return flushing;
  }
  log(event: string, fields: Record<string, unknown> = {}, callId?: string): void {
    const key = collapseKey(event, fields);
    if (key && this.collapse(key)) return;
    const entry = this.event(event, fields, callId);
    this.ring.push(entry);
    if (key) {
      if (this.recent.size > 50) this.recent.clear(); // ponytail: 只防无界增长，丢了最多多发一条
      this.recent.set(key, {at: Date.now(), entry});
    }
    const overflow = this.ring.length - (this.api ? RING_MAX : PRELOGIN_MAX);
    if (overflow > 0) {this.ring.splice(0, overflow); this.dropped += overflow;}
    if (this.ring.length >= FLUSH_AT) void this.flush();
  }
  /** 通话状态只喂给快照，主流程不依赖它。媒体状态来自 media.ts 的 ICE 回调。 */
  setCall(callId: string | null, mediaState?: string): void {
    if (callId !== (this.callId ?? null)) this.mediaState = undefined;
    this.callId = callId ?? undefined;
    if (mediaState) this.mediaState = mediaState;
  }
  /** 取走再发：重试一次仍失败就落盘，等下次启动补传。 */
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    const api = this.api;
    if (!api || !(this.ring.length || this.backlog.length)) return Promise.resolve();
    if (this.unauthorized) {this.persist([...this.backlog, ...this.ring]); return Promise.resolve();}
    return this.sending = this.send(api).finally(() => {this.sending = undefined;});
  }
  private async send(api: DiagAPI): Promise<void> {
    // 每次上报都在批尾带一条快照：直接进批次而不是进环形缓冲，缓冲满的时候它才不会被挤掉。
    const limit = BATCH_MAX - 1;
    const batch = this.backlog.splice(0, limit);
    if (batch.length < limit) batch.push(...this.ring.splice(0, limit - batch.length));
    batch.push(this.event('client.snapshot', this.snapshot(), this.callId));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await api('/diag/events', batch, 'POST', {timeoutMs: 5000, keepalive: true, diagSource: true, diagSentAt: Date.now()});
        if (this.persisted) this.persist([...this.backlog, ...this.ring]);
        return;
      } catch (error) {
        // 诊断上报失败不影响任何通话路径；401 说明会话已失效，重试和定时冲刷都只会继续刷 401。
        if ((error as {status?: unknown})?.status === 401) {this.unauthorized = true; break;}
      }
    }
    this.requeue(batch);
  }
  /**
   * 发不出去的一批退回积压队列（排在最前，它最旧），同时落盘。
   * 只有总量超过 2000 条才丢最旧的，并补一条 diag.dropped——环形缓冲始终空得下新事件，不会被堵死。
   */
  private requeue(batch: DiagEvent[]): void {
    this.backlog.unshift(...batch);
    const overflow = this.backlog.length + this.ring.length - STORE_MAX;
    if (overflow > 0) {
      this.backlog.splice(0, overflow);
      this.dropped += overflow;
      this.ring.push(this.event('diag.dropped', {count: overflow}));
    }
    this.persist([...this.backlog, ...this.ring]);
  }
  private persist(events: DiagEvent[]): void {
    const storage = probe(() => this.env.localStorage); // 隐私模式下光是读这个属性都可能抛
    if (!storage) return;
    try {
      if (!events.length) {storage.removeItem(STORE_KEY); this.persisted = false; return;}
      storage.setItem(STORE_KEY, JSON.stringify(events));
      this.persisted = true;
    } catch {/* 存不下就算了，诊断不能影响页面。 */}
  }
  private restore(): void {
    const storage = probe(() => this.env.localStorage); // 隐私模式下光是读这个属性都可能抛
    if (!storage) return;
    try {
      const raw = storage.getItem(STORE_KEY);
      storage.removeItem(STORE_KEY);
      this.persisted = false;
      const saved = raw ? JSON.parse(raw) as DiagEvent[] : [];
      if (Array.isArray(saved)) this.backlog = saved.filter(item => item && typeof item.event === 'string').slice(-STORE_MAX);
    } catch {/* 坏掉的缓存直接丢。 */}
  }
  /** S36b D1 / S69：同键事件 60 秒内只上报一条，次数记在 repeat（含第一条）。 */
  private collapse(key: string): boolean {
    const last = this.recent.get(key);
    if (!last || Date.now() - last.at > COLLAPSE_MS) return false;
    if (!this.ring.includes(last.entry)) return false; // 已经发出去了，重新开一条
    last.entry.fields.repeat = ((last.entry.fields.repeat as number) ?? 1) + 1;
    return true;
  }
  private event(event: string, fields: Record<string, unknown>, callId?: string): DiagEvent {
    return {
      ts: new Date().toISOString(),
      level: diagLevel(event, fields),
      appVersion: APP_VERSION,
      event, ...(callId ? {callId} : {}), fields: {...fields, seq: ++this.seq},
    };
  }
  private context(): Record<string, unknown> {
    const nav = this.env.navigator, ua = probe(() => nav?.userAgentData);
    return compact({
      platform: 'web',
      appVersion: APP_VERSION,
      userAgent: probe(() => nav?.userAgent),
      uaBrands: probe(() => ua?.brands?.map(brand => `${brand.brand} ${brand.version}`).join(', ')),
      uaPlatform: probe(() => ua?.platform),
      mobile: probe(() => ua?.mobile),
      locale: probe(() => nav?.language),
      timeZone: probe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      notificationPermission: probe(() => this.env.Notification?.permission),
      micPermission: this.micPermission,
      installId: this.installId,
    });
  }
  /** 值变了才再发一条——麦克风授权、语言、网络标识都可能在会话中途变。 */
  private emitContext(): void {
    const context = this.context(), fingerprint = JSON.stringify(context);
    if (fingerprint === this.lastContext) return;
    this.lastContext = fingerprint;
    this.log('client.context', context);
  }
  private snapshot(): Record<string, unknown> {
    const connection = probe(() => this.env.navigator?.connection);
    return compact({
      network: connection && compact({
        type: connection.type, effectiveType: connection.effectiveType,
        downlink: connection.downlink, rtt: connection.rtt, saveData: connection.saveData,
      }),
      battery: this.battery && compact({level: this.battery.level, charging: this.battery.charging}),
      memoryMB: probe(() => {
        const used = this.env.performance?.memory?.usedJSHeapSize;
        return used ? Math.round(used / 1048576) : undefined;
      }),
      appState: probe(() => this.env.document?.visibilityState === 'hidden' ? 'bg' : 'fg'),
      inCall: Boolean(this.callId),
      mediaState: this.mediaState,
      uptimeS: Math.round((Date.now() - loadedAt) / 1000),
      seqDropped: this.dropped,
    });
  }
  /** 测试用：当前待上报条数。 */
  get pending(): number {return this.ring.length + this.backlog.length;}
}

export const diag = new Diag();
