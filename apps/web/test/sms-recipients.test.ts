import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {createServer,type ViteDevServer} from 'vite';
import {uniqueSmsRecipients,startSmsRecipients,smsContactNumbers} from '../src/sms-recipient-policy.ts';
let server: ViteDevServer;
async function modules() {
  server ||= await createServer({root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),server:{middlewareMode:true,hmr:false},appType:'custom'});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  return {...await server.ssrLoadModule('/src/sms-recipients.tsx'),...await server.ssrLoadModule('/src/messages.tsx')};
}
after(async()=>{await server?.close();});
const contact={id:'a',displayName:'Alice',phones:[{rawNumber:'2125550190',e164:'+12125550190',label:'手机'},{rawNumber:'5550190',label:'办公室'}]};
const base={messages:[],simId:'a',simLabel:'A',online:true,busy:false,account:'test',onSend:async()=>{}};
const button=(r:ReactTestRenderer,text:string)=>r.root.findAllByType('button').find(n=>n.props.children===text)!;
const input=(r:ReactTestRenderer)=>r.root.findByProps({'aria-label':'收件号码'});
async function typeNumber(r:ReactTestRenderer,text:string){await act(async()=>{input(r).props.onChange({target:{value:text}});});}
async function add(r:ReactTestRenderer,text:string){await typeNumber(r,text);await act(async()=>{button(r,'添加').props.onClick();});}

test('recipient identity never collapses arbitrary suffixes; explicit prefill and ordinary empty start',()=>{
 assert.deepEqual(startSmsRecipients(),[]);
 assert.deepEqual(startSmsRecipients('+1 (212) 555-0190'),[{number:'+12125550190',name:undefined}]);
 assert.equal(uniqueSmsRecipients([{number:'+12125550190'},{number:'5550190'},{number:'+1 212 555 0190'}]).length,2);
 assert.equal(smsContactNumbers(contact).length,2);
 assert.equal(smsContactNumbers(contact)[1].label,'办公室');
});

test('picker stages multiple numbers, search preserves selection, Cancel/Escape discard, Done commits',async()=>{
 const {SmsRecipientPicker}=await modules();let committed:any;let closed=0;let r!:ReactTestRenderer;
 const props={contacts:[contact,{id:'b',displayName:'Bob',phones:[{rawNumber:'10086'}]}],value:[],query:'',onQuery:()=>{},onClose:()=>closed++,onChange:(v:any)=>committed=v};
 await act(async()=>{r=create(React.createElement(SmsRecipientPicker,props));});
 await act(async()=>{r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[0].props.onChange();});
 await act(async()=>{r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[1].props.onChange();});
 assert.equal(committed,undefined);
 await act(async()=>{r.update(React.createElement(SmsRecipientPicker,{...props,query:'Bob'}));});
 await act(async()=>{r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[0].props.onChange();});
 await act(async()=>{button(r,'完成').props.onClick();});
 assert.equal(committed.length,3);assert.equal(closed,1);
 committed=undefined;
 await act(async()=>{r.root.findByProps({role:'dialog'}).props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});});
 assert.equal(committed,undefined);assert.equal(closed,2);
 await act(async()=>{button(r,'取消').props.onClick();});assert.equal(committed,undefined);
 await act(async()=>r.unmount());
});

test('ordinary compose clears recipients, preserves body; SIM switch keeps recipients with separate bodies; account resets',async()=>{
 const {Messages}=await modules();let r!:ReactTestRenderer;
 await act(async()=>{r=create(React.createElement(Messages,base));});
 await act(async()=>r.root.findByProps({'aria-label':'新短信'}).props.onClick());
 await add(r,'10086');
 await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'draft A'}}));
 await act(async()=>r.update(React.createElement(Messages,{...base,simId:'b'})));
 assert.equal(r.root.findAllByType('li').length,1);assert.equal(r.root.findByType('textarea').props.value,'');
 await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'draft B'}}));
 await act(async()=>r.update(React.createElement(Messages,base)));
 assert.equal(r.root.findByType('textarea').props.value,'draft A');
 await act(async()=>r.root.findByProps({'aria-label':'新短信'}).props.onClick());
 assert.equal(r.root.findAllByType('li').length,0);assert.equal(r.root.findByType('textarea').props.value,'draft A');
 await act(async()=>r.update(React.createElement(Messages,{...base,account:'other'})));
 assert.equal(r.root.findAllByType('textarea').length,0);
 await act(async()=>r.unmount());
});

test('both composers block submit while manual input is uncommitted; explicit prefill editable; failed send preserves',async()=>{
 const {Messages,SmsCompose}=await modules();
 for(const Component of [Messages,SmsCompose]){
  let r!:ReactTestRenderer;const sent:string[]=[];
  const props={...base,remoteNumber:'10086',onClose(){},composeTo:{simId:'a',remoteNumber:'10086',token:1},onSend:async(n:string)=>{sent.push(n);throw new Error('offline');}};
  await act(async()=>{r=create(React.createElement(Component,props));});
  await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'keep me'}}));
  await typeNumber(r,'10010');
  assert.equal(r.root.findByProps({'aria-label':'发送短信'}).props.disabled,true);
  await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));assert.equal(sent.length,0);
  await typeNumber(r,'');
  await act(async()=>r.root.findByProps({'aria-label':'移除 10086'}).props.onClick());await add(r,'10010');
  await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(sent,['10010']);assert.equal(r.root.findByType('textarea').props.value,'keep me');
  assert.equal(r.root.findAllByType('li').length,1);
  await act(async()=>r.unmount());
 }
});

test('accepted single send clears captured SIM draft even after switching SIM',async()=>{
 const {Messages}=await modules();let resolve!:()=>void;let r!:ReactTestRenderer;
 const props={...base,onSend:()=>new Promise<void>(r=>resolve=r)};
 await act(async()=>{r=create(React.createElement(Messages,props));});
 await act(async()=>r.root.findByProps({'aria-label':'新短信'}).props.onClick());await add(r,'10086');
 await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'once'}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 await act(async()=>r.update(React.createElement(Messages,{...props,simId:'b'})));
 await act(async()=>resolve());
 await act(async()=>r.update(React.createElement(Messages,props)));
 assert.equal(r.root.findByType('textarea').props.value,'');
 await act(async()=>r.unmount());
});

test('picker loads later contact pages and server search without losing staged selections',async()=>{
 const {SmsRecipients}=await modules();let r!:ReactTestRenderer;const paths:string[]=[];let selected:any[]=[];
 const first=Array.from({length:200},(_,i)=>({id:`c${i}`,displayName:`Contact ${i}`,phones:[{rawNumber:`200${i}`}]}));
 const request=async(url:string)=>{paths.push(url);return {items:url.includes('query=Zed')?[{id:'zed',displayName:'Zed',phones:[{rawNumber:'9001'}]}]:url.includes('offset=200')?[{id:'last',displayName:'Last',phones:[{rawNumber:'9000'}]}]:first};};
 await act(async()=>{r=create(React.createElement(SmsRecipients,{value:[],onChange:(v:any)=>selected=v,request}));});
 await act(async()=>r.root.findByProps({'aria-label':'从通讯录添加收件人'}).props.onClick());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 await act(async()=>r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[0].props.onChange());
 await act(async()=>button(r,'加载更多联系人').props.onClick());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 assert.ok(paths.some(p=>p.includes('offset=200')));
 await act(async()=>r.root.findAllByType('input').filter(n=>n.props.type==='checkbox').at(-1)!.props.onChange());
 await act(async()=>r.root.findByProps({'aria-label':'搜索联系人姓名或号码'}).props.onChange({target:{value:'Zed'}}));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,270));});
 await act(async()=>r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[0].props.onChange());
 await act(async()=>button(r,'完成').props.onClick());
 assert.deepEqual(selected.map(item=>item.number),['2000','9000','9001']);
 await act(async()=>r.unmount());
});

test('100 recipient limit is explicit for manual entry and picker, never silently truncates',async()=>{
 const {SmsRecipients}=await modules();let r!:ReactTestRenderer;let changes=0;
 const value=Array.from({length:100},(_,i)=>({number:`300${i}`}));
 await act(async()=>{r=create(React.createElement(SmsRecipients,{value,contacts:[contact],onChange:()=>changes++}));});
 await add(r,'4000');assert.equal(changes,0);assert.match(r.root.findByProps({role:'alert'}).props.children,/100/);
 await act(async()=>r.root.findByProps({'aria-label':'从通讯录添加收件人'}).props.onClick());
 await act(async()=>r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[0].props.onChange());
 assert.equal(changes,0);assert.equal(r.root.findAllByType('input').filter(n=>n.props.type==='checkbox')[0].props.checked,false);
 await act(async()=>r.unmount());
});

test('inline dismissal preserves body but reopens with explicit recipient, pending accepted send clears even after close',async()=>{
 const {SmsCompose}=await modules();let r!:ReactTestRenderer;let resolve!:()=>void;
 const props={...base,account:'dismissal',remoteNumber:'10086',onClose(){},onSend:()=>new Promise<void>(r=>resolve=r)};
 await act(async()=>{r=create(React.createElement(SmsCompose,props));});
 await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'retained'}}));
 await act(async()=>r.unmount());
 await act(async()=>{r=create(React.createElement(SmsCompose,{...props,remoteNumber:'10010'}));});
 assert.equal(r.root.findByType('textarea').props.value,'retained');
 assert.ok(r.root.findByProps({'aria-label':'移除 10010'}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 await act(async()=>r.unmount());
 await act(async()=>resolve());
 await act(async()=>{r=create(React.createElement(SmsCompose,props));});
 assert.equal(r.root.findByType('textarea').props.value,'');
 await act(async()=>r.unmount());
});

test('both composer batch paths retry once with same key, expose accepted queue and clear body',async()=>{
 const {Messages,SmsCompose}=await modules();
 const prior=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');const map=new Map<string,string>();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>map.get(k)||null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)}});
 try{for(const [index,Component] of [Messages,SmsCompose].entries()){
  let r!:ReactTestRenderer;const bodies:any[]=[];let singles=0,refreshed=0;let fail=true;
  const props={...base,account:`batch${index}`,remoteNumber:'10086',onClose(){},composeTo:{simId:'a',remoteNumber:'10086',token:1},onSend:async()=>{singles++;},onSent:()=>{refreshed++;},request:async(url:string,body:any,_method?:string,options?:any)=>{assert.equal(url,'/sms/batch');bodies.push({body,...options});if(fail)throw new Error('timeout');return {batchId:'b',items:[{id:'a'},{id:'b'}],intervalSeconds:5};}};
  await act(async()=>{r=create(React.createElement(Component,props));});await add(r,'10010');
  await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'batch body'}}));
  await act(async()=>{r.root.findByType('form').props.onSubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,15));});
  assert.equal(r.root.findByType('textarea').props.value,'batch body');assert.equal(r.root.findAllByType('li').length,2);
  fail=false;
  await act(async()=>{r.root.findByType('form').props.onSubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,15));});
  assert.equal(singles,0);assert.equal(refreshed,1);assert.deepEqual(bodies[0],bodies[1]);assert.equal(r.root.findByType('textarea').props.value,'');
  await act(async()=>r.unmount());
 }}finally{if(prior)Object.defineProperty(globalThis,'sessionStorage',prior);else Reflect.deleteProperty(globalThis,'sessionStorage');}
});
