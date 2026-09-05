/**
 * One order in the customer's list.
 *
 * Quiet on purpose. The gold hairline along the top is the only thing that
 * says how far the order has come; the pill repeats it in words; everything
 * else is the facts a person scans a list for — what, when, how much — and
 * the four verbs they might want next.
 *
 * Nothing here is computed from money: the total, the due-on-delivery
 * balance and the item count all arrive from the server. When a field is
 * absent the element is absent too — no placeholder stands in for a fact.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Truck, Star, XCircle, Clock } from 'lucide-react';
import { formatIqd } from '../../lib/api';
import type { ApiOrder } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import SafeImage from '../ui/SafeImage';
import OrderTracker from '../OrderTracker';
import StatusHairline from './StatusHairline';
import InlineCopy from './InlineCopy';
import { asLang, countItems, formatDate, formatDateTime, itemCountLabel, statusLabel, statusStyle } from './format';

const STRINGS = {
  ar: {
    track: 'تتبع',
    hideTrack: 'إخفاء التتبع',
    details: 'التفاصيل',
    cancel: 'إلغاء',
    review: 'تقييم',
    total: 'المجموع',
    due: 'المتبقي عند التسليم',
    next: 'الخطوة التالية',
    orderId: 'رقم الطلب',
    giftTitle: 'هدية مرفقة مع هذا الطلب',
    giftDefault: 'بكرة فلمنت',
    more: (n: number) => `+${n}`,
    open: (id: string) => `فتح تفاصيل الطلب ${id}`,
  },
  en: {
    track: 'Track',
    hideTrack: 'Hide tracking',
    details: 'Details',
    cancel: 'Cancel',
    review: 'Review',
    total: 'Total',
    due: 'Due on delivery',
    next: 'Next step',
    orderId: 'Order number',
    giftTitle: 'A gift ships with this order',
    giftDefault: 'Filament spool',
    more: (n: number) => `+${n}`,
    open: (id: string) => `Open order ${id}`,
  },
  ckb: {
    track: 'بەدواداچوون',
    hideTrack: 'شاردنەوەی بەدواداچوون',
    details: 'وردەکاری',
    cancel: 'هەڵوەشاندنەوە',
    review: 'هەڵسەنگاندن',
    total: 'کۆی گشتی',
    due: 'ماوە لە کاتی گەیاندن',
    next: 'هەنگاوی داهاتوو',
    orderId: 'ژمارەی داواکاری',
    giftTitle: 'دیارییەک لەگەڵ ئەم داواکارییە دەنێردرێت',
    giftDefault: 'بەکەرەی فیلامێنت',
    more: (n: number) => `+${n}`,
    open: (id: string) => `کردنەوەی داواکاری ${id}`,
  },
} as const;

const ACTION =
  'inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border text-[12.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50';
const ACTION_QUIET = `${ACTION} border-zinc-800 text-zinc-200 hover:bg-zinc-800`;

/**
 * What is still owed at the door. `due_on_delivery_iqd` is the checkout-time
 * cash-on-delivery figure and is never zeroed, so read alone it keeps
 * announcing a balance on orders long since paid or cancelled. The server's
 * financial snapshot (§5) says what is actually outstanding; the raw field is
 * trusted only for an order still on its way that carries no snapshot.
 */
function dueOnDelivery(order: ApiOrder): number {
  if (order.status === 'cancelled') return 0;
  const fin = order.financial;
  if (fin) {
    if (fin.payment_state === 'paid') return 0;
    return Number(fin.outstanding_iqd) || 0;
  }
  if (order.status === 'delivered') return 0;
  return Number(order.due_on_delivery_iqd) || 0;
}

export default function OrderCard({
  order,
  reviewedProductIds,
  trackingOpen,
  onToggleTracking,
  onCancel,
  onReview,
}: {
  order: ApiOrder;
  /** null = not known yet; the Review verb is then offered on every delivered order. */
  reviewedProductIds: ReadonlySet<string> | null;
  trackingOpen: boolean;
  onToggleTracking: () => void;
  onCancel: (order: ApiOrder, anchor: HTMLElement | null) => void;
  onReview: (order: ApiOrder, anchor: HTMLElement | null) => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const count = countItems(order.items, order.item_count);
  const stack = order.items.slice(0, 3);
  const extraLines = Math.max(0, order.items.length - 1);
  const due = dueOnDelivery(order);
  const canReview =
    order.status === 'delivered' &&
    (reviewedProductIds === null ||
      order.items.some((it) => it.product_id && !reviewedProductIds.has(it.product_id)));

  return (
    <article
      data-order-id={order.id}
      data-order-status={order.status}
      className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60"
    >
      <StatusHairline progress={order.progress} cancelled={order.status === 'cancelled'} />
      <div className="p-4">
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex shrink-0" aria-hidden="true">
              {stack.map((it, i) => (
                <SafeImage
                  key={it.id}
                  src={it.image}
                  alt=""
                  aspect="square"
                  className={`w-12 h-12 rounded-xl border border-zinc-800 ring-2 ring-zinc-950 ${i > 0 ? '-ms-3' : ''}`}
                  bgClassName="bg-black"
                  fallbackIconClassName="w-5 h-5"
                />
              ))}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-0.5 min-w-0">
                <span dir="ltr" className="text-white font-bold text-[14px] truncate">
                  {order.id}
                </span>
                <InlineCopy value={order.id} label={s.orderId} />
              </div>
              <p className="text-[12px] text-zinc-500 truncate">
                <time dateTime={order.created_at}>{formatDate(order.created_at, lang)}</time>
                {' · '}
                {itemCountLabel(count, lang)}
              </p>
            </div>
          </div>
          <span
            data-order-pill
            className={`shrink-0 inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusStyle(order.status)}`}
          >
            {statusLabel(lang, order.status)}
          </span>
        </header>

        {order.items[0] && (
          <p className="mt-3 text-[13px] text-zinc-300 truncate">
            {order.items[0].name}
            {extraLines > 0 && <span className="text-zinc-500"> {s.more(extraLines)}</span>}
          </p>
        )}

        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] text-zinc-500">{s.total}</p>
            <p className="text-[#BAA369] font-bold text-[15px] tabular-nums">{formatIqd(order.total_iqd)}</p>
            {due > 0 && (
              <p className="text-[11.5px] text-zinc-400 tabular-nums">
                {s.due}: {formatIqd(due)}
              </p>
            )}
          </div>
          {/* Only ever shown when the SERVER scheduled the next move. */}
          {order.next_stage_at && order.status !== 'cancelled' && order.status !== 'delivered' && (
            <p className="text-[11px] text-zinc-500 text-end inline-flex items-center gap-1 shrink-0">
              <Clock className="w-3 h-3" aria-hidden />
              <span>
                {s.next}: <time dateTime={order.next_stage_at}>{formatDateTime(order.next_stage_at, lang)}</time>
              </span>
            </p>
          )}
        </div>

        {/* A membership gift earned on this order. Worth 0 IQD on every
            total — announced beside the order, never folded into it. */}
        {order.membership_gift && (
          <div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
            <p className="text-[12.5px] font-bold text-emerald-300">{s.giftTitle}</p>
            {/* The server stores the gift's label in Arabic only
                (entitlements.ts PreorderGiftSnapshot); every other language
                gets the component's own wording rather than Arabic text. */}
            <p className="text-[12px] text-emerald-200/85 mt-0.5">
              {(asLang(lang) === 'ar' && order.membership_gift.label_ar) || s.giftDefault}
              {order.membership_gift.qty > 1 && ` × ${order.membership_gift.qty}`}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-track-order={order.id}
            aria-expanded={trackingOpen}
            onClick={onToggleTracking}
            className={ACTION_QUIET}
          >
            <Truck className="w-3.5 h-3.5" aria-hidden />
            {trackingOpen ? s.hideTrack : s.track}
          </button>
          <Link to={`/orders/${encodeURIComponent(order.id)}`} aria-label={s.open(order.id)} className={ACTION_QUIET}>
            {s.details}
            <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" aria-hidden />
          </Link>
          {order.status === 'pending' && (
            <button
              type="button"
              data-cancel-order={order.id}
              onClick={(e) => onCancel(order, e.currentTarget)}
              className={`${ACTION} border-red-500/30 text-red-300 hover:bg-red-500/10 focus-visible:ring-red-400`}
            >
              <XCircle className="w-3.5 h-3.5" aria-hidden />
              {s.cancel}
            </button>
          )}
          {canReview && (
            <button
              type="button"
              data-review-order={order.id}
              onClick={(e) => onReview(order, e.currentTarget)}
              className={`${ACTION} border-[#BAA369]/40 text-[#BAA369] hover:bg-[#BAA369]/10`}
            >
              <Star className="w-3.5 h-3.5" aria-hidden />
              {s.review}
            </button>
          )}
        </div>

        {trackingOpen && <OrderTracker orderId={order.id} lang={lang} />}
      </div>
    </article>
  );
}
