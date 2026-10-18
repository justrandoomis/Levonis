/**
 * PRICING V2 — THE PRICES OF MODELS AND COLOURS (the owner's report of
 * 2026-10-17 on the «A1 Combo», DECISIONS row 247; docs/PRICING-V2.md §1.4,
 * §2.5, §10).
 *
 * The owner saw «مباشر 906,000 · طلب مسبق 906,000» on a model on the shelf —
 * the $35 pre-order discount gone without a word — and a pre-order that stayed
 * put while the direct price moved; «تكلفة مختلفة» had no minimum profit, and
 * its weight and box were empty although «أبعاد الخيار» held them. Proves:
 *   1. the engine, pure (the A1 Combo of the screenshots: U 1,500, EUR 1,650,
 *      T $143.90, Δ $35, the shelf at 690,062): the pre-order follows the
 *      direct price on the shelf too — P = round(E_D − Δ × U) — through own-cost
 *      and difference changes and batches; a pre-order equal to the direct
 *      price always carries its reason (withdrawn, or stopped);
 *   2. the owner's routes: a model's own minimum profit as an option-scope
 *      rule — previewed, saved, read back, set back to inherit, untouched by
 *      the product's — and refused from a price editor;
 *   3. the form's pure half: the wire sends only what changed, the currency
 *      «يتبع المنتج» travels named, the weight and box ARE the option's
 *      packaged dimensions, a colour edit never drops a colour's discount, and
 *      the model and colour cards read the server's reasons;
 *   4. DECISIONS row 254: a cost on every model and colour, in both methods —
 *      the wire sends a model's own cost price-first too, a colour's as scope
 *      color, dinars as `supplier_cost_iqd` alone (read back as typed), and
 *      nothing for a price editor; the server takes them on a price-first
 *      product, moves no price, and the owner's reading follows them; a
 *      purchase fold over a cost typed in dinars reads back as the fold's
 *      amount (never the old dinars); a colour on its own cost is labelled
 *      «من تكلفة اللون», shown apart, and never a model's reference line.
 *
 * Run: node --import tsx --test tests/pricingV2OptionPricing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { applyRate, OWNER_ROW_SQL } from './fixtures/fx';
import { seedOptionless, v2App, writeV2 } from './fixtures/pricingV2';
import { priceProductV2, type V2Discount, type V2PricePoint, type V2Sku } from '@levonis/pricing/priceV2';
import { resolveSkuInputs } from '@levonis/pricing/costToPrice';
import { roundPriceIqd } from '../packages/pricing/src/priceRounding';
import {
  FOLLOW_COLOUR,
  FOLLOW_MODEL,
  cleanIqdAmount,
  dollarsOf,
  draftOf,
  draftWire,
  lineWithOption,
  measurePendingOf,
  modelBlocks,
  modelFinalLine,
  productFinalLine,
  docWithoutLegacyMoney,
  optionDimsHeading,
  preorderOffOf,
  pricedStructureKey,
  withoutLegacyMoney,
  withOptionMeasure,
  type ColourDraft,
  type ModelDraft,
  type PriceDraft,
  type V2Answer,
  type V2LiveIds,
  type V2TableRow,
  type WireRule,
  skuLines,
} from '../src/components/adminProducts/form/v2/v2Model';
import { lineNotes } from '../src/components/adminProducts/form/v2/ResultBar';
import { V2_STRINGS } from '../src/components/adminProducts/form/v2/v2Strings';
import { hydrateRelations, relationsToWire, type RelationsState } from '../src/components/adminProducts/form/model';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { chainOfUnit, packagedMeasureOf, type InputWrite, type StoredInputRow, type UnitSelection } from '../worker/lib/pricingEngine/store';
import { mergedInputs } from '../worker/lib/pricingEngine/fromPurchase';

/* ------------------------------------------------------- 1. the engine, pure -- */

const RATES = {
  fx: { USD: { rate: '1500', version: 1, confirmed: true }, EUR: { rate: '1650', version: 1, confirmed: true }, CNY: { rate: '210', version: 1, confirmed: true } },
  shipping: { GERMANY_LAND: { rate: '3200', version: 1, confirmed: true }, CHINA_AIR: { rate: '20000', version: 1, confirmed: true }, CHINA_SEA: { rate: '400000', version: 1, confirmed: true } },
};
const OFF = 52_500; // Δ $35 × 1,500
const target = (usd: string) => ({ kind: 'target_profit', status: 'active', rule: { id: 'r1', version: 1 }, amount_usd: usd, amount_iqd: null, tie: false }) as unknown as V2Sku['target'];
/** The product (A1): 269 EUR by China air, 6,240 g. The Combo's own cost: none (follows), or typed. */
const PRODUCT = { supplier_cost: '269', supplier_currency: 'EUR', shipping_profile: 'CHINA_AIR', shipping_weight_g: 6240 };
type Own = { supplier_cost?: string; supplier_currency?: string; shipping_weight_g?: number; shipping_length_mm?: number; shipping_width_mm?: number; shipping_height_mm?: number };
const COMBO_SHELF: V2Sku['shelf'] = { state: 'on_shelf', cost_iqd: 690_062, units: 6 };

function combo(o: { own?: Own | null; shelf?: V2Sku['shelf']; T?: string; colour?: string | null } = {}): V2Sku {
  const colour = o.colour ?? null;
  return {
    combo_key: colour ? `o:combo|c:${colour}` : 'o:combo',
    model_id: 'combo',
    option_value_ids: ['combo'],
    color_id: colour,
    channels: ['direct_sale', 'pre_order_land'],
    chain: { base: { override: PRODUCT as never }, options: [{ scope_id: 'combo', override: (o.own ?? null) as never }] },
    target: target(o.T ?? '143.9'),
    shelf: o.shelf === undefined ? COMBO_SHELF : o.shelf,
  };
}
const PRODUCT_OFF: V2Discount = { scope: 'product', scope_id: '', usd: '35' };
const MODEL_OFF: V2Discount = { scope: 'option', scope_id: 'combo', usd: '35' };
const EUR = (eur: string, more: Own = {}): Own => ({ supplier_cost: eur, supplier_currency: 'EUR', ...more });
const BOX_13_5 = { shipping_weight_g: 13_500, shipping_length_mm: 560, shipping_width_mm: 540, shipping_height_mm: 430 };

function price(s: V2Sku, points: V2PricePoint[] = [], discounts: V2Discount[] = [PRODUCT_OFF]) {
  const r = priceProductV2({ method: 'cost', rates: RATES, points, discounts, skus: [s] }).skus[0]!;
  const direct = r.channels.find((c) => c.channel === 'direct_sale');
  const land = r.channels.find((c) => c.channel === 'pre_order_land');
  // (l) on every channel: never above D, never at or below the route's own rounded cost.
  for (const c of r.channels) {
    assert.ok(c.price_iqd <= c.direct_iqd, 'P ≤ D');
    if (c.channel !== 'direct_sale') assert.ok(c.price_iqd > roundPriceIqd(Number(c.replacement!.replacement_cost_iqd)), 'above the route cost');
    // No pre-order equals the direct price with a discount and no reason (the silent cap is gone).
    if (c.channel !== 'direct_sale' && c.price_iqd === c.direct_iqd && Number(c.discount_usd) > 0) assert.equal(c.floor, 'discount_withdrawn');
  }
  return { r, direct, land, codes: [...new Set(r.issues.map((i) => i.code))] };
}
const pair = (x: ReturnType<typeof price>) => [x.direct?.price_iqd ?? null, x.land?.price_iqd ?? null];

test('the A1 Combo on the shelf: the pre-order is the direct price less the $35 (shots A and B), and says so', () => {
  // (a) Shot A — «تكلفة مختلفة» with nothing typed: the shelf's direct price, less Δ × U (was 906,000 / 732,000).
  const a = price(combo());
  assert.deepEqual(pair(a), [906_000, 853_500]);
  assert.equal(a.land!.floor, 'none');
  assert.equal(a.land!.discount_usd, '35');
  assert.equal(a.direct!.price_iqd - a.land!.price_iqd, OFF);
  // (b) Shot B — own cost 375 EUR, the model's own Δ $35: the same (was 906,000 / 906,000, the discount lost silently).
  const b = price(combo({ own: EUR('375') }), [], [PRODUCT_OFF, MODEL_OFF]);
  assert.deepEqual(pair(b), [906_000, 853_500]);
  assert.deepEqual(b.land!.discount_from, { scope: 'option', scope_id: 'combo' });
  assert.deepEqual(b.codes, []);
  // (k) the other model, A1, at 500,346: 716,250 / 663,750 (was capped at 716,250 / 716,250).
  const a1 = price(combo({ shelf: { state: 'on_shelf', cost_iqd: 500_346, units: 3 } }));
  assert.deepEqual(pair(a1), [716_250, 663_750]);
});

test('issue 4: the pre-order moves with the direct price — batches, differences, the own cost without stock', () => {
  // (c) a costlier or a cheaper batch moves both by the same: D − P stays Δ × U.
  for (const [cost, want] of [
    [720_000, [936_000, 883_500]],
    [650_000, [866_000, 813_500]],
  ] as const) {
    const x = price(combo({ shelf: { state: 'on_shelf', cost_iqd: cost, units: 1 } }));
    assert.deepEqual(pair(x), want, `shelf ${cost}`);
    assert.equal(x.direct!.price_iqd - x.land!.price_iqd, OFF);
  }
  // (d) a model difference +$20 moves both; −$20 is lifted to the floor (cost + minimum profit) with its reason.
  assert.deepEqual(pair(price(combo(), [{ scope: 'option', scope_id: 'combo', kind: 'delta', usd: '+20' }])), [936_000, 883_500]);
  const minus = price(combo(), [{ scope: 'option', scope_id: 'combo', kind: 'delta', usd: '-20' }]);
  assert.deepEqual(pair(minus), [906_000, 853_500]);
  assert.ok(minus.codes.includes('V2_DIRECT_MIN_PROFIT'));
  // (h) without stock the own cost prices both: 300 / 375 / 400 EUR.
  assert.deepEqual(pair(price(combo({ shelf: null }))), [784_500, 732_000]);
  for (const [eur, want] of [
    ['300', [835_750, 783_250]],
    ['375', [959_500, 907_000]],
    ['400', [1_000_750, 948_250]],
  ] as const) {
    assert.deepEqual(pair(price(combo({ own: EUR(eur), shelf: null }))), want, `own ${eur} EUR`);
  }
  // (j) a colour +$10 on the Combo's shelf, own cost 375 EUR: 921,000 / 868,500 (was 921,000 / 921,000).
  assert.deepEqual(pair(price(combo({ own: EUR('375'), colour: 'red' }), [{ scope: 'color', scope_id: 'red', kind: 'delta', usd: '+10' }])), [921_000, 868_500]);
});

test('a pre-order equal to the direct price always has its reason: withdrawn (own 520 EUR) or stopped (own 540 EUR)', () => {
  // (e) the land route costs 877,968 (520 × 1,650 + 6.24 × 3,200): 853,500 does not clear it → the direct price, withdrawn.
  const w = price(combo({ own: EUR('520') }));
  assert.deepEqual(pair(w), [906_000, 906_000]);
  assert.equal(w.land!.floor, 'discount_withdrawn');
  assert.equal(w.land!.replacement!.replacement_cost_iqd, 877_968);
  assert.ok(w.r.issues.some((i) => i.code === 'V2_DISCOUNT_WITHDRAWN' && i.channel === 'pre_order_land'));
  // (f) 540 EUR: the route costs more than the shelf sells — stopped while it does, never sold at a loss.
  const stop = price(combo({ own: EUR('540') }));
  assert.equal(stop.direct!.price_iqd, 906_000);
  assert.equal(stop.land, undefined);
  assert.deepEqual(stop.r.issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_ROUTE_SHELF_CHEAPER']);
  // No supplier price at all while the shelf sells: the route is unavailable, the direct price stands.
  const none = priceProductV2({
    method: 'cost',
    rates: RATES,
    points: [],
    discounts: [PRODUCT_OFF],
    skus: [{ ...combo(), chain: {} }],
  }).skus[0]!;
  assert.equal(none.channels.find((c) => c.channel === 'direct_sale')!.price_iqd, 906_000);
  assert.deepEqual(none.issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_ROUTE_NO_SUPPLIER']);
});

test('issue 2 in the engine: the Combo freighted on its own 13.5 kg box; issue 1: a model minimum profit of $60', () => {
  // (g) on the shelf: the route's own cost uses 13.5 kg (661,950); the prices stay the shelf's less Δ.
  const shelf = price(combo({ own: EUR('375', BOX_13_5) }));
  assert.deepEqual(pair(shelf), [906_000, 853_500]);
  assert.equal(shelf.land!.replacement!.replacement_cost_iqd, 661_950);
  assert.equal(shelf.land!.replacement!.effective_weight_g, 13_500);
  // Without the box, the product's 6,240 g is inherited (the bug the option dimensions now fix in the form).
  assert.equal(price(combo({ own: EUR('375') })).land!.replacement!.effective_weight_g, 6240);
  // (h) without stock: 1,104,750 / 1,052,250 at 13.5 kg, against 959,500 / 907,000 at the inherited 6,240 g.
  assert.deepEqual(pair(price(combo({ own: EUR('375', BOX_13_5), shelf: null }))), [1_104_750, 1_052_250]);
  // (i) a minimum profit of $60 on the model (the SKU's resolved T).
  assert.deepEqual(pair(price(combo({ T: '60' }))), [780_250, 727_750]);
  assert.deepEqual(pair(price(combo({ own: EUR('375'), T: '60', shelf: null }))), [833_750, 781_250]);
});

test('a SKU sold by pre-order only takes nothing from the shelf: its route keeps the supplier calculation (C-8)', () => {
  // The Combo with its shelf at 690,062 but no direct sale: 269 EUR by air at 6,240 g + T → 784,500, Δ ignored.
  const only = (shelf: V2Sku['shelf']) =>
    priceProductV2({ method: 'cost', rates: RATES, points: [], discounts: [PRODUCT_OFF], skus: [{ ...combo({ shelf }), channels: ['pre_order_land'] }] }).skus[0]!;
  for (const shelf of [COMBO_SHELF, null, { state: 'sold_out' as const }]) {
    const r = only(shelf as V2Sku['shelf']);
    assert.deepEqual(
      r.channels.map((c) => [c.channel, c.price_iqd, c.shelf]),
      [['pre_order_land', 784_500, null]],
      JSON.stringify(shelf)
    );
    assert.deepEqual([...new Set(r.issues.map((i) => i.code))], ['V2_DISCOUNT_IGNORED'], JSON.stringify(shelf));
  }
});

test('on the shelf the route cost is weighed before the discount: a discount at or above the shelf D is stopped or withdrawn, never V2_DISCOUNT_TOO_LARGE', () => {
  // Shelf 200,000: D = round(200,000 + 215,850) = 416,000 is below the land route's own cost (463,818 → 464,000): stopped.
  const stop = price(combo({ shelf: { state: 'on_shelf', cost_iqd: 200_000, units: 1 } }), [], [{ scope: 'product', scope_id: '', usd: '400' }]);
  assert.equal(stop.direct!.price_iqd, 416_000);
  assert.equal(stop.land, undefined);
  assert.deepEqual(stop.r.issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_ROUTE_SHELF_CHEAPER']);
  // Shelf 300,000: D = 516,000 clears the route; a $400 discount (600,000) is more than D — withdrawn: the route sells at D.
  const back = price(combo({ shelf: { state: 'on_shelf', cost_iqd: 300_000, units: 1 } }), [], [{ scope: 'product', scope_id: '', usd: '400' }]);
  assert.deepEqual(pair(back), [516_000, 516_000]);
  assert.equal(back.land!.floor, 'discount_withdrawn');
  assert.deepEqual(back.codes, ['V2_DISCOUNT_WITHDRAWN']);
  assert.equal(back.r.ok, true, 'the whole SKU is written — its direct price too');
  // Off the shelf the rule is unchanged: a discount at or above D is the owner's error to fix.
  const off = price(combo({ shelf: null }), [], [{ scope: 'product', scope_id: '', usd: '1000' }]);
  assert.equal(off.land, undefined);
  assert.deepEqual(off.r.issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_DISCOUNT_TOO_LARGE']);
});

test('a discount worth less than one rounding step can round away (Δ × U < 250): P = D with floor none — the documented exception', () => {
  const r = priceProductV2({ method: 'cost', rates: RATES, points: [], discounts: [{ scope: 'product', scope_id: '', usd: '0.1' }], skus: [combo()] }).skus[0]!;
  const land = r.channels.find((c) => c.channel === 'pre_order_land')!;
  assert.equal(land.price_iqd, land.direct_iqd);
  assert.equal(land.floor, 'none');
  // $0.17 × 1,500 = 255 ≥ one step: the pre-order is below D.
  const r2 = priceProductV2({ method: 'cost', rates: RATES, points: [], discounts: [{ scope: 'product', scope_id: '', usd: '0.17' }], skus: [combo()] }).skus[0]!;
  assert.ok(r2.channels.find((c) => c.channel === 'pre_order_land')!.price_iqd < r2.channels.find((c) => c.channel === 'direct_sale')!.price_iqd);
});

/* ------------------------------------------------------- 2. the owner's routes -- */

const PID = 'p_a1';
const A1 = 'p_a1_std';
const COMBO = 'p_a1_combo';
const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
const sql = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** The owner's A1, OPTION stock, both models sold direct and by land; the Combo's «أبعاد الخيار» packed 13.5 kg, 56 × 54 × 43. */
async function world(o: { shelf?: boolean } = {}) {
  const raw: DatabaseSync = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_editor','Editor','editor@x.co','h','admin','2026-01-01T00:00:00.000Z')");
  applyRate(raw, 'USD_IQD', '1500');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND';
            UPDATE pricing_shipping_rates SET rate_iqd = '20000', version = version + 1 WHERE profile = 'CHINA_AIR';
            UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';`);
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
    VALUES (${sql(PID)}, 'bambu-a1', 'Bambu Lab A1', 'طابعة A1', 'چاپکەری A1', 'active', 700000, 9, 'direct_sale', '["direct_sale","pre_order"]', '[]', 'OPTION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('p_a1_g', ${sql(PID)}, 'Model', 0, 1);
  `);
  [
    { id: A1, en: 'A1', dims: 'NULL, NULL, NULL, NULL' },
    { id: COMBO, en: 'A1 Combo', dims: '13500, 560, 540, 430' },
  ].forEach((m, j) =>
    raw.exec(`
      INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, variant_key, variant_label,
                                         package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES (${sql(m.id)}, ${sql(PID)}, 'p_a1_g', ${sql(m.en)}, ${sql(m.en)}, ${sql(m.en)}, ${j}, 1, ${j ? 6 : 3}, ${sql(`m${j}`)}, ${sql(m.en)}, ${m.dims});
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (${sql(`${m.id}_d`)}, ${sql(PID)}, ${sql(m.id)}, 'direct_sale', 1);
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (${sql(`${m.id}_p`)}, ${sql(PID)}, ${sql(m.id)}, 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES (${sql(`${m.id}_p_land`)}, ${sql(PID)}, ${sql(`${m.id}_p`)}, 'land', 1);
    `)
  );
  // The Combo's batches (row 244): 685,831 / 689,581 / 690,062; A1's at 500,346.
  let seq = 0;
  for (const [model, cost] of o.shelf === false ? [] : ([
    [COMBO, 685_831],
    [COMBO, 689_581],
    [COMBO, 690_062],
    [A1, 500_346],
  ] as const)) {
    seq += 1;
    raw.exec(`INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
              VALUES ('lot_${seq}', ${sql(PID)}, 'option', ${sql(model)}, 2, 2, ${cost}, 'received', '2026-09-0${seq}T00:00:00.000Z')`);
  }
  const db = asD1(raw);
  await writeV2(db, PID, {
    method: 'cost',
    minimumProfitUsd: '143.9',
    discounts: [{ scope: 'product', scope_id: '', usd: '35' }],
    inputs: { supplier_cost_amount: '269', supplier_cost_currency: 'EUR', shipping_profile: 'CHINA_AIR', shipping_weight_g: 6240 },
  });
  return { raw, db, app: v2App(raw) };
}

type Row = V2TableRow;
const at = (table: Row[], model: string, channel: string) => table.find((r) => r.combo_key === `o:${model}` && r.channel === channel)?.price_iqd ?? null;
const previewOf = async (app: ReturnType<typeof v2App>, pricing: Record<string, unknown>) => {
  const res = await post(app, '/api/admin/products-v2/pricing/preview', { product_id: PID, pricing });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body as V2Answer & { review_hash: string };
};
const optionRule = (raw: DatabaseSync) =>
  row<{ state: string; amount_usd: string | null }>(raw, "SELECT state, amount_usd FROM pricing_rules WHERE product_id = ? AND kind = 'target_profit' AND scope = 'option' AND scope_id = ?", PID, COMBO);

test('the owner: a model minimum profit is an option-scope rule — previewed, saved, read back, untouched by the product, set back to inherit', async () => {
  const w = await world();
  const stored = (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))) as V2Answer;
  // B1 on the shelf, published: 906,000 / 853,500 for the Combo, 716,250 / 663,750 for A1.
  assert.equal(at(stored.table, COMBO, 'direct_sale'), 906_000);
  assert.equal(at(stored.table, COMBO, 'pre_order_land'), 853_500);
  assert.equal(at(stored.table, A1, 'pre_order_land'), 663_750);

  // The form's own wire for «استثناء $60» on the Combo: only that row.
  const rule: WireRule[] = [{ kind: 'target_profit', scope: 'option', scope_id: COMBO, amount_usd: '60' }];
  const pre = await previewOf(w.app, { cost: { minimum_profit: rule } });
  assert.equal(at(pre.table, COMBO, 'direct_sale'), 780_250);
  assert.equal(at(pre.table, COMBO, 'pre_order_land'), 727_750);
  assert.equal(at(pre.table, A1, 'direct_sale'), 716_250, 'only the Combo moves');
  assert.equal(at(pre.table, A1, 'pre_order_land'), 663_750);

  // Saved: one pricing_rules row (target_profit, option, Combo); the product's stays.
  const saved = await put(w.app, `/api/admin/products-v2/${PID}/pricing`, { seq: pre.seq, pricing: { cost: { minimum_profit: rule } }, preview_hash: pre.review_hash });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 400));
  assert.deepEqual(optionRule(w.raw), { state: 'ACTIVE', amount_usd: '60' });
  const back = (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))) as V2Answer;
  assert.ok(back.v2_cost_inputs!.minimum_profit.some((r) => r.scope === 'option' && r.scope_id === COMBO && r.amount_usd === '60'));
  assert.ok(back.v2_cost_inputs!.minimum_profit.some((r) => r.scope === 'product' && r.amount_usd === '143.9'));
  // The owner's rows carry their dinars too (a legacy dinar rule is drawn as kept, never as «يتبع المنتج»).
  assert.ok(back.v2_cost_inputs!.minimum_profit.every((r) => 'amount_iqd' in r));
  // The reload shows the exception again: «تكلفة مختلفة», «الحد الأدنى للربح: استثناء $60».
  const m = draftOf(back).models[COMBO]!;
  assert.equal(m.cost, 'own');
  assert.equal(m.price, 'follow', 'the price is a choice of its own (row 254)');
  assert.equal(m.profit, 'exception');
  assert.equal(m.profit_usd, '60');
  assert.equal(draftOf(back).min_profit_usd, '143.9');

  // The product's minimum profit alone (the text form) leaves the model's rule untouched.
  const product = await previewOf(w.app, { cost: { minimum_profit: '150' } });
  assert.equal(at(product.table, COMBO, 'direct_sale'), 780_250, 'the Combo keeps its own $60');
  assert.notEqual(at(product.table, A1, 'direct_sale'), 716_250, 'A1 follows the product');
  // An empty amount is INHERIT: the Combo is back on the product's $143.90.
  const inherit = await previewOf(w.app, { cost: { minimum_profit: [{ kind: 'target_profit', scope: 'option', scope_id: COMBO, amount_usd: '' }] } });
  assert.equal(at(inherit.table, COMBO, 'direct_sale'), 906_000);
  assert.equal(at(inherit.table, COMBO, 'pre_order_land'), 853_500);

  // A price editor never sends a minimum profit (refused by name, as every cost field).
  const editor = stubApp(asD1(w.raw), EDITOR, (a) => a.route('/api/admin/products-v2', adminProductsRoutes));
  const refused = await post(editor, '/api/admin/products-v2/pricing/preview', { product_id: PID, pricing: { cost: { minimum_profit: rule } } });
  assert.equal(refused.status, 403, (await refused.clone().text()).slice(0, 300));
  assert.doesNotMatch(await refused.text(), /780[,]?250|60/);
});

/* --------------------------------------------------- 3. the form's pure half -- */

const LIVE: V2LiveIds = { options: new Set(['combo', 'a1']), models: new Set(['combo', 'a1']), colours: new Set(['red']), skus: new Set(['o:combo', 'o:a1', 'o:combo|c:red']) };
const OPTS = { needsMethod: false, cost: true, money: true };
function ownerAnswer(o: { inputs?: Array<Record<string, unknown>>; rules?: Array<{ scope: string; scope_id: string | null; state: string | null; amount_usd: string | null; amount_iqd?: number | null }>; points?: V2Answer['v2_points']; discounts?: V2Answer['v2_discounts'] } = {}): V2Answer {
  const base = { scope: 'base', scope_id: '', supplier_cost_amount: '269', supplier_cost_currency: 'EUR', shipping_profile: 'CHINA_AIR', shipping_weight_g: 6240, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null, additional_cost_iqd: null };
  return {
    product_id: PID,
    v2: true,
    method: 'cost',
    seq: { inputs_seq: 1, write_seq: 1 },
    status: { kind: 'current' },
    can_edit: { money: true, cost: true, structure: true },
    table: [],
    missing: [],
    v2_points: o.points ?? [],
    v2_discounts: o.discounts ?? [{ scope: 'product', id: '', usd: '35' }],
    v2_cost_inputs: {
      inputs: [base, ...(o.inputs ?? [])] as never,
      minimum_profit: o.rules ?? [{ scope: 'product', scope_id: '', state: 'ACTIVE', amount_usd: '143.9' }],
    },
  };
}
const withModel = (d: PriceDraft, id: string, patch: Partial<ModelDraft>): PriceDraft => ({ ...d, models: { ...d.models, [id]: { ...(d.models[id] ?? FOLLOW_MODEL), ...patch } } });
const wireOf = (a: V2Answer, draft: (d: PriceDraft) => PriceDraft) => {
  const base = draftOf(a);
  return draftWire(base, draft(base), { points: a.v2_points ?? [], discounts: a.v2_discounts ?? [] }, LIVE, OPTS);
};
const OWN_ROW = { scope: 'option', scope_id: 'combo', supplier_cost_amount: '375', supplier_cost_currency: 'EUR', shipping_profile: null, shipping_weight_g: null, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null, additional_cost_iqd: null };

test('the wire: the product minimum profit alone is text; a model one sends only its changed row; leaving «تكلفة مختلفة» sends INHERIT', () => {
  const a = ownerAnswer();
  assert.equal(wireOf(a, (d) => ({ ...d, min_profit_usd: '150' })).cost?.minimum_profit, '150', 'back-compatible: the product alone is text');
  const model = wireOf(a, (d) => withModel(d, 'combo', { cost: 'own', profit: 'exception', profit_usd: '60' }));
  assert.deepEqual(model.cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '60' }]);
  // Both changed: the product's row first, then the model's — never a row that did not change.
  const both = wireOf(a, (d) => withModel({ ...d, min_profit_usd: '150' }, 'combo', { cost: 'own', profit: 'exception', profit_usd: '60' }));
  assert.deepEqual(both.cost?.minimum_profit, [
    { kind: 'target_profit', scope: 'product', amount_usd: '150' },
    { kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '60' },
  ]);
  // A minimum profit is an «تكلفة مختلفة» choice: with the cost «تتبع المنتج» nothing is sent, whatever the price.
  assert.equal(wireOf(a, (d) => withModel(d, 'combo', { price: 'delta', usd: '+5', profit: 'exception', profit_usd: '60' })).cost?.minimum_profit, undefined);

  // Stored: the Combo on its own cost (375 EUR) with its own $60 → «رجوع للموروث».
  const stored = ownerAnswer({ inputs: [OWN_ROW], rules: [{ scope: 'product', scope_id: '', state: 'ACTIVE', amount_usd: '143.9' }, { scope: 'option', scope_id: 'combo', state: 'ACTIVE', amount_usd: '60' }] });
  assert.deepEqual(
    { cost: draftOf(stored).models.combo!.cost, price: draftOf(stored).models.combo!.price, profit: draftOf(stored).models.combo!.profit, profit_usd: draftOf(stored).models.combo!.profit_usd },
    { cost: 'own', price: 'follow', profit: 'exception', profit_usd: '60' }
  );
  const follow = wireOf(stored, (d) => withModel(d, 'combo', { cost: 'follow', supplier_amount: '', supplier_currency: '', weight_g: null, box: null, profit: 'follow', profit_usd: '' }));
  assert.deepEqual(follow.cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '' }]);
  assert.deepEqual(follow.cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_amount: null }], 'its own cost cleared too');
  // An INHERIT row stored for the model is not an exception.
  assert.equal(draftOf(ownerAnswer({ rules: [{ scope: 'option', scope_id: 'combo', state: 'INHERIT', amount_usd: null }] })).models.combo, undefined);
});

test('the wire: an amount typed with the currency at «يتبع المنتج» names the product currency (never a refused preview)', () => {
  const w = wireOf(ownerAnswer(), (d) => withModel(d, 'combo', { cost: 'own', supplier_amount: '375', supplier_currency: '' }));
  assert.deepEqual(w.cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_amount: '375', supplier_cost_currency: 'EUR' }]);
  // A currency chosen is the model's own.
  const usd = wireOf(ownerAnswer(), (d) => withModel(d, 'combo', { cost: 'own', supplier_amount: '375', supplier_currency: 'USD' }));
  assert.equal(usd.cost?.inputs?.[0]?.supplier_cost_currency, 'USD');
});

test('«تكلفة مختلفة»: the weight and box ARE the option packaged dimensions (withOptionMeasure)', () => {
  const dims = (o: Partial<Record<'package_weight_g' | 'package_depth_mm' | 'package_width_mm' | 'package_height_mm', number | null>>) => ({
    net_weight_g: 8300,
    width_mm: 385,
    depth_mm: 410,
    height_mm: 430,
    package_weight_g: null,
    package_depth_mm: null,
    package_width_mm: null,
    package_height_mm: null,
    ...o,
  });
  const own: ModelDraft = { ...FOLLOW_MODEL, cost: 'own', supplier_amount: '375', supplier_currency: 'EUR' };
  const full = withOptionMeasure({ combo: own }, { combo: dims({ package_weight_g: 13_500, package_depth_mm: 560, package_width_mm: 540, package_height_mm: 430 }) });
  assert.equal(full.combo!.weight_g, 13_500, 'the packaged weight — never the net 8,300');
  assert.deepEqual(full.combo!.box, [560, 540, 430]);
  // A partial box is not a box: the weight comes, the box stays as it was.
  const partial = withOptionMeasure({ combo: own }, { combo: dims({ package_weight_g: 13_500, package_depth_mm: 560 }) });
  assert.equal(partial.combo!.weight_g, 13_500);
  assert.equal(partial.combo!.box, null);
  // The option inherits its package: a legacy value stored in pricing only is kept; nothing stored stays null.
  const legacy = { ...own, weight_g: 9000 };
  assert.equal(withOptionMeasure({ combo: legacy }, { combo: dims({}) }).combo!.weight_g, 9000);
  const nothing = { combo: own };
  assert.equal(withOptionMeasure(nothing, { combo: dims({}) }), nothing, 'the same object when nothing changes');
  assert.equal(withOptionMeasure(nothing, {}), nothing);
  // A model on «يتبع المنتج» or «زيادة» is untouched.
  const follows = { combo: FOLLOW_MODEL };
  assert.equal(withOptionMeasure(follows, { combo: dims({ package_weight_g: 13_500 }) }), follows);
  // The mirror travels in the save: the draft over the dims against the raw stored draft sends the measure.
  const a = ownerAnswer({ inputs: [OWN_ROW] });
  const base = draftOf(a);
  const shown = { ...base, models: withOptionMeasure(base.models, { combo: dims({ package_weight_g: 13_500, package_depth_mm: 560, package_width_mm: 540, package_height_mm: 430 }) }) };
  assert.deepEqual(draftWire(base, shown, { points: [], discounts: a.v2_discounts! }, LIVE, OPTS).cost?.inputs, [
    { scope: 'option', scope_id: 'combo', shipping_weight_g: 13_500, shipping_length_mm: 560, shipping_width_mm: 540, shipping_height_mm: 430 },
  ]);
});

test('the mirror follows the option dimensions: «مسح التخصيص» after a save clears the pricing row; a pricing-only value stays', () => {
  const dims = (o: Partial<Record<'package_weight_g' | 'package_depth_mm' | 'package_width_mm' | 'package_height_mm', number | null>>) => ({
    net_weight_g: 8300,
    width_mm: 385,
    depth_mm: 410,
    height_mm: 430,
    package_weight_g: null,
    package_depth_mm: null,
    package_width_mm: null,
    package_height_mm: null,
    ...o,
  });
  const PACKED = dims({ package_weight_g: 13_500, package_depth_mm: 560, package_width_mm: 540, package_height_mm: 430 });
  // Stored: the row-247 save wrote the mirror (375 EUR, 13,500 g, 56 × 54 × 43) beside the option's own package.
  const a = ownerAnswer({ inputs: [{ ...OWN_ROW, shipping_weight_g: 13_500, shipping_length_mm: 560, shipping_width_mm: 540, shipping_height_mm: 430 }] });
  const base = draftOf(a);
  const wire = (now: Record<string, ReturnType<typeof dims>>, saved: Record<string, ReturnType<typeof dims>>) => {
    const shown = (d: PriceDraft) => ({ ...d, models: withOptionMeasure(d.models, now, saved) });
    return { w: draftWire(base, shown(base), { points: [], discounts: a.v2_discounts! }, LIVE, OPTS), pending: measurePendingOf(base, shown(base)) };
  };
  // Unchanged: nothing to send, nothing pending.
  assert.deepEqual(wire({ combo: PACKED }, { combo: PACKED }).w, {});
  assert.equal(wire({ combo: PACKED }, { combo: PACKED }).pending.size, 0);
  // «مسح التخصيص / inherit all»: the option inherits again — the mirror is cleared with it (the engine inherits too).
  const reset = wire({ combo: dims({}) }, { combo: PACKED });
  assert.deepEqual(reset.w.cost?.inputs, [{ scope: 'option', scope_id: 'combo', shipping_weight_g: null, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null }]);
  assert.deepEqual([...reset.pending], ['combo']);
  // Only the box's height cleared: the box goes, the weight stays.
  const noBox = wire({ combo: { ...PACKED, package_height_mm: null } }, { combo: PACKED });
  assert.deepEqual(noBox.w.cost?.inputs, [{ scope: 'option', scope_id: 'combo', shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null }]);
  // A value saved in pricing only (never the option's) is kept: the option had no package of its own when saved.
  assert.deepEqual(wire({ combo: dims({}) }, { combo: dims({}) }).w, {});
  // Before the first save (shot B): the option's package is not in the pricing row yet — pending, so the form says «غير محفوظ».
  const legacy = ownerAnswer({ inputs: [OWN_ROW] });
  const legacyBase = draftOf(legacy);
  const legacyShown = { ...legacyBase, models: withOptionMeasure(legacyBase.models, { combo: PACKED }, { combo: PACKED }) };
  assert.deepEqual([...measurePendingOf(legacyBase, legacyShown)], ['combo']);
  assert.deepEqual([...measurePendingOf(legacyBase, legacyBase)], []);
});

test('a stored model minimum profit the dollar field cannot draw (dinars, or BLOCKED) is shown kept — never «يتبع المنتج» — and stays until changed', () => {
  const rules = (r: { state: string; amount_usd: string | null; amount_iqd?: number | null }) =>
    ownerAnswer({ inputs: [OWN_ROW], rules: [{ scope: 'product', scope_id: '', state: 'ACTIVE', amount_usd: '143.9' }, { scope: 'option', scope_id: 'combo', ...r }] });
  const dinars = rules({ state: 'ACTIVE', amount_usd: null, amount_iqd: 150_000 });
  const m = draftOf(dinars).models.combo!;
  assert.deepEqual([m.cost, m.profit, m.profit_iqd], ['own', 'kept', 150_000]);
  assert.deepEqual(wireOf(dinars, (d) => d), {}, 'left as it is: nothing sent, the rule stays');
  // Changed: «يتبع المنتج» sends INHERIT; an exception sends its dollars.
  assert.deepEqual(wireOf(dinars, (d) => withModel(d, 'combo', { profit: 'follow' })).cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '' }]);
  assert.deepEqual(wireOf(dinars, (d) => withModel(d, 'combo', { profit: 'exception', profit_usd: '60' })).cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '60' }]);
  const blocked = draftOf(rules({ state: 'BLOCKED', amount_usd: null })).models.combo!;
  assert.deepEqual([blocked.profit, blocked.profit_iqd], ['kept', null]);
  assert.equal(V2_STRINGS.ar.profitKeptIqd('150,000'), 'استثناء محفوظ: 150,000 د.ع');
});

test('a colour difference edited keeps the colour’s stored discount (it was silently dropped)', () => {
  const a = ownerAnswer({ points: [{ scope: 'color', id: 'red', kind: 'delta', usd: '5' }], discounts: [{ scope: 'product', id: '', usd: '35' }, { scope: 'color', id: 'red', usd: '10' }] });
  const edit = (d: PriceDraft) => ({ ...d, colours: { ...d.colours, red: { ...FOLLOW_COLOUR, price: 'delta' as const, usd: '7' } } });
  const w = wireOf(a, edit);
  assert.deepEqual(w.points, [{ scope: 'color', id: 'red', kind: 'delta', usd: '7' }]);
  assert.equal(w.discounts, undefined, 'the discounts did not change: nothing sent, every stored row kept');
  // With the product's discount changed too, the full set still carries the colour's.
  const both = wireOf(a, (d) => ({ ...edit(d), discount_usd: '30' }));
  assert.deepEqual(both.discounts, [
    { scope: 'color', id: 'red', usd: '10' },
    { scope: 'product', id: '', usd: '30' },
  ]);
});

/** One table row as the owner reads it (the server's shape, `dto.ts`). */
const tableRow = (combo_key: string, channel: V2TableRow['channel'], price: number | null, owner: Partial<NonNullable<V2TableRow['owner']>> = {}, extra: Partial<V2TableRow> = {}): V2TableRow => {
  const [model, colour] = combo_key.replace(/o:|c:/g, '').split('|');
  return {
    combo_key,
    option_value_ids: [model!],
    color_id: colour ?? null,
    names: { ar: combo_key, en: combo_key, ckb: combo_key },
    channel,
    price_iqd: price,
    source: 'stock',
    owner: { v2_exact_iqd: '0', v2_usd_ceil6: '0', v2_delta_usd: '0', v2_discount_usd: channel === 'direct_sale' ? null : '35', v2_discount_scope: null, v2_floor: 'none', v2_replacement_iqd: null, v2_profit_usd: '143.9', v2_below_cost: false, ...owner },
    ...extra,
  };
};

test('the cards read the server’s reasons: the discount taken, withdrawn, stopped, unavailable', () => {
  const s = V2_STRINGS.ar;
  const line = (rows: V2TableRow[]) => skuLines(rows)[0]!;
  const ok = line([tableRow('o:combo', 'direct_sale', 906_000), tableRow('o:combo', 'pre_order_land', 853_500)]);
  assert.equal(preorderOffOf(ok.channels.pre_order_land, ok.channels.direct_sale), '35');
  assert.deepEqual(lineNotes(ok, s), []);
  assert.equal(`(${s.preorderAfterOff('$35.00')})`, '(بعد خصم $35.00)');
  // Withdrawn: P = D, and the card says why.
  const withdrawn = line([tableRow('o:combo', 'direct_sale', 906_000), tableRow('o:combo', 'pre_order_land', 906_000, { v2_floor: 'discount_withdrawn' })]);
  assert.equal(preorderOffOf(withdrawn.channels.pre_order_land, withdrawn.channels.direct_sale), null);
  assert.deepEqual(lineNotes(withdrawn, s), ['الخصم أكبر من ربح هذا المسار — يُباع بسعر البيع المباشر']);
  // Stopped on the shelf, and unavailable without a supplier price.
  const blocked = (code: string) => line([tableRow('o:combo', 'direct_sale', 906_000), tableRow('o:combo', 'pre_order_land', null, {}, { blocked: true, v2_blocked: code as V2TableRow['v2_blocked'] })]);
  assert.deepEqual(lineNotes(blocked('V2_ROUTE_SHELF_CHEAPER'), s), [s.routeShelfCheaperNote]);
  assert.deepEqual(lineNotes(blocked('V2_ROUTE_NO_SUPPLIER'), s), [s.routeNoSupplierNote]);
  assert.equal(preorderOffOf(blocked('V2_ROUTE_SHELF_CHEAPER').channels.pre_order_land, null), null);
  assert.deepEqual(lineNotes(null, s), []);
  // No discount at all: nothing to show.
  const flat = line([tableRow('o:combo', 'direct_sale', 906_000), tableRow('o:combo', 'pre_order_land', 906_000, { v2_discount_usd: '0' })]);
  assert.equal(preorderOffOf(flat.channels.pre_order_land, flat.channels.direct_sale), null);
});

test('the model card reads its colour-less line, else a colour that follows its model — never a colour difference first', () => {
  const rows = [
    tableRow('o:combo|c:red', 'direct_sale', 921_000, {}, { source: 'colour_delta' }),
    tableRow('o:combo|c:black', 'direct_sale', 906_000, {}, { source: 'stock' }),
  ];
  assert.equal(lineWithOption(rows, 'combo')!.combo_key, 'o:combo|c:black');
  assert.equal(lineWithOption(rows, 'combo', { red: { ...FOLLOW_COLOUR, price: 'delta', usd: '10' } })!.combo_key, 'o:combo|c:black');
  assert.equal(lineWithOption([...rows, tableRow('o:combo', 'direct_sale', 906_000)], 'combo')!.combo_key, 'o:combo');
  assert.equal(lineWithOption([rows[0]!], 'combo')!.combo_key, 'o:combo|c:red', 'the only line, named by the card');
  assert.equal(lineWithOption(rows, 'a1'), null);
});

/* ------------------- 3. the packaged measure in every model mode (the owner, 2026-10-18; DECISIONS row 247) -- */

test('the measure chain: the model’s and the colour’s own packaged weight and box decide their levels — SKU row → colour → model → product', () => {
  assert.deepEqual(packagedMeasureOf({ package_weight_g: 13_500, package_depth_mm: 560, package_width_mm: 540, package_height_mm: 430 }), { weight_g: 13_500, box: [560, 540, 430] });
  assert.equal(packagedMeasureOf({ net_weight_g: 12_000, package_depth_mm: 560 }), null, 'net weight is never used; a partial box inherits');
  assert.equal(packagedMeasureOf(null), null);
  const inputs = [
    { scope: 'base', scope_id: '', origin: 'MANUAL_OVERRIDE', supplier_cost_amount: '269', supplier_cost_currency: 'EUR', shipping_profile: 'CHINA_AIR', shipping_weight_g: 6240, shipping_length_mm: 400, shipping_width_mm: 300, shipping_height_mm: 200 },
    // A value saved in pricing only, and an imported manual CBM: the option's own package decides over both.
    { scope: 'option', scope_id: 'combo', origin: 'MANUAL_OVERRIDE', shipping_weight_g: 9000 },
    { scope: 'option', scope_id: 'combo', origin: 'SOURCE', manual_cbm: '0.5', unresolved_fields: '[]' },
    { scope: 'sku', scope_id: 'o:combo|c:heavy', origin: 'MANUAL_OVERRIDE', shipping_weight_g: 15_000 },
  ] as unknown as StoredInputRow[];
  const COMBO_PACK = { weight_g: 13_500, box: [560, 540, 430] as const };
  const measure = (unit: Partial<UnitSelection>) => {
    const r = resolveSkuInputs(chainOfUnit(inputs, { option_value_ids: ['combo'], color_id: null, combo_key: null, ...unit })).inputs;
    const b = r.cbm?.box;
    return { g: r.weight?.value ?? null, at: r.weight?.level ?? null, box: b ? [b.length_mm, b.width_mm, b.height_mm] : null, boxAt: r.cbm?.level ?? null, cbm: r.cbm?.effective ?? null };
  };
  // The A1 Combo, whatever its price mode: its «أبعاد الخيار» — never the pricing-only 9,000 g, never the manual CBM.
  assert.deepEqual(measure({ packaged: { model: COMBO_PACK } }), { g: 13_500, at: 'option', box: [560, 540, 430], boxAt: 'option', cbm: '0.130032' });
  // No package of its own: its pricing row as before (row 247: a pricing-only value is never cleared silently).
  assert.deepEqual(measure({}), { g: 9000, at: 'option', box: null, boxAt: 'option', cbm: '0.5' });
  // A model with nothing: the product's measure.
  assert.deepEqual(measure({ option_value_ids: ['a1'] }), { g: 6240, at: 'base', box: [400, 300, 200], boxAt: 'base', cbm: '0.024' });
  // A colour with its own package is the more specific level: it beats the model's, field by field (weight, box).
  const RED = { weight_g: 14_200, box: [600, 560, 450] as const };
  assert.deepEqual(measure({ color_id: 'red', combo_key: 'o:combo|c:red', packaged: { model: COMBO_PACK, color: RED } }), { g: 14_200, at: 'color', box: [600, 560, 450], boxAt: 'color', cbm: '0.1512' });
  assert.deepEqual(measure({ color_id: 'red', combo_key: 'o:combo|c:red', packaged: { model: COMBO_PACK, color: { weight_g: 14_200, box: null } } }), { g: 14_200, at: 'color', box: [560, 540, 430], boxAt: 'option', cbm: '0.130032' });
  // A colour package on a model with none: the colour's; the SKU's own pricing row beats both.
  assert.equal(measure({ option_value_ids: ['a1'], color_id: 'red', combo_key: 'o:a1|c:red', packaged: { color: RED } }).g, 14_200);
  assert.deepEqual(measure({ color_id: 'heavy', combo_key: 'o:combo|c:heavy', packaged: { model: COMBO_PACK, color: RED } }).g, 15_000);
  // Only the model (the first value) carries the model's package: a second group's value never conflicts with it.
  assert.equal(measure({ option_value_ids: ['combo', 'size_l'], packaged: { model: COMBO_PACK } }).g, 13_500);
});

test('the owner 2026-10-18: the A1 Combo on «يتبع المنتج» and on «زيادة» ships at its «أبعاد الخيار» — 13,500 g, box 560 × 540 × 430 mm; A1 (none) at the product’s', async () => {
  const w = await world({ shelf: false }); // no batch: the supplier's cost prices both models (row 244)
  const route = (ev: Awaited<ReturnType<typeof writeV2>>, model: string, channel = 'pre_order_land') =>
    ev.result!.skus.find((s) => s.combo_key === `o:${model}`)!.channels.find((c) => c.channel === channel)!.replacement!;
  const base = { method: 'cost' as const, minimumProfitUsd: '143.9', discounts: [{ scope: 'product' as const, scope_id: '', usd: '35' }], dryRun: true };
  const DELTA: V2PricePoint = { scope: 'option', scope_id: COMBO, kind: 'delta', usd: '40' };
  for (const points of [[], [DELTA]]) {
    const ev = await writeV2(w.db, PID, { ...base, points });
    assert.equal(route(ev, COMBO).effective_weight_g, 13_500, points.length ? '«زيادة»' : '«يتبع المنتج»');
    assert.equal(route(ev, A1).effective_weight_g, 6240, 'a model with no package of its own: the product’s measure');
  }
  // Stocked by sea, the box prices the direct sale: the Combo's 560 × 540 × 430, A1 the product's 400 × 300 × 200.
  const sea = await writeV2(w.db, PID, { ...base, inputs: { shipping_profile: 'CHINA_SEA', shipping_length_mm: 400, shipping_width_mm: 300, shipping_height_mm: 200 } });
  assert.equal(route(sea, COMBO, 'direct_sale').effective_cbm, '0.130032');
  assert.equal(route(sea, A1, 'direct_sale').effective_cbm, '0.024');
  // The form's preview prices the same (the engine at 13.5 kg on «يتبع المنتج» and «زيادة»; A1 at 6,240 g).
  const followed = await previewOf(w.app, {});
  assert.deepEqual([at(followed.table, COMBO, 'direct_sale'), at(followed.table, COMBO, 'pre_order_land')], pair(price(combo({ own: BOX_13_5, shelf: null }))));
  assert.deepEqual([at(followed.table, A1, 'direct_sale'), at(followed.table, A1, 'pre_order_land')], pair(price(combo({ shelf: null }))));
  const delta = await previewOf(w.app, { points: [{ scope: 'option', id: COMBO, kind: 'delta', usd: '40' }] });
  assert.deepEqual(
    [at(delta.table, COMBO, 'direct_sale'), at(delta.table, COMBO, 'pre_order_land')],
    pair(price(combo({ own: BOX_13_5, shelf: null }), [{ scope: 'option', scope_id: 'combo', kind: 'delta', usd: '40' }]))
  );
  // Nothing published moved: the stored prices change only through a reviewed publish or the automatic repricing.
  assert.equal(row<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND scope = 'option'", PID)!.n, 0, 'no second store: the dimensions are the measure');
});

test('a colour with its own packaged dimensions ships on them; a colour with none on the product’s', async () => {
  const w = await world();
  seedOptionless(w.raw, 'p_col', { colours: 2 });
  w.raw.exec("UPDATE product_colors SET package_weight_g = 2500, package_depth_mm = 500, package_width_mm = 400, package_height_mm = 300 WHERE id = 'p_col_c0'");
  const inputs = { supplier_cost_amount: '100', supplier_cost_currency: 'USD' as const, shipping_profile: 'CHINA_AIR' as const, shipping_weight_g: 1000 };
  const o = { method: 'cost' as const, minimumProfitUsd: '10', inputs, dryRun: true };
  const route = (ev: Awaited<ReturnType<typeof writeV2>>, colour: string) =>
    ev.result!.skus.find((s) => s.combo_key.includes(colour))!.channels.find((c) => c.channel === 'direct_sale')!.replacement!;
  const air = await writeV2(w.db, 'p_col', o);
  assert.equal(route(air, 'p_col_c0').effective_weight_g, 2500);
  assert.equal(route(air, 'p_col_c1').effective_weight_g, 1000);
  const sea = await writeV2(w.db, 'p_col', { ...o, inputs: { ...inputs, shipping_profile: 'CHINA_SEA', shipping_length_mm: 400, shipping_width_mm: 300, shipping_height_mm: 200 } });
  assert.equal(route(sea, 'p_col_c0').effective_cbm, '0.06');
  assert.equal(route(sea, 'p_col_c1').effective_cbm, '0.024');
});

test('«أبعاد الخيار» edited on a saved product: the form prices the draft, and the save prices the same (own cost and follow)', async () => {
  const w = await world({ shelf: false });
  // What the form holds and posts (ProductForm `structureOf` / `save`): the document, its relations.
  const product = (await json(await get(w.app, `/api/admin/products-v2/${PID}`))).product;
  const state = hydrateRelations((await json(await get(w.app, `/api/admin/products/${PID}/relations`))) as never, product as never);
  const { options: _o, colors: _c, media: _m, ...docFields } = toEditorDoc(product as never) as unknown as Record<string, unknown>;
  void _o; void _c; void _m;
  const withCombo = (rs: RelationsState, patch: Record<string, number>): RelationsState => ({
    ...rs,
    groups: rs.groups.map((g, i) => (i ? g : { ...g, values: g.values.map((v) => (v.id === COMBO ? { ...v, dimensions: { ...v.dimensions!, ...patch } } : v)) })),
  });
  const heavier = withCombo(state, { package_weight_g: 20_000 });
  // The priced structure follows the model's and the colour's packages (it held ids and flags only); net weight never prices.
  const key = (rs: RelationsState) => pricedStructureKey(product.sale_types, rs);
  assert.notEqual(key(heavier), key(state), 'a package edit marks the structure dirty: the preview prices the draft');
  assert.equal(key(withCombo(state, { net_weight_g: 9000 })), key(state));
  const colourPack = { ...state, colors: [{ id: 'c1', active: true, option_value_ids: [], dimensions: { package_weight_g: 900 } }] } as unknown as RelationsState;
  assert.notEqual(key(colourPack), key({ ...state, colors: [{ id: 'c1', active: true, option_value_ids: [] }] } as unknown as RelationsState), 'a colour’s package too');
  const structure = { doc: docFields, relations: relationsToWire(heavier) as unknown as Record<string, unknown> };
  const preview = async (pricing: Record<string, unknown>, withStructure = true) => {
    const res = await post(w.app, '/api/admin/products-v2/pricing/preview', { product_id: PID, ...(withStructure ? { structure } : {}), pricing });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
    return body as V2Answer & { review_hash: string };
  };
  // «يتبع المنتج»: the draft's 20 kg freights the Combo (CHINA_AIR 20,000 IQD/kg: 6.5 kg more), A1 unmoved.
  const stored = (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))) as V2Answer;
  const follow = await preview({});
  assert.ok(at(follow.table, COMBO, 'pre_order_land')! > at(stored.table, COMBO, 'pre_order_land')!, 'the heavier package moves the price');
  assert.equal(at(follow.table, A1, 'pre_order_land'), at(stored.table, A1, 'pre_order_land'));
  // «تكلفة مختلفة»: the wire's weight is the mirror of the edited package — the draft and the wire agree on 20 kg.
  const own = (g: number) => ({ cost: { inputs: [{ scope: 'option', scope_id: COMBO, supplier_cost_amount: '375', supplier_cost_currency: 'EUR', shipping_weight_g: g, shipping_length_mm: 560, shipping_width_mm: 540, shipping_height_mm: 430 }] } });
  const ownHeavy = await preview(own(20_000));
  const ownStored = await preview(own(13_500), false);
  assert.notEqual(at(ownHeavy.table, COMBO, 'pre_order_land'), at(ownStored.table, COMBO, 'pre_order_land'), 'the 20 kg the form shows is the 20 kg it prices');
  // The save prices the same draft: the preview's hash is accepted, and the published prices are the preview's.
  const body = { ...docWithoutLegacyMoney(docFields), relations: withoutLegacyMoney(relationsToWire(heavier)), expected_updated_at: product.updated_at };
  const saved = await post(w.app, '/api/admin/products-v2', { ...body, pricing_v2: { pricing: own(20_000), preview_hash: ownHeavy.review_hash, confirm_large_change: true } });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 400));
  const back = (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))) as V2Answer;
  for (const channel of ['direct_sale', 'pre_order_land']) assert.equal(at(back.table, COMBO, channel), at(ownHeavy.table, COMBO, channel), channel);
});

test('the new words, in Arabic, English and real Sorani', () => {
  const sorani = /[ڕڵێۆە]/;
  for (const k of ['shelfOwnCostNote', 'minProfitFrom', 'profitBlocked', 'currencyChoose', 'currencyRequired'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(V2_STRINGS[lang][k].trim().length > 0, `${lang}.${k}`);
    assert.notEqual(V2_STRINGS.ckb[k], V2_STRINGS.ar[k]);
    assert.match(V2_STRINGS.ckb[k], sorani, k);
  }
  // The hints quote the option's dimensions heading as the form shows it — in every language (a Sorani reader finds it).
  const heading = optionDimsHeading('A1 Combo');
  assert.equal(heading, 'أبعاد A1 Combo / Option dimensions');
  for (const k of ['optionMeasureFrom', 'savedPricingOnly', 'measurePending', 'optionDimsPricing', 'optionWeightPricing', 'optionBoxPricing'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(V2_STRINGS[lang][k](heading).includes(`«${heading}»`), `${lang}.${k}`);
    assert.notEqual(V2_STRINGS.ckb[k](heading), V2_STRINGS.ar[k](heading));
    assert.match(V2_STRINGS.ckb[k]('X'), sorani, k);
  }
  for (const k of ['inheritsProductMeasure', 'preorderAfterOff', 'profitKeptIqd'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.match(V2_STRINGS[lang][k]('$35.00'), /\$35\.00/);
    assert.notEqual(V2_STRINGS.ckb[k]('X'), V2_STRINGS.ar[k]('X'));
    assert.match(V2_STRINGS.ckb[k]('X'), sorani, k);
  }
  assert.equal(V2_STRINGS.ar.inheritsProductMeasure('6.24'), 'يرث من المنتج: 6.24');
  assert.equal(V2_STRINGS.en.preorderAfterOff('$35.00'), 'after $35.00 off');
});

/* ---------- 4. a cost on every model and colour, both methods, dinars too (the owner 2026-10-18, DECISIONS row 254) -- */

const PRODUCT_700 = { scope: 'product' as const, id: '', kind: 'fixed' as const, usd: '700' };
const priceFirstAnswer = (o: Parameters<typeof ownerAnswer>[0] = {}): V2Answer => {
  const a = ownerAnswer(o);
  return { ...a, method: 'usd', v2_points: [...(a.v2_points ?? []), PRODUCT_700] };
};
const withColour = (d: PriceDraft, id: string, patch: Partial<ColourDraft>): PriceDraft => ({ ...d, colours: { ...d.colours, [id]: { ...(d.colours[id] ?? FOLLOW_COLOUR), ...patch } } });
const COLOUR_ROW = { ...OWN_ROW, scope: 'color', scope_id: 'red', supplier_cost_amount: '290' };

test('row 254, the wire: a model’s own cost is the owner’s in both methods — price-first it is sent, and moves no price', () => {
  const a = priceFirstAnswer();
  const w = wireOf(a, (d) => withModel(d, 'combo', { cost: 'own', supplier_amount: '375', supplier_currency: 'EUR' }));
  assert.equal(w.method, undefined, 'the method stays');
  assert.equal(w.points, undefined, 'no price moves');
  assert.deepEqual(w.cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_amount: '375', supplier_cost_currency: 'EUR' }]);
  // Stored on a price-first product: «تكلفة مختلفة», the price still «يتبع المنتج» — two choices.
  const stored = priceFirstAnswer({ inputs: [OWN_ROW] });
  const m = draftOf(stored).models.combo!;
  assert.deepEqual([m.cost, m.price, m.supplier_amount, m.supplier_currency], ['own', 'follow', '375', 'EUR']);
  // A difference beside the own cost: only the point travels; the cost did not change.
  const both = wireOf(stored, (d) => withModel(d, 'combo', { price: 'delta', usd: '+20' }));
  assert.deepEqual(both.points, [{ scope: 'option', id: 'combo', kind: 'delta', usd: '20' }, PRODUCT_700]);
  assert.equal(both.cost, undefined);
  // A stored own cost beside a stored difference reads back as both (it was hidden behind «فرق في السعر»).
  const delta = draftOf(ownerAnswer({ inputs: [OWN_ROW], points: [{ scope: 'option', id: 'combo', kind: 'delta', usd: '20' }] })).models.combo!;
  assert.deepEqual([delta.cost, delta.price, delta.usd, delta.supplier_amount], ['own', 'delta', '20', '375']);
  // «تتبع المنتج» clears it (INHERIT), price-first too; switching the method keeps it as it is.
  assert.deepEqual(wireOf(stored, (d) => withModel(d, 'combo', { cost: 'follow' })).cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_amount: null }]);
  assert.equal(wireOf(stored, (d) => ({ ...d, method: 'cost' })).cost, undefined, 'the method switch alone sends no cost');
});

test('row 254, the wire: a colour’s own cost travels as scope color — its currency named, its price untouched', () => {
  const a = ownerAnswer({ points: [{ scope: 'color', id: 'red', kind: 'delta', usd: '5' }] });
  const w = wireOf(a, (d) => withColour(d, 'red', { cost: 'own', supplier_amount: '290' }));
  assert.deepEqual(w.cost?.inputs, [{ scope: 'color', scope_id: 'red', supplier_cost_amount: '290', supplier_cost_currency: 'EUR' }], '«يتبع المنتج» names the product currency');
  assert.equal(w.points, undefined, 'the colour difference is untouched');
  // In its own currency, price-first too.
  const usd = wireOf(priceFirstAnswer(), (d) => withColour(d, 'red', { cost: 'own', supplier_amount: '320', supplier_currency: 'USD' }));
  assert.deepEqual(usd.cost?.inputs, [{ scope: 'color', scope_id: 'red', supplier_cost_amount: '320', supplier_cost_currency: 'USD' }]);
  // Stored, it reads back beside its difference; «تتبع الموديل» clears it.
  const stored = ownerAnswer({ inputs: [COLOUR_ROW], points: [{ scope: 'color', id: 'red', kind: 'delta', usd: '5' }] });
  const c = draftOf(stored).colours.red!;
  assert.deepEqual([c.cost, c.price, c.usd, c.supplier_amount, c.supplier_currency], ['own', 'delta', '5', '290', 'EUR']);
  assert.deepEqual(wireOf(stored, (d) => withColour(d, 'red', { cost: 'follow', supplier_amount: '', supplier_currency: '' })).cost?.inputs, [
    { scope: 'color', scope_id: 'red', supplier_cost_amount: null },
  ]);
  // The difference edited keeps the own cost: only the point travels.
  const moved = wireOf(stored, (d) => withColour(d, 'red', { usd: '7' }));
  assert.deepEqual(moved.points, [{ scope: 'color', id: 'red', kind: 'delta', usd: '7' }]);
  assert.equal(moved.cost, undefined);
  // The cost edited alone resends no point; a colour gone from the product is never named.
  const cost = wireOf(stored, (d) => withColour(d, 'red', { supplier_amount: '300' }));
  assert.equal(cost.points, undefined);
  assert.deepEqual(cost.cost?.inputs, [{ scope: 'color', scope_id: 'red', supplier_cost_amount: '300' }]);
  const base = draftOf(stored);
  const gone = draftWire(base, withColour(base, 'red', { supplier_amount: '300' }), { points: [], discounts: [] }, { ...LIVE, colours: new Set() }, OPTS);
  assert.equal(gone.cost, undefined);
});

test('row 254, the wire: a cost in Iraqi dinars travels as supplier_cost_iqd alone, and reads back as the dinars typed', () => {
  assert.deepEqual(wireOf(ownerAnswer(), (d) => withModel(d, 'combo', { cost: 'own', supplier_amount: '1500000', supplier_currency: 'IQD' })).cost?.inputs, [
    { scope: 'option', scope_id: 'combo', supplier_cost_iqd: 1_500_000 },
  ]);
  // A colour's (Arabic-Indic digits are digits), and the product's own (its card offers dinars too).
  assert.deepEqual(wireOf(ownerAnswer(), (d) => withColour(d, 'red', { cost: 'own', supplier_amount: '٣٠٠٠٠٠', supplier_currency: 'IQD' })).cost?.inputs, [
    { scope: 'color', scope_id: 'red', supplier_cost_iqd: 300_000 },
  ]);
  assert.deepEqual(wireOf(ownerAnswer(), (d) => ({ ...d, cost: { ...d.cost, supplier_amount: '400000', supplier_currency: 'IQD' } })).cost?.inputs, [{ scope: 'base', supplier_cost_iqd: 400_000 }]);
  // Whole dinars only: a fraction or nothing is no amount (the field says so), never a guess.
  assert.equal(cleanIqdAmount('1500.5'), null);
  assert.equal(cleanIqdAmount('0'), null);
  assert.equal(cleanIqdAmount('1,500,000'), 1_500_000);
  // The product's cost stored in dinars (IQD_CONVERTED): drawn as the dinars typed; untouched, nothing travels.
  const a = ownerAnswer();
  const converted = { ...a.v2_cost_inputs!.inputs[0]!, supplier_cost_amount: '266.666667', supplier_cost_currency: 'USD' as const, supplier_input_mode: 'IQD_CONVERTED' as const, original_input_amount: '400000' };
  const iqd: V2Answer = { ...a, v2_cost_inputs: { ...a.v2_cost_inputs!, inputs: [converted] } };
  assert.deepEqual([draftOf(iqd).cost.supplier_amount, draftOf(iqd).cost.supplier_currency], ['400000', 'IQD']);
  assert.deepEqual(wireOf(iqd, (d) => d), {}, 'the same dinars: the stored conversion stands');
  // A model following that currency types dinars too.
  assert.deepEqual(wireOf(iqd, (d) => withModel(d, 'combo', { cost: 'own', supplier_amount: '250000' })).cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_iqd: 250_000 }]);
  // Leaving dinars, the amount and its currency travel — even the same digits; emptied, both clear.
  assert.deepEqual(wireOf(iqd, (d) => ({ ...d, cost: { ...d.cost, supplier_currency: 'USD' } })).cost?.inputs, [{ scope: 'base', supplier_cost_amount: '400000', supplier_cost_currency: 'USD' }]);
  assert.deepEqual(wireOf(iqd, (d) => ({ ...d, cost: { ...d.cost, supplier_amount: '' } })).cost?.inputs, [{ scope: 'base', supplier_cost_amount: null, supplier_cost_currency: null }]);
  // An option row stored in dinars reads back the same way.
  const model = draftOf(ownerAnswer({ inputs: [{ ...OWN_ROW, supplier_cost_amount: '1000', supplier_cost_currency: 'USD', supplier_input_mode: 'IQD_CONVERTED', original_input_amount: '1500000' }] })).models.combo!;
  assert.deepEqual([model.cost, model.supplier_amount, model.supplier_currency], ['own', '1500000', 'IQD']);
});

test('row 254, the wire: a price editor never sends a cost — a model’s, a colour’s or the product’s', () => {
  const a = priceFirstAnswer({ inputs: [OWN_ROW, COLOUR_ROW] });
  const base = draftOf(a);
  const typed = withColour(withModel({ ...base, cost: { ...base.cost, supplier_amount: '400000', supplier_currency: 'IQD' } }, 'combo', { supplier_amount: '999' }), 'red', { supplier_amount: '1' });
  const editor = draftWire(base, typed, { points: a.v2_points ?? [], discounts: a.v2_discounts ?? [] }, LIVE, { needsMethod: false, cost: false, money: true });
  assert.equal(editor.cost, undefined);
  assert.ok(!JSON.stringify(editor).includes('supplier'));
});

async function colourWorld() {
  const raw: DatabaseSync = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1500');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  seedOptionless(raw, COL, { colours: 2, routes: ['land'] });
  const db = asD1(raw);
  await writeV2(db, COL, {
    method: 'usd',
    points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '400' }],
    inputs: { supplier_cost_amount: '100', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2000 },
    minimumProfitUsd: '50',
  });
  return { raw, db, app: v2App(raw) };
}
const COL = 'p_colours254';
const directOf = (table: V2TableRow[], match: (r: V2TableRow) => boolean) => table.find((r) => r.channel === 'direct_sale' && match(r))!;

test('row 254, the server: price-first takes a model’s own cost — no price moves, the owner’s reading follows it', async () => {
  const w = await world({ shelf: false });
  await writeV2(w.db, PID, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '700' }], discounts: [{ scope: 'product', scope_id: '', usd: '35' }] });
  const stored = (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))) as V2Answer;
  assert.equal(stored.method, 'usd');
  // The form's own wire for «تكلفة مختلفة: 375 EUR» on the Combo, price-first.
  const wire = draftWire(draftOf(stored), withModel(draftOf(stored), COMBO, { cost: 'own', supplier_amount: '375', supplier_currency: 'EUR' }), dollarsOf(stored), {
    options: new Set([A1, COMBO]),
    models: new Set([A1, COMBO]),
    colours: new Set(),
    skus: new Set(stored.table.map((r) => r.combo_key)),
  }, OPTS);
  assert.deepEqual(wire, { cost: { inputs: [{ scope: 'option', scope_id: COMBO, supplier_cost_amount: '375', supplier_cost_currency: 'EUR' }] } });
  const pre = await previewOf(w.app, { ...wire });
  // Price-first: the typed dollars price every model, the own cost or not ($700 × 1,500).
  for (const id of [A1, COMBO]) {
    assert.equal(at(pre.table, id, 'direct_sale'), 1_050_000, id);
    assert.equal(at(pre.table, id, 'direct_sale'), at(stored.table, id, 'direct_sale'));
  }
  // The owner's reading follows it: the Combo's cost is 106 EUR × 1.1 × 1,500 = 174,900 higher, A1's unchanged;
  // its own cost + the minimum profit ($143.90) is now above $700 — the warning, never a moved price.
  const owner = (t: V2TableRow[], id: string) => directOf(t, (r) => r.combo_key === `o:${id}`).owner!;
  assert.equal(owner(pre.table, COMBO).v2_replacement_iqd! - owner(stored.table, COMBO).v2_replacement_iqd!, 174_900);
  assert.equal(owner(pre.table, A1).v2_replacement_iqd, owner(stored.table, A1).v2_replacement_iqd);
  assert.equal(owner(stored.table, COMBO).v2_below_min_profit, false);
  assert.equal(owner(pre.table, COMBO).v2_below_min_profit, true);
  // Saved, read back: the cost on the Combo, the method and the prices as they were.
  const saved = await put(w.app, `/api/admin/products-v2/${PID}/pricing`, { seq: pre.seq, pricing: wire, preview_hash: pre.review_hash });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 400));
  const back = (await json(await get(w.app, `/api/admin/products-v2/${PID}/pricing`))) as V2Answer;
  assert.equal(back.method, 'usd');
  assert.equal(at(back.table, COMBO, 'direct_sale'), 1_050_000);
  const m = draftOf(back).models[COMBO]!;
  assert.deepEqual([m.cost, m.price, m.supplier_amount, m.supplier_currency], ['own', 'follow', '375', 'EUR']);
});

test('row 254, the server: a colour’s own cost in dinars — converted once, priced on its colour only, read back as the dinars typed', async () => {
  const w = await colourWorld();
  const stored = (await json(await get(w.app, `/api/admin/products-v2/${COL}/pricing`))) as V2Answer;
  const c0 = `${COL}_c0`;
  const c1 = `${COL}_c1`;
  const live: V2LiveIds = { options: new Set(), models: new Set(), colours: new Set([c0, c1]), skus: new Set(stored.table.map((r) => r.combo_key)) };
  const base = draftOf(stored);
  const wire = draftWire(base, withColour(base, c0, { cost: 'own', supplier_amount: '300000', supplier_currency: 'IQD' }), dollarsOf(stored), live, OPTS);
  assert.deepEqual(wire, { cost: { inputs: [{ scope: 'color', scope_id: c0, supplier_cost_iqd: 300_000 }] } });
  const res = await post(w.app, '/api/admin/products-v2/pricing/preview', { product_id: COL, pricing: wire });
  const pre = (await json(res)) as V2Answer & { review_hash: string };
  assert.equal(res.status, 200, JSON.stringify(pre).slice(0, 400));
  const colourRow = (t: V2TableRow[], id: string) => directOf(t, (r) => r.color_id === id);
  // The price is the typed $400 on both; the cost of c0 alone is 300,000 instead of $100 × 1,500.
  assert.equal(colourRow(pre.table, c0).price_iqd, 600_000);
  assert.equal(colourRow(pre.table, c1).price_iqd, 600_000);
  assert.equal(colourRow(pre.table, c0).owner!.v2_replacement_iqd! - colourRow(pre.table, c1).owner!.v2_replacement_iqd!, 150_000);
  assert.equal(colourRow(pre.table, c1).owner!.v2_replacement_iqd, colourRow(stored.table, c1).owner!.v2_replacement_iqd);
  const saved = await put(w.app, `/api/admin/products-v2/${COL}/pricing`, { seq: pre.seq, pricing: wire, preview_hash: pre.review_hash });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 400));
  const stored0 = row<{ supplier_cost_amount: string; supplier_cost_currency: string; supplier_input_mode: string; original_input_amount: string }>(
    w.raw,
    "SELECT supplier_cost_amount, supplier_cost_currency, supplier_input_mode, original_input_amount FROM pricing_inputs WHERE product_id = ? AND scope = 'color' AND scope_id = ?",
    COL,
    c0
  );
  assert.deepEqual({ ...stored0, supplier_cost_amount: Number(stored0!.supplier_cost_amount) }, { supplier_cost_amount: 200, supplier_cost_currency: 'USD', supplier_input_mode: 'IQD_CONVERTED', original_input_amount: '300000' });
  // The owner's answer reads it back as typed; the form draws dinars, and sends nothing for them again.
  const back = (await json(await get(w.app, `/api/admin/products-v2/${COL}/pricing`))) as V2Answer;
  const input = back.v2_cost_inputs!.inputs.find((r) => r.scope === 'color' && r.scope_id === c0)!;
  assert.deepEqual([input.supplier_input_mode, input.original_input_amount], ['IQD_CONVERTED', '300000']);
  assert.ok(back.v2_cost_inputs!.inputs.every((r) => 'original_input_amount' in r && 'supplier_input_mode' in r));
  const again = draftOf(back);
  assert.deepEqual([again.colours[c0]!.cost, again.colours[c0]!.supplier_amount, again.colours[c0]!.supplier_currency], ['own', '300000', 'IQD']);
  assert.deepEqual(draftWire(again, again, dollarsOf(back), live, OPTS), {});
  // A price editor's answer carries no cost row at all (v2_cost_inputs is the owner's).
  const editor = stubApp(asD1(w.raw), EDITOR, (a) => a.route('/api/admin/products-v2', adminProductsRoutes));
  const theirs = await get(editor, `/api/admin/products-v2/${COL}/pricing`);
  assert.equal(theirs.status, 200);
  const text = await theirs.text();
  assert.doesNotMatch(text, /v2_cost_inputs|original_input_amount|supplier_input_mode|300000/);
});

/* --------- 5. the review of row 254: a fold over dinars, and a colour on its own cost (the coordinator's three findings) -- */

const IQD_BASE = {
  product_id: 'p_x', scope: 'base', scope_id: '', origin: 'MANUAL_OVERRIDE', supplier_cost_amount: '1000', supplier_cost_delta: null, supplier_cost_currency: 'USD',
  shipping_profile: 'GERMANY_LAND', pricing_weight_g: null, shipping_weight_g: 2000, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null, manual_cbm: null,
  additional_cost_iqd: null, supplier_input_mode: 'IQD_CONVERTED', original_input_amount: '1500000', original_input_currency: 'IQD', conversion_rate_snapshot: '1500',
  conversion_fx_version: 1, canonical_supplier_cost_usd: '1000', converted_at: '2026-10-01T00:00:00.000Z',
} as unknown as StoredInputRow;
const writeOf = (set: InputWrite['set'], iqd?: InputWrite['iqd']): InputWrite => ({ scope: 'base', scope_id: '', existing: IQD_BASE, set, source_ref: 'test', ...(iqd ? { iqd } : {}) });

test('the merged store keeps each row self-consistent: a supplier cost replaced leaves dinars; untouched, the snapshot stands', () => {
  // A purchase fold (or an owner's edit) that sets the supplier cost: SOURCE_CURRENCY, the snapshot cleared.
  const [fold] = mergedInputs([IQD_BASE], [writeOf({ supplier_cost_amount: '900', supplier_cost_currency: 'EUR' })]);
  assert.deepEqual([fold!.supplier_cost_amount, fold!.supplier_cost_currency, fold!.supplier_input_mode, fold!.original_input_amount, fold!.canonical_supplier_cost_usd], ['900', 'EUR', 'SOURCE_CURRENCY', null, null]);
  // A currency alone touches the supplier cost too.
  assert.equal(mergedInputs([IQD_BASE], [writeOf({ supplier_cost_currency: 'EUR' })])[0]!.supplier_input_mode, 'SOURCE_CURRENCY');
  // Another field only: the conversion stands, byte for byte.
  const [weight] = mergedInputs([IQD_BASE], [writeOf({ shipping_weight_g: 2500 })]);
  assert.deepEqual([weight!.supplier_input_mode, weight!.original_input_amount, weight!.canonical_supplier_cost_usd, weight!.shipping_weight_g], ['IQD_CONVERTED', '1500000', '1000', 2500]);
  // New dinars converted: the write's own snapshot.
  const snap = { original_input_amount: '3000000', conversion_rate_snapshot: '1500', conversion_fx_version: 2, converted_at: '2026-10-18T00:00:00.000Z' };
  const [dinars] = mergedInputs([IQD_BASE], [writeOf({ supplier_cost_amount: '2000', supplier_cost_currency: 'USD' }, snap)]);
  assert.deepEqual([dinars!.supplier_input_mode, dinars!.original_input_amount, dinars!.canonical_supplier_cost_usd, dinars!.conversion_fx_version], ['IQD_CONVERTED', '3000000', '2000', 2]);
  // Cleared: no supplier, no mode, no snapshot.
  const [cleared] = mergedInputs([IQD_BASE], [writeOf({ supplier_cost_amount: null, supplier_cost_currency: null })]);
  assert.deepEqual([cleared!.supplier_input_mode, cleared!.original_input_amount], [null, null]);
});

test('a needs-pricing product whose dinar cost a pending purchase replaced reads back as the purchase’s amount — never the old dinars', async () => {
  const FOLD = 'p_fold254';
  const raw: DatabaseSync = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1500');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  seedOptionless(raw, FOLD, { routes: ['land'] });
  raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, shipping_profile, shipping_weight_g,
     supplier_input_mode, original_input_amount, original_input_currency, conversion_rate_snapshot, conversion_fx_version, canonical_supplier_cost_usd, converted_at, source_ref, version, updated_at)
     VALUES ('${FOLD}','base','','MANUAL_OVERRIDE','1000','USD','GERMANY_LAND',2000,'IQD_CONVERTED','1500000','IQD','1500',1,'1000','2026-10-01T00:00:00.000Z','x',1,'2026-10-01T00:00:00.000Z')`);
  raw.exec(`INSERT INTO pricing_rules (id, product_id, kind, scope, scope_id, state, amount_usd, source, version, updated_at) VALUES ('r_fold','${FOLD}','target_profit','product','','ACTIVE','50','OWNER',1,'2026-10-01T00:00:00.000Z')`);
  raw.exec(`INSERT INTO pricing_v2_purchase_reviews (id, product_id, purchase_id, inputs_json, state, created_at)
     VALUES ('pvr_fold','${FOLD}','po_x','[{"scope":"base","scope_id":"","set":{"supplier_cost_amount":"900","supplier_cost_currency":"EUR"},"source_ref":"purchase"}]','pending','2026-10-02T00:00:00.000Z')`);
  const app = v2App(raw);
  const a = (await json(await get(app, `/api/admin/products-v2/${FOLD}/pricing`))) as V2Answer;
  assert.equal(a.needs_pricing, true);
  const base = a.v2_cost_inputs!.inputs.find((r) => r.scope === 'base')!;
  // The row the answer prices (the fold's 900 EUR) — its mode and snapshot describe it, not the old 1,500,000 dinars.
  assert.deepEqual([base.supplier_cost_amount, base.supplier_cost_currency, base.supplier_input_mode, base.original_input_amount], ['900', 'EUR', 'SOURCE_CURRENCY', null]);
  const d = draftOf(a);
  assert.deepEqual([d.cost.supplier_amount, d.cost.supplier_currency], ['900', 'EUR']);
  // Switching the currency names the currency alone (900 USD) — never 1,500,000 USD.
  const live: V2LiveIds = { options: new Set(), models: new Set(), colours: new Set(), skus: new Set(a.table.map((r) => r.combo_key)) };
  const switched = draftWire(d, { ...d, cost: { ...d.cost, supplier_currency: 'USD' } }, dollarsOf(a), live, { ...OPTS, needsMethod: true });
  assert.deepEqual(switched.cost?.inputs, [{ scope: 'base', supplier_cost_currency: 'USD' }]);
  // Saved untouched: the store holds what the answer showed.
  const wire = draftWire(d, d, dollarsOf(a), live, { ...OPTS, needsMethod: true });
  const pre = (await json(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: FOLD, pricing: wire }))) as V2Answer & { review_hash: string };
  const saved = await put(app, `/api/admin/products-v2/${FOLD}/pricing`, { seq: pre.seq, pricing: wire, preview_hash: pre.review_hash });
  assert.equal(saved.status, 200, (await saved.clone().text()).slice(0, 400));
  const stored = row<{ supplier_cost_amount: string; supplier_cost_currency: string; supplier_input_mode: string; original_input_amount: string | null }>(
    raw,
    "SELECT supplier_cost_amount, supplier_cost_currency, supplier_input_mode, original_input_amount FROM pricing_inputs WHERE product_id = ? AND scope = 'base' AND origin = 'MANUAL_OVERRIDE'",
    FOLD
  );
  assert.deepEqual({ ...stored }, { supplier_cost_amount: '900', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', original_input_amount: null });
});

test('a colour on its own cost is never a model card’s line, nor the reference of its final price (or the product’s)', () => {
  // T $50: red on its own cost ($290) → $340; black follows the Combo's own cost ($370) → $420.
  const ref = (combo_key: string, ceil6: string, source: V2TableRow['source'] = 'model_cost') => tableRow(combo_key, 'direct_sale', 1, { v2_usd_ceil6: ceil6, v2_profit_usd: '50' }, { source });
  const rows = [ref('o:combo|c:red', '340', 'colour_cost'), ref('o:combo|c:black', '420')];
  const colours = { red: { ...FOLLOW_COLOUR, cost: 'own' as const, supplier_amount: '290', supplier_currency: 'USD' as const } };
  assert.equal(lineWithOption(rows, 'combo', colours)!.combo_key, 'o:combo|c:black', 'the draft says red has its own cost');
  assert.equal(lineWithOption(rows, 'combo')!.combo_key, 'o:combo|c:black', 'the server says so (colour_cost)');
  const red = skuLines(rows)[0]!;
  const draft = { models: { combo: { ...FOLLOW_MODEL, cost: 'own' as const, supplier_amount: '370', supplier_currency: 'USD' as const, profit: 'exception' as const, profit_usd: '50' } }, skus: {}, colours };
  assert.equal(modelFinalLine(rows, red, 'combo', draft)!.combo_key, 'o:combo|c:black', 'the model’s T is read on the model’s own cost');
  assert.equal(productFinalLine(rows, red, { models: {}, skus: {}, colours })!.combo_key, 'o:combo|c:black');
  // Only own-cost colours: no reference at all (the field waits), never a colour's cost read as the model's.
  assert.equal(modelFinalLine([rows[0]!], red, 'combo', draft), null);
  // A colour that follows again is a reference again.
  assert.equal(modelFinalLine(rows, red, 'combo', { ...draft, colours: { red: { ...FOLLOW_COLOUR } } })!.combo_key, 'o:combo|c:red');
});

test('cost-first, a colour on its own cost is «من تكلفة اللون» — shown apart from its model, never folded under it', async () => {
  const raw: DatabaseSync = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1500');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'");
  seedOptionless(raw, COL, { colours: 3, routes: ['land'] });
  await writeV2(asD1(raw), COL, {
    method: 'cost',
    inputs: { supplier_cost_amount: '100', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2000 },
    minimumProfitUsd: '50',
  });
  const app = v2App(raw);
  const stored = (await json(await get(app, `/api/admin/products-v2/${COL}/pricing`))) as V2Answer;
  const [c0, c1, c2] = [0, 1, 2].map((k) => `${COL}_c${k}`) as [string, string, string];
  const live: V2LiveIds = { options: new Set(), models: new Set(), colours: new Set([c0, c1, c2]), skus: new Set(stored.table.map((r) => r.combo_key)) };
  const base = draftOf(stored);
  const wire = draftWire(base, withColour(base, c1, { cost: 'own', supplier_amount: '110', supplier_currency: 'USD' }), dollarsOf(stored), live, OPTS);
  const res = await post(app, '/api/admin/products-v2/pricing/preview', { product_id: COL, pricing: wire });
  const pre = (await json(res)) as V2Answer;
  assert.equal(res.status, 200, JSON.stringify(pre).slice(0, 400));
  const sourceOf = (id: string) => [...new Set(pre.table.filter((r) => r.color_id === id).map((r) => r.source))];
  assert.deepEqual(sourceOf(c1), ['colour_cost']);
  assert.deepEqual(sourceOf(c0), ['product']);
  assert.deepEqual(sourceOf(c2), ['product']);
  // Its price differs ($110 + $50 against $100 + $50): the table shows it, and folds only the colours that follow.
  assert.ok(directOf(pre.table, (r) => r.color_id === c1).price_iqd! > directOf(pre.table, (r) => r.color_id === c2).price_iqd!);
  const [block] = modelBlocks(pre.table, () => null);
  assert.equal(block!.lead.color_id, c0);
  assert.deepEqual(block!.shown.map((l) => l.color_id), [c1]);
  assert.deepEqual(block!.folded.map((l) => l.color_id), [c2]);
  // Its label, in Arabic, English and real Sorani.
  assert.deepEqual([V2_STRINGS.ar.sourceColourCost, V2_STRINGS.en.sourceColourCost], ['من تكلفة اللون', "From the colour's cost"]);
  assert.notEqual(V2_STRINGS.ckb.sourceColourCost, V2_STRINGS.ar.sourceColourCost);
  assert.match(V2_STRINGS.ckb.sourceColourCost, /[ڕڵێۆە]/);
});
