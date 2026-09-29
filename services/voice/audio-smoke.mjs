import WebSocket from 'ws';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {vadSettings} from './server.mjs';
const key=process.env.XAI_API_KEY;if(!key)throw new Error('XAI_API_KEY not configured');
// S23 决策 4 pre-flight: run this with VOICE_VAD_* set to prove xAI accepts the endpointing fields
// BEFORE deploying them. The worker sends them in its initial session.update, where a refusal is
// fatal to the run, so this smoke is the cheap place to find out.
const {vadThreshold,vadPrefixMs,vadSilenceMs}=vadSettings(process.env);
const turnDetection={type:'server_vad',...(vadThreshold===undefined?{}:{threshold:vadThreshold}),
 ...(vadPrefixMs===undefined?{}:{prefix_padding_ms:vadPrefixMs}),...(vadSilenceMs===undefined?{}:{silence_duration_ms:vadSilenceMs})};
const dir=process.env.VOICE_PROBE_OUTPUT_DIR || './probe-output';mkdirSync(dir,{recursive:true});
const result={testedAt:new Date().toISOString(),connected:false,configured:false,turnDetection,audioBytes:0,transcript:'',error:null};
const ws=new WebSocket(`wss://api.x.ai/v1/realtime?agent_id=${encodeURIComponent(process.env.XAI_AGENT_ID||'')}`,{headers:{Authorization:`Bearer ${key}`},handshakeTimeout:12000});
const timer=setTimeout(()=>finish('Timed out after 30 seconds'),30000);let done=false;
function finish(error){if(done)return;done=true;clearTimeout(timer);result.error=error||null;writeFileSync(`${dir}/xai-audio-smoke.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));ws.close();setTimeout(()=>process.exit(error?1:0),200).unref();}
ws.on('open',()=>{result.connected=true;ws.send(JSON.stringify({type:'session.update',session:{turn_detection:turnDetection,audio:{input:{format:{type:'audio/pcm',rate:16000}},output:{format:{type:'audio/pcm',rate:16000}}},instructions:'You are testing a telephone gateway. Reply briefly in Chinese. Do not call tools.'}}));});
ws.on('message',async data=>{let e;try{e=JSON.parse(data)}catch{return}if(e.type==='error')return finish(e.error?.message||'Provider rejected request');if(e.type==='session.updated'){result.configured=true;const pcm=Buffer.concat([readFileSync(process.env.VOICE_PROBE_PCM_PATH || './fixtures/synthetic.pcm'),Buffer.alloc(32000)]);for(let i=0;i<pcm.length&&!done;i+=640){ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:pcm.subarray(i,i+640).toString('base64')}));await new Promise(r=>setTimeout(r,20));}}if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta')result.audioBytes+=Buffer.from(e.delta,'base64').length;if(e.type==='response.output_audio_transcript.delta'||e.type==='response.audio_transcript.delta')result.transcript+=e.delta;if(e.type==='response.done'){result.responseStatus=e.response?.status;result.responseDetails=e.response?.status_details;finish(result.audioBytes>0?null:'Response completed without audio');}});
ws.on('error',e=>finish(e.message));ws.on('close',()=>{if(!done)finish('Closed before response completed')});
