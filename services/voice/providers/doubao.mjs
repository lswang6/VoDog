import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Pcm24kTo16kResampler } from '../pcm-pipeline.mjs';
import { backpressureCheck } from './backpressure.mjs';

/**
 * S27 决策 5 — 豆包（火山引擎 端到端实时语音 3.0 Seeduplex）全双工适配器。
 *
 * 协议事实全部来自 R11（docs/evidence/s27-readers/r11-doubao-duplex-protocol.md）：纯 JSON 文本帧，
 * 音频以 base64 内嵌在事件字段里，**不是**旧版 S2S 的二进制帧头协议。这里不使用任何 R11 未写明的
 * 字段或事件名。
 *
 * 对外遵守冻结的 agent 合同（providers/index.mjs:7-9）：事件 audio / flushAudio / completed /
 * fault / notice / closed / transcript / speechStarted / response，方法 start / stop / greet /
 * appendAudio / interrupt / requestInputTranscription，外加 `outputGeneration` 属性。
 */

/** 端点固定：TLS 证书就是按这个主机名校验的。`DOUBAO_REALTIME_URL` 仅供测试/冒烟覆盖。 */
const DOUBAO_REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const DOUBAO_MODEL = '1.2.6.1';
/** R11 §2 文档自身示例用的音色；R11 §7 的 `_uranus_bigtts` 系列是备选（冒烟报 InvalidSpeaker 时换）。 */
const DOUBAO_VOICE = 'zh_female_vv_jupiter_bigtts';
const DOUBAO_GREETING = '您好！我是 VoDog AI 助理，代用户接听电话，我会整理通话要点供用户查看。麻烦您把希望沟通和谈论的事情，大概跟我快速的说一说。';
const DOUBAO_INSTRUCTIONS_FILE = 'prompts/doubao-persona.zh.md';
/** 服务端上限是 12K tokens（含模型内部 SP 与上下文）；按字符粗算一道闸，启动期就挡住。 */
const MAX_INSTRUCTIONS_CHARS = 20_000;

const MAX_PROVIDER_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PCM_BYTES_PER_APPEND = 32_000;
const MAX_TEXT = 16_384;
const MAX_TEXT_BUFFERS = 20;
/**
 * S27 决策 5（2026-09-12 实测修正）：文档 R11 §5 写的是"PCM 24000 Hz 单声道 16bit 小端序"，但真实
 * 下发的 `response.output_audio.delta` 是 **32 位小端浮点**（抓取的开场白：全部有限、全部落在
 * [-1,1]、RMS 0.084、过零率 1394/s，是语音；按 int16 解读则过零率 0.47/样本、峰值满幅，是噪声——
 * 三通真实来电听到的"机器人杂音"即此）。默认按 f32le 解码，留 `DOUBAO_OUTPUT_FORMAT=s16le` 以防
 * 服务端日后改回文档写法。
 */
const OUTPUT_SAMPLE_BYTES = Object.freeze({ f32le: 4, s16le: 2 });
const DOUBAO_OUTPUT_FORMAT = 'f32le';
/** R11 §2/§5：16 kHz int16 下 20 ms = 640 字节，且必须按实时节奏发送。 */
const PACKET_BYTES = 640;
const PACKET_MS = 20;
/** 1 秒上行积压即认定链路已经不在实时节奏上；丢最旧的包，保住"现在"这一段。 */
const MAX_QUEUED_PACKETS = 50;
/** 定时器迟到时一次最多补发 3 包（60 ms）：平均速率仍是实时，不构成 R11 §5 说的"过快"。 */
const MAX_CATCHUP_PACKETS = 3;
/** R11 §6.2：必须先 `session.close` 并收到 `session.closed` 再断 WebSocket，否则记 55000001。 */
const CLOSE_WAIT_MS = 2_000;
const SETUP_TIMEOUT_MS = 15_000;

/** 只在声明了 `end_call` 时追加到人设之后，工具关着时提示词里不出现这个工具名。 */
const END_CALL_INSTRUCTIONS = '## 挂断方式\n需要结束通话时，先说一句简短的道别，然后直接调用 end_call 工具。调用工具本身就会挂断电话：不要说"已挂断""挂断了""正在挂断"之类的话，不要输出任何括号里的动作说明或舞台提示，道别之后不要再说任何内容。';

/** `DOUBAO_END_CALL_TOOL` 打开时声明的唯一工具。 */
const END_CALL_TOOL = {
  type: 'function',
  name: 'end_call',
  // S27 决策 12 补充：真实通话里模型把"（已挂断）"念了出来，所以描述里明确"调用即挂断、不要播报"。
  description: '挂断本次电话。适用：来电目的已处理完毕、需要的信息已记录；推销或广告类来电已礼貌拒绝；对方态度恶劣或情况不安全。先说完道别再调用。调用本身就会挂断，不要在回复里说明或播报挂断动作，不要输出括号里的动作提示。',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', enum: ['sales_refused', 'info_collected', 'abusive', 'other'] } },
    required: ['reason'],
  },
};

const text = value => (typeof value === 'string' && value ? value.slice(0, 256) : '');

/**
 * 数值在构造函数里再校验一次（不只在启动解析里），这样即便有程序化调用方绕过 `doubaoConfig`，
 * 也不可能把越界的值发上线路——`speed`/`loudness` 的 0 是合法值，所以判存在而不判真值。
 */
function bounded(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * 端点校验：默认就是文档给的 wss 地址。允许覆盖是为了测试与冒烟；`ws://` 只在环回地址上放行，
 * 因为 `X-Api-Key` 绝不能明文过网。
 */
export function doubaoRealtimeUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DOUBAO_REALTIME_URL;
  const raw = String(value).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('DOUBAO_REALTIME_URL must be a wss:// URL'); }
  if (!url.hostname) throw new Error('DOUBAO_REALTIME_URL must be a wss:// URL');
  if (url.protocol === 'wss:') return raw;
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'ws:' && loopback) return raw;
  throw new Error('DOUBAO_REALTIME_URL must be a wss:// URL');
}

/** R11 §6.9 的错误码分段：4xxxxxxx 参数/鉴权类不重试，5xxxxxxx 服务端类，45000003 是空闲释放。 */
export function doubaoFaultKind(code) {
  const value = String(code ?? '').trim();
  if (value === '45000003') return 'doubao_idle_timeout';
  if (/^4\d{7}$/.test(value)) return 'doubao_request_rejected';
  if (/^5\d{7}$/.test(value)) return 'doubao_server_error';
  return 'doubao_error';
}

/** 32 位小端浮点 [-1,1] → PCM16LE；越界值钳住，不让一个异常样本变成满幅爆音。 */
export function float32ToPcm16(bytes) {
  const samples = bytes.length >>> 2;
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = bytes.readFloatLE(i * 4);
    const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    out.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }
  return out;
}

/**
 * Transport adapter only. 接听、录音、挂断的权威始终在 Control 与网关；这里只有一条 WebSocket。
 */
export class DoubaoVoiceAgent extends EventEmitter {
  constructor({
    apiKey,
    model = DOUBAO_MODEL,
    voice = DOUBAO_VOICE,
    instructions,
    greeting = DOUBAO_GREETING,
    speed,
    loudness,
    strictAudit = true,
    exitIntent = true,
    endCallTool = false,
    // S27 决策 5: 豆包没有"服务端已自动取消"这一说，打断要客户端显式发 response.cancel。
    // `off` 用于排查"AI 被自己的回声打断"一类现场问题，默认是 cancel。
    bargeIn = 'cancel',
    outputFormat = DOUBAO_OUTPUT_FORMAT,
    realtimeUrl,
    socketFactory = (url, options) => new WebSocket(url, options),
  } = {}) {
    super();
    if (!Object.hasOwn(OUTPUT_SAMPLE_BYTES, outputFormat)) throw new Error('Invalid Doubao output format');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(model ?? ''))) throw new Error('Invalid Doubao model');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(voice ?? ''))) throw new Error('Invalid Doubao voice');
    if (bargeIn !== 'cancel' && bargeIn !== 'off') throw new Error('Invalid Doubao barge-in mode');
    Object.assign(this, { apiKey, model, voice, greeting, socketFactory });
    this.instructions = String(instructions ?? '');
    this.speed = speed === undefined ? undefined : bounded(speed, 'Doubao speed', -50, 100);
    this.loudness = loudness === undefined ? undefined : bounded(loudness, 'Doubao loudness', -50, 100);
    this.strictAudit = strictAudit !== false;
    this.exitIntent = exitIntent !== false;
    this.endCallTool = endCallTool === true;
    this.bargeIn = bargeIn;
    this.outputFormat = outputFormat;
    this.url = doubaoRealtimeUrl(realtimeUrl);
    this.state = 'idle';
    this.sequence = -1;
    this.outputGeneration = 0;
    // 与 `outputGeneration` 一对：这一轮回复开始时的分代。两者不等即说明中途打断过，
    // 在途音频必须丢弃（xai.mjs:239 的同一道围栏）。
    this.responseGeneration = 0;
    this.responseActive = false;
    this.sessionOpen = false;
    // 服务端确认过 `session.closed` 才算优雅关闭（R11 §6.2）；冒烟脚本据此判断是否"干净收尾"。
    this.sessionClosedAck = false;
    this.closedEmitted = false;
    this.greeted = false;
    this.greetingLogged = false;
    this.callerPartial = undefined;
    this.unmuted = false;
    this.backlogNotified = false;
    this.backpressureSinceMs = undefined;
    this.backpressureNotified = false;
    this.eventSeq = 0;
    this.droppedPackets = 0;
    this.queue = [];
    this.textBuffers = new Map();
    // S27 决策 12/13：模型调用过 `end_call`。此后服务端随时可能自己断链，而道别的音频还排在
    // 播放队列里——`stop()` 与 `closed` 都要按"这是预期的收尾"处理，见 stop()/finishClose()。
    this.endCallRequested = false;
    /** 正在流式输出文本的那一轮（`response.output_text.delta` 最近一次带的 response_id）。 */
    this.textResponseId = undefined;
    /** 已经由 `end_call` 替它落过终稿的 response，防止迟到的 `output_text.done` 再落一条。 */
    this.endCallFinalised = new Set();
    this.resampler = new Pcm24kTo16kResampler();
  }

  /** R11 §3.10：所有上行事件都带 `event_id`，服务端会回带，用于链路追踪。 */
  nextEventId() { return `evt_${++this.eventSeq}`; }

  sendEvent(event) {
    if (this.state !== 'ready' || this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify({ event_id: this.nextEventId(), ...event })); return true; }
    catch (error) {
      // One agent per run, so this flag is "first failure of the run"; the worker logs it.
      if (!this.sendFailedNotified) { this.sendFailedNotified = true; this.emit('notice', { kind: 'provider_send_failed', message: String(error?.message ?? '').slice(0, 80) }); }
      return false;
    }
  }

  sessionCreate() {
    return {
      event_id: this.nextEventId(),
      type: 'session.create',
      session: {
        model: this.model,
        instructions: this.instructions,
        audio: {
          input: { format: { type: 'pcm', rate: 16_000 } },
          output: {
            format: { type: 'pcm', rate: 24_000 },
            voice: this.voice,
            ...(this.speed === undefined ? {} : { speed: this.speed }),
            ...(this.loudness === undefined ? {} : { loudness: this.loudness }),
          },
        },
        ...(this.endCallTool ? { tools: [END_CALL_TOOL] } : {}),
      },
      // R11 §6.1：专有能力一律走 extension 透传。`asr`/`tts` 保持空对象（与文档示例一致），
      // dialog.extra 只带这次真正需要的两个开关。
      extension: {
        asr: {},
        tts: {},
        dialog: { extra: { strict_audit: this.strictAudit, enable_user_query_exit: this.exitIntent } },
      },
    };
  }

  async start({ signal } = {}) {
    if (this.state !== 'idle') throw new Error('Agent already started');
    if (!this.apiKey) throw new Error('AI is not configured');
    if (!this.instructions) throw new Error('AI is not configured');
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      this.rejectSetup = reject;
      const abort = () => this.stop(signal.reason instanceof Error ? signal.reason : new Error('AI setup aborted'));
      if (signal?.aborted) {
        this.state = 'closed';
        this.rejectSetup = undefined;
        reject(signal.reason instanceof Error ? signal.reason : new Error('AI setup aborted'));
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.removeAbortListener = () => signal?.removeEventListener('abort', abort);
      let ws;
      try {
        // R11 §1：请求头只有 `X-Api-Key` 一个字段，没有别的可选头。
        ws = this.socketFactory(this.url, {
          headers: { 'X-Api-Key': this.apiKey },
          handshakeTimeout: 12_000,
          maxPayload: MAX_PROVIDER_MESSAGE_BYTES,
        });
        this.socket = ws;
      } catch (error) {
        this.state = 'closed';
        this.rejectSetup = undefined;
        this.removeAbortListener?.();
        reject(error);
        return;
      }
      const timer = setTimeout(() => { this.emit('notice', { kind: 'setup_timeout' }); reject(new Error('AI setup timeout')); this.stop(); }, SETUP_TIMEOUT_MS);
      this.setupTimer = timer;
      ws.on('open', () => {
        if (this.state !== 'connecting') return;
        try { ws.send(JSON.stringify(this.sessionCreate())); }
        catch (error) { this.emit('notice', { kind: 'session_create_send_failed' }); this.emit('fault', error); this.stop(); }
      });
      ws.on('message', raw => {
        // A throw inside a `ws` listener is not caught by the provider thread's port handler and
        // would kill the isolate mid-call; the run's existing failure path is the right outcome.
        try { this.onProviderMessage(raw, resolve, reject); }
        catch (error) {
          this.emit('notice', { kind: 'message_handler_error' });
          this.emit('fault', error instanceof Error ? error : new Error('Provider message handling failed'));
          this.stop();
        }
      });
      ws.on('error', error => {
        if (this.state === 'closed') return;
        clearTimeout(timer);
        this.emit('notice', { kind: 'socket_error' });
        reject(error);
        // S27 决策 15（xAI 真实通话 c3734597 的同源问题）：`end_call` 之后服务端自己拆链，`ws` 会
        // 先报 `error` 再报 `close`。那一声 fault 会让 worker `stop('provider_failed')`，在收尾
        // drain 还没跑完的时候就把桥拆了，来电者听到的再见被切掉一截。预期的收尾不是故障：
        // 安静地 stop()，由 `close` 处理器发 `closed {reason:'ended_by_provider'}`。
        if (!this.endCallRequested) this.emit('fault', error);
        this.stop();
      });
      ws.on('close', code => {
        clearTimeout(timer);
        // S69: kept for the `closed` payload; the close reason text is provider text and is dropped.
        if (Number.isInteger(code)) this.closeCode = code;
        // 先按常规路径收尾（围栏播放、停节拍器），再无条件结束等待：服务端主动断链时
        // `session.closed` 永远不会到，`stop()` 里那个 2 秒等待必须在这里被解除。
        this.stop();
        this.finishClose();
      });
    });
  }

  onProviderMessage(raw, resolve, reject) {
    if (Buffer.byteLength(raw) > MAX_PROVIDER_MESSAGE_BYTES) {
      this.emit('notice', { kind: 'message_too_large' });
      this.emit('fault', new Error('Provider message exceeded limit'));
      this.stop();
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch {
      this.emit('notice', { kind: 'invalid_json' });
      this.emit('fault', new Error('Invalid provider JSON'));
      this.stop();
      return;
    }
    const type = event?.type;
    // `session.closed` 是 `stop()` 在等的那一条，必须先于 closed 守卫处理。
    if (type === 'session.closed') { this.sessionClosedAck = true; this.finishClose(); return; }
    if (this.state === 'closed') {
      // relay-secondary 实测（2026-09-12 探针）：发出 `session.close` 之后、`session.closed` 之前，服务端
      // 还会补一条 `error`（`55000000 rpc error … the stream is done`）。那是它自己收尾的噪音，
      // 不是这通电话的故障——记一条 notice，继续等 `session.closed`，绝不当 fault。
      if (type === 'error') this.emit('notice', { kind: 'error_after_close' });
      return;
    }

    if (type === 'session.created') {
      if (this.state !== 'connecting') return;
      clearTimeout(this.setupTimer);
      this.rejectSetup = undefined;
      this.sessionId = text(event.session?.id) || undefined;
      this.sessionOpen = true;
      this.state = 'ready';
      // R11 §2/§5：模型靠上行音频流保活。worker 最多提前 30 秒预热，这段时间里一帧来电者音频
      // 都没有，不发静音事件服务端就会判超时、之后不再回应。
      this.sendEvent({ type: 'input_audio_mute.commit' });
      resolve({ provider: 'doubao', sessionId: this.sessionId ?? null, model: this.model });
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.started') {
      // 豆包不会自己取消在播的回复（对比 xAI 的 server VAD），打断必须客户端显式发起。
      if (this.bargeIn !== 'off' && this.responseActive) this.interrupt({ sendCancel: true });
      this.emit('speechStarted');
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      // 实测（2026-09-12 探针）：豆包的 ASR delta 是**累计**全文（"你"→"你好"→"你好我"…），不是增量。
      // 留一份最新版本：completed 缺文本、或根本不来（模型直接开答）时，它就是这句话的终稿。
      if (typeof event.delta === 'string') this.callerPartial = event.delta.slice(0, MAX_TEXT);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      // 实测：终稿字段是 `text`（文档示例写的是 `transcript`），两种都认。
      const whole = String(event.text ?? event.transcript ?? '') || this.callerPartial || '';
      this.callerPartial = undefined;
      if (whole) this.emit('transcript', { text: whole.slice(0, MAX_TEXT), final: true, speaker: 'caller' });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      // 一句没听清不是通话故障：只报一次 notice，绝不结束 run。
      this.emit('notice', { kind: 'transcription_failed' });
      return;
    }

    if (type === 'response.output_text.delta') {
      this.flushCallerPartial();
      if (typeof event.delta === 'string') {
        // 记住"正在说话的那一轮"：`end_call` 之后服务端不再给它发 done，助手终稿得自己收尾。
        this.textResponseId = text(event.response_id);
        this.appendText(this.textResponseId, event.delta);
      }
      return;
    }
    if (type === 'response.output_text.done') {
      const responseId = text(event.response_id);
      // `end_call` 已经替这一轮落过终稿（finaliseEndCallText）。服务端若日后补发 done，
      // 无论它带不带 `text` 都必须忽略，否则道别那句会在通话记录里出现两遍。
      if (this.endCallFinalised.has(responseId)) {
        this.endCallFinalised.delete(responseId);
        this.textBuffers.delete(responseId);
        return;
      }
      const whole = String(event.text ?? '') || this.textBuffers.get(responseId) || '';
      this.textBuffers.delete(responseId);
      // 助手文本只发这一条终稿：transcript-log 会按 responseId 累积，增量再发一遍就是双份。
      if (whole) this.emit('transcript', { text: whole.slice(0, MAX_TEXT), final: true, responseId: responseId || undefined });
      return;
    }

    if (type === 'response.output_audio.started') {
      this.flushCallerPartial();
      // R11 §3.1 的示例里打招呼那一轮 `response_id` 是空串、只有 `question_id`。
      const responseId = text(event.response_id) || text(event.question_id) || undefined;
      this.responseId = responseId;
      this.responseGeneration = this.outputGeneration;
      this.responseActive = true;
      // 开场白是客户端文本合成（tts_type=chat_tts_text），服务端不会给它发 output_text.done；
      // 通话记录里没有 AI 的第一句话很奇怪，这里补一条助手终稿。它带 `immediate`，在开始播放这一刻直接落库：
      // 线上 output_audio.done 带回的 id 与这里的 key 对不上（run 5ff14059），按 responseId 等 completed
      // 会让开场白一直挂到收尾才落库，排在来电者之后。
      if (event.tts_type === 'chat_tts_text' && this.greeted && !this.greetingLogged) {
        this.greetingLogged = true;
        this.emit('transcript', { text: this.greeting.slice(0, MAX_TEXT), final: true, responseId, immediate: true });
      }
      // 每轮重置重采样器：上一轮被打断后残留在 FIR 历史里的尾巴不该渗进下一句。
      this.resampler = new Pcm24kTo16kResampler();
      this.audioRemainder = undefined;
      if (responseId) this.emit('response', responseId);
      if (event.tts_type === 'audit_content_risky') this.emit('notice', { kind: 'audit_risky' });
      return;
    }
    if (type === 'response.output_audio.delta') {
      if (typeof event.delta !== 'string' || event.delta.length > MAX_PROVIDER_MESSAGE_BYTES * 2) return;
      // 分代围栏：打断之后到达的、属于被取消那一轮的音频必须丢掉，否则来电者会听见 AI 抢话。
      if (this.responseGeneration !== this.outputGeneration || this.state !== 'ready') return;
      // 一个 delta 只是字节流的一段，没有承诺按采样点对齐：落单的字节留给下一段，
      // 既不丢样本，也不会让解码/重采样因为长度不整抛异常。
      const sampleBytes = OUTPUT_SAMPLE_BYTES[this.outputFormat];
      let bytes = Buffer.from(event.delta, 'base64');
      if (this.audioRemainder?.length) { bytes = Buffer.concat([this.audioRemainder, bytes]); this.audioRemainder = undefined; }
      const tail = bytes.length % sampleBytes;
      if (tail) {
        this.audioRemainder = Buffer.from(bytes.subarray(bytes.length - tail));
        bytes = bytes.subarray(0, bytes.length - tail);
      }
      if (!bytes.length) return;
      // S70: f32le is resampled as float and quantized once; s16le keeps the int16 path.
      const pcm = this.outputFormat === 'f32le' ? this.resampler.processFloat32(bytes) : this.resampler.process(bytes);
      if (!pcm.length) return;
      // 下游（audio-bridge / GenerationPlaybackQueue）按字节切 16 kHz 帧，从不读 sampleRate：
      // 24 kHz 必须在这里降成 16 kHz，否则会以约 1.5 倍速播放且没有任何报错。
      this.emit('audio', { pcm, sampleRate: 16_000, responseId: text(event.response_id) || this.responseId, generation: this.outputGeneration });
      return;
    }
    if (type === 'response.output_audio.done') {
      const responseId = text(event.response_id) || this.responseId;
      const generation = this.responseGeneration;
      this.responseActive = false;
      this.emit('completed', { status: 'completed', responseId, generation, current: generation === this.outputGeneration });
      // 退出意图排在 completed 之后：worker 要先让播放队列收尾，再挂断。
      if (this.exitIntent && String(event.status_code ?? '') === '20000002') this.emit('notice', { kind: 'exit_intent' });
      if (responseId && responseId === this.responseId) this.responseId = undefined;
      return;
    }
    if (type === 'response.canceled') {
      const cancelled = this.cancelled;
      this.cancelled = undefined;
      this.responseActive = false;
      if (cancelled) {
        this.emit('completed', { status: 'cancelled', responseId: cancelled.responseId, generation: cancelled.generation,
          current: cancelled.generation === this.outputGeneration });
      }
      return;
    }
    if (type === 'response.function_call_arguments.done') { this.onFunctionCall(event); return; }
    // `response.done` 只是这一轮的用量统计（R11 §4），不是通话事件；`session.updated`、
    // `conversation.item.*`、`input_audio_buffer.committed` 同理，全部忽略。

    if (type === 'error') {
      const kind = doubaoFaultKind(event.error?.code ?? event.code ?? event.status_code);
      const detail = String(event.error?.message ?? event.message ?? '').slice(0, 200);
      const error = Object.assign(new Error(detail ? `${kind}: ${detail}` : kind), { code: kind });
      clearTimeout(this.setupTimer);
      // `fault` 的附加字段过不了线程边界（只剩 message），而日志只写 notice.kind——
      // 先发一条分类 notice，故障类型才会出现在 `provider_notice` 里，且不带供应商原文。
      this.emit('notice', { kind });
      reject(error);
      this.emit('fault', error);
      this.stop();
    }
  }

  /** 模型开始作答即视为来电者这句话说完了：累计 delta 的最新版本就是终稿。 */
  flushCallerPartial() {
    const partial = this.callerPartial;
    this.callerPartial = undefined;
    if (partial) this.emit('transcript', { text: partial, final: true, speaker: 'caller' });
  }

  /** 助手文本增量只在内部累积，上限与 transcript-log 的缓冲一致。 */
  appendText(responseId, delta) {
    const previous = this.textBuffers.get(responseId) ?? '';
    if (previous.length >= MAX_TEXT) return;
    this.textBuffers.set(responseId, (previous + delta).slice(0, MAX_TEXT));
    while (this.textBuffers.size > MAX_TEXT_BUFFERS) this.textBuffers.delete(this.textBuffers.keys().next().value);
  }

  /**
   * R11 §3.8/§6.7：每个 `call_id` 都要回传结果，模型才会继续；一次 done 可能带多个调用。
   * `end_call` 是唯一的例外，见下面的注释；其余工具（目前一个也没声明）照旧回 `{"ok":true}`，
   * 真正的挂断始终由 worker 做，适配器不碰通话控制。
   */
  onFunctionCall(event) {
    const items = Array.isArray(event.items) ? event.items.slice(0, 8) : [];
    const replies = [];
    let endCall = false;
    for (const item of items) {
      const callId = text(item?.call_id);
      if (!callId) continue;
      // S27 决策 12 补充（2026-09-12 真实通话 + 冒烟）：`end_call` 不回传结果。回传 `{"ok":true}` 会让模型再生成
      // 一轮"已挂断 / 已结束通话"的旁白并合成出来，来电者真的会听到；道别的音频在函数调用之前已经在流里。
      // 不回传，模型就停在这里等，而 worker 在播放队列放完后几秒内就挂断了。
      if (item?.name === 'end_call') { endCall = true; continue; }
      replies.push({ call_id: callId, role: 'tool', content: [{ type: 'input_text', text: '{"ok":true}' }] });
    }
    if (replies.length) this.sendEvent({ type: 'conversation.item.create', items: replies });
    if (!endCall) return;
    this.endCallRequested = true;
    // 终稿排在通知之前：worker 收到 `end_call` 就开始排队挂断，通话记录必须先落地。
    this.finaliseEndCallText();
    this.emit('notice', { kind: 'end_call' });
  }

  /**
   * 不回传 `end_call` 的代价（2026-09-12 探针实测）：服务端从此不再给这一轮发
   * `response.output_text.done`，道别那句话会永远留在 `textBuffers` 里，通话记录缺最后一句。
   * 这里按"正在流式输出文本的那一轮"自己收尾，并记住它，免得服务端日后补发 done 落成两条。
   * 尾部空白/换行要去掉：实测流里那句是 "再见。\n"。
   */
  finaliseEndCallText() {
    const responseId = this.textResponseId;
    if (responseId === undefined) return;
    const whole = (this.textBuffers.get(responseId) ?? '').trimEnd();
    this.textBuffers.delete(responseId);
    this.textResponseId = undefined;
    this.endCallFinalised.add(responseId);
    while (this.endCallFinalised.size > MAX_TEXT_BUFFERS) this.endCallFinalised.delete(this.endCallFinalised.values().next().value);
    if (whole) this.emit('transcript', { text: whole.slice(0, MAX_TEXT), final: true, responseId: responseId || undefined });
  }

  /** R11 §3.1：打招呼就是让服务端把这段文本合成出来，每 run 至多一次。 */
  greet() {
    if (this.greeted || this.state !== 'ready') return false;
    if (!this.sendEvent({ type: 'speech_text_buffer.commit', text: this.greeting })) {
      this.emit('notice', { kind: 'greeting_failed' });
      return false;
    }
    this.greeted = true;
    return true;
  }

  /**
   * 桥每 100 ms 递一批 3200 字节（pcm-pipeline 的 `ProviderInputBatcher` 硬编码 5 帧）。
   * 豆包要的是 20 ms/640 字节且严格实时的节奏，所以这里只入队，由节拍器按 20 ms 发。
   * 边界校验与 xai.mjs:342-345 逐字一致：线程两侧是两份独立代码，适配器必须自己再挡一遍。
   */
  appendAudio(pcm, { sampleRate = 16_000, sequence } = {}) {
    if (this.state !== 'ready') throw new Error('AI not ready');
    if (sampleRate !== 16_000 || pcm.length % 2 || pcm.length > MAX_PCM_BYTES_PER_APPEND) throw new Error('Expected at most one second of PCM16 mono at 16 kHz');
    if (!Number.isInteger(sequence) || sequence <= this.sequence) throw new Error('Audio sequence must increase');
    this.sequence = sequence;
    // 第一批来电者音频 = 麦克风重新打开，先取消静音，否则服务端仍按"静音保活"处理。
    if (!this.unmuted) { this.unmuted = true; this.sendEvent({ type: 'input_audio_unmute.commit' }); }
    for (let offset = 0; offset < pcm.length; offset += PACKET_BYTES) {
      this.queue.push(pcm.subarray(offset, offset + PACKET_BYTES).toString('base64'));
    }
    while (this.queue.length > MAX_QUEUED_PACKETS) {
      this.queue.shift();
      this.droppedPackets++;
      if (!this.backlogNotified) { this.backlogNotified = true; this.emit('notice', { kind: 'input_backlog' }); }
    }
    this.startPacer();
  }

  startPacer() {
    if (this.pacer || !this.queue.length) return;
    this.nextSendAtMs = Date.now() + PACKET_MS;
    this.pacer = setInterval(() => this.drainAudio(), PACKET_MS);
    this.pacer.unref?.();
  }

  stopPacer() {
    clearInterval(this.pacer);
    this.pacer = undefined;
    this.nextSendAtMs = undefined;
  }

  /**
   * 一个 tick 只发"按单调时钟已经到点"的包，最多补 3 个：定时器在忙主机上会迟到（S22 实测
   * 10 ms 定时器约 14 ms 才触发），只发一个会让上行永远慢于实时——队列进出速率相同（每 100 ms
   * 进 5 包、出 5 包），那段落后就成了永久的上行时延；一次性倒出去又会被服务端判为"发送过快"。
   * 追赶上限 3 包/tick 意味着最快 3 倍实时且持续时间有界（队列本身封顶 1 秒），平均速率是实时。
   * 队列排空后节拍器停表，`nextSendAtMs` 一并作废，下一批音频重新对时。
   */
  drainAudio() {
    if (this.state !== 'ready' || this.socket?.readyState !== 1) { this.stopPacer(); return; }
    const now = Date.now();
    // 判据与阈值在 backpressure.mjs（xai.mjs 用同一份，两条链路的 `provider_notice` 才可比）。
    const pressure = backpressureCheck({ bufferedAmount: this.socket.bufferedAmount, now, sinceMs: this.backpressureSinceMs, notified: this.backpressureNotified });
    if (pressure.action !== 'send') {
      // 拥塞期间不再往缓冲里塞：队列自己封顶 1 秒（appendAudio 丢最旧的），来电者的话会缺一段，
      // 但通话继续——听不清一句远好过被挂断。只有持续不退或冲破硬线，才认定这条链路废了。
      this.backpressureSinceMs = pressure.sinceMs;
      if (pressure.notify) { this.backpressureNotified = true; this.emit('notice', { kind: 'input_backpressure' }); }
      if (pressure.action === 'fatal') {
        this.emit('notice', { kind: 'input_backpressure_fatal' });
        this.emit('fault', new Error('AI audio backpressure'));
        this.stop();
      }
      return;
    }
    if (pressure.cleared) {
      this.backpressureSinceMs = undefined;
      this.backpressureNotified = false;
      // 拥塞刚过去：积压的包按旧时钟算全部"到点"，会连着倒出去。重新对时，回到实时节奏。
      this.nextSendAtMs = now;
      this.emit('notice', { kind: 'input_backpressure_cleared' });
    }
    if (this.nextSendAtMs === undefined) this.nextSendAtMs = now;
    let sent = 0;
    while (this.queue.length && sent < MAX_CATCHUP_PACKETS && now >= this.nextSendAtMs) {
      if (!this.sendEvent({ type: 'input_audio_buffer.append', audio: this.queue[0] })) break;
      this.queue.shift();
      this.nextSendAtMs += PACKET_MS;
      sent++;
    }
    if (!this.queue.length) this.stopPacer();
  }

  /**
   * 丢弃在途音频。递增 `outputGeneration` 与 `emit('flushAudio')` 必须同帧发生，
   * 否则播放端的分代围栏会错位（R10 §1）。
   */
  interrupt({ sendCancel = true } = {}) {
    if (sendCancel && this.state === 'ready' && this.responseActive) {
      this.cancelled = { responseId: this.responseId, generation: this.responseGeneration };
      this.sendEvent({ type: 'response.cancel' });
    }
    this.responseActive = false;
    this.outputGeneration++;
    this.emit('flushAudio', { generation: this.outputGeneration });
  }

  /** 豆包的 ASR 事件默认就有，没有可选的转写开关要请求。 */
  requestInputTranscription() {}

  stop(reason = new Error('AI stopped during setup')) {
    if (this.state === 'closed') return;
    clearTimeout(this.setupTimer);
    // 会话真的建起来过才值得优雅关闭；setup 期间中止时socket 开着但没有 session。
    const graceful = this.sessionOpen && this.socket?.readyState === 1;
    this.state = 'closed';
    this.rejectSetup?.(reason instanceof Error ? reason : new Error('AI stopped during setup'));
    this.rejectSetup = undefined;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.stopPacer();
    this.queue.length = 0;
    // S27 决策 13：`end_call` 之后服务端随时会自己断链，而道别的最后一两秒还排在播放队列里按实时
    // 节奏放。推进分代 = GenerationPlaybackQueue.advanceGeneration() → clear()，正好把来电者还没
    // 听完的那半句再见丢掉。挂断由 worker 在 `whenPlaybackDrained()` 之后做，这里不设围栏。
    if (!this.endCallRequested) {
      this.outputGeneration++;
      this.emit('flushAudio', { generation: this.outputGeneration });
    }
    if (!graceful) { this.finishClose(); return; }
    try { this.socket.send(JSON.stringify({ event_id: this.nextEventId(), type: 'session.close' })); }
    catch { this.finishClose(); return; }
    this.closeTimer = setTimeout(() => this.finishClose(), CLOSE_WAIT_MS);
    this.closeTimer.unref?.();
  }

  /**
   * 关闭 WebSocket 并发一次 `closed`。可重入：socket.close() 会把我们自己的 close 处理器叫回来。
   * `closed` 恒带一个对象载荷：普通收尾是 `{}`，`end_call` 之后是 `{reason:'ended_by_provider'}`，
   * worker 据此把这次关闭算成"AI 自己说完再见了"，而不是 `provider_disconnected`。
   */
  finishClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.stopPacer();
    const socket = this.socket;
    const first = !this.closedEmitted;
    this.closedEmitted = true;
    if (socket?.readyState === 0 || socket?.readyState === 1) { try { socket.close(); } catch {} }
    else { try { socket?.terminate?.(); } catch {} }
    if (first) this.emit('closed', { ...(this.endCallRequested ? { reason: 'ended_by_provider' } : {}), ...(Number.isInteger(this.closeCode) ? { closeCode: this.closeCode } : {}) });
  }
}

/**
 * S27 决策 4: this provider reads these keys and nothing else. `availableProviders()` answers
 * "may this worker announce doubao to Control" with presence only — a malformed value still has to
 * fail startup inside `doubaoConfig`, never silently disable the provider.
 */
export const DOUBAO_ENV_KEYS = Object.freeze(['DOUBAO_API_KEY', 'DOUBAO_VOICE', 'DOUBAO_GREETING', 'DOUBAO_INSTRUCTIONS_FILE',
  'DOUBAO_MAX_CALL_SECONDS', 'DOUBAO_SILENCE_HANGUP_SECONDS', 'DOUBAO_STRICT_AUDIT', 'DOUBAO_EXIT_INTENT',
  'DOUBAO_END_CALL_TOOL', 'DOUBAO_BARGE_IN', 'DOUBAO_SPEED', 'DOUBAO_LOUDNESS', 'DOUBAO_MODEL', 'DOUBAO_OUTPUT_FORMAT', 'DOUBAO_REALTIME_URL']);

export function doubaoConfigured(env = {}) {
  return Boolean(env.DOUBAO_API_KEY);
}

const raw = (env, name) => (env[name] === undefined || env[name] === null ? '' : String(env[name]).trim());

function integer(env, name, { min, max, fallback }) {
  const value = raw(env, name);
  if (value === '') return fallback;
  // 正则先挡：`Number()` 会收下 '1e2'、'+180'、'180.0' 和全角空格。
  if (!/^-?\d{1,6}$/.test(value)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function boolean(env, name, fallback) {
  const value = raw(env, name).toLowerCase();
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * 人设提示词随镜像发布，不走 `--env-file`（docker 的 env-file 装不下多行文本）。
 * 相对路径按 `services/voice/` 解析，因为那是运行时的模块根。
 */
export function doubaoInstructions(env = {}) {
  const configured = raw(env, 'DOUBAO_INSTRUCTIONS_FILE') || DOUBAO_INSTRUCTIONS_FILE;
  const base = fileURLToPath(new URL('../', import.meta.url));
  const path = isAbsolute(configured) ? configured : resolve(base, configured);
  let value;
  try { value = readFileSync(path, 'utf8'); }
  catch { throw new Error(`DOUBAO_INSTRUCTIONS_FILE could not be read: ${path}`); }
  const instructions = value.trim();
  if (!instructions) throw new Error(`DOUBAO_INSTRUCTIONS_FILE is empty: ${path}`);
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) throw new Error(`DOUBAO_INSTRUCTIONS_FILE exceeds ${MAX_INSTRUCTIONS_CHARS} characters`);
  return instructions;
}

/**
 * Startup-time configuration for one Doubao session, validated once. The returned object is plain
 * structured-cloneable data on purpose: it crosses the `worker_threads` boundary in `workerData`.
 * `maxCallSeconds`/`silenceHangupSeconds` are read by the worker off `agent.config` (S27 决策 6);
 * the adapter itself never looks at them.
 */
export function doubaoConfig(env = {}) {
  const apiKey = raw(env, 'DOUBAO_API_KEY');
  if (!apiKey) throw new Error('DOUBAO_API_KEY is required');
  const voice = raw(env, 'DOUBAO_VOICE') || DOUBAO_VOICE;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(voice)) throw new Error('DOUBAO_VOICE must be a voice id');
  const model = raw(env, 'DOUBAO_MODEL') || DOUBAO_MODEL;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(model)) throw new Error('DOUBAO_MODEL must be a model id');
  const bargeIn = raw(env, 'DOUBAO_BARGE_IN') || 'cancel';
  if (bargeIn !== 'cancel' && bargeIn !== 'off') throw new Error('DOUBAO_BARGE_IN must be cancel or off');
  const outputFormat = raw(env, 'DOUBAO_OUTPUT_FORMAT') || DOUBAO_OUTPUT_FORMAT;
  if (!Object.hasOwn(OUTPUT_SAMPLE_BYTES, outputFormat)) throw new Error('DOUBAO_OUTPUT_FORMAT must be f32le or s16le');
  const speed = integer(env, 'DOUBAO_SPEED', { min: -50, max: 100, fallback: undefined });
  const loudness = integer(env, 'DOUBAO_LOUDNESS', { min: -50, max: 100, fallback: undefined });
  const endCallTool = boolean(env, 'DOUBAO_END_CALL_TOOL', false);
  const persona = doubaoInstructions(env);
  const config = {
    apiKey,
    model,
    voice,
    instructions: endCallTool ? `${persona}\n\n${END_CALL_INSTRUCTIONS}` : persona,
    greeting: raw(env, 'DOUBAO_GREETING') || DOUBAO_GREETING,
    strictAudit: boolean(env, 'DOUBAO_STRICT_AUDIT', true),
    exitIntent: boolean(env, 'DOUBAO_EXIT_INTENT', true),
    endCallTool,
    bargeIn,
    outputFormat,
    ...(speed === undefined ? {} : { speed }),
    ...(loudness === undefined ? {} : { loudness }),
    // S27 决策 6: 这两条是 AI 自己做不到的，由 worker 用计时器兜底。
    maxCallSeconds: integer(env, 'DOUBAO_MAX_CALL_SECONDS', { min: 60, max: 3_600, fallback: 180 }),
    silenceHangupSeconds: integer(env, 'DOUBAO_SILENCE_HANGUP_SECONDS', { min: 0, max: 120, fallback: 15 }),
    ...(raw(env, 'DOUBAO_REALTIME_URL') ? { realtimeUrl: doubaoRealtimeUrl(env.DOUBAO_REALTIME_URL) } : {}),
  };
  return config;
}

export const doubaoDefaults = Object.freeze({ url: DOUBAO_REALTIME_URL, model: DOUBAO_MODEL, voice: DOUBAO_VOICE, outputFormat: DOUBAO_OUTPUT_FORMAT,
  greeting: DOUBAO_GREETING, instructionsFile: DOUBAO_INSTRUCTIONS_FILE, packetBytes: PACKET_BYTES, packetMs: PACKET_MS,
  maxQueuedPackets: MAX_QUEUED_PACKETS, closeWaitMs: CLOSE_WAIT_MS });
