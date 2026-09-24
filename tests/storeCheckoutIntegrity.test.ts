/**
 * THE COMMUNITY-STORE CHECKOUT, HELD TO WHAT IT CHARGES — wave 1 of the
 * merchant platform (docs/MERCHANT_PLATFORM.md), audit 02 findings pinned
 * against the real routes and every migration.
 *
 *   B1   GET /api/cart answered `scope: null` for a store-only cart, so the
 *        store checkout could not be reached from the cart page;
 *   B5   stock was checked per LINE and the decrement was a silent no-op:
 *        two colours of a one-unit product both sold, and a unit taken by a
 *        concurrent order still shipped;
 *   B6   a single-use coupon was redeemed twice under concurrency;
 *   B8   a two-store cart settled entirely to the first store;
 *   B11  a lapsed, restricted or not-selling merchant still took orders;
 *   B12  place-order re-priced silently after the quote;
 *   B16  option/colour text a client typed reached the merchant's order;
 *   B17  a merchant could buy from their own store;
 *   B18  the customer received the commission split and the raw order row;
 *   B21  checkout emptied Levonis lines it never priced;
 *   B22  free delivery was judged before the coupon;
 *   B4   the delivery fee was charged and credited to nobody;
 *   B24  the store debit recorded no dinars;
 *   B25  a hidden product read as available in the cart;
 *   B13  an abandoned checkout's wallet hold stayed active for ever.
 *
 * Run: node --import tsx --test tests/storeCheckoutIntegrity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb, asD1, failingD1, stubApp, post, get, patch, json, count, row, all, holds, spendable, pending,
} from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { releaseOrphanStoreHolds, STORE_HOLD_TTL_MINUTES } from '../worker/lib/storeOrderOps';
import type { Env } from '../worker/lib/types';

/** 100,000 cents at 1,400 IQD/USD — 1,400,000 IQD of spendable balance. */
const DEP = 100_000;
const FUTURE = '2099-01-01T00:00:00.000Z';

function seed(raw: DatabaseSync, opts: { aliDelivery?: string; aliPlus?: boolean; aliTier?: string } = {}) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('ali','Ali','ali@x.co','h','merchant'),
      ('zain','Zain','zain@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES
      ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','${opts.aliDelivery ?? '{}'}'),
      ('s_zain','m_zain','zain','zainprint','Zain Print','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,options,colors) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0,
        '[{"id":"opt_l","name":"كبير"},"صغير"]','["أحمر",{"id":"c_blue","label":"أزرق"}]'),
      ('cp_ltd','m_ali','s_ali','ali-ltd','Ali limited','active','active',14000,1,1,'["red","blue"]','[]'),
      ('cp_zain','m_zain','s_zain','zain-spool','Zain spool','active','active',9000,100,0,'[]','[]');
    INSERT INTO products (id,slug,name,price_iqd,status,stock) VALUES ('p_levo','levo-nozzle','Levonis nozzle',5000,'active',50);
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES
      ('a1','buyer','Sara','+964770','Street 1','basra'),
      ('a_ali','ali','Ali','+964771','Street 2','baghdad');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES
      ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed'),
      ('dep_ali','ali','deposit','USD',${DEP},'approved','seed');
  `);
  // The store entitlement belongs to the OWNER (PLUS, PREMIUM or PRO).
  if (opts.aliPlus !== false) {
    raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
              VALUES ('mem_ali','ali','plus_12mo','${opts.aliTier ?? 'plus'}','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}')`);
  }
  raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
            VALUES ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}')`);
}

const buyerApp = (db: D1Database, id = 'buyer') =>
  stubApp(db, { id, role: id === 'buyer' ? 'customer' : 'merchant', email: `${id}@x.co` }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
  });
type App = ReturnType<typeof buyerApp>;

const addM = (app: App, productId: string, body: object = {}) =>
  post(app, '/api/cart/merchant-items', { productId, qty: 1, ...body });
const quote = async (app: App, body: object = {}) => json(await post(app, '/api/store-orders/quote', body));
/** Quote, then place with the fingerprint that quote returned — what the checkout page does. */
async function place(app: App, key: string, body: Record<string, unknown> = {}) {
  const q = await quote(app, typeof body.couponCode === 'string' ? { couponCode: body.couponCode } : {});
  const res = await post(app, '/api/store-orders', {
    idempotencyKey: key,
    addressId: 'a1',
    quoteFingerprint: q.quote?.quote_fingerprint,
    ...body,
  });
  return { res, body: await json(res), quote: q };
}

let lineClock = 0;
/** A cart line written straight into the table — the state an older build, or the race 0114 closes, left behind. */
function rawLine(raw: DatabaseSync, id: string, merchant: string, store: string, product: string, extra: { qty?: number; option?: string; color?: string; user?: string } = {}) {
  lineClock += 1;
  raw.prepare(
    `INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,option_id,color_id,qty,created_at)
     VALUES (?,?,'merchant',?,?,?,?,?,?,?)`
  ).run(
    id, extra.user ?? 'buyer', merchant, store, product, extra.option ?? '', extra.color ?? '', extra.qty ?? 1,
    new Date(Date.UTC(2026, 0, 1) + lineClock * 1000).toISOString()
  );
}
/** A cart the 0114 guard would refuse — only for asserting what the checkout does with one. */
const withoutSellerGuard = (raw: DatabaseSync) =>
  raw.exec('DROP TRIGGER trg_cart_items_one_seller_insert; DROP TRIGGER trg_cart_items_one_seller_update;');

const orders = (raw: DatabaseSync) => count(raw, 'SELECT COUNT(*) n FROM orders');
const stockOf = (raw: DatabaseSync, id: string) =>
  row<{ stock: number; sold_count: number }>(raw, 'SELECT stock, sold_count FROM community_products WHERE id = ?', id)!;

// =========================================================================== B1

test('B1 GET /api/cart names a store-only cart as the store’s, and counts its units for the badge', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  assert.equal((await addM(app, 'cp_ali', { qty: 2 })).status, 201);

  const cart = await json(await get(app, '/api/cart'));
  assert.equal(cart.success, true, JSON.stringify(cart));
  assert.deepEqual(cart.scope, { seller_type: 'merchant', merchant_id: 'm_ali', store_id: 's_ali' },
    'Cart.tsx renders the store cart — and its link to /store-checkout — only on this scope');
  assert.deepEqual(cart.items, [], 'the platform half stays the platform half');
  assert.equal(cart.item_count, 2, 'the badge counts the store’s units, not zero');
});

// =========================================================================== B5

test('B5 the add door judges stock over every line of the product, not the line alone', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  assert.equal((await addM(app, 'cp_ltd', { optionId: 'red' })).status, 201);
  const second = await addM(app, 'cp_ltd', { optionId: 'blue' });
  const body = await json(second);
  assert.equal(second.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.equal(body.details.available, 0, 'the one unit is already in the cart');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE user_id='buyer'"), 1);
});

test('B5 the checkout sums a product’s option lines before judging stock', async () => {
  const raw = freshDb();
  seed(raw);
  // Two colours of a product with ONE unit, as a cart built before this fix holds them.
  rawLine(raw, 'ci_r', 'm_ali', 's_ali', 'cp_ltd', { option: 'red' });
  rawLine(raw, 'ci_bb', 'm_ali', 's_ali', 'cp_ltd', { option: 'blue' });
  const app = buyerApp(asD1(raw));

  const q = await quote(app);
  assert.equal(q.code, 'OUT_OF_STOCK', JSON.stringify(q));
  assert.equal(q.details.product_id, 'cp_ltd');
  assert.equal(q.details.available, 1);
  const placed = await post(app, '/api/store-orders', { idempotencyKey: 'b5-key-0001', addressId: 'a1', quoteFingerprint: 'x' });
  assert.equal(placed.status, 409);
  assert.equal(orders(raw), 0, 'two units were never sold from one');
  assert.deepEqual(stockOf(raw, 'cp_ltd'), { stock: 1, sold_count: 0 });
});

test('B5 a unit taken by a concurrent order ABORTS this order — no order, no debit, no credit (409 OUT_OF_STOCK)', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);
  assert.equal((await addM(app, 'cp_ltd')).status, 201);
  const q = await quote(app);
  failing.beforeBatch = (stmts) => {
    // Another customer bought the last unit between this checkout's read and its batch.
    if (stmts.some((s) => /INSERT INTO orders/.test(s.sql))) raw.exec("UPDATE community_products SET stock = 0 WHERE id = 'cp_ltd'");
  };
  const res = await post(app, '/api/store-orders', { idempotencyKey: 'b5-race-0001', addressId: 'a1', quoteFingerprint: q.quote.quote_fingerprint });
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.equal(body.details.product_id, 'cp_ltd');
  assert.equal(body.details.available, 0);
  assert.equal(orders(raw), 0, 'the order did not commit');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_ledger_entries'), 0, 'no merchant credit');
  assert.equal(stockOf(raw, 'cp_ltd').sold_count, 0, 'nothing was sold');
  // The refusal is FINAL for this attempt: the customer's remedy changes the
  // cart, and with it the quote and the checkout key (B12). The reservation is
  // handed back at once instead of sitting unspendable until the orphan sweep.
  assert.equal(holds(raw, 'buyer')[0].state, 'released', 'never committed, and not left holding the money');
  assert.equal(spendable(raw, 'buyer'), DEP, 'the money is spendable again');
  await Promise.allSettled(pending);
});

// =========================================================================== B6

test('B6 a single-use coupon spent by a concurrent order ABORTS this order (409 COUPON_EXHAUSTED)', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,max_uses,used_count) VALUES ('mc1','s_ali','m_ali','ONCE','fixed_iqd',4000,1,0)`);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);
  await addM(app, 'cp_ali');
  const q = await quote(app, { couponCode: 'ONCE' });
  assert.equal(q.quote.discount_iqd, 4000);
  failing.beforeBatch = (stmts) => {
    if (stmts.some((s) => /INSERT INTO orders/.test(s.sql))) raw.exec("UPDATE merchant_coupons SET used_count = 1 WHERE id = 'mc1'");
  };
  const res = await post(app, '/api/store-orders', {
    idempotencyKey: 'b6-key-0001', addressId: 'a1', couponCode: 'ONCE', quoteFingerprint: q.quote.quote_fingerprint,
  });
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'COUPON_EXHAUSTED');
  assert.equal(orders(raw), 0);
  assert.equal(row<{ used_count: number }>(raw, "SELECT used_count FROM merchant_coupons WHERE id='mc1'")!.used_count, 1, 'used once, by the other order');
  assert.equal(spendable(raw, 'buyer'), DEP, 'the refused attempt holds nothing back');

  // The customer removes the coupon: a new quote, a new fingerprint, a NEW
  // key — and the corrected order goes through on a single reservation.
  failing.beforeBatch = null;
  const { res: again, body: placed } = await place(app, 'b6-key-0002');
  assert.equal(again.status, 201, JSON.stringify(placed));
  assert.deepEqual(holds(raw, 'buyer').map((h) => h.state).sort(), ['committed', 'released']);
  assert.equal(spendable(raw, 'buyer'), DEP - 1000, 'charged once, for the order that exists');
  await Promise.allSettled(pending);
});

test('B6 the coupon counter moves with the order when the cap has room', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,max_uses,used_count) VALUES ('mc1','s_ali','m_ali','ONCE','fixed_iqd',4000,1,0)`);
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  const { res, body } = await place(app, 'b6-ok-00001', { couponCode: 'ONCE' });
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.order.coupon_discount_iqd, 4000);
  assert.equal(row<{ used_count: number }>(raw, "SELECT used_count FROM merchant_coupons WHERE id='mc1'")!.used_count, 1);
  await Promise.allSettled(pending);
});

// ====================================================================== B8, B21

test('B8 a cart spanning two stores is refused at checkout — nothing is billed to the first store', async () => {
  const raw = freshDb();
  seed(raw);
  withoutSellerGuard(raw);
  rawLine(raw, 'ci1', 'm_ali', 's_ali', 'cp_ali');
  rawLine(raw, 'ci22', 'm_zain', 's_zain', 'cp_zain');
  const app = buyerApp(asD1(raw));
  const q = await quote(app);
  assert.equal(q.code, 'CART_SELLER_CONFLICT', JSON.stringify(q));
  const res = await post(app, '/api/store-orders', { idempotencyKey: 'b8-key-0001', addressId: 'a1', quoteFingerprint: 'x' });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'CART_SELLER_CONFLICT');
  assert.equal(orders(raw), 0);
  assert.equal(stockOf(raw, 'cp_zain').sold_count, 0, 'the second store’s product is untouched');
});

test('B21 checkout removes only the lines it priced — a Levonis line in a legacy cart survives it', async () => {
  const raw = freshDb();
  seed(raw);
  withoutSellerGuard(raw);
  rawLine(raw, 'ci1', 'm_ali', 's_ali', 'cp_ali');
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,qty) VALUES ('ci_levo','buyer','p_levo',1)`);
  const app = buyerApp(asD1(raw));
  const { res, body } = await place(app, 'b21-key-0001');
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE id='ci_levo'"), 1, 'never priced, never deleted');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE id='ci1'"), 0, 'the priced line went with the order');
  await Promise.allSettled(pending);
});

// ========================================================================== B11

for (const [label, setup] of [
  ['an owner with no store entitlement (PLUS lapsed)', (raw: DatabaseSync) => raw.exec("UPDATE memberships SET state = 'expired' WHERE user_id = 'ali'")],
  ['a restricted merchant', (raw: DatabaseSync) => raw.exec("UPDATE community_merchants SET status = 'restricted' WHERE id = 'm_ali'")],
  ['a store that switched off direct products', (raw: DatabaseSync) => raw.exec("UPDATE merchant_stores SET sells_direct_products = 0 WHERE id = 's_ali'")],
  ['a paused store', (raw: DatabaseSync) => raw.exec("UPDATE merchant_stores SET status = 'paused' WHERE id = 's_ali'")],
] as const) {
  test(`B11 ${label} takes no new order — refused at the add door AND at checkout`, async () => {
    const raw = freshDb();
    seed(raw);
    rawLine(raw, 'ci_old', 'm_ali', 's_ali', 'cp_ali'); // added while the store could still sell
    setup(raw);
    const app = buyerApp(asD1(raw));

    const add = await addM(app, 'cp_ali');
    assert.equal(add.status, 400);
    assert.equal((await json(add)).code, 'STORE_CLOSED');

    const q = await quote(app);
    assert.equal(q.code, 'STORE_CLOSED', JSON.stringify(q));
    const res = await post(app, '/api/store-orders', { idempotencyKey: 'b11-key-0001', addressId: 'a1', quoteFingerprint: 'x' });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'STORE_CLOSED');
    assert.equal(orders(raw), 0);

    const cart = await json(await get(app, '/api/cart/merchant'));
    assert.equal(cart.items[0].available, false, 'the cart says so before the checkout does');
    assert.equal(cart.items[0].unavailable_reason, 'store_closed');
  });
}

test('B11 a PREMIUM owner’s store sells (owner decision: PREMIUM includes the store entitlement)', async () => {
  const raw = freshDb();
  seed(raw, { aliTier: 'prime' });
  const app = buyerApp(asD1(raw));
  assert.equal((await addM(app, 'cp_ali')).status, 201);
  const { res, body } = await place(app, 'b11-prime-001');
  assert.equal(res.status, 201, JSON.stringify(body));
  await Promise.allSettled(pending);
});

// ========================================================================== B12

test('B12 place-order refuses a total that moved after the quote, with the fresh quote, and charges nothing', async () => {
  const raw = freshDb();
  seed(raw, { aliDelivery: '{"fee_iqd":5000}' });
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  const q1 = (await quote(app)).quote;
  assert.equal(q1.total_iqd, 19000);
  assert.equal(q1.expected_total_iqd, 19000);

  // The merchant raises the delivery fee while the customer looks at 19,000.
  raw.exec(`UPDATE merchant_stores SET delivery_settings = '{"fee_iqd":25000}' WHERE id = 's_ali'`);
  const stale = await post(app, '/api/store-orders', { idempotencyKey: 'b12-key-0001', addressId: 'a1', quoteFingerprint: q1.quote_fingerprint });
  const body = await json(stale);
  assert.equal(stale.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'QUOTE_CHANGED');
  assert.equal(body.details.quote.total_iqd, 39000, 'the refusal carries the new total to show');
  assert.notEqual(body.details.quote.quote_fingerprint, q1.quote_fingerprint);
  assert.equal(orders(raw), 0);
  assert.equal(holds(raw, 'buyer').length, 0, 'not even a reservation');

  // Confirming the new quote (with a new key, as the page mints one) places it.
  const again = await post(app, '/api/store-orders', {
    idempotencyKey: 'b12-key-0002', addressId: 'a1', quoteFingerprint: body.details.quote.quote_fingerprint,
  });
  const placed = await json(again);
  assert.equal(again.status, 201, JSON.stringify(placed));
  assert.equal(placed.order.total_iqd, 39000);
  await Promise.allSettled(pending);
});

test('B12 an order with no confirmed quote at all is answered with the quote to confirm', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  const res = await post(app, '/api/store-orders', { idempotencyKey: 'b12-none-001', addressId: 'a1' });
  const body = await json(res);
  assert.equal(res.status, 409);
  assert.equal(body.code, 'QUOTE_CHANGED');
  assert.equal(body.details.quote.total_iqd, 14000);
  assert.equal(orders(raw), 0);
});

test('B12 the same checkout key sent again with a different total is 409 IDEMPOTENCY_KEY_REUSED, not a wallet error', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);
  await addM(app, 'cp_ali');
  const q = (await quote(app)).quote;
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO orders/.test(s.sql));
  const first = await post(app, '/api/store-orders', { idempotencyKey: 'b12-reuse-01', addressId: 'a1', quoteFingerprint: q.quote_fingerprint });
  assert.equal(first.status, 500, 'a transient failure — the hold survives for the retry');
  failing.failWhen = null;
  const lineId = row<{ id: string }>(raw, "SELECT id FROM cart_items WHERE user_id='buyer'")!.id;
  assert.equal((await patch(app, `/api/cart/merchant-items/${lineId}`, { qty: 2 })).status, 200);
  const q2 = (await quote(app)).quote;
  const retry = await post(app, '/api/store-orders', { idempotencyKey: 'b12-reuse-01', addressId: 'a1', quoteFingerprint: q2.quote_fingerprint });
  const body = await json(retry);
  assert.equal(retry.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'IDEMPOTENCY_KEY_REUSED');
  await Promise.allSettled(pending);
});

// ========================================================================== B16

test('B16 an option or colour must be one the merchant put on the product; the order records the merchant’s word', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  const junk = await addM(app, 'cp_ali', { optionId: 'GOLD PLATED (paid +20000)' });
  assert.equal(junk.status, 400);
  assert.equal((await json(junk)).code, 'OPTION_INVALID');
  const junkColor = await addM(app, 'cp_ali', { colorId: '<b>x</b>' });
  assert.equal((await json(junkColor)).code, 'COLOR_INVALID');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM cart_items WHERE user_id='buyer'"), 0);

  assert.equal((await addM(app, 'cp_ali', { optionId: 'opt_l', colorId: 'c_blue' })).status, 201);
  const { res, body } = await place(app, 'b16-key-0001');
  assert.equal(res.status, 201, JSON.stringify(body));
  const snap = row<{ option_snapshot: string }>(raw, 'SELECT option_snapshot FROM order_items WHERE order_id = ?', body.order.id)!;
  assert.equal(snap.option_snapshot, 'كبير / أزرق', 'the merchant’s names, never ids or client text');
  await Promise.allSettled(pending);
});

test('B16 a legacy cart line naming an option the product does not offer is refused at checkout', async () => {
  const raw = freshDb();
  seed(raw);
  rawLine(raw, 'ci_junk', 'm_ali', 's_ali', 'cp_ali', { option: 'NOT-AN-OPTION' });
  const app = buyerApp(asD1(raw));
  const q = await quote(app);
  assert.equal(q.code, 'OPTION_UNAVAILABLE', JSON.stringify(q));
  assert.equal(q.details.which, 'option');
  const cart = await json(await get(app, '/api/cart/merchant'));
  assert.equal(cart.items[0].unavailable_reason, 'option_gone');
});

// ========================================================================== B17

test('B17 a merchant cannot buy from their own store — at the add door or at checkout', async () => {
  const raw = freshDb();
  seed(raw);
  const own = buyerApp(asD1(raw), 'ali');
  const add = await addM(own, 'cp_ali');
  assert.equal(add.status, 403);
  assert.equal((await json(add)).code, 'OWN_STORE_PURCHASE');

  rawLine(raw, 'ci_self', 'm_ali', 's_ali', 'cp_ali', { user: 'ali' });
  const res = await post(own, '/api/store-orders', { idempotencyKey: 'b17-key-0001', addressId: 'a_ali', quoteFingerprint: 'x' });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'OWN_STORE_PURCHASE');
  assert.equal(orders(raw), 0);
});

// ========================================================================== B18

const PRIVATE = ['platform_fee_iqd', 'merchant_receivable_iqd', 'commission_percent_x100', 'admin_note', 'client_idempotency_key', 'idempotency_key'];

test('B18 the customer’s quote, order and replay carry no commission split and no admin note', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  const q = (await quote(app)).quote;
  for (const k of PRIVATE) assert.equal(k in q, false, `quote leaks ${k}`);

  const { res, body } = await place(app, 'b18-key-0001');
  assert.equal(res.status, 201, JSON.stringify(body));
  for (const k of PRIVATE) assert.equal(k in body.order, false, `order leaks ${k}`);
  assert.equal(body.order.payment_method_id, 'wallet');
  assert.equal(body.order.store_name, 'Ali 3D');

  const replay = await json(await post(app, '/api/store-orders', { idempotencyKey: 'b18-key-0001', addressId: 'a1' }));
  assert.equal(replay.replay, true);
  for (const k of PRIVATE) assert.equal(k in replay.order, false, `replay leaks ${k}`);
  await Promise.allSettled(pending);
});

// ====================================================================== B22, B4

test('B22 free delivery is judged on what the customer pays for the goods — after the coupon', async () => {
  const raw = freshDb();
  seed(raw, { aliDelivery: '{"fee_iqd":5000,"free_over_iqd":14000}' });
  raw.exec(`INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,min_total_iqd) VALUES ('mc3','s_ali','m_ali','HALF','percent',50,14000)`);
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  // The coupon's own minimum is judged BEFORE its discount (it cannot include itself).
  const q = (await quote(app, { couponCode: 'HALF' })).quote;
  assert.equal(q.discount_iqd, 7000, 'a 14,000 cart meets the 14,000 minimum');
  assert.equal(q.delivery_iqd, 5000, 'the customer pays 7,000 for goods — below the 14,000 free-over');
  assert.equal(q.total_iqd, 12000);
  // Without the coupon, the goods are 14,000 and delivery is free.
  assert.equal((await quote(app)).quote.delivery_iqd, 0);
});

test('B4 the merchant is credited their delivery fee; commission is on the goods only; fee + receivable = total', async () => {
  const raw = freshDb();
  seed(raw, { aliDelivery: '{"fee_iqd":5000}' });
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  const { res, body } = await place(app, 'b4-key-00001');
  assert.equal(res.status, 201, JSON.stringify(body));
  const o = row<{ total_iqd: number; platform_fee_iqd: number; merchant_receivable_iqd: number; shipping_iqd: number }>(
    raw, 'SELECT total_iqd, platform_fee_iqd, merchant_receivable_iqd, shipping_iqd FROM orders WHERE id = ?', body.order.id
  )!;
  assert.equal(o.total_iqd, 19000);
  assert.equal(o.shipping_iqd, 5000);
  assert.equal(o.platform_fee_iqd, 700, '5% of the 14,000 goods — never of the delivery');
  assert.equal(o.merchant_receivable_iqd, 18300, '13,300 for the goods + the 5,000 delivery');
  assert.equal(o.platform_fee_iqd + o.merchant_receivable_iqd, o.total_iqd, 'no dinar in nobody’s books');
  // Three lines of their own in the merchant ledger (migration 0121), pending, summing to the receivable.
  const lines = all<{ kind: string; bucket: string; amount_iqd: number }>(raw,
    'SELECT kind, bucket, amount_iqd FROM merchant_ledger_entries WHERE order_id = ? ORDER BY kind', body.order.id);
  assert.deepEqual(lines, [
    { kind: 'commission', bucket: 'pending', amount_iqd: -700 },
    { kind: 'delivery_fee', bucket: 'pending', amount_iqd: 5000 },
    { kind: 'sale_gross', bucket: 'pending', amount_iqd: 14000 },
  ]);
  assert.equal(lines.reduce((a, l) => a + l.amount_iqd, 0), 18300);
  await Promise.allSettled(pending);
});

// ========================================================================== B24

test('B24 the store debit records the dinars it spent, beside the rate — as the platform checkout’s does', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  const { res, body } = await place(app, 'b24-key-0001');
  assert.equal(res.status, 201, JSON.stringify(body));
  const debit = row<{ amount: number; amount_iqd: number | null; exchange_rate_snapshot: number | null }>(
    raw, "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE ref = ? AND type = 'withdrawal'", body.order.id
  )!;
  assert.deepEqual(debit, { amount: 1000, amount_iqd: 14000, exchange_rate_snapshot: 1400 });
  await Promise.allSettled(pending);
});

// ========================================================================== B25

test('B25 a hidden product reads as unavailable in the cart, with its reason', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addM(app, 'cp_ali');
  raw.exec("UPDATE community_products SET status = 'hidden' WHERE id = 'cp_ali'");
  const cart = await json(await get(app, '/api/cart/merchant'));
  assert.equal(cart.items[0].available, false);
  assert.equal(cart.items[0].unavailable_reason, 'unavailable');
  const q = await quote(app);
  assert.equal(q.code, 'PRODUCT_UNAVAILABLE');
});

// ========================================================================== B13

test('B13 an abandoned checkout’s wallet hold is handed back after its TTL — and never one that became an order', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);
  await addM(app, 'cp_ali');
  const q = (await quote(app)).quote;
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO orders/.test(s.sql));
  assert.equal((await post(app, '/api/store-orders', { idempotencyKey: 'b13-lost-001', addressId: 'a1', quoteFingerprint: q.quote_fingerprint })).status, 500);
  failing.failWhen = null;
  // A second checkout that DID become an order.
  const placed = await post(app, '/api/store-orders', { idempotencyKey: 'b13-good-001', addressId: 'a1', quoteFingerprint: q.quote_fingerprint });
  assert.equal(placed.status, 201);
  assert.equal(spendable(raw, 'buyer'), DEP - 1000 - 1000, 'one debit, one orphaned reservation');

  const env = { DB: asD1(raw) } as unknown as Env;
  const early = await releaseOrphanStoreHolds(env, new Date().toISOString());
  assert.equal(early.holds_released, 0, 'not before its TTL — a same-key retry may still come');

  const later = new Date(Date.now() + (STORE_HOLD_TTL_MINUTES + 1) * 60_000).toISOString();
  const swept = await releaseOrphanStoreHolds(env, later);
  assert.equal(swept.holds_released, 1);
  assert.equal(spendable(raw, 'buyer'), DEP - 1000, 'the reserved money is spendable again');
  const states = holds(raw, 'buyer').map((h) => h.state).sort();
  assert.deepEqual(states, ['committed', 'released'], 'the settled hold was never touched');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'wallet.store_hold_released'"), 1);
  assert.equal((await releaseOrphanStoreHolds(env, later)).holds_released, 0, 'idempotent');

  // The key whose hold was handed back is spent: the checkout is told to start again.
  await addM(app, 'cp_ali');
  const q2 = (await quote(app)).quote;
  const retry = await post(app, '/api/store-orders', { idempotencyKey: 'b13-lost-001', addressId: 'a1', quoteFingerprint: q2.quote_fingerprint });
  assert.equal((await json(retry)).code, 'IDEMPOTENCY_KEY_REUSED');
  await Promise.allSettled(pending);
});

test('B13 the release is fenced on the order: an active hold whose key already has an order is not handed back', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`
    INSERT INTO wallet_holds (id,user_id,kind,amount_cents,state,event_key,ref_type,ref_id,created_at,updated_at)
      VALUES ('wh1','buyer','purchase',1000,'active','store-order:buyer:k-000001','store_order','buyer:k-000001','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,client_idempotency_key,seller_type,merchant_id,store_id)
      VALUES ('ORD-K1','buyer','pending','{}','merchant','{}','wallet',14000,1400,14000,0,'k-000001','merchant','m_ali','s_ali');
  `);
  const res = await releaseOrphanStoreHolds({ DB: asD1(raw) } as unknown as Env, new Date().toISOString());
  assert.equal(res.holds_released, 0);
  assert.equal(holds(raw, 'buyer')[0].state, 'active');
});
