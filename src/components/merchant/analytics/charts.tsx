/**
 * THE ANALYTICS PAGE'S CHARTS — small, in-house SVG, no chart library.
 *
 * A charting library is 40–90 KB gzip; these four pieces are a few KB and
 * draw exactly the forms the page needs (tests/bundleBudget.test.ts holds the
 * page's chunk to a budget). They follow the dataviz rules the page was
 * designed by:
 *
 *   ONE AXIS. Views and orders are two charts side by side (small multiples),
 *   never one chart with two scales.
 *   THIN MARKS. 2px lines with a 10% wash; columns ≤ 24px with a 4px rounded
 *   end, square on the baseline; hairline solid gridlines; ≥ 8px markers with
 *   a 2px surface ring.
 *   TEXT NEVER WEARS A SERIES COLOUR. Labels, values and legends are text
 *   tokens; the colour is the mark (or the swatch beside a word).
 *   HOVER BY DEFAULT, NEVER ONLY BY HOVER. The daily charts have a crosshair
 *   that snaps to the day under the pointer, the same readout on keyboard
 *   focus (arrow keys walk the days), and every chart has a TABLE VIEW with
 *   the same numbers — the tooltip enhances, the table is the accessible twin.
 *   COLOUR FOLLOWS THE ENTITY. A stacked bar's parts keep their slot whatever
 *   the values are; a legend is always present for two or more parts.
 *
 * All text is React text (never HTML strings): product and coupon names come
 * from merchants.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import {
  bandWidth,
  CHART_SURFACE,
  dayTickIndexes,
  nearestIndex,
  niceTicks,
  seriesMax,
  shares,
  xPositions,
  yScale,
} from './chartMath';

/** The width of an element, following it as the layout changes. */
function useWidth<T extends HTMLElement>(fallback = 320): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.max(160, Math.round(el.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------- the card

export interface ChartCardProps {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The chart. */
  children: React.ReactNode;
  /** The same numbers as a table — the accessible twin every chart has. */
  table: React.ReactNode;
  className?: string;
}

/** A titled surface with a «chart / table» switch. */
export function ChartCard({ id, title, description, children, table, className = '' }: ChartCardProps) {
  const { loc } = useLanguage();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section aria-labelledby={`${id}-title`} data-chart-card={id} className={`lv-surface min-w-0 p-4 ${className}`}>
      <div className={`${description ? 'mb-1' : 'mb-3'} flex items-center justify-between gap-3`}>
        <h3 id={`${id}-title`} className="min-w-0 text-[15px] font-bold leading-snug text-text-primary">
          {title}
        </h3>
        <Segmented
          size="sm"
          group={`view-${id}`}
          label={loc('طريقة العرض', 'View as', 'پیشاندان')}
          value={view}
          onChange={(v) => setView(v as 'chart' | 'table')}
          dataAttr="data-chart-view"
          items={[
            { id: 'chart', label: loc('مخطط', 'Chart') /* OWNER: Sorani to be written by hand. */ },
            { id: 'table', label: loc('جدول', 'Table') /* OWNER: Sorani to be written by hand. */ },
          ]}
          className="w-[132px] shrink-0"
        />
      </div>
      {description && <p className="mb-3 text-[12.5px] leading-relaxed text-text-muted">{description}</p>}
      {view === 'chart' ? children : <div data-chart-table>{table}</div>}
    </section>
  );
}

/** A plain, readable table: headers, tabular figures, numbers as LTR islands. */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: Array<{ label: React.ReactNode; numeric?: boolean }>;
  rows: Array<Array<React.ReactNode>>;
}) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border-subtle">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface-raised">
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className={`px-3 py-2 font-semibold text-text-secondary ${c.numeric ? 'text-end' : 'text-start'}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle">
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3 py-2 ${columns[j]?.numeric ? 'whitespace-nowrap text-end tabular-nums text-text-primary' : 'text-text-secondary'}`}
                >
                  {columns[j]?.numeric ? <bdi>{cell}</bdi> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- daily chart

export interface DailyChartProps {
  /** One point per day, oldest first. */
  series: ReadonlyArray<{ day: string; value: number }>;
  kind: 'line' | 'columns';
  /** What one point is, for the readout and the chart's accessible name: «زوّار». */
  label: string;
  /** The value as text: a count, or money. */
  format: (v: number) => string;
  /** The day as text for the axis and the readout. */
  dayLabel: (day: string, short: boolean) => string;
  color?: string;
  /** Accessible summary: «زوار يوميًا من … إلى …، الأعلى …». */
  summary: string;
}

const H = 176; // plot + axis band, one number so the container never clips the axis (anti-pattern)
const PLOT_TOP = 10;
const PLOT_BOTTOM = 148;

export function DailyChart({ series, kind, label, format, dayLabel, color = '#3987e5', summary }: DailyChartProps) {
  const { dir } = useLanguage();
  const rtl = dir === 'rtl';
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const gradient = useId().replace(/:/g, '');
  const values = series.map((p) => p.value);
  const ticks = niceTicks(seriesMax(values), 3);
  const top = ticks[ticks.length - 1] || 1;
  // The tick labels sit at the inline start, outside the plot.
  const axisLabelWidth = Math.max(18, String(format(top)).length * 7 + 6);
  const pad = 6;
  const plotStart = rtl ? 0 : axisLabelWidth;
  const plotWidth = Math.max(40, width - axisLabelWidth);
  const xs = xPositions(series.length, plotWidth, pad, rtl).map((x) => x + plotStart);
  const band = bandWidth(series.length, plotWidth, pad);
  const y = (v: number) => yScale(v, top, PLOT_TOP, PLOT_BOTTOM);
  const tickIdx = dayTickIndexes(series.length, width < 360 ? 3 : 5);

  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(e.clientX - box.left - plotStart, series.length, plotWidth, pad, rtl));
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!series.length) return;
    // Arrows move in SCREEN direction: in Arabic, left is later.
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward || e.key === back || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive((i) => {
        const cur = i ?? series.length - 1;
        if (e.key === 'Home') return 0;
        if (e.key === 'End') return series.length - 1;
        return Math.min(series.length - 1, Math.max(0, cur + (e.key === forward ? 1 : -1)));
      });
    }
  };

  const linePath = series.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const areaPath = series.length
    ? `${linePath}L${xs[xs.length - 1].toFixed(1)},${PLOT_BOTTOM}L${xs[0].toFixed(1)},${PLOT_BOTTOM}Z`
    : '';
  const colW = Math.max(2, Math.min(24, band - 2));
  const last = series.length - 1;
  const shown = active ?? null;

  return (
    <div ref={wrap} className="relative" data-daily-chart={kind}>
      <svg
        role="img"
        aria-label={summary}
        tabIndex={0}
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        className="block touch-pan-y rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((i) => i ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.14" />
            <stop offset="1" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Gridlines: solid hairlines, one step off the surface. */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={plotStart} x2={plotStart + plotWidth} y1={y(t)} y2={y(t)} stroke="var(--color-border-subtle)" strokeWidth="1" />
            <text
              x={rtl ? width - 2 : 2}
              y={y(t) + 4}
              textAnchor={rtl ? 'end' : 'start'}
              className="fill-text-muted text-[10.5px] tabular-nums"
              style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}
            >
              {format(t)}
            </text>
          </g>
        ))}
        {kind === 'line' ? (
          <>
            <path d={areaPath} fill={`url(#${gradient})`} />
            <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {series.length === 1 && <circle cx={xs[0]} cy={y(series[0].value)} r="4" fill={color} />}
          </>
        ) : (
          series.map((p, i) => {
            if (p.value <= 0) return null;
            const x0 = xs[i] - colW / 2;
            const yTop = y(p.value);
            const h = PLOT_BOTTOM - yTop;
            const r = Math.min(4, colW / 2, h);
            // Rounded data end, square on the baseline.
            const d = `M${x0},${PLOT_BOTTOM}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x0 + colW - r}Q${x0 + colW},${yTop} ${x0 + colW},${yTop + r}V${PLOT_BOTTOM}Z`;
            return <path key={p.day} d={d} fill={color} opacity={shown === null || shown === i ? 1 : 0.55} />;
          })
        )}
        {/* The baseline. */}
        <line x1={plotStart} x2={plotStart + plotWidth} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} stroke="var(--color-text-muted)" strokeOpacity="0.45" strokeWidth="1" />
        {tickIdx.map((i) => (
          <text
            key={i}
            x={xs[i]}
            y={H - 8}
            // Anchored by the EDGE the label sits at, in screen terms (the
            // text itself is set LTR, so start = left): the outermost labels
            // grow inwards and are never clipped.
            textAnchor={i === 0 || i === last ? (xs[i] < width / 2 ? 'start' : 'end') : 'middle'}
            className="fill-text-muted text-[10.5px] tabular-nums"
            style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}
          >
            {dayLabel(series[i].day, true)}
          </text>
        ))}
        {shown !== null && series[shown] && (
          <g aria-hidden="true">
            <line x1={xs[shown]} x2={xs[shown]} y1={PLOT_TOP} y2={PLOT_BOTTOM} stroke="var(--color-text-secondary)" strokeOpacity="0.6" strokeWidth="1" />
            {kind === 'line' && (
              <circle cx={xs[shown]} cy={y(series[shown].value)} r="4.5" fill={color} stroke={CHART_SURFACE} strokeWidth="2" />
            )}
          </g>
        )}
      </svg>
      {shown !== null && series[shown] && (
        <Readout x={xs[shown]} width={width}>
          <span className="block text-[14px] font-bold tabular-nums text-text-primary">
            <bdi>{format(series[shown].value)}</bdi>
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-full" style={{ background: color }} />
            {label} · {dayLabel(series[shown].day, false)}
          </span>
        </Readout>
      )}
    </div>
  );
}

/** The one tooltip: value first, what it is second, kept inside the chart. */
function Readout({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const w = 150;
  const left = Math.min(Math.max(0, x - w / 2), Math.max(0, width - w));
  return (
    <div
      aria-hidden="true"
      data-chart-readout
      className="pointer-events-none absolute top-0 rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1.5 shadow-lg"
      style={{ left, width: w }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- bar list

export interface BarRow {
  key: string;
  label: React.ReactNode;
  value: number;
  /** The value as it is read: «12», «45,000 د.ع». */
  valueText: string;
  /** A second quiet line: «3 طلبات». */
  hint?: React.ReactNode;
}

/**
 * Ranked horizontal bars — one series, one colour; the value sits at the bar's
 * end (outside it, so it never clips), the name above. Bars grow from the
 * inline start, so they read the same way as the words.
 */
export function BarList({ rows, color = '#3987e5', ariaLabel }: { rows: readonly BarRow[]; color?: string; ariaLabel: string }) {
  const max = seriesMax(rows.map((r) => r.value));
  return (
    <ul aria-label={ariaLabel} className="space-y-3" data-bar-list>
      {rows.map((r) => {
        const pct = max > 0 ? Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100) : 0;
        return (
          <li key={r.key} className="group min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] text-text-secondary">{r.label}</span>
              <bdi className="shrink-0 text-[13px] font-semibold tabular-nums text-text-primary">{r.valueText}</bdi>
            </div>
            <div className="h-2 w-full" aria-hidden="true">
              <div
                className="h-2 rounded-e-[4px] transition-[filter] group-hover:brightness-125"
                style={{ width: `${pct}%`, background: color }}
              />
            </div>
            {r.hint && <p className="mt-1 text-[11.5px] text-text-muted">{r.hint}</p>}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- part-to-whole

export interface Part {
  key: string;
  label: string;
  value: number;
  valueText: string;
  color: string;
}

/**
 * One bar split into its parts, with a 2px surface gap between them and a
 * legend that names every part with its value and share — the legend is the
 * identity channel, colour only supports it. Hovering or focusing a part
 * lifts it and shows its readout.
 */
export function StackedBar({ parts, ariaLabel }: { parts: readonly Part[]; ariaLabel: string }) {
  const { lang } = useLanguage();
  const pcts = shares(parts.map((p) => p.value));
  const [active, setActive] = useState<string | null>(null);
  if (!pcts.length) return null;
  const pctText = (v: number) => `${v.toLocaleString(lang === 'en' ? 'en-US' : undefined)}%`;
  return (
    <div data-stacked-bar>
      <div role="img" aria-label={ariaLabel} className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]">
        {parts.map((p, i) =>
          p.value > 0 ? (
            <div
              key={p.key}
              className="h-full min-w-[3px] transition-opacity"
              style={{ flexGrow: p.value, flexBasis: 0, background: p.color, opacity: active && active !== p.key ? 0.45 : 1 }}
              onPointerEnter={() => setActive(p.key)}
              onPointerLeave={() => setActive(null)}
              title={`${p.label}: ${p.valueText} (${pctText(pcts[i])})`}
            />
          ) : null
        )}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {parts.map((p, i) => (
          <li
            key={p.key}
            tabIndex={0}
            onFocus={() => setActive(p.key)}
            onBlur={() => setActive(null)}
            onPointerEnter={() => setActive(p.key)}
            onPointerLeave={() => setActive(null)}
            className="flex min-w-0 items-center gap-2 rounded-md text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} />
            <span className="min-w-0 flex-1 truncate text-text-secondary">{p.label}</span>
            <bdi className="shrink-0 font-semibold tabular-nums text-text-primary">{p.valueText}</bdi>
            <bdi className="w-11 shrink-0 text-end tabular-nums text-text-muted">{pctText(pcts[i])}</bdi>
          </li>
        ))}
      </ul>
    </div>
  );
}
