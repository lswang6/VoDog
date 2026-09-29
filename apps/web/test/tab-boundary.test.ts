import assert from 'node:assert/strict';
import test from 'node:test';
import React, {useEffect} from 'react';
import {act, create} from 'react-test-renderer';
import {TabBoundary} from '../src/tab-boundary.ts';

test('a throwing tab renders the fallback without unmounting App or running its call cleanup', async () => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  let stops = 0, fail = false;
  const Tab = () => {if (fail) throw new Error('boom'); return React.createElement('p', null, 'ok');};
  // 模拟 main.tsx:131：App 卸载时的清理会 stop() 并挂断通话。
  const App = () => {useEffect(() => () => {stops++;}, []); return React.createElement(TabBoundary, null, React.createElement(Tab));};
  const quiet = console.error;
  console.error = () => {};
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {renderer = create(React.createElement(App));});
    fail = true;
    await act(async () => {renderer.update(React.createElement(App));});
    assert.equal(renderer.root.findByProps({role: 'alert'}).children.join(''), '该页面出错，请切换标签重试');
    assert.equal(stops, 0);
    await act(async () => {renderer.unmount();});
    assert.equal(stops, 1);
  } finally {console.error = quiet;}
});
