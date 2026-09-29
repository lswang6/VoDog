const PERIODS = new Set(['7d', '1m', '6m', '1y']);

function formatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    });
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
}

function partsAt(date, timeZone) {
  const values = {};
  for (const part of formatter(timeZone).formatToParts(date)) if (part.type !== 'literal') values[part.type] = Number(part.value);
  return {year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second, millisecond: values.fractionalSecond};
}

function wallEpoch(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function sameWall(a, b) {
  return wallEpoch(a) === wallEpoch(b);
}

export function zonedWallTimeToInstant(parts, timeZone, {disambiguation = 'compatible'} = {}) {
  if (!['compatible', 'earlier', 'later', 'reject'].includes(disambiguation)) throw new RangeError(`Invalid disambiguation: ${disambiguation}`);
  formatter(timeZone);
  const fields = ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'];
  if (!fields.every((field) => Number.isInteger(parts?.[field])) || parts.year < 1 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59 || parts.second < 0 || parts.second > 59 || parts.millisecond < 0 || parts.millisecond > 999) {
    throw new RangeError('Invalid local date-time');
  }
  const target = wallEpoch(parts);
  const canonical = new Date(target);
  if (canonical.getUTCFullYear() !== parts.year || canonical.getUTCMonth() + 1 !== parts.month || canonical.getUTCDate() !== parts.day) throw new RangeError('Invalid local date-time');
  const offsets = new Set();
  for (let sample = target - 48 * 3_600_000; sample <= target + 48 * 3_600_000; sample += 30 * 60_000) {
    offsets.add(wallEpoch(partsAt(new Date(sample), timeZone)) - sample);
  }
  const projections = [...offsets].map((offset) => {
    const instant = new Date(target - offset);
    const actual = partsAt(instant, timeZone);
    return {instant, actual, actualWall: wallEpoch(actual)};
  });
  const exact = projections.filter(({actual}) => sameWall(actual, parts)).sort((a, b) => a.instant - b.instant);
  if (exact.length) {
    if (exact.length > 1 && disambiguation === 'reject') throw new RangeError('Ambiguous local date-time');
    return new Date((disambiguation === 'later' ? exact.at(-1) : exact[0]).instant);
  }
  if (disambiguation === 'reject') throw new RangeError('Nonexistent local date-time');
  const before = projections.filter((item) => item.actualWall < target).sort((a, b) => b.actualWall - a.actualWall)[0];
  const after = projections.filter((item) => item.actualWall > target).sort((a, b) => a.actualWall - b.actualWall)[0];
  const selected = disambiguation === 'earlier' ? before : after;
  if (!selected) throw new RangeError('Unable to resolve local date-time');
  return new Date(selected.instant);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function subtractPeriod(local, period) {
  if (period === '7d') {
    const date = new Date(wallEpoch(local));
    date.setUTCDate(date.getUTCDate() - 7);
    return {year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: local.hour, minute: local.minute, second: local.second, millisecond: local.millisecond};
  }
  const months = period === '1m' ? 1 : period === '6m' ? 6 : 12;
  const monthIndex = local.year * 12 + local.month - 1 - months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  return {...local, year, month, day: Math.min(local.day, daysInMonth(year, month))};
}

export function reportWindow({period, anchor = new Date(), timeZone, disambiguation = 'compatible'}) {
  if (!PERIODS.has(period)) throw new RangeError(`Unsupported report period: ${period}`);
  const to = anchor instanceof Date ? new Date(anchor) : new Date(anchor);
  if (!Number.isFinite(to.getTime())) throw new RangeError('Invalid report anchor');
  const localTo = partsAt(to, timeZone);
  const localFrom = subtractPeriod(localTo, period);
  const from = zonedWallTimeToInstant(localFrom, timeZone, {disambiguation});
  return {period, timeZone, disambiguation, fromInclusive: from, toExclusive: to};
}

export function containsInReportWindow(window, instant) {
  const time = (instant instanceof Date ? instant : new Date(instant)).getTime();
  return time >= window.fromInclusive.getTime() && time < window.toExclusive.getTime();
}

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarDayParts(value, label) {
  const match = CALENDAR_DAY.exec(String(value ?? ''));
  if (!match) throw new RangeError(`Invalid report ${label} date: ${value}`);
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0, millisecond: 0};
}

function nextDay(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCDate(date.getUTCDate() + 1);
  return {...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate()};
}

/**
 * S22 报告日期选择. An explicit, inclusive pair of calendar days in the owner's own time zone,
 * resolved with exactly the same DST rules `reportWindow` uses. `to` is inclusive, so the exclusive
 * upper bound is midnight of the following day; a single day is a legal window.
 */
export function reportDayWindow({from, to, timeZone, disambiguation = 'compatible'}) {
  const start = calendarDayParts(from, 'from');
  const end = calendarDayParts(to, 'to');
  const fromInclusive = zonedWallTimeToInstant(start, timeZone, {disambiguation});
  const toExclusive = zonedWallTimeToInstant(nextDay(end), timeZone, {disambiguation});
  if (toExclusive.getTime() <= fromInclusive.getTime()) throw new RangeError('Report date range must end on or after it starts');
  return {timeZone, disambiguation, fromInclusive, toExclusive};
}
