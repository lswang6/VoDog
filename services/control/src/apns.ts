import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
export type ApnsResult={status:number;reason?:string};
export type BadgePush={token:string;environment:'development'|'production';badge:number};
export type VoipPush={token:string;environment:'development'|'production';callId:string;notificationId:string;contactName?:string|null;remoteNumber?:string|null;internal?:boolean;peerSimLabel?:string|null;simLabel?:string|null};
/** S21 §A: owner-visible text travels bounded and control-character free (name, and since S36 C1 the number). */
const boundedText=(value:unknown)=>{
 if(typeof value!=='string')return null;
 const trimmed=value.replace(/[\x00-\x1f\x7f]/g,'').trim();
 return trimmed?trimmed.slice(0,64):null;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ApnsClient {
 private key:KeyObject;
 private cached?:{jwt:string;created:number};
 constructor(private keyId:string,private teamId:string,pem:string,private connector:(url:string)=>ClientHttp2Session=connect){
  if(!/^[A-Z0-9]{10}$/.test(keyId)||!/^[A-Z0-9]{10}$/.test(teamId))throw new Error('Invalid APNs identifiers');
  this.key=createPrivateKey(pem);
  if(this.key.asymmetricKeyType!=='ec'||this.key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error('APNs requires a P-256 private key');
 }
 private jwt(){
  const now=Math.floor(Date.now()/1000);
  if(this.cached&&now-this.cached.created<1800)return this.cached.jwt;
  const head=Buffer.from(JSON.stringify({alg:'ES256',kid:this.keyId})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:this.teamId,iat:now})).toString('base64url');
  const unsigned=head+'.'+body;
  const signature=sign('sha256',Buffer.from(unsigned),{key:this.key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const jwt=unsigned+'.'+signature;this.cached={jwt,created:now};return jwt;
 }
 async sendIncoming(push:VoipPush):Promise<ApnsResult>{
  if(!/^[0-9a-f]{32,512}$/i.test(push.token)||!uuid.test(push.callId)||!uuid.test(push.notificationId))throw new Error('Invalid APNs push');
  // Message contents never travel. The contact name (S21 §A) feeds CXCallUpdate.localizedCallerName
  // and the number (S36 C1) its remoteHandle; both are omitted when unknown.
  const contactName=boundedText(push.contactName),remoteNumber=boundedText(push.remoteNumber);
  // S72: an internal call carries `internal` and the calling SIM's label. S81: every call carries the called SIM's label.
  const peerSimLabel=push.internal?boundedText(push.peerSimLabel):null,simLabel=boundedText(push.simLabel);
  return this.post(push.token,push.environment,{'apns-topic':'org.vodog.voip','apns-push-type':'voip','apns-expiration':'0','apns-priority':'10','apns-collapse-id':push.callId,'apns-id':push.notificationId},
   {aps:{'content-available':1},version:1,event:'call.incoming',callId:push.callId,...(contactName?{contactName}:{}),...(remoteNumber?{remoteNumber}:{}),...(simLabel?{simLabel}:{}),...(push.internal?{internal:true,...(peerSimLabel?{peerSimLabel}:{})}:{})});
 }
 /** S67: app-icon badge on the regular (non-VoIP) token; no alert, no sound. */
 async sendBadge(push:BadgePush):Promise<ApnsResult>{
  if(!/^[0-9a-f]{32,512}$/i.test(push.token)||!Number.isInteger(push.badge)||push.badge<0)throw new Error('Invalid APNs badge push');
  return this.post(push.token,push.environment,{'apns-topic':'org.vodog','apns-push-type':'alert','apns-priority':'10','apns-collapse-id':'badge'},{aps:{badge:push.badge}});
 }
 private post(token:string,environment:'development'|'production',headers:Record<string,string>,payload:unknown):Promise<ApnsResult>{
  const host=environment==='development'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  return new Promise((resolve,reject)=>{
   const client=this.connector(host);let settled=false;let response='';let status=0;
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timeout);client.destroy();if(error)reject(new Error('APNs connection failed'));else {let reason:string|undefined;try{const value=JSON.parse(response);if(typeof value.reason==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value.reason))reason=value.reason;}catch{}resolve({status,reason});}};
   const timeout=setTimeout(()=>finish(new Error('timeout')),8000);timeout.unref();client.once('error',finish);
   const request=client.request({':method':'POST',':path':'/3/device/'+token,'authorization':'bearer '+this.jwt(),...headers,'content-type':'application/json'});
   request.on('response',headers=>{status=Number(headers[':status']);});
   request.setEncoding('utf8');request.on('data',chunk=>{response+=chunk;if(response.length>4096)finish(new Error('oversized response'));});
   request.once('error',finish);request.once('end',()=>finish());
   request.end(JSON.stringify(payload));
  });
 }
}
