import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverRootTests, parseTestArgs, planRootShards, readRootTimings, runTestSuites, selectRootShard } from '../scripts/test-all.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'levonis suite-'));
  const put = (file: string, text = '') => { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put('node_modules/tsx/package.json', '{}');
  put('studio/node_modules/three-slicer/package.json', '{}');
  put('scripts/test-workspaces.mjs');
  put('scripts/test-no-network.mjs', readFileSync(new URL('../scripts/test-no-network.mjs', import.meta.url), 'utf8'));
  put('scripts/test-file-timings.mjs', readFileSync(new URL('../scripts/test-file-timings.mjs', import.meta.url), 'utf8'));
  put('studio/tests/z.test.mjs'); put('studio/tests/a.test.mjs');
  for (let index = 0; index < 17; index++) put(`tests/root-${String(index).padStart(2, '0')}.test.ts`);
  put('tests/nested/not-root.test.ts'); put('tests/not-root.test.mjs');
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const quiet = { log: () => {}, error: () => {} };

test('root shard manifests partition every discovered real root file exactly once, at every shard count CI could use', () => {
  const files = discoverRootTests();
  assert.ok(files.length > 800);
  assert.deepEqual(files, [...files].sort());
  const timings = readRootTimings();
  for (const total of [1, 4, 8, 12, 16, 17, 20, 32]) {
    const shards = Array.from({ length: total }, (_, index) => selectRootShard(files, { index: index + 1, total }, timings));
    const combined = shards.flat();
    assert.ok(shards.every((shard) => shard.length > 0), `${total}: no shard may be empty`);
    assert.equal(combined.length, files.length, `${total}: no root file may run in two shards`);
    assert.equal(new Set(combined).size, files.length, `${total}: no root file may run in two shards`);
    assert.deepEqual([...combined].sort(), files, `${total}: no existing or newly added root file may be omitted`);
    assert.ok(shards.every((shard) => shard.join('\n') === [...shard].sort().join('\n')), `${total}: each shard lists its files in name order`);
    assert.deepEqual(planRootShards(files, total, timings).map((shard) => shard.files), shards, `${total}: the manifest is the plan`);
    assert.deepEqual(selectRootShard(files, { index: Math.min(3, total), total }), shards[Math.min(3, total) - 1], `${total}: the default timings are the checked-in ones`);
  }
});

test('a new root file the timings have never seen still runs in exactly one shard, and a deleted one is ignored', () => {
  const before = discoverRootTests(), files = [...before, 'tests/zzzBrandNewFile.test.ts'].sort();
  const timings = readRootTimings();
  const gone = { ...timings, files: { ...timings.files, 'tests/aaaDeletedLongAgo.test.ts': 9999 } };
  const plan = planRootShards(files, 16, gone);
  assert.deepEqual(plan.flatMap((shard) => shard.files).sort(), files);
  assert.equal(plan.filter((shard) => shard.files.includes('tests/zzzBrandNewFile.test.ts')).length, 1);
  const unmeasured = (shards: Array<{ unmeasured: number }>) => shards.reduce((sum, shard) => sum + shard.unmeasured, 0);
  assert.equal(unmeasured(plan), unmeasured(planRootShards(before, 16, gone)) + 1, 'the new file is counted as unmeasured');
  assert.ok(!plan.some((shard) => shard.files.includes('tests/aaaDeletedLongAgo.test.ts')), 'a timing never adds a file');
});

test('strict argument parsing refuses typos, duplicate flags and invalid or ambiguous shards', () => {
  assert.deepEqual(parseTestArgs([]), { suite: null, shard: null, list: false });
  assert.deepEqual(parseTestArgs(['--suite=root', '--shard=2/8', '--list']), { suite: 'root', shard: { index: 2, total: 8 }, list: true });
  for (const args of [
    ['--skip'], ['root'], ['--suite'], ['--suite', 'all'], ['--suite', 'Root'], ['--suite=root', '--suite', 'studio'],
    ['--shard', '1/8'], ['--list'], ['--suite', 'studio', '--list'], ['--suite', 'workspaces', '--shard', '1/8'],
    ['--suite', 'root', '--list', '--list'], ['--suite', 'root', '--shard', '1/8', '--shard', '2/8'],
    ...['0/8', '1/0', '9/8', '-1/8', '01/8', '1.5/8', '1', '1/8/9', '1/9007199254740992'].map((value) => ['--suite', 'root', '--shard', value]),
  ]) assert.throws(() => parseTestArgs(args), Error, args.join(' '));
});

test('default runner attempts all three isolated suites even after failures or spawn errors', () => {
  const f = fixture();
  try {
    f.put('tests/literal$(echo bad).test.ts');
    const attempted: Array<{ args: string[]; cwd: string | URL | undefined }> = [], failures: string[] = [];
    const status = runTestSuites([], { root: f.root, env: { NODE_OPTIONS: '--no-warnings', TEST_SENTINEL: 'kept' }, log: quiet.log, error: (line) => failures.push(line),
      spawn: (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(options.shell, false, 'file arguments must never be expanded by a shell');
        assert.equal(options.env?.TEST_SENTINEL, 'kept');
        assert.equal(options.env?.NODE_OPTIONS, `--no-warnings --import=${pathToFileURL(join(f.root, 'scripts/test-no-network.mjs')).href}`);
        attempted.push({ args, cwd: options.cwd });
        if (attempted.length === 1) return { status: 7 };
        if (attempted.length === 2) throw new Error('Simulated spawn failure');
        return { status: 0 };
      },
    });
    assert.equal(status, 1);
    assert.equal(attempted.length, 3);
    assert.deepEqual(attempted[0].args, ['--import', 'tsx', '--test', ...discoverRootTests(f.root)]);
    assert.deepEqual(attempted[1].args, ['scripts/test-workspaces.mjs']);
    assert.deepEqual(attempted[2], { args: ['--test', 'tests/a.test.mjs', 'tests/z.test.mjs'], cwd: join(f.root, 'studio') });
    assert.match(failures.join('\n'), /root \(exit 7\).*workspaces \(Simulated spawn failure\).*All 3 selected suites were attempted/s);
  } finally { f.cleanup(); }
});

test('a sharded root run adds the per-file timing reporter beside TAP and runs exactly its planned files', () => {
  const f = fixture();
  try {
    const plan = planRootShards(discoverRootTests(f.root), 4, readRootTimings(f.root));
    const lines: string[] = [];
    let args: string[] = [];
    assert.equal(runTestSuites(['--suite', 'root', '--shard', '2/4'], { root: f.root, error: () => {}, log: (line) => lines.push(line), spawn: (_command, spawned) => { args = spawned; return { status: 0 }; } }), 0);
    const reporter = pathToFileURL(join(f.root, 'scripts/test-file-timings.mjs')).href;
    assert.deepEqual(args, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', ...plan[1].files]);
    assert.match(lines.join('\n'), /running root shard 2\/4 \(\d+ files, about \d+ s predicted \(no scripts\/test-timings\.json: balanced by file count\)\)/);
    rmSync(join(f.root, 'scripts/test-file-timings.mjs'));
    assert.equal(runTestSuites(['--suite', 'root', '--shard', '2/4'], { root: f.root, ...quiet, spawn: () => assert.fail('a shard without its timing reporter must not start') }), 1);
    f.put('scripts/test-file-timings.mjs');
    f.put('scripts/test-timings.json', '{"files": {"tests/root-00.test.ts": -1}}');
    assert.equal(runTestSuites(['--suite', 'root', '--shard', '2/4'], { root: f.root, ...quiet, spawn: () => assert.fail('malformed timings must not start a shard') }), 1);
  } finally { f.cleanup(); }
});

test('selected suite and root manifest modes never launch unselected suites', () => {
  const f = fixture();
  try {
    const listed: string[] = [];
    assert.equal(runTestSuites(['--suite', 'root', '--shard', '2/8', '--list'], { root: f.root, ...quiet, log: (line) => listed.push(line), spawn: () => assert.fail('list must not execute tests') }), 0);
    assert.deepEqual(listed, selectRootShard(discoverRootTests(f.root), { index: 2, total: 8 }));
    for (const suite of ['root', 'workspaces', 'studio']) {
      let called = 0;
      assert.equal(runTestSuites(['--suite', suite], { root: f.root, ...quiet, spawn: () => { called++; return { status: 0 }; } }), 0);
      assert.equal(called, 1);
    }
  } finally { f.cleanup(); }
});

test('missing dependencies, helpers, test files and empty shards fail closed before a test process starts', () => {
  for (const missing of ['node_modules/tsx/package.json', 'studio/node_modules/three-slicer/package.json', 'scripts/test-no-network.mjs', 'scripts/test-workspaces.mjs', 'tests', 'studio/tests']) {
    const f = fixture();
    try {
      rmSync(join(f.root, missing), { recursive: true });
      assert.equal(runTestSuites([], { root: f.root, ...quiet, spawn: () => assert.fail(`must refuse missing ${missing}`) }), 1, missing);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    assert.equal(runTestSuites(['--suite', 'root', '--shard', '18/18'], { root: f.root, ...quiet, spawn: () => assert.fail('empty shard must fail') }), 1);
    mkdirSync(join(f.root, 'tests', 'directory.test.ts'));
    assert.equal(runTestSuites(['--suite', 'root'], { root: f.root, ...quiet, spawn: () => assert.fail('a matching directory is not a test file') }), 1);
  } finally { f.cleanup(); }
});

test('the inherited absolute preload blocks external fetch inside a child whose working directory is Studio', () => {
  const f = fixture();
  try {
    assert.equal(runTestSuites(['--suite', 'studio'], { root: f.root, env: { ...process.env, NODE_OPTIONS: '--no-warnings' }, ...quiet,
      spawn: (command, _args, options) => {
        const result = spawnSync(command, ['--input-type=module', '--eval', `
          try { await fetch('https://unit-test.invalid'); process.exitCode = 2; }
          catch (error) { if (!String(error).includes('External network is disabled')) process.exitCode = 3; }
        `], { ...options, stdio: 'pipe' });
        assert.equal(result.status, 0, String(result.stderr));
        return result;
      },
    }), 0);
  } finally { f.cleanup(); }
});
