import React,{useEffect,useRef,useState} from 'react';
import {MAX_SMS_SELECTION,messageThreads,type MessageThread,type SmsDeleteResult,type ThreadDeleteResult,type ThreadMessage} from './message-threads';
import {numberWithContact,samePhoneNumber,type ApiRequest} from './contacts';
import {smsStatusLabel} from './sms-status';
import {useSmsDrafts} from './sms-drafts';
import {SmsRecipients} from './sms-recipients';
import {flashConfirmation} from './ui-error.ts';
import {startSmsRecipients,type SmsRecipient} from './sms-recipient-policy';
import {enqueueSmsBatch} from './sms-send';
import {ConfirmAction} from './confirm-action';
import {isOpenableUrl,smsLinkSegments} from './sms-links';
import {CONVERSATION_DELETE_AND_BLOCK_PROMPT,CONVERSATION_DELETE_PROMPT,MESSAGES_DELETE_CONFIRM_LABEL,MESSAGES_DELETE_PROMPT} from './confirm-copy';
import {threadHasUnread} from './badges';
import {diag} from './diag';
import {verificationCode} from './sms-code';
import {UiIcon} from './icons';
import {formatCompactCallDate,formatCompactThreadDate,gatewayDisplayTimeZone} from './gateway-time';
/**
 * `onDeleteMessages`/`onDeleteThread` answer `true` only when the server actually accepted (S30 §2): a failed
 * 屏蔽 must leave the reader inside the conversation, looking at the messages that are still there.
 */
type RecipientProps={request?:ApiRequest;account?:string;onSent?:(items:ThreadMessage[])=>void|Promise<void>};
type Props=RecipientProps&{messages:ThreadMessage[];simId:string;simLabel:string;online:boolean;busy:boolean;timeZone?:string|null;composeTo?:{simId:string;remoteNumber:string;token:number}|null;onComposeConsumed?:()=>void;onSend:(number:string,body:string)=>Promise<void>;onDeleteMessages?:(ids:string[])=>Promise<SmsDeleteResult|boolean|null>;onDeleteThread?:(thread:MessageThread,block:boolean)=>Promise<ThreadDeleteResult|boolean|null>;
 /** S67: ids of incoming messages in the open conversation, each sent once per mount; the server ignores already-read ids. */
 onReadIncoming?:(ids:string[])=>void;
 /** Presentation only: line chip for 「从 … 发送」 and header shortcuts into the existing call/contact flows. */
 fromChip?:React.ReactNode;onCall?:(number:string)=>void;onOpenContact?:(number:string,contactName:string|null)=>void};
export function Messages(props:Props){return <MessagesBody key={props.account||'session'} {...props}/>;}
function MessagesBody({request,account,onSent,messages,simId,simLabel,online,busy,timeZone,composeTo=null,onComposeConsumed,onSend,onDeleteMessages,onDeleteThread,onReadIncoming,fromChip,onCall,onOpenContact}:Props){
 const [query,setQuery]=useState('');const [copied,setCopied]=useState<string|null>(null);
 function copyCode(code:string){void navigator.clipboard?.writeText(code).then(()=>{setCopied(code);setTimeout(()=>setCopied(c=>c===code?null:c),2000);},()=>{});}
 const zone=gatewayDisplayTimeZone(timeZone);
 const [recipients,setRecipients]=useState<SmsRecipient[]>([]);
 const [pendingRecipient,setPendingRecipient]=useState(false);
 const [composeRevision,setComposeRevision]=useState(0);
 const [sending,setSending]=useState(false);const submitting=useRef(false);
 const [sendNotice,setSendNotice]=useState('');
 busy=busy||sending;
 const [threadKey,setThreadKey]=useState<string|null>(null),[composing,setComposing]=useState(false);
 const [focusFailedDraft,setFocusFailedDraft]=useState<string|null>(null);
 const [selecting,setSelecting]=useState(false),[selectedIds,setSelectedIds]=useState<ReadonlySet<string>>(new Set<string>());
 const [confirming,setConfirming]=useState<'selected'|'thread'|'block'|null>(null);
 const [deleteNotice,setDeleteNotice]=useState('');
 const [blockedThreadKey,setBlockedThreadKey]=useState<string|null>(null);
 const [drafts,setDrafts]=useSmsDrafts(account);
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const context=useRef(0),previousSim=useRef(simId);
 if(previousSim.current!==simId){context.current++;previousSim.current=simId;}
 useEffect(()=>()=>{context.current++;},[]);
 const threads=messageThreads(messages.filter(m=>m.simId===simId));
 const selected=threads.find(t=>t.key===threadKey);
 const draftKey=JSON.stringify([simId,composing?'new':selected?.key||'none']);
 const draft=drafts[draftKey]||{number:composing?'':selected?.number||'',body:''};
 function update(values:Partial<typeof draft>){setDrafts(old=>({...old,[draftKey]:{...draft,...values}}));}
 const active=composing||Boolean(selected);
 const readSent=useRef(new Set<string>());
 const unsentIncoming=!composing&&selected?selected.messages.filter(m=>m.direction==='incoming'&&!readSent.current.has(m.id)).map(m=>m.id).join(','):'';
 useEffect(()=>{if(!unsentIncoming||!onReadIncoming)return;const ids=unsentIncoming.split(',');for(const id of ids)readSent.current.add(id);onReadIncoming(ids);},[unsentIncoming]);
 const canReply=composing||selected?.messages.at(-1)?.canReply!==false;
 const bottom=useRef<HTMLDivElement>(null);
 const composer=useRef<HTMLTextAreaElement>(null);const activeDraft=useRef(draftKey);activeDraft.current=draftKey;
 useEffect(()=>{if(!busy&&focusFailedDraft===draftKey){composer.current?.focus();composer.current?.scrollIntoView({block:'center',behavior:'instant'});setFocusFailedDraft(null);}},[busy,focusFailedDraft,draftKey]);
 useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[selected?.messages.at(-1)?.id]);
 const consumedCompose=useRef<string|null>(null);
 useEffect(()=>{
  if(!composeTo||composeTo.simId!==simId)return;
  const intent=JSON.stringify([composeTo.simId,composeTo.remoteNumber,composeTo.token]);
  if(consumedCompose.current===intent)return;
  consumedCompose.current=intent;
  const key=JSON.stringify([simId,'new']);
  setComposing(true);
  setRecipients(startSmsRecipients(composeTo.remoteNumber));setPendingRecipient(false);setComposeRevision(value=>value+1);
  setThreadKey(null);
  setDrafts(old=>({...old,[key]:{number:composeTo.remoteNumber,body:old[key]?.body||''}}));
  onComposeConsumed?.();
 },[composeTo,simId,onComposeConsumed]);
 // Leaving the conversation (or the SIM) must never carry a stale selection into the next one.
 useEffect(()=>{setSelecting(false);setSelectedIds(new Set<string>());setConfirming(null);},[threadKey,simId,composing]);
 const picked=selected?selected.messages.filter(m=>selectedIds.has(m.id)):[];
 const pickedCount=picked.length;
 function toggleMessage(id:string){setSelectedIds(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else if(next.size<MAX_SMS_SELECTION)next.add(id);else setDeleteNotice(`每次最多选择 ${MAX_SMS_SELECTION} 条短信`);return next;});}
 function leaveSelection(){setSelecting(false);setSelectedIds(new Set<string>());setConfirming(null);}
 const showActions=Boolean(selected&&!composing&&(onDeleteMessages||onDeleteThread));
 function deleteSelected(){
  const thread=selected;if(!thread||!onDeleteMessages||!pickedCount)return;
  const ids=picked.map(m=>m.id);
  const wholeThread=ids.length===thread.messages.length;
  void onDeleteMessages(ids).then(result=>{setConfirming(null);if(!result)return;if(result===true){leaveSelection();if(wholeThread)setThreadKey(null);return;}if(result.skipped.length){setSelectedIds(new Set(result.skipped.map(row=>row.id)));const inflight=result.skipped.filter(row=>row.reason==='in_flight').length;setDeleteNotice(`已删除 ${result.deleted} 条；${result.skipped.length} 条未删除${inflight?`（其中 ${inflight} 条仍在发送）`:''}，已保留供重试。`);return;}leaveSelection();flashConfirmation(setDeleteNotice,`已删除 ${result.deleted} 条短信。`);if(wholeThread)setThreadKey(null);});
 }
 function deleteThread(block:boolean){
  const thread=selected;if(!thread||!onDeleteThread)return;
  const shouldBlock=block&&blockedThreadKey!==thread.key;
  void onDeleteThread(thread,shouldBlock).then(result=>{setConfirming(null);if(!result)return;if(result===true){setBlockedThreadKey(null);leaveSelection();setThreadKey(null);return;}if(result.blocked&&!result.ok){setBlockedThreadKey(thread.key);{const notice=result.error||'号码已屏蔽，但对话删除失败，请重试';setDeleteNotice(notice);diag.uiError('短信','sms.thread.delete',notice);}return;}if(result.ok&&result.skipped.length){if(result.blocked)setBlockedThreadKey(thread.key);setDeleteNotice(`仍有 ${result.skipped.length} 条短信正在发送，已保留供重试。`);return;}if(result.ok){setBlockedThreadKey(null);leaveSelection();setThreadKey(null);}});
 }
 return <section className={'messages-app '+(active?'has-conversation':'')} aria-label="短信会话">
  <div className="thread-list"><div className="messages-heading"><h2>信息</h2><button aria-label="新短信" disabled={!simId||busy} onClick={()=>{setComposing(true);setThreadKey(null);setRecipients([]);setPendingRecipient(false);setComposeRevision(value=>value+1);setSendNotice('');}}><UiIcon name="compose" size={18}/>新短信</button></div>
   <label className="thread-search"><UiIcon name="search" size={18}/><span className="sr-only">搜索短信</span><input type="search" placeholder="搜索会话、号码或内容" value={query} onChange={e=>setQuery(e.target.value)}/></label>
   {threads.length===0?<div className="empty"><h3>暂无短信</h3><p>选择号码后，开始一段对话。</p></div>:threads.filter(t=>{const q=query.trim().toLowerCase();return !q||[t.number,t.contactName,...t.messages.map(m=>m.body)].some(v=>v?.toLowerCase().includes(q));}).map(t=>{const last=t.messages.at(-1)!;const code=verificationCode(last.body);const unread=!(!composing&&selected?.key===t.key)&&threadHasUnread(t.messages,readSent.current);return <div className="thread-item" key={t.key}><button className={'thread-row '+(!composing&&selected?.key===t.key?'active':'')} onClick={()=>{setThreadKey(t.key);setComposing(false);}} aria-current={!composing&&selected?.key===t.key?'true':undefined}><span className="unread-dot thread-unread-dot" data-on={unread||undefined}>{unread&&<span className="sr-only">未读</span>}</span><span className="contact-avatar" aria-hidden="true">{t.contactName?t.contactName.slice(0,1):t.number?t.number.slice(-2):'?'}</span><span className="thread-preview"><strong>{numberWithContact(t.number,t.contactName)}</strong><span>{last.body}</span><small>{smsStatusLabel(last)}</small></span><time dateTime={last.createdAt}>{formatCompactThreadDate(last.createdAt,zone)}</time></button>{code&&<button type="button" className="code-copy" onClick={()=>copyCode(code)}><UiIcon name="copy" size={16}/>{copied===code?'已复制':'复制验证码'} <span className="num">{code}</span></button>}</div>})}
  </div>
  <div className="conversation">{!active?<div className="empty"><h3>选择一段对话</h3><p>使用 {simLabel} 接收和发送短信。</p></div>:<>
   <header className="conversation-heading"><button className="conversation-back" aria-label="返回短信列表" onClick={()=>{setComposing(false);setThreadKey(null);}}>‹ 信息</button><div><h2>{composing?'新短信':numberWithContact(selected?.number,selected?.contactName)}</h2><small dir="ltr">{!composing&&selected?.contactName?selected.number:`使用 ${simLabel}`}</small></div>{!composing&&selected?.number&&<div className="conversation-tools">{onCall&&<button type="button" className="icon-button call" aria-label={`拨打 ${selected.number}`} onClick={()=>onCall(selected.number)}><UiIcon name="phone" size={18}/></button>}{onOpenContact&&<button type="button" className="icon-button" aria-label="联系人信息" onClick={()=>onOpenContact(selected.number,selected.contactName)}><UiIcon name="contacts" size={18}/></button>}</div>}</header>
   {showActions&&<div className="conversation-actions">
    <div className="conversation-action-row">
     {selecting
      ?<>
       <span className="selection-count" role="status">已选 {pickedCount} 条</span>
       <button type="button" className="passkey" disabled={busy||!selected!.messages.length} onClick={()=>{const ids=selected!.messages.slice(0,MAX_SMS_SELECTION).map(m=>m.id);setSelectedIds(new Set(ids));if(selected!.messages.length>MAX_SMS_SELECTION)setDeleteNotice(`已选择前 ${MAX_SMS_SELECTION} 条；每次最多删除 ${MAX_SMS_SELECTION} 条。`);}}>全选</button>
       <button type="button" className="passkey" disabled={busy||!pickedCount} onClick={()=>setSelectedIds(new Set<string>())}>清空</button>
       {onDeleteMessages&&<button type="button" className="passkey hangup" disabled={busy||!pickedCount} onClick={()=>setConfirming('selected')}>删除所选（{pickedCount}）</button>}
       <button type="button" className="passkey" disabled={busy} onClick={leaveSelection}>完成</button>
      </>
      :<>
       {onDeleteMessages&&<button type="button" className="passkey" disabled={busy||!selected!.messages.length} onClick={()=>{setConfirming(null);setSelecting(true);}}>选择</button>}
       {onDeleteThread&&<button type="button" className="passkey hangup" disabled={busy} onClick={()=>setConfirming('thread')}>删除对话</button>}
       {onDeleteThread&&<button type="button" className="passkey hangup" disabled={busy} onClick={()=>setConfirming('block')}>删除并屏蔽</button>}
      </>}
    </div>
    {confirming&&<ConfirmAction
     busy={busy}
     prompt={confirming==='selected'?MESSAGES_DELETE_PROMPT:confirming==='thread'?CONVERSATION_DELETE_PROMPT:CONVERSATION_DELETE_AND_BLOCK_PROMPT}
     confirmLabel={MESSAGES_DELETE_CONFIRM_LABEL}
     onConfirm={()=>{if(confirming==='selected')deleteSelected();else deleteThread(confirming==='block');}}
     onCancel={()=>setConfirming(null)}
    />}
   </div>}
   {deleteNotice&&<p className="note" role="status">{deleteNotice}</p>}
   {composing&&<SmsRecipients key={composeRevision} value={recipients} onChange={setRecipients} onPendingChange={setPendingRecipient} request={request} busy={busy}/>}
   {sendNotice&&<p className="note" role="status">{sendNotice}</p>}
   <div className={'message-bubbles '+(selecting?'selecting':'')} aria-live="polite">{!composing&&selected?.messages.map(m=>{
    const chosen=selectedIds.has(m.id);
    // In selection mode the whole bubble is the hit target; the box only mirrors it, so one tap never toggles twice.
    const selectable=selecting?{role:'checkbox','aria-checked':chosen,tabIndex:0,onClick:()=>toggleMessage(m.id),onKeyDown:(event:React.KeyboardEvent)=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();toggleMessage(m.id);}}}:{};
    return <article className={'message-bubble '+(m.direction==='outgoing'?'outgoing':'incoming')+(chosen&&selecting?' selected':'')} key={m.id} {...selectable}>{selecting&&<input type="checkbox" className="message-select" checked={chosen} readOnly tabIndex={-1} aria-hidden="true"/>}<SmsBody body={m.body} plain={selecting}/>{!selecting&&(code=>code&&<button type="button" className="code-copy" onClick={()=>copyCode(code)}><UiIcon name="copy" size={16}/>{copied===code?'已复制':'复制验证码'} <span className="num">{code}</span></button>)(verificationCode(m.body))}<small>{formatCompactCallDate(m.createdAt,zone)} · {smsStatusLabel(m)}</small></article>;
   })}<div ref={bottom}/></div>
   <form className="message-composer" onSubmit={e=>{
    e.preventDefault();
    const numbers=composing?recipients.map(item=>item.number):[draft.number];
    if(submitting.current||(composing&&pendingRecipient)||busy||!online||!canReply||!numbers.length||numbers.length>100||!draft.body.trim())return;
    const epoch=context.current;const sentBody=draft.body;const sentNumber=draft.number;const sentRecipients=recipients;
    submitting.current=true;setSending(true);setSendNotice('');
    const send=async()=>{
     if(numbers.length===1)await onSend(numbers[0],sentBody);
     else {if(!request||!account)throw new Error('请重新载入页面以发送多收件人短信');await enqueueSmsBatch({request,account,simId,recipients:numbers,body:sentBody,storage:sessionStorage,onSent,isCurrent:()=>mounted.current});}
    };
    void send().then(()=>{
     setDrafts(old=>{const latest=old[draftKey];return !latest||(latest.body===sentBody&&latest.number===sentNumber)?{...old,[draftKey]:{number:sentNumber,body:''}}:old;});
     if(!mounted.current||epoch!==context.current)return;
     if(composing)setRecipients(current=>current===sentRecipients?[]:current);
     flashConfirmation(setSendNotice,`已受理 ${numbers.length} 个号码，等待发送。`);
    }).catch(error=>{if(epoch===context.current&&activeDraft.current===draftKey){{const notice=error instanceof Error?error.message:'发送失败，草稿已保留';setSendNotice(notice);diag.uiError('短信','sms.send',notice);}setFocusFailedDraft(draftKey);}})
      .finally(()=>{submitting.current=false;if(mounted.current)setSending(false);});
   }}>
    <p className="composer-from">从 {fromChip??<strong>{simLabel}</strong>} 发送 · 草稿自动保存</p><textarea ref={composer} name="message" autoComplete="off" aria-label="短信内容" placeholder="输入短信" rows={1} value={draft.body} onChange={e=>update({body:e.target.value})} disabled={busy}/><button className="send-message" aria-label={composing&&recipients.length>1?`发送短信到 ${recipients.length} 个号码`:'发送短信'} disabled={busy||!online||(composing?(pendingRecipient||!recipients.length||recipients.length>100):!draft.number.trim())||!draft.body.trim()||!canReply}><UiIcon name="send" size={20}/></button>
   </form>{!canReply&&<p className="note">此发送方不支持直接回复。</p>}{!online&&<p className="note">此号码暂不可用，草稿已保留。</p>}
  </>}</div>
 </section>;
}

/** S87: bubble text with tappable links; `plain` (selection mode) keeps the bubble a pure checkbox target. */
function SmsBody({body,plain=false}:{body:string;plain?:boolean}){
 const [pending,setPending]=useState<string|null>(null);
 if(plain&&pending)setPending(null);
 const segments=plain?[]:smsLinkSegments(body);
 if(!segments.some(s=>s.url))return <p>{body}</p>;
 return <>
  <p>{segments.map((s,i)=>s.url?<a key={i} className="sms-link" href={s.url} target="_blank" rel="noopener noreferrer" onClick={event=>{event.preventDefault();setPending(s.url!);}}>{s.text}</a>:s.text)}</p>
  {pending&&<ConfirmAction busy={false} prompt="打开链接？" detail={pending} confirmLabel="打开" tone="neutral"
   onConfirm={()=>{const url=pending;setPending(null);if(isOpenableUrl(url))window.open(url,'_blank','noopener,noreferrer');}}
   onCancel={()=>setPending(null)}/>}
 </>;
}

/**
 * 通讯录内联短信窗口: a focused conversation for one number — history (when present) plus the composer,
 * without the thread list or delete/block actions. The dedicated 短信 tab still uses the full `Messages` shell.
 */
type SmsComposeProps=RecipientProps&{
  messages:ThreadMessage[];simId:string;simLabel:string;online:boolean;busy:boolean;timeZone?:string|null;
  remoteNumber:string;requestToken?:number;contactName?:string|null;onSend:(number:string,body:string)=>Promise<void>;onClose:()=>void;
};
export function SmsCompose(props:SmsComposeProps){return <SmsComposeBody key={props.account||'session'} {...props}/>;}
function SmsComposeBody({request,account,onSent,messages,simId,simLabel,online,busy,timeZone,remoteNumber,requestToken,contactName,onSend,onClose}:SmsComposeProps){
  const zone=gatewayDisplayTimeZone(timeZone);
  const [recipients,setRecipients]=useState(()=>startSmsRecipients(remoteNumber,contactName||undefined));
  const [pendingRecipient,setPendingRecipient]=useState(false);
  useEffect(()=>{setRecipients(startSmsRecipients(remoteNumber,contactName||undefined));setPendingRecipient(false);},[remoteNumber,requestToken]);
  const [drafts,setDrafts]=useSmsDrafts(account);
  const bodyKey=JSON.stringify([simId,'new']);
  const body=drafts[bodyKey]?.body||'';const setBody=(text:string)=>setDrafts(old=>({...old,[bodyKey]:{number:'',body:text}}));
  const [sending,setSending]=useState(false);const submitting=useRef(false);
  const [sendNotice,setSendNotice]=useState('');
  busy=busy||sending;
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const receivingNumber=recipients.length===1?recipients[0].number:'';
  const thread=receivingNumber?messageThreads(messages.filter(m=>m.simId===simId)).find(t=>samePhoneNumber(t.number,receivingNumber)||samePhoneNumber(t.remoteNumber,receivingNumber)):undefined;
  const bottom=useRef<HTMLDivElement>(null);
  const panel=useRef<HTMLElement>(null);
  const restoreFocusTo=useRef<HTMLElement|null>(null);
  const restoreFocusTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[thread?.messages.at(-1)?.id,remoteNumber]);
  useEffect(()=>{
   const mountedPanel=panel.current;
   if(typeof document==='undefined'||!mountedPanel)return;
   // StrictMode replays cleanup/setup: a stale close must not steal this dialog's focus.
   if(restoreFocusTimer.current!==null){window.clearTimeout(restoreFocusTimer.current);restoreFocusTimer.current=null;}
   const active=document.activeElement;
   if(active instanceof HTMLElement&&active!==document.body&&!mountedPanel.contains(active))restoreFocusTo.current=active;
   // Also contain delayed focus restoration from the contact dialog we replace.
   const containFocus=(event:FocusEvent)=>{
    if(mountedPanel.isConnected&&event.target instanceof Node&&!mountedPanel.contains(event.target))mountedPanel.focus();
   };
   document.addEventListener('focusin',containFocus);
   mountedPanel.focus();
   return()=>{
    document.removeEventListener('focusin',containFocus);
    restoreFocusTimer.current=window.setTimeout(()=>{
     restoreFocusTimer.current=null;
     const current=document.activeElement;
     // A replacement dialog or an intentional focus move owns focus now.
     if(current instanceof HTMLElement&&current.isConnected&&current!==document.body&&!mountedPanel.contains(current))return;
     const opener=restoreFocusTo.current;
     const candidates=[opener,...document.querySelectorAll<HTMLElement>('#main input:not([disabled]), #main button:not([disabled]), #main a[href], #main [tabindex]:not([tabindex="-1"])')];
     for(const candidate of candidates){
      if(!candidate?.isConnected||candidate.offsetParent===null||candidate.matches(':disabled')||mountedPanel.contains(candidate))continue;
      candidate.focus();
      if(document.activeElement===candidate)return;
     }
    },0);
   };
  },[]);
  const title=recipients.length===1?numberWithContact(recipients[0].number,recipients[0].name):'新短信';
  return <>
    <div className="sms-compose-backdrop" aria-hidden="true" onClick={onClose}/>
    <section
      className="sms-compose"
      role="dialog"
      aria-modal="true"
      aria-label={`短信对话 ${title}`}
      ref={panel}
      tabIndex={-1}
      onKeyDown={event=>{
       if(event.key==='Escape'){event.stopPropagation();onClose();return;}
       if(event.key!=='Tab')return;
       const focusable=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(element=>element.offsetParent!==null);
       if(!focusable.length){event.preventDefault();event.currentTarget.focus();return;}
       if(event.shiftKey&& (document.activeElement===event.currentTarget||document.activeElement===focusable[0])){event.preventDefault();focusable.at(-1)?.focus();}
       else if(!event.shiftKey&&document.activeElement===event.currentTarget){event.preventDefault();focusable[0]?.focus();}
       else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0]?.focus();}
      }}
    >
    <header className="sms-compose-heading">
      <div><h2>{title}</h2><small>使用 {simLabel}</small></div>
      <button type="button" className="contact-card-close" aria-label="关闭短信窗口" onClick={onClose}>✕</button>
    </header>
    <SmsRecipients key={`${remoteNumber}:${requestToken||0}`} value={recipients} onChange={setRecipients} onPendingChange={setPendingRecipient} request={request} busy={busy}/>
    {sendNotice&&<p className="note" role="status">{sendNotice}</p>}
    <div className="message-bubbles" aria-live="polite">
      {(thread?.messages||[]).map(m=><article className={'message-bubble '+(m.direction==='outgoing'?'outgoing':'incoming')} key={m.id}><SmsBody body={m.body}/><small>{formatCompactCallDate(m.createdAt,zone)} · {smsStatusLabel(m)}</small></article>)}
      {(!thread||!thread.messages.length)&&<p className="sms-compose-empty">还没有聊天记录</p>}
      <div ref={bottom}/>
    </div>
    <form className="message-composer" onSubmit={e=>{
      e.preventDefault();const text=body.trim();if(!text||pendingRecipient||!online||busy||submitting.current||!recipients.length||recipients.length>100)return;
      const selected=recipients;submitting.current=true;setSending(true);setSendNotice('');
      const send=async()=>{if(selected.length===1)await onSend(selected[0].number,text);else {if(!request||!account)throw new Error('请重新载入页面以发送多收件人短信');await enqueueSmsBatch({request,account,simId,recipients:selected.map(item=>item.number),body:text,storage:sessionStorage,onSent,isCurrent:()=>mounted.current});}};
      void send().then(()=>{setDrafts(old=>old[bodyKey]?.body===body?{...old,[bodyKey]:{number:'',body:''}}:old);if(!mounted.current)return;flashConfirmation(setSendNotice,`已受理 ${selected.length} 个号码，等待发送。`);}).catch(error=>{if(mounted.current){const notice=error instanceof Error?error.message:'发送失败，草稿已保留';setSendNotice(notice);diag.uiError('短信','sms.compose',notice);}}).finally(()=>{submitting.current=false;if(mounted.current)setSending(false);});
    }}>
      <textarea autoComplete="off" aria-label="短信内容" placeholder="短信…" rows={1} value={body} onChange={e=>setBody(e.target.value)} disabled={busy}/>
      <button className="send-message" aria-label={recipients.length>1?`发送短信到 ${recipients.length} 个号码`:'发送短信'} disabled={busy||pendingRecipient||!online||!body.trim()||!recipients.length||recipients.length>100}>↑</button>
    </form>
    {!online&&<p className="note sms-compose-empty">此号码暂不可用，草稿已保留。</p>}
    </section>
  </>;
}
