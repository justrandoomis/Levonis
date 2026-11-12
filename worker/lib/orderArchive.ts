/**
 * THE COMPLETED ORDERS, NEWEST OR OLDEST FIRST — «completed orders should have
 * a filter, latest or oldest first» (owner, 2026-11-11; DECISIONS row 323).
 *
 * The archive (scope=delivered|cancelled, «المكتملة») used the live board's
 * due-day order, so it opened on the OLDEST delivery day and the order finished
 * this morning was the last row of the last page. It now sorts by WHEN EACH
 * ORDER WAS FINISHED:
 *
 *   «تم التسليم»  `orders.delivered_at` — written in the same UPDATE as every
 *                 flip into delivered (the stage door, the courier sync and the
 *                 sweeps through orderStageOps.ts, the legacy status PATCH, and
 *                 merchant.ts), always as fixed-width ISO-Z, so text order is
 *                 time order;
 *   «ملغاة»       `orders.cancelled_at` — kept by migration 0081's triggers:
 *                 stamped on a flip into cancelled, cleared on a re-open.
 *
 * ONE COLUMN PER HALF, NEVER `COALESCE(delivered_at, cancelled_at)`: each half
 * is one status, so one column says it, and an expression reads no index —
 * the cancelled half sorts on idx_orders_cancelled_retention (status,
 * cancelled_at) with only the `o.id` tie-break left to sort. The delivered
 * half has no index on its clock and sorts its status's rows in a temp
 * B-tree, the same cost class the archive has paid since it existed (the
 * COUNT and the facet beside it already read every row of the half).
 *
 * THE ID BREAKS TIES IN THE SAME DIRECTION, so the order is total (a row is
 * never on two pages, or on none) and «الأقدم أولًا» is the exact reverse of
 * «الأحدث أولًا». A row with no completion time (legacy or hand-edited data —
 * every writer stamps one) sorts as the oldest: SQLite puts NULL, then '',
 * before every time, so it is last under newest-first and first under
 * oldest-first. NULLS LAST would cost the cancelled half its index order.
 *
 * Every value written into SQL text here is from a closed set and checked
 * again before it is used, as `deliveryLead.ts` does with its table.
 *
 * A LEAF beside deliveryLead.ts: it imports only ./baghdadTime and the day
 * labels of ./deliveryDay.
 */
import { baghdadDayOf, isDay } from './baghdadTime';
import { dayLabel } from './deliveryDay';

/** «الأحدث أولًا» / «الأقدم أولًا» — the `sort` the board route accepts. */
export const ARCHIVE_SORTS = ['newest', 'oldest'] as const;
export type ArchiveSort = (typeof ARCHIVE_SORTS)[number];
/** What the archive opens on: the order finished most recently, first. */
export const DEFAULT_ARCHIVE_SORT: ArchiveSort = 'newest';

/** The two halves of the archive, and the column that says when an order in each was finished. */
export const ARCHIVE_DONE_COLUMN = Object.freeze({ delivered: 'delivered_at', cancelled: 'cancelled_at' } as const);
export type ArchiveScope = keyof typeof ARCHIVE_DONE_COLUMN;

const DIRECTION: Readonly<Record<ArchiveSort, 'ASC' | 'DESC'>> = Object.freeze({ newest: 'DESC', oldest: 'ASC' });

const own = (map: object, key: unknown): key is string =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);

/** Whether a board scope is a half of the archive. */
export function isArchiveScope(scope: unknown): scope is ArchiveScope {
  return own(ARCHIVE_DONE_COLUMN, scope);
}

/**
 * The archive's ORDER BY: the half's own completion column, then the id, both
 * in the chosen direction. Throws on anything outside the two closed sets —
 * the route validates `sort` with `oneOf` first, so this is the second check,
 * never the first.
 */
export function archiveOrderSql(scope: ArchiveScope, sort: ArchiveSort): string {
  if (!isArchiveScope(scope)) throw new Error(`archiveOrderSql: not an archive scope: ${String(scope)}`);
  if (!own(DIRECTION, sort)) throw new Error(`archiveOrderSql: not an archive sort: ${String(sort)}`);
  const dir = DIRECTION[sort];
  return `ORDER BY o.${ARCHIVE_DONE_COLUMN[scope]} ${dir}, o.id ${dir}`;
}

/** The row fields the completion time is read from. */
export interface DoneRow {
  status?: unknown;
  delivered_at?: unknown;
  cancelled_at?: unknown;
}

/** When the order was finished, as stored — `delivered_at` for a delivered order, `cancelled_at` for a cancelled one; '' otherwise. */
export function doneAtOf(o: DoneRow): string {
  const status = String(o.status ?? '');
  const at = status === 'delivered' ? o.delivered_at : status === 'cancelled' ? o.cancelled_at : null;
  return typeof at === 'string' ? at.trim() : '';
}

/** The Baghdad day the order was finished on — never `slice(0, 10)`, which files 21:00-24:00 UTC under the day before. '' when unknown. */
export function doneDayOf(o: DoneRow): string {
  const at = doneAtOf(o);
  return at ? baghdadDayOf(at) : '';
}

/** ASCII digits → ٠-٩, as dayLabel writes ar and ckb. */
const arabicIndic = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));

/**
 * The day it was finished, labelled like every day on the board — «اليوم»,
 * «الثلاثاء ١٠ تشرين الثاني» — in the reader's language and digits, with the
 * year added when it is not this year («… ٢٠٢٥»), because dayLabel names no
 * year and a completion can be from any year. '' for a live order or an
 * unknown time. The screen puts it after «سُلّم» / «أُلغي».
 */
export function doneLabelOf(o: DoneRow, today: string, lang: string): string {
  const day = doneDayOf(o);
  if (!isDay(day)) return '';
  const { label } = dayLabel(day, today, lang);
  if (!label) return '';
  const year = day.slice(0, 4);
  if (isDay(today) && today.slice(0, 4) === year) return label;
  return `${label} ${lang === 'en' ? year : arabicIndic(year)}`;
}
