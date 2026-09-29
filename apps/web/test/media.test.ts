import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeMedia,boundedOperation,mayEndCall,requiresSessionOwnerEnd,ringingEndGuard,shouldRetryTls,validateRelayOptions} from '../src/media-policy.ts';
import {diag} from '../src/diag.ts';
import {CallMedia,REJOIN_CONFLICT_BACKOFF_MS,REJOIN_SPACING_MS,REJOIN_WINDOW_MS,rejoinRetryDelay,rejoinTransport,OPUS_MAX_AVERAGE_BITRATE,OPUS_WIDEBAND_LIMIT,RELAY_SETTLE_MS,rewriteOpusOffer,waitForRelayCandidates} from '../src/media.ts';

const udp={iceServers:[{urls:['turn:relay.example:16801?transport=udp'],username:'user',credential:'credential'}],iceTransportPolicy:'relay' as const};
type TestMediaAPI=<T>(path:string,body?:unknown,method?:string,options?:{signal?:AbortSignal;timeoutMs?:number})=>Promise<T>;
type TestAuthorize=(callId:string,api:TestMediaAPI,transport:'udp'|'tls',signal:AbortSignal)=>Promise<RTCConfiguration>;

test('media authorization repeats the complete probe exactly once after MEDIA_PROBE_REQUIRED',async()=>{
 const generations:string[]=[],requests:unknown[]=[];let probes=0,options=0;
 const measure=async()=>{const value=`generation-${++probes}`;generations.push(value);return value;};
 const api=(async<T>(_path:string,body?:unknown)=>{requests.push(body);if(++options===1)throw Object.assign(new Error('stale'),{code:'MEDIA_PROBE_REQUIRED'});return udp as T;});
 const result=await authorizeMedia('call-1',api,'udp',new AbortController().signal,measure);
 assert.equal(result.iceTransportPolicy,'relay');
 assert.deepEqual(generations,['generation-1','generation-2']);
 assert.deepEqual(requests,[{transport:'udp',networkGeneration:'generation-1'},{transport:'udp',networkGeneration:'generation-2'}]);
});

test('media authorization does not loop after a second stale probe or node unavailable',async()=>{
 for(const code of ['MEDIA_PROBE_REQUIRED','MEDIA_NODE_UNAVAILABLE']){
  let probes=0,requests=0;
  const measure=async()=>`generation-${++probes}`;
  const api=(async<T>()=>{requests++;throw Object.assign(new Error(code),{code});}) as Parameters<typeof authorizeMedia>[1];
  await assert.rejects(authorizeMedia('call-1',api,'udp',new AbortController().signal,measure));
  assert.equal(probes,code==='MEDIA_PROBE_REQUIRED'?2:1);assert.equal(requests,probes);
 }
});

test('relay options require one credentialed URL for the selected transport',()=>{
 assert.deepEqual(validateRelayOptions(udp,'udp').iceServers,udp.iceServers);
 assert.throws(()=>validateRelayOptions({...udp,iceServers:[...udp.iceServers,...udp.iceServers]},'udp'));
 assert.throws(()=>validateRelayOptions(udp,'tls'));
 assert.throws(()=>validateRelayOptions({iceServers:[{urls:['turn:relay?transport=udp','turns:relay?transport=tcp'],username:'u',credential:'c'}],iceTransportPolicy:'relay'},'udp'));
 assert.throws(()=>validateRelayOptions({...udp,iceServers:[{...udp.iceServers[0],urls:['turn:relay.example:70000?transport=udp']}]},'udp'));
 assert.throws(()=>validateRelayOptions({...udp,iceServers:[{...udp.iceServers[0],urls:['turn:user@relay.example:16801?transport=udp']}]},'udp'));
 assert.throws(()=>validateRelayOptions({...udp,iceServers:[{...udp.iceServers[0],urls:['turn:relay.example:16801?transport=udp&extra=1']}]},'udp'));
 assert.throws(()=>validateRelayOptions({...udp,iceServers:[{...udp.iceServers[0],urls:['turn:relay..example:16801?transport=udp']}]},'udp'));
});

test('late microphone result is released after timeout',async()=>{
 let resolve!: (value:{stop:()=>void})=>void,stopped=0;
 const operation=new Promise<{stop:()=>void}>(done=>{resolve=done;});
 await assert.rejects(boundedOperation(operation,new AbortController().signal,1,'timeout',value=>value.stop()),/timeout/);
 resolve({stop:()=>{stopped++;}});
 await new Promise(done=>setTimeout(done,0));
 assert.equal(stopped,1);
});

test('already aborted bounded operation still owns and releases a late result',async()=>{
 let resolve!: (value:{stop:()=>void})=>void,stopped=0;
 const operation=new Promise<{stop:()=>void}>(done=>{resolve=done;}),controller=new AbortController();
 controller.abort();
 const result=boundedOperation(operation,controller.signal,100,'timeout',value=>value.stop());
 await assert.rejects(result,error=>error instanceof DOMException&&error.name==='AbortError');
 resolve({stop:()=>{stopped++;}});
 await new Promise(done=>setTimeout(done,0));
 assert.equal(stopped,1);
});

test('only ringing or this session media call can be ended',()=>{
 assert.equal(mayEndCall({id:'ring',state:'incoming_ringing'},null),true);
 assert.equal(mayEndCall({id:'other',state:'active',claimedByCurrentSession:false},null),false);
 assert.equal(mayEndCall({id:'mine',state:'active',claimedByCurrentSession:true},null),true);
 assert.equal(mayEndCall({id:'mine',state:'connecting'},'mine'),true);
 assert.equal(mayEndCall({id:'mine',state:'unknown',claimedByCurrentSession:true},null),true);
 assert.equal(mayEndCall({id:'other',state:'unknown',claimedByCurrentSession:false},null),false);
 // S38：手机拨号盘发起的通话不归客户端控制，即使本会话正拿着媒体也没有结束按钮。
 assert.equal(mayEndCall({id:'phone',state:'active',claimedByCurrentSession:true,originatingPlatform:'pixel'},'phone'),false);
 assert.equal(mayEndCall({id:'phone',state:'incoming_ringing',originatingPlatform:'pixel'},null),false);
 assert.equal(requiresSessionOwnerEnd({id:'mine',state:'active'}),true);
 assert.equal(requiresSessionOwnerEnd({id:'mine',state:'unknown'}),true);
 assert.equal(requiresSessionOwnerEnd({id:'ring',state:'incoming_ringing'}),false);
 assert.deepEqual(ringingEndGuard({id:'ring',state:'incoming_ringing'}),{onlyIfRinging:true});
 assert.throws(()=>ringingEndGuard({id:'claimed',state:'active'}),/只能用振铃保护/);
});

const RELAY_CANDIDATE='a=candidate:1 1 udp 41885439 203.0.113.9 16803 typ relay raddr 0.0.0.0 rport 0';
const GATHERED_OFFER=['v=0','m=audio 9 UDP/TLS/RTP/SAVPF 111','a=rtpmap:111 opus/48000/2','a=fmtp:111 minptime=10;useinbandfec=1',RELAY_CANDIDATE].join('\r\n')+'\r\n';
type PeerMode='checking'|'connected'|'gathering';
class FakePeer extends EventTarget{
 iceGatheringState:'new'|'gathering'|'complete';
 connectionState:'new'|'connecting'|'connected'|'disconnected'|'failed'|'closed'='new';
 localDescription:RTCSessionDescriptionInit|null=null;
 remoteDescription:RTCSessionDescriptionInit|null=null;
 ontrack:((event:{track:MediaStreamTrack})=>void)|null=null;
 onconnectionstatechange:((event:Event)=>void)|null=null;
 closeCount=0;
 readonly mode:PeerMode;
 readonly remoteTrack={onended:null} as unknown as MediaStreamTrack;
 constructor(mode:PeerMode){super();this.mode=mode;this.iceGatheringState=mode==='gathering'?'gathering':'complete';}
 addTransceiver(){return {setCodecPreferences:()=>{}} as unknown as RTCRtpTransceiver;}
 async createOffer(){return {type:'offer' as RTCSdpType,sdp:GATHERED_OFFER};}
 async setLocalDescription(value:RTCSessionDescriptionInit){this.localDescription=value;}
 async setRemoteDescription(value:RTCSessionDescriptionInit){
  this.remoteDescription=value;this.ontrack?.({track:this.remoteTrack});
  if(this.mode==='connected'){this.connectionState='connected';this.emitConnection();}
 }
 emitConnection(){const event=new Event('connectionstatechange');this.dispatchEvent(event);this.onconnectionstatechange?.(event);}
 emitCandidate(type:'relay'|'srflx'|'host'){this.dispatchEvent(Object.assign(new Event('icecandidate'),{candidate:{type}}));}
 completeGathering(){this.iceGatheringState='complete';this.dispatchEvent(new Event('icegatheringstatechange'));}
 close(){this.closeCount++;this.connectionState='closed';}
}

function mediaFixture(mode:PeerMode,overrides:{connectedTimeoutMs?:number;disconnectGraceMs?:number}={}){
 const browserWindow=new EventTarget(),peer=new FakePeer(mode),localTrack={enabled:true,stopCount:0,stop(){this.stopCount++;}};
 const stream={getTracks:()=>[localTrack],getAudioTracks:()=>[localTrack]} as unknown as MediaStream;
 const audio={autoplay:false,srcObject:null as MediaProvider|null,pauseCount:0,play:async()=>{},pause(){this.pauseCount++;}};
 let offers=0,failures=0,drops=0;
 const instance=new CallMedia(()=>{failures++;},{
  onMediaDrop:()=>{drops++;},
  authorize:async()=>udp,
  getUserMedia:async()=>stream,
  createPeer:()=>peer as unknown as RTCPeerConnection,
  createAudio:()=>audio as unknown as HTMLAudioElement,
  remoteStream:()=>({remote:true}) as unknown as MediaStream,
  audioCodecs:()=>[{mimeType:'audio/opus',clockRate:48000,channels:1}],
  window:browserWindow as unknown as Window,
  connection:new EventTarget(),
  connectedTimeoutMs:overrides.connectedTimeoutMs??20,
  iceTimeoutMs:20,
  disconnectGraceMs:overrides.disconnectGraceMs??20,
 });
 let offered='';
 const api=async<T>(_path?:string,body?:unknown)=>{offers++;offered=(body as {sdp?:string}|undefined)?.sdp??'';return {type:'answer',sdp:'v=0\r\n'} as T;};
 return {instance,browserWindow,peer,localTrack,audio,api,get offers(){return offers;},get offered(){return offered;},get failures(){return failures;},get drops(){return drops;}};
}

function networkRetryFixture(authorize:TestAuthorize,onApi?:TestMediaAPI){
 const connection=new EventTarget(),browserWindow=new EventTarget(),peer=new FakePeer('connected');let microphoneRequests=0;
 const track={enabled:true,stop(){}} as unknown as MediaStreamTrack,stream={getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream;
 const paths:string[]=[];
 const api:TestMediaAPI=async<T>(path,body,method,options)=>{paths.push(path);if(onApi)return onApi<T>(path,body,method,options);return (path.endsWith('/media/offer')?{type:'answer',sdp:'v=0\r\n'}:{}) as T;};
 const instance=new CallMedia(()=>assert.fail('unexpected asynchronous media failure'),{
  authorize,getUserMedia:async()=>{microphoneRequests++;return stream;},createPeer:()=>peer as unknown as RTCPeerConnection,
  createAudio:()=>Object.assign(new EventTarget(),{autoplay:false,srcObject:null,play:async()=>{},pause(){}}) as unknown as HTMLAudioElement,
  remoteStream:()=>stream,audioCodecs:()=>[{mimeType:'audio/opus',clockRate:48000,channels:1}],
  window:browserWindow as unknown as Window,connection,iceTimeoutMs:20,connectedTimeoutMs:20,
 });
 return {instance,connection,api,paths,get microphoneRequests(){return microphoneRequests;}};
}

test('one pre-allocation network change retries a fresh authorization before allocating once',async()=>{
 let attempts=0;const generations:string[]=[];let fixture:ReturnType<typeof networkRetryFixture>;
 const authorize:TestAuthorize=async(callId,api,_transport,signal)=>{
  const generation=`generation-${++attempts}`;generations.push(generation);await api('/media/probes/options',{networkGeneration:generation},undefined,{signal});await api('/media/quality-probes/options',{networkGeneration:generation},undefined,{signal});
  if(attempts===1){fixture.connection.dispatchEvent(new Event('change'));assert.equal(signal.aborted,true);await assert.rejects(api(`/calls/${callId}/media/options`,{networkGeneration:generation},undefined,{signal}),error=>error instanceof DOMException&&error.name==='AbortError');return udp;}
  await api('/media/quality-probes/results',{networkGeneration:generation,samples:[]},undefined,{signal});
  await api(`/calls/${callId}/media/options`,{networkGeneration:generation},undefined,{signal});return udp;
 };
 fixture=networkRetryFixture(authorize);await fixture.instance.start('call-retry',fixture.api);fixture.instance.stop();
 assert.deepEqual(generations,['generation-1','generation-2']);
 assert.equal(fixture.paths.filter(path=>path==='/media/quality-probes/options').length,2);assert.equal(fixture.paths.filter(path=>path==='/media/quality-probes/results').length,1);
 assert.equal(fixture.paths.filter(path=>path==='/calls/call-retry/media/options').length,1);assert.equal(fixture.microphoneRequests,1);
});

test('repeated pre-allocation network changes fail without media allocation',async()=>{
 let attempts=0;let fixture:ReturnType<typeof networkRetryFixture>;
 const authorize:TestAuthorize=async(_callId,api,_transport,signal)=>{await api('/media/probes/options',{networkGeneration:`generation-${++attempts}`},undefined,{signal});fixture.connection.dispatchEvent(new Event('change'));throw new DOMException('changed','AbortError');};
 fixture=networkRetryFixture(authorize);await assert.rejects(fixture.instance.start('call-repeat',fixture.api),error=>error instanceof DOMException&&error.name==='AbortError');
 assert.equal(attempts,2);assert.equal(fixture.paths.some(path=>path.endsWith('/media/options')),false);assert.equal(fixture.microphoneRequests,0);
});

test('user stop during a pending probe never retries or allocates',async()=>{
 let attempts=0;
 const authorize:TestAuthorize=async(_callId,api,_transport,signal)=>{attempts++;await api('/media/probes/options',{},undefined,{signal});return new Promise((_resolve,reject)=>{const abort=()=>reject(new DOMException('stopped','AbortError'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});};
 const fixture=networkRetryFixture(authorize),running=fixture.instance.start('call-stop',fixture.api);await new Promise(resolve=>setTimeout(resolve,0));fixture.instance.stop();
 await assert.rejects(running,error=>error instanceof DOMException&&error.name==='AbortError');assert.equal(attempts,1);assert.equal(fixture.paths.some(path=>path.endsWith('/media/options')),false);assert.equal(fixture.microphoneRequests,0);
});

test('network change during an in-flight allocation aborts without retrying',async()=>{
 let attempts=0;let fixture:ReturnType<typeof networkRetryFixture>;
 const request:TestMediaAPI=async<T>(path,_body,_method,options)=>path.endsWith('/media/options')?new Promise<T>((_resolve,reject)=>{const abort=()=>reject(new DOMException('changed','AbortError'));options?.signal?.addEventListener('abort',abort,{once:true});if(options?.signal?.aborted)abort();}):{} as T;
 const authorize:TestAuthorize=async(callId,api,_transport,signal)=>{attempts++;const pending=api<RTCConfiguration>(`/calls/${callId}/media/options`,{},undefined,{signal});fixture.connection.dispatchEvent(new Event('change'));return pending;};
 fixture=networkRetryFixture(authorize,request);await assert.rejects(fixture.instance.start('call-allocated',fixture.api),error=>error instanceof DOMException&&error.name==='AbortError');
 assert.equal(attempts,1);assert.equal(fixture.paths.filter(path=>path.endsWith('/media/options')).length,1);assert.equal(fixture.microphoneRequests,0);
});

test('CallMedia forever checking reaches deadline and closes tracks and playback',async()=>{
 const fixture=mediaFixture('checking',{connectedTimeoutMs:5});
 await assert.rejects(fixture.instance.start('call-1',fixture.api),/连接超时/);
 assert.equal(fixture.offers,1);assert.equal(fixture.peer.closeCount,1);
 assert.equal(fixture.localTrack.stopCount,1);assert.equal(fixture.audio.pauseCount,1);assert.equal(fixture.audio.srcObject,null);
});

test('CallMedia abort during negotiation closes resources without posting an offer',async()=>{
 const fixture=mediaFixture('gathering');
 const start=fixture.instance.start('call-1',fixture.api);
 await new Promise(resolve=>setTimeout(resolve,0));
 fixture.browserWindow.dispatchEvent(new Event('offline'));
 await assert.rejects(start,error=>error instanceof DOMException&&error.name==='AbortError');
 assert.equal(fixture.offers,0);assert.equal(fixture.peer.closeCount,1);assert.equal(fixture.localTrack.stopCount,1);
});


test('a peer cleanup exception still stops microphone and remote playback',async()=>{
 const fixture=mediaFixture('connected');await fixture.instance.start('call-cleanup',fixture.api);
 fixture.peer.close=()=>{throw new Error('peer already failed');};
 assert.doesNotThrow(()=>fixture.instance.stop());
 assert.equal(fixture.localTrack.stopCount,1);assert.equal(fixture.audio.pauseCount,1);assert.equal(fixture.audio.srcObject,null);
 fixture.instance.stop();assert.equal(fixture.localTrack.stopCount,1);
});

test('CallMedia mute toggles the real microphone track and fails closed without one',async()=>{
 const fixture=mediaFixture('connected');
 assert.equal(fixture.instance.setMuted(true),false);
 await fixture.instance.start('call-muted',fixture.api);
 assert.equal(fixture.instance.setMuted(true),true);assert.equal(fixture.localTrack.enabled,false);
 assert.equal(fixture.instance.setMuted(false),true);assert.equal(fixture.localTrack.enabled,true);
 fixture.instance.stop();
 assert.equal(fixture.instance.setMuted(true),false);
});

const CHROME_OFFER=['v=0','m=audio 9 UDP/TLS/RTP/SAVPF 111 63 126','a=rtpmap:111 opus/48000/2','a=fmtp:111 minptime=10;useinbandfec=1','a=rtpmap:63 red/48000/2','a=fmtp:63 111/111','a=rtpmap:126 telephone-event/8000','a=fmtp:126 0-16'].join('\r\n')+'\r\n';
// S70: the full shared line, spelled out so any drift from iOS/Android/Voice/bridge fails here.
const OPUS_FMTP='minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;maxplaybackrate=16000;sprop-maxcapturerate=16000';

test('Chrome offers keep one rewritten Opus fmtp line at 32 kbps without DTX',()=>{
 assert.equal(OPUS_MAX_AVERAGE_BITRATE,32000);
 const sdp=rewriteOpusOffer(CHROME_OFFER);
 assert.equal(sdp.includes(`a=fmtp:111 ${OPUS_FMTP}\r\n`),true);
 assert.equal(sdp.includes('usedtx'),false,'DTX silence resets the Pixel decoder');
 assert.equal(sdp.includes('maxaveragebitrate=16000'),false);
 assert.equal(sdp.split('\r\n').filter(line=>line.startsWith('a=fmtp:111 ')).length,1);
 assert.equal(sdp.endsWith('\r\n'),true,'CRLF line endings survive the rewrite');
});

test('Firefox offers without minptime are rewritten instead of skipped',()=>{
 const firefox=['v=0','m=audio 9 UDP/TLS/RTP/SAVPF 109','a=rtpmap:109 opus/48000/2','a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1'].join('\r\n')+'\r\n';
 const sdp=rewriteOpusOffer(firefox);
 assert.equal(sdp.includes(`a=fmtp:109 ${OPUS_FMTP}\r\n`),true);
 assert.equal(sdp.includes('maxplaybackrate=48000'),false);
 assert.equal(sdp.includes('stereo=1'),false);
});

test('an offer without an Opus fmtp line gains one right after the rtpmap',()=>{
 const bare=['v=0','m=audio 9 UDP/TLS/RTP/SAVPF 111','a=rtpmap:111 opus/48000/2','a=rtcp-fb:111 transport-cc'].join('\r\n')+'\r\n';
 assert.deepEqual(rewriteOpusOffer(bare).split('\r\n').slice(2,5),['a=rtpmap:111 opus/48000/2',`a=fmtp:111 ${OPUS_FMTP}`,'a=rtcp-fb:111 transport-cc']);
 assert.equal(rewriteOpusOffer('v=0\r\n'),'v=0\r\n','an offer without Opus is untouched');
});

test('only the Opus payload of a multi codec offer is rewritten',()=>{
 const sdp=rewriteOpusOffer(CHROME_OFFER);
 assert.equal(sdp.includes('a=fmtp:63 111/111'),true,'RED keeps its own fmtp');
 assert.equal(sdp.includes('a=fmtp:126 0-16'),true,'telephone-event keeps its own fmtp');
 assert.equal(sdp.split('\r\n').filter(line=>line.includes(OPUS_FMTP)).length,1);
});

test('the offer leaves one settle window after the first relay candidate, without gathering completing',async()=>{
 assert.equal(RELAY_SETTLE_MS,1000);
 const peer=new FakePeer('gathering');let resolved=false;
 const waiting=waitForRelayCandidates(peer as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:120,capMs:4000}).then(()=>{resolved=true;});
 peer.emitCandidate('host');peer.emitCandidate('relay');peer.emitCandidate('relay');
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(resolved,false,'the settle window is still open');
 await waiting;
 assert.equal(resolved,true);
 assert.equal(peer.iceGatheringState,'gathering','gathering never had to complete');
});

test('relay candidates gathered before the cap are offered even when gathering never completes',async()=>{
 const peer=new FakePeer('gathering'),started=Date.now();
 const waiting=waitForRelayCandidates(peer as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:5000,capMs:80});
 peer.emitCandidate('relay');
 await waiting;
 assert.ok(Date.now()-started>=60,'the wait ran to the cap');
 assert.equal(peer.iceGatheringState,'gathering');
});

test('a gathering without any relay candidate fails at the cap with the network timeout',async()=>{
 const peer=new FakePeer('gathering');
 const waiting=waitForRelayCandidates(peer as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:5000,capMs:40});
 peer.emitCandidate('srflx');
 await assert.rejects(waiting,/音频网络连接超时/);
});

test('gathering complete ends the wait immediately once a relay candidate exists',async()=>{
 const peer=new FakePeer('gathering');
 const waiting=waitForRelayCandidates(peer as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:5000,capMs:5000});
 peer.emitCandidate('relay');peer.completeGathering();
 await waiting;
});

test('a relay-only gathering that completes without a relay candidate fails at once',async()=>{
 const peer=new FakePeer('gathering');
 const waiting=waitForRelayCandidates(peer as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:5000,capMs:5000});
 peer.emitCandidate('srflx');peer.completeGathering();
 await assert.rejects(waiting,/未取得中继候选/);
});

test('an already gathered peer is accepted only when its offer carries a relay candidate',async()=>{
 const gathered=new FakePeer('connected');
 gathered.localDescription={type:'offer',sdp:GATHERED_OFFER};
 await waitForRelayCandidates(gathered as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:5000,capMs:5000});
 const empty=new FakePeer('connected');
 empty.localDescription={type:'offer',sdp:['v=0','a=candidate:2 1 udp 2122260223 192.0.2.7 51000 typ host'].join('\r\n')+'\r\n'};
 await assert.rejects(waitForRelayCandidates(empty as unknown as RTCPeerConnection,new AbortController().signal,{settleMs:5000,capMs:5000}),/未取得中继候选/);
});

test('CallMedia posts an offer whose Opus fmtp is the rewritten contract',async()=>{
 const fixture=mediaFixture('connected');
 await fixture.instance.start('call-offer',fixture.api);
 assert.equal(fixture.offered.includes(`a=fmtp:111 ${OPUS_FMTP}`),true);
 assert.equal(fixture.offered.includes('usedtx'),false);
 assert.equal(fixture.offered.includes(RELAY_CANDIDATE),true,'the gathered relay candidate travels with the offer');
 fixture.instance.stop();
});

/** A gathering peer whose offer never carries a relay candidate, so the relay wait hits its cap. */
function noRelayPeer(){const peer=new FakePeer('gathering');peer.createOffer=async()=>({type:'offer' as RTCSdpType,sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n'});return peer;}

function tlsRetryFixture(peers:FakePeer[],offerError?:Error){
 const transports:string[]=[],paths:string[]=[];
 const track={enabled:true,stop(){}} as unknown as MediaStreamTrack,stream={getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream;
 const instance=new CallMedia(()=>{},{
  authorize:async(_callId,_api,transport)=>{transports.push(transport);return udp;},
  getUserMedia:async()=>stream,createPeer:()=>peers.shift() as unknown as RTCPeerConnection,
  createAudio:()=>Object.assign(new EventTarget(),{autoplay:false,srcObject:null,play:async()=>{},pause(){}}) as unknown as HTMLAudioElement,
  remoteStream:()=>stream,audioCodecs:()=>[{mimeType:'audio/opus',clockRate:48000,channels:1}],
  window:new EventTarget() as unknown as Window,connection:new EventTarget(),iceTimeoutMs:20,connectedTimeoutMs:20,
 });
 const api:TestMediaAPI=async<T>(path:string)=>{paths.push(path);if(offerError)throw offerError;return {type:'answer',sdp:'v=0\r\n'} as T;};
 return {instance,api,transports,paths};
}
async function diagEvents(run:()=>Promise<unknown>){
 const posted:{event:string;fields:Record<string,unknown>}[]=[];
 diag.start(async(_path,body)=>{posted.push(...body as typeof posted);});
 await diag.flush();posted.length=0; // S69: drop events other tests left in the pre-login buffer
 try{await run();}finally{await diag.stop();}
 return posted.filter(item=>item.event.startsWith('media.'));
}

test('shouldRetryTls only covers UDP relay-stage failures',()=>{
 for(const code of ['NO_RELAY_CANDIDATE','ICE_FAILED','ICE_TIMEOUT'])assert.equal(shouldRetryTls(Object.assign(new Error('x'),{code}),'udp'),true);
 assert.equal(shouldRetryTls(Object.assign(new Error('x'),{code:'ICE_TIMEOUT'}),'tls'),false);
 assert.equal(shouldRetryTls(new DOMException('媒体连接已取消','AbortError'),'udp'),false);
 assert.equal(shouldRetryTls(Object.assign(new Error('x'),{status:401,code:'UNAUTHORIZED'}),'udp'),false);
 assert.equal(shouldRetryTls(Object.assign(new Error('x'),{code:'MEDIA_BRIDGE_UNAVAILABLE'}),'udp'),false);
 assert.equal(shouldRetryTls(new Error('通话音频连接超时'),'udp'),false);
 assert.equal(shouldRetryTls(new DOMException('denied','NotAllowedError'),'udp'),false);
});

test('a UDP relay timeout retries once over TLS before any offer and logs media.failed + media.retry_tls',async()=>{
 const fixture=tlsRetryFixture([noRelayPeer(),new FakePeer('connected')]);
 const events=await diagEvents(async()=>{await fixture.instance.start('call-tls',fixture.api,'udp');fixture.instance.stop();});
 assert.deepEqual(fixture.transports,['udp','tls']);
 assert.deepEqual(fixture.paths,['/calls/call-tls/media/offer']);
 const failed=events.find(item=>item.event==='media.failed');
 assert.equal(failed?.fields.stage,'relay');assert.equal(failed?.fields.transport,'udp');assert.match(String(failed?.fields.message),/音频网络连接超时/);
 assert.deepEqual(events.find(item=>item.event==='media.retry_tls')?.fields.code,'ICE_TIMEOUT');
});

test('TLS failures, post-offer failures and bridge rejections never retry',async()=>{
 const tls=tlsRetryFixture([noRelayPeer()]);
 await assert.rejects(tls.instance.start('call-a',tls.api,'tls'),/音频网络连接超时/);assert.deepEqual(tls.transports,['tls']);
 const postOffer=tlsRetryFixture([new FakePeer('checking'),new FakePeer('connected')]);
 const events=await diagEvents(()=>assert.rejects(postOffer.instance.start('call-b',postOffer.api,'udp'),/通话音频连接超时/));
 assert.deepEqual(postOffer.transports,['udp']);assert.equal(postOffer.paths.length,1);
 assert.equal(events.find(item=>item.event==='media.failed')?.fields.stage,'connect');
 const rejected=tlsRetryFixture([new FakePeer('connected'),new FakePeer('connected')],Object.assign(new Error('bridge'),{code:'MEDIA_BRIDGE_UNAVAILABLE'}));
 await assert.rejects(rejected.instance.start('call-c',rejected.api,'udp'),/bridge/);assert.deepEqual(rejected.transports,['udp']);
});

test('early authorization failures are logged as media.failed at the options stage',async()=>{
 const instance=new CallMedia(()=>{},{authorize:async()=>{throw Object.assign(new Error('expired'),{status:401});},window:new EventTarget() as unknown as Window,connection:new EventTarget()});
 const events=await diagEvents(()=>assert.rejects(instance.start('call-d',(async()=>({})) as TestMediaAPI,'udp'),/expired/));
 assert.deepEqual(events.map(item=>[item.event,item.fields.stage]),[['media.failed','options']]);
});

test('S70 wideband limit is its own constant appended to the Opus fmtp',()=>{
 assert.equal(OPUS_WIDEBAND_LIMIT,'maxplaybackrate=16000;sprop-maxcapturerate=16000');
 assert.equal(rewriteOpusOffer(CHROME_OFFER).includes(`a=fmtp:111 ${OPUS_FMTP}\r\n`),true);
});

test('S70 a connected call ends with media.summary carrying rx/tx',async()=>{
 const peer=new FakePeer('connected') as FakePeer&{getStats:()=>Promise<RTCStatsReport>};
 peer.getStats=async()=>new Map([['a',{type:'inbound-rtp',kind:'audio',packetsReceived:500,packetsLost:3,concealedSamples:960,concealmentEvents:2,jitter:0.012}],['b',{type:'outbound-rtp',kind:'audio',packetsSent:480,bytesSent:38000}]]) as unknown as RTCStatsReport;
 const fixture=tlsRetryFixture([peer]);
 const events=await diagEvents(async()=>{await fixture.instance.start('call-sum',fixture.api,'udp');await new Promise(resolve=>setTimeout(resolve,0));fixture.instance.stop();});
 const summary=events.find(item=>item.event==='media.summary');
 assert.deepEqual(summary?.fields.rx,{packetsReceived:500,packetsLost:3,concealedSamples:960,concealmentEvents:2,jitterMs:12});
 assert.deepEqual(summary?.fields.tx,{packetsSent:480,bytesSent:38000});
});

test('S73 rejoin policy: attempt 1 keeps the connected transport, 2–3 swap UDP↔TLS, then the 3-attempt / 60 s limit',()=>{
 assert.deepEqual([1,2,3,4].map(attempt=>rejoinTransport(attempt,0,'udp')),['udp','tls','tls',null]);
 assert.deepEqual([1,2,3].map(attempt=>rejoinTransport(attempt,0,'tls')),['tls','udp','udp']);
 assert.equal(rejoinTransport(2,REJOIN_WINDOW_MS-1,'udp'),'tls');
 assert.equal(rejoinTransport(1,REJOIN_WINDOW_MS,'udp'),null);
});

function statsPeer(mode:PeerMode){const peer=new FakePeer(mode) as FakePeer&{getStats:()=>Promise<RTCStatsReport>};peer.getStats=async()=>new Map() as unknown as RTCStatsReport;return peer;}
function rejoinFixture(peers:FakePeer[],offer:(count:number)=>void=()=>{},authorizeHook:(rejoin:boolean)=>void=()=>{}){
 const transports:string[]=[],rejoinFlags:boolean[]=[],reconnecting:boolean[]=[];let failures=0,offers=0,microphones=0;
 const track={enabled:true,stopCount:0,stop(){this.stopCount++;}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream;
 const all=[...peers],browserWindow=new EventTarget(),connection=new EventTarget();
 const instance=new CallMedia(()=>{failures++;},{
  authorize:async(_callId,_api,transport,_signal,rejoin)=>{transports.push(transport);rejoinFlags.push(rejoin===true);authorizeHook(rejoin===true);return udp;},
  getUserMedia:async()=>{microphones++;return stream;},createPeer:()=>peers.shift() as unknown as RTCPeerConnection,
  createAudio:()=>Object.assign(new EventTarget(),{autoplay:false,srcObject:null,play:async()=>{},pause(){}}) as unknown as HTMLAudioElement,
  remoteStream:()=>stream,audioCodecs:()=>[{mimeType:'audio/opus',clockRate:48000,channels:1}],
  window:browserWindow as unknown as Window,connection,iceTimeoutMs:20,connectedTimeoutMs:20,disconnectGraceMs:5,rejoinBackoffMs:5,rejoinSpacingMs:5,rejoinNetworkRetryMs:5,
  onReconnecting:active=>reconnecting.push(active),
 });
 const api:TestMediaAPI=async<T>()=>{offer(++offers);return {type:'answer',sdp:'v=0\r\n'} as T;};
 return {instance,api,track,all,transports,rejoinFlags,reconnecting,browserWindow,connection,get failures(){return failures;},get microphones(){return microphones;}};
}
const until=async(done:()=>boolean)=>{for(let i=0;i<200&&!done();i++)await new Promise(resolve=>setTimeout(resolve,5));};

test('S73 an established call rejoins on a new peer after the disconnect grace, keeping microphone and mute',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('connected')]);
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-rejoin',fixture.api,'udp');fixture.instance.setMuted(true);
  const first=fixture.all[0]!;first.connectionState='disconnected';first.emitConnection();
  await until(()=>fixture.reconnecting.length===2);
  assert.equal(first.closeCount,1);assert.equal(fixture.all[1]!.remoteDescription!==null,true);
  assert.equal(fixture.failures,0);assert.equal(fixture.track.stopCount,0);assert.equal(fixture.track.enabled,false);assert.equal(fixture.microphones,1);
  fixture.instance.stop();
 });
 assert.deepEqual(fixture.transports,['udp','udp']);assert.deepEqual(fixture.reconnecting,[true,false]);
 assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(({fields:{attempt,reason,transport,ms,ok}})=>({attempt,reason,transport,ms:typeof ms,ok})),[{attempt:1,reason:'disconnected',transport:'udp',ms:'number',ok:true}]);
 const rejoin=events.find(item=>item.event==='media.rejoin')!.fields as {ms:number;downMs:number};
 assert.ok(rejoin.downMs>=rejoin.ms+4,'S75: downMs 从首次 disconnected 起算，含 5 ms 宽限（取整留 1 ms）');
 assert.equal(events.find(item=>item.event==='media.summary')?.fields.rejoins,1);
});

test('S73 a wrapped bridge 409 (503 MEDIA_BRIDGE_UNAVAILABLE) backs off, counts as an attempt and the next attempt swaps transport',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('connected'),statsPeer('connected')],count=>{if(count===2)throw Object.assign(new Error('leg still connected'),{status:503,code:'MEDIA_BRIDGE_UNAVAILABLE'});});
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-409',fixture.api,'udp');
  const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
  await until(()=>fixture.reconnecting.length===2);fixture.instance.stop();
 });
 assert.deepEqual(fixture.transports,['udp','udp','tls']);assert.equal(fixture.failures,0);
 assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(item=>[item.fields.attempt,item.fields.reason,item.fields.transport,item.fields.ok]),[[1,'failed','udp',false],[2,'failed','tls',true]]);
});

test('S73 retry pacing: bridge conflicts back off 2 s, fast failures wait 15 s from the previous start, other 4xx stop',()=>{
 assert.equal(rejoinRetryDelay(Object.assign(new Error('x'),{status:409}),100),REJOIN_CONFLICT_BACKOFF_MS);
 assert.equal(rejoinRetryDelay(Object.assign(new Error('x'),{status:503,code:'MEDIA_BRIDGE_UNAVAILABLE'}),100),REJOIN_CONFLICT_BACKOFF_MS);
 assert.equal(rejoinRetryDelay(new TypeError('Failed to fetch'),1000),REJOIN_SPACING_MS-1000);
 assert.equal(rejoinRetryDelay(new Error('通话音频连接超时'),REJOIN_SPACING_MS+1),0);
 assert.equal(rejoinRetryDelay(Object.assign(new Error('x'),{status:503,code:'OTHER'}),0),REJOIN_SPACING_MS);
 for(const status of [401,403,404])assert.equal(rejoinRetryDelay(Object.assign(new Error('x'),{status}),0),null);
});

test('S73 a revoked call (4xx) stops rejoining at once through the existing failure path',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('connected')],count=>{if(count===2)throw Object.assign(new Error('gone'),{status:404,code:'NOT_FOUND'});});
 await fixture.instance.start('call-gone',fixture.api,'udp');
 const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
 await until(()=>fixture.failures>0);
 assert.equal(fixture.failures,1);assert.deepEqual(fixture.transports,['udp','udp']);assert.deepEqual(fixture.reconnecting,[true,false]);
});

test('S73 three failed rejoins fall through to the existing failure path once',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('checking'),statsPeer('checking'),statsPeer('checking')]);
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-lost',fixture.api,'udp');
  const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
  await until(()=>fixture.failures>0);
 });
 assert.equal(fixture.failures,1);assert.deepEqual(fixture.transports,['udp','udp','tls','tls']);assert.deepEqual(fixture.reconnecting,[true,false]);
 assert.equal(fixture.track.stopCount,1);assert.equal(fixture.all.every(peer=>peer.closeCount===1),true);
 assert.equal(events.filter(item=>item.event==='media.rejoin'&&item.fields.ok===false).length,3);
 assert.equal(events.find(item=>item.event==='media.summary')?.fields.rejoins,0);
});

test('S73 hanging up during a rejoin stops quietly without the failure path',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('gathering')]);
 await fixture.instance.start('call-hangup',fixture.api,'udp');
 const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
 await until(()=>fixture.transports.length===2);fixture.instance.stop();await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(fixture.failures,0);assert.deepEqual(fixture.reconnecting,[true,false]);assert.equal(fixture.track.stopCount,1);assert.equal(fixture.all[1]!.closeCount,1);
});

test('S73 a rejoin peer that fails before connecting only fails that attempt, not the call',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('checking'),statsPeer('connected')]);
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-refail',fixture.api,'udp');
  const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
  await until(()=>fixture.all[1]!.remoteDescription!==null);
  const second=fixture.all[1]!;second.connectionState='failed';second.emitConnection();
  await until(()=>fixture.reconnecting.length===2);fixture.instance.stop();
 });
 assert.equal(fixture.failures,0);assert.deepEqual(fixture.transports,['udp','udp','tls']);assert.deepEqual(fixture.reconnecting,[true,false]);
 assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(item=>item.fields.ok),[false,true]);
});

test('S73c failures while offline consume no attempt and keep the transport; retry on the online event or the 500 ms poll',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');let onLine=true;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{get onLine(){return onLine;}}});
 try{
  // 4 次断网失败（多于 3 次上限）后恢复：一次也不计数、不换 TLS、不走失败路径。
  const fixture=rejoinFixture([1,2,3,4,5,6].map(()=>statsPeer('connected')),count=>{if(count>=2&&count<=5)throw new TypeError('Failed to fetch');});
  const events=await diagEvents(async()=>{
   await fixture.instance.start('call-offline',fixture.api,'udp');
   onLine=false;const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
   for(let offers=2;offers<=4;offers++){await until(()=>fixture.transports.length===offers);await new Promise(resolve=>setTimeout(resolve,10));fixture.browserWindow.dispatchEvent(new Event('online'));}
   await until(()=>fixture.transports.length===5);await new Promise(resolve=>setTimeout(resolve,10));
   onLine=true;// 不发事件：靠 500 ms 轮询发现恢复。
   for(let i=0;i<30&&fixture.reconnecting.length<2;i++)await new Promise(resolve=>setTimeout(resolve,50));
   fixture.instance.stop();
  });
  assert.equal(fixture.failures,0);assert.deepEqual(fixture.reconnecting,[true,false]);
  assert.deepEqual(fixture.transports,['udp','udp','udp','udp','udp','udp']);
  assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(item=>[item.fields.attempt,item.fields.transport,item.fields.ok,item.fields.offline]),
   [[1,'udp',false,true],[1,'udp',false,true],[1,'udp',false,true],[1,'udp',false,true],[1,'udp',true,undefined]]);
  // S75：ms 是单次尝试耗时，downMs 是本次断线起的累计时长（单调不减、始终 ≥ 单次）。
  const rejoins=events.filter(item=>item.event==='media.rejoin').map(item=>item.fields as {ms:number;downMs:number});
  rejoins.forEach((item,index)=>{assert.ok(item.downMs>=item.ms);if(index)assert.ok(item.downMs>=rejoins[index-1]!.downMs);});
  assert.ok(rejoins.at(-1)!.downMs>=rejoins.reduce((sum,item)=>sum+item.ms,0));
 }finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete (globalThis as {navigator?:unknown}).navigator;}
});

test('S73h an episode that went offline makes the first post-online attempt UDP (then swaps); an online drop keeps today\'s rule',async()=>{
 assert.deepEqual([2,3].map(attempt=>rejoinTransport(attempt,0,'udp',2)),['udp','tls']);
 assert.equal(rejoinTransport(4,0,'udp',3),null);
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');let onLine=true;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{get onLine(){return onLine;}}});
 try{
  // 已建立的 TLS 腿在离线时断：离线尝试仍用 TLS 且不计次；恢复后首次 UDP（失败，计次），下一次换 TLS。
  const fixture=rejoinFixture([statsPeer('connected'),statsPeer('connected'),statsPeer('checking'),statsPeer('connected')],count=>{if(count===2)throw new TypeError('Failed to fetch');});
  const events=await diagEvents(async()=>{
   await fixture.instance.start('call-offline-tls',fixture.api,'tls');
   onLine=false;const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
   await until(()=>fixture.transports.length===2);await new Promise(resolve=>setTimeout(resolve,10));
   onLine=true;fixture.browserWindow.dispatchEvent(new Event('online'));
   await until(()=>fixture.reconnecting.length===2);fixture.instance.stop();
  });
  assert.equal(fixture.failures,0);assert.deepEqual(fixture.transports,['tls','tls','udp','tls']);
  assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(item=>[item.fields.attempt,item.fields.transport,item.fields.ok,item.fields.offline]),
   [[1,'tls',false,true],[1,'udp',false,undefined],[2,'tls',true,undefined]]);
  // 在线断线（从未离线）：TLS 腿第 1 次仍用 TLS。
  const online=rejoinFixture([statsPeer('connected'),statsPeer('connected')]);
  await online.instance.start('call-online-tls',online.api,'tls');
  const leg=online.all[0]!;leg.connectionState='failed';leg.emitConnection();
  await until(()=>online.reconnecting.length===2);online.instance.stop();
  assert.deepEqual(online.transports,['tls','tls']);assert.equal(online.failures,0);
  // S73e 离线建立在 TLS 上失败（UDP→TLS 后）：恢复后首次 UDP。
  onLine=false;
  const setup=rejoinFixture([1,2,3].map(()=>statsPeer('connected')),()=>{if(!onLine)throw new TypeError('Failed to fetch');});
  const started=setup.instance.start('call-setup-tls',setup.api,'tls');
  await until(()=>setup.transports.length===2);await new Promise(resolve=>setTimeout(resolve,10));
  onLine=true;setup.browserWindow.dispatchEvent(new Event('online'));
  await started;setup.instance.stop();
  assert.deepEqual(setup.transports,['tls','tls','udp']);assert.equal(setup.failures,0);
 }finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete (globalThis as {navigator?:unknown}).navigator;}
});

test('S73d rejoin attempts skip the media-node probe (authorize gets rejoin=true) and log probeSkipped',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('connected')]);
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-noprobe',fixture.api,'udp');
  const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
  await until(()=>fixture.reconnecting.length===2);fixture.instance.stop();
 });
 assert.deepEqual(fixture.rejoinFlags,[false,true]);
 assert.equal(events.find(item=>item.event==='media.rejoin')?.fields.probeSkipped,true);
});

test('S73d a network change during a rejoin attempt consumes no attempt and keeps the transport',async()=>{
 const fixture:ReturnType<typeof rejoinFixture>=rejoinFixture([1,2,3,4,5].map(()=>statsPeer('connected')),count=>{if(count>=2&&count<=4)fixture.connection.dispatchEvent(new Event('change'));});
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-flap',fixture.api,'udp');
  const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
  await until(()=>fixture.reconnecting.length===2);fixture.instance.stop();
 });
 assert.equal(fixture.failures,0);assert.deepEqual(fixture.transports,['udp','udp','udp','udp','udp']);
 assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(item=>[item.fields.attempt,item.fields.transport,item.fields.ok,item.fields.code]),
  [[1,'udp',false,'NETWORK_CHANGED'],[1,'udp',false,'NETWORK_CHANGED'],[1,'udp',false,'NETWORK_CHANGED'],[1,'udp',true,undefined]]);
});

test('S73g a skipped-probe rejoin answered 409 MEDIA_PROBE_REQUIRED retries at once with the probe, uncounted, same transport',async()=>{
 const fixture=rejoinFixture([statsPeer('connected'),statsPeer('connected')],()=>{},rejoin=>{if(rejoin)throw Object.assign(new Error('Media probe required'),{status:409,code:'MEDIA_PROBE_REQUIRED'});});
 const events=await diagEvents(async()=>{
  await fixture.instance.start('call-probe-required',fixture.api,'udp');
  const first=fixture.all[0]!;first.connectionState='failed';first.emitConnection();
  await until(()=>fixture.reconnecting.length===2);fixture.instance.stop();
 });
 assert.equal(fixture.failures,0);assert.deepEqual(fixture.transports,['udp','udp','udp']);assert.deepEqual(fixture.rejoinFlags,[false,true,false]);
 assert.deepEqual(events.filter(item=>item.event==='media.rejoin').map(item=>[item.fields.attempt,item.fields.ok,item.fields.probeSkipped,item.fields.code]),
  [[1,false,true,'MEDIA_PROBE_REQUIRED'],[1,true,false,undefined]]);
});

test('S73e setup failing while offline waits for online and retries (uncounted, S73g: probe skipped); online setup failures still reject',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');let onLine=false;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{get onLine(){return onLine;}}});
 try{
  const fixture=rejoinFixture([1,2,3].map(()=>statsPeer('connected')),()=>{if(!onLine)throw new TypeError('Failed to fetch');});
  const events=await diagEvents(async()=>{
   const started=fixture.instance.start('call-setup-offline',fixture.api,'udp');
   await until(()=>fixture.transports.length===2);await new Promise(resolve=>setTimeout(resolve,10));
   onLine=true;fixture.browserWindow.dispatchEvent(new Event('online'));
   await started;fixture.instance.stop();
  });
  assert.equal(fixture.failures,0);assert.deepEqual(fixture.reconnecting,[true,false]);assert.equal(fixture.microphones,1);
  assert.deepEqual(fixture.transports,['udp','udp','udp']);assert.deepEqual(fixture.rejoinFlags,[false,true,true]);
  assert.equal(events.filter(item=>item.event==='media.retry_tls').length,0);
  const rows=events.filter(item=>item.event==='media.rejoin').map(item=>item.fields);
  assert.deepEqual(rows.map(({attempt,reason,transport,ok,offline,probeSkipped})=>[attempt,reason,transport,ok,offline,probeSkipped]),
   [[1,'setup_offline','udp',false,true,true],[1,'setup_offline','udp',true,undefined,true]]);
  rows.forEach(item=>{assert.equal(typeof item.ms,'number');assert.equal(typeof item.downMs,'number');});
  // 在线时首次建立失败不变：直接抛出，不重连、不走 onFailure。
  onLine=true;
  const online=rejoinFixture([statsPeer('checking')]);
  await assert.rejects(online.instance.start('call-setup-online',online.api,'tls'),/通话音频连接超时/);
  assert.equal(online.failures,0);assert.deepEqual(online.transports,['tls']);assert.deepEqual(online.reconnecting,[]);
 }finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete (globalThis as {navigator?:unknown}).navigator;}
});
