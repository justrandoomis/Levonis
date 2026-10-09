/**
 * THE 4-CELL PRICING SUMMARY (owner brief 2026-10-09 §6-§7; USD design §5.2,
 * §12 P-C client): src/components/adminOperations/PricingSummaryBar.tsx, as the
 * procurement card and the product form render it.
 *
 * Proves: the brief's example reads $500.00 / +$120.00 / $620.00 / 992,000 د.ع
 * in that order; every figure is an LTR island inside the RTL page; one row of
 * four on a wide screen and two by two on a phone (utility classes only — no
 * new CSS against tests/bundleBudget.test.ts); a manual product's cell 4 says
 * «السعر المقترح للزبون» and an engine-priced one «السعر النهائي للزبون»; a
 * blocked bar shows "—" and the reason; "not installed" shows one line and no
 * bar; the screens import no pricing maths.
 *
 * Run: node --import tsx --test tests/pricingSummaryBar.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import PricingSummaryBar from '../src/components/adminOperations/PricingSummaryBar';
import type { PricingSummary } from '../src/components/adminOperations/procurementPricing';
import { PROCUREMENT_PRICING_STRINGS } from '../src/components/adminOperations/procurementPricingStrings';
import { codeOf } from './fixtures/source';

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));

const BRIEF: PricingSummary = {
  state: 'ok', issue_codes: [], shipping_profile: 'GERMANY_LAND', profile_source: 'default', engine_priced: false, option_id: 'o1',
  rule_level: 'product', minimum_target_profit_usd: '120', target_profit_iqd: null, target_profit_cents: 12_000,
  current_total_cost_cents: 50_000, final_price_cents: 62_000, preorder_base_iqd: 992_000, direct_sale_extra_iqd: null,
  direct_sale_price_iqd: null, rounding_added_iqd: 0, supplier_original_amount: '450', supplier_original_currency: 'EUR', iqd_converted: null,
  cross_rate: '1.1', supplier_cost_usd: '495', supplier_cost_cents: 49_500, basis: 'weight', effective_weight_g: 2500, effective_cbm: null,
  shipping_rate: '3200', shipping_cost_iqd: 8000, shipping_cost_usd: '5', shipping_cost_cents: 500, additional_cost_iqd: 0, additional_cost_usd: '0',
  additional_cost_cents: 0, excluded_charges: [], current_total_cost_usd: '500', final_price_usd: '620', usd_iqd_rate: '1600', document_rate: null,
  store_price_iqd: 900_000,
};

test('the brief’s example: $500.00 / +$120.00 / $620.00 / 992,000 د.ع, in that order, each figure an LTR island', () => {
  const html = render(createElement(PricingSummaryBar, { summary: BRIEF, label: 'AMS HT' }));
  const order = ['$500.00', '+$120.00', '$620.00', '992,000 د.ع'].map((f) => html.indexOf(f));
  assert.ok(order.every((i) => i > 0), html);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the four cells in the brief’s order');
  assert.equal((html.match(/<bdi dir="ltr"/g) ?? []).length, 4, 'every figure is an LTR island');
  assert.match(html, /grid-cols-2[^"]*sm:grid-cols-4|sm:grid-cols-4[^"]*grid-cols-2/, 'one row of four on a wide screen, two by two on a phone');
  const s = PROCUREMENT_PRICING_STRINGS.ar;
  for (const label of [s.cellCost, s.cellProfit, s.cellFinalUsd, s.cellSuggested]) assert.ok(html.includes(label), label);
  assert.ok(html.includes(s.barAria('AMS HT')));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes(s.storePrice('900,000 د.ع')), 'a manual product shows today’s store price beside the suggestion');
  assert.match(html, /aria-expanded="false"/, '«تفاصيل» starts closed');
});

test('an engine-priced product’s cell 4 is the final customer price; a blocked bar is "—" with its reason; not installed is one line', () => {
  const engine = render(createElement(PricingSummaryBar, { summary: { ...BRIEF, engine_priced: true }, label: 'x' }));
  assert.ok(engine.includes(PROCUREMENT_PRICING_STRINGS.ar.cellCustomer));
  assert.ok(!engine.includes(PROCUREMENT_PRICING_STRINGS.ar.storePrice('900,000 د.ع')));
  const blocked = render(createElement(PricingSummaryBar, { summary: { ...BRIEF, state: 'blocked', issue_codes: ['TARGET_PROFIT_MISSING'] }, label: 'x' }));
  assert.ok(!blocked.includes('$500.00'));
  assert.ok(blocked.includes(PROCUREMENT_PRICING_STRINGS.ar.targetProfitMissing));
  const off = render(createElement(PricingSummaryBar, { summary: null, label: 'x', notInstalled: true }));
  assert.ok(off.includes(PROCUREMENT_PRICING_STRINGS.ar.notInstalled));
  assert.ok(!off.includes('<dl'));
});

test('the bar, the card and the product form import no pricing or FX maths; they format the server’s figures', () => {
  for (const file of [
    'src/components/adminOperations/PricingSummaryBar.tsx',
    'src/components/adminOperations/ProcurementPricingReview.tsx',
    'src/components/adminOperations/procurementPricing.ts',
    'src/components/adminOperations/ProcurementPanel.tsx',
    'src/components/adminProducts/form/UsdPricingSection.tsx',
  ]) {
    const code = codeOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /from '[^']*(costToPrice|ruleResolution|legacyTargets|pricingEngine|fxChain|packages\/pricing)[^']*'/, file);
  }
});
