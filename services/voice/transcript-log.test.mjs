import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TranscriptCollector } from './transcript-log.mjs';

function setup(options = {}) {
  const posts = [];
  const agent = new EventEmitter();
  const clock = { ms: 0 };
  const collector = new TranscriptCollector({ flushMs: 10_000, post: async items => { posts.push(items); }, now: () => clock.ms, ...options });
  collector.attach(agent);
  // A caller utterance is held briefly so the provider can revise it. Tests that only care about
  // delivery step the injected clock past that window instead of waiting on real time.
  const flush = async () => { clock.ms += 10_000; await collector.flush(); };
  return { agent, collector, posts, clock, flush };
}

test('both roles share one monotonic sequence and AI deltas flush on completion', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '你好', final: false, responseId: 'r1' });
  agent.emit('transcript', { text: '，请讲', final: false, responseId: 'r1' });
  assert.equal(collector.pending.length, 0);
  agent.emit('completed', { responseId: 'r1' });
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['ai', 0, '你好，请讲'], ['caller', 1, '我要退款']]);
  assert.match(posts[0][0].at, /^\d{4}-\d\d-\d\dT.*Z$/);
  await collector.close();
});

test('only final caller transcripts are kept and empty text is dropped', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '我要', final: false, cumulative: true, speaker: 'caller' });
  agent.emit('transcript', { text: '   ', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: ' 我要退款 ', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0], [{ role: 'caller', sequence: 0, text: '我要退款', at: posts[0][0].at }]);
  await collector.close();
});

test('batches never exceed maxBatch and the size threshold flushes without the timer', async () => {
  const { agent, collector, posts, flush } = setup({ maxBatch: 3 });
  for (let i = 0; i < 7; i++) agent.emit('transcript', { text: `t${i}`, final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts.map(batch => batch.length), [3, 3, 1]);
  assert.deepEqual(collector.stats(), { sent: 7, dropped: 0, failed: 0, pending: 0, merged: 0 });
  await collector.close();
});

test('overflow drops the oldest pending items instead of growing without bound', async () => {
  const { agent, collector, posts, flush } = setup({ maxBatch: 100, maxPending: 3 });
  for (let i = 0; i < 6; i++) agent.emit('transcript', { text: `t${i}`, final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => item.text), ['t3', 't4', 't5']);
  assert.deepEqual(posts[0].map(item => item.sequence), [3, 4, 5]);
  assert.equal(collector.stats().dropped, 3);
  await collector.close();
});

test('a throwing post is swallowed, counted and never retried', async () => {
  const { agent, collector, flush } = setup({ post: async () => { throw new Error('control down'); } });
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(collector.stats(), { sent: 0, dropped: 0, failed: 1, pending: 0, merged: 0 });
  await collector.close();
});

test('close flushes orphaned AI buffers once and then ignores late events', async () => {
  const { agent, collector, posts } = setup();
  agent.emit('transcript', { text: '未完成的回答', final: false, responseId: 'r9' });
  await collector.close();
  assert.deepEqual(posts[0].map(item => [item.role, item.text]), [['ai', '未完成的回答']]);
  agent.emit('transcript', { text: '太晚了', final: true, speaker: 'caller' });
  agent.emit('completed', { responseId: 'r9' });
  await collector.close();
  assert.equal(posts.length, 1);
});

test('S23: one caller sentence repeated verbatim becomes one transcript row', async () => {
  const { agent, collector, posts, flush } = setup();
  // Production shape: three identical `...transcription.completed` events inside one second.
  for (let i = 0; i < 3; i++) agent.emit('transcript', { text: '请问你是', final: true, speaker: 'caller' });
  assert.equal(collector.pending.length, 0, 'the utterance is still open for revision');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '请问你是']]);
  assert.equal(collector.stats().merged, 2, 'the folded duplicates are not reported');
  await collector.close();
});

test('S23: a caller sentence revised as a growing prefix keeps only its longest version', async () => {
  const { agent, collector, posts, flush } = setup();
  for (const text of ['呃，那我', '呃，那我这里还有个快递', '呃，那我这里还有个快递要寄'])
    agent.emit('transcript', { text, final: true, speaker: 'caller' });
  // A late shorter repeat is still the same utterance and must not truncate the finished sentence.
  agent.emit('transcript', { text: '呃，那我这里', final: true, speaker: 'caller' });
  // An unrelated sentence is never merged: it closes the held one and opens its own.
  agent.emit('transcript', { text: '好的谢谢', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => [item.sequence, item.text]), [[0, '呃，那我这里还有个快递要寄'], [1, '好的谢谢']]);
  assert.equal(collector.stats().merged, 3);
  await collector.close();
});

test('S23: a held caller sentence is posted before the AI reply it triggered', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的', final: false, responseId: 'r1' });
  agent.emit('completed', { responseId: 'r1' });
  assert.deepEqual(posts, [], 'nothing is posted before the flush');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '我要退款'], ['ai', 1, '好的']]);
  await collector.close();
});

test('S90: an immediate AI final (Doubao greeting) is posted first even if its completed never matches', async () => {
  const { agent, collector, posts, clock } = setup();
  agent.emit('transcript', { text: '您好，我是助理', final: true, responseId: 'K1', immediate: true });
  clock.ms += 15_000;
  agent.emit('transcript', { text: '我找王先生', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的，请稍等', final: true, responseId: 'K2' });
  agent.emit('completed', { responseId: 'K2' });
  agent.emit('completed', { responseId: 'other' });
  await collector.close();
  assert.deepEqual(posts.flat().map(item => [item.role, item.sequence, item.text]),
    [['ai', 0, '您好，我是助理'], ['caller', 1, '我找王先生'], ['ai', 2, '好的，请稍等']]);
});

test('S27: caller revisions 2.4 s apart are one utterance, not one row each', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  // Production shape from run 0407de3e (rows 2–4 at 43:29.7 / 43:31.8 / 43:34.3): a caller reading a
  // number aloud, each `...transcription.completed` event a longer prefix of the last, 2.1–2.5 s
  // apart. At the old 1.2 s hold this one sentence was written as four rows. This case is the plain
  // growing prefix; the re-punctuated shape the same run actually produced is the test below.
  for (const text of ['呃，请记下号码', '呃，请记下号码，388', '呃，请记下号码，388665', '呃，请记下号码，38866534。']) {
    agent.emit('transcript', { text, final: true, speaker: 'caller' });
    clock.ms += 2_400;
  }
  assert.equal(collector.pending.length, 0, 'the utterance is still open for revision');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '呃，请记下号码，38866534。']]);
  assert.equal(collector.stats().merged, 3);
  // The row is stamped when the caller started speaking, not when the last revision landed.
  assert.equal(posts[0][0].at, new Date(0).toISOString());
  await collector.close();
});

test('S27: the re-punctuated revisions of run 0407de3e become one row', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  // The four caller finals as stored for run 0407de3e. Each intermediate one closes with "。", which
  // the next revision rewrites into "，" — compared literally they are not prefixes, so before the
  // trailing-punctuation normalisation this single utterance could never merge, at any hold length.
  const revisions = ['呃，请记下号码。', '呃，请记下号码，388。', '呃，请记下号码，388665。', '呃，请记下号码，38866534。'];
  const gaps = [2_100, 2_500, 2_400];
  revisions.forEach((text, i) => {
    agent.emit('transcript', { text, final: true, speaker: 'caller' });
    clock.ms += gaps[i] ?? 0;
  });
  assert.equal(collector.pending.length, 0, 'the utterance is still open for revision');
  await flush();
  // The posted text keeps its punctuation: normalisation decides identity, it never edits the row.
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '呃，请记下号码，38866534。']]);
  assert.equal(collector.stats().merged, 3);
  await collector.close();
});

test('S27: a revision arriving after the hold window becomes its own row', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  agent.emit('transcript', { text: '呃，请记下号码。', final: true, speaker: 'caller' });
  clock.ms += 4_000;
  // Documented limitation: past callerHoldMs the utterance is considered finished and splits. No
  // timer runs in these tests, so this also pins the per-event expiry check in handleTranscript —
  // without it the split would depend on where the 2 s flush tick happened to fall.
  agent.emit('transcript', { text: '呃，请记下号码。388。', final: true, speaker: 'caller' });
  assert.equal(collector.pending.length, 1, 'the first half was posted the moment the window closed');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.sequence, item.text]), [[0, '呃，请记下号码。'], [1, '呃，请记下号码。388。']]);
  assert.equal(collector.stats().merged, 0);
  await collector.close();
});

test('S27: an unrelated sentence inside the hold window still opens its own row', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  agent.emit('transcript', { text: '呃，请记下号码。', final: true, speaker: 'caller' });
  clock.ms += 500;
  // The longer hold must not start merging different sentences: isSameUtterance stays prefix-based.
  agent.emit('transcript', { text: '今天几点下班', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => [item.sequence, item.text]), [[0, '呃，请记下号码。'], [1, '今天几点下班']]);
  assert.equal(collector.stats().merged, 0);
  await collector.close();
});

test('S27: a held caller utterance is posted before the AI reply, inside or past the hold window', async () => {
  // Inside the window flushResponse closes the utterance; past it the per-event expiry does. Either
  // way the caller keeps the lower sequence, so the conversation never reads AI-first.
  for (const gapMs of [2_500, 3_500]) {
    const { agent, collector, posts, clock, flush } = setup();
    agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
    clock.ms += gapMs;
    agent.emit('transcript', { text: '好的', final: false, responseId: 'r1' });
    agent.emit('completed', { responseId: 'r1' });
    await flush();
    assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]),
      [['caller', 0, '我要退款'], ['ai', 1, '好的']], `gap ${gapMs} ms keeps caller→ai order`);
    await collector.close();
  }
});

test('detach stops collecting and no timer runs before start', async () => {
  const { agent, collector, posts } = setup({ flushMs: 1 });
  assert.equal(collector.timer, undefined);
  collector.start(); assert.ok(collector.timer);
  collector.detach(agent);
  agent.emit('transcript', { text: '忽略', final: true, speaker: 'caller' });
  await collector.close();
  assert.deepEqual(posts, []);
  assert.equal(collector.timer, undefined);
});
