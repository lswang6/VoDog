import {useUiMotionSafety} from './ui-motion';
import React, {useEffect,useState,useRef,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {UiIcon,type IconName} from './icons';
import {Messages,SmsCompose} from './messages';
import {deleteMessagesAndRefresh,deleteThread,type MessageThread} from './message-threads';
import {CallMedia} from './media';
import {mayEndCall,requiresSessionOwnerEnd,ringingEndGuard,errorCode,mediaErrorMessage,callErrorMessage} from './media-policy';
import {audioOwnership} from './audio-ownership';
import {acceptBrowserSession,isBrowserSignedOut,markBrowserSignedOut,mutateBrowserSession,browserSessionGeneration,expireBrowserSession,listenForSessionInvalidation} from './session-boundary';
import {AiTranscriptToggle,CallReports,CallTranscript,type ReportItem} from './reports';
import {formatCompactCallDate,formatCompactClock,gatewayDisplayTimeZone} from './gateway-time';
import {OutboundAttempt} from './outbound-attempt';
import {gatewayShortLabel,gatewayTag} from './gateway-kind';
import {CallAttemptScope,claimedByThisSession,claimWithReconciliation,CurrentSessionCallEnd,sendDtmfDigit} from './call-lifecycle';
import {diag,fetchErrorType} from './diag';
import {loadAllSms,type SmsPage} from './sms-pages';
import {useReportedError,flashConfirmation} from './ui-error';
import {WebCallLiveness,type CallLivenessAPI,type CallLivenessSnapshot} from './call-liveness';
import {DashboardRefreshCoordinator,dashboardRefreshIntervalMs,IDLE_DASHBOARD_REFRESH_MS} from './dashboard-refresh';
import {useVisibleRefresh} from './visible-refresh';
import {startAuthentication} from '@simplewebauthn/browser';
import {dialTone} from './dial-tone';
import {incomingRingtone} from './incoming-ringtone';
import {TurnstileWidget} from './turnstile';
import {AuthConfigLoader,finishPasswordAttempt,initialAuthConfigState,loginAvailability,passkeyOptionsBody,passwordTurnstileToken,type AuthConfigState} from './auth-config';
import {ConfirmAction} from './confirm-action';
import {GATEWAY_DELETE_PROMPT} from './confirm-copy';
import {PasskeyPanel} from './passkey-panel';
import {canBlock,canRedial,canSendSMS,deleteCallRecord,normalizedDialNumber} from './history-actions';
import {audibleRingingCall,canReleaseOccupancy,gatewayOccupiedCall} from './call-occupancy';
import {OccupancyNotice} from './occupancy-notice';
import {ContactsPanel} from './contacts-panel';
import {ContactCard,type ContactCardTarget} from './contact-card';
import {GatewayPowerPanel} from './gateway-power-panel';
import {VoiceProviderPanel} from './voice-provider-panel';
import {InterceptionsPanel} from './interceptions-panel';
import {AI_TRANSCRIPT_LABELS,CallHistoryPanel,CallList,Empty,aiAnsweredCall,labels,type Call,type Sim} from './call-history-panel';
import {CallRecording} from './recording';
import {preferPixelSource} from './recording-contract';
import {clientPage} from './pager';
import {isBlockedRow,numberWithContact,type ContactDto} from './contacts';
import type {InterceptionRow} from './interceptions';
import {settingsStatus,simAnswerModeBadge} from './settings-status';
import {simPaletteColor} from './sim-palette';
import {SimNotesForm,SimReceptionForm} from './sim-settings-forms';
import {acceptSettingsMutation} from './settings-mutations';
import {SettingsOverview} from './settings-overview';
import {BlocklistPanel} from './blocklist-panel';
import {TabBoundary} from './tab-boundary';
import {EMPTY_BADGES,badgeLabel,callAwaitsReview,decrementBadges,navBadgeCount,parseBadges,simBadgeCount,type Badges} from './badges';

// S69: 最早处挂错误监听，登录前的异常也进诊断缓冲（登录后随首批上报）。
diag.listen();

type Sms={id:string;simId:string;direction:string;number?:string;remoteNumber?:string;conversationAddress?:string;body:string;state:string;createdAt:string;contactId?:string|null;contactName?:string|null;blocked?:boolean;blockedEntryId?:string|null;unread?:boolean};
class ApiFailure extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message);}}
type SimLoadStatus='loading'|'ready'|'error';
class SimRefreshFailure extends Error{
 constructor(readonly authEpoch:number,cause:unknown){super(cause instanceof Error?cause.message:'无法读取 SIM 信息');this.name='SimRefreshFailure';}
}
const WEB_CALL_PROTOCOL='web-liveness-v1';
/** 近期通话 每页显示的历史条数（实时通话始终置顶显示，不参与分页）。 */
const RECENT_CALL_PAGE_SIZE=8;
type APIOptions={idempotencyKey?:string;signal?:AbortSignal;timeoutMs?:number;keepalive?:boolean;callProtocol?:boolean;cookieMutationOwned?:boolean;diagSource?:boolean;diagSentAt?:number};
async function api<T>(path:string,body?:unknown,method?:string,options:APIOptions={}):Promise<T>{
 if(['/auth/login','/auth/logout','/passkeys/authenticate/verify'].includes(path)&&!options.cookieMutationOwned)return mutateBrowserSession(path==='/auth/logout'?'logout':'login',()=>api<T>(path,body,method,{...options,cookieMutationOwned:true}));
 const requestGeneration=browserSessionGeneration();
 const controller=new AbortController(),external=options.signal;
 const abort=()=>controller.abort();if(external?.aborted)abort();else external?.addEventListener('abort',abort,{once:true});
 let timedOut=false;const began=Date.now();
 const timer=setTimeout(()=>{timedOut=true;abort();},options.timeoutMs??10000),hasBody=body!==undefined;
 try{
  const r=await fetch('/api/v1'+path,{method:method||(hasBody?'POST':'GET'),credentials:'include',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(options.idempotencyKey!==undefined?{'Idempotency-Key':options.idempotencyKey}:hasBody&&typeof body==='object'&&body!==null&&'idempotencyKey' in body?{'Idempotency-Key':String(body.idempotencyKey)}:{}),...(options.callProtocol?{'X-VoDog-Call-Protocol':WEB_CALL_PROTOCOL}:{}),...(options.diagSource?{'X-Diag-Source':'web','X-Diag-Install':diag.installId,...(options.diagSentAt!==undefined?{'X-Diag-Sent-At':String(options.diagSentAt)}:{})}:{})},body:hasBody?JSON.stringify(body):undefined,signal:controller.signal,keepalive:options.keepalive});
  const d=await r.json().catch(()=>({}));if(r.status===401&&!['/auth/me','/auth/login','/passkeys/authenticate/verify','/diag/events'].includes(path))expireBrowserSession(requestGeneration);if(!r.ok){const code=d.error?.code||`HTTP_${r.status}`;if(!path.startsWith('/diag'))diag.log('api.error',{path,code:r.status,serverCode:code,ms:Date.now()-began});throw new ApiFailure(r.status,code,callErrorMessage(code,d.error?.message||d.message||`请求失败 (${r.status})`));}return d as T;
 }catch(e){
  // S69: 网络层失败记 code:0 + errorType；外部主动取消不记。号码留在 path 里（S69 决定 6）。
  if(!(e instanceof ApiFailure)&&!path.startsWith('/diag')){const errorType=fetchErrorType(Boolean(external?.aborted),timedOut,navigator.onLine);if(errorType)diag.log('api.error',{path,code:0,errorType,ms:Date.now()-began});}
  throw e;
 }finally{clearTimeout(timer);external?.removeEventListener('abort',abort);}
}
/** S67: red pill in the top-right corner; hidden at 0, screen readers hear「N 条未读」. */
function UnreadBadge({count}:{count:number}){const label=badgeLabel(count);return label?<><b className="unread-badge" aria-hidden="true">{label}</b><span className="sr-only">{count} 条未读</span></>:null;}
export function SimSelector({sims,selectedId,status,busy,onSelect,onRetry,allLabel,badgeCount}:{
 sims:Sim[];selectedId:string;status:SimLoadStatus;busy:boolean;onSelect:(id:string)=>void;onRetry:()=>void;
 /** S64 记录: a leading chip for every SIM, selected when selectedId is ''. */
 allLabel?:string;
 /** S67 per-SIM unread count for the current tab. */
 badgeCount?:(simId:string)=>number;
}){
 return <>
  <section className="sim-bar" aria-label="选择 SIM">
   {allLabel&&sims.length>0&&<button className={selectedId===''?'selected':''} onClick={e=>{onSelect('');e.currentTarget.scrollIntoView({block:'nearest',inline:'center'});}}><strong>{allLabel}</strong><span>显示所有号码的记录</span></button>}
   {sims.length?sims.map(s=>{const c=simPaletteColor(s,sims);return <button className={selectedId===s.id?'selected':''} key={s.id} style={{'--sim-light':c.light,'--sim-dark':c.dark} as React.CSSProperties} onClick={e=>{onSelect(s.id);e.currentTarget.scrollIntoView({block:'nearest',inline:'center'});}}>{badgeCount&&<UnreadBadge count={badgeCount(s.id)}/>}<span className={`sim-dot ${s.present!==false&&s.online?'online':'offline'}`} aria-hidden="true"/><strong>{s.label||'未命名号码'}</strong>{(b=>b&&<span className="sim-mode-badge" aria-label={`接听方式：${b}`}>{b}</span>)(simAnswerModeBadge(s.settings))}<span>{s.phoneLabel||'未标注号码'}</span><small>{s.present===false?'未待机':s.online?'在线':'离线'}</small><span className="gateway-source" title={gatewayTag(s.gatewayId,s.gatewayKind)}>{gatewayShortLabel(s.gatewayId,s.gatewayKind,s.gatewayName)}</span></button>;}):status==='loading'?<div className="empty-sim"><strong>正在读取 SIM…</strong><span>正在确认当前账号的 SIM 分配。</span></div>:status==='error'?<div className="empty-sim"><strong>SIM 信息暂不可用</strong><span>暂时无法确认当前账号的 SIM 分配。</span></div>:<div className="empty-sim"><strong>还没有分配的 SIM</strong><span>在网关设备上配对，并将 SIM 分配到此账号。</span></div>}
  </section>
  {status==='error'&&<div className="error sim-load-error" role="alert"><p>{sims.length?'SIM 刷新失败，已保留上次读取的号码。':'暂时无法读取 SIM 信息，请重试。'}</p><button type="button" className="passkey" disabled={busy} onClick={onRetry}>重试读取 SIM</button></div>}
 </>;
}

function App(){
 useUiMotionSafety();
 const [user,setUser]=useState<{username:string;role?:string}|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [tab,setTab]=useState('通话'),[sims,setSims]=useState<Sim[]>([]),[simId,setSimId]=useState(''),[simDraftsDirty,setSimDraftsDirty]=useState({notes:false,reception:false}),[pendingSimSwitch,setPendingSimSwitch]=useState<string|null>(null),[calls,setCalls]=useState<Call[]>([]),[messages,setMessages]=useState<Sms[]>([]),[number,setNumber]=useState('');
 const [badges,setBadges]=useState<Badges>(EMPTY_BADGES);const badgeSeq=useRef(0),seenCalls=useRef(new Set<string>());
 // S67c: calls opened in this tab drop their row dot at once; the next list read is authoritative.
 // ponytail: grows by one id per opened call until sign-out, fine for a tab's lifetime.
 const [seenCallIds,setSeenCallIds]=useState<ReadonlySet<string>>(()=>new Set());
 const [connectionError,setConnectionError]=useState(''),[simLoadStatus,setSimLoadStatus]=useState<SimLoadStatus>('loading');
 const [keypadCallId,setKeypadCallId]=useState<string|null>(null),[dtmfError,setDtmfError]=useState('');
 const [authConfig,setAuthConfig]=useState<AuthConfigState>(initialAuthConfigState),[authConfigRetry,setAuthConfigRetry]=useState(0),[turnstileToken,setTurnstileToken]=useState<string|null>(null),[turnstileReset,setTurnstileReset]=useState(0);
 const [loginUsername,setLoginUsername]=useState('');
 const [activeMediaCallId,setActiveMediaCallId]=useState<string|null>(null),[microphoneMuted,setMicrophoneMuted]=useState(false),[mediaReconnecting,setMediaReconnecting]=useState(false),[endingCallId,setEndingCallId]=useState<string|null>(null),[ringtoneMuted,setRingtoneMuted]=useState(false);
const [smsCompose,setSmsCompose]=useState<{simId:string;remoteNumber:string;contactName:string|null;token:number}|null>(null);
// 联系人卡片 → 发送短信 from a call row: a modal over the current tab, separate from the 通讯录 side panel.
const [smsModal,setSmsModal]=useState<{remoteNumber:string;contactName:string|null;token:number}|null>(null);
 const [recordsView,setRecordsView]=useState<'calls'|'reports'|'blocked'>('calls'),[recordsSimId,setRecordsSimId]=useState('');
 const [historyLive,setHistoryLive]=useState(0);
 const [recentPage,setRecentPage]=useState(1);
 const [cardTarget,setCardTarget]=useState<(ContactCardTarget&{contact?:ContactDto|null;call?:Call})|null>(null);
 const [contactDraftRequest,setContactDraftRequest]=useState<{remoteNumber:string;token:number}|null>(null);
const [contactEditRequest,setContactEditRequest]=useState<{contact:ContactDto;token:number}|null>(null);
 const [contactsEpoch,setContactsEpoch]=useState(0);
 const [settingsReloadToken,setSettingsReloadToken]=useState(0),[settingsRefreshStatus,setSettingsRefreshStatus]=useState('');
 const [settingsSubmission,setSettingsSubmission]=useState<{simId:string;target:number;submittedObservation:number;submittedAt:number}|null>(null);
 const [dialHint,setDialHint]=useState('');
 const ringtoneNeedsUnlock=useSyncExternalStore(incomingRingtone.subscribe,()=>incomingRingtone.needsUnlock);
 const authEpoch=useRef(0);
 const actionInFlight=useRef(false);
 const simsObservation=useRef(0);
 const pollDelay=useRef(IDLE_DASHBOARD_REFRESH_MS);
 const manuallyEndingCall=useRef<string|null>(null);
 const [transport,setTransport]=useState<'udp'|'tls'>('udp');
 const mediaCallId=useRef<string|null>(null),media=useRef<CallMedia|null>(null);
 const liveness=useRef<WebCallLiveness|null>(null);
 const endOwned=useRef<{epoch:number;queue:CurrentSessionCallEnd}|null>(null);
 const callAttempts=useRef<CallAttemptScope|null>(null);
 const dashboardRefresh=useRef<DashboardRefreshCoordinator<{items:Sim[]},{items:Call[]},{items:Sms[]}>|null>(null);
 const authConfigLoader=useRef<AuthConfigLoader|null>(null);
 if(!authConfigLoader.current)authConfigLoader.current=new AuthConfigLoader();
 if(!callAttempts.current)callAttempts.current=new CallAttemptScope(sessionStorage);
 if(!dashboardRefresh.current)dashboardRefresh.current=new DashboardRefreshCoordinator({
  epoch:()=>authEpoch.current,
  loadSims:async()=>{const epoch=authEpoch.current;try{return await api<{items:Sim[]}>('/sims');}catch(cause){throw new SimRefreshFailure(epoch,cause);}},loadCalls:()=>api<{items:Call[]}>('/calls?includeBlocked=true'),loadMessages:()=>loadAllSms<Sms>(path=>api<SmsPage<Sms>>(path),(pages,items)=>diag.log('sms.page_cap',{pages,items})),
  applySims:s=>{simsObservation.current++;setSims(s.items);setSimLoadStatus('ready');setSimId(old=>s.items.some(x=>x.id===old)?old:s.items[0]?.id||'');setRecordsSimId(old=>!old||s.items.some(x=>x.id===old)?old:'');},
  applyCalls:c=>setCalls(c.items),applyMessages:m=>setMessages(m.items),
 });
 function setMediaCallId(id:string|null){mediaCallId.current=id;setActiveMediaCallId(id);diag.setCall(id);if(!id){setMicrophoneMuted(false);setMediaReconnecting(false);}}
 function endCurrentSessionCall(id:string):Promise<void>{
  const epoch=authEpoch.current;
  if(endOwned.current?.epoch!==epoch)endOwned.current={epoch,queue:new CurrentSessionCallEnd((path,requestBody)=>{
   if(authEpoch.current!==epoch)throw Object.assign(new Error('登录会话已改变'),{status:409});
   return api(path,requestBody,undefined,{timeoutMs:4000});
  })};
  return endOwned.current.queue.end(id);
 }
 if(!liveness.current)liveness.current=new WebCallLiveness((id,message)=>{if(mediaCallId.current===id){setMediaCallId(null);media.current?.stop();}setError(message);void endCurrentSessionCall(id).then(()=>refresh()).catch(()=>{});});
 if(!media.current)media.current=new CallMedia(message=>{const id=mediaCallId.current;setMediaCallId(null);liveness.current?.stop();setError(message);if(id)void endCurrentSessionCall(id).then(()=>refresh()).catch(()=>{});},{onMediaDrop:()=>{void refresh().catch(()=>{});},onReconnecting:setMediaReconnecting});
 useEffect(()=>{const stop=()=>{incomingRingtone.stop();audioOwnership.stopRecordings();const id=mediaCallId.current;setMediaCallId(null);liveness.current?.stop();media.current?.stop();if(id)void api(`/calls/${encodeURIComponent(id)}/end`,{onlyIfCurrentSessionOwner:true},'POST',{timeoutMs:2000,keepalive:true}).catch(()=>{});};window.addEventListener('pagehide',stop);return()=>{window.removeEventListener('pagehide',stop);stop();};},[]);
 useEffect(()=>{if(calls.some(c=>c.id===mediaCallId.current&&['ended','failed','ending','unknown'].includes(c.state))){liveness.current?.stop();media.current?.stop();setMediaCallId(null);}else if(calls.some(c=>c.id===liveness.current?.callId&&['ended','failed','ending','unknown'].includes(c.state)))liveness.current?.stop();},[calls]);
 useEffect(()=>{incomingRingtone.setMuted(ringtoneMuted);},[ringtoneMuted]);
 // A call the AI is answering is not a call for this browser to ring for (S22 决策 4).
 useEffect(()=>{if(!user||ringtoneMuted||busy||endingCallId||activeMediaCallId||!audibleRingingCall(calls))incomingRingtone.stop();else incomingRingtone.start();},[user,calls,activeMediaCallId,ringtoneMuted,busy,endingCallId]);
 const selected=sims.find(s=>s.id===simId);
 const recordsSim=sims.find(s=>s.id===recordsSimId);
 const submittedSettingStatus=selected?settingsStatus(selected.settings,settingsSubmission?.simId===selected.id?{target:settingsSubmission.target,fresh:simsObservation.current>settingsSubmission.submittedObservation,timedOut:Date.now()-settingsSubmission.submittedAt>30000}:null):'';
 const canUseSelectedPhone=Boolean(selected?.online&&selected?.present!==false&&selected?.telephonyReady&&selected?.mediaReady);
 const occupied=gatewayOccupiedCall(calls,sims,selected?.gatewayId);
 const ownedCall=calls.find(c=>c.claimedByCurrentSession===true&&!['ended','failed'].includes(c.state));
 const controlledCallId=activeMediaCallId||ownedCall?.id||null;
 const activeCall=calls.find(c=>c.id===controlledCallId);
 // 近期通话 (S35): live calls stay pinned so ringing/接听/结束 are always reachable; the ended/failed
 // history is client-paginated so the panel stays as tall as the dialer instead of growing without bound.
 const recentLive=calls.filter(c=>!['ended','failed'].includes(c.state));
 const recentHistory=calls.filter(c=>['ended','failed'].includes(c.state)&&(!simId||c.simId===simId));
 const recentHistoryPage=clientPage(recentHistory,recentPage,RECENT_CALL_PAGE_SIZE);
 const recentCalls=[...recentLive,...recentHistoryPage.items];
 // A card opened from a record follows that record: after 屏蔽/解除 the reloaded row is what it shows.
 const cardCall=cardTarget?.callId?calls.find(c=>c.id===cardTarget.callId):undefined;
 const liveCardTarget=cardTarget&&cardCall?{...cardTarget,remoteNumber:cardCall.remoteNumber||cardCall.number||cardTarget.remoteNumber,simId:cardCall.simId,contactId:cardCall.contactId??cardTarget.contactId,contactName:cardCall.contactName??cardTarget.contactName,blocked:cardCall.blocked??cardTarget.blocked,blockedEntryId:cardCall.blockedEntryId??cardTarget.blockedEntryId}:cardTarget;
 // The records page opens older calls that the dashboard list no longer holds: fall back to the row it was opened from.
 const mediaCall=cardCall??cardTarget?.call,mediaSim=sims.find(s=>s.id===mediaCall?.simId);
 // S67: /badges rides every dashboard refresh but never fails it; errors and malformed bodies keep the last value.
 function loadBadges(){const epoch=authEpoch.current,seq=++badgeSeq.current;api<unknown>('/badges').then(raw=>{const next=parseBadges(raw);if(next&&epoch===authEpoch.current&&seq===badgeSeq.current)setBadges(next);}).catch(()=>{});}
 function applyBadgeDecrement(line:string,kind:'calls'|'sms',by:number){badgeSeq.current++;setBadges(old=>decrementBadges(old,line,kind,by));}
 function markCallSeen(call:{id:string;simId:string}&Parameters<typeof callAwaitsReview>[0]){const epoch=authEpoch.current;setSeenCallIds(ids=>ids.has(call.id)?ids:new Set(ids).add(call.id));api(`/calls/${encodeURIComponent(call.id)}/seen`,undefined,'POST').then(()=>{if(epoch!==authEpoch.current)return;if(callAwaitsReview(call)&&!seenCalls.current.has(call.id)){seenCalls.current.add(call.id);applyBadgeDecrement(call.simId,'calls',1);}loadBadges();}).catch(()=>{if(epoch===authEpoch.current)setSeenCallIds(ids=>{const next=new Set(ids);next.delete(call.id);return next;});});}
 async function markSmsRead(ids:string[]){const epoch=authEpoch.current,line=messages.find(m=>m.id===ids[0])?.simId||simId;let updated=0;try{for(let i=0;i<ids.length;i+=500)updated+=(await api<{updated?:number}>('/sms/read',{ids:ids.slice(i,i+500)})).updated||0;}catch{}if(epoch!==authEpoch.current)return;applyBadgeDecrement(line,'sms',updated);loadBadges();}
 async function refresh(){loadBadges();try{return await dashboardRefresh.current!.request();}catch(caught){if(caught instanceof SimRefreshFailure&&caught.authEpoch===authEpoch.current)setSimLoadStatus('error');throw caught;}}
 async function loadLatestAssignedSim(id:string):Promise<Sim>{const result=await api<{items:Sim[]}>('/sims');const latest=result.items.find(item=>item.id===id);if(!latest)throw new Error('此号码已不再分配给当前账号。');return latest;}
 function refreshAfterReconnect(){void refresh().then(applied=>{if(applied)setConnectionError('');}).catch(()=>setConnectionError('连接暂时中断，正在自动重试。'));}
 function retrySimLoad(){if(simLoadStatus==='loading')return;setSimLoadStatus('loading');refreshAfterReconnect();}
 // S69 ui.error_shown：共享错误横幅出现时各记一条（diag 内同 screen+message 60 秒合并）。
 useReportedError(user?tab:'login','banner',error);
 useReportedError(tab,'connection',connectionError);
 useReportedError(tab,'sim.load',simLoadStatus==='error'&&'SIM 信息暂不可用');
 useReportedError('login','auth-config',authConfig.status==='error'&&authConfig.message);
 useReportedError(tab,'dtmf',dtmfError);
 useEffect(()=>listenForSessionInvalidation(()=>{authEpoch.current++;dashboardRefresh.current?.invalidate();setBadges(EMPTY_BADGES);seenCalls.current.clear();setSeenCallIds(new Set());incomingRingtone.stop();audioOwnership.stopRecordings();liveness.current?.stop();media.current?.stop();setMediaCallId(null);setUser(null);setSims([]);setSimLoadStatus('loading');setCalls([]);setMessages([]);setSettingsReloadToken(0);setSettingsRefreshStatus('');setSettingsSubmission(null);setError('登录状态已改变，请重新登录。');}),[]);
 useEffect(()=>{if(isBrowserSignedOut()){setLoading(false);return;}const epoch=authEpoch.current;let cancelled=false;api<{user:{username:string;role?:string}}>('/auth/me').then(d=>{if(!cancelled&&epoch===authEpoch.current)setUser(d.user);}).catch(()=>{}).finally(()=>{if(!cancelled)setLoading(false);});return()=>{cancelled=true;};},[]);
 useEffect(()=>{if(user){authConfigLoader.current!.invalidate();return;}void authConfigLoader.current!.load(()=>api('/auth/config'),state=>{setAuthConfig(state);if(state.status!=='ready'||state.config.enabled)setTurnstileToken(null);});return()=>authConfigLoader.current!.invalidate();},[user,authConfigRetry]);
 useEffect(()=>{if(!user)return;diag.start(api);const connection=(navigator as Navigator&{connection?:EventTarget&{type?:string;effectiveType?:string}}).connection;
  const networkChanged=()=>diag.log('network.type',{type:connection?.type??connection?.effectiveType??'unknown'});connection?.addEventListener('change',networkChanged);
  let cancelled=false;let timer:ReturnType<typeof setTimeout>;const schedule=()=>{clearTimeout(timer);if(!cancelled&&document.visibilityState==='visible')timer=setTimeout(()=>void poll(),pollDelay.current);};async function poll(){if(cancelled||document.visibilityState!=='visible')return;try{const applied=await refresh();if(!cancelled&&applied)setConnectionError('');}catch(e){if(!cancelled)setConnectionError('连接暂时中断，正在自动重试。');}schedule();}const visible=()=>{if(document.visibilityState==='visible')void poll();else clearTimeout(timer);};document.addEventListener('visibilitychange',visible);void poll();return()=>{cancelled=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);connection?.removeEventListener('change',networkChanged);void diag.stop();authEpoch.current++;dashboardRefresh.current?.invalidate();};},[user]);
 useEffect(()=>{pollDelay.current=dashboardRefreshIntervalMs(calls);},[calls]);
 useEffect(()=>{if(!user)return;const visible=()=>{if(document.visibilityState==='visible')refreshAfterReconnect();};window.addEventListener('focus',refreshAfterReconnect);window.addEventListener('online',refreshAfterReconnect);document.addEventListener('visibilitychange',visible);return()=>{window.removeEventListener('focus',refreshAfterReconnect);window.removeEventListener('online',refreshAfterReconnect);document.removeEventListener('visibilitychange',visible);};},[user]);
 useEffect(()=>{if(user&&tab==='记录')refreshAfterReconnect();},[user,tab]);
 /**
  * 通话记录 是服务端分页的独立请求（S28），不再跟着 1–2 s 的仪表盘轮询走。为了保留“记录页随通话状态变化”的手感，
  * 只有当通话的 id/状态集合真的变了才让它重新读一页——纯粹的轮询抖动不会造成请求。
  */
 const callsLiveKey=calls.map(c=>`${c.id}:${c.state}`).join(',');
 useEffect(()=>{setHistoryLive(value=>value+1);},[callsLiveKey]);
 // 切换所选 SIM 时回到近期通话第 1 页，避免停在旧号码的历史分页上。
 useEffect(()=>{setRecentPage(1);},[simId]);
 /** Dialer name hint (S21 §F): one debounced lookup per pause in typing, and never a stale name under a new number. */
 useEffect(()=>{
  setDialHint('');
  const dest=normalizedDialNumber(number);
  if(!user||controlledCallId||dest.length<3)return;
  const controller=new AbortController();
  const timer=setTimeout(()=>{
   void api<{item:{displayName?:string}|null}>(`/contacts/lookup?number=${encodeURIComponent(dest)}`,undefined,undefined,{signal:controller.signal,timeoutMs:4000})
    .then(found=>{if(!controller.signal.aborted)setDialHint(found.item?.displayName||'');})
    // No 通讯录 on an older Control, and a failed hint must never disturb dialing.
    .catch(()=>{});
  },300);
  return()=>{clearTimeout(timer);controller.abort();};
 },[number,user,controlledCallId]);
 function startLiveness(id:string,snapshot:CallLivenessSnapshot|null|undefined,epoch:number){if(!snapshot)throw new Error('服务器尚未启用通话存活保护');async function scopedApi<T>(path:string,body?:unknown,method?:string,options?:APIOptions):Promise<T>{if(epoch!==authEpoch.current)throw new Error('登录状态已改变');const response=await api<T>(path,body,method,options);if(epoch!==authEpoch.current)throw new Error('登录状态已改变');return response;}liveness.current!.start(id,snapshot,scopedApi as CallLivenessAPI);}
 async function startMedia(id:string){incomingRingtone.stop();if(mediaCallId.current&&mediaCallId.current!==id)throw new Error('请先结束本设备正在进行的通话');if(mediaCallId.current===id)return;setMediaCallId(id);const epoch=authEpoch.current;async function scopedApi<T>(path:string,body?:unknown,method?:string,options?:APIOptions):Promise<T>{if(epoch!==authEpoch.current)throw new Error('登录状态已改变');const response=await api<T>(path,body,method,options);if(epoch!==authEpoch.current)throw new Error('登录状态已改变');return response;}try{await media.current!.start(id,scopedApi,transport);}catch(e){if(mediaCallId.current===id)setMediaCallId(null);liveness.current?.stop();if(manuallyEndingCall.current===id)return;if(epoch===authEpoch.current)await endCurrentSessionCall(id);throw Object.assign(new Error(mediaErrorMessage(errorCode(e),e instanceof Error?e.message:'媒体连接失败')),{code:errorCode(e)});}}
 /** Ends this account's call on another device through the existing owner-authorized route. */
 async function releaseOccupiedCall(call:Call){await run(async()=>{try{await api(`/calls/${encodeURIComponent(call.id)}/end`,call.state==='incoming_ringing'?ringingEndGuard(call):{});}finally{await refresh();}});}
 // S36 C2: 通话中按键即发即忘，只在这一行显示失败；绝不打断通话或弹窗。
 function sendDtmf(callId:string,key:string){
  const began=Date.now();
  void sendDtmfDigit(api,callId,key).then(sent=>{if(sent){setDtmfError('');diag.log('dtmf.send',{code:'ok',ms:Date.now()-began},callId);}})
   .catch(e=>{setDtmfError(e instanceof Error?e.message:'按键未送达，请重试。');diag.log('dtmf.send',{code:errorCode(e)||'error',ms:Date.now()-began},callId);});
 }
 async function stopOwnedCall(id:string){if(endingCallId===id)return;incomingRingtone.stop();manuallyEndingCall.current=id;setEndingCallId(id);setError('');if(liveness.current?.callId===id)liveness.current.stop();if(mediaCallId.current===id){setMediaCallId(null);media.current?.stop();}const began=Date.now();try{await endCurrentSessionCall(id);diag.log('call.end',{code:'ok',ms:Date.now()-began},id);await refresh();}catch(e){diag.log('call.end',{code:errorCode(e)||'error',ms:Date.now()-began},id);setError(e instanceof Error?e.message:'停止通话失败，请重试。');}finally{if(manuallyEndingCall.current===id)manuallyEndingCall.current=null;setEndingCallId(null);}}
 async function logout(){markBrowserSignedOut();const username=user?.username;authEpoch.current++;dashboardRefresh.current?.invalidate();setBadges(EMPTY_BADGES);seenCalls.current.clear();setSeenCallIds(new Set());incomingRingtone.stop();audioOwnership.stopRecordings();liveness.current?.stop();media.current?.stop();const id=mediaCallId.current;setMediaCallId(null);setSettingsReloadToken(0);setSettingsRefreshStatus('');setSettingsSubmission(null);const ending=id?endCurrentSessionCall(id):Promise.resolve();const signingOut=api('/auth/logout',undefined,'POST',{timeoutMs:5000});if(username){callAttempts.current!.clear(username);for(const view of ['calls','reports','blocked'])try{sessionStorage.removeItem(recordsKey(view,username)!);}catch{}}setUser(null);setSims([]);setSimLoadStatus('loading');setCalls([]);setMessages([]);const results=await Promise.allSettled([ending,signingOut]);if(results[1].status==='rejected')setError('本机已退出，服务器暂未确认。请稍后重新登录。');}
 async function callAction(id:string,action:'claim'|'end'){await run(async()=>{incomingRingtone.stop();const epoch=authEpoch.current;try{if(action==='claim'){if(mediaCallId.current&&mediaCallId.current!==id)throw new Error('请先结束本设备正在进行的通话');const claimedAt=Date.now();const result=await claimWithReconciliation(()=>api<{call:Call;liveness:CallLivenessSnapshot|null}>(`/calls/${id}/claim`,{platform:'web',deviceName:'Web 浏览器'},undefined,{callProtocol:true}),()=>api<{call:Call;liveness:CallLivenessSnapshot|null}>(`/calls/${id}`));diag.log('call.claim',{ms:Date.now()-claimedAt},id);if(epoch!==authEpoch.current)return;if(!claimedByThisSession(result.call))throw new Error('本会话未获得接听权');try{startLiveness(id,result.liveness,epoch);}catch(error){await endCurrentSessionCall(id);throw error;}await startMedia(id);return;}const call=calls.find(item=>item.id===id);if(!call||!mayEndCall(call,mediaCallId.current))throw new Error('此通话由其他设备处理');const needsSessionOwnership=requiresSessionOwnerEnd(call);if(liveness.current?.callId===id)liveness.current.stop();if(id===mediaCallId.current){setMediaCallId(null);media.current?.stop();}if(needsSessionOwnership)await endCurrentSessionCall(id);else await api(`/calls/${id}/end`,ringingEndGuard(call));}finally{await refresh();}});} 
 async function startOutboundCall(lineId:string,remoteNumber:string){const username=user?.username;if(!username)throw new Error('登录状态已改变');await run(async()=>{const epoch=authEpoch.current;if(mediaCallId.current)throw new Error('请先结束本设备正在进行的通话');const line=sims.find(s=>s.id===lineId);const canUse=Boolean(line?.online&&line?.present!==false&&line?.telephonyReady&&line?.mediaReady);const lineBusy=gatewayOccupiedCall(calls,sims,line?.gatewayId);if(lineBusy||!canUse)throw new Error('所选号码当前无法拨打');const payload={simId:lineId,remoteNumber};const attempt=new OutboundAttempt(sessionStorage,callAttempts.current!.attemptKey(username));const key=await attempt.key(payload);if(epoch!==authEpoch.current)throw new Error('登录状态已改变');if(mediaCallId.current)throw new Error('请先结束本设备正在进行的通话');const dialedAt=Date.now();const result=await api<{call:Call;liveness:CallLivenessSnapshot|null}>('/calls/outbound',{...payload,idempotencyKey:key},undefined,{callProtocol:true}).catch(e=>{diag.log('dial.request',{code:errorCode(e)||'error',ms:Date.now()-dialedAt,simId:lineId});throw e;});diag.log('dial.request',{code:'ok',ms:Date.now()-dialedAt,simId:lineId},result.call.id);attempt.confirmed(key);if(epoch!==authEpoch.current)return;setNumber('');try{try{startLiveness(result.call.id,result.liveness,epoch);}catch(error){await endCurrentSessionCall(result.call.id);throw error;}await startMedia(result.call.id);}finally{await refresh();}});} 
 async function historyAction(call:Call,action:'redial'|'sms'|'block'|'delete'){const remote=call.remoteNumber||call.number;if(action==='sms'){if(!canSendSMS(remote,call.simId))return;setSimId(call.simId);setSmsModal({remoteNumber:normalizedDialNumber(remote||''),contactName:call.contactName||null,token:Date.now()});return;}if(action==='redial'){if(!canRedial(remote,call.simId,Boolean(mediaCallId.current)))return;const dest=normalizedDialNumber(remote||'');setSimId(call.simId);setNumber(dest);setTab('通话');await startOutboundCall(call.simId,dest);return;}if(action==='delete'){await run(async()=>{await deleteCallRecord(api,call.id);setContactsEpoch(value=>value+1);await refresh();setCardTarget(current=>current?.callId===call.id?null:current);});return;}if(action==='block'){if(!canBlock(remote)||!remote)return;await run(async()=>{await api('/blocklist',{remoteNumber:remote,sourceCallId:call.id,scope:'call'});setContactsEpoch(value=>value+1);await refresh();});}} 
 /** 报告卡片的回拨/发短信走与记录行完全相同的路径，只是数据来自报告项。 */
 function reportAction(item:ReportItem,action:'redial'|'sms'){
  void historyAction({id:item.callId,simId:item.sim?.id||simId,direction:item.direction,remoteNumber:item.remoteNumber||undefined,contactName:item.contactName,state:'ended',startedAt:item.startedAt},action);
 }
 /** 记录 子视图的 sessionStorage 键，按账号分开；退出登录时一并清掉。 */
 const recordsKey=(view:string,username=user?.username)=>username?`vodog:records:${username}:${view}`:undefined;
 /** Web has no record detail page, so every row opens this card instead (S21 §F 2.2). */
 function openCallCard(call:Call){setError('');setCardTarget({callId:call.id,remoteNumber:call.remoteNumber||call.number,simId:call.simId,contactId:call.contactId,contactName:call.contactName,blocked:isBlockedRow(call),blockedEntryId:call.blockedEntryId,call});markCallSeen(call);}
 function cardChanged(update?:{blocked:boolean;blockedEntryId?:string|null}){
  setContactsEpoch(value=>value+1);
  // The card reports the entry id it just created, so 屏蔽 → 解除 works before any list has reloaded.
  if(update)setCardTarget(current=>current?{...current,blocked:update.blocked,blockedEntryId:update.blockedEntryId??null}:current);
  void refresh().catch(()=>{});
 }
 async function sendSms(remoteNumber:string,messageBody:string){
  const username=user?.username;if(!username)throw new Error('登录状态已改变');
  if(!selected?.online||selected.present===false||selected.smsReady!==true)throw new Error('所选号码的短信能力尚未就绪');
  const requestEpoch=authEpoch.current;
  setBusy(true);setError('');
  try{
   const payload={simId,remoteNumber,body:messageBody};
   const attempt=new OutboundAttempt(sessionStorage,`vodog:sms:${username}`);
   const key=await attempt.key(payload);
   if(requestEpoch!==authEpoch.current)throw new Error('登录状态已改变');
   await api('/sms/outbound',{...payload,idempotencyKey:key});
   attempt.confirmed(key);
   if(requestEpoch===authEpoch.current){try{await refresh();}catch{setConnectionError('短信已受理，记录暂未刷新，正在自动重试。');}}
  }catch(e){
   if(requestEpoch===authEpoch.current)setError(e instanceof Error?e.message:'发送失败');
   throw e;
  }finally{
   if(requestEpoch===authEpoch.current)setBusy(false);
  }
 }
 async function run(action:()=>Promise<void>):Promise<boolean>{if(actionInFlight.current)return false;actionInFlight.current=true;const epoch=authEpoch.current;setBusy(true);setError('');try{await action();return true;}catch(e){if(epoch===authEpoch.current)setError(e instanceof Error?e.message:'请求失败');return false;}finally{actionInFlight.current=false;setBusy(false);}}
 async function refreshAllSettings(){
  const epoch=authEpoch.current;
  setSettingsRefreshStatus('');
  setSettingsReloadToken(value=>value+1);
  try{
   const applied=await refresh();
   if(epoch!==authEpoch.current)return;
   if(applied)setConnectionError('');
   flashConfirmation(setSettingsRefreshStatus,'已请求刷新所有设置；各分组会保留上次结果，并显示本次读取状态。');
  }catch{
   if(epoch!==authEpoch.current)return;
   setConnectionError('号码与通话状态暂时无法刷新；其他设置分组正在分别重试。');
   setSettingsRefreshStatus('刷新请求已完成，但部分状态暂时无法读取；上次成功结果已保留。');
  }
 }
 /** Turnstile token for this attempt; throws the user-facing message when the challenge is still unsolved. */
 function turnstileTokenForSubmit():string|undefined{return passwordTurnstileToken(authConfig,turnstileToken);}
 /** Turnstile tokens are single use, so any failed attempt starts a fresh challenge. */
 function resetTurnstile(){setTurnstileToken(null);setTurnstileReset(v=>v+1);}
 // Label and icon travel together so inserting a tab cannot desynchronise the two lists.
 const tabs:[string,IconName][]=[['通话','phone'],['短信','messages'],['记录','history'],['通讯录','contacts'],['设置','settings'],...(user?.role==='admin'?[['网关','gateways'] as [string,IconName]]:[])];
 const loginActions=loginAvailability(authConfig,turnstileToken,busy);
 if(loading)return <main className="loading">正在连接通信中心…</main>;
 if(!user)return <main className="login">
  <section className="intro">
   <div className="brand"><img src="/icon-192.png" width="28" height="28" alt=""/>VoDog</div>
   <div className="intro-copy">
    <p className="eyebrow">你的号码，随身同行</p><h1>在远方，<br/>也能接起这一通。</h1>
    <p>连接网关设备上的 SIM，在电脑与手机之间管理电话、短信和通话记录。</p>
   </div>
   <div className="login-preview" aria-hidden="true">
    <div className="preview-sims"><span><i/>SIM 1 · 在线</span><span><i/>SIM 2 · 在线</span></div>
    <div className="preview-call"><span className="preview-icon"><UiIcon name="phone"/></span><div><strong>来电</strong><small>经网关转接到这台电脑</small></div><em>接听</em></div>
    <div className="preview-sms"><small>短信 · 刚刚</small><p>您的验证码是 ••••••，5 分钟内有效。</p></div>
   </div>
  </section>
  <section className="login-form">
   <h2>登录通信中心</h2><p>使用你的账号查看已分配的 SIM。</p>
   <form onSubmit={e=>{
    e.preventDefault();const f=new FormData(e.currentTarget);
    void finishPasswordAttempt(()=>run(async()=>{
     const epoch=authEpoch.current;const token=turnstileTokenForSubmit();
     const d=await api<{user:{username:string;role?:string}}>('/auth/login',{username:f.get('username'),password:f.get('password'),platform:'web',deviceName:'Web 浏览器',...(token?{turnstileToken:token}:{})});
     if(epoch!==authEpoch.current)throw new Error('登录状态已改变，请重试。');
     authEpoch.current++;callAttempts.current!.rotate();acceptBrowserSession();setUser(d.user);
    }),resetTurnstile);
   }}>
    <label>用户名<input name="username" autoComplete="username webauthn" required spellCheck={false} value={loginUsername} onChange={event=>setLoginUsername(event.target.value)}/></label>
    <label>密码<input name="password" type="password" autoComplete="current-password" required/></label>
    {authConfig.status==='loading'&&<p className="note" role="status">{authConfig.message}</p>}
    {authConfig.status==='error'&&<div className="error" role="alert"><p>{authConfig.message}</p><button type="button" className="passkey" disabled={busy} onClick={()=>setAuthConfigRetry(value=>value+1)}>重试读取安全验证</button></div>}
    {authConfig.status==='ready'&&authConfig.config.enabled&&<TurnstileWidget siteKey={authConfig.config.siteKey!} onToken={setTurnstileToken} resetKey={turnstileReset}/>}
    <button className="primary" disabled={loginActions.passwordDisabled}>{busy?'请稍候…':'登录'}</button>
   </form>
   {error&&<p className="error" role="alert">{error}</p>}
   <div className="login-divider" aria-hidden="true"><span>或</span></div>
   <button className="passkey login-passkey" disabled={loginActions.passkeyDisabled} onClick={()=>void run(async()=>{
    const epoch=authEpoch.current;const body=passkeyOptionsBody(loginUsername);
    const o=await api<{challengeId:string;options:any}>('/passkeys/authenticate/options',body);
    const response=await startAuthentication({optionsJSON:o.options});
    if(epoch!==authEpoch.current)throw new Error('登录状态已改变，请重试。');
    const d=await api<{user:{username:string;role?:string}}>('/passkeys/authenticate/verify',{challengeId:o.challengeId,response,platform:'web'});
    if(epoch!==authEpoch.current)throw new Error('登录状态已改变，请重试。');
    authEpoch.current++;callAttempts.current!.rotate();acceptBrowserSession();setUser(d.user);
   })}><UiIcon name="key"/>使用通行密钥登录</button>
   <p className="note">账号与 SIM 由网关管理员分配。</p>
  </section>
 </main>;
 return <div className="shell" onPointerDown={()=>incomingRingtone.unlock()} onKeyDown={()=>incomingRingtone.unlock()}><a className="skip-link" href="#main">跳到主要内容</a><aside><div className="brand"><img src="/icon-192.png" width="28" height="28" alt=""/>VoDog</div><nav aria-label="主导航">{tabs.map(([t,icon])=><button key={t} aria-current={tab===t?'page':undefined} onClick={()=>{setTab(t);setError('');}}><UiIcon name={icon}/>{t}<UnreadBadge count={navBadgeCount(badges,t)}/></button>)}</nav><div className="account"><strong>{user.username}</strong><button className="passkey hangup" disabled={busy} onClick={()=>void run(async()=>{await logout();})}>退出登录</button></div></aside><main id="main" className="workspace" onKeyDown={e=>{if(e.key==='Escape'&&document.activeElement instanceof HTMLElement)document.activeElement.blur();}} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('input,textarea,select,button,a')&&document.activeElement instanceof HTMLElement&&document.activeElement.matches('input,textarea,select'))document.activeElement.blur();}}><header><div><p className="eyebrow">随身通信工作台</p><h1>{tab}</h1></div><span className="status" role="status" aria-live="polite">{simLoadStatus==='loading'&&!sims.length?'正在读取 SIM':simLoadStatus==='error'&&!sims.length?'SIM 状态暂不可用':sims.some(s=>s.online)?'网关已连接':'等待网关连接'}</span></header>{tab!=='设置'&&<SimSelector sims={sims} badgeCount={id=>simBadgeCount(badges,id,tab)} allLabel={tab==='记录'?'全部 SIM 卡':undefined} selectedId={tab==='记录'?recordsSimId:simId} status={simLoadStatus} busy={busy} onSelect={tab==='记录'?id=>{setRecordsSimId(id);if(id)setSimId(id);}:setSimId} onRetry={retrySimLoad}/>}{connectionError&&<p className="error" role="status">{connectionError}</p>}{error&&<p className="error" role="alert">{error}</p>}{Boolean(audibleRingingCall(calls))&&!activeMediaCallId&&ringtoneNeedsUnlock&&<p className="note ringtone-unlock" role="status"><button type="button" className="passkey" onClick={()=>incomingRingtone.unlock()}>点击开启来电铃声</button></p>}
 {tab==='通话'&&<TabBoundary><div className="columns call-columns"><section className={'panel dialer '+(controlledCallId?'has-active-call':'')}><div className="panel-heading"><div><h2>{controlledCallId?'当前通话':'拨打电话'}</h2><p className="muted">{controlledCallId?labels[activeCall?.state||'connecting']:'通过所选 SIM 的本地线路拨出'}</p></div>{controlledCallId&&<span className="live-indicator"><i aria-hidden="true"/>{mediaReconnecting&&activeMediaCallId===controlledCallId?'正在重新连接':labels[activeCall?.state||'connecting']}</span>}</div>{controlledCallId?<><div className="active-call-owner" role="status"><strong dir="ltr">{numberWithContact(activeCall?.remoteNumber||activeCall?.number,activeCall?.contactName,'正在接通')}</strong><span>{activeCall?.simLabel||(s=>s?.label||s?.phoneLabel)(sims.find(s=>s.id===activeCall?.simId))||'当前线路'} · Web 浏览器</span></div><div className="in-call-actions"><button className={'mute-call '+(microphoneMuted?'is-muted':'')} aria-pressed={microphoneMuted} disabled={activeMediaCallId!==controlledCallId||!media.current?.hasMicrophone} onClick={()=>{const next=!microphoneMuted;if(!media.current?.setMuted(next)){setError('麦克风尚未连接，请稍后重试。');return;}setMicrophoneMuted(next);setError('');}}><UiIcon name={microphoneMuted?'microphone-off':'microphone'}/>{microphoneMuted?'取消静音':'静音'}</button><button className={'mute-call '+(keypadCallId===controlledCallId?'is-muted':'')} aria-pressed={keypadCallId===controlledCallId} onClick={()=>{setDtmfError('');setKeypadCallId(id=>id===controlledCallId?null:controlledCallId);}}>键盘</button><button className="end-call" disabled={endingCallId===controlledCallId} onClick={()=>void stopOwnedCall(controlledCallId)}><UiIcon name="hangup"/>{endingCallId===controlledCallId?'正在停止…':'停止通话'}</button></div>{keypadCallId===controlledCallId&&<><PhoneKeypad dtmf onDigit={digit=>sendDtmf(controlledCallId,digit)}/>{dtmfError&&<p className="dtmf-error" role="alert">{dtmfError}</p>}</>}</>:<><label className="sr-only" htmlFor="number">电话号码</label><div className="number-entry"><input id="number" name="phone-number" autoComplete="off" inputMode="tel" className="number" value={number} onChange={e=>setNumber(e.target.value)} type="tel" placeholder="输入电话号码…"/><button className="delete-digit" aria-label="删除一位号码" disabled={!number} onClick={()=>setNumber(n=>n.slice(0,-1))}>⌫</button></div><div className="dial-hint-slot"><p className="note dial-hint" role="status" tabIndex={dialHint?0:undefined}>{dialHint||'\u00a0'}</p></div><PhoneKeypad onDigit={digit=>setNumber(n=>n+digit)}/><button className="primary call-button" disabled={busy||!canUseSelectedPhone||!number.trim()||Boolean(occupied)} onClick={()=>void startOutboundCall(simId,number.trim())}>拨打电话</button></>}{!controlledCallId&&occupied&&<OccupancyNotice key={occupied.id} call={occupied} timeZone={sims.find(s=>s.id===occupied.simId)?.timeZone} simLabel={occupied.simLabel||(s=>s?.label||s?.phoneLabel)(sims.find(s=>s.id===occupied.simId))} currentSessionLabel={`${user.username} · 当前浏览器`} busy={busy} onRelease={call=>void releaseOccupiedCall(call as Call)}/>}<p className="note">{controlledCallId?(activeMediaCallId!==controlledCallId?'这通电话尚未结束。当前页面未连接麦克风，可直接停止通话。':busy?'正在连接麦克风与音频…':mediaReconnecting?'网络波动，正在重新连接…':microphoneMuted?'麦克风已静音，对方听不到你的声音。':'麦克风正在传送声音。'):occupied?(canReleaseOccupancy(occupied)?'可先结束该通话，再用此号码拨打。':'请等待这通电话结束，再用此号码拨打。'):!canUseSelectedPhone?'等待所选号码的通话与音频能力就绪。':'使用当前 SIM 拨打电话。'}</p></section><section className="panel recent-calls"><div className="panel-heading"><h2>近期通话</h2>{incomingRingtone.supported&&<button type="button" className="passkey ringtone-mute" aria-pressed={ringtoneMuted} onClick={()=>setRingtoneMuted(v=>!v)}>{ringtoneMuted?'恢复来电铃声':'来电铃声静音'}</button>}</div><div className="recent-call-list"><CallList calls={recentCalls} sims={sims} sessionUsername={user.username} primaryControlledCallId={controlledCallId} mediaCallId={activeMediaCallId} busy={busy} onAction={callAction} onOpenCard={openCallCard} seenIds={seenCallIds}/></div>{recentHistoryPage.totalPages>1&&<nav className="pager" aria-label="近期通话分页"><button type="button" className="passkey" disabled={busy||recentHistoryPage.page<=1} onClick={()=>setRecentPage(recentHistoryPage.page-1)}>上一页</button><span className="muted" role="status">第 {recentHistoryPage.page} / {recentHistoryPage.totalPages} 页 · 共 {recentHistory.length} 条</span><button type="button" className="passkey" disabled={busy||recentHistoryPage.page>=recentHistoryPage.totalPages} onClick={()=>setRecentPage(recentHistoryPage.page+1)}>下一页</button></nav>}</section></div></TabBoundary>}
 {tab==='短信'&&<TabBoundary><Messages onReadIncoming={ids=>void markSmsRead(ids)} request={api} account={user.username} onSent={async()=>{try{await refresh();}catch{setConnectionError('短信已受理，记录暂未刷新，正在自动重试。');}}} messages={messages} simId={simId} simLabel={selected?.phoneLabel||selected?.label||'当前号码'} online={Boolean(selected?.online&&selected.present!==false&&selected.smsReady===true)} busy={busy} timeZone={selected?.timeZone} onDeleteMessages={async ids=>{let result:Awaited<ReturnType<typeof deleteMessagesAndRefresh>>|null=null;const ok=await run(async()=>{result=await deleteMessagesAndRefresh(api,ids,refresh,()=>setConnectionError('删除请求已处理，记录暂未刷新，正在自动重试。'));});return ok?result:null;}} onDeleteThread={async(thread:MessageThread,block:boolean)=>{let result:Awaited<ReturnType<typeof deleteThread>>|null=null;await run(async()=>{result=await deleteThread(api,thread,block);if(result.blocked)setContactsEpoch(value=>value+1);if(!result.ok)throw new Error(result.error);await refresh();});return result;}} onSend={sendSms}/></TabBoundary>}
 {tab==='记录'&&<TabBoundary><><div className="segmented" role="group" aria-label="记录视图">{([['calls','通话记录'],['reports','转录报告'],['blocked','拦截记录']] as const).map(([value,label])=><button key={value} type="button" className={recordsView===value?'selected':''} aria-pressed={recordsView===value} onClick={()=>setRecordsView(value)}>{label}</button>)}</div>
  {/* DESIGN.md：记录页必须写明范围。S64：顶部 SIM 条（含「全部 SIM 卡」，默认）同时限定通话记录、转录报告与拦截记录。 */}
  <p className="note">显示：{recordsSim?`${recordsSim.phoneLabel||recordsSim.label||'未命名号码'} 的记录`:'全部号码'}</p>
  {recordsView==='calls'?<CallHistoryPanel request={api} simId={recordsSimId} sims={sims} sessionUsername={user.username} mediaCallId={activeMediaCallId} busy={busy} reloadToken={contactsEpoch+historyLive} storageKey={recordsKey('calls')} onHistoryAction={historyAction} onOpenCard={openCallCard} seenIds={seenCallIds}/>
   :recordsView==='reports'?<CallReports simId={recordsSimId} timeZone={(recordsSim||selected)?.timeZone} request={api} busy={busy} mediaLive={Boolean(activeMediaCallId)} reloadToken={contactsEpoch} storageKey={recordsKey('reports')} onRedial={item=>reportAction(item,'redial')} onSms={item=>reportAction(item,'sms')} onChanged={()=>cardChanged()} onOpen={item=>markCallSeen({id:item.callId,simId:item.sim.id,direction:item.direction,state:item.endedAt?'ended':'active',answeredAt:item.answeredAt,answeredByPlatform:item.answeredByPlatform??undefined,conflictDisposition:item.conflictDisposition,internal:item.internal})} seenIds={seenCallIds}/>
   :<InterceptionsPanel request={api} busy={busy} simId={recordsSimId} sims={sims} timeZone={(recordsSim||selected)?.timeZone} reloadToken={contactsEpoch} storageKey={recordsKey('blocked')} onChanged={()=>setContactsEpoch(value=>value+1)} onOpenRow={row=>{setError('');setCardTarget({remoteNumber:row.remoteNumber,simId:row.simId||simId,contactId:row.contactId,blocked:row.blocked,blockedEntryId:row.blockedEntryId});}}/>}</></TabBoundary>}
 {tab==='通讯录'&&<TabBoundary>{smsCompose?<div className="contacts-with-sms"><ContactsPanel busy={busy} run={run} request={api} createFor={contactDraftRequest} editFor={contactEditRequest} reloadToken={contactsEpoch} onCreateConsumed={()=>setContactDraftRequest(null)} onEditConsumed={()=>setContactEditRequest(null)} onOpenNumber={(remoteNumber,contact)=>{setError('');setCardTarget({remoteNumber,simId,contactId:contact.id,contactName:contact.displayName,blocked:contact.blocked,contact});}} onChanged={()=>cardChanged()}/><SmsCompose request={api} account={user.username} onSent={async()=>{try{await refresh();}catch{setConnectionError('短信已受理，记录暂未刷新，正在自动重试。');}}} requestToken={smsCompose.token} messages={messages} simId={simId} simLabel={selected?.phoneLabel||selected?.label||'当前号码'} online={Boolean(selected?.online&&selected.present!==false&&selected.smsReady===true)} busy={busy} timeZone={selected?.timeZone} remoteNumber={smsCompose.remoteNumber} contactName={smsCompose.contactName} onSend={sendSms} onClose={()=>setSmsCompose(null)}/></div>:<ContactsPanel busy={busy} run={run} request={api} createFor={contactDraftRequest} editFor={contactEditRequest} reloadToken={contactsEpoch} onCreateConsumed={()=>setContactDraftRequest(null)} onEditConsumed={()=>setContactEditRequest(null)} onOpenNumber={(remoteNumber,contact)=>{setError('');setCardTarget({remoteNumber,simId,contactId:contact.id,contactName:contact.displayName,blocked:contact.blocked,contact});}} onChanged={()=>cardChanged()}/>}</TabBoundary>}
 {tab==='网关'&&<TabBoundary><AdminPanel/></TabBoundary>}
 {tab==='设置'&&<TabBoundary><section className="panel settings"><h2 className="settings-group-title">通用设置</h2><p className="muted">对账号下所有 SIM 生效。</p><SettingsOverview username={user.username} role={user.role} sims={sims} busy={busy} refreshStatus={settingsRefreshStatus} reloadToken={settingsReloadToken} onRefresh={()=>void run(refreshAllSettings)}/><hr/><VoiceProviderPanel busy={busy} run={run} request={api} reloadToken={settingsReloadToken}/><hr/><h2>通话网络</h2><label>此浏览器的连接方式<select value={transport} onChange={e=>setTransport(e.target.value as 'udp'|'tls')}><option value="udp">标准连接（优先低延迟）</option><option value="tls">兼容连接（适合受限网络）</option></select></label><p className="note">此选择只影响当前 Web 浏览器的通话音频连接；账号和网关上的共同设置不会改变。</p><hr/><BlocklistPanel request={api} busy={busy} reloadToken={settingsReloadToken} onChanged={()=>setContactsEpoch(value=>value+1)}/><button type="button" className="passkey" onClick={()=>{setRecordsView('blocked');setTab('记录');}}>查看拦截记录</button><hr/><PasskeyPanel busy={busy} run={run} request={api} reloadToken={settingsReloadToken}/><hr/><GatewayPowerPanel busy={busy} run={run} request={api} reloadToken={settingsReloadToken}/>
 <hr/><h2 className="settings-group-title">SIM 卡设置</h2><p className="muted">以下设置只作用于所选 SIM 卡，修改后需保存才生效。</p><SimSelector sims={sims} selectedId={simId} status={simLoadStatus} busy={busy} onSelect={id=>{if(id!==simId&&(simDraftsDirty.notes||simDraftsDirty.reception))setPendingSimSwitch(id);else{setPendingSimSwitch(null);setSimId(id);}}} onRetry={retrySimLoad}/>{pendingSimSwitch!==null&&<ConfirmAction busy={busy} prompt="当前 SIM 卡有未保存的设置，切换后这些修改将丢失。" confirmLabel="放弃修改并切换" onConfirm={()=>{if(sims.some(s=>s.id===pendingSimSwitch))setSimId(pendingSimSwitch);setPendingSimSwitch(null);}} onCancel={()=>setPendingSimSwitch(null)}/>}{!selected&&simLoadStatus==='ready'&&<p className="note">当前账号还没有分配 SIM；上方通用设置仍可使用。</p>}{!selected&&simLoadStatus==='loading'&&<p className="note">正在读取当前账号的 SIM；上方通用设置仍可使用。</p>}{!selected&&simLoadStatus==='error'&&<p className="note">暂时无法确认当前账号的 SIM 分配；上次读取结果已保留，上方通用设置仍可使用。</p>}{selected&&<SimNotesForm sim={selected} busy={busy} onDirtyChange={d=>setSimDraftsDirty(v=>({...v,notes:d}))}
  onSubmit={async(label,phoneLabel,expectedVersion)=>{let saved:{version:number;label:string;phoneLabel:string|null}|null=null;const epoch=authEpoch.current;const ok=await run(async()=>{const accepted=await acceptSettingsMutation(async()=>{const result=await api<{sim:{version:number;label:string;phoneLabel:string|null}}>(`/sims/${encodeURIComponent(selected.id)}`,{label,phoneLabel,expectedVersion},'PUT');if(epoch!==authEpoch.current)throw new Error('登录状态已改变');return result.sim;},refresh,()=>{if(epoch===authEpoch.current)setConnectionError('号码备注已保存，页面状态暂未刷新，正在自动重试。');});if(epoch===authEpoch.current)saved=accepted;});return ok&&epoch===authEpoch.current?saved:null;}}
  loadLatest={async()=>{const latest=await loadLatestAssignedSim(selected.id);if(latest.version===undefined)throw new Error('服务器未返回号码版本。');return {version:latest.version,label:latest.label||'',phoneLabel:latest.phoneLabel||null};}}/>}
 {selected&&<hr/>}{selected&&<SimReceptionForm sim={selected} busy={busy} status={submittedSettingStatus} onDirtyChange={d=>setSimDraftsDirty(v=>({...v,reception:d}))}
  onSubmit={async(nextMode,nextSeconds,expectedVersion)=>{let saved:{version:number;mode:string;timeoutSeconds:number}|null=null;const epoch=authEpoch.current;const ok=await run(async()=>{const accepted=await acceptSettingsMutation(async()=>{const result=await api<{settings:{version:number;mode:string;timeoutSeconds:number}}>(`/sims/${encodeURIComponent(selected.id)}/settings`,{mode:nextMode,timeoutSeconds:nextSeconds,expectedVersion},'PUT');if(epoch!==authEpoch.current)throw new Error('登录状态已改变');setSettingsSubmission({simId:selected.id,target:result.settings.version,submittedObservation:simsObservation.current,submittedAt:Date.now()});return result.settings;},refresh,()=>{if(epoch===authEpoch.current)setConnectionError('接听设置已保存，页面状态暂未刷新，正在自动重试。');});if(epoch===authEpoch.current)saved=accepted;});return ok&&epoch===authEpoch.current?saved:null;}}
  loadLatest={async()=>{const latest=await loadLatestAssignedSim(selected.id);return {version:latest.settings.version,mode:latest.settings.mode,timeoutSeconds:latest.settings.timeoutSeconds};}}/>}
 <hr/><button className="passkey hangup" disabled={busy} onClick={()=>void run(async()=>{await logout();})}>退出当前账号</button></section></TabBoundary>}
 {liveCardTarget&&<ContactCard key={liveCardTarget.callId||liveCardTarget.contactId||liveCardTarget.remoteNumber||'card'} target={liveCardTarget} contact={liveCardTarget.contact??null} busy={busy} mediaLive={Boolean(activeMediaCallId)} request={api} run={run}
  onClose={()=>setCardTarget(null)}
  onMissing={message=>{setCardTarget(null);setError(message);}}
  onCall={target=>{const dest=normalizedDialNumber(target.remoteNumber||'');const line=target.simId||simId;if(!dest||!line)return;setCardTarget(null);setSimId(line);setNumber(dest);setTab('通话');void startOutboundCall(line,dest);}}
  onSms={target=>{const dest=normalizedDialNumber(target.remoteNumber||'');const line=target.simId||simId;if(!dest||!line)return;setCardTarget(null);setSimId(line);const fromContacts=liveCardTarget?.contact;if(fromContacts){setSmsCompose({simId:line,remoteNumber:dest,contactName:fromContacts.displayName||null,token:Date.now()});setTab('通讯录');}else{setSmsModal({remoteNumber:dest,contactName:target.contactName||null,token:Date.now()});}}}
  onCreateContact={remoteNumber=>{setCardTarget(null);setContactDraftRequest({remoteNumber,token:Date.now()});setTab('通讯录');}}
  onEdit={contact=>{setCardTarget(null);setContactEditRequest({contact,token:Date.now()});setTab('通讯录');}}
  media={mediaCall&&<><div className="record-media-actions" role="group" aria-label="录音与转录"><CallRecording callId={mediaCall.id} timeZone={gatewayDisplayTimeZone(mediaCall.gatewayTimeZone,mediaSim?.timeZone)} request={api} preferPixelSource={preferPixelSource(mediaCall)} ownerJoinedLocal={mediaCall.ownerJoinedLocal} gatewayKind={mediaCall.gatewayKind??mediaSim?.gatewayKind}/><CallTranscript callId={mediaCall.id} request={api}/>{aiAnsweredCall(mediaCall)&&<AiTranscriptToggle callId={mediaCall.id} request={api} labels={AI_TRANSCRIPT_LABELS}/>}</div></>} onChanged={cardChanged}/>}
 {smsModal&&<div className="modal-backdrop sms-modal" onPointerDown={event=>{if(event.target===event.currentTarget)setSmsModal(null);}}><SmsCompose request={api} account={user.username} onSent={async()=>{try{await refresh();}catch{setConnectionError('短信已受理，记录暂未刷新，正在自动重试。');}}} requestToken={smsModal.token} messages={messages} simId={simId} simLabel={selected?.phoneLabel||selected?.label||'当前号码'} online={Boolean(selected?.online&&selected.present!==false&&selected.smsReady===true)} busy={busy} timeZone={selected?.timeZone} remoteNumber={smsModal.remoteNumber} contactName={smsModal.contactName} onSend={sendSms} onClose={()=>setSmsModal(null)}/></div>}
 </main></div>;
}

type Gateway={id:string;name:string;controlEnabled:boolean;telephonyReady:boolean;smsReady:boolean;mediaReady:boolean;lastSeenAt?:string;deviceEpoch?:number;timeZone?:string|null;kind?:string|null};
type AdminSim={id:string;gatewayId:string;slotIndex:number|null;label:string;phoneLabel?:string;present?:boolean;ownerUserId:string|null;version:number;assignmentPending:boolean};
function AdminPanel(){
 const [gatewayFilter,setGatewayFilter]=useState('');
 const epoch=useRef(0);
 const [gateways,setGateways]=useState<Gateway[]>([]),[users,setUsers]=useState<{id:string;username:string}[]>([]),[sims,setSims]=useState<AdminSim[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[pair,setPair]=useState<{code:string;expiresAt:string;timeZone:string}|null>(null),[confirmDeleteId,setConfirmDeleteId]=useState<string|null>(null);
 async function refresh(){const captured=epoch.current;const [g,u,s]=await Promise.all([api<{items:Gateway[]}>('/admin/gateways'),api<{items:{id:string;username:string}[]}>('/admin/users'),api<{items:AdminSim[]}>('/admin/sims')]);if(captured!==epoch.current)return;setGateways(g.items);setUsers(u.items);setSims(s.items);}
 useReportedError('网关','banner',error);
 useVisibleRefresh(async()=>{try{await refresh();setError('');}catch(e){setError(e instanceof Error?e.message:'刷新失败');}},5000,true);
 useEffect(()=>()=>{epoch.current++;},[]);
 async function act(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
 return <div className="columns"><section className="panel"><h2>网关设备</h2><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void act(async()=>{await api('/admin/gateways',{name:f.get('name')});});}}><label>设备名称<input name="name" placeholder="例如：家中的网关" required maxLength={120}/></label><button className="primary" disabled={busy}>添加网关</button></form>{gateways.map(g=><article className="record" key={g.id}><strong>{g.name}</strong><code className="gateway-tag">{gatewayTag(g.id,g.kind)}</code><small>最近联络：{g.lastSeenAt?formatCompactCallDate(g.lastSeenAt,gatewayDisplayTimeZone(g.timeZone)):'尚未连接'} · 连接代次 {g.deviceEpoch??0}</small><p>{g.controlEnabled?'总控已开启':'总控未开启'} · {g.telephonyReady&&g.mediaReady?'通话能力就绪':'通话尚未就绪'} · {g.smsReady?'短信已就绪':'短信尚未就绪'}</p>{confirmDeleteId===g.id?<ConfirmAction busy={busy} prompt={GATEWAY_DELETE_PROMPT} confirmLabel="确认删除" onConfirm={()=>void act(async()=>{await api(`/admin/gateways/${g.id}`,undefined,'DELETE');setConfirmDeleteId(null);})} onCancel={()=>setConfirmDeleteId(null)}/>:<div className="record-actions"><button type="button" className="passkey" aria-label={`生成配对码 ${g.name}`} disabled={busy} onClick={()=>void act(async()=>{const r=await api<{pairingCode:{code:string;expiresAt:string}}>(`/admin/gateways/${g.id}/pairing-codes`,{});setPair({...r.pairingCode,timeZone:gatewayDisplayTimeZone(g.timeZone)});})}>生成配对码</button><button type="button" className="passkey hangup" aria-label={`删除网关 ${g.name}`} disabled={busy} onClick={()=>setConfirmDeleteId(g.id)}>删除网关</button></div>}</article>)}{pair&&<div className="pairing" role="status"><strong>在网关设备上输入此配对码</strong><code>{pair.code}</code><small>有效至 {formatCompactClock(pair.expiresAt,pair.timeZone)}，只能使用一次。</small><button className="passkey" onClick={()=>setPair(null)}>隐藏配对码</button></div>}</section><section className="panel"><h2>号码与账号</h2><p className="muted">每个号码可独立分配；设备标签始终唯一，设备名称可以自定义。</p><label>筛选设备<select value={gatewayFilter} onChange={e=>setGatewayFilter(e.target.value)}><option value="">全部网关设备（{gateways.length}）</option>{gateways.map(g=><option key={g.id} value={g.id}>{g.name} · {g.id.slice(0,8)}</option>)}</select></label>{sims.filter(s=>!gatewayFilter||s.gatewayId===gatewayFilter).map(s=><form className="record" key={`${s.id}-${s.version}`} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void act(async()=>{await api(`/admin/sims/${s.id}/owner`,{ownerUserId:f.get('owner')||null,expectedVersion:s.version},'PUT');});}}><strong>{s.phoneLabel||s.label||'未命名号码'}</strong><span>{gateways.find(g=>g.id===s.gatewayId)?.name||'网关'} · {s.present===false?'未待机，保留归属及历史':'当前已识别'}</span><code className="gateway-tag">{gatewayTag(s.gatewayId,gateways.find(g=>g.id===s.gatewayId)?.kind)}</code><label>分配给<select name="owner" defaultValue={s.ownerUserId||''}><option value="">暂不分配</option>{users.map(u=><option value={u.id} key={u.id}>{u.username}</option>)}</select></label>{s.assignmentPending&&<p>卡片已变化，需要重新确认账号。</p>}<button className="primary" aria-label={`保存分配 ${s.phoneLabel||s.label||'未命名号码'}`} disabled={busy}>保存分配</button></form>)}{!sims.length&&<Empty text="尚未收到 SIM 信息" detail="先在网关设备上完成配对并授予电话状态权限。"/>}</section>{error&&<p className="error" role="alert">{error}</p>}</div>;
}

/** `dtmf` = 通话中按键：没有长按加号（DTMF 只有 [0-9*#]），其余完全一样。 */
function PhoneKeypad({onDigit,dtmf}:{onDigit:(digit:string)=>void;dtmf?:boolean}){
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),longPressed=useRef(false);
 const cancel=()=>{clearTimeout(timer.current);timer.current=undefined;};
 useEffect(()=>()=>cancel(),[]);
 return <div className="keypad">{'123456789*0#'.split('').map(k=><button key={k} data-static aria-label={k==='0'&&!dtmf?'0，长按输入加号':k} onPointerDown={e=>{if(k!=='0'||dtmf)return;longPressed.current=false;e.currentTarget.setPointerCapture(e.pointerId);timer.current=setTimeout(()=>{longPressed.current=true;onDigit('+');},500);}} onPointerUp={cancel} onPointerCancel={()=>{cancel();longPressed.current=false;}} onClick={()=>{if(k==='0'&&longPressed.current){longPressed.current=false;return;}dialTone.play(k);onDigit(k);}}>{k}</button>)}</div>;
}
if(typeof document!=='undefined'){const root=document.getElementById('root');if(root)createRoot(root,{
 onUncaughtError:(error,info)=>diag.log('app.crash',{where:'uncaught',message:String(error).slice(0,300),stack:info.componentStack?.slice(0,300)}),
 onCaughtError:(error,info)=>diag.log('app.crash',{where:'boundary',message:String(error).slice(0,300),stack:info.componentStack?.slice(0,300)}),
}).render(<React.StrictMode><App/></React.StrictMode>);}
