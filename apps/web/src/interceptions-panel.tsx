import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {BlocklistPanel} from './blocklist-panel';
import {UiIcon} from './icons';
import {formatCompactCallDate, gatewayDisplayTimeZone} from './gateway-time';
import {interceptionRow, sortInterceptions, type InterceptionItem, type InterceptionRow} from './interceptions';
import {Pager, clampPage, normalizePageSize, readViewState, storedPage, writeViewState, type PageSize} from './pager';
import type {ApiRequest} from './contacts';
import {useVisibleRefresh} from './visible-refresh';

/**
 * 拦截记录 view inside the 记录 tab (S21 §B/§F).
 *
 * Rows open the same 联系人卡片 as a normal record; the current blocklist is managed independently.
 * S64: scoped by the 记录 SIM strip (`simId`, '' = 全部 SIM); the blocklist itself stays account-wide.
 */
function errorStatus(error: unknown): number {
  const status = (error as {status?: unknown})?.status;
  return typeof status === 'number' ? status : 0;
}

/** `GET /blocklist/interceptions?page=&pageSize=&kind=[&simId=]` (S28 分页合同, S64 simId); the pre-S28 server ignores both and answers `{items}`. */
type InterceptionKind = 'all' | 'call' | 'sms';
export function interceptionsQueryPath({page, pageSize, kind = 'all', simId}: {page: number; pageSize: number; kind?: InterceptionKind; simId?: string}): string {
  return `/blocklist/interceptions?page=${page}&pageSize=${pageSize}&kind=${kind}` + (simId ? `&simId=${encodeURIComponent(simId)}` : '');
}

export function InterceptionsPanel({
  request,
  busy,
  timeZone,
  simId = '',
  sims = [],
  reloadToken = 0,
  storageKey,
  onOpenRow,
  onChanged,
}: {
  request: ApiRequest;
  busy: boolean;
  timeZone?: string | null;
  /** 记录 SIM scope; '' = every SIM. */
  simId?: string;
  sims?: {id: string; label?: string; phoneLabel?: string; timeZone?: string | null}[];
  reloadToken?: number;
  /** sessionStorage key: type, page and page size survive switching 记录 views (the page only for the same SIM). */
  storageKey?: string;
  onOpenRow?: (row: InterceptionRow) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<InterceptionItem[] | null>(null);
  const [interceptionsError, setInterceptionsError] = useState('');
  useReportedError('记录', 'interceptions', interceptionsError);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saved] = useState(() => readViewState(storageKey));
  const [page, setPage] = useState(() => (saved.simId ?? '') === simId ? storedPage(saved.page) : 1);
  const [pageSize, setPageSize] = useState<PageSize>(() => normalizePageSize(saved.pageSize));
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [totalPages, setTotalPages] = useState<number | undefined>(undefined);
  const [kind, setKind] = useState<InterceptionKind>(() => (saved.kind === 'call' || saved.kind === 'sms' ? saved.kind : 'all'));
  const [reloads, setReloads] = useState(0);
  // simId arrives as a prop, outside any handler: a change sends the list back to page 1 exactly once.
  const scopeKey = useRef(simId);

  useEffect(() => {
    if (scopeKey.current !== simId) {
      scopeKey.current = simId;
      if (page !== 1) { setPage(1); return; }
    }
    let cancelled = false;
    setLoading(true);
    request<{items: InterceptionItem[]; total?: number; totalPages?: number}>(
      interceptionsQueryPath({page, pageSize, kind, simId}),
    )
      .then(result => {
        if (cancelled) return;
        // No totalPages means a pre-S28 Control answered the whole thing: show the rows, hide the pager.
        const pages = typeof result.totalPages === 'number' ? Math.max(1, Math.floor(result.totalPages)) : undefined;
        setTotalPages(pages);
        setTotal(typeof result.total === 'number' ? result.total : undefined);
        // A page past the end (restored, or emptied by a removal) moves to the last page rather than rendering empty.
        if (pages !== undefined && page > pages) {
          setPage(pages);
          return;
        }
        setLoading(false);
        setItems(result.items || []);
        setUnsupported(false);
        setInterceptionsError('');
      })
      .catch(caught => {
        if (cancelled) return;
        setLoading(false);
        if (errorStatus(caught) === 404) setUnsupported(true);
        else setInterceptionsError(caught instanceof Error ? caught.message : '无法读取拦截记录');
      });
    return () => {
      cancelled = true;
    };
  }, [page, pageSize, kind, simId, reloadToken, reloads, request]);

  useVisibleRefresh(() => setReloads(value => value + 1), 5000, false);
  useEffect(() => writeViewState(storageKey, {kind, page, pageSize, simId}), [storageKey, kind, page, pageSize, simId]);
  // A Control without the S64 `simId` parameter answers every SIM, so the same filter stays client-side for the transition.
  const rows = sortInterceptions(items || []).map(interceptionRow).filter(row => !simId || row.simId === simId);

  return (
    <section className="panel interceptions-panel">
      <BlocklistPanel request={request} busy={busy} reloadToken={reloadToken} onChanged={() => {
        setReloads(value => value + 1);
        onChanged?.();
      }} />
      <hr />
      <h2>拦截记录</h2>
      <div className="segmented" role="group" aria-label="拦截类型">
        {([['all', '全部'], ['call', '来电'], ['sms', '短信']] as const).map(([value, label]) => (
          <button type="button" key={value} className={kind === value ? 'selected' : ''}
            aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>{label}</button>
        ))}
      </div>
      {unsupported && <p className="note">此服务器尚未启用拦截记录。</p>}
      {interceptionsError && (
        <p className="error" role="alert">
          {interceptionsError}
        </p>
      )}
      {items === null ? (
        <p className="muted">正在读取拦截记录…</p>
      ) : !rows.length ? (
        !unsupported && <p className="muted">没有此类型的拦截记录。</p>
      ) : (
        <div className="interception-list">
          {rows.map(row => {
              const rowSim = sims.find(sim => sim.id === row.simId);
              const zone = gatewayDisplayTimeZone(row.gatewayTimeZone, rowSim?.timeZone, timeZone);
              return (
              <button
                type="button"
                className="record interception-row"
                key={row.id}
                disabled={busy}
                aria-label={`${row.kindLabel} ${row.title}`}
                onClick={() => onOpenRow?.(row)}
              >
                <span className="interception-icon" aria-hidden="true">
                  <UiIcon name="blocked" />
                </span>
                <span className="interception-body">
                  <strong dir="ltr">{row.title}</strong>
                  <small>
                    {row.kindLabel}
                    {row.sourceLabel ? ` · ${row.sourceLabel}` : ''}
                    {row.simLabel || rowSim ? ` · ${row.simLabel || rowSim?.phoneLabel || rowSim?.label || '未命名号码'}` : ''}
                  </small>
                  {row.preview && <span className="interception-preview">{row.preview}</span>}
                </span>
                <time dateTime={row.occurredAt}>{formatCompactCallDate(row.occurredAt, zone)}</time>
              </button>
              );
            })}
        </div>
      )}
      <Pager
        page={page}
        pageSize={pageSize}
        total={total}
        totalPages={totalPages}
        busy={busy || (loading && items === null)}
        onPageChange={next => setPage(clampPage(next, totalPages ?? 1))}
        onPageSizeChange={next => {
          setPageSize(next);
          setPage(1);
        }}
      />
    </section>
  );
}
