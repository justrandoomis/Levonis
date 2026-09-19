import React, { useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LabelList,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FinanceBucket } from '../../lib/api';
import { CHART_INK, MARK, MEASURE_COLOR } from './palette';
import { bucketLabel, compactIqd, countText, money, percent, rangeLabel } from './format';
import { endLabelsFit, niceScale } from './scale';
import type { FinanceStrings } from './strings';

/**
 * REVENUE, GROSS PROFIT AND NET PROFIT OVER TIME — ON ONE AXIS.
 *
 * ###########################################################################
 * #  THERE IS NO SECOND Y-AXIS HERE AND THERE NEVER WILL BE.                #
 * ###########################################################################
 * The obvious next request for this chart is "put the margin percentage on the
 * right-hand side". It is the single most common charting mistake and it is
 * refused on purpose: the alignment of two scales on one plot is arbitrary, so
 * the chart INVENTS a correlation that is not in the numbers — a margin line
 * that appears to cross a revenue line at a meaningful moment when the
 * crossing is an artefact of where the two axes happened to be anchored.
 * Revenue is in dinars and margin is a ratio; they do not share an axis.
 *
 * The margin lives in its own tile above, as a figure with its own comparison.
 * If a margin TREND is ever wanted it gets a chart of its own, on its own
 * percentage axis, underneath this one — never a second scale on this plot.
 *
 * WHY THESE THREE TOGETHER AND NOT THREE SEPARATE CHARTS. All three are
 * dinars, so they are commensurable: the vertical distance between the revenue
 * line and the gross-profit line IS the cost of goods, and the distance from
 * gross to net IS everything the period spent that no product paid for. That
 * distance is the thing the owner is actually reading, and small multiples
 * with three independent scales would destroy it.
 *
 * ---------------------------------------------------------------------------
 * THE AXIS STARTS AT ZERO. A money chart whose baseline is `dataMin` doubles
 * the apparent size of every wobble. The domain is anchored at zero (or below
 * it, when a period's net profit is negative, so a loss is drawn as a loss
 * rather than clipped) and the ticks are rounded to clean 1/2/5 steps, because
 * they carry every value that is not directly labelled.
 *
 * ---------------------------------------------------------------------------
 * RIGHT-TO-LEFT IS A DATA DECISION, NOT A STYLE ONE. In Arabic and Kurdish the
 * earliest day belongs on the RIGHT, so the x-axis is reversed and the value
 * axis moves to the right edge. A chart left in LTR inside an RTL panel reads
 * as running backwards in time.
 */

export interface TimePoint {
  key: string;
  label: string;
  from: string;
  to: string;
  revenue: number;
  gross: number;
  net: number;
  margin: number | null;
  orders: number;
  estimated: boolean;
  estimatedLines: number;
}

export function toTimePoints(buckets: FinanceBucket[], latin: boolean): TimePoint[] {
  return buckets.map((b) => ({
    key: b.key,
    label: bucketLabel(b.key, latin),
    from: b.from,
    to: b.to,
    revenue: b.totals.revenue_iqd,
    gross: b.totals.gross_profit_iqd,
    net: b.totals.net_profit_iqd,
    margin: b.totals.gross_margin_percent,
    orders: b.totals.orders,
    estimated: b.totals.estimated,
    estimatedLines: b.totals.estimated_lines,
  }));
}

/** The plot's own height, once the x-axis band is taken out of the container. */
const CHART_HEIGHT = 300;
const X_AXIS_BAND = 34;
const TOP_MARGIN = 14;
const PLOT_HEIGHT = CHART_HEIGHT - X_AXIS_BAND - TOP_MARGIN;

interface SeriesSpec {
  key: 'revenue' | 'gross' | 'net';
  name: string;
  color: string;
}

export default function TimeSeriesChart({
  points,
  rtl,
  latin,
  s,
}: {
  points: TimePoint[];
  rtl: boolean;
  latin: boolean;
  s: FinanceStrings;
}) {
  const series: SeriesSpec[] = useMemo(
    () => [
      { key: 'revenue', name: s.revenue, color: MEASURE_COLOR.revenue },
      { key: 'gross', name: s.grossProfit, color: MEASURE_COLOR.gross_profit },
      { key: 'net', name: s.netProfit, color: MEASURE_COLOR.net_profit },
    ],
    [s]
  );

  const scale = useMemo(
    () => niceScale(points.flatMap((p) => [p.revenue, p.gross, p.net])),
    [points]
  );

  const labelled = useMemo(() => {
    const last = points[points.length - 1];
    if (!last) return false;
    return endLabelsFit([last.revenue, last.gross, last.net], scale.min, scale.max, PLOT_HEIGHT);
  }, [points, scale.min, scale.max]);

  // One point is not a line. Saying so is more useful than drawing a dot in an
  // empty frame and letting the owner wonder what broke.
  if (points.length < 2) {
    return (
      <p className="py-10 text-center text-[13px] leading-[1.7] text-text-muted">{s.onePoint}</p>
    );
  }

  const endLabel = (color: string) =>
    function EndLabel(props: unknown): React.ReactElement | null {
      const p = props as { x?: number; y?: number; value?: number; index?: number };
      if (!labelled || p.index !== points.length - 1) return null;
      if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.value !== 'number') return null;
      return (
        <g>
          {/* The identity is the dot, in the series colour; the TEXT wears a
              text token. A light categorical hue set as type on this surface
              is unreadable, and colouring the number would be the chart
              telling the reader to match hues. */}
          <circle
            cx={p.x}
            cy={p.y}
            r={MARK.dotRadius}
            fill={color}
            stroke={CHART_INK.surface}
            strokeWidth={MARK.ringWidth}
          />
          <text
            x={rtl ? p.x - 9 : p.x + 9}
            y={p.y + 4}
            textAnchor={rtl ? 'end' : 'start'}
            fill={CHART_INK.label}
            fontSize={11}
            fontWeight={700}
          >
            {compactIqd(p.value, latin)}
          </text>
        </g>
      );
    };

  return (
    <div data-finance-timeseries style={{ width: '100%', height: CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points}
          margin={{ top: TOP_MARGIN, right: rtl ? 8 : 68, left: rtl ? 68 : 8, bottom: 0 }}
        >
          {/* Hairline, SOLID, one step off the surface. A dashed grid reads as
              a threshold or a projection when it is only a grid. */}
          <CartesianGrid stroke={CHART_INK.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="label"
            reversed={rtl}
            tick={{ fill: CHART_INK.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: CHART_INK.axis }}
            height={X_AXIS_BAND}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          <YAxis
            orientation={rtl ? 'right' : 'left'}
            domain={[scale.min, scale.max]}
            ticks={scale.ticks}
            width={62}
            tick={{ fill: CHART_INK.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => compactIqd(v, latin)}
          />
          {/* Drawn only when a period actually lost money: a zero rule on an
              all-positive chart is one more line to read for no information. */}
          {scale.min < 0 && <ReferenceLine y={0} stroke={CHART_INK.axis} strokeWidth={1} />}
          <Tooltip
            cursor={{ stroke: CHART_INK.axis, strokeWidth: 1 }}
            content={<TimeTooltip series={series} rtl={rtl} latin={latin} s={s} />}
          />
          {/* A legend is present for two or more series, always: it is the
              dependable identity channel when the direct labels cannot fit. */}
          <Legend
            verticalAlign="bottom"
            height={28}
            iconType="plainline"
            formatter={(value: string) => (
              <span style={{ color: CHART_INK.label, fontSize: 12, fontWeight: 700 }}>{value}</span>
            )}
          />
          {series.map((sp) => (
            <Line
              key={sp.key}
              type="monotone"
              dataKey={sp.key}
              name={sp.name}
              stroke={sp.color}
              strokeWidth={MARK.lineWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: MARK.dotRadius, stroke: CHART_INK.surface, strokeWidth: MARK.ringWidth }}
              isAnimationActive={false}
            >
              <LabelList dataKey={sp.key} content={endLabel(sp.color)} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * ONE TOOLTIP, EVERY SERIES.
 *
 * The pointer never has to land on a particular line to get a value: the
 * crosshair finds the x position and the readout lists all three numbers for
 * that bucket. The VALUE leads and the series name follows — the legend's
 * hierarchy inverted, because here the reader already knows which series they
 * care about and wants the figure.
 *
 * The series key is a short stroke of the series colour, not a filled box: at
 * tooltip density a block of colour is data-weight ink doing a label's job.
 */
function TimeTooltip({
  active,
  payload,
  series,
  rtl,
  latin,
  s,
}: {
  active?: boolean;
  payload?: Array<{ payload?: TimePoint }>;
  series: SeriesSpec[];
  rtl: boolean;
  latin: boolean;
  s: FinanceStrings;
}) {
  if (!active) return null;
  /**
   * THE HOVERED BUCKET COMES FROM THE PAYLOAD, NEVER FROM ITS LABEL.
   *
   * This used to be `points.find((p) => p.label === label)` — re-finding the
   * datum by the string printed on the axis. `bucketLabel` drops the YEAR so
   * the ticks stay readable, so day/month is unique only inside a 365-day
   * window; `MAX_RANGE_DAYS` is 366 and `rangeProblem()` accepts exactly 366,
   * so a range of 2025-09-19 → 2026-09-19 renders «١٩/٩» twice and `find`
   * returns the FIRST. Hovering the later bucket then showed the earlier
   * year's revenue, profit, margin and order count with nothing looking
   * broken — the numbers were simply another year's.
   *
   * recharts already hands us the row it drew, so the identity of a bucket is
   * never its formatting. `BreakdownTooltip` in ./BreakdownChart.tsx reads the
   * payload the same way.
   */
  const point = payload?.[0]?.payload;
  if (!point) return null;
  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      className="lv-surface-raised max-w-[min(20rem,80vw)] p-2.5 text-[12px] leading-[1.6]"
    >
      <p className="font-bold text-text-secondary">
        {point.from === point.to ? point.label : rangeLabel(point.from, point.to, latin)}
      </p>
      <ul className="mt-1.5 space-y-1">
        {series.map((sp) => (
          <li key={sp.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-0.5 w-4 shrink-0 rounded-full"
              style={{ backgroundColor: sp.color }}
            />
            <span dir="ltr" className="font-black tabular-nums text-text-primary">
              {money(point[sp.key])}
            </span>
            <span className="text-text-muted">{sp.name}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-text-muted">
        {s.grossMargin} {percent(point.margin, latin)} · {countText(point.orders, latin)} {s.orders}
      </p>
      {point.estimated && (
        <p className="mt-1 font-bold text-warning">
          {s.estimatedBadge} — {countText(point.estimatedLines, latin)}
        </p>
      )}
    </div>
  );
}
