import type {TranscriptClassificationResult, TranscriptionAttempt, TranscriptionProvider, TranscriptionResult} from './worker.js';
import {validTranscriptionAudio} from './audio-format.js';
import {retryAfterPolicy, TranscriptionProviderHttpError} from './provider-error.js';

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** S23 决策 5: the OpenAI-compatible server only speaks `/chat/completions`, so the audio rides in one user message. */
const OPENAI_AUDIO_FORMATS: Record<string, string> = {'audio/wav': 'wav', 'audio/ogg': 'ogg'};
/** Pixel's canonical PCM WAV is 16 kHz mono 16-bit, so payload bytes divide by 32 to milliseconds. */
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_MS = 32;
const MAX_SEGMENT_MS = 24 * 60 * 60 * 1_000;
/** The server's proxy cuts a hung request at 60 s, so one attempt waits 65 s and no longer. */
const ATTEMPT_TIMEOUT_MS = 65_000;
const OPENAI_TRANSCRIPTION_PROMPT =
  '请逐字转写这段通话音频。只输出一个 JSON 对象，格式为 {"segments":[{"startMs":<整数>,"endMs":<整数>,"text":"..."}]}。' +
  '按自然停顿分句，startMs 与 endMs 是相对音频开头的整数毫秒并随分句递增；text 只写音频里听到的原话（中文用简体中文），' +
  '不要翻译、不要总结、不要添加说话人标签。不要输出 Markdown 代码围栏或任何解释文字。' +
  '如果音频里没有清晰可辨的人声（只有静音、噪声、按键音或提示音），输出 {"segments":[]}；绝不猜测、补全或编造内容。';
/** Second attempt: the simplest request the server is known to answer, with no format contract. */
const OPENAI_PLAIN_TRANSCRIPTION_PROMPT = '请逐字转写这段通话音频，只输出文字，按自然停顿分行。没有清晰人声时不要猜测或编造。';
/** Provider word annotations are grouped per utterance so stored segments read as sentences, not one row per word. */
const UTTERANCE_GAP_MS = 700;
const MAX_UTTERANCE_CHARS = 240;
const SENTENCE_END = /[。！？!?；;…]["'”’」』）)]?$/u;

export type TranscriptClassifier = (input: {
  callId: string; snapshotOwnerId: string; text: string; segments: unknown[]; signal: AbortSignal;
}) => Promise<TranscriptClassificationResult>;
export type {TranscriptClassificationResult} from './worker.js';

export type GeminiTranscriptionOptions = {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  prompt?: string;
  classifier?: TranscriptClassifier;
  clock?: () => Date;
};

export function createGeminiTranscriptionProvider(options: GeminiTranscriptionOptions): TranscriptionProvider {
  const apiKey = options.apiKey.trim();
  const model = (options.model ?? 'gemini-3.5-transcribe').trim();
  if (!apiKey) throw new Error('Transcription provider is not configured');
  if (!model || model.length > 120) throw new Error('Transcription model is invalid');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error('Transcription timeout is invalid');

  return {
    async transcribe(bytes, context): Promise<TranscriptionResult> {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) throw new Error('Transcription input must be between 1 byte and 20 MiB');
      if (!validTranscriptionAudio(bytes, context.mediaType, context.formatVersion)) throw new Error('Transcription input must be manifest v1 Ogg or verified Pixel v2/v3 PCM WAV audio');
      const linked = linkedSignal(context.signal, timeoutMs);
      try {
        const parts: Array<Record<string, unknown>> = [];
        if (options.prompt?.trim()) parts.push({text: options.prompt.trim()});
        parts.push({inline_data: {mime_type: context.mediaType, data: bytes.toString('base64')}});
        const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': apiKey},
          signal: linked.signal, redirect: 'error',
          body: JSON.stringify({
            contents: [{role: 'user', parts}],
            generationConfig: {audioTranscriptionConfig: {wordTimestamp: true, diarization: true}},
          }),
        });
        if (!response.ok) {
          const retryAfter = response.status === 429
            ? retryAfterPolicy(response.headers.get('retry-after'), (options.clock ?? (() => new Date()))().getTime())
            : {exceedsAutomaticWindow: false};
          await response.body?.cancel().catch(() => undefined);
          throw new TranscriptionProviderHttpError(response.status, retryAfter.delayMs, !retryAfter.exceedsAutomaticWindow);
        }
        const result = await readBoundedJson(response, MAX_RESPONSE_BYTES);
        const transcript = transcriptionResult(result);
        const version = typeof (result as any).modelVersion === 'string' ? (result as any).modelVersion : model;
        return {...transcript, provider: 'google-gemini', model, version};
      } finally { linked.dispose(); }
    },
    async classify(input) {
      if (!options.classifier) return {classification: 'unknown', summary: null, actionItems: []};
      return options.classifier(input);
    },
  };
}

export type OpenAICompatibleTranscriptionOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Optional second model, tried only after the configured model stalls twice. */
  fallbackModel?: string;
  fetcher?: typeof fetch;
  /** Per attempt, not per `transcribe()`: three attempts may run inside one call. */
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  prompt?: string;
  plainPrompt?: string;
  classifier?: TranscriptClassifier;
  clock?: () => Date;
};

/** Marks a stalled attempt — a hung upstream, not an answer — so the next plan may be tried. */
class TranscriptionAttemptStallError extends Error {
  constructor(readonly kind: 'timeout' | 'network', message: string) { super(message); this.name = 'TranscriptionAttemptStallError'; }
}

/**
 * S23 决策 5. The configured transcription server only exposes the OpenAI-compatible chat API, so the
 * audio is sent as one `input_audio` part and the model is asked for strict segment JSON. It has no
 * word timestamps and no diarization: the speaker still comes from the track, exactly as before.
 *
 * The proxy in front of it intermittently hangs: the same request 504s at the proxy's 60 s ceiling and
 * then succeeds seconds later, and one of its pooled upstream models can be exhausted while another
 * answers. So one `transcribe()` makes up to three attempts — configured model with the JSON prompt,
 * the same model with a plain-text prompt, then the optional fallback model with the JSON prompt —
 * and only a stall (5xx, attempt timeout, network failure) moves to the next one. A 429 is real
 * back-pressure and every other 4xx is a real answer: both stop immediately and keep worker semantics.
 */
export function createOpenAICompatibleTranscriptionProvider(options: OpenAICompatibleTranscriptionOptions): TranscriptionProvider {
  const endpoint = chatCompletionsEndpoint(options.baseURL, 'Transcription');
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  const fallbackModel = options.fallbackModel?.trim() || undefined;
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Transcription provider is not configured');
  for (const value of fallbackModel ? [model, fallbackModel] : [model]) {
    if (!value || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Transcription model is invalid');
  }
  const fetcher = options.fetcher ?? fetch;
  // The proxy's nginx cuts at 60 s, so waiting past 65 s only burns the worker's budget.
  const timeoutMs = options.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error('Transcription timeout is invalid');
  const maxTokens = options.maxTokens ?? 8_192;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768) throw new Error('Transcription token limit is invalid');
  // The verified request carried no `temperature`: this server fronts a reasoning model and such
  // endpoints often reject the parameter outright, so it is only sent when explicitly configured.
  const temperature = options.temperature;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('Transcription temperature is invalid');
  const jsonPrompt = options.prompt?.trim() || OPENAI_TRANSCRIPTION_PROMPT;
  const plainPrompt = options.plainPrompt?.trim() || OPENAI_PLAIN_TRANSCRIPTION_PROMPT;
  const plans: Array<{model: string; prompt: 'json' | 'plain'}> = [
    {model, prompt: 'json'},
    {model, prompt: 'plain'},
    ...(fallbackModel ? [{model: fallbackModel, prompt: 'json' as const}] : []),
  ];

  return {
    async transcribe(bytes, context): Promise<TranscriptionResult> {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) throw new Error('Transcription input must be between 1 byte and 20 MiB');
      if (!validTranscriptionAudio(bytes, context.mediaType, context.formatVersion)) throw new Error('Transcription input must be manifest v1 Ogg or verified Pixel v2/v3 PCM WAV audio');
      const format = OPENAI_AUDIO_FORMATS[context.mediaType];
      if (!format) throw new Error('Transcription input media type is not supported');
      const data = bytes.toString('base64');
      const durationMs = audioDurationMs(bytes, context.mediaType);
      const attempts: TranscriptionAttempt[] = [];
      for (let index = 0; index < plans.length; index++) {
        const plan = plans[index]!;
        const startedAt = Date.now();
        try {
          const answer = await requestTranscription({
            endpoint, apiKey, fetcher, timeoutMs, maxTokens, temperature, data, format, durationMs,
            model: plan.model, mode: plan.prompt, prompt: plan.prompt === 'json' ? jsonPrompt : plainPrompt,
            signal: context.signal, clock: options.clock ?? (() => new Date()),
          });
          attempts.push({model: plan.model, prompt: plan.prompt, status: answer.status, ms: Date.now() - startedAt});
          return {...answer.transcript, provider: 'openai-compatible', model: plan.model, version: answer.version, attempts};
        } catch (error) {
          attempts.push({model: plan.model, prompt: plan.prompt, status: attemptStatus(error), ms: Date.now() - startedAt});
          if (context.signal.aborted || index === plans.length - 1 || !stalledAttempt(error)) throw error;
        }
      }
      /* c8 ignore next */
      throw new Error('Transcription provider returned no transcription');
    },
    async classify(input) {
      if (!options.classifier) return {classification: 'unknown', summary: null, actionItems: []};
      return options.classifier(input);
    },
  };
}

async function requestTranscription(input: {
  endpoint: string; apiKey: string; fetcher: typeof fetch; timeoutMs: number; maxTokens: number;
  temperature: number | undefined; data: string; format: string; durationMs: number | undefined;
  model: string; mode: 'json' | 'plain'; prompt: string; signal: AbortSignal; clock: () => Date;
}): Promise<{transcript: {text: string; segments?: Array<{text: string; startMs?: number; endMs?: number}>}; version: string; status: number}> {
  const linked = linkedSignal(input.signal, input.timeoutMs);
  const stall = (error: unknown) => {
    if (input.signal.aborted) return error;
    if (linked.timedOut()) return new TranscriptionAttemptStallError('timeout', 'Transcription provider attempt timed out');
    return new TranscriptionAttemptStallError('network', 'Transcription provider request failed');
  };
  try {
    let response: Response;
    try {
      response = await input.fetcher(input.endpoint, {
        method: 'POST', headers: {'Authorization': `Bearer ${input.apiKey}`, 'Content-Type': 'application/json'},
        signal: linked.signal, redirect: 'error',
        body: JSON.stringify({
          model: input.model,
          messages: [{role: 'user', content: [
            {type: 'text', text: input.prompt},
            {type: 'input_audio', input_audio: {data: input.data, format: input.format}},
          ]}],
          max_tokens: input.maxTokens,
          ...(input.temperature === undefined ? {} : {temperature: input.temperature}),
        }),
      });
    } catch (error) { throw stall(error); }
    if (!response.ok) {
      const retryAfter = response.status === 429
        ? retryAfterPolicy(response.headers.get('retry-after'), input.clock().getTime())
        : {exceedsAutomaticWindow: false};
      await response.body?.cancel().catch(() => undefined);
      throw new TranscriptionProviderHttpError(response.status, retryAfter.delayMs, !retryAfter.exceedsAutomaticWindow);
    }
    const headerVersion = boundedVersion(response.headers.get('x-model-version'));
    let envelope: unknown;
    // A bounded or malformed body is a real answer; only a cut connection is a stall.
    try { envelope = await readBoundedJson(response, MAX_RESPONSE_BYTES); }
    catch (error) { throw linked.timedOut() && !input.signal.aborted ? stall(error) : error; }
    const transcript = chatTranscriptionResult(envelope, input.durationMs, input.mode);
    return {transcript, version: boundedVersion((envelope as any)?.model) ?? headerVersion ?? input.model, status: response.status};
  } finally { linked.dispose(); }
}

function stalledAttempt(error: unknown): boolean {
  return error instanceof TranscriptionAttemptStallError ||
    (error instanceof TranscriptionProviderHttpError && error.status >= 500);
}

function attemptStatus(error: unknown): number | string {
  if (error instanceof TranscriptionProviderHttpError) return error.status;
  if (error instanceof TranscriptionAttemptStallError) return error.kind;
  return 'invalid_response';
}

/** Turn one chat completion into the same `{text, segments}` shape the native Gemini path returns. */
function chatTranscriptionResult(value: unknown, durationMs: number | undefined, mode: 'json' | 'plain' = 'json'): {text: string; segments?: Array<{text: string; startMs?: number; endMs?: number}>} {
  const root = value as any;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Transcription provider returned no transcription');
  if (!Array.isArray(root.choices) || root.choices.length !== 1) throw new Error('Transcription provider returned no transcription');
  const choice = root.choices[0];
  if (!choice || typeof choice !== 'object') throw new Error('Transcription provider returned an unusable choice');
  // A truncated completion is a partial transcript that would otherwise be stored as the whole call.
  if (choice.finish_reason === 'length') throw new Error('Transcription provider truncated the transcription');
  if (typeof choice.finish_reason === 'string' && choice.finish_reason && choice.finish_reason !== 'stop') {
    throw new Error('Transcription provider returned an unusable choice');
  }
  // `reasoning_content` is present on this server and is deliberately ignored.
  const content = chatContentText(choice.message?.content);
  const body = stripJsonFence(content);
  if (!body) throw new Error('Transcription provider returned no transcription');
  // S78: the prompt's explicit "no speech" answer. The worker skips the track instead of retrying.
  if (mode === 'json' && /^\{\s*"segments"\s*:\s*\[\s*\]\s*\}$/.test(body)) return {text: '', segments: []};
  const strict = strictSegments(body);
  if (strict) return {text: joinWords(strict.map((segment) => segment.text)), segments: strict};
  // The contract was not met. Keep whatever words came back, never the JSON envelope.
  const salvaged = salvagedText(body);
  if (salvaged === null) throw new Error('Transcription provider returned no transcription');
  // The plain prompt asks for one utterance per line and claims no timing at all, so the lines become
  // segments without timestamps; the JSON prompt's fallback is one segment starting at 0, whose
  // `endMs` is only known when the source is Pixel's fixed-rate PCM WAV.
  if (mode === 'plain') {
    const lines = salvaged.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length) return {text: joinWords(lines), segments: lines.map((text) => ({text}))};
  }
  const flattened = salvaged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!flattened.length) throw new Error('Transcription provider returned no transcription');
  const text = joinWords(flattened);
  return {text, segments: [{text, startMs: 0, ...(durationMs === undefined ? {} : {endMs: durationMs})}]};
}

function chatContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object' && typeof (part as any).text === 'string' &&
          ((part as any).type === undefined || (part as any).type === 'text')) parts.push((part as any).text);
    }
    return parts.join('');
  }
  throw new Error('Transcription provider returned no transcription');
}

/** Unwrap exactly one Markdown envelope, matching the classifier's tolerance for this server. */
function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1]!.trim() : trimmed);
}

function strictSegments(body: string): Array<{text: string; startMs: number; endMs: number}> | null {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).segments;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const segments: Array<{text: string; startMs: number; endMs: number}> = [];
  let previousStartMs = 0;
  let previousEndMs = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const {text, startMs, endMs} = item as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) return null;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) return null;
    const start = startMs as number, end = endMs as number;
    if (start < 0 || end < start || end > MAX_SEGMENT_MS || start < previousStartMs || end < previousEndMs) return null;
    segments.push({text: text.trim(), startMs: start, endMs: end});
    previousStartMs = start;
    previousEndMs = end;
  }
  return segments;
}

/** `null` when nothing usable came back; never the raw JSON envelope of a contract the model half-kept. */
function salvagedText(body: string): string | null {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return body; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.segments)) {
    const parts: string[] = [];
    for (const item of record.segments) {
      const text = item && typeof item === 'object' && typeof (item as any).text === 'string' ? (item as any).text.trim() : '';
      if (text) parts.push(text);
    }
    return parts.length ? joinWords(parts) : null;
  }
  if (typeof record.text === 'string') return record.text.trim() || null;
  return body;
}

function audioDurationMs(bytes: Buffer, mediaType: string): number | undefined {
  if (mediaType !== 'audio/wav') return undefined;
  return Math.round((bytes.length - WAV_HEADER_BYTES) / WAV_BYTES_PER_MS);
}

/** Shared by the transcription provider and the report classifier: one fixed, credential-free HTTPS base. */
export function chatCompletionsEndpoint(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} base URL is invalid`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} base URL must be a credential-free HTTPS URL`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url.toString();
}

export function boundedVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 120 && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
}

function transcriptionResult(value: unknown): {text: string; segments?: Array<{text: string; startMs?: number; endMs?: number}>} {
  const root = value as any;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('Transcription provider returned no transcription');
  }
  if (root.promptFeedback !== undefined) {
    if (!root.promptFeedback || typeof root.promptFeedback !== 'object' || Array.isArray(root.promptFeedback) ||
        (root.promptFeedback.blockReason !== undefined && typeof root.promptFeedback.blockReason !== 'string')) {
      throw new Error('Transcription provider returned invalid prompt feedback');
    }
    if (root.promptFeedback.blockReason) throw new Error('Transcription provider blocked the response');
  }
  if (!Array.isArray(root.candidates) || root.candidates.length !== 1) {
    throw new Error('Transcription provider returned no transcription');
  }
  const textParts: string[] = [];
  const words: Array<{text: string; startMs?: number; endMs?: number}> = [];
  for (const candidate of root.candidates) {
    const safetyRatingsValid = candidate?.safetyRatings === undefined ||
      Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.every((rating: any) =>
        rating && typeof rating === 'object' && (rating.blocked === undefined || typeof rating.blocked === 'boolean'));
    if (!candidate || typeof candidate !== 'object' ||
        (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') ||
        !safetyRatingsValid ||
        (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.some((rating: any) => rating?.blocked === true)) ||
        !Array.isArray(candidate.content?.parts)) {
      throw new Error('Transcription provider returned an unusable candidate');
    }
    for (const part of candidate.content.parts) {
      if (typeof part?.text === 'string' && part.text.trim()) textParts.push(part.text.trim());
      if (part?.audioTranscription === undefined) continue;
      const audio = part.audioTranscription;
      if (!audio || typeof audio !== 'object' ||
          (audio.speakerLabel !== undefined && typeof audio.speakerLabel !== 'string') ||
          !Array.isArray(audio.words)) {
        throw new Error('Transcription provider returned invalid word annotations');
      }
      for (const item of audio.words) {
        const text = typeof item?.word === 'string' ? item.word.trim() : '';
        if (!text) throw new Error('Transcription provider returned invalid word annotations');
        const startMs = offsetMilliseconds(item.startOffset);
        const endMs = offsetMilliseconds(item.endOffset);
        if ((startMs === undefined) !== (endMs === undefined) ||
            (startMs !== undefined && endMs! < startMs)) {
          throw new Error('Transcription provider returned invalid word annotations');
        }
        words.push({text, ...(startMs === undefined ? {} : {startMs, endMs})});
      }
    }
  }
  const segments = groupWordsIntoUtterances(words);
  const annotatedText = joinWords(words.map((word) => word.text));
  const text = textParts.join('').trim() || annotatedText;
  if (!text) throw new Error('Transcription provider returned no transcription');
  return {text, ...(segments.length ? {segments} : {})};
}

/**
 * Merge provider word annotations into utterance-level segments. Timestamps stay on the first and last word of each
 * utterance so callers can still locate it, but a transcript no longer stores one segment per spoken word.
 */
function groupWordsIntoUtterances(words: Array<{text: string; startMs?: number; endMs?: number}>): Array<{text: string; startMs?: number; endMs?: number}> {
  const segments: Array<{text: string; startMs?: number; endMs?: number}> = [];
  let current: Array<{text: string; startMs?: number; endMs?: number}> = [];
  let currentChars = 0;
  const flush = () => {
    if (!current.length) return;
    const first = current[0]!, last = current[current.length - 1]!;
    segments.push({text: joinWords(current.map((word) => word.text)),
      ...(first.startMs === undefined ? {} : {startMs: first.startMs}),
      ...(last.endMs === undefined ? {} : {endMs: last.endMs})});
    current = [];
    currentChars = 0;
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    const gapMs = previous?.endMs === undefined || word.startMs === undefined ? undefined : word.startMs - previous.endMs;
    const startsNewUtterance = previous !== undefined &&
      (SENTENCE_END.test(previous.text) || (gapMs !== undefined && gapMs > UTTERANCE_GAP_MS) || currentChars + word.text.length > MAX_UTTERANCE_CHARS);
    if (startsNewUtterance) flush();
    current.push(word);
    currentChars += word.text.length;
  }
  flush();
  return segments;
}

function offsetMilliseconds(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?s$/.test(value)) {
    throw new Error('Transcription provider returned invalid word annotations');
  }
  const milliseconds = Number(value.slice(0, -1)) * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(Math.ceil(milliseconds))) {
    throw new Error('Transcription provider returned invalid word annotations');
  }
  return milliseconds;
}

function joinWords(words: string[]): string {
  return words.reduce((text, word) => {
    if (!text || /^\s|^[,.;:!?%)}\]\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a]/u.test(word) ||
        /[\s({\[\u201c\u300c\u300e\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a]$/u.test(text) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) &&
        /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) return text + word;
    return `${text} ${word}`;
  }, '');
}

function linkedSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let didTimeOut = false;
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => { didTimeOut = true; controller.abort(new Error('Transcription provider timed out')); }, timeoutMs);
  timer.unref();
  return {signal: controller.signal, timedOut: () => didTimeOut, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); }};
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); throw new Error('Transcription provider response is too large'); }
  if (!response.body) throw new Error('Transcription provider returned no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Transcription provider response is too large'); }
        chunks.push(value);
      }
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString('utf8')); }
  catch { throw new Error('Transcription provider returned invalid JSON'); }
}
