import {createHmac, randomBytes} from 'node:crypto';

const NODE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const NETWORK_GENERATION = /^[A-Za-z0-9._:-]{1,96}$/;
const SUBJECT_HASH = /^[A-Za-z0-9_-]{16,64}$/;

export type MediaProbeNode = {id:string;probeUrl:string;secret:string};
export type MediaProbeSample = {
  nodeId:string;
  networkGeneration:string;
  measuredAtMs:number;
  outcome:'ok'|'timeout'|'network_error';
  /** HTTPS request round-trip only. It is not a media loss or jitter metric. */
  httpsRttMs?:number;
};
export type MediaNodeSelection = {
  nodeId:string|null;
  reason:'measured_relay_quality'|'quality_hysteresis'|'no_common_quality_node'|'fixed_for_call'|'measured_https_rtt'|'default_without_measurements'|'no_common_reachable_node'|'fixed_node_unavailable';
  scoreMs?:number;
};

export class MediaProbeGrantIssuer {
  private readonly nodes = new Map<string,MediaProbeNode>();
  constructor(nodes:MediaProbeNode[]) {
    if (!nodes.length || nodes.length>16) throw new Error('Media probe node count is invalid');
    for (const raw of nodes) {
      if (!NODE_ID.test(raw.id) || raw.secret.length < 32 || this.nodes.has(raw.id)) throw new Error('Invalid media probe node');
      const url = new URL(raw.probeUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/probe') throw new Error('Media probe URL must be an exact trusted HTTPS /probe URL');
      this.nodes.set(raw.id,{...raw,probeUrl:url.toString()});
    }
  }
  issue(input:{nodeId:string;subjectHash:string;networkGeneration:string;count?:number;nowMs?:number}) {
    const node=this.nodes.get(input.nodeId);
    const count=input.count??3;
    if (!node || !SUBJECT_HASH.test(input.subjectHash) || !NETWORK_GENERATION.test(input.networkGeneration) || !Number.isSafeInteger(count) || count<1 || count>3) throw new Error('Invalid media probe grant request');
    const nowMs=input.nowMs??Date.now();
    if (!Number.isSafeInteger(nowMs)||nowMs<0) throw new Error('Invalid media probe grant time');
    const now=Math.floor(nowMs/1000);
    const grants=Array.from({length:count},()=>{
      const body=Buffer.from(JSON.stringify({purpose:'media-probe-v1',method:'POST',path:'/probe',nodeId:node.id,subjectHash:input.subjectHash,networkGeneration:input.networkGeneration,exp:now+30,nonce:randomBytes(24).toString('base64url')})).toString('base64url');
      return body+'.'+createHmac('sha256',node.secret).update(body).digest('base64url');
    });
    return {nodeId:node.id,probeUrl:node.probeUrl,expiresAt:new Date((now+30)*1000).toISOString(),grants};
  }
}

export function selectMediaNode(input:{
  configuredNodeIds:string[];
  defaultNodeId:string;
  gatewayReachableNodeIds:string[];
  clientSamples:MediaProbeSample[];
  clientNetworkGeneration:string;
  nowMs?:number;
  maxAgeMs?:number;
  fixedNodeId?:string|null;
}):MediaNodeSelection {
  if (input.configuredNodeIds.length<1||input.configuredNodeIds.length>16||input.gatewayReachableNodeIds.length>16||input.clientSamples.length>64) throw new Error('Media probe selection input exceeds bounds');
  if(input.configuredNodeIds.some(id=>!NODE_ID.test(id))||new Set(input.configuredNodeIds).size!==input.configuredNodeIds.length)throw new Error('Configured media probe nodes are invalid');
  const configured=new Set(input.configuredNodeIds);
  if (!configured.has(input.defaultNodeId)) throw new Error('Default media node is not configured');
  if (input.fixedNodeId) return configured.has(input.fixedNodeId)?{nodeId:input.fixedNodeId,reason:'fixed_for_call'}:{nodeId:null,reason:'fixed_node_unavailable'};
  const gatewayReachable=new Set(input.gatewayReachableNodeIds.filter(id=>configured.has(id)));
  const now=input.nowMs??Date.now(),maxAge=input.maxAgeMs??120_000;
  if (!NETWORK_GENERATION.test(input.clientNetworkGeneration) || !Number.isSafeInteger(now) || now<0 || !Number.isSafeInteger(maxAge) || maxAge<=0 || maxAge>600_000) throw new Error('Invalid media probe selection input');
  const relevant=input.clientSamples.filter(sample=>configured.has(sample.nodeId)&&gatewayReachable.has(sample.nodeId)&&sample.networkGeneration===input.clientNetworkGeneration&&Number.isFinite(sample.measuredAtMs)&&sample.measuredAtMs<=now&&now-sample.measuredAtMs<=maxAge);
  if (!relevant.length) return gatewayReachable.has(input.defaultNodeId)?{nodeId:input.defaultNodeId,reason:'default_without_measurements'}:{nodeId:null,reason:'no_common_reachable_node'};
  const ranked:{nodeId:string;scoreMs:number}[]=[];
  for (const nodeId of configured) {
    if (!gatewayReachable.has(nodeId)) continue;
    const samples=relevant.filter(sample=>sample.nodeId===nodeId).sort((a,b)=>b.measuredAtMs-a.measuredAtMs).slice(0,3);
    const successes=samples.filter((sample):sample is MediaProbeSample&{httpsRttMs:number}=>sample.outcome==='ok'&&typeof sample.httpsRttMs==='number'&&Number.isFinite(sample.httpsRttMs)&&sample.httpsRttMs>=0&&sample.httpsRttMs<=10_000);
    if (successes.length<2 || successes.length*3<samples.length*2) continue;
    const values=successes.map(sample=>sample.httpsRttMs).sort((a,b)=>a-b);
    const median=values[Math.floor(values.length/2)]!;
    ranked.push({nodeId,scoreMs:median+(samples.length-successes.length)*500});
  }
  ranked.sort((a,b)=>a.scoreMs-b.scoreMs||Number(b.nodeId===input.defaultNodeId)-Number(a.nodeId===input.defaultNodeId)||a.nodeId.localeCompare(b.nodeId));
  const winner=ranked[0];
  return winner?{nodeId:winner.nodeId,reason:'measured_https_rtt',scoreMs:winner.scoreMs}:{nodeId:null,reason:'no_common_reachable_node'};
}
