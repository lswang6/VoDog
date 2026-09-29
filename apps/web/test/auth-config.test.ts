import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthConfigLoader,
  finishPasswordAttempt,
  initialAuthConfigState,
  loginAvailability,
  passkeyOptionsBody,
  passwordTurnstileToken,
  type AuthConfigState,
} from '../src/auth-config.ts';

test('auth config fails closed on failure, timeout and invalid enabled config, then recovers on explicit retry', async () => {
  const loader = new AuthConfigLoader();
  const states: AuthConfigState[] = [];

  await loader.load(async () => { throw new Error('配置服务暂不可用'); }, state => states.push(state), 20);
  assert.deepEqual(states.map(state => state.status), ['loading', 'error']);
  assert.match(states.at(-1)!.message, /配置服务暂不可用/);
  assert.deepEqual(loginAvailability(states.at(-1)!, null, false), {passwordDisabled: true, passkeyDisabled: false});
  assert.throws(() => passwordTurnstileToken(states.at(-1)!, null), /配置服务暂不可用/);

  states.length = 0;
  await loader.load(() => new Promise(() => {}), state => states.push(state), 5);
  assert.deepEqual(states.map(state => state.status), ['loading', 'error']);
  assert.match(states.at(-1)!.message, /读取超时/);

  states.length = 0;
  await loader.load(async () => ({turnstile: {enabled: true, siteKey: '   '}}), state => states.push(state), 20);
  assert.equal(states.at(-1)!.status, 'error');
  assert.match(states.at(-1)!.message, /配置无效/);

  states.length = 0;
  await loader.load(async () => ({turnstile: {enabled: true, siteKey: '  site-key  '}}), state => states.push(state), 20);
  const ready = states.at(-1)!;
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') throw new Error('expected ready config');
  assert.equal(ready.config.siteKey, 'site-key');
  assert.deepEqual(loginAvailability(ready, null, false), {passwordDisabled: true, passkeyDisabled: false});
  assert.deepEqual(loginAvailability(ready, 'fresh-token', false), {passwordDisabled: false, passkeyDisabled: false});
  assert.equal(passwordTurnstileToken(ready, 'fresh-token'), 'fresh-token');

  const disabled: AuthConfigState = {status: 'ready', config: {enabled: false, siteKey: null}, message: ''};
  assert.equal(passwordTurnstileToken(disabled, null), undefined);
  assert.deepEqual(loginAvailability(disabled, null, false), {passwordDisabled: false, passkeyDisabled: false});
});

test('a superseded config response cannot replace a newer retry result', async () => {
  const loader = new AuthConfigLoader();
  let resolveOld!: (value: {turnstile: {enabled: boolean; siteKey: string | null}}) => void;
  const oldRequest = new Promise<{turnstile: {enabled: boolean; siteKey: string | null}}>(resolve => { resolveOld = resolve; });
  const applied: AuthConfigState[] = [];
  const oldLoad = loader.load(() => oldRequest, state => applied.push(state), 100);
  await loader.load(async () => ({turnstile: {enabled: true, siteKey: 'new-key'}}), state => applied.push(state), 100);
  resolveOld({turnstile: {enabled: false, siteKey: null}});
  await oldLoad;
  assert.equal(applied.at(-1)!.status, 'ready');
  if (applied.at(-1)!.status !== 'ready') throw new Error('expected latest ready config');
  assert.equal(applied.at(-1)!.config.siteKey, 'new-key');
});

test('failed password attempts rotate the single-use token while Passkey remains independent of captcha config', async () => {
  let resets = 0;
  assert.equal(await finishPasswordAttempt(async () => false, () => { resets++; }), false);
  assert.equal(resets, 1);
  assert.equal(await finishPasswordAttempt(async () => true, () => { resets++; }), true);
  assert.equal(resets, 1);

  assert.deepEqual(loginAvailability(initialAuthConfigState, null, false), {passwordDisabled: true, passkeyDisabled: false});
  const configError: AuthConfigState = {status: 'error', config: null, message: '配置失败'};
  assert.deepEqual(loginAvailability(configError, null, false), {passwordDisabled: true, passkeyDisabled: false});
  assert.deepEqual(passkeyOptionsBody('account@example.com'), {username: 'account@example.com'});
  assert.throws(() => passkeyOptionsBody('   '), /请先输入用户名/);
});
