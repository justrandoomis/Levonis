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
 *      the model and colour cards read the server's reasons.
 *
 * Run: node --import tsx --test tests/pricingV2OptionPricing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { applyRate, OWNER_ROW_SQL } from './fixtures/fx';
import { v2App, writeV2 } from './fixtures/pricingV2';
import { priceProductV2, type V2Discount, type V2PricePoint, type V2Sku } from '@levonis/pricing/priceV2';
import { roundPriceIqd } from '../packages/pricing/src/priceRounding';
import {
  FOLLOW_MODEL,
  draftOf,
  draftWire,
  lineWithOption,
  measurePendingOf,
  optionDimsHeading,
  preorderOffOf,
  withOptionMeasure,
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
import { adminProductsRoutes } from '../worker/routes/adminProducts';

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
async function world() {
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
  for (const [model, cost] of [
    [COMBO, 685_831],
    [COMBO, 689_581],
    [COMBO, 690_062],
    [A1, 500_346],
  ] as const) {
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
  assert.equal(m.price, 'own_cost');
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
  const model = wireOf(a, (d) => withModel(d, 'combo', { price: 'own_cost', profit: 'exception', profit_usd: '60' }));
  assert.deepEqual(model.cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '60' }]);
  // Both changed: the product's row first, then the model's — never a row that did not change.
  const both = wireOf(a, (d) => withModel({ ...d, min_profit_usd: '150' }, 'combo', { price: 'own_cost', profit: 'exception', profit_usd: '60' }));
  assert.deepEqual(both.cost?.minimum_profit, [
    { kind: 'target_profit', scope: 'product', amount_usd: '150' },
    { kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '60' },
  ]);
  // A minimum profit is an «تكلفة مختلفة» choice: under «زيادة» or «يتبع المنتج» nothing is sent.
  assert.equal(wireOf(a, (d) => withModel(d, 'combo', { price: 'delta', usd: '+5', profit: 'exception', profit_usd: '60' })).cost?.minimum_profit, undefined);

  // Stored: the Combo on its own cost (375 EUR) with its own $60 → «رجوع للموروث».
  const stored = ownerAnswer({ inputs: [OWN_ROW], rules: [{ scope: 'product', scope_id: '', state: 'ACTIVE', amount_usd: '143.9' }, { scope: 'option', scope_id: 'combo', state: 'ACTIVE', amount_usd: '60' }] });
  assert.deepEqual(
    { price: draftOf(stored).models.combo!.price, profit: draftOf(stored).models.combo!.profit, profit_usd: draftOf(stored).models.combo!.profit_usd },
    { price: 'own_cost', profit: 'exception', profit_usd: '60' }
  );
  const follow = wireOf(stored, (d) => withModel(d, 'combo', { price: 'follow', supplier_amount: '', supplier_currency: '', weight_g: null, box: null, profit: 'follow', profit_usd: '' }));
  assert.deepEqual(follow.cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'combo', amount_usd: '' }]);
  assert.deepEqual(follow.cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_amount: null }], 'its own cost cleared too');
  // An INHERIT row stored for the model is not an exception.
  assert.equal(draftOf(ownerAnswer({ rules: [{ scope: 'option', scope_id: 'combo', state: 'INHERIT', amount_usd: null }] })).models.combo, undefined);
});

test('the wire: an amount typed with the currency at «يتبع المنتج» names the product currency (never a refused preview)', () => {
  const w = wireOf(ownerAnswer(), (d) => withModel(d, 'combo', { price: 'own_cost', supplier_amount: '375', supplier_currency: '' }));
  assert.deepEqual(w.cost?.inputs, [{ scope: 'option', scope_id: 'combo', supplier_cost_amount: '375', supplier_cost_currency: 'EUR' }]);
  // A currency chosen is the model's own.
  const usd = wireOf(ownerAnswer(), (d) => withModel(d, 'combo', { price: 'own_cost', supplier_amount: '375', supplier_currency: 'USD' }));
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
  const own: ModelDraft = { ...FOLLOW_MODEL, price: 'own_cost', supplier_amount: '375', supplier_currency: 'EUR' };
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
  assert.deepEqual([m.price, m.profit, m.profit_iqd], ['own_cost', 'kept', 150_000]);
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
  const edit = (d: PriceDraft) => ({ ...d, colours: { ...d.colours, red: { price: 'delta' as const, usd: '7' } } });
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
  assert.equal(lineWithOption(rows, 'combo', { red: { price: 'delta', usd: '10' } })!.combo_key, 'o:combo|c:black');
  assert.equal(lineWithOption([...rows, tableRow('o:combo', 'direct_sale', 906_000)], 'combo')!.combo_key, 'o:combo');
  assert.equal(lineWithOption([rows[0]!], 'combo')!.combo_key, 'o:combo|c:red', 'the only line, named by the card');
  assert.equal(lineWithOption(rows, 'a1'), null);
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
  for (const k of ['optionMeasureFrom', 'savedPricingOnly', 'measurePending', 'optionDimsNotPricing'] as const) {
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
