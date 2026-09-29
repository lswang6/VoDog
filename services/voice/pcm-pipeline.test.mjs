import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pcm16kResampler, Pcm20msFramer, Pcm24kTo16kResampler, ProviderInputBatcher, GenerationPlaybackQueue } from './pcm-pipeline.mjs';
import { RealtimeAudioBridge } from './audio-bridge.mjs';

function pcm(sampleRate, ms, frequency = 0, amplitude = 12_000) {
  const samples = Math.round(sampleRate * ms / 1000);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(frequency ? Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude) : amplitude, i * 2);
  return out;
}
function rms(buffer, skipSamples = 0) {
  let sum = 0, count = 0;
  for (let i = skipSamples * 2; i < buffer.length; i += 2) { const value = buffer.readInt16LE(i);sum += value * value;count++; }
  return Math.sqrt(sum / Math.max(1, count));
}

test('stateful resampler preserves duration and attenuates out-of-band energy', () => {
  const pass = new Pcm16kResampler().process(pcm(48_000, 200, 1_000), 48_000);
  const stop = new Pcm16kResampler().process(pcm(48_000, 200, 12_000), 48_000);
  assert.equal(pass.length, 16_000 * 0.2 * 2);
  assert.ok(rms(pass, 40) > 7_000);
  assert.ok(rms(stop, 40) < rms(pass, 40) * 0.05, `alias was not attenuated: ${rms(stop,40)}`);
  assert.deepEqual(new Pcm16kResampler().process(pcm(16_000, 20),16_000),pcm(16_000,20));
  assert.throws(()=>new Pcm16kResampler().process(pcm(8_000,20),8_000),/Only/);
});

/** Sign changes, which is what says a tone kept its frequency after resampling. */
function zeroCrossings(buffer, skipSamples = 0) {
  let crossings = 0, previous = 0;
  for (let i = skipSamples * 2; i < buffer.length; i += 2) {
    const value = buffer.readInt16LE(i);
    if (value === 0) continue;
    if (previous && Math.sign(value) !== Math.sign(previous)) crossings++;
    previous = value;
  }
  return crossings;
}

test('S27: the 24 kHz downsampler keeps duration, tone and amplitude and drops what 16 kHz cannot carry', () => {
  // Chunk boundaries are arbitrary and uneven on purpose: a provider delta is whatever the network
  // gave us, and the FIR history, the 2× up-sampling and the ÷3 phase all have to survive it.
  const source = pcm(24_000, 500, 1_000);
  const resampler = new Pcm24kTo16kResampler();
  const sizes = [2, 640, 18, 4_096, 1_234, 6, 10_000];
  const parts = [];
  for (let offset = 0, i = 0; offset < source.length; i++) {
    const size = Math.min(sizes[i % sizes.length] * 2, source.length - offset);
    parts.push(resampler.process(source.subarray(offset, offset + size)));
    offset += size;
  }
  const pass = Buffer.concat(parts);
  // 2/3 of the input samples, give or take the one sample the decimation phase may still owe.
  assert.ok(Math.abs(pass.length / 2 - (source.length / 2) * 2 / 3) <= 1, `unexpected length ${pass.length}`);
  // 500 ms of 1 kHz is 500 cycles, whatever the sample rate: two sign changes per cycle.
  assert.ok(Math.abs(zeroCrossings(pass, 80) - 1_000) <= 100, `frequency moved: ${zeroCrossings(pass, 80)}`);
  assert.ok(Math.abs(rms(pass, 80) - rms(source, 80)) < rms(source, 80) * 0.1, `amplitude moved: ${rms(pass, 80)} vs ${rms(source, 80)}`);
  // 10 kHz exists at 24 kHz and would fold back onto 6 kHz at 16 kHz; the low-pass has to kill it.
  const stop = new Pcm24kTo16kResampler().process(pcm(24_000, 500, 10_000));
  assert.ok(rms(stop, 80) < rms(pass, 80) * 0.1, `alias was not attenuated by 20 dB: ${rms(stop, 80)}`);
  assert.equal(new Pcm24kTo16kResampler().process(Buffer.alloc(0)).length, 0);
  assert.throws(() => new Pcm24kTo16kResampler().process(Buffer.alloc(3)), /complete samples/);
});

test('arbitrary chunks become monotonic 20ms frames and exact 100ms provider batches', () => {
  const framer = new Pcm20msFramer();
  const batcher = new ProviderInputBatcher();
  const bytes = pcm(16_000, 100, 500);
  const frames = [...framer.push(bytes.subarray(0, 334), 7_000), ...framer.push(bytes.subarray(334), 17_000)];
  assert.equal(frames.length, 5);assert.deepEqual(frames.map(x=>x.sequence),[0,1,2,3,4]);assert.deepEqual(frames.map(x=>x.capturedAtUs),[7000,27000,47000,67000,87000]);
  let batch;for(const frame of frames)batch=batcher.push(frame)??batch;
  assert.equal(batch.pcm16le.length,3200);assert.equal(batch.sequence,4);assert.deepEqual(batch.pcm16le,bytes);
  assert.throws(()=>batcher.push({...frames[4],sequence:4}),/increase/);
});

test('playback is ACTIVE-only, bounded, and fenced by response generation', () => {
  const queue = new GenerationPlaybackQueue({maxFrames:2});const frame=pcm(16_000,20,500);
  assert.equal(queue.enqueue(frame,0),false);assert.equal(queue.stats().inactiveChunks,1);
  queue.setActive(true);assert.equal(queue.enqueue(Buffer.concat([frame,frame,frame]),0),false);assert.equal(queue.stats().droppedFrames,3);
  assert.equal(queue.take10ms(),null);queue.enqueue(Buffer.concat([frame,frame]),0);
  assert.equal(queue.take10ms().length,320);assert.equal(queue.take10ms().length,320);
  assert.equal(queue.take10ms().length,320);assert.equal(queue.take10ms().length,320);assert.equal(queue.take10ms(),null);
  queue.advanceGeneration(1);assert.equal(queue.take10ms(),null);assert.equal(queue.enqueue(frame,0),false);assert.equal(queue.stats().staleChunks,1);
  queue.enqueue(frame,1);assert.equal(queue.take10ms().length,320);queue.setActive(false);assert.equal(queue.take10ms(),null);
});

test('a six second reply delivered as one burst is retained in order instead of failing the call', () => {
  const queue=new GenerationPlaybackQueue();queue.setActive(true);
  const frames=Array.from({length:300},(_,index)=>pcm(16_000,20,0,(index%30)+1));
  assert.equal(queue.enqueue(Buffer.concat(frames),0),true);
  const played=[];for(let part;(part=queue.take10ms());)played.push(part);
  assert.equal(played.length,600);assert.deepEqual(Buffer.concat(played),Buffer.concat(frames));
  const stats=queue.stats();assert.equal(stats.droppedFrames,0);assert.equal(stats.generations[0].overflowBytes,0);
});

test('playback past the bound drops the newest chunk and reports once per generation', () => {
  const notices=[];const queue=new GenerationPlaybackQueue({maxFrames:4,onOverflow:detail=>notices.push(detail)});queue.setActive(true);
  const first=Buffer.concat([pcm(16_000,20,0,1),pcm(16_000,20,0,2)]);
  assert.equal(queue.enqueue(first,0),true);
  assert.equal(queue.enqueue(Buffer.concat([pcm(16_000,20,0,3),pcm(16_000,20,0,4),pcm(16_000,20,0,5)]),0),false);
  assert.equal(queue.enqueue(pcm(16_000,60,0,6),0),false);
  assert.equal(notices.length,1);assert.deepEqual([notices[0].generation,notices[0].maxFrames],[0,4]);
  const played=[];for(let part;(part=queue.take10ms());)played.push(part);
  assert.deepEqual(Buffer.concat(played),first,'the phrase already playing was not preserved');
  const stats=queue.stats().generations[0];
  assert.equal(stats.overflowBytes,1920+1920);assert.equal(stats.enqueuedBytes,1280);assert.equal(stats.playedBytes,1280);
  queue.advanceGeneration(1);queue.enqueue(Buffer.alloc(5*640,7),1);
  assert.equal(notices.length,2);assert.equal(notices[1].generation,1);
});

test('normal burst output longer than 120ms is retained in order', () => {
  const queue=new GenerationPlaybackQueue({maxFrames:150});queue.setActive(true);
  const frames=Array.from({length:50},(_,index)=>pcm(16_000,20,0,index+1));
  queue.enqueue(Buffer.concat(frames),0);
  const played=[];for(let part; (part=queue.take10ms());) played.push(part);
  assert.equal(played.length,100);assert.deepEqual(Buffer.concat(played),Buffer.concat(frames));assert.equal(queue.stats().droppedFrames,0);
});

class FakeAgent extends EventEmitter { constructor(){super();this.appends=[];this.stopped=false;}appendAudio(pcm,meta){this.appends.push({pcm,meta})}stop(){this.stopped=true} }
class FakePeer extends EventEmitter { constructor(){super();this.writes=[];this.closed=false;}writePcm16k10ms(pcm){this.writes.push(Buffer.from(pcm))}close(){this.closed=true} }

test('audio bridge sends silence before ACTIVE, batches caller PCM, and drops late response audio', () => {
  const agent=new FakeAgent(),peer=new FakePeer();let now=0,paceNow=0;
  const bridge=new RealtimeAudioBridge({agent,peer,nowUs:()=>now+=10_000,paceNowUs:()=>paceNow,tickMs:1000});bridge.start();
  // Pacing is clock-driven: the first tick only anchors the origin, and each frame needs 10 ms of it.
  bridge.tick();assert.equal(peer.writes.length,0);
  const tick=()=>{paceNow+=10_000;bridge.tick();};
  tick();assert.ok(peer.writes.at(-1).equals(Buffer.alloc(320)));
  agent.emit('audio',{pcm:pcm(16_000,20,440),generation:0});tick();assert.ok(peer.writes.at(-1).equals(Buffer.alloc(320)));
  bridge.setActive(true);
  for(let i=0;i<10;i++)peer.emit('pcm',{pcm:pcm(48_000,10,1_000),sampleRate:48_000,numberOfFrames:480});
  assert.equal(agent.appends.length,1);assert.equal(agent.appends[0].pcm.length,3200);
  agent.emit('audio',{pcm:pcm(16_000,20,440),generation:0});tick();assert.ok(rms(peer.writes.at(-1))>1000);
  agent.emit('flushAudio',{generation:1});agent.emit('audio',{pcm:pcm(16_000,20,440),generation:0});tick();assert.ok(peer.writes.at(-1).equals(Buffer.alloc(320)));
  bridge.close();assert.equal(peer.closed,true);assert.equal(agent.stopped,true);
});


test('S27: whenPlaybackDrained waits for the caller to hear the goodbye, and never past its bound', async () => {
  const agent=new FakeAgent(),peer=new FakePeer();let paceNow=0;
  const bridge=new RealtimeAudioBridge({agent,peer,paceNowUs:()=>paceNow,tickMs:1000});bridge.start();bridge.setActive(true);bridge.tick();
  agent.emit('audio',{pcm:Buffer.concat(Array.from({length:20},()=>pcm(16_000,20,440))),generation:0});
  assert.ok(bridge.stats().queuedBytes>0);
  let drained=null;const waiting=bridge.whenPlaybackDrained({timeoutMs:2_000,pollMs:1}).then(value=>{drained=value;});
  await delay(5);assert.equal(drained,null,'hanging up here would cut the sentence in half');
  for(let i=0;i<40;i++){paceNow+=10_000;bridge.tick();}
  await waiting;assert.equal(drained,true);assert.equal(bridge.stats().queuedBytes,0);
  // A bound, not a promise: audio nobody is draining must not hold the hangup forever.
  agent.emit('audio',{pcm:pcm(16_000,200,440),generation:0});
  assert.equal(await bridge.whenPlaybackDrained({timeoutMs:10,pollMs:1}),false);
  // A closed or muted bridge is drained by definition: those bytes will never reach anyone.
  bridge.close();assert.equal(await bridge.whenPlaybackDrained({timeoutMs:0}),true);
});

// ---------------------------------------------------------------------------------------------
// S27 决策 14（2026-09-12 in-image probes）: the end-of-call drain. `end_call` is when the provider
// DECIDED to hang up: Doubao streamed the goodbye text and the tool call at 13.75 s and only began
// delivering the matching TTS at 16.51 s, and because an unanswered `end_call` never produces
// `response.output_audio.done`, `finishGeneration()` is never called and the last 86 B stayed in
// `pendingBytes` forever. "Wait for an empty queue" therefore ran to the 15 s bound every time.
// The rule is tested here with small bounds; worker.mjs supplies 3000/1500/15000.
// ---------------------------------------------------------------------------------------------
/** Paces every queued frame out to the peer, the way the 5 ms tick does in a live call. */
function playOut(bridge, paceRef, frames = 200) {
  for (let i = 0; i < frames; i++) { paceRef.value += 10_000; bridge.tick(); }
}

test('S27 决策 14: the end-of-call drain waits out a provider whose audio lags its own end_call', async () => {
  const agent = new FakeAgent(), peer = new FakePeer(); const paceRef = { value: 0 };
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => paceRef.value, tickMs: 1_000 });
  bridge.start(); bridge.setActive(true); bridge.tick();
  const startedAt = Date.now();
  let drained = null;
  const waiting = bridge.whenPlaybackDrained({ timeoutMs: 5_000, pollMs: 2, minMs: 120, quietMs: 60 }).then(value => { drained = value; });
  // The 2.7 s gap between the tool call and the goodbye audio, in miniature: an empty queue here
  // must not be read as "the caller has heard everything".
  await delay(40);
  assert.equal(drained, null, 'hanging up in the TTS gap cuts the goodbye off before it starts');
  agent.emit('audio', { pcm: Buffer.concat(Array.from({ length: 20 }, () => pcm(16_000, 20, 440))), generation: 0 });
  assert.ok(bridge.stats().queuedBytes > 0);
  playOut(bridge, paceRef);
  // Deliberately NO `completed`: this is the Doubao path, where the turn is never finished.
  await waiting;
  const elapsed = Date.now() - startedAt;
  assert.equal(drained, true);
  assert.ok(elapsed >= 120 && elapsed < 1_000, `ended after ${elapsed} ms, not at the 5 s bound`);
});

test('S27 决策 14: audio still trickling in keeps the hangup waiting', async () => {
  const agent = new FakeAgent(), peer = new FakePeer(); const paceRef = { value: 0 };
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => paceRef.value, tickMs: 1_000 });
  bridge.start(); bridge.setActive(true); bridge.tick();
  let drained = null;
  const waiting = bridge.whenPlaybackDrained({ timeoutMs: 5_000, pollMs: 2, minMs: 40, quietMs: 100 }).then(value => { drained = value; });
  for (let i = 0; i < 6; i++) {
    agent.emit('audio', { pcm: pcm(16_000, 20, 440), generation: 0 });
    playOut(bridge, paceRef, 4);
    await delay(30);
    assert.equal(drained, null, `hung up after ${i + 1} of 6 chunks while the provider was still sending`);
  }
  await waiting;
  assert.equal(drained, true, 'and it does end once the provider goes quiet');
});

test('S27 决策 14: a hangup with no audio at all ends at the floor plus the quiet window', async () => {
  const agent = new FakeAgent(), peer = new FakePeer();
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => 0, tickMs: 1_000 });
  bridge.start(); bridge.setActive(true);
  const startedAt = Date.now();
  assert.equal(await bridge.whenPlaybackDrained({ timeoutMs: 5_000, pollMs: 2, minMs: 100, quietMs: 60 }), true);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 160 && elapsed < 1_000, `ended after ${elapsed} ms, expected about minMs + quietMs`);
});

test('S27 决策 14: an unplayable sub-frame remainder is drained, and a completed turn still empties the queue', async () => {
  const agent = new FakeAgent(), peer = new FakePeer(); const paceRef = { value: 0 };
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => paceRef.value, tickMs: 1_000 });
  bridge.start(); bridge.setActive(true); bridge.tick();
  // 700 bytes: one 640 B frame plus a 60 B remainder no `take10ms()` will ever hand to the peer.
  agent.emit('audio', { pcm: Buffer.alloc(700, 1), generation: 0 });
  playOut(bridge, paceRef, 10);
  assert.equal(bridge.stats().queuedBytes, 60, 'the remainder only becomes playable via finishGeneration');
  assert.equal(await bridge.whenPlaybackDrained({ timeoutMs: 3_000, pollMs: 2, minMs: 0, quietMs: 0 }), true);
  // The xAI path does send `response.done`, so its remainder is padded and the queue really empties.
  agent.emit('audio', { pcm: Buffer.alloc(700, 1), generation: 0 });
  agent.emit('completed', { status: 'completed', current: true, generation: 0 });
  assert.equal(bridge.stats().queuedBytes, 640 + 640, 'the tail was padded into a whole frame');
  playOut(bridge, paceRef, 20);
  assert.equal(bridge.stats().queuedBytes, 0);
  assert.equal(await bridge.whenPlaybackDrained({ timeoutMs: 3_000, pollMs: 2 }), true, 'and the original predicate is unchanged');
});

test('a burst the caller has not heard yet is never a bridge fault', () => {
  const agent=new FakeAgent(),peer=new FakePeer();const faults=[],notices=[];let paceNow=0;
  const bridge=new RealtimeAudioBridge({agent,peer,paceNowUs:()=>paceNow,tickMs:1000});bridge.on('fault',error=>faults.push(error));bridge.on('notice',notice=>notices.push(notice));
  bridge.start();bridge.setActive(true);bridge.tick();
  const burst=Buffer.concat(Array.from({length:300},(_,index)=>pcm(16_000,20,0,(index%30)+1)));
  agent.emit('audio',{pcm:burst,generation:0});
  assert.deepEqual([faults.length,notices.length],[0,0],'six seconds of AI speech ended the call');
  assert.equal(bridge.stats().queuedBytes,burst.length);
  for(let i=0;i<600;i++){paceNow+=10_000;bridge.tick();}
  assert.deepEqual(Buffer.concat(peer.writes),burst);assert.equal(bridge.stats().queuedBytes,0);
  bridge.close();
});

test('playback overflow reaches the worker as a notice on the provider notice path', () => {
  const agent=new FakeAgent(),peer=new FakePeer();const faults=[],notices=[];
  const bridge=new RealtimeAudioBridge({agent,peer,tickMs:1000,playbackMaxFrames:50});
  bridge.on('fault',error=>faults.push(error));bridge.on('notice',notice=>notices.push(notice));
  bridge.start();bridge.setActive(true);
  const frame=pcm(16_000,20,440);
  for(let i=0;i<60;i++)agent.emit('audio',{pcm:frame,generation:0});
  agent.emit('audio',{pcm:frame,generation:0});
  assert.equal(faults.length,0,'a bounded queue must never fault the media bridge');
  assert.equal(notices.length,1);assert.equal(notices[0].kind,'playback_overflow');assert.equal(notices[0].generation,0);
  assert.equal(bridge.stats().queuedFrames,50);assert.ok(bridge.stats().droppedFrames>=11);
  agent.emit('audio',{pcm:Buffer.alloc(7),generation:0});
  assert.equal(faults.length,1,'malformed provider PCM must still be reported');
  bridge.close();
});

test('response completion plays partial tail exactly and accounts padding', () => {
  const queue=new GenerationPlaybackQueue();queue.setActive(true);
  const original=Buffer.alloc(962,7);queue.enqueue(original,0);queue.finishGeneration(0);
  const played=[];for(let part;(part=queue.take10ms());)played.push(part);
  const result=Buffer.concat(played);assert.deepEqual(result.subarray(0,962),original);
  assert.deepEqual(result.subarray(962),Buffer.alloc(318));
  const stats=queue.stats().generations[0];assert.equal(stats.enqueuedBytes+stats.tailPaddingBytes,stats.playedBytes);
  assert.equal(queue.stats().queuedBytes,0);
});

test('barge-in accounts complete half and partial frames without replaying stale completion', () => {
  const queue=new GenerationPlaybackQueue();queue.setActive(true);queue.enqueue(Buffer.alloc(962,1),0);
  queue.take10ms();queue.advanceGeneration(1);queue.finishGeneration(0);
  assert.equal(queue.take10ms(),null);const previous=queue.stats().generations.find(s=>s.generation===0);
  assert.equal(previous.playedBytes,320);assert.equal(previous.clearedBytes,642);
  assert.equal(previous.enqueuedBytes,previous.playedBytes+previous.clearedBytes);
  queue.enqueue(Buffer.alloc(100,2),1);queue.finishGeneration(1);assert.equal(queue.take10ms().subarray(0,100).every(x=>x===2),true);
});

test('S23: the bridge pushes exactly what the monotonic clock makes due, never a forced frame', () => {
  class Agent extends EventEmitter { constructor(){ super(); this.outputGeneration = 0; } stop(){} }
  class Peer extends EventEmitter { constructor(){ super(); this.writes = []; } writePcm16k10ms(pcm){ this.writes.push(pcm); } close(){} }
  const agent = new Agent(), peer = new Peer(); let now = 0;
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => now, tickMs: 1000 });
  bridge.start();
  bridge.tick(); assert.equal(peer.writes.length, 0, 'the first tick only anchors the pacing origin');
  now = 10_000; bridge.tick(); assert.equal(peer.writes.length, 1, 'one frame per elapsed 10 ms');
  now = 24_000; bridge.tick(); assert.equal(peer.writes.length, 2, 'a partial frame is not yet due');
  now = 40_000; bridge.tick(); assert.equal(peer.writes.length, 4, 'the late tick catches the clock up, no further');
  now = 60_000; bridge.tick(); assert.equal(peer.writes.length, 6, 'a 20 ms late tick catches up: two frames');
  now = 61_000; bridge.tick(); assert.equal(peer.writes.length, 6, 'nothing is due 1 ms later: a forced frame would overrun real time');
  now = 2_000_000; bridge.tick(); assert.equal(peer.writes.length, 11, 'a long stall is capped at five frames');
  now = 2_010_000; bridge.tick(); assert.equal(peer.writes.length, 12, 'after the cap the origin is rebased, no further burst');
  const stats = bridge.stats(); assert.equal(stats.pacedFrames, 12); assert.equal(stats.paceStalls, 1); assert.equal(stats.paceCatchupFrames, 6);
  bridge.close();
});

test('S23: a 5 ms tick period streams at real time instead of twice it', () => {
  const agent = new FakeAgent(), peer = new FakePeer(); let now = 0;
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => now, tickMs: 5 });
  bridge.start();
  // One second of wall clock driven at the production tick period: 200 ticks, half of them with
  // nothing due. A `Math.max(1, dueFrames)` floor would push 200 frames — two seconds of audio.
  for (let i = 0; i < 200; i++) { bridge.tick(); now += 5_000; }
  bridge.tick();
  assert.equal(peer.writes.length, 100, 'one second of clock must produce exactly one second of audio');
  const stats = bridge.stats();
  assert.equal(stats.pacedFrames, 100); assert.equal(stats.paceStalls, 0); assert.equal(stats.paceCatchupFrames, 0);
  bridge.close();
});

// S27 决策 16（真实通话 c421d601, 2026-09-12 14:24 UTC）: the provider hung up first and the caller
// kept talking. Every uplink batch hit the adapter's `AI not ready` guard, the throw became a bridge
// fault, the worker read it as `media_failed` and ended the run 0.1 s later — 55040 bytes (1.7 s)
// of the goodbye were cleared before the drain and the tail had a chance to run.
test('S27 决策 16: caller audio after the agent closed is dropped, not a fault, and playback keeps pacing', async () => {
  const agent = new FakeAgent(), peer = new FakePeer(); const paceRef = { value: 0 };
  // Exactly what xai.mjs/doubao.mjs do once their state is 'closed'.
  agent.appendAudio = () => { throw new Error('AI not ready'); };
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => paceRef.value, tickMs: 1_000 });
  const faults = [];
  bridge.on('fault', error => faults.push(error));
  bridge.start(); bridge.setActive(true); bridge.tick();
  agent.emit('closed', { reason: 'ended_by_provider' });
  for (let i = 0; i < 30; i++) peer.emit('pcm', { pcm: pcm(16_000, 10), sampleRate: 16_000 });
  assert.deepEqual(faults, [], 'uplink with nowhere to go is not a media failure');
  assert.equal(agent.appends.length, 0, 'nothing is handed to a session that is gone');
  assert.equal(bridge.stats().upDroppedAfterAgentClosed, 30);
  // A provider fault after its own close is the teardown talking, not this bridge's business.
  agent.emit('fault', new Error('AI not ready'));
  assert.deepEqual(faults, []);
  // The half of the bridge that still matters keeps running: the goodbye must reach the caller.
  agent.emit('audio', { pcm: Buffer.concat(Array.from({ length: 5 }, () => pcm(16_000, 20, 440))), generation: 0 });
  assert.ok(bridge.stats().queuedBytes > 0);
  // 5 × 20 ms of tone is exactly 10 paced 10 ms frames, so the last write is still the goodbye.
  playOut(bridge, paceRef, 10);
  assert.ok(rms(peer.writes.at(-1)) > 1_000, 'playback is still paced out to the caller');
  assert.equal(await bridge.whenPlaybackDrained({ timeoutMs: 2_000, pollMs: 2, minMs: 0, quietMs: 0 }), true);
  bridge.close();
});

test('S27 决策 16: caller audio before the agent closes is forwarded exactly as before', () => {
  const agent = new FakeAgent(), peer = new FakePeer();
  const bridge = new RealtimeAudioBridge({ agent, peer, paceNowUs: () => 0, tickMs: 1_000 });
  const faults = [];
  bridge.on('fault', error => faults.push(error));
  bridge.start(); bridge.setActive(true);
  for (let i = 0; i < 30; i++) peer.emit('pcm', { pcm: pcm(16_000, 10), sampleRate: 16_000 });
  assert.ok(agent.appends.length > 0);
  assert.equal(bridge.stats().upDroppedAfterAgentClosed, 0);
  // And a genuine provider fault before the close is still relayed.
  agent.emit('fault', new Error('boom'));
  assert.equal(faults.length, 1);
  bridge.close();
});

test('S70: float32 is resampled as float and quantized once, matching the int16 path within rounding', () => {
  // A tone with sub-LSB detail: the old path rounded to int16 before the FIR, the new one after.
  const samples = 2_400, floats = Buffer.alloc(samples * 4), ints = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = 0.3 * Math.sin(2 * Math.PI * 1_000 * i / 24_000) + 0.00001 * (i % 7);
    floats.writeFloatLE(value, i * 4);
    ints.writeInt16LE(Math.round(Math.fround(value) * 32_767), i * 2);
  }
  const viaFloat = new Pcm24kTo16kResampler().processFloat32(floats);
  const viaInt = new Pcm24kTo16kResampler().process(ints);
  assert.equal(viaFloat.length, viaInt.length);
  let maxDiff = 0;
  for (let i = 0; i < viaFloat.length; i += 2) maxDiff = Math.max(maxDiff, Math.abs(viaFloat.readInt16LE(i) - viaInt.readInt16LE(i)));
  assert.ok(maxDiff <= 1, `float path drifted ${maxDiff} LSB from the int16 path`);
  // Exact float-domain reference for one output sample equals round(sum(taps × float×32767)) — i.e. one quantization.
  const reference = new Pcm24kTo16kResampler(), input = new Float64Array(samples);
  for (let i = 0; i < samples; i++) input[i] = floats.readFloatLE(i * 4) * 32_767;
  assert.deepEqual(viaFloat, reference.resample(input));
  const bad = Buffer.alloc(12); bad.writeFloatLE(Number.NaN, 0); bad.writeFloatLE(9, 4); bad.writeFloatLE(-9, 8);
  assert.equal(new Pcm24kTo16kResampler().processFloat32(bad).length, 4);
  assert.throws(() => new Pcm24kTo16kResampler().processFloat32(Buffer.alloc(6)), /complete samples/);
});
