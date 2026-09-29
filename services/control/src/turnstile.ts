/**
 * Cloudflare Turnstile verification for the pre-authentication endpoints.
 *
 * Turnstile is only enforced when the control service is configured with both a site key and a secret key, so a
 * missing secret can never silently disable the check on a deployment that turned it on (config validation refuses
 * to load instead). See https://developers.cloudflare.com/turnstile/get-started/server-side-validation/.
 */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_ERROR_CODES = 8;

export type TurnstileVerification = {success: boolean; error?: string; codes?: string[]};

export type TurnstileVerifierOptions = {
  secret: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  expectedHostname?: string;
  expectedAction?: string;
};

type TurnstileApiResponse = {
  success?: unknown;
  'error-codes'?: unknown;
  hostname?: unknown;
  action?: unknown;
};

function errorCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const codes = value.filter((code): code is string => typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code));
  return codes.length ? codes.slice(0, MAX_ERROR_CODES) : undefined;
}

export async function verifyTurnstileToken(token: unknown, remoteIp: string | undefined, options: TurnstileVerifierOptions): Promise<TurnstileVerification> {
  if (typeof token !== 'string' || !token.trim()) return {success: false, error: 'missing-token'};
  if (token.length > MAX_TOKEN_LENGTH) return {success: false, error: 'invalid-token'};
  if (!options.secret) return {success: false, error: 'turnstile-not-configured'};
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = new URLSearchParams({secret: options.secret, response: token});
  const ip = remoteIp?.trim();
  if (ip && ip.length <= 45) body.set('remoteip', ip);
  try {
    const response = await fetcher(SITEVERIFY_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {success: false, error: `upstream-${response.status}`};
    }
    const result = await response.json() as TurnstileApiResponse;
    if (result?.success !== true) return {success: false, error: 'verification-failed', ...(errorCodes(result?.['error-codes']) ? {codes: errorCodes(result['error-codes'])} : {})};
    if (options.expectedHostname && result.hostname !== options.expectedHostname) return {success: false, error: 'hostname-mismatch'};
    if (options.expectedAction && result.action !== options.expectedAction) return {success: false, error: 'action-mismatch'};
    return {success: true};
  } catch (error) {
    return {success: false, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable'};
  }
}
