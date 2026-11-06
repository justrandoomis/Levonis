/**
 * THE COUPON LANDS ON THE PRODUCT (owner, 2026-11-05: «from user side with apply on cart
 * product»; DECISIONS row 298), THROUGH THE REAL ROUTERS.
 *
 * The cart's read and the checkout's quote are two doors onto one resolver, so the
 * thing proved here is that they agree, dinar for dinar and coupon by coupon, in every
 * case the owner's programme can reach: a filament piece, two coupons, a delivery coupon
 * at its minimum and under it, an offer-priced line, a membership-discounted line, a
 * ticked subset, a gift line, a bundle, a free delivery and an unknown one.
 *
 * Real migrations, real triggers, real cart and checkout; only the session is stubbed.
 * Run: node --import tsx --test tests/cartRewardCoupons.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, dbThrough, proOnSale, row, stubApp, type App } from './fixtures/app';
import { BUYER, PLAIN, apps, get, giftInCart, json, paidLine, placeOrder, post, quoteBody, type J } from './fixtures/giftWorld';
import { handCoupon, printerOrder, productAt, readCoupons, rewardsWorld } from './fixtures/rewardsWorld';
import { esunWorld, setTerms } from './fixtures/shopWorld';
import { addBundle, seedCatalogue } from './lib/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { forgetPricingInputs } from '../worker/lib/membershipBenefits';
import { rewardText } from '../worker/lib/rewards/strings';

/** The read at the quote's own fee, and the quote its code opens: they must say the same, per coupon. */
async function sameAsQuote(app: App, body: Record<string, unknown> = {}) {
  const itemIds = (body.itemIds as string[] | undefined) ?? [];
  const plain = await json(await post(app, '/api/orders/quote', quoteBody(body)));
  assert.equal(plain.success, true, JSON.stringify(plain));
  const fee = Number(plain.quote.shipping.total_iqd);
  const read = await readCoupons(app, { delivery_iqd: String(fee), ...(itemIds.length ? { item_ids: itemIds.join(',') } : {}) });
  assert.ok(read.preview, `nothing opens: ${JSON.stringify(read)}`);
  const quote = await json(await post(app, '/api/orders/quote', quoteBody({ ...body, couponCode: read.preview.code })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  const c = quote.quote.coupon;
  assert.equal(read.preview.merchandise_iqd, Number(c.merchandise_iqd ?? 0), 'the goods part');
  assert.equal(read.preview.delivery_iqd, Number(c.delivery_iqd ?? 0), 'the delivery part');
  assert.equal(read.preview.total_iqd, Number(c.discount_iqd), 'the whole discount');
  assert.equal(read.preview.count, c.pool.length, 'how many coupons it spends');
  assert.deepEqual(
    read.coupons.filter((x: J) => x.state === 'applies').map((x: J) => [x.code, x.take_iqd]).sort(),
    c.pool.map((u: J) => [u.code, u.total_iqd]).sort(),
    'and what each one takes'
  );
  assert.equal(quote.quote.total_iqd, plain.quote.total_iqd - Number(c.discount_iqd), 'the total the customer would pay');
  return { read, quote, plain, fee };
}

const state = (read: J) => read.coupons.map((x: J) => `${x.kind}:${x.state}:${x.take_iqd}`).sort();

// ------------------------------------------------------------------ the preview is the quote

test('one filament piece: the coupon lands on the line, and the delivery coupon says what it still needs', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 3, fulfillmentType: 'direct_sale' });

  const { read } = await sameAsQuote(a.buyer);
  assert.deepEqual(read.preview.lines, [{ line_id: 'ci_fil', amount_iqd: 2_250 }], '15% of ONE piece at 15,000, not of three');
  assert.deepEqual(state(read), ['filament_discount:applies:2250', 'free_shipping:min_not_met:0']);
  const ship = read.coupons.find((x: J) => x.kind === 'free_shipping');
  assert.equal(ship.short_of_iqd, 100_000 - (45_000 - 2_250), 'on the goods after the coupon');
  assert.equal(read.preview.blocked_min_total_iqd, 100_000);
  assert.equal(read.preview.short_of_iqd, ship.short_of_iqd);
  assert.deepEqual(ship.lines, []);
});

test('two printers’ coupons: two pieces and 10,000 off the delivery, the same in the cart and at the quote', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  await printerOrder(raw, 2, new Date(Date.now() - 60_000).toISOString(), true);
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 3, fulfillmentType: 'direct_sale' });

  const { read, fee } = await sameAsQuote(a.buyer);
  assert.ok(fee >= 10_000, `the fixture’s delivery costs ${fee}`);
  assert.equal(read.preview.merchandise_iqd, 4_500);
  assert.equal(read.preview.delivery_iqd, 10_000);
  assert.equal(read.preview.count, 4);
  assert.deepEqual(read.preview.lines, [{ line_id: 'ci_fil', amount_iqd: 4_500 }]);
  const printerOf = read.coupons[0].printer;
  assert.deepEqual([printerOf.unit_index, printerOf.week, printerOf.product_slug], [1, 0, 'reward-printer'], 'each coupon names the printer behind it');
  assert.equal(printerOf.name.ckb, 'چاپکەری A1 mini');
});

test('a delivery coupon at exactly its minimum spends, and one dinar under it does not, in both doors', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  const { code, couponId } = await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 7, fulfillmentType: 'direct_sale' }); // 105,000 of goods
  const minimum = (iqd: number) => raw.prepare('UPDATE coupons SET min_total_iqd = ? WHERE id = ?').run(iqd, couponId);

  minimum(105_000);
  const at = await sameAsQuote(a.buyer);
  assert.deepEqual(state(at.read), [`free_shipping:applies:${Math.min(5_000, at.fee)}`]);

  minimum(105_001);
  const read = await readCoupons(a.buyer, { delivery_iqd: String(at.fee) });
  assert.deepEqual(state(read), ['free_shipping:min_not_met:0']);
  assert.equal(read.coupons[0].short_of_iqd, 1);
  assert.equal(read.preview, null, 'nothing applies');
  const refused = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.deepEqual([refused.success, refused.code], [false, 'MIN_TOTAL_NOT_MET']);
  const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code, delivery_iqd: at.fee }));
  assert.deepEqual([check.valid, check.reason, check.min_total_iqd], [false, 'MIN_TOTAL_NOT_MET', 105_001]);
});

test('an offer-priced line takes no filament coupon: the cart no longer promises what the checkout refuses', async () => {
  const raw = rewardsWorld();
  raw.exec("INSERT INTO offer_windows (subject_type,subject_id,id,required_tiers,offer_price_mode,discount_percent,active) VALUES ('product','p_plain','ofw_plain','[]','discount_percent',10,1)");
  const a = apps(raw);
  const { code } = await handCoupon(raw, 'filament_discount');
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });

  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual(state(read), ['filament_discount:on_offer:0'], 'the line is here: its offer is what keeps the coupon off, and the card must say that');
  assert.equal(read.preview, null);
  assert.equal(read.coupons[0].targets, undefined, 'and no link back to the very product in the cart');
  const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code }));
  assert.deepEqual([check.valid, check.reason], [false, 'NO_DISCOUNT'], 'the fix: the code check read every line as undiscounted');
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code })));
  assert.deepEqual([quote.success, quote.code], [false, 'NO_DISCOUNT'], 'the checkout refuses it the same');
});

test('a membership-discounted line: refused in both, and a saving applied at the line lowers the goods a minimum is tested on', async () => {
  const raw = proOnSale(rewardsWorld());
  productAt(raw, 'p_goods', 60_000);
  // PRO prices need the approved default address (worker/lib/entitlements.ts).
  raw.exec(`
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_b','buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_b','buyer','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,enabled)
      VALUES ('r_fil','pro','product_discount','category','cat_materials_fdm','percent',10,1);
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,product_id,discount_mode,percent,max_quantity,enabled)
      VALUES ('r_goods','pro','product_discount','product','p_goods','percent',40,1,1);
  `);
  const a = apps(raw);
  const filament = await handCoupon(raw, 'filament_discount');
  const ship = await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });

  // The rule set the filament's price: no coupon on top of it, in either door.
  const cart = await json(await get(a.buyer, '/api/cart'));
  assert.equal(cart.items[0].unit_price_iqd, 13_500, 'the rule set this price');
  const fee = Number((await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote.shipping.total_iqd);
  const onFilament = await readCoupons(a.buyer, { delivery_iqd: String(fee) });
  assert.equal(onFilament.coupons.find((x: J) => x.kind === 'filament_discount').state, 'on_offer');
  assert.equal(onFilament.preview, null);
  const refused = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: filament.code })));
  assert.equal(refused.success, false, JSON.stringify(refused));

  // Two pieces at 60,000 is 120,000 at the unit price, and 96,000 after the rule's one-unit saving
  // at the line: under the delivery coupon's minimum, whatever the unit price says.
  raw.exec("DELETE FROM cart_items WHERE id = 'ci_fil'");
  paidLine(raw, 'ci_goods', 'p_goods', { qty: 2, fulfillmentType: 'direct_sale' });
  const read = await readCoupons(a.buyer, { delivery_iqd: String(fee) });
  const shipFact = read.coupons.find((x: J) => x.kind === 'free_shipping');
  assert.equal(shipFact.state, 'min_not_met');
  assert.equal(shipFact.short_of_iqd, 100_000 - 96_000);
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: ship.code })));
  assert.deepEqual([quote.success, quote.code], [false, 'MIN_TOTAL_NOT_MET'], 'and the quote says the same');
});

/** The read and the quote on the same ticked lines: a promise the quote keeps, and nothing where the quote refuses. */
async function sameOnTicked(app: App, itemIds: string[]) {
  const plain = await json(await post(app, '/api/orders/quote', quoteBody({ itemIds })));
  assert.equal(plain.success, true, JSON.stringify(plain));
  const fee = Number(plain.quote.shipping.total_iqd);
  const read = await readCoupons(app, { delivery_iqd: String(fee), delivery_final: '1', item_ids: itemIds.join(',') });
  const code = read.preview?.code ?? read.coupons[0]?.code;
  const quote = await json(await post(app, '/api/orders/quote', quoteBody({ itemIds, couponCode: code })));
  if (read.preview) {
    assert.equal(quote.success, true, `the cart promises ${read.preview.total_iqd}, the quote refuses ${quote.code}`);
    assert.equal(read.preview.total_iqd, Number(quote.quote.coupon.discount_iqd), 'the whole discount');
    assert.equal(read.preview.merchandise_iqd, Number(quote.quote.coupon.merchandise_iqd ?? 0), 'the goods part');
  } else {
    assert.equal(quote.success, false, `the cart offers nothing, and the quote takes ${quote.quote?.coupon?.discount_iqd}`);
  }
  return { read, quote };
}

function proMember(raw: DatabaseSync, rules: string) {
  proOnSale(raw);
  raw.exec(`
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_b','buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_b','buyer','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    ${rules}
  `);
}

test('a membership rule’s limit belongs to the order: a max_quantity rule resolved over the ticked lines, in both doors', async () => {
  const raw = rewardsWorld();
  productAt(raw, 'p_f1', 30_000, { category: 'cat_materials_fdm' });
  productAt(raw, 'p_f2', 30_000, { category: 'cat_materials_fdm' });
  proMember(raw, `INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,max_quantity,enabled)
     VALUES ('r_q','pro','product_discount','category','cat_materials_fdm','percent',10,1,1);`);
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  paidLine(raw, 'ci_1', 'p_f1', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_2', 'p_f2', { qty: 1, fulfillmentType: 'direct_sale' });

  // Alone, each line takes the rule's one unit, and the coupon has nothing left to land on.
  for (const line of ['ci_1', 'ci_2']) {
    const { read, quote } = await sameOnTicked(a.buyer, [line]);
    assert.deepEqual(state(read), ['filament_discount:on_offer:0'], line);
    assert.deepEqual([quote.success, quote.code], [false, 'NO_DISCOUNT'], line);
  }
  // Together, one line takes the rule and the other the coupon: the same one at both doors.
  const both = await sameOnTicked(a.buyer, ['ci_1', 'ci_2']);
  assert.deepEqual(both.read.preview.lines, [{ line_id: 'ci_2', amount_iqd: 4_500 }], 'the rule goes to the lowest id, the coupon to the other');
  const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code: both.read.preview.code, item_ids: ['ci_2'] }));
  assert.deepEqual([check.valid, check.reason], [false, 'NO_DISCOUNT'], 'the code check reads the same builder');
});

test('a rule’s per-order ceiling, over the ticked line: it is spent on that line, so the coupon stays off it', async () => {
  const raw = rewardsWorld();
  productAt(raw, 'p_f1', 100_000, { category: 'cat_materials_fdm' });
  productAt(raw, 'p_f2', 30_000, { category: 'cat_materials_fdm' });
  proMember(raw, `INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,category_id,discount_mode,percent,max_discount_iqd,cap_scope,enabled)
     VALUES ('r_c','pro','product_discount','category','cat_materials_fdm','percent',10,5000,'per_order',1);`);
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_1', 'p_f1', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_2', 'p_f2', { qty: 1, fulfillmentType: 'direct_sale' });

  const { read, quote } = await sameOnTicked(a.buyer, ['ci_2']);
  assert.equal(read.preview, null, 'the whole cart’s ceiling went to the big line; alone, this line takes it');
  assert.equal(read.coupons.find((x: J) => x.kind === 'filament_discount').state, 'on_offer');
  assert.deepEqual([quote.success, quote.code], [false, 'MIN_TOTAL_NOT_MET']);
  await sameOnTicked(a.buyer, ['ci_1', 'ci_2']);
});

test('a rule’s minimum subtotal is the ticked lines’: under it there is no rule, and the coupon lands, in both doors', async () => {
  const raw = rewardsWorld();
  productAt(raw, 'p_f1', 100_000);
  productAt(raw, 'p_f2', 30_000, { category: 'cat_materials_fdm' });
  proMember(raw, `INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,discount_mode,percent,min_subtotal_iqd,enabled)
     VALUES ('r_m','pro','product_discount','global','percent',10,100000,1);`);
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  paidLine(raw, 'ci_1', 'p_f1', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_2', 'p_f2', { qty: 1, fulfillmentType: 'direct_sale' });

  const ticked = await sameOnTicked(a.buyer, ['ci_2']);
  assert.deepEqual(ticked.read.preview.lines, [{ line_id: 'ci_2', amount_iqd: 4_500 }], 'the whole cart reaches the minimum; the ticked line does not');
  const whole = await sameOnTicked(a.buyer, ['ci_1', 'ci_2']);
  assert.equal(whole.read.preview, null, 'both ticked: the rule discounts both, and the coupon joins no discount');
  assert.equal(whole.read.coupons[0].state, 'on_offer');
});

test('a tie on price: forty identical quotes give one answer, and the chip’s line is the order’s line', async () => {
  const raw = esunWorld();
  productAt(raw, 'p_a', 24_000, { category: 'cat_materials_fdm' });
  productAt(raw, 'p_b', 24_000, { category: 'cat_materials_fdm' });
  const a = apps(raw);
  // Yesterday's coupon: every FDM filament. Today's: only p_a, the day the owner ticks it.
  const old = await handCoupon(raw, 'filament_discount', 'buyer', { expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  const fresh = await handCoupon(raw, 'filament_discount', 'buyer', { expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  raw.prepare("UPDATE coupons SET scope='products', product_ids='[\"p_a\"]', category_id=NULL WHERE id=?").run(fresh.couponId);
  paidLine(raw, 'ci_a', 'p_a', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_b', 'p_b', { qty: 1, fulfillmentType: 'direct_sale' });

  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.equal(read.preview.total_iqd, 3_600, 'the first coupon takes ci_a by the shared name; the second names only that line');
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    raw.exec('DELETE FROM rate_limits');
    const q = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: old.code })));
    seen.add(Number(q.quote.coupon.discount_iqd));
  }
  assert.deepEqual([...seen], [3_600], 'one cart, one answer');
  // The order the screen was shown: no spurious COUPON_POOL_CHANGED, and the coupon frozen on the line the chip named.
  const order = await placeOrder(a.buyer, { couponCode: old.code, couponDiscountSeen: 3_600 });
  const onLines = all<{ product_id: string; coupon_discount_iqd: number }>(raw, 'SELECT product_id, coupon_discount_iqd FROM order_items WHERE order_id = ? AND coupon_discount_iqd > 0', order.id);
  assert.deepEqual(onLines, [{ product_id: 'p_a', coupon_discount_iqd: 3_600 }], 'the chip said ci_a');
});

test('the owner’s own product: three colours at one price, and the chip stands on the line the order freezes it on', async () => {
  const raw = esunWorld();
  setTerms(raw, { filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: ['p_esun'], max_pieces: 1, on_offer: true } });
  const a = apps(raw);
  const c1 = await handCoupon(raw, 'filament_discount');
  raw.prepare("UPDATE coupons SET scope='products', product_ids='[\"p_esun\"]', category_id=NULL, stacks=1 WHERE id=?").run(c1.couponId);
  paidLine(raw, 'ci_white', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_white', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_beige', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_beige', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_black', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });

  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual(read.preview.lines, [{ line_id: 'ci_beige', amount_iqd: 3_600 }], 'the lowest id among equals');
  const order = await placeOrder(a.buyer, { couponCode: c1.code, couponDiscountSeen: 3_600 });
  const onLines = all<{ color_id: string; coupon_discount_iqd: number }>(raw, 'SELECT color_id, coupon_discount_iqd FROM order_items WHERE order_id = ? AND coupon_discount_iqd > 0', order.id);
  assert.deepEqual(onLines, [{ color_id: 'c_esun_beige', coupon_discount_iqd: 3_600 }], 'the same colour');
});

/** A PREMIUM member: free standard delivery over the line, tested on the goods after the coupons. */
function premiumMember(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_b','buyer','prime_12mo','prime','active',12,99000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
}

test('a coupon that would make the order dearer is not offered: 76,000 over the 75,000 line, the coupon takes 3,600 and brings 5,000 back', async () => {
  const raw = esunWorld();
  productAt(raw, 'p_goods', 52_000);
  premiumMember(raw);
  const a = apps(raw);
  const c = await handCoupon(raw, 'filament_discount');
  raw.prepare("UPDATE coupons SET scope='products', product_ids='[\"p_esun\"]', category_id=NULL, stacks=1 WHERE id=?").run(c.couponId);
  paidLine(raw, 'ci_e', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_g', 'p_goods', { qty: 1, fulfillmentType: 'direct_sale' });

  const plain = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote as J;
  assert.deepEqual([plain.merchandise_iqd, plain.shipping.total_iqd, plain.total_iqd], [76_000, 0, 76_000], 'free over the line');
  const quote = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: c.code })))).quote as J;
  assert.deepEqual([quote.shipping.total_iqd, quote.total_iqd], [5_000, 77_400], 'and the checkout would charge 1,400 more with the coupon');

  // The cart passes its raw estimate, the fee before any waiver.
  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.equal(read.preview, null, 'nothing to press');
  assert.deepEqual(state(read), ['filament_discount:no_gain:0'], 'and the row says why');
});

test('a coupon that brings the fee back but still saves: the button says what it saves, and the delivery coupon is judged on the fee the customer pays', async () => {
  const raw = esunWorld();
  productAt(raw, 'p_goods', 32_000);
  premiumMember(raw);
  const a = apps(raw);
  for (let i = 0; i < 2; i++) {
    const c = await handCoupon(raw, 'filament_discount');
    raw.prepare("UPDATE coupons SET scope='products', product_ids='[\"p_esun\"]', category_id=NULL, stacks=1 WHERE id=?").run(c.couponId);
  }
  paidLine(raw, 'ci_e', 'p_esun', { qty: 2, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_g', 'p_goods', { qty: 1, fulfillmentType: 'direct_sale' });

  const plain = (await json(await post(a.buyer, '/api/orders/quote', quoteBody()))).quote as J;
  assert.deepEqual([plain.merchandise_iqd, plain.total_iqd], [80_000, 80_000]);
  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual([read.preview.total_iqd, read.preview.fee_back_iqd, read.preview.net_iqd], [7_200, 5_000, 2_200]);
  const quote = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: read.preview.code })))).quote as J;
  assert.equal(plain.total_iqd - quote.total_iqd, read.preview.net_iqd, 'the saving the button says is the quote’s own difference');

  // Well over the line nothing comes back, and a delivery coupon has no fee to take: the disclosed gap, closed for a member.
  raw.exec("UPDATE cart_items SET qty = 3 WHERE id = 'ci_g'");
  await handCoupon(raw, 'free_shipping');
  const over = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual([over.preview.total_iqd, over.preview.fee_back_iqd, over.preview.net_iqd], [7_200, 0, 7_200]);
  assert.equal(over.coupons.find((x: J) => x.kind === 'free_shipping').state, 'no_fee', 'the member pays no fee: it stays for the next order');
});

test('PREMIUM’s line is tested after the points the customer switched on, and the quote agrees', async () => {
  const raw = esunWorld();
  productAt(raw, 'p_goods', 56_000);
  premiumMember(raw);
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('pts_p','buyer','deposit','POINT',3000,'approved')");
  const a = apps(raw);
  const c = await handCoupon(raw, 'filament_discount');
  raw.prepare("UPDATE coupons SET scope='products', product_ids='[\"p_esun\"]', category_id=NULL, stacks=1 WHERE id=?").run(c.couponId);
  paidLine(raw, 'ci_e', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_g', 'p_goods', { qty: 1, fulfillmentType: 'direct_sale' });

  // 80,000 of goods. Without the points the coupon leaves 76,400, over the line: it simply saves 3,600.
  const noPoints = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual([noPoints.preview.fee_back_iqd, noPoints.preview.net_iqd], [0, 3_600]);
  // With 3,000 points on, 77,000 is over the line and 73,400 under it: the coupon brings the fee back.
  const withPoints = await readCoupons(a.buyer, { delivery_iqd: '5000', points_iqd: '3000' });
  assert.equal(withPoints.preview, null, 'it would cost 1,400');
  const plain = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ usePoints: true })))).quote as J;
  const quote = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ usePoints: true, couponCode: c.code })))).quote as J;
  assert.equal(quote.total_iqd - plain.total_iqd, 1_400, 'the quote says the same');
});

test('an owner who tests PRO’s line before the coupons: no coupon brings its fee back, and the read says so', async () => {
  const raw = esunWorld();
  productAt(raw, 'p_goods', 52_000);
  proMember(raw, '');
  raw.exec("UPDATE addresses SET is_default = 1 WHERE user_id = 'buyer'");
  const a = apps(raw);
  const c = await handCoupon(raw, 'filament_discount');
  raw.prepare("UPDATE coupons SET scope='products', product_ids='[\"p_esun\"]', category_id=NULL, stacks=1 WHERE id=?").run(c.couponId);
  paidLine(raw, 'ci_e', 'p_esun', { qty: 1, optionValueIds: ['v_esun'], colorId: 'c_esun_black', fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_g', 'p_goods', { qty: 1, fulfillmentType: 'direct_sale' });
  raw.prepare("INSERT OR REPLACE INTO membership_benefit_rules (id,tier,benefit_type,scope,free_shipping_threshold_iqd,enabled) VALUES ('r_ship','pro','free_shipping','global',75000,1)").run();
  forgetPricingInputs(asD1(raw));

  // The default basis: after the coupons, so this PRO member's coupon would cost them the free delivery.
  const after = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.equal(after.preview, null, 'over the line now, under it after the 3,600');
  assert.equal(after.coupons[0].state, 'no_gain');

  const policy = row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'shippingPolicy'");
  const stored = JSON.parse(policy?.value ?? '{}');
  raw.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(JSON.stringify({ ...stored, threshold_basis: 'merchandise_before_coupon' }));
  const before = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual([before.preview?.fee_back_iqd, before.preview?.net_iqd], [0, 3_600], 'on the goods before the coupons the fee stays waived');
});

test('the checkout’s read takes the quote’s fee as final: it tests no waiver a second time', async () => {
  const raw = esunWorld();
  productAt(raw, 'p_goods', 120_000);
  premiumMember(raw);
  const a = apps(raw);
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_g', 'p_goods', { qty: 1, fulfillmentType: 'direct_sale' });
  const asCart = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.equal(asCart.coupons[0].state, 'no_fee', 'the raw estimate, and this member would pay none of it');
  const asCheckout = await readCoupons(a.buyer, { delivery_iqd: '5000', delivery_final: '1' });
  assert.deepEqual([asCheckout.coupons[0].state, asCheckout.preview.delivery_iqd], ['applies', 5_000], 'a fee a quote charged is a fee');
});

test('the ticked lines only: an unticked filament takes nothing, and the same in both doors', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 2, fulfillmentType: 'direct_sale' });

  const justPrinter = await sameAsQuote(a.buyer, { itemIds: ['ci_goods'] });
  assert.equal(justPrinter.read.preview.merchandise_iqd, 0);
  assert.equal(justPrinter.read.coupons.find((x: J) => x.kind === 'filament_discount').state, 'no_target');

  const justFilament = await readCoupons(a.buyer, { item_ids: 'ci_fil', delivery_iqd: '5000' });
  assert.deepEqual(justFilament.preview.lines, [{ line_id: 'ci_fil', amount_iqd: 2_250 }]);
  assert.equal(justFilament.coupons.find((x: J) => x.kind === 'free_shipping').state, 'min_not_met', '30,000 of goods without the printer');

  const both = await sameAsQuote(a.buyer, { itemIds: ['ci_goods', 'ci_fil'] });
  assert.equal(both.read.preview.merchandise_iqd, 2_250);

  const ghost = await readCoupons(a.buyer, { item_ids: 'ci_goods,not_in_the_cart', delivery_iqd: '5000' });
  assert.equal(ghost.preview.merchandise_iqd, 0, 'an id not in the cart is ignored');
  const allGhost = await readCoupons(a.buyer, { item_ids: 'not_in_the_cart', delivery_iqd: '5000' });
  assert.equal(allGhost.preview.merchandise_iqd, 2_250, 'none left: every line');
  const empty = await readCoupons(a.buyer, { item_ids: '', delivery_iqd: '5000' });
  assert.equal(empty.preview.merchandise_iqd, 2_250);
});

test('a gift line pays nothing and takes no coupon: the filament coupon does not land on a gift of filament', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  await giftInCart(a, PLAIN);
  await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });

  const { read } = await sameAsQuote(a.buyer);
  assert.equal(read.coupons.find((x: J) => x.kind === 'filament_discount').state, 'no_target');
  assert.equal(read.preview.merchandise_iqd, 0);
  assert.equal(read.coupons.find((x: J) => x.kind === 'free_shipping').state, 'applies', 'the paid printer carries the delivery coupon');
});

test('a bundle with a saving is already discounted; one without takes the coupon on its own price, in both doors', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_saving', slug: 'with-saving', priceIqd: 400_000 });
  addBundle(raw, {
    id: 'prd_flat',
    slug: 'no-saving',
    priceIqd: 455_000,
    components: [
      { id: 'bc2_printer', product: 'p_printer', qty: 1 },
      { id: 'bc2_pla', product: 'p_pla', qty: 2 },
      { id: 'bc2_nozzle', product: 'p_nozzle', qty: 1 },
    ],
  });
  raw.exec("UPDATE products SET category_id = 'cat_materials_fdm' WHERE id IN ('prd_saving','prd_flat')");
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');

  const add = await json(await post(a.buyer, '/api/cart/items', { productId: 'prd_saving', qty: 1 }));
  assert.equal(add.success, true, JSON.stringify(add));
  const saving = await sameAsQuote(a.buyer);
  assert.equal(saving.read.coupons.find((x: J) => x.kind === 'filament_discount').state, 'on_offer', 'one discount per piece');
  assert.equal(saving.read.preview.merchandise_iqd, 0);

  raw.exec("DELETE FROM cart_bundle_choices; DELETE FROM cart_items WHERE user_id = 'buyer'");
  const addFlat = await json(await post(a.buyer, '/api/cart/items', { productId: 'prd_flat', qty: 1 }));
  assert.equal(addFlat.success, true, JSON.stringify(addFlat));
  const flat = await sameAsQuote(a.buyer);
  assert.equal(flat.read.preview.merchandise_iqd, 25_000, '15% of 455,000 is over the coupon’s 25,000 ceiling');
});

test('a delivery that came out free spends no delivery coupon: it stays for the next order, in both doors', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });

  const { read, fee } = await sameAsQuote(a.buyer, { deliveryMethodId: 'pickup' });
  assert.equal(fee, 0);
  assert.equal(read.coupons.find((x: J) => x.kind === 'free_shipping').state, 'no_fee');
  assert.equal(read.preview.delivery_iqd, 0);
  assert.equal(read.preview.merchandise_iqd, 2_250);
});

test('with no delivery estimate a delivery coupon waits, worth nothing yet, and an invalid estimate is no estimate', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  const { code } = await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  for (const query of [{}, { delivery_iqd: '' }, { delivery_iqd: 'abc' }, { delivery_iqd: '-5' }, { delivery_iqd: '1.5' }, { delivery_iqd: '10000001' }] as Array<Record<string, string>>) {
    const read = await readCoupons(a.buyer, query);
    assert.deepEqual(state(read), ['free_shipping:waiting:0'], JSON.stringify(query));
    assert.equal(read.preview.delivery_waiting, true);
    assert.equal(read.preview.total_iqd, 0);
    assert.equal(read.preview.count, 1, 'it would spend, once the fee is known');
    assert.equal(read.preview.code, code);
  }
  const known = await readCoupons(a.buyer, { delivery_iqd: '10000000' });
  assert.equal(known.preview.delivery_iqd, 5_000, 'the ceiling itself is an estimate');
  assert.equal(known.preview.delivery_waiting, false);
});

// ------------------------------------------------------------------ the code check

test('a valid code says what it does to the lines: a reward code its pool, a typed code its own', async () => {
  const raw = rewardsWorld();
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active) VALUES ('c10', 'TEN', 'percent', 10, 0, 5, 1)`);
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, active, scope, applies_to) VALUES ('cship', 'SHIP3', 'fixed_iqd', 3000, 0, 5, 1, 'global', 'delivery')`);
  const a = apps(raw);
  const filament = await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping');
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 2, fulfillmentType: 'direct_sale' });

  const pooled = await json(await post(a.buyer, '/api/cart/coupon-check', { code: filament.code, delivery_iqd: 5_000 }));
  assert.equal(pooled.valid, true, JSON.stringify(pooled));
  assert.deepEqual(pooled.lines, [{ line_id: 'ci_fil', amount_iqd: 2_250 }]);
  assert.deepEqual([pooled.merchandise_iqd, pooled.delivery_iqd, pooled.pool, pooled.pool_count], [2_250, 5_000, true, 2]);
  assert.equal(pooled.estimated_discount_iqd, 7_250, 'what it answered already, now with the delivery it was told');
  assert.equal(pooled.cart_total_iqd, 230_000);

  const noFee = await json(await post(a.buyer, '/api/cart/coupon-check', { code: filament.code }));
  assert.deepEqual([noFee.delivery_iqd, noFee.pool_count], [0, 2], 'the delivery coupon waits and still counts');

  const typed = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'TEN' }));
  assert.deepEqual([typed.pool, typed.pool_count, typed.delivery_iqd], [false, 0, 0]);
  assert.equal(typed.merchandise_iqd, 23_000);
  assert.deepEqual(typed.lines.map((l: J) => l.line_id).sort(), ['ci_fil', 'ci_goods']);

  const ticked = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'TEN', item_ids: ['ci_fil', 'ghost'] }));
  assert.deepEqual(ticked.lines, [{ line_id: 'ci_fil', amount_iqd: 3_000 }], 'the ticked lines, an unknown id ignored');
  assert.equal(ticked.cart_total_iqd, 30_000);

  const delivery = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'SHIP3', delivery_iqd: 5_000 }));
  assert.deepEqual([delivery.valid, delivery.merchandise_iqd, delivery.delivery_iqd], [true, 0, 3_000]);
  const pending = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'SHIP3' }));
  assert.deepEqual([pending.valid, pending.delivery_iqd], [true, 0], 'valid while the fee is unknown, as ever');
  assert.equal(pending.estimated_discount_iqd, undefined);
});

test('someone else’s code is invisible: one answer for every code this customer cannot see, and no reward mark', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  const theirs = await handCoupon(raw, 'free_shipping', 'other');
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });

  const read = await readCoupons(a.buyer, { delivery_iqd: '5000' });
  assert.deepEqual([read.installed, read.coupons, read.preview], [true, [], null], 'only their own');
  const mine = await readCoupons(a.other, { delivery_iqd: '5000' });
  assert.equal(mine.coupons.length, 1);
  assert.equal(mine.coupons[0].state, 'min_not_met', 'the other customer’s cart is empty');

  const stranger = await json(await post(a.buyer, '/api/cart/coupon-check', { code: theirs.code }));
  const unknown = await json(await post(a.buyer, '/api/cart/coupon-check', { code: 'NOSUCHCODE' }));
  assert.deepEqual(stranger, unknown);
  assert.equal(stranger.reward_code, undefined);
});

test('the customer’s own dead code is marked, so the cart can forget it; a live pool still opens from it', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  const past = new Date(Date.now() - 60_000).toISOString();
  const old = await handCoupon(raw, 'filament_discount', 'buyer', { issuedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), expiresAt: past });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });

  const dead = await json(await post(a.buyer, '/api/cart/coupon-check', { code: old.code }));
  assert.deepEqual([dead.valid, dead.reason, dead.reward_code], [false, 'EXPIRED', true]);

  await handCoupon(raw, 'filament_discount');
  const opens = await json(await post(a.buyer, '/api/cart/coupon-check', { code: old.code }));
  assert.deepEqual([opens.valid, opens.pool, opens.merchandise_iqd], [true, true, 2_250], 'last week’s code opens this week’s');
  assert.notEqual(opens.code, old.code);
  assert.equal(opens.reward_code, undefined);
});

test('a spent coupon and a withdrawn one are not in the read', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  const gone = await handCoupon(raw, 'filament_discount');
  raw.prepare("UPDATE reward_grants SET revoked_at = ?, revoke_reason = 'admin' WHERE id = ?").run(new Date().toISOString(), gone.grantId);
  raw.prepare('UPDATE coupons SET active = 0 WHERE id = ?').run(gone.couponId);
  const read = await readCoupons(a.buyer);
  assert.deepEqual(read.coupons, []);
});

// ------------------------------------------------------------------ what it costs

/** A database that counts what is asked of it. */
function counting(raw: DatabaseSync) {
  const inner = asD1(raw);
  const statements: string[] = [];
  const db = new Proxy(inner, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, statements };
}

test('a customer with no coupon costs one statement: no limiter write and no cart read', async () => {
  const raw = rewardsWorld();
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const { db, statements } = counting(raw);
  const app = stubApp(db, BUYER, (x) => x.route('/api/cart', cartRoutes), { publishV2: false });
  const res = await get(app, '/api/cart/reward-coupons?delivery_iqd=5000');
  const out = await json(res);
  assert.equal(res.status, 200);
  assert.deepEqual([out.installed, out.coupons, out.preview], [true, [], null]);
  assert.equal(typeof out.server_time, 'string');
  assert.equal(statements.length, 1, statements.join('\n---\n'));
  assert.match(statements[0], /FROM reward_grants g/);
  assert.equal(all(raw, 'SELECT * FROM rate_limits').length, 0);
});

test('a customer who holds coupons is limited, on the bucket the read names', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  await handCoupon(raw, 'free_shipping');
  await readCoupons(a.buyer);
  assert.equal(all<{ key: string }>(raw, 'SELECT key FROM rate_limits')[0]?.key, 'cart_reward_coupons:u:buyer');
  raw.prepare('UPDATE rate_limits SET count = 120').run();
  const res = await get(a.buyer, '/api/cart/reward-coupons');
  assert.equal(res.status, 429);
});

test('deploy-ahead: before 0220 and before 0225 the read answers 200, empty, installed false', async () => {
  for (const through of ['0219', '0224']) {
    const raw = dbThrough(through);
    raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','buyer@x.co','h','customer')");
    const app = stubApp(asD1(raw), BUYER, (x) => x.route('/api/cart', cartRoutes), { publishV2: false });
    const res = await get(app, '/api/cart/reward-coupons');
    const out = await json(res);
    assert.equal(res.status, 200, through);
    assert.deepEqual([out.success, out.installed, out.coupons, out.preview], [true, false, [], null], through);
  }
});

test('the cart’s own read never carries what the coupon resolver is told about a line', async () => {
  const raw = rewardsWorld();
  const a = apps(raw);
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const cart = await json(await get(a.buyer, '/api/cart'));
  assert.equal(cart.success, true);
  assert.equal(cart.couponLineFacts, undefined);
  assert.doesNotMatch(JSON.stringify(cart), /member_line_discount_iqd|already_discounted/);
  const read = await readCoupons(a.buyer);
  assert.doesNotMatch(JSON.stringify(read), /cost_iqd|coupon_id/, 'nothing of the shop’s books');
});

test('the team coupon’s notice exists in three languages, and the Sorani is its own', () => {
  for (const kinds of [['free_shipping'], ['filament_discount']] as const) {
    const text = rewardText({ kind: 'team_coupon', until: '2026-12-01', percent: 15, amount: 5_000, min: 100_000, pieces: 1, kinds });
    for (const part of [text.title, text.body]) {
      assert.ok(part.ar && part.en && part.ckb);
      assert.notEqual(part.ckb, part.ar, 'DECISIONS row 183');
    }
    assert.match(text.body.ar, /2026-12-01/);
    assert.match(text.body.ckb, /2026-12-01/);
  }
  assert.match(rewardText({ kind: 'team_coupon', until: 'x', percent: 15, amount: 5_000, min: 100_000, pieces: 1, kinds: ['free_shipping'] }).body.ckb, /100,000 دینار/);
});
