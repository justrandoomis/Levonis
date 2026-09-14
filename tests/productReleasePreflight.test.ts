import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './fixtures/app';

const mod = await import(new URL('../scripts/product-release-preflight.mjs', import.meta.url).href);
const { inspectProductRelease, assertProductRelease, PRODUCT_RELEASE_MIGRATIONS } = mod as {
  inspectProductRelease: (query: (sql: string) => Promise<unknown[]>) => Promise<{ ready: boolean; missing_migrations: string[]; missing_columns: string[]; live_legacy_option_rows: number | null; ambiguous_legacy_routes: unknown[]; orphan_cleanup_performed: boolean }>;
  assertProductRelease: (report: unknown, beforeMigration?: boolean) => void;
  PRODUCT_RELEASE_MIGRATIONS: string[];
};
function fixture() {
  const db = freshDb();
  db.exec('CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)');
  for (const name of PRODUCT_RELEASE_MIGRATIONS) db.prepare('INSERT INTO d1_migrations VALUES (?)').run(name);
  const query = async (sql: string) => { assert.match(sql, /^SELECT\s/i); return db.prepare(sql).all(); };
  return { db, query };
}

test('release preflight permits the complete product schema using only SELECTs', async () => {
  const { query } = fixture(); const report = await inspectProductRelease(query);
  assert.equal(report.ready, true); assert.equal(report.orphan_cleanup_performed, false);
  assert.doesNotThrow(() => assertProductRelease(report));
});

test('an unapplied migration blocks code deployment but permits a reviewed upgrade preflight', async () => {
  const { db, query } = fixture(); db.prepare('DELETE FROM d1_migrations WHERE name=?').run(PRODUCT_RELEASE_MIGRATIONS[0]);
  const report = await inspectProductRelease(query);
  assert.equal(report.ready, false); assert.deepEqual(report.missing_migrations, [PRODUCT_RELEASE_MIGRATIONS[0]]);
  assert.throws(() => assertProductRelease(report), /not ready/);
  assert.doesNotThrow(() => assertProductRelease(report, true));
});

test('migration names alone cannot approve a schema missing order snapshots', async () => {
  const { db, query } = fixture(); db.exec('ALTER TABLE order_items RENAME COLUMN selection_snapshot TO old_selection_snapshot');
  const report = await inspectProductRelease(query);
  assert.deepEqual(report.missing_migrations, []); assert.ok(report.missing_columns.includes('order_items.selection_snapshot'));
  assert.throws(() => assertProductRelease(report), /not ready/);
});

test('duplicate legacy journeys block the upgrade without cleaning existing orphan rows', async () => {
  const { db, query } = fixture();
  db.exec("INSERT INTO products(id,slug,name,price_iqd) VALUES ('p','p','P',1); INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('g','p','Models')");
  for (const id of ['one','two']) db.prepare("INSERT INTO product_option_values(id,product_id,group_id,name_en,variant_key,availability_type) VALUES (?,'p','g','Mini','mini','direct_sale')").run(id);
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO product_images(id,product_id,url) VALUES ('orphan','missing','/files/products/old.webp'); PRAGMA foreign_keys=ON");
  const report = await inspectProductRelease(query);
  assert.equal(report.live_legacy_option_rows, 2); assert.equal(report.ambiguous_legacy_routes.length, 1);
  assert.throws(() => assertProductRelease(report, true), /Ambiguous legacy/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_images').get()?.n, 1);
});

test('a failed live D1 read never turns into deployment permission', async () => {
  await assert.rejects(inspectProductRelease(async () => { throw new Error('D1 unavailable'); }), /D1 unavailable/);
});
