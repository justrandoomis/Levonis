import React, { useCallback, useEffect, useState } from 'react';
import WarrantySection from '../adminWarranty/WarrantySection';
import { createPortal } from 'react-dom';
import { X, ChevronDown, MessageSquare, ClipboardList, Package, Receipt, ShieldCheck, Tag, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, formatIqd, type AdminOrderDetail } from '../../lib/api';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import Spinner from '../ui/Spinner';
import { ErrorState } from '../ui/AsyncStates';
import CopyField from './CopyField';
import OrderChatPanel from './OrderChatPanel';
import OrderStagePanel from './OrderStagePanel';

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
  const [tab, setTab] = useState<'order' | 'stages' | 'chat'>('order');
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);

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
  // no modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addr = detail?.address ?? {};
  const govId = String(addr.governorate ?? '');
  const govLabel = govId ? GOVERNORATE_LABELS[govId]?.[lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'] ?? govId : '';
  const fin = detail?.financial;

  // RENDERED INTO document.body, NOT WHERE IT SITS IN THE TREE.
  //
  // The admin page lives inside a scrolling pane, and `position: fixed` stops
  // meaning "the viewport" the moment any ancestor establishes a containing
  // block (a transform, a filter, a backdrop-filter, `contain`). It did: the
  // modal was laid out relative to that pane instead, so it opened far below
  // the fold and the owner had to scroll to find it. A portal takes the modal
  // out of that subtree entirely, which also escapes the pane's
  // `overflow: hidden`. This is the fix rather than hunting the one offending
  // ancestor, because the next ancestor to grow a transform would break it
  // again.
  const overlay = (
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-order-modal
        dir={dir}
        className="bg-zinc-950 border border-zinc-800 w-full sm:max-w-3xl h-[92vh] sm:h-[88vh] sm:rounded-3xl rounded-t-3xl flex flex-col overflow-hidden shadow-2xl"
      >
        {/* ---------------------------------------------------------- header */}
        <div className="shrink-0 border-b border-zinc-800">
          <div className="flex items-center justify-between gap-3 p-4 pb-3">
            <div className="min-w-0">
              <h2 className="text-white font-black text-lg truncate">
                {loc('تجهيز الطلب', 'Prepare order', 'ئامادەکردنی داواکاری')}
              </h2>
              <p className="text-[12px] font-mono text-zinc-500 truncate">{orderId}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
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
          <div className="flex-1 overflow-y-auto p-4 min-h-0">
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
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-6 min-h-0">
            {/* ------------------------------------------- what to write down */}
            <section>
              <h3 className="text-[13px] font-bold text-zinc-400 mb-2">
                {loc('المبلغ النهائي للوصل', 'Final amount for the receipt', 'کۆی کۆتایی بۆ پسوولە')}
              </h3>
              <CopyField
                label={loc('الإجمالي بعد كل الخصومات', 'Total after every discount', 'کۆی گشتی دوای هەموو داشکاندنێک')}
                value={String(detail.total_iqd)}
                emphasis
                mono
              />
              <p className="text-[12px] text-zinc-500 mt-1.5">
                {formatIqd(detail.total_iqd)}
                {fin && fin.due_on_delivery_iqd !== detail.total_iqd && (
                  <>
                    {' · '}
                    {loc('يُحصَّل عند التسليم', 'due on delivery', 'لە کاتی گەیاندن')}: {formatIqd(fin.due_on_delivery_iqd)}
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
                          label={loc('رسوم (شحن مسبق/ضمان)', 'Fees (transport / warranty)', 'کرێ (گواستنەوە/گەرەنتی)')}
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
    </div>
  );

  return createPortal(overlay, document.body);
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
