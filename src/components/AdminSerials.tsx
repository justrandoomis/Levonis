import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import {
  Barcode, RefreshCw, Search, ShieldCheck, AlertTriangle, Repeat, CalendarClock,
  MessageSquare, Send, ChevronDown, ChevronUp, PackageCheck,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';

/**
 * Admin — serialized devices: order-units view with serial entry, per-unit
 * delivery correction, replacement, and the warranty-claims workflow. Every
 * mutation asks for a reason where the API requires one and the server
 * writes the audit trail; nothing here shows success before the server
 * confirms.
 */

const STRINGS = {
  ar: {
    title: 'الأجهزة والأرقام التسلسلية',
    tabUnits: 'وحدات الطلبات',
    tabClaims: 'مطالبات الضمان',
    orderPlaceholder: 'رقم الطلب (ORD-…)',
    emailPlaceholder: 'بريد الزبون',
    load: 'عرض',
    loading: 'جارٍ التحميل…',
    noUnits: 'لا توجد وحدات مسجّلة لهذا البحث.',
    notSerialized: 'لا يحتوي هذا الطلب على منتجات مُرقّمة (ops_policy.serialized).',
    backfill: 'إنشاء الوحدات (إعادة المحاولة آمنة)',
    backfillDone: (n: number) => `تم إنشاء ${n} وحدة.`,
    orderNotDelivered: 'تُنشأ الوحدات من حدث التسليم — هذا الطلب غير مُسلَّم بعد.',
    unit: 'وحدة',
    serial: 'الرقم التسلسلي',
    assign: 'تعيين',
    serialPlaceholder: 'أدخل الرقم كما هو على الملصق',
    reassignConfirm: 'هذا الرقم/الوحدة معيّن مسبقًا. إعادة التعيين إجراء مُدقَّق يتطلب سببًا. المتابعة؟',
    reasonPrompt: 'السبب (سيُسجَّل في سجل التدقيق):',
    reasonRequired: 'السبب مطلوب (5 أحرف على الأقل).',
    delivered: 'تاريخ التسليم',
    correctDelivery: 'تصحيح',
    deliveryPrompt: 'تاريخ/وقت التسليم الصحيح لهذه الوحدة (ISO مثل 2026-08-20T14:00:00Z):',
    warrantyEnd: 'نهاية الضمان',
    replace: 'استبدال',
    replaceSerialPrompt: 'الرقم التسلسلي للجهاز البديل (اتركه فارغًا للتعيين لاحقًا):',
    replaceNote: 'الاستبدال يحمل تاريخ نهاية الضمان الأصلي (قاعدة "المتبقي مقابل الجديد" بانتظار قرار المالك).',
    registered: 'مُفعَّل',
    notRegistered: 'غير مُفعَّل',
    stActive: 'ساري',
    stExpired: 'منتهي',
    stNeedsConfig: 'بحاجة إعداد',
    stNotDelivered: 'غير مُسلَّم',
    daysLeft: (n: number) => `${n} يوم متبقٍ`,
    claimsEmpty: 'لا توجد مطالبات.',
    stage: 'المرحلة',
    moveTo: 'نقل إلى…',
    decisionReason: 'سبب القرار (سيُبلَّغ للزبون ويُسجَّل):',
    reply: 'رد للزبون…',
    send: 'إرسال',
    replaced: 'مُستبدَل',
    viewThread: 'عرض المحادثة',
    hideThread: 'إخفاء المحادثة',
    all: 'الكل',
    refreshed: 'تحديث',
    error: 'حدث خطأ',
    customer: 'الزبون',
    subject: 'الموضوع',
  },
  en: {
    title: 'Serials & Devices',
    tabUnits: 'Order units',
    tabClaims: 'Warranty claims',
    orderPlaceholder: 'Order ID (ORD-…)',
    emailPlaceholder: 'Customer email',
    load: 'Load',
    loading: 'Loading…',
    noUnits: 'No units recorded for this search.',
    notSerialized: 'This order has no serialized products (ops_policy.serialized).',
    backfill: 'Create units (safe to retry)',
    backfillDone: (n: number) => `${n} unit(s) created.`,
    orderNotDelivered: 'Units are created from the delivery event — this order is not delivered yet.',
    unit: 'Unit',
    serial: 'Serial',
    assign: 'Assign',
    serialPlaceholder: 'Enter exactly as printed on the label',
    reassignConfirm: 'This serial/unit is already assigned. Reassignment is an audited action that requires a reason. Continue?',
    reasonPrompt: 'Reason (recorded in the audit trail):',
    reasonRequired: 'A reason is required (min 5 characters).',
    delivered: 'Delivered',
    correctDelivery: 'Correct',
    deliveryPrompt: 'Correct delivery timestamp for THIS unit (ISO, e.g. 2026-08-20T14:00:00Z):',
    warrantyEnd: 'Warranty end',
    replace: 'Replace',
    replaceSerialPrompt: 'Serial of the replacement device (leave empty to assign later):',
    replaceNote: 'The replacement carries the ORIGINAL warranty end date (remaining-vs-new rule pending owner decision).',
    registered: 'Registered',
    notRegistered: 'Not registered',
    stActive: 'Active',
    stExpired: 'Expired',
    stNeedsConfig: 'Needs config',
    stNotDelivered: 'Not delivered',
    daysLeft: (n: number) => `${n} days left`,
    claimsEmpty: 'No claims.',
    stage: 'Stage',
    moveTo: 'Move to…',
    decisionReason: 'Decision reason (shown to the customer, audited):',
    reply: 'Reply to the customer…',
    send: 'Send',
    replaced: 'Replaced',
    viewThread: 'View thread',
    hideThread: 'Hide thread',
    all: 'All',
    refreshed: 'Refresh',
    error: 'Something went wrong',
    customer: 'Customer',
    subject: 'Subject',
  },
  ckb: {
    title: 'ئامێرەکان و ژمارە زنجیرەییەکان',
    tabUnits: 'یەکەکانی داواکاری',
    tabClaims: 'داواکاریيەکانی گەرەنتی',
    orderPlaceholder: 'ژمارەی داواکاری (ORD-…)',
    emailPlaceholder: 'ئیمەیلی کڕیار',
    load: 'پیشاندان',
    loading: 'باردەکرێت…',
    noUnits: 'هیچ یەکەیەک بۆ ئەم گەڕانە تۆمار نەکراوە.',
    notSerialized: 'ئەم داواکارییە بەرهەمی ژمارە زنجیرەیی تێدا نییە (ops_policy.serialized).',
    backfill: 'دروستکردنی یەکەکان (دووبارەکردنەوە سەلامەتە)',
    backfillDone: (n: number) => `${n} یەکە دروستکرا.`,
    orderNotDelivered: 'یەکەکان لە ڕووداوی گەیاندنەوە دروستدەکرێن — ئەم داواکارییە هێشتا نەگەیەنراوە.',
    unit: 'یەکە',
    serial: 'ژمارە زنجیرەیی',
    assign: 'دیاریکردن',
    serialPlaceholder: 'وەک لەسەر لەیبڵەکە نووسراوە بینووسە',
    reassignConfirm: 'ئەم ژمارە/یەکەیە پێشتر دیاریکراوە. گۆڕینەوە کردارێکی وردبینیکراوە و هۆکاری دەوێت. بەردەوامبوون؟',
    reasonPrompt: 'هۆکار (لە تۆماری وردبینیدا تۆماردەکرێت):',
    reasonRequired: 'هۆکار پێویستە (لانیکەم ٥ پیت).',
    delivered: 'گەیاندن',
    correctDelivery: 'ڕاستکردنەوە',
    deliveryPrompt: 'کاتی گەیاندنی ڕاست بۆ ئەم یەکەیە (ISO وەک 2026-08-20T14:00:00Z):',
    warrantyEnd: 'کۆتایی گەرەنتی',
    replace: 'گۆڕینەوە',
    replaceSerialPrompt: 'ژمارە زنجیرەیی ئامێرە نوێیەکە (بەتاڵی بهێڵەوە بۆ دواتر):',
    replaceNote: 'گۆڕینەوەکە هەمان بەرواری کۆتایی گەرەنتی ڕەسەن هەڵدەگرێت (یاسای "ماوە بەرامبەر نوێ" چاوەڕوانی بڕیاری خاوەنە).',
    registered: 'چالاککراوە',
    notRegistered: 'چالاک نەکراوە',
    stActive: 'کارا',
    stExpired: 'بەسەرچووە',
    stNeedsConfig: 'پێویستی بە ڕێکخستنە',
    stNotDelivered: 'نەگەیەنراوە',
    daysLeft: (n: number) => `${n} ڕۆژ ماوە`,
    claimsEmpty: 'هیچ داواکارییەک نییە.',
    stage: 'قۆناغ',
    moveTo: 'گواستنەوە بۆ…',
    decisionReason: 'هۆکاری بڕیار (بۆ کڕیار پیشاندەدرێت و تۆماردەکرێت):',
    reply: 'وەڵامدانەوەی کڕیار…',
    send: 'ناردن',
    replaced: 'گۆڕدراوەتەوە',
    viewThread: 'بینینی گفتوگۆ',
    hideThread: 'شاردنەوەی گفتوگۆ',
    all: 'هەموو',
    refreshed: 'نوێکردنەوە',
    error: 'هەڵەیەک ڕوویدا',
    customer: 'کڕیار',
    subject: 'بابەت',
  },
} as const;

type Lang = keyof typeof STRINGS;

interface AdminDevice {
  unit_id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  product: { id: string | null; name: string; name_ar: string; image: string };
  serial: string | null;
  delivered_at: string | null;
  warranty: {
    start_at: string | null;
    end_at: string | null;
    base_months: number | null;
    ext_months: number;
    state: 'active' | 'expired' | 'needs_config' | 'not_delivered';
    remaining_days: number | null;
  };
  replaced_by_unit_id: string | null;
  replacement_of_unit_id: string | null;
  registration: { registered_at: string; revoked_at: string | null } | null;
}

interface AdminOrderUnits {
  order: { id: string; user_id: string; email: string | null; status: string; delivered_at: string | null };
  items: Array<{ id: string; name: string; qty: number; serialized: boolean; base_months: number | null }>;
  units: AdminDevice[];
}

interface AdminClaim {
  id: string;
  unit_id: string | null;
  subject: string;
  product_name: string;
  description: string;
  stage: string;
  decision: string | null;
  decision_reason: string;
  created_at: string;
  serial: string | null;
  email: string | null;
  evidence: Array<{ key: string; url: string }>;
}

interface ClaimMessage {
  id: string;
  is_staff: boolean;
  body: string;
  file_url: string | null;
  created_at: string;
}

const CLAIM_STAGES = ['received', 'diagnosing', 'approved', 'rejected', 'repairing', 'replaced', 'resolved'] as const;
const CLAIM_NEXT: Record<string, string[]> = {
  received: ['diagnosing', 'approved', 'rejected'],
  diagnosing: ['approved', 'rejected'],
  approved: ['repairing', 'replaced', 'resolved', 'rejected'],
  repairing: ['resolved', 'replaced'],
  replaced: ['resolved'],
  rejected: ['diagnosing'],
  resolved: [],
};

const STAGE_CLS: Record<string, string> = {
  received: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
  diagnosing: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  approved: 'bg-green-500/10 text-green-400 border-green-500/30',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/30',
  repairing: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  replaced: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  resolved: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function CoverageBadge({ device, s }: { device: AdminDevice; s: (typeof STRINGS)[Lang] }) {
  const st = device.warranty.state;
  const cls =
    st === 'active'
      ? 'bg-green-500/10 text-green-400 border-green-500/30'
      : st === 'expired'
        ? 'bg-red-500/10 text-red-400 border-red-500/30'
        : st === 'needs_config'
          ? 'bg-orange-500/10 text-orange-400 border-orange-500/30'
          : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30';
  const label =
    st === 'active'
      ? `${s.stActive}${device.warranty.remaining_days !== null ? ` · ${s.daysLeft(device.warranty.remaining_days)}` : ''}`
      : st === 'expired'
        ? s.stExpired
        : st === 'needs_config'
          ? s.stNeedsConfig
          : s.stNotDelivered;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-bold whitespace-nowrap ${cls}`}>{label}</span>;
}

export default function AdminSerials() {
  const { lang } = useLanguage();
  const s = STRINGS[lang];

  const [tab, setTab] = useState<'units' | 'claims'>('units');

  // ------------------------------------------------------------- units tab
  const [orderQuery, setOrderQuery] = useState('');
  const [emailQuery, setEmailQuery] = useState('');
  const [orderData, setOrderData] = useState<AdminOrderUnits | null>(null);
  const [customerUnits, setCustomerUnits] = useState<AdminDevice[] | null>(null);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [unitsError, setUnitsError] = useState('');
  const [unitsNotice, setUnitsNotice] = useState('');
  const [serialDrafts, setSerialDrafts] = useState<Record<string, string>>({});
  const [busyUnit, setBusyUnit] = useState<string | null>(null);

  const loadOrder = useCallback(async (orderId: string) => {
    if (!orderId.trim()) return;
    setUnitsLoading(true);
    setUnitsError('');
    setUnitsNotice('');
    setCustomerUnits(null);
    try {
      const data = await api.get<AdminOrderUnits>(`/api/devices/admin/orders/${encodeURIComponent(orderId.trim())}/units`);
      setOrderData(data);
    } catch (e) {
      setOrderData(null);
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUnitsLoading(false);
    }
  }, [s.error]);

  const loadCustomer = useCallback(async (email: string) => {
    if (!email.trim()) return;
    setUnitsLoading(true);
    setUnitsError('');
    setUnitsNotice('');
    setOrderData(null);
    try {
      const data = await api.get<{ units: AdminDevice[] }>(`/api/devices/admin/units?email=${encodeURIComponent(email.trim())}`);
      setCustomerUnits(data.units);
    } catch (e) {
      setCustomerUnits(null);
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUnitsLoading(false);
    }
  }, [s.error]);

  const refreshCurrent = useCallback(() => {
    if (orderData) loadOrder(orderData.order.id);
    else if (customerUnits && emailQuery) loadCustomer(emailQuery);
  }, [orderData, customerUnits, emailQuery, loadOrder, loadCustomer]);

  const backfill = async () => {
    if (!orderData) return;
    setUnitsError('');
    setUnitsNotice('');
    try {
      const res = await api.post<{ created: number }>(`/api/devices/admin/orders/${orderData.order.id}/units/backfill`);
      setUnitsNotice(s.backfillDone(res.created));
      await loadOrder(orderData.order.id);
    } catch (e) {
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    }
  };

  const assignSerial = async (device: AdminDevice) => {
    const serial = (serialDrafts[device.unit_id] ?? '').trim();
    if (!serial) return;
    setBusyUnit(device.unit_id);
    setUnitsError('');
    try {
      await api.post(`/api/devices/admin/units/${device.unit_id}/serial`, { serial });
      setSerialDrafts((d) => ({ ...d, [device.unit_id]: '' }));
      refreshCurrent();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REASSIGN_REQUIRED') {
        if (window.confirm(`${e.message}\n\n${s.reassignConfirm}`)) {
          const reason = window.prompt(s.reasonPrompt) || '';
          if (reason.trim().length < 5) {
            setUnitsError(s.reasonRequired);
          } else {
            try {
              await api.post(`/api/devices/admin/units/${device.unit_id}/serial`, { serial, reassign: true, reason: reason.trim() });
              setSerialDrafts((d) => ({ ...d, [device.unit_id]: '' }));
              refreshCurrent();
            } catch (e2) {
              setUnitsError(e2 instanceof ApiError ? e2.message : s.error);
            }
          }
        }
      } else {
        setUnitsError(e instanceof ApiError ? e.message : s.error);
      }
    } finally {
      setBusyUnit(null);
    }
  };

  const correctDelivery = async (device: AdminDevice) => {
    const ts = window.prompt(s.deliveryPrompt, device.delivered_at ?? '');
    if (!ts) return;
    const reason = window.prompt(s.reasonPrompt) || '';
    if (reason.trim().length < 5) {
      setUnitsError(s.reasonRequired);
      return;
    }
    setBusyUnit(device.unit_id);
    setUnitsError('');
    try {
      await api.patch(`/api/devices/admin/units/${device.unit_id}/delivery`, { delivered_at: ts.trim(), reason: reason.trim() });
      refreshCurrent();
    } catch (e) {
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setBusyUnit(null);
    }
  };

  const replaceUnit = async (device: AdminDevice) => {
    if (!window.confirm(`${s.replaceNote}\n\n${s.reassignConfirm}`)) return;
    const newSerial = window.prompt(s.replaceSerialPrompt) ?? '';
    const reason = window.prompt(s.reasonPrompt) || '';
    if (reason.trim().length < 5) {
      setUnitsError(s.reasonRequired);
      return;
    }
    setBusyUnit(device.unit_id);
    setUnitsError('');
    try {
      const res = await api.post<{ note: string }>(`/api/devices/admin/units/${device.unit_id}/replace`, {
        new_serial: newSerial.trim() || undefined,
        reason: reason.trim(),
      });
      setUnitsNotice(res.note);
      refreshCurrent();
    } catch (e) {
      setUnitsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setBusyUnit(null);
    }
  };

  // ------------------------------------------------------------ claims tab
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const [thread, setThread] = useState<ClaimMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

  const loadClaims = useCallback(async () => {
    setClaimsLoading(true);
    setClaimsError('');
    try {
      const qs = stageFilter === 'all' ? '' : `?stage=${stageFilter}`;
      const data = await api.get<{ claims: AdminClaim[] }>(`/api/devices/admin/claims${qs}`);
      setClaims(data.claims);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimsLoading(false);
    }
  }, [stageFilter, s.error]);

  useEffect(() => {
    if (tab === 'claims') loadClaims();
  }, [tab, loadClaims]);

  const openThread = async (claimId: string) => {
    if (openClaim === claimId) {
      setOpenClaim(null);
      return;
    }
    setOpenClaim(claimId);
    setThread([]);
    setThreadLoading(true);
    try {
      const data = await api.get<{ messages: ClaimMessage[] }>(`/api/devices/claims/${claimId}`);
      setThread(data.messages);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setThreadLoading(false);
    }
  };

  const moveClaim = async (claim: AdminClaim, next: string) => {
    const needsReason = ['approved', 'rejected', 'replaced', 'resolved'].includes(next);
    let reason = '';
    if (needsReason) {
      reason = window.prompt(s.decisionReason) || '';
      if (reason.trim().length < 5) {
        setClaimsError(s.reasonRequired);
        return;
      }
    }
    setClaimBusy(true);
    setClaimsError('');
    try {
      await api.patch(`/api/devices/admin/claims/${claim.id}`, { stage: next, reason: reason.trim() || undefined });
      await loadClaims();
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimBusy(false);
    }
  };

  const sendReply = async (claimId: string) => {
    if (!replyText.trim()) return;
    setClaimBusy(true);
    setClaimsError('');
    try {
      await api.post(`/api/devices/claims/${claimId}/messages`, { body: replyText.trim() });
      setReplyText('');
      const data = await api.get<{ messages: ClaimMessage[] }>(`/api/devices/claims/${claimId}`);
      setThread(data.messages);
    } catch (e) {
      setClaimsError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setClaimBusy(false);
    }
  };

  const renderUnitsTable = (units: AdminDevice[]) => (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[980px]">
          <thead>
            <tr className="bg-zinc-800/50 border-b border-zinc-700">
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.unit}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.serial}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.delivered}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.warrantyEnd}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase">{s.stage}</th>
              <th className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase" />
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.unit_id} className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors align-top">
                <td className="py-3 px-4">
                  <div className="text-sm text-white font-bold">{u.product.name_ar || u.product.name || '—'}</div>
                  <div className="text-[11px] text-zinc-500 font-mono">#{u.unit_index} · {u.unit_id}</div>
                  <div className="text-[11px] text-zinc-500 font-mono">{u.order_id}</div>
                  {u.replaced_by_unit_id && (
                    <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-purple-300"><Repeat className="w-3 h-3" />{s.replaced}</span>
                  )}
                  <div className="text-[11px] mt-1">
                    {u.registration && !u.registration.revoked_at ? (
                      <span className="text-green-400 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" />{s.registered}</span>
                    ) : (
                      <span className="text-zinc-500">{s.notRegistered}</span>
                    )}
                  </div>
                </td>
                <td className="py-3 px-4">
                  {u.serial ? (
                    <div className="font-mono text-sm text-white break-all">{u.serial}</div>
                  ) : null}
                  {!u.replaced_by_unit_id && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <input
                        value={serialDrafts[u.unit_id] ?? ''}
                        onChange={(e) => setSerialDrafts((d) => ({ ...d, [u.unit_id]: e.target.value }))}
                        placeholder={u.serial ? '' : s.serialPlaceholder}
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white font-mono w-44 outline-none focus:border-olive/60"
                      />
                      <button
                        onClick={() => assignSerial(u)}
                        disabled={busyUnit === u.unit_id || !(serialDrafts[u.unit_id] ?? '').trim()}
                        className="text-xs font-bold bg-olive/20 text-olive border border-olive/30 rounded-lg px-2.5 py-1.5 hover:bg-olive/30 disabled:opacity-40 transition-colors"
                      >
                        {s.assign}
                      </button>
                    </div>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="text-sm text-zinc-300 whitespace-nowrap">{fmtDate(u.delivered_at)}</div>
                  {!u.replaced_by_unit_id && (
                    <button
                      onClick={() => correctDelivery(u)}
                      disabled={busyUnit === u.unit_id}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] text-zinc-400 hover:text-white transition-colors disabled:opacity-40"
                    >
                      <CalendarClock className="w-3 h-3" />{s.correctDelivery}
                    </button>
                  )}
                </td>
                <td className="py-3 px-4">
                  <div className="text-sm text-zinc-300 whitespace-nowrap">{fmtDate(u.warranty.end_at)}</div>
                  <div className="text-[11px] text-zinc-500">
                    {u.warranty.base_months !== null ? `${u.warranty.base_months}m` : '—'}
                    {u.warranty.ext_months > 0 ? ` +${u.warranty.ext_months}m` : ''}
                  </div>
                </td>
                <td className="py-3 px-4"><CoverageBadge device={u} s={s} /></td>
                <td className="py-3 px-4">
                  {!u.replaced_by_unit_id && (
                    <button
                      onClick={() => replaceUnit(u)}
                      disabled={busyUnit === u.unit_id}
                      className="inline-flex items-center gap-1 text-xs font-bold bg-purple-500/10 text-purple-300 border border-purple-500/30 rounded-lg px-2.5 py-1.5 hover:bg-purple-500/20 disabled:opacity-40 transition-colors"
                    >
                      <Repeat className="w-3 h-3" />{s.replace}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {units.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-zinc-500 font-medium">{s.noUnits}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h2 className="text-2xl font-black text-white flex items-center gap-2"><Barcode className="w-6 h-6 text-olive" />{s.title}</h2>
        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {(['units', 'claims'] as const).map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tab === tb ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {tb === 'units' ? s.tabUnits : s.tabClaims}
            </button>
          ))}
        </div>
      </div>

      {tab === 'units' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadOrder(orderQuery); }}>
              <input
                value={orderQuery}
                onChange={(e) => setOrderQuery(e.target.value)}
                placeholder={s.orderPlaceholder}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm font-mono outline-none focus:border-olive/50"
              />
              <button type="submit" className="inline-flex items-center gap-1.5 bg-olive/20 text-olive border border-olive/30 rounded-xl px-4 text-sm font-bold hover:bg-olive/30 transition-colors">
                <Search className="w-4 h-4" />{s.load}
              </button>
            </form>
            <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); loadCustomer(emailQuery); }}>
              <input
                value={emailQuery}
                onChange={(e) => setEmailQuery(e.target.value)}
                placeholder={s.emailPlaceholder}
                type="email"
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50"
              />
              <button type="submit" className="inline-flex items-center gap-1.5 bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-xl px-4 text-sm font-bold hover:bg-zinc-700 transition-colors">
                <Search className="w-4 h-4" />{s.load}
              </button>
            </form>
          </div>

          {unitsError && <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm font-medium">{unitsError}</div>}
          {unitsNotice && <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-2xl p-3 text-sm font-medium">{unitsNotice}</div>}
          {unitsLoading && <div className="text-zinc-500 text-sm font-medium py-6 text-center">{s.loading}</div>}

          {orderData && !unitsLoading && (
            <div className="space-y-3">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="font-mono text-white font-bold">{orderData.order.id}</span>
                <span className="text-zinc-400">{s.customer}: <span className="text-zinc-200">{orderData.order.email || orderData.order.user_id}</span></span>
                <span className="text-zinc-400 capitalize">{orderData.order.status}</span>
                <span className="text-zinc-400">{s.delivered}: {fmtDate(orderData.order.delivered_at)}</span>
              </div>
              {orderData.items.some((it) => it.serialized) ? (
                <>
                  {orderData.order.delivered_at ? (
                    orderData.units.length <
                      orderData.items.filter((it) => it.serialized).reduce((n, it) => n + Number(it.qty), 0) && (
                      <button
                        onClick={backfill}
                        className="inline-flex items-center gap-2 bg-olive/20 text-olive border border-olive/30 rounded-xl px-4 py-2.5 text-sm font-bold hover:bg-olive/30 transition-colors"
                      >
                        <PackageCheck className="w-4 h-4" />{s.backfill}
                      </button>
                    )
                  ) : (
                    <div className="flex items-center gap-2 text-orange-400 text-sm font-medium">
                      <AlertTriangle className="w-4 h-4 shrink-0" />{s.orderNotDelivered}
                    </div>
                  )}
                  {renderUnitsTable(orderData.units)}
                </>
              ) : (
                <div className="text-zinc-500 text-sm font-medium py-4">{s.notSerialized}</div>
              )}
            </div>
          )}

          {customerUnits && !unitsLoading && renderUnitsTable(customerUnits)}
        </div>
      )}

      {tab === 'claims' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl overflow-x-auto">
              {(['all', ...CLAIM_STAGES] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setStageFilter(st)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize whitespace-nowrap transition-colors ${stageFilter === st ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {st === 'all' ? s.all : st}
                </button>
              ))}
            </div>
            <button
              onClick={loadClaims}
              className="p-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 hover:text-white transition-colors"
              title={s.refreshed}
            >
              <RefreshCw className={`w-4 h-4 ${claimsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {claimsError && <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm font-medium">{claimsError}</div>}
          {claimsLoading && claims.length === 0 && <div className="text-zinc-500 text-sm font-medium py-6 text-center">{s.loading}</div>}
          {!claimsLoading && claims.length === 0 && !claimsError && (
            <div className="text-zinc-500 text-sm font-medium py-6 text-center">{s.claimsEmpty}</div>
          )}

          <div className="space-y-3">
            {claims.map((cl) => (
              <div key={cl.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-white font-bold text-sm">{cl.subject}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      {cl.product_name} · {cl.email || '—'} · {cl.serial ? <span className="font-mono">{cl.serial}</span> : '—'} · {fmtDate(cl.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex px-2.5 py-1 rounded-full border text-[11px] font-bold capitalize ${STAGE_CLS[cl.stage] ?? STAGE_CLS.received}`}>{cl.stage}</span>
                    {(CLAIM_NEXT[cl.stage] ?? []).length > 0 && (
                      <select
                        value=""
                        disabled={claimBusy}
                        onChange={(e) => { if (e.target.value) moveClaim(cl, e.target.value); }}
                        className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none disabled:opacity-50"
                      >
                        <option value="" disabled>{s.moveTo}</option>
                        {(CLAIM_NEXT[cl.stage] ?? []).map((st) => (
                          <option key={st} value={st} className="capitalize">{st}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                <p className="text-zinc-400 text-sm mt-2 whitespace-pre-wrap">{cl.description}</p>
                {cl.decision_reason && (
                  <p className="text-[12px] text-zinc-500 mt-1">{s.decisionReason} {cl.decision_reason}</p>
                )}
                {cl.evidence.length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {cl.evidence.map((ev) => (
                      <a key={ev.key} href={ev.url} target="_blank" rel="noreferrer" className="block w-16 h-16 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
                        <img src={ev.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => openThread(cl.id)}
                  className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold text-zinc-400 hover:text-white transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  {openClaim === cl.id ? s.hideThread : s.viewThread}
                  {openClaim === cl.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {openClaim === cl.id && (
                  <div className="mt-3 border-t border-zinc-800 pt-3 space-y-2">
                    {threadLoading && <div className="text-zinc-500 text-xs">{s.loading}</div>}
                    {thread.map((m) => (
                      <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.is_staff ? 'bg-olive/15 border border-olive/25 text-zinc-100 ms-auto' : 'bg-zinc-800/70 text-zinc-200'}`}>
                        {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
                        {m.file_url && (
                          <a href={m.file_url} target="_blank" rel="noreferrer" className="block mt-1">
                            <img src={m.file_url} alt="" className="max-h-40 rounded-lg" loading="lazy" />
                          </a>
                        )}
                        <div className="text-[10px] text-zinc-500 mt-1">{new Date(m.created_at).toLocaleString()}</div>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <input
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={s.reply}
                        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-olive/50"
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(cl.id); } }}
                      />
                      <button
                        onClick={() => sendReply(cl.id)}
                        disabled={claimBusy || !replyText.trim()}
                        className="inline-flex items-center gap-1.5 bg-olive/20 text-olive border border-olive/30 rounded-xl px-3 text-sm font-bold hover:bg-olive/30 disabled:opacity-40 transition-colors"
                      >
                        <Send className="w-4 h-4" />{s.send}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
