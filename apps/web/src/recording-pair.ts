import type {DerivedTrackDescriptor,RecordingDescriptor,RecordingSource,TrackDescriptor,UplinkTrackDescriptor} from './recording-contract';

export type PairTrackDescriptor=TrackDescriptor|DerivedTrackDescriptor|UplinkTrackDescriptor;
export type PlaybackPair={tracks:readonly [PairTrackDescriptor,PairTrackDescriptor];label:string;description:string};

/** 可一起播放的声轨对，第一项是默认。S94：有本机上行轨时默认「对方 + 本机上行」，原声对与补偿对仍保留。 */
export function playbackPairs(recording:RecordingDescriptor,source:RecordingSource):PlaybackPair[]{
 const min=source==='pixel'?44:0,usable=(track:PairTrackDescriptor|undefined):track is PairTrackDescriptor=>Boolean(track&&track.bytes>min);
 const remote=recording.tracks.find(track=>track.id==='remote_original'),caller=recording.tracks.find(track=>track.id==='caller_original');
 const playout=recording.derivedTracks.find(track=>track.id==='caller_playout'),uplink=recording.uplinkTracks.find(track=>track.id==='caller_uplink');
 const pairs:PlaybackPair[]=[];
 if(!usable(remote))return pairs;
 if(source==='pixel'&&usable(uplink))pairs.push({tracks:[remote,uplink],label:'通话双方（含本机接入）',description:'同时播放对方原声与本机上行声音，含机主在本机接入后说的话，可能存在时间偏差。'});
 if(usable(caller))pairs.push({tracks:[remote,caller],label:'双向原声一起播放',description:'同时播放双方原声，可能存在时间偏差。需要核对细节时，可展开原始分轨。'});
 if(source==='pixel'&&usable(playout))pairs.push({tracks:[remote,playout],label:'补偿后双向播放',description:'同时播放对方原声与补偿后的播放声；补偿只用于播放，不改变原声。'});
 return pairs;
}

/** A fresh descriptor array from dashboard polling must not replace a playing pair. */
export function recordingPairIdentity(callId:string,source:RecordingSource,tracks:readonly [PairTrackDescriptor,PairTrackDescriptor]):string{
 return JSON.stringify([callId,source,...tracks.map(track=>track.sourceRole!=='derived_playout'
  ?[track.id,track.sourceRole,track.mediaType,track.bytes,track.sha256,track.captureComplete,track.gapCount,track.droppedFrames]
  :[track.id,track.sourceRole,track.mediaType,track.bytes,track.sha256,track.playoutComplete,track.gapCount,track.recoveryFrames])]);
}

export type PairAudio = {
 currentTime:number;duration:number;ended:boolean;readyState:number;
 play():Promise<void>;pause():void;
 addEventListener(type:string,listener:()=>void):void;removeEventListener(type:string,listener:()=>void):void;
};
export type PairState={playing:boolean;buffering:boolean;currentTime:number;duration:number;error:string};

export function pairContractDurationSeconds(tracks:readonly PairTrackDescriptor[]):number{
 let max=0;
 for(const track of tracks){
  if(typeof track.durationMs==='number'&&Number.isFinite(track.durationMs)&&track.durationMs>0)max=Math.max(max,track.durationMs/1000);
 }
 return max;
}

/** Coordinates two authenticated streaming elements without buffering either recording in JS memory. */
export class RecordingPairController{
 private desired=false;private buffering=false;private disposed=false;private generation=0;private error='';
 private readonly listeners=new Map<string,()=>void>();
 private readonly tracks:readonly [PairAudio,PairAudio];private readonly changed:(state:PairState)=>void;
 private readonly contractDuration:number;
 constructor(tracks:readonly [PairAudio,PairAudio],changed:(state:PairState)=>void,contractDuration=0){
  this.tracks=tracks;this.changed=changed;this.contractDuration=Number.isFinite(contractDuration)&&contractDuration>0?contractDuration:0;
  for(const event of ['loadedmetadata','durationchange','timeupdate','ended','waiting','stalled','canplay','error']){
   const listener=()=>this.event(event);this.listeners.set(event,listener);for(const track of tracks)track.addEventListener(event,listener);
  }
  this.publish();
 }
 state():PairState{
  const elementDuration=Math.max(...this.tracks.map(t=>finite(t.duration)));
  return {playing:this.desired&&!this.buffering,buffering:this.buffering,currentTime:Math.max(...this.tracks.map(t=>finite(t.currentTime))),duration:Math.max(elementDuration,this.contractDuration),error:this.error};
 }
 play(){if(this.disposed)return;if(!this.active().length&&(this.tracks.some(track=>finite(track.duration)>0)||this.contractDuration>0))this.seek(0);this.desired=true;this.buffering=false;this.error='';this.publish();void this.start();}
 pause(){if(this.disposed)return;this.desired=false;this.buffering=false;this.generation++;this.tracks.forEach(track=>track.pause());this.publish();}
 seek(seconds:number){if(this.disposed||!Number.isFinite(seconds)||seconds<0)return;const fallback=this.contractDuration;for(const track of this.tracks){const duration=finite(track.duration)||fallback;track.currentTime=duration?Math.min(seconds,duration):seconds;}this.publish();if(this.desired&&!this.buffering)void this.start();}
 dispose(){if(this.disposed)return;this.pause();this.disposed=true;for(const [event,listener] of this.listeners)for(const track of this.tracks)track.removeEventListener(event,listener);this.listeners.clear();}
 private active(){return this.tracks.filter(track=>{const duration=finite(track.duration);return duration?track.currentTime<duration-.01:!track.ended;});}
 private async start(){const generation=++this.generation,active=this.active();if(!active.length){this.desired=false;this.publish();return;}
  try{await Promise.all(active.map(track=>track.play()));if(generation!==this.generation)return;if(this.disposed||!this.desired)active.forEach(track=>track.pause());}
  catch{if(generation!==this.generation||this.disposed)return;this.desired=false;this.buffering=false;this.tracks.forEach(track=>track.pause());this.publish('双向一起播放失败，可在下方分别播放原始声轨。');}
 }
 private event(event:string){if(this.disposed)return;
  if(event==='error'){this.desired=false;this.buffering=false;this.generation++;this.tracks.forEach(track=>track.pause());this.publish('双向一起播放失败，可在下方分别播放原始声轨。');return;}
  if((event==='waiting'||event==='stalled')&&this.desired){this.buffering=true;this.generation++;this.tracks.forEach(track=>track.pause());this.publish();return;}
  if(event==='canplay'&&this.desired&&this.buffering&&this.active().every(track=>track.readyState>=3)){this.buffering=false;this.publish();void this.start();return;}
  if(event==='timeupdate'&&this.desired&&!this.buffering){const active=this.active();if(active.length===2&&Math.abs(active[0].currentTime-active[1].currentTime)>.25){const leader=Math.max(active[0].currentTime,active[1].currentTime);active.forEach(track=>track.currentTime=leader);}}
  if(event==='ended'&&this.active().length===0){this.desired=false;this.buffering=false;this.generation++;}
  this.publish();
 }
 private publish(error?:string){if(error!==undefined)this.error=error;this.changed(this.state());}
}
function finite(value:number){return Number.isFinite(value)&&value>0?value:0;}
