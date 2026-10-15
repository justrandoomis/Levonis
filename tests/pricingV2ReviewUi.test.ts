/**
 * PRICING V2 — THE FORM, THE LIST AND THE CART SAY ONE THING (UX review of feat/pricing-v2-core, 2026-10-14).
 *
 *   C3  the queue's missing line names fields, never raw codes, with a separator per language;
 *   C4  a box typed in the cost card is kept until its three axes are set; C11 the folded summary keeps
 *       each number with its localised unit;
 *   C5  the form header, the list rows, the Active tile and the completeness card agree on «يحتاج تسعيرًا»;
 *   C7  a cart with only unavailable lines never says «سلتك فارغة» under them;
 *   C8  inherited values are shown: the minimum profit (the owner's answer carries the resolved T), the
 *       model discount, the SKU price and discount behind visible labels;
 *   C9  a consequence (PRICE_INVALID) is not a separate missing item;
 *   C10 the pre-order label is not doubled; C12 section ٣ says «مخفي» once; C13 the buttons speak the
 *       reader's language; C14 tap targets; C15 two resets; C16 a model's own box; C17 the phone badge;
 *   C18 the result title of a product without options, and «مسار شحن المخزون».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, json, type StubUser } from './fixtures/app';
import { AMS, pricingWorld } from './fixtures/procurementPricing';
import { v2App, v2Context, writeV2 } from './fixtures/pricingV2';
import { missingLine } from '../src/components/adminProducts/NeedsPricingQueue';
import { boxOf, costSummaryParts } from '../src/components/adminProducts/form/v2/CostCard';
import { resultTitle } from '../src/components/adminProducts/form/v2/ResultBar';
import { followDiscount, followPrice } from '../src/components/adminProducts/form/v2/ModelPriceSelector';
import { inheritedUsd } from '../src/components/adminProducts/form/v2/FinalPricesTable';
import { draftOf, FOLLOW_MODEL, inheritedSkuDiscount, inheritPlaceholder, type SkuLine, type V2Answer } from '../src/components/adminProducts/form/v2/v2Model';
import { headerStatusText, V2_STRINGS } from '../src/components/adminProducts/form/v2/v2Strings';
import { activeTileSub, separateListNote } from '../src/components/adminProducts/needsPricingStrings';
import { cartEmptyText } from '../src/lib/cartEmptyText';
import { inheritedMinimumProfit } from '../worker/lib/pricingEngine/v2/api';
import { evaluateV2Write } from '../worker/lib/pricingEngine/v2/evaluate';
import type { PricingRuleRow } from '@levonis/pricing/ruleResolution';

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
const LANGS = ['ar', 'en', 'ckb'] as const;
const src = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

test('C3/C9: the queue\'s missing line names the field in the reader\'s language — no raw code, no «(—)», no consequence beside its cause', () => {
  const missing = [
    { code: 'V2_PRICE_MISSING', field: null, level: 'model', count: 6, first_name: { ar: 'قياسي', en: 'Std', ckb: 'ستاندارد' } },
    { code: 'PRICE_INVALID', field: null, level: null, count: 0, first_name: null },
    { code: 'V2_PRICE_MISSING', field: null, level: 'product', count: 1, first_name: { ar: '', en: '', ckb: '' } },
  ];
  for (const lang of LANGS) {
    const line = missingLine(missing, lang);
    assert.doesNotMatch(line, /V2_PRICE_MISSING|PRICE_INVALID/, lang);
    assert.doesNotMatch(line, /\(—\)/, lang);
    assert.match(line, /×6/);
  }
  assert.doesNotMatch(missingLine(missing, 'en'), /،/, 'an English list takes an English comma');
  assert.match(missingLine(missing, 'en'), /\(model · Std\) ×6, /);
  // A consequence alone still says something.
  assert.notEqual(missingLine([missing[1]!], 'ar'), '');
});

test('C9: the evaluation drops PRICE_INVALID when an input already explains the gap', async () => {
  const w = pricingWorld();
  const c = await v2Context(w.db, AMS);
  const ev = await evaluateV2Write({ ...c, method: 'usd', points: [], discounts: [], inputWrites: [], ruleWrites: [], acceptBlocked: true });
  assert.equal(ev.complete, false);
  const codes = ev.missing.map((m) => m.code);
  assert.ok(codes.length > 0);
  if (codes.some((x) => x !== 'PRICE_INVALID')) assert.ok(!codes.includes('PRICE_INVALID'), codes.join(','));
});

test('C4/C11/C16: a box is kept until its three axes are set; the summary keeps each number with its unit; a model can carry its own box', () => {
  assert.equal(boxOf([600, null, 480]), null, 'a partial box is never sent');
  assert.deepEqual(boxOf([600, 520, 480]), [600, 520, 480]);
  const parts = costSummaryParts({ supplier_amount: '500', supplier_currency: 'USD', weight_g: 9000, extras_iqd: null }, 'الشحن البحري من الصين', V2_STRINGS.ar.kgUnit);
  assert.deepEqual(parts, ['USD 500', 'الشحن البحري من الصين', '9 كغ']);
  assert.ok(!parts.some((p) => /\bkg\b/.test(p)), 'no hard-coded "kg" in Arabic');
  assert.notEqual(V2_STRINGS.ckb.kgUnit, V2_STRINGS.ar.kgUnit);
  const card = src('src/components/adminProducts/form/v2/CostCard.tsx');
  assert.match(card, /<bdi/, 'each summary part is isolated');
  assert.match(card, /const \[box, setBoxDraft\] = useState<Array<number \| null>>/, 'the typed axes are local state');
  // C16: «تكلفة مختلفة» offers a box; the draft reads a stored model box.
  assert.equal(FOLLOW_MODEL.box, null);
  const d = draftOf({
    v2_cost_inputs: {
      inputs: [{ scope: 'option', scope_id: 'm1', supplier_cost_amount: null, supplier_cost_currency: null, shipping_weight_g: null, shipping_length_mm: 400, shipping_width_mm: 300, shipping_height_mm: 200 }],
      minimum_profit: [],
    },
  } as unknown as V2Answer);
  assert.deepEqual(d.models.m1?.box, [400, 300, 200]);
  assert.equal(d.models.m1?.price, 'own_cost');
  assert.match(src('src/components/adminProducts/form/v2/ModelPriceSelector.tsx'), /<ModelBoxInputs/);
});

test('C18/C10: the result title of a product without options has no «(—)»; the pre-order label is never doubled', () => {
  for (const lang of LANGS) {
    const s = V2_STRINGS[lang];
    assert.doesNotMatch(resultTitle('—', s), /\(|—/, lang);
    assert.doesNotMatch(resultTitle('', s), /\(/, lang);
    assert.match(resultTitle('Pro', s), /Pro/);
  }
  for (const f of ['FinalPricesTable', 'ResultBar', 'ModelPriceSelector']) {
    assert.doesNotMatch(src(`src/components/adminProducts/form/v2/${f}.tsx`), /preorderVia\(/, `${f}: channelName alone`);
  }
  const noComments = (t: string) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const labels = noComments(src('packages/contracts/src/pricingFieldLabels.ts') + src('packages/contracts/src/pricingIssues.ts'));
  assert.doesNotMatch(labels, /طريقة الشحن الافتراضية|Default shipping profile/);
});

test('C15: the model\'s price and its discount exception have one reset each', () => {
  const p = followPrice();
  const d = followDiscount();
  assert.equal(p.price, 'follow');
  assert.ok(!('discount' in p) && !('discount_usd' in p), 'resetting the price keeps the discount exception');
  assert.equal(d.discount, 'follow');
  assert.ok(!('price' in d) && !('usd' in d), 'resetting the discount keeps the price exception');
  assert.equal(p.box, null);
});

test('C8: inherited values — the minimum-profit placeholder, the SKU discount and price behind visible labels', () => {
  assert.equal(inheritPlaceholder('يرث', { amount_usd: '40', amount_iqd: null }), 'يرث ($40.00)');
  assert.equal(inheritPlaceholder('Inherit', { amount_usd: null, amount_iqd: 50000 }), 'Inherit (50,000)');
  assert.equal(inheritPlaceholder('يرث', null), 'يرث');
  const draft = { discount_usd: '40', models: { m1: { ...FOLLOW_MODEL, discount: 'exception' as const, discount_usd: '25' }, m2: { ...FOLLOW_MODEL } } };
  assert.deepEqual(inheritedSkuDiscount(draft, 'm1'), { from: 'model', usd: '25' });
  assert.deepEqual(inheritedSkuDiscount(draft, 'm2'), { from: 'product', usd: '40' });
  assert.deepEqual(inheritedSkuDiscount({ discount_usd: '', models: {} }, null), { from: 'product', usd: '0' });
  const line = { channels: { direct_sale: { editor_usd_price: '999.5' } } } as unknown as SkuLine;
  assert.equal(inheritedUsd(line, ''), '999.5');
  assert.equal(inheritedUsd(line, '1200'), null, 'its own special price: nothing inherited');
  const table = src('src/components/adminProducts/form/v2/FinalPricesTable.tsx');
  assert.match(table, /<V2Field label=\{s\.skuSpecial\}/);
  assert.match(table, /<V2Field label=\{s\.skuDiscount\}/);
  assert.doesNotMatch(table, /placeholder=\{s\.skuSpecial\}|placeholder=\{s\.skuDiscount\}/, 'a label, not a placeholder');
  assert.match(src('src/components/adminProducts/form/v2/ProfitDiscountCard.tsx'), /placeholder=\{inheritPlaceholder\(s\.inherit, inheritedMinProfit\)\}/);
});

test('C8: the minimum profit the product inherits resolves from above its own rule — the store-wide rule, never its own', () => {
  const rule = (over: Partial<PricingRuleRow>): PricingRuleRow => ({
    id: 'r',
    kind: 'target_profit',
    scope: 'global',
    catalog_id: null,
    product_id: null,
    scope_id: '',
    state: 'ACTIVE',
    amount_iqd: null,
    amount_usd: null,
    version: 1,
    ...over,
  });
  const rules = [rule({ id: 'g', amount_usd: '40' }), rule({ id: 'own', scope: 'product', product_id: 'p1', amount_usd: '55' })];
  assert.deepEqual(inheritedMinimumProfit(rules, 'p1', '1500'), { amount_usd: '40', amount_iqd: null });
  assert.equal(inheritedMinimumProfit([rules[1]!], 'p1', '1500'), null, 'nothing above: the field is required');
});

test('C8: the owner\'s answer carries the inherited minimum profit inside its owner-only cost inputs; an editor\'s answer carries none', async () => {
  const w = pricingWorld();
  const owner = await json(await get(v2App(w.raw), `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(owner.success, true, JSON.stringify(owner));
  assert.ok('inherited_minimum_profit' in owner.v2_cost_inputs, 'the key is always answered (null when nothing above decides)');
  const editor = await json(await get(v2App(w.raw, EDITOR), `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(JSON.stringify(editor).includes('inherited_minimum_profit'), false);
  assert.equal(JSON.stringify(editor).includes('v2_cost_inputs'), false);
});

test('C5: the form header, the list badge, the Active tile and the completeness card agree on «يحتاج تسعيرًا»', () => {
  for (const lang of LANGS) {
    const s = V2_STRINGS[lang];
    assert.equal(headerStatusText('active', true, s), s.chipHidden, `${lang}: never «منشور» while hidden`);
    assert.equal(headerStatusText('active', false, s), s.statusPublished);
    assert.equal(headerStatusText('draft', true, s), s.draft);
    assert.equal(headerStatusText('hidden', false, s), s.statusHidden);
  }
  assert.notEqual(V2_STRINGS.ckb.statusPublished, V2_STRINGS.ar.statusPublished);
  assert.notEqual(V2_STRINGS.ckb.statusHidden, V2_STRINGS.ar.statusHidden);
  for (const lang of LANGS) {
    assert.match(activeTileSub({ active_needs_pricing: 3 }, 100, lang), /3/);
    assert.doesNotMatch(activeTileSub({ active_needs_pricing: 0 }, 100, lang), /·/);
    assert.match(separateListNote(3, lang), /3/);
  }
  assert.notEqual(activeTileSub({ active_needs_pricing: 3 }, 100, 'ckb'), activeTileSub({ active_needs_pricing: 3 }, 100, 'ar'));
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /\{headerStatusText\(doc\.status, v2\.hidden, v2s\)\}/);
  const list = src('src/components/AdminProducts.tsx');
  // Every row badge knows (row 240: from the row itself — a composition or a catalogue-held product reads «مخفي»).
  assert.equal((list.match(/<Badge status=\{p\.status\} product=\{p\} \/>/g) ?? []).length, 4, 'every row badge knows');
  assert.match(list, /sub=\{activeSub\(stats\.totals, activePct/);
  assert.match(list, /needsPricing=\{hiddenCount\}/);
  // C17: on a phone the badge also sits under the name.
  assert.match(list, /lg:hidden[^"]*"[^>]*data-needs-pricing-under-name/);
});

test('C5: /stats counts the active products customers cannot see yet', async () => {
  const w = pricingWorld();
  const editor = v2App(w.raw, EDITOR);
  const before = await json(await get(editor, '/api/admin/products-v2/stats'));
  assert.equal(before.success, true, JSON.stringify(before));
  const n = before.totals.active_needs_pricing as number;
  assert.ok(n >= 1, 'the seeded catalogue still needs pricing');
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }] });
  const after = await json(await get(editor, '/api/admin/products-v2/stats'));
  assert.equal(after.totals.active_needs_pricing, n - 1);
});

test('C7: a cart with only unavailable lines says nothing can be bought now — never «سلتك فارغة» under them', () => {
  assert.equal(cartEmptyText(0).ar, 'سلتك فارغة');
  const t = cartEmptyText(2);
  assert.notEqual(t.ar, 'سلتك فارغة');
  assert.notEqual(t.en, 'Your cart is empty.');
  assert.notEqual(t.ckb, t.ar);
  assert.match(src('src/pages/Cart.tsx'), /cartEmptyText\(unavailableLines\.length\)/);
});

test('C12/C13: section ٣ says «مخفي» once; the buttons speak the reader\'s language', () => {
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /v2\.hidden \? null : v2s\.noPriceYet/);
  assert.match(form, /\{v2s\.draft\}/);
  assert.match(form, /\{v2s\.publish\}/);
  assert.doesNotMatch(form, /\/> نشر\n/);
  // The copy names the button the reader sees.
  for (const lang of LANGS) assert.ok(V2_STRINGS[lang].hiddenNoteReady.includes(V2_STRINGS[lang].publish), lang);
});

test('C14: the new controls are at least 44px tall', () => {
  const v2 = (f: string) => src(`src/components/adminProducts/form/v2/${f}.tsx`);
  assert.match(v2('ReadinessV2'), /<button type="button" className="inline-flex min-h-11 /);
  assert.match(v2('ReviewSheetV2'), /<label className="flex min-h-11/);
  assert.match(v2('PricesSectionV2'), /href="\/admin\?tab=pricing" className="inline-flex min-h-11/);
  assert.match(v2('MethodToggle'), /size="md"/);
  assert.match(src('src/components/adminProducts/NeedsPricingQueue.tsx'), /\$\{T\.chip\} min-h-11/);
  for (const f of ['FinalPricesTable', 'ModelPriceSelector', 'ColourPriceSelector', 'CostCard']) assert.match(v2(f), /min-h-11/, f);
});
