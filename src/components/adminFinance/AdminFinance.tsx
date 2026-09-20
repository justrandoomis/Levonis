import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import {
  ApiError,
  fetchFinanceCategories,
  fetchFinanceProducts,
  fetchFinanceSummary,
  isAborted,
  type FinanceBreakdownRow,
  type FinanceCategoriesReport,
  type FinanceExpenseCategoryTotal,
  type FinanceGranularity,
  type FinancePeriodReport,
  type FinanceProductsReport,
  type FinanceTotals,
} from '../../lib/api';
import BreakdownChart, { type BreakdownDatum } from './BreakdownChart';
import TimeSeriesChart, { toTimePoints } from './TimeSeriesChart';
import PeriodControl, { type PeriodValue } from './PeriodControl';
import { BreakdownTable, ExpenseTable, PeriodTable } from './Tables';
import {
  ChartCard,
  Delta,
  EstimateBadge,
  HeroFigure,
  HonestyLine,
  StatTile,
  TableToggle,
  useTableView,
} from './Frame';
import { MEASURE_COLOR } from './palette';
import { countText, isLatin, money, percent, rangeLabel } from './format';
import { honestyNotices, isEstimated, type Notice } from './honesty';
import { defaultGranularity, presetRange, rangeProblem, type PresetId } from './period';
import { financeStrings } from './strings';
import ExpenseLedger from './ExpenseLedger';

/**
 * «لوحة الأرباح» — WHAT THE SHOP EARNED, AND WHAT IT COST TO EARN IT.
 *
 * ###########################################################################
 * #  TWO PROFITS. THEY ARE NEVER MERGED, AND THE SCREEN SAYS WHY.           #
 * ###########################################################################
 * The owner's own model, in their words: «التكلفه على مستوى واحد في تفاصيل
 * المنتج، لكن يستطيع الادمن في لوحه الاداره اضافه تكاليف اخرى ... لا علاقه لها
 * بالمنتج الاساسي او ما يظهر للمستخدم، انها خاصه في لوحه الادمن».
 *
 *   GROSS PROFIT = revenue − cost of goods sold. Every dinar of it belongs to
 *                  a product, so it is broken down by product, by main
 *                  category and by sub-category.
 *   NET PROFIT   = gross profit + delivery and COD fees collected − points
 *                  redeemed − operating expenses. PER PERIOD ONLY.
 *
 * A single number called «الربح» that the owner cannot decompose is worse than
 * two honest ones, so both are on screen, each says what it is made of, and
 * there is no per-product net profit anywhere — not as a column, not as a
 * zero, not as an option. `FinanceBreakdownTotals` omits the field, so adding
 * one would not compile.
 *
 * ---------------------------------------------------------------------------
 * EVERY BYTE ON THIS SCREEN IS BEHIND THE FINANCIAL GATE (mandate §11).
 *
 * «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن العادي
 * لا يراها في API ولا في HTML ولا في export». The three endpoints refuse an
 * assistant admin at the door with `FINANCIAL_SCOPE_REQUIRED` — the whole
 * router, before a query runs. This component therefore renders a REFUSAL, not
 * an error, on a 403: nothing here was fetched, so there is nothing to strip,
 * and the person reading it needs to know it is a permission and not a bug.
 * The tab is also hidden from an assistant in src/pages/Admin.tsx, but that is
 * a courtesy — the server is the gate.
 *
 * ---------------------------------------------------------------------------
 * ONE SLICE, ONE CONTROL, EVERY FIGURE.
 *
 * The period control at the top scopes the hero figures, all four charts and
 * all four tables. They are fetched together and replaced together, so two
 * numbers on this screen can never describe two different months.
 *
 * WHILE A NEW SLICE LOADS, THE OLD RENDER STAYS at reduced opacity. Skeletons
 * would flash the entire page and jump the layout on a control the owner will
 * press a dozen times in a sitting.
 */

/** How many rows a breakdown chart draws. Beyond this a table is the honest form. */
const BREAKDOWN_ROWS = 12;

interface Loaded {
  report: FinancePeriodReport;
  products: FinanceProductsReport;
  main: FinanceCategoriesReport;
  sub: FinanceCategoriesReport;
}

export default function AdminFinance() {
  const { loc, lang, dir } = useLanguage();
  const s = useMemo(() => financeStrings(loc), [loc]);
  const latin = isLatin(lang);
  const rtl = dir === 'rtl';

  const [period, setPeriod] = useState<PeriodValue>(() => {
    const initial = presetRange('last30', Date.now());
    return { preset: 'last30', ...initial, granularity: defaultGranularity(30) };
  });
  const [draft, setDraft] = useState({ from: period.from, to: period.to });
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * WHICH VIEW OF THE SAME PERIOD IS OPEN.
   *
   * The report READS operating expenses; the ledger WRITES them. They are two
   * views of one slice of time, not two screens, so they share the period row
   * above them: a second date picker inside the ledger is how the owner ends
   * up reading a March ledger beside an April profit with nothing on screen to
   * say which is which. This is a view switch, not a per-card filter — the
   * composition rule the period control's own header states is about a filter
   * that scopes ONE card while others keep another scope, and there is only
   * ever one scope here.
   */
  const [view, setView] = useState<'report' | 'ledger'>('report');

  const { from, to, granularity } = period;

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    const range = { from, to };
    Promise.all([
      fetchFinanceSummary({ ...range, granularity }, { signal: ac.signal }),
      fetchFinanceProducts({ ...range, limit: BREAKDOWN_ROWS }, { signal: ac.signal }),
      fetchFinanceCategories({ ...range, level: 'main', limit: BREAKDOWN_ROWS }, { signal: ac.signal }),
      fetchFinanceCategories({ ...range, level: 'sub', limit: BREAKDOWN_ROWS }, { signal: ac.signal }),
    ])
      .then(([report, products, main, sub]) => {
        if (ac.signal.aborted) return;
        setData({ report, products, main, sub });
      })
      .catch((e) => {
        // A cancelled request is the effect cleaning up after a period change,
        // never something to show: the next request is already in flight.
        if (ac.signal.aborted || isAborted(e)) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [from, to, granularity, reloadKey]);

  const onPreset = useCallback((id: PresetId) => {
    const next = presetRange(id, Date.now());
    setDraft(next);
    // A preset carries its own natural grouping with it: thirty days read in
    // months is a single bar, and a single day read in days is a one-point
    // line that draws nothing. `defaultGranularity` answers 'range' for a
    // one-day span for exactly that reason. The owner can still override it
    // afterwards — the grouping buttons sit in the same row.
    setPeriod({ preset: id, ...next, granularity: defaultGranularity(daysOf(next.from, next.to)) });
  }, []);

  const onApply = useCallback(() => {
    if (rangeProblem(draft.from, draft.to)) return;
    setPeriod((prev) => ({
      ...prev,
      preset: 'custom',
      from: draft.from,
      to: draft.to,
      granularity: defaultGranularity(daysOf(draft.from, draft.to)),
    }));
  }, [draft]);

  const onGranularity = useCallback((g: FinanceGranularity) => {
    setPeriod((prev) => ({ ...prev, granularity: g }));
  }, []);

  const problem = period.preset === 'custom' ? rangeProblem(draft.from, draft.to) : null;

  // ------------------------------------------------------------- the refusal
  if (error instanceof ApiError && error.status === 403) {
    return (
      <section dir={dir} className="mx-auto max-w-[36rem] py-14 text-center">
        <ShieldAlert className="mx-auto h-8 w-8 text-warning" aria-hidden />
        <h2 className="mt-3 text-[16px] leading-[1.4] font-black text-text-primary">{s.title}</h2>
        <p className="mt-2 text-[13px] leading-[1.8] text-text-secondary">{s.forbidden}</p>
      </section>
    );
  }

  const report = data?.report ?? null;
  const totals = report?.totals ?? null;
  const points = report ? toTimePoints(report.buckets, latin) : [];
  const notices: Notice[] = report ? honestyNotices(report) : [];
  const estimated = report ? isEstimated(report) : false;

  const nameOf = (row: { name_ar: string; name_en: string; name_ckb: string; id: string | null }): string => {
    // `loc(ar, en, ckb)` and never a direction test: 'ckb' is right-to-left
    // too, so `dir === 'rtl' ? ar : en` would serve Arabic to every Kurdish
    // reader. Products carry no Kurdish name at all (the server says so), so
    // the third argument is empty and `loc` falls through to Arabic — which is
    // the right answer, and the reason this is not a bug to fix here.
    const picked = loc(row.name_ar, row.name_en || row.name_ar, row.name_ckb);
    if (picked) return picked;
    return row.id === null ? s.unfiled : s.unnamed;
  };

  const toDatum = (row: FinanceBreakdownRow): BreakdownDatum => ({
    id: row.id ?? `${row.slug}|null`,
    name: nameOf(row),
    value: row.totals.gross_profit_iqd,
    estimated: row.totals.estimated,
    tooltip: [
      { label: s.colRevenue, value: money(row.totals.revenue_iqd) },
      { label: s.colCogs, value: money(row.totals.cogs_iqd) },
      { label: s.colGross, value: money(row.totals.gross_profit_iqd) },
      { label: s.colMargin, value: percent(row.totals.gross_margin_percent, latin) },
      { label: s.colUnits, value: countText(row.totals.units, latin) },
    ],
  });

  // The server pages these by REVENUE (its own truncation is a revenue
  // ranking), and the chart plots GROSS PROFIT — so the rows are re-ordered by
  // the thing the bars actually show, and the card's hint states both facts.
  // Sorting by one number while claiming to rank by another is how a "top
  // products" chart ends up with its longest bar in the middle.
  const byGross = (rows: FinanceBreakdownRow[]): FinanceBreakdownRow[] =>
    [...rows].sort((a, b) => b.totals.gross_profit_iqd - a.totals.gross_profit_iqd);

  const expenseName = (row: FinanceExpenseCategoryTotal): string =>
    loc(row.name_ar, row.name_en || row.name_ar, row.name_ckb) || (row.id === null ? s.unfiled : s.unnamed);

  const noticeText = (n: Notice): string => {
    switch (n.id) {
      case 'no_cost_snapshot':
        return s.noSnapshotColumn;
      case 'fifo_measured':
        return s.fifoMeasured(countText(n.values.lines, latin), money(n.values.cost), money(n.values.total));
      case 'estimated':
        return s.estimatedLines(countText(n.values.lines, latin), money(n.values.cost));
      case 'uncosted':
        return s.uncosted(countText(n.values.lines, latin), money(n.values.revenue));
      case 'no_expense_ledger':
        return s.noExpenseLedger;
      case 'no_expenses_recorded':
        return s.noExpensesRecorded;
      case 'unrecognized_orders':
        return s.unrecognizedOrders(countText(n.values.orders, latin));
      case 'unbucketed':
        return s.unbucketed(countText(n.values.lines, latin), money(n.values.amount));
    }
  };

  /**
   * NO SALES — which is not the same thing as NOTHING HAPPENED.
   *
   * Operating expenses are deliberately not in this test: a month with rent
   * and no orders is a real month, and it is the FIRST month for a shop whose
   * owner has just been handed an expense ledger to fill in. The empty-state
   * notice below still appears, because it teaches the recognition rule the
   * owner needs; what must not happen is the screen hiding the expense
   * breakdown and the decomposition while the hero above prints a loss. That
   * left the owner looking at a negative headline, a sentence saying no order
   * was delivered, and nothing at all to say where the money went.
   */
  const noSales =
    !!totals && totals.orders === 0 && totals.revenue_iqd === 0 && totals.gross_revenue_iqd === 0;
  /** Was anything SPENT? A period with spending is a period worth decomposing. */
  const anySpending =
    !!report && (report.totals.operating_expenses_iqd !== 0 || report.expense_categories.length > 0);

  return (
    <section dir={dir} data-admin-finance className="min-w-0 space-y-4">
      {/* ------------------------------------------------------ 1. THE HEADER */}
      <header className="min-w-0">
        <h2 className="text-lg leading-tight font-black text-text-primary">{s.title}</h2>
        <p className="mt-1 max-w-[70ch] text-[12px] leading-[1.8] text-text-muted">{s.intro}</p>
        <p className="mt-1 max-w-[70ch] text-[11px] leading-[1.8] text-text-muted">{s.ownerOnly}</p>
      </header>

      {/* --------------------------------------- 2. THE ONE CONTROL, ONE ROW */}
      {/* --------------------------------- 1b. THE TWO VIEWS OF ONE PERIOD */}
      <div role="group" aria-label={s.title} className="flex flex-wrap items-center gap-1.5">
        {(['report', 'ledger'] as const).map((id) => (
          <button
            key={id}
            type="button"
            data-finance-view={id}
            aria-pressed={view === id}
            onClick={() => setView(id)}
            className="lv-choice press-scale min-h-[44px] px-3 text-[12px] leading-[1.5] font-bold"
          >
            {id === 'report' ? s.tabReport : s.tabLedger}
          </button>
        ))}
      </div>

      <PeriodControl
        value={period}
        draft={draft}
        problem={problem}
        loading={loading}
        s={s}
        latin={latin}
        onPreset={onPreset}
        onDraft={setDraft}
        onApply={onApply}
        onGranularity={onGranularity}
        onRefresh={() => setReloadKey((k) => k + 1)}
      />

      {view === 'ledger' && (
        <ExpenseLedger
          from={period.from}
          to={period.to}
          s={s}
          latin={latin}
          dir={rtl ? 'rtl' : 'ltr'}
          // A written expense changes the period's NET profit, so the report
          // is re-fetched rather than left showing the figure from before the
          // rent was entered.
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}

      {view === 'report' && error && !(error instanceof ApiError && error.status === 403) && (
        <div className="lv-alert lv-alert-danger flex flex-wrap items-center gap-3">
          <p className="text-[13px] leading-[1.6] text-text-primary">
            {error instanceof ApiError ? error.message : s.loadFailed}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="lv-button lv-button-secondary lv-button-sm press-scale"
          >
            {s.retry}
          </button>
        </div>
      )}

      {view === 'report' && !report && loading && (
        <p className="py-16 text-center text-[13px] leading-[1.7] text-text-muted">{s.loading}</p>
      )}

      {/*
        `data` is named in the guard as well as `report`: this tsconfig has
        strictNullChecks OFF, so the compiler will not object to `data.products`
        under a `report &&` test even though nothing narrows `data` from it.
        The guard has to be written by hand or a first render with no data at
        all throws inside the tree and blanks the whole admin page.
      */}
      {view === 'report' && data && report && totals && (
        <div className={loading ? 'space-y-4 opacity-50 transition-opacity duration-200' : 'space-y-4 transition-opacity duration-200'}>
          {/* ------------------------------------- 3. THE HEADLINE AND TILES */}
          <div className="lv-surface p-3 sm:p-4">
            <HeroFigure
              label={s.netProfit}
              value={money(totals.net_profit_iqd)}
              meaning={s.netMeans}
              marker={
                estimated ? (
                  <EstimateBadge
                    label={s.estimatedBadge}
                    detail={s.estimatedLines(countText(totals.estimated_lines, latin), money(totals.estimated_cogs_iqd))}
                  />
                ) : undefined
              }
              delta={
                <Delta
                  amount={report.change.net_profit_iqd}
                  percent={report.change.net_profit_percent}
                  goodDirection="up"
                  latin={latin}
                  s={s}
                />
              }
            />
            {/*
              NET PROFIT SUBTRACTS 100% OF THE OPEX AND COUNTS 0% OF THE MARGIN
              ON SALES WHOSE COST IS UNKNOWN.

              `gross_profit` is `costed_revenue − cogs`, so revenue with no
              known cost is excluded from BOTH sides — correct for a margin,
              and a real distortion for a PERIOD PROFIT, because that money was
              actually collected while rent and salaries come off in full. On a
              shop whose history predates the cost snapshot this is not a
              corner case; the hero can read deeply negative for a reason the
              owner cannot see anywhere on the screen.

              So it is said HERE, beside the number, and not only in the
              honesty panel below: a caution about the headline belongs with
              the headline. The share is stated so the owner can judge how much
              of the figure it explains.
            */}
            {totals.uncosted_revenue_iqd > 0 && totals.revenue_iqd > 0 && (
              <p data-finance-net-caution className="mt-2 max-w-[60ch] text-[11px] leading-[1.7] text-warning">
                {s.netOnKnownCostOnly(
                  percent(
                    Math.round((totals.uncosted_revenue_iqd * 10_000) / totals.revenue_iqd) / 100,
                    latin
                  ),
                  money(totals.uncosted_revenue_iqd)
                )}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-[1.6] text-text-muted">
              {s.previousPeriod} {s.equalLength}:{' '}
              <span dir="ltr">{rangeLabel(report.previous.range.from, report.previous.range.to, latin)}</span>
              {' · '}
              <span dir="ltr" className="tabular-nums">{money(report.previous.totals.net_profit_iqd)}</span>
            </p>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                testId="revenue"
                label={s.revenue}
                value={money(totals.revenue_iqd)}
                note={`${s.grossRevenue} ${money(totals.gross_revenue_iqd)}`}
                delta={
                  <Delta
                    amount={report.change.revenue_iqd}
                    percent={report.change.revenue_percent}
                    goodDirection="up"
                    latin={latin}
                    s={s}
                    compact
                  />
                }
              />
              <StatTile
                testId="gross-profit"
                label={s.grossProfit}
                value={money(totals.gross_profit_iqd)}
                note={s.grossShort}
                marker={
                  estimated ? (
                    <EstimateBadge
                      label={s.estimatedBadge}
                      detail={s.estimatedLines(countText(totals.estimated_lines, latin), money(totals.estimated_cogs_iqd))}
                    />
                  ) : undefined
                }
                delta={
                  <Delta
                    amount={report.change.gross_profit_iqd}
                    percent={report.change.gross_profit_percent}
                    goodDirection="up"
                    latin={latin}
                    s={s}
                    compact
                  />
                }
              />
              <StatTile
                testId="gross-margin"
                label={s.grossMargin}
                value={percent(totals.gross_margin_percent, latin)}
                note={`${s.costedRevenue}: ${money(totals.costed_revenue_iqd)}`}
              />
              <StatTile
                testId="opex"
                label={s.opex}
                value={money(totals.operating_expenses_iqd)}
                note={`${countText(totals.expense_entries, latin)} ${s.colEntries}`}
              />
            </div>
          </div>

          {/* ------------------------------- 4. WHAT THE SCREEN MUST ADMIT */}
          {notices.length > 0 && (
            <div data-finance-honesty-panel className="lv-surface p-3 sm:p-4">
              <h3 className="text-[13px] leading-[1.5] font-black text-text-primary">{s.honestyTitle}</h3>
              <ul className="mt-2 space-y-2">
                {notices.map((n) => (
                  <HonestyLine key={n.id} tone={n.tone} text={noticeText(n)} />
                ))}
              </ul>
            </div>
          )}

          {/* --------------------------------------- 5. THE EMPTY STATE. */}
          {noSales && (
            <div data-finance-empty className="lv-surface p-6 text-center">
              <h3 className="text-[15px] leading-[1.4] font-black text-text-primary">{s.emptyTitle}</h3>
              <p className="mx-auto mt-2 max-w-[52ch] text-[13px] leading-[1.9] text-text-secondary">
                {s.emptyBody(rangeLabel(period.from, period.to, latin))}
              </p>
            </div>
          )}

          {/* The SALES cards, which have nothing to draw without sales. */}
          {!noSales && (
            <>
              <OverTimeCard points={points} rtl={rtl} latin={latin} s={s} loading={loading} />

              <BreakdownCard
                title={s.productsTitle}
                rows={byGross(data.products.products)}
                truncated={data.products.truncated}
                nameOf={nameOf}
                toDatum={toDatum}
                s={s}
                rtl={rtl}
                latin={latin}
                testId="products"
              />

              <BreakdownCard
                title={s.mainCategoriesTitle}
                rows={byGross(data.main.categories)}
                truncated={data.main.truncated}
                nameOf={nameOf}
                toDatum={toDatum}
                s={s}
                rtl={rtl}
                latin={latin}
                testId="main-categories"
              />

              <BreakdownCard
                title={s.subCategoriesTitle}
                rows={byGross(data.sub.categories)}
                truncated={data.sub.truncated}
                nameOf={nameOf}
                toDatum={toDatum}
                s={s}
                rtl={rtl}
                latin={latin}
                testId="sub-categories"
              />

            </>
          )}

          {/* SPENDING AND THE DECOMPOSITION STAND ON THEIR OWN. They are shown
              whenever there were sales OR there was spending — the period the
              owner most needs taken apart is the one with money going out and
              none coming in, and that is exactly the period the sales test
              above would have blanked. */}
          {(!noSales || anySpending) && (
            <>
              <ExpensesCard
                rows={report.expense_categories}
                nameOf={expenseName}
                s={s}
                rtl={rtl}
                latin={latin}
              />

              <DecompositionCard report={report} s={s} latin={latin} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Inclusive day count between two 'YYYY-MM-DD' strings, never via `Date`. */
function daysOf(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  const days = Math.round((b - a) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 1;
}

function OverTimeCard({
  points,
  rtl,
  latin,
  s,
  loading,
}: {
  points: ReturnType<typeof toTimePoints>;
  rtl: boolean;
  latin: boolean;
  s: ReturnType<typeof financeStrings>;
  loading: boolean;
}) {
  const [showTable, setShowTable] = useTableView();
  return (
    <ChartCard
      testId="over-time"
      title={s.overTimeTitle}
      caption={s.overTimeCaption}
      dim={loading}
      action={<TableToggle showTable={showTable} onToggle={setShowTable} s={s} />}
    >
      {showTable ? (
        <PeriodTable points={points} s={s} latin={latin} />
      ) : (
        <TimeSeriesChart points={points} rtl={rtl} latin={latin} s={s} />
      )}
    </ChartCard>
  );
}

function BreakdownCard({
  title,
  rows,
  truncated,
  nameOf,
  toDatum,
  s,
  rtl,
  latin,
  testId,
}: {
  title: string;
  rows: FinanceBreakdownRow[];
  truncated: boolean;
  nameOf: (row: FinanceBreakdownRow) => string;
  toDatum: (row: FinanceBreakdownRow) => BreakdownDatum;
  s: ReturnType<typeof financeStrings>;
  rtl: boolean;
  latin: boolean;
  testId: string;
}) {
  const [showTable, setShowTable] = useTableView();
  const shown = countText(rows.length, latin);
  return (
    <ChartCard
      testId={testId}
      title={title}
      caption={s.grossMeans}
      hint={
        rows.length > 0 ? (
          <p className="text-[11px] leading-[1.6] text-text-muted">
            {s.topSelection(shown)}
            {truncated ? ` ${s.truncated(shown)}` : ''}
          </p>
        ) : undefined
      }
      action={<TableToggle showTable={showTable} onToggle={setShowTable} s={s} />}
    >
      {showTable ? (
        <BreakdownTable rows={rows} nameOf={nameOf} s={s} latin={latin} testId={testId} />
      ) : (
        <BreakdownChart
          rows={rows.map(toDatum)}
          color={MEASURE_COLOR.gross_profit}
          rtl={rtl}
          latin={latin}
          emptyText={s.emptyChart}
          testId={testId}
        />
      )}
    </ChartCard>
  );
}

function ExpensesCard({
  rows,
  nameOf,
  s,
  rtl,
  latin,
}: {
  rows: FinanceExpenseCategoryTotal[];
  nameOf: (row: FinanceExpenseCategoryTotal) => string;
  s: ReturnType<typeof financeStrings>;
  rtl: boolean;
  latin: boolean;
}) {
  const [showTable, setShowTable] = useTableView();
  return (
    <ChartCard
      testId="expenses"
      title={s.expensesTitle}
      caption={s.expensesCaption}
      action={<TableToggle showTable={showTable} onToggle={setShowTable} s={s} />}
    >
      {showTable ? (
        <ExpenseTable rows={rows} nameOf={nameOf} s={s} latin={latin} />
      ) : (
        <BreakdownChart
          rows={rows.map((row) => ({
            id: row.id ?? `${row.slug}|null`,
            name: nameOf(row),
            value: row.amount_iqd,
            estimated: false,
            tooltip: [
              { label: s.colAmount, value: money(row.amount_iqd) },
              { label: s.colEntries, value: countText(row.entries, latin) },
            ],
          }))}
          // Spending wears its own hue for the whole dashboard. It is never the
          // profit colour: an owner who learned that aqua is profit must not
          // meet an aqua bar that means money leaving.
          color={MEASURE_COLOR.expenses}
          rtl={rtl}
          latin={latin}
          emptyText={s.emptyExpenses}
          testId="expenses"
        />
      )}
    </ChartCard>
  );
}

/**
 * THE TERMS OF THE HEADLINE, AS DATA.
 *
 * Pulled out of the card's render so the one property this card claims —
 * «كل سطر من حساب الخادم مطبوع هنا» — can be asserted instead of trusted.
 * `addend` is the SIGNED contribution of the row to net profit, or null for a
 * row that is a subtotal or a disclosure rather than a term; a test folds the
 * addends and checks the sum is exactly `net_profit_iqd`.
 *
 * That assertion exists because a term HAS already gone missing here: the
 * order-level coupon was subtracted by the server and printed by nothing, so
 * the card handed the owner a gap it could not explain — on the card whose
 * only job is that there is never a gap. A dropped field does not fail to
 * compile once it is also missing from the wire type, so it has to fail an
 * arithmetic assertion instead.
 */
export function decompositionLines(
  t: FinanceTotals,
  s: ReturnType<typeof financeStrings>
): Array<{ label: string; value: string; addend: number | null; strong?: boolean }> {
  return [
    { label: s.grossRevenue, value: money(t.gross_revenue_iqd), addend: null },
    { label: s.refundedRevenue, value: money(-t.refunded_revenue_iqd), addend: null },
    { label: s.revenue, value: money(t.revenue_iqd), addend: null, strong: true },
    { label: s.costedRevenue, value: money(t.costed_revenue_iqd), addend: null },
    { label: s.uncostedRevenue, value: money(t.uncosted_revenue_iqd), addend: null },
    { label: s.cogs, value: money(-t.cogs_iqd), addend: null },
    // From here down every row IS a term of `seal()`'s net-profit arithmetic,
    // in the order the server applies it.
    { label: s.grossProfit, value: money(t.gross_profit_iqd), addend: t.gross_profit_iqd, strong: true },
    { label: s.shipping, value: money(t.shipping_collected_iqd), addend: t.shipping_collected_iqd },
    { label: s.codTax, value: money(t.cod_tax_collected_iqd), addend: t.cod_tax_collected_iqd },
    { label: s.points, value: money(-t.points_redeemed_iqd), addend: -t.points_redeemed_iqd },
    { label: s.couponDiscount, value: money(-t.coupon_discount_iqd), addend: -t.coupon_discount_iqd },
    { label: s.opex, value: money(-t.operating_expenses_iqd), addend: -t.operating_expenses_iqd },
    { label: s.netProfit, value: money(t.net_profit_iqd), addend: null, strong: true },
  ];
}

/**
 * HOW THE HEADLINE WAS REACHED, LINE BY LINE.
 *
 * The owner must be able to take «الربح الصافي» apart. Every term of the
 * server's own arithmetic is printed here in the order it is applied, so a
 * figure that looks wrong can be traced to the line that made it wrong instead
 * of being argued about.
 */
function DecompositionCard({
  report,
  s,
  latin,
}: {
  report: FinancePeriodReport;
  s: ReturnType<typeof financeStrings>;
  latin: boolean;
}) {
  const t = report.totals;
  const lines = decompositionLines(t, s);
  return (
    <ChartCard testId="decomposition" title={s.breakdownTitle} caption={s.netMeans}>
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {lines.map((line) => (
          <div
            key={line.label}
            className={`flex items-baseline justify-between gap-3 border-b border-border-subtle/60 py-1.5 ${
              line.strong ? 'font-black text-text-primary' : ''
            }`}
          >
            <dt className="text-[12px] leading-[1.6] text-text-secondary">{line.label}</dt>
            <dd dir="ltr" className="text-[12px] leading-[1.6] tabular-nums text-text-primary">
              {line.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] leading-[1.7] text-text-muted">
        {s.refundCases}: {countText(t.refund_cases, latin)} · {s.orders}: {countText(t.orders, latin)} ·{' '}
        {countText(t.units, latin)} {s.units}
      </p>
    </ChartCard>
  );
}
