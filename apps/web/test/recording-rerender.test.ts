import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {createServer} from 'vite';
import type {TrackDescriptor} from '../src/recording-contract.ts';

class AudioElementFake extends EventTarget {
 currentTime=0;duration=30;ended=false;readyState=4;plays=0;pauses=0;loads=0;removedSources=0;
 async play(){this.plays++;}
 pause(){this.pauses++;}
 load(){this.loads++;}
 removeAttribute(name:string){if(name==='src')this.removedSources++;}
}

const callId='00000000-0000-4000-8000-000000000900';
const remote:TrackDescriptor={id:'remote_original',sourceRole:'original_capture',mediaType:'audio/wav',bytes:48044,sha256:'a'.repeat(64),captureComplete:true,gapCount:0,droppedFrames:0};
const caller:TrackDescriptor={id:'caller_original',sourceRole:'original_capture',mediaType:'audio/wav',bytes:50044,sha256:'b'.repeat(64),captureComplete:true,gapCount:0,droppedFrames:0};
const cloneTracks=(tracks:readonly [TrackDescriptor,TrackDescriptor]):[TrackDescriptor,TrackDescriptor]=>tracks.map(track=>({...track})) as [TrackDescriptor,TrackDescriptor];

test('paired playback survives more than two polling rerenders and content changes still dispose and reverify',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const vite=await createServer({root,server:{middlewareMode:true},appType:'custom'});
 const previousFetch=globalThis.fetch;
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 let expected:readonly [TrackDescriptor,TrackDescriptor]=[remote,caller],fetches=0;
 globalThis.fetch=async input=>{
  fetches++;
  const url=String(input),track=url.includes('remote_original')?expected[0]:expected[1];
  return new Response(new Uint8Array([0]),{status:206,headers:{'Content-Type':'audio/wav','Content-Length':'1','Content-Range':`bytes 0-0/${track.bytes}`,'Accept-Ranges':'bytes','ETag':`"${track.sha256}"`}});
 };
 const audios:AudioElementFake[]=[];
 let renderer:ReactTestRenderer|undefined;
 try{
  const {CombinedRecordingAudio}=await vite.ssrLoadModule('/src/recording.tsx') as typeof import('../src/recording.tsx');
  const view=(tracks:readonly [TrackDescriptor,TrackDescriptor])=>React.createElement(CombinedRecordingAudio,{callId,source:'pixel',tracks,label:'双向原声一起播放',description:'test'});
  await act(async()=>{renderer=create(view(cloneTracks(expected)),{createNodeMock:element=>{if(element.type==='audio'){const audio=new AudioElementFake();audios.push(audio);return audio;}return {};}});});
  assert.equal(fetches,2);assert.equal(audios.length,2);
  const playButton=()=>renderer!.root.findAllByType('button').find(button=>{
   const text=button.children.join('');return text==='播放'||text==='暂停';
  });
  await act(async()=>{playButton()!.props.onClick();});
  assert.deepEqual(audios.map(audio=>audio.plays),[1,1]);

  // Dashboard polling reconstructs descriptors and tuple arrays on every render.
  for(let poll=0;poll<3;poll++)await act(async()=>{renderer!.update(view(cloneTracks(expected)));});
  assert.equal(fetches,2,'stable content must not repeat authenticated header probes');
  assert.equal(audios.length,2,'stable content must retain the mounted audio elements');
  assert.deepEqual(audios.map(audio=>audio.pauses),[0,0]);
  assert.equal(playButton()!.children.join(''),'暂停');

  expected=[{...remote,sha256:'c'.repeat(64)},caller];
  await act(async()=>{renderer!.update(view(cloneTracks(expected)));});
  assert.equal(fetches,4,'changed content identity must reverify both tracks');
  assert.equal(audios.length,4,'changed content identity must mount a fresh pair');
  assert.deepEqual(audios.slice(0,2).map(audio=>({pauses:audio.pauses,removedSources:audio.removedSources,loads:audio.loads})),[
   {pauses:1,removedSources:1,loads:1},{pauses:1,removedSources:1,loads:1},
  ],'the replaced pair must release each old media element exactly once after React clears its refs');
  await act(async()=>renderer!.unmount());renderer=undefined;
  assert.ok(audios.every(audio=>audio.pauses===1&&audio.removedSources===1&&audio.loads===1),'collapse must release every pair element exactly once');
 }finally{
  if(renderer)await act(async()=>renderer!.unmount());
  globalThis.fetch=previousFetch;
  delete (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;
  await vite.close();
 }
});

test('S38 手机直拨的录音默认打开 Pixel 归档，并和其他录音一样有两条原声',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const vite=await createServer({root,server:{middlewareMode:true},appType:'custom'});
 const previousFetch=globalThis.fetch;
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 // 手机直拨也有两条真声轨：remote_original 是对方，caller_original 是本机自己的声音。
 const manifest={source:'pixel',version:2,archiveId:'c0f07951-cd27-48d5-a472-39f547737d7b',callId,manifestSha256:'f'.repeat(64),
  archiveComplete:true,captureComplete:true,startedAt:'2026-09-10T00:00:00Z',endedAt:'2026-09-10T00:01:00Z',
  tracks:[remote,caller].map(track=>({track:track.id,sourceRole:'original_capture',mediaType:'audio/wav',bytes:track.bytes,sha256:track.sha256,captureComplete:true,gapCount:0,droppedFrames:0})),
  timeline:{mediaType:'application/x-ndjson',bytes:128,sha256:'a'.repeat(64)}};
 globalThis.fetch=async input=>{
  const url=String(input);
  if(!url.includes('/recordings/'))return new Response(JSON.stringify({recording:manifest}),{status:200,headers:{'Content-Type':'application/json'}});
  const track=url.includes('remote_original')?manifest.tracks[0]!:manifest.tracks[1]!;
  return new Response(new Uint8Array([0]),{status:206,headers:{'Content-Type':'audio/wav','Content-Length':'1','Content-Range':`bytes 0-0/${track.bytes}`,'Accept-Ranges':'bytes','ETag':`"${track.sha256}"`}});
 };
 let renderer:ReactTestRenderer|undefined;
 try{
  const {CallRecording}=await vite.ssrLoadModule('/src/recording.tsx') as typeof import('../src/recording.tsx');
  await act(async()=>{renderer=create(React.createElement(CallRecording,{callId,preferPixelSource:true}),{createNodeMock:element=>element.type==='audio'?new AudioElementFake():{}});});
  const button=(text:string)=>renderer!.root.findAllByType('button').find(node=>node.children.join('')===text);
  await act(async()=>{button('查看录音')!.props.onClick();await new Promise(resolve=>setImmediate(resolve));});
  await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});
  assert.deepEqual(renderer!.root.findAllByType('button').filter(node=>node.props['aria-pressed']===true).map(node=>node.children.join('')),
   ['Pixel 原始归档'],'手机直拨的录音只在 Pixel 归档里，默认就打开它');
  const strongs=renderer!.root.findAllByType('strong').map(node=>node.children.join(''));
  assert.ok(strongs.includes('双向原声一起播放'),`手机直拨也有两条真声轨，要能双向并播：${strongs.join('/')}`);
  assert.ok(strongs.includes('对方原声')&&strongs.includes('我的原声'),`两条原声都要能单独播放：${strongs.join('/')}`);
  assert.ok(renderer!.root.findAllByType('details').some(node=>node.props.className==='original-tracks'),'保留「分别播放原声」');
  assert.ok(renderer!.root.findAll(node=>node.type==='button'&&node.children.join('')==='下载对话 MP3').length>0,'保留下载对话 MP3');
 }finally{
  if(renderer)await act(async()=>renderer!.unmount());
  globalThis.fetch=previousFetch;
  delete (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;
  await vite.close();
 }
});
