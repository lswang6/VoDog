import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {MediaProbeGrantIssuer,selectMediaNode,type MediaNodeSelection,type MediaProbeNode,type MediaProbeSample} from './media-probes.js';

const generationSchema=z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/);
const sampleSchema=z.object({nodeId:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),outcome:z.enum(['ok','timeout','network_error']),httpsRttMs:z.number().finite().min(0).max(10_000).optional()}).superRefine((value,ctx)=>{if(value.outcome==='ok'&&value.httpsRttMs===undefined)ctx.addIssue({code:'custom',message:'Successful probes require httpsRttMs'});if(value.outcome!=='ok'&&value.httpsRttMs!==undefined)ctx.addIssue({code:'custom',message:'Failed probes cannot include httpsRttMs'});});

type SubjectEvidence={generation:string;allowed:Set<string>;samples:MediaProbeSample[];expiresAtMs:number};
export class MediaProbeEvidenceError extends Error { constructor(public readonly code:'PROBE_OPTIONS_REQUIRED'|'PROBE_CAPACITY'|'PROBE_NODE_INVALID'){super(code);} }

/** Bounded, process-local probe evidence. Restart deliberately loses evidence. */
export class MediaProbeCoordinator {
  private readonly issuer:MediaProbeGrantIssuer;
  private readonly configuredNodeIds:string[];
  private readonly subjects=new Map<string,SubjectEvidence>();
  constructor(private readonly options:{nodes:MediaProbeNode[];defaultNodeId:string;now?:()=>number;ttlMs?:number;maxSubjects?:number}) {
    this.issuer=new MediaProbeGrantIssuer(options.nodes);this.configuredNodeIds=options.nodes.map(node=>node.id);
    if(!this.configuredNodeIds.includes(options.defaultNodeId))throw new Error('Default node requires a public probe URL');
    if((options.ttlMs??120_000)<30_000||(options.ttlMs??120_000)>600_000||(options.maxSubjects??4096)<1||(options.maxSubjects??4096)>100_000)throw new Error('Invalid media probe evidence bounds');
  }
  private now(){return this.options.now?.()??Date.now();}
  private cleanup(){const now=this.now();for(const [key,value] of this.subjects)if(value.expiresAtMs<=now)this.subjects.delete(key);}
  optionsFor(subjectKey:string,subjectHash:string,generation:string){
    this.cleanup();const now=this.now(),existing=this.subjects.get(subjectKey);
    if(!existing&&this.subjects.size>=(this.options.maxSubjects??4096))throw new MediaProbeEvidenceError('PROBE_CAPACITY');
    const expiresAtMs=now+(this.options.ttlMs??120_000);
    this.subjects.set(subjectKey,{generation,allowed:new Set(this.configuredNodeIds),samples:existing?.generation===generation?existing.samples:[],expiresAtMs});
    const nodes=this.configuredNodeIds.map(nodeId=>this.issuer.issue({nodeId,subjectHash,networkGeneration:generation,count:3,nowMs:now}));
    return {networkGeneration:generation,expiresAt:new Date(expiresAtMs).toISOString(),nodes};
  }
  submit(subjectKey:string,generation:string,rawSamples:{nodeId:string;outcome:'ok'|'timeout'|'network_error';httpsRttMs?:number}[]){
    this.cleanup();const evidence=this.subjects.get(subjectKey);if(!evidence||evidence.generation!==generation)throw new MediaProbeEvidenceError('PROBE_OPTIONS_REQUIRED');
    if(rawSamples.some(sample=>!evidence.allowed.has(sample.nodeId)))throw new MediaProbeEvidenceError('PROBE_NODE_INVALID');
    const now=this.now(),additions=rawSamples.map(sample=>({...sample,networkGeneration:generation,measuredAtMs:now}));
    // Prepending makes a new same-millisecond batch newer than retained data.
    evidence.samples=[...additions,...evidence.samples].sort((a,b)=>b.measuredAtMs-a.measuredAtMs).slice(0,64);evidence.expiresAtMs=now+(this.options.ttlMs??120_000);
    return {accepted:rawSamples.length,expiresAt:new Date(evidence.expiresAtMs).toISOString()};
  }
  select(input:{userSubjectKey:string;clientNetworkGeneration:string;gatewaySubjectKey:string;fixedNodeId?:string|null}):MediaNodeSelection{
    this.cleanup();const user=this.subjects.get(input.userSubjectKey),gateway=this.subjects.get(input.gatewaySubjectKey);
    if(!user||user.generation!==input.clientNetworkGeneration)throw new MediaProbeEvidenceError('PROBE_OPTIONS_REQUIRED');
    const gatewayReachableNodeIds=gateway?qualifiedNodes(gateway.samples,this.now(),this.options.ttlMs??120_000):[];
    return selectMediaNode({configuredNodeIds:this.configuredNodeIds,defaultNodeId:this.options.defaultNodeId,gatewayReachableNodeIds,clientSamples:user.samples,clientNetworkGeneration:input.clientNetworkGeneration,nowMs:this.now(),fixedNodeId:input.fixedNodeId});
  }
  /**
   * S73b: true only when fresh evidence for this subject (matching `generation` when given) holds samples
   * for the node and most of its latest <=3 are not OK. Absent, expired, other-generation or node-less
   * evidence is "not failed". ponytail: HTTPS evidence only; relay-quality samples are not consulted.
   */
  nodeFailed(subjectKey:string,nodeId:string,generation?:string){
    this.cleanup();const evidence=this.subjects.get(subjectKey);
    if(!evidence||(generation!==undefined&&evidence.generation!==generation))return false;
    const now=this.now(),maxAge=this.options.ttlMs??120_000;
    const latest=evidence.samples.filter(s=>s.nodeId===nodeId&&s.measuredAtMs<=now&&now-s.measuredAtMs<=maxAge).sort((a,b)=>b.measuredAtMs-a.measuredAtMs).slice(0,3);
    return latest.filter(s=>s.outcome!=='ok').length*2>latest.length;
  }
  hasGatewayEvidence(subjectKey:string){this.cleanup();return this.subjects.has(subjectKey);}
}

function qualifiedNodes(samples:MediaProbeSample[],now:number,maxAgeMs:number){
  const fresh=samples.filter(sample=>sample.measuredAtMs<=now&&now-sample.measuredAtMs<=maxAgeMs);
  return [...new Set(fresh.map(sample=>sample.nodeId))].filter(nodeId=>{const latest=fresh.filter(sample=>sample.nodeId===nodeId).sort((a,b)=>b.measuredAtMs-a.measuredAtMs).slice(0,3);const ok=latest.filter(sample=>sample.outcome==='ok').length;return ok>=2&&ok*3>=latest.length*2;});
}

export type MediaProbeRouteAuth={
  requireUser(req:FastifyRequest):{userId:string;sessionId:string};
  requireGateway(req:FastifyRequest):Promise<{gatewayId:string;deviceEpoch:number}>|{gatewayId:string;deviceEpoch:number};
  mutationOrigin(req:FastifyRequest):void;
  subjectHash(value:string):string;
  fail(status:number,code:string,message:string):never;
};

export function registerMediaProbeRoutes(app:FastifyInstance,coordinator:MediaProbeCoordinator|null,auth:MediaProbeRouteAuth){
  const bodySchema=z.object({networkGeneration:generationSchema});
  const resultsSchema=z.object({networkGeneration:generationSchema,samples:z.array(sampleSchema).min(1).max(48)});
  const requireCoordinator=()=>{if(!coordinator)auth.fail(503,'MEDIA_PROBES_UNAVAILABLE','Media node probes are not configured');return coordinator as MediaProbeCoordinator;};
  const mapError=(error:unknown):never=>{if(error instanceof MediaProbeEvidenceError){if(error.code==='PROBE_OPTIONS_REQUIRED')auth.fail(409,error.code,'Probe options are required for the current network generation');if(error.code==='PROBE_NODE_INVALID')auth.fail(400,error.code,'Probe result contains an unavailable node');auth.fail(429,error.code,'Probe evidence capacity is full');}throw error;};
  app.post('/api/v1/media/probes/options',async req=>{const user=auth.requireUser(req);auth.mutationOrigin(req);const body=bodySchema.parse(req.body);try{return requireCoordinator().optionsFor(`user:${user.sessionId}`,auth.subjectHash(`user:${user.sessionId}`),body.networkGeneration);}catch(error){return mapError(error);}});
  app.post('/api/v1/media/probes/results',async req=>{const user=auth.requireUser(req);auth.mutationOrigin(req);const body=resultsSchema.parse(req.body);try{return requireCoordinator().submit(`user:${user.sessionId}`,body.networkGeneration,body.samples);}catch(error){return mapError(error);}});
  app.post('/api/v1/gateway/media/probes/options',async req=>{const gateway=await auth.requireGateway(req);const body=bodySchema.parse(req.body);try{return requireCoordinator().optionsFor(`gateway:${gateway.gatewayId}:${gateway.deviceEpoch}`,auth.subjectHash(`gateway:${gateway.gatewayId}:${gateway.deviceEpoch}`),body.networkGeneration);}catch(error){return mapError(error);}});
  app.post('/api/v1/gateway/media/probes/results',async req=>{const gateway=await auth.requireGateway(req);const body=resultsSchema.parse(req.body);try{return requireCoordinator().submit(`gateway:${gateway.gatewayId}:${gateway.deviceEpoch}`,body.networkGeneration,body.samples);}catch(error){return mapError(error);}});
}
