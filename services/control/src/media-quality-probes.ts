import {createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {MediaProbeCoordinator,MediaProbeEvidenceError} from './media-probe-routes.js';
import {MediaProbeGrantIssuer,type MediaProbeNode,type MediaNodeSelection} from './media-probes.js';
const relayTurnUrl=z.string().regex(/^turn:[A-Za-z0-9.-]+:\d+\?transport=udp$/);

export type QualityNode=MediaProbeNode&{turnUdpUrl:string;turnSecret:string};
const generation=z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/);
export const qualitySampleSchema=z.object({
  nodeId:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  outcome:z.enum(['ok','timeout','network_error']),
  sent:z.number().int().min(0).max(250),received:z.number().int().min(0).max(250),
  connectionMs:z.number().finite().min(0).max(5000).optional(),
  rttMedianMs:z.number().finite().min(0).max(5000).optional(),
  rttP95Ms:z.number().finite().min(0).max(5000).optional(),
  // Successive echo RTT difference, not RTP jitter or an audio-quality measurement.
  jitterMs:z.number().finite().min(0).max(5000).optional(),
  sampleDurationMs:z.number().finite().min(0).max(5000),
}).strict().superRefine((s,c)=>{
  if(s.received>s.sent)c.addIssue({code:'custom',message:'Received count exceeds sent count'});
  if(s.outcome==='ok'&&(s.sent<20||s.received<1||s.sampleDurationMs<2000||s.connectionMs===undefined||s.rttMedianMs===undefined||s.rttP95Ms===undefined||s.jitterMs===undefined||s.rttP95Ms<s.rttMedianMs))c.addIssue({code:'custom',message:'Successful relay samples require complete bounded measurements'});
  if(s.outcome!=='ok'&&(s.rttMedianMs!==undefined||s.rttP95Ms!==undefined||s.jitterMs!==undefined))c.addIssue({code:'custom',message:'Failed relay samples cannot claim RTT quality'});
});
export type QualitySample=z.infer<typeof qualitySampleSchema>;
type Evidence={generation:string;expires:number;samples:Map<string,QualitySample>};
type SelectionInput=Parameters<MediaProbeCoordinator['select']>[0];

export class MediaQualityProbeCoordinator extends MediaProbeCoordinator {
  private readonly qualityNodes:QualityNode[];
  private readonly current=new Map<string,{generation:string;expires:number}>();
  private readonly evidence=new Map<string,Evidence>();
  private readonly prior=new Map<string,{nodeId:string;expires:number}>();
  constructor(private readonly settings:{nodes:QualityNode[];defaultNodeId:string;enabled?:boolean;now?:()=>number;ttlMs?:number;maxSubjects?:number}){
    super(settings);new MediaProbeGrantIssuer(settings.nodes);
    this.qualityNodes=settings.nodes.map(n=>{
      if(n.turnSecret.length<32)throw new Error('Quality TURN secret missing');
      return {...n,turnUdpUrl:relayTurnUrl.parse(n.turnUdpUrl)};
    });
  }
  private qualityNow(){return this.settings.now?.()??Date.now();}
  get enabled(){return this.settings.enabled===true;}
  private prune(){const now=this.qualityNow();for(const[k,v]of this.current)if(v.expires<=now)this.current.delete(k);for(const[k,v]of this.prior)if(v.expires<=now)this.prior.delete(k);}
  private requireCurrent(subject:string,networkGeneration:string){this.prune();if(this.current.get(subject)?.generation!==networkGeneration)throw new MediaProbeEvidenceError('PROBE_OPTIONS_REQUIRED');}
  override optionsFor(subjectKey:string,subjectHash:string,networkGeneration:string){
    this.prune();
    if(!this.current.has(subjectKey)&&this.current.size>=(this.settings.maxSubjects??4096))throw new MediaProbeEvidenceError('PROBE_CAPACITY');
    const result=super.optionsFor(subjectKey,subjectHash,networkGeneration);
    this.current.set(subjectKey,{generation:networkGeneration,expires:this.qualityNow()+(this.settings.ttlMs??120000)});
    const quality=this.evidence.get(subjectKey);
    if(quality&&quality.generation!==networkGeneration)this.evidence.delete(subjectKey);
    return result;
  }
  qualityOptions(subjectKey:string,subjectHash:string,networkGeneration:string,role:'client'|'gateway'){
    generation.parse(networkGeneration);
    this.requireCurrent(subjectKey,networkGeneration);
    if(!/^[A-Za-z0-9_-]{16,64}$/.test(subjectHash)||!subjectKey.startsWith(role==='client'?'user:':'gateway:'))throw new Error('Invalid quality probe subject');
    this.prune();const now=this.qualityNow(),old=this.evidence.get(subjectKey);
    if(!old&&this.evidence.size>=(this.settings.maxSubjects??4096))throw new MediaProbeEvidenceError('PROBE_CAPACITY');
    this.evidence.set(subjectKey,{generation:networkGeneration,expires:old?.generation===networkGeneration&&old.expires>now?old.expires:now+(this.settings.ttlMs??120000),samples:old?.generation===networkGeneration&&old.expires>now?old.samples:new Map()});
    return {networkGeneration,measurement:'relay_data_channel_echo_v1',lifetimeMs:5000,sampleDurationMs:2000,packetIntervalMs:20,maxPackets:250,maxPacketBytes:512,iceTransportPolicy:'relay',nodes:this.qualityNodes.map(n=>{
      const exp=Math.floor(now/1000)+30;
      const claim={purpose:'media-webrtc-probe-v1',method:'POST',path:'/webrtc-probe/offer',nodeId:n.id,subjectHash,networkGeneration,role,exp,nonce:randomBytes(24).toString('base64url')};
      const payload=Buffer.from(JSON.stringify(claim)).toString('base64url');
      const username=`${Math.floor(now/1000)+60}:quality-${randomBytes(8).toString('hex')}`;
      return {nodeId:n.id,probeUrl:new URL('/webrtc-probe/offer',n.probeUrl).toString(),expiresAt:new Date(exp*1000).toISOString(),grant:payload+'.'+createHmac('sha256',n.secret).update(payload).digest('base64url'),iceServers:[{urls:[n.turnUdpUrl],username,credential:createHmac('sha1',n.turnSecret).update(username).digest('base64')}]};
    })};
  }
  qualitySubmit(subjectKey:string,networkGeneration:string,samples:QualitySample[]){
    generation.parse(networkGeneration);this.requireCurrent(subjectKey,networkGeneration);const parsed=z.array(qualitySampleSchema).min(1).max(16).parse(samples);
    if(new Set(parsed.map(s=>s.nodeId)).size!==parsed.length)throw new Error('Duplicate quality node');
    this.prune();const evidence=this.evidence.get(subjectKey);
    if(!evidence||evidence.generation!==networkGeneration||evidence.expires<=this.qualityNow())throw new MediaProbeEvidenceError('PROBE_OPTIONS_REQUIRED');
    if(parsed.some(s=>!this.qualityNodes.some(n=>n.id===s.nodeId)))throw new MediaProbeEvidenceError('PROBE_NODE_INVALID');
    for(const s of parsed)evidence.samples.set(s.nodeId,s);
    // Submitting cannot prolong the options lifetime or revive old network evidence.
    return {accepted:parsed.length,expiresAt:new Date(evidence.expires).toISOString()};
  }
  override select(input:SelectionInput):MediaNodeSelection{
    if(input.fixedNodeId)return this.qualityNodes.some(n=>n.id===input.fixedNodeId)?{nodeId:input.fixedNodeId,reason:'fixed_for_call'}:{nodeId:null,reason:'fixed_node_unavailable'};
    if(!this.enabled)return super.select(input);
    this.prune();const user=this.evidence.get(input.userSubjectKey),gateway=this.evidence.get(input.gatewaySubjectKey);
    // Enrollment is per current winning session. A newer Gateway must not break old clients.
    if(!user||user.generation!==input.clientNetworkGeneration)return super.select(input);
    const currentUser=user.expires>this.qualityNow()&&this.current.get(input.userSubjectKey)?.generation===user.generation?user:undefined;
    const currentGateway=gateway&&gateway.expires>this.qualityNow()&&this.current.get(input.gatewaySubjectKey)?.generation===gateway.generation?gateway:undefined;
    if(!currentUser?.samples.size||!currentGateway?.samples.size)return {nodeId:null,reason:'no_common_quality_node'};
    const score=(s:QualitySample)=>s.rttP95Ms!+s.jitterMs!*2+(1-s.received/s.sent)*2000+s.connectionMs!*.05;
    const candidates=this.qualityNodes.flatMap(n=>{
      const a=currentUser.samples.get(n.id),b=currentGateway.samples.get(n.id);
      if(!a||!b||a.outcome!=='ok'||b.outcome!=='ok'||a.received/a.sent<.8||b.received/b.sent<.8)return [];
      return [{nodeId:n.id,scoreMs:score(a)+score(b)}];
    }).sort((a,b)=>a.scoreMs-b.scoreMs||a.nodeId.localeCompare(b.nodeId));
    const best=candidates[0];if(!best)return {nodeId:null,reason:'no_common_quality_node'};
    const key=[input.userSubjectKey,currentUser.generation,input.gatewaySubjectKey,currentGateway.generation].join('|');
    const old=this.prior.get(key),incumbent=candidates.find(n=>n.nodeId===old?.nodeId);
    const keep=incumbent&&incumbent.scoreMs-best.scoreMs<Math.max(25,incumbent.scoreMs*.15);
    const selected=keep?incumbent:best;
    if(!this.prior.has(key)&&this.prior.size>=(this.settings.maxSubjects??4096))this.prior.delete(this.prior.keys().next().value!);
    this.prior.set(key,{nodeId:selected.nodeId,expires:Math.min(currentUser.expires,currentGateway.expires)});
    return {...selected,reason:keep&&selected.nodeId!==best.nodeId?'quality_hysteresis':'measured_relay_quality'};
  }
}
