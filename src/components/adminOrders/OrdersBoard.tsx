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
 *  THE FOUR JOURNEYS ARE THE «النوع» SELECT, AND THERE IS NO "ALL"
 * ---------------------------------------------------------------------------
 * «فصلها في الطلبات المسبقة» — a container forty days out is a different kind
 * of waiting from a box that has to go out this morning, and interleaving them
 * by day is what made the old board useless. On the server that separation is
 * a SCOPE (`open` is direct-only, `preorder` is everything else), so each
 * option here maps to exactly one (scope, type) pair:
 *
 *      مباشر  → scope=open                          جوي  → preorder + air
 *      بحري   → scope=preorder, type=preorder_sea   بري  → preorder + land
 *
 * An aggregate «كل المسبقة» option was deliberately NOT added, even though
 * `scope=preorder` alone would serve it: the archive below reaches delivered
 * and cancelled orders through `scope=delivered` / `scope=cancelled`, where
 * the journey can only be expressed as `type`, and `type` has no value meaning
 * "any pre-order". The aggregate would therefore work in the work list and
 * silently show direct orders in the archive. Four honest options beat five
 * where the fifth lies in one combination.
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

/** The four journeys, as the server's `type` values. See the header note. */
type Journey = 'direct' | 'preorder_air' | 'preorder_sea' | 'preorder_land';

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

  const [journey, setJourney] = useState<Journey>('direct');
  const [status, setStatus] = useState<'' | OrderStatus>('');
  const [archive, setArchive] = useState(false);
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>('delivered');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (archive) {
      // In the archive the scope is the STATE, so the journey has to be sent
      // as `type` — it is no longer implied by the scope the way `open` implies
      // direct.
      params.set('scope', archiveScope);
      params.set('type', journey);
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
  }, [archive, archiveScope, journey, status, query, page]);

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
          <option value="direct">{loc('مباشر', 'Direct', 'ڕاستەوخۆ')}</option>
          <optgroup label={loc('الطلبات المسبقة', 'Pre-orders', 'داواکارییە پێشوەختەکان')}>
            {PREORDER_JOURNEYS.map((j) => (
              <option key={j.id} value={j.id}>
                {loc(j.ar, j.en, j.ckb)}
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
                {loc(s.ar, s.en, s.ckb)}
              </option>
            ))
          ) : (
            <>
              <option value="">{loc('كل الحالات', 'Any status', 'هەموو دۆخەکان')}</option>
              {OPEN_STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {loc(s.ar, s.en, s.ckb)}
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
                deleting={deletingId === o.id}
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
