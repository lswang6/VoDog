import test from 'node:test';
import assert from 'node:assert/strict';
import {measureMediaNodes,type ProbeAPI} from '../src/media-probe.ts';
function fixture(url='https://control.example.com/probe'){
 const reports:unknown[]=[];
 const api:ProbeAPI=async<T>(path:string,body?:unknown)=>{
  if(path.includes('/quality-probes/'))throw Object.assign(new Error('disabled'),{code:'MEDIA_QUALITY_UNAVAILABLE'});
  if(path.endsWith('/options'))return {networkGeneration:'generation-1',nodes:[{nodeId:'demo-node-1',probeUrl:url,grants:['one','two','three']}]} as T;
  reports.push(body);return {accepted:3} as T;
 };
 return {api,reports};
}
test('probe sends one-shot empty credential-isolated POSTs and actual browser timings',async()=>{
 const {api,reports}=fixture(),requests:RequestInit[]=[];let time=0;
 const request=(async(_url,init)=>{requests.push(init!);return new Response(JSON.stringify({ok:true,nodeId:'demo-node-1'}));}) as typeof fetch;
 assert.equal(await measureMediaNodes(api,new AbortController().signal,{fetch:request,now:()=>time+=10,newId:()=> 'generation-1'}),'generation-1');
 assert.equal(requests.length,3);assert.deepEqual(requests.map(r=>(r.headers as Record<string,string>).Authorization),['Bearer one','Bearer two','Bearer three']);
 for(const r of requests){assert.equal(r.method,'POST');assert.equal(r.body,undefined);assert.equal(r.credentials,'omit');assert.equal(r.redirect,'error');}
 assert.deepEqual(reports,[{networkGeneration:'generation-1',samples:Array.from({length:3},()=>({nodeId:'demo-node-1',outcome:'ok',httpsRttMs:10}))}]);
});
test('untrusted destination is rejected before any grant request',async()=>{
 const {api,reports}=fixture('https://untrusted.invalid/probe');let requested=false;
 await assert.rejects(measureMediaNodes(api,new AbortController().signal,{newId:()=> 'generation-1',fetch:(async()=>{requested=true;throw new Error();}) as typeof fetch}));
 assert.equal(requested,false);assert.deepEqual(reports,[]);
});
test('cancelled options cannot submit evidence under changed session or network',async()=>{
 const controller=new AbortController();let requests=0;
 const api:ProbeAPI=async<T>()=>{requests++;controller.abort();return {networkGeneration:'generation-1',nodes:[]} as T;};
 await assert.rejects(measureMediaNodes(api,controller.signal,{newId:()=> 'generation-1'}),/取消/);assert.equal(requests,1);
});
test('timeout and mismatched node response do not become successful RTT samples',async()=>{
 const {api,reports}=fixture();let calls=0;
 const request=(async(_url,init)=>{calls++;if(calls===1)return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));return new Response(JSON.stringify({ok:true,nodeId:'wrong'}));}) as typeof fetch;
 await measureMediaNodes(api,new AbortController().signal,{fetch:request,newId:()=> 'generation-1',timeoutMs:1});
 assert.deepEqual(reports,[{networkGeneration:'generation-1',samples:[{nodeId:'demo-node-1',outcome:'timeout'},{nodeId:'demo-node-1',outcome:'network_error'},{nodeId:'demo-node-1',outcome:'network_error'}]}]);
});
