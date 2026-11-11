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
 * The independent review (2026-11-11) added the overview itself, drawn end to end: the note
 * under the headline names only what came off it (R2) and, in dollars, names its parts in
 * dollars; no margin is «—»; a waiting investor share is «ينتظر» on both its rows; the
 * follow-up row of money still to be recorded counts Gini's amounts too; and the overview's
 * tables say «ناقص», never a bare dash. Every one of these failed on e4574a8a.
 *
 * The workspace imports its stylesheet; node has no CSS loader, so a resolve hook answers
 * `.css` with an empty module before the import (as tests/ordersListUi.test.ts).
 *
 * Run: node --import tsx --test tests/financeOverviewFigures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { averageOrder, overviewNet } from '../src/components/financeWorkspace/overviewFigures';
import type { DisplayUsdSummary, FinanceSummary } from '../src/components/financeWorkspace/types';
import ReportDeductions from '../src/components/financeWorkspace/ReportDeductions';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import { LanguageProvider } from '../src/LanguageContext';
import { codeOf } from './fixtures/source';
import { ROOT } from './fixtures/d1';

// The language the provider reads at mount: each render below picks its own.
let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
         if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
         return next(specifier, context);
       }`
    )
);
const { Overview, default: FinanceWorkspace } = await import('../src/components/financeWorkspace/FinanceWorkspace');
const { default: OverviewCharts } = await import('../src/components/financeWorkspace/OverviewCharts');

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
  assert.deepEqual(f.confirmed, { orders: 3, net: 780000, cents: undefined });
  assert.deepEqual(f.estimated, { orders: 6, net: 380000, cents: undefined });
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
  const overview = [workspace, codeOf('src/components/financeWorkspace/OverviewCharts.tsx'), codeOf('src/components/financeWorkspace/displayCurrency.tsx')].join('\n');
  for (const [, ar, , ckb] of overview.matchAll(/loc\('([^']*)', '([^']*)', '([^']*)'\)/g)) {
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

test('what the note names as taken off is what came off the figure shown: the complete orders\' own deductions on the known path, nothing without a figure (review R2)', () => {
  const known = (before: number, after: number) => ({ orders_count: 1, incomplete_orders: 1, revenue_iqd: 55000, cost_iqd: 20000, owner_net_iqd: before, net_after_report_adjustments_iqd: after });
  // The period's 5,000 coupon is the incomplete order's: the complete one took nothing off.
  const incomplete = { owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null, unknown_lines: 1, coupon_iqd: 5000 };
  assert.equal(overviewNet(summary({ totals: incomplete, known: known(35000, 35000) })).deductions, 0);
  assert.equal(overviewNet(summary({ totals: { ...incomplete, coupon_iqd: 8000 }, known: known(35000, 32000) })).deductions, 3000, 'only the complete orders\' 3,000 of the period\'s 8,000');
  const usd = { available: true, totals: { coupon_cents: 533 }, known: { revenue_cents: 3667, cost_cents: 1333, owner_net_cents: 2333, net_after_report_adjustments_cents: 2133 } };
  assert.equal(overviewNet(summary({ totals: { ...incomplete, coupon_iqd: 8000 }, known: known(35000, 32000) }), usd).deductionsCents, 200, 'in dollars, from the server\'s known cents');
  // A complete period: every order's deductions came off its figure.
  const full = { owner_period_net_iqd: 32300, owner_period_net_after_report_adjustments_iqd: 22300, coupon_iqd: 5000, price_protection_iqd: 3000, trade_in_credit_returned_iqd: 2000 };
  assert.equal(overviewNet(summary({ totals: full }), { available: true, totals: { owner_period_net_after_report_adjustments_cents: 1487, coupon_cents: 333, price_protection_cents: 200, trade_in_credit_returned_cents: 133 } }).deductionsCents, 666);
  // No figure at all, or a server whose figure is before the deductions: nothing to name as taken off.
  assert.equal(overviewNet(summary({ totals: { ...incomplete, coupon_iqd: 8000 } })).deductions, 0, 'a «ناقص» headline took nothing off');
  assert.equal(overviewNet(summary({ totals: { owner_period_net_iqd: 32300, coupon_iqd: 5000 } })).deductions, 0, 'a figure before the deductions took nothing off');
});

const noop = () => {};
/** The overview as the owner sees it (the charts load lazily, so they are not part of this markup). */
function screen(data: FinanceSummary, currency: 'IQD' | 'USD' = 'IQD', lang: 'ar' | 'en' | 'ckb' = 'ar') {
  LANG = lang;
  try {
    return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: currency },
      createElement(Overview, { data, from: '2026-11-01', to: '2026-11-11', revision: 0, openOrder: noop, onNavigate: noop, onCollections: noop, onMissing: noop }))));
  } finally { LANG = 'ar'; }
}
/** The note under «صافي حصتك»: the primary tile's own <small> (the accounting value's carries a class). */
const headlineNote = (html: string) => /fw-metric--primary[\s\S]*?<small>([^<]*)<\/small>/.exec(html)?.[1] ?? '';
/** One row of the overview, from its label to the end of its button. */
const rowOf = (html: string, label: string) => { const at = html.indexOf(`class="fw-row-label">${label}`); assert.ok(at >= 0, `the row «${label}»`); return html.slice(at, html.indexOf('</button>', at)); };

/** 1–11 Nov in shape: nine complete orders of thirteen; a 3,000 coupon on a confirmed order and 5,000 on an incomplete one. */
const period = () => summary({
  totals: { orders_count: 13, unknown_lines: 4, pending_costs: 0, owner_net_iqd: null, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null,
    coupon_iqd: 8000, price_protection_iqd: 0, trade_in_credit_returned_iqd: 0, investor_iqd: null, collected_iqd: 0, collection_difference_iqd: 2000000 },
  known: { orders_count: 9, incomplete_orders: 4, revenue_iqd: 4847211, cost_iqd: 3678427, owner_net_iqd: 1168784, net_after_report_adjustments_iqd: 1165784, overhead_share_iqd: 0,
    confirmed: { orders_count: 3, revenue_iqd: 3310000, owner_net_iqd: 784859, net_after_report_adjustments_iqd: 781859 },
    estimated: { orders_count: 6, revenue_iqd: 1537211, owner_net_iqd: 383925, net_after_report_adjustments_iqd: 383925 } },
  display_usd: { available: true, at_time_count: 13, today_count: 0, totals: { owner_period_net_cents: null, owner_period_net_after_report_adjustments_cents: null, coupon_cents: 533, price_protection_cents: 0, trade_in_credit_returned_cents: 0, investor_cents: null },
    known: { revenue_cents: 323147, cost_cents: 245228, owner_net_cents: 77919, net_after_report_adjustments_cents: 77719,
      confirmed: { orders_count: 3, owner_net_cents: 52324, net_after_report_adjustments_cents: 52124 }, estimated: { orders_count: 6, owner_net_cents: 25595, net_after_report_adjustments_cents: 25595 } },
    chart: { revenue_cents: 466511, cost_cents: null, owner_net_cents: null, investor_cents: null, daily: {}, expense_composition: [] } },
});

test('the overview: the note under «صافي حصتك» names the complete orders\' own deductions, and in dollars every amount in it is dollars (review R2, nit)', () => {
  const iqd = headlineNote(screen(period()));
  assert.match(iqd, /مؤكد 781,859 د\.ع \(3\)/);
  assert.match(iqd, /من طلبات فيها تكلفة تقديرية 383,925 د\.ع \(6\)/);
  assert.match(iqd, /−3,000 د\.ع/, 'the confirmed order\'s coupon came off the headline');
  assert.doesNotMatch(iqd, /8,000/, 'the incomplete order\'s coupon did not');
  const usd = headlineNote(screen(period(), 'USD'));
  assert.match(usd, /مؤكد \$521\.24 \(3\)/);
  assert.match(usd, /من طلبات فيها تكلفة تقديرية \$255\.95 \(6\)/);
  assert.match(usd, /−\$2\.00/);
  assert.doesNotMatch(usd, /د\.ع/, 'no dinars beside a dollar headline');
  // A server without the parts' cents: the dollar note names the parts and leaves their amounts out.
  const older = period(); delete older.display_usd!.known!.confirmed; delete older.display_usd!.known!.estimated;
  const bare = headlineNote(screen(older, 'USD'));
  assert.match(bare, /مؤكد \(3\) · من طلبات فيها تكلفة تقديرية \(6\)/);
  assert.doesNotMatch(bare, /د\.ع/);
});

test('the overview: no margin is a bare «—»; a waiting investor share says «ينتظر» on both its rows (review nits)', () => {
  const html = screen(summary({ totals: { orders_count: 2, unknown_lines: 1, owner_net_iqd: null, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null, investor_iqd: null } }));
  const note = headlineNote(html);
  assert.doesNotMatch(note, /هامش حصتك|—/, `no net, no margin to name: «${note}»`);
  for (const label of ['حصة المستثمرين', 'حصص المستثمرين']) {
    const row = rowOf(html, label);
    assert.match(row, /data-finance-missing[^>]*>ينتظر</, `«${label}» waits`);
    assert.doesNotMatch(row, />ناقص</, `«${label}» is not «ناقص» on one row and «ينتظر» on the other`);
  }
  assert.match(headlineNote(screen(period())), /هامش حصتك 24\.1%/, 'with a net, the margin over the complete orders\' revenue');
});

test('the overview: money due and not recorded yet is named for what it holds — paid on delivery or by Gini — in Arabic, English and Sorani (review nit)', () => {
  const words = { ar: ['مستحق لم يُسجَّل استلامه', 'ليس عجزًا: مبالغ الدفع عند التسليم أو من Gini'], en: ['Due, not recorded as received yet', 'on delivery or by Gini'], ckb: ['ماوە، هێشتا وەک وەرگیراو تۆمار نەکراوە', 'یان لە لایەن Gini'] } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = screen(period(), 'IQD', lang);
    for (const text of words[lang]) assert.ok(html.includes(text), `${lang}: «${text}»`);
    assert.doesNotMatch(html, /عند التسليم ولم يُسجَّل استلامه|Due on delivery, not recorded yet|cash-on-delivery amounts whose arrival/, `${lang}: the old words, which left Gini out`);
  }
  // On a phone a long hint beside a figure squeezed it until it split inside its digits («5,664,6» / «67 د.ع», in English
  // since step 1 and in Sorani with these words; the screens showed it). The figure keeps its digits together: the
  // value column never shrinks below them, and the figure may break only between the number and «د.ع».
  const css = readFileSync(join(ROOT, 'src/components/financeWorkspace/finance-workspace.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media(max-width:600px)'));
  const rule = (selector: string) => new RegExp(`[{}]${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(phone)?.[1];
  assert.notEqual(rule('.fw-row-value'), undefined);
  assert.doesNotMatch(rule('.fw-row-value')!, /min-width:0/, 'the value column never shrinks below its figure');
  assert.match(rule('.fw-row-value .fw-money,.fw-sheet-footer .fw-money') ?? '', /overflow-wrap:normal/, 'a figure breaks only between the number and its currency');
});

test('the overview\'s tables say «ناقص» for an incomplete amount, never a bare dash, in dinars and dollars (review nit)', () => {
  const data = summary({
    chart_data: { revenue_iqd: 55000, cost_iqd: null, owner_net_iqd: null, investor_iqd: 0, orders_count: 1, unknown_lines: 1, pending_costs: 1, basis: 'delivered_baghdad_day',
      daily: [{ day: '2026-11-02', revenue_iqd: 55000, cost_iqd: null, owner_net_iqd: null, investor_iqd: 0, orders_count: 1, unknown_lines: 1, pending_costs: 1 }],
      expense_composition: [{ key: 'goods', amount_iqd: null }, { key: 'wages', amount_iqd: null }, { key: 'delivery', amount_iqd: 0 }, { key: 'general', amount_iqd: 4000 }] } as unknown as FinanceSummary['chart_data'],
    categories: [{ id: 'printers', name: 'الطابعات', level: 'main', qty: 1, owner_net_iqd: null }] as FinanceSummary['categories'],
  });
  const usd = { available: true, categories: { main: { printers: { owner_net_cents: null } }, sub: {} },
    chart: { revenue_cents: 3667, cost_cents: null, owner_net_cents: null, investor_cents: 0, daily: { '2026-11-02': { revenue_cents: 3667, cost_cents: null, owner_net_cents: null, investor_cents: 0 } },
      expense_composition: [{ key: 'goods', amount_cents: null }, { key: 'wages', amount_cents: null }, { key: 'delivery', amount_cents: 0 }, { key: 'general', amount_cents: 267 }] } } as DisplayUsdSummary;
  for (const [currency, u] of [['IQD', undefined], ['USD', usd]] as const) {
    LANG = 'ar';
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(OverviewCharts, { data, usd: u })));
    const cells = [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    assert.ok(cells.length > 0, currency);
    for (const cell of cells) assert.doesNotMatch(cell, /^—$|>—</, `${currency}: a table cell is a bare dash: ${cell}`);
    // The goods and the wages of the cost table, the day's cost and net, and the section's net.
    assert.equal(cells.filter((cell) => /data-finance-missing[^>]*>ناقص</.test(cell)).length, 5, `${currency}: every incomplete amount says «ناقص»`);
  }
});

test('the workspace opens on «هذا الشهر حتى اليوم», the range it shows; the wage row says when wages still wait for their cost (review coverage)', () => {
  LANG = 'ar';
  const workspace = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(FinanceWorkspace)));
  assert.match(workspace, /<option value="month" selected="[^"]*">هذا الشهر حتى اليوم<\/option>/, 'not «فترة مخصصة» for the month so far');
  const waiting = screen(summary({ totals: { orders_count: 2, pending_costs: 2, wages_iqd: 7500 } }));
  assert.match(rowOf(waiting, 'أجور الموظفين'), /لا يشمل أجورًا تنتظر تكلفتها \(2\)/);
  assert.doesNotMatch(rowOf(screen(summary({ totals: { orders_count: 2, pending_costs: 0, wages_iqd: 7500 } })), 'أجور الموظفين'), /تنتظر تكلفتها/);
});
