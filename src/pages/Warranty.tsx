import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import {
  ArrowLeft, ArrowRight, ShieldCheck, X, Clock, CheckCircle, XCircle, Search,
  Barcode, Paperclip, Send, Wrench, Repeat, AlertTriangle, MessageSquare,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';

/**
 * Warranty center rebuilt around registered PHYSICAL devices (mandate §4):
 * my-devices list with honest per-unit coverage, add-device-by-serial,
 * per-device claim submission with private photo/video evidence, and the
 * claim message thread. Legacy claims (pre-device rows) stay visible through
 * the same claims list, and the old free-form claim path is preserved for
 * products without a device record.
 */

const STRINGS = {
  ar: {
    title: 'مركز الضمان',
    myDevices: 'أجهزتي المسجّلة',
    devicesEmpty: 'لا توجد أجهزة مسجّلة بعد. أضف جهازك برقمه التسلسلي.',
    addDevice: 'إضافة جهاز',
    serialLabel: 'الرقم التسلسلي',
    serialPlaceholder: 'أدخل الرقم كما هو على ملصق الجهاز',
    register: 'تسجيل الجهاز',
    registering: 'جارٍ التحقق…',
    registeredOk: 'تم تسجيل الجهاز على حسابك.',
    alreadyRegistered: 'هذا الجهاز مسجّل مسبقًا على حسابك.',
    registerHint: 'يطابق الرقم أجهزة طلباتك المُسلَّمة فقط. التسجيل لا يغيّر تواريخ الضمان إطلاقًا.',
    supportHint: 'إذا استمرت المشكلة تواصل مع الدعم من صفحة الحساب.',
    orderRef: 'الطلب',
    deliveredAt: 'تاريخ التسليم',
    warrantyEnd: 'نهاية الضمان',
    stActive: 'الضمان ساري',
    stExpired: 'الضمان منتهٍ',
    stNeedsConfig: 'مدة الضمان بحاجة إعداد من الإدارة',
    stNotDelivered: 'لم يُسلَّم بعد',
    daysLeft: (n: number) => `${n} يوم متبقٍ`,
    openClaim: 'فتح مطالبة',
    claims: 'مطالباتي',
    claimsEmpty: 'ليس لديك أي مطالبات ضمان.',
    newClaimTitle: 'مطالبة ضمان جديدة',
    subject: 'الموضوع',
    subjectPh: 'مثال: توقّف السخان عن العمل',
    description: 'وصف المشكلة',
    descriptionPh: 'صف المشكلة بالتفصيل (10 أحرف على الأقل)…',
    attachments: 'صور / فيديو (اختياري، حتى 6)',
    uploading: 'جارٍ الرفع…',
    submit: 'إرسال المطالبة',
    submitting: 'جارٍ الإرسال…',
    thread: 'المحادثة',
    reply: 'اكتب رسالة…',
    send: 'إرسال',
    attach: 'إرفاق ملف',
    close: 'إغلاق',
    loading: 'جارٍ التحميل…',
    error: 'حدث خطأ، حاول مجددًا.',
    decisionReason: 'سبب القرار',
    legacyClaimLink: 'منتج غير مسجّل كجهاز؟ قدّم مطالبة عامة',
    productName: 'اسم المنتج',
    replacedBadge: 'مُستبدَل',
    stageLabels: {
      received: 'مُستلَمة', diagnosing: 'قيد الفحص', approved: 'مقبولة', rejected: 'مرفوضة',
      repairing: 'قيد الإصلاح', replaced: 'استبدال', resolved: 'منتهية',
    } as Record<string, string>,
    submittedAt: 'تاريخ التقديم',
  },
  en: {
    title: 'Warranty Center',
    myDevices: 'My registered devices',
    devicesEmpty: 'No registered devices yet. Add your device by its serial number.',
    addDevice: 'Add device',
    serialLabel: 'Serial number',
    serialPlaceholder: 'Enter it exactly as printed on the device label',
    register: 'Register device',
    registering: 'Checking…',
    registeredOk: 'Device registered to your account.',
    alreadyRegistered: 'This device is already registered to your account.',
    registerHint: 'The serial matches only devices on YOUR delivered orders. Registration never changes any warranty date.',
    supportHint: 'If the problem persists, contact support from your account page.',
    orderRef: 'Order',
    deliveredAt: 'Delivered',
    warrantyEnd: 'Warranty ends',
    stActive: 'Warranty active',
    stExpired: 'Warranty expired',
    stNeedsConfig: 'Warranty duration needs configuration by the store',
    stNotDelivered: 'Not delivered yet',
    daysLeft: (n: number) => `${n} days left`,
    openClaim: 'Open claim',
    claims: 'My claims',
    claimsEmpty: 'You do not have any warranty claims.',
    newClaimTitle: 'New warranty claim',
    subject: 'Subject',
    subjectPh: 'e.g. Heater stopped working',
    description: 'Problem description',
    descriptionPh: 'Describe the issue in detail (at least 10 characters)…',
    attachments: 'Photos / video (optional, up to 6)',
    uploading: 'Uploading…',
    submit: 'Submit claim',
    submitting: 'Submitting…',
    thread: 'Conversation',
    reply: 'Write a message…',
    send: 'Send',
    attach: 'Attach file',
    close: 'Close',
    loading: 'Loading…',
    error: 'Something went wrong, please try again.',
    decisionReason: 'Decision reason',
    legacyClaimLink: 'Product not registered as a device? Submit a general claim',
    productName: 'Product name',
    replacedBadge: 'Replaced',
    stageLabels: {
      received: 'Received', diagnosing: 'Diagnosing', approved: 'Approved', rejected: 'Rejected',
      repairing: 'Repairing', replaced: 'Replaced', resolved: 'Resolved',
    } as Record<string, string>,
    submittedAt: 'Submitted',
  },
  ckb: {
    title: 'ناوەندی گەرەنتی',
    myDevices: 'ئامێرە تۆمارکراوەکانم',
    devicesEmpty: 'هێشتا هیچ ئامێرێک تۆمار نەکراوە. ئامێرەکەت بە ژمارە زنجیرەییەکەی زیاد بکە.',
    addDevice: 'زیادکردنی ئامێر',
    serialLabel: 'ژمارە زنجیرەیی',
    serialPlaceholder: 'وەک لەسەر لەیبڵی ئامێرەکە نووسراوە بینووسە',
    register: 'تۆمارکردنی ئامێر',
    registering: 'پشکنین…',
    registeredOk: 'ئامێرەکە لەسەر هەژمارەکەت تۆمارکرا.',
    alreadyRegistered: 'ئەم ئامێرە پێشتر لەسەر هەژمارەکەت تۆمارکراوە.',
    registerHint: 'ژمارەکە تەنها لەگەڵ ئامێرەکانی داواکارییە گەیەنراوەکانی خۆت دەگونجێت. تۆمارکردن هەرگیز بەرواری گەرەنتی ناگۆڕێت.',
    supportHint: 'ئەگەر کێشەکە بەردەوام بوو، لە پەڕەی هەژمارەوە پەیوەندی بە پشتگیری بکە.',
    orderRef: 'داواکاری',
    deliveredAt: 'گەیاندن',
    warrantyEnd: 'کۆتایی گەرەنتی',
    stActive: 'گەرەنتی کارایە',
    stExpired: 'گەرەنتی بەسەرچووە',
    stNeedsConfig: 'ماوەی گەرەنتی پێویستی بە ڕێکخستنە لەلایەن فرۆشگاوە',
    stNotDelivered: 'هێشتا نەگەیەنراوە',
    daysLeft: (n: number) => `${n} ڕۆژ ماوە`,
    openClaim: 'کردنەوەی داواکاری',
    claims: 'داواکارییەکانم',
    claimsEmpty: 'هیچ داواکارییەکی گەرەنتیت نییە.',
    newClaimTitle: 'داواکاری گەرەنتی نوێ',
    subject: 'بابەت',
    subjectPh: 'نموونە: گەرمکەرەوەکە لە کارکەوت',
    description: 'وەسفی کێشەکە',
    descriptionPh: 'کێشەکە بە وردی باس بکە (لانیکەم ١٠ پیت)…',
    attachments: 'وێنە / ڤیدیۆ (ئارەزوومەندانە، تا ٦)',
    uploading: 'بارکردن…',
    submit: 'ناردنی داواکاری',
    submitting: 'ناردن…',
    thread: 'گفتوگۆ',
    reply: 'نامەیەک بنووسە…',
    send: 'ناردن',
    attach: 'هاوپێچکردنی فایل',
    close: 'داخستن',
    loading: 'باردەکرێت…',
    error: 'هەڵەیەک ڕوویدا، دووبارە هەوڵبدەوە.',
    decisionReason: 'هۆکاری بڕیار',
    legacyClaimLink: 'بەرهەمەکە وەک ئامێر تۆمار نەکراوە؟ داواکاری گشتی پێشکەش بکە',
    productName: 'ناوی بەرهەم',
    replacedBadge: 'گۆڕدراوەتەوە',
    stageLabels: {
      received: 'وەرگیراوە', diagnosing: 'لە پشکنیندایە', approved: 'پەسەندکراوە', rejected: 'ڕەتکراوەتەوە',
      repairing: 'لە چاککردنەوەدایە', replaced: 'گۆڕدراوەتەوە', resolved: 'تەواوبووە',
    } as Record<string, string>,
    submittedAt: 'بەرواری پێشکەشکردن',
  },
} as const;

interface MyDevice {
  unit_id: string;
  order_id: string;
  unit_index: number;
  product: { id: string | null; slug: string | null; name: string; name_ar: string; name_ckb: string; image: string };
  serial: string | null;
  delivered_at: string | null;
  registered_at: string | null;
  warranty: {
    start_at: string | null;
    end_at: string | null;
    base_months: number | null;
    ext_months: number;
    state: 'active' | 'expired' | 'needs_config' | 'not_delivered';
    remaining_days: number | null;
  };
  replaced_by_unit_id: string | null;
}

interface MyClaim {
  id: string;
  unit_id: string | null;
  subject: string;
  product_name: string;
  description: string;
  stage: string;
  decision_reason: string;
  admin_note: string;
  created_at: string;
  serial: string | null;
  evidence: Array<{ key: string; url: string }>;
}

interface ClaimMessage {
  id: string;
  is_staff: boolean;
  mine: boolean;
  body: string;
  file_url: string | null;
  created_at: string;
}

interface ClaimDetail {
  claim: MyClaim;
  warranty_facts: { order_id: string; delivered_at: string | null; warranty_end_at: string | null; state: string; remaining_days: number | null } | null;
  messages: ClaimMessage[];
}

const STAGE_CLS: Record<string, { cls: string; icon: React.ElementType }> = {
  received: { cls: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30', icon: Clock },
  diagnosing: { cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', icon: Search },
  approved: { cls: 'bg-green-500/10 text-green-400 border-green-500/30', icon: CheckCircle },
  rejected: { cls: 'bg-red-500/10 text-red-400 border-red-500/30', icon: XCircle },
  repairing: { cls: 'bg-blue-500/10 text-blue-300 border-blue-500/30', icon: Wrench },
  replaced: { cls: 'bg-purple-500/10 text-purple-300 border-purple-500/30', icon: Repeat },
  resolved: { cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', icon: CheckCircle },
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export default function Warranty() {
  const navigate = useNavigate();
  const { lang, dir, loc } = useLanguage();
  const s = STRINGS[lang];

  // Devices
  const [devices, setDevices] = useState<MyDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState('');

  // Add-by-serial
  const [serialInput, setSerialInput] = useState('');
  const [serialBusy, setSerialBusy] = useState(false);
  const [serialError, setSerialError] = useState('');
  const [serialOk, setSerialOk] = useState('');

  // Claims
  const [claims, setClaims] = useState<MyClaim[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(true);
  const [claimsError, setClaimsError] = useState('');

  // New device claim modal
  const [claimForDevice, setClaimForDevice] = useState<MyDevice | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [attachments, setAttachments] = useState<Array<{ key: string; url: string; name: string }>>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState('');

  // Legacy free-form claim modal (kept from the previous page)
  const [showLegacyForm, setShowLegacyForm] = useState(false);
  const [legacyName, setLegacyName] = useState('');
  const [legacyDesc, setLegacyDesc] = useState('');
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyError, setLegacyError] = useState('');

  // Thread modal
  const [openClaimId, setOpenClaimId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api.get<{ devices: MyDevice[] }>('/api/devices/mine');
      setDevices(res.devices);
      setDevicesError('');
    } catch (e) {
      setDevicesError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setDevicesLoading(false);
    }
  }, [s.error]);

  const loadClaims = useCallback(async () => {
    try {
      const res = await api.get<{ claims: MyClaim[] }>('/api/devices/claims');
      setClaims(res.claims);
      setClaimsError('');
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimsLoading(false);
    }
  }, [s.error]);

  useEffect(() => {
    loadDevices();
    loadClaims();
  }, [loadDevices, loadClaims]);

  const registerSerial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (serialBusy || !serialInput.trim()) return;
    setSerialBusy(true);
    setSerialError('');
    setSerialOk('');
    try {
      const res = await api.post<{ device: MyDevice; already_registered: boolean }>('/api/devices/register', {
        serial: serialInput.trim(),
      });
      setSerialOk(res.already_registered ? s.alreadyRegistered : s.registeredOk);
      setSerialInput('');
      await loadDevices();
    } catch (e2) {
      setSerialError(e2 instanceof ApiError ? e2.message : s.error);
    } finally {
      setSerialBusy(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setClaimError('');
    setUploadBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (attachments.length >= 6) break;
        const form = new FormData();
        form.append('file', file);
        const res = await api.post<{ key: string; url: string }>('/api/devices/claims/upload', form);
        setAttachments((a) => (a.length >= 6 ? a : [...a, { key: res.key, url: res.url, name: file.name }]));
      }
    } catch (e) {
      setClaimError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUploadBusy(false);
    }
  };

  const submitDeviceClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!claimForDevice || claimBusy) return;
    setClaimBusy(true);
    setClaimError('');
    try {
      await api.post(`/api/devices/units/${claimForDevice.unit_id}/claims`, {
        subject,
        description,
        attachments: attachments.map((a) => a.key),
      });
      setClaimForDevice(null);
      setSubject('');
      setDescription('');
      setAttachments([]);
      await loadClaims();
    } catch (e2) {
      setClaimError(e2 instanceof ApiError ? e2.message : s.error);
    } finally {
      setClaimBusy(false);
    }
  };

  const submitLegacyClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (legacyBusy) return;
    setLegacyBusy(true);
    setLegacyError('');
    try {
      await api.post('/api/profile/warranty-claims', { productName: legacyName, description: legacyDesc });
      setShowLegacyForm(false);
      setLegacyName('');
      setLegacyDesc('');
      await loadClaims();
    } catch (e2) {
      setLegacyError(e2 instanceof ApiError ? e2.message : s.error);
    } finally {
      setLegacyBusy(false);
    }
  };

  const openThread = async (claimId: string) => {
    setOpenClaimId(claimId);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const res = await api.get<ClaimDetail>(`/api/devices/claims/${claimId}`);
      setDetail(res);
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setDetailLoading(false);
    }
  };

  const sendReply = async (fileKey?: string) => {
    if (!openClaimId || replyBusy) return;
    if (!replyText.trim() && !fileKey) return;
    setReplyBusy(true);
    setDetailError('');
    try {
      await api.post(`/api/devices/claims/${openClaimId}/messages`, {
        body: replyText.trim(),
        file_key: fileKey,
      });
      setReplyText('');
      const res = await api.get<ClaimDetail>(`/api/devices/claims/${openClaimId}`);
      setDetail(res);
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setReplyBusy(false);
    }
  };

  const attachToThread = async (files: FileList | null) => {
    if (!files || files.length === 0 || !openClaimId) return;
    setReplyBusy(true);
    setDetailError('');
    try {
      const form = new FormData();
      form.append('file', files[0]);
      const res = await api.post<{ key: string }>('/api/devices/claims/upload', form);
      await api.post(`/api/devices/claims/${openClaimId}/messages`, { body: replyText.trim(), file_key: res.key });
      setReplyText('');
      const refreshed = await api.get<ClaimDetail>(`/api/devices/claims/${openClaimId}`);
      setDetail(refreshed);
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setReplyBusy(false);
    }
  };

  const coverageBadge = (d: MyDevice) => {
    const st = d.warranty.state;
    if (st === 'active') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold bg-green-500/10 text-green-400 border-green-500/30">
          <ShieldCheck className="w-3 h-3" />
          {s.stActive}
          {d.warranty.remaining_days !== null && ` · ${s.daysLeft(d.warranty.remaining_days)}`}
        </span>
      );
    }
    if (st === 'expired') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold bg-red-500/10 text-red-400 border-red-500/30">
          <XCircle className="w-3 h-3" />{s.stExpired}
        </span>
      );
    }
    if (st === 'needs_config') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold bg-orange-500/10 text-orange-400 border-orange-500/30">
          <AlertTriangle className="w-3 h-3" />{s.stNeedsConfig}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold bg-zinc-500/10 text-zinc-400 border-zinc-500/30">
        <Clock className="w-3 h-3" />{s.stNotDelivered}
      </span>
    );
  };

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">{s.title}</h1>
      </div>

      <div className="p-4 space-y-6 max-w-2xl mx-auto">
        {/* ------------------------------------------------ add by serial */}
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Barcode className="w-5 h-5 text-olive-light" />
            <h2 className="text-white font-bold text-sm">{s.addDevice}</h2>
          </div>
          <form onSubmit={registerSerial} className="flex gap-2">
            <input
              value={serialInput}
              onChange={(e) => setSerialInput(e.target.value)}
              placeholder={s.serialPlaceholder}
              aria-label={s.serialLabel}
              maxLength={80}
              className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm font-mono outline-none focus:border-olive-light/50 transition-colors"
            />
            <button
              type="submit"
              disabled={serialBusy || !serialInput.trim()}
              className="shrink-0 bg-olive-light/20 text-olive-light px-4 py-2.5 rounded-xl font-bold text-sm border border-olive-light/30 hover:bg-olive-light/30 disabled:opacity-50 transition-colors"
            >
              {serialBusy ? s.registering : s.register}
            </button>
          </form>
          <p className="text-zinc-500 text-[11px] mt-2">{s.registerHint}</p>
          {serialError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3 mt-2">
              {serialError}
              <div className="text-red-400/70 text-[11px] mt-1">{s.supportHint}</div>
            </div>
          )}
          {serialOk && (
            <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-[13px] font-medium rounded-xl p-3 mt-2">
              {serialOk}
            </div>
          )}
        </div>

        {/* ------------------------------------------------- my devices */}
        <div>
          <h2 className="text-white font-bold text-base mb-3">{s.myDevices}</h2>
          {devicesError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3 mb-3">{devicesError}</div>
          )}
          {devicesLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-8 h-8 border-2 border-olive-light/30 border-t-olive-light rounded-full animate-spin" />
            </div>
          ) : devices.length === 0 && !devicesError ? (
            <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-6 text-center">
              <ShieldCheck className="w-10 h-10 text-olive-light mx-auto mb-3" />
              <p className="text-zinc-400 text-sm">{s.devicesEmpty}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {devices.map((d) => (
                <div key={d.unit_id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4">
                  <div className="flex gap-3">
                    <div className="w-16 h-16 rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden shrink-0">
                      {d.product.image ? (
                        <img src={d.product.image} alt="" className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-700">
                          <ShieldCheck className="w-6 h-6" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-white font-bold text-sm truncate">
                          {loc(d.product.name_ar || d.product.name, d.product.name, d.product.name_ckb)}
                        </h3>
                        {d.replaced_by_unit_id && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-300 shrink-0">
                            <Repeat className="w-3 h-3" />{s.replacedBadge}
                          </span>
                        )}
                      </div>
                      {d.serial && <div className="text-zinc-500 text-[12px] font-mono mt-0.5">{d.serial}</div>}
                      <div className="mt-1.5">{coverageBadge(d)}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3 text-[11px]">
                    <div className="bg-zinc-950/60 rounded-lg p-2">
                      <div className="text-zinc-500">{s.orderRef}</div>
                      <button onClick={() => navigate('/orders')} className="text-zinc-300 font-mono truncate block max-w-full hover:text-white transition-colors">
                        {d.order_id}
                      </button>
                    </div>
                    <div className="bg-zinc-950/60 rounded-lg p-2">
                      <div className="text-zinc-500">{s.deliveredAt}</div>
                      <div className="text-zinc-300">{fmtDate(d.delivered_at)}</div>
                    </div>
                    <div className="bg-zinc-950/60 rounded-lg p-2">
                      <div className="text-zinc-500">{s.warrantyEnd}</div>
                      <div className="text-zinc-300">{fmtDate(d.warranty.end_at)}</div>
                    </div>
                  </div>
                  {!d.replaced_by_unit_id && (
                    <button
                      onClick={() => { setClaimForDevice(d); setSubject(''); setDescription(''); setAttachments([]); setClaimError(''); }}
                      className="w-full mt-3 bg-zinc-800/80 hover:bg-zinc-800 text-zinc-200 py-2 rounded-xl text-[13px] font-bold border border-zinc-700/60 transition-colors inline-flex items-center justify-center gap-1.5"
                    >
                      <Wrench className="w-3.5 h-3.5" />{s.openClaim}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* --------------------------------------------------- my claims */}
        <div>
          <h2 className="text-white font-bold text-base mb-3">{s.claims}</h2>
          {claimsError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3 mb-3">{claimsError}</div>
          )}
          {claimsLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-8 h-8 border-2 border-olive-light/30 border-t-olive-light rounded-full animate-spin" />
            </div>
          ) : claims.length === 0 && !claimsError ? (
            <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-6 text-center">
              <p className="text-zinc-400 text-sm">{s.claimsEmpty}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {claims.map((cl) => {
                const st = STAGE_CLS[cl.stage] ?? STAGE_CLS.received;
                const StIcon = st.icon;
                return (
                  <button
                    key={cl.id}
                    onClick={() => openThread(cl.id)}
                    className="w-full text-start bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <h3 className="text-white font-bold text-sm truncate">{cl.subject}</h3>
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold shrink-0 ${st.cls}`}>
                        <StIcon className="w-3 h-3" />
                        {s.stageLabels[cl.stage] ?? cl.stage}
                      </span>
                    </div>
                    <p className="text-zinc-500 text-[12px] truncate">{cl.product_name}{cl.serial ? ` · ${cl.serial}` : ''}</p>
                    <p className="text-zinc-400 text-[13px] mt-1 line-clamp-2 whitespace-pre-wrap">{cl.description}</p>
                    {cl.decision_reason && (
                      <p className="text-zinc-500 text-[11px] mt-1">{s.decisionReason}: {cl.decision_reason}</p>
                    )}
                    <p className="text-zinc-600 text-[11px] mt-1.5 inline-flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />{s.submittedAt}: {fmtDate(cl.created_at)}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
          <button
            onClick={() => { setShowLegacyForm(true); setLegacyError(''); }}
            className="mt-3 text-[12px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
          >
            {s.legacyClaimLink}
          </button>
        </div>
      </div>

      {/* ------------------------------------------- new device claim modal */}
      {claimForDevice && (
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-[24px] p-6 w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button onClick={() => setClaimForDevice(null)} className="absolute top-4 end-4 p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors" aria-label={s.close}>
              <X className="w-4 h-4" />
            </button>
            <h2 className="text-white text-lg font-bold mb-1">{s.newClaimTitle}</h2>
            <p className="text-zinc-500 text-sm mb-4">
              {loc(claimForDevice.product.name_ar || claimForDevice.product.name, claimForDevice.product.name, claimForDevice.product.name_ckb)}
              {claimForDevice.serial ? ` · ${claimForDevice.serial}` : ''}
            </p>
            <form onSubmit={submitDeviceClaim} className="space-y-4">
              {claimError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3">{claimError}</div>
              )}
              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.subject}<span className="text-red-500">*</span></label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  minLength={3}
                  maxLength={200}
                  required
                  placeholder={s.subjectPh}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive-light/50 transition-colors"
                />
              </div>
              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.description}<span className="text-red-500">*</span></label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  minLength={10}
                  maxLength={5000}
                  required
                  rows={4}
                  placeholder={s.descriptionPh}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive-light/50 transition-colors resize-none"
                />
              </div>
              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.attachments}</label>
                <label className="inline-flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-zinc-300 text-sm cursor-pointer hover:border-zinc-700 transition-colors">
                  <Paperclip className="w-4 h-4" />
                  {uploadBusy ? s.uploading : s.attach}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4"
                    multiple
                    className="hidden"
                    disabled={uploadBusy || attachments.length >= 6}
                    onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
                  />
                </label>
                {attachments.length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {attachments.map((a) => (
                      <div key={a.key} className="relative w-16 h-16 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
                        {a.key.endsWith('.mp4') ? (
                          <div className="w-full h-full flex items-center justify-center text-[9px] text-zinc-400 px-1 text-center break-all">{a.name}</div>
                        ) : (
                          <img src={a.url} alt="" className="w-full h-full object-cover" />
                        )}
                        <button
                          type="button"
                          onClick={() => setAttachments((arr) => arr.filter((x) => x.key !== a.key))}
                          className="absolute top-0.5 end-0.5 bg-black/70 rounded-full p-0.5 text-zinc-300 hover:text-white"
                          aria-label={s.close}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={claimBusy || uploadBusy}
                className="w-full bg-olive hover:bg-olive-light text-white py-3 rounded-xl font-bold transition-colors disabled:opacity-50"
              >
                {claimBusy ? s.submitting : s.submit}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ---------------------------------------------- legacy claim modal */}
      {showLegacyForm && (
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-[24px] p-6 w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button onClick={() => setShowLegacyForm(false)} className="absolute top-4 end-4 p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors" aria-label={s.close}>
              <X className="w-4 h-4" />
            </button>
            <h2 className="text-white text-lg font-bold mb-4">{s.newClaimTitle}</h2>
            <form onSubmit={submitLegacyClaim} className="space-y-4">
              {legacyError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3">{legacyError}</div>
              )}
              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.productName}<span className="text-red-500">*</span></label>
                <input
                  value={legacyName}
                  onChange={(e) => setLegacyName(e.target.value)}
                  minLength={2}
                  maxLength={200}
                  required
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive-light/50 transition-colors"
                />
              </div>
              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{s.description}<span className="text-red-500">*</span></label>
                <textarea
                  value={legacyDesc}
                  onChange={(e) => setLegacyDesc(e.target.value)}
                  minLength={10}
                  maxLength={3000}
                  required
                  rows={4}
                  placeholder={s.descriptionPh}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive-light/50 transition-colors resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={legacyBusy}
                className="w-full bg-olive hover:bg-olive-light text-white py-3 rounded-xl font-bold transition-colors disabled:opacity-50"
              >
                {legacyBusy ? s.submitting : s.submit}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* -------------------------------------------------- thread modal */}
      {openClaimId && (
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-[24px] w-full max-w-md shadow-2xl relative max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-zinc-800/70 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-white text-base font-bold truncate">{detail?.claim.subject ?? s.thread}</h2>
                {detail?.warranty_facts && (
                  <p className="text-zinc-500 text-[11px] mt-1">
                    {s.orderRef}: <span className="font-mono">{detail.warranty_facts.order_id}</span>
                    {' · '}{s.deliveredAt}: {fmtDate(detail.warranty_facts.delivered_at)}
                    {' · '}{s.warrantyEnd}: {fmtDate(detail.warranty_facts.warranty_end_at)}
                  </p>
                )}
              </div>
              <button onClick={() => { setOpenClaimId(null); setDetail(null); }} className="p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors shrink-0" aria-label={s.close}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 space-y-3 min-h-[160px]">
              {detailLoading && (
                <div className="flex justify-center py-8">
                  <div className="w-7 h-7 border-2 border-olive-light/30 border-t-olive-light rounded-full animate-spin" />
                </div>
              )}
              {detailError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3">{detailError}</div>
              )}
              {detail && (
                <>
                  <div className="bg-zinc-900/70 rounded-xl px-3 py-2 text-sm text-zinc-300 whitespace-pre-wrap">{detail.claim.description}</div>
                  {detail.claim.evidence.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {detail.claim.evidence.map((ev) => (
                        <a key={ev.key} href={ev.url} target="_blank" rel="noreferrer" className="block w-16 h-16 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
                          {ev.key.endsWith('.mp4') ? (
                            <div className="w-full h-full flex items-center justify-center text-[9px] text-zinc-400">MP4</div>
                          ) : (
                            <img src={ev.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                  {detail.messages.map((m) => (
                    <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.mine ? 'bg-olive/25 text-zinc-100 ms-auto' : 'bg-zinc-800/70 text-zinc-200'}`}>
                      {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
                      {m.file_url && (
                        <a href={m.file_url} target="_blank" rel="noreferrer" className="block mt-1">
                          {m.file_url.endsWith('.mp4') ? (
                            <video src={m.file_url} controls preload="none" className="max-h-40 rounded-lg" />
                          ) : (
                            <img src={m.file_url} alt="" className="max-h-40 rounded-lg" loading="lazy" />
                          )}
                        </a>
                      )}
                      <div className="text-[10px] text-zinc-500 mt-1">{new Date(m.created_at).toLocaleString()}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="p-4 border-t border-zinc-800/70 flex items-center gap-2">
              <label className="p-2.5 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400 hover:text-white cursor-pointer transition-colors shrink-0" title={s.attach}>
                <Paperclip className="w-4 h-4" />
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4"
                  className="hidden"
                  disabled={replyBusy}
                  onChange={(e) => { attachToThread(e.target.files); e.target.value = ''; }}
                />
              </label>
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={s.reply}
                maxLength={3000}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive-light/50 transition-colors"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
              />
              <button
                onClick={() => sendReply()}
                disabled={replyBusy || !replyText.trim()}
                className="p-2.5 bg-olive-light/20 text-olive-light border border-olive-light/30 rounded-xl hover:bg-olive-light/30 disabled:opacity-40 transition-colors shrink-0"
                aria-label={s.send}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
