/**
 * «اطلب بالسعر التقديري» — THE CHECKOUT OF A LINE AT AN ESTIMATED PRICE
 * (docs/SMART_PRICING.md §6.1–6.3; migration 0218, triggers T6 and T7;
 * DECISIONS row 280; invariants I3 and I4).
 *
 * Driven through the REAL quote and order routes over a fully migrated
 * database, with the products V2-published by the real writer and labelled
 * the only way there is (inside the writer's `engine-price:<id>` token):
 *
 *   ACKNOWLEDGEMENT  an estimated line needs `price_estimate_ack` EQUAL to the
 *                    notice version — missing, old or a bare boolean is 409
 *                    PRICE_ESTIMATE_ACK_REQUIRED carrying the fresh quote, and
 *                    nothing is written.
 *   PAYMENT          wallet or cash on delivery only — BNPL and Gini are
 *                    refused (PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED) and taken off
 *                    the offered list — and both doors charge the same price.
 *   RECORDING        the order batch holds the checkout token from before the
 *                    first line to after the records, writes one record per
 *                    estimated line and marks its snapshot; a gift line is
 *                    never recorded; a firm SKU is no estimate; a label that
 *                    lands between the read and the batch is caught by T6 and
 *                    answered with the fresh quote.
 *   THE BRAKE        the owner's ordering switch refuses estimated lines, and
 *                    an unreadable switch refuses too (fail closed).
 *
 * Run: node --import tsx --test tests/priceEstimateCheckout.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, failingD1, json, post, row, stubApp, all, type StubUser } from './fixtures/app';
import { seedCatalogue, orderBody } from './lib/bundles';
import { publishSeededV2 } from './fixtures/autoPublish';
import { arithmeticLeaks, leaks } from './fixtures/costlyProduct';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { ESTIMATE_NOTICE_VERSION, ESTIMATE_STRINGS } from '../packages/contracts/src/priceEstimates';
import { allowedPaymentMethods, isPaymentMethodAllowed, isFinancedPaymentMethod } from '../packages/pricing/src/paymentPolicy';
import { giftInCart, giftWorld, apps as giftApps, PLATE_AIR, paidLine } from './fixtures/giftWorld';

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const PRO: StubUser = { id: 'u_pro', role: 'customer', email: 'r@x.co' };

/** What the V2 writer's estimate batch does to the label (T1 lets it in only under the price token). */
function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

/** One cart line: '' = direct sale, a route = a pre-order on it. */
function cartLine(raw: DatabaseSync, id: string, user: string, productId: string, route: '' | 'air' | 'sea', qty = 1): void {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,fulfillment_type)
       VALUES (?,?,?,'','[]','','',?,'',?,?)`
    )
    .run(id, user, productId, route, qty, route ? 'pre_order' : 'direct_sale');
}

/**
 * The bundle suite's catalogue, V2-published: `p_pre2` (TPU, pre-order by sea)
 * is the estimate, `p_pre` (PETG, by air or sea) its unlabelled twin, `p_pla`
 * a direct-sale spool. A dual product (`p_dual`, direct and by sea) is added
 * for the pre-order-only rule.
 */
async function world(): Promise<DatabaseSync> {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_dual','dual','Dual Spool','بكرة','بکرە',30000,'active',8,'[]','[]','direct_sale','["direct_sale","pre_order"]',
            '[{"method":"sea","active":true}]','[]','BASE','{"is_spool":true}');
  `);
  await publishSeededV2(raw);
  label(raw, 'p_pre2');
  return raw;
}

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
};
const appOf = (db: D1Database, user: StubUser = BUYER) => stubApp(db, user, mount, { publishV2: false });

const quoteBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  ...over,
});
const quote = async (db: D1Database, over: Record<string, unknown> = {}, user: StubUser = BUYER) => {
  const res = await post(appOf(db, user), '/api/orders/quote', quoteBody(over));
  return { status: res.status, body: await json(res) };
};
const order = async (db: D1Database, over: Record<string, unknown> = {}, user: StubUser = BUYER) => {
  const res = await post(appOf(db, user), '/api/orders', orderBody(over));
  return { status: res.status, body: await json(res) };
};
const ACK = { price_estimate_ack: ESTIMATE_NOTICE_VERSION };

const records = (raw: DatabaseSync, orderId: string) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM order_price_estimates WHERE order_id = ? ORDER BY order_item_id', orderId);
const tokensLeft = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'estimate-checkout:%'");

// ------------------------------------------------------------------ the policy (pure)

test('the payment policy: an estimate takes BNPL and Gini off the list, and only them', () => {
  for (const t of ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'] as const) {
    assert.deepEqual(allowedPaymentMethods(t, { bnplEligible: true, giniEnabled: true, hasEstimate: true }), ['wallet', 'cash']);
    assert.deepEqual(allowedPaymentMethods(t, { bnplEligible: true, giniEnabled: true }), ['wallet', 'cash', 'bnpl', 'gini']);
    const opts = { bnplEligible: true, giniEnabled: true, hasEstimate: true };
    assert.equal(isPaymentMethodAllowed('wallet', t, opts), true);
    assert.equal(isPaymentMethodAllowed('cash', t, opts), true);
    assert.equal(isPaymentMethodAllowed('full_advance', t, opts), true, 'the tolerated alias of the wallet');
    assert.equal(isPaymentMethodAllowed('bnpl', t, opts), false);
    assert.equal(isPaymentMethodAllowed('gini', t, opts), false);
  }
  assert.equal(isFinancedPaymentMethod('bnpl'), true);
  assert.equal(isFinancedPaymentMethod('gini'), true);
  assert.equal(isFinancedPaymentMethod('wallet'), false);
  assert.equal(isFinancedPaymentMethod('cash'), false);
});

// ------------------------------------------------------------------ the quote

test('the quote: the estimated line is labelled, the estimate block names it with the notice version, and only the wallet and cash are offered', async () => {
  const raw = await world();
  cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea');
  const db = asD1(raw);
  const q = await quote(db, { paymentMethodId: undefined });
  assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 400));
  const body = q.body.quote;
  assert.deepEqual(body.estimate, { lines: ['ci_tpu'], notice_version: ESTIMATE_NOTICE_VERSION });
  assert.equal(body.lines[0].price_estimate, true);
  assert.deepEqual(body.allowed_payment_methods, ['wallet', 'cash'], 'Gini ships enabled, and is still not offered');
  assert.equal(body.gini.available, false);
  assert.deepEqual(body.bnpl, { eligible: false });
  assert.equal(body.can_checkout, true);
  assert.deepEqual(arithmeticLeaks(body.lines[0]), []);
  assert.deepEqual(leaks(body), []);

  // The twin, unlabelled: no estimate key at all, and Gini is offered as before.
  raw.exec("DELETE FROM cart_items WHERE user_id = 'buyer'");
  cartLine(raw, 'ci_petg', 'buyer', 'p_pre', 'sea');
  const plain = (await quote(db, { paymentMethodId: undefined })).body.quote;
  assert.equal('estimate' in plain, false);
  assert.equal('price_estimate' in plain.lines[0], false);
  assert.deepEqual(plain.allowed_payment_methods, ['wallet', 'cash', 'gini']);
});

test('wallet and cash on delivery charge the same estimated price', async () => {
  const raw = await world();
  cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea');
  const db = asD1(raw);
  const wallet = (await quote(db, { paymentMethodId: 'wallet', useWallet: true })).body.quote;
  const cash = (await quote(db, { paymentMethodId: 'cash' })).body.quote;
  assert.equal(wallet.lines[0].unit_price_iqd, cash.lines[0].unit_price_iqd, 'no direct row: cash prices from the route row');
  assert.equal(wallet.subtotal_iqd, cash.subtotal_iqd);
  assert.ok(cash.lines[0].unit_price_iqd > 0);
  for (const pay of [{ paymentMethodId: 'cash' }, { paymentMethodId: 'wallet', useWallet: true }]) {
    raw.exec("DELETE FROM cart_items WHERE user_id = 'buyer'");
    cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea');
    const placed = await order(db, { ...pay, ...ACK });
    assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
    assert.equal(placed.body.order.items[0].unit_price_iqd, cash.lines[0].unit_price_iqd);
  }
});

test('BNPL and Gini are refused for an estimated line with PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED, and nothing is written', async () => {
  const raw = await world();
  // An eligible PRO (the payment suite's BNPL fixture): approved address, KYC and a credit line.
  raw.exec(`
    UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause';
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_pro','u_pro',1,'Rami','+9647701234570','Baghdad, Karrada 15','','approved');
    INSERT INTO kyc_cases (id,user_id,state,decided_at) VALUES ('kyc_pro','u_pro','verified','2026-01-01T00:00:00.000Z');
    INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd,approved_by) VALUES ('u_pro','approved',900000,'boss');
  `);
  cartLine(raw, 'ci_pro', 'u_pro', 'p_pre2', 'sea');
  const db = asD1(raw);
  // Without the estimate the PRO is offered BNPL here (the control) …
  raw.exec("UPDATE cart_items SET product_id = 'p_pre' WHERE id = 'ci_pro'");
  const control = (await quote(db, { addressId: 'addr_o', paymentMethodId: undefined, deliveryMethodId: 'personal' }, PRO)).body.quote;
  assert.ok(control.allowed_payment_methods.includes('bnpl'), JSON.stringify(control.allowed_payment_methods));
  raw.exec("UPDATE cart_items SET product_id = 'p_pre2' WHERE id = 'ci_pro'");
  // … and with it, not.
  const open = (await quote(db, { addressId: 'addr_o', paymentMethodId: undefined, deliveryMethodId: 'personal' }, PRO)).body.quote;
  assert.deepEqual(open.allowed_payment_methods, ['wallet', 'cash']);
  assert.equal(open.bnpl.eligible, false);

  for (const [method, extra] of [['bnpl', {}], ['gini', { giniOrderNo: '123456' }]] as const) {
    const q = await quote(db, { addressId: 'addr_o', paymentMethodId: method, deliveryMethodId: 'personal', ...extra }, PRO);
    assert.equal(q.status, 400, method);
    assert.equal(q.body.code, 'PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED', method);
    assert.deepEqual(q.body.details.allowed_payment_methods, ['wallet', 'cash']);
    const o = await order(db, { addressId: 'addr_o', paymentMethodId: method, deliveryMethodId: 'personal', ...ACK, ...extra }, PRO);
    assert.equal(o.status, 400, method);
    assert.equal(o.body.code, 'PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED', method);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'u_pro'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM bnpl_ledger'), 0);
});

// ------------------------------------------------------------------ the acknowledgement

test('a missing, old or boolean acknowledgement is refused with the fresh quote, and nothing is written', async () => {
  const raw = await world();
  cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea');
  const db = asD1(raw);
  for (const ack of [undefined, 0, ESTIMATE_NOTICE_VERSION - 1, ESTIMATE_NOTICE_VERSION + 1, true, String(ESTIMATE_NOTICE_VERSION)]) {
    const o = await order(db, ack === undefined ? {} : { price_estimate_ack: ack });
    assert.equal(o.status, 409, `ack ${JSON.stringify(ack)}`);
    assert.equal(o.body.code, 'PRICE_ESTIMATE_ACK_REQUIRED');
    const fresh = o.body.details.quote;
    assert.deepEqual(fresh.estimate, { lines: ['ci_tpu'], notice_version: ESTIMATE_NOTICE_VERSION });
    assert.equal(fresh.lines[0].price_estimate, true);
    assert.deepEqual(fresh.allowed_payment_methods, ['wallet', 'cash']);
    assert.deepEqual(leaks(o.body), []);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM cart_items WHERE id = 'ci_tpu'"), 1, 'the cart line is still there to retry');
  assert.equal(tokensLeft(raw), 0);
  // The right one goes through.
  const ok = await order(db, ACK);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 400));
});

// ------------------------------------------------------------------ the record

test('the order batch records every estimated line — token, record and snapshot — and the order reads its state', async () => {
  const raw = await world();
  cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea', 2);
  cartLine(raw, 'ci_petg', 'buyer', 'p_pre', 'sea');
  const { failing, db } = failingD1(raw);
  const placed = await order(db, ACK);
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
  const id = String(placed.body.order.id);

  // ONE record, for the estimated line only: its SKU, route, quantity, the regular unit price it was sold at, the version.
  const tpu = row<Record<string, unknown>>(raw, "SELECT * FROM order_items WHERE order_id = ? AND product_id = 'p_pre2'", id)!;
  const recs = records(raw, id);
  assert.equal(recs.length, 1);
  assert.deepEqual(
    [recs[0].order_item_id, recs[0].product_id, recs[0].combo_key, recs[0].channel, recs[0].qty, recs[0].notice_version, recs[0].state, recs[0].final_unit_iqd, recs[0].adjustment_id],
    [tpu.id, 'p_pre2', '', 'pre_order_sea', 2, ESTIMATE_NOTICE_VERSION, 'open', null, null]
  );
  assert.equal(recs[0].estimate_unit_iqd, tpu.unit_price_iqd, 'the regular unit price the line was sold at');
  // The snapshot carries the acknowledged version; the twin's does not.
  assert.deepEqual(JSON.parse(String(tpu.pricing_snapshot)).estimate, { v: ESTIMATE_NOTICE_VERSION });
  const petg = row<Record<string, unknown>>(raw, "SELECT * FROM order_items WHERE order_id = ? AND product_id = 'p_pre'", id)!;
  assert.equal(JSON.parse(String(petg.pricing_snapshot)).estimate, undefined);
  assert.equal(tokensLeft(raw), 0, 'the token never outlives its batch');

  // ONE batch, in this order: the token before the first line, the records and the token's removal after the last.
  const batch = failing.batches.find((b) => b.some((s) => s.startsWith('INSERT INTO orders')))!;
  const at = (re: RegExp) => batch.findIndex((s) => re.test(s));
  const lastItem = batch.map((s, i) => (/^INSERT INTO order_items/.test(s) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(at(/^INSERT INTO ops_guards/) > at(/^INSERT INTO orders/), 'after the order');
  assert.ok(at(/^INSERT INTO ops_guards/) < at(/^INSERT INTO order_items/), 'before the first line');
  assert.ok(at(/^INSERT INTO order_price_estimates/) > lastItem, 'the records after the last line');
  assert.ok(at(/^DELETE FROM ops_guards/) > at(/^INSERT INTO order_price_estimates/));

  // The order reads where each line stands, a state and never a figure.
  const read = await json(await appOf(asD1(raw)).request(`/api/orders/${id}`));
  const items = read.order.items as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const est = items.find((i) => i.product_id === 'p_pre2')!;
  assert.deepEqual(est.price_estimate, { state: 'open' });
  assert.equal(est.pricing.price_estimate, true);
  assert.equal('price_estimate' in items.find((i) => i.product_id === 'p_pre')!, false);
  assert.deepEqual(leaks(read), []);
  assert.equal(read.order.status, 'pending');
  assert.equal(read.order.stage, 'received');
  // …and the list too.
  const list = await json(await appOf(asD1(raw)).request('/api/orders'));
  assert.deepEqual(list.orders[0].items.find((i: { product_id: string }) => i.product_id === 'p_pre2').price_estimate, { state: 'open' });
});

test('an order with no labelled product writes exactly what it did: no token, no record, no snapshot mark', async () => {
  const raw = await world();
  cartLine(raw, 'ci_petg', 'buyer', 'p_pre', 'sea');
  const { failing, db } = failingD1(raw);
  const placed = await order(db);
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
  const batch = failing.batches.find((b) => b.some((s) => s.startsWith('INSERT INTO orders')))!;
  assert.equal(batch.some((s) => /ops_guards|order_price_estimates/.test(s)), false);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_price_estimates'), 0);
});

test('a firm SKU of a labelled product is no estimate: no acknowledgement, no record — and the label’s token still lets its line in', async () => {
  const raw = await world();
  raw.prepare('INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)').run('p_pre2', '', 'boss', '2026-11-01T00:00:00.000Z');
  cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea');
  const db = asD1(raw);
  const q = (await quote(db)).body.quote;
  assert.equal('estimate' in q, false);
  assert.deepEqual(q.allowed_payment_methods, ['wallet', 'cash', 'gini']);
  const placed = await order(db);
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
  assert.equal(records(raw, String(placed.body.order.id)).length, 0);
  assert.equal(tokensLeft(raw), 0);
});

test('a gift line is never recorded: beside a paid estimated line, only the paid line is', async () => {
  const raw = giftWorld();
  // A second pre-order product on the gift's own route (air), which the owner's apply labelled.
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
    VALUES ('p_est','est-plate','Smooth plate','لوح أملس','تەختەی لووس',50000,'active',NULL,'[]','[]','pre_order','["pre_order"]',
            '[{"method":"air","commission_iqd":0,"active":true}]','[]','BASE');
  `);
  const a = giftApps(raw);
  await giftInCart(a, PLATE_AIR); // a gift of an unlabelled product (gifts of labelled products are excluded, §8)
  label(raw, 'p_est');
  paidLine(raw, 'ci_est', 'p_est', { fulfillmentType: 'pre_order', transport: 'air' });
  const refused = await json(await post(a.buyer, '/api/orders', orderBody({ addressId: 'addr_b' })));
  assert.equal(refused.code, 'PRICE_ESTIMATE_ACK_REQUIRED', JSON.stringify(refused).slice(0, 300));
  const placed = await json(await post(a.buyer, '/api/orders', orderBody({ addressId: 'addr_b', ...ACK })));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  const id = String(placed.order.id);
  const recs = records(raw, id);
  assert.equal(recs.length, 1, 'one record: the paid line');
  const paid = row<Record<string, unknown>>(raw, "SELECT * FROM order_items WHERE order_id = ? AND product_id = 'p_est'", id)!;
  assert.deepEqual([recs[0].order_item_id, recs[0].combo_key, recs[0].channel], [paid.id, '', 'pre_order_air']);
  const gift = row<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ? AND gift_entitlement_id IS NOT NULL', id)!;
  assert.ok(gift, 'the gift line is in the order');
  assert.equal(JSON.parse(String(gift.pricing_snapshot)).estimate, undefined, 'a gift line carries no estimate mark');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_price_estimates WHERE order_item_id = ?', String(gift.id)), 0);
  assert.equal(tokensLeft(raw), 0);
});

test('T6 catches a stale read: a label landing between the checkout’s read and its batch aborts the order and answers with the fresh quote', async () => {
  const raw = await world();
  cartLine(raw, 'ci_petg', 'buyer', 'p_pre', 'sea');
  const { failing, db } = failingD1(raw);
  let labelled = false;
  failing.beforeBatch = (statements) => {
    if (!labelled && statements.some((s) => /^\s*INSERT INTO orders\b/.test(s.sql))) {
      label(raw, 'p_pre'); // the owner's apply commits while this checkout is in flight
      labelled = true;
    }
  };
  const stale = await order(db);
  assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 400));
  assert.equal(stale.body.code, 'PRICE_ESTIMATE_ACK_REQUIRED');
  assert.deepEqual(stale.body.details.quote.estimate, { lines: ['ci_petg'], notice_version: ESTIMATE_NOTICE_VERSION });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'the whole batch rolled back');
  assert.equal(tokensLeft(raw), 0);
  // The client retries into the acknowledgement.
  const ok = await order(db, ACK);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 400));
  assert.equal(records(raw, String(ok.body.order.id)).length, 1);
});

// ------------------------------------------------------------------ the doors' other refusals

test('an estimated SKU is sold only as a pre-order: a direct-sale line is refused at the quote and the order (PRICE_ESTIMATE_PREORDER_ONLY)', async () => {
  const raw = await world();
  label(raw, 'p_dual');
  cartLine(raw, 'ci_dual', 'buyer', 'p_dual', '');
  const db = asD1(raw);
  const q = await quote(db);
  assert.equal(q.status, 409, JSON.stringify(q.body).slice(0, 300));
  assert.equal(q.body.code, 'PRICE_ESTIMATE_PREORDER_ONLY');
  const o = await order(db, ACK);
  assert.equal(o.body.code, 'PRICE_ESTIMATE_PREORDER_ONLY');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  // The same product by sea is an ordinary estimate.
  raw.exec("UPDATE cart_items SET transport_method = 'sea', fulfillment_type = 'pre_order' WHERE id = 'ci_dual'");
  const placed = await order(db, ACK);
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 400));
  assert.equal(records(raw, String(placed.body.order.id))[0].channel, 'pre_order_sea');
});

test('the owner’s brake: while ordering is paused the quote reports it and the order refuses it; an unreadable switch refuses too', async () => {
  const raw = await world();
  cartLine(raw, 'ci_tpu', 'buyer', 'p_pre2', 'sea');
  const db = asD1(raw);
  raw.exec('UPDATE price_estimate_control SET ordering_enabled = 0 WHERE id = 1');
  const q = (await quote(db)).body.quote;
  assert.deepEqual(q.estimate, { lines: ['ci_tpu'], notice_version: ESTIMATE_NOTICE_VERSION, ordering_paused: true });
  assert.ok(q.blockers.includes('PRICE_ESTIMATE_ORDERING_PAUSED'));
  assert.equal(q.can_checkout, false);
  const o = await order(db, ACK);
  assert.equal(o.status, 409);
  assert.equal(o.body.code, 'PRICE_ESTIMATE_ORDERING_PAUSED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);

  // An unlabelled cart is not braked.
  raw.exec("UPDATE cart_items SET product_id = 'p_pre' WHERE id = 'ci_tpu'");
  assert.equal((await order(db)).status, 200);

  // FAIL CLOSED: the switch cannot be read → 503, nothing written (the table is gone in this copy).
  cartLine(raw, 'ci_tpu2', 'buyer', 'p_pre2', 'sea');
  raw.exec('DROP TABLE price_estimate_control');
  const before = count(raw, 'SELECT COUNT(*) AS n FROM orders');
  const broken = await order(db, ACK);
  assert.equal(broken.status, 503);
  assert.equal(broken.body.code, 'PRICE_ESTIMATES_READ_FAILED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), before);
});

test('the words: every estimate sentence the checkout serves exists in three languages, Sorani never the Arabic', () => {
  for (const key of ['notice', 'checkoutAck', 'checkoutButton', 'checkoutCancel', 'orderPlaced'] as const) {
    const t = ESTIMATE_STRINGS[key];
    assert.ok(t.ar && t.en && t.ckb, key);
    assert.notEqual(t.ckb, t.ar, key);
  }
});
