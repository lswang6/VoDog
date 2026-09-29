/**
 * Dial-pad key feedback tone (DTMF).
 *
 * The browser dialpad plays the same DTMF pair a phone emits for the pressed key, so typing a number feels like a
 * phone. "+" is not a DTMF digit and stays silent, matching the iOS and Android dialpads.
 */
export const DTMF_FREQUENCIES:Record<string,[number,number]>={
 '1':[697,1209],'2':[697,1336],'3':[697,1477],
 '4':[770,1209],'5':[770,1336],'6':[770,1477],
 '7':[852,1209],'8':[852,1336],'9':[852,1477],
 '*':[941,1209],'0':[941,1336],'#':[941,1477],
};
const TONE_SECONDS=0.12,ATTACK_SECONDS=0.006,RELEASE_SECONDS=0.01,PEAK_GAIN=0.09;

export function dtmfToneFrequencies(key:string):[number,number]|null{return DTMF_FREQUENCIES[key]??null;}

type AudioContextConstructor=new()=>AudioContext;

function audioContextConstructor():AudioContextConstructor|null{
 const scope=globalThis as unknown as {AudioContext?:AudioContextConstructor;webkitAudioContext?:AudioContextConstructor};
 return scope.AudioContext??scope.webkitAudioContext??null;
}

export class DialTone{
 private context:AudioContext|null=null;
 private enabled=true;
 get supported():boolean{return audioContextConstructor()!==null;}
 /** Key tones can be silenced without changing the dialpad itself. */
 setEnabled(enabled:boolean){this.enabled=enabled;}
 /** Plays one key's tone; returns false when the key has no DTMF pair or the browser cannot produce audio. */
 play(key:string):boolean{
  const frequencies=dtmfToneFrequencies(key);
  if(!frequencies||!this.enabled||!this.supported)return false;
  try{
   const context=this.context??(this.context=new (audioContextConstructor()!)());
   if(context.state==='suspended')void context.resume();
   const start=context.currentTime,end=start+TONE_SECONDS;
   const gain=context.createGain();
   gain.gain.setValueAtTime(0,start);
   gain.gain.linearRampToValueAtTime(PEAK_GAIN,start+ATTACK_SECONDS);
   gain.gain.setValueAtTime(PEAK_GAIN,end-RELEASE_SECONDS);
   gain.gain.linearRampToValueAtTime(0,end);
   gain.connect(context.destination);
   for(const frequency of frequencies){
    const oscillator=context.createOscillator();
    oscillator.type='sine';
    oscillator.frequency.setValueAtTime(frequency,start);
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(end);
    oscillator.onended=()=>gain.disconnect();
   }
   return true;
  }catch{return false;}
 }
}

export const dialTone=new DialTone();
