/**
 * «المال والأرباح» — THE NEW FRAME AND OVERVIEW, AS DATA AND WORDS (redesign steps 2–3,
 * owner 2026-11-11; DECISIONS row 315).
 *
 * The pure parts the screens stand on, each pinned here:
 *   · what a period is compared with (compare.ts): the same days one month earlier, clamped
 *     to the shorter month, or the period of the same length just before;
 *   · the statement «من المبيعات إلى حصتك» (statement.ts): every column adds up to its net,
 *     the waiting column says what it lacks instead of 0, and in dollars the cells are the
 *     server's cents — falling back to dinars for a server that predates them;
 *   · every word of the frame and the overview (overviewStrings.ts) in Arabic, English and
 *     real Sorani, never the Arabic pasted into the Sorani slot (DECISIONS row 183);
 *   · the frame itself: five sections, every old `finance=` link opening its page, and a
 *     period bar that asks for dates only for a custom range;
 *   · what the frame remembers (frameState.ts), driven as the screen drives it — the independent
 *     review's two blockers: a failed read of a new period or currency leaves no figures of
 *     another under its dates, and a page kept hidden is read afresh after a save anywhere, a
 *     refresh, another period or currency, or two minutes away — and the review's edges: a
 *     year-long comparison the server still answers, a change across zero, the statement's
 *     columns with no orders in them, a negative investor share, a dinar hint among dollars,
 *     a period with no revenue, and the payouts once the people are read.
 * The hold of a hidden page is run in React in tests/freshOnReturnHold.test.ts. The server's half (known.totals, waiting) is in tests/financeFigures.test.ts; the overview
 * drawn end to end is in tests/financeOverviewFigures.test.ts.
 *
 * The workspace imports its stylesheet; node has no CSS loader, so a resolve hook answers
 * `.css` with an empty module before the import (as tests/financeOverviewFigures.test.ts).
 *
 * Run: node --import tsx --test tests/financeOverviewScreen.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { change, compareRange, defaultCompare, MAX_SPAN_DAYS, monthEarlier, signFlip } from '../src/components/financeWorkspace/compare';
import { statementAddsUp, statementColumns, statementRows, type StatementRow } from '../src/components/financeWorkspace/statement';
import { comparisonFor, KEEP_MS, keepKey, keptPages, missingBadge, navigate, NO_SUMMARY, NOTHING_KEPT, pageMount, summaryKey, summaryReducer, summaryShown } from '../src/components/financeWorkspace/frameState';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import { validFinanceRange } from '../src/components/financeWorkspace/types';
import { FW, fw, rangeText } from '../src/components/financeWorkspace/overviewStrings';
import type { DisplayUsdSummary, FinanceSummary, ProfitTotals } from '../src/components/financeWorkspace/types';
import { LanguageProvider } from '../src/LanguageContext';
import { codeOf } from './fixtures/source';

let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
  return next(specifier, context);
}`));
const { default: FinanceWorkspace } = await import('../src/components/financeWorkspace/FinanceWorkspace');
const { Attention, Curve, niceStep, Payouts, Statement } = await import('../src/components/financeWorkspace/Overview');
type People = import('../src/components/financeWorkspace/Overview').People;

const ARABIC = /[؀-ۿ]/, ARABIC_ONLY = /[ةىيك]/, SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;

// ------------------------------------------------------------------ compare.ts
test('the same days last month: the end clamps to the shorter month, a leap February too, and January looks back to December', () => {
  assert.equal(monthEarlier('2026-11-11'), '2026-10-11');
  assert.equal(monthEarlier('2026-03-31'), '2026-02-28');
  assert.equal(monthEarlier('2024-03-31'), '2024-02-29', 'a leap year keeps the 29th');
  assert.equal(monthEarlier('2026-05-31'), '2026-04-30');
  assert.equal(monthEarlier('2026-01-15'), '2025-12-15');
  assert.deepEqual(compareRange({ from: '2026-11-01', to: '2026-11-11' }, 'month'), { from: '2026-10-01', to: '2026-10-11' }, '1–11 Nov against 1–11 Oct');
  // The clamp never turns a range around: the last days of March all fall on the last of February.
  assert.deepEqual(compareRange({ from: '2026-03-29', to: '2026-03-31' }, 'month'), { from: '2026-02-28', to: '2026-02-28' });
  assert.deepEqual(compareRange({ from: '2026-10-15', to: '2026-11-14' }, 'month'), { from: '2026-09-15', to: '2026-10-14' });
});

test('the previous period has the same length and ends the day before, across a month and a year; none is none', () => {
  assert.deepEqual(compareRange({ from: '2026-11-01', to: '2026-11-11' }, 'previous'), { from: '2026-10-21', to: '2026-10-31' }, 'eleven days before the first');
  assert.deepEqual(compareRange({ from: '2026-01-01', to: '2026-01-10' }, 'previous'), { from: '2025-12-22', to: '2025-12-31' });
  assert.deepEqual(compareRange({ from: '2026-03-01', to: '2026-03-01' }, 'previous'), { from: '2026-02-28', to: '2026-02-28' }, 'one day: the day before');
  const year = compareRange({ from: '2025-11-12', to: '2026-11-11' }, 'previous')!;
  assert.equal((Date.parse(year.to) - Date.parse(year.from)) / 86400000 + 1, 365, 'a year against the year before it');
  assert.equal(year.to, '2025-11-11');
  assert.equal(compareRange({ from: '2026-11-01', to: '2026-11-11' }, 'none'), null);
  // The default follows the period: inside one calendar month, the same days last month; otherwise the period before.
  assert.equal(defaultCompare({ from: '2026-11-01', to: '2026-11-11' }), 'month');
  assert.equal(defaultCompare({ from: '2026-10-15', to: '2026-11-14' }), 'previous');
  // The change is a share of the earlier figure; nothing to compare with is null, never 0% or ∞.
  assert.equal(change(110, 100), 0.1);
  assert.equal(change(50, -100), 1.5, 'a loss that shrank is a rise, over the loss\'s size');
  assert.equal(change(5, 0), null);
  assert.equal(change(null, 100), null);
  assert.equal(change(100, undefined), null);
});

// ------------------------------------------------------------------ statement.ts
const summary = (over: Partial<FinanceSummary>): FinanceSummary => ({ range: { from: '2026-11-01', to: '2026-11-11' }, orders: [], products: [], categories: [], exceptions: [], promotions: [], truncated: false,
  totals: {}, ...over }) as FinanceSummary;
const cell = (rows: StatementRow[], key: string, col: 0 | 1 | 2) => rows.find((r) => r.key === key)!.cells[col];
/** One order's figures as the server sums them: direct cost = wages + materials; basis − promotion − investor = owner net. */
const part = (o: { sales: number; cogs: number; ship: number; cod: number; wages: number; materials: number; manual: number; courier: number; payment: number; promo: number; investor: number; coupon: number; credit: number; tradeIn: number }): ProfitTotals => {
  const basis = o.sales - o.cogs + o.ship + o.cod - o.wages - o.materials - o.manual - o.courier - o.payment, owner = basis - o.promo - o.investor;
  return { retained_revenue_iqd: o.sales, cogs_iqd: o.cogs, gross_profit_iqd: o.sales - o.cogs, shipping_income_iqd: o.ship, cod_tax_iqd: o.cod, direct_cost_iqd: o.wages + o.materials, wages_iqd: o.wages,
    materials_iqd: o.materials, manual_direct_iqd: o.manual, courier_fee_iqd: o.courier, payment_fee_iqd: o.payment, promotion_iqd: o.promo, investor_iqd: o.investor, owner_net_iqd: owner,
    coupon_iqd: o.coupon, price_protection_iqd: o.credit, trade_in_credit_returned_iqd: o.tradeIn, net_after_report_adjustments_iqd: owner - o.coupon - o.credit - o.tradeIn, pending_costs: 0 };
};
const full = part({ sales: 1000000, cogs: 700000, ship: 10000, cod: 4000, wages: 7500, materials: 2000, manual: 1500, courier: 3000, payment: 1000, promo: 6000, investor: 25000, coupon: 3000, credit: 2000, tradeIn: 7000 });

test('a complete period: every term of the server\'s arithmetic in its order, and the rows add up to «صافي حصتك» after the overheads and every deduction', () => {
  const general = 10000, unallocated = 1500;
  const t = { ...full, general_expenses_iqd: general, unallocated_promotion_iqd: unallocated, owner_period_net_after_report_adjustments_iqd: full.net_after_report_adjustments_iqd! - general - unallocated, orders_count: 2 };
  const { rows, currency } = statementRows(summary({ totals: t, known: { orders_count: 2, incomplete_orders: 0, revenue_iqd: 1014000, cost_iqd: null, owner_net_iqd: null, totals: full, general_share_iqd: general, unallocated_share_iqd: unallocated,
    net_after_report_adjustments_iqd: t.owner_period_net_after_report_adjustments_iqd }, waiting: null }));
  assert.equal(currency, 'IQD');
  assert.deepEqual(rows.map((r) => `${r.sign}${r.key}`), ['sales', '−cogs', '=gross', '+delivery', '+cod', '−wages', '−materials', '−fees', '−promotion', '−investor', '−general', '−deductions', '=net']);
  assert.equal(cell(rows, 'materials', 2), 3500, 'the materials and the owner\'s manual direct cost');
  assert.equal(cell(rows, 'fees', 2), 4000, 'courier and payment fees');
  assert.equal(cell(rows, 'promotion', 2), 7500, 'the month\'s shares and the promotion no sale carried yet');
  assert.equal(cell(rows, 'deductions', 2), 12000, 'the coupon, the credited price protection and the returned trade-in credit');
  assert.equal(statementAddsUp(rows, 2), true);
  assert.equal(statementAddsUp(rows, 0), true, 'the calculated column is the whole period');
  assert.equal(cell(rows, 'net', 2), 1000000 - 700000 + 10000 + 4000 - 7500 - 3500 - 4000 - 7500 - 25000 - 10000 - 12000);
  // The check bites: a net that is not the sum of its terms, or a gross that is not sales − goods, is false.
  const off = rows.map((r) => (r.key === 'net' ? { ...r, cells: [r.cells[0], r.cells[1], r.cells[2]! + 1] as StatementRow['cells'] } : r));
  assert.equal(statementAddsUp(off, 2), false);
  const gross = rows.map((r) => (r.key === 'cogs' ? { ...r, cells: [r.cells[0], r.cells[1], r.cells[2]! + 1] as StatementRow['cells'] } : r));
  assert.equal(statementAddsUp(gross, 2), false);
});

test('while orders wait: the waiting column names what it lacks (no cell is a silent 0), a wage that waits for its cost leaves the column\'s wages unknown, and the calculated column still adds up', () => {
  const waitingTotals: ProfitTotals = { retained_revenue_iqd: 25530, cogs_iqd: null, gross_profit_iqd: null, shipping_income_iqd: 5000, cod_tax_iqd: 0, direct_cost_iqd: 0, wages_iqd: 0, materials_iqd: 0, manual_direct_iqd: 0,
    courier_fee_iqd: 0, payment_fee_iqd: 0, promotion_iqd: 900, investor_iqd: null, owner_net_iqd: null, coupon_iqd: 0, price_protection_iqd: 0, trade_in_credit_returned_iqd: 0, net_after_report_adjustments_iqd: null, pending_costs: 2 };
  const known = { orders_count: 9, incomplete_orders: 4, revenue_iqd: 1014000, cost_iqd: null, owner_net_iqd: full.owner_net_iqd! - 8000, net_after_report_adjustments_iqd: full.net_after_report_adjustments_iqd! - 8000,
    totals: full, general_share_iqd: 8000, unallocated_share_iqd: 0 };
  const data = summary({ totals: { ...full, cogs_iqd: null, gross_profit_iqd: null, investor_iqd: null, owner_net_iqd: null, owner_period_net_iqd: null, owner_period_net_after_report_adjustments_iqd: null, general_expenses_iqd: 10000, pending_costs: 2 },
    known, waiting: { orders_count: 4, totals: waitingTotals, reasons: { no_price: ['a', 'b'], wage_waits_cost: ['c'], investor_waits: ['d'] }, general_share_iqd: 2000, unallocated_share_iqd: 0 } });
  const { rows } = statementRows(data);
  assert.equal(statementAddsUp(rows, 0), true);
  assert.equal(cell(rows, 'net', 0), known.net_after_report_adjustments_iqd);
  assert.equal(cell(rows, 'general', 0)! + cell(rows, 'general', 1)!, 10000, 'the overhead, split by revenue, adds up to the period\'s');
  assert.deepEqual([cell(rows, 'cogs', 1), cell(rows, 'gross', 1), cell(rows, 'wages', 1), cell(rows, 'materials', 1), cell(rows, 'investor', 1), cell(rows, 'net', 1)], [null, null, null, null, null, null]);
  assert.equal(cell(rows, 'sales', 1), 25530, 'what is known of the waiting orders is shown');
  assert.equal(cell(rows, 'wages', 2), null, 'two wages wait for their cost: the period\'s wages are not known yet');
  assert.equal(statementAddsUp(rows, 1), null);
  assert.equal(statementAddsUp(rows, 2), null);
});

test('in dollars the cells are the server\'s cents — never a conversion — and «materials» is every direct cost that is not a wage, so the rows land on the net to the cent; an older server keeps dinars', () => {
  // 7,508 and 2,108 dinars at 1,500 are 501 and 141 cents, but their 9,616 is 641: each field is converted on its own.
  const cents = { retained_revenue_cents: 66667, cogs_cents: 46667, gross_profit_cents: 20000, shipping_income_cents: 333, cod_tax_cents: 0, direct_cost_cents: 641, wages_cents: 501, materials_cents: 141,
    manual_direct_cents: 100, courier_fee_cents: 0, payment_fee_cents: 0, promotion_cents: 400, investor_cents: 0, coupon_cents: 200, price_protection_cents: 0, trade_in_credit_returned_cents: 0 };
  const net = 20000 + 333 - 641 - 100 - 400 - 0;
  const totals = { ...cents, owner_net_cents: net, net_after_report_adjustments_cents: net - 200, general_expenses_cents: 667, unallocated_promotion_cents: 0, owner_period_net_after_report_adjustments_cents: net - 200 - 667 };
  const usd = { available: true, totals, known: { revenue_cents: 67000, cost_cents: null, owner_net_cents: null, totals: cents, general_share_cents: 667, unallocated_share_cents: 0, net_after_report_adjustments_cents: net - 200 - 667 }, waiting: null } as DisplayUsdSummary;
  const data = summary({ totals: { pending_costs: 0, orders_count: 1 }, known: { orders_count: 1, incomplete_orders: 0, revenue_iqd: 1, cost_iqd: null, owner_net_iqd: null, totals: { pending_costs: 0 } }, waiting: null });
  const { rows, currency } = statementRows(data, usd);
  assert.equal(currency, 'USD');
  assert.equal(cell(rows, 'materials', 2), 641 - 501 + 100, 'direct cost less wages, plus the manual cost — not 141 + 100');
  assert.equal(statementAddsUp(rows, 2), true, 'to the cent');
  assert.equal(statementAddsUp(rows, 0), true);
  // A server without the columns' cents: the statement stays in dinars rather than show a dollar column it does not have.
  const older = { ...usd, known: { revenue_cents: 67000, cost_cents: null, owner_net_cents: null } } as DisplayUsdSummary;
  assert.equal(statementRows(data, older).currency, 'IQD');
  assert.equal(statementRows(summary({ ...data, waiting: { orders_count: 1, totals: {}, reasons: {} } }), { ...usd, waiting: undefined } as DisplayUsdSummary).currency, 'IQD', 'nor a waiting column it has no cents for');
  assert.equal(statementRows(data).currency, 'IQD');
});

// ------------------------------------------------------------------ overviewStrings.ts
test('every word of the frame and the overview is in Arabic, English and real Sorani: no Sorani slot is the Arabic, no Arabic-only letter in it, the same placeholders in all three (DECISIONS row 183)', () => {
  const keys = Object.keys(FW) as Array<keyof typeof FW>;
  assert.ok(keys.length > 100, 'the whole table is read');
  for (const key of keys) {
    const [ar, en, ckb] = FW[key];
    assert.ok(ar && en && ckb, `${key}: a slot is empty`);
    assert.doesNotMatch(en.replace(/«[^»]*»/g, ''), ARABIC, `${key}: the English is English`);
    assert.match(ar, ARABIC, `${key}: the Arabic is Arabic`);
    assert.notEqual(ckb, ar, `${key}: the Sorani is the Arabic pasted across`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: «${ckb}» has a letter Sorani does not write`);
    if (ckb.replace(/\{\w+\}|[\d\s().,:·…/–-]/g, '').length > 4) assert.match(ckb, SORANI_ONLY, `${key}: «${ckb}» is not Sorani`);
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    assert.equal(holes(en), holes(ar), `${key}: English placeholders`);
    assert.equal(holes(ckb), holes(ar), `${key}: Sorani placeholders`);
  }
  // fw() fills the reader's language.
  const loc = (lang: 'ar' | 'en' | 'ckb') => (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k ?? a : a);
  assert.equal(fw(loc('ckb'), 'completeTitle', { n: 9, m: 13 }), 'داواکارییە ژمێردراوەکان: 9 لە 13');
  assert.equal(fw(loc('en'), 'completeTitle', { n: 9, m: 13 }), 'Calculated orders: 9 of 13');
  assert.equal(fw(loc('ar'), 'completeTitle', { n: 9, m: 13 }), 'الطلبات المحسوبة: 9 من 13');
  // The new screens' own loc() calls, outside the table, carry their Sorani too: the frame (the workspace's
  // own component, above the reports it still hosts unchanged until step 4) and the overview.
  const workspace = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  const frame = workspace.slice(0, workspace.indexOf('function orderKindName('));
  for (const [file, code] of [['FinanceWorkspace.tsx', frame], ['Overview.tsx', codeOf('src/components/financeWorkspace/Overview.tsx')]] as const) {
    assert.ok(code.length > 2000 && !code.includes('function OrderRow('), file);
    for (const [, ar, , ckb] of code.matchAll(/loc\('([^']*)', '([^']*)', '([^']*)'\)/g)) {
      assert.doesNotMatch(ckb, ARABIC_ONLY, `${file}: «${ckb}»`);
      if (ARABIC.test(ar.replace(/[،؛]/g, ''))) assert.notEqual(ckb, ar, `${file}: the Sorani of «${ar}» is the Arabic`);
    }
    assert.doesNotMatch(code, /loc\('[^'\n]*[؀-ۿ][^'\n]*', '[^'\n]*'\)/, `${file}: a string without its Sorani`);
  }
});

test('a period is written as each language writes it, in Latin digits, across a month and a year', () => {
  assert.equal(rangeText('ar', '2026-11-01', '2026-11-11'), '1–11 تشرين الثاني 2026');
  assert.equal(rangeText('en', '2026-11-01', '2026-11-11'), 'Nov 1–11, 2026');
  assert.equal(rangeText('ckb', '2026-11-01', '2026-11-11'), '1–11 تشرینی دووەم 2026');
  assert.equal(rangeText('ar', '2026-10-15', '2026-11-14'), '15 تشرين الأول – 14 تشرين الثاني 2026');
  assert.equal(rangeText('en', '2025-12-22', '2026-01-10'), 'Dec 22, 2025 – Jan 10, 2026');
  assert.equal(rangeText('en', '2026-11-05', '2026-11-05'), 'Nov 5, 2026');
});

// ------------------------------------------------------------------ the frame
/** The workspace as it opens on a link (its first render: the effects that read the server do not run here). */
function open(search: string, lang: 'ar' | 'en' | 'ckb' = 'ar') {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = { location: { search, href: `https://levonis-iq.com/admin${search}` }, history: { state: null, replaceState: () => {} } };
  LANG = lang;
  try { return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(FinanceWorkspace))); } finally { g.window = before; LANG = 'ar'; }
}
const current = (html: string) => /<button[^>]*class="fw-tab"[^>]*aria-current="page"[^>]*data-finance-section="(\w+)"/.exec(html)?.[1];
const page = (html: string) => /aria-pressed="true" data-finance-subpage="(\w+)"/.exec(html)?.[1];

test('five sections instead of eight tabs, and every earlier `finance=` link still opens its page (redesign step 2)', () => {
  const html = open('');
  assert.deepEqual([...html.matchAll(/data-finance-section="(\w+)"/g)].map((m) => m[1]), ['overview', 'reports', 'costs', 'people', 'accounting']);
  for (const word of ['نظرة عامة', 'التقارير', 'التكاليف', 'الأشخاص والدفعات', 'المحاسبة']) assert.ok(html.includes(`>${word}`), word);
  const links: Array<[string, string, string | undefined]> = [['overview', 'overview', undefined], ['orders', 'reports', 'orders'], ['products', 'reports', 'products'], ['monthly', 'costs', 'monthly'],
    ['monthlycosts', 'costs', 'monthly'], ['staff', 'people', 'staff'], ['people', 'people', 'staff'], ['investors', 'people', 'investors'], ['settlements', 'people', 'settlements'],
    ['withdrawals', 'people', 'settlements'], ['accounting', 'accounting', undefined], ['missing', 'costs', 'missing'], ['expenses', 'costs', 'expenses'], ['nonsense', 'overview', undefined]];
  for (const [link, section, sub] of links) {
    const shown = open(`?finance=${link}`);
    assert.equal(current(shown), section, `?finance=${link} opens «${section}»`);
    assert.equal(page(shown), sub, `?finance=${link} opens the page «${sub}»`);
  }
  // The people pages keep the words their refusals name them by (the wage settlement's «السحب والتسويات»).
  assert.ok(open('?finance=settlements').includes('>السحب والتسويات<'));
  assert.ok(open('?finance=settlements', 'ckb').includes('>ڕاکێشان و یەکلاکردنەوەکان<'));
});

test('one compact bar: a preset needs no dates (the header says them); a custom range asks for two; the comparison and the export sit beside it on the overview (redesign step 2)', () => {
  const month = open('');
  assert.match(month, /<option value="month" selected="[^"]*">هذا الشهر حتى اليوم<\/option>/, 'not «فترة مخصصة» for the month so far');
  assert.doesNotMatch(month, /type="date"/, 'a preset asks for no dates');
  assert.match(month, /data-finance-compare/);
  assert.match(month, /<option value="month" selected="[^"]*">نفس الأيام من الشهر السابق<\/option>/, 'a period inside one month is compared with the same days of the month before');
  assert.match(month, /href="\/api\/admin\/finance-workspace\/export\.csv\?from=[\d-]+&amp;to=[\d-]+"[^>]*data-finance-export/);
  // A past range that is no preset on any later day (a preset ends today).
  const custom = open('?from=2026-09-15&to=2026-10-14');
  assert.match(custom, /<option value="custom" selected="[^"]*">فترة مخصصة…<\/option>/);
  assert.equal((custom.match(/type="date"/g) ?? []).length, 2);
  assert.match(custom, /<option value="previous" selected="[^"]*">الفترة السابقة بنفس الطول<\/option>/, 'a range across months is compared with the period before it');
  assert.match(custom, /data-finance-range[^>]*><bdi>15 أيلول – 14 تشرين الأول 2026<\/bdi>/);
  assert.match(custom, /مقارنةً بـ 16 آب – 14 أيلول 2026/, 'and the header says which days: the thirty before');
  // Only the overview compares; only its and the reports' bar exports; the month page has its own month.
  const people = open('?finance=staff');
  assert.doesNotMatch(people, /data-finance-compare|data-finance-export/);
  assert.match(open('?finance=orders'), /data-finance-export/);
  assert.doesNotMatch(open('?finance=monthly'), /data-finance-period/);
  assert.match(open('?finance=monthly'), /type="month"/);
});

// ------------------------------------------------------------------ what the frame remembers (frameState.ts)
// The independent review (2026-11-11) found two ways the frame showed figures that were not true any more: a failed
// read of a new period left the old period's figures under the new dates (against the new comparison), and a page
// kept hidden never read again after the owner paid or saved on another page. The frame keeps that memory in a pure
// module; these tests drive it exactly as the screen does, then check the screen is wired to it.
const nov = summary({ range: { from: '2026-11-01', to: '2026-11-11' }, totals: { retained_revenue_iqd: 6858667, orders_count: 13 }, missing_costs: { lines: 19, orders: 9, unknown_lines: 4, estimated_lines: 15, unknown_products: [] } });
const oct = summary({ range: { from: '2026-10-01', to: '2026-10-31' }, totals: { retained_revenue_iqd: 19685330, orders_count: 33 } });

test('a failed read of another period never leaves the old period\'s figures under the new dates; while it loads they stay dimmed, without a comparison (review blocker)', () => {
  const NOV = summaryKey('2026-11-01', '2026-11-11', 'IQD'), OCT = summaryKey('2026-10-01', '2026-10-31', 'IQD');
  let s = summaryReducer(NO_SUMMARY, { type: 'start', key: NOV });
  assert.deepEqual(summaryShown(s, NOV), { data: null, current: false, at: '' }, 'the first read: a spinner, nothing to show yet');
  s = summaryReducer(s, { type: 'loaded', key: NOV, data: nov, at: '10:50' });
  assert.deepEqual(summaryShown(s, NOV), { data: nov, current: true, at: '10:50' });
  // The owner picks «الشهر السابق»: while October loads, November's figures stay — dimmed (not current), so no comparison is drawn.
  s = summaryReducer(s, { type: 'start', key: OCT });
  assert.deepEqual(summaryShown(s, OCT), { data: nov, current: false, at: '' });
  // October's read fails (a 503, the hourly read budget, a dropped line): November's figures go; the error stands alone.
  s = summaryReducer(s, { type: 'failed', key: OCT, error: 'خطأ في الخادم (503)' });
  assert.deepEqual(summaryShown(s, OCT), { data: null, current: false, at: '' }, 'no figures of another period under October\'s dates');
  assert.equal(s.error, 'خطأ في الخادم (503)');
  assert.equal(s.loading, null);
  assert.equal(missingBadge(s, '2026-10-01', '2026-10-31'), 0, 'nor November\'s «التكاليف 19» on October');
  // «إعادة المحاولة»: a spinner, not November again; then October's own figures.
  s = summaryReducer(s, { type: 'start', key: OCT });
  assert.equal(summaryShown(s, OCT).data, null);
  s = summaryReducer(s, { type: 'loaded', key: OCT, data: oct, at: '10:52' });
  assert.deepEqual(summaryShown(s, OCT), { data: oct, current: true, at: '10:52' });
  assert.equal(s.error, '');
});

test('a failed switch to dollars drops the dinar figures rather than show them under the dollar toggle; the period\'s badge stays while the dollars load', () => {
  const IQD = summaryKey('2026-11-01', '2026-11-11', 'IQD'), USD = summaryKey('2026-11-01', '2026-11-11', 'USD');
  let s = summaryReducer(summaryReducer(NO_SUMMARY, { type: 'start', key: IQD }), { type: 'loaded', key: IQD, data: nov, at: '10:50' });
  s = summaryReducer(s, { type: 'start', key: USD });
  assert.deepEqual(summaryShown(s, USD), { data: nov, current: false, at: '' }, 'dimmed while the dollars load');
  assert.equal(missingBadge(s, '2026-11-01', '2026-11-11'), 19, 'the same period: the badge does not blink');
  s = summaryReducer(s, { type: 'failed', key: USD, error: 'no rate' });
  assert.equal(summaryShown(s, USD).data, null, 'no dinars under «دولار»');
  // Back to dinars: read again (the dinar read went with the failure), never the dollars' error over it.
  s = summaryReducer(s, { type: 'start', key: IQD });
  assert.equal(s.error, '');
});

test('a refresh of the same period that fails keeps its figures — they are that period\'s — with the time they were read; a later background read clears the error', () => {
  const NOV = summaryKey('2026-11-01', '2026-11-11', 'IQD');
  let s = summaryReducer(summaryReducer(NO_SUMMARY, { type: 'start', key: NOV }), { type: 'loaded', key: NOV, data: nov, at: '10:50' });
  s = summaryReducer(summaryReducer(s, { type: 'start', key: NOV }), { type: 'failed', key: NOV, error: 'offline' });
  assert.deepEqual(summaryShown(s, NOV), { data: nov, current: true, at: '10:50' });
  assert.equal(s.error, 'offline');
  // The 30-second background read lands without a «start» of its own.
  s = summaryReducer(s, { type: 'loaded', key: NOV, data: nov, at: '10:51' });
  assert.equal(s.error, '');
  assert.equal(summaryShown(s, NOV).at, '10:51');
});

test('a kept page is read afresh after a save anywhere, a refresh, another period or currency, or two minutes away; accounting is never kept (review blocker)', () => {
  const only = (page: string) => page !== 'accounting';
  const key = (revision: number, currency = 'IQD', from = '2026-11-01') => keepKey(from, '2026-11-11', currency, revision);
  const t0 = Date.UTC(2026, 10, 11, 7, 0);
  // The owner reads «الموظفون», then pays on «السحب والتسويات»: Staff is kept, hidden.
  let k = navigate(NOTHING_KEPT, key(0), 'overview', 'staff', t0, only);
  k = navigate(k, key(0), 'staff', 'settlements', t0 + 5_000, only);
  assert.deepEqual(keptPages(k, key(0)).sort(), ['overview', 'staff']);
  // The payment calls onChanged → refresh(): the revision moves on, and no page from before it is kept — Staff
  // mounts again when shown and reads «متاح الآن» after the payment, instead of the 161,178 from before it.
  assert.deepEqual(keptPages(k, key(1)), [], 'a save or «تحديث» drops every hidden page');
  k = navigate(k, key(1), 'settlements', 'staff', t0 + 9_000, only);
  assert.deepEqual(keptPages(k, key(1)), ['settlements'], 'only the page just left is kept');
  // And the other way: Withdrawals, kept, after a settlement on Staff — the same.
  assert.deepEqual(keptPages(k, key(2)), []);
  // Another period or currency drops them too.
  assert.deepEqual(keptPages(k, key(1, 'USD')), []);
  assert.deepEqual(keptPages(k, key(1, 'IQD', '2026-10-01')), []);
  // Within two minutes a page comes back as it was left (no read); after them it mounts again (a fresh read):
  // a request or a payment made elsewhere meanwhile is on it.
  const before = pageMount(k, 'settlements');
  const quick = navigate(k, key(1), 'staff', 'settlements', t0 + 9_000 + KEEP_MS, only);
  assert.equal(pageMount(quick, 'settlements'), before, 'two minutes: kept as it was');
  const late = navigate(k, key(1), 'staff', 'settlements', t0 + 9_001 + KEEP_MS, only);
  assert.notEqual(pageMount(late, 'settlements'), before, 'over two minutes: read afresh');
  assert.equal(pageMount(late, 'staff'), pageMount(k, 'staff'), 'the page left keeps its mount');
  // Accounting is never kept; a page never keeps itself.
  const acc = navigate(navigate(NOTHING_KEPT, key(0), 'overview', 'accounting', t0, only), key(0), 'accounting', 'overview', t0 + 1, only);
  assert.deepEqual(keptPages(acc, key(0)), []);
});

test('the comparison is read once per key; a failed read says so instead of a silent card, and is not read again until the key moves', () => {
  assert.deepEqual(comparisonFor(null, ''), { data: null, failed: false, wanted: false }, '«بلا مقارنة»: nothing to read');
  assert.deepEqual(comparisonFor(null, 'a'), { data: null, failed: false, wanted: true });
  assert.deepEqual(comparisonFor({ key: 'a', data: oct }, 'a'), { data: oct, failed: false, wanted: false });
  assert.deepEqual(comparisonFor({ key: 'a', data: null }, 'a'), { data: null, failed: true, wanted: false }, 'failed: no retry loop');
  assert.deepEqual(comparisonFor({ key: 'a', data: oct }, 'b'), { data: null, failed: false, wanted: true }, 'a new key reads again');
});

test('the frame is wired to that memory: figures only under their own period and currency, the comparison only beside them, hidden pages by the keep key with the revision, each page in its own currency', () => {
  const code = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  assert.match(code, /const readKey = summaryKey\(range\.from, range\.to, currency\);/);
  assert.match(code, /const shown = summaryShown\(summary, readKey\), data = shown\.data/);
  assert.match(code, /<Overview data=\{d\} prev=\{shown\.current \? comparison\.data : null\}/);
  assert.match(code, /const kept = keepKey\(range\.from, range\.to, currency, revision\);/);
  assert.match(code, /const hidden = keptPages\(keptState, kept\);/);
  assert.match(code, /setKept\(\(state\) => navigate\(state, kept, section, next, Date\.now\(\), keepable\)\);/);
  assert.match(code, /<FreshOnReturnHold\.Provider key=\{pageMount\(keptState, id\)\} value=\{id !== section\}>/);
  // A kept page's currency never flips when the owner moves to a section without the toggle (a hidden re-read each time).
  assert.match(code, /<DisplayCurrencyContext\.Provider value=\{CURRENCY_PAGES\.includes\(id\) \? currency : 'IQD'\}>/);
  assert.match(code, /if \(section === 'orders'\) setOrdersPoll\(\(value\) => value \+ 1\);/);
  assert.match(code, /revision=\{revision \+ ordersPoll\}/);
  // The hold itself is run in React in tests/freshOnReturnHold.test.ts.
  assert.match(codeOf('src/lib/useFreshOnReturn.ts'), /const held = useContext\(FreshOnReturnHold\);\s*const enabled = wanted && !held;/);
  // A failed comparison is named in the header (the cards then show no change).
  const words = (lang: 'ar' | 'en' | 'ckb') => (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k ?? a : a);
  assert.equal(fw(words('ar'), 'vsFailed', { range: '1–11 تشرين الأول 2026' }), 'لا مقارنة: تعذّرت قراءة 1–11 تشرين الأول 2026');
  assert.match(code, /fw\(loc, comparison\.failed \? 'vsFailed' : 'vsHeader'/);
});

// ------------------------------------------------------------------ compare.ts, the edges
test('«same days last month» on a year-long range stays readable: its first day moves up so the server never refuses it (review nit)', () => {
  const c = compareRange({ from: '2023-03-31', to: '2024-03-30' }, 'month')!;
  assert.deepEqual(c, { from: '2023-03-01', to: '2024-02-29' });
  assert.equal((Date.parse(c.to) - Date.parse(c.from)) / 86400000, MAX_SPAN_DAYS);
  // Every comparison of every valid range is a range the server answers, both ways.
  for (let i = 0; i < 400; i += 1) {
    const from = new Date(Date.UTC(2023, 0, 1) + ((i * 7919) % 1460) * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(from) + ((i * 104729) % 366) * 86400000).toISOString().slice(0, 10);
    for (const mode of ['month', 'previous'] as const) assert.ok(validFinanceRange(compareRange({ from, to }, mode)!), `${mode} ${from}–${to}`);
  }
});

test('a figure that crossed zero has no percentage: a loss that became a profit says so, and the reverse (review nit)', () => {
  assert.equal(signFlip(1000000, -10000), 'up');
  assert.equal(signFlip(-5000, 20000), 'down');
  assert.equal(signFlip(110, 100), null);
  assert.equal(signFlip(-50, -100), null, 'a smaller loss is a percentage');
  assert.equal(signFlip(0, -100), null);
  assert.equal(signFlip(null, -100), null);
});

// ------------------------------------------------------------------ the statement, the edges
const drawStatement = (data: FinanceSummary, currency: 'IQD' | 'USD' = 'IQD', lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  LANG = lang;
  try {
    return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(DisplayCurrencyContext.Provider, { value: currency },
      createElement(Statement, { data, usd: currency === 'USD' ? data.display_usd : undefined }))));
  } finally { LANG = 'ar'; }
};
const statementRow = (html: string, key: string) => new RegExp(`<tr[^>]*data-key="${key}">([\\s\\S]*?)</tr>`).exec(html)![1];

test('the statement draws a column only when it has orders: none complete, or none waiting, is the period alone; split, a phone can show any of the three (review)', () => {
  assert.deepEqual(statementColumns(9, 4), [0, 1, 2]);
  assert.deepEqual(statementColumns(0, 3), [2], 'no complete order: no column of «ناقص» chips for an empty sum');
  assert.deepEqual(statementColumns(13, 0), [2]);
  // Three orders all waiting for a magnet price: one column, the period's, and it is the one a phone shows.
  const waiting = summary({ totals: { orders_count: 3, retained_revenue_iqd: 30000, cogs_iqd: null, gross_profit_iqd: null, pending_costs: 0, general_expenses_iqd: 10001 }, known: null,
    waiting: { orders_count: 3, totals: { retained_revenue_iqd: 30000, cogs_iqd: null }, reasons: { no_price: ['a', 'b', 'c'] }, general_share_iqd: 10001, unallocated_share_iqd: 0 } });
  const none = drawStatement(waiting);
  assert.deepEqual([...none.matchAll(/<th scope="col" data-col="(\d)">([^<]*)</g)].map((m) => m[2]), ['الفترة (3)']);
  assert.doesNotMatch(none, /data-col="0"|data-col="1"/);
  assert.match(none, /data-phone-col="2"/);
  assert.doesNotMatch(none, /fw-seg/, 'one column: no switch');
  // Split: the phone's switch offers all three — «تنتظر» too — and the heads name the estimates (owner decision 3).
  const split = summary({ totals: { orders_count: 13, general_expenses_iqd: 0 }, known: { orders_count: 9, incomplete_orders: 4, revenue_iqd: 1, cost_iqd: null, owner_net_iqd: null, totals: {},
    estimated: { orders_count: 6, revenue_iqd: 1, owner_net_iqd: 1 } }, waiting: { orders_count: 4, totals: {}, reasons: {} } });
  const html = drawStatement(split);
  assert.deepEqual([...html.matchAll(/<button type="button" aria-pressed="(?:true|false)">([^<]*)</g)].map((m) => m[1]), ['محسوبة (9 · تقديرية: 6)', 'تنتظر (4)', 'الفترة (13)']);
  assert.match(html, /data-phone-col="0"/);
  assert.match(html, /بأسعار شراء مؤكدة أو بتقدير وقت البيع/, 'the note says «محسوبة» includes sale-time estimates');
  assert.match(drawStatement(split, 'IQD', 'ckb'), /ژمێردراو \(9 · خەمڵێنراو: 6\)/);
  // All complete, six on estimates: the period's head names them.
  const allIn = summary({ totals: { orders_count: 13 }, known: { orders_count: 13, incomplete_orders: 0, revenue_iqd: 1, cost_iqd: null, owner_net_iqd: 1, totals: {}, estimated: { orders_count: 6, revenue_iqd: 1, owner_net_iqd: 1 } }, waiting: null });
  assert.match(drawStatement(allIn), /data-col="2">الفترة \(13 · تقديرية: 6\)</);
});

test('the statement explains a negative investor share, and in dollars names costs that wait for their orders without a dinar amount (review coverage)', () => {
  const t: ProfitTotals = { ...full, investor_iqd: -6000, owner_net_iqd: full.owner_net_iqd! + 31000, net_after_report_adjustments_iqd: full.net_after_report_adjustments_iqd! + 31000, general_waiting_iqd: 12000, general_expenses_iqd: 0, orders_count: 1 };
  t.owner_period_net_after_report_adjustments_iqd = t.net_after_report_adjustments_iqd;
  const data = summary({ totals: t, known: null, waiting: null });
  const iqd = drawStatement(data);
  assert.match(statementRow(iqd, 'investor'), /سالبة: مساهمة المستثمرين في الخسارة/);
  assert.match(statementRow(iqd, 'investor'), /-6,000 د\.ع/);
  assert.match(statementRow(iqd, 'general'), /لا تشمل تكاليف تنتظر تسليم طلباتها: 12,000 د\.ع/);
  assert.equal(statementAddsUp(statementRows(data).rows, 2), true, 'and the loss share still adds up');
  const cents = { retained_revenue_cents: 66667, cogs_cents: 46667, gross_profit_cents: 20000, shipping_income_cents: 667, cod_tax_cents: 267, direct_cost_cents: 633, wages_cents: 500, materials_cents: 133,
    manual_direct_cents: 100, courier_fee_cents: 200, payment_fee_cents: 67, promotion_cents: 400, investor_cents: -400, coupon_cents: 200, price_protection_cents: 133, trade_in_credit_returned_cents: 467,
    general_expenses_cents: 0, unallocated_promotion_cents: 0 };
  const net = 20000 + 667 + 267 - 500 - (633 - 500 + 100) - 267 - 400 + 400 - 0 - 800;
  const usd = { available: true, totals: { ...cents, owner_period_net_after_report_adjustments_cents: net } } as DisplayUsdSummary;
  const dollars = drawStatement({ ...data, display_usd: usd }, 'USD');
  assert.match(dollars, /data-finance-statement="USD"/);
  assert.equal(statementAddsUp(statementRows({ ...data, display_usd: usd }, usd).rows, 2), true, 'to the cent');
  assert.match(statementRow(dollars, 'general'), /لا تشمل تكاليف تنتظر تسليم طلباتها</);
  assert.doesNotMatch(dollars, /د\.ع/, 'no dinar amount among the dollar cells');
  assert.match(statementRow(dollars, 'investor'), /سالبة/);
});

// ------------------------------------------------------------------ the curve and the people, the edges
test('the revenue curve: a period with no revenue says so instead of a flat line on a scale of fractions; the axis never steps under one whole unit (review nit)', () => {
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(0), 1);
  assert.equal(niceStep(3.5), 1, 'a few dollars: whole dollars');
  assert.equal(niceStep(6997667), 2000000);
  const draw = (data: FinanceSummary, prev: FinanceSummary | null = null) => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Curve, { data, prev, compareLabel: '1–11 تشرين الأول 2026' })));
  const days = (values: number[]) => ({ daily: values.map((v, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, revenue_iqd: v, cost_iqd: null, owner_net_iqd: null, investor_iqd: null, orders_count: 0, unknown_lines: 0, pending_costs: 0 })) }) as unknown as FinanceSummary['chart_data'];
  const empty = draw(summary({ chart_data: days([0, 0, 0]) }));
  assert.match(empty, /data-finance-curve="empty"[^>]*>لا إيراد في الفترة</);
  assert.doesNotMatch(empty, /<svg/);
  const small = draw(summary({ chart_data: days([1, 0, 2]) }));
  const labels = [...small.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(labels.length >= 2 && labels.every((l) => /^\d+$/.test(l)), `whole units: ${labels.join(', ')}`);
  // The comparison alone still draws: last month sold, this one has not yet.
  assert.match(draw(summary({ chart_data: days([0, 0]) }), summary({ chart_data: days([5000, 7000]) })), /<svg/);
  // A comparison longer than the period (31 days against 11): the axis runs to the longer one, and both end where they end.
  const long = draw(summary({ chart_data: days([100, 200, 300]) }), summary({ chart_data: days([50, 50, 50, 50, 50]) }));
  const xs = [...long.matchAll(/text-anchor="middle"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...xs), 5, 'the day axis is the comparison\'s five days');
  assert.match(long, /This period|هذه الفترة/);
  // In dollars: the server's cents per day, labelled in whole dollars; a comparison without cents is not drawn beside them.
  const usd = { available: true, chart: { daily: { '2026-11-01': { revenue_cents: 66667 }, '2026-11-02': { revenue_cents: 0 }, '2026-11-03': { revenue_cents: 133333 } } } } as unknown as DisplayUsdSummary;
  const dollars = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Curve, { data: summary({ chart_data: days([1000000, 0, 2000000]) }), prev: summary({ chart_data: days([5, 5, 5]) }), usd, compareLabel: 'x' })));
  const ticks = [...dollars.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(ticks.length >= 2 && ticks.every((l) => /^\$\d+(k|M)?$/.test(l)), `dollar ticks: ${ticks.join(', ')}`);
  assert.match(dollars, /\$2,000\.00/, 'the period\'s total in the legend, from the cents');
  assert.doesNotMatch(dollars, /stroke-dasharray="5 4"/, 'no dinar comparison line among dollars');
});

test('«يحتاج انتباهك» and the payouts card once the people are read: who can be paid now, the largest first, and what is held (review coverage)', () => {
  const people: People = { error: false, list: [
    { user_id: 'u_sajjad', name: 'سجاد', investor: { state: 'active' }, combined: { available_iqd: 161178, held_iqd: 916971 } },
    { user_id: null, staff_id: 'staff_hussein', name: 'حسين', investor: null, combined: { available_iqd: 75000, held_iqd: 0 } },
    { user_id: 'u_m', name: 'منتضر', investor: { state: 'active' }, combined: { available_iqd: 0, held_iqd: 0 } }] };
  const draw = (node: ReturnType<typeof createElement>, lang: 'ar' | 'en' = 'ar') => { LANG = lang; try { return renderToStaticMarkup(createElement(LanguageProvider, null, node)); } finally { LANG = 'ar'; } };
  const noop = () => {};
  const data = summary({ totals: { orders_count: 13, general_expenses_iqd: 5000 } });
  const attention = draw(createElement(Attention, { data, people, openOrder: noop, onNavigate: noop, onMissing: noop, onCollections: noop }));
  assert.deepEqual([...attention.matchAll(/data-finance-attention-item="(\w+)"/g)].map((m) => m[1]), ['payouts']);
  assert.match(attention, /236,178 د\.ع لـ:/, 'the total ready to pay');
  assert.match(attention, /<bdi>سجاد 161,178 د\.ع<\/bdi>[\s\S]*<bdi>حسين 75,000 د\.ع<\/bdi>/, 'the largest first, each name beside its own amount');
  assert.doesNotMatch(attention, /منتضر/, 'nobody with nothing to pay');
  assert.match(draw(createElement(Attention, { data, people, openOrder: noop, onNavigate: noop, onMissing: noop, onCollections: noop }), 'en'), /236,178 د\.ع to: [\s\S]*<bdi>سجاد 161,178 د\.ع<\/bdi>/, 'an Arabic name keeps its place in an English line');
  const payouts = draw(createElement(Payouts, { people, onNavigate: noop }));
  assert.match(payouts, /data-finance-payouts="true"><dt>جاهز للدفع<\/dt><dd>[\s\S]*236,178 د\.ع[\s\S]*<dt>محجوز<\/dt><dd>[\s\S]*916,971 د\.ع/);
  assert.equal((payouts.match(/<li>/g) ?? []).length, 2, 'two people to pay; the third has nothing');
  assert.match(draw(createElement(Payouts, { people: { list: null, error: false }, onNavigate: noop })), /role="status">تحميل المستحقات…</);
  assert.match(draw(createElement(Payouts, { people: { list: [], error: true }, onNavigate: noop })), /role="alert">تعذّر تحميل المستحقات</);
});
