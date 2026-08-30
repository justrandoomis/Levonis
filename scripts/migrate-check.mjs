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
  (/^INSERT\s+INTO/i.test(s) && /WHERE NOT EXISTS/i.test(s)) ||
  // An UPDATE that only assigns LITERALS is idempotent by construction:
  // running it again writes the same constants over the same rows. One that
  // assigns an expression (`SET n = n + 1`) is not, and is excluded — that is
  // what the negative lookahead on the value is for. Migration 0025 is two
  // such UPDATEs, and before this every one of them was silently skipped, so
  // "0 idempotent statements re-ran with no row change" printed green while
  // testing nothing at all.
  (/^UPDATE\s+\w+\s+SET\s/i.test(s) && isLiteralAssignment(s));

/** true when every `col = value` in the SET clause assigns a literal. */
function isLiteralAssignment(stmt) {
  const m = /\bSET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(stmt);
  if (!m) return false;
  return m[1]
    .split(',')
    .every((pair) => /^\s*\w+\s*=\s*(-?\d+(\.\d+)?|'[^']*'|NULL)\s*$/i.test(pair));
}

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
  // A migration made only of statements this harness cannot re-run is not
  // "proven idempotent", it is UNTESTED — and printing a green line for it is
  // exactly the fake success the mandate forbids. Say so and fail.
  if (stmts.length === 0) {
    console.error(
      `✘ ${newest}: no statement in it is re-runnable by this harness, so the ` +
        'second-pass check proves nothing. Either the migration is not idempotent, ' +
        'or isIdempotent() needs to learn its shape.'
    );
    process.exit(1);
  }

  // §12 asks for "دون تكرار أو تلف" — no DUPLICATION and no CORRUPTION. Row
  // counts only answer the first. So the whole contents of each table are
  // snapshotted and compared, which also catches an UPDATE that rewrites a
  // value on the second pass without changing how many rows there are.
  const countable = ['catalogs', 'facets', 'membership_plans', 'product_option_groups', 'product_images'];
  const snapshot = () =>
    Object.fromEntries(
      countable.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())])
    );
  const counts = () =>
    Object.fromEntries(countable.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

  const before = snapshot();
  const beforeCounts = counts();
  db.exec('BEGIN');
  for (const s of stmts) db.exec(s);
  db.exec('COMMIT');
  const after = snapshot();
  const afterCounts = counts();
  for (const t of countable) {
    if (afterCounts[t] !== beforeCounts[t]) {
      console.error(`✘ re-running ${newest} DUPLICATED rows in ${t}: ${beforeCounts[t]} → ${afterCounts[t]}`);
      process.exit(1);
    }
    if (after[t] !== before[t]) {
      console.error(`✘ re-running ${newest} CHANGED the contents of ${t} without changing its row count`);
      process.exit(1);
    }
  }
  console.log(
    `✔ ${newest}: ${stmts.length} idempotent statement(s) re-ran — no row added, no value changed`
  );
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
