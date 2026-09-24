/**
 * «تسعير الطباعة» — what a job actually COSTS this shop, and on which machine.
 *
 * THIS IS THE SCREEN THE CUSTOMER MUST NEVER SEE (§22). The customer's quote
 * carries a price and a range and nothing else; this one carries purchase-cost
 * depreciation, the internal failure reserve, the overhead and the margin. The
 * two are different SHAPES built by different functions on the Worker
 * (`publicQuote` vs `merchantQuote`), not one payload with a flag — so no
 * future edit can leak a cost line by forgetting a check. What this component
 * renders is whatever the merchant endpoint returned; it computes no money of
 * its own.
 *
 * WHY A COMPARISON AND NOT A RECOMMENDATION (§25, §41). A shop with four
 * machines wants to know which one to put the job on, and "the A1 mini" is not
 * an answer they can argue with. So every printer is listed with its own cost,
 * hours, waste and margin, and a machine that cannot take the job is shown
 * WITH the reasons rather than silently dropped — a missing printer is a
 * question, and answering it is the difference between a table and an oracle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Box, ChevronDown, FileUp, Loader2, Printer, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, failureText, formatIqd } from '../../../lib/api';
import {
  formatDuration,
  formatGrams,
  loadMaterials,
  loadPrinters,
  measureModel,
  uploadModel,
  type AnalysisView,
  type QuoteMaterial,
  type QuotePrinter,
} from '../../../lib/printQuote';
import { Btn, Card, Empty, Notice, Spinner } from './ui';

/** One cost component, exactly as the engine emitted it. */
interface CostLineView {
  component: string;
  iqd: number;
  from: 'measured' | 'profile' | 'merchant' | 'platform' | 'inferred';
  detail?: string;
}

interface PrinterRow {
  merchant_printer_id: string;
  name: string;
  model: string;
  eligible: boolean;
  unlinked?: boolean;
  availability?: string;
  reasons?: string[];
  confidence?: 'exact' | 'estimated' | 'insufficient';
  lines?: CostLineView[];
  base_cost_iqd?: number;
  failure_reserve_iqd?: number;
  true_cost_iqd?: number;
  price_iqd?: number;
  profit_iqd?: number;
  margin_percent?: number;
  markup_percent?: number;
  break_even_iqd?: number;
  range_iqd?: { low: number; high: number };
  waste_grams?: number;
  waste_percent?: number;
  machine_hours?: number;
  because?: {
    plates: number;
    machine_hours: number;
    waste_grams: number;
    change_seconds: number;
    machine_iqd_per_hour: number;
  };
}

/** The component vocabulary, in the merchant's language. */
const COMPONENT_LABEL: Record<string, [string, string]> = {
  MODEL_MATERIAL: ['مادة القطعة', 'Part material'],
  SUPPORT_MATERIAL: ['مادة الدعامات', 'Support material'],
  SUPPORT_INTERFACE: ['طبقة التماس', 'Support interface'],
  PURGE: ['الهدر عند تبديل اللون', 'Purge'],
  PRIME_TOWER: ['برج التهيئة', 'Prime tower'],
  BRIM_RAFT: ['الحافة والقاعدة', 'Brim / raft'],
  OTHER_WASTE: ['هدر آخر', 'Other waste'],
  ELECTRICITY: ['الكهرباء', 'Electricity'],
  DEPRECIATION: ['إهلاك الجهاز', 'Depreciation'],
  MAINTENANCE: ['الصيانة', 'Maintenance'],
  LABOR: ['العمل', 'Labour'],
  POST_PROCESSING: ['التشطيب', 'Post-processing'],
  PACKAGING: ['التغليف', 'Packaging'],
  OVERHEAD: ['مصاريف عامة', 'Overhead'],
  PLATFORM_FEES: ['عمولة المنصة', 'Platform fee'],
  FAILURE_RESERVE: ['احتياطي الفشل', 'Failure reserve'],
};

/** Where a number came from, said in one word (§44). */
const PROVENANCE_LABEL: Record<string, [string, string]> = {
  measured: ['مقاس', 'measured'],
  profile: ['من المواصفات', 'profile'],
  merchant: ['من متجرك', 'yours'],
  platform: ['افتراضي', 'platform'],
  inferred: ['مستنتج', 'inferred'],
};

/**
 * Why a machine cannot take the job, in the merchant's language.
 *
 * KEYED ON THE CODES THE SERVER SENDS (audit 03 §10 Z). `printerEligibility`
 * (worker/lib/printQuote/printers.ts) answers `build_volume`, `material:<id>`,
 * `materials_at_once`, `enclosure`, `hardened_nozzle` and `nozzle`; this table
 * used to be keyed on names nothing ever sent (`TOO_LARGE`, …), so every
 * refusal was printed to the merchant as the raw code.
 */
const REASON_LABEL: Record<string, [string, string]> = {
  build_volume: ['القطعة أكبر من مساحة الطباعة', 'The part is larger than the build volume'],
  materials_at_once: ['عدد المواد أكثر مما يحمله الجهاز', 'More materials than the machine can hold at once'],
  enclosure: ['المادة تحتاج غرفة مغلقة', 'The material needs an enclosure'],
  hardened_nozzle: ['المادة كاشطة وتحتاج فوهة مقوّاة', 'The material is abrasive and needs a hardened nozzle'],
  nozzle: ['قياس الفوهة غير متوفر', 'That nozzle size is not fitted'],
};
const MATERIAL_REASON: [string, string] = ['المادة غير مدعومة على هذا الجهاز', 'This machine cannot run that material'];

/** One refusal code as the merchant reads it; an unknown code is shown as it came. */
function reasonLabel(code: string, en: boolean): string {
  if (code.startsWith('material:')) return `${MATERIAL_REASON[en ? 1 : 0]} (${code.slice('material:'.length)})`;
  const label = REASON_LABEL[code];
  return label ? label[en ? 1 : 0] : code;
}

export function CostingTab() {
  const { lang, loc } = useLanguage();
  const en = lang === 'en';

  const [printers, setPrinters] = useState<QuotePrinter[]>([]);
  const [materials, setMaterials] = useState<QuoteMaterial[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [analysisId, setAnalysisId] = useState('');
  const [modelId, setModelId] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [margin, setMargin] = useState('35');

  const [busy, setBusy] = useState<'' | 'upload' | 'measure' | 'compare'>('');
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [rows, setRows] = useState<PrinterRow[] | null>(null);
  const [openRow, setOpenRow] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    Promise.all([loadPrinters(ac.signal), loadMaterials(ac.signal)])
      .then(([p, m]) => {
        setPrinters(p);
        setMaterials(m);
        if (p.length) setModelId((cur) => cur || p[0].id);
        if (m.length) setMaterialId((cur) => cur || (m.find((x) => x.material_type === 'PLA')?.id ?? m[0].id));
      })
      .catch((e) => !ac.signal.aborted && setError(failureText(e, loc('تعذّر التحميل', 'Could not load'))));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = useCallback(() => {
    setAnalysis(null);
    setRows(null);
    setOpenRow('');
    setError('');
  }, []);

  const pick = useCallback(
    async (chosen: File) => {
      reset();
      setFile(chosen);
      setAnalysisId('');
      setBusy('upload');
      try {
        const up = await uploadModel(chosen);
        setAnalysisId(up.analysis_id);
      } catch (e) {
        setError(failureText(e, loc('فشل الرفع', 'Upload failed')));
      } finally {
        setBusy('');
      }
    },
    [reset, loc]
  );

  const run = useCallback(async () => {
    if (!analysisId || !modelId || !materialId) return;
    reset();
    setBusy('measure');
    try {
      // The measurement is taken against ONE model first — the geometry is a
      // fact about the file, and re-measuring it per printer would be the same
      // pass repeated. The comparison then prices that one analysis on every
      // machine the shop owns.
      const measured = await measureModel(analysisId, {
        printer_model_id: modelId,
        material_id: materialId,
        quantity,
      });
      setAnalysis(measured.analysis);
      setBusy('compare');
      const compared = await api.post<{ printers: PrinterRow[] }>(
        `/api/print-quote/analyses/${analysisId}/compare`,
        { target_margin_percent: Number(margin) || 35 }
      );
      setRows(compared.printers ?? []);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? '';
      setError(
        code === 'DOES_NOT_FIT'
          ? loc('المجسم أكبر من مساحة الطباعة لهذه الطابعة.', 'The model is larger than this printer can build.')
          : failureText(e, loc('تعذّر الحساب', 'Could not price it'))
      );
    } finally {
      setBusy('');
    }
  }, [analysisId, modelId, materialId, quantity, margin, reset, loc]);

  const eligible = useMemo(() => (rows ?? []).filter((r) => r.eligible), [rows]);
  const refused = useMemo(() => (rows ?? []).filter((r) => !r.eligible), [rows]);
  /** The cheapest TRUE cost, so the table can mark it without ranking by a
   *  score nobody can inspect. */
  const cheapest = eligible.reduce<number | null>(
    (best, r) => (r.true_cost_iqd === undefined ? best : best === null ? r.true_cost_iqd : Math.min(best, r.true_cost_iqd)),
    null
  );

  return (
    <div className="space-y-3">
      <Card title={loc('الملف', 'The file')}>
        <input
          ref={fileInput}
          type="file"
          accept=".stl,.3mf,.obj,.step,.stp,.amf,.glb,.gltf"
          className="sr-only"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = '';
            if (chosen) void pick(chosen);
          }}
        />
        {file ? (
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 grid place-items-center shrink-0">
              <Box className="w-4 h-4 text-gold" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-white text-[12.5px] truncate">{file.name}</p>
              <p className="text-zinc-500 text-[11px] tabular-nums" dir="ltr">
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
            <Btn kind="ghost" small onClick={() => fileInput.current?.click()} disabled={busy !== ''}>
              {loc('تغيير', 'Change')}
            </Btn>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== ''}
            className="w-full py-7 flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-zinc-800 hover:border-zinc-700 transition-colors disabled:opacity-50"
          >
            <FileUp className="w-5 h-5 text-gold" />
            <span className="text-white text-[12.5px]">{loc('ارفع ملف المجسم', 'Upload a model file')}</span>
            <span className="text-zinc-600 text-[11px]">STL · 3MF · OBJ · STEP</span>
          </button>
        )}
      </Card>

      {analysisId && (
        <Card title={loc('الإعدادات', 'Settings')}>
          <div className="grid grid-cols-2 gap-2.5">
            <Labelled label={loc('المادة', 'Material')}>
              <select
                value={materialId}
                onChange={(e) => {
                  setMaterialId(e.target.value);
                  reset();
                }}
                className={SELECT}
              >
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {(!en && m.name_ar) || m.name}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label={loc('طراز القياس', 'Measured against')}>
              <select
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  reset();
                }}
                className={SELECT}
              >
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.manufacturer} {p.model}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label={loc('عدد القطع', 'Quantity')}>
              <input
                inputMode="numeric"
                dir="ltr"
                value={quantity}
                onChange={(e) => {
                  setQuantity(Math.max(1, Math.min(500, Number(e.target.value.replace(/\D/g, '')) || 1)));
                  reset();
                }}
                className={SELECT}
              />
            </Labelled>
            <Labelled label={loc('هامش الربح %', 'Target margin %')}>
              <input
                inputMode="decimal"
                dir="ltr"
                value={margin}
                onChange={(e) => setMargin(e.target.value.replace(/[^0-9.]/g, ''))}
                className={SELECT}
              />
            </Labelled>
          </div>
          {/* §21 in one sentence, where the number is entered. */}
          <p className="text-zinc-600 text-[10.5px] mt-2 leading-relaxed">
            {loc(
              'الهامش حصة من السعر لا زيادة على الكلفة: السعر = الكلفة ÷ (١ − الهامش).',
              'Margin is a share of the PRICE, not a markup on cost: price = cost ÷ (1 − margin).'
            )}
          </p>
          <div className="mt-3">
            <Btn onClick={() => void run()} disabled={busy !== ''}>
              {busy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {busy === 'upload'
                    ? loc('يجري الرفع…', 'Uploading…')
                    : busy === 'measure'
                      ? loc('يجري القياس…', 'Measuring…')
                      : loc('يجري التسعير…', 'Pricing…')}
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  {loc('قارن طابعاتي', 'Compare my printers')}
                </>
              )}
            </Btn>
          </div>
        </Card>
      )}

      {error && <Notice text={error} />}

      {analysis && (
        <Card title={loc('القياس', 'The measurement')}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Fact label={loc('المادة', 'Material')}>
              {formatGrams(analysis.materials.reduce((n, m) => n + m.grams, 0))}
            </Fact>
            <Fact label={loc('الزمن', 'Time')}>
              {formatDuration(
                analysis.plate_count * (analysis.print_minutes_per_plate + analysis.preparation_minutes),
                en ? 'en' : 'ar'
              )}
            </Fact>
            <Fact label={loc('الألواح', 'Plates')}>{analysis.plate_count}</Fact>
            <Fact label={loc('لكل لوح', 'Per plate')}>{analysis.pieces_per_plate}</Fact>
          </div>
          <p className="text-zinc-600 text-[10.5px] mt-2.5">
            {analysis.provenance === 'measured'
              ? loc('من تقطيع حقيقي.', 'From a real slice.')
              : loc(
                  'تقدير هندسي من الملف، لا تقطيع فعلي — السعر يظهر كنطاق.',
                  'A geometric estimate from the file, not a real slice — the price shows as a range.'
                )}
          </p>
        </Card>
      )}

      {rows && eligible.length === 0 && refused.length === 0 && (
        <Empty
          text={loc('لا توجد طابعات مسجّلة في متجرك.', 'Your shop has no printers registered.')}
          hint={loc('أضِفها من تبويب «الطابعات».', 'Add them in the Printers tab.')}
        />
      )}

      {eligible.map((r) => (
        <PrinterCard
          key={r.merchant_printer_id}
          row={r}
          en={en}
          loc={loc}
          cheapest={cheapest !== null && r.true_cost_iqd === cheapest}
          open={openRow === r.merchant_printer_id}
          onToggle={() => setOpenRow((cur) => (cur === r.merchant_printer_id ? '' : r.merchant_printer_id))}
        />
      ))}

      {refused.length > 0 && (
        <Card title={loc('طابعات لا تصلح لهذه القطعة', 'Printers that cannot take this job')}>
          <ul className="space-y-2">
            {refused.map((r) => (
              <li key={r.merchant_printer_id} className="flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-zinc-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-zinc-300 text-[12px]">{r.name}</p>
                  <p className="text-zinc-600 text-[11px] leading-relaxed">
                    {(r.reasons ?? []).map((code) => reasonLabel(code, en)).join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {busy === 'compare' && !rows && <Spinner />}
    </div>
  );
}

const SELECT =
  'w-full h-10 bg-zinc-900 border border-zinc-800 rounded-xl px-3 text-white text-[12.5px] focus:outline-none focus:border-gold transition-colors';

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-zinc-500 text-[10px] uppercase tracking-wider mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-zinc-900/60 border border-zinc-800 px-3 py-2">
      <p className="text-zinc-500 text-[10px] uppercase tracking-wider">{label}</p>
      <p className="text-white text-[12.5px] font-medium mt-0.5 tabular-nums" dir="ltr">
        {children}
      </p>
    </div>
  );
}

/**
 * One machine, with the whole bill behind a disclosure.
 *
 * Collapsed it answers "what does this cost me and what should I charge". Open
 * it answers "why" — every component as its own row, with WHERE the number
 * came from, because a shop cannot act on a total.
 */
function PrinterCard({
  row,
  en,
  loc,
  cheapest,
  open,
  onToggle,
}: {
  row: PrinterRow;
  en: boolean;
  loc: (ar: string, e: string, ckb?: string) => string;
  cheapest: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const estimated = row.confidence !== 'exact';
  return (
    <div
      className={`rounded-2xl border bg-zinc-950 overflow-hidden ${
        cheapest ? 'border-gold/40' : 'border-zinc-800'
      }`}
    >
      <div className="p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 grid place-items-center shrink-0">
            <Printer className="w-4 h-4 text-zinc-400" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-white text-[13px] font-medium truncate">{row.name}</p>
            <p className="text-zinc-500 text-[11px] truncate">{row.model}</p>
          </div>
          {cheapest && (
            <span className="text-[10px] text-gold border border-gold/30 bg-gold/10 rounded-full px-2 py-0.5 shrink-0">
              {loc('الأقل كلفة', 'Lowest cost')}
            </span>
          )}
        </div>

        {row.confidence === 'insufficient' ? (
          <p className="text-amber-300/90 text-[11.5px] leading-relaxed mt-3">
            {loc(
              'لا يمكن تسعير هذه المادة: لم يُسجَّل سعر لها في متجرك ولا في الكتالوج.',
              'This material cannot be costed: no price is recorded on your spools or in the catalogue.'
            )}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mt-3">
              <Money label={loc('كلفتك', 'Your cost')} value={row.true_cost_iqd} tone="neutral" />
              <Money label={loc('السعر المقترح', 'Suggested price')} value={row.price_iqd} tone="gold" />
              <Money label={loc('الربح', 'Profit')} value={row.profit_iqd} tone="good" />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2.5 text-[11px] text-zinc-500 tabular-nums" dir="ltr">
              <span>{loc('هامش', 'Margin')} {row.margin_percent}%</span>
              <span>·</span>
              <span>{loc('زيادة', 'Markup')} {row.markup_percent}%</span>
              <span>·</span>
              <span>{(row.machine_hours ?? 0).toFixed(2)} h</span>
              <span>·</span>
              <span>{loc('هدر', 'Waste')} {row.waste_percent}%</span>
            </div>
            {estimated && row.range_iqd && (
              <p className="text-amber-300/80 text-[11px] mt-2 tabular-nums" dir="ltr">
                {loc('نطاق', 'Range')}: {formatIqd(row.range_iqd.low)} – {formatIqd(row.range_iqd.high)}
              </p>
            )}
          </>
        )}

        {(row.lines?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="mt-3 w-full flex items-center justify-center gap-1.5 text-[11.5px] text-zinc-400 hover:text-white py-1.5 rounded-lg hover:bg-zinc-900 transition-colors"
          >
            {open ? loc('إخفاء التفاصيل', 'Hide breakdown') : loc('أين تذهب الكلفة', 'Where the cost goes')}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {open && row.lines && (
        <div className="border-t border-zinc-800 divide-y divide-zinc-800/60">
          {row.lines.map((line) => (
            <div key={line.component} className="px-3.5 py-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-zinc-300 text-[12px]">
                  {COMPONENT_LABEL[line.component]?.[en ? 1 : 0] ?? line.component}
                </p>
                {line.detail && (
                  <p className="text-zinc-600 text-[10.5px] truncate" dir="ltr">
                    {line.detail}
                  </p>
                )}
              </div>
              <div className="text-end shrink-0">
                <p className="text-white text-[12px] tabular-nums" dir="ltr">
                  {formatIqd(line.iqd)}
                </p>
                <p className="text-zinc-600 text-[10px]">{PROVENANCE_LABEL[line.from]?.[en ? 1 : 0] ?? line.from}</p>
              </div>
            </div>
          ))}
          {/* The reserve is shown SEPARATELY from the base, because §13's whole
              point is that risk is not hidden inside the filament number. */}
          <div className="px-3.5 py-2.5 bg-zinc-900/40 space-y-1">
            <Sum label={loc('كلفة طبعة ناجحة', 'One successful print')} value={row.base_cost_iqd} />
            <Sum label={loc('احتياطي المحاولات الفاشلة', 'Reserve for failed attempts')} value={row.failure_reserve_iqd} />
            <Sum label={loc('نقطة التعادل', 'Break-even')} value={row.break_even_iqd} strong />
          </div>
          {row.because && (
            <p className="px-3.5 py-2 text-zinc-600 text-[10.5px] leading-relaxed" dir="ltr">
              {row.because.plates} plates · {row.because.machine_hours.toFixed(2)} h ·{' '}
              {formatIqd(row.because.machine_iqd_per_hour)}/h · {formatGrams(row.because.waste_grams)}{' '}
              {loc('هدر', 'waste')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Money({ label, value, tone }: { label: string; value?: number; tone: 'neutral' | 'gold' | 'good' }) {
  const color = tone === 'gold' ? 'text-gold' : tone === 'good' ? 'text-emerald-400' : 'text-white';
  return (
    <div className="rounded-xl bg-zinc-900/60 border border-zinc-800 px-2.5 py-2">
      <p className="text-zinc-500 text-[10px] uppercase tracking-wider truncate">{label}</p>
      <p className={`text-[13px] font-semibold mt-0.5 tabular-nums ${color}`} dir="ltr">
        {value === undefined ? '—' : formatIqd(value)}
      </p>
    </div>
  );
}

function Sum({ label, value, strong }: { label: string; value?: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-[11.5px] ${strong ? 'text-white font-medium' : 'text-zinc-400'}`}>{label}</span>
      <span className={`text-[12px] tabular-nums ${strong ? 'text-white font-semibold' : 'text-zinc-300'}`} dir="ltr">
        {value === undefined ? '—' : formatIqd(value)}
      </span>
    </div>
  );
}
