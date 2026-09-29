import WebSocket from 'ws';
import {writeFileSync,mkdirSync} from 'node:fs';
const key=process.env.XAI_API_KEY;if(!key)throw new Error('XAI_API_KEY not configured');
const dir=process.env.VOICE_PROBE_OUTPUT_DIR || './probe-output';mkdirSync(dir,{recursive:true});
const result={testedAt:new Date().toISOString(),connected:false,configured:false,audioBytes:0,transcript:'',error:null};
const ws=new WebSocket(`wss://api.x.ai/v1/realtime?agent_id=${encodeURIComponent(process.env.XAI_AGENT_ID||'')}`,{headers:{Authorization:`Bearer ${key}`},handshakeTimeout:12000});
const timer=setTimeout(()=>finish('Timed out after 30 seconds'),30000);let done=false;
function finish(error){if(done)return;done=true;clearTimeout(timer);result.error=error||null;writeFileSync(`${dir}/xai-smoke.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));ws.close();setTimeout(()=>process.exit(error?1:0),200).unref();}
ws.on('open',()=>{result.connected=true;ws.send(JSON.stringify({type:'session.update',session:{audio:{input:{format:{type:'audio/pcm',rate:16000}},output:{format:{type:'audio/pcm',rate:16000}}},instructions:'You are testing a telephone gateway. Reply briefly in Chinese. Do not call tools.'}}));});
ws.on('message',data=>{let e;try{e=JSON.parse(data)}catch{return}if(e.type==='error')return finish(e.error?.message||'Provider rejected request');if(e.type==='session.updated'){result.configured=true;ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'这是一条网关接口测试，请回复测试成功。'}]}}));ws.send(JSON.stringify({type:'response.create'}));}if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta')result.audioBytes+=Buffer.from(e.delta,'base64').length;if(e.type==='response.output_audio_transcript.delta'||e.type==='response.audio_transcript.delta')result.transcript+=e.delta;if(e.type==='response.done'){result.responseStatus=e.response?.status;result.responseDetails=e.response?.status_details;finish(result.audioBytes>0?null:'Response completed without audio');}});
ws.on('error',e=>finish(e.message));ws.on('close',()=>{if(!done)finish('Closed before response completed')});
