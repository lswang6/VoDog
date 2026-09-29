import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {ConfirmAction} from './confirm-action';
import type {ApiRequest} from './contacts';
import {useVisibleRefresh} from './visible-refresh';

export type BlocklistScope = 'call' | 'sms';
export type BlocklistItem = {id: string; remoteNumber: string; contactName?: string | null; createdAt?: string; source?: 'client' | 'phone'; scope?: BlocklistScope};
type BlocklistLists = Record<BlocklistScope, BlocklistItem[]>;

/** S66: two independent lists; both are read together so the summary can show both counts. */
const SCOPES = [['call', '来电'], ['sms', '短信']] as const;

const localBlockDate = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
export function blocklistTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : localBlockDate.format(date);
}

function errorStatus(error: unknown): number {
  const status = (error as {status?: unknown})?.status;
  return typeof status === 'number' ? status : 0;
}

export function BlocklistPanel({
  request,
  busy,
  reloadToken = 0,
  intervalMs = 5000,
  onChanged,
}: {
  request: ApiRequest;
  busy: boolean;
  reloadToken?: number;
  intervalMs?: number;
  onChanged?: () => void;
}) {
  const [lists, setLists] = useState<BlocklistLists | null>(null);
  const [scope, setScope] = useState<BlocklistScope>('call');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useReportedError('记录', 'blocklist', error);
  const [unsupported, setUnsupported] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const epoch = useRef(0);
  const mutatingRef = useRef(false);
  const requestRef = useRef(request);
  const readInFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  requestRef.current = request;

  function load(acceptedMessage = ''): Promise<void> {
    if (!mounted.current) return Promise.resolve();
    if (mutatingRef.current) return Promise.resolve();
    if (readInFlight.current) return readInFlight.current;
    const captured = epoch.current;
    const scopedRequest = requestRef.current;
    const task = (async () => {
      try {
        const [call, sms] = await Promise.all(SCOPES.map(([value]) => scopedRequest<{items?: BlocklistItem[]}>(`/blocklist?scope=${value}`)));
        if (!mounted.current || captured !== epoch.current) return;
        setLists({call: call?.items || [], sms: sms?.items || []});
        setUnsupported(false);
        setError('');
      } catch (caught) {
        if (!mounted.current || captured !== epoch.current) return;
        if (errorStatus(caught) === 404) {
          setUnsupported(true);
          setLists({call: [], sms: []});
          setError('');
        } else {
          // Keep the last successful list visible while explaining that this read is stale.
          const detail = caught instanceof Error ? caught.message : '无法读取已屏蔽号码';
          setError(acceptedMessage ? `${acceptedMessage}，但名单暂未刷新：${detail}` : detail);
        }
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
      mutatingRef.current = false;
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

  function unblock(item: BlocklistItem) {
    mutatingRef.current = true;
    const captured = ++epoch.current;
    readInFlight.current = null;
    setMutating(true);
    setError('');
    void request(`/blocklist/${encodeURIComponent(item.id)}`, undefined, 'DELETE')
      .then(() => {
        if (!mounted.current || captured !== epoch.current) return;
        setLists(current => current && {call: current.call.filter(entry => entry.id !== item.id), sms: current.sms.filter(entry => entry.id !== item.id)});
        setConfirmId(null);
        onChanged?.();
        mutatingRef.current = false;
        setMutating(false);
        void load('已解除屏蔽');
      })
      .catch(caught => {
        if (mounted.current && captured === epoch.current) setError(caught instanceof Error ? caught.message : '解除屏蔽失败');
      })
      .finally(() => {
        mutatingRef.current = false;
        if (!mounted.current) return;
        if (captured === epoch.current) setMutating(false);
        else void load();
      });
  }

  const items = lists?.[scope] ?? null;
  const listName = scope === 'sms' ? '短信黑名单' : '来电黑名单';
  const digits = query.replace(/[^0-9+]/g, '');
  const filteredItems = items?.filter(item => !query.trim() || (digits && item.remoteNumber.replace(/[^0-9+]/g, '').includes(digits)));

  if (unsupported) return null;
  return (
    <details className="blocklist-manager">
      <summary>管理已屏蔽号码{lists ? `（来电 ${lists.call.length} · 短信 ${lists.sms.length}）` : ''}</summary>
      <div className="segmented" role="group" aria-label="屏蔽名单">
        {SCOPES.map(([value, label]) => (
          <button type="button" key={value} className={scope === value ? 'selected' : ''}
            aria-pressed={scope === value} onClick={() => { setScope(value); setConfirmId(null); }}>{label}</button>
        ))}
      </div>
      <label>搜索号码<input type="search" inputMode="tel" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已屏蔽号码" /></label>
      {error && <div className="error" role="alert"><p>{error}</p><button type="button" className="passkey" disabled={busy || mutating} onClick={() => void load()}>重试读取屏蔽名单</button></div>}
      {items === null ? (
        <p className="muted">正在读取已屏蔽号码…</p>
      ) : !items.length ? (
        <p className="muted">{listName}目前没有号码。</p>
      ) : (
        <div className="blocklist-list">
          {!filteredItems?.length && <p className="muted">没有匹配的已屏蔽号码。</p>}
          {filteredItems?.map(item => (
            <article className="record blocklist-row" key={item.id}>
              <div>
                <span>
                  <strong dir="ltr">{item.remoteNumber}</strong>
                  {item.contactName && <small>{item.contactName}</small>}
                  {item.source === 'phone' && <small>手机屏蔽</small>}
                  {item.createdAt && <small>屏蔽于 <time dateTime={item.createdAt}>{blocklistTimeLabel(item.createdAt)}</time></small>}
                </span>
                {confirmId === item.id ? (
                  <ConfirmAction
                    busy={busy || mutating}
                    prompt={`从${listName}解除 ${item.remoteNumber}？`}
                    confirmLabel="确认解除"
                    onConfirm={() => unblock(item)}
                    onCancel={() => setConfirmId(null)}
                  />
                ) : (
                  <button type="button" className="passkey hangup" disabled={busy || mutating} onClick={() => setConfirmId(item.id)}>
                    解除屏蔽
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </details>
  );
}
