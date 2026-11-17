/**
 * «استيراد من صور الطلب / الفاتورة» — the owner photographs or screenshots a
 * supplier order (1688 / Taobao / Tmall in Chinese, a Bambu Lab EU invoice PDF)
 * and the purchase gets its lines: product + option / colour, quantity and the
 * unit price paid (owner request 2026-11-17).
 *
 *   1. pick files (several at once, the camera on a phone); a tall capture is
 *      cut here into parts the model reads at full resolution;
 *   2. POST ${PROCUREMENT}/import/extract — the owner's AI model reads them
 *      (worker/routes/adminProcurementImport.ts);
 *   3. POST ${PROCUREMENT}/import/match — catalogue candidates found by text,
 *      the model only chooses among them;
 *   4. the owner reviews every row (re-match with StockSelection, skip, edit
 *      qty / price), sees the totals check, and adds the lines.
 *
 * Nothing is saved here: `onAdd` hands the lines and the document header to
 * the purchase wizard (the lead wires it into ProcurementPanel).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import VariantImg from '../ui/VariantImg';
import StockSelection from './StockSelection';
import { api, operationErrorText, PROCUREMENT, T, useLabels, type Selection } from './shared';

export interface InvoiceImportDocument {
  supplier?: string;
  order_no?: string;
  date?: string;
  currency: string;
  shipping?: number;
  discount?: number;
  total?: number;
}
export interface InvoiceImportResult {
  lines: Array<{ selection: Selection; qty: number; unit_price: number; currency: string }>;
  document: InvoiceImportDocument;
}

interface ExtractLine {
  ref: string;
  group: number;
  order_no: string;
  title: string;
  name_en: string;
  name_ar: string;
  sku: string;
  option: string;
  color: string;
  qty: number;
  unit_price: number;
  line_total: number;
  warnings: string[];
}
interface ExtractAnswer {
  job_id: string;
  document: InvoiceImportDocument;
  lines: ExtractLine[];
  notes: string[];
  rejected: number;
}
interface MatchAnswer {
  lines: Array<{ ref: string; key: string | null; confidence: 'high' | 'medium' | 'low' | null; via: 'sku' | 'ai' | null }>;
  groups: Array<{ index: number; keys: string[] }>;
  selections: Record<string, Selection>;
}
interface Row {
  line: ExtractLine;
  key: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  manual: boolean;
  qty: string;
  unit: string;
  skip: boolean;
}
interface Picked {
  id: string;
  file: File;
  url: string;
  pdf: boolean;
}
interface Part {
  label: string;
  media_type: string;
  data: string;
}

const MAX_PARTS = 20;
/** The long side a picture is read at without the provider shrinking it. */
const MAX_SIDE = 1568;
/** A tall capture is cut into parts of this height (after scaling), overlapping so no row is cut in half unseen. */
const SLICE = 1500;
const OVERLAP = 90;
const MAX_PART_BYTES = 3_600_000;
const MAX_PDF_BYTES = 12_000_000;
const EXTRACT_TIMEOUT_MS = 200_000;
const MATCH_TIMEOUT_MS = 130_000;

const keyOf = (s: Pick<Selection, 'product_id' | 'scope' | 'scope_id'>) => `${s.product_id}|${s.scope}|${s.scope_id ?? ''}`;
const newKey = () => `inv_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;
const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
const fmt = (v: number, cur: string) => `${(Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${cur}`;

function rowValid(r: Row): boolean {
  const q = num(r.qty);
  const u = num(r.unit);
  return Number.isSafeInteger(q) && q > 0 && Number.isFinite(u) && u >= 0;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function decode(file: File): Promise<{ draw: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file);
    return { draw: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    // Safari / HEIC: the <img> decoder knows more formats than createImageBitmap.
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    return { draw: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality));
}

/** One picture → one or more JPEG parts: scaled to MAX_SIDE wide at most, a tall one cut into overlapping slices. */
async function pictureParts(file: File): Promise<Part[]> {
  const img = await decode(file);
  try {
    const scale = Math.min(1, MAX_SIDE / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const starts: number[] = [];
    if (h <= MAX_SIDE) starts.push(0);
    else for (let y = 0; y < h; y += SLICE - OVERLAP) {
      starts.push(y);
      if (y + SLICE >= h) break;
    }
    const parts: Part[] = [];
    for (const [i, y] of starts.entries()) {
      const sh = Math.min(h <= MAX_SIDE ? h : SLICE, h - y);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = sh;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, sh);
      ctx.drawImage(img.draw, 0, y / scale, img.width, sh / scale, 0, 0, w, sh);
      let blob = await canvasBlob(canvas, 0.9);
      if (blob.size > MAX_PART_BYTES) blob = await canvasBlob(canvas, 0.72);
      const label = starts.length > 1 ? `${file.name} — part ${i + 1} of ${starts.length} of one tall capture` : file.name;
      parts.push({ label, media_type: 'image/jpeg', data: await blobToBase64(blob) });
    }
    return parts;
  } finally {
    img.close();
  }
}

export default function PurchaseInvoiceImport({ currency, onAdd }: { currency: string; onAdd: (result: InvoiceImportResult) => void }) {
  const { loc } = useLabels();
  const { lang } = useLanguage();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [stage, setStage] = useState<'pick' | 'preparing' | 'reading' | 'matching' | 'review'>('pick');
  const [error, setError] = useState<{ text: string; settings?: boolean } | null>(null);
  const [extract, setExtract] = useState<ExtractAnswer | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [groupKeys, setGroupKeys] = useState<Record<number, string[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    if (stage !== 'reading' && stage !== 'matching' && stage !== 'preparing') return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const busy = stage === 'preparing' || stage === 'reading' || stage === 'matching';

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next: Picked[] = [];
    for (const file of Array.from(list)) {
      const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!pdf && !file.type.startsWith('image/') && !/\.(heic|heif|png|jpe?g|webp)$/i.test(file.name)) continue;
      const url = pdf ? '' : URL.createObjectURL(file);
      if (url) urls.current.push(url);
      next.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, url, pdf });
    }
    setPicked((p) => [...p, ...next]);
    setError(null);
  }

  function remove(id: string) {
    setPicked((p) => {
      const gone = p.find((x) => x.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return p.filter((x) => x.id !== id);
    });
  }

  function errorOf(e: unknown): { text: string; settings?: boolean } {
    const code = e instanceof ApiError ? e.code : undefined;
    const settings = loc(
      'اضبط مفتاح Anthropic والنموذج من إعدادات استوديو Levonis الإبداعي.',
      'Set the Anthropic key and model in Levonis Creative Studio settings.',
      'کلیلی Anthropic و مۆدێل لە ڕێکخستنەکانی ستۆدیۆی داهێنەری Levonis دابنێ.'
    );
    switch (code) {
      case 'KEY_NOT_CONFIGURED':
        return { text: `${loc('لا يوجد مفتاح ذكاء اصطناعي مضبوط.', 'No AI key is configured.', 'هیچ کلیلێکی زیرەکی دەستکرد دانەنراوە.')} ${settings}`, settings: true };
      case 'MODEL_NOT_SELECTED':
        return { text: `${loc('لم يُختر نموذج الذكاء الاصطناعي بعد.', 'No AI model is chosen yet.', 'هێشتا مۆدێلی زیرەکی دەستکرد هەڵنەبژێردراوە.')} ${settings}`, settings: true };
      case 'MODEL_NO_VISION':
        return { text: `${loc('النموذج المختار لا يقرأ الصور.', 'The chosen model cannot read pictures.', 'مۆدێلی هەڵبژێردراو ناتوانێت وێنە بخوێنێتەوە.')} ${settings}`, settings: true };
      case 'CREATIVE_SCHEMA_MISSING':
        return { text: loc('جداول الاستوديو الإبداعي غير مثبتة على قاعدة البيانات بعد.', 'The Creative Studio tables are not installed yet.', 'خشتەکانی ستۆدیۆی داهێنەر هێشتا دانەمەزراون.') };
      case 'BUDGET_EXCEEDED':
        return { text: loc('ميزانية الذكاء الاصطناعي لهذا اليوم انتهت.', "Today's AI budget is used up.", 'بودجەی زیرەکی دەستکردی ئەمڕۆ تەواو بووە.'), settings: true };
      case 'PARALLEL_LIMIT':
      case 'PROVIDER_RATE_LIMITED':
      case 'PROVIDER_OVERLOADED':
        return { text: loc('الخدمة مشغولة الآن؛ أعد المحاولة بعد لحظات.', 'The service is busy; try again in a moment.', 'خزمەتگوزارییەکە ئێستا سەرقاڵە؛ دوای کەمێک دووبارە هەوڵ بدەرەوە.') };
      case 'PROVIDER_TIMEOUT':
      case 'TIMEOUT':
        return { text: loc('استغرقت القراءة وقتًا طويلًا. جرّب صورًا أقل في المرة الواحدة.', 'The reading took too long. Try fewer pictures at a time.', 'خوێندنەوەکە زۆری خایاند. وێنەی کەمتر لە یەک جاردا تاقی بکەرەوە.') };
      case 'OUTPUT_TRUNCATED':
        return { text: loc('الطلب كبير جدًا لقراءة واحدة؛ قسّم الصور على دفعتين.', 'Too many rows for one reading; split the pictures into two batches.', 'ڕیزەکان بۆ یەک خوێندنەوە زۆرن؛ وێنەکان بکە بە دوو بەش.') };
      case 'INVALID_OUTPUT':
        return { text: loc('لم يُعثر على أسطر شراء مقروءة في هذه الملفات.', 'No readable purchase rows were found in these files.', 'هیچ ڕیزێکی کڕینی خوێندراوە لەم فایلانەدا نەدۆزرایەوە.') };
      case 'PROVIDER_REFUSED':
        return { text: loc('رفض النموذج قراءة هذه الملفات.', 'The model declined to read these files.', 'مۆدێلەکە خوێندنەوەی ئەم فایلانەی ڕەتکردەوە.') };
      case 'IMPORT_TOO_LARGE':
      case 'IMPORT_TOO_MANY_FILES':
        return { text: loc('الملفات كبيرة أو كثيرة على قراءة واحدة؛ أرسلها على دفعتين.', 'Too many or too large files for one reading; send them in two batches.', 'فایلەکان بۆ یەک خوێندنەوە زۆر یان گەورەن؛ بە دوو بەش بینێرە.') };
      default:
        return { text: operationErrorText(e, lang) };
    }
  }

  async function run() {
    if (!picked.length || busy) return;
    setError(null);
    setStage('preparing');
    let parts: Part[] = [];
    try {
      for (const p of picked) {
        if (p.pdf) {
          if (p.file.size > MAX_PDF_BYTES) throw new Error(loc(`الملف ${p.file.name} أكبر من 12 ميغابايت`, `${p.file.name} is larger than 12 MB`, `${p.file.name} لە 12 مێگابایت گەورەترە`));
          parts.push({ label: p.file.name, media_type: 'application/pdf', data: await blobToBase64(p.file) });
        } else parts.push(...(await pictureParts(p.file)));
      }
      if (parts.length > MAX_PARTS) {
        throw new Error(
          loc(
            `الصور تنتج ${parts.length} جزءًا والحد ${MAX_PARTS}؛ أرسلها على دفعتين.`,
            `These pictures make ${parts.length} parts; the limit is ${MAX_PARTS}. Send them in two batches.`,
            `ئەم وێنانە ${parts.length} بەش دروست دەکەن؛ سنوور ${MAX_PARTS}ە. بە دوو بەش بینێرە.`
          )
        );
      }
    } catch (e) {
      setStage('pick');
      setError(e instanceof ApiError ? errorOf(e) : { text: e instanceof Error && e.message !== 'encode' ? e.message : loc('تعذّر تجهيز إحدى الصور.', 'One of the pictures could not be prepared.', 'یەکێک لە وێنەکان ئامادە نەکرا.') });
      return;
    }
    let ex: ExtractAnswer;
    try {
      setStage('reading');
      ex = await api.post<ExtractAnswer>(`${PROCUREMENT}/import/extract`, { idempotency_key: newKey(), files: parts }, { timeoutMs: EXTRACT_TIMEOUT_MS });
      parts = [];
    } catch (e) {
      setStage('pick');
      setError(errorOf(e));
      return;
    }
    setExtract(ex);
    const base: Row[] = ex.lines.map((line) => ({ line, key: null, confidence: null, manual: false, qty: String(line.qty), unit: String(line.unit_price), skip: false }));
    setRows(base);
    try {
      setStage('matching');
      const m = await api.post<MatchAnswer>(`${PROCUREMENT}/import/match`, { job_id: ex.job_id, idempotency_key: newKey() }, { timeoutMs: MATCH_TIMEOUT_MS });
      const by = new Map(m.lines.map((l) => [l.ref, l]));
      setSelections(m.selections);
      setGroupKeys(Object.fromEntries(m.groups.map((g) => [g.index, g.keys])));
      setRows(base.map((r) => ({ ...r, key: by.get(r.line.ref)?.key ?? null, confidence: by.get(r.line.ref)?.confidence ?? null })));
    } catch (e) {
      // The reading is kept: every row can still be matched by hand.
      setError({
        text: `${loc('قُرئت الفاتورة لكن المطابقة مع الكتالوج لم تكتمل؛ اختر المنتجات يدويًا.', 'The invoice was read but catalogue matching failed; pick the products by hand.', 'پسوولەکە خوێندرایەوە بەڵام هاوتاکردن لەگەڵ کاتالۆگ سەرنەکەوت؛ بەرهەمەکان بە دەست هەڵبژێرە.')} ${errorOf(e).text}`,
      });
    }
    setStage('review');
  }

  function patch(ref: string, change: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.line.ref === ref ? { ...r, ...change } : r)));
  }

  function pick(ref: string, s: Selection | null) {
    if (!s) return;
    const k = keyOf(s);
    setSelections((m) => ({ ...m, [k]: s }));
    patch(ref, { key: k, confidence: 'high', manual: true, skip: false });
    setEditing(null);
  }

  function reset() {
    picked.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    setPicked([]);
    setExtract(null);
    setRows([]);
    setSelections({});
    setGroupKeys({});
    setEditing(null);
    setError(null);
    setStage('pick');
  }

  // A currency the reading could not name (OTHER) is never passed up: the prices are taken in the purchase's own.
  const unknownCurrency = extract?.document.currency === 'OTHER';
  const docCurrency = !extract || unknownCurrency ? currency : extract.document.currency;
  const ready = rows.filter((r) => !r.skip && r.key && selections[r.key] && rowValid(r));
  const unmatched = rows.filter((r) => !r.skip && (!r.key || !selections[r.key])).length;
  const invalid = rows.filter((r) => !r.skip && r.key && !rowValid(r)).length;

  const totals = useMemo(() => {
    if (!extract) return null;
    // The invoice covers every row it lists, skipped or not: the check reads them all.
    const lines = rows.reduce((a, r) => a + (rowValid(r) ? num(r.qty) * num(r.unit) : 0), 0);
    const d = extract.document;
    const expected = lines + (d.shipping ?? 0) - (d.discount ?? 0);
    const diff = d.total === undefined ? null : expected - d.total;
    return { lines, expected, diff, mismatch: diff !== null && Math.abs(diff) > Math.max(0.5, (d.total ?? 0) * 0.01) };
  }, [rows, extract]);

  function add() {
    if (!extract || !ready.length) return;
    const merged = new Map<string, { selection: Selection; qty: number; unit_price: number; currency: string }>();
    for (const r of ready) {
      const unit = num(r.unit);
      const k = `${r.key}|${unit}`;
      const prev = merged.get(k);
      if (prev) prev.qty += num(r.qty);
      else merged.set(k, { selection: selections[r.key!], qty: num(r.qty), unit_price: unit, currency: docCurrency });
    }
    onAdd({ lines: [...merged.values()], document: { ...extract.document, currency: docCurrency } });
    reset();
  }

  const stageText =
    stage === 'preparing'
      ? loc('تجهيز الصور…', 'Preparing pictures…', 'ئامادەکردنی وێنەکان…')
      : stage === 'reading'
        ? loc('قراءة المنتجات والأسعار…', 'Reading products and prices…', 'خوێندنەوەی بەرهەم و نرخەکان…')
        : loc('مطابقة المنتجات مع الكتالوج…', 'Matching products to the catalogue…', 'هاوتاکردنی بەرهەمەکان لەگەڵ کاتالۆگ…');

  const confText = (c: Row['confidence']) =>
    c === 'high'
      ? loc('مطابقة مؤكدة', 'Sure match', 'هاوتای دڵنیا')
      : c === 'medium'
        ? loc('مطابقة محتملة', 'Likely match', 'هاوتای ئەگەری')
        : loc('تحقق منها', 'Check it', 'پشکنینی بکە');

  return (
    <section className={`${T.surface} grid gap-3 p-3 sm:p-4`} aria-busy={busy}>
      <div className="grid gap-1">
        <h3 className={`font-bold ${T.text1}`}>{loc('إضافة المنتجات من صور الطلب أو الفاتورة', 'Add products from order screenshots or invoice', 'زیادکردنی بەرهەم لە وێنەی داواکاری یان پسوولە')}</h3>
        <p className={`text-xs ${T.text3}`}>
          {loc(
            'ارفع لقطات طلبات 1688 / Taobao أو فاتورة PDF؛ يقرأ النظام المنتجات والألوان والكميات وسعر الشراء، ثم تراجعها قبل الإضافة.',
            'Upload 1688 / Taobao order screenshots or a PDF invoice; the system reads products, colours, quantities and purchase prices, and you review them before adding.',
            'وێنەی داواکارییەکانی 1688 / Taobao یان پسوولەی PDF باربکە؛ سیستەم بەرهەم، ڕەنگ، بڕ و نرخی کڕین دەخوێنێتەوە و تۆ پێش زیادکردن پێیاندا دەچیتەوە.'
          )}
        </p>
      </div>

      {error && (
        <div role="alert" className="lv-alert lv-alert-danger text-sm text-text-primary">
          {error.text}{' '}
          {error.settings && (
            <a className="underline" href="/admin/creative-studio">
              {loc('فتح الإعدادات', 'Open settings', 'کردنەوەی ڕێکخستنەکان')}
            </a>
          )}
        </div>
      )}

      {stage !== 'review' && (
        <>
          <div
            className={`grid place-items-center gap-2 rounded-[var(--ap-radius-md)] border border-dashed border-[var(--ap-border)] p-4 text-center ${busy ? 'opacity-60' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy) addFiles(e.dataTransfer.files);
            }}
          >
            <p className={`text-sm ${T.text2}`}>{loc('اسحب الصور أو ملفات PDF هنا', 'Drop pictures or PDF files here', 'وێنە یان فایلی PDF ڕابکێشە ئێرە')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className={T.btnSecondary} disabled={busy} onClick={() => fileInput.current?.click()}>
                {loc('اختيار ملفات', 'Choose files', 'هەڵبژاردنی فایل')}
              </button>
              <button type="button" className={`${T.btnSecondary} sm:hidden`} disabled={busy} onClick={() => cameraInput.current?.click()}>
                {loc('التقاط صورة', 'Take a photo', 'گرتنی وێنە')}
              </button>
            </div>
            <input ref={fileInput} type="file" multiple accept="image/*,application/pdf,.pdf" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label={loc('الملفات المختارة', 'Chosen files', 'فایلە هەڵبژێردراوەکان')}>
              {picked.map((p) => (
                <li key={p.id} className="relative h-20 w-16 overflow-hidden rounded-[var(--ap-radius-sm)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)]">
                  {p.pdf ? (
                    <span className={`grid h-full place-items-center p-1 text-center text-[10px] ${T.text2}`}>PDF<br />{p.file.name.slice(0, 18)}</span>
                  ) : (
                    <img src={p.url} alt={p.file.name} className="h-full w-full object-cover object-top" />
                  )}
                  {!busy && (
                    <button
                      type="button"
                      className="absolute end-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-xs text-white"
                      aria-label={loc(`إزالة ${p.file.name}`, `Remove ${p.file.name}`, `لابردنی ${p.file.name}`)}
                      onClick={() => remove(p.id)}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={T.btnPrimary} disabled={!picked.length || busy} onClick={() => void run()}>
              {loc('استخراج المنتجات', 'Extract products', 'دەرهێنانی بەرهەمەکان')}
            </button>
            {busy && (
              <span role="status" className={`text-sm ${T.text2}`}>
                {stageText} {seconds > 0 ? `${seconds}s` : ''}
              </span>
            )}
          </div>
        </>
      )}

      {stage === 'review' && extract && (
        <>
          <dl className={`grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4 ${T.text2}`}>
            {extract.document.supplier && (
              <div className="col-span-2">
                <dt className={T.text3}>{loc('المورد', 'Supplier', 'دابینکەر')}</dt>
                <dd className={`break-words ${T.text1}`}>{extract.document.supplier}</dd>
              </div>
            )}
            {extract.document.order_no && (
              <div className="col-span-2">
                <dt className={T.text3}>{loc('رقم الطلب', 'Order no.', 'ژمارەی داواکاری')}</dt>
                <dd className={`break-all ${T.text1}`}>{extract.document.order_no}</dd>
              </div>
            )}
            {extract.document.date && (
              <div>
                <dt className={T.text3}>{loc('التاريخ', 'Date', 'بەروار')}</dt>
                <dd className={T.text1}>{extract.document.date}</dd>
              </div>
            )}
            <div>
              <dt className={T.text3}>{loc('العملة', 'Currency', 'دراو')}</dt>
              <dd className={T.text1}>{docCurrency}</dd>
            </div>
          </dl>

          {unknownCurrency && (
            <p role="status" className="lv-alert lv-alert-warning text-sm text-text-primary">
              {loc(
                `لم تُعرف عملة الفاتورة؛ اعتُبرت الأسعار بعملة الشراء ${currency}. تحقق منها.`,
                `The invoice currency was not recognised; prices are taken as ${currency}, the purchase currency. Check them.`,
                `دراوی پسوولەکە نەناسرایەوە؛ نرخەکان بە دراوی کڕین ${currency} دانران. بیانپشکنە.`
              )}
            </p>
          )}
          {docCurrency !== currency && (
            <p role="status" className="lv-alert lv-alert-warning text-sm text-text-primary">
              {loc(
                `عملة الفاتورة ${docCurrency} وعملة الشراء الحالية ${currency}. عند الإضافة تُضبط عملة الشراء على ${docCurrency}.`,
                `The invoice is in ${docCurrency} and the purchase is in ${currency}. Adding sets the purchase currency to ${docCurrency}.`,
                `پسوولەکە بە ${docCurrency}یە و کڕینەکە بە ${currency}. زیادکردن دراوی کڕین دەکاتە ${docCurrency}.`
              )}
            </p>
          )}

          {(extract.rejected > 0 || extract.notes.length > 0) && (
            <div className="lv-alert lv-alert-info text-xs text-text-primary">
              {extract.rejected > 0 && (
                <p>
                  {loc(
                    `${extract.rejected} سطرًا لم تُقرأ أرقامه بوضوح ولم يُضف؛ راجع الصورة وأضفه يدويًا.`,
                    `${extract.rejected} row(s) had unreadable figures and were left out; check the picture and add them by hand.`,
                    `${extract.rejected} ڕیز ژمارەکانی ڕوون نەبوون و زیاد نەکران؛ وێنەکە بپشکنە و بە دەست زیادیان بکە.`
                  )}
                </p>
              )}
              {extract.notes.map((n, i) => (
                <p key={i} dir="auto">{n}</p>
              ))}
            </div>
          )}

          <ul className="grid gap-2">
            {rows.map((r) => {
              const s = r.key ? selections[r.key] : undefined;
              const alts = (groupKeys[r.line.group] ?? []).filter((k) => selections[k]);
              const q = num(r.qty);
              const u = num(r.unit);
              const total = Number.isFinite(q) && Number.isFinite(u) ? q * u : null;
              return (
                <li key={r.line.ref} className={`grid gap-2 rounded-[var(--ap-radius-md)] border p-2.5 ${r.skip ? 'border-[var(--ap-border)] opacity-55' : s ? 'border-[var(--ap-border)]' : 'border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)]'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`truncate text-xs ${T.text3}`} dir="auto" title={r.line.title}>{r.line.title || r.line.name_en}</p>
                      <p className={`text-sm ${T.text1}`} dir="auto">
                        {[lang === 'en' ? r.line.name_en || r.line.name_ar : r.line.name_ar || r.line.name_en, r.line.option, r.line.color].filter(Boolean).join(' · ')}
                      </p>
                      {r.line.warnings.includes('LINE_TOTAL_MISMATCH') && (
                        <p className="text-xs text-[var(--ap-warning)]">
                          {loc(
                            `مجموع السطر في الصورة ${fmt(r.line.line_total, docCurrency)} لا يساوي الكمية × السعر`,
                            `The row total in the picture (${fmt(r.line.line_total, docCurrency)}) is not qty × price`,
                            `کۆی ڕیز لە وێنەکەدا (${fmt(r.line.line_total, docCurrency)}) یەکسان نییە بە بڕ × نرخ`
                          )}
                        </p>
                      )}
                    </div>
                    <button type="button" className={T.btnGhostSm} onClick={() => patch(r.line.ref, { skip: !r.skip })}>
                      {r.skip ? loc('إرجاع', 'Include', 'گەڕاندنەوە') : loc('تخطي', 'Skip', 'تێپەڕاندن')}
                    </button>
                  </div>

                  {!r.skip && (
                    <>
                      <div className="flex items-center gap-2">
                        {s?.image_url ? <VariantImg sizes="40px" src={s.image_url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" /> : <span className="h-10 w-10 shrink-0 rounded bg-[var(--ap-surface-2)]" aria-hidden />}
                        <div className="min-w-0 flex-1">
                          {s ? (
                            <>
                              <p className={`text-sm ${T.text1}`}>{s.label}{s.sku ? ` · ${s.sku}` : ''}</p>
                              <p className={`text-xs ${r.confidence === 'low' ? 'text-[var(--ap-warning)]' : T.text3}`}>{r.manual ? loc('اخترته يدويًا', 'Picked by hand', 'بە دەست هەڵبژێردرا') : confText(r.confidence)}</p>
                            </>
                          ) : (
                            <p className="text-sm text-[var(--ap-warning)]">
                              {loc('لا يوجد منتج مطابق في الكتالوج — اختره يدويًا أو تخطَّ السطر.', 'No matching catalogue product — pick it by hand or skip the row.', 'هیچ بەرهەمێکی هاوتا لە کاتالۆگدا نییە — بە دەست هەڵیبژێرە یان ڕیزەکە تێپەڕێنە.')}
                            </p>
                          )}
                        </div>
                        <button type="button" className={T.btnGhostSm} aria-expanded={editing === r.line.ref} onClick={() => setEditing(editing === r.line.ref ? null : r.line.ref)}>
                          {s ? loc('تغيير', 'Change', 'گۆڕین') : loc('اختيار', 'Pick', 'هەڵبژاردن')}
                        </button>
                      </div>

                      {editing === r.line.ref && (
                        <div className="grid gap-2 rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] p-2">
                          {alts.length > 0 && (
                            <label className="grid gap-1 text-sm">
                              <span className={T.text2}>{loc('اقتراحات لهذا المنتج', 'Suggestions for this product', 'پێشنیارەکان بۆ ئەم بەرهەمە')}</span>
                              <select className={T.select} value={r.key ?? ''} onChange={(e) => pick(r.line.ref, selections[e.target.value] ?? null)}>
                                <option value="">{loc('اختر…', 'Choose…', 'هەڵبژێرە…')}</option>
                                {alts.map((k) => (
                                  <option key={k} value={k}>
                                    {selections[k].label}{selections[k].sku ? ` · ${selections[k].sku}` : ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <StockSelection value={s ?? null} onChange={(v) => pick(r.line.ref, v)} />
                        </div>
                      )}

                      <div className="grid grid-cols-3 items-end gap-2">
                        <label className="grid gap-1 text-xs">
                          <span className={T.text3}>{loc('الكمية', 'Qty', 'بڕ')}</span>
                          <input className={T.input} inputMode="numeric" value={r.qty} aria-invalid={!(Number.isSafeInteger(q) && q > 0)} onChange={(e) => patch(r.line.ref, { qty: e.target.value })} />
                        </label>
                        <label className="grid gap-1 text-xs">
                          <span className={T.text3}>{loc(`سعر الوحدة (${docCurrency})`, `Unit price (${docCurrency})`, `نرخی یەکە (${docCurrency})`)}</span>
                          <input className={T.input} inputMode="decimal" value={r.unit} aria-invalid={!(Number.isFinite(u) && u >= 0)} onChange={(e) => patch(r.line.ref, { unit: e.target.value })} />
                        </label>
                        <div className="grid gap-1 text-xs">
                          <span className={T.text3}>{loc('المجموع', 'Total', 'کۆ')}</span>
                          <span className={`py-2 text-sm ${T.text1}`}>{total === null ? '—' : fmt(total, docCurrency)}</span>
                        </div>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          {totals && (
            <div className={`grid gap-1 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-2.5 text-sm ${T.text2}`}>
              <p>{loc('مجموع الأسطر', 'Lines total', 'کۆی ڕیزەکان')}: <b className={T.text1}>{fmt(totals.lines, docCurrency)}</b></p>
              {extract.document.shipping !== undefined && <p>{loc('الشحن', 'Shipping', 'گەیاندن')}: {fmt(extract.document.shipping, docCurrency)}</p>}
              {extract.document.discount !== undefined && <p>{loc('الخصم / الرصيد', 'Discount / credit', 'داشکاندن / باڵانس')}: −{fmt(extract.document.discount, docCurrency)}</p>}
              {extract.document.total !== undefined ? (
                <p>
                  {loc('المدفوع في الفاتورة', 'Paid on the invoice', 'پارەی دراو لە پسوولەدا')}: <b className={T.text1}>{fmt(extract.document.total, docCurrency)}</b>
                </p>
              ) : (
                <p className={T.text3}>{loc('لم يظهر المجموع المدفوع لكل الطلبات؛ لا يمكن التحقق من المجموع.', 'The paid total is not shown for every order; the total cannot be checked.', 'کۆی دراو بۆ هەموو داواکارییەکان دەرنەکەوت؛ ناتوانرێت کۆکە بپشکنرێت.')}</p>
              )}
              {totals.mismatch && totals.diff !== null && (
                <p role="status" className="lv-alert lv-alert-warning text-sm text-text-primary">
                  {loc(
                    `الأسطر + الشحن − الخصم = ${fmt(totals.expected, docCurrency)} وتختلف عن المدفوع بـ ${fmt(Math.abs(totals.diff), docCurrency)}. قد يكون سطر ناقصًا (صورة لم تُرفع) أو مقروءًا خطأ.`,
                    `Lines + shipping − discount = ${fmt(totals.expected, docCurrency)}, ${fmt(Math.abs(totals.diff), docCurrency)} off the paid total. A row may be missing (a picture not uploaded) or misread.`,
                    `ڕیزەکان + گەیاندن − داشکاندن = ${fmt(totals.expected, docCurrency)}، ${fmt(Math.abs(totals.diff), docCurrency)} جیاوازە لە کۆی دراو. لەوانەیە ڕیزێک کەم بێت (وێنەیەک بارنەکرابێت) یان هەڵە خوێندرابێتەوە.`
                  )}
                </p>
              )}
              {totals.diff !== null && !totals.mismatch && <p className="text-xs">{loc('المجموع يطابق الفاتورة.', 'The total agrees with the invoice.', 'کۆکە لەگەڵ پسوولەکە دەگونجێت.')}</p>}
              {(extract.document.shipping ?? 0) > 0 && (
                <p className={`text-xs ${T.text3}`}>
                  {loc('الشحن والخصم لا يُضافان كأسطر؛ أدخلهما في رسوم الشراء.', 'Shipping and discount are not added as lines; enter them in the purchase charges.', 'گەیاندن و داشکاندن وەک ڕیز زیاد ناکرێن؛ لە تێچووەکانی کڕیندا بیاننووسە.')}
                </p>
              )}
            </div>
          )}

          {(unmatched > 0 || invalid > 0) && (
            <p className={`text-xs ${T.text3}`}>
              {unmatched > 0 && loc(`${unmatched} سطرًا بلا منتج لن يُضاف. `, `${unmatched} row(s) without a product will not be added. `, `${unmatched} ڕیز بێ بەرهەم زیاد ناکرێن. `)}
              {invalid > 0 && loc(`${invalid} سطرًا كميته أو سعره غير صحيح.`, `${invalid} row(s) have an invalid quantity or price.`, `${invalid} ڕیز بڕ یان نرخیان هەڵەیە.`)}
            </p>
          )}

          <div className="sticky bottom-0 flex flex-wrap gap-2 bg-[var(--ap-surface-1)] py-2">
            <button type="button" className={`${T.btnPrimary} flex-1 sm:flex-none`} disabled={!ready.length} onClick={add}>
              {loc(`إضافة ${ready.length} منتجات للشراء`, `Add ${ready.length} items to the purchase`, `زیادکردنی ${ready.length} بەرهەم بۆ کڕین`)}
            </button>
            <button type="button" className={T.btnSecondary} onClick={reset}>
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
