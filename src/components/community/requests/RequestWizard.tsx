/**
 * THE PRINT REQUEST WIZARD, v2 (stream W5-A; audit 03 §9 G1–G3, G5).
 *
 * Four short steps — what · how · where and when · review — and the request
 * is a DRAFT the whole way: nobody but the customer sees it until «انشر».
 *
 *   1. WHAT. Four ways to describe the job, all first-class: a model file, a
 *      link to one, reference pictures, or words alone (the old wizard knew
 *      only the first two). The draft is created when this step is done, so
 *      files have somewhere to live and a model is measured while the
 *      customer answers step 2.
 *   2. HOW. Process and material each have «لست متأكدًا» — the default — and
 *      nothing is auto-picked (the old wizard chose PLA for anyone who did
 *      not choose). Dimensions are typed when there is no model to measure;
 *      a measured model's size is shown instead. Notes for the merchants are
 *      their own field (the old one hid a link in `notes`).
 *   3. WHERE AND WHEN. Governorate, delivery or pickup, a real DATE for the
 *      deadline, and a budget — all optional.
 *   4. REVIEW. Everything on one screen, the Levonis estimate (a range when
 *      the material is open), and the two exits: «احفظ كمسودة» and «انشر».
 *
 * The same component edits a DRAFT (`requestId`) and a PUBLISHED request: for
 * the latter the last button is «احفظ التعديلات», and it warns first when
 * standing offers would be superseded by a change to what they priced.
 *
 * Every figure is the server's; this screen only collects answers.
 * Sorani: nothing here is machine-written (docs/DECISIONS.md row 11) — `loc`
 * falls back to the Arabic until the owner writes it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Check, FileText, Image as ImageIcon, Link2, Ruler, Trash2, Upload } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { GOVERNORATES } from '../../../lib/governorates';
import { uploadRequestFiles, formatBytes } from '../../media/RequestAttachments';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import {
  requestsApi,
  type Catalog,
  type DeliveryPref,
  type Dims,
  type DraftFile,
  type ProcessChoice,
  type Quality,
  type Quote,
  type SourceType,
  type WizardPayload,
} from './api';

type Step = 1 | 2 | 3 | 4;
type Lang = 'ar' | 'en' | 'ckb';

const MODEL_ACCEPT = '.stl,.3mf,.obj,.amf,.glb,.gltf,.step,.stp';
const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif';
const MAX_FILES = 6;

/** Colours by name — the merchant reads the word, not only the swatch. */
const SWATCHES: Array<{ hex: string; ar: string; en: string }> = [
  { hex: '#1a1a1a', ar: 'أسود', en: 'Black' },
  { hex: '#f2f2f2', ar: 'أبيض', en: 'White' },
  { hex: '#808080', ar: 'رمادي', en: 'Grey' },
  { hex: '#d32f2f', ar: 'أحمر', en: 'Red' },
  { hex: '#1976d2', ar: 'أزرق', en: 'Blue' },
  { hex: '#388e3c', ar: 'أخضر', en: 'Green' },
  { hex: '#fbc02d', ar: 'أصفر', en: 'Yellow' },
];

export interface WizardState {
  title: string;
  description: string;
  customer_notes: string;
  source_type: SourceType;
  source_url: string;
  process: ProcessChoice;
  material_id: string;
  quality: Quality;
  quantity: number;
  color_hex: string;
  color_name: string;
  dims: { x: number | null; y: number | null; z: number | null };
  governorate: string;
  delivery_pref: DeliveryPref;
  deadline: string;
  budget_iqd: number | null;
}

export const EMPTY_WIZARD: WizardState = {
  title: '',
  description: '',
  customer_notes: '',
  source_type: 'model',
  source_url: '',
  process: 'unsure',
  material_id: 'unsure',
  quality: 'standard',
  quantity: 1,
  color_hex: '',
  color_name: '',
  dims: { x: null, y: null, z: null },
  governorate: '',
  delivery_pref: '',
  deadline: '',
  budget_iqd: null,
};

const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** The typed size, only when all three edges are there. */
function statedDims(s: WizardState): Dims | null {
  const { x, y, z } = s.dims;
  return x && y && z ? { x, y, z } : null;
}

export function wizardPayload(s: WizardState, primaryFileId: string, measured: boolean): WizardPayload {
  return {
    title: s.title.trim(),
    description: s.description.trim(),
    customer_notes: s.customer_notes.trim(),
    source_type: s.source_type,
    process: s.process,
    material_id: s.material_id,
    quality: s.quality,
    quantity: s.quantity,
    color_hex: s.color_hex,
    color_name: s.color_name,
    ...(s.source_type === 'model' && primaryFileId ? { primary_file_id: primaryFileId } : {}),
    source_url: s.source_type === 'link' ? s.source_url.trim() : '',
    stated_dimensions_mm: measured ? null : statedDims(s),
    governorate: s.governorate,
    delivery_pref: s.delivery_pref,
    deadline: s.deadline,
    budget_iqd: s.budget_iqd,
  };
}

export default function RequestWizard({
  requestId: initialId,
  initialLink,
  onDone,
  onCancel,
}: {
  /** A draft to finish, or a published request to edit. */
  requestId?: string;
  /** A model link carried over from the price calculator. */
  initialLink?: string;
  onDone: (requestId: string, how: 'published' | 'saved') => void;
  onCancel: () => void;
}) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [step, setStep] = useState<Step>(1);
  const [s, setS] = useState<WizardState>(() =>
    initialLink ? { ...EMPTY_WIZARD, source_type: 'link', source_url: initialLink } : EMPTY_WIZARD
  );
  const [requestId, setRequestId] = useState(initialId ?? '');
  const [state, setState] = useState<string>(initialId ? '' : 'draft');
  const [liveOffers, setLiveOffers] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [busy, setBusy] = useState<'' | 'next' | 'save' | 'publish' | 'load'>(initialId ? 'load' : '');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'title' | 'description' | 'source' | 'deadline', string>>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [linkInfo, setLinkInfo] = useState<{ name?: string } | null>(null);
  const [published, setPublished] = useState<{ notified: number; replayed: boolean; revised: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const L = lang as Lang;
  const editingPublished = !!requestId && state !== '' && state !== 'draft';

  const set = useCallback(<K extends keyof WizardState>(k: K, v: WizardState[K]) => setS((p) => ({ ...p, [k]: v })), []);
  const refusal = useCallback(
    (e: unknown, fallback: string) => (e instanceof ApiError ? apiRefusal(e, L, e.message || fallback) : fallback),
    [L]
  );

  useEffect(() => {
    requestsApi.catalog().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  // Resume a draft (or open a published request for editing).
  useEffect(() => {
    if (!initialId) return;
    let alive = true;
    requestsApi
      .draft(initialId)
      .then(({ draft: d }) => {
        if (!alive) return;
        setState(d.state);
        setLiveOffers(d.live_offers);
        setFiles(d.files);
        const p = d.print;
        setS({
          title: d.title,
          description: d.description,
          customer_notes: d.customer_notes,
          source_type: p?.source_type ?? (d.files.some((f) => f.kind === 'model') ? 'model' : d.files.length ? 'images' : 'description'),
          source_url: p?.source_url ?? '',
          process: p?.process ?? 'unsure',
          material_id: p?.material_id || 'unsure',
          quality: p?.quality ?? 'standard',
          quantity: d.quantity || 1,
          color_hex: p?.color_hex ?? '',
          color_name: p?.color_name ?? '',
          dims: { x: p?.stated_dimensions_mm?.x ?? null, y: p?.stated_dimensions_mm?.y ?? null, z: p?.stated_dimensions_mm?.z ?? null },
          governorate: d.governorate,
          delivery_pref: (['delivery', 'pickup'].includes(d.delivery_pref) ? d.delivery_pref : '') as DeliveryPref,
          // A free-text deadline from before v2 is not a date the picker can hold.
          deadline: /^\d{4}-\d{2}-\d{2}$/.test(d.deadline) && d.deadline >= isoDay() ? d.deadline : '',
          budget_iqd: d.budget_iqd,
        });
      })
      .catch((e) => alive && setError(refusal(e, loc('تعذّر فتح الطلب', 'Could not open the request'))))
      .finally(() => alive && setBusy(''));
    return () => {
      alive = false;
    };
  }, [initialId, loc, refusal]);

  const models = files.filter((f) => f.kind === 'model');
  const images = files.filter((f) => f.kind === 'reference');
  const primary = models.find((f) => f.analysis?.measured) ?? models[0] ?? null;
  const measured = !!primary?.analysis?.measured && s.source_type === 'model';

  // ------------------------------------------------------------ step 1

  function addFiles(list: FileList | null) {
    if (!list) return;
    const room = MAX_FILES - files.length - pending.length;
    const picked = Array.from(list).slice(0, Math.max(0, room));
    setPending((p) => [...p, ...picked]);
    setErrors((e) => ({ ...e, source: undefined }));
    if (fileInput.current) fileInput.current.value = '';
  }

  async function checkLink() {
    if (!s.source_url.trim()) return;
    setError('');
    try {
      const d = await requestsApi.checkLink(s.source_url.trim());
      set('source_url', d.link.canonical_url);
      setLinkInfo(d.info);
      if (!s.title.trim() && d.info.name) set('title', d.info.name.slice(0, 140));
      setErrors((e) => ({ ...e, source: undefined }));
    } catch (e) {
      setLinkInfo(null);
      setErrors((x) => ({ ...x, source: refusal(e, loc('هذا لا يبدو رابط مجسم.', 'That does not look like a model link.')) }));
    }
  }

  // A link carried over from the price calculator is checked on arrival, once:
  // the wizard opens on the link source with it filled in and read.
  const initialLinkTaken = useRef(false);
  useEffect(() => {
    if (initialLinkTaken.current || initialId || !initialLink?.trim()) return;
    initialLinkTaken.current = true;
    void checkLink();
    // Once, on arrival — `checkLink` is re-created every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLink, initialId]);

  function validateStep1(): boolean {
    const next: typeof errors = {};
    const t = s.title.trim();
    if (t.length < 4 || t.length > 140) next.title = loc('اكتب عنوانًا من 4 إلى 140 حرفًا.', 'Write a title of 4 to 140 characters.');
    if (s.description.trim().length < 10) next.description = loc('صف ما تريده في 10 أحرف على الأقل.', 'Describe what you need in at least 10 characters.');
    const haveModel = models.length > 0 || pending.some((f) => MODEL_ACCEPT.includes(f.name.split('.').pop()?.toLowerCase() ?? '~'));
    const haveImage = images.length > 0 || pending.some((f) => IMAGE_ACCEPT.includes(f.name.split('.').pop()?.toLowerCase() ?? '~'));
    if (s.source_type === 'model' && !haveModel) next.source = loc('أرفق ملف المجسم.', 'Attach the model file.');
    if (s.source_type === 'images' && !haveImage) next.source = loc('أرفق صورة واحدة على الأقل.', 'Attach at least one picture.');
    if (s.source_type === 'link' && !/^https:\/\//i.test(s.source_url.trim())) next.source = loc('ألصق رابط المجسم (https).', 'Paste the model link (https).');
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /** The draft exists, and every picked file is on it (models measured). */
  async function ensureDraft(): Promise<string> {
    let id = requestId;
    if (!id) {
      const created = await requestsApi.createDraft({
        title: s.title.trim(),
        description: s.description.trim(),
        customer_notes: s.customer_notes.trim(),
      });
      id = created.request.id;
      setRequestId(id);
      setState('draft');
    }
    if (pending.length) {
      const failed = await uploadRequestFiles(id, pending);
      setPending([]);
      if (failed) toast.error(loc(`تعذّر رفع ${failed} من الملفات.`, `${failed} file(s) did not upload.`));
      const back = await requestsApi.draft(id);
      const fresh = back.draft.files;
      // Measure every model not measured yet — the price is built on it.
      const measuredFiles = await Promise.all(
        fresh.map(async (f) => {
          if (f.kind !== 'model' || f.analysis) return f;
          try {
            const r = await requestsApi.analyze(id, f.id);
            return { ...f, analysis: r.analysis };
          } catch {
            return f;
          }
        })
      );
      setFiles(measuredFiles);
    }
    return id;
  }

  async function next() {
    setError('');
    if (step === 1) {
      if (!validateStep1()) return;
      setBusy('next');
      try {
        await ensureDraft();
        setStep(2);
      } catch (e) {
        setError(refusal(e, loc('تعذّر حفظ الطلب', 'Could not save the request')));
      } finally {
        setBusy('');
      }
      return;
    }
    if (step === 3 && s.deadline && (s.deadline < isoDay() || s.deadline > isoDay(366))) {
      setErrors((e) => ({ ...e, deadline: loc('اختر تاريخًا من اليوم إلى سنة قادمة.', 'Choose a date from today to a year ahead.') }));
      return;
    }
    setStep((x) => Math.min(4, x + 1) as Step);
  }

  async function removeFile(f: DraftFile) {
    if (!requestId) return;
    const ok = await confirm({
      title: loc('حذف هذا الملف؟', 'Remove this file?'),
      consequence: editingPublished && liveOffers
        ? loc('التجار الذين قدّموا عروضًا سعّروا هذا الملف — ستحتاج عروضهم إلى تأكيد جديد.', 'Merchants priced this file — their offers will need re-confirming.')
        : loc('لن يراه التجار.', 'Merchants will not see it.'),
      confirmLabel: loc('حذف', 'Remove'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await requestsApi.removeFile(requestId, f.id);
      setFiles((x) => x.filter((y) => y.id !== f.id));
    } catch (e) {
      toast.error(refusal(e, loc('تعذّر حذف الملف', 'Could not remove the file')));
    }
  }

  // ------------------------------------------------------------ the estimate

  const payload = useMemo(() => wizardPayload(s, primary?.id ?? '', measured), [s, primary?.id, measured]);
  useEffect(() => {
    if (step !== 4 || !requestId) return;
    let alive = true;
    requestsApi
      .quote({ ...payload, file_id: payload.primary_file_id })
      .then((d) => alive && setQuote(d.quote))
      .catch(() => alive && setQuote(null));
    return () => {
      alive = false;
    };
  }, [step, requestId, payload]);

  // ------------------------------------------------------------ save / publish

  async function saveDraft() {
    setError('');
    if (step === 1 && !validateStep1()) return;
    setBusy('save');
    try {
      const id = await ensureDraft();
      await requestsApi.saveDraft(id, wizardPayload(s, primary?.id ?? '', measured));
      toast.success(loc('حُفظت المسودة. لا يراها أحد غيرك.', 'Draft saved. Nobody but you can see it.'));
      onDone(id, 'saved');
    } catch (e) {
      setError(refusal(e, loc('تعذّر حفظ المسودة', 'Could not save the draft')));
    } finally {
      setBusy('');
    }
  }

  async function publish() {
    setError('');
    if (editingPublished && liveOffers > 0) {
      const ok = await confirm({
        title: loc('حفظ التعديلات؟', 'Save these changes?'),
        consequence: loc(
          `إن غيّرت ما سعّره التجار، تتوقف العروض القائمة (${liveOffers}) حتى يؤكدها أصحابها من جديد، ويُبلَّغون بذلك.`,
          `If you change what merchants priced, the standing offers (${liveOffers}) pause until their merchants re-confirm them, and they are told.`
        ),
        confirmLabel: loc('احفظ التعديلات', 'Save changes'),
      });
      if (!ok) return;
    }
    setBusy('publish');
    try {
      const id = await ensureDraft();
      const d = await requestsApi.publish(id, wizardPayload(s, primary?.id ?? '', measured));
      setPublished({ notified: d.matching.notified, replayed: d.replayed, revised: d.revised });
    } catch (e) {
      setError(refusal(e, loc('تعذّر نشر الطلب', 'Could not publish the request')));
    } finally {
      setBusy('');
    }
  }

  // ------------------------------------------------------------ render

  if (published) {
    return (
      <div className="lv-surface p-5 text-center" data-wizard="published" role="status">
        <span aria-hidden="true" className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-success/10 text-success">
          <Check className="h-5 w-5" />
        </span>
        <h2 className="text-[16px] font-bold text-text-primary">
          {editingPublished ? loc('حُفظت التعديلات', 'Changes saved') : loc('نُشر طلبك', 'Your request is published')}
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-text-secondary">
          {published.replayed
            ? loc('لم يتغير شيء سعّره التجار.', 'Nothing merchants priced has changed.')
            : published.notified > 0
              ? loc(`أبلغنا ${published.notified} من التجار الذين تناسب ورشهم طلبك. ستصلك العروض هنا.`, `We told ${published.notified} merchants whose workshops fit. Offers will arrive here.`)
              : loc('طلبك على لوحة الطلبات، وسيراه التجار ويقدّمون عروضهم.', 'Your request is on the board; merchants will see it and make offers.')}
        </p>
        <Button variant="primary" className="mt-4" onClick={() => onDone(requestId, 'published')} data-wizard-open={requestId}>
          {loc('افتح الطلب', 'Open the request')}
        </Button>
      </div>
    );
  }

  const materials = (catalog?.materials ?? []).filter((m) => s.process === 'unsure' || m.process === s.process);
  const stepTitles: Record<Step, string> = {
    1: loc('ماذا تريد أن نطبع؟', 'What should be printed?'),
    2: loc('تفاصيل الطباعة', 'Printing details'),
    3: loc('التسليم والموعد', 'Delivery and timing'),
    4: loc('راجع طلبك', 'Review your request'),
  };
  const govName = (id: string) => {
    const g = GOVERNORATES.find((x) => x.id === id);
    return g ? (lang === 'en' ? g.en : g.ar) : '';
  };
  const materialName = (id: string) => {
    const m = catalog?.materials.find((x) => x.id === id);
    return m ? (lang === 'en' ? m.name_en : m.name_ar || m.name_en) : id;
  };
  const sourceLabel: Record<SourceType, string> = {
    model: loc('ملف مجسم', 'Model file'),
    link: loc('رابط مجسم', 'Model link'),
    images: loc('صور مرجعية', 'Reference pictures'),
    description: loc('وصف فقط', 'Description only'),
  };

  return (
    <div className="pb-24" data-wizard-step={step} data-wizard-state={state || 'loading'}>
      {/* Where am I: the step, its name, and a quiet four-part progress line. */}
      <div className="mb-5">
        <p className="text-[12px] font-semibold text-text-muted tabular-nums">
          {loc(`الخطوة ${step} من 4`, `Step ${step} of 4`)}
          {editingPublished && <span className="ms-2 text-warning">{loc('تعديل طلب منشور', 'Editing a published request')}</span>}
        </p>
        <h2 className="mt-1 text-[18px] font-bold leading-snug text-text-primary">{stepTitles[step]}</h2>
        <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1 rounded-full transition-colors ${i <= step ? 'bg-gold' : 'bg-white/10'}`} />
          ))}
        </div>
      </div>

      {busy === 'load' ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-24 animate-pulse rounded-2xl bg-white/[0.04]" />
          <div className="h-12 animate-pulse rounded-2xl bg-white/[0.04]" />
        </div>
      ) : (
        <div className="space-y-5">
          {step === 1 && (
            <>
              <fieldset>
                <legend className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('ماذا لديك؟', 'What do you have?')}</legend>
                <div role="radiogroup" aria-label={loc('مصدر الطلب', 'Request source')} className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['model', Box, loc('ملف مجسم', 'A model file'), 'STL · 3MF · OBJ · STEP'],
                      ['link', Link2, loc('رابط مجسم', 'A model link'), 'MakerWorld · Printables'],
                      ['images', ImageIcon, loc('صور مرجعية', 'Pictures'), loc('صورة أو رسم', 'A photo or a sketch')],
                      ['description', FileText, loc('وصف فقط', 'Words only'), loc('صف ما تريده', 'Describe what you need')],
                    ] as Array<[SourceType, typeof Box, string, string]>
                  ).map(([id, Icon, label, sub]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={s.source_type === id}
                      data-source={id}
                      onClick={() => {
                        set('source_type', id);
                        setErrors((e) => ({ ...e, source: undefined }));
                      }}
                      className="lv-choice flex min-h-[76px] flex-col items-start gap-1 px-3 py-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span className="flex w-full items-center gap-2">
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                        <span className="text-[13.5px] font-semibold">{label}</span>
                        {s.source_type === id && <Check aria-hidden="true" className="ms-auto h-4 w-4 text-gold" />}
                      </span>
                      <span className="text-[11.5px] leading-snug text-text-muted" dir="auto">{sub}</span>
                    </button>
                  ))}
                </div>
              </fieldset>

              {(s.source_type === 'model' || s.source_type === 'images') && (
                <div>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    accept={s.source_type === 'model' ? `${MODEL_ACCEPT},${IMAGE_ACCEPT},.pdf` : `${IMAGE_ACCEPT},.pdf`}
                    onChange={(e) => addFiles(e.target.files)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    data-wizard="pick-files"
                    className="flex min-h-[88px] w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-4 text-center transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <Upload aria-hidden="true" className="h-5 w-5 text-text-muted" />
                    <span className="text-[13.5px] font-semibold text-text-primary">
                      {s.source_type === 'model' ? loc('اختر ملف المجسم', 'Choose the model file') : loc('اختر الصور', 'Choose pictures')}
                    </span>
                    <span className="text-[11.5px] text-text-muted">
                      {s.source_type === 'model'
                        ? loc('حتى 40 ميغابايت. نقيسه نحن — لا تحتاج أن تعرف مقاسه.', 'Up to 40 MB. We measure it — you do not need to know its size.')
                        : loc('حتى 8 ميغابايت لكل صورة، و6 ملفات كحد أقصى.', 'Up to 8 MB each, 6 files at most.')}
                    </span>
                  </button>
                  {errors.source && <p className="lv-field-error mt-2" role="alert">{errors.source}</p>}
                  {(files.length > 0 || pending.length > 0) && (
                    <ul className="mt-3 space-y-1.5" aria-label={loc('الملفات', 'Files')}>
                      {files.map((f) => (
                        <li key={f.id} className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-[12.5px]">
                          <span className="min-w-0 flex-1 truncate text-text-primary" dir="ltr">{f.file_name}</span>
                          {f.analysis?.measured && (
                            <span className="shrink-0 text-text-muted tabular-nums" dir="ltr">
                              {Math.round(f.analysis.dimensions_mm.x)}×{Math.round(f.analysis.dimensions_mm.y)}×{Math.round(f.analysis.dimensions_mm.z)} mm
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => removeFile(f)}
                            aria-label={loc(`حذف ${f.file_name}`, `Remove ${f.file_name}`)}
                            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                      {pending.map((f, i) => (
                        <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-[12.5px]">
                          <span className="min-w-0 flex-1 truncate text-text-primary" dir="ltr">{f.name}</span>
                          <span className="shrink-0 text-text-muted tabular-nums" dir="ltr">{formatBytes(f.size)}</span>
                          <button
                            type="button"
                            onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                            aria-label={loc(`إزالة ${f.name}`, `Remove ${f.name}`)}
                            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {s.source_type === 'link' && (
                <Field
                  label={loc('رابط المجسم', 'Model link')}
                  error={errors.source}
                  hint={linkInfo?.name ? loc(`وجدنا: ${linkInfo.name}`, `Found: ${linkInfo.name}`) : loc('من MakerWorld أو Printables أو Thingiverse…', 'From MakerWorld, Printables, Thingiverse…')}
                >
                  <Input
                    ltr
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder="https://"
                    value={s.source_url}
                    onChange={(e) => {
                      set('source_url', e.target.value);
                      setLinkInfo(null);
                    }}
                    onBlur={checkLink}
                  />
                </Field>
              )}

              {s.source_type === 'description' && (
                <p className="rounded-xl bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-relaxed text-text-secondary">
                  {loc(
                    'لا بأس بلا ملف. صف الشكل والمقاس والاستعمال، وسيسألك التجار عمّا يحتاجونه قبل تسعيره.',
                    'No file is fine. Describe the shape, the size and what it is for — merchants will ask what they need before pricing it.'
                  )}
                </p>
              )}

              {/* A published request keeps the title and description merchants
                  read when they offered; the job's facts are what an edit changes. */}
              <Field label={loc('العنوان', 'Title')} error={errors.title} required hint={editingPublished ? loc('لا يتغير بعد النشر.', 'Fixed once published.') : undefined}>
                <Input value={s.title} maxLength={140} readOnly={editingPublished} onChange={(e) => set('title', e.target.value)} placeholder={loc('مثال: حامل هاتف للسيارة', 'e.g. A car phone holder')} />
              </Field>
              <Field label={loc('الوصف', 'Description')} error={errors.description} required hint={editingPublished ? loc('لا يتغير بعد النشر — أضف ما يلزم في ملاحظات التجار.', 'Fixed once published — add anything new in the notes for merchants.') : loc('ما هو، ولأي استعمال، وما المهم فيه.', 'What it is, what it is for, what matters about it.')}>
                <Textarea value={s.description} rows={4} maxLength={6000} readOnly={editingPublished} onChange={(e) => set('description', e.target.value)} dir="auto" />
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('طريقة الطباعة', 'Printing process')}</p>
                <Segmented
                  group="wizard-process"
                  label={loc('طريقة الطباعة', 'Printing process')}
                  value={s.process}
                  dataAttr="data-process"
                  onChange={(id) => setS((p) => ({ ...p, process: id as ProcessChoice, material_id: 'unsure' }))}
                  items={[
                    { id: 'fdm', label: loc('خيوط FDM', 'FDM filament') },
                    { id: 'resin', label: loc('ريزن', 'Resin') },
                    { id: 'unsure', label: loc('لست متأكدًا', 'Not sure') },
                  ]}
                />
                <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
                  {s.process === 'resin'
                    ? loc('تفاصيل دقيقة جدًا وسطح ناعم — للمجسمات الصغيرة.', 'Very fine detail and a smooth surface — for small models.')
                    : s.process === 'fdm'
                      ? loc('قوي واقتصادي — لأغلب القطع العملية.', 'Strong and economical — right for most functional parts.')
                      : loc('سنعرض طلبك على ورش الطريقتين، ويقترح التاجر الأنسب.', 'We show your request to both kinds of workshop; the merchant suggests what fits.')}
                </p>
              </div>

              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('المادة', 'Material')}</p>
                <div role="radiogroup" aria-label={loc('المادة', 'Material')} className="flex flex-wrap gap-2">
                  {[{ id: 'unsure', label: loc('لست متأكدًا', 'Not sure') }, ...materials.map((m) => ({ id: m.id, label: lang === 'en' ? m.name_en : m.name_ar || m.name_en }))].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={s.material_id === m.id}
                      data-material={m.id}
                      onClick={() => {
                        const mat = catalog?.materials.find((x) => x.id === m.id);
                        setS((p) => ({ ...p, material_id: m.id, process: mat ? mat.process : p.process }));
                      }}
                      className="lv-choice px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('اللون', 'Colour')}</p>
                <div role="radiogroup" aria-label={loc('اللون', 'Colour')} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!s.color_hex}
                    onClick={() => setS((p) => ({ ...p, color_hex: '', color_name: '' }))}
                    className="lv-choice px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {loc('أي لون', 'Any colour')}
                  </button>
                  {SWATCHES.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      role="radio"
                      aria-checked={s.color_hex === c.hex}
                      onClick={() => setS((p) => ({ ...p, color_hex: c.hex, color_name: c.en }))}
                      className="lv-choice inline-flex items-center gap-2 px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border border-white/20" style={{ backgroundColor: c.hex }} />
                      {lang === 'en' ? c.en : c.ar}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('الدقة', 'Detail')}</p>
                  <Segmented
                    group="wizard-quality"
                    size="sm"
                    label={loc('الدقة', 'Detail')}
                    value={s.quality}
                    onChange={(id) => set('quality', id as Quality)}
                    items={[
                      { id: 'draft', label: loc('سريعة', 'Quick') },
                      { id: 'standard', label: loc('قياسية', 'Standard') },
                      { id: 'fine', label: loc('دقيقة', 'Fine') },
                      { id: 'ultra', label: loc('فائقة', 'Ultra') },
                    ]}
                  />
                </div>
                <Field label={loc('الكمية', 'Quantity')}>
                  <NumberInput kind="quantity" min={1} max={10000} value={s.quantity} onValueChange={(v) => set('quantity', Math.max(1, v ?? 1))} />
                </Field>
              </div>

              {measured && primary?.analysis ? (
                <p className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3.5 py-3 text-[12.5px] text-text-secondary">
                  <Ruler aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                  {loc('المقاس من ملفك:', 'Size from your file:')}
                  <span className="font-semibold text-text-primary tabular-nums" dir="ltr">
                    {Math.round(primary.analysis.dimensions_mm.x)}×{Math.round(primary.analysis.dimensions_mm.y)}×{Math.round(primary.analysis.dimensions_mm.z)} mm
                  </span>
                </p>
              ) : (
                <fieldset>
                  <legend className="mb-2 text-[13px] font-semibold text-text-secondary">
                    {loc('المقاس التقريبي (ملم)', 'Approximate size (mm)')} <span className="font-normal text-text-muted">{loc('— اختياري', '— optional')}</span>
                  </legend>
                  <div className="grid grid-cols-3 gap-2">
                    {(['x', 'y', 'z'] as const).map((k) => (
                      <Field key={k} label={k === 'x' ? loc('الطول', 'Length') : k === 'y' ? loc('العرض', 'Width') : loc('الارتفاع', 'Height')}>
                        <NumberInput min={1} max={5000} decimals={1} unit="mm" value={s.dims[k]} onValueChange={(v) => setS((p) => ({ ...p, dims: { ...p.dims, [k]: v } }))} />
                      </Field>
                    ))}
                  </div>
                </fieldset>
              )}

              <Field
                label={loc('ملاحظات للتجار', 'Notes for the merchants')}
                optional
                hint={loc('يراها التجار. لا تكتب رقم هاتفك — يصل للتاجر الذي تختاره تلقائيًا.', 'Merchants see this. Do not write your phone number — the merchant you choose receives it.')}
              >
                <Textarea value={s.customer_notes} rows={3} maxLength={1000} dir="auto" onChange={(e) => set('customer_notes', e.target.value)} />
              </Field>
            </>
          )}

          {step === 3 && (
            <>
              <Field label={loc('المحافظة', 'Governorate')} optional>
                <Select value={s.governorate} onChange={(e) => set('governorate', e.target.value)}>
                  <option value="">{loc('لم أحدد', 'Not set')}</option>
                  {GOVERNORATES.map((g) => (
                    <option key={g.id} value={g.id}>{lang === 'en' ? g.en : g.ar}</option>
                  ))}
                </Select>
              </Field>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('الاستلام', 'Handover')}</p>
                <Segmented
                  group="wizard-delivery"
                  label={loc('الاستلام', 'Handover')}
                  value={s.delivery_pref || 'either'}
                  onChange={(id) => set('delivery_pref', (id === 'either' ? '' : id) as DeliveryPref)}
                  items={[
                    { id: 'delivery', label: loc('توصيل', 'Delivery') },
                    { id: 'pickup', label: loc('استلام بنفسي', 'I collect') },
                    { id: 'either', label: loc('أيهما', 'Either') },
                  ]}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={loc('أحتاجه قبل', 'Needed by')} optional error={errors.deadline}>
                  <Input
                    ltr
                    type="date"
                    min={isoDay()}
                    max={isoDay(366)}
                    value={s.deadline}
                    onChange={(e) => {
                      set('deadline', e.target.value);
                      setErrors((x) => ({ ...x, deadline: undefined }));
                    }}
                  />
                </Field>
                <Field label={loc('ميزانيتك', 'Your budget')} optional hint={loc('يراها التجار. اتركها فارغة إن لم تكن متأكدًا.', 'Merchants see it. Leave it empty if unsure.')}>
                  <NumberInput kind="money" value={s.budget_iqd} onValueChange={(v, ok) => ok && set('budget_iqd', v)} />
                </Field>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <dl className="lv-surface divide-y divide-white/[0.06]">
                {(
                  [
                    [loc('المصدر', 'Source'), sourceLabel[s.source_type] + (s.source_type === 'model' || s.source_type === 'images' ? ` · ${files.length}` : ''), 1],
                    [loc('العنوان', 'Title'), s.title, 1],
                    [loc('الطريقة', 'Process'), s.process === 'unsure' ? loc('لست متأكدًا', 'Not sure') : s.process === 'fdm' ? 'FDM' : loc('ريزن', 'Resin'), 2],
                    [loc('المادة', 'Material'), s.material_id === 'unsure' ? loc('لست متأكدًا', 'Not sure') : materialName(s.material_id), 2],
                    [loc('الكمية', 'Quantity'), String(s.quantity), 2],
                    [
                      loc('المقاس', 'Size'),
                      measured && primary?.analysis
                        ? `${Math.round(primary.analysis.dimensions_mm.x)}×${Math.round(primary.analysis.dimensions_mm.y)}×${Math.round(primary.analysis.dimensions_mm.z)} mm`
                        : statedDims(s)
                          ? `${s.dims.x}×${s.dims.y}×${s.dims.z} mm`
                          : '—',
                      2,
                    ],
                    [loc('ملاحظات للتجار', 'Notes for merchants'), s.customer_notes || '—', 2],
                    [loc('المحافظة', 'Governorate'), govName(s.governorate) || '—', 3],
                    [loc('الاستلام', 'Handover'), s.delivery_pref === 'delivery' ? loc('توصيل', 'Delivery') : s.delivery_pref === 'pickup' ? loc('استلام بنفسي', 'I collect') : loc('أيهما', 'Either'), 3],
                    [loc('أحتاجه قبل', 'Needed by'), s.deadline || '—', 3],
                  ] as Array<[string, string, Step]>
                ).map(([k, v, st], i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                    <dt className="w-28 shrink-0 text-[12.5px] text-text-muted">{k}</dt>
                    <dd className="min-w-0 flex-1 break-words text-[13px] text-text-primary" dir="auto">{v}</dd>
                    <button type="button" onClick={() => setStep(st)} className="-my-2.5 inline-flex min-h-[44px] shrink-0 items-center rounded px-1 text-[12px] font-semibold text-gold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                      {loc('تعديل', 'Edit')}
                    </button>
                  </div>
                ))}
                <div className="flex items-start gap-3 px-4 py-2.5">
                  <dt className="w-28 shrink-0 text-[12.5px] text-text-muted">{loc('الميزانية', 'Budget')}</dt>
                  <dd className="min-w-0 flex-1 text-[13px] text-text-primary">{s.budget_iqd ? <Money iqd={s.budget_iqd} /> : '—'}</dd>
                </div>
              </dl>

              <div className="lv-surface px-4 py-3.5" data-wizard="estimate">
                <p className="text-[12.5px] text-text-muted">{loc('تقدير Levonis', 'Levonis estimate')}</p>
                {quote?.priced ? (
                  <>
                    <p className="mt-1 text-[17px] font-bold text-text-primary">
                      <Money iqd={quote.price_low_iqd} /> <span className="text-text-muted">–</span> <Money iqd={quote.price_high_iqd} />
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                      {quote.range_basis === 'materials'
                        ? loc('المادة لم تُحدد، فهذا المدى يغطي المواد الممكنة. السعر النهائي من عروض التجار.', 'The material is open, so this range covers the materials it could be. The final price comes from merchants’ offers.')
                        : loc('تقدير فقط — السعر النهائي من عروض التجار.', 'An estimate — the final price comes from merchants’ offers.')}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                    {loc('لا تقدير بلا ملف مقيس — سيسعّره التجار في عروضهم.', 'No estimate without a measured file — merchants will price it in their offers.')}
                  </p>
                )}
              </div>

              {editingPublished && liveOffers > 0 && (
                <p className="lv-alert lv-alert-warning text-[12.5px]" role="note">
                  {loc(
                    `على هذا الطلب ${liveOffers} عرض قائم. تغيير ما سعّره التجار يوقف عروضهم حتى يؤكدوها.`,
                    `This request has ${liveOffers} standing offer(s). Changing what merchants priced pauses them until they re-confirm.`
                  )}
                </p>
              )}
              {!editingPublished && (
                <p className="text-[12px] leading-relaxed text-text-muted">
                  {loc(
                    'عند النشر يظهر طلبك على لوحة الطلبات ويُبلَّغ التجار الذين تناسب ورشهم. رقمك وعنوانك لا يصلان لأي تاجر إلا الذي تقبل عرضه.',
                    'Publishing puts your request on the board and tells the merchants whose workshops fit. Your phone and address reach only the merchant whose offer you accept.'
                  )}
                </p>
              )}
            </>
          )}

          {error && (
            <p className="lv-field-error" role="alert" data-wizard="error">
              {error}
            </p>
          )}
        </div>
      )}

      {/* The actions stay under the thumb, clear of the home indicator. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.06] bg-canvas/95 px-4 pt-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <Button variant="secondary" className="whitespace-nowrap" onClick={() => (step === 1 ? onCancel() : setStep((x) => (x - 1) as Step))} disabled={!!busy && busy !== 'load'}>
            {step === 1 ? loc('إلغاء', 'Cancel') : loc('رجوع', 'Back')}
          </Button>
          {!editingPublished && (step > 1 || requestId) && (
            <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={saveDraft} loading={busy === 'save'} data-wizard="save-draft">
              {loc('احفظ مسودة', 'Save draft')}
            </Button>
          )}
          <div className="ms-auto" />
          {step < 4 ? (
            <Button variant="primary" className="whitespace-nowrap" onClick={next} loading={busy === 'next'} loadingLabel={loc('جارٍ الرفع والقياس…', 'Uploading and measuring…')} data-wizard="next">
              {loc('التالي', 'Next')}
            </Button>
          ) : (
            <Button variant="primary" className="whitespace-nowrap" onClick={publish} loading={busy === 'publish'} data-wizard="publish">
              {editingPublished ? loc('احفظ التعديلات', 'Save changes') : loc('انشر', 'Publish')}
            </Button>
          )}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
