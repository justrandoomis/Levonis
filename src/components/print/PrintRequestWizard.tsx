/**
 * THE PRINT REQUEST WIZARD — give us the thing, tell us what you need, see the
 * price, publish.
 *
 * "Complex underneath. Extremely simple above." Everything hard happens on the
 * Worker — the file is measured there, the estimate is computed there, the
 * merchants are matched there. What the customer sees is three screens and one
 * number.
 *
 * WHY THE REQUEST IS CREATED BEFORE STEP 2. A file belongs to a request, so the
 * request has to exist before anything can be uploaded, and nothing can be
 * measured until it is uploaded. Measuring a 40 MB mesh is the slow part of this
 * whole flow, so it is started the moment step 1 is finished and runs while the
 * customer is busy choosing a material — by the time they reach the price, the
 * geometry is already known.
 *
 * WHY THE ROW IS FINISHED AT PUBLISH TIME. The request row is created at the end
 * of step 1, before the customer has picked a material or a governorate — the
 * owner refused to make those mandatory, so they belong in step 2. They travel
 * to the server on the publish call, which writes them onto that same row before
 * it matches: the governorate and the delivery preference decide which merchants
 * are eligible at all, and the budget is what the public board card shows. It is
 * one request throughout; nothing here creates a second one.
 *
 * THE COMPLETENESS METER IS NOT A GATE. The owner was explicit: unnecessary
 * detail must never be mandatory. The meter says "more detail buys you a better
 * price"; it never blocks the publish button, and the publish button never waits
 * on it.
 *
 * THE 3D VIEW IS A LINK, NOT A COMPONENT. This wizard mints a short-lived token
 * and opens the viewer in its own tab. It does not import a renderer: a mesh
 * viewer inside the request form would drag a WebGL stack into the storefront
 * bundle for a button most customers never press.
 *
 * SORANI. `loc(ar, en)` falls back to the Arabic — the source language — when no
 * ckb string is given, which is the documented behaviour and the honest one. The
 * copy here is long and technical; a machine translation of it would be worse
 * than the fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  Upload, Link2, Loader2, Check, ChevronDown, ChevronLeft, X, Box, FileText,
  Sparkles, Info, AlertTriangle, Ruler, Timer, Boxes, Eye, Send, Trash2,
  Layers, Weight, Palette, CircleCheck,
} from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, formatIqd } from '../../lib/api';
import { GOVERNORATES } from '../../lib/governorates';
import { UnauthorizedState } from '../ui/AsyncStates';
import { MAX_ATTACHMENTS, formatBytes, uploadRequestFiles, type RequestFile } from '../media/RequestAttachments';

// ------------------------------------------------------------------ the shapes

type Loc = (ar: string, en: string, ckb?: string) => string;
type Step = 1 | 2 | 3;
type Source = 'upload' | 'link';
type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
type Process = 'fdm' | 'resin';

interface Vec3 { x: number; y: number; z: number }

interface FormatCapability {
  previewable: boolean;
  measurable: boolean;
  sliceable: boolean;
  convertible: boolean;
  reference_only: boolean;
}

type WarningCode =
  | 'NOT_WATERTIGHT' | 'ZERO_VOLUME' | 'INVERTED_NORMALS' | 'VERY_LARGE' | 'VERY_SMALL'
  | 'THIN_FEATURES' | 'HEAVY_OVERHANG' | 'MANY_PARTS' | 'TOPOLOGY_NOT_ANALYSED'
  | 'HUGE_MESH' | 'UNIT_ASSUMED' | 'DEGENERATE_TRIANGLES';

interface ModelWarning {
  code: WarningCode;
  severity: 'info' | 'warning' | 'blocking';
  detail?: Record<string, number | string>;
}

/** Mirrors worker/lib/modelGeometry.ts — the server's measurement, read-only here. */
interface ModelAnalysis {
  format: string;
  capability: FormatCapability;
  measured: boolean;
  reason?: string;
  unit_source: 'declared' | 'assumed';
  dimensions_mm: Vec3;
  volume_mm3: number;
  surface_area_mm2: number;
  triangle_count: number;
  shell_count: number | null;
  watertight: boolean | null;
  overhang_ratio: number;
  complexity: number;
  warnings: ModelWarning[];
  title?: string;
}

/** Mirrors worker/lib/printPricing.ts, minus the cost lines the server strips. */
interface Quote {
  priced: boolean;
  reason?: string;
  process: Process;
  material_id: string;
  printed_volume_cm3: number;
  material_grams: number;
  print_time_minutes: number;
  total_time_minutes: number;
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  confidence: 'high' | 'medium' | 'low';
  confidence_reasons: string[];
  unit_price_iqd: number;
}

interface CatalogMaterial {
  id: string;
  process: Process;
  name_en: string;
  name_ar: string;
  needs_enclosure: boolean;
  abrasive: boolean;
}

interface Catalog {
  materials: CatalogMaterial[];
  processes: Process[];
  qualities: Array<{ id: Quality; layer_mm: number }>;
  capabilities: string[];
  formats: Array<{ id: string } & FormatCapability>;
  min_job_iqd: number;
}

interface ParsedLink { provider: string; external_id: string; canonical_url: string; host: string }

interface LinkInfo {
  resolved: boolean;
  reason?: string;
  provider: string;
  external_id: string;
  url: string;
  name?: string;
  creator?: string;
  images?: string[];
  estimated_weight_g?: number;
  estimated_time_minutes?: number;
  license?: string;
}

// ------------------------------------------------------------------ constants

/**
 * Wider than RequestAttachments' own list, because the print pipeline reads
 * formats the plain marketplace attachment picker never offered: AMF and glTF
 * measure, and STEP is accepted as a drawing. Kept in step with
 * worker/lib/attachments.ts, which is the real gate.
 */
const ACCEPT = '.stl,.3mf,.obj,.amf,.glb,.gltf,.step,.stp,.jpg,.jpeg,.png,.webp,.gif,.pdf';
const MODEL_EXTS = ['stl', '3mf', 'obj', 'amf', 'glb', 'gltf', 'step', 'stp'];
/** STEP is boundary-representation CAD. We store it and show it; we cannot measure it. */
const REFERENCE_ONLY_EXTS = ['step', 'stp'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const IMAGE_MAX = 8 * 1024 * 1024;
const MODEL_MAX = 40 * 1024 * 1024;

const extOf = (name: string) => name.toLowerCase().split('.').pop() ?? '';

const SWATCHES: Array<{ hex: string; ar: string; en: string }> = [
  { hex: '#1a1a1a', ar: 'أسود', en: 'Black' },
  { hex: '#f2f2f2', ar: 'أبيض', en: 'White' },
  { hex: '#808080', ar: 'رمادي', en: 'Grey' },
  { hex: '#d32f2f', ar: 'أحمر', en: 'Red' },
  { hex: '#1976d2', ar: 'أزرق', en: 'Blue' },
  { hex: '#388e3c', ar: 'أخضر', en: 'Green' },
  { hex: '#fbc02d', ar: 'أصفر', en: 'Yellow' },
  { hex: '#f57c00', ar: 'برتقالي', en: 'Orange' },
];

/** Quality as the customer experiences it. The layer height is the merchant's business. */
const QUALITY_COPY: Record<Quality, { ar: string; en: string; subAr: string; subEn: string }> = {
  draft: { ar: 'سريعة', en: 'Quick', subAr: 'الأسرع والأرخص', subEn: 'Fastest and cheapest' },
  standard: { ar: 'قياسية', en: 'Standard', subAr: 'مناسبة لأغلب القطع', subEn: 'Right for most parts' },
  fine: { ar: 'دقيقة', en: 'Fine', subAr: 'تفاصيل أوضح', subEn: 'Crisper detail' },
  ultra: { ar: 'دقيقة جدًا', en: 'Very fine', subAr: 'أعلى تفصيل، ووقت أطول', subEn: 'Highest detail, longest time' },
};

/**
 * What a measurement warning means to somebody who is not a printer operator.
 * Never the raw code, and never an alarm — most of these are things a merchant
 * fixes without thinking about it.
 */
function warningText(w: ModelWarning, loc: Loc): string {
  const d = w.detail ?? {};
  switch (w.code) {
    case 'NOT_WATERTIGHT':
      return loc(
        'المجسم ليس مغلقًا تمامًا. غالبًا يصلحه التاجر قبل الطباعة، لكن التقدير أقل دقة قليلًا.',
        'The mesh is not fully closed. A merchant usually repairs this before printing, but the estimate is slightly less precise.'
      );
    case 'ZERO_VOLUME':
      return loc(
        'لم نستطع حساب حجم لهذا الملف، لذلك لا يمكن تقدير سعره من الملف نفسه.',
        'We could not compute any volume from this file, so it cannot be priced from the file itself.'
      );
    case 'INVERTED_NORMALS':
      return loc(
        'بعض أسطح المجسم متجهة إلى الداخل. مشكلة شائعة ويصلحها التاجر بسهولة.',
        'Some surfaces face inwards. A common thing, and easy for a merchant to fix.'
      );
    case 'VERY_LARGE':
      return loc(
        `القطعة كبيرة (${d.largest_mm ?? '—'} ملم في أطول بُعد). قد تحتاج طابعة كبيرة أو تقسيمها إلى أجزاء.`,
        `This is large (${d.largest_mm ?? '—'} mm at its longest). It may need a big printer, or splitting into parts.`
      );
    case 'VERY_SMALL':
      return loc(
        `القطعة صغيرة جدًا (${d.largest_mm ?? '—'} ملم). قد تختفي بعض التفاصيل في الطباعة.`,
        `This is very small (${d.largest_mm ?? '—'} mm). Fine detail may not survive printing.`
      );
    case 'THIN_FEATURES':
      return loc(
        'فيه أجزاء رفيعة جدًا قد تنكسر. اذكر في الوصف إن كانت القطعة ستتحمل جهدًا.',
        'It has very thin areas that could snap. Say in your description if the part will take any load.'
      );
    case 'HEAVY_OVERHANG':
      return loc(
        'فيه أجزاء بارزة كثيرة، لذلك سيحتاج دعامات — وهذا مضاف إلى التقدير.',
        'It has a lot of overhang, so it will need supports — that is already in the estimate.'
      );
    case 'MANY_PARTS':
      return loc(
        `الملف يحتوي على ${d.parts ?? 'عدة'} قطعة منفصلة. إن كانت مجموعة واحدة فاذكر ذلك في الوصف.`,
        `The file contains ${d.parts ?? 'several'} separate bodies. If they belong together, say so in your description.`
      );
    case 'TOPOLOGY_NOT_ANALYSED':
      return loc(
        'المجسم أكبر من أن نفحص بنيته بالكامل. الأبعاد والحجم دقيقة، وما لم نفحصه هو الإغلاق وعدد القطع فقط.',
        'The model was too big for a full structural check. The size and volume are exact; only the closure and part count went unchecked.'
      );
    case 'HUGE_MESH':
      return loc(
        `الملف ثقيل (${d.triangles ?? '—'} مثلث). سيعمل، لكنه قد يبطئ برنامج التاجر.`,
        `This is a heavy file (${d.triangles ?? '—'} triangles). It works, but it may slow the merchant's software.`
      );
    case 'UNIT_ASSUMED':
      return loc(
        'هذه الصيغة لا تذكر وحدة القياس، فاعتمدنا المليمتر. إن كان المقاس مختلفًا فاذكره في الوصف.',
        'This format does not state its unit, so we read it as millimetres. If the scale is different, say so in your description.'
      );
    case 'DEGENERATE_TRIANGLES':
      return loc(
        `فيه ${d.count ?? 'بعض'} مثلثات فارغة في الشبكة. لا تؤثر على السعر عادةً.`,
        `There are ${d.count ?? 'some'} empty triangles in the mesh. Usually harmless.`
      );
    default:
      return '';
  }
}

/** Why the link lookup came back empty. Every one of these is a fact, not a fault. */
function linkReasonText(reason: string | undefined, loc: Loc): string {
  if (!reason) return '';
  if (reason.startsWith('HTTP_')) {
    const code = reason.slice(5);
    return loc(`رد الموقع بالرمز ${code}.`, `The site answered with status ${code}.`);
  }
  switch (reason) {
    case 'NO_API_CONFIGURED':
      return loc('هذا الموقع غير مربوط بخدمة بيانات لدينا بعد.', 'We are not connected to this site’s data service yet.');
    case 'PROVIDER_NOT_ENABLED':
      return loc('قراءة التفاصيل من هذا الموقع غير مفعّلة حاليًا.', 'Reading details from this site is switched off right now.');
    case 'NO_MODEL_ID_IN_URL':
      return loc('الرابط لا يحتوي على رقم المجسم.', 'The link does not carry a model id.');
    case 'TIMEOUT':
      return loc('الموقع تأخر في الرد.', 'The site took too long to answer.');
    case 'FETCH_FAILED':
      return loc('تعذّر الوصول إلى الموقع الآن.', 'We could not reach the site just now.');
    case 'NOT_JSON':
      return loc('رد الموقع بصيغة لا نقرأها.', 'The site answered in a format we do not read.');
    case 'UNRECOGNISED_SHAPE':
      return loc('رد الموقع، لكن ببيانات بشكل غير متوقع.', 'The site answered, but not in a shape we recognise.');
    case 'BAD_URL':
      return loc('هذا لا يبدو رابط مجسم.', 'That does not look like a model link.');
    default:
      return '';
  }
}

function minutesLabel(mins: number, loc: Loc): string {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h <= 0) return loc(`${r} دقيقة`, `${r} min`);
  return r ? loc(`${h} ساعة و${r} دقيقة`, `${h}h ${r}m`) : loc(`${h} ساعة`, `${h}h`);
}

// ------------------------------------------------------------------ the wizard

export default function PrintRequestWizard({
  onCreated,
  onCancel,
}: {
  onCreated: (requestId: string) => void;
  onCancel: () => void;
}) {
  const { loc, lang } = useLanguage();

  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<Source>('upload');
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [error, setError] = useState('');

  // ---- step 1
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [link, setLink] = useState<{ link: ParsedLink; info: LinkInfo } | null>(null);
  /**
   * The cover the source's API named, if it named one, and whether it loaded.
   *
   * `https` only, and that is not caution for its own sake: the page is served
   * over https, so an `http` image is simply blocked by the browser, and a
   * `data:` or relative string from somebody else's API is not a picture of
   * anything. `pickImages` on the worker applies the same rule; this repeats
   * it because what is rendered must be decided where it is rendered.
   */
  const linkCover = (() => {
    const first = link?.info.images?.[0] ?? '';
    return /^https:\/\//i.test(first) ? first : '';
  })();
  const [coverFailed, setCoverFailed] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // ---- what the server made of it
  const [requestId, setRequestId] = useState('');
  const [progress, setProgress] = useState<'' | 'creating' | 'uploading' | 'measuring'>('');
  const [uploaded, setUploaded] = useState<RequestFile[]>([]);
  const [primaryFileId, setPrimaryFileId] = useState('');
  const [analysis, setAnalysis] = useState<ModelAnalysis | null>(null);
  /** Typed by the customer when the file is CAD we cannot measure. Feeds `volume_cm3`. */
  const [volumeCm3, setVolumeCm3] = useState('');

  // ---- step 2
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [spec, setSpec] = useState({
    process: 'fdm' as Process,
    material_id: '',
    quality: 'standard' as Quality,
    infill_percent: 20,
    supports: true,
    colors_count: 1,
    post_processing_minutes: 0,
    quantity: 1,
    color_hex: '',
    color_name: '',
  });
  const [extras, setExtras] = useState({ governorate: '', delivery_pref: '', budget_iqd: '', deadline: '' });

  // ---- step 3
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{ notified: number } | null>(null);

  /** One place that decides whether a thrown error is "you are signed out". */
  const report = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof ApiError && e.status === 401) {
        setSignInNeeded(true);
        return;
      }
      setError(e instanceof ApiError ? e.message : fallback);
    },
    []
  );

  useEffect(() => {
    api
      .get<Catalog>('/api/marketplace/print/catalog')
      .then((d) => {
        setCatalog(d);
        // Pick a sane default so the estimate has something to work with the
        // moment the geometry lands — the customer can change it in one tap.
        const first = d.materials.find((m) => m.process === 'fdm') ?? d.materials[0];
        if (first) setSpec((s) => (s.material_id ? s : { ...s, material_id: first.id, process: first.process }));
      })
      .catch(() => setCatalog(null));
  }, []);

  // ------------------------------------------------------------- files

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    setFileError('');
    const room = MAX_ATTACHMENTS - files.length;
    if (room <= 0) {
      setFileError(loc(`الحد الأقصى ${MAX_ATTACHMENTS} ملفات.`, `At most ${MAX_ATTACHMENTS} files.`));
      return;
    }
    const accepted: File[] = [];
    let rejected = '';
    for (const f of Array.from(list).slice(0, room)) {
      const ext = extOf(f.name);
      if (![...MODEL_EXTS, ...IMAGE_EXTS, 'pdf'].includes(ext)) {
        rejected = loc(
          'نوع غير مدعوم — ارفع STL أو 3MF أو OBJ أو AMF أو GLB أو STEP، أو صورة أو PDF.',
          'Unsupported type — upload an STL, 3MF, OBJ, AMF, GLB or STEP model, or an image or PDF.'
        );
        continue;
      }
      const max = IMAGE_EXTS.includes(ext) ? IMAGE_MAX : MODEL_MAX;
      if (f.size > max) {
        rejected = loc(
          `الملف أكبر من ${max / 1024 / 1024} ميغابايت.`,
          `That file is larger than ${max / 1024 / 1024} MB.`
        );
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
    if (rejected) setFileError(rejected);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function checkLink() {
    if (!linkUrl.trim()) return;
    setLinkBusy(true);
    setError('');
    try {
      const d = await api.post<{ link: ParsedLink; info: LinkInfo }>('/api/marketplace/print/link', {
        url: linkUrl.trim(),
      });
      setLink(d);
      setCoverFailed(false);
      // The provider knows the model's own name; offering it saves typing and
      // is far more useful to a merchant than "طلب طباعة".
      if (!title.trim() && d.info.name) setTitle(d.info.name.slice(0, 140));
    } catch (e) {
      setLink(null);
      report(e, loc('تعذّر فحص الرابط', 'Could not check that link'));
    } finally {
      setLinkBusy(false);
    }
  }

  // ------------------------------------------------------- create + measure

  const step1Ready =
    title.trim().length >= 4 &&
    title.trim().length <= 140 &&
    description.trim().length >= 10 &&
    (source === 'upload' ? files.length > 0 : !!link);

  /**
   * Everything the API insists happens in order: the request, then the files,
   * then the measurement. Runs once — coming back to step 1 does not create a
   * second request, and the files already on the server stay there.
   */
  async function prepare() {
    if (requestId) {
      setStep(2);
      return;
    }
    setError('');
    setProgress('creating');
    try {
      const created = await api.post<{ request: { id: string } }>('/api/marketplace/requests', {
        title: title.trim(),
        description: description.trim(),
        quantity: spec.quantity,
        budget_iqd: extras.budget_iqd === '' ? null : Number(extras.budget_iqd),
        material: spec.material_id,
        color: spec.color_name || spec.color_hex,
        dimensions: '',
        governorate: extras.governorate,
        delivery_pref: extras.delivery_pref,
        notes: source === 'link' ? linkUrl.trim() : '',
      });
      const id = created.request.id;
      setRequestId(id);

      if (source === 'upload' && files.length) {
        setProgress('uploading');
        const failed = await uploadRequestFiles(id, files);
        if (failed) {
          setError(loc(
            `تعذّر رفع ${failed} من الملفات. يمكنك إضافتها لاحقًا من صفحة الطلب.`,
            `${failed} file(s) did not upload. You can add them later from the request page.`
          ));
        }

        // The upload route answers one file at a time; reading the request back
        // is the only way to learn every id at once — and it is the same read
        // the request page does, so there is no second source of truth.
        setProgress('measuring');
        const back = await api.get<{ files: RequestFile[] }>(`/api/marketplace/requests/${id}`);
        const saved = back.files ?? [];
        setUploaded(saved);

        let primary = '';
        let primaryAnalysis: ModelAnalysis | null = null;
        for (const f of saved.filter((x) => x.kind === 'model')) {
          let a: ModelAnalysis | null = null;
          try {
            const r = await api.post<{ analysis: ModelAnalysis | null }>(
              `/api/marketplace/print/requests/${id}/files/${f.id}/analyze`
            );
            a = r.analysis;
          } catch {
            // One unreadable attachment does not sink the request; the merchant
            // still gets the file, and the wizard carries on with the rest.
            a = null;
          }
          // The first file we could actually measure is the one the price is
          // built on. A CAD drawing still becomes the primary file if it is all
          // we have, so the merchant has something to open.
          if (a?.measured) { primary = f.id; primaryAnalysis = a; break; }
          if (!primary) { primary = f.id; primaryAnalysis = a; }
        }
        setPrimaryFileId(primary);
        setAnalysis(primaryAnalysis);
      }
      setStep(2);
    } catch (e) {
      report(e, loc('تعذّر إنشاء الطلب', 'Could not create the request'));
    } finally {
      setProgress('');
    }
  }

  // --------------------------------------------------------------- the price

  const measurable = !!analysis?.measured;
  /** A STEP/STP drawing, or anything else the measurer declined. */
  const referenceOnly =
    (!!analysis && !analysis.measured) ||
    (source === 'upload' && !analysis && files.some((f) => REFERENCE_ONLY_EXTS.includes(extOf(f.name))));

  const quoteSeq = useRef(0);
  useEffect(() => {
    if (step < 2 || !requestId || !spec.material_id) return;
    const seq = quoteSeq.current + 1;
    quoteSeq.current = seq;
    // Debounced: a customer dragging the infill slider should produce one
    // estimate, not forty. Every keystroke that lands inside the window is
    // collapsed into the last one.
    const t = window.setTimeout(() => {
      setQuoting(true);
      const vol = Number(volumeCm3);
      api
        .post<{ quote: Quote }>('/api/marketplace/print/quote', {
          process: spec.process,
          material_id: spec.material_id,
          quality: spec.quality,
          infill_percent: spec.infill_percent,
          supports: spec.supports,
          colors_count: spec.colors_count,
          quantity: spec.quantity,
          post_processing_minutes: spec.post_processing_minutes,
          color_hex: spec.color_hex,
          color_name: spec.color_name,
          file_id: primaryFileId || undefined,
          volume_cm3: Number.isFinite(vol) && vol > 0 ? vol : undefined,
        })
        .then((d) => { if (seq === quoteSeq.current) setQuote(d.quote); })
        .catch((e) => {
          if (seq !== quoteSeq.current) return;
          setQuote(null);
          if (e instanceof ApiError && e.status === 401) setSignInNeeded(true);
        })
        .finally(() => { if (seq === quoteSeq.current) setQuoting(false); });
    }, 400);
    return () => window.clearTimeout(t);
  }, [step, requestId, spec, primaryFileId, volumeCm3]);

  /**
   * How much of the picture we have — encouragement, never a gate. Computed
   * here rather than asked for, so it moves the instant the customer touches
   * something. The server keeps its own copy for the record.
   */
  const completeness = useMemo(() => {
    let s = 0;
    if (source === 'upload' ? files.length > 0 : !!link) s += 40;
    if (spec.material_id) s += 15;
    if (spec.color_hex || spec.color_name) s += 10;
    if (spec.quality) s += 5;
    if (quote?.priced) s += 20;
    const filledExtras = [
      extras.governorate,
      extras.delivery_pref,
      extras.budget_iqd,
      extras.deadline,
      spec.post_processing_minutes > 0 ? 'x' : '',
    ].filter(Boolean).length;
    s += filledExtras * 2;
    return Math.min(100, s);
  }, [source, files.length, link, spec, quote, extras]);

  async function openViewer() {
    if (!requestId || !primaryFileId) return;
    setViewerBusy(true);
    setError('');
    try {
      const data = await api.post<{ url: string }>(
        `/api/marketplace/print/requests/${requestId}/files/${primaryFileId}/viewer-token`
      );
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      report(e, loc('تعذّر فتح العارض', 'Could not open the viewer'));
    } finally {
      setViewerBusy(false);
    }
  }

  async function publish() {
    if (!requestId) return;
    setPublishing(true);
    setError('');
    try {
      const vol = Number(volumeCm3);
      const d = await api.post<{
        quote: Quote;
        completeness: number;
        matching: { considered: number; eligible: number; notified: number };
      }>(`/api/marketplace/print/requests/${requestId}/publish`, {
        process: spec.process,
        material_id: spec.material_id,
        quality: spec.quality,
        infill_percent: spec.infill_percent,
        supports: spec.supports,
        colors_count: spec.colors_count,
        quantity: spec.quantity,
        post_processing_minutes: spec.post_processing_minutes,
        color_hex: spec.color_hex,
        color_name: spec.color_name,
        volume_cm3: Number.isFinite(vol) && vol > 0 ? vol : undefined,
        primary_file_id: primaryFileId || undefined,
        source_kind: source,
        source_url: source === 'link' ? (link?.link.canonical_url || linkUrl.trim()) : '',
        // The step-2 answers the request row was created too early to hold.
        // `publish` writes them onto that same row before it matches, because
        // the governorate and the delivery preference decide WHICH merchants
        // are eligible, and the budget is what the public board card shows.
        governorate: extras.governorate,
        delivery_pref: extras.delivery_pref,
        budget_iqd: extras.budget_iqd === '' ? null : Number(extras.budget_iqd),
        deadline: extras.deadline,
        // `source_meta` keeps what it is actually for: where the model came
        // from, when it came from somebody else's site.
        source_meta: {
          provider: link?.link.provider ?? '',
          external_id: link?.link.external_id ?? '',
          name: link?.info.name ?? '',
          creator: link?.info.creator ?? '',
          // «البيانات فقط، والصورة بالرابط» — the cover travels as a LINK to
          // the source's own CDN and is never downloaded, never re-hosted and
          // never written to R2. The merchant sees the same picture the
          // customer confirmed; the shop stores no bytes it has no licence to,
          // and nothing goes stale when the designer replaces the render. The
          // server keeps it only if it is an absolute https URL.
          image_url: linkCover,
          resolved: link?.info.resolved ?? false,
        },
      });
      setQuote(d.quote);
      setPublished({ notified: d.matching.notified });
    } catch (e) {
      report(e, loc('تعذّر نشر الطلب', 'Could not publish the request'));
    } finally {
      setPublishing(false);
    }
  }

  // The success panel is the last thing the customer reads, so it stays on
  // screen long enough to be read before the page hands over to the request.
  useEffect(() => {
    if (!published || !requestId) return;
    const t = window.setTimeout(() => onCreated(requestId), 6000);
    return () => window.clearTimeout(t);
  }, [published, requestId, onCreated]);

  // ------------------------------------------------------------------ render

  const materials = catalog?.materials ?? [];
  const material = materials.find((m) => m.id === spec.material_id) ?? null;
  const govLabel = (id: string) => {
    const g = GOVERNORATES.find((x) => x.id === id);
    return g ? (lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar) : id;
  };
  /** formatIqd speaks Arabic; English gets the Latin form the rest of the app uses. */
  const money = (n: number) => loc(formatIqd(n), `${Math.round(n).toLocaleString('en-US')} IQD`);

  if (published) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        data-wizard="published"
        className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-5 text-center"
      >
        <CircleCheck className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
        <p className="text-white font-bold text-[15px] leading-relaxed mb-2">
          تم نشر طلبك. سيقوم Levonis بإشعار التجار الذين تتوافق إمكانياتهم مع طلبك، وستظهر عروضهم هنا.
        </p>
        <p className="text-zinc-400 text-[12.5px] leading-relaxed mb-4">
          Your request is published. Levonis will notify the merchants whose capabilities match it,
          and their offers will appear here.
        </p>
        {published.notified > 0 && (
          <p className="text-emerald-300/90 text-[12px] mb-4" dir="ltr">
            {loc(`أُشعر ${published.notified} تاجرًا`, `${published.notified} merchants notified`)}
          </p>
        )}
        <button
          type="button"
          data-wizard="open-request"
          onClick={() => onCreated(requestId)}
          className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px]"
        >
          {loc('اذهب إلى طلبي', 'Go to my request')}
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4"
    >
      {/* ---------------------------------------------------------- stepper */}
      <div className="flex items-center justify-between gap-2">
        <div
          className="flex items-center gap-1.5 min-w-0 overflow-x-auto hide-scrollbar"
          data-wizard="stepper"
          data-wizard-active={step}
        >
          {([1, 2, 3] as Step[]).map((n) => {
            const done = n < step;
            const active = n === step;
            return (
              <button
                key={n}
                type="button"
                data-wizard-step={n}
                data-active={active ? 'true' : 'false'}
                aria-current={active ? 'step' : undefined}
                // Going back is always allowed; going forward is what `prepare`
                // is for, so a tap ahead of the flow does nothing.
                onClick={() => { if (n < step) setStep(n); }}
                disabled={n > step}
                className={`flex items-center gap-1.5 px-2.5 min-h-[34px] rounded-xl border text-[11.5px] font-semibold transition-colors ${
                  active
                    ? 'border-gold/40 bg-gold/10 text-gold'
                    : done
                      ? 'border-white/10 bg-white/[0.04] text-zinc-300'
                      : 'border-white/5 bg-transparent text-zinc-600'
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                    done ? 'bg-emerald-500/20 text-emerald-400' : active ? 'bg-gold/20 text-gold' : 'bg-white/5 text-zinc-600'
                  }`}
                  dir="ltr"
                >
                  {done ? <Check className="w-2.5 h-2.5" /> : n}
                </span>
                {/* Three full labels plus a close button do not fit at 390px,
                    so away from the current step only the number survives. */}
                <span className={`truncate max-w-[86px] ${active ? '' : 'hidden sm:inline'}`}>
                  {n === 1
                    ? loc('ملفك أو رابطك', 'Your file or link')
                    : n === 2
                      ? loc('تفاصيل الطباعة', 'Print details')
                      : loc('السعر والنشر', 'Price and publish')}
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" data-wizard="cancel" onClick={onCancel} className="text-zinc-500 shrink-0" aria-label={loc('إغلاق', 'Close')}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {signInNeeded && <UnauthorizedState next="/requests" compact />}

      {/* ============================================================ step 1 */}
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-gold font-bold text-[14px]">{loc('ملفك أو رابطك', 'Your file or link')}</h2>

          <div className="grid grid-cols-2 gap-2">
            {(['upload', 'link'] as Source[]).map((s) => (
              <button
                key={s}
                type="button"
                data-wizard-source={s}
                data-active={source === s ? 'true' : 'false'}
                onClick={() => setSource(s)}
                disabled={!!requestId}
                className={`rounded-2xl border p-3 text-start transition-colors disabled:opacity-50 ${
                  source === s ? 'border-gold/40 bg-gold/[0.07]' : 'border-white/10 bg-black/30'
                }`}
              >
                {s === 'upload' ? (
                  <Upload className={`w-4 h-4 mb-1.5 ${source === s ? 'text-gold' : 'text-zinc-500'}`} />
                ) : (
                  <Link2 className={`w-4 h-4 mb-1.5 ${source === s ? 'text-gold' : 'text-zinc-500'}`} />
                )}
                <p className="text-white text-[12.5px] font-semibold">
                  {s === 'upload' ? loc('ارفع ملفًا', 'Upload a file') : loc('الصق رابطًا', 'Paste a link')}
                </p>
                <p className="text-zinc-500 text-[11px] leading-relaxed mt-0.5">
                  {s === 'upload'
                    ? loc('STL، 3MF، OBJ، STEP، صورة أو PDF', 'STL, 3MF, OBJ, STEP, an image or a PDF')
                    : loc('MakerWorld، Printables، Thingiverse…', 'MakerWorld, Printables, Thingiverse…')}
                </p>
              </button>
            ))}
          </div>

          {source === 'upload' ? (
            <div>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                className={`relative rounded-2xl border border-dashed p-5 text-center transition-colors ${
                  dragging ? 'border-gold/50 bg-gold/[0.06]' : 'border-white/15 bg-white/[0.02]'
                }`}
              >
                <Upload className="w-6 h-6 text-zinc-500 mx-auto mb-2" />
                <p className="text-zinc-300 text-[12.5px] font-semibold">
                  {loc('اسحب ملفك إلى هنا، أو اضغط للاختيار', 'Drop your file here, or tap to choose')}
                </p>
                <p className="text-zinc-600 text-[11px] mt-1">
                  {loc(
                    `حتى ${MAX_ATTACHMENTS} ملفات · المجسم حتى ٤٠ ميغابايت، الصورة حتى ٨`,
                    `Up to ${MAX_ATTACHMENTS} files · models up to 40 MB, images up to 8`
                  )}
                </p>
                {/* A real file input stretched over the box: one control does
                    both the click and the accessible label, and drag-and-drop
                    is handled by the wrapper. */}
                <input
                  ref={fileInput}
                  type="file"
                  data-wizard="file-input"
                  accept={ACCEPT}
                  multiple
                  disabled={!!requestId}
                  onChange={(e) => addFiles(e.target.files)}
                  aria-label={loc('اختر ملفًا', 'Choose a file')}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                />
              </div>

              {files.length > 0 && (
                <div className="space-y-2 mt-2">
                  {files.map((f, i) => (
                    <div
                      key={`${f.name}-${i}`}
                      data-wizard="file"
                      className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-3 py-2.5"
                    >
                      {IMAGE_EXTS.includes(extOf(f.name)) ? (
                        <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                      ) : (
                        <Box className="w-4 h-4 text-zinc-500 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-zinc-200 text-[12.5px] truncate">{f.name}</p>
                        <p className="text-zinc-600 text-[11px]" dir="ltr">{formatBytes(f.size)}</p>
                      </div>
                      {!requestId && (
                        <button
                          type="button"
                          data-wizard="file-remove"
                          onClick={() => setFiles(files.filter((_, j) => j !== i))}
                          className="text-red-300/80 shrink-0"
                          aria-label={loc('إزالة', 'Remove')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {fileError && <p className="text-red-400 text-[11.5px] mt-2">{fileError}</p>}
            </div>
          ) : (
            <div>
              <div className="flex gap-2">
                <input
                  data-wizard="link-url"
                  value={linkUrl}
                  onChange={(e) => { setLinkUrl(e.target.value); setLink(null); setCoverFailed(false); }}
                  disabled={!!requestId}
                  dir="ltr"
                  inputMode="url"
                  placeholder="https://makerworld.com/models/…"
                  className="flex-1 min-w-0 min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[13px] outline-none focus:border-gold/40 disabled:opacity-50"
                />
                <button
                  type="button"
                  data-wizard="link-check"
                  onClick={checkLink}
                  disabled={linkBusy || !linkUrl.trim() || !!requestId}
                  className="shrink-0 px-4 min-h-[48px] rounded-2xl bg-olive text-white text-[12.5px] font-bold flex items-center gap-1.5 disabled:opacity-40"
                >
                  {linkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                  {loc('افحص الرابط', 'Check the link')}
                </button>
              </div>

              {link && (
                <div className="rounded-2xl border border-white/10 bg-black/30 p-3 mt-2" data-wizard="link-result">
                  <div className="flex items-start gap-3">
                    {/*
                      THE PICTURE IS THE CONFIRMATION. A customer pasting a
                      link is saying "print me this one", and a name and a
                      creator are a poor way to check that the shop understood
                      which one. It is loaded straight from the source's own
                      CDN — never downloaded, never copied into R2 — which is
                      the owner's decision on this and also why it is `https`
                      only and carries no referrer. If it fails to load, the
                      row silently loses the thumbnail and keeps everything
                      else: a broken frame would look like a broken request.
                    */}
                    {linkCover && !coverFailed && (
                      <img
                        data-wizard="link-cover"
                        src={linkCover}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        onError={() => setCoverFailed(true)}
                        className="w-14 h-14 rounded-xl object-cover bg-black/40 border border-white/10 shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <p className="text-zinc-200 text-[12.5px] font-semibold truncate">
                          {link.info.name || link.link.host}
                        </p>
                      </div>
                      {link.info.creator && (
                        <p className="text-zinc-500 text-[11.5px]">
                          {loc('التصميم لـ', 'Designed by')} {link.info.creator}
                        </p>
                      )}
                      <a
                        href={link.link.canonical_url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        dir="ltr"
                        className="text-zinc-500 hover:text-zinc-300 text-[11px] truncate block mt-0.5 transition-colors"
                      >
                        {link.link.host}
                      </a>
                    </div>
                  </div>
                  {!link.info.resolved && (
                    <p className="text-zinc-400 text-[11.5px] leading-relaxed mt-1.5">
                      {loc(
                        'قرأنا الرابط نفسه فقط ولم نستطع قراءة تفاصيل المجسم من الموقع.',
                        'We read the link itself, but could not read the model’s details from the site.'
                      )}{' '}
                      {linkReasonText(link.info.reason, loc)}{' '}
                      {loc(
                        'طلبك يعمل بشكل طبيعي؛ التقدير فقط سيكون أقل دقة.',
                        'Your request works normally; the estimate will simply be less precise.'
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <F label={loc('ماذا تريد أن نطبع؟', 'What would you like printed?')} required>
            <input
              data-wizard="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              disabled={!!requestId}
              placeholder={loc('مثال: حامل هاتف للسيارة', 'e.g. A phone holder for the car')}
              className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40 disabled:opacity-60"
            />
          </F>

          <F label={loc('اشرح لنا باختصار', 'Tell us briefly')} required>
            <textarea
              data-wizard="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={6000}
              disabled={!!requestId}
              placeholder={loc(
                'لأي شيء ستستخدمه؟ هل يتحمل وزنًا؟ أي مقاس مهم؟',
                'What is it for? Does it take any weight? Any size that matters?'
              )}
              className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 resize-none disabled:opacity-60"
            />
          </F>

          {!!requestId && (
            <p className="text-zinc-500 text-[11.5px] leading-relaxed">
              {loc(
                'طلبك أُنشئ بالفعل وملفاتك مرفوعة، لذلك لا يمكن تعديل هذا الجزء هنا — يمكنك تعديله من صفحة الطلب بعد النشر.',
                'Your request already exists and your files are uploaded, so this part is fixed here — you can edit it from the request page after publishing.'
              )}
            </p>
          )}

          {progress && (
            <div className="rounded-2xl border border-gold/25 bg-gold/[0.05] px-4 py-3 flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 text-gold animate-spin shrink-0" />
              <p className="text-zinc-300 text-[12.5px]">
                {progress === 'creating'
                  ? loc('نُنشئ طلبك…', 'Creating your request…')
                  : progress === 'uploading'
                    ? loc('نرفع ملفاتك…', 'Uploading your files…')
                    : loc('نقيس المجسم — هذه أطول خطوة، وتستحق الانتظار.', 'Measuring your model — the slowest step, and the one worth waiting for.')}
              </p>
            </div>
          )}

          {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

          <button
            type="button"
            data-wizard="next"
            onClick={prepare}
            disabled={!step1Ready || !!progress}
            className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {progress ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {loc('التالي — تفاصيل الطباعة', 'Next — print details')}
          </button>
        </div>
      )}

      {/* ============================================================ step 2 */}
      {step === 2 && (
        <div className="space-y-4">
          <h2 className="text-gold font-bold text-[14px]">{loc('تفاصيل الطباعة', 'Print details')}</h2>

          {referenceOnly && (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-3.5" data-wizard="reference-only">
              <div className="flex items-start gap-2 mb-1.5">
                <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-amber-200 text-[12.5px] font-semibold">
                  {loc('لا نستطيع قياس ملفات CAD', 'We cannot measure CAD files')}
                </p>
              </div>
              <p className="text-zinc-300 text-[11.5px] leading-relaxed mb-3">
                {loc(
                  'ملفات STEP رسم هندسي وليست شبكة مثلثات، فلا يمكننا استخراج الحجم منها. سيصل الملف إلى التاجر كما هو وسيسعّره من الرسم. إن عرفت الحجم التقريبي فاكتبه، وسنعطيك تقديرًا مبدئيًا.',
                  'A STEP file is an engineering drawing, not a triangle mesh, so we cannot read a volume out of it. The merchant receives the file as it is and quotes from the drawing. If you know the rough volume, type it and we will give you a first estimate.'
                )}
              </p>
              <F label={loc('الحجم التقريبي (سم³) — اختياري', 'Approximate volume (cm³) — optional')}>
                <input
                  data-wizard="volume-cm3"
                  type="number"
                  min={0}
                  inputMode="decimal"
                  value={volumeCm3}
                  onChange={(e) => setVolumeCm3(e.target.value)}
                  dir="ltr"
                  className="w-full min-h-[46px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
                />
              </F>
            </div>
          )}

          {/* ---- the simple row: material, colour, quantity, quality ---- */}
          <F label={loc('المادة', 'Material')}>
            {materials.length === 0 ? (
              <p className="text-zinc-600 text-[12px]">{loc('جارٍ تحميل المواد…', 'Loading materials…')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {materials.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    data-wizard="material"
                    data-material-id={m.id}
                    data-active={spec.material_id === m.id ? 'true' : 'false'}
                    onClick={() => setSpec((s) => ({ ...s, material_id: m.id, process: m.process }))}
                    className={`px-3 min-h-[40px] rounded-2xl border text-[12.5px] font-semibold transition-colors ${
                      spec.material_id === m.id
                        ? 'border-gold/40 bg-gold/10 text-gold'
                        : 'border-white/10 bg-white/[0.03] text-zinc-400'
                    }`}
                  >
                    {loc(m.name_ar, m.name_en)}
                  </button>
                ))}
              </div>
            )}
            {material?.abrasive && (
              <p className="text-zinc-500 text-[11px] mt-1.5">
                {loc(
                  'هذه المادة كاشطة، وتحتاج طابعة مجهّزة لها — سنوجّه طلبك إلى تاجر يملكها.',
                  'This material is abrasive and needs a printer set up for it — we will route your request to a merchant who has one.'
                )}
              </p>
            )}
          </F>

          <F label={loc('اللون', 'Colour')}>
            <div className="flex flex-wrap items-center gap-2">
              {SWATCHES.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  data-wizard="color"
                  data-color-hex={c.hex}
                  data-active={spec.color_hex === c.hex ? 'true' : 'false'}
                  onClick={() => setSpec((s) => ({ ...s, color_hex: c.hex, color_name: loc(c.ar, c.en) }))}
                  title={loc(c.ar, c.en)}
                  aria-label={loc(c.ar, c.en)}
                  className={`w-9 h-9 rounded-full border-2 transition-transform ${
                    spec.color_hex === c.hex ? 'border-gold scale-110' : 'border-white/15'
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
              {/* The custom swatch: a native colour well, because a hex field is
                  a keyboard task and this is a phone. */}
              <label className="w-9 h-9 rounded-full border-2 border-dashed border-white/25 flex items-center justify-center cursor-pointer relative overflow-hidden">
                <Palette className="w-4 h-4 text-zinc-400" />
                <input
                  type="color"
                  data-wizard="color-custom"
                  value={spec.color_hex || '#808080'}
                  onChange={(e) => setSpec((s) => ({ ...s, color_hex: e.target.value.toLowerCase(), color_name: '' }))}
                  aria-label={loc('لون مخصص', 'Custom colour')}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              {spec.color_hex && (
                <span className="text-zinc-500 text-[11.5px]" dir="ltr">{spec.color_hex}</span>
              )}
            </div>
          </F>

          <div className="grid grid-cols-2 gap-3">
            <F label={loc('الكمية', 'Quantity')}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-wizard="quantity-dec"
                  onClick={() => setSpec((s) => ({ ...s, quantity: Math.max(1, s.quantity - 1) }))}
                  className="w-10 h-10 rounded-xl border border-white/10 bg-black/40 text-zinc-300 text-[16px] font-bold shrink-0"
                  aria-label={loc('أقل', 'Fewer')}
                >
                  −
                </button>
                <input
                  data-wizard="quantity"
                  type="number"
                  min={1}
                  value={spec.quantity}
                  onChange={(e) => setSpec((s) => ({ ...s, quantity: Math.max(1, Number(e.target.value) || 1) }))}
                  dir="ltr"
                  className="flex-1 min-w-0 min-h-[40px] rounded-xl bg-black/40 border border-white/10 px-2 text-center text-white text-[14px] outline-none focus:border-gold/40"
                />
                <button
                  type="button"
                  data-wizard="quantity-inc"
                  onClick={() => setSpec((s) => ({ ...s, quantity: s.quantity + 1 }))}
                  className="w-10 h-10 rounded-xl border border-white/10 bg-black/40 text-zinc-300 text-[16px] font-bold shrink-0"
                  aria-label={loc('أكثر', 'More')}
                >
                  +
                </button>
              </div>
            </F>
            <F label={loc('عدد الألوان', 'Colours')}>
              <input
                data-wizard="colors-count"
                type="number"
                min={1}
                max={16}
                value={spec.colors_count}
                onChange={(e) =>
                  setSpec((s) => ({ ...s, colors_count: Math.min(16, Math.max(1, Number(e.target.value) || 1)) }))
                }
                dir="ltr"
                className="w-full min-h-[40px] rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[14px] outline-none focus:border-gold/40"
              />
            </F>
          </div>

          <F label={loc('الجودة', 'Quality')}>
            <div className="grid grid-cols-2 gap-2">
              {(['draft', 'standard', 'fine', 'ultra'] as Quality[]).map((q) => (
                <button
                  key={q}
                  type="button"
                  data-wizard="quality"
                  data-quality={q}
                  data-active={spec.quality === q ? 'true' : 'false'}
                  onClick={() => setSpec((s) => ({ ...s, quality: q }))}
                  className={`rounded-2xl border p-2.5 text-start transition-colors ${
                    spec.quality === q ? 'border-gold/40 bg-gold/[0.07]' : 'border-white/10 bg-black/30'
                  }`}
                >
                  <p className={`text-[12.5px] font-semibold ${spec.quality === q ? 'text-gold' : 'text-zinc-200'}`}>
                    {loc(QUALITY_COPY[q].ar, QUALITY_COPY[q].en)}
                  </p>
                  <p className="text-zinc-500 text-[10.5px] leading-relaxed mt-0.5">
                    {loc(QUALITY_COPY[q].subAr, QUALITY_COPY[q].subEn)}
                  </p>
                </button>
              ))}
            </div>
          </F>

          {/* ---- everything else, folded away ---- */}
          <div data-wizard="advanced" data-open={advanced ? 'true' : 'false'}>
            <button
              type="button"
              data-wizard="advanced-toggle"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="w-full min-h-[44px] rounded-2xl border border-white/10 bg-white/[0.03] px-4 flex items-center justify-between text-zinc-300 text-[12.5px] font-semibold"
            >
              {loc('خيارات متقدمة', 'Advanced options')}
              <ChevronDown className={`w-4 h-4 transition-transform ${advanced ? 'rotate-180' : ''}`} />
            </button>

            {advanced && (
              <div data-wizard="advanced-panel" className="space-y-4 pt-4">
                <F label={loc(`نسبة التعبئة الداخلية — ${spec.infill_percent}٪`, `Infill — ${spec.infill_percent}%`)}>
                  <input
                    data-wizard="infill"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={spec.infill_percent}
                    onChange={(e) => setSpec((s) => ({ ...s, infill_percent: Number(e.target.value) }))}
                    className="w-full accent-gold"
                  />
                  <p className="text-zinc-600 text-[11px] mt-1">
                    {loc(
                      'أعلى = أقوى وأثقل وأغلى. ٢٠٪ تكفي لأغلب القطع.',
                      'Higher means stronger, heavier and dearer. 20% is enough for most parts.'
                    )}
                  </p>
                </F>

                <button
                  type="button"
                  data-wizard="supports"
                  data-active={spec.supports ? 'true' : 'false'}
                  aria-pressed={spec.supports}
                  onClick={() => setSpec((s) => ({ ...s, supports: !s.supports }))}
                  className="w-full min-h-[46px] rounded-2xl border border-white/10 bg-black/30 px-4 flex items-center justify-between"
                >
                  <span className="text-zinc-300 text-[12.5px] font-semibold text-start">
                    {loc('دعامات للأجزاء البارزة', 'Supports for overhanging parts')}
                  </span>
                  <span
                    className={`w-10 h-6 rounded-full flex items-center px-0.5 transition-colors ${
                      spec.supports ? 'bg-olive justify-end' : 'bg-white/10 justify-start'
                    }`}
                  >
                    <span className="w-5 h-5 rounded-full bg-white block" />
                  </span>
                </button>

                <div className="grid grid-cols-2 gap-3">
                  <F label={loc('تشطيب يدوي (دقائق)', 'Hand finishing (minutes)')}>
                    <input
                      data-wizard="post-minutes"
                      type="number"
                      min={0}
                      max={600}
                      value={spec.post_processing_minutes}
                      onChange={(e) =>
                        setSpec((s) => ({
                          ...s,
                          post_processing_minutes: Math.min(600, Math.max(0, Number(e.target.value) || 0)),
                        }))
                      }
                      dir="ltr"
                      className="w-full min-h-[46px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
                    />
                  </F>
                  <F label={loc('الميزانية (د.ع)', 'Budget (IQD)')}>
                    <input
                      data-wizard="budget"
                      type="number"
                      min={0}
                      value={extras.budget_iqd}
                      onChange={(e) => setExtras((x) => ({ ...x, budget_iqd: e.target.value }))}
                      dir="ltr"
                      className="w-full min-h-[46px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
                    />
                  </F>
                </div>

                <F label={loc('المحافظة', 'Governorate')}>
                  <select
                    data-wizard="governorate"
                    value={extras.governorate}
                    onChange={(e) => setExtras((x) => ({ ...x, governorate: e.target.value }))}
                    className="w-full min-h-[46px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
                  >
                    <option value="">{loc('اختر', 'Select')}</option>
                    {GOVERNORATES.map((g) => (
                      <option key={g.id} value={g.id} className="bg-[#0a0a0a]">
                        {govLabel(g.id)}
                      </option>
                    ))}
                  </select>
                </F>

                <F label={loc('كيف تفضّل الاستلام؟', 'How would you rather receive it?')}>
                  <div className="grid grid-cols-2 gap-2">
                    {([['delivery', 'توصيل إلى عنواني', 'Delivered to me'],
                       ['pickup', 'أستلم من التاجر', 'I collect from the merchant']] as const).map(([id, ar, en]) => (
                      <button
                        key={id}
                        type="button"
                        data-wizard="delivery"
                        data-delivery={id}
                        data-active={extras.delivery_pref === id ? 'true' : 'false'}
                        onClick={() =>
                          setExtras((x) => ({ ...x, delivery_pref: x.delivery_pref === id ? '' : id }))
                        }
                        className={`min-h-[46px] px-3 rounded-2xl border text-[12px] font-semibold transition-colors ${
                          extras.delivery_pref === id
                            ? 'border-gold/40 bg-gold/10 text-gold'
                            : 'border-white/10 bg-black/30 text-zinc-400'
                        }`}
                      >
                        {loc(ar, en)}
                      </button>
                    ))}
                  </div>
                </F>

                <F label={loc('تحتاجه قبل تاريخ؟', 'Need it before a date?')}>
                  <input
                    data-wizard="deadline"
                    type="date"
                    value={extras.deadline}
                    onChange={(e) => setExtras((x) => ({ ...x, deadline: e.target.value }))}
                    dir="ltr"
                    className="w-full min-h-[46px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
                  />
                </F>
              </div>
            )}
          </div>

          {/* ---- the meter, and the reason it exists ---- */}
          <div
            data-wizard="completeness"
            data-completeness={completeness}
            className="rounded-2xl border border-white/10 bg-black/30 p-3.5"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-zinc-300 text-[12px] font-semibold flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-gold" />
                {loc('اكتمال الطلب', 'Request completeness')}
              </span>
              <span className="text-gold text-[13px] font-bold" dir="ltr">{completeness}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <motion.div
                className="h-full bg-gold rounded-full"
                initial={false}
                animate={{ width: `${completeness}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <p className="text-zinc-400 text-[11.5px] leading-relaxed mt-2.5">
              كلما زادت المعلومات التي تضيفها، أصبح تسعير طلبك أسرع وأدق، وقد تحصل على تكلفة أفضل لأن Levonis
              يستطيع توجيه طلبك إلى التاجر الأكثر قدرة على تنفيذه.
            </p>
            <p className="text-zinc-500 text-[11px] leading-relaxed mt-1.5">
              The more information you add, the faster and more accurate your pricing becomes — and you may get a
              better cost, because Levonis can route your request to the merchant best able to make it.
            </p>
            <p className="text-zinc-600 text-[10.5px] mt-2">
              {loc('لا شيء من هذا إجباري.', 'None of this is required.')}
            </p>
          </div>

          {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              data-wizard="back"
              onClick={() => setStep(1)}
              className="shrink-0 px-4 min-h-[48px] rounded-2xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12.5px] font-semibold flex items-center gap-1.5"
            >
              <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
              {loc('رجوع', 'Back')}
            </button>
            <button
              type="button"
              data-wizard="next"
              onClick={() => setStep(3)}
              className="flex-1 min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px]"
            >
              {loc('التالي — السعر', 'Next — the price')}
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ step 3 */}
      {step === 3 && (
        <div className="space-y-4">
          <h2 className="text-gold font-bold text-[14px]">{loc('السعر والنشر', 'Price and publish')}</h2>

          {/* ---- what the file gave up ---- */}
          {/* Always rendered, even for a pasted link with nothing to measure:
              "we have no measurements" is itself a fact the customer needs
              before they read a price built without them. */}
          <div data-wizard="analysis" data-measured={measurable ? 'true' : 'false'} className="rounded-2xl border border-white/10 bg-black/30 p-3.5">
            <p className="text-zinc-300 text-[12px] font-semibold mb-2.5 flex items-center gap-1.5">
              <Ruler className="w-3.5 h-3.5 text-gold" />
              {analysis
                ? loc('ما قرأناه من ملفك', 'What we read from your file')
                : loc('القياسات', 'Measurements')}
            </p>

            {!analysis ? (
              <p className="text-zinc-400 text-[12px] leading-relaxed">
                {source === 'link'
                  ? loc(
                      'طلبك يعتمد على رابط، ولم نقس ملفًا. التاجر سيفتح المجسم من الموقع ويسعّره بنفسه.',
                      'Your request is based on a link, so nothing was measured here. The merchant opens the model on the site and prices it themselves.'
                    )
                  : loc(
                      'لا يوجد ملف يمكن قياسه في هذا الطلب. التاجر سيسعّره من الوصف والمرفقات.',
                      'There is no measurable file on this request. The merchant will price it from your description and attachments.'
                    )}
              </p>
            ) : null}

            {analysis && (
              <>
                {measurable ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Fact
                      icon={<Ruler className="w-3 h-3" />}
                      label={loc('الأبعاد (ملم)', 'Dimensions (mm)')}
                      value={`${analysis.dimensions_mm.x.toFixed(1)} × ${analysis.dimensions_mm.y.toFixed(1)} × ${analysis.dimensions_mm.z.toFixed(1)}`}
                    />
                    <Fact
                      icon={<Box className="w-3 h-3" />}
                      label={loc('الحجم', 'Volume')}
                      value={`${(analysis.volume_mm3 / 1000).toFixed(1)} cm³`}
                    />
                    <Fact
                      icon={<Boxes className="w-3 h-3" />}
                      label={loc('عدد القطع', 'Parts')}
                      value={analysis.shell_count === null ? loc('لم يُفحص', 'Not checked') : String(analysis.shell_count)}
                    />
                    <Fact
                      icon={<Layers className="w-3 h-3" />}
                      label={loc('مغلق تمامًا', 'Watertight')}
                      value={
                        analysis.watertight === null
                          ? loc('لم يُفحص', 'Not checked')
                          : analysis.watertight
                            ? loc('نعم', 'Yes')
                            : loc('لا', 'No')
                      }
                    />
                    {!!quote?.material_grams && (
                      <Fact
                        icon={<Weight className="w-3 h-3" />}
                        label={loc('الوزن التقديري', 'Estimated weight')}
                        value={`${quote.material_grams.toFixed(0)} g`}
                      />
                    )}
                    {!!quote?.print_time_minutes && (
                      <Fact
                        icon={<Timer className="w-3 h-3" />}
                        label={loc('زمن الطباعة التقديري', 'Estimated print time')}
                        value={minutesLabel(quote.print_time_minutes, loc)}
                      />
                    )}
                  </div>
                ) : (
                  <p className="text-zinc-400 text-[12px] leading-relaxed">
                    {loc(
                      'لم نقس هذا الملف. التاجر سيفتحه ويسعّره بنفسه.',
                      'We did not measure this file. The merchant will open it and price it themselves.'
                    )}
                  </p>
                )}

                {analysis.warnings.length > 0 && (
                  <div className="space-y-1.5 mt-3">
                    {analysis.warnings.map((w) => (
                      <div
                        key={w.code}
                        data-warning={w.code}
                        data-severity={w.severity}
                        className={`flex items-start gap-2 rounded-xl px-3 py-2 border ${
                          w.severity === 'blocking'
                            ? 'border-red-500/25 bg-red-500/[0.07]'
                            : w.severity === 'warning'
                              ? 'border-amber-500/25 bg-amber-500/[0.06]'
                              : 'border-white/10 bg-white/[0.02]'
                        }`}
                      >
                        {w.severity === 'info' ? (
                          <Info className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
                        ) : (
                          <AlertTriangle
                            className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                              w.severity === 'blocking' ? 'text-red-300' : 'text-amber-300'
                            }`}
                          />
                        )}
                        <p className="text-zinc-300 text-[11.5px] leading-relaxed">{warningText(w, loc)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {analysis.capability.previewable && !!primaryFileId && (
                  <button
                    type="button"
                    data-wizard="view-3d"
                    onClick={openViewer}
                    disabled={viewerBusy}
                    className="w-full min-h-[44px] mt-3 rounded-2xl border border-white/10 bg-white/[0.04] text-zinc-200 text-[12.5px] font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
                  >
                    {viewerBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                    {loc('مشاهدة المجسم ثلاثي الأبعاد', 'View in 3D')}
                  </button>
                )}
              </>
            )}
          </div>

          {/* ---- the estimate ---- */}
          <div
            data-wizard="estimate"
            data-estimate-confidence={quote?.priced ? quote.confidence : 'none'}
            className="rounded-2xl border border-gold/25 bg-gold/[0.05] p-4"
          >
            {quoting && !quote ? (
              <div className="flex items-center gap-2 text-zinc-400 text-[12.5px]">
                <Loader2 className="w-4 h-4 animate-spin text-gold" />
                {loc('نحسب التقدير…', 'Working out the estimate…')}
              </div>
            ) : quote?.priced ? (
              <>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <p className="text-zinc-400 text-[11.5px] font-semibold">
                    {loc('سعر Levonis التقديري', 'Levonis Estimated Price')}
                  </p>
                  <ConfidenceBadge confidence={quote.confidence} loc={loc} />
                </div>
                <p className="text-gold font-bold text-[20px] leading-tight" dir="ltr">
                  {Math.round(quote.price_low_iqd).toLocaleString('en-US')} – {money(quote.price_high_iqd)}
                </p>
                {spec.quantity > 1 && (
                  <p className="text-zinc-400 text-[11.5px] mt-1" dir="ltr">
                    {loc(`للقطعة الواحدة: ${money(quote.unit_price_iqd)}`, `Per piece: ${money(quote.unit_price_iqd)}`)}
                  </p>
                )}
                {!!quote.total_time_minutes && (
                  <p className="text-zinc-500 text-[11.5px] mt-1">
                    {loc('زمن التنفيذ التقديري:', 'Estimated time to make:')}{' '}
                    {minutesLabel(quote.total_time_minutes, loc)}
                  </p>
                )}
                <p className="text-zinc-400 text-[11.5px] leading-relaxed mt-2.5">
                  {loc(
                    'هذا تقدير من Levonis لمساعدتك على المقارنة — وليس عرض تاجر ولا سعرًا نهائيًا. السعر النهائي يأتي في عروض التجار، وأنت من يختار.',
                    'This is a Levonis estimate to help you compare — it is not a merchant’s offer and not a final price. The final price arrives in the merchants’ offers, and you choose.'
                  )}
                </p>
                {!!catalog?.min_job_iqd && (
                  <p className="text-zinc-600 text-[10.5px] mt-1.5">
                    {loc(
                      `الحد الأدنى لأي طلب طباعة هو ${money(catalog.min_job_iqd)}.`,
                      `The minimum for any print job is ${money(catalog.min_job_iqd)}.`
                    )}
                  </p>
                )}
              </>
            ) : (
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-gold shrink-0 mt-0.5" />
                <p className="text-zinc-300 text-[12.5px] leading-relaxed">
                  {quote?.reason === 'MATERIAL_UNKNOWN'
                    ? loc('اختر المادة لنحسب لك التقدير.', 'Pick a material and we will work the estimate out.')
                    : quote?.reason === 'NO_GEOMETRY'
                      ? loc(
                          'نحتاج قياسات المجسم. ارفع ملفًا يمكن قياسه، أو اكتب الحجم التقريبي بالسنتيمتر المكعب في الخطوة السابقة.',
                          'We need the model’s measurements. Upload a measurable file, or type an approximate volume in cm³ on the previous step.'
                        )
                      : loc(
                          'لا نستطيع حساب تقدير بهذه المعلومات بعد — وهذا لا يمنعك من النشر. التاجر سيسعّر طلبك.',
                          'We cannot work out an estimate from this yet — and that does not stop you publishing. A merchant will price it.'
                        )}
                </p>
              </div>
            )}
          </div>

          {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              data-wizard="back"
              onClick={() => setStep(2)}
              className="shrink-0 px-4 min-h-[48px] rounded-2xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12.5px] font-semibold flex items-center gap-1.5"
            >
              <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
              {loc('رجوع', 'Back')}
            </button>
            <button
              type="button"
              data-wizard="publish"
              onClick={publish}
              disabled={publishing}
              className="flex-1 min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {loc('انشر الطلب', 'Publish the request')}
            </button>
          </div>

          <p className="text-zinc-600 text-[11px] leading-relaxed text-center">
            {loc(
              'عند النشر يُشعر Levonis التجار المناسبين فقط. لا يُدفع أي مبلغ الآن.',
              'Publishing notifies only the merchants who fit. Nothing is charged now.'
            )}
          </p>
          {uploaded.length > 0 && (
            <p className="text-zinc-700 text-[10.5px] text-center" dir="ltr">
              {loc(`${uploaded.length} ملف مرفق`, `${uploaded.length} file(s) attached`)}
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ------------------------------------------------------------------- bits

function F({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
        {label}
        {required && <span className="text-gold ms-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/40 border border-white/5 px-3 py-2">
      <p className="text-zinc-600 text-[10.5px] mb-0.5 flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-zinc-200 text-[12px] font-semibold" dir="ltr">{value}</p>
    </div>
  );
}

/**
 * How much the estimate should be trusted, said in one word. It is the same
 * value the merchant sees on the request, so nobody is being told a different
 * story about the same number.
 */
function ConfidenceBadge({ confidence, loc }: { confidence: Quote['confidence']; loc: Loc }) {
  const cls =
    confidence === 'high'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
      : confidence === 'medium'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
        : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-300';
  const label =
    confidence === 'high'
      ? loc('ثقة عالية', 'High confidence')
      : confidence === 'medium'
        ? loc('ثقة متوسطة', 'Medium confidence')
        : loc('ثقة منخفضة', 'Low confidence');
  return (
    <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-full border ${cls}`}>{label}</span>
  );
}
