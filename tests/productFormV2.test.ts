/**
 * PRICING V2-4 — THE PRODUCT FORM (implementation spec §5 and its addendum of
 * 2026-10-14, A.6/A.7/A.13; docs/PRICING-V2.md §2; DECISIONS rows 221, 222).
 *
 * Proves, on the form's own modules:
 *   - every product mounts section ٣ «الأسعار» V2 and NONE of the old dinar
 *     fields (§2.8, A.6): no «السعر» input, no «سعر LEVO PRO», no «التكلفة
 *     القديمة», no compare-at line, no pinned-price notice, no option/colour
 *     price cells, no «زيادة البيع المباشر», no «زيادة هذا المسار», no V1 USD
 *     panels — and no «unmigrated» branch (no «لم يُنقل بعد», no «راجع وانقل»,
 *     no read-only legacy prices);
 *   - add-product types no dinar price, and its preview prices the draft
 *     under the id the save persists, before the first save;
 *   - the request: the owner sends dollars, the method and the cost; a price
 *     editor sends dollars only (Q2) — never a cost field — and nothing at all
 *     on a cost-first product; a product with no method states one;
 *   - the one review sheet lists only the changed rows, the 15% tick is asked
 *     when the server flags it, and cancel keeps every typed value;
 *   - section jumps: a refusal's or a missing line's section opens ٣ or ٥;
 *   - the editor projection shows no cost card and no cost figure; a
 *     cost-first product is the owner's;
 *   - one status chip, never contradictory, «ظاهر بلا سعر — يحتاج تسعيرًا» until published (row 240);
 *   - every v2Strings key in ar, en and ckb — ckb never the Arabic, with a
 *     Sorani-only letter (row 183).
 *
 * Run: node --import tsx --test tests/productFormV2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LanguageProvider } from '../src/LanguageContext';
import {
  comboKeyOf,
  draftOf,
  draftWire,
  lowestPrice,
  modelBlocks,
  previewOf,
  sectionOf,
  withoutLegacyMoney,
  type PriceDraft,
  type V2Answer,
  type V2LiveIds,
  type V2TableRow,
} from '../src/components/adminProducts/form/v2/v2Model';
import { V2_STRINGS, v2Strings, type V2Strings } from '../src/components/adminProducts/form/v2/v2Strings';
import { V2PricingProvider, draftStructure, saveHashOf, type V2PricingState } from '../src/components/adminProducts/form/v2/useV2Pricing';
import PricesSectionV2 from '../src/components/adminProducts/form/v2/PricesSectionV2';
import { chipOf } from '../src/components/adminProducts/form/v2/StatusChipV2';
import { sectionOfMissing } from '../src/components/adminProducts/form/v2/ReadinessV2';
import { needsTickOf, reviewRowsOf } from '../src/components/adminProducts/form/v2/ReviewSheetV2';

const ROOT = join(import.meta.dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const S = V2_STRINGS.ar;

const names = (n: string) => ({ ar: n, en: n, ckb: n });
const row = (combo: string, model: string | null, channel: V2TableRow['channel'], price: number, extra: Partial<V2TableRow> = {}): V2TableRow => ({
  combo_key: combo,
  option_value_ids: model ? [model] : [],
  color_id: null,
  names: names(model ?? 'Product'),
  channel,
  price_iqd: price,
  old_iqd: null,
  source: 'product',
  ...extra,
});
const TABLE: V2TableRow[] = [
  row('o:m1', 'm1', 'direct_sale', 1_500_000, { editor_usd_price: '1000' }),
  row('o:m1', 'm1', 'pre_order_land', 1_425_000, { editor_usd_price: '950' }),
  row('o:m2', 'm2', 'direct_sale', 1_815_000, { source: 'model_fixed', editor_usd_price: '1210' }),
];
const answer = (over: Partial<V2Answer> = {}): V2Answer => ({
  product_id: 'p1',
  v2: true,
  needs_pricing: false,
  method: 'usd',
  seq: { inputs_seq: 1, write_seq: 1 },
  status: { kind: 'current' },
  can_edit: { money: true, cost: false, method: false, structure: true },
  table: TABLE,
  missing: [],
  publishable: true,
  review_hash: 'a'.repeat(64),
  editor_usd: { points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1000' }], discounts: [{ scope: 'product', id: '', usd: '50' }] },
  ...over,
});
const LIVE: V2LiveIds = { options: new Set(['m1', 'm2']), models: new Set(['m1', 'm2']), colours: new Set(), skus: new Set(['o:m1', 'o:m2']) };

function stateOf(a: V2Answer | null, over: Partial<V2PricingState> = {}): V2PricingState {
  const owner = a?.can_edit.cost ?? false;
  return {
    mode: 'stored',
    owner,
    money: a?.can_edit.money ?? true,
    needsMethod: !!a && !a.v2,
    hidden: !!a?.needs_pricing,
    answer: a,
    stored: a,
    loading: false,
    previewing: false,
    error: '',
    draft: draftOf(a),
    setDraft: () => undefined,
    wire: {},
    touched: false,
    measurePending: new Set(),
    storedDraft: draftOf(a),
    drafting: false,
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
const section3 = (st: V2PricingState) =>
  render(createElement(V2PricingProvider, { value: st }, createElement(PricesSectionV2, { modelNames: (id: string) => names(id), firstModelId: 'm1', packageDims: null, onJump: () => undefined })));

test('§5.5 / A.6: the form carries no old dinar field anywhere — and no unmigrated branch', () => {
  const form = src('src/components/adminProducts/ProductForm.tsx');
  const options = src('src/components/adminProducts/form/OptionsSection.tsx');
  for (const [where, text] of [['ProductForm', form], ['OptionsSection', options]] as const) {
    for (const gone of [
      'سعر LEVO PRO',
      'التكلفة القديمة',
      'TierPriceDisclosure',
      'PinnedPriceNotice',
      'UsdPricing',
      'usdPricingStrings',
      'زيادة البيع المباشر',
      'زيادة هذا المسار',
      'PriceCells',
      'السعر قبل التخفيض',
      'store-price-engine',
      'pinnedRows',
      'saveAfterProduct',
      'data_only',
    ]) {
      assert.ok(!text.includes(gone), `${where} still carries «${gone}»`);
    }
  }
  // No dinar price input: the product's price is never a `Money` bound to price_iqd / pro_price_iqd / cost.
  assert.doesNotMatch(form, /price_iqd:\s*v\b|pro_price_iqd:\s*v\b|product_cost_iqd:\s*v\b/);
  assert.doesNotMatch(options, /surcharge_iqd\s*\}\)|regular_adjust_iqd\s*\}\)/, 'no fee is typed on a route or the direct cell');
  // Every product: section ٣ is V2, its chip in the header, the one sheet at the root, the selectors in ٥.
  for (const piece of ['<PricesSectionV2', 'chip={<StatusChipV2', '<ReviewSheetV2', '<ModelPriceSelector', '<ColourPriceSelector', '<ColourBulkBar']) {
    assert.ok(form.includes(piece), `ProductForm mounts ${piece}`);
  }
  // No unmigrated branch, anywhere in the form's V2 folder or the form itself.
  const v2Dir = join(ROOT, 'src/components/adminProducts/form/v2');
  const files = readdirSync(v2Dir).map((f) => src(`src/components/adminProducts/form/v2/${f}`)).concat(form);
  for (const text of files) {
    for (const gone of ['not_migrated', 'لم يُنقل بعد', 'راجع وانقل', 'LegacyPricesReadOnly', 'legacyLog', 'intents', 'lifted_to_cost', 'editorDraftOf']) {
      assert.ok(!text.includes(gone), `the V2 form still carries «${gone}»`);
    }
  }
  // The old V1 form is deleted, not hidden.
  for (const gone of ['src/components/adminProducts/form/UsdPricingSection.tsx', 'src/components/adminProducts/form/usdPricingStrings.ts', 'src/components/adminProducts/PinnedPriceNotice.tsx']) {
    assert.throws(() => src(gone), `${gone} is deleted`);
  }
});

test('add-product: no dinar price is typed; the preview prices the draft under the id the save persists', () => {
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /\.\.\.\(next\.id \? \{\} : \{ id: draftId \}\)/, 'the first save sends the id the preview priced');
  const hook = src('src/components/adminProducts/form/v2/useV2Pricing.ts');
  assert.match(hook, /product_id: mode === 'stored' \? productId : null/);
  assert.match(hook, /structure: draftStructure\(structureRef\.current\(\), mode === 'new' \? draftId : null\)/);
  const s = draftStructure({ doc: { name_en: '', price_iqd: undefined }, relations: { groups: [] } }, 'prd_new1');
  assert.equal(s.doc.id, 'prd_new1');
  assert.equal(s.doc.name_en, 'Draft', 'a product not yet named is priced under a placeholder, never refused');
  assert.equal(s.doc.price_iqd, 0, 'the document never offers a typed price');
  // A new product states its method: the owner's from cost, an editor's the dollar price (Q9).
  const owner = draftOf(null, 'cost');
  assert.equal(owner.method, 'cost');
  const wire = draftWire(owner, owner, { points: [], discounts: [] }, LIVE, { needsMethod: true, cost: true, money: true });
  assert.deepEqual(wire, { method: 'cost' });
  const editorWire = draftWire(owner, owner, { points: [], discounts: [] }, LIVE, { needsMethod: true, cost: false, money: true });
  assert.deepEqual(editorWire, { method: 'usd' }, 'an editor prices a never-priced product in dollars');
});

test('Q2: the owner sends dollars, method and cost; a price editor sends dollars only — never a cost field; nothing on a cost-first product', () => {
  const stored = answer({ can_edit: { money: true, cost: true, method: true, structure: true } });
  const base = draftOf(stored);
  assert.equal(base.product_usd, '1000');
  assert.equal(base.discount_usd, '50');
  const typed: PriceDraft = {
    ...base,
    product_usd: '1093.75',
    min_profit_usd: '120',
    cost: { ...base.cost, supplier_amount: '450', supplier_currency: 'EUR' },
    models: { m2: { price: 'delta', usd: '-43.21', discount: 'exception', discount_usd: '13.79', supplier_amount: '', supplier_currency: '', weight_g: null, box: null, profit: 'follow', profit_usd: '', profit_iqd: null } },
  };
  const dollars = { points: stored.editor_usd!.points, discounts: stored.editor_usd!.discounts };
  const ownerWire = draftWire(base, typed, dollars, LIVE, { needsMethod: false, cost: true, money: true });
  assert.deepEqual(ownerWire.points, [
    { scope: 'option', id: 'm2', kind: 'delta', usd: '-43.21' },
    { scope: 'product', id: '', kind: 'fixed', usd: '1093.75' },
  ]);
  assert.deepEqual(ownerWire.discounts, [
    { scope: 'option', id: 'm2', usd: '13.79' },
    { scope: 'product', id: '', usd: '50' },
  ]);
  assert.equal(ownerWire.cost?.minimum_profit, '120');
  assert.deepEqual(ownerWire.cost?.inputs?.[0], { scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR' });
  const editor = draftWire(base, typed, dollars, LIVE, { needsMethod: false, cost: false, money: true });
  assert.deepEqual(Object.keys(editor).sort(), ['discounts', 'points'], 'an editor sends the dollar set alone');
  assert.equal(editor.method, undefined);
  assert.equal(editor.cost, undefined);
  const costFirst = draftWire(base, { ...typed, method: 'cost' }, dollars, LIVE, { needsMethod: false, cost: false, money: false });
  assert.deepEqual(costFirst, {}, 'a cost-first product is the owner’s: an editor sends nothing');
  // A stored SKU row the form cannot draw is kept when another scope is edited (the full set is rebuilt, never dropped).
  const withSku = { points: [...dollars.points, { scope: 'sku' as const, id: 'o:m1', kind: 'fixed' as const, usd: '1234.56' }], discounts: dollars.discounts };
  const skuBase = draftOf(answer({ editor_usd: withSku }));
  const keep = draftWire(skuBase, { ...skuBase, product_usd: '1100' }, withSku, LIVE, { needsMethod: false, cost: false, money: true });
  assert.ok(keep.points?.some((p) => p.scope === 'sku' && p.usd === '1234.56'), 'the SKU’s own price survives an edit elsewhere');
});

test('the one review sheet: only the changed rows; the tick when the server flags 15% or a 30% drop; cancel keeps every typed value', () => {
  const preview = answer({
    changes: [
      { combo_key: 'o:m1', names: names('m1'), channel: 'direct_sale', old_iqd: 1_500_000, new_iqd: 1_750_000, change_percent: '16.67', large: true, drop_flag: false },
      { combo_key: 'o:m2', names: names('m2'), channel: 'direct_sale', old_iqd: 1_815_000, new_iqd: 1_815_000, change_percent: '0.00', large: false, drop_flag: false },
    ],
    large_change: true,
  });
  assert.deepEqual(reviewRowsOf(preview).map((c) => c.combo_key), ['o:m1'], 'an unchanged row is not listed');
  assert.equal(needsTickOf(preview), true);
  assert.equal(needsTickOf(answer({ changes: [], large_change: false, drop_flag: false })), false);
  assert.ok(previewOf({ preview, section: 3 }));
  assert.equal(previewOf({ preview: { nope: 1 } }), null);
  // Cancel is closeReview: it clears the sheet and nothing else.
  const hook = src('src/components/adminProducts/form/v2/useV2Pricing.ts');
  assert.match(hook, /const closeReview = useCallback\(\(\) => setReview\(null\), \[\]\);/);
  const sheet = src('src/components/adminProducts/form/v2/ReviewSheetV2.tsx');
  assert.ok(sheet.indexOf('</table>') < sheet.indexOf('data-v2-review-confirm') || sheet.includes('footer='), 'the confirm sits under the table');
  assert.doesNotMatch(sheet, /\bPRO\b/, 'no PRO lines (P6)');
  // The form opens the sheet on the three 409s and resends with the hash and the tick.
  const form = src('src/components/adminProducts/ProductForm.tsx');
  for (const code of ['PRICING_PREVIEW_REQUIRED', 'PRICING_PREVIEW_STALE', 'PRICING_LARGE_CHANGE_CONFIRM']) assert.ok(form.includes(`'${code}'`), code);
  assert.match(form, /save\(r\.status, \{ confirm: \{ hash: r\.preview\.review_hash, confirmLarge \} \}\)/);
});

test('«نشر» never publishes a price change without the review sheet (§2.6, A.8; review 2026-10-14)', () => {
  const moving = answer({
    review_hash: 'a'.repeat(64),
    changes: [{ combo_key: 'o:m1', names: names('m1'), channel: 'direct_sale', old_iqd: null, new_iqd: 1_750_000, change_percent: null, large: false, drop_flag: false }],
  });
  // A price moves (a first publish lists every row): no hash, so the server answers PRICING_PREVIEW_REQUIRED and the sheet opens.
  assert.equal(saveHashOf(moving), null);
  // The sheet's confirm carries its own hash.
  assert.equal(saveHashOf(moving, { hash: 'b'.repeat(64) }), 'b'.repeat(64));
  // Nothing moves (a structure or data edit): the preview's hash travels unasked.
  assert.equal(saveHashOf(answer({ review_hash: 'c'.repeat(64), changes: [] })), 'c'.repeat(64));
  assert.equal(saveHashOf(null), null);
  const hook = src('src/components/adminProducts/form/v2/useV2Pricing.ts');
  assert.match(hook, /const hash = saveHashOf\(shown, confirm\);/);
  assert.doesNotMatch(hook, /confirm\?\.hash \?\? shown\?\.review_hash/);
});

test('section jumps: a refusal’s section and a missing line’s level open ٣ or ٥', () => {
  assert.equal(sectionOf({ section: 5 }), 5);
  assert.equal(sectionOf({ section: 3 }), 3);
  assert.equal(sectionOf({}), null);
  assert.equal(sectionOfMissing({ level: 'model' }), 5);
  assert.equal(sectionOfMissing({ level: 'colour' }), 5);
  assert.equal(sectionOfMissing({ level: 'product' }), 3);
  assert.equal(sectionOfMissing({ level: null }), 3);
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /const section = e instanceof ApiError \? refusalSection\(e\.details\) : null;/);
  assert.match(form, /'\[data-form="pricing-v2"\]' : '\[data-section="5"\]'/);
});

test('Q2 projection: the owner reads the cost card; a price editor reads dollars and no cost; a cost-first product is the owner’s', () => {
  const owner = section3(stateOf(answer({ method: 'cost', can_edit: { money: true, cost: true, method: true, structure: true }, editor_usd: undefined })));
  assert.match(owner, /data-v2-card="cost"/);
  assert.ok(owner.includes(S.costOwnerOnly));
  const editor = section3(stateOf(answer()));
  assert.doesNotMatch(editor, /data-v2-card="cost"/, 'no cost card for a price editor');
  assert.ok(!editor.includes(S.costOwnerOnly) && !editor.includes(S.costOptional));
  assert.match(editor, /data-v2-field="product-usd"/, 'the editor types the dollar price');
  assert.ok(editor.includes(S.staffUsd));
  assert.doesNotMatch(editor, /data-v2-readout="cost"|data-v2-readout="profit"/, 'no cost or profit read-out');
  const costFirst = section3(stateOf(answer({ method: 'cost', can_edit: { money: false, cost: false, method: false, structure: true }, editor_usd: undefined })));
  assert.match(costFirst, /data-v2-owner-only/);
  assert.ok(costFirst.includes(S.costFirstNoMoney));
  assert.doesNotMatch(costFirst, /data-v2-field=/, 'nothing to type on a cost-first product');
  assert.match(costFirst, /1,500,000/, 'the final dinars are read');
});

test('the clean start: a product with no method is hidden until published; the chip says so, never contradictory', () => {
  const hidden = answer({ v2: false, needs_pricing: true, publishable: false, status: { kind: 'missing', first: null }, default_method: 'usd' });
  const html = section3(stateOf(hidden));
  assert.match(html, /data-v2-hidden/);
  assert.ok(html.includes(S.hiddenNote));
  assert.equal(chipOf(hidden, { owner: false, hidden: true, lang: 'ar' })?.kind, 'hidden');
  assert.equal(chipOf({ ...hidden, publishable: true }, { owner: false, hidden: true, lang: 'ar' })?.kind, 'hidden_ready');
  // Held beats everything; then hidden; then missing, review, current.
  assert.equal(chipOf({ ...hidden, status: { kind: 'held', reason: 'FX_REVIEW_PENDING' } }, { owner: true, hidden: true, lang: 'ar' })?.text, S.chipHeld);
  assert.equal(chipOf({ ...hidden, status: { kind: 'held', reason: 'FX_REVIEW_PENDING' } }, { owner: false, hidden: true, lang: 'ar' })?.text, S.chipHeldStaff);
  const live = answer();
  assert.equal(chipOf(live, { owner: true, hidden: false, lang: 'ar' })?.kind, 'current');
  assert.equal(chipOf({ ...live, status: { kind: 'review', count: 3 } }, { owner: true, hidden: false, lang: 'ar' })?.text, S.chipReview('3'));
  const missing = { ...live, status: { kind: 'missing' as const, first: { code: 'SUPPLIER_COST_MISSING', field: null, level: 'product' as const, count: 6, first_name: null } } };
  assert.match(chipOf(missing, { owner: true, hidden: false, lang: 'ar' })!.text, /^ناقص: /);
  // The table: one block per model, the lowest final price is section ٨'s «من … د.ع».
  assert.deepEqual(modelBlocks(TABLE, () => null).map((b) => b.model_id), ['m1', 'm2']);
  assert.equal(lowestPrice(TABLE), 1_425_000);
  assert.equal(comboKeyOf(['m2', 'm1'], 'c1'), 'o:m1|o:m2|c:c1', 'the server’s canonical SKU key');
});

test('no old dinar value is ever shown: the «البيانات المرسلة» view drops every legacy money key', () => {
  const view = withoutLegacyMoney({
    doc: { name_en: 'X', price_iqd: 900_000, pro_price_iqd: 850_000, original_price_iqd: 990_000, product_cost_iqd: 654_321, membership_prices: {}, direct_surcharge_iqd: 5000 },
    relations: { groups: [{ values: [{ id: 'v', regular_price_iqd: 1, regular_adjust_iqd: 2, cost_iqd: 3, fulfillments: [{ transports: [{ surcharge_iqd: 4, enabled: true }] }] }] }] },
  }) as { doc: Record<string, unknown>; relations: { groups: Array<{ values: Array<Record<string, unknown>> }> } };
  assert.deepEqual(Object.keys(view.doc), ['name_en']);
  const value = view.relations.groups[0]!.values[0]!;
  assert.deepEqual(Object.keys(value), ['id', 'fulfillments']);
  assert.match(src('src/components/adminProducts/ProductForm.tsx'), /JSON\.stringify\(withoutLegacyMoney\(/);
  // Section ٨: «السعر» is the lowest final price of the table, PRO is gone, the checkout preview waits for publication.
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /<Row k=\{v2s\.price\} v=\{lowest !== null \? v2s\.from\(iqdText\(lowest\)\)/);
  assert.match(form, /\{doc\.id && !v2\.hidden && \(/);
});

test('every v2Strings key in ar, en and ckb — ckb never copies the Arabic and carries a Sorani-only letter (row 183)', () => {
  const sample = (v: V2Strings[keyof V2Strings]) => (typeof v === 'function' ? (v as (a: string, b: string) => string)('X', 'Y') : v);
  const keys = Object.keys(V2_STRINGS.ar) as Array<keyof V2Strings>;
  assert.ok(keys.length >= 120);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(Object.keys(V2_STRINGS[lang]).sort(), [...keys].sort(), lang);
  const latinOnly = /^[\sA-Za-z0-9$±.()=:{}·+\-−→←/%]*$/;
  for (const k of keys) {
    const ar = sample(V2_STRINGS.ar[k]);
    const ckb = sample(V2_STRINGS.ckb[k]);
    const en = sample(V2_STRINGS.en[k]);
    assert.ok(ar && en && ckb, k);
    if (latinOnly.test(ckb)) continue;
    assert.notEqual(ckb, ar, `${k}: the Sorani copies the Arabic`);
    assert.match(ckb, /[ێۆڕڵەڤگچپژ]/, `${k}: no Sorani-only letter in «${ckb}»`);
  }
  // DECISIONS row 240: an unpriced product is shown without a price, no longer hidden.
  assert.equal(v2Strings('ckb').chipHidden, 'بێ نرخ پیشان دەدرێت — پێویستی بە نرخدانان هەیە');
  assert.equal(v2Strings('en').costFirstNoMoney, 'This product is priced from cost; only the owner prices it');
});
