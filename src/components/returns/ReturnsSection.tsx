import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, AlertCircle, Camera, X, ChevronDown, CheckCircle2, Clock } from 'lucide-react';
import { api, ApiOrder, formatIqd, uploadFile } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { asLang, daysLeftLabel, formatDate } from '../orders/format';
import { apiRefusal } from '../../lib/refusalStrings';

/**
 * Returns section for ONE order (final-phase §6.2) — wired into the Orders
 * page for delivered orders.
 *  - Request flow per delivered order item: quantity, reason (fixed enum),
 *    description and PRIVATE photo evidence (owner-scoped receipts/ keys).
 *  - Case list with the full state timeline (requested → assessment →
 *    approved/rejected → collection → received → inspected → resolved),
 *    decision reasons and resolution.
 *  - Honest states everywhere: loading, error, empty, closed 7-day window
 *    (the SERVER judges timeliness by the request time — this UI only
 *    mirrors it). No success UI before the server confirms.
 */

const STATES = ['requested', 'assessment', 'approved', 'collection', 'received', 'inspected', 'resolved'] as const;

const REASONS = ['defective', 'manufacturing_fault', 'not_as_described', 'wrong_product', 'shipping_damage'] as const;
type Reason = (typeof REASONS)[number];
/**
 * The reasons a SINGLE PART of a bundle may be claimed on (owner decision 3).
 * A change of mind about one part is refused by the server — a bundle is
 * returned whole — but a fault is not a change of mind, so the picker offers
 * exactly what the server will accept rather than letting the customer choose
 * a reason and then be told no.
 */
const COMPONENT_REASONS: readonly Reason[] = ['defective', 'manufacturing_fault', 'shipping_damage'];

interface ReturnCaseDto {
  id: string;
  order_id: string;
  order_item_id: string;
  qty: number;
  reason: string;
  description: string;
  state: string;
  resolution: string | null;
  admin_note: string;
  requested_at: string;
  delivered_at: string | null;
  within_window: boolean;
  decided_at: string | null;
  item?: { name: string; image: string; variant: string };
}

type OrderLike = ApiOrder & { delivered_at?: string | null };

/** Per-unit delivery, when the order's devices were loaded (GET /:id/units). */
export interface ReturnsUnitLike {
  order_item_id: string;
  delivered_at: string | null;
}

const STRINGS = {
  ar: {
    title: 'الإرجاع والاستبدال',
    intro: 'يمكن طلب الإرجاع خلال 7 أيام من الاستلام الفعلي للمنتج المتأثر.',
    windowClosed: 'انتهت نافذة الإرجاع (7 أيام من الاستلام) لهذا الطلب.',
    windowUnknown: 'لم نتمكن من تحديد تاريخ الاستلام الفعلي لهذا الطلب، لذا لا نستطيع حساب الأيام المتبقية هنا. يمكنك إرسال الطلب وسيحكم النظام على المدة عند الاستلام.',
    itemClosed: 'انتهت نافذة الإرجاع لهذا المنتج.',
    daysLeft: (n: number) => `${daysLeftLabel(n, 'ar')} لطلب الإرجاع`,
    request: 'طلب إرجاع',
    faultyPartHint: 'قطعة معطوبة من الحزمة؟ طالِب بها وحدها:',
    reportFault: 'إبلاغ عن عطل',
    loading: 'جارٍ التحميل…',
    loadError: 'تعذّر تحميل حالات الإرجاع.',
    retry: 'إعادة المحاولة',
    noCases: 'لا توجد طلبات إرجاع لهذا الطلب.',
    qty: 'الكمية',
    reasonLabel: 'سبب الإرجاع',
    reasons: {
      defective: 'منتج معيب',
      manufacturing_fault: 'عيب مصنعي',
      not_as_described: 'مخالف للوصف',
      wrong_product: 'منتج خاطئ',
      shipping_damage: 'ضرر أثناء الشحن',
    } as Record<string, string>,
    descLabel: 'وصف المشكلة',
    descPlaceholder: 'اشرح المشكلة بدقة…',
    evidence: 'صور توضيحية (خاصة — تُعرض للإدارة فقط)',
    addPhoto: 'إضافة صورة',
    uploading: 'جارٍ الرفع…',
    submit: 'إرسال طلب الإرجاع',
    submitting: 'جارٍ الإرسال…',
    cancel: 'إلغاء',
    removePhoto: 'إزالة الصورة',
    caseTitle: 'حالة إرجاع',
    states: {
      requested: 'مُقدَّم',
      assessment: 'قيد التقييم',
      approved: 'مقبول',
      rejected: 'مرفوض',
      collection: 'قيد الاستلام',
      received: 'استُلم',
      inspected: 'تم الفحص',
      resolved: 'منتهٍ',
    } as Record<string, string>,
    resolutions: {
      replacement: 'استبدال',
      refund: 'استرجاع المبلغ إلى المحفظة',
      repair: 'إصلاح',
      declined: 'رفض بعد الفحص',
    } as Record<string, string>,
    adminNote: 'ملاحظة الإدارة',
    requestedAt: 'تاريخ الطلب',
    timely: 'قُدِّم ضمن المدة — تأخر المراجعة الإدارية لا يُبطل الطلب.',
    refundNote: 'المبالغ تُعاد إلى المحفظة عند اكتمال الفحص والموافقة (وجهة الاسترجاع النهائية قرار إداري قابل للتهيئة).',
  },
  en: {
    title: 'Returns & Replacement',
    intro: 'A return can be requested within 7 days of the actual delivery of the affected item.',
    windowClosed: 'The 7-day return window (from delivery) for this order has closed.',
    windowUnknown: 'We could not determine the actual delivery date of this order, so the days left cannot be shown here. You can still submit a request — the server judges the window when it is filed.',
    itemClosed: 'The return window for this item has closed.',
    daysLeft: (n: number) => `${daysLeftLabel(n, 'en')} to request a return`,
    request: 'Request return',
    faultyPartHint: 'A faulty part of the bundle? Claim it on its own:',
    reportFault: 'Report a fault',
    loading: 'Loading…',
    loadError: 'Could not load return cases.',
    retry: 'Retry',
    noCases: 'No return requests for this order.',
    qty: 'Quantity',
    reasonLabel: 'Return reason',
    reasons: {
      defective: 'Defective item',
      manufacturing_fault: 'Manufacturing fault',
      not_as_described: 'Not as described',
      wrong_product: 'Wrong product',
      shipping_damage: 'Shipping damage',
    } as Record<string, string>,
    descLabel: 'Describe the problem',
    descPlaceholder: 'Explain the issue precisely…',
    evidence: 'Photos (private — visible to staff only)',
    addPhoto: 'Add photo',
    uploading: 'Uploading…',
    submit: 'Submit return request',
    submitting: 'Submitting…',
    cancel: 'Cancel',
    removePhoto: 'Remove photo',
    caseTitle: 'Return case',
    states: {
      requested: 'Requested',
      assessment: 'Under assessment',
      approved: 'Approved',
      rejected: 'Rejected',
      collection: 'Collection',
      received: 'Received',
      inspected: 'Inspected',
      resolved: 'Resolved',
    } as Record<string, string>,
    resolutions: {
      replacement: 'Replacement',
      refund: 'Refund to wallet',
      repair: 'Repair',
      declined: 'Declined after inspection',
    } as Record<string, string>,
    adminNote: 'Staff note',
    requestedAt: 'Requested',
    timely: 'Filed within the window — late staff review never invalidates it.',
    refundNote: 'Refunds are credited to your wallet after inspection and approval (the final refund destination is a configurable store decision).',
  },
  ckb: {
    title: 'گەڕاندنەوە و گۆڕینەوە',
    intro: 'داوای گەڕاندنەوە لە ماوەی 7 ڕۆژ لە وەرگرتنی ڕاستەقینەی کاڵاکە دەکرێت.',
    windowClosed: 'ماوەی گەڕاندنەوە (7 ڕۆژ لە وەرگرتن) بۆ ئەم داواکارییە تەواو بووە.',
    windowUnknown: 'نەمانتوانی بەرواری ڕاستەقینەی وەرگرتنی ئەم داواکارییە دیاری بکەین، بۆیە ڕۆژە ماوەکان لێرە نیشان نادرێن. هێشتا دەتوانیت داواکە بنێریت — ڕاژەکار ماوەکە لە کاتی ناردن هەڵدەسەنگێنێت.',
    itemClosed: 'ماوەی گەڕاندنەوە بۆ ئەم کاڵایە تەواو بووە.',
    daysLeft: (n: number) => `${daysLeftLabel(n, 'ckb')} بۆ داوای گەڕاندنەوە`,
    request: 'داوای گەڕاندنەوە',
    faultyPartHint: 'پارچەیەکی تێکچووی پاکێجەکە؟ بە تەنها داوای بکە:',
    reportFault: 'ڕاپۆرتی تێکچوون',
    loading: 'بارکردن…',
    loadError: 'حاڵەتەکانی گەڕاندنەوە بارنەکران.',
    retry: 'هەوڵدانەوە',
    noCases: 'هیچ داوایەکی گەڕاندنەوە نییە بۆ ئەم داواکارییە.',
    qty: 'ژمارە',
    reasonLabel: 'هۆکاری گەڕاندنەوە',
    reasons: {
      defective: 'کاڵای خراپ',
      manufacturing_fault: 'کێشەی دروستکردن',
      not_as_described: 'جیاواز لە وەسفەکە',
      wrong_product: 'کاڵای هەڵە',
      shipping_damage: 'زیانی گەیاندن',
    } as Record<string, string>,
    descLabel: 'کێشەکە باس بکە',
    descPlaceholder: 'کێشەکە بە وردی ڕوون بکەرەوە…',
    evidence: 'وێنەکان (تایبەت — تەنها بۆ ستاف)',
    addPhoto: 'زیادکردنی وێنە',
    uploading: 'بارکردن…',
    submit: 'ناردنی داوای گەڕاندنەوە',
    submitting: 'ناردن…',
    cancel: 'هەڵوەشاندنەوە',
    removePhoto: 'لابردنی وێنە',
    caseTitle: 'حاڵەتی گەڕاندنەوە',
    states: {
      requested: 'پێشکەشکراوە',
      assessment: 'لە هەڵسەنگاندندایە',
      approved: 'پەسەندکراوە',
      rejected: 'ڕەتکراوەتەوە',
      collection: 'لە وەرگرتنەوەدایە',
      received: 'وەرگیراوە',
      inspected: 'پشکنراوە',
      resolved: 'تەواوبووە',
    } as Record<string, string>,
    resolutions: {
      replacement: 'گۆڕینەوە',
      refund: 'گەڕاندنەوەی پارە بۆ جزدان',
      repair: 'چاککردنەوە',
      declined: 'ڕەتکرایەوە دوای پشکنین',
    } as Record<string, string>,
    adminNote: 'تێبینی ستاف',
    requestedAt: 'بەرواری داوا',
    timely: 'لە ماوەکەدا پێشکەش کراوە — دواکەوتنی پێداچوونەوە بەتاڵی ناکاتەوە.',
    refundNote: 'پارە دەگەڕێتەوە بۆ جزدانەکەت دوای پشکنین و پەسەندکردن.',
  },
};

const WINDOW_MS = 7 * 86_400_000;

interface FormState {
  itemId: string;
  qty: number;
  reason: Reason;
  description: string;
  evidence: string[]; // private receipt keys
  /** True when the form is claiming ONE PART of a bundle, not a whole line. */
  component: boolean;
}

/** Days left in the 7-day window from a delivery time; null when unknown. */
function daysLeftFrom(deliveredIso: string | null | undefined): number | null {
  if (!deliveredIso) return null;
  const ms = Date.parse(deliveredIso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil((ms + WINDOW_MS - Date.now()) / 86_400_000));
}

export default function ReturnsSection({ order, units }: { order: OrderLike; units?: ReturnsUnitLike[] }) {
  const { lang, dir } = useLanguage();
  const S = STRINGS[lang as keyof typeof STRINGS] ?? STRINGS.ar;

  const [cases, setCases] = useState<ReturnCaseDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);

  const [form, setForm] = useState<FormState | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await api.get<{ cases: ReturnCaseDto[] }>(`/api/returns?orderId=${encodeURIComponent(order.id)}`);
      setCases(data.cases || []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    if (order.status === 'delivered') load();
    else setLoading(false);
  }, [order.status, load]);

  if (order.status !== 'delivered') return null;

  // The window runs from the ACTUAL delivery of the affected item. Devices
  // carry their own per-unit delivered_at (partial shipments); a plain item
  // falls back to the order's delivery time. The latest unit delivery is
  // used — the customer's most generous honest date; the server still judges.
  const itemDeliveredAt = (itemId: string): string | null => {
    const own = (units ?? []).filter((u) => u.order_item_id === itemId && u.delivered_at);
    if (own.length > 0) {
      return own.reduce<string | null>((best, u) => (!best || Date.parse(u.delivered_at!) > Date.parse(best) ? u.delivered_at : best), null);
    }
    return order.delivered_at ?? null;
  };
  const orderDaysLeft = daysLeftFrom(order.delivered_at);
  // Three honest states for the order as a whole: open, closed, or unknown.
  // Unknown is NOT closed — the buttons stay, and the server decides.
  const orderWindow: 'open' | 'closed' | 'unknown' =
    orderDaysLeft === null ? 'unknown' : orderDaysLeft > 0 ? 'open' : 'closed';
  const itemWindow = (itemId: string): { state: 'open' | 'closed' | 'unknown'; days: number | null } => {
    const d = daysLeftFrom(itemDeliveredAt(itemId));
    return { state: d === null ? 'unknown' : d > 0 ? 'open' : 'closed', days: d };
  };
  const anyRequestable = order.items.some((it) => itemWindow(it.id).state !== 'closed');

  /** How many units of this row exist — whether it is a line or a part of one. */
  const maxQtyFor = (itemId: string): number => {
    const top = order.items.find((i) => i.id === itemId);
    if (top) return Number(top.qty) || 1;
    const part = order.items
      .flatMap((i) => i.bundle?.components ?? [])
      .find((k) => k.order_item_id === itemId);
    return Number(part?.qty) || 1;
  };

  const startForm = (itemId: string, component = false) => {
    setForm({ itemId, qty: 1, reason: 'defective', description: '', evidence: [], component });
    setSubmitError('');
  };

  const addPhoto = async (file: File) => {
    if (!form) return;
    setUploadBusy(true);
    setSubmitError('');
    try {
      // 'receipt' uploads land under the caller's PRIVATE receipts/<uid>/
      // prefix (owner-or-admin access only) — evidence is never public.
      const { key } = await uploadFile(file, 'receipt');
      setForm((f) => (f ? { ...f, evidence: [...f.evidence, key].slice(0, 6) } : f));
    } catch (err) {
      setSubmitError(apiRefusal(err, asLang(lang), 'upload failed'));
    } finally {
      setUploadBusy(false);
    }
  };

  const submit = async () => {
    if (!form || submitBusy) return;
    setSubmitBusy(true);
    setSubmitError('');
    try {
      await api.post('/api/returns', {
        orderItemId: form.itemId,
        qty: form.qty,
        reason: form.reason,
        description: form.description,
        evidence: form.evidence,
      });
      setForm(null);
      await load(); // show the persisted case — no success UI before the server confirms
    } catch (err) {
      setSubmitError(apiRefusal(err, asLang(lang), 'failed'));
    } finally {
      setSubmitBusy(false);
    }
  };

  const stateIndex = (s: string) => (STATES as readonly string[]).indexOf(s);

  return (
    <div dir={dir} className="mt-3 rounded-xl border border-white/10 bg-[#0a0a0a] overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-start hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
      >
        <span className="flex items-center gap-2 text-sm text-white font-normal">
          <RotateCcw className="w-4 h-4 text-zinc-400" strokeWidth={1.5} />
          {S.title}
          {cases.length > 0 && (
            <span className="text-[10px] bg-white/10 rounded-full px-2 py-0.5 text-zinc-300">{cases.length}</span>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.5} />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-white/5 pt-4">
          {/* Window state — display only; the server judges by request time.
              Unknown is said as unknown, never dressed up as closed. */}
          {orderWindow === 'open' ? (
            <p className="text-xs text-emerald-400/90 font-light flex items-center gap-2" data-return-window="open">
              <Clock className="w-4 h-4 shrink-0" strokeWidth={1.5} />
              {S.daysLeft(orderDaysLeft as number)}
            </p>
          ) : orderWindow === 'closed' ? (
            <p className="text-xs text-zinc-500 font-light flex items-center gap-2" data-return-window="closed">
              <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
              {S.windowClosed}
            </p>
          ) : (
            <p className="text-xs text-amber-300/90 font-light flex items-start gap-2" data-return-window="unknown">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              {S.windowUnknown}
            </p>
          )}
          <p className="text-xs text-zinc-500 font-light">{S.intro}</p>

          {/* Existing cases */}
          {loading ? (
            <p className="text-xs text-zinc-500 font-light">{S.loading}</p>
          ) : loadError ? (
            <div className="flex items-center gap-3">
              <p className="text-xs text-red-400 font-light">{S.loadError}</p>
              <button type="button" onClick={load} className="text-xs text-white underline">{S.retry}</button>
            </div>
          ) : cases.length === 0 ? (
            <p className="text-xs text-zinc-600 font-light">{S.noCases}</p>
          ) : (
            <div className="space-y-3">
              {cases.map((c) => {
                const idx = stateIndex(c.state);
                const rejected = c.state === 'rejected';
                return (
                  <div key={c.id} className="rounded-lg bg-[#050505] border border-white/5 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-white font-normal truncate">
                          {c.item?.name ?? S.caseTitle} × {c.qty}
                        </p>
                        <p className="text-[11px] text-zinc-500 font-light">
                          {S.reasons[c.reason === 'wrong_item' ? 'wrong_product' : c.reason] ?? c.reason}
                          {' · '}
                          {S.requestedAt}: {formatDate(c.requested_at, lang)}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] px-2 py-1 rounded-full shrink-0 ${
                          rejected
                            ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                            : c.state === 'resolved'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : 'bg-white/5 text-zinc-300 border border-white/10'
                        }`}
                      >
                        {S.states[c.state] ?? c.state}
                      </span>
                    </div>

                    {/* Timeline */}
                    {!rejected && (
                      <div className="flex items-center gap-1 overflow-x-auto pb-1">
                        {STATES.map((s, i) => (
                          <React.Fragment key={s}>
                            {i > 0 && <span className={`h-px flex-1 min-w-2 ${i <= idx ? 'bg-emerald-400/60' : 'bg-white/10'}`} />}
                            <span
                              title={S.states[s]}
                              className={`w-2 h-2 rounded-full shrink-0 ${i <= idx ? 'bg-emerald-400' : 'bg-white/15'}`}
                            />
                          </React.Fragment>
                        ))}
                      </div>
                    )}

                    {c.within_window && <p className="text-[10px] text-zinc-600 font-light">{S.timely}</p>}
                    {c.resolution && (
                      <p className="text-[11px] text-zinc-300 font-light flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" strokeWidth={1.5} />
                        {S.resolutions[c.resolution] ?? c.resolution}
                      </p>
                    )}
                    {c.admin_note && (
                      <p className="text-[11px] text-zinc-500 font-light">
                        {S.adminNote}: {c.admin_note}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Request buttons per item — each item judged by ITS delivery. A
              closed item says so; an unknown one keeps its button. */}
          {anyRequestable && !form && (
            <div className="space-y-2">
              {order.items.map((it) => {
                const w = itemWindow(it.id);
                // A BUNDLE'S PARTS GET THEIR OWN FAULT BUTTON (owner decision 3).
                // The whole-bundle button above is the commercial return; a
                // broken part is claimed on its own, and the components are
                // nested under the priced line — never top-level items — so
                // without this row nothing in the app could ever post a
                // component id, and the carve-out would be unreachable.
                const parts = w.state !== 'closed' ? (it.bundle?.components ?? []) : [];
                return (
                  <div key={it.id} data-return-item={it.id} data-return-item-window={w.state} className="rounded-lg bg-[#050505] border border-white/5 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex items-center gap-3">
                        {it.image ? (
                          <img referrerPolicy="no-referrer" src={it.image} alt="" className="w-9 h-9 rounded object-cover border border-white/5 shrink-0" />
                        ) : (
                          <div className="w-9 h-9 rounded bg-zinc-900 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-xs text-white truncate">{it.name}</p>
                          <p className="text-[10px] text-zinc-500">× {it.qty} · {formatIqd(it.line_total_iqd)}</p>
                          {w.state === 'open' && orderWindow !== 'open' && (
                            <p className="text-[10px] text-emerald-400/90">{S.daysLeft(w.days as number)}</p>
                          )}
                          {w.state === 'closed' && <p className="text-[10px] text-zinc-500">{S.itemClosed}</p>}
                        </div>
                      </div>
                      {w.state !== 'closed' && (
                        <button
                          type="button"
                          onClick={() => startForm(it.id)}
                          className="text-xs bg-white/10 hover:bg-white/20 border border-white/10 text-white px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                        >
                          {S.request}
                        </button>
                      )}
                    </div>
                    {parts.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
                        <p className="text-[10px] text-zinc-500">{S.faultyPartHint}</p>
                        {parts.map((k) => (
                          <div key={k.order_item_id} data-return-component={k.order_item_id} className="flex items-center justify-between gap-3">
                            <p className="text-[11px] text-zinc-300 truncate min-w-0">
                              {k.name}
                              {k.variant ? <span className="text-zinc-500"> · {k.variant}</span> : null}
                              <span className="text-zinc-500"> × {k.qty}</span>
                            </p>
                            <button
                              type="button"
                              onClick={() => startForm(k.order_item_id, true)}
                              className="text-[11px] text-zinc-300 hover:text-white border border-white/10 hover:border-white/20 px-2 py-1 rounded-md shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                            >
                              {S.reportFault}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Request form */}
          {form && (
            <div className="rounded-lg bg-[#050505] border border-white/10 p-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] text-zinc-500 block mb-1">{S.qty}</span>
                  <select
                    value={form.qty}
                    onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })}
                    className="w-full bg-black border border-white/10 rounded-lg px-2 py-2 text-xs text-white"
                  >
                    {/* The row being claimed is a top-level item OR a bundle
                        component, and components are never in `order.items` —
                        they are nested under `bundle.components[]`. Looking
                        only at `order.items` made every per-part fault form
                        offer a single unit, so a customer with three broken
                        spools could file for one and was never told the other
                        two could be claimed. */}
                    {Array.from({ length: Math.max(1, maxQtyFor(form.itemId)) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] text-zinc-500 block mb-1">{S.reasonLabel}</span>
                  <select
                    value={form.reason}
                    onChange={(e) => setForm({ ...form, reason: e.target.value as Reason })}
                    className="w-full bg-black border border-white/10 rounded-lg px-2 py-2 text-xs text-white"
                  >
                    {(form.component ? COMPONENT_REASONS : REASONS).map((r) => (
                      <option key={r} value={r}>{S.reasons[r]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="text-[11px] text-zinc-500 block mb-1">{S.descLabel}</span>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={S.descPlaceholder}
                  rows={3}
                  maxLength={3000}
                  className="w-full bg-black border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-zinc-600 resize-y"
                />
              </label>
              <div>
                <span className="text-[11px] text-zinc-500 block mb-1">{S.evidence}</span>
                <div className="flex items-center gap-2 flex-wrap">
                  {form.evidence.map((k) => (
                    <span key={k} className="flex items-center gap-1 text-[10px] bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-zinc-300">
                      <Camera className="w-3 h-3" strokeWidth={1.5} />
                      {k.split('/').pop()}
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, evidence: form.evidence.filter((x) => x !== k) })}
                        className="text-zinc-500 hover:text-white rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                        aria-label={S.removePhoto}
                      >
                        <X className="w-3 h-3" strokeWidth={1.5} />
                      </button>
                    </span>
                  ))}
                  {form.evidence.length < 6 && (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploadBusy}
                      className="text-[11px] bg-white/5 hover:bg-white/10 border border-dashed border-white/15 text-zinc-300 px-3 py-1.5 rounded-lg disabled:opacity-50"
                    >
                      {uploadBusy ? S.uploading : S.addPhoto}
                    </button>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) addPhoto(f);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
              {submitError && (
                <p className="text-xs text-red-400 font-light flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                  {submitError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitBusy || uploadBusy}
                  className="flex-1 bg-white text-black text-xs font-normal py-2.5 rounded-lg disabled:opacity-50 hover:bg-zinc-200 transition-colors"
                >
                  {submitBusy ? S.submitting : S.submit}
                </button>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  disabled={submitBusy}
                  className="text-xs text-zinc-400 hover:text-white px-3 py-2.5"
                >
                  {S.cancel}
                </button>
              </div>
            </div>
          )}

          <p className="text-[10px] text-zinc-600 font-light">{S.refundNote}</p>
        </div>
      )}
    </div>
  );
}
