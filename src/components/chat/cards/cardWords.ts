/**
 * THE WORDS A CARD SAYS — its status, the event a system card records, how a
 * job is handed over. One place, so the same state reads the same way on every
 * card and in the orders panel. Arabic and English; Sorani is written by hand
 * (the `loc` fallback shows the Arabic until then).
 *
 * OWNER: Sorani to be written by hand for every sentence in this file.
 */
import type { ChatCard } from '../../../lib/chatCards';

type Loc = (ar: string, en: string, ckb?: string) => string;

/** «بانتظار ردّك» / «بانتظار الزبون»: a status is said from the reader's side. */
export function statusText(type: ChatCard['type'], status: string, loc: Loc, side: 'customer' | 'merchant' | 'other'): string {
  const mine = side === 'customer';
  switch (type) {
    case 'quote':
      return (
        {
          pending: mine ? loc('بانتظار ردّك', 'Waiting for your answer') : loc('بانتظار ردّ الزبون', 'Waiting for the customer'),
          accepted: loc('مقبول — المبلغ في الضمان', 'Accepted — the money is held'),
          declined: loc('مرفوض', 'Declined'),
          withdrawn: loc('سُحب', 'Withdrawn'),
          expired: loc('انتهت صلاحيته', 'Expired'),
          superseded: mine ? loc('بانتظار تأكيد المتجر بعد تعديلك', 'Waiting for the store to re-confirm') : loc('عدّل الزبون الطلب — أكّد عرضك أو عدّله', 'The customer changed the job — re-confirm or edit'),
          changed: loc('حُدِّث هذا العرض — انظر الأحدث', 'This quote was updated — see the latest'),
          closed: loc('الطلب لم يعد يستقبل عروضًا', 'The request no longer takes quotes'),
        } as Record<string, string>
      )[status] ?? '';
    case 'print_request':
      return (
        {
          open: mine ? loc('أُرسل للمتجر — بانتظار عرض السعر', 'Sent — waiting for a quote') : loc('بانتظار عرض سعرك', 'Waiting for your quote'),
          receiving_offers: mine ? loc('وصلك عرض سعر', 'You have a quote') : loc('أرسلت عرضًا', 'You sent a quote'),
          in_progress: loc('قيد التنفيذ', 'In progress'),
          completed: loc('مكتمل', 'Completed'),
          cancelled: loc('أُلغي', 'Cancelled'),
          expired: loc('انتهت مدته', 'Expired'),
          disputed: loc('نزاع مفتوح', 'In dispute'),
          draft: loc('مسودة', 'Draft'),
        } as Record<string, string>
      )[status] ?? '';
    case 'custom_product':
      return (
        {
          available: mine ? loc('متاح لك وحدك', 'Available to you only') : loc('بانتظار شراء الزبون', 'Waiting for the customer to buy'),
          purchased: loc('تم الشراء', 'Bought'),
          cancelled: loc('ألغاه المتجر', 'Cancelled by the store'),
          expired: loc('انتهت صلاحيته', 'Expired'),
          unavailable: loc('غير متاح', 'Not available'),
        } as Record<string, string>
      )[status] ?? '';
    case 'order':
      return (
        {
          pending: loc('بانتظار تأكيد المتجر', 'Waiting for the store to confirm'),
          confirmed: loc('أكّده المتجر', 'Confirmed by the store'),
          processing: loc('قيد التجهيز', 'Being prepared'),
          shipped: loc('شُحن', 'Shipped'),
          delivered: loc('وصل', 'Delivered'),
          cancelled: loc('أُلغي وأُعيد المبلغ', 'Cancelled and refunded'),
        } as Record<string, string>
      )[status] ?? '';
    case 'custom_order':
      return (
        {
          funded: loc('المبلغ في الضمان — لم يبدأ التنفيذ', 'Money held — work not started'),
          in_progress: loc('قيد التنفيذ', 'In progress'),
          merchant_marked_delivered: mine ? loc('سُلِّم — أكّد الاستلام', 'Delivered — confirm receipt') : loc('سُلِّم — بانتظار تأكيد الزبون', 'Delivered — waiting for the customer'),
          customer_confirmed: loc('أكّد الزبون الاستلام', 'Confirmed by the customer'),
          completed: loc('مكتمل — أُفرج عن المبلغ', 'Completed — money released'),
          disputed: loc('نزاع — المبلغ مجمّد', 'Disputed — money frozen'),
          refunded: loc('أُعيد المبلغ للزبون', 'Refunded to the customer'),
          cancelled: loc('أُلغي وأُعيد المبلغ', 'Cancelled and refunded'),
        } as Record<string, string>
      )[status] ?? '';
    default:
      return '';
  }
}

/** A system card's sentence: what just happened, in words. Null = say the plain fallback. */
export function eventText(card: ChatCard | null, loc: Loc): string | null {
  if (!card) return null;
  const e = String(card.original.event ?? '');
  if (card.type === 'custom_order') {
    return (
      {
        funded: loc('قُبل العرض وحُجز المبلغ في الضمان', 'Quote accepted — the money is held in escrow'),
        started: loc('بدأ المتجر العمل على الطلب', 'The store started the work'),
        delivered: loc('سلّم المتجر الطلب — بانتظار تأكيد الاستلام', 'The store delivered — waiting for confirmation'),
        confirmed: loc('أكّد الزبون الاستلام', 'The customer confirmed receipt'),
        completed: loc('اكتمل الطلب وأُفرج عن المبلغ للمتجر', 'Order completed — the money was released to the store'),
        disputed: loc('فُتح نزاع — المبلغ مجمّد حتى يقرّر فريق Levonis', 'A dispute was opened — the money is frozen until Levonis decides'),
        refunded: loc('قرّر فريق Levonis إعادة المبلغ للزبون', 'Levonis decided to refund the customer'),
        cancelled: loc('أُلغي الطلب وأُعيد المبلغ', 'The order was cancelled and refunded'),
        // The order timeline's updates (0160, POST /orders/:id/updates) — one card each, in
        // all three languages (D6; review 2026-09-30), in the notices' own Sorani words.
        progress: loc('أضاف المتجر تحديثًا على التنفيذ', 'The store posted a progress update', 'فرۆشگاکە نوێکردنەوەیەکی لەسەر جێبەجێکردنەکە دانا'),
        photo: loc('أرسل المتجر صورة من التنفيذ', 'The store shared a photo of the work', 'فرۆشگاکە وێنەیەکی کارەکەی نارد'),
        ready: loc('الطلب جاهز للتسليم', 'The order is ready for handover', 'داواکارییەکە ئامادەیە بۆ ڕادەستکردن'),
        note: loc('أضاف المتجر ملاحظة على الطلب', 'The store added a note to the order', 'فرۆشگاکە تێبینییەکی لەسەر داواکارییەکە زیاد کرد'),
        modification_request: loc('طلب الزبون تعديلًا على الطلب', 'The customer asked for a change', 'کڕیارەکە داوای گۆڕانکاری لە داواکارییەکە کرد'),
      } as Record<string, string>
    )[e] ?? null;
  }
  if (card.type === 'order') {
    return (
      {
        placed: loc('تم إنشاء الطلب ودُفع من المحفظة', 'Order placed and paid from the wallet'),
        confirmed: loc('أكّد المتجر الطلب', 'The store confirmed the order'),
        processing: loc('المتجر يجهّز الطلب', 'The store is preparing the order'),
        shipped: loc('شُحن الطلب', 'The order was shipped'),
        delivered: loc('وصل الطلب — أكّد الاستلام', 'The order arrived — confirm receipt'),
        received: loc('أكّد الزبون استلام الطلب', 'The customer confirmed receipt'),
        cancelled: loc('أُلغي الطلب وأُعيد المبلغ للمحفظة', 'The order was cancelled and refunded to the wallet'),
      } as Record<string, string>
    )[e] ?? null;
  }
  return null;
}

/** How a job is handed over (worker/lib/requestRevisions.ts OFFER_DELIVERY_METHODS). */
export function deliveryText(method: unknown, loc: Loc): string {
  return (
    {
      merchant_delivery: loc('توصيل من المتجر', 'Delivered by the store'),
      courier: loc('شركة توصيل', 'By courier'),
      pickup: loc('استلام من المتجر', 'Pickup from the store'),
    } as Record<string, string>
  )[String(method ?? '')] ?? '';
}

/** «٣ أيام» / «3 days» — a count of days, singular and plural handled plainly. */
export function daysText(n: number, loc: Loc): string {
  const d = Math.max(0, Math.round(n));
  if (d === 0) return loc('جاهز فورًا', 'Ready now');
  if (d === 1) return loc('يوم واحد', '1 day');
  if (d === 2) return loc('يومان', '2 days');
  if (d <= 10) return loc(`${d} أيام`, `${d} days`);
  return loc(`${d} يومًا`, `${d} days`);
}
