#!/usr/bin/env node
/**
 * Run every workspace's unit tests (packages/<name>/test/*.test.ts and
 * services/<name>/test/*.test.ts) with the same runner as the root suite
 * (`tsx --test`). Part of `npm run test:unit`, so CI runs them without any
 * workflow knowing a workspace exists. Refuses to pass when it found no test
 * file at all: a suite that quietly ran nothing is the failure mode this repo
 * keeps closing (scripts/check-studio.mjs).
 *
 *   node scripts/test-workspaces.mjs             run all
 *   node scripts/test-workspaces.mjs --list      print the files it would run
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_PACKAGE = join(ROOT, 'node_modules', 'tsx');

function testFiles() {
  const out = [];
  for (const group of ['packages', 'services']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      for (const testDir of ['test', 'tests']) {
        const dir = join(base, name, testDir);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir).sort()) if (/\.test\.(ts|mts|js|mjs)$/.test(f)) out.push(join(dir, f));
      }
    }
  }
  return out;
}

const files = testFiles();
if (process.argv.includes('--list')) {
  for (const f of files) console.log(f.slice(ROOT.length + 1));
  process.exit(0);
}
if (!existsSync(TSX_PACKAGE)) {
  console.error('test-workspaces: the tsx package is missing — run npm ci first');
  process.exit(1);
}
if (files.length === 0) {
  console.error('test-workspaces: found no workspace test files — refusing to report success for a suite that ran nothing');
  process.exit(1);
}
try {
  execFileSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: ROOT, stdio: 'inherit' });
  console.log(`test-workspaces: ${files.length} workspace test files passed`);
} catch {
  console.error('test-workspaces: a workspace test failed (see above)');
  process.exit(1);
}
