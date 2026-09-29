import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act,create,type ReactTestRenderer,type ReactTestInstance} from 'react-test-renderer';
import {createServer} from 'vite';
import type {PasskeyItem} from '../src/passkey-panel.tsx';

function collectText(node:unknown):string{
 if(typeof node==='string'||typeof node==='number')return String(node);
 if(Array.isArray(node))return node.map(collectText).join('');
 if(!node||typeof node!=='object')return '';
 const record=node as {children?:unknown[];props?:{children?:unknown}};
 return collectText(record.children??record.props?.children);
}
function rowButton(row:ReactTestInstance,label:string){
 return row.findAll((node)=>node.type==='button'&&collectText(node).includes(label))[0];
}
function flush(){return new Promise<void>((resolve)=>setImmediate(resolve));}

const fixture:PasskeyItem[]=[
 {id:'pk-1',createdAt:'2026-09-01T02:03:00.000Z',deviceType:'multiDevice',backedUp:true,transports:['internal','hybrid'],
  label:'我的 MacBook',displayName:'Chrome on macOS',aaguid:'adce0002-35bc-c60a-648b-0b25f1f05503',
  clientPlatform:'Chrome on macOS',authenticatorAttachment:'platform',lastUsedAt:'2026-09-10T09:30:00.000Z'},
 {id:'pk-2',createdAt:'2026-09-02T02:03:00.000Z',deviceType:'multiDevice',backedUp:true,
  label:null,displayName:'iCloud 钥匙串',clientPlatform:'iOS App',authenticatorAttachment:'platform',lastUsedAt:null},
 {id:'pk-3',createdAt:'2026-09-03T02:03:00.000Z',deviceType:'cross-platform',backedUp:false,
  displayName:'硬件安全密钥',clientPlatform:null,authenticatorAttachment:'cross-platform',lastUsedAt:null},
 // An old server sends only the two original columns, so the row must still name the device.
 {id:'pk-4',createdAt:'2026-09-04T02:03:00.000Z',deviceType:'singleDevice'},
];

test('the passkey panel names every credential, labels its platform and reports when it was last used',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 let renderer:ReactTestRenderer|undefined;
 try{
  const {PasskeyPanel,passkeyPlatformLabel,passkeyName}=await vite.ssrLoadModule('/src/passkey-panel.tsx') as typeof import('../src/passkey-panel.tsx');

  assert.equal(passkeyPlatformLabel(fixture[0]!),'本机 · 已同步 · Chrome on macOS');
  assert.equal(passkeyPlatformLabel(fixture[1]!),'本机 · 已同步 · iOS App');
  assert.equal(passkeyPlatformLabel(fixture[2]!),'跨设备');
  assert.equal(passkeyPlatformLabel(fixture[3]!),'本机','an old server without the new fields falls back to the device type');
  assert.equal(passkeyPlatformLabel({id:'old',createdAt:fixture[3]!.createdAt,deviceType:'multiDevice',backedUp:true}),'已同步');
  assert.equal(passkeyName(fixture[1]!),'iCloud 钥匙串','a null label falls through to the server display name');
  assert.equal(passkeyName(fixture[3]!),'本机');

  const calls:{path:string;method?:string;body?:unknown}[]=[];
  let patchFailure='';
  const request=async<T>(path:string,body?:unknown,method?:string):Promise<T>=>{
   calls.push({path,method,body});
   if(path==='/passkeys')return {items:fixture.map(item=>({...item}))} as T;
   if(method==='PATCH'){if(patchFailure)throw new Error(patchFailure);return {item:{...fixture[0]!,...(body as object)}} as T;}
   throw new Error(`unexpected ${method??'GET'} ${path}`);
  };
  await act(async()=>{
   renderer=create(React.createElement('div',null,React.createElement(PasskeyPanel,{
    busy:false,
    run:async(action)=>{await action();return true;},
    request,
    register:async()=>({id:'unused'}),
   })));
  });
  await act(async()=>{await flush();});
  const rows=()=>renderer!.root.findAll((node)=>node.type==='article');
  assert.equal(rows().length,4);

  const first=collectText(rows()[0]!.props.children);
  assert.match(first,/我的 MacBook/);
  assert.match(first,/本机 · 已同步 · Chrome on macOS/);
  assert.match(first,/添加于/);
  assert.match(first,/最近使用/);
  assert.deepEqual(rows()[0]!.findAll((node)=>node.type==='time').map((node)=>node.props.dateTime),
   ['2026-09-01T02:03:00.000Z','2026-09-10T09:30:00.000Z'],'both timestamps stay machine readable');

  const second=collectText(rows()[1]!.props.children);
  assert.match(second,/iCloud 钥匙串/);
  assert.match(second,/尚未使用/);
  assert.doesNotMatch(second,/最近使用/);
  assert.deepEqual(rows()[1]!.findAll((node)=>node.type==='time').map((node)=>node.props.dateTime),
   ['2026-09-02T02:03:00.000Z'],'a never-used passkey has no last-used timestamp');

  assert.match(collectText(rows()[2]!.props.children),/硬件安全密钥/);
  assert.match(collectText(rows()[3]!.props.children),/本机/);

  // Rename controls sit next to the delete button so the red hangup rule only styles deletion.
  const actions=rows()[0]!.findAll((node)=>node.props?.className==='record-actions');
  assert.equal(actions.length,1);
  assert.deepEqual(actions[0]!.findAllByType('button').map((button)=>collectText(button)),['重命名','删除']);

  const reads=calls.length;
  await act(async()=>{rowButton(rows()[0]!,'重命名').props.onClick();});
  const input=()=>renderer!.root.findAllByType('input')[0]!;
  assert.equal(input().props.value,'我的 MacBook','the editor starts from the current name');

  await act(async()=>{input().props.onChange({target:{value:'   '}});});
  await act(async()=>{rowButton(rows()[0]!,'保存').props.onClick();});
  await act(async()=>{await flush();});
  assert.match(collectText(rows()[0]!.props.children),/请输入 1 到 64 个字符的名称/);
  assert.equal(calls.length,reads,'a blank name never reaches the server');

  await act(async()=>{input().props.onChange({target:{value:'长'.repeat(65)}});});
  await act(async()=>{rowButton(rows()[0]!,'保存').props.onClick();});
  await act(async()=>{await flush();});
  assert.match(collectText(rows()[0]!.props.children),/名称最多 64 个字符/);
  assert.equal(calls.length,reads,'a 65 character name never reaches the server');

  await act(async()=>{rowButton(rows()[0]!,'取消').props.onClick();});
  assert.equal(renderer!.root.findAllByType('input').length,0,'cancel closes the editor');
  assert.equal(calls.length,reads,'cancel issues no request');

  // Escape cancels the same way the 取消 button does.
  await act(async()=>{rowButton(rows()[0]!,'重命名').props.onClick();});
  await act(async()=>{input().props.onChange({target:{value:'改名'}});});
  await act(async()=>{input().props.onKeyDown({key:'Escape',preventDefault(){}});});
  assert.equal(renderer!.root.findAllByType('input').length,0);
  assert.equal(calls.length,reads,'Escape issues no request');

  // A rejected rename keeps the editor open and shows the server message instead of a generic failure.
  patchFailure='名称已被占用';
  await act(async()=>{rowButton(rows()[0]!,'重命名').props.onClick();});
  await act(async()=>{input().props.onChange({target:{value:'重复的名字'}});});
  await act(async()=>{input().props.onKeyDown({key:'Enter',preventDefault(){}});});
  await act(async()=>{await flush();});
  assert.deepEqual(calls.filter((call)=>call.method==='PATCH'),[{path:'/passkeys/pk-1',method:'PATCH',body:{label:'重复的名字'}}],'Enter saves once');
  assert.match(collectText(renderer!.toJSON()),/名称已被占用/);
  assert.equal(renderer!.root.findAllByType('input').length,1,'a rejected rename keeps the editor open');
  assert.equal(calls.filter((call)=>call.path==='/passkeys').length,1,'a rejected rename does not reload the list');
 }finally{
  renderer?.unmount();
  await vite.close();
 }
});

test('添加通行密钥 asks the server for options, calls the browser authenticator, then verifies and reloads',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 let renderer:ReactTestRenderer|undefined;
 try{
  const {PasskeyPanel}=await vite.ssrLoadModule('/src/passkey-panel.tsx') as typeof import('../src/passkey-panel.tsx');
  const steps:string[]=[];
  let registered:unknown;
  const request=async<T>(path:string,body?:unknown,method?:string):Promise<T>=>{
   steps.push(`${method??(body===undefined?'GET':'POST')} ${path}`);
   if(path==='/passkeys')return {items:[]} as T;
   if(path==='/passkeys/register/options')return {challengeId:'ch-1',options:{challenge:'abc'}} as T;
   if(path==='/passkeys/register/verify'){registered=(body as {response:unknown}).response;return {} as T;}
   throw new Error(`unexpected ${method??'GET'} ${path}`);
  };
  await act(async()=>{
   renderer=create(React.createElement('div',null,React.createElement(PasskeyPanel,{
    busy:false,
    run:async(action)=>{await action();return true;},
    request,
    register:async(args)=>{steps.push(`register ${JSON.stringify(args.optionsJSON)}`);return {id:'cred-1'};},
   })));
  });
  await act(async()=>{await flush();});
  assert.match(collectText(renderer!.toJSON()),/尚未添加通行密钥/);
  const add=renderer!.root.findAll((node)=>node.type==='button'&&collectText(node)==='添加通行密钥')[0]!;
  await act(async()=>{add.props.onClick();});
  await act(async()=>{await flush();});
  assert.deepEqual(steps,[
   'GET /passkeys',
   'POST /passkeys/register/options',
   'register {"challenge":"abc"}',
   'POST /passkeys/register/verify',
   'GET /passkeys',
  ]);
  assert.deepEqual(registered,{id:'cred-1'},'the authenticator response is forwarded unchanged');
 }finally{
  renderer?.unmount();
  await vite.close();
 }
});

test('accepted passkey rename and deletion survive a failed follow-up list read without offering the stale action again',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 let renderer:ReactTestRenderer|undefined;
 try{
  const {PasskeyPanel}=await vite.ssrLoadModule('/src/passkey-panel.tsx') as typeof import('../src/passkey-panel.tsx');
  let reads=0;
  const mutations:string[]=[];
  const request=async<T>(requestPath:string,body?:unknown,method?:string):Promise<T>=>{
   if(requestPath==='/passkeys'){
    reads++;
    if(reads>1)throw new Error('temporary passkey GET failure');
    return {items:[fixture[0]]} as T;
   }
   if(method==='PATCH'){
    mutations.push('PATCH');
    return {item:{...fixture[0]!,label:(body as {label:string}).label}} as T;
   }
   if(method==='DELETE'){mutations.push('DELETE');return {} as T;}
   throw new Error(`unexpected ${method??'GET'} ${requestPath}`);
  };
  await act(async()=>{renderer=create(React.createElement(PasskeyPanel,{busy:false,run:async action=>{await action();return true;},request,register:async()=>({})}));});
  await act(async()=>{await flush();});
  let row=renderer!.root.findByType('article');
  await act(async()=>rowButton(row,'重命名').props.onClick());
  const editor=renderer!.root.findByType('input');
  await act(async()=>editor.props.onChange({target:{value:'新名称'}}));
  await act(async()=>rowButton(renderer!.root.findByType('article'),'保存').props.onClick());
  await act(async()=>{await flush();await flush();});
  assert.match(collectText(renderer!.toJSON()),/新名称/);
  assert.match(collectText(renderer!.toJSON()),/名称已保存，但通行密钥列表暂未刷新/);
  row=renderer!.root.findByType('article');
  await act(async()=>rowButton(row,'删除').props.onClick());
  await act(async()=>rowButton(renderer!.root.findByType('article'),'确认删除').props.onClick());
  await act(async()=>{await flush();await flush();});
  assert.deepEqual(mutations,['PATCH','DELETE']);
  assert.equal(renderer!.root.findAllByType('article').length,0,'accepted deletion removes the stale row before the failed GET');
  assert.match(collectText(renderer!.toJSON()),/通行密钥已删除，但通行密钥列表暂未刷新/);
 }finally{
  if(renderer)await act(async()=>renderer!.unmount());
  await vite.close();
 }
});
