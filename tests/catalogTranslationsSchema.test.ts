/**
 * MIGRATION 0196 — THE CATALOGUE TRANSLATION MEMORY'S TABLES
 * (docs/bambu-import/I18N-DESIGN.md §A.2).
 *
 *   1. it applies twice (every CREATE carries IF NOT EXISTS: what
 *      scripts/migrate-check.mjs proves on a throwaway database), additively —
 *      no existing table is touched;
 *   2. the CHECKs refuse a key that is not 64 lowercase hex, an unknown
 *      status, an empty English, a part name outside `p<3 digits>…`;
 *   3. a ref is (product, hash) once: `INSERT OR IGNORE` of a duplicate is a
 *      no-op; refs need no product (no foreign key);
 *   4. /hello's presence probe reports 0196, and 0195 alone without it.
 *
 * Run: node --import tsx --test tests/catalogTranslationsSchema.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, dbThrough, freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { migrationsPresent } from '../worker/lib/catalogImport/runOps';

const SQL = readFileSync(join(ROOT, 'migrations', '0196_catalog_translations.sql'), 'utf8');
const H = 'a'.repeat(64);

test('0196 applies twice and only creates its own three tables and one index', () => {
  const raw = dbThrough('0195');
  const before = raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string | null }>;
  raw.exec(SQL);
  raw.exec(SQL);
  const after = raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string | null }>;
  const added = after.filter((a) => !before.some((b) => b.name === a.name)).map((a) => `${a.type}:${a.name}`).sort();
  assert.deepEqual(added, [
    'index:ix_ctr_h',
    'index:sqlite_autoindex_catalog_translation_parts_1',
    'index:sqlite_autoindex_catalog_translations_1',
    'table:catalog_translation_parts',
    'table:catalog_translation_refs',
    'table:catalog_translations',
  ]);
  for (const b of before) {
    const a = after.find((x) => x.name === b.name);
    assert.equal(a?.sql, b.sql, `${b.name} is untouched`);
  }
  assert.doesNotMatch(SQL, /\b(ALTER|DROP|DELETE|UPDATE)\b/i, 'additive only');
});

test('the CHECKs refuse a bad key, status, English and part', () => {
  const raw = freshDb();
  const ins = (h: string, en: string, status: string) =>
    raw.prepare('INSERT INTO catalog_translations (h, en, ar, ckb, kind, status, part) VALUES (?, ?, ?, ?, ?, ?, ?)').run(h, en, 'عربي', 'کوردی', 'spec_value_text', status, 'p001');
  ins(H, 'Gray', 'reviewed');
  // `keep`: the reviewers decided the English stays (a name, a code); stored, never shown (the reads ask for
  // reviewed and machine only).
  ins('f'.repeat(64), 'MacOS', 'keep');
  assert.throws(() => ins('A'.repeat(64), 'Grey', 'reviewed'), /CHECK/, 'upper-case hex');
  assert.throws(() => ins('b'.repeat(63), 'Grey', 'reviewed'), /CHECK/, '63 characters');
  assert.throws(() => ins('g'.repeat(64), 'Grey', 'reviewed'), /CHECK/, 'not hex');
  assert.throws(() => ins('c'.repeat(64), 'Grey', 'approved'), /CHECK/, 'status');
  assert.throws(() => ins('d'.repeat(64), '', 'reviewed'), /CHECK/, 'empty English');
  assert.throws(() => ins('e'.repeat(64), 'x'.repeat(4001), 'reviewed'), /CHECK/, 'over 4,000');
  assert.throws(() => ins(H, 'Gray', 'reviewed'), /UNIQUE|PRIMARY/, 'one row per key');
  const part = (name: string) => raw.prepare('INSERT INTO catalog_translation_parts (part, sha256, rows) VALUES (?, ?, 1)').run(name, H);
  part('p001');
  part('p0123');
  assert.throws(() => part('q001'), /CHECK/);
  assert.throws(() => part('p01'), /CHECK/);
  assert.throws(() => raw.prepare('INSERT INTO catalog_translation_parts (part, sha256, rows) VALUES (?, ?, -1)').run('p002', H), /CHECK/);
});

test('a ref is (product, hash) once; INSERT OR IGNORE of a duplicate is a no-op; no product is needed', () => {
  const raw = freshDb();
  const ins = raw.prepare('INSERT OR IGNORE INTO catalog_translation_refs (product_id, h) VALUES (?, ?)');
  assert.equal(Number(ins.run('p_not_written_yet', H).changes), 1);
  assert.equal(Number(ins.run('p_not_written_yet', H).changes), 0);
  assert.equal(Number(ins.run('p_other', H).changes), 1);
  assert.throws(() => raw.prepare('INSERT INTO catalog_translation_refs (product_id, h) VALUES (?, ?)').run('', H), /CHECK/);
  const plan = raw.prepare('EXPLAIN QUERY PLAN SELECT product_id FROM catalog_translation_refs WHERE h = ?').all(H) as Array<{ detail: string }>;
  assert.ok(plan.some((p) => /ix_ctr_h/.test(p.detail)), 'refs by hash use the index');
});

test('/hello reports 0196 present on a current database, absent on one at 0195', async () => {
  assert.deepEqual(await migrationsPresent(asD1(freshDb())), { '0193': true, '0194': true, '0195': true, '0196': true });
  assert.deepEqual(await migrationsPresent(asD1(dbThrough('0195'))), { '0193': true, '0194': true, '0195': true, '0196': false });
});
