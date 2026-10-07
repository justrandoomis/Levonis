/**
 * The pricing engine's maths, exact (master plan v2 §2.4, E1; LD4, [C2-M4],
 * [C2-M5], [C1-G10], [C1-G24], [L2-1a], [L2-1b], LD6).
 *
 * The owner's rule (decision 3): Final Price − Replacement Cost ≥ Target Profit,
 * ALWAYS — so the price is ceil_1000(R_exact + T), never a rounding to nearest,
 * and the price moves when costs move instead of the profit shrinking. A
 * property test checks it on 100,000 random SKUs against an independent BigInt
 * oracle written in this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_MAX_SKUS,
  MAX_FINAL_PRICE_IQD,
  ROUNDING_STEP_IQD,
  ceilStep,
  directPrice,
  isOnStep,
  preorderPrice,
  priceSku,
  replacementCost,
  resolveSkuInputs,
  type CentralRates,
  type ChannelPrice,
  type PriceSkuInput,
  type PricingInputRow,
  type SkuInputChain,
  type SkuPricingResult,
  type SupplierCurrency,
} from '../packages/pricing/src/costToPrice';
import type { RuleResolution } from '../packages/pricing/src/ruleResolution';
import {
  PROFILE_BASIS,
  ROUTE_PROFILE,
  SHIPPING_PROFILES,
  SKU_CHANNELS,
  channelOfRoute,
  channelOfShippingType,
  parseSkuComboKey,
  profileOfChannel,
  routeOfChannel,
  shippingTypeOfChannel,
  skuComboKey,
  skuPriceHistoryKey,
  type ShippingProfile,
  type SkuChannel,
} from '../packages/pricing/src/skuChannel';
import {
  addProcurementExact,
  ceilProcurementExact,
  compareProcurementExact,
  divProcurementExact,
  mulProcurementExact,
  parseProcurementDecimal,
  procurementExact,
  procurementExactText,
  roundProcurementProduct,
} from '../packages/contracts/src/procurementCost';
import { PRICING_ISSUES, isPricingIssueCode } from '../packages/contracts/src/pricingIssues';
import { isPricingFieldName } from '../packages/contracts/src/pricingFieldLabels';
import { comboKey } from '../worker/lib/inventory';
import { SHIPPING_TYPES } from '../packages/pricing/src/shippingType';
import { importSpecifiers, tsFiles } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- fixtures -- */

const rate = (r: string | null, confirmed = true, version = 1) => ({ rate: r, version, confirmed });
const RATES: CentralRates = {
  fx: { USD: rate('1500'), EUR: rate('1626.25'), CNY: rate('235') },
  shipping: { GERMANY_LAND: rate('5950'), CHINA_AIR: rate('12500'), CHINA_SEA: rate('450000') },
};
const withRates = (patch: { fx?: CentralRates['fx']; shipping?: CentralRates['shipping'] }): CentralRates => ({
  fx: { ...RATES.fx, ...patch.fx },
  shipping: { ...RATES.shipping, ...patch.shipping },
});

const active = (amount: number, kind: 'target_profit' | 'direct_premium' = 'target_profit', id = kind === 'target_profit' ? 'rule_t' : 'rule_p'): RuleResolution => ({
  status: 'active',
  kind,
  amount_iqd: amount,
  rule: { id, version: 3, scope: 'product', scope_id: '', catalog_id: null },
  tie: false,
  candidates: [{ id, version: 3, scope: 'product', scope_id: '', catalog_id: null }],
});
const T = (amount: number) => active(amount, 'target_profit');
const P = (amount: number) => active(amount, 'direct_premium');
const base = (source: PricingInputRow, override?: PricingInputRow): SkuInputChain => ({ base: { source, override } });

const price = (input: Partial<PriceSkuInput> & Pick<PriceSkuInput, 'chain'>): SkuPricingResult =>
  priceSku({ rates: RATES, channels: ['pre_order_air'], target: T(200_000), ...input });

const channel = (r: SkuPricingResult, c: SkuChannel): ChannelPrice => {
  const found = r.channels.find((x) => x.channel === c);
  assert.ok(found, `channel ${c} priced (issues: ${JSON.stringify(r.issues)})`);
  return found;
};
const codes = (r: SkuPricingResult, c?: SkuChannel) => [...new Set(r.issues.filter((i) => !c || i.channel === c).map((i) => i.code))].sort();

/** Every issue is a known code with the table's severity, carries no number, and
 * every error names a channel that is then absent from the priced channels. */
function assertWellFormed(r: SkuPricingResult): void {
  const priced = new Set(r.channels.map((c) => c.channel));
  for (const issue of r.issues) {
    assert.ok(isPricingIssueCode(issue.code), issue.code);
    if (issue.code === 'FX_RATE_UNCONFIRMED' || issue.code === 'SHIPPING_RATE_UNCONFIRMED') assert.ok(['error', 'warning'].includes(issue.severity));
    else assert.equal(issue.severity, PRICING_ISSUES[issue.code].severity, issue.code);
    for (const [k, v] of Object.entries(issue)) assert.notEqual(typeof v, 'number', `issue ${issue.code} carries a number in ${k}`);
    if (issue.field) assert.ok(isPricingFieldName(issue.field), `field ${issue.field} has a label`);
    if (issue.severity === 'error') {
      assert.ok(issue.channel, `${issue.code} names its channel`);
      assert.ok(!priced.has(issue.channel), `${issue.channel} has an error and must not be priced`);
    }
  }
  assert.equal(r.ok, r.issues.every((i) => i.severity !== 'error') && r.channels.length === new Set(r.channels.map((c) => c.channel)).size);
}

/* -------------------------------------------------- an independent oracle -- */
// Written without the contracts helpers, so the property test checks the engine
// against a second implementation of the same exact arithmetic.
type Q = readonly [bigint, bigint];
const q = (text: string): Q => {
  const [i, f = ''] = text.split('.');
  return [BigInt(`${i}${f}`), 10n ** BigInt(f.length)];
};
const qInt = (n: number | bigint): Q => [BigInt(n), 1n];
const qAdd = (a: Q, b: Q): Q => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const qMul = (a: Q, b: Q): Q => [a[0] * b[0], a[1] * b[1]];
const qDiv = (a: Q, d: bigint): Q => [a[0], a[1] * d];
const qCeil = (a: Q): bigint => (a[0] % a[1] === 0n ? a[0] / a[1] : a[0] / a[1] + 1n); // a ≥ 0
const qCmp = (a: Q, b: Q) => {
  const l = a[0] * b[1], r = b[0] * a[1];
  return l < r ? -1 : l > r ? 1 : 0;
};

/* ------------------------------------------------- the owner's examples -- */

test('owner decision 3: R 800,000 + T 200,000 → 1,000,000; R 875,000 → 1,075,000; direct +50,000 → 1,125,000', () => {
  assert.equal(ROUNDING_STEP_IQD, 1000);
  assert.equal(preorderPrice(800_000, 200_000), 1_000_000);
  assert.equal(preorderPrice(875_000, 200_000), 1_075_000);
  assert.equal(directPrice(preorderPrice(875_000, 200_000), 50_000), 1_125_000);
});

test('owner decision 3: a calculated 1,073,420 rounds UP — never down — and profit never falls below target', () => {
  assert.equal(ceilStep(1_073_420), 1_074_000);
  assert.equal(ceilStep('1073420'), 1_074_000);
  assert.equal(ceilStep(1_074_000), 1_074_000, 'already on the step: unchanged');
  assert.equal(ceilStep('1073000.0001'), 1_074_000, 'a fraction of a dinar above a step goes to the next step');
  const p = preorderPrice(873_420, 200_000);
  assert.equal(p, 1_074_000);
  assert.ok(p - 873_420 >= 200_000);
  assert.equal(isOnStep(50_000), true);
  assert.equal(isOnStep(50_500), false);
  assert.throws(() => directPrice(1_074_000, 50_500), /PREMIUM_NOT_ON_STEP/, 'a premium off the step is refused, never rounded');
  assert.throws(() => preorderPrice(800_000, 0), RangeError, 'a target of 0 is no target [C2-M2]');
});

test('owner decision 3 through the engine: FX rises, the PRICE moves and the target profit stays 200,000', () => {
  // USD 500 × 1,500 = 750,000 + 1 kg air at 50,000/kg = 800,000.
  const rates = withRates({ shipping: { CHINA_AIR: rate('50000') } });
  const chain = (usd: string) => base({ supplier_cost: usd, supplier_currency: 'USD', shipping_weight_g: 1000, shipping_profile: 'CHINA_AIR' });
  const input = { rates, channels: ['direct_sale', 'pre_order_air'] as SkuChannel[], target: T(200_000), premium: P(50_000) };
  const before = priceSku({ ...input, chain: chain('500') });
  assert.equal(channel(before, 'pre_order_air').replacement_cost_iqd, 800_000);
  assert.equal(channel(before, 'pre_order_air').computed_price_iqd, 1_000_000);
  assert.equal(channel(before, 'direct_sale').computed_price_iqd, 1_050_000);
  // USD 550 → replacement 875,000: the price follows, the profit does not shrink.
  const after = priceSku({ ...input, chain: chain('550') });
  const air = channel(after, 'pre_order_air');
  assert.equal(air.replacement_cost_iqd, 875_000);
  assert.equal(air.computed_price_iqd, 1_075_000);
  assert.equal(air.computed_price_iqd - air.replacement_cost_iqd, 200_000);
  const direct = channel(after, 'direct_sale');
  assert.equal(direct.preorder_base_iqd, 1_075_000);
  assert.equal(direct.direct_premium_iqd, 50_000);
  assert.equal(direct.computed_price_iqd, 1_125_000);
  assert.equal(after.ok, true);
});

/* ----------------------------------------------------- brief 1 §5 example -- */

test('brief 1 §5: Product 500 EUR / 15 kg, Combo +80 EUR / 22 kg, Red +5 EUR, Combo+Red SKU 22.5 kg → 585 EUR at 22.5 kg', () => {
  const product = { source: { supplier_cost: '500', supplier_currency: 'EUR' as const, shipping_weight_g: 15_000, shipping_profile: 'GERMANY_LAND' as const } };
  const combo = { scope_id: 'ov_combo', source: { supplier_cost_delta: '+80', shipping_weight_g: 22_000 } };
  const standalone = { scope_id: 'ov_standalone', source: null };
  const red = { scope_id: 'col_red', source: { supplier_cost_delta: '5' } };
  const comboRed = skuComboKey({ option_value_ids: ['ov_combo'], color_id: 'col_red' });
  const skus: Array<[string, SkuInputChain, string, number]> = [
    ['Combo / Red', { base: product, options: [combo], color: red, sku: { scope_id: comboRed, source: { shipping_weight_g: 22_500 } } }, '585', 22_500],
    ['Combo / Black', { base: product, options: [combo], color: null }, '580', 22_000],
    ['Standalone / Red', { base: product, options: [standalone], color: red }, '505', 15_000],
    ['Standalone / Black', { base: product, options: [standalone] }, '500', 15_000],
  ];
  for (const [name, chain, eur, grams] of skus) {
    const r = priceSku({ chain, rates: RATES, channels: ['pre_order_land'], target: T(200_000) });
    assertWellFormed(r);
    assert.equal(r.inputs.supplier?.amount, eur, `${name}: supplier cost`);
    assert.equal(r.inputs.supplier?.currency, 'EUR');
    assert.equal(r.inputs.weight?.value, grams, `${name}: weight`);
    const land = channel(r, 'pre_order_land');
    const exact = qAdd(qMul(q(eur), q('1626.25')), qDiv(qMul(qInt(grams), q('5950')), 1000n));
    assert.equal(BigInt(land.replacement_cost_iqd), qCeil(exact), name);
    assert.equal(BigInt(land.computed_price_iqd), qCeil(qDiv(qAdd(exact, qInt(200_000)), 1000n)) * 1000n, name);
  }
  // Combo / Red in full: 585 × 1626.25 = 951,356.25; 22.5 kg × 5,950 = 133,875.
  const r = priceSku({ chain: skus[0][1], rates: RATES, channels: ['pre_order_land'], target: T(200_000) });
  const land = channel(r, 'pre_order_land');
  assert.equal(land.supplier_cost_exact, '951356.25');
  assert.equal(land.supplier_cost_iqd, 951_357);
  assert.equal(land.shipping_cost_exact, '133875');
  assert.equal(land.replacement_exact, '1085231.25');
  assert.equal(land.replacement_cost_iqd, 1_085_232);
  assert.equal(land.shipping_cost_iqd, 133_875);
  assert.equal(land.computed_price_iqd, 1_286_000);
  assert.equal(r.inputs.weight?.level, 'sku');
  assert.equal(r.inputs.supplier?.amount_level, 'base');
});

/* ---------------------------------------------------- reference vectors -- */

test('reference vectors (ENG §4.2.2): EUR/Germany, CNY air, CNY sea box and manual, USD equality, the float trap', () => {
  // EUR / Germany land, additional 15,000, direct +50,000.
  const eur = priceSku({
    chain: base({ supplier_cost: '855', supplier_currency: 'EUR', shipping_weight_g: 22_300, additional_cost_iqd: 15_000, shipping_profile: 'GERMANY_LAND' }),
    rates: RATES,
    channels: ['direct_sale', 'pre_order_land'],
    target: T(200_000),
    premium: P(50_000),
  });
  assertWellFormed(eur);
  const land = channel(eur, 'pre_order_land');
  assert.equal(land.supplier_cost_exact, '1390443.75');
  assert.equal(land.supplier_cost_iqd, 1_390_444);
  assert.equal(land.shipping_cost_iqd, 132_685);
  assert.equal(land.additional_cost_iqd, 15_000);
  assert.equal(land.replacement_exact, '1538128.75');
  assert.equal(land.replacement_cost_iqd, 1_538_129);
  assert.equal(land.computed_price_iqd, 1_739_000);
  assert.equal(land.rounding_added_iqd, 871);
  assert.equal(channel(eur, 'direct_sale').computed_price_iqd, 1_789_000);
  assert.equal(channel(eur, 'direct_sale').shipping_profile, 'GERMANY_LAND', 'direct is priced on the default profile');

  // CNY air: 3,200 × 235 = 752,000; 15 kg × 12,500 = 187,500 → 939,500; T 150,000 → 1,090,000.
  const air = channel(price({ chain: base({ supplier_cost: '3200', supplier_currency: 'CNY', shipping_weight_g: 15_000 }), target: T(150_000) }), 'pre_order_air');
  assert.equal(air.replacement_cost_iqd, 939_500);
  assert.equal(air.computed_price_iqd, 1_090_000);

  // CNY sea, box 600 × 500 × 450 mm = 0.135 CBM × 450,000 = 60,750 → 812,750 → 963,000.
  const box = { supplier_cost: '3200', supplier_currency: 'CNY' as const, shipping_length_mm: 600, shipping_width_mm: 500, shipping_height_mm: 450 };
  const seaBox = channel(price({ chain: base(box), channels: ['pre_order_sea'], target: T(150_000) }), 'pre_order_sea');
  assert.equal(seaBox.shipping_cbm, '0.135');
  assert.equal(seaBox.effective_cbm, '0.135');
  assert.equal(seaBox.manual_cbm, null);
  assert.equal(seaBox.shipping_cost_iqd, 60_750);
  assert.equal(seaBox.replacement_cost_iqd, 812_750);
  assert.equal(seaBox.computed_price_iqd, 963_000);
  assert.equal(seaBox.effective_weight_g, null, 'a volume channel does not record a weight');

  // Same level, manual CBM 0.142 wins (LD6): 63,900 → 815,900 → 966,000.
  const seaManual = channel(price({ chain: base({ ...box, manual_cbm: '0.142' }), channels: ['pre_order_sea'], target: T(150_000) }), 'pre_order_sea');
  assert.equal(seaManual.manual_cbm, '0.142');
  assert.equal(seaManual.shipping_cbm, '0.135', 'the calculated CBM is still shown beside the manual one');
  assert.equal(seaManual.effective_cbm, '0.142');
  assert.equal(seaManual.shipping_cost_iqd, 63_900);
  assert.equal(seaManual.computed_price_iqd, 966_000);

  // USD exactly on the step: 520 × 1,500 + 8 kg × 12,500 = 880,000; + 100,000 = 980,000 (equality allowed).
  const usd = channel(price({ chain: base({ supplier_cost: '520', supplier_currency: 'USD', shipping_weight_g: 8_000 }), target: T(100_000) }), 'pre_order_air');
  assert.equal(usd.computed_price_iqd, 980_000);
  assert.equal(usd.rounding_added_iqd, 0);

  // Float trap: 0.07 × 100 is exactly 7 (a float ceil gives 8).
  assert.equal(Math.ceil(0.07 * 100), 8, 'the trap is real');
  const trap = channel(
    price({ chain: base({ supplier_cost: '0.07', supplier_currency: 'USD', shipping_weight_g: 1 }), rates: withRates({ fx: { USD: rate('100') } }), target: T(1_000) }),
    'pre_order_air'
  );
  assert.equal(trap.supplier_cost_exact, '7');
  assert.equal(trap.supplier_cost_iqd, 7);
});

test('[C2-M4] one ceiling on the exact sum: exact R 874,999.6 + 200,000 → 1,075,000, not the double-ceiling 1,076,000', () => {
  // 291.6662 USD × 1,500 = 437,499.3 and 1 kg × 437,500.3 = 437,500.3 → R_exact 874,999.6.
  const r = price({
    chain: base({ supplier_cost: '291.6662', supplier_currency: 'USD', shipping_weight_g: 1_000 }),
    rates: withRates({ shipping: { CHINA_AIR: rate('437500.3') } }),
  });
  const air = channel(r, 'pre_order_air');
  assert.equal(air.replacement_exact, '874999.6');
  assert.equal(air.replacement_cost_iqd, 875_000);
  assert.equal(air.computed_price_iqd, 1_075_000);
  assert.equal(air.supplier_cost_iqd, 437_500, 'supplier = ceil(exact supplier)');
  assert.equal(air.shipping_cost_iqd, 437_500, 'shipping = R − supplier − additional, not ceil(437,500.3)');
  assert.equal(air.supplier_cost_iqd + air.shipping_cost_iqd + air.additional_cost_iqd, air.replacement_cost_iqd);
  // The component-ceiling way would have charged a whole extra step.
  assert.equal(ceilStep(437_500 + 437_501 + 200_000), 1_076_000);
});

test('[L2-4e][LD4] exact R 800,000.4 + 200,000 → 1,001,000: the half-up replacement (800,000 → 1,000,000) would leave 199,999.6', () => {
  // 500.0004 USD × 1,500 = 750,000.6 and 1 kg × 49,999.8 = 49,999.8 → 800,000.4.
  const r = price({
    chain: base({ supplier_cost: '500.0004', supplier_currency: 'USD', shipping_weight_g: 1_000 }),
    rates: withRates({ shipping: { CHINA_AIR: rate('49999.8') } }),
  });
  const air = channel(r, 'pre_order_air');
  assert.equal(air.replacement_exact, '800000.4');
  assert.equal(air.computed_price_iqd, 1_001_000);
  assert.equal(air.replacement_cost_iqd, 800_001);
  assert.equal(roundProcurementProduct(['800000.4']) + 200_000, 1_000_000, 'the half-up path the plan forbids');
  assert.ok(qCmp(qAdd(qInt(air.computed_price_iqd), [-q('800000.4')[0], q('800000.4')[1]]), qInt(200_000)) >= 0);
});

/* -------------------------------------------------------- property test -- */

/** mulberry32: a small seeded PRNG, so a failure reproduces. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: 100,000 random SKUs — price = ceil_step(R_exact + T) (+P), parts sum to R, price − R_exact ≥ T, on the step', () => {
  const rnd = prng(0x5eed_e1);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const decimal = (lo: number, hi: number, maxPlaces: number) => {
    const places = int(0, maxPlaces);
    const frac = places ? `.${Array.from({ length: places }, () => int(0, 9)).join('')}` : '';
    return `${int(lo, hi)}${frac}`;
  };
  const currencies: SupplierCurrency[] = ['USD', 'EUR', 'CNY'];
  let priced = 0;
  for (let i = 0; i < 100_000; i++) {
    const currency = currencies[int(0, 2)];
    const profile: ShippingProfile = SHIPPING_PROFILES[int(0, 2)];
    const fxText = decimal(1, 20_000, 6);
    const shipText = decimal(1, PROFILE_BASIS[profile] === 'volume' ? 900_000 : 30_000, 3);
    const supplierText = decimal(1, 99_999, 4);
    const optionDelta = rnd() < 0.3 ? decimal(0, 500, 2) : null;
    const colorDelta = rnd() < 0.3 ? decimal(0, 50, 2) : null;
    const target = int(1, 2_000_000);
    const premium = int(0, 500) * 1000;
    const additional = rnd() < 0.5 ? null : int(0, 500_000);
    const step = rnd() < 0.9 ? 1000 : [1, 250, 5000][int(0, 2)];

    const baseRow: PricingInputRow = { supplier_cost: supplierText, supplier_currency: currency, shipping_profile: profile, additional_cost_iqd: additional };
    let measure: Q;
    if (PROFILE_BASIS[profile] === 'weight') {
      const grams = int(1, 200_000);
      baseRow.shipping_weight_g = grams;
      measure = qDiv(qInt(grams), 1000n);
    } else if (rnd() < 0.5) {
      const [l, w, h] = [int(1, 2500), int(1, 2500), int(1, 2500)];
      Object.assign(baseRow, { shipping_length_mm: l, shipping_width_mm: w, shipping_height_mm: h });
      measure = qDiv(qInt(BigInt(l) * BigInt(w) * BigInt(h)), 1_000_000_000n);
    } else {
      const cbm = `${int(0, 30)}.${String(int(1, 999_999)).padStart(6, '0')}`;
      baseRow.manual_cbm = cbm;
      measure = q(cbm);
    }
    const chain: SkuInputChain = {
      base: { source: baseRow },
      options: optionDelta ? [{ scope_id: 'ov_1', source: { supplier_cost_delta: `+${optionDelta}` } }] : [],
      color: colorDelta ? { scope_id: 'col_1', override: { supplier_cost_delta: colorDelta } } : null,
    };
    const route = PROFILE_BASIS[profile] === 'volume' ? 'sea' : profile === 'CHINA_AIR' ? 'air' : 'land';
    const rates: CentralRates = withRates({ fx: { [currency]: rate(fxText) }, shipping: { [profile]: rate(shipText) } });
    const P_ = premium - (premium % step);
    const r = priceSku({ chain, rates, channels: ['direct_sale', channelOfRoute(route)], target: T(target), premium: P(P_), step });

    // The oracle.
    let amount = q(supplierText);
    if (optionDelta) amount = qAdd(amount, q(optionDelta));
    if (colorDelta) amount = qAdd(amount, q(colorDelta));
    const S = qMul(amount, q(fxText));
    const H = qMul(q(shipText), measure);
    const Rx = qAdd(qAdd(S, H), qInt(additional ?? 0));
    const R = qCeil(Rx);
    const B = qCeil(qDiv(qAdd(Rx, qInt(target)), BigInt(step))) * BigInt(step);

    assert.equal(r.ok, true, `#${i}: ${JSON.stringify(r.issues)}`);
    assert.equal(r.channels.length, 2);
    for (const c of r.channels) {
      const premiumHere = c.channel === 'direct_sale' ? P_ : 0;
      assert.equal(BigInt(c.replacement_cost_iqd), R, `#${i} R = ceil(R_exact)`);
      assert.equal(qCmp(q(c.replacement_exact), Rx), 0, `#${i} replacement_exact is exact`);
      assert.equal(BigInt(c.supplier_cost_iqd), qCeil(S), `#${i} supplier = ceil(exact)`);
      assert.equal(c.supplier_cost_iqd + c.shipping_cost_iqd + c.additional_cost_iqd, c.replacement_cost_iqd, `#${i} parts sum to R`);
      assert.ok(c.shipping_cost_iqd >= 0 && BigInt(c.shipping_cost_iqd) <= qCeil(H), `#${i} 0 ≤ shipping ≤ ceil(exact shipping)`);
      assert.equal(BigInt(c.preorder_base_iqd), B, `#${i} pre-order = ceil_step(R_exact + T)`);
      assert.equal(BigInt(c.preorder_base_iqd), qCeil(qDiv(qInt(R + BigInt(target)), BigInt(step))) * BigInt(step), `#${i} ≡ ceil_step(R + T)`);
      assert.equal(c.computed_price_iqd, c.preorder_base_iqd + premiumHere, `#${i} (+P)`);
      assert.equal(c.computed_price_iqd % step, 0, `#${i} on the step`);
      // price − premium − R_exact ≥ T, exactly.
      assert.ok(qCmp(qAdd(qInt(c.computed_price_iqd - premiumHere), [-Rx[0], Rx[1]]), qInt(target)) >= 0, `#${i} profit ≥ target`);
      assert.ok(c.rounding_added_iqd >= 0 && c.rounding_added_iqd < step, `#${i} rounding < one step`);
      assert.equal(c.rounding_added_iqd, c.computed_price_iqd - c.replacement_cost_iqd - target - premiumHere);
      assert.equal(c.rounding_step_iqd, step);
      priced++;
    }
  }
  assert.equal(priced, 200_000);
});

/* ------------------------------------------- missing inputs → codes only -- */

test('missing inputs return codes, never a number; a zero supplier cost is missing [C1-G24]', () => {
  const all = SKU_CHANNELS;
  const none = priceSku({ chain: {}, rates: RATES, channels: all, target: T(200_000), premium: P(50_000) });
  assertWellFormed(none);
  assert.equal(none.ok, false);
  assert.deepEqual(none.channels, []);
  for (const c of all) assert.ok(codes(none, c).includes('SUPPLIER_COST_MISSING') && codes(none, c).includes('SUPPLIER_CURRENCY_MISSING'), c);
  assert.deepEqual(codes(none, 'pre_order_air'), ['SUPPLIER_COST_MISSING', 'SUPPLIER_CURRENCY_MISSING', 'WEIGHT_MISSING']);
  assert.deepEqual(codes(none, 'pre_order_sea'), ['CBM_MISSING', 'SUPPLIER_COST_MISSING', 'SUPPLIER_CURRENCY_MISSING']);
  assert.deepEqual(codes(none, 'direct_sale'), ['SHIPPING_PROFILE_MISSING', 'SUPPLIER_COST_MISSING', 'SUPPLIER_CURRENCY_MISSING']);

  for (const zero of ['0', '0.00', '000']) {
    const r = price({ chain: base({ supplier_cost: zero, supplier_currency: 'USD', shipping_weight_g: 1000 }) });
    assertWellFormed(r);
    assert.deepEqual(codes(r), ['SUPPLIER_COST_MISSING'], zero);
  }
  const cancelled = price({
    chain: { base: { source: { supplier_cost: '500', supplier_currency: 'USD', shipping_weight_g: 1000 } }, color: { scope_id: 'c', source: { supplier_cost_delta: '-500' } } },
  });
  assert.deepEqual(codes(cancelled), ['SUPPLIER_COST_MISSING'], 'differences that bring the cost to 0 leave it missing');
  const negative = price({
    chain: { base: { source: { supplier_cost: '500', supplier_currency: 'USD', shipping_weight_g: 1000 } }, color: { scope_id: 'c', source: { supplier_cost_delta: '-500.01' } } },
  });
  assert.deepEqual(codes(negative), ['NEGATIVE_SUPPLIER_COST']);
});

test('supplier differences: DELTA_WITHOUT_BASE, CURRENCY_MISMATCH, CURRENCY_WITHOUT_AMOUNT, INPUT_CONFLICT, and an SKU absolute replaces the ladder', () => {
  const ok = { shipping_weight_g: 1000 };
  const check = (chain: SkuInputChain, expected: string[]) => {
    const r = price({ chain });
    assertWellFormed(r);
    assert.deepEqual(codes(r), expected, JSON.stringify(chain));
    return r;
  };
  check({ base: { source: { supplier_currency: 'EUR', ...ok } }, options: [{ scope_id: 'o1', source: { supplier_cost_delta: '80' } }] }, ['DELTA_WITHOUT_BASE']);
  check({ base: { source: { supplier_cost: '500', supplier_currency: 'EUR', ...ok } }, color: { scope_id: 'c', source: { supplier_cost_delta: '5', supplier_currency: 'USD' } } }, ['CURRENCY_MISMATCH']);
  check({ base: { source: { supplier_cost: '500', supplier_currency: 'EUR', ...ok } }, color: { scope_id: 'c', source: { supplier_currency: 'CNY' } } }, ['CURRENCY_WITHOUT_AMOUNT']);
  const conflict = check(
    { base: { source: { supplier_currency: 'EUR', ...ok } }, options: [{ scope_id: 'o1', source: { supplier_cost: '600' } }, { scope_id: 'o2', source: { supplier_cost: '650' } }] },
    ['INPUT_CONFLICT']
  );
  assert.deepEqual(conflict.issues[0].scope_ids, ['o1', 'o2']);
  assert.equal(conflict.issues[0].level, 'option');
  assert.equal(conflict.issues[0].field, 'supplier_cost');
  // Same absolute value from two options is no conflict; two differences add up.
  const same = check(
    { base: { source: { supplier_currency: 'EUR', ...ok } }, options: [{ scope_id: 'o1', source: { supplier_cost: '600.0' } }, { scope_id: 'o2', source: { supplier_cost: '600' } }] },
    []
  );
  assert.equal(same.inputs.supplier?.amount, '600');
  const twoGroups = check(
    { base: { source: { supplier_cost: '500', supplier_currency: 'EUR', ...ok } }, options: [{ scope_id: 'o1', source: { supplier_cost_delta: '80' } }, { scope_id: 'o2', source: { supplier_cost_delta: '12.5' } }] },
    []
  );
  assert.equal(twoGroups.inputs.supplier?.amount, '592.5');
  // An absolute cost on the exact SKU replaces product + differences; its currency too.
  const sku = check(
    {
      base: { source: { supplier_cost: '500', supplier_currency: 'EUR', ...ok } },
      options: [{ scope_id: 'o1', source: { supplier_cost_delta: '80' } }],
      sku: { scope_id: 'o:o1', source: { supplier_cost: '3200', supplier_currency: 'CNY' } },
    },
    []
  );
  assert.deepEqual(sku.inputs.supplier, { amount: '3200', currency: 'CNY', amount_level: 'sku' });
  // MANUAL_OVERRIDE's amount wins whole over SOURCE's at the same scope; currency per field.
  const manual = check(base({ supplier_cost: '500', supplier_currency: 'EUR', ...ok }, { supplier_cost: '510' }), []);
  assert.deepEqual(manual.inputs.supplier, { amount: '510', currency: 'EUR', amount_level: 'base' });
});

test('rates: missing or zero → FX/SHIPPING_RATE_MISSING; unconfirmed blocks a write and only warns in a preview [C2-M3]', () => {
  const chain = base({ supplier_cost: '100', supplier_currency: 'EUR', shipping_weight_g: 1000 });
  for (const fx of [rate(null), rate('0'), rate('0.000')]) {
    const r = price({ chain, rates: withRates({ fx: { EUR: fx } }) });
    assertWellFormed(r);
    assert.deepEqual(codes(r), ['FX_RATE_MISSING']);
    assert.equal(r.issues[0].currency, 'EUR');
  }
  const noShip = price({ chain, rates: withRates({ shipping: { CHINA_AIR: rate('0') } }) });
  assert.deepEqual(codes(noShip), ['SHIPPING_RATE_MISSING']);
  assert.equal(noShip.issues[0].profile, 'CHINA_AIR');
  const absentRow = price({ chain, rates: { fx: {}, shipping: {} } });
  assert.deepEqual(codes(absentRow), ['FX_RATE_MISSING', 'SHIPPING_RATE_MISSING']);

  const unconfirmed = withRates({ fx: { EUR: rate('1626.25', false) }, shipping: { CHINA_AIR: rate('12500', false) } });
  const write = price({ chain, rates: unconfirmed });
  assertWellFormed(write);
  assert.deepEqual(codes(write), ['FX_RATE_UNCONFIRMED', 'SHIPPING_RATE_UNCONFIRMED']);
  assert.equal(write.channels.length, 0, 'an unconfirmed rate never produces a price to write');
  const preview = price({ chain, rates: unconfirmed, allowUnconfirmedRates: true });
  assert.equal(preview.channels.length, 1);
  assert.ok(preview.issues.every((i) => i.severity === 'warning'));
  assert.equal(preview.ok, true);
});

test('rules: missing or BLOCKED target stops every channel; the premium only matters for direct_sale; PREMIUM_NOT_ON_STEP [C2-M5]', () => {
  const chain = base({ supplier_cost: '500', supplier_currency: 'USD', shipping_weight_g: 1000, shipping_profile: 'CHINA_AIR' });
  const input = { chain, rates: RATES, channels: ['direct_sale', 'pre_order_air', 'pre_order_land'] as SkuChannel[] };
  const missing = priceSku({ ...input, target: { status: 'missing', kind: 'target_profit', code: 'TARGET_PROFIT_MISSING' }, premium: P(50_000) });
  assertWellFormed(missing);
  assert.deepEqual(missing.channels, []);
  for (const c of input.channels) assert.deepEqual(codes(missing, c), ['TARGET_PROFIT_MISSING']);
  const blocked = priceSku({
    ...input,
    target: { status: 'blocked', kind: 'target_profit', code: 'TARGET_PROFIT_BLOCKED', rule: { id: 'b', version: 1, scope: 'product', scope_id: '', catalog_id: null } },
  });
  assert.deepEqual(codes(blocked, 'pre_order_air'), ['TARGET_PROFIT_BLOCKED']);

  const noPremium = priceSku({ ...input, target: T(200_000) });
  assert.deepEqual(codes(noPremium), ['DIRECT_PREMIUM_MISSING']);
  assert.deepEqual(noPremium.channels.map((c) => c.channel), ['pre_order_air', 'pre_order_land'], 'pre-order channels still priced');
  assert.equal(noPremium.issues[0].channel, 'direct_sale');

  const offStep = priceSku({ ...input, target: T(200_000), premium: P(50_500) });
  assert.deepEqual(codes(offStep, 'direct_sale'), ['PREMIUM_NOT_ON_STEP']);
  const stepChange = priceSku({ ...input, target: T(200_000), premium: P(1_000), step: 5_000 });
  assert.deepEqual(codes(stepChange, 'direct_sale'), ['PREMIUM_NOT_ON_STEP'], 'a step change never silently rounds an old premium');
  assert.equal(channel(stepChange, 'pre_order_air').computed_price_iqd % 5_000, 0);

  const zero = priceSku({ ...input, target: T(200_000), premium: P(0) });
  assert.equal(channel(zero, 'direct_sale').computed_price_iqd, channel(zero, 'pre_order_air').computed_price_iqd, 'a premium of 0 is a real value');
  assert.equal(channel(zero, 'direct_sale').direct_premium_iqd, 0);
  // A hand-built resolution with an amount the CHECKs refuse fails closed.
  const bad = priceSku({ ...input, target: T(0), premium: P(-1000) });
  assert.deepEqual(codes(bad, 'direct_sale'), ['DIRECT_PREMIUM_BLOCKED', 'TARGET_PROFIT_BLOCKED']);
  const tie: RuleResolution = { ...(T(250_000) as Extract<RuleResolution, { status: 'active' }>), tie: true };
  const tied = priceSku({ ...input, target: tie, premium: P(0) });
  assert.equal(tied.ok, true, 'RULE_TIE is a warning');
  assert.deepEqual(tied.issues.map((i) => [i.code, i.severity]), [['RULE_TIE', 'warning']]);
  assert.equal(channel(tied, 'pre_order_air').target_profit_iqd, 250_000);
  assert.equal(channel(tied, 'pre_order_air').target_rule_version, 3);
});

test('direct_sale needs the default profile; AMOUNT_TOO_LARGE; channels are de-duplicated', () => {
  const noProfile = priceSku({
    chain: base({ supplier_cost: '500', supplier_currency: 'USD', shipping_weight_g: 1000 }),
    rates: RATES,
    channels: ['direct_sale', 'pre_order_air'],
    target: T(200_000),
    premium: P(50_000),
  });
  assertWellFormed(noProfile);
  assert.deepEqual(codes(noProfile, 'direct_sale'), ['SHIPPING_PROFILE_MISSING']);
  assert.equal(noProfile.channels.length, 1);
  const seaDirect = priceSku({
    chain: base({ supplier_cost: '500', supplier_currency: 'USD', shipping_profile: 'CHINA_SEA', manual_cbm: '0.5' }),
    rates: RATES,
    channels: ['direct_sale', 'direct_sale'],
    target: T(200_000),
    premium: P(50_000),
  });
  assert.equal(seaDirect.channels.length, 1);
  assert.equal(channel(seaDirect, 'direct_sale').shipping_basis, 'volume');
  assert.equal(channel(seaDirect, 'direct_sale').effective_cbm, '0.5');

  const huge = price({ chain: base({ supplier_cost: '99999999999', supplier_currency: 'USD', shipping_weight_g: 1000 }) });
  assertWellFormed(huge);
  assert.deepEqual(codes(huge), ['AMOUNT_TOO_LARGE']);
  const borderline = price({
    chain: base({ supplier_cost: String(Math.floor((MAX_FINAL_PRICE_IQD - 300_000) / 1500)), supplier_currency: 'USD', shipping_weight_g: 1 }),
  });
  assert.equal(borderline.ok, true);
  assert.ok(channel(borderline, 'pre_order_air').computed_price_iqd <= MAX_FINAL_PRICE_IQD);
  assert.equal(ENGINE_MAX_SKUS, 240);
});

/* ----------------------------------------------- effective weight [G10] -- */

test('effective weight [C1-G10]: pricing ?? shipping per level, MANUAL before SOURCE, most specific level first, unresolved never inherits', () => {
  const sup = { supplier_cost: '100', supplier_currency: 'USD' as const };
  const w = (chain: SkuInputChain) => resolveSkuInputs(chain).inputs.weight;
  assert.deepEqual(w(base({ ...sup, pricing_weight_g: 18_000, shipping_weight_g: 20_000 })), {
    value: 18_000, origin: 'SOURCE', level: 'base', scope_id: '', field: 'pricing_weight_g',
  });
  assert.equal(w(base({ ...sup, shipping_weight_g: 20_000 }, { shipping_weight_g: 21_000 }))?.value, 21_000);
  assert.equal(w(base({ ...sup, shipping_weight_g: 20_000 }, { shipping_weight_g: 21_000 }))?.origin, 'MANUAL_OVERRIDE');
  assert.equal(w(base({ ...sup, shipping_weight_g: 20_000 }, { pricing_weight_g: 19_000 }))?.field, 'pricing_weight_g');
  // A packed weight stated on the SKU beats a pricing weight stated on the product.
  const sku = w({ base: { source: { ...sup, pricing_weight_g: 15_000 } }, sku: { scope_id: 'o:a', source: { shipping_weight_g: 22_500 } } });
  assert.deepEqual([sku?.value, sku?.level, sku?.field], [22_500, 'sku', 'shipping_weight_g']);

  // Unresolved at the option level: the product's 15 kg is NOT used for this SKU.
  const chain: SkuInputChain = {
    base: { source: { ...sup, shipping_weight_g: 15_000, manual_cbm: '0.2' } },
    options: [{ scope_id: 'ov_combo', source: { unresolved_fields: ['shipping_weight_g'] } }],
  };
  const r = priceSku({ chain, rates: RATES, channels: ['pre_order_air', 'pre_order_sea'], target: T(100_000) });
  assertWellFormed(r);
  assert.deepEqual(codes(r, 'pre_order_air'), ['SHIPPING_FIELD_UNRESOLVED']);
  assert.deepEqual(r.issues[0].scope_ids, ['ov_combo']);
  assert.equal(r.issues[0].level, 'option');
  assert.equal(channel(r, 'pre_order_sea').effective_cbm, '0.2', 'a volume channel is not held by a weight problem');
  // The owner's MANUAL_OVERRIDE at that level resolves it.
  const fixed: SkuInputChain = { ...chain, options: [{ scope_id: 'ov_combo', source: { unresolved_fields: ['shipping_weight_g'] }, override: { shipping_weight_g: 22_000 } }] };
  assert.equal(channel(priceSku({ chain: fixed, rates: RATES, channels: ['pre_order_air'], target: T(100_000) }), 'pre_order_air').effective_weight_g, 22_000);
  // Two option groups disagreeing on weight is a conflict, never a guess.
  const conflict = price({
    chain: { base: { source: sup }, options: [{ scope_id: 'a', source: { shipping_weight_g: 1000 } }, { scope_id: 'b', source: { shipping_weight_g: 1200 } }] },
  });
  assert.deepEqual(codes(conflict), ['INPUT_CONFLICT']);
  assert.equal(conflict.issues[0].field, 'shipping_weight_g');
  // Two groups stating the same weight agree.
  assert.equal(
    w({ base: { source: sup }, options: [{ scope_id: 'a', source: { shipping_weight_g: 1000 } }, { scope_id: 'b', override: { pricing_weight_g: 1000 } }] })?.value,
    1000
  );
});

/* ---------------------------------------------------- box and CBM vectors -- */

test('box vectors [L2-1a][L2-1b][LD6]: atomic box, most specific deciding level, manual wins, no axis mixing', () => {
  const sup = { supplier_cost: '3200', supplier_currency: 'CNY' as const };
  const fullBox = { shipping_length_mm: 600, shipping_width_mm: 500, shipping_height_mm: 450 };
  const sea = (chain: SkuInputChain, channels: SkuChannel[] = ['pre_order_sea']) => {
    const r = priceSku({ chain, rates: RATES, channels, target: T(150_000) });
    assertWellFormed(r);
    return r;
  };

  // 1. Atomic box: an option stating only a length does NOT borrow the product's width and height.
  const partial = sea({ base: { source: { ...sup, ...fullBox, shipping_weight_g: 5000 } }, options: [{ scope_id: 'ov_combo', source: { shipping_length_mm: 700 } }] }, ['pre_order_sea', 'pre_order_air']);
  assert.deepEqual(codes(partial, 'pre_order_sea'), ['CBM_MISSING']);
  assert.equal(partial.issues[0].level, 'option');
  assert.equal(partial.issues[0].field, 'shipping_box');
  assert.equal(channel(partial, 'pre_order_air').effective_weight_g, 5000, 'weight channels are unaffected');

  // 2. A less specific manual CBM never beats a more specific complete box.
  const specific = sea({ base: { source: { ...sup, manual_cbm: '0.2' } }, options: [{ scope_id: 'ov_combo', source: fullBox }] });
  const s = channel(specific, 'pre_order_sea');
  assert.deepEqual([s.effective_cbm, s.shipping_cbm, s.manual_cbm], ['0.135', '0.135', null]);
  assert.equal(specific.inputs.cbm?.level, 'option');
  assert.equal(specific.inputs.cbm?.from, 'calculated');

  // 3. At one level, manual wins over the box (LD6) and the calculated value is kept for display.
  const same = channel(sea({ base: { source: sup }, options: [{ scope_id: 'ov_combo', source: { ...fullBox, manual_cbm: '0.1420' } }] }), 'pre_order_sea');
  assert.deepEqual([same.effective_cbm, same.shipping_cbm, same.manual_cbm], ['0.142', '0.135', '0.142']);

  // 4. A manual CBM at a more specific level beats a less specific box.
  const skuManual = sea({ base: { source: { ...sup, ...fullBox } }, sku: { scope_id: 'o:ov_combo', source: { manual_cbm: '0.1' } } });
  assert.deepEqual([skuManual.inputs.cbm?.level, skuManual.inputs.cbm?.effective, skuManual.inputs.cbm?.calculated], ['sku', '0.1', null]);
  assert.equal(channel(skuManual, 'pre_order_sea').shipping_cost_iqd, 45_000);

  // 5. An override box replaces the source box WHOLE; an override with one axis is partial, never mixed.
  const overrideBox = sea(base({ ...sup, ...fullBox }, { shipping_length_mm: 700, shipping_width_mm: 500, shipping_height_mm: 450 }));
  assert.deepEqual([overrideBox.inputs.cbm?.effective, overrideBox.inputs.cbm?.box?.origin], ['0.1575', 'MANUAL_OVERRIDE']);
  const overrideAxis = sea(base({ ...sup, ...fullBox }, { shipping_length_mm: 700 }));
  assert.deepEqual(codes(overrideAxis), ['CBM_MISSING']);

  // 6. A box marked unresolved at a level does not inherit the product's box …
  const unresolved = sea({ base: { source: { ...sup, ...fullBox } }, options: [{ scope_id: 'ov_combo', source: { unresolved_fields: ['shipping_box'] } }] });
  assert.deepEqual(codes(unresolved), ['SHIPPING_FIELD_UNRESOLVED']);
  assert.equal(unresolved.issues[0].field, 'shipping_box');
  const axisMarked = sea({ base: { source: { ...sup, ...fullBox } }, options: [{ scope_id: 'ov_combo', source: { unresolved_fields: ['shipping_width_mm'] } }] });
  assert.deepEqual(codes(axisMarked), ['SHIPPING_FIELD_UNRESOLVED'], 'one axis marks the whole box');
  // … but the owner's manual CBM at that level decides (manual always wins).
  const resolved = sea({
    base: { source: { ...sup, ...fullBox } },
    options: [{ scope_id: 'ov_combo', source: { unresolved_fields: ['shipping_box'] }, override: { manual_cbm: '0.3' } }],
  });
  assert.equal(channel(resolved, 'pre_order_sea').effective_cbm, '0.3');
  const manualUnresolved = sea({ base: { source: { ...sup, ...fullBox } }, options: [{ scope_id: 'ov_combo', source: { unresolved_fields: ['manual_cbm'] } }] });
  assert.deepEqual(codes(manualUnresolved), ['SHIPPING_FIELD_UNRESOLVED']);
  assert.equal(manualUnresolved.issues[0].field, 'manual_cbm');

  // 7. Two option groups with different boxes conflict; the same box agrees.
  const conflict = sea({ base: { source: sup }, options: [{ scope_id: 'a', source: fullBox }, { scope_id: 'b', source: { ...fullBox, shipping_height_mm: 451 } }] });
  assert.deepEqual(codes(conflict), ['INPUT_CONFLICT']);
  assert.equal(conflict.issues[0].field, 'shipping_box');
  const agree = sea({ base: { source: sup }, options: [{ scope_id: 'a', source: fullBox }, { scope_id: 'b', source: { manual_cbm: '0.135' } }] });
  assert.equal(channel(agree, 'pre_order_sea').effective_cbm, '0.135');

  // 8. Calculated CBM is exact: 333³ mm³ = 0.036926037 m³; freight 0.036926037 × 450,000 = 16,616.71665.
  const odd = channel(sea(base({ ...sup, shipping_length_mm: 333, shipping_width_mm: 333, shipping_height_mm: 333 })), 'pre_order_sea');
  assert.equal(odd.shipping_cbm, '0.036926037');
  assert.equal(odd.shipping_cost_exact, '16616.71665');
  assert.equal(odd.replacement_cost_iqd, 752_000 + 16_617);

  // 9. Nothing anywhere → CBM_MISSING; an invalid manual CBM decides its level (no fallback).
  assert.deepEqual(codes(sea(base(sup))), ['CBM_MISSING']);
  const invalidManual = sea({ base: { source: { ...sup, manual_cbm: '0.2' } }, sku: { scope_id: 'k', source: { manual_cbm: '0' } } });
  assert.deepEqual(codes(invalidManual), ['CBM_MISSING']);
  assert.equal(invalidManual.issues[0].level, 'sku');
});

test('replacementCost alone (the switch preview) uses the same maths and the same codes', () => {
  const resolved = resolveSkuInputs(base({ supplier_cost: '855', supplier_currency: 'EUR', shipping_weight_g: 22_300, additional_cost_iqd: 15_000 }));
  const r = replacementCost(resolved, 'GERMANY_LAND', RATES);
  assert.ok(r.ok);
  assert.equal(r.cost.replacement_cost_iqd, 1_538_129);
  assert.equal(r.cost.replacement_exact, '1538128.75');
  const sea = replacementCost(resolved, 'CHINA_SEA', RATES);
  assert.ok(!sea.ok);
  assert.deepEqual(sea.issues.map((i) => i.code), ['CBM_MISSING']);
  const unconfirmed = replacementCost(resolved, 'GERMANY_LAND', withRates({ fx: { EUR: rate('1626.25', false) } }), { allowUnconfirmedRates: true });
  assert.ok(unconfirmed.ok);
  assert.deepEqual(unconfirmed.warnings.map((i) => i.code), ['FX_RATE_UNCONFIRMED']);
});

/* -------------------------------------------- review findings (E1 fixes) -- */

test('[C1-G24] a zero supplier cost at ANY level is missing: a placeholder 0 never becomes the base for differences', () => {
  const ok = { shipping_weight_g: 1000, manual_cbm: '0.1' };
  for (const zero of ['0', '0.000']) {
    const option = price({ chain: { base: { source: { supplier_cost: zero, supplier_currency: 'EUR', ...ok } }, options: [{ scope_id: 'o1', source: { supplier_cost_delta: '+80' } }] } });
    assertWellFormed(option);
    assert.equal(option.ok, false, `${zero} + 80 must not price`);
    assert.deepEqual(codes(option), ['SUPPLIER_COST_MISSING']);
    assert.equal(option.issues[0].level, 'base');
    assert.deepEqual(option.issues[0].scope_ids, ['']);
    const colour = price({ chain: { base: { source: { supplier_cost: zero, supplier_currency: 'EUR', ...ok } }, color: { scope_id: 'c', override: { supplier_cost_delta: '5' } } } });
    assert.deepEqual(codes(colour), ['SUPPLIER_COST_MISSING']);
    assert.equal(colour.inputs.supplier, null);
  }
  // A zero on a more specific level is missing there too, even with a real base below it.
  const sku = price({ chain: { base: { source: { supplier_cost: '500', supplier_currency: 'EUR', ...ok } }, sku: { scope_id: 'k', override: { supplier_cost: '0' } } } });
  assert.deepEqual(codes(sku), ['SUPPLIER_COST_MISSING']);
  assert.equal(sku.issues[0].level, 'sku');
  // A zero DIFFERENCE is a real (empty) difference.
  const zeroDelta = price({ chain: { base: { source: { supplier_cost: '500', supplier_currency: 'EUR', ...ok } }, color: { scope_id: 'c', source: { supplier_cost_delta: '0' } } } });
  assert.equal(zeroDelta.ok, true);
  assert.equal(zeroDelta.inputs.supplier?.amount, '500');
});

test('a SOURCE unresolved mark beats its own row\'s value (box included) but never the owner\'s MANUAL_OVERRIDE at that level', () => {
  const sup = { supplier_cost: '3200', supplier_currency: 'CNY' as const };
  const fullBox = { shipping_length_mm: 600, shipping_width_mm: 500, shipping_height_mm: 450 };
  const run = (chain: SkuInputChain, channels: SkuChannel[]) => {
    const r = priceSku({ chain, rates: RATES, channels, target: T(150_000) });
    assertWellFormed(r);
    return r;
  };
  // The box on the same SOURCE row as its own mark: unresolved, like weight and manual CBM.
  for (const mark of ['shipping_box', 'shipping_length_mm']) {
    const boxed = run(base({ ...sup, ...fullBox, unresolved_fields: [mark] }), ['pre_order_sea']);
    assert.deepEqual(codes(boxed), ['SHIPPING_FIELD_UNRESOLVED'], mark);
    assert.equal(boxed.issues[0].field, 'shipping_box');
    assert.equal(boxed.inputs.cbm, null);
  }
  const ownWeight = run(base({ ...sup, shipping_weight_g: 5000, unresolved_fields: ['shipping_weight_g'] }), ['pre_order_air']);
  assert.deepEqual(codes(ownWeight), ['SHIPPING_FIELD_UNRESOLVED']);
  const ownManual = run(base({ ...sup, manual_cbm: '0.2', unresolved_fields: ['manual_cbm'] }), ['pre_order_sea']);
  assert.deepEqual(codes(ownManual), ['SHIPPING_FIELD_UNRESOLVED']);

  // Weight: SOURCE marks the pricing weight; the owner's manual shipping weight decides.
  const weight = run(
    { base: { source: { ...sup, shipping_weight_g: 15_000 } }, options: [{ scope_id: 'ov', source: { unresolved_fields: ['pricing_weight_g'] }, override: { shipping_weight_g: 22_000 } }] },
    ['pre_order_air']
  );
  assert.equal(channel(weight, 'pre_order_air').effective_weight_g, 22_000);
  assert.deepEqual([weight.inputs.weight?.origin, weight.inputs.weight?.level, weight.inputs.weight?.field], ['MANUAL_OVERRIDE', 'option', 'shipping_weight_g']);
  // The MANUAL row's pair decides whole: its shipping weight beats a SOURCE pricing weight.
  const pair = resolveSkuInputs(base({ ...sup, pricing_weight_g: 18_000 }, { shipping_weight_g: 21_000 })).inputs.weight;
  assert.deepEqual([pair?.value, pair?.origin], [21_000, 'MANUAL_OVERRIDE']);

  // CBM: SOURCE marks manual CBM and the box; the owner's full box decides.
  const cbm = run(
    { base: { source: { ...sup, ...fullBox } }, options: [{ scope_id: 'ov', source: { unresolved_fields: ['manual_cbm', 'shipping_box'] }, override: { shipping_length_mm: 700, shipping_width_mm: 500, shipping_height_mm: 450 } }] },
    ['pre_order_sea']
  );
  assert.deepEqual([cbm.inputs.cbm?.effective, cbm.inputs.cbm?.from, cbm.inputs.cbm?.box?.origin, cbm.inputs.cbm?.level], ['0.1575', 'calculated', 'MANUAL_OVERRIDE', 'option']);
  // A partial owner box is still never completed (fail closed), mark or not.
  const partial = run({ base: { source: { ...sup, ...fullBox } }, options: [{ scope_id: 'ov', source: { unresolved_fields: ['shipping_box'] }, override: { shipping_length_mm: 700 } }] }, ['pre_order_sea']);
  assert.deepEqual(codes(partial), ['CBM_MISSING']);
  // LD6 at one level: a SOURCE manual CBM wins over an override box ("manual CBM always wins").
  const ld6 = resolveSkuInputs(base({ ...sup, manual_cbm: '0.2' }, { shipping_length_mm: 700, shipping_width_mm: 500, shipping_height_mm: 450 })).inputs.cbm;
  assert.deepEqual([ld6?.effective, ld6?.from, ld6?.manual_origin, ld6?.calculated], ['0.2', 'manual', 'SOURCE', '0.1575']);
  // A box the SOURCE calls unresolved is not shown beside a manual CBM either.
  const shown = resolveSkuInputs(base({ ...sup, ...fullBox, unresolved_fields: ['shipping_box'] }, { manual_cbm: '0.3' })).inputs.cbm;
  assert.deepEqual([shown?.effective, shown?.box, shown?.calculated], ['0.3', null, null]);
});

test('priceSku refuses swapped rule resolutions (a premium priced as the profit is a programming error)', () => {
  const chain = base({ supplier_cost: '500', supplier_currency: 'USD', shipping_weight_g: 1000, shipping_profile: 'CHINA_AIR' });
  const input = { chain, rates: RATES, channels: ['direct_sale', 'pre_order_air'] as SkuChannel[] };
  assert.throws(() => priceSku({ ...input, target: P(50_000), premium: T(200_000) }), /PRICING_INVARIANT/);
  assert.throws(() => priceSku({ ...input, target: T(200_000), premium: T(50_000) }), /PRICING_INVARIANT/);
  assert.throws(() => priceSku({ ...input, target: { status: 'missing', kind: 'direct_premium', code: 'DIRECT_PREMIUM_MISSING' } }), /PRICING_INVARIANT/);
  assert.equal(priceSku({ ...input, target: T(200_000), premium: P(50_000) }).ok, true);
});

test('the public price helpers: never a negative replacement, never a price below one step, never a float', () => {
  assert.throws(() => preorderPrice(-250_000, 200_000), RangeError);
  assert.throws(() => preorderPrice(-1000, 1000), RangeError);
  assert.throws(() => preorderPrice('-0.01', 1000), RangeError);
  assert.equal(preorderPrice(0, 1), 1000, 'a zero replacement still prices at least one step');
  assert.throws(() => directPrice(-5000, 1000), RangeError);
  assert.throws(() => directPrice(0, 0), RangeError, 'a base of 0 is no price');
  assert.equal(directPrice(1000, 0), 1000);
  assert.throws(() => ceilStep(1000.0000000000001), RangeError, 'a fractional JS number is refused, not rounded');
  assert.throws(() => preorderPrice(0.1 + 0.2, 1000), RangeError);
  assert.throws(() => preorderPrice(873_419.5, 200_000), RangeError);
  assert.equal(preorderPrice('873419.5', 200_000), 1_074_000, 'decimals arrive as text, exact');
  assert.equal(preorderPrice({ num: 8_734_195n, den: 10n }, 200_000), 1_074_000);
  assert.throws(() => preorderPrice({ num: 1n, den: 0n }, 1000), RangeError);
  assert.throws(() => preorderPrice(800_000, 1.5), RangeError);
  assert.equal(preorderPrice(800_000n, 200_000), 1_000_000);
});

test('bad caller data fails closed with the right code: a repeated option row, an out-of-range additional cost, CHECK-refused decimals', () => {
  const sup = { supplier_cost: '100', supplier_currency: 'USD' as const, shipping_weight_g: 1000, shipping_profile: 'CHINA_AIR' as const };
  const twice = priceSku({
    chain: { base: { source: sup }, options: [{ scope_id: 'a', source: { supplier_cost_delta: '+80' } }, { scope_id: 'a', source: { supplier_cost_delta: '+80' } }] },
    rates: RATES,
    channels: SKU_CHANNELS,
    target: T(200_000),
    premium: P(0),
  });
  assertWellFormed(twice);
  assert.deepEqual(twice.channels, [], 'never 260 USD: the same option value is not counted twice');
  for (const c of SKU_CHANNELS) assert.ok(codes(twice, c).includes('INPUT_CONFLICT'), c);
  assert.deepEqual(twice.issues.find((i) => i.code === 'INPUT_CONFLICT')?.scope_ids, ['a']);
  assert.equal(twice.issues.find((i) => i.code === 'INPUT_CONFLICT')?.level, 'option');
  const distinct = price({ chain: { base: { source: sup }, options: [{ scope_id: 'a', source: { supplier_cost_delta: '+80' } }, { scope_id: 'b' }] } });
  assert.equal(distinct.inputs.supplier?.amount, '180');

  for (const bad of [-5, 1.5, 1_000_000_001]) {
    const r = price({ chain: base({ ...sup, additional_cost_iqd: bad }) });
    assertWellFormed(r);
    assert.deepEqual(codes(r), ['AMOUNT_TOO_LARGE'], String(bad));
    assert.equal(r.issues[0].field, 'additional_cost_iqd', 'the issue names the field that holds the bad amount');
    assert.equal(r.issues[0].level, 'base');
  }

  // Decimals the 0179 CHECKs refuse are never priced, wherever they appear.
  for (const cost of ['1e3', '.5', '5.', '+500', ' ', '1,5']) {
    assert.deepEqual(codes(price({ chain: base({ ...sup, supplier_cost: cost }) })), ['SUPPLIER_COST_MISSING'], cost);
  }
  assert.deepEqual(codes(price({ chain: { base: { source: sup }, color: { scope_id: 'c', source: { supplier_cost_delta: '5e1' } } } })), ['SUPPLIER_COST_MISSING']);
  assert.deepEqual(codes(price({ chain: base({ ...sup, supplier_cost: 500 as unknown as string }) })), ['SUPPLIER_COST_MISSING'], 'a decimal column is TEXT');
  const sea = (manual: string) => priceSku({ chain: base({ ...sup, manual_cbm: manual }), rates: RATES, channels: ['pre_order_sea'], target: T(1_000) });
  for (const manual of ['.2', '2e-1', '0.2.0']) assert.deepEqual(codes(sea(manual)), ['CBM_MISSING'], manual);
  for (const r of ['1e3', '.5', '-1500']) assert.deepEqual(codes(price({ chain: base(sup), rates: withRates({ fx: { USD: rate(r) } }) })), ['FX_RATE_MISSING'], r);
});

test('property: 20,000 random SKUs with measures on every level — the most specific level decides; prices are monotone in rates and target (ENG T1)', () => {
  const rnd = prng(0x1e7e15);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const decimal = (lo: number, hi: number, maxPlaces: number) => {
    const places = int(0, maxPlaces);
    const frac = places ? `.${Array.from({ length: places }, () => int(0, 9)).join('')}` : '';
    return `${int(lo, hi)}${frac}`;
  };
  const LEVELS = ['base', 'option', 'color', 'sku'] as const;
  type Level = (typeof LEVELS)[number];
  const ROWS: Record<Level, readonly string[]> = { base: ['base'], option: ['o1', 'o2'], color: ['c1'], sku: ['sku'] };
  const CHANNELS: SkuChannel[] = ['pre_order_air', 'pre_order_sea', 'pre_order_land'];
  const priceOf = (r: SkuPricingResult, c: SkuChannel) => r.channels.find((x) => x.channel === c)?.computed_price_iqd;
  let weightPriced = 0, volumePriced = 0;

  for (let i = 0; i < 20_000; i++) {
    const rows: Record<string, { source: PricingInputRow; override: PricingInputRow }> = {};
    for (const id of Object.values(ROWS).flat()) rows[id] = { source: {}, override: {} };
    const currency: SupplierCurrency = (['USD', 'EUR', 'CNY'] as const)[int(0, 2)];
    const supplierText = decimal(1, 99_999, 4);
    rows.base.source.supplier_cost = supplierText;
    rows.base.source.supplier_currency = currency;
    const deciding = (level: Level) => (level === 'option' ? (rnd() < 0.3 ? ['o1', 'o2'] : [rnd() < 0.5 ? 'o1' : 'o2']) : ROWS[level]);

    // Weight on random levels; each placement may carry a decoy the resolution order must ignore.
    const weightAt: Partial<Record<Level, number>> = {};
    for (const level of LEVELS) {
      if (rnd() >= 0.4) continue;
      const grams = int(1, 200_000);
      const viaOverride = rnd() < 0.5;
      const field = rnd() < 0.5 ? 'pricing_weight_g' : 'shipping_weight_g';
      for (const id of deciding(level)) {
        if (viaOverride) {
          rows[id].override[field] = grams;
          if (rnd() < 0.5) rows[id].source[rnd() < 0.5 ? 'pricing_weight_g' : 'shipping_weight_g'] = int(1, 200_000); // the MANUAL row decides whole
        } else {
          rows[id].source[field] = grams;
          if (field === 'pricing_weight_g' && rnd() < 0.5) rows[id].source.shipping_weight_g = int(1, 200_000); // pricing ?? shipping
        }
      }
      weightAt[level] = grams;
    }

    // CBM on random levels: manual (MANUAL or SOURCE) or a whole box (MANUAL or SOURCE), with decoys.
    const cbmAt: Partial<Record<Level, Q>> = {};
    for (const level of LEVELS) {
      if (rnd() >= 0.4) continue;
      const kind = int(0, 3);
      const manualText = `${int(0, 9)}.${String(int(1, 999_999)).padStart(6, '0')}`;
      const box = { shipping_length_mm: int(1, 2500), shipping_width_mm: int(1, 2500), shipping_height_mm: int(1, 2500) };
      const decoyBox = { shipping_length_mm: int(1, 2500), shipping_width_mm: int(1, 2500), shipping_height_mm: int(1, 2500) };
      for (const id of deciding(level)) {
        const { source, override } = rows[id];
        if (kind === 0) {
          override.manual_cbm = manualText; // beats everything at its level
          if (rnd() < 0.5) Object.assign(rnd() < 0.5 ? source : override, decoyBox);
          if (rnd() < 0.3) source.manual_cbm = `${int(0, 9)}.5`;
        } else if (kind === 1) {
          source.manual_cbm = manualText; // LD6: beats any box at its level, the override's too
          if (rnd() < 0.5) Object.assign(rnd() < 0.5 ? source : override, decoyBox);
        } else if (kind === 2) {
          Object.assign(override, box); // the owner's box replaces the SOURCE box whole
          if (rnd() < 0.5) Object.assign(source, decoyBox);
        } else {
          Object.assign(source, box);
        }
      }
      cbmAt[level] = kind <= 1 ? q(manualText) : qDiv(qInt(BigInt(box.shipping_length_mm) * BigInt(box.shipping_width_mm) * BigInt(box.shipping_height_mm)), 1_000_000_000n);
    }

    const chain: SkuInputChain = {
      base: { source: rows.base.source, override: rows.base.override },
      options: [{ scope_id: 'o1', ...rows.o1 }, { scope_id: 'o2', ...rows.o2 }],
      color: { scope_id: 'c1', ...rows.c1 },
      sku: { scope_id: 'o:o1|o:o2|c:c1', ...rows.sku },
    };
    const fxText = decimal(1, 20_000, 6);
    const shipTexts: Record<ShippingProfile, string> = { CHINA_AIR: decimal(1, 30_000, 3), GERMANY_LAND: decimal(1, 30_000, 3), CHINA_SEA: decimal(1, 900_000, 3) };
    const ratesOf = (fx: string, ship: Record<ShippingProfile, string>): CentralRates => ({
      fx: { [currency]: rate(fx) },
      shipping: { CHINA_AIR: rate(ship.CHINA_AIR), GERMANY_LAND: rate(ship.GERMANY_LAND), CHINA_SEA: rate(ship.CHINA_SEA) },
    });
    const target = int(1, 2_000_000);
    const run = (fx: string, ship: Record<ShippingProfile, string>, t: number) => priceSku({ chain, rates: ratesOf(fx, ship), channels: CHANNELS, target: T(t) });
    const r = run(fxText, shipTexts, target);
    assertWellFormed(r);

    // The oracle: the most specific level decides each measure.
    const mostSpecific = <V>(at: Partial<Record<Level, V>>) => [...LEVELS].reverse().map((l) => at[l]).find((v) => v !== undefined);
    const grams = mostSpecific(weightAt);
    const cbm = mostSpecific(cbmAt);
    const S = qMul(q(supplierText), q(fxText));
    for (const c of CHANNELS) {
      const profile = profileOfChannel(c, null)!;
      const measure = PROFILE_BASIS[profile] === 'weight' ? (grams === undefined ? undefined : qDiv(qInt(grams), 1000n)) : cbm;
      if (measure === undefined) {
        assert.deepEqual(codes(r, c), [PROFILE_BASIS[profile] === 'weight' ? 'WEIGHT_MISSING' : 'CBM_MISSING'], `#${i} ${c}`);
        continue;
      }
      const Rx = qAdd(S, qMul(q(shipTexts[profile]), measure));
      const got = channel(r, c);
      assert.equal(qCmp(q(got.replacement_exact), Rx), 0, `#${i} ${c} R_exact`);
      assert.equal(BigInt(got.computed_price_iqd), qCeil(qDiv(qAdd(Rx, qInt(target)), 1000n)) * 1000n, `#${i} ${c} price`);
      if (PROFILE_BASIS[profile] === 'weight') {
        assert.equal(got.effective_weight_g, grams, `#${i} ${c} weight`);
        weightPriced++;
      } else {
        assert.equal(qCmp(q(got.effective_cbm!), cbm!), 0, `#${i} ${c} cbm`);
        volumePriced++;
      }
    }

    // Monotone: a higher FX or shipping rate never lowers a price; target +Δ moves it by Δ ± (step − 1).
    const plus = (a: string, b: string) => procurementExactText(addProcurementExact(procurementExact(a), procurementExact(b)));
    const fxUp = run(plus(fxText, decimal(0, 5_000, 3)), shipTexts, target);
    const bumped = SHIPPING_PROFILES[int(0, 2)];
    const shipUp = run(fxText, { ...shipTexts, [bumped]: plus(shipTexts[bumped], decimal(0, 50_000, 3)) }, target);
    const delta = int(1, 300_000);
    const targetUp = run(fxText, shipTexts, target + delta);
    for (const c of r.channels.map((x) => x.channel)) {
      const before = priceOf(r, c)!;
      assert.ok(priceOf(fxUp, c)! >= before, `#${i} ${c}: FX up never lowers the price`);
      const shipAfter = priceOf(shipUp, c)!;
      if (profileOfChannel(c, null) === bumped) assert.ok(shipAfter >= before, `#${i} ${c}: its shipping rate up never lowers the price`);
      else assert.equal(shipAfter, before, `#${i} ${c}: another profile's rate leaves it unchanged`);
      const moved = priceOf(targetUp, c)! - before;
      assert.ok(moved >= delta - 999 && moved <= delta + 999, `#${i} ${c}: target +${delta} moved the price by ${moved}`);
    }
  }
  assert.ok(weightPriced > 10_000 && volumePriced > 5_000, `enough priced cases (${weightPriced} weight, ${volumePriced} volume)`);
});

/* ---------------------------------------------------- exact arithmetic -- */

test('contracts exact rationals: parse, add, multiply, divide, ceil, compare, canonical text', () => {
  const x = (v: string | number | bigint, signed = false) => procurementExact(v, { signed });
  assert.equal(procurementExactText(mulProcurementExact(x('0.07'), x('100'))), '7');
  assert.equal(procurementExactText(mulProcurementExact(x('855'), x('1626.25'))), '1390443.75');
  assert.equal(procurementExactText(x('1500.0')), '1500');
  // The low-level reader keeps rational()'s legacy tolerance; untrusted text goes
  // through parseProcurementDecimal first (below), and the engine does so for every input.
  assert.equal(procurementExactText(x('+0.50')), '0.5');
  assert.equal(procurementExactText(x('.5')), '0.5');
  assert.equal(procurementExactText(x('1e3')), '1000');
  assert.throws(() => x(0.5), RangeError, 'a fractional JS number is a float: refused');
  assert.throws(() => x(0.1 + 0.2), RangeError);
  assert.throws(() => x(Number.NaN), RangeError);
  assert.equal(procurementExactText(x(-7, true)), '-7');
  assert.equal(procurementExactText(x(0)), '0');
  assert.equal(procurementExactText(x('-3', true)), '-3');
  assert.equal(procurementExactText(addProcurementExact(x('500'), x('-500.01', true))), '-0.01');
  assert.equal(procurementExactText(divProcurementExact(x(135_000_000n), 1_000_000_000)), '0.135');
  assert.throws(() => x('-3'), RangeError, 'a sign needs { signed: true }');
  assert.throws(() => x('abc'), RangeError);
  assert.throws(() => x('1.2.3'), RangeError);
  assert.throws(() => procurementExactText(divProcurementExact(x(1), 3)), /terminating/);
  assert.throws(() => divProcurementExact(x(1), 0), RangeError);
  assert.equal(ceilProcurementExact(x('874999.6')), 875_000n);
  assert.equal(ceilProcurementExact(x('875000')), 875_000n);
  assert.equal(ceilProcurementExact(x('-0.5', true)), 0n);
  assert.equal(ceilProcurementExact(x('-1.5', true)), -1n);
  assert.equal(compareProcurementExact(x('0.1'), x('0.10')), 0);
  assert.equal(compareProcurementExact(x('0.1'), x('0.11')), -1);
  assert.equal(compareProcurementExact(x('2'), x('1.999999999')), 1);
  assert.throws(() => ceilStep('-500'), RangeError, 'a negative amount is never rounded to a price');
  assert.throws(() => ceilStep(-1), RangeError);
  assert.equal(ceilStep(0), 0);
  assert.throws(() => ceilStep(1, 0), RangeError);
  assert.throws(() => ceilStep(Number.NaN), RangeError);
});

test('parseProcurementDecimal (ENG §4.1): canonical text the 0179 CHECKs accept, or a RangeError', () => {
  const p = (v: unknown, o: Partial<Parameters<typeof parseProcurementDecimal>[1]> = {}) =>
    parseProcurementDecimal(v, { maxIntDigits: 12, maxFractionDigits: 6, ...o });
  const CHECK = /^[0-9]+(\.[0-9]+)?$/; // GLOB '[0-9]*', no other characters, one '.', no trailing '.'
  for (const [input, canonical] of [
    ['1500.0', '1500'], ['007.50', '7.5'], ['0', '0'], ['0.000', '0'], ['1626.25', '1626.25'], [' 12 ', '12'], ['0.142', '0.142'],
  ] as const) {
    assert.equal(p(input), canonical, input);
    assert.match(canonical, CHECK);
  }
  assert.equal(p(1500), '1500', 'a safe-integer number');
  assert.equal(p(42n), '42');
  assert.equal(p('+0.50', { signed: true }), '0.5');
  assert.equal(p('-3', { signed: true }), '-3');
  assert.equal(p('-0.00', { signed: true }), '0');
  assert.equal(p('+80', { signed: true }), '80');
  for (const bad of ['1e3', '1E3', '.5', '5.', '1.2.3', '', ' ', 'abc', '0x10', '1,5', '١٢', 'Infinity', '- 3', '--3', '+-3']) assert.throws(() => p(bad, { signed: true }), RangeError, JSON.stringify(bad));
  for (const bad of ['+1', '-1', '-0']) assert.throws(() => p(bad), RangeError, `${bad}: a sign needs { signed: true }`);
  for (const bad of [0.5, 0.1 + 0.2, Number.NaN, Infinity, 2 ** 53, null, undefined, {}, ['1']]) assert.throws(() => p(bad), RangeError, String(bad));
  assert.throws(() => p('1234567890123'), RangeError, 'more integer digits than allowed');
  assert.equal(p('000000000000001'), '1', 'leading zeros are not digits');
  assert.throws(() => p('1.1234567'), RangeError, 'more fraction digits than allowed');
  assert.equal(p('1.1234560000'), '1.123456', 'trailing zeros are not digits');
  assert.throws(() => p('0', { min: 'positive' }), RangeError);
  assert.throws(() => p('0.000', { min: 'positive' }), RangeError);
  assert.equal(p('0.001', { min: 'positive' }), '0.001');
  assert.equal(p('0', { min: 'nonnegative' }), '0');
  assert.throws(() => p('-0.01', { signed: true, min: 'nonnegative' }), RangeError);
  assert.equal(p('-0', { signed: true, min: 'nonnegative' }), '0');
  assert.throws(() => p('1', { maxIntDigits: 0 }), RangeError, 'limits are validated');
});

/* ---------------------------------------------------- SKU × channel names -- */

test('channels and profiles: air → CHINA_AIR, sea → CHINA_SEA, land → GERMANY_LAND; direct uses the default profile', () => {
  assert.deepEqual(SKU_CHANNELS, ['direct_sale', 'pre_order_air', 'pre_order_sea', 'pre_order_land']);
  assert.deepEqual(ROUTE_PROFILE, { air: 'CHINA_AIR', sea: 'CHINA_SEA', land: 'GERMANY_LAND' });
  assert.deepEqual(PROFILE_BASIS, { GERMANY_LAND: 'weight', CHINA_AIR: 'weight', CHINA_SEA: 'volume' });
  assert.equal(profileOfChannel('pre_order_sea', 'CHINA_AIR'), 'CHINA_SEA');
  assert.equal(profileOfChannel('direct_sale', 'GERMANY_LAND'), 'GERMANY_LAND');
  assert.equal(profileOfChannel('direct_sale', null), null);
  assert.equal(routeOfChannel('direct_sale'), null);
  assert.equal(channelOfRoute('land'), 'pre_order_land');
  for (const t of SHIPPING_TYPES) assert.equal(shippingTypeOfChannel(channelOfShippingType(t)), t);
  for (const c of SKU_CHANNELS) assert.equal(channelOfShippingType(shippingTypeOfChannel(c)), c);
  assert.equal(skuPriceHistoryKey('o:a|c:b', 'pre_order_air'), 'sku:o:a|c:b@pre_order_air');
});

test('skuComboKey is byte-identical to the product_variants comboKey (worker/lib/inventory.ts) and parses back', () => {
  const rnd = prng(42);
  const id = () => `${['ov', 'pc', 'x'][Math.floor(rnd() * 3)]}_${Math.floor(rnd() * 1e6).toString(36)}`;
  for (let i = 0; i < 2000; i++) {
    const option_value_ids = Array.from({ length: Math.floor(rnd() * 4) }, id);
    if (rnd() < 0.1) option_value_ids.push('');
    const color_id = rnd() < 0.5 ? id() : rnd() < 0.5 ? null : '';
    const key = skuComboKey({ option_value_ids, color_id });
    assert.equal(key, comboKey({ option_value_ids, color_id: color_id || null }), JSON.stringify({ option_value_ids, color_id }));
    const parsed = parseSkuComboKey(key);
    assert.ok(parsed, key);
    assert.deepEqual(parsed.option_value_ids, option_value_ids.filter(Boolean).sort());
    assert.equal(parsed.color_id, color_id || null);
    assert.equal(skuComboKey(parsed), key);
  }
  assert.deepEqual(parseSkuComboKey(''), { option_value_ids: [], color_id: null }, "'' is the product itself");
  for (const bad of ['o:b|o:a', 'c:x|o:a', 'c:x|c:y', 'o:', 'q:a', 'o:a|', '|o:a', 'oa']) assert.equal(parseSkuComboKey(bad), null, bad);
});

/* ---------------------------------------------------- confidentiality -- */

test('the pricing formula never ships to the browser: src/ imports neither costToPrice nor ruleResolution', () => {
  for (const file of tsFiles(join(ROOT, 'src'))) {
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      assert.ok(!/costToPrice|ruleResolution/.test(spec), `${file} imports ${spec}`);
    }
  }
});
