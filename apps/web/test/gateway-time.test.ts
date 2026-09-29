import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_GATEWAY_TIME_ZONE,formatCompactCallDate,formatCompactClock,formatCompactThreadDate,formatGatewayDateTime,gatewayDisplayTimeZone,isIanaTimeZone} from '../src/gateway-time.ts';

const instant = '2026-09-10T16:00:00Z';

test('Shanghai wall clock is the next calendar day at midnight, independent of process TZ', () => {
 assert.equal(formatCompactCallDate(instant, 'Asia/Shanghai'), '2026-09-11 00:00');
 assert.equal(formatCompactCallDate(instant, DEFAULT_GATEWAY_TIME_ZONE), '2026-09-11 00:00');
 assert.equal(formatCompactCallDate(instant, 'UTC'), '2026-09-10 16:00');
 assert.equal(formatCompactCallDate(instant, 'America/New_York'), '2026-09-10 12:00');
});

test('display zone prefers a snapshotted IANA, then live SIM zone, then Shanghai — never Asia/Beijing', () => {
 assert.equal(gatewayDisplayTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
 assert.equal(gatewayDisplayTimeZone(undefined, 'Asia/Tokyo'), 'Asia/Tokyo');
 assert.equal(gatewayDisplayTimeZone(null, '', 'Not/AZone'), 'Asia/Shanghai');
 assert.equal(gatewayDisplayTimeZone('Asia/Beijing', 'Asia/Shanghai'), 'Asia/Shanghai');
 assert.equal(gatewayDisplayTimeZone('GMT+08:00'), 'Asia/Shanghai');
 assert.equal(isIanaTimeZone('Asia/Beijing'), false);
 assert.equal(isIanaTimeZone('Asia/Shanghai'), true);
});

test('pairing-code expiry shows the gateway wall clock, never the browser clock', () => {
 assert.equal(formatCompactClock(instant, 'Asia/Shanghai'), '00:00');
 assert.equal(formatCompactClock(instant, DEFAULT_GATEWAY_TIME_ZONE), '00:00');
 assert.equal(formatCompactClock(instant, 'UTC'), '16:00');
 assert.equal(formatCompactClock(instant, 'America/New_York'), '12:00');
 assert.equal(formatCompactClock('not-a-date', 'Asia/Shanghai'), 'not-a-date');
});

test('thread dates drop the year inside the current year and keep the gateway calendar day', () => {
 const thisYear = new Date('2026-09-30T12:00:00Z');
 assert.equal(formatCompactThreadDate(instant, 'Asia/Shanghai', thisYear), '09-11');
 assert.equal(formatCompactThreadDate(instant, 'UTC', thisYear), '09-10');
 assert.equal(formatCompactThreadDate(instant, 'Asia/Shanghai', new Date('2027-01-02T12:00:00Z')), '2026-09-11');
 assert.equal(formatCompactThreadDate('not-a-date', 'Asia/Shanghai', thisYear), 'not-a-date');
});

test('recording header dates also honor the gateway zone', () => {
 const text = formatGatewayDateTime(instant, 'Asia/Shanghai');
 assert.match(text, /11/);
 assert.match(text, /2026|26/);
});
