import React, {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useReportedError} from './ui-error';
import {serverRecordingLabel,parseRecording,recordingAttachmentFilename,recordingUrl,verifyPixelTrackHeaders,type DerivedTrackDescriptor,type UplinkTrackDescriptor,type RecordingDescriptor,type RecordingSource,type RecordingTrack,type TrackDescriptor} from './recording-contract';
import {audioOwnership} from './audio-ownership';
import {expireBrowserSession,browserSessionGeneration} from './session-boundary';
import {recordingErrorCode,recordingRequest} from './recording-request';
import {pairContractDurationSeconds,playbackPairs,RecordingPairController,recordingPairIdentity,type PairState,type PairTrackDescriptor} from './recording-pair';
import {formatGatewayDateTime,gatewayDisplayTimeZone} from './gateway-time';
import {CallDetailGuard} from './call-detail-guard';
import type {ApiRequest} from './contacts';
import {gatewayArchiveLabel,gatewayKindLabel} from './gateway-kind';

const labels={remote_original:'对方原声',caller_original:'我的原声',caller_playout:'通话播放声（含补偿）',caller_uplink:'本机上行（含本机接入）'};
const pixelDisabled='设备原始归档尚未启用；当前可播放服务器录音。';
const DOWNLOAD_TIMEOUT_MS=900_000;
const recordingPlayers=new Set<()=>void>();
function registerRecordingPlayer(pause:()=>void,dispose:()=>void){recordingPlayers.add(pause);const unregister=audioOwnership.registerPlayer(dispose);return()=>{recordingPlayers.delete(pause);unregister();};}
function claimRecordingPlayer(owner:()=>void){for(const stop of [...recordingPlayers])if(stop!==owner)stop();}
/** `preferPixelSource`：S38 手机直拨的通话没有 media_node 那一路，录音只在 Pixel 归档里，默认就打开它。 */
export function CallRecording({callId,timeZone,request,preferPixelSource=false,ownerJoinedLocal=false,gatewayKind,initialOpen=false}:{callId:string;timeZone?:string;request?:ApiRequest;preferPixelSource?:boolean;ownerJoinedLocal?:boolean;gatewayKind?:string|null;/** 记录 detail pane: open on mount (still closes when a call starts). */initialOpen?:boolean}){
 const callActiveNow=audioOwnership.isCallActive();
 const [opened,setOpened]=useState(()=>initialOpen&&!callActiveNow),[source,setSource]=useState<RecordingSource>(preferPixelSource?'pixel':'media_node');
 const [missingNotice,setMissingNotice]=useState('');
 const callActive=useSyncExternalStore(audioOwnership.subscribe,audioOwnership.isCallActive);
 const zone=gatewayDisplayTimeZone(timeZone);
 useEffect(()=>audioOwnership.registerPlayer(()=>setOpened(false)),[]);
 return <div className="call-recording">
  <button className="passkey" disabled={callActive} aria-expanded={opened} onClick={()=>{setMissingNotice('');setOpened(value=>!value);}}>{opened?'收起录音':'查看录音'}</button>
  {callActive&&<p className="note">通话结束后可播放录音。</p>}
  {missingNotice&&<p className="note" role="status">{missingNotice}</p>}
  {opened&&request&&<CallDetailGuard callId={callId} request={request} onMissing={message=>{audioOwnership.stopRecordings();setOpened(false);setMissingNotice(message);}}/>}
  {opened&&<><div className="recording-sources" role="group" aria-label="录音副本">
   {(['media_node','pixel'] as const).map(value=><button key={value} className={source===value?'primary':'passkey'} aria-pressed={source===value} onClick={()=>setSource(value)}>{value==='pixel'?gatewayArchiveLabel(gatewayKind):serverRecordingLabel(ownerJoinedLocal)}</button>)}
  </div><RecordingDetail key={`${callId}:${source}`} callId={callId} source={source} timeZone={zone} gatewayKind={gatewayKind}/></>}
 </div>;
}
async function responseError(response:Response,generation:number):Promise<Error>{
 if(response.status===401)expireBrowserSession(generation);
 const code=await recordingErrorCode(response);
 return new Error(response.status===401?'登录已过期，请重新登录。':code==='PIXEL_ARCHIVE_DISABLED'?pixelDisabled:response.status===404?'这份录音暂不可访问。':response.status===416?'录音内容已变化，请重新打开录音。':'暂时无法读取录音，请稍后重试。');
}
function RecordingDetail({callId,source,timeZone,gatewayKind}:{callId:string;source:RecordingSource;timeZone:string;gatewayKind?:string|null}){
 const [recording,setRecording]=useState<RecordingDescriptor|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useReportedError('recording','load',error!==pixelDisabled&&error);
 useEffect(()=>{const controller=new AbortController(),generation=browserSessionGeneration();setLoading(true);setError('');setRecording(null);
  void recordingRequest(recordingUrl(callId,source),{credentials:'include',cache:'no-store'},controller.signal,async response=>{
   if(!response.ok)throw await responseError(response,generation);
   const value=await response.json() as {recording:unknown};
   return parseRecording(value.recording,source,callId);
  }).then(value=>{if(!controller.signal.aborted)setRecording(value);}).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'无法读取录音。');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  const unregister=audioOwnership.registerPlayer(()=>controller.abort());
  return()=>{unregister();controller.abort();};
 },[callId,source,attempt]);
 if(loading)return <p role="status">正在读取录音…</p>;
 if(error===pixelDisabled)return <p className="note" role="status">{error}</p>;
 if(error)return <div><p className="error" role="alert">{error}</p><button className="passkey" onClick={()=>setAttempt(value=>value+1)}>重试</button></div>;
 if(!recording)return <p className="note">{source==='pixel'?`${gatewayKindLabel(gatewayKind).short} 原始录音尚未归档，或仍在上传。`:'录音尚未生成或仍在保存。'}</p>;
 return <div><p className="note">{recording.archiveComplete?'声轨已保存':'保存未完成，以下声轨可供查看'} · {formatGatewayDateTime(recording.finalizedAt,timeZone)}</p>
 {recording.captureComplete===false&&<p className="note">录制过程中有缺失，回放可能出现缺音。</p>}
  {playbackPairs(recording,source).map(pair=><CombinedRecordingAudio key={pair.label} callId={callId} source={source} tracks={pair.tracks} label={pair.label} description={pair.description}/>)}
  <details className="original-tracks"><summary>分别播放原声</summary>{[...recording.tracks,...recording.uplinkTracks].filter(track=>track.bytes>(source==='pixel'?44:0)).map(track=><RecordingAudio key={`${track.id}:${track.sha256}`} callId={callId} source={source} track={track}/>)}</details>
  {recording.derivedTracks.length>0&&<details className="derived-tracks"><summary>播放通话声音（含补偿）</summary><p className="note">这是补偿丢包后的播放声，只用于收听；原声保持不变。</p>{recording.derivedTracks.filter(track=>track.bytes>44).map(track=><RecordingAudio key={`${track.id}:${track.sha256}`} callId={callId} source={source} track={track}/>)}</details>}
 </div>;
}
export function CombinedRecordingAudio({callId,source,tracks,label,description}:{callId:string;source:RecordingSource;tracks:readonly [PairTrackDescriptor,PairTrackDescriptor];label:string;description:string}){
 const identity=recordingPairIdentity(callId,source,tracks);
 const [verifiedIdentity,setVerifiedIdentity]=useState<string|null>(source==='media_node'?identity:null),[verificationFailure,setVerificationFailure]=useState<{identity:string;message:string}|null>(null);
 const ready=source==='media_node'||verifiedIdentity===identity;
 const verificationError=verificationFailure?.identity===identity?verificationFailure.message:'';
 useReportedError('recording','pair.verify',verificationError);
 useEffect(()=>{
  if(source==='media_node'){setVerifiedIdentity(identity);return;}
  const controller=new AbortController(),generation=browserSessionGeneration();
  void Promise.all(tracks.map(track=>{const url=recordingUrl(callId,source,track.id);return recordingRequest(url,{credentials:'include',cache:'no-store',headers:{Range:'bytes=0-0'}},controller.signal,async response=>{
   try {if(!response.ok)throw await responseError(response,generation);verifyPixelTrackHeaders(response.status,response.headers,track);}
   finally {await response.body?.cancel();}
  });})).then(()=>{if(!controller.signal.aborted){setVerificationFailure(null);setVerifiedIdentity(identity);}}).catch(reason=>{if(!controller.signal.aborted)setVerificationFailure({identity,message:reason instanceof Error?reason.message:'原声暂时无法播放。'});});
  return()=>controller.abort();
 },[identity]);
 if(!ready)return <div className="recording-track combined-recording"><strong>{label}</strong>{verificationError?<p role="alert">{verificationError}</p>:<p role="status">正在校验两条声轨…</p>}</div>;
 return <RecordingPairAudio key={identity} callId={callId} source={source} tracks={tracks} label={label} description={description}/>;
}
function RecordingPairAudio({callId,source,tracks,label,description}:{callId:string;source:RecordingSource;tracks:readonly [PairTrackDescriptor,PairTrackDescriptor];label:string;description:string}){
 const primary=useRef<HTMLAudioElement>(null),secondary=useRef<HTMLAudioElement>(null),controller=useRef<RecordingPairController|null>(null),pauseRef=useRef<()=>void>(()=>{}),disposeRef=useRef<()=>void>(()=>{});
 const contractDuration=pairContractDurationSeconds(tracks);
 const [state,setState]=useState<PairState>({playing:false,buffering:false,currentTime:0,duration:contractDuration,error:''});
 const [rate,setRate]=useState(1),[peaks,setPeaks]=useState<number[]|null>(null);
 useReportedError('recording','pair.play',state.error);
 useEffect(()=>{
  if(!primary.current||!secondary.current)return;const elements=[primary.current,secondary.current] as const,pair=new RecordingPairController(elements,setState,contractDuration);controller.current=pair;let released=false;
  const pause=()=>pair.pause();
  const dispose=()=>{if(released)return;released=true;pair.dispose();for(const audio of elements){audio.removeAttribute('src');audio.load();}};
  pauseRef.current=pause;disposeRef.current=dispose;const unregister=registerRecordingPlayer(pause,dispose);return()=>{unregister();dispose();};
 },[]);
 const progress=state.duration?Math.min(1,state.currentTime/state.duration):0;
 return <div className="recording-track combined-recording"><strong>{label}</strong><p className="note">{description}</p>
  <div className="recording-pair-controls"><button className={'passkey play-toggle'+(state.playing||state.buffering?' playing':'')} onClick={()=>{if(audioOwnership.isCallActive()){disposeRef.current();return;}claimRecordingPlayer(pauseRef.current);(state.playing||state.buffering)?controller.current?.pause():controller.current?.play();}}>{state.playing||state.buffering?'暂停':'播放'}</button>
   <div className={'recording-progress'+(peaks?' has-waveform':'')} style={{'--played':`${progress*100}%`} as React.CSSProperties}>
    {peaks&&<div className="recording-waveform" aria-hidden="true">{peaks.map((peak,index)=><span key={index} className={index/peaks.length<progress?'played':''} style={{height:`${Math.max(8,peak*100)}%`}}/>)}</div>}
    <input type="range" min="0" max={state.duration||0} step="0.1" value={Math.min(state.currentTime,state.duration||0)} disabled={!state.duration} aria-label="双向播放进度" onChange={event=>controller.current?.seek(Number(event.target.value))}/>
   </div>
   <span className="note recording-duration num">{formatTime(state.currentTime)} / {formatTime(state.duration)}</span>
   <button type="button" className="passkey recording-rate num" aria-label={`播放速度 ${rate} 倍`} onClick={()=>{const next=RATES[(RATES.indexOf(rate)+1)%RATES.length]!;setRate(next);for(const audio of [primary.current,secondary.current])if(audio){audio.defaultPlaybackRate=next;audio.playbackRate=next;}}}>{rate}×</button>
   <RecordingDownloadButton callId={callId} source={source} track="conversation" label="下载对话 MP3" note="双方声音时间对齐后合成的一个文件" onBlob={blob=>void decodePeaks(blob).then(value=>{if(value)setPeaks(value);})}/></div>
  <audio ref={primary} hidden preload="metadata" aria-hidden="true" src={recordingUrl(callId,source,tracks[0].id)}/>
  <audio ref={secondary} hidden preload="metadata" aria-hidden="true" src={recordingUrl(callId,source,tracks[1].id)}/>
  {state.error&&<p role="alert">{state.error}</p>}
 </div>;
}
const RATES=[1,1.5,2];
/**
 * S95 waveform: peak amplitude per bucket of audio the user already downloaded (下载对话 MP3). The streamed
 * `<audio>` never exposes its bytes, so until then the player shows a plain progress bar — never a made-up wave.
 */
export async function decodePeaks(blob:Blob,count=72):Promise<number[]|null>{
 const Context=globalThis.OfflineAudioContext;
 if(!Context)return null;
 try{
  const audio=await new Context(1,1,44100).decodeAudioData(await blob.arrayBuffer());
  const data=audio.getChannelData(0),size=Math.max(1,Math.floor(data.length/count)),peaks:number[]=[];
  for(let bucket=0;bucket<count;bucket++){let peak=0;for(let i=bucket*size;i<Math.min(data.length,(bucket+1)*size);i++)peak=Math.max(peak,Math.abs(data[i]!));peaks.push(peak);}
  const max=Math.max(...peaks);
  return max>0?peaks.map(peak=>peak/max):null;
 }catch{return null;}
}
function formatTime(seconds:number){if(!Number.isFinite(seconds)||seconds<0)return '0:00';const whole=Math.floor(seconds);return `${Math.floor(whole/60)}:${String(whole%60).padStart(2,'0')}`;}
function RecordingAudio({callId,source,track}:{callId:string;source:RecordingSource;track:TrackDescriptor|DerivedTrackDescriptor|UplinkTrackDescriptor}){
 const name=labels[track.id];
 const ref=useRef<HTMLAudioElement>(null),pauseRef=useRef<()=>void>(()=>{}),disposeRef=useRef<()=>void>(()=>{}),[ready,setReady]=useState(source==='media_node'),[error,setError]=useState('');
 const url=recordingUrl(callId,source,track.id);
 const knownDuration=typeof track.durationMs==='number'&&Number.isFinite(track.durationMs)&&track.durationMs>=0?track.durationMs/1000:undefined;
 useReportedError('recording','track',error);
 useEffect(()=>{
  const controller=new AbortController(),generation=browserSessionGeneration();setError('');setReady(source==='media_node');
  if(source==='pixel')void recordingRequest(url,{credentials:'include',cache:'no-store',headers:{Range:'bytes=0-0'}},controller.signal,async response=>{
   try {if(!response.ok)throw await responseError(response,generation);verifyPixelTrackHeaders(response.status,response.headers,track);}
   finally {await response.body?.cancel();}
   if(!controller.signal.aborted)setReady(true);
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'音频暂时无法播放。');});
  const pause=()=>ref.current?.pause();const dispose=()=>{controller.abort();const audio=ref.current;if(audio){audio.pause();audio.removeAttribute('src');audio.load();}};
  pauseRef.current=pause;disposeRef.current=dispose;const unregister=registerRecordingPlayer(pause,dispose);
  return()=>{unregister();dispose();};
 },[url,source,track]);
 useEffect(()=>{const audio=ref.current;return()=>{if(audio){audio.pause();audio.removeAttribute('src');audio.load();}};},[]);
 return <div className="recording-track"><div className="recording-track-heading"><strong>{name}</strong>{knownDuration!==undefined&&<span className="note recording-duration">{formatTime(knownDuration)}</span>}<RecordingDownloadButton callId={callId} source={source} track={track.id} label="下载"/></div>
  {track.sourceRole!=='derived_playout'&&track.captureComplete===false&&<p className="note">此声轨录制不完整，可能有短暂缺音</p>}
  {track.sourceRole==='derived_playout'&&<p className="note">补偿播放声{track.gapCount?` · ${track.gapCount} 处缺口`:''}{track.playoutComplete?'':' · 播放轨不完整'}</p>}
  {!ready&&!error&&<p role="status">正在校验声轨…</p>}
  <audio ref={ref} hidden={!ready||Boolean(error)} controls preload="metadata" aria-label={name} src={ready&&!error?url:undefined} onPlay={()=>{if(audioOwnership.isCallActive())disposeRef.current();else claimRecordingPlayer(pauseRef.current);}} onError={()=>setError('音频暂时无法播放，请重新打开录音或重新登录。')}/>
  {error&&<p role="alert">{error}</p>}
 </div>;
}
/** S36 C4: 每个按钮只存一个文件——单声轨或 `conversation` 合成轨，都是 mp3。 */
function RecordingDownloadButton({callId,source,track,label,note,onBlob}:{callId:string;source:RecordingSource;track:RecordingTrack;label:string;note?:string;/** The saved file, for a waveform drawn from real audio. */onBlob?:(blob:Blob)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useReportedError('recording','download',error);
 async function save(){

  if(busy)return;
  setBusy(true);setError('');
  const controller=new AbortController(),generation=browserSessionGeneration();
  let objectUrl='';
  try{
   const url=recordingUrl(callId,source,track,'attachment','mp3');
   const {blob,filename}=await recordingRequest(url,{credentials:'include',cache:'no-store'},controller.signal,async response=>{
    if(!response.ok)throw await responseError(response,generation);
    const blob=await response.blob();
    return {blob,filename:recordingAttachmentFilename(callId,source,track,response.headers.get('Content-Disposition'),'mp3')};
   },DOWNLOAD_TIMEOUT_MS);
   onBlob?.(blob);
   objectUrl=URL.createObjectURL(blob);
   const link=document.createElement('a');
   link.href=objectUrl;
   link.download=filename;
   link.rel='noopener';
   document.body.append(link);
   link.click();
   link.remove();
  }catch(reason){
   if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'下载失败，请稍后重试。');
  }finally{
   if(objectUrl)window.setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
   setBusy(false);
  }
 }
 return <div className="recording-download"><button type="button" className="passkey" disabled={busy} onClick={()=>void save()}>{busy?'正在保存…':label}</button>{note&&<p className="note">{note}</p>}{error&&<p role="alert">{error}</p>}</div>;
}
