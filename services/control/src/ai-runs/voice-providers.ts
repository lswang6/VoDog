import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {QueryResult} from 'pg';
import {z} from 'zod';
import type {Config} from '../config.js';
import {safeRollback,withClient,type Db} from '../db.js';
import {AI_PROTOCOL,DEFAULT_VOICE_PROVIDER} from './repository.js';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};

/**
 * S24 决策 3. One shape guards the column CHECK, the `AI_VOICE_PROVIDERS` config key and the PUT body,
 * so an id that reaches the database has already been rejected three times if it is malformed.
 */
export const VOICE_PROVIDER_ID=/^[a-z][a-z0-9_-]{0,31}$/;
export {DEFAULT_VOICE_PROVIDER};
/** Unknown ids fall back to the id itself: a provider can ship before anyone writes a label for it. */
const VOICE_PROVIDER_LABELS:Record<string,string>={xai:'xAI Grok',doubao:'豆包'};
export const voiceProviderLabel=(id:string)=>VOICE_PROVIDER_LABELS[id]??id;

/**
 * The DB-backed tests build `Config` objects by hand and never set `AI_VOICE_PROVIDERS`, so an absent
 * value must mean exactly what the production default means: xAI alone.
 */
export function parseVoiceProviders(value?:string|null):string[]{
  const items=[...new Set((value??DEFAULT_VOICE_PROVIDER).split(',').map(item=>item.trim()).filter(item=>VOICE_PROVIDER_ID.test(item)))];
  return items.length?items:[DEFAULT_VOICE_PROVIDER];
}

/** A provider is online only while some worker instance with a live heartbeat still advertises it. */
export async function onlineVoiceProviders(db:Queryable):Promise<Set<string>>{
  const q=await db.query(`SELECT DISTINCT unnest(providers) provider FROM ai_worker_instances
    WHERE protocol=$1 AND capacity=1 AND expires_at>now()`,[AI_PROTOCOL]);
  return new Set(q.rows.map(row=>row.provider as string));
}

export async function selectedVoiceProvider(db:Queryable,userId:string):Promise<string>{
  const q=await db.query(`SELECT ai_voice_provider FROM users WHERE id=$1`,[userId]);
  return (q.rows[0]?.ai_voice_provider as string|undefined)??DEFAULT_VOICE_PROVIDER;
}

/**
 * The list always contains the user's current selection, even after it was dropped from
 * `AI_VOICE_PROVIDERS`: the three clients have to be able to render "已选择但未配置" instead of
 * silently showing a different provider as selected.
 */
export async function voiceProviderStatus(db:Db,config:Pick<Config,'AI_VOICE_PROVIDERS'>,userId:string){
  const configured=parseVoiceProviders(config.AI_VOICE_PROVIDERS);
  const [selection,online]=await Promise.all([
    db.query(`SELECT ai_voice_provider,ai_voice_provider_version FROM users WHERE id=$1`,[userId]),
    onlineVoiceProviders(db),
  ]);
  const selected=(selection.rows[0]?.ai_voice_provider as string|undefined)??DEFAULT_VOICE_PROVIDER;
  const configVersion=Number(selection.rows[0]?.ai_voice_provider_version??1);
  const ids=configured.includes(selected)?configured:[...configured,selected];
  return{
    items:ids.map(id=>({id,label:voiceProviderLabel(id),configured:configured.includes(id),online:online.has(id)})),
    selected,
    configVersion,
  };
}

type RouteDependencies={
  requireUser(request:FastifyRequest):{userId:string};
  mutationOrigin(request:FastifyRequest):void;
  fail(status:number,code:string,message:string,details?:unknown):never;
};

export function registerVoiceProviderRoutes(app:FastifyInstance,db:Db,config:Pick<Config,'AI_VOICE_PROVIDERS'>,dependencies:RouteDependencies){
  app.get('/api/v1/ai/voice-providers',async request=>{
    const {userId}=dependencies.requireUser(request);
    return voiceProviderStatus(db,config,userId);
  });
  /**
   * Only later runs are affected: `ai_call_runs.voice_provider` is frozen when the call arrives, so a
   * switch never re-targets a call that a worker is already answering.
   */
  app.put('/api/v1/ai/voice-provider',async request=>{
    const {userId}=dependencies.requireUser(request);
    dependencies.mutationOrigin(request);
    if(!request.body||typeof request.body!=='object'||!Object.prototype.hasOwnProperty.call(request.body,'expectedVersion'))
      dependencies.fail(428,'PROVIDER_VERSION_REQUIRED','expectedVersion is required');
    const body=z.object({provider:z.string().regex(VOICE_PROVIDER_ID),expectedVersion:z.number().int().min(1)}).parse(request.body);
    const label=voiceProviderLabel(body.provider);
    if(!parseVoiceProviders(config.AI_VOICE_PROVIDERS).includes(body.provider))
      dependencies.fail(409,'PROVIDER_UNAVAILABLE',`语音服务 ${label} 未配置，无法选择`,{provider:body.provider,reason:'not_configured'});
    if(!(await onlineVoiceProviders(db)).has(body.provider))
      dependencies.fail(409,'PROVIDER_UNAVAILABLE',`语音服务 ${label} 当前离线`,{provider:body.provider,reason:'offline'});
    await withClient(db,async c=>{
      try{
        await c.query('BEGIN');
        const current=await c.query(`SELECT ai_voice_provider,ai_voice_provider_version FROM users WHERE id=$1 FOR UPDATE`,[userId]);
        if(!current.rowCount){await c.query('COMMIT');dependencies.fail(401,'UNAUTHENTICATED','Authentication required');}
        const from=current.rows[0].ai_voice_provider as string;
        const currentVersion=Number(current.rows[0].ai_voice_provider_version);
        if(currentVersion!==body.expectedVersion)
          dependencies.fail(409,'PROVIDER_VERSION_CONFLICT','Provider changed; refresh before saving',{currentVersion});
        await c.query(`UPDATE users SET ai_voice_provider=$2,ai_voice_provider_version=ai_voice_provider_version+1
          WHERE id=$1 AND ai_voice_provider_version=$3`,[userId,body.provider,body.expectedVersion]);
        await c.query(`INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)
          VALUES($1,'ai.voice_provider.update','user',$1,$2)`,[userId,JSON.stringify({from,to:body.provider})]);
        await c.query('COMMIT');
      }catch(error){await safeRollback(c);throw error;}
    });
    return voiceProviderStatus(db,config,userId);
  });
}
