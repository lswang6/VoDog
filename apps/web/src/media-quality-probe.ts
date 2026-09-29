import type {ProbeAPI} from './media-probe.ts';

export type QualitySample={nodeId:string;outcome:'ok'|'timeout'|'network_error';sent:number;received:number;sampleDurationMs:number;connectionMs?:number;rttMedianMs?:number;rttP95Ms?:number;jitterMs?:number};
type QualityNode={nodeId:string;probeUrl:string;expiresAt:string;grant:string;iceServers:RTCIceServer[]};
type QualityOptions={networkGeneration:string;measurement:string;lifetimeMs:number;sampleDurationMs:number;packetIntervalMs:number;maxPackets:number;maxPacketBytes:number;iceTransportPolicy:string;nodes:QualityNode[]};
type Dependencies={createPeer?:(configuration:RTCConfiguration)=>RTCPeerConnection;fetch?:typeof fetch;now?:()=>number;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;measureNode?:(node:QualityNode,options:QualityOptions,signal:AbortSignal)=>Promise<QualitySample>};
const trustedOrigins=new Set(['https://control.example.com','https://relay.example.com:16800']);

function code(error:unknown){return typeof error==='object'&&error!==null&&'code' in error?String(error.code):undefined;}
function finite(value:number,min:number,max:number){return Number.isFinite(value)&&value>=min&&value<=max;}
function validateOptions(value:QualityOptions,generation:string):QualityOptions{
 if(value.networkGeneration!==generation||value.measurement!=='relay_data_channel_echo_v1'||value.lifetimeMs!==5000||value.sampleDurationMs!==2000||value.packetIntervalMs!==20||value.maxPackets!==250||value.maxPacketBytes!==512||value.iceTransportPolicy!=='relay'||!Array.isArray(value.nodes)||value.nodes.length<1||value.nodes.length>16)throw new Error('中继质量探测配置无效');
 const seen=new Set<string>();
 for(const node of value.nodes){
  const url=new URL(node.probeUrl);
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(node.nodeId)||seen.has(node.nodeId)||!trustedOrigins.has(url.origin)||url.pathname!=='/webrtc-probe/offer'||url.search||url.hash||url.username||url.password||typeof node.grant!=='string'||!node.grant||node.grant.length>4096||!Number.isFinite(Date.parse(node.expiresAt))||!Array.isArray(node.iceServers)||node.iceServers.length!==1)throw new Error('中继质量探测配置无效');
  const server=node.iceServers[0],urls=typeof server.urls==='string'?[server.urls]:server.urls;
  if(!Array.isArray(urls)||urls.length!==1||!/^turn:[A-Za-z0-9.-]+:\d+\?transport=udp$/.test(urls[0])||typeof server.username!=='string'||!server.username||typeof server.credential!=='string'||!server.credential)throw new Error('中继质量探测配置无效');
  seen.add(node.nodeId);
 }
 return value;
}

export function qualityPacket(sequence:number,sentUs:bigint):ArrayBuffer{
 if(!Number.isInteger(sequence)||sequence<0||sequence>249||sentUs<0n)throw new Error('invalid quality packet');
 const bytes=new Uint8Array(32);bytes.set([0x43,0x43,0x51,0x31]);const view=new DataView(bytes.buffer);view.setUint32(4,sequence);view.setBigUint64(8,sentUs);return bytes.buffer;
}
export function parseQualityEcho(data:ArrayBuffer):{sequence:number;sentUs:bigint}|null{
 if(data.byteLength!==32)return null;const bytes=new Uint8Array(data);if(bytes[0]!==0x43||bytes[1]!==0x43||bytes[2]!==0x51||bytes[3]!==0x31||bytes.slice(16).some(Boolean))return null;
 const view=new DataView(data);const sequence=view.getUint32(4);if(sequence>249)return null;return {sequence,sentUs:view.getBigUint64(8)};
}
function percentile(values:number[],fraction:number){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)]!;}
export function qualityMetrics(nodeId:string,sent:number,duration:number,rtts:number[],connectionMs:number):QualitySample{
 if(sent<20||rtts.length<1||duration<2000)throw new Error('insufficient relay quality sample');
 const median=percentile(rtts,.5),p95=percentile(rtts,.95),differences=rtts.slice(1).map((value,index)=>Math.abs(value-rtts[index]!));
 return {nodeId,outcome:'ok',sent,received:rtts.length,sampleDurationMs:Math.min(5000,duration),connectionMs:Math.min(5000,connectionMs),rttMedianMs:median,rttP95Ms:Math.max(median,p95),jitterMs:differences.length?differences.reduce((a,b)=>a+b,0)/differences.length:0};
}
export function completedRelayOnlyUdpSdp(sdp:string):string{
 const lines=sdp.split(/\r?\n/),media=lines.map((line,index)=>line.startsWith('m=')?index:-1).filter(index=>index>=0);
 const candidates=lines.map((line,index)=>({line,index})).filter(item=>item.line.startsWith('a=candidate:'));
 if(media.length!==1||!lines[media[0]!]!.startsWith('m=application ')||!candidates.length||candidates.some(item=>!/(?:^| )typ relay(?: |$)/.test(item.line)||!/(?:^| )udp(?: |$)/i.test(item.line)))throw new Error('中继质量探测未取得完整 UDP relay candidate');
 if(!lines.some(line=>line==='a=end-of-candidates'))lines.splice(candidates[candidates.length-1]!.index+1,0,'a=end-of-candidates');
 return lines.join('\r\n');
}
const defaultSleep=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(new DOMException('质量探测已取消','AbortError'));}signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
function waitUntil(target:EventTarget,event:string,signal:AbortSignal,timeoutMs:number,ready:()=>boolean,failed:()=>boolean):Promise<void>{return new Promise((resolve,reject)=>{let settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);target.removeEventListener(event,changed);signal.removeEventListener('abort',aborted);error?reject(error):resolve();};const changed=()=>{if(ready())finish();else if(failed())finish(new Error('WebRTC quality probe failed'));};const aborted=()=>finish(new DOMException('质量探测已取消','AbortError'));const timer=setTimeout(()=>finish(new DOMException('quality timeout','AbortError')),Math.max(0,timeoutMs));target.addEventListener(event,changed);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();else changed();});}
function abortable<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{let settled=false;const finish=(error:unknown,value?:T)=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);error===undefined?resolve(value as T):reject(error);};const aborted=()=>finish(new DOMException('质量探测已取消','AbortError'));signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();operation.then(value=>finish(undefined,value),error=>finish(error));});}

export async function measureNode(node:QualityNode,options:QualityOptions,parent:AbortSignal,deps:Dependencies):Promise<QualitySample>{
 const now=deps.now??(()=>performance.now()),sleep=deps.sleep??defaultSleep,started=now(),deadline=started+options.lifetimeMs,controller=new AbortController(),abort=()=>controller.abort();parent.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,options.lifetimeMs);let peer:RTCPeerConnection|undefined,channel:RTCDataChannel|undefined,sent=0,sampleStarted=started;
 let cleaned=false;const cleanup=()=>{if(cleaned)return;cleaned=true;try{channel?.close();}catch{}try{peer?.close();}catch{}};controller.signal.addEventListener('abort',cleanup,{once:true});
 try{
  peer=(deps.createPeer??(configuration=>new RTCPeerConnection(configuration)))({iceServers:node.iceServers,iceTransportPolicy:'relay'});
  channel=peer.createDataChannel('media-quality-v1',{ordered:false,maxRetransmits:0});channel.binaryType='arraybuffer';
  const echoes=new Map<number,number>(),payloads=new Map<number,Uint8Array>();
  channel.addEventListener('message',event=>{if(!(event.data instanceof ArrayBuffer))return;const parsed=parseQualityEcho(event.data);if(!parsed||echoes.has(parsed.sequence))return;const expected=payloads.get(parsed.sequence),actual=new Uint8Array(event.data);if(!expected||expected.some((byte,index)=>byte!==actual[index]))return;echoes.set(parsed.sequence,Math.max(0,now()-Number(parsed.sentUs)/1000));});
  const offer=await abortable(peer.createOffer(),controller.signal);await abortable(peer.setLocalDescription(offer),controller.signal);
  if(peer.iceGatheringState!=='complete')await waitUntil(peer,'icegatheringstatechange',controller.signal,2000,()=>peer!.iceGatheringState==='complete',()=>peer!.connectionState==='failed'||peer!.connectionState==='closed');
  if(now()>=deadline)throw new DOMException('quality timeout','AbortError');
  const rawSdp=peer.localDescription?.sdp;if(typeof rawSdp!=='string')throw new Error('quality offer missing');const localSdp=completedRelayOnlyUdpSdp(rawSdp);
  const response=await (deps.fetch??fetch)(node.probeUrl,{method:'POST',headers:{Authorization:`Bearer ${node.grant}`,'Content-Type':'application/json'},body:JSON.stringify({type:'offer',sdp:localSdp}),credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
  const answer=await response.json() as RTCSessionDescriptionInit;if(!response.ok||answer.type!=='answer'||typeof answer.sdp!=='string')throw new Error('invalid quality probe answer');await abortable(peer.setRemoteDescription(answer),controller.signal);
  if(channel.readyState!=='open')await waitUntil(channel,'open',controller.signal,deadline-now(),()=>channel!.readyState==='open',()=>channel!.readyState==='closed');
  const connected=now()-started;sampleStarted=now();
  while(sent<options.maxPackets&&now()-sampleStarted<=options.sampleDurationMs){const sentUs=BigInt(Math.max(0,Math.floor(now()*1000))),packet=qualityPacket(sent,sentUs),copy=new Uint8Array(packet);payloads.set(sent,copy);channel.send(packet);sent++;await sleep(options.packetIntervalMs,controller.signal);}
  const duration=Math.min(options.lifetimeMs,now()-sampleStarted);if(parent.aborted)throw new DOMException('质量探测已取消','AbortError');
  return qualityMetrics(node.nodeId,sent,duration,[...echoes.entries()].sort((a,b)=>a[0]-b[0]).map(entry=>entry[1]),connected);
 }catch(error){if(parent.aborted)throw error;return {nodeId:node.nodeId,outcome:controller.signal.aborted?'timeout':'network_error',sent,received:0,sampleDurationMs:Math.max(0,Math.min(5000,now()-sampleStarted))};}
 finally{clearTimeout(timer);parent.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cleanup);cleanup();}
}

/** S69: until this wall-clock time the quality probe is skipped (server said enabled:false). */
let qualityProbesPausedUntil=0;
/** Test hook. */
export function resetQualityProbePause(){qualityProbesPausedUntil=0;}
/** Runs only after the HTTPS probe has enrolled this exact network generation. */
export async function measureRelayQuality(api:ProbeAPI,networkGeneration:string,signal:AbortSignal,deps:Dependencies={}):Promise<'measured'|'unavailable'>{
 const now=Date.now;
 if(now()<qualityProbesPausedUntil)return 'unavailable';
 let options:QualityOptions;
 try{
  const raw=await api<QualityOptions|{enabled:false;retryAfterMs?:number}>('/media/quality-probes/options',{networkGeneration},undefined,{signal,timeoutMs:6000});
  // S69: Control 关着开关时回 200 {enabled:false, retryAfterMs}，按它停探，不当成配置无效。
  if((raw as {enabled?:unknown}).enabled===false){const wait=Number((raw as {retryAfterMs?:unknown}).retryAfterMs);qualityProbesPausedUntil=now()+(Number.isFinite(wait)&&wait>0?Math.min(wait,86_400_000):3_600_000);return 'unavailable';}
  options=validateOptions(raw as QualityOptions,networkGeneration);
 }catch(error){if(code(error)==='MEDIA_QUALITY_UNAVAILABLE')return 'unavailable';throw error;}
 if(signal.aborted)throw new DOMException('质量探测已取消','AbortError');
 const runner=deps.measureNode??((node,value,current)=>measureNode(node,value,current,deps));
 const samples=await Promise.all(options.nodes.map(node=>runner(node,options,signal)));
 if(signal.aborted)throw new DOMException('质量探测已取消','AbortError');
 const result=await api<{accepted:number}>('/media/quality-probes/results',{networkGeneration,samples},undefined,{signal,timeoutMs:6000});
 if(result.accepted!==samples.length)throw new Error('中继质量结果未被完整确认');return 'measured';
}
