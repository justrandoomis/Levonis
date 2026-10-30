/** The CI root shards are balanced by measured seconds, not by name order.
 *
 * Run 38144865240 split the root suite eight ways by name: its shards took
 * 6.5 to 14 minutes, and the slowest held the deploy. scripts/test-all.mjs now
 * plans the shards longest-file-first from scripts/test-timings.json, and
 * every sharded run prints the per-file seconds the next regeneration reads.
 * These tests pin the planner's rules on small worlds where the right answer
 * is known, then hold the real plan to them. Partition coverage of the real
 * file list is in testSuiteRunner.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { discoverRootTests, planRootShards, readRootTimings, ROOT_TIMINGS_FILE } from '../scripts/test-all.mjs';
import testFileTimings, { FILE_SECONDS_PREFIX, fileSecondsFromEvent } from '../scripts/test-file-timings.mjs';
import { main as updateTimings, mergeTimings, parseFileSeconds } from '../scripts/update-test-timings.mjs';

const t = (name: string) => `tests/${name}.test.ts`;
const world = (seconds: Record<string, number>, concurrency = 1) => ({ concurrency, files: Object.fromEntries(Object.entries(seconds).map(([name, value]) => [t(name), value])) });

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'levonis timings-'));
  const put = (file: string, text = '') => { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the heaviest files are placed first, each on the shard that finishes soonest', () => {
  // One file at a time per shard, so a shard's time is its sum: LPT gives
  // {10, 7, 6} and {9, 8, 5, 4}, 23 and 26 seconds.
  const timings = world({ a: 4, b: 5, c: 6, d: 7, e: 8, f: 9, g: 10 });
  const plan = planRootShards(Object.keys(timings.files), 2, timings);
  assert.deepEqual(plan.map((shard) => shard.files), [[t('c'), t('d'), t('g')], [t('a'), t('b'), t('e'), t('f')]]);
  assert.deepEqual(plan.map((shard) => shard.seconds), [23, 26]);
});

test('a shard is timed the way node --test runs it: name order, `concurrency` files at a time', () => {
  // Three files at a time in name order: 4 s, 4 s, 4 s start together, the
  // 12 s file starts at 4 s and ends at 16 s.
  const one = world({ a: 4, b: 4, c: 4, z: 12 }, 3);
  assert.equal(planRootShards(Object.keys(one.files), 1, one)[0].seconds, 16);
  // So a heavy file is never parked where it would run alone at the end: the
  // planner keeps the two 12 s files apart and fills around them.
  const two = world({ a: 4, b: 4, c: 4, d: 4, y: 12, z: 12 }, 3);
  const plan = planRootShards(Object.keys(two.files), 2, two);
  assert.equal(plan.filter((shard) => shard.files.includes(t('y')) || shard.files.includes(t('z'))).length, 2);
  assert.deepEqual(plan.map((shard) => shard.seconds), [12, 12]);
});

test('a file with no measurement weighs the median of the measured ones', () => {
  const odd = world({ a: 1, b: 2, c: 30 });
  const files = [...Object.keys(odd.files), t('new')];
  assert.deepEqual(planRootShards(files, 1, odd)[0], { files: files.sort(), seconds: 35, unmeasured: 1 });
  const even = world({ a: 1, b: 3 });
  assert.equal(planRootShards([t('a'), t('b'), t('new')], 1, even)[0].seconds, 6);
  // With no timings at all every file weighs the same, and the plan is still exact.
  const plan = planRootShards([t('a'), t('b'), t('c'), t('d')], 2, { concurrency: 3, files: {} });
  assert.deepEqual(plan.map((shard) => shard.files), [[t('a'), t('c')], [t('b'), t('d')]]);
});

test('the plan is deterministic: the same for any input order, on every call', () => {
  const files = discoverRootTests(), timings = readRootTimings();
  const first = planRootShards(files, 16, timings);
  const reversed = planRootShards([...files].reverse(), 16, timings);
  const shuffled = planRootShards([...files].sort((a, b) => (a.length - b.length) || (a < b ? 1 : -1)), 16, timings);
  assert.deepEqual(reversed, first);
  assert.deepEqual(shuffled, first);
  assert.deepEqual(planRootShards(files, 16, timings), first);
});

test('impossible plans are refused rather than guessed', () => {
  assert.throws(() => planRootShards([t('a'), t('a')], 2, world({})), /duplicate/);
  for (const total of [0, -1, 1.5, Number.NaN]) assert.throws(() => planRootShards([t('a')], total, world({})), /positive integer/);
});

test('the checked-in timings are well formed, measured on the CI runner, and give sixteen even shards', () => {
  const timings = readRootTimings();
  assert.equal(timings.missing, false, `${ROOT_TIMINGS_FILE} is checked in`);
  assert.equal(timings.concurrency, 3, 'node --test runs three files at a time on a 4-vCPU GitHub runner');
  const files = discoverRootTests();
  const measured = files.filter((file) => Object.hasOwn(timings.files, file)).length;
  assert.ok(measured >= files.length / 2, `${measured} of ${files.length} root files measured — regenerate ${ROOT_TIMINGS_FILE}`);
  const raw = readFileSync(new URL(`../${ROOT_TIMINGS_FILE}`, import.meta.url), 'utf8');
  const keys = Object.keys(JSON.parse(raw).files);
  assert.deepEqual(keys, [...keys].sort(), 'sorted keys keep regenerations reviewable');
  const plan = planRootShards(files, 16, timings);
  const total = files.reduce((sum, file) => sum + (timings.files[file] ?? 0), 0);
  const ideal = total / timings.concurrency / 16;
  const slowest = Math.max(...plan.map((shard) => shard.seconds));
  assert.ok(slowest <= ideal * 1.1, `slowest shard ${slowest.toFixed(0)} s against an even ${ideal.toFixed(0)} s`);
});

test('malformed timings are an error; a missing file only costs balance', () => {
  const cases: Array<[string, RegExp]> = [
    ['{', /not valid JSON/],
    ['[]', /"files" object/],
    ['{"files": []}', /"files" object/],
    ['{"files": {"tests/a.test.ts": 0}}', /positive number/],
    ['{"files": {"tests/a.test.ts": -3}}', /positive number/],
    ['{"files": {"tests/a.test.ts": "7"}}', /positive number/],
    ['{"files": {"tests/nested/a.test.ts": 7}}', /not a root test file/],
    ['{"files": {"studio/tests/a.test.mjs": 7}}', /not a root test file/],
    ['{"concurrency": 0, "files": {}}', /concurrency/],
    ['{"concurrency": 2.5, "files": {}}', /concurrency/],
  ];
  for (const [text, message] of cases) {
    const r = tempRoot();
    try {
      r.put(ROOT_TIMINGS_FILE, text);
      assert.throws(() => readRootTimings(r.root), message, text);
    } finally { r.cleanup(); }
  }
  const r = tempRoot();
  try {
    assert.deepEqual(readRootTimings(r.root), { concurrency: 3, files: {}, missing: true });
    r.put(ROOT_TIMINGS_FILE, '{"files": {"tests/a.test.ts": 7.5}}');
    assert.deepEqual(readRootTimings(r.root), { concurrency: 3, files: { 'tests/a.test.ts': 7.5 }, missing: false });
  } finally { r.cleanup(); }
});

test('the timing reporter reports each file once, from node\'s file-level event only', async () => {
  // Absolute in this platform's form, as node reports it ('/work/repo' on Linux, 'C:\work\repo' on Windows).
  const cwd = resolve('/work/repo');
  const file = join(cwd, 'tests/a.test.ts');
  const event = (type: string, data: object) => ({ type, data });
  assert.deepEqual(fileSecondsFromEvent(event('test:complete', { file, name: 'tests/a.test.ts', nesting: 0, details: { duration_ms: 1234.5 } }), cwd), { file: 'tests/a.test.ts', seconds: 1.2345 });
  for (const ignored of [
    event('test:pass', { file, name: 'tests/a.test.ts', nesting: 0, details: { duration_ms: 1 } }),
    event('test:complete', { file, name: 'a test inside the file', nesting: 0, details: { duration_ms: 1 } }),
    event('test:complete', { file, name: 'tests/a.test.ts', nesting: 1, details: { duration_ms: 1 } }),
    event('test:complete', { name: 'tests/a.test.ts', nesting: 0, details: { duration_ms: 1 } }),
    event('test:complete', { file, name: 'tests/a.test.ts', nesting: 0, details: {} }),
    event('test:stdout', { file, message: 'x' }),
  ]) assert.equal(fileSecondsFromEvent(ignored, cwd), null);

  const here = process.cwd();
  async function* events() {
    yield event('test:complete', { file: join(here, 'tests/z.test.ts'), name: 'tests/z.test.ts', nesting: 0, details: { duration_ms: 2000 } });
    yield event('test:complete', { file: join(here, 'tests/z.test.ts'), name: 'it works', nesting: 0, details: { duration_ms: 1999 } });
    yield event('test:complete', { file: join(here, 'tests/a.test.ts'), name: 'tests/a.test.ts', nesting: 0, details: { duration_ms: 500.4 } });
  }
  const lines: string[] = [];
  for await (const line of testFileTimings(events())) lines.push(line);
  assert.deepEqual(lines, [`${FILE_SECONDS_PREFIX}tests/a.test.ts 0.500\n`, `${FILE_SECONDS_PREFIX}tests/z.test.ts 2.000\n`]);
  assert.ok(FILE_SECONDS_PREFIX.startsWith('# '), 'a TAP comment, never a test line');
});

test('regeneration reads the per-file lines out of GitHub job logs and keeps the largest of duplicates', () => {
  const log = [
    '﻿2026-10-13T10:00:00.0000000Z Current runner version: x',
    `2026-10-13T10:09:59.1000000Z ${FILE_SECONDS_PREFIX}tests/a.test.ts 12.345`,
    `2026-10-13T10:09:59.2000000Z ${FILE_SECONDS_PREFIX}tests/b.test.ts 3`,
    `${FILE_SECONDS_PREFIX}tests/a.test.ts 11.0`,
    `2026-10-13T10:09:59.3000000Z ${FILE_SECONDS_PREFIX}tests/nested/c.test.ts 9`,
    `2026-10-13T10:09:59.4000000Z ${FILE_SECONDS_PREFIX}tests/d.test.ts -1`,
    `2026-10-13T10:09:59.5000000Z ok 1 - ${FILE_SECONDS_PREFIX}tests/e.test.ts 5`,
  ].join('\r\n');
  assert.deepEqual([...parseFileSeconds(log)], [['tests/a.test.ts', 12.345], ['tests/b.test.ts', 3]]);
  const merged = mergeTimings({ 'tests/b.test.ts': 9.9, 'tests/c.test.ts': 4.2, 'tests/gone.test.ts': 99 }, new Map([['tests/a.test.ts', 12.345], ['tests/b.test.ts', 0.01], ['tests/gone2.test.ts', 5]]), ['tests/c.test.ts', 'tests/b.test.ts', 'tests/a.test.ts', 'tests/new.test.ts']);
  assert.deepEqual(Object.entries(merged), [['tests/a.test.ts', 12.3], ['tests/b.test.ts', 0.1], ['tests/c.test.ts', 4.2]]);
});

test('regeneration writes a sorted, valid timings file from a log folder, and refuses logs with nothing to read', () => {
  const r = tempRoot();
  try {
    for (const name of ['a', 'b', 'c']) r.put(t(name));
    r.put(ROOT_TIMINGS_FILE, `${JSON.stringify({ about: 'x', source: 'old', concurrency: 3, files: { [t('c')]: 4, [t('gone')]: 8 } })}\n`);
    r.put('.github/workflows/verify-all.yml', "        run: node scripts/test-all.mjs --suite root --shard '${{ matrix.shard }}/2'\n");
    r.put('logs/verify  Root tests (1_2)/6_Run.txt', `2026-10-13T10:00:00.0000000Z ${FILE_SECONDS_PREFIX}tests/b.test.ts 20.04\n`);
    r.put('logs/0_verify  Root tests (1_2).txt', `2026-10-13T10:00:00.0000000Z ${FILE_SECONDS_PREFIX}tests/b.test.ts 20.06\n${FILE_SECONDS_PREFIX}tests/a.test.ts 7\n`);
    r.put('logs/notes.md', `${FILE_SECONDS_PREFIX}tests/c.test.ts 1000\n`);
    const out: string[] = [];
    const quiet = { root: r.root, log: (line: string) => out.push(line), error: (line: string) => out.push(line) };

    assert.equal(updateTimings([join(r.root, 'logs'), '--dry-run'], quiet), 0);
    assert.match(readFileSync(join(r.root, ROOT_TIMINGS_FILE), 'utf8'), /"source":"old"/, 'a dry run writes nothing');

    assert.equal(updateTimings([join(r.root, 'logs'), '--source', 'run 1 (abc)'], quiet), 0);
    const written = JSON.parse(readFileSync(join(r.root, ROOT_TIMINGS_FILE), 'utf8'));
    assert.equal(written.source, 'run 1 (abc)');
    assert.equal(written.concurrency, 3);
    assert.deepEqual(Object.entries(written.files), [[t('a'), 7], [t('b'), 20.1], [t('c'), 4]], 'measured, kept and dropped as documented; .md logs are not read');
    assert.deepEqual(readRootTimings(r.root).files, written.files, 'the planner accepts what regeneration writes');
    assert.match(out.join('\n'), /verify-all\.yml's 2 shards: about \d+ s for the slowest/);

    r.put('empty/job.txt', 'ok 1 - nothing timed here\n');
    assert.equal(updateTimings([join(r.root, 'empty')], quiet), 1);
    assert.equal(updateTimings([join(r.root, 'missing')], quiet), 1);
    assert.equal(updateTimings([], quiet), 1);
    assert.equal(updateTimings([join(r.root, 'logs'), '--force'], quiet), 1);
    assert.ok(existsSync(join(r.root, ROOT_TIMINGS_FILE)));
  } finally { r.cleanup(); }
});
