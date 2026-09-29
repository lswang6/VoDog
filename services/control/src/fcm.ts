import type {FcmAccessTokenProvider} from './fcm-credentials.js';

export type FcmEvent='call.incoming'|'call.cancelled';
export type FcmPush={token:string;event:FcmEvent;callId:string;notificationId:string;contactName?:string|null;remoteNumber?:string|null};
/** S21 §A: owner-visible text travels bounded and control-character free (name, and since S36 C1 the number). */
const boundedText=(value:unknown)=>{
  if(typeof value!=='string')return null;
  const trimmed=value.replace(/[\x00-\x1f\x7f]/g,'').trim();
  return trimmed?trimmed.slice(0,64):null;
};
export type FcmBadgePush={token:string;notificationId:string;badge:number;calls:number;sms:number};
export type FcmResult={status:number;reason?:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FcmClient {
  // S36 C1: an Android client older than the `remoteNumber` key drops the whole push, so the key
  // only travels once `FCM_PUSH_REMOTE_NUMBER` is turned on behind the shipped client.
  constructor(private projectId:string,private credentials:FcmAccessTokenProvider,private fetcher:typeof fetch=fetch,private includeRemoteNumber=false){
    if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))throw new Error('Invalid FCM project ID');
  }
  async send(push:FcmPush,signal?:AbortSignal):Promise<FcmResult>{
    if(push.token.length<32||push.token.length>4096||/[\x00-\x1f\x7f]/.test(push.token)||!uuid.test(push.callId)||!uuid.test(push.notificationId)||!['call.incoming','call.cancelled'].includes(push.event))throw new Error('Invalid FCM push');
    // The contact name (S21 §A) and, when enabled, the number (S36 C1) are the only owner content here.
    return this.post({token:push.token,data:{version:'1',event:push.event,callId:push.callId,notificationId:push.notificationId,
      ...(boundedText(push.contactName)?{contactName:boundedText(push.contactName)!}:{}),
      ...(this.includeRemoteNumber&&boundedText(push.remoteNumber)?{remoteNumber:boundedText(push.remoteNumber)!}:{})},android:{priority:'HIGH',ttl:'30s'}},signal);
  }
  /** S67: counts only, collapsed so a device offline for a while gets just the latest value. */
  async sendBadge(push:FcmBadgePush,signal?:AbortSignal):Promise<FcmResult>{
    const counts=[push.badge,push.calls,push.sms];
    if(push.token.length<32||push.token.length>4096||/[\x00-\x1f\x7f]/.test(push.token)||!uuid.test(push.notificationId)||!counts.every(n=>Number.isInteger(n)&&n>=0))throw new Error('Invalid FCM push');
    return this.post({token:push.token,data:{version:'1',event:'badge.update',notificationId:push.notificationId,badge:String(push.badge),calls:String(push.calls),sms:String(push.sms)},
      android:{priority:'NORMAL',ttl:'86400s',collapse_key:'badge'}},signal);
  }
  private async post(message:unknown,signal?:AbortSignal):Promise<FcmResult>{
    const timeout=AbortSignal.timeout(8000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    const accessToken=await this.credentials.getAccessToken(combined);
    const response=await this.fetcher(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,{
      method:'POST',redirect:'error',signal:combined,
      headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},
      body:JSON.stringify({message}),
    });
    const raw=await readBounded(response,16_384);
    if(response.ok)return {status:response.status};
    return {status:response.status,reason:reasonFrom(raw)};
  }
}

async function readBounded(response:Response,limit:number){
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('FCM response exceeds limit');chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}
function reasonFrom(raw:string){
  try{
    const error=JSON.parse(raw)?.error;
    const fcm=Array.isArray(error?.details)?error.details.find((item:any)=>typeof item?.errorCode==='string')?.errorCode:undefined;
    const candidate=fcm??error?.status;
    return typeof candidate==='string'&&/^[A-Z0-9_]{1,80}$/.test(candidate)?candidate:undefined;
  }catch{return undefined;}
}
