/**
 * The one readiness list of the pricing engine and its owner-only labels
 * (master plan v2 §2.3, C22, [C1-G23], [C1-V10]; packages/contracts/src/
 * pricingIssues.ts and pricingFieldLabels.ts).
 *
 * Every code and every private field label exists in Arabic, English and real
 * Sorani: `ckb` is never the Arabic or the English pasted across (DECISIONS row
 * 183), always holds at least one Sorani-only letter, and follows the pricing
 * terminology (C32/C46: shipping «ناردن», product «بەرهەم», batch «وەجبە»).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICING_ISSUES,
  PRICING_ISSUE_CODES,
  isPricingIssueCode,
  pricingIssueLabel,
  pricingIssueLabels,
  pricingIssueParams,
  pricingMissingEntriesOf,
  pricingMissingEntry,
  type PricingIssueCode,
} from '../packages/contracts/src/pricingIssues';
import {
  PRICING_CHANNEL_LABELS,
  PRICING_FIELD_LABELS,
  PRICING_LANGS,
  PRICING_ORIGIN_LABELS,
  PRICING_PROFILE_LABELS,
  PRICING_SCOPE_LABELS,
  isPricingFieldName,
  type PricingLabel,
} from '../packages/contracts/src/pricingFieldLabels';
import { SHIPPING_PROFILES, SKU_CHANNELS } from '../packages/pricing/src/skuChannel';
import { RULE_SCOPE_ORDER } from '../packages/pricing/src/ruleResolution';
import { UNRESOLVABLE_FIELDS } from '../packages/pricing/src/costToPrice';

const SORANI_ONLY = /[ێۆڕڵەڤ]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Every label table, flattened, for the shared language checks. */
const TABLES: Record<string, Readonly<Record<string, PricingLabel>>> = {
  issues: Object.fromEntries(PRICING_ISSUE_CODES.map((c) => [c, PRICING_ISSUES[c].label])),
  fields: PRICING_FIELD_LABELS,
  profiles: PRICING_PROFILE_LABELS,
  channels: PRICING_CHANNEL_LABELS,
  scopes: PRICING_SCOPE_LABELS,
  origins: PRICING_ORIGIN_LABELS,
};

test('the list holds every readiness code of master plan v2 §2.3 (v1, [C2], v2) plus DIRECT_SALE_EXTRA_BLOCKED, once each', () => {
  const v1 = [
    'SUPPLIER_COST_MISSING', 'SUPPLIER_CURRENCY_MISSING', 'SHIPPING_PROFILE_MISSING', 'WEIGHT_MISSING', 'CBM_MISSING',
    'FX_RATE_MISSING', 'SHIPPING_RATE_MISSING', 'TARGET_PROFIT_MISSING', 'DIRECT_SALE_EXTRA_MISSING', 'INPUT_CONFLICT',
    'DELTA_WITHOUT_BASE', 'CURRENCY_WITHOUT_AMOUNT', 'CURRENCY_MISMATCH', 'NEGATIVE_SUPPLIER_COST', 'AMOUNT_TOO_LARGE',
    'RULE_TIE', 'SKU_GRID_TOO_LARGE', 'RELATIONS_REQUIRED', 'COMPOSITION_NOT_PRICEABLE', 'PRICE_INVALID', 'RESOLVER_MISMATCH',
  ];
  const c2 = ['FX_RATE_UNCONFIRMED', 'SHIPPING_RATE_UNCONFIRMED', 'CHANNEL_INCOMPLETE', 'PRICE_DROP_REVIEW', 'PINNED_BELOW_TARGET', 'PRICING_CATEGORY_DIFFERS', 'RULE_ORPHANED', 'DIRECT_SALE_EXTRA_NOT_ON_STEP'];
  const v2 = ['TARGET_PROFIT_BLOCKED', 'SHIPPING_FIELD_UNRESOLVED', 'SKU_INPUTS_UNREVIEWED', 'INPUT_ORPHANED', 'MEASURE_FROM_PUBLIC_SPEC'];
  const check = ['DIRECT_SALE_EXTRA_BLOCKED']; // master-plan-v2-check (1)7
  const writer = ['PRICE_SHAPE_UNSUPPORTED', 'FX_DERIVED_STALE', 'PRICING_ENGINE_PAUSED']; // the writer (owner decision 8)
  assert.deepEqual([...PRICING_ISSUE_CODES], [...v1, ...c2, ...v2, ...check, ...writer]);
  assert.equal(new Set(PRICING_ISSUE_CODES).size, PRICING_ISSUE_CODES.length);
  assert.deepEqual(Object.keys(PRICING_ISSUES).sort(), [...PRICING_ISSUE_CODES].sort());
  assert.equal(isPricingIssueCode('RULE_TIE'), true);
  assert.equal(isPricingIssueCode('rule_tie'), false);
  assert.equal(isPricingIssueCode('toString'), false);
});

test('severity: only the never-blocking notices are warnings', () => {
  const warnings = PRICING_ISSUE_CODES.filter((c) => PRICING_ISSUES[c].severity === 'warning').sort();
  // CHANNEL_INCOMPLETE is the owner-only notice that one route is unavailable while the
  // product stays live [C2-R10]; MEASURE_FROM_PUBLIC_SPEC: "readiness warns" [C1-G11]
  // (the opt-in's measures_confirmed gate refuses, R1/L4).
  assert.deepEqual(warnings, [
    'CHANNEL_INCOMPLETE', 'INPUT_ORPHANED', 'MEASURE_FROM_PUBLIC_SPEC', 'PINNED_BELOW_TARGET', 'PRICE_DROP_REVIEW', 'PRICING_CATEGORY_DIFFERS', 'RULE_ORPHANED', 'RULE_TIE',
  ]);
  for (const c of PRICING_ISSUE_CODES) assert.ok(['error', 'warning'].includes(PRICING_ISSUES[c].severity), c);
});

test('every label is trilingual: ar, en and real Sorani, none equal to another', () => {
  for (const [table, rows] of Object.entries(TABLES)) {
    for (const [key, label] of Object.entries(rows)) {
      const where = `${table}.${key}`;
      assert.deepEqual(Object.keys(label).sort(), [...PRICING_LANGS].sort(), where);
      for (const lang of PRICING_LANGS) {
        assert.equal(typeof label[lang], 'string', `${where}.${lang}`);
        assert.ok(label[lang].trim().length > 0, `${where}.${lang} empty`);
        assert.equal(label[lang], label[lang].trim(), `${where}.${lang} padded`);
      }
      assert.notEqual(label.ckb, label.ar, `${where}: ckb copies the Arabic`);
      assert.notEqual(label.ckb, label.en, `${where}: ckb copies the English`);
      assert.notEqual(label.ar, label.en, `${where}: ar copies the English`);
      assert.match(label.ckb, SORANI_ONLY, `${where}: ckb has no Sorani-only letter (ێ ۆ ڕ ڵ ە ڤ)`);
      assert.doesNotMatch(label.ar, SORANI_ONLY, `${where}: ar holds a Sorani letter`);
      assert.match(label.ar, ARABIC_SCRIPT, `${where}: ar is not Arabic`);
      assert.doesNotMatch(label.en, ARABIC_SCRIPT, `${where}: en holds Arabic script`);
      // C32/C46: «ناردن» for shipping (never «گواستنەوە»), «بەرهەم» for product (never «کاڵا»);
      // a rule is «ڕێسا» («یاسا» is a law); a SKU is never «تێکەڵە» (a mixture).
      assert.doesNotMatch(label.ckb, /گواستنەوە|کاڵا|یاسا|تێکەڵە/, `${where}: pricing terminology (C32/C46)`);
    }
  }
});

test('placeholders are the same in all three languages and always filled', () => {
  for (const code of PRICING_ISSUE_CODES) {
    const label = PRICING_ISSUES[code].label;
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(label.ar), names(label.en), `${code}: ar placeholders`);
    assert.deepEqual(names(label.ckb), names(label.en), `${code}: ckb placeholders`);
    for (const p of names(label.en)) assert.ok(['currency', 'profile', 'field'].includes(p), `${code}: unknown placeholder ${p}`);
    for (const lang of PRICING_LANGS) {
      assert.doesNotMatch(pricingIssueLabel(code, lang), /[{}]/, `${code}.${lang}: a placeholder left unfilled without params`);
      assert.doesNotMatch(pricingIssueLabel(code, lang, { currency: 'EUR', profile: 'CHINA_SEA', field: 'manual_cbm' }), /[{}]/);
    }
  }
  assert.deepEqual(pricingIssueParams('FX_RATE_MISSING'), ['currency']);
  assert.deepEqual(pricingIssueParams('SHIPPING_RATE_UNCONFIRMED'), ['profile']);
  assert.deepEqual(pricingIssueParams('INPUT_CONFLICT'), ['field']);
  assert.deepEqual(pricingIssueParams('WEIGHT_MISSING'), []);
});

test('filled labels read naturally in each language', () => {
  assert.deepEqual(pricingIssueLabels('FX_RATE_MISSING', { currency: 'EUR' }), {
    ar: 'سعر صرف EUR غير مضبوط',
    en: 'The EUR exchange rate is not set',
    ckb: 'نرخی ئاڵوگۆڕی EUR دانەنراوە',
  });
  assert.deepEqual(pricingIssueLabels('SHIPPING_RATE_MISSING', { profile: 'CHINA_SEA' }), {
    ar: 'سعر الشحن البحري من الصين غير مضبوط',
    en: 'The China sea shipping rate is not set',
    ckb: 'نرخی ناردنی دەریایی لە چینەوە دانەنراوە',
  });
  assert.deepEqual(pricingIssueLabels('SHIPPING_RATE_MISSING'), {
    ar: 'سعر الشحن غير مضبوط',
    en: 'The shipping rate is not set',
    ckb: 'نرخی ناردن دانەنراوە',
  });
  assert.equal(pricingIssueLabel('INPUT_CONFLICT', 'en', { field: 'shipping_weight_g' }), 'Two options of this SKU give different values for Shipping weight (g)');
  assert.equal(pricingIssueLabel('INPUT_CONFLICT', 'ckb', { field: 'shipping_weight_g' }), 'دوو هەڵبژاردەی ئەم SKU-یە دوو بەهای جیاواز بۆ کێشی ناردن (گرام) دەدەن');
  assert.equal(pricingIssueLabel('INPUT_CONFLICT', 'ar'), 'خياران لهذه التركيبة يعطيان قيمتين مختلفتين في هذا الحقل');
});

test('missing_json entries [C1-G23]: code, scope, scope_id and the label in three languages, named', () => {
  const combo = { ar: 'كومبو', en: 'Combo', ckb: 'کۆمبۆ' };
  assert.deepEqual(pricingMissingEntry({ code: 'WEIGHT_MISSING', scope: 'option', scope_id: 'ov_combo', name: combo }), {
    code: 'WEIGHT_MISSING',
    scope: 'option',
    scope_id: 'ov_combo',
    label_ar: 'كومبو — وزن الشحن غير موجود',
    label_en: 'Combo — Shipping weight is missing',
    label_ckb: 'کۆمبۆ — کێشی ناردن دانەنراوە',
  });
  const product = pricingMissingEntry({ code: 'FX_RATE_MISSING', scope: 'product', scope_id: 'ignored', params: { currency: 'CNY' } });
  assert.equal(product.scope_id, '', 'the product itself has no scope id');
  assert.equal(product.label_en, 'The CNY exchange rate is not set');
  for (const entry of [product]) for (const v of Object.values(entry)) assert.notEqual(typeof v, 'number', 'codes and names only — never a number');
});

test('the label tables cover the engine vocabulary exactly', () => {
  assert.deepEqual(Object.keys(PRICING_PROFILE_LABELS).sort(), [...SHIPPING_PROFILES].sort());
  assert.deepEqual(Object.keys(PRICING_CHANNEL_LABELS).sort(), [...SKU_CHANNELS].sort());
  for (const scope of [...RULE_SCOPE_ORDER, 'base']) assert.ok(scope in PRICING_SCOPE_LABELS, scope);
  // Every input column of pricing_inputs, every value column of pricing_sku_costs and the
  // engine's breakdown names (FINANCIAL_FIELDS: calculated_cbm) have a label.
  const columns = [
    'supplier_amount', 'calculated_cbm',
    'supplier_cost', 'supplier_cost_delta', 'supplier_currency', 'shipping_profile', 'pricing_weight_g', 'shipping_weight_g',
    'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'manual_cbm', 'additional_cost_iqd',
    'fx_rate', 'supplier_cost_iqd', 'shipping_rate', 'effective_weight_g', 'shipping_cbm', 'effective_cbm', 'shipping_cost_iqd',
    'replacement_exact', 'replacement_cost_iqd', 'target_profit_iqd', 'direct_sale_extra_iqd', 'rounding_step_iqd', 'preorder_base_iqd',
    'computed_price_iqd', 'supplier_cost_exact', 'shipping_cost_exact', 'rounding_added_iqd',
  ];
  for (const c of columns) assert.ok(isPricingFieldName(c), c);
  for (const f of UNRESOLVABLE_FIELDS) assert.ok(isPricingFieldName(f), f);
  assert.equal(isPricingFieldName('hasOwnProperty'), false);
});

test('pricingMissingEntriesOf: one engine issue → its missing_json entries (base → product, one per scope id, the SKU itself otherwise)', () => {
  const names: Record<string, { ar: string; en: string; ckb: string }> = {
    'option:ov_a': { ar: 'كومبو', en: 'Combo', ckb: 'کۆمبۆ' },
    'option:ov_b': { ar: 'برو', en: 'Pro', ckb: 'پرۆ' },
    'sku:o:ov_a|c:red': { ar: 'كومبو / أحمر', en: 'Combo / Red', ckb: 'کۆمبۆ / سوور' },
  };
  const ctx = { combo_key: 'o:ov_a|c:red', nameOf: (scope: string, id: string) => names[`${scope}:${id}`] ?? null };
  const conflict = pricingMissingEntriesOf({ code: 'INPUT_CONFLICT', level: 'option', scope_ids: ['ov_a', 'ov_b', 'ov_a'], field: 'shipping_weight_g' }, ctx);
  assert.deepEqual(conflict.map((e) => [e.scope, e.scope_id]), [['option', 'ov_a'], ['option', 'ov_b']], 'fanned out, repeated ids once');
  assert.equal(conflict[0].label_en, 'Combo — Two options of this SKU give different values for Shipping weight (g)');
  assert.equal(conflict[1].label_ckb, 'پرۆ — دوو هەڵبژاردەی ئەم SKU-یە دوو بەهای جیاواز بۆ کێشی ناردن (گرام) دەدەن');
  const baseLevel = pricingMissingEntriesOf({ code: 'WEIGHT_MISSING', level: 'base', scope_ids: [''] }, ctx);
  assert.deepEqual(baseLevel.map((e) => [e.scope, e.scope_id, e.label_en]), [['product', '', 'Shipping weight is missing']]);
  const rateIssue = pricingMissingEntriesOf({ code: 'FX_RATE_MISSING', currency: 'EUR' }, ctx);
  assert.deepEqual(rateIssue.map((e) => [e.scope, e.scope_id, e.label_en]), [['sku', 'o:ov_a|c:red', 'Combo / Red — The EUR exchange rate is not set']]);
  const productItself = pricingMissingEntriesOf({ code: 'SHIPPING_RATE_MISSING', profile: 'CHINA_SEA' }, { combo_key: '' });
  assert.deepEqual(productItself.map((e) => [e.scope, e.scope_id, e.label_ar]), [['product', '', 'سعر الشحن البحري من الصين غير مضبوط']]);
  // Unknown params fall back to the neutral word; nothing numeric is ever carried.
  const odd = pricingMissingEntriesOf({ code: 'SHIPPING_RATE_MISSING', profile: 'toString', field: 'hasOwnProperty' }, { combo_key: '' });
  assert.equal(odd[0].label_en, 'The shipping rate is not set');
  for (const e of [...conflict, ...baseLevel, ...rateIssue, ...productItself]) for (const v of Object.values(e)) assert.equal(typeof v, 'string');
});

test('codes are plain SCREAMING_SNAKE identifiers a client can switch on', () => {
  for (const code of PRICING_ISSUE_CODES as readonly PricingIssueCode[]) assert.match(code, /^[A-Z][A-Z0-9_]+$/);
});
