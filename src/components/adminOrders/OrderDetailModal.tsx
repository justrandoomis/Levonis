import React, { useCallback, useEffect, useRef, useState } from 'react';
import WarrantySection from '../adminWarranty/WarrantySection';
import { X, ChevronDown, MessageSquare, ClipboardList, Package, Receipt, ShieldCheck, Tag, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, formatIqd, type AdminOrderDetail } from '../../lib/api';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import { useMotion } from '../../lib/motion';
import Spinner from '../ui/Spinner';
import { Overlay } from '../ui/Overlay';
import { ErrorState } from '../ui/AsyncStates';
import CopyField from './CopyField';
import { collectOnDeliveryIqd } from './collectAmount';
import MysteryReveal from '../offers/MysteryReveal';
import OrderChatPanel from './OrderChatPanel';
import OrderStagePanel from './OrderStagePanel';
import GiniReceiptPanel from './GiniReceiptPanel';
import OrderStatusCorrection from './OrderStatusCorrection';

/**
 * The order fulfilment screen.
 *
 * The admin list showed an id, a customer, an item count, a total and a
 * status — nothing a person can prepare an order from. This is the screen
 * that answers "what am I packing, where is it going, and what do I write on
 * the receipt", with every value the admin has to retype elsewhere carrying
 * its own copy button.
 *
 * Two tabs in ONE modal: the order, and the conversation about the order.
 * Switching to the chat does not navigate away, so the address and the item
 * list are still there when the admin switches back.
 */
export default function OrderDetailModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { loc, lang, dir } = useLanguage();
  const m = useMotion();
  const [tab, setTab] = useState<'order' | 'stages' | 'chat'>('order');
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);

  // THE WINDOW OWNS ITS OWN CLOSING, so it can be seen leaving.
  //
  // The admin page mounts this component when a row is tapped and unmounts it
  // the instant `onClose` fires. Handing the parent's `onClose` straight to the
  // close button would therefore rip the window out of the DOM before any exit
  // could run — which is exactly the disappearing-to-nowhere this migration
  // exists to end. So the local `open` flag drives the primitive: closing flips
  // it to false, the panel plays the same path it arrived on in reverse, and
  // only then does the parent get told (which is also when it reloads the
  // list, so the refresh lands after the window is gone rather than under it).
  const [open, setOpen] = useState(true);
  const closing = useRef<number | null>(null);

  const close = useCallback(() => {
    if (closing.current != null) return; // a second tap must not queue a second unmount
    setOpen(false);
    // Long enough for the `sheet` spring the primitive uses at this placement,
    // and short enough that a reduced-motion cross-fade is not left waiting.
    closing.current = window.setTimeout(onClose, m.reduced ? 170 : 340);
  }, [onClose, m.reduced]);

  useEffect(
    () => () => {
      if (closing.current != null) window.clearTimeout(closing.current);
    },
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ order: AdminOrderDetail }>(`/api/admin/orders/${orderId}`);
      setDetail(data.order);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  // Escape closes — a modal that traps the admin on a busy day is worse than
  // no modal. The key listener that used to live here is deleted: `Overlay`
  // owns Escape for every window in the app, and two listeners on the same key
  // would have closed this one twice over.

  const addr = detail?.address ?? {};
  const govId = String(addr.governorate ?? '');
  const govLabel = govId ? GOVERNORATE_LABELS[govId]?.[lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'] ?? govId : '';
  const fin = detail?.financial;
  const collectIqd = collectOnDeliveryIqd(fin, detail?.total_iqd);

  // WHY `Overlay` AND NOT `Sheet`, AND WHY IT STILL RISES FROM THE BOTTOM EDGE.
  //
  // This is the owner's working surface: it is nearly full height, it scrolls
  // internally, and it holds a tab state that a stray gesture must not throw
  // away mid-shift. `Sheet` is the right primitive for something you flick
  // away, but its drag lives on the panel itself, so every downward swipe over
  // the item list or the chat would be arguing with the scroll underneath it,
  // and a lost argument would close the window the admin was reading. So:
  // `Overlay` at `placement="bottom"`, which keeps exactly the geometry this
  // window already had — full-bleed and rising from the bottom edge on a phone,
  // a centred card from `sm:` up — while the only way out stays deliberate
  // (the X, the scrim, Escape). `placement` is also why there is no hardcoded
  // slide direction here: the travel is along the vertical axis, which does not
  // mirror, so nothing has to be re-reasoned for Arabic.
  //
  // The portal that used to be written out by hand below now belongs to the
  // primitive, and for the same reason it was added: the admin page lives
  // inside a scrolling, transformed pane, under which `position: fixed` stops
  // meaning "the viewport" and this window was laid out far below the fold.
  //
  // The old markup carried `role="dialog"` and `aria-modal="true"` with no
  // accessible name at all — the primitive still supplies both, and the title
  // that was already on screen now names the window through `labelledBy`.
  return (
    <Overlay
      open={open}
      onClose={close}
      mode="modal"
      placement="bottom"
      labelledBy="order-detail-title"
      z={200}
      testId="order-detail"
      panelClassName="w-full sm:max-w-3xl h-[92vh] sm:h-[88vh] flex flex-col overflow-hidden"
    >
      <div data-order-modal className="flex flex-col flex-1 min-h-0">
        {/* ---------------------------------------------------------- header */}
        <div className="shrink-0 border-b border-zinc-800">
          <div className="flex items-center justify-between gap-3 p-4 pb-3">
            <div className="min-w-0">
              <h2 id="order-detail-title" className="text-white font-black text-lg truncate">
                {loc('تجهيز الطلب', 'Prepare order', 'ئامادەکردنی داواکاری')}
              </h2>
              <p className="text-[12px] font-mono text-zinc-500 truncate">{orderId}</p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={loc('إغلاق', 'Close', 'داخستن')}
              className="w-11 h-11 shrink-0 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex px-4 gap-1" role="tablist">
            {([
              ['order', ClipboardList, loc('معلومات الطلب', 'Order', 'زانیاری داواکاری')],
              ['stages', Truck, loc('المراحل', 'Stages', 'قۆناغەکان')],
              ['chat', MessageSquare, loc('المحادثة', 'Chat', 'گفتوگۆ')],
            ] as const).map(([id, Icon, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                data-order-tab={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 px-4 min-h-[44px] rounded-t-xl text-sm font-bold border-b-2 transition-colors ${
                  tab === id
                    ? 'text-white border-olive bg-zinc-900/60'
                    : 'text-zinc-500 border-transparent hover:text-zinc-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ----------------------------------------------------------- body */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner size="md" />
          </div>
        ) : error != null ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={load} />
          </div>
        ) : !detail ? null : tab === 'chat' ? (
          <OrderChatPanel orderId={orderId} active />
        ) : tab === 'stages' ? (
          <div className="flex-1 overflow-y-auto p-4 min-h-0 space-y-4">
            {/* THE GINI GATE, ABOVE THE PATH IT BLOCKS. The server refuses to
                move an unscanned Gini order across the stock boundary, so the
                buttons below would simply keep answering GINI_RECEIPT_REQUIRED
                until the barcode is recorded here. Null on every other payment
                method, so an ordinary order sees nothing extra. */}
            {detail.gini ? (
              <GiniReceiptPanel orderId={orderId} gini={detail.gini} dir={dir} onScanned={load} />
            ) : null}
            {detail.tracking ? (
              // Moving a stage reloads the whole detail, because the move
              // changes the available list, the history and the legacy
              // status underneath — refreshing only the panel would leave
              // the rest of the modal describing the previous state.
              <OrderStagePanel orderId={orderId} tracking={detail.tracking} dir={dir} onMoved={load} />
            ) : (
              // The tracking block is an enrichment and degrades like the
              // others: an honest note beats a 500 on the whole screen.
              <p className="text-zinc-400 text-sm">
                {loc('تعذّر تحميل مراحل هذا الطلب.', 'Stages could not be loaded for this order.', 'قۆناغەکان بار نەکران.')}
              </p>
            )}
            {/* The legacy status dropdown, demoted off the board's rows and
                placed UNDER the path it corrects — and it renders even when
                the tracking enrichment failed, because that is exactly when
                an admin has nothing else to move the order with. */}
            <OrderStatusCorrection orderId={orderId} status={detail.status} onChanged={load} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-6 min-h-0">
            {detail.priority === 1 && (
              <section data-pro-priority className="rounded-2xl border border-[#B03142]/40 bg-gradient-to-r from-[#B03142]/15 to-amber-500/[0.06] p-3.5">
                <div className="flex items-start gap-2.5">
                  <Truck className="mt-0.5 h-4.5 w-4.5 shrink-0 text-[#f3bdc5]" aria-hidden="true" />
                  <div>
                    <p className="text-[13px] font-black text-[#f3bdc5]">
                      {detail.fulfillment_service === 'pro_priority_12h'
                        ? loc('أولوية PRO — يجب إتمام الخدمة خلال 12 ساعة', 'PRO priority — service due within 12 hours', 'پێشینەیی PRO — خزمەت لە ١٢ کاتژمێردا')
                        : loc('أولوية تجهيز وتوصيل PRO', 'PRO preparation and delivery priority', 'پێشینەیی ئامادەکردن و گەیاندنی PRO')}
                    </p>
                    {detail.priority_due_at && (
                      <p className="mt-0.5 text-[11.5px] text-[#f3bdc5]/75">
                        {loc('الموعد الأقصى', 'Deadline', 'کۆتا کات')}: <time dateTime={detail.priority_due_at}>{new Date(detail.priority_due_at).toLocaleString()}</time>
                      </p>
                    )}
                  </div>
                </div>
              </section>
            )}
            {/* ------------------------------------------- what to write down */}
            <section>
              <h3 className="text-[13px] font-bold text-zinc-400 mb-2">
                {loc('المبلغ النهائي للوصل', 'Final amount for the receipt', 'کۆی کۆتایی بۆ پسوولە')}
              </h3>
              {/* THE FIGURE THE COURIER COLLECTS, not the order total (owner,
                  2026-09-25: «يجب أن يكون 1732992 بدلا من 1783000»). The total
                  still counts what the wallet (or Gini) already paid, so
                  copying it onto the receipt over-collected every part-prepaid
                  order. `due_on_delivery_iqd` is the stored door amount the
                  sticker, the receipt and the Telegram card already print; it
                  does not move when a collection is recorded, so the sheet
                  still reads right after delivery. Orders loaded without the
                  financial block fall back to the total. */}
              <CopyField
                label={loc('المتبقي عند التسليم', 'Outstanding on delivery', 'ماوە لە گەیاندن')}
                value={String(collectIqd)}
                emphasis
                mono
              />
              <p data-collect-note className="text-[12px] text-zinc-500 mt-1.5">
                {formatIqd(collectIqd)}
                {collectIqd !== detail.total_iqd && (
                  <>
                    {' · '}
                    {loc('الإجمالي', 'Total', 'کۆی گشتی')}: {formatIqd(detail.total_iqd)}
                  </>
                )}
                {fin && (fin.bnpl_due_iqd ?? 0) > 0 && (
                  <>
                    {' · '}
                    {loc('ممّول عبر BNPL', 'financed through BNPL', 'بە BNPL دارایی کراوە')}: {formatIqd(fin.bnpl_due_iqd ?? 0)}
                  </>
                )}
              </p>

              {/* The breakdown is collapsed by default: the number above is
                  what goes on the receipt, and everything below explains how
                  it got there. */}
              {fin && (
                <>
                  <button
                    type="button"
                    data-breakdown-toggle
                    aria-expanded={showBreakdown}
                    onClick={() => setShowBreakdown((v) => !v)}
                    className="mt-3 flex items-center gap-1.5 min-h-[44px] text-[13px] font-bold text-zinc-300 hover:text-white transition-colors"
                  >
                    <ChevronDown className={`w-4 h-4 transition-transform ${showBreakdown ? 'rotate-180' : ''}`} />
                    {loc('تفاصيل السعر', 'Price details', 'وردەکاری نرخ')}
                  </button>
                  {showBreakdown && (
                    <dl data-breakdown className="mt-2 rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
                      <Row label={loc('البضاعة', 'Merchandise', 'کاڵا')} value={formatIqd(fin.merchandise_iqd)} />
                      {fin.fees_iqd > 0 && (
                        <Row
                          label={loc('رسوم (زيادة البيع المباشر/شحن مسبق/ضمان)', 'Fees (direct-sale surcharge / transport / warranty)', 'کرێ (زیادەی فرۆشتنی ڕاستەوخۆ/گواستنەوە/گەرەنتی)')}
                          value={formatIqd(fin.fees_iqd)}
                        />
                      )}
                      <Row label={loc('المجموع الفرعي', 'Subtotal', 'کۆی بەشەکی')} value={formatIqd(fin.subtotal_iqd)} />
                      {fin.coupon_discount_iqd > 0 && (
                        <Row
                          label={`${loc('كوبون', 'Coupon', 'کۆپۆن')}${detail.coupon?.code ? ` (${detail.coupon.code})` : ''}`}
                          value={`− ${formatIqd(fin.coupon_discount_iqd)}`}
                          tone="down"
                        />
                      )}
                      {fin.points_used > 0 && (
                        <Row
                          label={`${loc('نقاط', 'Points', 'خاڵ')} (${fin.points_used})`}
                          value={`− ${formatIqd(fin.points_value_iqd)}`}
                          tone="down"
                        />
                      )}
                      <Row
                        label={loc('التوصيل', 'Delivery', 'گەیاندن')}
                        value={fin.delivery_waived ? loc('مجاني', 'waived', 'بەخۆڕایی') : formatIqd(fin.shipping_iqd)}
                      />
                      {fin.cod_tax_iqd > 0 && (
                        <Row
                          label={loc('ضريبة الدفع عند الاستلام', 'Cash on Delivery Tax', 'باجی پارەدان لە کاتی گەیاندن')}
                          value={formatIqd(fin.cod_tax_iqd)}
                        />
                      )}
                      {detail.membership_tier_snapshot && detail.membership_tier_snapshot !== 'free' && (
                        <Row
                          label={loc('العضوية وقت الطلب', 'Membership at order time', 'ئەندامێتی لە کاتی داواکاری')}
                          value={String(detail.membership_tier_snapshot).toUpperCase()}
                        />
                      )}
                      {fin.wallet_applied_iqd > 0 && (
                        <Row
                          label={loc('مدفوع من المحفظة', 'Paid from wallet', 'لە جزدان دراوە')}
                          value={`− ${formatIqd(fin.wallet_applied_iqd)}`}
                          tone="down"
                        />
                      )}
                      <Row label={loc('الإجمالي', 'Total', 'کۆی گشتی')} value={formatIqd(fin.total_iqd)} strong />
                      <Row
                        label={loc('المتبقي عند التسليم', 'Outstanding on delivery', 'ماوە لە گەیاندن')}
                        value={formatIqd(fin.outstanding_iqd)}
                        strong
                      />
                    </dl>
                  )}
                </>
              )}
            </section>

            {/* -------------------------------------------------- the customer */}
            <section>
              <h3 className="text-[13px] font-bold text-zinc-400 mb-2">
                {loc('العميل والعنوان', 'Customer and address', 'کڕیار و ناونیشان')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {/* The name copies ALONE — it goes in its own box on a courier form. */}
                <CopyField label={loc('الاسم', 'Name', 'ناو')} value={String(addr.name ?? detail.customer.name ?? '')} />
                <CopyField label={loc('الرقم', 'Phone', 'ژمارە')} value={String(addr.phone ?? '')} mono />
                <CopyField label={loc('المحافظة', 'Governorate', 'پارێزگا')} value={govLabel} />
                <CopyField label={loc('المنطقة', 'Area', 'ناوچە')} value={String(addr.area ?? '')} />
                <div className="sm:col-span-2">
                  <CopyField
                    label={loc('أقرب نقطة دالة', 'Nearest landmark', 'نزیکترین نیشانە')}
                    value={String(addr.landmark ?? '')}
                  />
                </div>
                <div className="sm:col-span-2">
                  <CopyField
                    label={loc('الملاحظات', 'Notes', 'تێبینی')}
                    value={String(addr.notes ?? '')}
                    multiline
                  />
                </div>
                {/* The original free-text line. Every address saved before
                    migration 0026 has ONLY this — nothing was parsed out of
                    it, because guessing would produce confident, wrong data
                    on a real parcel. */}
                {!!addr.address && (
                  <div className="sm:col-span-2">
                    <CopyField
                      label={loc('العنوان كما كتبه العميل', 'Address as the customer wrote it', 'ناونیشان وەک کڕیار نووسیویەتی')}
                      value={String(addr.address)}
                      multiline
                    />
                  </div>
                )}
              </div>
              {!govId && !addr.area && (
                <p className="text-[12px] text-amber-400/90 mt-2">
                  {loc(
                    'هذا العنوان محفوظ قبل فصل المحافظة والمنطقة — المتاح هو النص الكامل أعلاه. سيملأ العميل الحقول عند أول تعديل للعنوان.',
                    'This address was saved before the governorate and area were separate fields — the full text above is what exists. The customer fills them in the next time they edit it.',
                    'ئەم ناونیشانە پێش جیاکردنەوەی پارێزگا و ناوچە پاشەکەوت کراوە — دەقی تەواو لە سەرەوە ئەوەیە کە هەیە.'
                  )}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                {detail.customer.account_phone && (
                  <CopyField
                    label={loc('رقم الحساب (قد يختلف)', 'Account phone (may differ)', 'ژمارەی هەژمار')}
                    value={detail.customer.account_phone}
                    mono
                  />
                )}
                {detail.customer.email && (
                  <CopyField label={loc('البريد', 'Email', 'ئیمەیل')} value={detail.customer.email} />
                )}
              </div>
            </section>

            {/* ----------------------------------------------------- the goods */}
            <section>
              <h3 className="text-[13px] font-bold text-zinc-400 mb-2">
                {loc('المنتجات', 'Items', 'بەرهەمەکان')}
              </h3>
              {/* A membership gift is not a line: it costs the customer 0 IQD
                  and is a PACKING instruction, so it sits above the items
                  where whoever fills the box will read it. */}
              {detail.membership_gift && (
                <div
                  className="mb-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-emerald-300"
                  data-admin="order-gift"
                >
                  <p className="text-[12.5px] font-semibold">
                    {loc('يُرفَق مع الشحنة — هدية عضوية', 'Ships with the parcel — membership gift', 'لەگەڵ پاکەتەکە — دیاری ئەندامێتی')}
                  </p>
                  <p className="text-[12px] text-emerald-200/85 mt-0.5">
                    {detail.membership_gift.label_ar || detail.membership_gift.product_id}
                    {detail.membership_gift.qty > 1 && ` × ${detail.membership_gift.qty}`}
                  </p>
                </div>
              )}
              <ul className="space-y-2">
                {detail.items.map((it) => {
                  const units = detail.units.filter((u) => u.order_item_id === it.id);
                  return (
                    <li
                      key={it.id}
                      data-order-item
                      className="flex gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 min-w-0"
                    >
                      <div className="w-14 h-14 shrink-0 rounded-lg bg-black/50 overflow-hidden flex items-center justify-center">
                        {it.image ? (
                          <img src={it.image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <Package className="w-5 h-5 text-zinc-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-bold text-sm">{it.name}</p>
                        {/* The option and colour the customer actually chose —
                            the whole reason a picker exists. */}
                        {it.variant && <p className="text-[12px] text-olive-light mt-0.5">{it.variant}</p>}
                        <p className="text-[12px] text-zinc-400 mt-1">
                          <span className="font-bold text-white">×{it.qty}</span>
                          {' · '}
                          {formatIqd(it.unit_price_iqd)}
                          {' · '}
                          <span className="text-zinc-300">{formatIqd(it.line_total_iqd)}</span>
                        </p>
                        {units.length > 0 && (
                          <p className="text-[11px] text-zinc-500 mt-1">
                            {loc('وحدات مسلسلة', 'Serialized units', 'یەکە ژمارەدارەکان')}: {units.length}
                            {units.some((u) => u.serial) &&
                              ` — ${units.map((u) => u.serial).filter(Boolean).join(', ')}`}
                          </p>
                        )}
                        {/* THE BOX, AS THE PERSON PACKING IT SEES IT
                            (docs/BUNDLES_MYSTERY.md §6.3). A bundle's parts are
                            grouped UNDER their parent rather than listed as N
                            ungrouped zero-price rows: this is the screen staff
                            read while packing, and "one bundle" plus an
                            indented parts list is what is actually in the
                            carton. */}
                        {it.bundle && it.bundle.components.length > 0 && (
                          <ul className="mt-2 border-s-2 border-zinc-700 ps-3 space-y-1" data-order-bundle={it.id}>
                            {it.bundle.components.map((k) => (
                              <li key={k.order_item_id} className="text-[12px] text-zinc-300 flex items-baseline gap-2">
                                <span className="font-bold text-white tabular-nums shrink-0">×{k.qty}</span>
                                <span className="min-w-0 truncate">
                                  {k.name}
                                  {k.variant && <span className="text-olive-light"> · {k.variant}</span>}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {/* THE PICK, ON THE SCREEN STAFF READ WHEN PACKING
                            (§8.2). Admins see it from the first second, with a
                            "not yet revealed to the customer" chip — an
                            allocation that reached the API and stopped there
                            would leave the justification for admin access
                            unimplemented. */}
                        {it.mystery && (
                          <MysteryReveal mystery={it.mystery} cover={it.image} viewer="admin" />
                        )}
                      </div>
                      <div className="shrink-0 self-center text-2xl font-black text-white tabular-nums">
                        {it.qty}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* The warranty paper is issued PER DEVICE, so it sits directly
                under the goods it belongs to rather than in the print bar:
                each unit needs its serial typed before anything can be
                generated, and that is data entry, not printing. */}
            <WarrantySection orderId={orderId} />

            {detail.admin_note && (
              <section>
                <h3 className="text-[13px] font-bold text-zinc-400 mb-2">
                  {loc('ملاحظة الإدارة', 'Admin note', 'تێبینی بەڕێوەبەر')}
                </h3>
                <p className="text-sm text-zinc-300 whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                  {detail.admin_note}
                </p>
              </section>
            )}
          </div>
        )}

        {/* --------------------------------------------------- printing bar
            Opened in a NEW TAB with ?print=1, which fires the browser's own
            print dialog on load. That dialog is the only route a web page has
            to a printer — there is no API that opens a USB or network
            receipt printer directly — and the pages carry `@page` rules for
            the right roll, so the shop is not asked to pick A4 and scale it.

            Kept out of the chat tab: a print button beside a conversation is
            a mis-tap waiting to happen. */}
        {!loading && error == null && detail && tab === 'order' && (
          <div
            data-order-print-bar
            className="shrink-0 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 flex flex-wrap gap-2"
          >
            {([
              ['receipt', `/api/admin/orders/${orderId}/receipt?print=1`, Receipt,
                loc('وصل الشراء', 'Purchase receipt', 'پسوولەی کڕین'), false],
              ['warranty', `/api/admin/orders/${orderId}/warranty-receipt?print=1`, ShieldCheck,
                loc('وصل الضمان', 'Warranty receipt', 'پسوولەی گەرەنتی'), true],
              ['label', `/api/admin/orders/${orderId}/label?print=1`, Tag,
                loc('ستيكر التوصيل', 'Delivery label', 'ستیکەری گەیاندن'), false],
            ] as const).map(([id, href, Icon, label, deviceOnly]) => (
              <a
                key={id}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-print={id}
                // The warranty slip is offered on every order because whether
                // an order HAS warranted units is a server-side question the
                // panel cannot answer from what it was sent — and the route
                // refuses with a message rather than printing a blank form.
                title={deviceOnly ? loc('للأجهزة التي لها ضمان', 'For devices under warranty', 'بۆ ئامێرە گەرەنتیدارەکان') : undefined}
                className="inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-xl border border-zinc-700 bg-zinc-900 text-zinc-200 text-[13px] font-bold hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <Icon className="w-4 h-4" aria-hidden />
                {label}
              </a>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: 'down';
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 min-w-0">
      <dt className={`text-[13px] min-w-0 truncate ${strong ? 'text-white font-bold' : 'text-zinc-400'}`}>{label}</dt>
      <dd
        className={`text-[13px] shrink-0 tabular-nums ${
          tone === 'down' ? 'text-emerald-400' : strong ? 'text-white font-black' : 'text-zinc-200'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
