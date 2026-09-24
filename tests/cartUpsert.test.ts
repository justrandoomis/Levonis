/**
 * "The same line twice is one line with a bigger quantity" — against the real
 * migrated schema, with the real SQL the routes issue.
 *
 * THIS TEST EXISTS BECAUSE ITS ABSENCE COST A PRODUCTION OUTAGE.
 *
 * Migration 0030 rebuilt `cart_items` and, in widening the unique key to
 * cover merchant lines, broke it for both kinds of line at once — because
 * NULLS ARE DISTINCT in a SQLite unique index. A Levonis row has
 * `community_product_id = NULL` and a merchant row has `product_id = NULL`,
 * so a key spanning both columns can never collide with anything, and the
 * `ON CONFLICT(...)` in worker/routes/cart.ts stopped naming any index that
 * exists. SQLite answers that with an error, so adding ANYTHING to a cart
 * returned 500 on the live site.
 *
 * Every other cart test in this repo works on parsed structures or stubs.
 * None of them issue the actual statement against the actual schema, so none
 * of them could see it. These do: the migrations are applied to a real SQLite
 * engine and the SQL below is copied from the routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  // Release A schema: 0082 expand is present and 0083 contract is deliberately
  // a separate deployment. Most route SQL must remain valid in this dual-index
  // state; contract-only behaviour is tested in cartIdentityContract.test.ts.
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && !x.startsWith('0083')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id, slug, name, price_iqd, status)
      VALUES ('p1','widget','Widget',5000,'active');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name)
      VALUES ('s1','m1','u1','ali3d','Ali 3D');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd)
      VALUES ('cp1','m1','s1','ali3d-widget','Widget',5000);
  `);
  return raw;
}

/** Copied verbatim from worker/routes/cart.ts — that is the point. */
const LEVONIS_ADD = `
  INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id,
                          shipping_method_id, transport_method, warranty_plan_id, qty)
  VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  ON CONFLICT DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                option_value_ids = excluded.option_value_ids,
                transport_method = excluded.transport_method,
                warranty_plan_id = CASE WHEN excluded.warranty_plan_id = ''
                                        THEN cart_items.warranty_plan_id
                                        ELSE excluded.warranty_plan_id END`;

/** Release -1 statement: kept here to prove 0082 never strands a Worker that
 * still names the five-column 0032 conflict target. */
const LEGACY_LEVONIS_ADD = `
  INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id,
                          shipping_method_id, transport_method, warranty_plan_id, qty)
  VALUES (?, ?, ?, ?, ?, ?, '', '', '', ?)
  ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)
    WHERE product_id IS NOT NULL
  DO UPDATE SET qty = MIN(99, qty + excluded.qty)`;

const MERCHANT_ADD = `
  INSERT INTO cart_items
    (id, user_id, seller_type, merchant_id, store_id, community_product_id, option_id, color_id, qty)
  VALUES (?, ?, 'merchant', ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, community_product_id, option_id, color_id)
    WHERE community_product_id IS NOT NULL
  DO UPDATE SET qty = MIN(99, cart_items.qty + excluded.qty)`;

const addLevonis = (
  raw: DatabaseSync,
  id: string,
  qty = 1,
  opt = '',
  color = '',
  plan = '',
  selected: string[] = opt ? [opt] : []
) => {
  const canonical = [...new Set(selected.filter(Boolean))].sort();
  raw.prepare(LEVONIS_ADD).run(
    id,
    'u1',
    'p1',
    canonical[0] || opt || '',
    JSON.stringify(canonical),
    color,
    '',
    plan,
    qty
  );
};

const addMerchant = (raw: DatabaseSync, id: string, qty = 1, opt = '', color = '') =>
  raw.prepare(MERCHANT_ADD).run(id, 'u1', 'm1', 's1', 'cp1', opt, color, qty);

const rows = (raw: DatabaseSync) =>
  raw.prepare('SELECT * FROM cart_items ORDER BY id').all() as Array<Record<string, number | string | null>>;

// --------------------------------------------------------------- the fix

test('adding a Levonis product twice makes ONE line with qty 2', () => {
  const raw = db();
  addLevonis(raw, 'ci1', 1);
  addLevonis(raw, 'ci2', 1);
  const r = rows(raw);
  assert.equal(r.length, 1, 'a second add created a second line');
  assert.equal(r[0].qty, 2);
  assert.equal(r[0].seller_type, 'levonis');
});

test('adding a merchant product twice makes ONE line with qty 2', () => {
  const raw = db();
  addMerchant(raw, 'ci1', 1);
  addMerchant(raw, 'ci2', 1);
  const r = rows(raw);
  assert.equal(r.length, 1);
  assert.equal(r[0].qty, 2);
  assert.equal(r[0].seller_type, 'merchant');
});

test('the quantity is capped at the column CHECK rather than violating it', () => {
  const raw = db();
  addLevonis(raw, 'ci1', 60);
  addLevonis(raw, 'ci2', 60);
  assert.equal(rows(raw)[0].qty, 99);
});

test('a merge never blanks the line’s extended-warranty plan: an add without a plan keeps it, an add with one sets it', () => {
  // The warranty is not part of the merge key, so the second add lands on the
  // same line. The route refuses a DIFFERENT plan before this statement runs
  // (409 CART_WARRANTY_CONFLICT, tests/extendedWarranty.test.ts); what the SQL
  // itself must guarantee is that an add naming NO plan does not erase the
  // one the customer chose — the old `warranty_plan_id = excluded.…` did.
  const raw = db();
  addLevonis(raw, 'ci1', 1, '', '', 'wp_ext24');
  addLevonis(raw, 'ci2', 1, '', '', '');
  let r = rows(raw);
  assert.equal(r.length, 1);
  assert.equal(r[0].qty, 2);
  assert.equal(r[0].warranty_plan_id, 'wp_ext24', 'a plain re-add kept the chosen plan');
  addLevonis(raw, 'ci3', 1, '', '', 'wp_ext24');
  r = rows(raw);
  assert.equal(r[0].qty, 3);
  assert.equal(r[0].warranty_plan_id, 'wp_ext24');
  // A line with no plan takes the plan an add names (the route only lets
  // this statement see a plan that matches the line's, or a line with none
  // being given one is refused upstream — the SQL still behaves sensibly).
  raw.exec("UPDATE cart_items SET warranty_plan_id = '' WHERE id = 'ci1'");
  addLevonis(raw, 'ci4', 1, '', '', 'wp_ext12');
  assert.equal(rows(raw)[0].warranty_plan_id, 'wp_ext12');
});

test('a different option, colour or shipping method is a DIFFERENT line', () => {
  const raw = db();
  addLevonis(raw, 'ci1', 1, '', '');
  addLevonis(raw, 'ci2', 1, 'opt-a', '');
  addLevonis(raw, 'ci3', 1, '', 'red');
  assert.equal(rows(raw).length, 3);
});

test('0082 canonicalizes and dedupes without dropping the five-column v1 index', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of files) {
    if (f.startsWith('0082')) break;
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id, slug, name, price_iqd, status)
      VALUES ('p1','widget','Widget',5000,'active');
    INSERT INTO products (id, slug, name, price_iqd, status, composition)
      VALUES ('bundle1','mystery-box','Mystery box',5000,'active','mystery');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
      ('g-size','p1','Size',20,1),
      ('g-model','p1','Model',10,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active) VALUES
      ('a-size','p1','g-size','Small',0,1),
      ('z-model','p1','g-model','Model Z',0,1);
    INSERT INTO cart_items
      (id,user_id,seller_type,product_id,option_id,option_value_ids,warranty_plan_id,qty)
    VALUES
      ('legacy','u1','levonis','p1','z-model','["z-model","a-size","a-size"]','wp_ext12',1),
      ('legacy-second','u1','levonis','p1','a-size','["a-size","z-model"]','',2),
      ('bundle','u1','levonis','bundle1','bx_keep_me','["family-a"]','',1);
  `);

  raw.exec(readFileSync(join(dir, files.find((f) => f.startsWith('0082'))!), 'utf8'));
  const migrated = raw.prepare("SELECT option_id, option_value_ids FROM cart_items WHERE id = 'legacy'")
    .get() as { option_id: string; option_value_ids: string };
  assert.equal(migrated.option_id, 'z-model', 'expand must not rewrite the old index key');
  assert.equal(migrated.option_value_ids, '["a-size","z-model"]');
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE product_id = 'p1'").get() as { n: number }).n,
    1
  );
  assert.equal(
    (raw.prepare("SELECT qty FROM cart_items WHERE product_id = 'p1'").get() as { qty: number }).qty,
    3
  );
  assert.equal(
    (raw.prepare("SELECT warranty_plan_id FROM cart_items WHERE product_id = 'p1'").get() as { warranty_plan_id: string }).warranty_plan_id,
    '',
    'mixed warranty choices must be cleared rather than applied to unagreed units'
  );
  const bundle = raw.prepare("SELECT option_id, option_value_ids FROM cart_items WHERE id = 'bundle'")
    .get() as { option_id: string; option_value_ids: string };
  assert.equal(bundle.option_id, 'bx_keep_me');
  assert.equal(bundle.option_value_ids, '["family-a"]');

  const expandedIndexes = (raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cart_items'"
  ).all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(expandedIndexes.includes('idx_cart_levonis_line'));
  assert.ok(expandedIndexes.includes('idx_cart_levonis_line_v2'));

});

test('Release A UPSERT and the old Worker both work on old-only and dual-index schemas', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of files) {
    if (f.startsWith('0082')) break;
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id,slug,name,price_iqd,status) VALUES ('p1','widget','Widget',5000,'active');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g1','p1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active)
      VALUES ('opt-a','p1','g1','A',0,1);
  `);
  const oldAdd = (id: string) => raw.prepare(LEGACY_LEVONIS_ADD)
    .run(id, 'u1', 'p1', 'opt-a', '["opt-a"]', '', 1);
  const releaseAAdd = (id: string) => raw.prepare(LEVONIS_ADD)
    .run(id, 'u1', 'p1', 'opt-a', '["opt-a"]', '', '', '', 1);
  const qty = () => (raw.prepare("SELECT qty FROM cart_items WHERE product_id = 'p1'").get() as { qty: number }).qty;

  oldAdd('old-only-old-worker');
  releaseAAdd('old-only-release-a');
  assert.equal(qty(), 2, 'targetless Release A failed against the old-only index');

  raw.exec(readFileSync(join(dir, files.find((f) => f.startsWith('0082'))!), 'utf8'));
  oldAdd('dual-old-worker');
  releaseAAdd('dual-release-a');
  assert.equal(qty(), 4, 'old or new Worker failed against the dual-index schema');

});

test('reordering option groups cannot create a second line for the same complete selection', () => {
  const raw = db();
  raw.exec(`
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
      ('g-model','p1','Model',10,1),
      ('g-size','p1','Size',20,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active) VALUES
      ('z-model','p1','g-model','Model Z',0,1),
      ('a-size','p1','g-size','Small',0,1);
  `);

  addLevonis(raw, 'ci-before', 1, 'z-model', '', '', ['z-model', 'a-size']);
  raw.exec("UPDATE product_option_groups SET sort = CASE id WHEN 'g-model' THEN 20 ELSE 10 END WHERE product_id = 'p1'");
  addLevonis(raw, 'ci-after', 1, 'a-size', '', '', ['a-size', 'z-model']);

  const r = rows(raw);
  assert.equal(r.length, 1, 'group reorder changed the cart identity');
  assert.equal(r[0].qty, 2);
  assert.equal(r[0].option_id, 'a-size');
  assert.equal(r[0].option_value_ids, '["a-size","z-model"]');
});

test('a merchant line and a Levonis line never share one cart — the database refuses the second (0114)', () => {
  // They are different sellers; nothing about one may absorb the other, and
  // since migration 0114 one customer's cart cannot hold both at all
  // (docs/MERCHANT_PLATFORM.md §2 decision 1). The line identities still do
  // not collide across customers — tests/cartSellerGuard.test.ts has the rest.
  const raw = db();
  addLevonis(raw, 'ci1', 1);
  assert.throws(() => addMerchant(raw, 'ci2', 1), /CART_SELLER_CONFLICT/);
  const r = rows(raw);
  assert.equal(r.length, 1);
  assert.equal(r[0].seller_type, 'levonis');
});

// ------------------------------------------------- the invariants beneath

test('a cart line must name exactly one product source, matching its seller', () => {
  const raw = db();
  // A merchant line with no merchant: refused by the CHECK, not by the route.
  assert.throws(() =>
    raw.prepare(
      `INSERT INTO cart_items (id,user_id,seller_type,community_product_id,qty)
       VALUES ('bad','u1','merchant','cp1',1)`
    ).run()
  );
  // A Levonis line that also names a community product: refused.
  assert.throws(() =>
    raw.prepare(
      `INSERT INTO cart_items (id,user_id,seller_type,product_id,community_product_id,qty)
       VALUES ('bad2','u1','levonis','p1','cp1',1)`
    ).run()
  );
});

test('the partial indexes exist and are the ones the routes name', () => {
  const raw = db();
  const idx = (raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cart_items'"
  ).all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(idx.includes('idx_cart_levonis_line'), idx.join(', '));
  assert.ok(idx.includes('idx_cart_levonis_line_v2'), idx.join(', '));
  assert.ok(idx.includes('idx_cart_merchant_line'), idx.join(', '));
});

test('0032 folds duplicates that 0030 allowed instead of dropping a line', () => {
  // Rehearse the repair on the shape the broken window could produce: two
  // identical Levonis lines. The migration sums them; a customer's items are
  // not silently discarded to make an index build.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of files) {
    if (f.startsWith('0032')) break;
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id, slug, name, price_iqd, status)
      VALUES ('p1','widget','Widget',5000,'active');
    INSERT INTO cart_items (id,user_id,seller_type,product_id,qty) VALUES ('a','u1','levonis','p1',2);
    INSERT INTO cart_items (id,user_id,seller_type,product_id,qty) VALUES ('b','u1','levonis','p1',3);
  `);
  raw.exec(readFileSync(join(dir, files.find((f) => f.startsWith('0032'))!), 'utf8'));

  const r = raw.prepare('SELECT id, qty FROM cart_items').all() as Array<{ id: string; qty: number }>;
  assert.equal(r.length, 1, 'the duplicates were not folded');
  assert.equal(r[0].qty, 5, 'quantities were dropped rather than summed');
});

test('the conflict target 0030 left behind really does fail against this schema', () => {
  // Not a hypothetical. This is the exact statement that was live, and this
  // is the exact error the site returned as a 500 on every add-to-cart.
  const raw = db();
  assert.throws(
    () =>
      raw.prepare(
        `INSERT INTO cart_items (id, user_id, product_id, option_id, color_id, qty)
         VALUES ('x','u1','p1','','',1)
         ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)
         DO UPDATE SET qty = qty + 1`
      ).run(),
    /ON CONFLICT|no unique|does not match/i,
    'the pre-0032 conflict target unexpectedly resolved — this test no longer proves anything'
  );
});

// ------------------------------------------------ composition lines (0058)

/**
 * A BUNDLE LINE IS AN ORDINARY `cart_items` ROW, and that is the whole point
 * of §5.1: it satisfies the same table CHECK, the same
 * `UNIQUE (user_id, product_id, community_product_id, option_id, color_id,
 * shipping_method_id)`, the same partial index `idx_cart_levonis_line` and the
 * same `ON CONFLICT(...)` upsert. Migration 0082 widens the partial index with
 * canonical option_value_ids while retaining option_id for this key.
 *
 * The composition key remains in `option_id`; option_value_ids adds ordinary
 * multi-group identity without replacing the bundle key.
 *
 * `draw_salt` is the one column 0058 adds, and it is deliberately OUTSIDE the
 * tuple, so `ALTER TABLE … ADD COLUMN` does not touch the index at all.
 */
const BUNDLE_ADD = `
  INSERT INTO cart_items (id, user_id, product_id, option_id, option_value_ids, color_id,
                          shipping_method_id, transport_method, warranty_plan_id, qty, draw_salt)
  VALUES (?, ?, ?, ?, '[]', '', '', ?, '', ?, ?)
  ON CONFLICT DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                transport_method = excluded.transport_method`;

const addBundleLine = (raw: DatabaseSync, id: string, key: string, qty = 1, salt = '') =>
  raw.prepare(BUNDLE_ADD).run(id, 'u1', 'pb1', key, '', qty, salt);

const withBundle = () => {
  const raw = db();
  raw.exec(`
    INSERT INTO products (id, slug, name, price_iqd, status, stock, composition, selling_type)
      VALUES ('pb1','starter-bundle','Starter Bundle',400000,'active',NULL,'bundle','bundle');
  `);
  return raw;
};

test('a bundle line upserts through the SAME index, and the same key merges', () => {
  const raw = withBundle();
  addBundleLine(raw, 'cb1', 'bx_1111111111111111', 1);
  addBundleLine(raw, 'cb2', 'bx_1111111111111111', 1);
  const r = rows(raw);
  assert.equal(r.length, 1, 'identical composition keys are one line');
  assert.equal(r[0].qty, 2);
  assert.equal(r[0].option_id, 'bx_1111111111111111');
  assert.equal(r[0].option_value_ids, '[]', 'the key is line identity, never a selection');
});

test('two different composition keys are two lines, exactly like two options are', () => {
  const raw = withBundle();
  addBundleLine(raw, 'cb1', 'bx_1111111111111111', 1);
  addBundleLine(raw, 'cb2', 'bx_2222222222222222', 1);
  assert.equal(rows(raw).length, 2);
});

test('a bundle line and an ordinary line of the same customer never collide', () => {
  const raw = withBundle();
  addLevonis(raw, 'ci1', 1);
  addBundleLine(raw, 'cb1', 'bx_1111111111111111', 1);
  const r = rows(raw);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => String(x.product_id)).sort(), ['p1', 'pb1']);
});

test('draw_salt stays outside the unique tuple and full option identity stays inside it', () => {
  const raw = db();
  const cols = (raw.prepare('PRAGMA table_info(cart_items)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('draw_salt'), 'draw_salt is missing');
  // 0082 adds the complete option selection; draw_salt remains unrelated.
  const idx = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_cart_levonis_line_v2'").get() as {
    sql: string;
  }).sql;
  assert.ok(!idx.includes('draw_salt'), 'draw_salt must not be inside idx_cart_levonis_line');
  assert.ok(!idx.includes('composition_key'), 'the composition key rides in option_id, not a new column');
  for (const part of ['user_id', 'product_id', 'option_id', 'option_value_ids', 'color_id', 'shipping_method_id']) {
    assert.ok(idx.includes(part), `${part} left the line-identity index`);
  }
});

test('cart_bundle_choices cascade with the line they belong to', () => {
  const raw = withBundle();
  raw.exec(`
    INSERT INTO bundle_components (id,bundle_product_id,member_product_id,qty) VALUES ('bc_1','pb1','p1',1);
  `);
  addBundleLine(raw, 'cb1', 'bx_1111111111111111', 1);
  raw
    .prepare("INSERT INTO cart_bundle_choices (cart_item_id, component_id, option_value_ids, color_id, included) VALUES ('cb1','bc_1','[]','',1)")
    .run();
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM cart_bundle_choices').get() as { n: number }).n, 1);
  raw.prepare("DELETE FROM cart_items WHERE id = 'cb1'").run();
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS n FROM cart_bundle_choices').get() as { n: number }).n,
    0,
    'a removed cart line must not leave its composition behind'
  );
});
