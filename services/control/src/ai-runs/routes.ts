import {createHash,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {Config} from '../config.js';
import type {Db} from '../db.js';
import {MediaNodeNotFoundError,MediaNodeRegistry} from '../media-node-registry.js';
import {AiRunError,AI_PROTOCOL,authorizeAiMedia,claimAiRun,commitAiAnswer,failAiRun,heartbeatAiWorker,markAiMediaFailure,readAiRun,renewAiLease} from './repository.js';
import {VOICE_PROVIDER_ID} from './voice-providers.js';
import {diag} from '../diag.js';
import {MediaBridgeError} from '../media-client.js';
import {AI_TRANSCRIPT_MAX_BATCH,AI_TRANSCRIPT_MAX_TEXT,storeAiTranscript} from './transcripts.js';

type Fail=(status:number,code:string,message:string,details?:unknown)=>never;
const workerIdentity=z.object({instanceId:z.uuid(),bootId:z.uuid()});

export function registerAiRunRoutes(app:FastifyInstance,db:Db,config:Config,media:MediaNodeRegistry|null,fail:Fail,onMediaClose:(callId:string)=>Promise<void>,
  /** S20 D4: rung after the answer command's transaction committed, never inside it. */
  onCommandInserted?:(gatewayId:string)=>void){
  const mapError=(error:unknown):never=>{
    if(error instanceof AiRunError&&error.lease?.runId)leaseLost(error.lease as {runId:string;check:string;runState?:string});
    if(error instanceof AiRunError)fail(error.status,error.code,error.message);throw error;
  };
  // S75: fire and forget; callState tells an end-of-call race (call already ended) from a real loss. Never the token.
  const leaseLost=(lease:{runId:string;check:string;runState?:string})=>void db.query(
    `SELECT run.call_id,run.state,call.state call_state FROM ai_call_runs run LEFT JOIN call_records call ON call.id=run.call_id WHERE run.id=$1`,[lease.runId],
  ).then(q=>{const r=q.rows[0];
    diag(db,'ai.lease_lost',{runId:lease.runId,check:lease.check,runState:lease.runState??r?.state??null,callState:r?.call_state??null},{callId:r?.call_id??null,level:'warn'});
  },()=>undefined);
  const requireService=(req:FastifyRequest)=>{
    if(!config.AI_INTERNAL_TOKEN)fail(503,'AI_SERVICE_UNAVAILABLE','AI service identity is not configured');
    const value=req.headers.authorization;
    if(typeof value!=='string'||!value.startsWith('Bearer '))fail(401,'AI_SERVICE_UNAUTHENTICATED','AI service authentication is required');
    const actual=createHash('sha256').update(value.slice(7)).digest(),expected=createHash('sha256').update(config.AI_INTERNAL_TOKEN).digest();
    if(!timingSafeEqual(actual,expected))fail(401,'AI_SERVICE_UNAUTHENTICATED','AI service authentication is required');
  };
  const lease=(req:FastifyRequest)=>{
    const token=req.headers['x-ai-lease-token'];
    if(typeof token!=='string'||token.length<32||token.length>128)fail(401,'AI_LEASE_REQUIRED','AI run lease is required');
    return token;
  };
  app.post('/internal/v1/ai/workers/heartbeat',async req=>{
    requireService(req);const body=workerIdentity.extend({protocol:z.literal(AI_PROTOCOL),capacity:z.literal(1),
      // S24 决策 3: optional so a pre-S24 worker keeps advertising xAI and nothing else changes. An
      // explicitly empty array is NOT that case — it is a worker telling us it can instantiate nothing,
      // which must leave every provider offline instead of routing calls into a run that cannot run.
      providers:z.array(z.string().regex(VOICE_PROVIDER_ID)).max(16).optional()}).parse(req.body);
    try{return{worker:{...body,...await heartbeatAiWorker(db,body)}};}catch(error){return mapError(error);}
  });
  app.post('/internal/v1/ai/runs/claim',async(req,reply)=>{
    requireService(req);const body=workerIdentity.parse(req.body);
    try{const claimed=await claimAiRun(db,{enabled:config.AI_ENABLED&&config.AI_WORKER_READY,...body});if(!claimed)return reply.code(204).send();return{run:{...claimed.run,leaseToken:claimed.leaseToken,leaseExpiresAt:claimed.leaseExpiresAt}};}catch(error){return mapError(error);}
  });
  app.put('/internal/v1/ai/runs/:runId/lease',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params),body=workerIdentity.parse(req.body);
    try{return{lease:await renewAiLease(db,{runId,token:lease(req),...body})};}catch(error){return mapError(error);}
  });
  app.post('/internal/v1/ai/runs/:runId/commit-answer',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params),body=workerIdentity.parse(req.body);
    if(!media)fail(503,'MEDIA_UNAVAILABLE','Call media is not configured');
    let nodeId:string;try{nodeId=media.choose(config.AI_MEDIA_NODE_ID);}catch(error){if(error instanceof MediaNodeNotFoundError)fail(503,'AI_MEDIA_NODE_UNAVAILABLE','AI media node is not configured');throw error;}
    try{
      const committed=await commitAiAnswer(db,{enabled:config.AI_ENABLED&&config.AI_WORKER_READY,runId,token:lease(req),onlineSeconds:config.GATEWAY_ONLINE_SECONDS,nodeId,...body});
      if(!committed.replayed&&onCommandInserted){
        const owner=await db.query(`SELECT gateway_id FROM ai_call_runs WHERE id=$1`,[runId]);
        if(owner.rowCount)onCommandInserted(owner.rows[0].gateway_id);
      }
      return committed;
    }catch(error){return mapError(error);}
  });
  /**
   * S21 §E realtime transcript. Best-effort by contract: the Voice worker never lets a transcript
   * failure end a call, so a replayed batch is absorbed by `ON CONFLICT (run_id,sequence)`.
   */
  app.post('/internal/v1/ai/runs/:runId/transcript',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params);
    const body=workerIdentity.extend({items:z.array(z.object({
      role:z.enum(['ai','caller']),
      sequence:z.number().int().min(0).max(1_000_000),
      text:z.string().min(1).max(AI_TRANSCRIPT_MAX_TEXT),
      at:z.string().refine(value=>Number.isFinite(Date.parse(value)),'Invalid transcript timestamp'),
    })).min(1).max(AI_TRANSCRIPT_MAX_BATCH)}).parse(req.body);
    try{return await storeAiTranscript(db,{runId,token:lease(req),...body});}catch(error){return mapError(error);}
  });
  app.get('/internal/v1/ai/runs/:runId',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params),query=workerIdentity.parse(req.query);
    try{return await readAiRun(db,{runId,token:lease(req),onlineSeconds:config.GATEWAY_ONLINE_SECONDS,...query});}catch(error){return mapError(error);}
  });
  app.post('/internal/v1/ai/runs/:runId/fail',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params),body=workerIdentity.extend({code:z.string().regex(/^[a-z0-9_]{1,80}$/)}).parse(req.body);
    try{return await failAiRun(db,{runId,token:lease(req),...body});}catch(error){return mapError(error);}
  });
  const mediaIdentity=workerIdentity.extend({transport:z.enum(['udp','tls']).default('udp')});
  app.post('/internal/v1/ai/runs/:runId/media/options',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params),body=mediaIdentity.parse(req.body);
    if(!media)fail(503,'MEDIA_UNAVAILABLE','Call media is not configured');
    try{
      const authorized=await authorizeAiMedia(db,{runId,token:lease(req),onlineSeconds:config.GATEWAY_ONLINE_SECONDS,...body});
      return{mediaNodeId:authorized.nodeId,mediaEpoch:authorized.mediaEpoch,iceServers:media.iceServers(authorized.nodeId,body.transport),iceTransportPolicy:'relay'};
    }catch(error){return mapError(error);}
  });
  app.post('/internal/v1/ai/runs/:runId/media/offer',async req=>{
    requireService(req);const {runId}=z.object({runId:z.uuid()}).parse(req.params),body=workerIdentity.extend({type:z.literal('offer'),sdp:z.string().min(1).max(120*1024)}).parse(req.body);
    if(!media)fail(503,'MEDIA_UNAVAILABLE','Call media is not configured');
    let authorized:{callId:string;nodeId:string;mediaEpoch:number};
    try{authorized=await authorizeAiMedia(db,{runId,token:lease(req),onlineSeconds:config.GATEWAY_ONLINE_SECONDS,markAttempted:true,...body});}
    catch(error){
      if(error instanceof AiRunError&&error.code==='AI_MEDIA_ALREADY_ATTEMPTED'){
        const failed=await markAiMediaFailure(db,runId,'ai_media_offer_replayed');if(failed)await onMediaClose(failed.callId);
      }
      return mapError(error);
    }
    let answer:{type:'answer';sdp:string}|undefined;const startedAt=Date.now();
    try{
      answer=await media.offer(authorized.nodeId,authorized.callId,'client',{type:'offer',sdp:body.sdp},authorized.mediaEpoch);
      await authorizeAiMedia(db,{runId,token:lease(req),onlineSeconds:config.GATEWAY_ONLINE_SECONDS,...body});
      // S75: the AI leg's node is fixed at commit-answer; mirror the human media.offer row for call-timeline.
      diag(db,'media.offer',{ms:Date.now()-startedAt,nodeId:authorized.nodeId,nodeReason:config.AI_MEDIA_NODE_ID?'ai_configured':'default',candidates:[authorized.nodeId],leg:'ai',runId},{callId:authorized.callId});
      return answer;
    }catch(error){
      if(!answer)diag(db,'media.offer_failed',{stage:'bridge_offer',ms:Date.now()-startedAt,nodeId:authorized.nodeId,leg:'ai',runId,
        bridgeStatus:error instanceof MediaBridgeError?error.status:null,
        reason:error instanceof MediaBridgeError?null:`${(error as Error)?.name}: ${String((error as Error)?.message)}`.slice(0,200)},
        {callId:authorized.callId,level:'warn'});
      const failed=await markAiMediaFailure(db,runId,'ai_media_offer_failed');
      await onMediaClose(failed?.callId??authorized.callId);
      if(error instanceof AiRunError)return mapError(error);
      fail(503,'MEDIA_BRIDGE_UNAVAILABLE','Media bridge did not accept the AI offer');
    }
  });
}
