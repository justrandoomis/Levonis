/**
 * THE REVIEW GIFT THROUGH THE REAL CHECKOUT (docs/REVIEWS_GIFTS.md §6.3,
 * owner brief §14, §15, §17 and §18) — lane S3.
 *
 *   «الهدية تعتبر مستهلكة نهائيًا عند نجاح إنشاء/تأكيد الطلب، وليس بمجرد
 *    إضافتها للسلة.»
 *   «لا يمكن استخدام entitlement في طلبين. لا يمكن فتح Checkout متزامنين
 *    وإنشاء طلبين لنفس الهدية … فشل الدفع/إنشاء الطلب قبل Commit لا يجب أن
 *    يستهلك الهدية نهائيًا … لا تخصم مخزون البيع المباشر مرتين. لا تنشئ
 *    Pre-order مرتين.»
 *
 * Real routes, real migrations, real triggers; concurrency is D1's
 * single-writer model (tests/fixtures/serialD1.ts) or a writer injected
 * between the plan and the commit (tests/fixtures/app.ts `failingD1`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, dbThrough, failingD1, row, all, count, json, post, get } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { deductOrderStock } from '../worker/lib/orderInventory';
import { createInvoiceForOrder } from '../worker/lib/invoices';
import { orderAnnouncement } from '../worker/lib/adminTopicRouting';
import {
  PLATE_AIR,
  giftWorld,
  grantGift,
  shopApp,
  orderBody,
  quoteBody,
  paidLine,
} from './fixtures/giftCommerce';

type Raw = ReturnType<typeof giftWorld>;
const entitlement = (raw: Raw, id: string) =>
  row<Record<string, unknown>>(raw, 'SELECT * FROM gift_entitlements WHERE id = ?', id)!;
const optionStock = (raw: Raw, id: string) =>
  ({ ...row<{ stock: number; reserved: number }>(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', id)! });

async function giftInCart(raw: Raw, id = 'ge1') {
  const app = shopApp(asD1(raw));
  const added = await json(await post(app, '/api/cart/gift-items', { entitlementId: id }));
  assert.equal(added.success, true, JSON.stringify(added));
  return app;
}

test('a successful checkout marks the gift ordered with order_id, order_item_id and ordered_at', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1', level: 2 });
  const app = await giftInCart(raw);

  // THE QUOTE prices the gift at 0 from the frozen line, delivery as usual.
  const quote = await json(await post(app, '/api/orders/quote', quoteBody()));
  assert.equal(quote.success, true, JSON.stringify(quote));
  const qLine = quote.quote.lines[0];
  assert.equal(qLine.unit_price_iqd, 0);
  assert.equal(qLine.line_total_iqd, 0);
  assert.equal(qLine.kind, 'gift');
  assert.deepEqual(qLine.gift, { entitlement_id: 'ge1', level: 2, value_iqd: 40000 });
  assert.equal(quote.quote.merchandise_iqd, 0);
  assert.equal(quote.quote.subtotal_iqd, 0);
  assert.ok(quote.quote.shipping.total_iqd > 0, 'delivery rules apply to a gift order as to any order');
  assert.equal(quote.quote.total_iqd, quote.quote.shipping.total_iqd + quote.quote.cod_tax_iqd);
  assert.deepEqual(quote.quote.membership_benefits.lines, [], 'no membership rule reaches a gift line');
  assert.equal(quote.quote.points.earn_pending, 0, 'and it earns no points');

  const res = await post(app, '/api/orders', orderBody());
  const placed = await json(res);
  assert.equal(res.status, 200, JSON.stringify(placed));
  const orderId = placed.order.id as string;

  // An ORDINARY order_items row at 0 IQD, naming its gift and the attempt.
  const item = row<Record<string, any>>(raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId)!;
  assert.equal(item.product_id, 'p_nozzle');
  assert.equal(item.qty, 1);
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.line_total_iqd, 0);
  assert.equal(item.gift_entitlement_id, 'ge1');
  assert.equal(item.gift_order_seq, 1);
  assert.equal(item.option_value_ids, '["v_04"]');
  assert.equal(item.color_id, 'c_red');
  assert.equal(item.shipping_method_id, '', 'the cart discriminator never reaches the order');
  assert.equal(item.warranty_snapshot, null);
  assert.equal(item.cost_basis, 'unpriced', 'the cost is recorded honestly (none configured), never as pure margin');
  const snap = JSON.parse(item.pricing_snapshot);
  assert.equal(snap.applied_iqd, 0);
  assert.equal(snap.unit_subtotal_iqd, 0);
  assert.equal(snap.regular_iqd, 40000);
  assert.deepEqual(snap.gift, { entitlement_id: 'ge1', reward_id: 'rr_ge1', level: 2, value_iqd: 40000 });
  assert.equal(snap.cost_iqd, undefined, 'no cost in the customer snapshot');
  assert.equal(snap.fulfillment.type, 'direct_sale');

  // …and in the SAME batch the entitlement became `ordered`, linked both ways.
  const ent = entitlement(raw, 'ge1');
  assert.equal(ent.state, 'ordered');
  assert.equal(ent.order_id, orderId);
  assert.equal(ent.order_item_id, item.id);
  assert.ok(typeof ent.ordered_at === 'string' && ent.ordered_at.length > 10);
  assert.equal(ent.order_seq, 1);
  assert.deepEqual(
    { ...row(raw, "SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = 'gift'", orderId) },
    { expected: 1, actual: 1 },
    'the gift fence balanced'
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0, 'the cart line went with the order');

  // The order: nothing charged for the product, delivery charged as usual.
  const order = row<Record<string, number>>(raw, 'SELECT subtotal_iqd, merchandise_iqd, shipping_iqd, total_iqd FROM orders WHERE id = ?', orderId)!;
  assert.equal(order.subtotal_iqd, 0);
  assert.equal(order.merchandise_iqd, 0);
  assert.ok(order.shipping_iqd > 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM points_accruals WHERE order_id = ? AND points > 0", orderId), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ?', orderId), 0);

  // The customer's order says so.
  const pub = placed.order.items[0];
  assert.equal(pub.is_gift, true);
  assert.equal(pub.gift_entitlement_id, 'ge1');
  assert.equal(pub.unit_price_iqd, 0);
  const detail = await json(await get(app, `/api/orders/${orderId}`));
  assert.equal(detail.order.items[0].is_gift, true);
});

test('two concurrent checkouts of one gift make one order; the loser consumes nothing', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  await giftInCart(raw);
  const app = shopApp(serialD1(raw));

  // Two checkouts of the same cart, different keys, at once.
  const [a, b] = await Promise.all([post(app, '/api/orders', orderBody()), post(app, '/api/orders', orderBody())]);
  const results = [{ res: a, body: await json(a) }, { res: b, body: await json(b) }];
  const won = results.filter((r) => r.res.status === 200);
  const lost = results.filter((r) => r.res.status !== 200);
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal(lost.length, 1);
  assert.equal(lost[0].res.status, 409);
  assert.equal(lost[0].body.code, 'GIFT_ALREADY_ORDERED');

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1, 'ONE order');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items WHERE gift_entitlement_id = ?', 'ge1'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'reserve'"), 1, 'one reservation');
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });
  assert.equal(entitlement(raw, 'ge1').order_id, won[0].body.order.id);
  assert.equal(entitlement(raw, 'ge1').order_seq, 1);
});

test('a checkout that lost the race between its plan and its commit rolls back whole', async () => {
  // DETERMINISTIC: the winner lands exactly between this checkout's reads and
  // its batch. The 0165 insert guard refuses the gift line inside the batch, so
  // the loser's order, wallet spend, reservation and every other line go too.
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  await giftInCart(raw);
  paidLine(raw, 'ci_paid', 'p_nozzle', { optionValueIds: ['v_04'], colorId: 'c_blue', fulfillmentType: 'direct_sale' });
  const before = row(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'buyer'")!;
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => /INSERT INTO orders/i.test(s.sql))) return;
    failing.beforeBatch = null;
    raw
      .prepare(
        `UPDATE gift_entitlements SET state = 'ordered', order_id = 'ord_winner', order_item_id = 'oi_winner',
                ordered_at = ?, order_seq = order_seq + 1 WHERE id = 'ge1'`
      )
      .run(new Date().toISOString());
  };
  const res = await post(shopApp(db), '/api/orders', orderBody({ useWallet: true, paymentMethodId: 'wallet' }));
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'GIFT_ALREADY_ORDERED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'no order');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 0, 'not even the paid line');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0, 'no reservation');
  assert.deepEqual({ ...row(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'buyer'") }, { ...before }, 'no wallet debit');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 2, 'the cart is intact');
});

test('the attempt index refuses a second consumption of the same attempt', async () => {
  // The backstop under the guard: an order_items row already holds (ge1, 1)
  // while the entitlement still reads ready — the UNIQUE index refuses the
  // second, and the refusal is a gift code, not a generic «try again».
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  await giftInCart(raw);
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => /INSERT INTO orders/i.test(s.sql))) return;
    failing.beforeBatch = null;
    raw.exec(`
      INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                          subtotal_iqd,shipping_iqd,total_iqd,due_on_delivery_iqd)
      VALUES ('ord_ghost','buyer','pending','{}','standard','{}','cash',0,0,0,0);
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,
                               gift_entitlement_id,gift_order_seq)
      VALUES ('oi_ghost','ord_ghost','p_nozzle','Nozzle kit','',1,0,0,'ge1',1);
    `);
  };
  const res = await post(shopApp(db), '/api/orders', orderBody());
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'GIFT_NOT_ORDERABLE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id <> 'ord_ghost'"), 0);
  assert.equal(entitlement(raw, 'ge1').state, 'redeemed_ready_to_order');
});

test('a failed order creation consumes nothing', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  await giftInCart(raw);

  // 1. A transient D1 failure on the order batch.
  const { failing, db } = failingD1(raw);
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO orders/i.test(s.sql));
  const failed = await post(shopApp(db), '/api/orders', orderBody());
  assert.notEqual(failed.status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.equal(entitlement(raw, 'ge1').state, 'redeemed_ready_to_order', 'the gift is still ready');
  assert.equal(entitlement(raw, 'ge1').order_seq, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', 'ge1'), 1, 'and still in the cart');

  // 2. A refusal before the batch: another line of the cart is out of stock.
  paidLine(raw, 'ci_out', 'p_nozzle', { optionValueIds: ['v_06'], colorId: 'c_red', fulfillmentType: 'direct_sale' });
  const refused = await post(shopApp(asD1(raw)), '/api/orders', orderBody());
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'OUT_OF_STOCK');
  assert.equal(entitlement(raw, 'ge1').state, 'redeemed_ready_to_order');

  // 3. And the same cart, fixed, orders the gift once.
  raw.prepare("DELETE FROM cart_items WHERE id = 'ci_out'").run();
  const ok = await json(await post(shopApp(asD1(raw)), '/api/orders', orderBody()));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(entitlement(raw, 'ge1').state, 'ordered');
});

test('a direct-sale gift reserves once and deducts once at confirmation', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = await giftInCart(raw);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 }, 'the cart reserves nothing');

  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;
  // The REAL counter of the gift's model, through the ordinary ledger — no gift inventory.
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve'", orderId), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_pool_items'), 0, 'nothing touches a gift pool counter');

  await deductOrderStock(asD1(raw), orderId, null);
  await deductOrderStock(asD1(raw), orderId, null); // a double-clicked confirmation
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 2, reserved: 0 }, 'one unit left the shelf, once');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'deduct'", orderId), 1);
});

test('a pre-order gift keeps pre_order, its route and its lead time', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge_pre', line: PLATE_AIR });
  const app = shopApp(asD1(raw));
  const added = await json(await post(app, '/api/cart/gift-items', { entitlementId: 'ge_pre' }));
  assert.equal(added.success, true, JSON.stringify(added));
  const cartItem = (added.items as Array<Record<string, any>>).find((i) => i.kind === 'gift')!;
  assert.equal(cartItem.availability.mode, 'preorder');
  assert.equal(cartItem.transport_method, 'air');
  assert.equal(cartItem.breakdown.transport.commission_iqd, 0, 'the route commission is part of the gift');
  assert.equal(cartItem.breakdown.transport.method, 'air');
  assert.equal(row(raw, 'SELECT fulfillment_type FROM cart_items WHERE gift_entitlement_id = ?', 'ge_pre')?.fulfillment_type, 'pre_order');

  // Paid in advance (wallet) and cash on delivery both keep it a pre-order.
  const placed = await json(await post(app, '/api/orders', orderBody({ paymentMethodId: 'wallet', useWallet: true })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;
  assert.equal(row(raw, 'SELECT shipping_type FROM orders WHERE id = ?', orderId)?.shipping_type, 'preorder_air');

  const item = row<Record<string, any>>(raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId)!;
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.gift_entitlement_id, 'ge_pre');
  assert.deepEqual(JSON.parse(item.transport_snapshot), { method: 'air', commission_iqd: 0, waived: true, waived_by: 'gift' });
  const snap = JSON.parse(item.pricing_snapshot);
  assert.equal(snap.fulfillment.type, 'pre_order', 'never re-typed to a direct sale');
  assert.equal(snap.fulfillment.lead_time_min_days, 10, 'the route’s own lead time');
  assert.equal(snap.fulfillment.lead_time_max_days, 14);
  assert.equal(snap.gift.value_iqd, snap.regular_iqd);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ?', orderId), 0, 'a pre-order reserves no shelf');
  assert.equal(entitlement(raw, 'ge_pre').state, 'ordered');

  // ONE pre-order: the cart line is gone and the gift cannot be ordered again.
  const again = await post(app, '/api/cart/gift-items', { entitlementId: 'ge_pre' });
  assert.equal((await json(again)).code, 'GIFT_ALREADY_ORDERED');
});

test('a gift beside bought lines: only the bought lines are charged, and both say what they are', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = await giftInCart(raw);
  const paid = await json(await post(app, '/api/cart/items', { productId: 'p_nozzle', optionValueIds: ['v_04'], colorId: 'c_red', qty: 1 }));
  assert.equal(paid.success, true, JSON.stringify(paid));

  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;
  const items = all<Record<string, any>>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY unit_price_iqd', orderId);
  assert.deepEqual(
    items.map((i) => [i.unit_price_iqd, i.gift_entitlement_id, i.gift_order_seq]),
    [[0, 'ge1', 1], [40000, null, null]],
    'the bought line is written exactly as before — no gift column'
  );
  assert.equal(row(raw, 'SELECT subtotal_iqd FROM orders WHERE id = ?', orderId)?.subtotal_iqd, 40000);
  // Both units come off the same real counter (two reservations of one row).
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 2 });

  // THE INVOICE prints the gift as a gift, at 0, in the customer's language.
  const invoice = await createInvoiceForOrder({ DB: asD1(raw) } as never, orderId);
  assert.ok(invoice);
  const snapshot = JSON.parse(String(row(raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', orderId)!.snapshot));
  const giftLine = snapshot.lines.find((l: Record<string, unknown>) => l.is_gift === true);
  assert.ok(giftLine, JSON.stringify(snapshot.lines));
  assert.equal(giftLine.unit_price_iqd, 0);
  assert.equal(giftLine.gift_value_iqd, 40000);
  assert.match(giftLine.variant, /^Gift · /, 'the owner account is English (no locale) — the label follows it');
  assert.equal(giftLine.transport_commission_iqd, 0);
  const bought = snapshot.lines.find((l: Record<string, unknown>) => l.is_gift !== true);
  assert.equal(bought.is_gift, undefined);
  assert.doesNotMatch(bought.variant, /Gift/);

  // THE GROUP'S ORDER MESSAGE marks it 🎁.
  const text = orderAnnouncement({ orderId, lines: [{ name: 'Nozzle kit', qty: 1, line: 0, gift: { entitlement_id: 'ge1' } }, { name: 'Nozzle kit', qty: 1, line: 40000 }] });
  assert.match(text, /• 🎁 هدية: Nozzle kit × 1 — 0 د\.ع/);
  assert.match(text, /• Nozzle kit × 1 — 40,000 د\.ع/);
});

test('an Arabic or Sorani account reads «هدية» / «دیاری» on its invoice', async () => {
  for (const [locale, label] of [['ar', 'هدية'], ['ku', 'دیاری']] as const) {
    const raw = giftWorld();
    raw.prepare('UPDATE users SET locale = ? WHERE id = ?').run(locale, 'buyer');
    grantGift(raw, { id: 'ge1' });
    const app = await giftInCart(raw);
    const placed = await json(await post(app, '/api/orders', orderBody()));
    assert.equal(placed.success, true, JSON.stringify(placed));
    await createInvoiceForOrder({ DB: asD1(raw) } as never, placed.order.id);
    const snapshot = JSON.parse(String(row(raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', placed.order.id)!.snapshot));
    assert.equal(snapshot.lines[0].variant.split(' · ')[0], label, locale);
  }
});

test('a same-key double tap replays the gift order instead of refusing it', async () => {
  const raw = giftWorld();
  grantGift(raw, { id: 'ge1' });
  const app = await giftInCart(raw);
  const body = orderBody();
  const first = await json(await post(app, '/api/orders', body));
  assert.equal(first.success, true);
  const second = await json(await post(app, '/api/orders', body));
  assert.equal(second.success, true);
  assert.equal(second.replay, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
});

test('the ordinary order_items INSERT names no 0165 column, so a Worker ahead of its migration still sells', async () => {
  const orders = readFileSync(join(ROOT, 'worker/routes/orders.ts'), 'utf8');
  const ordinary = /: `INSERT INTO order_items \(([\s\S]*?)\)\s*VALUES/.exec(orders);
  assert.ok(ordinary, 'the ordinary INSERT is still there');
  assert.doesNotMatch(ordinary![1], /gift_/, 'the paid path names no gift column');

  // The live database before 0165: the cart, the quote and an order all work.
  const raw = dbThrough('0152');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
      VALUES ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_pla','pla','PLA Basic','PLA',25000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
  `);
  const app = shopApp(asD1(raw));
  const added = await json(await post(app, '/api/cart/items', { productId: 'p_pla', qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const cart = await json(await get(app, '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 25000);
  assert.equal(cart.items[0].kind, undefined);
  const quote = await json(await post(app, '/api/orders/quote', quoteBody()));
  assert.equal(quote.success, true, JSON.stringify(quote));
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(placed.order.items[0].is_gift, false);
  assert.equal(placed.order.items[0].gift_entitlement_id, null);
});
