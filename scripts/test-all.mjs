#!/usr/bin/env node
/**
 * Run ALL THREE suites and report all three, then exit non-zero if any failed.
 *
 * `test:unit` used to be `tsx --test tests/*.test.ts && npm run test:workspaces`.
 * The `&&` meant one red root test hid every workspace suite: the deploy that
 * failed on five bundle-budget assertions never ran a single workspace test,
 * and nothing in the log said so. A gate that stops measuring the moment it
 * finds one fault tells you least exactly when you need it most.
 *
 * THE STUDIO IS THE THIRD RUN, and it was missing for the same reason
 * scripts/check-studio.mjs exists: studio/ is its own npm workspace, so a gate
 * written for the monolith could not see it. `test-workspaces.mjs` walks
 * packages/ and services/ only. So `npm run check`, `node scripts/test-all.mjs`
 * and `npm run build` could all read exit 0 on a commit that took four Studio
 * tests down with it — which is exactly what happened on 2026-09-22: the break
 * was found by workflow 8, in a deploy, after the push.
 *
 * It runs WITHOUT building studio/. Nearly every Studio test reads source and
 * the installed engine, so a bare run catches source-level breakage in seconds;
 * the two that genuinely need `studio/dist` say "skipped" in the open
 * (tests/rendered-html.test.mjs, tests/single-kernel.test.mjs) and workflow 8
 * still builds before it runs them. A visible skip is the house answer; a green
 * tick over an artifact nobody built is not.
 *
 * A missing studio/node_modules is a HARD FAILURE, not a skip, for the reason
 * check-studio.mjs states at length: reporting "0 errors" for code that was
 * never looked at is how a broken Studio once shipped for a day.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** No flags keeps the full local gate. CI may select one suite, and only the
 * root suite may be partitioned: --suite root --shard 1/16. --list prints that
 * root selection without running it. Unknown/duplicate flags are errors. */
export function parseTestArgs(argv) {
  const options = { suite: null, shard: null, list: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const match = /^(--suite|--shard)(?:=(.*))?$/.exec(argv[i]);
    const flag = match?.[1] ?? argv[i];
    if (!['--suite', '--shard', '--list'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or duplicate argument: ${argv[i]}`);
    seen.add(flag);
    if (flag === '--list') { options.list = true; continue; }
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--suite') {
      if (!['root', 'workspaces', 'studio'].includes(value)) throw new Error(`Invalid suite: ${value}`);
      options.suite = value;
    } else {
      const shard = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
      if (!shard) throw new Error('Shard must be positive N/T, for example 1/8');
      const index = Number(shard[1]), total = Number(shard[2]);
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) throw new Error('Shard must satisfy 1 <= N <= T with safe integers');
      options.shard = { index, total };
    }
  }
  if ((options.shard || options.list) && options.suite !== 'root') throw new Error('--shard and --list require --suite root');
  return options;
}

function requireFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Required file is missing: ${path}`);
}

function discoverTests(root, suffix) {
  const directory = join(root, 'tests');
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`Test directory is missing: ${directory}`);
  const files = readdirSync(directory).filter((name) => name.endsWith(suffix)).sort().map((name) => `tests/${name}`);
  if (!files.length) throw new Error(`No ${suffix} test files found in ${directory}`);
  for (const file of files) requireFile(join(root, file));
  return files;
}

/** Exactly the old tests/*.test.ts scope, explicitly sorted and shell-free. */
export const discoverRootTests = (root = ROOT) => discoverTests(root, '.test.ts');

/** Measured seconds per root file, checked in so every CI shard computes the
 * same plan without talking to anything. Regenerate it from a run's logs with
 * scripts/update-test-timings.mjs. */
export const ROOT_TIMINGS_FILE = 'scripts/test-timings.json';
const TIMING_KEY = /^tests\/[^/]+\.test\.ts$/;

/** A missing file only costs balance, never coverage: every file then weighs
 * the same. A file that is present but malformed is an error, because a typo
 * there would silently skew every shard. */
export function readRootTimings(root = ROOT) {
  const path = join(root, ROOT_TIMINGS_FILE);
  if (!existsSync(path)) return { concurrency: 3, files: {}, missing: true };
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch (failure) {
    throw new Error(`${ROOT_TIMINGS_FILE} is not valid JSON (${failure instanceof Error ? failure.message : String(failure)})`);
  }
  if (!data || typeof data !== 'object' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error(`${ROOT_TIMINGS_FILE} must hold a "files" object`);
  const concurrency = data.concurrency ?? 3;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error(`${ROOT_TIMINGS_FILE}: concurrency must be an integer from 1 to 64`);
  const files = {};
  for (const [file, seconds] of Object.entries(data.files)) {
    if (!TIMING_KEY.test(file)) throw new Error(`${ROOT_TIMINGS_FILE}: "${file}" is not a root test file (tests/<name>.test.ts)`);
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error(`${ROOT_TIMINGS_FILE}: "${file}" needs a positive number of seconds`);
    files[file] = seconds;
  }
  return { concurrency, files, missing: false };
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** How long one shard takes: `node --test` sorts its files by name and runs
 * `concurrency` of them at a time, each next file taking the first free slot.
 * On run 38144865240 it predicted all eight old shards to within about 4%. */
function shardFinishMs(sortedFiles, weightMs, concurrency) {
  const slots = new Array(concurrency).fill(0);
  for (const file of sortedFiles) {
    let free = 0;
    for (let slot = 1; slot < concurrency; slot++) if (slots[slot] < slots[free]) free = slot;
    slots[free] += weightMs.get(file);
  }
  return Math.max(...slots);
}

/** Duration-weighted, deterministic partition of the root files.
 *
 * Longest-processing-time first: files are taken heaviest first (ties by
 * name) and each goes to the shard that would then FINISH soonest, the finish
 * being simulated the way node --test schedules a shard (name order,
 * `concurrency` at a time) — so a heavy file is never parked at the end of a
 * shard where it would run alone. Ties go to the lighter shard, then the lower
 * index. A file with no measurement weighs the median of the measured ones.
 * Weights are whole milliseconds, so the plan is the same on every machine.
 *
 * Exact cover is checked, not assumed: every input file lands in exactly one
 * shard, and the union of the shards is the unsharded set. */
export function planRootShards(files, total, timings = readRootTimings()) {
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('The shard count must be a positive integer');
  if (new Set(files).size !== files.length) throw new Error('The root test list contains a duplicate');
  const concurrency = timings.concurrency ?? 3;
  const measured = timings.files ?? {};
  const known = files.filter((file) => Object.hasOwn(measured, file)).map((file) => Math.max(1, Math.round(measured[file] * 1000))).sort((a, b) => a - b);
  const middle = known.length >> 1;
  const median = !known.length ? 1000 : known.length % 2 ? known[middle] : Math.round((known[middle - 1] + known[middle]) / 2);
  const weightMs = new Map(files.map((file) => [file, Object.hasOwn(measured, file) ? Math.max(1, Math.round(measured[file] * 1000)) : median]));
  const shards = Array.from({ length: total }, () => ({ files: [], sumMs: 0, finishMs: 0 }));
  for (const file of [...files].sort((a, b) => weightMs.get(b) - weightMs.get(a) || byName(a, b))) {
    let best = -1, bestFinish = Infinity;
    shards.forEach((shard, index) => {
      const candidate = [...shard.files, file].sort(byName);
      const finish = shardFinishMs(candidate, weightMs, concurrency);
      if (finish < bestFinish || (finish === bestFinish && shard.sumMs < shards[best].sumMs)) { best = index; bestFinish = finish; }
    });
    const chosen = shards[best];
    chosen.files.push(file);
    chosen.files.sort(byName);
    chosen.sumMs += weightMs.get(file);
    chosen.finishMs = bestFinish;
  }
  const placed = shards.flatMap((shard) => shard.files), placedSet = new Set(placed);
  if (placed.length !== files.length || placedSet.size !== files.length || !files.every((file) => placedSet.has(file))) {
    throw new Error('The shard plan does not cover every root test file exactly once');
  }
  return shards.map((shard) => ({ files: shard.files, seconds: shard.finishMs / 1000, unmeasured: shard.files.filter((file) => !Object.hasOwn(measured, file)).length }));
}

function nonEmpty(files) {
  if (!files.length) throw new Error('The root test shard is empty; refusing to report success without tests');
  return files;
}

export function selectRootShard(files, shard, timings = readRootTimings()) {
  return nonEmpty(shard ? planRootShards(files, shard.total, timings)[shard.index - 1].files : files);
}

/** Windows caps a whole command line at 32,767 characters, and the unsharded
 * root list is longer than that: spawn failed with ENAMETOOLONG before a
 * single test ran. There the list runs as consecutive parts that each fit,
 * every file exactly once and in name order. Elsewhere the budget is
 * unlimited and one process runs the whole list, as before. */
export const WINDOWS_COMMAND_LINE_BUDGET = 30_000;

export function splitTestArgs(prefix, files, budget, command = process.execPath) {
  if (!Number.isFinite(budget)) return [[...prefix, ...files]];
  const cost = (arg) => arg.length + 3; // two quotes and a separating space
  const base = cost(command) + prefix.reduce((sum, arg) => sum + cost(arg), 0);
  const parts = [];
  let current = [], used = base;
  for (const file of files) {
    if (current.length && used + cost(file) > budget) { parts.push([...prefix, ...current]); current = []; used = base; }
    current.push(file);
    used += cost(file);
  }
  if (current.length) parts.push([...prefix, ...current]);
  return parts;
}

/** Dependencies and file discovery are validated before any suite runs. The
 * injected spawn/log adapters let regression tests prove aggregation without
 * recursively launching the actual repository suites. */
export function runTestSuites(argv, { root = ROOT, env = process.env, spawn = spawnSync, log = console.log, error = console.error, commandLineBudget = process.platform === 'win32' ? WINDOWS_COMMAND_LINE_BUDGET : Infinity } = {}) {
  try {
    const options = parseTestArgs(argv), studio = join(root, 'studio');
    requireFile(join(root, 'node_modules', 'tsx', 'package.json'));
    const studioPackage = join(studio, 'node_modules', 'three-slicer', 'package.json');
    if (!existsSync(studioPackage) || !statSync(studioPackage).isFile()) throw new Error('The Studio workspace is not installed. Run (cd studio && npm ci); its tests must not be skipped.');
    const guard = join(root, 'scripts', 'test-no-network.mjs');
    requireFile(guard);
    // NODE_OPTIONS is inherited by nested Node children too. Absolute URLs
    // keep the preload valid when the Studio child changes its cwd.
    // TZ: the Worker runs in UTC, and so does CI; a developer machine in
    // Baghdad (UTC+3) printed tomorrow's date on a receipt every evening from
    // 21:00 UTC. A TZ the developer sets on purpose is kept.
    const testEnv = { ...env, TZ: env.TZ || 'UTC', NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(guard).href}`.trim() };
    const suites = options.suite ? [options.suite] : ['root', 'workspaces', 'studio'];
    const runs = suites.map((name) => {
      if (name === 'root') {
        if (!options.shard) {
          const files = discoverRootTests(root);
          return { name, files, parts: splitTestArgs(['--import', 'tsx', '--test'], files, commandLineBudget), cwd: root };
        }
        const timings = readRootTimings(root);
        const plan = planRootShards(discoverRootTests(root), options.shard.total, timings)[options.shard.index - 1];
        const files = nonEmpty(plan.files);
        // A sharded run also prints each file's measured seconds, the input of
        // scripts/update-test-timings.mjs. A second reporter replaces node's
        // default, so TAP (its default without a terminal, as in CI) is named.
        const reporter = join(root, 'scripts', 'test-file-timings.mjs');
        requireFile(reporter);
        const note = `${files.length} files, about ${Math.round(plan.seconds)} s predicted${timings.missing ? ` (no ${ROOT_TIMINGS_FILE}: balanced by file count)` : ''}`;
        return { name, files, note, cwd: root, args: ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(reporter).href}`, '--test-reporter-destination=stdout', ...files] };
      }
      if (name === 'studio') {
        const files = discoverTests(studio, '.test.mjs');
        return { name, files, args: ['--test', ...files], cwd: studio };
      }
      const file = 'scripts/test-workspaces.mjs';
      requireFile(join(root, file));
      return { name, files: [file], args: [file], cwd: root };
    });
    if (options.list) {
      for (const file of runs[0].files) log(file);
      return 0;
    }
    const failed = [];
    for (const run of runs) {
      const parts = run.parts ?? [run.args];
      const split = parts.length > 1 ? ` in ${parts.length} parts (Windows command-line limit)` : '';
      log(`\ntest:unit: running ${run.name}${options.shard ? ` shard ${options.shard.index}/${options.shard.total}` : ''}${run.note ? ` (${run.note})` : ''}${split}`);
      try {
        for (const file of run.files) requireFile(join(run.cwd, file));
      } catch (failure) {
        failed.push(`${run.name} (${failure instanceof Error ? failure.message : String(failure)})`);
        continue;
      }
      parts.forEach((args, index) => {
        const label = parts.length > 1 ? `${run.name} part ${index + 1}/${parts.length}` : run.name;
        try {
          const result = spawn(process.execPath, args, { stdio: 'inherit', shell: false, cwd: run.cwd, env: testEnv });
          if (result.status !== 0 || result.error) failed.push(`${label} (${result.error?.message ?? `exit ${result.status ?? `signal ${result.signal}`}`})`);
        } catch (failure) {
          failed.push(`${label} (${failure instanceof Error ? failure.message : String(failure)})`);
        }
      });
    }
    if (failed.length) {
      error(`\ntest:unit FAILED — ${failed.join(', ')}. All ${runs.length} selected suites were attempted.`);
      return 1;
    }
    log(`\ntest:unit: ${suites.join(', ')} suites all green.`);
    return 0;
  } catch (failure) {
    error(`test-all: ${failure instanceof Error ? failure.message : String(failure)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runTestSuites(process.argv.slice(2));
