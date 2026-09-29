/** Deadline covers headers and body parsing; caller cancellation stays silent. */
export async function recordingRequest<T>(
 url:string, options:RequestInit, parent:AbortSignal,
 consume:(response:Response)=>Promise<T>, timeoutMs=10000,
 busyRetryDelaysMs:readonly number[]=[500,1000],
):Promise<T>{
 if(busyRetryDelaysMs.length>2||busyRetryDelaysMs.some(delay=>!Number.isFinite(delay)||delay<0)||busyRetryDelaysMs.reduce((sum,delay)=>sum+delay,0)>2000)throw new Error('invalid recording busy retry policy');
 const controller=new AbortController();let timedOut=false;
 const abort=()=>controller.abort();
 if(parent.aborted)abort();else parent.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
 let response:Response|undefined;
 try{
  const retryBusy=eligibleBusyRetry(url,options);
  for(let attempt=0;;attempt++){
   response=await fetch(url,{...options,signal:controller.signal});
   if(retryBusy&&response.status===503){
    const inspected=await inspectBoundedError(response);
    response=inspected.response;
    if(inspected.code==='RECORDING_VERIFICATION_BUSY'&&attempt<busyRetryDelaysMs.length){
     await response.body?.cancel().catch(()=>{});
     await abortableDelay(busyRetryDelaysMs[attempt],controller.signal);
     continue;
    }
   }
   return await consume(response);
  }
 }catch(error){
  if(timedOut&&!parent.aborted)throw new Error('读取录音超时，请重试。');
  throw error;
 }finally{
  clearTimeout(timer);parent.removeEventListener('abort',abort);
  if(controller.signal.aborted)await response?.body?.cancel().catch(()=>{});
 }
}

function eligibleBusyRetry(url:string,options:RequestInit):boolean{
 if(String(options.method??'GET').toUpperCase()!=='GET')return false;
 try{
  const parsed=new URL(url,'https://recording.invalid');
  if(!/^\/api\/v1\/calls\/[0-9a-f-]{36}\/recordings\/(remote_original|caller_original|caller_playout)$/.test(parsed.pathname))return false;
  const source=parsed.searchParams.get('source');
  if(source!=='media_node'&&source!=='pixel')return false;
  const format=parsed.searchParams.get('format');
  if(format!==null&&format!=='mp3')return false;
  // S36 C4: mp3 导出也要保留 503 忙碌重试，否则转码排队时下载会直接失败。
  const keys=[...parsed.searchParams.keys()].sort().filter(key=>key!=='format');
  const range=new Headers(options.headers).get('Range');
  if(parsed.searchParams.get('disposition')==='attachment'){
   return !range&&keys.length===2&&keys[0]==='disposition'&&keys[1]==='source';
  }
  if(format!==null)return false;
  return source==='pixel'&&range==='bytes=0-0'&&keys.length===1&&keys[0]==='source';
 }catch{return false;}
}

async function inspectBoundedError(response:Response,maxBytes=4096):Promise<{response:Response;code?:string}>{
 const headers=new Headers(response.headers),declared=Number(headers.get('Content-Length')??'0');
 if(Number.isFinite(declared)&&declared>maxBytes){await response.body?.cancel().catch(()=>{});return {response:new Response(new Uint8Array(),{status:response.status,statusText:response.statusText,headers})};}
 const reader=response.body?.getReader();if(!reader)return {response,code:undefined};
 const chunks:Uint8Array[]=[];let size=0,complete=false;
 try{while(true){const {done,value}=await reader.read();if(done){complete=true;break;}if(!value)continue;if(size+value.byteLength>maxBytes){await reader.cancel();return {response:new Response(new Uint8Array(),{status:response.status,statusText:response.statusText,headers})};}size+=value.byteLength;chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 await response.body?.cancel().catch(()=>{});
 const rebuilt=new Response(bytes,{status:response.status,statusText:response.statusText,headers});
 if(!complete)return {response:rebuilt};
 try{const value=JSON.parse(new TextDecoder().decode(bytes)) as unknown;if(!value||typeof value!=='object'||Array.isArray(value))return {response:rebuilt};const error=(value as {error?:unknown}).error;if(!error||typeof error!=='object'||Array.isArray(error))return {response:rebuilt};const code=(error as {code?:unknown}).code;return {response:rebuilt,code:typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:undefined};}catch{return {response:rebuilt};}
}

function abortableDelay(delayMs:number,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{if(signal.aborted){reject(signal.reason??new DOMException('aborted','AbortError'));return;}const timer=setTimeout(done,delayMs);function done(){signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??new DOMException('aborted','AbortError'));}signal.addEventListener('abort',abort,{once:true});});
}

/** Read only the small, structured error code needed for user-facing recovery. */
export async function recordingErrorCode(response:Response,maxBytes=4096):Promise<string|undefined>{
 const length=Number(response.headers.get('Content-Length')??'0');
 if(Number.isFinite(length)&&length>maxBytes){await response.body?.cancel().catch(()=>{});return undefined;}
 const reader=response.body?.getReader();if(!reader)return undefined;
 const chunks:Uint8Array[]=[];let size=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;if(!value)continue;
   size+=value.byteLength;if(size>maxBytes){await reader.cancel();return undefined;}chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const parsed=JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return undefined;
  const error=(parsed as {error?:unknown}).error;
  if(!error||typeof error!=='object'||Array.isArray(error))return undefined;
  const code=(error as {code?:unknown}).code;
  return typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:undefined;
 }catch{return undefined;}finally{reader.releaseLock();}
}
