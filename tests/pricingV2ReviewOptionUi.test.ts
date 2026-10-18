/**
 * PRICING V2 — THE MODEL AND COLOUR CARDS OF SECTION ٥ (the owner's report of
 * 2026-10-17, DECISIONS row 247; docs/PRICING-V2.md §2.5).
 *
 *   - «تكلفة مختلفة» carries a minimum profit «يتبع المنتج: $X | استثناء»,
 *     inside the own-cost panel only, cleared by «التكلفة: رجوع للموروث»;
 *   - the cost is a choice of its own beside the price, the owner's on every
 *     model and colour card in both methods, its currency IQD too (row 254);
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
import { followCost, followPrice } from '../src/components/adminProducts/form/v2/ModelPriceSelector';
import { V2_STRINGS, type V2Strings } from '../src/components/adminProducts/form/v2/v2Strings';

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');
const v2 = (f: string) => src(`src/components/adminProducts/form/v2/${f}.tsx`);

test('«تكلفة مختلفة» has its own minimum profit — in the own-cost panel only — and «التكلفة: رجوع للموروث» clears it', () => {
  const m = v2('ModelPriceSelector');
  const panel = m.slice(m.indexOf('{ownCost ? ('), m.indexOf('{isModel ? (', m.indexOf('{ownCost ? (')));
  assert.ok(panel.length > 0);
  for (const field of ['`model-profit:${id}`', '`model-profit-usd:${id}`']) {
    assert.ok(panel.includes(field), `${field} in the own-cost panel`);
    assert.equal(m.split(field).length, 2, `${field} only there`);
  }
  // The inherited product value is visible beside the exception (§2.1 rule 2).
  assert.match(panel, /\$\{s\.followsProduct\}: \$\{productT\}/);
  assert.match(panel, /s\.inheritedProduct\(productT\)/);
  const reset = followCost();
  assert.equal(reset.cost, 'follow');
  assert.equal(reset.profit, 'follow');
  assert.equal(reset.profit_usd, '');
  assert.equal(reset.supplier_amount, '');
  // The price and the cost are two decisions (row 254): the price's reset leaves the cost as it is.
  assert.deepEqual(followPrice(), { price: 'follow', usd: '' });
});

test('row 254: the cost is its own choice — the owner’s, on every model and colour card, in both methods, IQD offered', () => {
  const m = v2('ModelPriceSelector');
  // No «تكلفة مختلفة» among the price modes any more, and no cost-first-only gate.
  assert.doesNotMatch(m, /own_cost/);
  assert.match(m, /const costChoice = owner && isModel;/);
  assert.match(m, /data-v2-field=\{`model-cost:\$\{id\}`\}/);
  assert.match(m, /<option value="follow">\{s\.costFollowsProduct\}<\/option>/);
  assert.match(m, /COST_CURRENCIES\.map/);
  // The hint states what the engine does with the cost in each method and price mode.
  assert.match(m, /!costFirst \? s\.ownCostPriceFirstHint : price === 'delta' \? s\.ownCostDeltaHint : price === 'fixed' \? s\.ownCostFixedHint : s\.ownCostFollowHint/);
  // The model's final price edits its minimum profit only where the price follows that cost.
  assert.match(m, /costFirst && price === 'follow' && m\.profit === 'exception' \? <FinalPriceField/);
  const c = v2('ColourPriceSelector');
  // The colour's cost: the owner's alone (never shown to a price editor), amount and currency only.
  assert.match(c, /const ownCost = owner && c\.cost === 'own';/);
  assert.match(c, /\{owner \? \(\n\s+<V2Field label=\{s\.costLabel\}/);
  assert.match(c, /<option value="follow">\{s\.costFollowsModel\}<\/option>/);
  assert.match(c, /data-v2-field=\{`colour-supplier:\$\{id\}`\}/);
  assert.match(c, /data-v2-field=\{`colour-currency:\$\{id\}`\}/);
  assert.doesNotMatch(c, /colour-weight|colour-box/);
  // A price change (one colour, the ticked ones, or all back) keeps each colour's own cost.
  assert.doesNotMatch(c, /\{ \.\.\.FOLLOW_COLOUR \}/);
  assert.match(c, /\.\.\.\(x\.colours\[id\] \?\? FOLLOW_COLOUR\), price: 'delta' as const, usd/);
  // The base cost card offers dinars too.
  const card = v2('CostCard');
  assert.match(card, /COST_CURRENCIES\.map/);
  assert.match(card, /currencyLabel\(c, s\.iqdName\)/);
});

test('the own-cost weight and box ARE the option dimensions: written through measure.onDims, never a copy in the draft', () => {
  const m = v2('ModelPriceSelector');
  assert.match(m, /measure\.onDims\(\{ \.\.\.dims, package_weight_g \}\)/);
  assert.match(m, /package_depth_mm: box\?\.\[0\] \?\? null, package_width_mm: box\?\.\[1\] \?\? null, package_height_mm: box\?\.\[2\] \?\? null/);
  assert.doesNotMatch(m, /set\(\{ weight_g \}\)/);
  assert.doesNotMatch(m, /set\(\{ box \}\)/);
  // The hints quote the dimensions heading as the form shows it (a Sorani reader finds the block).
  for (const hint of ['s.optionMeasureFrom(measure.heading)', 's.savedPricingOnly(measure.heading)', 's.inheritsProductMeasure(']) assert.ok(m.includes(hint), hint);
  // The currency «يتبع المنتج: EUR» — or «اختر العملة» when the product has none (never «يتبع المنتج: —»), said at the field.
  assert.match(m, /<option value="">\{d\.cost\.supplier_currency \? `\$\{s\.followsProduct\}: \$\{d\.cost\.supplier_currency\}` : s\.currencyChoose\}<\/option>/);
  assert.match(m, /hint=\{currencyMissing \? s\.currencyRequired : undefined\}/);
  // The currency has room: no fixed 6rem column.
  assert.ok(!m.includes('_6rem_'));
  // An emptied box empties the three axes (no stale axis written back).
  assert.match(m, /setAxes\(stored \? \[\.\.\.stored\] : \[null, null, null\]\)/);
  assert.match(m, /s\.inheritedProduct\(productCost\)/);
  // The option's «أبعاد الخيار» patcher reaches the card, and the form mirrors the dimensions into the pricing draft.
  assert.match(src('src/components/adminProducts/form/OptionsSection.tsx'), /pricingV2\?\.model\(v, groupIndex === 0, \(dimensions\) => patchValue\(g\.id, v\.id, \{ dimensions \}\)\)/);
  assert.match(src('src/components/adminProducts/ProductForm.tsx'), /measure=\{\{ dims: v\.dimensions \?\? null, onDims, heading: optionDimsHeading\(v\.name_en\) \}\}/);
  assert.match(src('src/components/adminProducts/ProductForm.tsx'), /optionPackages,\n\s+savedOptionPackages,/);
  assert.match(src('src/components/adminProducts/form/OptionsSection.tsx'), /label=\{optionDimsHeading\(v\.name_en\)\}/);
  // The saved dimensions tell the mirror from a pricing-only value; a mirror not yet saved counts as unsaved.
  const hook = src('src/components/adminProducts/form/v2/useV2Pricing.ts');
  assert.match(hook, /models: withOptionMeasure\(d\.models, optionPackages, savedOptionPackages\)/);
  assert.match(hook, /touched: typed \|\| measurePending\.size > 0/);
  assert.match(m, /v2\.measurePending\.has\(id\)/);
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
  assert.match(m, /shelf && m\.cost === 'own' \?/);
  assert.match(m, /s\.shelfOwnCostNote/);
  // One live region (section ٣'s), not one per model card.
  assert.doesNotMatch(m, /aria-live/);
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

test('the new words in ar, en and ckb — ckb never the Arabic, with a Sorani letter', () => {
  const sample = (v: V2Strings[keyof V2Strings]) => (typeof v === 'function' ? (v as (a: string) => string)('X') : v);
  for (const k of [
    'optionMeasureFrom',
    'inheritsProductMeasure',
    'savedPricingOnly',
    'preorderAfterOff',
    'shelfOwnCostNote',
    // Row 254.
    'costLabel',
    'costFollowsProduct',
    'costFollowsModel',
    'iqdName',
    'iqdHint',
    'amountUnreadable',
    'ownCostFollowHint',
    'ownCostDeltaHint',
    'ownCostFixedHint',
    'ownCostPriceFirstHint',
    'colourCostHint',
    'colourCostPriceFirstHint',
    'resetCost',
  ] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(sample(V2_STRINGS[lang][k]).trim().length > 0, `${lang}.${k}`);
    assert.notEqual(sample(V2_STRINGS.ckb[k]), sample(V2_STRINGS.ar[k]), k);
    assert.match(sample(V2_STRINGS.ckb[k]), /[ڕڵێۆە]/, k);
  }
});
