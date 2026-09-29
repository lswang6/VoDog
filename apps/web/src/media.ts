import {audioOwnership} from './audio-ownership.ts';
import {AudioQualityMonitor,diagAudioStats} from './media-quality.ts';
import {diag} from './diag.ts';
import {errorCode,shouldRetryTls} from './media-policy.ts';
type MediaRequestOptions={signal?:AbortSignal;timeoutMs?:number};
type MediaAPI=<T>(path:string,body?:unknown,method?:string,options?:MediaRequestOptions)=>Promise<T>;
type Transport='udp'|'tls';
type Authorize=(callId:string,api:MediaAPI,transport:Transport,signal:AbortSignal,rejoin?:boolean)=>Promise<RTCConfiguration>;
type MediaDependencies={
 authorize?:Authorize;
 getUserMedia?:(constraints:MediaStreamConstraints)=>Promise<MediaStream>;
 createPeer?:(configuration:RTCConfiguration)=>RTCPeerConnection;
 createAudio?:()=>HTMLAudioElement;
 remoteStream?:(track:MediaStreamTrack)=>MediaStream;
 audioCodecs?:()=>RTCRtpCodec[]|undefined;
 window?:Pick<Window,'addEventListener'|'removeEventListener'>;
 connection?:EventTarget;
 iceTimeoutMs?:number;
 connectedTimeoutMs?:number;
 disconnectGraceMs?:number;
 /** S70d：媒体断开时立即让仪表盘拉一次 `/calls`，对端挂断不必等下一次 2 s 轮询；只刷新，不结束通话。 */
 onMediaDrop?:()=>void;
 /** S73 D7：整腿重连开始/结束（true = 显示「网络波动，正在重新连接…」）。 */
 onReconnecting?:(active:boolean)=>void;
 rejoinBackoffMs?:number;
 rejoinSpacingMs?:number;
 rejoinNetworkRetryMs?:number;
};

/** S73 D3：最多 3 次、自首次断线起 60 s；冲突（旧腿仍 Connected）退避 2 s；其他失败距上次开始至少 15 s 再试。都计入次数（S73c：断网时的失败除外）。 */
export const REJOIN_MAX_ATTEMPTS=3,REJOIN_WINDOW_MS=60000,REJOIN_CONFLICT_BACKOFF_MS=2000,REJOIN_SPACING_MS=15000;
/** S73d：重连期间网络切换打断的尝试按断网处理：不计次数、不换传输，约 1 s 后重试，仍受 60 s 窗口约束。 */
export const REJOIN_NETWORK_RETRY_MS=1000;
/**
 * S73 跨端规则：失败的重连尝试之后等多久再试；null = 不再重连，走原失败路径。
 * 409 或 Control 包装的 503 MEDIA_BRIDGE_UNAVAILABLE = 桥上旧腿仍 Connected → 退避；其他 4xx（鉴权/撤销/不存在）→ 停。
 */
export function rejoinRetryDelay(error:unknown,sinceAttemptStartMs:number,{backoffMs=REJOIN_CONFLICT_BACKOFF_MS,spacingMs=REJOIN_SPACING_MS}={}):number|null{
 const status=(error as {status?:number}|null)?.status;
 if(status===409||errorCode(error)==='MEDIA_BRIDGE_UNAVAILABLE')return backoffMs;
 if(status!==undefined&&status>=400&&status<500)return null;
 return Math.max(0,spacingMs-sinceAttemptStartMs);
}
/** S73 D3：第 attempt 次（从 1 起）重连用的传输；第 from 次用 base，之后与 base 互换 UDP↔TLS；用尽次数或窗口返回 null。
 * S73h：本轮断过网时，恢复在线后的首次尝试以 UDP 为 base、from=当时的 attempt。 */
export function rejoinTransport(attempt:number,elapsedMs:number,base:Transport,from=1):Transport|null{
 if(attempt>REJOIN_MAX_ATTEMPTS||elapsedMs>=REJOIN_WINDOW_MS)return null;
 return attempt>from?(base==='udp'?'tls':'udp'):base;
}

/** S73c：只认浏览器明确报告的离线（Node/旧浏览器没有 onLine 时按在线处理）。 */
const isOffline=()=>(globalThis.navigator as Navigator|undefined)?.onLine===false;

/** S73d：重连不测节点——房间节点已由 Control 固定（call.media_node_id），networkGeneration 只为满足接口，服务端此时不看它。 */
async function defaultAuthorize(callId:string,api:MediaAPI,transport:Transport,signal:AbortSignal,rejoin=false):Promise<RTCConfiguration>{
 const [{authorizeMedia},{measureMediaNodes}]=await Promise.all([import('./media-policy'),import('./media-probe')]);
 return authorizeMedia(callId,api,transport,signal,rejoin?async()=>crypto.randomUUID():measureMediaNodes);
}

async function bounded<T>(operation:Promise<T>,signal:AbortSignal,timeoutMs:number,message:string,onLateValue?:(value:T)=>void):Promise<T>{
 return await new Promise<T>((resolve,reject)=>{
  let settled=false;
  const finish=(action:()=>void)=>{if(settled)return false;settled=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);action();return true;};
  const onAbort=()=>finish(()=>reject(new DOMException('媒体连接已取消','AbortError')));
  const timer=setTimeout(()=>finish(()=>reject(new Error(message))),timeoutMs);
  signal.addEventListener('abort',onAbort,{once:true});
  operation.then(value=>{if(!finish(()=>resolve(value)))try{onLateValue?.(value);}catch{/* Late cleanup is best effort. */}},error=>{finish(()=>reject(error));});
  if(signal.aborted)onAbort();
 });
}

/** Relay-stage failures (before any offer reaches the bridge) carry a code so the UDP→TLS retry can tell them apart. */
const relayError=(message:string,code:string)=>Object.assign(new Error(message),{code});

function cancelled(signal:AbortSignal){if(signal.aborted)throw new DOMException('媒体连接已取消','AbortError');}

/** Opus target bitrate for every VoDog offer (S20 D1); a separate constant so the bitrate and the DTX removal roll back independently. */
export const OPUS_MAX_AVERAGE_BITRATE=32000;
/** The single Opus fmtp contract shared by Web, iOS, Android and the Go bridge. No `usedtx`: DTX silence breaks the Pixel playout buffer. */
/** S70: both gateways decode at ≤16 kHz, so the encoders stay wideband; separate so it rolls back alone (S20 invariant 5). */
export const OPUS_WIDEBAND_LIMIT='maxplaybackrate=16000;sprop-maxcapturerate=16000';
const OPUS_FMTP_PARAMETERS=`minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=${OPUS_MAX_AVERAGE_BITRATE};${OPUS_WIDEBAND_LIMIT}`;

/**
 * Forces the Opus fmtp line of an offer, whatever the browser proposed.
 *
 * Chrome offers `minptime=10;useinbandfec=1`, Firefox offers `maxplaybackrate=48000;stereo=1;useinbandfec=1`
 * and some builds offer no fmtp line at all, so the payload type comes from `a=rtpmap:<pt> opus/48000/2`
 * and the whole line is replaced (or inserted). Offers without Opus are returned untouched.
 */
export function rewriteOpusOffer(sdp:string):string{
 const lines=sdp.split('\n');
 let payload='',rtpIndex=-1;
 for(let index=0;index<lines.length;index++){
  const match=/^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?$/i.exec(lines[index]!.replace(/\r$/,''));
  if(match){payload=match[1]!;rtpIndex=index;break;}
 }
 if(!payload)return sdp;
 const line=`a=fmtp:${payload} ${OPUS_FMTP_PARAMETERS}${lines[rtpIndex]!.endsWith('\r')?'\r':''}`;
 const fmtpIndex=lines.findIndex(candidate=>candidate.replace(/\r$/,'').startsWith(`a=fmtp:${payload} `));
 if(fmtpIndex>=0)lines[fmtpIndex]=line;else lines.splice(rtpIndex+1,0,line);
 return lines.join('\n');
}

/** Time granted after the first relay candidate so a second interface's candidate can join the offer (S20 D3). */
export const RELAY_SETTLE_MS=1000;

/** Relay candidates already written into the local description, for candidates gathered before this wait attached. */
function relayCandidateLines(sdp:string|null|undefined):number{
 if(!sdp)return 0;
 return sdp.split('\n').filter(line=>line.startsWith('a=candidate:')&&/ typ relay(\s|\r?$)/.test(line)).length;
}

/**
 * Waits until the relay candidates are good enough to post the offer, instead of waiting for gathering to complete.
 *
 * iOS (S18) and Android (S19) proved that `iceGatheringState` may never reach `complete` when TURN allocations on
 * IMS/VPN tunnels never finish, so `complete` is only an early exit here: the offer leaves one settle window after
 * the first relay candidate, and the cap posts whatever arrived rather than waiting the full budget.
 *
 * Under `iceTransportPolicy:'relay'` a gathering that completed without a single relay candidate can never connect,
 * so it fails immediately instead of posting a candidate-less offer and waiting out the connection budget.
 */
export async function waitForRelayCandidates(peer:RTCPeerConnection,signal:AbortSignal,{settleMs=RELAY_SETTLE_MS,capMs}:{settleMs?:number;capMs:number}):Promise<number>{
 if(peer.iceGatheringState==='complete'){
  const gathered=relayCandidateLines(peer.localDescription?.sdp);
  if(gathered)return gathered;
  throw relayError('未取得中继候选','NO_RELAY_CANDIDATE');
 }
 return await new Promise<number>((resolve,reject)=>{
  let settled=false,relayCandidates=0,settleTimer:ReturnType<typeof setTimeout>|undefined;
  const gatheredRelay=()=>relayCandidates>0||relayCandidateLines(peer.localDescription?.sdp)>0;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(capTimer);clearTimeout(settleTimer);signal.removeEventListener('abort',aborted);peer.removeEventListener('icecandidate',gathered);peer.removeEventListener('icegatheringstatechange',changed);peer.removeEventListener('connectionstatechange',failed);error?reject(error):resolve(Math.max(relayCandidates,relayCandidateLines(peer.localDescription?.sdp)));};
  const gathered=(event:Event)=>{if((event as RTCPeerConnectionIceEvent).candidate?.type!=='relay')return;if(++relayCandidates>1)return;settleTimer=setTimeout(()=>finish(),settleMs);};
  const changed=()=>{if(peer.iceGatheringState==='complete')finish(gatheredRelay()?undefined:relayError('未取得中继候选','NO_RELAY_CANDIDATE'));};
  const failed=()=>{if(peer.connectionState==='failed'||peer.connectionState==='closed')finish(relayError('音频网络连接失败','ICE_FAILED'));};
  const aborted=()=>finish(new DOMException('媒体连接已取消','AbortError'));
  const capTimer=setTimeout(()=>finish(gatheredRelay()?undefined:relayError('音频网络连接超时','ICE_TIMEOUT')),capMs);
  signal.addEventListener('abort',aborted,{once:true});peer.addEventListener('icecandidate',gathered);peer.addEventListener('icegatheringstatechange',changed);peer.addEventListener('connectionstatechange',failed);
  if(signal.aborted)aborted();
 });
}

async function waitForConnected(peer:RTCPeerConnection,signal:AbortSignal,timeoutMs:number):Promise<void>{
 if(peer.connectionState==='connected')return;
 await new Promise<void>((resolve,reject)=>{
  let settled=false;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);peer.removeEventListener('connectionstatechange',changed);error?reject(error):resolve();};
  const changed=()=>{if(peer.connectionState==='connected')finish();else if(peer.connectionState==='failed'||peer.connectionState==='closed')finish(new Error('通话音频连接失败'));};
  const aborted=()=>finish(new DOMException('媒体连接已取消','AbortError'));
  const timer=setTimeout(()=>finish(new Error('通话音频连接超时')),timeoutMs);
  signal.addEventListener('abort',aborted,{once:true});peer.addEventListener('connectionstatechange',changed);
  if(signal.aborted)aborted();
 });
}

export class CallMedia {
 private quality?:AudioQualityMonitor;
 private qualityCallId?:string;
 private callId?:string;
 private statsTimer?:ReturnType<typeof setInterval>;
 private audioOwner?:symbol;
 private peer?:RTCPeerConnection;
 private stream?:MediaStream;
 private output?:HTMLAudioElement;
 private generation=0;
 private operation?:AbortController;
 private disconnectTimer?:ReturnType<typeof setTimeout>;
 private api?:MediaAPI;
 private transport:Transport='udp';
 private rejoins=0;
 private rejoining?:symbol;
 private readonly onFailure:(message:string)=>void;
 private readonly dependencies:MediaDependencies;
 constructor(onFailure:(message:string)=>void,dependencies:MediaDependencies={}){this.onFailure=onFailure;this.dependencies=dependencies;}
 private fail(message:string){const callId=this.callId;this.stop();diag.log('media.failed',{message},callId);this.onFailure(message);}
 /** One automatic UDP→TLS retry, only for relay-stage failures: the first offer never reached the bridge, so no 409. */
 async start(callId:string,api:MediaAPI,transport:Transport='udp'):Promise<void>{
  try{await this.attempt(callId,api,transport);}
  catch(error){
   if(isOffline()||!shouldRetryTls(error,transport))return this.setupOffline(error,callId,transport);
   diag.log('media.retry_tls',{code:errorCode(error)},callId);
   try{await this.attempt(callId,api,'tls');}catch(tlsError){return this.setupOffline(tlsError,callId,'tls');}
  }
 }
 /** S73e：首次建立时断网失败（attempt 已只拆腿、保留 callId/麦克风）→ 走 S73 重连循环：等 online、断网不计次、60 s 窗口；在线失败照旧抛出。 */
 private async setupOffline(error:unknown,callId:string,transport:Transport):Promise<void>{
  if(this.callId!==callId)throw error;
  if(!isOffline()){this.stop();throw error;}
  this.transport=transport;await this.rejoin('setup_offline');
 }
 /** S73 D3：已建立的通话断线后关旧 PC、重跑 options+offer；麦克风流（静音与设备）和播放元素保留。用尽才走原失败路径。 */
 private async rejoin(reason:string,downSince=performance.now()){
  const callId=this.callId,api=this.api,token=Symbol('rejoin'),first=performance.now();
  const downMs=()=>Math.round(performance.now()-downSince);// S75：本次断线（首次 disconnected 起）总时长；ms 仍是单次尝试
  if(!callId||!api||this.rejoining)return;
  this.rejoining=token;this.dependencies.onReconnecting?.(true);
  // S73h：本轮任一时刻离线（发现断线时、任一次失败时、或 setup_offline）→ 恢复在线后的首次尝试改用 UDP，其后从 UDP 起互换。
  let base=this.transport,from=1,wentOffline=reason==='setup_offline'||isOffline();
  let needsProbe=false;// S73g：重连（含 setup_offline）一律跳过测节点；Control 回 409 MEDIA_PROBE_REQUIRED（节点未固定）时本轮下一次测节点
  const deadline=setTimeout(()=>{if(this.rejoining===token)this.operation?.abort();},REJOIN_WINDOW_MS);
  try{
   const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
   const target=this.dependencies.window??window;
   // S73c：断网期间失败不计次数、不换传输；等 online 事件（兜底每 500 ms 查一次）立即重试，仍受首次断线起 60 s 窗口约束。
   const waitOnline=()=>new Promise<void>(resolve=>{
    const done=()=>{clearInterval(poll);clearTimeout(cap);target.removeEventListener('online',done);resolve();};
    const poll=setInterval(()=>{if(!isOffline()||this.rejoining!==token)done();},500);
    const cap=setTimeout(done,Math.max(0,REJOIN_WINDOW_MS-(performance.now()-first)));
    target.addEventListener('online',done);
   });
   for(let attempt=1;;){
    if(wentOffline&&!isOffline()){base='udp';from=attempt;wentOffline=false;}
    const transport=rejoinTransport(attempt,performance.now()-first,base,from);
    if(!transport){this.fail('通话音频连接已中断');return;}
    const began=performance.now(),probe=needsProbe;
    try{
     await this.attempt(callId,api,transport,true,probe);
     if(this.rejoining!==token)return;
     this.rejoins++;diag.log('media.rejoin',{attempt,reason,transport,ms:Math.round(performance.now()-began),downMs:downMs(),ok:true,probeSkipped:!probe},callId);
     this.rejoining=undefined;this.dependencies.onReconnecting?.(false);return;
    }catch(error){
     if(this.rejoining!==token)return;
     const offline=isOffline();
     diag.log('media.rejoin',{attempt,reason,transport,ms:Math.round(performance.now()-began),downMs:downMs(),ok:false,probeSkipped:!probe,code:errorCode(error)??(error as {status?:number}).status,message:String(error).slice(0,300),...(offline?{offline:true}:{})},callId);
     if(offline){wentOffline=true;await waitOnline();if(this.rejoining!==token)return;continue;}
     if(!probe&&errorCode(error)==='MEDIA_PROBE_REQUIRED'){needsProbe=true;continue;}// 不计次数、不换传输，立即带测节点重试
     if(errorCode(error)==='NETWORK_CHANGED'){await sleep(this.dependencies.rejoinNetworkRetryMs??REJOIN_NETWORK_RETRY_MS);if(this.rejoining!==token)return;continue;}
     attempt++;
     const delay=rejoinRetryDelay(error,performance.now()-began,{backoffMs:this.dependencies.rejoinBackoffMs,spacingMs:this.dependencies.rejoinSpacingMs});
     if(delay===null){this.fail('通话音频连接已中断');return;}
     await sleep(delay);
     if(this.rejoining!==token)return;
    }
   }
  }finally{clearTimeout(deadline);}
 }
 private async attempt(callId:string,api:MediaAPI,transport:Transport,rejoin=false,probe=!rejoin):Promise<void>{
  if(rejoin)this.closeLeg();else{this.stop();this.audioOwner=audioOwnership.beginCall();}
  const generation=this.generation,operation=new AbortController();this.operation=operation;this.callId=callId;this.api=api;
  const began=performance.now();let offerAt=0,stage='options';
  const browserWindow=this.dependencies.window??window;
  const connection=this.dependencies.connection??(navigator as Navigator&{connection?:EventTarget}).connection;
  type AuthorizationAttempt={controller:AbortController;networkChanged:boolean;allocationStarted:boolean};
  let authorization:AuthorizationAttempt|undefined;
  const offline=()=>operation.abort();
  let networkFlap=false;
  const networkChanged=()=>{const current=authorization;if(current&&!current.allocationStarted){current.networkChanged=true;current.controller.abort();}else{networkFlap=true;operation.abort();}};
  browserWindow.addEventListener('offline',offline);connection?.addEventListener('change',networkChanged);
  try{
   const authorize=this.dependencies.authorize??defaultAuthorize,allocationPath=`/calls/${callId}/media/options`;
   let rtcConfiguration:RTCConfiguration|undefined;
   for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController(),current:AuthorizationAttempt={controller,networkChanged:false,allocationStarted:false};authorization=current;
    const rootAbort=()=>controller.abort();operation.signal.addEventListener('abort',rootAbort,{once:true});if(operation.signal.aborted)rootAbort();
    const authorizeApi:MediaAPI=async(path,body,method,options={})=>{
     if(authorization!==current||operation.signal.aborted||controller.signal.aborted)throw new DOMException('媒体连接已取消','AbortError');
     if(path===allocationPath)current.allocationStarted=true;
     return api(path,body,method,{...options,signal:controller.signal});
    };
    try{const candidate=await authorize(callId,authorizeApi,transport,controller.signal,!probe);if(controller.signal.aborted||current.networkChanged||operation.signal.aborted)throw new DOMException('媒体连接已取消','AbortError');rtcConfiguration=candidate;break;}
    catch(error){if(!(current.networkChanged&&!current.allocationStarted&&!operation.signal.aborted&&attempt===0))throw error;}
    finally{operation.signal.removeEventListener('abort',rootAbort);if(authorization===current)authorization=undefined;}
   }
   if(!rtcConfiguration)throw new Error('通话网络测量未完成');
   diag.log('media.options',{ms:Math.round(performance.now()-began),transport},callId);
   cancelled(operation.signal);if(generation!==this.generation)return;stage='microphone';
   const getUserMedia=this.dependencies.getUserMedia??(constraints=>navigator.mediaDevices.getUserMedia(constraints));
   const stream=rejoin&&this.stream?this.stream:await bounded(getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}),operation.signal,15000,'等待麦克风权限超时',late=>late.getTracks().forEach(track=>track.stop()));
   if(generation!==this.generation||operation.signal.aborted){if(stream!==this.stream)stream.getTracks().forEach(t=>t.stop());return;}
   this.stream=stream;stage='relay';
   const peer=(this.dependencies.createPeer??(configuration=>new RTCPeerConnection(configuration)))(rtcConfiguration);this.peer=peer;
   const output=this.output??(this.dependencies.createAudio??(()=>new Audio()))();output.autoplay=true;this.output=output;
   peer.ontrack=event=>{if(generation!==this.generation)return;output.srcObject=(this.dependencies.remoteStream??(track=>new MediaStream([track])))(event.track);event.track.onended=()=>{if(generation===this.generation)this.fail('对方音频已中断');};void output.play().catch(()=>{if(generation===this.generation)this.fail('浏览器未能播放对方声音，请检查音频权限后重试');});};
   // S36 C3: ms 是发出 offer 之后的毫秒数；offer 之前的状态变化按开始起算。
   peer.oniceconnectionstatechange=()=>{if(generation!==this.generation)return;diag.setCall(callId,peer.iceConnectionState);diag.log('media.ice',{state:peer.iceConnectionState,ms:Math.round(performance.now()-(offerAt||began))},callId);};
   let established=false,downAt:number|undefined;
   peer.onconnectionstatechange=()=>{
    if(generation!==this.generation)return;
    if(peer.connectionState==='failed'){if(established)void this.rejoin('failed',downAt);else if(!rejoin&&!isOffline())this.fail('通话音频连接失败');return;}
    if(peer.connectionState==='disconnected'){
     this.dependencies.onMediaDrop?.();downAt??=performance.now();
     clearTimeout(this.disconnectTimer);this.disconnectTimer=setTimeout(()=>{if(generation===this.generation&&peer.connectionState==='disconnected'){if(established)void this.rejoin('disconnected',downAt);else if(!rejoin&&!isOffline())this.fail('通话音频连接已中断');}},this.dependencies.disconnectGraceMs??5000);
    }else{clearTimeout(this.disconnectTimer);if(peer.connectionState==='connected')downAt=undefined;}
   };
   for(const track of stream.getAudioTracks()){
    const transceiver=peer.addTransceiver(track,{direction:'sendrecv',streams:[stream]});
    const opus=(this.dependencies.audioCodecs??(()=>RTCRtpSender.getCapabilities('audio')?.codecs))()?.filter(c=>c.mimeType.toLowerCase()==='audio/opus');
    if(!opus?.length)throw new Error('当前浏览器不支持 Opus 音频');
    transceiver.setCodecPreferences(opus);
   }
   const offer=await bounded(peer.createOffer(),operation.signal,6000,'创建音频连接超时');
   if(offer.sdp)offer.sdp=rewriteOpusOffer(offer.sdp);
   await bounded(peer.setLocalDescription(offer),operation.signal,6000,'设置本地音频超时');
   const relayCandidates=await waitForRelayCandidates(peer,operation.signal,{settleMs:RELAY_SETTLE_MS,capMs:this.dependencies.iceTimeoutMs??12000});
   diag.log('media.relay_candidates',{count:relayCandidates,ms:Math.round(performance.now()-began)},callId);
   cancelled(operation.signal);if(generation!==this.generation)return;
   offerAt=performance.now();stage='offer';diag.log('media.offer',{ms:Math.round(offerAt-began)},callId);
   const answer=await api<RTCSessionDescriptionInit>(`/calls/${callId}/media/offer`,{type:'offer',sdp:peer.localDescription!.sdp},undefined,{signal:operation.signal,timeoutMs:8000});
   diag.log('media.answer',{ms:Math.round(performance.now()-offerAt)},callId);stage='connect';
   cancelled(operation.signal);if(generation!==this.generation)return;
   await bounded(peer.setRemoteDescription(answer),operation.signal,6000,'设置远端音频超时');
   await waitForConnected(peer,operation.signal,this.dependencies.connectedTimeoutMs??12000);
   if(generation!==this.generation)return;
   established=true;this.transport=transport;
   if(generation===this.generation&&typeof peer.getStats==='function'){this.qualityCallId=callId;this.quality=new AudioQualityMonitor(peer);this.quality.start();
    this.statsTimer=setInterval(()=>{void peer.getStats().then(report=>diag.log('media.stats',diagAudioStats(report),callId)).catch(()=>{/* 诊断读数失败不影响通话。 */});},30000);}
  }catch(error){if(generation===this.generation){if(rejoin)this.closeLeg();else{if(isOffline())this.closeLeg();else this.stop();diag.log('media.failed',{stage,transport,message:String(error).slice(0,300),...(isOffline()?{offline:true}:{})},callId);}}
   throw rejoin&&networkFlap?Object.assign(new Error('重连期间网络切换'),{code:'NETWORK_CHANGED'}):error;}
  finally{authorization?.controller.abort();authorization=undefined;browserWindow.removeEventListener('offline',offline);connection?.removeEventListener('change',networkChanged);if(this.operation===operation)this.operation=undefined;}
 }
 get hasMicrophone():boolean{return Boolean(this.stream?.getAudioTracks().some(track=>track.readyState!=='ended'));}
 setMuted(muted:boolean):boolean{
  const tracks=this.stream?.getAudioTracks()??[];
  if(!tracks.length)return false;
  for(const track of tracks)track.enabled=!muted;
  return true;
 }
 /** S73：只拆当前腿（PC、计时器、质量监测）；麦克风、播放与音频归属留给重连。 */
 private closeLeg(){
  this.quality?.stop();this.quality=undefined;
  this.generation++;this.operation?.abort();this.operation=undefined;clearTimeout(this.disconnectTimer);this.disconnectTimer=undefined;clearInterval(this.statsTimer);this.statsTimer=undefined;
  const peer=this.peer;this.peer=undefined;
  if(peer){peer.ontrack=null;peer.onconnectionstatechange=null;peer.oniceconnectionstatechange=null;try{peer.close();}catch{/* A failed peer may throw on close. */}}
 }
 stop(){
  if(this.quality){const quality=this.quality,samples=quality.stop();try{console.info('VoDog audio quality',{callId:this.qualityCallId,samples});}catch{/* Logging cannot prevent cleanup. */}
   // S70: concealment and rx/tx leave the browser, from the last 2 s sample (a closed peer has no stats).
   diag.log('media.summary',{samples:samples.length,rejoins:this.rejoins,...(quality.lastRxTx??{rx:{},tx:{}})},this.qualityCallId);
   this.quality=undefined;this.qualityCallId=undefined;}
  else if(this.rejoining&&this.callId)diag.log('media.summary',{samples:0,rejoins:this.rejoins,rx:{},tx:{}},this.callId);
  if(this.rejoining){this.rejoining=undefined;this.dependencies.onReconnecting?.(false);}
  this.rejoins=0;this.api=undefined;
  this.closeLeg();this.callId=undefined;
  const cleanup=(action:()=>void)=>{try{action();}catch{/* Attempt every owned resource even if another has already failed. */}};
  const stream=this.stream,output=this.output;this.stream=undefined;this.output=undefined;
  stream?.getTracks().forEach(track=>cleanup(()=>track.stop()));
  if(output){cleanup(()=>output.pause());cleanup(()=>{output.srcObject=null;});}
  if(this.audioOwner){audioOwnership.endCall(this.audioOwner);this.audioOwner=undefined;}
 }
}
