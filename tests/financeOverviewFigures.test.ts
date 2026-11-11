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
 * The independent review of steps 2–3 (2026-11-11): every figure resting on a sale-time estimate
 * says so (the gross card, the statement's head, «تقديري» on a product); a change across zero is
 * words, not a percentage; a net still missing is a partial comparison; a product sold at 0 has
 * «بلا مبيعات» for a margin; and the net-sales sparkline is net sales by day.
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
import { FW } from '../src/components/financeWorkspace/overviewStrings';
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
const { default: FinanceWorkspace } = await import('../src/components/financeWorkspace/FinanceWorkspace');
const { default: Overview } = await import('../src/components/financeWorkspace/Overview');

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
  // So every caller that draws dollars passes the credit's cents beside the coupon's and the price protection's: the product rows
  // and the order sheet. Since step 3 the period's deductions are a row of the overview's statement, the credit in it in both currencies.
  const calls = ['FinanceWorkspace.tsx', 'OrderProfitSheet.tsx', 'Overview.tsx']
    .flatMap((file) => codeOf(`src/components/financeWorkspace/${file}`).split('\n').filter((line) => line.includes('<ReportDeductions ')));
  assert.equal(calls.length, 2, 'the product rows and the order sheet');
  for (const call of calls) assert.match(call, /tradeIn: \w+\('trade_in_credit_returned_iqd'\)/, call.trim().slice(0, 160));
  assert.match(codeOf('src/components/financeWorkspace/statement.ts'), /case 'deductions': return add\(v\('coupon_iqd'\), v\('price_protection_iqd'\), t\.trade_in_credit_returned_iqd \?\? 0\);/);
});

test('the note under «صافي حصتك» names the complete orders in Arabic, English and real Sorani; no Sorani on the screen is the Arabic', () => {
  const ARABIC_ONLY = /[ةىيك]/, SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
  // Since step 3 the overview's words are one table (overviewStrings.ts); the note's are these.
  assert.match(FW.knownNote[0], /^من الطلبات المكتملة فقط /);
  assert.equal(FW.overheadNote[0], '، مع حصتها من المصاريف العامة بنسبة إيرادها');
  for (const key of ['knownNote', 'overheadNote', 'confirmedPart', 'estimatedPart', 'deducted', 'shareMargin'] as const) {
    const [ar, en, ckb] = FW[key];
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: the English is English`);
    assert.notEqual(ckb, ar, key);
    assert.match(ckb, SORANI_ONLY, ckb);
    assert.doesNotMatch(ckb, ARABIC_ONLY, ckb);
  }
  const workspace = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  const overview = [workspace, codeOf('src/components/financeWorkspace/Overview.tsx'), codeOf('src/components/financeWorkspace/displayCurrency.tsx')].join('\n');
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
/** The overview as the owner sees it, on its first render (the payouts it reads after mounting say they are loading). */
function screen(data: FinanceSummary, currency: 'IQD' | 'USD' = 'IQD', lang: 'ar' | 'en' | 'ckb' = 'ar', prev: FinanceSummary | null = null) {
  LANG = lang;
  try {
    return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: currency },
      createElement(Overview, { data, prev, compareFrom: prev ? '2026-10-01' : undefined, compareTo: prev ? '2026-10-11' : undefined, openOrder: noop, onNavigate: noop, onCollections: noop, onMissing: noop }))));
  } finally { LANG = 'ar'; }
}
/** One card of the overview, from its label to the next card. */
const cardOf = (html: string, key: string) => { const at = html.indexOf(`data-finance-kpi="${key}"`); assert.ok(at >= 0, `the card ${key}`); const next = html.indexOf('data-finance-kpi=', at + 20), end = next < 0 ? html.indexOf('class="fw-grid', at) : next; return html.slice(at, end); };
/** The notes under «صافي حصتك»: the card's own <small>s (the accounting value's carries a class). */
const headlineNote = (html: string) => [...cardOf(html, 'netShare').matchAll(/<small>([^<]*)<\/small>/g)].map((m) => m[1]).join(' · ');
/** One row of the statement, label and cells. */
const rowOf = (html: string, key: string) => { const m = new RegExp(`<tr[^>]*data-key="${key}">([\\s\\S]*?)</tr>`).exec(html); assert.ok(m, `the statement row ${key}`); return m[1]; };
const chips = (html: string, word: string) => (html.match(new RegExp(`data-finance-missing="true">${word}<`, 'g')) ?? []).length;

/** 1–11 Nov in shape: nine complete orders of thirteen; a 3,000 coupon on a confirmed order and 5,000 on an incomplete one. */
const period = () => summary({
  totals: { orders_count: 13, unknown_lines: 4, pending_costs: 0, owner_net_iqd: null, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null,
    coupon_iqd: 8000, price_protection_iqd: 0, trade_in_credit_returned_iqd: 0, investor_iqd: null, collected_iqd: 0, collection_difference_iqd: 2000000 },
  known: { orders_count: 9, incomplete_orders: 4, revenue_iqd: 4847211, cost_iqd: 3678427, owner_net_iqd: 1168784, net_after_report_adjustments_iqd: 1165784, overhead_share_iqd: 0,
    confirmed: { orders_count: 3, revenue_iqd: 3310000, owner_net_iqd: 784859, net_after_report_adjustments_iqd: 781859 },
    estimated: { orders_count: 6, revenue_iqd: 1537211, owner_net_iqd: 383925, net_after_report_adjustments_iqd: 383925 } },
  display_usd: { available: true, at_time_count: 13, today_count: 0, totals: { owner_period_net_cents: null, owner_period_net_after_report_adjustments_cents: null, coupon_cents: 533, price_protection_cents: 0, trade_in_credit_returned_cents: 0, investor_cents: null, collected_cents: 0, collection_difference_cents: 133333 },
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
  assert.match(iqd, /من الطلبات المكتملة فقط \(9\/13\)/, 'and the basis of the figure is printed with it');
  const usdHtml = screen(period(), 'USD'), usd = headlineNote(usdHtml);
  assert.match(usd, /مؤكد \$521\.24 \(3\)/);
  assert.match(usd, /من طلبات فيها تكلفة تقديرية \$255\.95 \(6\)/);
  assert.match(usd, /−\$2\.00/);
  assert.doesNotMatch(usd, /د\.ع/, 'no dinars beside a dollar headline');
  // The other cards' notes too: the average order is the server's cents.
  assert.match(cardOf(usdHtml, 'deliveredOrders'), /متوسط الطلب \$358\.85/);
  assert.doesNotMatch(cardOf(usdHtml, 'deliveredOrders'), /د\.ع/);
  // A server without the parts' cents: the dollar note names the parts and leaves their amounts out.
  const older = period(); delete older.display_usd!.known!.confirmed; delete older.display_usd!.known!.estimated;
  const bare = headlineNote(screen(older, 'USD'));
  assert.match(bare, /مؤكد \(3\) · من طلبات فيها تكلفة تقديرية \(6\)/);
  assert.doesNotMatch(bare, /د\.ع/);
});

test('the overview: no margin is a bare «—»; a waiting investor share says «ينتظر», not «ناقص» (review nits)', () => {
  const html = screen(summary({ totals: { orders_count: 2, unknown_lines: 1, owner_net_iqd: null, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null, investor_iqd: null } }));
  const note = headlineNote(html);
  assert.doesNotMatch(note, /هامش حصتك|—/, `no net, no margin to name: «${note}»`);
  const investor = rowOf(html, 'investor');
  assert.match(investor, /data-finance-missing="true">ينتظر</, 'the investor share waits');
  assert.doesNotMatch(investor, />ناقص</);
  assert.match(headlineNote(screen(period())), /هامش حصتك 24\.1%/, 'with a net, the margin over the complete orders\' revenue');
});

test('the overview: money due and not recorded yet is named for what it holds — paid on delivery or by Gini — in Arabic, English and Sorani (review nit)', () => {
  const words = { ar: ['مستحق لم يُسجَّل استلامه', 'ليس عجزًا: مبالغ الدفع عند التسليم أو من Gini', 'مستحق عند التسليم أو من Gini'], en: ['Due, not recorded as received yet', 'on delivery or by Gini', 'Due on delivery or from Gini'],
    ckb: ['ماوە، هێشتا وەک وەرگیراو تۆمار نەکراوە', 'یان لە لایەن Gini', 'ماوە لە کاتی گەیاندن یان لە Gini'] } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = screen(period(), 'IQD', lang);
    for (const text of words[lang]) assert.ok(html.includes(text), `${lang}: «${text}»`);
    assert.doesNotMatch(html, /عند التسليم ولم يُسجَّل استلامه|Due on delivery, not recorded yet|cash-on-delivery amounts whose arrival|يُحصَّل عند التسليم/, `${lang}: the old words, which left Gini out`);
  }
  // The cash card adds the server's two figures and nothing else: due = recorded + not recorded yet.
  const cash = /data-finance-cash="true">([\s\S]*?)<\/dl>/.exec(screen(period()))![1];
  assert.deepEqual([...cash.matchAll(/>([\d,]+) د\.ع</g)].map((m) => m[1]), ['2,000,000', '0', '2,000,000']);
  // On a phone a long hint beside a figure squeezed it until it split inside its digits («5,664,6» / «67 د.ع»; the screens showed
  // it). The rows that remain keep the figure whole: the value column never shrinks below it, and it breaks only before «د.ع».
  const css = readFileSync(join(ROOT, 'src/components/financeWorkspace/finance-workspace.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media(max-width:600px)'));
  const rule = (selector: string) => new RegExp(`[{}]${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(phone)?.[1];
  assert.notEqual(rule('.fw-row-value'), undefined);
  assert.doesNotMatch(rule('.fw-row-value')!, /min-width:0/, 'the value column never shrinks below its figure');
  assert.match(rule('.fw-row-value .fw-money,.fw-sheet-footer .fw-money') ?? '', /overflow-wrap:normal/, 'a figure breaks only between the number and its currency');
});

test('the overview\'s tables say «ناقص» or «ينتظر» for an incomplete amount, never a bare dash, in dinars and dollars (review nit)', () => {
  const data = summary({
    totals: { orders_count: 1, unknown_lines: 1, pending_costs: 1, retained_revenue_iqd: 55000, cogs_iqd: null, gross_profit_iqd: null, shipping_income_iqd: 5000, cod_tax_iqd: 0, direct_cost_iqd: 0, wages_iqd: 0, materials_iqd: 0,
      manual_direct_iqd: 0, courier_fee_iqd: 0, payment_fee_iqd: 0, promotion_iqd: 1500, investor_iqd: 0, owner_net_iqd: null, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null,
      coupon_iqd: 0, price_protection_iqd: 0, trade_in_credit_returned_iqd: 0, general_expenses_iqd: 4000 },
    products: [{ id: 'magnet', name: 'Magnet', qty: 60, retained_revenue_iqd: 55000, gross_profit_iqd: null }, { id: 'printer', name: 'Printer', qty: 1, retained_revenue_iqd: 100000, gross_profit_iqd: 25000 }] as FinanceSummary['products'],
    display_usd: { available: true, totals: { retained_revenue_cents: 3667, cogs_cents: null, gross_profit_cents: null, shipping_income_cents: 333, cod_tax_cents: 0, direct_cost_cents: 0, wages_cents: 0, materials_cents: 0,
      manual_direct_cents: 0, courier_fee_cents: 0, payment_fee_cents: 0, promotion_cents: 100, investor_cents: 0, coupon_cents: 0, price_protection_cents: 0, trade_in_credit_returned_cents: 0,
      general_expenses_cents: 267, unallocated_promotion_cents: 0, owner_period_net_cents: null, owner_period_net_after_report_adjustments_cents: null },
      products: { magnet: { retained_revenue_cents: 3667, gross_profit_cents: null }, printer: { retained_revenue_cents: 6667, gross_profit_cents: 1667 } } } as DisplayUsdSummary,
  });
  for (const currency of ['IQD', 'USD'] as const) {
    const html = screen(data, currency);
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).join('');
    const cells = [...tables.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    assert.ok(cells.length > 15, currency);
    for (const c of cells) assert.doesNotMatch(c, /^—$|>—</, `${currency}: a table cell is a bare dash: ${c}`);
    // The statement: the goods cost, the gross and the net are missing; the wages and the materials wait for the cost a wage
    // waits for (a waiting cost is in neither sum yet). The products: the magnets' gross profit and margin.
    assert.equal(chips(tables, 'ناقص'), 5, `${currency}: every incomplete amount says «ناقص»`);
    assert.equal(chips(tables, 'ينتظر'), 2, `${currency}: what waits for a cost says «ينتظر»`);
    assert.match(rowOf(html, 'materials'), /data-finance-missing="true">ينتظر</);
    assert.match(rowOf(html, 'sales'), currency === 'USD' ? /\$36\.67/ : /55,000 د\.ع/, `${currency}: a known amount is drawn`);
  }
  assert.match(screen(data, 'USD'), /data-finance-statement="USD"/, 'in dollars the statement is the server\'s cents');
});

test('the workspace opens on «هذا الشهر حتى اليوم», the range it shows; the wage row says when wages still wait for their cost (review coverage)', () => {
  LANG = 'ar';
  const workspace = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(FinanceWorkspace)));
  assert.match(workspace, /<option value="month" selected="[^"]*">هذا الشهر حتى اليوم<\/option>/, 'not «فترة مخصصة» for the month so far');
  const waiting = screen(summary({ totals: { orders_count: 2, pending_costs: 2, wages_iqd: 7500 } }));
  assert.match(rowOf(waiting, 'wages'), /أجور تنتظر تكلفتها: 2/);
  assert.match(rowOf(waiting, 'wages'), /data-finance-missing="true">ينتظر</, 'and the period\'s wages are not shown as known');
  const paid = rowOf(screen(summary({ totals: { orders_count: 2, pending_costs: 0, wages_iqd: 7500 } })), 'wages');
  assert.doesNotMatch(paid, /تنتظر تكلفتها/);
  assert.match(paid, /7,500 د\.ع/);
});

test('the overview, top to bottom: how much is calculated and what the rest waits for, the cards against the comparison, what needs the owner, the statement (redesign step 3)', () => {
  const data = period();
  data.totals = { ...data.totals, retained_revenue_iqd: 6858667, gross_profit_iqd: null, units: 166, general_expenses_iqd: 0 };
  data.known = { ...data.known!, totals: { retained_revenue_iqd: 4813000, gross_profit_iqd: 1176000 } };
  data.waiting = { orders_count: 4, totals: {}, reasons: { no_price: ['a', 'b'], wage_waits_cost: ['c'], investor_waits: ['ORD-X2D'] }, general_share_iqd: 0, unallocated_share_iqd: 0 };
  data.missing_costs = { lines: 19, orders: 9, unknown_lines: 4, estimated_lines: 15, unknown_products: [] };
  data.orders = [{ id: 'ORD-X2D', order_id: 'ORD-X2D', status: 'delivered', created_at: '2026-11-03', cost_confidence: 'verified', collection_difference_iqd: 2000000 }] as FinanceSummary['orders'];
  const prev = summary({ totals: { orders_count: 33, retained_revenue_iqd: 19685330, gross_profit_iqd: 6000000, owner_period_net_iqd: 6338187, owner_period_net_after_report_adjustments_iqd: 6338187 } });
  const html = screen(data, 'IQD', 'ar', prev);
  // The banner counts, never implies: 9 of 13, 3 confirmed, 6 on estimates, 4 waiting and for what.
  const banner = /data-finance-completeness="waiting"[\s\S]*?<\/button><\/div>/.exec(html)?.[0] ?? '';
  assert.match(banner, /الطلبات المحسوبة: 9 من 13/);
  assert.match(banner, /سعر شراء \(2\)، أجر ينتظر تثبيت التكلفة \(1\)، حصة مستثمر تنتظر تسجيل النقد أو تثبيت التكلفة \(1\)/);
  assert.match(banner, /مؤكد 3[\s\S]*تقديري 6[\s\S]*ينتظر 4/);
  assert.match(banner, /أكمل التكاليف الناقصة \(19\)/);
  // Like with like: sales against sales; a gross or a net from complete orders only is a partial comparison, with no figure.
  assert.match(cardOf(html, 'netSales'), /data-finance-delta="-0\.65[\d]*"[^>]*>[\s\S]*▼[\s\S]*65\.2%[\s\S]*عن 1–11 تشرين الأول 2026/);
  assert.match(cardOf(html, 'grossProfit'), /data-finance-delta="partial"[^>]*>مقارنة جزئية</);
  assert.match(cardOf(html, 'netShare'), /data-finance-delta="partial"/);
  assert.match(cardOf(html, 'deliveredOrders'), /▼[\s\S]*60\.6%/);
  assert.match(cardOf(html, 'grossProfit'), /1,176,000 د\.ع[\s\S]*هامش 24\.4%[\s\S]*من الطلبات المكتملة فقط \(9\/13\)/, 'the gross of the complete orders, over their own sales');
  // What waits for the owner, each with its button: the costs first, then the cash, the investor share, the missing rent.
  assert.deepEqual([...html.matchAll(/data-finance-attention-item="(\w+)"/g)].map((m) => m[1]), ['costs', 'cash', 'investor', 'expenses']);
  assert.match(html, /2,000,000 د\.ع مستحق لم يُسجَّل استلامه · طلبات: 1/);
  // The statement shows the three columns, «محسوبة» first on a phone, its head naming the six on sale-time estimates (owner decision 3).
  assert.match(html, /data-phone-col="0"/);
  assert.deepEqual([...html.matchAll(/<th scope="col" data-col="(\d)">([^<]*)</g)].map((m) => m[2]), ['محسوبة (9 · تقديرية: 6)', 'تنتظر (4)', 'الفترة (13)']);
  // So does the gross card: its figure rests on them too (independent review, 2026-11-11).
  assert.match(cardOf(html, 'grossProfit'), /<small>طلبات بتكلفة تقديرية: 6<\/small>/);
  // The payouts are read after the screen mounts; until then they say so.
  assert.match(html, /تحميل المستحقات…/);
});

test('every figure resting on a sale-time estimate says so; a change across zero is no percentage; a net still missing is a partial comparison (independent review, 2026-11-11)', () => {
  // The products: a margin whose goods cost is the sale-time estimate carries «تقديري» and the note says what that means;
  // a product sold at 0 (a gift) has «بلا مبيعات» for a margin, never an empty cell.
  const data = summary({ totals: { orders_count: 3, retained_revenue_iqd: 158000, gross_profit_iqd: 60000 },
    products: [{ id: 'switch', name: 'Levo Switch', qty: 87, retained_revenue_iqd: 10527, gross_profit_iqd: 6039, estimated_lines: 2 }, { id: 'a2l', name: 'A2L', qty: 1, retained_revenue_iqd: 147473, gross_profit_iqd: 56000, estimated_lines: 0 },
      { id: 'gift', name: 'Gift sticker', qty: 1, retained_revenue_iqd: 0, gross_profit_iqd: -2039 }] as FinanceSummary['products'],
    missing_costs: { lines: 2, orders: 1, unknown_lines: 0, estimated_lines: 2, unknown_products: [] } });
  const html = screen(data);
  const table = /data-finance-top-products[\s\S]*?<\/table>/.exec(html)![0];
  assert.match(table, /data-finance-estimated="true"><th scope="row">Levo Switch <span class="fw-status fw-status--warning">تقديري<\/span>/);
  assert.equal((table.match(/data-finance-estimated/g) ?? []).length, 1, 'only the product with an estimated line');
  assert.match(html, /«تقديري»: تكلفة بضاعته كلها أو بعضها تقدير وقت البيع/);
  assert.match(table, /<th scope="row">Gift sticker<\/th>[\s\S]*?<td>بلا مبيعات<\/td>/);
  // The gross card of a period whose every gross is known: how many orders rest on the estimate (the missing-costs count, no unknown line).
  assert.match(cardOf(html, 'grossProfit'), /<small>طلبات بتكلفة تقديرية: 1<\/small>/);
  assert.match(cardOf(screen(data, 'IQD', 'ckb'), 'grossProfit'), /داواکاری بە تێچووی خەمڵێنراو: 1/);
  // A net that turned from a loss into a profit: no «▲10100.0%», but the words.
  const now = summary({ totals: { orders_count: 5, owner_period_net_iqd: 1000000, owner_period_net_after_report_adjustments_iqd: 1000000, retained_revenue_iqd: 4000000 } });
  const lost = summary({ totals: { orders_count: 0, owner_period_net_iqd: -10000, owner_period_net_after_report_adjustments_iqd: -10000, retained_revenue_iqd: 0 } });
  const flip = cardOf(screen(now, 'IQD', 'ar', lost), 'netShare');
  assert.match(flip, /data-finance-delta="loss-to-profit"[^>]*>[\s\S]*من خسارة إلى ربح/);
  assert.doesNotMatch(flip, /%<\/bdi>/);
  // A net still missing this period against a complete one: «مقارنة جزئية», not «لا شيء للمقارنة».
  const missing = summary({ totals: { orders_count: 3, unknown_lines: 1, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null } });
  assert.match(cardOf(screen(missing, 'IQD', 'ar', lost), 'netShare'), /data-finance-delta="partial"/);
});

test('the net-sales sparkline is net sales day by day, from the orders by Baghdad delivery day, not the revenue with delivery the curve shows (independent review nit)', () => {
  const daily = ['2026-11-01', '2026-11-02', '2026-11-03'].map((day) => ({ day, revenue_iqd: day === '2026-11-03' ? 5000 : 0, cost_iqd: null, owner_net_iqd: null, investor_iqd: null, orders_count: 0, unknown_lines: 0, pending_costs: 0 }));
  // One order delivered on 1 Nov at 23:30 Baghdad (20:30 UTC) with 100,000 of goods; 3 Nov has only a delivery fee.
  const data = summary({ chart_data: { daily } as unknown as FinanceSummary['chart_data'], totals: { orders_count: 1, retained_revenue_iqd: 100000 },
    orders: [{ id: 'o', order_id: 'o', status: 'delivered', created_at: '2026-11-01T20:00:00Z', delivered_at: '2026-11-01T20:30:00Z', retained_revenue_iqd: 100000 }] as FinanceSummary['orders'] });
  const spark = /data-finance-kpi="netSales"[\s\S]*?<svg class="fw-spark"[\s\S]*?<\/svg>/.exec(screen(data))![0];
  const points = /<polyline points="([^"]*)" style="fill:none/.exec(spark)![1].split(' ').map((p) => Number(p.split(',')[1]));
  assert.deepEqual(points.map((y) => y < 10), [true, false, false], 'the peak is the first day\'s sales; the third day\'s delivery fee is not a sale');
});
