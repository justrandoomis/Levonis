/**
 * PRICING V2 — THE MODEL AND COLOUR CARDS OF SECTION ٥ (the owner's report of
 * 2026-10-17, DECISIONS row 247; docs/PRICING-V2.md §2.5).
 *
 *   - «تكلفة مختلفة» carries a minimum profit «يتبع المنتج: $X | استثناء»,
 *     inside the own-cost panel only, cleared by «رجوع للموروث»;
 *   - its weight and box are the option's «أبعاد الخيار» — the inputs write
 *     through the option's dimensions patcher, never a second copy;
 *   - the result lines show the discount taken and the owner's reasons
 *     (`lineNotes`, shared with the result bar), the card's own preview state,
 *     and a colour's figures each labelled by channel;
 *   - the new words exist in Arabic, English and real Sorani.
 * Source-level checks in the style of pricingV2ReviewUi.test.ts; the
 * behaviour behind them is tests/pricingV2OptionPricing.test.ts.
 *
 * Run: node --import tsx --test tests/pricingV2ReviewOptionUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { followPrice } from '../src/components/adminProducts/form/v2/ModelPriceSelector';
import { V2_STRINGS, type V2Strings } from '../src/components/adminProducts/form/v2/v2Strings';

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');
const v2 = (f: string) => src(`src/components/adminProducts/form/v2/${f}.tsx`);

test('«تكلفة مختلفة» has its own minimum profit — in the own-cost panel only — and «رجوع للموروث» clears it', () => {
  const m = v2('ModelPriceSelector');
  const panel = m.slice(m.indexOf("{price === 'own_cost' ? ("), m.indexOf('{isModel ? (', m.indexOf("{price === 'own_cost' ? (")));
  assert.ok(panel.length > 0);
  for (const field of ['`model-profit:${id}`', '`model-profit-usd:${id}`']) {
    assert.ok(panel.includes(field), `${field} in the own-cost panel`);
    assert.equal(m.split(field).length, 2, `${field} only there`);
  }
  // The inherited product value is visible beside the exception (§2.1 rule 2).
  assert.match(panel, /\$\{s\.followsProduct\}: \$\{productT\}/);
  assert.match(panel, /s\.inheritedProduct\(productT\)/);
  const reset = followPrice();
  assert.equal(reset.profit, 'follow');
  assert.equal(reset.profit_usd, '');
  assert.equal(reset.supplier_amount, '');
});

test('the own-cost weight and box ARE the option dimensions: written through measure.onDims, never a copy in the draft', () => {
  const m = v2('ModelPriceSelector');
  assert.match(m, /measure\.onDims\(\{ \.\.\.dims, package_weight_g \}\)/);
  assert.match(m, /package_depth_mm: box\?\.\[0\] \?\? null, package_width_mm: box\?\.\[1\] \?\? null, package_height_mm: box\?\.\[2\] \?\? null/);
  assert.doesNotMatch(m, /set\(\{ weight_g \}\)/);
  assert.doesNotMatch(m, /set\(\{ box \}\)/);
  for (const hint of ['s.optionMeasureFrom', 's.savedPricingOnly', 's.inheritsProductMeasure(']) assert.ok(m.includes(hint), hint);
  // The currency «يتبع المنتج: EUR», and the product's supplier price in grey.
  assert.match(m, /<option value="">\{`\$\{s\.followsProduct\}: \$\{d\.cost\.supplier_currency \|\| '—'\}`\}<\/option>/);
  assert.match(m, /s\.inheritedProduct\(productCost\)/);
  // The option's «أبعاد الخيار» patcher reaches the card, and the form mirrors the dimensions into the pricing draft.
  assert.match(src('src/components/adminProducts/form/OptionsSection.tsx'), /pricingV2\?\.model\(v, groupIndex === 0, \(dimensions\) => patchValue\(g\.id, v\.id, \{ dimensions \}\)\)/);
  assert.match(src('src/components/adminProducts/ProductForm.tsx'), /measure=\{\{ dims: v\.dimensions \?\? null, onDims \}\}/);
  assert.match(src('src/components/adminProducts/ProductForm.tsx'), /optionPackages,/);
  assert.match(src('src/components/adminProducts/form/v2/useV2Pricing.ts'), /models: withOptionMeasure\(d\.models, optionPackages\)/);
});

test('the model card shows the discount taken, the shelf, the owner’s reasons and its own preview state', () => {
  const m = v2('ModelPriceSelector');
  assert.match(m, /import \{ lineNotes \} from '\.\/ResultBar'/);
  assert.match(m, /s\.preorderAfterOff\(usdText\(off\)\)/);
  assert.match(m, /const off = owner \? preorderOffOf\(pre, direct\) : null/);
  assert.match(m, /const notes = owner \? lineNotes\(line, s\) : \[\]/);
  assert.match(m, /pre\.blocked \?/);
  assert.match(m, /s\.noPriceYet/);
  assert.match(m, /s\.sourceStock\(/);
  assert.match(m, /shelf && m\.price === 'own_cost' \?/);
  assert.match(m, /s\.shelfOwnCostNote/);
  assert.match(m, /aria-live="polite"/);
  assert.match(m, /v2\.previewing \? s\.computing : v2\.error \? s\.previewFailed\(v2\.error\) : ''/);
  // The result bar uses the one helper, unchanged in what it says.
  const bar = v2('ResultBar');
  assert.match(bar, /export function lineNotes\(/);
  assert.match(bar, /const warnings = owner \? lineNotes\(line, s\) : \[\]/);
});

test('the colour card labels every figure by its channel — never an unlabelled first channel — with the owner’s reasons', () => {
  const c = v2('ColourPriceSelector');
  assert.ok(!c.includes('Object.values(l.channels)[0]'));
  assert.match(c, /channelName\(pre\.channel, lang\)/);
  assert.match(c, /firstPreorder\(l\)/);
  assert.match(c, /preorderOffOf\(pre, direct\)/);
  assert.match(c, /lineNotes\(l, s\)/);
  assert.match(c, /s\.noPriceYet/);
});

test('the five new words in ar, en and ckb — ckb never the Arabic, with a Sorani letter', () => {
  const sample = (v: V2Strings[keyof V2Strings]) => (typeof v === 'function' ? (v as (a: string) => string)('X') : v);
  for (const k of ['optionMeasureFrom', 'inheritsProductMeasure', 'savedPricingOnly', 'preorderAfterOff', 'shelfOwnCostNote'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(sample(V2_STRINGS[lang][k]).trim().length > 0, `${lang}.${k}`);
    assert.notEqual(sample(V2_STRINGS.ckb[k]), sample(V2_STRINGS.ar[k]), k);
    assert.match(sample(V2_STRINGS.ckb[k]), /[ڕڵێۆە]/, k);
  }
});
