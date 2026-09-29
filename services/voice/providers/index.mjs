import { DOUBAO_ENV_KEYS, DoubaoVoiceAgent, doubaoConfig, doubaoConfigured } from './doubao.mjs';
import { XAI_ENV_KEYS, XaiVoiceAgent, xaiConfig, xaiConfigured } from './xai.mjs';

/**
 * S24 决策 3: the voice provider registry. One place decides which realtime provider a run uses,
 * so adding a provider is a registry entry plus one module — never another branch in the worker.
 *
 * Every entry keeps the frozen agent contract: events audio / flushAudio / completed / fault /
 * notice / closed / transcript / speechStarted / response, methods start / stop / greet /
 * appendAudio / interrupt / requestInputTranscription, and the `outputGeneration` property.
 * Configuration keys are per-provider prefixed (xAI keeps `XAI_*`).
 */

/** The id shape Control and the worker heartbeat agree on. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const REGISTRY = {
  xai: { label: 'xAI', envKeys: XAI_ENV_KEYS, configured: xaiConfigured, config: xaiConfig, create: config => new XaiVoiceAgent(config) },
  // S27 决策 4: 第二家供应商。Control 的 `VOICE_PROVIDER_LABELS` 里"豆包"早就存在，三端设置页
  // 是数据驱动的，所以新增一家就是这一行 + 一个模块，worker 与三端都不需要改。
  doubao: { label: '豆包', envKeys: DOUBAO_ENV_KEYS, configured: doubaoConfigured, config: doubaoConfig, create: config => new DoubaoVoiceAgent(config) },
};

/**
 * S22 决策 5 expects an unusable provider to end the run through the existing failure path, which
 * is keyed on a lowercase code. Carrying the code on the error lets `VoiceWorker.execute` report it
 * without a second branch.
 */
export function providerUnavailable() {
  return Object.assign(new Error('Voice provider is unavailable'), { code: 'provider_unavailable' });
}

export function providerIds() { return Object.keys(REGISTRY); }

export function providerLabel(provider) { return entry(provider)?.label ?? null; }

/** Presence-only answer: what this worker may announce to Control in its heartbeat. */
export function availableProviders(env = {}) {
  return providerIds().filter(id => {
    try { return REGISTRY[id].configured(env) === true; } catch { return false; }
  });
}

/** Startup-time parse. Throws on a malformed value so a typo fails the service, never a call. */
export function providerConfig({ provider, env = {} } = {}) {
  const found = entry(provider);
  if (!found || !found.configured(env)) throw providerUnavailable();
  return found.config(env);
}

/**
 * `config` is the already-parsed startup configuration (it is what crosses into the provider
 * thread); `env` is the fallback for callers that hold only the environment. `overrides` exists
 * for tests to inject a socket factory and must stay out of the deployed path.
 */
export function createVoiceAgent({ provider, env, config, overrides } = {}) {
  const found = entry(provider);
  if (!found) throw providerUnavailable();
  const resolved = config ?? providerConfig({ provider, env: env ?? {} });
  return found.create({ ...resolved, ...(overrides ?? {}) });
}

function entry(provider) {
  if (typeof provider !== 'string' || !PROVIDER_ID_PATTERN.test(provider)) return null;
  return Object.hasOwn(REGISTRY, provider) ? REGISTRY[provider] : null;
}
