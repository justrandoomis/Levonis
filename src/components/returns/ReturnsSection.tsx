import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, AlertCircle, Camera, X, ChevronDown, CheckCircle2, Clock } from 'lucide-react';
import { api, ApiError, ApiOrder, formatIqd, uploadFile } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

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

const STRINGS = {
  ar: {
    title: 'الإرجاع والاستبدال',
    intro: 'يمكن طلب الإرجاع خلال 7 أيام من الاستلام الفعلي للمنتج المتأثر.',
    windowClosed: 'انتهت نافذة الإرجاع (7 أيام من الاستلام) لهذا الطلب.',
    daysLeft: (n: number) => (n === 1 ? 'يوم واحد متبقٍ لطلب الإرجاع' : `${n.toLocaleString('ar')} أيام متبقية لطلب الإرجاع`),
    request: 'طلب إرجاع',
    loading: 'جارٍ التحميل...',
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
    descPlaceholder: 'اشرح المشكلة بدقة...',
    evidence: 'صور توضيحية (خاصة — تُعرض للإدارة فقط)',
    addPhoto: 'إضافة صورة',
    uploading: 'جارٍ الرفع...',
    submit: 'إرسال طلب الإرجاع',
    submitting: 'جارٍ الإرسال...',
    cancel: 'إلغاء',
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
    daysLeft: (n: number) => (n === 1 ? '1 day left to request a return' : `${n} days left to request a return`),
    request: 'Request return',
    loading: 'Loading...',
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
    descPlaceholder: 'Explain the issue precisely...',
    evidence: 'Photos (private — visible to staff only)',
    addPhoto: 'Add photo',
    uploading: 'Uploading...',
    submit: 'Submit return request',
    submitting: 'Submitting...',
    cancel: 'Cancel',
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
    daysLeft: (n: number) => `${n} ڕۆژ ماوە بۆ داوای گەڕاندنەوە`,
    request: 'داوای گەڕاندنەوە',
    loading: 'بارکردن...',
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
    descPlaceholder: 'کێشەکە بە وردی ڕوون بکەرەوە...',
    evidence: 'وێنەکان (تایبەت — تەنها بۆ ستاف)',
    addPhoto: 'زیادکردنی وێنە',
    uploading: 'بارکردن...',
    submit: 'ناردنی داوای گەڕاندنەوە',
    submitting: 'ناردن...',
    cancel: 'هەڵوەشاندنەوە',
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
}

export default function ReturnsSection({ order }: { order: OrderLike }) {
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

  const deliveredMs = order.delivered_at ? Date.parse(order.delivered_at) : NaN;
  const daysLeft = Number.isFinite(deliveredMs)
    ? Math.max(0, Math.ceil((deliveredMs + WINDOW_MS - Date.now()) / 86_400_000))
    : null;
  const windowOpen = daysLeft !== null && daysLeft > 0;

  const startForm = (itemId: string) => {
    setForm({ itemId, qty: 1, reason: 'defective', description: '', evidence: [] });
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
      setSubmitError(err instanceof Error ? err.message : 'upload failed');
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
      setSubmitError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'failed');
    } finally {
      setSubmitBusy(false);
    }
  };

  const stateIndex = (s: string) => (STATES as readonly string[]).indexOf(s);

  return (
    <div dir={dir} className="mt-3 rounded-xl border border-white/10 bg-[#0a0a0a] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-start hover:bg-white/5 transition-colors"
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
          {/* Window state — display only; the server judges by request time. */}
          {windowOpen ? (
            <p className="text-xs text-emerald-400/90 font-light flex items-center gap-2">
              <Clock className="w-4 h-4 shrink-0" strokeWidth={1.5} />
              {S.daysLeft(daysLeft as number)}
            </p>
          ) : (
            <p className="text-xs text-zinc-500 font-light flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
              {S.windowClosed}
            </p>
          )}
          <p className="text-xs text-zinc-500 font-light">{S.intro}</p>

          {/* Existing cases */}
          {loading ? (
            <p className="text-xs text-zinc-500 font-light">{S.loading}</p>
          ) : loadError ? (
            <div className="flex items-center gap-3">
              <p className="text-xs text-red-400 font-light">{S.loadError}</p>
              <button onClick={load} className="text-xs text-white underline">{S.retry}</button>
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
                          {S.requestedAt}: {new Date(c.requested_at).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ')}
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

          {/* Request buttons per item (window open only) */}
          {windowOpen && !form && (
            <div className="space-y-2">
              {order.items.map((it) => (
                <div key={it.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#050505] border border-white/5 p-3">
                  <div className="min-w-0 flex items-center gap-3">
                    {it.image ? (
                      <img referrerPolicy="no-referrer" src={it.image} alt="" className="w-9 h-9 rounded object-cover border border-white/5 shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded bg-zinc-900 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs text-white truncate">{it.name}</p>
                      <p className="text-[10px] text-zinc-500">× {it.qty} · {formatIqd(it.line_total_iqd)}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => startForm(it.id)}
                    className="text-xs bg-white/10 hover:bg-white/20 border border-white/10 text-white px-3 py-1.5 rounded-lg shrink-0 transition-colors"
                  >
                    {S.request}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Request form */}
          {windowOpen && form && (
            <div className="rounded-lg bg-[#050505] border border-white/10 p-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] text-zinc-500 block mb-1">{S.qty}</span>
                  <select
                    value={form.qty}
                    onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })}
                    className="w-full bg-black border border-white/10 rounded-lg px-2 py-2 text-xs text-white"
                  >
                    {Array.from(
                      { length: Math.max(1, order.items.find((i) => i.id === form.itemId)?.qty ?? 1) },
                      (_, i) => i + 1
                    ).map((n) => (
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
                    {REASONS.map((r) => (
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
                        onClick={() => setForm({ ...form, evidence: form.evidence.filter((x) => x !== k) })}
                        className="text-zinc-500 hover:text-white"
                        aria-label="remove"
                      >
                        <X className="w-3 h-3" strokeWidth={1.5} />
                      </button>
                    </span>
                  ))}
                  {form.evidence.length < 6 && (
                    <button
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
                  onClick={submit}
                  disabled={submitBusy || uploadBusy}
                  className="flex-1 bg-white text-black text-xs font-normal py-2.5 rounded-lg disabled:opacity-50 hover:bg-zinc-200 transition-colors"
                >
                  {submitBusy ? S.submitting : S.submit}
                </button>
                <button
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
