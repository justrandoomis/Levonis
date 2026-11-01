/**
 * «سعر تقديري» ON EVERY CUSTOMER READ (docs/SMART_PRICING.md §5.1–5.3; WP7;
 * DECISIONS rows 278 and 281; invariants I2 and I6).
 *
 * An estimated price is an ordinary priced SKU — `price_status` stays binary —
 * whose product carries the label `products.price_estimate`, read off the very
 * row the price is read with; the owner may make single SKUs firm
 * (`price_estimate_firm_skus`, read in the overlay's one SKU statement). This
 * suite proves, on the real routes and the real V2 writer:
 *
 *   WHERE THE LABEL APPEARS. The card (`price_estimate`), the product page (the
 *     opening selection, its `pricing` and the card-level `product`), the quote
 *     (per selection), the public API (`price.estimate`), Creative Studio (an
 *     estimate is UNPRICED for creatives) and the order read (a line sold at an
 *     estimate) carry it or honour it — and an unlabelled twin carries none of
 *     it, byte for byte.
 *   A FIRM SKU of a mixed product carries none; once every priced SKU is firm
 *     the card carries none either.
 *   FAIL CLOSED: a firm read that fails labels every SKU of a labelled product
 *     and no other product, and the prices still stand.
 *   A SKU PRICED LATER, by the V2 writer (the form's door), is an estimate: the
 *     label is per product.
 *   WHAT NEVER APPEARS: no supplier price, catalogue key, flag, measure or
 *     estimator figure — seeded with sentinels in every owner-only 0218 table —
 *     in any customer payload or in a non-owner admin's product read (the
 *     `tests/fixtures/costlyProduct.ts` scanner).
 *
 * The cart, the checkout and the purchase doors are the next packages' (WP8,
 * WP9: tests/priceEstimateDoors.test.ts, tests/priceEstimateCheckout.test.ts);
 * here the line projection they share (`customerLinePrice`, `customerOrderPricing`)
 * is pinned.
 *
 * Run: node --import tsx --test tests/priceEstimateCustomerSurfaces.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, ctx, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { productRoutes } from '../worker/routes/products';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { loadRelationsViews } from '../worker/lib/productOverlay';
import { productEstimated, selectionEstimated, selectionKey, skuEstimated } from '../worker/lib/commercialState';
import { customerLinePrice, customerOrderPricing } from '../worker/lib/customerPricing';
import { buildSnapshotData, cardStates, priceOfCard, productDetail } from '../worker/lib/creative/store';
import { resolveListingCards, pricingCtxForUser } from '../worker/routes/products';
import { compareRoutes } from '../worker/routes/compare';
import { profileRoutes } from '../worker/routes/profile';
import { communityFavoriteRoutes } from '../worker/routes/communityFavorites';
import { assistantCardFrom } from '../worker/routes/support';
import type { ResolvedPrice } from '../worker/lib/pricing';

type World = ReturnType<typeof pricingWorld>;
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The estimate, as the apply leaves it: pre-order only, one route, two colours (the first dearer). */
const EST = 'p_est';
/** Its twin, priced the same way and never labelled. */
const PLAIN = 'p_plain';
const slugOf = (pid: string) => `slug-${pid}`;
const colour = (pid: string, k: number) => `${pid}_c${k}`;
const skuOf = (pid: string, k: number) => selectionKey([], colour(pid, k));
const SEA = { fulfillmentType: 'pre_order', transportMethod: 'sea' } as const;

/** What the V2 writer's estimate batch does to the label (trigger T1 lets it in only under the price token). */
function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

/** The owner's confirmation of one SKU (trigger T4: only on a labelled product). */
function firm(raw: DatabaseSync, pid: string, comboKey: string): void {
  raw
    .prepare('INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(pid, comboKey, 'usr_owner', '2026-11-01T00:00:00.000Z');
}

async function world(): Promise<World> {
  const w = pricingWorld();
  for (const pid of [EST, PLAIN]) {
    seedOptionless(w.raw, pid, { routes: ['sea'], saleTypes: ['pre_order'], colours: 2 });
    await writeV2(w.db, pid, {
      method: 'usd',
      points: [
        { scope: 'product', scope_id: '', kind: 'fixed', usd: '20' },
        { scope: 'color', scope_id: colour(pid, 0), kind: 'delta', usd: '2' },
      ],
    });
  }
  label(w.raw, EST);
  return w;
}

/** The storefront routes, with only the products this world priced published (no census auto-publish). */
const storefront = (db: unknown, user: StubUser | null = null) =>
  stubApp(db, user, (a) => a.route('/api/products', productRoutes), { publishV2: false });

async function card(db: unknown, pid: string): Promise<Rec> {
  const res = await get(storefront(db), '/api/products?limit=50');
  assert.equal(res.status, 200);
  const found = ((await json(res)).products as Rec[]).find((c) => c.id === pid);
  assert.ok(found, `${pid} is on the listing`);
  return found;
}

async function quote(db: unknown, pid: string, k: number): Promise<Rec> {
  const res = await post(storefront(db), `/api/products/${slugOf(pid)}/quote`, { qty: 1, colorId: colour(pid, k), ...SEA });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.price_status, 'priced');
  return body;
}

/** The public API v1 through the real Worker (an anonymous agent). */
async function publicApi(db: unknown, path: string): Promise<Rec> {
  const env = { DB: db, STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const res = await worker.fetch(new Request(`https://${APEX}/api/public/v1${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.71' } }), env as never, ctx);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  return body;
}

// ---------------------------------------------------------------- where the label appears

test('the card, the page and the quote carry the label on a labelled product — and its unlabelled twin carries none of it', async () => {
  const w = await world();
  const est = await card(w.db, EST);
  assert.equal(est.price_status, 'priced', 'price_status stays binary: an estimate is priced');
  assert.equal(est.price_estimate, true);
  assert.equal(typeof est.display_price_iqd, 'number');
  const plain = await card(w.db, PLAIN);
  assert.equal('price_estimate' in plain, false, 'emitted only when true');
  assert.equal(plain.display_price_iqd, est.display_price_iqd, 'the label moves no price');

  const page = await json(await get(storefront(w.db), `/api/products/${slugOf(EST)}`));
  assert.equal(page.price_status, 'priced');
  assert.equal(page.price_estimate, true, 'the opening selection is an estimate');
  assert.equal(page.product.price_estimate, true, 'the page card is labelled');
  assert.equal(page.pricing.price_estimate, true, 'the opening price is labelled');
  const twin = await get(storefront(w.db), `/api/products/${slugOf(PLAIN)}`);
  assert.equal((await twin.text()).includes('price_estimate'), false, 'no key anywhere on the twin');

  for (const k of [0, 1]) {
    const q = await quote(w.db, EST, k);
    assert.equal(q.price_estimate, true, `colour ${k}: the selection is an estimate`);
    assert.equal(q.quote.price_estimate, true, `colour ${k}: and so is its line`);
    const t = await quote(w.db, PLAIN, k);
    assert.equal(JSON.stringify(t).includes('price_estimate'), false, `colour ${k} of the twin: no key`);
    assert.equal(t.quote.unit_subtotal_iqd, q.quote.unit_subtotal_iqd, 'the same price, labelled or not');
  }
});

test('a firm SKU of a mixed product carries no label; the card keeps it while any priced SKU is an estimate', async () => {
  const w = await world();
  firm(w.raw, EST, skuOf(EST, 1));
  const firmQuote = await quote(w.db, EST, 1);
  assert.equal('price_estimate' in firmQuote, false, 'the firm SKU is a confirmed price');
  assert.equal('price_estimate' in firmQuote.quote, false);
  assert.equal((await quote(w.db, EST, 0)).price_estimate, true, 'the other SKU is still an estimate');
  assert.equal((await card(w.db, EST)).price_estimate, true, 'one estimated SKU labels the card');
  const page = await json(await get(storefront(w.db), `/api/products/${slugOf(EST)}`));
  assert.equal(page.product.price_estimate, true);
  assert.equal(page.price_estimate, true, 'nothing chosen yet, and a way to buy it is an estimate');

  // Every priced SKU firm: nothing is an estimate any more — no label on the card, the page or a quote.
  firm(w.raw, EST, skuOf(EST, 0));
  const all = await card(w.db, EST);
  assert.equal('price_estimate' in all, false);
  const allPage = await json(await get(storefront(w.db), `/api/products/${slugOf(EST)}`));
  for (const at of [allPage, allPage.product, allPage.pricing]) assert.equal('price_estimate' in at, false);
  assert.equal('price_estimate' in (await quote(w.db, EST, 0)), false);
});

/** A binding whose statements naming the firm table fail with an ordinary D1 error (never "no such table"). */
class FirmReadFails {
  failing = true;
  constructor(readonly inner: D1Database) {}
  prepare(sql: string) {
    const st = this.inner.prepare(sql);
    if (!this.failing || !sql.includes('price_estimate_firm_skus')) return st;
    const boom = async (): Promise<never> => {
      throw new Error('D1_ERROR: simulated read failure (injected by the test)');
    };
    const failed = { all: boom, first: boom, run: boom, raw: boom };
    return { ...failed, bind: () => failed };
  }
  batch(statements: unknown[]) {
    return (this.inner as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(statements);
  }
}

test('a firm read that fails labels every SKU of a labelled product and no other product — and the prices stand', async () => {
  const w = await world();
  firm(w.raw, EST, skuOf(EST, 1));
  const flaky = new FirmReadFails(w.db);
  const db = flaky as unknown as D1Database;
  const errors: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
  try {
    const views = await loadRelationsViews(db, [{ id: EST }, { id: PLAIN }]);
    for (const pid of [EST, PLAIN]) {
      const v = views.get(pid)!;
      assert.equal(v.sku_prices?.length, 2, `${pid}: the SKU prices were read without the arm`);
      assert.equal(v.sku_prices_unread, undefined, `${pid}: not a failed price read`);
      assert.equal(v.sku_strict, true);
      assert.equal(v.sku_firm, undefined, `${pid}: no firm list`);
    }
    // Fail closed: the firm SKU is labelled again; the twin never is.
    assert.equal((await quote(db, EST, 1)).price_estimate, true, 'an unread firm list labels the firm SKU too');
    assert.equal('price_estimate' in (await quote(db, PLAIN, 1)), false, 'an unlabelled product is never labelled');
    assert.equal(typeof (await quote(db, EST, 1)).quote.unit_subtotal_iqd, 'number');
  } finally {
    console.error = log;
  }
  assert.ok(errors.some((e) => e.includes('firm skus')), 'the failure is logged');
  // An ordinary failure is not "0218 is absent": the next read asks for the arm again and honours it.
  flaky.failing = false;
  assert.equal('price_estimate' in (await quote(db, EST, 1)), false, 'read again, the firm SKU is firm');
});

test('a SKU priced later through the V2 writer (the form’s door) is an estimate: the label is the product’s', async () => {
  const w = await world();
  firm(w.raw, EST, skuOf(EST, 1));
  // A delta import (or the owner) adds a third colour; the next price write prices it — never through the estimator.
  w.raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
              VALUES ('${colour(EST, 2)}', '${EST}', 'Colour 3', 'لون 3', 'ڕەنگی 3', '#996633', 2, 1, 5)`);
  await writeV2(w.db, EST, {
    method: 'usd',
    points: [
      { scope: 'product', scope_id: '', kind: 'fixed', usd: '20' },
      { scope: 'color', scope_id: colour(EST, 0), kind: 'delta', usd: '2' },
    ],
  });
  const added = await quote(w.db, EST, 2);
  assert.equal(added.price_estimate, true, 'the new SKU is labelled the moment it is priced');
  assert.equal('price_estimate' in (await quote(w.db, EST, 1)), false, 'a firm SKU stays firm across a reprice');
  assert.equal((await card(w.db, EST)).price_estimate, true);
});

test('the public API says `price.estimate` on the list and the product, false for every other price', async () => {
  const w = await world();
  const product = (await publicApi(w.db, `/products/${slugOf(EST)}`)).data as Rec;
  assert.equal(product.price.status, 'priced');
  assert.equal(product.price.estimate, true);
  assert.ok(product.purchase && product.purchase.pre_order.length === 1, 'one way to buy, one route');
  assert.equal((await publicApi(w.db, `/products/${slugOf(PLAIN)}`)).data.price.estimate, false);
  const list = (await publicApi(w.db, '/products?limit=50')).data as Rec[];
  const bySlug = new Map(list.map((p) => [p.slug, p]));
  assert.equal(bySlug.get(slugOf(EST))?.price.estimate, true);
  assert.equal(bySlug.get(slugOf(PLAIN))?.price.estimate, false);
  for (const p of list) assert.equal(typeof p.price.estimate, 'boolean', `${p.slug}: always present`);
});

test('the compare columns and picker, both favourites lists and the assistant carry the label; the print calculator lists no estimate', async () => {
  const w = await world();
  // A comparison needs a spec sheet; the print calculator lists `materials` with a net weight.
  w.raw.exec(`UPDATE products SET spec_fields = '{"net_weight":"1000","material_type":"PLA"}', template_family = 'materials' WHERE id IN ('${EST}', '${PLAIN}');
    INSERT INTO users (id, name, email, password_hash, role, username) VALUES ('usr_fav', 'Buyer', 'fav@x.co', 'h', 'customer', 'usr_fav');
    INSERT INTO favorites (user_id, product_id) VALUES ('usr_fav', '${EST}'), ('usr_fav', '${PLAIN}');`);
  const buyer: StubUser = { id: 'usr_fav', role: 'customer', email: 'fav@x.co' };
  const shop = (user: StubUser | null) =>
    stubApp(
      w.db,
      user,
      (a) => {
        a.route('/api/products', productRoutes);
        a.route('/api/compare', compareRoutes);
        a.route('/api/profile', profileRoutes);
        a.route('/api/community-favorites', communityFavoriteRoutes);
      },
      { publishV2: false }
    );
  // The comparison's columns (§5.3, the compare row): the label on the estimate's column only.
  const compared = await json(await get(shop(null), `/api/compare?ids=${EST},${PLAIN}`));
  assert.equal(compared.success, true, JSON.stringify(compared).slice(0, 300));
  const column = new Map((compared.products as Rec[]).map((p) => [p.product_id, p]));
  assert.equal(column.get(EST)?.price_estimate, true);
  assert.equal(column.get(EST)?.price_status, 'priced');
  assert.equal('price_estimate' in (column.get(PLAIN) ?? {}), false, 'emitted only when true');
  // The picker priced for a viewer: the same card label.
  const picker = await json(await get(shop(null), '/api/compare/candidates'));
  const offered = new Map((picker.products as Rec[]).map((p) => [p.id, p]));
  assert.equal(offered.get(EST)?.price_estimate, true);
  assert.equal('price_estimate' in (offered.get(PLAIN) ?? {}), false);
  // Both favourites lists: the profile's strip and «المحفوظات».
  const strip = await json(await get(shop(buyer), '/api/profile/favorites'));
  const saved = new Map((strip.favorites as Rec[]).map((f) => [f.id, f]));
  assert.equal(saved.get(EST)?.price_estimate, true);
  assert.equal('price_estimate' in (saved.get(PLAIN) ?? {}), false);
  const merged = await json(await get(shop(buyer), '/api/community-favorites'));
  const items = new Map((merged.items as Rec[]).filter((i) => i.source === 'catalog').map((i) => [i.product_id, i]));
  assert.equal(items.get(EST)?.price_estimate, true);
  assert.equal('price_estimate' in (items.get(PLAIN) ?? {}), false);
  // The print calculator never publishes an estimate as a per-gram figure; the firm twin stays listed.
  const calc = await json(await get(shop(null), '/api/products/print-calculator'));
  const listed = (calc.filaments as Rec[]).map((f) => f.id);
  assert.ok(listed.includes(PLAIN), 'the unlabelled filament is listed');
  assert.equal(listed.includes(EST), false, 'the estimated filament is not');
  // The support assistant's product card copies the listing card's label (and its figure).
  const rows = [EST, PLAIN].map((id) => w.raw.prepare('SELECT *, 1 AS sellable_now FROM products WHERE id = ?').get(id) as Rec);
  const cards = await resolveListingCards(w.db, rows, await pricingCtxForUser(w.db, null), null, 'flag');
  const assistant = assistantCardFrom('en', cards.get(EST)!, rows[0]!, 'Estimated');
  assert.equal(assistant.price_estimate, true);
  assert.match(String(assistant.subtitle), /Estimated price/);
  assert.equal('price_estimate' in assistantCardFrom('en', cards.get(PLAIN)!, rows[1]!, 'Plain'), false);
});

test('Creative Studio quotes no estimate: an estimated card is unpriced for creatives, its twin is priced', async () => {
  const w = await world();
  const ctxGuest = await pricingCtxForUser(w.db, null);
  const rows = [EST, PLAIN].map((id) => w.raw.prepare('SELECT *, 1 AS sellable_now FROM products WHERE id = ?').get(id) as Rec);
  const cards = await resolveListingCards(w.db, rows, ctxGuest, null, 'flag');
  assert.equal(cards.get(EST)!.price_estimate, true);
  assert.equal(priceOfCard(cards.get(EST)!).status, 'unpriced', 'no advert states an estimate as a price');
  assert.equal(priceOfCard(cards.get(EST)!).amount_iqd, null);
  assert.equal(priceOfCard(cards.get(PLAIN)!).status, 'priced');
  const detail = await productDetail(w.db, EST);
  assert.equal(detail?.price.status, 'unpriced');
  const snapshot = await buildSnapshotData(w.db, EST, null);
  assert.equal(snapshot?.price.status, 'unpriced');
  assert.equal(snapshot?.price.amount_iqd, null);
  const states = await cardStates(w.db, [EST, PLAIN]);
  assert.equal(states.get(EST)?.price_status, 'unpriced');
  assert.equal(states.get(EST)?.display_price_iqd, null);
  assert.equal(states.get(PLAIN)?.price_status, 'priced');
});

test('the line projections: a label only where the line is an estimate — never a figure', () => {
  const resolved = {
    regular_iqd: 35_250, applied_iqd: 35_250, applied_tier: 'regular', unit_subtotal_iqd: 35_250,
    fulfillment: { type: 'pre_order', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null },
    transport: { method: 'sea' }, warranty: null, errors: [],
  } as unknown as ResolvedPrice;
  assert.equal(customerLinePrice(resolved, { estimate: true }).price_estimate, true);
  assert.equal('price_estimate' in customerLinePrice(resolved), false);
  assert.equal('price_estimate' in customerLinePrice(resolved, { estimate: false }), false);
  // A stored order line: the checkout freezes `estimate: {v: <the acknowledged notice version>}` (§6.3).
  const sold = { regular_iqd: 35_250, applied_iqd: 35_250, unit_subtotal_iqd: 35_250, applied_tier: 'regular' };
  assert.equal(customerOrderPricing({ ...sold, estimate: { v: 1 } })!.price_estimate, true);
  for (const bad of [undefined, null, true, 1, {}, { v: 0 }, { v: -1 }, { v: 1.5 }, { v: '1' }]) {
    assert.equal('price_estimate' in customerOrderPricing({ ...sold, estimate: bad })!, false, JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(customerOrderPricing({ ...sold, estimate: { v: 1 } })).includes('"v"'), false, 'the notice version stays on the row');
});

test('the helpers: skuEstimated / productEstimated / selectionEstimated fail closed for a labelled product, never for another', () => {
  const rows = [
    { combo_key: 'c:a', channel: 'pre_order_sea', regular_price_iqd: 1000 },
    { combo_key: 'c:b', channel: 'pre_order_sea', regular_price_iqd: 1250 },
  ];
  const labelled = { price_estimate: true as const, sku_strict: true as const, sku_prices: rows };
  assert.equal(skuEstimated(labelled, 'c:a'), true);
  assert.equal(skuEstimated({ ...labelled, sku_firm: ['c:a'] }, 'c:a'), false);
  assert.equal(skuEstimated({ sku_firm: ['c:a'] }, 'c:b'), false, 'an unlabelled product is never an estimate');
  assert.equal(productEstimated(labelled), true);
  assert.equal(productEstimated({ ...labelled, sku_firm: ['c:a'] }), true, 'c:b is still an estimate');
  assert.equal(productEstimated({ ...labelled, sku_firm: ['c:a', 'c:b'] }), false, 'every priced SKU firm');
  assert.equal(productEstimated({ price_estimate: true, sku_firm: ['c:a', 'c:b'] }), true, 'rows unknown: fail closed');
  assert.equal(productEstimated({ ...labelled, sku_prices: [], sku_firm: ['c:a'] }), true, 'no row read: fail closed');
  assert.equal(productEstimated({ sku_strict: true, sku_prices: rows }), false);

  // A selection: the SKU it names, or — naming none yet — any priced SKU that could finish it.
  const grid = [
    { combo_key: 'o:m1|c:x', channel: 'pre_order_sea', regular_price_iqd: 1000 },
    { combo_key: 'o:m1|c:y', channel: 'pre_order_sea', regular_price_iqd: 1000 },
    { combo_key: 'o:m2|c:x', channel: 'pre_order_sea', regular_price_iqd: 1250 },
  ];
  const mixed = { price_estimate: true as const, sku_strict: true as const, sku_prices: grid, sku_firm: ['o:m1|c:x', 'o:m1|c:y'] };
  assert.equal(selectionEstimated(mixed, ['m1'], 'x'), false, 'a firm SKU');
  assert.equal(selectionEstimated(mixed, ['m2'], 'x'), true, 'an estimated SKU');
  assert.equal(selectionEstimated(mixed, ['m1'], null), false, 'every way to finish model 1 is firm');
  assert.equal(selectionEstimated(mixed, [], 'x'), true, 'colour x can still be model 2, an estimate');
  assert.equal(selectionEstimated(mixed, [], null), true, 'nothing chosen: some way to buy it is an estimate');
  assert.equal(selectionEstimated({ ...mixed, sku_firm: grid.map((r) => r.combo_key) }, [], null), false, 'all firm: no label');
  assert.equal(selectionEstimated({ price_estimate: true }, ['m1'], 'x'), true, 'rows unknown: fail closed');
  assert.equal(selectionEstimated({ sku_strict: true, sku_prices: grid }, ['m2'], 'x'), false, 'unlabelled: never');
});

// ---------------------------------------------------------------- what never appears

/** Sentinels in every owner-only 0218 table: figures and words no public answer can hold. */
const PRIVATE = {
  decimals: ['173.37', '419.83', '58.91', '4.73', '0.031477'],
  numbers: [7731, 67891, 676767, 686868, 371, 291],
  words: ['TMALL-TITLE-SECRET-7E', 'SUPPLIER-ITEM-7E', 'supplier-secret-7e.example', 'EST_DEFAULT_WEIGHT', 'EST_US_REFERENCE', 'tmall_cn', 'type_default', '优惠前'],
} as const;

function seedEstimateSentinels(raw: DatabaseSync, pid: string): void {
  const now = '2026-11-01T00:00:00.000Z';
  raw.exec(`
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, captured_by, file_sha256, item_count, sku_count, state, created_by, created_at, completed_at)
      VALUES ('sps_7e_cn', 'tmall_cn', 'CNY', 'browser_sweep', '2026-10-31', 'usr_owner', '${'a'.repeat(64)}', 1, 1, 'complete', 'usr_owner', '${now}', '${now}'),
             ('sps_7e_eu', 'bambu_eu', 'EUR', 'browser_sweep', '2026-10-31', 'usr_owner', '${'b'.repeat(64)}', 1, 1, 'complete', 'usr_owner', '${now}', '${now}');
    INSERT INTO supplier_price_items (snapshot_id, item_key, url, page_host, title, name_en, category, sourcing_hint, route_hint)
      VALUES ('sps_7e_cn', 'SUPPLIER-ITEM-7E', 'https://supplier-secret-7e.example/item.htm?id=1', 'supplier-secret-7e.example', 'TMALL-TITLE-SECRET-7E', 'PLA refill', 'filament', 'CHINA_CNY', 'CHINA_SEA'),
             ('sps_7e_eu', 'SUPPLIER-ITEM-7E', 'https://supplier-secret-7e.example/eu', 'supplier-secret-7e.example', 'TMALL-TITLE-SECRET-7E', 'AMS', 'ams', 'EU_STORE_EUR', 'GERMANY_LAND');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, sku_code, price, price_label, quantity, pack_units, net_weight_g)
      VALUES ('sps_7e_cn', 'SUPPLIER-ITEM-7E', 'SUPPLIER-ITEM-7E-sku', 'SUPPLIER-ITEM-7E-code', '173.37', '优惠前', 9, 1, 7731),
             ('sps_7e_eu', 'SUPPLIER-ITEM-7E', 'SUPPLIER-ITEM-7E-eu', '', '419.83', '', NULL, 1, NULL);
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, reasons_json, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('${pid}', '', 'tmall_cn', 'SUPPLIER-ITEM-7E', 'SUPPLIER-ITEM-7E-sku', 'exact', 'color_code', '["EST_US_REFERENCE"]', 'confirmed', 'auto', '${now}', 'sps_7e_cn', '${now}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, evidence_url, evidence_host, note, entered_by, entered_at)
      VALUES ('${pid}', '${colour(pid, 0)}', '58.91', 'USD', 'store_page', 'https://supplier-secret-7e.example/us', 'supplier-secret-7e.example', 'TMALL-TITLE-SECRET-7E', 'usr_owner', '${now}');
    UPDATE price_estimate_types SET default_weight_g = 7731, default_length_mm = 371, default_width_mm = 291, default_height_mm = 173,
                                    default_cbm = '0.031477', additional_cost_iqd = 67891, min_profit_usd = '4.73' WHERE key = 'filament';
    INSERT INTO product_price_estimates (product_id, type_key, type_source, state, measure_basis, flags_json, preview_hash, computed_at, applied_at, applied_by, applied_wire_json, updated_at)
      VALUES ('${pid}', 'filament', 'supplier_category', 'estimated', 'type_default', '["EST_DEFAULT_WEIGHT","EST_US_REFERENCE"]', '${'c'.repeat(64)}', '${now}', '${now}', 'usr_owner',
              '{"inputs":[{"scope":"base","supplier_cost_amount":"173.37","source":"tmall_cn"},{"scope":"base","shipping_weight_g":7731,"source":"type_default"}],"rule":{"minimum_profit":"4.73"}}', '${now}');
    INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, supplier_amount, supplier_currency, measure_source, flags_json, est_cost_iqd, est_price_iqd, published_price_iqd, computed_at)
      VALUES ('${pid}', '${skuOf(pid, 0)}', 'pre_order_sea', 'tmall_cn', '173.37', 'CNY', 'type_default', '["EST_DEFAULT_WEIGHT"]', 676767, 686868, NULL, '${now}');
  `);
}

const FULL_ADMIN: StubUser = { id: 'usr_full_7e', role: 'admin', email: 'full7e@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'usr_asst_7e', role: 'admin', email: 'asst7e@x.co', admin_scope: 'assistant' };

test('no supplier price, catalogue key, flag, measure or estimator figure reaches a customer, an agent or a non-owner admin', async () => {
  const w = await world();
  seedEstimateSentinels(w.raw, EST);
  w.raw.exec(`INSERT INTO users (id, name, email, password_hash, role, admin_scope, email_verified_at) VALUES
    ('${FULL_ADMIN.id}', 'Full', '${FULL_ADMIN.email}', 'h', 'admin', 'full', '2026-01-01T00:00:00.000Z'),
    ('${ASSISTANT.id}', 'Asst', '${ASSISTANT.email}', 'h', 'admin', 'assistant', '2026-01-01T00:00:00.000Z')`);
  const answers: Array<[string, unknown]> = [];
  for (const user of [null, { id: 'u_c7e', role: 'customer', email: 'c7e@x.co' } as StubUser]) {
    const app = storefront(w.db, user);
    const who = user ? 'customer' : 'guest';
    answers.push([`${who} GET /api/products`, await json(await get(app, '/api/products?limit=50'))]);
    answers.push([`${who} GET /api/products/:slug`, await json(await get(app, `/api/products/${slugOf(EST)}`))]);
    answers.push([`${who} POST quote`, await json(await post(app, `/api/products/${slugOf(EST)}/quote`, { qty: 1, colorId: colour(EST, 0), ...SEA }))]);
  }
  answers.push(['agent GET /api/public/v1/products/:slug', await publicApi(w.db, `/products/${slugOf(EST)}`)]);
  answers.push(['agent GET /api/public/v1/products', await publicApi(w.db, '/products?limit=50')]);
  for (const admin of [FULL_ADMIN, ASSISTANT]) {
    const app = stubApp(w.db, admin, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });
    const res = await get(app, `/api/admin/products-v2/${EST}`);
    assert.equal(res.status, 200, `${admin.admin_scope} admin reads the product`);
    answers.push([`${admin.admin_scope} admin GET /api/admin/products-v2/:id`, await json(res)]);
  }
  const problems: string[] = [];
  for (const [at, body] of answers) {
    problems.push(...leaks(body, { decimals: PRIVATE.decimals, numbers: PRIVATE.numbers }).map((l) => `${at}: ${l}`));
    const text = JSON.stringify(body);
    for (const word of PRIVATE.words) if (text.includes(word)) problems.push(`${at}: carries «${word}»`);
    for (const key of ['sku_firm', 'flags_json', 'applied_wire_json', 'price_source', 'supplier_amount']) if (text.includes(`"${key}"`)) problems.push(`${at}: carries the key ${key}`);
  }
  assert.deepEqual(problems, []);
  // Not vacuous: the customer answers do carry the label, and the owner-only rows are really there.
  assert.equal((answers[1][1] as Rec).price_estimate, true);
  assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM price_estimate_lines WHERE est_cost_iqd = 676767').get() as { n: number }).n), 1);
});
