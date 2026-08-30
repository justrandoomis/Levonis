import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Package, RefreshCw, Info, Truck } from 'lucide-react';
import { api, ApiOrder, formatIqd } from '../lib/api';
import ReturnsSection from '../components/returns/ReturnsSection';
import OrderTracker from '../components/OrderTracker';

/**
 * Orders list with a WORKING status filter. The filter is driven by the
 * ?status= query param so profile deep-links land on the right view:
 *
 *  - pending / shipped / cancelled … single REAL order statuses, passed to
 *    GET /api/orders?status=… (server-side WHERE status = ?).
 *  - to_ship … merges the two real "waiting to ship" statuses
 *    (confirmed + processing) client-side; the server filter is
 *    single-status, so the full list is fetched and filtered here.
 *  - review / returns … both open the DELIVERED orders list, because
 *    reviewing and the 7-day return window (ReturnsSection below each
 *    order) are actions on delivered orders. The returns view says so
 *    explicitly instead of pretending a separate "returns orders" status
 *    exists.
 *
 * Unknown ?status= values fall back to "All" — never an accidental empty
 * list from a bogus server filter.
 */

type Filter = 'All' | 'pending' | 'to_ship' | 'shipped' | 'review' | 'returns' | 'cancelled';

/** Map an incoming ?status= value (including legacy links) to a view. */
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

/** Server query for a view; null = fetch all and filter client-side. */
const SERVER_STATUS: Record<Filter, string | null> = {
  All: '',
  pending: 'pending',
  shipped: 'shipped',
  cancelled: 'cancelled',
  review: 'delivered',
  returns: 'delivered',
  to_ship: null,
};

const STRINGS = {
  ar: {
    track: 'تتبع الشحنة',
    title: 'طلباتي',
    back: 'رجوع',
    filters: {
      All: 'الكل',
      pending: 'انتظار الدفع',
      to_ship: 'انتظار الشحن',
      shipped: 'المشحونة',
      review: 'المراجعة',
      returns: 'الاسترجاع',
      cancelled: 'الملغية',
    } as Record<Filter, string>,
    statuses: {
      pending: 'بانتظار الدفع',
      confirmed: 'بانتظار الشحن',
      processing: 'قيد التجهيز',
      shipped: 'مشحونة',
      delivered: 'تم التوصيل',
      cancelled: 'ملغية',
    } as Record<ApiOrder['status'], string>,
    returnsNote: 'الإرجاع يُطلب من الطلبات المستلمة (خلال 7 أيام من الاستلام). هذه قائمة طلباتك المستلمة — استخدم قسم «الإرجاع والاستبدال» أسفل كل طلب.',
    empty: 'لا توجد طلبات بعد.',
    emptyFiltered: 'لا توجد طلبات بهذه الحالة.',
    loadError: 'تعذر تحميل الطلبات.',
    retry: 'إعادة المحاولة',
    total: 'المجموع',
    cancel: 'إلغاء الطلب',
    cancelling: 'جارٍ الإلغاء...',
    cancelConfirm: (id: string) => `هل أنت متأكد من إلغاء الطلب ${id}؟ سيُعاد أي رصيد أو نقاط مدفوعة.`,
    cancelFailed: 'تعذر إلغاء الطلب',
    filterLabel: 'تصفية الطلبات',
  },
  en: {
    track: 'Track shipment',
    title: 'My Orders',
    back: 'Back',
    filters: {
      All: 'All',
      pending: 'Pending payment',
      to_ship: 'To ship',
      shipped: 'Shipped',
      review: 'To review',
      returns: 'Returns',
      cancelled: 'Cancelled',
    } as Record<Filter, string>,
    statuses: {
      pending: 'Pending payment',
      confirmed: 'To ship',
      processing: 'Processing',
      shipped: 'Shipped',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
    } as Record<ApiOrder['status'], string>,
    returnsNote: 'Returns are requested from DELIVERED orders (within 7 days of receipt). This is your delivered-orders list — use the "Returns & exchange" section under each order.',
    empty: 'No orders yet.',
    emptyFiltered: 'No orders with this status.',
    loadError: 'Could not load orders.',
    retry: 'Retry',
    total: 'Total',
    cancel: 'Cancel',
    cancelling: 'Cancelling...',
    cancelConfirm: (id: string) => `Cancel order ${id}? Any paid balance or points will be refunded.`,
    cancelFailed: 'Failed to cancel order',
    filterLabel: 'Filter orders',
  },
  ckb: {
    track: 'بەدواداچوونی بار',
    title: 'داواکارییەکانم',
    back: 'گەڕانەوە',
    filters: {
      All: 'هەموو',
      pending: 'چاوەڕێی پارەدان',
      to_ship: 'چاوەڕێی ناردن',
      shipped: 'نێردراوەکان',
      review: 'پێداچوونەوە',
      returns: 'گەڕاندنەوە',
      cancelled: 'هەڵوەشێنراوەکان',
    } as Record<Filter, string>,
    statuses: {
      pending: 'چاوەڕێی پارەدان',
      confirmed: 'چاوەڕێی ناردن',
      processing: 'لە جێبەجێکردندایە',
      shipped: 'نێردراوە',
      delivered: 'گەیەنراوە',
      cancelled: 'هەڵوەشێنراوەتەوە',
    } as Record<ApiOrder['status'], string>,
    returnsNote: 'گەڕاندنەوە لە داواکارییە گەیەنراوەکانەوە داوا دەکرێت (لە ماوەی ٧ ڕۆژ لە وەرگرتن). ئەمە لیستی داواکارییە گەیەنراوەکانتە — بەشی «گەڕاندنەوە و گۆڕینەوە» لەژێر هەر داواکارییەک بەکاربهێنە.',
    empty: 'هێشتا هیچ داواکارییەک نییە.',
    emptyFiltered: 'هیچ داواکارییەک بەم دۆخە نییە.',
    loadError: 'داواکارییەکان بار نەبوون.',
    retry: 'هەوڵدانەوە',
    total: 'کۆی گشتی',
    cancel: 'هەڵوەشاندنەوە',
    cancelling: 'هەڵوەشاندنەوە بەردەوامە...',
    cancelConfirm: (id: string) => `دڵنیایت لە هەڵوەشاندنەوەی داواکاری ${id}؟ هەر باڵانس یان خاڵێکی دراو دەگەڕێتەوە.`,
    cancelFailed: 'داواکارییەکە هەڵنەوەشایەوە',
    filterLabel: 'فلتەرکردنی داواکارییەکان',
  },
};

const FILTER_ORDER: Filter[] = ['All', 'pending', 'to_ship', 'shipped', 'review', 'returns', 'cancelled'];

const STATUS_STYLES: Record<ApiOrder['status'], string> = {
  pending: 'bg-amber-500/10 text-amber-400',
  confirmed: 'bg-blue-500/10 text-blue-400',
  processing: 'bg-sky-500/10 text-sky-400',
  shipped: 'bg-indigo-500/10 text-indigo-400',
  delivered: 'bg-emerald-500/10 text-emerald-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function Orders() {
  const navigate = useNavigate();
  const { dir, lang } = useLanguage();
  const location = useLocation();
  const s = STRINGS[lang] ?? STRINGS.ar;

  const filter = useMemo(
    () => parseFilter(new URLSearchParams(location.search).get('status')),
    [location.search]
  );

  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [trackingFor, setTrackingFor] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    try {
      const serverStatus = SERVER_STATUS[filter];
      const query = serverStatus ? `?status=${encodeURIComponent(serverStatus)}` : '';
      const data = await api.get<{ orders: ApiOrder[] }>(`/api/orders${query}`);
      let list = data.orders || [];
      if (filter === 'to_ship') {
        list = list.filter((o) => o.status === 'confirmed' || o.status === 'processing');
      }
      setOrders(list);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [filter, s.loadError]);

  useEffect(() => {
    setLoading(true);
    loadOrders();
  }, [loadOrders]);

  // Real per-status counts for the filter chips (same endpoint the profile
  // page uses) — never invented numbers; chips render without a badge until
  // (or unless) counts load.
  useEffect(() => {
    api
      .get<{ counts: Record<string, number> }>('/api/orders/counts')
      .then((res) => setCounts(res.counts || {}))
      .catch(() => setCounts({}));
  }, []);

  const chipCount = (f: Filter): number | null => {
    switch (f) {
      case 'pending': return counts.pending ?? null;
      case 'to_ship': return (counts.confirmed || 0) + (counts.processing || 0) || null;
      case 'shipped': return counts.shipped ?? null;
      case 'review':
      case 'returns': return counts.delivered ?? null;
      case 'cancelled': return counts.cancelled ?? null;
      default: return null;
    }
  };

  const setFilter = (f: Filter) => {
    navigate(f === 'All' ? '/orders' : `/orders?status=${f}`, { replace: true });
  };

  const goBack = () => {
    // navigate(-1) is a no-op when the page was opened directly (deep link,
    // refresh) — fall back to home instead of a dead button.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  const cancelOrder = async (order: ApiOrder) => {
    const confirmed = window.confirm(s.cancelConfirm(order.id));
    if (!confirmed) return;
    setCancellingId(order.id);
    try {
      await api.post(`/api/orders/${order.id}/cancel`);
      await loadOrders();
    } catch (err) {
      alert(err instanceof Error ? err.message : s.cancelFailed);
    } finally {
      setCancellingId(null);
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60">
        <div className="px-4 py-2 flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            aria-label={s.back}
            className="w-11 h-11 flex items-center justify-center bg-zinc-900 rounded-full hover:bg-zinc-800 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-all"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5" aria-hidden="true" /> : <ArrowLeft className="w-5 h-5" aria-hidden="true" />}
          </button>
          <h1 className="text-white font-bold text-lg">
            {s.title}{filter !== 'All' ? ` — ${s.filters[filter]}` : ''}
          </h1>
        </div>

        {/* Status filter chips — each one changes ?status= and the list
            actually refetches/refilters. Active chip is bold + gold border,
            not color-only. */}
        <div role="group" aria-label={s.filterLabel} className="flex gap-2 px-4 pb-3 overflow-x-auto hide-scrollbar">
          {FILTER_ORDER.map((f) => {
            const active = filter === f;
            const n = chipCount(f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={active}
                className={`shrink-0 min-h-[36px] px-3.5 rounded-full text-xs whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                  active
                    ? 'bg-olive/30 border border-gold text-gold font-bold'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 font-medium hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                {s.filters[f]}
                {n != null && n > 0 && (
                  <span className={`ms-1.5 text-[10px] font-bold ${active ? 'text-gold' : 'text-zinc-500'}`}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-4">
        {/* Honest explanation of the returns view: it IS the delivered list. */}
        {filter === 'returns' && !loading && !error && (
          <div className="flex items-start gap-2 bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-3 mb-4 text-xs text-zinc-400 leading-relaxed">
            <Info className="w-4 h-4 text-gold shrink-0 mt-0.5" aria-hidden="true" />
            <p>{s.returnsNote}</p>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12" role="status" aria-busy="true">
            <div className="w-6 h-6 mx-auto border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : error ? (
          <div className="text-center py-12 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            <p className="text-red-400 mb-3">{error}</p>
            <button
              type="button"
              onClick={() => { setLoading(true); loadOrders(); }}
              className="min-h-[44px] px-6 inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 text-sm font-bold text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              {s.retry}
            </button>
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            {filter === 'All' ? s.empty : s.emptyFiltered}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {orders.map(order => (
              <div key={order.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex flex-col">
                <div className="flex justify-between items-center mb-3 pb-3 border-b border-zinc-800/50">
                  <span className="text-white font-bold">{order.id}</span>
                  <span className="text-xs text-zinc-500">{formatDate(order.created_at)}</span>
                </div>

                <div className="flex flex-col gap-3 mb-4">
                  {order.items.map(item => (
                    <div key={item.id} className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-black rounded-lg flex items-center justify-center border border-zinc-800 overflow-hidden shrink-0">
                        {item.image ? (
                          <img referrerPolicy="no-referrer" src={item.image} alt={item.name} className="w-full h-full object-cover" />
                        ) : (
                          <Package className="w-6 h-6 text-olive" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-300 line-clamp-1">{item.name}</div>
                        <div className="text-xs text-zinc-500">
                          {item.variant ? `${item.variant} · ` : ''}x{item.qty}
                        </div>
                      </div>
                      <div className="text-sm text-zinc-400 shrink-0">{formatIqd(item.line_total_iqd)}</div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-zinc-800/50">
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">{s.total}</div>
                    <div className="text-gold font-bold">{formatIqd(order.total_iqd)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {order.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => cancelOrder(order)}
                        disabled={cancellingId === order.id}
                        className="min-h-[36px] px-3 py-1 rounded text-xs font-bold tracking-wider border border-red-500/30 text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 transition-colors disabled:opacity-50"
                      >
                        {cancellingId === order.id ? s.cancelling : s.cancel}
                      </button>
                    )}
                    <span className={`px-3 py-1 rounded text-xs font-bold tracking-wider ${STATUS_STYLES[order.status] ?? 'bg-zinc-800 text-zinc-300'}`}>
                      {s.statuses[order.status] ?? order.status}
                    </span>
                  </div>
                </div>
                {/* Where the parcel actually is, on the path this order
                    walks — five stages direct, fourteen for a pre-order.
                    Opened on demand: the list is already the slowest query on
                    this screen, and fourteen history rows per order would
                    make every other card slower for one that is expanded. */}
                {trackingFor === order.id ? (
                  <OrderTracker orderId={order.id} lang={lang} />
                ) : (
                  <button
                    type="button"
                    data-track-order={order.id}
                    onClick={() => setTrackingFor(order.id)}
                    className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-bold text-zinc-300 hover:text-white border border-zinc-700 rounded-lg px-3 py-2 hover:bg-zinc-800 transition-colors"
                  >
                    <Truck className="w-3.5 h-3.5" aria-hidden />
                    {s.track}
                  </button>
                )}
                <ReturnsSection order={order} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
