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
 *     period bar that asks for dates only for a custom range.
 * The server's half (known.totals, waiting) is in tests/financeFigures.test.ts; the overview
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
import { change, compareRange, defaultCompare, monthEarlier } from '../src/components/financeWorkspace/compare';
import { statementAddsUp, statementRows, type StatementRow } from '../src/components/financeWorkspace/statement';
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
  assert.match(custom, /عن 16 آب – 14 أيلول 2026/, 'and the header says which days: the thirty before');
  // Only the overview compares; only its and the reports' bar exports; the month page has its own month.
  const people = open('?finance=staff');
  assert.doesNotMatch(people, /data-finance-compare|data-finance-export/);
  assert.match(open('?finance=orders'), /data-finance-export/);
  assert.doesNotMatch(open('?finance=monthly'), /data-finance-period/);
  assert.match(open('?finance=monthly'), /type="month"/);
});

test('a page the owner leaves is kept, hidden, until the period changes, and it holds its refreshes while hidden (redesign step 2)', () => {
  const code = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  // Kept by period: another range starts afresh; accounting (on-demand tools that pause the summary's refresh) is not kept.
  assert.match(code, /const keepKey = `\$\{range\.from\}\|\$\{range\.to\}`;/);
  assert.match(code, /const keptPages = kept\.key === keepKey \? kept\.pages : \[\];/);
  assert.match(code, /const KEPT: FinanceSection\[\] = SECTIONS\.filter\(\(s\) => s !== 'accounting'\);/);
  assert.match(code, /<FreshOnReturnHold\.Provider key=\{id\} value=\{id !== section\}>/);
  assert.match(code, /style=\{id === section \? undefined : \{ display: 'none' \}\}/);
  // The orders list re-reads after the summary's background refresh only while it is shown.
  assert.match(code, /if \(section === 'orders'\) setOrdersPoll\(\(value\) => value \+ 1\);/);
  assert.match(code, /revision=\{revision \+ ordersPoll\}/);
  // The hold: nothing polls while hidden, and a wake it missed runs when it is shown again.
  const hook = codeOf('src/lib/useFreshOnReturn.ts');
  assert.match(hook, /export const FreshOnReturnHold = createContext\(false\);/);
  assert.match(hook, /const held = useContext\(FreshOnReturnHold\);\s*const enabled = wanted && !held;/);
  assert.match(hook, /if \(!was && enabled && pendingRef\.current\)/);
  // The comparison is read once per period, comparison, currency and refresh, and only for the overview.
  assert.match(code, /const compareKey = compared \? `\$\{compared\.from\}\|\$\{compared\.to\}\|\$\{display\}\|\$\{revision\}` : '';/);
  assert.match(code, /const wantsComparison = main === 'overview' && !!compareKey && !comparison;/);
});
