/**
 * ONE CART, ONE SELLER — NOW THE DATABASE'S RULE TOO (docs/MERCHANT_PLATFORM.md
 * §2 decision 1; audit 02 B8, B15).
 *
 *   · Migration 0114's trigger refuses a second seller's line in one user's
 *     cart, whatever door writes it and however two requests interleave. The
 *     add doors read-then-insert, so two adds from two tabs could both pass
 *     their read — and the checkout then billed one store for another's goods.
 *   · Both add doors map the trigger's refusal to the SAME 400
 *     CART_SELLER_CONFLICT (both shops named) that their own check answers.
 *   · «Empty the cart and shop here» runs in the SAME batch as the add: a
 *     refused or failed add leaves the old cart exactly as it was (B15).
 *
 * tests/cartSeller.test.ts pins the other half: two DIFFERENT users holding
 * different sellers' carts is the ordinary state of the table.
 *
 * Run: node --import tsx --test tests/cartSellerGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, json, count } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';

const FUTURE = '2099-01-01T00:00:00.000Z';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('other','Omar','other@x.co','h','customer'),
      ('ali','Ali','ali@x.co','h','merchant'),
      ('zain','Zain','zain@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES
      ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active'), ('s_zain','m_zain','zain','zainprint','Zain Print','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0),
      ('cp_ali2','m_ali','s_ali','ali-nozzle','Ali nozzle','active','active',3000,100,0),
      ('cp_ltd','m_ali','s_ali','ali-ltd','Ali limited','active','active',14000,1,1),
      ('cp_zain','m_zain','s_zain','zain-spool','Zain spool','active','active',9000,100,0);
    INSERT INTO products (id,slug,name,price_iqd,status,stock) VALUES ('p_levo','levo-nozzle','Levonis nozzle',5000,'active',50);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
}

const merchantLine = (raw: DatabaseSync, id: string, user: string, merchant: string, store: string, product: string) =>
  raw.prepare(
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,qty) VALUES (?,?,'merchant',?,?,?,1)`
  ).run(id, user, merchant, store, product);
const levonisLine = (raw: DatabaseSync, id: string, user: string) =>
  raw.prepare(`INSERT INTO cart_items (id,user_id,product_id,qty) VALUES (?,?,'p_levo',1)`).run(id, user);
const lines = (raw: DatabaseSync) =>
  (raw.prepare("SELECT id FROM cart_items WHERE user_id = 'buyer' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);

const buyerApp = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/cart', cartRoutes));

// ================================================================ the trigger

test('0114: the database refuses a second seller in one user’s cart — Levonis × store, store × store', () => {
  const raw = freshDb();
  seed(raw);
  levonisLine(raw, 'l1', 'buyer');
  assert.throws(() => merchantLine(raw, 'm1', 'buyer', 'm_ali', 's_ali', 'cp_ali'), /CART_SELLER_CONFLICT/);

  merchantLine(raw, 'm2', 'other', 'm_ali', 's_ali', 'cp_ali');
  merchantLine(raw, 'm3', 'other', 'm_ali', 's_ali', 'cp_ali2'); // the same store again: fine
  assert.throws(() => merchantLine(raw, 'm4', 'other', 'm_zain', 's_zain', 'cp_zain'), /CART_SELLER_CONFLICT/);
  assert.throws(() => levonisLine(raw, 'l2', 'other'), /CART_SELLER_CONFLICT/);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM cart_items'), 3);
});

test('0114: re-pointing a line at another seller is refused; quantity and option edits never are', () => {
  const raw = freshDb();
  seed(raw);
  merchantLine(raw, 'm1', 'buyer', 'm_ali', 's_ali', 'cp_ali');
  merchantLine(raw, 'm2', 'buyer', 'm_ali', 's_ali', 'cp_ali2');
  assert.throws(
    () => raw.exec("UPDATE cart_items SET merchant_id = 'm_zain', store_id = 's_zain', community_product_id = 'cp_zain' WHERE id = 'm2'"),
    /CART_SELLER_CONFLICT/
  );
  raw.exec("UPDATE cart_items SET qty = 3 WHERE id = 'm1'");
  raw.exec("UPDATE cart_items SET option_id = 'x' WHERE id = 'm1'");
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE qty = 3 AND option_id = 'x'"), 1);
});

// ============================================================= the two doors

test('B8 the store add door, raced by a Levonis add from another tab, answers the same named 400', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO cart_items/.test(s.sql))) levonisLine(raw, 'l_race', 'buyer');
  };
  const res = await post(buyerApp(db), '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'CART_SELLER_CONFLICT');
  assert.equal(body.details.cart_seller_name, 'LEVONIS');
  assert.equal(body.details.incoming_seller_name, 'Ali 3D');
  assert.deepEqual(lines(raw), ['l_race'], 'the cart holds one seller');
});

test('B8 the Levonis add door, raced by a store add from another tab, answers the same named 400', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO cart_items/.test(s.sql))) merchantLine(raw, 'm_race', 'buyer', 'm_zain', 's_zain', 'cp_zain');
  };
  const res = await post(buyerApp(db), '/api/cart/items', { productId: 'p_levo', qty: 1 });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'CART_SELLER_CONFLICT');
  assert.equal(body.details.cart_seller_name, 'Zain Print');
  assert.equal(body.details.incoming_seller_name, 'LEVONIS');
  assert.deepEqual(lines(raw), ['m_race']);
});

// ==================================================================== B15

test('B15 «empty the cart and shop here» is validated FIRST — a refused add leaves the old cart as it was', async () => {
  const raw = freshDb();
  seed(raw);
  merchantLine(raw, 'z1', 'buyer', 'm_zain', 's_zain', 'cp_zain');
  const res = await post(buyerApp(asD1(raw)), '/api/cart/merchant-items', { productId: 'cp_ltd', qty: 2, replaceCart: true });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.deepEqual(lines(raw), ['z1'], 'the customer’s cart was not thrown away for an add that was refused');
});

test('B15 the store door empties and adds in ONE batch — a failed write empties nothing', async () => {
  const raw = freshDb();
  seed(raw);
  merchantLine(raw, 'z1', 'buyer', 'm_zain', 's_zain', 'cp_zain');
  const { failing, db } = failingD1(raw);
  failing.failWhen = (stmts) => stmts.some((s) => /DELETE FROM cart_items/.test(s.sql));
  const res = await post(buyerApp(db), '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1, replaceCart: true });
  assert.equal(res.status, 500);
  assert.deepEqual(lines(raw), ['z1']);

  failing.failWhen = null;
  const ok = await json(await post(buyerApp(db), '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1, replaceCart: true }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE user_id = 'buyer' AND merchant_id = 'm_ali'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE user_id = 'buyer' AND merchant_id = 'm_zain'"), 0);
});

test('B15 the Levonis door empties and adds in ONE batch too', async () => {
  const raw = freshDb();
  seed(raw);
  merchantLine(raw, 'a1', 'buyer', 'm_ali', 's_ali', 'cp_ali');
  const { failing, db } = failingD1(raw);
  failing.failWhen = (stmts) => stmts.some((s) => /DELETE FROM cart_items/.test(s.sql));
  const failed = await post(buyerApp(db), '/api/cart/items', { productId: 'p_levo', qty: 1, replaceCart: true });
  assert.equal(failed.status, 500);
  assert.deepEqual(lines(raw), ['a1'], 'a failed add leaves the store cart standing');

  failing.failWhen = null;
  const ok = await json(await post(buyerApp(db), '/api/cart/items', { productId: 'p_levo', qty: 1, replaceCart: true }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE user_id = 'buyer' AND seller_type = 'merchant'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE user_id = 'buyer' AND product_id = 'p_levo'"), 1);
});
