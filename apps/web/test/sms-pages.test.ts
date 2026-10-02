import assert from 'node:assert/strict';
import test from 'node:test';
import {loadAllSms, SMS_MAX_PAGES, type SmsPage} from '../src/sms-pages.ts';

type M = {id: string; body?: string};
function pager(pages: Array<SmsPage<M> | Error>) {
  const paths: string[] = [];
  return {paths, fetch: async (path: string) => { const p = pages[paths.push(path) - 1]; if (p instanceof Error) throw p; return p; }};
}
const cursor = {before: '2026-09-01T00:00:00.000Z', beforeId: 'b'};

test('one page (nextCursor null): one request, result is that page', async () => {
  const p = pager([{items: [{id: 'a'}, {id: 'b'}], nextCursor: null}]);
  assert.deepEqual(await loadAllSms(p.fetch), {items: [{id: 'a'}, {id: 'b'}]});
  assert.deepEqual(p.paths, ['/sms?limit=500']);
});

test('old Control without nextCursor field is treated as the last page', async () => {
  const p = pager([{items: [{id: 'a'}]}]);
  assert.deepEqual(await loadAllSms(p.fetch), {items: [{id: 'a'}]});
  assert.equal(p.paths.length, 1);
});

test('two pages: second request carries before/beforeId, results concatenated in page order', async () => {
  const p = pager([{items: [{id: 'a'}, {id: 'b'}], nextCursor: cursor}, {items: [{id: 'c'}], nextCursor: null}]);
  assert.deepEqual(await loadAllSms(p.fetch), {items: [{id: 'a'}, {id: 'b'}, {id: 'c'}]});
  assert.equal(p.paths.length, 2);
  const q = new URLSearchParams(p.paths[1].split('?')[1]);
  assert.equal(q.get('limit'), '500');
  assert.equal(q.get('before'), cursor.before);
  assert.equal(q.get('beforeId'), cursor.beforeId);
});

test('duplicate ids across pages: first occurrence wins', async () => {
  const p = pager([{items: [{id: 'a', body: 'first'}, {id: 'b'}], nextCursor: cursor}, {items: [{id: 'b', body: 'dup'}, {id: 'a', body: 'second'}, {id: 'c'}], nextCursor: null}]);
  assert.deepEqual(await loadAllSms(p.fetch), {items: [{id: 'a', body: 'first'}, {id: 'b'}, {id: 'c'}]});
});

test('second page fails: the whole load rejects (caller keeps the previous list)', async () => {
  const p = pager([{items: [{id: 'a'}], nextCursor: cursor}, new Error('HTTP_502')]);
  await assert.rejects(loadAllSms(p.fetch), /HTTP_502/);
});

test('endless nextCursor: stops after 20 pages, returns what was fetched, reports cap once', async () => {
  const paths: string[] = [], caps: Array<[number, number]> = [];
  const result = await loadAllSms(async path => { paths.push(path); return {items: [{id: String(paths.length)}], nextCursor: cursor}; }, (pages, items) => caps.push([pages, items]));
  assert.equal(paths.length, SMS_MAX_PAGES);
  assert.equal(result.items.length, 20);
  assert.deepEqual(caps, [[20, 20]]);
});

test('old Control rejects limit=500 with 400 on page 1: falls back to one limit=100 request', async () => {
  const p = pager([Object.assign(new Error('HTTP_400'), {status: 400}), {items: [{id: 'a'}, {id: 'b'}]}]);
  assert.deepEqual(await loadAllSms(p.fetch), {items: [{id: 'a'}, {id: 'b'}]});
  assert.deepEqual(p.paths, ['/sms?limit=500', '/sms?limit=100']);
  const later = pager([{items: [{id: 'a'}], nextCursor: cursor}, Object.assign(new Error('HTTP_400'), {status: 400})]);
  await assert.rejects(loadAllSms(later.fetch), /HTTP_400/);
  const other = pager([Object.assign(new Error('HTTP_500'), {status: 500})]);
  await assert.rejects(loadAllSms(other.fetch), /HTTP_500/);
  assert.equal(other.paths.length, 1);
});
