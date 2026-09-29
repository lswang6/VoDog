/** S67 unread badges: pure helpers shared by the nav buttons and SIM chips. */
export type SimBadge = {simId: string; calls: number; sms: number};
export type Badges = {calls: number; sms: number; sims: SimBadge[]};
export const EMPTY_BADGES: Badges = {calls: 0, sms: 0, sims: []};

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Accepts a `GET /badges` body; returns null for anything malformed so the caller keeps the last value. */
export function parseBadges(raw: unknown): Badges | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as {calls?: unknown; sms?: unknown; sims?: unknown};
  if (typeof body.calls !== 'number' || typeof body.sms !== 'number' || !Array.isArray(body.sims)) return null;
  const sims = body.sims.flatMap(item => item && typeof item === 'object' && typeof (item as SimBadge).simId === 'string'
    ? [{simId: (item as SimBadge).simId, calls: count((item as SimBadge).calls), sms: count((item as SimBadge).sms)}]
    : []);
  return {calls: count(body.calls), sms: count(body.sms), sims};
}

/** '' hides the badge; >99 reads `99+`. */
export function badgeLabel(n: number): string {
  return n > 99 ? '99+' : n > 0 ? String(Math.floor(n)) : '';
}

/** Nav button count: only 通话 and 短信 carry a badge. */
export function navBadgeCount(badges: Badges, tab: string): number {
  return tab === '通话' ? badges.calls : tab === '短信' ? badges.sms : 0;
}

/** SIM chip count: calls on 通话, sms on 短信, both elsewhere. */
export function simBadgeCount(badges: Badges, simId: string, tab: string): number {
  const sim = badges.sims.find(item => item.simId === simId);
  if (!sim) return 0;
  return tab === '通话' ? sim.calls : tab === '短信' ? sim.sms : sim.calls + sim.sms;
}

/** Optimistic local decrement after marking seen / read; clamps at 0. */
export function decrementBadges(badges: Badges, simId: string, kind: 'calls' | 'sms', by: number): Badges {
  if (by <= 0) return badges;
  return {
    ...badges,
    [kind]: Math.max(0, badges[kind] - by),
    sims: badges.sims.map(sim => sim.simId === simId ? {...sim, [kind]: Math.max(0, sim[kind] - by)} : sim),
  };
}

/**
 * Best-effort client view of S67 rule 1, used only to decide the optimistic decrement.
 * The POST is sent for every opened call; the next `/badges` read is authoritative.
 */
export function callAwaitsReview(call: {direction: string; state: string; answeredAt?: string | null; failureReason?: string | null; answeredByPlatform?: string; conflictDisposition?: string | null; internal?: boolean}): boolean {
  // S72 B6：内部通话不计未读角标。
  if (call.internal || call.direction !== 'incoming' || (call.state !== 'ended' && call.state !== 'failed') || call.failureReason === 'number_blocked') return false;
  return !call.answeredAt || call.answeredByPlatform === 'ai' || call.conflictDisposition === 'ai_answered';
}

/** S67c row dot: the server's `unseen` flag (missing = false), unless this tab already opened the call. */
export function callShowsDot(call: {id: string; unseen?: boolean}, seenIds: ReadonlySet<string>): boolean {
  return call.unseen === true && !seenIds.has(call.id);
}

/** S67c thread dot: any message still `unread` (missing = false) that this tab has not already marked read. */
export function threadHasUnread(messages: readonly {id: string; unread?: boolean}[], readIds: ReadonlySet<string>): boolean {
  return messages.some(message => message.unread === true && !readIds.has(message.id));
}
