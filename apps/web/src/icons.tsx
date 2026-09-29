export type IconName='phone'|'messages'|'history'|'contacts'|'settings'|'gateways'|'microphone'|'microphone-off'|'hangup'|'blocked'|'info'|'key';
const paths:Record<IconName,string>={
 phone:'M8 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a15 15 0 0 1-6-6l2-2-2-5Z',
 messages:'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 3-2Zm2 5h10M7 13h7',
 history:'M3 12a9 9 0 1 0 2.6-6.4L3 8m0-5v5h5m4-1v5l3 2',
 contacts:'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm-3 5h2M3 12h2M3 17h2',
 settings:'m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3H9Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
 gateways:'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3 3h4m-3 14h2',
 microphone:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6',
 'microphone-off':'M9 5a3 3 0 0 1 6 0v7M9 9v3a3 3 0 0 0 5 2m-8-3v1a6 6 0 0 0 10 4m2-5v1m-6 6v4m-3 0h6M3 3l18 18',
 hangup:'M3 15v-3c5-5 13-5 18 0v3a1 1 0 0 1-1 1h-4v-4a13 13 0 0 0-8 0v4H4a1 1 0 0 1-1-1Z',
 blocked:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-6.4 2.6 12.8 12.8',
 info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.2v.6m0 3.2v5.8',
 key:'M14.5 3a6.5 6.5 0 1 1-2.2 12.6L10 18H8v2H6v2H2v-3.5l6.4-6.4A6.5 6.5 0 0 1 14.5 3Zm2 3.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
};
export function UiIcon({name}:{name:IconName}){return <svg className="ui-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>;}
