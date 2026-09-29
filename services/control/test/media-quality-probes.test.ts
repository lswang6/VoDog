import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import Fastify from 'fastify';
import {MediaQualityProbeCoordinator,qualitySampleSchema,type QualitySample} from '../src/media-quality-probes.js';
import {registerMediaQualityProbeRoutes} from '../src/media-quality-probe-routes.js';
const nodes=['relay-primary','relay-secondary'].map(id=>({id,probeUrl:`https://${id}.example/probe`,secret:'m'.repeat(32),turnSecret:'t'.repeat(32),turnUdpUrl:`turn:${id}.example:3478?transport=udp`}));
const now=1_788_960_000_000;
const user='user:s1',gateway='gateway:g1:1',hash='hashed_subject_1234567890';
const input={userSubjectKey:user,clientNetworkGeneration:'client-wifi:1',gatewaySubjectKey:gateway};
const sample=(nodeId:string,rtt=100):QualitySample=>({nodeId,outcome:'ok',sent:100,received:100,connectionMs:100,rttMedianMs:rtt,rttP95Ms:rtt,jitterMs:5,sampleDurationMs:2000});
function ready(clock=()=>now){const c=new MediaQualityProbeCoordinator({nodes,defaultNodeId:'relay-primary',enabled:true,now:clock});c.optionsFor(user,hash,'client-wifi:1');c.optionsFor(gateway,hash,'pixel-cell:99');c.qualityOptions(user,hash,'client-wifi:1','client');c.qualityOptions(gateway,hash,'pixel-cell:99','gateway');return c;}
test('quality grants bind role/node/purpose and issue only trusted 60-second relay credentials',()=>{
 const c=ready(),response=c.qualityOptions(user,hash,'client-wifi:1','client');
 const [body,signature]=response.nodes[0]!.grant.split('.');
 assert.equal(signature,createHmac('sha256',nodes[0]!.secret).update(body!).digest('base64url'));
 const claims=JSON.parse(Buffer.from(body!,'base64url').toString());
 assert.equal(claims.purpose,'media-webrtc-probe-v1');assert.equal(claims.role,'client');assert.equal(claims.path,'/webrtc-probe/offer');assert.equal(claims.exp,now/1000+30);assert.equal(claims.callId,undefined);
 assert.equal(response.nodes[0]!.probeUrl,'https://relay-primary.example/webrtc-probe/offer');assert.equal(response.iceTransportPolicy,'relay');
 assert.match(response.nodes[0]!.iceServers[0]!.username,new RegExp(`^${now/1000+60}:`));
 assert.throws(()=>new MediaQualityProbeCoordinator({nodes:[{...nodes[0]!,probeUrl:'https://evil.example/path?redirect=https://x'}],defaultNodeId:'relay-primary'}));
});
test('both independent endpoint generations must have successful quality; failures never fall back to HTTPS',()=>{
 const c=ready();c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary',80),sample('relay-secondary',30)]);
 assert.equal(c.select(input).nodeId,null);
 c.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary',80),sample('relay-secondary',40)]);
 assert.equal(c.select(input).nodeId,'relay-secondary');assert.equal(c.select(input).reason,'measured_relay_quality');
 c.qualitySubmit(gateway,'pixel-cell:99',[{nodeId:'relay-secondary',outcome:'timeout',sent:0,received:0,sampleDurationMs:0},{nodeId:'relay-primary',outcome:'network_error',sent:0,received:0,sampleDurationMs:0}]);
 assert.deepEqual(c.select(input),{nodeId:null,reason:'no_common_quality_node'});
 assert.equal(c.select({...input,fixedNodeId:'relay-secondary'}).nodeId,'relay-secondary');
 assert.throws(()=>c.select({...input,userSubjectKey:'user:other'}));
});
test('deterministic hysteresis keeps a healthy incumbent for small gains and releases it on failure',()=>{
 const c=ready();c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary',100),sample('relay-secondary',140)]);c.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary',100),sample('relay-secondary',140)]);
 assert.equal(c.select(input).nodeId,'relay-primary');
 c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary',100),sample('relay-secondary',95)]);c.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary',100),sample('relay-secondary',95)]);
 assert.deepEqual(c.select(input),{nodeId:'relay-primary',scoreMs:230,reason:'quality_hysteresis'});
 c.qualitySubmit(user,'client-wifi:1',[{nodeId:'relay-primary',outcome:'timeout',sent:0,received:0,sampleDurationMs:0}]);assert.equal(c.select(input).nodeId,'relay-secondary');
});
test('options refresh cannot prolong old evidence; network change clears only its endpoint',()=>{
 let time=now;const c=ready(()=>time);c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary')]);c.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary')]);
 time+=119000;c.qualityOptions(user,hash,'client-wifi:1','client');time+=2000;
 assert.throws(()=>c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary')]));
 const fresh=ready();fresh.qualitySubmit(user,'client-wifi:1',[sample('relay-primary')]);fresh.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary')]);fresh.optionsFor(gateway,hash,'pixel-new:100');assert.equal(fresh.select(input).nodeId,null);
 assert.throws(()=>fresh.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary')]));
});
test('quality accepts bounded measurements and rejects forged counts, short samples, wrong nodes and duplicate batches',()=>{
 assert.throws(()=>qualitySampleSchema.parse({...sample('relay-primary'),received:101}));assert.throws(()=>qualitySampleSchema.parse({...sample('relay-primary'),sampleDurationMs:100}));assert.throws(()=>qualitySampleSchema.parse({...sample('relay-primary'),rttMedianMs:200,rttP95Ms:100}));assert.throws(()=>qualitySampleSchema.parse({...sample('relay-primary'),lossRatio:0}));
 const c=ready();assert.throws(()=>c.qualitySubmit(user,'client-wifi:1',[sample('forged')]));assert.throws(()=>c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary'),sample('relay-primary')]));assert.throws(()=>c.qualityOptions(gateway,hash,'pixel-cell:99','client'));
});
test('new quality routes authenticate exact caller role and reject call-linked payloads',async()=>{
 const app=Fastify();const fail=(status:number,code:string,message:string):never=>{throw Object.assign(new Error(message),{statusCode:status,code});};
 registerMediaQualityProbeRoutes(app,ready(),{requireUser:r=>{if(r.headers.authorization!=='Bearer user')fail(401,'unauth','user required');return{userId:'u',sessionId:'s1'};},requireGateway:r=>{if(r.headers.authorization!=='Bearer gateway')fail(401,'unauth','gateway required');return{gatewayId:'g1',deviceEpoch:1};},mutationOrigin:()=>{},subjectHash:()=>hash,fail});
 try{
  const anon=await app.inject({method:'POST',url:'/api/v1/media/quality-probes/options',payload:{networkGeneration:'client-wifi:1'}});assert.equal(anon.statusCode,401);
  const wrong=await app.inject({method:'POST',url:'/api/v1/gateway/media/quality-probes/options',headers:{authorization:'Bearer user'},payload:{networkGeneration:'client-wifi:1'}});assert.equal(wrong.statusCode,401);
  const ok=await app.inject({method:'POST',url:'/api/v1/media/quality-probes/options',headers:{authorization:'Bearer user'},payload:{networkGeneration:'client-wifi:1'}});assert.equal(ok.statusCode,200);assert.equal(ok.json().nodes.length,2);
  const invalid=await app.inject({method:'POST',url:'/api/v1/media/quality-probes/options',headers:{authorization:'Bearer user'},payload:{networkGeneration:'a',callId:'forbidden'}});assert.notEqual(invalid.statusCode,200);
 }finally{await app.close();}
});

test('legacy unenrolled session remains on HTTPS alongside upgraded Gateway quality',()=>{
 const c=ready();
 c.optionsFor('user:legacy',hash,'client-wifi:1');
 c.optionsFor(user,hash,'client-wifi:1');c.optionsFor(gateway,hash,'pixel-cell:99');
 for(const subject of [user,gateway])c.submit(subject,subject===user?'client-wifi:1':'pixel-cell:99',[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:80},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:90}]);
 c.optionsFor('user:legacy',hash,'client-wifi:1');c.submit('user:legacy','client-wifi:1',[{nodeId:'relay-primary',outcome:'ok',httpsRttMs:80},{nodeId:'relay-primary',outcome:'ok',httpsRttMs:90}]);
 c.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary')]);
 assert.equal(c.select({...input,userSubjectKey:'user:legacy'}).reason,'measured_https_rtt');
 c.qualitySubmit(user,'client-wifi:1',[{nodeId:'relay-primary',outcome:'timeout',sent:0,received:0,sampleDurationMs:0}]);
 assert.equal(c.select(input).reason,'no_common_quality_node');
});

test('quality disabled defaults issue no grants and expired enrolled session does not downgrade',async()=>{
 const disabled=new MediaQualityProbeCoordinator({nodes,defaultNodeId:'relay-primary'});assert.equal(disabled.enabled,false);
 let time=now;const c=ready(()=>time);c.qualitySubmit(user,'client-wifi:1',[sample('relay-primary')]);c.qualitySubmit(gateway,'pixel-cell:99',[sample('relay-primary')]);time+=121000;
 assert.deepEqual(c.select(input),{nodeId:null,reason:'no_common_quality_node'});
 const app=Fastify();registerMediaQualityProbeRoutes(app,disabled,{requireUser:()=>({userId:'u',sessionId:'s'}),requireGateway:()=>({gatewayId:'g',deviceEpoch:1}),mutationOrigin:()=>{},subjectHash:()=>hash,fail:(status,code,message)=>{throw Object.assign(new Error(message),{statusCode:status,code});}});
 try{const response=await app.inject({method:'POST',url:'/api/v1/media/quality-probes/options',payload:{networkGeneration:'a'}});assert.equal(response.statusCode,503);assert.equal(response.json().code,'MEDIA_QUALITY_UNAVAILABLE');}finally{await app.close();}
});
