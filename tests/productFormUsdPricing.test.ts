/**
 * PRICING AND SHIPPING INSIDE «تعديل منتج» / «إضافة منتج» — THE SCREEN (owner
 * correction 2026-10-09): src/components/adminProducts/form/UsdPricingSection.tsx
 * and its wiring in ProductForm.tsx (sections ٣ «الأسعار», ٥ «الخيارات والألوان»
 * and ٨ «المعاينة والحفظ»).
 *
 * Proves:
 *   - the measure is the form's own package measurement: an edit, an adoption
 *     or an empty pricing measure carries it to pricing; a stored pricing
 *     measure (say, from a purchase) is never overwritten silently; clearing a
 *     package measurement never clears a pricing one; only the measure the
 *     route prices by travels (the box for sea, the weight otherwise);
 *   - the IQD convenience input sends whole dinars only (never a USD amount or
 *     a rate), and a currency switch never re-reads a number in another
 *     currency;
 *   - each model's card shows its computed customer price and direct price and
 *     says its colours follow it; a new model says its pricing follows the
 *     product's save; section ٨ shows decision 8's six columns;
 *   - non-owners get nothing (every mount point is the owner's), the product
 *     document never carries a private pricing value, and the form saves the
 *     pricing after the product through the pricing door;
 *   - an engine-priced product's «السعر» is the read-only «سعر المتجر الحالي»;
 *     «التكلفة» is the legacy cost.
 *
 * Run: node --import tsx --test tests/productFormUsdPricing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import {
  UsdPricingModelRow,
  UsdPricingPreview,
  UsdPricingProductPanel,
  UsdPricingProvider,
  draftProblems,
  draftWire,
  effectiveDrafts,
  measureDraftOf,
  packageMeasureOf,
  type ScopeAnswer,
  type UsdPricingAnswer,
  type UsdPricingFormContext,
  type UsdPricingState,
} from '../src/components/adminProducts/form/UsdPricingSection';
import { USD_PRICING_FORM_STRINGS } from '../src/components/adminProducts/form/usdPricingStrings';
import { PROCUREMENT_PRICING_STRINGS } from '../src/components/adminOperations/procurementPricingStrings';
import { emptyDimensions, type ProductDimensionsV2 } from '../src/lib/productTypes';
import type { PricingSummary } from '../src/components/adminOperations/procurementPricing';
import { codeOf } from './fixtures/source';

const S = USD_PRICING_FORM_STRINGS.ar;
const P = PROCUREMENT_PRICING_STRINGS.ar;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));

const dims = (over: Partial<ProductDimensionsV2> = {}): ProductDimensionsV2 => ({ ...emptyDimensions(), ...over }) as ProductDimensionsV2;
const inputs = (over: Record<string, unknown> = {}) => ({
  supplier_cost_amount: null, supplier_cost_currency: null, supplier_input_mode: null, original_input_amount: null, conversion_rate_snapshot: null,
  converted_at: null, shipping_profile: null, shipping_weight_g: null, pricing_weight_g: null, shipping_length_mm: null, shipping_width_mm: null,
  shipping_height_mm: null, manual_cbm: null, additional_cost_iqd: null, source_ref: 'owner', ...over,
});
const scope = (s: 'base' | 'option', id: string, pricing: ReturnType<typeof inputs> | null): ScopeAnswer => ({
  scope: s, scope_id: id, name_ar: id ? 'موديل' : '', name_en: id ? 'Model' : '', name_ckb: id ? 'مۆدێل' : '', pricing_inputs: pricing,
  minimum_target_profit_usd: null, target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null,
});
const SUMMARY: PricingSummary = {
  state: 'ok', issue_codes: [], shipping_profile: 'GERMANY_LAND', profile_source: 'default', engine_priced: false, option_id: 'm1',
  rule_level: 'product', minimum_target_profit_usd: '120', target_profit_iqd: null, target_profit_cents: 12_000,
  current_total_cost_cents: 50_000, final_price_cents: 62_000, preorder_base_iqd: 992_000, direct_sale_extra_iqd: 25_000,
  direct_sale_price_iqd: 1_017_000, rounding_added_iqd: 0, supplier_original_amount: '450', supplier_original_currency: 'EUR', iqd_converted: null,
  cross_rate: '1.1', supplier_cost_usd: '495', supplier_cost_cents: 49_500, basis: 'weight', effective_weight_g: 2500, effective_cbm: null,
  shipping_rate: '3200', shipping_cost_iqd: 8000, shipping_cost_usd: '5', shipping_cost_cents: 500, additional_cost_iqd: 0, additional_cost_usd: '0',
  additional_cost_cents: 0, excluded_charges: [], current_total_cost_usd: '500', final_price_usd: '620', usd_iqd_rate: '1600', document_rate: null,
  store_price_iqd: 900_000,
};
const answerOf = (base: ReturnType<typeof inputs> | null, option: ReturnType<typeof inputs> | null = null): UsdPricingAnswer => ({
  product_id: 'p1', mode: 'manual', inputs_seq: 3, rates: { usd_iqd_rate: '1600', review_pending: false, derived_stale: false },
  scopes: [scope('base', '', base), scope('option', 'm1', option)],
  models: [{ option_id: 'm1', name_ar: 'موديل', name_en: 'Model', name_ckb: 'مۆدێل', sells_direct: true, pricing_summary: SUMMARY }],
  rows: [
    { option_id: 'm1', name_ar: 'موديل', name_en: 'Model', name_ckb: 'مۆدێل', channel: 'direct_sale', today_prepaid_iqd: 950_000, today_cod_iqd: 950_000, cod_priced_as_direct: false, computed_price_iqd: 1_017_000, change_iqd: 67_000, replacement_cost_iqd: 800_000, target_profit_usd: '120', target_profit_iqd: 192_000, direct_sale_extra_iqd: 25_000, preorder_base_iqd: 992_000, issue_codes: [] },
    { option_id: 'm1', name_ar: 'موديل', name_en: 'Model', name_ckb: 'مۆدێل', channel: 'pre_order_land', today_prepaid_iqd: 900_000, today_cod_iqd: 900_000, cod_priced_as_direct: false, computed_price_iqd: 992_000, change_iqd: 92_000, replacement_cost_iqd: 800_000, target_profit_usd: '120', target_profit_iqd: 192_000, direct_sale_extra_iqd: null, preorder_base_iqd: 992_000, issue_codes: [] },
  ],
  preview_hash: 'a'.repeat(64),
});
const formOf = (over: Partial<UsdPricingFormContext> = {}): UsdPricingFormContext => ({
  baseDimensions: dims({ package_weight_g: 2500 }),
  optionDimensions: { m1: dims() },
  savedBaseDimensions: dims({ package_weight_g: 2500 }),
  savedOptionDimensions: { m1: dims() },
  models: [{ id: 'm1', name_en: 'Model', name_ar: 'موديل', name_ckb: 'مۆدێل', sells_direct: true }],
  productSellsDirect: true,
  setMeasure: () => {},
  ...over,
});
const stateOf = (answer: UsdPricingAnswer, over: Partial<UsdPricingState> = {}): UsdPricingState => ({
  enabled: true, productId: 'p1', form: formOf(), answer, shown: answer, drafts: {}, effective: {}, dirty: false, invalid: false, busy: false,
  saving: false, notInstalled: false, error: '', notice: '', engine: false, setDraft: () => {}, discard: () => {}, save: async () => {},
  reload: () => {}, snapshot: () => null, saveAfterProduct: async () => ({ ok: true, message: '' }), ...over,
});
const withState = (state: UsdPricingState, el: Parameters<typeof renderToStaticMarkup>[0]) => render(createElement(UsdPricingProvider, { value: state, children: el }));

test('the measure is the form’s package measurement: L × W × H from depth, width, height, whole or nothing', () => {
  assert.deepEqual(packageMeasureOf(dims({ package_weight_g: 2500, package_depth_mm: 500, package_width_mm: 400, package_height_mm: 300 })), {
    weight_g: 2500, box: [500, 400, 300], partial_box: false,
  });
  assert.deepEqual(packageMeasureOf(dims({ package_depth_mm: 500 })), { weight_g: null, box: null, partial_box: true });
  assert.deepEqual(packageMeasureOf(null), { weight_g: null, box: null, partial_box: false });
});

test('a measure reaches pricing by the owner’s act: an edit, an adoption, or an empty pricing measure — never over a stored one silently', () => {
  const m = (w: number | null) => ({ weight_g: w, box: null, partial_box: false });
  assert.deepEqual(measureDraftOf(m(2500), m(2500), inputs(), false), { shipping_weight_g: 2500 }, 'an empty pricing measure takes the box weight');
  assert.deepEqual(measureDraftOf(m(2500), m(2500), inputs({ shipping_weight_g: 2700 }), false), {}, 'a purchase’s weight stays until the owner acts');
  assert.deepEqual(measureDraftOf(m(2600), m(2500), inputs({ shipping_weight_g: 2700 }), false), { shipping_weight_g: 2600 }, 'an edit in the form is the owner’s act');
  assert.deepEqual(measureDraftOf(m(2500), m(2500), inputs({ shipping_weight_g: 2700 }), true), { shipping_weight_g: 2500 }, '«اعتمد قياس الصندوق للتسعير»');
  assert.deepEqual(measureDraftOf(m(null), m(2500), inputs({ shipping_weight_g: 2500 }), false), {}, 'clearing the package weight never clears pricing');
  assert.deepEqual(measureDraftOf(m(2500), m(2400), inputs({ shipping_weight_g: 2500 }), false), {}, 'already equal: nothing to save');
  const box = { weight_g: null, box: [500, 400, 300] as const, partial_box: false };
  assert.deepEqual(measureDraftOf(box, box, inputs(), false), { box: [500, 400, 300] });
  assert.deepEqual(measureDraftOf(box, box, inputs({ shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: 300 }), false), {});
});

test('only the measure the route prices by travels; a model inherits the product’s route; a model removed from the form takes its drafts with it', () => {
  const form = formOf({
    baseDimensions: dims({ package_weight_g: 2500, package_depth_mm: 500, package_width_mm: 400, package_height_mm: 300 }),
    savedBaseDimensions: dims({ package_weight_g: 2500, package_depth_mm: 500, package_width_mm: 400, package_height_mm: 300 }),
    optionDimensions: { m1: dims({ package_weight_g: 3100 }) },
    savedOptionDimensions: { m1: dims({ package_weight_g: 3100 }) },
  });
  assert.deepEqual(effectiveDrafts({}, answerOf(null), form), {}, 'no route, no measure');
  assert.deepEqual(effectiveDrafts({ base: { shipping_profile: 'GERMANY_LAND' } }, answerOf(null), form), {
    base: { shipping_weight_g: 2500, shipping_profile: 'GERMANY_LAND' },
    'option:m1': { shipping_weight_g: 3100 },
  });
  assert.deepEqual(effectiveDrafts({}, answerOf(inputs({ shipping_profile: 'CHINA_SEA' })), form), { base: { box: [500, 400, 300] } });
  const gone = effectiveDrafts({ 'option:old': { additional_cost_iqd: 5000 } }, answerOf(null), form);
  assert.equal(gone['option:old'], undefined);
});

test('the dinar input sends whole dinars only; a box goes as its three axes; a scope the server does not know yet waits', () => {
  const answer = answerOf(inputs({ supplier_cost_amount: '450', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY' }));
  const wire = draftWire(
    {
      base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 792_000, box: [500, 400, 300] },
      'option:m1': { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_000_000, reconvert: true, box: null },
      'option:new': { additional_cost_iqd: 1000 },
    },
    answer
  );
  assert.deepEqual(wire.inputs, [
    { scope: 'base', supplier_cost_iqd: 792_000, shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: 300 },
    { scope: 'option', scope_id: 'm1', supplier_cost_iqd: 1_000_000, reconvert: true, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null },
  ]);
  assert.doesNotMatch(JSON.stringify(wire), /conversion|canonical|usd_iqd|1600/);
  // Choosing the dinar input needs its amount; leaving it needs the new currency's amount.
  assert.ok(draftProblems({ supplier_cost_currency: 'IQD' }).supplier_cost_iqd);
  assert.equal(draftProblems({ supplier_cost_currency: 'IQD' }, inputs({ supplier_input_mode: 'IQD_CONVERTED' })).supplier_cost_iqd, undefined);
  assert.ok(draftProblems({ supplier_cost_currency: 'IQD', supplier_cost_iqd: 0 }).supplier_cost_iqd);
  assert.ok(draftProblems({ supplier_cost_currency: 'EUR', supplier_cost_amount: '' }, inputs({ supplier_input_mode: 'IQD_CONVERTED' })).supplier_cost_amount);
  assert.deepEqual(draftProblems({ supplier_cost_currency: 'EUR', supplier_cost_amount: '450' }, inputs({ supplier_input_mode: 'IQD_CONVERTED' })), {});
});

test('each model’s card: its computed customer price and direct price, its colours follow it, its bar; a new model waits for the product’s save', () => {
  const answer = answerOf(inputs({ shipping_profile: 'GERMANY_LAND' }));
  const html = withState(stateOf(answer), createElement(UsdPricingModelRow, { model: { id: 'm1', name_en: 'Model', name_ar: 'موديل', sells_direct: true } }));
  assert.ok(html.includes(S.modelTitle));
  assert.ok(html.includes(S.customerPrice('992,000 د.ع')), html);
  assert.ok(html.includes(S.directPrice('1,017,000 د.ع')));
  assert.ok(html.includes(S.coloursFollow));
  assert.ok(html.includes(P.cellCost) && html.includes('$500.00') && html.includes('+$120.00') && html.includes('$620.00'), 'the 4-cell bar');
  assert.ok(html.includes(S.extra), 'a model sold direct shows the Direct Sale Extra');
  assert.ok(html.includes(S.measureFromForm), 'the measure is the form’s');
  const fresh = withState(stateOf(answer), createElement(UsdPricingModelRow, { model: { id: 'new1', name_en: 'New', sells_direct: false } }));
  assert.ok(fresh.includes(S.modelSavedLater));
  assert.ok(!fresh.includes(S.customerPrice('992,000 د.ع')));
  assert.ok(!fresh.includes(S.extra), 'not sold direct: no Direct Sale Extra field');
});

test('section ٣ offers the four currencies and the dinar input; section ٨ shows decision 8’s six figures; nothing renders for anyone but the owner', () => {
  const answer = answerOf(inputs({ shipping_profile: 'GERMANY_LAND', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY' }));
  const panel = withState(stateOf(answer), createElement(UsdPricingProductPanel));
  for (const c of ['USD', 'EUR', 'CNY']) assert.match(panel, new RegExp(`<option value="${c}"[^>]*>${c}</option>`), c);
  assert.match(panel, /<option value="EUR" selected="">EUR<\/option>/, 'the stored currency is the one selected');
  assert.ok(panel.includes(S.currencyIqd));
  assert.ok(panel.includes(S.minProfit) && panel.includes(S.additional) && panel.includes(S.route) && panel.includes(S.weightKg));
  assert.ok(panel.includes('$500.00'), 'one model: its bar under the product’s fields');

  const preview = withState(stateOf(answer), createElement(UsdPricingPreview));
  for (const h of [P.colReplacement, P.colMinProfit, P.colNewPreorder, P.colExtra, P.colNewDirect, P.colOldNew]) assert.ok(preview.includes(h), h);
  assert.ok(preview.includes('800,000 د.ع') && preview.includes('1,017,000 د.ع') && preview.includes('$120'));
  assert.ok(preview.includes(S.previewNote), 'this stage writes no customer price');

  const off = stateOf(answer, { enabled: false });
  for (const el of [createElement(UsdPricingProductPanel), createElement(UsdPricingPreview), createElement(UsdPricingModelRow, { model: { id: 'm1', name_en: 'Model', sells_direct: true } })])
    assert.equal(withState(off, el), '');
  assert.equal(render(createElement(UsdPricingPreview)), '', 'no provider, nothing');
});

test('the product form: every mount point is the owner’s, the document never carries a private value, the pricing saves after the product', () => {
  const form = codeOf('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /useUsdPricingState\(\{ productId: doc\.id \|\| null, enabled: canSeeCost, form: pricingForm \}\)/);
  assert.match(form, /\{canSeeCost && <UsdPricingProductPanel \/>\}/);
  assert.match(form, /\{canSeeCost && <UsdPricingOptionsFooter \/>\}/);
  assert.match(form, /\{canSeeCost && <UsdPricingPreview \/>\}/);
  assert.match(form, /valueExtra=\{\s*canSeeCost\s*\?/);
  // An engine-priced product's price is read only for the owner; everyone else keeps «السعر».
  assert.match(form, /\{canSeeCost && pricing\.engine \? \(\s*<Field ar=\{us\.storePrice\}[\s\S]{0,200}<TextInput readOnly/);
  assert.match(form, /<Field\s+ar="السعر"\s+en="Price"\s+required/);
  assert.match(form, /<Field ar=\{us\.legacyCost\}/);
  // The pricing follows the product's save, through the pricing door, from a snapshot taken before it.
  const snap = form.indexOf('const pricingSnap = pricing.snapshot();');
  const post = form.indexOf("'/api/admin/products-v2'");
  const after = form.indexOf('pricing.saveAfterProduct(savedId, pricingSnap)');
  assert.ok(snap > 0 && post > snap && after > post, 'snapshot → product save → pricing save');
  // No private pricing value is a key of the product document or its save.
  assert.doesNotMatch(form, /supplier_cost_amount|supplier_cost_iqd|minimum_target_profit_usd|direct_sale_extra_iqd|conversion_rate_snapshot/);

  const section = codeOf('src/components/adminProducts/form/UsdPricingSection.tsx');
  // Every request of the section goes to the pricing door.
  const paths = [...section.matchAll(/\.(?:get|post|put)<[^>]*>\(\s*`([^`]*)`/g)].map((m) => m[1]);
  assert.equal(paths.length, 5, String(paths));
  assert.equal((section.match(/\bapi\s*\.\s*(?:get|post|put|patch|delete)\b/g) ?? []).length, 5, 'no request outside the five above');
  for (const p of paths) assert.match(p!, /^\$\{PRICING\}\/products\//);
  assert.match(section, /const PRICING = '\/api\/admin\/pricing';/);
  // The options card renders the section's row for each model, and nothing for anyone else.
  const options = codeOf('src/components/adminProducts/form/OptionsSection.tsx');
  assert.match(options, /\{valueExtra\?\.\(v\)\}/);
});
