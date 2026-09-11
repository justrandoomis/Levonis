/**
 * The Community V2 schema, proven against a real SQLite engine.
 *
 * scripts/migrate-check.mjs already proves the migrations APPLY to a fresh
 * database and are idempotent. It cannot prove the two things that actually
 * put existing production data at risk, because it starts from empty:
 *
 *   1. `cart_items` is REBUILT by 0030 (SQLite cannot relax the NOT NULL on
 *      product_id in place, and a merchant line has no `products` row to
 *      point at). A rebuild that silently drops carts would be discovered by
 *      customers, not by CI. So this file fills the table BEFORE 0030 runs
 *      and checks every row is still there, with its values intact, after.
 *
 *   2. The invariants that make the marketplace safe are database
 *      constraints, not route conditions — a mixed cart, an escrow whose
 *      parts do not sum to its total, two winning offers on one request, two
 *      reviews for one transaction. Each is asserted to be REFUSED, so no
 *      future endpoint can reintroduce it by forgetting a check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const MIGRATIONS = join(ROOT, 'migrations');
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

/**
 * Applies migrations numbered in (after, upTo], in order, like D1 does.
 * `after` exists so a test can stop, write rows, and then resume — re-running
 * an already-applied file would fail on "table already exists" and prove
 * nothing about the rebuild.
 */
function applyRange(db: DatabaseSync, after: string, upTo: string): void {
  for (const f of files()) {
    const n = f.slice(0, 4);
    if (n <= after) continue;
    if (n > upTo) break;
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
}

function freshDb(upTo = '9999'): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyRange(db, '0000', upTo);
  return db;
}

/** Asserts the statement is refused by the database itself. */
function refuses(db: DatabaseSync, sql: string, what: string): void {
  assert.throws(() => db.exec(sql), new RegExp('.'), `the database ALLOWED ${what}`);
}

// ---------------------------------------------------------------- the rebuild

test('0030 rebuilds cart_items without losing a single existing row', () => {
  const db = freshDb('0029');

  db.exec(`
    INSERT INTO users (id, name, email, password_hash) VALUES ('u1','Zaid','z@x.co','h');
    INSERT INTO products (id, slug, name, price_iqd) VALUES ('p1','printer','Printer',100);
    INSERT INTO cart_items
      (id, user_id, product_id, option_id, option_value_ids, color_id,
       shipping_method_id, transport_method, warranty_plan_id, qty, created_at)
    VALUES
      ('c1','u1','p1','opt-a','["v1","v2"]','red','ship-1','air','w-24',3,'2026-01-02T03:04:05.000Z');
  `);

  // The dangerous step — resume at 0030, on a database that already has data.
  applyRange(db, '0029', '0030');

  const row = db.prepare('SELECT * FROM cart_items WHERE id = ?').get('c1') as Record<string, unknown>;
  assert.ok(row, 'the pre-existing cart line did not survive the rebuild');

  // Not merely present — unchanged, field by field. A rebuild that kept the
  // row but dropped its variant or quantity is still a lost cart.
  assert.equal(row.user_id, 'u1');
  assert.equal(row.product_id, 'p1');
  assert.equal(row.option_id, 'opt-a');
  assert.equal(row.option_value_ids, '["v1","v2"]');
  assert.equal(row.color_id, 'red');
  assert.equal(row.shipping_method_id, 'ship-1');
  assert.equal(row.transport_method, 'air');
  assert.equal(row.warranty_plan_id, 'w-24');
  assert.equal(row.qty, 3);
  assert.equal(row.created_at, '2026-01-02T03:04:05.000Z', 'created_at was not carried over');

  // And it is correctly labelled as what it always was: a platform line.
  assert.equal(row.seller_type, 'levonis');
  assert.equal(row.merchant_id, null);
  assert.equal(row.store_id, null);
  assert.equal(row.community_product_id, null);
});

test('the rebuilt cart_items still has its lookup index', () => {
  const db = freshDb();
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cart_items'")
    .all()
    .map((r) => (r as { name: string }).name);
  assert.ok(idx.includes('idx_cart_user'), `idx_cart_user missing after rebuild: ${idx.join(', ')}`);
  assert.ok(idx.includes('idx_cart_seller'), 'the seller-scoped index is missing');
});

// ------------------------------------------------------------------ PLUS

test('every PLUS duration is priced, active and therefore purchasable', () => {
  const db = freshDb();
  const rows = db
    .prepare("SELECT id, price_iqd, active FROM membership_plans WHERE tier='plus' ORDER BY duration_months")
    .all() as Array<{ id: string; price_iqd: number | null; active: number }>;

  assert.deepEqual(
    rows.map((r) => [r.id, r.price_iqd, r.active]),
    [
      ['plus_1mo', 4500, 1],
      ['plus_3mo', 10000, 1],
      ['plus_6mo', 17000, 1],
      ['plus_12mo', 29000, 1],
    ],
    'the owner-set PLUS schedule is not what the database holds'
  );
  // A NULL price is what "not purchasable" looks like in this schema — the
  // exact state PLUS was stuck in before. Assert it cannot recur silently.
  assert.equal(rows.filter((r) => r.price_iqd === null).length, 0);
});

test('PRO stays annual-only — the PLUS change did not revive short PRO plans', () => {
  const db = freshDb();
  const pro = db
    .prepare("SELECT id, active FROM membership_plans WHERE tier='pro' AND active=1")
    .all() as Array<{ id: string }>;
  assert.deepEqual(pro.map((r) => r.id), ['pro_12mo']);
});

// ------------------------------------------------------- seeded fixtures

function seedMerchant(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('owner','Ali','ali@x.co','h'), ('buyer','Sara','sara@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name)
      VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,price_iqd)
      VALUES ('cp1','m1','s1','bracket','Bracket',5000);
  `);
}

// -------------------------------------------------------------- cart rules

test('a cart line must be exactly one kind of thing, and name its seller', () => {
  const db = freshDb();
  seedMerchant(db);

  db.exec(
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,qty)
     VALUES ('ok1','buyer','merchant','m1','s1','cp1',1)`
  );

  refuses(
    db,
    `INSERT INTO cart_items (id,user_id,seller_type,community_product_id,qty)
     VALUES ('x1','buyer','merchant','cp1',1)`,
    'a merchant line with no merchant_id'
  );
  refuses(
    db,
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,product_id,qty)
     VALUES ('x2','buyer','merchant','m1','s1','cp1','p1',1)`,
    'a line pointing at both a platform and a merchant product'
  );
  refuses(
    db,
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,qty)
     VALUES ('x3','buyer','levonis','m1',1)`,
    'a platform line carrying a merchant'
  );
});

// ------------------------------------------------------------ escrow money

test('an escrow whose parts do not sum to its total is refused', () => {
  const db = freshDb();
  seedMerchant(db);
  db.exec(`
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','buyer','Print a part');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',50000);
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','buyer','m1',50000,5000,45000);
  `);

  db.exec(
    `INSERT INTO community_escrows
       (id,community_order_id,customer_id,merchant_id,gross_iqd,platform_fee_iqd,merchant_receivable_iqd)
     VALUES ('e1','co1','buyer','m1',50000,5000,45000)`
  );

  refuses(
    db,
    `INSERT INTO community_orders
       (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
     VALUES ('coBad','r1','o1','buyer','m1',50000,5000,44000)`,
    'an order where fee + receivable does not equal the price'
  );

  refuses(
    db,
    `UPDATE community_escrows SET released_iqd = 60000 WHERE id = 'e1'`,
    'releasing more than the escrow ever held'
  );
});

test('one accepted offer means one community order — a retry cannot create a second', () => {
  const db = freshDb();
  seedMerchant(db);
  db.exec(`
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','buyer','Print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',50000);
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','buyer','m1',50000,5000,45000);
  `);
  refuses(
    db,
    `INSERT INTO community_orders
       (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
     VALUES ('co2','r1','o1','buyer','m1',50000,5000,45000)`,
    'a second community order for the same accepted offer'
  );
});

test('a merchant may hold only one live offer per request, but may re-offer after withdrawing', () => {
  const db = freshDb();
  seedMerchant(db);
  db.exec(`
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','buyer','Print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',50000);
  `);

  refuses(
    db,
    `INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o2','r1','m1',40000)`,
    'a second pending offer from the same merchant on the same request'
  );

  // Withdrawal frees the slot — the merchant is not locked out for good.
  db.exec(`UPDATE community_offers SET state='withdrawn' WHERE id='o1'`);
  db.exec(`INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o2','r1','m1',40000)`);
  const live = db
    .prepare("SELECT COUNT(*) c FROM community_offers WHERE request_id='r1' AND state='pending'")
    .get() as { c: number };
  assert.equal(live.c, 1);
});

// ---------------------------------------------------------------- reviews

test('a review needs exactly one completed transaction, and only one review may exist for it', () => {
  const db = freshDb();
  seedMerchant(db);
  db.exec(`
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','buyer','Print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',50000);
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','buyer','m1',50000,5000,45000);
    INSERT INTO merchant_reviews (id,merchant_id,customer_id,community_order_id,rating)
      VALUES ('rv1','m1','buyer','co1',5);
  `);

  refuses(
    db,
    `INSERT INTO merchant_reviews (id,merchant_id,customer_id,community_order_id,rating)
     VALUES ('rv2','m1','buyer','co1',1)`,
    'a second review for the same community order'
  );
  refuses(
    db,
    `INSERT INTO merchant_reviews (id,merchant_id,customer_id,rating) VALUES ('rv3','m1','buyer',5)`,
    'a review attached to no transaction at all'
  );
  refuses(
    db,
    `INSERT INTO merchant_reviews (id,merchant_id,customer_id,order_id,community_order_id,rating)
     VALUES ('rv4','m1','buyer','ORD-1','co1',5)`,
    'a review claiming to belong to two different transactions'
  );
  refuses(
    db,
    `INSERT INTO merchant_reviews (id,merchant_id,customer_id,order_id,rating)
     VALUES ('rv5','m1','buyer','ORD-1',6)`,
    'a rating outside 1..5'
  );
});

// --------------------------------------------------------------- slugs

test('every system subdomain is reserved before any merchant can ask for it', () => {
  const db = freshDb();
  const reserved = new Set(
    (db.prepare('SELECT slug FROM reserved_slugs').all() as Array<{ slug: string }>).map((r) => r.slug)
  );
  // The exact list the mandate names, plus the hosts this platform actually
  // runs on today. `studio` and `mail` are live services: handing either to a
  // merchant would take down a running product.
  for (const s of [
    'www', 'api', 'admin', 'studio', 'mail', 'support', 'cdn', 'assets', 'static',
    'auth', 'account', 'community', 'shop', 'store', 'app', 'dashboard', 'status',
    'help', 'billing', 'checkout',
  ]) {
    assert.ok(reserved.has(s), `"${s}" is claimable by a merchant`);
  }
});
