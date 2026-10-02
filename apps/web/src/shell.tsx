import {useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import {UiIcon,type IconName} from './icons';
import {AiBadge,SimChip,StatusShape,simColorStyle,type SimStatus} from './sim-chip';
import {simPaletteColor} from './sim-palette';
import {gatewayKindLabel} from './gateway-kind';
import {accountRoleLabel} from './settings-overview';
import {labels,type Call,type Sim} from './call-history-panel';

/** Display names for the five zones; internal tab keys (通话…) stay unchanged for badges and diagnostics. */
export const TAB_TITLES:Record<string,string>={'通话':'电话'};
export const tabTitle=(tab:string)=>TAB_TITLES[tab]??tab;

/** Gateway device name for display; never the internal id (S95b §C). */
export function gatewayName(sim:Pick<Sim,'gatewayKind'|'gatewayName'>):string{return sim.gatewayName?.trim()||gatewayKindLabel(sim.gatewayKind).short;}
export function simName(sim:Pick<Sim,'label'|'phoneLabel'>):string{return sim.label||sim.phoneLabel||'未命名号码';}
/** Last four digits of the line's own number, when it has one. */
export function simTail(sim:Pick<Sim,'phoneLabel'>):string|undefined{const digits=(sim.phoneLabel||'').replace(/\D/g,'');return digits.length>=4?digits.slice(-4):undefined;}
/** ● online · ○ offline/not present · ◐ online but the device has not applied the saved settings yet. */
export function simStatus(sim:Sim):SimStatus{
 if(sim.present===false||!sim.online)return 'offline';
 const s=sim.settings;return s&&s.appliedVersion!=null&&s.appliedVersion<s.version?'pending':'online';
}

const subscribeOnline=(fn:()=>void)=>{window.addEventListener('online',fn);window.addEventListener('offline',fn);return()=>{window.removeEventListener('online',fn);window.removeEventListener('offline',fn);};};
/** navigator.onLine as React state (SSR/tests: online). */
/** Media query as React state (SSR/tests: false). */
export function useMediaQuery(query:string){return useSyncExternalStore(fn=>{const m=globalThis.matchMedia?.(query);m?.addEventListener('change',fn);return()=>m?.removeEventListener('change',fn);},()=>Boolean(globalThis.matchMedia?.(query).matches),()=>false);}
export function useBrowserOnline(){return useSyncExternalStore(subscribeOnline,()=>navigator.onLine,()=>true);}

export type ConnectionKind='ok'|'loading'|'local'|'service'|'device';
/** Spec §1.3: three connection problems, derived only from existing signals. */
export function connectionKind({online,connectionError,simLoadStatus,sims,sim}:{online:boolean;connectionError:string;simLoadStatus:'loading'|'ready'|'error';sims:Sim[];sim?:Sim}):ConnectionKind{
 if(!online)return 'local';
 if(connectionError||simLoadStatus==='error')return 'service';
 if(simLoadStatus==='loading'&&!sims.length)return 'loading';
 const line=sim??sims[0];
 if(line&&(line.present===false||!line.online))return 'device';
 return 'ok';
}
const PILL:Record<ConnectionKind,[string,string]>={ok:['服务正常','ok'],loading:['正在读取 SIM','loading'],local:['本机未联网','local'],service:['服务连接暂不可用','warn'],device:['号码设备离线','device']};
export function StatusPill({kind}:{kind:ConnectionKind}){
 const [text,tone]=PILL[kind];
 return <span className={`status status-pill ${tone}`} role="status" aria-live="polite"><StatusShape status={kind==='ok'?'online':kind==='loading'||kind==='service'?'pending':'offline'}/>{text}</span>;
}

/** Spec §5 status banner: rounded 14, icon + bold title + one sentence. Never replaces the list under it. */
export function StatusBanner({kind,title,children,role='status'}:{kind:'local'|'service'|'device'|'error';title:string;children?:ReactNode;role?:'status'|'alert'}){
 const icon:IconName=kind==='local'?'offline':kind==='device'?'gateways':'warning';
 return <div className={`status-banner ${kind}${kind==='error'?' error':''}`} role={role}><UiIcon name={icon}/><div><strong>{title}</strong>{children&&<p>{children}</p>}</div></div>;
}

export function Sidebar({tabs,tab,badge,onSelect,sims,username,role,busy,onLogout}:{tabs:[string,IconName][];tab:string;badge:(tab:string)=>ReactNode;onSelect:(tab:string)=>void;sims:Sim[];username:string;role?:string;busy:boolean;onLogout:()=>void}){
 return <aside>
  <div className="brand"><img src="/icon-192.png" width="30" height="30" alt=""/>VoDog</div>
  <nav aria-label="主导航">{tabs.map(([t,icon])=><button key={t} aria-current={tab===t?'page':undefined} onClick={()=>onSelect(t)}><UiIcon name={icon}/>{tabTitle(t)}{badge(t)}</button>)}</nav>
  {sims.length>0&&<section className="side-lines" aria-label="线路">
   <p className="side-caption">线路</p>
   {sims.map(s=>{const status=simStatus(s),tail=simTail(s);return <div className="side-line sim-tint" key={s.id} style={simColorStyle(simPaletteColor(s,sims))}>
    <span className="side-line-bar" aria-hidden="true"/>
    <div><strong><span>{simName(s)}</span><AiBadge ai={s.settings} full/></strong><span>{gatewayName(s)} · {s.present===false?'未待机':status==='offline'?'离线':tail?<>尾号 <span className="num">{tail}</span></>:'在线'}</span></div>
    <StatusShape status={status}/>
   </div>;})}
  </section>}
  <div className="account">
   <span className="account-avatar" aria-hidden="true">{username.slice(0,1).toUpperCase()}</span>
   <div><strong>{username}</strong><span>{accountRoleLabel(role)}</span></div>
   <button className="passkey hangup" disabled={busy} onClick={onLogout}>退出</button>
  </div>
 </aside>;
}

function clock(totalSeconds:number){const s=Math.max(0,Math.floor(totalSeconds)),h=Math.floor(s/3600),m=Math.floor(s/60)%60,sec=s%60;return (h?`${h}:${String(m).padStart(2,'0')}`:String(m).padStart(2,'0'))+':'+String(sec).padStart(2,'0');}
/** UI-only ticker from the call's existing connect time; no call logic. */
export function useCallTimer(since?:string){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{if(!since)return;const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[since]);
 const base=since?Date.parse(since):NaN;
 return Number.isFinite(base)?clock((now-base)/1000):null;
}

/** Global call bar above every tab while this browser controls a call (spec §5). */
export function CallBar({call,sims,title,muted,canMute,ending,onMute,onReturn,onEnd}:{call?:Call;sims:Sim[];title:string;muted:boolean;canMute:boolean;ending:boolean;onMute:()=>void;onReturn:()=>void;onEnd:()=>void}){
 const timer=useCallTimer(call?.state==='active'?call.answeredAt||call.startedAt:undefined);
 const sim=sims.find(s=>s.id===call?.simId);
 return <div className="call-bar" role="region" aria-label="当前通话">
  <span className="call-bar-dot" aria-hidden="true"/>
  <strong className="call-bar-title"><span className="call-bar-state">{call?.state==='active'||!call?'通话中':labels[call.state]||'通话中'}</span> · <span dir="ltr">{title}</span></strong>
  {sim&&<SimChip name={simName(sim)} color={simPaletteColor(sim,sims)} ai={sim.settings}/>}
  {timer&&<span className="call-bar-timer num" aria-label={`通话时长 ${timer}`}>{timer}</span>}
  <div className="call-bar-actions">
   <button type="button" className={muted?'is-muted':''} aria-pressed={muted} disabled={!canMute||ending} onClick={onMute}><UiIcon name={muted?'microphone-off':'microphone'} size={18}/><span>{muted?'取消静音':'静音'}</span></button>
   <button type="button" onClick={onReturn}>返回通话</button>
   <button type="button" className="call-bar-end" disabled={ending} onClick={onEnd}>{ending?'正在结束…':<><UiIcon name="hangup" size={18}/>结束</>}</button>
  </div>
 </div>;
}
