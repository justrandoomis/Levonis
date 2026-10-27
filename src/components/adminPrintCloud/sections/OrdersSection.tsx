/**
 * ORDERS AND PAYMENTS — a money section end to end (every route needs a full
 * admin; AdminPrintCloud hides the section from anyone else).
 *
 *   Orders          `GET /orders` (status filter; the server returns the 500
 *                   newest and this screen pages them) and one order's whole
 *                   record (`GET /orders/{id}`): lines, payments, refunds.
 *   Manual payment  `POST /orders/{id}/confirm-payment` — a cash or transfer
 *                   receipt: amount and reference. NO Idempotency-Key: the
 *                   receipt (order, amount, reference) is the event id, so the
 *                   same receipt entered twice is recorded once and says so.
 *                   The server takes no payment method field — the provider
 *                   of this door is always `manual`.
 *   Cancel          `POST /orders/{id}/cancel` — an unpaid order only; its
 *                   stock holds go back on the shelf.
 *   Refunds         `POST /orders/{id}/refunds` — one line at a time, planned
 *                   on screen and confirmed, with an Idempotency-Key minted
 *                   per plan and reused by every retry of it (a changed plan
 *                   is a new key). There is no dry run on the server: the
 *                   amount, when left empty, is computed by the server (the
 *                   value of what is taken back, capped at what is left on the
 *                   line) and shown after it is recorded. An order paid from
 *                   the customer's Levonis wallet is refunded INTO that wallet
 *                   by the server in the same batch — no method is sent.
 *   Payment events  `GET /payment-events` — every confirmation the system
 *                   received, once per provider event, wallet payments
 *                   (`levonis_wallet`) included.
 */
import { useMemo, useState } from 'react';
import { CreditCard, Receipt } from 'lucide-react';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { StatusChip, type Tone } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { toast } from '../../../lib/toastStore';
import { iqdUnit } from '../../../lib/money';
import { enc, newIdempotencyKey, pc, query, type OrderDetail, type OrderLine, type OrderRow, type PaymentEvent, type PaymentResult } from '../api';
import { LINE_KIND, ORDER_KIND, ORDER_STATUS, PAYMENT_OUTCOME, PAYMENT_STATUS, PROVIDER, REFUND_STATUS, labelOf, tri, type Tri } from '../i18n';
import { duration, formatDateTime, num, qty } from '../format';
import { pcRefusal } from '../refusal';
import { useRefs, type RefLists } from '../refs';
import { Act, Chips, Id, IntField, Json, KV, LoadState, Note, Pager, type PcColumn, PcList, RefreshButton, SectionHead, SelectField, T, TextArea, TextField, Tray, useLoad, usePaged, usePcLang, W } from '../ui';
import { DurationInput } from './catalog/fieldInputs';
import type { Go, SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('الطلبات والمدفوعات', 'Orders and payments', 'داواکاری و پارەدان'),
  desc: tri(
    'طلبات الساعات والمواد ورسوم التوصيل، ودفعاتها واستردادها. كل مبلغ هنا من الخادم.',
    'Orders of hours, materials and delivery fees, with their payments and refunds. Every amount here is the server’s.',
    'داواکارییەکانی کاتژمێر و کەرەستە و کرێی گەیاندن، لەگەڵ پارەدان و گەڕاندنەوەکانیان. هەموو بڕێک لێرە هی ڕاژەکارە.'
  ),
  view: tri('العرض', 'View', 'پیشاندان'),
  orders: tri('الطلبات', 'Orders', 'داواکارییەکان'),
  events: tri('أحداث الدفع', 'Payment events', 'ڕووداوەکانی پارەدان'),
  status: tri('الحالة', 'State', 'دۆخ'),
  all: tri('الكل', 'All', 'هەموو'),
  search: tri('بحث برقم الطلب أو معرّف العميل', 'Search by order or customer id', 'گەڕان بە ژمارەی داواکاری یان ناسنامەی کڕیار'),
  cap: tri('أحدث 500 طلب في هذه الحالة.', 'The 500 newest orders in this state.', '500 نوێترین داواکاری لەم دۆخەدا.'),
  empty: tri('لا طلبات هنا.', 'No orders here.', 'هیچ داواکارییەک لێرە نییە.'),
  order: tri('الطلب', 'Order', 'داواکاری'),
  kind: tri('النوع', 'Kind', 'جۆر'),
  total: tri('المجموع', 'Total', 'کۆ'),
  paid: tri('المدفوع', 'Paid', 'دراو'),
  refunded: tri('المسترد', 'Refunded', 'گەڕێنراوە'),
  method: tri('طريقة الدفع', 'Payment method', 'شێوازی پارەدان'),
  created: tri('أُنشئ', 'Created', 'دروستکرا'),
  paidAt: tri('دُفع في', 'Paid at', 'پارەی درا لە'),
  fulfilledAt: tri('نُفّذ في', 'Fulfilled at', 'جێبەجێکرا لە'),
  holdUntil: tri('المخزون محجوز حتى', 'Stock held until', 'کۆگا گیراوە تا'),
  subtotal: tri('قبل الخصم', 'Before discount', 'پێش داشکاندن'),
  discount: tri('الخصم', 'Discount', 'داشکاندن'),
  shipment: tri('الشحنة', 'Shipment', 'ناردن'),
  promotions: tri('العروض المطبّقة', 'Promotions applied', 'ئۆفەرە جێبەجێکراوەکان'),
  address: tri('عنوان التوصيل', 'Delivery address', 'ناونیشانی گەیاندن'),
  openCustomer: tri('فتح العميل', 'Open the customer', 'کردنەوەی کڕیار'),
  openShipment: tri('فتح الشحنات', 'Open shipments', 'کردنەوەی ناردنەکان'),
  lines: tri('البنود', 'Lines', 'بەندەکان'),
  linePrice: tri('السعر النهائي', 'Final price', 'نرخی کۆتایی'),
  lineLeft: tri('المتبقي للاسترداد', 'Left to refund', 'ماوە بۆ گەڕاندنەوە'),
  fulfilment: tri('التنفيذ', 'Fulfilment', 'جێبەجێکردن'),
  expires: tri('تنتهي بعد', 'Expires after', 'بەسەردەچێت دوای'),
  days: tri('يوماً', 'days', 'ڕۆژ'),
  payments: tri('الدفعات', 'Payments', 'پارەدانەکان'),
  noPayments: tri('لا دفعات بعد.', 'No payments yet.', 'هێشتا هیچ پارەدانێک نییە.'),
  refunds: tri('الاستردادات', 'Refunds', 'گەڕاندنەوەکان'),
  noRefunds: tri('لا استردادات.', 'No refunds.', 'هیچ گەڕاندنەوەیەک نییە.'),
  walletPaid: tri(
    'دُفع هذا الطلب من محفظة العميل في Levonis: أي استرداد يُعيد الدنانير إلى تلك المحفظة في الخطوة نفسها.',
    'This order was paid from the customer’s Levonis wallet: a refund returns the dinars to that wallet in the same step.',
    'ئەم داواکارییە لە جزدانی Levonis ی کڕیار پارەی دراوە: هەر گەڕاندنەوەیەک دینارەکان لە هەمان هەنگاودا بۆ ئەو جزدانە دەگەڕێنێتەوە.'
  ),
  walletPending: tri(
    'اختار العميل الدفع من محفظته في Levonis. أكّد إيصالاً يدوياً فقط إن دفع لك مباشرة.',
    'The customer chose to pay from their Levonis wallet. Confirm a manual receipt only if they paid you directly.',
    'کڕیار پارەدان لە جزدانی Levonis ی هەڵبژارد. تەنها ئەگەر ڕاستەوخۆ پارەی پێدایت پسوولەیەکی دەستی پشتڕاست بکەرەوە.'
  ),
  // manual payment
  confirmPayment: tri('تأكيد دفعة يدوية', 'Confirm a manual payment', 'پشتڕاستکردنەوەی پارەدانێکی دەستی'),
  paymentHelp: tri(
    'إيصال نقد أو تحويل بحوزة الورشة. المبلغ يجب أن يساوي مجموع الطلب، والمرجع رقم الإيصال أو التحويل. الإيصال نفسه إن أُدخل مرتين يُسجَّل مرة واحدة.',
    'A cash or transfer receipt the workshop holds. The amount must equal the order total; the reference is the receipt or transfer number. The same receipt entered twice is recorded once.',
    'پسوولەیەکی نەقد یان گواستنەوە کە لای کارگەیە. بڕەکە دەبێت یەکسان بێت بە کۆی داواکاری؛ سەرچاوە ژمارەی پسوولە یان گواستنەوەکەیە. هەمان پسوولە ئەگەر دوو جار بنووسرێت یەک جار تۆمار دەکرێت.'
  ),
  amount: tri('المبلغ', 'Amount', 'بڕ'),
  reference: tri('المرجع (رقم الإيصال أو التحويل)', 'Reference (receipt or transfer number)', 'سەرچاوە (ژمارەی پسوولە یان گواستنەوە)'),
  amountDiffers: tri('المبلغ لا يساوي مجموع الطلب — سيُسجَّل ولن يُطبَّق.', 'The amount differs from the order total — it will be recorded, not applied.', 'بڕەکە یەکسان نییە بە کۆی داواکاری — تۆمار دەکرێت بەڵام جێبەجێ ناکرێت.'),
  recordPayment: tri('تسجيل الدفعة', 'Record the payment', 'تۆمارکردنی پارەدان'),
  paymentAsk: tri('تسجيل هذه الدفعة؟', 'Record this payment?', 'ئەم پارەدانە تۆمار بکرێت؟'),
  paymentConsequence: tri('إن طابقت المجموعَ يُنفَّذ الطلب فوراً: تُضاف الساعات أو المواد إلى رصيد العميل.', 'If it matches the total the order is fulfilled at once: the hours or materials go to the customer’s balance.', 'ئەگەر لەگەڵ کۆکەدا بگونجێت داواکارییەکە یەکسەر جێبەجێ دەکرێت: کاتژمێر یان کەرەستەکان دەچنە باڵانسی کڕیار.'),
  outcome: tri('النتيجة', 'Outcome', 'ئەنجام'),
  previously: tri('سُجّل من قبل بمبلغ', 'Recorded before with the amount', 'پێشتر تۆمارکرابوو بە بڕی'),
  // cancel
  cancel: tri('إلغاء الطلب غير المدفوع', 'Cancel the unpaid order', 'هەڵوەشاندنەوەی داواکاریی پارە نەدراو'),
  cancelAsk: tri('إلغاء هذا الطلب؟', 'Cancel this order?', 'ئەم داواکارییە هەڵبوەشێنرێتەوە؟'),
  cancelConsequence: tri('يُغلق الطلب ويعود المخزون المحجوز له إلى الرف. لا يمكن التراجع.', 'The order closes and the stock it held goes back on the shelf. This cannot be undone.', 'داواکارییەکە دادەخرێت و ئەو کۆگایەی بۆی گیرابوو دەگەڕێتەوە سەر ڕەف. ناگەڕێتەوە.'),
  cancelled: tri('أُلغي الطلب.', 'The order was cancelled.', 'داواکارییەکە هەڵوەشێنرایەوە.'),
  // refunds
  refund: tri('استرداد', 'Refund', 'گەڕاندنەوە'),
  refundTitle: tri('استرداد بند', 'Refund a line', 'گەڕاندنەوەی بەندێک'),
  refundHelp: tri(
    'يُسترد بند واحد في كل مرة: تُسحب الساعات أو المواد غير المستعملة من رصيد العميل ويُسجَّل المبلغ. لا يُسترد ما استُهلك أو حُجز لمهمة.',
    'One line at a time: the unused hours or materials are taken back from the customer’s balance and the amount is recorded. What was used, or is held for a job, cannot be refunded.',
    'هەر جارە بەندێک: کاتژمێر یان کەرەستە بەکارنەهاتووەکان لە باڵانسی کڕیار دەگیرێنەوە و بڕەکە تۆمار دەکرێت. ئەوەی بەکارهاتووە یان بۆ کارێک گیراوە ناگەڕێنرێتەوە.'
  ),
  line: tri('البند', 'Line', 'بەند'),
  takeBackSeconds: tri('الساعات المسحوبة (فارغ = كل غير المستعمل الآن)', 'Hours taken back (empty = all unused now)', 'ئەو کاتژمێرانەی دەگیرێنەوە (بەتاڵ = هەموو بەکارنەهاتووەکانی ئێستا)'),
  takeBackQty: tri('الكمية المسحوبة (فارغ = كل غير المستعمل الآن)', 'Quantity taken back (empty = all unused now)', 'ئەو بڕەی دەگیرێتەوە (بەتاڵ = هەموو بەکارنەهاتووەکانی ئێستا)'),
  refundAmount: tri('المبلغ المسترد (فارغ = يحسبه الخادم)', 'Amount refunded (empty = the server computes it)', 'بڕی گەڕێنراوە (بەتاڵ = ڕاژەکار دەیژمێرێت)'),
  refundAmountHint: tri('يحسب الخادم قيمة ما يُسحب بسعر شرائه، ولا يتجاوز المتبقي في البند.', 'The server values what is taken back at its purchase price, never beyond what is left on the line.', 'ڕاژەکار بەهای ئەوەی دەگیرێتەوە بە نرخی کڕینەکەی دەژمێرێت، هەرگیز زیاتر لەوەی لە بەندەکەدا ماوە نا.'),
  refundMethod: tri('كيف يعود المال', 'How the money goes back', 'پارەکە چۆن دەگەڕێتەوە'),
  methodManual: tri('يدوياً — نقداً أو تحويلاً خارج النظام', 'By hand — cash or transfer outside the system', 'بە دەست — نەقد یان گواستنەوە لە دەرەوەی سیستەم'),
  methodGateway: tri('عبر بوابة الدفع', 'Through the payment gateway', 'لە ڕێگەی دەروازەی پارەدان'),
  methodWallet: tri('إلى محفظة العميل في Levonis (تلقائياً)', 'To the customer’s Levonis wallet (automatic)', 'بۆ جزدانی Levonis ی کڕیار (خۆکارانە)'),
  plan: tri('مراجعة الاسترداد', 'Review the refund', 'پێداچوونەوەی گەڕاندنەوە'),
  planTitle: tri('ما سيحدث', 'What will happen', 'ئەوەی ڕوودەدات'),
  planTake: tri('يُسحب من رصيد العميل', 'Taken back from the customer’s balance', 'لە باڵانسی کڕیار دەگیرێتەوە'),
  planAllUnused: tri('كل غير المستعمل الآن', 'All that is unused now', 'هەموو ئەوەی ئێستا بەکارنەهاتووە'),
  planAmount: tri('المبلغ', 'Amount', 'بڕ'),
  planComputed: tri('يحسبه الخادم ويظهر بعد التسجيل', 'Computed by the server, shown once recorded', 'ڕاژەکار دەیژمێرێت، دوای تۆمارکردن دەردەکەوێت'),
  planNothingTaken: tri('لا شيء يُسحب: بند رسوم', 'Nothing is taken back: a fee line', 'هیچ شتێک ناگیرێتەوە: بەندی کرێ'),
  confirmRefund: tri('تأكيد الاسترداد', 'Confirm the refund', 'پشتڕاستکردنەوەی گەڕاندنەوە'),
  editPlan: tri('تعديل', 'Change', 'گۆڕین'),
  refundAsk: tri('تسجيل هذا الاسترداد؟', 'Record this refund?', 'ئەم گەڕاندنەوەیە تۆمار بکرێت؟'),
  refundConsequence: tri('يُسجَّل نهائياً ويُسحب ما ذُكر من رصيد العميل.', 'It is recorded for good and what is stated is taken from the customer’s balance.', 'بە یەکجاری تۆمار دەکرێت و ئەوەی گوترا لە باڵانسی کڕیار دەگیرێتەوە.'),
  refundDone: tri('سُجّل الاسترداد', 'The refund is recorded', 'گەڕاندنەوەکە تۆمارکرا'),
  replayed: tri('(كان مسجّلاً من قبل — لم يتكرر)', '(it was already recorded — not repeated)', '(پێشتر تۆمارکرابوو — دووبارە نەکرایەوە)'),
  reasonNeeded: tri('اذكر السبب.', 'State the reason.', 'هۆکارەکە بنووسە.'),
  lineNeeded: tri('اختر بنداً.', 'Choose a line.', 'بەندێک هەڵبژێرە.'),
  noRefundable: tri('لا بند متبقٍّ للاسترداد في هذا الطلب.', 'No line of this order has anything left to refund.', 'هیچ بەندێکی ئەم داواکارییە شتێکی بۆ گەڕاندنەوە نەماوە.'),
  refundOnlyFulfilled: tri('الاسترداد للطلبات المنفَّذة فقط.', 'Only fulfilled orders can be refunded.', 'تەنها داواکارییە جێبەجێکراوەکان دەگەڕێنرێنەوە.'),
  // events
  eventsDesc: tri(
    'كل تأكيد دفع استقبله النظام، مرة واحدة لكل حدث من المزوّد — بما فيها مدفوعات محفظة Levonis.',
    'Every payment confirmation the system received, once per provider event — Levonis wallet payments included.',
    'هەموو پشتڕاستکردنەوەیەکی پارەدان کە سیستەم وەریگرت، یەک جار بۆ هەر ڕووداوێکی دابینکەر — پارەدانەکانی جزدانی Levonis یش.'
  ),
  provider: tri('المزوّد', 'Provider', 'دابینکەر'),
  eventId: tri('معرّف الحدث', 'Event id', 'ناسنامەی ڕووداو'),
  received: tri('استُلم', 'Received', 'وەرگیرا'),
  noEvents: tri('لم يُستلم أي حدث دفع بعد.', 'No payment event has been received yet.', 'هێشتا هیچ ڕووداوێکی پارەدان وەرنەگیراوە.'),
  eventsCap: tri('أحدث 500 حدث.', 'The 500 newest events.', '500 نوێترین ڕووداو.'),
  quantity: tri('الكمية', 'Quantity', 'بڕ'),
} satisfies Record<string, Tri>;

const FULFILMENT: Readonly<Record<string, Tri>> = {
  credits: tri('إلى رصيد الساعات', 'To the hour balance', 'بۆ باڵانسی کاتژمێر'),
  inventory: tri('إلى رصيد مواد العميل', 'To the customer’s material balance', 'بۆ باڵانسی کەرەستەی کڕیار'),
  delivery: tri('للتوصيل', 'For delivery', 'بۆ گەیاندن'),
  project: tri('لمشروع طباعة', 'For a print project', 'بۆ پڕۆژەیەکی چاپ'),
  fee: tri('رسوم', 'Fee', 'کرێ'),
};

const REFUND_METHOD: Readonly<Record<string, Tri>> = {
  manual: S.methodManual,
  gateway: S.methodGateway,
  levonis_wallet: S.methodWallet,
  dev: tri('تطوير (تجريبي)', 'Development (test)', 'گەشەپێدان (تاقیکردنەوە)'),
};

const ORDER_STATES = ['awaiting_payment', 'fulfilled', 'partially_refunded', 'refunded', 'cancelled', 'expired'];

const orderTone = (s: string): Tone =>
  s === 'fulfilled' ? 'success' : s === 'awaiting_payment' ? 'warning' : s === 'refunded' || s === 'partially_refunded' ? 'info' : 'neutral';

const outcomeTone = (o: string): Tone => (o === 'applied' ? 'success' : o === 'duplicate_event' ? 'neutral' : o === 'duplicate_order' ? 'warning' : 'danger');

type Tab = 'orders' | 'events';

export default function OrdersSection({ params, go }: SectionProps) {
  const { t } = usePcLang();
  const [tab, setTab] = useState<Tab>(params.tab === 'events' ? 'events' : 'orders');
  const [openOrder, setOpenOrder] = useState<string | null>(params.order ?? null);
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      <Chips<Tab>
        label={t(S.view)}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'orders', label: t(S.orders) },
          { id: 'events', label: t(S.events) },
        ]}
      />
      {tab === 'orders' ? <OrdersPanel initialStatus={params.status ?? ''} onOpen={setOpenOrder} /> : <EventsPanel onOpen={setOpenOrder} />}
      {openOrder && <OrderSheet key={openOrder} orderId={openOrder} onClose={() => setOpenOrder(null)} go={go} />}
    </div>
  );
}

function OrdersPanel({ initialStatus, onOpen }: { initialStatus: string; onOpen: (id: string) => void }) {
  const { t, lang } = usePcLang();
  const [status, setStatus] = useState(initialStatus);
  const [search, setSearch] = useState('');
  const orders = useLoad(() => pc.get<OrderRow[]>(`/orders${query({ status })}`), [status]);
  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => (orders.data && needle ? orders.data.filter((o) => o.id.toLowerCase().includes(needle) || o.user_id.toLowerCase().includes(needle)) : orders.data), [orders.data, needle]);
  const paged = usePaged(rows, 50);
  const columns: PcColumn<OrderRow>[] = [
    {
      id: 'id',
      header: t(S.order),
      card: 'title',
      cell: (o) => (
        <button type="button" className="rounded-sm text-start font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => onOpen(o.id)}>
          <Id value={o.id} />
        </button>
      ),
    },
    { id: 'status', header: t(S.status), card: 'badge', cell: (o) => <StatusChip tone={orderTone(o.status)}>{labelOf(ORDER_STATUS, o.status, lang)}</StatusChip> },
    { id: 'kind', header: t(S.kind), cell: (o) => labelOf(ORDER_KIND, o.kind, lang) },
    { id: 'total', header: t(S.total), numeric: true, cell: (o) => <Money iqd={o.total_iqd} /> },
    { id: 'paid', header: t(S.paid), numeric: true, cell: (o) => <Money iqd={o.paid_iqd} /> },
    { id: 'refunded', header: t(S.refunded), numeric: true, cell: (o) => (o.refunded_iqd ? <Money iqd={o.refunded_iqd} /> : '—') },
    { id: 'method', header: t(S.method), cell: (o) => labelOf(PROVIDER, o.payment_method, lang) },
    { id: 'user', header: t(W.user), cell: (o) => <Id value={o.user_id} /> },
    { id: 'created', header: t(S.created), card: 'meta', cell: (o) => formatDateTime(o.created_at, lang) },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Chips<string> label={t(S.status)} value={status} onChange={setStatus} items={[{ id: '', label: t(S.all) }, ...ORDER_STATES.map((s) => ({ id: s, label: labelOf(ORDER_STATUS, s, lang) }))]} />
        <RefreshButton onClick={() => orders.reload()} loading={orders.loading} />
      </div>
      <TextField label={t(S.search)} value={search} onChange={setSearch} ltr maxLength={120} className="max-w-md" />
      <p className={`text-[11.5px] ${T.text3}`}>{t(S.cap)}</p>
      <PcList<OrderRow>
        label={t(S.orders)}
        columns={columns}
        rows={paged.slice}
        rowKey={(o) => o.id}
        loading={orders.loading}
        error={orders.error}
        onRetry={() => void orders.reload()}
        empty={{ title: t(S.empty), icon: <Receipt size={22} aria-hidden /> }}
        rowLabel={(o) => o.id}
        rowActions={(o) => [{ id: 'open', label: t(W.open), onSelect: () => onOpen(o.id) }]}
      />
      <Pager page={paged.page} total={paged.total} onPage={paged.setPage} />
    </div>
  );
}

function EventsPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, lang } = usePcLang();
  const events = useLoad(() => pc.get<PaymentEvent[]>('/payment-events?limit=500'), []);
  const paged = usePaged(events.data, 50);
  const columns: PcColumn<PaymentEvent>[] = [
    { id: 'received', header: t(S.received), card: 'title', cell: (e) => formatDateTime(e.received_at, lang) },
    { id: 'outcome', header: t(S.outcome), card: 'badge', cell: (e) => <StatusChip tone={outcomeTone(e.outcome)}>{labelOf(PAYMENT_OUTCOME, e.outcome, lang)}</StatusChip> },
    { id: 'provider', header: t(S.provider), cell: (e) => labelOf(PROVIDER, e.provider, lang) },
    { id: 'amount', header: t(S.amount), numeric: true, cell: (e) => <Money iqd={e.amount_iqd} /> },
    {
      id: 'order',
      header: t(S.order),
      cell: (e) =>
        e.order_id ? (
          <button type="button" className={T.btnGhostSm} onClick={() => onOpen(e.order_id as string)}>
            <Id value={e.order_id} />
          </button>
        ) : (
          '—'
        ),
    },
    { id: 'event', header: t(S.eventId), card: 'meta', cell: (e) => <bdi dir="ltr" className="break-all font-mono text-[11.5px]">{e.provider_event_id}</bdi> },
  ];
  return (
    <div className="space-y-3">
      <SectionHead level={3} title={t(S.events)} description={t(S.eventsDesc)} actions={<RefreshButton onClick={() => events.reload()} loading={events.loading} />} />
      <p className={`text-[11.5px] ${T.text3}`}>{t(S.eventsCap)}</p>
      <PcList<PaymentEvent>
        label={t(S.events)}
        columns={columns}
        rows={paged.slice}
        rowKey={(e) => e.id}
        loading={events.loading}
        error={events.error}
        onRetry={() => void events.reload()}
        empty={{ title: t(S.noEvents), icon: <CreditCard size={22} aria-hidden /> }}
        rowLabel={(e) => e.provider_event_id}
        rowActions={(e) => (e.order_id ? [{ id: 'open', label: t(W.open), onSelect: () => onOpen(e.order_id as string) }] : [])}
      />
      <Pager page={paged.page} total={paged.total} onPage={paged.setPage} />
    </div>
  );
}

/** A line as the customer bought it: «Standard hours × 2 · 10 h», «PLA Black · 1,000 g». */
function lineWhat(l: OrderLine, refs: RefLists, lang: 'ar' | 'en' | 'ckb'): string {
  switch (l.kind) {
    case 'credit_package':
      return `${refs.name('packages', l.package_id)} × ${num(l.quantity)} · ${duration(l.seconds, lang)}`;
    case 'credit_hours':
      return `${refs.name('tiers', l.tier_id)} · ${duration(l.seconds, lang)}`;
    case 'material':
      return `${refs.name('variants', l.variant_id)} · ${qty(l.quantity, String(refs.row('variants', l.variant_id)?.unit_code ?? ''), lang)}`;
    default:
      return labelOf(LINE_KIND, l.kind, lang);
  }
}

function OrderSheet({ orderId, onClose, go }: { orderId: string; onClose: () => void; go: Go }) {
  const { t, lang } = usePcLang();
  const order = useLoad(() => pc.get<OrderDetail>(`/orders/${enc(orderId)}`), [orderId]);
  const refs = useRefs(['tiers', 'packages', 'variants'], lang);
  const titleId = `pc-order-${orderId}`;
  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="ap w-full sm:max-w-2xl"
      header={
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {t(S.order)} <Id value={orderId} copy />
          </h2>
          <RefreshButton onClick={() => order.reload()} loading={order.loading} />
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        <LoadState state={order}>{(o) => <OrderBody order={o} refs={refs} reload={order.reload} go={go} onClose={onClose} />}</LoadState>
      </div>
    </Sheet>
  );
}

function OrderBody({ order: o, refs, reload, go, onClose }: { order: OrderDetail; refs: RefLists; reload: () => Promise<void>; go: Go; onClose: () => void }) {
  const { t, lang } = usePcLang();
  const wallet = o.payment_method === 'levonis_wallet' || o.payments.some((p) => p.provider === 'levonis_wallet' && p.status === 'confirmed');
  const lineOf = (id: string | null) => o.lines.find((l) => l.id === id);
  const refundable = o.status === 'fulfilled' || o.status === 'partially_refunded';
  return (
    <>
      <section className={`${T.surface} space-y-3 p-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={orderTone(o.status)}>{labelOf(ORDER_STATUS, o.status, lang)}</StatusChip>
          <span className={`text-[12px] ${T.text3}`}>{labelOf(ORDER_KIND, o.kind, lang)}</span>
        </div>
        <KV
          rows={[
            [t(W.user), <Id key="u" value={o.user_id} copy />],
            [t(S.method), labelOf(PROVIDER, o.payment_method, lang)],
            [t(S.subtotal), <Money key="s" iqd={o.subtotal_iqd} />],
            o.discount_iqd > 0 && [t(S.discount), <Money key="d" iqd={-o.discount_iqd} signed />],
            [t(S.total), <Money key="t" iqd={o.total_iqd} className="font-bold" />],
            [t(S.paid), <Money key="p" iqd={o.paid_iqd} />],
            o.refunded_iqd > 0 && [t(S.refunded), <Money key="r" iqd={o.refunded_iqd} />],
            [t(S.created), formatDateTime(o.created_at, lang)],
            !!o.paid_at && [t(S.paidAt), formatDateTime(o.paid_at, lang)],
            !!o.fulfilled_at && [t(S.fulfilledAt), formatDateTime(o.fulfilled_at, lang)],
            o.status === 'awaiting_payment' && [t(S.holdUntil), formatDateTime(o.stock_hold_expires_at, lang)],
            !!o.shipment_id && [t(S.shipment), <Id key="sh" value={o.shipment_id} copy />],
            o.promotion_ids.length > 0 && [t(S.promotions), o.promotion_ids.map((p) => <Id key={p} value={p} />)],
          ]}
        />
        {o.delivery_address && (
          <div>
            <p className={`text-[11.5px] font-semibold ${T.text3}`}>{t(S.address)}</p>
            <Json value={o.delivery_address} />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Act kind="ghost" onClick={() => go('customers', { user: o.user_id })}>
            {t(S.openCustomer)}
          </Act>
          {o.shipment_id && (
            <Act kind="ghost" onClick={() => go('shipments', { shipment: o.shipment_id as string })}>
              {t(S.openShipment)}
            </Act>
          )}
        </div>
      </section>

      {wallet && <Note tone="info">{t(o.status === 'awaiting_payment' ? S.walletPending : S.walletPaid)}</Note>}

      <Tray title={t(S.lines)}>
        <ul className="space-y-2">
          {o.lines.map((l) => (
            <li key={l.id} className="space-y-0.5 text-[12.5px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`font-semibold ${T.text1}`}>
                  #{l.line_no} · {labelOf(LINE_KIND, l.kind, lang)} — {lineWhat(l, refs, lang)}
                </span>
                <Money iqd={l.final_price_iqd} className="font-bold" />
              </div>
              <p className={T.text3}>
                {t(S.fulfilment)}: {labelOf(FULFILMENT, l.fulfillment, lang)}
                {l.expires_after_days !== null && ` · ${t(S.expires)} ${num(l.expires_after_days)} ${t(S.days)}`}
                {l.refunded_iqd > 0 && (
                  <>
                    {' · '}
                    {t(S.refunded)}: <Money iqd={l.refunded_iqd} />
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      </Tray>

      <Tray title={t(S.payments)}>
        {o.payments.length === 0 ? (
          <p className={`text-[12.5px] ${T.text3}`}>{t(S.noPayments)}</p>
        ) : (
          <ul className="space-y-1.5 text-[12.5px]">
            {o.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className={T.text2}>
                  {labelOf(PROVIDER, p.provider, lang)} · {formatDateTime(p.confirmed_at ?? p.created_at, lang)}
                </span>
                <span className="flex items-center gap-2">
                  <StatusChip tone={p.status === 'confirmed' ? 'success' : p.status === 'rejected' ? 'danger' : 'warning'}>{labelOf(PAYMENT_STATUS, p.status, lang)}</StatusChip>
                  <Money iqd={p.amount_iqd} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Tray>

      <Tray title={t(S.refunds)}>
        {o.refunds.length === 0 ? (
          <p className={`text-[12.5px] ${T.text3}`}>{t(S.noRefunds)}</p>
        ) : (
          <ul className="space-y-2 text-[12.5px]">
            {o.refunds.map((r) => {
              const line = lineOf(r.order_line_id);
              return (
                <li key={r.id} className="space-y-0.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={T.text2}>
                      {line ? `#${line.line_no} · ${labelOf(LINE_KIND, line.kind, lang)}` : '—'}
                      {r.quantity > 0 && line && ` · ${line.kind === 'material' ? qty(r.quantity, String(refs.row('variants', line.variant_id)?.unit_code ?? ''), lang) : duration(r.quantity, lang)}`}
                    </span>
                    <Money iqd={r.amount_iqd} className="font-bold" />
                  </div>
                  <p className={T.text3}>
                    {labelOf(REFUND_METHOD, r.method, lang)} · {labelOf(REFUND_STATUS, r.status, lang)} · {formatDateTime(r.created_at, lang)}
                  </p>
                  {r.reason && <p className={T.text2}>{r.reason}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Tray>

      {o.status === 'awaiting_payment' && (
        <>
          <ManualPayment order={o} reload={reload} />
          <CancelOrder order={o} reload={reload} onClose={onClose} />
        </>
      )}
      {refundable ? <RefundForm order={o} refs={refs} wallet={wallet} reload={reload} /> : o.status !== 'awaiting_payment' && <p className={`text-[12px] ${T.text3}`}>{t(S.refundOnlyFulfilled)}</p>}
    </>
  );
}

function ManualPayment({ order: o, reload }: { order: OrderDetail; reload: () => Promise<void> }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const [amount, setAmount] = useState<number | null>(o.total_iqd);
  const [reference, setReference] = useState('');
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const amountError = amount === null ? t(W.required) : null;
  const referenceError = !reference.trim() ? t(W.required) : null;
  const submit = async () => {
    setTried(true);
    setFailure(null);
    if (amountError || referenceError) return;
    const ok = await confirm({ title: t(S.paymentAsk), consequence: t(S.paymentConsequence), confirmLabel: t(S.recordPayment) });
    if (!ok) return;
    try {
      // No Idempotency-Key: the receipt itself is the event id on the server.
      const out = await pc.post<PaymentResult>(`/orders/${enc(o.id)}/confirm-payment`, { amount_iqd: amount, reference: reference.trim() });
      setResult(out);
      if (out.outcome === 'applied') toast.success(labelOf(PAYMENT_OUTCOME, out.outcome, lang));
      await reload();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };
  return (
    <Tray title={t(S.confirmPayment)} description={t(S.paymentHelp)}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <IntField label={t(S.amount)} unit={iqdUnit(lang)} value={amount} onChange={setAmount} error={tried ? amountError : null} hint={<Money iqd={o.total_iqd} />} />
          <TextField label={t(S.reference)} value={reference} onChange={setReference} ltr maxLength={120} error={tried ? referenceError : null} />
        </div>
        {amount !== null && amount !== o.total_iqd && <Note tone="warning">{t(S.amountDiffers)}</Note>}
        {result && (
          <Note tone={result.outcome === 'applied' ? 'success' : result.outcome === 'duplicate_event' ? 'info' : 'warning'}>
            {t(S.outcome)}: {labelOf(PAYMENT_OUTCOME, result.outcome, lang)}
            {result.previous_outcome && ` · ${labelOf(PAYMENT_OUTCOME, result.previous_outcome, lang)}`}
            {typeof result.previous_amount_iqd === 'number' && (
              <>
                {' · '}
                {t(S.previously)} <Money iqd={result.previous_amount_iqd} />
              </>
            )}
          </Note>
        )}
        {failure && <Note tone="danger">{failure}</Note>}
        <Act kind="primary" onClick={submit}>
          {t(S.recordPayment)}
        </Act>
      </div>
      {confirmDialog}
    </Tray>
  );
}

function CancelOrder({ order: o, reload, onClose }: { order: OrderDetail; reload: () => Promise<void>; onClose: () => void }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    setFailure(null);
    const ok = await confirm({ title: t(S.cancelAsk), consequence: t(S.cancelConsequence), confirmLabel: t(S.cancel), destructive: true });
    if (!ok) return;
    try {
      await pc.post(`/orders/${enc(o.id)}/cancel`, reason.trim() ? { reason: reason.trim() } : {});
      toast.success(t(S.cancelled));
      await reload();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };
  return (
    <Tray title={t(S.cancel)}>
      <div className="space-y-3">
        <TextArea label={`${t(W.reason)} (${t(W.optional)})`} value={reason} onChange={setReason} maxLength={300} rows={2} />
        {failure && <Note tone="danger">{failure}</Note>}
        <div className="flex flex-wrap gap-2">
          <Act kind="danger" onClick={submit}>
            {t(S.cancel)}
          </Act>
          <Act kind="ghost" onClick={onClose}>
            {t(W.close)}
          </Act>
        </div>
      </div>
      {confirmDialog}
    </Tray>
  );
}

interface RefundAnswer {
  refund_id: string;
  amount_iqd: number;
  quantity: number;
  replayed: boolean;
}

/**
 * Plan, then confirm. The Idempotency-Key belongs to the plan: minted when a
 * plan is made, reused by every retry of that plan, replaced when the plan
 * changes — so a network retry can never record a second refund, and a
 * changed plan is never refused as a reused key.
 */
function RefundForm({ order: o, refs, wallet, reload }: { order: OrderDetail; refs: RefLists; wallet: boolean; reload: () => Promise<void> }) {
  const { t, lang } = usePcLang();
  const [confirm, confirmDialog] = useConfirm();
  const open = o.lines.filter((l) => l.final_price_iqd - l.refunded_iqd > 0);
  const [lineId, setLineId] = useState(open.length === 1 ? open[0].id : '');
  const [takeSeconds, setTakeSeconds] = useState<number | null>(null);
  const [takeQty, setTakeQty] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'manual' | 'gateway'>('manual');
  const [planned, setPlanned] = useState<{ key: string; body: Record<string, unknown> } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<RefundAnswer | null>(null);
  const line = o.lines.find((l) => l.id === lineId);
  const left = line ? line.final_price_iqd - line.refunded_iqd : 0;
  const credit = line?.kind === 'credit_package' || line?.kind === 'credit_hours';
  const material = line?.kind === 'material';
  const unit = String(refs.row('variants', line?.variant_id)?.unit_code ?? '');

  if (open.length === 0) {
    return (
      <Tray title={t(S.refundTitle)}>
        <p className={`text-[12.5px] ${T.text3}`}>{t(S.noRefundable)}</p>
      </Tray>
    );
  }

  // Any change to the plan drops it (and its key).
  const edit = <V,>(set: (v: V) => void) => (v: V) => {
    set(v);
    setPlanned(null);
    setDone(null);
  };

  const makePlan = () => {
    setFailure(null);
    if (!line) return setFailure(t(S.lineNeeded));
    if (!reason.trim()) return setFailure(t(S.reasonNeeded));
    const quantity = credit ? takeSeconds : material ? takeQty : null;
    setPlanned({
      key: newIdempotencyKey(),
      body: {
        line_id: line.id,
        ...(quantity !== null && quantity > 0 ? { quantity } : {}),
        ...(amount !== null ? { amount_iqd: amount } : {}),
        reason: reason.trim(),
        // A wallet-paid order goes back to the wallet: the server decides, no method is sent.
        ...(wallet ? {} : { method }),
      },
    });
  };

  const submit = async () => {
    if (!planned) return;
    setFailure(null);
    const ok = await confirm({ title: t(S.refundAsk), consequence: t(S.refundConsequence), confirmLabel: t(S.confirmRefund), destructive: true });
    if (!ok) return;
    try {
      const out = await pc.post<RefundAnswer>(`/orders/${enc(o.id)}/refunds`, planned.body, planned.key);
      setDone(out);
      setPlanned(null);
      setTakeSeconds(null);
      setTakeQty(null);
      setAmount(null);
      setReason('');
      toast.success(t(S.refundDone));
      await reload();
    } catch (e) {
      // The plan and its key stay: a retry of the same plan is the same refund.
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  const body = planned?.body;
  return (
    <Tray title={t(S.refundTitle)} description={t(S.refundHelp)}>
      <div className="space-y-3">
        {done && (
          <Note tone="success">
            {t(S.refundDone)}: <Money iqd={done.amount_iqd} />
            {done.quantity > 0 && line && ` · ${material ? qty(done.quantity, unit, lang) : duration(done.quantity, lang)}`} {done.replayed && t(S.replayed)}
          </Note>
        )}
        <SelectField
          label={t(S.line)}
          value={lineId}
          placeholder="—"
          options={open.map((l) => ({ value: l.id, label: `#${l.line_no} · ${labelOf(LINE_KIND, l.kind, lang)} — ${lineWhat(l, refs, lang)}` }))}
          onChange={edit(setLineId)}
        />
        {line && (
          <p className={`text-[12px] ${T.text3}`}>
            {t(S.lineLeft)}: <Money iqd={left} />
          </p>
        )}
        {credit && <DurationInput label={t(S.takeBackSeconds)} value={takeSeconds} onChange={edit(setTakeSeconds)} />}
        {material && <IntField label={t(S.takeBackQty)} unit={unit || undefined} value={takeQty} onChange={edit(setTakeQty)} />}
        {line && <IntField label={t(S.refundAmount)} unit={iqdUnit(lang)} value={amount} onChange={edit(setAmount)} hint={t(S.refundAmountHint)} />}
        <TextArea label={t(W.reason)} value={reason} onChange={edit(setReason)} maxLength={500} rows={2} />
        {wallet ? (
          <p className={`text-[12px] ${T.text2}`}>
            {t(S.refundMethod)}: {t(S.methodWallet)}
          </p>
        ) : (
          <SelectField
            label={t(S.refundMethod)}
            value={method}
            options={[
              { value: 'manual', label: t(S.methodManual) },
              { value: 'gateway', label: t(S.methodGateway) },
            ]}
            onChange={edit((v: string) => setMethod(v === 'gateway' ? 'gateway' : 'manual'))}
          />
        )}
        {failure && <Note tone="danger">{failure}</Note>}
        {planned && body && line ? (
          <section className={`${T.surface} space-y-2 p-3`} aria-live="polite">
            <h4 className={`text-[13px] font-bold ${T.text1}`}>{t(S.planTitle)}</h4>
            <KV
              rows={[
                [t(S.line), `#${line.line_no} · ${lineWhat(line, refs, lang)}`],
                [
                  t(S.planTake),
                  credit || material
                    ? typeof body.quantity === 'number'
                      ? credit
                        ? duration(body.quantity, lang)
                        : qty(body.quantity, unit, lang)
                      : t(S.planAllUnused)
                    : t(S.planNothingTaken),
                ],
                [t(S.planAmount), typeof body.amount_iqd === 'number' ? <Money key="a" iqd={body.amount_iqd} /> : t(S.planComputed)],
                [t(S.refundMethod), t(wallet ? S.methodWallet : method === 'gateway' ? S.methodGateway : S.methodManual)],
                [t(W.reason), String(body.reason)],
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <Act kind="danger" onClick={submit}>
                {t(S.confirmRefund)}
              </Act>
              <Act kind="ghost" onClick={() => setPlanned(null)}>
                {t(S.editPlan)}
              </Act>
            </div>
          </section>
        ) : (
          <Act kind="primary" onClick={makePlan}>
            {t(S.plan)}
          </Act>
        )}
      </div>
      {confirmDialog}
    </Tray>
  );
}
