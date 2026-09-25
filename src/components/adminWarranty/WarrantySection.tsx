/**
 * "الضمان والأرقام التسلسلية" — the order screen's warranty section.
 *
 * ONE ROW PER PHYSICAL DEVICE, never per product line: an order with two
 * printers shows two rows, each with its own serial box and its own receipt.
 * That is the whole point of the feature — a warranty belongs to a machine,
 * not to a SKU — so the row is keyed by the unit id the delivery created.
 *
 * The section is deliberately strict about the order of operations: a serial
 * has to be saved before the Generate button becomes usable, because a
 * receipt without a serial identifies nothing and the server refuses it
 * anyway. Everything else (preview, print, PDF, reprint) only appears once a
 * receipt exists.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck, Barcode, RefreshCw, Printer, FileText, Eye, AlertTriangle, Check, Copy, History,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { openWarrantyDoc, popupBlockedMessage } from './printDoc';
import UnitHistory from './UnitHistory';

export interface WarrantyUnitRow {
  id: string;
  order_item_id: string;
  unit_index: number;
  product_name: string;
  option: string;
  unit_price_iqd: number | null;
  serial: string | null;
  delivered_at: string | null;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  months: number | null;
  base_months: number | null;
  ext_months: number;
  /** A replacement unit that carries the ORIGINAL device's end date. Its
   *  months are not the lever — the device route refuses to save a no-op. */
  carried_end: boolean;
  open_claims: number;
  /** WHICH ACCOUNT HOLDS THE MACHINE. Null when nobody has linked it, or
   *  when the link was released. The order screen could show a serial and a
   *  warranty window while «الطابعة المرتبطة» stayed invisible. */
  registration: { user_id: string | null; email: string | null; username: string | null; name: string | null; registered_at: string } | null;
  replaced: boolean;
  replacement_of: string | null;
  receipt: {
    id: string;
    receipt_no: string;
    status: string;
    serial: string | null;
    /** The paper no longer matches the device record. It is not rewritten
     *  behind the owner's back — it is reported, and reissuing fixes it. */
    drift: { serial: boolean; end: boolean };
  } | null;
}

interface OrderWarrantyResponse {
  order: {
    id: string;
    status: string;
    delivered_at: string | null;
    created_at: string;
    invoice_no: string | null;
    customer: { name: string; phone: string; address: string; email: string };
  };
  config: { default_months: number };
  units: WarrantyUnitRow[];
}

const STR = {
  ar: {
    title: 'الضمان والأرقام التسلسلية',
    subtitle: 'وصل ضمان مستقل لكل جهاز، مربوط برقمه التسلسلي.',
    none: 'لا توجد وحدات قابلة للضمان في هذا الطلب. تُنشأ الوحدات عند تسليم الطلب للمنتجات المُرقّمة (الطابعات).',
    // A delivered order with no units is an order delivered before the courier
    // door created them (Al-Waseet / cron). One click creates them now.
    noneDelivered: 'الطلب مُسلَّم لكن لم تُنشأ وحدات أجهزته بعد (طلب سُلِّم قبل أن يُنشئها التسليم عبر شركة التوصيل). أنشئها الآن ليبدأ ضمانها من تاريخ التسليم ويستطيع الزبون ربطها.',
    backfill: 'إنشاء الوحدات',
    backfilling: 'جارٍ الإنشاء…',
    backfillNone: 'لا يحتوي هذا الطلب على منتجات مُرقّمة (طابعات) — لا وحدات لإنشائها.',
    unit: 'وحدة',
    serial: 'الرقم التسلسلي',
    serialPlaceholder: 'أدخل الرقم كما هو على ملصق الجهاز',
    save: 'حفظ',
    saved: 'محفوظ',
    months: 'مدة الضمان (شهر)',
    start: 'بداية الضمان',
    end: 'نهاية الضمان',
    generate: 'إنشاء وصل الضمان',
    generating: 'جارٍ الإنشاء…',
    needSerial: 'أدخل الرقم التسلسلي أولًا — لا يُصدر وصل بلا رقم.',
    driftSerial: 'الوصل المطبوع يحمل الرقم التسلسلي {old} بينما الجهاز صار {new}. أعد إصدار الوصل من شاشة «الضمانات» ليطابق الجهاز.',
    driftEnd: 'تاريخ نهاية الضمان على الوصل لا يطابق سجل الجهاز بعد تصحيح التسليم. أعد إصدار الوصل ليطابقه.',
    preview: 'معاينة',
    print: 'طباعة',
    pdf: 'حفظ PDF',
    reprint: 'نسخة أخرى',
    receiptNo: 'رقم الوصل',
    status: 'الحالة',
    stDraft: 'مسودة',
    stActive: 'ساري',
    stExpired: 'منتهٍ',
    stVoid: 'ملغى',
    stReplaced: 'مُستبدَل',
    replaced: 'وحدة مُستبدَلة',
    reassignConfirm: 'هذا الرقم مستخدم أو للوحدة رقم آخر. إعادة التعيين إجراء مُدقَّق يتطلب سببًا. المتابعة؟',
    reasonPrompt: 'السبب (يُسجَّل في سجل التدقيق):',
    reasonRequired: 'السبب مطلوب (5 أحرف على الأقل).',
    copy: 'نسخ الرقم',
    copied: 'نُسخ',
    notDelivered: 'الطلب غير مُسلَّم بعد — يمكن تجهيز الوصل الآن ويبدأ الضمان من التاريخ المذكور أدناه.',
    cancelled: 'الطلب ملغى — لا يُصدر ضمان لطلب لم يُسلَّم.',
    loading: 'جارٍ التحميل…',
    linkedTo: 'الجهاز مرتبط بحساب',
    linkedSince: 'منذ',
    notLinked: 'غير مرتبط بأي حساب بعد',
    openClaims: 'مطالبات ضمان مفتوحة',
    editDuration: 'تعديل مدة الضمان',
    durationTitle: 'مدة الضمان تُحسب مرة واحدة عند التسليم. تغييرها قرار متعمّد يُسجَّل في سجل التدقيق باسمك وتاريخه، ولا يُعاد إصدار الوصل المطبوع.',
    baseMonths: 'المدة الأساسية (شهر)',
    extMonths: 'التمديد (شهر)',
    durationReason: 'السبب (5 أحرف على الأقل، يُسجَّل في سجل التدقيق)',
    saveDuration: 'حفظ المدة',
    durationSaved: 'تم تحديث مدة الضمان.',
    monthsRequired: 'أدخل مدة أساسية صحيحة (1 إلى 240 شهرًا).',
    shorterWarn: 'هذا التغيير يُنهي التغطية قبل تاريخها الحالي، وقد يكون الزبون قد أُبلغ بالتاريخ القديم. أكّد لتتابع.',
    shorterConfirm: 'نعم، قصّر التغطية',
    carriedEnd: 'وحدة بديلة تحمل تاريخ نهاية الجهاز الأصلي — عدّل ضمان الوحدة الأصلية.',
    cancel: 'إلغاء',
    delivered: 'التسليم',
    history: 'سجل التعديلات',
    hideHistory: 'إخفاء السجل',
  },
  en: {
    title: 'Warranty & Serial Numbers',
    subtitle: 'One warranty receipt per device, tied to its serial number.',
    none: 'This order has no warranty-eligible units. Units are created when the order is delivered, for serialized products (printers).',
    noneDelivered: 'The order is delivered but its device units were never created (it was delivered before courier deliveries created them). Create them now so the warranty starts from the delivery date and the customer can link the device.',
    backfill: 'Create units',
    backfilling: 'Creating…',
    backfillNone: 'This order has no serialized products (printers) — there are no units to create.',
    unit: 'Unit',
    serial: 'Serial number',
    serialPlaceholder: 'Enter it exactly as printed on the device',
    save: 'Save',
    saved: 'Saved',
    months: 'Warranty (months)',
    start: 'Warranty start',
    end: 'Warranty end',
    generate: 'Generate warranty',
    generating: 'Generating…',
    needSerial: 'Enter the serial number first — no receipt is issued without one.',
    driftSerial: 'The printed receipt carries serial {old} while the device now reads {new}. Reissue it from the Warranties screen so the paper matches the device.',
    driftEnd: 'The receipt’s end date no longer matches the device record after the delivery correction. Reissue it to match.',
    preview: 'Preview',
    print: 'Print',
    pdf: 'Save PDF',
    reprint: 'Another copy',
    receiptNo: 'Receipt no.',
    status: 'Status',
    stDraft: 'Draft',
    stActive: 'Active',
    stExpired: 'Expired',
    stVoid: 'Void',
    stReplaced: 'Replaced',
    replaced: 'Replaced unit',
    reassignConfirm: 'That serial is taken, or this unit already has one. Reassignment is audited and needs a reason. Continue?',
    reasonPrompt: 'Reason (recorded in the audit log):',
    reasonRequired: 'A reason is required (at least 5 characters).',
    copy: 'Copy number',
    copied: 'Copied',
    notDelivered: 'The order is not delivered yet — the receipt can be prepared now and starts on the date below.',
    cancelled: 'The order was cancelled — no warranty is issued for an order that was never delivered.',
    loading: 'Loading…',
    linkedTo: 'Linked to account',
    linkedSince: 'since',
    notLinked: 'Not linked to any account yet',
    openClaims: 'open warranty claim(s)',
    editDuration: 'Change warranty duration',
    durationTitle: 'A warranty duration is computed once, at delivery. Changing it is a deliberate decision, recorded in the audit trail with your name and the time, and the printed receipt is not reissued.',
    baseMonths: 'Base months',
    extMonths: 'Extension months',
    durationReason: 'Reason (min 5 characters, recorded in the audit trail)',
    saveDuration: 'Save duration',
    durationSaved: 'Warranty duration updated.',
    monthsRequired: 'Enter a valid base duration (1 to 240 months).',
    shorterWarn: 'This ends the coverage earlier than it ends today, and the customer may already have been told the old date. Confirm to continue.',
    shorterConfirm: 'Yes, shorten the coverage',
    carriedEnd: 'A replacement unit carrying the original device’s end date — change the original unit’s warranty instead.',
    cancel: 'Cancel',
    delivered: 'Delivered',
    history: 'Change history',
    hideHistory: 'Hide history',
  },
};

const dateInput = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');
const toIso = (day: string): string => (day ? new Date(`${day}T00:00:00.000Z`).toISOString() : '');

export default function WarrantySection({ orderId }: { orderId: string }) {
  const { lang, dir } = useLanguage();
  const t = lang === 'en' ? STR.en : STR.ar;
  const [data, setData] = useState<OrderWarrantyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // A SET, not one string. Two device rows sit side by side and the owner
  // does use them in parallel; with a single value the second action cleared
  // the first one's in-flight flag, re-enabling a button whose request was
  // still on the wire and inviting a double submit.
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const busy = (key: string) => busyKeys.has(key);
  const setBusy = (key: string, on: boolean) =>
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const [drafts, setDrafts] = useState<Record<string, { serial: string; months: string; start: string; start0: string }>>({});
  const [copied, setCopied] = useState('');
  // The warranty-duration editor, open for at most one unit at a time. The
  // shorten confirmation arms ONLY after the server has refused this exact
  // change once, so a live window can never be pulled in on a first click.
  const [durationFor, setDurationFor] = useState<string | null>(null);
  const [duration, setDuration] = useState({ base: '', ext: '', reason: '', shorter: false });
  const [durationNote, setDurationNote] = useState('');
  // «مَن غيّر ومتى»: the per-unit history, open per row, refetched after every
  // reload of the section so a change just saved appears in it at once.
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  const [historyTick, setHistoryTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<OrderWarrantyResponse>(`/api/admin/warranties/orders/${orderId}`);
      setData(res);
      setHistoryTick((n) => n + 1);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const u of res.units) {
          if (!next[u.id]) {
            const start = dateInput(u.warranty_start_at ?? u.delivered_at ?? res.order.delivered_at ?? res.order.created_at);
            // `start0` remembers what was PREFILLED. A date input can only
            // carry a day, so sending it back unchanged would replace the
            // device's exact delivery timestamp with midnight UTC and move
            // the whole window. The value travels only when the admin edits it.
            next[u.id] = { serial: u.serial ?? '', months: String(u.months ?? res.config.default_months), start, start0: start };
          }
        }
        return next;
      });
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A delivered order with no units (delivered through the courier before the
  // courier door created them): the same idempotent backfill AdminSerials
  // offers, one click from where the admin noticed it.
  const [backfilling, setBackfilling] = useState(false);
  const [backfillNone, setBackfillNone] = useState(false);
  const backfillUnits = async () => {
    setBackfilling(true);
    try {
      const res = await api.post<{ serialized_items: number; created: number }>(
        `/api/devices/admin/orders/${orderId}/units/backfill`
      );
      if (!res.serialized_items) setBackfillNone(true);
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBackfilling(false);
    }
  };

  const setDraft = (unitId: string, patch: Partial<{ serial: string; months: string; start: string }>) =>
    setDrafts((d) => ({ ...d, [unitId]: { ...d[unitId], ...patch } }));

  /** Saves the serial through the DEVICE route — the one place serials live. */
  const saveSerial = async (unit: WarrantyUnitRow) => {
    const serial = (drafts[unit.id]?.serial ?? '').trim();
    if (serial.length < 4) {
      setErr(t.needSerial);
      return;
    }
    const key = `serial:${unit.id}`;
    setBusy(key, true);
    setErr(null);
    try {
      await api.post(`/api/devices/admin/units/${unit.id}/serial`, { serial });
      await load();
    } catch (e) {
      // The device route asks for an explicit reassign + reason rather than
      // silently moving a serial off another machine.
      if (e instanceof ApiError && e.code === 'REASSIGN_REQUIRED') {
        if (!window.confirm(t.reassignConfirm)) return;
        const reason = window.prompt(t.reasonPrompt) ?? '';
        if (reason.trim().length < 5) {
          setErr(t.reasonRequired);
          return;
        }
        try {
          await api.post(`/api/devices/admin/units/${unit.id}/serial`, { serial, reassign: true, reason: reason.trim() });
          await load();
        } catch (e2) {
          setErr(e2 instanceof ApiError ? e2.message : String(e2));
        }
      } else {
        setErr(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setBusy(key, false);
    }
  };

  const openDuration = (unit: WarrantyUnitRow) => {
    setDurationNote('');
    setErr(null);
    if (durationFor === unit.id) {
      setDurationFor(null);
      return;
    }
    setDurationFor(unit.id);
    setDuration({
      base: unit.base_months !== null ? String(unit.base_months) : String(unit.months ?? ''),
      ext: String(unit.ext_months ?? 0),
      reason: '',
      shorter: false,
    });
  };

  /**
   * Moves the unit's CLOCK — not the paper. The device route owns the
   * warranty columns (this file only reads them), audits the change, and
   * refuses a shortening it was not explicitly told about; that refusal is
   * the prompt below, not an error to swallow.
   */
  const saveDuration = async (unit: WarrantyUnitRow) => {
    const base = Number(duration.base);
    const ext = Number(duration.ext || '0');
    if (!Number.isInteger(base) || base < 1 || base > 240 || !Number.isInteger(ext) || ext < 0 || ext > 240) {
      setErr(t.monthsRequired);
      return;
    }
    if (duration.reason.trim().length < 5) {
      setErr(t.reasonRequired);
      return;
    }
    const key = `dur:${unit.id}`;
    setBusy(key, true);
    setErr(null);
    try {
      await api.patch(`/api/devices/admin/units/${unit.id}/warranty`, {
        base_months: base,
        ext_months: ext,
        reason: duration.reason.trim(),
        confirm_shorter: duration.shorter || undefined,
      });
      setDurationFor(null);
      setDurationNote(t.durationSaved);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_SHORTER_REQUIRED') {
        setDuration((d) => ({ ...d, shorter: true }));
      }
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(key, false);
    }
  };

  const generate = async (unit: WarrantyUnitRow) => {
    const d = drafts[unit.id];
    const key = `gen:${unit.id}`;
    setBusy(key, true);
    setErr(null);
    try {
      await api.post('/api/admin/warranties', {
        unit_id: unit.id,
        months: Number(d?.months) || undefined,
        warranty_start_at: d?.start && d.start !== d.start0 ? toIso(d.start) : undefined,
      });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(key, false);
    }
  };

  /** Opening the document is a navigation, so the cookie goes with it. The
   *  counting rules live in one place; see printDoc.ts. */
  const openDoc = async (receiptId: string, print: boolean) => {
    const key = `print:${receiptId}`;
    setBusy(key, true);
    try {
      const res = await openWarrantyDoc(receiptId, { print, lang });
      if (res === 'blocked') setErr(popupBlockedMessage(lang));
      else if (print) await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(key, false);
    }
  };

  const reprint = (receiptId: string) => openDoc(receiptId, true);

  const statusLabel = (s: string) =>
    s === 'active' ? t.stActive : s === 'expired' ? t.stExpired : s === 'void' ? t.stVoid : s === 'replaced' ? t.stReplaced : t.stDraft;
  const statusClass = (s: string) =>
    s === 'active'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : s === 'expired'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : s === 'void' || s === 'replaced'
          ? 'bg-red-500/10 text-red-300 border-red-500/30'
          : 'bg-zinc-700/40 text-zinc-300 border-zinc-600';

  return (
    <section data-warranty-section dir={dir}>
      <h3 className="text-[13px] font-bold text-zinc-400 mb-1 flex items-center gap-2">
        <ShieldCheck className="w-4 h-4" aria-hidden />
        {t.title}
      </h3>
      <p className="text-[12px] text-zinc-500 mb-2">{t.subtitle}</p>

      {err && (
        <div className="mb-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300" role="alert">
          {err}
        </div>
      )}

      {durationNote && (
        <div className="mb-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-300" role="status">
          {durationNote}
        </div>
      )}

      {loading && !data ? (
        <p className="text-zinc-500 text-[13px]">{t.loading}</p>
      ) : !data || data.units.length === 0 ? (
        data && data.order.status === 'delivered' && data.order.delivered_at ? (
          <div className="space-y-2">
            <p className="text-zinc-400 text-[13px]">{backfillNone ? t.backfillNone : t.noneDelivered}</p>
            {!backfillNone && (
              <button
                type="button"
                onClick={() => void backfillUnits()}
                disabled={backfilling}
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-bold text-emerald-300 disabled:opacity-50"
              >
                {backfilling ? t.backfilling : t.backfill}
              </button>
            )}
          </div>
        ) : (
          <p className="text-zinc-500 text-[13px]">{t.none}</p>
        )
      ) : (
        <>
          {data.order.status === 'cancelled' && !data.order.delivered_at && (
            <div className="mb-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {t.cancelled}
            </div>
          )}
          {data.order.status !== 'cancelled' && !data.order.delivered_at && (
            <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {t.notDelivered}
            </div>
          )}

          <div className="space-y-2.5">
            {data.units.map((u) => {
              const d = drafts[u.id] ?? { serial: '', months: '', start: '', start0: '' };
              const serialSaved = !!u.serial && u.serial === d.serial.trim();
              return (
                <div
                  key={u.id}
                  data-warranty-unit={u.id}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-[13px] font-bold text-white min-w-0 truncate">{u.product_name}</span>
                    <span className="text-[11px] text-zinc-400 shrink-0">
                      {t.unit} {u.unit_index}
                    </span>
                    {u.option && <span className="text-[11px] text-zinc-500 truncate">{u.option}</span>}
                    {u.replaced && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-600 text-zinc-400">
                        {t.replaced}
                      </span>
                    )}
                    {u.receipt && (
                      <span
                        data-warranty-status={u.receipt.status}
                        className={`text-[10px] px-2 py-0.5 rounded-full border ${statusClass(u.receipt.status)}`}
                      >
                        {statusLabel(u.receipt.status)}
                      </span>
                    )}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[1fr_auto] items-end">
                    <label className="block min-w-0">
                      <span className="block text-[11px] font-bold text-zinc-400 mb-1">{t.serial}</span>
                      <div className="flex gap-1.5">
                        <input
                          dir="ltr"
                          value={d.serial}
                          data-warranty-serial={u.id}
                          onChange={(e) => setDraft(u.id, { serial: e.target.value })}
                          placeholder={t.serialPlaceholder}
                          className="flex-1 min-w-0 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white font-mono focus:border-iris focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void saveSerial(u)}
                          disabled={busy(`serial:${u.id}`) || serialSaved}
                          data-warranty-save-serial={u.id}
                          className="inline-flex items-center gap-1.5 min-h-10 px-3 rounded-lg border border-zinc-700 bg-zinc-800 text-[12px] font-bold text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                        >
                          {serialSaved ? <Check className="w-4 h-4" aria-hidden /> : <Barcode className="w-4 h-4" aria-hidden />}
                          {serialSaved ? t.saved : t.save}
                        </button>
                      </div>
                    </label>

                    {!u.receipt && (
                      <div className="flex flex-wrap gap-2">
                        <label className="block">
                          <span className="block text-[11px] font-bold text-zinc-400 mb-1">{t.months}</span>
                          <input
                            type="number"
                            min={1}
                            max={240}
                            dir="ltr"
                            value={d.months}
                            data-warranty-months={u.id}
                            onChange={(e) => setDraft(u.id, { months: e.target.value })}
                            className="w-20 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white focus:border-iris focus:outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="block text-[11px] font-bold text-zinc-400 mb-1">{t.start}</span>
                          <input
                            type="date"
                            dir="ltr"
                            value={d.start}
                            data-warranty-start={u.id}
                            onChange={(e) => setDraft(u.id, { start: e.target.value })}
                            className="min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white focus:border-iris focus:outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void generate(u)}
                          disabled={!u.serial || busy(`gen:${u.id}`)}
                          title={!u.serial ? t.needSerial : undefined}
                          data-warranty-generate={u.id}
                          className="self-end inline-flex items-center gap-1.5 min-h-10 px-3.5 rounded-lg bg-[#6B46FF] hover:bg-iris-deep text-snow text-[12px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {busy(`gen:${u.id}`) ? (
                            <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />
                          ) : (
                            <ShieldCheck className="w-4 h-4" aria-hidden />
                          )}
                          {busy(`gen:${u.id}`) ? t.generating : t.generate}
                        </button>
                      </div>
                    )}
                  </div>

                  {!u.serial && !u.receipt && (
                    <p className="mt-1.5 text-[11px] text-amber-300/90">{t.needSerial}</p>
                  )}

                  {/* WHO HOLDS THE MACHINE, and the window it is under. The
                      serial says which box; this says which customer account
                      will phone about it, and whether a claim is already
                      open on it. */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    {u.registration ? (
                      <span className="text-zinc-400" data-warranty-holder={u.id}>
                        <ShieldCheck className="inline w-3 h-3 me-1 text-emerald-400" aria-hidden />
                        {t.linkedTo}:{' '}
                        <span className="text-zinc-200 break-all" dir="ltr">
                          {u.registration.email || u.registration.username || u.registration.name || u.registration.user_id}
                        </span>{' '}
                        <span className="text-zinc-500">
                          {t.linkedSince} {dateInput(u.registration.registered_at)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-zinc-500" data-warranty-holder={u.id}>{t.notLinked}</span>
                    )}
                    {u.open_claims > 0 && (
                      <span className="text-amber-300/90">
                        <AlertTriangle className="inline w-3 h-3 me-1" aria-hidden />
                        {u.open_claims} {t.openClaims}
                      </span>
                    )}
                    {/* The whole window, not only its end: the delivery it was
                        measured from and the day it started — which differ
                        for a replacement unit or a corrected delivery. The
                        start used to appear only as the draft input before a
                        receipt existed, and vanished once one did. */}
                    <span className="text-zinc-500" data-warranty-window={u.id}>
                      {t.delivered}: <span className="text-zinc-300" dir="ltr">{dateInput(u.delivered_at) || '—'}</span>
                      {' · '}
                      {t.start}: <span className="text-zinc-300" dir="ltr">{dateInput(u.warranty_start_at) || '—'}</span>
                      {' · '}
                      {t.months}: <span className="text-zinc-300" dir="ltr">{u.months ?? '—'}</span>
                      {' · '}
                      {t.end}: <span className="text-zinc-300" dir="ltr">{dateInput(u.warranty_end_at) || '—'}</span>
                    </span>
                    {u.carried_end ? (
                      <span className="text-zinc-500">{t.carriedEnd}</span>
                    ) : (
                      !u.replaced && (
                        <button
                          type="button"
                          onClick={() => openDuration(u)}
                          data-warranty-edit-duration={u.id}
                          className="text-zinc-400 hover:text-white underline underline-offset-2"
                        >
                          {t.editDuration}
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((h) => ({ ...h, [u.id]: !h[u.id] }))}
                      aria-expanded={!!historyOpen[u.id]}
                      data-warranty-history-toggle={u.id}
                      className="inline-flex items-center gap-1 text-zinc-400 hover:text-white underline underline-offset-2"
                    >
                      <History className="w-3 h-3" aria-hidden />
                      {historyOpen[u.id] ? t.hideHistory : t.history}
                    </button>
                  </div>

                  {historyOpen[u.id] && (
                    <div className="mt-2">
                      <UnitHistory unitId={u.id} lang={lang} refreshKey={historyTick} />
                    </div>
                  )}

                  {durationFor === u.id && (
                    <div className="mt-2 rounded-xl border border-zinc-700 bg-zinc-900/70 p-3 space-y-2">
                      <p className="text-[11px] text-zinc-400 leading-relaxed">{t.durationTitle}</p>
                      <div className="flex flex-wrap gap-2">
                        <label className="block">
                          <span className="block text-[11px] font-bold text-zinc-400 mb-1">{t.baseMonths}</span>
                          <input
                            type="number"
                            min={1}
                            max={240}
                            dir="ltr"
                            value={duration.base}
                            data-warranty-base={u.id}
                            onChange={(e) => setDuration((d) => ({ ...d, base: e.target.value }))}
                            className="w-24 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white focus:border-iris focus:outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="block text-[11px] font-bold text-zinc-400 mb-1">{t.extMonths}</span>
                          <input
                            type="number"
                            min={0}
                            max={240}
                            dir="ltr"
                            value={duration.ext}
                            data-warranty-ext={u.id}
                            onChange={(e) => setDuration((d) => ({ ...d, ext: e.target.value }))}
                            className="w-24 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white focus:border-iris focus:outline-none"
                          />
                        </label>
                      </div>
                      <label className="block">
                        <span className="block text-[11px] font-bold text-zinc-400 mb-1">{t.durationReason}</span>
                        <textarea
                          rows={2}
                          minLength={5}
                          maxLength={500}
                          value={duration.reason}
                          data-warranty-reason={u.id}
                          onChange={(e) => setDuration((d) => ({ ...d, reason: e.target.value }))}
                          className="w-full bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 py-2 text-[13px] text-white focus:border-iris focus:outline-none resize-none"
                        />
                      </label>
                      {duration.shorter && (
                        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200 leading-relaxed">
                          {t.shorterWarn}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void saveDuration(u)}
                          disabled={busy(`dur:${u.id}`)}
                          data-warranty-save-duration={u.id}
                          className="inline-flex items-center gap-1.5 min-h-10 px-3.5 rounded-lg bg-[#6B46FF] hover:bg-iris-deep text-snow text-[12px] font-bold disabled:opacity-40"
                        >
                          {busy(`dur:${u.id}`) ? <RefreshCw className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldCheck className="w-4 h-4" aria-hidden />}
                          {duration.shorter ? t.shorterConfirm : t.saveDuration}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDurationFor(null)}
                          className="min-h-10 px-3 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-300 hover:bg-zinc-800"
                        >
                          {t.cancel}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* The paper is a snapshot on purpose, so a corrected serial
                      or delivery date cannot reach back into it. Saying so is
                      the difference between a snapshot and a stale document. */}
                  {u.receipt?.drift?.serial && (
                    <p className="mt-1.5 text-[11px] text-amber-300/90" data-warranty-drift={u.id}>
                      {t.driftSerial.replace('{old}', u.receipt.serial ?? '—').replace('{new}', u.serial ?? '—')}
                    </p>
                  )}
                  {u.receipt?.drift?.end && !u.receipt.drift.serial && (
                    <p className="mt-1.5 text-[11px] text-amber-300/90" data-warranty-drift={u.id}>
                      {t.driftEnd}
                    </p>
                  )}

                  {u.receipt && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2">
                      <span className="text-[11px] text-zinc-400">{t.receiptNo}</span>
                      <span className="font-mono text-[12px] text-white" dir="ltr">
                        {u.receipt.receipt_no}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard?.writeText(u.receipt!.receipt_no);
                          setCopied(u.receipt!.receipt_no);
                          window.setTimeout(() => setCopied(''), 1200);
                        }}
                        title={t.copy}
                        aria-label={t.copy}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800"
                      >
                        {copied === u.receipt.receipt_no ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <div className="ms-auto flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openDoc(u.receipt!.id, false)}
                          data-warranty-preview={u.id}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          <Eye className="w-3.5 h-3.5" aria-hidden /> {t.preview}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openDoc(u.receipt!.id, true)}
                          data-warranty-print={u.id}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          <Printer className="w-3.5 h-3.5" aria-hidden /> {t.print}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openDoc(u.receipt!.id, true)}
                          data-warranty-pdf={u.id}
                          title={lang === 'en' ? 'Choose “Save as PDF” in the print dialog' : 'اختر «حفظ بصيغة PDF» في نافذة الطباعة'}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          <FileText className="w-3.5 h-3.5" aria-hidden /> {t.pdf}
                        </button>
                        <button
                          type="button"
                          onClick={() => void reprint(u.receipt!.id)}
                          disabled={busy(`print:${u.receipt.id}`)}
                          data-warranty-reprint={u.id}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${busy(`print:${u.receipt.id}`) ? 'animate-spin' : ''}`} aria-hidden />
                          {t.reprint}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
