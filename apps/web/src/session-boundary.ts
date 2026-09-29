import {audioOwnership} from './audio-ownership.ts';
const eventName='vodog-session-invalidated';
const storageKey='vodog-session-change-v1';
const signedOutKey='vodog-signed-out-v1';
let generation=0;
export const browserSessionGeneration=()=>generation;
export function markBrowserSignedOut(){try{sessionStorage.setItem(signedOutKey,'1');}catch{/* Keep in-memory cleanup available. */}}
export function acceptBrowserSession(){try{sessionStorage.removeItem(signedOutKey);}catch{/* No persisted state to recover. */}}
export function isBrowserSignedOut(){try{return sessionStorage.getItem(signedOutKey)==='1';}catch{return false;}}
/** Contains no user identity, credentials or content; listeners clear their own state. */
export function broadcastSessionChange(){
 generation++;
 audioOwnership.stopRecordings();
 try{localStorage.setItem(storageKey,JSON.stringify({nonce:crypto.randomUUID(),at:Date.now()}));}catch{/* Local cleanup still succeeds if storage is unavailable. */}
}
export function expireBrowserSession(expectedGeneration=browserSessionGeneration()){
 if(expectedGeneration!==generation)return;
 markBrowserSignedOut();
 audioOwnership.stopRecordings();
 window.dispatchEvent(new Event(eventName));
 broadcastSessionChange();
}
export function listenForSessionInvalidation(invalidate:()=>void){
 const local=()=>invalidate();
 const external=(event:StorageEvent)=>{
  if(event.key!==storageKey||!event.newValue)return;
  try{const value=JSON.parse(event.newValue);if(typeof value.nonce!=='string'||typeof value.at!=='number')return;}catch{return;}
  generation++;
  markBrowserSignedOut();
  audioOwnership.stopRecordings();invalidate();
 };
 window.addEventListener(eventName,local);window.addEventListener('storage',external);
 return()=>{window.removeEventListener(eventName,local);window.removeEventListener('storage',external);};
}
/** Browsers with Web Locks serialize same-origin cookie mutations across tabs. */
export async function withSessionMutation<T>(action:()=>Promise<T>):Promise<T>{
 return navigator.locks?.request ? await navigator.locks.request('vodog-session-cookie',action) : await action();
}
/** Failed authentication must not interrupt another tab's valid call. */
export async function mutateBrowserSession<T>(kind:'login'|'logout',action:()=>Promise<T>):Promise<T>{
 const expected=generation;
 return withSessionMutation(async()=>{
  if(expected!==generation)throw new Error('登录状态已改变，请重试。');
  if(kind==='logout')broadcastSessionChange();
  const value=await action();
  if(kind==='login')broadcastSessionChange();
  return value;
 });
}
