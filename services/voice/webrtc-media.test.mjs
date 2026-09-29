import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientMediaPeer, OPUS_WIDEBAND_LIMIT, rewriteOpusOffer } from './webrtc-media.mjs';

const callId='00000000-0000-4000-8000-000000000001';
const relayOptions={mediaNodeId:'test',mediaEpoch:1,iceTransportPolicy:'relay',iceServers:[{urls:'turn:test.invalid:16801?transport=udp'}]};
const tlsOptions={...relayOptions,iceServers:[{urls:['turns:test.invalid:16802?transport=tcp']}]};

function fakeWrtc({addTrackError,setLocalDescription}={}) {
  const state={pcs:[],tracks:[]};
  class PC {
    constructor(){this.connectionState='new';this.iceGatheringState='complete';this.closed=false;state.pcs.push(this)}
    addTrack(){if(addTrackError)throw addTrackError}
    createOffer(){return Promise.resolve({type:'offer',sdp:'offer'})}
    setLocalDescription(value){this.localDescription=value;return setLocalDescription?.(this,value)??Promise.resolve()}
    setRemoteDescription(){this.connectionState='connected';return Promise.resolve()}
    close(){this.closed=true;this.connectionState='closed'}
  }
  class Source {createTrack(){const track={stopped:false,stop(){this.stopped=true}};state.tracks.push(track);return track}}
  return {wrtc:{RTCPeerConnection:PC,nonstandard:{RTCAudioSource:Source,RTCAudioSink:class{stop(){}}}},state};
}

test('one deadline bounds signaling options that ignore AbortSignal',async()=>{
  const {wrtc,state}=fakeWrtc();const started=Date.now();
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,timeoutMs:1000,signaling:{options:()=>new Promise(()=>{})}}),/timed out/);
  assert.ok(Date.now()-started<1600);assert.equal(state.pcs.length,0);
});

test('partial native initialization is cleaned when addTrack throws',async()=>{
  const {wrtc,state}=fakeWrtc({addTrackError:new Error('addTrack failed')});
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,timeoutMs:1000,signaling:{options:async()=>relayOptions}}),/addTrack failed/);
  assert.equal(state.pcs[0].closed,true);assert.equal(state.tracks[0].stopped,true);
});

test('external lease abort bounds an ignored native promise and closes resources',async()=>{
  const controller=new AbortController();const {wrtc,state}=fakeWrtc({setLocalDescription:()=>new Promise(()=>{})});
  const connected=ClientMediaPeer.connect({wrtc,callId,timeoutMs:5000,signal:controller.signal,signaling:{options:async()=>relayOptions}});
  setImmediate(()=>controller.abort(new Error('lease lost')));
  await assert.rejects(connected,/lease lost/);assert.equal(state.pcs[0].closed,true);assert.equal(state.tracks[0].stopped,true);
});

test('peer constructor refuses an already aborted lifetime without leaking native handles',()=>{
  const controller=new AbortController();controller.abort(new Error('already revoked'));
  const pc={onconnectionstatechange:null,close(){this.closed=true}};const track={stop(){this.stopped=true}};
  assert.throws(()=>new ClientMediaPeer({wrtc:{},pc,source:{},sourceTrack:track,sink:null,callId,mediaNodeId:'test',mediaEpoch:1,signal:controller.signal}),/already revoked/);
  assert.equal(pc.closed,true);assert.equal(track.stopped,true);
});

test('S25 决策 10: a transient ICE disconnect is tolerated for the grace period and only faults when it lasts', async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const makePc=()=>({connectionState:'connected',iceConnectionState:'connected',onconnectionstatechange:null,close(){this.closed=true;this.connectionState='closed'},getStats:async()=>new Map()});
  const track=()=>({stop(){this.stopped=true}});
  // Recovers inside the grace window: no fault, one disconnected + one reconnected notice.
  const pc1=makePc();const peer1=new ClientMediaPeer({wrtc:{},pc:pc1,source:{},sourceTrack:track(),sink:null,callId,mediaNodeId:'test',mediaEpoch:1,disconnectGraceMs:40});
  const seen=[];for(const name of ['fault','disconnected','reconnected'])peer1.on(name,()=>seen.push(name));
  pc1.connectionState='disconnected';pc1.onconnectionstatechange();await wait(10);
  pc1.connectionState='connected';pc1.onconnectionstatechange();await wait(60);
  assert.deepEqual(seen,['disconnected','reconnected']);peer1.close();
  // Stays disconnected past the grace window: exactly one fault carrying the ICE snapshot.
  const pc2=makePc();const peer2=new ClientMediaPeer({wrtc:{},pc:pc2,source:{},sourceTrack:track(),sink:null,callId,mediaNodeId:'test',mediaEpoch:1,disconnectGraceMs:30});
  const faults=[];peer2.on('fault',error=>faults.push(error));
  pc2.connectionState='disconnected';pc2.onconnectionstatechange();await wait(10);assert.equal(faults.length,0);
  await wait(50);assert.equal(faults.length,1);assert.match(faults[0].message,/disconnected/);assert.equal(faults[0].iceStats.connectionState,'disconnected');
  // `failed` never waits.
  const pc3=makePc();const peer3=new ClientMediaPeer({wrtc:{},pc:pc3,source:{},sourceTrack:track(),sink:null,callId,mediaNodeId:'test',mediaEpoch:1,disconnectGraceMs:1000});
  const fast=[];peer3.on('fault',error=>fast.push(error));pc3.connectionState='failed';pc3.onconnectionstatechange();await wait(20);assert.equal(fast.length,1);peer2.close();peer3.close();
});

test('S70d: inboundRtp fires once when audio inbound-rtp counts a packet', async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let packets=0,polls=0;
  const pc={connectionState:'connected',onconnectionstatechange:null,close(){},getStats:async()=>{polls++;return new Map([['v',{type:'inbound-rtp',kind:'video',packetsReceived:9}],['a',{type:'inbound-rtp',kind:'audio',packetsReceived:packets}]])}};
  const peer=new ClientMediaPeer({wrtc:{},pc,source:{},sourceTrack:{stop(){}},sink:null,callId,mediaNodeId:'test',mediaEpoch:1,inboundRtpPollMs:5});
  let fired=0;peer.on('inboundRtp',()=>fired++);
  await wait(30);assert.equal(fired,0,'video packets or zero audio packets must not count');assert.equal(polls>1,true);
  packets=1;await wait(30);assert.equal(fired,1);
  // S73f: polling continues (for gap detection) but `inboundRtp` stays one-shot.
  packets=5;await wait(30);assert.equal(fired,1);peer.close();
});

test('S73f: a stalled inbound RTP count is a mediaGap, and growth after it is mediaResumed', async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let packets=0;
  const pc={connectionState:'connected',onconnectionstatechange:null,close(){},getStats:async()=>new Map([['a',{type:'inbound-rtp',kind:'audio',packetsReceived:packets}]])};
  const peer=new ClientMediaPeer({wrtc:{},pc,source:{},sourceTrack:{stop(){}},sink:null,callId,mediaNodeId:'test',mediaEpoch:1,inboundRtpPollMs:5,inboundRtpWatchMs:5,inboundRtpGapMs:40});
  const events=[];for(const name of ['inboundRtp','mediaGap','mediaResumed'])peer.on(name,value=>events.push([name,value]));
  // No packet yet: never a gap (the first-packet wait belongs to the greeting fallback).
  await wait(80);assert.deepEqual(events,[]);
  // Packets flowing (a silent caller still sends RTP): no gap.
  for(let i=0;i<8;i++){packets++;await wait(10);}
  assert.deepEqual(events.map(e=>e[0]),['inboundRtp']);
  await wait(80);assert.deepEqual(events.map(e=>e[0]),['inboundRtp','mediaGap'],'one gap, reported once');
  assert.equal(events[1][1].sinceMs>40,true);
  packets++;await wait(20);
  assert.deepEqual(events.map(e=>e[0]),['inboundRtp','mediaGap','mediaResumed']);
  assert.equal(events[2][1].gapMs>=80,true);
  peer.close();
});

test('S70d: the inbound RTP poller stops on close and a throwing getStats keeps polling', async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let polls=0;
  const pc={connectionState:'connected',onconnectionstatechange:null,close(){},getStats:async()=>{polls++;throw new Error('boom')}};
  const peer=new ClientMediaPeer({wrtc:{},pc,source:{},sourceTrack:{stop(){}},sink:null,callId,mediaNodeId:'test',mediaEpoch:1,inboundRtpPollMs:5});
  let fired=0;peer.on('inboundRtp',()=>fired++);
  await wait(30);assert.equal(polls>1,true);peer.close();
  const after=polls;await wait(30);assert.equal(polls,after,'no poll after close');assert.equal(fired,0);
});

function gatheringWrtc({candidates=[],gatheringState='gathering'}={}) {
  const state={pcs:[],offers:[]};
  class PC {
    constructor(){this.connectionState='new';this.iceGatheringState=gatheringState;this.closed=false;state.pcs.push(this)}
    addTrack(){}
    createOffer(){return Promise.resolve({type:'offer',sdp:'offer'})}
    setLocalDescription(value){
      this.localDescription=value;
      // Real agents only start gathering here, which is why the watcher must already be attached.
      for(const candidate of candidates)setTimeout(()=>this.onicecandidate?.({candidate:{candidate}}),1);
      return Promise.resolve();
    }
    setRemoteDescription(){this.connectionState='connected';return Promise.resolve()}
    close(){this.closed=true;this.connectionState='closed'}
  }
  class Source {createTrack(){return {stop(){}}}}
  const signaling={
    options:async()=>relayOptions,
    offer:async(_callId,description)=>{state.offers.push(description);return {type:'answer',sdp:'answer'};},
  };
  return {wrtc:{RTCPeerConnection:PC,nonstandard:{RTCAudioSource:Source,RTCAudioSink:class{stop(){}}}},state,signaling};
}
const RELAY='candidate:1 1 udp 2130706431 192.0.2.21 16803 typ relay raddr 0.0.0.0 rport 0';
const HOST='candidate:2 1 udp 2130706431 192.0.2.24 51000 typ host';

test('the offer follows the first relay candidate and never waits for a completion that never comes',async()=>{
  const {wrtc,state,signaling}=gatheringWrtc({candidates:[RELAY,HOST]});
  const started=Date.now();
  const peer=await ClientMediaPeer.connect({wrtc,callId,signaling,timeoutMs:5000,relaySettleMs:20,gatheringCapMs:4000});
  assert.equal(state.offers.length,1);
  assert.ok(Date.now()-started<1000,'the offer waited for iceGatheringState complete');
  assert.equal(state.pcs[0].iceGatheringState,'gathering','completion is an early exit, never a requirement');
  peer.close();
});

test('non-relay candidates alone never post an offer and fail at the gathering cap',async()=>{
  const {wrtc,state,signaling}=gatheringWrtc({candidates:[HOST]});
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,signaling,timeoutMs:5000,relaySettleMs:20,gatheringCapMs:60}),/no relay candidate/);
  assert.equal(state.offers.length,0);
  assert.equal(state.pcs[0].closed,true);
});

test('an ICE gathering that completes without any candidate still proceeds exactly as before',async()=>{
  const {wrtc,state,signaling}=gatheringWrtc({gatheringState:'complete'});
  const peer=await ClientMediaPeer.connect({wrtc,callId,signaling,timeoutMs:5000,relaySettleMs:5000,gatheringCapMs:5000});
  assert.equal(state.offers.length,1);
  peer.close();
});

test('a lease abort during gathering cancels the watcher and closes the peer connection',async()=>{
  const controller=new AbortController();
  const {wrtc,state,signaling}=gatheringWrtc();
  const connected=ClientMediaPeer.connect({wrtc,callId,signaling,signal:controller.signal,timeoutMs:5000,relaySettleMs:20,gatheringCapMs:4000});
  setTimeout(()=>controller.abort(new Error('authority revoked')),5);
  await assert.rejects(connected,/authority revoked/);
  assert.equal(state.offers.length,0);
  assert.equal(state.pcs[0].closed,true);
});

test('S23: the configured transport reaches Control and only a matching TURN URL is accepted',async()=>{
  const {wrtc}=fakeWrtc();const asked=[];
  const signaling={options:async(_callId,transport)=>{asked.push(transport);return tlsOptions;},offer:async()=>({type:'answer',sdp:'answer'})};
  const peer=await ClientMediaPeer.connect({wrtc,callId,signaling,transport:'tls',timeoutMs:5000});
  assert.deepEqual(asked,['tls'],'Control was not told which relay transport to issue');
  peer.close();
  // A TLS request answered with the plain UDP relay URL would silently keep the lossy path.
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,timeoutMs:5000,transport:'tls',
    signaling:{options:async()=>relayOptions}}),/does not match the requested transport/);
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,timeoutMs:5000,
    signaling:{options:async()=>tlsOptions}}),/does not match the requested transport/);
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,timeoutMs:5000,transport:'tcp',
    signaling:{options:async()=>relayOptions}}),/must be udp or tls/);
  await assert.rejects(ClientMediaPeer.connect({wrtc,callId,timeoutMs:5000,
    signaling:{options:async()=>({...relayOptions,iceServers:[{urls:['turn:a.invalid:1?transport=udp','turn:b.invalid:2?transport=udp']}]})}}),/Exactly one TURN URL/);
});

// S70: the full shared line, spelled out so drift from Web/iOS/Android/bridge fails here.
const S70_FMTP='minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;maxplaybackrate=16000;sprop-maxcapturerate=16000';
const WRTC_OFFER=['v=0','m=audio 9 UDP/TLS/RTP/SAVPF 111 103','a=rtpmap:111 opus/48000/2','a=fmtp:111 minptime=10;useinbandfec=1','a=rtpmap:103 ISAC/16000',''].join('\r\n');

test('S70: the Opus fmtp is rewritten to the shared line, the wideband limit is its own constant',()=>{
  assert.equal(OPUS_WIDEBAND_LIMIT,'maxplaybackrate=16000;sprop-maxcapturerate=16000');
  const sdp=rewriteOpusOffer(WRTC_OFFER);
  assert.ok(sdp.includes(`a=fmtp:111 ${S70_FMTP}\r\n`));
  assert.equal(sdp.split('\r\n').filter(line=>line.startsWith('a=fmtp:111 ')).length,1);
  assert.ok(!sdp.includes('usedtx'));
  const inserted=rewriteOpusOffer('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 opus/48000/2\r\n');
  assert.ok(inserted.includes(`a=rtpmap:96 opus/48000/2\r\na=fmtp:96 ${S70_FMTP}\r\n`));
  assert.equal(rewriteOpusOffer('v=0\r\n'),'v=0\r\n');
});

test('S70: the rewritten offer is what setLocalDescription gets and what the bridge receives',async()=>{
  const {wrtc,state}=fakeWrtc();
  wrtc.RTCPeerConnection.prototype.createOffer=function(){return Promise.resolve({type:'offer',sdp:WRTC_OFFER})};
  let sent;
  const peer=await ClientMediaPeer.connect({wrtc,callId,timeoutMs:1000,signaling:{options:async()=>relayOptions,offer:async(_id,offer)=>{sent=offer.sdp;return {type:'answer',sdp:'answer'}}}});
  assert.ok(state.pcs[0].localDescription.sdp.includes(`a=fmtp:111 ${S70_FMTP}`));
  assert.equal(sent,state.pcs[0].localDescription.sdp);
  peer.close();
});
