/**
 * LEAK AUDIT — customer-api: the per-route pre-order prices hand any anonymous
 * visitor the owner's PRIVATE central freight rates (`pricing_shipping_rates`:
 * CHINA_AIR and GERMANY_LAND per kg, CHINA_SEA per CBM) and each SKU's private
 * per-route freight cost.
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY
 * the final price — no cost and no step of how a price was computed. Freight
 * is such a cost: `shipping_rate`, `shipping_cost_iqd`, `effective_weight_g`
 * and `effective_cbm` are FINANCIAL_FIELDS (worker/lib/adminScope.ts), kept in
 * `pricing_sku_costs` for the owner alone.
 *
 * THE PATH. The engine (packages/pricing/src/costToPrice.ts priceSku) prices
 * every pre-order route of a SKU on its own shipping profile
 * (skuChannel.ts ROUTE_PROFILE: air → CHINA_AIR, sea → CHINA_SEA,
 * land → GERMANY_LAND), with the SAME supplier cost, additional cost and
 * minimum profit on every route:
 *
 *     price(route) = ceil_1000( supplier + freight(route) + additional + minimum profit )
 *     freight(air)  = CHINA_AIR    × weight_kg
 *     freight(land) = GERMANY_LAND × weight_kg
 *     freight(sea)  = CHINA_SEA    × L×W×H (CBM)
 *
 * The writer stores each route row's own price with a zero route fee
 * (DECISIONS row 196), and the storefront publishes every route's final price
 * per selection — `pricing_modes.preorder[].prepaid.unit_subtotal_iqd` on
 * GET /api/products/:slug and POST /api/products/:slug/quote
 * (worker/routes/products.ts pricingModes), and `purchase.pre_order[].prepaid`
 * on GET /api/public/v1/products/:slug — next to the product's package weight
 * and box (`product.dimensions`), which are the very measures the owner's form
 * adopts as the engine's shipping weight and box
 * (src/components/adminProducts/form/UsdPricingSection.tsx measureDraftOf).
 * So, for every product, whatever its private supplier cost or profit:
 *
 *     price(air) − price(land) = (CHINA_AIR − GERMANY_LAND) × weight_kg   ± 1,000
 *     price(air) − price(sea)  =  CHINA_AIR × weight_kg − CHINA_SEA × CBM  ± 1,000
 *
 * and a least-squares fit over a few products gives the three private rates
 * themselves, and then each SKU's private per-route freight cost.
 *
 * The tests drive the REAL chain, locally: the census catalogue
 * (tests/fixtures/legacyCatalogue.ts) with the owner's distinctive private
 * freight rates, three products offering air, sea and land, the owner's
 * real completing save through PUT /api/admin/pricing/products/:id/inputs
 * (409 preview, then the save with its hash — the engine writer), and an
 * ANONYMOUS visitor through the real Worker (worker/index.ts fetch). They
 * assert that what the visitor holds does NOT give the private rates or the
 * private per-route freight. Today it does.
 *
 * The existing guards (costRoleMatrix, costLeaksPhase0, securityPricingLeak,
 * liveCostProbes, the leak scanner of tests/fixtures/costlyProduct.ts) look
 * for private values literally (a sentinel number, a FINANCIAL_FIELDS key);
 * none of them flags a private value DERIVED from published final prices —
 * the first assertion on each surface shows the scanner passing.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real route modules
 * and Worker, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_route_price_spread_reveals_freight.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, all, asD1, ctx, row } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { leaks } from './fixtures/costlyProduct';
import worker from '../worker/index';

type World = ReturnType<typeof pricingWorld>;
type Route = 'air' | 'sea' | 'land';

/** The owner's PRIVATE central freight rates (IQD per kg, per kg, per CBM) — figures no public number here equals. */
const PRIVATE_RATES = { CHINA_AIR: 17_350, GERMANY_LAND: 4_150, CHINA_SEA: 387_500 } as const;
const PROFILE_OF: Readonly<Record<Route, keyof typeof PRIVATE_RATES>> = { air: 'CHINA_AIR', land: 'GERMANY_LAND', sea: 'CHINA_SEA' };
const STEP = 1_000;
/** A derived rate this close to the private one is the private rate (the rounding alone allows ~0.5%). */
const REL_TOLERANCE = 0.01;

/**
 * Three census products, each one model sold direct and by pre-order, each
 * given air, sea and land. Their supplier costs (three currencies), minimum
 * profits, extras and additional costs all differ and stay private; their
 * package weight and box are the public package specs the form adopts.
 */
const CATALOGUE = [
  { slug: 'bambu-lab-ams-2-pro', weight_g: 12_400, box: [600, 500, 400], supplier: ['300', 'USD'], target_usd: '40', extra: 25_000, additional: null },
  { slug: 'bambu-lab-ams-ht', weight_g: 4_800, box: [800, 600, 700], supplier: ['410', 'EUR'], target_usd: '55', extra: 30_000, additional: 7_500 },
  { slug: 'bambu-lab-ams-lite', weight_g: 21_000, box: [500, 450, 350], supplier: ['2600', 'CNY'], target_usd: '25', extra: 15_000, additional: null },
] as const;

const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

/** The owner's completing save through the product form: 409 with the preview, then the save with its hash. */
async function ownerAdopts(w: World, pid: string, draft: Record<string, unknown>) {
  const first = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body).slice(0, 400));
  assert.equal(first.body.code, 'PRICING_PREVIEW_REQUIRED');
  const hash = first.body.details?.preview?.preview_hash;
  assert.equal(typeof hash, 'string');
  const saved = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft, preview_hash: hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 400));
  assert.equal(saved.body.mode, 'engine', `${pid} is engine-priced`);
}

/** The census world: the owner's private freight rates, three products on all three routes, engine-priced by the owner. */
async function world() {
  const w = pricingWorld();
  for (const [profile, rate] of Object.entries(PRIVATE_RATES)) {
    w.raw.prepare('UPDATE pricing_shipping_rates SET rate_iqd = ?, version = version + 1 WHERE profile = ?').run(String(rate), profile);
  }
  for (const p of CATALOGUE) {
    const pid = legacyProductId(p.slug);
    // The catalogue: the model's pre-order cell offers air, sea and land; the package specs are the product's.
    w.raw.prepare('UPDATE product_option_transports SET enabled = 1 WHERE product_id = ? AND fulfillment_id = ?').run(pid, `${pid}_o0_p`);
    w.raw.prepare('UPDATE product_option_values SET package_weight_g = NULL WHERE product_id = ?').run(pid);
    w.raw
      .prepare('UPDATE products SET package_weight_g = ?, package_depth_mm = ?, package_width_mm = ?, package_height_mm = ? WHERE id = ?')
      .run(p.weight_g, p.box[0], p.box[1], p.box[2], pid);
    // The owner's save, as «تعديل منتج» sends it: the private supplier cost, profit and extra, and the
    // package measures adopted for pricing (measureDraftOf).
    await ownerAdopts(w, pid, {
      inputs: [
        {
          scope: 'base',
          supplier_cost_amount: p.supplier[0],
          supplier_cost_currency: p.supplier[1],
          shipping_profile: 'CHINA_AIR',
          shipping_weight_g: p.weight_g,
          shipping_length_mm: p.box[0],
          shipping_width_mm: p.box[1],
          shipping_height_mm: p.box[2],
          ...(p.additional !== null ? { additional_cost_iqd: p.additional } : {}),
        },
      ],
      rules: [
        { kind: 'target_profit', scope: 'product', amount_usd: p.target_usd },
        { kind: 'direct_sale_extra', scope: 'product', amount_iqd: p.extra },
      ],
    });
  }
  return w;
}

/** The owner-only freight of each SKU × route, as the engine stored it (ground truth; never read by the visitor). */
function privateFreight(w: World, pid: string): Record<Route, { rate: string; cost: number; weight_g: number | null; cbm: string | null }> {
  const rows = all<{ channel: string; shipping_rate: string; shipping_cost_iqd: number; effective_weight_g: number | null; effective_cbm: string | null }>(
    w.raw,
    "SELECT channel, shipping_rate, shipping_cost_iqd, effective_weight_g, effective_cbm FROM pricing_sku_costs WHERE product_id = ? AND channel LIKE 'pre_order_%'",
    pid
  );
  const out = {} as Record<Route, { rate: string; cost: number; weight_g: number | null; cbm: string | null }>;
  for (const r of rows) out[r.channel.replace('pre_order_', '') as Route] = { rate: r.shipping_rate, cost: r.shipping_cost_iqd, weight_g: r.effective_weight_g, cbm: r.effective_cbm };
  return out;
}

// ---------------------------------------------------------------- the anonymous visitor, through the real Worker

function anonymousFetch(w: World) {
  const env = {
    DB: asD1(w.raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  return async (path: string, body?: unknown) => {
    const res = await worker.fetch(
      new Request(`https://${APEX}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.9', ...(body === undefined ? {} : { 'content-type': 'application/json', Origin: `https://${APEX}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env as never,
      ctx
    );
    const text = await res.text();
    assert.equal(res.status, 200, `anonymous ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
}

/** The first object at any depth holding `key`. */
function findKey(v: unknown, key: string): Record<string, unknown> | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const f = findKey(x, key);
      if (f) return f;
    }
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (key in o) return o;
    for (const x of Object.values(o)) {
      const f = findKey(x, key);
      if (f) return f;
    }
  }
  return null;
}

/** What the visitor reads off one public answer: the package measures and each route's final (prepaid) price. */
interface Observation {
  weight_kg: number;
  cbm: number;
  price: Record<Route, number>;
}

function observe(body: unknown, surface: 'storefront' | 'v1'): Observation {
  const dims = findKey(body, 'package_weight_g') as Record<string, number>;
  assert.ok(dims, 'the answer publishes the package measures');
  const price = {} as Record<Route, number>;
  if (surface === 'storefront') {
    const modes = findKey(body, 'preorder') as { preorder: Array<{ method: Route; prepaid: { unit_subtotal_iqd: number } | null }> };
    for (const m of modes.preorder) if (m.prepaid) price[m.method] = m.prepaid.unit_subtotal_iqd;
  } else {
    const purchase = findKey(body, 'pre_order') as { pre_order: Array<{ method: Route; prepaid: number | null }> };
    for (const m of purchase.pre_order) if (typeof m.prepaid === 'number') price[m.method] = m.prepaid;
  }
  for (const r of ['air', 'sea', 'land'] as const) assert.equal(typeof price[r], 'number', `the answer publishes the ${r} pre-order price`);
  return {
    weight_kg: dims.package_weight_g! / 1000,
    cbm: (dims.package_depth_mm! * dims.package_width_mm! * dims.package_height_mm!) / 1e9,
    price,
  };
}

/**
 * THE VISITOR'S ARITHMETIC — public numbers only. Per product the unknown
 * supplier cost, extra cost and profit cancel in the route spreads:
 *   air − land = w·A − w·L          air − sea = w·A − c·S
 * Least squares over the products gives A (air /kg), L (land /kg), S (sea /CBM).
 */
function fitRates(obs: readonly Observation[]): { CHINA_AIR: number; GERMANY_LAND: number; CHINA_SEA: number } {
  const rows: Array<[number[], number]> = [];
  for (const o of obs) {
    rows.push([[o.weight_kg, -o.weight_kg, 0], o.price.air - o.price.land]);
    rows.push([[o.weight_kg, 0, -o.cbm], o.price.air - o.price.sea]);
  }
  // Normal equations (AᵀA)x = Aᵀb, solved by Gaussian elimination.
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, [a]) => s + a[i]! * a[j]!, 0)));
  const v = [0, 1, 2].map((i) => rows.reduce((s, [a, b]) => s + a[i]! * b, 0));
  for (let k = 0; k < 3; k += 1) {
    for (let i = k + 1; i < 3; i += 1) {
      const f = M[i]![k]! / M[k]![k]!;
      for (let j = k; j < 3; j += 1) M[i]![j]! -= f * M[k]![j]!;
      v[i]! -= f * v[k]!;
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i -= 1) x[i] = (v[i]! - [0, 1, 2].slice(i + 1).reduce((s, j) => s + M[i]![j]! * x[j]!, 0)) / M[i]![i]!;
  return { CHINA_AIR: x[0]!, GERMANY_LAND: x[1]!, CHINA_SEA: x[2]! };
}

const close = (derived: number, actual: number) => Math.abs(derived - actual) <= REL_TOLERANCE * actual;
const pct = (derived: number, actual: number) => `${((100 * (derived - actual)) / actual).toFixed(2)}%`;

/** Every private freight figure of the world, for the literal scan. */
function privateNumbers(w: World): number[] {
  const out: number[] = [...Object.values(PRIVATE_RATES)];
  for (const p of CATALOGUE) for (const f of Object.values(privateFreight(w, legacyProductId(p.slug)))) out.push(f.cost);
  return out;
}

/**
 * The checks every surface gets. The literal scan is blind (asserted: it
 * passes); then every way the visitor's own arithmetic lands on a private
 * figure is returned as a finding — the fitted central rates first, then each
 * SKU's per-route freight cost, then each per-SKU freight differential.
 */
function freightFindings(w: World, surface: string, answers: ReadonlyArray<{ path: string; body: unknown; obs: Observation; pid: string }>): string[] {
  const secret = privateNumbers(w);
  for (const a of answers) {
    // The existing scanner sees nothing: no private rate, freight cost or FINANCIAL_FIELDS key appears literally.
    assert.deepEqual(leaks(a.body, { numbers: secret, decimals: Object.values(PRIVATE_RATES).map(String) }), [], `${a.path}: the literal scan passes`);
  }
  const found: string[] = [];

  // (1) Fitted across the products against the public package measures: the private central rates themselves.
  const fit = fitRates(answers.map((a) => a.obs));
  for (const k of Object.keys(PRIVATE_RATES) as Array<keyof typeof PRIVATE_RATES>) {
    if (close(fit[k], PRIVATE_RATES[k]))
      found.push(
        `${surface}: fitted ${k} = ${Math.round(fit[k])} IQD/${k === 'CHINA_SEA' ? 'CBM' : 'kg'} vs the owner's private pricing_shipping_rates ${PRIVATE_RATES[k]} (${pct(fit[k], PRIVATE_RATES[k])}) — from ${answers.length} products' route prices and package measures`
      );
  }

  // (2) …and with them each SKU's private per-route freight cost (`pricing_sku_costs.shipping_cost_iqd`).
  for (const a of answers) {
    const f = privateFreight(w, a.pid);
    for (const r of ['air', 'sea', 'land'] as const) {
      const derived = r === 'sea' ? fit.CHINA_SEA * a.obs.cbm : fit[PROFILE_OF[r]] * a.obs.weight_kg;
      if (close(derived, f[r].cost))
        found.push(`${a.path}: derived ${r} freight ${Math.round(derived)} vs private shipping_cost_iqd ${f[r].cost} (${pct(derived, f[r].cost)})`);
    }
  }

  // (3) The per-SKU freight differential between two routes is the spread of two published final prices.
  for (const a of answers) {
    const f = privateFreight(w, a.pid);
    for (const [r1, r2] of [['air', 'land'], ['air', 'sea'], ['sea', 'land']] as const) {
      const spread = a.obs.price[r1] - a.obs.price[r2];
      const privateDiff = f[r1].cost - f[r2].cost;
      if (Math.abs(spread - privateDiff) < STEP)
        found.push(`${a.path}: price(${r1}) − price(${r2}) = ${spread} vs private freight(${r1}) − freight(${r2}) = ${privateDiff} (within one rounding step)`);
    }
  }
  return found;
}

// ---------------------------------------------------------------- the tests

/**
 * Kept, failing, as `todo`: the arithmetic below is real and stays proven on
 * every run, but closing it changes what customers pay — the owner decides.
 */
const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 219): every pre-order route is priced on the same supplier cost, extra cost and profit, so the spread of two published route prices IS the private freight difference — no change short of a different price (or one shared price for all routes, or hiding a route) closes it, and prices are the owner\'s to change';

test('the path is real: the engine prices each route on its own private freight rate and the public package measures', async () => {
  const w = await world();
  for (const p of CATALOGUE) {
    const pid = legacyProductId(p.slug);
    const f = privateFreight(w, pid);
    for (const r of ['air', 'sea', 'land'] as const) {
      assert.equal(Number(f[r].rate), PRIVATE_RATES[PROFILE_OF[r]], `${pid} ${r} is priced on the private ${PROFILE_OF[r]} rate`);
      if (r === 'sea') assert.equal(Number(f[r].cbm), (p.box[0] * p.box[1] * p.box[2]) / 1e9, `${pid} sea is priced on the package box`);
      else assert.equal(f[r].weight_g, p.weight_g, `${pid} ${r} is priced on the package weight`);
    }
    // Each route row carries its own engine price with a zero route fee (DECISIONS row 196).
    const routes = all<{ method: string; surcharge_iqd: number; regular_price_iqd: number }>(
      w.raw,
      'SELECT method, surcharge_iqd, regular_price_iqd FROM product_option_transports WHERE product_id = ? AND enabled = 1',
      pid
    );
    assert.equal(routes.length, 3);
    for (const t of routes) assert.equal(t.surcharge_iqd, 0, `${pid} ${t.method}: route fee zero`);
  }
});

test('anonymous GET /api/products/:slug and POST /api/products/:slug/quote: route spreads must not give the private freight rates or freight costs', { todo: OWNER_RULING }, async () => {
  const w = await world();
  const fetchAnon = anonymousFetch(w);
  const detail: Array<{ path: string; body: unknown; obs: Observation; pid: string }> = [];
  const quote: Array<{ path: string; body: unknown; obs: Observation; pid: string }> = [];
  for (const p of CATALOGUE) {
    const pid = legacyProductId(p.slug);
    const path = `/api/products/${p.slug}`;
    const body = await fetchAnon(path);
    detail.push({ path: `GET ${path}`, body, obs: observe(body, 'storefront'), pid });
    const qPath = `/api/products/${p.slug}/quote`;
    const qBody = await fetchAnon(qPath, { optionId: `${pid}_o0`, qty: 1 });
    // The visitor reads the package measures off the product page and the route prices off the quote.
    const qObs = observe({ quote: qBody, dims: findKey(body, 'package_weight_g') }, 'storefront');
    quote.push({ path: `POST ${qPath}`, body: qBody, obs: qObs, pid });
  }
  const found = [
    ...freightFindings(w, 'GET /api/products/:slug pricing_modes.preorder[].prepaid', detail),
    ...freightFindings(w, 'POST /api/products/:slug/quote pricing_modes.preorder[].prepaid', quote),
  ];
  assert.deepEqual(found, [], `LEAK: an anonymous visitor derives the owner's PRIVATE freight from the storefront's per-route final prices:\n  ${found.join('\n  ')}`);
});

test('anonymous GET /api/public/v1/products/:slug: purchase.pre_order spreads must not give the private freight rates or freight costs', { todo: OWNER_RULING }, async () => {
  const w = await world();
  const fetchAnon = anonymousFetch(w);
  const answers: Array<{ path: string; body: unknown; obs: Observation; pid: string }> = [];
  for (const p of CATALOGUE) {
    const path = `/api/public/v1/products/${p.slug}`;
    const body = await fetchAnon(path);
    answers.push({ path: `GET ${path}`, body, obs: observe(body, 'v1'), pid: legacyProductId(p.slug) });
  }
  const found = freightFindings(w, 'GET /api/public/v1/products/:slug purchase.pre_order[].prepaid', answers);
  assert.deepEqual(found, [], `LEAK: an anonymous visitor derives the owner's PRIVATE freight from the public API's per-route final prices:\n  ${found.join('\n  ')}`);
});
