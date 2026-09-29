import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
let server: ViteDevServer | undefined;
after(async () => { await server?.close(); });
async function load(entry: string) {
  server ??= await createServer({root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  return server.ssrLoadModule(entry);
}
test('secondary disclosure starts closed and Escape returns focus to its native summary', async () => {
  const {MoreActions} = await load('/src/more-actions.tsx');
  let focused = false, stopped = false;
  const element = {open: true, querySelector: () => ({focus: () => { focused = true; }})};
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(MoreActions, {label: '更多通话操作'}, React.createElement('button', null, '删除')), {createNodeMock: node => node.type === 'details' ? element : null}); });
  try {
    const disclosure = renderer.root.findByType('details');
    assert.equal(disclosure.props.open, undefined);
    assert.equal(renderer.root.findByType('summary').props.children[1], '更多');
    assert.equal(renderer.root.findByType('summary').props['aria-label'], '更多通话操作');
    disclosure.props.onKeyDown({key: 'Escape', stopPropagation: () => { stopped = true; }});
    assert.equal(element.open, false);
    assert.equal(focused, true);
    assert.equal(stopped, true);
  } finally { await act(async () => renderer.unmount()); }
});
test('history keeps primary actions outside disclosure and deletion requires confirmation', async () => {
  const {HistoryCallActions} = await load('/src/history-call-actions.tsx');
  let deletes = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(HistoryCallActions, {remoteNumber:'2025550111',simId:'sim-1',mediaLive:false,busy:false,onRedial:()=>{},onSms:()=>{},onBlock:()=>{},onDelete:()=>{deletes++;}})); });
  try {
    const details = renderer.root.findByType('details');
    assert.deepEqual(details.findAllByType('button').map(node => node.props.children), ['屏蔽', '删除']);
    assert.equal(renderer.root.findAllByType('button').length, 4);
    await act(async () => { details.findAllByType('button')[1]!.props.onClick(); });
    assert.equal(deletes, 0);
    assert.equal(renderer.root.findAllByType('details').length, 0);
    const confirm = renderer.root.findAllByType('button').find(node => node.props.children === '确认删除');
    assert.ok(confirm);
    await act(async () => { confirm.props.onClick(); });
    assert.equal(deletes, 1);
  } finally { await act(async () => renderer.unmount()); }
});

test('outside pointer closes disclosure and restores focus before hiding its focused action', async () => {
  const {MoreActions} = await load('/src/more-actions.tsx');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let listener: ((event: {target: object}) => void) | undefined;
  let focused = false, removed = false;
  const inside = {};
  const element = {open:true, contains:(target: object)=>target === inside, querySelector:()=>({focus:()=>{focused=true;}})};
  Object.defineProperty(globalThis, 'document', {configurable:true,value:{
    addEventListener: (_: string, callback: typeof listener) => { listener=callback; },
    removeEventListener: () => { removed=true; },
    activeElement:inside,
  }});
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer=create(React.createElement(MoreActions, null, React.createElement('button',null,'删除')), {createNodeMock:node=>node.type==='details'?element:null}); });
    listener!({target:inside});
    assert.equal(element.open,true);
    listener!({target:{}});
    assert.equal(element.open,false);
    assert.equal(focused,true);
    focused=false;
    renderer.root.findByType('details').props.onToggle();
    assert.equal(focused,true,'native close also restores focus when the focused child becomes hidden');
    await act(async () => renderer.unmount());
    assert.equal(removed,true);
  } finally {
    if(previous)Object.defineProperty(globalThis,'document',previous);
    else Reflect.deleteProperty(globalThis,'document');
  }
});
