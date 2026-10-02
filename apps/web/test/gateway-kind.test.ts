import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayArchiveLabel,gatewayKindLabel,gatewayShortLabel,gatewayTag} from '../src/gateway-kind.ts';

test('S58: missing or unknown gatewayKind reads as Pixel',()=>{
 for(const kind of [undefined,null,'','pixel','future']){
  assert.equal(gatewayKindLabel(kind).device,'Pixel');
  assert.equal(gatewayTag('abcdef0123456789',kind),'PX-abcdef0123456789');
  assert.equal(gatewayShortLabel('abcdef0123456789',kind),'Pixel · abcdef01');
  assert.equal(gatewayArchiveLabel(kind),'Pixel 原始归档');
  assert.equal(gatewayKindLabel(kind).deviceDial,'通过手机拨打');
  assert.equal(gatewayKindLabel(kind).occupied,'手机通话中');
 }
});

test('S91: gateway name wins over the short id; blank or missing name keeps the short id',()=>{
 assert.equal(gatewayShortLabel('abcdef0123456789','pixel','Pixel 7 Pro'),'Pixel 7 Pro');
 assert.equal(gatewayShortLabel('abcdef0123456789','dji4g','DJI 4G'),'DJI 4G');
 for(const name of [undefined,null,'','  '])assert.equal(gatewayShortLabel('abcdef0123456789','dji4g',name),'DJI 4G · abcdef01');
});

test('S58: dji4g labels follow the contract table',()=>{
 assert.equal(gatewayKindLabel('dji4g').device,'DJI 4G 模组');
 assert.equal(gatewayTag('abcdef0123456789','dji4g'),'DJI-abcdef0123456789');
 assert.equal(gatewayShortLabel('abcdef0123456789','dji4g'),'DJI 4G · abcdef01');
 assert.equal(gatewayArchiveLabel('dji4g'),'DJI 4G 原始归档');
 assert.equal(gatewayKindLabel('dji4g').deviceDial,'通过 DJI 4G 模组拨打');
 assert.equal(gatewayKindLabel('dji4g').occupied,'DJI 4G 模组通话中');
});
