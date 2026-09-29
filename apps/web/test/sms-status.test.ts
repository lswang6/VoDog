import assert from 'node:assert/strict';
import test from 'node:test';
import {smsStatusLabel} from '../src/sms-status.ts';
test('SMS queue, unknown execution and failed dispatch have truthful user-facing status',()=>{
 assert.equal(smsStatusLabel({state:'queued',failureReason:'sms_gateway_execution_unresolved'}),'等待上一条短信状态确认');
 assert.equal(smsStatusLabel({state:'unknown',failureReason:'sms_execution_unresolved'}),'发送状态待确认，请勿重复发送');
 assert.equal(smsStatusLabel({state:'failed',failureReason:'sms_not_dispatched'}),'发送失败，短信尚未下发');
 assert.equal(smsStatusLabel({state:'failed',failureReason:'sms_route_changed_before_release'}),'发送失败，发送号码已变更');
 assert.equal(smsStatusLabel({state:'delivered',failureReason:'sms_gateway_execution_unresolved'}),'已送达');
 assert.equal(smsStatusLabel({state:'queued'}),'等待发送');
});
