import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClientMediaPeer, loadWrtc } from '../webrtc-media.mjs';

const secret = 'voice-prototype-media-secret-32-bytes-minimum';
const mediaDir = resolve(import.meta.dirname, '../../media');
const fixturePath = resolve(process.env.VOICE_PROBE_OGG_PATH || './fixtures/synthetic.ogg');

function signGrant(callId, role) {
  const body = Buffer.from(JSON.stringify({callId,role,mediaEpoch:1,exp:Math.floor(Date.now()/1000)+60,nonce:`voice-prototype-${role}-${randomUUID()}`})).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
async function freePort() {
  return new Promise((resolvePort,reject) => { const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolvePort(port));}); });
}
async function waitHealth(baseUrl) {
  for(let i=0;i<120;i++) { try { const response=await fetch(`${baseUrl}/healthz`,{signal:AbortSignal.timeout(300)});if(response.ok)return; } catch {} await delay(100); }
  throw new Error('isolated Go bridge did not become healthy');
}
function offerToBridge(baseUrl,callId,role) {
  return async description => {
    const response=await fetch(`${baseUrl}/offer`,{method:'POST',headers:{Authorization:`Bearer ${signGrant(callId,role)}`,'Content-Type':'application/json'},body:JSON.stringify(description),signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw new Error(`bridge offer failed ${response.status}: ${await response.text()}`);
    return response.json();
  };
}
async function negotiateGateway(wrtc,baseUrl,callId) {
  const pc=new wrtc.RTCPeerConnection({iceServers:[],iceTransportPolicy:'all'});
  const dc=pc.createDataChannel('cellular-opus-v1',{ordered:false,maxRetransmits:0});
  const gathered=new Promise(resolveGather=>{pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolveGather();}});
  await pc.setLocalDescription(await pc.createOffer());if(pc.iceGatheringState!=='complete')await gathered;
  await pc.setRemoteDescription(await offerToBridge(baseUrl,callId,'gateway')({type:'offer',sdp:pc.localDescription.sdp}));
  await new Promise((resolveOpen,reject)=>{const timer=setTimeout(()=>reject(new Error('gateway data channel timeout')),10_000);dc.onopen=()=>{clearTimeout(timer);resolveOpen();};});
  return {pc,dc};
}
function opusPackets(raw) {
  const packets=[];let pending=Buffer.alloc(0);
  for(let offset=0;offset<raw.length;) {
    assert.equal(raw.subarray(offset,offset+4).toString(),'OggS');const segments=raw[offset+26];const table=raw.subarray(offset+27,offset+27+segments);let cursor=offset+27+segments;
    for(const size of table) { pending=Buffer.concat([pending,raw.subarray(cursor,cursor+size)]);cursor+=size;if(size<255){if(!pending.subarray(0,8).equals(Buffer.from('OpusHead'))&&!pending.subarray(0,8).equals(Buffer.from('OpusTags')))packets.push(pending);pending=Buffer.alloc(0);} }
    offset=cursor;
  }
  return packets.filter(packet=>packet.length>0);
}
function mediaPacket(opus,sequence) {
  const result=Buffer.alloc(16+opus.length);result[0]=1;result[1]=0;result.writeUInt16BE(20,2);result.writeUInt32BE(sequence,4);result.writeBigUInt64BE(BigInt(sequence)*20_000n,8);opus.copy(result,16);return result;
}
function pcmTone10ms(sequence) {
  const result=Buffer.alloc(320);for(let i=0;i<160;i++)result.writeInt16LE(Math.round(Math.sin(2*Math.PI*700*(sequence*160+i)/16_000)*10_000),i*2);return result;
}

async function main() {
  const wrtc=await loadWrtc();const port=await freePort();const baseUrl=`http://127.0.0.1:${port}`;const recordDir=await mkdtemp(join(tmpdir(),'vodog-voice-bridge-'));const callId=randomUUID();let logs='';
  const binary=join(recordDir,'media-bridge');
  const built=spawn('go',['build','-o',binary,'.'],{cwd:mediaDir,stdio:['ignore','pipe','pipe']});let buildLogs='';built.stdout.on('data',chunk=>buildLogs+=chunk);built.stderr.on('data',chunk=>buildLogs+=chunk);const buildExit=await new Promise(resolveExit=>built.once('exit',resolveExit));if(buildExit!==0)throw new Error(`Go build failed: ${buildLogs.slice(-1000)}`);
  const child=spawn(binary,[],{env:{...process.env,MEDIA_SECRET:secret,MEDIA_RECORD_DIR:recordDir,MEDIA_NODE_ID:'voice-test',MEDIA_TURN_UDP_URL:'turn:127.0.0.1:9?transport=udp',MEDIA_LISTEN_ADDR:`127.0.0.1:${port}`,TURN_SECRET:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  let gateway,client;
  try {
    await waitHealth(baseUrl);
    const gatewayPromise=negotiateGateway(wrtc,baseUrl,callId);
    // Let gateway SDP reach the bridge, then create the client role that completes ICE.
    await delay(100);
    const signaling={options:async()=>({mediaNodeId:'voice-test',mediaEpoch:1,iceServers:[],iceTransportPolicy:'all'}),offer:async(_id,description)=>offerToBridge(baseUrl,callId,'client')(description)};
    const clientPromise=ClientMediaPeer.connect({wrtc,signaling,callId,allowNonRelayForTest:true,timeoutMs:15_000});
    [gateway,client]=await Promise.all([gatewayPromise,clientPromise]);
    let pcmFrames=0,upPackets=0;client.on('pcm',()=>pcmFrames++);gateway.dc.onmessage=event=>{const bytes=Buffer.from(event.data);if(bytes[1]===1)upPackets++;};
    const packets=opusPackets(await readFile(fixturePath)).filter(packet=>packet[0]!==undefined).slice(0,50);
    assert.ok(packets.length>=20,'real Opus fixture missing');
    for(let i=0;i<80;i++) { if(i<packets.length)gateway.dc.send(mediaPacket(packets[i],i+1));client.writePcm16k10ms(pcmTone10ms(i));await delay(10); }
    await delay(500);
    assert.ok(pcmFrames>=20,`decoded caller PCM frames=${pcmFrames}`);
    assert.ok(upPackets>=20,`encoded AI Opus packets=${upPackets}`);
    const close=await fetch(`${baseUrl}/close/${callId}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'X-Media-Epoch':'1'} });assert.equal(close.status,204);
    const manifest=JSON.parse(await readFile(join(recordDir,callId,'manifest.json'),'utf8'));assert.equal(manifest.complete,true);assert.equal(manifest.nodeId,'voice-test');assert.equal(manifest.mediaEpoch,1);
    return {ok:true,decodedPcmFrames:pcmFrames,encodedOpusPackets:upPackets,manifestComplete:manifest.complete};
  } finally {
    try{client?.close();}catch{}try{gateway?.dc?.close();gateway?.pc?.close();}catch{}
    child.kill('SIGTERM');await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),delay(2_000)]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),delay(1_000)]);}
    await rm(recordDir,{recursive:true,force:true});
    if(child.exitCode===null&&child.signalCode===null)throw new Error(`isolated media process did not stop: ${logs.slice(-1000)}`);
  }
}

main().then(result=>{console.log(JSON.stringify(result));process.exit(0)},error=>{console.error(String(error?.stack??error));process.exit(1)});
