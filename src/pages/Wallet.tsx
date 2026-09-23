import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';
import { useMoney } from '../CurrencyContext';
import { api, uploadFile, usdCentsToIqd, iqdToUsdCents, depositDeclaredIqd } from '../lib/api';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { Segmented } from '../components/ui/Segmented';
import { Overlay } from '../components/ui/Overlay';
import Spinner from '../components/ui/Spinner';
import {
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  DollarSign,
  ArrowDownLeft,
  X,
  Upload,
  CheckCircle,
  Clock,
  XCircle,
  Copy,
  Receipt,
  Lock,
  HelpCircle,
  Search,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

/**
 * Wallet page (integrated mandate §11.1–§11.4).
 *
 * The three numbers the mandate insists on are shown SEPARATELY: available
 * (spendable), held (reserved by an open withdrawal or purchase) and pending
 * (a deposit under review, which adds nothing spendable). Every figure comes
 * from the server on each load — the browser computes no balance and stores
 * none.
 *
 * Honesty rules visible here: a submitted deposit says "under review", never
 * "added"; an approved withdrawal says "approved for processing", never
 * "transferred"; and the withdrawal fee/net preview says outright that no fee
 * policy has been configured yet instead of inventing a percentage.
 */

type Lang = 'ar' | 'en' | 'ckb';

const STRINGS: Record<Lang, Record<string, string>> = {
  ar: {
    operations: 'العمليات',
    stepChannel: 'القناة',
    stepAmount: 'المبلغ',
    stepProof: 'الإثبات',
    stepAccount: 'رقم الحساب',
    stepReview: 'المراجعة',
    next: 'التالي',
    back2: 'السابق',
    chooseChannel: 'اختر القناة المناسبة',
    chooseChannelHint: 'اضغط على القناة لنسخ رقم الحساب.',
    accountForChannel: 'اكتب رقم حسابك لهذه القناة',
    copyDone: 'تم نسخ رقم الحساب',
    amountWithin: 'المبلغ ضمن رصيدك المتاح',
    optional: 'اختياري',
    confirmDeposit: 'تأكيد الإيداع',
    confirmWithdraw: 'تأكيد السحب',
    channelRequired: 'اختر قناة أولًا',
    accountRequired2: 'اكتب رقم الحساب',
    summary: 'ملخص الطلب',
    stepOf: 'خطوة {n} من 3',
    title: 'المحفظة',
    back: 'رجوع',
    available: 'الرصيد المتاح',
    availableHint: 'القابل للإنفاق الآن',
    held: 'محجوز',
    heldHint: 'محجوز لطلب سحب أو شراء قائم',
    pendingDeposits: 'إيداعات قيد المراجعة',
    pendingHint: 'لا تزيد المتاح قبل الاعتماد',
    pendingWithdrawals: 'سحوبات مفتوحة',
    settled: 'الرصيد المُسوّى',
    points: 'النقاط',
    addFunds: 'إضافة رصيد',
    withdraw: 'سحب رصيد',
    activity: 'العمليات',
    withdrawalRequests: 'طلبات السحب',
    noActivity: 'لا توجد عمليات بعد',
    noActivityHint: 'ستظهر هنا كل عمليات الإيداع والسحب مع أرقامها وحالتها.',
    noWithdrawals: 'لا توجد طلبات سحب',
    filterAll: 'الكل',
    filterDeposit: 'إيداع',
    filterWithdrawal: 'سحب',
    statusAll: 'كل الحالات',
    statusPending: 'قيد المراجعة',
    statusApproved: 'معتمدة',
    statusRejected: 'مرفوضة',
    searchPlaceholder: 'ابحث برقم العملية أو الملاحظة',
    operationNumber: 'رقم العملية',
    receipt: 'الإثبات',
    requestReview: 'طلب مراجعة',
    reviewRequested: 'مراجعة مطلوبة',
    reviewTitle: 'طلب مراجعة عملية',
    reviewReason: 'اشرح سبب طلب المراجعة',
    reviewSubmitted: 'تم تسجيل طلب المراجعة. سيراجعه فريق المالية.',
    amount: 'المبلغ',
    amountIqd: 'المبلغ (د.ع)',
    amountUsd: 'المبلغ (دولار)',
    note: 'ملاحظة (اختياري)',
    notePlaceholder: 'أضف ملاحظة…',
    cancel: 'إلغاء',
    submit: 'إرسال الطلب',
    submitting: 'جارٍ الإرسال…',
    depositTitle: 'إضافة رصيد',
    depositIntro: 'حوّل إلى أحد الحسابات أدناه ثم أرسل الإثبات — كل إيداع يخضع لمراجعة فريقنا.',
    depositMethods: 'وسائل الدفع',
    noMethods: 'لم تُضف وسائل دفع بعد — تواصل مع الدعم قبل التحويل.',
    reference: 'رقم مرجع التحويل',
    referenceHint: 'يمنع احتساب التحويل نفسه مرتين. اتركه فارغًا إن لم يوجد.',
    channel: 'الحساب/القناة',
    receiptLabel: 'صورة الإثبات',
    receiptUploaded: 'تم رفع الإثبات — اضغط للاستبدال',
    receiptUpload: 'اضغط لرفع صورة',
    uploading: 'جارٍ الرفع…',
    depositSubmitted: 'تم تسجيل طلب الإيداع بحالة «قيد المراجعة». لا يُضاف الرصيد قبل اعتماد التحويل.',
    withdrawTitle: 'سحب رصيد',
    withdrawIntro: 'يُحجز المبلغ من رصيدك المتاح فور التسجيل، ولا يُصرف إلا بعد تحويل فعلي موثق.',
    destinationKind: 'وسيلة الاستلام',
    destinationAccount: 'رقم الحساب/المحفظة',
    destinationHolder: 'اسم صاحب الحساب',
    destinationFrozen: 'تُجمَّد بيانات الوجهة عند التأكيد؛ تغييرها يحتاج طلبًا جديدًا.',
    feePreview: 'الرسوم والصافي',
    feeNotConfigured: 'لم تُعتمد سياسة رسوم سحب بعد، لذلك لا نعرض نسبة مخترعة: الصافي = المبلغ المطلوب.',
    feeDeducted: 'العمولة تُخصم من المبلغ المطلوب: يصلك الصافي، ويُحجز المبلغ المطلوب كاملًا من رصيدك.',
    fee: 'الرسوم',
    net: 'الصافي المتوقع',
    withdrawSubmitted: 'تم تسجيل طلب السحب وحجز المبلغ. الموافقة تعني بدء المعالجة، لا أن التحويل تم.',
    availableAfter: 'المتاح بعد الحجز',
    insufficient: 'المبلغ يتجاوز رصيدك المتاح',
    cancelRequest: 'إلغاء الطلب',
    cancelling: 'جارٍ الإلغاء…',
    cancelled: 'تم إلغاء الطلب وتحرير المبلغ المحجوز.',
    destination: 'الوجهة',
    payoutRef: 'مرجع التحويل',
    reason: 'السبب',
    needsReconciliation: 'نتيجة التحويل غير مؤكدة — قيد المطابقة، ولا يُعاد الإرسال تلقائيًا.',
    stateRequested: 'مسجَّل',
    stateApproved: 'موافق على المعالجة',
    stateProcessing: 'قيد المعالجة',
    statePaid: 'تم التحويل',
    stateRejected: 'مرفوض',
    stateCancelled: 'ملغى',
    stateFailed: 'فشل',
    approvedNotSent: 'الموافقة ليست تحويلًا',
    retry: 'إعادة المحاولة',
    refresh: 'تحديث',
    loading: 'جارٍ تحميل المحفظة',
    close: 'إغلاق',
    required: 'مطلوب',
    invalidAmount: 'أدخل مبلغًا صحيحًا',
    receiptRequired: 'صورة الإثبات مطلوبة للإيداع',
    accountRequired: 'أدخل وجهة استلام صحيحة',
    reasonRequired: 'اكتب سببًا واضحًا (٥ أحرف على الأقل)',
    pointsNote: 'النقاط رصيد منفصل ولا تتحول إلى سحب نقدي.',
  },
  en: {
    operations: 'Operations',
    stepChannel: 'Channel',
    stepAmount: 'Amount',
    stepProof: 'Proof',
    stepAccount: 'Account',
    stepReview: 'Review',
    next: 'Next',
    back2: 'Back',
    chooseChannel: 'Choose a channel',
    chooseChannelHint: 'Tap a channel to copy its account number.',
    accountForChannel: 'Your account number for this channel',
    copyDone: 'Account number copied',
    amountWithin: 'Amount, within your available balance',
    optional: 'optional',
    confirmDeposit: 'Confirm deposit',
    confirmWithdraw: 'Confirm withdrawal',
    channelRequired: 'Choose a channel first',
    accountRequired2: 'Enter the account number',
    summary: 'Summary',
    stepOf: 'Step {n} of 3',
    title: 'Wallet',
    back: 'Back',
    available: 'Available balance',
    availableHint: 'Spendable right now',
    held: 'Held',
    heldHint: 'Reserved by an open withdrawal or purchase',
    pendingDeposits: 'Deposits under review',
    pendingHint: 'Adds nothing spendable until approved',
    pendingWithdrawals: 'Open withdrawals',
    settled: 'Settled balance',
    points: 'Points',
    addFunds: 'Add funds',
    withdraw: 'Withdraw',
    activity: 'Operations',
    withdrawalRequests: 'Withdrawal requests',
    noActivity: 'No operations yet',
    noActivityHint: 'Deposits and withdrawals appear here with their number and status.',
    noWithdrawals: 'No withdrawal requests',
    filterAll: 'All',
    filterDeposit: 'Deposits',
    filterWithdrawal: 'Withdrawals',
    statusAll: 'Any status',
    statusPending: 'Under review',
    statusApproved: 'Approved',
    statusRejected: 'Rejected',
    searchPlaceholder: 'Search by operation number or note',
    operationNumber: 'Operation',
    receipt: 'Receipt',
    requestReview: 'Request review',
    reviewRequested: 'Review requested',
    reviewTitle: 'Request a review',
    reviewReason: 'Explain what looks wrong',
    reviewSubmitted: 'Review request recorded. Our finance team will look at it.',
    amount: 'Amount',
    amountIqd: 'Amount (IQD)',
    amountUsd: 'Amount (USD)',
    note: 'Note (optional)',
    notePlaceholder: 'Add a note…',
    cancel: 'Cancel',
    submit: 'Submit request',
    submitting: 'Submitting…',
    depositTitle: 'Add funds',
    depositIntro: 'Transfer to one of the accounts below, then submit the receipt — every deposit is reviewed by our team.',
    depositMethods: 'Payment methods',
    noMethods: 'No payment methods are configured yet — contact support before transferring.',
    reference: 'Transfer reference',
    referenceHint: 'Stops the same transfer being credited twice. Leave blank if you have none.',
    channel: 'Account / channel',
    receiptLabel: 'Payment receipt',
    receiptUploaded: 'Receipt uploaded — tap to replace',
    receiptUpload: 'Tap to upload an image',
    uploading: 'Uploading…',
    depositSubmitted: 'Deposit request recorded as “under review”. Nothing is credited until the transfer is verified.',
    withdrawTitle: 'Withdraw',
    withdrawIntro: 'The amount is held from your available balance immediately and is only paid out after a verified transfer.',
    destinationKind: 'Payout method',
    destinationAccount: 'Account / wallet number',
    destinationHolder: 'Account holder name',
    destinationFrozen: 'Destination details are frozen at confirmation; changing them needs a new request.',
    feePreview: 'Fee and net',
    feeNotConfigured: 'No withdrawal fee policy has been approved yet, so we show no invented rate: net = requested amount.',
    feeDeducted: 'The commission is deducted from the requested amount: you receive the net, and the full requested amount is held from your balance.',
    fee: 'Fee',
    net: 'Expected net',
    withdrawSubmitted: 'Withdrawal request recorded and the amount held. Approval starts processing — it is not a transfer.',
    availableAfter: 'Available after the hold',
    insufficient: 'That exceeds your available balance',
    cancelRequest: 'Cancel request',
    cancelling: 'Cancelling…',
    cancelled: 'Request cancelled and the held amount released.',
    destination: 'Destination',
    payoutRef: 'Payout reference',
    reason: 'Reason',
    needsReconciliation: 'Payout outcome unconfirmed — under reconciliation; nothing is re-sent automatically.',
    stateRequested: 'Requested',
    stateApproved: 'Approved for processing',
    stateProcessing: 'Processing',
    statePaid: 'Paid',
    stateRejected: 'Rejected',
    stateCancelled: 'Cancelled',
    stateFailed: 'Failed',
    approvedNotSent: 'Approved ≠ sent',
    retry: 'Try again',
    refresh: 'Refresh',
    loading: 'Loading your wallet',
    close: 'Close',
    required: 'required',
    invalidAmount: 'Enter a valid amount',
    receiptRequired: 'A receipt image is required for deposits',
    accountRequired: 'Enter a valid payout destination',
    reasonRequired: 'Write a clear reason (at least 5 characters)',
    pointsNote: 'Points are a separate balance and never convert into a cash payout.',
  },
  ckb: {
    operations: 'کردارەکان',
    stepChannel: 'کەناڵ',
    stepAmount: 'بڕ',
    stepProof: 'بەڵگە',
    stepAccount: 'ژمارەی هەژمار',
    stepReview: 'پێداچوونەوە',
    next: 'دواتر',
    back2: 'پێشتر',
    chooseChannel: 'کەناڵێک هەڵبژێرە',
    chooseChannelHint: 'کلیک لە کەناڵ بکە بۆ لەبەرگرتنی ژمارەی هەژمار.',
    accountForChannel: 'ژمارەی هەژمارت بۆ ئەم کەناڵە',
    copyDone: 'ژمارەی هەژمار لەبەرگیرا',
    amountWithin: 'بڕ، لە سنووری باڵانسی بەردەستت',
    optional: 'ئارەزوومەندانە',
    confirmDeposit: 'دڵنیاکردنەوەی دانان',
    confirmWithdraw: 'دڵنیاکردنەوەی دەرهێنان',
    channelRequired: 'سەرەتا کەناڵێک هەڵبژێرە',
    accountRequired2: 'ژمارەی هەژمار بنووسە',
    summary: 'کورتە',
    stepOf: 'هەنگاوی {n} لە 3',
    title: 'جزدان',
    back: 'گەڕانەوە',
    available: 'باڵانسی بەردەست',
    availableHint: 'ئێستا دەتوانرێت خەرج بکرێت',
    held: 'گیراو',
    heldHint: 'گیراوە بۆ داواکاری کێشانەوە یان کڕینێکی کراوە',
    pendingDeposits: 'دانانەکان لە پێداچوونەوەدان',
    pendingHint: 'هیچ باڵانسێکی خەرجکراو زیاد ناکات پێش پەسەندکردن',
    pendingWithdrawals: 'کێشانەوەی کراوە',
    settled: 'باڵانسی جێگیر',
    points: 'خاڵەکان',
    addFunds: 'زیادکردنی باڵانس',
    withdraw: 'کێشانەوە',
    activity: 'کردارەکان',
    withdrawalRequests: 'داواکاری کێشانەوە',
    noActivity: 'هێشتا هیچ کردارێک نییە',
    noActivityHint: 'دانان و کێشانەوەکان لێرە بە ژمارە و دۆخیانەوە دەردەکەون.',
    noWithdrawals: 'هیچ داواکاری کێشانەوە نییە',
    filterAll: 'هەموو',
    filterDeposit: 'دانان',
    filterWithdrawal: 'کێشانەوە',
    statusAll: 'هەموو دۆخەکان',
    statusPending: 'لە پێداچوونەوەدا',
    statusApproved: 'پەسەندکراو',
    statusRejected: 'ڕەتکراوە',
    searchPlaceholder: 'گەڕان بە ژمارەی کردار یان تێبینی',
    operationNumber: 'ژمارەی کردار',
    receipt: 'بەڵگە',
    requestReview: 'داوای پێداچوونەوە',
    reviewRequested: 'داوای پێداچوونەوە کراوە',
    reviewTitle: 'داوای پێداچوونەوەی کردار',
    reviewReason: 'ڕوونی بکەوە چی هەڵەیە',
    reviewSubmitted: 'داواکاری پێداچوونەوە تۆمارکرا.',
    amount: 'بڕ',
    amountIqd: 'بڕ (د.ع)',
    amountUsd: 'بڕ (دۆلار)',
    note: 'تێبینی (ئارەزوومەندانە)',
    notePlaceholder: 'تێبینییەک زیاد بکە…',
    cancel: 'هەڵوەشاندنەوە',
    submit: 'ناردنی داواکاری',
    submitting: 'دەنێردرێت…',
    depositTitle: 'زیادکردنی باڵانس',
    depositIntro: 'بۆ یەکێک لە هەژمارەکانی خوارەوە بگوازەوە، پاشان بەڵگە بنێرە — هەموو دانانێک پێداچوونەوەی بۆ دەکرێت.',
    depositMethods: 'ڕێگاکانی پارەدان',
    noMethods: 'هێشتا هیچ ڕێگایەکی پارەدان زیاد نەکراوە — پەیوەندی بە پشتگیری بکە.',
    reference: 'ژمارەی ئاماژەی گواستنەوە',
    referenceHint: 'ڕێگری دەکات هەمان گواستنەوە دوو جار بژمێردرێت.',
    channel: 'هەژمار/کەناڵ',
    receiptLabel: 'وێنەی بەڵگە',
    receiptUploaded: 'بەڵگە بارکرا — بۆ گۆڕین دابگرە',
    receiptUpload: 'بۆ بارکردنی وێنە دابگرە',
    uploading: 'باردەکرێت…',
    depositSubmitted: 'داواکاری دانان تۆمارکرا وەک «لە پێداچوونەوەدا». هیچ باڵانسێک زیاد ناکرێت پێش پشتڕاستکردنەوە.',
    withdrawTitle: 'کێشانەوەی باڵانس',
    withdrawIntro: 'بڕەکە یەکسەر لە باڵانسی بەردەستت دەگیرێت و تەنها دوای گواستنەوەیەکی پشتڕاستکراو دەدرێت.',
    destinationKind: 'ڕێگای وەرگرتن',
    destinationAccount: 'ژمارەی هەژمار/جزدان',
    destinationHolder: 'ناوی خاوەن هەژمار',
    destinationFrozen: 'زانیاری مەبەست لە کاتی پشتڕاستکردنەوە جێگیر دەکرێت؛ گۆڕینی داواکاریەکی نوێ دەوێت.',
    feePreview: 'کرێ و پاکی',
    feeNotConfigured: 'هێشتا هیچ سیاسەتێکی کرێی کێشانەوە پەسەند نەکراوە، بۆیە ڕێژەیەکی داهێنراو پیشان نادەین: پاکی = بڕی داواکراو.',
    feeDeducted: 'کرێ لە بڕی داواکراو کەم دەکرێتەوە: پاکی پێت دەگات، و بڕی داواکراو بە تەواوی لە باڵانسەکەت دەگیرێت.',
    fee: 'کرێ',
    net: 'پاکی چاوەڕوانکراو',
    withdrawSubmitted: 'داواکاری کێشانەوە تۆمارکرا و بڕەکە گیرا. پەسەندکردن دەستپێکردنی پرۆسەیە، نەک گواستنەوە.',
    availableAfter: 'بەردەست دوای گرتن',
    insufficient: 'بڕەکە لە باڵانسی بەردەستت زیاترە',
    cancelRequest: 'هەڵوەشاندنەوەی داواکاری',
    cancelling: 'هەڵدەوەشێندرێتەوە…',
    cancelled: 'داواکاری هەڵوەشێندرایەوە و بڕە گیراوەکە ئازاد کرا.',
    destination: 'مەبەست',
    payoutRef: 'ئاماژەی گواستنەوە',
    reason: 'هۆکار',
    needsReconciliation: 'ئەنجامی گواستنەوە پشتڕاست نەکراوە — لە پرۆسەی لێکدانەوەدایە.',
    stateRequested: 'تۆمارکراو',
    stateApproved: 'پەسەندکراو بۆ پرۆسە',
    stateProcessing: 'لە پرۆسەدا',
    statePaid: 'گوازرایەوە',
    stateRejected: 'ڕەتکراوە',
    stateCancelled: 'هەڵوەشێنراوە',
    stateFailed: 'شکستی هێنا',
    approvedNotSent: 'پەسەندکردن ≠ ناردن',
    retry: 'دووبارە هەوڵ بدە',
    refresh: 'نوێکردنەوە',
    loading: 'جزدان باردەکرێت',
    close: 'داخستن',
    required: 'پێویستە',
    invalidAmount: 'بڕێکی دروست بنووسە',
    receiptRequired: 'وێنەی بەڵگە پێویستە بۆ دانان',
    accountRequired: 'مەبەستێکی دروست بنووسە',
    reasonRequired: 'هۆکارێکی ڕوون بنووسە (لانیکەم ٥ پیت)',
    pointsNote: 'خاڵەکان باڵانسێکی جیاوازن و هەرگیز نابنە کێشانەوەی نەقدی.',
  },
};

interface TxView {
  id: string;
  type: 'deposit' | 'withdrawal';
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  date: string;
  note: string;
  adminNote?: string;
  receiptUrl: string | null;
  number: string;
  reviewRequested: boolean;
  depositContext: {
    provider: string;
    channel: string;
    reference: string;
    review_state: string;
    /**
     * The dinars the customer actually typed (migration 0105), or null for a
     * deposit filed before the column existed / typed in dollars. Read, never
     * recomputed — see `depositDeclaredIqd` in src/lib/api.ts for why the
     * cents cannot be converted back to it.
     */
    declared_amount_iqd: number | null;
    exchange_rate_snapshot: number | null;
  } | null;
}

type WithdrawalState = 'requested' | 'approved' | 'processing' | 'paid' | 'rejected' | 'cancelled' | 'failed';

interface WithdrawalView {
  id: string;
  /**
   * The wallet transaction this request produced. It is how the two lists the
   * server sends are one list really: a withdrawal request and its ledger
   * entry are the same event seen from two tables.
   */
  tx_id: string | null;
  number: string;
  amount_usd_cents: number;
  fee_cents: number;
  net_cents: number;
  fee_configured: boolean;
  state: WithdrawalState;
  money_sent: boolean;
  needs_reconciliation: boolean;
  destination: { kind: string; account: string; holder: string; note: string; frozen_at: string };
  payout_reference: string | null;
  outcome_reason: string | null;
  created_at: string;
}

/** One row of the merged list: a ledger entry, a withdrawal request, or both. */
interface Operation {
  key: string;
  kind: 'deposit' | 'withdrawal';
  at: string;
  amount: number;
  tx: TxView | null;
  withdrawal: WithdrawalView | null;
}

interface Balances {
  usd_cents_settled: number;
  usd_cents_held: number;
  usd_cents_available: number;
  usd_cents_pending_deposits: number;
  usd_cents_pending_withdrawals: number;
  points_settled: number;
  points_pending: number;
}

interface WalletResponse {
  balance_usd_cents: number;
  point_balance: number;
  transactions: TxView[];
  balances: Balances;
  withdrawals: WithdrawalView[];
}

const EMPTY_BALANCES: Balances = {
  usd_cents_settled: 0,
  usd_cents_held: 0,
  usd_cents_available: 0,
  usd_cents_pending_deposits: 0,
  usd_cents_pending_withdrawals: 0,
  points_settled: 0,
  points_pending: 0,
};

const PAYOUT_KINDS = ['manual_transfer', 'zaincash', 'fib', 'bank_account'] as const;

export default function Wallet() {
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const s = STRINGS[(lang as Lang) in STRINGS ? (lang as Lang) : 'ar'];
  const isRtl = dir === 'rtl';

  const { paymentMethods, currency: defaultCurrency, exchangeRate, refreshWallet } = useWallet();
  const { currency: siteCurrency } = useMoney();

  /**
   * PAGE-LOCAL, BUT IT OPENS ON THE SAME ANSWER AS THE REST OF THE SHOP.
   *
   * This toggle predates the site-wide currency setting and is kept: the
   * wallet's ledger is genuinely USD cents (migrations/0001_init.sql), so
   * reading a BALANCE in dollars is a different question from reading a PRICE
   * in dollars, and someone reconciling a deposit wants to flip it without
   * changing how the catalogue reads.
   *
   * What it must not do is contradict the setting on arrival. Two controls
   * disagreeing about the same word on first paint is the confusion this shop
   * removes, not adds: the site preference seeds it, the store's own default
   * is the fallback for a browser that has never answered.
   */
  const [currency, setCurrency] = useState<'IQD' | 'USD'>(siteCurrency ?? defaultCurrency);
  const [balances, setBalances] = useState<Balances>(EMPTY_BALANCES);
  const [transactions, setTransactions] = useState<TxView[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [banner, setBanner] = useState<string>('');
  const [actionError, setActionError] = useState<string>('');

  // Filters (server-side; the browser never re-derives balances from them).
  const [typeFilter, setTypeFilter] = useState<'all' | 'deposit' | 'withdrawal'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  /**
   * WHY THE WINDOWS ARE NOT MOUNTED BY THEIR OWN STATE ANY MORE.
   *
   * Both money dialogs used to be written `{modal && <RequestModal …/>}`, which
   * meant the component was destroyed the instant the flag went false. A
   * destroyed component cannot animate: the window appeared from nowhere and
   * then simply ceased to exist, which is exactly the disappearance Apple's
   * spatial-consistency rule is about — if it does not leave the way it came,
   * there is nothing for a person to build a mental model out of.
   *
   * So the flag now only drives `open`, and the component stays mounted long
   * enough to play its exit. Two pieces of bookkeeping fall out of that, and
   * both matter more here than anywhere else in the app because this page moves
   * money:
   *
   *   `modalKind` remembers WHICH form is on screen, so the panel keeps its
   *   content and its heading for the length of the exit instead of blanking
   *   to the other form's copy on the way out.
   *
   *   `modalSession` restores what the unmount used to do for free: a fresh
   *   `key` per opening throws the old instance away, so the step, the typed
   *   amount, the uploaded receipt and — critically — the per-form idempotency
   *   key are all regenerated. Without it a second deposit would inherit the
   *   first one's key and the server would reject or dedupe it. The count also
   *   gates the first mount, so the form does not exist at all until it has
   *   been asked for once.
   */
  const [modal, setModal] = useState<'deposit' | 'withdrawal' | null>(null);
  const [modalKind, setModalKind] = useState<'deposit' | 'withdrawal'>('deposit');
  const [modalSession, setModalSession] = useState(0);
  const [reviewFor, setReviewFor] = useState<TxView | null>(null);
  const [reviewSession, setReviewSession] = useState(0);
  // The row being reviewed, held past the moment `reviewFor` clears so the
  // window still has its operation number to show while it leaves.
  const reviewTxRef = useRef<TxView | null>(null);
  const [cancellingId, setCancellingId] = useState<string>('');

  const openRequest = (which: 'deposit' | 'withdrawal') => {
    setModalKind(which);
    setModalSession((n) => n + 1);
    setModal(which);
  };

  const openReview = (tx: TxView) => {
    reviewTxRef.current = tx;
    setReviewSession((n) => n + 1);
    setReviewFor(tx);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (search) params.set('q', search);
      const qs = params.toString();
      const data = await api.get<WalletResponse>(`/api/wallet${qs ? `?${qs}` : ''}`);
      setBalances(data.balances ?? EMPTY_BALANCES);
      setTransactions(data.transactions ?? []);
      setWithdrawals(data.withdrawals ?? []);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * THE COMMISSION RATE COMES FROM THE SERVER, AND ONLY TO BE PRINTED.
   *
   * «عمولة للسحب بقدر 3% قابله للتغيير من الادارة.» The form must be able to
   * state the rate before any request exists, so it reads GET
   * /api/wallet/policy — the same route the quote is computed on. What it must
   * NOT do is multiply by 3% itself: a rate changed mid-session would show the
   * customer one number while the ledger wrote another, and nothing downstream
   * would catch it because the server's own arithmetic would stay consistent.
   * The figure that binds is the one stored on the row.
   *
   * A failed read leaves the rate at 0, which prints the old
   * «no fee policy has been approved» sentence rather than a guess.
   */
  const [feeBps, setFeeBps] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .get<{ withdrawal: { fee_bps: number } }>('/api/wallet/policy')
      .then((p) => {
        if (alive) setFeeBps(Number(p.withdrawal?.fee_bps) || 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /** Format USD cents in the currently displayed currency. */
  const fmt = useCallback(
    (cents: number, showSymbol = true) => {
      if (currency === 'IQD') {
        const iqd = usdCentsToIqd(cents, exchangeRate);
        const formatted = iqd.toLocaleString('en-US', { maximumFractionDigits: 0 });
        return showSymbol ? `IQD ${formatted}` : formatted;
      }
      const formatted = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return showSymbol ? `$${formatted}` : formatted;
    },
    [currency, exchangeRate]
  );

  /**
   * A DEPOSIT ROW PRINTS THE NUMBER THE CUSTOMER TYPED.
   *
   * «كتبت ٥٠,٠٠٠ وظهر ٥٠,٠٠٨.» `fmt` converts the stored cents back to dinars,
   * and that conversion is not the inverse of the one the form did: at 1,400
   * IQD/USD a cent is 14 د.ع, so 50,000 has no cent value that reads back as
   * 50,000. Since migration 0105 the request records the typed figure, so a
   * deposit shows testimony rather than arithmetic.
   *
   * ONLY IN DINARS, AND ONLY FOR DEPOSITS. In USD the stored cents ARE the
   * customer's number, and a withdrawal records no declared dinars — printing
   * a typed figure there while the hold reserves the converted cents would be
   * the same defect wearing the other shirt. Everything else falls back to
   * `fmt`, which is still the only thing that formats a balance.
   */
  const fmtOperation = useCallback(
    (op: Operation) => {
      const declared = op.tx?.depositContext?.declared_amount_iqd;
      if (currency !== 'IQD' || op.kind !== 'deposit' || !op.tx) return fmt(op.amount);
      const iqd = depositDeclaredIqd(declared, op.amount, exchangeRate);
      return `IQD ${iqd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    },
    [currency, exchangeRate, fmt]
  );

  /**
   * ONE list of operations, as the owner asked: "دمج عمليات السحب والايداع في
   * قائمة العمليات".
   *
   * The server sends two arrays because they come from two tables — the wallet
   * ledger and the withdrawal-request register — but a withdrawal and its
   * ledger entry are the SAME EVENT, linked by tx_id. Showing them as two
   * sections made a customer count their money twice and then hunt for the
   * cancel button in the other list.
   *
   * So they are joined here, not concatenated: a withdrawal row carries its
   * destination, its state and its cancel button, and a request that has no
   * ledger entry yet still appears rather than vanishing until one exists.
   */
  const operations = useMemo<Operation[]>(() => {
    const byTx = new Map<string, WithdrawalView>();
    for (const w of withdrawals) if (w.tx_id) byTx.set(w.tx_id, w);

    const rows: Operation[] = transactions.map((tx) => ({
      key: tx.id,
      kind: tx.type,
      at: tx.date,
      amount: tx.amount,
      tx,
      withdrawal: byTx.get(tx.id) ?? null,
    }));

    // A request whose hold has not produced a visible ledger row yet — or one
    // the current filter excluded — must not disappear from the customer's
    // own record of what they asked for.
    const seen = new Set(rows.map((r) => r.withdrawal?.id).filter(Boolean));
    for (const w of withdrawals) {
      if (seen.has(w.id)) continue;
      if (typeFilter === 'deposit') continue;
      rows.push({ key: `wd_${w.id}`, kind: 'withdrawal', at: w.created_at, amount: w.amount_usd_cents, tx: null, withdrawal: w });
    }
    return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [transactions, withdrawals, typeFilter]);

  const stateLabel = (state: WithdrawalState) =>
    ({
      requested: s.stateRequested,
      approved: s.stateApproved,
      processing: s.stateProcessing,
      paid: s.statePaid,
      rejected: s.stateRejected,
      cancelled: s.stateCancelled,
      failed: s.stateFailed,
    })[state];

  const onCancelWithdrawal = async (id: string) => {
    setCancellingId(id);
    setBanner('');
    setActionError('');
    try {
      await api.post(`/api/wallet/withdrawals/${id}/cancel`);
      setBanner(s.cancelled);
      await Promise.all([load(), refreshWallet()]);
    } catch (e) {
      // The server's real reason (e.g. it is already being processed) — the
      // request is NOT reported as cancelled.
      setActionError((e as Error)?.message || '');
    } finally {
      setCancellingId('');
    }
  };

  const Back = isRtl ? ChevronRight : ChevronLeft;

  return (
    <div dir={dir} className="w-full bg-black min-h-screen font-sans flex flex-col pb-24">
      {/* ---------------------------------------------------------- header */}
      <div className="bg-gradient-to-b from-olive to-olive-dark rounded-b-[36px] pt-12 pb-8 px-5 sm:px-8 flex flex-col items-center relative border-b border-gold/10">
        <button
          onClick={() => navigate(-1)}
          aria-label={s.back}
          className="absolute start-5 top-12 p-2 bg-olive/40 hover:bg-olive/80 transition-colors rounded-full"
        >
          <Back className="w-5 h-5 text-gold" />
        </button>
        <button
          onClick={() => setCurrency(currency === 'USD' ? 'IQD' : 'USD')}
          className="absolute end-5 top-12 bg-olive/80 hover:bg-olive-light px-3 py-1.5 rounded-xl flex items-center gap-1.5 border border-gold/20 transition-transform active:scale-95"
        >
          <div className="bg-gold text-olive-dark rounded-[4px] p-0.5 flex items-center justify-center">
            {currency === 'USD' ? (
              <DollarSign className="w-3 h-3" strokeWidth={3} />
            ) : (
              <span className="text-[10px] font-bold leading-none px-0.5">ع.د</span>
            )}
          </div>
          <span className="text-gold font-bold text-[13px]">{currency}</span>
        </button>

        <h1 className="text-zinc-400 text-xs font-bold uppercase tracking-widest mt-1">{s.title}</h1>

        <div className="mt-6 flex flex-col items-center">
          <span className="text-zinc-400 text-[12px] font-bold">{s.available}</span>
          {loading ? (
            <Skeleton className="h-12 w-52 mt-2 rounded-2xl" />
          ) : (
            <span dir="ltr" className="text-[40px] sm:text-[52px] font-black text-gold tracking-tight leading-none mt-1">
              {/* A failed load shows a dash, never a fabricated zero balance. */}
              {loadError ? '—' : fmt(balances.usd_cents_available)}
            </span>
          )}
          <span className="text-zinc-500 text-[11px] mt-1">{s.availableHint}</span>
        </div>

        {/* THE THREE NUMBERS THE MANDATE REQUIRES SEPARATELY — «تظهر بسطرين».
            The labels are not the defect and are not shortened: «إيداعات قيد
            المراجعة» is the tile that must not be mistakable for money you can
            spend, and cutting it to «إيداعات» deletes the part doing the work.
            The GEOMETRY was the defect. A 3-up grid on a 390px phone left each
            label about 69px of text box — 20 Arabic characters at 10px cannot
            fit that — so below `sm` each tile is a full-width row with the
            label at the inline start and the number at the inline end, and the
            3-up returns at `sm`, where it already fitted. `truncate` +
            `whitespace-nowrap` are the belt-and-braces guard for a future
            longer string; with the stack they never engage.

            The hint stays only where it carries an honesty claim. The
            withdrawals tile used to repeat the HELD tile's sentence — «محجوز
            لطلب سحب أو شراء قائم» is the definition of *held*, not of *open
            withdrawals* — which made two of three mandated-distinct numbers
            read as the same thing. 9px is also below legibility for Arabic. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 w-full max-w-2xl mt-5">
          {[
            { label: s.held, hint: s.heldHint, value: balances.usd_cents_held, icon: <Lock className="w-3.5 h-3.5" /> },
            {
              label: s.pendingDeposits,
              hint: s.pendingHint,
              value: balances.usd_cents_pending_deposits,
              icon: <Clock className="w-3.5 h-3.5" />,
            },
            {
              label: s.pendingWithdrawals,
              hint: '',
              value: balances.usd_cents_pending_withdrawals,
              icon: <ArrowUp className="w-3.5 h-3.5" />,
            },
          ].map((card) => (
            <div key={card.label} className="bg-black/30 border border-white/10 rounded-2xl p-2.5 sm:text-center">
              <div className="flex items-center justify-between gap-3 sm:block">
                <div className="flex items-center gap-1 min-w-0 text-zinc-400 text-[10px] font-bold sm:justify-center">
                  <span className="shrink-0">{card.icon}</span>
                  <span className="truncate whitespace-nowrap">{card.label}</span>
                </div>
                {loading ? (
                  <Skeleton className="h-5 w-16 rounded sm:mx-auto sm:mt-2" />
                ) : (
                  <div dir="ltr" className="text-white font-bold text-[15px] shrink-0 sm:mt-1">
                    {loadError ? '—' : fmt(card.value)}
                  </div>
                )}
              </div>
              {card.hint ? (
                <div className="text-zinc-500 text-[10px] mt-1 leading-snug">{card.hint}</div>
              ) : null}
            </div>
          ))}
        </div>

        {/* «الرصيد المسوّى» SPLIT ACROSS TWO LINES because the whole sentence —
            two label/value pairs plus the points note — was one run of
            space-separated text, so the break landed wherever it landed,
            including between «الرصيد» and «المسوّى». Each pair is now its own
            non-breaking unit and the note has its own line. The line may still
            wrap BETWEEN the pairs; what it can no longer do is split a label
            from itself. */}
        <div className="text-zinc-500 text-[10px] mt-3 text-center max-w-md leading-relaxed">
          <span className="whitespace-nowrap">
            {s.settled}: <span dir="ltr">{loadError ? '—' : fmt(balances.usd_cents_settled)}</span>
          </span>
          <span aria-hidden className="mx-1.5">·</span>
          <span className="whitespace-nowrap">
            {s.points}: <span dir="ltr">{loadError ? '—' : balances.points_settled.toLocaleString('en-US')}</span>
          </span>
          <span className="block mt-0.5">{s.pointsNote}</span>
        </div>
      </div>

      {/* --------------------------------------------------------- actions */}
      <div className="flex justify-center items-center gap-3 py-5 px-5">
        {/* One primary action, one secondary — the old pair were identical
            olive slabs, so neither read as the thing you came here to do. */}
        <button
          onClick={() => openRequest('withdrawal')}
          disabled={loading || !!loadError}
          className="flex-1 max-w-[240px] min-h-12 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 transition-colors text-white rounded-2xl flex items-center justify-center gap-2 font-bold text-[15px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {s.withdraw}
          <ArrowUp className="w-4 h-4" strokeWidth={3} />
        </button>
        <button
          onClick={() => openRequest('deposit')}
          className="flex-1 max-w-[240px] min-h-12 bg-gold hover:bg-gold-light transition-colors text-black rounded-2xl flex items-center justify-center gap-2 font-black text-[15px]"
        >
          <ArrowDown className="w-4 h-4" strokeWidth={3} />
          {s.addFunds}
        </button>
      </div>

      {banner && (
        <div role="status" className="mx-5 mb-4 bg-[#59A846]/10 border border-[#59A846]/40 text-[#9fd58f] text-xs font-medium rounded-2xl p-3 text-center">
          {banner}
        </div>
      )}
      {actionError && (
        <div role="alert" className="mx-5 mb-4 bg-[#B03142]/10 border border-[#B03142]/40 text-[#e4899a] text-xs font-medium rounded-2xl p-3 text-center">
          {actionError}
        </div>
      )}

      <div className="flex-1 px-4 sm:px-6 pt-2 pb-10">
        {/* ------------------------------------------------- one operations list
            The owner asked for the two lists to become one: "دمج عمليات السحب
            والايداع في قائمة العمليات". A withdrawal row keeps everything the
            separate list used to carry — its destination, its state, its
            cancel button and its reconciliation warning — so nothing was lost
            in the merge, only the second place to look. */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-white font-bold text-[15px]">{s.operations}</h2>
            <button
              onClick={() => void load()}
              className="text-zinc-400 hover:text-white text-[11px] font-bold flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> {s.refresh}
            </button>
          </div>

          {/* «الفلاتر كبيرة». Three things made this row loud, and none of
              them was the declared font size.

              The chips were `bg-gold text-black border-gold` — gold fill, gold
              border AND inverted text, three cues at once on one control, which
              the project's own apple-design skill forbids (§3, §7). They are
              the shared `Segmented` primitive now: equal columns, ONE moving
              indicator, real radiogroup semantics, RTL-aware arrow keys, and a
              44px minimum per option — which the hand-rolled chips only reached
              by accident of flex stretch.

              The row had no `align-items`, so it stretched every item to the
              tallest on its line. The tallest is the select, which src/index.css
              raises to 16px under `(pointer: coarse)` — the deliberate anti-zoom
              floor with tests/inputZoom.test.ts behind it. `items-center` is the
              load-bearing token that stops the select inflating its neighbours;
              lowering that floor to "fix" the size would bring the typing-zoom
              bug back and is not on the table.

              `text-[12px]` is dropped from both fields for the same reason: on
              every touch device the floor overrides it, so the number was a lie
              to the next reader. `min-h-11` states the real target instead. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
            <Segmented
              group="wallet-type"
              label={s.operations}
              value={typeFilter}
              onChange={(id) => setTypeFilter(id as typeof typeFilter)}
              items={[
                { id: 'all', label: s.filterAll },
                { id: 'deposit', label: s.filterDeposit },
                { id: 'withdrawal', label: s.filterWithdrawal },
              ]}
              className="w-full sm:w-auto sm:min-w-[220px]"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="min-h-11 w-full sm:w-auto bg-zinc-900/60 border border-zinc-800 rounded-xl px-3 text-zinc-200 font-bold focus:outline-none focus:border-zinc-600"
            >
              <option value="all">{s.statusAll}</option>
              <option value="pending">{s.statusPending}</option>
              <option value="approved">{s.statusApproved}</option>
              <option value="rejected">{s.statusRejected}</option>
            </select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(searchInput.trim());
              }}
              className="flex items-center gap-2 w-full sm:flex-1 sm:w-auto sm:min-w-[160px]"
            >
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-3" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={s.searchPlaceholder}
                  className="min-h-11 w-full bg-zinc-900/60 border border-zinc-800 rounded-xl ps-9 pe-3 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
                />
              </div>
            </form>
          </div>

          {loading ? (
            <SkeletonGroup label={s.loading} className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[76px] w-full rounded-2xl" />
              ))}
            </SkeletonGroup>
          ) : loadError ? (
            <ErrorState error={loadError} onRetry={() => void load()} />
          ) : operations.length === 0 ? (
            <EmptyState title={s.noActivity} description={s.noActivityHint} />
          ) : (
            <div className="space-y-3">
              {operations.map((op) => {
                const tx = op.tx;
                const w = op.withdrawal;
                const isDeposit = op.kind === 'deposit';
                // A withdrawal's own state is more precise than the ledger's
                // three-way status — "approved" there means processing has
                // been authorised, not that money moved — so it wins when
                // both exist.
                const badge = w
                  ? {
                      text: stateLabel(w.state),
                      tone:
                        w.state === 'paid'
                          ? 'bg-[#59A846]/15 text-[#8fd07c]'
                          : w.state === 'rejected' || w.state === 'failed' || w.state === 'cancelled'
                            ? 'bg-[#B03142]/15 text-[#e4899a]'
                            : 'bg-yellow-500/15 text-yellow-400',
                    }
                  : {
                      text:
                        tx?.status === 'pending'
                          ? s.statusPending
                          : tx?.status === 'approved'
                            ? s.statusApproved
                            : s.statusRejected,
                      tone:
                        tx?.status === 'pending'
                          ? 'bg-yellow-500/15 text-yellow-400'
                          : tx?.status === 'approved'
                            ? 'bg-[#59A846]/15 text-[#8fd07c]'
                            : 'bg-[#B03142]/15 text-[#e4899a]',
                    };
                return (
                  <div key={op.key} data-wallet-operation className="bg-zinc-900/60 rounded-2xl p-4 border border-zinc-800">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                            isDeposit ? 'bg-[#59A846]/15' : 'bg-[#B03142]/15'
                          }`}
                        >
                          {isDeposit ? (
                            <ArrowDownLeft className="w-5 h-5 text-[#8fd07c]" />
                          ) : (
                            <ArrowUp className="w-5 h-5 text-[#e4899a]" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-white font-bold text-[14px] truncate">
                            {tx?.note || (isDeposit ? s.filterDeposit : s.filterWithdrawal)}
                          </h3>
                          <div className="text-zinc-400 text-[11px] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span dir="ltr">{tx?.number ?? w?.number}</span>
                            <span>{new Date(op.at).toLocaleDateString()}</span>
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${badge.tone}`}>
                              {!w && tx?.status === 'pending' && <Clock className="w-3 h-3" />}
                              {!w && tx?.status === 'approved' && <CheckCircle className="w-3 h-3" />}
                              {!w && tx?.status === 'rejected' && <XCircle className="w-3 h-3" />}
                              {badge.text}
                            </span>
                            {w?.state === 'approved' && (
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-zinc-800 text-zinc-300">
                                {s.approvedNotSent}
                              </span>
                            )}
                            {tx?.receiptUrl && (
                              <a
                                href={tx.receiptUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-zinc-300 hover:text-white underline text-[10px] font-bold"
                              >
                                <Receipt className="w-3 h-3" /> {s.receipt}
                              </a>
                            )}
                          </div>
                          {/* Everything the separate withdrawals list used to
                              show, kept on the row it belongs to. */}
                          {w && (
                            <div className="text-zinc-500 text-[11px] mt-1.5 space-y-0.5">
                              <div>
                                {s.destination}: <span dir="ltr">{w.destination.kind} · {w.destination.account}</span>
                              </div>
                              {w.payout_reference && (
                                <div>
                                  {s.payoutRef}: <span dir="ltr">{w.payout_reference}</span>
                                </div>
                              )}
                              {w.outcome_reason && <div>{s.reason}: {w.outcome_reason}</div>}
                            </div>
                          )}
                          {tx?.adminNote ? <p className="text-zinc-500 text-[11px] mt-1">{tx.adminNote}</p> : null}
                        </div>
                      </div>
                      <div className="text-end shrink-0">
                        <span dir="ltr" className={`font-bold text-[16px] ${isDeposit ? 'text-[#8fd07c]' : 'text-[#e4899a]'}`}>
                          {isDeposit ? '+' : '-'}
                          {fmtOperation(op)}
                        </span>
                        <div className="mt-2 flex flex-col items-end gap-1.5">
                          {w && (w.state === 'requested' || w.state === 'approved') && (
                            <button
                              onClick={() => onCancelWithdrawal(w.id)}
                              disabled={cancellingId === w.id}
                              className="text-[10px] font-bold text-[#e4899a] hover:text-white border border-[#B03142]/40 rounded-lg px-2.5 py-1.5 disabled:opacity-60"
                            >
                              {cancellingId === w.id ? s.cancelling : s.cancelRequest}
                            </button>
                          )}
                          {tx &&
                            (tx.reviewRequested ? (
                              <span className="text-zinc-500 text-[10px] font-bold">{s.reviewRequested}</span>
                            ) : (
                              <button
                                onClick={() => openReview(tx)}
                                className="inline-flex items-center gap-1 text-zinc-400 hover:text-white text-[10px] font-bold"
                              >
                                <HelpCircle className="w-3 h-3" /> {s.requestReview}
                              </button>
                            ))}
                        </div>
                      </div>
                    </div>
                    {w?.needs_reconciliation && (
                      <div className="mt-3 flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-2.5 text-[11px] text-yellow-200">
                        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{s.needsReconciliation}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {modalSession > 0 && (
        <RequestModal
          key={modalSession}
          open={modal !== null}
          kind={modalKind}
          s={s}
          lang={lang}
          currency={currency}
          exchangeRate={exchangeRate}
          available={balances.usd_cents_available}
          paymentMethods={paymentMethods}
          feeBps={feeBps}
          fmt={fmt}
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            setBanner(message);
            await Promise.all([load(), refreshWallet()]);
          }}
        />
      )}

      {reviewSession > 0 && reviewTxRef.current && (
        <ReviewModal
          key={reviewSession}
          open={reviewFor !== null}
          s={s}
          tx={reviewTxRef.current}
          onClose={() => setReviewFor(null)}
          onDone={async () => {
            setReviewFor(null);
            setBanner(s.reviewSubmitted);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- modals

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-gold/60 text-[10px] font-bold mb-1.5 uppercase tracking-wider">{label}</label>
      {children}
      {hint ? <p className="text-gold/35 text-[10px] mt-1 leading-snug">{hint}</p> : null}
    </div>
  );
}

const inputClass =
  'w-full bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3.5 text-white text-sm placeholder-zinc-500 focus:outline-none focus:border-gold/60 transition-colors';

/** Owner-authored names for the payout channels. Never machine-translated. */
const PAYOUT_KIND_LABELS: Record<string, { ar: string; en: string; ckb: string }> = {
  manual_transfer: { ar: 'تحويل يدوي', en: 'Manual transfer', ckb: 'گواستنەوەی دەستی' },
  zaincash: { ar: 'زين كاش', en: 'ZainCash', ckb: 'زەین کاش' },
  fib: { ar: 'FIB', en: 'FIB', ckb: 'FIB' },
  bank_account: { ar: 'حساب مصرفي', en: 'Bank account', ckb: 'هەژماری بانکی' },
};

/**
 * The deposit and withdrawal form, as three steps.
 *
 * WHY IT IS STEPPED NOW. It used to be one scroll of eight fields, and the
 * owner reported it as broken: "هناك مشكلة في النافذة المنبثقة للسحب والايداع
 * واريد العمليه بسيطه". Two things were wrong with it. It asked for a
 * transfer reference and an account-holder name that nothing required, so the
 * shortest path to depositing money was buried; and it was rendered inline,
 * where an ancestor's transform makes `position: fixed` stop meaning the
 * viewport — the same bug that put the order modal at the bottom of the page.
 * It is portalled to document.body now — by `Overlay`, which owns the portal
 * along with the scrim, the material and the motion.
 *
 * The steps are exactly the owner's order:
 *
 *   deposit     القناة → المبلغ → الصورة (والملاحظات اختيارية)
 *   withdrawal  القناة ورقم الحساب → المبلغ (ضمن الرصيد) → الملاحظات
 *
 * Each step refuses to advance until its own field is valid, so an error can
 * never be about something two screens back.
 */
function RequestModal({
  open,
  kind,
  s,
  lang,
  currency,
  exchangeRate,
  available,
  paymentMethods,
  feeBps,
  fmt,
  onClose,
  onDone,
}: {
  open: boolean;
  kind: 'deposit' | 'withdrawal';
  s: Record<string, string>;
  lang: string;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  available: number;
  paymentMethods: { id: string; name: string; details: string }[];
  /** Commission in basis points, as the server reports it. Display only. */
  feeBps: number;
  fmt: (cents: number, showSymbol?: boolean) => string;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('');
  const [channel, setChannel] = useState('');
  const [receiptKey, setReceiptKey] = useState('');
  /**
   * The owner's own first channel when there is one, the legacy default
   * otherwise. NOT prefilled with `m.details`: that is the SHOP's account
   * number, and a withdrawal goes to the CUSTOMER's.
   */
  const [destinationKind, setDestinationKind] = useState<string>(paymentMethods[0]?.id ?? PAYOUT_KINDS[0]);
  const [destinationAccount, setDestinationAccount] = useState('');
  const [copied, setCopied] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // One key per open form: retrying a failed submit must not create a second
  // request, and the server refuses the same key with different details.
  const idempotencyKeyRef = useRef<string>(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const rawAmount = Number(amount.replace(/,/g, ''));
  const amountCents =
    Number.isFinite(rawAmount) && rawAmount > 0
      ? currency === 'IQD'
        ? iqdToUsdCents(rawAmount, exchangeRate)
        : Math.round(rawAmount * 100)
      : 0;
  /**
   * THE TYPED DINARS, KEPT AS TYPED.
   *
   * `amountCents` above is and stays the money — it is what is sent, what is
   * held, and what a credit is computed from. This is the same figure BEFORE
   * the conversion, and it exists because the conversion has no inverse: at
   * 1,400 IQD/USD, 50,000 د.ع becomes 3,572 cents and reads back as 50,008,
   * which is the number the customer, the admin panel and the Telegram card
   * were all showing for a transfer of 50,000.
   *
   * It is sent only for a DEPOSIT, because only a deposit records it
   * (migration 0105, `wallet_deposit_meta`). A withdrawal has nowhere to put
   * it, so the withdrawal screens keep printing the converted amount — the
   * figure that is actually reserved — rather than a typed number the ledger
   * would then disagree with.
   */
  const typedIqd = currency === 'IQD' && Number.isInteger(rawAmount) && rawAmount > 0 ? rawAmount : 0;
  /**
   * THE PREVIEW OF THE COMMISSION — the same arithmetic the server will run,
   * written once, here, and nowhere else on this page.
   *
   * Floor, because the server floors: the rounding goes to the customer. It is
   * a PREVIEW and says so by being recomputed from the live rate on every
   * keystroke; the figure that binds is the fee_cents the request stores when
   * it is filed, which is what every later screen reads. Deducted, never added
   * on top — `net` is what reaches the customer and `amountCents` is what
   * leaves the balance.
   */
  const feeCents = feeBps > 0 ? Math.floor((amountCents * feeBps) / 10_000) : 0;
  const netCents = amountCents - feeCents;
  const feePercentLabel = `${(feeBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  const amountLabel = kind === 'deposit' && typedIqd ? `IQD ${typedIqd.toLocaleString('en-US')}` : fmt(amountCents);
  const overBalance = kind === 'withdrawal' && amountCents > available;
  /**
   * THE WITHDRAWAL CHANNELS ARE THE DEPOSIT CHANNELS — «نفس قنوات الإيداع».
   *
   * The payout list used to be a four-item array compiled into this file, so
   * the owner could add Ki Card or Rafidain to the deposit screen and the
   * withdrawal screen would never hear about it. It now reads the SAME
   * admin-authored `paymentMethods` the deposit step reads, and falls back to
   * the four legacy ids only when the owner has published nothing.
   *
   * The channel NAME is one free-text string the admin typed, so it is not
   * trilingual — the same as the deposit list, and the same as an admin's own
   * content everywhere else. Everything around it stays in STRINGS.
   */
  const payoutChannels: { id: string; name: string }[] =
    paymentMethods.length > 0
      ? paymentMethods.map((m) => ({ id: m.id, name: m.name }))
      : PAYOUT_KINDS.map((k) => ({ id: k, name: payoutLabel(k) }));
  /**
   * A HISTORIC ROW STILL READS AS A NAME. A withdrawal filed as 'zaincash'
   * keeps that id forever, so the legacy labels stay even after the owner's
   * own list replaces them as the CHOICE — otherwise an old request would
   * render a raw id.
   */
  function payoutLabel(k: string): string {
    const configured = paymentMethods.find((m) => m.id === k);
    if (configured) return configured.name;
    return PAYOUT_KIND_LABELS[k]?.[lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'] ?? k;
  }

  const onAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    if (parts.length > 2) val = `${parts[0]}.${parts.slice(1).join('')}`;
    const finalParts = val.split('.');
    finalParts[0] = finalParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    setAmount(finalParts.join('.'));
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setError('');
    setReceiptKey('');
    try {
      const { key } = await uploadFile(file, 'receipt');
      setReceiptKey(key);
    } catch (err) {
      setError((err as Error)?.message || s.uploading);
      if (fileRef.current) fileRef.current.value = '';
    } finally {
      setUploading(false);
    }
  };

  /** What is still wrong with the CURRENT step, or '' when it may advance. */
  const stepProblem = (n: number): string => {
    if (n === 1) {
      if (kind === 'deposit') return method ? '' : s.channelRequired;
      return destinationAccount.trim().length >= 3 ? '' : s.accountRequired2;
    }
    if (n === 2) {
      if (!amountCents) return s.invalidAmount;
      if (overBalance) return s.insufficient;
      return '';
    }
    if (n === 3 && kind === 'deposit' && !receiptKey) return s.receiptRequired;
    return '';
  };

  const goNext = () => {
    const problem = stepProblem(step);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setStep((n) => Math.min(3, n + 1));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || uploading) return;
    // Re-checked at submit, not only per step: a customer can walk back and
    // empty a field they already passed.
    for (const n of [1, 2, 3]) {
      const problem = stepProblem(n);
      if (problem) {
        setStep(n);
        setError(problem);
        return;
      }
    }
    setError('');
    setSubmitting(true);
    try {
      if (kind === 'deposit') {
        await api.post('/api/wallet/deposits', {
          amount_usd_cents: amountCents,
          // Testimony alongside the money, never instead of it: the server
          // records it and credits the cents (migration 0105).
          declared_amount_iqd: typedIqd || undefined,
          note: note || undefined,
          paymentMethod: method || undefined,
          provider: method || undefined,
          channel: channel || undefined,
          receiptKey,
        });
        await onDone(s.depositSubmitted);
      } else {
        await api.post('/api/wallet/withdrawals', {
          amount_usd_cents: amountCents,
          note: note || undefined,
          destinationKind,
          destinationAccount: destinationAccount.trim(),
          idempotencyKey: idempotencyKeyRef.current,
        });
        await onDone(s.withdrawSubmitted);
      }
    } catch (err) {
      // The server's real message — never a fabricated success.
      setError((err as Error)?.message || '');
    } finally {
      setSubmitting(false);
    }
  };

  const stepTitles =
    kind === 'deposit'
      ? [s.stepChannel, s.stepAmount, s.stepProof]
      : [s.stepAccount, s.stepAmount, s.stepReview];

  /**
   * OVERLAY, NOT SHEET, even though it comes up from the bottom edge on a
   * phone. `Sheet` adds drag-to-dismiss, and this window is the one place in
   * the app where an accidental dismissal costs the customer real work: three
   * steps, a typed amount, a destination account, and an uploaded receipt that
   * would have to be uploaded again. Its panel is also the scroll container
   * (`max-h-[92vh] overflow-y-auto`), and a vertical drag competing with a
   * vertical scroll is the classic way a sheet ends up fighting the finger.
   * So it keeps `placement="bottom"` — the same geometry the hand-rolled
   * window had, `items-end sm:items-center` — and gains the arrival and the
   * symmetric exit without gaining a gesture that can throw the form away.
   *
   * DISMISSAL IS COPIED ACROSS EXACTLY. The old wrapper closed on a backdrop
   * click only when nothing was in flight (`!submitting && !uploading`), so
   * that is what `dismissOnScrim` is given rather than a flat `true` — a tap
   * outside must not abandon a deposit whose receipt is still uploading or
   * whose request is already on the wire. Escape is held to the same test: the
   * primitive owns the key handler now, and there was no Escape listener here
   * to delete.
   *
   * The material, the border and the rounding come from the primitive, so
   * `panelClassName` carries geometry only and the old inner padding moves to
   * a div inside.
   */
  return (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy="wallet-request-title"
      placement="bottom"
      z={120}
      dismissOnScrim={!submitting && !uploading}
      dismissOnEscape={!submitting && !uploading}
      testId={`wallet-${kind}`}
      panelClassName="w-full sm:max-w-[460px] max-h-[92vh] overflow-y-auto"
    >
      <div data-wallet-modal={kind} className="relative flex flex-col p-5 sm:p-6">
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="absolute top-4 end-4 text-zinc-400 hover:text-white bg-zinc-900 hover:bg-zinc-800 p-2 rounded-full"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 id="wallet-request-title" className="text-xl font-black text-white mb-1 text-center pe-10">
          {kind === 'deposit' ? s.depositTitle : s.withdrawTitle}
        </h2>

        {/* Where the customer is, and how much is left. Three dots beat a
            scrollbar for telling someone a form is nearly over. */}
        <div className="flex items-center justify-center gap-2 mb-4 mt-2">
          {stepTitles.map((title, i) => (
            <div key={title} className="flex items-center gap-2">
              <span
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors ${
                  step === i + 1
                    ? 'bg-gold text-black'
                    : step > i + 1
                      ? 'bg-zinc-800 text-zinc-300'
                      : 'bg-zinc-900 text-zinc-600'
                }`}
              >
                {title}
              </span>
              {i < 2 && <span className="w-3 h-px bg-zinc-700" />}
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div role="alert" className="bg-[#B03142]/10 border border-[#B03142]/40 text-[#e4899a] text-xs font-medium rounded-2xl p-3 text-center">
              {error}
            </div>
          )}

          {/* ------------------------------------------------------ step 1 */}
          {step === 1 && kind === 'deposit' && (
            <div className="space-y-2">
              <p className="text-zinc-400 text-xs leading-relaxed">{s.chooseChannelHint}</p>
              {paymentMethods.length === 0 ? (
                // No invented account numbers. If the owner has not published
                // a channel, saying so is the only honest screen.
                <p className="text-zinc-400 text-xs text-center py-6 bg-zinc-900 rounded-2xl border border-zinc-800">{s.noMethods}</p>
              ) : (
                paymentMethods.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => {
                      navigator.clipboard?.writeText(m.details).then(
                        () => setCopied(m.id),
                        () => setCopied('')
                      );
                      setMethod(m.name);
                      setChannel(m.details);
                    }}
                    className={`w-full flex justify-between items-center gap-3 p-3.5 rounded-2xl border transition-colors ${
                      method === m.name ? 'bg-zinc-800 border-gold/60' : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800'
                    }`}
                  >
                    <span className="text-white font-bold text-sm flex items-center gap-1.5 min-w-0 truncate">
                      {method === m.name && <CheckCircle className="w-4 h-4 text-gold shrink-0" />}
                      {m.name}
                    </span>
                    <span dir="ltr" className="text-zinc-300 font-mono bg-black/50 px-2 py-1 rounded-lg text-xs flex items-center gap-1.5 shrink-0">
                      {m.details}
                      <Copy className="w-3 h-3 text-zinc-500" />
                    </span>
                  </button>
                ))
              )}
              {copied && <p className="text-[#8fd07c] text-[11px] font-bold text-center">{s.copyDone}</p>}
            </div>
          )}

          {step === 1 && kind === 'withdrawal' && (
            <div className="space-y-4">
              <Field label={s.destinationKind}>
                <div className="grid grid-cols-2 gap-2">
                  {payoutChannels.map((ch) => (
                    <button
                      type="button"
                      key={ch.id}
                      onClick={() => setDestinationKind(ch.id)}
                      className={`min-h-11 px-3 py-3 rounded-2xl border text-sm font-bold transition-colors ${
                        destinationKind === ch.id
                          ? 'bg-zinc-800 border-gold/60 text-white'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <span className="block truncate">{ch.name}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={`${s.accountForChannel} *`} hint={s.destinationFrozen}>
                <input
                  dir="ltr"
                  value={destinationAccount}
                  onChange={(e) => setDestinationAccount(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                  required
                />
              </Field>
            </div>
          )}

          {/* ------------------------------------------------------ step 2 */}
          {step === 2 && (
            <div className="space-y-4">
              {kind === 'withdrawal' && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between">
                  <span className="text-zinc-400 font-medium text-sm">{s.available}</span>
                  <span dir="ltr" className="text-white font-bold text-lg">{fmt(available)}</span>
                </div>
              )}
              <Field
                label={currency === 'IQD' ? s.amountIqd : s.amountUsd}
                hint={kind === 'withdrawal' ? s.amountWithin : undefined}
              >
                <input
                  dir="ltr"
                  inputMode="decimal"
                  autoFocus
                  value={amount}
                  onChange={onAmountChange}
                  placeholder="0.00"
                  className={`${inputClass} font-bold text-lg`}
                  required
                />
              </Field>
              {kind === 'withdrawal' && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2">
                  <div className="flex justify-between text-xs text-zinc-400">
                    <span>
                      {s.fee}
                      {feeBps > 0 && <span dir="ltr"> ({feePercentLabel})</span>}
                    </span>
                    {feeBps > 0 ? (
                      <span dir="ltr">−{fmt(feeCents)}</span>
                    ) : (
                      <span aria-label={s.feeNotConfigured}>—</span>
                    )}
                  </div>
                  <div className="flex justify-between text-sm text-white font-bold">
                    <span>{s.net}</span>
                    <span dir="ltr">{fmt(netCents)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-zinc-400">
                    <span>{s.availableAfter}</span>
                    <span dir="ltr">{fmt(Math.max(available - amountCents, 0))}</span>
                  </div>
                  {/* The rate is stated when there is one and refused when
                      there is not — the old sentence is kept for feeBps === 0
                      rather than deleted, because that is still a real state. */}
                  <p className="text-zinc-500 text-[10px] leading-snug">
                    {feeBps > 0 ? s.feeDeducted : s.feeNotConfigured}
                  </p>
                  {overBalance && <p className="text-[#e4899a] text-[11px] font-bold">{s.insufficient}</p>}
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------------ step 3 */}
          {step === 3 && (
            <div className="space-y-4">
              {kind === 'deposit' && (
                <Field label={`${s.receiptLabel} *`}>
                  <div
                    className={`relative border-2 border-dashed rounded-2xl p-6 text-center transition-all bg-zinc-900 ${
                      uploading ? 'border-gold/50 cursor-wait' : 'border-zinc-700 hover:border-gold/50 cursor-pointer'
                    }`}
                  >
                    <input
                      type="file"
                      ref={fileRef}
                      accept="image/*"
                      onChange={onUpload}
                      disabled={uploading}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    {uploading ? (
                      <div className="flex flex-col items-center gap-2 text-zinc-300">
                        <Spinner size="md" decorative />
                        <span className="text-xs font-bold text-white">{s.uploading}</span>
                      </div>
                    ) : receiptKey ? (
                      <div className="flex flex-col items-center gap-2">
                        <CheckCircle className="w-6 h-6 text-[#8fd07c]" />
                        <span className="text-xs font-bold text-white">{s.receiptUploaded}</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1.5 text-zinc-400">
                        <Upload className="w-5 h-5" />
                        <span className="text-xs font-medium">{s.receiptUpload}</span>
                      </div>
                    )}
                  </div>
                </Field>
              )}

              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-1.5 text-xs">
                <h3 className="text-white font-bold text-[11px] uppercase tracking-wider mb-1">{s.summary}</h3>
                <div className="flex justify-between text-zinc-400">
                  <span>{kind === 'deposit' ? s.stepChannel : s.destinationKind}</span>
                  <span className="text-white font-bold">
                    {kind === 'deposit' ? method || '—' : payoutLabel(destinationKind)}
                  </span>
                </div>
                {kind === 'withdrawal' && (
                  <div className="flex justify-between text-zinc-400">
                    <span>{s.destinationAccount}</span>
                    <span dir="ltr" className="text-white font-mono">{destinationAccount || '—'}</span>
                  </div>
                )}
                <div className="flex justify-between text-zinc-400">
                  <span>{s.amount}</span>
                  <span dir="ltr" className="text-white font-bold">{amountLabel}</span>
                </div>
                {kind === 'withdrawal' && feeBps > 0 && (
                  <>
                    <div className="flex justify-between text-zinc-400">
                      <span>
                        {s.fee}
                        <span dir="ltr"> ({feePercentLabel})</span>
                      </span>
                      <span dir="ltr" className="text-white font-bold">−{fmt(feeCents)}</span>
                    </div>
                    <div className="flex justify-between text-zinc-400">
                      <span>{s.net}</span>
                      <span dir="ltr" className="text-white font-bold">{fmt(netCents)}</span>
                    </div>
                  </>
                )}
              </div>

              <Field label={`${s.note} — ${s.optional}`}>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={s.notePlaceholder}
                  className={`${inputClass} h-20 resize-none`}
                />
              </Field>

              <p className="text-zinc-500 text-[11px] leading-relaxed">
                {kind === 'deposit' ? s.depositIntro : s.withdrawIntro}
              </p>
            </div>
          )}

          <div className="pt-1 flex gap-3">
            <button
              type="button"
              onClick={() => (step === 1 ? onClose() : (setError(''), setStep((n) => n - 1)))}
              className="flex-1 px-4 py-3.5 rounded-2xl font-bold text-zinc-300 hover:text-white hover:bg-zinc-900 border border-zinc-800"
            >
              {step === 1 ? s.cancel : s.back2}
            </button>
            {step < 3 ? (
              <button
                type="button"
                onClick={goNext}
                className="flex-[2] bg-gold hover:bg-gold-light text-black font-black text-sm py-3.5 rounded-2xl transition-colors"
              >
                {s.next}
              </button>
            ) : (
              <button
                type="submit"
                disabled={submitting || uploading}
                className="flex-[2] bg-gold hover:bg-gold-light text-black font-black text-sm py-3.5 rounded-2xl disabled:opacity-70 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner size="sm" decorative /> {s.submitting}
                  </span>
                ) : kind === 'deposit' ? (
                  s.confirmDeposit
                ) : (
                  s.confirmWithdraw
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </Overlay>
  );
}

function ReviewModal({
  open,
  s,
  tx,
  onClose,
  onDone,
}: {
  open: boolean;
  s: Record<string, string>;
  tx: TxView;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (reason.trim().length < 5) {
      setError(s.reasonRequired);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.post(`/api/wallet/transactions/${tx.id}/review-request`, { reason: reason.trim() });
      await onDone();
    } catch (err) {
      setError((err as Error)?.message || '');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Portalled for the same reason as the request modal — under a transformed
   * ancestor `position: fixed` stops meaning the viewport, and the dialog lands
   * wherever that ancestor happens to be — except the portal, the scrim and the
   * `role="dialog"`/`aria-modal` pair now come from `Overlay` rather than being
   * spelled out here.
   *
   * `Overlay` and not `Sheet`: this is a short question about one operation,
   * not a surface you pull around, and dragging away a typed complaint is the
   * same loss as dragging away the deposit form. It keeps the bottom placement
   * it already had. The old markup had no accessible name at all — only
   * `role="dialog"` — so the heading it already shows on screen is given an id
   * and named through `labelledBy`, which is the label that was missing rather
   * than a new string. The backdrop closed it only when no request was in
   * flight, so `dismissOnScrim` and the newly-inherited Escape are both held to
   * that same `!submitting` test.
   */
  return (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy="wallet-review-title"
      placement="bottom"
      z={120}
      dismissOnScrim={!submitting}
      dismissOnEscape={!submitting}
      testId="wallet-review"
      panelClassName="w-full sm:max-w-[420px]"
    >
      <div data-wallet-review className="relative p-6">
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="absolute top-5 end-5 text-zinc-400 hover:text-white bg-zinc-900 hover:bg-zinc-800 p-2 rounded-full"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 id="wallet-review-title" className="text-xl font-black text-white mb-1 text-center pe-10">
          {s.reviewTitle}
        </h2>
        <p className="text-zinc-400 text-center text-xs mb-4" dir="ltr">
          {tx.number}
        </p>
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div role="alert" className="bg-[#B03142]/10 border border-[#B03142]/40 text-[#e4899a] text-xs rounded-2xl p-3 text-center">
              {error}
            </div>
          )}
          <Field label={s.reviewReason}>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} h-24 resize-none`} />
          </Field>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 rounded-2xl font-bold text-zinc-300 hover:text-white border border-zinc-800 hover:bg-zinc-900"
            >
              {s.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-[2] bg-gold hover:bg-gold-light text-black font-black text-sm py-3 rounded-2xl disabled:opacity-70 transition-colors"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner size="sm" decorative /> {s.submitting}
                </span>
              ) : (
                s.submit
              )}
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
