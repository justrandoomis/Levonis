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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = join(ROOT, 'studio');

if (!existsSync(join(STUDIO, 'node_modules', 'three-slicer'))) {
  console.error(
    'test-all: the Studio workspace is not installed, so its tests were NOT run.\n' +
      '  Install it first:  (cd studio && npm ci)\n' +
      '  (Hard failure on purpose — see the note above.)'
  );
  process.exit(1);
}

const runs = [
  { name: 'root', cmd: process.execPath, args: ['--import', 'tsx', '--test', 'tests/*.test.ts'], shell: true, cwd: ROOT },
  { name: 'workspaces', cmd: 'node', args: ['scripts/test-workspaces.mjs'], shell: false, cwd: ROOT },
  { name: 'studio', cmd: process.execPath, args: ['--test', 'tests/*.test.mjs'], shell: true, cwd: STUDIO },
];

const failed = [];
for (const run of runs) {
  const res = spawnSync(run.cmd, run.args, { stdio: 'inherit', shell: run.shell, cwd: run.cwd });
  if (res.status !== 0) failed.push(`${run.name} (exit ${res.status ?? 'signal ' + res.signal})`);
}

if (failed.length > 0) {
  console.error(`\ntest:unit FAILED — ${failed.join(', ')}. All three suites above ran; read all three.`);
  process.exit(1);
}
console.log('\ntest:unit: root, workspace and Studio suites all green.');
