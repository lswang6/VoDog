export type IconName='phone'|'messages'|'history'|'contacts'|'settings'|'gateways'|'microphone'|'microphone-off'|'hangup'|'blocked'|'info'|'key'|'search'|'backspace'|'copy'|'more'|'compose'|'offline'|'warning'|'send';
const ring=(cx:number,cy:number,r:number)=>`M${cx-r} ${cy}a${r} ${r} 0 1 0 ${2*r} 0a${r} ${r} 0 1 0 ${-2*r} 0`;
const paths:Record<IconName,string>={
 phone:'M6.5 3.5h3l1.6 4.4-2.1 1.3a11 11 0 0 0 5.8 5.8l1.3-2.1 4.4 1.6v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z',
 messages:'M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5z',
 history:'M4 12a8 8 0 1 0 2.4-5.7L4 8.6M4 4v4.6h4.6M12 8v4.2l2.8 1.8',
 contacts:ring(12,8.5,3.5)+'M5 19.5c1.3-3.3 3.9-5 7-5s5.7 1.7 7 5',
 settings:'M4 7h9M17 7h3M4 17h3M11 17h9'+ring(15,7,2)+ring(9,17,2),
 gateways:'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3 3h4m-3 14h2',
 microphone:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6',
 'microphone-off':'M9 5a3 3 0 0 1 6 0v7M9 9v3a3 3 0 0 0 5 2m-8-3v1a6 6 0 0 0 10 4m2-5v1m-6 6v4m-3 0h6M3 3l18 18',
 hangup:'M3 15v-3c5-5 13-5 18 0v3a1 1 0 0 1-1 1h-4v-4a13 13 0 0 0-8 0v4H4a1 1 0 0 1-1-1Z',
 blocked:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-6.4 2.6 12.8 12.8',
 info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.2v.6m0 3.2v5.8',
 key:'M14.5 3a6.5 6.5 0 1 1-2.2 12.6L10 18H8v2H6v2H2v-3.5l6.4-6.4A6.5 6.5 0 0 1 14.5 3Zm2 3.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
 search:ring(11,11,6.5)+'M16 16l4 4',
 backspace:'M21 5.5H9.5L3.5 12l6 6.5H21zM12.5 9.5l5 5M17.5 9.5l-5 5',
 copy:'M9 9h10v11H9zM5 15V4h10',
 more:'M5.5 12h.01M12 12h.01M18.5 12h.01',
 compose:'M12 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M17.5 3.5l3 3L12 15l-4 1 1-4z',
 offline:'M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4-2.4M19 12.9a10 10 0 0 0-2.6-1.9M2 9.3a15 15 0 0 1 4.3-2.8M22 9.3A15 15 0 0 0 11 5.1M12 20h.01',
 warning:'M12 4 2.8 19.5h18.4L12 4zM12 10v4.5M12 17.2h.01',
 send:'M12 19V5M6 11l6-6 6 6',
};
export function UiIcon({name,size=20}:{name:IconName;size?:number}){return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>;}
