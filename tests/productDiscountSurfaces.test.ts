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

test('the card applies a dollar sale per level: the cheapest AFTER price wins, «يبدأ من» stays honest, the strike is the level’s own', async () => {
  const w = await discountWorld({ costFirst: false });
  // Only the Combo on sale, deep enough to drop below the P1S: 1,125,000 → 840,000 ($560) < 900,000.
  assert.equal((await w.saveOffer(w.owner, perModel(null, '560'))).status, 200);
  const c = cardOf(await listing(w))!;
  assert.equal(c.display_price_iqd, 840_000, 'the Combo’s sale price is now the cheapest way to buy');
  assert.equal(c.display_offer_before_iqd, 1_125_000, 'struck: the Combo’s own before price, never the P1S’s');
  assert.equal(c.display_offer_saving_percent, 25);
  assert.equal(c.display_from, true, 'the P1S at 900,000 is dearer: «يبدأ من» is real');
  const offer = c.offer as Record<string, unknown>;
  assert.equal(offer.priced, true);
  assert.equal(offer.price_source, 'offer');
  // Applying the window to the cheapest level alone (the old projection) would have shown 900,000 with no sale.

  // Both models on sale: 750,000 «يبدأ من», struck 900,000, −17٪.
  assert.equal((await w.saveOffer(w.owner, perModel('500', '640'))).status, 200);
  const both = cardOf(await listing(w))!;
  assert.deepEqual([both.display_price_iqd, both.display_offer_before_iqd, both.display_offer_saving_percent, both.display_from], [750_000, 900_000, 17, true]);
  assert.doesNotMatch(JSON.stringify(both), CUSTOMER_FORBIDDEN);
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
