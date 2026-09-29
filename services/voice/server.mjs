import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VoiceControlClient } from './control-client.mjs';
import { PROVIDER_ID_PATTERN, availableProviders, providerConfig, providerUnavailable } from './providers/index.mjs';
import { ThreadedVoiceAgent } from './provider-proxy.mjs';
import { loadWrtc } from './webrtc-media.mjs';
import { VoiceWorker, logLevel } from './worker.mjs';

// S23 决策 4 startup validation now lives with the provider that owns those keys; audio-smoke.mjs
// and the worker tests still import it from here, which is the surface they have always used.
export { vadSettings, xaiRealtimePort } from './providers/xai.mjs';

export function privateToken(path) {
  if (!path?.startsWith('/')) throw new Error('AI_INTERNAL_TOKEN_FILE must be an absolute path');
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('AI token must be a private regular file');
  return readFileSync(path, 'utf8').trim();
}
/**
 * A misconfigured hangup cap is worse than no cap: reject it instead of ignoring it.
 *
 * S27 决策 6: this is the **global default**. A provider may carry its own `maxCallSeconds` in the
 * configuration it parses at startup (`doubaoConfig` does: 180 s), and the worker prefers that for
 * the runs it serves; `AI_MAX_CALL_SECONDS` remains what every provider without one uses (xAI).
 */
export function maxCallSeconds(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') return 600;
  if (!/^\d{1,6}$/.test(raw)) throw new Error('AI_MAX_CALL_SECONDS must be an integer number of seconds between 60 and 3600');
  const seconds = Number.parseInt(raw, 10);
  if (seconds < 60 || seconds > 3600) throw new Error('AI_MAX_CALL_SECONDS must be between 60 and 3600');
  return seconds;
}
/** S23 决策 2: the worker→bridge leg. A typo must fail startup, never silently fall back to UDP. */
export function mediaTransport(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') return 'udp';
  if (raw !== 'udp' && raw !== 'tls') throw new Error('VOICE_MEDIA_TRANSPORT must be udp or tls');
  return raw;
}
/**
 * S24 决策 3: which provider a run uses when the claim does not name one. A typo here would
 * silently answer every call with the wrong provider — or with none — so it fails startup.
 */
export function defaultProvider(value, configured) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const provider = raw === '' ? 'xai' : raw;
  if (!PROVIDER_ID_PATTERN.test(provider)) throw new Error('VOICE_PROVIDER must be a lowercase provider id');
  if (!configured.includes(provider)) throw new Error(`VOICE_PROVIDER ${provider} is not configured`);
  return provider;
}
/**
 * S25 决策 6: which host this worker runs on, reported on the heartbeat so an operator can tell
 * the relay-secondary container from the relay-primary unit kept for rollback. Optional; a malformed value fails
 * startup rather than mislabelling the node in Control's view.
 */
export function workerNodeId(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') return undefined;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(raw)) throw new Error('VOICE_NODE_ID must be a lowercase node id');
  return raw;
}
/**
 * The single stdout log chokepoint: `ts` + `nodeId` on every line, and `callId` on run-scoped lines
 * (most carry only `runId`) so they join to Control's call_id without a lookup. The runId→callId
 * map learns from any record carrying both (`run_claimed` first) and forgets on `run_closed`.
 */
export function jsonLogger({ nodeId, write = line => process.stdout.write(line), now = () => new Date() } = {}) {
  const callIds = new Map();
  return record => {
    if (record?.runId && record.callId) {
      callIds.delete(record.runId); callIds.set(record.runId, record.callId);
      if (callIds.size > 32) callIds.delete(callIds.keys().next().value); // capacity is 1 run; bound leaks
    }
    const callId = record?.runId ? callIds.get(record.runId) : undefined;
    write(`${JSON.stringify({ ts: now().toISOString(), level: logLevel(record), event: record?.event, kind: record?.kind, nodeId, callId, ...record })}\n`);
    if (record?.event === 'run_closed') callIds.delete(record.runId);
  };
}
export async function main(env = process.env) {
  // Validate all startup configuration and native dependencies before advertising
  // worker health. The service's environment contains no DB or MEDIA_SECRET.
  const configured = availableProviders(env);
  const selected = defaultProvider(env.VOICE_PROVIDER, configured);
  // Parsed once, at startup, so a malformed key fails the service rather than a live call — and so
  // the result is plain data that can cross into the provider thread as `workerData`.
  const configs = new Map(configured.map(id => [id, providerConfig({ provider: id, env })]));
  const maxSeconds = maxCallSeconds(env.AI_MAX_CALL_SECONDS);
  const transport = mediaTransport(env.VOICE_MEDIA_TRANSPORT);
  const nodeId = workerNodeId(env.VOICE_NODE_ID);
  const control = new VoiceControlClient({ baseUrl: env.VOICE_CONTROL_ORIGIN || 'http://127.0.0.1:16880', token: privateToken(env.AI_INTERNAL_TOKEN_FILE), instanceId: env.VOICE_INSTANCE_ID, providers: configured, nodeId });
  const wrtc = await loadWrtc();
  if (!wrtc.nonstandard?.RTCAudioSource || !wrtc.nonstandard?.RTCAudioSink) throw new Error('Native WebRTC audio is unavailable');
  // S24 决策 2: one provider thread per run. The main thread keeps the wrtc objects, the audio
  // bridge's pacing and Control I/O; nothing else.
  const createAgent = ({ provider }) => {
    const config = configs.get(provider);
    if (!config) throw providerUnavailable();
    return new ThreadedVoiceAgent({ provider, config });
  };
  const worker = new VoiceWorker({ control, wrtc, createAgent, defaultProvider: selected, maxCallSeconds: maxSeconds, mediaTransport: transport, heapRestartMb: Number(env.VOICE_HEAP_RESTART_MB) || 120, log: jsonLogger({ nodeId }) });
  const stop = () => { void worker.stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await worker.start(); } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // S69: class and code only — a startup error message can name the token file path.
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'worker_fatal', errorName: String(error?.name ?? 'Error').slice(0, 64), code: error?.code != null ? String(error.code).slice(0, 80) : null })}\n`);
    process.stderr.write('Voice worker startup or runtime failed; inspect configuration without logging credentials.\n'); process.exitCode = 1;
  });
}
