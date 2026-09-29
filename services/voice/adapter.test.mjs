import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {XaiVoiceAgent,transcribeOgg,xaiRealtimeUrl} from './adapter.mjs';import {XAI_ENV_KEYS,xaiTranscriptionLanguage} from './providers/xai.mjs';import {createVoiceAgent} from './providers/index.mjs';
class Socket extends EventEmitter{readyState=1;bufferedAmount=0;sent=[];send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;this.emit('close');}}
const appendsOf=socket=>socket.sent.filter(event=>event.type==='input_audio_buffer.append');
// S27（2026-09-12 真实探针）: in agent mode the adapter HOLDS the Space agent's opener until greet()
// releases it, so a test that is not about the hold must release first — in agent mode that puts
// nothing on the wire (no response.create), so every `socket.sent` index below is unchanged.
async function ready({release=true,...options}={}){const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',socketFactory:()=>socket,...options});const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;if(release)agent.greet();return {agent,socket};}
/** Model mode: no Space agent persona, so greet() still sends the greeting response.create. */
async function readyModel(options={}){const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',socketFactory:()=>socket,...options});const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;return {agent,socket};}
const deltaEvent=(responseId,pcm)=>JSON.stringify({type:'response.output_audio.delta',response_id:responseId,delta:pcm.toString('base64')});
test('audio rejects replay and unconfigured sample rates',async()=>{const {agent,socket}=await ready();agent.appendAudio(Buffer.alloc(640),{sequence:0});assert.throws(()=>agent.appendAudio(Buffer.alloc(640),{sequence:0}),/sequence/);assert.throws(()=>agent.appendAudio(Buffer.alloc(640),{sequence:1,sampleRate:24000}),/PCM16/);assert.equal(socket.sent.at(-1).type,'input_audio_buffer.append');agent.stop();});
test('barge-in drops late audio belonging to cancelled response',async()=>{const {agent,socket}=await ready();let audio=0,flush=0;agent.on('audio',()=>audio++);agent.on('flushAudio',()=>flush++);socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"r1"}}'));agent.interrupt();socket.emit('message',Buffer.from('{"type":"response.output_audio.delta","response_id":"r1","delta":"AAAA"}'));assert.equal(audio,0);assert.equal(flush,1);agent.stop();});
// S27 2026-09-12 真实来电修正: a congestion episode 34 s into an otherwise good call tripped this
// exact `bufferedAmount > 64 KB` guard on the Doubao side and ended the call (`provider_failed`).
// The xAI link is cross-border through the sing-box tunnel, so it is at least as exposed.
// Upstream congestion must cost the caller audio, never the call.
test('S27: transient upstream backpressure drops the batch and keeps the call, and recovers on its own',async()=>{
 const {agent,socket}=await ready();
 const notices=[],faults=[];
 agent.on('notice',notice=>notices.push(notice.kind));agent.on('fault',error=>faults.push(error));
 socket.bufferedAmount=64001;
 agent.appendAudio(Buffer.alloc(640),{sequence:0});
 agent.appendAudio(Buffer.alloc(640),{sequence:1});
 assert.deepEqual(faults,[],'a congested second is not a failed call');
 assert.equal(agent.state,'ready');
 assert.deepEqual(notices,['input_backpressure'],'one notice per episode, not one per batch');
 assert.equal(appendsOf(socket).length,0,'nothing is pushed into a full send buffer');
 assert.equal(agent.droppedAppends,2);
 assert.equal(agent.sequence,1,'the replay fence keeps advancing across dropped batches');
 // The link drains: the next batch goes out and the episode is reported closed.
 socket.bufferedAmount=0;
 agent.appendAudio(Buffer.alloc(640),{sequence:2});
 assert.deepEqual(notices,['input_backpressure','input_backpressure_cleared']);
 assert.equal(appendsOf(socket).length,1);
 assert.equal(agent.droppedAppends,2);
 agent.stop();
});
test('S27: backpressure that never clears is a real fault, bounded in time and in bytes',async()=>{
 const sustained=await ready();
 const faults=[],kinds=[];
 sustained.agent.on('fault',error=>faults.push(error));sustained.agent.on('notice',notice=>kinds.push(notice.kind));
 sustained.socket.bufferedAmount=200_000;
 sustained.agent.appendAudio(Buffer.alloc(640),{sequence:0});
 assert.deepEqual(faults,[]);
 // Five seconds of a send buffer that never drains: the link is gone, end the run the normal way.
 sustained.agent.backpressureSinceMs=Date.now()-5_000;
 sustained.agent.appendAudio(Buffer.alloc(640),{sequence:1});
 assert.equal(faults.length,1);
 assert.deepEqual(kinds,['input_backpressure','input_backpressure_fatal']);
 assert.equal(sustained.agent.state,'closed');
 assert.equal(appendsOf(sustained.socket).length,0);
 // A buffer past the hard ceiling does not wait out the five seconds.
 const burst=await ready();
 const burstFaults=[],burstKinds=[];
 burst.agent.on('fault',error=>burstFaults.push(error));burst.agent.on('notice',notice=>burstKinds.push(notice.kind));
 burst.socket.bufferedAmount=600_000;
 burst.agent.appendAudio(Buffer.alloc(640),{sequence:0});
 assert.equal(burstFaults.length,1,'half a megabyte queued is not a transient hiccup');
 assert.deepEqual(burstKinds,['input_backpressure','input_backpressure_fatal']);
 assert.equal(burst.agent.state,'closed');
});
test('transcription rejects raw PCM before network transmission',async()=>{let requested=false;await assert.rejects(transcribeOgg(Buffer.alloc(20),{apiKey:'test',fetcher:async()=>{requested=true}}),/Ogg/);assert.equal(requested,false);});
test('transcription uses the wacli Gemini contract',async()=>{const result=await transcribeOgg(Buffer.from('OggS-test'),{apiKey:'test',fetcher:async(url,o)=>{assert.match(url,/generateContent$/);assert.equal(JSON.parse(o.body).contents[0].parts[0].inline_data.mime_type,'audio/ogg');return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'测试'}]}}]})}}});assert.equal(result.text,'测试');});
test('stopping setup settles its promise and cannot be reopened by late provider events',async()=>{const socket=new Socket();socket.readyState=0;socket.terminate=()=>{socket.readyState=3;socket.emit('close')};const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',socketFactory:()=>socket});let flushed=0,closed=0;agent.on('flushAudio',()=>flushed++);agent.on('closed',()=>closed++);const started=agent.start();const rejected=assert.rejects(started,/stopped during setup/);agent.stop();await rejected;socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));agent.stop();assert.equal(agent.state,'closed');assert.equal(socket.sent.length,0);assert.equal(flushed,1);assert.equal(closed,1);});
test('socket construction failure leaves a terminal agent without a pending setup',async()=>{const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',socketFactory:()=>{throw new Error('creation failed')}});await assert.rejects(agent.start(),/creation failed/);assert.equal(agent.state,'closed');assert.equal(agent.rejectSetup,undefined);});
test('old response completion cannot clear a newer response selected for interruption',async()=>{const {agent,socket}=await ready();socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"old"}}'));socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"new"}}'));socket.emit('message',Buffer.from('{"type":"response.done","response":{"id":"old","status":"cancelled"}}'));agent.interrupt();assert.equal(agent.cancelledResponses.has('new'),true);agent.stop();});
test('Space agent and public model URLs remain explicit distinct contracts',()=>{
 assert.match(xaiRealtimeUrl({agentId:'agent_custom'}),/agent_id=agent_custom$/);
 assert.match(xaiRealtimeUrl({model:'grok-voice-think-fast-2.0'}),/model=grok-voice-think-fast-2.0$/);
 assert.throws(()=>xaiRealtimeUrl({agentId:'a',model:'m'}),/either/);
 assert.throws(()=>xaiRealtimeUrl({agentId:'agent custom'}),/Invalid/);
 assert.throws(()=>xaiRealtimeUrl({model:'bad/model'}),/Invalid/);
 assert.throws(()=>xaiRealtimeUrl({}),/required/);
 // S25 决策 6: only the port moves; the hostname api.x.ai is what SNI and the certificate check use.
 assert.equal(xaiRealtimeUrl({agentId:'agent_custom'}),'wss://api.x.ai/v1/realtime?agent_id=agent_custom');
 assert.equal(xaiRealtimeUrl({agentId:'agent_custom',realtimePort:16890}),'wss://api.x.ai:16890/v1/realtime?agent_id=agent_custom');
 assert.equal(xaiRealtimeUrl({model:'grok-4',realtimePort:16890}),'wss://api.x.ai:16890/v1/realtime?model=grok-4');
 for(const realtimePort of [0,65536,-1,443.5,'16890',null,NaN])assert.throws(()=>xaiRealtimeUrl({agentId:'agent_custom',realtimePort}),/XAI_REALTIME_PORT/);
});
test('S25: the forwarding port survives the startup parse and reaches the socket with a pinned Host',async()=>{
 // The path a deployed run actually takes: env -> xaiConfig -> workerData -> createVoiceAgent.
 // Asserting xaiRealtimeUrl() alone would not catch a config field dropped in the constructor.
 const env={XAI_API_KEY:'test',XAI_AGENT_ID:'agent_custom',XAI_REALTIME_PORT:'16890'};
 const seen=[];const socket=new Socket();
 const agent=createVoiceAgent({provider:'xai',env,overrides:{socketFactory:(url,options)=>{seen.push({url,options});return socket}}});
 const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
 assert.equal(seen[0].url,'wss://api.x.ai:16890/v1/realtime?agent_id=agent_custom');
 assert.equal(seen[0].options.headers.Host,'api.x.ai','a forwarded port would otherwise announce Host: api.x.ai:16890 to xAI');
 assert.equal(seen[0].options.headers.Authorization,'Bearer test');
 // Nothing here weakens verification: no rejectUnauthorized, no checkServerIdentity, no servername override.
 assert.deepEqual(Object.keys(seen[0].options).sort(),['handshakeTimeout','headers','maxPayload']);
 agent.stop();

 const direct=new Socket();const plain=[];
 const unforwarded=createVoiceAgent({provider:'xai',env:{XAI_API_KEY:'test',XAI_AGENT_ID:'agent_custom'},overrides:{socketFactory:(url,options)=>{plain.push({url,options});return direct}}});
 const running=unforwarded.start();direct.emit('open');direct.emit('message',Buffer.from('{"type":"session.updated"}'));await running;
 assert.equal(plain[0].url,'wss://api.x.ai/v1/realtime?agent_id=agent_custom');
 assert.deepEqual(plain[0].options.headers,{Authorization:'Bearer test'},'the default path must send exactly what production sends today');
 unforwarded.stop();
 assert.throws(()=>createVoiceAgent({provider:'xai',env:{...env,XAI_REALTIME_PORT:'0'}}),/XAI_REALTIME_PORT/);
});
test('session configuration is bounded PCM without tools and identifies provider mode',async()=>{
 const socket=new Socket();let url;const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',voice:'eve',socketFactory:value=>{url=value;return socket}});
 const started=agent.start();socket.emit('open');const update=socket.sent[0];
 assert.match(url,/model=pinned-model$/);assert.deepEqual(update.session.tools,[]);assert.equal(update.session.audio.input.format.rate,16000);assert.equal(update.session.audio.output.transport,'json');
 socket.emit('message',Buffer.from('{"type":"session.updated"}'));assert.deepEqual(await started,{mode:'model',model:'pinned-model'});agent.stop();
});
test('server VAD flushes locally without racing automatic provider cancellation',async()=>{
 const {agent,socket}=await ready();const audio=[];agent.on('audio',event=>audio.push(event));
 socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"r1"}}'));
 socket.emit('message',Buffer.from('{"type":"input_audio_buffer.speech_started"}'));
 assert.equal(socket.sent.some(event=>event.type==='response.cancel'),false);
 socket.emit('message',Buffer.from('{"type":"response.output_audio.delta","response_id":"r1","delta":"AAAA"}'));
 assert.equal(audio.length,0);agent.stop();
});
test('abort during setup settles once and ignores late readiness',async()=>{
 const socket=new Socket();socket.readyState=0;socket.terminate=()=>{socket.readyState=3;socket.emit('close')};const controller=new AbortController();
 const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',socketFactory:()=>socket});const started=agent.start({signal:controller.signal});controller.abort(new Error('lease lost'));
 await assert.rejects(started,/lease lost/);socket.emit('message',Buffer.from('{"type":"session.updated"}'));assert.equal(agent.state,'closed');
});
test('the initial session.update stays byte-for-byte what the provider already accepted',async()=>{
 class RawSocket extends EventEmitter{readyState=1;bufferedAmount=0;raw=[];send(s){this.raw.push(s)}close(){this.readyState=3;this.emit('close')}}
 const socket=new RawSocket();const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',voice:'eve',socketFactory:()=>socket});
 const started=agent.start();socket.emit('open');
 assert.equal(socket.raw[0],'{"type":"session.update","session":{"voice":"eve","instructions":"请用中文简洁接听电话，说明你是AI助理。","turn_detection":{"type":"server_vad"},"tools":[],"audio":{"input":{"format":{"type":"audio/pcm","rate":16000},"transport":"json"},"output":{"format":{"type":"audio/pcm","rate":16000},"transport":"json"}}}}');
 assert.equal(socket.raw.length,1);socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
 assert.equal(socket.raw.length,2);agent.stop();
});
test('input transcription is a tagged second update sent only after readiness',async()=>{
 const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',transcriptionModel:'whisper-x',socketFactory:()=>socket});
 const started=agent.start();socket.emit('open');
 assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].event_id,undefined);
 socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
 const update=socket.sent[1];assert.equal(update.type,'session.update');assert.match(update.event_id,/^cc-transcription-/);
 assert.equal(update.session.audio.input.transcription.model,'whisper-x');assert.equal(update.session.input_audio_transcription.model,'whisper-x');
 assert.equal(agent.bestEffortEventIds.has(update.event_id),true);agent.stop();
});
test('a rejected best-effort update is a notice, not the end of a live call',async()=>{
 const {agent,socket}=await ready();const notices=[];let faults=0;agent.on('notice',n=>notices.push(n));agent.on('fault',()=>faults++);
 const id=socket.sent[1].event_id;
 socket.emit('message',Buffer.from(JSON.stringify({type:'error',error:{event_id:id,message:'unimplemented session field'}})));
 assert.equal(agent.state,'ready');assert.equal(faults,0);assert.equal(notices[0].kind,'best_effort_rejected');
 assert.equal(agent.bestEffortEventIds.has(id),false);agent.stop();
});
test('an untagged unimplemented rejection inside the window is swallowed once and then fatal again',async()=>{
 const {agent,socket}=await ready();const notices=[];agent.on('notice',n=>notices.push(n));agent.on('fault',()=>{});
 socket.emit('message',Buffer.from('{"type":"error","error":{"code":"unimplemented","message":"nope"}}'));
 assert.equal(agent.state,'ready');assert.equal(notices.length,1);
 socket.emit('message',Buffer.from('{"type":"session.updated"}'));assert.equal(agent.bestEffortEventIds.size,0);
 socket.emit('message',Buffer.from('{"type":"error","error":{"code":"unimplemented","message":"nope"}}'));
 assert.equal(agent.state,'closed');
});
test('an unrelated provider error after readiness remains fatal',async()=>{
 const {agent,socket}=await ready();let faults=0;const notices=[];agent.on('fault',()=>faults++);agent.on('notice',n=>notices.push(n));
 socket.emit('message',Buffer.from('{"type":"error","error":{"message":"quota exceeded"}}'));
 assert.equal(faults,1);assert.equal(notices.length,0);assert.equal(agent.state,'closed');
});
test('a setup error is fatal even while a best-effort id is pending',async()=>{
 const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',socketFactory:()=>socket});
 const started=agent.start();socket.emit('open');agent.bestEffortEventIds.add('cc-transcription-pending');
 socket.emit('message',Buffer.from('{"type":"error","error":{"message":"unimplemented"}}'));
 await assert.rejects(started,/unimplemented/);assert.equal(agent.state,'closed');
});
test('model mode: greeting is configurable, sent once, and never before readiness',async()=>{
 const socket=new Socket();const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',greeting:'您好',socketFactory:()=>socket});
 assert.equal(agent.greet(),false);const started=agent.start();socket.emit('open');
 assert.equal(agent.greet(),false);assert.equal(socket.sent.some(e=>e.type==='response.create'),false);
 socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
 assert.equal(agent.greet(),true);assert.equal(agent.greet(),false);
 const created=socket.sent.filter(e=>e.type==='response.create');
 assert.equal(created.length,1);assert.deepEqual(created[0].response,{instructions:'您好'});agent.stop();
 assert.equal(agent.greet(),false);
});
test('model mode: greeting defaults to an instruction rather than a scripted opener and a failed send is only a notice',async()=>{
 const {agent,socket}=await readyModel();const notices=[];agent.on('notice',n=>notices.push(n));let faults=0;agent.on('fault',()=>faults++);
 socket.send=()=>{throw new Error('socket gone')};
 assert.equal(agent.greet(),false);assert.equal(agent.greeted,false);assert.equal(faults,0);
 assert.equal(notices[0].kind,'greeting_failed');assert.equal(agent.greeting,'通话已接通，请用你的开场白问候来电者');
});
test('model mode: the greeting is tagged best effort, sends no manual cancel, and a refusal is only a notice',async()=>{
 const {agent,socket}=await readyModel();const notices=[];let faults=0;agent.on('notice',n=>notices.push(n));agent.on('fault',()=>faults++);
 socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"self"}}'));
 assert.equal(agent.greet(),true);
 const create=socket.sent.find(e=>e.type==='response.create');
 assert.equal(socket.sent.some(e=>e.type==='response.cancel'),false,'a manual cancel can race the provider and surface an untagged error');
 assert.match(create.event_id,/^cc-greeting-[0-9a-f]{8}-/);
 assert.equal(agent.outputGeneration,0,'the opener was fenced before the greeting had started');
 socket.emit('message',Buffer.from(JSON.stringify({type:'error',error:{event_id:create.event_id,message:'conversation already has an active response'}})));
 assert.equal(agent.state,'ready');assert.equal(faults,0);assert.equal(notices.at(-1).kind,'best_effort_rejected');
 agent.stop();
});
test('model mode: the greeting response opens a new playback generation and nothing is cancelled when it is the first',async()=>{
 const {agent,socket}=await readyModel();const audio=[],flushes=[];agent.on('audio',e=>audio.push(e));agent.on('flushAudio',e=>flushes.push(e.generation));
 assert.equal(agent.greet(),true);
 assert.equal(socket.sent.some(e=>e.type==='response.cancel'),false);
 socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"greeting"}}'));
 assert.deepEqual(flushes,[1]);assert.equal(agent.cancelledResponses.size,0);
 socket.emit('message',Buffer.from('{"type":"response.output_audio.delta","response_id":"greeting","delta":"AAAA"}'));
 assert.deepEqual(audio.map(e=>e.generation),[1]);
 socket.emit('message',Buffer.from('{"type":"response.created","response":{"id":"reply"}}'));
 assert.deepEqual(flushes,[1],'only the greeting fences the session opener');
 agent.stop();
});
test('a server event id beside the client one still identifies the best-effort update',async()=>{
 const {agent,socket}=await ready();const notices=[];let faults=0;agent.on('notice',n=>notices.push(n));agent.on('fault',()=>faults++);
 const id=socket.sent[1].event_id;
 socket.emit('message',Buffer.from(JSON.stringify({type:'error',event_id:'evt_server',error:{event_id:id,message:'Invalid session configuration'}})));
 assert.equal(agent.state,'ready');assert.equal(faults,0);assert.equal(notices[0].kind,'best_effort_rejected');
 assert.equal(agent.bestEffortEventIds.size,0);agent.stop();
});
test('S23: configured endpointing rides the initial session.update and a refusal fails before the answer',async()=>{
 class RawSocket extends EventEmitter{readyState=1;bufferedAmount=0;raw=[];send(s){this.raw.push(s)}close(){this.readyState=3;this.emit('close')}}
 const socket=new RawSocket();
 const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',vadThreshold:0.5,vadPrefixMs:300,vadSilenceMs:800,socketFactory:()=>socket});
 const started=agent.start();socket.emit('open');
 assert.deepEqual(JSON.parse(socket.raw[0]).session.turn_detection,
  {type:'server_vad',threshold:0.5,prefix_padding_ms:300,silence_duration_ms:800});
 // The initial update is deliberately NOT best-effort tagged (see the byte-for-byte test above):
 // a refusal is fatal, and it happens in start(), before the worker commits the answer.
 socket.emit('message',Buffer.from('{"type":"error","error":{"message":"unknown field silence_duration_ms"}}'));
 await assert.rejects(started,/unknown field/);assert.equal(agent.state,'closed');
});
test('S23: zero is a configured endpointing value, not an absent one',()=>{
 const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',vadThreshold:0,vadPrefixMs:0});
 assert.deepEqual(agent.turnDetection,{type:'server_vad',threshold:0,prefix_padding_ms:0});
 assert.deepEqual(new XaiVoiceAgent({apiKey:'test',model:'m'}).turnDetection,{type:'server_vad'});
 for(const bad of [{vadThreshold:1.5},{vadPrefixMs:-1},{vadSilenceMs:1.5},{vadSilenceMs:6000}])
  assert.throws(()=>new XaiVoiceAgent({apiKey:'test',model:'m',...bad}),/Invalid VAD/);
});

// ---------------------------------------------------------------------------------------------
// S27（2026-09-12 真实探针 /tmp/xai-probe-S1..S6）: agent-mode opener hold-and-release.
// The Space agent's own opener IS the greeting (S1), a response.create while it is in flight or
// after it finished is silently dropped (S2/S3), and a bare response.cancel at response.created
// kills a turn cleanly (S4/S6). Production held the audio gate closed until Control opened it, so
// the caller used to hear only the tail of that opener and its transcript was never recorded.
// ---------------------------------------------------------------------------------------------
const feed=(socket,event)=>socket.emit('message',Buffer.from(typeof event==='string'?event:JSON.stringify(event)));

test('S27: the Space agent opener is held until greet() releases it, and greet() puts nothing on the wire',async()=>{
 const {agent,socket}=await ready({release:false});
 const audio=[],transcripts=[],completed=[],flushes=[];
 agent.on('audio',e=>audio.push(e));agent.on('transcript',e=>transcripts.push(e));
 agent.on('completed',e=>completed.push(e));agent.on('flushAudio',e=>flushes.push(e.generation));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 for(const byte of [1,2,3])feed(socket,deltaEvent('opener',Buffer.alloc(4,byte)));
 feed(socket,{type:'response.output_audio_transcript.delta',response_id:'opener',delta:'您好！'});
 feed(socket,{type:'response.output_audio_transcript.delta',response_id:'opener',delta:'我是 VoDog AI 助理，代用户接听电话。'});
 // Never emitted by this adapter (the collector assembles the deltas), so holding it is vacuous.
 feed(socket,{type:'response.output_audio_transcript.done',response_id:'opener',transcript:'您好！我是 VoDog AI 助理，代用户接听电话。'});
 feed(socket,{type:'response.done',response:{id:'opener',status:'completed'}});
 assert.deepEqual([audio.length,transcripts.length,completed.length,flushes.length],[0,0,0,0],'the audio gate is still closed');
 assert.deepEqual(socket.sent.map(e=>e.type),['session.update','session.update'],'only the initial update and the transcription request');
 assert.equal(agent.greet(),true);
 assert.deepEqual(audio.map(e=>e.pcm.toString('hex')),['01010101','02020202','03030303'],'released in wire order');
 assert.deepEqual(audio.map(e=>e.generation),[0,0,0]);
 assert.deepEqual(audio.map(e=>e.responseId),['opener','opener','opener']);
 assert.deepEqual(transcripts,[{text:'您好！',final:false,responseId:'opener'},{text:'我是 VoDog AI 助理，代用户接听电话。',final:false,responseId:'opener'}]);
 assert.deepEqual(completed,[{status:'completed',responseId:'opener',current:true,generation:0}]);
 assert.equal(socket.sent.some(e=>e.type==='response.create'),false,'probe S2/S3: xAI silently drops it, so it must not be sent');
 assert.equal(agent.greet(),false,'one opening line per run');
 agent.stop();
});

test('S27: activation mid-opener releases the held half and the live half continues at the same generation',async()=>{
 const {agent,socket}=await ready({release:false});
 const audio=[],completed=[];agent.on('audio',e=>audio.push(e));agent.on('completed',e=>completed.push(e));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 feed(socket,deltaEvent('opener',Buffer.alloc(4,1)));feed(socket,deltaEvent('opener',Buffer.alloc(4,2)));
 assert.equal(audio.length,0);
 assert.equal(agent.greet(),true);
 assert.equal(audio.length,2,'the first half is released at greet()');
 feed(socket,deltaEvent('opener',Buffer.alloc(4,3)));feed(socket,deltaEvent('opener',Buffer.alloc(4,4)));
 feed(socket,{type:'response.done',response:{id:'opener',status:'completed'}});
 assert.deepEqual(audio.map(e=>e.pcm.toString('hex')),['01010101','02020202','03030303','04040404']);
 assert.deepEqual(audio.map(e=>e.generation),[0,0,0,0],'a re-tagged release must not fence out the live remainder');
 assert.deepEqual(completed,[{status:'completed',responseId:'opener',current:true,generation:0}],'one completion, not two');
 agent.stop();
});

test('S27: an opener created after greet() is pass-through and never held',async()=>{
 const {agent,socket}=await ready();
 const audio=[],flushes=[];agent.on('audio',e=>audio.push(e));agent.on('flushAudio',e=>flushes.push(e.generation));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 feed(socket,deltaEvent('opener',Buffer.alloc(4,7)));
 assert.deepEqual(audio.map(e=>e.pcm.toString('hex')),['07070707'],'this is what run 821ac3c2 already did right');
 assert.deepEqual([audio[0].generation,flushes.length,agent.openerHeld.length],[0,0,0]);
 agent.stop();
});

test('S27: the idle-timeout turn before release is cancelled on sight and reaches nothing',async()=>{
 const {agent,socket}=await ready({release:false});
 const audio=[],transcripts=[],completed=[],flushes=[];
 agent.on('audio',e=>audio.push(e));agent.on('transcript',e=>transcripts.push(e));
 agent.on('completed',e=>completed.push(e));agent.on('flushAudio',e=>flushes.push(e.generation));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 feed(socket,deltaEvent('opener',Buffer.alloc(4,1)));
 // ~15 s with no uplink audio: xAI commits an empty user item and the agent starts an unsolicited
 // turn（「抱歉，我无法接听电话…」, probe S1/S2）. Cancelling it at response.created is probe S4/S6.
 feed(socket,{type:'response.created',response:{id:'idle'}});
 assert.deepEqual(socket.sent.filter(e=>e.type==='response.cancel'),[{type:'response.cancel'}],'bare cancel, exactly as probed');
 feed(socket,deltaEvent('idle',Buffer.alloc(4,9)));
 feed(socket,{type:'response.output_audio_transcript.delta',response_id:'idle',delta:'抱歉，我无法接听电话。'});
 feed(socket,{type:'response.done',response:{id:'idle',status:'cancelled'}});
 assert.deepEqual([transcripts.length,completed.length,flushes.length,agent.outputGeneration],[0,0,0,0]);
 assert.equal(agent.responseId,'opener','the stray never became the current response');
 assert.equal(agent.greet(),true);
 assert.deepEqual(audio.map(e=>e.pcm.toString('hex')),['01010101'],'only the opener is released');
 agent.stop();
});

test('S27: after release a barge-in still cuts the opener and opens a new generation',async()=>{
 const {agent,socket}=await ready({release:false});
 const audio=[],flushes=[];agent.on('audio',e=>audio.push(e));agent.on('flushAudio',e=>flushes.push(e.generation));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 feed(socket,deltaEvent('opener',Buffer.alloc(4,1)));
 assert.equal(agent.greet(),true);
 assert.deepEqual(audio.map(e=>e.generation),[0]);
 feed(socket,{type:'input_audio_buffer.speech_started'});
 assert.deepEqual(flushes,[1],'server VAD still advances the local playback generation');
 feed(socket,deltaEvent('opener',Buffer.alloc(4,2)));
 assert.equal(audio.length,1,'audio the caller talked over never reaches the bridge');
 assert.equal(socket.sent.some(e=>e.type==='response.cancel'),false);
 agent.stop();
});

test('S27: stop() during the hold discards the buffer without emitting',async()=>{
 const {agent,socket}=await ready({release:false});
 const emitted=[];for(const name of ['audio','transcript','completed'])agent.on(name,()=>emitted.push(name));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 feed(socket,deltaEvent('opener',Buffer.alloc(4,1)));
 feed(socket,{type:'response.output_audio_transcript.delta',response_id:'opener',delta:'您好'});
 assert.equal(agent.openerHeld.length,2);
 agent.stop();
 assert.deepEqual(emitted,[]);
 assert.deepEqual([agent.openerHeld.length,agent.openerHeldBytes],[0,0]);
 assert.equal(agent.greet(),false,'a stopped run has no opening line left to release');
});

test('S27: the opener hold is bounded and reports an overflow once',async()=>{
 const {agent,socket}=await ready({release:false});
 const notices=[],audio=[];agent.on('notice',n=>notices.push(n.kind));agent.on('audio',e=>audio.push(e));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 for(let index=0;index<205;index++)feed(socket,deltaEvent('opener',Buffer.alloc(2,index%256)));
 assert.deepEqual(notices,['opener_hold_overflow'],'one notice, never a fault, and never a log flood');
 assert.equal(agent.greet(),true);
 assert.equal(audio.length,200,'oldest first: what the caller hears is the end of the sentence, not its start');
 agent.stop();
});

test('S27: agent mode omits instructions from the initial session.update; model mode still sends it',async()=>{
 class RawSocket extends EventEmitter{readyState=1;bufferedAmount=0;raw=[];send(s){this.raw.push(s)}close(){this.readyState=3;this.emit('close')}}
 // The deployed path: env -> xaiConfig -> createVoiceAgent. No env key supplies instructions
 // (XAI_ENV_KEYS, and infra/deploy-voice-relay-secondary.py's OPTIONAL_ENV_KEYS/ALLOWED_KEYS), so the Space
 // agent keeps its own prompt — sending ours replaced it and the agent said「我是AI助理」(probe S6
 // vs S1/S2/S4/S5, and two real calls today).
 const space=new RawSocket();
 const agent=createVoiceAgent({provider:'xai',env:{XAI_API_KEY:'test',XAI_AGENT_ID:'agent_custom'},overrides:{socketFactory:()=>space}});
 const started=agent.start();space.emit('open');
 // S27 决策 13: agent mode also omits `tools` and restores the Space agent's own two idle fields.
 assert.equal(space.raw[0],'{"type":"session.update","session":{"turn_detection":{"type":"server_vad","idle_timeout_ms":5000,"end_call_after_idle_reminder_count":2},"audio":{"input":{"format":{"type":"audio/pcm","rate":16000},"transport":"json"},"output":{"format":{"type":"audio/pcm","rate":16000},"transport":"json"}}}}');
 space.emit('message',Buffer.from('{"type":"session.updated"}'));await started;agent.stop();
 const pinned=new RawSocket();
 const model=createVoiceAgent({provider:'xai',env:{XAI_API_KEY:'test',XAI_REALTIME_MODEL:'pinned-model'},overrides:{socketFactory:()=>pinned}});
 const running=model.start();pinned.emit('open');
 assert.equal(JSON.parse(pinned.raw[0]).session.instructions,'请用中文简洁接听电话，说明你是AI助理。','no Space agent persona to clobber');
 pinned.emit('message',Buffer.from('{"type":"session.updated"}'));await running;model.stop();
 // An explicitly configured instruction still reaches agent mode; nothing in production supplies one.
 assert.equal(new XaiVoiceAgent({apiKey:'test',agentId:'a',instructions:'x'}).instructions,'x');
 assert.equal(new XaiVoiceAgent({apiKey:'test',agentId:'a'}).instructions,undefined);
});

// ---------------------------------------------------------------------------------------------
// S27 决策 13（2026-09-12 真实探针 /tmp/xai-tool-probe-T1.log, T2.log）: the Space agent declares its
// OWN `end_call` tool server-side and its own idle `turn_detection`. Production's initial
// `session.update` sent `tools: []` and a bare `{type:'server_vad',silence_duration_ms:800}`, which
// replaced both — the agent could never hang up. With the tool present it calls `end_call` in the
// same response as the spoken goodbye, the server injects `{"status":"ending_call"}` and closes the
// socket ~1.5 s later, while about a second of that goodbye is still queued for real-time playback.
// ---------------------------------------------------------------------------------------------
const endCallDone=(responseId='r1')=>({type:'response.function_call_arguments.done',event_id:'e1',item_id:'i1',response_id:responseId,
 output_index:0,call_id:'call-1-0',name:'end_call',arguments:'{"reason":"sales_refused"}'});

test('S27: agent mode sends no tools key at all; model mode still sends the empty list',async()=>{
 class RawSocket extends EventEmitter{readyState=1;bufferedAmount=0;raw=[];send(s){this.raw.push(s)}close(){this.readyState=3;this.emit('close')}}
 const space=new RawSocket();
 const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',socketFactory:()=>space});
 const started=agent.start();space.emit('open');
 const spaceSession=JSON.parse(space.raw[0]).session;
 assert.equal('tools' in spaceSession,false,'`tools: []` wipes the Space agent\'s own end_call');
 space.emit('message',Buffer.from('{"type":"session.updated"}'));await started;agent.stop();
 const pinned=new RawSocket();
 const model=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',socketFactory:()=>pinned});
 const running=model.start();pinned.emit('open');
 assert.deepEqual(JSON.parse(pinned.raw[0]).session.tools,[],'no Space agent tool list to protect');
 pinned.emit('message',Buffer.from('{"type":"session.updated"}'));await running;model.stop();
});

test('S27: agent-mode turn_detection carries the Space agent\'s own idle fields beside ours',()=>{
 assert.deepEqual(new XaiVoiceAgent({apiKey:'test',agentId:'a'}).turnDetection,
  {type:'server_vad',idle_timeout_ms:5000,end_call_after_idle_reminder_count:2});
 assert.deepEqual(new XaiVoiceAgent({apiKey:'test',agentId:'a',vadThreshold:0.5,vadPrefixMs:300,vadSilenceMs:800}).turnDetection,
  {type:'server_vad',threshold:0.5,prefix_padding_ms:300,silence_duration_ms:800,idle_timeout_ms:5000,end_call_after_idle_reminder_count:2});
 // Model mode is unchanged: there is no Space agent behind it to preserve.
 assert.deepEqual(new XaiVoiceAgent({apiKey:'test',model:'m',vadSilenceMs:800}).turnDetection,{type:'server_vad',silence_duration_ms:800});
});

test('S27: end_call is one notice, answers nothing on the wire, and never asks for another response',async()=>{
 const {agent,socket}=await ready();
 const notices=[];agent.on('notice',notice=>notices.push(notice.kind));
 feed(socket,{type:'response.created',response:{id:'r1'}});
 const before=socket.sent.length;
 // The same call is carried by four other event shapes; none of them may trigger a second notice.
 feed(socket,{type:'response.output_item.added',response_id:'r1',item:{type:'function_call',call_id:'call-1-0',name:'end_call',arguments:''}});
 feed(socket,{type:'conversation.item.added',item:{type:'function_call',call_id:'call-1-0',name:'end_call',arguments:''}});
 feed(socket,{type:'response.function_call_arguments.delta',response_id:'r1',item_id:'i1',call_id:'call-1-0',delta:'{"reason":"sales_refused"}'});
 feed(socket,endCallDone('r1'));
 feed(socket,endCallDone('r1'));
 assert.deepEqual(notices,['end_call']);
 assert.equal(agent.endCallRequested,true);
 assert.equal(socket.sent.length,before,'no function_call_output and no response.create');
 agent.stop();
});

test('S27: a cancelled idle turn calling end_call is not the AI saying goodbye',async()=>{
 const {agent,socket}=await ready({release:false});
 const notices=[];agent.on('notice',notice=>notices.push(notice.kind));
 feed(socket,{type:'response.created',response:{id:'opener'}});
 feed(socket,{type:'response.created',response:{id:'idle'}});   // cancelled on sight (probe S1/S2)
 feed(socket,endCallDone('idle'));
 assert.deepEqual(notices,[]);
 assert.equal(agent.endCallRequested,false);
 agent.stop();
});

test('S27: the close that follows end_call keeps the queued goodbye and names itself',async()=>{
 const {agent,socket}=await ready();
 const flushes=[],closed=[];
 agent.on('flushAudio',event=>flushes.push(event));agent.on('closed',payload=>closed.push(payload));
 feed(socket,{type:'response.created',response:{id:'r1'}});
 feed(socket,endCallDone('r1'));
 socket.close();
 assert.deepEqual(flushes,[],'a flush advances the playback generation, which clears the queue');
 assert.deepEqual(closed,[{reason:'ended_by_provider'}]);
 assert.equal(agent.outputGeneration,0);
});

test('S27: a close with no end_call behind it still fences playback and carries an empty reason',async()=>{
 const {agent,socket}=await ready();
 const flushes=[],closed=[];
 agent.on('flushAudio',event=>flushes.push(event));agent.on('closed',payload=>closed.push(payload));
 socket.close();
 assert.deepEqual(flushes,[{generation:1}]);
 assert.deepEqual(closed,[{}]);
});

// S27 决策 15（真实通话 c3734597, 2026-09-12 13:55 UTC）: `ws` reports the server's post-`end_call`
// teardown as an `error` BEFORE `close`. That fault reached the worker as `provider_failed`, which
// aborted the run and tore the bridge down under the drain — 0.87 s of the goodbye was discarded.
test('S27: a socket error after end_call is the expected end, not a fault',async()=>{
 const {agent,socket}=await ready();
 const faults=[],closed=[],flushes=[];
 agent.on('fault',error=>faults.push(error));agent.on('closed',payload=>closed.push(payload));agent.on('flushAudio',event=>flushes.push(event));
 feed(socket,{type:'response.created',response:{id:'r1'}});
 feed(socket,endCallDone('r1'));
 socket.emit('error',new Error('read ECONNRESET'));
 socket.emit('close');
 assert.deepEqual(faults,[],'an expected teardown must not end the run as a provider failure');
 assert.deepEqual(closed,[{reason:'ended_by_provider'}],'still exactly one closed, with its reason');
 assert.deepEqual(flushes,[],'and the goodbye still queued in the bridge is not cleared');
 assert.equal(agent.state,'closed');
});

test('S27: a socket error with no end_call behind it is still a fault',async()=>{
 const {agent,socket}=await ready();
 const faults=[],closed=[];
 agent.on('fault',error=>faults.push(error));agent.on('closed',payload=>closed.push(payload));
 socket.emit('error',new Error('read ECONNRESET'));
 assert.equal(faults.length,1);
 assert.deepEqual(closed,[{}]);
 assert.equal(agent.state,'closed');
});

// S27 决策 16（2026-09-12 in-image probe）: xAI echoed `input_audio_transcription`
// {"model":"whisper-1","language":"zh"} back unchanged, in both the flat and the nested shape, with
// no `error` event — so the caller-language hint is accepted and agent mode defaults to it.
test('S27: the caller language hint rides the tagged transcription update in both shapes',async()=>{
 const socket=new Socket();
 const agent=new XaiVoiceAgent({apiKey:'test',agentId:'test',transcriptionLanguage:'zh',socketFactory:()=>socket});
 const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
 const update=socket.sent[1];
 assert.equal(update.type,'session.update');
 assert.match(update.event_id,/^cc-transcription-/,'still best effort: a refusal must be a notice, not a failed call');
 assert.deepEqual(update.session.input_audio_transcription,{model:'whisper-1',language:'zh'});
 assert.deepEqual(update.session.audio.input.transcription,{model:'whisper-1',language:'zh'});
 assert.equal(socket.sent.length,2,'and nothing else was added to the wire');
 agent.stop();
});

test('S27: without a configured language the transcription update is byte-for-byte what it was',async()=>{
 const socket=new Socket();
 const agent=new XaiVoiceAgent({apiKey:'test',model:'pinned-model',socketFactory:()=>socket});
 const started=agent.start();socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.updated"}'));await started;
 assert.deepEqual(socket.sent[1].session.input_audio_transcription,{model:'whisper-1'});
 assert.deepEqual(socket.sent[1].session.audio.input.transcription,{model:'whisper-1'});
 assert.throws(()=>new XaiVoiceAgent({apiKey:'test',agentId:'a',transcriptionLanguage:'chinese, please'}),/transcription language/);
 agent.stop();
});

test('S27: XAI_TRANSCRIPTION_LANGUAGE defaults to zh in agent mode, is overridable and removable',()=>{
 assert.deepEqual(xaiTranscriptionLanguage({},{agentMode:true}),{transcriptionLanguage:'zh'});
 assert.deepEqual(xaiTranscriptionLanguage({},{agentMode:false}),{},'no deployed caller behind a pinned model');
 assert.deepEqual(xaiTranscriptionLanguage({XAI_TRANSCRIPTION_LANGUAGE:'zh-CN'},{agentMode:true}),{transcriptionLanguage:'zh-CN'});
 // A key that is present but empty is how the hint is switched off from the env file.
 assert.deepEqual(xaiTranscriptionLanguage({XAI_TRANSCRIPTION_LANGUAGE:''},{agentMode:true}),{});
 assert.deepEqual(xaiTranscriptionLanguage({XAI_TRANSCRIPTION_LANGUAGE:'  '},{agentMode:true}),{});
 for(const bad of ['z','chinese please','zh_CN','1234'])
  assert.throws(()=>xaiTranscriptionLanguage({XAI_TRANSCRIPTION_LANGUAGE:bad},{agentMode:true}),/XAI_TRANSCRIPTION_LANGUAGE/);
 assert.equal(XAI_ENV_KEYS.includes('XAI_TRANSCRIPTION_LANGUAGE'),true,'and the key is announced with the rest');
});
