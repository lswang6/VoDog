import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface FcmAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}
type ServiceAccount = { type: string; project_id: string; client_email: string; private_key: string };
const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/firebase.messaging';

// Cancelling one delivery must not abort a refresh shared by other deliveries.
function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('FCM credentials request cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('FCM credentials request cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function serviceAccountTokenProvider(
  projectId: string,
  credentials: ServiceAccount,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): FcmAccessTokenProvider {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
    || credentials.type !== 'service_account' || credentials.project_id !== projectId
    || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(credentials.client_email)
    || !credentials.client_email.endsWith('@' + projectId + '.iam.gserviceaccount.com')) {
    throw new Error('Invalid FCM service account identity');
  }
  let key: KeyObject;
  try { key = createPrivateKey(credentials.private_key); } catch { throw new Error('Invalid FCM signing key'); }
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('FCM requires an RSA key of at least 2048 bits');
  }
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  async function refresh(): Promise<string> {
    const issued = Math.floor(now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: credentials.client_email, scope, aud: tokenUrl, iat: issued, exp: issued + 3600 })).toString('base64url');
    const unsigned = header + '.' + payload;
    const assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('FCM OAuth timeout')); }, 8000);
      timer.unref();
    });
    try {
      const work = async () => {
        const response = await fetcher(tokenUrl, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('FCM OAuth rejected'); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('FCM OAuth empty response');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 16384) throw new Error('FCM OAuth oversized response');
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof value.access_token !== 'string' || value.access_token.length < 16 || value.access_token.length > 8192
          || /[\s\r\n]/.test(value.access_token) || value.token_type?.toLowerCase() !== 'bearer'
          || !Number.isFinite(value.expires_in) || value.expires_in < 120 || value.expires_in > 3600) {
          throw new Error('FCM OAuth invalid response');
        }
        // A timed-out response must never populate the token cache.
        if (controller.signal.aborted) throw new Error('FCM OAuth timeout');
        cached = { token: value.access_token, expires: now() + (value.expires_in - 60) * 1000 };
        return value.access_token as string;
      };
      return await Promise.race([work(), deadline]);
    } catch { throw new Error('FCM OAuth token refresh failed'); }
    finally { clearTimeout(timer!); }
  }
  return {
    getAccessToken(signal) {
      if (signal?.aborted) return Promise.reject(new Error('FCM credentials request cancelled'));
      if (cached && now() < cached.expires) return cancellable(Promise.resolve(cached.token), signal);
      if (!pending) pending = refresh().finally(() => { pending = undefined; });
      return cancellable(pending, signal);
    },
  };
}

export async function createFcmAccessTokenProvider(projectId: string, credentialsPath: string): Promise<FcmAccessTokenProvider> {
  const file = await open(credentialsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error('FCM credentials require a private regular file');
    let credentials: ServiceAccount;
    try { credentials = JSON.parse(await file.readFile('utf8')); }
    catch { throw new Error('Invalid FCM credentials file'); }
    return serviceAccountTokenProvider(projectId, credentials);
  } finally { await file.close(); }
}
