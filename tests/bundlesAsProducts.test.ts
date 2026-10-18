/**
 * BUNDLES AND MYSTERY BOXES, PRICED AND OPENED LIKE ORDINARY PRODUCTS
 * (the owner's decision of 2026-10-18, DECISIONS row 250, amending addendum A.14 / Q7).
 *
 *   1. a bundle priced FROM COST gets exactly the price an ordinary product with the
 *      same cost and minimum profit gets (the same V2 maths, the same rounding rule);
 *   2. a bundle priced FROM A DOLLAR PRICE is the dollar × U on the rounding rule, and
 *      the automatic repricing follows U for it as for any product (the dollar is the base);
 *   3. a mystery box is priced the same way, and quoted to a guest;
 *   4. a non-subscriber sees a bundle and can buy it: 0201 clears the members-only
 *      gate 0063 wrote, and leaves an ordinary product's window alone;
 *   5. an existing composition with no V2 price keeps its archived dinar figure, is
 *      not listed and not sold, and the owner reads «يحتاج تسعيرًا» in the queue and
 *      the bundles panel — until the owner prices it through the same section ٣ door.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/bundlesAsProducts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, OWNER, post, put, stubApp, type StubUser } from './fixtures/app';
import { applyRate, fxEnv, OWNER_ROW_SQL } from './fixtures/fx';
import { seedProfileRates } from './fixtures/legacyCatalogue';
import { writeV2 } from './fixtures/pricingV2';
import { ensureUsdRate, isV2Published, publishAllV2, publishV2 } from './fixtures/v2Publish';
import { addBundle, seedCatalogue } from './lib/bundles';
import { addMysteryOffer, seedMysteryPool } from './lib/mysteryOffer';
import { isOnPriceRule } from '../packages/pricing/src/priceRounding';
import { bundlesRoutes } from '../worker/routes/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { repriceStaleEngineProducts } from '../worker/lib/pricingEngine/autoReprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

const GUEST = null;
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const COMPONENTS = ['p_printer', 'p_pla', 'p_nozzle'];

const shop = (raw: DatabaseSync, user: StubUser | null, opts: { publishV2?: boolean } = {}) =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.route('/api/bundles', bundlesRoutes);
      a.route('/api/cart', cartRoutes);
    },
    opts
  );

const admin = (raw: DatabaseSync) =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin/bundles', adminBundlesRoutes);
    a.route('/api/admin/products-v2', adminProductsRoutes);
  });

const directPrice = (raw: DatabaseSync, id: string): number => {
  const rows = raw.prepare('SELECT channel, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = ?').all(id) as Array<{ channel: string; final_price_iqd: number }>;
  assert.deepEqual(rows.map((r) => r.channel), ['direct_sale'], `${id} is priced on its one direct channel`);
  return Number(rows[0]!.final_price_iqd);
};

/** An ordinary product to compare with: the same shape a bundle's price has (one SKU, sold direct). */
const addTwin = (raw: DatabaseSync, id: string) =>
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
            VALUES ('${id}','${id}','Twin','توأم','دووانە',0,'active',NULL,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE')`);

/** The central rates a cost-first price needs (the procurement world's: U = 1,600, EUR/USD 1.1, Germany by land 3,200). */
function costRates(raw: DatabaseSync): void {
  raw.exec(OWNER_ROW_SQL);
  seedProfileRates(raw);
  applyRate(raw, 'USD_IQD', '1600');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'");
}

const COST = { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 } as const;

test('a bundle priced FROM COST gets exactly the price an ordinary product with the same cost and minimum profit gets', async () => {
  const raw = seedCatalogue();
  costRates(raw);
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 0 });
  addTwin(raw, 'p_twin');
  await publishAllV2(raw, { ids: COMPONENTS, u: '1600' });

  await writeV2(asD1(raw), 'prd_b1', { method: 'cost', inputs: { ...COST }, minimumProfitUsd: '120' });
  await writeV2(asD1(raw), 'p_twin', { method: 'cost', inputs: { ...COST }, minimumProfitUsd: '120' });
  const bundle = directPrice(raw, 'prd_b1');
  assert.ok(bundle > 0 && isOnPriceRule(bundle), `${bundle} is a price on the rounding rule`);
  assert.equal(bundle, directPrice(raw, 'p_twin'), 'the same cost priced a bundle differently from a product');

  // The storefront quotes the V2 price, to a guest, card and detail alike.
  const card = (await json(await get(shop(raw, GUEST), '/api/bundles'))).bundles[0];
  assert.equal(card.display_price_iqd, bundle);
  assert.equal((await json(await get(shop(raw, GUEST), '/api/bundles/starter'))).bundle.display_price_iqd, bundle);
});

test('a bundle priced FROM A DOLLAR PRICE is the dollar × U on the rounding rule, as an ordinary product is', async () => {
  const raw = seedCatalogue();
  ensureUsdRate(raw, '1500');
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 0 });
  addTwin(raw, 'p_twin');
  await publishAllV2(raw, { ids: COMPONENTS });
  await publishV2(raw, 'prd_b1', { usd: '250.10' });
  await publishV2(raw, 'p_twin', { usd: '250.10' });
  // 250.10 × 1,500 = 375,150 → up to the next 250 (DECISIONS row 245).
  assert.equal(directPrice(raw, 'prd_b1'), 375_250);
  assert.equal(directPrice(raw, 'p_twin'), 375_250);
  const card = (await json(await get(shop(raw, GUEST), '/api/bundles'))).bundles[0];
  assert.equal(card.display_price_iqd, 375_250);
  assert.equal(card.composition.component_total_iqd, 400_000 + 2 * 25_000 + 5_000);
});

test('the dollar stays the base: when U moves, the automatic repricing moves a bundle\'s dinar price as it moves a product\'s', async () => {
  const raw = seedCatalogue();
  costRates(raw);
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 0 });
  await publishAllV2(raw, { ids: COMPONENTS, u: '1600' });
  await publishV2(raw, 'prd_b1', { usd: '250' });
  assert.equal(directPrice(raw, 'prd_b1'), 400_000);

  applyRate(raw, 'USD_IQD', '1632');
  const report = await repriceStaleEngineProducts({ ...fxEnv(raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' } as Env, { trigger: 'fx', budget: statementBudget(600) });
  assert.ok(report.repriced.includes('prd_b1'), JSON.stringify(report));
  // 250 × 1,632 = 408,000 — on the rounding rule already.
  assert.equal(directPrice(raw, 'prd_b1'), 408_000);
});

test('a mystery box is priced like a product: its own dollar price, listed and quoted to a guest', async () => {
  const raw = seedCatalogue();
  ensureUsdRate(raw, '1500');
  seedMysteryPool(raw);
  addMysteryOffer(raw, { priceIqd: 0 });
  await publishAllV2(raw, { ids: raw.prepare("SELECT id FROM products WHERE COALESCE(composition, '') = ''").all().map((r) => String((r as { id: string }).id)) });
  assert.equal(isV2Published(raw, 'p_mystery'), false);
  assert.equal((await json(await get(shop(raw, GUEST), '/api/bundles?kind=mystery'))).bundles.length, 0, 'an unpriced mystery box was listed');

  await publishV2(raw, 'p_mystery', { usd: '40' });
  assert.equal(directPrice(raw, 'p_mystery'), 60_000);
  const card = (await json(await get(shop(raw, GUEST), '/api/bundles?kind=mystery'))).bundles[0];
  assert.equal(card.display_price_iqd, 60_000);
  assert.equal((await json(await get(shop(raw, GUEST), '/api/bundles/mystery-box'))).bundle.display_price_iqd, 60_000);
});

test('a non-subscriber sees a bundle and can buy it: 0201 clears the members-only gate 0063 wrote, and only that', async () => {
  const raw = seedCatalogue();
  // The migrated legacy bundle: gated to PLUS / PRIME / PRO exactly as 0063 wrote it.
  addBundle(raw, { id: 'prd_b1', slug: 'starter', window: { required_tiers: '["plus","prime","pro"]' } });
  seedMysteryPool(raw);
  addMysteryOffer(raw, { requiredTiers: '["plus"]' });
  raw.exec(`INSERT INTO offer_windows (subject_type, subject_id, id, required_tiers, active) VALUES ('product', 'p_color', 'ofw_p_color', '["plus"]', 1)`);

  const before = (await json(await get(shop(raw, BUYER), '/api/bundles?kind=bundle'))).bundles[0];
  assert.equal(before.locked, true, 'the fixture is the gated legacy bundle');

  raw.exec(readFileSync('migrations/0201_compositions_open_to_everyone.sql', 'utf8'));
  const tiers = (id: string) => String((raw.prepare("SELECT required_tiers AS t FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?").get(id) as { t: string }).t);
  assert.equal(tiers('prd_b1'), '[]');
  assert.equal(tiers('p_mystery'), '[]');
  assert.equal(tiers('p_color'), '["plus"]', 'an ordinary product’s window is not the section’s gate');
  // Idempotent: a second pass changes nothing.
  raw.exec(readFileSync('migrations/0201_compositions_open_to_everyone.sql', 'utf8'));
  assert.equal(tiers('prd_b1'), '[]');

  for (const user of [GUEST, BUYER]) {
    const card = (await json(await get(shop(raw, user), '/api/bundles?kind=bundle'))).bundles[0];
    assert.equal(card.locked, false, `${user ? 'a free account' : 'a guest'} still sees a locked card`);
    assert.equal(card.display_price_iqd, 400_000);
  }
  const added = await json(await post(shop(raw, BUYER), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added).slice(0, 300));
  assert.equal(added.items[0].kind, 'bundle');
  assert.equal(added.items[0].unit_price_iqd, 400_000);
});

test('an existing composition with no V2 price is not sold, keeps its archived price, and shows «يحتاج تسعيرًا» to the owner until priced', async () => {
  const raw = seedCatalogue();
  ensureUsdRate(raw, '1500');
  // An existing bundle with its old dinar figure: under the clean start it is an archive, never a price.
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000, config: { price_mode: 'discount_percent', discount_percent: 10 } });
  await publishAllV2(raw, { ids: COMPONENTS });

  const store = shop(raw, BUYER, { publishV2: false });
  assert.equal((await json(await get(store, '/api/bundles'))).bundles.length, 0, 'an unpriced bundle was listed');
  assert.equal((await get(store, '/api/bundles/starter')).status, 404);
  const refused = await post(store, '/api/cart/items', { productId: 'prd_b1', qty: 1 });
  assert.notEqual(refused.status, 200, 'an unpriced bundle was sold');
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM cart_items').get() as { n: number }).n), 0);
  assert.equal(Number((raw.prepare("SELECT price_iqd FROM products WHERE id = 'prd_b1'").get() as { price_iqd: number }).price_iqd), 400_000, 'no price moved silently');

  // The owner: the queue lists it like any product, with the bundles panel's own section ٣ …
  const app = admin(raw);
  const queue = await json(await get(app, '/api/admin/products-v2/needs-pricing?filter=all&page=1'));
  const row = (queue.products as Array<Record<string, unknown>>).find((r) => r.id === 'prd_b1');
  assert.ok(row, 'the bundle is not in «يحتاج تسعيرًا»');
  assert.equal(row!.state, 'needs_pricing');
  assert.equal(row!.composition, 'bundle');
  assert.equal(row!.link, '/admin?tab=bundles&edit=prd_b1&section=3');
  // … and the bundles panel says so, in all three languages.
  const panel = await json(await get(app, '/api/admin/bundles'));
  const listed = (panel.bundles as Array<Record<string, unknown>>).find((b) => b.id === 'prd_b1')!;
  assert.equal(listed.needs_pricing, true);
  const issue = (listed.warning_details as Array<Record<string, string>>).find((w) => w.code === 'COMPOSITION_NEEDS_PRICING');
  assert.ok(issue, JSON.stringify(listed.warning_details));
  assert.match(issue!.ar, /يحتاج تسعيرًا/);
  assert.match(issue!.en, /needs pricing/);
  assert.match(issue!.ckb, /نرخدانان/);
  assert.notEqual(issue!.ckb, issue!.ar);
  const one = await json(await get(app, '/api/admin/bundles/prd_b1'));
  assert.equal(one.needs_pricing, true);

  // The owner prices it through the same door as any product (section ٣, the prices-only apply).
  const stored = await json(await get(app, '/api/admin/products-v2/prd_b1/pricing'));
  assert.equal(stored.needs_pricing, true);
  const pricing = { method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd: '250' }] };
  const bare = await json(await put(app, '/api/admin/products-v2/prd_b1/pricing', { seq: stored.seq, pricing }));
  assert.equal(bare.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(bare).slice(0, 300));
  const res = await put(app, '/api/admin/products-v2/prd_b1/pricing', { seq: stored.seq, pricing, preview_hash: bare.details.preview.review_hash, confirm_large_change: true });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 300));
  assert.equal(directPrice(raw, 'prd_b1'), 375_000);

  assert.equal((await json(await get(admin(raw), '/api/admin/bundles/prd_b1'))).needs_pricing, false);
  const card = (await json(await get(store, '/api/bundles'))).bundles[0];
  assert.equal(card.display_price_iqd, 375_000, 'the retired derived discount still priced the bundle');
  const added = await json(await post(store, '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added).slice(0, 300));
  assert.equal(added.items[0].unit_price_iqd, 375_000);
});
