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
  ShieldCheck, Barcode, RefreshCw, Printer, FileText, Eye, AlertTriangle, Check, Copy,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

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
  replaced: boolean;
  replacement_of: string | null;
  receipt: { id: string; receipt_no: string; status: string } | null;
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
    none: 'لا توجد وحدات قابلة للضمان في هذا الطلب. تُنشأ الوحدات من حدث التسليم للمنتجات المُرقّمة.',
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
  },
  en: {
    title: 'Warranty & Serial Numbers',
    subtitle: 'One warranty receipt per device, tied to its serial number.',
    none: 'This order has no warranty-eligible units. Units are created from the delivery event for serialized products.',
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
  const [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { serial: string; months: string; start: string }>>({});
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<OrderWarrantyResponse>(`/api/admin/warranties/orders/${orderId}`);
      setData(res);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const u of res.units) {
          if (!next[u.id]) {
            next[u.id] = {
              serial: u.serial ?? '',
              months: String(u.months ?? res.config.default_months),
              start: dateInput(u.warranty_start_at ?? u.delivered_at ?? res.order.delivered_at ?? res.order.created_at),
            };
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

  const setDraft = (unitId: string, patch: Partial<{ serial: string; months: string; start: string }>) =>
    setDrafts((d) => ({ ...d, [unitId]: { ...d[unitId], ...patch } }));

  /** Saves the serial through the DEVICE route — the one place serials live. */
  const saveSerial = async (unit: WarrantyUnitRow) => {
    const serial = (drafts[unit.id]?.serial ?? '').trim();
    if (serial.length < 4) {
      setErr(t.needSerial);
      return;
    }
    setBusy(`serial:${unit.id}`);
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
      setBusy('');
    }
  };

  const generate = async (unit: WarrantyUnitRow) => {
    const d = drafts[unit.id];
    setBusy(`gen:${unit.id}`);
    setErr(null);
    try {
      await api.post('/api/admin/warranties', {
        unit_id: unit.id,
        months: Number(d?.months) || undefined,
        warranty_start_at: d?.start ? toIso(d.start) : undefined,
      });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  /** Opening the document is a navigation, so the cookie goes with it. */
  const openDoc = (receiptId: string, print: boolean) => {
    window.open(`/api/admin/warranties/${receiptId}/document${print ? '?print=1' : ''}`, '_blank', 'noopener');
  };

  const reprint = async (receiptId: string) => {
    setBusy(`print:${receiptId}`);
    try {
      // Counted and audited BEFORE the tab opens: a second copy of a warranty
      // document is exactly the thing that has to leave a trace.
      await api.post(`/api/admin/warranties/${receiptId}/printed`, {});
      openDoc(receiptId, true);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

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

      {loading && !data ? (
        <p className="text-zinc-500 text-[13px]">{t.loading}</p>
      ) : !data || data.units.length === 0 ? (
        <p className="text-zinc-500 text-[13px]">{t.none}</p>
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
              const d = drafts[u.id] ?? { serial: '', months: '', start: '' };
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
                          className="flex-1 min-w-0 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white font-mono focus:border-[#6B46FF] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void saveSerial(u)}
                          disabled={busy === `serial:${u.id}` || serialSaved}
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
                            className="w-20 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white focus:border-[#6B46FF] focus:outline-none"
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
                            className="min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white focus:border-[#6B46FF] focus:outline-none"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void generate(u)}
                          disabled={!u.serial || busy === `gen:${u.id}`}
                          title={!u.serial ? t.needSerial : undefined}
                          data-warranty-generate={u.id}
                          className="self-end inline-flex items-center gap-1.5 min-h-10 px-3.5 rounded-lg bg-[#6B46FF] hover:bg-[#5a3ae0] text-white text-[12px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {busy === `gen:${u.id}` ? (
                            <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />
                          ) : (
                            <ShieldCheck className="w-4 h-4" aria-hidden />
                          )}
                          {busy === `gen:${u.id}` ? t.generating : t.generate}
                        </button>
                      </div>
                    )}
                  </div>

                  {!u.serial && !u.receipt && (
                    <p className="mt-1.5 text-[11px] text-amber-300/90">{t.needSerial}</p>
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
                          onClick={() => openDoc(u.receipt!.id, false)}
                          data-warranty-preview={u.id}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          <Eye className="w-3.5 h-3.5" aria-hidden /> {t.preview}
                        </button>
                        <button
                          type="button"
                          onClick={() => openDoc(u.receipt!.id, true)}
                          data-warranty-print={u.id}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          <Printer className="w-3.5 h-3.5" aria-hidden /> {t.print}
                        </button>
                        <button
                          type="button"
                          onClick={() => openDoc(u.receipt!.id, true)}
                          data-warranty-pdf={u.id}
                          title={lang === 'en' ? 'Choose “Save as PDF” in the print dialog' : 'اختر «حفظ بصيغة PDF» في نافذة الطباعة'}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          <FileText className="w-3.5 h-3.5" aria-hidden /> {t.pdf}
                        </button>
                        <button
                          type="button"
                          onClick={() => void reprint(u.receipt!.id)}
                          disabled={busy === `print:${u.receipt.id}`}
                          data-warranty-reprint={u.id}
                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${busy === `print:${u.receipt.id}` ? 'animate-spin' : ''}`} aria-hidden />
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
