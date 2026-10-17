/**
 * PRODUCT DISCOUNT — THE CUSTOMER SURFACES (docs/ux/PRODUCT-DISCOUNT.md §8, §9, §12 "Server: customer
 * surfaces").
 *
 *   - the card applies the window PER LEVEL (F2): with per-model dollar prices the cheapest after price
 *     wins and «يبدأ من» is honest; `display_offer_before_iqd`, `display_offer_saving_percent` and
 *     `offer.priced` say what the card strikes;
 *   - a live percent sale strikes too (F1);
 *   - the listing: «عليها عرض» sees a live sale; a live priced window that lowers nothing is not a
 *     scheduled offer; `type=discounted` lists a live priced window (F7) and not an ended one;
 *   - the flash board lists a dollar sale; a members-only window gives an ineligible viewer no struck
 *     price, on the card and on the quote;
 *   - no customer answer carries a dollar figure, a rate or the SKU identity.
 *
 * Run: npx tsx --test tests/productDiscountSurfaces.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountWorld, M1, M2, PID, SLUG, type DiscountWorld } from './fixtures/productDiscount';

const CUSTOMER_FORBIDDEN = /"(usd_iqd_rate|offer_usd_prices|price_usd_cents|offer_price_usd|offer_model_id|usd_prices|before_usd|after_usd|cents)"|"sku":\{/;

const perModel = (p1s: string | null, combo: string | null, over: Record<string, unknown> = {}) => ({
  offer_price_mode: 'fixed_usd',
  offer_usd_prices: [...(p1s ? [{ model_id: M1, usd: p1s }] : []), ...(combo ? [{ model_id: M2, usd: combo }] : [])],
  ...over,
});

async function listing(w: DiscountWorld, query = 'limit=50') {
  const res = await w.call(w.guest, 'GET', `/api/products?${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  return res.body;
}
const cardOf = (body: Record<string, unknown>, id = PID) => (body.products as Array<Record<string, unknown>>).find((p) => p.id === id);

test('the card applies a dollar sale per level: the cheapest AFTER price wins, «يبدأ من» keeps its pre-order basis, the strike is the pre-sale «from»', async () => {
  const w = await discountWorld({ costFirst: false });
  // No sale: «يبدأ من 825,000» — the P1S by land pre-order.
  const none = cardOf(await listing(w))!;
  assert.deepEqual([none.display_price_iqd, none.display_offer_before_iqd, none.display_offer_saving_percent], [825_000, null, null]);
  // Only the Combo on sale, deep enough to drop below the P1S: 1,125,000 → 840,000 ($560); its land
  // route keeps the same saving: 1,050,000 − 285,000 = 765,000 < 825,000.
  assert.equal((await w.saveOffer(w.owner, perModel(null, '560'))).status, 200);
  const c = cardOf(await listing(w))!;
  assert.equal(c.display_price_iqd, 765_000, 'the Combo by land is now the cheapest way to buy');
  assert.equal(c.display_offer_before_iqd, 825_000, 'struck: the card’s own «from» before the sale — never the Combo’s 1,125,000');
  assert.equal(c.display_offer_saving_percent, 7);
  assert.equal(c.display_from, true, 'the P1S at 825,000 and up is dearer: «يبدأ من» is real');
  const offer = c.offer as Record<string, unknown>;
  assert.equal(offer.priced, true);
  assert.equal(offer.price_source, 'offer');

  // Both models on sale: «يبدأ من 675,000» (the P1S by land, as the product page says), struck 825,000, −18٪.
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  const both = cardOf(await listing(w))!;
  assert.deepEqual([both.display_price_iqd, both.display_offer_before_iqd, both.display_offer_saving_percent, both.display_from], [675_000, 825_000, 18, true]);
  assert.doesNotMatch(JSON.stringify(both), CUSTOMER_FORBIDDEN);
});

test('one basis for «يبدأ من» and its strike: a Combo-only sale above the card’s «from» strikes nothing and never raises it', async () => {
  const w = await discountWorld({ costFirst: false });
  // Combo $550: direct 825,000, land 750,000 — below the P1S's 825,000 by land.
  assert.equal((await w.saveOffer(w.owner, perModel(null, '550'))).status, 200);
  const a = cardOf(await listing(w))!;
  assert.deepEqual([a.display_price_iqd, a.display_offer_before_iqd, a.display_offer_saving_percent], [750_000, 825_000, 9]);
  // Combo $700: direct 1,050,000, land 975,000 — still above 825,000. The «from» stays 825,000 (it used
  // to rise to 900,000), with no strike, no badge and no clock.
  assert.equal((await w.saveOffer(w.owner, perModel(null, '700', { ends_at: '2099-01-01T00:00' }))).status, 200);
  const cc = cardOf(await listing(w))!;
  assert.deepEqual([cc.display_price_iqd, cc.display_offer_before_iqd, cc.display_offer_saving_percent], [825_000, null, null]);
  assert.equal((cc.offer as Record<string, unknown>).price_source, 'ladder', 'a priced window that lowers nothing on this card');
  // The product page still sells the Combo at its sale price.
  const q = await w.call(w.guest, 'POST', `/api/products/${SLUG}/quote`, { qty: 1, optionId: M2, fulfillmentType: 'direct_sale' });
  assert.deepEqual([q.body.quote.unit_subtotal_iqd, q.body.quote.offer_before_iqd], [1_050_000, 1_125_000]);
});

test('members on the card under a sale: one basis, the pay-the-lower rule, and the F5 label', async () => {
  const { proOnSale } = await import('./fixtures/app');
  for (const [percent, expected, tier] of [
    [5, [675_000, 825_000, 18], 'regular'], // PRO 5% of 825,000 = 783,750 > 675,000: the sale price, «سعر العرض»
    [20, [660_000, 825_000, 20], 'pro'], // PRO 20% of 825,000 = 660,000 < 675,000: PRO's price
  ] as const) {
    const w = await discountWorld({ costFirst: false });
    proOnSale(w.raw);
    w.raw.exec(`
      INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,product_id,discount_mode,percent,enabled,priority)
        VALUES ('mbr_pro','pro','product_discount','product','${PID}','percent',${percent},1,0);
      INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
        VALUES ('m_pro','u_buyer','pro_12mo','pro','active',12,1,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
      INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
        VALUES ('ap_b','u_buyer',1,'Sara','+9647701234567','Baghdad, Karrada 12','','approved');
    `);
    assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
    const res = await w.call(w.buyer, 'GET', '/api/products?limit=50');
    const c = cardOf(res.body)!;
    assert.deepEqual([c.display_price_iqd, c.display_offer_before_iqd, c.display_offer_saving_percent], [...expected], `PRO ${percent}%`);
    assert.equal(c.display_applied_tier, tier, `PRO ${percent}% label`);
  }
});

test('a live percent sale strikes its before price on the card, the page and the level grid (F1)', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'discount_percent', discount_percent: 10 })).status, 200);
  const c = cardOf(await listing(w))!;
  assert.deepEqual([c.display_price_iqd, c.display_offer_before_iqd, c.display_offer_saving_percent], [742_500, 825_000, 10]);
  const page = await w.call(w.guest, 'GET', `/api/products/${SLUG}`);
  assert.equal(page.status, 200);
  const level = page.body.price_levels.option[M1];
  assert.deepEqual([level.applied_iqd, level.offer_before_iqd, level.offer_saving_percent], [810_000, 900_000, 10]);
  assert.doesNotMatch(JSON.stringify(page.body), CUSTOMER_FORBIDDEN);
});

test('the listing: «عليها عرض» sees a live sale; a live priced window that lowers nothing is no scheduled offer', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  const on = await listing(w, 'offer=1&limit=50');
  assert.ok(cardOf(on), 'a live sale is «عليها عرض»');
  // A dollar price that lowers nothing here: P1S at $650 (not below), the Combo uncovered — saved? No:
  // the door refuses a sale that lowers nothing (OFFER_NOT_LOWER). So the window lowers nothing only
  // after the owner raises… a V2 price under it: lower the P1S's own price below the sale.
  const { writeV2 } = await import('./fixtures/pricingV2');
  const { option, off } = await import('./fixtures/productDiscount');
  await writeV2(w.db, PID, { method: 'usd', points: [option(M1, '480'), option(M2, '620')], discounts: [off('50')] });
  const card = cardOf(await listing(w))!;
  assert.equal(card.display_offer_before_iqd, null);
  assert.equal((card.offer as Record<string, unknown>).price_source, 'ladder');
  assert.equal(cardOf(await listing(w, 'offer=1&limit=50')), undefined, 'a live priced window that lowers nothing is not «عليها عرض»');
});

test('type=discounted (the flash board’s «عرض الكل») lists a live priced window and not an ended one; the flash board lists a dollar sale', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal(cardOf(await listing(w, 'type=discounted&limit=50')), undefined, 'no sale, no membership discount: not discounted');
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  assert.ok(cardOf(await listing(w, 'type=discounted&limit=50')), 'a live dollar sale is discounted');
  const home = await w.call(w.guest, 'GET', '/api/home/sections');
  assert.equal(home.status, 200);
  assert.ok((home.body.flash_deals as Array<{ id: string }>).some((p) => p.id === PID), 'the flash board lists it');
  // Ended: no longer discounted.
  w.raw.exec(`UPDATE offer_windows SET starts_at = '2020-01-01T00:00:00.000Z', ends_at = '2020-02-01T00:00:00.000Z' WHERE subject_id = '${PID}'`);
  assert.equal(cardOf(await listing(w, 'type=discounted&limit=50')), undefined, 'an ended window is not discounted');
  // Upcoming: not discounted either (nothing is lowered yet).
  w.raw.exec(`UPDATE offer_windows SET starts_at = '2099-01-01T00:00:00.000Z', ends_at = NULL WHERE subject_id = '${PID}'`);
  assert.equal(cardOf(await listing(w, 'type=discounted&limit=50')), undefined);
});

test('a members-only sale gives an ineligible viewer no struck price — card, page and quote — and the lock', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640', { required_tiers: ['pro'] }))).status, 200);
  const c = cardOf(await listing(w))!;
  assert.equal(c.display_offer_before_iqd, null);
  assert.equal(c.display_offer_saving_percent, null);
  assert.equal((c.offer as Record<string, unknown>).locked, true);
  const q = await w.call(w.guest, 'POST', `/api/products/${SLUG}/quote`, { qty: 1, optionId: M1, fulfillmentType: 'direct_sale' });
  assert.deepEqual([q.body.quote.unit_subtotal_iqd, q.body.quote.offer_before_iqd, q.body.quote.offer_saving_percent], [900_000, null, null]);
  // …and the members-only window still lists the product as discounted (its card shows the lock).
  assert.ok(cardOf(await listing(w, 'type=discounted&limit=50')));
});

test('an existing members-only percent window keeps the guest card in «عليها عرض» with its clock — the shelf and the card agree', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: 'discount_percent', discount_percent: 20, required_tiers: ['plus'], ends_at: '2099-01-01T00:00' })).status, 200);
  const c = cardOf(await listing(w))!;
  const offer = c.offer as Record<string, unknown>;
  assert.deepEqual([offer.locked, offer.priced, offer.price_source, offer.schedule_state], [true, true, 'ladder', 'live']);
  const on = await listing(w, 'offer=1&facets=1&limit=50');
  assert.ok(cardOf(on), 'a locked live window is still «عليها عرض», as before the dollar sale');
  assert.equal((on.facets as Record<string, unknown>).offer, 1, 'and counts in its facet');
  assert.ok(cardOf(await listing(w, 'type=discounted&limit=50')), 'the «المخفَّضة» shelf lists it; its card wears the lock');
});

test('the customer leak scanners pass during a dollar sale: card, page, quote, cart, checkout and order carry dinars only', async () => {
  const { arithmeticLeaks, leaks } = await import('./fixtures/costlyProduct');
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640', { ends_at: '2099-01-01T00:00' }))).status, 200);
  const answers: Array<[string, unknown]> = [];
  answers.push(['listing', await listing(w)]);
  answers.push(['page', (await w.call(w.guest, 'GET', `/api/products/${SLUG}`)).body]);
  answers.push(['quote', (await w.call(w.guest, 'POST', `/api/products/${SLUG}/quote`, { qty: 1, optionId: M1, fulfillmentType: 'direct_sale' })).body]);
  answers.push(['home', (await w.call(w.guest, 'GET', '/api/home/sections')).body]);
  await w.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'direct_sale' });
  answers.push(['cart', (await w.cart()).body]);
  answers.push(['checkout', (await w.quote('cash')).body]);
  const placed = await w.placeOrder('cash');
  assert.equal(placed.status, 200);
  answers.push(['order', placed.body]);
  answers.push(['order read', (await w.call(w.buyer, 'GET', `/api/orders/${placed.body.order.id}`)).body]);
  for (const [name, body] of answers) {
    assert.deepEqual(arithmeticLeaks(body), [], `${name}: arithmetic`);
    assert.deepEqual(leaks(body), [], `${name}: cost`);
    assert.doesNotMatch(JSON.stringify(body), CUSTOMER_FORBIDDEN, name);
  }
  // The scanner itself sees the keys it is meant to (a self-test of the net).
  assert.ok(arithmeticLeaks({ x: { offer_price_usd: '500.00' } }).length === 1);
  assert.ok(arithmeticLeaks({ line: { sku: { combo_key: 'o:m', channel: 'direct_sale', model_id: 'm' } } }).length === 1);
  assert.deepEqual(arithmeticLeaks({ product: { sku: 'P1S-001' } }), [], 'a product code is not arithmetic');
});
