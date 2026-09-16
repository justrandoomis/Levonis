/**
 * Persistence of the local translations (mandate §3: "خزّن المصدر الإنجليزي
 * ومخرجات ar وckb مع حالة translation_version").
 *
 * Runs against a real SQLite database created from the REAL `product_translations`
 * definition in migrations/0018, through the shared node:sqlite → D1 adapter,
 * so the PRIMARY KEY, the status CHECK and the ON CONFLICT upsert all execute
 * for real.
 */
import { test } from 'node:test';
import { TRANSLATION_VERSION } from '../worker/lib/translate/index';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1, createTableIfNotExistsSql, newSqlite } from './fixtures/d1';
import { syncProductTranslations, loadProductTranslations } from '../worker/lib/translate/store';

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = newSqlite();
  // products(id) is the FK target; only the column the constraint needs.
  raw.exec('CREATE TABLE products (id TEXT PRIMARY KEY)');
  raw.exec(createTableIfNotExistsSql('0018_prime_taxonomy_inventory.sql', 'product_translations'));
  raw.prepare('INSERT INTO products (id) VALUES (?)').run('prd_1');
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

test('a covered field stores machine status and both languages', async () => {
  const { db, raw } = freshDb();
  const s = await syncProductTranslations(db, 'prd_1', [
    { field: 'description', source_en: 'Nozzle diameter: 0.4 mm' },
  ]);
  assert.equal(s.written, 1);
  assert.deepEqual(s.review_needed, []);

  const row = raw.prepare('SELECT * FROM product_translations WHERE product_id = ?').get('prd_1') as Record<string, unknown>;
  assert.equal(row.field, 'description');
  assert.equal(row.source_en, 'Nozzle diameter: 0.4 mm');
  assert.equal(row.text_ar, 'قطر الفوهة: 0.4 مم');
  assert.equal(row.status, 'machine');
  // Against the CONSTANT, not a literal: the version is meant to move when the
  // rules change, and a hardcoded number turns every deliberate bump into a
  // failing test that says nothing about the stored row.
  assert.equal(row.translation_version, TRANSLATION_VERSION);
  assert.ok(String(row.source_hash).length > 0);
});

test('an uncoverable field is stored as English with review_needed — never blocked', async () => {
  const { db } = freshDb();
  const prose = 'A description no rule-based engine can safely translate.';
  const s = await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: prose }]);
  assert.deepEqual(s.review_needed, ['description']);

  const stored = await loadProductTranslations(db, 'prd_1');
  assert.equal(stored.description.status, 'review_needed');
  assert.equal(stored.description.text_ar, prose, 'the English source is preserved verbatim');
  assert.equal(stored.description.text_ckb, prose);
});

test('re-saving unchanged text writes nothing', async () => {
  const { db } = freshDb();
  const input = [{ field: 'description', source_en: 'Layer height: 0.2 mm' }];
  await syncProductTranslations(db, 'prd_1', input);
  const second = await syncProductTranslations(db, 'prd_1', input);
  assert.equal(second.written, 0);
  assert.equal(second.skipped_unchanged, 1);
});

test('changed text is upserted in place, not duplicated', async () => {
  const { db, raw } = freshDb();
  await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: 'Weight: 5 kg' }]);
  await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: 'Weight: 6 kg' }]);
  const n = raw.prepare('SELECT COUNT(*) AS n FROM product_translations WHERE product_id = ?').get('prd_1') as { n: number };
  assert.equal(n.n, 1);
  const stored = await loadProductTranslations(db, 'prd_1');
  assert.equal(stored.description.text_ar, 'الوزن: 6 كغم');
});

test('a human approval survives a re-save of the same English source', async () => {
  const { db, raw } = freshDb();
  const input = [{ field: 'description', source_en: 'Layer height: 0.2 mm' }];
  await syncProductTranslations(db, 'prd_1', input);
  raw
    .prepare("UPDATE product_translations SET status='approved', text_ar=? WHERE product_id=? AND field=?")
    .run('ترجمة راجعها إنسان', 'prd_1', 'description');

  const again = await syncProductTranslations(db, 'prd_1', input);
  assert.equal(again.kept_approved, 1);
  assert.equal(again.written, 0);
  const stored = await loadProductTranslations(db, 'prd_1');
  assert.equal(stored.description.text_ar, 'ترجمة راجعها إنسان', 'the machine must not overwrite a human');
  assert.equal(stored.description.status, 'approved');
});

test('changing the English source DOES override a stale human approval', async () => {
  const { db, raw } = freshDb();
  await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: 'Weight: 5 kg' }]);
  raw.prepare("UPDATE product_translations SET status='approved' WHERE product_id=?").run('prd_1');
  await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: 'Weight: 9 kg' }]);
  const stored = await loadProductTranslations(db, 'prd_1');
  assert.equal(stored.description.status, 'machine');
  assert.equal(stored.description.text_ar, 'الوزن: 9 كغم');
});

test('a field removed from the product loses its stale translation', async () => {
  const { db } = freshDb();
  await syncProductTranslations(db, 'prd_1', [
    { field: 'description', source_en: 'Weight: 5 kg' },
    { field: 'how_to_use', source_en: 'Drying: 60' },
  ]);
  await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: 'Weight: 5 kg' }]);
  const stored = await loadProductTranslations(db, 'prd_1');
  assert.ok(stored.description);
  assert.equal(stored.how_to_use, undefined);
});

test('an empty input list is a no-op, not a wipe', async () => {
  const { db } = freshDb();
  await syncProductTranslations(db, 'prd_1', [{ field: 'description', source_en: 'Weight: 5 kg' }]);
  const s = await syncProductTranslations(db, 'prd_1', []);
  assert.equal(s.written, 0);
  const stored = await loadProductTranslations(db, 'prd_1');
  assert.ok(stored.description, 'passing no fields must not delete existing rows');
});
