/**
 * E1 WITH A MINIMUM PROFIT IN USD (owner brief 2026-10-09; USD design §2.1,
 * §2.2, §2.4, §2.5, §12 "P-B").
 *
 *     Supplier cost USD/EUR/CNY → USD → + (shipping + additional) ÷ U
 *       = Current Total Cost USD (K);  K + Minimum Target Profit USD (T) = F;
 *     F × U → rounded UP to the next 1,000 → the stored IQD price;
 *     direct sale: + Direct Sale Extra (whole dinars on the step) AFTER rounding.
 *
 * E1 computes it exactly: ceil_1000(F × U) = ceil_1000(R_exact + T × U), and
 * the USD figures are display-only (rounded up at 6 decimals). Proven here:
 *   - the brief's example: €450 × 1.1 + 2.5 kg × 3,200 ÷ 1,600 = $500, + $120
 *     = $620, × 1,600 = 992,000 IQD;
 *   - CNY with C at 10 decimals, a USD supplier, a fractional T × U;
 *   - a property test against an independent BigInt oracle, whose every row
 *     the 0181 storage backstops (pricing_sku_costs CHECKs) accept;
 *   - FX_RATE_MISSING {USD} on an EUR product with a USD minimum, an
 *     unconfirmed U, a mixed tie priced at another rate;
 *   - a migrated dinar minimum prices exactly as before.
 *
 * Run: node --import tsx --test tests/pricingCostToPriceUsd.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUNDING_STEP_IQD,
  preorderPrice,
  priceSku,
  type CentralRates,
  type ChannelPrice,
  type SkuInputChain,
  type SkuPricingResult,
  type SupplierCurrency,
} from '../packages/pricing/src/costToPrice';
import type { RuleResolution } from '../packages/pricing/src/ruleResolution';
import { composeIqdRates, currentUsdCost } from '../packages/pricing/src/fxChain';
import type { SkuChannel } from '../packages/pricing/src/skuChannel';
import { freshDb } from './fixtures/app';

const rate = (r: string | null, confirmed = true, version = 1) => ({ rate: r, version, confirmed });

/** Rates as FX-1 derives them: USD = U, EUR = E × U, CNY = C × U. */
function chainRates(U: string, E: string, C: string, shipping: Partial<Record<'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA', string>>): CentralRates {
  const fx = composeIqdRates(U, E, C);
  return {
    fx: { USD: rate(fx.USD), EUR: rate(fx.EUR), CNY: rate(fx.CNY) },
    shipping: Object.fromEntries(Object.entries(shipping).map(([k, v]) => [k, rate(v!)])),
  };
}

const ref = (id: string) => ({ id, version: 1, scope: 'product' as const, scope_id: '', catalog_id: null });
const usdTarget = (amount: string, extra: Partial<Extract<RuleResolution, { status: 'active' }>> = {}): RuleResolution => ({
  status: 'active', kind: 'target_profit', amount_iqd: null, amount_usd: amount, rule: ref('rule_t'), tie: false, candidates: [ref('rule_t')], ...extra,
});
const iqdTarget = (amount: number): RuleResolution => ({
  status: 'active', kind: 'target_profit', amount_iqd: amount, rule: ref('rule_t'), tie: false, candidates: [ref('rule_t')],
});
const extraOf = (amount: number): RuleResolution => ({
  status: 'active', kind: 'direct_sale_extra', amount_iqd: amount, rule: ref('rule_x'), tie: false, candidates: [ref('rule_x')],
});

const channel = (r: SkuPricingResult, c: SkuChannel): ChannelPrice => {
  const found = r.channels.find((x) => x.channel === c);
  assert.ok(found, `channel ${c} priced (issues: ${JSON.stringify(r.issues)})`);
  return found;
};
const codes = (r: SkuPricingResult, c?: SkuChannel) => [...new Set(r.issues.filter((i) => !c || i.channel === c).map((i) => i.code))].sort();

/* ---------------------------------------------------------- the example -- */

test('the brief: €450 × 1.1 = $495; 2.5 kg × 3,200 = 8,000 IQD = $5; K = $500; + $120 = $620; × 1,600 = 992,000 IQD', () => {
  const rates = chainRates('1600', '1.1', '0.14', { GERMANY_LAND: '3200' });
  const chain: SkuInputChain = { base: { override: { supplier_cost: '450', supplier_currency: 'EUR', shipping_weight_g: 2500, shipping_profile: 'GERMANY_LAND' } } };
  const r = priceSku({ chain, rates, channels: ['pre_order_land', 'direct_sale'], target: usdTarget('120'), extra: extraOf(50_000) });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  const land = channel(r, 'pre_order_land');
  assert.equal(land.computed_price_iqd, 992_000);
  assert.equal(land.supplier_cost_usd, '495');
  assert.equal(land.shipping_cost_iqd, 8_000);
  assert.equal(land.shipping_cost_usd, '5');
  assert.equal(land.additional_cost_usd, '0');
  assert.equal(land.current_total_cost_usd, '500');
  assert.equal(land.target_profit_usd, '120');
  assert.equal(land.final_price_usd, '620');
  assert.equal(land.usd_iqd_rate, '1600');
  assert.equal(land.target_profit_iqd_exact, '192000');
  assert.equal(land.target_profit_iqd, 192_000);
  assert.equal(land.rounding_added_iqd, 0);
  // Direct sale: the extra after rounding, never inside F, never in USD.
  const direct = channel(r, 'direct_sale');
  assert.equal(direct.preorder_base_iqd, 992_000);
  assert.equal(direct.computed_price_iqd, 1_042_000);
  assert.equal(direct.direct_sale_extra_iqd, 50_000);
  assert.equal(direct.final_price_usd, '620', 'F excludes the Direct Sale Extra');
});

test('CNY with C at 10 decimals, a USD supplier, and a fractional T × U ($120.55 × 1,660.5 = 200,173.275)', () => {
  const rates = chainRates('1660.5', '1.0875', '0.1404562891', { CHINA_AIR: '12500', CHINA_SEA: '450000' });
  const cny = priceSku({
    chain: { base: { override: { supplier_cost: '3200', supplier_currency: 'CNY', shipping_weight_g: 4300, manual_cbm: '0.05' } } },
    rates, channels: ['pre_order_air', 'pre_order_sea'], target: usdTarget('120.55'),
  });
  assert.equal(cny.ok, true, JSON.stringify(cny.issues));
  // R_exact = 3200 × (0.1404562891 × 1660.5) + 4.3 × 12500 = 746,328.53776176 + 53,750 = 800,078.53776176
  const air = channel(cny, 'pre_order_air');
  assert.equal(air.fx_rate, '233.22766805055', 'C × U, exact');
  assert.equal(air.replacement_exact, '800078.53776176');
  assert.equal(air.target_profit_iqd_exact, '200173.275');
  assert.equal(air.target_profit_iqd, 200_173);
  assert.equal(air.computed_price_iqd, 1_001_000, 'ceil_1000(800,078.538 + 200,173.275) = 1,001,000');
  assert.equal(air.rounding_added_iqd, 1_001_000 - 1_000_252, 'pre − ceil(R_exact + T×U)');
  const sea = channel(cny, 'pre_order_sea');
  assert.equal(sea.computed_price_iqd, 970_000, 'ceil_1000(746,328.54 + 22,500 + 200,173.275) = 970,000');

  const usd = priceSku({
    chain: { base: { override: { supplier_cost: '199.99', supplier_currency: 'USD', shipping_weight_g: 1000 } } },
    rates, channels: ['pre_order_air'], target: usdTarget('35.5'),
  });
  const u = channel(usd, 'pre_order_air');
  // 199.99 × 1660.5 + 12,500 = 344,583.395; + 35.5 × 1660.5 = 58,947.75 → 403,531.145 → 404,000
  assert.equal(u.computed_price_iqd, 404_000);
  assert.equal(u.supplier_cost_usd, '199.99');
  assert.equal(u.current_total_cost_usd, '207.517854', 'ceil6(344,583.395 ÷ 1,660.5)');
  assert.equal(u.final_price_usd, '243.017854');
});

/* -------------------------------------------------------- the property -- */

/** An independent oracle: plain BigInt rationals, no contracts helpers. */
type Q = readonly [bigint, bigint];
const q = (text: string): Q => {
  const [i, f = ''] = text.split('.');
  return [BigInt(`${i}${f}`), 10n ** BigInt(f.length)];
};
const qAdd = (a: Q, b: Q): Q => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const qMul = (a: Q, b: Q): Q => [a[0] * b[0], a[1] * b[1]];
const qCeil = (a: Q): bigint => (a[0] % a[1] === 0n ? a[0] / a[1] : a[0] / a[1] + 1n);
const qFloor = (a: Q): bigint => a[0] / a[1];
const qGe = (a: Q, b: Q) => a[0] * b[1] >= b[0] * a[1];

let seed = 20261009;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const dec = (lo: number, hi: number, places: number) => {
  const whole = int(lo, hi);
  if (!places) return String(whole);
  const frac = String(int(0, 10 ** places - 1)).padStart(places, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

/** The 0181 row the writer would store for a channel price (the columns the CHECKs read). */
function skuCostRow(product: string, combo: string, c: ChannelPrice, currency: SupplierCurrency, E: string, C: string) {
  const cross = currency === 'USD' ? null : currency === 'EUR' ? E : C;
  return {
    product_id: product, combo_key: combo, channel: c.channel, shipping_profile: c.shipping_profile, supplier_amount: c.supplier_amount,
    supplier_currency: c.supplier_currency, supplier_input_mode: 'SOURCE_CURRENCY',
    current_supplier_cost_usd_exact: currentUsdCost({ amount: c.supplier_amount, currency }, E, C)!,
    usd_iqd_rate: c.usd_iqd_rate!, usd_fx_version: 1, cross_rate: cross, cross_fx_version: cross ? 1 : null, fx_rate: c.fx_rate, fx_version: c.fx_version,
    supplier_cost_iqd: c.supplier_cost_iqd, shipping_basis: c.shipping_basis, shipping_rate: c.shipping_rate, shipping_version: c.shipping_version,
    effective_weight_g: c.effective_weight_g, shipping_cbm: c.shipping_cbm, manual_cbm: c.manual_cbm, effective_cbm: c.effective_cbm,
    shipping_cost_iqd: c.shipping_cost_iqd, additional_cost_iqd: c.additional_cost_iqd, replacement_exact: c.replacement_exact,
    replacement_cost_iqd: c.replacement_cost_iqd, target_profit_iqd: c.target_profit_iqd, target_profit_usd: c.target_profit_usd,
    target_profit_iqd_exact: c.target_profit_iqd_exact, shipping_cost_usd: c.shipping_cost_usd!, additional_cost_usd: c.additional_cost_usd!,
    current_total_cost_usd: c.current_total_cost_usd!, final_price_usd: c.final_price_usd!, target_rule_id: c.target_rule_id,
    target_rule_version: c.target_rule_version, direct_sale_extra_iqd: c.direct_sale_extra_iqd, extra_rule_id: c.extra_rule_id,
    extra_rule_version: c.extra_rule_version, config_version: 0, rounding_step_iqd: c.rounding_step_iqd, preorder_base_iqd: c.preorder_base_iqd,
    computed_price_iqd: c.computed_price_iqd, computed_at: '2026-10-09T12:00:00.000Z',
  };
}

test('property (4,000 SKUs): price = ceil_1000(R_exact + T×U); price − X − R_exact ≥ T×U; rounding ∈ [0, 1000); direct = pre + X; every row passes the 0181 CHECKs', () => {
  const db = freshDb();
  db.exec("INSERT INTO products (id, slug, name, status) VALUES ('prop', 'prop', 'Property', 'active')");
  let inserted = 0;
  for (let i = 0; i < 4000; i++) {
    const U = dec(1200, 2400, int(0, 4));
    const eFrac = String(int(0, 400000)).padStart(6, '0').replace(/0+$/, '');
    const E = eFrac ? `1.${eFrac}` : '1';
    const C = `0.1${String(int(1, 999999999)).padStart(9, '0')}`.replace(/0+$/, '');
    const currency = (['USD', 'EUR', 'CNY'] as const)[int(0, 2)];
    const amount = dec(1, 20000, int(0, 3));
    const T = dec(0, 3000, int(0, 2)).replace(/^0$/, '0.01');
    const X = 1000 * int(0, 200);
    const weight = int(1, 60000);
    const shipRate = dec(500, 30000, int(0, 2));
    const additional = int(0, 50000);
    const rates = chainRates(U, E, C, { CHINA_AIR: shipRate });
    const r = priceSku({
      chain: { base: { override: { supplier_cost: amount, supplier_currency: currency, shipping_weight_g: weight, additional_cost_iqd: additional, shipping_profile: 'CHINA_AIR' } } },
      rates, channels: ['pre_order_air', 'direct_sale'], target: usdTarget(T), extra: extraOf(X),
    });
    assert.equal(r.ok, true, `#${i} ${JSON.stringify(r.issues)}`);
    const fxIqd = q(rates.fx[currency]!.rate!);
    const R = qAdd(qAdd(qMul(q(amount), fxIqd), qMul(q(shipRate), [BigInt(weight), 1000n])), [BigInt(additional), 1n]);
    const TU = qMul(q(T), q(U));
    const pre = qCeil([qAdd(R, TU)[0], qAdd(R, TU)[1] * 1000n]) * 1000n;
    const air = channel(r, 'pre_order_air');
    const direct = channel(r, 'direct_sale');
    assert.equal(BigInt(air.computed_price_iqd), pre, `#${i} pre-order`);
    assert.equal(BigInt(direct.computed_price_iqd), pre + BigInt(X), `#${i} direct = pre + X`);
    assert.equal(direct.preorder_base_iqd, air.computed_price_iqd);
    assert.ok(qGe(qAdd([BigInt(air.computed_price_iqd), 1n], [-R[0], R[1]]), TU), `#${i} price − R_exact ≥ T×U`);
    assert.ok(air.rounding_added_iqd >= 0 && air.rounding_added_iqd < ROUNDING_STEP_IQD, `#${i} rounding`);
    assert.equal(BigInt(air.rounding_added_iqd), pre - qCeil(qAdd(R, TU)));
    assert.equal(BigInt(air.target_profit_iqd), qFloor(TU), `#${i} floor(T×U)`);
    if (i % 20 === 0) {
      for (const c of [air, direct]) {
        const row = skuCostRow('prop', `o:k${i}`, c, currency, E, C);
        const keys = Object.keys(row);
        db.prepare(`INSERT INTO pricing_sku_costs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(keys.map((k) => (row as Record<string, unknown>)[k]) as never[]));
        inserted++;
      }
    }
  }
  assert.equal(inserted, 400);
});

/* ------------------------------------------------------ failure shapes -- */

test('a USD minimum needs U on every channel: FX_RATE_MISSING {USD} on an EUR product; an unconfirmed U blocks a write and only warns in a preview', () => {
  const chain: SkuInputChain = { base: { override: { supplier_cost: '450', supplier_currency: 'EUR', shipping_weight_g: 2500, shipping_profile: 'GERMANY_LAND' } } };
  const noUsd: CentralRates = { fx: { EUR: rate('1760') }, shipping: { GERMANY_LAND: rate('3200') } };
  const r = priceSku({ chain, rates: noUsd, channels: ['pre_order_land', 'direct_sale'], target: usdTarget('120'), extra: extraOf(0) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.channels, []);
  for (const c of ['pre_order_land', 'direct_sale'] as const) {
    const issue = r.issues.find((i) => i.channel === c && i.code === 'FX_RATE_MISSING');
    assert.equal(issue?.currency, 'USD', c);
  }
  // A dinar (migrated) minimum does not need U: same product, priced, USD figures null.
  const legacy = priceSku({ chain, rates: noUsd, channels: ['pre_order_land'], target: iqdTarget(192_000) });
  assert.equal(channel(legacy, 'pre_order_land').computed_price_iqd, 992_000);
  assert.equal(channel(legacy, 'pre_order_land').final_price_usd, null);

  const unconfirmed = chainRates('1600', '1.1', '0.14', { GERMANY_LAND: '3200' });
  const shaky: CentralRates = { ...unconfirmed, fx: { ...unconfirmed.fx, USD: rate('1600', false) } };
  const write = priceSku({ chain, rates: shaky, channels: ['pre_order_land'], target: usdTarget('120') });
  assert.deepEqual(codes(write), ['FX_RATE_UNCONFIRMED']);
  assert.equal(write.channels.length, 0);
  const preview = priceSku({ chain, rates: shaky, channels: ['pre_order_land'], target: usdTarget('120'), allowUnconfirmedRates: true });
  assert.equal(channel(preview, 'pre_order_land').computed_price_iqd, 992_000);
  assert.ok(preview.issues.every((i) => i.severity === 'warning'));
});

test('an invalid USD amount on a hand-built resolution fails closed (TARGET_PROFIT_BLOCKED); a mixed tie priced at another rate is a programming error', () => {
  const rates = chainRates('1600', '1.1', '0.14', { GERMANY_LAND: '3200' });
  const chain: SkuInputChain = { base: { override: { supplier_cost: '450', supplier_currency: 'EUR', shipping_weight_g: 2500 } } };
  for (const bad of ['0', '120.555', '100000.01', '-1', 'abc']) {
    const r = priceSku({ chain, rates, channels: ['pre_order_land'], target: usdTarget(bad) });
    assert.deepEqual(codes(r), ['TARGET_PROFIT_BLOCKED'], bad);
  }
  const both = priceSku({ chain, rates, channels: ['pre_order_land'], target: usdTarget('120', { amount_iqd: 5 }) });
  assert.deepEqual(codes(both), ['TARGET_PROFIT_BLOCKED'], 'never both currencies');
  assert.throws(
    () => priceSku({ chain, rates, channels: ['pre_order_land'], target: usdTarget('120', { tie: true, ranked_at_usd_iqd: '1500' }) }),
    /PRICING_INVARIANT: a mixed tie is ranked at the rate it is priced at/
  );
  const sameRate = priceSku({ chain, rates, channels: ['pre_order_land'], target: usdTarget('120', { tie: true, ranked_at_usd_iqd: '1600.0' }) });
  assert.equal(channel(sameRate, 'pre_order_land').computed_price_iqd, 992_000);
});

test('a migrated dinar minimum prices exactly as before: ceil_1000(R_exact + T), rounding = computed − R − T − X', () => {
  const rates = chainRates('1500', '1.084166', '0.156666', { CHINA_AIR: '12500', GERMANY_LAND: '5950' });
  const chain: SkuInputChain = { base: { override: { supplier_cost: '873.42', supplier_currency: 'EUR', shipping_weight_g: 18_000, shipping_profile: 'GERMANY_LAND' } } };
  const r = priceSku({ chain, rates, channels: ['pre_order_air', 'direct_sale'], target: iqdTarget(200_000), extra: extraOf(50_000) });
  for (const c of r.channels) {
    const X = c.direct_sale_extra_iqd ?? 0;
    assert.equal(c.preorder_base_iqd, preorderPrice(c.replacement_exact, 200_000));
    assert.equal(c.computed_price_iqd, c.preorder_base_iqd + X);
    assert.equal(c.rounding_added_iqd, c.computed_price_iqd - c.replacement_cost_iqd - 200_000 - X);
    assert.equal(c.target_profit_iqd, 200_000);
    assert.equal(c.target_profit_usd, null);
    assert.equal(c.target_profit_iqd_exact, '200000');
    assert.ok(c.final_price_usd, 'USD figures are shown when U exists');
  }
});

test('preorderPrice takes an exact rational minimum; a fractional JS number is still refused', () => {
  assert.equal(preorderPrice('800000', '192000'), 992_000);
  assert.equal(preorderPrice('800065.539', '200173.275'), 1_001_000);
  assert.equal(preorderPrice({ num: 8_000_000n, den: 10n }, { num: 1_920_001n, den: 10n }), 993_000);
  assert.throws(() => preorderPrice(800_000, 1.5), RangeError);
  assert.throws(() => preorderPrice(800_000, '0'), RangeError);
  assert.throws(() => preorderPrice(800_000, '-1'), RangeError);
});

/* ----------------------------------------------------- the storefront -- */

test('the storefront never recomputes: only the owner pricing router, the engine and FX modules import costToPrice, fxChain or pricingEngine (USD design §2.4)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const ENGINE = /from\s+['"][^'"]*(?:\/pricingEngine\/[^'"]+|\/costToPrice|\/fxChain)['"]/;
  const allowed = (f: string) => f.startsWith('worker/lib/pricingEngine/') || f.startsWith('worker/lib/fx/') || f === 'worker/routes/adminPricing.ts';
  const files = [...walk(join(ROOT, 'worker')), ...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'services'))].map((f) => ({
    f: relative(ROOT, f).split('\\').join('/'),
    src: readFileSync(f, 'utf8'),
  }));
  const importers = files.filter(({ src }) => ENGINE.test(src)).map(({ f }) => f);
  assert.ok(importers.includes('worker/routes/adminPricing.ts'), 'not vacuous');
  // Owner decision 6 (ODP §5.1 item 10): checkout and the price-protection claim read the engine's
  // STORED results through two helpers that compute no price — the order line's snapshot and the
  // claim's observations. They import those two helpers only, and the helpers import no price computer.
  const DECISION6: Readonly<Record<string, readonly string[]>> = {
    'worker/routes/orders.ts': ['../lib/pricingEngine/orderBasis'],
    'worker/routes/returns.ts': ['../lib/pricingEngine/orderBasis', '../lib/pricingEngine/protectionBasis'],
  };
  for (const [f, helpers] of Object.entries(DECISION6)) {
    const src = files.find((x) => x.f === f)!.src;
    const engine = [...src.matchAll(/from\s+['"]([^'"]*(?:\/pricingEngine\/[^'"]+|\/costToPrice|\/fxChain))['"]/g)].map((m) => m[1]).sort();
    assert.deepEqual(engine, [...helpers].sort(), f);
  }
  for (const helper of ['worker/lib/pricingEngine/orderBasis.ts', 'worker/lib/pricingEngine/protectionBasis.ts']) {
    const src = files.find((x) => x.f === helper)!.src;
    assert.doesNotMatch(src, /from\s+['"][^'"]*(?:\/costToPrice|\/fxChain|\/ruleResolution|\/engineWrite|\/writer|\/procurementPreview)['"]/, helper);
  }
  // The owner's product tools — admin routes and the cron, never a customer path: the product data
  // file's pricing block reads and writes inputs and rules through the engine's own modules (DECISIONS
  // row 204), and «ناقص» asks the engine's resolvers whether a cost or a minimum profit EXISTS; it
  // computes no price (row 205). None of them is reachable from a customer route.
  const OWNER_TOOLS = ['worker/lib/productDataFilePricing.ts', 'worker/routes/templateDataFile.ts', 'worker/lib/productCompleteness.ts'];
  const TOOL_IMPORT = /from\s+['"][^'"]*\/(?:productDataFilePricing|templateDataFile|productCompleteness|completenessHooks)['"]/;
  for (const f of ['worker/routes/products.ts', 'worker/routes/cart.ts', 'worker/routes/orders.ts', 'worker/routes/catalog.ts', 'worker/routes/compare.ts', 'worker/routes/seo.ts', 'worker/lib/listing.ts', 'worker/lib/publicApi/resources/products.ts']) {
    assert.doesNotMatch(files.find((x) => x.f === f)!.src, TOOL_IMPORT, `${f} reaches no owner tool`);
  }
  assert.deepEqual(importers.filter((f) => !allowed(f) && !(f in DECISION6) && !OWNER_TOOLS.includes(f)), []);
});
