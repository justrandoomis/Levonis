/**
 * The relational overlay must never take the catalogue down.
 *
 * THE INCIDENT THIS FILE EXISTS FOR: on 2026-08-30 levonis-iq.com answered
 * 500 on every product listing while the storefront shell, sign-in and the
 * settings endpoint were all fine. The worker log named it exactly:
 *
 *   D1_ERROR: no such table: product_option_groups: SQLITE_ERROR
 *       at async loadRelationsViews (index.js:10147:61)
 *
 * The worker had been deployed with code that reads the relational tables
 * against a database still migrated to 0012. The product ROWS were perfectly
 * fine — 44 of them — and every one of them was unreachable because an
 * enrichment query threw.
 *
 * A deploy can always land before its migration. The window is normally
 * seconds; here it was days. Either way the storefront has to survive it, so
 * these tests pin the contract: a failing relations read degrades to "this
 * product has no relations", never to an exception.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1, newSqlite, createTableIfNotExistsSql } from './fixtures/d1';
import {
  loadRelationsView,
  loadRelationsViews,
  applyRelations,
  EMPTY_RELATIONS,
  isMissingRelationTable,
} from '../worker/lib/productOverlay';
import type { ProductDoc } from '../worker/lib/productModel';

/** A database with NO relational tables at all — the live 0012 schema. */
function dbWithoutRelations(): SqliteD1 {
  return new SqliteD1(newSqlite());
}

/** A database that has them, so the happy path is covered by the same test
 *  file and a future "just delete the queries" fix cannot pass. */
function dbWithRelations(): { d1: SqliteD1; raw: DatabaseSync } {
  const raw = newSqlite();
  raw.exec('CREATE TABLE products (id TEXT PRIMARY KEY, inventory_mode TEXT NOT NULL DEFAULT \'BASE\')');
  for (const t of [
    'product_option_groups',
    'product_option_values',
    'product_colors',
    'product_color_option_links',
    'product_variants',
    'product_images',
  ]) {
    raw.exec(createTableIfNotExistsSql('0018_prime_taxonomy_inventory.sql', t));
  }
  return { d1: new SqliteD1(raw), raw };
}

const doc = (over: Partial<ProductDoc> = {}) =>
  ({
    id: 'prd_1',
    slug: 'p',
    status: 'active',
    name_en: 'Printer',
    name_ar: 'Printer',
    name_ckb: 'Printer',
    price_iqd: 1000,
    pro_price_iqd: null,
    prime_price_iqd: null,
    product_cost_iqd: null,
    options: [],
    colors: [],
    media: [],
    ...over,
  }) as unknown as ProductDoc;

// --------------------------------------------------------------- the guard

test('a page of products survives the relational tables not existing yet', async () => {
  const db = dbWithoutRelations();
  const views = await loadRelationsViews(db as unknown as D1Database, [
    { id: 'prd_1', inventory_mode: 'BASE' },
    { id: 'prd_2', inventory_mode: 'COLOR' },
  ]);
  assert.equal(views.size, 2, 'every requested product must come back');
  for (const v of views.values()) {
    assert.equal(v.has_relations, false);
    assert.deepEqual(v.groups, []);
    assert.deepEqual(v.colors, []);
    assert.deepEqual(v.images, []);
  }
});

test('one product survives it too', async () => {
  const db = dbWithoutRelations();
  const view = await loadRelationsView(db as unknown as D1Database, 'prd_1', 'COLOR');
  assert.equal(view.has_relations, false);
  assert.deepEqual(view.values, []);
  assert.deepEqual(view.variants, []);
});

test('the product still projects from its own row when relations are gone', async () => {
  const db = dbWithoutRelations();
  const view = await loadRelationsView(db as unknown as D1Database, 'prd_1', 'BASE');
  // The legacy JSON columns carry the option the admin actually entered; the
  // overlay having nothing to add must not erase it.
  const legacy = doc({
    options: [
      { id: 'opt_1', name_en: 'A1', name_ar: 'A1', name_ckb: '', image: '', order: 0, active: true,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
    ] as ProductDoc['options'],
  });
  const out = applyRelations(legacy, view);
  assert.equal(out.options.length, 1, 'the legacy option survives an empty overlay');
  assert.equal(out.options[0].name_en, 'A1');
  assert.equal(out.name_en, 'Printer');
  assert.equal(out.price_iqd, 1000);
});

test('EMPTY_RELATIONS is what a failed read degrades to', async () => {
  const db = dbWithoutRelations();
  const view = await loadRelationsView(db as unknown as D1Database, 'prd_1', 'BASE');
  const { inventory_mode: _mode, ...rest } = view;
  const { inventory_mode: _empty, ...expected } = EMPTY_RELATIONS;
  assert.deepEqual(rest, expected);
});

test('the missing-table error is recognised for what it is', () => {
  assert.equal(isMissingRelationTable(new Error('D1_ERROR: no such table: product_option_groups: SQLITE_ERROR')), true);
  assert.equal(isMissingRelationTable(new Error('D1_ERROR: UNIQUE constraint failed')), false);
});

// ----------------------------------------------------------- happy path

test('with the tables present the overlay still reads real rows', async () => {
  const { d1, raw } = dbWithRelations();
  raw.exec("INSERT INTO products (id, inventory_mode) VALUES ('prd_1', 'COLOR')");
  raw.exec(
    "INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('og_1','prd_1','Printer',0,1)"
  );
  raw.exec(
    "INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('ov_1','prd_1','og_1','A1',0,1)"
  );
  raw.exec(
    "INSERT INTO product_colors (id, product_id, name_en, hex, sort, active) VALUES ('pc_1','prd_1','Black','#000000',0,1)"
  );
  raw.exec(
    "INSERT INTO product_color_option_links (color_id, option_value_id, group_id) VALUES ('pc_1','ov_1','og_1')"
  );

  const view = await loadRelationsView(d1 as unknown as D1Database, 'prd_1', 'COLOR');
  assert.equal(view.has_relations, true);
  assert.equal(view.groups.length, 1);
  assert.equal(view.values.length, 1);
  assert.equal(view.colors.length, 1);
  assert.equal(view.links.length, 1);
  assert.equal(view.inventory_mode, 'COLOR');

  const views = await loadRelationsViews(d1 as unknown as D1Database, [{ id: 'prd_1', inventory_mode: 'COLOR' }]);
  assert.equal(views.get('prd_1')?.values.length, 1);
});
