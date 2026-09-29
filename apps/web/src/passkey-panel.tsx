import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {startRegistration} from '@simplewebauthn/browser';
import {ConfirmAction} from './confirm-action';
import {PASSKEY_DELETE_PROMPT} from './confirm-copy';

export type PasskeyItem = {
  id: string;
  createdAt: string;
  deviceType: string;
  backedUp?: boolean;
  transports?: string[];
  label?: string | null;
  displayName?: string;
  aaguid?: string | null;
  clientPlatform?: string | null;
  authenticatorAttachment?: 'platform' | 'cross-platform' | null;
  lastUsedAt?: string | null;
};

export type PasskeyRequest = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

export function passkeyDeviceLabel(deviceType: string): string {
  if (deviceType === 'singleDevice' || deviceType === 'platform') return '本机';
  if (deviceType === 'multiDevice' || deviceType === 'cross-platform') return '已同步';
  return deviceType || '未知';
}

/** Passkeys are account-level, so the browser locale formats their timestamps, not the gateway time zone. */
const passkeyTime = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
function passkeyTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : passkeyTime.format(date);
}

export function passkeyName(item: PasskeyItem): string {
  return item.label || item.displayName || passkeyDeviceLabel(item.deviceType);
}

/** Older servers send neither attachment nor client platform, so the device type stays the only label. */
export function passkeyPlatformLabel(item: PasskeyItem): string {
  const parts: string[] = [];
  if (item.authenticatorAttachment === 'platform') parts.push('本机');
  else if (item.authenticatorAttachment === 'cross-platform') parts.push('跨设备');
  if (item.backedUp === true) parts.push('已同步');
  if (item.clientPlatform) parts.push(item.clientPlatform);
  return parts.length ? parts.join(' · ') : passkeyDeviceLabel(item.deviceType);
}

export function passkeyLabelError(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '请输入 1 到 64 个字符的名称';
  if (trimmed.length > 64) return '名称最多 64 个字符';
  return '';
}

export function PasskeyPanel({
  busy,
  run,
  request,
  reloadToken = 0,
  register = startRegistration,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<boolean>;
  request: PasskeyRequest;
  reloadToken?: number;
  register?: (args: {optionsJSON: any}) => Promise<unknown>;
}) {
  const [items, setItems] = useState<PasskeyItem[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [renameError, setRenameError] = useState('');
  const [error, setError] = useState('');
  useReportedError('设置', 'passkey.load', error);
  useReportedError('设置', 'passkey.rename', renameError);
  const [registrationAwaitingRefresh, setRegistrationAwaitingRefresh] = useState(false);
  const epoch = useRef(0);

  async function reload() {
    const captured = ++epoch.current;
    let result: {items: PasskeyItem[]};
    try {
      result = await request<{items: PasskeyItem[]}>('/passkeys');
    } catch (caught) {
      if (captured !== epoch.current) return false;
      throw caught;
    }
    if (captured !== epoch.current) return false;
    setItems(result.items);
    setRegistrationAwaitingRefresh(false);
    setError('');
    return true;
  }

  async function reloadAfterAccepted(message: string) {
    try {
      await reload();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : '读取失败';
      setError(`${message}，但通行密钥列表暂未刷新：${detail}`);
    }
  }

  function startRename(item: PasskeyItem) {
    setConfirmId(null);
    setRenameId(item.id);
    setRenameLabel(passkeyName(item));
    setRenameError('');
    setError('');
  }

  function cancelRename() {
    setRenameId(null);
    setRenameLabel('');
    setRenameError('');
  }

  function saveRename(item: PasskeyItem) {
    const invalid = passkeyLabelError(renameLabel);
    setRenameError(invalid);
    if (invalid) return;
    void run(async () => {
      const captured = ++epoch.current;
      let renamed!: PasskeyItem;
      try {
        const result = await request<{item: PasskeyItem}>(`/passkeys/${encodeURIComponent(item.id)}`, {label: renameLabel.trim()}, 'PATCH');
        renamed = result.item;
      } catch (caught) {
        if (captured !== epoch.current) return;
        setError(caught instanceof Error ? caught.message : '重命名失败');
        return;
      }
      if (captured !== epoch.current) return;
      setItems(current => current?.map(entry => entry.id === item.id ? renamed : entry) || [renamed]);
      setRenameId(null);
      setRenameLabel('');
      await reloadAfterAccepted('名称已保存');
    });
  }

  useEffect(() => {
    void reload().catch(caught => setError(caught instanceof Error ? caught.message : '无法读取通行密钥'));
  }, [reloadToken, request]);
  useEffect(() => () => { epoch.current++; }, []);

  return (
    <>
      <h2>通行密钥</h2>
      {error && (
        <div className="error" role="alert"><p>{error}</p><button type="button" className="passkey" disabled={busy} onClick={() => void reload().catch(caught => setError(caught instanceof Error ? caught.message : '无法读取通行密钥'))}>重试读取通行密钥</button></div>
      )}
      {items === null ? (
        <p className="muted">正在读取通行密钥…</p>
      ) : !items.length ? (
        <p className="muted">尚未添加通行密钥</p>
      ) : (
        <div className="passkey-list">
          {items.map((item) => (
            <article className="record" key={item.id}>
              <div className="passkey-summary">
                <strong>{passkeyName(item)}</strong>
                <small>{passkeyPlatformLabel(item)}</small>
                <small className="passkey-times">
                  添加于 <time dateTime={item.createdAt}>{passkeyTimeLabel(item.createdAt)}</time>
                  {' · '}
                  {item.lastUsedAt ? (
                    <>
                      最近使用{' '}
                      <time dateTime={item.lastUsedAt}>{passkeyTimeLabel(item.lastUsedAt)}</time>
                    </>
                  ) : (
                    '尚未使用'
                  )}
                </small>
              </div>
              {renameId === item.id ? (
                <div className="passkey-rename">
                  <input
                    aria-label="通行密钥名称"
                    value={renameLabel}
                    disabled={busy}
                    onChange={(event) => setRenameLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        saveRename(item);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                  {renameError && (
                    <p className="error" role="alert">
                      {renameError}
                    </p>
                  )}
                  <div className="record-actions">
                    <button
                      type="button"
                      className="passkey"
                      aria-label="保存通行密钥名称"
                      disabled={busy}
                      onClick={() => saveRename(item)}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="passkey"
                      aria-label="取消重命名通行密钥"
                      disabled={busy}
                      onClick={cancelRename}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : confirmId === item.id ? (
                <ConfirmAction
                  busy={busy}
                  prompt={PASSKEY_DELETE_PROMPT}
                  confirmLabel="确认删除"
                  onConfirm={() =>
                    void run(async () => {
                      const captured = ++epoch.current;
                      await request(`/passkeys/${encodeURIComponent(item.id)}`, undefined, 'DELETE');
                      if (captured !== epoch.current) return;
                      setItems(current => current?.filter(entry => entry.id !== item.id) || []);
                      setConfirmId(null);
                      await reloadAfterAccepted('通行密钥已删除');
                    })
                  }
                  onCancel={() => setConfirmId(null)}
                />
              ) : (
                <div className="record-actions">
                  <button
                    type="button"
                    className="passkey"
                    aria-label={`重命名通行密钥 ${passkeyName(item)}`}
                    disabled={busy}
                    onClick={() => startRename(item)}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="passkey hangup"
                    aria-label={`删除通行密钥 ${passkeyName(item)}`}
                    disabled={busy}
                    onClick={() => {
                      setRenameId(null);
                      setConfirmId(item.id);
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      <button
        className="passkey"
        disabled={busy || registrationAwaitingRefresh}
        onClick={() =>
          void run(async () => {
            const captured = ++epoch.current;
            const options = await request<{challengeId: string; options: any}>(
              '/passkeys/register/options',
              {},
            );
            const response = await register({optionsJSON: options.options});
            await request('/passkeys/register/verify', {challengeId: options.challengeId, response});
            if (captured !== epoch.current) return;
            setRegistrationAwaitingRefresh(true);
            await reloadAfterAccepted('通行密钥已添加');
          })
        }
      >
        {registrationAwaitingRefresh ? '已添加，等待列表刷新' : '添加通行密钥'}
      </button>
    </>
  );
}
