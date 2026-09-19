import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, FileText, Star, CheckCircle2, ShieldCheck, ExternalLink, ChevronRight, Truck } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';
import { api, formatIqd } from '../lib/api';
import Note from '../components/ui/Note';
import BundleContents from '../components/bundles/BundleContents';
import MysteryReveal from '../components/offers/MysteryReveal';
import type { ApiOrder, OrderTrackingPublic, OrderUnitPublic } from '../lib/api';
import { TabStrip, TabPanels } from '../components/ui/Tabs';
import { classifyError, ErrorState, NotFoundState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import SafeImage from '../components/ui/SafeImage';
import CopyField from '../components/adminOrders/CopyField';
import OrderTracker from '../components/OrderTracker';
import ReturnsSection from '../components/returns/ReturnsSection';
import StatusHairline from '../components/orders/StatusHairline';
import PaymentBreakdown from '../components/orders/PaymentBreakdown';
import OrderUnits from '../components/orders/OrderUnits';
import ReorderButton from '../components/orders/ReorderButton';
import PriceProtection from '../components/orders/PriceProtection';
import SupportActions from '../components/orders/SupportActions';
import CancelOrderSheet from '../components/orders/CancelOrderSheet';
import ReviewSheet from '../components/orders/ReviewSheet';
import DeliveryDayPicker from '../components/orders/DeliveryDayPicker';
import { apiRefusal } from '../lib/refusalStrings';
import { asLang, countItems, formatDate, itemCountLabel, monthsLabel, statusLabel, statusStyle } from '../components/orders/format';

/**
 * ONE order, everything the customer can know or do about it.
 *
 * Three requests run together: the order (§5 money view included), its
 * tracking path (labels resolved server-side) and its serialized units. The
 * order decides the page — 404 is "not found", 401 is "sign in" — while the
 * other two fail on their own without taking the page with them.
 *
 * The tab lives in the URL (?tab=) so a link into "Payment & points" lands
 * there, and Back returns to the list, not to the previous tab.
 */

type Tab = 'tracking' | 'items' | 'payment' | 'support';
const TABS: Tab[] = ['tracking', 'items', 'payment', 'support'];
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function parseTab(raw: string | null): Tab {
  return raw === 'items' || raw === 'payment' || raw === 'support' ? raw : 'tracking';
}

const STRINGS = {
  ar: {
    title: 'تفاصيل الطلب',
    back: 'رجوع إلى الطلبات',
    orderNo: 'رقم الطلب',
    placed: 'تاريخ الطلب',
    total: 'المجموع',
    priority12h: 'طلب PRO مؤهل للتجهيز والتوصيل خلال 12 ساعة',
    priority: 'طلب PRO بأولوية التجهيز والتوصيل',
    tabsLabel: 'أقسام الطلب',
    tabs: { tracking: 'التتبع', items: 'المنتجات', payment: 'الدفع والنقاط', support: 'الدعم' } as Record<Tab, string>,
    trackingNo: 'رقم التتبع',
    unitsFailed: 'تعذر تحميل الأجهزة والضمان لهذا الطلب.',
    rate: 'قيّم هذا المنتج',
    reviewed: 'تم التقييم',
    warrantyCentre: 'مركز الضمان',
    invoice: 'عرض / طباعة الفاتورة',
    financialUnavailable: 'ملخص الدفع غير متاح لهذا الطلب.',
    transport: { air: 'شحن جوي', sea: 'شحن بحري', land: 'شحن بري' } as Record<string, string>,
    warrantyMonths: (n: number) => `ضمان ${n} شهرًا`,
    // The extension frozen at checkout: "+12 months (24 in total)" — the
    // total is the snapshot's, never re-added here.
    warrantyExtended: (ext: string, total: string | null) =>
      total ? `ضمان ممدد +${ext} (الإجمالي ${total})` : `ضمان ممدد +${ext}`,
    codDirectPricing: 'سُعِّر كبيع مباشر (الدفع عند الاستلام)',
    printerNote: (v: string) => `عند طلب توصيل الطابعة إلى المنزل يُدفع ${v} عند الاستلام.`,
    cancelledNotice: 'أُلغي الطلب.',
    reviewThanks: 'شكرًا — مراجعتك بانتظار الاعتماد.',
    linkedNotice: 'تم ربط الجهاز بحسابك.',
    dayChanged: 'تم تغيير يوم التوصيل.',
    dayFailed: 'تعذّر تغيير يوم التوصيل.',
    notFoundBack: 'رجوع إلى الطلبات',
  },
  en: {
    title: 'Order details',
    back: 'Back to orders',
    orderNo: 'Order number',
    placed: 'Placed',
    total: 'Total',
    priority12h: 'PRO order eligible for preparation and delivery within 12 hours',
    priority: 'PRO order with preparation and delivery priority',
    tabsLabel: 'Order sections',
    tabs: { tracking: 'Tracking', items: 'Items', payment: 'Payment & points', support: 'Support' } as Record<Tab, string>,
    trackingNo: 'Tracking number',
    unitsFailed: 'The devices and warranty for this order could not be loaded.',
    rate: 'Rate this product',
    reviewed: 'Reviewed',
    warrantyCentre: 'Warranty centre',
    invoice: 'View / print invoice',
    financialUnavailable: 'The payment summary is not available for this order.',
    transport: { air: 'Air freight', sea: 'Sea freight', land: 'Land freight' } as Record<string, string>,
    warrantyMonths: (n: number) => `${n}-month warranty`,
    warrantyExtended: (ext: string, total: string | null) =>
      total ? `Extended warranty +${ext} (${total} in total)` : `Extended warranty +${ext}`,
    codDirectPricing: 'Priced as a direct sale (cash on delivery)',
    printerNote: (v: string) => `When home delivery is requested for a printer, ${v} is paid on delivery.`,
    cancelledNotice: 'The order was cancelled.',
    reviewThanks: 'Thank you — your review is awaiting approval.',
    linkedNotice: 'The device is now linked to your account.',
    dayChanged: 'The delivery day was changed.',
    dayFailed: 'The delivery day could not be changed.',
    notFoundBack: 'Back to orders',
  },
  ckb: {
    title: 'وردەکاری داواکاری',
    back: 'گەڕانەوە بۆ داواکارییەکان',
    orderNo: 'ژمارەی داواکاری',
    placed: 'بەرواری داواکاری',
    total: 'کۆی گشتی',
    priority12h: 'داواکاری PRO ی گونجاو بۆ ئامادەکردن و گەیاندن لە ١٢ کاتژمێردا',
    priority: 'داواکاری PRO بە پێشینەیی ئامادەکردن و گەیاندن',
    tabsLabel: 'بەشەکانی داواکاری',
    tabs: { tracking: 'بەدواداچوون', items: 'کاڵاکان', payment: 'پارەدان و خاڵ', support: 'پشتگیری' } as Record<Tab, string>,
    trackingNo: 'ژمارەی بەدواداچوون',
    unitsFailed: 'ئامێرەکان و گەرەنتی ئەم داواکارییە بار نەکران.',
    rate: 'ئەم کاڵایە هەڵبسەنگێنە',
    reviewed: 'هەڵسەنگێنراوە',
    warrantyCentre: 'ناوەندی گەرەنتی',
    invoice: 'بینین / چاپکردنی پسوڵە',
    financialUnavailable: 'کورتەی پارەدان بۆ ئەم داواکارییە بەردەست نییە.',
    transport: { air: 'گواستنەوەی ئاسمانی', sea: 'گواستنەوەی دەریایی', land: 'گواستنەوەی وشکانی' } as Record<string, string>,
    warrantyMonths: (n: number) => `گەرەنتی ${n} مانگ`,
    warrantyExtended: (ext: string, total: string | null) =>
      total ? `گەرەنتی درێژکراوە +${ext} (کۆی گشتی ${total})` : `گەرەنتی درێژکراوە +${ext}`,
    codDirectPricing: 'وەک فرۆشتنی ڕاستەوخۆ نرخ کراوە (پارەدان لە کاتی گەیاندن)',
    printerNote: (v: string) => `کاتێک گەیاندنی پرینتەر بۆ ماڵەوە داوا دەکرێت، ${v} لە کاتی گەیاندن دەدرێت.`,
    cancelledNotice: 'داواکارییەکە هەڵوەشێنرایەوە.',
    reviewThanks: 'سوپاس — پێداچوونەوەکەت چاوەڕێی پەسەندکردنە.',
    linkedNotice: 'ئامێرەکە بە هەژمارەکەت بەسترا.',
    dayChanged: 'ڕۆژی گەیاندن گۆڕدرا.',
    dayFailed: 'ڕۆژی گەیاندن نەگۆڕدرا.',
    notFoundBack: 'گەڕانەوە بۆ داواکارییەکان',
  },
};

function DetailSkeleton() {
  return (
    <SkeletonGroup className="flex flex-col gap-4">
      <div aria-hidden="true" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-14 w-full rounded-xl mt-3" />
        <div className="flex items-end justify-between mt-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
      <div aria-hidden="true" className="flex gap-2 border-b border-zinc-800 pb-2">
        <Skeleton className="h-6 flex-1" />
        <Skeleton className="h-6 flex-1" />
        <Skeleton className="h-6 flex-1" />
        <Skeleton className="h-6 flex-1" />
      </div>
      <div aria-hidden="true" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-44" />
      </div>
    </SkeletonGroup>
  );
}

const TILE =
  'flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 min-h-[52px] hover:bg-zinc-800/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]';

export default function OrderDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { lang, dir } = useLanguage();
  const s = STRINGS[asLang(lang)];
  // The printer home-delivery note amount, the owner's setting. null = no
  // note; the figure is never invented and never enters a total.
  const { settings } = useWallet();
  const printerNoteIqd = (() => {
    const n = settings?.printerHomeDeliveryNoteIqd;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  })();

  const tab = useMemo(() => parseTab(new URLSearchParams(location.search).get('tab')), [location.search]);
  const setTab = (t: Tab) =>
    navigate(`/orders/${encodeURIComponent(id)}${t === 'tracking' ? '' : `?tab=${t}`}`, { replace: true });

  const [order, setOrder] = useState<ApiOrder | null>(null);
  const [orderError, setOrderError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tracking, setTracking] = useState<OrderTrackingPublic | null>(null);
  const [units, setUnits] = useState<OrderUnitPublic[] | null>(null);
  const [unitsFailed, setUnitsFailed] = useState(false);
  const [reviewed, setReviewed] = useState<ReadonlySet<string> | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewItem, setReviewItem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  /**
   * THE DAY THE CUSTOMER JUST TAPPED, ahead of the server confirming it.
   *
   * `undefined` means "follow the order", which is the resting state; a string
   * or `null` is a pick in flight. Apple's first rule of a fluid interface is
   * response — a chip that stays unpressed until a round trip completes reads
   * as a dead control, and the customer taps it again. On a refusal this goes
   * straight back to `undefined`, because the server's answer is the only one.
   */
  const [dayPick, setDayPick] = useState<string | null | undefined>(undefined);
  const [daySaving, setDaySaving] = useState(false);
  const [dayError, setDayError] = useState('');

  /**
   * `quiet` RELOADS WITHOUT REPLACING THE SCREEN WITH A SKELETON. A day change
   * is a one-field edit on a page the customer is looking at; swapping the
   * whole detail for the loading skeleton after a chip tap loses their scroll
   * position and reads as a navigation. The noisy form stays the default —
   * cancelling an order really does change the whole page.
   */
  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    setOrderError(null);
    const [o, t, u] = await Promise.allSettled([
      api.get<{ order: ApiOrder }>(`/api/orders/${encodeURIComponent(id)}`),
      api.get<OrderTrackingPublic>(`/api/orders/${encodeURIComponent(id)}/tracking?lang=${encodeURIComponent(lang)}`),
      api.get<{ units: OrderUnitPublic[] }>(`/api/orders/${encodeURIComponent(id)}/units`),
    ]);
    if (o.status === 'fulfilled') setOrder(o.value.order);
    else {
      setOrder(null);
      setOrderError(o.reason);
    }
    // The tracker fetches for itself when this failed — its own retry path.
    setTracking(t.status === 'fulfilled' ? t.value : null);
    if (u.status === 'fulfilled') {
      setUnits(u.value.units || []);
      setUnitsFailed(false);
    } else {
      setUnits(null);
      setUnitsFailed(true);
    }
    setLoading(false);
  }, [id, lang]);

  useEffect(() => {
    load();
  }, [load]);

  const delivered = order?.status === 'delivered';
  useEffect(() => {
    if (!delivered) return;
    let alive = true;
    api
      .get<{ reviews: Array<{ product_id: string | null }> }>('/api/reviews/mine')
      .then((r) => alive && setReviewed(new Set((r.reviews || []).map((x) => x.product_id).filter((x): x is string => !!x))))
      .catch(() => alive && setReviewed(null));
    return () => {
      alive = false;
    };
  }, [delivered]);

  const unitsByItem = useMemo(() => {
    const m = new Map<string, OrderUnitPublic[]>();
    for (const u of units ?? []) {
      const list = m.get(u.order_item_id);
      if (list) list.push(u);
      else m.set(u.order_item_id, [u]);
    }
    return m;
  }, [units]);

  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/orders');
  };

  const markLinked = (unitId: string) => {
    setUnits((prev) => prev?.map((u) => (u.unit_id === unitId ? { ...u, linked: 'mine' as const } : u)) ?? prev);
    setNotice(s.linkedNotice);
  };

  const onCancelled = () => {
    setCancelOpen(false);
    setNotice(s.cancelledNotice);
    load();
  };

  const onReviewSubmitted = (productId: string) => {
    setReviewed((prev) => new Set([...(prev ?? []), productId]));
    setNotice(s.reviewThanks);
  };

  /**
   * «يستطيع اختيار وتغيير يوم التوصيل في أي وقت يريد» — one PATCH, then the
   * order is re-read rather than patched in place.
   *
   * RE-READING IS THE POINT. The day is not the only thing that moves with it:
   * `delivery_day_changed_at` and the counter move too, and the route can
   * refuse with `DELIVERY_DAY_RACED` when the admin created the courier
   * shipment in the same second this screen was deciding. A screen that
   * believed its own optimistic value would keep showing a day the row does
   * not hold.
   */
  const onPickDay = async (day: string | null) => {
    if (daySaving) return;
    setDayPick(day);
    setDaySaving(true);
    setDayError('');
    try {
      await api.patch(`/api/orders/${encodeURIComponent(id)}/delivery-date`, { date: day });
      setNotice(s.dayChanged);
      await load({ quiet: true });
      setDayPick(undefined);
    } catch (err) {
      setDayPick(undefined);
      setDayError(apiRefusal(err, asLang(lang), s.dayFailed));
    } finally {
      setDaySaving(false);
    }
  };

  // The pill names the CURRENT stage in the server's words when the tracker
  // loaded; the six-value legacy label is the fallback, never a guess.
  const pillLabel = tracking?.steps.find((st) => st.current)?.label ?? (order ? statusLabel(lang, order.status) : '');
  const notFound = orderError !== null && classifyError(orderError) === 'not-found';

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
          <div className="min-w-0 flex-1">
            <h1 className="text-white font-bold text-lg truncate">{s.title}</h1>
            <p dir="ltr" className="text-[11.5px] text-zinc-500 truncate text-start">
              {id}
            </p>
          </div>
        </div>
      </div>

      <div className="p-4 max-w-2xl mx-auto flex flex-col gap-4">
        <p
          role="status"
          aria-live="polite"
          className={notice ? 'rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-200' : 'sr-only'}
        >
          {notice}
        </p>

        {loading ? (
          <DetailSkeleton />
        ) : notFound ? (
          <NotFoundState onBack={() => navigate('/orders')} />
        ) : orderError !== null ? (
          <ErrorState error={orderError} onRetry={load} />
        ) : order ? (
          <>
            {/* Summary */}
            <section
              data-order-summary={order.id}
              className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4"
            >
              <StatusHairline progress={order.progress} cancelled={order.status === 'cancelled'} />
              <div className="flex items-center justify-between gap-3">
                <span
                  data-order-pill
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusStyle(order.status)}`}
                >
                  {pillLabel}
                </span>
                <p className="text-[12px] text-zinc-500 truncate">
                  {s.placed}: <time dateTime={order.created_at}>{formatDate(order.created_at, lang)}</time>
                </p>
              </div>
              <div className="mt-3">
                <CopyField label={s.orderNo} value={order.id} mono />
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] text-zinc-500">{s.total}</p>
                  <p className="text-[#BAA369] font-bold text-[17px] tabular-nums">{formatIqd(order.total_iqd)}</p>
                </div>
                <p className="text-[12px] text-zinc-500 text-end">
                  {itemCountLabel(countItems(order.items, order.item_count), lang)}
                  {tracking?.shipping_type_label && <span className="block text-zinc-600">{tracking.shipping_type_label}</span>}
                </p>
              </div>
              {order.priority === 1 && (
                <div data-pro-priority className="mt-3 flex items-start gap-2 rounded-xl border border-[#B03142]/35 bg-[#B03142]/10 px-3 py-2 text-[12px] font-bold text-[#f3bdc5]">
                  <Truck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {order.fulfillment_service === 'pro_priority_12h' ? s.priority12h : s.priority}
                    {order.priority_due_at && <time dateTime={order.priority_due_at} className="mt-0.5 block font-normal text-[#f3bdc5]/75">{new Date(order.priority_due_at).toLocaleString()}</time>}
                  </span>
                </div>
              )}
            </section>

            <TabStrip
              items={TABS.map((t) => ({ id: t, label: s.tabs[t] }))}
              value={tab}
              onChange={(t) => setTab(t as Tab)}
              group="order-detail"
              indicatorClassName="bg-[#BAA369]"
              activeClassName="text-[#BAA369] font-bold"
              idleClassName="text-zinc-400 hover:text-zinc-200"
              label={s.tabsLabel}
              className="border-b border-zinc-800"
            />

            <TabPanels value={tab} order={TABS}>
              {tab === 'tracking' && (
                <div className="flex flex-col gap-3">
                  <OrderTracker orderId={order.id} lang={lang} tracking={tracking} showTrackingNo={false} />
                  {/*
                    THE DAY SITS IN THE TRACKING TAB, directly under the
                    tracker. This is the tab the customer already opened to ask
                    "when", so the answer and the one control that changes it
                    belong in the same column of the same screen. The summary
                    card above the tabs is money, the order number and the PRO
                    strip — a day chooser there would compete with the total for
                    the first thing the eye lands on.
                  */}
                  {order.delivery_date && (
                    <DeliveryDayPicker
                      days={order.delivery_date.days}
                      selected={dayPick === undefined ? order.delivery_date.selected : dayPick}
                      canChange={order.delivery_date.can_change}
                      reason={order.delivery_date.reason}
                      onPick={onPickDay}
                    />
                  )}
                  {dayError && (
                    <p role="alert" className="lv-alert lv-alert-danger text-[12.5px] leading-[1.6] text-text-secondary">
                      {dayError}
                    </p>
                  )}
                  {(tracking?.tracking_no || order.tracking_no) && (
                    <CopyField label={s.trackingNo} value={String(tracking?.tracking_no || order.tracking_no)} mono />
                  )}
                </div>
              )}

              {tab === 'items' && (
                <div className="flex flex-col gap-3">
                  <ul className="flex flex-col gap-3" data-order-items>
                    {order.items.map((it) => {
                      const itemUnits = unitsByItem.get(it.id) ?? [];
                      const reviewedThis = !!it.product_id && !!reviewed?.has(it.product_id);
                      const unitPrice = it.pricing?.unit_subtotal_iqd ?? it.unit_price_iqd;
                      const extras: string[] = [];
                      const months = it.warranty?.duration_months;
                      if (it.warranty && typeof months === 'number' && months > 0) {
                        // An EXTENSION is "+N months", with the total the
                        // checkout froze beside it — printing the extension's
                        // months as the whole warranty misled the customer.
                        if (it.warranty.duration_kind === 'extension') {
                          const total = it.warranty.total_months;
                          extras.push(
                            s.warrantyExtended(
                              monthsLabel(months, lang),
                              typeof total === 'number' && total > 0 ? monthsLabel(total, lang) : null
                            )
                          );
                        } else {
                          extras.push(s.warrantyMonths(months));
                        }
                      }
                      const method = it.transport?.method;
                      if (method && s.transport[method]) extras.push(s.transport[method]);
                      // A pre-order paid cash on delivery: the line kept its
                      // journey but was priced by the direct-sale rule — the
                      // frozen snapshot says so, and the customer is told.
                      if (method && it.pricing?.pricing_basis === 'direct') extras.push(s.codDirectPricing);
                      // The home-delivery note is about a delivery still to
                      // come: a delivered order has paid it (or not), and a
                      // cancelled one will never be delivered — neither is
                      // told to keep money ready at the door.
                      const showPrinterNote =
                        it.is_printer === true &&
                        printerNoteIqd !== null &&
                        order.delivery_method?.id !== 'pickup' &&
                        order.status !== 'delivered' &&
                        order.status !== 'cancelled';
                      return (
                        <li key={it.id} data-order-item={it.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
                          <div className="flex gap-3">
                            <SafeImage src={it.image} alt="" aspect="square" className="w-16 h-16 rounded-xl shrink-0" bgClassName="bg-black" />
                            <div className="min-w-0 flex-1">
                              {it.product_slug ? (
                                <Link
                                  to={`/product/${encodeURIComponent(it.product_slug)}`}
                                  className="text-white text-[13.5px] font-bold line-clamp-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded"
                                >
                                  {it.name}
                                </Link>
                              ) : (
                                <p className="text-white text-[13.5px] font-bold line-clamp-2">{it.name}</p>
                              )}
                              {it.variant && <p className="text-[12px] text-zinc-500 truncate">{it.variant}</p>}
                              <p className="text-[12px] text-zinc-400 tabular-nums mt-0.5">
                                × {it.qty} · {formatIqd(Number(unitPrice) || 0)}
                              </p>
                              {extras.length > 0 && <p className="text-[11px] text-zinc-500 truncate">{extras.join(' · ')}</p>}
                            </div>
                            <p className="text-[13.5px] text-white font-bold tabular-nums shrink-0">{formatIqd(it.line_total_iqd)}</p>
                          </div>

                          {/* A bundle is ONE item here too, with its parts
                              unfolding underneath (§6.3). Each part's figure is
                              its own share of what was paid — the components
                              are priced at 0 on the order, because the money is
                              on this line. */}
                          {it.bundle && it.bundle.components.length > 0 && (
                            <BundleContents
                              className="mt-3"
                              componentTotalIqd={it.bundle.component_total_iqd}
                              savingPercent={it.bundle.saving_percent}
                              lines={it.bundle.components.map((k) => ({
                                key: k.order_item_id,
                                name: k.name,
                                variant: k.variant,
                                qty: k.qty,
                                value_iqd: k.alloc_iqd,
                              }))}
                            />
                          )}

                          {/* THE MYSTERY LINE (§8). Pre-reveal it says when,
                              never what; post-reveal it renders the frozen
                              allocation snapshots. The verdict is the
                              server's — this screen has no reveal logic. */}
                          {it.mystery && (
                            <MysteryReveal mystery={it.mystery} cover={it.image} viewer="customer" />
                          )}

                          {showPrinterNote && (
                            <Note tone="gold" compact animate={false} icon={<Truck className="w-3.5 h-3.5" aria-hidden />} className="mt-3" testId="order-printer-note">
                              {s.printerNote(formatIqd(printerNoteIqd))}
                            </Note>
                          )}

                          {order.status === 'delivered' && it.product_id && (
                            <div className="mt-3">
                              {reviewedThis ? (
                                <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-300" data-item-reviewed={it.id}>
                                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                                  {s.reviewed}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  data-rate-item={it.id}
                                  onClick={() => {
                                    setReviewItem(it.id);
                                    setReviewOpen(true);
                                  }}
                                  className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border border-[#BAA369]/40 text-[#BAA369] text-[12.5px] font-bold hover:bg-[#BAA369]/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                                >
                                  <Star className="w-3.5 h-3.5" aria-hidden />
                                  {s.rate}
                                </button>
                              )}
                            </div>
                          )}

                          {itemUnits.length > 0 && <OrderUnits units={itemUnits} onLinked={markLinked} />}
                        </li>
                      );
                    })}
                  </ul>

                  {unitsFailed && (
                    <p role="status" className="text-amber-400 text-[12px]">
                      {s.unitsFailed}
                    </p>
                  )}
                  {units && units.length > 0 && (
                    <Link to="/warranty" className={TILE} data-warranty-centre>
                      <ShieldCheck className="w-4 h-4 text-[#BAA369] shrink-0" aria-hidden />
                      <span className="flex-1 min-w-0 text-[13px] text-zinc-300 truncate">{s.warrantyCentre}</span>
                      <ChevronRight className="w-4 h-4 text-zinc-600 rtl:rotate-180 shrink-0" aria-hidden />
                    </Link>
                  )}
                  <ReorderButton items={order.items} className="mt-1" />
                </div>
              )}

              {tab === 'payment' && (
                <div className="flex flex-col gap-3">
                  {order.financial ? (
                    <PaymentBreakdown order={order} financial={order.financial} />
                  ) : (
                    <p className="text-zinc-500 text-[12.5px]">{s.financialUnavailable}</p>
                  )}
                  {order.invoice && (
                    <a
                      href={`/api/invoices/${encodeURIComponent(order.invoice.id)}/html`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={TILE}
                      data-view-invoice={order.invoice.invoice_no}
                    >
                      <FileText className="w-4 h-4 text-[#BAA369] shrink-0" aria-hidden />
                      <span className="flex-1 min-w-0 text-[13px] text-zinc-300 truncate">
                        {s.invoice} <span dir="ltr" className="font-mono text-zinc-500">{order.invoice.invoice_no}</span>
                      </span>
                      <ExternalLink className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden />
                    </a>
                  )}
                  <PriceProtection order={order} />
                  <ReturnsSection order={order} units={units ?? undefined} />
                </div>
              )}

              {tab === 'support' && <SupportActions order={order} onCancelRequest={() => setCancelOpen(true)} />}
            </TabPanels>
          </>
        ) : null}
      </div>

      <CancelOrderSheet open={cancelOpen} orderId={order?.id ?? null} onClose={() => setCancelOpen(false)} onCancelled={onCancelled} />
      {order && (
        <ReviewSheet
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          orderId={order.id}
          items={order.items}
          initialItemId={reviewItem}
          reviewedProductIds={reviewed ?? EMPTY_SET}
          onSubmitted={onReviewSubmitted}
        />
      )}
    </div>
  );
}
