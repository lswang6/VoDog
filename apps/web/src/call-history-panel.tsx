import React, {useEffect,useRef,useState} from 'react';
import {useReportedError} from './ui-error';
import {UiIcon} from './icons';
import {CallRecording} from './recording';
import {AiTranscriptToggle,CallTranscript,talkDuration} from './reports';
import {HistoryCallActions} from './history-call-actions';
import {formatCompactCallDate,gatewayDisplayTimeZone} from './gateway-time';
import {mayEndCall} from './media-policy';
import {gatewayKindLabel,gatewayShortLabel} from './gateway-kind';
import {AI_ANSWERING_LABEL,aiSuppressed,internalCallRoute,offersAnswerControls,type CallOccupancy} from './call-occupancy';
import {isBlockedRow,numberWithContact,type ApiRequest} from './contacts';
import {interceptionSourceLabel} from './interceptions';
import {Pager,clampPage,normalizePageSize,readViewState,storedPage,storedText,writeViewState,type PageSize} from './pager';
import {useVisibleRefresh} from './visible-refresh';
import {callShowsDot} from './badges';

export type Sim={id:string;label?:string;phoneLabel?:string;slotIndex?:number|null;gatewayId:string;gatewayKind?:string|null;present?:boolean;online?:boolean;telephonyReady?:boolean;mediaReady?:boolean;smsReady?:boolean;version?:number;timeZone?:string|null;settings:{mode:string;version:number;timeoutSeconds:number;appliedVersion:number|null;availableModes?:string[];aiUnavailableReason?:string|null}};
/**
 * `contactId`/`contactName`/`blocked`/`blockedEntryId` are S21 §A additions an older Control omits entirely,
 * and `answerMode`/`aiHandling`/`aiTriggerAt` are the S22 决策 4 additions: without them nothing is suppressed.
 */
export type Call={id:string;simId:string;direction:string;remoteNumber?:string;number?:string;state:string;startedAt:string;answeredByPlatform?:string;originatingPlatform?:string;answeredByDevice?:string;answeredAt?:string;endedAt?:string;claimedByCurrentSession?:boolean;gatewayTimeZone?:string|null;gatewayKind?:string|null;occupancy?:CallOccupancy;contactId?:string|null;contactName?:string|null;blocked?:boolean;blockedEntryId?:string|null;answerMode?:string;aiHandling?:boolean;aiTriggerAt?:string|null;failureReason?:string|null;conflictDisposition?:string|null;blockedSource?:string|null;/** S67c: missing = false. */unseen?:boolean;/** S72：内部通话（同一 owner 的托管卡互打）；peerSim* 是另一条腿的己方卡。 */internal?:boolean;peerSimId?:string|null;peerSimLabel?:string|null;/** S81：被叫 SIM 显示名（名称优先，否则号码），仅非空时下发。 */simLabel?:string};
export const AI_TRANSCRIPT_LABELS:[string,string]=['AI 对话','收起 AI 对话'];
export const labels:Record<string,string>={incoming_ringing:'来电振铃',outgoing_pending:'等待网关确认',connecting:'正在接通',active:'通话中',ending:'正在结束',ended:'已结束',failed:'失败',unknown:'状态待核实',queued:'等待发送',sending:'发送中',sent:'已发送',delivered:'已送达'};

/** S38：手机拨号盘发起的通话没有客户端设备可显示，行主体固定写「通过手机拨打」。 */
export function callRowOwner(c:Call,sessionUsername?:string):string|undefined{
 if(c.originatingPlatform==='pixel')return gatewayKindLabel(c.gatewayKind).deviceDial;
 return c.claimedByCurrentSession&&sessionUsername?`${sessionUsername} · 当前浏览器`:c.answeredByDevice||platformLabel(c.answeredByPlatform)||(c.direction==='outgoing'?platformLabel(c.originatingPlatform):undefined);
}
const PLATFORM_LABELS:Record<string,string>={ios:'iPhone 端',android:'Android 端',macos:'Mac 端',web:'网页端',ai:'AI 接听',device:'网关本机'};
/** Raw platform ids (`macos`…) never reach the row; unknown ones stay as sent. */
function platformLabel(p?:string|null){return p?PLATFORM_LABELS[p]??p:undefined;}
/** S38：忙线冲突的两种结局；自动拒接的记录同时带 `conflictDisposition='rejected'`，所以先看 failureReason。 */
export function busyConflictLabel(c:Pick<Call,'failureReason'|'conflictDisposition'>):string|null{
 if(c.failureReason==='busy_auto_rejected')return '忙线未接';
 if(c.conflictDisposition==='ai_answered')return '忙线 AI 代接';
 return null;
}

/** 没人接起的来电（结束或失败）；被拦截的来电另有标记，内部通话不算未接（S72 B6）。 */
export function missedIncomingCall(c:Pick<Call,'direction'|'answeredAt'|'state'|'failureReason'|'internal'>):boolean{
 return c.direction==='incoming'&&!c.internal&&!c.answeredAt&&(c.state==='ended'||c.state==='failed')&&c.failureReason!=='number_blocked';
}

/** S72 E：内部通话行标题；振铃中的内部来电写「来自 {主叫卡}（内部）」。 */
export function internalCallTitle(c:Pick<Call,'internal'|'direction'|'state'|'peerSimLabel'>,ownLabel?:string|null):string|null{
 if(!c.internal)return null;
 if(c.direction==='incoming'&&c.state==='incoming_ringing')return `来自 ${(c.peerSimLabel||'').trim()||'另一张卡'}（内部）`;
 return `内部通话 ${internalCallRoute(c,ownLabel)}`;
}

/** S38b：被拦截的来电（failureReason='number_blocked'）在行里说明是哪一侧拦的；旧记录没有 blockedSource。 */
export function interceptedCallLabel(c:Pick<Call,'failureReason'|'blockedSource'>):string|null{
 return c.failureReason==='number_blocked'?interceptionSourceLabel(c.blockedSource)||'已拦截':null;
}

/** Only an AI-answered call can have an AI 对话; the old Control that predates both fields never ran the AI at all. */
export function aiAnsweredCall(c:Pick<Call,'answeredByPlatform'|'conflictDisposition'>):boolean{
 return c.answeredByPlatform==='ai'||c.conflictDisposition==='ai_answered';
}

export function Empty({text,detail}:{text:string;detail:string}){return <div className="empty"><span aria-hidden="true">◌</span><h3>{text}</h3><p>{detail}</p></div>}

/**
 * `GET /calls?page=&pageSize=[&query=][&simId=]` (S28 分页合同).
 *
 * A pre-S28 Control ignores all four and answers with its own unfiltered page, so the caller must be ready for a
 * bare `{items}` — that is exactly what hides the pager instead of showing a wrong "第 1 / 1 页".
 */
export function callHistoryQueryPath({page,pageSize,query,simId}:{page:number;pageSize:number;query?:string;simId?:string}):string{
 const search=(query||'').trim();
 const line=(simId||'').trim();
 return `/calls?page=${page}&pageSize=${pageSize}&includeBlocked=true`
  +(search?`&query=${encodeURIComponent(search)}`:'')
  +(line?`&simId=${encodeURIComponent(line)}`:'');
}

/**
 * 通话记录 view inside the 记录 tab (S28 分页).
 *
 * This list is a *server page*, deliberately separate from the dashboard's polled `calls` array: 通话 页的近期通话
 * still reads that array 1–2 s at a time, while this panel only reloads when the page, the filters or `reloadToken`
 * move. S64: the 记录 SIM strip scopes it (`simId`, '' = 全部 SIM); every row still names its line. Everything a row can show — 联系人卡片, 回拨/短信/屏蔽, 录音, 转录, AI 对话 — is unchanged.
 */
export function CallHistoryPanel({
 request,
 simId,
 sims,
 sessionUsername,
 mediaCallId=null,
 busy=false,
 reloadToken=0,
 storageKey,
 onHistoryAction,
 onOpenCard,
 seenIds,
}:{
 request:ApiRequest;
 /** 记录 SIM scope; '' = every SIM. */
 simId:string;
 sims:Sim[];
 sessionUsername?:string;
 mediaCallId?:string|null;
 busy?:boolean;
 reloadToken?:number;
 /** sessionStorage key: search, page and page size survive switching 记录 views (the page only for the same SIM). */
 storageKey?:string;
 onHistoryAction?:(call:Call,action:'redial'|'sms'|'block'|'delete')=>void|Promise<void>;
 onOpenCard?:(call:Call)=>void;
 /** S67c: calls opened in this tab lose their dot before the next read. */
 seenIds?:ReadonlySet<string>;
}){
 const [saved]=useState(()=>readViewState(storageKey));
 const [query,setQuery]=useState(()=>storedText(saved.search)),[search,setSearch]=useState(()=>storedText(saved.search).trim());
 const [items,setItems]=useState<Call[]|null>(null),[error,setError]=useState('');
 useReportedError('记录','call-history',error);
 const [page,setPage]=useState(()=>saved.simId===simId?storedPage(saved.page):1),[pageSize,setPageSize]=useState<PageSize>(()=>normalizePageSize(saved.pageSize));
 const [total,setTotal]=useState<number|undefined>(undefined),[totalPages,setTotalPages]=useState<number|undefined>(undefined);
 const [loading,setLoading]=useState(false);
 const [refreshTick,setRefreshTick]=useState(0);
 // Filters that arrive as props (simId) change outside any handler; this key sends them back to page 1 exactly once.
 // Seeded with the restored filters, so a restored page is not mistaken for a filter change on mount.
 const filterKey=useRef([search,simId,pageSize].join('|'));

 /** One server request per pause in typing, exactly like the 通讯录 search box; the filter key sends it to page 1. */
 useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),250);return()=>clearTimeout(timer);},[query]);

 useEffect(()=>{
  const key=[search,simId,pageSize].join('|');
  if(filterKey.current!==key){
   filterKey.current=key;
   if(page!==1){setPage(1);return;}
  }
  let cancelled=false;
  setLoading(true);
  request<{items:Call[];total?:number;totalPages?:number}>(callHistoryQueryPath({page,pageSize,query:search,simId}))
   .then(result=>{
    if(cancelled)return;
    const pages=typeof result.totalPages==='number'?Math.max(1,Math.floor(result.totalPages)):undefined;
    setTotalPages(pages);
    setTotal(typeof result.total==='number'?result.total:undefined);
    // A 屏蔽 or a restored page can sit past the end: go to the last page instead of showing an empty one.
    if(pages!==undefined&&page>pages){setPage(pages);return;}
    setLoading(false);
    setItems(result.items||[]);
    setError('');
   })
   .catch(caught=>{
    if(cancelled)return;
    setLoading(false);
    setError(caught instanceof Error?caught.message:'读取通话记录失败，请稍后重试。');
   });
  return()=>{cancelled=true;};
 },[page,pageSize,search,simId,reloadToken,refreshTick,request]);
 useVisibleRefresh(()=>setRefreshTick(value=>value+1),5000,false);
 useEffect(()=>writeViewState(storageKey,{search,page,pageSize,simId}),[storageKey,search,page,pageSize,simId]);

 // A pre-S28 Control ignores `simId`, so the same filter stays client-side for the transition.
 const shown=(items||[]).filter(call=>!simId||call.simId===simId);
 return (
  <section className="panel call-history">
   <h2>通话记录</h2>
   <label className="call-search">搜索
    <input type="search" value={query} placeholder="搜索姓名或号码" autoComplete="off" spellCheck={false} onChange={e=>setQuery(e.target.value)}/>
   </label>
   {error&&<p className="error" role="alert">{error}</p>}
   {items===null
    ?<p role="status">{search?'正在搜索通话…':'正在读取通话记录…'}</p>
    :<CallList calls={shown} sims={sims} sessionUsername={sessionUsername} mediaCallId={mediaCallId} busy={busy} showRecordings onHistoryAction={onHistoryAction} onOpenCard={onOpenCard} request={request} seenIds={seenIds}/>}
   <p className="note">{search?'搜索结果来自服务器，按姓名或号码匹配所选范围的通话。':'展开录音可一起听双方声音，也可分别播放原声。点击记录可打开联系人卡片。'}</p>
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

const NO_IDS:ReadonlySet<string>=new Set();

export function CallList({calls,sims=[],sessionUsername,primaryControlledCallId=null,mediaCallId=null,busy=false,onAction,showRecordings=false,onHistoryAction,onOpenCard,request,seenIds=NO_IDS}:{calls:Call[];seenIds?:ReadonlySet<string>;sims?:Sim[];sessionUsername?:string;primaryControlledCallId?:string|null;mediaCallId?:string|null;showRecordings?:boolean;busy?:boolean;onAction?:(id:string,action:'claim'|'end')=>Promise<void>;onHistoryAction?:(call:Call,action:'redial'|'sms'|'block'|'delete')=>void|Promise<void>;onOpenCard?:(call:Call)=>void;request?:<T>(path:string,body?:unknown,method?:string)=>Promise<T>}){
 if(!calls.length)return <Empty text="还没有通话记录" detail="接听或拨打后，可在这里查看通话详情。"/>;
 return <div>{calls.map(c=>{
  const sim=sims.find(s=>s.id===c.simId);
  const zone=gatewayDisplayTimeZone(c.gatewayTimeZone,sim?.timeZone);
  // While the AI answers, this row is a status, not a choice: no ringtone, no 接听, no 拒接 (S22 决策 4).
  const suppressed=aiSuppressed(c);
  const mayEnd=!suppressed&&c.id!==primaryControlledCallId&&mayEndCall(c,mediaCallId);
  const owner=callRowOwner(c,sessionUsername),busyLabel=busyConflictLabel(c),blockedLabel=interceptedCallLabel(c);
  const remote=c.remoteNumber||c.number||'';
  const simName=c.simLabel||sim?.label||sim?.phoneLabel;
  const internalTitle=internalCallTitle(c,simName);
  const openCard=()=>onOpenCard?.(c);
  const dot=callShowsDot(c,seenIds);
  return <article className="record call-record" key={c.id} id={`call-record-${c.id}`} role={onOpenCard?'group':undefined} aria-label={onOpenCard?`${dot?'未查看，':''}通话记录 ${internalTitle??numberWithContact(remote,c.contactName)}，按回车打开联系人卡片`:undefined} tabIndex={onOpenCard?0:undefined} onKeyDown={onOpenCard?event=>{
   if(event.target!==event.currentTarget||!['Enter',' '].includes(event.key))return;
   event.preventDefault();openCard();
  }:undefined} onClick={onOpenCard?event=>{
   // The row itself opens the card, but never when the click landed on a control or on the media sections.
   if(event.target instanceof Element&&event.target.closest('button,a,input,audio,details,summary,label,.call-recording,.report-transcript,.transcript-detail,.ai-transcript,.record-media-actions,.record-actions,.confirm-action'))return;
   openCard();
  }:undefined}><div className="call-record-heading"><div className="call-record-number">{dot&&<span className="unread-dot call-unread-dot"><span className="sr-only">未查看</span></span>}<strong dir="ltr">{(isBlockedRow(c)||blockedLabel)&&<span className="blocked-mark" role="img" aria-label={blockedLabel&&!isBlockedRow(c)?'已拦截':'已屏蔽'}><UiIcon name="blocked"/></span>}{internalTitle??numberWithContact(remote,c.contactName)}</strong>{missedIncomingCall(c)?<small className="missed">呼入 · {c.failureReason==='busy_auto_rejected'?'忙线未接':'未接来电'}</small>:<small>{c.direction==='outgoing'?'呼出':'呼入'} · {labels[c.state]||c.state}</small>}</div><div className="call-record-meta"><time dateTime={c.startedAt}>{formatCompactCallDate(c.startedAt,zone)}</time>{onOpenCard&&<button type="button" className="record-info" aria-label={`联系人信息 ${remote||'未知号码'}`} disabled={busy} onClick={openCard}><UiIcon name="info"/></button>}</div></div>{(sim||simName)&&<small className="call-record-sim">{simName||'未命名号码'}{sim&&` · ${gatewayShortLabel(sim.gatewayId,sim.gatewayKind??c.gatewayKind)}`}</small>}{owner&&<p className="call-owner">{c.direction==='outgoing'?'发起':'接听'}：{owner}</p>}{busyLabel&&(c.failureReason!=='busy_auto_rejected'||!missedIncomingCall(c))&&<p className="call-owner">{busyLabel}</p>}{blockedLabel&&<p className="call-owner">{blockedLabel}</p>}{talkDuration(c)&&<small className="call-duration">通话时长 {talkDuration(c)}</small>}{suppressed&&<p className="call-ai-status" role="status">{AI_ANSWERING_LABEL}</p>}{onAction&&(offersAnswerControls(c)||mayEnd)&&<div className="record-actions">{offersAnswerControls(c)&&<button className="primary" disabled={busy||Boolean(mediaCallId&&mediaCallId!==c.id)} onClick={()=>void onAction(c.id,'claim')}>接听</button>}{mayEnd&&<button className="passkey hangup" disabled={busy} onClick={()=>void onAction(c.id,'end')}>{c.state==='incoming_ringing'?'拒接':'结束通话'}</button>}</div>}{showRecordings&&<><HistoryCallActions remoteNumber={c.remoteNumber||c.number} simId={c.simId} mediaLive={Boolean(mediaCallId)} busy={busy} onRedial={()=>void onHistoryAction?.(c,'redial')} onSms={()=>void onHistoryAction?.(c,'sms')} onBlock={()=>onHistoryAction?.(c,'block')} onDelete={onHistoryAction?()=>onHistoryAction(c,'delete'):undefined}/><div className="record-media-actions" role="group" aria-label="录音与转录"><CallRecording callId={c.id} timeZone={zone} request={request} preferPixelSource={c.originatingPlatform==='pixel'} gatewayKind={c.gatewayKind??sim?.gatewayKind}/><CallTranscript callId={c.id} request={request}/>{request&&aiAnsweredCall(c)&&<AiTranscriptToggle callId={c.id} request={request} labels={AI_TRANSCRIPT_LABELS}/>}</div></>}</article>;
 })}</div>;
}
