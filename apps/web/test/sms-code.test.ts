import assert from 'node:assert/strict';
import test from 'node:test';
import {verificationCode} from '../src/sms-code.ts';

test('verification codes are detected only next to a code keyword', () => {
  assert.equal(verificationCode('【服务】您的验证码为 4821，5 分钟内有效。'), '4821');
  assert.equal(verificationCode('Your login code: 773019'), '773019');
  assert.equal(verificationCode('123456 是您的动态码'), '123456');
  assert.equal(verificationCode('明天 1400 见，带上合同'), null);
  assert.equal(verificationCode('验证码已过期，请重新获取'), null);
  assert.equal(verificationCode('订单号 2024051812345678，验证码 5531'), '5531');
});
