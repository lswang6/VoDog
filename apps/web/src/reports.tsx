import React, {useEffect,useRef,useState} from 'react';
import {useReportedError} from './ui-error';
import {useVisibleRefresh} from './visible-refresh';
import {CallRecording} from './recording';
import {preferPixelSource} from './recording-contract';
import {CallDetailGuard} from './call-detail-guard';
import {Pager,clampPage,normalizePageSize,readViewState,storedPage,storedText,writeViewState,type PageSize} from './pager';
import {AiTranscript,clockOffset} from './ai-transcript';
import {HistoryCallActions} from './history-call-actions';
import {browserSessionGeneration,expireBrowserSession} from './session-boundary';
import {formatCompactCallDate,gatewayCalendarDate,gatewayDisplayTimeZone,shiftCalendarDate} from './gateway-time';
import {mergeTranscriptSegments,transcriptTrackLabel,type TranscriptSegment} from './transcript-text';
import type {ApiRequest} from './contacts';
import {callShowsDot} from './badges';
import {internalCallRoute} from './call-occupancy';

const NO_IDS:ReadonlySet<string>=new Set();

type Transcript={status:string;nextAttemptAt?:string;error?:{code:string};result?:{text:string;summary?:string;actionItems?:string[];segments?:TranscriptSegment[]}};

/** `GET /api/v1/reports/calls` item (S22 接口合同). Every S22 addition is optional: an older Control omits it. */
export type ReportTranscriptState='none'|'queued'|'running'|'retry'|'succeeded'|'failed';
export type ReportItem={
 callId:string;
 startedAt:string;
 answeredAt?:string|null;
 endedAt?:string|null;
 direction:string;
 remoteNumber?:string|null;
 contactName?:string|null;
 contactId?:string|null;
 blocked?:boolean;
 blockedEntryId?:string|null;
 sim:{id:string;label?:string|null;slotIndex?:number|null};
 gatewayTimeZone?:string|null;
 answerMode?:string|null;
 answeredByPlatform?:string|null;
 /** S67: only feeds the mark-seen check when a report is opened. */
 conflictDisposition?:string|null;
 /** S67c: server-side 待查看 flag; missing (older Control) = no dot. */
 unseen?:boolean;
 /** S38：`'pixel'` 是手机拨号盘直拨的通话，录音只有一条声轨。 */
 originatingPlatform?:string|null;
 /** S94b：机主在 Pixel 本机接入；缺失 = false。 */
 ownerJoinedLocal?:boolean;
 /** S58：只选录音来源文字，缺失按 Pixel。 */
 gatewayKind?:string|null;
 recordingStatus?:string|null;
 transcriptState?:ReportTranscriptState|null;
 transcriptError?:{code?:string}|null;
 summary?:string|null;
 actionItems?:string[]|null;
 classification?:string|null;
 /** `null` is a historical row the classifier never saw: the card says 未分类 rather than guessing. */
 blockRecommended?:boolean|null;
 blockCategory?:string|null;
 blockReason?:string|null;
 hasAiTranscript?:boolean;
 transcriptCompletedAt?:string|null;
 /** S72：内部通话；peerSim* 是另一条腿的己方卡。旧 Control 缺失 = 非内部。 */
 internal?:boolean;
 peerSimId?:string|null;
 peerSimLabel?:string|null;
 failureReason?:string|null;
};

export type ReportPreset='today'|'7d'|'30d'|'custom';
export const REPORT_PRESETS:readonly [ReportPreset,string][]=[['today','今天'],['7d','7 天'],['30d','30 天'],['custom','自定义']];

async function read<T>(path:string,signal:AbortSignal):Promise<T>{
 const generation=browserSessionGeneration();
 const response=await fetch('/api/v1'+path,{credentials:'include',signal});
 if(response.status===401)expireBrowserSession(generation);
 if(!response.ok)throw new Error(response.status===401?'登录已过期，请重新登录。':response.status===404?'此内容暂不可访问。':'读取失败，请稍后重试。');
 return response.json();
}
function errorStatus(error:unknown):number{
 const status=(error as {status?:unknown})?.status;
 return typeof status==='number'?status:0;
}

export function CallTranscript({callId,request,initialOpen=false}:{callId:string;request?:ApiRequest;initialOpen?:boolean}){
 const [opened,setOpened]=useState(initialOpen);
 const [missingNotice,setMissingNotice]=useState('');
 return <div className="report-transcript"><button type="button" className="passkey" aria-expanded={opened} onClick={()=>{setMissingNotice('');setOpened(v=>!v);}}>{opened?'收起转录':'查看转录'}</button>{missingNotice&&<p className="note" role="status">{missingNotice}</p>}{opened&&request&&<CallDetailGuard callId={callId} request={request} onMissing={message=>{setOpened(false);setMissingNotice(message);}}/>}{opened&&<TranscriptDetail callId={callId}/>}</div>;
}
function TranscriptDetail({callId}:{callId:string}){
 const [value,setValue]=useState<Transcript|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useReportedError('记录','transcript',error);
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;setValue(null);setLoading(true);setError('');
  async function load(){try{const data=await read<{transcript:Transcript|null}>(`/calls/${encodeURIComponent(callId)}/transcript`,controller.signal);if(controller.signal.aborted)return;setValue(data.transcript);if(data.transcript&&['queued','running','retry'].includes(data.transcript.status))timer=setTimeout(()=>void load(),5000);}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'读取失败');}finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>{controller.abort();clearTimeout(timer);};
 },[callId,retry]);
 if(loading)return <p role="status">正在读取转录…</p>;
 if(error)return <div><p role="alert">{error}</p><button className="passkey" onClick={()=>setRetry(v=>v+1)}>重新读取</button></div>;
 if(!value)return <p className="note">此通话尚无转录任务。</p>;
 if(value.status==='failed')return <p role="status">转录失败，原始录音仍可查看。</p>;
 if(value.status!=='succeeded')return <p role="status">{value.status==='retry'?'转录暂时失败，正在等待重试。':'转录处理中…'}</p>;
 if(!value.result)return <p>转录结果暂不可用。</p>;
 const blocks=mergeTranscriptSegments(value.result.segments);
 return <div className="transcript-detail">{value.result.summary&&<p className="transcript-summary"><strong>摘要</strong>{value.result.summary}</p>}{blocks.length?blocks.map((block,index)=><p key={index} className="transcript-line"><span className="transcript-time num">{typeof block.startMs==='number'?clockOffset(block.startMs):''}</span><strong className={block.speaker==='ai'?'speaker-ai':undefined}>{speakerLabel(block.track,block.speaker)}</strong><span className="transcript-text">{block.text}</span></p>):<p>{value.result.text}</p>}<p className="note">机器转录供参考，可对照原始录音核实。</p></div>;
}
/** Transcript lines read 对方 / 我 (S95); other tracks keep their full track name. */
function speakerLabel(track:string,speaker?:string):string{
 if(speaker==='ai')return 'AI';
 if(track==='ai_realtime_transcript'&&speaker==='remote')return '对方';
 return track==='remote_original'?'对方':track==='caller_original'||track==='caller_uplink'?'我':transcriptTrackLabel(track);
}

/** 今天/7 天/30 天 are inclusive calendar windows ending today; 自定义 keeps whatever the two date inputs hold. */
export function reportWindowRange(preset:ReportPreset,today:string):{from:string;to:string}|null{
 if(preset==='custom')return null;
 if(preset==='today')return {from:today,to:today};
 return {from:shiftCalendarDate(today,preset==='30d'?-29:-6),to:today};
}

/**
 * `GET /reports/calls?timeZone=&from=&to=[&page=&pageSize=][&query=][&simId=]` — `period` is only for the pre-S22
 * server, and `page`/`pageSize`/`simId` are the S28 additions a pre-S28 server simply ignores.
 */
export function reportQueryPath({timeZone,from,to,query,simId,page,pageSize}:{timeZone:string;from:string;to:string;query?:string;simId?:string;page?:number;pageSize?:number}):string{
 const search=(query||'').trim();
 const line=(simId||'').trim();
 return `/reports/calls?timeZone=${encodeURIComponent(timeZone)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  +(page&&pageSize?`&page=${page}&pageSize=${pageSize}`:'')
  +(search?`&query=${encodeURIComponent(search)}`:'')
  +(line?`&simId=${encodeURIComponent(line)}`:'');
}

/** 接听方式: the platform that actually answered decides, so a human who grabbed a timeout_ai call reads 真人. */
export function answerModeLabel(item:Pick<ReportItem,'answerMode'|'answeredByPlatform'|'answeredAt'|'internal'|'failureReason'>):string{
 if(!item.answeredAt)return item.internal?'未接通':item.failureReason==='busy_auto_rejected'?'忙线未接':'未接';
 if(item.answeredByPlatform==='device')return '网关本机';
 if(item.answeredByPlatform==='ai')return item.answerMode==='timeout_ai'?'超时 AI':'AI 接听';
 if(item.answeredByPlatform)return '真人';
 if(item.answerMode==='timeout_ai')return '超时 AI';
 if(item.answerMode==='ai')return 'AI 接听';
 return '真人';
}

/** What stands in for the summary when there is no transcript to summarise (S22 客户端合同). */
export function transcriptPlaceholder(state:ReportTranscriptState|null|undefined):string|null{
 switch(state){
  case 'none': return '无转录：录音为空';
  case 'queued':
  case 'running':
  case 'retry': return '转录处理中…';
  case 'failed': return '转录失败，原始录音仍可查看';
  default: return null;
 }
}

/** 姓名 · 号码 on the report card (the 全部通话 row keeps 号码 · 姓名 from S21 §F). */
export function reportDisplayName(item:Pick<ReportItem,'remoteNumber'|'contactName'>&Partial<Pick<ReportItem,'internal'|'direction'|'peerSimLabel'|'sim'>>):string{
 if(item.internal)return `内部通话 ${internalCallRoute(item,item.sim&&simLabel(item.sim))}`;
 const number=(item.remoteNumber||'').trim();
 const name=(item.contactName||'').trim();
 if(!number)return name||'未知号码';
 return name?`${name} · ${number}`:number;
}

/** S82 unified talk duration: "48 秒" / "2 分 05 秒"; null when not answered. */
export function talkDuration(item:{answeredAt?:string|null;endedAt?:string|null}):string|null{
 if(!item.answeredAt||!item.endedAt)return null;
 const raw=Math.round((Date.parse(item.endedAt)-Date.parse(item.answeredAt))/1000);
 if(!Number.isFinite(raw))return null;
 const seconds=Math.max(0,raw);
 return seconds>=60?`${Math.floor(seconds/60)} 分 ${String(seconds%60).padStart(2,'0')} 秒`:`${seconds} 秒`;
}

export function callDurationLabel(item:Pick<ReportItem,'answeredAt'|'endedAt'>):string{
 const duration=talkDuration(item);
 return duration?`通话 ${duration}`:'未接通';
}

/** S95 row tags, only from fields the report already carries. */
export function reportTags(item:Pick<ReportItem,'recordingStatus'|'transcriptState'|'summary'|'hasAiTranscript'>):string[]{
 return [
  item.recordingStatus==='ready'||item.recordingStatus==='complete'?'录音':'',
  item.transcriptState==='succeeded'?'转录':'',
  (item.summary||'').trim()?'摘要':'',
  item.hasAiTranscript?'AI 对话':'',
 ].filter(Boolean);
}

function simLabel(sim:ReportItem['sim']):string{
 const label=(sim?.label||'').trim();
 if(label)return label;
 return typeof sim?.slotIndex==='number'?`SIM ${sim.slotIndex+1}`:'未命名号码';
}

/**
 * 报告 tab (S22 决策 10).
 *
 * Every call in the window gets a card — advertising is marked, never hidden — so the panel's job is to make
 * the classifier's verdict legible (推荐拦截 + 原因) and put 屏蔽 one click away from the record that caused it.
 */
export function CallReports({
 simId,
 timeZone,
 request,
 busy=false,
 mediaLive=false,
 reloadToken=0,
 storageKey,
 onRedial,
 onSms,
 onChanged,
 onOpen,
 seenIds=NO_IDS,
}:{
 simId:string;
 timeZone?:string|null;
 request:ApiRequest;
 busy?:boolean;
 mediaLive?:boolean;
 reloadToken?:number;
 /** sessionStorage key: range, search, page and page size survive switching 记录 views (the page only for the same window and SIM). */
 storageKey?:string;
 onRedial?:(item:ReportItem)=>void;
 onSms?:(item:ReportItem)=>void;
 onChanged?:()=>void;
 /** S67: expanding a report's recording or transcript counts as opening the call. */
 onOpen?:(item:ReportItem)=>void;
 /** S67c: calls this tab already opened; hides their dot before the next reload. */
 seenIds?:ReadonlySet<string>;
}){
 const zone=gatewayDisplayTimeZone(timeZone);
 const [today,setToday]=useState(()=>gatewayCalendarDate(new Date(),zone));
 // 今天/7 天/30 天 are recomputed from today, so a stored window from yesterday never sticks; only 自定义 keeps its dates.
 const [initial]=useState(()=>{
  const saved=readViewState(storageKey),date=/^\d{4}-\d{2}-\d{2}$/;
  const preset=REPORT_PRESETS.find(([value])=>value===saved.preset)?.[0]||'7d';
  const custom=preset==='custom'&&typeof saved.from==='string'&&typeof saved.to==='string'&&date.test(saved.from)&&date.test(saved.to);
  const range=custom?{from:saved.from as string,to:saved.to as string}:reportWindowRange(preset,today)||{from:today,to:today};
  const same=saved.from===range.from&&saved.to===range.to&&saved.simId===simId&&saved.zone===zone;
  return {preset:preset==='custom'&&!custom?'custom':preset,...range,search:storedText(saved.search),page:same?storedPage(saved.page):1,pageSize:normalizePageSize(saved.pageSize)};
 });
 const [preset,setPreset]=useState<ReportPreset>(initial.preset);
 const [from,setFrom]=useState(initial.from);
 const [to,setTo]=useState(initial.to);
 const [query,setQuery]=useState(initial.search),[search,setSearch]=useState(initial.search);
 const [items,setItems]=useState<ReportItem[]|null>(null);
 const [error,setError]=useState(''),[unsupported,setUnsupported]=useState(false),[reloads,setReloads]=useState(0);
 useReportedError('记录','reports',error);
 const [page,setPage]=useState(initial.page),[pageSize,setPageSize]=useState<PageSize>(initial.pageSize);
 const [total,setTotal]=useState<number|undefined>(undefined),[totalPages,setTotalPages]=useState<number|undefined>(undefined);
 const [loading,setLoading]=useState(false);
 useVisibleRefresh(()=>setReloads(value=>value+1),5000,false);
 // Every filter change must land on page 1; this key catches the ones that arrive as props rather than as clicks.
 // It starts at the restored filters, so a restored page survives the first request.
 const filterKey=useRef([from,to,search,simId,pageSize,zone].join('|'));

 // One request per pause in typing, exactly like the 通讯录 search box; the filter key below sends it to page 1.
 useEffect(()=>{const timer=setTimeout(()=>setSearch(query),250);return()=>clearTimeout(timer);},[query]);

 // The SIM list loads after the first render, so the gateway zone — and with it “today” — can still change.
 useEffect(()=>{
  const day=gatewayCalendarDate(new Date(),zone);
  if(!day||day===today)return;
  setToday(day);
  const range=reportWindowRange(preset,day);
  if(!range)return;
  setPage(1);
  setFrom(range.from);
  setTo(range.to);
 },[zone]);

 useEffect(()=>{
  if(!from||!to)return;
  if(from>to){setError('开始日期不能晚于结束日期。');return;}
  // A filter that changed while the user sat on page 4 must re-enter the list at page 1, and only request once.
  const key=[from,to,search,simId,pageSize,zone].join('|');
  if(filterKey.current!==key){
   filterKey.current=key;
   if(page!==1){setPage(1);return;}
  }
  let cancelled=false;
  setLoading(true);
  request<{items:ReportItem[];total?:number;totalPages?:number}>(reportQueryPath({timeZone:zone,from,to,query:search,simId,page,pageSize}))
   .then(result=>{
    if(cancelled)return;
    // Without totalPages this is a pre-S28 Control answering with the whole window: rows yes, pager no.
    const pages=typeof result.totalPages==='number'?Math.max(1,Math.floor(result.totalPages)):undefined;
    setTotalPages(pages);
    setTotal(typeof result.total==='number'?result.total:undefined);
    // A page past the end (restored, or emptied by a 屏蔽) moves to the last page rather than rendering empty.
    if(pages!==undefined&&page>pages){setPage(pages);return;}
    setLoading(false);
    setItems(result.items||[]);
    setUnsupported(false);
    setError('');
   })
   .catch(caught=>{
    if(cancelled)return;
    setLoading(false);
    if(errorStatus(caught)===404)setUnsupported(true);
    else setError(caught instanceof Error?caught.message:'读取报告失败，请稍后重试。');
   });
  return()=>{cancelled=true;};
 },[from,to,search,simId,page,pageSize,zone,reloads,reloadToken,request]);
 useEffect(()=>writeViewState(storageKey,{preset,from,to,search,page,pageSize,simId,zone}),[storageKey,preset,from,to,search,page,pageSize,simId,zone]);

 function choosePreset(value:ReportPreset){
  setPreset(value);
  setPage(1);
  const range=reportWindowRange(value,today);
  if(!range)return;
  setFrom(range.from);
  setTo(range.to);
 }

 /** Resolves once settled, so HistoryCallActions keeps its confirmation up until the request is done. */
 async function blockNumber(item:ReportItem){
  const remote=(item.remoteNumber||'').trim();
  if(!remote)return;
  try{
   const created=await request<{item?:{id?:string}}>('/blocklist',{remoteNumber:remote,sourceCallId:item.callId,scope:'call'});
   // Every card for this number reads 已屏蔽 straight away; the reload then confirms it from the server.
   setItems(current=>(current||[]).map(row=>(row.remoteNumber||'').trim()===remote
    ?{...row,blocked:true,blockedEntryId:created?.item?.id??row.blockedEntryId??null}
    :row));
   setError('');
   onChanged?.();
   setReloads(value=>value+1);
  }catch(caught){
   setError(caught instanceof Error?caught.message:'屏蔽失败，请稍后重试。');
  }
 }

 // `simId` is a request parameter since S28; the same filter stays client-side because a pre-S28 Control ignores it.
 const shown=(items||[]).filter(item=>!simId||item.sim?.id===simId);
 return (
  <section className="panel call-reports">
   <h2>转录报告</h2>
   <div className="report-filters">
    <div className="segmented report-presets" role="group" aria-label="报告时间范围">
     {REPORT_PRESETS.map(([value,label])=>(
      <button
       key={value}
       type="button"
       className={preset===value?'selected':''}
       aria-pressed={preset===value}
       onClick={()=>choosePreset(value)}
      >{label}</button>
     ))}
    </div>
    {preset==='custom'&&(
     <div className="report-dates">
      <label>开始日期<input type="date" value={from} max={to||undefined} onChange={e=>{setPage(1);setFrom(e.target.value);}}/></label>
      <label>结束日期<input type="date" value={to} min={from||undefined} onChange={e=>{setPage(1);setTo(e.target.value);}}/></label>
     </div>
    )}
    <label className="report-search">搜索
     <input
      type="search"
      value={query}
      placeholder="搜索姓名或号码"
      autoComplete="off"
      spellCheck={false}
      onChange={e=>setQuery(e.target.value)}
     />
    </label>
   </div>
   <p className="note">按 {zone} 的自然日统计 {from} 至 {to}。窗口内每通电话都有报告条目，分类结果仅作标注。</p>
   {unsupported&&<p className="note">此服务器尚未启用报告搜索与日期范围。</p>}
   {error&&<p className="error" role="alert">{error}</p>}
   {items===null?<p role="status">正在读取报告…</p>
    :!shown.length?<p className="note">此时间范围内没有通话记录。</p>
    :<div className="report-list">{shown.map(item=>{
     const itemZone=gatewayDisplayTimeZone(item.gatewayTimeZone,zone);
     const remote=(item.remoteNumber||'').trim();
     const placeholder=transcriptPlaceholder(item.transcriptState);
     const summary=(item.summary||'').trim();
     const actionItems=(item.actionItems||[]).filter(action=>(action||'').trim());
     const aiFirst=Boolean(item.hasAiTranscript)&&item.transcriptState!=='succeeded';
     return (
      <article className="report-card" key={item.callId} id={`call-report-${item.callId}`}>
       <div className="report-card-heading">
        {callShowsDot({id:item.callId,unseen:item.unseen},seenIds)&&<span className="unread-dot call-unread-dot"><span className="sr-only">未查看</span></span>}
        <strong dir="ltr">{reportDisplayName(item)}</strong>
        <time dateTime={item.startedAt}>{formatCompactCallDate(item.startedAt,itemZone)}</time>
       </div>
       <p className="report-meta">
        {simLabel(item.sim)} · {item.direction==='outgoing'?'呼出':'呼入'} · {callDurationLabel(item)} · {answerModeLabel(item)}
        {reportTags(item).map(tag=><span key={tag} className={'record-tag'+(tag==='AI 对话'?' tag-ai':'')}>{tag}</span>)}
       </p>
       {/* `false` is a classified, harmless call and wears no pill at all. */}
       {item.blockRecommended!==false&&(
        <p className="report-pills">
         {item.blockRecommended===true
          ?<><span className="pill pill-danger">推荐拦截</span>{(item.blockReason||'').trim()&&<span className="pill pill-neutral">{item.blockReason}</span>}</>
          :<span className="pill pill-muted">未分类</span>}
        </p>
       )}
       <p className={summary?'report-summary':'report-summary muted'}>{summary||placeholder||'此通话暂无摘要，可查看转录。'}</p>
       {actionItems.length>0&&<ul className="report-action-items">{actionItems.map((action,index)=><li key={index}>{action}</li>)}</ul>}
       {/* Same order as a 全部通话 row: 回拨 → 发短信 → 更多(屏蔽) → 查看录音 → 查看转录. */}
       <HistoryCallActions remoteNumber={remote||undefined} simId={item.sim?.id} mediaLive={mediaLive} busy={busy} blocked={Boolean(item.blocked)} onRedial={()=>onRedial?.(item)} onSms={()=>onSms?.(item)} onBlock={()=>blockNumber(item)}/>
       <div className="record-media-actions" role="group" aria-label="录音与转录" onClickCapture={()=>onOpen?.(item)}>
        <CallRecording callId={item.callId} timeZone={itemZone} request={request} preferPixelSource={preferPixelSource(item)} ownerJoinedLocal={item.ownerJoinedLocal} gatewayKind={item.gatewayKind}/>
        {aiFirst?<AiTranscriptToggle callId={item.callId} request={request}/>:<CallTranscript callId={item.callId} request={request}/>}
       </div>
      </article>
     );
    })}</div>}
   <Pager
    page={page}
    pageSize={pageSize}
    total={total}
    totalPages={totalPages}
    busy={busy||(loading&&items===null)}
    onPageChange={next=>setPage(clampPage(next,totalPages??1))}
    onPageSizeChange={next=>{setPageSize(next);setPage(1);}}
   />
  </section>
 );
}

/** “查看转录” points at the AI 对话 when that is the only text this call produced (S22 客户端合同); call rows reuse it, fetching only on click. */
export function AiTranscriptToggle({callId,request,labels=['查看转录','收起转录'],initialOpen=false}:{callId:string;request:ApiRequest;labels?:[string,string];initialOpen?:boolean}){
 const [opened,setOpened]=useState(initialOpen);
 const [missingNotice,setMissingNotice]=useState('');
 return (
  <div className="report-transcript">
   <button type="button" className="passkey" aria-expanded={opened} onClick={()=>{setMissingNotice('');setOpened(value=>!value);}}>
    {opened?labels[1]:labels[0]}
   </button>
   {missingNotice&&<p className="note" role="status">{missingNotice}</p>}
   {opened&&<CallDetailGuard callId={callId} request={request} onMissing={message=>{setOpened(false);setMissingNotice(message);}}/>}
   {opened&&<AiTranscript callId={callId} request={request}/>}
  </div>
 );
}
