/** One tab's call audio and recording playback must never compete. */
export class AudioOwnership {
 private calls=new Set<symbol>();
 private players=new Set<()=>void>();
 private listeners=new Set<()=>void>();
 readonly isCallActive=()=>this.calls.size>0;
 readonly subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 registerPlayer(stop:()=>void){this.players.add(stop);if(this.isCallActive())stop();return()=>{this.players.delete(stop);};}
 stopRecordings(){for(const stop of [...this.players]){try{stop();}catch{/* Always clean up the remaining players. */}}}
 beginCall(){const owner=Symbol('call-audio');this.calls.add(owner);this.stopRecordings();this.changed();return owner;}
 endCall(owner:symbol){if(this.calls.delete(owner))this.changed();}
 private changed(){for(const listener of [...this.listeners]){try{listener();}catch{/* A stale view cannot retain another audio owner. */}}}
}
export const audioOwnership=new AudioOwnership();
