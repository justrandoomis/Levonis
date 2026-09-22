/**
 * «احسب سعر طباعتك» — the print quote flow.
 *
 * WHAT CHANGED, AND WHY IT MATTERS MORE THAN THE SCREEN.
 *
 * The page this replaces asked the customer for the answer. It had three
 * fields — grams, hours, quantity — and multiplied them by a filament price.
 * A customer who knows how many grams their model weighs does not need a
 * calculator, and one who does not cannot use it. Worse, the material list was
 * built from products carrying a `net_weight`, and no filament product in the
 * catalogue carried one, so the page most visitors actually saw said «لا توجد
 * مواد مسجّلة» and stopped.
 *
 * So the question is turned around: the customer brings the FILE, and the
 * engine answers. Nothing is asked that the file can say.
 *
 * WHERE THE NUMBERS COME FROM, because this page is the one place a visitor
 * decides whether to believe them:
 *
 *   MEASURED    the volume, the surface area, the bounding box, the overhang.
 *               Integrals over the real triangles, computed on the Worker —
 *               shown under «ما يقوله الملف» as facts.
 *   MODELLED    walls, infill, support, minutes. A stated physical model with
 *               named coefficients (worker/lib/printQuote/geometryAdapter.ts).
 *
 * That split is why the price is shown as a RANGE and labelled «تقدير». §50
 * forbids presenting an estimate as a quote, and the engine enforces it by
 * refusing to emit equal range bounds for anything that is not `exact`. This
 * page never computes a price of its own — there is no arithmetic on money
 * here at all — so it cannot drift from the engine that has to defend it.
 *
 * TWO DOORS, ONE ENGINE. «أو من الملف» — the owner's own "or". A customer who
 * already knows they need 100 g of a particular filament in one or two colours
 * should not have to produce a file to be told a price, and sending them away
 * to find one is how they go and ask another shop. So there is a second mode,
 * `src/components/tools/GramsQuotePanel.tsx`, which asks for the WEIGHT.
 *
 * It is a different question, not a different price list: the grams route
 * builds a `PrintAnalysis` and hands it to the same `priceJob`, with the same
 * per-gram rate, the same material correction and the same minimum job that
 * this file path uses. tests/printQuoteGrams.test.ts holds the two together to
 * the dinar, because the day they disagree is the day the number a customer
 * was shown stops being the number the shop charges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  FileUp,
  Layers,
  Loader2,
  RefreshCw,
  Ruler,
  Scale,
  Timer,
  Upload,
  Users,
} from 'lucide-react';
import { failureText } from '../lib/api';
import {
  formatDuration,
  formatGrams,
  formatMm,
  loadMaterials,
  loadPrinters,
  measureModel,
  quoteAnalysis,
  uploadModel,
  type AnalysisView,
  type GeometryView,
  type PublicQuoteView,
  type QuoteMaterial,
  type QuotePrinter,
} from '../lib/printQuote';
import GramsQuotePanel from '../components/tools/GramsQuotePanel';
import { useMoney } from '../CurrencyContext';

type Lang = 'ar' | 'en' | 'ckb';
type Quality = 'draft' | 'standard' | 'fine';
type Strength = 'light' | 'standard' | 'strong';

const ACCEPT = '.stl,.3mf,.obj,.step,.stp,.amf,.glb,.gltf';

const STRINGS = {
  ar: {
    title: 'احسب سعر طباعتك',
    lead: 'ارفع ملف المجسم، ونقيسه ونحسب لك تقديرًا للسعر.',
    pick: 'اختر ملف المجسم',
    formats: 'STL · 3MF · OBJ · STEP · AMF — حتى 40 ميغابايت',
    drop: 'أو اسحب الملف إلى هنا',
    change: 'ملف آخر',
    uploading: 'يجري الرفع…',
    measuring: 'يجري قياس المجسم…',
    pricing: 'يجري الحساب…',
    settings: 'إعدادات الطباعة',
    printer: 'الطابعة',
    material: 'المادة',
    quality: 'الدقة',
    strength: 'المتانة',
    quantity: 'عدد القطع',
    supports: 'دعامات',
    supportsOn: 'مفعّلة',
    supportsOff: 'بدون',
    draft: 'سريعة',
    standard: 'قياسية',
    fine: 'ناعمة',
    light: 'خفيفة',
    strongOpt: 'قوية',
    calculate: 'احسب السعر',
    recalc: 'أعد الحساب',
    fromFile: 'ما يقوله الملف',
    volume: 'الحجم الصلب',
    size: 'الأبعاد',
    triangles: 'المثلثات',
    parts: 'الأجزاء',
    overhang: 'المساحة المعلّقة',
    estimated: 'تقدير الطباعة',
    weight: 'وزن المادة',
    waste: 'منها هدر',
    time: 'زمن الطباعة',
    plates: 'عدد الألواح',
    layers: 'الطبقات',
    price: 'السعر التقديري',
    rangeNote: 'النطاق المتوقع',
    estimateBadge: 'تقدير — ليس عرض سعر نهائيًا',
    exactBadge: 'محسوب من تقطيع حقيقي',
    why: 'هذا تقدير لأن حساب المادة والزمن مبني على نموذج للطباعة، لا على تقطيع فعلي للملف. التاجر الذي سيطبع القطعة يعطيك السعر النهائي.',
    insufficient: 'لا يمكن حساب سعر لهذه المادة بعد: لم يُسجَّل سعرها في المتجر. جرّب مادة أخرى أو أرسل طلبًا وسيسعّره التاجر.',
    unmeasured: 'ما لا يستطيع هذا التقدير قياسه',
    SUPPORT_PLACEMENT: 'موضع الدعامات الفعلي',
    SEAM_AND_TRAVEL: 'زمن التنقّل والخياطة',
    OPEN_MESH_VOLUME: 'حجم شبكة غير مغلقة',
    PART_COUNT: 'عدد الأجزاء المنفصلة',
    sendRequest: 'أرسل طلب طباعة إلى التجّار',
    sendNote: 'التجّار يرون المجسم ويقدّمون عروضهم — سعر نهائي من شخص سيطبعها فعلًا.',
    back: 'رجوع',
    warnHeavyOverhang: 'المجسم فيه مساحات معلّقة كثيرة، لذا كلفة الدعامات مرتفعة. تدوير القطعة قد يخفّض السعر.',
    warnNotWatertight: 'الشبكة غير مغلقة تمامًا، لذا الحجم المقاس قد لا يكون دقيقًا.',
    warnUnitAssumed: 'الصيغة لا تذكر وحدة القياس، فافترضنا الملّيمتر.',
    doesNotFit: 'المجسم أكبر من مساحة طباعة هذه الطابعة. اختر طابعة أكبر أو صغّر المقاس.',
    notMeasurable: 'لا يمكن قياس هذه الصيغة. ارفع STL أو 3MF.',
    zeroVolume: 'الملف لا يحتوي على مجسم مصمت يمكن قياسه.',
    modeFile: 'من ملف',
    modeGrams: 'من الغرامات',
  },
  en: {
    title: 'Print price calculator',
    lead: 'Upload your model — we measure it and work out an estimate.',
    pick: 'Choose a model file',
    formats: 'STL · 3MF · OBJ · STEP · AMF — up to 40 MB',
    drop: 'or drop the file here',
    change: 'Different file',
    uploading: 'Uploading…',
    measuring: 'Measuring the model…',
    pricing: 'Working it out…',
    settings: 'Print settings',
    printer: 'Printer',
    material: 'Material',
    quality: 'Quality',
    strength: 'Strength',
    quantity: 'Quantity',
    supports: 'Supports',
    supportsOn: 'On',
    supportsOff: 'Off',
    draft: 'Draft',
    standard: 'Standard',
    fine: 'Fine',
    light: 'Light',
    strongOpt: 'Strong',
    calculate: 'Calculate',
    recalc: 'Recalculate',
    fromFile: 'What the file says',
    volume: 'Solid volume',
    size: 'Dimensions',
    triangles: 'Triangles',
    parts: 'Parts',
    overhang: 'Overhanging area',
    estimated: 'Print estimate',
    weight: 'Material',
    waste: 'of which waste',
    time: 'Print time',
    plates: 'Plates',
    layers: 'Layers',
    price: 'Estimated price',
    rangeNote: 'Expected range',
    estimateBadge: 'Estimate — not a final quote',
    exactBadge: 'From a real slice',
    why: 'This is an estimate because the material and time come from a printing model, not from slicing your file. The merchant who prints it gives you the final price.',
    insufficient: 'This material has no price in the shop yet, so it cannot be costed. Try another material, or send a request and a merchant will price it.',
    unmeasured: 'What this estimate cannot measure',
    SUPPORT_PLACEMENT: 'Where supports actually land',
    SEAM_AND_TRAVEL: 'Travel and seam time',
    OPEN_MESH_VOLUME: 'Volume of an open mesh',
    PART_COUNT: 'Number of separate bodies',
    sendRequest: 'Send a print request to merchants',
    sendNote: 'Merchants see the model and bid — a final price from someone who will actually print it.',
    back: 'Back',
    warnHeavyOverhang: 'This model overhangs a lot, so support costs are high. Rotating it may lower the price.',
    warnNotWatertight: 'The mesh is not fully closed, so the measured volume may not be exact.',
    warnUnitAssumed: 'The format states no unit, so millimetres were assumed.',
    doesNotFit: 'The model is larger than this printer can build. Pick a larger printer or scale it down.',
    notMeasurable: 'This format cannot be measured. Upload an STL or 3MF.',
    zeroVolume: 'The file contains no solid body to measure.',
    modeFile: 'From a file',
    modeGrams: 'By grams',
  },
  ckb: {
    title: 'ژمێرەری نرخی چاپ',
    lead: 'فایلی مۆدێلەکەت باربکە، دەیپێوین و خەمڵاندنێکی نرخت بۆ دەکەین.',
    pick: 'فایلی مۆدێل هەڵبژێرە',
    formats: 'STL · 3MF · OBJ · STEP · AMF — تا ٤٠ مێگابایت',
    drop: 'یان فایلەکە بێنە ئێرە',
    change: 'فایلێکی تر',
    uploading: 'بارکردن…',
    measuring: 'پێوانی مۆدێل…',
    pricing: 'ژمێرین…',
    settings: 'ڕێکخستنی چاپ',
    printer: 'چاپکەر',
    material: 'ماددە',
    quality: 'وردی',
    strength: 'بەهێزی',
    quantity: 'ژمارەی پارچە',
    supports: 'پاڵپشت',
    supportsOn: 'کارا',
    supportsOff: 'بێ',
    draft: 'خێرا',
    standard: 'ئاسایی',
    fine: 'ناسک',
    light: 'سووک',
    strongOpt: 'بەهێز',
    calculate: 'نرخ بژمێرە',
    recalc: 'دووبارە بژمێرە',
    fromFile: 'ئەوەی فایلەکە دەیڵێت',
    volume: 'قەبارەی ڕەق',
    size: 'ڕەهەندەکان',
    triangles: 'سێگۆشەکان',
    parts: 'بەشەکان',
    overhang: 'ڕووبەری هەڵواسراو',
    estimated: 'خەمڵاندنی چاپ',
    weight: 'ماددە',
    waste: 'لەوانە بەفیڕۆدان',
    time: 'کاتی چاپ',
    plates: 'ژمارەی پلێت',
    layers: 'چینەکان',
    price: 'نرخی خەمڵێنراو',
    rangeNote: 'مەودای چاوەڕوانکراو',
    estimateBadge: 'خەمڵاندن — نرخی کۆتایی نییە',
    exactBadge: 'لە پارچەکردنی ڕاستەقینەوە',
    why: 'ئەمە خەمڵاندنە چونکە ماددە و کات لە مۆدێلێکی چاپەوە دێن، نەک لە پارچەکردنی ڕاستەقینەی فایلەکەت. ئەو بازرگانەی دەیچاپێت نرخی کۆتاییت پێدەدات.',
    insufficient: 'ئەم ماددەیە هێشتا نرخی لە فرۆشگادا نییە، بۆیە ناژمێردرێت. ماددەیەکی تر تاقی بکەرەوە، یان داواکاری بنێرە و بازرگان نرخی دەکات.',
    unmeasured: 'ئەوەی ئەم خەمڵاندنە ناتوانێت بیپێوێت',
    SUPPORT_PLACEMENT: 'شوێنی ڕاستەقینەی پاڵپشتەکان',
    SEAM_AND_TRAVEL: 'کاتی گواستنەوە و دروو',
    OPEN_MESH_VOLUME: 'قەبارەی تۆڕی کراوە',
    PART_COUNT: 'ژمارەی بەشە جیاکانەوە',
    sendRequest: 'داواکاری چاپ بنێرە بۆ بازرگانان',
    sendNote: 'بازرگانان مۆدێلەکە دەبینن و نرخ دەدەن — نرخی کۆتایی لە کەسێکەوە کە بەڕاستی دەیچاپێت.',
    back: 'گەڕانەوە',
    warnHeavyOverhang: 'ئەم مۆدێلە زۆر هەڵواسراوە، بۆیە تێچووی پاڵپشت بەرزە. سووڕاندنەوەی لەوانەیە نرخ کەم بکاتەوە.',
    warnNotWatertight: 'تۆڕەکە بە تەواوی داخراو نییە، بۆیە قەبارەی پێوراو لەوانەیە ورد نەبێت.',
    warnUnitAssumed: 'فۆرماتەکە یەکەی پێوان ناڵێت، بۆیە میلیمەتر وەرگیرا.',
    doesNotFit: 'مۆدێلەکە لە ڕووبەری چاپی ئەم چاپکەرە گەورەترە. چاپکەرێکی گەورەتر هەڵبژێرە یان بچووکی بکەرەوە.',
    notMeasurable: 'ئەم فۆرماتە ناپێورێت. STL یان 3MF باربکە.',
    zeroVolume: 'فایلەکە هیچ جەستەیەکی ڕەقی تێدا نییە بۆ پێوان.',
    modeFile: 'لە فایلەوە',
    modeGrams: 'بە گرام',
  },
} as const;

/** Server refusal codes → the one sentence a customer can act on. */
const REFUSAL_KEY: Record<string, keyof (typeof STRINGS)['ar']> = {
  DOES_NOT_FIT: 'doesNotFit',
  NOT_MEASURABLE: 'notMeasurable',
  ZERO_VOLUME: 'zeroVolume',
};

export default function Tools() {
  const { money } = useMoney();
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const L = (lang in STRINGS ? lang : 'ar') as Lang;
  const s = STRINGS[L];
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  /**
   * WHICH QUESTION THE VISITOR IS ASKING. «أو من الملف» is the owner's own
   * "or", so it is a choice made once at the top rather than a field buried in
   * a form — the two modes need different inputs and say different things
   * about what the answer covers, and a single form pretending to do both
   * would have to leave half its boxes meaningless in either case.
   */
  const [mode, setMode] = useState<'file' | 'grams'>('file');

  const [printers, setPrinters] = useState<QuotePrinter[]>([]);
  const [materials, setMaterials] = useState<QuoteMaterial[]>([]);
  const [catalogError, setCatalogError] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [analysisId, setAnalysisId] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [quality, setQuality] = useState<Quality>('standard');
  const [strength, setStrength] = useState<Strength>('standard');
  const [supports, setSupports] = useState(true);
  const [quantity, setQuantity] = useState(1);

  const [stage, setStage] = useState<'idle' | 'uploading' | 'measuring' | 'pricing'>('idle');
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [geometry, setGeometry] = useState<GeometryView | null>(null);
  const [quote, setQuote] = useState<PublicQuoteView | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    Promise.all([loadPrinters(ac.signal), loadMaterials(ac.signal)])
      .then(([p, m]) => {
        setPrinters(p);
        setMaterials(m);
        if (p.length && !printerId) setPrinterId(p[0].id);
        if (m.length && !materialId) setMaterialId(m.find((x) => x.material_type === 'PLA')?.id ?? m[0].id);
      })
      .catch((e) => !ac.signal.aborted && setCatalogError(failureText(e, s.back)));
    return () => ac.abort();
    // The catalogue is fetched once; the ids are seeded only when empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const printer = printers.find((p) => p.id === printerId) ?? null;

  /**
   * Only the materials this machine can actually run.
   *
   * A machine that cannot take ABS is not a cheaper way to print ABS — it is
   * not an option, and offering it produces a quote for a job nobody can
   * deliver. The same rule the engine applies server-side (§28), applied here
   * so the customer never picks a combination that will be refused.
   */
  const usableMaterials = useMemo(() => {
    if (!printer) return materials;
    const allowed = new Set(printer.materials.map((t) => t.toUpperCase()));
    return materials.filter((m) => allowed.has(m.material_type.toUpperCase()));
  }, [materials, printer]);

  useEffect(() => {
    if (!usableMaterials.length) return;
    if (!usableMaterials.some((m) => m.id === materialId)) setMaterialId(usableMaterials[0].id);
  }, [usableMaterials, materialId]);

  /** A settings change invalidates the answer — it must not sit there looking
   *  current while it describes the previous choice. */
  const invalidate = useCallback(() => {
    setAnalysis(null);
    setGeometry(null);
    setQuote(null);
    setError('');
  }, []);

  const pickFile = useCallback(
    async (chosen: File) => {
      invalidate();
      setFile(chosen);
      setAnalysisId('');
      setStage('uploading');
      setError('');
      try {
        const up = await uploadModel(chosen);
        setAnalysisId(up.analysis_id);
      } catch (e) {
        setError(failureText(e, s.uploading));
      } finally {
        setStage('idle');
      }
    },
    [invalidate, s.uploading]
  );

  const calculate = useCallback(async () => {
    if (!analysisId || !printerId || !materialId) return;
    invalidate();
    setStage('measuring');
    try {
      const measured = await measureModel(analysisId, {
        printer_model_id: printerId,
        material_id: materialId,
        quality_id: quality,
        strength_id: strength,
        supports,
        quantity,
      });
      setAnalysis(measured.analysis);
      setGeometry(measured.geometry);
      setStage('pricing');
      const priced = await quoteAnalysis(analysisId);
      setQuote(priced.quote);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? '';
      const key = REFUSAL_KEY[code];
      setError(key ? (s[key] as string) : failureText(e, s.measuring));
    } finally {
      setStage('idle');
    }
  }, [analysisId, printerId, materialId, quality, strength, supports, quantity, invalidate, s]);

  const busy = stage !== 'idle';
  const totalGrams = analysis?.materials.reduce((n, m) => n + m.grams, 0) ?? 0;
  const wasteGrams = analysis?.materials.reduce((n, m) => n + m.wasteGrams, 0) ?? 0;
  const totalMinutes = analysis ? analysis.plate_count * (analysis.print_minutes_per_plate + analysis.preparation_minutes) : 0;

  return (
    <div className="w-full pb-28 text-zinc-300 bg-black min-h-screen" dir={dir}>
      <header className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          aria-label={s.back}
          className="p-2 -m-2 text-zinc-400 hover:text-white transition-colors"
        >
          <Back className="w-5 h-5" />
        </button>
        <h1 className="text-white font-semibold text-[17px] tracking-tight">{s.title}</h1>
      </header>

      <div className="px-4 pt-5 max-w-2xl mx-auto space-y-5">
        {/*
          The two doors, side by side and equal. Not a link and not a tucked-away
          "advanced" toggle: a customer who knows their weight and a customer who
          holds a file are both ordinary, and hiding either question behind the
          other is how one of them decides the calculator is not for them.
        */}
        <div role="group" aria-label={s.title} className="grid grid-cols-2 gap-0.5 bg-zinc-900 border border-zinc-800 rounded-2xl p-0.5">
          {([
            { value: 'file' as const, label: s.modeFile, Icon: FileUp },
            { value: 'grams' as const, label: s.modeGrams, Icon: Scale },
          ]).map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={mode === o.value}
              onClick={() => setMode(o.value)}
              className={`h-10 rounded-[0.9rem] text-[13px] leading-snug flex items-center justify-center gap-2 transition-colors ${
                mode === o.value ? 'bg-zinc-800 text-white font-medium shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <o.Icon className="w-4 h-4" aria-hidden />
              {o.label}
            </button>
          ))}
        </div>

        {catalogError && <Notice tone="error">{catalogError}</Notice>}

        {mode === 'grams' ? (
          /* The catalogue is already loaded above, so the weight form reuses it
             rather than fetching the same two lists a second time. */
          <GramsQuotePanel printers={printers} materials={materials} />
        ) : (
          <>
        <p className="text-zinc-400 text-[13px] leading-relaxed">{s.lead}</p>

        {/* ---------------------------------------------------------- 1. file */}
        <section
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) void pickFile(dropped);
          }}
          className={`rounded-2xl border transition-colors ${
            dragging ? 'border-[#BAA369] bg-[#BAA369]/5' : 'border-zinc-800 bg-zinc-950'
          }`}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              if (chosen) void pickFile(chosen);
            }}
          />
          {file ? (
            <div className="p-4 flex items-center gap-3">
              <span className="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 grid place-items-center shrink-0">
                <Box className="w-5 h-5 text-[#BAA369]" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-white text-[13px] font-medium truncate">{file.name}</p>
                <p className="text-zinc-500 text-[11px] tabular-nums" dir="ltr">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                  {analysisId && <Check className="w-3 h-3 inline-block ms-1.5 text-emerald-400" aria-hidden />}
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="text-[12px] text-zinc-400 hover:text-white px-3 py-2 rounded-lg hover:bg-zinc-900 transition-colors disabled:opacity-40"
              >
                {s.change}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="w-full p-8 flex flex-col items-center gap-2 text-center disabled:opacity-50"
            >
              <span className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 grid place-items-center">
                <FileUp className="w-5 h-5 text-[#BAA369]" aria-hidden />
              </span>
              <span className="text-white text-[14px] font-medium mt-1">{s.pick}</span>
              <span className="text-zinc-500 text-[11px]">{s.formats}</span>
              <span className="text-zinc-600 text-[11px] hidden sm:block">{s.drop}</span>
            </button>
          )}
        </section>

        {/* ------------------------------------------------------ 2. settings */}
        {analysisId && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800/70">
            <h2 className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{s.settings}</h2>

            <Field label={s.printer}>
              <Select
                value={printerId}
                onChange={(v) => {
                  setPrinterId(v);
                  invalidate();
                }}
                disabled={busy}
                options={printers.map((p) => ({
                  value: p.id,
                  label: `${p.manufacturer} ${p.model} — ${p.build_mm.x}×${p.build_mm.y}×${p.build_mm.z}`,
                }))}
              />
            </Field>

            <Field label={s.material}>
              <Select
                value={materialId}
                onChange={(v) => {
                  setMaterialId(v);
                  invalidate();
                }}
                disabled={busy}
                /**
                 * «اختيار الماده اجعلها بالانجليزي».
                 *
                 * A material name is an identifier, not prose: "PLA Matte",
                 * "PETG-CF", "ASA". It is what is printed on the spool, what
                 * the merchant searches for and what the slicer profile is
                 * named after, and it is the same string in every language —
                 * the rule this codebase already applies to product names
                 * («the product name is English in every language and is never
                 * translated»). An Arabic rendering of it is a second name for
                 * one thing, and the customer then cannot match what they
                 * chose here against what they are buying.
                 */
                options={usableMaterials.map((m) => ({
                  value: m.id,
                  label: m.name || m.material_type,
                }))}
              />
            </Field>

            <Field label={s.quality}>
              <Segmented
                value={quality}
                onChange={(v) => {
                  setQuality(v);
                  invalidate();
                }}
                disabled={busy}
                options={[
                  { value: 'draft' as const, label: s.draft },
                  { value: 'standard' as const, label: s.standard },
                  { value: 'fine' as const, label: s.fine },
                ]}
              />
            </Field>

            <Field label={s.strength}>
              <Segmented
                value={strength}
                onChange={(v) => {
                  setStrength(v);
                  invalidate();
                }}
                disabled={busy}
                options={[
                  { value: 'light' as const, label: s.light },
                  { value: 'standard' as const, label: s.standard },
                  { value: 'strong' as const, label: s.strongOpt },
                ]}
              />
            </Field>

            <Field label={s.supports}>
              <Segmented
                value={supports}
                onChange={(v) => {
                  setSupports(v);
                  invalidate();
                }}
                disabled={busy}
                options={[
                  { value: true, label: s.supportsOn },
                  { value: false, label: s.supportsOff },
                ]}
              />
            </Field>

            <Field label={s.quantity}>
              <div className="flex items-center gap-1" dir="ltr">
                <Stepper
                  sign="−"
                  disabled={busy || quantity <= 1}
                  onClick={() => {
                    setQuantity((n) => Math.max(1, n - 1));
                    invalidate();
                  }}
                />
                <span className="w-10 text-center text-white text-[14px] font-medium tabular-nums">{quantity}</span>
                <Stepper
                  sign="+"
                  disabled={busy || quantity >= 200}
                  onClick={() => {
                    setQuantity((n) => Math.min(200, n + 1));
                    invalidate();
                  }}
                />
              </div>
            </Field>
          </section>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        {analysisId && (
          <button
            type="button"
            onClick={() => void calculate()}
            disabled={busy || !printerId || !materialId}
            className="w-full h-12 rounded-2xl bg-[#BAA369] text-black font-semibold text-[15px] flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.99] transition-transform"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                {stage === 'uploading' ? s.uploading : stage === 'measuring' ? s.measuring : s.pricing}
              </>
            ) : (
              <>
                {analysis ? <RefreshCw className="w-4 h-4" aria-hidden /> : <Upload className="w-4 h-4" aria-hidden />}
                {analysis ? s.recalc : s.calculate}
              </>
            )}
          </button>
        )}

        {/* --------------------------------------------- 3. what the file says */}
        {geometry && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden">
            <h2 className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800/70 flex items-center gap-2">
              <Ruler className="w-3.5 h-3.5" aria-hidden />
              {s.fromFile}
            </h2>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-zinc-800/70">
              <Fact label={s.size}>
                {formatMm(geometry.dimensions_mm.x)} × {formatMm(geometry.dimensions_mm.y)} ×{' '}
                {formatMm(geometry.dimensions_mm.z)} mm
              </Fact>
              <Fact label={s.volume}>{(geometry.volume_mm3 / 1000).toFixed(1)} cm³</Fact>
              <Fact label={s.overhang}>{Math.round(geometry.overhang_ratio * 100)}%</Fact>
              <Fact label={s.triangles}>{geometry.triangle_count.toLocaleString('en-US')}</Fact>
              {geometry.shell_count !== null && <Fact label={s.parts}>{geometry.shell_count}</Fact>}
            </dl>
            {/* Warnings that change what the customer should DO, in their words. */}
            <div className="p-3 space-y-2 empty:hidden">
              {geometry.warnings.some((w) => w.code === 'HEAVY_OVERHANG') && <Hint>{s.warnHeavyOverhang}</Hint>}
              {geometry.watertight === false && <Hint>{s.warnNotWatertight}</Hint>}
              {geometry.unit_source === 'assumed' && <Hint>{s.warnUnitAssumed}</Hint>}
            </div>
          </section>
        )}

        {/* -------------------------------------------------- 4. the estimate */}
        {analysis && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden">
            <h2 className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800/70 flex items-center gap-2">
              <Layers className="w-3.5 h-3.5" aria-hidden />
              {s.estimated}
            </h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-zinc-800/70">
              <Fact label={s.weight}>{formatGrams(totalGrams)}</Fact>
              <Fact label={s.time}>
                <span className="inline-flex items-center gap-1">
                  <Timer className="w-3 h-3 text-zinc-500" aria-hidden />
                  {formatDuration(totalMinutes, L)}
                </span>
              </Fact>
              <Fact label={s.plates}>{analysis.plate_count}</Fact>
              <Fact label={s.layers}>{analysis.layer_count.toLocaleString('en-US')}</Fact>
            </dl>
            {wasteGrams > 0.05 && (
              <p className="px-4 py-2.5 text-[11px] text-zinc-500 border-t border-zinc-800/70">
                {s.waste}: <span className="text-zinc-300 tabular-nums" dir="ltr">{formatGrams(wasteGrams)}</span>
              </p>
            )}
            {analysis.unmeasured.length > 0 && (
              <div className="px-4 py-3 border-t border-zinc-800/70">
                <p className="text-[11px] text-zinc-500 mb-1.5">{s.unmeasured}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {analysis.unmeasured.map((u) => (
                    <li key={u} className="text-[11px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-full px-2.5 py-1">
                      {(s as Record<string, string>)[u] ?? u}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* ----------------------------------------------------- 5. the price */}
        {quote && quote.confidence === 'insufficient' && <Notice tone="warn">{s.insufficient}</Notice>}

        {quote && quote.confidence !== 'insufficient' && (
          <section className="rounded-2xl border border-[#BAA369]/30 bg-gradient-to-b from-[#BAA369]/[0.07] to-transparent p-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{s.price}</p>
            <p className="text-white font-bold text-[30px] leading-tight mt-1 tabular-nums" dir="ltr" data-quote-price>
              {money(quote.price_iqd)}
            </p>
            {quote.range_iqd.high > quote.range_iqd.low && (
              <p className="text-zinc-400 text-[12px] mt-1 tabular-nums" dir="ltr">
                {s.rangeNote}: {money(quote.range_iqd.low)} – {money(quote.range_iqd.high)}
              </p>
            )}
            <p
              className={`inline-flex items-center gap-1.5 mt-3 text-[11px] rounded-full px-2.5 py-1 border ${
                quote.confidence === 'exact'
                  ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                  : 'text-amber-300 border-amber-500/30 bg-amber-500/10'
              }`}
            >
              <AlertCircle className="w-3 h-3" aria-hidden />
              {quote.confidence === 'exact' ? s.exactBadge : s.estimateBadge}
            </p>
            {quote.confidence !== 'exact' && (
              <p className="text-zinc-500 text-[11px] leading-relaxed mt-3">{s.why}</p>
            )}
          </section>
        )}

        {/* --------------------------------------- 6. the step that ends in a print */}
        {quote && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <button
              type="button"
              onClick={() => navigate('/requests')}
              className="w-full h-11 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-white text-[14px] font-medium flex items-center justify-center gap-2 transition-colors"
            >
              <Users className="w-4 h-4 text-[#BAA369]" aria-hidden />
              {s.sendRequest}
            </button>
            <p className="text-zinc-500 text-[11px] leading-relaxed mt-2.5 text-center">{s.sendNote}</p>
          </section>
        )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- pieces

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-3 min-h-[3.25rem]">
      <span className="text-zinc-400 text-[13px] shrink-0">{label}</span>
      <div className="min-w-0 flex justify-end">{children}</div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-950 px-4 py-3">
      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider">{label}</dt>
      <dd className="text-white text-[13px] font-medium mt-0.5 tabular-nums" dir="ltr">
        {children}
      </dd>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[16rem] bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-[13px] focus:outline-none focus:border-[#BAA369] disabled:opacity-40 transition-colors truncate"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The selected segment carries ONE cue — a lifted neutral surface — rather than
 * a gold border plus a gold background plus gold text. Selection has to be
 * obvious, not loud.
 */
function Segmented<T extends string | boolean>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div role="group" className="inline-flex bg-zinc-900 border border-zinc-800 rounded-xl p-0.5 gap-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 rounded-[0.6rem] text-[12px] transition-colors disabled:opacity-40 ${
              active ? 'bg-zinc-800 text-white font-medium shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Stepper({ sign, onClick, disabled }: { sign: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={sign === '+' ? 'increase' : 'decrease'}
      className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-[15px] grid place-items-center disabled:opacity-30 hover:border-zinc-700 transition-colors"
    >
      {sign}
    </button>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'warn'; children: React.ReactNode }) {
  const styles =
    tone === 'error'
      ? 'text-[#e4899a] bg-[#B03142]/10 border-[#B03142]/40'
      : 'text-amber-300/90 bg-amber-500/10 border-amber-500/25';
  return (
    <p role="alert" className={`text-[12px] leading-relaxed rounded-2xl p-3.5 border flex items-start gap-2 ${styles}`}>
      <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] leading-relaxed text-zinc-400 flex items-start gap-2">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px text-amber-400/80" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
