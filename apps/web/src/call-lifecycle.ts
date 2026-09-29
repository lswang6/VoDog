export type CallEndResponse = {call:{state?:string}};
export type CallEndRequest = (path:string,body:unknown)=>Promise<CallEndResponse>;
type AttemptStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

const releasedStates=new Set(['ending','ended','failed','unknown']);
const terminalStatuses=new Set([401,403,404,409]);

/** Ends only a call originated or claimed by this exact authenticated session. */
export class CurrentSessionCallEnd {
  private readonly active=new Map<string,Promise<void>>();
  private readonly request:CallEndRequest;
  private readonly delays:number[];
  private readonly pause:(milliseconds:number)=>Promise<void>;
  constructor(
    request:CallEndRequest,
    delays:number[]=[0,250,1000],
    pause:(milliseconds:number)=>Promise<void>=(milliseconds)=>new Promise(resolve=>setTimeout(resolve,milliseconds)),
  ){this.request=request;this.delays=delays;this.pause=pause;}
  end(callId:string):Promise<void>{
    const existing=this.active.get(callId);
    if(existing)return existing;
    const operation=this.run(callId).finally(()=>{if(this.active.get(callId)===operation)this.active.delete(callId);});
    this.active.set(callId,operation);
    return operation;
  }
  private async run(callId:string):Promise<void>{
    for(const delay of this.delays){
      if(delay)await this.pause(delay);
      try{
        const response=await this.request(`/calls/${encodeURIComponent(callId)}/end`,{onlyIfCurrentSessionOwner:true});
        if(releasedStates.has(response.call.state||''))return;
      }catch(error){
        const status=typeof error==='object'&&error!==null&&'status' in error?Number(error.status):undefined;
        if(status!==undefined&&terminalStatuses.has(status))return;
      }
    }
  }
}

/** S36 C2: 通话中按键。只发 [0-9*#]；长按 "0" 得到的 "+" 不是 DTMF，直接丢弃而不是让服务端 400。 */
export async function sendDtmfDigit(
  request:(path:string,body:unknown,method:string,options:{timeoutMs:number})=>Promise<unknown>,
  callId:string,key:string,
):Promise<boolean>{
  if(!/^[0-9*#]$/.test(key))return false;
  await request(`/calls/${encodeURIComponent(callId)}/dtmf`,{digits:key},'POST',{timeoutMs:4000});
  return true;
}

export function claimedByThisSession(call:{claimedByCurrentSession?:boolean;state?:string}):boolean{
  return call.claimedByCurrentSession===true&&['connecting','active'].includes(call.state||'');
}

/** A lost successful claim response must be reconciled before leaving an owned call unattended. */
export async function claimWithReconciliation<T extends {claimedByCurrentSession?:boolean;state?:string},R extends {call:T}={call:T}>(
  claim:()=>Promise<R>, detail:()=>Promise<R>,
):Promise<R>{
  for(let attempt=0;attempt<2;attempt++){
    try{return await claim();}catch(error){
      const status=typeof error==='object'&&error!==null&&'status' in error?Number(error.status):undefined;
      if(status!==undefined&&status>=400&&status<500)throw error;
      const snapshot=await detail();
      if(claimedByThisSession(snapshot.call))return snapshot;
      // Reconcile even the final response loss; never retry a different winner.
      if(snapshot.call.state!=='incoming_ringing'||attempt===1)throw error;
    }
  }
  throw new Error('无法确认接听状态');
}

/** Keeps ambiguous call intents across reloads, but never across an explicit new login. */
export class CallAttemptScope {
  private readonly storage:AttemptStorage;
  private readonly newId:()=>string;
  constructor(
    storage:AttemptStorage,
    newId:()=>string=()=>crypto.randomUUID(),
  ){this.storage=storage;this.newId=newId;}
  current():string{
    const existing=this.storage.getItem('vodog:call-session');
    if(existing)return existing;
    const created=this.newId();
    this.storage.setItem('vodog:call-session',created);
    return created;
  }
  rotate():string{
    const created=this.newId();
    this.storage.setItem('vodog:call-session',created);
    return created;
  }
  attemptKey(username:string):string{
    return `vodog:call:${username}:${this.current()}`;
  }
  clear(username:string):void{
    this.storage.removeItem(this.attemptKey(username));
    this.storage.removeItem('vodog:call-session');
  }
}
