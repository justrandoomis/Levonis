/**
 * THE SNAPSHOT SQL COLUMN GUARD (Bambu import spec §D.1, §A.8; DECISIONS row 239).
 *
 * Workflow 60 `mode=snapshot` runs scripts/bambu-import/snapshot.sql against
 * the LIVE database. Its answer is sealed, but sealing is not a licence: the
 * snapshot exists to map sections and match existing products, so it reads
 * identity and taxonomy and nothing else. No price, cost, stock, reservation,
 * package, weight, warranty, user or order column may ever enter it.
 *
 * The guard does not trust the SQL's text alone. It parses the file the way
 * cf.mjs does, then RUNS every statement on the schema every migration builds
 * and reads each answer column's ORIGIN (table and column, through any alias)
 * from SQLite itself. Each origin must be on the reviewed allow-list below;
 * the allow-list itself is checked against FINANCIAL_FIELDS
 * (worker/lib/adminScope.ts) and a deny list; and a seeded catalogue proves
 * that every product status and every section is in the answer while no
 * planted money or stock value is.
 *
 * Adding a column to snapshot.sql means adding it here, in review.
 *
 * Run: node --import tsx --test tests/bambuSnapshotSql.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { all, freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';
// @ts-expect-error - plain ESM helper run by workflow 60, no types
import { parseSnapshotSql, SNAPSHOT_SQL } from '../scripts/bambu-import/cf.mjs';

type Statement = { key: string; sql: string };

/** The reviewed columns, by origin table. Identity and taxonomy only. */
const ALLOWED: Record<string, readonly string[]> = {
  d1_migrations: ['name'],
  catalogs: ['id', 'parent_id', 'slug', 'name_ar', 'name_en', 'name_ckb', 'active', 'sort', 'template_family', 'is_printer_catalog'],
  brands: ['id', 'slug', 'name_en', 'name_ar', 'name_ckb', 'active'],
  products: ['id', 'slug', 'status', 'name', 'name_ar', 'name_ku', 'sku', 'brand_id', 'brand', 'category_id', 'sub_category_id', 'template_family', 'composition'],
  product_catalogs: ['product_id', 'catalog_id', 'position'],
  product_printer_fits: ['product_id', 'printer_id', 'position'],
  product_option_groups: ['name_en'],
  product_option_values: ['id', 'product_id', 'group_id', 'name_en', 'name_ar', 'name_ckb', 'sku_part', 'variant_key', 'active'],
  product_colors: ['id', 'product_id', 'name_en', 'name_ar', 'name_ckb', 'hex', 'sku_part', 'active'],
  product_images: ['product_id', 'source_url'],
};

/** Whatever a future schema calls it: money, stock, logistics, people and orders. */
const DENIED = [
  /price/, /cost/, /_iqd$/, /_usd$/, /margin/, /profit/, /supplier/, /surcharge/, /commission/, /discount/, /fee/,
  /payment/, /membership/, /wallet/, /fx_/, /rate/,
  /stock/, /reserved/, /threshold/, /inventory/, /lot_/, /ledger/, /serial/,
  /weight/, /width/, /depth/, /height/, /package/, /cbm/, /shipping/, /transport/, /lead_time/, /availability/,
  /sale_type/, /selling_type/, /warranty/, /ops_policy/, /condition/, /gift/,
  /order/, /cart/, /user/, /customer/, /email/, /phone/, /password/, /token/, /secret/, /session/, /address/,
];
const DENIED_TABLES = /^(?:users|orders|order_items|cart|wallet|pricing_|product_pricing|product_sku_prices|price_|inventory_|procurement_|product_option_fulfillment|product_option_transports|product_variants|accounting|finance|investor|coupon|product_price_request)/;

const statements = (): Statement[] => parseSnapshotSql(readFileSync(SNAPSHOT_SQL, 'utf8'));
const financial = new Set<string>(FINANCIAL_FIELDS);

/** Every migration, plus the bookkeeping table wrangler keeps on D1. Built once: no test writes to it before the last. */
let built: DatabaseSync | null = null;
function migratedDb(): DatabaseSync {
  if (built) return built;
  const db = freshDb();
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const insert = db.prepare('INSERT INTO d1_migrations (name) VALUES (?)');
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) insert.run(file);
  return (built = db);
}

test('snapshot.sql is the reviewed list of plain SELECTs, one per key', () => {
  const list = statements();
  assert.deepEqual(list.map((s) => s.key), [
    'd1_migrations', 'catalogs', 'brands', 'products', 'product_catalogs', 'product_printer_fits', 'option_values', 'colors', 'image_sources',
  ]);
  for (const { key, sql } of list) {
    assert.match(sql, /^SELECT /, key);
    assert.equal(sql.match(/\bSELECT\b/gi)?.length, 1, `${key}: one SELECT, no subquery or UNION`);
    assert.doesNotMatch(sql, /\*/, `${key}: no SELECT *`);
    assert.doesNotMatch(sql, /\b(?:UNION|INTERSECT|EXCEPT|ATTACH|PRAGMA|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i, key);
    assert.doesNotMatch(sql, /;/, `${key}: one statement`);
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_0-9]+)/gi)].map((m) => m[1]);
    assert.ok(tables.length >= 1, key);
    for (const table of tables) {
      assert.ok(Object.hasOwn(ALLOWED, table), `${key} reads ${table}, which is not on the reviewed list`);
      assert.doesNotMatch(table, DENIED_TABLES, `${key} reads ${table}`);
    }
  }
  // Every status and every section: no filter on the two tables P0 maps from.
  for (const key of ['products', 'catalogs', 'brands']) {
    assert.doesNotMatch(list.find((s) => s.key === key)!.sql, /\bWHERE\b/i, `${key} must not be filtered`);
  }
});

test('the reviewed allow-list holds no financial, stock, logistics, user or order column', () => {
  for (const [table, columns] of Object.entries(ALLOWED)) {
    assert.doesNotMatch(table, DENIED_TABLES, table);
    for (const column of columns) {
      assert.ok(!financial.has(column), `${table}.${column} is in FINANCIAL_FIELDS`);
      for (const pattern of DENIED) assert.doesNotMatch(column, pattern, `${table}.${column}`);
    }
  }
  // The deny list is not vacuous: it catches every money and stock column the snapshot tables really have.
  const db = migratedDb();
  for (const table of ['products', 'product_option_values', 'product_colors']) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ['stock', 'cost_iqd', 'product_cost_iqd', 'price_iqd', 'regular_price_iqd', 'package_weight_g', 'low_stock_threshold']) {
      if (!columns.includes(column)) continue;
      assert.ok(financial.has(column) || DENIED.some((pattern) => pattern.test(column)), `${table}.${column} slips through the deny list`);
    }
  }
});

test('run on the migrated schema, every answer column comes from the allow-list, through any alias', () => {
  const db = migratedDb();
  for (const { key, sql } of statements()) {
    const columns = db.prepare(sql).columns();
    assert.ok(columns.length > 0, key);
    const names = columns.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `${key}: two answer columns share a name, and D1 would keep only one`);
    for (const column of columns) {
      assert.ok(column.table && column.column, `${key}.${column.name} is an expression, not a column`);
      assert.ok(ALLOWED[column.table]?.includes(column.column), `${key}.${column.name} comes from ${column.table}.${column.column}, not on the reviewed list`);
      assert.ok(!financial.has(column.name) && !financial.has(column.column), `${key}.${column.name} is financial`);
      for (const pattern of DENIED) {
        assert.doesNotMatch(column.name, pattern, `${key}.${column.name}`);
        assert.doesNotMatch(column.column, pattern, `${key}.${column.name} (${column.table}.${column.column})`);
      }
    }
  }
});

test('a seeded catalogue: every status and section is in the answer, no planted money or stock value is', () => {
  const db = migratedDb();
  db.exec(`
    INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('br_bambu', 'bambu-lab', 'بامبو لاب', 'Bambu Lab');
    INSERT INTO catalogs (id, slug, name_ar, name_en, active) VALUES ('cat_planted_off', 'planted-off', 'قسم', 'An inactive section', 0);
    INSERT INTO products (id, slug, name, status, price_iqd, original_price_iqd, product_cost_iqd, stock, sku, brand_id, package_weight_g) VALUES
      ('p_active', 'bambu-a1', 'Bambu A1', 'active', 777001, 777011, 666001, 4242, 'A1-SKU', 'br_bambu', 5551),
      ('p_draft', 'draft-one', 'Draft one', 'draft', 777002, NULL, 666002, 4243, 'DRAFT-SKU', NULL, NULL),
      ('p_hidden', 'hidden-one', 'Hidden one', 'hidden', 777003, NULL, 666003, NULL, NULL, 'br_bambu', NULL);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_active', 'cat_planted_off', 1);
    INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES ('p_draft', 'p_active', 0);
    INSERT INTO product_option_groups (id, product_id, name_en) VALUES ('g1', 'p_active', 'Bundle');
    INSERT INTO product_option_values (id, product_id, group_id, name_en, regular_price_iqd, cost_iqd, stock, reserved) VALUES ('v1', 'p_active', 'g1', 'Combo', 777004, 666004, 4244, 3);
    INSERT INTO product_colors (id, product_id, name_en, hex, regular_price_iqd, cost_iqd, stock) VALUES ('c1', 'p_active', 'Black', '#000000', 777005, 666005, 4245);
    INSERT INTO product_images (id, product_id, url, source_url) VALUES
      ('i1', 'p_hidden', '/files/products/a.webp', 'https://store.bblcdn.com/s7/default/a.png'),
      ('i2', 'p_active', '/files/products/b.webp', 'https://cdn.shopify.com/s/files/b.png'),
      ('i3', 'p_active', '/files/products/c.webp', 'https://example.com/c.png');
  `);
  const answer: Record<string, Array<Record<string, unknown>>> = {};
  for (const { key, sql } of statements()) answer[key] = all(db, sql);

  assert.deepEqual(answer.products.map((p) => p.status).sort(), ['active', 'draft', 'hidden']);
  assert.ok(answer.catalogs.some((c) => c.id === 'cat_planted_off' && c.active === 0), 'an inactive section is in the snapshot');
  assert.equal(answer.catalogs.length, (db.prepare('SELECT COUNT(*) AS n FROM catalogs').get() as { n: number }).n);
  assert.deepEqual(answer.image_sources.map((i) => i.source_url), ['https://cdn.shopify.com/s/files/b.png', 'https://store.bblcdn.com/s7/default/a.png']);
  assert.equal(answer.option_values.length, 1);
  assert.deepEqual(Object.keys(answer.option_values[0]), [
    'value_id', 'product_id', 'group_id', 'group_name_en', 'name_en', 'name_ar', 'name_ckb', 'sku_part', 'variant_key', 'active',
  ]);
  assert.equal(answer.option_values[0].group_name_en, 'Bundle');
  assert.equal(answer.option_values[0].name_en, 'Combo');
  assert.deepEqual(answer.product_printer_fits, [{ product_id: 'p_draft', printer_id: 'p_active', position: 0 }]);
  assert.equal(answer.d1_migrations.length, readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).length);

  const text = JSON.stringify(answer);
  for (const planted of ['777001', '777002', '777003', '777004', '777005', '777011', '666001', '666004', '666005', '4242', '4244', '4245', '5551']) {
    assert.ok(!text.includes(planted), `the planted value ${planted} reached the snapshot`);
  }
  for (const key of ['price', 'cost', 'stock', 'reserved', 'package', 'weight']) {
    assert.ok(!new RegExp(`"[a-z_]*${key}[a-z_]*":`).test(text), `a ${key} key reached the snapshot`);
  }
});

test('the parser: keys are mandatory and unique, writes are refused, quotes and comments are respected', () => {
  const ok = parseSnapshotSql("-- a comment; with a semicolon and it's quote\n-- @key a\nSELECT x -- trailing note\n  FROM t WHERE y = 'a--b;c' ;\n-- @key b\nSELECT 'it''s' AS z FROM u;\n");
  assert.deepEqual(ok, [
    { key: 'a', sql: "SELECT x FROM t WHERE y = 'a--b;c'" },
    { key: 'b', sql: "SELECT 'it''s' AS z FROM u" },
  ]);
  const refuses = (text: string, reason: RegExp) => assert.throws(() => parseSnapshotSql(text), reason, text);
  refuses('SELECT 1;', /no "-- @key" line/);
  refuses('-- @key a\nSELECT 1;\n-- @key a\nSELECT 2;', /used twice/);
  refuses("-- @key a\nUPDATE products SET status = 'hidden';", /not a SELECT/);
  refuses('-- @key a\nSELECT id FROM products WHERE id IN (DELETE FROM products);', /not read-only/);
  refuses('-- @key a\nSELECT 1;\nDROP TABLE products;', /no "-- @key" line/);
  refuses("-- @key a\nSELECT 'open FROM t;", /unterminated/);
  refuses('-- @key a\n/* x */ SELECT 1;', /block comments/);
  refuses('-- @key a\nSELECT 1', /does not end in ;/);
  refuses('-- @key a\n-- @key b\nSELECT 1;', /two @key lines/);
  refuses('-- @key a\nSELECT 1 -- @key b\nFROM t;', /inside a statement/);
  refuses('-- @key Bad-Key\nSELECT 1;', /not a key name/);
  refuses('-- @key a\n;', /empty statement/);
  refuses('-- @key a\n', /names no statement/);
  refuses('-- nothing here\n', /no statement/);
});
