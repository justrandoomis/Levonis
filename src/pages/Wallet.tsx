import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';
import { api, uploadFile, usdCentsToIqd, iqdToUsdCents } from '../lib/api';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
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
  depositContext: { provider: string; channel: string; reference: string; review_state: string } | null;
}

type WithdrawalState = 'requested' | 'approved' | 'processing' | 'paid' | 'rejected' | 'cancelled' | 'failed';

interface WithdrawalView {
  id: string;
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

  // Display currency is a page-local preference only; stored money is USD cents.
  const [currency, setCurrency] = useState<'IQD' | 'USD'>(defaultCurrency);
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

  const [modal, setModal] = useState<'deposit' | 'withdrawal' | null>(null);
  const [reviewFor, setReviewFor] = useState<TxView | null>(null);
  const [cancellingId, setCancellingId] = useState<string>('');

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
      <div className="bg-[#0A1F18] rounded-b-[44px] pt-12 pb-8 px-5 sm:px-8 flex flex-col items-center relative">
        <button
          onClick={() => navigate(-1)}
          aria-label={s.back}
          className="absolute start-5 top-12 p-2 bg-[#0F2F25]/40 hover:bg-[#0F2F25]/80 transition-colors rounded-full"
        >
          <Back className="w-5 h-5 text-gold" />
        </button>
        <button
          onClick={() => setCurrency(currency === 'USD' ? 'IQD' : 'USD')}
          className="absolute end-5 top-12 bg-[#0F2F25]/80 hover:bg-[#184235] px-3 py-1.5 rounded-xl flex items-center gap-1.5 border border-gold/20 transition-transform active:scale-95"
        >
          <div className="bg-gold text-[#0A1F18] rounded-[4px] p-0.5 flex items-center justify-center">
            {currency === 'USD' ? (
              <DollarSign className="w-3 h-3" strokeWidth={3} />
            ) : (
              <span className="text-[10px] font-bold leading-none px-0.5">ع.د</span>
            )}
          </div>
          <span className="text-gold font-bold text-[13px]">{currency}</span>
        </button>

        <h1 className="text-gold/70 text-xs font-bold uppercase tracking-widest mt-1">{s.title}</h1>

        <div className="mt-6 flex flex-col items-center">
          <span className="text-gold/60 text-[12px] font-bold">{s.available}</span>
          {loading ? (
            <Skeleton className="h-12 w-52 mt-2 rounded-2xl" />
          ) : (
            <span dir="ltr" className="text-[40px] sm:text-[52px] font-black text-gold tracking-tight leading-none mt-1">
              {/* A failed load shows a dash, never a fabricated zero balance. */}
              {loadError ? '—' : fmt(balances.usd_cents_available)}
            </span>
          )}
          <span className="text-gold/40 text-[11px] mt-1">{s.availableHint}</span>
        </div>

        {/* The three numbers the mandate requires to be shown separately. */}
        <div className="grid grid-cols-3 gap-2 w-full max-w-2xl mt-6">
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
              hint: s.heldHint,
              value: balances.usd_cents_pending_withdrawals,
              icon: <ArrowUp className="w-3.5 h-3.5" />,
            },
          ].map((card) => (
            <div key={card.label} className="bg-[#0F2F25]/70 border border-gold/10 rounded-2xl p-3 text-center">
              <div className="flex items-center justify-center gap-1 text-gold/60 text-[10px] font-bold">
                {card.icon}
                <span>{card.label}</span>
              </div>
              {loading ? (
                <Skeleton className="h-5 w-16 mx-auto mt-2 rounded" />
              ) : (
                <div dir="ltr" className="text-gold font-bold text-[15px] mt-1">
                  {loadError ? '—' : fmt(card.value)}
                </div>
              )}
              <div className="text-gold/30 text-[9px] mt-1 leading-tight">{card.hint}</div>
            </div>
          ))}
        </div>

        <div className="text-gold/40 text-[10px] mt-3 text-center max-w-md">
          {s.settled}: <span dir="ltr">{loadError ? '—' : fmt(balances.usd_cents_settled)}</span> · {s.points}:{' '}
          <span dir="ltr">{loadError ? '—' : balances.points_settled.toLocaleString('en-US')}</span> — {s.pointsNote}
        </div>
      </div>

      {/* --------------------------------------------------------- actions */}
      <div className="flex justify-center items-center gap-3 py-5 px-5">
        <button
          onClick={() => setModal('withdrawal')}
          disabled={loading || !!loadError}
          className="flex-1 max-w-[240px] bg-[#184235] hover:bg-[#205242] transition-colors text-gold py-4 rounded-[20px] flex items-center justify-center gap-2 font-bold text-[15px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {s.withdraw}
          <ArrowUp className="w-4 h-4" strokeWidth={3} />
        </button>
        <button
          onClick={() => setModal('deposit')}
          className="flex-1 max-w-[240px] bg-[#184235] hover:bg-[#205242] transition-colors text-gold py-4 rounded-[20px] flex items-center justify-center gap-2 font-bold text-[15px]"
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

      <div className="bg-[#0A1F18] flex-1 rounded-t-[44px] px-4 sm:px-6 pt-7 pb-10">
        {/* ------------------------------------------------ withdrawals */}
        <section className="mb-8">
          <h2 className="text-gold font-bold text-[15px] mb-3">{s.withdrawalRequests}</h2>
          {loading ? (
            <SkeletonGroup label={s.loading} className="space-y-2">
              <Skeleton className="h-20 w-full rounded-2xl" />
              <Skeleton className="h-20 w-full rounded-2xl" />
            </SkeletonGroup>
          ) : loadError ? (
            <ErrorState compact error={loadError} onRetry={() => void load()} />
          ) : withdrawals.length === 0 ? (
            <EmptyState compact title={s.noWithdrawals} />
          ) : (
            <div className="space-y-3">
              {withdrawals.map((w) => (
                <div key={w.id} className="bg-[#0F2F25] border border-gold/10 rounded-[22px] p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gold font-bold text-[15px]" dir="ltr">
                          {fmt(w.amount_usd_cents)}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            w.state === 'paid'
                              ? 'bg-[#59A846]/10 text-[#59A846]'
                              : w.state === 'rejected' || w.state === 'failed' || w.state === 'cancelled'
                                ? 'bg-[#B03142]/10 text-[#B03142]'
                                : 'bg-yellow-500/10 text-yellow-500'
                          }`}
                        >
                          {stateLabel(w.state)}
                        </span>
                        {w.state === 'approved' && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gold/10 text-gold/80">
                            {s.approvedNotSent}
                          </span>
                        )}
                      </div>
                      <div className="text-gold/50 text-[11px] mt-1.5 space-y-0.5">
                        <div>
                          {s.operationNumber}: <span dir="ltr">{w.number}</span>
                        </div>
                        <div>
                          {s.destination}: <span dir="ltr">{w.destination.kind} · {w.destination.account}</span>
                        </div>
                        {w.payout_reference && (
                          <div>
                            {s.payoutRef}: <span dir="ltr">{w.payout_reference}</span>
                          </div>
                        )}
                        {w.outcome_reason && (
                          <div>
                            {s.reason}: {w.outcome_reason}
                          </div>
                        )}
                      </div>
                    </div>
                    {(w.state === 'requested' || w.state === 'approved') && (
                      <button
                        onClick={() => onCancelWithdrawal(w.id)}
                        disabled={cancellingId === w.id}
                        className="text-[11px] font-bold text-[#e4899a] hover:text-[#B03142] border border-[#B03142]/30 rounded-xl px-3 py-2 disabled:opacity-60"
                      >
                        {cancellingId === w.id ? s.cancelling : s.cancelRequest}
                      </button>
                    )}
                  </div>
                  {w.needs_reconciliation && (
                    <div className="mt-3 flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-2.5 text-[11px] text-yellow-200">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{s.needsReconciliation}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* --------------------------------------------------- operations */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-gold font-bold text-[15px]">{s.activity}</h2>
            <button
              onClick={() => void load()}
              className="text-gold/60 hover:text-gold text-[11px] font-bold flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> {s.refresh}
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            {(
              [
                ['all', s.filterAll],
                ['deposit', s.filterDeposit],
                ['withdrawal', s.filterWithdrawal],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTypeFilter(value)}
                className={`px-3 py-1.5 rounded-xl text-[12px] font-bold border transition-colors ${
                  typeFilter === value
                    ? 'bg-gold text-[#0A1F18] border-gold'
                    : 'bg-transparent text-gold/70 border-gold/20 hover:border-gold/50'
                }`}
              >
                {label}
              </button>
            ))}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="bg-black/30 border border-gold/20 rounded-xl px-3 py-1.5 text-gold/80 text-[12px] font-bold focus:outline-none focus:border-gold/50"
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
              className="flex items-center gap-2 flex-1 min-w-[180px]"
            >
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-gold/40 absolute top-1/2 -translate-y-1/2 start-3" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={s.searchPlaceholder}
                  className="w-full bg-black/30 border border-gold/20 rounded-xl ps-9 pe-3 py-1.5 text-gold text-[12px] placeholder-gold/30 focus:outline-none focus:border-gold/50"
                />
              </div>
            </form>
          </div>

          {loading ? (
            <SkeletonGroup label={s.loading} className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[76px] w-full rounded-[22px]" />
              ))}
            </SkeletonGroup>
          ) : loadError ? (
            <ErrorState error={loadError} onRetry={() => void load()} />
          ) : transactions.length === 0 ? (
            <EmptyState title={s.noActivity} description={s.noActivityHint} />
          ) : (
            <div className="space-y-3">
              {transactions.map((tx) => (
                <div key={tx.id} className="bg-[#0F2F25] rounded-[22px] p-4 border border-gold/10">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-[14px] flex items-center justify-center bg-[#184235] shrink-0">
                        {tx.type === 'deposit' ? (
                          <ArrowDownLeft className="w-5 h-5 text-gold" />
                        ) : (
                          <ArrowUp className="w-5 h-5 text-gold" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-gold font-bold text-[14px] truncate">
                          {tx.note || (tx.type === 'deposit' ? s.filterDeposit : s.filterWithdrawal)}
                        </h3>
                        <div className="text-gold/50 text-[11px] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span dir="ltr">{tx.number}</span>
                          <span>{new Date(tx.date).toLocaleDateString()}</span>
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                              tx.status === 'pending'
                                ? 'bg-yellow-500/10 text-yellow-500'
                                : tx.status === 'approved'
                                  ? 'bg-[#59A846]/10 text-[#59A846]'
                                  : 'bg-[#B03142]/10 text-[#B03142]'
                            }`}
                          >
                            {tx.status === 'pending' && <Clock className="w-3 h-3" />}
                            {tx.status === 'approved' && <CheckCircle className="w-3 h-3" />}
                            {tx.status === 'rejected' && <XCircle className="w-3 h-3" />}
                            {tx.status === 'pending'
                              ? s.statusPending
                              : tx.status === 'approved'
                                ? s.statusApproved
                                : s.statusRejected}
                          </span>
                          {tx.receiptUrl && (
                            <a
                              href={tx.receiptUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-gold/70 hover:text-gold underline text-[10px] font-bold"
                            >
                              <Receipt className="w-3 h-3" /> {s.receipt}
                            </a>
                          )}
                          {tx.depositContext?.reference && (
                            <span dir="ltr" className="text-gold/40">
                              {tx.depositContext.provider} · {tx.depositContext.reference}
                            </span>
                          )}
                        </div>
                        {tx.adminNote ? <p className="text-gold/40 text-[11px] mt-1">{tx.adminNote}</p> : null}
                      </div>
                    </div>
                    <div className="text-end shrink-0">
                      <span
                        dir="ltr"
                        className={`font-bold text-[16px] ${tx.type === 'deposit' ? 'text-[#59A846]' : 'text-[#B03142]'}`}
                      >
                        {tx.type === 'deposit' ? '+' : '-'}
                        {fmt(tx.amount)}
                      </span>
                      <div className="mt-2">
                        {tx.reviewRequested ? (
                          <span className="text-gold/50 text-[10px] font-bold">{s.reviewRequested}</span>
                        ) : (
                          <button
                            onClick={() => setReviewFor(tx)}
                            className="inline-flex items-center gap-1 text-gold/60 hover:text-gold text-[10px] font-bold"
                          >
                            <HelpCircle className="w-3 h-3" /> {s.requestReview}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {modal && (
        <RequestModal
          kind={modal}
          s={s}
          currency={currency}
          exchangeRate={exchangeRate}
          available={balances.usd_cents_available}
          paymentMethods={paymentMethods}
          fmt={fmt}
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            setBanner(message);
            await Promise.all([load(), refreshWallet()]);
          }}
        />
      )}

      {reviewFor && (
        <ReviewModal
          s={s}
          tx={reviewFor}
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
  'w-full bg-black/25 border border-gold/15 rounded-2xl px-4 py-3 text-gold text-sm placeholder-gold/30 focus:outline-none focus:border-gold/50 transition-colors';

function RequestModal({
  kind,
  s,
  currency,
  exchangeRate,
  available,
  paymentMethods,
  fmt,
  onClose,
  onDone,
}: {
  kind: 'deposit' | 'withdrawal';
  s: Record<string, string>;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  available: number;
  paymentMethods: { id: string; name: string; details: string }[];
  fmt: (cents: number, showSymbol?: boolean) => string;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('');
  const [channel, setChannel] = useState('');
  const [reference, setReference] = useState('');
  const [receiptKey, setReceiptKey] = useState('');
  const [destinationKind, setDestinationKind] = useState<string>(PAYOUT_KINDS[0]);
  const [destinationAccount, setDestinationAccount] = useState('');
  const [destinationHolder, setDestinationHolder] = useState('');
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
  const overBalance = kind === 'withdrawal' && amountCents > available;

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || uploading) return;
    setError('');
    if (!amountCents) {
      setError(s.invalidAmount);
      return;
    }
    if (kind === 'deposit' && !receiptKey) {
      setError(s.receiptRequired);
      return;
    }
    if (kind === 'withdrawal') {
      if (destinationAccount.trim().length < 3) {
        setError(s.accountRequired);
        return;
      }
      if (overBalance) {
        setError(s.insufficient);
        return;
      }
    }
    setSubmitting(true);
    try {
      if (kind === 'deposit') {
        await api.post('/api/wallet/deposits', {
          amount_usd_cents: amountCents,
          note: note || undefined,
          paymentMethod: method || undefined,
          provider: method || undefined,
          channel: channel || undefined,
          reference: reference || undefined,
          receiptKey,
        });
        await onDone(s.depositSubmitted);
      } else {
        await api.post('/api/wallet/withdrawals', {
          amount_usd_cents: amountCents,
          note: note || undefined,
          destinationKind,
          destinationAccount: destinationAccount.trim(),
          destinationHolder: destinationHolder.trim() || undefined,
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

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4">
      <div className="bg-[#0A1F18] border border-gold/20 rounded-t-[32px] sm:rounded-[32px] w-full sm:max-w-[460px] p-6 sm:p-7 relative flex flex-col max-h-[92vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="absolute top-5 end-5 text-gold/50 hover:text-gold bg-white/5 hover:bg-white/10 p-2 rounded-full"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-2xl font-black text-gold mb-1 text-center">
          {kind === 'deposit' ? s.depositTitle : s.withdrawTitle}
        </h2>
        <p className="text-gold/60 text-center text-xs mb-5 leading-relaxed">
          {kind === 'deposit' ? s.depositIntro : s.withdrawIntro}
        </p>

        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div role="alert" className="bg-[#B03142]/10 border border-[#B03142]/40 text-[#e4899a] text-xs font-medium rounded-2xl p-3 text-center">
              {error}
            </div>
          )}

          {kind === 'withdrawal' && (
            <div className="bg-white/5 border border-gold/10 rounded-2xl p-4 flex items-center justify-between">
              <span className="text-gold/70 font-medium text-sm">{s.available}</span>
              <span dir="ltr" className="text-gold font-bold text-lg">
                {fmt(available)}
              </span>
            </div>
          )}

          {kind === 'deposit' && (
            <div className="bg-white/5 p-4 rounded-2xl border border-gold/10">
              <h3 className="text-gold font-bold mb-3 text-xs uppercase tracking-wider">{s.depositMethods}</h3>
              {paymentMethods.length === 0 ? (
                <p className="text-gold/50 text-xs text-center py-2">{s.noMethods}</p>
              ) : (
                <div className="space-y-2">
                  {paymentMethods.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => {
                        navigator.clipboard?.writeText(m.details).catch(() => {});
                        setMethod(m.name);
                        setChannel(m.details);
                      }}
                      className={`w-full flex justify-between items-center p-3 rounded-xl border transition-colors ${
                        method === m.name ? 'bg-black/40 border-gold/40' : 'bg-black/20 hover:bg-black/40 border-white/5'
                      }`}
                    >
                      <span className="text-gold/90 font-medium text-sm flex items-center gap-1.5">
                        {method === m.name && <CheckCircle className="w-3.5 h-3.5 text-gold" />}
                        {m.name}
                      </span>
                      <span dir="ltr" className="text-gold/80 font-mono bg-black/40 px-2 py-1 rounded-md text-xs flex items-center gap-1.5">
                        {m.details}
                        <Copy className="w-3 h-3 text-gold/40" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {kind === 'withdrawal' && (
            <>
              <Field label={s.destinationKind}>
                <select value={destinationKind} onChange={(e) => setDestinationKind(e.target.value)} className={inputClass}>
                  {PAYOUT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`${s.destinationAccount} *`} hint={s.destinationFrozen}>
                <input
                  dir="ltr"
                  value={destinationAccount}
                  onChange={(e) => setDestinationAccount(e.target.value)}
                  className={inputClass}
                  required
                />
              </Field>
              <Field label={s.destinationHolder}>
                <input value={destinationHolder} onChange={(e) => setDestinationHolder(e.target.value)} className={inputClass} />
              </Field>
            </>
          )}

          <Field label={currency === 'IQD' ? s.amountIqd : s.amountUsd}>
            <input
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={onAmountChange}
              placeholder="0.00"
              className={`${inputClass} font-bold text-lg`}
              required
            />
          </Field>

          {kind === 'withdrawal' && (
            <div className="bg-black/25 border border-gold/10 rounded-2xl p-4 space-y-2">
              <h3 className="text-gold/80 font-bold text-xs uppercase tracking-wider">{s.feePreview}</h3>
              <div className="flex justify-between text-xs text-gold/70">
                <span>{s.fee}</span>
                <span aria-label={s.feeNotConfigured}>—</span>
              </div>
              <div className="flex justify-between text-sm text-gold font-bold">
                <span>{s.net}</span>
                <span dir="ltr">{fmt(amountCents)}</span>
              </div>
              <div className="flex justify-between text-xs text-gold/60">
                <span>{s.availableAfter}</span>
                <span dir="ltr">{fmt(Math.max(available - amountCents, 0))}</span>
              </div>
              <p className="text-gold/35 text-[10px] leading-snug">{s.feeNotConfigured}</p>
              {overBalance && <p className="text-[#e4899a] text-[11px] font-bold">{s.insufficient}</p>}
            </div>
          )}

          {kind === 'deposit' && (
            <>
              <Field label={s.channel}>
                <input dir="ltr" value={channel} onChange={(e) => setChannel(e.target.value)} className={inputClass} />
              </Field>
              <Field label={s.reference} hint={s.referenceHint}>
                <input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} className={inputClass} />
              </Field>
              <Field label={`${s.receiptLabel} *`}>
                <div
                  className={`relative border-2 border-dashed rounded-2xl p-5 text-center transition-all bg-black/10 ${
                    uploading ? 'border-gold/40 cursor-wait' : 'border-gold/20 hover:border-gold/40 cursor-pointer'
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
                    <div className="flex flex-col items-center gap-2 text-gold/70">
                      <Spinner size="md" decorative />
                      <span className="text-xs font-bold text-gold">{s.uploading}</span>
                    </div>
                  ) : receiptKey ? (
                    <div className="flex flex-col items-center gap-2">
                      <CheckCircle className="w-6 h-6 text-[#59A846]" />
                      <span className="text-xs font-bold text-gold">{s.receiptUploaded}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 text-gold/50">
                      <Upload className="w-5 h-5" />
                      <span className="text-xs font-medium">{s.receiptUpload}</span>
                    </div>
                  )}
                </div>
              </Field>
            </>
          )}

          <Field label={s.note}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={s.notePlaceholder}
              className={`${inputClass} h-20 resize-none`}
            />
          </Field>

          <div className="pt-2 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3.5 rounded-xl font-bold text-gold/60 hover:text-gold hover:bg-white/5 border border-gold/10"
            >
              {s.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting || uploading}
              className="flex-[2] bg-gradient-to-r from-gold to-[#BAA369] text-[#0A1F18] font-black text-sm py-3.5 rounded-xl disabled:opacity-70 disabled:cursor-not-allowed"
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
    </div>
  );
}

function ReviewModal({
  s,
  tx,
  onClose,
  onDone,
}: {
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

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4">
      <div className="bg-[#0A1F18] border border-gold/20 rounded-t-[32px] sm:rounded-[32px] w-full sm:max-w-[420px] p-6 relative">
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="absolute top-5 end-5 text-gold/50 hover:text-gold bg-white/5 p-2 rounded-full"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-black text-gold mb-1 text-center">{s.reviewTitle}</h2>
        <p className="text-gold/50 text-center text-xs mb-4" dir="ltr">
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
              className="flex-1 px-4 py-3 rounded-xl font-bold text-gold/60 hover:text-gold border border-gold/10"
            >
              {s.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-[2] bg-gradient-to-r from-gold to-[#BAA369] text-[#0A1F18] font-black text-sm py-3 rounded-xl disabled:opacity-70"
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
    </div>
  );
}
