import {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import type {Sim} from './call-history-panel';

export type SimNotesSnapshot={version:number;label:string;phoneLabel:string|null};
export type SimSettingsSnapshot={version:number;mode:string;timeoutSeconds:number};
type NotesDraft={simId:string;baseVersion:number|undefined;label:string;phoneLabel:string;baseLabel:string;basePhoneLabel:string;dirty:boolean;blocked:boolean;message:string};
const notesFrom=(sim:Sim):NotesDraft=>({simId:sim.id,baseVersion:sim.version,label:sim.label||'',phoneLabel:sim.phoneLabel||'',baseLabel:sim.label||'',basePhoneLabel:sim.phoneLabel||'',dirty:false,blocked:false,message:''});
const notesFromSnapshot=(simId:string,value:SimNotesSnapshot):NotesDraft=>({simId,baseVersion:value.version,label:value.label,phoneLabel:value.phoneLabel||'',baseLabel:value.label,basePhoneLabel:value.phoneLabel||'',dirty:false,blocked:false,message:''});
const notesDirty=(next:NotesDraft):NotesDraft=>({...next,dirty:next.label.trim()!==next.baseLabel.trim()||next.phoneLabel.trim()!==next.basePhoneLabel.trim()});

export function SimNotesForm({sim,busy,onSubmit,loadLatest,onDirtyChange}:{
 sim:Sim;busy:boolean;onDirtyChange?:(dirty:boolean)=>void;
 onSubmit:(label:string,phoneLabel:string|null,expectedVersion:number)=>Promise<SimNotesSnapshot|null>;
 loadLatest:()=>Promise<SimNotesSnapshot>;
}){
 const [draft,setDraft]=useState<NotesDraft>(()=>notesFrom(sim));
 useReportedError('设置','sim.notes',draft.message);
 useEffect(()=>{onDirtyChange?.(draft.dirty);return()=>onDirtyChange?.(false);},[draft.dirty]);
 const [pending,setPending]=useState(false);
 const latestSimId=useRef(sim.id);latestSimId.current=sim.id;
 const latestServerVersion=useRef(sim.version||0);latestServerVersion.current=sim.version||0;
 useEffect(()=>setDraft(current=>{
  if(current.simId!==sim.id)return notesFrom(sim);
  if(current.baseVersion!==sim.version){
   if(current.dirty||current.blocked)return {...current,blocked:true,message:'号码备注已在其他设备更新。草稿和原版本已保留，请载入最新内容后再编辑。'};
   return notesFrom(sim);
  }
  if(!current.dirty&&!current.blocked&&(current.label!==(sim.label||'')||current.phoneLabel!==(sim.phoneLabel||'')))return notesFrom(sim);
  return current;
 }),[sim.id,sim.version,sim.label,sim.phoneLabel]);
 async function reload(){if(busy||pending)return;const simId=draft.simId;setPending(true);try{const latest=await loadLatest();if(latestSimId.current===simId)setDraft(notesFromSnapshot(simId,latest));}catch{if(latestSimId.current===simId)setDraft(current=>({...current,blocked:true,message:'暂时无法读取服务器最新号码备注；草稿和原版本已保留，请重试。'}));}finally{setPending(false);}}
 async function submit(){if(busy||pending||draft.baseVersion===undefined||!draft.label.trim()||draft.blocked)return;const simId=draft.simId;setPending(true);const snapshot={label:draft.label.trim(),phoneLabel:draft.phoneLabel.trim()||null,version:draft.baseVersion};try{const saved=await onSubmit(snapshot.label,snapshot.phoneLabel,snapshot.version);if(latestSimId.current!==simId)return;if(saved){const next=notesFromSnapshot(simId,saved);setDraft(latestServerVersion.current>saved.version?{...next,blocked:true,message:'号码备注已保存，但服务器随后又有更新；请载入最新内容后再编辑。'}:next);}else setDraft(current=>({...current,blocked:true,message:'号码备注未保存。草稿和原版本已保留，请载入服务器最新内容后重试。'}));}catch{if(latestSimId.current===simId)setDraft(current=>({...current,blocked:true,message:'号码备注未保存。草稿和原版本已保留，请载入服务器最新内容后重试。'}));}finally{setPending(false);}}
 const locked=busy||pending;
 return <form onSubmit={event=>{event.preventDefault();void submit();}}>
  <h2>号码备注</h2><p className="muted">仅修改显示名称，不会更换 SIM 身份或中断通话。</p>
  <label>名称<input value={draft.label} maxLength={80} required disabled={locked} onChange={event=>setDraft(current=>notesDirty({...current,label:event.target.value}))}/></label>
  <label>号码标注<input value={draft.phoneLabel} maxLength={80} disabled={locked} onChange={event=>setDraft(current=>notesDirty({...current,phoneLabel:event.target.value}))} placeholder="例如：家庭卡"/></label>
  {draft.message&&<div className="note" role="status"><p>{draft.message}</p><button type="button" className="passkey" disabled={locked} onClick={()=>void reload()}>载入最新号码备注（替换当前草稿）</button></div>}
  <dl className="settings-facts"><div><dt>服务器版本</dt><dd>{sim.version??'—'}</dd></div><div><dt>草稿基于版本</dt><dd>{draft.baseVersion??'—'}</dd></div></dl>
  {draft.dirty&&<p className="unsaved" role="status">未保存设置</p>}
  <button className="primary" disabled={locked||draft.blocked||draft.baseVersion===undefined||!draft.label.trim()}>{pending?'正在保存…':'保存号码备注'}</button>
  {draft.dirty&&!draft.blocked&&<button type="button" className="passkey" disabled={locked} onClick={()=>setDraft(notesFrom(sim))}>放弃修改</button>}
 </form>;
}

type SettingsDraft={simId:string;baseVersion:number;mode:string;seconds:number;baseMode:string;baseSeconds:number;dirty:boolean;blocked:boolean;message:string};
const settingsFrom=(sim:Sim):SettingsDraft=>({simId:sim.id,baseVersion:sim.settings.version,mode:sim.settings.mode,seconds:sim.settings.timeoutSeconds||45,baseMode:sim.settings.mode,baseSeconds:sim.settings.timeoutSeconds||45,dirty:false,blocked:false,message:''});
const settingsFromSnapshot=(simId:string,value:SimSettingsSnapshot):SettingsDraft=>({simId,baseVersion:value.version,mode:value.mode,seconds:value.timeoutSeconds||45,baseMode:value.mode,baseSeconds:value.timeoutSeconds||45,dirty:false,blocked:false,message:''});
const settingsDirty=(next:SettingsDraft):SettingsDraft=>({...next,dirty:next.mode!==next.baseMode||next.seconds!==next.baseSeconds});

/** Same field values as before (normal / timeout_ai / ai); only the presentation is three selectable cards. */
const ANSWER_MODES:[string,string,string][]=[['normal','我自己接','人工接听，来电在已登录的设备上响铃'],['timeout_ai','先响铃，无人接听再交给 AI','超时转 AI'],['ai','AI 立即代接','不响铃，事后看摘要']];
export function SimReceptionForm({sim,busy,status,onSubmit,loadLatest,onDirtyChange}:{
 sim:Sim;busy:boolean;status:string;onDirtyChange?:(dirty:boolean)=>void;
 onSubmit:(mode:string,seconds:number,expectedVersion:number)=>Promise<SimSettingsSnapshot|null>;
 loadLatest:()=>Promise<SimSettingsSnapshot>;
}){
 const [draft,setDraft]=useState<SettingsDraft>(()=>settingsFrom(sim));
 useReportedError('设置','sim.reception',draft.message);
 useEffect(()=>{onDirtyChange?.(draft.dirty);return()=>onDirtyChange?.(false);},[draft.dirty]);
 const [pending,setPending]=useState(false);
 const latestSimId=useRef(sim.id);latestSimId.current=sim.id;
 const latestServerVersion=useRef(sim.settings.version);latestServerVersion.current=sim.settings.version;
 useEffect(()=>setDraft(current=>{
  if(current.simId!==sim.id)return settingsFrom(sim);
  if(current.baseVersion!==sim.settings.version){
   if(current.dirty||current.blocked)return {...current,blocked:true,message:'接听设置已在其他设备更新。草稿和原版本已保留，请载入最新内容后再编辑。'};
   return settingsFrom(sim);
  }
  if(!current.dirty&&!current.blocked&&(current.mode!==sim.settings.mode||current.seconds!==(sim.settings.timeoutSeconds||45)))return settingsFrom(sim);
  return current;
 }),[sim.id,sim.settings.version,sim.settings.mode,sim.settings.timeoutSeconds]);
 const available=sim.settings.availableModes||['normal'];
 async function reload(){if(busy||pending)return;const simId=draft.simId;setPending(true);try{const latest=await loadLatest();if(latestSimId.current===simId)setDraft(settingsFromSnapshot(simId,latest));}catch{if(latestSimId.current===simId)setDraft(current=>({...current,blocked:true,message:'暂时无法读取服务器最新接听设置；草稿和原版本已保留，请重试。'}));}finally{setPending(false);}}
 async function submit(){if(busy||pending||draft.blocked||!available.includes(draft.mode))return;const simId=draft.simId;setPending(true);const snapshot={mode:draft.mode,seconds:draft.seconds,version:draft.baseVersion};try{const saved=await onSubmit(snapshot.mode,snapshot.seconds,snapshot.version);if(latestSimId.current!==simId)return;if(saved){const next=settingsFromSnapshot(simId,saved);setDraft(latestServerVersion.current>saved.version?{...next,blocked:true,message:'接听设置已保存，但服务器随后又有更新；请载入最新内容后再编辑。'}:next);}else setDraft(current=>({...current,blocked:true,message:'接听设置未保存。草稿和原版本已保留，请载入服务器最新内容后重试。'}));}catch{if(latestSimId.current===simId)setDraft(current=>({...current,blocked:true,message:'接听设置未保存。草稿和原版本已保留，请载入服务器最新内容后重试。'}));}finally{setPending(false);}}
 const locked=busy||pending;
 return <><h2>来电怎么接</h2><p className="muted">为当前 SIM 设置接听方式；设备确认后生效。</p><p role="status">{status}</p>
  <form onSubmit={event=>{event.preventDefault();void submit();}}>
   <div className="answer-modes" role="radiogroup" aria-label="接听模式">{ANSWER_MODES.map(([value,title,detail])=><label key={value} className={`answer-card${draft.mode===value?' selected':''}`}><input type="radio" name={`answer-mode-${sim.id}`} value={value} checked={draft.mode===value} disabled={locked||(value!=='normal'&&!available.includes(value))} onChange={event=>setDraft(current=>settingsDirty({...current,mode:event.target.value}))}/><strong>{title}</strong><small>{value==='timeout_ai'&&draft.mode==='timeout_ai'?`等待 ${draft.seconds} 秒`:detail}</small></label>)}</div>
   {draft.mode==='timeout_ai'&&<label>等待秒数<input type="number" min={10} max={120} value={draft.seconds} disabled={locked} onChange={event=>setDraft(current=>settingsDirty({...current,seconds:Number(event.target.value)}))}/></label>}
   {(!available.includes('ai')||!available.includes('timeout_ai'))&&<p className="note">{sim.settings.aiUnavailableReason||'AI 接听尚未开放'}</p>}
   {draft.message&&<div className="note" role="status"><p>{draft.message}</p><button type="button" className="passkey" disabled={locked} onClick={()=>void reload()}>载入最新接听设置（替换当前草稿）</button></div>}
   <dl className="settings-facts"><div><dt>服务器版本</dt><dd>{sim.settings.version}</dd></div><div><dt>草稿基于版本</dt><dd>{draft.baseVersion}</dd></div><div><dt>设备已应用</dt><dd>{sim.settings.appliedVersion??'尚未确认'}</dd></div></dl>
   {draft.dirty&&<p className="unsaved" role="status">未保存设置</p>}
   <button className="primary" disabled={locked||draft.blocked||!available.includes(draft.mode)}>{pending?'正在保存…':'保存接听设置'}</button>
   {draft.dirty&&!draft.blocked&&<button type="button" className="passkey" disabled={locked} onClick={()=>setDraft(settingsFrom(sim))}>放弃修改</button>}
  </form></>;
}
