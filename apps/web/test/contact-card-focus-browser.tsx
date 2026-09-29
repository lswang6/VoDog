import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContactCard} from '../src/contact-card';
import {ConfirmAction} from '../src/confirm-action';
import {ContactsPanel} from '../src/contacts-panel';
import '../src/style.css';

declare global {
  interface Window { contactCardFocusHarness: {removeOpenerOnClose: boolean}; }
}

window.contactCardFocusHarness = {removeOpenerOnClose: false};

const contactExample={
  id:'danger-contact',version:3,displayName:'颜色验收联系人',
  phones:[{rawNumber:'2025550130',label:'手机'}],
  emails:[{address:'danger@example.test',label:'工作'}],
  addresses:[{formatted:'台北市信义路 1 号',label:'工作'}],
};
async function contactExampleRequest<T>(path:string):Promise<T>{
  if(path.startsWith('/contacts?'))return {items:[contactExample]} as T;
  return {} as T;
}

function Harness() {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  const [removeOpener, setRemoveOpener] = useState(false);
  const close = () => {
    setOpen(false);
    if (window.contactCardFocusHarness.removeOpenerOnClose) {
      setShowOpener(false);
      window.setTimeout(() => setShowOpener(true), 3000);
    }
  };
  return <main style={{padding:32}}>
    <h1>联系人卡片焦点验收</h1>
    <section aria-label="危险操作颜色验收" className="panel" style={{marginBottom:24}}>
      <h2>危险操作颜色验收</h2>
      <div className="record-actions">
        <button id="danger-delete" type="button" className="passkey hangup">删除联系人</button>
        <button id="danger-block" type="button" className="passkey hangup">屏蔽号码</button>
        <button id="danger-end-call" type="button" className="end-call">停止通话</button>
      </div>
      <div className="conversation-actions" style={{marginTop:12}}>
        <div className="conversation-action-row">
          <button id="danger-unblock" type="button" className="passkey hangup">解除屏蔽</button>
          <button id="danger-disabled" type="button" className="passkey hangup" disabled>删除并屏蔽</button>
        </div>
      </div>
      <ConfirmAction busy={false} prompt="删除后无法恢复。" confirmLabel="确认删除" onConfirm={() => {}} onCancel={() => {}} />
      <div className="account" style={{marginTop:16}}><button id="danger-logout" type="button" className="passkey hangup">退出登录</button></div>
    </section>
    <section id="contact-removal-example" aria-label="联系人字段移除颜色验收">
      <ContactsPanel busy={false} run={async action=>{await action();return true;}} request={contactExampleRequest}/>
    </section>
    <label style={{marginBottom:20}}><span>关闭时暂时移除打开按钮</span><input type="checkbox" checked={removeOpener} onChange={event=>{setRemoveOpener(event.target.checked);window.contactCardFocusHarness.removeOpenerOnClose=event.target.checked;}}/></label>
    {showOpener && <button id="focus-opener" type="button" onClick={() => setOpen(true)}>打开联系人卡片</button>}
    <button id="unrelated-control" type="button">另一个控件</button>
    {open && <ContactCard
      target={{remoteNumber:'2025550130', simId:'sim-1'}}
      busy={false}
      mediaLive={false}
      request={async <T,>(path:string):Promise<T> => path==='/blocklist?scope=call' ? {items:[]} as T : {item:null} as T}
      run={async action => {await action(); return true;}}
      onClose={close}
      onCall={() => {}}
      onSms={() => {}}
      onCreateContact={() => {}}
    />}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);
