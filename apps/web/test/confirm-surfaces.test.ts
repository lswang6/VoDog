import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {createServer} from 'vite';
import {GATEWAY_DELETE_PROMPT,PASSKEY_DELETE_PROMPT} from '../src/confirm-copy.ts';

function collectText(node:unknown):string{
 if(typeof node==='string'||typeof node==='number')return String(node);
 if(Array.isArray(node))return node.map(collectText).join('');
 if(!node||typeof node!=='object')return '';
 const record=node as {children?:unknown[];props?:{children?:unknown}};
 return collectText(record.children??record.props?.children);
}
function findButton(renderer:ReactTestRenderer,label:string){
 return renderer.root.findAll((node)=>node.type==='button'&&collectText(node).includes(label))[0];
}
function flush(){return new Promise<void>((resolve)=>setImmediate(resolve));}

test('ConfirmAction, PasskeyPanel delete, and history 回拨/发短信/屏蔽 have UI coverage',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 let renderer:ReactTestRenderer|undefined;
 try{
  const {ConfirmAction}=await vite.ssrLoadModule('/src/confirm-action.tsx') as typeof import('../src/confirm-action.tsx');
  const {PasskeyPanel}=await vite.ssrLoadModule('/src/passkey-panel.tsx') as typeof import('../src/passkey-panel.tsx');
  const {HistoryCallActions}=await vite.ssrLoadModule('/src/history-call-actions.tsx') as typeof import('../src/history-call-actions.tsx');

  assert.match(GATEWAY_DELETE_PROMPT,/不会先结束通话再删除/);
  let confirmed=false;
  await act(async()=>{
   renderer=create(React.createElement(ConfirmAction,{
    busy:false,
    prompt:GATEWAY_DELETE_PROMPT,
    confirmLabel:'确认删除',
    onConfirm:()=>{confirmed=true;},
    onCancel:()=>{},
   }));
  });
  assert.match(collectText(renderer!.toJSON()),/不会先结束通话再删除/);
  assert.match(findButton(renderer!,'确认删除').props.className,/\bhangup\b/,'every destructive confirmation uses the danger treatment');
  await act(async()=>{findButton(renderer!,'确认删除').props.onClick();});
  assert.equal(confirmed,true);
  renderer!.unmount();

  const calls:{path:string;method?:string;body?:unknown}[]=[];
  const items:{id:string;createdAt:string;deviceType:string;label?:string}[]=[{id:'pk-1',createdAt:'2026-09-11T00:00:00.000Z',deviceType:'platform'}];
  const request=async<T>(path:string,body?:unknown,method?:string):Promise<T>=>{
   calls.push({path,method,body});
   // A reload must hand React fresh objects, exactly as the real fetch does.
   if(path==='/passkeys')return {items:items.map(item=>({...item}))} as T;
   if(method==='PATCH'){items[0]!.label=(body as {label:string}).label;return {item:{...items[0]!}} as T;}
   if(method==='DELETE'){items.splice(0,1);return {} as T;}
   throw new Error(`unexpected ${method} ${path}`);
  };
  await act(async()=>{
   renderer=create(React.createElement('div',null,React.createElement(PasskeyPanel,{
    busy:false,
    run:async(action)=>{await action();return true;},
    request,
   })));
  });
  await act(async()=>{await flush();});
  assert.match(collectText(renderer!.toJSON()),/本机/);

  await act(async()=>{findButton(renderer!,'重命名').props.onClick();});
  const renameInput=renderer!.root.findAllByType('input')[0]!;
  assert.equal(renameInput.props.value,'本机');
  await act(async()=>{renameInput.props.onChange({target:{value:' 家里的 Mac '}});});
  await act(async()=>{findButton(renderer!,'保存').props.onClick();});
  await act(async()=>{await flush();});
  assert.deepEqual(calls.filter((call)=>call.method==='PATCH'),[{path:'/passkeys/pk-1',method:'PATCH',body:{label:'家里的 Mac'}}]);
  assert.equal(renderer!.root.findAllByType('input').length,0,'saving closes the editor');
  assert.match(collectText(renderer!.toJSON()),/家里的 Mac/,'the list reloads with the new name');
  assert.equal(calls.filter((call)=>call.path==='/passkeys').length,2,'renaming reloads the list');

  await act(async()=>{findButton(renderer!,'删除').props.onClick();});
  assert.match(collectText(renderer!.toJSON()),new RegExp(PASSKEY_DELETE_PROMPT));
  assert.match(findButton(renderer!,'确认删除').props.className,/\bhangup\b/);
  await act(async()=>{findButton(renderer!,'确认删除').props.onClick();});
  await act(async()=>{await flush();});
  assert.equal(calls.some((call)=>call.path==='/passkeys/pk-1'&&call.method==='DELETE'),true);
  renderer!.unmount();

  const actions:string[]=[];
  await act(async()=>{
   renderer=create(React.createElement(HistoryCallActions,{
    remoteNumber:'2025550111',
    simId:'sim-1',
    mediaLive:false,
    busy:false,
    onRedial:()=>actions.push('redial'),
    onSms:()=>actions.push('sms'),
    onBlock:()=>{actions.push('block');},
   }));
  });
  const tree=collectText(renderer!.toJSON());
  assert.match(tree,/回拨/);
  assert.match(tree,/发短信/);
  assert.match(tree,/屏蔽/);
  assert.doesNotMatch(tree,/拉黑/,'S22 决策 10: the verb is 屏蔽 everywhere');
  await act(async()=>{findButton(renderer!,'回拨').props.onClick();});
  await act(async()=>{findButton(renderer!,'发短信').props.onClick();});
  await act(async()=>{findButton(renderer!,'屏蔽').props.onClick();});
  assert.match(collectText(renderer!.toJSON()),/屏蔽此号码/);
  assert.match(findButton(renderer!,'确认屏蔽').props.className,/\bhangup\b/);
  await act(async()=>{findButton(renderer!,'确认屏蔽').props.onClick();});
  assert.deepEqual(actions,['redial','sms','block']);
 }finally{
  renderer?.unmount();
  await vite.close();
 }
});
