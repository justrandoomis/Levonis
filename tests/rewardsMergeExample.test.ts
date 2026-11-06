/**
 * THE OWNER'S OWN EXAMPLE, THROUGH THE REAL CHECKOUT (DECISIONS rows 295 and 299).
 *
 *   «the coupons can merge together < like he have 4 printer so 15% dicount on 4 pics of
 *    filament esun pla plus. and free 4 coupons 20000 deleivery like he order 50pc of
 *    filament that 25000 shipping so 20000 discount on same order >»
 *
 * Four printers under warranty, this week's coupons issued by the real sweep, on eSUN PLA+
 * ticked in the owner's settings. The owner's fee is the delivery policy's own rule: 5,000
 * per started block of 10 pieces of filament, so 50 pieces are 25,000.
 *
 * THE LIVE eSUN IS ON AN OPEN-ENDED OFFER (27,250 struck to 24,000), and the fixture holds it
 * so. His example then needs one ruling from him: either the coupon works on a piece with an
 * offer (`filament.on_offer`, the road these tests take unless they say otherwise) or the
 * offer ends and 24,000 is the regular price. The last test proves the other answer: with the
 * switch off the coupon honestly takes nothing, and says why.
 *
 * Real migrations, real triggers, the real cart and checkout; only the session is stubbed.
 * Run: node --import tsx --test tests/rewardsMergeExample.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, row } from './fixtures/app';
import { apps, json, paidLine, placeOrder, post, quoteBody, type J } from './fixtures/giftWorld';
import { DAY, envOf, printerOrder, productAt, readCoupons } from './fixtures/rewardsWorld';
import { ESUN_UNIT_IQD, esunWorld, setTerms, shopApps } from './fixtures/shopWorld';
import { listUserRewardCoupons } from '../worker/lib/rewards/coupons';
import { runRewardSweep } from '../worker/lib/rewards/sweep';

const FIFTEEN_PERCENT = ESUN_UNIT_IQD * 0.15; // 3,600 IQD: one piece of eSUN PLA+

/** 5,000 per started block of 10 pieces of filament. */
function filamentByTheBlock(raw: DatabaseSync) {
  const policy = JSON.parse(row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'deliveryPolicy'")!.value);
  policy.groups.push({ id: 'g_filament', name: { ar: 'فلامنت', en: 'Filament', ckb: 'فیلامێنت' }, enabled: true, mode: 'per_block', fee_iqd: 5_000, block_size: 10, catalog_ids: ['cat_materials_fdm'], product_ids: [] });
  raw.prepare("UPDATE admin_settings SET value = ? WHERE key = 'deliveryPolicy'").run(JSON.stringify(policy));
}

/** Four printers delivered a week and a day ago, with the owner's terms, and this week's coupons from the real sweep. */
async function fourPrinters(onOffer = true) {
  const now = Date.now();
  const raw = esunWorld(now - 30 * DAY);
  setTerms(raw, { filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: ['p_esun'], max_pieces: 1, on_offer: onOffer } });
  filamentByTheBlock(raw);
  await printerOrder(raw, 4, new Date(now - 8 * DAY).toISOString());
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 0, 'the first week has gone');
  const report = await runRewardSweep(envOf(raw), new Date(now).toISOString());
  assert.equal(report.weekly.issued, 8);
  const a = apps(raw);
  return { raw, a };
}

const grants = (raw: DatabaseSync) =>
  all<{ kind: string; source_ref: string; code: string; value: number; min_total_iqd: number; max_quantity: number | null; product_ids: string; scope: string }>(
    raw,
    `SELECT g.kind, g.source_ref, c.code, c.value, c.min_total_iqd, c.max_quantity, c.product_ids, c.scope
       FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id ORDER BY g.kind, g.source_ref`
  );

test('four printers under warranty: this week four delivery coupons and four filament coupons, on eSUN PLA+', async () => {
  const { raw } = await fourPrinters();
  const all8 = grants(raw);
  assert.equal(all8.length, 8);
  const ship = all8.filter((g) => g.kind === 'free_shipping');
  const fil = all8.filter((g) => g.kind === 'filament_discount');
  assert.equal(ship.length, 4);
  assert.equal(fil.length, 4);
  assert.ok(all8.every((g) => g.source_ref.endsWith(':w1')), 'this week’s, the second of the warranty');
  assert.ok(ship.every((g) => g.value === 5_000 && g.min_total_iqd === 100_000), '5,000 off the delivery on an order over 100,000');
  assert.ok(fil.every((g) => g.value === 15 && g.max_quantity === 1 && g.scope === 'products' && g.product_ids === '["p_esun"]'), '15% off one piece of eSUN PLA+');
  assert.equal(new Set(all8.map((g) => g.source_ref.split(':')[2])).size, 4, 'one pair from each of the four printers');
});

test('50 pieces with a 25,000 fee: 15% off 4 pieces only, exactly 20,000 off the delivery, on the same order', async () => {
  const { raw, a } = await fourPrinters();
  paidLine(raw, 'ci_esun', 'p_esun', { qty: 50, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });

  const plain = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote as J;
  assert.equal(plain.merchandise_iqd, 50 * ESUN_UNIT_IQD);
  assert.equal(plain.lines[0].qty, 50);
  assert.equal(plain.shipping.total_iqd, 25_000, 'the owner’s own fee: five blocks of ten');

  const code = grants(raw)[0].code;
  const read = await readCoupons(a.buyer, { delivery_iqd: '25000' });
  assert.deepEqual([read.preview.merchandise_iqd, read.preview.delivery_iqd, read.preview.count], [14_400, 20_000, 8], 'the cart says the same before the customer leaves it');
  const out = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.equal(out.success, true, JSON.stringify(out));
  const c = out.quote.coupon as J;
  assert.equal(c.merchandise_iqd, 4 * FIFTEEN_PERCENT, '14,400: four pieces, never the other 46');
  assert.equal(c.delivery_iqd, 20_000, 'four coupons of 5,000, and the last 5,000 of the fee stays');
  assert.equal(c.discount_iqd, 34_400);
  assert.equal(c.pool.length, 8, 'all eight, from one code');
  assert.ok(c.pool.filter((u: J) => u.kind === 'free_shipping' || u.delivery_iqd > 0).every((u: J) => u.total_iqd === 5_000), 'each delivery coupon took its own 5,000');
  assert.equal(out.quote.total_iqd, plain.total_iqd - 34_400, 'and the customer pays that much less');

  const order = await placeOrder(a.buyer, { couponCode: code });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ? AND state = 'active'", order.id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemption_extras WHERE order_id = ? AND state = 'active'", order.id), 7, 'eight coupons on one order');
  const spent =
    row<{ n: number }>(raw, 'SELECT COALESCE(SUM(amount_iqd),0) AS n FROM coupon_redemptions WHERE order_id = ?', order.id)!.n +
    row<{ n: number }>(raw, 'SELECT COALESCE(SUM(amount_iqd),0) AS n FROM coupon_redemption_extras WHERE order_id = ?', order.id)!.n;
  assert.equal(spent, 34_400, 'the rows add up to the order’s discount');
  assert.equal(row<{ n: number }>(raw, 'SELECT COALESCE(SUM(coupon_discount_iqd),0) AS n FROM order_items WHERE order_id = ?', order.id)!.n, 14_400, 'the goods part on the line');
  const views = await listUserRewardCoupons(a.db, 'buyer');
  assert.deepEqual(views.map((v) => v.state), Array(8).fill('used'));
  assert.ok(views.every((v) => v.used_on_order_id === order.id));
});

test('2 pieces over 100,000 with a 5,000 fee: it spends what it can, 2 filament and 1 delivery, and the other five stay live', async () => {
  const { raw, a } = await fourPrinters();
  productAt(raw, 'p_big', 100_000);
  paidLine(raw, 'ci_esun', 'p_esun', { qty: 2, optionValueIds: ['v_esun'], colorId: 'c_esun_beige', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_big', 'p_big', { qty: 1, fulfillmentType: 'direct_sale' });

  const plain = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote as J;
  assert.equal(plain.merchandise_iqd, 148_000);
  assert.equal(plain.shipping.total_iqd, 5_000);

  const code = grants(raw)[0].code;
  const c = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })))).quote.coupon as J;
  assert.equal(c.merchandise_iqd, 2 * FIFTEEN_PERCENT, 'only the two pieces it can see');
  assert.equal(c.delivery_iqd, 5_000, 'the whole fee, by one coupon: a second has nothing left to take');
  assert.equal(c.pool.length, 3);

  const order = await placeOrder(a.buyer, { couponCode: code });
  const views = await listUserRewardCoupons(a.db, 'buyer');
  const by = (kind: string, state: string) => views.filter((v) => v.kind === kind && v.state === state).length;
  assert.deepEqual([by('filament_discount', 'used'), by('free_shipping', 'used')], [2, 1]);
  assert.deepEqual([by('filament_discount', 'active'), by('free_shipping', 'active')], [2, 3], 'the rest stays for the next order');
  assert.ok(views.filter((v) => v.state === 'used').every((v) => v.used_on_order_id === order.id));
});

test('2 pieces under 100,000: the filament coupons spend, every delivery coupon waits for an order over its minimum', async () => {
  const { raw, a } = await fourPrinters();
  paidLine(raw, 'ci_esun', 'p_esun', { qty: 2, optionValueIds: ['v_esun'], colorId: 'c_esun_white', fulfillmentType: 'direct_sale' });
  const plain = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote as J;
  assert.equal(plain.merchandise_iqd, 48_000);

  const code = grants(raw).find((g) => g.kind === 'filament_discount')!.code;
  const c = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })))).quote.coupon as J;
  assert.equal(c.merchandise_iqd, 2 * FIFTEEN_PERCENT);
  assert.equal(c.delivery_iqd, 0, 'nothing off the delivery');
  assert.equal(c.pool.length, 2);

  await placeOrder(a.buyer, { couponCode: code });
  const views = await listUserRewardCoupons(a.db, 'buyer');
  assert.equal(views.filter((v) => v.state === 'used').length, 2);
  assert.equal(views.filter((v) => v.kind === 'free_shipping' && v.state === 'active').length, 4);
  assert.equal(views.filter((v) => v.kind === 'filament_discount' && v.state === 'active').length, 2);
});

test('the coupons never reach a gift of the same filament: a line swapped for points beside bought pieces takes none', async () => {
  const { raw } = await fourPrinters();
  paidLine(raw, 'ci_esun', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });
  raw.prepare("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_m','buyer','deposit','POINT',30000,'approved')").run();
  raw.prepare("UPDATE admin_settings SET value = json_set(value, '$.shop.items', json(?)) WHERE key = 'rewardProgramConfig'").run(
    JSON.stringify([{ id: 'esun_beige', product_id: 'p_esun', option_value_ids: ['v_esun'], color_id: 'c_esun_beige', qty: 1, sale_type: 'direct_sale', transport_method: '', points: 23_000, enabled: true }])
  );
  const b = shopApps(raw);
  const swap = await json(await post(b.buyer, '/api/rewards/program/shop/items/esun_beige'));
  assert.equal(swap.success, true, JSON.stringify(swap));
  assert.equal((await post(b.buyer, '/api/cart/gift-items', { giftId: swap.gift.id })).status, 200);

  const code = grants(raw).find((g) => g.kind === 'filament_discount')!.code;
  const c = (await json(await post(b.buyer, '/api/orders/quote', quoteBody({ couponCode: code })))).quote.coupon as J;
  assert.equal(c.merchandise_iqd, FIFTEEN_PERCENT, 'one bought piece, one coupon; the gift line is 0 and takes nothing');
  assert.equal(c.pool.length, 1);
});

test('the live offer with the switch off: 14,400 becomes 0, the delivery part stands, and the card says why rather than «no filament»', async () => {
  const { raw, a } = await fourPrinters(false);
  assert.ok(grants(raw).filter((g) => g.kind === 'filament_discount').length === 4);
  paidLine(raw, 'ci_esun', 'p_esun', { qty: 50, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });

  const read = await readCoupons(a.buyer, { delivery_iqd: '25000' });
  assert.deepEqual(read.coupons.filter((x: J) => x.kind === 'filament_discount').map((x: J) => [x.state, x.take_iqd, x.on_offer]), Array(4).fill(['on_offer', 0, false]));
  assert.deepEqual([read.preview.merchandise_iqd, read.preview.delivery_iqd, read.preview.count], [0, 20_000, 4]);

  const c = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: read.preview.code })))).quote.coupon as J;
  assert.deepEqual([c.merchandise_iqd ?? 0, c.delivery_iqd, c.pool.length], [0, 20_000, 4], 'the quote says the same');
});

test('the switch is frozen on the coupon: what it was minted with is what it does, whatever the settings say now', async () => {
  const { raw, a } = await fourPrinters(true);
  setTerms(raw, { filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: ['p_esun'], max_pieces: 1, on_offer: false } });
  paidLine(raw, 'ci_esun', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });
  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.equal(read.preview.merchandise_iqd, FIFTEEN_PERCENT, 'minted to work on an offer, so it does');
  assert.ok(read.coupons.filter((x: J) => x.kind === 'filament_discount').every((x: J) => x.on_offer === true));
});

test('each coupon has its own ceiling: 15% of a 200,000 piece is 30,000, and a coupon takes 25,000 of it, four times', async () => {
  const { raw, a } = await fourPrinters();
  productAt(raw, 'p_pricey', 200_000, { category: 'cat_materials_fdm' });
  // The coupons name what was ticked when they were minted: these four name this filament too.
  raw.exec(`UPDATE coupons SET product_ids = '["p_esun","p_pricey"]' WHERE kind = 'percent' AND reward_grant_id IS NOT NULL`);
  paidLine(raw, 'ci_pricey', 'p_pricey', { qty: 10, fulfillmentType: 'direct_sale' });
  const code = grants(raw).find((g) => g.kind === 'filament_discount')!.code;
  const c = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })))).quote.coupon as J;
  assert.equal(c.merchandise_iqd, 4 * 25_000);
  assert.deepEqual(c.pool.filter((u: J) => u.merchandise_iqd > 0).map((u: J) => u.merchandise_iqd), [25_000, 25_000, 25_000, 25_000]);
});
