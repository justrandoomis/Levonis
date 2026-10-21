/**
 * THE REQUEST EDITOR (plan P1-06, docs/DECISIONS.md row 268) — one page for a
 * new request, a draft and the edit of a published one, in place of the
 * four-step wizard:
 *
 *   «صف طلبك»    the title and the description (they name the draft);
 *   «ما لديك»    files, pictures, links and written references, together;
 *   «ماذا نطبع»  the job and its parts, materials and colours;
 *   and the bar under the thumb: where the save stands, and «مراجعة».
 *
 * THE DRAFT IS BORN ON THE FIRST CHANGE (the entry door, a draft born empty)
 * and the address becomes /requests/new/<id> in place, so a reload, a lost
 * connection or a tap on Back resumes it: what the server does not have yet
 * is in this tab’s copy (sessionMirror.ts) until it does (persistence.ts).
 * A published request opens at /requests/<id>/edit, where nothing is saved
 * until «احفظ التعديلات» — except files, which the upload doors attach at
 * once, as the banner says.
 *
 * No 3D code is loaded here (BASE 6): «عرض ثلاثي الأبعاد» opens the existing
 * viewer in a new tab, which also keeps this page and its unsaved work open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MoreVertical, Store } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { useAuth } from '../../../../AuthContext';
import { ApiError } from '../../../../lib/api';
import { apiRefusal } from '../../../../lib/refusalStrings';
import { useSuppressBottomNav } from '../../../../lib/bottomNavSuppress';
import { useMediaQuery } from '../../../../lib/useMediaQuery';
import { useSignInPrompt } from '../../../../lib/guest';
import { Button, IconButton } from '../../../ui/Button';
import { Field, Input, Textarea, focusFirstInvalid } from '../../../ui/Field';
import { Menu } from '../../../ui/Menu';
import { useConfirm } from '../../../ui/ConfirmDialog';
import { useToast } from '../../../ui/Toast';
import { warmLink } from '../../links/useLinkCard';
import { forgetCommunityFeed } from '../../hub/feedCache';
import { requestPath } from '../requestStates';
import { editorApi, requestsApi, type Catalog, type DraftFile, type Quote } from '../api';
import {
  addLink,
  addMaterial,
  addPart,
  addTextRef,
  blankState,
  bodyKey,
  chooseMaterial,
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
import { COMPACT_QUERY, useKeyboardOpen } from './useKeyboardOpen';
import { ActionBar } from './ActionBar';
import { SourcesArea, sourceName } from './SourcesArea';
import { gridPictures, type GridPicture } from './ImageGrid';
import { ImageViewer } from './ImageViewer';
import { PartsEditor } from './PartsEditor';
import { ReviewSheet } from './ReviewSheet';
import { partEstimates } from './estimate';
import { editorLang, editorStrings, fill } from './strings';

type Load = { phase: 'loading' } | { phase: 'failed'; error: unknown } | { phase: 'ready' } | { phase: 'locked'; requestId: string };

/** The address an editable request lives at: a draft at /requests/new/:id, a published one at /requests/:id/edit. */
export function editorPath(requestId: string, requestState: string): string {
  if (!requestId) return '/requests/new';
  const id = encodeURIComponent(requestId);
  return requestState === 'draft' ? `/requests/new/${id}` : `/requests/${id}/edit`;
}

export default function RequestEditor({ requestId: routeId }: { requestId: string }) {
  const { lang, dir } = useLanguage();
  const L = editorLang(lang);
  const t = editorStrings(lang);
  const { user, refreshUser } = useAuth();
  const userId = user?.id ?? '';
  const { signIn } = useSignInPrompt();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  useSuppressBottomNav();
  const keyboard = useKeyboardOpen();
  const compact = useMediaQuery(COMPACT_QUERY);
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
  const [publishError, setPublishError] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<EditorState | null>(null);
  stateRef.current = state;
  const setState = useCallback((updater: (s: EditorState | null) => EditorState | null) => setStateRaw(updater), []);
  const edit = (fn: (s: EditorState) => EditorState) => setStateRaw((s) => (s ? fn(s) : s));

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
  useEffect(() => {
    if (!userId) return;
    dropOtherAccounts(storage, userId);
    if (routeId && routeId === createdHere.current) return;
    let alive = true;
    setLoad({ phase: 'loading' });
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
        if (location.pathname !== want) navigate(`${want}${location.search}`, { replace: true });
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
        setStateRaw((cur) =>
          cur ? { ...cur, requestId: request_id, requestState: 'draft', updatedAt: born.updatedAt, revision: born.revision } : born
        );
        const cur = stateRef.current;
        if (cur) moveNewMirror(storage, userId, { ...cur, requestId: request_id, updatedAt: born.updatedAt });
        navigate(`/requests/new/${encodeURIComponent(request_id)}${location.search}`, { replace: true });
        return request_id;
      } finally {
        creating.current = null;
      }
    })();
    return creating.current;
  }, [navigate, location.search, storage, userId]);

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

  // ---------------------------------------------------------------- uploads

  const measure = useCallback(async (requestId: string, f: DraftFile) => {
    if (f.kind !== 'model' || f.analysis?.measured) return;
    setMeasuring((s) => new Set([...s, f.id]));
    try {
      const r = await requestsApi.analyze(requestId, f.id);
      if (r.measure === 'later') setMeasureLater((s) => new Set([...s, f.id]));
      if (r.analysis) edit((s) => ({ ...s, files: s.files.map((x) => (x.id === f.id ? { ...x, analysis: r.analysis } : x)) }));
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

  // The browser asks before closing a tab that would lose work: a published
  // request’s unpublished edits, or a draft the server could not take.
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

  // ---------------------------------------------------------------- render guards

  if (load.phase === 'loading' || (!state && load.phase === 'ready')) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 px-4 py-6" aria-busy="true" data-editor="loading">
        <p className="sr-only">{t.preparing}</p>
        <div className="h-24 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
        <div className="h-40 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
      </div>
    );
  }
  if (load.phase === 'failed') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 text-center" data-editor="load-failed">
        <p className="text-[15px] font-semibold text-text-primary">{t.loadFailed}</p>
        <p className="mt-1 text-[13px] text-text-secondary">{apiRefusal(load.error, L, '')}</p>
        <Button className="mt-4" variant="secondary" onClick={() => navigate(0)}>
          {t.retryLoad}
        </Button>
      </div>
    );
  }
  if (load.phase === 'locked' || !state) {
    const id = load.phase === 'locked' ? load.requestId : '';
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 text-center" data-editor="not-editable">
        <p className="text-[15px] font-semibold text-text-primary">{t.notEditable}</p>
        {id && (
          <Button className="mt-4" variant="primary" onClick={() => navigate(requestPath(id), { replace: true })}>
            {t.openRequest}
          </Button>
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
  const titleText = publishedEdit ? t.titleEdit : s.requestId ? t.titleDraft : t.titleNew;

  // ---------------------------------------------------------------- actions

  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/requests?view=mine');
  };

  const flushOnLeave = (e: React.FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    void persistence.flush();
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

  const openReview = async () => {
    setPublishError('');
    if (!publishedEdit) {
      const next: typeof errors = {};
      const title = s.title.trim();
      if (title.length < 4 || title.length > 140) next.title = t.titleError;
      if (s.description.trim().length < 10) next.description = t.descError;
      setErrors(next);
      if (next.title || next.description) {
        requestAnimationFrame(() => focusFirstInvalid(rootRef.current));
        return;
      }
      await persistence.flush();
    }
    const p = new URLSearchParams(params);
    p.set('review', '1');
    setParams(p);
  };
  const reviewOpen = params.get('review') === '1';
  const closeReview = () => {
    const p = new URLSearchParams(params);
    p.delete('review');
    setParams(p, { replace: true });
  };

  const publish = async () => {
    setPublishError('');
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
        setPublishError(persistence.status === 'conflict' ? t.conflictTitle : t.saveFailed);
        return;
      }
      const cur = stateRef.current ?? s;
      await editorApi.publish(id, editorBody(cur));
      forgetCommunityFeed('requests');
      clearMirror(storage, userId, id);
      persistence.reset(cur);
      if (publishedEdit) toast.success(t.changesSaved);
      // Back from the request lands on «طلباتي», never in the editor again (critique 5).
      navigate('/requests?view=mine', { replace: true });
      navigate(requestPath(id), { state: { published: !publishedEdit } });
    } catch (e) {
      setPublishError(apiRefusal(e, L, publishedEdit ? t.saveFailed : t.publishFailed));
    } finally {
      setPublishing(false);
    }
  };

  const deleteDraft = async () => {
    if (!s.requestId) {
      clearMirror(storage, userId, '');
      navigate('/requests?view=mine', { replace: true });
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
      navigate('/requests?view=mine', { replace: true });
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

  const processOf = (id: string): 'fdm' | 'resin' | '' => catalogue.find((m) => m.id === id)?.process ?? '';
  const saveRefusal = persistence.error ? apiRefusal(persistence.error, L, t.saveFailed) : '';
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div ref={rootRef} className="mx-auto max-w-2xl px-4 pb-32 pt-3" data-editor-state={s.requestState} data-editor-id={s.requestId || 'new'}>
      <header className="mb-4 flex items-center gap-1">
        <IconButton label={t.back} icon={<BackIcon className="h-5 w-5" />} onClick={goBack} data-editor="back" />
        <h1 className="min-w-0 flex-1 truncate text-[18px] font-bold text-text-primary">{titleText}</h1>
        {!publishedEdit && (
          <Menu
            label={t.pageActions}
            items={[{ id: 'delete', label: t.deleteDraft, destructive: true, onSelect: () => void deleteDraft() }]}
            trigger={(props) => <IconButton {...props} label={t.pageActions} icon={<MoreVertical className="h-5 w-5" />} data-editor="page-menu" />}
          />
        )}
      </header>

      <div className="space-y-3">
        {s.direct && (
          <div className="lv-alert lv-alert-info flex items-start gap-2 text-[13px]" data-editor="direct-banner">
            <Store aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">
                <bdi>{t.directBanner.replace('{store}', s.direct.store_name)}</bdi>
              </p>
              <p className="mt-0.5 text-[12.5px]">{t.directHint}</p>
            </div>
          </div>
        )}
        {publishedEdit && (
          <div className="lv-alert lv-alert-info text-[12.5px]" role="note" data-editor="edit-banner">
            <p>{t.editBanner}</p>
            {s.liveOffers > 0 && <p className="mt-1 font-semibold">{t.liveOffersNote.replace('{n}', String(s.liveOffers))}</p>}
          </div>
        )}
        {persistence.status === 'conflict' && (
          <div className="lv-alert lv-alert-warning text-[13px]" role="alert" data-editor="conflict">
            <p className="font-semibold">{t.conflictTitle}</p>
            <p className="mt-0.5 text-[12.5px]">{t.conflictBody}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => void takeLatest()}>
                {t.loadLatest}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void keepMine()}>
                {t.keepMine}
              </Button>
            </div>
          </div>
        )}
        {persistence.status === 'signedOut' && (
          <div className="lv-alert lv-alert-warning text-[13px]" role="alert" data-editor="signed-out">
            <p>{t.sessionExpired}</p>
            <Button size="sm" variant="primary" className="mt-2" onClick={() => void signBackIn()}>
              {t.signIn}
            </Button>
          </div>
        )}
        {persistence.status === 'failed' && saveRefusal && (
          <p className="lv-field-error" role="alert" data-editor="save-refusal">
            {t.saveRefused.replace('{reason}', saveRefusal)}
          </p>
        )}
      </div>

      <section className="mt-5" aria-labelledby="editor-describe" onBlur={flushOnLeave}>
        <h2 id="editor-describe" className="mb-3 text-[15px] font-bold text-text-primary">
          {t.secDescribe}
        </h2>
        <div className="space-y-4">
          <Field label={t.titleLabel} error={errors.title} required={!publishedEdit} hint={publishedEdit ? t.titleFixed : undefined}>
            <Input
              dir="auto"
              value={s.title}
              maxLength={140}
              readOnly={publishedEdit}
              placeholder={t.titlePlaceholder}
              onChange={(e) => {
                const v = e.target.value;
                edit((cur) => ({ ...cur, title: v }));
                if (errors.title) setErrors((x) => ({ ...x, title: undefined }));
              }}
              data-editor="title"
            />
          </Field>
          <Field label={t.descLabel} error={errors.description} required={!publishedEdit} hint={publishedEdit ? t.descFixed : t.descHint}>
            <Textarea
              dir="auto"
              rows={4}
              maxLength={6000}
              value={s.description}
              readOnly={publishedEdit}
              onChange={(e) => {
                const v = e.target.value;
                edit((cur) => ({ ...cur, description: v }));
                if (errors.description) setErrors((x) => ({ ...x, description: undefined }));
              }}
              data-editor="description"
            />
          </Field>
        </div>
      </section>

      <section className="mt-8" aria-labelledby="editor-sources" onBlur={flushOnLeave} data-editor-section="sources">
        <h2 id="editor-sources" className="mb-2 text-[15px] font-bold text-text-primary">
          {t.secSources}
        </h2>
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
      </section>

      <section className="mt-8" aria-labelledby="editor-parts" onBlur={flushOnLeave} data-editor-section="parts">
        <h2 id="editor-parts" className="mb-3 text-[15px] font-bold text-text-primary">
          {t.secParts}
        </h2>
        <PartsEditor
          parts={s.parts}
          sets={s.sets}
          quality={s.quality}
          files={s.files}
          measurable={measurableFiles(s)}
          measuring={measuring}
          measureLater={measureLater}
          catalogue={catalogue}
          refs={refs}
          refName={refName}
          estimates={estimates}
          lang={L}
          t={t}
          onSets={(n) => edit((cur) => ({ ...cur, sets: n }))}
          onQuality={(q) => edit((cur) => ({ ...cur, quality: q }))}
          onPart={(key, patch) => edit((cur) => updatePart(cur, key, patch))}
          onMaterial={(key, mk, patch) => edit((cur) => updateMaterial(cur, key, mk, patch))}
          onChooseMaterial={(key, mk, id) => edit((cur) => chooseMaterial(cur, key, mk, id, processOf))}
          onColours={(key, mk, next) => edit((cur) => updateMaterial(cur, key, mk, { colours: next }))}
          onAddMaterial={(key) => edit((cur) => addMaterial(cur, key)[0])}
          onRemoveMaterial={(key, mk) => edit((cur) => removeMaterial(cur, key, mk))}
          onAddPart={() => {
            const [next, k] = addPart(s);
            if (k) setStateRaw(next);
            return k;
          }}
          onDuplicate={(key) => {
            const [next, k] = duplicatePart(s, key);
            if (k) setStateRaw(next);
            return k;
          }}
          onMove={(key, by) => edit((cur) => movePart(cur, key, by))}
          onRemove={removePartFlow}
        />
      </section>

      <ActionBar
        status={persistence.status}
        edit={publishedEdit}
        hidden={keyboard}
        wide={!compact}
        primaryLabel={t.review}
        onPrimary={() => void openReview()}
        onRetry={() => void persistence.saveNow()}
        onSave={() => void persistence.saveNow()}
        t={t}
      />

      <ReviewSheet
        open={reviewOpen}
        onClose={closeReview}
        state={s}
        catalogue={catalogue}
        refName={refName}
        working={uploads.working}
        busy={publishing}
        error={publishError}
        onPublish={() => void publish()}
        lang={L}
        t={t}
      />

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
