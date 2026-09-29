import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {MediaProbeGrantIssuer,selectMediaNode,type MediaProbeSample} from '../src/media-probes.js';

test('probe grants bind one request to one configured HTTPS node',()=>{
  const secret='g'.repeat(40),now=1_788_960_000_000;
  const issuer=new MediaProbeGrantIssuer([{id:'relay-secondary',probeUrl:'https://media-relay-secondary.example/probe',secret}]);
  const issued=issuer.issue({nodeId:'relay-secondary',subjectHash:'sessionHash_1234567890',networkGeneration:'wifi:42',count:3,nowMs:now});
  assert.equal(issued.grants.length,3);assert.equal(new Set(issued.grants).size,3);assert.equal(issued.probeUrl,'https://media-relay-secondary.example/probe');
  for(const token of issued.grants){const [body,signature]=token.split('.');assert.equal(signature,createHmac('sha256',secret).update(body!).digest('base64url'));const claim=JSON.parse(Buffer.from(body!,'base64url').toString());assert.deepEqual({...claim,nonce:'x'},{purpose:'media-probe-v1',method:'POST',path:'/probe',nodeId:'relay-secondary',subjectHash:'sessionHash_1234567890',networkGeneration:'wifi:42',exp:Math.floor(now/1000)+30,nonce:'x'});}
  assert.throws(()=>issuer.issue({nodeId:'unknown',subjectHash:'sessionHash_1234567890',networkGeneration:'wifi:42'}));
  assert.throws(()=>new MediaProbeGrantIssuer([{id:'bad',probeUrl:'https://media-relay-secondary.example/other',secret}]));
  assert.throws(()=>new MediaProbeGrantIssuer([{id:'bad',probeUrl:'http://media-relay-secondary.example/probe',secret}]));
});

test('selection uses fresh same-generation client RTT only within gateway reachability',()=>{
  const now=1_788_960_000_000;
  const sample=(nodeId:string,httpsRttMs:number,overrides:Partial<MediaProbeSample>={}):MediaProbeSample=>({nodeId,networkGeneration:'cell:7',measuredAtMs:now-1000,outcome:'ok',httpsRttMs,...overrides});
  const result=selectMediaNode({configuredNodeIds:['relay-primary','relay-secondary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-primary','relay-secondary','forged'],clientNetworkGeneration:'cell:7',nowMs:now,clientSamples:[sample('relay-primary',180),sample('relay-primary',200),sample('relay-secondary',70),sample('relay-secondary',80),sample('forged',1),sample('relay-secondary',1,{networkGeneration:'old'}),sample('relay-secondary',1,{measuredAtMs:now-300_000})]});
  assert.deepEqual(result,{nodeId:'relay-secondary',reason:'measured_https_rtt',scoreMs:80});
  const gatewayFence=selectMediaNode({configuredNodeIds:['relay-primary','relay-secondary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-primary'],clientNetworkGeneration:'cell:7',nowMs:now,clientSamples:[sample('relay-primary',180),sample('relay-primary',200),sample('relay-secondary',1),sample('relay-secondary',1)]});
  assert.equal(gatewayFence.nodeId,'relay-primary');
  const oldGeneration=selectMediaNode({configuredNodeIds:['relay-primary','relay-secondary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-primary','relay-secondary'],clientNetworkGeneration:'cell:8',nowMs:now,clientSamples:[sample('relay-secondary',1),sample('relay-secondary',1)]});
  assert.deepEqual(oldGeneration,{nodeId:'relay-primary',reason:'default_without_measurements'});
});

test('selection fails closed after measured failures and never migrates a fixed call',()=>{
  const now=1_788_960_000_000;
  const failed:MediaProbeSample[]=[{nodeId:'relay-primary',networkGeneration:'wifi:1',measuredAtMs:now,outcome:'timeout'},{nodeId:'relay-secondary',networkGeneration:'wifi:1',measuredAtMs:now,outcome:'network_error'}];
  assert.deepEqual(selectMediaNode({configuredNodeIds:['relay-primary','relay-secondary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-primary','relay-secondary'],clientNetworkGeneration:'wifi:1',nowMs:now,clientSamples:failed}),{nodeId:null,reason:'no_common_reachable_node'});
  assert.deepEqual(selectMediaNode({configuredNodeIds:['relay-primary','relay-secondary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-secondary'],clientNetworkGeneration:'wifi:1',nowMs:now,clientSamples:[],fixedNodeId:'relay-primary'}),{nodeId:'relay-primary',reason:'fixed_for_call'});
  assert.deepEqual(selectMediaNode({configuredNodeIds:['relay-primary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-primary'],clientNetworkGeneration:'wifi:1',nowMs:now,clientSamples:[],fixedNodeId:'retired'}),{nodeId:null,reason:'fixed_node_unavailable'});
  assert.deepEqual(selectMediaNode({configuredNodeIds:['relay-primary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:[],clientNetworkGeneration:'wifi:1',nowMs:now,clientSamples:[]}),{nodeId:null,reason:'no_common_reachable_node'});
  assert.throws(()=>selectMediaNode({configuredNodeIds:['relay-primary'],defaultNodeId:'relay-primary',gatewayReachableNodeIds:['relay-primary'],clientNetworkGeneration:'wifi:1',nowMs:now,clientSamples:Array.from({length:65},()=>failed[0]!)}));
});
