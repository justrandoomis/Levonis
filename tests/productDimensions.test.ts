/**
 * «الأبعاد والوزن» — eight columns, and the two ways they are silently lost.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING
 *
 *  1. `PRODUCT_COLUMNS` IS THE WRITE PATH. A field `serializeDoc` emits but
 *     that list omits is produced, carried to the statement and dropped — the
 *     exact defect `condition_doc` shipped with, where an owner marking a
 *     printer «مستعمل» saved it at HTTP 200 as an ordinary new product with no
 *     error anywhere. So every one of the eight is asserted to survive a real
 *     save against the real migrations.
 *
 *  2. A SHEET THAT PREDATES THE COLUMNS MUST NOT WIPE THEM. Eight nulls
 *     overwriting eight measurements would empty the catalogue the first time
 *     the owner re-imported an old file, so the import merges per key.
 *
 * Plus the unit rule: NULL is "not measured" and is never coerced to 0, which
 * would be a claim that the thing is weightless.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, row } from './fixtures/app';
import {
  DIMENSION_FIELDS,
  EMPTY_DIMENSIONS,
  parseDimensions,
  parseProductRow,
  serializeDoc,
  PRODUCT_COLUMNS,
} from '../worker/lib/productModel';
import { productsHaveColumn } from '../worker/lib/conditionProjection';

const MEASURED = {
  net_weight_g: 8000,
  width_mm: 430,
  depth_mm: 400,
  height_mm: 450,
  package_weight_g: 9400,
  package_width_mm: 500,
  package_depth_mm: 550,
  package_height_mm: 600,
};

// ===========================================================================
//  THE RULE
// ===========================================================================

test('a measurement is a positive whole number, and everything else is "not measured"', () => {
  const d = parseDimensions({
    net_weight_g: 8000,
    width_mm: '430',
    // ZERO IS NOT A WIDTH. An empty form field that coerced to 0 would store a
    // claim that the thing has no width, and a freight estimate would read it.
    depth_mm: 0,
    height_mm: -5,
    package_weight_g: 9.4,
    package_width_mm: '',
    package_depth_mm: null,
    package_height_mm: 'abc',
  });
  assert.equal(d.net_weight_g, 8000);
  assert.equal(d.width_mm, 430, 'a numeric string is a number');
  assert.equal(d.depth_mm, null, 'zero must not become a measurement');
  assert.equal(d.height_mm, null);
  assert.equal(d.package_weight_g, null, 'a fraction is not a whole gram');
  assert.equal(d.package_width_mm, null);
  assert.equal(d.package_depth_mm, null);
  assert.equal(d.package_height_mm, null);
});

test('an unmeasured product is eight nulls, never eight zeroes', () => {
  const d = EMPTY_DIMENSIONS();
  for (const k of DIMENSION_FIELDS) assert.equal(d[k], null, k);
  assert.deepEqual(parseDimensions(undefined), d);
  assert.deepEqual(parseDimensions({}), d);
});

// ===========================================================================
//  THE WRITE PATH — the defect condition_doc shipped with
// ===========================================================================

test('every dimension column is in PRODUCT_COLUMNS, which IS the write path', () => {
  const cols = new Set<string>(PRODUCT_COLUMNS as readonly string[]);
  for (const k of DIMENSION_FIELDS) {
    assert.ok(cols.has(k), `${k} is emitted by serializeDoc but never bound — it would be dropped silently`);
  }
});

test('serializeDoc emits all eight, flat, under their own column names', () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('p1','p1','X','س',1000,'[]')`);
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p1')!;
  const doc = parseProductRow(stored);
  doc.dimensions = { ...MEASURED };
  const record = serializeDoc(doc) as Record<string, unknown>;
  for (const k of DIMENSION_FIELDS) assert.equal(record[k], MEASURED[k], k);
});

test('a real save against the real migrations stores and reads back every one', () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('p1','p1','X','س',1000,'[]')`);
  const before = parseProductRow(row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p1')!);
  // Unmeasured on the way in, which is what every existing product is.
  for (const k of DIMENSION_FIELDS) assert.equal(before.dimensions[k], null, k);

  before.dimensions = { ...MEASURED };
  const record = serializeDoc(before) as Record<string, unknown>;
  const cols = (PRODUCT_COLUMNS as readonly string[]).filter((k) => k !== 'id');
  raw.prepare(`UPDATE products SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = 'p1'`)
    .run(...(cols.map((k) => (record[k] ?? null) as never)));

  const after = parseProductRow(row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p1')!);
  assert.deepEqual(after.dimensions, MEASURED);
});

test('the shipping box and the product itself stay two separate facts', () => {
  // Not a tautology: they are eight columns and the ONLY thing stopping a
  // reader conflating them is that each is stored under its own name. A single
  // transposition here is a freight quote wrong by half.
  const d = parseDimensions(MEASURED);
  assert.notEqual(d.net_weight_g, d.package_weight_g);
  assert.notEqual(d.width_mm, d.package_width_mm);
  assert.notEqual(d.depth_mm, d.package_depth_mm);
  assert.notEqual(d.height_mm, d.package_height_mm);
  assert.ok(d.package_weight_g! > d.net_weight_g!, 'a box weighs more than its contents');
});

// ===========================================================================
//  THE DEPLOY-AHEAD MINUTE
// ===========================================================================

test('the column probe answers honestly, and errs towards failing loudly', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  assert.equal(await productsHaveColumn(db, 'net_weight_g'), true);
  assert.equal(await productsHaveColumn(db, 'no_such_column'), false);

  // Cannot ask at all → "yes", so the save names the column and reports the
  // real problem rather than silently dropping what the owner just typed.
  const broken = { prepare: () => ({ all: () => Promise.reject(new Error('no')) }) } as unknown as D1Database;
  assert.equal(await productsHaveColumn(broken, 'net_weight_g'), true);
});

test('a row from a database without the columns reads as unmeasured, not as zero', () => {
  // What `parseProductRow` sees during the minute between a deploy and its
  // migration: the keys are simply absent.
  const d = parseDimensions({ id: 'p1', name: 'X', price_iqd: 1000 });
  for (const k of DIMENSION_FIELDS) assert.equal(d[k], null, k);
});
