/**
 * THE SCHEMA INVARIANT WITH A TEST ATTACHED — case 3 of the owner's seventeen
 * ("never duplicate product inventory"), docs/BUNDLES_MYSTERY.md §15.2.
 *
 * NO STOCK OR RESERVED COLUMN EXISTS OUTSIDE `products`,
 * `product_option_values`, `product_colors` and `product_variants`. A bundle
 * and a mystery offer have NO stock of their own: `products.stock` is NULL on
 * the composition row for ever and availability is computed from the members'
 * real inventory at every read. This is the mandate's hardest schema rule, and
 * a static test is the only thing that can keep it true against a future
 * migration that "just adds a cached count".
 *
 * It also pins the two structural decisions that are easy to undo by accident:
 * `cart_items` gained ONLY `draw_salt` (a column inside the
 * `UNIQUE (user_id, product_id, community_product_id, option_id, color_id,
 * shipping_method_id)` tuple would rebuild `idx_cart_levonis_line`, which is
 * the exact operation migrations/0032_cart_line_identity.sql exists because
 * of), and every composition column is a foreign key into the real catalogue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, row } from './fixtures/app';
import { validateProductDoc } from '../worker/lib/productModel';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';

/**
 * The composition feature's own migrations, whatever of them exist yet.
 *
 * The contract fixes 0058-0062; 0063 exists because §1.11's `offer_windows`
 * backfill cannot run inside 0059 (0060 creates that table, and migrations
 * apply in file order). The range here follows the FILES, not the contract's
 * planned numbering — an invariant that stops one number short of the feature
 * is an invariant a later migration escapes silently.
 */
const FEATURE_FILES = readdirSync(join(ROOT, 'migrations'))
  .filter((f) => /^00(5[89]|6[0-3])_/.test(f))
  .sort();

const sqlOf = (f: string) => readFileSync(join(ROOT, 'migrations', f), 'utf8').replace(/--[^\n]*/g, '');

const FORBIDDEN = ['stock', 'stock_reserved', 'reserved', 'available', 'quantity'];
const REAL_STOCK_TABLES = ['product_option_fulfillment', 'products', 'product_option_values', 'product_colors', 'product_variants'];
const FEATURE_PREFIXES = /^(bundle_|mystery_|offer_|cart_bundle_|composition_|order_reservation_)/;

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
}

/** The live schema, so the assertions read the database rather than a regex
 *  over a file that may have been re-formatted. */
function schema(): { raw: DatabaseSync; tables: string[] } {
  const raw = freshDb();
  const tables = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  return { raw, tables };
}

test('every migration that creates a composition table is inside the invariant’s range', () => {
  assert.ok(FEATURE_FILES.length > 0, 'no composition migration found');
  assert.ok(FEATURE_FILES.includes('0058_composition_core.sql'));
  // The range above is a number range, and a number range drifts: 0063 exists
  // only because the `offer_windows` backfill could not run inside 0059. So
  // the range is checked against the FILES rather than trusted — any migration
  // anywhere that creates a composition table must be one this file walks, or
  // it carries no assertion at all.
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    // The legacy `bundles` / `bundle_items` pair of 0034 shares the prefix and
    // predates the feature; the era starts at 0058 (§1.1).
    if (FEATURE_FILES.includes(f) || f < '0058') continue;
    // 0073 rebuilds historical tables; the live-schema assertions below verify them.
    if (f === '0073_product_history_dependencies.sql') continue;
    for (const m of sqlOf(f).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
      assert.ok(!FEATURE_PREFIXES.test(m[1]), `${f} creates ${m[1]} outside the range this file walks`);
    }
  }
});

test('no composition table carries a stock, reserved, available or quantity column', () => {
  const { raw, tables } = schema();
  const offenders: string[] = [];
  for (const t of tables.filter((x) => FEATURE_PREFIXES.test(x))) {
    const cols = raw.prepare(`PRAGMA table_info(${t})`).all() as unknown as Column[];
    for (const c of cols) {
      if (FORBIDDEN.includes(c.name)) offenders.push(`${t}.${c.name}`);
    }
  }
  assert.deepEqual(offenders, [], 'a composition table invented its own inventory');
});

test('the feature’s migrations add no forbidden column to ANY table', () => {
  // Catches the other direction too: an ALTER that hangs a cached count off an
  // existing table rather than creating a new one.
  for (const f of FEATURE_FILES) {
    for (const m of sqlOf(f).matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
      assert.ok(!FORBIDDEN.includes(m[2]), `${f} adds ${m[1]}.${m[2]}`);
    }
  }
});

test('the four real stock tables are untouched by the feature’s migrations', () => {
  for (const f of FEATURE_FILES) {
    const sql = sqlOf(f);
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
      if (!REAL_STOCK_TABLES.includes(m[1])) continue;
      // `products.composition` is the ONE column the feature adds to a stock
      // table, and it holds no quantity of any kind.
      assert.equal(`${m[1]}.${m[2]}`, 'products.composition', `${f}: unexpected column on a stock table`);
    }
    assert.doesNotMatch(sql, /DROP\s+TABLE/i, `${f} must be additive`);
    assert.doesNotMatch(sql, /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, `${f}: every CREATE TABLE is IF NOT EXISTS`);
  }
});

test('cart_items gained ONLY draw_salt, so idx_cart_levonis_line is never rebuilt', () => {
  const added: string[] = [];
  for (const f of FEATURE_FILES) {
    for (const m of sqlOf(f).matchAll(/ALTER\s+TABLE\s+cart_items\s+ADD\s+COLUMN\s+(\w+)/gi)) added.push(m[1]);
  }
  assert.deepEqual(added, ['draw_salt']);

  const { raw } = schema();
  const idx = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_cart_levonis_line'")
    .get() as { sql: string } | undefined;
  assert.ok(idx, 'the partial unique index still exists');
  assert.doesNotMatch(idx!.sql, /draw_salt/, 'the new column is not part of cart line identity');
  const tuple = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cart_items'").get() as { sql: string };
  assert.match(tuple.sql, /UNIQUE\s*\(\s*user_id,\s*product_id,\s*community_product_id,\s*option_id,\s*color_id,\s*shipping_method_id\s*\)/);
});

test('every composition column that names catalogue data is a foreign key into it', () => {
  const { raw } = schema();
  const expected: Record<string, Record<string, string>> = {
    bundle_config: { product_id: 'products' },
    bundle_components: { bundle_product_id: 'products', member_product_id: 'products' },
    bundle_component_choices: { component_id: 'bundle_components' },
    cart_bundle_choices: { cart_item_id: 'cart_items', component_id: 'bundle_components' },
    order_reservation_fence: { order_id: 'orders' },
    offer_redemptions: { user_id: 'users', order_id: 'orders' },
  };
  for (const [table, cols] of Object.entries(expected)) {
    const keys = raw.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string }>;
    for (const [column, target] of Object.entries(cols)) {
      const found = keys.find((k) => k.from === column);
      assert.ok(found, `${table}.${column} is not a foreign key`);
      assert.equal(found!.table, target, `${table}.${column} points at the wrong table`);
    }
  }
});

test('a member product cannot be deleted out from under a bundle — RESTRICT, never CASCADE', () => {
  const sql = sqlOf('0058_composition_core.sql');
  assert.match(sql, /member_product_id\s+TEXT NOT NULL REFERENCES products\(id\) ON DELETE RESTRICT/);
  // ...while the bundle's own rows go with it.
  assert.match(sql, /bundle_product_id\s+TEXT NOT NULL REFERENCES products\(id\) ON DELETE CASCADE/);
});

test('the fence is keyed per (order, kind) and enforces its own equality', () => {
  const { raw } = schema();
  const t = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_reservation_fence'").get() as {
    sql: string;
  };
  assert.match(t.sql, /PRIMARY KEY \(order_id, kind\)/);
  assert.match(t.sql, /CHECK \(actual = expected\)/);
});

test('the offer secret, once it exists, is referenced by exactly one module', () => {
  // Written now so the rule lands with the table rather than after it: the seed
  // is a pure function of the secret, so one leaked admin payload would let
  // anyone precompute every future draw.
  const referencing: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && readFileSync(join(ROOT, p), 'utf8').includes('mystery_offer_secrets')) {
        referencing.push(p);
      }
    }
  };
  for (const dir of ['worker', 'src', 'packages']) walk(dir);
  // The OWNERSHIP REGISTRY is the one other place the name may appear, and it
  // is not a reader: `01-TARGET.md` §2.1 and `tests/ownership.test.ts` require
  // every table a migration creates to be claimed by exactly one service, so
  // the alternative to naming it there is an unowned table — or a name spelled
  // in pieces to dodge a grep, which would be worse than the risk it hides.
  const OWNERSHIP = 'packages/contracts/src/ownership.ts';
  assert.deepEqual(
    referencing.filter((p) => p !== 'worker/lib/mysteryDraw.ts' && p !== OWNERSHIP),
    [],
    'the offer secret is read by worker/lib/mysteryDraw.ts and nothing else'
  );
  if (referencing.includes(OWNERSHIP)) {
    // ...and it stays a LIST there, never a query.
    const src = readFileSync(join(ROOT, OWNERSHIP), 'utf8');
    for (const line of src.split('\n').filter((l) => l.includes('mystery_offer_secrets'))) {
      assert.doesNotMatch(line, /SELECT|FROM|INSERT|prepare\(/i, 'the ownership registry lists the table, it never reads it');
    }
  }
});

test('the composition column exists on products, defaults to ordinary, and indexes its listing', () => {
  const { raw } = schema();
  const cols = raw.prepare('PRAGMA table_info(products)').all() as unknown as Column[];
  const composition = cols.find((c) => c.name === 'composition');
  assert.ok(composition, 'products.composition is missing');
  assert.equal(composition!.notnull, 1);
  assert.equal(String(composition!.dflt_value), "''", 'every existing row is an ordinary product');
  const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_products_composition'").get();
  assert.ok(idx, 'idx_products_composition is missing');
});

test('a bundle row stores NULL stock and the four stock tables are the only counters that exist', () => {
  const { raw, tables } = schema();
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,stock,composition,selling_type,sale_types,inventory_mode)
      VALUES ('prd_bundle','b','Bundle',145000,NULL,'bundle','bundle','["bundle"]','BASE');
  `);
  const row = raw.prepare('SELECT stock, stock_reserved FROM products WHERE id = ?').get('prd_bundle') as {
    stock: number | null;
    stock_reserved: number;
  };
  assert.equal(row.stock, null);
  assert.equal(row.stock_reserved, 0);

  // Every table in the whole schema carrying a `stock` column, listed. New
  // entries here are a deliberate decision, never an accident.
  const withStock = tables.filter((t) =>
    (raw.prepare(`PRAGMA table_info(${t})`).all() as unknown as Column[]).some((c) => c.name === 'stock')
  );
  assert.deepEqual(
    withStock.sort(),
    [
      ...REAL_STOCK_TABLES,
      // Pre-existing, and neither is platform catalogue inventory: a merchant's
      // own product stock, and the gift pool's remaining prizes.
      'community_products',
      'gift_pool_items',
    ].sort(),
    'a new table with a stock column is a deliberate decision, never an accident'
  );
});

// ------------------------------------------------- the write door (§1.2)

test('planProductSave REFUSES a composition row from any writer that did not ask for one', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,email,role) VALUES ('boss','a@x.co','admin')");
  const db = asD1(raw);
  const doc = validateProductDoc({ name_en: 'Starter Bundle', price_iqd: 145_000, composition: 'bundle' });

  await assert.rejects(
    () => planProductSave(db, { mode: 'create', doc, prev: null, relations: null, actor: { adminId: 'boss', money: true } }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'COMPOSITION_NOT_ALLOWED');
      return true;
    }
  );
});

test('the pins of §1.2 are applied by the one writer, not by the panel that calls it', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,email,role) VALUES ('boss','a@x.co','admin')");
  const db = asD1(raw);

  // A caller trying to give a bundle stock, options and a colour of its own.
  const doc = validateProductDoc({
    name_en: 'Starter Bundle',
    price_iqd: 145_000,
    composition: 'bundle',
    stock: 40,
    low_stock_threshold: 5,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale'],
    options: [{ id: 'ov_x', name_en: 'Large' }],
    colors: [{ id: 'clr_x', name_en: 'Black', hex: '#000000' }],
  });
  doc.id = 'prd_bundle';
  doc.slug = 'starter-bundle';

  const plan = await planProductSave(db, {
    mode: 'create',
    doc,
    prev: null,
    relations: null,
    allowComposition: true,
    actor: { adminId: 'boss', money: true },
  });
  await saveProductAtomic(db, plan);

  const stored = row<{
    stock: number | null;
    stock_reserved: number;
    inventory_mode: string;
    selling_type: string;
    sale_types: string;
    composition: string;
    options: string;
    colors: string;
    low_stock_threshold: number | null;
  }>(raw, 'SELECT stock, stock_reserved, inventory_mode, selling_type, sale_types, composition, options, colors, low_stock_threshold FROM products WHERE id = ?', 'prd_bundle')!;

  assert.equal(stored.stock, null, 'NEVER stocked — the single most important invariant in the design');
  assert.equal(stored.stock_reserved, 0, 'nothing reserves against the bundle row itself');
  assert.equal(stored.inventory_mode, 'BASE', 'so resolveStock answers available: null for the bundle row');
  assert.equal(stored.low_stock_threshold, null, 'a warn level on a row with no stock is a lie');
  assert.equal(stored.composition, 'bundle');
  assert.equal(stored.selling_type, 'bundle');
  assert.deepEqual(JSON.parse(stored.sale_types), ['bundle']);
  assert.deepEqual(JSON.parse(stored.options), [], 'a bundle’s variability lives in its components');
  assert.deepEqual(JSON.parse(stored.colors), []);
});

test('a PRE-ORDER bundle keeps its pre-order type, with "bundle" pinned first', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,email,role) VALUES ('boss','a@x.co','admin')");
  const db = asD1(raw);
  const doc = validateProductDoc({
    name_en: 'Pre-order Bundle',
    price_iqd: 100_000,
    composition: 'bundle',
    sale_types: ['pre_order'],
    preorder_transports: [{ method: 'air', commission_iqd: 12_000, active: true }],
  });
  doc.id = 'prd_pb';
  doc.slug = 'preorder-bundle';
  const plan = await planProductSave(db, {
    mode: 'create',
    doc,
    prev: null,
    relations: null,
    allowComposition: true,
    actor: { adminId: 'boss', money: true },
  });
  await saveProductAtomic(db, plan);
  const stored = row<{ sale_types: string; selling_type: string }>(
    raw,
    'SELECT sale_types, selling_type FROM products WHERE id = ?',
    'prd_pb'
  )!;
  // serializeDoc writes `selling_type: sale_types[0]`, so pinning position 0
  // IS what pins the scalar — one rule, not two that could drift.
  assert.deepEqual(JSON.parse(stored.sale_types), ['bundle', 'pre_order']);
  assert.equal(stored.selling_type, 'bundle');
});

test('a product can never be converted into a composition, or back', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,email,role) VALUES ('boss','a@x.co','admin')");
  const db = asD1(raw);
  const ordinary = validateProductDoc({ name_en: 'PLA', price_iqd: 25_000, stock: 10 });
  ordinary.id = 'prd_pla';
  ordinary.slug = 'pla';
  await saveProductAtomic(
    db,
    await planProductSave(db, { mode: 'create', doc: ordinary, prev: null, relations: null, actor: { adminId: 'boss', money: true } })
  );

  const promoted = validateProductDoc({ name_en: 'PLA', price_iqd: 25_000, composition: 'bundle' });
  promoted.id = 'prd_pla';
  promoted.slug = 'pla';
  await assert.rejects(
    () =>
      planProductSave(db, {
        mode: 'update',
        doc: promoted,
        prev: ordinary,
        relations: null,
        allowComposition: true,
        actor: { adminId: 'boss', money: true },
      }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'COMPOSITION_NOT_ALLOWED');
      return true;
    }
  );

  // ...and a bundle cannot be demoted into a stockless ordinary product, which
  // `saleAvailability` would read as "untracked → sell 99".
  const bundle = validateProductDoc({ name_en: 'Bundle', price_iqd: 145_000, composition: 'bundle' });
  const demoted = validateProductDoc({ name_en: 'Bundle', price_iqd: 145_000 });
  demoted.id = bundle.id;
  await assert.rejects(
    () =>
      planProductSave(db, {
        mode: 'update',
        doc: demoted,
        prev: bundle,
        relations: null,
        allowComposition: true,
        actor: { adminId: 'boss', money: true },
      }),
    /composition/
  );
});

test('an existing composition row is not editable by an ordinary product writer', async () => {
  const bundle = validateProductDoc({ name_en: 'Bundle', price_iqd: 145_000, composition: 'bundle' });
  const edit = validateProductDoc({ name_en: 'Bundle', price_iqd: 999_000, composition: 'bundle' });
  edit.id = bundle.id;
  const raw = freshDb();
  const db = asD1(raw);
  await assert.rejects(
    () => planProductSave(db, { mode: 'update', doc: edit, prev: bundle, relations: null, actor: { adminId: 'boss', money: true } }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'COMPOSITION_NOT_ALLOWED');
      return true;
    }
  );
});

test('a composition row is refused option groups, colours and variants of its own', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,email,role) VALUES ('boss','a@x.co','admin')");
  const db = asD1(raw);
  const doc = validateProductDoc({ name_en: 'Bundle', price_iqd: 145_000, composition: 'bundle' });
  await assert.rejects(
    () =>
      planProductSave(db, {
        mode: 'create',
        doc,
        prev: null,
        relations: { groups: [{ name_en: 'Size', values: [{ name_en: 'Large' }] }] },
        allowComposition: true,
        actor: { adminId: 'boss', money: true },
      }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'COMPOSITION_NOT_ALLOWED');
      return true;
    }
  );
});

test('the CSV importer states the same refusal, because it writes the product row itself', () => {
  // `composition` is part of PRODUCT_COLUMNS, so an importer update that did
  // not refuse would write '' over a bundle's own value and demote it.
  const src = readFileSync(join(ROOT, 'worker/routes/adminImport.ts'), 'utf8');
  assert.match(src, /COMPOSITION_NOT_ALLOWED/);
  assert.match(src, /doc\.composition !== ''/);
});
