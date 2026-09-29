import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {
  GATEWAY_POWER_REFRESH_MS,
  gatewayPowerErrorMessage,
  gatewayPowerPendingLabel,
  gatewayPowerStatusLabel,
  gatewayPowerToggle,
  lastPowerResultText,
  remotePowerAllowedLabel,
  type GatewayPowerDto,
} from './gateway-power';
import type {ApiRequest} from './contacts';
import {ConfirmAction} from './confirm-action';
import {gatewayKindLabel} from './gateway-kind';
import {useVisibleRefresh} from './visible-refresh';

/**
 * 网关设备 remote power section of 设置 (S21 §D/§F).
 *
 * It polls `/gateways/power` every 5 s while the 设置 tab is mounted — that route reads the standby beacon,
 * which is the only channel a switched-off gateway keeps open, so a stale view would offer a switch that
 * cannot work. The server re-checks every precondition; the client only avoids certain-to-fail requests and
 * translates the 409 codes.
 */
function errorCode(error: unknown): string {
  const code = (error as {code?: unknown})?.code;
  return typeof code === 'string' ? code : '';
}
function errorStatus(error: unknown): number {
  const status = (error as {status?: unknown})?.status;
  return typeof status === 'number' ? status : 0;
}

export function GatewayPowerPanel({
  busy,
  run,
  request,
  reloadToken = 0,
  intervalMs = GATEWAY_POWER_REFRESH_MS,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<boolean>;
  request: ApiRequest;
  reloadToken?: number;
  intervalMs?: number;
}) {
  const [items, setItems] = useState<GatewayPowerDto[] | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  useReportedError('设置', 'gateway-power.load', error);
  useReportedError('设置', 'gateway-power.action', actionError);
  const [unsupported, setUnsupported] = useState(false);
  const [confirmOffId, setConfirmOffId] = useState<string | null>(null);
  const epoch = useRef(0);
  const pendingRef = useRef(false);
  const requestRef = useRef(request);
  const readInFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  requestRef.current = request;

  function load(): Promise<void> {
    if (!mounted.current) return Promise.resolve();
    if (pendingRef.current) return Promise.resolve();
    if (readInFlight.current) return readInFlight.current;
    const captured = epoch.current;
    const scopedRequest = requestRef.current;
    const task = (async () => {
      try {
        const result = await scopedRequest<{items: GatewayPowerDto[]}>('/gateways/power');
        if (!mounted.current || captured !== epoch.current) return;
        setItems(result.items || []);
        setConfirmOffId(current => current && result.items.some(item => item.gatewayId === current && item.controlEnabled) ? current : null);
        setUnsupported(false);
        setError('');
      } catch (caught) {
        if (!mounted.current || captured !== epoch.current) return;
        // An older Control has no power routes; that is a missing feature, not a failure to report loudly.
        if (errorStatus(caught) === 404) {
          setUnsupported(true);
          setItems([]);
          setError('');
          return;
        }
        setError(caught instanceof Error ? caught.message : '无法读取网关状态');
      }
    })();
    const tracked = task.finally(() => {
      if (readInFlight.current === tracked) readInFlight.current = null;
    });
    readInFlight.current = tracked;
    return tracked;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      pendingRef.current = false;
      readInFlight.current = null;
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    readInFlight.current = null;
    void load();
  }, [request]);
  useEffect(() => { void load(); }, [reloadToken]);
  useVisibleRefresh(load, intervalMs, false);

  function setPower(item: GatewayPowerDto, desired: 'on' | 'off') {
    setActionError('');
    void run(async () => {
      pendingRef.current = true;
      const captured = ++epoch.current;
      readInFlight.current = null;
      try {
        const result = await requestRef.current<{item: GatewayPowerDto}>(`/gateways/${encodeURIComponent(item.gatewayId)}/power`, {desired});
        if (!mounted.current || captured !== epoch.current) return;
        setItems(current => current?.map(entry => entry.gatewayId === item.gatewayId ? result.item : entry) || [result.item]);
        if (desired === 'off') setConfirmOffId(null);
      } catch (caught) {
        if (!mounted.current || captured !== epoch.current) return;
        setActionError(
          gatewayPowerErrorMessage(errorCode(caught), caught instanceof Error ? caught.message : '操作失败'),
        );
        return;
      } finally {
        pendingRef.current = false;
        if (mounted.current && captured !== epoch.current) void load();
      }
      await load();
    });
  }

  return (
    <>
      <h2>网关设备</h2>
      <p className="muted">
        网关关闭后网关设备恢复本地通话。只有在网关设备上打开“允许远程开启（待命）”，这里才能远程开启。
      </p>
      {unsupported && <p className="note">此服务器尚未启用远程开关。</p>}
      {error && (
        <div className="error" role="alert"><p>{error}</p><button type="button" className="passkey" disabled={busy} onClick={() => void load()}>重试读取网关状态</button></div>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {items === null ? (
        <p className="muted">正在读取网关状态…</p>
      ) : !items.length ? (
        !unsupported && <p className="muted">没有可管理的网关。</p>
      ) : (
        <div className="gateway-power-list">
          {items.map(item => {
            const toggle = gatewayPowerToggle(item);
            const pending = gatewayPowerPendingLabel(item);
            const lastResult = lastPowerResultText(item.lastPowerResult);
            const status = gatewayPowerStatusLabel(item);
            return (
              <article className="record gateway-power-row" key={item.gatewayId}>
                <div className="gateway-power-summary">
                  <strong>{item.name || '网关'}</strong>
                  <small className="gateway-kind">{gatewayKindLabel(item.kind).device}</small>
                  <small className={`gateway-power-status status-${status === '在线' ? 'online' : status === '待命中' ? 'standby' : 'offline'}`}>
                    {status}
                    {item.occupied ? ' · 通话中' : ''}
                  </small>
                  <small>{remotePowerAllowedLabel(item)}</small>
                  {pending && <small role="status">{pending}</small>}
                  {lastResult && <small className="gateway-power-result">{lastResult}</small>}
                </div>
                {confirmOffId === item.gatewayId ? (
                  <ConfirmAction
                    busy={busy}
                    prompt={`关闭 ${item.name || '网关'} 的网关总控？网关设备将恢复本地通话。`}
                    confirmLabel="确认关闭"
                    onConfirm={() => setPower(item, 'off')}
                    onCancel={() => setConfirmOffId(null)}
                  />
                ) : (
                  <div className="record-actions">
                    <button
                      type="button"
                      className={toggle.checked ? 'passkey hangup' : 'passkey'}
                      role="switch"
                      aria-checked={toggle.checked}
                      aria-label={`网关总控 ${item.name || '网关'}`}
                      disabled={busy || toggle.disabled}
                      onClick={() => toggle.checked ? setConfirmOffId(item.gatewayId) : setPower(item, toggle.desired)}
                    >
                      {toggle.checked ? '关闭网关总控' : '开启网关总控'}
                    </button>
                  </div>
                )}
                <small className="note gateway-power-hint">{toggle.hint}</small>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
