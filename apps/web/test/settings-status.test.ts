import assert from 'node:assert/strict';
import test from 'node:test';
import {settingsStatus,simAnswerModeBadge} from '../src/settings-status.ts';

test('a submitted settings version succeeds only after a fresh exact-version observation',()=>{
 assert.equal(settingsStatus({version:6,appliedVersion:6},{target:6,fresh:false}),'正在应用中…');
 assert.equal(settingsStatus({version:6,appliedVersion:5},{target:6,fresh:true}),'正在应用中…');
 assert.equal(settingsStatus({version:6,appliedVersion:6},{target:6,fresh:true}),'应用成功');
});

test('a newer server settings version supersedes the submitted target even when applied is ahead',()=>{
 assert.equal(settingsStatus({version:7,appliedVersion:7},{target:6,fresh:true}),'设置已被另一客户端的新版本替代，请刷新后查看。');
 assert.equal(settingsStatus({version:7,appliedVersion:8},{target:6,fresh:true}),'设置已被另一客户端的新版本替代，请刷新后查看。');
});

test('S80 iOS copy: idle states and a 30 s unconfirmed submission turn into the warning',()=>{
 assert.equal(settingsStatus({version:6,appliedVersion:6}),'设备已确认当前设置');
 assert.equal(settingsStatus({version:6,appliedVersion:5}),'设置已保存，但设备尚未确认应用。');
 assert.equal(settingsStatus({version:6,appliedVersion:5},{target:6,fresh:true,timedOut:false}),'正在应用中…');
 assert.equal(settingsStatus({version:6,appliedVersion:5},{target:6,fresh:true,timedOut:true}),'设置已保存，但设备尚未确认应用。');
 assert.equal(settingsStatus({version:6,appliedVersion:6},{target:6,fresh:true,timedOut:true}),'应用成功');
});

test('S57 SIM answer-mode badge maps normal to 人工, ai/timeout_ai to AI, missing settings to nothing',()=>{
 assert.equal(simAnswerModeBadge({mode:'normal'}),'人工');
 assert.equal(simAnswerModeBadge({mode:'ai'}),'AI');
 assert.equal(simAnswerModeBadge({mode:'timeout_ai'}),'AI');
 assert.equal(simAnswerModeBadge(undefined),null);
 assert.equal(simAnswerModeBadge({mode:'unknown'}),null);
});
