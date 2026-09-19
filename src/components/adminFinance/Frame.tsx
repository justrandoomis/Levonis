import React, { useId, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, TriangleAlert } from 'lucide-react';
import { DELTA_CLASS, deltaTone, money, signedMoney, signedPercent } from './format';
import type { FinanceStrings } from './strings';

/**
 * THE FURNITURE OF THE PROFIT SCREEN — the card, the figures, the delta and
 * the disclosure that rides beside a number rather than under the page.
 *
 * ---------------------------------------------------------------------------
 * ONE HERO, THEN TILES. A dashboard that leads with eight equal numbers has no
 * headline, and the reader's eye has to do the editor's job. So exactly one
 * figure on this screen is set at hero size — the net profit, the number the
 * owner opened the screen for — and everything else is a tile beneath it.
 *
 * PROPORTIONAL FIGURES ON THE BIG NUMBERS. `tabular-nums` gives every digit
 * the width of a zero, which is right in a column of table rows and wrong at
 * 44px, where `121` comes out visibly loose. Tabular is therefore applied to
 * table cells and axis ticks ONLY.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHART HAS A TABLE TWIN.
 *
 * `ChartCard` carries a toggle between the chart and the same rows as a table,
 * and it is not an accessibility afterthought: a tooltip must never be the
 * only way to read a value, and an owner comparing two products wants the
 * numbers, not a hover. The toggle is a real button with `aria-pressed`, the
 * house `lv-choice` primitive, so the selected state is announced.
 *
 * ---------------------------------------------------------------------------
 * A REFETCH HOLDS THE FRAME.
 *
 * Changing the period re-renders every card. Replacing them with skeletons
 * would flash the whole screen and jump the layout for a request that usually
 * takes a moment — so a card that is reloading keeps its previous render at
 * reduced opacity and says nothing. The numbers only change when the new ones
 * arrive.
 */

/** A section card: a `<figure>` with a real title, a caption and room for a control. */
export function ChartCard({
  title,
  caption,
  hint,
  action,
  dim,
  children,
  testId,
}: {
  title: string;
  caption?: string;
  /** A short fact that belongs beside the title, e.g. how many rows are shown. */
  hint?: React.ReactNode;
  action?: React.ReactNode;
  dim?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const titleId = useId();
  return (
    <figure
      data-finance-card={testId}
      aria-labelledby={titleId}
      className="lv-surface m-0 min-w-0 p-3 sm:p-4"
    >
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[15px] leading-[1.4] font-black text-text-primary">
            {title}
          </h3>
          {caption && (
            <p className="mt-1 text-[12px] leading-[1.6] text-text-muted">{caption}</p>
          )}
          {hint && <div className="mt-1.5">{hint}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </figcaption>
      {/* The frame is held while new data arrives: no skeleton, no jump. */}
      <div className={dim ? 'opacity-50 transition-opacity duration-200' : 'transition-opacity duration-200'}>
        {children}
      </div>
    </figure>
  );
}

/** The chart / table switch that every chart card carries. */
export function TableToggle({
  showTable,
  onToggle,
  s,
}: {
  showTable: boolean;
  onToggle: (next: boolean) => void;
  s: FinanceStrings;
}) {
  return (
    <button
      type="button"
      data-finance-table-toggle={showTable ? 'table' : 'chart'}
      aria-pressed={showTable}
      onClick={() => onToggle(!showTable)}
      className="lv-choice press-scale inline-flex min-h-[44px] items-center gap-1.5 px-3 text-[12px] leading-[1.5] font-bold"
    >
      {showTable ? s.showChart : s.showTable}
    </button>
  );
}

/**
 * A comparison, or an honest statement that there is none.
 *
 * THE SERVER SENDS `null` FOR THE PERCENTAGE WHEN THE EARLIER SIDE WAS ZERO OR
 * NEGATIVE, and that null is rendered as «—» rather than as «+100%» or «∞».
 * A month that went from nothing to 900,000 did not grow by a percentage, it
 * started — and the absolute difference beside it is always true, so nothing
 * is lost by refusing to print the ratio.
 *
 * THE COLOUR IS NEVER THE ONLY SIGNAL. An arrow glyph and the words «مقارنة
 * بالفترة السابقة» carry the same meaning, because a delta drawn in green on a
 * black panel is unreadable to a reader with a red-green deficiency and
 * illegible to everyone on a bad screen in daylight.
 */
export function Delta({
  amount,
  percent,
  goodDirection,
  latin,
  s,
  compact,
}: {
  amount: number;
  percent: number | null;
  goodDirection: 'up' | 'down';
  latin: boolean;
  s: FinanceStrings;
  compact?: boolean;
}) {
  const tone = deltaTone(amount, goodDirection);
  const Icon = amount > 0 ? ArrowUpRight : amount < 0 ? ArrowDownRight : Minus;
  return (
    <span
      data-finance-delta={tone}
      className={`inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-[1.5] font-bold ${DELTA_CLASS[tone]}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} aria-hidden />
      <span dir="ltr" className="tabular-nums">{signedMoney(amount)}</span>
      <span dir="ltr" className="tabular-nums">({signedPercent(percent, latin)})</span>
      {!compact && <span className="font-medium text-text-muted">{s.vsPrevious}</span>}
    </span>
  );
}

/**
 * THE ONE HERO FIGURE. Same sans as the rest of the panel — a display face on
 * a money figure reads as decoration, and this number is not decoration.
 */
export function HeroFigure({
  label,
  value,
  meaning,
  delta,
  marker,
}: {
  label: string;
  value: string;
  meaning: string;
  delta?: React.ReactNode;
  /** The estimate/exclusion badge, which belongs BESIDE the number. */
  marker?: React.ReactNode;
}) {
  return (
    <div data-finance-hero className="min-w-0">
      <p className="text-[13px] leading-[1.5] font-bold text-text-secondary">{label}</p>
      <p
        dir="ltr"
        className="mt-1 text-[clamp(30px,7vw,48px)] leading-[1.1] font-black text-text-primary"
      >
        {value}
      </p>
      {marker && <div className="mt-2">{marker}</div>}
      {delta && <div className="mt-2">{delta}</div>}
      <p className="mt-2 max-w-[54ch] text-[12px] leading-[1.7] text-text-muted">{meaning}</p>
    </div>
  );
}

/** A secondary figure: label, value, optional delta, optional one-line note. */
export function StatTile({
  label,
  value,
  note,
  delta,
  marker,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  delta?: React.ReactNode;
  marker?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-finance-tile={testId} className="lv-surface min-w-0 p-3">
      <p className="text-[12px] leading-[1.5] font-bold text-text-secondary">{label}</p>
      <p dir="ltr" className="mt-1 text-[22px] leading-[1.25] font-black text-text-primary">
        {value}
      </p>
      {marker && <div className="mt-1.5">{marker}</div>}
      {delta && <div className="mt-1.5">{delta}</div>}
      {note && <p className="mt-1.5 text-[11px] leading-[1.6] text-text-muted">{note}</p>}
    </div>
  );
}

/**
 * THE ESTIMATE MARKER — beside the number, never in a footnote.
 *
 * «إن كان الرقم مقدَّرًا جزئيًا فالشاشة تقول ذلك بجانبه». A profit figure that
 * hides the fact that part of its cost basis was reconstructed from today's
 * catalogue is the worst thing this screen could do: somebody sets a supplier
 * price from it. So the badge sits inline with the figure it qualifies, it
 * carries the word as well as the colour, and its `title` spells out the
 * count.
 */
export function EstimateBadge({ label, detail }: { label: string; detail: string }) {
  return (
    <span
      data-finance-estimated
      title={detail}
      className="inline-flex items-center gap-1.5 rounded-md border border-warning/35 bg-warning/10 px-2 py-1 text-[11px] leading-[1.45] font-bold text-warning"
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
      {label}
    </span>
  );
}

/** One line of disclosure inside the honesty panel. */
export function HonestyLine({ text, tone = 'warning' }: { text: string; tone?: 'warning' | 'info' }) {
  return (
    <li
      data-finance-honesty={tone}
      className="flex items-start gap-2 text-[12px] leading-[1.7] text-text-secondary"
    >
      <span
        aria-hidden
        className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone === 'warning' ? 'bg-warning' : 'bg-info'}`}
      />
      <span>{text}</span>
    </li>
  );
}

/**
 * A card that holds a chart and its table twin, and remembers which one the
 * reader chose. The state lives here so every card on the screen can be
 * switched independently — an owner reading the product table does not want
 * the time chart to turn into a table under them.
 */
export function useTableView(): [boolean, (next: boolean) => void] {
  const [showTable, setShowTable] = useState(false);
  return [showTable, setShowTable];
}

/** The money cell every table on this screen uses: exact, LTR, tabular. */
export function MoneyCell({ iqd, className = '' }: { iqd: number; className?: string }) {
  return (
    <span dir="ltr" className={`tabular-nums ${className}`}>
      {money(iqd)}
    </span>
  );
}
