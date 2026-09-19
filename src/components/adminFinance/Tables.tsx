import React from 'react';
import type { FinanceBreakdownRow, FinanceExpenseCategoryTotal } from '../../lib/api';
import { countText, money, percent } from './format';
import type { FinanceStrings } from './strings';
import type { TimePoint } from './TimeSeriesChart';

/**
 * THE TABLE TWIN OF EVERY CHART ON THIS SCREEN.
 *
 * A tooltip enhances; it never gates. Every value any chart here can show is
 * also reachable as text, in a table, without a pointer — which is what makes
 * the charts safe to draw at all for a reader using a keyboard, a screen
 * reader, or a phone where hovering does not exist. It is also simply what an
 * owner wants half the time: comparing two products is a job for two rows, not
 * for two hovers.
 *
 * NUMBERS ARE `tabular-nums` HERE AND NOWHERE ELSE ON THE SCREEN. Equal-width
 * digits are what let a column of dinars line up on its thousands separator;
 * the same setting on the hero figure would make it look loose, so it is
 * applied to table cells and axis ticks only.
 *
 * MONEY IS LTR INSIDE AN RTL TABLE. «1,250,000 د.ع» is a Latin-digit number
 * with an Arabic unit; without `dir="ltr"` on the cell the bidi algorithm can
 * reorder a negative sign or a thousands separator and print a different
 * number than the one in the data.
 */

const th = 'px-2 py-2 text-start text-[11px] leading-[1.5] font-bold text-text-muted whitespace-nowrap';
const td = 'px-2 py-2 text-start text-[12px] leading-[1.5] text-text-secondary whitespace-nowrap';
const tdNum = `${td} tabular-nums`;

function Estimated({ s }: { s: FinanceStrings }) {
  return (
    <span className="ms-1.5 rounded border border-warning/35 px-1 py-px text-[10px] leading-[1.4] font-bold text-warning">
      {s.estimatedBadge}
    </span>
  );
}

/** Products, main categories and sub-categories all print the same columns. */
export function BreakdownTable({
  rows,
  nameOf,
  s,
  latin,
  testId,
}: {
  rows: FinanceBreakdownRow[];
  nameOf: (row: FinanceBreakdownRow) => string;
  s: FinanceStrings;
  latin: boolean;
  testId?: string;
}) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table data-finance-table={testId} className="w-full min-w-[34rem] border-collapse">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className={th}>{s.colName}</th>
            <th className={th}>{s.colRevenue}</th>
            <th className={th}>{s.colCogs}</th>
            <th className={th}>{s.colGross}</th>
            <th className={th}>{s.colMargin}</th>
            <th className={th}>{s.colUnits}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id ?? `${row.slug}|null`} className="border-b border-border-subtle/60">
              <td className={`${td} whitespace-normal font-bold text-text-primary`}>
                {nameOf(row)}
                {row.totals.estimated && <Estimated s={s} />}
              </td>
              <td className={tdNum} dir="ltr">{money(row.totals.revenue_iqd)}</td>
              <td className={tdNum} dir="ltr">{money(row.totals.cogs_iqd)}</td>
              <td className={`${tdNum} font-bold text-text-primary`} dir="ltr">
                {money(row.totals.gross_profit_iqd)}
              </td>
              <td className={tdNum} dir="ltr">{percent(row.totals.gross_margin_percent, latin)}</td>
              <td className={tdNum}>{countText(row.totals.units, latin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/*
        THE COLUMN THAT IS DELIBERATELY ABSENT.
        There is no net-profit column on a product row and there cannot be one:
        `FinanceBreakdownTotals` omits the field, so writing it here would not
        render a zero — it would fail to compile. The sentence says why, where
        the owner would otherwise look for it.
      */}
      <p className="mt-2 text-[11px] leading-[1.7] text-text-muted">{s.noPerProductNet}</p>
    </div>
  );
}

/** The period chart's twin: one row per bucket. */
export function PeriodTable({
  points,
  s,
  latin,
}: {
  points: TimePoint[];
  s: FinanceStrings;
  latin: boolean;
}) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table data-finance-table="period" className="w-full min-w-[32rem] border-collapse">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className={th}>{s.colPeriod}</th>
            <th className={th}>{s.revenue}</th>
            <th className={th}>{s.grossProfit}</th>
            <th className={th}>{s.netProfit}</th>
            <th className={th}>{s.colMargin}</th>
            <th className={th}>{s.orders}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key} className="border-b border-border-subtle/60">
              <td className={`${td} font-bold text-text-primary`}>
                {p.label}
                {p.estimated && <Estimated s={s} />}
              </td>
              <td className={tdNum} dir="ltr">{money(p.revenue)}</td>
              <td className={tdNum} dir="ltr">{money(p.gross)}</td>
              <td className={`${tdNum} font-bold text-text-primary`} dir="ltr">{money(p.net)}</td>
              <td className={tdNum} dir="ltr">{percent(p.margin, latin)}</td>
              <td className={tdNum}>{countText(p.orders, latin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The operating-expense twin. No margin column: an expense has no revenue. */
export function ExpenseTable({
  rows,
  nameOf,
  s,
  latin,
}: {
  rows: FinanceExpenseCategoryTotal[];
  nameOf: (row: FinanceExpenseCategoryTotal) => string;
  s: FinanceStrings;
  latin: boolean;
}) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table data-finance-table="expenses" className="w-full min-w-[22rem] border-collapse">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className={th}>{s.colName}</th>
            <th className={th}>{s.colAmount}</th>
            <th className={th}>{s.colEntries}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id ?? `${row.slug}|null`} className="border-b border-border-subtle/60">
              <td className={`${td} whitespace-normal font-bold text-text-primary`}>{nameOf(row)}</td>
              <td className={`${tdNum} font-bold text-text-primary`} dir="ltr">{money(row.amount_iqd)}</td>
              <td className={tdNum}>{countText(row.entries, latin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
