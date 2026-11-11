/**
 * «صافي حصتك» ON THE OVERVIEW IS WHAT THE OWNER KEEPS (redesign step 1, DECISIONS row 313).
 *
 * The 2026-11-11 audit found the headline BEFORE the order coupon, credited price
 * protection and a returned trade-in credit, while every staff and investor share is
 * worked out after them — so the owner's figure was overstated by the whole of them —
 * and a "complete" net that silently rested on sale-time estimates. These cases pin
 * the pure arithmetic the overview words (src/components/financeWorkspace/overviewFigures.ts).
 *
 * The step's review added three screen cases: a period without orders has no average
 * order to call «ناقص»; a returned trade-in credit reads in dollars on an order and a
 * product as on the period; and the note under the headline is worded in Sorani too.
 *
 * Run: node --import tsx --test tests/financeOverviewFigures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { averageOrder, overviewNet } from '../src/components/financeWorkspace/overviewFigures';
import type { DisplayUsdSummary, FinanceSummary } from '../src/components/financeWorkspace/types';
import ReportDeductions from '../src/components/financeWorkspace/ReportDeductions';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import { LanguageProvider } from '../src/LanguageContext';
import { codeOf } from './fixtures/source';

const summary = (over: Partial<FinanceSummary> & { totals?: FinanceSummary['totals'] }): FinanceSummary => ({
  range: { from: '2026-11-01', to: '2026-11-11' }, orders: [], kinds: null, products: [], categories: [], exceptions: [], promotions: [],
  general_expenses_iqd: 0, truncated: false, chart_data: { revenue_iqd: 55000 } as FinanceSummary['chart_data'], known: null, missing_costs: undefined,
  ...over, totals: { orders_count: 1, unknown_lines: 0, pending_costs: 0, ...(over.totals ?? {}) },
}) as FinanceSummary;

test('the headline is the period net after the order coupon, price protection and a returned trade-in credit', () => {
  const f = overviewNet(summary({ totals: { owner_period_net_iqd: 32300, owner_period_net_after_report_adjustments_iqd: 22300, coupon_iqd: 5000, price_protection_iqd: 3000, trade_in_credit_returned_iqd: 2000 } }));
  assert.equal(f.net, 22300, 'what the owner keeps, not 32,300');
  assert.equal(f.deductions, 10000, 'and the screen can say what came off');
  assert.equal(f.fromKnown, false);
  assert.equal(f.state, 'confirmed');
});

test('with incomplete orders it is the complete orders\' net after their deductions, over their own revenue', () => {
  const f = overviewNet(summary({
    totals: { owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null, unknown_lines: 4 },
    known: { orders_count: 9, incomplete_orders: 4, revenue_iqd: 4847211, cost_iqd: 3678427, owner_net_iqd: 1168784, net_after_report_adjustments_iqd: 1160000,
      confirmed: { orders_count: 3, revenue_iqd: 3310000, owner_net_iqd: 784859, net_after_report_adjustments_iqd: 780000 },
      estimated: { orders_count: 6, revenue_iqd: 1537211, owner_net_iqd: 383925, net_after_report_adjustments_iqd: 380000 } },
  }));
  assert.equal(f.net, 1160000);
  assert.equal(f.fromKnown, true);
  assert.equal(f.marginBase, 4847211, 'the margin is over the complete orders\' own revenue');
  assert.deepEqual(f.confirmed, { orders: 3, net: 780000 });
  assert.deepEqual(f.estimated, { orders: 6, net: 380000 });
  assert.equal(f.confirmed!.net! + f.estimated!.net!, f.net, 'the two parts add up to the headline');
  assert.equal(f.state, 'review');
});

test('a complete period whose net rests partly on sale-time estimates is never shown as confirmed', () => {
  const f = overviewNet(summary({
    totals: { owner_period_net_iqd: 20000, owner_period_net_after_report_adjustments_iqd: 20000 },
    known: { orders_count: 2, incomplete_orders: 0, revenue_iqd: 75000, cost_iqd: 50000, owner_net_iqd: 20000, net_after_report_adjustments_iqd: 20000,
      confirmed: { orders_count: 1, revenue_iqd: 55000, owner_net_iqd: 15000, net_after_report_adjustments_iqd: 15000 },
      estimated: { orders_count: 1, revenue_iqd: 20000, owner_net_iqd: 5000, net_after_report_adjustments_iqd: 5000 } },
  }));
  assert.equal(f.net, 20000);
  assert.equal(f.state, 'estimated', 'the status says «فيه تكلفة تقديرية», not «كل التكاليف مؤكدة»');
});

test('in dollars the headline takes the server\'s after-deductions cents, and a figure the server lacks stays missing, never dinars', () => {
  const data = summary({ totals: { owner_period_net_iqd: 32300, owner_period_net_after_report_adjustments_iqd: 24300, coupon_iqd: 5000, price_protection_iqd: 3000 } });
  const usd = { available: true, totals: { owner_period_net_cents: 2153, owner_period_net_after_report_adjustments_cents: 1620 } };
  assert.equal(overviewNet(data, usd).cents, 1620);
  assert.equal(overviewNet(data, { available: true, totals: { owner_period_net_cents: 2153 } }).cents, null, 'missing cents are missing, not the before-deductions figure');
  assert.equal(overviewNet(data).cents, undefined, 'no USD block: the figure stays in dinars');
});

test('a server that predates the after-deductions field still answers the figure before them', () => {
  const f = overviewNet(summary({ totals: { owner_period_net_iqd: 32300 } }));
  assert.equal(f.net, 32300);
});

test('a period without orders has no average order to show — never «ناقص», which means a value still to complete (step 1 review)', () => {
  assert.equal(averageOrder(summary({ totals: { orders_count: 0 }, chart_data: { revenue_iqd: 0 } as FinanceSummary['chart_data'] })), null);
  const four = summary({ totals: { orders_count: 4 }, chart_data: { revenue_iqd: 100000 } as FinanceSummary['chart_data'] });
  assert.deepEqual(averageOrder(four), { iqd: 25000, cents: undefined });
  assert.deepEqual(averageOrder(four, { available: true, chart: { revenue_cents: 6667 } } as DisplayUsdSummary), { iqd: 25000, cents: 1667 });
  const unknown = summary({ totals: { orders_count: 2 }, chart_data: { revenue_iqd: null } as unknown as FinanceSummary['chart_data'] });
  assert.deepEqual(averageOrder(unknown), { iqd: null, cents: undefined }, 'a revenue the server could not total stays missing');
});

test('a returned trade-in credit reads in dollars wherever the deductions are drawn — the period, an order, a product (step 1 review)', () => {
  const draw = (currency: 'IQD' | 'USD', cents?: { coupon?: number | null; credit?: number | null; tradeIn?: number | null; net?: number | null }) =>
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: currency },
      createElement(ReportDeductions, { totals: { coupon_iqd: 0, price_protection_iqd: 0, trade_in_credit_returned_iqd: 7000 }, net: 28000, cents }))));
  const usd = draw('USD', { coupon: 0, credit: 0, tradeIn: 467, net: 1867 });
  assert.match(usd, /4\.67/);
  assert.doesNotMatch(usd, /data-finance-missing/, 'the credit has its dollars');
  assert.doesNotMatch(draw('IQD'), /data-finance-missing/);
  assert.match(draw('USD', { coupon: 0, credit: 0, net: 1867 }), /data-finance-missing/, 'without them the row would say «ناقص»');
  // So every caller that draws dollars passes the credit's cents beside the coupon's and the price protection's.
  const calls = ['FinanceWorkspace.tsx', 'OrderProfitSheet.tsx']
    .flatMap((file) => codeOf(`src/components/financeWorkspace/${file}`).split('\n').filter((line) => line.includes('<ReportDeductions ')));
  assert.equal(calls.length, 3, 'the period, the product rows and the order sheet');
  for (const call of calls) assert.match(call, /tradeIn: \w+\('trade_in_credit_returned_iqd'\)/, call.trim().slice(0, 160));
});

test('the note under «صافي حصتك» names the complete orders in Arabic, English and real Sorani; no Sorani on the screen is the Arabic', () => {
  const ARABIC_ONLY = /[ةىيك]/, SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
  const workspace = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  for (const ar of ['من الطلبات المكتملة فقط', '، مع حصتها من المصاريف العامة بنسبة إيرادها']) {
    const words = new RegExp(`loc\\('${ar}', '([^']+)', '([^']+)'\\)`).exec(workspace);
    assert.ok(words, `«${ar}» carries its English and its Sorani`);
    assert.doesNotMatch(words[1], /[؀-ۿ]/, 'the English is English');
    assert.notEqual(words[2], ar);
    assert.match(words[2], SORANI_ONLY, words[2]);
    assert.doesNotMatch(words[2], ARABIC_ONLY, words[2]);
  }
  for (const [, ar, , ckb] of workspace.matchAll(/loc\('([^']*)', '([^']*)', '([^']*)'\)/g)) {
    assert.doesNotMatch(ckb, ARABIC_ONLY, `«${ckb}»`);
    if (/[؀-ۿ]/.test(ar.replace(/[،؛]/g, ''))) assert.notEqual(ckb, ar, `the Sorani of «${ar}» is the Arabic`);
  }
});

test('«تكاليف الشهر» explains the promotion by sales value wherever it explains it — no sentence still says pieces (owner 2026-11-11)', () => {
  const ARABIC_ONLY = /[ةىيك]/, SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
  const monthly = codeOf('src/components/financeWorkspace/MonthlyCosts.tsx');
  assert.doesNotMatch(monthly, /قطع المنتجات المباعة|عند بيع القطع|حسب عدد القطع|sold units|units sell/);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const ar of ['مبلغ واحد للشهر كله. يتوزع على مبيعات الشهر حسب قيمتها ويُخصم من حصة المالك.', 'حسب قيمة المبيعات', 'يظهر الآن ضمن تكاليف المالك، ويتوزع على مبيعات الشهر عند تسليمها.']) {
    const words = new RegExp(`loc\\('${escape(ar)}', '([^']+)', '([^']+)'\\)`).exec(monthly);
    assert.ok(words, `«${ar}» is said, with its English and its Sorani`);
    assert.match(words[1], /sales/i, words[1]);
    assert.match(words[2], SORANI_ONLY, words[2]);
    assert.doesNotMatch(words[2], ARABIC_ONLY, words[2]);
  }
});
