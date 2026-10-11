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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** No flags keeps the full local gate. CI may select one suite, and only the
 * root suite may be partitioned: --suite root --shard 1/8. --list prints that
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

export function selectRootShard(files, shard) {
  const selected = shard ? files.filter((_, index) => index % shard.total === shard.index - 1) : files;
  if (!selected.length) throw new Error('The root test shard is empty; refusing to report success without tests');
  return selected;
}

/** Dependencies and file discovery are validated before any suite runs. The
 * injected spawn/log adapters let regression tests prove aggregation without
 * recursively launching the actual repository suites. */
export function runTestSuites(argv, { root = ROOT, env = process.env, spawn = spawnSync, log = console.log, error = console.error } = {}) {
  try {
    const options = parseTestArgs(argv), studio = join(root, 'studio');
    requireFile(join(root, 'node_modules', 'tsx', 'package.json'));
    const studioPackage = join(studio, 'node_modules', 'three-slicer', 'package.json');
    if (!existsSync(studioPackage) || !statSync(studioPackage).isFile()) throw new Error('The Studio workspace is not installed. Run (cd studio && npm ci); its tests must not be skipped.');
    const guard = join(root, 'scripts', 'test-no-network.mjs');
    requireFile(guard);
    // NODE_OPTIONS is inherited by nested Node children too. Absolute URLs
    // keep the preload valid when the Studio child changes its cwd.
    const testEnv = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(guard).href}`.trim() };
    const suites = options.suite ? [options.suite] : ['root', 'workspaces', 'studio'];
    const runs = suites.map((name) => {
      if (name === 'root') {
        const files = selectRootShard(discoverRootTests(root), options.shard);
        return { name, files, args: ['--import', 'tsx', '--test', ...files], cwd: root };
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
      log(`\ntest:unit: running ${run.name}${options.shard ? ` shard ${options.shard.index}/${options.shard.total}` : ''}`);
      try {
        for (const file of run.files) requireFile(join(run.cwd, file));
        const result = spawn(process.execPath, run.args, { stdio: 'inherit', shell: false, cwd: run.cwd, env: testEnv });
        if (result.status !== 0 || result.error) failed.push(`${run.name} (${result.error?.message ?? `exit ${result.status ?? `signal ${result.signal}`}`})`);
      } catch (failure) {
        failed.push(`${run.name} (${failure instanceof Error ? failure.message : String(failure)})`);
      }
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
