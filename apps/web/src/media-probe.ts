export type ProbeAPI=<T>(path:string,body?:unknown,method?:string,options?:{signal?:AbortSignal;timeoutMs?:number})=>Promise<T>;
type ProbeNode={nodeId:string;probeUrl:string;grants:string[]};
type ProbeOptions={networkGeneration:string;nodes:ProbeNode[]};
type ProbeSample={nodeId:string;outcome:'ok'|'timeout'|'network_error';httpsRttMs?:number};
const trustedOrigins=new Set(['https://control.example.com','https://relay.example.com:16800']);

/** Measures this browser's current HTTPS path, never a VPS-to-VPS surrogate. */
export async function measureMediaNodes(api:ProbeAPI,signal:AbortSignal,dependencies:{fetch?:typeof fetch;now?:()=>number;newId?:()=>string;timeoutMs?:number}={}):Promise<string>{
 const request=dependencies.fetch??fetch,now=dependencies.now??(()=>performance.now());
 const networkGeneration=(dependencies.newId??(()=>crypto.randomUUID()))();
 const assertCurrent=()=>{if(signal.aborted)throw new Error('通话网络测量已取消，请重试');};
 assertCurrent();
 const options=await api<ProbeOptions>('/media/probes/options',{networkGeneration},undefined,{signal,timeoutMs:6000});
 assertCurrent();
 if(options.networkGeneration!==networkGeneration||!Array.isArray(options.nodes)||!options.nodes.length||options.nodes.length>16)throw new Error('中继探测配置无效');
 const seen=new Set<string>();
 for(const node of options.nodes){
  const url=new URL(node.probeUrl);
  if(!trustedOrigins.has(url.origin)||url.pathname!=='/probe'||url.search||url.hash||url.username||url.password||!node.nodeId||seen.has(node.nodeId)||!Array.isArray(node.grants)||node.grants.length!==3||node.grants.some(g=>typeof g!=='string'||!g||g.length>4096))throw new Error('中继探测配置无效');
  seen.add(node.nodeId);
 }
 const results=await Promise.all(options.nodes.map(async node=>{
  const samples:ProbeSample[]=[];
  for(const grant of node.grants){
   assertCurrent();
   const controller=new AbortController();let timedOut=false;
   const cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});
   const timer=setTimeout(()=>{timedOut=true;controller.abort();},dependencies.timeoutMs??2000);
   const started=now();
   try{
    const response=await request(node.probeUrl,{method:'POST',headers:{Authorization:`Bearer ${grant}`},credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
    const body=await response.json();assertCurrent();
    const elapsed=now()-started;
    if(!response.ok||body.ok!==true||body.nodeId!==node.nodeId||!Number.isFinite(elapsed)||elapsed<0||elapsed>10000)throw new Error('Invalid probe response');
    samples.push({nodeId:node.nodeId,outcome:'ok',httpsRttMs:elapsed});
   }catch{
    assertCurrent();samples.push({nodeId:node.nodeId,outcome:timedOut?'timeout':'network_error'});
   }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
  }
  return samples;
 }));
 assertCurrent();
 const samples=results.flat();
 const result=await api<{accepted:number}>('/media/probes/results',{networkGeneration,samples},undefined,{signal,timeoutMs:6000});
 if(result.accepted!==samples.length)throw new Error('中继测量结果未被完整确认');
 const {measureRelayQuality}=await import('./media-quality-probe.ts');
 await measureRelayQuality(api,networkGeneration,signal);
 assertCurrent();return networkGeneration;
}
