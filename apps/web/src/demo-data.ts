import type {ApiRequest} from './contacts';
import type {Call,Sim} from './call-history-panel';
import type {ThreadMessage} from './message-threads';
import type {ReportItem} from './reports';
export const demoSim:Sim={id:'demo-sim',gatewayId:'demo-gateway',label:'工作号',phoneLabel:'+1 202 555 0100',gatewayKind:'pixel',online:true,present:true,telephonyReady:false,mediaReady:false,smsReady:false,timeZone:'UTC',settings:{mode:'ai',version:1,appliedVersion:1,timeoutSeconds:20}};
/** Second, offline line so the sidebar 线路 list shows both states. */
export const demoSims:Sim[]=[demoSim,{id:'demo-sim-2',gatewayId:'demo-gateway-2',label:'个人号',phoneLabel:'+1 202 555 0199',gatewayKind:'dji4g',online:false,present:true,timeZone:'UTC',settings:{mode:'normal',version:1,appliedVersion:1,timeoutSeconds:20}}];
export const demoCalls:Call[]=[
 {id:'00000000-0000-4000-8000-000000000001',simId:demoSim.id,direction:'incoming',remoteNumber:'+12025550101',contactName:'星舟工作室（虚构）',state:'ended',startedAt:'2026-09-30T09:40:00Z',answeredAt:'2026-09-30T09:40:04Z',endedAt:'2026-09-30T09:42:18Z',answeredByPlatform:'ai',answerMode:'ai',unseen:true},
 {id:'00000000-0000-4000-8000-000000000002',simId:demoSim.id,direction:'outgoing',remoteNumber:'+12025550102',contactName:'林小禾（虚构）',state:'ended',startedAt:'2026-09-30T09:15:00Z',answeredAt:'2026-09-30T09:15:03Z',endedAt:'2026-09-30T09:18:24Z',originatingPlatform:'web'},
 {id:'00000000-0000-4000-8000-000000000003',simId:'demo-sim-2',direction:'incoming',remoteNumber:'+12025550103',contactName:'纸飞机设计（虚构）',state:'ended',startedAt:'2026-09-29T18:52:00Z'},
 {id:'00000000-0000-4000-8000-000000000004',simId:demoSim.id,direction:'incoming',remoteNumber:'+12025550104',contactName:'陈小舟（虚构）',state:'ended',startedAt:'2026-09-28T08:30:00Z',answeredAt:'2026-09-28T08:30:02Z',endedAt:'2026-09-28T08:31:10Z',answeredByPlatform:'ios'}
];
export const demoMessages:ThreadMessage[]=[
 ['1','incoming','早上好！周四的设计评审，我们改到下午两点可以吗？','09:30'],
 ['2','outgoing','可以，已为你预留。请把需要讨论的草图带来。','09:32'],
 ['3','incoming','好的，我会带上两个配色方案。到时候见！','09:34'],
].map(([id,direction,body,time])=>({id:'demo-message-'+id,simId:demoSim.id,direction,remoteNumber:'+12025550101',contactName:'星舟工作室（虚构）',body,state:direction==='incoming'?'received':'delivered',createdAt:`2026-09-30T${time}:00Z`,canReply:true}));
demoMessages.push({id:'demo-message-4',simId:demoSim.id,direction:'incoming',remoteNumber:'+12025550102',contactName:'林小禾（虚构）',body:'演示样品已经准备好了，明天一起看看。',state:'received',createdAt:'2026-09-29T08:50:00Z',canReply:true});
export const demoReport:ReportItem={callId:demoCalls[0].id,startedAt:demoCalls[0].startedAt,answeredAt:demoCalls[0].answeredAt,endedAt:demoCalls[0].endedAt,direction:'incoming',remoteNumber:demoCalls[0].remoteNumber,contactName:demoCalls[0].contactName,sim:{id:demoSim.id,label:demoSim.label},gatewayTimeZone:'UTC',answerMode:'ai',answeredByPlatform:'ai',recordingStatus:'none',transcriptState:'none',hasAiTranscript:true,blockRecommended:false,summary:'星舟工作室确认周四下午两点的设计评审。将携带两套配色草图，希望预留半小时讨论。此摘要为人工编写的虚构演示内容。',actionItems:['周四 14:00 · 设计评审（虚构日程）','准备展示屏与两个配色方案']};
export const demoDialogue=[{role:'ai',text:'你好，这里是演示工作室的 VoDog 助理。请问有什么可以帮你？'},{role:'caller',text:'想确认一下，周四下午两点的设计评审方便吗？我们会带上两套配色方案。'},{role:'ai',text:'已记录：周四下午两点，讨论两套配色方案。我会把你的留言整理给工作室。'}];
export const demoRequest:ApiRequest=async <T>(path:string,body?:unknown,method?:string):Promise<T>=>{
 if(body!==undefined||(method&&method!=='GET'))throw new Error('本地演示不执行写入或通信操作。');
 const url=new URL(path,'https://demo.example.com');let result:unknown;
 if(url.pathname==='/calls'){
  const query=(url.searchParams.get('query')||'').toLowerCase();const items=demoCalls.filter(c=>`${c.contactName} ${c.remoteNumber}`.toLowerCase().includes(query));result={items,total:items.length,totalPages:1};
 }else if(url.pathname==='/reports/calls'){
  const query=(url.searchParams.get('query')||'').toLowerCase();const items=`${demoReport.contactName} ${demoReport.remoteNumber}`.toLowerCase().includes(query)?[demoReport]:[];result={items,total:items.length,totalPages:1};
 }else if(url.pathname.endsWith('/ai-transcript'))result={items:demoDialogue};
 else if(url.pathname.endsWith('/transcript'))result={transcript:null};
 else if(url.pathname.endsWith('/recordings'))result={recording:null};
 else if(url.pathname.startsWith('/calls/'))result={call:demoCalls.find(c=>url.pathname==='/calls/'+c.id)};
 else throw new Error('演示中未提供此数据。');
 return structuredClone(result) as T;
};
export function demoHostAllowed(host:string){return host==='127.0.0.1'||host==='localhost'||host==='[::1]';}
