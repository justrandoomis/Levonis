/**
 * THE COMPLETED ORDERS ON THE SCREEN, NEWEST OR OLDEST FIRST (DECISIONS row
 * 323) — «completed orders should have a filter, latest or oldest first».
 *
 * The server sorts the archive by when each order was finished
 * (worker/lib/orderArchive.ts); this file holds what the board does with that:
 *
 *   · the switch «الأحدث أولًا / الأقدم أولًا», remembered per browser — a
 *     convenience only, so storage that is blocked or throws reads as newest
 *     and a refused write keeps the choice for the visit;
 *   · ONE LIST IN THE SERVER'S ORDER (`archiveRowsOf`). The live board files
 *     rows under day headers; doing that to the archive would put a delivery
 *     made this morning under the day it was due and scramble the order the
 *     owner asked for;
 *   · the finished row's chip, «سُلّم الثلاثاء ١٠ تشرين الثاني» / «أُلغي اليوم»,
 *     in place of the delivery day — so a finished order is never «متأخر».
 *
 * ONE TYPED TABLE, so a sentence missing a language does not compile; the
 * `ckb` slot is its own Sorani, never the Arabic pasted across (DECISIONS row
 * 183), and tests/orderArchiveUi.test.ts holds every entry to that. `{day}` is
 * the label the SERVER wrote (`done_label`), already in the reader's language
 * and digits. Pure data and pure functions; no React.
 */
import type { AdminArchiveSort, AdminOrderRow, AdminOrdersResponse } from '../../lib/api';
import { dayLine, type Tri } from './prepareDayStrings';

export type ArchiveSort = AdminArchiveSort;
/** In the order the switch shows them: the default first. */
export const ARCHIVE_SORTS: readonly ArchiveSort[] = ['newest', 'oldest'];
/** This browser's choice (beside `levonis.admin.warrantyView`). */
export const ARCHIVE_SORT_KEY = 'levonis.admin.ordersArchiveSort';

export const ARCHIVE_STRINGS = {
  /** The switch: the order finished most recently first (the default)… */
  newest: { ar: 'الأحدث أولًا', en: 'Newest first', ckb: 'نوێترین سەرەتا' },
  /** …or the one finished longest ago. */
  oldest: { ar: 'الأقدم أولًا', en: 'Oldest first', ckb: 'کۆنترین سەرەتا' },
  /** The switch's name for a screen reader. */
  sortGroup: { ar: 'ترتيب الطلبات المكتملة', en: 'Sort completed orders', ckb: 'ڕیزکردنی داواکارییە تەواوبووەکان' },
  /** A delivered row's chip: the day it was delivered. */
  delivered: { ar: 'سُلّم {day}', en: 'Delivered: {day}', ckb: 'گەیەنرا: {day}' },
  /** A cancelled row's chip: the day it was cancelled. */
  cancelled: { ar: 'أُلغي {day}', en: 'Cancelled: {day}', ckb: 'هەڵوەشێنرا: {day}' },
  /** The same, for a row with no recorded time (legacy or hand-edited data). */
  deliveredNoDay: { ar: 'سُلّم', en: 'Delivered', ckb: 'گەیەنرا' },
  cancelledNoDay: { ar: 'أُلغي', en: 'Cancelled', ckb: 'هەڵوەشێنرا' },
  /** The archive's header during an order- or phone-number lookup, which ignores the half chosen. */
  results: { ar: 'نتائج البحث', en: 'Search results', ckb: 'ئەنجامی گەڕان' },
} satisfies Record<string, Tri>;

type Loc = (ar: string, en: string, ckb?: string) => string;

/** One entry of the table through the screen's own `loc`. */
export const say = (loc: Loc, entry: Tri): string => loc(entry.ar, entry.en, entry.ckb);

/** Where the choice is kept. Reading `window.localStorage` itself throws where storage is blocked, so callers read it inside their `try`. */
export const browserStorage = (): Storage | null => (typeof window === 'undefined' ? null : window.localStorage);

/** The archive's order this browser chose: newest unless it chose oldest. Never throws. */
export function readArchiveSort(storage: () => Pick<Storage, 'getItem'> | null | undefined = browserStorage): ArchiveSort {
  try {
    return storage()?.getItem(ARCHIVE_SORT_KEY) === 'oldest' ? 'oldest' : 'newest';
  } catch {
    return 'newest';
  }
}

/** Remembers the choice; false when the storage refuses (private mode) — the choice then lasts the visit. Never throws. */
export function saveArchiveSort(sort: ArchiveSort, storage: () => Pick<Storage, 'setItem'> | null | undefined = browserStorage): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(ARCHIVE_SORT_KEY, sort);
    return true;
  } catch {
    return false;
  }
}

/** A finished order: delivered or cancelled. */
export const isFinished = (status: unknown): status is 'delivered' | 'cancelled' => status === 'delivered' || status === 'cancelled';

/**
 * THE ARCHIVE'S ROWS, EXACTLY AS THE SERVER SENT THEM — or null when the
 * answer is the live board's, whose rows group by day. Decided by the
 * answer's own `scope` (not the switch), so the list and the header always
 * describe the rows on the screen, even while the next answer is loading.
 */
export function archiveRowsOf(data: Pick<AdminOrdersResponse, 'scope' | 'orders'> | null | undefined): AdminOrderRow[] | null {
  if (!data || !isFinished(data.scope)) return null;
  return Array.isArray(data.orders) ? data.orders : [];
}

/** A finished row's chip: «سُلّم <day>» / «أُلغي <day>», or the verb alone when no time was recorded. */
export function doneText(loc: Loc, status: 'delivered' | 'cancelled', label = ''): string {
  if (!label) return say(loc, status === 'cancelled' ? ARCHIVE_STRINGS.cancelledNoDay : ARCHIVE_STRINGS.deliveredNoDay);
  return dayLine(loc, status === 'cancelled' ? ARCHIVE_STRINGS.cancelled : ARCHIVE_STRINGS.delivered, label);
}
