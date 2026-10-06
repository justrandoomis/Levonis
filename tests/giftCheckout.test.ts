/**
 * THE GIFT THROUGH THE REAL CHECKOUT (owner brief 2026-10-06 §1;
 * docs/GIFTS_QUICK_BUY.md D4, D6, §1.2, S7, S8).
 *
 *   «الهدية تُطلب مرة واحدة بسعر 0 د.ع؛ المخزون يُخصم فقط عبر مسار الطلب
 *    العادي؛ لا يمكن طلبها مرتين.»
 *
 * Real routes, real migrations, real triggers. Concurrency is D1's
 * single-writer model (tests/fixtures/serialD1.ts) or a writer injected
 * between the plan and the commit (tests/fixtures/app.ts `failingD1`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, failingD1, proOnSale, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { deductOrderStock } from '../worker/lib/orderInventory';
import { createInvoiceForOrder } from '../worker/lib/invoices';
import { orderAnnouncement } from '../worker/lib/adminTopicRouting';
import { grantPrinterGiftIfEligible, orderHasSupportEligibleLine } from '../worker/lib/membershipOps';
import { tradeInCouponCap } from '../worker/lib/tradeIn';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';
import {
  NOZZLE_04_RED,
  PLATE_AIR,
  appAs,
  apps,
  appsFor,
  addGiftToCart,
  get,
  giftInCart,
  giftRow,
  giftWorld,
  json,
  myGift,
  optionStock,
  orderBody,
  paidLine,
  placeOrder,
  post,
  quoteBody,
  redeemedGift,
  send,
} from './fixtures/giftWorld';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

test('a checkout prices the gift at 0, reserves its real stock, links the line and marks the gift ordered — one batch', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);

  // THE QUOTE prices the gift at 0 from the frozen selection, delivery as usual.
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody()));
  assert.equal(quote.success, true, JSON.stringify(quote));
  const qLine = quote.quote.lines[0];
  assert.equal(qLine.unit_price_iqd, 0);
  assert.equal(qLine.line_total_iqd, 0);
  assert.equal(qLine.kind, 'gift');
  assert.equal(qLine.is_gift, true);
  assert.deepEqual(qLine.gift, { id, level: 2, value_iqd: 40000 });
  assert.equal(quote.quote.merchandise_iqd, 0);
  assert.equal(quote.quote.subtotal_iqd, 0);
  assert.ok(quote.quote.shipping.total_iqd > 0, 'delivery rules apply to a gift order as to any order');
  assert.equal(quote.quote.total_iqd, quote.quote.shipping.total_iqd + quote.quote.cod_tax_iqd);
  assert.deepEqual(quote.quote.membership_benefits.lines, [], 'no membership rule reaches a gift line');
  assert.equal(quote.quote.points.earn_eligible_iqd, 0, 'and it earns no points');

  const order = await placeOrder(a.buyer);
  const orderId = order.id as string;
  assert.equal(order.order_kind, 'gift', 'every line a gift: a gift order (D15)');

  // An ORDINARY order_items row at 0 IQD, naming its gift and the attempt.
  const item = row<J>(raw, 'SELECT * FROM order_items WHERE order_id = ?', orderId)!;
  assert.equal(item.product_id, 'p_nozzle');
  assert.equal(item.qty, 1);
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.line_total_iqd, 0);
  assert.equal(item.gift_entitlement_id, id);
  assert.equal(item.gift_order_seq, 1);
  assert.equal(item.option_value_ids, '["v_04"]');
  assert.equal(item.color_id, 'c_red');
  assert.equal(item.shipping_method_id, '', 'the cart discriminator never reaches the order');
  assert.equal(item.warranty_snapshot, null);
  const snap = JSON.parse(item.pricing_snapshot);
  assert.equal(snap.applied_iqd, 0);
  assert.equal(snap.unit_subtotal_iqd, 0);
  assert.equal(snap.regular_iqd, 40000);
  assert.deepEqual(snap.gift, { gift_id: id, level: 2, value_iqd: 40000 });
  assert.equal(snap.cost_iqd, undefined, 'no cost in the customer snapshot');
  assert.equal(snap.fulfillment.type, 'direct_sale');

  // …and in the SAME batch the gift became `ordered`, linked both ways.
  const g = giftRow(raw, id);
  assert.equal(g.state, 'ordered');
  assert.equal(g.order_id, orderId);
  assert.equal(g.order_item_id, item.id);
  assert.ok(typeof g.ordered_at === 'string' && g.ordered_at.length > 10);
  assert.equal(g.order_seq, 1);
  assert.deepEqual(
    { ...row<Record<string, unknown>>(raw, "SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = 'gift'", orderId)! },
    { expected: 1, actual: 1 },
    'the gift fence balanced'
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0, 'the cart line went with the order');
  // THE REAL COUNTER of the model, through the ordinary ledger (D6).
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve'", orderId), 1);

  // The order: nothing charged for the product, delivery charged as usual.
  const o = row<J>(raw, 'SELECT subtotal_iqd, shipping_iqd, total_iqd, order_kind FROM orders WHERE id = ?', orderId)!;
  assert.equal(o.subtotal_iqd, 0);
  assert.ok(o.shipping_iqd > 0);
  assert.equal(o.total_iqd, o.shipping_iqd);
  assert.equal(o.order_kind, 'gift');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM points_accruals WHERE order_id = ? AND points > 0', orderId), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ?', orderId), 0);
  assert.equal(
    row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.order' AND target = ?", id) !== undefined,
    true,
    'the consumption is in the audit log'
  );

  // The customer's order and gift card say so.
  assert.equal(order.items[0].is_gift, true);
  assert.equal(order.items[0].gift_id, id);
  assert.equal(order.items[0].unit_price_iqd, 0);
  const detail = await json(await get(a.buyer, `/api/orders/${orderId}`));
  assert.equal(detail.order.items[0].is_gift, true);
  assert.equal(detail.order.order_kind, 'gift');
  const card = await myGift(a.buyer, id);
  assert.equal(card?.status, 'ORDERED');
  assert.equal(card?.order.id, orderId);
  assert.equal(card?.order.status, 'pending');
});

test('two concurrent checkouts of one gift make one order; the loser consumes nothing', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const s = appsFor(serialD1(raw));

  const [x, y] = await Promise.all([post(s.buyer, '/api/orders', orderBody()), post(s.buyer, '/api/orders', orderBody())]);
  const results = [
    { res: x, body: await json(x) },
    { res: y, body: await json(y) },
  ];
  const won = results.filter((r) => r.res.status === 200);
  const lost = results.filter((r) => r.res.status !== 200);
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal(lost[0].res.status, 409);
  assert.equal(lost[0].body.code, 'GIFT_ALREADY_ORDERED');

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1, 'ONE order');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items WHERE gift_entitlement_id = ?', id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'reserve'"), 1, 'one reservation');
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });
  assert.equal(giftRow(raw, id).order_id, won[0].body.order.id);
  assert.equal(giftRow(raw, id).order_seq, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.order'"), 1);
});

test('a checkout that lost the gift between its plan and its commit rolls back whole', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  paidLine(raw, 'ci_paid', 'p_nozzle', { optionValueIds: ['v_04'], colorId: 'c_blue', fulfillmentType: 'direct_sale' });
  const walletBefore = count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'buyer'");
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (!stmts.some((st) => /INSERT INTO orders/i.test(st.sql))) return;
    failing.beforeBatch = null;
    raw
      .prepare(
        `UPDATE gift_entitlements SET state = 'ordered', order_id = 'ord_winner', order_item_id = 'oi_winner',
                ordered_at = ?, order_seq = order_seq + 1 WHERE id = ?`
      )
      .run(new Date().toISOString(), id);
  };
  const res = await post(appAs(db), '/api/orders', orderBody({ useWallet: true, paymentMethodId: 'wallet' }));
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'GIFT_ALREADY_ORDERED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'no order');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 0, 'not even the paid line');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0, 'no reservation');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'buyer'"), walletBefore, 'no wallet debit');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 2, 'the cart is intact');
});

test('the attempt index refuses a second consumption of the same attempt with a gift code', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  const { failing, db } = failingD1(raw);
  failing.beforeBatch = (stmts) => {
    if (!stmts.some((st) => /INSERT INTO orders/i.test(st.sql))) return;
    failing.beforeBatch = null;
    raw.exec(`
      INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                          subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ord_ghost','buyer','pending','{}','standard','{}','cash',0,0,1400,0,0);
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,
                               gift_entitlement_id,gift_order_seq)
      VALUES ('oi_ghost','ord_ghost','p_nozzle','Nozzle kit','',1,0,0,'${id}',1);
    `);
  };
  const res = await post(appAs(db), '/api/orders', orderBody());
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'GIFT_NOT_ORDERABLE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id <> 'ord_ghost'"), 0);
  assert.equal(giftRow(raw, id).state, 'redeemed');
});

test('a failed order creation consumes nothing, and the same cart then orders the gift once', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);

  // 1. A transient D1 failure on the order batch.
  const { failing, db } = failingD1(raw);
  failing.failWhen = (stmts) => stmts.some((st) => /INSERT INTO orders/i.test(st.sql));
  const failed = await post(appAs(db), '/api/orders', orderBody());
  assert.notEqual(failed.status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.equal(giftRow(raw, id).state, 'redeemed', 'the gift is still waiting');
  assert.equal(giftRow(raw, id).order_seq, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', id), 1, 'and still in the cart');

  // 2. A refusal before the batch: another line of the cart is out of stock.
  paidLine(raw, 'ci_out', 'p_nozzle', { optionValueIds: ['v_06'], colorId: 'c_red', fulfillmentType: 'direct_sale' });
  const refused = await post(a.buyer, '/api/orders', orderBody());
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'OUT_OF_STOCK');
  assert.equal(giftRow(raw, id).state, 'redeemed');

  // 3. Fixed, it orders once; a same-key double tap replays the same order.
  raw.prepare("DELETE FROM cart_items WHERE id = 'ci_out'").run();
  const body = orderBody();
  const first = await json(await post(a.buyer, '/api/orders', body));
  assert.equal(first.success, true, JSON.stringify(first));
  const second = await json(await post(a.buyer, '/api/orders', body));
  assert.equal(second.replay, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  assert.equal(giftRow(raw, id).state, 'ordered');
});

test('a direct-sale gift reserves once and deducts once at confirmation', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  await giftInCart(a);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 }, 'the cart reserves nothing');
  const order = await placeOrder(a.buyer);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_pool_items'), 0, 'no gift counter exists to touch');
  await deductOrderStock(asD1(raw), order.id, null);
  await deductOrderStock(asD1(raw), order.id, null); // a double-clicked confirmation
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 2, reserved: 0 }, 'one unit left the shelf, once');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'deduct'", order.id), 1);
});

test('a pre-order gift keeps pre_order, its route and its lead time; it is never ordered twice', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a, PLATE_AIR);
  const order = await placeOrder(a.buyer, { paymentMethodId: 'wallet', useWallet: true });
  assert.equal(row(raw, 'SELECT shipping_type FROM orders WHERE id = ?', order.id)?.shipping_type, 'preorder_air');
  const item = row<J>(raw, 'SELECT * FROM order_items WHERE order_id = ?', order.id)!;
  assert.equal(item.unit_price_iqd, 0);
  assert.equal(item.gift_entitlement_id, id);
  assert.deepEqual(JSON.parse(item.transport_snapshot), { method: 'air', commission_iqd: 0, waived: true, waived_by: 'gift' });
  const snap = JSON.parse(item.pricing_snapshot);
  assert.equal(snap.fulfillment.type, 'pre_order', 'never re-typed to a direct sale');
  assert.equal(snap.fulfillment.lead_time_min_days, 10, 'the route’s own lead time');
  assert.equal(snap.fulfillment.lead_time_max_days, 14);
  assert.equal(snap.gift.value_iqd, snap.regular_iqd);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ?', order.id), 0, 'a pre-order reserves no shelf');
  assert.equal(giftRow(raw, id).state, 'ordered');
  const again = await addGiftToCart(a.buyer, id);
  assert.equal((await json(again)).code, 'GIFT_ALREADY_ORDERED');
});

test('a gift beside bought lines: only the bought lines are charged, and every surface says which is the gift', async () => {
  const raw = giftWorld();
  raw.prepare("UPDATE users SET locale = 'en' WHERE id = 'buyer'").run();
  const a = apps(raw);
  const id = await giftInCart(a);
  const paid = await json(await post(a.buyer, '/api/cart/items', { productId: 'p_nozzle', optionValueIds: ['v_04'], colorId: 'c_red', qty: 1 }));
  assert.equal(paid.success, true, JSON.stringify(paid));

  const order = await placeOrder(a.buyer);
  assert.equal(order.order_kind, 'normal', 'a mixed order stays normal (D15)');
  const items = all<J>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY unit_price_iqd', order.id);
  assert.deepEqual(
    items.map((i) => [i.unit_price_iqd, i.gift_entitlement_id, i.gift_order_seq]),
    [[0, id, 1], [40000, null, null]],
    'the bought line is written exactly as before — no gift column'
  );
  assert.equal(row(raw, 'SELECT subtotal_iqd FROM orders WHERE id = ?', order.id)?.subtotal_iqd, 40000);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 2 }, 'both units off the same real counter');

  // THE INVOICE prints the gift as a gift, at 0, in the customer's language.
  await createInvoiceForOrder({ DB: asD1(raw) } as never, order.id);
  const snapshot = JSON.parse(String(row(raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', order.id)!.snapshot));
  const giftLine = snapshot.lines.find((l: Record<string, unknown>) => l.is_gift === true);
  assert.ok(giftLine, JSON.stringify(snapshot.lines));
  assert.equal(giftLine.unit_price_iqd, 0);
  assert.equal(giftLine.gift_value_iqd, 40000);
  assert.match(giftLine.variant, /^Gift · /);
  const bought = snapshot.lines.find((l: Record<string, unknown>) => l.is_gift !== true);
  assert.equal(bought.is_gift, undefined);
  assert.doesNotMatch(bought.variant, /Gift/);

  // THE GROUP'S ORDER MESSAGE marks it 🎁.
  const text = orderAnnouncement({ orderId: order.id, lines: [{ name: 'Nozzle kit', qty: 1, line: 0, gift: { gift_id: id } }, { name: 'Nozzle kit', qty: 1, line: 40000 }] });
  assert.match(text, /• 🎁 هدية: Nozzle kit × 1 — 0 د\.ع/);
  assert.match(text, /• Nozzle kit × 1 — 40,000 د\.ع/);
});

test('a gift and a bought line on the same scarce stock are judged together: refused whole, nothing consumed', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const id = await giftInCart(a);
  // v_04 holds 3: three bought units plus the gift's one ask for four.
  const paid = await json(await post(a.buyer, '/api/cart/items', { productId: 'p_nozzle', optionValueIds: ['v_04'], colorId: 'c_red', qty: 3 }));
  assert.equal(paid.success, true, JSON.stringify(paid));

  const res = await post(a.buyer, '/api/orders', orderBody());
  const body = await json(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 }, 'not one unit reserved');
  assert.equal(giftRow(raw, id).state, 'redeemed', 'the gift is still waiting, in the cart');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', id), 1);
});

test('an Arabic or Sorani account reads «هدية» / «دیاری» on its invoice', async () => {
  for (const [locale, label] of [['ar', 'هدية'], ['ku', 'دیاری']] as const) {
    const raw = giftWorld();
    raw.prepare('UPDATE users SET locale = ? WHERE id = ?').run(locale, 'buyer');
    const a = apps(raw);
    await giftInCart(a);
    const order = await placeOrder(a.buyer);
    await createInvoiceForOrder({ DB: asD1(raw) } as never, order.id);
    const snapshot = JSON.parse(String(row(raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', order.id)!.snapshot));
    assert.equal(snapshot.lines[0].variant.split(' · ')[0], label, locale);
  }
});

// ------------------------------------------------------------------ S8

test('S8: a gift earns no points and no membership discount, and leaves the coupon basis as it was', async () => {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_prem','buyer','prime_12mo','prime','active',12,299000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,discount_mode,percent,cap_scope,enabled,label)
      VALUES ('mbr_all','prime','product_discount','global','percent',10,'per_unit',1,'Premium 10%');
    INSERT INTO coupons (id,code,kind,value,min_total_iqd,active) VALUES ('cp1','SAVE10','percent',10,0,1);
  `);
  const a = apps(raw);
  // The SAME paid line, without and then with a gift beside it.
  paidLine(raw, 'ci_plain', 'p_plain', { fulfillmentType: 'direct_sale' });
  const before = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: 'SAVE10' })));
  assert.equal(before.success, true, JSON.stringify(before));
  await giftInCart(a);
  const after = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: 'SAVE10' })));
  assert.equal(after.success, true, JSON.stringify(after));

  const q0 = before.quote;
  const q1 = after.quote;
  assert.equal(q1.merchandise_iqd, q0.merchandise_iqd, 'the gift adds nothing to the merchandise');
  assert.equal(q1.points.earn_eligible_iqd, q0.points.earn_eligible_iqd, 'nor to the points basis');
  assert.equal(q1.coupon?.discount_iqd ?? 0, q0.coupon?.discount_iqd ?? 0, 'nor to the coupon');
  assert.equal(q1.membership_benefits.discount_total_iqd, q0.membership_benefits.discount_total_iqd, 'nor to the membership discount');
  const giftLine = q1.lines.find((l: J) => l.is_gift);
  assert.ok(!q1.membership_benefits.lines.some((l: J) => l.cart_item_id === giftLine.cart_item_id), 'no membership line names the gift');
});

test('S8: a gift line qualifies no support-code gift, no printer membership gift, no trade-in credit and no review reward', async () => {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,is_printer_catalog) VALUES ('gc_printers',NULL,'gc-printers','طابعات','Printers',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,support_gift_eligible)
      VALUES ('p_printer','gift-printer','Printer','طابعة',900000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','[]',1);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','gc_printers',0);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('reviewPointsConfig','{"enabled":true,"points":25}');
  `);
  const a = apps(raw);
  const id = await giftInCart(a, { productId: 'p_printer', saleType: 'direct_sale', optionValueIds: [], colorId: '' });
  const order = await placeOrder(a.buyer, {
    printerStandardDeliveryAcceptance: { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true },
  });
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), order.id);
  assert.equal(giftRow(raw, id).state, 'fulfilled');
  const db = asD1(raw);

  // The support-code referrer and the printer membership gift look only at bought lines.
  assert.equal(await orderHasSupportEligibleLine(db, order.id), false);
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('printerGiftConfig','{"enabled":true,"plan_id":"prime_12mo"}')`);
  assert.equal(await grantPrinterGiftIfEligible({ DB: db } as never, order.id), null);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'buyer'"), 0);

  // The same product BOUGHT does qualify — the rule is about the gift, not the product.
  raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord_paid','buyer','delivered','{}','standard','{}','cash',900000,0,1400,900000,0,'2026-09-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_paid','ord_paid','p_printer','Printer','',1,900000,900000);
  `);
  assert.equal(await orderHasSupportEligibleLine(db, 'ord_paid'), true);

  // A trade-in credit is capped by the BOUGHT target line, never a gift line.
  const tradeInCoupon = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          trade_in_id: 'ti_1', assigned_user_id: 'buyer', product_id: 'p_printer', option_value_id: null, color_id: null,
          status: 'awaiting_payment', user_id: 'buyer', coupon_id: 'cp_ti',
        }),
      }),
    }),
  } as unknown as D1Database;
  const giftOnly = [{ product_id: 'p_printer', unit: 0, gift: { gift_id: id } }];
  await assert.rejects(() => tradeInCouponCap(tradeInCoupon, 'buyer', 'cp_ti', giftOnly), /TRADE_IN_COUPON_MISMATCH|trade/i);
  assert.equal(await tradeInCouponCap(tradeInCoupon, 'buyer', 'cp_ti', [...giftOnly, { product_id: 'p_printer', unit: 900000 }]), 900000);

  // A review proved only by the gift line is published, and earns nothing.
  const review = await json(
    await post(a.buyer, '/api/reviews', {
      productId: 'p_printer',
      orderId: order.id,
      stars: 5,
      body: 'وصلتني الطابعة كهدية، التغليف ممتاز والطباعة الأولى كانت نظيفة جداً.',
    })
  );
  assert.equal(review.success, true, JSON.stringify(review));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM review_rewards'), 0, 'no reward row');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM points_awards WHERE source_ref LIKE 'review-fallback:%'"), 0, 'no fallback points');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'buyer' AND currency = 'POINT'"), 0);
});

test('S8: a gift-only pre-order earns no PRO filament spool; a bought one still does', async () => {
  const raw = proOnSale(giftWorld());
  raw.exec(`
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_pro','buyer','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap1','buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','','approved');
    INSERT OR REPLACE INTO admin_settings (key,value)
      VALUES ('preorderGiftConfig','{"enabled":true,"product_id":"p_plain","label_ar":"بكرة PLA","qty":1}');
  `);
  const a = apps(raw);
  await giftInCart(a, PLATE_AIR);
  const giftOrder = await placeOrder(a.buyer, { paymentMethodId: 'wallet', useWallet: true });
  assert.equal(giftOrder.order_kind, 'gift');
  assert.equal(giftOrder.membership_gift, null, 'a gift triggers no other reward');

  paidLine(raw, 'ci_plate', 'p_plate', { optionValueIds: ['v_pei'], colorId: 'c_black', fulfillmentType: 'pre_order', transport: 'air' });
  const bought = await placeOrder(a.buyer, { paymentMethodId: 'wallet', useWallet: true });
  assert.ok(bought.membership_gift, `the control earns the spool: ${JSON.stringify(bought.membership_gift)}`);
});

test('the gift line drives no line of a cancelled order back into the shelf twice, and quote lines stay ordinary for the rest', async () => {
  // A cart with a gift and an ordinary line quotes the ordinary line exactly as before.
  const raw = giftWorld();
  const a = apps(raw);
  paidLine(raw, 'ci_plain', 'p_plain', { fulfillmentType: 'direct_sale', qty: 2 });
  const plainOnly = await json(await post(a.buyer, '/api/orders/quote', quoteBody()));
  await redeemedGift(a, NOZZLE_04_RED).then((gid) => addGiftToCart(a.buyer, gid));
  const withGift = await json(await post(a.buyer, '/api/orders/quote', quoteBody()));
  const ordinary = (q: J) => q.quote.lines.find((l: J) => !l.is_gift);
  assert.deepEqual(ordinary(withGift), ordinary(plainOnly), 'the bought line is untouched by the gift beside it');
  assert.equal(ordinary(withGift).kind, undefined);

  // Cancelling the mixed order returns each unit to its own counter exactly once.
  const order = await placeOrder(a.buyer);
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 1 });
  const cancelled = await json(await post(a.buyer, `/api/orders/${order.id}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));
  assert.deepEqual(optionStock(raw, 'v_04'), { stock: 3, reserved: 0 });
  assert.equal(row(raw, "SELECT stock_reserved FROM products WHERE id = 'p_plain'")?.stock_reserved ?? 0, 0);
  await send(a.buyer, 'DELETE', '/api/cart');
});
