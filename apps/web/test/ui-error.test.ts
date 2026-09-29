import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {act, create} from 'react-test-renderer';
import {diag} from '../src/diag.ts';
import {flashConfirmation, useReportedError} from '../src/ui-error.ts';

test('S69: useReportedError logs ui.error_shown when a message appears or changes, never for empty', async () => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: unknown[][] = [];
  const original = diag.uiError;
  diag.uiError = (...args: Parameters<typeof diag.uiError>) => {calls.push(args);};
  try {
    const Panel = ({message}: {message: string}) => {useReportedError('记录', 'reports', message); return null;};
    let renderer!: ReturnType<typeof create>;
    await act(async () => {renderer = create(React.createElement(Panel, {message: ''}));});
    assert.equal(calls.length, 0);
    await act(async () => {renderer.update(React.createElement(Panel, {message: '读取失败'}));});
    await act(async () => {renderer.update(React.createElement(Panel, {message: '读取失败'}));}); // 重渲染不重复记
    await act(async () => {renderer.update(React.createElement(Panel, {message: '网络中断'}));});
    await act(async () => {renderer.update(React.createElement(Panel, {message: ''}));});
    assert.deepEqual(calls, [['记录', 'reports', '读取失败', undefined], ['记录', 'reports', '网络中断', undefined]]);
    renderer.unmount();
  } finally {
    diag.uiError = original;
  }
});

test('flashConfirmation shows the text and clears it later only if nothing replaced it', async () => {
  let value = '';
  const set = (update: (current: string) => string) => { value = update(value); };
  flashConfirmation(set, '已受理 1 个号码，等待发送。', 10);
  assert.equal(value, '已受理 1 个号码，等待发送。');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(value, '');
  flashConfirmation(set, '已删除 2 条短信。', 10);
  value = '发送失败，草稿已保留';
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(value, '发送失败，草稿已保留');
});
