/**
 * «في تسعير الطباعة… يستطيع المستخدم أو التاجر وضع عدد الغرامات مثلا مئة غرام
 *  من فيلمنت معين بلون واحد أو أكثر ليحسب السعر، أو من الملف».
 *
 * THE QUESTION THIS SCREEN ANSWERS. The file calculator next to it is built on
 * the idea that the model says everything, and for somebody holding an STL it
 * does. But the question a shop is actually asked at the counter is «شكد يطلع
 * سعر مئة غرام PLA أسود؟», and answering it by demanding a file the customer
 * does not have is how they go and ask somewhere else.
 *
 * THE TWO THINGS THAT COULD GO WRONG HERE, AND WHAT STOPS THEM:
 *
 *  1. A SECOND PRICE. It is one line of code to multiply grams by a rate in a
 *     component, and the moment that line exists the shop has two prices for
 *     one job — the one the customer was shown and the one the merchant
 *     charges. So there is NO arithmetic on money in this file. Every figure
 *     rendered came from `priceJob` through /api/print-quote/grams-quote, the
 *     same engine and the same minimum the uploaded-file path goes through;
 *     tests/printQuoteGrams.test.ts pins the two together to the dinar.
 *
 *  2. A HALF PRICE PRESENTED AS A WHOLE ONE. A file yields a print TIME; a
 *     weight does not, and machine hours are real money. Nothing here guesses
 *     an hour count from a gram count — the customer is ASKED, plainly, and if
 *     they do not know then the answer says on its face that it covers material
 *     and handling and not machine time. That sentence is not a footnote: it
 *     sits under the price, in the customer's own language, every time.
 *
 * LANGUAGE. `loc(ar, en, ckb)` everywhere, never `dir === 'rtl' ? ar : en` —
 * Sorani is right-to-left too, and that idiom serves Arabic to every Kurdish
 * reader while looking correct. Spacing is logical (ms-/me-/ps-/pe-) so the
 * layout mirrors itself rather than being written twice.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Plus, Scale, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { failureText, formatIqd } from '../../lib/api';
import { quoteByGrams, type GramsQuoteResponse } from './gramsQuoteApi';

/** Only what this panel reads. Structural, so the page's richer catalogue
 *  objects pass straight in without this file importing their module. */
export interface GramsPrinterOption {
  id: string;
  manufacturer: string;
  model: string;
  materials: string[];
}
export interface GramsFilamentOption {
  id: string;
  material_type: string;
  name: string;
  name_ar: string | null;
}

interface FormRow {
  /** Stable across re-orders, so removing the first row does not make React
   *  re-key every colour swatch below it into the wrong input. */
  key: string;
  materialId: string;
  colorHex: string;
  /** Kept as the RAW STRING the customer typed. A number state would turn an
   *  empty box into 0 and a half-typed "1." into 1, and the server's refusal of
   *  a zero gram count is only reachable if the box can actually be empty. */
  grams: string;
}

const MAX_ROWS = 8;
const newRow = (materialId: string, colorHex = '#D9D9D9'): FormRow => ({
  key: `r${Math.random().toString(36).slice(2, 9)}`,
  materialId,
  colorHex,
  grams: '',
});

export default function GramsQuotePanel({
  printers,
  materials,
}: {
  printers: GramsPrinterOption[];
  materials: GramsFilamentOption[];
}) {
  const { loc } = useLanguage();

  const [printerId, setPrinterId] = useState('');
  const [rows, setRows] = useState<FormRow[]>([]);
  /** An explicit question with an explicit answer. There is no third state
   *  where the screen quietly decides for the customer. */
  const [knowsTime, setKnowsTime] = useState(false);
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GramsQuoteResponse | null>(null);

  const printer = printers.find((p) => p.id === printerId) ?? printers[0] ?? null;

  /**
   * Only the filaments this machine can run. A printer that cannot take ABS is
   * not a cheaper way to print ABS — offering it produces a price for a job
   * nobody can deliver, which the Worker would refuse anyway.
   */
  const usable = useMemo(() => {
    if (!printer) return materials;
    const allowed = new Set(printer.materials.map((t) => t.toUpperCase()));
    const fits = materials.filter((m) => allowed.has(m.material_type.toUpperCase()));
    return fits.length ? fits : materials;
  }, [materials, printer]);

  const defaultMaterialId = usable.find((m) => m.material_type.toUpperCase() === 'PLA')?.id ?? usable[0]?.id ?? '';

  /**
   * The form always shows one row, even before anything is in state.
   *
   * Memoised rather than rebuilt inline because `newRow` mints a random key: an
   * inline expression would hand every render a NEW key, React would throw the
   * `<input>` away and remount it on each keystroke, and the grams box would
   * lose focus after every character typed into it.
   */
  const effectiveRows = useMemo(
    () => (rows.length ? rows : defaultMaterialId ? [newRow(defaultMaterialId)] : []),
    [rows, defaultMaterialId]
  );

  /**
   * A printer change can strip a material out from under a row that already
   * names it — pick an A1 mini after choosing ABS and the select would sit on a
   * value that is no longer one of its options, showing a blank box and posting
   * a combination the Worker refuses. Repairing the row is the honest fix: the
   * machine genuinely cannot run it, so the choice has to change.
   */
  useEffect(() => {
    if (!rows.length || !defaultMaterialId) return;
    const allowed = new Set(usable.map((m) => m.id));
    if (rows.every((r) => allowed.has(r.materialId))) return;
    setRows((current) => current.map((r) => (allowed.has(r.materialId) ? r : { ...r, materialId: defaultMaterialId })));
    setResult(null);
  }, [usable, rows, defaultMaterialId]);

  /** Any change to the inputs invalidates the answer — a price that stays on
   *  screen describing the previous question is worse than no price. */
  const invalidate = useCallback(() => {
    setResult(null);
    setError('');
  }, []);

  const patchRow = (key: string, patch: Partial<FormRow>) => {
    setRows((current) => (current.length ? current : effectiveRows).map((r) => (r.key === key ? { ...r, ...patch } : r)));
    invalidate();
  };

  const addRow = () => {
    setRows((current) => {
      const base = current.length ? current : effectiveRows;
      return base.length >= MAX_ROWS ? base : [...base, newRow(defaultMaterialId)];
    });
    invalidate();
  };

  const removeRow = (key: string) => {
    setRows((current) => {
      const base = current.length ? current : effectiveRows;
      return base.length <= 1 ? base : base.filter((r) => r.key !== key);
    });
    invalidate();
  };

  const filled = effectiveRows.filter((r) => r.materialId && Number(r.grams) > 0);
  const canSubmit = !!printer && filled.length > 0 && !busy;

  const submit = useCallback(async () => {
    if (!printer) return;
    const ready = effectiveRows.filter((r) => r.materialId && Number(r.grams) > 0);
    if (!ready.length) {
      setError(
        loc(
          'اكتب عدد الغرامات لكل فيلمنت — رقم أكبر من صفر.',
          'Enter the grams for each filament — a number greater than zero.',
          'ژمارەی گرامەکان بۆ هەر فیلمەنتێک بنووسە — ژمارەیەک گەورەتر لە سفر.'
        )
      );
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      // Hours and minutes are TIME, not money: turning "2 h 30" into 150 is
      // presentation. The rule this file obeys is that no PRICE is computed
      // here, and the server is the only thing that turns minutes into dinars.
      const stated = knowsTime ? Math.round((Number(hours) || 0) * 60 + (Number(minutes) || 0)) : 0;
      const answer = await quoteByGrams({
        printer_model_id: printer.id,
        rows: ready.map((r) => ({ material_id: r.materialId, grams: Number(r.grams), color_hex: r.colorHex })),
        print_minutes: stated > 0 ? stated : 0,
      });
      setResult(answer);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? '';
      setError(refusalText(code, loc) || failureText(e, loc('تعذّر الحساب.', 'Could not work it out.', 'نەتوانرا بژمێردرێت.')));
    } finally {
      setBusy(false);
    }
  }, [printer, effectiveRows, knowsTime, hours, minutes, loc]);

  const t = {
    lead: loc(
      'تعرف كم غرام تحتاج؟ اكتب الوزن واللون — أو أكثر من لون — ونعطيك تقديرًا بدون ملف.',
      'Know how many grams you need? Enter the weight and the colour — or more than one — and get an estimate with no file.',
      'دەزانیت چەند گرامت پێویستە؟ کێش و ڕەنگ بنووسە — یان زیاتر لە ڕەنگێک — بێ فایل خەمڵاندنت بۆ دەکەین.'
    ),
    printer: loc('الطابعة', 'Printer', 'چاپکەر'),
    filaments: loc('الفلامنت والغرامات', 'Filament and grams', 'فیلامێنت و گرامەکان'),
    material: loc('المادة', 'Material', 'ماددە'),
    colour: loc('اللون', 'Colour', 'ڕەنگ'),
    grams: loc('الغرامات', 'Grams', 'گرام'),
    addColour: loc('أضف لونًا آخر', 'Add another colour', 'ڕەنگێکی تر زیاد بکە'),
    remove: loc('احذف السطر', 'Remove row', 'ڕیزەکە بسڕەوە'),
    timeQuestion: loc(
      'هل تعرف كم ساعة ستستغرق الطباعة؟',
      'Do you know how long the print will take?',
      'دەزانیت چاپکردنەکە چەند کاتژمێر دەخایەنێت؟'
    ),
    timeYes: loc('أعرف تقريبًا', 'Roughly, yes', 'بە نزیکەیی بەڵێ'),
    timeNo: loc('لا أعرف', 'No', 'نەخێر'),
    hours: loc('ساعة', 'Hours', 'کاتژمێر'),
    minutesLabel: loc('دقيقة', 'Minutes', 'خولەک'),
    timeWhy: loc(
      'الوزن يخبرنا بكلفة المادة فقط. ساعات المكينة كلفة حقيقية أيضًا — إن لم تعرفها، سنحسب لك المادة والمناولة ونقول ذلك بوضوح.',
      'A weight tells us the material cost only. Machine hours are a real cost too — if you do not know them, we price the material and the handling and say so plainly.',
      'کێش تەنها تێچووی ماددەمان پێدەڵێت. کاتژمێرەکانی ئامێریش تێچووی ڕاستەقینەن — ئەگەر نایانزانیت، ماددە و دەستکاری دەژمێرین و بە ڕوونی دەیڵێین.'
    ),
    calculate: loc('احسب السعر', 'Calculate', 'نرخ بژمێرە'),
    working: loc('يجري الحساب…', 'Working it out…', 'ژمێرین…'),
    price: loc('السعر التقديري', 'Estimated price', 'نرخی خەمڵێنراو'),
    range: loc('النطاق المتوقع', 'Expected range', 'مەودای چاوەڕوانکراو'),
    badge: loc('تقدير — ليس عرض سعر نهائيًا', 'Estimate — not a final quote', 'خەمڵاندن — نرخی کۆتایی نییە'),
    totalWeight: loc('الوزن المحسوب', 'Weight priced', 'کێشی ژمێردراو'),
    machineHours: loc('ساعات المكينة', 'Machine hours', 'کاتژمێری ئامێر'),
    includes: loc('يشمل هذا السعر', 'This price includes', 'ئەم نرخە لەخۆدەگرێت'),
    excludes: loc('لا يشمل', 'It does not include', 'لەخۆی ناگرێت'),
    materialOnly: loc(
      'لم تُحدَّد مدة الطباعة، فهذا السعر يغطي المادة والمناولة فقط — ساعات المكينة والكهرباء غير محسوبة.',
      'No print time was given, so this price covers material and handling only — machine hours and electricity are not in it.',
      'ماوەی چاپ دیارینەکراوە، بۆیە ئەم نرخە تەنها ماددە و دەستکاری دەگرێتەوە — کاتژمێری ئامێر و کارەبا تێیدا نین.'
    ),
    insufficient: loc(
      'لا يمكن تسعير هذه المادة بعد: لم يُسجَّل سعر الكيلو لها. جرّب مادة أخرى أو أرسل طلبًا وسيسعّره التاجر.',
      'This material cannot be priced yet: no price per kilo is on file. Try another material, or send a request and a merchant will price it.',
      'ئەم ماددەیە هێشتا ناژمێردرێت: نرخی کیلۆی تۆمار نەکراوە. ماددەیەکی تر تاقی بکەرەوە، یان داواکاری بنێرە.'
    ),
  };

  return (
    <div className="space-y-5" data-grams-quote>
      <p className="text-zinc-400 text-[13px] leading-relaxed">{t.lead}</p>

      {/* ------------------------------------------------------ the machine */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800/70">
        <div className="px-4 py-3 flex items-center justify-between gap-3 min-h-[3.25rem]">
          <label htmlFor="grams-printer" className="text-zinc-400 text-[13px] leading-snug shrink-0">
            {t.printer}
          </label>
          <select
            id="grams-printer"
            value={printer?.id ?? ''}
            disabled={busy || !printers.length}
            onChange={(e) => {
              setPrinterId(e.target.value);
              invalidate();
            }}
            className="max-w-[16rem] bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-[13px] leading-snug focus:outline-none focus:border-[#BAA369] disabled:opacity-40 transition-colors truncate"
          >
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.manufacturer} {p.model}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* -------------------------------------------- the rows: «بلون واحد أو أكثر» */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden">
        <h3 className="px-4 py-3 text-[11px] leading-snug font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800/70 flex items-center gap-2">
          <Scale className="w-3.5 h-3.5" aria-hidden />
          {t.filaments}
        </h3>

        <ul className="divide-y divide-zinc-800/70">
          {effectiveRows.map((r, index) => (
            <li key={r.key} className="p-4 space-y-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label htmlFor={`grams-material-${r.key}`} className="block text-zinc-500 text-[11px] leading-snug mb-1">
                    {t.material}
                  </label>
                  <select
                    id={`grams-material-${r.key}`}
                    value={r.materialId}
                    disabled={busy}
                    onChange={(e) => patchRow(r.key, { materialId: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-[13px] leading-snug focus:outline-none focus:border-[#BAA369] disabled:opacity-40 transition-colors truncate"
                  >
                    {usable.map((m) => (
                      <option key={m.id} value={m.id}>
                        {loc(m.name_ar || m.name, m.name, m.name_ar || m.name) || m.material_type}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="shrink-0">
                  <label htmlFor={`grams-colour-${r.key}`} className="block text-zinc-500 text-[11px] leading-snug mb-1">
                    {t.colour}
                  </label>
                  <input
                    id={`grams-colour-${r.key}`}
                    type="color"
                    value={r.colorHex}
                    disabled={busy}
                    onChange={(e) => patchRow(r.key, { colorHex: e.target.value })}
                    className="h-[42px] w-12 rounded-xl bg-zinc-900 border border-zinc-800 p-1 disabled:opacity-40 cursor-pointer"
                  />
                </div>

                {effectiveRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(r.key)}
                    disabled={busy}
                    aria-label={t.remove}
                    className="h-[42px] w-11 shrink-0 grid place-items-center rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-[#e4899a] hover:border-[#B03142]/40 disabled:opacity-30 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </button>
                )}
              </div>

              <div>
                <label htmlFor={`grams-weight-${r.key}`} className="block text-zinc-500 text-[11px] leading-snug mb-1">
                  {t.grams}
                </label>
                <div className="relative">
                  <input
                    id={`grams-weight-${r.key}`}
                    type="number"
                    inputMode="decimal"
                    min={1}
                    step={1}
                    dir="ltr"
                    autoComplete="off"
                    placeholder={index === 0 ? '100' : ''}
                    value={r.grams}
                    disabled={busy}
                    onChange={(e) => patchRow(r.key, { grams: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 pe-12 text-white text-[14px] leading-snug tabular-nums focus:outline-none focus:border-[#BAA369] disabled:opacity-40 transition-colors"
                  />
                  <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-zinc-500 text-[12px] leading-snug">
                    g
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>

        {effectiveRows.length < MAX_ROWS && (
          <button
            type="button"
            onClick={addRow}
            disabled={busy}
            className="w-full px-4 py-3 border-t border-zinc-800/70 text-[13px] leading-snug text-[#BAA369] flex items-center justify-center gap-2 hover:bg-zinc-900/60 disabled:opacity-40 transition-colors"
          >
            <Plus className="w-4 h-4" aria-hidden />
            {t.addColour}
          </button>
        )}
      </section>

      {/* ------------------------------- the one thing a weight cannot tell us */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
        <p className="text-zinc-300 text-[13px] leading-relaxed">{t.timeQuestion}</p>
        <div role="group" className="inline-flex bg-zinc-900 border border-zinc-800 rounded-xl p-0.5 gap-0.5">
          {[
            { value: true, label: t.timeYes },
            { value: false, label: t.timeNo },
          ].map((o) => (
            <button
              key={String(o.value)}
              type="button"
              disabled={busy}
              aria-pressed={knowsTime === o.value}
              onClick={() => {
                setKnowsTime(o.value);
                invalidate();
              }}
              className={`px-3 py-1.5 rounded-[0.6rem] text-[12px] leading-snug transition-colors disabled:opacity-40 ${
                knowsTime === o.value ? 'bg-zinc-800 text-white font-medium shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {knowsTime && (
          <div className="flex items-end gap-2" dir="ltr">
            <div className="flex-1">
              <label htmlFor="grams-hours" className="block text-zinc-500 text-[11px] leading-snug mb-1">
                {t.hours}
              </label>
              <input
                id="grams-hours"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                autoComplete="off"
                placeholder="4"
                value={hours}
                disabled={busy}
                onChange={(e) => {
                  setHours(e.target.value);
                  invalidate();
                }}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-[14px] leading-snug tabular-nums focus:outline-none focus:border-[#BAA369] disabled:opacity-40 transition-colors"
              />
            </div>
            <div className="flex-1">
              <label htmlFor="grams-minutes" className="block text-zinc-500 text-[11px] leading-snug mb-1">
                {t.minutesLabel}
              </label>
              <input
                id="grams-minutes"
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                step={5}
                autoComplete="off"
                placeholder="30"
                value={minutes}
                disabled={busy}
                onChange={(e) => {
                  setMinutes(e.target.value);
                  invalidate();
                }}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-[14px] leading-snug tabular-nums focus:outline-none focus:border-[#BAA369] disabled:opacity-40 transition-colors"
              />
            </div>
          </div>
        )}

        <p className="text-zinc-500 text-[11px] leading-relaxed">{t.timeWhy}</p>
      </section>

      {error && (
        <p role="alert" className="text-[12px] leading-relaxed rounded-2xl p-3.5 border flex items-start gap-2 text-[#e4899a] bg-[#B03142]/10 border-[#B03142]/40">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="w-full h-12 rounded-2xl bg-[#BAA369] text-black font-semibold text-[15px] leading-snug flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.99] transition-transform"
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            {t.working}
          </>
        ) : (
          <>
            <Scale className="w-4 h-4" aria-hidden />
            {t.calculate}
          </>
        )}
      </button>

      {/* ------------------------------------------------------- the answer */}
      {result && result.quote.confidence === 'insufficient' && (
        <p role="alert" className="text-[12px] leading-relaxed rounded-2xl p-3.5 border flex items-start gap-2 text-amber-300/90 bg-amber-500/10 border-amber-500/25">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
          <span>{t.insufficient}</span>
        </p>
      )}

      {result && result.quote.confidence !== 'insufficient' && (
        <section className="rounded-2xl border border-[#BAA369]/30 bg-gradient-to-b from-[#BAA369]/[0.07] to-transparent p-5">
          <p className="text-[11px] leading-snug font-semibold uppercase tracking-wider text-zinc-500">{t.price}</p>
          <p className="text-white font-bold text-[30px] leading-tight mt-1 tabular-nums" dir="ltr" data-grams-price>
            {formatIqd(result.quote.price_iqd)}
          </p>
          {result.quote.range_iqd.high > result.quote.range_iqd.low && (
            <p className="text-zinc-400 text-[12px] leading-snug mt-1 tabular-nums" dir="ltr">
              {t.range}: {formatIqd(result.quote.range_iqd.low)} – {formatIqd(result.quote.range_iqd.high)}
            </p>
          )}

          <p className="inline-flex items-center gap-1.5 mt-3 text-[11px] leading-snug rounded-full px-2.5 py-1 border text-amber-300 border-amber-500/30 bg-amber-500/10">
            <AlertCircle className="w-3 h-3" aria-hidden />
            {t.badge}
          </p>

          <dl className="grid grid-cols-2 gap-px bg-zinc-800/70 rounded-xl overflow-hidden mt-4">
            <div className="bg-zinc-950 px-4 py-3">
              <dt className="text-zinc-500 text-[10px] leading-snug uppercase tracking-wider">{t.totalWeight}</dt>
              <dd className="text-white text-[13px] leading-snug font-medium mt-0.5 tabular-nums" dir="ltr">
                {result.grams_total} g
              </dd>
            </div>
            <div className="bg-zinc-950 px-4 py-3">
              <dt className="text-zinc-500 text-[10px] leading-snug uppercase tracking-wider">{t.machineHours}</dt>
              <dd className="text-white text-[13px] leading-snug font-medium mt-0.5 tabular-nums" dir="ltr">
                {result.covers.material_only ? '—' : result.quote.machine_hours}
              </dd>
            </div>
          </dl>

          {/*
            THE SENTENCE THAT MAKES THIS SCREEN HONEST. A grams quote with no
            stated print time is a MATERIAL bill, and a customer who is not told
            that will read it as the whole price and think the merchant's real
            offer is a rip-off. It is placed above the itemised lists, not below
            them, because it is the part that changes what the number means.
          */}
          {result.covers.material_only && (
            <p className="mt-4 text-[12px] leading-relaxed text-amber-200/90 bg-amber-500/10 border border-amber-500/25 rounded-xl p-3">
              {t.materialOnly}
            </p>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <CoverList title={t.includes} tone="in" codes={result.covers.included} />
            <CoverList title={t.excludes} tone="out" codes={result.covers.excluded} />
          </div>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- pieces

/** The coverage codes, said in the reader's language. An unknown code falls
 *  back to itself rather than disappearing: a silently dropped exclusion is the
 *  same failure as never having sent one. */
function CoverList({ title, tone, codes }: { title: string; tone: 'in' | 'out'; codes: string[] }) {
  const { loc } = useLanguage();
  if (!codes.length) return null;
  const label = (code: string): string => {
    switch (code) {
      case 'MATERIAL':
        return loc('المادة (الفلامنت)', 'Material (filament)', 'ماددە (فیلامێنت)');
      case 'HANDLING_LABOUR':
        return loc('التحضير والمناولة', 'Setup and handling', 'ئامادەکاری و دەستکاری');
      case 'FAILURE_RESERVE':
        return loc('احتياط فشل الطباعة', 'Allowance for failed prints', 'پاشەکەوت بۆ چاپی سەرنەکەوتوو');
      case 'MACHINE_TIME':
        return loc('ساعات المكينة', 'Machine hours', 'کاتژمێری ئامێر');
      case 'ELECTRICITY':
        return loc('الكهرباء', 'Electricity', 'کارەبا');
      case 'SUPPORT_MATERIAL':
        return loc('مادة الدعامات', 'Support material', 'ماددەی پاڵپشت');
      case 'PURGE_ON_COLOR_CHANGE':
        return loc('الهدر عند تبديل اللون', 'Filament flushed on colour changes', 'بەفیڕۆدان لە گۆڕینی ڕەنگ');
      case 'FINISHING':
        return loc('الصنفرة والطلاء', 'Sanding and painting', 'سمبادە و بۆیە');
      case 'DELIVERY':
        return loc('التوصيل', 'Delivery', 'گەیاندن');
      default:
        return code;
    }
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
      <p className="text-zinc-500 text-[10px] leading-snug uppercase tracking-wider mb-2">{title}</p>
      <ul className="space-y-1">
        {codes.map((code) => (
          <li
            key={code}
            className={`text-[12px] leading-relaxed flex items-start gap-1.5 ${
              tone === 'in' ? 'text-zinc-300' : 'text-zinc-500'
            }`}
          >
            <span aria-hidden className="mt-px shrink-0">
              {tone === 'in' ? '✓' : '—'}
            </span>
            <span>{label(code)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The server's refusal codes, turned into the one sentence a customer can act
 * on. An empty string means "no specific wording", and the caller falls back to
 * the server's own message rather than swallowing the failure.
 */
function refusalText(code: string, loc: (ar: string, en: string, ckb?: string) => string): string {
  switch (code) {
    case 'BAD_GRAMS':
      return loc(
        'اكتب عدد الغرامات لكل فيلمنت — رقم أكبر من صفر.',
        'Enter the grams for each filament — a number greater than zero.',
        'ژمارەی گرامەکان بۆ هەر فیلمەنتێک بنووسە — ژمارەیەک گەورەتر لە سفر.'
      );
    case 'NO_GRAM_ROWS':
      return loc(
        'أضف فيلمنتًا واحدًا على الأقل مع وزنه.',
        'Add at least one filament with its weight.',
        'لانیکەم یەک فیلمەنت لەگەڵ کێشەکەی زیاد بکە.'
      );
    case 'TOO_MANY_GRAM_ROWS':
      return loc(
        'هذا أكثر من عدد الألوان الذي نحسبه في طلب واحد.',
        'That is more colours than one quote takes.',
        'ئەمە زیاترە لە ژمارەی ڕەنگەکان کە لە یەک داواکاریدا دەژمێرین.'
      );
    case 'GRAMS_TOO_LARGE':
      return loc(
        'هذا الوزن أكبر من طلب طباعة واحد — قسّمه أو تواصل مع تاجر مباشرة.',
        'That weight is more than one print job — split it or talk to a merchant directly.',
        'ئەم کێشە زیاترە لە یەک داواکاری چاپ — دابەشی بکە یان ڕاستەوخۆ لەگەڵ بازرگانێک بدوێ.'
      );
    case 'UNKNOWN_MATERIAL':
    case 'MATERIAL_NOT_WEIGHABLE':
      return loc(
        'هذه المادة غير مسجّلة بكثافتها، فلا يمكن تحويل الغرامات إلى سعر. اختر مادة أخرى.',
        'That material has no density on file, so grams cannot become a price. Pick another material.',
        'ئەم ماددەیە چڕی تۆمارکراوی نییە، بۆیە گرام ناتوانرێت ببێتە نرخ. ماددەیەکی تر هەڵبژێرە.'
      );
    case 'PRINTER_INELIGIBLE':
      return loc(
        'هذه الطابعة لا تستطيع طباعة هذه المواد معًا. اختر طابعة أخرى أو قلّل الألوان.',
        'This printer cannot run these materials together. Pick another printer or fewer colours.',
        'ئەم چاپکەرە ناتوانێت ئەم ماددانە پێکەوە بەکاربهێنێت. چاپکەرێکی تر هەڵبژێرە یان ڕەنگ کەم بکەرەوە.'
      );
    case 'UNKNOWN_PRINTER':
      return loc('اختر طابعة من القائمة.', 'Choose a printer from the list.', 'چاپکەرێک لە لیستەکە هەڵبژێرە.');
    default:
      return '';
  }
}
