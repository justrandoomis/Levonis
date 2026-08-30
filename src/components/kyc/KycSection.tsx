import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, ShieldAlert, IdCard, Phone, MapPin, UploadCloud, X,
  RefreshCw, Clock, CheckCircle, AlertTriangle, Lock,
} from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, isNotConfigured } from '../../lib/api';

/**
 * Customer PRO identity verification (KYC) + approved-address section.
 *
 * Deliberately SEPARATE from any public profile: nothing here is prefilled
 * from or written to the public profile, and the server never exposes these
 * fields publicly. Uploading documents is NOT verification — only the human
 * admin decision sets 'verified', and this UI never claims otherwise.
 */

const STRINGS = {
  ar: {
    title: 'التحقق من الهوية (PRO)',
    privacyNote: 'بيانات الهوية هنا منفصلة تمامًا عن ملفك العام ولا تظهر لأي مستخدم آخر. تُخزَّن الحقول الحساسة مشفّرة ولا يطّلع عليها إلا موظف مراجعة مخوَّل ضمن سجل تدقيق.',
    notConfigured: 'التحقق من الهوية غير مفعّل على هذا الخادم بعد (مفتاح التشفير غير مضبوط). لا يمكن استقبال أي بيانات حتى يفعّله المالك — هذه حالة صادقة وليست عطلًا.',
    loadError: 'تعذر تحميل حالة التحقق.',
    retry: 'إعادة المحاولة',
    phoneTitle: 'الهاتف الموثَّق',
    phoneLinked: (m: string) => `رقمك الموثَّق عبر تيليغرام: ${m}`,
    phoneMissing: 'يجب توثيق رقم هاتفك عبر تيليغرام قبل تقديم طلب التحقق.',
    phoneGo: 'توثيق الهاتف من الإعدادات',
    idTitle: 'حالة التحقق',
    stateNames: {
      draft: 'مسودة', submitted: 'مُقدَّم', reviewing: 'قيد المراجعة',
      changes_requested: 'مطلوب تعديل', rejected: 'مرفوض', verified: 'موثَّق',
    } as Record<string, string>,
    reasonLabel: 'ملاحظة المراجعة:',
    verifiedNote: 'اكتمل توثيق هويتك بقرار مراجعة بشري.',
    pendingNote: 'طلبك لدى فريق المراجعة. رفع الصور ليس توثيقًا بحد ذاته — القرار النهائي بشري.',
    formTitle: 'تقديم طلب التحقق',
    resubmitTitle: 'إعادة التقديم بعد التعديل',
    fullName: 'الاسم الثلاثي الكامل (كما في الوثيقة)',
    fullNameHint: 'ثلاثة مقاطع على الأقل.',
    dob: 'تاريخ الميلاد',
    docType: 'نوع الوثيقة (واحدة فقط)',
    nationalId: 'البطاقة الوطنية',
    passport: 'جواز السفر',
    docNumber: 'رقم الوثيقة',
    evidence: 'صور الوثيقة',
    evidenceHint: 'حتى 6 صور (JPEG/PNG/WebP، بحد 8MB). تُرفع لتخزين خاص بلا رابط عام.',
    addImages: 'إضافة صور',
    uploading: 'جارٍ الرفع…',
    submit: 'إرسال طلب التحقق',
    submitting: 'جارٍ الإرسال…',
    submitOk: 'استُلم طلبك وسيراجَع يدويًا.',
    minAgeNote: 'الحد الأدنى للعمر المقبول قرار مالك معلّق وسيُعلن ضمن السياسة قبل التفعيل النهائي.',
    addrTitle: 'العنوان الافتراضي المعتمد (PRO)',
    addrNone: 'لا يوجد عنوان معتمد بعد.',
    addrCurrent: (v: number) => `النسخة المعتمدة الحالية #${v}`,
    addrMatches: 'عنوانك المحفوظ مطابق للنسخة المعتمدة.',
    addrMismatch: 'تنبيه: عدّلت العنوان المحفوظ بعد اعتماده — النسخة المعتمدة لم تتغير، ومزايا PRO تُحسب على النسخة المعتمدة فقط. لتغييرها قدّم طلبًا جديدًا.',
    addrSourceGone: 'العنوان المحفوظ الذي بُنيت عليه النسخة المعتمدة حُذف — النسخة المعتمدة نفسها محفوظة ولم تتأثر.',
    addrPending: 'طلب اعتماد قيد المراجعة',
    addrNominate: 'ترشيح عنوان للاعتماد',
    addrPick: 'اختر عنوانًا من عناوينك المحفوظة',
    addrReason: 'سبب الطلب',
    addrReasonPh: 'مثال: هذا عنوان سكني الدائم…',
    addrSend: 'إرسال طلب الاعتماد',
    addrSent: 'أُرسل الطلب — يتطلب موافقة إدارية.',
    addrNoSaved: 'لا توجد عناوين محفوظة — أضف عنوانًا أولًا.',
    addrManage: 'إدارة العناوين',
    phoneChangeTitle: 'تغيير الهاتف المعتمد',
    phoneChangeNote: 'يتطلب إثبات ملكية حديثًا عبر تيليغرام (خلال آخر 30 دقيقة) ثم موافقة إدارية. أعد توثيق الرقم الجديد من الإعدادات ثم اضغط هنا.',
    phoneChangeBtn: 'طلب تغيير الهاتف',
    phoneChangePending: (m: string) => `طلب تغيير الهاتف إلى ${m} قيد المراجعة.`,
    phoneChangeSent: 'أُرسل طلب تغيير الهاتف للمراجعة.',
    actionError: 'تعذر تنفيذ الإجراء',
    signIn: 'سجّل الدخول لعرض هذا القسم.',
  },
  en: {
    title: 'Identity Verification (PRO)',
    privacyNote: 'Identity data here is fully separate from your public profile and is never shown to other users. Sensitive fields are stored encrypted and only an authorized reviewer sees them, under an audit log.',
    notConfigured: 'Identity verification is not enabled on this server yet (the encryption key is not configured). No data can be accepted until the owner enables it — this is an honest state, not a bug.',
    loadError: 'Could not load your verification status.',
    retry: 'Retry',
    phoneTitle: 'Verified phone',
    phoneLinked: (m: string) => `Your Telegram-verified number: ${m}`,
    phoneMissing: 'You must verify your phone through Telegram before submitting a verification request.',
    phoneGo: 'Verify phone in Settings',
    idTitle: 'Verification status',
    stateNames: {
      draft: 'Draft', submitted: 'Submitted', reviewing: 'In review',
      changes_requested: 'Changes requested', rejected: 'Rejected', verified: 'Verified',
    } as Record<string, string>,
    reasonLabel: 'Review note:',
    verifiedNote: 'Your identity was verified by a human review decision.',
    pendingNote: 'Your request is with the review team. Uploading images is not verification by itself — the final decision is human.',
    formTitle: 'Submit a verification request',
    resubmitTitle: 'Resubmit after changes',
    fullName: 'Full three-part name (as on the document)',
    fullNameHint: 'At least three parts.',
    dob: 'Date of birth',
    docType: 'Document type (exactly one)',
    nationalId: 'National ID card',
    passport: 'Passport',
    docNumber: 'Document number',
    evidence: 'Document photos',
    evidenceHint: 'Up to 6 images (JPEG/PNG/WebP, max 8MB). Uploaded to private storage with no public URL.',
    addImages: 'Add images',
    uploading: 'Uploading…',
    submit: 'Send verification request',
    submitting: 'Sending…',
    submitOk: 'Your request was received and will be reviewed manually.',
    minAgeNote: 'The minimum accepted age is a pending owner decision and will be announced in the policy before final activation.',
    addrTitle: 'Approved default address (PRO)',
    addrNone: 'No approved address yet.',
    addrCurrent: (v: number) => `Current approved version #${v}`,
    addrMatches: 'Your saved address matches the approved version.',
    addrMismatch: 'Notice: you edited the saved address after approval — the approved version is unchanged, and PRO benefits are computed against the approved version only. To change it, submit a new request.',
    addrSourceGone: 'The saved address the approved version was based on was deleted — the approved version itself is preserved and unaffected.',
    addrPending: 'Approval request under review',
    addrNominate: 'Nominate an address for approval',
    addrPick: 'Pick one of your saved addresses',
    addrReason: 'Reason for the request',
    addrReasonPh: 'e.g. This is my permanent home address…',
    addrSend: 'Send approval request',
    addrSent: 'Request sent — it requires admin approval.',
    addrNoSaved: 'No saved addresses — add one first.',
    addrManage: 'Manage addresses',
    phoneChangeTitle: 'Change the approved phone',
    phoneChangeNote: 'Requires fresh Telegram ownership proof (within the last 30 minutes) and then admin approval. Re-verify the new number in Settings, then tap here.',
    phoneChangeBtn: 'Request phone change',
    phoneChangePending: (m: string) => `Phone change to ${m} is under review.`,
    phoneChangeSent: 'Phone-change request sent for review.',
    actionError: 'The action failed',
    signIn: 'Sign in to view this section.',
  },
  ckb: {
    title: 'پشتڕاستکردنەوەی ناسنامە (PRO)',
    privacyNote: 'داتای ناسنامە لێرە بە تەواوی جیاوازە لە پرۆفایلی گشتیت و هەرگیز بۆ بەکارهێنەرانی تر پیشان نادرێت. خانە هەستیارەکان بە کۆدکراوی هەڵدەگیرێن و تەنها پێداچوونەوەکاری مۆڵەتدار دەیانبینێت، لەژێر تۆماری چاودێریدا.',
    notConfigured: 'پشتڕاستکردنەوەی ناسنامە هێشتا لەم سێرڤەرەدا چالاک نییە (کلیلی کۆدکردن ڕێکنەخراوە). هیچ داتایەک وەرناگیرێت هەتا خاوەنەکە چالاکی دەکات — ئەمە دۆخێکی ڕاستگۆیە، نەک هەڵە.',
    loadError: 'دۆخی پشتڕاستکردنەوەکەت بار نەبوو.',
    retry: 'هەوڵدانەوە',
    phoneTitle: 'تەلەفۆنی پشتڕاستکراو',
    phoneLinked: (m: string) => `ژمارە پشتڕاستکراوەکەت بە تێلێگرام: ${m}`,
    phoneMissing: 'پێویستە ژمارەکەت بە تێلێگرام پشتڕاست بکەیتەوە پێش ناردنی داواکاری پشتڕاستکردنەوە.',
    phoneGo: 'پشتڕاستکردنەوەی تەلەفۆن لە ڕێکخستنەکان',
    idTitle: 'دۆخی پشتڕاستکردنەوە',
    stateNames: {
      draft: 'ڕەشنووس', submitted: 'نێردراوە', reviewing: 'لە پێداچوونەوەدایە',
      changes_requested: 'گۆڕانکاری داواکراوە', rejected: 'ڕەتکراوەتەوە', verified: 'پشتڕاستکراوە',
    } as Record<string, string>,
    reasonLabel: 'تێبینی پێداچوونەوە:',
    verifiedNote: 'ناسنامەکەت بە بڕیاری پێداچوونەوەی مرۆیی پشتڕاست کرایەوە.',
    pendingNote: 'داواکارییەکەت لای تیمی پێداچوونەوەیە. بارکردنی وێنە بە تەنها پشتڕاستکردنەوە نییە — بڕیاری کۆتایی مرۆییە.',
    formTitle: 'ناردنی داواکاری پشتڕاستکردنەوە',
    resubmitTitle: 'دووبارە ناردن دوای گۆڕانکاری',
    fullName: 'ناوی سیانی تەواو (وەک لە بەڵگەنامەکەدا)',
    fullNameHint: 'بەلایەنی کەمەوە سێ بەش.',
    dob: 'ڕێکەوتی لەدایکبوون',
    docType: 'جۆری بەڵگەنامە (تەنها یەک)',
    nationalId: 'کارتی نیشتمانی',
    passport: 'پاسپۆرت',
    docNumber: 'ژمارەی بەڵگەنامە',
    evidence: 'وێنەکانی بەڵگەنامە',
    evidenceHint: 'هەتا ٦ وێنە (JPEG/PNG/WebP، زۆرترین 8MB). بۆ کۆگای تایبەت بار دەکرێن بەبێ بەستەری گشتی.',
    addImages: 'زیادکردنی وێنە',
    uploading: 'بار دەکرێت…',
    submit: 'ناردنی داواکاری پشتڕاستکردنەوە',
    submitting: 'دەنێردرێت…',
    submitOk: 'داواکارییەکەت وەرگیرا و بە دەستی پێداچوونەوەی بۆ دەکرێت.',
    minAgeNote: 'کەمترین تەمەنی وەرگیراو بڕیارێکی خاوەنە کە ماوە و پێش چالاککردنی کۆتایی لە سیاسەتەکەدا ڕادەگەیەنرێت.',
    addrTitle: 'ناونیشانی بنەڕەتی پەسەندکراو (PRO)',
    addrNone: 'هێشتا ناونیشانی پەسەندکراو نییە.',
    addrCurrent: (v: number) => `وەشانی پەسەندکراوی ئێستا #${v}`,
    addrMatches: 'ناونیشانە پاشەکەوتکراوەکەت لەگەڵ وەشانە پەسەندکراوەکە یەکسانە.',
    addrMismatch: 'ئاگاداری: ناونیشانە پاشەکەوتکراوەکەت دوای پەسەندکردن گۆڕاوە — وەشانە پەسەندکراوەکە نەگۆڕاوە، و سوودەکانی PRO تەنها لەسەر وەشانە پەسەندکراوەکە دەژمێردرێن. بۆ گۆڕینی، داواکارییەکی نوێ بنێرە.',
    addrSourceGone: 'ئەو ناونیشانە پاشەکەوتکراوەی وەشانە پەسەندکراوەکەی لەسەر بنیات نرابوو سڕایەوە — وەشانە پەسەندکراوەکە خۆی پارێزراوە و کاریگەر نەبووە.',
    addrPending: 'داواکاری پەسەندکردن لە پێداچوونەوەدایە',
    addrNominate: 'دیاریکردنی ناونیشانێک بۆ پەسەندکردن',
    addrPick: 'یەکێک لە ناونیشانە پاشەکەوتکراوەکانت هەڵبژێرە',
    addrReason: 'هۆکاری داواکارییەکە',
    addrReasonPh: 'بۆ نموونە: ئەمە ناونیشانی نیشتەجێبوونی هەمیشەییمە…',
    addrSend: 'ناردنی داواکاری پەسەندکردن',
    addrSent: 'داواکارییەکە نێردرا — پێویستی بە پەسەندکردنی بەڕێوەبەرایەتییە.',
    addrNoSaved: 'هیچ ناونیشانێکی پاشەکەوتکراو نییە — سەرەتا یەکێک زیاد بکە.',
    addrManage: 'بەڕێوەبردنی ناونیشانەکان',
    phoneChangeTitle: 'گۆڕینی تەلەفۆنی پەسەندکراو',
    phoneChangeNote: 'پێویستی بە بەڵگەی خاوەندارێتی نوێی تێلێگرامە (لە ٣٠ خولەکی ڕابردوودا) و پاشان پەسەندکردنی بەڕێوەبەرایەتی. ژمارە نوێیەکە لە ڕێکخستنەکان دووبارە پشتڕاست بکەوە، پاشان لێرە دابگرە.',
    phoneChangeBtn: 'داواکاری گۆڕینی تەلەفۆن',
    phoneChangePending: (m: string) => `گۆڕینی تەلەفۆن بۆ ${m} لە پێداچوونەوەدایە.`,
    phoneChangeSent: 'داواکاری گۆڕینی تەلەفۆن بۆ پێداچوونەوە نێردرا.',
    actionError: 'کردارەکە سەرکەوتوو نەبوو',
    signIn: 'بچۆ ژوورەوە بۆ بینینی ئەم بەشە.',
  },
} as const;

interface MineResponse {
  configured: boolean;
  phone: { linked: boolean; phone_masked: string | null; verified_at: string | null };
  identity: {
    id: string; state: string; reason: string; doc_type: string | null;
    evidence_count: number; submitted_at: string | null; decided_at: string | null;
    created_at: string; retention_status: string;
  } | null;
  phone_change: {
    id: string; state: string; reason: string; new_phone_masked: string;
    submitted_at: string | null; decided_at: string | null;
  } | null;
  approved_address: {
    version: number; name: string; phone_e164: string; address: string; landmark: string;
    approved_at: string | null; source_address_id: string | null;
    source_address_exists: boolean; matches_saved_address: boolean | null;
  } | null;
  pending_address_request: {
    id: string; version: number; name: string; address: string; landmark: string;
    reason: string; requested_at: string;
  } | null;
}

interface SavedAddress {
  id: string; label: string; name: string; phone: string; address: string; landmark: string; is_default: number;
}

const STATE_STYLE: Record<string, string> = {
  draft: 'bg-zinc-700/40 text-zinc-300',
  submitted: 'bg-sky-500/15 text-sky-400',
  reviewing: 'bg-amber-500/15 text-amber-400',
  changes_requested: 'bg-orange-500/15 text-orange-400',
  rejected: 'bg-red-500/15 text-red-400',
  verified: 'bg-emerald-500/15 text-emerald-400',
};

export default function KycSection() {
  const { isAuthenticated, isLoaded } = useAuth();
  const { lang } = useLanguage();
  const t = STRINGS[lang] || STRINGS.ar;

  const [data, setData] = useState<MineResponse | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [okMsg, setOkMsg] = useState('');

  // Identity form
  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [docType, setDocType] = useState<'national_id' | 'passport'>('national_id');
  const [docNumber, setDocNumber] = useState('');
  const [evidenceKeys, setEvidenceKeys] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Address nomination
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [pickedAddressId, setPickedAddressId] = useState('');
  const [addrReason, setAddrReason] = useState('');
  const [isNominating, setIsNominating] = useState(false);
  const [isRequestingPhone, setIsRequestingPhone] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    setIsLoading(true);
    try {
      const res = await api.get<MineResponse>('/api/kyc/mine');
      setData(res);
      setNotConfigured(!res.configured);
      try {
        const a = await api.get<{ addresses: SavedAddress[] }>('/api/addresses');
        setAddresses(a.addresses);
      } catch {
        setAddresses([]);
      }
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setLoadError((err as Error)?.message || 'error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isAuthenticated) {
      setIsLoading(false);
      return;
    }
    load();
  }, [isLoaded, isAuthenticated, load]);

  const uploadEvidence = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setActionError('');
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (evidenceKeys.length >= 6) break;
        const form = new FormData();
        form.append('file', file);
        const res = await api.post<{ key: string }>('/api/kyc/upload', form);
        setEvidenceKeys((prev) => (prev.includes(res.key) || prev.length >= 6 ? prev : [...prev, res.key]));
      }
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setIsUploading(false);
    }
  };

  const submitIdentity = async () => {
    if (isSubmitting) return;
    setActionError('');
    setOkMsg('');
    setIsSubmitting(true);
    try {
      await api.post('/api/kyc/submit', { fullName, dob, docType, docNumber, evidenceKeys });
      setOkMsg(t.submitOk);
      setFullName('');
      setDob('');
      setDocNumber('');
      setEvidenceKeys([]);
      await load();
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setIsSubmitting(false);
    }
  };

  const nominateAddress = async () => {
    if (isNominating) return;
    setActionError('');
    setOkMsg('');
    setIsNominating(true);
    try {
      await api.post('/api/kyc/address-request', { addressId: pickedAddressId, reason: addrReason });
      setOkMsg(t.addrSent);
      setPickedAddressId('');
      setAddrReason('');
      await load();
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setIsNominating(false);
    }
  };

  const requestPhoneChange = async () => {
    if (isRequestingPhone) return;
    setActionError('');
    setOkMsg('');
    setIsRequestingPhone(true);
    try {
      await api.post('/api/kyc/phone-change-request');
      setOkMsg(t.phoneChangeSent);
      await load();
    } catch (err) {
      setActionError((err as ApiError)?.message || t.actionError);
    } finally {
      setIsRequestingPhone(false);
    }
  };

  if (!isLoaded || isLoading) {
    return (
      <div className="flex justify-center py-10">
        <div className="w-7 h-7 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <p className="text-zinc-500 text-sm text-center py-8">{t.signIn}</p>;
  }

  const identity = data?.identity ?? null;
  const canSubmit =
    !identity || identity.state === 'changes_requested' || identity.state === 'rejected' || identity.state === 'draft';
  const phoneLinked = !!data?.phone.linked;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <IdCard className="w-5 h-5 text-gold" />
        <h2 className="font-bold text-[16px]">{t.title}</h2>
      </div>

      <p className="text-[12px] text-zinc-500 flex gap-2 items-start">
        <Lock className="w-4 h-4 shrink-0 mt-[1px]" />
        {t.privacyNote}
      </p>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] rounded-2xl p-3">
          {t.loadError}
          <button onClick={load} className="ms-3 underline font-bold inline-flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> {t.retry}
          </button>
        </div>
      )}
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] rounded-2xl p-3">{actionError}</div>
      )}
      {okMsg && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[13px] rounded-2xl p-3">{okMsg}</div>
      )}

      {notConfigured ? (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[13px] rounded-2xl p-4 flex gap-2">
          <ShieldAlert className="w-5 h-5 shrink-0" />
          <p>{t.notConfigured}</p>
        </div>
      ) : (
        data && (
          <>
            {/* Phone prerequisite */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Phone className="w-4 h-4 text-zinc-400" />
                <p className="font-bold text-[14px]">{t.phoneTitle}</p>
              </div>
              {phoneLinked ? (
                <p className="text-[13px] text-emerald-400">{t.phoneLinked(data.phone.phone_masked || '')}</p>
              ) : (
                <div className="text-[13px] text-zinc-400">
                  <p>{t.phoneMissing}</p>
                  <Link to="/settings" className="text-gold font-bold underline">
                    {t.phoneGo}
                  </Link>
                </div>
              )}
            </div>

            {/* Identity status */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <p className="font-bold text-[14px]">{t.idTitle}</p>
                {identity ? (
                  <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${STATE_STYLE[identity.state] || STATE_STYLE.draft}`}>
                    {t.stateNames[identity.state] || identity.state}
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500">—</span>
                )}
              </div>
              {identity?.state === 'verified' && (
                <p className="text-[13px] text-emerald-400 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4" /> {t.verifiedNote}
                </p>
              )}
              {identity && (identity.state === 'submitted' || identity.state === 'reviewing') && (
                <p className="text-[13px] text-zinc-400 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" /> {t.pendingNote}
                </p>
              )}
              {identity && identity.reason && (
                <p className="text-[13px] text-orange-300 mt-2">
                  <span className="font-bold">{t.reasonLabel}</span> {identity.reason}
                </p>
              )}
            </div>

            {/* Identity submission form */}
            {canSubmit && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
                <p className="font-bold text-[14px]">
                  {identity && identity.state !== 'draft' ? t.resubmitTitle : t.formTitle}
                </p>

                <div>
                  <label className="text-[12px] text-zinc-400 block mb-1">{t.fullName}</label>
                  <input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-gold/50"
                  />
                  <p className="text-[11px] text-zinc-600 mt-1">{t.fullNameHint}</p>
                </div>

                <div>
                  <label className="text-[12px] text-zinc-400 block mb-1">{t.dob}</label>
                  <input
                    type="date"
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                    className="w-full bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-gold/50"
                  />
                  <p className="text-[11px] text-zinc-600 mt-1">{t.minAgeNote}</p>
                </div>

                <div>
                  <label className="text-[12px] text-zinc-400 block mb-2">{t.docType}</label>
                  <div className="flex gap-2">
                    {(['national_id', 'passport'] as const).map((dt) => (
                      <button
                        key={dt}
                        type="button"
                        onClick={() => setDocType(dt)}
                        className={`flex-1 py-2.5 rounded-xl border text-[13px] font-bold transition-colors ${
                          docType === dt
                            ? 'border-gold/60 bg-gold/10 text-gold'
                            : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                        }`}
                      >
                        {dt === 'national_id' ? t.nationalId : t.passport}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[12px] text-zinc-400 block mb-1">{t.docNumber}</label>
                  <input
                    value={docNumber}
                    onChange={(e) => setDocNumber(e.target.value)}
                    dir="ltr"
                    className="w-full bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-gold/50"
                  />
                </div>

                <div>
                  <label className="text-[12px] text-zinc-400 block mb-1">{t.evidence}</label>
                  <p className="text-[11px] text-zinc-600 mb-2">{t.evidenceHint}</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-full text-[13px] font-bold inline-flex items-center gap-2 cursor-pointer">
                      <UploadCloud className="w-4 h-4" />
                      {isUploading ? t.uploading : t.addImages}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        multiple
                        className="hidden"
                        disabled={isUploading || evidenceKeys.length >= 6}
                        onChange={(e) => {
                          uploadEvidence(e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {evidenceKeys.map((k, i) => (
                      <span
                        key={k}
                        className="text-[11px] bg-zinc-800 border border-zinc-700 rounded-full px-2.5 py-1 inline-flex items-center gap-1.5"
                      >
                        #{i + 1}
                        <button
                          type="button"
                          onClick={() => setEvidenceKeys((prev) => prev.filter((x) => x !== k))}
                          aria-label="remove"
                        >
                          <X className="w-3 h-3 text-zinc-500 hover:text-red-400" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <button
                  onClick={submitIdentity}
                  disabled={isSubmitting || isUploading || !phoneLinked || evidenceKeys.length === 0}
                  className="w-full py-3.5 rounded-2xl bg-olive hover:bg-olive-light font-bold text-[14px] disabled:opacity-40 transition-colors"
                >
                  {isSubmitting ? t.submitting : t.submit}
                </button>
                {!phoneLinked && (
                  <p className="text-[12px] text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" /> {t.phoneMissing}
                  </p>
                )}
              </div>
            )}

            {/* Approved address */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-zinc-400" />
                <p className="font-bold text-[14px]">{t.addrTitle}</p>
              </div>

              {data.approved_address ? (
                <div className="bg-zinc-800/50 border border-gold/20 rounded-xl p-3">
                  <p className="text-[12px] text-gold font-bold mb-1 flex items-center gap-1.5">
                    <CheckCircle className="w-3.5 h-3.5" /> {t.addrCurrent(data.approved_address.version)}
                  </p>
                  <p className="text-[13px] font-bold">{data.approved_address.name}</p>
                  <p className="text-[13px] text-zinc-400">{data.approved_address.address}</p>
                  {data.approved_address.landmark && (
                    <p className="text-[12px] text-zinc-500">{data.approved_address.landmark}</p>
                  )}
                  <p className="text-[12px] text-zinc-500 mt-1" dir="ltr">
                    {data.approved_address.phone_e164}
                  </p>
                  {data.approved_address.matches_saved_address === true && (
                    <p className="text-[12px] text-emerald-400 mt-2">{t.addrMatches}</p>
                  )}
                  {data.approved_address.matches_saved_address === false && (
                    <p className="text-[12px] text-amber-400 mt-2 flex gap-1.5">
                      <AlertTriangle className="w-4 h-4 shrink-0" /> {t.addrMismatch}
                    </p>
                  )}
                  {data.approved_address.source_address_id && !data.approved_address.source_address_exists && (
                    <p className="text-[12px] text-zinc-500 mt-2">{t.addrSourceGone}</p>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-zinc-500">{t.addrNone}</p>
              )}

              {data.pending_address_request ? (
                <div className="bg-sky-500/5 border border-sky-500/20 rounded-xl p-3">
                  <p className="text-[12px] text-sky-400 font-bold mb-1 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> {t.addrPending}
                  </p>
                  <p className="text-[13px]">{data.pending_address_request.name}</p>
                  <p className="text-[13px] text-zinc-400">{data.pending_address_request.address}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[13px] font-bold">{t.addrNominate}</p>
                  {addresses.length === 0 ? (
                    <p className="text-[13px] text-zinc-500">
                      {t.addrNoSaved}{' '}
                      <Link to="/addresses" className="text-gold underline font-bold">
                        {t.addrManage}
                      </Link>
                    </p>
                  ) : (
                    <>
                      <label className="text-[12px] text-zinc-400 block">{t.addrPick}</label>
                      <select
                        value={pickedAddressId}
                        onChange={(e) => setPickedAddressId(e.target.value)}
                        className="w-full bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-gold/50"
                      >
                        <option value="">—</option>
                        {addresses.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label} — {a.address.slice(0, 60)}
                          </option>
                        ))}
                      </select>
                      <label className="text-[12px] text-zinc-400 block">{t.addrReason}</label>
                      <textarea
                        value={addrReason}
                        onChange={(e) => setAddrReason(e.target.value)}
                        placeholder={t.addrReasonPh}
                        rows={2}
                        className="w-full bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-gold/50 resize-none"
                      />
                      <button
                        onClick={nominateAddress}
                        disabled={isNominating || !pickedAddressId || addrReason.trim().length < 5}
                        className="w-full py-3 rounded-2xl bg-zinc-800 hover:bg-zinc-700 font-bold text-[13px] disabled:opacity-40 transition-colors"
                      >
                        {isNominating ? '…' : t.addrSend}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Phone change (approved record) */}
            {data.approved_address && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2">
                <p className="font-bold text-[14px]">{t.phoneChangeTitle}</p>
                {data.phone_change && (data.phone_change.state === 'submitted' || data.phone_change.state === 'reviewing') ? (
                  <p className="text-[13px] text-sky-400 flex items-center gap-1.5">
                    <Clock className="w-4 h-4" /> {t.phoneChangePending(data.phone_change.new_phone_masked)}
                  </p>
                ) : (
                  <>
                    <p className="text-[12px] text-zinc-500">{t.phoneChangeNote}</p>
                    {data.phone_change && data.phone_change.reason && (
                      <p className="text-[12px] text-orange-300">
                        <span className="font-bold">{t.reasonLabel}</span> {data.phone_change.reason}
                      </p>
                    )}
                    <button
                      onClick={requestPhoneChange}
                      disabled={isRequestingPhone}
                      className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-full text-[13px] font-bold disabled:opacity-40"
                    >
                      {isRequestingPhone ? '…' : t.phoneChangeBtn}
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
