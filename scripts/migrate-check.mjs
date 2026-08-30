#!/usr/bin/env node
/**
 * Migration harness — mandate §12: "migrations تعمل على قاعدة جديدة وعلى نسخة
 * من schema الحالية، وتنجح مرتين دون تكرار أو تلف".
 *
 * Applies migrations/ to a throwaway SQLite database the way D1 does — one
 * transaction per file, foreign keys ON, bookkeeping in `d1_migrations` so a
 * file is never applied twice — and reports the exact statement that fails
 * instead of D1's opaque "rolled back … constraints were violated".
 *
 *   node scripts/migrate-check.mjs                  fresh database
 *   node scripts/migrate-check.mjs --from <file.sqlite>
 *                                                   an existing schema/data copy
 *   node scripts/migrate-check.mjs --twice          run the whole set twice and
 *                                                   prove the second pass is a
 *                                                   no-op, then re-execute the
 *                                                   newest migration's
 *                                                   idempotent statements and
 *                                                   prove no row is duplicated
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitStatements } from './lib/sql-split.mjs';

const OUT = process.env.MIGRATE_CHECK_DIR || '/tmp/levonis-migrate-check';
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const from = flag('--from');
const twice = args.includes('--twice');

function applyFile(db, file, sql) {
  const stmts = splitStatements(sql);
  db.exec('BEGIN');
  let n = 0;
  try {
    for (const s of stmts) { db.exec(s); n++; }
    db.exec('COMMIT');
  } catch (e) {
    const failing = stmts[n] ?? '(commit — a DEFERRED constraint was still violated)';
    // The transaction may already be closed; the original error is what matters.
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    console.error(`\n✘ ${file} — statement #${n + 1} of ${stmts.length} failed`);
    console.error(`  ${e.message}`);
    console.error(`  ---\n${failing.split('\n').slice(0, 12).join('\n')}\n  ---`);
    process.exit(1);
  }
  return stmts.length;
}

/** Mirrors wrangler's own bookkeeping table so a file runs at most once. */
function applyAll(db, { quiet = false } = {}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  );
  const applied = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const n = applyFile(db, f, readFileSync(join('migrations', f), 'utf8'));
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
    if (!quiet) console.log(`✔ ${f} (${n} statements)`);
    count++;
  }
  return count;
}

/** Statements a re-run must tolerate: everything except ALTER TABLE ADD COLUMN
 *  and the one-shot table rebuild, which D1's bookkeeping guarantees never
 *  runs a second time. */
const isIdempotent = (s) =>
  /^CREATE (TABLE|INDEX|UNIQUE INDEX)\s+IF NOT EXISTS/i.test(s) ||
  /^CREATE UNIQUE INDEX IF NOT EXISTS/i.test(s) ||
  /^INSERT OR IGNORE\s+INTO/i.test(s) ||
  (/^INSERT\s+INTO/i.test(s) && /WHERE NOT EXISTS/i.test(s));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const target = join(OUT, 'check.sqlite');
if (from) {
  copyFileSync(from, target);
  console.log(`base: copy of ${from}`);
} else {
  console.log('base: empty database');
}

const db = new DatabaseSync(target);
db.exec('PRAGMA foreign_keys = ON');
applyAll(db);

if (twice) {
  const again = applyAll(db, { quiet: true });
  if (again !== 0) { console.error(`✘ second pass re-applied ${again} file(s)`); process.exit(1); }
  console.log('✔ second full pass applied 0 files (bookkeeping holds)');

  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
  const newest = files[files.length - 1];
  const stmts = splitStatements(readFileSync(join('migrations', newest), 'utf8')).filter(isIdempotent);
  const countable = ['catalogs', 'facets', 'membership_plans', 'product_option_groups', 'product_images'];
  const before = Object.fromEntries(
    countable.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])
  );
  db.exec('BEGIN');
  for (const s of stmts) db.exec(s);
  db.exec('COMMIT');
  for (const t of countable) {
    const after = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    if (after !== before[t]) {
      console.error(`✘ re-running ${newest} changed ${t}: ${before[t]} → ${after}`);
      process.exit(1);
    }
  }
  console.log(`✔ ${newest}: ${stmts.length} idempotent statements re-ran with no row change`);
}

const tables = db.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).get();
const fk = db.prepare('PRAGMA foreign_key_check').all();
const orphanCat = db.prepare(
  'SELECT COUNT(*) AS n FROM catalogs c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalogs p WHERE p.id = c.parent_id)'
).get();
console.log(`\ntables: ${tables.n}   foreign_key_check violations: ${fk.length}   orphan catalogs: ${orphanCat.n}`);
if (fk.length) { console.error(JSON.stringify(fk.slice(0, 5), null, 2)); process.exit(1); }
if (orphanCat.n) process.exit(1);
db.close();
