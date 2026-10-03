#!/usr/bin/env node
/** The live D1 /query parser rejects compound triggers in 0099 and 0162.
 * File ingestion restores its pre-import state on failure; include the D1
 * bookkeeping row in the same file so schema and history commit together.
 * Apply pending files in order, rather than importing 0162 ahead of older
 * migrations or returning to `migrations apply` and its broken query path.
 * The existing deployment workflow must record a restore bookmark first. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These are the live historical names (docs/WORKERS.md). Do not derive the
// target from an optional environment variable or silently select another DB.
const DATABASE = 'levonis-db-staging';
const ENVIRONMENT = 'staging';
const directory = join(process.cwd(), 'migrations');
const command = ['--no-install', 'wrangler', 'd1', 'execute', DATABASE, '--remote', '--env', ENVIRONMENT, '--yes', '--json'];

function execute(args) {
  const result = spawnSync('npx', [...command, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr.trim()) console.error(result.stderr.trim());
    if (result.stdout.trim()) console.error(result.stdout.trim());
    throw new Error(`Wrangler failed (exit ${result.status ?? 'signal'}) — no further migration will run`);
  }
  let response;
  try { response = JSON.parse(result.stdout); } catch {
    throw new Error('Wrangler did not return valid JSON — migration state is unconfirmed');
  }
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true || !Array.isArray(response[0].results))
    throw new Error('Wrangler did not confirm successful execution — no further migration will run');
  return response[0];
}

function history() {
  const rows = execute(['--command', 'SELECT name FROM d1_migrations ORDER BY name']).results;
  if (rows.length === 0) throw new Error('Remote migration history is empty — refusing to bootstrap the live database');
  if (rows.some((row) => typeof row?.name !== 'string' || !row.name.endsWith('.sql')))
    throw new Error('Remote migration history is malformed');
  const names = new Set(rows.map((row) => row.name));
  if (names.size !== rows.length) throw new Error('Remote migration history contains duplicate names');
  return names;
}

let scratch;
try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/apply-remote-migrations.mjs (live DB and staging environment are fixed)');
  const files = readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  if (!files.length || files.some((file) => !/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(file)))
    throw new Error('Migration files must have unique sortable numbered names');
  if (new Set(files.map((file) => file.slice(0, 4))).size !== files.length)
    throw new Error('Duplicate migration numbers');

  let applied = history();
  let newlyApplied = 0;
  console.log(`Live migration history confirmed: ${applied.size} files`);
  for (const [index, file] of files.entries()) {
    if (applied.has(file)) continue;
    if (files.slice(0, index).some((prior) => !applied.has(prior)))
      throw new Error(`Cannot apply ${file} before its predecessors are confirmed`);
    scratch ??= mkdtempSync(join(tmpdir(), 'levonis-remote-migrations-'));
    const bundle = join(scratch, file);
    writeFileSync(bundle,
      `${readFileSync(join(directory, file), 'utf8')}\n\nINSERT INTO d1_migrations (name) VALUES ('${file}');\n`,
      { mode: 0o600 });
    console.log(`Applying ${file} through atomic file ingestion`);
    execute(['--file', bundle]);
    const confirmed = history();
    if (!confirmed.has(file) || [...applied].some((prior) => !confirmed.has(prior)))
      throw new Error(`Remote history did not confirm ${file} and all prior migrations — stopping`);
    applied = confirmed;
    newlyApplied++;
    console.log(`Confirmed ${file}`);
  }
  console.log(`Live migrations current: ${files.length} repository files confirmed; ${newlyApplied} newly applied`);
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
