/**
 * PRODUCT DISCOUNT — THE PURE RESOLVER (docs/ux/PRODUCT-DISCOUNT.md §4, §9, §12 "Server: pure").
 *
 * A dollar sale price (`fixed_usd`, 0197) is converted at the SKU's OWN V2 rate, rounded UP to the
 * 1,000 IQD step Pricing V2 publishes with, and a pre-order route keeps the same IQD saving. It is
 * never ≥ before (D4): no strike, no badge, no error. `offer_before_iqd` (the struck price) is set only
 * when a window lowered the line, a member label names a rung only below the offer (F5), the bundle
 * mirror ignores `fixed_usd`, and every call site of `applyOfferToResolved` passes its document.
 *
 * Run: npx tsx --test tests/productDiscountResolver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveUnitPrice, type ResolvedPrice, type SkuPriceRow, type Tier } from '../worker/lib/pricing';
import { applyOfferToResolved, fixedUsdAnswerFor, resolveOfferPrice, windowFromRow, type OfferWindow } from '../worker/lib/offers';
import { centsOfUsdText, fixedUsdLine, offerSavingPercent, usdTextOfCents, usdToIqdCeil } from '../worker/lib/offerUsd';
import { customerLinePrice, customerOrderPricing, offerLabelTier } from '../worker/lib/customerPricing';
import { buyerClassOf } from '../worker/lib/protectionClaims';

const NOW = Date.parse('2026-10-16T12:00:00Z');

/* ----------------------------------------------------------- the world -- */

/** P1S ($600) and P1S Combo ($750), direct and by land (Δ $50), at the rate given — §4.4's worked numbers. */
function printer(rate = '1500', prices = { p1s: 900_000, p1sLand: 825_000, combo: 1_125_000, comboLand: 1_050_000 }, over: Record<string, unknown> = {}) {
  const row = (combo: string, channel: string, iqd: number): SkuPriceRow => ({ combo_key: combo, channel, regular_price_iqd: iqd, v2: true, usd_iqd_rate: rate });
  return {
    price_iqd: prices.combo,
    prime_price_iqd: null,
    pro_price_iqd: null,
    product_cost_iqd: null,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale', 'pre_order'],
    options: [
      { id: 'm1', name_en: 'P1S', name_ar: 'P1S', active: true },
      { id: 'm2', name_en: 'P1S Combo', name_ar: 'P1S Combo', active: true },
    ],
    colors: [],
    preorder_transports: [{ method: 'land', commission_iqd: 0, active: true }],
    warranty_plans: [],
    sku_strict: true,
    sku_prices: [
      row('o:m1', 'direct_sale', prices.p1s),
      row('o:m1', 'pre_order_land', prices.p1sLand),
      row('o:m2', 'direct_sale', prices.combo),
      row('o:m2', 'pre_order_land', prices.comboLand),
    ],
    ...over,
  };
}

type Doc = ReturnType<typeof printer>;

const line = (doc: Doc, model: 'm1' | 'm2', how: 'direct' | 'land' | 'land_cod' = 'direct', tier: Tier = 'free', tierActive = false, over: Record<string, unknown> = {}): ResolvedPrice =>
  resolveUnitPrice({
    product: doc as never,
    optionId: model,
    transportMethod: how === 'direct' ? null : 'land',
    fulfillmentType: how === 'direct' ? 'direct_sale' : 'pre_order',
    preorderPricing: how === 'land_cod' ? 'cod' : 'prepaid',
    tier,
    tierActive,
    ...over,
  });

const window = (over: Partial<OfferWindow> = {}): OfferWindow => ({
  id: 'ofw_p1',
  starts_at: null,
  ends_at: null,
  required_tiers: [],
  offer_price_mode: 'fixed_usd',
  offer_price_iqd: null,
  discount_percent: null,
  discount_iqd: null,
  plus_price_iqd: null,
  locked_preview: true,
  active: true,
  usd_prices: [],
  ...over,
});

const perModel = (p1s: number | null, combo: number | null) =>
  window({
    usd_prices: [
      ...(p1s === null ? [] : [{ model_id: 'm1', cents: p1s }]),
      ...(combo === null ? [] : [{ model_id: 'm2', cents: combo }]),
    ],
  });

const apply = (r: ResolvedPrice, w: OfferWindow, doc: Doc | null, tier: Tier = 'free', tierActive = false) =>
  applyOfferToResolved(r, { window: w, limits: null }, tier, tierActive, NOW, doc);

/* ------------------------------------------------------- fixedUsdLine -- */

test('§4.4 worked numbers: rate, rounding up to 1,000, the same IQD saving on a route, D4', () => {
  const cases: Array<[string, number, number, number, number, number | null, number | null]> = [
    // [U, cents, directIqd, channelIqd, expected regular | null (none), expected badge on that channel]
    ['1500', 50_000, 900_000, 900_000, 750_000, 17, null],
    ['1500', 50_000, 900_000, 825_000, 675_000, 18, null],
    ['1500', 64_000, 1_125_000, 1_125_000, 960_000, 15, null],
    ['1500', 64_000, 1_125_000, 1_050_000, 885_000, 16, null],
    ['1530', 50_000, 918_000, 918_000, 765_000, 17, null],
    ['1530', 50_000, 918_000, 842_000, 689_000, 18, null],
    ['1530', 64_000, 1_148_000, 1_148_000, 980_000, 15, null],
    ['1527.5', 50_000, 917_000, 917_000, 764_000, 17, null],
    ['1500', 59_950, 900_000, 900_000, null, null, null],
  ].map(([u, c, d, ch, exp, badge]) => [u, c, d, ch, exp, badge, null] as never);
  for (const [u, cents, direct, channel, expected, badge] of cases) {
    const out = fixedUsdLine({ cents, rate: u, directIqd: direct, channelIqd: channel });
    if (expected === null) {
      assert.deepEqual(out, { kind: 'none' }, `${u} × ${cents}: not below the before price — no sale (D4)`);
      continue;
    }
    assert.deepEqual(out, { kind: 'price', regular_iqd: expected }, `${u} × ${cents} on ${channel}`);
    assert.equal(offerSavingPercent(channel, expected), badge, `badge of ${channel} → ${expected}`);
  }
  // The badge rounds to the nearest whole percent (D9): 16.67 → 17, 14.67 → 15.
  assert.equal(offerSavingPercent(900_000, 750_000), 17);
  assert.equal(offerSavingPercent(1_125_000, 960_000), 15);
  assert.equal(offerSavingPercent(900_000, 899_000), null, 'below 1 → no badge');
  assert.equal(offerSavingPercent(null, 750_000), null);
});

test('fractional rates convert exactly, and every answer is a multiple of 1,000', () => {
  assert.equal(usdToIqdCeil(50_000, '1527.5'), 764_000);
  assert.equal(usdToIqdCeil(50_000, '1530.25'), 766_000); // 765,125 → 766,000
  assert.equal(usdToIqdCeil(1, '1530.25'), 1_000, 'one cent is still at least one step');
  assert.equal(usdToIqdCeil(10_000_000, '1500'), 150_000_000, '$100,000.00 — the 0189 ceiling');
  assert.equal(usdToIqdCeil(50_000, '0'), null, 'a zero rate is no rate');
  assert.equal(usdToIqdCeil(50_000, '1e3'), null, 'an exponent is not a stored rate');
  assert.equal(usdToIqdCeil(50_000, null), null);
  for (const cents of [1, 99, 12_345, 59_999, 10_000_000]) {
    for (const rate of ['1500', '1527.5', '1530.25', '1309.123456']) {
      const v = usdToIqdCeil(cents, rate)!;
      assert.equal(v % 1000, 0, `${cents} × ${rate} is on the 1,000 step`);
    }
  }
});

test('none: a missing model row, a missing rate, a missing direct row (a V1 row has no rate)', () => {
  assert.deepEqual(fixedUsdLine({ cents: null, rate: '1500', directIqd: 900_000, channelIqd: 900_000 }), { kind: 'none' });
  assert.deepEqual(fixedUsdLine({ cents: 50_000, rate: null, directIqd: 900_000, channelIqd: 900_000 }), { kind: 'none' });
  assert.deepEqual(fixedUsdLine({ cents: 50_000, rate: '1500', directIqd: null, channelIqd: 825_000 }), { kind: 'none' });
  assert.deepEqual(fixedUsdLine({ cents: 60_000, rate: '1500', directIqd: 900_000, channelIqd: 900_000 }), { kind: 'none' }, 'equal is not lower');
  assert.deepEqual(fixedUsdLine({ cents: 70_000, rate: '1500', directIqd: 900_000, channelIqd: 900_000 }), { kind: 'none' }, 'above is not lower');
  // A V1 SKU row carries no rate: the line prices nothing.
  const v1 = printer();
  v1.sku_prices = v1.sku_prices.map(({ usd_iqd_rate: _r, v2: _v, ...rest }) => rest) as never;
  const r = line(v1, 'm1');
  assert.deepEqual(fixedUsdAnswerFor(r, perModel(50_000, 64_000), v1 as never), { kind: 'none' });
});

test('below_floor: a route whose saving reaches its own price', () => {
  // D = 900,000, a route P = 150,000 (absurd but possible), a sale saving 750,000 → P − saving < 1.
  assert.deepEqual(fixedUsdLine({ cents: 10_000, rate: '1500', directIqd: 900_000, channelIqd: 150_000 }), { kind: 'below_floor' });
  assert.deepEqual(fixedUsdLine({ cents: 10_000, rate: '1500', directIqd: 900_000, channelIqd: 750_000 }), { kind: 'below_floor' }, 'exactly 0 is below the floor');
  assert.deepEqual(fixedUsdLine({ cents: 10_000, rate: '1500', directIqd: 900_000, channelIqd: 751_000 }), { kind: 'price', regular_iqd: 1_000 });
});

test('no float anywhere: random cents × random decimal rates agree with a BigInt reference', () => {
  let seed = 20261016;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 2000; i += 1) {
    const cents = 1 + Math.floor(rand() * 10_000_000);
    const whole = 1000 + Math.floor(rand() * 2000);
    const frac = Math.floor(rand() * 10_000);
    const rate = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(4, '0').replace(/0+$/, '')}`;
    // Reference: cents × rate × 10^4 / (100 × 10^4), ceil to 1,000 — all BigInt.
    const [ri, rf = ''] = rate.split('.');
    const scale = 10n ** BigInt(rf.length);
    const rateScaled = BigInt(ri) * scale + BigInt(rf || '0');
    const num = BigInt(cents) * rateScaled;
    const den = 100n * scale * 1000n;
    const steps = num / den + (num % den > 0n ? 1n : 0n);
    assert.equal(usdToIqdCeil(cents, rate), Number(steps * 1000n), `${cents} × ${rate}`);
  }
});

test('typed dollars: two decimals, > 0, ≤ 100,000; a JSON float throws; cents print back', () => {
  assert.equal(centsOfUsdText('500'), 50_000);
  assert.equal(centsOfUsdText('500.5'), 50_050);
  assert.equal(centsOfUsdText('599.50'), 59_950);
  assert.equal(centsOfUsdText('0.01'), 1);
  assert.equal(centsOfUsdText('100000'), 10_000_000);
  for (const bad of ['500.123', '0', '-5', '100000.01', '1e3', ' 500', '', 'abc', '5,00']) assert.equal(centsOfUsdText(bad), null, bad);
  assert.equal(centsOfUsdText(500), null, 'a JSON whole number is not text');
  assert.throws(() => centsOfUsdText(500.5), RangeError, 'a JSON fraction is a binary float');
  assert.equal(usdTextOfCents(50_000), '500.00');
  assert.equal(usdTextOfCents(59_950), '599.50');
  assert.equal(usdTextOfCents(1), '0.01');
});

/* ------------------------------------------------ the resolver itself -- */

test('fixed_usd: a model row prices its model; an uncovered model sells at its price with no strike and no error', () => {
  const doc = printer();
  const w = perModel(50_000, null);
  const p1s = apply(line(doc, 'm1'), w, doc);
  assert.equal(p1s.source, 'offer');
  assert.equal(p1s.resolved.regular_iqd, 750_000);
  assert.equal(p1s.resolved.applied_iqd, 750_000);
  assert.equal(p1s.resolved.offer_before_iqd, 900_000);
  assert.equal(p1s.resolved.unit_subtotal_iqd, 750_000);
  const combo = apply(line(doc, 'm2'), w, doc);
  assert.equal(combo.source, 'ladder');
  assert.equal(combo.resolved.regular_iqd, 1_125_000);
  assert.equal(combo.resolved.offer_before_iqd, undefined, 'no strike on a model without a row');
  assert.deepEqual(combo.resolved.errors, []);
});

test("fixed_usd: the whole-product '' row prices every model at the same dollars", () => {
  const doc = printer('1500', { p1s: 900_000, p1sLand: 825_000, combo: 900_000, comboLand: 825_000 });
  const w = window({ usd_prices: [{ model_id: '', cents: 50_000 }] });
  for (const m of ['m1', 'm2'] as const) {
    const out = apply(line(doc, m), w, doc);
    assert.equal(out.resolved.regular_iqd, 750_000, m);
    assert.equal(out.resolved.offer_before_iqd, 900_000, m);
  }
});

test("the scope rule at READ time: a '' row prices only while every direct SKU shares one price, a model row only while its colours do", () => {
  // Saved while both models cost $600 (900,000): the whole-product row prices both.
  const w = window({ usd_prices: [{ model_id: '', cents: 50_000 }] });
  const uniform = printer('1500', { p1s: 900_000, p1sLand: 825_000, combo: 900_000, comboLand: 825_000 });
  assert.equal(apply(line(uniform, 'm2'), w, uniform).resolved.regular_iqd, 750_000);
  // The owner later reprices the Combo to $750 (1,125,000) — no offer check runs on a V2 save. The
  // stored '' row no longer has ONE before price to replace: it prices nothing, on either model, rather
  // than selling the Combo at $500 (−33%, a discount nobody typed). No strike, no error.
  const diverged = printer();
  for (const m of ['m1', 'm2'] as const) {
    for (const how of ['direct', 'land'] as const) {
      const out = apply(line(diverged, m, how), w, diverged);
      assert.equal(out.source, 'ladder', `${m} ${how}`);
      assert.equal(out.resolved.offer_before_iqd, undefined, `${m} ${how}: no strike`);
      assert.deepEqual(out.resolved.errors, []);
    }
  }
  assert.deepEqual(fixedUsdAnswerFor(line(diverged, 'm2'), w, diverged as never), { kind: 'none' });
  // A model row keeps pricing its model while that model's colours share one price; once one colour is
  // dearer, it prices none of that model's colours. The other model's row is untouched.
  const coloured = (c2: number) =>
    printer('1500', undefined, {
      colors: [
        { id: 'c1', name_en: 'Black', name_ar: 'أسود', active: true },
        { id: 'c2', name_en: 'White', name_ar: 'أبيض', active: true },
      ],
      sku_prices: [
        { combo_key: 'o:m1|c:c1', channel: 'direct_sale', regular_price_iqd: 900_000, v2: true, usd_iqd_rate: '1500' },
        { combo_key: 'o:m1|c:c2', channel: 'direct_sale', regular_price_iqd: c2, v2: true, usd_iqd_rate: '1500' },
        { combo_key: 'o:m2|c:c1', channel: 'direct_sale', regular_price_iqd: 1_125_000, v2: true, usd_iqd_rate: '1500' },
        { combo_key: 'o:m2|c:c2', channel: 'direct_sale', regular_price_iqd: 1_125_000, v2: true, usd_iqd_rate: '1500' },
      ],
    });
  const byColour = (doc: Doc, model: 'm1' | 'm2', colour: 'c1' | 'c2') =>
    resolveUnitPrice({ product: doc as never, optionId: model, colorId: colour, fulfillmentType: 'direct_sale', tier: 'free', tierActive: false });
  const pm = perModel(50_000, 64_000);
  const same = coloured(900_000);
  assert.equal(apply(byColour(same, 'm1', 'c2'), pm, same).resolved.regular_iqd, 750_000);
  const dearer = coloured(930_000);
  assert.equal(apply(byColour(dearer, 'm1', 'c1'), pm, dearer).source, 'ladder', 'P1S Black: its model row no longer has one before price');
  assert.equal(apply(byColour(dearer, 'm1', 'c2'), pm, dearer).source, 'ladder', 'P1S White');
  assert.equal(apply(byColour(dearer, 'm2', 'c2'), pm, dearer).resolved.regular_iqd, 960_000, 'the Combo row still prices the Combo');
  // A deactivated colour's leftover row does not count against the scope.
  const cols = dearer.colors as unknown as Array<{ id: string; name_en: string; name_ar: string; active: boolean }>;
  const inactive = { ...dearer, colors: [cols[0]!, { ...cols[1]!, active: false }] } as unknown as Doc;
  assert.equal(apply(byColour(inactive, 'm1', 'c1'), pm, inactive).resolved.regular_iqd, 750_000);
});

test('a prepaid route pays P − the same saving; a COD pre-order pays the direct offer price', () => {
  const doc = printer();
  const w = perModel(50_000, 64_000);
  assert.equal(apply(line(doc, 'm1', 'land'), w, doc).resolved.regular_iqd, 675_000);
  assert.equal(apply(line(doc, 'm2', 'land'), w, doc).resolved.regular_iqd, 885_000);
  const cod = line(doc, 'm1', 'land_cod');
  assert.equal(cod.sku?.channel, 'direct_sale', 'COD is priced from the direct row');
  assert.equal(cod.fulfillment.type, 'pre_order', 'and stays a pre-order');
  const out = apply(cod, w, doc);
  assert.equal(out.resolved.regular_iqd, 750_000);
  assert.equal(out.resolved.offer_before_iqd, 900_000);
});

test('the rate is the SKU row’s own: a product not yet repriced keeps its old rate for both prices', () => {
  // Mid-wave: the central rate moved to 1,530, this product still reads 1,500 on its rows.
  const old = printer('1500');
  assert.equal(apply(line(old, 'm1'), perModel(50_000, null), old).resolved.regular_iqd, 750_000);
  // Repriced: its rows say 1,530 and the new published prices.
  const repriced = printer('1530', { p1s: 918_000, p1sLand: 842_000, combo: 1_148_000, comboLand: 1_071_000 });
  const w = perModel(50_000, 64_000);
  assert.equal(apply(line(repriced, 'm1'), w, repriced).resolved.regular_iqd, 765_000);
  assert.equal(apply(line(repriced, 'm1', 'land'), w, repriced).resolved.regular_iqd, 689_000);
  assert.equal(apply(line(repriced, 'm2'), w, repriced).resolved.regular_iqd, 980_000);
});

test('a caller without the document gets no sale for fixed_usd — never a guessed price', () => {
  const doc = printer();
  const out = apply(line(doc, 'm1'), perModel(50_000, 64_000), null);
  assert.equal(out.source, 'ladder');
  assert.equal(out.resolved.regular_iqd, 900_000);
  assert.deepEqual(out.resolved.errors, []);
});

test('below the floor on a route: the line does not sell (DERIVED_PRICE_BELOW_FLOOR + OFFER_INACTIVE)', () => {
  const doc = printer('1500', { p1s: 900_000, p1sLand: 150_000, combo: 1_125_000, comboLand: 1_050_000 });
  const out = apply(line(doc, 'm1', 'land'), perModel(10_000, null), doc);
  assert.equal(out.source, 'ladder');
  assert.ok(out.resolved.errors.includes('DERIVED_PRICE_BELOW_FLOOR'));
  assert.ok(out.resolved.errors.includes('OFFER_INACTIVE'));
  assert.equal(out.resolved.offer_before_iqd, undefined);
});

test('D4 for every mode: a window price not strictly below the regular contributes nothing, without error', () => {
  const r = line(printer(), 'm1');
  const modes: Array<Partial<OfferWindow>> = [
    { offer_price_mode: 'fixed', offer_price_iqd: 900_000 },
    { offer_price_mode: 'fixed', offer_price_iqd: 950_000 },
    { offer_price_mode: 'fixed_usd', usd_prices: [{ model_id: 'm1', cents: 59_950 }] },
    { offer_price_mode: 'discount_iqd', discount_iqd: 0 },
  ];
  for (const m of modes) {
    const w = window(m);
    const usd = m.offer_price_mode === 'fixed_usd' ? fixedUsdAnswerFor(r, w, printer() as never) : undefined;
    const out = resolveOfferPrice({ base: r, window: w, scheduleState: 'live', tier: 'free', tierActive: false, ...(usd ? { usd } : {}) });
    assert.equal(out.source, 'ladder', JSON.stringify(m));
    assert.equal(out.regular_iqd, 900_000);
    assert.deepEqual(out.errors, [], 'no error: the line sells at its regular price');
  }
  // …while a real reduction in every mode still prices.
  for (const m of [
    { offer_price_mode: 'discount_percent', discount_percent: 10 },
    { offer_price_mode: 'discount_iqd', discount_iqd: 50_000 },
    { offer_price_mode: 'fixed', offer_price_iqd: 800_000 },
  ] as Array<Partial<OfferWindow>>) {
    const out = resolveOfferPrice({ base: r, window: window(m), scheduleState: 'live', tier: 'free', tierActive: false });
    assert.equal(out.source, 'offer', JSON.stringify(m));
  }
});

test('offer_before_iqd is set only when a window lowered the line (percent included — F1)', () => {
  const doc = printer();
  const r = line(doc, 'm1');
  const percent = apply(r, window({ offer_price_mode: 'discount_percent', discount_percent: 10 }), doc);
  assert.equal(percent.resolved.regular_iqd, 810_000);
  assert.equal(percent.resolved.offer_before_iqd, 900_000, 'a percent sale now strikes its before price too');
  for (const w of [
    window({ offer_price_mode: '' }),
    window({ offer_price_mode: 'discount_percent', discount_percent: 10, active: false }),
    window({ offer_price_mode: 'discount_percent', discount_percent: 10, starts_at: '2099-01-01T00:00:00Z' }),
    window({ offer_price_mode: 'discount_percent', discount_percent: 10, ends_at: '2020-01-01T00:00:00Z' }),
  ]) {
    const out = apply(r, w, doc);
    assert.equal(out.source, 'ladder');
    assert.equal(out.resolved.offer_before_iqd, undefined, JSON.stringify(w));
  }
});

test('F5: a member clamped UP to the offer price is LABELLED regular; one below it keeps the rung — the money and the buyer class never move', () => {
  const doc = printer();
  const w = perModel(50_000, null);
  // PRO 5% = 855,000 > the offer 750,000: clamped to 750,000 → «سعر العرض», not «سعر PRO».
  const pro5 = line(doc, 'm1', 'direct', 'pro', true, { proPolicy: { mode: 'global_percent', percent: 5 } });
  assert.equal(pro5.applied_iqd, 855_000, 'PRO 5% before the offer');
  const a = apply(pro5, w, doc, 'pro', true);
  assert.equal(a.resolved.applied_iqd, 750_000);
  // THE RESOLVER'S applied_tier IS THE BUYER'S PRICE CLASS, frozen into the order snapshot and read by
  // price protection (buyerClassOf): it stays 'pro' — a PRO buyer is compared against today's PRO price.
  assert.equal(a.resolved.applied_tier, 'pro', 'the price class is unchanged by the offer');
  assert.equal(buyerClassOf(a.resolved), 'pro', 'price protection still sees a PRO buyer');
  // The LABEL is display-only, derived where a customer reads it: «سعر العرض», not «سعر PRO».
  assert.equal(offerLabelTier(a.resolved), 'regular');
  assert.equal(customerLinePrice(a.resolved).applied_tier, 'regular');
  assert.equal(customerOrderPricing(JSON.parse(JSON.stringify(a.resolved)))!.applied_tier, 'regular', 'the order view derives the same label from the frozen snapshot');
  // PRO 20% = 720,000 < 750,000: the member pays 720,000 in PRO's colour.
  const pro20 = line(doc, 'm1', 'direct', 'pro', true, { proPolicy: { mode: 'global_percent', percent: 20 } });
  const b = apply(pro20, w, doc, 'pro', true);
  assert.equal(b.resolved.applied_iqd, 720_000);
  assert.equal(b.resolved.applied_tier, 'pro');
  assert.equal(offerLabelTier(b.resolved), 'pro');
  assert.equal(customerLinePrice(b.resolved).applied_tier, 'pro');
  // No offer: the label is the rung, exactly as before.
  assert.equal(offerLabelTier(pro5), 'pro');
  assert.equal(b.resolved.offer_before_iqd, 900_000);
  assert.equal(offerSavingPercent(b.resolved.offer_before_iqd, b.resolved.applied_iqd), 20);
  // The amount a member pays is exactly the resolver's clamp, label or not.
  const priced = resolveOfferPrice({ base: pro5, window: w, scheduleState: 'live', tier: 'pro', tierActive: true, usd: fixedUsdAnswerFor(pro5, w, doc as never) });
  assert.equal(priced.applied_iqd, a.resolved.applied_iqd);
});

test('F5 regression: an EXISTING percent offer keeps a PRO buyer in the PRO price class for price protection', () => {
  // A typed PRO price of 900,000 on a 1,000,000 product; a live 20% window (800,000) clamps the PRO rung
  // up to the offer price. The buyer is still a PRO buyer: a later drop to 850,000 / PRO 765,000 is a
  // 35,000 per-unit claim against today's PRO price, never a regular-price comparison.
  const product = { price_iqd: 1_000_000, prime_price_iqd: null, pro_price_iqd: 900_000, product_cost_iqd: null, selling_type: 'direct_sale', sale_types: ['direct_sale'], options: [], colors: [], preorder_transports: [], warranty_plans: [] };
  const base = resolveUnitPrice({ product: product as never, tier: 'pro', tierActive: true });
  const out = applyOfferToResolved(base, { window: window({ offer_price_mode: 'discount_percent', discount_percent: 20 }), limits: null }, 'pro', true, NOW);
  assert.equal(out.resolved.applied_iqd, 800_000);
  assert.equal(out.resolved.pro_iqd, 800_000);
  assert.equal(out.resolved.applied_tier, 'pro', 'the snapshot keeps the price class');
  assert.equal(buyerClassOf(JSON.parse(JSON.stringify(out.resolved))), 'pro');
  assert.equal(customerLinePrice(out.resolved).applied_tier, 'regular', 'the customer reads «سعر العرض»');
});

test('the SKU rung names itself on the resolved line; the ladder does not', () => {
  const r = line(printer(), 'm2', 'land');
  assert.deepEqual(r.sku, { combo_key: 'o:m2', channel: 'pre_order_land', model_id: 'm2' });
  const ladder = resolveUnitPrice({ product: { ...printer(), sku_prices: [] } as never, optionId: 'm1', tier: 'free', tierActive: false });
  assert.equal('sku' in ladder, false, 'a ladder line carries no sku key at all');
});

test('windowFromRow keeps fixed_usd; an unknown mode reads as no price', () => {
  const row = (mode: string) =>
    windowFromRow({ subject_type: 'product', subject_id: 'p', id: 'w', starts_at: null, ends_at: null, required_tiers: '[]', offer_price_mode: mode, offer_price_iqd: null, discount_percent: null, discount_iqd: null, plus_price_iqd: null, locked_preview: 1, active: 1 });
  assert.equal(row('fixed_usd').offer_price_mode, 'fixed_usd');
  assert.deepEqual(row('fixed_usd').usd_prices, []);
  assert.equal(row('fixed_eur').offer_price_mode, '');
});

/* ---------------------------------------------- the mirror and the sites -- */

test('the bundle mirror never prices a fixed_usd window (a stray row is inert on a composition)', () => {
  const src = readFileSync('worker/lib/bundleRead.ts', 'utf8');
  const decl = /const windowPrices =([\s\S]*?);/.exec(src)?.[1] ?? '';
  assert.match(decl, /'fixed'/);
  assert.match(decl, /'discount_percent'/);
  assert.match(decl, /'discount_iqd'/);
  assert.doesNotMatch(decl, /fixed_usd|!== ''/, 'the mirror lists the dinar modes, never "any mode"');
});

test('every applyOfferToResolved call site passes the line’s document (a missing one prices no dollar sale)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk('worker');
  const sites: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const re = /applyOfferToResolved\(([^;]*?)\)(?:\.resolved)?\s*[;:\n]/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (file.endsWith('worker/lib/offers.ts')) continue; // the definition and its doc
      const args = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      sites.push(`${file}:${args.length}`);
      assert.equal(args.length, 6, `${file}: applyOfferToResolved(${m[1]}) must pass the document as its sixth argument`);
    }
  }
  // The four doors of §4.6: withLiveOffer, the card projection, resolveCartLine (cart and checkout).
  assert.ok(sites.length >= 3, `found ${sites.join(', ')}`);
  assert.ok(sites.some((s) => s.includes('routes/products.ts')) && sites.some((s) => s.includes('routes/cart.ts')));
});
