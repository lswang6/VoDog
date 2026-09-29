import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {
  VOICE_PROVIDER_FOOTER,
  voiceProviderDisabledReason,
  voiceProviderErrorMessage,
  voiceProviderLabel,
  voiceProviderList,
  voiceProviderSelected,
  voiceProviderShouldSubmit,
  voiceProviderStatusLabel,
  type VoiceProviderDto,
  type VoiceProviderListDto,
} from './voice-provider';
import type {ApiRequest} from './contacts';
import {useVisibleRefresh} from './visible-refresh';

/**
 * 设置页「AI 语音服务」分组 (S24 决策 3).
 *
 * A native radio group: one request in flight at a time, unavailable providers disabled with the reason on
 * their own row, and the 勾 restored on any failure — the panel must never claim a provider the server did
 * not accept. Foreground refreshes keep availability current; overlapping reads share one request so a slow
 * response can still become the current snapshot.
 */
function errorCode(error: unknown): string {
  const code = (error as {code?: unknown})?.code;
  return typeof code === 'string' ? code : '';
}
function errorStatus(error: unknown): number {
  const status = (error as {status?: unknown})?.status;
  return typeof status === 'number' ? status : 0;
}

export function VoiceProviderPanel({
  busy,
  run,
  request,
  reloadToken = 0,
  intervalMs,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<boolean>;
  request: ApiRequest;
  reloadToken?: number;
  intervalMs?: number;
}) {
  const [items, setItems] = useState<VoiceProviderDto[] | null>(null);
  const [selected, setSelected] = useState('');
  const [configVersion, setConfigVersion] = useState(1);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [pending, setPending] = useState('');
  const [operationConflict, setOperationConflict] = useState<{attempted: string} | null>(null);
  useReportedError('设置', 'voice-provider.load', error);
  useReportedError('设置', 'voice-provider.conflict', operationConflict ? `AI 语音服务已在其他设备更新。刚才尝试选择「${operationConflict.attempted}」未写入；请确认服务器当前选择后再继续。` : '');
  const readEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const pendingRef = useRef(false);
  const requestRef = useRef(request);
  const readInFlight = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  requestRef.current = request;

  function load():Promise<boolean> {
    if (!mounted.current || pendingRef.current) return Promise.resolve(false);
    if (readInFlight.current) return readInFlight.current;
    const captured = readEpoch.current;
    const scopedRequest = requestRef.current;
    const task = (async () => {
      try {
        const result = await scopedRequest<VoiceProviderListDto>('/ai/voice-providers');
        if (!mounted.current || captured !== readEpoch.current) return false;
        const list = voiceProviderList(result);
        setItems(list.items);
        setSelected(list.selected);
        setConfigVersion(list.configVersion);
        setUnsupported(false);
        setError('');
        return true;
      } catch (caught) {
        if (!mounted.current || captured !== readEpoch.current) return false;
        // An older Control has no voice-provider routes; that is a missing feature, not a failure to report.
        if (errorStatus(caught) === 404) {
          setUnsupported(true);
          setItems([]);
          setError('');
          return false;
        }
        setError(caught instanceof Error ? caught.message : '无法读取语音服务');
        return false;
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
      readEpoch.current++;
      mutationEpoch.current++;
      pendingRef.current = false;
      readInFlight.current = null;
    };
  }, []);
  useEffect(() => {
    readEpoch.current++;
    readInFlight.current = null;
    void load();
  }, [request]);
  useEffect(() => { void load(); }, [reloadToken]);
  useVisibleRefresh(() => { void load(); }, intervalMs, false);

  function choose(item: VoiceProviderDto) {
    if (pending || operationConflict || !voiceProviderShouldSubmit(item, selected)) return;
    const previous = selected;
    setError('');
    // `run` is the page-wide single-action guard; it returns without ever calling the action when another
    // action is already in flight, so the optimistic move has to happen *inside* it — otherwise a refused
    // `run` would leave `pending` set and the 勾 on a provider that was never submitted. The action body
    // still runs synchronously up to the request, so the 勾 moves in the same frame as the click.
    // The failure is handled here so the settings-page banner never doubles this section's own message.
    void run(async () => {
      const captured = ++mutationEpoch.current;
      readEpoch.current++;
      readInFlight.current = null;
      setPending(item.id);
      pendingRef.current = true;
      setOperationConflict(null);
      setSelected(item.id);
      try {
        const result = await requestRef.current<VoiceProviderListDto>(
          '/ai/voice-provider',
          {provider: item.id, expectedVersion: configVersion},
          'PUT',
        );
        if (!mounted.current || captured !== mutationEpoch.current) return;
        const list = voiceProviderList(result);
        setItems(list.items);
        setSelected(list.selected);
        setConfigVersion(list.configVersion);
      } catch (caught) {
        if (!mounted.current || captured !== mutationEpoch.current) return;
        const code = errorCode(caught);
        if (errorStatus(caught) === 428 || code === 'PROVIDER_VERSION_REQUIRED' || code === 'PROVIDER_VERSION_CONFLICT') {
          setOperationConflict({attempted: voiceProviderLabel(item)});
          setSelected(previous);
          pendingRef.current = false;
          await load();
        } else {
          setSelected(previous);
          setError(voiceProviderErrorMessage(code, caught instanceof Error ? caught.message : ''));
        }
      } finally {
        if (mounted.current && captured === mutationEpoch.current) {
          pendingRef.current = false;
          setPending('');
        }
      }
    });
  }

  if (unsupported) return null;

  return (
    <>
      <h2>AI 语音服务</h2>
      <p className="muted">选择由哪个供应商来接听 AI 来电。</p>
      {error && (
        <div className="error" role="alert"><p>{error}</p><button type="button" className="passkey" disabled={busy || Boolean(pending)} onClick={() => void load()}>重试读取语音服务</button></div>
      )}
      {operationConflict && (
        <div className="error provider-conflict" role="alert">
          <p>AI 语音服务已在其他设备更新。刚才尝试选择「{operationConflict.attempted}」未写入；请确认服务器当前选择后再继续。</p>
          <button
            type="button"
            className="passkey"
            disabled={busy || Boolean(pending)}
            onClick={() => void load().then(fresh => {if (fresh) setOperationConflict(null);})}
          >
            重新读取并确认当前选择
          </button>
        </div>
      )}
      {items === null ? (
        <p className="muted">正在读取语音服务…</p>
      ) : !items.length ? (
        // A failed read already says why; "没有可选的语音服务" under an error would contradict it.
        !error && <p className="muted">没有可选的语音服务。</p>
      ) : (
        <fieldset className="voice-provider-list">
          <legend className="sr-only">AI 语音服务</legend>
          {items.map(item => {
            const reason = voiceProviderDisabledReason(item);
            const checked = voiceProviderSelected(item, selected);
            return (
              <label className="voice-provider-row" key={item.id}>
                <input
                  type="radio"
                  name="voice-provider"
                  value={item.id}
                  checked={checked}
                  disabled={busy || Boolean(reason) || Boolean(pending) || Boolean(operationConflict)}
                  onChange={() => choose(item)}
                />
                <span className="voice-provider-summary">
                  <strong>{voiceProviderLabel(item)}</strong>
                  <small className={reason ? 'voice-provider-status unavailable' : 'voice-provider-status'}>
                    {!reason && <span className="voice-provider-check" aria-hidden="true">✓</span>}
                    {voiceProviderStatusLabel(item)}
                    {pending === item.id ? ' · 正在切换…' : ''}
                  </small>
                  {/* The reason a row cannot be chosen belongs on that row, not in a banner elsewhere. */}
                  {reason && <small className="note">{reason}</small>}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      <p className="note">{VOICE_PROVIDER_FOOTER}</p>
    </>
  );
}
