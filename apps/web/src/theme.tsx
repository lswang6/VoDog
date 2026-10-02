import {useState} from 'react';
import {snapThemeChange} from './ui-motion';

export type Appearance='system'|'light'|'dark';
export const APPEARANCE_KEY='signal:appearance';
const OPTIONS:[Appearance,string][]=[['system','跟随系统'],['light','浅色'],['dark','深色']];

/** Saved per browser; survives sign-out (session-boundary never touches this key). Default 跟随系统. */
export function readAppearance():Appearance{
 try{const v=localStorage.getItem(APPEARANCE_KEY);return v==='light'||v==='dark'?v:'system';}catch{return 'system';}
}

/** 跟随系统 removes data-theme so the prefers-color-scheme token block applies. */
export function applyAppearance(value:Appearance){
 if(typeof document==='undefined')return;
 const root=document.documentElement;
 if(value==='system')root.removeAttribute('data-theme');else root.setAttribute('data-theme',value);
}

export function AppearanceSetting(){
 const [value,setValue]=useState<Appearance>(readAppearance);
 function choose(next:Appearance){
  if(next===value)return;
  try{if(next==='system')localStorage.removeItem(APPEARANCE_KEY);else localStorage.setItem(APPEARANCE_KEY,next);}catch{/* still applies for this page */}
  snapThemeChange();applyAppearance(next);setValue(next);
 }
 return <div className="setting-row">
  <div><strong id="appearance-label">主题</strong><p className="muted">只作用于此浏览器，离线也可切换。</p></div>
  <div className="segmented" role="radiogroup" aria-labelledby="appearance-label">{OPTIONS.map(([key,label])=>
   <button key={key} type="button" role="radio" aria-checked={value===key} className={value===key?'selected':''} onClick={()=>choose(key)}>{label}</button>)}</div>
 </div>;
}
