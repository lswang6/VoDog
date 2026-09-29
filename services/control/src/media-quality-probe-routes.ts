import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {MediaProbeEvidenceError,type MediaProbeRouteAuth} from './media-probe-routes.js';
import {MediaQualityProbeCoordinator,qualitySampleSchema} from './media-quality-probes.js';

export function registerMediaQualityProbeRoutes(app:FastifyInstance,coordinator:MediaQualityProbeCoordinator|null,auth:MediaProbeRouteAuth){
  const body=z.object({networkGeneration:z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/)}).strict();
  const results=body.extend({samples:z.array(qualitySampleSchema).min(1).max(16)}).superRefine((v,c)=>{if(new Set(v.samples.map(s=>s.nodeId)).size!==v.samples.length)c.addIssue({code:'custom',message:'Duplicate quality node'});});
  const selected=()=>coordinator?.enabled?coordinator:auth.fail(503,'MEDIA_QUALITY_UNAVAILABLE','Relay quality probes are not configured');
  function mapError(error:unknown):never{
    if(error instanceof MediaProbeEvidenceError){
      if(error.code==='PROBE_OPTIONS_REQUIRED')auth.fail(409,error.code,'Quality options are required for the current network');
      if(error.code==='PROBE_NODE_INVALID')auth.fail(400,error.code,'Quality result node is not configured');
      auth.fail(429,error.code,'Quality probe capacity is full');
    }throw error;
  }
  for(const role of ['client','gateway'] as const){
    const base=role==='client'?'/api/v1/media/quality-probes':'/api/v1/gateway/media/quality-probes';
    app.post(`${base}/options`,async req=>{
      let subject:string;
      if(role==='client'){const user=auth.requireUser(req);auth.mutationOrigin(req);subject=`user:${user.sessionId}`;}
      else {const gateway=await auth.requireGateway(req);subject=`gateway:${gateway.gatewayId}:${gateway.deviceEpoch}`;}
      const parsed=body.parse(req.body);
      try{return selected().qualityOptions(subject,auth.subjectHash(subject),parsed.networkGeneration,role);}catch(error){return mapError(error);}
    });
    app.post(`${base}/results`,async req=>{
      let subject:string;
      if(role==='client'){const user=auth.requireUser(req);auth.mutationOrigin(req);subject=`user:${user.sessionId}`;}
      else {const gateway=await auth.requireGateway(req);subject=`gateway:${gateway.gatewayId}:${gateway.deviceEpoch}`;}
      const parsed=results.parse(req.body);
      try{return selected().qualitySubmit(subject,parsed.networkGeneration,parsed.samples);}catch(error){return mapError(error);}
    });
  }
}
