/**
 * «تفاصيل السعر» ADDS UP (owner, 2026-11-21; DECISIONS row 364).
 *
 * The admin order window's money rows come from ONE server reading of the stored order
 * (worker/lib/orderBreakdown.ts → `financial.breakdown`). For every kind of order «خصص طابعتك» can
 * write, the rows — each named, each signed — must add up to the order's total exactly, with no
 * «unexplained» row:
 *
 *   1. a Just Printer order under the price anchor (the services row is NEGATIVE)
 *   2. the Smart package under the anchor (services row 0: the price already includes it)
 *   3. the Complete package delivered to the home (services above Smart + the printer's own delivery)
 *   4. a store pickup (no delivery at all)
 *   5. a member's order with a membership discount taken after the subtotal
 *   6. a printer with a kit, an add-on, and a spare part under a Levo Care part offer
 *   7. a Levo Care draw-prize gift order (a 0 IQD line that ships)
 *   8. a membership bought with the printer (its own row; never counted on the waybill or the label)
 *
 * The orders are placed through the real checkout and read back through the real admin route.
 *
 * Run: node --import tsx --test tests/orderBreakdownSums.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { addPrinter, appAs, json, liveConfig, orderBody, pending, post, setup, type Json } from './fixtures/printerOffers';
import { asD1, stubApp, get as appGet, json as appJson } from './fixtures/app';
import { apps, giftInCart, giftWorld, placeOrder } from './fixtures/giftWorld';
import { seedCareOffer } from './fixtures/careOffer';
import { adminRoutes } from '../worker/routes/admin';
import { forgetPricingInputs } from '../worker/lib/membershipBenefits';
import { orderBreakdown } from '../worker/lib/orderBreakdown';
import { DEFAULT_PRINTER_SERVICES, presetSelection, type PrinterServicesConfig, type ServiceSelection } from '../packages/pricing/src/printerServices';

const adminOf = (db: D1Database, id = 'owner', email = 'owner@x.co') =>
  stubApp(db, { id, role: 'admin', email }, (a) => a.route('/api/admin', adminRoutes), { publishV2: false, env: { INITIAL_ADMIN_EMAIL: email } });

const anchored = (over: Partial<PrinterServicesConfig> = {}) => liveConfig({ price_anchor: 'smart', ...over });
const pkg = (id: 'just' | 'smart' | 'complete', delivery: ServiceSelection['delivery'] = 'economy'): ServiceSelection =>
  ({ ...presetSelection(DEFAULT_PRINTER_SERVICES, id, delivery), confirmed: true, ack_no_warranty: id === 'just' });

type Breakdown = { rows: Array<{ key: string; amount_iqd: number }>; total_iqd: number; subtotal_iqd: number; balanced: boolean };

/** The order as the admin window reads it, with its breakdown proven to add up to the stored total. */
async function adminOrder(raw: DatabaseSync, db: D1Database, orderId: string, admin = adminOf(db)) {
  const res = await appGet(admin, `/api/admin/orders/${orderId}?lang=ar`);
  const body = await appJson(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  const order = body.order as Json;
  const b = order.financial.breakdown as Breakdown;
  const stored = raw.prepare('SELECT total_iqd, subtotal_iqd FROM orders WHERE id = ?').get(orderId) as { total_iqd: number; subtotal_iqd: number };
  const sum = b.rows.reduce((n, r) => n + r.amount_iqd, 0);
  assert.equal(sum, Number(stored.total_iqd), `the rows add up to the order total: ${JSON.stringify(b.rows)}`);
  assert.equal(b.total_iqd, Number(stored.total_iqd));
  assert.equal(b.balanced, true);
  assert.equal(b.rows.some((r) => r.key === 'unexplained'), false, 'nothing is left unexplained');
  // The four rows above the discounts are the stored subtotal.
  const above = b.rows.filter((r) => ['goods', 'printer_services', 'membership', 'other_fees'].includes(r.key)).reduce((n, r) => n + r.amount_iqd, 0);
  assert.equal(above, Number(stored.subtotal_iqd), 'goods + services + membership + other fees = the stored subtotal');
  const row = (key: string) => b.rows.find((r) => r.key === key)?.amount_iqd;
  return { order, b, row, total: Number(stored.total_iqd) };
}

async function place(a: ReturnType<typeof appAs>, over: Record<string, unknown> = {}) {
  const res = await post(a, '/api/orders', orderBody(over));
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 600));
  return body.order as Json;
}

test('1 · Just Printer under the anchor: goods at the catalogue price, the services row is the negative the customer saved, and it adds up', async () => {
  const { db, raw } = setup({ config: anchored() });
  const a = appAs(db, 'buyer');
  await addPrinter(a, { services: pkg('just') });
  const placed = await place(a);
  const { order, row, total } = await adminOrder(raw, db, placed.id);
  assert.equal(row('goods'), 840_000, 'the printer at its catalogue price');
  assert.equal(row('printer_services'), -44_000, 'the Smart package the price included, not bought');
  assert.equal(row('printer_delivery'), 5_000);
  assert.equal(total, 840_000 - 44_000 + 5_000 + (row('cod_tax') ?? 0));
  const line = order.items.find((i: Json) => i.product_id === 'p_a1');
  assert.deepEqual([line.services.net_fee_iqd, line.services.anchor_fee_iqd, line.services.fee_iqd, line.services.warranty_months], [-44_000, 44_000, 0, 0]);
  assert.equal(line.services.selection.ack_no_warranty, true, 'the «no warranty» agreement is on the view');
  assert.equal('cover' in line.services, false, 'no end dates before delivery');
  await Promise.allSettled(pending);
});

test('2 · Smart under the anchor: the services row is drawn and is 0 — the price already includes the package', async () => {
  const { db, raw } = setup({ config: anchored() });
  const a = appAs(db, 'buyer');
  await addPrinter(a, { services: pkg('smart') });
  const placed = await place(a);
  const { order, row, b } = await adminOrder(raw, db, placed.id);
  assert.equal(row('goods'), 840_000);
  assert.equal(row('printer_services'), 0);
  assert.ok(b.rows.some((r) => r.key === 'printer_services'), 'a serviced order always names its services row');
  const line = order.items.find((i: Json) => i.product_id === 'p_a1');
  assert.deepEqual([line.services.warranty_months, line.services.care_total_months, 'ack_no_warranty' in line.services.selection], [12, 24, false]);
  await Promise.allSettled(pending);
});

test('3 · Complete to the home: what Complete adds over Smart, and the printer\'s own delivery split out of «التوصيل»', async () => {
  const { db, raw } = setup({ config: anchored() });
  const a = appAs(db, 'buyer');
  await addPrinter(a, { services: pkg('complete') }, 2);
  const placed = await place(a);
  const { order, row, b } = await adminOrder(raw, db, placed.id);
  const line = order.items.find((i: Json) => i.product_id === 'p_a1');
  assert.ok(line.services.net_fee_iqd > 0);
  assert.equal(row('goods'), 2 * 840_000);
  assert.equal(row('printer_services'), 2 * line.services.net_fee_iqd);
  assert.equal(row('printer_delivery'), 2 * 5_000, 'Economy for the class, per printer');
  assert.equal(b.rows.some((r) => r.key === 'delivery'), false, 'nothing else was delivered');
  assert.deepEqual([order.financial.breakdown.delivery.printer_units, order.financial.breakdown.delivery.printer_delivery], [2, 'economy']);
  // Delivered: the two dates the months run to.
  raw.prepare("UPDATE order_service_tasks SET status = 'done', done_by = 'owner', done_at = '2026-11-21T08:00:00.000Z', result_note = 'ok' WHERE order_id = ?").run(placed.id);
  raw.prepare("UPDATE orders SET delivered_at = '2026-11-22T09:00:00.000Z' WHERE id = ?").run(placed.id);
  const after = (await adminOrder(raw, db, placed.id)).order;
  const cover = after.items.find((i: Json) => i.product_id === 'p_a1').services.cover;
  assert.deepEqual(cover, { from: '2026-11-22T09:00:00.000Z', warranty_end_at: '2028-11-22T09:00:00.000Z', care_end_at: '2029-11-22T09:00:00.000Z' });
  // Who closed each task, by NAME — never an id.
  assert.ok(after.service_tasks.length >= 2);
  for (const t of after.service_tasks) {
    assert.equal(t.done_by_name, 'Owner');
    assert.ok(t.text && t.text.ar && t.text.en && t.text.ckb, `${t.kind}: words in three languages`);
    assert.doesNotMatch(`${t.text.ar}${t.text.en}${t.text.ckb}`, /\(0 د\.ع\)|undefined|null/);
  }
  await Promise.allSettled(pending);
});

test('4 · store pickup: no delivery charge and no printer-delivery row; the line records «pickup»', async () => {
  const { db, raw } = setup({ config: anchored() });
  const a = appAs(db, 'buyer');
  await addPrinter(a, { services: pkg('smart') });
  const placed = await place(a, { deliveryMethodId: 'pickup' });
  const { order, row, b, total } = await adminOrder(raw, db, placed.id);
  assert.equal(row('delivery'), 0);
  assert.equal(b.rows.some((r) => r.key === 'printer_delivery'), false);
  assert.equal(total, 840_000);
  assert.equal(order.items.find((i: Json) => i.product_id === 'p_a1').services.delivery, 'pickup');
  await Promise.allSettled(pending);
});

test('5 · a member\'s order: the membership discount taken after the subtotal is its own row and the breakdown still adds up', async () => {
  const { db, raw } = setup({ config: anchored() });
  raw.exec(`
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_pro','buyer','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    UPDATE users SET membership_tier = 'pro' WHERE id = 'buyer';
    -- PRO is paused on live (0145) and then earns no product discount; these are its mechanics, proven with it on sale.
    UPDATE admin_settings SET value = '{"paused":false,"since":null}' WHERE key = 'proPause';
    -- A quantity-limited rule cannot live in the unit price: it is deducted after the subtotal, like a coupon.
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,discount_mode,percent,max_quantity,enabled,priority)
      VALUES ('mbr_one_unit','pro','product_discount','global','percent',10,1,1,0);
  `);
  forgetPricingInputs(db);
  const a = appAs(db, 'buyer');
  const added = await post(a, '/api/cart/items', { productId: 'p_pla', qty: 2 });
  assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
  const placed = await place(a);
  const { row, order } = await adminOrder(raw, db, placed.id);
  const stored = JSON.parse(String((raw.prepare('SELECT benefit_snapshot FROM orders WHERE id = ?').get(placed.id) as Json).benefit_snapshot));
  assert.ok(stored.line_discount_iqd > 0, `the rule was applied after the subtotal: ${JSON.stringify(stored).slice(0, 300)}`);
  assert.equal(row('membership_discount'), -stored.line_discount_iqd);
  // The row the old screen could not show: without it the member's rows were short by exactly this.
  const old = order.financial.subtotal_iqd - order.financial.coupon_discount_iqd - order.financial.points_value_iqd + order.financial.shipping_iqd + order.financial.cod_tax_iqd;
  assert.equal(old - order.financial.total_iqd, stored.line_discount_iqd);
  await Promise.allSettled(pending);
});

test('6 · kit + add-on + a part under a Levo Care offer: the Care discount is its own row (never «كوبون»), the attached lines name their printer', async () => {
  const { db, raw } = setup({ config: anchored() });
  seedCareOffer(raw, { user: 'buyer', product: 'p_petg', pct: 50 });
  const a = appAs(db, 'buyer');
  await addPrinter(a, { services: pkg('smart'), kitId: 'a1-starter', addonIds: ['nozzle'] });
  const part = await post(a, '/api/cart/items', { productId: 'p_petg', qty: 1, colorId: 'c_blue' });
  assert.equal(part.status, 200, JSON.stringify(await json(part.clone())));
  const placed = await place(a);
  const { order, row, b } = await adminOrder(raw, db, placed.id);
  assert.equal(row('care_offer'), -15_000, '50% of the 30,000 part');
  assert.equal(b.rows.some((r) => r.key === 'coupon'), false, 'no code was typed: no coupon row');
  assert.equal(order.financial.breakdown.coupon, null);
  // 840,000 printer + 2 × 22,500 kit spools + 8,000 nozzle + 30,000 part.
  assert.equal(row('goods'), 840_000 + 45_000 + 8_000 + 30_000);
  const printer = order.items.find((i: Json) => i.product_id === 'p_a1');
  const pla = order.items.find((i: Json) => i.product_id === 'p_pla');
  const nozzle = order.items.find((i: Json) => i.product_id === 'p_nozzle');
  const petg = order.items.find((i: Json) => i.product_id === 'p_petg');
  assert.equal(pla.kit.printer_item_id, printer.id);
  assert.equal(nozzle.addon.printer_item_id, printer.id);
  assert.deepEqual([petg.care_offer.discount_iqd, 'kit' in petg, 'addon' in petg], [15_000, false, false]);
  // The receipt names it too, and no longer prints it as «خصم الكود».
  const receipt = await (await appGet(adminOf(db), `/api/admin/orders/${placed.id}/receipt`)).text();
  assert.match(receipt, /خصم ليفو كير على قطعة/);
  assert.doesNotMatch(receipt, /خصم الكود/);
  assert.match(receipt, /الباقة: الاختيار الذكي/);
  assert.match(receipt, /ضمن باقة الفيلامنت مع الطابعة/);
  await Promise.allSettled(pending);
});

test('7 · a Levo Care draw-prize gift order: a 0 IQD line that ships, marked as the draw\'s prize, and the total is the delivery alone', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const giftId = await giftInCart(a);
  const placed = await placeOrder(a.buyer);
  raw.prepare(
    `INSERT INTO care_draws (id, month, state, candidates, winner_user_id, prize_product_id, prize_qty, gift_id, confirmed_by, confirmed_at)
     VALUES ('cd_1', '2026-11', 'confirmed', 3, 'buyer', 'p_nozzle', 1, ?, 'boss', '2026-11-01T08:00:00.000Z')`
  ).run(giftId);
  const db = asD1(raw);
  const admin = adminOf(db, 'boss', 'boss@x.co');
  const { order, row, total } = await adminOrder(raw, db, placed.id, admin);
  assert.equal(row('goods'), 0, 'the prize costs the customer nothing');
  assert.equal(total, row('delivery'));
  assert.ok(total > 0, 'delivery rules apply to a gift order');
  const line = order.items[0];
  assert.equal(line.is_gift, true);
  assert.deepEqual(order.draw_prize_item_ids, [line.id]);
  // It is a physical line: the label counts it.
  const label = await (await appGet(admin, `/api/admin/orders/${placed.id}/label`)).text();
  assert.match(label, />1</, 'one piece on the sticker');
});

test('8 · a membership bought with the printer: its own row; the sticker counts the printer only', async () => {
  const { db, raw } = setup({ config: anchored() });
  const a = appAs(db, 'buyer');
  const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: pkg('smart'), membershipPlanId: 'plus_1mo' });
  const addedBody = await json(added);
  assert.equal(added.status, 200, JSON.stringify(addedBody));
  const quote = (await json(await post(a, '/api/orders/quote', orderBody()))).quote;
  assert.ok(quote.membership, 'the membership is on the quote');
  const placed = await place(a, { membershipChargeIqd: quote.membership.charge_iqd });
  const { row, order } = await adminOrder(raw, db, placed.id);
  assert.equal(row('membership'), quote.membership.charge_iqd);
  assert.equal(row('goods'), 840_000);
  assert.ok(order.items.some((i: Json) => i.kind === 'membership'));
  const items = raw.prepare('SELECT * FROM order_items WHERE order_id = ?').all(placed.id) as Json[];
  assert.equal(items.reduce((n, i) => n + Number(i.qty), 0), 2, 'two lines: the printer and the membership');
  const label = await (await appGet(adminOf(db), `/api/admin/orders/${placed.id}/label`)).text();
  assert.match(label, />1</);
  assert.doesNotMatch(label, />2</, 'the membership is not a piece in the parcel');
  await Promise.allSettled(pending);
});

test('a stored order that does not reconcile says so in its own row — never a figure bent to fit; an order before the snapshots reads as before', () => {
  const o = { subtotal_iqd: 100_000, total_iqd: 104_000, shipping_iqd: 5_000, coupon_snapshot: null, points_discount_iqd: 0, cod_tax_iqd: 0 };
  const items = [{ id: 'i1', qty: 1, line_total_iqd: 100_000 }];
  const b = orderBreakdown(o, items, 100_000);
  assert.deepEqual(b.rows, [{ key: 'goods', amount_iqd: 100_000 }, { key: 'delivery', amount_iqd: 5_000 }, { key: 'unexplained', amount_iqd: -1_000 }]);
  assert.equal(b.balanced, false);
  // A legacy order with a transport commission: merchandise + other fees, nothing else, as the old two rows.
  const legacy = orderBreakdown({ subtotal_iqd: 120_000, total_iqd: 125_000, shipping_iqd: 5_000 }, [{ id: 'i1', qty: 1, line_total_iqd: 120_000 }], 100_000);
  assert.deepEqual(legacy.rows, [{ key: 'goods', amount_iqd: 100_000 }, { key: 'other_fees', amount_iqd: 20_000 }, { key: 'delivery', amount_iqd: 5_000 }]);
  assert.deepEqual([legacy.balanced, legacy.services], [true, null]);
});
