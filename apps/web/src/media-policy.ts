type MediaRequestOptions={signal?:AbortSignal;timeoutMs?:number};
type MediaAPI=<T>(path:string,body?:unknown,method?:string,options?:MediaRequestOptions)=>Promise<T>;
type RelayOptions={iceServers:RTCIceServer[];iceTransportPolicy:'relay'};
type Transport='udp'|'tls';
type Measure=(api:MediaAPI,signal:AbortSignal)=>Promise<string>;

export function errorCode(error:unknown):string|undefined{return typeof error==='object'&&error!==null&&'code' in error?String(error.code):undefined;}

/**
 * iOS MediaRetryPolicy.shouldRetryTLS 的 Web 对应：只有 UDP 下中继候选缺失 / ICE 失败 / ICE 超时才换 TLS 重试一次。
 * 白名单只含 offer 发出之前的失败——Web 没有媒体释放接口，offer 已被桥接受后再发会 409（Control 503 MEDIA_BRIDGE_UNAVAILABLE），
 * 所以 offer 之后的连接超时、API 错误、鉴权、麦克风、取消都不重试。
 */
export function shouldRetryTls(error:unknown,transport:Transport):boolean{
 return transport==='udp'&&['NO_RELAY_CANDIDATE','ICE_FAILED','ICE_TIMEOUT'].includes(errorCode(error)??'');
}

/** Server media codes carry the real reason; anything else (including DOMException numeric codes) keeps its own message. */
const MEDIA_ERROR_MESSAGES:Record<string,string>={
 GATEWAY_OFFLINE:'网关当前不在线（心跳超时），请稍后重试',
 MEDIA_UNAVAILABLE:'网关媒体能力暂不可用，请稍后重试',
 MEDIA_NODE_UNAVAILABLE:'当前网络与设备没有共同可用的媒体节点',
 MEDIA_BRIDGE_UNAVAILABLE:'媒体节点未接受连接，请重试',
 MEDIA_REVOKED:'通话已结束或媒体授权失效',
 MEDIA_PROBE_REQUIRED:'网络测量尚未完成，请重试',
 MEDIA_NODE_MISMATCH:'媒体节点不一致，请重新连接音频',
 MEDIA_NOT_WINNER:'此通话已由其他设备接听',
};
export function mediaErrorMessage(code:string|undefined,fallback:string):string{
 return (code!==undefined&&Object.prototype.hasOwnProperty.call(MEDIA_ERROR_MESSAGES,code)?MEDIA_ERROR_MESSAGES[code]:undefined)??fallback;
}

/** S72 E：通话接口的 409 错误码固定文案；其余错误码沿用服务端 message。 */
const CALL_ERROR_MESSAGES:Record<string,string>={
 SAME_DEVICE_INTERNAL:'同一设备上的两张卡不能互打',
 OWN_OUTGOING_CALL:'这是你正在拨出的通话',
};
export function callErrorMessage(code:string|undefined,fallback:string):string{
 return (code!==undefined&&Object.prototype.hasOwnProperty.call(CALL_ERROR_MESSAGES,code)?CALL_ERROR_MESSAGES[code]:undefined)??fallback;
}

export async function boundedOperation<T>(operation:Promise<T>,signal:AbortSignal,timeoutMs:number,message:string,onLateValue?:(value:T)=>void):Promise<T>{
 return await new Promise<T>((resolve,reject)=>{
  let settled=false;
  const finish=(action:()=>void)=>{if(settled)return false;settled=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);action();return true;};
  const onAbort=()=>finish(()=>reject(new DOMException('媒体连接已取消','AbortError')));
  const timer=setTimeout(()=>finish(()=>reject(new Error(message))),timeoutMs);
  signal.addEventListener('abort',onAbort,{once:true});
  operation.then(value=>{if(!finish(()=>resolve(value)))try{onLateValue?.(value);}catch{/* Late cleanup must never create an unhandled rejection. */}},error=>{finish(()=>reject(error));});
  if(signal.aborted)onAbort();
 });
}

export type CallEndPolicy={id:string;state:string;claimedByCurrentSession?:boolean;originatingPlatform?:string};
export function mayEndCall(call:CallEndPolicy,mediaCallId:string|null):boolean{
 // S38: 手机拨号盘发起的通话不归任何客户端控制（Control 对它的 /end 返回 409）。
 if(call.originatingPlatform==='pixel')return false;
 if(call.state==='incoming_ringing')return true;
 return ['outgoing_pending','connecting','active','ending','unknown'].includes(call.state)&&(call.claimedByCurrentSession===true||mediaCallId===call.id);
}

export function requiresSessionOwnerEnd(call:CallEndPolicy):boolean{
 return ['outgoing_pending','connecting','active','ending','unknown'].includes(call.state);
}

export function ringingEndGuard(call:CallEndPolicy):{onlyIfRinging:true}{
 if(call.state!=='incoming_ringing')throw new Error('只能用振铃保护拒接尚未接听的来电');
 return {onlyIfRinging:true};
}

export function validateRelayOptions(options:RelayOptions,transport:Transport):RTCConfiguration{
 if(options?.iceTransportPolicy!=='relay'||!Array.isArray(options.iceServers)||options.iceServers.length!==1)throw new Error('中继授权配置无效');
 const server=options.iceServers[0],urls=typeof server.urls==='string'?[server.urls]:server.urls;
 if(!Array.isArray(urls)||urls.length!==1||typeof server.username!=='string'||!server.username||typeof server.credential!=='string'||!server.credential)throw new Error('中继授权配置无效');
 const value=urls[0].toLowerCase(),match=/^(turn|turns):(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?\?transport=(udp|tcp)$/.exec(value);
 if(!match||(match[3]!==undefined&&Number(match[3])>65535))throw new Error('中继授权配置无效');
 const host=match[2];
 if(host.startsWith('[')){
  try{new URL(`https://${host}`);}catch{throw new Error('中继授权配置无效');}
 }else if(host.length>253||host.split('.').some(label=>label.length<1||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw new Error('中继授权配置无效');
 if(transport==='udp'&&(match[1]!=='turn'||match[4]!=='udp'))throw new Error('中继授权配置无效');
 if(transport==='tls'&&(match[1]!=='turns'||match[4]!=='tcp'))throw new Error('中继授权配置无效');
 return {iceServers:[server],iceTransportPolicy:'relay'};
}

export async function authorizeMedia(callId:string,api:MediaAPI,transport:Transport,signal:AbortSignal,measure:Measure):Promise<RTCConfiguration>{
 for(let attempt=0;attempt<2;attempt++){
  const networkGeneration=await measure(api,signal);
  try{
   const options=await api<RelayOptions>(`/calls/${callId}/media/options`,{transport,networkGeneration},undefined,{signal,timeoutMs:6000});
   return validateRelayOptions(options,transport);
  }catch(error){if(errorCode(error)==='MEDIA_PROBE_REQUIRED'&&attempt===0)continue;throw error;}
 }
 throw new Error('无法确认媒体节点');
}
