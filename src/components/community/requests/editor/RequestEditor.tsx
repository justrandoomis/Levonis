/**
 * THE REQUEST EDITOR IN FOUR STEPS (community UI plan C4, §4; P1-06,
 * docs/DECISIONS.md row 268): one editor for a new request, a draft and the
 * edit of a published one, laid out as the references of the owner draw it:
 *
 *   1 «الملفات والفكرة»     what the customer has (files, pictures, links,
 *                           written references), the title, the description
 *   2 «إعدادات الطباعة»     the method, the material and colour, the quality,
 *                           the quantity, the size, the notes; more parts
 *   3 «التسليم والميزانية»  the governorate, the handover, the day, the
 *                           budget and its switch, the summary
 *   4 «راجع طلبك»           every card with «تعديل», the estimate, «ما يراه
 *                           الآخرون», and the verb: «انشر الطلب», «احفظ
 *                           التعديلات» or «أرسل إلى {store}»
 *
 * THE STEP LIVES IN THE ADDRESS (`?step=1..4`): a step forward is a new
 * history entry, so Android Back and the header back walk the steps, and a
 * reload opens the same step with the same data (the server draft, plus this
 * tab copy of what the server does not have yet, sessionMirror.ts).
 *
 * THE DRAFT IS BORN ON THE FIRST ACT (P1-06 critique 4: nothing is born of a
 * visit alone): the first keystroke, file or link creates it through the
 * entry door (POST /api/marketplace/print/requests) and the address becomes
 * /requests/new/<id>?step=1 in place. An entry from a project («اطلب طباعة
 * مثلها»: `state.project` or `?project=`), a product or a store is created
 * on arrival; the server answers an untouched draft of the same origin again
 * instead of making another. A published request opens at /requests/<id>/edit,
 * where nothing is saved until «احفظ التعديلات» except files, which the
 * upload doors attach at once, as the banner says (critique 2).
 *
 * LEAVING. The router of this app cannot block a navigation (critique 3), so
 * the editor flushes with a keepalive save on every way out
 * (persistence.ts), and its OWN back, on step 1, asks before leaving work the
 * server could not take: a draft whose save failed, or the unpublished
 * changes of a published request («تغادر دون حفظ؟»).
 *
 * After a publish the steps this visit pushed are walked back first, so the
 * request page that follows has the board behind it, never the editor
 * (critique 5); then the page (src/pages/community/RequestNew.tsx) lands on
 * /requests/:id with `{ published: true }`.
 *
 * No 3D code is loaded here (BASE 6): «عرض ثلاثي الأبعاد» opens the existing
 * viewer in a new tab, which also keeps this page and its unsaved work open.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, Store } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { useAuth } from '../../../../AuthContext';
import { ApiError } from '../../../../lib/api';
import { apiRefusal } from '../../../../lib/refusalStrings';
import { useSuppressBottomNav } from '../../../../lib/bottomNavSuppress';
import { useSignInPrompt } from '../../../../lib/guest';
import { Menu } from '../../../ui/Menu';
import { useConfirm } from '../../../ui/ConfirmDialog';
import { useToast } from '../../../ui/Toast';
import { ActionDock } from '../../kit/display';
import { CountedField } from '../../kit/fields';
import { GoldButton, KitButton, KitIconButton } from '../../kit/buttons';
import { warmLink } from '../../links/useLinkCard';
import { forgetCommunityFeed } from '../../hub/feedCache';
import { requestPath } from '../requestStates';
import { editorApi, requestsApi, type Catalog, type DraftFile, type EditorEntry, type EntryCopies, type Quote } from '../api';
import {
  addLink,
  addMaterial,
  addPart,
  addTextRef,
  blankState,
  bodyKey,
  chooseMaterial,
  chooseProcess,
  duplicatePart,
  editorBody,
  fileStored,
  hydrate,
  isEditable,
  isFileSource,
  isPublishedEdit,
  LIMITS,
  measurableFiles,
  movePart,
  removeMaterial,
  removePart,
  removeSource,
  setOriginal,
  setPrimary,
  updateMaterial,
  updatePart,
  updateSource,
  type EditorState,
  type Key,
} from './state';
import { clearMirror, defaultMirrorStorage, dropOtherAccounts, mirrorBase, moveNewMirror, readMirror } from './sessionMirror';
import { useDraftPersistence } from './persistence';
import { useUploads, unfinishedUploads } from './uploads';
import { useKeyboardOpen } from './useKeyboardOpen';
import { SourcesArea, sourceName } from './SourcesArea';
import { gridPictures, type GridPicture } from './ImageGrid';
import { ImageViewer } from './ImageViewer';
import { PartsEditor } from './PartsEditor';
import { ReviewStep, RequestSummary, type EditTarget } from './ReviewStep';
import { DeliveryFields } from './DeliveryFields';
import { AudiencePanel } from './AudiencePanel';
import { partEstimates } from './estimate';
import { WizardHeader, stepOf, stepTitle, type WizardStep } from './WizardHeader';
import { editorLang, editorStrings, fill } from './strings';

type Load =
  | { phase: 'loading' }
  | { phase: 'entering'; kind: EditorEntry['kind'] }
  | { phase: 'failed'; error: unknown; entry?: boolean }
  | { phase: 'ready' }
  | { phase: 'locked'; requestId: string };

/** How the editor hands the request back to its page. */
export type EditorDone = { id: string; how: 'published' | 'saved' } | { id: string; how: 'sent'; chatId: string };

/** The history state the editor stamps on a step it pushed: how many steps of this visit lie behind. */
interface StepMark {
  editorDepth?: number;
  focus?: string;
}

/**
 * WHERE A NEW REQUEST COMES FROM, read from the editor address and the
 * router state (row 268):
 *   ?project=<post> or state.project   the files of a project, copied in («اطلب طباعة مثلها»)
 *   ?product=<product>&store=<slug>    a store product, for that store only
 *   ?store=<merchant>                  «لهذا المتجر فقط»
 * Anything else is a blank request (a carried `?link=` is added on arrival).
 */
export function entryFrom(params: URLSearchParams, routerState?: unknown): EditorEntry | null {
  const carried = (routerState as { project?: unknown } | null)?.project;
  const fromState =
    typeof carried === 'string' ? carried : carried && typeof carried === 'object' && typeof (carried as { id?: unknown }).id === 'string' ? (carried as { id: string }).id : '';
  const project = (params.get('project') ?? fromState).trim();
  if (project) return { kind: 'project', post_id: project };
  const product = params.get('product')?.trim();
  const store = params.get('store')?.trim();
  if (product && store) return { kind: 'product', product_id: product, store };
  if (store) return { kind: 'store', merchant_id: store };
  return null;
}

/** A skipped copy in the reader words: the editor own for the copy codes, the refusal table for the rest. */
export function copyReason(code: string, lang: 'ar' | 'en' | 'ckb', t: { copyTooLarge: string; copyKind: string; copyFull: string; copyMissing: string; copyChanged: string; copyFailed: string }): string {
  switch (code) {
    case 'COPY_TOO_LARGE':
      return t.copyTooLarge;
    case 'COPY_KIND':
      return t.copyKind;
    case 'REQUEST_FILES_FULL':
      return t.copyFull;
    case 'COPY_MISSING':
      return t.copyMissing;
    case 'COPY_CHANGED':
      return t.copyChanged;
    default:
      return apiRefusal({ code }, lang, t.copyFailed);
  }
}

/** The address an editable request lives at: a draft at /requests/new/:id, a published one at /requests/:id/edit. */
export function editorPath(requestId: string, requestState: string): string {
  if (!requestId) return '/requests/new';
  const id = encodeURIComponent(requestId);
  return requestState === 'draft' ? `/requests/new/${id}` : `/requests/${id}/edit`;
}

/** The query of a step: `step` set, the entry keys of the arrival dropped (they are read once). */
export function stepSearch(params: URLSearchParams, step: WizardStep): string {
  const p = new URLSearchParams(params);
  p.set('step', String(step));
  for (const k of ['link', 'project', 'product', 'store']) p.delete(k);
  return `?${p.toString()}`;
}

/** The step-1 questions the publish asks too: a title of 4–140 and a description of 10 or more. */
export function describeErrors(s: Pick<EditorState, 'title' | 'description'>, t: { titleError: string; descError: string }): { title?: string; description?: string } {
  const out: { title?: string; description?: string } = {};
  const title = s.title.trim();
  if (title.length < 4 || title.length > 140) out.title = t.titleError;
  if (s.description.trim().length < 10) out.description = t.descError;
  return out;
}

/** Bring an element into view and give it the focus (a heading or a section gets a programmatic tab stop). */
function focusTarget(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  const control = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement || el instanceof HTMLSelectElement;
  if (!control && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
  return true;
}

export default function RequestEditor({
  requestId: routeId,
  carriedLink: carried = '',
  onDone,
  onLeave,
}: {
  requestId: string;
  /** A model link a door carried to a new request (src/pages/community/RequestNew.tsx reads it). */
  carriedLink?: string;
  /** Called once the history entries of the steps are walked back. */
  onDone: (done: EditorDone) => void;
  /** Leave the editor (its own back on step 1, once allowed). */
  onLeave: () => void;
}) {
  const { lang, dir } = useLanguage();
  const L = editorLang(lang);
  const t = editorStrings(lang);
  const { user, refreshUser } = useAuth();
  const userId = user?.id ?? '';
  const { signIn } = useSignInPrompt();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  useSuppressBottomNav();
  const keyboard = useKeyboardOpen();
  const storage = useMemo(() => defaultMirrorStorage(), []);
  const [touch] = useState(() => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);

  const [state, setStateRaw] = useState<EditorState | null>(null);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({});
  const [measuring, setMeasuring] = useState<ReadonlySet<string>>(() => new Set());
  const [measureLater, setMeasureLater] = useState<ReadonlySet<string>>(() => new Set());
  const [quote, setQuote] = useState<Quote | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<{ text: string; closed: boolean } | null>(null);
  const [processNotes, setProcessNotes] = useState<ReadonlySet<Key>>(() => new Set());
  /** What a project entry copied: the post, the count, and what it skipped (each with «انسخه مجددًا»). */
  const [copies, setCopies] = useState<(EntryCopies & { postId: string; seeded: boolean }) | null>(null);
  const [copying, setCopying] = useState('');
  /** The link flow, for the effect that adds a carried link (it is defined below the render guards). */
  const addLinkFlowRef = useRef<(url: string) => Promise<string>>(async () => '');
  const stateRef = useRef<EditorState | null>(null);
  stateRef.current = state;
  const setState = useCallback((updater: (s: EditorState | null) => EditorState | null) => setStateRaw(updater), []);
  const edit = (fn: (s: EditorState) => EditorState) => setStateRaw((s) => (s ? fn(s) : s));

  const mark = (location.state ?? null) as StepMark | null;
  const depth = typeof mark?.editorDepth === 'number' ? mark.editorDepth : 0;
  // A request not born yet has only its first step.
  const step: WizardStep = state && !state.requestId ? 1 : stepOf(params.get('step'));

  const persistence = useDraftPersistence({
    state,
    setState,
    userId,
    storage,
    enabled: load.phase === 'ready' && !!state && isEditable(state),
  });
  const persist = useRef(persistence);
  persist.current = persistence;

  // ---------------------------------------------------------------- loading

  /** The id this page created itself: the address change it causes is not a new load. */
  const createdHere = useRef('');
  /** The address the editor arrived at, read once: an entry and a carried link. */
  const arrival = useRef({ entry: routeId ? null : entryFrom(params, location.state), link: routeId ? '' : carried.trim() });
  useEffect(() => {
    if (!userId) return;
    dropOtherAccounts(storage, userId);
    if (routeId && routeId === createdHere.current) return;
    let alive = true;
    setLoad({ phase: 'loading' });
    const entry = routeId ? null : arrival.current.entry;
    if (entry) {
      // A draft made from a project, a product or a store: born on the server
      // (an idle one from the same origin is answered again), then loaded at
      // its own address like every draft, at its first step.
      setLoad({ phase: 'entering', kind: entry.kind });
      editorApi
        .createEntry(entry, lang)
        .then(({ request_id, copied, draft }) => {
          if (!alive) return;
          if (entry.kind === 'project') {
            setCopies({ postId: entry.post_id, files: copied?.files ?? 0, skipped: copied?.skipped ?? [], seeded: (draft.model?.parts.length ?? 0) > 1 });
          }
          navigate(`/requests/new/${encodeURIComponent(request_id)}?step=1`, { replace: true });
        })
        .catch((error) => alive && setLoad({ phase: 'failed', error, entry: true }));
      return () => {
        alive = false;
      };
    }
    if (!routeId) {
      const fresh = blankState();
      const copy = readMirror(storage, userId, '', null);
      persist.current.reset(fresh);
      setStateRaw(copy ?? fresh);
      setLoad({ phase: 'ready' });
      return;
    }
    editorApi
      .draft(routeId)
      .then(({ draft }) => {
        if (!alive) return;
        const fresh = hydrate(draft);
        if (!isEditable(fresh)) {
          setStateRaw(fresh);
          setLoad({ phase: 'locked', requestId: draft.id });
          return;
        }
        // The right address for what it is: a draft, or a published request.
        const want = editorPath(draft.id, draft.state);
        if (location.pathname !== want) navigate(`${want}${location.search}`, { replace: true, state: location.state });
        const copy = readMirror(storage, userId, draft.id, mirrorBase(fresh));
        persist.current.reset(fresh);
        setStateRaw(copy ? { ...copy, updatedAt: fresh.updatedAt, revision: fresh.revision, liveOffers: fresh.liveOffers, requestState: fresh.requestState } : fresh);
        setLoad({ phase: 'ready' });
      })
      .catch((error) => alive && setLoad({ phase: 'failed', error }));
    return () => {
      alive = false;
    };
    // A load per request and account; the rest are read when it answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, userId]);

  useEffect(() => {
    requestsApi.catalog().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  // ---------------------------------------------------------------- the draft is born

  const creating = useRef<Promise<string> | null>(null);
  const ensureRequest = useCallback(async (): Promise<string> => {
    const now = stateRef.current;
    if (now?.requestId) return now.requestId;
    if (creating.current) return creating.current;
    creating.current = (async () => {
      try {
        const { request_id, draft } = await editorApi.createEntry();
        createdHere.current = request_id;
        const born = hydrate(draft);
        persist.current.reset(born);
        setStateRaw((cur) => (cur ? { ...cur, requestId: request_id, requestState: 'draft', updatedAt: born.updatedAt, revision: born.revision } : born));
        const cur = stateRef.current;
        if (cur) moveNewMirror(storage, userId, { ...cur, requestId: request_id, updatedAt: born.updatedAt });
        navigate(`/requests/new/${encodeURIComponent(request_id)}?step=1`, { replace: true });
        return request_id;
      } finally {
        creating.current = null;
      }
    })();
    return creating.current;
  }, [navigate, storage, userId]);

  // The first change of a blank page creates the draft (critique 4): nothing is born of a visit alone.
  const blankKey = useMemo(() => bodyKey(blankState()), []);
  const createFailed = useRef(0);
  useEffect(() => {
    if (!state || state.requestId || load.phase !== 'ready') return;
    if (bodyKey(state) === blankKey) return;
    if (Date.now() - createFailed.current < 5_000) return;
    ensureRequest().catch(() => {
      createFailed.current = Date.now();
    });
  }, [state, load.phase, blankKey, ensureRequest]);

  // A link carried to a blank page (Tools, a link card, an old address) is
  // checked and added on arrival, which is the act that creates the draft.
  const carriedLink = useRef(false);
  useEffect(() => {
    if (carriedLink.current || load.phase !== 'ready' || !state || state.requestId) return;
    const link = arrival.current.link;
    if (!link) return;
    carriedLink.current = true;
    void addLinkFlowRef.current(link).then((err) => err && toast.error(err));
    // Once, when the blank page is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.phase, state?.requestId]);

  // ---------------------------------------------------------------- uploads

  const measure = useCallback(async (requestId: string, f: DraftFile) => {
    if (f.kind !== 'model' || f.analysis?.measured) return;
    setMeasuring((s) => new Set([...s, f.id]));
    try {
      const r = await requestsApi.analyze(requestId, f.id);
      if (r.measure === 'later') setMeasureLater((s) => new Set([...s, f.id]));
      if (r.analysis) setStateRaw((s) => (s ? { ...s, files: s.files.map((x) => (x.id === f.id ? { ...x, analysis: r.analysis } : x)) } : s));
    } catch {
      // the next visit measures it
    } finally {
      setMeasuring((s) => {
        const next = new Set(s);
        next.delete(f.id);
        return next;
      });
    }
  }, []);

  const uploads = useUploads({
    lang: L,
    ensureRequest,
    beforeUpload: () => persist.current.flush(),
    storedFiles: () => stateRef.current?.files ?? [],
    readFiles: async (id) => (await editorApi.draft(id)).draft.files,
    onStored: (f) => {
      edit((s) => fileStored(s, f));
      const id = stateRef.current?.requestId;
      if (id) void measure(id, f);
    },
    failedText: t.uploadFailedReason,
  });

  // Models stored before this visit and never measured are measured now.
  useEffect(() => {
    if (load.phase !== 'ready' || !state?.requestId) return;
    for (const f of state.files) if (f.kind === 'model' && !f.analysis && !measuring.has(f.id)) void measure(state.requestId, f);
    // Once per load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.phase, state?.requestId]);

  const [unfinished, setUnfinished] = useState<string[]>([]);
  useEffect(() => {
    let store: Storage | null = null;
    try {
      store = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    } catch {
      store = null;
    }
    setUnfinished(unfinishedUploads(state?.requestId ?? '', store));
  }, [state?.requestId, uploads.rows.length]);

  // ---------------------------------------------------------------- the estimate

  const body = state ? JSON.stringify(editorBody(state)) : '';
  useEffect(() => {
    const s = stateRef.current;
    if (!s?.requestId || load.phase !== 'ready') return;
    let alive = true;
    const timer = setTimeout(() => {
      editorApi
        .quote(s.requestId, editorBody(s))
        .then((d) => alive && setQuote(d.quote))
        .catch(() => alive && setQuote(null));
    }, 800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [body, load.phase]);

  // ---------------------------------------------------------------- leaving

  // The browser asks before closing a tab that would lose work: the
  // unpublished edits of a published request, or a draft the server could not take.
  useEffect(() => {
    const risky = !!state && persistence.dirty && (isPublishedEdit(state) || ['failed', 'offline', 'signedOut', 'conflict'].includes(persistence.status));
    if (!risky) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [state, persistence.dirty, persistence.status]);

  // ---------------------------------------------------------------- a step arrives

  // Each step opens at its top with the focus on its title, or on the card an
  // «تعديل» of the review named. The first paint of a load keeps the page as it is.
  const lastStep = useRef<WizardStep | null>(null);
  useLayoutEffect(() => {
    if (load.phase !== 'ready' || !state) return;
    const want = mark?.focus;
    if (lastStep.current === step && !want) return;
    const first = lastStep.current === null;
    lastStep.current = step;
    requestAnimationFrame(() => {
      if (want && focusTarget(want)) return;
      if (first) return;
      window.scrollTo({ top: 0 });
      document.getElementById('main-scroll-container')?.scrollTo({ top: 0 });
      focusTarget('editor-step-title');
    });
    // The step and the mark of its entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, location.key, load.phase]);

  // ---------------------------------------------------------------- render guards

  if (load.phase === 'loading' || load.phase === 'entering' || (!state && load.phase === 'ready')) {
    const entering = load.phase === 'entering';
    return (
      <div className="space-y-3 py-6" aria-busy="true" data-editor={entering ? `entering-${load.kind}` : 'loading'}>
        <p className={entering ? 'text-[15px] font-semibold text-text-secondary' : 'sr-only'} role="status">
          {entering && load.kind === 'project' ? t.copyingProject : t.preparing}
        </p>
        <div className="h-24 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
        <div className="h-40 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
      </div>
    );
  }
  if (load.phase === 'failed') {
    return (
      <div className="py-10 text-center" data-editor="load-failed">
        <p className="text-[15px] font-semibold text-text-primary">{load.entry ? t.entryFailed : t.loadFailed}</p>
        <p className="mt-1 text-[13px] text-text-secondary">{apiRefusal(load.error, L, '')}</p>
        <KitButton className="mt-4" variant="secondary" onClick={() => navigate(0)}>
          {t.retryLoad}
        </KitButton>
      </div>
    );
  }
  if (load.phase === 'locked' || !state) {
    const id = load.phase === 'locked' ? load.requestId : '';
    return (
      <div className="py-10 text-center" data-editor="not-editable">
        <p className="text-[15px] font-semibold text-text-primary">{t.notEditable}</p>
        {id && (
          <GoldButton className="mt-4" onClick={() => navigate(requestPath(id), { replace: true })}>
            {t.openRequest}
          </GoldButton>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- derived

  const s = state;
  const publishedEdit = isPublishedEdit(s);
  const catalogue = catalog?.materials ?? [];
  const refs = s.sources.filter((x) => !x.original).map((x) => ({ key: x.key, label: sourceName(s, x) }));
  const refName = (key: string) => {
    const x = s.sources.find((y) => y.key === key);
    return x ? sourceName(s, x) : '';
  };
  const pictures: GridPicture[] = gridPictures(s, uploads.rows);
  const estimates = partEstimates(quote, s.parts.length, L, t);
  const processOf = (id: string): 'fdm' | 'resin' | '' => catalogue.find((m) => m.id === id)?.process ?? '';
  const saveRefusal = persistence.error ? apiRefusal(persistence.error, L, t.saveFailed) : '';

  // ---------------------------------------------------------------- moving between steps

  /** A step forward: a new history entry, marked with how many steps of this visit lie behind. */
  const pushStep = (to: WizardStep) => {
    const mark: StepMark = { editorDepth: depth + 1 };
    navigate({ pathname: location.pathname, search: stepSearch(params, to) }, { state: mark });
  };
  /** A move that is not a step forward (back without a pushed step, an «تعديل» of the review): the entry is replaced. */
  const jumpStep = (to: WizardStep, focus?: string) => {
    const mark: StepMark = { editorDepth: depth, ...(focus ? { focus } : {}) };
    navigate({ pathname: location.pathname, search: stepSearch(params, to) }, { replace: true, state: mark });
  };

  /** Walk back the steps this visit pushed, then go on (the page behind the editor is what Back reaches next). */
  const unwind = (then: () => void) => {
    if (depth <= 0) {
      then();
      return;
    }
    window.addEventListener('popstate', () => setTimeout(then, 0), { once: true });
    navigate(-depth);
  };

  const flushOnLeave = (e: React.FocusEvent<HTMLElement>) => {
    const nextFocus = e.relatedTarget as Node | null;
    if (nextFocus && e.currentTarget.contains(nextFocus)) return;
    void persistence.flush();
  };

  const next = async () => {
    if (step === 1 && !publishedEdit) {
      const found = describeErrors(s, t);
      setErrors(found);
      if (found.title || found.description) {
        requestAnimationFrame(() => focusTarget(found.title ? 'editor-title' : 'editor-description'));
        return;
      }
    }
    if (!publishedEdit) await persistence.flush();
    pushStep((step + 1) as WizardStep);
  };

  /** The header back: the step before, or, on step 1, out (asking first when work would be lost). */
  const back = async () => {
    if (step > 1) {
      if (depth > 0) navigate(-1);
      else jumpStep((step - 1) as WizardStep);
      return;
    }
    if (persistence.dirty) {
      const saved = !publishedEdit && s.requestId ? await persistence.flush() : false;
      if (!saved) {
        const ok = await confirm({
          title: t.leaveTitle,
          consequence: publishedEdit ? t.leaveBodyEdit : t.leaveBody,
          confirmLabel: t.leave,
          cancelLabel: t.stay,
          destructive: true,
        });
        if (!ok) return;
      }
    }
    onLeave();
  };

  const pickFiles = async (files: File[]) => {
    if (publishedEdit && s.liveOffers > 0) {
      const ok = await confirm({ title: t.addOnPublishedTitle, consequence: t.addOnPublishedBody.replace('{n}', String(s.liveOffers)), confirmLabel: t.addAnyway });
      if (!ok) return;
    }
    uploads.add(files);
  };

  const addLinkFlow = async (url: string): Promise<string> => {
    try {
      const d = await requestsApi.checkLink(url);
      const [, , code] = addLink(stateRef.current ?? s, d.link.canonical_url, d.link.provider);
      if (code) return apiRefusal({ code }, L, t.linkInvalid);
      edit((cur) => addLink(cur, d.link.canonical_url, d.link.provider)[0]);
      // The server learns the link card once, so every reader draws it from the stored row (R1).
      void warmLink(d.link.canonical_url);
      return '';
    } catch (e) {
      return apiRefusal(e, L, t.linkInvalid);
    }
  };
  addLinkFlowRef.current = addLinkFlow;

  const addTextFlow = (text: string): string => {
    const [, , err] = addTextRef(s, text);
    if (err === 'TEXT_REFS_TOO_MANY') return apiRefusal({ code: err }, L, fill(t.textRefsFull, { n: LIMITS.maxTextRefs }));
    if (err) return '';
    edit((cur) => addTextRef(cur, text)[0]);
    return '';
  };

  const removeSourceFlow = async (key: Key) => {
    const x = s.sources.find((y) => y.key === key);
    if (!x) return;
    if (isFileSource(x) && x.fileId && s.requestId) {
      const ok = await confirm({
        title: t.removeTitle,
        consequence: publishedEdit && s.liveOffers > 0 ? t.removeWithOffers : t.removePlain,
        confirmLabel: t.remove,
        destructive: true,
      });
      if (!ok) return;
      try {
        await requestsApi.removeFile(s.requestId, x.fileId);
      } catch (e) {
        toast.error(apiRefusal(e, L, t.saveFailed));
        return;
      }
    }
    edit((cur) => removeSource(cur, key));
  };

  const view3d = async (fileId: string) => {
    if (!s.requestId) return;
    try {
      const d = await editorApi.viewerToken(s.requestId, fileId);
      window.open(d.url, '_blank', 'noopener');
    } catch (e) {
      toast.error(apiRefusal(e, L, t.loadFailed));
    }
  };

  const publish = async () => {
    setPublishError(null);
    if (!publishedEdit) {
      const found = describeErrors(s, t);
      if (found.title || found.description) {
        setErrors(found);
        jumpStep(1, found.title ? 'editor-title' : 'editor-description');
        return;
      }
    }
    if (uploads.failed > 0) {
      const ok = await confirm({ title: t.failedUploadsTitle, consequence: t.failedUploadsBody.replace('{n}', String(uploads.failed)), confirmLabel: t.publishWithout });
      if (!ok) return;
    }
    if (publishedEdit && s.liveOffers > 0) {
      const ok = await confirm({ title: t.saveChangesConfirmTitle, consequence: t.saveChangesConfirmBody.replace('{n}', String(s.liveOffers)), confirmLabel: t.saveChanges });
      if (!ok) return;
    }
    setPublishing(true);
    try {
      const id = await ensureRequest();
      if (!publishedEdit && !(await persistence.flush())) {
        setPublishError({ text: persistence.status === 'conflict' ? t.conflictTitle : t.saveFailed, closed: false });
        return;
      }
      const cur = stateRef.current ?? s;
      if (cur.direct && !publishedEdit) {
        // A request for one store is SENT: its conversation opens and its
        // card lands there; the customer reads the store offer in it.
        const sent = await editorApi.sendDirect(id);
        clearMirror(storage, userId, id);
        persistence.reset(cur);
        toast.success(fill(t.directSentTitle, { store: cur.direct.store_name }));
        unwind(() => onDone({ id, how: 'sent', chatId: sent.chat_id }));
        return;
      }
      await editorApi.publish(id, editorBody(cur));
      forgetCommunityFeed('requests');
      clearMirror(storage, userId, id);
      persistence.reset(cur);
      toast.success(publishedEdit ? t.changesSaved : t.publishedToast);
      unwind(() => onDone({ id, how: publishedEdit ? 'saved' : 'published' }));
    } catch (e) {
      const closed = e instanceof ApiError && e.code === 'COMMUNITY_CLOSED';
      setPublishError({ text: closed ? t.closedNotice : apiRefusal(e, L, publishedEdit ? t.saveFailed : s.direct ? t.sendFailed : t.publishFailed), closed });
    } finally {
      setPublishing(false);
    }
  };

  const deleteDraft = async () => {
    if (!s.requestId) {
      clearMirror(storage, userId, '');
      onLeave();
      return;
    }
    const ok = await confirm({ title: t.deleteDraftTitle, consequence: t.deleteDraftBody, confirmLabel: t.deleteDraft, destructive: true });
    if (!ok) return;
    try {
      await editorApi.cancel(s.requestId);
      clearMirror(storage, userId, s.requestId);
      persistence.reset(s);
      forgetCommunityFeed('requests');
      toast.success(t.draftDeleted);
      unwind(() => navigate('/requests?view=mine', { replace: true }));
    } catch (e) {
      toast.error(apiRefusal(e, L, t.saveFailed));
    }
  };

  const signBackIn = async () => {
    await refreshUser();
    // Still signed in here (the refusal was another account, or the check
    // could not tell): the sign-in page, with the way back.
    signIn();
  };

  const takeLatest = async () => {
    if (persistence.dirty) {
      const ok = await confirm({ title: t.loadLatestConfirmTitle, consequence: t.loadLatestConfirmBody, confirmLabel: t.loadLatest, destructive: true });
      if (!ok) return;
    }
    persistence.takeLatest();
  };
  const keepMine = async () => {
    const ok = await confirm({ title: t.keepMineConfirmTitle, consequence: t.keepMineConfirmBody, confirmLabel: t.keepMine, destructive: true });
    if (ok) await persistence.keepMine();
  };

  /** «انسخه مجددًا»: a skipped project file, copied again (never one the request already holds). */
  const copyAgain = async (postFileId: string) => {
    if (!copies || !s.requestId) return;
    setCopying(postFileId);
    try {
      await persistence.flush();
      const d = await editorApi.copyFromProject(s.requestId, copies.postId, [postFileId]);
      const fresh = hydrate(d.draft);
      persistence.reset(fresh);
      setStateRaw((cur) => (cur ? { ...fresh, title: cur.title, description: cur.description, delivery: cur.delivery } : fresh));
      setCopies((c) => (c ? { ...c, files: c.files + d.copied.files, skipped: [...c.skipped.filter((x) => x.post_file_id !== postFileId), ...d.copied.skipped] } : c));
    } catch (e) {
      toast.error(apiRefusal(e, L, t.copyFailed));
    } finally {
      setCopying('');
    }
  };

  const removePartFlow = async (key: Key): Promise<boolean> => {
    const p = s.parts.find((x) => x.key === key);
    if (!p) return false;
    const filled = !!(p.name.trim() || p.notes.trim() || p.assembly.trim() || p.materials.some((m) => (m.materialId && m.materialId !== 'unsure') || m.colours.some((c) => c.mode !== 'any')));
    if (filled) {
      const ok = await confirm({
        title: t.removePartTitle.replace('{name}', p.name.trim() || `#${s.parts.indexOf(p) + 1}`),
        consequence: t.removePartBody,
        confirmLabel: t.removePart,
        destructive: true,
      });
      if (!ok) return false;
    }
    edit((cur) => removePart(cur, key));
    return true;
  };

  const dropProcessNote = (key: Key) =>
    setProcessNotes((cur) => {
      if (!cur.has(key)) return cur;
      const n = new Set(cur);
      n.delete(key);
      return n;
    });

  // ---------------------------------------------------------------- the steps

  const delivery = s.delivery ?? s.carried;
  const working = uploads.working;
  const verb = publishedEdit ? t.saveChanges : s.direct ? fill(t.sendTo, { store: s.direct.store_name }) : t.publishCta;

  const banners = (
    <div className="space-y-3 empty:hidden">
      {s.direct && (
        <div className="lv-alert lv-alert-info flex items-start gap-2 text-[13px]" data-editor="direct-banner">
          <Store aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">
              <bdi>{t.directBanner.replace('{store}', s.direct.store_name)}</bdi>
            </p>
            <p className="mt-0.5 text-[13px]">{t.directHint}</p>
          </div>
        </div>
      )}
      {publishedEdit && (
        <div className="lv-alert lv-alert-info text-[13px]" role="note" data-editor="edit-banner">
          <p>{t.editBanner}</p>
          {s.liveOffers > 0 && <p className="mt-1 font-semibold">{t.liveOffersNote.replace('{n}', String(s.liveOffers))}</p>}
        </div>
      )}
      {persistence.status === 'conflict' && (
        <div className="lv-alert lv-alert-warning text-[13px]" role="alert" data-editor="conflict">
          <p className="font-semibold">{t.conflictTitle}</p>
          <p className="mt-0.5 text-[13px]">{t.conflictBody}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <KitButton size="sm" variant="secondary" onClick={() => void takeLatest()}>
              {t.loadLatest}
            </KitButton>
            <KitButton size="sm" variant="ghost" onClick={() => void keepMine()}>
              {t.keepMine}
            </KitButton>
          </div>
        </div>
      )}
      {persistence.status === 'signedOut' && (
        <div className="lv-alert lv-alert-warning text-[13px]" role="alert" data-editor="signed-out">
          <p>{t.sessionExpired}</p>
          <KitButton size="sm" variant="secondary" className="mt-2" onClick={() => void signBackIn()}>
            {t.signIn}
          </KitButton>
        </div>
      )}
      {persistence.status === 'failed' && saveRefusal && (
        <p className="lv-field-error" role="alert" data-editor="save-refusal">
          {t.saveRefused.replace('{reason}', saveRefusal)}
        </p>
      )}
    </div>
  );

  const stepOne = (
    <div className="space-y-5" onBlur={flushOnLeave}>
      {copies && (
        <div className="space-y-2" data-editor="project-copies">
          {copies.files === 0 && copies.skipped.length === 0 && <p className="lv-alert lv-alert-info text-[13px]">{t.projectNoFiles}</p>}
          {copies.files > 0 && <p className="text-ui-xs text-text-muted">{t.projectCopyNote}</p>}
          {copies.seeded && s.parts.length > 1 && (
            <p className="lv-alert lv-alert-info text-[13px]" data-editor="seeded-parts">
              {t.seededParts}
            </p>
          )}
          {copies.skipped.map((x) => (
            <div key={`${x.post_file_id}:${x.code}`} className="lv-alert lv-alert-warning flex flex-wrap items-center gap-2 text-[13px]" data-editor-copy-skipped={x.code}>
              <p className="min-w-0 flex-1">
                <bdi>{fill(t.copySkipped, { name: x.name, reason: copyReason(x.code, L, t) })}</bdi>
              </p>
              {x.post_file_id && (
                <KitButton size="sm" variant="secondary" loading={copying === x.post_file_id} onClick={() => void copyAgain(x.post_file_id)}>
                  {t.copyAgain}
                </KitButton>
              )}
            </div>
          ))}
        </div>
      )}
      <SourcesArea
        state={s}
        uploads={uploads}
        pictures={pictures}
        touch={touch}
        unfinished={unfinished}
        measuring={measuring}
        measureLater={measureLater}
        t={t}
        onPickFiles={(files) => void pickFiles(files)}
        onAddLink={addLinkFlow}
        onAddTextRef={addTextFlow}
        onOpenPicture={(i) => setViewer(i)}
        onNote={(key, note) => edit((cur) => updateSource(cur, key, { note }))}
        onPrimary={(key) => edit((cur) => setPrimary(cur, key))}
        onOriginal={(key, on) => {
          const [, err] = setOriginal(s, key, on);
          if (err) return t.originalMeasured;
          edit((cur) => setOriginal(cur, key, on)[0]);
          return '';
        }}
        onView3d={(fileId) => void view3d(fileId)}
        onRemove={(key) => void removeSourceFlow(key)}
      />
      <div className="space-y-5" data-editor-section="describe">
        <CountedField
          id="editor-title"
          label={t.reqTitle}
          max={140}
          value={s.title}
          placeholder={t.titlePlaceholder}
          required={!publishedEdit}
          disabled={publishedEdit}
          hint={publishedEdit ? t.titleFixed : undefined}
          error={errors.title}
          onValueChange={(v) => {
            edit((cur) => ({ ...cur, title: v }));
            if (errors.title) setErrors((x) => ({ ...x, title: undefined }));
          }}
        />
        <CountedField
          id="editor-description"
          label={t.reqDesc}
          multiline
          rows={4}
          max={6000}
          value={s.description}
          required={!publishedEdit}
          disabled={publishedEdit}
          hint={publishedEdit ? t.descFixed : t.descHint}
          error={errors.description}
          onValueChange={(v) => {
            edit((cur) => ({ ...cur, description: v }));
            if (errors.description) setErrors((x) => ({ ...x, description: undefined }));
          }}
        />
      </div>
    </div>
  );

  const stepTwo = (
    <div id="editor-step-2" onBlur={flushOnLeave}>
      <PartsEditor
        parts={s.parts}
        sets={s.sets}
        quality={s.quality}
        qualities={catalog?.qualities}
        notes={delivery.notes}
        files={s.files}
        measurable={measurableFiles(s)}
        measuring={measuring}
        measureLater={measureLater}
        catalogue={catalogue}
        refs={refs}
        refName={refName}
        estimates={estimates}
        processNotes={processNotes}
        lang={L}
        t={t}
        onSets={(n) => edit((cur) => ({ ...cur, sets: n }))}
        onQuality={(q) => edit((cur) => ({ ...cur, quality: q }))}
        onNotes={(v) => edit((cur) => ({ ...cur, delivery: { ...(cur.delivery ?? cur.carried), notes: v } }))}
        onPart={(key, patch) => edit((cur) => updatePart(cur, key, patch))}
        onProcess={(key, proc) => {
          const [nextState, cleared] = chooseProcess(s, key, proc, processOf);
          setStateRaw(nextState);
          if (cleared) setProcessNotes((cur) => new Set([...cur, key]));
          else dropProcessNote(key);
        }}
        onMaterial={(key, mk, patch) => edit((cur) => updateMaterial(cur, key, mk, patch))}
        onChooseMaterial={(key, mk, id) => {
          edit((cur) => chooseMaterial(cur, key, mk, id, processOf));
          dropProcessNote(key);
        }}
        onColours={(key, mk, nextColours) => edit((cur) => updateMaterial(cur, key, mk, { colours: nextColours }))}
        onAddMaterial={(key) => edit((cur) => addMaterial(cur, key)[0])}
        onRemoveMaterial={(key, mk) => edit((cur) => removeMaterial(cur, key, mk))}
        onAddPart={() => {
          const [nextState, k] = addPart(s);
          if (k) setStateRaw(nextState);
          return k;
        }}
        onDuplicate={(key) => {
          const [nextState, k] = duplicatePart(s, key);
          if (k) setStateRaw(nextState);
          return k;
        }}
        onMove={(key, by) => edit((cur) => movePart(cur, key, by))}
        onRemove={removePartFlow}
      />
    </div>
  );

  const stepThree = (
    <div className="space-y-3" onBlur={flushOnLeave}>
      <DeliveryFields
        value={delivery}
        direct={!!s.direct}
        published={publishedEdit}
        onChange={(patch) => edit((cur) => ({ ...cur, delivery: { ...(cur.delivery ?? cur.carried), ...patch } }))}
        lang={L}
        t={t}
      />
      <RequestSummary state={s} catalogue={catalogue} refName={refName} lang={L} t={t} />
      <AudiencePanel state={s} t={t} />
    </div>
  );

  const stepFour = (
    <ReviewStep
      state={s}
      catalogue={catalogue}
      qualities={catalog?.qualities}
      refName={refName}
      quote={quote}
      onEdit={({ step: to, focus }: EditTarget) => jumpStep(to, focus)}
      lang={L}
      t={t}
    />
  );

  const cta =
    step === 4
      ? { label: verb, onClick: () => publish(), disabled: working > 0, busy: publishing, note: working > 0 ? fill(t.waitUploads, { n: working }) : '' }
      : { label: step === 3 ? t.reviewCta : t.next, onClick: () => next(), disabled: false, busy: false, note: '' };

  return (
    <div data-editor-state={s.requestState} data-editor-id={s.requestId || 'new'} data-editor-step={step}>
      <WizardHeader
        step={step}
        title={stepTitle(step, t, publishedEdit)}
        status={persistence.status}
        edit={publishedEdit}
        onBack={() => void back()}
        onSave={() => void (s.requestId ? persistence.saveNow() : ensureRequest().then(() => persistence.saveNow()).catch(() => undefined))}
        t={t}
      />
      <div className="space-y-4 pb-6">
        {banners}
        {step === 1 ? stepOne : step === 2 ? stepTwo : step === 3 ? stepThree : stepFour}
        {step === 4 && publishError && (
          <p className={publishError.closed ? 'lv-alert lv-alert-info text-[13px]' : 'lv-field-error'} role="alert" data-editor-review-error={publishError.closed ? 'closed' : 'refused'}>
            {publishError.text}
          </p>
        )}
        {!publishedEdit && (
          <div className="flex justify-end">
            <Menu
              label={t.pageActions}
              items={[{ id: 'delete', label: t.deleteDraft, destructive: true, onSelect: () => void deleteDraft() }]}
              trigger={(props) => <KitIconButton {...props} tone="ghost" label={t.pageActions} icon={<Ellipsis className="h-5 w-5" />} data-editor="page-menu" />}
            />
          </div>
        )}
      </div>
      <ActionDock className={`bottom-0 -mx-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${keyboard ? 'hidden' : ''}`}>
        <div className="w-full" data-editor-bar={keyboard ? 'keyboard' : 'shown'}>
          {cta.note && (
            <p className="mb-2 text-center text-[13px] font-semibold text-text-secondary" role="status">
              {cta.note}
            </p>
          )}
          <GoldButton size="cta" block disabled={cta.disabled} loading={cta.busy} onClick={cta.onClick} data-editor={step === 4 ? (s.direct && !publishedEdit ? 'send' : 'publish') : 'primary'}>
            <span className="truncate">
              <bdi>{cta.label}</bdi>
            </span>
          </GoldButton>
        </div>
      </ActionDock>

      {viewer !== null && pictures.length > 0 && (
        <ImageViewer
          open
          pictures={pictures.map((p) => ({ key: p.key, name: p.name, url: p.url, preview: p.preview, note: s.sources.find((x) => x.key === p.key)?.note ?? '', primary: p.primary, stored: !p.upload }))}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onNote={(key, note) => edit((cur) => updateSource(cur, key, { note }))}
          onPrimary={(key) => edit((cur) => setPrimary(cur, key))}
          onRemove={(key) => {
            const isUpload = pictures.some((p) => p.key === key && p.upload);
            setViewer(null);
            if (isUpload) uploads.cancel(key);
            else void removeSourceFlow(key);
          }}
          dir={dir}
          t={t}
        />
      )}
      {confirmDialog}
    </div>
  );
}

/** For tests: the save refusal of a 401 is a session that ran out, never a failure to retry. */
export const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401;
