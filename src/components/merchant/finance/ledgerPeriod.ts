/**
 * THE LEDGER'S PERIOD — which lines a merchant reconciles at a time: this
 * month, last month, or two days they choose. In BAGHDAD days: a merchant
 * counting the cash a courier brought on the 1st means the 1st in Baghdad.
 *
 * The server (`GET /api/merchant/finance/ledger`, worker/routes/merchantFinance.ts)
 * takes `from` (inclusive) and `to` (exclusive) and compares them with each
 * line's `created_at`, a UTC instant ('YYYY-MM-DDTHH:MM:SS.sssZ',
 * worker/lib/merchantLedger.ts `ledgerPage`). A Baghdad day begins at 21:00
 * UTC the day before (UTC+3, no daylight saving since 2007 —
 * worker/lib/baghdadTime.ts), so each bound is sent as THAT instant, in the
 * same spelling as `created_at`, which the route accepts (its `ISO_DAY`
 * allows the time). A bare day would cut every month three hours late: a sale
 * at 01:00 on the 1st in Baghdad is still the 31st in UTC.
 *
 * Pure strings in, strings out — no Date object leaves this file.
 */
export type LedgerPeriod = 'all' | 'this_month' | 'last_month' | 'custom';

export const LEDGER_PERIODS: readonly LedgerPeriod[] = ['all', 'this_month', 'last_month', 'custom'];

/** Iraq's fixed offset from UTC. */
const BAGHDAD_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A real calendar day 'YYYY-MM-DD' (shape and validity: '2026-02-31' is not one). */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && dayOf(ms) === value;
}

/** Today in Baghdad. */
export function baghdadToday(now: number = Date.now()): string {
  return dayOf(now + BAGHDAD_OFFSET_MS);
}

/** The day `n` days after `day` (negative: before). */
export function addDays(day: string, n: number): string {
  return dayOf(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS);
}

/** The UTC instant a Baghdad day begins, spelled as the ledger spells `created_at`. */
export function baghdadDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - BAGHDAD_OFFSET_MS).toISOString();
}

/** The first day of the month before the one `day` is in. */
function previousMonthStart(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

export type LedgerRange = { from: string; to: string };
export type LedgerRangeAnswer = { ok: true; range: LedgerRange } | { ok: false; reason: 'incomplete' | 'order' };

/**
 * The `from` / `to` the ledger request carries for a period. Empty strings
 * mean "no bound". A custom range is the two days the merchant typed, both
 * included; it is refused when a day is missing or the first comes after the
 * second — never silently swapped.
 */
export function ledgerRange(period: LedgerPeriod, now: number, custom: LedgerRange = { from: '', to: '' }): LedgerRangeAnswer {
  const today = baghdadToday(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (period) {
    case 'this_month':
      return { ok: true, range: { from: baghdadDayStart(monthStart), to: '' } };
    case 'last_month':
      return { ok: true, range: { from: baghdadDayStart(previousMonthStart(today)), to: baghdadDayStart(monthStart) } };
    case 'custom':
      if (!isDay(custom.from) || !isDay(custom.to)) return { ok: false, reason: 'incomplete' };
      if (custom.from > custom.to) return { ok: false, reason: 'order' };
      return { ok: true, range: { from: baghdadDayStart(custom.from), to: baghdadDayStart(addDays(custom.to, 1)) } };
    default:
      return { ok: true, range: { from: '', to: '' } };
  }
}
