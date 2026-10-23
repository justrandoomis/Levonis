/**
 * PRICING V2 — THE MATHS (docs/PRICING-V2.md §1; owner decisions A1, B1, C1,
 * DECISIONS row 221; implementation spec V2-1 §1.5).
 *
 *     D = round(anchor × U + Σ differences × U)           (cost-first: never below R_stock + T × U)
 *     P_route = round((D_usd − Δ) × U)                     (B1: one Δ for every route; P ≤ D)
 *
 * `round` is the one rounding rule (DECISIONS row 245, `roundPriceIqd`): above 1,000 IQD up to
 * the next 250, else up to whole dinars. The §1.6 cells below are that rule's (they were the
 * 1,000 step's until 2026-10-17: Combo's land route 1,778,000 is now 1,777,500).
 *
 * Proven here:
 *   1. every fixed cell of PRICING-V2.md §1.6 and of the decision examples (§8);
 *   2. a property over 4,000 SKUs against an independent BigInt oracle (anchor and
 *      discount precedence, the floor — a floored route sells at D, owner answer Q1 —,
 *      blocked routes, the errors, the price-first below-cost and below-minimum-profit
 *      warnings, Q3), plus P ≤ D, the rounding rule, D − R ≥ T, monotone discounts and colour
 *      differences;
 *   3. the owner's answers of 2026-10-14 (DECISIONS row 222): Q1 a floored route sells at
 *      the direct price (never at its cost), Q3 a typed price below cost + minimum profit
 *      saves with the owner's warning, Q5 a negative model difference is lifted to the floor;
 *   5. no float ever enters;
 *   6. a pre-order-only SKU sells every route at D.
 * The reproduce helper (usdReproducing) lives with its only user, tests/fixtures/v2Publish.ts,
 * and is proven by tests/v2Publish.test.ts: the clean start (Q6) retired the migration.
 *
 * Run: node --import tsx --test tests/pricingV2Maths.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorOf,
  parseV2Usd,
  priceProductV2,
  resolveDiscount,
  type V2Channel,
  type V2Discount,
  type V2Input,
  type V2Method,
  type V2PricePoint,
  type V2Result,
  type V2Sku,
} from '../packages/pricing/src/priceV2';
import type { CentralRates, PricingInputRow, SupplierCurrency } from '../packages/pricing/src/costToPrice';
import type { RuleResolution } from '../packages/pricing/src/ruleResolution';
import { composeIqdRates } from '../packages/pricing/src/fxChain';
import {
  PRODUCT_COMBO_KEY,
  PRODUCT_SKU_ROW_KEY,
  ROUTE_PROFILE,
  parseSkuComboKey,
  routeOfChannel,
  skuComboKey,
  skuKeyOfStored,
  storedSkuKey,
  type ShippingProfile,
  type SkuChannel,
} from '../packages/pricing/src/skuChannel';

/* ----------------------------------------------------------- fixtures -- */

const rate = (r: string | null, confirmed = true, version = 1) => ({ rate: r, version, confirmed });

/** Rates as FX-1 derives them: USD = U, EUR = E × U, CNY = C × U. */
function chainRates(U: string, E: string, C: string, shipping: Partial<Record<ShippingProfile, string>>): CentralRates {
  const fx = composeIqdRates(U, E, C);
  return {
    fx: { USD: rate(fx.USD), EUR: rate(fx.EUR), CNY: rate(fx.CNY) },
    shipping: Object.fromEntries(Object.entries(shipping).map(([k, v]) => [k, rate(v!)])),
  };
}

const ref = (id: string) => ({ id, version: 3, scope: 'product' as const, scope_id: '', catalog_id: null });
const usdTarget = (amount: string): RuleResolution => ({
  status: 'active', kind: 'target_profit', amount_iqd: null, amount_usd: amount, rule: ref('rule_t'), tie: false, candidates: [ref('rule_t')],
});

const CHANNELS_LAND: SkuChannel[] = ['direct_sale', 'pre_order_land'];

/** §1.6: supplier €500, stock route land 9,000 IQD/kg × 22 kg, extras 15,000; Combo «تكلفة مختلفة» €650, 30 kg. */
const STANDARD_INPUTS: PricingInputRow = { supplier_cost: '500', supplier_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 22000, additional_cost_iqd: 15000 };
const COMBO_INPUTS: PricingInputRow = { supplier_cost: '650', shipping_weight_g: 30000 };

function workedSku(model: 'std' | 'combo', colour: string | null, channels: SkuChannel[] = CHANNELS_LAND, base: PricingInputRow = STANDARD_INPUTS): V2Sku {
  const option_value_ids = [model];
  return {
    combo_key: skuComboKey({ option_value_ids, color_id: colour }),
    model_id: model,
    option_value_ids,
    color_id: colour,
    channels,
    chain: { base: { override: base }, options: model === 'combo' ? [{ scope_id: 'combo', override: COMBO_INPUTS }] : [] },
    target: usdTarget('318'),
  };
}

const WORKED_POINTS: V2PricePoint[] = [{ scope: 'color', scope_id: 'red', kind: 'delta', usd: '2' }];
const WORKED_DISCOUNTS: V2Discount[] = [
  { scope: 'product', scope_id: '', usd: '50' },
  { scope: 'option', scope_id: 'combo', usd: '25' },
];

function worked(U: string, E: string, over: Partial<V2Input> = {}, shipping: Partial<Record<ShippingProfile, string>> = {}): V2Result {
  return priceProductV2({
    method: 'cost',
    rates: chainRates(U, E, '0.14', { GERMANY_LAND: '9000', CHINA_AIR: '20000', CHINA_SEA: '300000', ...shipping }),
    points: WORKED_POINTS,
    discounts: WORKED_DISCOUNTS,
    skus: [workedSku('std', null), workedSku('combo', null), workedSku('std', 'red'), workedSku('combo', 'red')],
    ...over,
  });
}

function skuOf(r: V2Result, key: string) {
  const s = r.skus.find((x) => x.combo_key === key);
  assert.ok(s, `no SKU ${key}`);
  return s;
}
function ch(r: V2Result, key: string, channel: SkuChannel): V2Channel {
  const c = skuOf(r, key).channels.find((x) => x.channel === channel);
  assert.ok(c, `${key} ${channel} not priced: ${JSON.stringify(skuOf(r, key).issues)}`);
  return c;
}
const dp = (r: V2Result, key: string, route: SkuChannel = 'pre_order_land') => [ch(r, key, 'direct_sale').price_iqd, ch(r, key, route).price_iqd];
const codes = (r: V2Result, key: string, severity: 'error' | 'warning', channel?: SkuChannel) =>
  skuOf(r, key).issues.filter((i) => i.severity === severity && (channel === undefined || i.channel === channel)).map((i) => i.code);

const STD = 'o:std';
const COMBO = 'o:combo';
const STD_RED = 'o:std|c:red';
const COMBO_RED = 'o:combo|c:red';

/* ------------------------------------------------ 1. the fixed cells -- */

test('§1.6 start (U 1,500, E 1.08): Standard 1,500,000 / 1,425,000, Combo 1,815,000 / 1,777,500, Red +$2 on both models', () => {
  const r = worked('1500', '1.08');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(dp(r, STD), [1_500_000, 1_425_000]);
  assert.deepEqual(dp(r, COMBO), [1_815_000, 1_777_500], 'E_P 1,777,500 is on the rule: no rounding added');
  assert.deepEqual(dp(r, STD_RED), [1_503_000, 1_428_000]);
  assert.deepEqual(dp(r, COMBO_RED), [1_818_000, 1_780_500]);

  // The private figures behind the cells (owner-only).
  const d = ch(r, STD, 'direct_sale');
  assert.equal(d.replacement?.replacement_cost_iqd, 1_023_000, 'R = 810,000 + 198,000 + 15,000');
  assert.equal(d.anchor, 'cost');
  assert.equal(d.exact_iqd, '1500000');
  assert.equal(d.usd_ceil6, '1000');
  assert.equal(d.usd_exact, null, 'cost-first carries no exact USD');
  assert.equal(d.target_profit_usd, '318');
  assert.equal(d.target_rule_id, 'rule_t');
  assert.equal(d.target_rule_version, 3);
  assert.equal(d.discount_usd, null);
  assert.equal(d.floor, 'none');
  const p = ch(r, COMBO, 'pre_order_land');
  assert.equal(ch(r, COMBO, 'direct_sale').replacement?.replacement_cost_iqd, 1_338_000, 'Combo R = 1,053,000 + 270,000 + 15,000');
  assert.equal(p.exact_iqd, '1777500');
  assert.equal(p.discount_usd, '25');
  assert.deepEqual(p.discount_from, { scope: 'option', scope_id: 'combo' }, 'the model exception beats the product discount');
  assert.equal(p.direct_iqd, 1_815_000);
  assert.equal(ch(r, STD, 'pre_order_land').discount_from?.scope, 'product');
  assert.equal(ch(r, COMBO_RED, 'direct_sale').deltas_usd, '2', 'the colour difference is the same USD on every model (C1)');
});

test('§1.6 U 1,500 → 1,530: Standard 1,525,750 / 1,449,250, Combo 1,845,750 / 1,807,500 (freight and extras stay IQD)', () => {
  const r = worked('1530', '1.08');
  assert.deepEqual(dp(r, STD), [1_525_750, 1_449_250], '1,525,740 → 1,525,750; 1,449,240 → 1,449,250');
  assert.deepEqual(dp(r, COMBO), [1_845_750, 1_807_500], '1,845,600 → 1,845,750; 1,807,350 → 1,807,500');
  assert.equal(ch(r, STD, 'direct_sale').exact_iqd, '1525740');
  assert.equal(ch(r, COMBO, 'pre_order_land').exact_iqd, '1807350');
});

test('§1.6 E 1.08 → 1.12 at U 1,500: Standard 1,530,000 / 1,455,000, Combo 1,854,000 / 1,816,500', () => {
  const r = worked('1500', '1.12');
  assert.deepEqual(dp(r, STD), [1_530_000, 1_455_000]);
  assert.deepEqual(dp(r, COMBO), [1_854_000, 1_816_500]);
});

test('§1.6 price-first «$1,000» at U 1,530: 1,530,000 / 1,453,500, with the exact USD carried', () => {
  const r = worked('1530', '1.08', {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }],
    discounts: [{ scope: 'product', scope_id: '', usd: '50' }],
    skus: [{ ...workedSku('std', null), chain: undefined, target: undefined }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(dp(r, STD), [1_530_000, 1_453_500], '$950 × 1,530 = 1,453,500, on the rule');
  const p = ch(r, STD, 'pre_order_land');
  assert.equal(p.anchor, 'product_fixed');
  assert.equal(p.usd_exact, '950');
  assert.equal(p.exact_iqd, '1453500');
  assert.equal(ch(r, STD, 'direct_sale').usd_exact, '1000');
  assert.equal(p.replacement, null, 'price-first without a cost has no replacement figure');
  assert.equal(p.target_profit_usd, null);
  assert.equal(p.below_cost, false);
});

test('B1 air example: R_air 1,265,000, P_air 1,425,000 (land and air alike), profit 160,000', () => {
  const r = worked('1500', '1.08', { skus: [workedSku('std', null, ['direct_sale', 'pre_order_land', 'pre_order_air'])] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const air = ch(r, STD, 'pre_order_air');
  assert.equal(air.price_iqd, 1_425_000);
  assert.equal(ch(r, STD, 'pre_order_land').price_iqd, 1_425_000);
  assert.equal(air.replacement?.replacement_cost_iqd, 1_265_000);
  assert.equal(air.replacement?.shipping_profile, 'CHINA_AIR');
  assert.equal(air.price_iqd - air.replacement!.replacement_cost_iqd, 160_000);
  assert.equal(air.floor, 'none');
});

test('B1 floor, owner answer Q1: air freight above the discounted price → the route sells at D (discount withdrawn), never lifted to its cost', () => {
  const skus = [workedSku('std', null, ['direct_sale', 'pre_order_land', 'pre_order_air'])];
  // 30,000/kg × 22 kg = 660,000 → R_air = 1,485,000: above P = 1,425,000, below D = 1,500,000.
  const direct = worked('1500', '1.08', { skus }, { CHINA_AIR: '30000' });
  const air = ch(direct, STD, 'pre_order_air');
  assert.equal(air.replacement?.replacement_cost_iqd, 1_485_000);
  assert.equal(air.price_iqd, 1_500_000);
  assert.equal(air.floor, 'discount_withdrawn');
  assert.equal(air.exact_iqd, '1500000');
  assert.deepEqual(codes(direct, STD, 'warning', 'pre_order_air'), ['V2_DISCOUNT_WITHDRAWN']);
  assert.equal(ch(direct, STD, 'pre_order_land').price_iqd, 1_425_000, 'land keeps its discount');
  assert.equal(direct.ok, true);

  // Q1: the price is never the cost rounded up (that would publish the cost) — whatever R_air is.
  const odd = worked('1500', '1.08', { skus }, { CHINA_AIR: '29999.5' });
  assert.equal(ch(odd, STD, 'pre_order_air').replacement?.replacement_exact, '1484989');
  assert.equal(ch(odd, STD, 'pre_order_air').price_iqd, 1_500_000, 'D, not round(R_air) = 1,485,000');
  assert.equal(ch(odd, STD, 'pre_order_air').floor, 'discount_withdrawn');
  // The retired `cost` floor mode is a programming error, never a price.
  assert.throws(() => priceProductV2({ ...inputOfWorked(), floorMode: 'cost' } as V2Input), /PRICING_INVARIANT/);
});

test('Q1 (review 2026-10-14): a cost-first route never sells AT its own cost, even rounded up by the rule', () => {
  const skus = [workedSku('std', null, ['direct_sale', 'pre_order_land', 'pre_order_air'])];
  // 27,265/kg × 22 kg = 599,830 → R_air = 1,424,830, under E_P = 1,425,000 but rounding to it: the discount would
  // sell the route at round(R_air) — the cost published. Withdrawn: the route sells at D.
  const at = worked('1500', '1.08', { skus }, { CHINA_AIR: '27265' });
  const air = ch(at, STD, 'pre_order_air');
  assert.equal(air.replacement?.replacement_exact, '1424830');
  assert.equal(air.price_iqd, 1_500_000);
  assert.equal(air.floor, 'discount_withdrawn');
  assert.equal(ch(at, STD, 'pre_order_land').price_iqd, 1_425_000, 'land keeps its discount');
  // 27,250/kg → R_air = 1,424,500, on the rule and below P = 1,425,000: the 250 grid leaves the discount on (the
  // 1,000 step withdrew it) — the route still sells above its cost.
  const under = worked('1500', '1.08', { skus }, { CHINA_AIR: '27250' });
  assert.equal(ch(under, STD, 'pre_order_air').price_iqd, 1_425_000);
  assert.equal(ch(under, STD, 'pre_order_air').floor, 'none');
  // 30,671/kg × 22 kg = 674,762 → R_air = 1,499,762: round(R_air) = D — blocked, never sold at D = its cost rounded up.
  const edge = worked('1500', '1.08', { skus }, { CHINA_AIR: '30671' });
  assert.deepEqual(codes(edge, STD, 'error', 'pre_order_air'), ['V2_ROUTE_BELOW_COST']);
  // 30,650/kg → R_air = 1,499,300 rounds to 1,499,500 < D: not blocked; its discount is withdrawn (P ≤ round(R)).
  const near = worked('1500', '1.08', { skus }, { CHINA_AIR: '30650' });
  assert.equal(ch(near, STD, 'pre_order_air').price_iqd, 1_500_000);
  assert.equal(ch(near, STD, 'pre_order_air').floor, 'discount_withdrawn');
  for (const r of [at, under, near])
    for (const c of skuOf(r, STD).channels) if (c.channel !== 'direct_sale' && c.replacement) assert.ok(c.price_iqd > c.replacement.replacement_cost_iqd);
});

test('B1 block: R_air above D blocks air only; land and direct stay priced', () => {
  // 35,000/kg × 22 kg = 770,000 → R_air = 1,595,000 > D = 1,500,000.
  const r = worked('1500', '1.08', { skus: [workedSku('std', null, ['direct_sale', 'pre_order_land', 'pre_order_air'])] }, { CHINA_AIR: '35000' });
  const s = skuOf(r, STD);
  assert.equal(s.ok, false);
  assert.equal(r.ok, false);
  assert.deepEqual(s.channels.map((c) => c.channel), ['direct_sale', 'pre_order_land']);
  assert.deepEqual(codes(r, STD, 'error', 'pre_order_air'), ['V2_ROUTE_BELOW_COST']);
  assert.equal(s.issues.find((i) => i.code === 'V2_ROUTE_BELOW_COST')?.profile, 'CHINA_AIR');
  assert.deepEqual(dp(r, STD), [1_500_000, 1_425_000]);
});

test('decision examples: D1 a purchase at €520 → 1,532,500 / 1,457,500; C1 Gold +$2 on $20 / $16 models → 33,000 / 27,000', () => {
  const r = worked('1500', '1.08', { skus: [workedSku('std', null, CHANNELS_LAND, { ...STANDARD_INPUTS, supplier_cost: '520' })] });
  assert.deepEqual(dp(r, STD), [1_532_500, 1_457_500], '1,532,400 → 1,532,500; 1,457,400 → 1,457,500');

  const filament = (model: string, colour: string | null): V2Sku => ({
    combo_key: skuComboKey({ option_value_ids: [model], color_id: colour }), model_id: model, option_value_ids: [model], color_id: colour, channels: ['direct_sale'],
  });
  const c1 = priceProductV2({
    method: 'usd',
    rates: chainRates('1500', '1.08', '0.14', {}),
    points: [
      { scope: 'product', scope_id: '', kind: 'fixed', usd: '20' },
      { scope: 'option', scope_id: 'refill', kind: 'fixed', usd: '16' },
      { scope: 'color', scope_id: 'gold', kind: 'delta', usd: '2' },
    ],
    discounts: [],
    skus: [filament('spool', null), filament('refill', null), filament('spool', 'gold'), filament('refill', 'gold')],
  });
  assert.equal(c1.ok, true, JSON.stringify(c1));
  const d = (k: string) => ch(c1, k, 'direct_sale').price_iqd;
  assert.deepEqual([d('o:spool'), d('o:refill'), d('o:spool|c:gold'), d('o:refill|c:gold')], [30_000, 24_000, 33_000, 27_000]);
  assert.equal(ch(c1, 'o:refill', 'direct_sale').anchor, 'model_fixed');
  assert.equal(ch(c1, 'o:spool', 'direct_sale').anchor, 'product_fixed');
});

test('a SKU «سعر خاص $» replaces D for that SKU: no colour or model difference is added', () => {
  const r = worked('1500', '1.08', { points: [...WORKED_POINTS, { scope: 'sku', scope_id: COMBO_RED, kind: 'fixed', usd: '1300' }] });
  const c = ch(r, COMBO_RED, 'direct_sale');
  assert.equal(c.anchor, 'sku_fixed');
  assert.equal(c.deltas_usd, '0');
  assert.equal(c.price_iqd, 1_950_000);
  assert.equal(ch(r, COMBO_RED, 'pre_order_land').price_iqd, 1_912_500, '(1,300 − 25) × 1,500 = 1,912,500, on the rule');
  assert.deepEqual(dp(r, STD_RED), [1_503_000, 1_428_000], 'other SKUs unchanged');
});

test('cost-first: D never below R_stock + T (C-9) — a low fixed price or a negative difference is lifted, flagged to the owner', () => {
  const low = worked('1500', '1.08', { points: [{ scope: 'option', scope_id: 'std', kind: 'fixed', usd: '900' }], skus: [workedSku('std', null)] });
  const d = ch(low, STD, 'direct_sale');
  assert.equal(d.anchor, 'model_fixed');
  assert.equal(d.price_iqd, 1_500_000, '$900 × 1,500 = 1,350,000 < R + T = 1,500,000');
  assert.equal(d.floor, 'direct_min_profit');
  assert.equal(ch(low, STD, 'pre_order_land').price_iqd, 1_425_000);
  assert.equal(ch(low, STD, 'pre_order_land').floor, 'direct_min_profit', 'the route was priced from the lifted D');
  assert.deepEqual(codes(low, STD, 'warning'), ['V2_DIRECT_MIN_PROFIT']);
  const minus = worked('1500', '1.08', { points: [{ scope: 'color', scope_id: 'red', kind: 'delta', usd: '-5.5' }], skus: [workedSku('std', 'red')] });
  assert.equal(ch(minus, STD_RED, 'direct_sale').price_iqd, 1_500_000);
  assert.equal(ch(minus, STD_RED, 'direct_sale').floor, 'direct_min_profit');
  const above = worked('1500', '1.08', { points: [{ scope: 'option', scope_id: 'std', kind: 'fixed', usd: '1100.01' }], skus: [workedSku('std', null)] });
  assert.equal(ch(above, STD, 'direct_sale').price_iqd, 1_650_250, '1,100.01 × 1,500 = 1,650,015 → 1,650,250');
  assert.equal(ch(above, STD, 'direct_sale').floor, 'none');
});

test('price-first never floors (C-6, Q3): below its known cost, or below cost + minimum profit, it only warns the owner', () => {
  const r = worked('1500', '1.08', {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '700' }],
    skus: [workedSku('std', null, ['direct_sale', 'pre_order_land', 'pre_order_air'])],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(dp(r, STD), [1_050_000, 975_000]);
  const air = ch(r, STD, 'pre_order_air');
  assert.equal(air.price_iqd, 975_000, 'R_air 1,265,000 is above, and nothing is lifted');
  assert.equal(air.below_cost, true);
  assert.equal(air.floor, 'none');
  assert.equal(ch(r, STD, 'pre_order_land').below_cost, true, '975,000 < R_land 1,023,000');
  assert.equal(ch(r, STD, 'direct_sale').below_cost, false, '1,050,000 > R_stock 1,023,000');
  assert.deepEqual(codes(r, STD, 'warning', 'pre_order_air'), ['V2_BELOW_COST']);
  assert.equal(air.target_profit_usd, null);
  // Q3: E_D 1,050,000 < R_stock 1,023,000 + T $318 × 1,500 = 1,500,000 → saved, priced, the owner warned.
  assert.ok(codes(r, STD, 'warning').includes('V2_BELOW_MIN_PROFIT'));
  for (const c of skuOf(r, STD).channels) assert.equal(c.below_min_profit, true, `${c.channel}: every channel shares D`);
});

test('Q3: a typed dollar price at or above cost + minimum profit raises nothing; without a complete cost or minimum profit nothing is said', () => {
  const at = (usd: string, sku: V2Sku = workedSku('std', null)) =>
    worked('1500', '1.08', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd }], discounts: [], skus: [sku] });
  // R_stock + T = 1,023,000 + 477,000 = 1,500,000 = $1,000 × 1,500.
  const exact = at('1000');
  assert.equal(ch(exact, STD, 'direct_sale').below_min_profit, false, 'E_D = R_stock + T is not below');
  assert.ok(!codes(exact, STD, 'warning').includes('V2_BELOW_MIN_PROFIT'));
  const cent = at('999.99');
  assert.equal(ch(cent, STD, 'direct_sale').below_min_profit, true, 'one cent under');
  assert.equal(ch(cent, STD, 'direct_sale').price_iqd, 1_500_000, 'the price is the typed dollars, never moved');
  assert.equal(cent.ok, true);
  // No minimum profit, or no cost: no warning (and never an error on a price-first product).
  const noTarget = at('700', { ...workedSku('std', null), target: undefined });
  assert.equal(noTarget.ok, true);
  assert.equal(ch(noTarget, STD, 'direct_sale').below_min_profit, false);
  const noCost = at('700', { ...workedSku('std', null), chain: undefined });
  assert.equal(ch(noCost, STD, 'direct_sale').below_min_profit, false);
  assert.equal(ch(noCost, STD, 'direct_sale').below_cost, false);
  // A model or SKU fixed price is judged the same (the direct price, whatever its anchor).
  const model = worked('1500', '1.08', {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1200' }, { scope: 'option', scope_id: 'std', kind: 'fixed', usd: '800' }],
    discounts: [],
    skus: [workedSku('std', null)],
  });
  assert.equal(ch(model, STD, 'direct_sale').anchor, 'model_fixed');
  assert.equal(ch(model, STD, 'direct_sale').below_min_profit, true);
  // Cost-first never carries the price-first warnings.
  const cost = worked('1500', '1.08', { skus: [workedSku('std', null)] });
  for (const c of skuOf(cost, STD).channels) assert.deepEqual([c.below_cost, c.below_min_profit], [false, false]);
});

test('Q5: from cost, a negative model difference below R_stock + T is lifted to the floor with V2_DIRECT_MIN_PROFIT', () => {
  const r = worked('1500', '1.08', { points: [{ scope: 'option', scope_id: 'std', kind: 'delta', usd: '-40' }], discounts: [], skus: [workedSku('std', null)] });
  const d = ch(r, STD, 'direct_sale');
  assert.equal(d.price_iqd, 1_500_000, 'R + T + (−$40 × 1,500) = 1,440,000 → lifted to 1,500,000');
  assert.equal(d.floor, 'direct_min_profit');
  assert.deepEqual(codes(r, STD, 'warning'), ['V2_DIRECT_MIN_PROFIT']);
});

/* ---------------------------------------------- refusals and codes -- */

test('a discount at or above D is V2_DISCOUNT_TOO_LARGE on the routes; direct sale stays priced', () => {
  const r = worked('1500', '1.08', {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '100' }],
    discounts: [{ scope: 'product', scope_id: '', usd: '100' }],
    skus: [workedSku('std', null)],
  });
  assert.deepEqual(codes(r, STD, 'error', 'pre_order_land'), ['V2_DISCOUNT_TOO_LARGE']);
  assert.equal(ch(r, STD, 'direct_sale').price_iqd, 150_000);
  assert.equal(skuOf(r, STD).ok, false);
});

test('price-first without a product price, or differences that take D to 0, is V2_PRICE_MISSING on every channel', () => {
  const none = worked('1500', '1.08', { method: 'usd', points: [], skus: [workedSku('std', null)] });
  assert.deepEqual(codes(none, STD, 'error'), ['V2_PRICE_MISSING', 'V2_PRICE_MISSING']);
  assert.equal(skuOf(none, STD).channels.length, 0);
  const zero = worked('1500', '1.08', {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }, { scope: 'option', scope_id: 'std', kind: 'delta', usd: '-10' }],
    skus: [workedSku('std', null)],
  });
  assert.deepEqual(codes(zero, STD, 'error'), ['V2_PRICE_MISSING', 'V2_PRICE_MISSING']);
});

test('the stored shapes the 0189 CHECKs refuse are V2_SCOPE_INVALID / AMOUNT_TOO_LARGE / V2_POINT_CONFLICT, never priced', () => {
  const run = (points: V2PricePoint[], discounts: V2Discount[] = [], method: V2Method = 'usd') =>
    worked('1500', '1.08', { method, points, discounts, skus: [workedSku('std', 'red'), workedSku('combo', null)] });
  const P = (usd = '1000'): V2PricePoint => ({ scope: 'product', scope_id: '', kind: 'fixed', usd });
  const cases: Array<[string, V2Result, string]> = [
    ['colour fixed (C1)', run([P(), { scope: 'color', scope_id: 'red', kind: 'fixed', usd: '5' }]), 'V2_SCOPE_INVALID'],
    ['SKU difference (C1)', run([P(), { scope: 'sku', scope_id: STD_RED, kind: 'delta', usd: '5' }]), 'V2_SCOPE_INVALID'],
    ['product difference', run([{ scope: 'product', scope_id: '', kind: 'delta', usd: '5' }]), 'V2_SCOPE_INVALID'],
    ['product price on a cost-first product', run([P()], [], 'cost'), 'V2_SCOPE_INVALID'],
    ['product scope with an id', run([{ scope: 'product', scope_id: 'x', kind: 'fixed', usd: '5' }]), 'V2_SCOPE_INVALID'],
    ['unknown scope', run([P(), { scope: 'category' as never, scope_id: 'x', kind: 'fixed', usd: '5' }]), 'V2_SCOPE_INVALID'],
    ['seven decimals', run([P('1000.0000001')]), 'AMOUNT_TOO_LARGE'],
    ['above $100,000', run([P('100000.01')]), 'AMOUNT_TOO_LARGE'],
    ['a zero difference', run([P(), { scope: 'color', scope_id: 'red', kind: 'delta', usd: '0' }]), 'AMOUNT_TOO_LARGE'],
    ['a negative discount', run([P()], [{ scope: 'product', scope_id: '', usd: '-1' }]), 'AMOUNT_TOO_LARGE'],
    ['two rows for one scope', run([P(), P('900')]), 'V2_POINT_CONFLICT'],
    ['two discounts for one model', run([P()], [{ scope: 'option', scope_id: 'std', usd: '1' }, { scope: 'option', scope_id: 'std', usd: '2' }]), 'V2_POINT_CONFLICT'],
  ];
  for (const [what, r, code] of cases) {
    assert.equal(r.ok, false, what);
    assert.ok(r.issues.some((i) => i.code === code && i.severity === 'error' && i.channel === undefined), `${what}: setup issue ${code} in ${JSON.stringify(r.issues)}`);
  }
  // A SKU the bad row names gets the error on every channel; one it does not name stays priced.
  const colour = cases[0][1];
  assert.deepEqual(codes(colour, STD_RED, 'error'), ['V2_SCOPE_INVALID', 'V2_SCOPE_INVALID']);
  assert.equal(skuOf(colour, STD_RED).issues[0].level, 'color');
  assert.deepEqual(skuOf(colour, STD_RED).issues[0].scope_ids, ['red']);
  assert.equal(skuOf(colour, COMBO).ok, true);
  const model = cases[9][1];
  assert.equal(skuOf(model, COMBO).ok, false, 'a product-level row names every SKU');
});

test('a fixed price or a discount on an option value that is not the SKU model is V2_SCOPE_INVALID for that SKU', () => {
  const sku: V2Sku = { combo_key: 'o:std|o:wifi', model_id: 'std', option_value_ids: ['std', 'wifi'], color_id: null, channels: CHANNELS_LAND };
  const base = { method: 'usd' as const, rates: chainRates('1500', '1.08', '0.14', {}), skus: [sku] };
  const fixed = priceProductV2({ ...base, points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }, { scope: 'option', scope_id: 'wifi', kind: 'fixed', usd: '20' }], discounts: [] });
  assert.deepEqual(fixed.skus[0].issues.filter((i) => i.severity === 'error').map((i) => [i.code, i.scope_ids]), [
    ['V2_SCOPE_INVALID', ['wifi']],
    ['V2_SCOPE_INVALID', ['wifi']],
  ]);
  // A ± on a second option group adds, like the model's.
  const delta = priceProductV2({ ...base, points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }, { scope: 'option', scope_id: 'wifi', kind: 'delta', usd: '+3' }, { scope: 'option', scope_id: 'std', kind: 'delta', usd: '1' }], discounts: [] });
  assert.equal(delta.skus[0].channels[0].price_iqd, 21_000, '(10 + 3 + 1) × 1,500');
  assert.equal(delta.skus[0].channels[0].deltas_usd, '4');
  const discount = priceProductV2({ ...base, points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }], discounts: [{ scope: 'option', scope_id: 'wifi', usd: '1' }] });
  assert.deepEqual(discount.skus[0].issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_SCOPE_INVALID', 'V2_SCOPE_INVALID']);
});

test('U missing or unconfirmed refuses every channel; a preview reads an unconfirmed U as a warning (as E1)', () => {
  const rates = chainRates('1500', '1.08', '0.14', { GERMANY_LAND: '9000' });
  const missing = worked('1500', '1.08', { rates: { ...rates, fx: { ...rates.fx, USD: rate(null) } }, skus: [workedSku('std', null)] });
  assert.deepEqual(codes(missing, STD, 'error'), ['FX_RATE_MISSING', 'FX_RATE_MISSING']);
  assert.equal(skuOf(missing, STD).issues[0].currency, 'USD');
  const unconfirmed = { ...rates, fx: { ...rates.fx, USD: rate('1500', false) } };
  const refused = worked('1500', '1.08', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }], rates: unconfirmed, skus: [workedSku('std', null)] });
  assert.deepEqual(codes(refused, STD, 'error'), ['FX_RATE_UNCONFIRMED', 'FX_RATE_UNCONFIRMED']);
  const preview = worked('1500', '1.08', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }], rates: unconfirmed, skus: [workedSku('std', null)], allowUnconfirmedRates: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(dp(preview, STD), [1_500_000, 1_425_000]);
  assert.deepEqual(codes(preview, STD, 'warning'), ['FX_RATE_UNCONFIRMED']);
});

test('cost-first readiness: the engine codes of E1, on every channel or on the one route that misses a measure («ناقص: الوزن لمسار جوي»)', () => {
  const noTarget = worked('1500', '1.08', { skus: [{ ...workedSku('std', null), target: undefined }] });
  assert.deepEqual(codes(noTarget, STD, 'error'), ['TARGET_PROFIT_MISSING', 'TARGET_PROFIT_MISSING']);
  const noCost = worked('1500', '1.08', { skus: [{ ...workedSku('std', null), chain: {} }] });
  assert.ok(codes(noCost, STD, 'error', 'direct_sale').includes('SUPPLIER_COST_MISSING'));
  // Stock arrives by sea (a box, no weight): direct and sea are priced; air misses its weight only.
  const seaStock: PricingInputRow = { supplier_cost: '500', supplier_currency: 'EUR', shipping_profile: 'CHINA_SEA', shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: 300, additional_cost_iqd: 15000 };
  const r = worked('1500', '1.08', { skus: [workedSku('std', null, ['direct_sale', 'pre_order_sea', 'pre_order_air'], seaStock)] });
  assert.deepEqual(skuOf(r, STD).channels.map((c) => c.channel), ['direct_sale', 'pre_order_sea']);
  assert.deepEqual(codes(r, STD, 'error'), ['WEIGHT_MISSING']);
  assert.equal(skuOf(r, STD).issues[0].channel, 'pre_order_air');
  // 0.06 CBM × 300,000 = 18,000 freight: R = 810,000 + 18,000 + 15,000 = 843,000; + 477,000 = 1,320,000.
  assert.equal(ch(r, STD, 'direct_sale').price_iqd, 1_320_000);
  assert.equal(ch(r, STD, 'direct_sale').replacement?.shipping_profile, 'CHINA_SEA');
});

test('a pre-order-only SKU (C-8): every route sells at D; a stored discount is ignored with V2_DISCOUNT_IGNORED', () => {
  const r = worked('1500', '1.08', { skus: [workedSku('std', null, ['pre_order_land', 'pre_order_air'])] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const land = ch(r, STD, 'pre_order_land');
  const air = ch(r, STD, 'pre_order_air');
  assert.equal(land.price_iqd, 1_500_000);
  assert.equal(air.price_iqd, 1_500_000);
  assert.equal(land.direct_iqd, 1_500_000);
  assert.equal(land.discount_usd, '0');
  assert.equal(land.discount_from, null);
  assert.deepEqual(codes(r, STD, 'warning'), ['V2_DISCOUNT_IGNORED']);
  assert.equal(skuOf(r, STD).issues[0].level, 'base', 'the product discount is the one ignored');
  // An explicit 0 for this SKU ignores nothing.
  const zero = worked('1500', '1.08', { discounts: [...WORKED_DISCOUNTS, { scope: 'sku', scope_id: STD, usd: '0' }], skus: [workedSku('std', null, ['pre_order_land'])] });
  assert.deepEqual(codes(zero, STD, 'warning'), []);
});

/* ------------------------------------------------- precedence helpers -- */

test('resolveDiscount: sku > colour > model > product; anchorOf: sku > model > product (usd) | cost', () => {
  const s: V2Sku = { combo_key: 'o:m1|c:red', model_id: 'm1', option_value_ids: ['m1'], color_id: 'red', channels: [] };
  const all: V2Discount[] = [
    { scope: 'product', scope_id: '', usd: '1' },
    { scope: 'option', scope_id: 'm1', usd: '2' },
    { scope: 'color', scope_id: 'red', usd: '3' },
    { scope: 'sku', scope_id: 'o:m1|c:red', usd: '4' },
  ];
  assert.equal(resolveDiscount(all, s)?.usd, '4');
  assert.equal(resolveDiscount(all.slice(0, 3), s)?.usd, '3');
  assert.equal(resolveDiscount(all.slice(0, 2), s)?.usd, '2');
  assert.equal(resolveDiscount(all.slice(0, 1), s)?.usd, '1');
  assert.equal(resolveDiscount([{ scope: 'option', scope_id: 'm2', usd: '9' }], s), null, "another model's exception");
  assert.equal(resolveDiscount([], s), null);

  const pts: V2PricePoint[] = [
    { scope: 'product', scope_id: '', kind: 'fixed', usd: '10' },
    { scope: 'option', scope_id: 'm1', kind: 'fixed', usd: '20' },
    { scope: 'sku', scope_id: 'o:m1|c:red', kind: 'fixed', usd: '30' },
  ];
  assert.equal(anchorOf(pts, s, 'usd').anchor, 'sku_fixed');
  assert.equal(anchorOf(pts.slice(0, 2), s, 'usd').anchor, 'model_fixed');
  assert.equal(anchorOf(pts.slice(0, 1), s, 'usd').anchor, 'product_fixed');
  assert.deepEqual(anchorOf([], s, 'usd'), { anchor: null, code: 'V2_PRICE_MISSING', point: null });
  assert.deepEqual(anchorOf([], s, 'cost'), { anchor: 'cost', point: null });
  assert.equal(anchorOf(pts.slice(1, 2), s, 'cost').anchor, 'model_fixed', 'a model «سعر خاص $» is allowed cost-first');
  assert.equal(anchorOf(pts.slice(0, 1), s, 'cost').anchor, null, 'a product dollar price is not a cost-first anchor');
});

test('parseV2Usd is the 0211 CHECK grammar', () => {
  for (const ok of ['1', '0.01', '0.051', '0.000001', '99999.999999', '120.5', '120.50', '100000', '007.5']) assert.ok(parseV2Usd(ok), ok);
  for (const bad of ['0', '0.00', '1.2345678', '1.', '.5', '1e3', '100000.01', '-1', '+1', ' 1', '1,5', '', '1234567890', 'abc']) assert.equal(parseV2Usd(bad), null, bad);
  assert.deepEqual(parseV2Usd('-43.21', { signed: true }), { num: -4321n, den: 100n });
  assert.deepEqual(parseV2Usd('+7.77', { signed: true }), { num: 777n, den: 100n });
  for (const bad of ['0', '-0', '+-1', '--1', '-100000.01', '-1.2345678']) assert.equal(parseV2Usd(bad, { signed: true }), null, bad);
  assert.deepEqual(parseV2Usd('0', { zero: true }), { num: 0n, den: 1n });
  assert.equal(parseV2Usd(15 as unknown as string), null, 'a number is not stored text');
  assert.throws(() => parseV2Usd(1.5 as unknown as string), RangeError);
});

test('C-3: the option-less product row is stored under o:*, and only the two mapping functions know it', () => {
  assert.equal(PRODUCT_SKU_ROW_KEY, 'o:*');
  assert.equal(storedSkuKey(PRODUCT_COMBO_KEY), 'o:*');
  assert.equal(skuKeyOfStored('o:*'), '');
  for (const k of ['o:a', 'o:a|c:b', 'c:x']) {
    assert.equal(storedSkuKey(k), k);
    assert.equal(skuKeyOfStored(k), k);
  }
  assert.equal(skuComboKey({ option_value_ids: [], color_id: null }), '', 'the canonical key is unchanged');
  // The 0183 CHECK: length 3…400 and GLOB 'o:?*' or 'c:?*'.
  assert.ok(/^(o:.+|c:.+)$/.test(storedSkuKey('')) && storedSkuKey('').length >= 3);
  assert.deepEqual(parseSkuComboKey('o:*'), { option_value_ids: ['*'], color_id: null }, 'an older reader sees an option id no selection carries');
});

/* --------------------------------------------- 2. the property (4,000) -- */

/** The LCG of pricingCostToPriceUsd.test.ts, computed exactly in BigInt: the float
 * version loses bits above 2^53 and cycles after about 14,000 draws. */
function lcg(seed: bigint) {
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245n + 12345n) % 2147483648n;
    return Number(state) / 2147483648;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const dec = (lo: number, hi: number, places: number) => {
    const whole = int(lo, hi);
    if (!places) return String(whole);
    const frac = String(int(0, 10 ** places - 1)).padStart(places, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : String(whole);
  };
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  return { rnd, int, dec, pick };
}

type Q = readonly [bigint, bigint];
const q = (t: string): Q => {
  const neg = t.startsWith('-');
  const [i, f = ''] = t.replace(/^[+-]/, '').split('.');
  const n = BigInt(`${i}${f}`);
  return [neg ? -n : n, 10n ** BigInt(f.length)];
};
const qi = (n: number | bigint): Q => [BigInt(n), 1n];
const qAdd = (a: Q, b: Q): Q => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const qSub = (a: Q, b: Q): Q => qAdd(a, [-b[0], b[1]]);
const qMul = (a: Q, b: Q): Q => [a[0] * b[0], a[1] * b[1]];
const qCmp = (a: Q, b: Q) => {
  const l = a[0] * b[1];
  const r = b[0] * a[1];
  return l < r ? -1 : l > r ? 1 : 0;
};
/** The rounding rule (row 245), independently: above 1,000 up to the next 250, else up to whole dinars. */
const qCeilStep = (a: Q): number => {
  const step = a[0] > 1000n * a[1] ? 250n : 1n;
  const d = a[1] * step;
  const fl = a[0] / d;
  return Number((a[0] % d === 0n ? fl : fl + 1n) * step);
};

interface Gen {
  method: V2Method;
  U: string;
  E: string;
  C: string;
  ship: Record<ShippingProfile, string>;
  base: { amount: string; currency: SupplierCurrency; profile: ShippingProfile; weight: number; box: [number, number, number] | null; additional: number };
  modelInputs: Record<string, { amount?: string; weight?: number }>;
  T: string;
  withChain: boolean;
  skus: Array<{ model: string | null; colour: string | null; channels: SkuChannel[] }>;
  points: V2PricePoint[];
  discounts: V2Discount[];
}

function generate(g: ReturnType<typeof lcg>): Gen {
  const { int, dec, pick, rnd } = g;
  const method: V2Method = rnd() < 0.5 ? 'cost' : 'usd';
  const models = Array.from({ length: int(0, 3) }, (_, i) => `m${i}`);
  const colours = Array.from({ length: int(0, 2) }, (_, i) => `c${i}`);
  const eFrac = String(int(0, 400000)).padStart(6, '0').replace(/0+$/, '');
  const signed = (lo: number, hi: number) => {
    const v = dec(lo, hi, int(0, 2));
    const nonZero = /^0(\.0*)?$/.test(v) ? '1' : v;
    return pick(['-', '+', '']) + nonZero;
  };
  const skus: Gen['skus'] = [];
  for (const model of models.length ? models : [null]) {
    for (const colour of colours.length ? colours : [null]) {
      const channels: SkuChannel[] = [];
      if (rnd() < 0.8) channels.push('direct_sale');
      for (const c of ['pre_order_air', 'pre_order_sea', 'pre_order_land'] as const) if (rnd() < 0.45) channels.push(c);
      skus.push({ model, colour, channels: channels.length ? channels : ['direct_sale'] });
    }
  }
  const points: V2PricePoint[] = [];
  if (method === 'usd' && rnd() < 0.95) points.push({ scope: 'product', scope_id: '', kind: 'fixed', usd: dec(1, 3000, int(0, 2)) });
  for (const m of models) {
    const r = rnd();
    if (r < 0.3) points.push({ scope: 'option', scope_id: m, kind: 'fixed', usd: dec(1, 3000, int(0, 2)) });
    else if (r < 0.65) points.push({ scope: 'option', scope_id: m, kind: 'delta', usd: signed(0, 400) });
  }
  for (const c of colours) if (rnd() < 0.5) points.push({ scope: 'color', scope_id: c, kind: 'delta', usd: signed(0, 60) });
  for (const s of skus) {
    const key = skuComboKey({ option_value_ids: s.model ? [s.model] : [], color_id: s.colour });
    if (key && rnd() < 0.1) points.push({ scope: 'sku', scope_id: key, kind: 'fixed', usd: dec(1, 3000, int(0, 2)) });
  }
  const discounts: V2Discount[] = [];
  if (rnd() < 0.8) discounts.push({ scope: 'product', scope_id: '', usd: dec(0, 400, int(0, 2)) });
  for (const m of models) if (rnd() < 0.3) discounts.push({ scope: 'option', scope_id: m, usd: dec(0, 400, int(0, 2)) });
  for (const c of colours) if (rnd() < 0.2) discounts.push({ scope: 'color', scope_id: c, usd: dec(0, 400, int(0, 2)) });
  for (const s of skus) {
    const key = skuComboKey({ option_value_ids: s.model ? [s.model] : [], color_id: s.colour });
    if (key && rnd() < 0.1) discounts.push({ scope: 'sku', scope_id: key, usd: dec(0, 400, int(0, 2)) });
  }
  const modelInputs: Gen['modelInputs'] = {};
  for (const m of models) {
    modelInputs[m] = {};
    if (rnd() < 0.4) modelInputs[m].amount = dec(1, 2000, int(0, 2));
    if (rnd() < 0.3) modelInputs[m].weight = int(100, 60000);
  }
  return {
    method,
    U: dec(1200, 2400, int(0, 4)),
    E: eFrac ? `1.${eFrac}` : '1',
    C: `0.1${String(int(1, 999999999)).padStart(9, '0')}`.replace(/0+$/, ''),
    ship: { GERMANY_LAND: dec(500, 30000, int(0, 2)), CHINA_AIR: dec(500, 40000, int(0, 2)), CHINA_SEA: dec(50000, 900000, int(0, 2)) },
    base: {
      amount: dec(1, 2000, int(0, 2)),
      currency: pick(['USD', 'EUR', 'CNY'] as const),
      profile: pick(['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'] as const),
      weight: int(100, 60000),
      box: rnd() < 0.9 ? [int(50, 1500), int(50, 1500), int(50, 1500)] : null,
      additional: int(0, 50000),
    },
    modelInputs,
    T: dec(1, 500, int(0, 2)),
    withChain: method === 'cost' || rnd() < 0.5,
    skus,
    points,
    discounts,
  };
}

function inputOf(gen: Gen, over: Partial<V2Input> = {}): V2Input {
  const rates = chainRates(gen.U, gen.E, gen.C, gen.ship);
  const base: PricingInputRow = {
    supplier_cost: gen.base.amount,
    supplier_currency: gen.base.currency,
    shipping_profile: gen.base.profile,
    shipping_weight_g: gen.base.weight,
    additional_cost_iqd: gen.base.additional,
    ...(gen.base.box ? { shipping_length_mm: gen.base.box[0], shipping_width_mm: gen.base.box[1], shipping_height_mm: gen.base.box[2] } : {}),
  };
  const skus: V2Sku[] = gen.skus.map((s) => {
    const option_value_ids = s.model ? [s.model] : [];
    const own = s.model ? gen.modelInputs[s.model] : undefined;
    const override: PricingInputRow = {
      ...(own?.amount ? { supplier_cost: own.amount } : {}),
      ...(own?.weight ? { shipping_weight_g: own.weight } : {}),
    };
    return {
      combo_key: skuComboKey({ option_value_ids, color_id: s.colour }),
      model_id: s.model,
      option_value_ids,
      color_id: s.colour,
      channels: s.channels,
      ...(gen.withChain
        ? { chain: { base: { override: base }, options: s.model && Object.keys(override).length ? [{ scope_id: s.model, override }] : [] } }
        : {}),
      target: usdTarget(gen.T),
    };
  });
  return {
    method: gen.method,
    rates,
    points: gen.points,
    discounts: gen.discounts,
    skus,
    ...over,
  };
}

type Expected = { price: number; floor: string; anchor: string; discount: string | null; below: boolean; belowMin: boolean; direct: number } | { error: string };

/** An independent oracle: the §1.3 algorithm on the generator's own fields, in plain BigInt pairs. */
function oracle(gen: Gen, input: V2Input): Map<string, Map<SkuChannel, Expected>> {
  const U = q(gen.U);
  const out = new Map<string, Map<SkuChannel, Expected>>();
  const fx = q(input.rates.fx[gen.base.currency]!.rate!);
  const R = (s: Gen['skus'][number], profile: ShippingProfile): Q | string => {
    const own = s.model ? gen.modelInputs[s.model] : undefined;
    const amount = q(own?.amount ?? gen.base.amount);
    const weight = own?.weight ?? gen.base.weight;
    let ship: Q;
    if (profile === 'CHINA_SEA') {
      if (!gen.base.box) return 'CBM_MISSING';
      const [l, w, h] = gen.base.box;
      ship = qMul(q(gen.ship.CHINA_SEA), [BigInt(l * w * h), 1_000_000_000n]);
    } else ship = qMul(q(gen.ship[profile]), [BigInt(weight), 1000n]);
    return qAdd(qAdd(qMul(amount, fx), ship), qi(gen.base.additional));
  };
  const T = qMul(q(gen.T), U);
  const usd = (p: { usd: string }) => q(p.usd);
  for (const s of gen.skus) {
    const key = skuComboKey({ option_value_ids: s.model ? [s.model] : [], color_id: s.colour });
    const rows = new Map<SkuChannel, Expected>();
    out.set(key, rows);
    const all = (error: string) => s.channels.forEach((c) => rows.set(c, { error }));
    const skuFixed = key ? gen.points.find((p) => p.scope === 'sku' && p.scope_id === key) : undefined;
    const modelPoint = s.model ? gen.points.find((p) => p.scope === 'option' && p.scope_id === s.model) : undefined;
    const productPoint = gen.points.find((p) => p.scope === 'product');
    const colourPoint = s.colour ? gen.points.find((p) => p.scope === 'color' && p.scope_id === s.colour) : undefined;
    const rStock = gen.withChain ? R(s, gen.base.profile) : null;
    if (gen.method === 'cost' && typeof rStock === 'string') {
      all(rStock);
      continue;
    }
    const floorTo = gen.method === 'cost' ? qAdd(rStock as Q, T) : null;
    let anchor: string;
    let base: Q;
    if (skuFixed) [anchor, base] = ['sku_fixed', qMul(usd(skuFixed), U)];
    else if (modelPoint?.kind === 'fixed') [anchor, base] = ['model_fixed', qMul(usd(modelPoint), U)];
    else if (gen.method === 'usd') {
      if (!productPoint) {
        all('V2_PRICE_MISSING');
        continue;
      }
      [anchor, base] = ['product_fixed', qMul(usd(productPoint), U)];
    } else [anchor, base] = ['cost', floorTo!];
    let sum: Q = qi(0);
    if (!skuFixed) {
      if (modelPoint?.kind === 'delta') sum = qAdd(sum, usd(modelPoint));
      if (colourPoint) sum = qAdd(sum, usd(colourPoint));
    }
    let eD = qAdd(base, qMul(sum, U));
    let dFloor = 'none';
    if (floorTo && qCmp(eD, floorTo) < 0) [eD, dFloor] = [floorTo, 'direct_min_profit'];
    if (eD[0] <= 0n) {
      all('V2_PRICE_MISSING');
      continue;
    }
    const D = qCeilStep(eD);
    // Q3: price-first, the direct price below R_stock + T (both known) — on every channel of the SKU.
    const belowMin = gen.method === 'usd' && rStock !== null && typeof rStock !== 'string' && qCmp(eD, qAdd(rStock, T)) < 0;
    const sellsDirect = s.channels.includes('direct_sale');
    const won =
      (key ? gen.discounts.find((d) => d.scope === 'sku' && d.scope_id === key) : undefined) ??
      (s.colour ? gen.discounts.find((d) => d.scope === 'color' && d.scope_id === s.colour) : undefined) ??
      (s.model ? gen.discounts.find((d) => d.scope === 'option' && d.scope_id === s.model) : undefined) ??
      gen.discounts.find((d) => d.scope === 'product');
    const delta = sellsDirect && won ? usd(won) : qi(0);
    for (const c of s.channels) {
      const route = routeOfChannel(c);
      if (!route) {
        const below = gen.method === 'usd' && rStock !== null && typeof rStock !== 'string' && qCmp(eD, rStock) < 0;
        rows.set(c, { price: D, floor: dFloor, anchor, discount: null, below, belowMin, direct: D });
        continue;
      }
      const rR = gen.withChain ? R(s, ROUTE_PROFILE[route]) : null;
      if (gen.method === 'cost' && typeof rR === 'string') {
        rows.set(c, { error: rR });
        continue;
      }
      const eP = qSub(eD, qMul(delta, U));
      if (eP[0] <= 0n) {
        rows.set(c, { error: 'V2_DISCOUNT_TOO_LARGE' });
        continue;
      }
      let price = qCeilStep(eP);
      let floor = dFloor;
      if (gen.method === 'cost') {
        const r = rR as Q;
        // Q1 (review 2026-10-14): the cost rounded by the rule is the line — a route never sells AT its cost rounded up.
        const rStep = qCeilStep(r);
        if (rStep >= D) {
          rows.set(c, { error: 'V2_ROUTE_BELOW_COST' });
          continue;
        }
        if (price <= rStep) [price, floor] = [D, 'discount_withdrawn']; // Q1: never lifted to the cost
      }
      const below = gen.method === 'usd' && rR !== null && typeof rR !== 'string' && qCmp(eP, rR) < 0;
      const discountText = sellsDirect && won ? won.usd : '0';
      rows.set(c, { price, floor, anchor, discount: discountText, below, belowMin, direct: D });
    }
  }
  return out;
}

/** Canonical text of a rational whose denominator is a power of ten (every sum of decimals here). */
const qText = ([n, d]: Q): string => {
  const places = d.toString().length - 1;
  assert.equal(10n ** BigInt(places), d, 'a power of ten');
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};
const usdText = (t: string) => qText(q(t));

test('property (4,000 SKUs): exactly the oracle; P ≤ D; on the rounding rule; D − R ≥ T; a floored route sells at D (Q1); the Q3 warning; monotone discounts; colour moves every model alike', () => {
  const g = lcg(20261013n);
  let skuCount = 0;
  const seen = { anchor: new Map<string, number>(), floor: new Map<string, number>(), error: new Map<string, number>(), below: 0, belowMin: 0, monotone: 0, colour: 0, products: 0 };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  while (skuCount < 4000) {
    const gen = generate(g);
    const input = inputOf(gen);
    const r = priceProductV2(input);
    const want = oracle(gen, input);
    seen.products++;
    for (const s of r.skus) {
      skuCount++;
      const exp = want.get(s.combo_key)!;
      for (const [channel, e] of exp) {
        const got = s.channels.find((c) => c.channel === channel);
        const where = `product ${seen.products} ${s.combo_key} ${channel} (${gen.method})`;
        if ('error' in e) {
          assert.equal(got, undefined, `${where}: priced, expected ${e.error}`);
          assert.ok(s.issues.some((i) => i.severity === 'error' && i.channel === channel && i.code === e.error), `${where}: ${e.error} not in ${JSON.stringify(s.issues)}`);
          bump(seen.error, e.error);
          continue;
        }
        assert.ok(got, `${where}: not priced: ${JSON.stringify(s.issues)}`);
        assert.equal(got.price_iqd, e.price, `${where}: price`);
        assert.equal(got.direct_iqd, e.direct, `${where}: D`);
        assert.equal(got.floor, e.floor, `${where}: floor`);
        assert.equal(got.anchor, e.anchor, `${where}: anchor`);
        assert.equal(got.discount_usd, e.discount === null ? null : usdText(e.discount), `${where}: discount`);
        assert.equal(got.below_cost, e.below, `${where}: below_cost`);
        assert.equal(got.below_min_profit, e.belowMin, `${where}: below_min_profit`);
        bump(seen.anchor, got.anchor);
        bump(seen.floor, got.floor);
        if (got.below_cost) seen.below++;
        if (got.below_min_profit) seen.belowMin++;

        // The owner's rules, checked from the outside.
        assert.ok(got.price_iqd <= got.direct_iqd, `${where}: P ≤ D`);
        assert.ok(got.price_iqd >= 1 && (got.price_iqd <= 1000 || got.price_iqd % 250 === 0), `${where}: on the rounding rule`);
        const exact = q(got.exact_iqd);
        assert.equal(qCeilStep(exact), got.price_iqd, `${where}: price = ceil(exact)`);
        if (gen.method === 'cost') {
          const stock = s.channels.find((c) => c.channel === 'direct_sale')?.replacement ?? null;
          const rStock = stock ? q(stock.replacement_exact) : null;
          if (rStock) assert.ok(qCmp(qSub(qi(got.direct_iqd), rStock), qMul(q(gen.T), q(gen.U))) >= 0, `${where}: D − R_stock ≥ T × U`);
          if (routeOfChannel(channel)) {
            const rR = q(got.replacement!.replacement_exact);
            const eP = qSub(q(got.direct_exact_iqd), qMul(q(got.discount_usd!), q(gen.U)));
            assert.ok(got.price_iqd === qCeilStep(eP) || got.price_iqd === got.direct_iqd, `${where}: P ∈ {ceil(E_P), D}`);
            assert.ok(qCmp(qi(got.price_iqd), rR) >= 0, `${where}: never below R_r`);
            assert.ok(got.floor !== 'discount_withdrawn' || got.price_iqd === got.direct_iqd, `${where}: a floored route sells at D (Q1)`);
          }
          assert.equal(got.below_min_profit, false, `${where}: cost-first never carries the price-first warning`);
        } else {
          assert.equal(got.floor, 'none', 'price-first never floors');
          assert.equal(qCmp(qMul(q(got.usd_exact!), q(gen.U)), exact), 0, `${where}: exact = USD × U`);
        }
        if (got.anchor === 'sku_fixed') assert.equal(got.deltas_usd, '0', `${where}: a SKU price ignores differences`);
      }
    }

    // Monotone: every discount larger by k ⇒ no route dearer (a withdrawn discount sells at D, by design).
    if (gen.discounts.length) {
      const k = q(g.dec(0, 100, 2).replace(/^0$/, '0.01'));
      const larger = gen.discounts.map((d) => ({ ...d, usd: qText(qAdd(q(d.usd), k)) }));
      const r2 = priceProductV2(inputOf(gen, { discounts: larger }));
      for (const [i, s] of r.skus.entries()) {
        for (const c1 of s.channels) {
          const c2 = r2.skus[i].channels.find((x) => x.channel === c1.channel);
          if (!c2 || !routeOfChannel(c1.channel)) continue;
          if (c2.floor === 'discount_withdrawn' && c1.floor !== 'discount_withdrawn') assert.equal(c2.price_iqd, c2.direct_iqd);
          else assert.ok(c2.price_iqd <= c1.price_iqd, `monotone: ${s.combo_key} ${c1.channel} ${c1.price_iqd} → ${c2.price_iqd}`);
          seen.monotone++;
        }
      }
    }

    // A colour difference moves every model's D by the same USD (C1): within one rounding (< 250) of γ × U.
    const colourPoints = gen.points.filter((p) => p.scope === 'color');
    if (colourPoints.length) {
      const r3 = priceProductV2(inputOf(gen, { points: gen.points.filter((p) => p.scope !== 'color') }));
      for (let i = 0; i < r.skus.length; i++) {
        const sku = input.skus[i];
        const gamma = colourPoints.find((p) => p.scope_id === sku.color_id);
        // Cost-first, a lifted D shows on the direct channel only (a route shows its own floor first).
        const first = (x: V2Result) => (gen.method === 'usd' ? x.skus[i].channels[0] : x.skus[i].channels.find((c) => c.channel === 'direct_sale'));
        const a = first(r);
        const b = first(r3);
        if (!gamma || !a || !b || a.anchor === 'sku_fixed' || a.floor === 'direct_min_profit' || b.floor === 'direct_min_profit') continue;
        const moved = qSub(qi(a.direct_iqd), qi(b.direct_iqd));
        const gu = qMul(q(gamma.usd), q(gen.U));
        assert.ok(qCmp(qSub(moved, gu), qi(-250)) > 0 && qCmp(qSub(moved, gu), qi(250)) < 0, `colour ${gamma.usd}: D moved ${a.direct_iqd - b.direct_iqd}`);
        seen.colour++;
      }
    }
  }
  // Not vacuous: every branch was taken.
  for (const a of ['sku_fixed', 'model_fixed', 'product_fixed', 'cost']) assert.ok((seen.anchor.get(a) ?? 0) >= 20, `anchor ${a}: ${seen.anchor.get(a)}`);
  for (const f of ['none', 'discount_withdrawn', 'direct_min_profit']) assert.ok((seen.floor.get(f) ?? 0) >= 10, `floor ${f}: ${seen.floor.get(f)}`);
  assert.ok(!seen.floor.has('lifted_to_cost'), 'Q1: no route is ever lifted to its cost');
  for (const e of ['V2_PRICE_MISSING', 'V2_DISCOUNT_TOO_LARGE', 'V2_ROUTE_BELOW_COST', 'CBM_MISSING']) assert.ok((seen.error.get(e) ?? 0) >= 3, `error ${e}: ${seen.error.get(e)}`);
  assert.ok(seen.below >= 10, `below_cost: ${seen.below}`);
  assert.ok(seen.belowMin >= 10, `below_min_profit: ${seen.belowMin}`);
  assert.ok(seen.monotone >= 500, `monotone pairs: ${seen.monotone}`);
  assert.ok(seen.colour >= 200, `colour pairs: ${seen.colour}`);
});

/* ------------------------------------------------------- 5. no float -- */

test('no float: a fractional JS number anywhere in the input is a RangeError, never a price', () => {
  const ok = () => inputOfWorked();
  assert.doesNotThrow(() => priceProductV2(ok()));
  const cases: Array<[string, (i: V2Input) => void]> = [
    ['a point', (i) => ((i.points as V2PricePoint[])[0] = { ...i.points[0], usd: 2.5 as unknown as string })],
    ['a discount', (i) => ((i.discounts as V2Discount[])[0] = { ...i.discounts[0], usd: 50.5 as unknown as string })],
    ['U', (i) => (i.rates = { ...i.rates, fx: { ...i.rates.fx, USD: { rate: 1500.5 as unknown as string, version: 1, confirmed: true } } })],
    ['a shipping rate', (i) => (i.rates = { ...i.rates, shipping: { ...i.rates.shipping, GERMANY_LAND: { rate: 9000.5 as unknown as string, version: 1, confirmed: true } } })],
    ['a weight', (i) => ((i.skus as V2Sku[])[0] = { ...i.skus[0], chain: { base: { override: { ...STANDARD_INPUTS, shipping_weight_g: 22000.5 } } } })],
  ];
  for (const [what, spoil] of cases) {
    const input = ok();
    spoil(input);
    assert.throws(() => priceProductV2(input), RangeError, what);
  }
});

function inputOfWorked(): V2Input {
  return {
    method: 'cost',
    rates: chainRates('1500', '1.08', '0.14', { GERMANY_LAND: '9000', CHINA_AIR: '20000', CHINA_SEA: '300000' }),
    points: [...WORKED_POINTS],
    discounts: [...WORKED_DISCOUNTS],
    skus: [workedSku('std', null), workedSku('combo', 'red')],
  };
}

test('programming errors throw: a combo key that is not its selection, a SKU listed twice, the Direct Sale Extra passed as the profit', () => {
  const base = inputOfWorked();
  assert.throws(() => priceProductV2({ ...base, skus: [{ ...base.skus[0], combo_key: 'o:other' }] }), /PRICING_INVARIANT/);
  assert.throws(() => priceProductV2({ ...base, skus: [base.skus[0], base.skus[0]] }), /PRICING_INVARIANT/);
  assert.throws(() => priceProductV2({ ...base, skus: [{ ...base.skus[0], model_id: 'nope' }] }), /PRICING_INVARIANT/);
  const extra: RuleResolution = { status: 'active', kind: 'direct_sale_extra', amount_iqd: 0, rule: ref('x'), tie: false, candidates: [ref('x')] };
  assert.throws(() => priceProductV2({ ...base, skus: [{ ...base.skus[0], target: extra }] }), /PRICING_INVARIANT/);
  // One rounding rule (row 245): a caller passing its own step is a programming error, never a second rule.
  assert.throws(() => priceProductV2({ ...base, step: 1000 } as V2Input), /PRICING_INVARIANT/);
});
