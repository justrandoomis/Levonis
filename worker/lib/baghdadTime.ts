/**
 * THE DAY BOUNDARY. One copy, for the whole platform.
 *
 * Iraq is UTC+3 all year — no DST since 2007 — so "which day is it" is one
 * addition. The reason this file exists is that the addition was already
 * written TWICE (`baghdadDay` in pointsTasks.ts, `baghdadDayOf` in
 * farm/time.ts) and was about to be written a third time for the delivery
 * board. Three copies of a rule are three chances for one of them to drift,
 * and the one that drifts is the one deciding whether an order belongs on
 * today's board.
 *
 * THE DEFECT THIS PREVENTS, already recorded in worker/routes/rewards.ts: a
 * day string derived from UTC LAGS Baghdad between 21:00 and 24:00 UTC — that
 * is 00:00–03:00 local, the first three hours of every Iraqi day. An order
 * placed at 01:00 on the 19th is a UTC 18th. So is a check-in, and so is a
 * warranty clock. SQLite's `date('now')` is UTC and is therefore wrong for
 * three hours out of every twenty-four; it must never decide a bucket.
 *
 * WHY 'YYYY-MM-DD' STRINGS AND NOT Date OBJECTS. A fixed-width, zero-padded
 * civil date compares LEXICOGRAPHICALLY in date order: `'2026-09-19' <
 * '2026-09-23'` is true, and so is the SQL `<` on the same two values. That
 * means no comparison anywhere — TypeScript or SQL — needs to construct a Date
 * or pick a timezone, and there is no second place for a timezone to be got
 * wrong. Every function here takes and returns those strings.
 *
 * THIS IS A LEAF MODULE. It imports nothing from the worker, and nothing may
 * be added to it that does. `settings.ts` is imported by half the tree, and an
 * import cycle through it leaves a `const` uninitialised at runtime — the same
 * reason `orderExpiry.ts`, `farm/config.ts` and `warrantyConfig.ts` are
 * leaves. `deliveryDay.ts` imports this; if this ever imported `settings.ts`
 * back, checkout would start reading `undefined` for a module constant with no
 * type error to warn anyone.
 *
 * '' IS THE "NO DAY" ANSWER, and it is never a throw. Unparseable input
 * returns the empty string, which sorts before every real day and is falsy, so
 * a caller can test it. `new Date(NaN).toISOString()` throws a RangeError, and
 * a throw inside a map over thirty board rows takes the whole admin screen
 * down over one row with a bad `created_at`.
 */

/** Iraq's fixed offset from UTC. No DST since 2007, so this is a constant. */
export const BAGHDAD_OFFSET_MS = 3 * 3_600_000;

/**
 * The shape of a civil day string, and the ONLY definition of it in the
 * codebase. Migration 0094 encodes the same shape as a SQL GLOB on
 * `orders.delivery_due_day`; the two must keep agreeing, so neither is
 * loosened without the other.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is this a well-formed 'YYYY-MM-DD'? Shape only — see `dayParts` for real. */
export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY_RE.test(value);
}

/**
 * The year/month/day of a day string, or null when it is not one.
 *
 * SHAPE IS NOT VALIDITY: '2026-02-31' and '2026-13-01' both match the regex.
 * The round-trip through `Date.UTC` is what rejects them — a date that does
 * not format back to the string it came from was never that date.
 */
export function dayParts(day: string): { y: number; m: number; d: number } | null {
  if (!isDay(day)) return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms) || fromUtcMs(ms) !== day) return null;
  return { y, m, d };
}

/**
 * The Baghdad calendar day at an instant, optionally offset by whole days.
 *
 * ARGUMENT ORDER: `(nowMs, offsetDays)`. `pointsTasks.baghdadDay` keeps the
 * OPPOSITE order for its own callers and delegates here — see the note on it.
 * Both arguments are numbers, so a swap is invisible to the type checker; that
 * is exactly why the two orders are documented on both sides rather than
 * quietly reconciled.
 *
 * `nowMs` is always the SERVER's `Date.now()`. Nothing derived from a request
 * may reach it: a day a client can choose is a day a client can be paid for.
 */
export function baghdadDay(nowMs: number, offsetDays = 0): string {
  if (!Number.isFinite(nowMs)) return '';
  return fromUtcMs(nowMs + BAGHDAD_OFFSET_MS + offsetDays * 86_400_000);
}

/**
 * The Baghdad calendar day an ISO instant falls on.
 *
 * THIS IS NOT `iso.slice(0, 10)`, and the difference is a whole day for every
 * instant between 21:00 and 24:00 UTC. `created_at = '2026-09-18T22:00:00Z'`
 * is an order placed at one in the morning on the NINETEENTH in Baghdad, and
 * slicing it hands that customer a delivery window one day shorter than the
 * one they were promised.
 */
export function baghdadDayOf(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return fromUtcMs(t + BAGHDAD_OFFSET_MS);
}

/**
 * `n` whole days after (or before, when negative) a day string.
 *
 * `Date.UTC` normalises the overflow, so month ends, leap days and year
 * boundaries need no special case: 2026-12-30 + 3 is 2027-01-02.
 */
export function addDays(day: string, n: number): string {
  const p = dayParts(day);
  if (!p || !Number.isFinite(n)) return '';
  return fromUtcMs(Date.UTC(p.y, p.m - 1, p.d + Math.trunc(n)));
}

/**
 * The day of the week, 0 = Sunday, or -1 when the day is not one.
 *
 * `getUTCDay()` and never `getDay()`: the second reads the HOST's timezone,
 * which on a Worker is UTC and on a developer's laptop is whatever they set —
 * two different answers from the same code, one of them found in production.
 */
export function dayOfWeek(day: string): number {
  const p = dayParts(day);
  if (!p) return -1;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** ms → 'YYYY-MM-DD'. The one place a Date is built, and never for a compare. */
function fromUtcMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
