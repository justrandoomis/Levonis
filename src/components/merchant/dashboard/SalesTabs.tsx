/**
 * The selling side of the dashboard: store orders (with the full fulfilment
 * detail — address, phone, items, chat), custom community orders (the
 * request → offer → escrow lifecycle), and the store's own coupons.
 *
 * Money semantics are the server's: a store order's payout becomes available
 * when the CUSTOMER confirms receipt, or three days after delivery with no
 * open complaint — the merchant's own «تم التسليم» starts that clock and
 * releases nothing (owner decision 2026-09-24); a community order pays only
 * when the customer confirms. Every state button below is exactly one legal
 * transition of those machines.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronDown, Copy, Loader2, MapPin, MessageCircle, Phone, Plus, Tag, Trash2,
  ExternalLink, Hammer, Check,
} from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError } from '../../../lib/api';
import { useStore } from '../../../StoreContext';
import { useCommunityAccess } from '../../../pages/community/access';
import {
  merchantApi, communityOrdersApi, iqd,
  type CommunityOrderRow, type MerchantCoupon,
} from '../../../lib/merchant';
import OrderContactCard from '../../community/offers/OrderContactCard';
import { Btn, Card, Chip, Empty, Input, Notice, Spinner, Toggle, useMainSiteHref, type Loc } from './ui';
import { Sheet } from '../../ui/Overlay';
import { apiRefusal } from '../../../lib/refusalStrings';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { merchantRefusal } from '../shell/refusal';
import { formatDate } from '../../orders/format';

// ------------------------------------------------------------ store orders

const ORDER_FLOW: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const STATUS_FILTERS = ['', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as const;

export function statusLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'pending': return loc('جديد', 'New', 'نوێ');
    case 'confirmed': return loc('مؤكد', 'Confirmed', 'پشتڕاستکراو');
    case 'processing': return loc('قيد التجهيز', 'Preparing', 'ئامادەکردن');
    case 'shipped': return loc('تم الشحن', 'Shipped', 'نێردرا');
    case 'delivered': return loc('تم التسليم', 'Delivered', 'گەیشت');
    case 'cancelled': return loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە');
    default: return k;
  }
}

export function StatusChip({ status }: { status: string }) {
  const { loc } = useLanguage();
  const map: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    confirmed: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    processing: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    shipped: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    delivered: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    cancelled: 'bg-red-500/10 text-red-300 border-red-500/20',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[status] ?? map.pending}`}>
      {statusLabel(status, loc)}
    </span>
  );
}

/**
 * Where the merchant's money for one store order stands — said on the order,
 * so «تم التسليم» is never read as «paid». Nothing for a cancelled order (its
 * chip says it) or one still on its way.
 */
function creditText(o: Record<string, unknown>, loc: Loc, lang: string): string {
  if (o.status === 'cancelled') return '';
  if (o.credit_state === 'available') {
    // OWNER: Sorani to be written by hand.
    return loc('المبلغ متاح في رصيدك', 'The money is in your available balance');
  }
  if (o.credit_state === 'pending' && o.status === 'delivered') {
    const at = typeof o.release_after === 'string' ? formatDate(o.release_after, lang) : '';
    return at
      ? // OWNER: Sorani to be written by hand.
        loc(
          `بانتظار تأكيد الزبون — أو تلقائيًا بعد ${at} ما لم تُفتح شكوى`,
          `Awaiting the customer’s confirmation — or automatically after ${at} unless a complaint is open`
        )
      : loc('بانتظار تأكيد الزبون', 'Awaiting customer confirmation', 'چاوەڕوانی کڕیار');
  }
  return '';
}

/**
 * `focusOrderId`: the order a workspace address names (`/merchant/orders/<id>`,
 * a notification's or the ledger's link, W2-E) — opened and scrolled to; shown
 * on its own above the list when it is not on the loaded page.
 */
export function OrdersTab({
  focusOrderId = null,
  initialStatus = '',
  orderHref,
}: {
  focusOrderId?: string | null;
  /** The list opened on one status — a workspace address's `?status=` (W3-A). */
  initialStatus?: string;
  /** The order's own screen (W3-B): an open row links to it. */
  orderHref?: (orderId: string) => string;
} = {}) {
  const { loc, lang } = useLanguage();
  const [orders, setOrders] = useState<Record<string, unknown>[] | null>(null);
  /** The server's keyset cursor for the next page (B26) — null on the last. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState(() => ((STATUS_FILTERS as readonly string[]).includes(initialStatus) ? initialStatus : ''));
  useEffect(() => {
    if ((STATUS_FILTERS as readonly string[]).includes(initialStatus)) setFilter(initialStatus);
  }, [initialStatus]);
  const [busy, setBusy] = useState('');
  const [openId, setOpenId] = useState(focusOrderId ?? '');
  useEffect(() => {
    if (focusOrderId) setOpenId(focusOrderId);
  }, [focusOrderId]);
  /** A refused move, beside the order it was refused for — never a browser alert. */
  const [moveError, setMoveError] = useState<{ id: string; text: string } | null>(null);
  /** The order whose cancellation is being confirmed, and that sheet's own error. */
  const [cancelId, setCancelId] = useState('');
  const [cancelError, setCancelError] = useState('');
  /** A list answer that lands after the filter changed is dropped, not shown. */
  const seq = useRef(0);

  const query = useCallback(
    (cursor?: string) => {
      const qs = new URLSearchParams();
      if (filter) qs.set('status', filter);
      if (cursor) qs.set('cursor', cursor);
      const q = qs.toString();
      return q ? `?${q}` : '';
    },
    [filter]
  );

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoadFailed(false);
    merchantApi
      .orders(query())
      .then((d) => {
        if (mine !== seq.current) return;
        setOrders(d.orders);
        setNextCursor(d.next_cursor ?? null);
        setMore('idle');
      })
      .catch(() => {
        if (mine === seq.current) setLoadFailed(true);
      });
  }, [query]);
  useEffect(load, [load]);

  async function loadMore() {
    if (!nextCursor || more === 'loading') return;
    const mine = seq.current;
    setMore('loading');
    try {
      const d = await merchantApi.orders(query(nextCursor));
      if (mine !== seq.current) return;
      setOrders((prev) => {
        const seen = new Set((prev ?? []).map((o) => String(o.id)));
        return [...(prev ?? []), ...d.orders.filter((o) => !seen.has(String(o.id)))];
      });
      setNextCursor(d.next_cursor ?? null);
      setMore('idle');
    } catch {
      if (mine === seq.current) setMore('error');
    }
  }

  /** Re-read ONE order after a move, in place — the pages already loaded stay loaded. */
  async function refreshOne(id: string) {
    try {
      const { order: o } = await merchantApi.order(id);
      setOrders((prev) =>
        prev?.map((row) =>
          String(row.id) === id
            ? {
                ...row,
                status: o.status,
                credit_state: o.credit_state,
                release_after: o.release_after,
                delivered_at: o.delivered_at,
                receipt_confirmed_at: o.receipt_confirmed_at,
              }
            : row
        ) ?? prev
      );
    } catch {
      load();
    }
  }

  async function move(id: string, to: string) {
    setBusy(id);
    setMoveError(null);
    setCancelError('');
    try {
      await merchantApi.setOrderStatus(id, to);
      setCancelId('');
      await refreshOne(id);
    } catch (e) {
      // The code, in the merchant's language (ORDER_CHANGED and friends).
      const text = apiRefusal(e, lang, loc('تعذّر تحديث الطلب', 'Could not update the order'));
      if (to === 'cancelled') setCancelError(text);
      else setMoveError({ id, text });
      // A refusal that says the order moved on: show where it is now.
      if (e instanceof ApiError && (e.code === 'ORDER_CHANGED' || e.code === 'ORDER_TRANSITION_INVALID')) {
        void refreshOne(id);
      }
    } finally {
      setBusy('');
    }
  }

  const cancelling = busy !== '' && busy === cancelId;

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar -mx-4 px-4 pb-0.5">
        {STATUS_FILTERS.map((s) => (
          <span key={s || 'all'} className="shrink-0">
            <Chip
              label={s === '' ? loc('الكل', 'All', 'هەموو') : statusLabel(s, loc)}
              active={filter === s}
              onClick={() => {
                if (s === filter) return;
                setOrders(null);
                setNextCursor(null);
                setFilter(s);
              }}
            />
          </span>
        ))}
      </div>

      {orders === null ? (
        loadFailed ? (
          <div className="py-8 text-center space-y-3" role="alert">
            {/* OWNER: Sorani to be written by hand. */}
            <p className="text-zinc-400 text-[13px]">{loc('تعذّر تحميل الطلبات', 'Could not load the orders')}</p>
            <Btn kind="ghost" small onClick={load}>
              {/* OWNER: Sorani to be written by hand. */}
              {loc('إعادة المحاولة', 'Try again')}
            </Btn>
          </div>
        ) : (
          <Spinner />
        )
      ) : !orders.length && !focusOrderId ? (
        <Empty text={loc('لا توجد طلبات', 'No orders', 'داواکاری نییە')} />
      ) : (
        <>
        {focusOrderId && !orders.some((o) => String(o.id) === focusOrderId) && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03]" data-focus-order={focusOrderId}>
            <p className="px-3 pt-3 text-white text-[12.5px] font-semibold" dir="ltr">{focusOrderId}</p>
            <OrderDetail id={focusOrderId} />
          </div>
        )}
        {orders.map((o) => {
          const id = String(o.id);
          const status = String(o.status);
          const next = ORDER_FLOW[status] ?? [];
          const open = openId === id;
          const credit = creditText(o, loc, lang);
          return (
            <div
              key={id}
              className="rounded-2xl border border-white/10 bg-white/[0.03]"
              ref={id === focusOrderId ? (el) => el?.scrollIntoView({ block: 'start' }) : undefined}
            >
              <button
                type="button"
                onClick={() => setOpenId(open ? '' : id)}
                aria-expanded={open}
                className="w-full p-3 text-start"
              >
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0">
                    <p className="text-white text-[12.5px] font-semibold truncate" dir="ltr">{id}</p>
                    <p className="text-zinc-500 text-[11px]">
                      {String(o.customer_name)} · {String(o.item_count)} {loc('منتج', 'items', 'بەرهەم')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <StatusChip status={status} />
                    <ChevronDown className={`w-4 h-4 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </div>
                </div>
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="text-zinc-500">
                    {loc('الإجمالي', 'Total', 'کۆ')}: <span className="text-white font-semibold" dir="ltr">{iqd(Number(o.total_iqd))}</span>
                  </span>
                  <span className="text-zinc-500">
                    {loc('لك', 'You get', 'بۆ تۆ')}: <span className="text-gold font-semibold" dir="ltr">{iqd(Number(o.merchant_receivable_iqd))}</span>
                  </span>
                </div>
                {credit && <p className="text-zinc-500 text-[10.5px] mt-1 leading-relaxed" data-credit-state={String(o.credit_state ?? '')}>{credit}</p>}
              </button>

              {/* Keyed on the status, so a move re-reads the sheet's money rows. */}
              {open && <OrderDetail key={`${id}:${status}`} id={id} />}
              {open && orderHref && (
                <div className="px-3 pb-3">
                  <Link to={orderHref(id)} data-open-order={id} className="inline-flex min-h-11 items-center text-[12.5px] font-semibold text-gold underline-offset-2 hover:underline">
                    {/* OWNER: Sorani to be written by hand. */}
                    {loc('صفحة الطلب كاملة: المال والخط الزمني والطباعة', 'The full order: money, timeline and printing')}
                  </Link>
                </div>
              )}

              {next.length > 0 && (
                <div className="px-3 pb-3 space-y-1.5">
                  <div className="flex gap-2 flex-wrap">
                    {next.map((s) => (
                      <Btn
                        key={s}
                        small
                        kind={s === 'cancelled' ? 'danger' : 'primary'}
                        disabled={busy === id}
                        onClick={() => {
                          if (s === 'cancelled') {
                            setCancelError('');
                            setCancelId(id);
                            return;
                          }
                          void move(id, s);
                        }}
                      >
                        {busy === id && s !== 'cancelled' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null}
                        {statusLabel(s, loc)}
                      </Btn>
                    ))}
                  </div>
                  {next.includes('delivered') && (
                    <p className="text-zinc-600 text-[10.5px] leading-relaxed">
                      {/* OWNER: Sorani to be written by hand. */}
                      {loc(
                        'بعد «تم التسليم» يصلك المبلغ حين يؤكد الزبون الاستلام، أو تلقائيًا بعد 3 أيام ما لم تُفتح شكوى.',
                        'After “Delivered”, your money arrives when the customer confirms receipt — or automatically after 3 days unless a complaint is open.'
                      )}
                    </p>
                  )}
                  {moveError?.id === id && (
                    <p role="alert" className="text-red-300 text-[11px]">{moveError.text}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        </>
      )}

      {orders !== null && nextCursor && (
        <Btn kind="ghost" full onClick={loadMore} disabled={more === 'loading'}>
          {more === 'loading'
            ? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')
            : more === 'error'
              ? loc('تعذر تحميل المزيد — إعادة المحاولة', 'Failed to load more — retry', 'زیاتر بارنەبوو — دووبارە هەوڵ بدەوە')
              : loc('عرض المزيد', 'Load more', 'زیاتر پیشان بدە')}
        </Btn>
      )}

      {/* The one irreversible move, confirmed in a sheet that says what it
          does to the customer's money — never `window.confirm`. */}
      <Sheet
        open={cancelId !== ''}
        onClose={() => {
          if (!cancelling) setCancelId('');
        }}
        label={loc('إلغاء الطلب؟', 'Cancel this order?', 'هەڵوەشاندنەوە؟')}
        dismissOnEscape={!cancelling}
        dismissOnScrim={!cancelling}
        panelClassName="w-full sm:max-w-md"
        testId="merchant-cancel-order"
      >
        <div className="px-5 pb-6 pt-2">
          <h2 className="text-white font-bold text-[16px]">{loc('إلغاء الطلب؟', 'Cancel this order?', 'هەڵوەشاندنەوە؟')}</h2>
          <p className="text-zinc-400 text-[13px] mt-2 leading-relaxed">
            {/* OWNER: Sorani to be written by hand. */}
            {loc(
              'يُعاد إلى الزبون كامل ما دفعه في محفظته، وتعود الكمية إلى مخزونك، ويُحرَّر استخدام الكوبون. لا يمكن التراجع عن الإلغاء.',
              'The customer gets back everything they paid, to their wallet; the units return to your stock and the coupon use is released. A cancellation cannot be undone.'
            )}
          </p>
          <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-3 min-h-[1.25em]">
            {cancelError}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setCancelId('')}
              disabled={cancelling}
              className="flex-1 min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
            >
              {loc('الإبقاء على الطلب', 'Keep order', 'هێشتنەوەی داواکاری')}
            </button>
            <button
              type="button"
              onClick={() => void move(cancelId, 'cancelled')}
              disabled={cancelling}
              data-confirm-merchant-cancel
              className="flex-1 min-h-[44px] rounded-xl bg-[#ef233c] text-white text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {cancelling && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {cancelling
                ? loc('جارٍ الإلغاء…', 'Cancelling…', 'هەڵوەشاندنەوە…')
                : loc('إلغاء الطلب', 'Cancel order', 'هەڵوەشاندنەوەی داواکاری')}
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

/** The fulfilment sheet: who, where, what — and the door to the order chat. */
function OrderDetail({ id }: { id: string }) {
  const { loc, lang } = useLanguage();
  const navigate = useNavigate();
  const { store: hostStore } = useStore();
  const mainHref = useMainSiteHref();
  const [data, setData] = useState<Awaited<ReturnType<typeof merchantApi.order>> | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');

  useEffect(() => {
    merchantApi.order(id).then(setData).catch(() => {});
  }, [id]);

  if (!data) return <Spinner />;
  const o = data.order;
  const addr = (o.address as Record<string, unknown>) ?? {};
  // The snapshot is the addresses-table row: governorate, area, the free-text
  // address line and an optional landmark.
  const addrText = [addr.governorate, addr.area, addr.address, addr.landmark]
    .filter(Boolean)
    .join('، ');
  const phone = String(o.customer_phone ?? '');

  async function openChat() {
    setChatBusy(true);
    setChatError('');
    try {
      const r = await api.post<{ chatId: string }>('/api/chats/open', { orderId: id });
      // On a store subdomain the messenger lives on the main site — the
      // shared cookie keeps the session across the hop. The address comes
      // from the dashboard's one main-site helper, not a second literal.
      if (hostStore) window.location.href = mainHref(`/chat/${r.chatId}`);
      else navigate(`/chat/${r.chatId}`);
    } catch (e) {
      // Beside the button, in the merchant's language — never a browser alert.
      // OWNER: Sorani to be written by hand.
      setChatError(apiRefusal(e, lang, loc('تعذّر فتح المحادثة', 'Could not open the chat')));
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="px-3 pb-3 space-y-2.5">
      <div className="rounded-xl bg-black/30 border border-white/5 p-2.5 space-y-1.5">
        {phone && (
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <span className="text-zinc-400 flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5" />
              <a href={`tel:${phone}`} className="text-gold font-semibold" dir="ltr">{phone}</a>
            </span>
            <button
              onClick={() => navigator.clipboard?.writeText(phone).catch(() => {})}
              className="text-zinc-500 p-1"
              aria-label={loc('نسخ', 'Copy', 'کۆپی')}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {addrText && (
          <div className="flex items-start justify-between gap-2 text-[12px]">
            <span className="text-zinc-300 flex items-start gap-1.5">
              <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-zinc-500" />
              {addrText}
            </span>
            <button
              onClick={() => navigator.clipboard?.writeText(addrText).catch(() => {})}
              className="text-zinc-500 p-1 shrink-0"
              aria-label={loc('نسخ', 'Copy', 'کۆپی')}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {data.items.map((it) => (
          <div key={String(it.id)} className="flex items-center gap-2.5 text-[12px]">
            <div className="w-9 h-9 rounded-lg bg-black/40 overflow-hidden shrink-0">
              {!!it.image_snapshot && <img src={String(it.image_snapshot)} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-zinc-200 truncate">{String(it.name_snapshot)}</p>
              {!!it.option_snapshot && <p className="text-zinc-600 text-[10.5px]" dir="auto">{String(it.option_snapshot)}</p>}
            </div>
            <span className="text-zinc-500 shrink-0" dir="ltr">×{String(it.qty)}</span>
            <span className="text-zinc-300 font-semibold shrink-0" dir="ltr">{iqd(Number(it.line_total_iqd))}</span>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-black/30 border border-white/5 p-2.5 text-[11.5px] space-y-1">
        <Row label={loc('المنتجات', 'Items', 'بەرهەمەکان')} value={iqd(Number(o.subtotal_iqd))} />
        {Number(o.coupon_discount_iqd ?? 0) > 0 && (
          <Row label={`${loc('كوبون', 'Coupon', 'کۆبۆن')} ${String(o.coupon_code ?? '')}`} value={`− ${iqd(Number(o.coupon_discount_iqd))}`} />
        )}
        <Row label={loc('التوصيل', 'Delivery', 'گەیاندن')} value={iqd(Number(o.shipping_iqd))} />
        <Row label={loc('الإجمالي', 'Total', 'کۆی گشتی')} value={iqd(Number(o.total_iqd))} strong />
        <Row label={loc('عمولة المنصة', 'Platform fee', 'کۆمیشن')} value={`− ${iqd(Number(o.platform_fee_iqd))}`} />
        <Row label={loc('صافي أرباحك', 'Your share', 'بەشی تۆ')} value={iqd(Number(o.merchant_receivable_iqd))} gold />
        <Row
          label={loc('الدفع', 'Payment', 'پارەدان')}
          value={o.payment_method_id === 'wallet' ? loc('محفظة (مدفوع)', 'Wallet (paid)', 'جزدان') : loc('عند الاستلام', 'Cash on delivery', 'لە گەیاندن')}
        />
      </div>

      <Btn kind="ghost" small onClick={openChat} disabled={chatBusy}>
        {chatBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageCircle className="w-3.5 h-3.5" />}
        {loc('محادثة حول الطلب', 'Chat about this order', 'گفتوگۆ لەسەر داواکاری')}
      </Btn>
      {chatError && <p role="alert" className="text-red-300 text-[11px]">{chatError}</p>}
    </div>
  );
}

function Row({ label, value, strong, gold }: { label: string; value: string; strong?: boolean; gold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className={`${gold ? 'text-gold font-bold' : strong ? 'text-white font-bold' : 'text-zinc-300'}`} dir="ltr">
        {value}
      </span>
    </div>
  );
}

// --------------------------------------------------------- community orders

function communityStateLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'funded': return loc('مموّل — بانتظار البدء', 'Funded — awaiting start', 'پارە دراوە');
    case 'in_progress': return loc('قيد التنفيذ', 'In progress', 'لە جێبەجێکردندایە');
    case 'merchant_marked_delivered': return loc('بانتظار تأكيد الزبون', 'Awaiting customer confirmation', 'چاوەڕوانی کڕیار');
    case 'completed': return loc('مكتمل — تم تحويل المبلغ', 'Completed — funds released', 'تەواو');
    case 'disputed': return loc('نزاع — بيد Levonis', 'Disputed — with Levonis', 'ناکۆکی');
    case 'cancelled': return loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە');
    case 'refunded': return loc('مسترجع', 'Refunded', 'گەڕێنراوەتەوە');
    case 'accepted': return loc('مقبول', 'Accepted', 'پەسەندکراو');
    default: return k;
  }
}

/**
 * The merchant side of custom orders. The money is IN ESCROW: starting and
 * delivering are the merchant's moves, but only the customer's confirmation
 * releases the funds — the buttons say exactly that.
 */
export function CustomOrdersTab() {
  const { loc, lang } = useLanguage();
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  const mainHref = useMainSiteHref();
  // The request board is Levo Community (DECISIONS 110): while it is shut to
  // this merchant, browsing it would land on the maintenance card. Funded
  // orders below keep running — their routes stay open.
  const { access: communityAccess } = useCommunityAccess();
  const [orders, setOrders] = useState<CommunityOrderRow[] | null>(null);
  const [busy, setBusy] = useState('');
  // A refused «ابدأ العمل» says why, on its own card, in the merchant's language
  // (the order changed under them, or its money is not held — review F2).
  const [startError, setStartError] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(() => {
    communityOrdersApi
      .list()
      .then((d) => setOrders(d.orders.filter((o) => o.role === 'merchant')))
      .catch(() => setOrders([]));
  }, []);
  useEffect(load, [load]);

  if (orders === null) return <Spinner />;

  return (
    <div className="space-y-3">
      {communityAccess?.may_enter !== false && (
        <a
          href={mainHref('/requests')}
          className="w-full h-10 rounded-xl border border-gold/30 bg-gold/10 text-gold font-bold text-[12.5px] flex items-center justify-center gap-2"
        >
          <Hammer className="w-4 h-4" />
          {loc('تصفح طلبات الزبائن وقدّم عروضك', 'Browse customer requests and make offers', 'داواکاریەکان ببینە و ئۆفەر بدە')}
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}

      {!orders.length && (
        <Empty
          text={loc('لا توجد طلبات مخصصة بعد', 'No custom orders yet', 'هێشتا داواکاری تایبەت نییە')}
          hint={loc(
            'عندما يقبل زبون عرضك على طلبه، يظهر هنا كطلب مموّل جاهز للتنفيذ.',
            'When a customer accepts your offer, it appears here funded and ready to start.',
            'کاتێک کڕیار ئۆفەرەکەت قبوڵ دەکات لێرە دەردەکەوێت.'
          )}
        />
      )}

      {orders.map((o) => (
        <div key={o.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <p className="text-white text-[12.5px] font-semibold flex-1 min-w-0 truncate">{o.request_title}</p>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 shrink-0">
              {communityStateLabel(o.state, loc)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11.5px] mb-2">
            <span className="text-zinc-500">
              {loc('قيمة الاتفاق', 'Deal value', 'بەهای ڕێککەوتن')}: <span className="text-white font-semibold" dir="ltr">{iqd(o.price_iqd)}</span>
            </span>
            <span className="text-zinc-500">
              {loc('لك', 'You get', 'بۆ تۆ')}: <span className="text-gold font-semibold" dir="ltr">{iqd(o.merchant_receivable_iqd)}</span>
            </span>
          </div>

          {/* W5-A: the customer's contact and delivery details, revealed by the
              acceptance, and the request's conversation. */}
          {['funded', 'in_progress', 'merchant_marked_delivered', 'disputed'].includes(o.state) && (
            <details className="mb-2" data-custom-order-contact={o.id}>
              <summary className="min-h-[44px] flex items-center cursor-pointer text-[12px] font-semibold text-gold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]">
                {loc('بيانات الزبون والتسليم', 'Customer and delivery details')}
              </summary>
              <OrderContactCard orderId={o.id} compact />
            </details>
          )}

          {o.state === 'funded' && (
            <Btn
              small
              disabled={busy === o.id}
              onClick={async () => {
                setBusy(o.id);
                setStartError(null);
                try {
                  await communityOrdersApi.start(o.id);
                } catch (e) {
                  // OWNER: Sorani to be written by hand.
                  setStartError({ id: o.id, text: apiRefusal(e, lang, loc('تعذّر بدء العمل', 'Could not start the work')) });
                } finally {
                  setBusy('');
                  // Either way the card shows the order as it now stands.
                  load();
                }
              }}
            >
              {loc('ابدأ العمل', 'Start work', 'دەست پێ بکە')}
            </Btn>
          )}
          {startError?.id === o.id && (
            <p role="alert" className="text-red-300 text-[11px] mt-1.5">
              {startError.text}
            </p>
          )}
          {o.state === 'in_progress' && (
            <Btn
              small
              disabled={busy === o.id}
              onClick={async () => {
                const ok = await confirm({
                  title: loc('تأكيد التسليم؟', 'Mark delivered?', 'گەیاندن پشتڕاست بکرێتەوە؟'),
                  // OWNER: Sorani to be written by hand.
                  consequence: loc('المبلغ يبقى محجوزًا حتى يؤكد الزبون الاستلام.', 'The money stays held until the customer confirms.'),
                  confirmLabel: loc('سلّمت العمل', 'I delivered the work', 'کارەکەم گەیاند'),
                  cancelLabel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
                });
                if (!ok) return;
                setBusy(o.id);
                try {
                  await communityOrdersApi.delivered(o.id);
                  load();
                } catch (e) {
                  // OWNER: Sorani to be written by hand.
                  toast.error(merchantRefusal(e, lang, loc('تعذّر تسجيل التسليم', 'Could not mark the work delivered')));
                } finally {
                  setBusy('');
                }
              }}
            >
              <Check className="w-3.5 h-3.5" />
              {loc('سلّمت العمل', 'I delivered the work', 'کارەکەم گەیاند')}
            </Btn>
          )}
          {o.state === 'merchant_marked_delivered' && (
            <p className="text-zinc-500 text-[11px]">
              {loc(
                'المبلغ يُحوَّل لك فور تأكيد الزبون.',
                'The funds are released to you the moment the customer confirms.',
                'پارەکە دوای پشتڕاستکردنەوەی کڕیار دەگاتە تۆ.'
              )}
              {o.auto_complete_at &&
                ` ${loc('التأكيد التلقائي', 'Auto-confirm', 'پشتڕاستکردنەوەی خۆکار')}: ${new Date(o.auto_complete_at).toLocaleDateString()}`}
            </p>
          )}
        </div>
      ))}
      {confirmDialog}
    </div>
  );
}

// ----------------------------------------------------------------- coupons

export function CouponsTab({
  canSell,
  startCreating = false,
  onCreateHandled,
}: {
  canSell: boolean;
  /** Open with the «new coupon» form showing — the workspace's quick create (`?new=1`, W3-A). */
  startCreating?: boolean;
  /** Told once the form was opened for `startCreating`, so the address can drop `?new=1`. */
  onCreateHandled?: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  const [items, setItems] = useState<MerchantCoupon[] | null>(null);
  const [creating, setCreating] = useState(() => startCreating && canSell);
  const handled = useRef(onCreateHandled);
  handled.current = onCreateHandled;
  useEffect(() => {
    if (!startCreating) return;
    if (canSell) setCreating(true);
    handled.current?.();
  }, [startCreating, canSell]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [f, setF] = useState({ code: '', kind: 'percent' as 'percent' | 'fixed_iqd', value: '', min: '', maxUses: '' });

  const load = useCallback(() => {
    merchantApi.coupons().then((d) => setItems(d.coupons)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  if (items === null) return <Spinner />;

  async function create() {
    setBusy('new');
    setError('');
    try {
      await merchantApi.createCoupon({
        code: f.code,
        kind: f.kind,
        value: Number(f.value) || 0,
        min_total_iqd: Number(f.min) || 0,
        max_uses: f.maxUses ? Number(f.maxUses) : null,
      });
      setF({ code: '', kind: 'percent', value: '', min: '', maxUses: '' });
      setCreating(false);
      load();
    } catch (e) {
      setError(merchantRefusal(e, lang, loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت')));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-3">
      {canSell ? (
        !creating && (
          <Btn onClick={() => setCreating(true)} full>
            <Plus className="w-4 h-4" />
            {loc('كوبون جديد', 'New coupon', 'کۆبۆنی نوێ')}
          </Btn>
        )
      ) : (
        <Notice text={loc('لا يمكن إنشاء كوبونات جديدة الآن.', 'New coupons cannot be created right now.', 'ناتوانرێت کۆبۆنی نوێ دروست بکرێت.')} />
      )}

      {creating && (
        <Card title={loc('كوبون جديد', 'New coupon', 'کۆبۆنی نوێ')}>
          <div className="space-y-2.5">
            <Input
              label={loc('الكود', 'Code', 'کۆد')}
              value={f.code}
              onChange={(v) => setF({ ...f, code: v.toUpperCase() })}
              placeholder="WELCOME10"
              ltr
            />
            <div className="flex gap-1.5">
              <Chip label={loc('نسبة %', 'Percent %', '٪')} active={f.kind === 'percent'} onClick={() => setF({ ...f, kind: 'percent' })} />
              <Chip label={loc('مبلغ ثابت', 'Fixed amount', 'بڕی جێگیر')} active={f.kind === 'fixed_iqd'} onClick={() => setF({ ...f, kind: 'fixed_iqd' })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input
                label={f.kind === 'percent' ? loc('الخصم %', 'Discount %', '٪') : loc('الخصم د.ع', 'Discount IQD', 'د.ع')}
                value={f.value}
                type="number"
                ltr
                onChange={(v) => setF({ ...f, value: v })}
              />
              <Input label={loc('حد أدنى للطلب', 'Min order', 'کەمترین')} value={f.min} type="number" ltr onChange={(v) => setF({ ...f, min: v })} />
              <Input label={loc('عدد الاستخدامات', 'Max uses', 'ژمارە')} value={f.maxUses} type="number" ltr onChange={(v) => setF({ ...f, maxUses: v })} />
            </div>
            {error && <p className="text-red-400 text-[11.5px]">{error}</p>}
            <div className="flex gap-2">
              <Btn onClick={create} disabled={busy === 'new' || !f.code || !f.value} full>
                {busy === 'new' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
                {loc('إنشاء', 'Create', 'دروستکردن')}
              </Btn>
              <Btn kind="ghost" onClick={() => setCreating(false)}>{loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}</Btn>
            </div>
          </div>
        </Card>
      )}

      {!items.length && !creating && (
        <Empty
          text={loc('لا توجد كوبونات', 'No coupons yet', 'کۆبۆن نییە')}
          hint={loc('الكوبون يعمل فقط في سلة متجرك أنت.', 'A coupon works only in your own store’s checkout.', 'کۆبۆن تەنها لە فرۆشگای خۆتدا کاردەکات.')}
        />
      )}

      {items.map((cp) => (
        <div key={cp.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-white font-bold text-[13px] tracking-wide" dir="ltr">{cp.code}</span>
            <span className="text-gold font-bold text-[12.5px]" dir="ltr">
              {cp.kind === 'percent' ? `${cp.value}%` : iqd(cp.value)}
            </span>
          </div>
          <p className="text-zinc-500 text-[11px] mb-2">
            {cp.min_total_iqd > 0 && `${loc('حد أدنى', 'Min', 'کەمترین')} ${iqd(cp.min_total_iqd)} · `}
            {loc('استُخدم', 'Used', 'بەکارهاتووە')} {cp.used_count}
            {cp.max_uses !== null && ` / ${cp.max_uses}`}
            {!cp.active && ` · ${loc('موقوف', 'inactive', 'ناچالاک')}`}
          </p>
          <div className="flex gap-2">
            <Toggle
              label={cp.active ? loc('فعّال', 'Active', 'چالاک') : loc('موقوف', 'Inactive', 'ناچالاک')}
              on={cp.active}
              disabled={busy === cp.id || (!cp.active && !canSell)}
              onChange={async (v) => {
                setBusy(cp.id);
                try {
                  await merchantApi.updateCoupon(cp.id, { active: v });
                  load();
                } catch (e) {
                  toast.error(merchantRefusal(e, lang, loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت')));
                } finally {
                  setBusy('');
                }
              }}
            />
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: loc('حذف الكوبون؟', 'Delete this coupon?', 'بسڕدرێتەوە؟'),
                  // OWNER: Sorani to be written by hand.
                  consequence: loc('الكوبون المستخدم من قبل يُوقف ولا يُمحى، لأن طلباتك تحمل رمزه.', 'A coupon that was already used is switched off, not erased — your orders carry its code.'),
                  confirmLabel: loc('حذف', 'Delete', 'سڕینەوە'),
                  cancelLabel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
                  destructive: true,
                });
                if (!ok) return;
                setBusy(cp.id);
                try {
                  await merchantApi.deleteCoupon(cp.id);
                  load();
                } catch (e) {
                  toast.error(merchantRefusal(e, lang, loc('تعذّر الحذف', 'Could not delete', 'نەسڕایەوە')));
                } finally {
                  setBusy('');
                }
              }}
              disabled={busy === cp.id}
              aria-label={loc('حذف الكوبون؟', 'Delete this coupon?', 'بسڕدرێتەوە؟')}
              className="w-11 h-11 rounded-lg border border-red-500/30 text-red-300 disabled:opacity-40 flex items-center justify-center shrink-0 self-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
      {confirmDialog}
    </div>
  );
}
