import assert from 'node:assert/strict';
import test from 'node:test';
import {containsInReportWindow, reportDayWindow, reportWindow, zonedWallTimeToInstant} from './report-window.mjs';

test('7d uses New York calendar days across spring DST', () => {
  const window = reportWindow({period: '7d', anchor: '2024-03-11T16:00:00.000Z', timeZone: 'America/New_York'});
  assert.equal(window.fromInclusive.toISOString(), '2024-03-04T17:00:00.000Z');
  assert.equal(window.toExclusive.toISOString(), '2024-03-11T16:00:00.000Z');
  assert.equal((window.toExclusive - window.fromInclusive) / 3_600_000, 167);
});

test('7d uses New York calendar days across fall DST', () => {
  const window = reportWindow({period: '7d', anchor: '2024-11-04T17:00:00.000Z', timeZone: 'America/New_York'});
  assert.equal(window.fromInclusive.toISOString(), '2024-10-28T16:00:00.000Z');
  assert.equal((window.toExclusive - window.fromInclusive) / 3_600_000, 169);
});

test('month and year windows clamp leap month calendar dates', () => {
  assert.equal(reportWindow({period: '1m', anchor: '2024-03-31T04:00:00.000Z', timeZone: 'Asia/Taipei'}).fromInclusive.toISOString(), '2024-02-29T04:00:00.000Z');
  assert.equal(reportWindow({period: '6m', anchor: '2024-08-31T04:00:00.000Z', timeZone: 'Asia/Taipei'}).fromInclusive.toISOString(), '2024-02-29T04:00:00.000Z');
  assert.equal(reportWindow({period: '1y', anchor: '2024-02-29T04:00:00.000Z', timeZone: 'Asia/Taipei'}).fromInclusive.toISOString(), '2023-02-28T04:00:00.000Z');
});

test('ambiguous local time resolves earlier by compatible and supports later/reject', () => {
  const parts = {year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0, millisecond: 0};
  assert.equal(zonedWallTimeToInstant(parts, 'America/New_York').toISOString(), '2024-11-03T05:30:00.000Z');
  assert.equal(zonedWallTimeToInstant(parts, 'America/New_York', {disambiguation: 'later'}).toISOString(), '2024-11-03T06:30:00.000Z');
  assert.throws(() => zonedWallTimeToInstant(parts, 'America/New_York', {disambiguation: 'reject'}), /Ambiguous/);
});

test('nonexistent local time resolves after the gap by compatible and before with earlier', () => {
  const parts = {year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0, millisecond: 0};
  assert.equal(zonedWallTimeToInstant(parts, 'America/New_York').toISOString(), '2024-03-10T07:30:00.000Z');
  assert.equal(zonedWallTimeToInstant(parts, 'America/New_York', {disambiguation: 'earlier'}).toISOString(), '2024-03-10T06:30:00.000Z');
  assert.throws(() => zonedWallTimeToInstant(parts, 'America/New_York', {disambiguation: 'reject'}), /Nonexistent/);
});

test('membership is from-inclusive and to-exclusive', () => {
  const window = reportWindow({period: '1m', anchor: '2024-03-31T04:00:00.000Z', timeZone: 'Asia/Taipei'});
  assert.equal(containsInReportWindow(window, window.fromInclusive), true);
  assert.equal(containsInReportWindow(window, new Date(window.toExclusive.getTime() - 1)), true);
  assert.equal(containsInReportWindow(window, window.toExclusive), false);
});

test('invalid calendar dates and zones are rejected', () => {
  assert.throws(() => zonedWallTimeToInstant({year: 2024, month: 2, day: 31, hour: 0, minute: 0, second: 0, millisecond: 0}, 'UTC'), /Invalid local/);
  assert.throws(() => reportWindow({period: '7d', anchor: '2024-01-01T00:00:00Z', timeZone: 'Not\/AZone'}), /Invalid IANA/);
});

test('explicit calendar days are inclusive on both ends in the owner time zone', () => {
  const window = reportDayWindow({from: '2026-09-01', to: '2026-09-11', timeZone: 'Asia/Shanghai'});
  assert.equal(window.fromInclusive.toISOString(), '2026-08-31T16:00:00.000Z');
  assert.equal(window.toExclusive.toISOString(), '2026-09-11T16:00:00.000Z');
  const single = reportDayWindow({from: '2026-09-11', to: '2026-09-11', timeZone: 'Asia/Shanghai'});
  assert.equal((single.toExclusive - single.fromInclusive) / 3_600_000, 24);
});

test('calendar day windows follow DST and reject malformed or inverted ranges', () => {
  const spring = reportDayWindow({from: '2024-03-10', to: '2024-03-10', timeZone: 'America/New_York'});
  assert.equal((spring.toExclusive - spring.fromInclusive) / 3_600_000, 23);
  const fall = reportDayWindow({from: '2024-11-03', to: '2024-11-03', timeZone: 'America/New_York'});
  assert.equal((fall.toExclusive - fall.fromInclusive) / 3_600_000, 25);
  assert.throws(() => reportDayWindow({from: '2026-9-1', to: '2026-09-11', timeZone: 'Asia/Shanghai'}), /Invalid report from date/);
  assert.throws(() => reportDayWindow({from: '2026-09-11', to: '2026-09-01', timeZone: 'Asia/Shanghai'}), /end on or after/);
  assert.throws(() => reportDayWindow({from: '2026-09-01', to: '2026-09-11', timeZone: 'Not/AZone'}), /Invalid IANA/);
});
