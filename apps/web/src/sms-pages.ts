/** S89: pull the whole SMS list by following Control's keyset `nextCursor`; callers still full-replace (S32/S88 deletion sync). */
export type SmsCursor = {before: string; beforeId: string};
export type SmsPage<T> = {items: T[]; nextCursor?: SmsCursor | null};
export const SMS_PAGE_LIMIT = 500, SMS_MAX_PAGES = 20;

// ponytail: fetches every message on every poll; at ~2–3k rows or ~500 KB per refresh switch to a thread-summary API + per-thread paging (or tombstone deltas).
// Any page error propagates, so the refresh coordinator keeps the previous list instead of applying a partial one.
export async function loadAllSms<T extends {id: string}>(fetchPage: (path: string) => Promise<SmsPage<T>>, onCap?: (pages: number, items: number) => void): Promise<{items: T[]}> {
  const seen = new Set<string>(), items: T[] = [];
  let cursor: SmsCursor | null = null;
  for (let page = 0; page < SMS_MAX_PAGES; page++) {
    const query = new URLSearchParams({limit: String(SMS_PAGE_LIMIT)});
    if (cursor) { query.set('before', cursor.before); query.set('beforeId', cursor.beforeId); }
    let result: SmsPage<T>;
    try { result = await fetchPage(`/sms?${query}`); }
    catch (error) {
      // Rollback safety: pre-S89 Control caps limit at 100 and answers 400; take its single page as the whole list.
      if (page === 0 && (error as {status?: unknown})?.status === 400) return {items: (await fetchPage('/sms?limit=100')).items};
      throw error;
    }
    for (const item of result.items) if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
    cursor = result.nextCursor ?? null; // pre-S89 Control omits nextCursor: one page.
    if (!cursor) return {items};
  }
  onCap?.(SMS_MAX_PAGES, items.length);
  return {items};
}
