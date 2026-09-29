export type CallLivenessSnapshot={mediaEpoch:number;revision:number;expiresAt:string};
export type CallLivenessAPI=<T>(path:string,body?:unknown,method?:string,options?:{signal?:AbortSignal;timeoutMs?:number})=>Promise<T>;
type Timer=ReturnType<typeof setTimeout>;

export class WebCallLiveness{
 private generation=0;
 private timer?:Timer;
 private operation?:AbortController;
 private activeCallId:string|null=null;
 private snapshot?:CallLivenessSnapshot;
 private readonly onLost:(callId:string,message:string)=>void;
 private readonly intervalMs:number;
 constructor(onLost:(callId:string,message:string)=>void,intervalMs=5000){this.onLost=onLost;this.intervalMs=intervalMs;}
 get callId(){return this.activeCallId;}
 start(callId:string,snapshot:CallLivenessSnapshot,api:CallLivenessAPI){
  this.stop();this.activeCallId=callId;this.snapshot=this.validate(snapshot);const generation=this.generation;
  this.schedule(generation,api,0);
 }
 stop(){this.generation++;clearTimeout(this.timer);this.timer=undefined;this.operation?.abort();this.operation=undefined;this.activeCallId=null;this.snapshot=undefined;}
 private validate(value:CallLivenessSnapshot){
  if(!Number.isSafeInteger(value.mediaEpoch)||value.mediaEpoch<1||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isFinite(Date.parse(value.expiresAt)))throw new Error('通话存活租约无效');
  return value;
 }
 private schedule(generation:number,api:CallLivenessAPI,delay=this.intervalMs){
  if(generation!==this.generation||!this.activeCallId)return;
  this.timer=setTimeout(()=>void this.beat(generation,api),delay);
 }
 private async beat(generation:number,api:CallLivenessAPI){
  const callId=this.activeCallId,current=this.snapshot;if(generation!==this.generation||!callId||!current)return;
  const controller=new AbortController();this.operation=controller;let answered=false;
  try{
   try{
    const result=await api<{liveness:CallLivenessSnapshot}>(`/calls/${encodeURIComponent(callId)}/liveness`,{mediaEpoch:current.mediaEpoch,expectedRevision:current.revision},'PUT',{signal:controller.signal,timeoutMs:4000});
    if(generation!==this.generation)return;this.snapshot=this.validate(result.liveness);
   }catch(error){
    if(generation!==this.generation||controller.signal.aborted)return;
    const detail=await api<{liveness:CallLivenessSnapshot|null}>(`/calls/${encodeURIComponent(callId)}`,undefined,'GET',{signal:controller.signal,timeoutMs:4000});
    if(generation!==this.generation)return;answered=true;
    if(!detail.liveness||detail.liveness.mediaEpoch!==current.mediaEpoch)throw error;
    this.snapshot=this.validate(detail.liveness);
   }
   this.schedule(generation,api);
  }catch{
   if(generation!==this.generation||controller.signal.aborted)return;
   // S73 D7：连不上 Control（断网、媒体正在重连）时租约未到期就 1 s 后再试；Control 明确说租约没了或本地租约已过期才结束。
   if(!answered&&Date.now()<Date.parse(current.expiresAt)){this.schedule(generation,api,1000);return;}
   this.stop();this.onLost(callId,'无法确认通话连接，正在安全结束通话');
  }finally{if(this.operation===controller)this.operation=undefined;}
 }
}
