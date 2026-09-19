/**
 * WHICH DAY IT IS IN BAGHDAD, decided on the client the same way the server
 * decides it.
 *
 * ###########################################################################
 * #  THE DEFECT THIS PREVENTS                                               #
 * ###########################################################################
 * `new Date().toISOString().slice(0, 10)` is a UTC day, and Iraq is UTC+3. For
 * the first three hours of every Iraqi day — 00:00 to 03:00 local, 21:00 to
 * 24:00 UTC — that string is YESTERDAY. An owner who opens the profit screen
 * at one in the morning would be asking the server for a range that ends the
 * day before, and today's sales would simply not be on it. Nothing would look
 * broken; the number would just be wrong, every night, for three hours.
 *
 * `worker/lib/baghdadTime.ts` is the platform's one copy of this rule and its
 * header says so. This file is a CLIENT MIRROR of it, not a second opinion:
 * `src/` is bundled for a browser and the Worker tree is not in that graph, so
 * the arithmetic is repeated and the constant is quoted from there. It is four
 * lines, it has no dependencies, and the identical UTC+3 constant is the only
 * thing that has to stay in step. If Iraq ever adopts DST again, that file
 * changes and so does this one.
 *
 * 'YYYY-MM-DD' STRINGS, NEVER Date OBJECTS, for the same reason: a
 * fixed-width civil date compares lexicographically in date order, so no
 * comparison anywhere — here or in SQL — has to pick a timezone.
 */

/** Iraq's fixed offset from UTC. No DST since 2007 (worker/lib/baghdadTime.ts). */
const BAGHDAD_OFFSET_MS = 3 * 3_600_000;

const pad = (n: number): string => String(n).padStart(2, '0');

const dayFromUtcMs = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** The Baghdad civil day for an instant, optionally shifted by whole days. */
export function baghdadDay(atMs: number, offsetDays = 0): string {
  return dayFromUtcMs(atMs + BAGHDAD_OFFSET_MS + offsetDays * 86_400_000);
}

/** The parts of a 'YYYY-MM-DD', or null when it is not one. Shape AND validity. */
export function dayParts(day: string): { y: number; m: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d);
  // SHAPE IS NOT VALIDITY: '2026-02-31' matches the regex. A date that does not
  // format back to the string it came from was never that date.
  if (!Number.isFinite(ms) || dayFromUtcMs(ms) !== day) return null;
  return { y, m, d };
}

export const isDay = (value: string): boolean => dayParts(value) !== null;

/** Whole days between two day strings, inclusive of both ends, or null. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayParts(from);
  const b = dayParts(to);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) + 1;
}

/** The first day of the Baghdad month an instant falls in. */
export function baghdadMonthStart(atMs: number): string {
  const today = baghdadDay(atMs);
  return `${today.slice(0, 7)}-01`;
}

/**
 * THE PERIOD PRESETS — rows, not a calendar grid.
 *
 * Nobody fights a two-month calendar to say "last 30 days", so the presets are
 * the primary control and the custom range sits behind them for the one case
 * they do not cover. The ids are stable strings because they are also what the
 * screen marks as selected.
 *
 * Every preset ENDS TODAY. A preset that ended yesterday would answer a
 * different question than the one the owner is asking when they open the
 * screen at nine in the morning to see how the shop is doing.
 */
export type PresetId = 'today' | 'last7' | 'last30' | 'month' | 'last90' | 'custom';

export const PRESET_IDS: readonly PresetId[] = ['today', 'last7', 'last30', 'month', 'last90', 'custom'];

/** The span a preset means, resolved against a real instant. */
export function presetRange(id: PresetId, atMs: number): { from: string; to: string } {
  const today = baghdadDay(atMs);
  switch (id) {
    case 'today':
      return { from: today, to: today };
    case 'last7':
      return { from: baghdadDay(atMs, -6), to: today };
    case 'last30':
      return { from: baghdadDay(atMs, -29), to: today };
    case 'month':
      return { from: baghdadMonthStart(atMs), to: today };
    case 'last90':
      return { from: baghdadDay(atMs, -89), to: today };
    case 'custom':
      // A custom range keeps whatever the owner typed; this is only the
      // starting point offered when they first switch to it.
      return { from: baghdadDay(atMs, -29), to: today };
  }
}

/** The server's ceiling (`MAX_RANGE_DAYS` in worker/lib/financeReport.ts). */
export const MAX_RANGE_DAYS = 366;

/**
 * WHICH BUCKET SIZE A SPAN DESERVES.
 *
 * A line with 366 daily points on a 900px card is a solid band with no
 * readable shape, and a line with one point is not a line at all. So the
 * granularity follows the span by default: days up to about five weeks, weeks
 * up to about a third of a year, months beyond that. The owner can still
 * override it — a 90-day period read in days is a legitimate thing to want —
 * which is why this is a DEFAULT and not a constraint.
 *
 * A single-day period has exactly one bucket whatever is asked for, so it
 * takes 'range': one bucket asked for honestly, rather than a one-point line
 * chart that draws nothing and reads as a bug.
 */
export function defaultGranularity(days: number): 'day' | 'week' | 'month' | 'range' {
  if (days <= 1) return 'range';
  if (days <= 35) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/**
 * Validate a range the owner typed, in the same terms the server would.
 *
 * Checked HERE as well as there because a 400 that says «from must be on or
 * before to» after a round trip, on a screen whose numbers have meanwhile gone
 * blank, is a worse answer than a sentence under the field that never let the
 * request leave. The server still enforces all of it — this is a courtesy, not
 * a gate.
 */
export type RangeProblem = 'from_not_a_day' | 'to_not_a_day' | 'reversed' | 'too_long' | null;

export function rangeProblem(from: string, to: string): RangeProblem {
  if (!isDay(from)) return 'from_not_a_day';
  if (!isDay(to)) return 'to_not_a_day';
  const days = daysBetween(from, to);
  if (days === null || days <= 0) return 'reversed';
  if (days > MAX_RANGE_DAYS) return 'too_long';
  return null;
}
