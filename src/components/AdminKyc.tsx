import React, { useState, useEffect, useCallback } from 'react';
import {
  IdCard, MapPin, Phone, RefreshCw, Eye, EyeOff, ShieldCheck, AlertTriangle, Clock,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api } from '../lib/api';
import { Overlay } from './ui/Overlay';

/**
 * Admin — PRO KYC: identity/phone-change review queues and the approved-
 * address request queue. Opening a case decrypts identity fields and every
 * such view (and every evidence image view) is written to the audit log by
 * the server — the UI says so before opening. Only the explicit human
 * decision here can set 'verified'.
 *
 * NOTE: the codebase currently has one 'admin' role; identity-review vs
 * support vs finance separation is pending a roles model (documented gap).
 */

const STRINGS = {
  ar: {
    title: 'التحقق من الهوية (KYC)',
    tabCases: 'طلبات الهوية',
    tabPhone: 'تغييرات الهاتف',
    tabAddresses: 'طلبات العناوين',
    refresh: 'تحديث',
    all: 'الكل',
    empty: 'لا توجد طلبات.',
    loadError: 'تعذر التحميل — أعد المحاولة.',
    stateNames: {
      draft: 'مسودة', submitted: 'مُقدَّم', reviewing: 'قيد المراجعة',
      changes_requested: 'مطلوب تعديل', rejected: 'مرفوض', verified: 'موثَّق',
      pending: 'معلّق', approved: 'معتمد', superseded: 'مستبدَل',
    } as Record<string, string>,
    openCase: 'فتح الطلب (اطلاع مُدقَّق)',
    auditWarn: 'فتح الطلب يفك تشفير حقول الهوية ويسجَّل كل اطلاع (بما فيه الصور) في سجل التدقيق.',
    close: 'إغلاق',
    fullName: 'الاسم الثلاثي',
    dob: 'تاريخ الميلاد',
    docNumber: 'رقم الوثيقة',
    docType: 'نوع الوثيقة',
    unreadable: 'غير قابل للقراءة (مفتاح التشفير غير متاح لهذه النسخة) — لا قيمة مختلقة.',
    evidence: 'صور الوثيقة (عرضها مُدقَّق)',
    showEvidence: 'عرض الصور',
    hideEvidence: 'إخفاء الصور',
    newPhone: 'الرقم الجديد المثبت',
    proof: 'نوع الإثبات',
    decisions: 'القرار',
    startReview: 'بدء المراجعة',
    reqChanges: 'طلب تعديل…',
    reject: 'رفض…',
    verify: 'توثيق (قرار نهائي)',
    verifyConfirm: 'التوثيق قرار بشري نهائي يسجَّل باسمك في سجل التدقيق. المتابعة؟',
    reasonPrompt: 'السبب (سيظهر للزبون ويُسجَّل):',
    reasonRequired: 'السبب مطلوب (5 أحرف على الأقل).',
    customerReason: 'سبب الزبون:',
    approve: 'اعتماد',
    approveConfirm: 'سيُعتمد هذا العنوان كنسخة جديدة غير قابلة للتعديل وتُستبدل النسخة السابقة. المتابعة؟',
    rejectAddr: 'رفض…',
    snapshotNote: 'هذه نسخة منسوخة من محتوى العنوان وقت الطلب — تعديل العنوان المحفوظ لاحقًا لا يغيّرها.',
    version: 'النسخة',
    actionError: 'تعذر تنفيذ الإجراء',
    rolesGap: 'ملاحظة: يوجد حاليًا دور إداري واحد؛ فصل صلاحيات مراجعة الهوية عن الدعم والمالية بانتظار نموذج أدوار.',
  },
  en: {
    title: 'Identity Verification (KYC)',
    tabCases: 'Identity cases',
    tabPhone: 'Phone changes',
    tabAddresses: 'Address requests',
    refresh: 'Refresh',
    all: 'All',
    empty: 'No requests.',
    loadError: 'Load failed — retry.',
    stateNames: {
      draft: 'Draft', submitted: 'Submitted', reviewing: 'In review',
      changes_requested: 'Changes requested', rejected: 'Rejected', verified: 'Verified',
      pending: 'Pending', approved: 'Approved', superseded: 'Superseded',
    } as Record<string, string>,
    openCase: 'Open case (audited view)',
    auditWarn: 'Opening a case decrypts identity fields; every view (including images) is written to the audit log.',
    close: 'Close',
    fullName: 'Full name',
    dob: 'Date of birth',
    docNumber: 'Document number',
    docType: 'Document type',
    unreadable: 'Unreadable (encryption key unavailable for this version) — no fabricated value.',
    evidence: 'Document images (viewing is audited)',
    showEvidence: 'Show images',
    hideEvidence: 'Hide images',
    newPhone: 'Proven new number',
    proof: 'Proof type',
    decisions: 'Decision',
    startReview: 'Start review',
    reqChanges: 'Request changes…',
    reject: 'Reject…',
    verify: 'Verify (final decision)',
    verifyConfirm: 'Verification is a final human decision recorded under your name in the audit log. Continue?',
    reasonPrompt: 'Reason (shown to the customer, audited):',
    reasonRequired: 'A reason is required (min 5 characters).',
    customerReason: 'Customer reason:',
    approve: 'Approve',
    approveConfirm: 'This address becomes a new immutable approved version, superseding the previous one. Continue?',
    rejectAddr: 'Reject…',
    snapshotNote: 'This is a snapshot copy of the address contents at request time — later edits of the saved address never change it.',
    version: 'Version',
    actionError: 'The action failed',
    rolesGap: 'Note: a single admin role exists today; identity-review vs support vs finance separation is pending a roles model.',
  },
  ckb: {
    title: 'پشتڕاستکردنەوەی ناسنامە (KYC)',
    tabCases: 'داواکارییەکانی ناسنامە',
    tabPhone: 'گۆڕینەکانی تەلەفۆن',
    tabAddresses: 'داواکارییەکانی ناونیشان',
    refresh: 'نوێکردنەوە',
    all: 'هەموو',
    empty: 'هیچ داواکارییەک نییە.',
    loadError: 'بارکردن سەرکەوتوو نەبوو — هەوڵ بدەوە.',
    stateNames: {
      draft: 'ڕەشنووس', submitted: 'نێردراوە', reviewing: 'لە پێداچوونەوەدایە',
      changes_requested: 'گۆڕانکاری داواکراوە', rejected: 'ڕەتکراوەتەوە', verified: 'پشتڕاستکراوە',
      pending: 'چاوەڕوانە', approved: 'پەسەندکراوە', superseded: 'گۆڕدراوە',
    } as Record<string, string>,
    openCase: 'کردنەوەی داواکاری (بینینی تۆمارکراو)',
    auditWarn: 'کردنەوەی داواکارییەک خانەکانی ناسنامە دەکاتەوە؛ هەر بینینێک (وێنەکانیش) لە تۆماری چاودێریدا دەنووسرێت.',
    close: 'داخستن',
    fullName: 'ناوی سیانی',
    dob: 'ڕێکەوتی لەدایکبوون',
    docNumber: 'ژمارەی بەڵگەنامە',
    docType: 'جۆری بەڵگەنامە',
    unreadable: 'ناخوێندرێتەوە (کلیلی کۆدکردن بۆ ئەم وەشانە بەردەست نییە) — هیچ بەهایەکی داهێنراو نییە.',
    evidence: 'وێنەکانی بەڵگەنامە (بینین تۆمار دەکرێت)',
    showEvidence: 'پیشاندانی وێنەکان',
    hideEvidence: 'شاردنەوەی وێنەکان',
    newPhone: 'ژمارە نوێی سەلمێنراو',
    proof: 'جۆری بەڵگە',
    decisions: 'بڕیار',
    startReview: 'دەستپێکردنی پێداچوونەوە',
    reqChanges: 'داواکردنی گۆڕانکاری…',
    reject: 'ڕەتکردنەوە…',
    verify: 'پشتڕاستکردنەوە (بڕیاری کۆتایی)',
    verifyConfirm: 'پشتڕاستکردنەوە بڕیارێکی مرۆیی کۆتاییە و بە ناوی تۆوە لە تۆماری چاودێریدا دەنووسرێت. بەردەوام بیت؟',
    reasonPrompt: 'هۆکار (بۆ کڕیار دەردەکەوێت و تۆمار دەکرێت):',
    reasonRequired: 'هۆکار پێویستە (بەلایەنی کەمەوە ٥ پیت).',
    customerReason: 'هۆکاری کڕیار:',
    approve: 'پەسەندکردن',
    approveConfirm: 'ئەم ناونیشانە دەبێتە وەشانێکی پەسەندکراوی نوێی نەگۆڕ و وەشانی پێشوو دەگۆڕێتەوە. بەردەوام بیت؟',
    rejectAddr: 'ڕەتکردنەوە…',
    snapshotNote: 'ئەمە وێنەیەکی لەبەرگیراوەی ناوەڕۆکی ناونیشانەکەیە لە کاتی داواکاریدا — دەستکاری دواتری ناونیشانە پاشەکەوتکراوەکە نایگۆڕێت.',
    version: 'وەشان',
    actionError: 'کردارەکە سەرکەوتوو نەبوو',
    rolesGap: 'تێبینی: ئێستا تەنها یەک ڕۆڵی بەڕێوەبەر هەیە؛ جیاکردنەوەی دەسەڵاتی پێداچوونەوەی ناسنامە لە پشتگیری و دارایی چاوەڕوانی مۆدێلی ڕۆڵەکانە.',
  },
} as const;

interface QueueCase {
  id: string;
  user_id: string;
  user_email: string;
  user_username: string | null;
  state: string;
  case_type: 'identity' | 'phone_change';
  doc_type: string | null;
  reason: string;
  evidence_count: number;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
}
interface CaseDetail extends QueueCase {
  full_name: string | null;
  dob: string | null;
  doc_number: string | null;
  fields_readable: boolean;
  evidence_indexes: number[];
  payload: { new_phone_e164?: string; proof?: string };
}
interface AddressRequest {
  id: string;
  user_id: string;
  user_email: string;
  user_username: string | null;
  version: number;
  name: string;
  phone_e164: string;
  address: string;
  landmark: string;
  state: string;
  reason: string;
  requested_at: string;
  source_address_id: string;
}

type Tab = 'identity' | 'phone_change' | 'addresses';

const CASE_STATES = ['', 'submitted', 'reviewing', 'changes_requested', 'rejected', 'verified'];
const ADDR_STATES = ['pending', 'approved', 'rejected', 'superseded'];

const STATE_STYLE: Record<string, string> = {
  submitted: 'bg-sky-500/15 text-sky-400',
  reviewing: 'bg-amber-500/15 text-amber-400',
  changes_requested: 'bg-orange-500/15 text-orange-400',
  rejected: 'bg-red-500/15 text-red-400',
  verified: 'bg-emerald-500/15 text-emerald-400',
  pending: 'bg-sky-500/15 text-sky-400',
  approved: 'bg-emerald-500/15 text-emerald-400',
  superseded: 'bg-zinc-700/40 text-zinc-400',
  draft: 'bg-zinc-700/40 text-zinc-400',
};

export default function AdminKyc() {
  const { lang } = useLanguage();
  const t = STRINGS[lang] || STRINGS.ar;

  const [tab, setTab] = useState<Tab>('identity');
  const [stateFilter, setStateFilter] = useState('submitted');
  const [addrFilter, setAddrFilter] = useState('pending');
  const [cases, setCases] = useState<QueueCase[]>([]);
  const [addrRequests, setAddrRequests] = useState<AddressRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError('');
    setActionError('');
    try {
      if (tab === 'addresses') {
        const data = await api.get<{ requests: AddressRequest[] }>(
          `/api/kyc/admin/address-queue?state=${encodeURIComponent(addrFilter)}`
        );
        setAddrRequests(data.requests);
      } else {
        const params = new URLSearchParams({ case_type: tab });
        if (stateFilter) params.set('state', stateFilter);
        const data = await api.get<{ cases: QueueCase[] }>(`/api/kyc/admin/queue?${params.toString()}`);
        setCases(data.cases);
      }
    } catch (err) {
      setLoadError((err as Error)?.message || t.loadError);
    } finally {
      setIsLoading(false);
    }
  }, [tab, stateFilter, addrFilter, t.loadError]);

  useEffect(() => {
    load();
  }, [load]);

  const openCase = async (id: string) => {
    setActionError('');
    setShowEvidence(false);
    try {
      const data = await api.get<{ case: CaseDetail }>(`/api/kyc/admin/cases/${id}`);
      setDetail(data.case);
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    }
  };

  const decide = async (id: string, decision: string) => {
    setActionError('');
    let reason = '';
    if (decision === 'changes_requested' || decision === 'rejected') {
      const typed = window.prompt(t.reasonPrompt);
      if (typed === null) return;
      if (typed.trim().length < 5) {
        setActionError(t.reasonRequired);
        return;
      }
      reason = typed.trim();
    }
    if (decision === 'verified' && !window.confirm(t.verifyConfirm)) return;
    setBusy(true);
    try {
      await api.post(`/api/kyc/admin/cases/${id}/decision`, { decision, reason });
      setDetail(null);
      await load();
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setBusy(false);
    }
  };

  const decideAddress = async (id: string, approve: boolean) => {
    setActionError('');
    let reason = '';
    if (approve) {
      if (!window.confirm(t.approveConfirm)) return;
    } else {
      const typed = window.prompt(t.reasonPrompt);
      if (typed === null) return;
      if (typed.trim().length < 5) {
        setActionError(t.reasonRequired);
        return;
      }
      reason = typed.trim();
    }
    setBusy(true);
    try {
      await api.post(`/api/kyc/admin/address/${id}/decision`, { approve, reason });
      await load();
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setBusy(false);
    }
  };

  const stateChip = (s: string) => (
    <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${STATE_STYLE[s] || STATE_STYLE.draft}`}>
      {t.stateNames[s] || s}
    </span>
  );

  return (
    <div className="text-white">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h2 className="font-bold text-[17px] flex items-center gap-2">
          <IdCard className="w-5 h-5 text-gold" /> {t.title}
        </h2>
        <button
          onClick={load}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-full text-[12px] font-bold inline-flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" /> {t.refresh}
        </button>
      </div>
      <p className="text-[12px] text-zinc-500 mb-4">{t.rolesGap}</p>

      <div className="flex gap-2 mb-4 flex-wrap">
        {(
          [
            ['identity', t.tabCases, IdCard],
            ['phone_change', t.tabPhone, Phone],
            ['addresses', t.tabAddresses, MapPin],
          ] as Array<[Tab, string, typeof IdCard]>
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold inline-flex items-center gap-1.5 border transition-colors ${
              tab === id ? 'border-gold/50 bg-gold/10 text-gold' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900'
            }`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab !== 'addresses' ? (
        <div className="flex gap-1.5 mb-4 flex-wrap">
          {CASE_STATES.map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setStateFilter(s)}
              className={`px-3 py-1 rounded-full text-[12px] font-bold border ${
                stateFilter === s ? 'border-gold/50 text-gold' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s ? t.stateNames[s] || s : t.all}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-1.5 mb-4 flex-wrap">
          {ADDR_STATES.map((s) => (
            <button
              key={s}
              onClick={() => setAddrFilter(s)}
              className={`px-3 py-1 rounded-full text-[12px] font-bold border ${
                addrFilter === s ? 'border-gold/50 text-gold' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.stateNames[s] || s}
            </button>
          ))}
        </div>
      )}

      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] rounded-2xl p-3 mb-4">{actionError}</div>
      )}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] rounded-2xl p-3 mb-4">{loadError}</div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-7 h-7 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
        </div>
      ) : tab !== 'addresses' ? (
        cases.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-10">{t.empty}</p>
        ) : (
          <div className="space-y-3">
            {cases.map((k) => (
              <div key={k.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-bold text-[14px] truncate">{k.user_email}</p>
                    <p className="text-[12px] text-zinc-500">
                      {k.case_type === 'identity' ? (k.doc_type || '—') : t.tabPhone} ·{' '}
                      {k.submitted_at ? new Date(k.submitted_at).toLocaleString() : '—'}
                      {k.case_type === 'identity' && ` · ${k.evidence_count} 📎`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {stateChip(k.state)}
                    <button
                      onClick={() => openCase(k.id)}
                      className="px-3 py-1.5 rounded-lg border border-zinc-700 text-[12px] font-bold hover:bg-zinc-800 inline-flex items-center gap-1.5"
                    >
                      <Eye className="w-3.5 h-3.5" /> {t.openCase}
                    </button>
                  </div>
                </div>
                {k.reason && (
                  <p className="text-[12px] text-orange-300 mt-2">{k.reason}</p>
                )}
              </div>
            ))}
          </div>
        )
      ) : addrRequests.length === 0 ? (
        <p className="text-zinc-500 text-sm text-center py-10">{t.empty}</p>
      ) : (
        <div className="space-y-3">
          {addrRequests.map((r) => (
            <div key={r.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <p className="font-bold text-[14px] truncate">{r.user_email}</p>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-500">
                    {t.version} #{r.version}
                  </span>
                  {stateChip(r.state)}
                </div>
              </div>
              <p className="text-[13px]">{r.name}</p>
              <p className="text-[13px] text-zinc-400">{r.address}</p>
              {r.landmark && <p className="text-[12px] text-zinc-500">{r.landmark}</p>}
              <p className="text-[12px] text-zinc-500 mt-1" dir="ltr">{r.phone_e164}</p>
              <p className="text-[12px] text-zinc-400 mt-2">
                <span className="font-bold">{t.customerReason}</span> {r.reason}
              </p>
              <p className="text-[11px] text-zinc-600 mt-1">{t.snapshotNote}</p>
              {r.state === 'pending' && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => decideAddress(r.id, true)}
                    disabled={busy}
                    className="px-4 py-2 rounded-xl bg-emerald-500/15 text-emerald-400 text-[13px] font-bold hover:bg-emerald-500/25 disabled:opacity-40 inline-flex items-center gap-1.5"
                  >
                    <ShieldCheck className="w-4 h-4" /> {t.approve}
                  </button>
                  <button
                    onClick={() => decideAddress(r.id, false)}
                    disabled={busy}
                    className="px-4 py-2 rounded-xl bg-red-500/10 text-red-400 text-[13px] font-bold hover:bg-red-500/20 disabled:opacity-40"
                  >
                    {t.rejectAddr}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* CASE DETAIL — the audited decrypted view.

          It was a `fixed inset-0` div mounted on `detail`, so an identity
          document appeared instantly and vanished instantly with no Escape
          key at all: the only way out was the button at the very bottom of a
          scrolling panel. On a screen whose whole point is that opening it is
          AUDITED, being able to close it the moment you realise it is the
          wrong case matters. `solid` keeps its own near-black ground, because
          a decrypted document read through tinted glass is a document read
          badly. */}
      <Overlay
        open={!!detail}
        onClose={() => setDetail(null)}
        label={detail?.user_email ?? t.auditWarn}
        placement="bottom"
        z={60}
        solid
        testId="kyc-case-detail"
        panelClassName="w-full max-w-xl max-h-[88dvh] overflow-y-auto bg-[#0a0a0a] border border-zinc-800 !rounded-t-[28px] sm:!rounded-[28px]"
      >
          <div className="p-5">
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold">{detail.user_email}</p>
              {stateChip(detail.state)}
            </div>
            <p className="text-[11px] text-amber-400 flex items-center gap-1.5 mb-4">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {t.auditWarn}
            </p>

            {detail.case_type === 'identity' ? (
              <div className="space-y-2 text-[13px]">
                {!detail.fields_readable && (
                  <p className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-[12px]">
                    {t.unreadable}
                  </p>
                )}
                <p><span className="text-zinc-500">{t.fullName}:</span> <span className="font-bold">{detail.full_name ?? '—'}</span></p>
                <p><span className="text-zinc-500">{t.dob}:</span> <span dir="ltr">{detail.dob ?? '—'}</span></p>
                <p><span className="text-zinc-500">{t.docType}:</span> {detail.doc_type ?? '—'}</p>
                <p><span className="text-zinc-500">{t.docNumber}:</span> <span dir="ltr" className="font-mono">{detail.doc_number ?? '—'}</span></p>

                <div className="pt-2">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-zinc-400 text-[12px] font-bold">{t.evidence}</p>
                    <button
                      onClick={() => setShowEvidence((v) => !v)}
                      className="px-3 py-1 rounded-lg border border-zinc-700 text-[12px] font-bold inline-flex items-center gap-1.5"
                    >
                      {showEvidence ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      {showEvidence ? t.hideEvidence : t.showEvidence}
                    </button>
                  </div>
                  {showEvidence && (
                    <div className="grid grid-cols-2 gap-2">
                      {detail.evidence_indexes.map((i) => (
                        <img
                          key={i}
                          src={`/api/kyc/admin/cases/${detail.id}/evidence/${i}`}
                          alt={`evidence ${i + 1}`}
                          className="w-full rounded-xl border border-zinc-800 max-w-full"
                          loading="lazy"
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-[13px]">
                <p>
                  <span className="text-zinc-500">{t.newPhone}:</span>{' '}
                  <span dir="ltr" className="font-bold">{detail.payload?.new_phone_e164 || '—'}</span>
                </p>
                <p><span className="text-zinc-500">{t.proof}:</span> {detail.payload?.proof || '—'}</p>
              </div>
            )}

            {detail.reason && (
              <p className="text-[12px] text-orange-300 mt-3">{detail.reason}</p>
            )}

            {(detail.state === 'submitted' || detail.state === 'reviewing') && (
              <div className="mt-5 border-t border-zinc-800 pt-4">
                <p className="text-[12px] font-bold text-zinc-400 mb-2">{t.decisions}</p>
                <div className="flex gap-2 flex-wrap">
                  {detail.state === 'submitted' && (
                    <button
                      onClick={() => decide(detail.id, 'reviewing')}
                      disabled={busy}
                      className="px-3.5 py-2 rounded-xl bg-amber-500/15 text-amber-300 text-[13px] font-bold hover:bg-amber-500/25 disabled:opacity-40 inline-flex items-center gap-1.5"
                    >
                      <Clock className="w-4 h-4" /> {t.startReview}
                    </button>
                  )}
                  <button
                    onClick={() => decide(detail.id, 'changes_requested')}
                    disabled={busy}
                    className="px-3.5 py-2 rounded-xl bg-orange-500/15 text-orange-300 text-[13px] font-bold hover:bg-orange-500/25 disabled:opacity-40"
                  >
                    {t.reqChanges}
                  </button>
                  <button
                    onClick={() => decide(detail.id, 'rejected')}
                    disabled={busy}
                    className="px-3.5 py-2 rounded-xl bg-red-500/10 text-red-400 text-[13px] font-bold hover:bg-red-500/20 disabled:opacity-40"
                  >
                    {t.reject}
                  </button>
                  <button
                    onClick={() => decide(detail.id, 'verified')}
                    disabled={busy}
                    className="px-3.5 py-2 rounded-xl bg-emerald-500/15 text-emerald-400 text-[13px] font-bold hover:bg-emerald-500/25 disabled:opacity-40 inline-flex items-center gap-1.5"
                  >
                    <ShieldCheck className="w-4 h-4" /> {t.verify}
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={() => setDetail(null)}
              className="mt-5 w-full py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 font-bold text-sm"
            >
              {t.close}
            </button>
          </div>
      </Overlay>
    </div>
  );
}
