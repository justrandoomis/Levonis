/**
 * THE PRICE FEED ROUTE (`GET /api/products/price-feed.csv`, worker/routes/products.ts)
 * on the real listing, the real V2 writer and the real product page quote.
 *
 * The world is the product-discount spec's P1S (tests/fixtures/productDiscount.ts):
 * two models sold direct and by land pre-order, on the shelf, priced direct
 * 900,000 / 1,125,000 and by land 825,000 / 1,050,000 — so the listing card says
 * «يبدأ من 825,000», a PRE-ORDER price. The feed must say «يبدأ من 900,000»: the
 * shelf's direct price, the figure the product page quotes for a direct sale.
 * Beside it a pre-order-only product, a never-priced one and a bundle.
 *
 * Run: node --import tsx --test tests/priceFeedRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './fixtures/app';
import { COST_M, COST_SLUG, M1, M2, PID, SLUG, discountWorld, seedShapes, type DiscountWorld } from './fixtures/productDiscount';
import { PRICE_FEED_HEADER } from '../worker/lib/priceFeed';
import { cacheControlFor } from '../worker/lib/edgePolicy';
import { PRICE_FEED_LIFETIME } from '../worker/routes/products';

async function feed(w: DiscountWorld, app = w.guest) {
  const res = await get(app, '/api/products/price-feed.csv');
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 300));
  const lines = text.split('\r\n');
  assert.equal(lines.pop(), '', 'the last record ends with CRLF');
  return { res, text, rows: lines.map((l) => l.split(',')), byLink: new Map(lines.slice(1).map((l) => [l.slice(l.lastIndexOf(',') + 1).replace(/^.*\/product\//, ''), l])) };
}

async function directQuote(w: DiscountWorld, slug: string, optionId: string): Promise<number> {
  const q = await w.call(w.guest, 'POST', `/api/products/${slug}/quote`, { qty: 1, optionId, fulfillmentType: 'direct_sale' });
  assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 300));
  return q.body.quote.unit_subtotal_iqd as number;
}

const grouped = (n: number) => n.toLocaleString('en-US');

test('the feed is the default listing as CSV: in stock at the shelf’s DIRECT price, never the card’s pre-order «from»', async () => {
  const w = await discountWorld();
  await seedShapes(w);
  const listing = await w.call(w.guest, 'GET', '/api/products?limit=50');
  const p1sCard = (listing.body.products as Array<Record<string, unknown>>).find((p) => p.slug === SLUG)!;
  assert.deepEqual([p1sCard.display_price_iqd, p1sCard.display_from], [825_000, true], 'the card’s «from» is the P1S by land pre-order');

  const { res, text, byLink } = await feed(w);
  // Its own route, not swallowed by `/:slug`, and a public answer under its own lifetime.
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), cacheControlFor(PRICE_FEED_LIFETIME));
  assert.equal(cacheControlFor(PRICE_FEED_LIFETIME), 'public, max-age=300, s-maxage=900, stale-while-revalidate=900');
  assert.ok(text.startsWith(`${PRICE_FEED_HEADER.join(',')}\r\n`), 'the header first, no BOM');

  // The P1S: both models on the shelf, priced as the product page quotes a direct sale.
  const [p1s, combo] = [await directQuote(w, SLUG, M1), await directQuote(w, SLUG, M2)];
  assert.deepEqual([p1s, combo], [900_000, 1_125_000]);
  assert.equal(byLink.get(SLUG), `طابعة بامبو,Bambu Lab ${SLUG},متوفر الآن (بيع مباشر),In stock,"يبدأ من ${grouped(p1s)}",,http://localhost/product/${SLUG}`);
  // The cost-first AMS: one model on the shelf, one price — no «يبدأ من».
  const ams = await directQuote(w, COST_SLUG, COST_M);
  assert.match(byLink.get(COST_SLUG)!, new RegExp(`,In stock,"${grouped(ams)}",`));
  // Colour-only, both colours on the shelf: the direct prices, the dearer colour making it «from».
  assert.match(byLink.get('slug-p_colours')!, /,In stock,"يبدأ من 900,000",/);
  // Pre-order only: the agent's sentence, no price. Never priced: «السعر غير متوفر حالياً».
  assert.equal(byLink.get('slug-p_preonly'), 'منتج,Product p_preonly,طلب مسبق — نكدر نوفره لك، والإدارة تبلغك بالسعر والموعد,Pre-order,,,http://localhost/product/slug-p_preonly');
  assert.equal(byLink.get('slug-p_unpriced'), 'منتج,Product p_unpriced,السعر غير متوفر حالياً,Not priced,,,http://localhost/product/slug-p_unpriced');
  // The default listing carries no composition, and neither does the feed.
  assert.equal(byLink.has('a-bundle'), false);
  // No pre-order figure anywhere: 825,000 is the P1S's, the colours' and the pre-order product's land price.
  assert.doesNotMatch(text, /825,000|855,000|1,050,000/);
  // In stock, then pre-order, then not priced.
  assert.deepEqual([...byLink.keys()], [SLUG, COST_SLUG, 'slug-p_colours', 'slug-p_preonly', 'slug-p_unpriced']);
});

test('a direct sale sold out with pre-order open is a pre-order; a signed-in caller reads the same body, never stored', async () => {
  const w = await discountWorld();
  w.raw.exec(`UPDATE product_option_values SET stock = 0 WHERE product_id = 'p_p1s'`);
  const guest = await feed(w);
  assert.equal(guest.byLink.get(SLUG), `طابعة بامبو,Bambu Lab ${SLUG},طلب مسبق — نكدر نوفره لك، والإدارة تبلغك بالسعر والموعد,Pre-order,,,http://localhost/product/${SLUG}`);
  assert.doesNotMatch(guest.text, /900,000|825,000/);
  // A guest's prices for every caller: the buyer's answer is the guest's, and it leaves `private, no-store`.
  const buyer = await feed(w, w.buyer);
  assert.equal(buyer.text, guest.text);
  assert.equal(buyer.res.headers.get('cache-control'), 'private, no-store');
});

test('during a live offer (Black Friday, owner 2026-11-04): the sale price and «السعر قبل الخصم» are the product page’s own figures', async () => {
  const w = await discountWorld();
  // A dollar sale on both P1S models, saved through the admin offers door (the P1S $500 → 750,000 direct).
  const saved = await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }, { model_id: M2, usd: '640' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
  // What the product page quotes a guest for the cheaper model as a direct sale: the sale price, and its struck price.
  const q = await w.call(w.guest, 'POST', `/api/products/${SLUG}/quote`, { qty: 1, optionId: M1, fulfillmentType: 'direct_sale' });
  assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 300));
  const quote = q.body.quote as { unit_subtotal_iqd: number; applied_iqd: number; offer_before_iqd: number };
  assert.deepEqual([quote.unit_subtotal_iqd, quote.offer_before_iqd], [750_000, 900_000], 'the page strikes 900,000 beside 750,000');

  const { text, byLink } = await feed(w);
  assert.equal(
    byLink.get(SLUG),
    `طابعة بامبو,Bambu Lab ${SLUG},متوفر الآن (بيع مباشر),In stock,"يبدأ من ${grouped(quote.unit_subtotal_iqd)}","${grouped(quote.offer_before_iqd)}",http://localhost/product/${SLUG}`
  );
  // Still never the pre-order «from» or a land price.
  assert.doesNotMatch(text, /825,000|1,050,000/);
});

test('a sale on one model only: no struck price where the product did not get cheaper; «يبدأ من» struck against the old low', async () => {
  // The Combo cut to $600 = 900,000, the P1S's own undiscounted price: the product's price did not drop.
  const even = await discountWorld();
  assert.equal((await even.saveOffer(even.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M2, usd: '600' }] })).status, 200);
  const p1sQuote = await even.call(even.guest, 'POST', `/api/products/${SLUG}/quote`, { qty: 1, optionId: M1, fulfillmentType: 'direct_sale' });
  assert.equal(p1sQuote.body.quote.offer_before_iqd ?? null, null, 'the page opens on the P1S, which shows no strike');
  assert.match((await feed(even)).byLink.get(SLUG)!, /,In stock,"900,000",,http/);
  // The Combo cut to $560 = 840,000, below the P1S: «يبدأ من 840,000» struck against 900,000, the old low.
  const below = await discountWorld();
  assert.equal((await below.saveOffer(below.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M2, usd: '560' }] })).status, 200);
  assert.match((await feed(below)).byLink.get(SLUG)!, /,In stock,"يبدأ من 840,000","900,000",http/);
});

test('a live window that refuses a guest the product leaves no price: members only, or its quantity used up', async () => {
  const NOT_PRICED_LINE = `طابعة بامبو,Bambu Lab ${SLUG},السعر غير متوفر حالياً,Not priced,,,http://localhost/product/${SLUG}`;
  // Members only: a guest's add to cart answers MEMBERSHIP_REQUIRED, so the feed quotes nothing.
  const members = await discountWorld();
  const gated = await members.saveOffer(members.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }], required_tiers: ['pro'] });
  assert.equal(gated.status, 200, JSON.stringify(gated.body).slice(0, 300));
  const membersFeed = await feed(members);
  assert.equal(membersFeed.byLink.get(SLUG), NOT_PRICED_LINE);
  assert.doesNotMatch(membersFeed.text, /750,000|900,000/);
  // A sale of one unit, sold: the checkout refuses everyone while the window is live (OFFER_GLOBAL_LIMIT).
  const limited = await discountWorld();
  const one = await limited.saveOffer(limited.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }], max_global: 1 });
  assert.equal(one.status, 200, JSON.stringify(one.body).slice(0, 300));
  assert.match((await feed(limited)).byLink.get(SLUG)!, /,In stock,"يبدأ من 750,000","900,000",http/, 'the sale is quoted while a unit is left');
  const add = await limited.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'direct_sale' });
  assert.equal(add.status, 200, JSON.stringify(add.body).slice(0, 300));
  const placed = await limited.placeOrder('cash');
  assert.equal(placed.status, 200, JSON.stringify(placed.body).slice(0, 300));
  assert.equal((await feed(limited)).byLink.get(SLUG), NOT_PRICED_LINE);
  // Switched off after it sold out, the window still refuses every buyer (the checkout counts the product's
  // active redemptions against max_global whatever the window's state), so the feed still quotes nothing.
  // If the checkout ever stops counting a window that is not live, this pair of assertions changes together.
  limited.raw.exec(`UPDATE offer_windows SET active = 0 WHERE subject_type = 'product' AND subject_id = '${PID}'`);
  const again = await limited.addToCart({ productId: PID, optionId: M1, optionValueIds: [M1], qty: 1, fulfillmentType: 'direct_sale' });
  assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 300));
  const refused = await limited.placeOrder('cash');
  assert.equal(refused.status, 400, JSON.stringify(refused.body).slice(0, 300));
  assert.match(JSON.stringify(refused.body), /GLOBAL_LIMIT_REACHED/);
  assert.equal((await feed(limited)).byLink.get(SLUG), NOT_PRICED_LINE);
});
