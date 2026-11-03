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
import { COST_M, COST_SLUG, M1, M2, SLUG, discountWorld, seedShapes, type DiscountWorld } from './fixtures/productDiscount';
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
  assert.equal(byLink.get(SLUG), `طابعة بامبو,Bambu Lab ${SLUG},متوفر الآن (بيع مباشر),In stock,"يبدأ من ${grouped(p1s)}",http://localhost/product/${SLUG}`);
  // The cost-first AMS: one model on the shelf, one price — no «يبدأ من».
  const ams = await directQuote(w, COST_SLUG, COST_M);
  assert.match(byLink.get(COST_SLUG)!, new RegExp(`,In stock,"${grouped(ams)}",`));
  // Colour-only, both colours on the shelf: the direct prices, the dearer colour making it «from».
  assert.match(byLink.get('slug-p_colours')!, /,In stock,"يبدأ من 900,000",/);
  // Pre-order only: the agent's sentence, no price. Never priced: «السعر غير متوفر حالياً».
  assert.equal(byLink.get('slug-p_preonly'), 'منتج,Product p_preonly,طلب مسبق — نكدر نوفره لك، والإدارة تبلغك بالسعر والموعد,Pre-order,,http://localhost/product/slug-p_preonly');
  assert.equal(byLink.get('slug-p_unpriced'), 'منتج,Product p_unpriced,السعر غير متوفر حالياً,Not priced,,http://localhost/product/slug-p_unpriced');
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
  assert.equal(guest.byLink.get(SLUG), `طابعة بامبو,Bambu Lab ${SLUG},طلب مسبق — نكدر نوفره لك، والإدارة تبلغك بالسعر والموعد,Pre-order,,http://localhost/product/${SLUG}`);
  assert.doesNotMatch(guest.text, /900,000|825,000/);
  // A guest's prices for every caller: the buyer's answer is the guest's, and it leaves `private, no-store`.
  const buyer = await feed(w, w.buyer);
  assert.equal(buyer.text, guest.text);
  assert.equal(buyer.res.headers.get('cache-control'), 'private, no-store');
});
