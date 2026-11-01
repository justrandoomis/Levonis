/**
 * LEAK AUDIT — customer-api: across many estimated products of one type, the
 * PUBLIC supplier list prices, the PUBLIC package boxes, public FX and the
 * published estimates give any anonymous visitor the owner's PRIVATE freight
 * rate and the type's PRIVATE margin (minimum profit plus extra cost), by
 * regression (DECISIONS row 281, "acknowledged, not solved"; owner question
 * 282(e); docs/SMART_PRICING.md §5, §11 "Freight or profit leak").
 *
 * THE PATH. An estimate is priced cost-first from the supplier's own list price
 * (docs/SMART_PRICING.md §4.3), on one route (row 220 (a) does not grow:
 * tests/priceEstimateRouteSpread.test.ts):
 *
 *     D = roundPriceIqd( amount × C × U  +  CBM × S  +  X  +  T × U )
 *
 * `amount` is Bambu's own list price — public on its store; C and U are public
 * FX (the shop publishes U as `displayUsdRate`, DECISIONS row 252); CBM is the
 * product's package box — published on its page (`product.dimensions`), the
 * very measure the estimator prices with (§4.4, measure precedence 2). Only S
 * (the private sea rate per CBM), X (the type's extra cost) and T (the type's
 * minimum profit) are private, and they are SHARED by every product of the
 * type. So D − amount·C·U = CBM·S + (X + T·U) ± one rounding step: a straight
 * line over the products of a type, whose slope is the private freight rate
 * and whose intercept the private per-unit margin. This generalises row
 * 220 (a) across products.
 *
 * The tests drive the REAL chain: the census world's private rates, five
 * filament estimates priced through the real V2 writer exactly as the estimator
 * writes them (a Tmall CNY price, the product's own box on the base row, sea,
 * the type's minimum profit and extra cost), labelled, and an ANONYMOUS visitor
 * through the real Worker (the public API) and the storefront. The literal scan
 * of tests/fixtures/costlyProduct.ts passes (no private figure appears as
 * itself); the visitor's own arithmetic then lands on the private figures.
 *
 * Kept as a `todo` pin, like the route-spread audit: closing it changes what
 * customers pay or see (hide package boxes on estimated products, round
 * estimates more coarsely, or accept), and that is the owner's ruling (282(e),
 * default: accept, with this audit pinned).
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real routes and Worker, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_estimate_supplier_regression.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, ctx, json, row } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { pricingWorld } from './fixtures/procurementPricing';
import { writeV2 } from './fixtures/pricingV2';

type World = ReturnType<typeof pricingWorld>;
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The census world's PRIVATE sea rate (IQD per CBM; tests/fixtures/procurementPricing.ts). */
const PRIVATE_SEA_PER_CBM = 400_000;
/** The type's PRIVATE extra cost (IQD per unit) and minimum profit (USD per unit), as the owner sets them in admin. */
const PRIVATE_EXTRA_IQD = 2_500;
const PRIVATE_MIN_PROFIT_USD = '2.75';
/** Public FX: the shop's own published USD rate and the market's CNY/USD (the census world's figures). */
const PUBLIC_U = 1_600;
const PUBLIC_CNY_USD = 0.14;
/** A derived figure this close to the private one is the private one (one rounding step allows less). */
const REL_TOLERANCE = 0.02;
const STEP = 250;

/** Five filament estimates: Bambu's public list price (CNY) and each product's public package box (mm). */
const CATALOGUE = [
  { id: 'p_reg_1', cny: '69', box: [200, 200, 100] },
  { id: 'p_reg_2', cny: '129', box: [300, 200, 150] },
  { id: 'p_reg_3', cny: '159', box: [400, 300, 200] },
  { id: 'p_reg_4', cny: '239', box: [400, 400, 300] },
  { id: 'p_reg_5', cny: '349', box: [600, 400, 300] },
] as const;

function seedEstimate(raw: DatabaseSync, p: (typeof CATALOGUE)[number]): void {
  // As the apply leaves it: pre-order only on the type's one route, the box published as the product's package.
  raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                           package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
     VALUES (?, ?, ?, 'خيط', 'فیلامێنت', 'active', 0, NULL, 'pre_order', '["pre_order"]', ?, 'BASE', 1000, ?, ?, ?)`
  ).run(p.id, `slug-${p.id}`, `Filament ${p.id}`, JSON.stringify([{ method: 'sea', commission_iqd: 0, active: true }]), p.box[0], p.box[1], p.box[2]);
}

async function world(): Promise<World> {
  const w = pricingWorld();
  for (const p of CATALOGUE) {
    seedEstimate(w.raw, p);
    // The estimator's wire (§4.4): the supplier price, the product's own box on the base row, sea, the type's extra and profit.
    await writeV2(w.db, p.id, {
      method: 'cost',
      inputs: {
        supplier_cost_amount: p.cny,
        supplier_cost_currency: 'CNY',
        shipping_profile: 'CHINA_SEA',
        shipping_weight_g: 1_000,
        shipping_length_mm: p.box[0],
        shipping_width_mm: p.box[1],
        shipping_height_mm: p.box[2],
        additional_cost_iqd: PRIVATE_EXTRA_IQD,
      },
      minimumProfitUsd: PRIVATE_MIN_PROFIT_USD,
    });
    w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${p.id}', 1);
      UPDATE products SET price_estimate = 1 WHERE id = '${p.id}';
      DELETE FROM ops_guards WHERE id = 'engine-price:${p.id}';`);
  }
  return w;
}

/** An anonymous agent through the real Worker. */
function anonymous(w: World) {
  const env = { DB: w.db, STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  return async (path: string): Promise<Rec> => {
    const res = await worker.fetch(new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.74' } }), env as never, ctx);
    const body = await json(res);
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
}

/** What the visitor holds per product: the public supplier price in dinars, the public CBM and the published price. */
interface Observation {
  id: string;
  supplier_iqd: number;
  cbm: number;
  price: number;
  body: unknown;
}

async function observe(w: World): Promise<Observation[]> {
  const fetchAnon = anonymous(w);
  const out: Observation[] = [];
  for (const p of CATALOGUE) {
    const body = await fetchAnon(`/api/public/v1/products/slug-${p.id}`);
    const data = body.data as Rec;
    assert.equal(data.price.estimate, true, `${p.id} is published as an estimate`);
    const dims = data.dimensions as Rec;
    const route = (data.purchase.pre_order as Rec[]).find((r) => r.method === 'sea')!;
    out.push({
      id: p.id,
      supplier_iqd: Number(p.cny) * PUBLIC_CNY_USD * PUBLIC_U,
      cbm: (dims.package_depth_mm * dims.package_width_mm * dims.package_height_mm) / 1e9,
      price: route.prepaid,
      body,
    });
  }
  return out;
}

/** Least squares of (price − supplier) on CBM: slope = freight per CBM, intercept = the per-unit margin. */
function fit(obs: readonly Observation[]): { slope: number; intercept: number } {
  const xs = obs.map((o) => o.cbm);
  const ys = obs.map((o) => o.price - o.supplier_iqd);
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

test('the path is real: each estimate is the public supplier price plus the private freight, extra and profit, rounded', async () => {
  const w = await world();
  const margin = PRIVATE_EXTRA_IQD + Number(PRIVATE_MIN_PROFIT_USD) * PUBLIC_U;
  for (const o of await observe(w)) {
    const exact = o.supplier_iqd + o.cbm * PRIVATE_SEA_PER_CBM + margin;
    assert.ok(o.price >= exact && o.price - exact < STEP, `${o.id}: ${o.price} is ${exact} rounded up to the next ${STEP}`);
    // The private figures never appear as themselves: the literal scan passes.
    const privateNumbers = [PRIVATE_SEA_PER_CBM, PRIVATE_EXTRA_IQD, Math.round(o.cbm * PRIVATE_SEA_PER_CBM)];
    assert.deepEqual(leaks(o.body, { numbers: privateNumbers, decimals: [PRIVATE_MIN_PROFIT_USD] }), [], `${o.id}: the literal scan passes`);
  }
  // The package box the visitor reads is the box the estimate was priced on.
  const stored = row<{ l: number; w: number; h: number }>(w.raw, "SELECT shipping_length_mm AS l, shipping_width_mm AS w, shipping_height_mm AS h FROM pricing_inputs WHERE product_id = 'p_reg_5' AND scope = 'base'");
  assert.deepEqual(stored && [stored.l, stored.w, stored.h], [...CATALOGUE[4].box]);
});

const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 281, question 282(e)): estimates of one type share the private sea rate, extra cost and minimum profit, and the supplier list price, the package box and FX are public — so a straight line through a few estimated products IS the private freight rate and margin. Closing it means hiding package boxes on estimated products, rounding estimates more coarsely, or accepting it (the default); prices are the owner’s to change';

test('anonymous GET /api/public/v1/products/:slug over one type’s estimates must not give the private freight rate or margin', { todo: OWNER_RULING }, async () => {
  const w = await world();
  const obs = await observe(w);
  const { slope, intercept } = fit(obs);
  const margin = PRIVATE_EXTRA_IQD + Number(PRIVATE_MIN_PROFIT_USD) * PUBLIC_U;
  const found: string[] = [];
  if (Math.abs(slope - PRIVATE_SEA_PER_CBM) <= REL_TOLERANCE * PRIVATE_SEA_PER_CBM)
    found.push(`fitted sea freight ${Math.round(slope)} IQD/CBM vs the owner's private CHINA_SEA ${PRIVATE_SEA_PER_CBM} — from ${obs.length} estimates' public supplier prices, boxes and published prices`);
  if (Math.abs(intercept - margin) <= STEP)
    found.push(`fitted per-unit margin ${Math.round(intercept)} IQD vs the type's private extra cost + minimum profit ${margin} (within one rounding step)`);
  for (const o of obs) {
    const freight = o.cbm * slope;
    if (Math.abs(freight - o.cbm * PRIVATE_SEA_PER_CBM) <= Math.max(STEP, REL_TOLERANCE * o.cbm * PRIVATE_SEA_PER_CBM))
      found.push(`${o.id}: derived freight ${Math.round(freight)} vs private ${Math.round(o.cbm * PRIVATE_SEA_PER_CBM)}`);
  }
  assert.deepEqual(found, [], `LEAK: an anonymous visitor derives the owner's PRIVATE freight rate and margin from estimated prices:\n  ${found.join('\n  ')}`);
});
