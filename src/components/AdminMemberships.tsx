import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, formatIqd, newIdempotencyKey } from '../lib/api';
import { RefreshCw, Users, Inbox, ShieldAlert, ChevronDown, X, MessageSquare, CreditCard, Rocket } from 'lucide-react';
import { Overlay } from './ui/Overlay';
import { tierLabel, tierMetaFor } from './subscription/tierMeta';

/**
 * PRO-operations console (final-phase brief §10):
 *  - member search/filter (tier, membership state, KYC state, restrictions,
 *    expiry window) and a member detail view that SEPARATES subscription
 *    payment/term, identity status (kyc_cases states only), benefit
 *    eligibility context, the live BNPL credit line/ledger and restriction
 *    cases;
 *  - restriction-case management: open a typed case with evidence, gate
 *    specific benefit flags (pause/revoke), resume with reason — audited
 *    server-side. Restrictions gate benefit computation only, never orders,
 *    wallet, points, warranty or support access;
 *  - the support-ticket queue with REAL priority-then-age ordering; age is
 *    shown prominently so ordinary customers are visibly not starved.
 */

// ------------------------------------------------------------------- types

interface MemberRow {
  id: string;
  email: string;
  username: string | null;
  name: string;
  created_at: string;
  tier: 'free' | 'plus' | 'pro' | 'prime';
  membership_state: string;
  expires_at: string | null;
  kyc_state: string | null;
  active_restrictions: number;
  has_approved_address: boolean;
}

interface RestrictionCase {
  id: string;
  case_type: string;
  kind: string;
  state: 'active' | 'resolved';
  reason: string;
  evidence: string[];
  benefit_flags: string[];
  decision: 'pause' | 'revoke' | null;
  decision_reason: string;
  opened_by: string;
  opened_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

interface MemberDetailData {
  user: { id: string; email: string; username: string | null; name: string; role: string; created_at: string };
  tier_status: { tier: string; active: boolean; expires_at: string | null; pending_launch: { tier: string; duration_months: number } | null };
  memberships: Array<{
    id: string;
    plan_id: string;
    tier: string;
    state: string;
    duration_months: number;
    price_paid_iqd: number;
    purchased_at: string;
    starts_at: string | null;
    expires_at: string | null;
    source: string;
  }>;
  kyc_cases: Array<{
    id: string;
    case_type: string;
    doc_type: string | null;
    state: string;
    reason: string;
    submitted_at: string | null;
    decided_at: string | null;
    created_at: string;
  }>;
  benefit_context: {
    tier: string;
    tier_active: boolean;
    gated_benefit_flags: string[];
    restrictable_benefits: readonly string[];
    note: string;
  };
  approved_addresses: Array<{
    id: string;
    version: number;
    state: string;
    name: string;
    address: string;
    landmark: string;
    requested_at: string;
    approved_at: string | null;
  }>;
  debt: {
    bnpl_enabled: boolean;
    eligible: boolean;
    eligibility_reason: string | null;
    available_iqd: number;
    account_state: string;
    credit_limit_iqd: number;
    outstanding_iqd: number;
    ledger: Array<{ id: string; kind: string; amount_iqd: number; due_at: string | null; created_at: string }>;
  };
  restriction_cases: RestrictionCase[];
  support_ticket_count: number;
}

interface AdminTicket {
  id: string;
  subject: string;
  order_id: string | null;
  unit_id: string | null;
  priority: number;
  state: 'open' | 'waiting_customer' | 'waiting_staff' | 'resolved';
  created_at: string;
  updated_at: string;
  message_count?: number;
  user_id?: string;
  email?: string | null;
  username?: string | null;
}
interface TicketMsg {
  id: string;
  body: string;
  is_staff: boolean;
  created_at: string;
}

// ----------------------------------------------------------------- strings

const STRINGS = {
  ar: {
    tabMembers: 'الأعضاء',
    tabQueue: 'قائمة الدعم',
    searchPlaceholder: 'بحث بالبريد/الاسم/اسم المستخدم...',
    fTier: 'الفئة',
    fStatus: 'حالة الاشتراك',
    fKyc: 'حالة الهوية',
    fRestriction: 'القيود',
    fExpiry: 'ينتهي خلال',
    all: 'الكل',
    days: 'يوم',
    colMember: 'العضو',
    colTier: 'الفئة',
    colState: 'الاشتراك',
    colExpiry: 'الانتهاء',
    colKyc: 'الهوية',
    colRestr: 'قيود',
    colAddr: 'عنوان معتمد',
    yes: 'نعم',
    no: 'لا',
    none: 'لا يوجد',
    loading: 'جارٍ التحميل...',
    empty: 'لا نتائج',
    loadError: 'تعذر التحميل',
    retry: 'إعادة المحاولة',
    detailTitle: 'تفاصيل العضو',
    secSubscription: 'الاشتراك (الدفع والمدة)',
    secIdentity: 'حالة الهوية (KYC)',
    secBenefits: 'سياق أهلية المزايا',
    secAddresses: 'العنوان المعتمد',
    secDebt: 'الديون (الشراء الآن والدفع لاحقًا)',
    secRestrictions: 'قضايا القيود',
    bnplStatus: 'BNPL فعّال حصريًا لأعضاء PRO المستوفين. سجل الدين غير قابل للتعديل؛ إدارة السقف والحالة مدققة أدناه.',
    eligible: 'مؤهل الآن',
    ineligible: 'غير مؤهل',
    available: 'المتاح',
    approveBnpl: 'اعتماد / تحديث السقف',
    suspendBnpl: 'تعليق BNPL',
    limitPlaceholder: 'السقف بالدينار',
    bnplSaved: 'تم تحديث حساب BNPL',
    outstanding: 'الرصيد المستحق',
    creditLimit: 'السقف',
    accountState: 'حالة الحساب',
    noLedger: 'لا توجد حركات',
    kycNone: 'لا توجد قضايا هوية',
    kycNote: 'تُعرض الحالات فقط — أدلة الهوية المشفّرة تُفتح حصريًا من واجهة مراجعة KYC المخصصة.',
    benefitActive: 'مزايا سارية',
    benefitGated: 'مزايا مقيّدة حاليًا',
    benefitNoneGated: 'لا قيود فعالة على المزايا',
    benefitNote:
      'القيود تقيّد احتساب المزايا فقط — لا تحذف طلبات أو محفظة أو نقاطًا ولا تمنع الضمان أو الدعم. اختيار عنوان بديل حالة لكل طلب وليس عقوبة.',
    gatingScopeNote:
      'التقييد نافذ عبر طبقة الاستحقاقات المركزية في الدفع والشحن والمجتمع والمتجر والدعم.',
    addrNone: 'لا يوجد عنوان معتمد',
    subsNone: 'لا اشتراكات',
    openCase: 'فتح قضية قيد',
    caseType: 'نوع القضية',
    ct_dropshipping_suspected: 'اشتباه دروبشيبينغ',
    ct_repeated_refusal: 'رفض استلام متكرر',
    ct_abuse: 'إساءة استخدام',
    ct_debt: 'دين غير مسدد',
    evidence: 'الأدلة (نص)',
    reason: 'السبب',
    decision: 'القرار',
    d_pause: 'إيقاف مؤقت',
    d_revoke: 'سحب حتى القرار',
    flags: 'المزايا المقيّدة',
    submitCase: 'فتح القضية',
    creating: 'جارٍ الحفظ...',
    resume: 'استئناف المزايا (حل القضية)',
    resumeReason: 'سبب الاستئناف:',
    active: 'فعالة',
    resolved: 'محلولة',
    openedAt: 'فُتحت',
    resolvedAt: 'حُلّت',
    caseNone: 'لا قضايا',
    required: 'هذا الحقل مطلوب',
    selectFlag: 'اختر ميزة واحدة على الأقل',
    close: 'إغلاق',
    // queue
    queueTitle: 'قائمة تذاكر الدعم (أولوية PRO ثم الأقدمية — العمر ظاهر دائمًا)',
    qState: 'الحالة',
    unresolved: 'غير المحلولة',
    colTicket: 'التذكرة',
    colCustomer: 'العميل',
    colPriority: 'الأولوية',
    colAge: 'العمر',
    colMsgs: 'رسائل',
    proBadge: 'PRO',
    ordinary: 'عادي',
    stateOpen: 'مفتوحة',
    stateWaitingCustomer: 'بانتظار العميل',
    stateWaitingStaff: 'بانتظار الفريق',
    stateResolved: 'محلولة',
    replyPlaceholder: 'رد الفريق...',
    reply: 'إرسال الرد',
    moveTo: 'نقل إلى...',
    customer: 'العميل',
    staffLabel: 'الفريق',
    ticketsEmpty: 'لا تذاكر',
  },
  en: {
    tabMembers: 'Members',
    tabQueue: 'Support queue',
    searchPlaceholder: 'Search email/name/username...',
    fTier: 'Tier',
    fStatus: 'Membership',
    fKyc: 'KYC',
    fRestriction: 'Restrictions',
    fExpiry: 'Expires within',
    all: 'All',
    days: 'days',
    colMember: 'Member',
    colTier: 'Tier',
    colState: 'Membership',
    colExpiry: 'Expires',
    colKyc: 'KYC',
    colRestr: 'Restr.',
    colAddr: 'Appr. address',
    yes: 'Yes',
    no: 'No',
    none: 'None',
    loading: 'Loading...',
    empty: 'No results',
    loadError: 'Failed to load',
    retry: 'Retry',
    detailTitle: 'Member detail',
    secSubscription: 'Subscription (payment & term)',
    secIdentity: 'Identity status (KYC)',
    secBenefits: 'Benefit eligibility context',
    secAddresses: 'Approved address',
    secDebt: 'Debt (Buy Now Pay Later)',
    secRestrictions: 'Restriction cases',
    bnplStatus: 'BNPL is active exclusively for eligible PRO members. Debt entries are immutable; audited limit/state controls are below.',
    eligible: 'Eligible now',
    ineligible: 'Not eligible',
    available: 'Available',
    approveBnpl: 'Approve / update limit',
    suspendBnpl: 'Suspend BNPL',
    limitPlaceholder: 'Credit limit (IQD)',
    bnplSaved: 'BNPL account updated',
    outstanding: 'Outstanding',
    creditLimit: 'Limit',
    accountState: 'Account state',
    noLedger: 'No ledger entries',
    kycNone: 'No identity cases',
    kycNote: 'States only — encrypted identity evidence opens exclusively in the dedicated KYC review surface.',
    benefitActive: 'Active benefits basis',
    benefitGated: 'Currently gated benefits',
    benefitNoneGated: 'No active benefit restrictions',
    benefitNote:
      'Restrictions gate benefit computation ONLY — they never delete orders, wallet or points, and never block warranty or support access. Choosing an alternate address is a per-order condition, not a sanction.',
    gatingScopeNote:
      'Gating is enforced through the canonical entitlement layer across checkout, shipping, Community, stores and support.',
    addrNone: 'No approved address',
    subsNone: 'No memberships',
    openCase: 'Open restriction case',
    caseType: 'Case type',
    ct_dropshipping_suspected: 'Suspected dropshipping',
    ct_repeated_refusal: 'Repeated delivery refusal',
    ct_abuse: 'Abuse',
    ct_debt: 'Unpaid debt',
    evidence: 'Evidence (text)',
    reason: 'Reason',
    decision: 'Decision',
    d_pause: 'Pause (temporary)',
    d_revoke: 'Revoke until resolved',
    flags: 'Gated benefits',
    submitCase: 'Open case',
    creating: 'Saving...',
    resume: 'Resume benefits (resolve case)',
    resumeReason: 'Resume reason:',
    active: 'Active',
    resolved: 'Resolved',
    openedAt: 'Opened',
    resolvedAt: 'Resolved',
    caseNone: 'No cases',
    required: 'This field is required',
    selectFlag: 'Select at least one benefit',
    close: 'Close',
    queueTitle: 'Support ticket queue (PRO priority then age — age always visible)',
    qState: 'State',
    unresolved: 'Unresolved',
    colTicket: 'Ticket',
    colCustomer: 'Customer',
    colPriority: 'Priority',
    colAge: 'Age',
    colMsgs: 'Msgs',
    proBadge: 'PRO',
    ordinary: 'Ordinary',
    stateOpen: 'Open',
    stateWaitingCustomer: 'Waiting customer',
    stateWaitingStaff: 'Waiting staff',
    stateResolved: 'Resolved',
    replyPlaceholder: 'Staff reply...',
    reply: 'Send reply',
    moveTo: 'Move to...',
    customer: 'Customer',
    staffLabel: 'Staff',
    ticketsEmpty: 'No tickets',
  },
  ckb: {
    tabMembers: 'ئەندامان',
    tabQueue: 'ڕیزی پشتگیری',
    searchPlaceholder: 'گەڕان بە ئیمەیڵ/ناو...',
    fTier: 'پلە',
    fStatus: 'ئەندامێتی',
    fKyc: 'KYC',
    fRestriction: 'سنووردارکردن',
    fExpiry: 'کۆتایی دێت لە ماوەی',
    all: 'هەموو',
    days: 'ڕۆژ',
    colMember: 'ئەندام',
    colTier: 'پلە',
    colState: 'ئەندامێتی',
    colExpiry: 'کۆتایی',
    colKyc: 'KYC',
    colRestr: 'سنوور',
    colAddr: 'ناونیشانی پەسەند',
    yes: 'بەڵێ',
    no: 'نەخێر',
    none: 'نییە',
    loading: 'بارکردن...',
    empty: 'هیچ ئەنجامێک نییە',
    loadError: 'بارکردن سەرکەوتوو نەبوو',
    retry: 'هەوڵدانەوە',
    detailTitle: 'وردەکاری ئەندام',
    secSubscription: 'ئەندامێتی (پارەدان و ماوە)',
    secIdentity: 'دۆخی ناسنامە (KYC)',
    secBenefits: 'سیاقی شایستەیی سوودەکان',
    secAddresses: 'ناونیشانی پەسەندکراو',
    secDebt: 'قەرز (BNPL)',
    secRestrictions: 'کەیسەکانی سنووردارکردن',
    bnplStatus: 'BNPL تەنها بۆ ئەندامی PRO ی گونجاو چالاکە. تۆماری قەرز ناگۆڕدرێت؛ سنوور و دۆخ لە خوارەوە بە پشکنینەوە بەڕێوەدەبرێت.',
    eligible: 'ئێستا گونجاوە',
    ineligible: 'گونجاو نییە',
    available: 'بەردەست',
    approveBnpl: 'پەسەندکردن / نوێکردنەوەی سنوور',
    suspendBnpl: 'ڕاگرتنی BNPL',
    limitPlaceholder: 'سنووری قەرز (IQD)',
    bnplSaved: 'هەژماری BNPL نوێکرایەوە',
    outstanding: 'ماوەی قەرز',
    creditLimit: 'سنوور',
    accountState: 'دۆخی هەژمار',
    noLedger: 'هیچ تۆمارێک نییە',
    kycNone: 'هیچ کەیسێکی ناسنامە نییە',
    kycNote: 'تەنها دۆخەکان — بەڵگە شفرکراوەکانی ناسنامە تەنها لە ڕووکاری پێداچوونەوەی KYC دەکرێنەوە.',
    benefitActive: 'بنەمای سوودە چالاکەکان',
    benefitGated: 'سوودە سنووردارکراوەکان',
    benefitNoneGated: 'هیچ سنوورێکی چالاک نییە لەسەر سوودەکان',
    benefitNote:
      'سنووردارکردنەکان تەنها ژماردنی سوودەکان دەگرنەوە — هەرگیز داواکاری، جزدان یان خاڵ ناسڕنەوە و گەرەنتی و پشتگیری ناگیرێت. هەڵبژاردنی ناونیشانی جیاواز مەرجی هەر داواکارییەکە، نەک سزا.',
    gatingScopeNote:
      'سنووردارکردن لە ڕێگەی توێژی ناوەندی سوودەکان لە پارەدان و گەیاندن و کۆمەڵگە و فرۆشگا و پشتگیری جێبەجێ دەکرێت.',
    addrNone: 'ناونیشانی پەسەندکراو نییە',
    subsNone: 'هیچ ئەندامێتییەک نییە',
    openCase: 'کردنەوەی کەیسی سنووردارکردن',
    caseType: 'جۆری کەیس',
    ct_dropshipping_suspected: 'گومانی دڕۆپشیپینگ',
    ct_repeated_refusal: 'ڕەتکردنەوەی دووبارەی وەرگرتن',
    ct_abuse: 'بەکارهێنانی خراپ',
    ct_debt: 'قەرزی نەدراوە',
    evidence: 'بەڵگە (دەق)',
    reason: 'هۆکار',
    decision: 'بڕیار',
    d_pause: 'ڕاگرتنی کاتی',
    d_revoke: 'سەندنەوە تا چارەسەر',
    flags: 'سوودە سنووردارکراوەکان',
    submitCase: 'کردنەوەی کەیس',
    creating: 'پاشەکەوتکردن...',
    resume: 'گەڕاندنەوەی سوودەکان (چارەسەری کەیس)',
    resumeReason: 'هۆکاری گەڕاندنەوە:',
    active: 'چالاک',
    resolved: 'چارەسەرکراوە',
    openedAt: 'کرایەوە',
    resolvedAt: 'چارەسەرکرا',
    caseNone: 'هیچ کەیسێک نییە',
    required: 'ئەم خانەیە پێویستە',
    selectFlag: 'لانیکەم یەک سوود هەڵبژێرە',
    close: 'داخستن',
    queueTitle: 'ڕیزی تیکێتی پشتگیری (پێشینەیی PRO پاشان تەمەن — تەمەن هەمیشە دیارە)',
    qState: 'دۆخ',
    unresolved: 'چارەسەرنەکراوەکان',
    colTicket: 'تیکێت',
    colCustomer: 'کڕیار',
    colPriority: 'پێشینەیی',
    colAge: 'تەمەن',
    colMsgs: 'پەیام',
    proBadge: 'PRO',
    ordinary: 'ئاسایی',
    stateOpen: 'کراوەیە',
    stateWaitingCustomer: 'چاوەڕوانی کڕیار',
    stateWaitingStaff: 'چاوەڕوانی تیم',
    stateResolved: 'چارەسەرکراوە',
    replyPlaceholder: 'وەڵامی تیم...',
    reply: 'ناردنی وەڵام',
    moveTo: 'گواستنەوە بۆ...',
    customer: 'کڕیار',
    staffLabel: 'تیم',
    ticketsEmpty: 'هیچ تیکێتێک نییە',
  },
};

type S = (typeof STRINGS)['en'];

const BENEFIT_LABELS: Record<string, { ar: string; en: string; ckb: string }> = {
  proPricing: { ar: 'أسعار PRO', en: 'PRO prices', ckb: 'نرخەکانی PRO' },
  freeDelivery: { ar: 'التوصيل المجاني', en: 'Free delivery', ckb: 'گەیاندنی بێبەرامبەر' },
  noPreorderCommission: { ar: 'إعفاء عمولة الطلب المسبق', en: 'Preorder commission waiver', ckb: 'لێبوردنی کۆمیسیۆنی پێش-داواکاری' },
  priorityService: { ar: 'أولوية الخدمة والدعم', en: 'Priority service/support', ckb: 'پێشینەیی خزمەتگوزاری/پشتگیری' },
  proExclusive: { ar: 'عروض PRO الحصرية', en: 'PRO-exclusive offers', ckb: 'ئۆفەرە تایبەتەکانی PRO' },
  merchantProfile: { ar: 'ملف التاجر', en: 'Merchant profile', ckb: 'پرۆفایلی بازرگان' },
  exclusiveSections: { ar: 'الأقسام الحصرية', en: 'Exclusive sections', ckb: 'بەشە تایبەتەکان' },
  verifiedMerchant: { ar: 'شارة التاجر PRO', en: 'PRO merchant badge', ckb: 'نیشانەی بازرگانی PRO' },
  proMerchantBadge: { ar: 'شارة التاجر PRO', en: 'PRO merchant badge', ckb: 'نیشانەی بازرگانی PRO' },
  exclusiveCoupons: { ar: 'كوبونات الأعضاء', en: 'Member coupons', ckb: 'کۆپۆنی ئەندامان' },
};

const CASE_TYPES = ['dropshipping_suspected', 'repeated_refusal', 'abuse', 'debt'] as const;

const STATE_STYLES: Record<AdminTicket['state'], string> = {
  open: 'bg-blue-500/20 text-blue-300',
  waiting_customer: 'bg-amber-500/20 text-amber-300',
  waiting_staff: 'bg-purple-500/20 text-purple-300',
  resolved: 'bg-emerald-500/20 text-emerald-300',
};

function benefitLabel(flag: string, lang: 'ar' | 'en' | 'ckb'): string {
  const l = BENEFIT_LABELS[flag];
  if (!l) return flag;
  return lang === 'en' ? l.en : lang === 'ckb' ? l.ckb : l.ar;
}

function ticketStateLabel(s: S, state: AdminTicket['state']): string {
  if (state === 'open') return s.stateOpen;
  if (state === 'waiting_customer') return s.stateWaitingCustomer;
  if (state === 'waiting_staff') return s.stateWaitingStaff;
  return s.stateResolved;
}

function ageOf(iso: string, s: S): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)} ${s.days}`;
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

// ============================================================ members list

function MembersSection({ s, lang }: { s: S; lang: 'ar' | 'en' | 'ckb' }) {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [status, setStatus] = useState('');
  const [kyc, setKyc] = useState('');
  const [restriction, setRestriction] = useState('');
  const [expiryDays, setExpiryDays] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (tier) params.set('tier', tier);
      if (status) params.set('status', status);
      if (kyc) params.set('kyc', kyc);
      if (restriction) params.set('restriction', restriction);
      if (expiryDays) params.set('expiry_days', expiryDays);
      const d = await api.get<{ members: MemberRow[] }>(`/api/support/admin/members?${params.toString()}`);
      setMembers(d.members || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [q, tier, status, kyc, restriction, expiryDays, s.loadError]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, status, kyc, restriction, expiryDays]);

  const selectCls =
    'bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          placeholder={s.searchPlaceholder}
          className="flex-1 min-w-[180px] bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none"
        />
        <select value={tier} onChange={(e) => setTier(e.target.value)} className={selectCls} aria-label={s.fTier}>
          <option value="">{s.fTier}: {s.all}</option>
          <option value="pro">PRO</option>
          <option value="plus">PLUS</option>
          <option value="free">{s.none}</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls} aria-label={s.fStatus}>
          <option value="">{s.fStatus}: {s.all}</option>
          <option value="active">active</option>
          <option value="expired">expired</option>
          <option value="pending_launch">pending_launch</option>
          <option value="none">{s.none}</option>
        </select>
        <select value={kyc} onChange={(e) => setKyc(e.target.value)} className={selectCls} aria-label={s.fKyc}>
          <option value="">{s.fKyc}: {s.all}</option>
          {['draft', 'submitted', 'reviewing', 'changes_requested', 'rejected', 'verified'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={restriction} onChange={(e) => setRestriction(e.target.value)} className={selectCls} aria-label={s.fRestriction}>
          <option value="">{s.fRestriction}: {s.all}</option>
          <option value="active">{s.active}</option>
        </select>
        <select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} className={selectCls} aria-label={s.fExpiry}>
          <option value="">{s.fExpiry}: {s.all}</option>
          <option value="7">7 {s.days}</option>
          <option value="30">30 {s.days}</option>
          <option value="90">90 {s.days}</option>
        </select>
        <button onClick={load} className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm">
          {error}{' '}
          <button onClick={load} className="underline">
            {s.retry}
          </button>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse min-w-[820px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700 text-start">
                {[s.colMember, s.colTier, s.colState, s.colExpiry, s.colKyc, s.colRestr, s.colAddr].map((h) => (
                  <th key={h} className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase tracking-wider text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => setSelected(m.id)}
                  className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4">
                    <div className="text-sm text-white font-bold">{m.name || m.username || '—'}</div>
                    <div className="text-xs text-zinc-500">{m.email}</div>
                  </td>
                  <td className="py-3 px-4 text-xs font-bold uppercase text-zinc-300">{m.tier}</td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{m.membership_state}</td>
                  <td className="py-3 px-4 text-xs text-zinc-500 whitespace-nowrap">{shortDate(m.expires_at)}</td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{m.kyc_state ?? '—'}</td>
                  <td className="py-3 px-4">
                    {m.active_restrictions > 0 ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-300">
                        {m.active_restrictions}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{m.has_approved_address ? s.yes : s.no}</td>
                </tr>
              ))}
              {!loading && members.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-zinc-500">
                    {s.empty}
                  </td>
                </tr>
              )}
              {loading && members.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-zinc-500">
                    {s.loading}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <MemberDetail userId={selected} s={s} lang={lang} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

// ============================================================ member detail

function MemberDetail({
  userId,
  s,
  lang,
  onClose,
  onChanged,
}: {
  userId: string;
  s: S;
  lang: 'ar' | 'en' | 'ckb';
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<MemberDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');
  const [bnplLimit, setBnplLimit] = useState('');
  const [bnplBusy, setBnplBusy] = useState(false);
  const [bnplNote, setBnplNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<{ member: MemberDetailData }>(`/api/support/admin/members/${userId}`);
      setData(d.member);
      setBnplLimit(String(d.member.debt.credit_limit_iqd || ''));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [userId, s.loadError]);

  useEffect(() => {
    load();
  }, [load]);

  // Resuming a paused benefit asks for its reason in the house window (no
  // browser prompt): the case is remembered while the window is open.
  const [resumeTarget, setResumeTarget] = useState<RestrictionCase | null>(null);
  const resumeCase = async (rc: RestrictionCase, reason: string) => {
    setRowBusy(rc.id);
    setRowError('');
    try {
      await api.patch(`/api/support/admin/restrictions/${rc.id}`, { action: 'resume', reason });
      setResumeTarget(null);
      await load();
      onChanged();
    } catch (e) {
      setRowError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setRowBusy(null);
    }
  };

  const updateBnpl = async (state: 'approved' | 'suspended') => {
    if (bnplBusy || !data) return;
    const limit = Number(bnplLimit);
    if (state === 'approved' && (!Number.isInteger(limit) || limit <= 0)) {
      setBnplNote({ ok: false, text: s.limitPlaceholder });
      return;
    }
    setBnplBusy(true);
    setBnplNote(null);
    try {
      await api.put(`/api/memberships/admin/bnpl/${encodeURIComponent(userId)}`, {
        state,
        credit_limit_iqd: state === 'approved' ? limit : data.debt.credit_limit_iqd,
      });
      setBnplNote({ ok: true, text: s.bnplSaved });
      await load();
      onChanged();
    } catch (e) {
      setBnplNote({ ok: false, text: e instanceof ApiError ? e.message : s.loadError });
    } finally {
      setBnplBusy(false);
    }
  };

  const sec = 'bg-zinc-900 border border-zinc-800 rounded-2xl p-4';
  const secTitle = 'text-sm font-black text-white mb-2 flex items-center gap-2';

  return (
    <div className="bg-zinc-950 border border-zinc-700 rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-black">{s.detailTitle}</h3>
        <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg text-zinc-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8 text-zinc-500">{s.loading}</div>
      ) : error || !data ? (
        <div className="text-center py-8 text-red-400 text-sm">
          {error || s.loadError}{' '}
          <button onClick={load} className="underline">
            {s.retry}
          </button>
        </div>
      ) : (
        <>
          <div className="text-sm text-white font-bold">
            {data.user.name || data.user.username || '—'} <span className="text-zinc-500 font-normal">{data.user.email}</span>
          </div>

          {/* subscription payment/term */}
          <div className={sec}>
            <div className={secTitle}>{s.secSubscription}</div>
            <div className="text-xs text-zinc-400 mb-2">
              {data.tier_status.tier.toUpperCase()} · {data.tier_status.active ? s.active : s.none} ·{' '}
              {shortDate(data.tier_status.expires_at)}
            </div>
            {data.memberships.length === 0 ? (
              <div className="text-xs text-zinc-600">{s.subsNone}</div>
            ) : (
              <div className="space-y-1">
                {data.memberships.map((m) => (
                  <div key={m.id} className="text-xs text-zinc-400 flex flex-wrap gap-x-3">
                    <span className="font-bold text-zinc-300 uppercase">{m.tier}</span>
                    <span>{m.state}</span>
                    <span>{m.duration_months}mo</span>
                    <span>{formatIqd(m.price_paid_iqd)}</span>
                    <span>
                      {shortDate(m.starts_at)} → {shortDate(m.expires_at)}
                    </span>
                    <span className="text-zinc-600">{m.source}</span>
                  </div>
                ))}
              </div>
            )}
            <GrantMembership userId={userId} onGranted={() => { load(); onChanged(); }} />
          </div>

          {/* identity */}
          <div className={sec}>
            <div className={secTitle}>{s.secIdentity}</div>
            <p className="text-[11px] text-zinc-500 mb-2">{s.kycNote}</p>
            {data.kyc_cases.length === 0 ? (
              <div className="text-xs text-zinc-600">{s.kycNone}</div>
            ) : (
              <div className="space-y-1">
                {data.kyc_cases.map((k) => (
                  <div key={k.id} className="text-xs text-zinc-400 flex flex-wrap gap-x-3">
                    <span className="font-bold text-zinc-300">{k.case_type}</span>
                    <span className="uppercase">{k.state}</span>
                    {k.doc_type && <span>{k.doc_type}</span>}
                    <span className="text-zinc-600">{shortDate(k.submitted_at ?? k.created_at)}</span>
                    {k.reason && <span className="text-zinc-500">{k.reason}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* benefit context */}
          <div className={sec}>
            <div className={secTitle}>{s.secBenefits}</div>
            <p className="text-[11px] text-zinc-500 mb-2">{s.benefitNote}</p>
            <p className="text-[11px] text-amber-400/80 mb-2">{s.gatingScopeNote}</p>
            <div className="text-xs text-zinc-400 mb-1">
              {s.benefitActive}: <span className="text-zinc-300 font-bold uppercase">{data.benefit_context.tier}</span>{' '}
              {data.benefit_context.tier_active ? `(${s.active})` : `(${s.none})`}
            </div>
            {data.benefit_context.gated_benefit_flags.length === 0 ? (
              <div className="text-xs text-emerald-400">{s.benefitNoneGated}</div>
            ) : (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-xs text-zinc-500">{s.benefitGated}:</span>
                {data.benefit_context.gated_benefit_flags.map((f) => (
                  <span key={f} className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-300">
                    {benefitLabel(f, lang)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* approved address */}
          <div className={sec}>
            <div className={secTitle}>{s.secAddresses}</div>
            {data.approved_addresses.length === 0 ? (
              <div className="text-xs text-zinc-600">{s.addrNone}</div>
            ) : (
              <div className="space-y-1">
                {data.approved_addresses.map((a) => (
                  <div key={a.id} className="text-xs text-zinc-400 flex flex-wrap gap-x-3">
                    <span className="font-bold text-zinc-300">v{a.version}</span>
                    <span className="uppercase">{a.state}</span>
                    <span className="break-words">{a.address}</span>
                    <span className="text-zinc-600">{shortDate(a.approved_at ?? a.requested_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* BNPL credit line and immutable ledger */}
          <div className={sec}>
            <div className={secTitle}>{s.secDebt}</div>
            <div className="text-[11px] text-zinc-500 mb-2">{s.bnplStatus}</div>
            <div className="text-xs text-zinc-400 flex flex-wrap gap-x-4">
              <span className={data.debt.eligible ? 'font-bold text-emerald-300' : 'font-bold text-amber-300'}>
                {data.debt.eligible ? s.eligible : s.ineligible}
                {!data.debt.eligible && data.debt.eligibility_reason ? ` · ${data.debt.eligibility_reason}` : ''}
              </span>
              <span>
                {s.accountState}: <span className="text-zinc-300">{data.debt.account_state}</span>
              </span>
              <span>
                {s.creditLimit}: <span className="text-zinc-300">{formatIqd(data.debt.credit_limit_iqd)}</span>
              </span>
              <span>
                {s.outstanding}: <span className={data.debt.outstanding_iqd > 0 ? 'text-red-300 font-bold' : 'text-zinc-300'}>{formatIqd(data.debt.outstanding_iqd)}</span>
              </span>
              <span>
                {s.available}: <span className="text-zinc-300">{formatIqd(data.debt.available_iqd)}</span>
              </span>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1000}
                value={bnplLimit}
                onChange={(e) => setBnplLimit(e.target.value)}
                placeholder={s.limitPlaceholder}
                aria-label={s.limitPlaceholder}
                className="min-h-10 min-w-0 flex-1 rounded-xl border border-zinc-700 bg-black px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
              />
              <button type="button" disabled={bnplBusy} onClick={() => void updateBnpl('approved')} className="min-h-10 rounded-xl bg-gold px-3 text-xs font-black text-black disabled:opacity-50">
                {s.approveBnpl}
              </button>
              <button type="button" disabled={bnplBusy || data.debt.account_state === 'suspended'} onClick={() => void updateBnpl('suspended')} className="min-h-10 rounded-xl border border-red-500/35 bg-red-500/10 px-3 text-xs font-bold text-red-300 disabled:opacity-50">
                {s.suspendBnpl}
              </button>
            </div>
            {bnplNote && <p role={bnplNote.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${bnplNote.ok ? 'text-emerald-300' : 'text-red-300'}`}>{bnplNote.text}</p>}
            {data.debt.ledger.length === 0 ? (
              <div className="text-xs text-zinc-600 mt-2">{s.noLedger}</div>
            ) : (
              <div className="mt-2 space-y-1">
                {data.debt.ledger.map((l) => (
                  <div key={l.id} className="text-xs text-zinc-500 flex flex-wrap gap-x-3">
                    <span className="text-zinc-400">{l.kind}</span>
                    <span>{formatIqd(l.amount_iqd)}</span>
                    {l.due_at && <span>→ {shortDate(l.due_at)}</span>}
                    <span className="text-zinc-600">{shortDate(l.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* restriction cases */}
          <div className={sec}>
            <div className="flex items-center justify-between mb-2">
              <div className={secTitle}>
                <ShieldAlert className="w-4 h-4 text-red-400" />
                {s.secRestrictions}
              </div>
              <button
                onClick={() => setShowCaseForm((v) => !v)}
                className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-bold hover:bg-red-500/20"
              >
                {s.openCase}
              </button>
            </div>

            {showCaseForm && (
              <RestrictionForm
                userId={userId}
                s={s}
                lang={lang}
                onDone={() => {
                  setShowCaseForm(false);
                  load();
                  onChanged();
                }}
              />
            )}

            {rowError && <div className="text-xs text-red-400 mb-2">{rowError}</div>}
            {data.restriction_cases.length === 0 ? (
              <div className="text-xs text-zinc-600">{s.caseNone}</div>
            ) : (
              <div className="space-y-2">
                {data.restriction_cases.map((rc) => (
                  <div key={rc.id} className="bg-black border border-zinc-800 rounded-xl p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-white">
                        {(s as Record<string, unknown>)[`ct_${rc.case_type}`] as string || rc.case_type}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          rc.state === 'active' ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        {rc.state === 'active' ? s.active : s.resolved}
                      </span>
                      {rc.decision && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-zinc-800 text-zinc-300">
                          {rc.decision === 'pause' ? s.d_pause : s.d_revoke}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-400 mt-1">{rc.reason}</div>
                    {rc.evidence.length > 0 && (
                      <div className="text-xs text-zinc-500 mt-1 whitespace-pre-wrap break-words">{rc.evidence.join('\n')}</div>
                    )}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {rc.benefit_flags.map((f) => (
                        <span key={f} className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400">
                          {benefitLabel(f, lang)}
                        </span>
                      ))}
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-1.5">
                      {s.openedAt}: {shortDate(rc.opened_at)}
                      {rc.resolved_at && (
                        <>
                          {' '}
                          · {s.resolvedAt}: {shortDate(rc.resolved_at)} — {rc.decision_reason}
                        </>
                      )}
                    </div>
                    {rc.state === 'active' && (
                      <button
                        type="button"
                        onClick={() => setResumeTarget(rc)}
                        disabled={rowBusy === rc.id}
                        className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-bold hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        {rowBusy === rc.id ? s.creating : s.resume}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <ReasonWindow
        open={!!resumeTarget}
        busy={!!resumeTarget && rowBusy === resumeTarget.id}
        title={s.resume}
        body={s.resumeReason}
        confirmLabel={s.resume}
        error={rowError}
        onClose={() => setResumeTarget(null)}
        onConfirm={(reason) => {
          if (resumeTarget) void resumeCase(resumeTarget, reason);
        }}
      />
    </div>
  );
}

/**
 * Give an account a membership without a payment.
 *
 * The schema has allowed `source = 'admin'` since the beginning and nothing
 * ever wrote one, so until now the only way to hold PLUS was to buy it. That
 * left an admin unable to comp a member whose payment failed, restore a
 * subscription cancelled by mistake, or set up a merchant — without pushing
 * real money through a real wallet to do it.
 *
 * It is an ENTITLEMENT, not a transaction: `price_paid_iqd` is 0 and no
 * wallet row moves. A reason is required, because a membership somebody
 * cannot explain later is one that gets revoked by whoever asks loudest.
 */
function GrantMembership({ userId, onGranted }: { userId: string; onGranted: () => void }) {
  const { loc } = useLanguage();
  const [plans, setPlans] = useState<Array<{ id: string; tier: string; duration_months: number; purchasable: boolean }>>([]);
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    api
      .get<{ plans: Array<{ id: string; tier: string; duration_months: number; purchasable: boolean }> }>(
        '/api/memberships/plans'
      )
      .then((d) => {
        setPlans(d.plans);
        // Default to the shortest PLUS term: a comp should be the smallest
        // thing that solves the problem, not the largest.
        const plus = d.plans.filter((p) => p.tier === 'plus').sort((a, b) => a.duration_months - b.duration_months);
        setPlanId(plus[0]?.id ?? d.plans[0]?.id ?? '');
      })
      .catch(() => setPlans([]));
  }, []);

  // The reason is asked for in the house window, not a browser prompt.
  const [askOpen, setAskOpen] = useState(false);
  const grantBtnRef = useRef<HTMLButtonElement>(null);

  async function grant(reason: string) {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const r = await api.post<{ replayed: boolean; tier?: string; active?: boolean; note?: string }>(
        '/api/memberships/admin/grant',
        { userId, planId, reason, idempotencyKey: newIdempotencyKey() }
      );
      setAskOpen(false);
      setDone(
        r.replayed
          ? loc('هذا المنح مسجّل مسبقًا.', 'That grant was already recorded.', 'ئەم پێدانە پێشتر تۆمارکراوە.')
          : r.note ?? loc('تم المنح.', 'Granted.', 'پێدرا.')
      );
      onGranted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر المنح', 'Could not grant it', 'نەتوانرا بدرێت'));
    } finally {
      setBusy(false);
    }
  }

  if (!plans.length) return null;

  return (
    <div className="mt-3 pt-3 border-t border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          className="min-h-[34px] rounded-lg bg-zinc-800 border border-zinc-700 px-2 text-white text-xs outline-none"
        >
          {plans.map((p) => (
            <option key={p.id} value={p.id} className="bg-zinc-900">
              {p.tier.toUpperCase()} · {p.duration_months}mo
            </option>
          ))}
        </select>
        <button
          ref={grantBtnRef}
          type="button"
          onClick={() => setAskOpen(true)}
          disabled={busy || !planId}
          className="min-h-[34px] px-3 rounded-lg bg-olive text-white text-xs font-bold disabled:opacity-40"
        >
          {busy
            ? loc('جارٍ…', 'Working…', 'خەریکە…')
            : loc('منح اشتراك بدون دفع', 'Grant without payment', 'بەخشینی بەشداری')}
        </button>
      </div>
      <ReasonWindow
        open={askOpen}
        busy={busy}
        anchor={grantBtnRef}
        title={loc('منح اشتراك بدون دفع', 'Grant without payment', 'بەخشینی بەشداری')}
        body={loc(
          'سبب المنح مطلوب ويُسجَّل في سجل التدقيق. لا تُسجَّل أي حركة في المحفظة.',
          'The reason for the grant is required and is kept in the audit log. No wallet movement is recorded.',
          'هۆکاری پێدان پێویستە و لە تۆماری وردبینی هەڵدەگیرێت. هیچ جووڵەیەکی جزدان تۆمار ناکرێت.'
        )}
        confirmLabel={loc('منح', 'Grant', 'پێدان')}
        error={error}
        onClose={() => setAskOpen(false)}
        onConfirm={(reason) => void grant(reason)}
      />
      <p className="text-[11px] text-zinc-600 mt-1.5">
        {loc(
          'منح صلاحية وليس عملية مالية — لا تُسجَّل أي حركة في المحفظة، والسبب يُحفظ في سجل التدقيق.',
          'An entitlement, not a transaction — no wallet movement is recorded, and the reason is kept in the audit log.',
          'مافێکە نەک کارێکی دارایی — هیچ جووڵەیەکی جزدان تۆمار ناکرێت.'
        )}
      </p>
      {done && <p className="text-emerald-400 text-[11.5px] mt-1">{done}</p>}
      {error && <p className="text-red-400 text-[11.5px] mt-1">{error}</p>}
    </div>
  );
}

function RestrictionForm({
  userId,
  s,
  lang,
  onDone,
}: {
  userId: string;
  s: S;
  lang: 'ar' | 'en' | 'ckb';
  onDone: () => void;
}) {
  const [caseType, setCaseType] = useState<string>('dropshipping_suspected');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'pause' | 'revoke'>('pause');
  const [flags, setFlags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggleFlag = (f: string) => {
    setFlags((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  };

  const submit = async () => {
    if (evidence.trim().length < 5 || reason.trim().length < 3) {
      setError(s.required);
      return;
    }
    if (flags.length === 0) {
      setError(s.selectFlag);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/support/admin/members/${userId}/restrictions`, {
        case_type: caseType,
        evidence: evidence.trim(),
        reason: reason.trim(),
        decision,
        benefit_flags: flags,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
      setBusy(false);
    }
  };

  return (
    <div className="bg-black border border-red-500/20 rounded-xl p-3 mb-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-zinc-500 block mb-1">{s.caseType}</label>
          <div className="relative">
            <select
              value={caseType}
              onChange={(e) => setCaseType(e.target.value)}
              className="w-full appearance-none bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-white focus:outline-none"
            >
              {CASE_TYPES.map((ct) => (
                <option key={ct} value={ct}>
                  {(s as Record<string, unknown>)[`ct_${ct}`] as string}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-600 absolute top-2.5 ltr:right-2 rtl:left-2 pointer-events-none" />
          </div>
        </div>
        <div>
          <label className="text-[11px] text-zinc-500 block mb-1">{s.decision}</label>
          <div className="relative">
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as 'pause' | 'revoke')}
              className="w-full appearance-none bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-white focus:outline-none"
            >
              <option value="pause">{s.d_pause}</option>
              <option value="revoke">{s.d_revoke}</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-600 absolute top-2.5 ltr:right-2 rtl:left-2 pointer-events-none" />
          </div>
        </div>
      </div>
      <div>
        <label className="text-[11px] text-zinc-500 block mb-1">{s.flags}</label>
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(BENEFIT_LABELS).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => toggleFlag(f)}
              className={`px-2 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                flags.includes(f)
                  ? 'bg-red-500/20 border-red-500/40 text-red-300'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {benefitLabel(f, lang)}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        rows={2}
        maxLength={4000}
        placeholder={s.evidence}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-white placeholder-zinc-600 focus:outline-none resize-none"
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        placeholder={s.reason}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-white placeholder-zinc-600 focus:outline-none"
      />
      {error && <div className="text-xs text-red-400">{error}</div>}
      <button
        onClick={submit}
        disabled={busy}
        className="px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/40 text-red-200 text-xs font-black hover:bg-red-500/30 disabled:opacity-50"
      >
        {busy ? s.creating : s.submitCase}
      </button>
    </div>
  );
}

// ============================================================= ticket queue

function QueueSection({ s }: { s: S; lang: 'ar' | 'en' | 'ckb' }) {
  const [stateFilter, setStateFilter] = useState('');
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ ticket: AdminTicket; messages: TicketMsg[] } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [threadError, setThreadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = stateFilter ? `?state=${encodeURIComponent(stateFilter)}` : '';
      const d = await api.get<{ tickets: AdminTicket[] }>(`/api/support/admin/tickets${qs}`);
      setTickets(d.tickets || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [stateFilter, s.loadError]);

  useEffect(() => {
    load();
  }, [load]);

  const openThread = useCallback(
    async (id: string) => {
      setOpenId(id);
      setThread(null);
      setThreadError('');
      setThreadLoading(true);
      try {
        const d = await api.get<{ ticket: AdminTicket; messages: TicketMsg[] }>(`/api/support/admin/tickets/${id}`);
        setThread({ ticket: d.ticket, messages: d.messages || [] });
      } catch (e) {
        setThreadError(e instanceof ApiError ? e.message : s.loadError);
      } finally {
        setThreadLoading(false);
      }
    },
    [s.loadError]
  );

  const sendReply = async () => {
    if (!openId || reply.trim().length === 0) return;
    setBusy(true);
    setThreadError('');
    try {
      await api.post(`/api/support/admin/tickets/${openId}/messages`, { body: reply.trim() });
      setReply('');
      await openThread(openId);
      await load();
    } catch (e) {
      setThreadError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setBusy(false);
    }
  };

  const changeState = async (next: string) => {
    if (!openId || !next) return;
    setBusy(true);
    setThreadError('');
    try {
      await api.patch(`/api/support/admin/tickets/${openId}`, { state: next });
      await openThread(openId);
      await load();
    } catch (e) {
      setThreadError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setBusy(false);
    }
  };

  if (openId) {
    return (
      <div className="space-y-3">
        <button onClick={() => setOpenId(null)} className="text-xs text-zinc-400 hover:text-white font-bold">
          ← {s.tabQueue}
        </button>
        {threadLoading ? (
          <div className="text-center py-8 text-zinc-500">{s.loading}</div>
        ) : thread ? (
          <>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white font-bold text-sm break-words">{thread.ticket.subject}</span>
                {thread.ticket.priority === 1 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-300">{s.proBadge}</span>
                )}
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATE_STYLES[thread.ticket.state]}`}>
                  {ticketStateLabel(s, thread.ticket.state)}
                </span>
                <span className="text-[10px] text-zinc-500 font-bold">
                  {s.colAge}: {ageOf(thread.ticket.created_at, s)}
                </span>
              </div>
              <div className="text-xs text-zinc-500">
                {thread.ticket.email || thread.ticket.username || thread.ticket.user_id}
                {thread.ticket.order_id && <span className="font-mono"> · {thread.ticket.order_id}</span>}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <select
                  value=""
                  disabled={busy}
                  onChange={(e) => changeState(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none disabled:opacity-50"
                >
                  <option value="" disabled>
                    {s.moveTo}
                  </option>
                  {(['open', 'waiting_customer', 'waiting_staff', 'resolved'] as const)
                    .filter((st) => st !== thread.ticket.state)
                    .map((st) => (
                      <option key={st} value={st}>
                        {ticketStateLabel(s, st)}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              {thread.messages.map((m) => (
                <div key={m.id} className={`flex ${m.is_staff ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                      m.is_staff ? 'bg-[#6B46FF]/10 border border-[#6B46FF]/30 text-zinc-100' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
                    }`}
                  >
                    <div className="text-[10px] text-zinc-500 mb-0.5">
                      {m.is_staff ? s.staffLabel : s.customer} · {shortDate(m.created_at)}
                    </div>
                    {m.body}
                  </div>
                </div>
              ))}
            </div>
            {threadError && <div className="text-xs text-red-400">{threadError}</div>}
            <div className="flex gap-2">
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendReply();
                }}
                maxLength={4000}
                placeholder={s.replyPlaceholder}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none"
              />
              <button
                onClick={sendReply}
                disabled={busy || reply.trim().length === 0}
                className="px-4 rounded-xl bg-[#2CE59B] text-black text-sm font-black disabled:opacity-50"
              >
                {s.reply}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-red-400 text-sm">{threadError || s.loadError}</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-black text-white">{s.queueTitle}</h3>
        <div className="flex items-center gap-2">
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none"
            aria-label={s.qState}
          >
            <option value="">{s.unresolved}</option>
            <option value="all">{s.all}</option>
            {(['open', 'waiting_customer', 'waiting_staff', 'resolved'] as const).map((st) => (
              <option key={st} value={st}>
                {ticketStateLabel(s, st)}
              </option>
            ))}
          </select>
          <button onClick={load} className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm">
          {error}{' '}
          <button onClick={load} className="underline">
            {s.retry}
          </button>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700">
                {[s.colTicket, s.colCustomer, s.colPriority, s.colAge, s.qState, s.colMsgs].map((h) => (
                  <th key={h} className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase tracking-wider text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openThread(t.id)}
                  className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4">
                    <div className="text-sm text-white font-bold break-words max-w-[260px]">{t.subject}</div>
                    <div className="text-[10px] text-zinc-600 font-mono">{t.id}</div>
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{t.email || t.username || '—'}</td>
                  <td className="py-3 px-4">
                    {t.priority === 1 ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-300">{s.proBadge}</span>
                    ) : (
                      <span className="text-xs text-zinc-500">{s.ordinary}</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm font-black text-white whitespace-nowrap">{ageOf(t.created_at, s)}</td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATE_STYLES[t.state]}`}>
                      {ticketStateLabel(s, t.state)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" /> {t.message_count ?? 0}
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && tickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-zinc-500">
                    {s.ticketsEmpty}
                  </td>
                </tr>
              )}
              {loading && tickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-zinc-500">
                    {s.loading}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


// ================================================================== plans

/**
 * The plan catalogue and the launch switch — the two admin endpoints that
 * existed (PATCH /admin/plans/:id, POST /admin/activate-launch) but had no
 * screen, so prices and the launch could only be changed with curl.
 *
 * A price is data: an empty field means UNPRICED, which the storefront shows
 * as "price to be announced" and refuses to sell. The launch activation is
 * irreversible and starts every prepaid membership, so it asks for the word
 * ACTIVATE to be typed into an in-app window — no browser prompt.
 */
const PLAN_STRINGS = {
  ar: {
    tab: 'الخطط والإطلاق',
    title: 'خطط العضوية',
    intro: 'السعر بالدينار العراقي (عدد صحيح). اترك الحقل فارغًا ليصبح "غير مسعّر" — لا يُباع ويظهر للزبون بأن السعر يُعلن لاحقًا.',
    tier: 'الفئة',
    duration: 'المدة',
    price: 'السعر (د.ع)',
    active: 'نشطة',
    inactive: 'موقوفة',
    purchasable: 'قابلة للشراء',
    unpriced: 'غير مسعّرة',
    save: 'حفظ',
    saved: 'تم الحفظ',
    months: 'شهر',
    loading: 'جارٍ التحميل…',
    loadError: 'تعذر تحميل الخطط',
    retry: 'إعادة المحاولة',
    badPrice: 'السعر يجب أن يكون عددًا صحيحًا غير سالب',
    launchTitle: 'إطلاق العضويات',
    launchActive: 'الإطلاق مُفعّل',
    launchInactive: 'الإطلاق غير مُفعّل — كل الاشتراكات المدفوعة تبقى محجوزة حتى التفعيل.',
    launchAt: 'تاريخ الإطلاق المعلن',
    activatedAt: 'فُعّل في',
    notSet: 'غير محدد',
    activate: 'تفعيل الإطلاق',
    activateTitle: 'تفعيل إطلاق العضويات',
    activateBody: 'هذا الإجراء نهائي ويبدأ عدّاد كل اشتراك مدفوع مسبقًا من هذه اللحظة. اكتب ACTIVATE للتأكيد.',
    typeHere: 'اكتب ACTIVATE',
    confirm: 'تفعيل الآن',
    cancel: 'إلغاء',
    working: 'جارٍ التنفيذ…',
    activated: (n: number) => `تم التفعيل — ${n} اشتراكًا بدأ الآن.`,
    alreadyActivated: (n: number) => `الإطلاق كان مُفعّلًا مسبقًا — ${n} اشتراكًا متأخرًا بدأ الآن.`,
  },
  en: {
    tab: 'Plans & launch',
    title: 'Membership plans',
    intro: 'Price in IQD (a whole number). Leave the field empty to make a plan UNPRICED — it cannot be bought and the customer sees "price to be announced".',
    tier: 'Tier',
    duration: 'Duration',
    price: 'Price (IQD)',
    active: 'Active',
    inactive: 'Inactive',
    purchasable: 'Purchasable',
    unpriced: 'Unpriced',
    save: 'Save',
    saved: 'Saved',
    months: 'mo',
    loading: 'Loading…',
    loadError: 'The plans could not be loaded',
    retry: 'Retry',
    badPrice: 'The price must be a non-negative whole number',
    launchTitle: 'Membership launch',
    launchActive: 'Launch activated',
    launchInactive: 'Launch not activated — every paid membership stays reserved until it is.',
    launchAt: 'Announced launch date',
    activatedAt: 'Activated at',
    notSet: 'Not set',
    activate: 'Activate launch',
    activateTitle: 'Activate the membership launch',
    activateBody: 'This is final and starts the clock on every prepaid membership from this moment. Type ACTIVATE to confirm.',
    typeHere: 'Type ACTIVATE',
    confirm: 'Activate now',
    cancel: 'Cancel',
    working: 'Working…',
    activated: (n: number) => `Activated — ${n} memberships started now.`,
    alreadyActivated: (n: number) => `The launch was already active — ${n} straggling memberships started now.`,
  },
  ckb: {
    tab: 'پلان و دەستپێکردن',
    title: 'پلانەکانی ئەندامێتی',
    intro: 'نرخ بە دیناری عێراقی (ژمارەی تەواو). خانەکە بەتاڵ بهێڵەرەوە بۆ ئەوەی پلانەکە "بێ نرخ" بێت — نافرۆشرێت و کڕیار دەبینێت نرخ دواتر ڕادەگەیەنرێت.',
    tier: 'ئاست',
    duration: 'ماوە',
    price: 'نرخ (د.ع)',
    active: 'چالاک',
    inactive: 'ناچالاک',
    purchasable: 'دەکڕدرێت',
    unpriced: 'بێ نرخ',
    save: 'پاشەکەوت',
    saved: 'پاشەکەوت کرا',
    months: 'مانگ',
    loading: 'باردەکرێت…',
    loadError: 'پلانەکان بار نەکران',
    retry: 'دووبارە هەوڵبدەرەوە',
    badPrice: 'نرخ دەبێت ژمارەیەکی تەواوی نا-نەرێنی بێت',
    launchTitle: 'دەستپێکردنی ئەندامێتییەکان',
    launchActive: 'دەستپێکردن چالاک کراوە',
    launchInactive: 'دەستپێکردن چالاک نەکراوە — هەموو ئەندامێتییە پارەدراوەکان پارێزراو دەمێننەوە تا چالاک دەکرێت.',
    launchAt: 'بەرواری ڕاگەیەنراوی دەستپێکردن',
    activatedAt: 'چالاک کرا لە',
    notSet: 'دیاری نەکراوە',
    activate: 'چالاککردنی دەستپێکردن',
    activateTitle: 'چالاککردنی دەستپێکردنی ئەندامێتی',
    activateBody: 'ئەمە کۆتاییە و کاتژمێری هەموو ئەندامێتییەکی پێشپارەدراو لەم ساتەوە دەست پێدەکات. ACTIVATE بنووسە بۆ پشتڕاستکردنەوە.',
    typeHere: 'ACTIVATE بنووسە',
    confirm: 'ئێستا چالاک بکە',
    cancel: 'پاشگەزبوونەوە',
    working: 'جێبەجێ دەکرێت…',
    activated: (n: number) => `چالاک کرا — ${n} ئەندامێتی ئێستا دەستی پێکرد.`,
    alreadyActivated: (n: number) => `دەستپێکردن پێشتر چالاک بوو — ${n} ئەندامێتیی دواکەوتوو ئێستا دەستی پێکرد.`,
  },
};

type PS = (typeof PLAN_STRINGS)['en'];

interface AdminPlan {
  id: string;
  tier: string;
  duration_months: number;
  price_iqd: number | null;
  purchasable: boolean;
  active: boolean;
  sort: number;
}
interface AdminLaunch {
  launch_at: string | null;
  activated: boolean;
  activated_at: string | null;
}

function PlansSection({ lang }: { lang: 'ar' | 'en' | 'ckb' }) {
  const ps: PS = PLAN_STRINGS[lang] ?? PLAN_STRINGS.ar;
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [launch, setLaunch] = useState<AdminLaunch | null>(null);
  const [loadError, setLoadError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNote, setRowNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [activateOpen, setActivateOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [activating, setActivating] = useState(false);
  const [launchNote, setLaunchNote] = useState<{ ok: boolean; text: string } | null>(null);
  const activateBtnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const d = await api.get<{ plans: AdminPlan[]; launch: AdminLaunch }>('/api/memberships/admin/plans');
      setPlans(d.plans);
      setLaunch(d.launch);
      const next: Record<string, string> = {};
      for (const p of d.plans) next[p.id] = p.price_iqd === null ? '' : String(p.price_iqd);
      setDrafts(next);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : ps.loadError);
      setPlans([]);
    }
  }, [ps.loadError]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(plan: AdminPlan, body: { price_iqd?: number | null; active?: boolean }) {
    setRowBusy(plan.id);
    setRowNote((n) => ({ ...n, [plan.id]: { ok: true, text: '' } }));
    try {
      const r = await api.patch<{ plan: AdminPlan }>(`/api/memberships/admin/plans/${encodeURIComponent(plan.id)}`, body);
      setPlans((cur) => (cur ? cur.map((p) => (p.id === plan.id ? { ...p, ...r.plan } : p)) : cur));
      setDrafts((d) => ({ ...d, [plan.id]: r.plan.price_iqd === null ? '' : String(r.plan.price_iqd) }));
      setRowNote((n) => ({ ...n, [plan.id]: { ok: true, text: ps.saved } }));
    } catch (e) {
      setRowNote((n) => ({ ...n, [plan.id]: { ok: false, text: e instanceof ApiError ? e.message : ps.loadError } }));
    } finally {
      setRowBusy(null);
    }
  }

  function savePrice(plan: AdminPlan) {
    const raw = (drafts[plan.id] ?? '').replace(/[,\s]/g, '');
    if (raw === '') {
      void patch(plan, { price_iqd: null });
      return;
    }
    if (!/^\d+$/.test(raw)) {
      setRowNote((n) => ({ ...n, [plan.id]: { ok: false, text: ps.badPrice } }));
      return;
    }
    void patch(plan, { price_iqd: Number(raw) });
  }

  async function activateLaunch() {
    if (confirmText !== 'ACTIVATE' || activating) return;
    setActivating(true);
    try {
      const r = await api.post<{ already_activated: boolean; converted: number; activated_at: string }>(
        '/api/memberships/admin/activate-launch',
        { confirm: 'ACTIVATE' }
      );
      setLaunchNote({ ok: true, text: r.already_activated ? ps.alreadyActivated(r.converted) : ps.activated(r.converted) });
      setActivateOpen(false);
      setConfirmText('');
      await load();
    } catch (e) {
      setLaunchNote({ ok: false, text: e instanceof ApiError ? e.message : ps.loadError });
    } finally {
      setActivating(false);
    }
  }

  const inputCls =
    'min-h-[36px] w-32 rounded-lg bg-zinc-800 border border-zinc-700 px-2 text-white text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]';

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-white font-bold text-base flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-gold" aria-hidden /> {ps.title}
            </h3>
            <p className="text-zinc-500 text-xs mt-1 max-w-2xl leading-relaxed">{ps.intro}</p>
          </div>
          <button
            type="button"
            onClick={load}
            aria-label={ps.retry}
            className="p-2 min-h-[36px] min-w-[36px] bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white"
          >
            <RefreshCw className={`w-4 h-4 ${plans === null ? 'animate-spin' : ''}`} aria-hidden />
          </button>
        </div>

        {loadError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm">
            {loadError}{' '}
            <button type="button" onClick={load} className="underline">
              {ps.retry}
            </button>
          </div>
        )}

        {plans === null ? (
          <p className="text-zinc-500 text-sm py-6">{ps.loading}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-zinc-900/60 text-zinc-400 text-[11px] uppercase">
                <tr>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.tier}</th>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.duration}</th>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.price}</th>
                  <th className="text-start py-2.5 px-3 font-bold">{ps.active}</th>
                  <th className="py-2.5 px-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {plans.map((p) => {
                  const meta = tierMetaFor(p.tier);
                  const note = rowNote[p.id];
                  const busy = rowBusy === p.id;
                  return (
                    <tr key={p.id} data-admin-plan={p.id}>
                      <td className="py-2.5 px-3">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-black px-2 py-0.5 rounded-md border ${meta ? meta.chip : 'border-zinc-700 text-zinc-300'}`}>
                          {meta && <meta.Icon className="w-3.5 h-3.5" aria-hidden />}
                          {tierLabel(p.tier)}
                        </span>
                        <div className="text-[10px] text-zinc-600 font-mono mt-1">{p.id}</div>
                      </td>
                      <td className="py-2.5 px-3 text-white tabular-nums" dir="ltr">
                        {p.duration_months} {ps.months}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            value={drafts[p.id] ?? ''}
                            onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') savePrice(p);
                            }}
                            inputMode="numeric"
                            dir="ltr"
                            placeholder={ps.unpriced}
                            aria-label={`${ps.price} — ${tierLabel(p.tier)} ${p.duration_months}`}
                            className={inputCls}
                          />
                          <button
                            type="button"
                            onClick={() => savePrice(p)}
                            disabled={busy}
                            className="min-h-[36px] px-3 rounded-lg bg-[#BAA369] text-black text-xs font-bold disabled:opacity-40"
                          >
                            {busy ? ps.working : ps.save}
                          </button>
                          <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full border ${p.purchasable ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-500/30 text-amber-300 bg-amber-500/10'}`}>
                            {p.purchasable ? `${ps.purchasable} · ${formatIqd(p.price_iqd as number)}` : ps.unpriced}
                          </span>
                        </div>
                        {note?.text && (
                          <p role={note.ok ? 'status' : 'alert'} className={`text-[11px] mt-1 ${note.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                            {note.text}
                          </p>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={p.active}
                          aria-label={`${ps.active} — ${tierLabel(p.tier)} ${p.duration_months}`}
                          disabled={busy}
                          onClick={() => patch(p, { active: !p.active })}
                          className={`min-h-[32px] px-3 rounded-full text-xs font-bold border transition-colors disabled:opacity-40 ${
                            p.active
                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                          }`}
                        >
                          {p.active ? ps.active : ps.inactive}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 text-[10px] text-zinc-600 tabular-nums" dir="ltr">
                        sort {p.sort}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <h3 className="text-white font-bold text-base flex items-center gap-2">
          <Rocket className="w-4 h-4 text-gold" aria-hidden /> {ps.launchTitle}
        </h3>
        {launch ? (
          <div className="text-sm space-y-1.5">
            <p className={launch.activated ? 'text-emerald-300 font-bold' : 'text-amber-300'}>
              {launch.activated ? ps.launchActive : ps.launchInactive}
            </p>
            <p className="text-zinc-400 text-xs" dir="ltr">
              {ps.launchAt}: {launch.launch_at ?? ps.notSet}
            </p>
            {launch.activated && (
              <p className="text-zinc-400 text-xs" dir="ltr">
                {ps.activatedAt}: {launch.activated_at ?? ps.notSet}
              </p>
            )}
          </div>
        ) : (
          <p className="text-zinc-500 text-sm">{ps.loading}</p>
        )}
        <button
          ref={activateBtnRef}
          type="button"
          onClick={() => {
            setLaunchNote(null);
            setConfirmText('');
            setActivateOpen(true);
          }}
          disabled={!launch || launch.activated}
          aria-haspopup="dialog"
          className="min-h-[40px] px-4 rounded-xl bg-[#B03142] text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {ps.activate}
        </button>
        {launchNote && (
          <p className={`text-[12.5px] ${launchNote.ok ? 'text-emerald-400' : 'text-red-400'}`}>{launchNote.text}</p>
        )}
      </section>

      <Overlay
        open={activateOpen}
        onClose={() => {
          if (!activating) setActivateOpen(false);
        }}
        labelledBy="activate-launch-title"
        label={ps.activateTitle}
        anchor={activateBtnRef}
        dismissOnEscape={!activating}
        dismissOnScrim={!activating}
        testId="activate-launch"
        panelClassName="w-full max-w-md"
      >
        <div className="p-5 sm:p-6">
          <h2 id="activate-launch-title" className="text-white font-bold text-lg flex items-center gap-2">
            <Rocket className="w-5 h-5 text-[#e06070]" aria-hidden /> {ps.activateTitle}
          </h2>
          <p className="text-zinc-300 text-sm mt-2 leading-relaxed">{ps.activateBody}</p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') activateLaunch();
            }}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder={ps.typeHere}
            aria-label={ps.typeHere}
            className="mt-4 w-full min-h-[44px] rounded-xl bg-zinc-900 border border-zinc-700 px-3 text-white font-mono tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-[#B03142]"
          />
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button
              type="button"
              onClick={() => setActivateOpen(false)}
              disabled={activating}
              className="flex-1 min-h-[48px] rounded-2xl border border-zinc-700 text-zinc-200 font-semibold hover:bg-zinc-900 disabled:opacity-50"
            >
              {ps.cancel}
            </button>
            <button
              type="button"
              onClick={activateLaunch}
              disabled={confirmText !== 'ACTIVATE' || activating}
              className="flex-1 min-h-[48px] rounded-2xl bg-[#B03142] text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {activating ? ps.working : ps.confirm}
            </button>
          </div>
        </div>
      </Overlay>
    </div>
  );
}

// ==================================================================== root

export default function AdminMemberships() {
  const { lang } = useLanguage();
  const s: S = STRINGS[lang] ?? STRINGS.ar;
  const [tab, setTab] = useState<'members' | 'queue' | 'plans'>('members');
  const ps: PS = PLAN_STRINGS[lang] ?? PLAN_STRINGS.ar;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap bg-zinc-900 border border-zinc-800 p-1 rounded-xl w-fit">
        <button
          type="button"
          onClick={() => setTab('members')}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
            tab === 'members' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          {s.tabMembers}
        </button>
        <button
          type="button"
          onClick={() => setTab('queue')}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
            tab === 'queue' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Inbox className="w-3.5 h-3.5" />
          {s.tabQueue}
        </button>
        <button
          type="button"
          data-admin-tab="plans"
          onClick={() => setTab('plans')}
          className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
            tab === 'plans' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <CreditCard className="w-3.5 h-3.5" />
          {ps.tab}
        </button>
      </div>

      {tab === 'members' ? (
        <MembersSection s={s} lang={lang} />
      ) : tab === 'queue' ? (
        <QueueSection s={s} lang={lang} />
      ) : (
        <PlansSection lang={lang} />
      )}
    </div>
  );
}

/**
 * The house question window for an action that must carry a written reason
 * (a grant, resuming a paused benefit): title, body, a reason field with a
 * three-character floor, cancel and confirm. Replaces the browser prompt so
 * the reason is typed inside the page, in the reader's language, with the
 * server's refusal shown in place.
 */
function ReasonWindow({
  open,
  busy,
  anchor,
  title,
  body,
  confirmLabel,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  anchor?: React.RefObject<HTMLElement | null>;
  title: string;
  body: string;
  confirmLabel: string;
  error?: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { loc } = useLanguage();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const ready = reason.trim().length >= 3 && !busy;
  const titleId = 'reason-window-title';
  return (
    <Overlay
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      labelledBy={titleId}
      label={title}
      anchor={anchor}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      panelClassName="w-full max-w-md"
    >
      <div className="p-5 sm:p-6">
        <h2 id={titleId} className="text-white font-bold text-lg">
          {title}
        </h2>
        <p className="text-zinc-300 text-sm mt-2 leading-relaxed">{body}</p>
        <label className="block mt-4">
          <span className="block text-xs text-zinc-400 mb-1">{loc('السبب (٣ محارف على الأقل)', 'Reason (at least 3 characters)', 'هۆکار (لانیکەم ٣ پیت)')}</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={busy}
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-white text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          />
        </label>
        {error && (
          <p className="text-red-400 text-[12px] mt-2" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[40px] px-4 rounded-xl bg-zinc-800 text-zinc-200 text-sm font-bold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            {loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
          </button>
          <button
            type="button"
            onClick={() => ready && onConfirm(reason.trim())}
            disabled={!ready}
            className="min-h-[40px] px-4 rounded-xl bg-olive text-white text-sm font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            {busy ? loc('جارٍ…', 'Working…', 'خەریکە…') : confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
