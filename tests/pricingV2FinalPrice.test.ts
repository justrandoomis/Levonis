/**
 * PRICING V2 — «السعر النهائي ($)», THE OWNER'S TWO-WAY EDITOR OF THE MINIMUM PROFIT (the owner's request,
 * 2026-10-18; docs/PRICING-V2.md §1.2).
 *
 *   - T stays the one stored figure: a typed final price X stores T = X − base, the reference SKU's dollars
 *     without profit read from the CURRENT preview (down to the cent, so the customer's price — rounded up to
 *     the cent, row 248 — is X);
 *   - a typed T moves the shown final price on the next preview (never the stale one);
 *   - at or below cost it is refused (ar/en/ckb), T untouched;
 *   - a price editor never sees it; a model in «تكلفة مختلفة» has its own beside its minimum-profit exception.
 *
 * Run: node --import tsx --test tests/pricingV2FinalPrice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import {
  draftOf,
  draftWire,
  finalUsdOf,
  FOLLOW_MODEL,
  modelFinalLine,
  productFinalLine,
  profitForFinal,
  skuLines,
  usdCentsUp,
  wireIsEmpty,
  withoutMinimumProfit,
  type PriceDraft,
  type V2Answer,
  type V2LiveIds,
  type V2OwnerExtras,
  type V2TableRow,
} from '../src/components/adminProducts/form/v2/v2Model';
import { V2_STRINGS } from '../src/components/adminProducts/form/v2/v2Strings';
import { V2PricingProvider, type V2PricingState } from '../src/components/adminProducts/form/v2/useV2Pricing';
import PricesSectionV2 from '../src/components/adminProducts/form/v2/PricesSectionV2';
import ModelPriceSelector from '../src/components/adminProducts/form/v2/ModelPriceSelector';

const S = V2_STRINGS.ar;
const readSrc = (name: string) => readFileSync(join(import.meta.dirname, '..', `src/components/adminProducts/form/v2/${name}.tsx`), 'utf8');
const names = (n: string) => ({ ar: n, en: n, ckb: n });
const extras = (usd_ceil6: string, profit: string | null): V2OwnerExtras => ({
  v2_exact_iqd: '0',
  v2_usd_ceil6: usd_ceil6,
  v2_delta_usd: '0',
  v2_discount_usd: null,
  v2_discount_scope: null,
  v2_floor: 'none',
  v2_replacement_iqd: 150_000,
  v2_profit_usd: profit,
  v2_below_cost: false,
});
const row = (model: string, ceil6: string, profit: string | null, price: number): V2TableRow => ({
  combo_key: `o:${model}`,
  option_value_ids: [model],
  color_id: null,
  names: names(model),
  channel: 'direct_sale',
  price_iqd: price,
  old_iqd: null,
  source: 'product',
  owner: extras(ceil6, profit),
});
// U = 1,500: m1 costs 150,000 د.ع ($100) + T $25 → $125; m2 «تكلفة مختلفة» costs $200 + its own T $30 → $230.
const TABLE = (m1 = row('m1', '125', '25', 187_500)): V2TableRow[] => [m1, row('m2', '230', '30', 345_000)];
const answer = (table: V2TableRow[], over: Partial<V2Answer> = {}): V2Answer => ({
  product_id: 'p1',
  v2: true,
  needs_pricing: false,
  method: 'cost',
  seq: { inputs_seq: 1, write_seq: 1 },
  status: { kind: 'current' },
  can_edit: { money: true, cost: true, method: true, structure: true },
  table,
  missing: [],
  publishable: true,
  review_hash: 'a'.repeat(64),
  v2_cost_inputs: { inputs: [], minimum_profit: [{ scope: 'product', scope_id: null, state: 'active', amount_usd: '25' }], inherited_minimum_profit: null },
  ...over,
});
const M2_OWN: PriceDraft['models'][string] = { ...FOLLOW_MODEL, price: 'own_cost', supplier_amount: '200', supplier_currency: 'USD', profit: 'exception', profit_usd: '30' };
const draftWith = (a: V2Answer, over: Partial<PriceDraft> = {}): PriceDraft => {
  const d = draftOf(a);
  return { ...d, models: { ...d.models, m2: M2_OWN }, ...over };
};
// The answer prices the draft when the draft is its own; `priced` says otherwise (an edit waiting for its preview).
function stateOf(a: V2Answer, draft: PriceDraft = draftWith(a), over: Partial<V2PricingState> = {}): V2PricingState {
  const owner = a.can_edit.cost;
  return {
    mode: 'stored',
    owner,
    money: a.can_edit.money,
    needsMethod: false,
    hidden: false,
    answer: a,
    stored: a,
    loading: false,
    previewing: false,
    error: '',
    draft,
    setDraft: () => undefined,
    wire: {},
    touched: false,
    measurePending: new Set(),
    storedDraft: draftWith(a),
    drafting: false,
    priced: { draft: JSON.stringify(draft) === JSON.stringify(draftWith(a)), cost: true },
    discard: () => undefined,
    reload: () => undefined,
    saveBlock: () => null,
    afterSave: () => undefined,
    review: null,
    openReview: () => undefined,
    reviewError: () => undefined,
    closeReview: () => undefined,
    selectedColours: new Set(),
    toggleColour: () => undefined,
    clearColours: () => undefined,
    ...over,
  };
}
const inLang = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const section3 = (st: V2PricingState) =>
  inLang(createElement(V2PricingProvider, { value: st }, createElement(PricesSectionV2, { modelNames: (id: string) => names(id), firstModelId: 'm1', packageDims: null, onJump: () => undefined })));
const modelCard = (st: V2PricingState, id: string) =>
  inLang(
    createElement(
      V2PricingProvider,
      { value: st },
      createElement(ModelPriceSelector, { id, isModel: true, line: skuLines(st.answer!.table).find((l) => l.model_id === id) ?? null, measure: { dims: null, onDims: () => undefined, heading: 'h' } })
    )
  );
const inputOf = (html: string, field: string): string | null => new RegExp(`<input[^>]*data-v2-field="${field}"[^>]*>`).exec(html)?.[0] ?? null;
const valueOf = (html: string, field: string): string | null => {
  const tag = inputOf(html, field);
  return tag === null ? null : (/\svalue="([^"]*)"/.exec(tag)?.[1] ?? '');
};
const LIVE: V2LiveIds = { options: new Set(['m1', 'm2']), models: new Set(['m1', 'm2']), colours: new Set(), skus: new Set(['o:m1', 'o:m2']) };
const OPTS = { needsMethod: false, cost: true, money: true };

test('a typed final price $X stores T = X − base (the preview’s dollars without profit), on the wire, never a new column', () => {
  const a = answer(TABLE());
  const ref = finalUsdOf(skuLines(a.table)[0]);
  assert.deepEqual(ref && { final: ref.final, cost: ref.cost, profit: ref.profit }, { final: '125.00', cost: '100.00', profit: '25' });
  const r = profitForFinal('140', ref!.base);
  assert.deepEqual(r, { ok: true, usd: '40' }, '140 − 100 = 40');
  const base = draftWith(a);
  const wire = draftWire(base, { ...base, min_profit_usd: r!.ok ? r.usd : '' }, { points: [], discounts: [] }, LIVE, OPTS);
  assert.equal(wire.cost?.minimum_profit, '40', 'the product’s minimum profit is what travels');
  assert.equal(JSON.stringify(wire).includes('final'), false, 'no final-price key reaches the server');
  // Arabic-Indic digits and the Arabic decimal mark are digits.
  assert.deepEqual(profitForFinal('١٤٠٫٥', ref!.base), { ok: true, usd: '40.5' });
  // A sub-cent base: T is taken down to the cent, so the customer's price (rounded up to the cent) is X.
  const odd = finalUsdOf(skuLines([row('m1', '114.503817', '25', 171_756)])[0])!;
  assert.equal(odd.final, '114.51');
  const t = profitForFinal('120', odd.base);
  assert.deepEqual(t, { ok: true, usd: '30.49' });
  assert.equal(odd.base, '89503817', 'micro-dollars: $89.503817');
  assert.equal(usdCentsUp('119.993817'), '120.00', '$89.503817 + $30.49, rounded up to the cent');
  // Nothing typed: nothing changes.
  assert.equal(profitForFinal('', ref!.base), null);
  assert.equal(profitForFinal('.', ref!.base), null);
});

test('a final price at or below cost is refused — T is never 0 or less — with a clear message in ar, en and ckb', () => {
  const ref = finalUsdOf(skuLines(TABLE())[0])!;
  assert.deepEqual(profitForFinal('99.99', ref.base), { ok: false, reason: 'below_cost' });
  assert.deepEqual(profitForFinal('100', ref.base), { ok: false, reason: 'below_cost' }, 'T = 0 would read as «inherit»');
  assert.deepEqual(profitForFinal('0', ref.base), { ok: false, reason: 'below_cost' });
  assert.deepEqual(profitForFinal('100.01', ref.base), { ok: true, usd: '0.01' });
  assert.deepEqual(profitForFinal('200000', ref.base), { ok: false, reason: 'too_large' });
  for (const key of ['finalPrice', 'finalPriceHint', 'finalPriceWaiting', 'finalTooLarge'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(V2_STRINGS[lang][key].length > 0, `${lang}.${key}`);
    assert.notEqual(V2_STRINGS.ckb[key], V2_STRINGS.ar[key], `${key}: Sorani is not a copy of the Arabic`);
  }
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(V2_STRINGS[lang].finalBelowCost('$100.00').includes('$100.00'));
  assert.notEqual(V2_STRINGS.ckb.finalBelowCost('x'), V2_STRINGS.ar.finalBelowCost('x'));
  // The component says it at the field, and leaves T as it was.
  const field = readSrc('FinalPriceField');
  assert.match(field, /if \(r\?\.ok\) onProfit\(r\.usd\);/);
  assert.match(field, /s\.finalBelowCost\(usdText\(ref!\.cost\)\)/);
  assert.match(field, /role="alert"/);
});

test('editing T moves the shown final price — from the next preview, never the stale one', () => {
  const before = answer(TABLE());
  const html = section3(stateOf(before));
  assert.equal(valueOf(html, 'final-usd'), '125.00', 'the preview’s final price, as the customer reads it');
  assert.ok(html.includes(S.finalPrice) && html.includes(S.finalPriceHint), 'labelled, and the rounding rule is said');
  assert.ok(inputOf(html, 'min-profit'), 'beside the minimum profit');
  // The owner types T = 40: until the next preview, the field does not show the old price.
  const typed = section3(stateOf(before, draftWith(before, { min_profit_usd: '40' })));
  assert.equal(valueOf(typed, 'final-usd'), '');
  // The next preview: $100 + $40.
  const after = answer(TABLE(row('m1', '140', '40', 210_000)));
  assert.equal(valueOf(section3(stateOf(after, draftWith(after, { min_profit_usd: '40' }))), 'final-usd'), '140.00');
  // The result bar reads the same cents (rounded up, row 248).
  const odd = section3(stateOf(answer(TABLE(row('m1', '114.503817', '25', 171_756)))));
  assert.equal(valueOf(odd, 'final-usd'), '114.51');
  assert.ok(odd.includes('$114.51') && !odd.includes('$114.50'));
  // No preview figure: the field waits, and says why.
  const none = section3(stateOf(answer(TABLE(row('m1', '125', null, 187_500)).slice(0, 1))));
  assert.match(inputOf(none, 'final-usd') ?? '', /disabled/);
  assert.ok(none.includes(S.finalPriceWaiting));
});

test('a price editor never sees the final-price editor', () => {
  const editor = answer(
    TABLE().map((r) => ({ ...r, owner: null })),
    { can_edit: { money: true, cost: false, method: false, structure: true }, v2_cost_inputs: undefined }
  );
  const html = section3(stateOf(editor));
  assert.equal(inputOf(html, 'final-usd'), null);
  assert.ok(!html.includes(S.finalPrice));
  const noMoney = section3(stateOf(answer(TABLE(), { can_edit: { money: false, cost: false, method: false, structure: true } })));
  assert.equal(inputOf(noMoney, 'final-usd'), null);
  // The model's, too.
  assert.equal(inputOf(modelCard(stateOf(editor), 'm2'), 'model-final-usd:m2'), null);
});

test('a model in «تكلفة مختلفة» has its own final price beside its minimum-profit exception; the product’s skips it', () => {
  const a = answer(TABLE());
  const card = modelCard(stateOf(a), 'm2');
  assert.equal(valueOf(card, 'model-final-usd:m2'), '230.00');
  assert.ok(inputOf(card, 'model-profit-usd:m2'));
  // $250 on the model: its own T = 250 − 200 = 50, as its own rule row.
  const ref = finalUsdOf(skuLines(a.table).find((l) => l.model_id === 'm2'))!;
  const r = profitForFinal('250', ref.base);
  assert.deepEqual(r, { ok: true, usd: '50' });
  const base = draftWith(a);
  const wire = draftWire(base, { ...base, models: { ...base.models, m2: { ...M2_OWN, profit_usd: r!.ok ? r.usd : '' } } }, { points: [], discounts: [] }, LIVE, OPTS);
  assert.deepEqual(wire.cost?.minimum_profit, [{ kind: 'target_profit', scope: 'option', scope_id: 'm2', amount_usd: '50' }]);
  // Below the model's own cost: refused.
  assert.deepEqual(profitForFinal('200', ref.base), { ok: false, reason: 'below_cost' });
  // Following the product, the model has no field of its own.
  const follows = modelCard(stateOf(a, draftWith(a, { models: { m2: { ...M2_OWN, profit: 'follow', profit_usd: '' } } })), 'm2');
  assert.equal(inputOf(follows, 'model-final-usd:m2'), null);
  // The product's reference SKU is never one with its own minimum profit.
  const lines = skuLines(a.table);
  const m2 = lines.find((l) => l.model_id === 'm2')!;
  assert.equal(productFinalLine(a.table, m2, base)?.model_id, 'm1');
  assert.equal(productFinalLine(a.table, m2, { models: {}, skus: {} })?.model_id, 'm2', 'a model that follows the product is its reference');
});

test('a SKU on a special price is never the final price’s reference — T does not move it one for one (C-9)', () => {
  // m1 «سعر خاص» $150 at cost $100 and T $10: the server prices max($150, $110) = $150, so «150 − 10» is no cost.
  const a = answer([row('m1', '150', '10', 225_000), row('m3', '110', '10', 165_000)]);
  const m1 = skuLines(a.table)[0];
  const special = (usd: string): PriceDraft['models'] => ({ m1: { ...FOLLOW_MODEL, price: 'fixed', usd } });
  assert.equal(productFinalLine(a.table, m1, draftWith(a, { models: special('150') }))?.model_id, 'm3', 'the first SKU priced from cost alone');
  assert.equal(productFinalLine(a.table, m1, draftWith(a, { skus: { 'o:m1': { fixed_usd: '150', discount_usd: '' } } }))?.model_id, 'm3', 'a SKU’s own special price, too');
  assert.equal(productFinalLine(a.table, m1, draftWith(a, { models: special('') }))?.model_id, 'm1', 'an empty special price sends no point: priced from cost');
  // Nothing priced from cost alone: the field is closed, and says why.
  const only = answer([row('m1', '150', '10', 225_000)]);
  const html = section3(stateOf(only, draftWith(only, { models: special('150') }), { priced: { draft: true, cost: true } }));
  assert.match(inputOf(html, 'final-usd') ?? '', /disabled/);
  assert.ok(html.includes(S.finalPriceWaiting));
  // A model's own final price skips its SKU on a special price.
  const t = answer(TABLE());
  const m2 = skuLines(t.table).find((l) => l.model_id === 'm2')!;
  assert.equal(modelFinalLine(t.table, m2, 'm2', draftWith(t))?.combo_key, 'o:m2');
  const fixedSku = draftWith(t, { skus: { 'o:m2': { fixed_usd: '300', discount_usd: '' } } });
  assert.equal(modelFinalLine(t.table, m2, 'm2', fixedSku), null);
  assert.match(inputOf(modelCard(stateOf(t, fixedSku, { priced: { draft: true, cost: true } }), 'm2'), 'model-final-usd:m2') ?? '', /disabled/);
});

test('any other edit (the cost, the shipping, a difference…) closes the final price until its preview answers — never an old cost', () => {
  const a = answer(TABLE());
  const base = draftWith(a);
  const moved = { ...base, cost: { ...base.cost, supplier_amount: '120', supplier_currency: 'USD' as const } };
  const waiting = { priced: { draft: false, cost: false } };
  for (const previewing of [false, true]) {
    const html = section3(stateOf(a, moved, { ...waiting, previewing }));
    const tag = inputOf(html, 'final-usd') ?? '';
    assert.match(tag, /disabled/, 'the 400 ms wait and the request alike');
    assert.equal(valueOf(html, 'final-usd'), '', 'never the old $125.00');
    assert.match(tag, /placeholder="…"/);
    assert.ok(html.includes(S.computing));
  }
  // A failed preview: still closed, and it says it waits for a priced preview.
  const failed = section3(stateOf(a, moved, { ...waiting, error: 'x' }));
  assert.match(inputOf(failed, 'final-usd') ?? '', /disabled/);
  assert.ok(failed.includes(S.finalPriceWaiting));
  // The model's own final price waits too.
  assert.match(inputOf(modelCard(stateOf(a, moved, waiting), 'm2'), 'model-final-usd:m2') ?? '', /disabled/);
  // What «cost» compares: the wire but the minimum profit — a T typed (the product's or a model's) leaves it, so
  // the final price stays open while it is typed; any other input moves it.
  const costOf = (d: PriceDraft) => withoutMinimumProfit(draftWire(base, d, { points: [], discounts: [] }, LIVE, OPTS));
  assert.ok(wireIsEmpty(costOf({ ...base, min_profit_usd: '40' })));
  assert.ok(wireIsEmpty(costOf({ ...base, min_profit_usd: '' })));
  assert.ok(wireIsEmpty(costOf({ ...base, models: { ...base.models, m2: { ...M2_OWN, profit_usd: '50' } } })));
  assert.ok(!wireIsEmpty(costOf(moved)));
});

test('an emptied (inherited) or unreadable minimum profit never shows the old T’s final price', () => {
  const inherited = { amount_usd: '10', amount_iqd: null };
  const a = answer(TABLE(), { v2_cost_inputs: { inputs: [], minimum_profit: [{ scope: 'product', scope_id: null, state: 'active', amount_usd: '25' }], inherited_minimum_profit: inherited } });
  for (const min_profit_usd of ['', 'abc']) {
    const html = section3(stateOf(a, draftWith(a, { min_profit_usd })));
    assert.equal(valueOf(html, 'final-usd'), '', `«${min_profit_usd}»: not the $125.00 of T $25`);
    assert.match(inputOf(html, 'final-usd') ?? '', /placeholder="…"/);
  }
  // Its preview answers with the inherited T ($100 + $10): the draft's own figure, shown.
  const after = answer(TABLE(row('m1', '110', '10', 165_000)), { v2_cost_inputs: { inputs: [], minimum_profit: [], inherited_minimum_profit: inherited } });
  assert.equal(valueOf(section3(stateOf(after, draftWith(after, { min_profit_usd: '' }))), 'final-usd'), '110.00');
});
