/**
 * «محرر الطابعات → اقتصاديات الطراز» — what an hour on each printer model costs.
 *
 * WHY THIS SCREEN EXISTS. «مهما اخترت الطابعة لا يغير من حساب السعر». On the
 * live catalogue every model's purchase price, resale value, useful hours,
 * maintenance and wattages are EMPTY (migration 0078 refuses to invent them),
 * so the calculator bills every machine hour at the one platform rate, and ten
 * of the fourteen printers quote the same file to the same dinar. Nothing
 * could fill those columns until now: docs/DECISIONS.md row 100 pointed at an
 * editor that did not exist.
 *
 * WHAT IT WRITES. PATCH /api/admin/print-quote/printer-models/:id — bounded
 * on the server, audited with the before and after, and read by the very next
 * quote (worker/lib/printQuote/repository.ts `printerModelFromRow`). An empty
 * box means "not recorded" and is sent as null; the engine then falls back to
 * the platform machine-hour rate for depreciation and charges no electricity,
 * exactly as it does today. No figure on this screen is a default — every
 * number is one the owner typed.
 *
 * THE GROUP LABEL beside each model is the same `price_group` the customer's
 * calculator uses: models sharing one quote ONE piece in ONE material
 * identically. Entering a model's real figures moves it out of its group —
 * which is how the owner sees the change reach the price.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Printer, RotateCcw, Save } from 'lucide-react';
import { api, ApiError } from '../../lib/api';

type T = (ar: string, en: string) => string;

interface FieldSpec {
  column: string;
  min: number;
  max: number;
  integer: boolean;
  nullable: boolean;
}

interface ModelRow {
  id: string;
  manufacturer: string;
  model: string;
  technology: 'fdm' | 'resin';
  enclosed: number;
  active: number;
  price_group: string;
  machine_iqd_per_hour: number;
  [column: string]: unknown;
}

interface ListResponse {
  fields: FieldSpec[];
  platform_machine_hour_iqd: { fdm: number; resin: number };
  models: ModelRow[];
}

/** Labels, units and a one-line why, per column the server lets us write. */
const META: Record<string, { ar: string; en: string; unit: [string, string]; hint?: [string, string] }> = {
  purchase_iqd: { ar: 'سعر الشراء', en: 'Purchase price', unit: ['د.ع', 'IQD'] },
  residual_iqd: { ar: 'قيمة البيع المتوقعة', en: 'Expected resale value', unit: ['د.ع', 'IQD'] },
  useful_print_hours: {
    ar: 'ساعات الطباعة المتوقعة',
    en: 'Useful print hours',
    unit: ['ساعة', 'h'],
    hint: ['الاستهلاك لكل ساعة = (الشراء − البيع) ÷ الساعات', 'Depreciation per hour = (purchase − resale) ÷ hours'],
  },
  maintenance_iqd_per_hour: { ar: 'صيانة لكل ساعة', en: 'Maintenance per hour', unit: ['د.ع', 'IQD'] },
  idle_watts: { ar: 'واط الخمول', en: 'Idle watts', unit: ['واط', 'W'] },
  printing_watts: { ar: 'واط أثناء الطباعة', en: 'Printing watts', unit: ['واط', 'W'] },
  bed_heating_watts: { ar: 'واط تسخين السرير', en: 'Bed heating watts', unit: ['واط', 'W'] },
  nozzle_heating_watts: { ar: 'واط تسخين الفوهة', en: 'Nozzle heating watts', unit: ['واط', 'W'] },
  max_volumetric_flow_mm3_s: { ar: 'أقصى تدفق', en: 'Max volumetric flow', unit: ['مم³/ث', 'mm³/s'] },
  layer_overhead_seconds: { ar: 'زمن إضافي لكل طبقة', en: 'Overhead per layer', unit: ['ث', 's'] },
  warmup_minutes: { ar: 'التسخين قبل الطباعة', en: 'Warm-up', unit: ['دقيقة', 'min'] },
  baseline_success_rate: { ar: 'نسبة النجاح الأساسية', en: 'Baseline success rate', unit: ['0.5–1', '0.5–1'] },
};

/** A whole-dinar figure with Latin digits; the unit is written beside it. */
const dinars = (n: number): string => Math.round(n).toLocaleString('en-US');

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * The boxes after a (re)load. The first load fills every model from the
 * server. After ONE model is saved only that model's boxes are refilled:
 * figures the admin typed on another card and has not saved yet are kept,
 * not silently replaced by the stored values.
 */
export function draftsAfterLoad(
  prev: Record<string, Record<string, string>>,
  models: Array<Record<string, unknown> & { id: string }>,
  fields: Array<{ column: string }>,
  savedId?: string
): Record<string, Record<string, string>> {
  const fromServer = (m: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f.column, text(m[f.column])]));
  return Object.fromEntries(
    models.map((m) => [m.id, savedId === undefined || m.id === savedId || !prev[m.id] ? fromServer(m) : prev[m.id]])
  );
}

export default function PrinterModelsEditor({ t }: { t: T }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadErr, setLoadErr] = useState('');
  /** Per model: the boxes as typed (strings, so "" and "0." are reachable). */
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState('');
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async (savedId?: string) => {
    const res = await api.get<ListResponse & { success: boolean }>('/api/admin/print-quote/printer-models');
    setData(res);
    setDrafts((prev) => draftsAfterLoad(prev, res.models, res.fields, savedId));
  }, []);

  useEffect(() => {
    load().catch((e: unknown) => setLoadErr(e instanceof ApiError ? e.message : t('تعذّر التحميل', 'Could not load')));
    // `t` only changes the error's language; reloading would drop typed figures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  /** How many printers share each group — the honest summary at the top. */
  const summary = useMemo(() => {
    if (!data) return null;
    const fdm = data.models.filter((m) => m.technology === 'fdm' && m.active);
    const groups = new Map<string, string[]>();
    for (const m of fdm) groups.set(m.price_group, [...(groups.get(m.price_group) ?? []), m.model]);
    const unpriced = fdm.filter((m) => m.purchase_iqd === null || m.useful_print_hours === null).length;
    const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    return { total: fdm.length, groups: groups.size, unpriced, largest };
  }, [data]);

  const changedFields = (m: ModelRow): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    if (!data) return out;
    for (const f of data.fields) {
      const typed = (drafts[m.id]?.[f.column] ?? '').trim();
      if (typed === text(m[f.column])) continue;
      out[f.column] = typed === '' ? null : Number(typed);
    }
    return out;
  };

  const save = async (m: ModelRow) => {
    const body = changedFields(m);
    if (!Object.keys(body).length) return;
    setSaving(m.id);
    try {
      await api.patch(`/api/admin/print-quote/printer-models/${encodeURIComponent(m.id)}`, body);
      await load(m.id);
      setNotes((n) => ({ ...n, [m.id]: { ok: true, text: t('حُفظ — يُستخدم في التسعيرة التالية', 'Saved — used by the next quote') } }));
    } catch (e) {
      // The server's sentence names the field and its bounds; shown as it came.
      setNotes((n) => ({ ...n, [m.id]: { ok: false, text: e instanceof ApiError ? e.message : t('تعذّر الحفظ', 'Could not save') } }));
    } finally {
      setSaving('');
    }
  };

  if (loadErr) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-red-300 text-[12.5px]">{loadErr}</div>
    );
  }
  if (!data || !summary) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-printer-models-editor>
      <div className="rounded-2xl border border-gold/25 bg-gold/[0.06] p-3 space-y-1.5">
        <p className="text-gold text-[12.5px] font-bold">{t('لماذا لا يتغيّر السعر بين بعض الطابعات', 'Why some printers quote alike')}</p>
        <p className="text-zinc-300 text-[11.5px] leading-relaxed">
          {t(
            `من ${summary.total} طابعة FDM، ${summary.unpriced} بلا سعر شراء أو ساعات مسجّلة، فتُحسب ساعتها بأجرة المنصة الواحدة (${dinars(data.platform_machine_hour_iqd.fdm)} د.ع). لذلك تنقسم الطابعات إلى ${summary.groups} مجموعات فقط، وطابعات المجموعة الواحدة تُسعّر القطعة الواحدة بالسعر نفسه. أكبر مجموعة: ${summary.largest.join('، ')}. أدخل ما دفعته فعلًا لكل طراز وكم ساعة تتوقع أن يطبع، فيصبح سعره خاصًا به.`,
            `Of ${summary.total} FDM printers, ${summary.unpriced} have no purchase price or hours recorded, so their hour is billed at the one platform rate (${dinars(data.platform_machine_hour_iqd.fdm)} IQD). So the printers fall into only ${summary.groups} groups, and every printer in a group prices one piece identically. The largest group: ${summary.largest.join(', ')}. Enter what you actually paid for each model and the hours you expect from it, and its price becomes its own.`
          )}
        </p>
        <p className="text-zinc-500 text-[11px] leading-relaxed">
          {t(
            'الخانة الفارغة تعني «غير مسجّل». لا يُستخدم أي رقم لم تكتبه أنت، وكل حفظ يُسجَّل في سجل التدقيق.',
            'An empty box means “not recorded”. No figure you did not type is used, and every save is written to the audit log.'
          )}
        </p>
      </div>

      {data.models.map((m) => {
        const dirty = Object.keys(changedFields(m)).length > 0;
        const note = notes[m.id];
        return (
          <section key={m.id} className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4" data-printer-model={m.id}>
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="min-w-0">
                <h3 className="text-white font-bold text-[13.5px] flex items-center gap-2 min-w-0">
                  <Printer className="w-4 h-4 text-gold shrink-0" aria-hidden />
                  <span className="truncate" dir="ltr">
                    {m.manufacturer} {m.model}
                  </span>
                </h3>
                <p className="text-zinc-500 text-[11px] mt-0.5">
                  {m.machine_iqd_per_hour > 0
                    ? t(`استهلاك الساعة: ${dinars(m.machine_iqd_per_hour)} د.ع`, `Depreciation: ${dinars(m.machine_iqd_per_hour)} IQD/h`)
                    : t('يُحسب بأجرة ساعة المنصة', 'Billed at the platform machine-hour rate')}
                </p>
              </div>
              <span
                className="shrink-0 rounded-full border border-zinc-700 px-2 py-0.5 text-[10.5px] text-zinc-400"
                title={t('الطابعات بالرمز نفسه تُسعَّر القطعة الواحدة بالسعر نفسه', 'Printers with the same label price one piece identically')}
                dir="ltr"
              >
                {m.price_group}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {data.fields.map((f) => {
                const meta = META[f.column];
                return (
                  <label key={f.column} className="block min-w-0">
                    <span className="block text-zinc-400 text-[11.5px] font-semibold mb-1 truncate">
                      {meta ? t(meta.ar, meta.en) : f.column}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <input
                        type="number"
                        inputMode="decimal"
                        dir="ltr"
                        min={f.min}
                        max={f.max}
                        step={f.integer ? 1 : 0.01}
                        value={drafts[m.id]?.[f.column] ?? ''}
                        placeholder={f.nullable ? t('غير مسجّل', 'not recorded') : ''}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [m.id]: { ...(d[m.id] ?? {}), [f.column]: e.target.value } }))
                        }
                        data-printer-field={f.column}
                        className="min-w-0 flex-1 min-h-[44px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 px-3 text-white text-[13px] outline-none focus:border-gold/40"
                      />
                      {meta && <span className="text-zinc-500 text-[10.5px] shrink-0">{t(meta.unit[0], meta.unit[1])}</span>}
                    </span>
                    {meta?.hint && <span className="block text-zinc-600 text-[10px] mt-1 leading-relaxed">{t(meta.hint[0], meta.hint[1])}</span>}
                  </label>
                );
              })}
            </div>

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <button
                type="button"
                disabled={!dirty || saving === m.id}
                onClick={() => void save(m)}
                className="inline-flex items-center gap-1.5 px-4 min-h-[44px] rounded-2xl bg-gold text-black text-[12.5px] font-bold disabled:opacity-40"
                data-printer-save={m.id}
              >
                {saving === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t('حفظ', 'Save')}
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((d) => ({
                      ...d,
                      [m.id]: Object.fromEntries(data.fields.map((f) => [f.column, text(m[f.column])])),
                    }))
                  }
                  className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-2xl bg-zinc-800 text-zinc-300 text-[12.5px]"
                >
                  <RotateCcw className="w-4 h-4" />
                  {t('تراجع', 'Undo')}
                </button>
              )}
              {note && (
                <span
                  role={note.ok ? 'status' : 'alert'}
                  className={`inline-flex items-center gap-1.5 text-[11.5px] ${note.ok ? 'text-emerald-300' : 'text-red-300'}`}
                >
                  {note.ok ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                  {note.text}
                </span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
