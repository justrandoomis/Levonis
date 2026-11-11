import type { FinanceRange } from './types';

/**
 * WHAT A PERIOD IS COMPARED WITH (redesign step 2, owner 2026-11-11).
 *
 * `month`: the same days one month earlier — 1–11 Nov against 1–11 Oct, the
 * comparison a shop owner reads at a glance; the end day is clamped to the
 * shorter month (31 Mar → 28/29 Feb). `previous`: the period of the same length
 * just before. `none`: no comparison. A range inside one calendar month defaults
 * to `month`, any other to `previous`. Dates are Baghdad days as strings, never
 * through a local clock.
 */
export type CompareMode = 'month' | 'previous' | 'none';

const DAY = 86_400_000;
const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysIn = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** The same day one month earlier, clamped to that month's length. */
export function monthEarlier(day: string): string {
  const y = Number(day.slice(0, 4)), m0 = Number(day.slice(5, 7)) - 1, d = Number(day.slice(8, 10));
  const py = m0 === 0 ? y - 1 : y, pm0 = m0 === 0 ? 11 : m0 - 1;
  return `${py}-${String(pm0 + 1).padStart(2, '0')}-${String(Math.min(d, daysIn(py, pm0))).padStart(2, '0')}`;
}

export function defaultCompare(range: FinanceRange): CompareMode {
  return range.from.slice(0, 7) === range.to.slice(0, 7) ? 'month' : 'previous';
}

/** The longest period /summary answers: its last day at most 365 days after its first (worker range(), validFinanceRange). */
export const MAX_SPAN_DAYS = 365;

export function compareRange(range: FinanceRange, mode: CompareMode): FinanceRange | null {
  if (mode === 'none') return null;
  if (mode === 'month') {
    // A year-long range moved a month back can come out a day longer than the server answers (31 Mar – 30 Mar of the
    // next year lands on 28 Feb – 29 Feb of a leap year): its first day moves up, so the comparison is always readable.
    const from = monthEarlier(range.from), to = monthEarlier(range.to);
    return { from: at(to) - at(from) > MAX_SPAN_DAYS * DAY ? iso(at(to) - MAX_SPAN_DAYS * DAY) : from, to };
  }
  const days = Math.round((at(range.to) - at(range.from)) / DAY) + 1;
  const to = at(range.from) - DAY;
  return { from: iso(to - (days - 1) * DAY), to: iso(to) };
}

/** The change from `before` to `now` as a share of `before`; null when there is nothing to compare. */
export function change(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || before === 0) return null;
  return (now - before) / Math.abs(before);
}

/** A figure that crossed zero — a loss that became a profit (`up`) or the reverse (`down`) — has no meaningful percentage. */
export function signFlip(now: number | null | undefined, before: number | null | undefined): 'up' | 'down' | null {
  if (now == null || before == null || now === 0 || before === 0 || Math.sign(now) === Math.sign(before)) return null;
  return now > 0 ? 'up' : 'down';
}
