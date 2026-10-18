/**
 * THE DOLLAR IS THE BASE — THE PURE RESOLVER (DECISIONS row 248).
 *
 * The owner, 2026-10-17: «الدولار هو الاساس كما اتفقنا وليس العكس … الدولار هو الثابت والدينار العراقي هو
 * المتغير بسعر الصرف». His eSUN PLA+ product form reads «الآن 26,000 د.ع · ≈ $15.20» and «بعد الخصم $14.00 ·
 * 24,000 د.ع»; the storefront read $15.66 → $14.45 — the rounded dinars divided back by the public rate.
 *
 * Every V2-priced line now carries the shop's own dollar price beside its dinars: the `usd_ceil6` of the
 * row that priced it, ceiled to the cent (`usdCeilCentsOf`), as `*_usd_cents` twins. A ladder figure gets
 * one only when every live row at that dinar price agrees; a member price, a dinar-typed sale or a V1 row
 * gets none (converted). A dollar sale's after-price is the typed cents (a route: route − (direct −
 * typed)); a percent sale is the percent of the dollars, ceiled to the cent.
 *
 * Run: npx tsx --test tests/usdBaseResolver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, unanimousUsdCents, type ResolvedPrice, type SkuPriceRow, type Tier } from '../worker/lib/pricing';
import { applyOfferToResolved, type OfferWindow } from '../worker/lib/offers';
import { fixedUsdLine } from '../worker/lib/offerUsd';
import { customerLinePrice, customerOrderPricing, offerFigures } from '../worker/lib/customerPricing';
import { isUsdCents, percentOffUsdCents, usdCeilCentsOf } from '../packages/pricing/src/usdCents';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const USD_KEYS = ['regular_usd_cents', 'applied_usd_cents', 'unit_subtotal_usd_cents', 'offer_before_usd_cents'] as const;

/* ------------------------------------------------------------ the world -- */

const row = (combo: string, channel: string, iqd: number, usdCents?: number, rate = '1700'): SkuPriceRow => ({
  combo_key: combo,
  channel,
  regular_price_iqd: iqd,
  v2: true,
  usd_iqd_rate: rate,
  ...(usdCents === undefined ? {} : { usd_cents: usdCents }),
});

/** The owner's eSUN PLA+ (cost-first, option-less): 26,000 IQD direct = $15.20; a land route at 28,000 = $16.50. */
function esun(rows: SkuPriceRow[] = [row('', 'direct_sale', 26_000, 1520), row('', 'pre_order_land', 28_000, 1650)], over: Record<string, unknown> = {}) {
  return {
    price_iqd: 26_000,
    prime_price_iqd: null,
    pro_price_iqd: null,
    product_cost_iqd: null,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale', 'pre_order'],
    options: [],
    colors: [],
    preorder_transports: [{ method: 'land', commission_iqd: 0, active: true }],
    warranty_plans: [],
    sku_strict: true,
    sku_prices: rows,
    ...over,
  };
}
type Doc = ReturnType<typeof esun>;

const line = (doc: Doc, how: 'direct' | 'land' | 'land_cod' = 'direct', tier: Tier = 'free', tierActive = false, over: Record<string, unknown> = {}): ResolvedPrice =>
  resolveUnitPrice({
    product: doc as never,
    transportMethod: how === 'direct' ? null : 'land',
    fulfillmentType: how === 'direct' ? 'direct_sale' : 'pre_order',
    preorderPricing: how === 'land_cod' ? 'cod' : 'prepaid',
    tier,
    tierActive,
    ...over,
  });

const window = (over: Partial<OfferWindow> = {}): OfferWindow => ({
  id: 'ofw_esun',
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
  usd_prices: [{ model_id: '', cents: 1400 }],
  ...over,
});

const apply = (r: ResolvedPrice, w: OfferWindow, doc: Doc) => applyOfferToResolved(r, { window: w, limits: null }, 'free', false, NOW, doc).resolved;
const usdKeysOf = (r: object) => Object.keys(r).filter((k) => /usd/.test(k));

/* ---------------------------------------------------------- the rounding -- */

test('usdCeilCentsOf: the row’s usd_ceil6 rounded UP to the cent, exactly; anything else is no figure', () => {
  assert.equal(usdCeilCentsOf('15.194118'), 1520, 'the eSUN form’s «≈ $15.20»');
  assert.equal(usdCeilCentsOf('100'), 10_000);
  assert.equal(usdCeilCentsOf('100.000000'), 10_000);
  assert.equal(usdCeilCentsOf('14.000001'), 1401, 'never below the price');
  assert.equal(usdCeilCentsOf('0.000001'), 1);
  for (const bad of ['', '0', '0.000000', '-1', '1e3', 'abc', ' ', '15,20', null, undefined]) assert.equal(usdCeilCentsOf(bad as never), null, String(bad));
  assert.equal(usdCeilCentsOf(15.2 as never), null, 'a float is not stored text');
  assert.equal(percentOffUsdCents(1520, 10), 1368);
  assert.equal(percentOffUsdCents(1001, 10), 901, '900.9 → 901: up to the cent');
  for (const [b, p] of [[0, 10], [1520, 0], [1520, 100], [1520, 10.5]] as const) assert.equal(percentOffUsdCents(b, p), null);
  assert.ok(isUsdCents(0) && isUsdCents(1520) && !isUsdCents(-1) && !isUsdCents(15.2) && !isUsdCents('1520'));
});

/* ---------------------------------------------------------- the resolver -- */

test('a V2 direct line carries its row’s dollars on all three figures', () => {
  const r = line(esun());
  assert.equal(r.regular_iqd, 26_000);
  assert.equal(r.regular_usd_cents, 1520);
  assert.equal(r.applied_usd_cents, 1520);
  assert.equal(r.unit_subtotal_usd_cents, 1520);
  assert.equal(r.offer_before_usd_cents, undefined, 'no sale, no struck dollars');
});

test('the line reads the row of its own channel: a prepaid route its route row, a COD pre-order priced as direct the direct row', () => {
  const land = line(esun(), 'land');
  assert.equal(land.regular_iqd, 28_000);
  assert.equal(land.regular_usd_cents, 1650);
  const cod = line(esun(), 'land_cod');
  assert.equal(cod.regular_iqd, 26_000, 'COD prices a V2 pre-order as direct');
  assert.equal(cod.regular_usd_cents, 1520);
});

test('a ladder figure gets the dollars only when every live row at that dinar price is a V2 row with cents — the lowest of them', () => {
  // A colour product read with no colour: the ladder's 26,000 matches the one row at 26,000.
  const colours = (rows: SkuPriceRow[]) =>
    esun(rows, { sku_strict: false, colors: [{ id: 'c1', name_en: 'Red', active: true }, { id: 'c2', name_en: 'Blue', active: true }] });
  const one = line(colours([row('c:c1', 'direct_sale', 26_000, 1520), row('c:c2', 'direct_sale', 27_000, 1580)]));
  assert.equal(one.price_source === 'sku', false, 'the ladder answered');
  assert.equal(one.regular_iqd, 26_000);
  assert.equal(one.regular_usd_cents, 1520);
  // Two rows share the dinar price but not the dollar (a colour a cent dearer under one 250-IQD step): the
  // lowest — a real SKU's price at the dinar figure shown — never the rounded dinars divided back.
  const two = line(colours([row('c:c1', 'direct_sale', 26_000, 1521), row('c:c2', 'direct_sale', 26_000, 1520)]));
  assert.equal(two.regular_usd_cents, 1520);
  assert.equal(unanimousUsdCents([row('c:c1', 'direct_sale', 26_000, 1525), row('c:c2', 'direct_sale', 26_000, 1520)], 26_000), 1520);
  // A row at that price without dollars (an unparseable usd_ceil6) or a V1 row: no twin.
  assert.deepEqual(usdKeysOf(line(colours([row('c:c1', 'direct_sale', 26_000, 1520), row('c:c2', 'direct_sale', 26_000)]))), []);
  const v1 = { combo_key: 'c:c1', channel: 'direct_sale', regular_price_iqd: 26_000 };
  assert.equal(unanimousUsdCents([v1], 26_000), null);
  assert.equal(unanimousUsdCents([row('c:c1', 'direct_sale', 27_000, 1580)], 26_000), null, 'no row at that price');
});

test('a PRO price comes from dinar rules: the regular keeps its dollars, the applied price has none', () => {
  const r = line(esun([row('', 'direct_sale', 26_000, 1520)], { pro_price_iqd: 24_500 }), 'direct', 'pro', true);
  assert.equal(r.applied_iqd, 24_500);
  assert.equal(r.regular_usd_cents, 1520);
  assert.equal(r.applied_usd_cents, undefined);
  assert.equal(r.unit_subtotal_usd_cents, undefined);
});

test('a ladder or V1 answer is byte-identical to before: no dollar key at all', () => {
  const v1Rows = [{ combo_key: '', channel: 'direct_sale', regular_price_iqd: 26_000 }];
  const v1 = line(esun(v1Rows as SkuPriceRow[], { sku_strict: false }));
  assert.deepEqual(usdKeysOf(v1), []);
  const none = line(esun([], { sku_strict: false }));
  assert.deepEqual(usdKeysOf(none), []);
  // A V2 row without a dollar figure (an older database's read): no twin either.
  assert.deepEqual(usdKeysOf(line(esun([row('', 'direct_sale', 26_000)]))), []);
});

/* -------------------------------------------------------------- the sale -- */

test('the owner’s eSUN: a $14.00 sale on $15.20 — 24,000 / $14.00 against 26,000 / $15.20, −8% both ways', () => {
  const doc = esun();
  const sold = apply(line(doc), window(), doc);
  assert.equal(sold.regular_iqd, 24_000, '$14.00 × 1,700 = 23,800 → 24,000 (row 245)');
  assert.equal(sold.offer_before_iqd, 26_000);
  assert.equal(sold.regular_usd_cents, 1400);
  assert.equal(sold.applied_usd_cents, 1400);
  assert.equal(sold.unit_subtotal_usd_cents, 1400);
  assert.equal(sold.offer_before_usd_cents, 1520);
  const shown = customerLinePrice(sold);
  assert.equal(shown.offer_saving_percent, 8);
  assert.equal(shown.offer_before_usd_cents, 1520);
  assert.equal(shown.offer_saving_percent_usd, 8);
  assert.equal(shown.applied_usd_cents, 1400);
});

test('a prepaid route takes the same dollar saving off its own dollars; a COD line sells at the typed cents', () => {
  const doc = esun();
  const land = apply(line(doc, 'land'), window(), doc);
  assert.equal(land.regular_usd_cents, 1650 - (1520 - 1400), '$16.50 − ($15.20 − $14.00) = $15.30');
  assert.equal(land.offer_before_usd_cents, 1650);
  const cod = apply(line(doc, 'land_cod'), window(), doc);
  assert.equal(cod.regular_usd_cents, 1400);
  // The route's dollars unknown: no dollar pair at all (both converted).
  const noRouteUsd = esun([row('', 'direct_sale', 26_000, 1520), row('', 'pre_order_land', 28_000)]);
  assert.deepEqual(usdKeysOf(apply(line(noRouteUsd, 'land'), window(), noRouteUsd)), []);
  // A route that would reach zero dollars: no twin (the dinars still decide whether it sells).
  // $1.00 × 1,700 = 1,700 → 1,750; the route pays 28,000 − (26,000 − 1,750) = 3,750 — but 1400 − (1520 − 100) ≤ 0.
  assert.deepEqual(
    fixedUsdLine({ cents: 100, rate: '1700', directIqd: 26_000, channelIqd: 28_000, direct: false, directUsdCents: 1520, channelUsdCents: 1400 }),
    { kind: 'price', regular_iqd: 3_750 },
    'no dollar twin at or below zero'
  );
});

test('a percent sale is the percent of the dollars, rounded up to the cent; a dinar-typed sale carries no dollars at all', () => {
  const doc = esun();
  const pct = apply(line(doc), window({ offer_price_mode: 'discount_percent', discount_percent: 10, usd_prices: [] }), doc);
  assert.equal(pct.regular_iqd, 23_500, '26,000 × 0.9 = 23,400 → 23,500');
  assert.equal(pct.regular_usd_cents, 1368);
  assert.equal(pct.offer_before_usd_cents, 1520);
  for (const w of [
    window({ offer_price_mode: 'discount_iqd', discount_iqd: 2_000, usd_prices: [] }),
    window({ offer_price_mode: 'fixed', offer_price_iqd: 24_000, usd_prices: [] }),
  ]) {
    const sold = apply(line(doc), w, doc);
    assert.ok(typeof sold.offer_before_iqd === 'number', `${w.offer_price_mode} lowered the line`);
    assert.deepEqual(usdKeysOf(sold), [], `${w.offer_price_mode}: no dollar key`);
    assert.deepEqual(usdKeysOf(customerLinePrice(sold)), []);
  }
  // A sale that lowers nothing leaves the line as it was, dollars included.
  const same = apply(line(doc), window({ usd_prices: [{ model_id: '', cents: 1520 }] }), doc);
  assert.equal(same.regular_usd_cents, 1520);
  assert.equal(same.offer_before_usd_cents, undefined);
});

/* ------------------------------------------------------ what is served -- */

test('offerFigures: the dollar pair and its percent only when both twins exist and the before is above', () => {
  assert.deepEqual(offerFigures(26_000, 24_000), { offer_before_iqd: 26_000, offer_saving_percent: 8 });
  assert.deepEqual(offerFigures(26_000, 24_000, 1520, 1400), { offer_before_iqd: 26_000, offer_saving_percent: 8, offer_before_usd_cents: 1520, offer_saving_percent_usd: 8 });
  assert.deepEqual(offerFigures(26_000, 24_000, 1520, undefined), { offer_before_iqd: 26_000, offer_saving_percent: 8 });
  assert.deepEqual(offerFigures(26_000, 24_000, 1400, 1520), { offer_before_iqd: 26_000, offer_saving_percent: 8 });
  assert.deepEqual(offerFigures(null, 24_000, 1520, 1400), { offer_before_iqd: null, offer_saving_percent: null });
});

test('a stored order line serves its frozen dollars — whole cents only — and a line sold before them has none', () => {
  const doc = esun();
  const sold = apply(line(doc), window(), doc);
  const { cost_iqd: _cost, ...snapshot } = sold;
  const served = customerOrderPricing(JSON.parse(JSON.stringify(snapshot)))!;
  for (const k of USD_KEYS) assert.equal(served[k], sold[k], k);
  assert.equal(served.offer_saving_percent_usd, 8);
  // Junk in a snapshot is dropped, never served.
  const junk = customerOrderPricing({ ...snapshot, regular_usd_cents: '1520', applied_usd_cents: -1, unit_subtotal_usd_cents: 14.5, offer_before_usd_cents: Number.MAX_SAFE_INTEGER + 2 })!;
  assert.deepEqual(usdKeysOf(junk), []);
  // A pre-change snapshot: no dollar key.
  const old = { ...snapshot };
  for (const k of USD_KEYS) delete (old as Record<string, unknown>)[k];
  assert.deepEqual(usdKeysOf(customerOrderPricing(old)!), []);
});
