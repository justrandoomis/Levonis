/**
 * Migration 0022 — the backfill from the JSON option/colour/image columns into
 * the relational tables (mandate §11: "حافظ على التوافق مع المنتجات الحالية
 * عبر migration/backfill، ولا تستخدم destructive reset").
 *
 * Products are inserted in BOTH JSON generations that exist in the live
 * database — the v1 shape ({name, price_iqd, option_id}) and the v2 shape
 * ({name_en, regular_price_iqd, linked_option_ids}) — then 0018–0022 run, and
 * the resulting rows are checked. The JSON columns are asserted UNCHANGED
 * afterwards: a backfill that quietly rewrites the source it read from is not
 * reversible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, newSqlite } from './fixtures/d1';

const migrations = readdirSync(join(ROOT, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const upTo = (raw: DatabaseSync, last: string) => {
  for (const f of migrations) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
    if (f.startsWith(last)) return;
  }
};

const V1_OPTIONS = JSON.stringify([
  { id: 'o1', name: 'A1', image: 'a1.png', price_iqd: 120000, cost_iqd: 70000 },
  { id: 'o2', name: 'P1S', price_iqd: 150000 },
]);
const V1_COLORS = JSON.stringify([
  { id: 'c1', name: 'Black', hex: '#000000', option_id: 'o1' },
  { id: 'c2', name: 'White', hex: '#FFFFFF' },
]);
const V1_IMAGES = JSON.stringify(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);

const V2_OPTIONS = JSON.stringify([
  { id: 'x1', name_en: 'Combo', name_ar: 'باقة', order: 1, active: true, regular_price_iqd: 90000, pro_price_iqd: 85000 },
  { id: 'x2', name_en: 'Solo', order: 0, active: false, regular_price_iqd: 60000 },
]);
const V2_COLORS = JSON.stringify([
  { id: 'y1', name_en: 'Gold', hex: '#c8a951', linked_option_ids: ['x1', 'x2'] },
]);
const V2_IMAGES = JSON.stringify([
  { url: 'https://cdn.example/1.jpg', primary: false, alt_en: 'front' },
  { url: 'https://cdn.example/2.jpg', primary: true, alt_en: 'back' },
]);

function seeded(): DatabaseSync {
  const raw = newSqlite();
  upTo(raw, '0017');
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, price_iqd, stock, options, colors, images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run('prd_v1', 'legacy-one', 'Legacy One', 100000, 5, V1_OPTIONS, V1_COLORS, V1_IMAGES);
  ins.run('prd_v2', 'legacy-two', 'Legacy Two', 200000, 2, V2_OPTIONS, V2_COLORS, V2_IMAGES);
  ins.run('prd_bare', 'legacy-bare', 'No Variants', 5000, null, '[]', '[]', '[]');
  for (const f of ['0018', '0019', '0020', '0021', '0022']) upTo2(raw, f);
  return raw;
}

/** Applies exactly one migration by number prefix. */
function upTo2(raw: DatabaseSync, prefix: string) {
  const file = migrations.find((f) => f.startsWith(prefix));
  assert.ok(file, `migration ${prefix} not found`);
  raw.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
}

test('a v1 product gets one group, its values and its colours', () => {
  const raw = seeded();
  const groups = raw.prepare('SELECT * FROM product_option_groups WHERE product_id = ?').all('prd_v1');
  assert.equal(groups.length, 1);
  const values = raw
    .prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY sort')
    .all('prd_v1') as Array<Record<string, unknown>>;
  assert.deepEqual(values.map((v) => v.name_en), ['A1', 'P1S']);
  assert.equal(values[0].regular_price_iqd, 120000, 'v1 price_iqd maps to regular_price_iqd');
  assert.equal(values[0].cost_iqd, 70000);
  assert.equal(values[0].stock, null, 'no per-option quantity is invented from base stock');
});

test('a v2 product reads the v2 field names and honours active/order', () => {
  const raw = seeded();
  const values = raw
    .prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY sort')
    .all('prd_v2') as Array<Record<string, unknown>>;
  assert.deepEqual(values.map((v) => v.name_en), ['Solo', 'Combo']);
  assert.equal(values.find((v) => v.name_en === 'Solo')!.active, 0);
  assert.equal(values.find((v) => v.name_en === 'Combo')!.pro_price_iqd, 85000);
});

test('a v1 single option_id becomes ONE real link row', () => {
  const raw = seeded();
  const links = raw
    .prepare(
      `SELECT l.* FROM product_color_option_links l
         JOIN product_colors c ON c.id = l.color_id
        WHERE c.product_id = ?`
    )
    .all('prd_v1') as Array<Record<string, unknown>>;
  assert.equal(links.length, 1);
  assert.equal(links[0].option_value_id, 'ov_prd_v1_o1');
  assert.equal(links[0].group_id, 'og_prd_v1');
});

test('a v2 linked_option_ids list becomes MANY link rows (OR inside the group)', () => {
  const raw = seeded();
  const links = raw
    .prepare(
      `SELECT l.option_value_id FROM product_color_option_links l
         JOIN product_colors c ON c.id = l.color_id
        WHERE c.product_id = ? ORDER BY l.option_value_id`
    )
    .all('prd_v2') as Array<{ option_value_id: string }>;
  assert.deepEqual(links.map((l) => l.option_value_id), ['ov_prd_v2_x1', 'ov_prd_v2_x2']);
});

test('a colour with no link gets no rows — which IS "visible with every option"', () => {
  const raw = seeded();
  const white = raw
    .prepare('SELECT COUNT(*) AS n FROM product_color_option_links WHERE color_id = ?')
    .get('pc_prd_v1_c2') as { n: number };
  assert.equal(white.n, 0);
});

test('an unusable hex becomes black instead of blocking the migration', () => {
  const raw = newSqlite();
  upTo(raw, '0017');
  raw
    .prepare('INSERT INTO products (id, slug, name, price_iqd, colors) VALUES (?,?,?,?,?)')
    .run('prd_bad', 'bad-hex', 'Bad Hex', 1000, JSON.stringify([{ id: 'z', name: 'Weird', hex: 'not-a-colour' }]));
  for (const f of ['0018', '0019', '0020', '0021', '0022']) upTo2(raw, f);
  const row = raw.prepare('SELECT hex FROM product_colors WHERE product_id = ?').get('prd_bad') as { hex: string };
  assert.equal(row.hex, '#000000');
});

test('v1 string images and v2 media objects both become image rows, with exactly one primary', () => {
  const raw = seeded();
  for (const productId of ['prd_v1', 'prd_v2']) {
    const imgs = raw
      .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order')
      .all(productId) as Array<Record<string, unknown>>;
    assert.equal(imgs.length, 2, productId);
    assert.equal(imgs.filter((i) => i.is_primary === 1).length, 1, `${productId}: exactly one primary`);
  }
  const v1 = raw
    .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order')
    .all('prd_v1') as Array<Record<string, unknown>>;
  assert.equal(v1[0].url, 'https://cdn.example/a.jpg');
  assert.equal(v1[0].is_primary, 1, 'with nothing claiming primary, the first image is it');

  const v2 = raw
    .prepare('SELECT * FROM product_images WHERE product_id = ? AND is_primary = 1')
    .all('prd_v2') as Array<Record<string, unknown>>;
  assert.equal(v2[0].url, 'https://cdn.example/2.jpg', 'the object that claims primary wins');
  assert.equal(v2[0].alt_en, 'back');
});

test('a product with no variants and no images gets no rows at all', () => {
  const raw = seeded();
  for (const table of ['product_option_groups', 'product_option_values', 'product_colors', 'product_images']) {
    const n = raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE product_id = ?`).get('prd_bare') as { n: number };
    assert.equal(n.n, 0, table);
  }
});

test('every existing product stays on BASE inventory — nothing changes how it sells', () => {
  const raw = seeded();
  const rows = raw.prepare('SELECT id, inventory_mode, stock FROM products').all() as Array<{
    id: string;
    inventory_mode: string;
    stock: number | null;
  }>;
  for (const r of rows) assert.equal(r.inventory_mode, 'BASE', r.id);
  assert.equal(rows.find((r) => r.id === 'prd_v1')!.stock, 5, 'base stock untouched');
});

test('the source JSON columns are left exactly as they were', () => {
  const raw = seeded();
  const row = raw.prepare('SELECT options, colors, images FROM products WHERE id = ?').get('prd_v1') as {
    options: string;
    colors: string;
    images: string;
  };
  assert.equal(row.options, V1_OPTIONS);
  assert.equal(row.colors, V1_COLORS);
  assert.equal(row.images, V1_IMAGES);
});

test('re-running the backfill duplicates nothing', () => {
  const raw = seeded();
  const before = raw.prepare('SELECT COUNT(*) AS n FROM product_option_values').get() as { n: number };
  upTo2(raw, '0022');
  const after = raw.prepare('SELECT COUNT(*) AS n FROM product_option_values').get() as { n: number };
  assert.equal(after.n, before.n);
});

test('a product already curated in the new form is never mixed with migrated images', () => {
  const raw = newSqlite();
  upTo(raw, '0017');
  raw
    .prepare('INSERT INTO products (id, slug, name, price_iqd, images) VALUES (?,?,?,?,?)')
    .run('prd_cur', 'curated', 'Curated', 1000, JSON.stringify(['https://old/1.jpg', 'https://old/2.jpg']));
  for (const f of ['0018', '0019', '0020', '0021']) upTo2(raw, f);
  // The admin already replaced the gallery through the new endpoint.
  raw
    .prepare('INSERT INTO product_images (id, product_id, url, sort_order, is_primary) VALUES (?,?,?,?,?)')
    .run('pi_new', 'prd_cur', 'https://new/only.jpg', 0, 1);
  upTo2(raw, '0022');
  const imgs = raw.prepare('SELECT url FROM product_images WHERE product_id = ?').all('prd_cur') as Array<{
    url: string;
  }>;
  assert.deepEqual(imgs.map((i) => i.url), ['https://new/only.jpg']);
});

test('a product in exactly one catalog gets that catalog as its main section', () => {
  const raw = newSqlite();
  upTo(raw, '0017');
  raw.prepare('INSERT INTO products (id, slug, name, price_iqd) VALUES (?,?,?,?)').run('prd_one', 'one', 'One', 100);
  raw.prepare('INSERT INTO products (id, slug, name, price_iqd) VALUES (?,?,?,?)').run('prd_two', 'two', 'Two', 100);
  raw
    .prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?,?,?,?)')
    .run('cat_a', 'cat-a', 'أ', 'A');
  raw
    .prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?,?,?,?)')
    .run('cat_b', 'cat-b', 'ب', 'B');
  raw.prepare('INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?,?,?)').run('prd_one', 'cat_a', 1);
  raw.prepare('INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?,?,?)').run('prd_two', 'cat_a', 2);
  raw.prepare('INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?,?,?)').run('prd_two', 'cat_b', 1);
  for (const f of ['0018', '0019', '0020', '0021', '0022']) upTo2(raw, f);

  const one = raw.prepare('SELECT category_id FROM products WHERE id = ?').get('prd_one') as { category_id: string };
  assert.equal(one.category_id, 'cat_a');
  const two = raw.prepare('SELECT category_id FROM products WHERE id = ?').get('prd_two') as {
    category_id: string | null;
  };
  assert.equal(two.category_id, null, 'an ambiguous placement is left for the admin, never guessed');
});
