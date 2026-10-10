/**
 * FX-7 IN «تعديل منتج» / «إضافة منتج» — THE COLOUR AND VARIANT LEVELS ON SCREEN
 * (src/components/adminProducts/form/UsdPricingSection.tsx; section ٥
 * «الخيارات والألوان»).
 *
 * Proves:
 *   - with the SKU rung (migration 0183) each colour's card carries the same
 *     override inputs as a model, empty = inherited (its one linked model's
 *     value, else the product's), with the computed customer price of every
 *     SKU it makes; each variant row likewise, inheriting its colour, model and
 *     product; the model's card no longer says its colours follow it;
 *   - without the rung (a database before 0183) nothing of that renders and the
 *     model's card keeps its old note;
 *   - the wire carries colour and SKU scopes for inputs and rules, never a
 *     figure the server computes; the SKU key is the server's own
 *     (`skuComboKey`: values sorted, then the colour);
 *   - the preview says when the product is priced per SKU; non-owners get
 *     nothing;
 *   - every new word exists in Arabic, English and real Sorani.
 *
 * Run: node --import tsx --test tests/skuPricesForm.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import {
  UsdPricingColourRow,
  UsdPricingModelRow,
  UsdPricingPreview,
  UsdPricingProvider,
  UsdPricingSkuRow,
  draftWire,
  effectiveDrafts,
  pricingSkuKey,
  type ScopeAnswer,
  type UsdPricingAnswer,
  type UsdPricingFormContext,
  type UsdPricingState,
} from '../src/components/adminProducts/form/UsdPricingSection';
import { USD_PRICING_FORM_STRINGS } from '../src/components/adminProducts/form/usdPricingStrings';
import { ENGINE_SAVE_STRINGS } from '../src/components/adminOperations/engineSaveStrings';
import { emptyDimensions, type ProductDimensionsV2 } from '../src/lib/productTypes';
import type { PricingSummary } from '../src/components/adminOperations/procurementPricing';
import { skuComboKey } from '../packages/pricing/src/skuChannel';

const S = USD_PRICING_FORM_STRINGS.ar;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const dims = (over: Partial<ProductDimensionsV2> = {}): ProductDimensionsV2 => ({ ...emptyDimensions(), ...over }) as ProductDimensionsV2;

const inputs = (over: Record<string, unknown> = {}) => ({
  supplier_cost_amount: null, supplier_cost_currency: null, supplier_input_mode: null, original_input_amount: null, conversion_rate_snapshot: null,
  converted_at: null, shipping_profile: null, shipping_weight_g: null, pricing_weight_g: null, shipping_length_mm: null, shipping_width_mm: null,
  shipping_height_mm: null, manual_cbm: null, additional_cost_iqd: null, source_ref: 'owner', ...over,
});
const scope = (s: ScopeAnswer['scope'], id: string, pricing: ReturnType<typeof inputs> | null, over: Partial<ScopeAnswer> = {}): ScopeAnswer => ({
  scope: s, scope_id: id, name_ar: 'اسم', name_en: 'Name', name_ckb: 'ناو', pricing_inputs: pricing,
  minimum_target_profit_usd: null, target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null, ...over,
});
const summary = (pre: number, direct: number | null): PricingSummary => ({
  state: 'ok', issue_codes: [], shipping_profile: 'CHINA_SEA', profile_source: 'default', engine_priced: true, option_id: 'm1',
  rule_level: 'product', minimum_target_profit_usd: '3', target_profit_iqd: null, target_profit_cents: 300,
  current_total_cost_cents: 1_200, final_price_cents: 1_500, preorder_base_iqd: pre, direct_sale_extra_iqd: direct === null ? null : direct - pre,
  direct_sale_price_iqd: direct, rounding_added_iqd: 0, supplier_original_amount: '12', supplier_original_currency: 'USD', iqd_converted: null,
  cross_rate: null, supplier_cost_usd: '12', supplier_cost_cents: 1_200, basis: 'volume', effective_weight_g: null, effective_cbm: '0.005',
  shipping_rate: '400000', shipping_cost_iqd: 2000, shipping_cost_usd: '1.25', shipping_cost_cents: 125, additional_cost_iqd: 0, additional_cost_usd: '0',
  additional_cost_cents: 0, excluded_charges: [], current_total_cost_usd: '13.25', final_price_usd: '16.25', usd_iqd_rate: '1600', document_rate: null,
  store_price_iqd: null,
});
const RED = 'c1';
const BLUE = 'c2';
const KEY_RED = pricingSkuKey(['m1'], RED);

const answerOf = (levels: boolean): UsdPricingAnswer => ({
  product_id: 'p1', mode: 'engine', inputs_seq: 7, write_seq: 3, rates: { usd_iqd_rate: '1600', review_pending: false, derived_stale: false },
  sku_levels: levels,
  per_sku: levels,
  scopes: [
    scope('base', '', inputs({ supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', manual_cbm: '0.005' }), { minimum_target_profit_usd: '3' }),
    scope('option', 'm1', null),
    ...(levels
      ? [
          scope('color', RED, inputs({ supplier_cost_amount: '12', supplier_cost_currency: 'USD' }), { name_en: 'Red' }),
          scope('color', BLUE, null, { name_en: 'Blue' }),
          scope('sku', KEY_RED, null, { name_en: 'Model · Red' }),
        ]
      : []),
  ],
  models: [{ option_id: 'm1', name_ar: 'موديل', name_en: 'Model', name_ckb: 'مۆدێل', sells_direct: true, pricing_summary: summary(23_000, 25_000) }],
  skus: levels
    ? [
        { combo_key: KEY_RED, option_id: 'm1', option_value_ids: ['m1'], color_id: RED, name_ar: 'موديل · أحمر', name_en: 'Model · Red', name_ckb: 'مۆدێل · سوور', sells_direct: true, pricing_summary: summary(26_000, 28_000) },
        { combo_key: pricingSkuKey(['m1'], BLUE), option_id: 'm1', option_value_ids: ['m1'], color_id: BLUE, name_ar: 'موديل · أزرق', name_en: 'Model · Blue', name_ckb: 'مۆدێل · شین', sells_direct: true, pricing_summary: summary(23_000, 25_000) },
      ]
    : [],
  rows: [],
  preview_hash: 'b'.repeat(64),
});
const formOf = (over: Partial<UsdPricingFormContext> = {}): UsdPricingFormContext => ({
  baseDimensions: dims(),
  optionDimensions: { m1: dims() },
  savedBaseDimensions: dims(),
  savedOptionDimensions: { m1: dims() },
  models: [{ id: 'm1', name_en: 'Model', name_ar: 'موديل', name_ckb: 'مۆدێل', sells_direct: true }],
  productSellsDirect: true,
  colours: [
    { id: RED, name_en: 'Red', name_ar: 'أحمر', name_ckb: 'سوور', option_ids: [] },
    { id: BLUE, name_en: 'Blue', name_ar: 'أزرق', name_ckb: 'شین', option_ids: ['m1'] },
  ],
  skus: [{ combo_key: KEY_RED, option_value_ids: ['m1'], color_id: RED }],
  colourDimensions: { [RED]: dims(), [BLUE]: dims() },
  savedColourDimensions: { [RED]: dims(), [BLUE]: dims() },
  skuDimensions: { [KEY_RED]: dims() },
  savedSkuDimensions: { [KEY_RED]: dims() },
  setMeasure: () => {},
  ...over,
});
const stateOf = (answer: UsdPricingAnswer, over: Partial<UsdPricingState> = {}): UsdPricingState => ({
  enabled: true, productId: 'p1', form: formOf(), answer, shown: answer, drafts: {}, effective: {}, dirty: false, touched: false, invalid: false,
  invalidWhere: '', busy: false, saving: false, notInstalled: false, error: '', notice: '', outcome: null, serverField: null, rateKnownMissing: false,
  engine: true, setDraft: () => {}, discard: () => {}, save: async () => {}, reload: () => {}, snapshot: () => null,
  saveAfterProduct: async () => ({ ok: true, message: '' }), afterProductSaved: async () => {}, review: null, reviewBusy: false,
  confirmReview: async () => {}, cancelReview: () => {}, openReview: () => {}, exitEngine: async () => {}, ...over,
});
const withState = (state: UsdPricingState, el: Parameters<typeof renderToStaticMarkup>[0]) => render(createElement(UsdPricingProvider, { value: state, children: el }));

test('the SKU key is the server’s own: the option values sorted, then the colour', () => {
  for (const [ids, colour] of [[['m2', 'm1'], 'c9'], [['m1'], null], [[], 'c1'], [['zz', 'aa', 'mm'], 'c']] as const) {
    assert.equal(pricingSkuKey(ids, colour), skuComboKey({ option_value_ids: ids, color_id: colour }));
  }
});

test('with the SKU rung each colour’s card prices its own SKUs and edits its own values; the model no longer says its colours follow it', () => {
  const answer = answerOf(true);
  const model = withState(stateOf(answer), createElement(UsdPricingModelRow, { model: { id: 'm1', name_en: 'Model', sells_direct: true } }));
  assert.ok(model.includes(S.coloursOwn), 'the model points to the colours');
  assert.ok(!model.includes(S.coloursFollow), 'the «colours follow the model» note is gone');

  const red = withState(stateOf(answer), createElement(UsdPricingColourRow, { colour: formOf().colours![0]! }));
  assert.ok(red.includes(S.colourTitle));
  assert.ok(red.includes(S.colourInherits));
  assert.ok(red.includes(S.customerPrice('26,000 د.ع')), red);
  assert.ok(red.includes(S.directPrice('28,000 د.ع')));
  assert.ok(!red.includes(S.customerPrice('23,000 د.ع')), 'only this colour’s SKUs');
  assert.ok(red.includes('value="12"'), 'the colour’s own stored value');
  assert.ok(red.includes(S.minProfit) && red.includes(S.additional) && red.includes(S.route) && red.includes(S.extra), 'the same override inputs as a model');
  // Linked to no single model: the product's values are its "inherits" placeholders.
  assert.ok(red.includes(S.inheritPlaceholder('$3')), 'the minimum profit inherited from the product');

  const variant = withState(stateOf(answer), createElement(UsdPricingSkuRow, { comboKey: KEY_RED }));
  assert.ok(variant.includes(S.skuTitle) && variant.includes(S.skuInherits));
  assert.ok(variant.includes(S.customerPrice('26,000 د.ع')));
  // The variant inherits its colour's supplier cost first.
  assert.ok(variant.includes(S.inheritPlaceholder('12 USD')), variant);
});

test('without the SKU rung (a database before 0183) no colour or variant pricing renders and the model keeps its old note', () => {
  const answer = answerOf(false);
  const model = withState(stateOf(answer), createElement(UsdPricingModelRow, { model: { id: 'm1', name_en: 'Model', sells_direct: true } }));
  assert.ok(model.includes(S.coloursFollow));
  assert.equal(withState(stateOf(answer), createElement(UsdPricingColourRow, { colour: formOf().colours![0]! })), '');
  assert.equal(withState(stateOf(answer), createElement(UsdPricingSkuRow, { comboKey: KEY_RED })), '');
});

test('the wire carries colour and SKU scopes for inputs and rules — typed values only, never a computed figure', () => {
  const answer = answerOf(true);
  const drafts = {
    [`color:${BLUE}`]: { supplier_cost_amount: '13', minimum_target_profit_usd: '4' },
    [`sku:${KEY_RED}`]: { minimum_target_profit_usd: '5', direct_sale_extra_iqd: 3000, additional_cost_iqd: 500 },
  };
  const eff = effectiveDrafts(drafts, answer, formOf());
  assert.deepEqual(Object.keys(eff).sort(), [`color:${BLUE}`, `sku:${KEY_RED}`]);
  const wire = draftWire(eff, answer);
  assert.deepEqual(wire.inputs, [
    { scope: 'color', scope_id: BLUE, supplier_cost_amount: '13', supplier_cost_currency: 'USD' },
    { scope: 'sku', scope_id: KEY_RED, additional_cost_iqd: 500 },
  ]);
  assert.deepEqual(wire.rules, [
    { kind: 'target_profit', scope: 'color', scope_id: BLUE, amount_usd: '4' },
    { kind: 'target_profit', scope: 'sku', scope_id: KEY_RED, amount_usd: '5' },
    { kind: 'direct_sale_extra', scope: 'sku', scope_id: KEY_RED, amount_iqd: 3000 },
  ]);
  assert.doesNotMatch(JSON.stringify(wire), /26000|28000|preorder|computed/);
  // A colour removed from the form (and unknown to the server) takes its drafts with it.
  const gone = effectiveDrafts({ 'color:c404': { supplier_cost_amount: '1' } }, answer, formOf());
  assert.deepEqual(Object.keys(gone), []);
});

test('the preview says when the product is priced per SKU; non-owners get nothing', () => {
  const answer = answerOf(true);
  const preview = withState(stateOf(answer), createElement(UsdPricingPreview));
  assert.ok(preview.includes(S.perSkuNote));
  assert.ok(!withState(stateOf(answerOf(false)), createElement(UsdPricingPreview)).includes(S.perSkuNote));
  for (const el of [createElement(UsdPricingColourRow, { colour: formOf().colours![0]! }), createElement(UsdPricingSkuRow, { comboKey: KEY_RED })]) {
    assert.equal(withState(stateOf(answer, { enabled: false }), el), '', 'the owner’s alone');
  }
});

test('every new word in Arabic, English and real Sorani (never the Arabic in the Sorani slot)', () => {
  const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
  const ARABIC_ONLY = /[ةىيك]/;
  const keys = ['coloursOwn', 'colourTitle', 'colourInherits', 'colourSavedLater', 'skuTitle', 'skuInherits', 'perSkuNote'] as const;
  for (const k of keys) {
    const { ar, en, ckb } = { ar: USD_PRICING_FORM_STRINGS.ar[k], en: USD_PRICING_FORM_STRINGS.en[k], ckb: USD_PRICING_FORM_STRINGS.ckb[k] };
    for (const s of [ar, en, ckb]) assert.ok(typeof s === 'string' && s.trim().length > 0, k);
    assert.notEqual(ckb, ar, k);
    assert.match(ckb, SORANI_ONLY, k);
    assert.doesNotMatch(ckb, ARABIC_ONLY, k);
    assert.doesNotMatch(en, /[؀-ۿ]/, k);
  }
  for (const k of ['exitConfirmPerSku', 'reasonSkus'] as const) {
    const { ar, en, ckb } = { ar: ENGINE_SAVE_STRINGS.ar[k], en: ENGINE_SAVE_STRINGS.en[k], ckb: ENGINE_SAVE_STRINGS.ckb[k] };
    assert.notEqual(ckb, ar, k);
    assert.match(ckb, SORANI_ONLY, k);
    assert.doesNotMatch(ckb, ARABIC_ONLY, k);
    assert.doesNotMatch(en, /[؀-ۿ]/, k);
  }
});
