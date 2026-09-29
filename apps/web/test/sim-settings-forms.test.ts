import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {Sim} from '../src/call-history-panel.tsx';

function textOf(node: unknown): string {if(typeof node==='string'||typeof node==='number')return String(node);if(Array.isArray(node))return node.map(textOf).join('');if(!node||typeof node!=='object')return '';const value=node as {children?:unknown[];props?:{children?:unknown}};return textOf(value.children??value.props?.children);}
function input(renderer:ReactTestRenderer,label:string){const labels=renderer.root.findAll(node=>node.type==='label'&&textOf(node).includes(label));return labels[0]!.findAll(node=>node.type==='input'||node.type==='select')[0]!;}
function button(renderer:ReactTestRenderer,label:string){return renderer.root.findAll(node=>node.type==='button'&&textOf(node).trim()===label)[0]!;}
let server:ViteDevServer|undefined;
async function components(){const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');if(!server)server=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;return await server.ssrLoadModule('/src/sim-settings-forms.tsx') as typeof import('../src/sim-settings-forms.tsx');}
after(async()=>{await server?.close();delete (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;});
const sim=(version:number,settingsVersion:number,label='家庭卡',mode='normal'):Sim=>({id:'sim-1',version,label,phoneLabel:'号码一',gatewayId:'gateway-1',settings:{mode,version:settingsVersion,timeoutSeconds:45,appliedVersion:settingsVersion,availableModes:['normal','ai','timeout_ai']}});

test('SIM note polling preserves the dirty draft and reloads from a fresh request before unlocking',async()=>{
 const {SimNotesForm}=await components();const submitted:unknown[]=[];let renderer:ReactTestRenderer|undefined;
 const view=(value:Sim)=>React.createElement(SimNotesForm,{sim:value,busy:false,onSubmit:async(...args)=>{submitted.push(args);return {version:6,label:String(args[0]),phoneLabel:String(args[1])};},loadLatest:async()=>({version:5,label:'其他设备名称',phoneLabel:'号码一'})});
 try{
  await act(async()=>{renderer=create(view(sim(4,3)));});
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'我的草稿'}}));
  await act(async()=>renderer!.update(view(sim(5,3,'其他设备名称'))));
  assert.equal(input(renderer!,'名称').props.value,'我的草稿');
  assert.match(textOf(renderer!.toJSON()),/草稿和原版本已保留/);
  assert.equal(button(renderer!,'保存号码备注').props.disabled,true);
  assert.deepEqual(submitted,[]);
  await act(async()=>{button(renderer!,'载入最新号码备注（替换当前草稿）').props.onClick();await new Promise(resolve=>setImmediate(resolve));});
  assert.equal(input(renderer!,'名称').props.value,'其他设备名称');
  await act(async()=>renderer!.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(submitted,[['其他设备名称','号码一',5]]);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('reception setting polling preserves a dirty mode and reloads from a fresh request before unlocking',async()=>{
 const {SimReceptionForm}=await components();const submitted:unknown[]=[];let renderer:ReactTestRenderer|undefined;
 const view=(value:Sim)=>React.createElement(SimReceptionForm,{sim:value,busy:false,status:'设置已应用',onSubmit:async(...args)=>{submitted.push(args);return {version:9,mode:String(args[0]),timeoutSeconds:Number(args[1])};},loadLatest:async()=>({version:8,mode:'ai',timeoutSeconds:45})});
 try{
  await act(async()=>{renderer=create(view(sim(4,7)));});
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'timeout_ai'}}));
  await act(async()=>renderer!.update(view(sim(4,8,'家庭卡','ai'))));
  assert.equal(input(renderer!,'接听模式').props.value,'timeout_ai');
  assert.match(textOf(renderer!.toJSON()),/草稿和原版本已保留/);
  assert.equal(button(renderer!,'保存接听设置').props.disabled,true);
  await act(async()=>{button(renderer!,'载入最新接听设置（替换当前草稿）').props.onClick();await new Promise(resolve=>setImmediate(resolve));});
  assert.equal(input(renderer!,'接听模式').props.value,'ai');
  await act(async()=>renderer!.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(submitted,[['ai',45,8]]);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('a deferred note save owns its draft and adopts the authoritative response after a parent refresh',async()=>{
 const {SimNotesForm}=await components();let renderer:ReactTestRenderer|undefined;
 let resolveSave!: (value:{version:number;label:string;phoneLabel:string|null})=>void;
 const saving=new Promise<{version:number;label:string;phoneLabel:string|null}>(resolve=>{resolveSave=resolve;});
 const submitted:unknown[]=[];
 const view=(value:Sim)=>React.createElement(SimNotesForm,{sim:value,busy:false,loadLatest:async()=>({version:5,label:'轮询内容',phoneLabel:'号码一'}),onSubmit:async(...args)=>{submitted.push(args);return saving;}});
 try{
  await act(async()=>{renderer=create(view(sim(4,3)));});
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'提交中的草稿'}}));
  await act(async()=>renderer!.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(input(renderer!,'名称').props.disabled,true,'pending save prevents unsent edits');
  await act(async()=>renderer!.update(view(sim(5,3,'父级先收到旧轮询'))));
  assert.equal(input(renderer!,'名称').props.value,'提交中的草稿');
  await act(async()=>{resolveSave({version:5,label:'服务器确认名称',phoneLabel:'号码一'});await saving;await new Promise(resolve=>setImmediate(resolve));});
  assert.equal(input(renderer!,'名称').props.value,'服务器确认名称','success uses the mutation response, never the captured pre-save sim');
  assert.equal(input(renderer!,'名称').props.disabled,false);
  assert.deepEqual(submitted,[['提交中的草稿','号码一',4]]);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('a failed explicit SIM reload keeps the dirty draft and conflict lock',async()=>{
 const {SimNotesForm}=await components();let renderer:ReactTestRenderer|undefined;
 const view=(value:Sim)=>React.createElement(SimNotesForm,{sim:value,busy:false,onSubmit:async()=>null,loadLatest:async()=>{throw new Error('offline');}});
 try{
  await act(async()=>{renderer=create(view(sim(4,3)));});
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'不能丢的草稿'}}));
  await act(async()=>renderer!.update(view(sim(5,3,'服务器内容'))));
  await act(async()=>{button(renderer!,'载入最新号码备注（替换当前草稿）').props.onClick();await new Promise(resolve=>setImmediate(resolve));});
  assert.equal(input(renderer!,'名称').props.value,'不能丢的草稿');
  assert.equal(button(renderer!,'保存号码备注').props.disabled,true);
  assert.match(textOf(renderer!.toJSON()),/暂时无法读取服务器最新号码备注/);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('a deferred reception save locks every field and adopts its returned settings snapshot',async()=>{
 const {SimReceptionForm}=await components();let renderer:ReactTestRenderer|undefined;
 let resolveSave!: (value:{version:number;mode:string;timeoutSeconds:number})=>void;
 const saving=new Promise<{version:number;mode:string;timeoutSeconds:number}>(resolve=>{resolveSave=resolve;});
 const view=(value:Sim)=>React.createElement(SimReceptionForm,{sim:value,busy:false,status:'等待确认',loadLatest:async()=>({version:8,mode:'ai',timeoutSeconds:45}),onSubmit:async()=>saving});
 try{
  await act(async()=>{renderer=create(view(sim(4,7)));});
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'timeout_ai'}}));
  await act(async()=>input(renderer!,'等待秒数').props.onChange({target:{value:'60'}}));
  await act(async()=>renderer!.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(input(renderer!,'接听模式').props.disabled,true);
  assert.equal(input(renderer!,'等待秒数').props.disabled,true);
  await act(async()=>renderer!.update(view(sim(4,8,'家庭卡','ai'))));
  await act(async()=>{resolveSave({version:8,mode:'timeout_ai',timeoutSeconds:60});await saving;await new Promise(resolve=>setImmediate(resolve));});
  assert.equal(input(renderer!,'接听模式').props.value,'timeout_ai');
  assert.equal(input(renderer!,'等待秒数').props.value,60);
  assert.equal(button(renderer!,'保存接听设置').props.disabled,false);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('S80 unsaved marker, saving label and discard restore the server values',async()=>{
 const {SimNotesForm,SimReceptionForm}=await components();let renderer:ReactTestRenderer|undefined;
 let resolveSave!: (value:{version:number;label:string;phoneLabel:string|null})=>void;
 const saving=new Promise<{version:number;label:string;phoneLabel:string|null}>(resolve=>{resolveSave=resolve;});
 const notes=(value:Sim)=>React.createElement(SimNotesForm,{sim:value,busy:false,loadLatest:async()=>({version:4,label:'家庭卡',phoneLabel:'号码一'}),onSubmit:async()=>saving});
 const text=()=>textOf(renderer!.toJSON());
 try{
  await act(async()=>{renderer=create(notes(sim(4,3)));});
  assert.doesNotMatch(text(),/未保存设置/);assert.equal(button(renderer!,'放弃修改'),undefined);
  assert.match(text(),/服务器版本4/);
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'草稿'}}));
  assert.match(text(),/未保存设置/);
  await act(async()=>button(renderer!,'放弃修改').props.onClick());
  assert.equal(input(renderer!,'名称').props.value,'家庭卡');assert.doesNotMatch(text(),/未保存设置/);
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'新名称'}}));
  await act(async()=>renderer!.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(button(renderer!,'正在保存…').props.disabled,true);
  assert.equal(button(renderer!,'放弃修改').props.disabled,true);
  await act(async()=>{resolveSave({version:5,label:'新名称',phoneLabel:'号码一'});await saving;await new Promise(resolve=>setImmediate(resolve));});
  assert.doesNotMatch(text(),/未保存设置/);assert.ok(button(renderer!,'保存号码备注'));
  await act(async()=>renderer!.unmount());
  const reception=(value:Sim)=>React.createElement(SimReceptionForm,{sim:value,busy:false,status:'',loadLatest:async()=>({version:7,mode:'normal',timeoutSeconds:45}),onSubmit:async()=>null});
  await act(async()=>{renderer=create(reception({...sim(4,7),settings:{...sim(4,7).settings,appliedVersion:null}}));});
  assert.match(text(),/设备已应用尚未确认/);
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'ai'}}));
  assert.match(text(),/未保存设置/);
  await act(async()=>button(renderer!,'放弃修改').props.onClick());
  assert.equal(input(renderer!,'接听模式').props.value,'normal');assert.doesNotMatch(text(),/未保存设置/);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('S80 note edits changed back to the base values are not dirty',async()=>{
 const {SimNotesForm}=await components();let renderer:ReactTestRenderer|undefined;const text=()=>textOf(renderer!.toJSON());const reported:boolean[]=[];
 try{
  await act(async()=>{renderer=create(React.createElement(SimNotesForm,{sim:sim(4,3),busy:false,onDirtyChange:d=>reported.push(d),loadLatest:async()=>({version:4,label:'家庭卡',phoneLabel:'号码一'}),onSubmit:async()=>null}));});
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'草稿'}}));
  assert.match(text(),/未保存设置/);assert.equal(reported.at(-1),true);
  await act(async()=>input(renderer!,'名称').props.onChange({target:{value:'家庭卡'}}));assert.equal(reported.at(-1),false);
  assert.doesNotMatch(text(),/未保存设置/);assert.equal(button(renderer!,'放弃修改'),undefined);
  await act(async()=>input(renderer!,'号码标注').props.onChange({target:{value:'号码一 '}}));
  assert.doesNotMatch(text(),/未保存设置/);assert.equal(button(renderer!,'放弃修改'),undefined);
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});

test('S80 reception mode changed back to the base value is not dirty',async()=>{
 const {SimReceptionForm}=await components();let renderer:ReactTestRenderer|undefined;const text=()=>textOf(renderer!.toJSON());const reported:boolean[]=[];
 try{
  await act(async()=>{renderer=create(React.createElement(SimReceptionForm,{sim:sim(4,7),busy:false,status:'',onDirtyChange:d=>reported.push(d),loadLatest:async()=>({version:7,mode:'normal',timeoutSeconds:45}),onSubmit:async()=>null}));});
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'ai'}}));
  assert.match(text(),/未保存设置/);assert.equal(reported.at(-1),true);
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'normal'}}));
  assert.doesNotMatch(text(),/未保存设置/);assert.equal(button(renderer!,'放弃修改'),undefined);assert.equal(reported.at(-1),false);
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'ai'}}));assert.equal(reported.at(-1),true);
  await act(async()=>button(renderer!,'放弃修改').props.onClick());assert.equal(reported.at(-1),false);
  await act(async()=>input(renderer!,'接听模式').props.onChange({target:{value:'ai'}}));await act(async()=>renderer!.unmount());renderer=undefined;assert.equal(reported.at(-1),false,'unmount reports clean');
 }finally{if(renderer)await act(async()=>renderer!.unmount());}
});
