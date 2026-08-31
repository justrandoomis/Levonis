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
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
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
  ON CONFLICT(user_id, product_id, option_id, color_id, shipping_method_id)
    WHERE product_id IS NOT NULL
  DO UPDATE SET qty = MIN(99, qty + excluded.qty),
                option_value_ids = excluded.option_value_ids,
                transport_method = excluded.transport_method,
                warranty_plan_id = excluded.warranty_plan_id`;

const MERCHANT_ADD = `
  INSERT INTO cart_items
    (id, user_id, seller_type, merchant_id, store_id, community_product_id, option_id, color_id, qty)
  VALUES (?, ?, 'merchant', ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, community_product_id, option_id, color_id)
    WHERE community_product_id IS NOT NULL
  DO UPDATE SET qty = MIN(99, cart_items.qty + excluded.qty)`;

const addLevonis = (raw: DatabaseSync, id: string, qty = 1, opt = '', color = '') =>
  raw.prepare(LEVONIS_ADD).run(id, 'u1', 'p1', opt, '[]', color, '', '', qty);

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

test('a different option, colour or shipping method is a DIFFERENT line', () => {
  const raw = db();
  addLevonis(raw, 'ci1', 1, '', '');
  addLevonis(raw, 'ci2', 1, 'opt-a', '');
  addLevonis(raw, 'ci3', 1, '', 'red');
  assert.equal(rows(raw).length, 3);
});

test('a merchant line and a Levonis line for the same shape do not collide', () => {
  // They are different sellers and different products; nothing about one
  // should be able to absorb the other.
  const raw = db();
  addLevonis(raw, 'ci1', 1);
  addMerchant(raw, 'ci2', 1);
  const r = rows(raw);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.seller_type).sort(), ['levonis', 'merchant']);
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
