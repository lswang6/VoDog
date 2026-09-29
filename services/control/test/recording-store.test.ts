import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RecordingStore, RecordingStoreError, recordingByteRange } from '../src/recording-store.js';
const id = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cc-recording-'));
  const dir = join(root, id); await mkdir(dir);
  const artifacts = [];
  for (const name of ['remote_original.ogg', 'caller_original.ogg', 'timeline.jsonl']) {
    const content = Buffer.from(name === 'timeline.jsonl' ? '{}\n' : 'OggS0123456789');
    await writeFile(join(dir, name), content);
    artifacts.push({ name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const manifest = { version: 1, callId: id, finalizedAt: new Date().toISOString(), complete: true, artifacts };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { root, dir, manifest, store: new RecordingStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function bytes(stream: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString();
}
test('finalized recording verifies checksums and streams exact byte ranges', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.manifest(id))?.complete, true);
    const full = await f.store.openTrack(id, 'remote_original'); assert.equal(await bytes(full.stream), 'OggS0123456789');
    const ranged = await f.store.openTrack(id, 'caller_original', 'bytes=4-7');
    assert.equal(ranged.partial, true); assert.equal(await bytes(ranged.stream), '0123');
    const suffix = await f.store.openTrack(id, 'caller_original', 'bytes=-3'); assert.equal(await bytes(suffix.stream), '789');
    await writeFile(join(f.dir, 'caller_original.ogg'), 'OggScorruption');
    await assert.rejects(() => f.store.openTrack(id, 'caller_original'), (e: unknown) => e instanceof RecordingStoreError && e.code === 'RECORDING_CORRUPT');
  } finally { await f.cleanup(); }
});
test('recordings reject traversal, symlinks and mismatched call manifests', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.store.manifest('../secret'));
    await assert.rejects(() => f.store.openTrack(id, '../manifest' as never));
    await rm(join(f.dir, 'caller_original.ogg')); await symlink(join(f.dir, 'remote_original.ogg'), join(f.dir, 'caller_original.ogg'));
    await assert.rejects(() => f.store.openTrack(id, 'caller_original'));
    const other = '22222222-2222-4222-8222-222222222222'; await symlink(f.dir, join(f.root, other));
    await assert.rejects(() => f.store.manifest(other));
    await writeFile(join(f.dir, 'manifest.json'), JSON.stringify({ ...f.manifest, callId: other }));
    await assert.rejects(() => f.store.manifest(id));
    assert.equal(await f.store.manifest('33333333-3333-4333-8333-333333333333'), null);
  } finally { await f.cleanup(); }
});
test('manifest durationMs sums timeline packet durations and never uses byte length', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-recording-duration-'));
  const dir = join(root, id); await mkdir(dir);
  const remote = Buffer.from('OggS0123456789');
  const caller = Buffer.from('OggS0123456789');
  const timeline = Buffer.from('{"direction":"remote_original","durationMs":20}\n{"direction":"caller_original","durationMs":15}\n{"direction":"remote_original","durationMs":10}\n');
  const artifacts = [
    { name: 'remote_original.ogg', bytes: remote.length, sha256: createHash('sha256').update(remote).digest('hex') },
    { name: 'caller_original.ogg', bytes: caller.length, sha256: createHash('sha256').update(caller).digest('hex') },
    { name: 'timeline.jsonl', bytes: timeline.length, sha256: createHash('sha256').update(timeline).digest('hex') },
  ];
  await writeFile(join(dir, 'remote_original.ogg'), remote);
  await writeFile(join(dir, 'caller_original.ogg'), caller);
  await writeFile(join(dir, 'timeline.jsonl'), timeline);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 1, callId: id, finalizedAt: new Date().toISOString(), complete: true, artifacts }));
  try {
    const store = new RecordingStore(root);
    const manifest = await store.manifest(id);
    const byName = Object.fromEntries((manifest?.artifacts ?? []).map((item) => [item.name, item]));
    assert.equal(byName['remote_original.ogg']?.durationMs, 30);
    assert.equal(byName['caller_original.ogg']?.durationMs, 15);
    assert.equal(byName['timeline.jsonl']?.durationMs, undefined);
    assert.notEqual(byName['remote_original.ogg']?.durationMs, remote.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('single range parsing rejects unsafe/multiple/unsatisfiable requests', () => {
  for (const value of ['bytes=99-', 'bytes=9-4', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=999999999999999999999-', 'bytes=a-b']) {
    assert.throws(() => recordingByteRange(value, 10), (e: unknown) => e instanceof RecordingStoreError && e.code === 'RANGE_NOT_SATISFIABLE');
  }
  assert.deepEqual(recordingByteRange('bytes=3-999', 10), { start: 3, end: 9, partial: true });
  assert.deepEqual(recordingByteRange('bytes=-99', 10), { start: 0, end: 9, partial: true });
});
