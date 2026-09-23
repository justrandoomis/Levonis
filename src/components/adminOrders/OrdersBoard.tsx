/**
 * ===========================================================================
 *  THE ADMIN ORDER BOARD — «أريد ترتيب إدارة الطلبات في اللوحة الإدارة بشكل
 *  أفضل وأكثر تنسيقا»
 * ===========================================================================
 * «أكثر تنسيقا» is BETTER ORGANISED, not more controls. That sentence is the
 * whole design brief, and it is the one to check every addition against.
 *
 * FOUR THINGS, NOT A FILTER PANEL:
 *
 *   1. ONE HEADER LINE of counts, as text — «اليوم ٦ · غدًا ٣ · متأخر ١».
 *      Overdue is the only thing on this screen allowed to be red. If
 *      everything is coloured, nothing is urgent.
 *   2. ONE SEARCH BOX, debounced, whose result is labelled with the reading
 *      the server chose (see OrderSearchField).
 *   3. ONE ROW OF THREE CONTROLS. Two dimensions are real here — WHEN a box
 *      goes out and WHAT KIND of order it is — but only ONE of them is a
 *      control, because the WHEN dimension is answered by the shape of the
 *      list itself.
 *   4. THE LIST, GROUPED BY DAY with sticky headers. No click is needed for
 *      the question the owner asks every morning.
 *
 * WHAT REPLACED WHAT. Seven status chips bound to one `statusFilter`, plus a
 * per-row status dropdown, plus a phone card and an 820px table that both
 * identified the customer by their EMAIL. The chips are two selects and a
 * switch; the dropdown moved into the modal's stage panel, which is already
 * the authority; the email is the delivery name and governorate, which were
 * already on the payload.
 *
 * ---------------------------------------------------------------------------
 *  THE JOURNEYS ARE THE «النوع» SELECT, AND «الكل» IS ONE OF THEM
 * ---------------------------------------------------------------------------
 * «فصلها في الطلبات المسبقة» — a container forty days out is a different kind
 * of waiting from a box that has to go out this morning, and interleaving them
 * by day is what made the old board useless. On the server that separation is
 * a SCOPE (`open` is direct-only, `preorder` is everything else), so each
 * option here maps to exactly one (scope, type) pair:
 *
 *      مباشر  → scope=open                          جوي  → preorder + air
 *      بحري   → scope=preorder, type=preorder_sea   بري  → preorder + land
 *      الكل   → scope=all (work list) / NO `type` at all (archive)
 *
 * «الكل» WAS ADDED, AND WHAT THIS NOTE USED TO REJECT IS STILL REJECTED.
 * The option this file refused was an aggregate spelled `scope=preorder`: the
 * archive reaches delivered and cancelled orders through `scope=delivered` /
 * `scope=cancelled`, where the journey can only be expressed as `type`, and
 * `type` has no value meaning "any pre-order" — so that spelling would have
 * worked in the work list and silently shown direct orders in the archive.
 * «الكل» is a different thing and it is honest in BOTH halves, because in both
 * it is an ABSENCE rather than a value: in the work list it is `scope=all`,
 * whose WHERE is the partial index's own and carries no `shipping_type` clause
 * at all; in the archive it is simply no `type` parameter. There is no
 * combination in which it can name the wrong population. The owner asked for
 * it — «الكل» — and this is the spelling that can be given.
 *
 * ---------------------------------------------------------------------------
 *  THE NUMBER BESIDE EACH OPTION
 * ---------------------------------------------------------------------------
 * «عدد بجانب كل خيار». Both vectors come from the server's `options` block,
 * folded from one GROUP BY, and each honours the OTHER select while ignoring
 * its own — so the number beside the option currently chosen is the same
 * number as the board's total, and the other numbers answer "how many would I
 * get if I tapped this". A count computed from `orders` on this page would
 * answer neither: the page is thirty rows of a set that may be three hundred.
 *
 * `options` is NULL during a pierced lookup (an order number, a phone number),
 * and then no option carries a number. That is not a gap — a lookup has no
 * alternatives to count, and a stale number beside an option is worse than
 * none.
 *
 * ---------------------------------------------------------------------------
 *  EVERY DECISION IS THE SERVER'S
 * ---------------------------------------------------------------------------
 * The filter, the page, the day, the bucket and the reading of the search box
 * are all computed in `worker/routes/admin.ts`. This file renders them.
 *
 *  * NO CLIENT-SIDE RE-FILTERING. The page's own older comment already argues
 *    it — «Filtering a page client-side hid every matching order that happened
 *    to fall on another page» — and for the SEARCH it is worse than a hidden
 *    row: the server folds Arabic orthography on both sides, so «احمد» finds
 *    «أحمد علي», and a `.toLowerCase().includes()` laid on top would hide
 *    exactly the rows the feature was built to find.
 *  * NO BUCKET DERIVED FROM A DATE. Between 00:00 and 03:00 Baghdad a
 *    UTC-derived "today" is still yesterday — precisely the early-morning
 *    shift when the delivery runs are planned.
 *  * NO `new Date(day)`. `new Date('2026-09-23')` is UTC midnight, which a
 *    browser west of Baghdad renders as the 22nd. The server sends the label.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Tag } from 'lucide-react';
import { loc as locOutside, useLanguage } from '../../LanguageContext';
import {
  api,
  ApiError,
  type AdminOrderRow,
  type AdminOrdersResponse,
  type OrderDueBucket,
  type OrderStatus,
} from '../../lib/api';
import OrderDetailModal from './OrderDetailModal';
import OrderBoardRow from './OrderBoardRow';
import OrderSearchField from './OrderSearchField';
import { countText } from './OrderBoardBadges';

/** Unchanged from the board this replaces: thirty rows and their items in two
 *  queries, rather than two hundred rows and two hundred and one. */
const PAGE_SIZE = 30;

/** The four journeys, as the server's `type` values, plus «الكل» — which is
 *  the ABSENCE of a journey rather than one of them. See the header note. */
type Journey = 'all' | 'direct' | 'preorder_air' | 'preorder_sea' | 'preorder_land';

/**
 * ONE WORD EACH, AND THE SEPARATION CARRIED BY AN `<optgroup>`.
 *
 * «مسبق — جوي» would not fit a third of a 390px row, and a select clips its
 * own text without saying so. The three transports therefore sit under a
 * group heading — «الطلبات المسبقة», the owner's own words — which shows when
 * the list is open and costs nothing when it is closed. The four words are
 * also exactly the four badges a row carries, so the control and the rows
 * name the same things the same way.
 */
const PREORDER_JOURNEYS: Array<{ id: Journey; ar: string; en: string; ckb: string }> = [
  { id: 'preorder_air', ar: 'جوي', en: 'Air', ckb: 'ئاسمانی' },
  { id: 'preorder_sea', ar: 'بحري', en: 'Sea', ckb: 'دەریایی' },
  { id: 'preorder_land', ar: 'بري', en: 'Land', ckb: 'وشکانی' },
];

/** What a live order can be. `delivered` and `cancelled` are the ARCHIVE —
 *  «الطلبات الملغية والطلبات التي تم توصيلها يتم عزلها» — so they are not
 *  offered here; the switch beside this select reaches them. */
const OPEN_STATUSES: Array<{ id: OrderStatus; ar: string; en: string; ckb: string }> = [
  { id: 'pending', ar: 'قيد الانتظار', en: 'Pending', ckb: 'چاوەڕوان' },
  { id: 'confirmed', ar: 'مؤكد', en: 'Confirmed', ckb: 'پشتڕاستکراو' },
  { id: 'processing', ar: 'قيد التجهيز', en: 'Processing', ckb: 'ئامادەکردن' },
  { id: 'shipped', ar: 'تم الشحن', en: 'Shipped', ckb: 'نێردرا' },
];

type ArchiveScope = 'delivered' | 'cancelled';
const ARCHIVE_SCOPES: Array<{ id: ArchiveScope; ar: string; en: string; ckb: string }> = [
  { id: 'delivered', ar: 'تم التسليم', en: 'Delivered', ckb: 'گەیەنراو' },
  { id: 'cancelled', ar: 'ملغاة', en: 'Cancelled', ckb: 'هەڵوەشاوە' },
];

/**
 * The day headers, in the order the server already returns rows in (day
 * ascending, NULLs last), so grouping never reorders anything.
 *
 * OVERDUE IS NOT A GROUP OF ITS OWN. The server takes the same view for its
 * `due=today` filter: «a box that should have gone out on Tuesday is not a
 * separate kind of work on Wednesday — it is today's work, and it is the most
 * urgent of it». It sorts first inside «اليوم» because its day is earlier, and
 * the row itself is marked «متأخر».
 */
type GroupKey = 'today' | 'tomorrow' | 'week' | 'later' | 'unscheduled';
const GROUPS: Array<{ id: GroupKey; ar: string; en: string; ckb: string }> = [
  { id: 'today', ar: 'اليوم', en: 'Today', ckb: 'ئەمڕۆ' },
  { id: 'tomorrow', ar: 'غدًا', en: 'Tomorrow', ckb: 'بەیانی' },
  { id: 'week', ar: 'هذا الأسبوع', en: 'This week', ckb: 'ئەم هەفتەیە' },
  { id: 'later', ar: 'لاحقًا', en: 'Later', ckb: 'دواتر' },
  { id: 'unscheduled', ar: 'بلا موعد', en: 'No day', ckb: 'بێ ڕۆژ' },
];

const groupOf = (bucket?: OrderDueBucket): GroupKey => {
  // A missing bucket is «بلا موعد», never today: an order with no day named is
  // not work for this morning, and `null` must never COALESCE to a day.
  if (!bucket) return 'unscheduled';
  return bucket === 'overdue' ? 'today' : bucket;
};

const EMPTY_COUNTS: AdminOrdersResponse['counts'] = {
  total: 0, overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, unscheduled: 0,
};

export default function OrdersBoard() {
  const { loc, lang } = useLanguage();
  const latin = lang === 'en';

  const [data, setData] = useState<AdminOrdersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * «مباشر» IS STILL THE DEFAULT, AND «الكل» IS AN OPTION, NOT THE OPENING
   * SCREEN. «فصلها في الطلبات المسبقة» is a decision about what the board
   * shows when nobody has asked for anything: a container forty days out
   * interleaved by day among this morning's boxes is what made the old board
   * useless, and adding an «الكل» option must not quietly restore that as the
   * first thing an owner sees every morning. The number beside «الكل» says
   * how much is behind it, which is what makes one tap enough.
   */
  const [journey, setJourney] = useState<Journey>('direct');
  /** The one-tap move in flight, so the row can spin and nothing double-fires. */
  const [advancing, setAdvancing] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | OrderStatus>('');
  const [archive, setArchive] = useState(false);
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>('delivered');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  // «🔗 فتح في لوحة الإدارة» on the Telegram order message lands here as
  // `/admin?tab=orders&order=<id>` and opens that order straight away — the
  // admin tapped a button about ONE order, not a request to browse the board.
  const [openOrderId, setOpenOrderId] = useState<string | null>(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('order') ?? '';
      return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  });
  // …once. The parameter is taken off the address after it has been read, so
  // coming back to this tab later opens the board, not that order again.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('order')) return;
      url.searchParams.delete('order');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* no history API — the modal still opened */
    }
  }, []);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    /**
     * `lang` IS SENT, AND IT IS NOT DECORATION. Two strings on this payload are
     * rendered by the SERVER — `due_label` («اليوم» / «الأربعاء ٢٣ أيلول») and
     * `quick_next.label` (the stage the button moves to) — and `langOf` reads
     * exactly this parameter, defaulting to Arabic. Without it an English or
     * Sorani admin gets an otherwise-translated board with two Arabic strings
     * in the middle of it, one of them on a button that changes an order.
     */
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), lang });
    if (archive) {
      // In the archive the scope is the STATE, so the journey has to be sent
      // as `type` — it is no longer implied by the scope the way `open` implies
      // direct. «الكل» sends NO `type`, which is the one spelling of "any
      // journey" this half understands; see the header note.
      params.set('scope', archiveScope);
      if (journey !== 'all') params.set('type', journey);
    } else if (journey === 'all') {
      // The live set with no `shipping_type` clause at all — the partial
      // index's own WHERE, and the cheapest of the three live scopes.
      params.set('scope', 'all');
      if (status) params.set('status', status);
    } else if (journey === 'direct') {
      // AND NOT `type=direct` BESIDE IT. `scope=open` already restricts to
      // direct orders through a clause written to match `idx_orders_board_open`
      // character for character; adding an indexable equality on
      // `shipping_type` makes the planner prefer `idx_orders_shipping_type` and
      // abandon that partial index, which widens the scan from "open orders" to
      // "every direct order ever placed" with EXPLAIN still reading healthy
      // (worker/routes/admin.ts, migration 0094).
      params.set('scope', 'open');
      if (status) params.set('status', status);
    } else {
      params.set('scope', 'preorder');
      params.set('type', journey);
      if (status) params.set('status', status);
    }
    if (query) params.set('q', query);
    try {
      setData(await api.get<AdminOrdersResponse>(`/api/admin/orders?${params}`));
    } catch (e) {
      // The STANDALONE `loc`, which LanguageContext documents for exactly this:
      // the context's own is a fresh closure on every provider render, and a
      // fetch callback that depends on it re-fires whenever anything above this
      // panel re-renders.
      setError(e instanceof ApiError ? e.message : locOutside('تعذّر تحميل الطلبات', 'Failed to load orders', 'داواکارییەکان بار نەبوون'));
    } finally {
      setLoading(false);
    }
  }, [archive, archiveScope, journey, status, query, page, lang]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  /**
   * EVERY CONTROL RESETS THE PAGE, and the search box most of all. Narrowing a
   * board from page 4 asks the server for rows 90-120 of a result set that now
   * has eleven rows in it, and an admin who just typed a customer's name lands
   * on an empty screen for a search that matched.
   */
  const commitSearch = useCallback((q: string) => {
    setQuery(q);
    setPage(0);
  }, []);

  const orders = data?.orders ?? [];
  const counts = data?.counts ?? EMPTY_COUNTS;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** The board-wide count behind each header. Overdue folds into today. */
  const groupCount = (id: GroupKey): number =>
    id === 'today' ? counts.today + counts.overdue : counts[id];

  // The rows come back in day order already (day ascending, NULLs last), so
  // bucketing them preserves the server's ordering inside every group —
  // including the PRO pin, which is a tie-break WITHIN a day.
  const groups = useMemo(() => {
    const rows = data?.orders ?? [];
    return GROUPS.map((g) => ({ ...g, rows: rows.filter((o) => groupOf(o.due_bucket) === g.id) })).filter(
      (g) => g.rows.length > 0
    );
  }, [data]);

  /**
   * The PRO segment counts the rows ON THIS PAGE, because the server's counts
   * block carries no PRO column — it counts days. On page one that is the top
   * of the board and matches what the eye sees; as soon as there is a second
   * page it could be read as a board total, so it says which it is.
   */
  const proHere = orders.filter((o) => o.priority === 1).length;

  /**
   * «مباشر ٦» — the option and what tapping it would return.
   *
   * A MISSING NUMBER IS NO NUMBER, not a zero. `options` is null during a
   * pierced lookup, and writing «مباشر ٠» there would be a claim about the
   * board that the server explicitly declined to make.
   */
  const opt = (label: string, n: number | undefined): string =>
    n === undefined ? label : `${label} ${countText(n, latin)}`;
  const typeOpts = data?.options?.type;
  const statusOpts = data?.options?.status;

  /**
   * ONE TAP FORWARD, and the move is the SERVER'S — `order.quick_next.stage`,
   * through the same `PATCH /orders/:id/stage` door the modal's stage panel
   * uses. Not a status PATCH: the stage is the authority for what the customer
   * is told, and the two doors must not be able to say different things about
   * the same order.
   *
   * THE SERVER'S REFUSAL IS SHOWN VERBATIM. A Gini receipt that was never
   * scanned, an offer allowance already spent, a stage somebody else moved
   * while this board was open — each has its own sentence, and «تعذّر» in
   * place of any of them sends an admin hunting the wrong problem.
   */
  const advance = async (order: AdminOrderRow) => {
    const next = order.quick_next;
    if (!next || advancing) return;
    setAdvancing(order.id);
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/api/admin/orders/${order.id}/stage`, { stage: next.stage });
      /* OWNER: Sorani to be written by hand — `loc(ar, en)` falls back to the
         Arabic text for a Kurdish reader rather than inventing Kurdish. */
      setNotice(loc(`تم النقل إلى: ${next.label}`, `Moved to: ${next.label}`));
      await loadOrders();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر تحديث الحالة', 'Failed to update the status') /* OWNER: Sorani by hand. */);
    } finally {
      setAdvancing(null);
    }
  };

  const deleteCancelled = async (order: AdminOrderRow) => {
    if (order.status !== 'cancelled' || deletingId) return;
    const ok = window.confirm(
      loc(
        `حذف الطلب ${order.id} نهائياً من قاعدة البيانات؟ لا يمكن التراجع عن هذا الإجراء.`,
        `Permanently delete order ${order.id} from the database? This cannot be undone.`,
        `داواکاری ${order.id} بۆ هەمیشە لە بنکەدراوە بسڕێتەوە؟ ئەمە ناگەڕێتەوە.`
      )
    );
    if (!ok) return;
    setDeletingId(order.id);
    setNotice(null);
    try {
      await api.delete(`/api/admin/orders/${order.id}`);
      setNotice(loc('حُذف الطلب نهائياً من قاعدة البيانات.', 'Order permanently deleted.', 'داواکاری بۆ هەمیشە سڕایەوە.'));
      await loadOrders();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر حذف الطلب', 'Failed to delete order', 'سڕینەوە سەرکەوتوو نەبوو'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      {/* ------------------------------------------------- 1. THE HEADER LINE */}
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <h2 className="text-lg leading-tight font-black text-text-primary">
            {loc('الطلبات', 'Orders', 'داواکارییەکان')}
          </h2>
          {/* TEXT, NOT CHIPS. Four numbers an owner reads in one glance on a
              busy morning; the only coloured one is the one that means "late". */}
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
                  {pages > 1 && (
                    <span className="ms-1 text-text-muted">
                      {loc('(هذه الصفحة)', '(this page)', '(ئەم پەڕەیە)')}
                    </span>
                  )}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Stickers for the orders not yet dispatched. "New" is decided on
              the SERVER (stage received or confirmed) — printing a sticker for
              a parcel already on a motorbike is how the same order goes out
              twice. */}
          <a
            href="/api/admin/labels?print=1"
            target="_blank"
            rel="noopener noreferrer"
            data-print-new-labels
            className="lv-button lv-button-secondary lv-button-sm press-scale"
            title={loc('طباعة ستيكرات الطلبات الجديدة', 'Print labels for new orders', 'چاپکردنی ستیکەری داواکارییە نوێیەکان')}
          >
            <Tag className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{loc('ستيكرات الجديدة', 'New labels', 'ستیکەرە نوێیەکان')}</span>
          </a>
          <button
            type="button"
            onClick={loadOrders}
            aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}
            title={loc('تحديث', 'Refresh', 'نوێکردنەوە')}
            className="lv-button lv-button-secondary press-scale w-11 px-0"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------- 2. THE ONE BOX */}
      <OrderSearchField
        value={query}
        onCommit={commitSearch}
        kind={data?.search_kind ?? 'none'}
        search={data?.search ?? null}
        lang={lang}
        loc={loc}
      />

      {/* --------------------------------------------- 3. THE THREE CONTROLS */}
      {/* `auto` for the switch and `minmax(0, 1fr)` for the two selects: the
          switch's label is short and fixed, and giving the rest to the selects
          is what keeps «قيد الانتظار» readable in a third of a 390px row. The
          `minmax(0, …)` is what stops a select's intrinsic width from pushing
          the row wider than the screen. */}
      <div data-order-filters className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 min-w-0">
        <select
          data-order-filter="type"
          value={journey}
          onChange={(e) => {
            setJourney(e.target.value as Journey);
            setPage(0);
          }}
          aria-label={loc('نوع الطلب', 'Order type', 'جۆری داواکاری')}
          className="lv-input min-w-0 px-2 text-[14px] leading-[1.4] font-bold"
        >
          <option value="all">{opt(loc('الكل', 'All', 'هەموو'), typeOpts?.all)}</option>
          <option value="direct">{opt(loc('مباشر', 'Direct', 'ڕاستەوخۆ'), typeOpts?.direct)}</option>
          <optgroup label={loc('الطلبات المسبقة', 'Pre-orders', 'داواکارییە پێشوەختەکان')}>
            {PREORDER_JOURNEYS.map((j) => (
              <option key={j.id} value={j.id}>
                {opt(loc(j.ar, j.en, j.ckb), typeOpts?.[j.id])}
              </option>
            ))}
          </optgroup>
        </select>

        <select
          data-order-filter="status"
          value={archive ? archiveScope : status}
          onChange={(e) => {
            if (archive) setArchiveScope(e.target.value as ArchiveScope);
            else setStatus(e.target.value as '' | OrderStatus);
            setPage(0);
          }}
          aria-label={loc('حالة الطلب', 'Order status', 'دۆخی داواکاری')}
          className="lv-input min-w-0 px-2 text-[14px] leading-[1.4] font-bold"
        >
          {/* The archive IS a state, so inside it this select chooses WHICH
              completed state rather than offering live ones that cannot
              co-exist with it. */}
          {archive ? (
            ARCHIVE_SCOPES.map((s) => (
              <option key={s.id} value={s.id}>
                {opt(loc(s.ar, s.en, s.ckb), statusOpts?.[s.id])}
              </option>
            ))
          ) : (
            <>
              <option value="">{opt(loc('كل الحالات', 'Any status', 'هەموو دۆخەکان'), statusOpts?.any)}</option>
              {OPEN_STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {opt(loc(s.ar, s.en, s.ckb), statusOpts?.[s.id])}
                </option>
              ))}
            </>
          )}
        </select>

        {/* «كذلك الطلبات الملغية والطلبات التي تم توصيلها يتم عزلها» — isolated
            behind one switch rather than mixed into the day list. */}
        <button
          type="button"
          data-order-filter="archive"
          aria-pressed={archive}
          onClick={() => {
            setArchive((v) => !v);
            setPage(0);
          }}
          className="lv-choice press-scale flex min-w-0 items-center justify-center gap-1.5 px-2 text-[13px] leading-[1.4] font-bold"
        >
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${archive ? 'rotate-180' : ''}`} aria-hidden />
          <span className="truncate">{loc('المكتملة', 'Completed', 'تەواوبووەکان')}</span>
        </button>
      </div>

      {error && (
        <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-[1.6] text-text-primary">
          {error}
        </p>
      )}
      {notice && (
        <p className="lv-alert lv-alert-warning text-[13px] leading-[1.6] text-text-primary">{notice}</p>
      )}

      {/* ------------------------------------------------- 4. THE DAY LIST.
          A CARD LAYOUT AT EVERY WIDTH, not a table that becomes one. Sticky
          headers inside an `overflow-x-auto` table do not stick — the overflow
          box becomes the scrollport — and that failure appears only at the
          desktop breakpoint, which is the one nobody re-checks after testing
          the phone. */}
      {groups.map((g) => (
        <section key={g.id} data-order-group={g.id} className="min-w-0">
          <h3
            className="sticky top-0 z-10 mb-2 flex items-baseline gap-1.5 rounded-lg bg-canvas px-2 py-2 text-[13px] leading-[1.5] font-black text-text-secondary"
          >
            {loc(g.ar, g.en, g.ckb)}
            <span className="tabular-nums text-text-muted">({countText(groupCount(g.id), latin)})</span>
          </h3>
          <div className="space-y-2">
            {g.rows.map((o) => (
              <OrderBoardRow
                key={o.id}
                order={o}
                loc={loc}
                onOpen={setOpenOrderId}
                onDelete={deleteCancelled}
                onAdvance={advance}
                advancing={advancing === o.id}
                deleting={deletingId === o.id}
                latin={latin}
              />
            ))}
          </div>
        </section>
      ))}

      {orders.length === 0 && (
        <p className="py-12 text-center text-[14px] leading-[1.6] font-medium text-text-muted">
          {loading
            ? loc('جارٍ التحميل...', 'Loading...', 'بار دەبێت...')
            : loc('لا توجد طلبات', 'No orders found', 'هیچ داواکارییەک نییە')}
        </p>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            data-orders-prev
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="lv-button lv-button-secondary lv-button-sm press-scale"
          >
            {loc('السابق', 'Previous', 'پێشوو')}
          </button>
          <span className="text-[12px] leading-[1.5] tabular-nums text-text-muted">
            {countText(page + 1, latin)} / {countText(pages, latin)} · {countText(total, latin)}{' '}
            {loc('طلب', 'orders', 'داواکاری')}
          </span>
          <button
            type="button"
            data-orders-next
            disabled={page + 1 >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
            className="lv-button lv-button-secondary lv-button-sm press-scale"
          >
            {loc('التالي', 'Next', 'دواتر')}
          </button>
        </div>
      )}

      {openOrderId && (
        <OrderDetailModal
          orderId={openOrderId}
          onClose={() => {
            setOpenOrderId(null);
            // A stage or a status may have changed inside the modal, and a
            // stale row is worse than a second of loading.
            loadOrders();
          }}
        />
      )}
    </div>
  );
}
