/**
 * AN ESTIMATED PRODUCT PUBLISHES EXACTLY ONE ROUTE (docs/SMART_PRICING.md §4.1,
 * §4.7–4.8, §5.3; DECISIONS rows 220 (a) and 279; WP7).
 *
 * Two published pre-order routes of one product leak their freight difference:
 * every route is priced on the same supplier cost, extra cost and profit, so
 * the spread of two route prices IS the private freight spread
 * (tests/leakAudit_customer-api_route_price_spread_reveals_freight.test.ts,
 * row 220 (a), pinned `todo`). The estimate therefore never grows that leak:
 * the apply makes the product pre-order-only on its type's ONE route, and the
 * customer read path must publish that one route and nothing else — no second
 * route from a default, no direct price, on any surface.
 *
 * The product here is priced as the estimator prices it (cost-first through the
 * real V2 writer: a Tmall CNY price, sea freight per CBM on its box, the type's
 * minimum profit as the product's own rule) and structured as the apply leaves
 * it (`sale_types ['pre_order']`, one active route). Then every customer
 * surface is read: the page (`product.preorder_transports`, `pricing_modes`,
 * `availability`), the quote (its route and any other), and the public API
 * (`purchase`) — exactly one route, priced, and the label beside it. The label
 * itself adds no route and drops none: the same product unlabelled publishes
 * the same routes at the same prices.
 *
 * Run: node --import tsx --test tests/priceEstimateRouteSpread.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, ctx, get, json, post, stubApp } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { productRoutes } from '../worker/routes/products';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EST = 'p_est_sea';
const SLUG = `slug-${EST}`;
const ROUTE = 'sea';
const OTHER_ROUTES = ['air', 'land'] as const;

function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

/**
 * The census world's rates (tests/fixtures/pricingV2.ts: U = 1,600, CNY/USD 0.14, China sea 400,000 IQD per
 * CBM) and the estimate's inputs, as the estimator writes them (§4.3–4.4): a PLA refill at 69 CNY, its
 * 200 × 200 × 100 mm box on the base row, sea, and the filament type's minimum profit of $2.
 */
const INPUTS = {
  supplier_cost_amount: '69',
  supplier_cost_currency: 'CNY',
  shipping_profile: 'CHINA_SEA',
  shipping_weight_g: 1_000,
  shipping_length_mm: 200,
  shipping_width_mm: 200,
  shipping_height_mm: 100,
} as const;
/** §4.3: R = 69 × 0.14 × 1,600 + 0.004 × 400,000 = 17,056; E_D = R + 2 × 1,600 = 20,256; D = 20,500 (next 250). */
const D = 20_500;

async function world(labelled: boolean) {
  const w = pricingWorld();
  // As the apply leaves it: pre-order only, on the type's one route.
  seedOptionless(w.raw, EST, { routes: [ROUTE], saleTypes: ['pre_order'] });
  await writeV2(w.db, EST, { method: 'cost', inputs: { ...INPUTS }, minimumProfitUsd: '2' });
  if (labelled) label(w.raw, EST);
  return w;
}

const storefront = (db: unknown) => stubApp(db, null, (a) => a.route('/api/products', productRoutes), { publishV2: false });

async function agent(db: unknown, path: string): Promise<Rec> {
  const env = { DB: db, STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const res = await worker.fetch(new Request(`https://${APEX}/api/public/v1${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.73' } }), env as never, ctx);
  assert.equal(res.status, 200);
  return json(res);
}

/** Every route a customer answer names with a price, wherever it does. */
function pricedRoutes(page: Rec, quote: Rec, api: Rec): Record<string, string[]> {
  const modes = (m: Rec | null | undefined) => ((m?.preorder ?? []) as Rec[]).filter((r) => r.prepaid || r.cod).map((r) => String(r.method));
  return {
    'page product.preorder_transports': (page.product.preorder_transports as Rec[]).map((t) => String(t.method)),
    'page pricing_modes.preorder': modes(page.pricing_modes),
    'page availability.preorder.transports': ((page.availability?.preorder?.transports ?? []) as Rec[]).filter((t) => t.configured).map((t) => String(t.method)),
    'quote pricing_modes.preorder': modes(quote.pricing_modes),
    'quote availability.preorder.transports': ((quote.availability?.preorder?.transports ?? []) as Rec[]).filter((t) => t.configured).map((t) => String(t.method)),
    'public API purchase.pre_order': ((api.data.purchase?.pre_order ?? []) as Rec[]).filter((p) => p.prepaid !== null || p.cash_on_delivery !== null).map((p) => String(p.method)),
  };
}

async function read(db: unknown) {
  const app = storefront(db);
  const page = await json(await get(app, `/api/products/${SLUG}`));
  const quote = await json(await post(app, `/api/products/${SLUG}/quote`, { qty: 1, fulfillmentType: 'pre_order', transportMethod: ROUTE }));
  const api = await agent(db, `/products/${SLUG}`);
  return { app, page, quote, api };
}

test('the estimated product is priced as the estimator prices it: cost-first, D on its one route', async () => {
  const w = await world(true);
  const { quote } = await read(w.db);
  assert.equal(quote.price_status, 'priced');
  assert.equal(quote.price_estimate, true, 'and labelled');
  assert.equal(quote.quote.unit_subtotal_iqd, D, '§4.3: supplier + freight + the type’s minimum profit, rounded up to the next 250');
  assert.deepEqual(quote.quote.errors, []);
});

test('every customer surface publishes exactly one route, priced — never a second, never a direct price', async () => {
  const w = await world(true);
  const { app, page, quote, api } = await read(w.db);
  assert.equal(page.price_estimate, true);
  for (const [at, routes] of Object.entries(pricedRoutes(page, quote, api))) {
    assert.deepEqual(routes, [ROUTE], `${at}: exactly the one route`);
  }
  assert.equal(page.pricing_modes.direct, null, 'no direct price on the page');
  assert.equal(quote.pricing_modes.direct, null, 'nor on the quote');
  assert.equal(api.data.purchase.direct_sale, null, 'nor in the public API');
  assert.deepEqual(page.product.sale_types, ['pre_order']);
  assert.equal(api.data.price.estimate, true);
  // Asking for another route prices nothing: no second figure exists to subtract from the first.
  for (const other of OTHER_ROUTES) {
    const q = await json(await post(app, `/api/products/${SLUG}/quote`, { qty: 1, fulfillmentType: 'pre_order', transportMethod: other }));
    const routes = ((q.pricing_modes?.preorder ?? []) as Rec[]).map((r) => String(r.method));
    assert.deepEqual(routes, [ROUTE], `${other}: the ways to buy are still the one route`);
    assert.ok((q.quote?.errors ?? []).length > 0 || q.price_status !== 'priced', `${other}: not offered`);
  }
});

test('the label adds no route and drops none: the same product unlabelled publishes the same routes at the same prices', async () => {
  const labelled = await read((await world(true)).db);
  const plain = await read((await world(false)).db);
  assert.deepEqual(pricedRoutes(labelled.page, labelled.quote, labelled.api), pricedRoutes(plain.page, plain.quote, plain.api));
  assert.deepEqual(labelled.page.pricing_modes, plain.page.pricing_modes);
  assert.deepEqual(labelled.quote.pricing_modes, plain.quote.pricing_modes);
  assert.deepEqual(labelled.api.data.purchase, plain.api.data.purchase);
  assert.equal('price_estimate' in plain.page, false);
});
