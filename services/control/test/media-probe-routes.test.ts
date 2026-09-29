import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {ZodError} from 'zod';
import {createHash} from 'node:crypto';
import {MediaProbeCoordinator,registerMediaProbeRoutes} from '../src/media-probe-routes.js';

class TestApiError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message)}}
const nodes=[
  {id:'relay-primary',probeUrl:'https://relay-primary-media.example/probe',secret:'v'.repeat(40)},
  {id:'relay-secondary',probeUrl:'https://relay-secondary-media.example/probe',secret:'g'.repeat(40)},
];
function fixture(){
  let now=1_788_960_000_000;
  const coordinator=new MediaProbeCoordinator({nodes,defaultNodeId:'relay-primary',now:()=>now,ttlMs:120_000,maxSubjects:8});
  const app=Fastify();
  app.setErrorHandler((error,_request,reply)=>error instanceof TestApiError?reply.code(error.status).send({error:{code:error.code}}):error instanceof ZodError?reply.code(400).send({error:{code:'INVALID_REQUEST'}}):reply.send(error));
  registerMediaProbeRoutes(app,coordinator,{
    requireUser(req){const session=req.headers['x-session'];if(typeof session!=='string')throw new TestApiError(401,'UNAUTHENTICATED','auth');return{userId:'user-1',sessionId:session};},
    requireGateway(req){const gateway=req.headers['x-gateway'],epoch=Number(req.headers['x-epoch']);if(typeof gateway!=='string'||!Number.isSafeInteger(epoch))throw new TestApiError(401,'DEVICE_UNAUTHENTICATED','auth');return{gatewayId:gateway,deviceEpoch:epoch};},
    mutationOrigin(){},subjectHash(value){return createHash('sha256').update(value).digest('base64url').slice(0,32);},
    fail(status,code,message){throw new TestApiError(status,code,message);},
  });
  return{app,coordinator,advance:(ms:number)=>{now+=ms}};
}

test('probe routes bind generations to the authenticated session and gateway epoch',async()=>{
  const {app,coordinator}=fixture();
  try{
    const anonymous=await app.inject({method:'POST',url:'/api/v1/media/probes/options',payload:{networkGeneration:'wifi:1'}});assert.equal(anonymous.statusCode,401);
    const premature=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:1',samples:[{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:20}]}});assert.equal(premature.statusCode,409);assert.equal(premature.json().error.code,'PROBE_OPTIONS_REQUIRED');
    const userOptions=await app.inject({method:'POST',url:'/api/v1/media/probes/options',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:1'}});assert.equal(userOptions.statusCode,200,userOptions.body);assert.deepEqual(userOptions.json().nodes.map((node:any)=>node.nodeId),['relay-primary','relay-secondary']);assert.equal(userOptions.json().nodes[0].grants.length,3);
    const userResults=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:1',samples:[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:180},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:190},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:50},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:60}]}});assert.equal(userResults.statusCode,200,userResults.body);
    const gatewayHeaders={'x-gateway':'gateway-1','x-epoch':'7'};
    await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/options',headers:gatewayHeaders,payload:{networkGeneration:'cell:3'}});
    const gatewayResults=await app.inject({method:'POST',url:'/api/v1/gateway/media/probes/results',headers:gatewayHeaders,payload:{networkGeneration:'cell:3',samples:[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:100},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:110},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:70},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:75}]}});assert.equal(gatewayResults.statusCode,200,gatewayResults.body);
    assert.deepEqual(coordinator.select({userSubjectKey:'user:session-a',clientNetworkGeneration:'wifi:1',gatewaySubjectKey:'gateway:gateway-1:7'}),{nodeId:'relay-secondary',reason:'measured_https_rtt',scoreMs:60});
    assert.equal(coordinator.hasGatewayEvidence('gateway:gateway-1:8'),false);
    assert.deepEqual(coordinator.select({userSubjectKey:'user:session-a',clientNetworkGeneration:'wifi:1',gatewaySubjectKey:'gateway:gateway-1:8'}),{nodeId:null,reason:'no_common_reachable_node'});
    const otherSession=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:{'x-session':'session-b'},payload:{networkGeneration:'wifi:1',samples:[{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:1}]}});assert.equal(otherSession.statusCode,409);
  }finally{await app.close();}
});

test('probe evidence is bounded, expires, and rejects unknown nodes or old generations',async()=>{
  const {app,coordinator,advance}=fixture();
  try{
    await app.inject({method:'POST',url:'/api/v1/media/probes/options',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:1'}});
    const unknown=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:1',samples:[{nodeId:'forged',outcome:'ok',httpsRttMs:1}]}});assert.equal(unknown.statusCode,400);assert.equal(unknown.json().error.code,'PROBE_NODE_INVALID');
    await app.inject({method:'POST',url:'/api/v1/media/probes/options',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:2'}});
    const old=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:1',samples:[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:10}]}});assert.equal(old.statusCode,409);
    advance(121_000);assert.throws(()=>coordinator.select({userSubjectKey:'user:session-a',clientNetworkGeneration:'wifi:2',gatewaySubjectKey:'gateway:gateway-1:7'}),error=>error instanceof Error&&'code'in error&&(error as any).code==='PROBE_OPTIONS_REQUIRED');
    const oversized=await app.inject({method:'POST',url:'/api/v1/media/probes/results',headers:{'x-session':'session-a'},payload:{networkGeneration:'wifi:2',samples:Array.from({length:49},()=>({nodeId:'relay-primary',outcome:'timeout'}))}});assert.equal(oversized.statusCode,400);
  }finally{await app.close();}
});

test('a rejected batch is atomic and same-millisecond failures supersede old success',()=>{
  let now=1_788_960_000_000;
  const coordinator=new MediaProbeCoordinator({nodes,defaultNodeId:'relay-primary',now:()=>now});
  coordinator.optionsFor('user:s','sessionHash_1234567890','wifi:1');coordinator.optionsFor('gateway:g:1','gatewayHash_123456789','cell:1');
  coordinator.submit('user:s','wifi:1',[{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:50},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:60},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:70}]);
  coordinator.submit('gateway:g:1','cell:1',[{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:80},{nodeId:'relay-secondary',outcome:'ok',httpsRttMs:90}]);
  assert.throws(()=>coordinator.submit('user:s','wifi:1',[{nodeId:'relay-secondary',outcome:'timeout'},{nodeId:'forged',outcome:'timeout'}]),error=>error instanceof Error&&'code'in error&&(error as any).code==='PROBE_NODE_INVALID');
  assert.equal(coordinator.select({userSubjectKey:'user:s',clientNetworkGeneration:'wifi:1',gatewaySubjectKey:'gateway:g:1'}).nodeId,'relay-secondary');
  coordinator.submit('user:s','wifi:1',[{nodeId:'relay-secondary',outcome:'timeout'},{nodeId:'relay-secondary',outcome:'network_error'}]);
  assert.deepEqual(coordinator.select({userSubjectKey:'user:s',clientNetworkGeneration:'wifi:1',gatewaySubjectKey:'gateway:g:1'}),{nodeId:null,reason:'no_common_reachable_node'});
  now++;
});
