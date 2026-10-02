import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create} from 'react-test-renderer';
import {createServer} from 'vite';

test('AiBadge shows only for AI answer modes, compact or full, with one spoken label', async () => {
  const server = await createServer({root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const {AiBadge, SimChip} = await server.ssrLoadModule('/src/sim-chip.tsx') as typeof import('../src/sim-chip.tsx');
    const render = (el: React.ReactElement) => { let r!: ReturnType<typeof create>; act(() => { r = create(el); }); return r; };
    const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON());
    assert.equal(render(React.createElement(AiBadge, {ai: {mode: 'normal', timeoutSeconds: 20}})).toJSON(), null);
    assert.equal(render(React.createElement(AiBadge, {ai: null})).toJSON(), null);
    const compact = render(React.createElement(AiBadge, {ai: {mode: 'timeout_ai', timeoutSeconds: 20}}));
    assert.equal(compact.root.findByProps({role: 'img'}).props['aria-label'], 'AI 代接已开启，响铃 20 秒无人接听后由 AI 接听');
    assert.match(text(compact), /"AI"/);
    assert.match(text(render(React.createElement(AiBadge, {ai: {mode: 'timeout_ai', timeoutSeconds: 20}, full: true}))), /秒后/);
    assert.match(text(render(React.createElement(AiBadge, {ai: {mode: 'timeout_ai'}, full: true}))), /AI 兜底/);
    const full = render(React.createElement(AiBadge, {ai: {mode: 'ai'}, full: true}));
    assert.match(text(full), /AI 代接/);
    assert.equal(full.root.findByProps({role: 'img'}).props['aria-label'], 'AI 代接已开启，立即由 AI 接听');
    const chip = render(React.createElement(SimChip, {name: '线路一', color: '#2457C5', ai: {mode: 'ai'}, status: 'online'}));
    assert.equal(chip.root.findAll(node => node.props.className === 'ai-badge').length, 1);
  } finally {
    await server.close();
  }
});
