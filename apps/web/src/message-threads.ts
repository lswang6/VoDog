import type {ApiRequest} from './contacts';
export type ThreadMessage={id:string;simId:string;direction:string;number?:string;remoteNumber?:string;body:string;state:string;conversationAddress?:string;replyNumber?:string|null;canReply?:boolean;createdAt:string;contactId?:string|null;contactName?:string|null;blocked?:boolean;blockedEntryId?:string|null;/** S67c: missing = false. */unread?:boolean};
/**
 * `conversationAddress` is the server's own thread key (S30 §1.3 normalises both sides of it), and `remoteNumber`
 * is the raw number the rows carry — 屏蔽 takes that one, never the normalised address.
 */
export type MessageThread={key:string;simId:string;number:string;conversationAddress:string|null;remoteNumber:string|null;contactName:string|null;messages:ThreadMessage[]};
export const MAX_SMS_SELECTION = 500;
export type SmsDeleteSkipped={id:string;reason:'not_found'|'in_flight'};
export type SmsDeleteResult={deleted:number;skipped:SmsDeleteSkipped[]};
export type ThreadDeleteResult=SmsDeleteResult&{ok:boolean;blocked:boolean;error?:string};
export const BLOCKED_BUT_THREAD_DELETE_FAILED='号码已屏蔽，但对话删除失败，请重试';
/** The newest message that carries a name wins, so a rename shows up without reloading older rows (S21 §A). */
function threadContactName(messages:ThreadMessage[]):string|null{
 for(let index=messages.length-1;index>=0;index--){
  const name=(messages[index]!.contactName||'').trim();
  if(name)return name;
 }
 return null;
}
/** Same 最新一条优先 rule as the name: an older row missing the field must not blank out a newer one that has it. */
function newestField(messages:ThreadMessage[],read:(message:ThreadMessage)=>string|undefined):string|null{
 for(let index=messages.length-1;index>=0;index--){
  const value=(read(messages[index]!)||'').trim();
  if(value)return value;
 }
 return null;
}
export function messageThreads(messages:ThreadMessage[]):MessageThread[]{
 const groups=new Map<string,MessageThread>();
 for(const message of messages){
  const number=message.conversationAddress||message.remoteNumber||message.number||'';
  // Unknown senders must not accidentally become a shared, replyable conversation.
  const key=JSON.stringify([message.simId,number||message.id]);
  const group=groups.get(key)||{key,simId:message.simId,number,conversationAddress:null,remoteNumber:null,contactName:null,messages:[]};
  group.messages.push(message);groups.set(key,group);
 }
 return [...groups.values()].map(group=>{const ordered=[...group.messages].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));return {...group,messages:ordered,contactName:threadContactName(ordered),conversationAddress:newestField(ordered,m=>m.conversationAddress),remoteNumber:newestField(ordered,m=>m.remoteNumber||m.number)};})
 .sort((a,b)=>b.messages.at(-1)!.createdAt.localeCompare(a.messages.at(-1)!.createdAt)||a.key.localeCompare(b.key));
}

/**
 * S30 §1.2: `POST /sms/delete {ids}` deletes this account's own messages; anything still 在途 comes back as
 * `skipped`, which is not an error — the next refresh simply still shows it.
 */
export async function deleteMessages(request:ApiRequest,ids:string[]):Promise<SmsDeleteResult>{
 if(ids.length>MAX_SMS_SELECTION)throw new Error(`每次最多选择 ${MAX_SMS_SELECTION} 条短信`);
 if(!ids.length)return {deleted:0,skipped:[]};
 return request<SmsDeleteResult>('/sms/delete',{ids});
}

/** Keep an accepted delete result even when the follow-up dashboard read is temporarily unavailable. */
export async function deleteMessagesAndRefresh(
 request:ApiRequest,
 ids:string[],
 refresh:()=>Promise<unknown>,
 onRefreshFailure:(error:unknown)=>void,
):Promise<SmsDeleteResult>{
 const result=await deleteMessages(request,ids);
 try{await refresh();}catch(error){onRefreshFailure(error);}
 return result;
}

/**
 * S30 §1.3: deleting a whole conversation, optionally 屏蔽 first.
 *
 * 屏蔽 goes first on purpose: if it fails (400 紧急号码/不可拨号) the messages are still there to try again on, and
 * the account never ends up with a deleted thread whose number keeps calling. Both 201 新建 and 200 已存在 count as
 * success, which `api` already gives us — only a non-2xx throws.
 */
export async function deleteThread(request:ApiRequest,thread:MessageThread,block:boolean):Promise<ThreadDeleteResult>{
 if(block)await request<unknown>('/blocklist',{remoteNumber:thread.remoteNumber||thread.number,scope:'sms'});
 try{
  const result=await request<SmsDeleteResult>('/sms/threads/delete',{simId:thread.simId,conversationAddress:thread.conversationAddress??thread.number});
  return {...result,ok:true,blocked:block};
 }catch(caught){
  if(block)return {ok:false,blocked:true,deleted:0,skipped:[],error:BLOCKED_BUT_THREAD_DELETE_FAILED};
  throw caught;
 }
}
