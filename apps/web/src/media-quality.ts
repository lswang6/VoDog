/** Numeric audio counters only: never retain SDP, candidates, addresses or credentials. */
export type AudioQualitySample={elapsedMs:number;inbound:Record<string,number>[]};
const fields=['packetsReceived','packetsLost','jitter','concealedSamples','silentConcealedSamples','concealmentEvents','totalSamplesReceived','jitterBufferDelay','jitterBufferEmittedCount','bytesReceived'] as const;
export function audioQualitySample(report:RTCStatsReport,elapsedMs:number):AudioQualitySample{
 const inbound:Record<string,number>[]=[];
 report.forEach(stat=>{
  if(stat.type!=='inbound-rtp'||(stat.kind??stat.mediaType)!=='audio')return;
  const counters:Record<string,number>={};
  for(const key of fields)if(typeof stat[key]==='number'&&Number.isFinite(stat[key]))counters[key]=stat[key];
  inbound.push(counters);
 });
 return {elapsedMs:Math.max(0,Math.round(elapsedMs)),inbound};
}
const num=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export type AudioRxTx={rx:Record<string,number>;tx:Record<string,number>};
/** S70：通话接收/发送质量计数（inbound-rtp / outbound-rtp audio），进 30 s `media.stats` 与通话结束 `media.summary`。 */
export function audioRxTx(report:RTCStatsReport):AudioRxTx{
 const rx:Record<string,number>={},tx:Record<string,number>={};
 report.forEach(stat=>{
  if((stat.kind??stat.mediaType)!=='audio')return;
  if(stat.type==='inbound-rtp'){
   for(const key of ['packetsReceived','packetsLost','concealedSamples','silentConcealedSamples','totalSamplesReceived','concealmentEvents','insertedSamplesForDeceleration','removedSamplesForAcceleration'] as const)if(num(stat[key]))rx[key]=stat[key];
   if(num(stat.jitter))rx.jitterMs=Math.round(stat.jitter*1000*10)/10;
   if(num(stat.jitterBufferDelay)&&num(stat.jitterBufferEmittedCount)&&stat.jitterBufferEmittedCount>0)rx.jitterBufferMs=Math.round(stat.jitterBufferDelay/stat.jitterBufferEmittedCount*1000*10)/10;
  }
  if(stat.type==='outbound-rtp')for(const key of ['packetsSent','bytesSent'] as const)if(num(stat[key]))tx[key]=stat[key];
 });
 return {rx,tx};
}
/** S36 C3：诊断只留几个数字——够判断一通电话的音频好坏，不留任何地址或凭据。S70 追加 `rx`/`tx`。 */
export function diagAudioStats(report:RTCStatsReport):Record<string,unknown>{
 const stats:Record<string,unknown>=audioRxTx(report);
 report.forEach(stat=>{
  if(stat.type==='inbound-rtp'&&(stat.kind??stat.mediaType)==='audio'){
   for(const key of ['packetsLost','jitter','audioLevel'] as const)if(typeof stat[key]==='number'&&Number.isFinite(stat[key]))stats[key]=stat[key];
  }
  if(stat.type==='candidate-pair'&&stat.nominated&&typeof stat.currentRoundTripTime==='number'&&Number.isFinite(stat.currentRoundTripTime))stats.rtt=stat.currentRoundTripTime;
 });
 return stats;
}
/** One in-flight read, bounded memory, and no late result after disposal. */
export class AudioQualityMonitor{
 private timer?:ReturnType<typeof setInterval>;
 private pending=false;
 private stopped=false;
 private readonly started=performance.now();
 readonly samples:AudioQualitySample[]=[];
 /** S70：最近一次读数的 rx/tx，通话结束时进 `media.summary`（关闭后的 peer 读不到统计）。 */
 lastRxTx?:AudioRxTx;
 private readonly peer:Pick<RTCPeerConnection,'getStats'>;
 private readonly intervalMs:number;
 constructor(peer:Pick<RTCPeerConnection,'getStats'>,intervalMs=2000){this.peer=peer;this.intervalMs=intervalMs;}
 start(){if(this.timer||this.stopped)return;void this.sample();this.timer=setInterval(()=>{void this.sample();},this.intervalMs);}
 async sample(){
  if(this.pending||this.stopped)return;
  this.pending=true;
  try{const report=await this.peer.getStats();if(!this.stopped){this.lastRxTx=audioRxTx(report);this.samples.push(audioQualitySample(report,performance.now()-this.started));if(this.samples.length>180)this.samples.shift();}}
  catch{/* Diagnostics must never interrupt a call. */}
  finally{this.pending=false;}
 }
 stop(){this.stopped=true;clearInterval(this.timer);this.timer=undefined;return this.samples.map(sample=>({elapsedMs:sample.elapsedMs,inbound:sample.inbound.map(row=>({...row}))}));}
}
