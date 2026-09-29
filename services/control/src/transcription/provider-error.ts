const MAX_RETRY_AFTER_MS = 15 * 60 * 1_000;
const MIN_RATE_LIMIT_RETRY_MS = 30 * 1_000;

export class TranscriptionProviderHttpError extends Error {
  readonly code: 'PROVIDER_RATE_LIMITED' | 'PROVIDER_RATE_LIMITED_DEFERRED' | 'PROVIDER_HTTP_ERROR';
  readonly retryable: boolean;

  constructor(readonly status: number, readonly retryAfterMs?: number, automaticRetry = true) {
    super(status === 429 && !automaticRetry
      ? 'Transcription provider HTTP 429; Retry-After exceeds the automatic retry window'
      : `Transcription provider HTTP ${status}`);
    this.name = 'TranscriptionProviderHttpError';
    this.code = status === 429
      ? (automaticRetry ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_RATE_LIMITED_DEFERRED')
      : 'PROVIDER_HTTP_ERROR';
    this.retryable = automaticRetry && (status === 429 || status >= 500);
  }
}

export function retryAfterPolicy(value: string | null, nowMs: number): {delayMs?: number; exceedsAutomaticWindow: boolean} {
  if (!value) return {exceedsAutomaticWindow: false};
  const trimmed = value.trim();
  if (trimmed.length > 128) return {exceedsAutomaticWindow: true};
  if (/^\d+$/.test(trimmed)) {
    const digits = trimmed.replace(/^0+/, '') || '0';
    if (digits.length > 3) return {exceedsAutomaticWindow: true};
    const seconds = Number(digits);
    if (seconds > MAX_RETRY_AFTER_MS / 1_000) return {exceedsAutomaticWindow: true};
    return {delayMs: seconds * 1_000, exceedsAutomaticWindow: false};
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return {exceedsAutomaticWindow: false};
  const delayMs = Math.max(0, at - nowMs);
  return delayMs > MAX_RETRY_AFTER_MS
    ? {exceedsAutomaticWindow: true}
    : {delayMs, exceedsAutomaticWindow: false};
}

export const maxTranscriptionRetryDelayMs = MAX_RETRY_AFTER_MS;
export const minRateLimitRetryDelayMs = MIN_RATE_LIMIT_RETRY_MS;
