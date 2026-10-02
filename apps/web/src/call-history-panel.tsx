import React, {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import './records.css';
import {useReportedError} from './ui-error';
import {UiIcon} from './icons';
import {CallRecording} from './recording';
import {preferPixelSource} from './recording-contract';
import {AiTranscriptToggle,CallTranscript,talkDuration} from './reports';
import {HistoryCallActions} from './history-call-actions';
import {formatCompactCallDate,gatewayCalendarDate,gatewayDisplayTimeZone,shiftCalendarDate} from './gateway-time';
import {SimChip} from './sim-chip';
import {simPaletteColor} from './sim-palette';
import {mayEndCall} from './media-policy';
import {gatewayKindLabel,gatewayShortLabel} from './gateway-kind';
import {AI_ANSWERING_LABEL,aiSuppressed,internalCallRoute,offersAnswerControls,type CallOccupancy} from './call-occupancy';
import {isBlockedRow,numberWithContact,type ApiRequest} from './contacts';
import {interceptionSourceLabel} from './interceptions';
import {Pager,clampPage,normalizePageSize,readViewState,storedPage,storedText,writeViewState,type PageSize} from './pager';
import {useVisibleRefresh} from './visible-refresh';
import {callShowsDot} from './badges';

export type Sim={id:string;label?:string;phoneLabel?:string;slotIndex?:number|null;gatewayId:string;gatewayKind?:string|null;/** S91：gateways.name，旧 Control 缺省。 */gatewayName?:string|null;present?:boolean;online?:boolean;telephonyReady?:boolean;mediaReady?:boolean;smsReady?:boolean;version?:number;timeZone?:string|null;settings:{mode:string;version:number;timeoutSeconds:number;appliedVersion:number|null;availableModes?:string[];aiUnavailableReason?:string|null}};
/**
 * `contactId`/`contactName`/`blocked`/`blockedEntryId` are S21 §A additions an older Control omits entirely,
 * and `answerMode`/`aiHandling`/`aiTriggerAt` are the S22 决策 4 additions: without them nothing is suppressed.
 */
export type Call={id:string;simId:string;direction:string;remoteNumber?:string;number?:string;state:string;startedAt:string;answeredByPlatform?:string;originatingPlatform?:string;/** S94b: missing = false. */ownerJoinedLocal?:boolean;answeredByDevice?:string;answeredAt?:string;endedAt?:string;claimedByCurrentSession?:boolean;gatewayTimeZone?:string|null;gatewayKind?:string|null;occupancy?:CallOccupancy;contactId?:string|null;contactName?:string|null;blocked?:boolean;blockedEntryId?:string|null;answerMode?:string;aiHandling?:boolean;aiTriggerAt?:string|null;failureReason?:string|null;conflictDisposition?:string|null;blockedSource?:string|null;/** S67c: missing = false. */unseen?:boolean;/** S72：内部通话（同一 owner 的托管卡互打）；peerSim* 是另一条腿的己方卡。 */internal?:boolean;peerSimId?:string|null;peerSimLabel?:string|null;/** S81：被叫 SIM 显示名（名称优先，否则号码），仅非空时下发。 */simLabel?:string};
export const AI_TRANSCRIPT_LABELS:[string,string]=['AI 对话','收起 AI 对话'];
export const labels:Record<string,string>={incoming_ringing:'来电振铃',outgoing_pending:'等待网关确认',connecting:'正在接通',active:'通话中',ending:'正在结束',ended:'已结束',failed:'失败',unknown:'状态待核实',queued:'等待发送',sending:'发送中',sent:'已发送',delivered:'已送达'};

/** S38：手机拨号盘发起的通话没有客户端设备可显示，行主体固定写「通过手机拨打」。 */
export function callRowOwner(c:Call,sessionUsername?:string):string|undefined{
 if(c.originatingPlatform==='pixel')return gatewayKindLabel(c.gatewayKind).deviceDial;
 return c.claimedByCurrentSession&&sessionUsername?`${sessionUsername} · 当前浏览器`:c.answeredByDevice||platformLabel(c.answeredByPlatform)||(c.direction==='outgoing'?platformLabel(c.originatingPlatform):undefined);
}
const PLATFORM_LABELS:Record<string,string>={ios:'iPhone 端',android:'Android 端',macos:'Mac 端',web:'网页端',ai:'AI 接听',device:'网关本机'};
/** Raw platform ids (`macos`…) never reach the row; an unknown one shows nothing (S95b §C). */
function platformLabel(p?:string|null){return p?PLATFORM_LABELS[p]:undefined;}
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

export type CallKind='blocked'|'ai'|'missed'|'outgoing'|'incoming';
/** S95 row icon: 已拦截 shield (the call itself was intercepted; a number blocked later keeps its direction icon), AI 代接 ✦, 未接 red ↙, 呼出 ↗, 呼入 ↙ — derived only from existing fields. */
export function callDirectionKind(c:Call):CallKind{
 if(interceptedCallLabel(c))return 'blocked';
 if(aiAnsweredCall(c))return 'ai';
 if(missedIncomingCall(c))return 'missed';
 return c.direction==='outgoing'?'outgoing':'incoming';
}
const DIR_GLYPH:Record<Exclude<CallKind,'blocked'>,string>={ai:'✦',missed:'↙',outgoing:'↗',incoming:'↙'};

/** S95 记录 list headers: 今天 / 昨天 / 本周 (Monday-start, gateway wall clock) / otherwise the calendar day. */
export function callDateGroup(startedAt:string,zone:string,now:Date=new Date()):string{
 const day=gatewayCalendarDate(startedAt,zone),today=gatewayCalendarDate(now,zone);
 if(!day||!today)return '';
 if(day===today)return '今天';
 if(day===shiftCalendarDate(today,-1))return '昨天';
 const weekday=(new Date(`${today}T00:00:00Z`).getUTCDay()+6)%7;
 if(day<today&&day>=shiftCalendarDate(today,-weekday))return '本周';
 const [y,m,d]=day.split('-').map(Number);
 return `${y===Number(today.slice(0,4))?'':`${y}年`}${m}月${d}日`;
}
/** Under a date header the row only needs the clock; 本周 also names the weekday. */
function groupedTime(startedAt:string,zone:string,group:string):string{
 const full=formatCompactCallDate(startedAt,zone),clock=full.slice(11);
 if(!clock)return full;
 return group==='本周'?`周${'日一二三四五六'[new Date(`${full.slice(0,10)}T00:00:00Z`).getUTCDay()]} ${clock}`:clock;
}

/** 电话 page recent list: 今天 14:32 / 昨天 20:16 / 周二 10:21 / 9/13. */
export function relativeCallTime(startedAt:string,zone:string,now:Date=new Date()):string{
 const group=callDateGroup(startedAt,zone,now),full=formatCompactCallDate(startedAt,zone),clock=full.slice(11);
 if(!clock)return full;
 if(group==='今天'||group==='昨天')return `${group} ${clock}`;
 if(group==='本周')return groupedTime(startedAt,zone,group);
 return `${Number(full.slice(5,7))}/${Number(full.slice(8,10))}`;
}

const WIDE_RECORDS='(min-width: 1001px)';
function subscribeWide(notify:()=>void){const query=globalThis.matchMedia?.(WIDE_RECORDS);query?.addEventListener?.('change',notify);return()=>query?.removeEventListener?.('change',notify);}
/** >1000px: list + detail pane. Without matchMedia (tests, old browsers) the single-column rows stay as before. */
export function useWideRecords():boolean{
 return useSyncExternalStore(subscribeWide,()=>Boolean(globalThis.matchMedia?.(WIDE_RECORDS).matches),()=>false);
}

/** Secondary facts of a row (who answered, busy conflict, interception source). */
function callFacts(c:Call,sessionUsername?:string):string[]{
 const owner=callRowOwner(c,sessionUsername),busyLabel=busyConflictLabel(c);
 return [
  owner&&`${c.direction==='outgoing'?'发起':'接听'}：${owner}`,
  busyLabel&&(c.failureReason!=='busy_auto_rejected'||!missedIncomingCall(c))?busyLabel:'',
  // An intercepted call names its source in the direction line instead.
 ].filter((value):value is string=>Boolean(value));
}
function directionSmall(c:Call){
 const blockedLabel=interceptedCallLabel(c);
 if(blockedLabel)return <small>{c.direction==='outgoing'?'呼出':'呼入'} · {blockedLabel}</small>;
 return missedIncomingCall(c)?<small className="missed">呼入 · {c.failureReason==='busy_auto_rejected'?'忙线未接':'未接来电'}</small>:<small>{c.direction==='outgoing'?'呼出':'呼入'} · {labels[c.state]||labels.unknown}</small>;
}
function CallSimChip({c,sim,sims,simName,quiet=false}:{c:Call;sim?:Sim;sims:Sim[];simName?:string;/** Gateway name for screen readers only (compact rows). */quiet?:boolean}){
 return <small className="call-record-sim"><SimChip name={simName||'未命名号码'} color={sim?simPaletteColor(sim,sims):'var(--ink-3)'} ai={sim?.settings}/>{sim&&<span className={quiet?'call-record-gateway sr-only':'call-record-gateway'}>{` · ${gatewayShortLabel(sim.gatewayId,sim.gatewayKind??c.gatewayKind,sim.gatewayName)}`}</span>}</small>;
}
function callTitle(c:Call,simName?:string){
 const remote=c.remoteNumber||c.number||'';
 const name=(c.contactName||'').trim();
 const internal=internalCallTitle(c,simName);
 return {remote,title:internal??(name||remote||'未知号码'),showNumber:!internal&&Boolean(name&&remote)};
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
 onOpenCall,
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
 /** Wide layout: a row was selected into the detail pane (the shell may count it as opened, S67). */
 onOpenCall?:(call:Call)=>void;
 /** S67c: calls opened in this tab lose their dot before the next read. */
 seenIds?:ReadonlySet<string>;
}){
 const wide=useWideRecords();
 const [selectedId,setSelectedId]=useState<string|null>(null);
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
 const selected=wide?shown.find(call=>call.id===selectedId):undefined;
 const selectedSim=selected&&sims.find(s=>s.id===selected.simId);
 return (
  <section className={'panel call-history'+(wide?' records-split':'')}>
   <div className="records-list-pane">
    <h2 className="records-title">通话记录</h2>
    <label className="call-search">搜索
     <input type="search" value={query} placeholder="搜索姓名或号码" autoComplete="off" spellCheck={false} onChange={e=>setQuery(e.target.value)}/>
    </label>
    {error&&<p className="error" role="alert">{error}</p>}
    {items===null
     ?<p role="status">{search?'正在搜索通话…':'正在读取通话记录…'}</p>
     :<CallList calls={shown} sims={sims} sessionUsername={sessionUsername} mediaCallId={mediaCallId} busy={busy} showRecordings grouped onHistoryAction={onHistoryAction} onOpenCard={onOpenCard} request={request} seenIds={seenIds}
       selectedId={wide?selectedId:null} onSelect={wide?call=>{setSelectedId(call.id);onOpenCall?.(call);}:undefined}/>}
    <Pager
     page={page}
     pageSize={pageSize}
     total={total}
     totalPages={totalPages}
     busy={busy||(loading&&items===null)}
     onPageChange={next=>setPage(clampPage(next,totalPages??1))}
     onPageSizeChange={next=>{setPageSize(next);setPage(1);}}
    />
    <p className="note">{search?'搜索结果来自服务器，按姓名或号码匹配所选范围的通话。':wide?'选择一条通话，可在右侧收听录音、查看转录。':'展开录音可一起听双方声音，也可分别播放原声。点击记录可打开联系人卡片。'}</p>
   </div>
   {wide&&<div className="records-detail-pane">
    {selected
     ?<CallDetail key={selected.id} call={selected} sim={selectedSim} sims={sims} sessionUsername={sessionUsername} mediaCallId={mediaCallId} busy={busy} request={request} onHistoryAction={onHistoryAction} onOpenCard={onOpenCard}/>
     :<Empty text="选择一条通话" detail="在左侧选择通话，可查看详情、录音与转录。"/>}
   </div>}
  </section>
 );
}

/** Wide 记录 detail pane: the same actions and media a single-column row carries, laid out as one card. */
function CallDetail({call:c,sim,sims,sessionUsername,mediaCallId=null,busy,request,onHistoryAction,onOpenCard}:{call:Call;sim?:Sim;sims:Sim[];sessionUsername?:string;mediaCallId?:string|null;busy:boolean;request:ApiRequest;onHistoryAction?:(call:Call,action:'redial'|'sms'|'block'|'delete')=>void|Promise<void>;onOpenCard?:(call:Call)=>void}){
 const zone=gatewayDisplayTimeZone(c.gatewayTimeZone,sim?.timeZone);
 const simName=c.simLabel||sim?.label||sim?.phoneLabel;
 const {remote,title,showNumber}=callTitle(c,simName);
 const kind=callDirectionKind(c),duration=talkDuration(c),ai=aiAnsweredCall(c);
 const name=(c.contactName||'').trim();
 return <article className="call-detail" aria-label={`通话详情 ${numberWithContact(remote,c.contactName)}`}>
  <header className="call-detail-head">
   <span className={`call-avatar call-dir-${kind}`} aria-hidden="true">{name?Array.from(name)[0]:kind==='blocked'?<UiIcon name="blocked"/>:DIR_GLYPH[kind]}</span>
   <div className="call-detail-title">
    <h3 dir="auto">{title}</h3>
    <p className="call-detail-meta">{showNumber&&<span className="num" dir="ltr">{remote}</span>}{(sim||simName)&&<CallSimChip c={c} sim={sim} sims={sims} simName={simName}/>}{directionSmall(c)}<time className="num" dateTime={c.startedAt}>{formatCompactCallDate(c.startedAt,zone)}</time>{duration&&<span className="num">{duration}</span>}</p>
   </div>
  </header>
  {callFacts(c,sessionUsername).map(fact=><p className="call-owner" key={fact}>{fact}</p>)}
  {aiSuppressed(c)&&<p className="call-ai-status" role="status">{AI_ANSWERING_LABEL}</p>}
  <HistoryCallActions variant="detail" remoteNumber={remote||undefined} simId={c.simId} mediaLive={Boolean(mediaCallId)} busy={busy} onRedial={()=>void onHistoryAction?.(c,'redial')} onSms={()=>void onHistoryAction?.(c,'sms')} onBlock={()=>onHistoryAction?.(c,'block')} onDelete={onHistoryAction?()=>onHistoryAction(c,'delete'):undefined} onContact={onOpenCard?()=>onOpenCard(c):undefined} contactLabel={c.contactId?'联系人信息':'存为联系人'}/>
  <section className="record-card call-detail-recording" aria-label="通话录音">
   <h4>通话录音</h4>
   <CallRecording callId={c.id} timeZone={zone} request={request} preferPixelSource={preferPixelSource(c)} ownerJoinedLocal={c.ownerJoinedLocal} gatewayKind={c.gatewayKind??sim?.gatewayKind} initialOpen/>
  </section>
  <section className="call-detail-transcript" aria-label="转录">
   <h4>转录{ai&&<span className="record-tag tag-ai">AI 代接</span>}</h4>
   <CallTranscript callId={c.id} request={request} initialOpen/>
   {ai&&<AiTranscriptToggle callId={c.id} request={request} labels={AI_TRANSCRIPT_LABELS} initialOpen/>}
  </section>
 </article>;
}

const NO_IDS:ReadonlySet<string>=new Set();

export function CallList({calls,sims=[],sessionUsername,primaryControlledCallId=null,mediaCallId=null,busy=false,onAction,showRecordings=false,onHistoryAction,onOpenCard,request,seenIds=NO_IDS,grouped=false,selectedId=null,onSelect}:{calls:Call[];seenIds?:ReadonlySet<string>;sims?:Sim[];sessionUsername?:string;primaryControlledCallId?:string|null;mediaCallId?:string|null;showRecordings?:boolean;busy?:boolean;onAction?:(id:string,action:'claim'|'end')=>Promise<void>;onHistoryAction?:(call:Call,action:'redial'|'sms'|'block'|'delete')=>void|Promise<void>;onOpenCard?:(call:Call)=>void;request?:<T>(path:string,body?:unknown,method?:string)=>Promise<T>;
 /** 记录: insert 今天 / 昨天 / 本周 / date headers and show only the clock per row. */
 grouped?:boolean;
 /** Wide 记录 layout: the row selects into the detail pane instead of expanding in place. */
 selectedId?:string|null;onSelect?:(call:Call)=>void}){
 if(!calls.length)return <Empty text="还没有通话记录" detail="接听或拨打后，可在这里查看通话详情。"/>;
 const now=new Date();
 let lastGroup='';
 return <div className={'call-list'+(onSelect?' call-list-select':'')+(showRecordings?'':' call-list-compact')}>{calls.map(c=>{
  const sim=sims.find(s=>s.id===c.simId);
  const zone=gatewayDisplayTimeZone(c.gatewayTimeZone,sim?.timeZone);
  const group=grouped?callDateGroup(c.startedAt,zone,now):'';
  const header=group&&group!==lastGroup?<h3 className="call-group-label" key={`group-${c.id}`}>{group}</h3>:null;
  lastGroup=group||lastGroup;
  // While the AI answers, this row is a status, not a choice: no ringtone, no 接听, no 拒接 (S22 决策 4).
  const suppressed=aiSuppressed(c);
  const mayEnd=!suppressed&&c.id!==primaryControlledCallId&&mayEndCall(c,mediaCallId);
  const blockedLabel=interceptedCallLabel(c);
  const simName=c.simLabel||sim?.label||sim?.phoneLabel;
  const {remote,title,showNumber}=callTitle(c,simName);
  const kind=callDirectionKind(c);
  const select=onSelect?()=>onSelect(c):undefined;
  const openCard=select??(()=>onOpenCard?.(c));
  const interactive=Boolean(onSelect||onOpenCard);
  const dot=callShowsDot(c,seenIds);
  const duration=talkDuration(c);
  // 电话 page recent list (no media): compact S95 row — relative time, chip column, hover quick actions, facts for screen readers.
  const compact=!showRecordings;
  const facts=callFacts(c,sessionUsername);
  const chip=(sim||simName)&&<CallSimChip c={c} sim={sim} sims={sims} simName={simName} quiet={compact}/>;
  return <React.Fragment key={c.id}>{header}<article className={`record call-record call-kind-${kind}${selectedId===c.id?' selected':''}`} id={`call-record-${c.id}`} role={interactive?'group':undefined} aria-current={selectedId===c.id?'true':undefined} aria-label={interactive?`${dot?'未查看，':''}通话记录 ${internalCallTitle(c,simName)??numberWithContact(remote,c.contactName)}，${onSelect?'按回车查看详情':'按回车打开联系人卡片'}`:undefined} tabIndex={interactive?0:undefined} onKeyDown={interactive?event=>{
   if(event.target!==event.currentTarget||!['Enter',' '].includes(event.key))return;
   event.preventDefault();openCard();
  }:undefined} onClick={interactive?event=>{
   // The row itself opens the card, but never when the click landed on a control or on the media sections.
   if(event.target instanceof Element&&event.target.closest('button,a,input,audio,details,summary,label,.call-recording,.report-transcript,.transcript-detail,.ai-transcript,.record-media-actions,.record-actions,.confirm-action'))return;
   openCard();
  }:undefined}><div className="call-record-heading">
   <span className={`call-dir call-dir-${kind}`} aria-hidden={kind==='blocked'?undefined:'true'}>{kind==='blocked'?<span className="blocked-mark" role="img" aria-label={blockedLabel&&!isBlockedRow(c)?'已拦截':'已屏蔽'}><UiIcon name="blocked"/></span>:DIR_GLYPH[kind]}</span>
   <div className="call-record-number">
    <strong dir="auto">{dot&&<span className="unread-dot call-unread-dot"><span className="sr-only">未查看</span></span>}{kind!=='blocked'&&isBlockedRow(c)&&<span className="blocked-mark" role="img" aria-label="已屏蔽"><UiIcon name="blocked"/></span>}{title}</strong>
    <span className="call-record-line">{!compact&&chip}{showNumber&&<span className="call-record-remote num" dir="ltr">{remote}</span>}{directionSmall(c)}{duration&&<small className="call-duration num"> · {duration}</small>}{aiAnsweredCall(c)&&<span className="record-tag tag-ai">AI 代接</span>}{compact&&facts.length>0&&<span className="sr-only">{facts.join('；')}</span>}</span>
   </div>
   {compact&&chip}
   <div className="call-record-meta"><time className="num" dateTime={c.startedAt} title={formatCompactCallDate(c.startedAt,zone)}>{grouped?groupedTime(c.startedAt,zone,group):compact?relativeCallTime(c.startedAt,zone,now):formatCompactCallDate(c.startedAt,zone)}</time>{onOpenCard&&!onSelect&&!(compact&&onHistoryAction)&&<button type="button" className="record-info" aria-label={`联系人信息 ${remote||'未知号码'}`} disabled={busy} onClick={()=>onOpenCard(c)}><UiIcon name="info"/></button>}</div>
  </div>
  {!onSelect&&!compact&&facts.map(fact=><p className="call-owner" key={fact}>{fact}</p>)}
  {suppressed&&<p className="call-ai-status" role="status">{AI_ANSWERING_LABEL}</p>}
  {onAction&&(offersAnswerControls(c)||mayEnd)&&<div className="record-actions">{offersAnswerControls(c)&&<button className="primary" disabled={busy||Boolean(mediaCallId&&mediaCallId!==c.id)} onClick={()=>void onAction(c.id,'claim')}>接听</button>}{mayEnd&&<button className="passkey hangup" disabled={busy} onClick={()=>void onAction(c.id,'end')}>{c.state==='incoming_ringing'?'拒接':'结束通话'}</button>}</div>}
  {(showRecordings||onHistoryAction)&&<HistoryCallActions remoteNumber={c.remoteNumber||c.number} simId={c.simId} mediaLive={Boolean(mediaCallId)} busy={busy} onRedial={()=>void onHistoryAction?.(c,'redial')} onSms={()=>void onHistoryAction?.(c,'sms')} onBlock={()=>onHistoryAction?.(c,'block')} onDelete={onHistoryAction?()=>onHistoryAction(c,'delete'):undefined}/>}
  {showRecordings&&!onSelect&&<div className="record-media-actions" role="group" aria-label="录音与转录"><CallRecording callId={c.id} timeZone={zone} request={request} preferPixelSource={preferPixelSource(c)} ownerJoinedLocal={c.ownerJoinedLocal} gatewayKind={c.gatewayKind??sim?.gatewayKind}/><CallTranscript callId={c.id} request={request}/>{request&&aiAnsweredCall(c)&&<AiTranscriptToggle callId={c.id} request={request} labels={AI_TRANSCRIPT_LABELS}/>}</div>}
 </article></React.Fragment>;
 })}</div>;
}
