import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DoubaoVoiceAgent, doubaoConfig } from './providers/doubao.mjs';

/**
 * S27 决策 8: 电话之前先冒烟。姊妹脚本 `audio-smoke.mjs` 是 xAI 专属的（URL、鉴权头、
 * session.update 形状都写死），所以豆包用这一份。
 *
 * 它跑的是**真的** `doubaoConfig` + 真的 `DoubaoVoiceAgent`——与线上通话同一段代码，区别只有
 * 没有 WebRTC 腿。密钥只从 process.env 读，绝不打印；输出只有一行 JSON，不含供应商原文。
 *
 *   node doubao-smoke.mjs [--seconds 3] [--wav /path/16k-mono.wav]
 */

const args = process.argv.slice(2);
const argOf = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const seconds = Math.min(30, Math.max(0, Number(argOf('--seconds') ?? 3) || 0));
const wavPath = argOf('--wav');

/** 只接受 worker 真正会送给适配器的规格：16 kHz、单声道、PCM16。 */
function wavPcm16k(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WAVE') throw new Error('WAV must be a RIFF/WAVE file');
  let offset = 12, format = null, data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString();
    const size = bytes.readUInt32LE(offset + 4);
    const body = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') format = { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV is missing its fmt or data chunk');
  if (format.tag !== 1 || format.channels !== 1 || format.rate !== 16_000 || format.bits !== 16) throw new Error('WAV must be 16 kHz mono PCM16');
  return data.subarray(0, data.length - (data.length % 2));
}

const result = { ok: false, sessionId: null, greetingFirstAudioMs: null, greetingBytes16k: 0, greetingZeroCrossingsPerSecond: null, aiReplied: false,
  transcripts: [], notices: [], faultKind: null, closedCleanly: false };

async function main() {
  const config = doubaoConfig(process.env);
  const agent = new DoubaoVoiceAgent(config);
  let audioBytes = 0, greetedAtMs = 0, completed = 0, closed = false;
  // 2026-09-12：三通真实来电只听到"机器人杂音"，根因是服务端下发 float32 而文档写 int16。冒烟从此
  // 顺带做一道"像不像语音"的粗检：16 kHz 语音的过零率通常 500–3000 次/秒，按错误格式解码的噪声
  // 在 7000 以上。不精确，但足以在发布前拦住同类错误。
  let crossings = 0, previousSample = 0, samples = 0;
  agent.on('audio', data => {
    if (greetedAtMs && result.greetingFirstAudioMs === null) result.greetingFirstAudioMs = Date.now() - greetedAtMs;
    audioBytes += data.pcm.length;
    for (let i = 0; i + 1 < data.pcm.length; i += 2) {
      const sample = data.pcm.readInt16LE(i);
      if (samples > 0 && (sample < 0) !== (previousSample < 0)) crossings++;
      previousSample = sample; samples++;
    }
  });
  agent.on('completed', () => { completed++; });
  agent.on('notice', notice => { if (result.notices.length < 20) result.notices.push(String(notice?.kind ?? 'unknown').slice(0, 64)); });
  agent.on('transcript', event => {
    if (result.transcripts.length >= 20) return;
    result.transcripts.push({ speaker: event?.speaker === 'caller' ? 'caller' : 'ai', final: event?.final === true, text: String(event?.text ?? '').slice(0, 200) });
  });
  agent.on('fault', error => { result.faultKind ??= String(error?.code ?? 'fault').slice(0, 64); });
  agent.on('closed', () => { closed = true; });

  const setup = new AbortController();
  const setupTimer = setTimeout(() => setup.abort(new Error('setup timed out')), 20_000);
  try { await agent.start({ signal: setup.signal }); } finally { clearTimeout(setupTimer); }
  result.sessionId = agent.sessionId ?? null;

  // 开场白：等第一块音频与这一轮的 completed（上限 20 秒）。
  greetedAtMs = Date.now();
  agent.greet();
  for (let i = 0; i < 200 && !completed && !closed && !result.faultKind; i++) await delay(100);
  result.greetingBytes16k = audioBytes;
  result.greetingZeroCrossingsPerSecond = samples ? Math.round(crossings / (samples / 16_000)) : null;

  // 来电者音频：第一次 appendAudio 会先发 input_audio_unmute.commit，之后按 100 ms 一批实时送。
  const pcm = wavPath ? wavPcm16k(wavPath) : Buffer.alloc(Math.round(seconds * 32_000) - (Math.round(seconds * 32_000) % 3_200));
  const startedAt = Date.now();
  let sequence = 4;
  for (let offset = 0; offset < pcm.length && !closed && !result.faultKind; offset += 3_200) {
    agent.appendAudio(Buffer.from(pcm.subarray(offset, offset + 3_200)), { sampleRate: 16_000, sequence });
    sequence += 5;
    await delay(Math.max(0, startedAt + (offset / 3_200 + 1) * 100 - Date.now()));
  }
  // 给模型留一轮回复的时间：服务端靠**持续的**上行音频判停并保活（2026-09-12 探针：音频一停就再也
  // 等不到 completed/回复），所以这里继续按实时节奏送静音，直到 AI 一轮说完或 8 秒。
  const silence = Buffer.alloc(3_200);
  const replyBaseline = completed;
  for (let i = 0; i < 80 && !closed && !result.faultKind && completed === replyBaseline; i++) {
    agent.appendAudio(silence, { sampleRate: 16_000, sequence });
    sequence += 5;
    await delay(100);
  }
  result.aiReplied = completed > replyBaseline;

  agent.stop(new Error('smoke finished'));
  for (let i = 0; i < 40 && !closed; i++) await delay(100);
  result.closedCleanly = agent.sessionClosedAck === true;
  const speechLike = result.greetingZeroCrossingsPerSecond !== null && result.greetingZeroCrossingsPerSecond < 4_000;
  result.ok = result.greetingBytes16k > 0 && speechLike && result.closedCleanly && result.faultKind === null;
}

main()
  .catch(error => { result.faultKind ??= String(error?.code ?? error?.message ?? 'smoke_failed').slice(0, 64); })
  .finally(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    setTimeout(() => process.exit(result.ok ? 0 : 1), 500).unref();
  });
