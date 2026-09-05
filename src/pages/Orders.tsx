import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Info, Search, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api } from '../lib/api';
import type { ApiOrder } from '../lib/api';
import { TabStrip } from '../components/ui/Tabs';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import Spinner from '../components/ui/Spinner';
import OrderCard from '../components/orders/OrderCard';
import OrderCardSkeleton from '../components/orders/OrderCardSkeleton';
import CancelOrderSheet from '../components/orders/CancelOrderSheet';
import ReviewSheet from '../components/orders/ReviewSheet';
import GiftsEntry from '../components/orders/GiftsEntry';
import { asLang } from '../components/orders/format';

/**
 * The customer's orders, one page at a time.
 *
 * The status filter is the ?status= query param so profile deep-links land on
 * the right view:
 *
 *  - pending / shipped / cancelled … single REAL order statuses.
 *  - to_ship … the two "waiting to ship" statuses (confirmed + processing),
 *    sent to the server as a comma list — the server filters, so a page is a
 *    page and never an empty remainder after client-side filtering.
 *  - review / returns … both open the DELIVERED list, because reviewing and
 *    the 7-day return window are actions on delivered orders. The returns
 *    view says so instead of pretending a "returns" status exists.
 *
 * Unknown ?status= values fall back to "All" — never an accidental empty
 * list from a bogus server filter.
 *
 * The list is cursor-paginated (limit + before). Search is client-side over
 * what is loaded and says so when more pages exist.
 */

type Filter = 'All' | 'pending' | 'to_ship' | 'shipped' | 'review' | 'returns' | 'cancelled';

function parseFilter(raw: string | null): Filter {
  switch (raw) {
    case 'pending':
    case 'shipped':
    case 'cancelled':
    case 'to_ship':
    case 'review':
    case 'returns':
      return raw;
    // Legacy deep-links used raw DB statuses for compound views:
    case 'confirmed':
    case 'processing':
      return 'to_ship';
    case 'delivered':
      return 'review';
    default:
      return 'All';
  }
}

/** Server query for a view — every view is server-filtered now. */
const SERVER_STATUS: Record<Filter, string> = {
  All: '',
  pending: 'pending',
  to_ship: 'confirmed,processing',
  shipped: 'shipped',
  review: 'delivered',
  returns: 'delivered',
  cancelled: 'cancelled',
};

const FILTER_ORDER: Filter[] = ['All', 'pending', 'to_ship', 'shipped', 'review', 'returns', 'cancelled'];
const PAGE_SIZE = 20;
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

const STRINGS = {
  ar: {
    title: 'طلباتي',
    back: 'رجوع',
    filters: {
      All: 'الكل',
      pending: 'انتظار الدفع',
      to_ship: 'انتظار الشحن',
      shipped: 'المشحونة',
      review: 'المستلمة',
      returns: 'الاسترجاع',
      cancelled: 'الملغية',
    } as Record<Filter, string>,
    returnsNote: 'الإرجاع يُطلب من الطلبات المستلمة (خلال 7 أيام من الاستلام). افتح تفاصيل الطلب ← «الدفع والنقاط» ← «الإرجاع والاستبدال».',
    empty: 'لا توجد طلبات بعد.',
    emptyFiltered: 'لا توجد طلبات بهذه الحالة.',
    filterLabel: 'تصفية الطلبات',
    search: 'بحث في الطلبات',
    searchPlaceholder: 'ابحث برقم الطلب أو اسم المنتج',
    clearSearch: 'مسح البحث',
    noMatches: 'لا نتائج مطابقة',
    searchHint: 'يبحث ضمن الطلبات المحمّلة فقط — حمّل المزيد لتوسيع البحث.',
    loadMore: 'تحميل المزيد',
    loadingMore: 'جارٍ التحميل…',
    loadMoreFailed: 'تعذر تحميل المزيد.',
    cancelledNotice: (id: string) => `أُلغي الطلب ${id}.`,
    reviewThanks: 'شكرًا — مراجعتك بانتظار الاعتماد.',
  },
  en: {
    title: 'My Orders',
    back: 'Back',
    filters: {
      All: 'All',
      pending: 'Pending payment',
      to_ship: 'To ship',
      shipped: 'Shipped',
      review: 'Delivered',
      returns: 'Returns',
      cancelled: 'Cancelled',
    } as Record<Filter, string>,
    returnsNote: 'Returns are requested from DELIVERED orders (within 7 days of receipt). Open an order → "Payment & points" → "Returns & Replacement".',
    empty: 'No orders yet.',
    emptyFiltered: 'No orders with this status.',
    filterLabel: 'Filter orders',
    search: 'Search orders',
    searchPlaceholder: 'Search by order number or product',
    clearSearch: 'Clear search',
    noMatches: 'No matching orders',
    searchHint: 'Searching loaded orders only — load more to widen the search.',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    loadMoreFailed: 'Could not load more.',
    cancelledNotice: (id: string) => `Order ${id} was cancelled.`,
    reviewThanks: 'Thank you — your review is awaiting approval.',
  },
  ckb: {
    title: 'داواکارییەکانم',
    back: 'گەڕانەوە',
    filters: {
      All: 'هەموو',
      pending: 'چاوەڕێی پارەدان',
      to_ship: 'چاوەڕێی ناردن',
      shipped: 'نێردراوەکان',
      review: 'گەیەنراوەکان',
      returns: 'گەڕاندنەوە',
      cancelled: 'هەڵوەشێنراوەکان',
    } as Record<Filter, string>,
    returnsNote: 'گەڕاندنەوە لە داواکارییە گەیەنراوەکانەوە داوا دەکرێت (لە ماوەی ٧ ڕۆژ لە وەرگرتن). داواکارییەک بکەرەوە ← «پارەدان و خاڵ» ← «گەڕاندنەوە و گۆڕینەوە».',
    empty: 'هێشتا هیچ داواکارییەک نییە.',
    emptyFiltered: 'هیچ داواکارییەک بەم دۆخە نییە.',
    filterLabel: 'فلتەرکردنی داواکارییەکان',
    search: 'گەڕان لە داواکارییەکان',
    searchPlaceholder: 'بە ژمارەی داواکاری یان ناوی کاڵا بگەڕێ',
    clearSearch: 'سڕینەوەی گەڕان',
    noMatches: 'هیچ داواکارییەکی هاوتا نییە',
    searchHint: 'تەنها لە داواکارییە بارکراوەکان دەگەڕێت — زیاتر بار بکە بۆ فراوانکردنی گەڕان.',
    loadMore: 'زیاتر بار بکە',
    loadingMore: 'بارکردن…',
    loadMoreFailed: 'زیاتر بار نەکرا.',
    cancelledNotice: (id: string) => `داواکاری ${id} هەڵوەشێنرایەوە.`,
    reviewThanks: 'سوپاس — پێداچوونەوەکەت چاوەڕێی پەسەندکردنە.',
  },
};

function listUrl(filter: Filter, before?: string | null): string {
  const p = new URLSearchParams();
  const st = SERVER_STATUS[filter];
  if (st) p.set('status', st);
  p.set('limit', String(PAGE_SIZE));
  if (before) p.set('before', before);
  return `/api/orders?${p.toString()}`;
}

export default function Orders() {
  const navigate = useNavigate();
  const { dir, lang } = useLanguage();
  const location = useLocation();
  const s = STRINGS[asLang(lang)];

  const filter = useMemo(() => parseFilter(new URLSearchParams(location.search).get('status')), [location.search]);

  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [reviewed, setReviewed] = useState<ReadonlySet<string> | null>(null);
  const [trackingFor, setTrackingFor] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<ApiOrder | null>(null);
  const [reviewFor, setReviewFor] = useState<ApiOrder | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  // A filter changed mid-flight must not let the older response land last.
  const requestSeq = useRef(0);

  const loadFirst = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setMoreError('');
    try {
      const data = await api.get<{ orders: ApiOrder[]; next_before?: string | null }>(listUrl(filter));
      if (seq !== requestSeq.current) return;
      setOrders(data.orders || []);
      setNextBefore(data.next_before ?? null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filter]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setMoreError('');
    try {
      const data = await api.get<{ orders: ApiOrder[]; next_before?: string | null }>(listUrl(filter, nextBefore));
      if (seq !== requestSeq.current) return;
      setOrders((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...(data.orders || []).filter((o) => !seen.has(o.id))];
      });
      setNextBefore(data.next_before ?? null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setMoreError(e instanceof Error && e.message ? e.message : s.loadMoreFailed);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadCounts = useCallback(() => {
    // Real per-status counts for the tabs — never invented numbers; a tab
    // renders without a badge until (or unless) counts load.
    api
      .get<{ counts: Record<string, number> }>('/api/orders/counts')
      .then((res) => setCounts(res.counts || {}))
      .catch(() => setCounts({}));
  }, []);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  // Which products this customer already reviewed, so a delivered order
  // whose every item is reviewed does not keep offering the verb. Unknown
  // (request failed) means the verb is offered and the sheet asks the server.
  useEffect(() => {
    let alive = true;
    api
      .get<{ reviews: Array<{ product_id: string | null }> }>('/api/reviews/mine')
      .then((r) => {
        if (!alive) return;
        setReviewed(new Set((r.reviews || []).map((x) => x.product_id).filter((x): x is string => !!x)));
      })
      .catch(() => alive && setReviewed(null));
    return () => {
      alive = false;
    };
  }, []);

  const chipCount = (f: Filter): number | null => {
    switch (f) {
      case 'pending':
        return counts.pending ?? null;
      case 'to_ship':
        return (counts.confirmed || 0) + (counts.processing || 0) || null;
      case 'shipped':
        return counts.shipped ?? null;
      case 'review':
      case 'returns':
        return counts.delivered ?? null;
      case 'cancelled':
        return counts.cancelled ?? null;
      default:
        return null;
    }
  };

  const setFilter = (f: Filter) => {
    setTrackingFor(null);
    navigate(f === 'All' ? '/orders' : `/orders?status=${f}`, { replace: true });
  };

  const goBack = () => {
    // navigate(-1) is a no-op when the page was opened directly (deep link,
    // refresh) — fall back to home instead of a dead button.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) => o.id.toLowerCase().includes(q) || o.items.some((it) => (it.name || '').toLowerCase().includes(q))
    );
  }, [orders, search]);

  const onCancelled = (order: ApiOrder) => {
    setCancelFor(null);
    setNotice(s.cancelledNotice(order.id));
    setOrders((prev) =>
      filter === 'pending' ? prev.filter((o) => o.id !== order.id) : prev.map((o) => (o.id === order.id ? { ...o, ...order } : o))
    );
    loadCounts();
  };

  const onReviewSubmitted = (productId: string) => {
    setReviewed((prev) => new Set([...(prev ?? []), productId]));
    setNotice(s.reviewThanks);
  };

  const tabs = FILTER_ORDER.map((f) => {
    const n = chipCount(f);
    return {
      id: f,
      label: s.filters[f],
      badge:
        n != null && n > 0 ? (
          <span className="text-[10px] font-bold tabular-nums text-zinc-500" data-count={n}>
            {n}
          </span>
        ) : undefined,
    };
  });

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60">
        <div className="px-4 py-2 flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            aria-label={s.back}
            className="w-11 h-11 shrink-0 flex items-center justify-center bg-zinc-900 rounded-full hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-colors"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5" aria-hidden="true" /> : <ArrowLeft className="w-5 h-5" aria-hidden="true" />}
          </button>
          <h1 className="text-white font-bold text-lg min-w-0 truncate flex-1">{s.title}</h1>
        </div>

        <div className="px-4 pb-2">
          <label className="relative block">
            <span className="sr-only">{s.search}</span>
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={s.searchPlaceholder}
              autoComplete="off"
              data-orders-search
              className="w-full min-h-[40px] bg-zinc-900 border border-zinc-800 rounded-xl ps-9 pe-10 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#BAA369]/60 focus-visible:ring-2 focus-visible:ring-[#BAA369]"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label={s.clearSearch}
                className="absolute end-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-lg text-zinc-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </label>
        </div>

        {/* Status tabs — the indicator travels; the URL carries the choice. */}
        <div className="overflow-x-auto hide-scrollbar px-2">
          <TabStrip
            items={tabs}
            value={filter}
            onChange={(id) => setFilter(id as Filter)}
            group="orders-status"
            fill={false}
            indicatorClassName="bg-[#BAA369]"
            activeClassName="text-[#BAA369] font-bold"
            idleClassName="text-zinc-400 hover:text-zinc-200"
            label={s.filterLabel}
            className="min-w-max"
          />
        </div>
      </div>

      <div className="p-4 max-w-2xl mx-auto">
        <p
          role="status"
          aria-live="polite"
          className={notice ? 'mb-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-200' : 'sr-only'}
        >
          {notice}
        </p>

        {/* Honest explanation of the returns view: it IS the delivered list. */}
        {filter === 'returns' && !loading && !error && (
          <div className="flex items-start gap-2 bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3 mb-4 text-xs text-zinc-400 leading-relaxed">
            <Info className="w-4 h-4 text-[#BAA369] shrink-0 mt-0.5" aria-hidden="true" />
            <p>{s.returnsNote}</p>
          </div>
        )}

        {loading ? (
          <OrderCardSkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={loadFirst} />
        ) : orders.length === 0 ? (
          <EmptyState title={filter === 'All' ? s.empty : s.emptyFiltered} />
        ) : visible.length === 0 ? (
          <EmptyState title={s.noMatches} description={nextBefore ? s.searchHint : undefined} compact />
        ) : (
          <div className="flex flex-col gap-4" data-orders-list>
            {visible.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                reviewedProductIds={reviewed}
                trackingOpen={trackingFor === order.id}
                onToggleTracking={() => setTrackingFor((cur) => (cur === order.id ? null : order.id))}
                onCancel={(o) => setCancelFor(o)}
                onReview={(o) => setReviewFor(o)}
              />
            ))}
            {search && nextBefore && <p className="text-[11.5px] text-zinc-500 text-center">{s.searchHint}</p>}
            {nextBefore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                data-load-more
                className="min-h-[44px] rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-200 text-[13px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                {loadingMore && <Spinner size="sm" delayMs={0} decorative />}
                {loadingMore ? s.loadingMore : s.loadMore}
              </button>
            )}
            {moreError && (
              <p role="alert" className="text-red-400 text-[12.5px] text-center">
                {moreError}
              </p>
            )}
          </div>
        )}

        <GiftsEntry className="mt-6" />
      </div>

      <CancelOrderSheet
        open={cancelFor !== null}
        orderId={cancelFor?.id ?? null}
        onClose={() => setCancelFor(null)}
        onCancelled={onCancelled}
      />
      <ReviewSheet
        open={reviewFor !== null}
        onClose={() => setReviewFor(null)}
        orderId={reviewFor?.id ?? ''}
        items={reviewFor?.items ?? []}
        reviewedProductIds={reviewed ?? EMPTY_SET}
        onSubmitted={onReviewSubmitted}
      />
    </div>
  );
}
