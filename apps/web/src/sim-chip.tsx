import type {CSSProperties} from 'react';

export type SimStatus='online'|'offline'|'pending';
/** Line colour: a palette pair from simPaletteColor (theme-aware) or one fixed CSS colour. */
export type SimColor=string|{light:string;dark:string};

const STATUS_LABEL:Record<SimStatus,string>={online:'在线',offline:'离线',pending:'待生效'};

/** Inline vars consumed by .sim-tint/.sim-swatch in style.css. */
export function simColorStyle(color:SimColor):CSSProperties{
 const c=typeof color==='string'?{light:color,dark:color}:color;
 return {'--sim-light':c.light,'--sim-dark':c.dark} as CSSProperties;
}

/** ● online, ○ offline, ◐ pending — shape carries the state, never colour alone. */
export function StatusShape({status}:{status:SimStatus}){
 return <span className={`status-shape ${status}`} role="img" aria-label={STATUS_LABEL[status]}/>;
}

/** The SIM's existing answer-mode setting (`normal` / `ai` / `timeout_ai` + seconds). */
export type AiMode={mode?:string|null;timeoutSeconds?:number|null}|null|undefined;

/** S95b: ✦ AI badge, shown iff the line's answer mode is not `normal`. Compact = `AI`; full = `AI 代接` / `AI · N 秒后`. */
export function AiBadge({ai,full=false}:{ai:AiMode;full?:boolean}){
 const mode=ai?.mode;if(mode!=='ai'&&mode!=='timeout_ai')return null;
 const seconds=ai?.timeoutSeconds;
 const label=mode==='ai'?'AI 代接已开启，立即由 AI 接听':seconds?`AI 代接已开启，响铃 ${seconds} 秒无人接听后由 AI 接听`:'AI 代接已开启，响铃无人接听后由 AI 接听';
 const text=!full?'AI':mode==='ai'?'AI 代接':seconds?<>AI · <span className="num">{seconds}</span> 秒后</>:'AI 兜底';
 return <span className="ai-badge" role="img" aria-label={label}><span aria-hidden="true">✦</span><span aria-hidden="true">{text}</span></span>;
}

export function SimChip({name,color,tail,status,selected,ai}:{name:string;color:SimColor;tail?:string|null;status?:SimStatus;selected?:boolean;ai?:AiMode}){
 return <span className={`sim-chip${selected?' selected':''}`} style={simColorStyle(color)}>
  <span className="sim-swatch" aria-hidden="true"/>
  <span className="sim-chip-name">{name}</span>
  {tail?<span className="sim-chip-tail num">{tail}</span>:null}
  <AiBadge ai={ai}/>
  {status==='offline'?<><span className="status-shape offline" aria-hidden="true"/><span className="sim-chip-offline">离线</span></>:status?<StatusShape status={status}/>:null}
 </span>;
}
