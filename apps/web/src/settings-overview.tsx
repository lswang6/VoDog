import React, {useEffect, useState} from 'react';
import {useReportedError} from './ui-error';
import type {Sim} from './call-history-panel';

export function accountRoleLabel(role?: string): string {
  if (role === 'admin') return '管理员';
  if (role === 'user') return '用户';
  return '暂不可用';
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

type CapabilityState = 'granted' | 'denied' | 'prompt' | 'unavailable' | 'unknown';
const microphoneLabel = (state: CapabilityState) =>
  state === 'granted' ? '麦克风已允许' :
  state === 'denied' ? '麦克风已阻止，请在浏览器网站设置中允许' :
  state === 'prompt' ? '麦克风尚未授权' :
  state === 'unavailable' ? '此浏览器不支持麦克风' : '麦克风权限暂不可用';

export function SettingsOverview({
  username,
  role,
  sims,
  busy,
  refreshStatus,
  reloadToken = 0,
  onRefresh,
}: {
  username: string;
  role?: string;
  sims: Sim[];
  busy: boolean;
  refreshStatus?: string;
  reloadToken?: number;
  onRefresh: () => void;
}) {
  const [online, setOnline] = useState(browserOnline);
  const [microphone, setMicrophone] = useState<CapabilityState>('unknown');
  const [permissionError, setPermissionError] = useState('');
  useReportedError('设置', 'permission', permissionError);

  async function readCapabilities() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setMicrophone('unavailable');
      return;
    }
    try {
      if (!navigator.permissions?.query) { setMicrophone('unknown'); return; }
      const result = await navigator.permissions.query({name: 'microphone' as PermissionName});
      setMicrophone(result.state);
    } catch {
      setMicrophone('unknown');
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setOnline(browserOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => { void readCapabilities(); }, [reloadToken]);

  async function requestMicrophone() {
    setPermissionError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      stream.getTracks().forEach(track => track.stop());
      await readCapabilities();
      setMicrophone('granted');
    } catch (caught) {
      await readCapabilities();
      setPermissionError(caught instanceof Error ? `麦克风未启用：${caught.message}` : '麦克风未启用');
    }
  }

  const connected = sims.filter(sim => sim.online && sim.present !== false).length;

  return (
    <>
      <h2>账号</h2>
      <dl className="settings-facts">
        <div><dt>用户名</dt><dd>{username}</dd></div>
        <div><dt>角色</dt><dd>{accountRoleLabel(role)}</dd></div>
        <div><dt>当前会话</dt><dd>Web 浏览器 · 此设备</dd></div>
      </dl>
      <hr />
      <div className="panel-heading settings-heading">
        <div>
          <h2>设备与连接</h2>
          <p className="muted">这里显示当前浏览器与账号下网关设备的连接情况。</p>
        </div>
        <button type="button" className="passkey" disabled={busy} onClick={() => { void readCapabilities(); onRefresh(); }}>
          {busy ? '正在刷新…' : '刷新全部设置'}
        </button>
      </div>
      <dl className="settings-facts">
        <div><dt>当前设备</dt><dd>Web 浏览器</dd></div>
        <div><dt>浏览器网络</dt><dd>{online ? '已连接' : '离线'}</dd></div>
        <div><dt>网关设备</dt><dd>{connected ? `${connected} 个号码在线` : '目前没有在线号码'}</dd></div>
        <div><dt>麦克风</dt><dd>{microphoneLabel(microphone)}</dd></div>
        <div><dt>来电通知</dt><dd>页面内铃声 · 需保持页面打开</dd></div>
      </dl>
      <div className="settings-permission-actions">
        {microphone !== 'granted' && microphone !== 'unavailable' && <button type="button" className="passkey" disabled={busy} onClick={() => void requestMicrophone()}>检查并允许麦克风</button>}
      </div>
      {permissionError && <p className="error" role="alert">{permissionError}</p>}
      <p className="note">Web 目前不发送后台系统来电通知；实际来电以当前打开页面的铃声和网关状态为准。</p>
      {refreshStatus && <p className="note" role="status">{refreshStatus}</p>}
    </>
  );
}
