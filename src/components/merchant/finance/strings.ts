/**
 * The finance page's words, and the pure decisions about them (tested in
 * tests/merchantFinanceUi.test.ts).
 *
 * SORANI IS NEVER MACHINE-WRITTEN (docs/DECISIONS.md row 11). Where the app
 * already carries a hand-written Sorani word for the same thing it is reused
 * VERBATIM — the old earnings tab (src/pages/MerchantDashboardPage.tsx) wrote
 * «بەردەست», «چاوەڕوان», «دراوە», «تۆمار», «فرۆشتن», «داواکاری تایبەت»,
 * «کۆمیشن», «گەڕاندنەوە», «دراوە بە تۆ», «گۆڕانکاری», «قازانج». Everything
 * else passes only Arabic and English (`loc` falls back to the Arabic) and is
 * marked for the owner.
 */
import type { LedgerBucket, LedgerKind, PayoutState } from './financeApi';

export type Loc = (ar: string, en: string, ckb?: string) => string;

export function financeStrings(loc: Loc) {
  return {
    title: loc('الأرباح', 'Earnings', 'قازانج'),
    availableHero: loc('متاح للسحب', 'Available to withdraw'), // OWNER: Sorani to be written by hand.
    available: loc('متاح', 'Available', 'بەردەست'),
    pending: loc('قيد الانتظار', 'Pending', 'چاوەڕوان'),
    reserved: loc('محجوز', 'Reserved'), // OWNER: Sorani to be written by hand.
    paidOut: loc('مدفوع لك', 'Paid out', 'دراوە'),
    escrowHeld: loc('في الضمان', 'In escrow'), // OWNER: Sorani to be written by hand.
    pendingHint: loc(
      'يصبح متاحًا حين يؤكد الزبون الاستلام، أو بعد 3 أيام من التسليم ما لم تُفتح شكوى.',
      'Becomes available when the customer confirms receipt — or 3 days after delivery unless a complaint is open.'
    ), // OWNER: Sorani to be written by hand.
    frozenHint: (amount: string) =>
      loc(`منها ${amount} مجمّدة بشكوى أو تذكرة مفتوحة.`, `${amount} of it is held by an open complaint or ticket.`), // OWNER: Sorani to be written by hand.
    reservedHint: (n: number) =>
      loc(`${n} طلب سحب قيد المعالجة`, n === 1 ? '1 payout request in progress' : `${n} payout requests in progress`), // OWNER: Sorani to be written by hand.
    escrowHint: loc('طلبات مخصصة؛ يُضاف إلى «متاح» حين يؤكد الزبون أو يُحسم النزاع.', 'Custom orders; moves to Available when the customer confirms or a dispute is decided.'), // OWNER: Sorani to be written by hand.
    requestPayout: loc('اطلب تحويل أرباحك', 'Request a payout'), // OWNER: Sorani to be written by hand.
    nothingToWithdraw: loc('لا يوجد مبلغ متاح للسحب الآن.', 'There is nothing available to withdraw right now.'), // OWNER: Sorani to be written by hand.
    debt: loc(
      'عليك مبلغ لـ Levonis من استرداد لزبون بعد تحرير المال؛ يُسدَّد من مبيعاتك القادمة.',
      'You owe Levonis for a customer refund made after the money was released; your next sales settle it.'
    ), // OWNER: Sorani to be written by hand.

    statement: loc('كشف الأرباح', 'Earnings statement'), // OWNER: Sorani to be written by hand.
    statementNote: loc('كل رقم هنا مجموع حركات السجل أدناه.', 'Every figure here is a sum of the ledger below.'), // OWNER: Sorani to be written by hand.
    // Review F6: a DIFFERENT figure from Analytics «إجمالي المدفوع» — named
    // apart and defined under the row (tests/merchantFiguresRelation.test.ts pins how they relate).
    gross: loc('مبيعات مسجّلة', 'Recorded sales'), // OWNER: Sorani to be written by hand.
    grossMeans: loc(
      'قيمة البضاعة بعد الخصم ودون أجرة التوصيل، وتشمل الطلبات الملغاة — ما أُعيد للزبائن في سطره أدناه.',
      'Goods after coupons, excluding delivery, including cancelled orders — what went back to customers is on its own line below.'
    ), // OWNER: Sorani to be written by hand.
    grossBreakdown: (store: string, custom: string) =>
      loc(`المتجر ${store} · الطلبات المخصصة ${custom}`, `Store ${store} · Custom orders ${custom}`), // OWNER: Sorani to be written by hand.
    commission: loc('عمولة المنصة', 'Platform commission', 'کۆمیشن'),
    deliveryFees: loc('أجور التوصيل لك', 'Your delivery fees'), // OWNER: Sorani to be written by hand.
    refunds: loc('المبالغ المُعادة للزبائن', 'Refunded to customers'), // OWNER: Sorani to be written by hand.
    adjustments: loc('تسويات', 'Adjustments', 'گۆڕانکاری'),
    receivable: loc('صافي أرباحك', 'Your net earnings'), // OWNER: Sorani to be written by hand.

    ledger: loc('سجل الحركات', 'Ledger', 'تۆمار'),
    ledgerEmpty: loc('لا توجد حركات بعد. تظهر هنا أول ما يصلك طلب.', 'No entries yet. They appear here with your first order.'), // OWNER: Sorani to be written by hand.
    loadMore: loc('المزيد', 'Load more'), // OWNER: Sorani to be written by hand.
    loadFailed: loc('تعذّر تحميل الأرباح.', 'Could not load your earnings.'), // OWNER: Sorani to be written by hand.
    retry: loc('إعادة المحاولة', 'Try again'), // OWNER: Sorani to be written by hand.
    filterAll: loc('الكل', 'All'), // OWNER: Sorani to be written by hand.
    filterSales: loc('المبيعات', 'Sales'), // OWNER: Sorani to be written by hand.
    filterCommission: loc('العمولة', 'Commission'), // OWNER: Sorani to be written by hand.
    filterRefunds: loc('الاسترداد', 'Refunds'), // OWNER: Sorani to be written by hand.
    filterPayouts: loc('السحب', 'Payouts'), // OWNER: Sorani to be written by hand.
    filterLabel: loc('نوع الحركة', 'Entry type'), // OWNER: Sorani to be written by hand.
    carried: loc('منقول من السجل القديم', 'Carried from the old ledger'), // OWNER: Sorani to be written by hand.
    orderRef: (id: string) => loc(`الطلب ${id}`, `Order ${id}`), // OWNER: Sorani to be written by hand.
    customRef: (id: string) => loc(`طلب مخصص ${id}`, `Custom order ${id}`), // OWNER: Sorani to be written by hand.
    payoutRef: loc('طلب سحب', 'Payout request'), // OWNER: Sorani to be written by hand.

    payouts: loc('طلبات السحب', 'Payout requests'), // OWNER: Sorani to be written by hand.
    payoutsEmpty: loc('لم تطلب أي تحويل بعد.', 'You have not requested a payout yet.'), // OWNER: Sorani to be written by hand.
    cancelRequest: loc('إلغاء الطلب', 'Cancel request'), // OWNER: Sorani to be written by hand.
    cancelTitle: loc('إلغاء طلب السحب؟', 'Cancel this payout request?'), // OWNER: Sorani to be written by hand.
    cancelConsequence: (amount: string) =>
      loc(`يعود ${amount} إلى رصيدك المتاح فورًا.`, `${amount} goes straight back to your available balance.`), // OWNER: Sorani to be written by hand.
    keepRequest: loc('إبقاء الطلب', 'Keep request'), // OWNER: Sorani to be written by hand.
    cancelled: loc('أُلغي الطلب وعاد المبلغ إلى رصيدك المتاح.', 'Request cancelled; the amount is back in Available.'), // OWNER: Sorani to be written by hand.
    reference: (r: string) => loc(`مرجع التحويل: ${r}`, `Transfer reference: ${r}`), // OWNER: Sorani to be written by hand.
    failReason: (r: string) => loc(`السبب: ${r}`, `Reason: ${r}`), // OWNER: Sorani to be written by hand.
    byLevonis: loc('سجّلته Levonis', 'Recorded by Levonis'), // OWNER: Sorani to be written by hand.

    sheetTitle: loc('طلب تحويل الأرباح', 'Request a payout'), // OWNER: Sorani to be written by hand.
    sheetLead: (amount: string) =>
      loc(`المتاح الآن ${amount}. يُحجز المبلغ فور الطلب حتى تحوّله Levonis.`, `${amount} is available now. The amount is reserved as soon as you ask, until Levonis transfers it.`), // OWNER: Sorani to be written by hand.
    amount: loc('المبلغ', 'Amount'), // OWNER: Sorani to be written by hand.
    allAvailable: (amount: string) => loc(`كامل المتاح (${amount})`, `All available (${amount})`), // OWNER: Sorani to be written by hand.
    channel: loc('طريقة الاستلام', 'Receive through'), // OWNER: Sorani to be written by hand.
    account: loc('رقم الحساب أو البطاقة', 'Account or card number'), // OWNER: Sorani to be written by hand.
    holder: loc('اسم صاحب الحساب', 'Account holder'), // OWNER: Sorani to be written by hand.
    note: loc('ملاحظة لفريق Levonis', 'Note for the Levonis team'), // OWNER: Sorani to be written by hand.
    review: loc('مراجعة الطلب', 'Review request'), // OWNER: Sorani to be written by hand.
    confirmTitle: (amount: string) => loc(`طلب تحويل ${amount}؟`, `Request ${amount}?`), // OWNER: Sorani to be written by hand.
    confirmConsequence: (channel: string, account: string) =>
      loc(
        `يُحجز المبلغ من رصيدك المتاح ويُحوَّل عبر ${channel}${account ? ` إلى ${account}` : ''} بعد مراجعة Levonis. يمكنك إلغاؤه قبل الموافقة.`,
        `The amount is reserved from your available balance and sent through ${channel}${account ? ` to ${account}` : ''} once Levonis reviews it. You can cancel it until it is approved.`
      ), // OWNER: Sorani to be written by hand.
    send: loc('اطلب التحويل', 'Request payout'), // OWNER: Sorani to be written by hand.
    back: loc('رجوع', 'Back'), // OWNER: Sorani to be written by hand.
    requested: loc('أُرسل طلبك، والمبلغ محجوز حتى التحويل.', 'Request sent; the amount is reserved until it is transferred.'), // OWNER: Sorani to be written by hand.
    amountInvalid: loc('اكتب مبلغًا صحيحًا بالدينار أكبر من صفر.', 'Enter a whole number of dinars above zero.'), // OWNER: Sorani to be written by hand.
    amountTooHigh: (amount: string) => loc(`المبلغ أكبر من المتاح (${amount}).`, `That is more than is available (${amount}).`), // OWNER: Sorani to be written by hand.
    accountRequired: loc('هذه الطريقة تحتاج رقم الحساب أو البطاقة.', 'This channel needs the account or card number.'), // OWNER: Sorani to be written by hand.
  };
}

export type FinanceStrings = ReturnType<typeof financeStrings>;

/** A ledger line's kind, in words the merchant uses. */
export function kindLabel(kind: LedgerKind, loc: Loc): string {
  switch (kind) {
    case 'sale_gross': return loc('بيع من المتجر', 'Store sale', 'فرۆشتن');
    case 'commission': return loc('عمولة المنصة', 'Platform commission', 'کۆمیشن');
    case 'delivery_fee': return loc('أجرة التوصيل', 'Delivery fee'); // OWNER: Sorani to be written by hand.
    case 'refund': return loc('استرجاع للزبون', 'Refund to the customer', 'گەڕاندنەوە');
    case 'commission_refund': return loc('إعادة العمولة', 'Commission returned'); // OWNER: Sorani to be written by hand.
    case 'delivery_refund': return loc('استرجاع التوصيل', 'Delivery refunded'); // OWNER: Sorani to be written by hand.
    case 'escrow_release': return loc('طلب مخصص', 'Custom order', 'داواکاری تایبەت');
    case 'adjustment': return loc('تسوية', 'Adjustment', 'گۆڕانکاری');
    case 'release': return loc('تحرير المبلغ', 'Released'); // OWNER: Sorani to be written by hand.
    case 'payout': return loc('تحويل لك', 'Payout to you', 'دراوە بە تۆ');
    case 'payout_reversal': return loc('إعادة طلب سحب', 'Payout returned'); // OWNER: Sorani to be written by hand.
  }
}

/** Which of the four figures a line moves. */
export function bucketLabel(bucket: LedgerBucket, loc: Loc): string {
  switch (bucket) {
    case 'pending': return loc('قيد الانتظار', 'Pending', 'چاوەڕوان');
    case 'available': return loc('متاح', 'Available', 'بەردەست');
    case 'reserved': return loc('محجوز', 'Reserved'); // OWNER: Sorani to be written by hand.
    case 'paid': return loc('مدفوع', 'Paid out', 'دراوە');
  }
}

export function payoutStateLabel(state: PayoutState, loc: Loc): string {
  switch (state) {
    case 'requested': return loc('بانتظار المراجعة', 'Awaiting review'); // OWNER: Sorani to be written by hand.
    case 'approved': return loc('موافق عليه — قيد التحويل', 'Approved — being transferred'); // OWNER: Sorani to be written by hand.
    case 'paid': return loc('حُوِّل', 'Paid'); // OWNER: Sorani to be written by hand.
    case 'failed': return loc('لم يتم', 'Failed'); // OWNER: Sorani to be written by hand.
    case 'cancelled': return loc('ملغى', 'Cancelled'); // OWNER: Sorani to be written by hand.
  }
}

export function payoutTone(state: PayoutState): 'warning' | 'info' | 'success' | 'danger' | 'neutral' {
  return state === 'requested' ? 'warning' : state === 'approved' ? 'info' : state === 'paid' ? 'success' : state === 'failed' ? 'danger' : 'neutral';
}

/** The ledger filter chips: each maps to one API `kind` (or all). */
export const LEDGER_FILTERS: Array<{ id: string; kind: LedgerKind | '' }> = [
  { id: 'all', kind: '' },
  { id: 'sales', kind: 'sale_gross' },
  { id: 'commission', kind: 'commission' },
  { id: 'refunds', kind: 'refund' },
  { id: 'payouts', kind: 'payout' },
];

/**
 * The payout routes' refusals as the merchant's own sentences — never the
 * server's English or the code. `available` names the balance when the server
 * sent it.
 */
export function payoutRefusalText(
  code: string | undefined,
  details: Record<string, unknown> | undefined,
  loc: Loc,
  money: (iqd: number) => string
): string {
  switch (code) {
    case 'INSUFFICIENT_BALANCE': {
      const a = Number(details?.available_iqd);
      return Number.isFinite(a)
        ? loc(`المبلغ أكبر من المتاح الآن (${money(a)}).`, `That is more than is available now (${money(a)}).`) // OWNER: Sorani to be written by hand.
        : loc('المبلغ أكبر من المتاح الآن.', 'That is more than is available now.'); // OWNER: Sorani to be written by hand.
    }
    case 'INVALID_AMOUNT': return loc('اكتب مبلغًا صحيحًا بالدينار أكبر من صفر.', 'Enter a whole number of dinars above zero.'); // OWNER: Sorani to be written by hand.
    case 'UNKNOWN_PAYOUT_METHOD': return loc('طريقة الاستلام هذه لم تعد متاحة — اختر غيرها.', 'That channel is no longer offered — choose another.'); // OWNER: Sorani to be written by hand.
    case 'PAYOUT_ACCOUNT_REQUIRED': return loc('هذه الطريقة تحتاج رقم الحساب أو البطاقة.', 'This channel needs the account or card number.'); // OWNER: Sorani to be written by hand.
    case 'IDEMPOTENCY_KEY_REUSED': return loc('انتهت صلاحية هذا الطلب — راجع المبلغ وأرسله من جديد.', 'This request expired — check the amount and send it again.'); // OWNER: Sorani to be written by hand.
    case 'PAYOUT_NOT_CANCELLABLE': return loc('وافقت Levonis على هذا الطلب ولا يمكن إلغاؤه الآن.', 'Levonis has approved this request; it can no longer be cancelled.'); // OWNER: Sorani to be written by hand.
    case 'RATE_LIMITED': return loc('طلبات كثيرة خلال وقت قصير — حاول بعد قليل.', 'Too many requests in a short time — try again shortly.'); // OWNER: Sorani to be written by hand.
    default: return loc('تعذّر إتمام الطلب — تحقّق من الاتصال وحاول مجددًا.', 'Could not complete it — check the connection and try again.'); // OWNER: Sorani to be written by hand.
  }
}
