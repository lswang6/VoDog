import {useEffect,useRef,useState} from 'react';
import {useReportedError} from './ui-error';

/**
 * Cloudflare Turnstile widget for the login screen.
 *
 * The site key is published by the control service (`GET /api/v1/auth/config`), so turning Turnstile on or rotating
 * the key is a server-side change and never depends on a rebuild of the web bundle. The token is single use: it must
 * be reset after any failed attempt, which the caller does through the `resetKey` prop.
 */
export type TurnstileConfig={enabled:boolean;siteKey:string|null};
type TurnstileCallbacks={callback?:(token:string)=>void;'error-callback'?:()=>void;'expired-callback'?:()=>void;'timeout-callback'?:()=>void};
export type TurnstileApi={
 render:(container:HTMLElement,options:Record<string,unknown>&TurnstileCallbacks)=>string;
 remove:(widgetId?:string)=>void;
 reset:(widgetId?:string)=>void;
};
declare global{interface Window{turnstile?:TurnstileApi}}

const SCRIPT_SRC='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loader:Promise<TurnstileApi>|null=null;
const LOAD_TIMEOUT_MS=8000;

export function retryTurnstileLoader(){
 loader=null;
 if(typeof document!=='undefined')document.querySelector<HTMLScriptElement>('script[data-turnstile]')?.remove();
}

export function loadTurnstile(timeoutMs=LOAD_TIMEOUT_MS):Promise<TurnstileApi>{
 if(typeof document==='undefined')return Promise.reject(new Error('Turnstile requires a browser'));
 if(window.turnstile)return Promise.resolve(window.turnstile);
 if(loader)return loader;
 loader=new Promise<TurnstileApi>((resolve,reject)=>{
  let settled=false;
  // A script tag left behind by a failed load never fires `load` again, so replace it instead of waiting forever.
  document.querySelector<HTMLScriptElement>('script[data-turnstile]')?.remove();
  const script=document.createElement('script');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(error?:Error)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);script.removeEventListener('load',loaded);script.removeEventListener('error',failed);if(error){script.remove();reject(error);}else resolve(window.turnstile!);};
  const loaded=()=>window.turnstile?finish():finish(new Error('人机验证脚本未能初始化，请重试。'));
  const failed=()=>finish(new Error('人机验证加载失败，请重试。'));
  script.addEventListener('load',loaded);
  script.addEventListener('error',failed);
  script.dataset.turnstile='true';
  script.src=SCRIPT_SRC;
  script.async=true;
  script.defer=true;
  timer=setTimeout(()=>finish(new Error('人机验证加载超时，请重试。')),timeoutMs);
  document.head.appendChild(script);
 }).catch(error=>{loader=null;throw error;});
 return loader;
}

export function TurnstileWidget({siteKey,onToken,resetKey}:{siteKey:string;onToken:(token:string|null)=>void;resetKey:number}){
 const container=useRef<HTMLDivElement|null>(null);
 const widgetId=useRef<string|null>(null);
 const onTokenRef=useRef(onToken);
 const generation=useRef(0);
 const [retryKey,setRetryKey]=useState(0);
 const [status,setStatus]=useState<{kind:'loading'|'ready'|'verified'|'error'|'expired'|'timeout';message:string}>({kind:'loading',message:'正在加载人机验证…'});
 useReportedError('login','turnstile',['error','expired','timeout'].includes(status.kind)&&status.message);
 onTokenRef.current=onToken;
 useEffect(()=>{
  const current=++generation.current;
  setStatus({kind:'loading',message:'正在加载人机验证…'});
  onTokenRef.current(null);
  loadTurnstile().then(api=>{
   if(current!==generation.current||!container.current)return;
   const mount=container.current;
   try{
    // Some test and failure implementations call a callback synchronously from render. Publish ready first so that
    // a verified/error/expired result remains authoritative instead of being overwritten after render returns.
    setStatus({kind:'ready',message:'请完成人机验证。'});
    const id=api.render(mount,{
     sitekey:siteKey,theme:'auto',language:'zh-cn',size:'flexible',
     callback:(token:string)=>{if(current!==generation.current)return;onTokenRef.current(token);setStatus({kind:'verified',message:'人机验证已完成。'});},
     'error-callback':()=>{if(current!==generation.current)return;onTokenRef.current(null);setStatus({kind:'error',message:'人机验证失败，请重试。'});},
     'expired-callback':()=>{if(current!==generation.current)return;onTokenRef.current(null);setStatus({kind:'expired',message:'人机验证已过期，请重新验证。'});},
     'timeout-callback':()=>{if(current!==generation.current)return;onTokenRef.current(null);setStatus({kind:'timeout',message:'人机验证已超时，请重试。'});},
    });
    if(typeof id!=='string'||!id)throw new Error('人机验证组件未能启动，请重试。');
    widgetId.current=id;
   }catch(e){mount.replaceChildren();if(current===generation.current){onTokenRef.current(null);setStatus({kind:'error',message:e instanceof Error?e.message:'人机验证组件未能启动，请重试。'});}}
  }).catch(e=>{if(current===generation.current){onTokenRef.current(null);setStatus({kind:'error',message:e instanceof Error?e.message:'人机验证加载失败，请重试。'});}});
  return ()=>{if(generation.current===current)generation.current++;const id=widgetId.current;widgetId.current=null;if(id)window.turnstile?.remove(id);};
 },[siteKey,resetKey,retryKey]);
 const retryable=['error','expired','timeout'].includes(status.kind);
 return <div className="turnstile"><div ref={container}/><p className="note" role="status">{status.message}</p>{retryable&&<button type="button" className="passkey" onClick={()=>{retryTurnstileLoader();setRetryKey(value=>value+1);}}>重新加载人机验证</button>}</div>;
}
