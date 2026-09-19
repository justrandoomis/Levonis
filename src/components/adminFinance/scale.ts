/**
 * THE VALUE AXIS'S OWN ARITHMETIC — kept out of the chart component on purpose.
 *
 * Two decisions on this screen are easy to get subtly wrong and impossible to
 * see in a screenshot: where the axis starts, and whether the three lines may
 * carry direct end labels. Both are pure functions of numbers, so both live
 * here where `tests/financeDashboard.test.ts` can exercise them with real
 * values instead of a regular expression over a render tree — and neither
 * module has to import recharts to be tested.
 */

/**
 * A rounded axis step — 1, 2 or 5 times a power of ten.
 *
 * Ticks carry the values that are not directly labelled, so they have to be
 * numbers a person can hold: 0 / 500 ألف / 1 م, never 0 / 487,333 / 974,666.
 */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/** The domain and the ticks, decided here so the chart cannot pick its own. */
export function niceScale(values: number[], targetTicks = 5): { min: number; max: number; ticks: number[] } {
  const finite = values.filter((v) => Number.isFinite(v));
  const rawMax = Math.max(0, ...finite);
  const rawMin = Math.min(0, ...finite);
  if (rawMax === 0 && rawMin === 0) return { min: 0, max: 1, ticks: [0, 1] };
  const step = niceStep((rawMax - rawMin) / Math.max(1, targetTicks - 1));
  const min = Math.floor(rawMin / step) * step;
  const max = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  // A guard on the loop, not a trust in floating point: a step that fails to
  // advance would hang the render thread and take the whole admin down.
  for (let v = min, guard = 0; v <= max + step / 2 && guard < 64; v += step, guard += 1) ticks.push(v);
  return { min, max, ticks };
}

/**
 * MAY THE THREE LINES CARRY DIRECT END LABELS?
 *
 * Direct labels work because they are sparing and because they sit ON their
 * line. When series converge at the right edge — and revenue, gross and net
 * converge on any day the shop sold almost nothing — three labels stack into
 * an unreadable pile, and nudging them apart detaches each one from the line
 * it belongs to, which is worse than having none.
 *
 * So the labels are conditional: the last value of each series is projected
 * onto the plot in pixels, and if any two land closer together than one line
 * of text, every label is dropped and the legend plus the tooltip carry the
 * identity instead. That is the documented fallback, chosen by measurement
 * rather than by hope.
 */
export function endLabelsFit(lastValues: number[], min: number, max: number, plotHeight: number): boolean {
  const span = max - min;
  if (span <= 0 || plotHeight <= 0) return false;
  const ys = lastValues
    .filter((v) => Number.isFinite(v))
    .map((v) => ((max - v) / span) * plotHeight)
    .sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i += 1) if (ys[i] - ys[i - 1] < 18) return false;
  return true;
}

/**
 * THE OUTLINE OF A BAR WHOSE **DATA END** IS ROUNDED AND WHOSE BASELINE END IS
 * SQUARE.
 *
 * Written as geometry rather than handed to recharts' `radius` prop because
 * the data end MOVES, in two independent ways:
 *
 *   1. In Arabic and Kurdish the value axis is reversed, so a positive bar
 *      grows to the LEFT and its tip is its left edge.
 *   2. A negative gross profit — a product refunded more than it sold this
 *      period — grows the other way again, whichever direction the chart runs.
 *
 * A fixed corner list rounds the BASELINE on half of those cases, and a bar
 * rounded where it meets its axis reads as floating free of the thing it is
 * measured from. The two cancel, which is why the test below checks the
 * combination and not each flag on its own.
 *
 * Returns an SVG path `d`. Pure, so the shape can be asserted as a string.
 */
export function roundedEndPath(
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
  rtl: boolean
): string {
  const w = Math.max(Math.abs(width), 1);
  const left = Math.min(x, x + width);
  const right = left + w;
  const top = y;
  const bottom = y + height;
  const r = Math.min(4, height / 2, w);
  // `value >= 0 !== rtl`: positive-and-LTR and negative-and-RTL both put the
  // tip on the right; the other two put it on the left.
  const endOnRight = value >= 0 !== rtl;
  return endOnRight
    ? `M${left},${top} H${right - r} Q${right},${top} ${right},${top + r} V${bottom - r} Q${right},${bottom} ${right - r},${bottom} H${left} Z`
    : `M${right},${top} H${left + r} Q${left},${top} ${left},${top + r} V${bottom - r} Q${left},${bottom} ${left + r},${bottom} H${right} Z`;
}
