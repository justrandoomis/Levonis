/**
 * A STOCK PURCHASE IS REVIEWED FOR DIRECT SALE (owner request 2026-10-10:
 * «المخزون هو للبيع المباشر … المفروض هو فقط بيع مباشر»):
 * src/components/adminOperations/ProcurementPricingReview.tsx, rendered.
 *
 * Proves: the Direct Sale Extra field and direct table contain only direct-sale
 * rows, even if a stale response still carries preorder rows. A preorder-only
 * product has an explanation and no price table. The generic table remains
 * available to the product form and global pricing screens. Typed extras keep
 * the existing validation, large-change confirmation and Sorani translations.
 *
 * Run: node --import tsx --test tests/procurementPricingReview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import ProcurementPricingReview, { PricingRowsTable, SavedPurchasePricing, extrasOf, typedExtraList, withProductExtras } from '../src/components/adminOperations/ProcurementPricingReview';
import { extraAmount, extraOnStep, hasSomethingToApply, pricingBody, type EngineAdoption, type PricingPreview, type PricingPreviewRow, type PricingProduct } from '../src/components/adminOperations/procurementPricing';
import { PROCUREMENT_PRICING_STRINGS, issueText } from '../src/components/adminOperations/procurementPricingStrings';
import { engineSaveStrings } from '../src/components/adminOperations/engineSaveStrings';

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const S = PROCUREMENT_PRICING_STRINGS.ar;

const row = (option_id: string, name: string, channel: string, over: Partial<PricingPreviewRow> = {}): PricingPreviewRow => ({
  option_id, name_ar: name, name_en: name, name_ckb: name, channel,
  today_prepaid_iqd: null, today_cod_iqd: null, cod_priced_as_direct: false, computed_price_iqd: null, change_iqd: null,
  replacement_cost_iqd: null, target_profit_usd: '175', target_profit_iqd: null, direct_sale_extra_iqd: null, preorder_base_iqd: null, issue_codes: [],
  ...over,
});

/** The owner's A1 (2026-10-10 screenshot): A1 and A1 Combo, sold direct and by land pre-order, no Direct Sale Extra yet. */
const ROWS: PricingPreviewRow[] = [
  row('a1', 'A1', 'direct_sale', { today_prepaid_iqd: 799_000, issue_codes: ['DIRECT_SALE_EXTRA_MISSING'] }),
  row('a1', 'A1', 'pre_order_land', { today_prepaid_iqd: 749_000, computed_price_iqd: 875_000, preorder_base_iqd: 875_000, replacement_cost_iqd: 585_727 }),
  row('combo', 'A1 Combo', 'direct_sale', { today_prepaid_iqd: 965_000, issue_codes: ['DIRECT_SALE_EXTRA_MISSING'] }),
  row('combo', 'A1 Combo', 'pre_order_land', { today_prepaid_iqd: 915_000, computed_price_iqd: 1_100_000, preorder_base_iqd: 1_100_000, replacement_cost_iqd: 810_391 }),
];

const dataOnly: EngineAdoption = {
  kind: null, mode: 'manual', complete: false, missing_codes: ['DIRECT_SALE_EXTRA_MISSING'], needs_write: false, preview_hash: null, large_change: false,
  drop_flag: false, legacy_step: false, cod_priced_as_direct: true, review_pending: false, usd_iqd_rate: '1650', rows: [],
};

const adoptRow = (r: PricingPreviewRow, price: number, extra: number | null) => ({
  option_id: r.option_id, name_ar: r.name_ar, name_en: r.name_en, name_ckb: r.name_ckb, channel: r.channel, today_prepaid_iqd: r.today_prepaid_iqd,
  computed_price_iqd: price, change_iqd: price - (r.today_prepaid_iqd ?? 0), change_pct: '16.8', large: true, drop_flag: false,
  replacement_cost_iqd: 585_727, target_profit_usd: '175', target_profit_iqd: 288_750, preorder_base_iqd: price - (extra ?? 0), direct_sale_extra_iqd: extra,
  final_price_usd: '530', route_fee_removed: false, pro_before_iqd: null, pro_after_iqd: null, prime_before_iqd: null, prime_after_iqd: null,
});

const writes: EngineAdoption = {
  ...dataOnly, kind: 'adopt', complete: true, missing_codes: [], needs_write: true, preview_hash: 'e'.repeat(64), large_change: true,
  rows: [adoptRow(ROWS[0]!, 875_000, 0), adoptRow(ROWS[1]!, 875_000, null), adoptRow(ROWS[2]!, 1_100_000, 0), adoptRow(ROWS[3]!, 1_100_000, null)],
};

const A1: PricingProduct = {
  product_id: 'p_a1', label: 'Bambu Lab A1', mode: 'manual', feeds: true, eligible: true, reason: null, use_purchase: true, prefer_purchase_values: false,
  preview_hash: 'f'.repeat(64), applied: false, cancelled_source: false, entries: [], proposals: [{ scope: 'base', scope_id: '', shipping_profile: 'GERMANY_LAND' }],
  shadowed: [], rows: ROWS, missing_codes: ['DIRECT_SALE_EXTRA_MISSING'], cod_priced_as_direct: true, minimum_profits: [],
  direct_sale_extras: [], extra_suggestions: [{ option_id: 'a1', direct_sale_extra_iqd: 50_000 }, { option_id: 'combo', direct_sale_extra_iqd: 50_000 }],
  adoption: dataOnly,
};

const preview = (...products: PricingProduct[]): PricingPreview => ({ rates: { usd_iqd_rate: '1650', review_pending: false, derived_stale: false }, lines: [], products });
const review = (p: PricingProduct, extras: Record<string, string> = {}) =>
  render(
    createElement(ProcurementPricingReview, {
      preview: preview(p), busy: false, usePurchase: {}, prefer: {}, onUsePurchase: () => {}, onPrefer: () => {},
      confirmLarge: {}, onConfirmLarge: () => {}, extras, onExtras: () => {},
    })
  );
const headers = (html: string) => [...html.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

test('data only: only direct rows and their extra field are reviewed; stale preorder rows never appear', () => {
  const html = review(A1);
  const direct = html.indexOf('data-direct-block');
  assert.ok(direct > 0);
  assert.ok(!html.includes('data-preorder-block'), 'stock procurement has no preorder disclosure');
  const block = html.slice(direct);
  assert.ok(block.includes(S.sectionDirect));
  assert.ok(block.includes(S.extraLabel) && block.includes(S.extraHint));
  assert.ok(block.includes(S.noExtra));
  assert.ok(block.includes(S.todayExtra('50,000 د.ع')), 'every direct model has today’s value: the button offers it');
  assert.deepEqual(headers(block), [S.colModel, S.colReplacement, S.colMinProfit, S.colBeforeExtra, S.colExtra, S.colNewDirect, S.colOldNew], 'the direct table: no channel column');
  assert.equal((block.match(/<tr class="border-b/g) ?? []).length, 2, 'one row for each direct model');
  assert.ok(!block.includes('749,000') && !block.includes('915,000'), 'neither preorder price is exposed as an applicable stock price');
  assert.ok(html.includes(S.extraNeeded));
  assert.ok(!html.includes(S.incomplete('')), 'not the generic data-only notice');
  assert.ok(html.includes(S.directRoute('الشحن البري من ألمانيا')));
  assert.ok(!html.includes('مسار الشحن الأساسي'), 'the old pre-order wording of the route notice is gone for a direct product');
});

test('a confirm that writes prices: direct base plus extra only, with the 15% tick beneath the direct table', () => {
  const html = review({ ...A1, missing_codes: [], adoption: writes });
  assert.ok(!html.includes('data-preorder-block'));
  const block = html.slice(html.indexOf('data-direct-block'));
  assert.ok(block.includes('875,000 د.ع') && block.includes('1,100,000 د.ع'));
  assert.ok(block.includes('799,000 د.ع ← 875,000 د.ع'), 'old → new of the direct cell');
  assert.ok(!block.includes('749,000') && !block.includes('915,000'), 'a stale mixed-channel adoption is filtered too');
  assert.equal((block.match(/<tr class="border-b/g) ?? []).length, 2);
  assert.ok(block.includes('0 د.ع'), 'the extra the owner typed');
  const tick = html.indexOf('data-pricing-large');
  assert.ok(tick > html.indexOf('</table>'), 'the tick covers the direct prices shown above it');
  assert.ok(html.includes(engineSaveStrings('ar').adoptIntro));
  assert.ok(!html.includes(S.extraNeeded));
});

test('the field: the stored value as placeholder, the typed value shown, an off-step value refused; no «today» button unless every direct model has a clean value', () => {
  const stored = review({ ...A1, direct_sale_extras: [{ scope: 'product', scope_id: '', state: 'ACTIVE', source: 'OWNER', direct_sale_extra_iqd: 25_000 }] });
  assert.match(stored, /placeholder="25,000 د.ع"/);
  const typed = review(A1, { 'p_a1|product|': '1500' });
  assert.match(typed, /value="1500"/);
  assert.ok(typed.includes(S.extraInvalid), 'off the 1,000 step: refused on screen as the server would');
  assert.ok(!review(A1, { 'p_a1|product|': '٥٠٬٠٠٠' }).includes(S.extraInvalid), 'Arabic-Indic digits and separators are read');
  const partial = review({ ...A1, extra_suggestions: [{ option_id: 'a1', direct_sale_extra_iqd: 50_000 }] });
  assert.ok(!partial.includes('data-extra-today'), 'one model without a clean value: no button');
  assert.ok(partial.includes(S.noExtra), '0 is always one click');
  const mixed = review({ ...A1, extra_suggestions: [{ option_id: 'a1', direct_sale_extra_iqd: 50_000 }, { option_id: 'combo', direct_sale_extra_iqd: 100_000 }] });
  assert.ok(mixed.includes(S.todayExtra('50,000 د.ع – 100,000 د.ع')));
});

test('a preorder-only product has a notice without any purchase pricing table or extra field', () => {
  const preorderOnly: PricingProduct = { ...A1, rows: ROWS.filter((r) => r.channel !== 'direct_sale'), missing_codes: [], cod_priced_as_direct: false, extra_suggestions: [] };
  const html = review(preorderOnly);
  assert.ok(!html.includes('data-direct-block'));
  assert.ok(!html.includes('data-extra-field'));
  assert.ok(html.includes(S.preorderOnly));
  assert.ok(!html.includes('data-pricing-rows'));
  assert.ok(!html.includes('data-preorder-block'));
  assert.deepEqual(headers(html), []);
  assert.ok(!html.includes('749,000') && !html.includes('915,000'));
});

test('PricingRowsTable without a variant is the eight columns the product form and the save sheet read, unchanged', () => {
  const all = render(createElement(PricingRowsTable, { rows: ROWS }));
  assert.deepEqual(headers(all), [S.colModel, S.colChannel, S.colReplacement, S.colMinProfit, S.colNewPreorder, S.colExtra, S.colNewDirect, S.colOldNew]);
  assert.match(all, /<div class="mt-3 overflow-x-auto" data-pricing-rows="true"><table class="w-full min-w-\[640px\] text-start text-\[13px\] tabular-nums">/);
  assert.equal((all.match(/<tr class="border-b/g) ?? []).length, 4);
  assert.deepEqual(headers(render(createElement(PricingRowsTable, { rows: ROWS, variant: 'direct' }))).length, 7);
  assert.deepEqual(headers(render(createElement(PricingRowsTable, { rows: ROWS, variant: 'preorder' }))).length, 6);
});

test('the client helpers: typed extras by product, the request body, and the same validation as the server', () => {
  // The card's map ↔ one product's entries.
  let m = withProductExtras({ 'x|product|': '5000' }, 'p_a1', [{ scope: 'product', scope_id: '', amount: '0' }, { scope: 'option', scope_id: 'combo', amount: '0' }]);
  assert.deepEqual(m, { 'x|product|': '5000', 'p_a1|product|': '0', 'p_a1|option|combo': '0' });
  assert.deepEqual(extrasOf(m, 'p_a1'), { 'product|': '0', 'option|combo': '0' });
  assert.deepEqual(typedExtraList('p_a1', extrasOf(m, 'p_a1')), [
    { product_id: 'p_a1', scope: 'product', scope_id: '', amount_iqd: '0' },
    { product_id: 'p_a1', scope: 'option', scope_id: 'combo', amount_iqd: '0' },
  ]);
  m = withProductExtras(m, 'p_a1', null);
  assert.deepEqual(m, { 'x|product|': '5000' });
  // Digits and separators are read; the 1,000 step and the bounds are checked; '' is inherit.
  assert.equal(extraAmount('٥٠٬٠٠٠'), 50_000);
  assert.equal(extraAmount('50,000'), 50_000);
  assert.equal(extraAmount('۵۰۰۰۰'), 50_000);
  assert.equal(extraAmount(' '), null);
  assert.ok(Number.isNaN(extraAmount('5e4')!));
  assert.ok(Number.isNaN(extraAmount('-1000')!));
  assert.equal(extraOnStep(''), true);
  assert.equal(extraOnStep('0'), true);
  assert.equal(extraOnStep('1500'), false);
  assert.equal(extraOnStep('2000000000'), false);
  // The body carries the extras only when typed: an older server, which refuses an unknown key, sees today's body.
  const base = { minimums: [], optIn: [], usePurchase: {}, prefer: {} };
  assert.equal('direct_sale_extras' in pricingBody(base), false);
  assert.deepEqual(pricingBody({ ...base, extras: [{ product_id: 'p_a1', scope: 'product', scope_id: 'ignored', amount_iqd: '٥٠٬٠٠٠' }] }).direct_sale_extras, [
    { product_id: 'p_a1', scope: 'product', scope_id: '', amount_iqd: 50_000 },
  ]);
  // A typed extra is something to apply, even when the purchase feeds nothing.
  const quiet: PricingProduct = { ...A1, entries: [] };
  assert.equal(hasSomethingToApply(quiet, base), false);
  assert.equal(hasSomethingToApply(quiet, { ...base, extras: [{ product_id: 'p_a1', scope: 'product', scope_id: '', amount_iqd: '0' }] }), true);
});

test('the Sorani screen reads Sorani: the direct block and the field', () => {
  const store = globalThis as unknown as { localStorage?: unknown };
  const before = store.localStorage;
  store.localStorage = { getItem: () => 'ckb', setItem: () => {}, removeItem: () => {} };
  try {
    const html = review(A1);
    const K = PROCUREMENT_PRICING_STRINGS.ckb;
    for (const s of [K.sectionDirect, K.extraLabel, K.noExtra, K.extraNeeded, K.colBeforeExtra]) assert.ok(html.includes(s), s);
    assert.ok(!html.includes(S.extraLabel) && !html.includes(S.noExtra), 'never the Arabic in the Sorani screen');
  } finally {
    store.localStorage = before;
  }
});

test('a saved purchase confirmed «data only» for want of the extra: «تفاصيل الشحنة» offers the same field — applied or not — and no apply until a value is typed and previewed', () => {
  const saved = (p: PricingProduct) =>
    render(createElement(SavedPurchasePricing, { preview: preview(p), purchaseId: 'po_1', failures: [], choices: { minimums: [], optIn: [], usePurchase: {}, prefer: {} }, onDone: () => {} }));
  const appliedHtml = saved({ ...A1, applied: true });
  assert.ok(appliedHtml.includes('data-extra-field'), 'applied data-only: the field');
  assert.ok(appliedHtml.includes(S.incomplete(issueText('DIRECT_SALE_EXTRA_MISSING', 'ar'))), 'its state says data only, and why');
  assert.ok(!appliedHtml.includes(`>${S.applyNow}<`), 'nothing to apply until the owner types a value');
  const pendingHtml = saved({ ...A1, applied: false, entries: [{ scope: 'option', scope_id: 'a1', narrow: false, line_ids: [], kept_higher: [], changes: { supplier_cost_amount: { before: null, after: '320' } } }] });
  assert.ok(pendingHtml.includes('data-extra-field'), 'not applied yet: the field too');
  assert.ok(pendingHtml.includes(S.notApplied) && pendingHtml.includes(S.applyNow));
  assert.equal((pendingHtml.match(/data-saved-product=/g) ?? []).length, 1, 'one card per product');
  // A complete product needs no field.
  assert.equal(saved({ ...A1, applied: true, missing_codes: [] }), '');
});
