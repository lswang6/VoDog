/**
 * 拦截记录 row presentation (S21 §B/§F).
 *
 * The list is served by `GET /api/v1/blocklist/interceptions`, which an older Control does not expose at all;
 * callers treat a 404 as "no interceptions yet" rather than an error.
 */
import {isBlockedRow, numberWithContact} from './contacts.ts';

export type InterceptionItem = {
  id: string;
  kind: string;
  simId?: string;
  simLabel?: string | null;
  gatewayTimeZone?: string | null;
  remoteNumber?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  occurredAt: string;
  bodyPreview?: string | null;
  blocked?: boolean;
  blockedEntryId?: string | null;
  source?: string;
};

/** §B caps the preview server-side; the client re-caps so a lenient server cannot break the row layout. */
export const INTERCEPTION_PREVIEW_LIMIT = 160;

export function interceptionKindLabel(kind: string | null | undefined): string {
  if (kind === 'call') return '来电';
  if (kind === 'sms') return '短信';
  return '拦截';
}

export function interceptionSourceLabel(source: string | null | undefined): string {
  if (source === 'gateway') return '网关拦截';
  if (source === 'control') return '服务器拦截';
  if (source === 'phone') return '手机自动拦截';
  return '';
}

export function interceptionTitle(item: InterceptionItem): string {
  return numberWithContact(item.remoteNumber, item.contactName);
}

export function interceptionPreview(item: InterceptionItem): string {
  const body = (item.bodyPreview || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  return body.length > INTERCEPTION_PREVIEW_LIMIT
    ? `${body.slice(0, INTERCEPTION_PREVIEW_LIMIT)}…`
    : body;
}

export type InterceptionRow = {
  id: string;
  kindLabel: string;
  title: string;
  preview: string;
  sourceLabel: string;
  occurredAt: string;
  blocked: boolean;
  blockedEntryId: string | null;
  remoteNumber: string;
  contactId: string | null;
  simId: string;
  simLabel: string;
  gatewayTimeZone: string | null;
};

/**
 * One display row.
 *
 * An interception exists because the number was blocked, but §B's payload has no `blocked` field, so the
 * entry id doubles as the signal: without it the card can still show the number, just not offer 解除屏蔽.
 */
export function interceptionRow(item: InterceptionItem): InterceptionRow {
  return {
    id: item.id,
    kindLabel: interceptionKindLabel(item.kind),
    title: interceptionTitle(item),
    preview: interceptionPreview(item),
    sourceLabel: interceptionSourceLabel(item.source),
    occurredAt: item.occurredAt,
    // S66: the row only feeds the call-scoped 联系人卡片; an SMS row's entry id is on the SMS list, so the card
    // resolves call-list state from its own `?scope=call` read instead of deleting the SMS entry.
    blocked: item.kind !== 'sms' && (isBlockedRow(item) || Boolean(item.blockedEntryId)),
    blockedEntryId: item.kind === 'sms' ? null : item.blockedEntryId || null,
    remoteNumber: item.remoteNumber || '',
    contactId: item.contactId || null,
    simId: item.simId || '',
    simLabel: item.simLabel || '',
    gatewayTimeZone: item.gatewayTimeZone || null,
  };
}

/** Newest first, matching the server order, so a partially sorted response still reads correctly. */
export function sortInterceptions(items: readonly InterceptionItem[]): InterceptionItem[] {
  return [...items].sort(
    (a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '') || a.id.localeCompare(b.id),
  );
}
