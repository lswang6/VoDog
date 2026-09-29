import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { XaiVoiceAgent } from './adapter.mjs';
import { RealtimeAudioBridge } from './audio-bridge.mjs';

class Socket extends EventEmitter { readyState=1;bufferedAmount=0;sent=[];send(raw){this.sent.push(JSON.parse(raw))}close(){this.readyState=3;this.emit('close')} }
class Peer extends EventEmitter { closed=false;writes=[];writePcm16k10ms(pcm){this.writes.push(Buffer.from(pcm))}close(){this.closed=true} }
function tone(ms=20){const result=Buffer.alloc(16_000*ms/1000*2);for(let i=0;i<result.length/2;i++)result.writeInt16LE(Math.round(Math.sin(2*Math.PI*500*i/16_000)*10_000),i*2);return result;}
function energy(pcm){let sum=0;for(let i=0;i<pcm.length;i+=2)sum+=Math.abs(pcm.readInt16LE(i));return sum;}

test('fake provider to media bridge enforces ACTIVE and response generation end to end',async()=>{
  const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',agentId:'space-agent',socketFactory:()=>socket});const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
  // S27: release the agent-mode opener hold up front — this test is about the ACTIVE gate and the
  // generation fence, which is the session's behaviour after the greeting (see the hold test below).
  agent.greet();
  const peer=new Peer();let paceNow=0;const bridge=new RealtimeAudioBridge({agent,peer,paceNowUs:()=>paceNow,tickMs:1000});bridge.start();
  // Clock-driven pacing: anchor the origin, then give every tick the 10 ms a frame costs.
  bridge.tick();const tick=()=>{paceNow+=10_000;bridge.tick();};
  socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"r1"}}'));socket.emit('message',Buffer.from(JSON.stringify({type:'response.output_audio.delta',response_id:'r1',delta:tone().toString('base64')})));
  tick();assert.equal(energy(peer.writes.at(-1)),0,'AI audio escaped before ACTIVE');
  bridge.setActive(true);socket.emit('message',Buffer.from(JSON.stringify({type:'response.output_audio.delta',response_id:'r1',delta:tone().toString('base64')})));tick();assert.ok(energy(peer.writes.at(-1))>0);
  socket.emit('message',Buffer.from('{"type":"input_audio_buffer.speech_started"}'));socket.emit('message',Buffer.from(JSON.stringify({type:'response.output_audio.delta',response_id:'r1',delta:tone().toString('base64')})));tick();assert.equal(energy(peer.writes.at(-1)),0,'late cancelled audio escaped');
  socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"r2"}}'));socket.emit('message',Buffer.from(JSON.stringify({type:'response.output_audio.delta',response_id:'r2',delta:tone().toString('base64')})));tick();assert.ok(energy(peer.writes.at(-1))>0,'new generation was not playable');
  bridge.close();assert.equal(peer.closed,true);assert.equal(agent.state,'closed');
});

test('bridge starts at the provider current output generation',()=>{
  const agent=new EventEmitter();agent.outputGeneration=3;agent.stop=()=>{};
  const peer=new Peer();let paceNow=0;const bridge=new RealtimeAudioBridge({agent,peer,paceNowUs:()=>paceNow,tickMs:1000});bridge.start();bridge.setActive(true);bridge.tick();
  agent.emit('audio',{pcm:tone(),generation:3});paceNow+=10_000;bridge.tick();
  assert.ok(energy(peer.writes.at(-1))>0,'current provider generation was treated as stale');
  bridge.close();
});

// S27（2026-09-12 真实探针 S1/S2/S3）: the Space agent's own opener IS the greeting, and a
// `response.create` of ours is silently dropped, so the opener is held until the audio gate opens
// instead of being replaced. Production run 0407de3e lost 68,508 of 283,798 bytes to
// `inactiveBytes` — the caller heard the opener from the middle of a sentence.
test('S27: the Space agent opener is held while the audio gate is closed and reaches the caller whole',async()=>{
  const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',agentId:'space-agent',socketFactory:()=>socket});
  const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
  const peer=new Peer();let paceNow=0;const bridge=new RealtimeAudioBridge({agent,peer,paceNowUs:()=>paceNow,tickMs:1000});bridge.start();
  const transcripts=[];agent.on('transcript',event=>transcripts.push(event.text));
  bridge.tick();const tick=()=>{paceNow+=10_000;bridge.tick();};
  const send=event=>socket.emit('message',Buffer.from(JSON.stringify(event)));
  // The Space agent opens with its own line while Control still keeps the audio gate closed.
  send({type:'response.created',response:{id:'self'}});
  send({type:'response.output_audio.delta',response_id:'self',delta:tone(200).toString('base64')});
  send({type:'response.output_audio_transcript.delta',response_id:'self',delta:'您好！我是 VoDog AI 助理，代用户接听电话。'});
  tick();assert.equal(energy(peer.writes.at(-1)),0,'nothing may be played before the gate opens');
  assert.equal(bridge.stats().queuedBytes,0);
  assert.deepEqual(bridge.stats().generations,[],'held in the adapter: the bridge never saw it, so nothing was discarded');
  assert.deepEqual(transcripts,[],'the collector is still muted, so the transcript waits too');
  // Control opens the gate and the worker greets: the opener is released from its first sample.
  bridge.setActive(true);
  assert.equal(agent.greet(),true);
  assert.equal(socket.sent.some(event=>event.type==='response.create'),false,'probe S2/S3: xAI silently drops it, so it must not be sent');
  assert.equal(bridge.stats().queuedBytes,6_400,'every byte of the held opener, none of it inactive');
  assert.deepEqual(transcripts,['您好！我是 VoDog AI 助理，代用户接听电话。']);
  tick();assert.ok(energy(peer.writes.at(-1))>0,'the caller hears the opener from its start');
  // Activation landed mid-opener: the live remainder must keep flowing on the same generation.
  send({type:'response.output_audio.delta',response_id:'self',delta:tone(200).toString('base64')});
  send({type:'response.done',response:{id:'self',status:'completed'}});
  for(let frame=0;frame<20;frame++)tick();// past the 6400 bytes that were held
  assert.ok(energy(peer.writes.at(-1))>0,'the live remainder of the opener was fenced out as stale');
  bridge.close();
});

test('only current completed response flushes the bridge partial tail',async()=>{
  const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',agentId:'space-agent',socketFactory:()=>socket});
  const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
  agent.greet();// S27: past the opener hold; this test is about the completion that pads the tail.
  const peer=new Peer();let paceNow=0;const bridge=new RealtimeAudioBridge({agent,peer,paceNowUs:()=>paceNow,tickMs:1000});bridge.start();bridge.setActive(true);
  bridge.tick();const tick=()=>{paceNow+=10_000;bridge.tick();};
  const send=event=>socket.emit('message',Buffer.from(JSON.stringify(event)));
  send({type:'response.created',response:{id:'tail'}});
  send({type:'response.output_audio.delta',response_id:'tail',delta:Buffer.alloc(100,1).toString('base64')});
  send({type:'response.done',response:{id:'old',status:'completed'}});tick();assert.equal(energy(peer.writes.at(-1)),0);
  send({type:'response.done',response:{id:'tail',status:'completed'}});tick();assert.deepEqual(peer.writes.at(-1).subarray(0,100),Buffer.alloc(100,1));
  tick();assert.equal(bridge.stats().queuedBytes,0);assert.equal(bridge.stats().generations[0].tailPaddingBytes,540);
  bridge.close();
});
