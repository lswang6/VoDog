import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/**
 * S24 决策 3: the provider id shape Control validates on the far side of the heartbeat.
 * S25 决策 6 reuses the same shape for the optional `nodeId` (`relay-secondary` / `relay-primary`).
 */
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'];
export class ControlError extends Error {
  constructor(status, code) { super(`Control ${code} (${status})`); this.status = status; this.code = code; }
}

/** Dedicated service identity. Never accepts user, gateway, or media credentials. */
export class VoiceControlClient {
  constructor({ baseUrl, token, instanceId, bootId = randomUUID(), providers = [], nodeId, fetcher = fetch, timeoutMs = 3_000 }) {
    const url = new URL(baseUrl);
    // Service credentials require TLS whenever traffic leaves loopback.
    const hostLocalHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
    if ((!hostLocalHttp && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Voice Control must use a loopback HTTP or an HTTPS origin');
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('Invalid AI service identity');
    if (!UUID.test(instanceId) || !UUID.test(bootId)) throw new Error('Invalid worker identity');
    if (!Array.isArray(providers) || providers.length > 16 || !providers.every(id => typeof id === 'string' && PROVIDER_ID.test(id))) throw new Error('Invalid announced voice providers');
    if (nodeId !== undefined && (typeof nodeId !== 'string' || !PROVIDER_ID.test(nodeId))) throw new Error('Invalid worker node id');
    Object.assign(this, { baseUrl: url.origin, token, instanceId, bootId, providers: [...providers], nodeId, fetcher, timeoutMs });
  }
  identity() { return { instanceId: this.instanceId, bootId: this.bootId }; }
  async request(path, { method = 'POST', body, run, signal, timeoutMs = this.timeoutMs } = {}) {
    const response = await this.fetcher(`${this.baseUrl}/internal/v1/ai/${path}`, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`, ...(run ? { 'X-AI-Lease-Token': run.leaseToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return null;
    // Bound even error bodies and never expose arbitrary upstream text or headers.
    const reader = response.body?.getReader(); let length = 0; const chunks = [];
    if (reader) try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
        if (length > 192 * 1024) throw new ControlError(502, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ControlError(response.status, 'INVALID_RESPONSE'); }
    if (!response.ok) { const code = value?.error?.code ?? value?.code; throw new ControlError(response.status, typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'REQUEST_FAILED'); }
    return value;
  }
  // S24 决策 3: `providers` is what lets Control mark a voice provider "online" in the settings
  // picker. Control's heartbeat body strips keys it does not know, so announcing it is safe
  // against a Control that has not shipped the field yet.
  // S25 决策 6: `nodeId` says which host serves this instance, so an operator can tell the relay-secondary
  // container from the relay-primary unit kept for rollback. It rides the heartbeat only — claim, renew and
  // commit bodies are the frozen `identity()` and stay untouched — and it is omitted entirely when
  // unset, so a Control that ignores unknown keys sees exactly today's body.
  heartbeat(signal) { return this.request('workers/heartbeat', { body: { ...this.identity(), protocol: 'voice-run-v1', capacity: 1, providers: this.providers, ...(this.nodeId ? { nodeId: this.nodeId } : {}) }, signal }); }
  async claim(signal) { return (await this.request('runs/claim', { body: this.identity(), signal }))?.run ?? null; }
  path(run, suffix = '') { if (!UUID.test(run.id) || typeof run.leaseToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(run.leaseToken)) throw new Error('Invalid run lease'); return `runs/${run.id}${suffix}`; }
  async renew(run, signal) { return (await this.request(this.path(run, '/lease'), { method: 'PUT', body: this.identity(), run, signal })).lease; }
  commit(run, signal) { return this.request(this.path(run, '/commit-answer'), { body: this.identity(), run, signal }); }
  read(run, signal) { return this.request(`${this.path(run)}?${new URLSearchParams(this.identity())}`, { method: 'GET', run, signal }); }
  transcript(run, items, signal) { return this.request(this.path(run, '/transcript'), { body: { ...this.identity(), items }, run, signal }); }
  fail(run, code, signal) { if (!/^[a-z0-9_]{1,80}$/.test(code)) throw new Error('Invalid failure code'); return this.request(this.path(run, '/fail'), { body: { ...this.identity(), code }, run, signal }); }
  signaling(run) { return {
    options: (_callId, transport, signal) => this.request(this.path(run, '/media/options'), { body: { ...this.identity(), transport }, run, signal }),
    offer: (_callId, offer, signal) => this.request(this.path(run, '/media/offer'), { body: { ...this.identity(), ...offer }, run, signal, timeoutMs: 15_000 }),
  }; }
}
