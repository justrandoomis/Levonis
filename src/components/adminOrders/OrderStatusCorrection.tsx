/**
 * THE LEGACY STATUS, DEMOTED — and this is where it belongs.
 *
 * This control used to sit on every row of the order board, next to the one
 * button the owner actually came for, on a list they scan with a thumb. The
 * page's own history records what that cost: «عند تحديث الطلب يظهر خيارين
 * فقط» — a mis-tap on a row dropdown moving an order nobody meant to move.
 * A destructive, irreversible-in-practice control has no business being the
 * widest thing on a scan-and-tap list.
 *
 * SO IT LIVES UNDER THE STAGE PANEL, which is already the authority for where
 * an order is. The stage panel is the ordinary way to move an order, drawn as
 * the whole path with only the legal moves offered; this is the CORRECTION
 * underneath it — the path that puts a `delivered` order back to `shipped`
 * after a mis-tap, which the stage graph does not offer as a forward move.
 *
 * THE SERVER STILL DECIDES. This list only chooses what the select OFFERS;
 * `ORDER_TRANSITIONS` in worker/routes/admin.ts decides what is accepted, and
 * a move it refuses comes back as its own sentence rather than a generic
 * failure.
 */
import { useState } from 'react';
import { api, ApiError, type OrderStatus } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/**
 * Mirrors ORDER_TRANSITIONS in worker/routes/admin.ts. It used to be a one-way
 * ratchet that gave `shipped` a single option and `delivered` none, so a
 * mis-tap could not be corrected at all — which is the whole reason this
 * control still exists beside the stage panel.
 */
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
  shipped: ['pending', 'confirmed', 'processing', 'delivered', 'cancelled'],
  delivered: ['shipped'],
  cancelled: ['pending', 'confirmed', 'processing'],
};

const STATUS_LABEL: Record<OrderStatus, { ar: string; en: string; ckb: string }> = {
  pending: { ar: 'قيد الانتظار', en: 'Pending', ckb: 'چاوەڕوان' },
  confirmed: { ar: 'مؤكد', en: 'Confirmed', ckb: 'پشتڕاستکراو' },
  processing: { ar: 'قيد التجهيز', en: 'Processing', ckb: 'ئامادەکردن' },
  shipped: { ar: 'تم الشحن', en: 'Shipped', ckb: 'نێردرا' },
  delivered: { ar: 'تم التسليم', en: 'Delivered', ckb: 'گەیەنرا' },
  cancelled: { ar: 'ملغى', en: 'Cancelled', ckb: 'هەڵوەشێنرا' },
};

export default function OrderStatusCorrection({
  orderId,
  status,
  onChanged,
}: {
  orderId: string;
  status: OrderStatus;
  onChanged: () => void | Promise<void>;
}) {
  const { loc } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const label = (st: OrderStatus) => {
    const entry = STATUS_LABEL[st];
    return entry ? loc(entry.ar, entry.en, entry.ckb) : st;
  };

  const next = ORDER_TRANSITIONS[status] ?? [];
  if (next.length === 0) return null;

  const change = async (to: OrderStatus) => {
    if (busy) return;
    if (to === 'cancelled') {
      const ok = window.confirm(
        loc(
          `هل أنت متأكد من إلغاء الطلب ${orderId}؟ سيتم إرجاع المبالغ المدفوعة تلقائياً.`,
          `Cancel order ${orderId}? Any wallet/points applied will be refunded automatically.`,
          `دڵنیایت لە هەڵوەشاندنەوەی ${orderId}؟ بڕە دراوەکان خۆکارانە دەگەڕێنەوە.`
        )
      );
      if (!ok) return;
    }
    // Backing out of a delivered order does not un-grant what delivery
    // granted. The server says so in its response; asking first is fairer.
    if (status === 'delivered') {
      const ok = window.confirm(
        loc(
          `إرجاع الطلب ${orderId} من «تم التسليم»؟ النقاط الممنوحة وسجلات الأجهزة وتواريخ بدء الضمان لا تُلغى.`,
          `Move order ${orderId} back from delivered? Points already awarded, device records and warranty start dates are NOT reversed.`,
          `داواکاری ${orderId} لە «گەیەنراوە» بگەڕێنیتەوە؟ خاڵە بەخشراوەکان و تۆمارەکانی ئامێر هەڵناوەشێنرێنەوە.`
        )
      );
      if (!ok) return;
    }
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await api.patch<{ stock_note?: string; reversal_note?: string }>(
        `/api/admin/orders/${orderId}`,
        { status: to }
      );
      // What the move did to stock, and what a reversal did NOT undo. Both are
      // the server's own sentences and neither is worth swallowing.
      if (res.stock_note || res.reversal_note) {
        setNote([res.stock_note, res.reversal_note].filter(Boolean).join(' · '));
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر تحديث الحالة', 'Failed to update the status', 'دۆخ نوێ نەکرایەوە'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-order-status-correction className="space-y-2 rounded-xl border border-border-subtle bg-surface p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] leading-[1.5] font-bold text-text-primary">
          {loc('تصحيح الحالة', 'Correct the status', 'ڕاستکردنەوەی دۆخ')}
        </h3>
        <p className="text-[11px] leading-[1.5] text-text-muted">
          {loc('الحالة الآن', 'Now', 'ئێستا')}: {label(status)}
        </p>
      </div>

      <p className="text-[11.5px] leading-[1.6] text-text-muted">
        {loc(
          'المراحل أعلاه هي الطريق المعتاد. استخدم هذا فقط لتصحيح خطأ.',
          'The stages above are the ordinary route. Use this only to correct a mistake.',
          'قۆناغەکانی سەرەوە ڕێگای ئاساییە. ئەمە تەنها بۆ ڕاستکردنەوەی هەڵەیە.'
        )}
      </p>

      {error && (
        <p role="alert" className="lv-alert lv-alert-danger text-[12px] leading-[1.6] text-text-primary">
          {error}
        </p>
      )}
      {note && <p className="lv-alert lv-alert-warning text-[12px] leading-[1.6] text-text-primary">{note}</p>}

      <select
        value=""
        disabled={busy}
        data-order-status-select={orderId}
        aria-label={loc('تغيير حالة الطلب', 'Change the order status', 'گۆڕینی دۆخی داواکاری')}
        onChange={(e) => {
          const to = e.target.value as OrderStatus;
          if (to) void change(to);
          e.target.value = '';
        }}
        className="lv-input w-full text-[14px] leading-[1.4]"
      >
        <option value="" disabled>
          {busy ? loc('جارٍ الحفظ...', 'Saving...', 'پاشەکەوت دەکرێت...') : loc('تغيير إلى...', 'Move to...', 'بیگۆڕە بۆ...')}
        </option>
        {next.map((st) => (
          <option key={st} value={st}>
            {label(st)}
          </option>
        ))}
      </select>
    </section>
  );
}
