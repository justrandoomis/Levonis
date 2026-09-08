#!/usr/bin/env node
/**
 * Typecheck every npm workspace (packages/*, services/*) as part of the repo's
 * `npm run check` — the pattern of scripts/check-studio.mjs, for the same
 * reason: a check that cannot see part of the product reads as a clean bill of
 * health. Each workspace is checked with ITS OWN tsconfig (strict, Workers
 * types) using the root TypeScript, because the workspaces share the root
 * dependency tree. A workspace that exists but is not linked into
 * node_modules/@levonis fails hard: `npm install` was not run after the
 * package was added, so nothing that imports it was really checked either.
 *
 *   node scripts/check-workspaces.mjs            typecheck every workspace
 *   node scripts/check-workspaces.mjs --list     print the workspace directories
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

export function workspaceDirs(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = [];
  for (const pattern of pkg.workspaces ?? []) {
    const m = /^([^*]+)\/\*$/.exec(pattern);
    if (!m) throw new Error(`check-workspaces: only "<dir>/*" workspace patterns are supported, got ${pattern}`);
    const base = join(root, m[1]);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) out.push(dir);
    }
  }
  return out;
}

/**
 * Directories that are NOT npm workspaces but still hold TypeScript this
 * repository compiles: a `tsconfig.json` with no `package.json` beside it.
 * `services/probes` is the one today (ADR-017's throwaway Workers own no code
 * anyone imports, so making them a package would be a lie), and a probe that
 * does not compile answers nothing at the gate where it is finally run.
 */
export function unlinkedTsProjects(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = [];
  for (const pattern of pkg.workspaces ?? []) {
    const base = join(root, /^([^*]+)\/\*$/.exec(pattern)[1]);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'package.json'))) continue;
      if (existsSync(join(dir, 'tsconfig.json'))) out.push(dir);
    }
  }
  return out;
}

if (process.argv.includes('--list')) {
  for (const d of [...workspaceDirs(), ...unlinkedTsProjects()]) console.log(d);
  process.exit(0);
}

if (!existsSync(TSC)) {
  console.error('check-workspaces: node_modules/.bin/tsc is missing — run npm ci first');
  process.exit(1);
}

let failed = 0;
const dirs = workspaceDirs();
if (dirs.length === 0) {
  console.error('check-workspaces: no workspaces found under the patterns in package.json — refusing to report success for nothing');
  process.exit(1);
}
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const rel = dir.slice(ROOT.length + 1);
  const link = join(ROOT, 'node_modules', ...manifest.name.split('/'));
  if (!existsSync(link)) {
    console.error(`check-workspaces: ${rel} (${manifest.name}) is not linked in node_modules — run npm install so the workspace resolves`);
    failed++;
    continue;
  }
  if (!existsSync(join(dir, 'tsconfig.json'))) {
    console.error(`check-workspaces: ${rel} has no tsconfig.json — every workspace is typechecked with its own strict config`);
    failed++;
    continue;
  }
  try {
    execFileSync(TSC, ['--noEmit', '-p', join(dir, 'tsconfig.json')], { cwd: ROOT, stdio: 'inherit' });
    console.log(`check-workspaces: ${rel} typechecks clean`);
  } catch {
    console.error(`check-workspaces: ${rel} does not typecheck (see above)`);
    failed++;
  }
}
for (const dir of unlinkedTsProjects()) {
  const rel = dir.slice(ROOT.length + 1);
  try {
    execFileSync(TSC, ['--noEmit', '-p', join(dir, 'tsconfig.json')], { cwd: ROOT, stdio: 'inherit' });
    console.log(`check-workspaces: ${rel} typechecks clean (not a package: tsconfig only)`);
  } catch {
    console.error(`check-workspaces: ${rel} does not typecheck (see above)`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
