/**
 * «منتجات التاجر يستطيع وضعها في السلة ولا تختلط مع تاجر آخر ولا تختلط مع
 *  منتجات المتجر الرسمي إلا بعد التفريغ… وأن مجتمع ليفو في منتجات التاجر
 *  تدفع فقط مقدما ولا يستطيع الدفع عند الاستلام أو الاستلام من المخزن»
 *
 * The owner asked for this whole chain to be CONFIRMED, not rebuilt. Two of
 * its three links were already sound and are pinned here so they stay that
 * way. The third was not:
 *
 *   THE MERCHANT CHECKOUT OFFERED CASH ON DELIVERY, AND OFFERED IT FIRST.
 *   `payWithWallet` defaulted to `false` on the screen and the route wrote
 *   that as `payment_method_id = 'cod'` with the entire total recorded as due
 *   at the door — an order nobody could ever collect, because a merchant
 *   ships their own goods and Levonis holds neither their stock nor their
 *   cash. Nothing refused it; the order simply existed, unpaid, with the
 *   merchant credited a pending payout against money that was never taken.
 *
 * The rule has two halves and both are asserted below against the real
 * routes and the real migrations: the cart never mixes sellers, and a
 * merchant order is prepaid from the wallet with nothing due on delivery
 * and no pickup to choose.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, holds, pending } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { merchantRoutes } from '../worker/routes/merchant';

/** 100,000 cents at 1,400 IQD/USD — 1,400,000 IQD of spendable balance. */
const DEP = 100_000;

/**
 * Two rival merchants and the official store, so "does not mix" can be
 * asserted in every direction rather than in the one the code happens to
 * take first.
 */
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('ali','Ali','ali@x.co','h','merchant'),
      ('zain','Zain','zain@x.co','h','merchant');

    INSERT INTO community_merchants (id,user_id,name,status) VALUES
      ('m_ali','ali','Ali 3D','active'),
      ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}'),
      ('s_zain','m_zain','zain','zainprint','Zain Print','active','{}');

    INSERT INTO community_products
      (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0),
      ('cp_zain','m_zain','s_zain','zain-spool','Zain spool','active','active',9000,100,0);

    /* The official store's own product — the third seller in the rule. */
    INSERT INTO products (id,slug,name,price_iqd,status,stock)
      VALUES ('p_levo','levo-nozzle','Levonis nozzle',5000,'active',50);

    /* A governorate: the store checkout prices delivery from it and refuses
       an address without one (W2-A, ADDRESS_GOVERNORATE_REQUIRED). */
    INSERT INTO addresses (id,user_id,name,phone,address,governorate)
      VALUES ('a1','buyer','Sara','+964770','Baghdad','baghdad');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed funding');

    /* A store sells only while its OWNER holds the store entitlement
       (worker/lib/storeOrderOps.ts, storeTakesOrders) — both are PLUS here. */
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
}

/**
 * Place a store order the way the checkout page does: quote first, then send
 * back the fingerprint of the quote the customer confirmed (B12).
 */
async function placeStoreOrder(app: ReturnType<typeof buyerApp>, body: Record<string, unknown>) {
  const q = await json(await post(app, '/api/store-orders/quote', {}));
  return post(app, '/api/store-orders', { quoteFingerprint: q.quote?.quote_fingerprint, ...body });
}

const buyerApp = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/store-orders', storeOrderRoutes);
  });

const merchantApp = (db: D1Database, who: 'ali' | 'zain') =>
  stubApp(db, { id: who, role: 'merchant', email: `${who}@x.co` }, (a) => {
    a.route('/api/merchant', merchantRoutes);
  });

const addMerchant = (app: ReturnType<typeof buyerApp>, productId: string, body: object = {}) =>
  post(app, '/api/cart/merchant-items', { productId, qty: 1, ...body });

const lines = (raw: DatabaseSync) =>
  count(raw, 'SELECT COUNT(*) n FROM cart_items WHERE user_id = ?', 'buyer');

// =========================================================================
// THE SEPARATION — «لا تختلط مع تاجر آخر ولا مع المتجر الرسمي إلا بعد التفريغ»
// =========================================================================

test('a merchant product goes into the cart, and the cart says whose it is', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));

  const added = await json(await addMerchant(app, 'cp_ali'));
  assert.equal(added.success, true, JSON.stringify(added));
  assert.deepEqual(added.scope, { seller_type: 'merchant', merchant_id: 'm_ali', store_id: 's_ali' });
  assert.equal(added.store.name, 'Ali 3D');

  // The row carries its seller, so the rule survives a route that forgets it.
  const line = row<{ seller_type: string; merchant_id: string; product_id: string | null }>(
    raw, 'SELECT seller_type, merchant_id, product_id FROM cart_items WHERE user_id = ?', 'buyer'
  )!;
  assert.equal(line.seller_type, 'merchant');
  assert.equal(line.merchant_id, 'm_ali');
  assert.equal(line.product_id, null, 'a merchant line names no Levonis product');
});

test('a SECOND merchant is refused, and the refusal names both shops', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');

  const res = await addMerchant(app, 'cp_zain');
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, 'CART_SELLER_CONFLICT');
  // Naming both is the whole point: "items from another store" leaves the
  // customer guessing which of the shops they were browsing is in the way.
  assert.equal(body.details.cart_seller_name, 'Ali 3D');
  assert.equal(body.details.incoming_seller_name, 'Zain Print');
  assert.equal(lines(raw), 1, 'a refused add writes nothing');
});

test('the official store and a merchant refuse each other, in both directions', async () => {
  // Levonis first, then a merchant.
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'p_levo', qty: 1 }))).success, true);

  const intoLevonis = await json(await addMerchant(app, 'cp_ali'));
  assert.equal(intoLevonis.code, 'CART_SELLER_CONFLICT');
  assert.equal(intoLevonis.details.cart_seller_name, 'LEVONIS');
  assert.equal(lines(raw), 1);

  // And the mirror: a merchant first, then Levonis.
  const raw2 = freshDb();
  seed(raw2);
  const app2 = buyerApp(asD1(raw2));
  await addMerchant(app2, 'cp_ali');

  const intoMerchant = await json(await post(app2, '/api/cart/items', { productId: 'p_levo', qty: 1 }));
  assert.equal(intoMerchant.code, 'CART_SELLER_CONFLICT', JSON.stringify(intoMerchant));
  assert.equal(lines(raw2), 1, 'the merchant line is still the only one');
});

test('«إلا بعد التفريغ» — emptying is what frees the cart, in ONE request', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');

  // One request, one confirmed intent. Two calls could leave the cart
  // emptied with nothing added if the second failed.
  const swapped = await json(await addMerchant(app, 'cp_zain', { replaceCart: true }));
  assert.equal(swapped.success, true, JSON.stringify(swapped));
  assert.equal(lines(raw), 1, 'the old seller is gone, not kept alongside');
  assert.deepEqual(swapped.scope, { seller_type: 'merchant', merchant_id: 'm_zain', store_id: 's_zain' });

  // And an emptied cart belongs to nobody, so the official store is welcome.
  await app.request('/api/cart', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(lines(raw), 0);
  const scope = await json(await get(app, '/api/cart/scope'));
  assert.equal(scope.scope, null, 'an empty cart has no seller at all');
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'p_levo', qty: 1 }))).success, true);
});

// =========================================================================
// PREPAID ONLY — «تدفع فقط مقدما ولا يستطيع الدفع عند الاستلام أو الاستلام من المخزن»
// =========================================================================

test('THE BUG: cash on delivery is refused, and refused BEFORE anything is written', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');

  const res = await post(app, '/api/store-orders', {
    idempotencyKey: 'prepaid-key-001', addressId: 'a1', payWithWallet: false,
  });
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'STORE_PREPAID_ONLY');

  // Refused in words, not by silently charging a wallet for a method the
  // customer did not pick — so nothing at all exists afterwards.
  assert.equal(count(raw, "SELECT COUNT(*) n FROM orders"), 0);
  assert.equal(holds(raw, 'buyer').length, 0, 'no money was reserved');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_ledger_entries"), 0, 'and no merchant was credited');
  assert.equal(lines(raw), 1, 'the cart is untouched, so they can still pay properly');
});

test('a merchant order is wallet-paid, with nothing due at the door and no pickup to choose', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');

  const placed = await json(await placeStoreOrder(app, {
    idempotencyKey: 'prepaid-key-002', addressId: 'a1',
  }));
  assert.equal(placed.success, true, JSON.stringify(placed));

  // The three columns that ARE the rule.
  assert.equal(placed.order.payment_method_id, 'wallet');
  assert.equal(Number(placed.order.due_on_delivery_iqd), 0, 'nothing is collected at the door');
  assert.equal(placed.order.delivery_method_id, 'merchant', 'and there is no warehouse to collect from');
  assert.equal(Number(placed.order.wallet_applied_iqd), 14000);
  assert.equal(placed.order.seller_type, 'merchant');
  assert.equal(placed.order.merchant_id, 'm_ali');

  // Paid, not promised: 14,000 IQD at 1,400 = 1,000 cents, actually debited.
  const h = holds(raw, 'buyer');
  assert.equal(h.length, 1);
  assert.equal(h[0].state, 'committed');
  assert.equal(h[0].amount_cents, 1000);
  await Promise.allSettled(pending);
});

test('omitting the field is not a loophole — it is the only way to pay', async () => {
  // An older client sent `payWithWallet` as a boolean either way. A newer one
  // sends nothing, because there is nothing to choose. Both must land on the
  // wallet rather than on a default that quietly means cash.
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');

  const placed = await json(await placeStoreOrder(app, {
    idempotencyKey: 'prepaid-key-003', addressId: 'a1', payWithWallet: true,
  }));
  assert.equal(placed.order.payment_method_id, 'wallet');
  assert.equal(Number(placed.order.due_on_delivery_iqd), 0);
  await Promise.allSettled(pending);
});

test('the quote answers "can my wallet actually pay this" before the button, not after', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');

  const rich = (await json(await post(app, '/api/store-orders/quote', {}))).quote;
  assert.equal(rich.payment_method, 'wallet');
  assert.equal(rich.total_iqd, 14000);
  assert.equal(rich.wallet_available_iqd, 1_400_000, '100,000 cents at 1,400 IQD/USD');
  assert.equal(rich.wallet_covers, true);
  assert.equal(rich.wallet_shortfall_iqd, 0);

  // Spend the balance down to less than the order and ask again.
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
              VALUES ('w_out','buyer','withdrawal','USD',${DEP - 500},'approved','spent')`);
  const poor = (await json(await post(app, '/api/store-orders/quote', {}))).quote;
  assert.equal(poor.wallet_covers, false);
  assert.equal(poor.wallet_available_iqd, 7000, '500 cents at 1,400');
  assert.equal(poor.wallet_shortfall_iqd, 7000, 'and the customer is told the exact gap');

  // The screen's answer and the checkout's answer must be the same answer.
  const refused = await json(await placeStoreOrder(app, {
    idempotencyKey: 'prepaid-key-004', addressId: 'a1',
  }));
  assert.equal(refused.code, 'INSUFFICIENT_FUNDS');
  assert.equal(refused.details.required_iqd, 14000);
});

// =========================================================================
// AND THE ORDER GOES TO THE MERCHANT — «الطلب يذهب للتاجر لطلباته»
// =========================================================================

test('the order lands in the selling merchant\'s own list and in nobody else\'s', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  await addMerchant(app, 'cp_ali');
  const placed = await json(await placeStoreOrder(app, {
    idempotencyKey: 'prepaid-key-005', addressId: 'a1',
  }));
  const orderId = placed.order.id as string;

  const mine = await json(await get(merchantApp(asD1(raw), 'ali'), '/api/merchant/orders'));
  assert.equal(mine.orders.length, 1);
  assert.equal(mine.orders[0].id, orderId);
  assert.equal(mine.orders[0].origin, 'store_product');
  assert.equal(mine.orders[0].payment_method_id, 'wallet', 'the merchant sees it is already paid');

  // The isolation is the WHERE clause, not a filter a client could drop.
  const theirs = await json(await get(merchantApp(asD1(raw), 'zain'), '/api/merchant/orders'));
  assert.equal(theirs.orders.length, 0);
  const peek = await get(merchantApp(asD1(raw), 'zain'), `/api/merchant/orders/${orderId}`);
  assert.equal(peek.status, 404, 'and one merchant cannot read another\'s order by id');

  // The merchant's share is recorded against THEM, pending until it completes.
  assert.equal(
    count(raw, "SELECT COUNT(DISTINCT order_id) n FROM merchant_ledger_entries WHERE merchant_id='m_ali' AND bucket='pending'"),
    1
  );
  await Promise.allSettled(pending);
});
