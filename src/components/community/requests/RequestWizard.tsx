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
 *
 * WHAT THE CUSTOMER SEES IS WHAT THEY SENT (Community V3 R4, R1, R5, R9): a
 * picture is a thumbnail from the moment it is chosen (an object URL, revoked
 * when it leaves the list or the wizard closes) and after it is stored (the
 * authorised route, sized by `?w=`); a pasted link is its link card; a file
 * that a request cannot take is refused before the upload, from the table
 * every door reads, in words built from FORMAT_CAPABILITIES. Every line is
 * written in Arabic, English and Sorani — never the Arabic standing in for
 * the Sorani (row 183).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Camera, Check, FileText, Image as ImageIcon, Link2, Ruler, Trash2, Upload } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { GOVERNORATES } from '../../../lib/governorates';
import { pickRequestUpload, resumeKey } from '../../../lib/uploadSession';
import { UploadTile } from '../../upload/UploadTile';
import { uploadRequestFiles, formatBytes } from '../../media/RequestAttachments';
import { REQUEST_FILE_LIMITS, requestFileAccept, requestFileKind } from '../../../../packages/contracts/src/requestFiles';
import { requestFilesCheck, requestUploadRefusal } from './fileRefusals';
import { REQUEST_COLOURS, localColour, localMaterial } from './mirrors';
import { RequestThumb, pictureFiles } from './RequestFileThumbs';
import { SourceLinkCard } from '../links/LinkCard';
import { warmLink } from '../links/useLinkCard';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Segmented } from '../../ui/Segmented';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { useSuppressBottomNav } from '../../../lib/bottomNavSuppress';
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
import { forgetCommunityFeed } from '../hub/feedCache';

type Step = 1 | 2 | 3 | 4;
type Lang = 'ar' | 'en' | 'ckb';

/** What each source takes — the one table every door reads (packages/contracts/src/requestFiles.ts, R5). */
const MODEL_ACCEPT = requestFileAccept(['model']);
const IMAGE_ACCEPT = requestFileAccept(['image']);
const PDF_ACCEPT = requestFileAccept(['document']);
const MAX_FILES = REQUEST_FILE_LIMITS.maxFiles;

/**
 * THE FILE STEP'S OWN WORDS (§9.4) — every line in Arabic, English and real
 * Sorani. A model or an archive always goes up through a resumable session
 * (UploadTile); a photo above 8 MiB does too; the rest takes the whole-body
 * route as before.
 */
const FILE_STEP = {
  ar: {
    modelHint: 'المجسمات الكبيرة تُرفع على أجزاء وتُستأنف إن انقطع الاتصال. نقيسه نحن — لا تحتاج أن تعرف مقاسه.',
    imagesHint: '6 ملفات كحد أقصى. الصور الكبيرة تُرفع على أجزاء وتُستأنف إن انقطع الاتصال.',
    uploading: 'ملفات قيد الرفع',
    takePhoto: 'التقط صورة',
    resume: (name: string) => `رفع «${name}» لم يكتمل — اختر الملف نفسه مرة أخرى ليُستأنف من حيث توقف.`,
    measureLater: 'يُقاس لاحقًا',
    measureLaterHint: 'المجسمات الأكبر من 40 ميغابايت لا تُقاس هنا: تصل إلى الورش كمرجع، ويمكنك كتابة مقاسها التقريبي.',
  },
  en: {
    modelHint: 'Large models upload in parts and resume if the connection drops. We measure it — you do not need to know its size.',
    imagesHint: '6 files at most. Large pictures upload in parts and resume if the connection drops.',
    uploading: 'Files uploading',
    takePhoto: 'Take a photo',
    resume: (name: string) => `“${name}” did not finish uploading — pick the same file again to resume where it stopped.`,
    measureLater: 'Measured later',
    measureLaterHint: 'Models over 40 MB are not measured here: they reach the workshops as a reference, and you can type the approximate size.',
  },
  ckb: {
    modelHint: 'مۆدێلە گەورەکان بە بەش باردەکرێن و ئەگەر هێڵەکە بپچڕێت بەردەوام دەبنەوە. ئێمە دەیپێوین — پێویست ناکات قەبارەکەی بزانیت.',
    imagesHint: 'زۆرترین ٦ فایل. وێنە گەورەکان بە بەش باردەکرێن و ئەگەر هێڵەکە بپچڕێت بەردەوام دەبنەوە.',
    uploading: 'فایلەکان باردەکرێن',
    takePhoto: 'وێنەیەک بگرە',
    resume: (name: string) => `بارکردنی «${name}» تەواو نەبووە — هەمان فایل دووبارە هەڵبژێرە بۆ ئەوەی لەو شوێنەوە بەردەوام بێت کە وەستاوە.`,
    measureLater: 'دواتر دەپێورێت',
    measureLaterHint: 'ئەو مۆدێلانەی لە ٤٠ مێگابایت گەورەترن لێرە ناپێورێن: وەک سەرچاوە دەگەنە وۆرکشۆپەکان، و دەتوانیت قەبارە نزیکەکەی بنووسیت.',
  },
} as const;

/**
 * A FILE STILL ON THE DEVICE (R4): its own id, the File, and — for a picture —
 * the object URL its thumbnail is drawn from. The URL is revoked when the
 * file leaves the list (removed, or uploaded) and when the wizard closes.
 */
interface PendingFile {
  tempId: string;
  file: File;
  objectUrl: string | null;
}

/** A picture by its name or its type — the one kind a device can preview before the upload. */
const isPicture = (f: File) => requestFileKind(f.name) === 'image' || f.type.startsWith('image/');

/** A device preview for a picture (an object URL), null for anything else. */
export function previewUrl(f: File): string | null {
  if (!isPicture(f) || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(f);
  } catch {
    return null;
  }
}

/** Revoke every preview in a list: the browser frees the bytes the moment a file leaves. */
export function releasePreviews(list: readonly Pick<PendingFile, 'objectUrl'>[]): void {
  for (const p of list) {
    if (p.objectUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(p.objectUrl);
  }
}

/**
 * THE LEADING SQUARE OF A FILE ROW (R4): the picture itself — a stored one
 * through its authorised route as a sized copy, one still on the device from
 * its object URL — and the kind glyph for a model or a document. Never an id.
 */
export function WizardFileThumb({ url, objectUrl, kind }: { url?: string | null; objectUrl?: string | null; kind: string }) {
  if (objectUrl) {
    return <img src={objectUrl} alt="" data-wizard-thumb="pending" width={44} height={44} className="h-11 w-11 shrink-0 rounded-md bg-surface-raised object-cover" />;
  }
  if (url && (kind === 'image' || kind === 'reference')) {
    return (
      <span data-wizard-thumb="stored" className="shrink-0">
        <RequestThumb url={url} size={44} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted">
      {kind === 'model' ? <Box className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
    </span>
  );
}

/** One file on its way up through a session, with the request it belongs to. */
interface SessionTile {
  id: string;
  file: File;
  entityId: string;
  state: 'working' | 'done' | 'gone';
}

/**
 * The names of this request's uploads a reload interrupted: the resume records
 * src/lib/uploadSession.ts keeps in sessionStorage under
 * `levonis.upload.request:<id>:<size>:<mtime>:<name>`. A browser cannot keep
 * the File itself across a reload, so the person is asked to pick the same
 * file again; the upload then continues from the parts the server holds.
 */
export function unfinishedUploads(requestId: string, storage: Pick<Storage, 'length' | 'key'> | null | undefined): string[] {
  if (!requestId || !storage) return [];
  const prefix = resumeKey('request', '', requestId);
  const names: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i) ?? '';
      if (!k.startsWith(prefix)) continue;
      const name = k.slice(prefix.length).split(':').slice(2).join(':');
      if (name) names.push(name);
    }
  } catch {
    // a blocked storage only costs the hint
  }
  return names;
}

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
  // The wizard's own bar sits under the thumb: the floating nav steps aside.
  useSuppressBottomNav();
  const [step, setStep] = useState<Step>(1);
  const [s, setS] = useState<WizardState>(() =>
    initialLink ? { ...EMPTY_WIZARD, source_type: 'link', source_url: initialLink } : EMPTY_WIZARD
  );
  const [requestId, setRequestId] = useState(initialId ?? '');
  const [state, setState] = useState<string>(initialId ? '' : 'draft');
  const [liveOffers, setLiveOffers] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [pending, setPending] = useState<PendingFile[]>([]);
  // The previews alive right now, for the unmount below: a closed wizard leaves no object URL behind.
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pending;
  useEffect(() => () => releasePreviews(pendingRef.current), []);
  const tempSeq = useRef(0);
  // The link whose card the author resolve has warmed, so the card is drawn again from the stored row.
  const [linkWarm, setLinkWarm] = useState('');
  const [files, setFiles] = useState<DraftFile[]>([]);
  // The models /analyze answered «measure later» for (R3): too large to measure here.
  const [measureLater, setMeasureLater] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<'' | 'next' | 'save' | 'publish' | 'load'>(initialId ? 'load' : '');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'title' | 'description' | 'source' | 'deadline', string>>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [linkInfo, setLinkInfo] = useState<{ name?: string } | null>(null);
  const [published, setPublished] = useState<{ notified: number; replayed: boolean; revised: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const L = lang as Lang;
  const fs = FILE_STEP[L] ?? FILE_STEP.ar;
  const editingPublished = !!requestId && state !== '' && state !== 'draft';

  // ---- the session uploads (§9.4): tiles that «التالي» waits for ----
  const [tiles, setTiles] = useState<SessionTile[]>([]);
  // `ensureDraft` parks its promise here; the effect below settles it once
  // every tile is done or gone (a failed tile keeps «إعادة المحاولة» and «إلغاء»).
  const tilesWaiter = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!tilesWaiter.current || tiles.length === 0) return;
    if (tiles.some((t) => t.state === 'working')) return;
    const settle = tilesWaiter.current;
    tilesWaiter.current = null;
    setTiles([]);
    settle();
  }, [tiles]);
  // A phone gets «التقط صورة» beside the album on the pictures source.
  const [touch] = useState(() => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  // Uploads a reload cut short: named, so the person knows which file to pick again.
  const [unfinished, setUnfinished] = useState<string[]>([]);
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    } catch {
      storage = null;
    }
    setUnfinished(unfinishedUploads(requestId, storage));
  }, [requestId, tiles, pending]);

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
      .catch((e) => alive && setError(refusal(e, loc('تعذّر فتح الطلب', 'Could not open the request', 'نەتوانرا داواکارییەکە بکرێتەوە'))))
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

  /**
   * The browser half of the check (R5): every picked file is asked the same
   * table the server asks — count, kind and size — and a refused one is
   * named, with its short reason, before a byte is sent; what a request takes
   * is said once (`requestFilesCheck`), not once per refused file.
   */
  function addFiles(list: FileList | null) {
    if (!list) return;
    const { accepted, refusal } = requestFilesCheck(Array.from(list), L, files.length + pending.length);
    const picked: PendingFile[] = accepted.map((file) => {
      tempSeq.current += 1;
      return { tempId: `p${tempSeq.current}`, file, objectUrl: previewUrl(file) };
    });
    if (picked.length) setPending((p) => [...p, ...picked]);
    setErrors((e) => ({ ...e, source: refusal || undefined }));
    if (fileInput.current) fileInput.current.value = '';
  }

  function dropPending(tempId: string) {
    setPending((p) => {
      releasePreviews(p.filter((x) => x.tempId === tempId));
      return p.filter((x) => x.tempId !== tempId);
    });
  }

  async function checkLink() {
    if (!s.source_url.trim()) return;
    setError('');
    try {
      const d = await requestsApi.checkLink(s.source_url.trim());
      set('source_url', d.link.canonical_url);
      setLinkInfo(d.info);
      // The author resolve (R1): the server learns the link card once, so the
      // details page, the board and the offer panel draw it from the stored row.
      const canonical = d.link.canonical_url;
      void warmLink(canonical).then(() => setLinkWarm(canonical));
      if (!s.title.trim() && d.info.name) set('title', d.info.name.slice(0, 140));
      setErrors((e) => ({ ...e, source: undefined }));
    } catch (e) {
      setLinkInfo(null);
      setErrors((x) => ({ ...x, source: refusal(e, loc('هذا لا يبدو رابط مجسم.', 'That does not look like a model link.', 'ئەمە وەک لینکی مۆدێل نایەتە بەرچاو.')) }));
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
    if (t.length < 4 || t.length > 140) next.title = loc('اكتب عنوانًا من 4 إلى 140 حرفًا.', 'Write a title of 4 to 140 characters.', 'ناونیشانێک بنووسە لە ٤ تا ١٤٠ پیت.');
    if (s.description.trim().length < 10) next.description = loc('صف ما تريده في 10 أحرف على الأقل.', 'Describe what you need in at least 10 characters.', 'ئەوەی پێویستتە لانیکەم بە ١٠ پیت باس بکە.');
    const haveModel = models.length > 0 || pending.some((p) => requestFileKind(p.file.name) === 'model');
    const haveImage = images.length > 0 || pending.some((p) => requestFileKind(p.file.name) === 'image');
    if (s.source_type === 'model' && !haveModel) next.source = loc('أرفق ملف المجسم.', 'Attach the model file.', 'فایلی مۆدێلەکە هاوپێچ بکە.');
    if (s.source_type === 'images' && !haveImage) next.source = loc('أرفق صورة واحدة على الأقل.', 'Attach at least one picture.', 'لانیکەم یەک وێنە هاوپێچ بکە.');
    if (s.source_type === 'link' && !/^https:\/\//i.test(s.source_url.trim())) next.source = loc('ألصق رابط المجسم (https).', 'Paste the model link (https).', 'لینکی مۆدێلەکە دابنێ (https).');
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
      // Two doors (§9.4): a model, an archive or anything above 8 MiB goes
      // through a resumable session — a tile in the list that «التالي»
      // waits for — the rest in one request each, as before.
      const leaving = pending;
      const chosen = leaving.map((p) => p.file);
      const session = chosen.filter((f) => pickRequestUpload(f) === 'session');
      const simple = chosen.filter((f) => pickRequestUpload(f) !== 'session');
      setPending([]);
      // The device previews go with the list: the stored pictures are drawn from the route from here on.
      releasePreviews(leaving);
      const { failed, reasons } = simple.length ? await uploadRequestFiles(id, simple) : { failed: 0, reasons: [] as unknown[] };
      if (session.length) {
        const stamp = Date.now();
        await new Promise<void>((resolve) => {
          tilesWaiter.current = resolve;
          setTiles(session.map((file, i) => ({ id: `t${stamp}_${i}`, file, entityId: id, state: 'working' })));
        });
      }
      // The reason, not only a count (R5): the server refusal in the reader's words.
      if (failed) toast.error(requestUploadRefusal(reasons[0], L, loc(`تعذّر رفع ${failed} من الملفات.`, `${failed} file(s) did not upload.`, `${failed} فایل بار نەکرا.`)));
      const back = await requestsApi.draft(id);
      const fresh = back.draft.files;
      // Measure every model not measured yet — the price is built on it.
      const later: string[] = [];
      const measuredFiles = await Promise.all(
        fresh.map(async (f) => {
          if (f.kind !== 'model' || f.analysis) return f;
          try {
            const r = await requestsApi.analyze(id, f.id);
            if (r.measure === 'later') later.push(f.id);
            return { ...f, analysis: r.analysis };
          } catch {
            return f;
          }
        })
      );
      if (later.length) setMeasureLater((prev) => new Set([...prev, ...later]));
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
        setError(refusal(e, loc('تعذّر حفظ الطلب', 'Could not save the request', 'نەتوانرا داواکارییەکە پاشەکەوت بکرێت')));
      } finally {
        setBusy('');
      }
      return;
    }
    if (step === 3 && s.deadline && (s.deadline < isoDay() || s.deadline > isoDay(366))) {
      setErrors((e) => ({ ...e, deadline: loc('اختر تاريخًا من اليوم إلى سنة قادمة.', 'Choose a date from today to a year ahead.', 'بەروارێک لە ئەمڕۆوە تا ساڵێکی تر هەڵبژێرە.') }));
      return;
    }
    setStep((x) => Math.min(4, x + 1) as Step);
  }

  async function removeFile(f: DraftFile) {
    if (!requestId) return;
    const ok = await confirm({
      title: loc('حذف هذا الملف؟', 'Remove this file?', 'ئەم فایلە بسڕیتەوە؟'),
      consequence: editingPublished && liveOffers
        ? loc('التجار الذين قدّموا عروضًا سعّروا هذا الملف — ستحتاج عروضهم إلى تأكيد جديد.', 'Merchants priced this file — their offers will need re-confirming.', 'بازرگانەکان نرخیان بۆ ئەم فایلە داناوە — ئۆفەرەکانیان پێویستیان بە پشتڕاستکردنەوەی نوێ دەبێت.')
        : loc('لن يراه التجار.', 'Merchants will not see it.', 'بازرگانەکان نایبینن.'),
      confirmLabel: loc('حذف', 'Remove', 'سڕینەوە'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await requestsApi.removeFile(requestId, f.id);
      setFiles((x) => x.filter((y) => y.id !== f.id));
    } catch (e) {
      toast.error(refusal(e, loc('تعذّر حذف الملف', 'Could not remove the file', 'نەتوانرا فایلەکە بسڕدرێتەوە')));
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
      toast.success(loc('حُفظت المسودة. لا يراها أحد غيرك.', 'Draft saved. Nobody but you can see it.', 'ڕەشنووسەکە پاشەکەوت کرا. جگە لە تۆ کەس نایبینێت.'));
      onDone(id, 'saved');
    } catch (e) {
      setError(refusal(e, loc('تعذّر حفظ المسودة', 'Could not save the draft', 'نەتوانرا ڕەشنووسەکە پاشەکەوت بکرێت')));
    } finally {
      setBusy('');
    }
  }

  async function publish() {
    setError('');
    if (editingPublished && liveOffers > 0) {
      const ok = await confirm({
        title: loc('حفظ التعديلات؟', 'Save these changes?', 'ئەم گۆڕانکارییانە پاشەکەوت بکرێن؟'),
        consequence: loc(
          `إن غيّرت ما سعّره التجار، تتوقف العروض القائمة (${liveOffers}) حتى يؤكدها أصحابها من جديد، ويُبلَّغون بذلك.`,
          `If you change what merchants priced, the standing offers (${liveOffers}) pause until their merchants re-confirm them, and they are told.`,
          `ئەگەر ئەوە بگۆڕیت کە بازرگانەکان نرخیان بۆ داناوە، ئۆفەرە هەنووکەییەکان (${liveOffers}) ڕادەگیرێن تا بازرگانەکانیان دووبارە پشتڕاستیان دەکەنەوە، و ئاگادار دەکرێنەوە.`
        ),
        confirmLabel: loc('احفظ التعديلات', 'Save changes', 'گۆڕانکارییەکان پاشەکەوت بکە'),
      });
      if (!ok) return;
    }
    setBusy('publish');
    try {
      const id = await ensureDraft();
      const d = await requestsApi.publish(id, wizardPayload(s, primary?.id ?? '', measured));
      // The community page's remembered request lists no longer say what is on the board.
      forgetCommunityFeed('requests');
      setPublished({ notified: d.matching.notified, replayed: d.replayed, revised: d.revised });
    } catch (e) {
      setError(refusal(e, loc('تعذّر نشر الطلب', 'Could not publish the request', 'نەتوانرا داواکارییەکە بڵاو بکرێتەوە')));
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
          {editingPublished ? loc('حُفظت التعديلات', 'Changes saved', 'گۆڕانکارییەکان پاشەکەوت کران') : loc('نُشر طلبك', 'Your request is published', 'داواکارییەکەت بڵاوکرایەوە')}
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-text-secondary">
          {published.replayed
            ? loc('لم يتغير شيء سعّره التجار.', 'Nothing merchants priced has changed.', 'هیچ شتێک لەوەی بازرگانەکان نرخیان بۆ داناوە نەگۆڕاوە.')
            : published.notified > 0
              ? loc(`أبلغنا ${published.notified} من التجار الذين تناسب ورشهم طلبك. ستصلك العروض هنا.`, `We told ${published.notified} merchants whose workshops fit. Offers will arrive here.`, `${published.notified} بازرگانمان ئاگادار کردەوە کە وۆرکشۆپەکانیان گونجاوە. ئۆفەرەکان لێرە دەگەن.`)
              : loc('طلبك على لوحة الطلبات، وسيراه التجار ويقدّمون عروضهم.', 'Your request is on the board; merchants will see it and make offers.', 'داواکارییەکەت لەسەر تەختەی داواکارییەکانە؛ بازرگانەکان دەیبینن و ئۆفەر پێشکەش دەکەن.')}
        </p>
        <Button variant="primary" className="mt-4" onClick={() => onDone(requestId, 'published')} data-wizard-open={requestId}>
          {loc('افتح الطلب', 'Open the request', 'داواکارییەکە بکەرەوە')}
        </Button>
      </div>
    );
  }

  const materials = (catalog?.materials ?? []).filter((m) => s.process === 'unsure' || m.process === s.process);
  const stepTitles: Record<Step, string> = {
    1: loc('ماذا تريد أن نطبع؟', 'What should be printed?', 'چی چاپ بکرێت؟'),
    2: loc('تفاصيل الطباعة', 'Printing details', 'وردەکاریی چاپکردن'),
    3: loc('التسليم والموعد', 'Delivery and timing', 'گەیاندن و کات'),
    4: loc('راجع طلبك', 'Review your request', 'داواکارییەکەت پێدابچۆرەوە'),
  };
  const govName = (id: string) => {
    const g = GOVERNORATES.find((x) => x.id === id);
    return g ? g[L] : '';
  };
  const materialName = (id: string) => localMaterial(id, L, catalog?.materials ?? []);
  const pictures = pictureFiles(files);
  const sourceLabel: Record<SourceType, string> = {
    model: loc('ملف مجسم', 'Model file', 'فایلی مۆدێل'),
    link: loc('رابط مجسم', 'Model link', 'لینکی مۆدێل'),
    images: loc('صور مرجعية', 'Reference pictures', 'وێنەی سەرچاوە'),
    description: loc('وصف فقط', 'Description only', 'تەنها وەسف'),
  };

  return (
    <div className="pb-24" data-wizard-step={step} data-wizard-state={state || 'loading'}>
      {/* Where am I: the step, its name, and a quiet four-part progress line. */}
      <div className="mb-5">
        <p className="text-[12px] font-semibold text-text-muted tabular-nums">
          {loc(`الخطوة ${step} من 4`, `Step ${step} of 4`, `هەنگاوی ${step} لە 4`)}
          {editingPublished && <span className="ms-2 text-warning">{loc('تعديل طلب منشور', 'Editing a published request', 'دەستکاریکردنی داواکارییەکی بڵاوکراوە')}</span>}
        </p>
        <h2 className="mt-1 text-[18px] font-bold leading-snug text-text-primary">{stepTitles[step]}</h2>
        <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1 rounded-full transition-colors ${i <= step ? 'bg-gold' : 'bg-border-subtle'}`} />
          ))}
        </div>
      </div>

      {busy === 'load' ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-24 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
          <div className="h-12 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
        </div>
      ) : (
        <div className="space-y-5">
          {step === 1 && (
            <>
              <fieldset>
                <legend className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('ماذا لديك؟', 'What do you have?', 'چیت هەیە؟')}</legend>
                <div role="radiogroup" aria-label={loc('مصدر الطلب', 'Request source', 'سەرچاوەی داواکاری')} className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['model', Box, loc('ملف مجسم', 'A model file', 'فایلێکی مۆدێل'), 'STL · 3MF · OBJ · STEP'],
                      ['link', Link2, loc('رابط مجسم', 'A model link', 'لینکێکی مۆدێل'), 'MakerWorld · Printables'],
                      ['images', ImageIcon, loc('صور مرجعية', 'Pictures', 'وێنە'), loc('صورة أو رسم', 'A photo or a sketch', 'وێنەیەک یان هێڵکارییەک')],
                      ['description', FileText, loc('وصف فقط', 'Words only', 'تەنها وشە'), loc('صف ما تريده', 'Describe what you need', 'ئەوەی پێویستتە باسی بکە')],
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
                    accept={s.source_type === 'model' ? `${MODEL_ACCEPT},${IMAGE_ACCEPT},${PDF_ACCEPT}` : `${IMAGE_ACCEPT},${PDF_ACCEPT}`}
                    onChange={(e) => addFiles(e.target.files)}
                  />
                  {/* The camera itself, on a phone: a photo of the broken part, straight in. */}
                  <input ref={cameraInput} type="file" hidden accept="image/*" capture="environment" onChange={(e) => addFiles(e.target.files)} data-wizard="camera-input" />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    // A full request takes no seventh file (the same count every door asks, R5).
                    disabled={files.length + pending.length >= MAX_FILES}
                    data-wizard="pick-files"
                    className="flex min-h-[88px] w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--clay-field)] px-4 py-4 text-center transition-colors hover:bg-surface active:bg-[var(--clay-well-bg)] active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
                  >
                    <Upload aria-hidden="true" className="h-5 w-5 text-text-muted" />
                    <span className="text-[13.5px] font-semibold text-text-primary">
                      {s.source_type === 'model' ? loc('اختر ملف المجسم', 'Choose the model file', 'فایلی مۆدێلەکە هەڵبژێرە') : loc('اختر الصور', 'Choose pictures', 'وێنەکان هەڵبژێرە')}
                    </span>
                    <span className="text-[11.5px] text-text-muted">{s.source_type === 'model' ? fs.modelHint : fs.imagesHint}</span>
                  </button>
                  {touch && s.source_type === 'images' && (
                    <button
                      type="button"
                      onClick={() => cameraInput.current?.click()}
                      data-wizard="take-photo"
                      className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <Camera aria-hidden="true" className="h-4 w-4" />
                      {fs.takePhoto}
                    </button>
                  )}
                  {unfinished.length > 0 && (
                    <p className="mt-2 text-[11.5px] text-warning" role="status" data-wizard="resume-hint">
                      {unfinished.map((name) => fs.resume(name)).join(' ')}
                    </p>
                  )}
                  {errors.source && <p className="lv-field-error mt-2" role="alert">{errors.source}</p>}
                  {(files.length > 0 || pending.length > 0 || tiles.length > 0) && (
                    <ul className="mt-3 space-y-1.5" aria-label={loc('الملفات', 'Files', 'فایلەکان')}>
                      {files.map((f) => (
                        <li key={f.id} className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-[12.5px]" data-wizard-file={f.inline ? 'picture' : f.kind}>
                          <WizardFileThumb url={f.url} kind={f.inline ? 'image' : f.kind} />
                          <span className="min-w-0 flex-1 truncate text-text-primary" dir="ltr">{f.file_name}</span>
                          {f.analysis?.measured && (
                            <span className="shrink-0 text-text-muted tabular-nums" dir="ltr">
                              {Math.round(f.analysis.dimensions_mm.x)}×{Math.round(f.analysis.dimensions_mm.y)}×{Math.round(f.analysis.dimensions_mm.z)} mm
                            </span>
                          )}
                          {!f.analysis?.measured && measureLater.has(f.id) && (
                            <span className="shrink-0 text-text-muted" data-wizard="measure-later">{fs.measureLater}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => removeFile(f)}
                            aria-label={loc(`حذف ${f.file_name}`, `Remove ${f.file_name}`, `سڕینەوەی ${f.file_name}`)}
                            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                      {pending.map(({ tempId, file: f, objectUrl }) => (
                        <li key={tempId} className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-[12.5px]" data-wizard-pending={tempId}>
                          <WizardFileThumb objectUrl={objectUrl} kind={requestFileKind(f.name) ?? 'document'} />
                          <span className="min-w-0 flex-1 truncate text-text-primary" dir="ltr">{f.name}</span>
                          <span className="shrink-0 text-text-muted tabular-nums" dir="ltr">{formatBytes(f.size)}</span>
                          <button
                            type="button"
                            onClick={() => dropPending(tempId)}
                            aria-label={loc(`إزالة ${f.name}`, `Remove ${f.name}`, `لابردنی ${f.name}`)}
                            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                      {/* The session uploads (§9.4): ring, checksum step, cancel, retry;
                          «التالي» stays busy until each is done or given up. */}
                      {tiles
                        .filter((t) => t.state === 'working')
                        .map((t) => (
                          <li key={t.id} aria-label={fs.uploading} data-wizard="upload-tile">
                            <UploadTile
                              file={t.file}
                              purpose="request"
                              entityId={t.entityId}
                              onDone={() => setTiles((list) => list.map((x) => (x.id === t.id ? { ...x, state: 'done' } : x)))}
                              onCancel={() => setTiles((list) => list.map((x) => (x.id === t.id ? { ...x, state: 'gone' } : x)))}
                            />
                          </li>
                        ))}
                    </ul>
                  )}
                  {files.some((f) => !f.analysis?.measured && measureLater.has(f.id)) && (
                    <p className="mt-2 text-[11.5px] text-text-muted" role="status" data-wizard="measure-later-hint">
                      {fs.measureLaterHint}
                    </p>
                  )}
                </div>
              )}

              {s.source_type === 'link' && (
                <Field
                  label={loc('رابط المجسم', 'Model link', 'لینکی مۆدێل')}
                  error={errors.source}
                  hint={linkInfo?.name ? loc(`وجدنا: ${linkInfo.name}`, `Found: ${linkInfo.name}`, `دۆزرایەوە: ${linkInfo.name}`) : loc('من MakerWorld أو Printables أو Thingiverse…', 'From MakerWorld, Printables, Thingiverse…', 'لە MakerWorld، Printables، Thingiverse…')}
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
              {s.source_type === 'link' && linkInfo && /^https:\/\//i.test(s.source_url.trim()) && (
                <SourceLinkCard key={linkWarm || 'bare'} url={s.source_url} />
              )}

              {s.source_type === 'description' && (
                <p className="rounded-lg bg-surface px-3.5 py-3 text-[12.5px] leading-relaxed text-text-secondary">
                  {loc(
                    'لا بأس بلا ملف. صف الشكل والمقاس والاستعمال، وسيسألك التجار عمّا يحتاجونه قبل تسعيره.',
                    'No file is fine. Describe the shape, the size and what it is for — merchants will ask what they need before pricing it.',
                    'بەبێ فایلیش باشە. شێوە و قەبارە و بەکارهێنانەکەی باس بکە — بازرگانەکان پێش نرخدانان ئەوەی پێویستیانە لێت دەپرسن.'
                  )}
                </p>
              )}

              {/* A published request keeps the title and description merchants
                  read when they offered; the job's facts are what an edit changes. */}
              <Field label={loc('العنوان', 'Title', 'ناونیشان')} error={errors.title} required hint={editingPublished ? loc('لا يتغير بعد النشر.', 'Fixed once published.', 'دوای بڵاوکردنەوە ناگۆڕدرێت.') : undefined}>
                <Input value={s.title} maxLength={140} readOnly={editingPublished} onChange={(e) => set('title', e.target.value)} placeholder={loc('مثال: حامل هاتف للسيارة', 'e.g. A car phone holder', 'بۆ نموونە: هەڵگری مۆبایل بۆ ئۆتۆمبێل')} />
              </Field>
              <Field label={loc('الوصف', 'Description', 'وەسف')} error={errors.description} required hint={editingPublished ? loc('لا يتغير بعد النشر — أضف ما يلزم في ملاحظات التجار.', 'Fixed once published — add anything new in the notes for merchants.', 'دوای بڵاوکردنەوە ناگۆڕدرێت — هەر شتێکی نوێ لە تێبینییەکان بۆ بازرگانەکان زیاد بکە.') : loc('ما هو، ولأي استعمال، وما المهم فيه.', 'What it is, what it is for, what matters about it.', 'چییە، بۆ چییە، و چی تێیدا گرنگە.')}>
                <Textarea value={s.description} rows={4} maxLength={6000} readOnly={editingPublished} onChange={(e) => set('description', e.target.value)} dir="auto" />
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('طريقة الطباعة', 'Printing process', 'شێوازی چاپکردن')}</p>
                <Segmented
                  group="wizard-process"
                  label={loc('طريقة الطباعة', 'Printing process', 'شێوازی چاپکردن')}
                  value={s.process}
                  dataAttr="data-process"
                  onChange={(id) => setS((p) => ({ ...p, process: id as ProcessChoice, material_id: 'unsure' }))}
                  items={[
                    { id: 'fdm', label: loc('خيوط FDM', 'FDM filament', 'دەزووی FDM') },
                    { id: 'resin', label: loc('ريزن', 'Resin', 'ڕێزن') },
                    { id: 'unsure', label: loc('لست متأكدًا', 'Not sure', 'دڵنیا نیم') },
                  ]}
                />
                <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
                  {s.process === 'resin'
                    ? loc('تفاصيل دقيقة جدًا وسطح ناعم — للمجسمات الصغيرة.', 'Very fine detail and a smooth surface — for small models.', 'وردەکاریی زۆر ورد و ڕووی لووس — بۆ مۆدێلە بچووکەکان.')
                    : s.process === 'fdm'
                      ? loc('قوي واقتصادي — لأغلب القطع العملية.', 'Strong and economical — right for most functional parts.', 'بەهێز و ئابووری — گونجاوە بۆ زۆربەی پارچەکانی بەکارهێنان.')
                      : loc('سنعرض طلبك على ورش الطريقتين، ويقترح التاجر الأنسب.', 'We show your request to both kinds of workshop; the merchant suggests what fits.', 'داواکارییەکەت بە هەردوو جۆری وۆرکشۆپ پیشان دەدەین؛ بازرگانەکە ئەوەی گونجاوە دیاری دەکات.')}
                </p>
              </div>

              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('المادة', 'Material', 'ماددە')}</p>
                <div role="radiogroup" aria-label={loc('المادة', 'Material', 'ماددە')} className="flex flex-wrap gap-2">
                  {[{ id: 'unsure', label: loc('لست متأكدًا', 'Not sure', 'دڵنیا نیم') }, ...materials.map((m) => ({ id: m.id, label: localMaterial(m.id, L, catalog?.materials ?? []) }))].map((m) => (
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
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('اللون', 'Colour', 'ڕەنگ')}</p>
                <div role="radiogroup" aria-label={loc('اللون', 'Colour', 'ڕەنگ')} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!s.color_hex}
                    onClick={() => setS((p) => ({ ...p, color_hex: '', color_name: '' }))}
                    className="lv-choice px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {loc('أي لون', 'Any colour', 'هەر ڕەنگێک')}
                  </button>
                  {REQUEST_COLOURS.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      role="radio"
                      aria-checked={s.color_hex === c.hex}
                      onClick={() => setS((p) => ({ ...p, color_hex: c.hex, color_name: c.en }))}
                      className="lv-choice inline-flex items-center gap-2 px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border border-white/20" style={{ backgroundColor: c.hex }} />
                      {c[L]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('الدقة', 'Detail', 'وردی')}</p>
                  <Segmented
                    group="wizard-quality"
                    size="sm"
                    label={loc('الدقة', 'Detail', 'وردی')}
                    value={s.quality}
                    onChange={(id) => set('quality', id as Quality)}
                    items={[
                      { id: 'draft', label: loc('سريعة', 'Quick', 'خێرا') },
                      { id: 'standard', label: loc('قياسية', 'Standard', 'ستاندارد') },
                      { id: 'fine', label: loc('دقيقة', 'Fine', 'ورد') },
                      { id: 'ultra', label: loc('فائقة', 'Ultra', 'زۆر ورد') },
                    ]}
                  />
                </div>
                <Field label={loc('الكمية', 'Quantity', 'بڕ')}>
                  <NumberInput kind="quantity" min={1} max={10000} value={s.quantity} onValueChange={(v) => set('quantity', Math.max(1, v ?? 1))} />
                </Field>
              </div>

              {measured && primary?.analysis ? (
                <p className="lv-well flex items-center gap-2 rounded-md px-3.5 py-3 text-[12.5px] text-text-secondary">
                  <Ruler aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                  {loc('المقاس من ملفك:', 'Size from your file:', 'قەبارە لە فایلەکەتەوە:')}
                  <span className="font-semibold text-text-primary tabular-nums" dir="ltr">
                    {Math.round(primary.analysis.dimensions_mm.x)}×{Math.round(primary.analysis.dimensions_mm.y)}×{Math.round(primary.analysis.dimensions_mm.z)} mm
                  </span>
                </p>
              ) : (
                <fieldset>
                  <legend className="mb-2 text-[13px] font-semibold text-text-secondary">
                    {loc('المقاس التقريبي (ملم)', 'Approximate size (mm)', 'قەبارەی نزیکەیی (ملم)')} <span className="font-normal text-text-muted">{loc('— اختياري', '— optional', '— ئارەزوومەندانە')}</span>
                  </legend>
                  {primary && measureLater.has(primary.id) && (
                    <p className="mb-2 text-[11.5px] text-text-muted" role="status" data-wizard="measure-later-size">
                      {fs.measureLaterHint}
                    </p>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    {(['x', 'y', 'z'] as const).map((k) => (
                      <Field key={k} label={k === 'x' ? loc('الطول', 'Length', 'درێژی') : k === 'y' ? loc('العرض', 'Width', 'پانی') : loc('الارتفاع', 'Height', 'بەرزی')}>
                        <NumberInput min={1} max={5000} decimals={1} unit="mm" value={s.dims[k]} onValueChange={(v) => setS((p) => ({ ...p, dims: { ...p.dims, [k]: v } }))} />
                      </Field>
                    ))}
                  </div>
                </fieldset>
              )}

              <Field
                label={loc('ملاحظات للتجار', 'Notes for the merchants', 'تێبینی بۆ بازرگانەکان')}
                optional
                hint={loc('يراها التجار. لا تكتب رقم هاتفك — يصل للتاجر الذي تختاره تلقائيًا.', 'Merchants see this. Do not write your phone number — the merchant you choose receives it.', 'بازرگانەکان ئەمە دەبینن. ژمارەی مۆبایلەکەت مەنووسە — ئەو بازرگانەی هەڵیدەبژێریت خۆکارانە وەریدەگرێت.')}
              >
                <Textarea value={s.customer_notes} rows={3} maxLength={1000} dir="auto" onChange={(e) => set('customer_notes', e.target.value)} />
              </Field>
            </>
          )}

          {step === 3 && (
            <>
              <Field label={loc('المحافظة', 'Governorate', 'پارێزگا')} optional>
                <Select value={s.governorate} onChange={(e) => set('governorate', e.target.value)}>
                  <option value="">{loc('لم أحدد', 'Not set', 'دیاری نەکراوە')}</option>
                  {GOVERNORATES.map((g) => (
                    <option key={g.id} value={g.id}>{g[L]}</option>
                  ))}
                </Select>
              </Field>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('الاستلام', 'Handover', 'وەرگرتن')}</p>
                <Segmented
                  group="wizard-delivery"
                  label={loc('الاستلام', 'Handover', 'وەرگرتن')}
                  value={s.delivery_pref || 'either'}
                  onChange={(id) => set('delivery_pref', (id === 'either' ? '' : id) as DeliveryPref)}
                  items={[
                    { id: 'delivery', label: loc('توصيل', 'Delivery', 'گەیاندن') },
                    { id: 'pickup', label: loc('استلام بنفسي', 'I collect', 'خۆم وەریدەگرم') },
                    { id: 'either', label: loc('أيهما', 'Either', 'هەر کامیان') },
                  ]}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={loc('أحتاجه قبل', 'Needed by', 'پێویستە پێش')} optional error={errors.deadline}>
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
                <Field label={loc('ميزانيتك', 'Your budget', 'بودجەکەت')} optional hint={loc('يراها التجار. اتركها فارغة إن لم تكن متأكدًا.', 'Merchants see it. Leave it empty if unsure.', 'بازرگانەکان دەیبینن. ئەگەر دڵنیا نیت بەتاڵی بهێڵەوە.')}>
                  <NumberInput kind="money" value={s.budget_iqd} onValueChange={(v, ok) => ok && set('budget_iqd', v)} />
                </Field>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <dl className="lv-surface divide-y divide-border-subtle/60">
                {(
                  [
                    [loc('المصدر', 'Source', 'سەرچاوە'), sourceLabel[s.source_type] + (s.source_type === 'model' || s.source_type === 'images' ? ` · ${files.length}` : ''), 1],
                    [loc('العنوان', 'Title', 'ناونیشان'), s.title, 1],
                    [loc('الطريقة', 'Process', 'شێواز'), s.process === 'unsure' ? loc('لست متأكدًا', 'Not sure', 'دڵنیا نیم') : s.process === 'fdm' ? 'FDM' : loc('ريزن', 'Resin', 'ڕێزن'), 2],
                    [loc('المادة', 'Material', 'ماددە'), s.material_id === 'unsure' ? loc('لست متأكدًا', 'Not sure', 'دڵنیا نیم') : materialName(s.material_id), 2],
                    [loc('اللون', 'Colour', 'ڕەنگ'), s.color_hex ? localColour(s.color_name || s.color_hex, L) : loc('أي لون', 'Any colour', 'هەر ڕەنگێک'), 2],
                    [loc('الكمية', 'Quantity', 'بڕ'), String(s.quantity), 2],
                    [
                      loc('المقاس', 'Size', 'قەبارە'),
                      measured && primary?.analysis
                        ? `${Math.round(primary.analysis.dimensions_mm.x)}×${Math.round(primary.analysis.dimensions_mm.y)}×${Math.round(primary.analysis.dimensions_mm.z)} mm`
                        : statedDims(s)
                          ? `${s.dims.x}×${s.dims.y}×${s.dims.z} mm`
                          : '—',
                      2,
                    ],
                    [loc('ملاحظات للتجار', 'Notes for merchants', 'تێبینی بۆ بازرگانەکان'), s.customer_notes || '—', 2],
                    [loc('المحافظة', 'Governorate', 'پارێزگا'), govName(s.governorate) || '—', 3],
                    [loc('الاستلام', 'Handover', 'وەرگرتن'), s.delivery_pref === 'delivery' ? loc('توصيل', 'Delivery', 'گەیاندن') : s.delivery_pref === 'pickup' ? loc('استلام بنفسي', 'I collect', 'خۆم وەریدەگرم') : loc('أيهما', 'Either', 'هەر کامیان'), 3],
                    [loc('أحتاجه قبل', 'Needed by', 'پێویستە پێش'), s.deadline || '—', 3],
                  ] as Array<[string, string, Step]>
                ).map(([k, v, st], i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                    <dt className="w-28 shrink-0 text-[12.5px] text-text-muted">{k}</dt>
                    <dd className="min-w-0 flex-1 break-words text-[13px] text-text-primary" dir="auto">{v}</dd>
                    <button type="button" onClick={() => setStep(st)} className="-my-2.5 inline-flex min-h-[44px] shrink-0 items-center rounded px-1 text-[12px] font-semibold text-gold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                      {loc('تعديل', 'Edit', 'دەستکاری')}
                    </button>
                  </div>
                ))}
                <div className="flex items-start gap-3 px-4 py-2.5">
                  <dt className="w-28 shrink-0 text-[12.5px] text-text-muted">{loc('الميزانية', 'Budget', 'بودجە')}</dt>
                  <dd className="min-w-0 flex-1 text-[13px] text-text-primary">{s.budget_iqd ? <Money iqd={s.budget_iqd} /> : '—'}</dd>
                </div>
              </dl>

              {/* What the merchants will look at: the pictures as pictures, the link as its card (R4, R1). */}
              {(pictures.length > 0 || (s.source_type === 'link' && !!s.source_url.trim())) && (
                <div className="lv-surface space-y-2 px-4 py-3" data-wizard="review-sources">
                  {pictures.length > 0 && (
                    <ul aria-label={loc('الصور', 'Pictures', 'وێنەکان')} className="flex flex-wrap gap-2">
                      {pictures.map((f) => (
                        <li key={f.id} data-wizard-thumb="review">
                          <RequestThumb url={f.url} size={56} alt={f.file_name} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.source_type === 'link' && <SourceLinkCard key={linkWarm || 'bare'} url={s.source_url} />}
                </div>
              )}

              <div className="lv-surface px-4 py-3.5" data-wizard="estimate">
                <p className="text-[12.5px] text-text-muted">{loc('تقدير Levonis', 'Levonis estimate', 'خەمڵاندنی Levonis')}</p>
                {quote?.priced ? (
                  <>
                    <p className="mt-1 text-[17px] font-bold text-text-primary">
                      <Money iqd={quote.price_low_iqd} /> <span className="text-text-muted">–</span> <Money iqd={quote.price_high_iqd} />
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                      {quote.range_basis === 'materials'
                        ? loc('المادة لم تُحدد، فهذا المدى يغطي المواد الممكنة. السعر النهائي من عروض التجار.', 'The material is open, so this range covers the materials it could be. The final price comes from merchants’ offers.', 'ماددەکە دیاری نەکراوە، بۆیە ئەم مەودایە ئەو ماددانە دەگرێتەوە کە دەکرێت بەکاربهێنرێن. نرخی کۆتایی لە ئۆفەری بازرگانەکانەوە دێت.')
                        : loc('تقدير فقط — السعر النهائي من عروض التجار.', 'An estimate — the final price comes from merchants’ offers.', 'تەنها خەمڵاندنە — نرخی کۆتایی لە ئۆفەری بازرگانەکانەوە دێت.')}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                    {loc('لا تقدير بلا ملف مقيس — سيسعّره التجار في عروضهم.', 'No estimate without a measured file — merchants will price it in their offers.', 'بەبێ فایلی پێوراو خەمڵاندن نییە — بازرگانەکان لە ئۆفەرەکانیاندا نرخی بۆ دادەنێن.')}
                  </p>
                )}
              </div>

              {editingPublished && liveOffers > 0 && (
                <p className="lv-alert lv-alert-warning text-[12.5px]" role="note">
                  {loc(
                    `على هذا الطلب ${liveOffers} عرض قائم. تغيير ما سعّره التجار يوقف عروضهم حتى يؤكدوها.`,
                    `This request has ${liveOffers} standing offer(s). Changing what merchants priced pauses them until they re-confirm.`,
                    `ئەم داواکارییە ${liveOffers} ئۆفەری هەنووکەیی هەیە. گۆڕینی ئەوەی بازرگانەکان نرخیان بۆ داناوە ڕایاندەگرێت تا دووبارە پشتڕاستی دەکەنەوە.`
                  )}
                </p>
              )}
              {!editingPublished && (
                <p className="text-[12px] leading-relaxed text-text-muted">
                  {loc(
                    'عند النشر يظهر طلبك على لوحة الطلبات ويُبلَّغ التجار الذين تناسب ورشهم. رقمك وعنوانك لا يصلان لأي تاجر إلا الذي تقبل عرضه.',
                    'Publishing puts your request on the board and tells the merchants whose workshops fit. Your phone and address reach only the merchant whose offer you accept.',
                    'بڵاوکردنەوە داواکارییەکەت دەخاتە سەر تەختەی داواکارییەکان و ئەو بازرگانانە ئاگادار دەکاتەوە کە وۆرکشۆپەکانیان گونجاوە. ژمارە و ناونیشانەکەت تەنها دەگاتە ئەو بازرگانەی ئۆفەرەکەی قبوڵ دەکەیت.'
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
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-surface-raised shadow-dock px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <Button variant="secondary" className="whitespace-nowrap" onClick={() => (step === 1 ? onCancel() : setStep((x) => (x - 1) as Step))} disabled={!!busy && busy !== 'load'}>
            {step === 1 ? loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە') : loc('رجوع', 'Back', 'گەڕانەوە')}
          </Button>
          {!editingPublished && (step > 1 || requestId) && (
            <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={saveDraft} loading={busy === 'save'} data-wizard="save-draft">
              {loc('احفظ مسودة', 'Save draft', 'ڕەشنووس پاشەکەوت بکە')}
            </Button>
          )}
          <div className="ms-auto" />
          {step < 4 ? (
            <Button variant="primary" className="whitespace-nowrap" onClick={next} loading={busy === 'next'} loadingLabel={loc('جارٍ الرفع والقياس…', 'Uploading and measuring…', 'بارکردن و پێوانە…')} data-wizard="next">
              {loc('التالي', 'Next', 'دواتر')}
            </Button>
          ) : (
            <Button variant="primary" className="whitespace-nowrap" onClick={publish} loading={busy === 'publish'} data-wizard="publish">
              {editingPublished ? loc('احفظ التعديلات', 'Save changes', 'گۆڕانکارییەکان پاشەکەوت بکە') : loc('انشر', 'Publish', 'بڵاوکردنەوە')}
            </Button>
          )}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
