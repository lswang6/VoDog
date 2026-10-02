import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CallHistoryPanel,CallList,aiAnsweredCall,missedIncomingCall,type Sim} from './call-history-panel';
import {Messages} from './messages';
import {CallReports} from './reports';
import {Sidebar,StatusPill,simName,simTail,tabTitle} from './shell';
import {AiBadge,SimChip,simColorStyle} from './sim-chip';
import {simPaletteColor} from './sim-palette';
import {UiIcon,type IconName} from './icons';
import {demoSim,demoSims,demoCalls,demoMessages,demoRequest,demoHostAllowed} from './demo-data';
import './style.css';
import './demo.css';
// This entry never imports main.tsx. No login, diagnostics startup, or media setup.

// Demo-only: pin "now" to the fixture day so 今天/昨天 grouping and the 7 天 report window never drift.
const DEMO_NOW=Date.parse('2026-09-30T12:00:00Z');
class DemoDate extends Date{
 constructor(...args:unknown[]){if(args.length)super(...(args as [string]));else super(DEMO_NOW);}
 static now(){return DEMO_NOW;}
}
globalThis.Date=DemoDate as unknown as DateConstructor;

const TABS:[string,IconName][]=[['通话','phone'],['短信','messages'],['记录','history'],['通讯录','contacts'],['设置','settings']];
const KEY_LETTERS:Record<string,string>={'2':'ABC','3':'DEF','4':'GHI','5':'JKL','6':'MNO','7':'PQRS','8':'TUV','9':'WXYZ','0':'+'};

/** Same markup as SimSelector in main.tsx (not importable here: main.tsx boots the app on import). */
function DemoSimBar({sims,selectedId,onSelect,allLabel}:{sims:Sim[];selectedId:string;onSelect:(id:string)=>void;allLabel?:string}){
 return <section className="sim-bar" aria-label="选择 SIM">
  {allLabel&&<button className={selectedId===''?'selected':''} onClick={()=>onSelect('')}><strong>{allLabel}</strong></button>}
  {sims.map(s=>{const on=s.present!==false&&Boolean(s.online),tail=simTail(s);return <button className={selectedId===s.id?'selected':''} key={s.id} style={simColorStyle(simPaletteColor(s,sims))} onClick={()=>onSelect(s.id)}><span className="sim-swatch" aria-hidden="true"/><strong>{simName(s)}</strong>{tail&&<span className="num sim-bar-tail">{tail}</span>}<AiBadge ai={s.settings}/><span className={`sim-dot status-shape ${on?'online':'offline'}`} aria-hidden="true"/><small className={on?'sr-only':''}>{on?'在线':'离线'}</small></button>;})}
 </section>;
}

function Demo(){
 const [tab,setTab]=useState('通话'),[simId,setSimId]=useState(demoSim.id),[recordsSimId,setRecordsSimId]=useState('');
 const [recordsView,setRecordsView]=useState<'calls'|'reports'|'blocked'>('calls'),[recentFilter,setRecentFilter]=useState<'all'|'missed'|'ai'>('all');
 const [number,setNumber]=useState(''),[messages,setMessages]=useState(demoMessages);
 const selected=demoSims.find(s=>s.id===simId)??demoSim,color=simPaletteColor(selected,demoSims);
 const recent=demoCalls.filter(c=>c.simId===simId&&(recentFilter==='all'||(recentFilter==='missed'?missedIncomingCall(c):aiAnsweredCall(c))));
 const recordsSim=demoSims.find(s=>s.id===recordsSimId);
 return <div className="shell"><a className="skip-link" href="#main">跳到主要内容</a>
  <Sidebar tabs={TABS} tab={tab} badge={()=>null} onSelect={setTab} sims={demoSims} username="演示访客" role="user" busy={false} onLogout={()=>{}}/>
  <main id="main" className="workspace">
   <header className="topbar"><h1>{tabTitle(tab)}</h1>
    {tab==='记录'&&<><div className="segmented" role="group" aria-label="记录视图">{([['calls','通话记录'],['reports','转录报告'],['blocked','拦截记录']] as const).map(([value,label])=><button key={value} type="button" className={recordsView===value?'selected':''} aria-pressed={recordsView===value} onClick={()=>setRecordsView(value)}>{label}</button>)}</div><p className="records-scope">范围：{recordsSim?recordsSim.phoneLabel:'全部线路'}</p></>}
    {tab!=='设置'&&<DemoSimBar sims={demoSims} allLabel={tab==='记录'?'全部 SIM 卡':undefined} selectedId={tab==='记录'?recordsSimId:simId} onSelect={tab==='记录'?setRecordsSimId:setSimId}/>}
    <StatusPill kind="ok"/>
   </header>
   <div className="page">
    {tab==='通话'&&<div className="columns call-columns">
     <section className="panel dialer"><div className="panel-heading"><div><h2>拨打电话</h2></div><span className="sim-chip dial-from" style={simColorStyle(color)}><span className="sim-swatch" aria-hidden="true"/>从 {simName(selected)} 拨出<AiBadge ai={selected.settings}/></span></div>
      <label className="sr-only" htmlFor="number">电话号码</label><div className="number-entry"><input id="number" autoComplete="off" inputMode="tel" className="number" value={number} onChange={e=>setNumber(e.target.value)} type="tel" placeholder="输入电话号码…"/></div>
      <div className="dial-hint-slot"><p className="note dial-hint" role="status">{' '}</p></div>
      <div className="keypad">{'123456789*0#'.split('').map(k=><button key={k} data-static onClick={()=>setNumber(n=>n+k)}>{k}{KEY_LETTERS[k]&&<small aria-hidden="true">{KEY_LETTERS[k]}</small>}</button>)}</div>
      <div className="dial-actions"><span/><button className="primary call-button" aria-label="拨打电话（演示中不可用）" disabled><UiIcon name="phone" size={28}/></button><button className="delete-digit" aria-label="删除一位号码" disabled={!number} onClick={()=>setNumber(n=>n.slice(0,-1))}><UiIcon name="backspace" size={26}/></button></div>
      <p className="note dial-tip">本地演示不会拨出电话 · 所有数据均为虚构</p>
     </section>
     <section className="panel recent-calls"><div className="panel-heading"><h2>最近通话</h2><div className="segmented compact" role="group" aria-label="筛选最近通话">{([['all','全部'],['missed','未接'],['ai','AI 代接']] as const).map(([value,label])=><button key={value} type="button" className={recentFilter===value?'selected':''} aria-pressed={recentFilter===value} onClick={()=>setRecentFilter(value)}>{label}</button>)}</div><button type="button" className="link-button" onClick={()=>{setRecordsView('calls');setRecordsSimId(simId);setTab('记录');}}>在记录中查看全部</button></div>
      <div className="recent-call-list"><CallList calls={recent} sims={demoSims} sessionUsername="demo" busy={true}/></div>
     </section>
    </div>}
    {tab==='短信'&&<Messages fromChip={<SimChip name={simName(selected)} color={color} tail={simTail(selected)} ai={selected.settings}/>} messages={messages.filter(m=>m.simId===simId)} simId={simId} simLabel={selected.phoneLabel||simName(selected)} online={selected.online===true} busy={false} timeZone="UTC" onSend={async(number,body)=>{setMessages(items=>[...items,{id:crypto.randomUUID(),simId,direction:'outgoing',remoteNumber:number,contactName:items.find(item=>item.remoteNumber===number)?.contactName,body,state:'sent',createdAt:new Date().toISOString(),canReply:true}]);}}/>}
    {tab==='记录'&&(recordsView==='calls'?<CallHistoryPanel request={demoRequest} simId={recordsSimId} sims={demoSims} sessionUsername="demo" busy={true}/>
     :recordsView==='reports'?<CallReports request={demoRequest} simId={recordsSimId} timeZone="UTC" busy={true}/>
     :<section className="panel"><p className="note">本地演示不包含拦截记录。</p></section>)}
    {(tab==='通讯录'||tab==='设置')&&<section className="panel"><p className="note">本地演示不包含{tabTitle(tab)}；所有数据均为虚构，不连接服务。</p></section>}
   </div>
  </main>
 </div>;
}
const root=createRoot(document.getElementById('root')!);
if(!demoHostAllowed(location.hostname))root.render(<p>Local demo is available on loopback only.</p>);
else{
 // Existing report/recording readers use fetch; never delegate to native fetch.
 globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith('/api/v1/'))throw new Error('Local demo blocks network requests.');
  const data=await demoRequest(url.pathname.slice('/api/v1'.length)+url.search,init?.body,init?.method);
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
 };
 root.render(<Demo/>);
}
