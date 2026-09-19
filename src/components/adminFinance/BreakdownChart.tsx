import React from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_INK, MARK } from './palette';
import { compactIqd } from './format';
import { roundedEndPath } from './scale';

/**
 * A BREAKDOWN — one measure, many nominal subjects, drawn as horizontal bars.
 *
 * ---------------------------------------------------------------------------
 * WHY BARS AND NOT A PIE, AND WHY HORIZONTAL.
 *
 * The reader's job here is to compare magnitudes and to find the top of the
 * list, which is what a bar chart is for. A pie of eight products asks the
 * reader to compare angles they cannot compare, and a donut with a number in
 * the middle is a stat tile wearing a chart's clothes.
 *
 * HORIZONTAL because the category names are Arabic product titles — «حامل
 * هاتف مغناطيسي للسيارة» — and a vertical column chart has to rotate those
 * forty-five degrees, truncate them, or replace them with a legend of eight
 * colours. Laid horizontally, every name gets a full line of its own and the
 * bars start from a shared edge, which is the comparison the reader is making.
 *
 * ---------------------------------------------------------------------------
 * ONE COLOUR FOR EVERY BAR, AND IT IS THE MEASURE'S COLOUR.
 *
 * Products and categories are NOMINAL — «أقلام» is not more or less than
 * «أحبار» — so there is no order for a colour ramp to encode. Shading the bars
 * light-to-dark by value would spend the identity channel restating the thing
 * the bar's LENGTH already says, and a ramp fails the chroma and lightness
 * checks by construction. One series means no legend box either: the card's
 * own title says what is plotted, and a legend with a single swatch just
 * restates it.
 *
 * ---------------------------------------------------------------------------
 * THE VALUE RIDES THE TIP OF ITS OWN BAR.
 *
 * Placed OUTSIDE the bar end, never inside it: a short bar cannot hold its own
 * label, and `overflow: hidden` on the mark would crop the first digits of the
 * number — which is worse than no label at all. The margin on the value side
 * is reserved for exactly this, so a label never leaves the plot. The full,
 * unrounded figure is in the tooltip and in the table twin, so the rounded tip
 * label gates nothing.
 */

export interface BreakdownDatum {
  id: string;
  /** The full name, as the tooltip and the table print it. */
  name: string;
  /** The plotted measure, in dinars. May be negative — a refunded product is. */
  value: number;
  /** True when any part of this row's cost was reconstructed, not recorded. */
  estimated: boolean;
  /** Prepared by the caller: this chart never computes a number of its own. */
  tooltip: Array<{ label: string; value: string }>;
}

/** Room for one row, and the smallest and largest a card may grow to. */
const ROW_HEIGHT = 34;
const AXIS_BAND = 30;

/**
 * The bar mark: a path from `roundedEndPath` (see ./scale.ts, where the
 * geometry is a pure function so its RTL and negative-value cases can be
 * asserted as strings) filled with the measure's own colour.
 */
function roundedEndBar(props: unknown, rtl: boolean): React.ReactElement {
  const p = props as { x?: number; y?: number; width?: number; height?: number; fill?: string; value?: number };
  const { x, y, width, height } = p;
  // recharts calls `shape` before the layout is measured on the first frame, so
  // a missing coordinate is ordinary rather than exceptional: it draws nothing
  // that frame instead of throwing inside the SVG renderer and blanking the
  // whole admin panel.
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return <g />;
  }
  return <path d={roundedEndPath(x, y, width, height, p.value ?? 0, rtl)} fill={p.fill} />;
}

export default function BreakdownChart({
  rows,
  color,
  rtl,
  latin,
  emptyText,
  testId,
}: {
  rows: BreakdownDatum[];
  color: string;
  rtl: boolean;
  latin: boolean;
  emptyText: string;
  testId?: string;
}) {
  /**
   * THE CARD'S OWN WIDTH, MEASURED RATHER THAN ASSUMED.
   *
   * `ResponsiveContainer` sizes the PLOT, but the axis width and the value
   * margin are decided by this component before recharts ever renders, so they
   * need the number too. The initial 640 is a desktop guess that lasts one
   * frame; the observer corrects it on mount, before the reader sees anything.
   * Guarded for the environments where `ResizeObserver` does not exist (the
   * server-render smoke test, and any test runner without a DOM), where the
   * desktop figures are the right fallback anyway.
   */
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(640);
  React.useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(el.clientWidth || 640);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (rows.length === 0) {
    return <p className="py-10 text-center text-[13px] leading-[1.7] text-text-muted">{emptyText}</p>;
  }

  // The container grows with its content and includes the axis band, so the
  // card never develops a tiny nested scrollbar that hides the last rows.
  const height = rows.length * ROW_HEIGHT + AXIS_BAND;

  /**
   * THE CHROME IS SIZED AGAINST THE CARD, NOT AGAINST A DESKTOP.
   *
   * `valueMargin` reserves room for the longest label this formatter can
   * produce — «−999.9 ألف», the widest case, since anything past a million
   * collapses to «م» — and `nameWidth` reserves the category column. Both used
   * to be the fixed 76 and 132 that a desktop card wants. Inside a `lv-surface
   * p-3` on a 360px phone the content box is about 336px, which left the bars
   * 336 − 132 − 76 − 8 ≈ 120px: a name column WIDER than the plot, and every
   * comparison the chart exists to support squeezed into a third of the card.
   * Nothing overflowed, so nothing looked wrong; it was simply unreadable.
   *
   * Capped at the desktop figures and floored well above nothing, so a wide
   * card is unchanged and a narrow one gives the bars the room instead of the
   * chrome. The tooltip and the table twin both print the whole name and the
   * exact figure, so a shorter axis label on a phone gates nothing.
   */
  const w = width;
  const valueMargin = Math.max(48, Math.min(76, Math.round(w * 0.2)));
  const nameWidth = Math.max(84, Math.min(132, Math.round(w * 0.32)));
  const nameChars = nameWidth >= 120 ? 18 : 12;

  /**
   * A NEGATIVE BAR'S LABEL NEEDS A MARGIN ON THE OTHER SIDE.
   *
   * The value margin is reserved on the side a POSITIVE bar's tip lands on. A
   * negative gross profit — a product that was refunded more than it sold — runs
   * the other way, and `tipLabel` correctly anchors its text past the far end,
   * which was an 8px gutter: the figure was drawn straight across the category
   * names. Reserving both sides the moment any row is negative costs a wide
   * card nothing and stops the collision entirely.
   */
  const anyNegative = rows.some((r) => r.value < 0);

  const tipLabel = (props: unknown): React.ReactElement | null => {
    const p = props as { x?: number; y?: number; width?: number; height?: number; value?: number };
    if (
      typeof p.x !== 'number' ||
      typeof p.y !== 'number' ||
      typeof p.width !== 'number' ||
      typeof p.height !== 'number' ||
      typeof p.value !== 'number'
    ) {
      return null;
    }
    const endOnRight = p.value >= 0 !== rtl;
    const left = Math.min(p.x, p.x + p.width);
    const right = left + Math.abs(p.width);
    return (
      <text
        x={endOnRight ? right + 6 : left - 6}
        y={p.y + p.height / 2 + 4}
        textAnchor={endOnRight ? 'start' : 'end'}
        fill={CHART_INK.label}
        fontSize={11}
        fontWeight={700}
      >
        {compactIqd(p.value, latin)}
      </text>
    );
  };

  return (
    <div ref={hostRef} data-finance-breakdown={testId} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={rows}
          barSize={MARK.barSize}
          margin={{
            top: 6,
            right: rtl && !anyNegative ? 8 : valueMargin,
            left: !rtl && !anyNegative ? 8 : valueMargin,
            bottom: 0,
          }}
        >
          <CartesianGrid stroke={CHART_INK.grid} strokeWidth={1} horizontal={false} />
          {/* With bars on both sides of it, the zero line is what the reader
              measures direction from. Drawn only when it is needed — on an
              all-positive chart the value axis already IS zero, and a second
              rule on top of it is ink saying nothing. Same rule, same ink, as
              TimeSeriesChart's zero line. */}
          {anyNegative && <ReferenceLine x={0} stroke={CHART_INK.axis} strokeWidth={1} />}
          <XAxis
            type="number"
            reversed={rtl}
            tick={{ fill: CHART_INK.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: CHART_INK.axis }}
            height={AXIS_BAND}
            tickFormatter={(v: number) => compactIqd(v, latin)}
          />
          <YAxis
            type="category"
            dataKey="name"
            orientation={rtl ? 'right' : 'left'}
            width={nameWidth}
            tick={{ fill: CHART_INK.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            // Truncated HERE and nowhere else: the tooltip and the table twin
            // both print the whole name, so nothing is only ever readable in a
            // clipped form.
            tickFormatter={(v: string) => (v.length > nameChars ? `${v.slice(0, nameChars - 1)}…` : v)}
          />
          <Tooltip
            // On bars the MARK is the hit target — no crosshair. The hovered
            // bar lightens so the reader sees it answer.
            cursor={{ fill: '#ffffff', fillOpacity: 0.06 }}
            content={<BreakdownTooltip rtl={rtl} />}
          />
          <Bar
            dataKey="value"
            fill={color}
            isAnimationActive={false}
            shape={(props: object) => roundedEndBar(props, rtl)}
          >
            <LabelList dataKey="value" content={tipLabel} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The hovered bar's own readout: value first, then the name, then the detail. */
function BreakdownTooltip({
  active,
  payload,
  rtl,
}: {
  active?: boolean;
  payload?: Array<{ payload?: BreakdownDatum }>;
  rtl: boolean;
}) {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      className="lv-surface-raised max-w-[min(22rem,80vw)] p-2.5 text-[12px] leading-[1.6]"
    >
      <p className="font-bold text-text-primary">{row.name}</p>
      <ul className="mt-1.5 space-y-0.5">
        {row.tooltip.map((line) => (
          <li key={line.label} className="flex items-center justify-between gap-3">
            <span className="text-text-muted">{line.label}</span>
            <span dir="ltr" className="font-black tabular-nums text-text-primary">{line.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
