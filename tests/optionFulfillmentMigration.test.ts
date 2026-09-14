/**
 * THE MERGE IS PROVED ON THE OWNER'S OWN NUMBERS.
 *
 * Migration 0073 turns the 0043 shape — "A1 mini — Pre-order" and "A1 mini —
 * Direct Sale" as two option rows sharing a `variant_key` — into ONE model
 * with two fulfilment rows. The only claim that matters is that it cannot
 * change a price, and the only way to show that is to build the legacy shape
 * against the REAL schema, run the migration, and read every column back.
 *
 * The fixture is the owner's example verbatim:
 *
 *   A1 mini        pre-order 499,000   direct 549,000   (+50,000)
 *   A1 mini Combo  pre-order 679,000   direct 699,000   (+20,000)
 *
 * — two DIFFERENT direct differences on ONE product, which is exactly what a
 * single `products.direct_surcharge_iqd` cannot express and why the fulfilment
 * row has to exist.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const MIGRATION = '0073_option_fulfillment.sql';

/** Every migration strictly before 0073 — the world as it was. */
function legacySchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (f >= MIGRATION) break;
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

function applyFulfillmentMigration(db: DatabaseSync): void {
  db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION), 'utf8'));
}

type Row = Record<string, unknown>;
// node:sqlite hands back NULL-PROTOTYPE objects, which `assert.deepEqual`
// refuses to match against an object literal. Spreading once here keeps that
// detail out of every assertion below.
const all = (db: DatabaseSync, sql: string, ...args: unknown[]): Row[] =>
  (db.prepare(sql).all(...(args as never[])) as Row[]).map((r) => ({ ...r }));
const one = (db: DatabaseSync, sql: string, ...args: unknown[]): Row | undefined => {
  const row = db.prepare(sql).get(...(args as never[])) as Row | undefined;
  return row === undefined ? undefined : { ...row };
};

function insert(db: DatabaseSync, table: string, values: Record<string, unknown>) {
  const cols = db.prepare(`SELECT * FROM pragma_table_info('${table}')`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const row: Record<string, unknown> = { ...values };
  for (const col of cols) {
    if (col.name in row) continue;
    if (col.notnull !== 1 || col.dflt_value !== null) continue;
    row[col.name] = /INT|REAL|NUM/i.test(col.type) ? 0 : `auto-${col.name}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
  ).run(...(names.map((n) => row[n]) as never[]));
}

/** The A1 mini as 0043 stored it: four option rows, two models. */
function legacyA1(db: DatabaseSync) {
  insert(db, 'products', {
    id: 'p-a1',
    slug: 'a1-mini',
    name: 'Bambu Lab A1 mini',
    status: 'active',
    price_iqd: 499_000,
    selling_type: 'pre_order',
    sale_types: JSON.stringify(['pre_order', 'direct_sale']),
    direct_surcharge_iqd: 50_000,
  });
  insert(db, 'product_option_groups', { id: 'g-model', product_id: 'p-a1', name_en: 'Model', sort: 0 });

  const rows = [
    { id: 'o-mini-pre', name: 'A1 mini — Pre-order', key: 'a1-mini', label: 'A1 mini', type: 'pre_order', price: null, sort: 0 },
    { id: 'o-mini-dir', name: 'A1 mini — Direct', key: 'a1-mini', label: 'A1 mini', type: 'direct_sale', price: 549_000, sort: 1 },
    { id: 'o-combo-pre', name: 'A1 mini Combo — Pre-order', key: 'a1-mini-combo', label: 'A1 mini Combo', type: 'pre_order', price: 679_000, sort: 2 },
    { id: 'o-combo-dir', name: 'A1 mini Combo — Direct', key: 'a1-mini-combo', label: 'A1 mini Combo', type: 'direct_sale', price: 699_000, sort: 3 },
  ];
  for (const r of rows) {
    insert(db, 'product_option_values', {
      id: r.id,
      product_id: 'p-a1',
      group_id: 'g-model',
      name_en: r.name,
      sort: r.sort,
      active: 1,
      availability_type: r.type,
      variant_key: r.key,
      variant_label: r.label,
      regular_price_iqd: r.price,
      prime_price_iqd: r.id === 'o-combo-dir' ? 689_000 : null,
      pro_price_iqd: null,
      cost_iqd: r.price === null ? null : r.price - 100_000,
      stock: r.type === 'direct_sale' ? 3 : null,
      lead_time_text: r.type === 'pre_order' ? '١٤ إلى ٢١ يوم' : '',
      lead_time_min_days: r.type === 'pre_order' ? 14 : null,
      lead_time_max_days: r.type === 'pre_order' ? 21 : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------

test('the two rows of one model merge, and the survivor is the cheaper one', () => {
  const db = legacySchema();
  legacyA1(db);
  applyFulfillmentMigration(db);

  const live = all(db, "SELECT id, name_en FROM product_option_values WHERE merged_into = '' ORDER BY sort");
  assert.deepEqual(
    live.map((r) => r.id),
    ['o-mini-pre', 'o-combo-pre'],
    'the pre-order rows are cheaper, so they survive as the models'
  );
  // The model takes the model's NAME — no "— Pre-order" left in the catalogue.
  assert.deepEqual(live.map((r) => r.name_en), ['A1 mini', 'A1 mini Combo']);
  for (const r of live) assert.ok(!String(r.name_en).match(/pre-?order|direct/i));

  const tombstones = all(db, "SELECT id, merged_into, active FROM product_option_values WHERE merged_into <> '' ORDER BY id");
  assert.equal(tombstones.length, 2);
  assert.deepEqual(
    tombstones.map((r) => [r.id, r.merged_into, r.active]),
    [
      ['o-combo-dir', 'o-combo-pre', 0],
      ['o-mini-dir', 'o-mini-pre', 0],
    ]
  );
});

test('every price survives the merge verbatim — the two direct differences included', () => {
  const db = legacySchema();
  legacyA1(db);
  applyFulfillmentMigration(db);

  const cells = all(
    db,
    `SELECT option_id, fulfillment_type, regular_price_iqd, prime_price_iqd, cost_iqd,
            lead_time_text, lead_time_min_days, lead_time_max_days, enabled
       FROM product_option_fulfillment ORDER BY option_id, fulfillment_type`
  );
  assert.equal(cells.length, 4, 'two models x two order types');

  const cell = (opt: string, type: string) =>
    cells.find((c) => c.option_id === opt && c.fulfillment_type === type)!;

  // A1 mini: pre-order inherits the product's 499,000 (NULL stays NULL), and
  // direct states 549,000. The +50,000 is expressed, not computed.
  assert.equal(cell('o-mini-pre', 'pre_order').regular_price_iqd, null);
  assert.equal(cell('o-mini-pre', 'direct_sale').regular_price_iqd, 549_000);

  // Combo: 679,000 / 699,000 — a DIFFERENT direct difference on the SAME
  // product, which one `products.direct_surcharge_iqd` could never hold.
  assert.equal(cell('o-combo-pre', 'pre_order').regular_price_iqd, 679_000);
  assert.equal(cell('o-combo-pre', 'direct_sale').regular_price_iqd, 699_000);
  assert.equal(
    Number(cell('o-combo-pre', 'direct_sale').regular_price_iqd) -
      Number(cell('o-combo-pre', 'pre_order').regular_price_iqd),
    20_000
  );
  assert.equal(
    Number(cell('o-mini-pre', 'direct_sale').regular_price_iqd) - 499_000,
    50_000,
    "and the A1 mini's is 50,000 at the same time"
  );

  // Member prices, cost and stock come across untouched.
  assert.equal(cell('o-combo-pre', 'direct_sale').prime_price_iqd, 689_000);
  assert.equal(cell('o-combo-pre', 'pre_order').prime_price_iqd, null);
  assert.equal(cell('o-combo-pre', 'direct_sale').cost_iqd, 599_000);
  // Stock is NOT on the cell — it is the MODEL's, and the merge hoists the
  // direct row's count onto the survivor so a stocked model is not zeroed.
  assert.equal(one(db, 'SELECT stock FROM product_option_values WHERE id = ?', 'o-mini-pre')!.stock, 3);

  // Lead time follows the pre-order, and only the pre-order.
  assert.equal(cell('o-mini-pre', 'pre_order').lead_time_text, '١٤ إلى ٢١ يوم');
  assert.equal(cell('o-mini-pre', 'pre_order').lead_time_min_days, 14);
  assert.equal(cell('o-mini-pre', 'direct_sale').lead_time_text, '');
});

test('a live basket keeps buying what it was buying', () => {
  const db = legacySchema();
  legacyA1(db);
  insert(db, 'users', { id: 'u1' });
  insert(db, 'cart_items', { id: 'cart-1', user_id: 'u1', product_id: 'p-a1', option_id: 'o-combo-dir', qty: 1 });
  insert(db, 'cart_items', { id: 'cart-2', user_id: 'u1', product_id: 'p-a1', option_id: 'o-mini-pre', qty: 2 });
  applyFulfillmentMigration(db);

  const moved = one(db, 'SELECT option_id, fulfillment_type FROM cart_items WHERE id = ?', 'cart-1')!;
  assert.equal(moved.option_id, 'o-combo-pre', 'the line points at the surviving model');
  assert.equal(moved.fulfillment_type, 'direct_sale', 'and remembers it was a direct sale');

  const stayed = one(db, 'SELECT option_id, fulfillment_type FROM cart_items WHERE id = ?', 'cart-2')!;
  assert.equal(stayed.option_id, 'o-mini-pre');
  assert.equal(stayed.fulfillment_type, 'pre_order');
});

test('a colour linked to the tombstone follows the model, without duplicating', () => {
  const db = legacySchema();
  legacyA1(db);
  insert(db, 'product_colors', { id: 'c-white', product_id: 'p-a1', name_en: 'White', hex: '#ffffff' });
  insert(db, 'product_colors', { id: 'c-black', product_id: 'p-a1', name_en: 'Black', hex: '#000000' });
  // White is linked to BOTH rows of the model — after the merge that must be
  // ONE link, not two, and the unique index is what would catch a plain UPDATE.
  insert(db, 'product_color_option_links', { color_id: 'c-white', option_value_id: 'o-combo-pre', group_id: 'g-model' });
  insert(db, 'product_color_option_links', { color_id: 'c-white', option_value_id: 'o-combo-dir', group_id: 'g-model' });
  insert(db, 'product_color_option_links', { color_id: 'c-black', option_value_id: 'o-combo-dir', group_id: 'g-model' });
  applyFulfillmentMigration(db);

  const links = all(db, 'SELECT color_id, option_value_id FROM product_color_option_links ORDER BY color_id');
  assert.deepEqual(links, [
    { color_id: 'c-black', option_value_id: 'o-combo-pre' },
    { color_id: 'c-white', option_value_id: 'o-combo-pre' },
  ]);
});

test('order history is not touched, and its option id still resolves', () => {
  const db = legacySchema();
  legacyA1(db);
  insert(db, 'users', { id: 'u1' });
  insert(db, 'orders', {
    id: 'ord-1',
    user_id: 'u1',
    address_snapshot: '{}',
    delivery_method_id: 'dm',
    delivery_method_snapshot: '{}',
    payment_method_id: 'cod',
    subtotal_iqd: 699_000,
    exchange_rate: 1,
    total_iqd: 699_000,
    due_on_delivery_iqd: 699_000,
  });
  insert(db, 'order_items', {
    id: 'oi-1',
    order_id: 'ord-1',
    product_id: 'p-a1',
    option_id: 'o-combo-dir',
    name_snapshot: 'A1 mini Combo — Direct',
    qty: 1,
    unit_price_iqd: 699_000,
    line_total_iqd: 699_000,
  });
  applyFulfillmentMigration(db);

  const line = one(db, 'SELECT option_id, name_snapshot, unit_price_iqd FROM order_items WHERE id = ?', 'oi-1')!;
  assert.equal(line.option_id, 'o-combo-dir', 'an order line is frozen — its id is NOT repointed');
  assert.equal(line.unit_price_iqd, 699_000);
  // And that id still finds a row, which is the whole reason a tombstone is
  // kept rather than deleted.
  const target = one(db, 'SELECT id, active FROM product_option_values WHERE id = ?', 'o-combo-dir');
  assert.ok(target, 'the tombstone still exists for history to resolve');
  assert.equal(target!.active, 0);
});

test('an option with no variant_key is already a model, and is left as one', () => {
  const db = legacySchema();
  insert(db, 'products', { id: 'p-solo', slug: 'solo', name: 'Solo', price_iqd: 100_000 });
  insert(db, 'product_option_groups', { id: 'g-solo', product_id: 'p-solo', name_en: 'Size' });
  insert(db, 'product_option_values', {
    id: 'o-solo',
    product_id: 'p-solo',
    group_id: 'g-solo',
    name_en: 'Large',
    availability_type: 'pre_order',
    variant_key: '',
    regular_price_iqd: 120_000,
  });
  applyFulfillmentMigration(db);

  assert.equal(one(db, 'SELECT merged_into FROM product_option_values WHERE id = ?', 'o-solo')!.merged_into, '');
  const cells = all(db, 'SELECT option_id, fulfillment_type, regular_price_iqd FROM product_option_fulfillment');
  assert.deepEqual(cells, [{ option_id: 'o-solo', fulfillment_type: 'pre_order', regular_price_iqd: 120_000 }]);
});

test('an option that never declared a route gets no fulfilment row, and keeps inheriting', () => {
  const db = legacySchema();
  insert(db, 'products', { id: 'p-plain', slug: 'plain', name: 'Plain', price_iqd: 50_000 });
  insert(db, 'product_option_groups', { id: 'g-plain', product_id: 'p-plain', name_en: 'Size' });
  insert(db, 'product_option_values', { id: 'o-plain', product_id: 'p-plain', group_id: 'g-plain', name_en: 'M' });
  applyFulfillmentMigration(db);

  assert.equal(all(db, 'SELECT * FROM product_option_fulfillment').length, 0);
  const row = one(db, 'SELECT availability_type, merged_into, active FROM product_option_values WHERE id = ?', 'o-plain')!;
  assert.equal(row.availability_type, '', "'' still means inherit the product");
  assert.equal(row.merged_into, '');
  assert.equal(row.active, 1);
});

test('two legacy rows declaring the SAME route do not abort the migration', () => {
  const db = legacySchema();
  insert(db, 'products', { id: 'p-dup', slug: 'dup', name: 'Dup', price_iqd: 10_000 });
  insert(db, 'product_option_groups', { id: 'g-dup', product_id: 'p-dup', name_en: 'Model' });
  for (const [id, sort, price] of [['o-dup-a', 0, 20_000], ['o-dup-b', 1, 30_000]] as const) {
    insert(db, 'product_option_values', {
      id,
      product_id: 'p-dup',
      group_id: 'g-dup',
      name_en: id,
      sort,
      availability_type: 'pre_order',
      variant_key: 'dup',
      regular_price_iqd: price,
    });
  }
  applyFulfillmentMigration(db);

  const cells = all(db, 'SELECT option_id, fulfillment_type, regular_price_iqd FROM product_option_fulfillment');
  assert.deepEqual(cells, [{ option_id: 'o-dup-a', fulfillment_type: 'pre_order', regular_price_iqd: 20_000 }]);
  assert.equal(one(db, 'SELECT merged_into FROM product_option_values WHERE id = ?', 'o-dup-b')!.merged_into, 'o-dup-a');
});

test('the transport table starts empty — a product transport is still the default', () => {
  const db = legacySchema();
  legacyA1(db);
  db.prepare('UPDATE products SET preorder_transports = ? WHERE id = ?').run(
    JSON.stringify([{ method: 'air', commission_iqd: 50_000, active: true }]),
    'p-a1'
  );
  applyFulfillmentMigration(db);

  assert.equal(all(db, 'SELECT * FROM product_option_transports').length, 0);
  const p = one(db, 'SELECT preorder_transports FROM products WHERE id = ?', 'p-a1')!;
  assert.deepEqual(JSON.parse(String(p.preorder_transports)), [
    { method: 'air', commission_iqd: 50_000, active: true },
  ]);
});
