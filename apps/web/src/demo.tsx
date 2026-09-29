import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CallHistoryPanel} from './call-history-panel';
import {Messages} from './messages';
import {CallReports} from './reports';
import {AiTranscript} from './ai-transcript';
import {demoSim,demoCalls,demoMessages,demoRequest,demoHostAllowed} from './demo-data';
import './style.css';
import './demo.css';
// This entry never imports main.tsx. No login, diagnostics startup, or media setup.
function Demo(){
 const [tab,setTab]=useState('calls');
 const [messages,setMessages]=useState(demoMessages);
 return <div className="shell demo-shell"><a className="skip-link" href="#main">跳到主要内容</a><aside><div className="brand"><img src="/icon-192.png" width="38" height="38" alt=""/>VoDog</div><p className="demo-tagline">每一段对话，都有着落。</p><nav aria-label="演示导航">{[['calls','↗','通话'],['messages','✉','短信'],['reports','≋','AI 与录音报告']].map(([id,icon,label])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav><div className="demo-side-note"><strong>一个号码，随处连接</strong><p>通话、短信与 AI 留言<br/>在同一个工作台里。</p></div><div className="account"><strong>演示访客</strong><small>Fictional workspace · 本地体验</small></div></aside><main id="main" className="workspace"><div className="demo-banner"><strong>ILLUSTRATIVE LOCAL DEMO</strong><span>演示专用布局 · 所有数据均为虚构 · 无真实通话或录音 · 不连接服务</span></div><header><div><p className="eyebrow">VODOG / YOUR CONVERSATIONS, TOGETHER</p><h1>{tab==='calls'?'让每一通来电，都被看见。':tab==='messages'?'消息不断，思路不乱。':'接住来电，也记住重点。'}</h1><p className="demo-subtitle">{tab==='calls'?'从接听到回顾，一个清晰的通信工作台。':tab==='messages'?'按联系人聚合对话，让上下文留在眼前。':'AI 对话、重点摘要与录音入口，集中回顾。'}</p></div><span className="demo-date">29 SEP 2026<br/><b>虚构演示 · UTC</b></span></header><div className="demo-line"><div><span className="demo-dot"/><strong>{demoSim.label}</strong><small>+1 202 555 0100</small></div><span>模拟状态 · {tab==='messages'?'本地预览':'只读预览'}</span></div>
 {tab==='calls'&&<><div className="demo-stats">{[['04','近期通话'],['01','AI 留言'],['01','未接来电']].map(([value,label])=><div key={label}><small>{label}</small><strong>{value}</strong><span>虚构样本</span></div>)}</div><CallHistoryPanel request={demoRequest} simId="" sims={[demoSim]} sessionUsername="demo" busy={true}/></>}
 {tab==='messages'&&<><p className="note">本地短信演示：回复仅添加到此页面，刷新即清除，不发送到任何号码。</p><Messages messages={messages} simId={demoSim.id} simLabel={demoSim.label!} online={true} busy={false} timeZone="UTC" onSend={async(number,body)=>{setMessages(items=>[...items,{id:crypto.randomUUID(),simId:demoSim.id,direction:'outgoing',remoteNumber:number,contactName:items.find(item=>item.remoteNumber===number)?.contactName,body,state:'sent',createdAt:new Date().toISOString(),canReply:true}]);}}/></>}
 {tab==='reports'&&<div className="demo-reports"><div><CallReports request={demoRequest} simId="" timeZone="UTC" busy={true}/><div className="demo-recording"><span className="demo-record-icon">◉</span><div><strong>录音归档 · 演示说明</strong><p>这里不包含真实录音。可展开上方录音入口查看空状态。</p></div></div></div><section className="panel demo-dialogue"><p className="eyebrow">FICTIONAL AI CONVERSATION</p><AiTranscript callId={demoCalls[0].id} request={demoRequest}/><p className="demo-disclosure">以上为人工编写的演示对话，未调用 AI 服务。</p></section></div>}
 <footer className="demo-footer">VoDog <span>本地产品演示 · 所有数据均为虚构 · AGPL-3.0</span></footer></main></div>;
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
