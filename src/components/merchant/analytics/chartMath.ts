/**
 * THE ANALYTICS PAGE'S ARITHMETIC — pure, so every number a chart draws is
 * tested without a browser (tests/merchantAnalyticsCharts.test.ts).
 *
 *   niceTicks        clean y-axis steps (0 / 5 / 10 …), never 0.37-sized
 *   xPositions       a band per day; RTL mirrors TIME, never the numbers
 *   periodDelta      a change only when BOTH periods have a real figure
 *   shares           whole percentages that add up to exactly 100
 *   funnelSteps      each stage against the first and against the previous
 *   rangeFor         the preset ranges in Baghdad days
 *
 * NO FIGURE IS INVENTED HERE: a missing input comes back as null (and the
 * page does not draw it), never as 0.
 */

/** The chart palette — the dataviz reference's DARK steps, validated on this app's chart surface. */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const;
/**
 * Validated with the dataviz skill's `validate_palette.js --mode dark
 * --surface "#131519"` (the `--color-surface` every card sits on): lightness
 * band, chroma floor, adjacent CVD ΔE 8.4 (≥ 8), normal-vision ΔE 19.8 (≥ 15),
 * contrast ≥ 3:1 — all PASS. The app has one (dark) theme, so the dark steps
 * ARE the selected mode; there is no automatic flip to guard.
 */
export const CHART_SURFACE = '#131519';

/** Ticks for an axis from 0 to at least `max`: 1, 2 or 5 × 10ⁿ steps, `target` ticks or so. */
export function niceTicks(max: number, target = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  // Counts are whole: a step below 1 would label «0.5 orders».
  const s = Math.max(1, step);
  const top = Math.ceil(max / s) * s;
  const out: number[] = [];
  for (let v = 0; v <= top + s / 2; v += s) out.push(Math.round(v));
  return out;
}

/**
 * The centre of each day's band across `width`, with `pad` either side.
 * Time runs in the reading direction: left→right in English, right→left in
 * Arabic and Sorani — the NUMBERS on the axis are never mirrored, only where
 * the days sit.
 */
export function xPositions(count: number, width: number, pad: number, rtl: boolean): number[] {
  if (count <= 0) return [];
  const inner = Math.max(0, width - pad * 2);
  const band = inner / count;
  return Array.from({ length: count }, (_, i) => {
    const x = pad + band * (i + 0.5);
    return rtl ? width - x : x;
  });
}

export function bandWidth(count: number, width: number, pad: number): number {
  return count > 0 ? Math.max(0, width - pad * 2) / count : 0;
}

/** Map a value on [0, top] to a y in [bottom, topY] (SVG y grows down). */
export function yScale(value: number, top: number, plotTop: number, plotBottom: number): number {
  const t = top > 0 ? Math.min(1, Math.max(0, value / top)) : 0;
  return plotBottom - t * (plotBottom - plotTop);
}

/** Which day's band the pointer is over — the crosshair snaps to it. */
export function nearestIndex(pointerX: number, count: number, width: number, pad: number, rtl: boolean): number {
  if (count <= 0) return -1;
  const band = bandWidth(count, width, pad);
  if (band <= 0) return 0;
  const fromStart = rtl ? width - pointerX : pointerX;
  return Math.min(count - 1, Math.max(0, Math.floor((fromStart - pad) / band)));
}

/** Which tick labels to print on a time axis of `count` days: the first, the last, and evenly between, at most `max`. */
export function dayTickIndexes(count: number, max = 5): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out = new Set<number>([0, count - 1]);
  const step = (count - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.add(Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}

export interface Delta {
  /** Percent change, one decimal: 12.5 is +12.5%. */
  percent: number;
}

/**
 * The change from the previous period — ONLY when both sides are real figures
 * and the previous one is above zero (a rise «from nothing» has no percent).
 */
export function periodDelta(current: number | null | undefined, previous: number | null | undefined): Delta | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return { percent: Math.round(((current - previous) / previous) * 1000) / 10 };
}

/**
 * Whole percentages of a total that add up to 100 exactly (largest
 * remainder), so a stacked bar's labels never read 33 + 33 + 33 = 99.
 * Empty when the total is 0 — there is no share of nothing.
 */
export function shares(values: readonly number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v || 0), 0);
  if (total <= 0) return [];
  const exact = values.map((v) => (Math.max(0, v || 0) / total) * 100);
  const floor = exact.map(Math.floor);
  let left = 100 - floor.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floor[i] += 1;
    left -= 1;
  }
  return floor;
}

export interface FunnelStep {
  key: string;
  value: number;
  /** Of the first stage, 0–100, one decimal. Null when the first stage is 0. */
  ofFirst: number | null;
  /** Of the stage before, 0–100+, one decimal. Null for the first stage or after a 0. */
  ofPrevious: number | null;
}

export function funnelSteps(stages: ReadonlyArray<{ key: string; value: number }>): FunnelStep[] {
  const first = stages[0]?.value ?? 0;
  return stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].value : 0;
    return {
      key: s.key,
      value: s.value,
      ofFirst: first > 0 ? Math.round((s.value / first) * 1000) / 10 : null,
      ofPrevious: i > 0 && prev > 0 ? Math.round((s.value / prev) * 1000) / 10 : null,
    };
  });
}

// ------------------------------------------------------------------ ranges

export type RangePreset = '7' | '30' | '90' | 'custom';

/** Today in Baghdad (UTC+3, no daylight saving) as YYYY-MM-DD. */
export function baghdadToday(now = Date.now()): string {
  return new Date(now + 3 * 3_600_000).toISOString().slice(0, 10);
}

export function addDay(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return '';
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysInclusive(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export const MAX_RANGE_DAYS = 366;

/** A preset's range ending today (Baghdad). */
export function rangeFor(preset: Exclude<RangePreset, 'custom'>, today = baghdadToday()): { from: string; to: string } {
  return { from: addDay(today, -(Number(preset) - 1)), to: today };
}

export type RangeProblem = 'missing' | 'order' | 'future' | 'too_long';

/** Why a custom range cannot be asked for — checked before the server says the same. */
export function customRangeProblem(from: string, to: string, today = baghdadToday()): RangeProblem | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'missing';
  const days = daysInclusive(from, to);
  if (days === null) return 'missing';
  if (days <= 0) return 'order';
  if (to > today) return 'future';
  if (days > MAX_RANGE_DAYS) return 'too_long';
  return null;
}

// ------------------------------------------------------------------ tables

/** The rows a daily chart's table view shows — every day, the chart's own numbers. */
export function dailyTableRows<T extends { day: string }>(series: readonly T[], pick: (row: T) => number): Array<{ day: string; value: number }> {
  return series.map((r) => ({ day: r.day, value: pick(r) }));
}

/** The largest value in a series, for its axis. */
export function seriesMax(values: readonly number[]): number {
  let m = 0;
  for (const v of values) if (Number.isFinite(v) && v > m) m = v;
  return m;
}
