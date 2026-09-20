/**
 * THE FINANCIAL DASHBOARD — the promises it makes that a screenshot cannot keep.
 *
 * This repository has no browser DOM runner, so the rules below are pinned two
 * ways, and the split is deliberate:
 *
 *   BEHAVIOUR is tested as BEHAVIOUR. "The estimate warning appears when the
 *   server reported estimated rows, and not otherwise" is the single most
 *   important promise on this screen — somebody sets a supplier price from a
 *   number this warning qualifies — so it is exercised as a function over a
 *   real response shape, with estimates and without. A regular expression over
 *   the JSX would pass just as happily with the condition inverted.
 *
 *   STRUCTURE is pinned over the SOURCE, the way tests/adminSurfaceDesign.ts
 *   and tests/bundleAdminUi.ts already do: a second y-axis, a missing line
 *   height and an eager `recharts` import are all invisible to a unit test and
 *   all of them are regressions this screen must not be allowed to acquire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { honestyNotices, isEstimated } from '../src/components/adminFinance/honesty';
import { decompositionLines } from '../src/components/adminFinance/AdminFinance';
import { expenseProblem } from '../src/components/adminFinance/expenseForm';
import { financeStrings } from '../src/components/adminFinance/strings';
import { MEASURE_COLOR } from '../src/components/adminFinance/palette';
import { endLabelsFit, niceScale, roundedEndPath } from '../src/components/adminFinance/scale';
import { baghdadDay, defaultGranularity, presetRange, rangeProblem } from '../src/components/adminFinance/period';
import type { FinancePeriodReport, FinanceTotals, FinanceReportMeta } from '../src/lib/api';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const DIR = 'src/components/adminFinance';
/**
 * The source with its comments removed.
 *
 * Needed because this file's own rules are QUOTED in the comments of the code
 * they govern — the panel explains, in prose, why `dir === 'rtl' ? ar : en` is
 * forbidden, and a naive scan would then fail on the explanation. Stripping
 * comments means a ban is checked against what the code DOES, which also stops
 * the opposite failure: a rule silently satisfied by a comment that mentions it.
 */
const codeOf = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const sources = (): Array<{ name: string; text: string }> =>
  readdirSync(new URL(`../${DIR}`, import.meta.url))
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map((f) => ({ name: `${DIR}/${f}`, text: read(`${DIR}/${f}`) }));

// --------------------------------------------------------------- fixtures

const zeroTotals = (): FinanceTotals => ({
  gross_revenue_iqd: 0,
  refunded_revenue_iqd: 0,
  revenue_iqd: 0,
  costed_revenue_iqd: 0,
  uncosted_revenue_iqd: 0,
  cogs_iqd: 0,
  refunded_cogs_iqd: 0,
  gross_profit_iqd: 0,
  gross_margin_percent: null,
  shipping_collected_iqd: 0,
  cod_tax_collected_iqd: 0,
  points_redeemed_iqd: 0,
  coupon_discount_iqd: 0,
  operating_expenses_iqd: 0,
  net_profit_iqd: 0,
  net_margin_percent: null,
  orders: 0,
  lines: 0,
  units: 0,
  refunded_units: 0,
  refund_cases: 0,
  expense_entries: 0,
  estimated: false,
  estimated_lines: 0,
  estimated_units: 0,
  estimated_cogs_iqd: 0,
  uncosted_lines: 0,
  uncosted_units: 0,
  fifo_lines: 0,
  fifo_cogs_iqd: 0,
});

/** A healthy deployment: 0095 applied, a ledger installed, nothing missing. */
const cleanMeta = (): FinanceReportMeta => ({
  recognition: 'delivered_baghdad_day',
  timezone: 'Asia/Baghdad',
  week_starts_on: 'saturday',
  currency: 'IQD',
  cost_snapshot_available: true,
  fifo_available: true,
  operating_expenses_available: true,
  unrecognized_orders: 0,
  unbucketed: {
    sale_lines: 0,
    sale_revenue_iqd: 0,
    refund_cases: 0,
    expense_entries: 0,
    expense_amount_iqd: 0,
  },
});

const reportOf = (
  totals: Partial<FinanceTotals>,
  meta: Partial<FinanceReportMeta> = {}
): Pick<FinancePeriodReport, 'totals' | 'meta'> => ({
  totals: { ...zeroTotals(), ...totals },
  meta: { ...cleanMeta(), ...meta },
});

// ------------------------------------------- 1. the estimate disclosure

test('the estimate warning appears when the server reports estimated rows, and NOT otherwise', () => {
  // A measured period: every cost was captured at the moment of sale, AND the
  // owner has entered operating expenses — without that last part the period
  // owes the «لم تُسجَّل أي مصاريف» disclosure, because a net profit that
  // silently ignores rent is the number the owner would price against.
  const measured = reportOf({
    revenue_iqd: 4_000_000,
    costed_revenue_iqd: 4_000_000,
    cogs_iqd: 2_500_000,
    gross_profit_iqd: 1_500_000,
    estimated: false,
    estimated_lines: 0,
    expense_entries: 3,
    operating_expenses_iqd: 600_000,
  });
  assert.deepEqual(honestyNotices(measured), [], 'a fully measured period owes no disclosure');
  assert.equal(isEstimated(measured), false, 'nothing here was reconstructed');

  // The same period with 142 lines priced from today's catalogue instead.
  const partly = reportOf({
    revenue_iqd: 4_000_000,
    costed_revenue_iqd: 4_000_000,
    cogs_iqd: 2_500_000,
    gross_profit_iqd: 1_500_000,
    estimated: true,
    estimated_lines: 142,
    estimated_units: 190,
    estimated_cogs_iqd: 820_000,
    expense_entries: 3,
    operating_expenses_iqd: 600_000,
  });
  const ids = honestyNotices(partly).map((n) => n.id);
  assert.deepEqual(ids, ['estimated'], 'the estimate is disclosed, and nothing else is invented');
  assert.equal(isEstimated(partly), true);
  const notice = honestyNotices(partly)[0];
  // The COUNT travels with the notice: "partly estimated" without a number is
  // a shrug, and the owner's next question is always how much.
  assert.equal(notice.values.lines, 142);
  assert.equal(notice.values.cost, 820_000);
  assert.equal(notice.tone, 'warning');
});

test('a deployment with no cost-at-sale column says EVERY figure is an estimate, even at zero counted lines', () => {
  // The trap this closes: with migration 0095 absent there is nothing to
  // count, so `estimated_lines` is 0 — and "0 estimated lines" reads as
  // "nothing was estimated" when in fact everything was.
  const noColumn = reportOf({ revenue_iqd: 1_000_000, estimated: false, estimated_lines: 0 }, { cost_snapshot_available: false });
  const ids = honestyNotices(noColumn).map((n) => n.id);
  assert.ok(ids.includes('no_cost_snapshot'));
  assert.equal(isEstimated(noColumn), true, 'no snapshot column means the whole screen is an estimate');
});

test('unknown costs, a missing ledger and unplaced rows are each disclosed on their own terms', () => {
  const messy = reportOf(
    {
      revenue_iqd: 3_000_000,
      uncosted_lines: 9,
      uncosted_units: 12,
      uncosted_revenue_iqd: 450_000,
    },
    {
      operating_expenses_available: false,
      unrecognized_orders: 4,
      unbucketed: {
        sale_lines: 2,
        sale_revenue_iqd: 70_000,
        refund_cases: 0,
        expense_entries: 1,
        expense_amount_iqd: 30_000,
      },
    }
  );
  const ids = honestyNotices(messy).map((n) => n.id);
  assert.deepEqual(ids, ['uncosted', 'no_expense_ledger', 'unrecognized_orders', 'unbucketed']);

  const unbucketed = honestyNotices(messy).find((n) => n.id === 'unbucketed')!;
  // Sale lines + refund cases + expense entries, and both money columns: a
  // partial count would understate what fell outside every period.
  assert.equal(unbucketed.values.lines, 3);
  assert.equal(unbucketed.values.amount, 100_000);

  // An uncosted sale is NOT an estimated one. Its cost is unknown and it is
  // excluded from the margin base entirely — reporting it as "estimated" would
  // claim a number that was never computed.
  assert.equal(isEstimated(messy), false);
});

// ------------------------------------------------ 2. no dual-axis charts

test('no chart on this screen has two value axes', () => {
  for (const { name, text } of sources()) {
    // `yAxisId` is recharts' ONLY way to put a second scale on one plot. Its
    // absence is the structural guarantee: the alignment of two scales is
    // arbitrary, so a dual axis invents a correlation that is not in the data.
    assert.doesNotMatch(text, /yAxisId/, `${name} must not introduce a second y-axis`);
    const axes = text.match(/<YAxis\b/g) ?? [];
    assert.ok(axes.length <= 1, `${name} declares ${axes.length} <YAxis> elements — one plot, one value axis`);
  }
  // And the reason is written down where the next person will look for it.
  assert.match(read(`${DIR}/TimeSeriesChart.tsx`), /THERE IS NO SECOND Y-AXIS HERE AND THERE NEVER WILL BE/);
});

test('the value axis is anchored at zero and its ticks are round numbers', () => {
  const scale = niceScale([1_237_400, 812_006, 96_500]);
  assert.equal(scale.min, 0, 'a money chart that starts at dataMin doubles every wobble');
  assert.ok(scale.max >= 1_237_400);
  // Every tick is a whole multiple of the step, and the step is 1/2/5 × 10^k.
  const step = scale.ticks[1] - scale.ticks[0];
  assert.ok(step > 0);
  const mantissa = step / 10 ** Math.floor(Math.log10(step));
  assert.ok([1, 2, 5].includes(Math.round(mantissa)), `step ${step} is not a 1/2/5 step`);
  for (const t of scale.ticks) assert.equal(t % step, 0, `${t} is not on the step`);

  // A loss is DRAWN as a loss: the domain opens below zero rather than clipping.
  const withLoss = niceScale([500_000, -240_000]);
  assert.ok(withLoss.min < 0, 'a negative net profit must not be clipped at the baseline');

  // An all-zero period still produces a usable domain instead of NaN ticks.
  const empty = niceScale([0, 0, 0]);
  assert.ok(empty.max > empty.min);
  assert.ok(empty.ticks.length >= 2);
});

test('direct end labels are dropped when the lines converge, rather than stacked', () => {
  // Far apart on a 250px plot: each label sits on its own line.
  assert.equal(endLabelsFit([1_000_000, 600_000, 200_000], 0, 1_000_000, 250), true);
  // A quiet day: revenue, gross and net land within a few thousand dinars of
  // each other, so three labels would pile up and detach from their lines.
  assert.equal(endLabelsFit([100_000, 98_000, 96_000], 0, 1_000_000, 250), false);
  // A degenerate domain never claims the labels fit.
  assert.equal(endLabelsFit([1, 2], 0, 0, 250), false);
});

test('a bar is rounded at its data end and square where it meets the axis', () => {
  // x=10, width=100 -> the bar spans 10..110, 18px tall.
  const ltrPositive = roundedEndPath(10, 0, 100, 18, 500_000, false);
  const rtlPositive = roundedEndPath(10, 0, 100, 18, 500_000, true);
  const ltrNegative = roundedEndPath(10, 0, 100, 18, -500_000, false);
  const rtlNegative = roundedEndPath(10, 0, 100, 18, -500_000, true);

  // The path starts at the SQUARE end and curves at the far one, so which
  // corner is rounded is readable from where the path begins.
  assert.ok(ltrPositive.startsWith('M10,0'), 'left-to-right, a gain is square at the axis on the left');
  assert.ok(rtlPositive.startsWith('M110,0'), 'right-to-left, a gain grows leftward and is square on the right');
  // A loss reverses the tip again — and in RTL the two reversals cancel.
  assert.ok(ltrNegative.startsWith('M110,0'));
  assert.ok(rtlNegative.startsWith('M10,0'));
  assert.equal(ltrPositive, rtlNegative, 'the two reversals cancel exactly');

  // The corner radius never exceeds half the bar's own thickness, so a thin
  // bar cannot round itself into a lozenge.
  assert.match(roundedEndPath(0, 0, 50, 4, 1, false), /Q50,0 50,2/);
  // A zero-width bar still produces a drawable path rather than NaN.
  assert.doesNotMatch(roundedEndPath(0, 0, 0, 18, 0, false), /NaN/);
});

// -------------------------------------- 3. every arbitrary size has a leading

test('every arbitrary text size on this screen states its own line height', () => {
  // Tailwind v4: `text-[13px]` sets font-size ONLY. Without a `leading-`, the
  // line box comes from whatever is inherited, and Arabic — which sits taller
  // than Latin — clips its own descenders at a size nobody re-checks.
  for (const { name, text } of sources()) {
    for (const size of text.match(/text-\[[\d.]+px\]/g) ?? []) {
      const at = text.indexOf(size);
      const className = text.slice(text.lastIndexOf('"', at) + 1, text.indexOf('"', at));
      assert.match(className, /leading-/, `${name}: ${size} must state its leading`);
    }
  }
});

// ------------------------------------------------- 4. all three languages

test('every string on the profit screen exists in Arabic, English and Kurdish', () => {
  const pick = (which: 0 | 1 | 2) => (ar: string, en: string, ckb?: string) => {
    const all = [ar, en, ckb];
    const value = all[which];
    // A missing Kurdish argument is the defect this test exists for: `loc`
    // falls back to Arabic at runtime, so the gap is INVISIBLE on screen and
    // a Kurdish reader silently gets Arabic.
    return value === undefined ? '<<MISSING>>' : value;
  };

  for (const which of [0, 1, 2] as const) {
    const s = financeStrings(pick(which));
    for (const [key, value] of Object.entries(s)) {
      const text = typeof value === 'function' ? (value as (...a: string[]) => string)('٧', '٨') : value;
      assert.equal(typeof text, 'string', `${key} is not a string`);
      assert.ok(text.length > 0, `${key} is empty in language ${which}`);
      assert.doesNotMatch(text, /<<MISSING>>/, `${key} has no translation for language ${which}`);
    }
  }
});

test('the screen never decides a language by writing direction', () => {
  // `dir === 'rtl' ? ar : en` is banned across src/: 'ckb' is right-to-left
  // too, so the ternary hands Arabic to every Kurdish reader and no Arabic or
  // English tester ever sees it.
  for (const { name, text } of sources()) {
    const code = codeOf(text);
    assert.doesNotMatch(code, /dir\s*===\s*'rtl'\s*\?/, `${name} picks copy by direction instead of by language`);
    assert.doesNotMatch(code, /lang\s*===\s*'ar'\s*\?/, `${name} branches on Arabic instead of calling loc()`);
  }
});

// --------------------------------------------- 5. recharts stays lazy

test('recharts is reachable only through the lazy panel, never from the entry', () => {
  const app = read('src/App.tsx');
  const main = read('src/main.tsx');
  const admin = read('src/pages/Admin.tsx');

  // The entry and the app shell import it nowhere: `vendor-charts` is a manual
  // chunk (vite.config.ts) and tests/bundleBudget.test.ts asserts it is not in
  // the entry's static closure. A static import anywhere eager would put an
  // SVG charting engine into every customer's first visit.
  for (const [name, text] of [['src/App.tsx', app], ['src/main.tsx', main]] as const) {
    assert.doesNotMatch(text, /from\s+['"]recharts['"]/, `${name} must not import recharts`);
  }

  // The admin page reaches the panel through React.lazy and never statically.
  assert.match(admin, /const AdminFinance = React\.lazy\(\(\) => import\('\.\.\/components\/adminFinance\/AdminFinance'\)\)/);
  assert.doesNotMatch(admin, /^import .*adminFinance/m, 'the finance panel must not be a static import');
  assert.doesNotMatch(admin, /from\s+['"]recharts['"]/);

  // And inside the panel, recharts is imported by the two chart components
  // only — so a future card cannot pull it into a file that something eager
  // might one day import.
  const importers = sources().filter((f) => /from\s+['"]recharts['"]/.test(f.text)).map((f) => f.name);
  assert.deepEqual(importers.sort(), [
    `${DIR}/BreakdownChart.tsx`,
    `${DIR}/TimeSeriesChart.tsx`,
  ]);
});

// ------------------------------------------ 6. the palette was validated

test('the series colours are the validated dark-surface slots, unchanged', () => {
  // Re-run before changing any of these:
  //   node <dataviz>/scripts/validate_palette.js \
  //     "#3987e5,#199e70,#9085e9,#d95926" --mode dark --surface "#000000"
  // All six checks pass on this store's black surface AND on the card surface
  // #131519. A hue swapped without that run is a hue nobody has checked for
  // colour-vision separation or for contrast against the panel it sits on.
  assert.deepEqual(MEASURE_COLOR, {
    revenue: '#3987e5',
    gross_profit: '#199e70',
    net_profit: '#9085e9',
    expenses: '#d95926',
  });
  // Four measures, four distinct hues: a duplicate would make two different
  // quantities look like the same series across two cards.
  assert.equal(new Set(Object.values(MEASURE_COLOR)).size, 4);
  // Spending must never wear the profit colour.
  assert.notEqual(MEASURE_COLOR.expenses, MEASURE_COLOR.gross_profit);
});

// ------------------------------------- 7. the Baghdad day, and the period

test('the default period is a BAGHDAD day, so 01:00 in Iraq is not yesterday', () => {
  // 2026-09-19T22:30:00Z is 01:30 on the 20th in Baghdad. A UTC day string
  // would answer the 19th, and the owner opening the screen at that moment
  // would be shown a range that ends before today — with today's sales simply
  // missing and nothing on the screen saying so.
  const lateNight = Date.parse('2026-09-19T22:30:00Z');
  assert.equal(baghdadDay(lateNight), '2026-09-20');
  assert.equal(new Date(lateNight).toISOString().slice(0, 10), '2026-09-19', 'the UTC answer, for contrast');

  const today = presetRange('today', lateNight);
  assert.deepEqual(today, { from: '2026-09-20', to: '2026-09-20' });
  assert.deepEqual(presetRange('last7', lateNight), { from: '2026-09-14', to: '2026-09-20' });
  assert.deepEqual(presetRange('month', lateNight), { from: '2026-09-01', to: '2026-09-20' });
});

test('a range the owner types is checked before the request leaves', () => {
  assert.equal(rangeProblem('2026-09-01', '2026-09-30'), null);
  assert.equal(rangeProblem('2026-09-30', '2026-09-01'), 'reversed');
  assert.equal(rangeProblem('2026-02-31', '2026-03-01'), 'from_not_a_day', 'shape is not validity');
  assert.equal(rangeProblem('2026-09-01', 'yesterday'), 'to_not_a_day');
  assert.equal(rangeProblem('2024-01-01', '2026-01-01'), 'too_long', 'the server caps a range at 366 days');
});

test('a one-day period asks for one bucket instead of drawing a one-point line', () => {
  assert.equal(defaultGranularity(1), 'range');
  assert.equal(defaultGranularity(30), 'day');
  assert.equal(defaultGranularity(90), 'week');
  assert.equal(defaultGranularity(365), 'month');
});

// ------------------------------- 8. no per-product net profit, anywhere

test('a product row has no net profit — not as a column, not as a zero', () => {
  // The type omits the period-only fields exactly as the server's
  // `stripPeriodOnly` deletes them, so reading one off a product row is a
  // compile error rather than a plausible zero on a financial screen.
  const api = read('src/lib/api.ts');
  assert.match(api, /export type FinanceBreakdownTotals = Omit<FinanceTotals, FinancePeriodOnlyField>/);
  for (const field of ['net_profit_iqd', 'net_margin_percent', 'operating_expenses_iqd', 'points_redeemed_iqd']) {
    assert.match(api, new RegExp(`\\|\\s*'${field}'`), `${field} must be listed as period-only`);
  }
  // And the table that would be the natural place to add one says why there
  // is none, in the reader's own language.
  const tables = read(`${DIR}/Tables.tsx`);
  assert.doesNotMatch(tables, /net_profit_iqd/, 'no breakdown table may print a per-product net profit');
  assert.match(tables, /noPerProductNet/);
});

// -------------------------------------------- 9. the composition rules

test('one filter row scopes everything, and no chart card carries its own period', () => {
  const panel = read(`${DIR}/AdminFinance.tsx`);
  // Exactly one period control, mounted above the cards.
  assert.equal((panel.match(/<PeriodControl/g) ?? []).length, 1);
  for (const { name, text } of sources()) {
    if (name.endsWith('PeriodControl.tsx') || name.endsWith('AdminFinance.tsx')) continue;
    assert.doesNotMatch(text, /data-finance-preset/, `${name} must not grow its own date filter`);
  }
  // A refetch holds the previous render instead of flashing a skeleton.
  assert.match(panel, /opacity-50 transition-opacity/);
  assert.match(read(`${DIR}/Frame.tsx`), /opacity-50 transition-opacity/);
});

test('every chart ships its table twin and a legend where identity needs one', () => {
  const panel = read(`${DIR}/AdminFinance.tsx`);
  // THREE card components carry a toggle, and one of them — the breakdown — is
  // mounted three times (products, main categories, sub-categories). So four
  // charts on screen have four table twins, from three declarations. A tooltip
  // is never the only way to read a value on any of them.
  assert.equal((panel.match(/<TableToggle/g) ?? []).length, 3);
  assert.equal((panel.match(/<BreakdownCard/g) ?? []).length, 3);
  assert.equal((panel.match(/<OverTimeCard/g) ?? []).length, 1);
  assert.equal((panel.match(/<ExpensesCard/g) ?? []).length, 1);
  // The multi-series chart carries a legend; the single-series bars do not
  // need one (a legend box with one swatch just restates the card's title).
  assert.match(read(`${DIR}/TimeSeriesChart.tsx`), /<Legend/);
  assert.doesNotMatch(read(`${DIR}/BreakdownChart.tsx`), /<Legend/);
  // Gridlines are solid hairlines, never dashed.
  for (const { name, text } of sources()) {
    assert.doesNotMatch(text, /strokeDasharray/, `${name}: a dashed grid reads as a threshold`);
  }
});

// ============ 12. the decomposition adds up, and the ledger exists

test('every signed term of the decomposition sums EXACTLY to the net profit above it', () => {
  // THE PROPERTY THE CARD CLAIMS, ASSERTED. «حتى يستطيع المالك تفكيك الرقم بدل
  // أن يجادله» is only true if the printed terms reach the printed headline.
  // The order-level coupon was subtracted by the server and printed by
  // nothing, so the owner was handed a gap with nothing to attribute it to —
  // and no test could see it, because the field was missing from the client
  // type too and therefore could not fail to compile.
  const totals: FinanceTotals = {
    ...zeroTotals(),
    gross_revenue_iqd: 4_000_000,
    refunded_revenue_iqd: 200_000,
    revenue_iqd: 3_800_000,
    costed_revenue_iqd: 3_500_000,
    uncosted_revenue_iqd: 300_000,
    cogs_iqd: 2_100_000,
    gross_profit_iqd: 1_400_000,
    shipping_collected_iqd: 90_000,
    cod_tax_collected_iqd: 40_000,
    points_redeemed_iqd: 25_000,
    coupon_discount_iqd: 20_000,
    operating_expenses_iqd: 600_000,
    expense_entries: 4,
  };
  // The server's own arithmetic, written out by hand rather than recomputed
  // the way the code does: 1,400,000 + 90,000 + 40,000 − 25,000 − 20,000 − 600,000.
  totals.net_profit_iqd = 885_000;

  const s = financeStrings((ar: string) => ar);
  const lines = decompositionLines(totals, s);
  const sum = lines.reduce((n, l) => n + (l.addend ?? 0), 0);
  assert.equal(sum, totals.net_profit_iqd, 'the printed terms must reach the printed headline');
  // And the coupon is one of them, by name — so deleting the line fails here
  // rather than silently shrinking the sum by the coupons the shop gave away.
  assert.ok(lines.some((l) => l.label === s.couponDiscount && l.addend === -20_000));
});

test('the client mirror carries every period-only field the server strips', () => {
  // `FinancePeriodOnlyField` exists so `FinanceBreakdownTotals` omits exactly
  // what `stripPeriodOnly()` deletes. The two drifted once — the client listed
  // seven names where the server listed eight — and the missing one was the
  // coupon, which is why the decomposition above did not add up. This reads
  // the server's list and demands the client's match it name for name.
  const server = read('worker/lib/financeReport.ts');
  const block = server.slice(server.indexOf('export const PERIOD_ONLY_FIELDS'));
  const serverFields = [...block.slice(0, block.indexOf('] as const')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(serverFields.length >= 8, `expected the server's full list, saw ${serverFields.length}`);

  const api = read('src/lib/api.ts');
  const clientBlock = api.slice(api.indexOf('export type FinancePeriodOnlyField'));
  const clientFields = [...clientBlock.slice(0, clientBlock.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...clientFields].sort(), [...serverFields].sort(), 'the two period-only lists must not drift');
  // And every one of them is a real field on the client's own totals type.
  for (const f of serverFields) {
    assert.match(api, new RegExp(`\\n  ${f}:`), `FinanceTotals is missing ${f}`);
  }
});

test('an installed but empty expense ledger is disclosed, not read as «ما صرفنا شي»', () => {
  // The ledger table exists the moment migration 0095 lands, so
  // `no_expense_ledger` — which fires on a MISSING table — goes quiet exactly
  // when the owner has a screen to fill in and has not filled it in yet. That
  // is the first state a real shop sees, and «الربح الصافي» equals «الربح
  // الإجمالي» through it.
  const nothingEntered = reportOf({ revenue_iqd: 1_000_000, costed_revenue_iqd: 1_000_000, expense_entries: 0 });
  assert.deepEqual(honestyNotices(nothingEntered).map((n) => n.id), ['no_expenses_recorded']);

  const entered = reportOf({
    revenue_iqd: 1_000_000,
    costed_revenue_iqd: 1_000_000,
    expense_entries: 2,
    operating_expenses_iqd: 400_000,
  });
  assert.deepEqual(honestyNotices(entered).map((n) => n.id), [], 'once expenses exist there is nothing to warn about');

  // And a deployment with NO ledger still says the other thing — the two are
  // different sentences and must not collapse into one.
  const noTable = reportOf({ revenue_iqd: 1_000_000, costed_revenue_iqd: 1_000_000 }, { operating_expenses_available: false });
  assert.deepEqual(honestyNotices(noTable).map((n) => n.id), ['no_expense_ledger']);
});

test('the uncosted notice fires on the MONEY, never on a count worth nothing', () => {
  // A fully refunded composition leaves its parent line standing with its
  // revenue reversed to zero (returns.ts raises a case per component, never
  // one against the parent). Firing on the line count then printed «سطر بيع
  // واحد بقيمة ٠ د.ع لا تُعرف تكلفته» — a warning that reads as nothing to
  // worry about — on a screen whose whole job is that the warnings are real.
  const zeroWorth = reportOf({ revenue_iqd: 0, uncosted_lines: 1, uncosted_units: 1, uncosted_revenue_iqd: 0, expense_entries: 1 });
  assert.equal(honestyNotices(zeroWorth).some((n) => n.id === 'uncosted'), false);

  const realMoney = reportOf({ revenue_iqd: 200_000, uncosted_lines: 1, uncosted_units: 1, uncosted_revenue_iqd: 200_000, expense_entries: 1 });
  const notice = honestyNotices(realMoney).find((n) => n.id === 'uncosted');
  assert.ok(notice, 'revenue outside the margin base is always disclosed');
  assert.equal(notice.values.revenue, 200_000);
});

test('the expense ledger the owner asked for exists, and calls the endpoints that were built for it', () => {
  // «يستطيع الادمن في لوحه الاداره اضافه تكاليف اخرى». Eight endpoints and a
  // migration existed with no screen to reach them, so `operating_expenses`
  // could never receive a row and the net-profit hero subtracted a permanent
  // zero. This asserts the screen is wired, not that it is pretty.
  const api = read('src/lib/api.ts');
  for (const path of [
    '/api/admin/finance/expense-categories',
    '/api/admin/finance/expenses',
  ]) {
    assert.ok(api.includes(path), `src/lib/api.ts must call ${path}`);
  }
  const ledger = read(`${DIR}/ExpenseLedger.tsx`);
  for (const fn of ['createExpense', 'fetchExpenses', 'voidExpense', 'restoreExpense', 'createExpenseCategory']) {
    assert.ok(ledger.includes(fn), `the ledger screen must use ${fn}`);
  }
  // Removal is a VOID and the screen says so, rather than dressing it as a
  // delete the owner believes erased the row.
  assert.match(ledger, /voidMeans/);
  assert.doesNotMatch(codeOf(ledger), /window\.confirm/, 'a confirm dialog cannot be translated or read RTL');
  // It is reached from the panel, under the SAME period control.
  const panel = read(`${DIR}/AdminFinance.tsx`);
  assert.match(panel, /<ExpenseLedger/);
  assert.match(panel, /from=\{period\.from\}/);
  assert.equal((panel.match(/<PeriodControl/g) ?? []).length, 1, 'still exactly one period control');
});

test('the entry form refuses what the server refuses, before the request leaves', () => {
  const today = '2026-03-10';
  const ok = { category_id: 'exc_rent', amount: '600000', expense_day: '2026-03-01', repeat_months: 1 };
  assert.equal(expenseProblem(ok, today), null);

  // A NEGATIVE "expense" is a refund — a different fact. Accepting one would
  // let a mistyped minus sign cancel a real cost with nothing on screen.
  assert.equal(expenseProblem({ ...ok, amount: '-600000' }, today), 'amount_not_positive');
  assert.equal(expenseProblem({ ...ok, amount: '0' }, today), 'amount_not_positive');
  assert.equal(expenseProblem({ ...ok, amount: '12.5' }, today), 'amount_not_whole');
  assert.equal(expenseProblem({ ...ok, amount: '' }, today), 'amount_not_a_number');
  assert.equal(expenseProblem({ ...ok, amount: '  ' }, today), 'amount_not_a_number');
  assert.equal(expenseProblem({ ...ok, amount: '1000000000000' }, today), 'amount_too_large');
  // A well-shaped non-day: the right shape, not a date. An expense filed on
  // the 31st of February lands in a month nobody can reconcile.
  assert.equal(expenseProblem({ ...ok, expense_day: '2026-02-31' }, today), 'day_not_a_day');
  assert.equal(expenseProblem({ ...ok, expense_day: '2226-01-01' }, today), 'day_too_far');
  // Prepaid rent a few months out is legitimate and is NOT refused.
  assert.equal(expenseProblem({ ...ok, expense_day: '2026-09-01' }, today), null);
  assert.equal(expenseProblem({ ...ok, repeat_months: 0 }, today), 'repeat_out_of_range');
  assert.equal(expenseProblem({ ...ok, repeat_months: 25 }, today), 'repeat_out_of_range');
  assert.equal(expenseProblem({ ...ok, category_id: '' }, today), 'no_category');
});

test('the Kurdish disclosures say as much as the Arabic ones', () => {
  // ckb is present everywhere and test 9 proves it, but presence is not
  // content: the strings that carry the REASONING were abridged in Kurdish —
  // `netMeans` dropped the points term entirely, `emptyBody` dropped the «هذا
  // ليس خطأ في الشاشة» that is the whole point of the empty state. A Kurdish
  // reading admin got a materially weaker disclosure on the one screen where
  // disclosure IS the feature.
  const ar = financeStrings((a: string) => a);
  const ckb = financeStrings((a: string, _e: string, k?: string) => k || a);
  const multiClause = [
    'grossMeans', 'netMeans', 'noPerProductNet', 'noSnapshotColumn',
    'noExpenseLedger', 'noExpensesRecorded', 'onePoint', 'repeatMeans', 'voidMeans',
    'ledgerIntro', 'ledgerEmpty', 'intro',
  ] as const;
  for (const key of multiClause) {
    const a = String(ar[key]);
    const k = String(ckb[key]);
    assert.ok(k.length >= 0.5 * a.length, `${key}: the Kurdish is an abridgement (${k.length} vs ${a.length} chars)`);
  }
  // The sentence-building notices too, fed the same arguments.
  for (const key of ['estimatedLines', 'uncosted', 'unrecognizedOrders', 'unbucketed'] as const) {
    const a = (ar[key] as (x: string, y: string) => string)('٧', '٩٠٠٠٠');
    const k = (ckb[key] as (x: string, y: string) => string)('٧', '٩٠٠٠٠');
    assert.ok(k.length >= 0.5 * a.length, `${key}: the Kurdish is an abridgement`);
  }
});

test('a bucket is found by its identity, never by the label printed on the axis', () => {
  // `bucketLabel` drops the YEAR so the ticks stay readable, so day/month is
  // unique only inside a 365-day window — and MAX_RANGE_DAYS is 366, which
  // `rangeProblem` accepts. Re-finding the hovered datum by that string showed
  // the earlier year's numbers on the later year's point, with nothing looking
  // broken.
  assert.equal(rangeProblem('2025-09-19', '2026-09-19'), null, '366 days is an accepted range');
  const chart = codeOf(read(`${DIR}/TimeSeriesChart.tsx`));
  assert.doesNotMatch(chart, /points\.find\(/, 'the tooltip must not re-derive its datum from a label');
  assert.match(chart, /payload\?\.\[0\]\?\.payload/, 'the hovered row comes from the payload recharts hands it');
});

test('a negative bar keeps its label inside the plot, and gets a zero line to measure from', () => {
  const chart = codeOf(read(`${DIR}/BreakdownChart.tsx`));
  // The value margin used to be reserved on ONE side — the side a POSITIVE
  // bar's tip lands on — so a refunded product's figure was drawn across the
  // category names in the 8px gutter.
  assert.match(chart, /anyNegative/);
  assert.match(chart, /ReferenceLine x=\{0\}/);
  // And the chrome is sized against the card, so a 360px phone does not spend
  // two thirds of the plot on an axis label.
  assert.match(chart, /Math\.min\(132/);
  assert.match(chart, /Math\.min\(76/);
});
