/** Beijing wall clock is Asia/Shanghai. Never Asia/Beijing, never a numeric offset. */
export const DEFAULT_GATEWAY_TIME_ZONE = 'Asia/Shanghai';

export function isIanaTimeZone(zone: string): boolean {
 if (typeof zone !== 'string' || zone.length < 1 || zone.length > 100 || zone === 'Asia/Beijing' || /[+]/.test(zone)) return false;
 try {
  Intl.DateTimeFormat('en-US', {timeZone: zone});
  return true;
 } catch {
  return false;
 }
}

export function gatewayDisplayTimeZone(...candidates: Array<string | null | undefined>): string {
 for (const zone of candidates) {
  if (typeof zone === 'string' && isIanaTimeZone(zone)) return zone;
 }
 return DEFAULT_GATEWAY_TIME_ZONE;
}

function parts(iso: string, timeZone: string): Intl.DateTimeFormatPart[] {
 const date = new Date(iso);
 if (!Number.isFinite(date.getTime())) return [];
 return new Intl.DateTimeFormat('en-US', {
  timeZone: gatewayDisplayTimeZone(timeZone),
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
 }).formatToParts(date);
}

function part(items: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
 return items.find(item => item.type === type)?.value || '';
}

function clock(items: Intl.DateTimeFormatPart[]): string {
 const hour = part(items, 'hour') === '24' ? '00' : part(items, 'hour');
 const minute = part(items, 'minute');
 return hour && minute ? `${hour}:${minute}` : '';
}

/** Compact list clock in the Pixel gateway zone, independent of the browser/process TZ. */
export function formatCompactCallDate(iso: string, timeZone: string): string {
 const items = parts(iso, timeZone);
 const year = part(items, 'year');
 const month = part(items, 'month');
 const day = part(items, 'day');
 const time = clock(items);
 if (!year || !month || !day || !time) return iso;
 return `${year}-${month}-${day} ${time}`;
}

/** Wall clock only (`HH:mm`) in the gateway zone — same-day deadlines such as a pairing code expiry. */
export function formatCompactClock(iso: string, timeZone: string): string {
 return clock(parts(iso, timeZone)) || iso;
}

/** Thread list date in the gateway zone: `MM-DD` within the current year, `YYYY-MM-DD` before it. */
export function formatCompactThreadDate(iso: string, timeZone: string, now: Date = new Date()): string {
 const date = gatewayCalendarDate(iso, timeZone);
 if (!date) return iso;
 const today = gatewayCalendarDate(now, timeZone);
 return today.slice(0, 4) === date.slice(0, 4) ? date.slice(5) : date;
}

export function formatGatewayDateTime(iso: string, timeZone: string): string {
 const date = new Date(iso);
 if (!Number.isFinite(date.getTime())) return iso;
 try {
  return new Intl.DateTimeFormat('zh-CN', {
   dateStyle: 'medium',
   timeStyle: 'short',
   timeZone: gatewayDisplayTimeZone(timeZone),
  }).format(date);
 } catch {
  return formatCompactCallDate(iso, timeZone);
 }
}

/**
 * The calendar day (`YYYY-MM-DD`) a moment falls on in the gateway wall clock (S22 报告 from/to).
 *
 * The server closes the window on owner-zone calendar days, so the browser must not send a day computed
 * from its own `TZ`: at 08:00 Asia/Shanghai a UTC browser would still be asking for yesterday.
 */
export function gatewayCalendarDate(at: Date | string, timeZone: string): string {
 const date = typeof at === 'string' ? new Date(at) : at;
 if (!Number.isFinite(date.getTime())) return '';
 const items = new Intl.DateTimeFormat('en-US', {
  timeZone: gatewayDisplayTimeZone(timeZone),
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
 }).formatToParts(date);
 const year = part(items, 'year'), month = part(items, 'month'), day = part(items, 'day');
 return year && month && day ? `${year}-${month}-${day}` : '';
}

/** Day arithmetic on a `YYYY-MM-DD` label, done in UTC so a DST jump can never skip or repeat a day. */
export function shiftCalendarDate(date: string, days: number): string {
 const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
 if (!match) return date;
 const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
 if (!Number.isFinite(shifted.getTime())) return date;
 return shifted.toISOString().slice(0, 10);
}
