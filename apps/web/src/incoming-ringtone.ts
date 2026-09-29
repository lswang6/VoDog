/**
 * Incoming-call ringtone. Dual-tone 440+480 Hz (US ring), ~2s on / 4s off, looping until stop().
 * Separate from DialTone (DTMF). Not an AudioOwnership participant.
 */
export const RING_FREQUENCIES:[number,number]=[440,480];
export const RING_ON_SECONDS=2;
export const RING_OFF_SECONDS=4;
const ATTACK_SECONDS=0.012,RELEASE_SECONDS=0.03,PEAK_GAIN=0.12;

type AudioContextConstructor=new()=>AudioContext;

function audioContextConstructor():AudioContextConstructor|null{
 const scope=globalThis as unknown as {AudioContext?:AudioContextConstructor;webkitAudioContext?:AudioContextConstructor};
 return scope.AudioContext??scope.webkitAudioContext??null;
}

export class IncomingRingtone{
 private readonly Context:AudioContextConstructor|null;
 private context:AudioContext|null=null;
 private muted=false;
 private enabled=true;
 private desired=false;
 private ringing=false;
 private unlockNeeded=false;
 private starting=false;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private nodes:{oscillator:OscillatorNode;gain:GainNode}[]=[];
 private readonly listeners=new Set<()=>void>();
 constructor(Context?:AudioContextConstructor|null){
  this.Context=Context===undefined?audioContextConstructor():Context;
 }
 get supported():boolean{return this.Context!==null;}
 get needsUnlock():boolean{return this.unlockNeeded;}
 get isRinging():boolean{return this.ringing;}
 readonly subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 setMuted(muted:boolean){
  this.muted=muted;
  if(muted)this.haltSound();
  else if(this.desired)void this.tryStart();
  this.notify();
 }
 setEnabled(enabled:boolean){
  this.enabled=enabled;
  if(!enabled)this.haltSound();
  else if(this.desired)void this.tryStart();
  this.notify();
 }
 /** Resume a suspended context (call from a user gesture). Retries start when ringing was blocked. */
 unlock(){void this.tryUnlock();}
 /** Begin the ring loop. No-op when muted, disabled, unsupported, or already ringing. */
 start(){
  if(this.muted||!this.enabled||!this.supported||this.ringing)return;
  this.desired=true;
  void this.tryStart();
 }
 /** Stop the loop. Idempotent. */
 stop(){
  this.desired=false;
  this.unlockNeeded=false;
  this.haltSound();
  this.notify();
 }
 private notify(){for(const listener of [...this.listeners]){try{listener();}catch{/* A stale view cannot retain the ringtone. */}}}
 private ensureContext():AudioContext{
  return this.context??(this.context=new this.Context!());
 }
 private async tryUnlock(){
  if(!this.supported)return;
  const context=this.ensureContext();
  if(context.state==='suspended'){
   try{await context.resume();}catch{/* Autoplay may still block. */}
  }
  if(context.state==='suspended'){
   this.unlockNeeded=true;
   this.notify();
   return;
  }
  this.unlockNeeded=false;
  this.notify();
  if(this.desired&&!this.ringing)void this.tryStart();
 }
 private async tryStart(){
  if(!this.desired||this.muted||!this.enabled||!this.supported||this.ringing||this.starting)return;
  this.starting=true;
  try{
   const context=this.ensureContext();
   if(context.state==='suspended'){
    try{await context.resume();}catch{/* Autoplay may still block. */}
   }
   if(!this.desired||this.muted||!this.enabled||this.ringing)return;
   if(context.state==='suspended'){
    this.unlockNeeded=true;
    this.notify();
    return;
   }
   this.unlockNeeded=false;
   this.ringing=true;
   this.notify();
   this.playBurst();
  }catch{
   this.unlockNeeded=true;
   this.notify();
  }finally{this.starting=false;}
 }
 private playBurst(){
  if(!this.desired||!this.ringing||this.muted||!this.enabled||!this.context)return;
  const context=this.context;
  try{
   const start=context.currentTime,end=start+RING_ON_SECONDS;
   const gain=context.createGain();
   gain.gain.setValueAtTime(0,start);
   gain.gain.linearRampToValueAtTime(PEAK_GAIN,start+ATTACK_SECONDS);
   gain.gain.setValueAtTime(PEAK_GAIN,Math.max(start+ATTACK_SECONDS,end-RELEASE_SECONDS));
   gain.gain.linearRampToValueAtTime(0,end);
   gain.connect(context.destination);
   let remaining=RING_FREQUENCIES.length;
   const finished=()=>{
    remaining--;
    if(remaining>0)return;
    this.nodes=this.nodes.filter(node=>node.gain!==gain);
    try{gain.disconnect();}catch{/* Already disconnected by stop(). */}
   };
   for(const frequency of RING_FREQUENCIES){
    const oscillator=context.createOscillator();
    oscillator.type='sine';
    oscillator.frequency.setValueAtTime(frequency,start);
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(end);
    oscillator.onended=finished;
    this.nodes.push({oscillator,gain});
   }
  }catch{
   this.unlockNeeded=true;
   this.ringing=false;
   this.notify();
   return;
  }
  const timer=setTimeout(()=>{
   this.timer=undefined;
   if(this.desired&&this.ringing&&!this.muted&&this.enabled)this.playBurst();
  },(RING_ON_SECONDS+RING_OFF_SECONDS)*1000);
  this.timer=timer;
  if(typeof timer==='object'&&timer&&'unref' in timer)(timer as {unref:()=>void}).unref();
 }
 private haltSound(){
  clearTimeout(this.timer);
  this.timer=undefined;
  const nodes=this.nodes;
  this.nodes=[];
  this.ringing=false;
  for(const {oscillator,gain} of nodes){
   try{oscillator.onended=null;}catch{/* Ignore engines that freeze ended callbacks. */}
   try{oscillator.stop();}catch{/* Already stopped at the burst end. */}
   try{oscillator.disconnect();}catch{/* Already disconnected. */}
   try{gain.disconnect();}catch{/* Already disconnected. */}
  }
 }
}

export const incomingRingtone=new IncomingRingtone();
