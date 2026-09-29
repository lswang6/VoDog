import test from 'node:test';
import assert from 'node:assert/strict';
import {audioQualitySample,audioRxTx,AudioQualityMonitor,diagAudioStats} from '../src/media-quality.ts';
const report=(rows:unknown[])=>new Map(rows.map((row,index)=>[String(index),row])) as unknown as RTCStatsReport;
test('audio diagnostics whitelist counters and preserve unavailable values as absent',()=>{
 const sample=audioQualitySample(report([{type:'inbound-rtp',kind:'audio',packetsLost:4,concealedSamples:960,jitter:NaN,address:'private',credential:'secret'},{type:'inbound-rtp',kind:'video',packetsLost:99},{type:'candidate-pair',address:'private'}]),10.6);
 assert.deepEqual(sample,{elapsedMs:11,inbound:[{packetsLost:4,concealedSamples:960}]});
});
test('stopped monitor ignores late stats and coalesces overlapping reads',async()=>{
 let resolve!:(value:RTCStatsReport)=>void,calls=0;
 const monitor=new AudioQualityMonitor({getStats:()=>{calls++;return new Promise(done=>{resolve=done;});}});
 const first=monitor.sample();await monitor.sample();assert.equal(calls,1);
 assert.deepEqual(monitor.stop(),[]);resolve(report([]));await first;assert.deepEqual(monitor.samples,[]);
});
test('monitor bounds history and stats failure does not escape',async()=>{
 let fail=true;const monitor=new AudioQualityMonitor({getStats:async()=>{if(fail)throw new Error('closed');return report([]);}});
 await monitor.sample();fail=false;for(let i=0;i<190;i++)await monitor.sample();
 assert.equal(monitor.stop().length,180);
});

test('diagnostic audio stats keep four numbers from the audio stream and the nominated pair only',()=>{
 assert.deepEqual(diagAudioStats(report([
  {type:'inbound-rtp',kind:'audio',packetsLost:7,jitter:0.02,audioLevel:0.3,address:'private'},
  {type:'inbound-rtp',kind:'video',packetsLost:99},
  {type:'candidate-pair',nominated:false,currentRoundTripTime:9},
  {type:'candidate-pair',nominated:true,currentRoundTripTime:0.11,remoteCandidateId:'x'},
 ])),{rx:{packetsLost:7,jitterMs:20},tx:{},packetsLost:7,jitter:0.02,audioLevel:0.3,rtt:0.11});
 assert.deepEqual(diagAudioStats(report([{type:'inbound-rtp',kind:'audio',jitter:NaN}])),{rx:{},tx:{}});
});

test('S70 rx/tx map inbound/outbound audio stats and derive jitter buffer ms',()=>{
 assert.deepEqual(audioRxTx(report([
  {type:'inbound-rtp',kind:'audio',packetsReceived:1000,packetsLost:5,jitter:0.0154,concealedSamples:4800,silentConcealedSamples:4000,totalSamplesReceived:960000,concealmentEvents:3,jitterBufferDelay:48,jitterBufferEmittedCount:960000,insertedSamplesForDeceleration:10,removedSamplesForAcceleration:20,address:'x'},
  {type:'outbound-rtp',kind:'audio',packetsSent:990,bytesSent:79200,ssrc:1},
  {type:'outbound-rtp',kind:'video',packetsSent:9},
  {type:'inbound-rtp',kind:'audio',jitterBufferDelay:1,jitterBufferEmittedCount:0},
 ])),{rx:{packetsReceived:1000,packetsLost:5,concealedSamples:4800,silentConcealedSamples:4000,totalSamplesReceived:960000,concealmentEvents:3,insertedSamplesForDeceleration:10,removedSamplesForAcceleration:20,jitterMs:15.4,jitterBufferMs:0.1},tx:{packetsSent:990,bytesSent:79200}});
});
