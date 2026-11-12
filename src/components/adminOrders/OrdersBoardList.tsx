/**
 * THE BOARD'S ANSWER, DRAWN — the header line under «الطلبات», the note under
 * it, the archive's «الأحدث أولًا / الأقدم أولًا» switch and the list itself, as
 * pure functions of the server's answer. OrdersBoard.tsx keeps the state, the
 * requests and the controls; this file only draws what one answer says, so
 * tests render it with the route's own JSON (tests/orderArchiveUi.test.ts,
 * tests/orderBoardLateness.test.ts) instead of pinning source text — which is
 * how a lookup's finished orders reached «اليوم» and a red «متأخر ٢»
 * unnoticed (the review of DECISIONS row 323).
 *
 * WHICH OF THE THREE LISTS is `listModeOf` (archiveSort.ts): the live board's
 * day groups, the archive's one list by when each order was finished, or a
 * lookup's one list of results. Only the day groups count a day as late.
 */
import type { ReactNode } from 'react';
import type { AdminOrderRow, AdminOrdersResponse, OrderDueBucket } from '../../lib/api';
import { countText } from './OrderBoardBadges';
import { PREPARE_DAY_STRINGS, dayLine } from './prepareDayStrings';
import { ARCHIVE_SCOPES, ARCHIVE_SORTS, ARCHIVE_STRINGS, listModeOf, say, type ArchiveSort } from './archiveSort';

type Loc = (ar: string, en: string, ckb?: string) => string;
/** The parts of the answer drawn here. */
type Answer = Pick<AdminOrdersResponse, 'scope' | 'orders' | 'total' | 'counts' | 'search' | 'sort'>;

/**
 * The day headers, in the order the server already returns rows in (day
 * ascending, NULLs last), so grouping never reorders anything.
 *
 * THE DAY IS THE DAY TO PREPARE (DECISIONS row 322). «اليوم» is what needs us
 * today: packed and handed to the courier at 7 pm, a day before the customer's
 * day — or arriving today, for our own same-day delivery and for a parcel
 * already with the courier. The words did not change; the row says whose day
 * it names («التوصيل: غدًا»), and the note under the header says the rule.
 *
 * OVERDUE IS NOT A GROUP OF ITS OWN. The server takes the same view for its
 * `due=today` filter: «a box that should have gone out on Tuesday is not a
 * separate kind of work on Wednesday — it is today's work, and it is the most
 * urgent of it». It sorts first inside «اليوم» because its day is earlier, and
 * the row itself is marked «متأخر».
 */
export type GroupKey = 'today' | 'tomorrow' | 'week' | 'later' | 'unscheduled';
export const GROUPS: Array<{ id: GroupKey; ar: string; en: string; ckb: string }> = [
  { id: 'today', ar: 'اليوم', en: 'Today', ckb: 'ئەمڕۆ' },
  { id: 'tomorrow', ar: 'غدًا', en: 'Tomorrow', ckb: 'بەیانی' },
  { id: 'week', ar: 'هذا الأسبوع', en: 'This week', ckb: 'ئەم هەفتەیە' },
  { id: 'later', ar: 'لاحقًا', en: 'Later', ckb: 'دواتر' },
  { id: 'unscheduled', ar: 'بلا موعد', en: 'No day', ckb: 'بێ ڕۆژ' },
];

export const groupOf = (bucket?: OrderDueBucket): GroupKey => {
  // A missing bucket is «بلا موعد», never today: an order with no day named is
  // not work for this morning, and `null` must never COALESCE to a day.
  if (!bucket) return 'unscheduled';
  return bucket === 'overdue' ? 'today' : bucket;
};

export const EMPTY_COUNTS: AdminOrdersResponse['counts'] = {
  total: 0, overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, unscheduled: 0,
};

/**
 * THE HEADER LINE. TEXT, NOT CHIPS. Four numbers an owner reads in one glance
 * on a busy morning; the only coloured one is the one that means "late".
 *
 * Only the live board's day groups have a day to be late on. The archive's
 * line is the half shown and its total («تم التسليم ٩», row 323); a lookup's
 * is «نتائج البحث N» — its rows may be a customer's delivered and cancelled
 * orders, whose past days the counts would otherwise call «متأخر».
 *
 * The PRO segment counts the rows ON THIS PAGE, because the server's counts
 * block carries no PRO column — it counts days. On page one that is the top of
 * the board and matches what the eye sees; as soon as there is a second page
 * it could be read as a board total, so it says which it is.
 */
export function BoardHeaderLine({ data, loc, latin, pages }: { data: Answer | null; loc: Loc; latin: boolean; pages: number }) {
  const mode = listModeOf(data);
  const total = data?.total ?? 0;
  if (mode !== 'groups') {
    const title = mode === 'results' ? ARCHIVE_STRINGS.results : (ARCHIVE_SCOPES.find((s) => s.id === data?.scope) ?? ARCHIVE_SCOPES[0]);
    return (
      <p data-order-buckets className="mt-1 text-[13px] leading-[1.6] text-text-secondary">
        <span data-order-list-total={mode} className="tabular-nums">
          {say(loc, title)} {countText(total, latin)}
        </span>
      </p>
    );
  }
  const counts = data?.counts ?? EMPTY_COUNTS;
  const proHere = (data?.orders ?? []).filter((o) => o.priority === 1).length;
  return (
    <p data-order-buckets className="mt-1 text-[13px] leading-[1.6] text-text-secondary">
      <span className="tabular-nums">
        {loc('اليوم', 'Today', 'ئەمڕۆ')} {countText(counts.today + counts.overdue, latin)}
      </span>
      <span className="mx-1.5 text-text-muted" aria-hidden>·</span>
      <span className="tabular-nums">
        {loc('غدًا', 'Tomorrow', 'بەیانی')} {countText(counts.tomorrow, latin)}
      </span>
      {counts.overdue > 0 && (
        <>
          <span className="mx-1.5 text-text-muted" aria-hidden>·</span>
          <span data-order-overdue-count className="tabular-nums font-bold text-danger">
            {loc('متأخر', 'Overdue', 'دواکەوتوو')} {countText(counts.overdue, latin)}
          </span>
        </>
      )}
      {proHere > 0 && (
        <>
          <span className="mx-1.5 text-text-muted" aria-hidden>·</span>
          <span className="tabular-nums">
            PRO {countText(proHere, latin)}
            {pages > 1 && <span className="ms-1 text-text-muted">{loc('(هذه الصفحة)', '(this page)', '(ئەم پەڕەیە)')}</span>}
          </span>
        </>
      )}
    </p>
  );
}

/**
 * WHY AN ORDER FOR TOMORROW IS UNDER «اليوم» (row 322), once, in muted words —
 * over the live board's day groups only: the archive is one list by when each
 * order was finished (row 323), and a lookup's results have no day headers.
 */
export function BoardNote({ data, loc }: { data: Answer | null; loc: Loc }) {
  if (listModeOf(data) !== 'groups') return null;
  return (
    <p data-order-board-note className="mt-0.5 text-[12px] leading-[1.5] text-text-muted">
      {dayLine(loc, PREPARE_DAY_STRINGS.boardNote)}
    </p>
  );
}

/**
 * «الأحدث أولًا / الأقدم أولًا» (owner, row 323) — the archive only, by when
 * each order was delivered or cancelled. Its own row under the three controls,
 * never a fourth inside theirs (the e2e pins that row at three), in the slot
 * the live board's price filters use. NOT DURING A LOOKUP (the review): an
 * order or phone number keeps the work list's order whatever the switch says
 * (the server echoes `sort: null`), and a pressed «الأقدم أولًا» over results
 * it does not order is a switch that lies.
 */
export function ArchiveSortSwitch({
  archive,
  data,
  value,
  onChoose,
  loc,
}: {
  archive: boolean;
  data: Answer | null;
  value: ArchiveSort;
  onChoose: (sort: ArchiveSort) => void;
  loc: Loc;
}) {
  if (!archive || data?.search?.pierced) return null;
  return (
    <div data-order-archive-sort role="group" aria-label={say(loc, ARCHIVE_STRINGS.sortGroup)} className="flex flex-wrap gap-2 min-w-0">
      {ARCHIVE_SORTS.map((s) => (
        <button
          key={s}
          type="button"
          data-order-sort={s}
          aria-pressed={value === s}
          onClick={() => onChoose(s)}
          className="lv-choice press-scale inline-flex min-h-[44px] items-center px-3 text-[13px] leading-[1.4] font-bold"
        >
          {say(loc, ARCHIVE_STRINGS[s])}
        </button>
      ))}
    </div>
  );
}

/**
 * THE LIST. ONE TRAY OF FLAT ROWS PER DAY, AT EVERY WIDTH (clay: a long list is
 * one resting tray with dividers, never a stack of cards), not a table that
 * becomes one. Sticky headers inside an `overflow-x-auto` table do not stick —
 * the overflow box becomes the scrollport — and that failure appears only at
 * the desktop breakpoint, which is the one nobody re-checks after testing the
 * phone.
 *
 * THE ARCHIVE AND A LOOKUP ARE ONE TRAY, their rows exactly in the server's
 * order and with no day headers: an archive row says its own day («سُلّم …»),
 * and a lookup's live row names its day to prepare itself (`flat`).
 */
export function BoardTrays({
  data,
  loc,
  latin,
  rowOf,
}: {
  data: Answer | null;
  loc: Loc;
  latin: boolean;
  rowOf: (order: AdminOrderRow, flat: boolean) => ReactNode;
}) {
  const mode = listModeOf(data);
  const rows = data?.orders ?? [];
  if (mode !== 'groups') {
    if (rows.length === 0) return null;
    return (
      <section data-order-group={mode} data-order-sorted={data?.sort ?? ''} className="min-w-0">
        <div className="lv-surface divide-y divide-border-subtle overflow-hidden">{rows.map((o) => rowOf(o, true))}</div>
      </section>
    );
  }
  const counts = data?.counts ?? EMPTY_COUNTS;
  /** The board-wide count behind each header. Overdue folds into today. */
  const groupCount = (id: GroupKey): number => (id === 'today' ? counts.today + counts.overdue : counts[id]);
  // The rows come back in day order already (day ascending, NULLs last), so
  // bucketing them preserves the server's ordering inside every group —
  // including the PRO pin, which is a tie-break WITHIN a day.
  const groups = GROUPS.map((g) => ({ ...g, rows: rows.filter((o) => groupOf(o.due_bucket) === g.id) })).filter((g) => g.rows.length > 0);
  return (
    <>
      {groups.map((g) => (
        <section key={g.id} data-order-group={g.id} className="min-w-0">
          {/* On the canvas now (the admin's same-colour panel is gone), so
              the header is the flat canvas: it rests mid-page and sticks over
              plain canvas once the page's light has scrolled away — the
              wash (lv-canvas) would restart the light at its own top. */}
          <h3 className="sticky top-0 z-10 mb-2 flex items-baseline gap-1.5 bg-canvas px-2 py-2 text-[13px] leading-[1.5] font-black text-text-secondary">
            {loc(g.ar, g.en, g.ckb)}
            <span className="tabular-nums text-text-muted">({countText(groupCount(g.id), latin)})</span>
          </h3>
          <div className="lv-surface divide-y divide-border-subtle overflow-hidden">{g.rows.map((o) => rowOf(o, false))}</div>
        </section>
      ))}
    </>
  );
}
