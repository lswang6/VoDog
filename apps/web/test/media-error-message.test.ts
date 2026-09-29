import assert from 'node:assert/strict';
import test from 'node:test';
import {errorCode,mediaErrorMessage} from '../src/media-policy.ts';

const fallback='媒体连接失败';

test('every server media code becomes its own Chinese sentence',()=>{
 assert.deepEqual([
  'GATEWAY_OFFLINE','MEDIA_UNAVAILABLE','MEDIA_NODE_UNAVAILABLE','MEDIA_BRIDGE_UNAVAILABLE',
  'MEDIA_REVOKED','MEDIA_PROBE_REQUIRED','MEDIA_NODE_MISMATCH','MEDIA_NOT_WINNER',
 ].map(code=>mediaErrorMessage(code,fallback)),[
  '网关当前不在线（心跳超时），请稍后重试',
  '网关媒体能力暂不可用，请稍后重试',
  '当前网络与设备没有共同可用的媒体节点',
  '媒体节点未接受连接，请重试',
  '通话已结束或媒体授权失效',
  '网络测量尚未完成，请重试',
  '媒体节点不一致，请重新连接音频',
  '此通话已由其他设备接听',
 ]);
});

test('unknown codes, DOMException numeric codes and missing codes keep the original message',()=>{
 assert.equal(mediaErrorMessage('20','媒体连接已取消'),'媒体连接已取消');
 assert.equal(mediaErrorMessage(undefined,fallback),fallback);
 assert.equal(mediaErrorMessage('HTTP_500',fallback),fallback);
 assert.equal(mediaErrorMessage('toString',fallback),fallback,'object prototype keys must not leak a message');
 assert.equal(mediaErrorMessage('',fallback),fallback);
});

test('errorCode reads the server code and the DOMException numeric code',()=>{
 assert.equal(errorCode(Object.assign(new Error('offline'),{code:'GATEWAY_OFFLINE'})),'GATEWAY_OFFLINE');
 assert.equal(errorCode(new DOMException('媒体连接已取消','AbortError')),'20');
 assert.equal(errorCode(new Error('plain')),undefined);
 assert.equal(errorCode('GATEWAY_OFFLINE'),undefined);
});

test('S72: the two internal-call 409 codes read as fixed Chinese sentences',async()=>{
 const {callErrorMessage}=await import('../src/media-policy.ts');
 assert.equal(callErrorMessage('SAME_DEVICE_INTERNAL','x'),'同一设备上的两张卡不能互打');
 assert.equal(callErrorMessage('OWN_OUTGOING_CALL','x'),'这是你正在拨出的通话');
 assert.equal(callErrorMessage('GATEWAY_BUSY','服务端文案'),'服务端文案');
});
