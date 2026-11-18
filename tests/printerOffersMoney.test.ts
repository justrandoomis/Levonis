/**
 * «خصص طابعتك», PHASE 4 — THE MONEY OF THE PRINTER'S OFFERS (DECISIONS row 355, money rules D1–D10):
 * the discount lives INSIDE the unit price (cart total = quote total = order total, line = unit × qty),
 * printer_discount_iqd + pricing_snapshot.printer_discount are report-only, a discounted line is an
 * offer-priced line (coupon already_discounted; a membership rule reads the price before), a chosen colour
 * is never swapped, «random» is picked again for the order and reserved, and the packing note names both.
 *
 * Fixture: tests/fixtures/printerOffers.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPrinter, appAs, attachedRows, get, json, liveConfig, orderBody, pending, post, setConfig, setup, type Json } from './fixtures/printerOffers';
import { applyPrinterDiscount, benefitRegularUnit, printerLineDiscount } from '../worker/lib/printerOffers';
import type { ResolvedPrice } from '../worker/lib/pricing';
import { ADDON_NOZZLE, KIT_FIXED } from './fixtures/printerOffers';

const resolvedOf = (over: Partial<ResolvedPrice> = {}): ResolvedPrice => ({
  regular_iqd: 10_000, pro_iqd: null, prime_iqd: null, applied_iqd: 10_000, applied_tier: 'regular', cost_iqd: 6_000, price_source: 'sku',
  member_rule: { pro: null, prime: null },
  fulfillment: { type: 'direct_sale', source: 'stated', from_option_cell: false, variant_key: '', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null },
  components: { base_iqd: 10_000, option_iqd: 10_000, fulfillment_iqd: 10_000, transport_iqd: 10_000, color_iqd: 10_000, membership_adjustment_iqd: 0, transport_fee_iqd: 0, direct_fee_iqd: 0, warranty_fee_iqd: 0 },
  transport: null, direct: null, pricing_basis: 'direct', warranty: null, unit_subtotal_iqd: 10_000, errors: [],
  regular_usd_cents: 700, applied_usd_cents: 700, unit_subtotal_usd_cents: 700,
  ...over,
} as ResolvedPrice);

test('applyPrinterDiscount: inside the unit (applied and unit subtotal), regular kept, struck price set, dollar twins dropped; nothing on a refused line or with no terms', () => {
  const config = liveConfig();
  const terms = printerLineDiscount(config, { kit_parent_id: 'ci_p', addon_id: 'nozzle', kit_unit_qty: 1 });
  assert.deepEqual(terms, { kind: 'addon', id: 'nozzle', discount: { mode: 'percent', value: 20 }, units: 1, revision: 7 });
  const { resolved, applied } = applyPrinterDiscount(resolvedOf({ unit_subtotal_iqd: 11_000, applied_usd_cents: undefined, unit_subtotal_usd_cents: undefined }), terms);
  assert.deepEqual([resolved.applied_iqd, resolved.unit_subtotal_iqd, resolved.regular_iqd, resolved.offer_before_iqd], [8_000, 9_000, 10_000, 10_000]);
  assert.equal(resolved.applied_usd_cents, undefined);
  assert.equal(resolved.unit_subtotal_usd_cents, undefined);
  assert.equal(resolved.regular_usd_cents, 700, 'the regular twin is the regular price, unchanged');
  assert.deepEqual(applied, { kind: 'addon', id: 'nozzle', mode: 'percent', value: 20, before_unit_iqd: 10_000, discount_unit_iqd: 2_000, revision: 7 });
  // A live offer already struck the line: its before stays (the price before the offer).
  assert.equal(applyPrinterDiscount(resolvedOf({ offer_before_iqd: 12_000 }), terms).resolved.offer_before_iqd, 12_000);
  // Refused, or no terms: untouched.
  const refused = resolvedOf({ errors: ['X'] });
  assert.equal(applyPrinterDiscount(refused, terms).resolved, refused);
  assert.equal(applyPrinterDiscount(resolvedOf(), null).applied, null);
  // A kit line: the kit's terms, the fixed amount split over every spool of the kit (2 units per printer).
  const kitTerms = printerLineDiscount(config, { kit_parent_id: 'ci_p', kit_id: 'a1-colour', kit_unit_qty: 1 });
  assert.equal(applyPrinterDiscount(resolvedOf(), kitTerms).applied?.discount_unit_iqd, 2_500);
  // An ordinary line, an inactive or undiscounted add-on: none.
  assert.equal(printerLineDiscount(config, { kit_parent_id: null }), null);
  assert.equal(printerLineDiscount(config, { kit_parent_id: 'ci_p', addon_id: 'petg-extra' }), null);
  assert.equal(printerLineDiscount(liveConfig({ addons: [{ ...ADDON_NOZZLE, active: false }] }), { kit_parent_id: 'ci_p', addon_id: 'nozzle' }), null);
});

test('membership (D10): a discounted line is read like an offer — the rule sees the price before, the regular unit is the discounted one', () => {
  const terms = printerLineDiscount(liveConfig(), { kit_parent_id: 'ci_p', addon_id: 'nozzle', kit_unit_qty: 1 });
  const { resolved, applied } = applyPrinterDiscount(resolvedOf(), terms);
  assert.equal(benefitRegularUnit(resolved, applied), 8_000, 'non-member: the «offer regular» is the after price');
  assert.equal(resolved.offer_before_iqd, 10_000, 'and the before is what a line-applied rule is worked out on');
  // A PRO member priced 9,000: 20% → 1,800 off; the rule reads regular 10,000 − 1,800, never below what is charged.
  const pro = applyPrinterDiscount(resolvedOf({ applied_iqd: 9_000, unit_subtotal_iqd: 9_000, applied_tier: 'pro', pro_iqd: 9_000 }), terms);
  assert.deepEqual([pro.resolved.applied_iqd, benefitRegularUnit(pro.resolved, pro.applied)], [7_200, 8_200]);
  assert.equal(benefitRegularUnit(resolvedOf(), null), 10_000, 'an undiscounted line is unchanged');
});

test('cart total = quote total = order total; line = unit × qty; the discount column and snapshot are report-only; the order view and the packing note name it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { kitId: 'a1-colour', kitColors: { p_petg: 'c_red' }, addonIds: ['nozzle'] }, 2);
  const cart = await json(await get(a, '/api/cart'));
  const cartGoods = cart.items.reduce((s: number, i: Json) => s + Number(i.unit_price_iqd) * Number(i.qty), 0);
  const q = (await json(await post(a, '/api/orders/quote', orderBody()))).quote;
  assert.equal(q.subtotal_iqd, cartGoods, 'cart = quote');
  // 2 printers: PETG 2 × 2,500 + PLA 2 × 2,500 + nozzle 2 × 2,000.
  assert.equal(q.printer_discount_iqd, 14_000);
  for (const l of q.lines) assert.equal(l.line_total_iqd, l.unit_price_iqd * l.qty, `${l.product_id}: unit × qty`);
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const order = raw.prepare('SELECT subtotal_iqd, total_iqd FROM orders WHERE id = ?').get(placed.order.id) as Json;
  assert.deepEqual([Number(order.subtotal_iqd), Number(order.total_iqd)], [q.subtotal_iqd, q.total_iqd], 'quote = order');
  const items = raw.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id').all(placed.order.id) as Json[];
  const byProduct = (pid: string) => items.find((i) => i.product_id === pid)!;
  const printer = byProduct('p_a1');
  const petg = byProduct('p_petg');
  const nozzle = byProduct('p_nozzle');
  assert.deepEqual([petg.unit_price_iqd, petg.qty, petg.line_total_iqd, petg.printer_discount_iqd, petg.kit_color_mode, petg.kit_id, petg.kit_parent_item_id, petg.color_id],
    [27_500, 2, 55_000, 5_000, 'chosen', 'a1-colour', printer.id, 'c_red']);
  assert.deepEqual([nozzle.unit_price_iqd, nozzle.line_total_iqd, nozzle.printer_discount_iqd, nozzle.addon_id, nozzle.kit_id, nozzle.kit_parent_item_id, nozzle.shipping_method_id],
    [8_000, 16_000, 4_000, 'nozzle', null, printer.id, '']);
  assert.equal(byProduct('p_pla').kit_color_mode, null, 'a fixed item records no colour mode');
  const snap = JSON.parse(String(nozzle.pricing_snapshot));
  assert.deepEqual(snap.printer_discount, { kind: 'addon', id: 'nozzle', mode: 'percent', value: 20, before_unit_iqd: 10_000, discount_unit_iqd: 2_000, revision: 7 });
  assert.equal(snap.applied_iqd, 8_000, 'the snapshot is the after price');
  assert.equal(printer.printer_discount_iqd, 0);
  // Σ order lines = subtotal: the discount is never a line of its own nor subtracted again.
  assert.equal(items.reduce((s, i) => s + Number(i.line_total_iqd), 0), Number(order.subtotal_iqd));
  const view = placed.order.items.find((i: Json) => i.product_id === 'p_nozzle');
  assert.deepEqual(view.addon, { printer_item_id: printer.id, addon_id: 'nozzle', color_mode: null });
  assert.deepEqual(view.printer_discount, { before_unit_iqd: 10_000, discount_unit_iqd: 2_000, total_iqd: 4_000 });
  assert.equal(placed.order.items.find((i: Json) => i.product_id === 'p_petg').kit.color_mode, 'chosen');
  const note = (raw.prepare("SELECT note FROM order_service_tasks WHERE order_id = ? AND kind = 'packaging'").get(placed.order.id) as { note: string }).note;
  assert.match(note, /باقة الفيلامنت/);
  assert.match(note, /لون اختاره الزبون/);
  assert.match(note, /الإضافات: فوهة 0\.4 ×2/);
  // The chosen colour is reserved on its own counter.
  assert.equal(Number((raw.prepare("SELECT reserved FROM product_colors WHERE id = 'c_red'").get() as Json).reserved), 2);
  await Promise.allSettled(pending);
});

test('coupon: a printer-discounted line is already discounted — a coupon that does not stack skips it; the same line without the discount takes it', async () => {
  const { db, raw } = setup();
  raw.exec(`INSERT INTO coupons (id,code,kind,value,min_total_iqd,active,scope,product_ids,stacks) VALUES ('cp1','NOZ10','percent',10,0,1,'products','["p_nozzle"]',0)`);
  const a = appAs(db, 'buyer');
  await addPrinter(a, { addonIds: ['nozzle'] });
  const withAddon = await json(await post(a, '/api/orders/quote', orderBody({ couponCode: 'NOZ10' })));
  const couponOff = (r: Json) => Number(r.quote?.coupon?.discount_iqd ?? r.quote?.coupon_discount_iqd ?? 0);
  // The only line the coupon names is the discounted add-on: it has nothing to discount.
  assert.equal(withAddon.code, 'NO_DISCOUNT', JSON.stringify(withAddon).slice(0, 400));
  // Without the owner's discount the same add-on line is an ordinary one.
  setConfig(raw, liveConfig({ addons: [{ ...ADDON_NOZZLE, discount: null }] }));
  const plain = await json(await post(a, '/api/orders/quote', orderBody({ couponCode: 'NOZ10' })));
  assert.equal(plain.success, true, JSON.stringify(plain).slice(0, 400));
  assert.equal(couponOff(plain), 1_000, '10% of the 10,000 nozzle');
});

test('checkout: a chosen colour that sold out is refused with its colour (never swapped); a random one is picked again, ordered and reserved', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { kitId: 'a1-colour', kitColors: { p_petg: 'c_red' } });
  raw.prepare("UPDATE product_colors SET stock = 0 WHERE id = 'c_red'").run();
  const refused = await json(await post(a, '/api/orders/quote', orderBody()));
  assert.equal(refused.code, 'OUT_OF_STOCK', JSON.stringify(refused));
  assert.deepEqual([refused.details.product_id, refused.details.color_id, refused.details.kit_id], ['p_petg', 'c_red', 'a1-colour']);
  assert.equal(attachedRows(raw).find((r) => r.product_id === 'p_petg')!.color_id, 'c_red', 'nothing swapped');

  // «random»: black was picked at the add; it sells out; the order takes blue and reserves it.
  raw.prepare("UPDATE product_colors SET stock = 3 WHERE id = 'c_red'").run();
  const b = setup();
  const ab = appAs(b.db, 'buyer');
  await addPrinter(ab, { kitId: 'a1-colour' });
  assert.equal(attachedRows(b.raw).find((r) => r.product_id === 'p_petg')!.color_id, 'c_black');
  b.raw.prepare("UPDATE product_colors SET stock = 0 WHERE id = 'c_black'").run();
  const q = (await json(await post(ab, '/api/orders/quote', orderBody()))).quote;
  assert.equal(q.lines.find((l: Json) => l.product_id === 'p_petg').kit_line.color_mode, 'random');
  const placed = await json(await post(ab, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const petg = b.raw.prepare("SELECT color_id, kit_color_mode FROM order_items WHERE order_id = ? AND product_id = 'p_petg'").get(placed.order.id) as Json;
  assert.deepEqual([petg.color_id, petg.kit_color_mode], ['c_blue', 'random']);
  assert.equal(Number((b.raw.prepare("SELECT reserved FROM product_colors WHERE id = 'c_blue'").get() as Json).reserved), 1);
  const note = (b.raw.prepare("SELECT note FROM order_service_tasks WHERE order_id = ? AND kind = 'packaging'").get(placed.order.id) as { note: string }).note;
  assert.match(note, /لون عشوائي — اختاره النظام من المخزون/);
  await Promise.allSettled(pending);
});

test('no discount, no change: an undiscounted kit is priced, stored and ordered exactly as before phase 4', async () => {
  // A kit stored before phase 4: no discount field, no colour mode.
  const { discount: _none, ...preKit } = { ...KIT_FIXED, items: [{ product_id: 'p_pla', option_value_ids: [], color_id: null, qty: 2 }] };
  const { db, raw } = setup({ config: liveConfig({ kits: [preKit], addons: [] }) });
  const a = appAs(db, 'buyer');
  await addPrinter(a, { kitId: 'a1-starter' });
  const cart = await json(await get(a, '/api/cart'));
  const pla = cart.items.find((i: Json) => i.kit_line);
  assert.deepEqual([pla.unit_price_iqd, pla.kit_line.printer_discount, pla.kit_line.color_mode], [25_000, undefined, 'fixed']);
  const placed = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const item = raw.prepare("SELECT unit_price_iqd, printer_discount_iqd, kit_color_mode, pricing_snapshot FROM order_items WHERE order_id = ? AND product_id = 'p_pla'").get(placed.order.id) as Json;
  assert.deepEqual([item.unit_price_iqd, item.printer_discount_iqd, item.kit_color_mode, JSON.parse(String(item.pricing_snapshot)).printer_discount], [25_000, 0, null, undefined]);
  await Promise.allSettled(pending);
});
