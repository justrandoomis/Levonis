/**
 * PRICING V2-3 — AUTOMATIC REPRICING OVER EVERY V2 PRODUCT (spec §3.4
 * autoReprice and ratePreview, §3.7; FX-5's run, unchanged in its budget,
 * deficit order, blocks, bell and purge).
 *
 * V2 products are `mode = 'engine'`, so the run already selects them; only the
 * branch after the selection is new. Proves:
 *   - U moves past the dead band: every V2 product, both methods, reprices in
 *     the same run beside a V1 engine product — a price-first product follows
 *     U (its dollars re-read), deficit first, within the statement budget (a
 *     tight budget defers the rest, a later run finishes them);
 *   - EUR moves: only the cost-first EUR product moves;
 *   - a shipping rate moves: the cost-first product whose ROUTE uses it
 *     reprices (`engine_owner`), and one whose route cost would now exceed D
 *     is held (V2_ROUTE_BELOW_COST) with its prices unchanged — never blocked
 *     silently;
 *   - `price_history` carries `engine_fx` and U; the purge lists exactly the
 *     moved products' pages;
 *   - the owner's rate-act preview lists the V2 products, and its hash moves
 *     with them.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2AutoReprice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, row } from './fixtures/app';
import { applyRate, fxEnv } from './fixtures/fx';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { seedOptionless, writeV2, cartGrid } from './fixtures/pricingV2';
import { repriceStaleEngineProducts, autoRepriceStatus } from '../worker/lib/pricingEngine/autoReprice';
import { statementBudget } from '../worker/lib/fx/budget';
import { previewRateAct } from '../worker/lib/pricingEngine/ratePreview';
import { loadPricingRates } from '../worker/lib/pricingEngine/rates';
import type { Env } from '../worker/lib/types';

type World = ReturnType<typeof pricingWorld>;

const AMS2 = legacyProductId('bambu-lab-ams-2-pro');
const V1 = legacyProductId('bambu-lab-a1');
const OL = 'p_v2_ol';
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });
const envOf = (raw: DatabaseSync): Env => ({ ...fxEnv(raw), STORE_ROOT_DOMAIN: 'levonis-iq.com' }) as Env;
const ceil1000 = (n: number) => Math.ceil(n / 1000) * 1000;
const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

function trapPurges() {
  const g = globalThis as { caches?: unknown };
  const before = g.caches;
  const paths: string[] = [];
  g.caches = { default: { delete: async (req: Request) => (paths.push(new URL(req.url).pathname), true), match: async () => undefined, put: async () => undefined } };
  return { paths, restore: () => (before === undefined ? delete g.caches : (g.caches = before)) };
}

/** A world with three V2 products (price-first one model, price-first option-less, cost-first EUR with air + land) and one V1 engine product. */
async function world(): Promise<World> {
  const w = pricingWorld();
  seedOptionless(w.raw, OL, { routes: ['land'] });
  const draft = {
    inputs: [{ scope: 'base', supplier_cost_amount: '200', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '30' }, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 15_000 }],
  };
  const first = await w.putInputs(V1, { inputs_seq: seqOf(w, V1), ...draft });
  const saved = await w.putInputs(V1, { inputs_seq: seqOf(w, V1), ...draft, preview_hash: first.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  await writeV2(w.db, OL, { method: 'usd', points: [fixed('500')], discounts: [off('25')] });
  await writeV2(w.db, AMS2, {
    method: 'cost',
    inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
    minimumProfitUsd: '120',
    discounts: [off('50')],
  });
  return w;
}

async function run(w: World, trigger: 'fx' | 'shipping' | 'sweep', limit = 600) {
  const trap = trapPurges();
  const budget = statementBudget(limit);
  try {
    const report = await repriceStaleEngineProducts(envOf(w.raw), { trigger, budget });
    assert.ok(budget.used <= limit, 'within the statement budget');
    return { report, paths: trap.paths, used: budget.used };
  } finally {
    trap.restore();
  }
}

const slugOf = (w: World, pid: string) => row<{ s: string }>(w.raw, 'SELECT slug AS s FROM products WHERE id = ?', pid)!.s;

test('U moves past the dead band: every V2 product (both methods) reprices beside V1, price-first follows U, deficit first, engine_fx, purged', async () => {
  const w = await world();
  const status0 = await autoRepriceStatus(w.db);
  assert.equal(status0?.engine_products, 4);
  assert.equal(status0?.stale, 0);
  const history0 = count(w.raw, 'SELECT COUNT(*) AS n FROM price_history');

  applyRate(w.raw, 'USD_IQD', '1632');
  assert.equal((await autoRepriceStatus(w.db))?.stale, 4, 'the V2 products are stale through their results, V1 through its own');
  const { report, paths } = await run(w, 'fx');
  assert.equal(report.skipped, null);
  assert.deepEqual([...report.repriced].sort(), [AMS, AMS2, OL, V1].sort());
  assert.deepEqual([...report.changed].sort(), [AMS, AMS2, OL, V1].sort());
  assert.deepEqual(report.blocked, []);
  // Deficit first among the V2 products: the largest increase first ($1,000 → +32,000; $950 cost-first; $500 → +16,000).
  const v2Order = report.repriced.filter((id) => id !== V1);
  assert.equal(v2Order.at(-1), OL, `the smallest increase last (${v2Order.join(', ')})`);

  // A price-first product follows U: its dollars re-read at 1,632.
  const ams = await cartGrid(w.db, AMS);
  assert.equal(ams[`o:${AMS}_o0@direct_sale`]!.prepaid, 1_632_000);
  assert.equal(ams[`o:${AMS}_o0@pre_order_land`]!.prepaid, ceil1000(950 * 1632));
  assert.equal((await cartGrid(w.db, OL))['@pre_order_land']!.prepaid, ceil1000(475 * 1632));
  // A cost-first product: EUR 450 × 1.1 × U + 8,000 freight + $120 × U, never below the minimum profit.
  const d = ceil1000(450 * 1.1 * 1632 + 8000 + 120 * 1632);
  assert.equal((await cartGrid(w.db, AMS2))[`o:${AMS2}_o0@direct_sale`]!.prepaid, d);
  for (const r of all<{ final_price_iqd: number; replacement_cost_iqd: number; channel: string; usd_iqd_rate: string }>(w.raw, "SELECT final_price_iqd, replacement_cost_iqd, channel, usd_iqd_rate FROM pricing_v2_sku_results WHERE product_id = ? AND channel = 'direct_sale'", AMS2)) {
    assert.equal(r.usd_iqd_rate, '1632');
    assert.ok(r.final_price_iqd - r.replacement_cost_iqd >= 120 * 1632, 'D − R ≥ T × U');
  }

  // History: engine_fx with U, one row per moved SKU × channel of each V2 product.
  const v2Hist = all<{ product_id: string; price_source: string; usd_iqd_rate: string }>(w.raw, 'SELECT product_id, price_source, usd_iqd_rate FROM price_history WHERE product_id IN (?, ?, ?) AND rowid > ?', AMS, OL, AMS2, history0);
  assert.equal(v2Hist.length, 2 + 2 + 3);
  assert.ok(v2Hist.every((h) => h.price_source === 'engine_fx' && h.usd_iqd_rate === '1632'));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE entity = 'sku_price' AND action = 'reprice_auto' AND product_id IN (?, ?, ?)", AMS, OL, AMS2), 3);
  // The purge: exactly the moved products' pages.
  for (const pid of [AMS, AMS2, OL, V1]) assert.ok(paths.includes(`/api/products/${slugOf(w, pid)}`), `${pid} purged`);
  // (Each page is purged on every host the shop answers on: the set of pages is what counts.)
  const productPages = [...new Set(paths.filter((p) => /^\/api\/products\/[^/]+$/.test(p)))];
  assert.deepEqual(productPages.sort(), [AMS, AMS2, OL, V1].map((pid) => `/api/products/${slugOf(w, pid)}`).sort());
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
  // Nothing is left: the next run finds nothing stale.
  assert.equal((await run(w, 'sweep')).report.skipped, 'NOTHING_STALE');
});

test('a tight budget defers in deficit order and a later run finishes; EUR moves only the cost-first EUR product', async () => {
  const w = await world();
  applyRate(w.raw, 'USD_IQD', '1632');
  const tight = await run(w, 'sweep', 120);
  assert.ok(tight.report.deferred.length > 0, `some products wait for a later tick (used ${tight.used})`);
  const rest = await run(w, 'sweep');
  assert.deepEqual([...tight.report.repriced, ...rest.report.repriced].sort(), [AMS, AMS2, OL, V1].sort());

  // EUR/USD 1.1 → 1.12: only the cost-first product with a EUR supplier moves.
  const before = { ams: await cartGrid(w.db, AMS), ol: await cartGrid(w.db, OL) };
  applyRate(w.raw, 'EUR_USD', '1.12');
  const eur = await run(w, 'fx');
  assert.deepEqual(eur.report.repriced, [AMS2]);
  assert.deepEqual(await cartGrid(w.db, AMS), before.ams, 'a price-first product never moves with EUR');
  assert.deepEqual(await cartGrid(w.db, OL), before.ol);
  assert.equal((await cartGrid(w.db, AMS2))[`o:${AMS2}_o0@direct_sale`]!.prepaid, ceil1000(450 * 1.12 * 1632 + 8000 + 120 * 1632));
});

test('a shipping rate reprices the cost-first product whose route uses it (engine_owner); a route cost above D is held, never written silently', async () => {
  const w = await world();
  const history0 = count(w.raw, 'SELECT COUNT(*) AS n FROM price_history');
  // China air 20,000 → 60,000 IQD/kg: R_air = 792,000 + 150,000 = 942,000 > P 912,000 → the air route sells at D.
  w.raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '60000', version = version + 1 WHERE profile = 'CHINA_AIR'`);
  const ship = await run(w, 'shipping');
  assert.deepEqual(ship.report.repriced, [AMS2], 'only the product whose route uses the profile');
  const grid = await cartGrid(w.db, AMS2);
  assert.equal(grid[`o:${AMS2}_o0@pre_order_air`]!.prepaid, 992_000, 'the discount withdrawn on air');
  assert.equal(grid[`o:${AMS2}_o0@pre_order_land`]!.prepaid, 912_000);
  const hist = all<{ variant_key: string; price_source: string }>(w.raw, 'SELECT variant_key, price_source FROM price_history WHERE product_id = ? AND rowid > ?', AMS2, history0);
  assert.deepEqual(hist.map((h) => [h.variant_key, h.price_source]), [[`sku:o:${AMS2}_o0@pre_order_air`, 'engine_owner']]);

  // China air → 200,000 IQD/kg: R_air 1,292,000 > D 992,000. The route would be blocked: the run holds the product instead.
  w.raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '200000', version = version + 1 WHERE profile = 'CHINA_AIR'`);
  const held = await run(w, 'shipping');
  assert.deepEqual(held.report.repriced, []);
  assert.deepEqual(held.report.blocked, [{ product_id: AMS2, code: 'V2_ROUTE_BELOW_COST' }]);
  assert.deepEqual(await cartGrid(w.db, AMS2), grid, 'its prices stay at the last good write');
  assert.equal(row<{ c: string }>(w.raw, 'SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = ?', AMS2)!.c, 'V2_ROUTE_BELOW_COST');
});

test('the owner’s rate-act preview lists the V2 products, and its hash moves with them', async () => {
  const w = await world();
  const move = { kind: 'fx' as const, act: 'manual' as const, pair: 'USD_IQD' as const, owner_version: 1, before: '1600', after: '1632', clears_pending: false };
  const p1 = await previewRateAct(w.db, move, (await loadPricingRates(w.db))!, 600);
  const ids = new Set(p1.preview.rows.map((r) => r.product_id));
  for (const pid of [AMS, AMS2, OL, V1]) assert.ok(ids.has(pid), `${pid} is in the preview`);
  const ams = p1.preview.rows.find((r) => r.product_id === AMS && r.channel === 'direct_sale')!;
  assert.deepEqual([ams.today_prepaid_iqd, ams.computed_price_iqd], [1_600_000, 1_632_000]);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'a preview writes nothing');
  // The V2 product's own data moves the act's hash.
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1100')], discounts: [off('50')] });
  const p2 = await previewRateAct(w.db, move, (await loadPricingRates(w.db))!, 600);
  assert.notEqual(p2.preview.preview_hash, p1.preview.preview_hash);
});
