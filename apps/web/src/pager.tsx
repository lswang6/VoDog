import React, {useState} from 'react';

/**
 * 记录 分页控件 (S28).
 *
 * The three 记录 tabs all read a server page — `{items,page,pageSize,total,totalPages}` — but an older Control
 * answers the same request with a bare `{items}`. `totalPages` is therefore the whole feature switch: without it
 * this component renders nothing at all and the tab keeps showing the single page it was given.
 */
export const PAGE_SIZES = [50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 50;

/** Any typed or stored page number lands inside `1..totalPages`; a server that reports no pages still has page 1. */
export function clampPage(page: number, totalPages: number): number {
  const pages = Math.max(1, Math.floor(Number(totalPages)) || 1);
  const wanted = Math.floor(Number(page));
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  return Math.min(wanted, pages);
}

/** Normalises whatever the `每页` control produced back onto the three supported sizes. */
export function normalizePageSize(size: unknown): PageSize {
  const value = Number(size);
  return (PAGE_SIZES as readonly number[]).includes(value) ? (value as PageSize) : DEFAULT_PAGE_SIZE;
}

/**
 * 记录 子视图的搜索/页码/每页在切换视图或离开 记录 页后仍保留（sessionStorage，键按账号区分）。
 * Storage may be missing (tests, private mode) or hold anything: every access is guarded and every read field is
 * validated by the caller, so a bad entry simply starts the view fresh.
 */
export function readViewState(key?: string): Record<string, unknown> {
  if (!key) return {};
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export function writeViewState(key: string | undefined, value: Record<string, unknown>): void {
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage: the view just starts fresh next time.
  }
}
export function storedPage(value: unknown): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}
export function storedText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Client-side slice of an already-loaded list into one page (S35 近期通话).
 *
 * Unlike the server `Pager`, there is no server round trip: the dashboard's polled `calls` array is
 * already in memory, and this only bounds how much of it is rendered at once. The returned `page` is
 * always clamped into `1..totalPages`, so a list that shrank under a stale page number renders the
 * last page instead of an empty one.
 */
export function clientPage<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): {items: T[]; page: number; totalPages: number} {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const current = clampPage(page, totalPages);
  const start = (current - 1) * size;
  return {items: items.slice(start, start + size), page: current, totalPages};
}

export function Pager({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  busy = false,
}: {
  page: number;
  pageSize: number;
  total?: number;
  totalPages?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
  busy?: boolean;
}) {
  const [jump, setJump] = useState('');
  // An older Control never sends totalPages: the pager is not "empty", it does not exist.
  if (typeof totalPages !== 'number' || !Number.isFinite(totalPages)) return null;
  const pages = Math.max(1, Math.floor(totalPages));
  const current = clampPage(page, pages);
  const hasTotal = typeof total === 'number' && Number.isFinite(total);
  const count = hasTotal ? Math.max(0, Math.floor(total)) : 0;
  const goto = (value: number) => {
    const next = clampPage(value, pages);
    if (next !== current) onPageChange(next);
  };
  return (
    <nav className="pager" aria-label="分页">
      <button type="button" className="passkey" disabled={busy || current <= 1} onClick={() => goto(1)}>首页</button>
      <button type="button" className="passkey" disabled={busy || current <= 1} onClick={() => goto(current - 1)}>上一页</button>
      <button type="button" className="passkey" disabled={busy || current >= pages} onClick={() => goto(current + 1)}>下一页</button>
      <button type="button" className="passkey" disabled={busy || current >= pages} onClick={() => goto(pages)}>末页</button>
      <span className="muted" role="status">第 {current} / {pages} 页{hasTotal ? ` · 共 ${count} 条` : ''}</span>
      <label>每页
        <select
          value={pageSize}
          aria-label="每页条数"
          disabled={busy}
          onChange={event => onPageSizeChange(normalizePageSize(event.target.value))}
        >
          {PAGE_SIZES.map(size => <option key={size} value={size}>{size} 条</option>)}
        </select>
      </label>
      <form
        onSubmit={event => {
          event.preventDefault();
          if (!jump.trim()) return;
          const next = clampPage(Number(jump), pages);
          setJump(String(next));
          if (next !== current) onPageChange(next);
        }}
      >
        <label>跳转到
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={pages}
            value={jump}
            disabled={busy}
            onChange={event => setJump(event.target.value)}
          />
        </label>
        <button type="submit" className="passkey" disabled={busy}>跳转</button>
      </form>
    </nav>
  );
}
