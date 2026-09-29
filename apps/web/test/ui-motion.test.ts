import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer} from 'vite';

test('system theme changes suppress transitions until the next frame and clean up on unmount', async () => {
  const server=await createServer({root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),server:{middlewareMode:true,hmr:false},appType:'custom'});
  const names=['window','document','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
  let listener!:()=>void, nextFrame!:()=>void;
  let appended=0,removed=0,reflows=0,unsubscribed=false;
  const style={textContent:'',remove:()=>{removed++;}};
  const values={
    window:{matchMedia:(query:string)=>{assert.equal(query,'(prefers-color-scheme: dark)');return {addEventListener:(_:string,fn:()=>void)=>{listener=fn;},removeEventListener:()=>{unsubscribed=true;}};}},
    document:{createElement:()=>style,head:{append:()=>{appended++;}},documentElement:{get offsetHeight(){reflows++;return 800;}}},
    requestAnimationFrame:(fn:()=>void)=>{nextFrame=fn;return 1;},cancelAnimationFrame:()=>{},IS_REACT_ACT_ENVIRONMENT:true,
  };
  let renderer:ReactTestRenderer|undefined;
  try{
    for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,value:values[name]});
    const {useUiMotionSafety}=await server.ssrLoadModule('/src/ui-motion.ts');
    function Harness(){useUiMotionSafety();return null;}
    await act(async()=>{renderer=create(React.createElement(Harness));});
    listener();
    assert.equal(style.textContent,'*,*::before,*::after{transition:none !important}');
    assert.equal(appended,1);assert.equal(reflows,1);assert.equal(removed,0);
    nextFrame();assert.equal(removed,1);
    listener();
    await act(async()=>renderer!.unmount());renderer=undefined;
    assert.equal(removed,2);assert.equal(unsubscribed,true);
  }finally{
    if(renderer)await act(async()=>renderer!.unmount());
    for(const [name,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
    await server.close();
  }
});
