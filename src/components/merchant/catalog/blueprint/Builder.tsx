/**
 * THE BLUEPRINT BUILDER — «التخصيص · Customization · خۆگونجاندن» (Programme C,
 * phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 1, §B.2 items 1–5 and the
 * look card, §B.3 «Slots» and «Compatibility», §0 rows 5 and 39; survey S8
 * and the merchant track's S2–S6). A lazy chunk (`BlueprintBuilder`) opened
 * from the one door in the product editor (./BlueprintDoor.tsx); C1 ships it
 * dark (./gate.ts).
 *
 * A Sheet v2 over the editor, one step per screen on a phone and two panes
 * from `lg` — the model (or the photo) on one side, the step on the other:
 *
 *   المصدر      the model (1–12 files through the shared UploadTile, purpose
 *               product_file → PUT …/model) or «بالصور فقط» (the product's
 *               own photos mapped to colours and options)
 *   الأجزاء      each part of the file → a role (a tap on the model or its
 *               row), the colours a customer chooses from, the first colour
 *   الكتابة      ≤ 4 areas: tap a face → a frame (o/n/u, w × h mm); on a photo,
 *               four corners
 *   المقاسات     the product's OWN option groups as the size / look / quality
 *               axes; «أضف مقاسات» through the product's own PATCH
 *   الإضافات     slots of this store's parts: qty, required, who chooses, how
 *               it is priced, how it shows on the model
 *   القواعد      the automatic ones as facts, and rules from the closed list
 *   المعاينة     the studio itself on the draft (lane L8's `Studio`,
 *               preview), the look card captured from the model, publish
 *
 * THE DRAFT IS SAVED BY ITSELF — after a pause, only when it changed, and
 * only when the engine's own `normalizeBlueprint` (packages/catalog, in this
 * chunk) passes it; what it refuses is listed on the step that edits it
 * (./model.ts `stepOf`), as is what the server refuses. A live revision is
 * never edited: the first save opens the next draft from it, and the builder
 * says so. Closing waits for the last save.
 */
import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Motion from 'motion/react-m';
import { X } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { useMotion } from '../../../../lib/motion';
import { MotionFeatures } from '../../../../lib/motionFeatures';
import { ApiError } from '../../../../lib/api';
import type { LoadedMesh } from '../../../../lib/viewer/mesh';
import { Sheet } from '../../../ui/Sheet';
import { Button, IconButton } from '../../../ui/Button';
import { StatusChip } from '../../../ui/Badge';
import { Skeleton } from '../../../ui/Skeleton';
import { useToast } from '../../../ui/Toast';
import type { BlueprintSpec, EngineIssue, Vec3 } from '../../../../../packages/catalog/src/personalize/types';
import { isPhotoOnly, normalizeBlueprint } from '../../../../../packages/catalog/src/personalize/spec';
import { canonicalJson } from '../../../../../packages/catalog/src/personalize/canonical';
import { catalogApi, type CatalogProductDetail } from '../catalogApi';
import { blueprintApi, type BuilderState } from './api';
import { langOf, useWords, type BuilderStrings } from './strings';
import { blankSpec, fill, frameAt, newArea, regionOfPart, regionsFrom, stepOf, stepsFor, type StepId } from './model';
import { PhotoStage, Stage, type StageHandle, type StageHit } from './Stage';
import type { Kit, PickMode, Selection } from './kit';
import { Source } from './steps/Source';
import { Parts } from './steps/Parts';
import { Areas } from './steps/Areas';
import { Sizes } from './steps/Sizes';
import type { Prep } from './steps/Publish';

// The later steps are chunks of their own, fetched while the merchant is on the first ones.
const Addons = lazy(() => import('./steps/Addons'));
const Rules = lazy(() => import('./steps/Rules'));
const Publish = lazy(() => import('./steps/Publish'));
const LATER = [() => import('./steps/Addons'), () => import('./steps/Rules'), () => import('./steps/Publish')];

export interface BuilderProps {
  product: CatalogProductDetail;
  initial: BuilderState;
  dirty: boolean;
  onState: (st: BuilderState) => void;
  onClose: () => void;
  onReload: () => void;
}

type Status = 'idle' | 'saving' | 'saved' | 'invalid' | 'error';

/** Where the builder starts: the draft (or the live revision) as it is, else the model's suggested parts. */
export function startOf(st: BuilderState): { spec: BlueprintSpec; rev: number | null; saved: string; kind: 'model' | 'photos' | null } {
  const cur = st.draft ?? st.live;
  if (cur?.spec) return { spec: cur.spec, rev: cur.rev, saved: canonicalJson(cur.spec), kind: isPhotoOnly(cur.spec) ? 'photos' : 'model' };
  const spec = blankSpec();
  const model = st.mesh_state === 'ready' && st.parts.length > 0;
  if (model) spec.regions = regionsFrom(st.parts, st.suggestions.roles);
  return { spec, rev: cur?.rev ?? st.retired[0]?.rev ?? null, saved: '', kind: model ? 'model' : null };
}

/** The merchant's words for where a problem is. */
export function whereOf(path: string, t: BuilderStrings): string {
  const [head, i] = path.split('.');
  const n = (Number(i) || 0) + 1;
  if (head === 'regions') return t.whereParts;
  if (head === 'areas' || head === 'quads') return fill(t.whereArea, { n });
  if (head === 'axes' || head === 'prep_days_add') return t.whereSizes;
  if (head === 'slots' || head === 'fixed') return fill(t.whereAddon, { n });
  if (head === 'rules') return fill(t.whereRule, { n });
  if (head === 'photos') return t.wherePhotos;
  if (head === 'colors') return t.whereColours;
  return head === 'sell' ? t.whereSell : t.whereOther;
}

const STEP_WORD = { source: 'stepSource', parts: 'stepParts', areas: 'stepAreas', sizes: 'stepSizes', addons: 'stepAddons', rules: 'stepRules', publish: 'stepPublish' } as const;

export default function Builder({ product, initial, dirty, onState, onClose, onReload }: BuilderProps) {
  const { lang: l } = useLanguage();
  const lang = langOf(l);
  // The door fetched this language's table before the builder was asked for.
  const t = useWords(lang)!;
  const m = useMotion();
  const toast = useToast();
  const titleId = useId();
  const pid = product.id;
  const start = useMemo(() => startOf(initial), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [st, setSt] = useState(initial);
  const [detail, setDetail] = useState(product);
  const [spec, setSpec] = useState(start.spec);
  const [kind, setKind] = useState(start.kind);
  const [step, setStep] = useState<StepId>(start.kind === 'model' ? 'parts' : start.kind === 'photos' ? 'areas' : 'source');
  const [status, setStatus] = useState<Status>('idle');
  const [issues, setIssues] = useState<EngineIssue[]>([]);
  const [sel, setSel] = useState<Selection>({});
  const [pick, setPick] = useState<PickMode | null>(null);
  const [names, setNamesRaw] = useState<Record<string, string>>({});
  const [mesh, setMesh] = useState<LoadedMesh | null>(null);
  const [meshFailed, setMeshFailed] = useState(false);
  const [prep, setPrep] = useState<Prep>('idle');
  const [missing, setMissing] = useState<string[]>([]);

  const rev = useRef(start.rev);
  const saved = useRef(start.saved);
  const touched = useRef(false);
  const specRef = useRef(spec);
  specRef.current = spec;
  const stRef = useRef(st);
  stRef.current = st;
  const stage = useRef<StageHandle>(null);

  const photoOnly = kind === 'photos';
  const cur = st.draft ?? st.live;
  const dims = (!photoOnly && (cur?.mesh?.dims_mm ?? cur?.analysis.dims_mm)) || null;

  /** Every answer is the whole state; a draft it opened is the revision edited from now on. */
  const adopt = useCallback(
    (next: BuilderState) => {
      if (next.draft) rev.current = next.draft.rev;
      setSt(next);
      onState(next);
    },
    [onState]
  );

  const refuse = useCallback(
    (e: unknown) => {
      void import('../../../../lib/refusalStrings').then(({ apiRefusal }) => toast.error(apiRefusal(e, lang, t.saveFailed)));
    },
    [lang, t.saveFailed, toast]
  );

  useEffect(() => {
    const id = window.setTimeout(() => LATER.forEach((f) => void f().catch(() => undefined)), 1200);
    return () => window.clearTimeout(id);
  }, []);

  // ------------------------------------------------------------ the draft
  const opts = {
    partCount: photoOnly ? undefined : st.parts.length || undefined,
    variantGroups: Object.fromEntries(detail.option_groups.map((g) => [g.id, g.values.map((v) => v.id)])),
    mediaIds: detail.media.flatMap((x) => (x.kind === 'image' && x.id ? [x.id] : [])),
    bboxMm: dims ? (dims as Vec3) : undefined,
  };
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const chain = useRef<Promise<void>>(Promise.resolve());

  /** Saves `next` after whatever is saving now; answers whether the server now holds it. */
  const save = useCallback(
    (next: BlueprintSpec): Promise<boolean> => {
      const run = chain.current.then(async (): Promise<boolean> => {
        const r = normalizeBlueprint(next, optsRef.current);
        if (r.ok === false) {
          setIssues(r.errors?.length ? r.errors : [{ path: (r as { path?: string }).path ?? '', code: 'INVALID' }]);
          setStatus('invalid');
          return false;
        }
        const body = canonicalJson(r.value);
        if (body === saved.current) {
          setIssues([]);
          setStatus((s) => (s === 'idle' ? s : 'saved'));
          return true;
        }
        setStatus('saving');
        try {
          const out = await blueprintApi.draft(pid, r.value, rev.current);
          saved.current = body;
          rev.current = out.draft?.rev ?? rev.current;
          adopt(out);
          setIssues([]);
          setStatus('saved');
          return true;
        } catch (e) {
          setStatus('error');
          const list = e instanceof ApiError ? (e.details?.errors as EngineIssue[] | undefined) : undefined;
          if (Array.isArray(list) && list.length) setIssues(list);
          else refuse(e);
          return false;
        }
      });
      chain.current = run.then(() => undefined);
      return run;
    },
    [pid, adopt, refuse]
  );

  const edit = useCallback((fn: (s: BlueprintSpec) => BlueprintSpec) => {
    touched.current = true;
    setSpec((s) => fn(s));
  }, []);

  useEffect(() => {
    if (!touched.current) return;
    const id = window.setTimeout(() => void save(spec), 800);
    return () => window.clearTimeout(id);
  }, [spec, save]);

  const flush = useCallback((): Promise<boolean> => (touched.current ? save(specRef.current) : chain.current.then(() => true)), [save]);

  // ------------------------------------------------------------ the model
  const meshUrl = cur?.mesh?.url ?? (st.mesh_state === 'ready' && st.retired[0] ? `/api/merchant/products/${encodeURIComponent(pid)}/blueprint/mesh?rev=${st.retired[0].rev}` : null);
  const meshKey = cur?.mesh?.hash ?? meshUrl;
  useEffect(() => {
    setMesh(null);
    setMeshFailed(false);
    if (!meshUrl || photoOnly) return;
    let alive = true;
    import('../../../../lib/viewer/mesh')
      .then((x) => x.loadMesh(meshUrl))
      .then((got) => {
        if (!alive) return;
        if (got && !('unsupported' in got)) setMesh(got);
        else setMeshFailed(true);
      })
      .catch(() => alive && setMeshFailed(true));
    return () => {
      alive = false;
    };
    // The same bytes under a new revision number are the same model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshKey, photoOnly]);

  // The editor behind re-reads the product only once the builder closes: its reload swaps the whole form
  // (this builder included) for a skeleton. «أضف مقاسات» is refused while the editor has unsaved changes.
  const productChanged = useRef(false);
  const reloadProduct = useCallback(async () => {
    try {
      const d = (await catalogApi.get(pid)).product;
      setDetail(d);
      productChanged.current = true;
      return d;
    } catch (e) {
      refuse(e);
      return null;
    }
  }, [pid, refuse]);

  // --------------------------------------------------------------- taps
  function onPick(hit: StageHit) {
    const s = specRef.current;
    const box = st.parts.find((x) => x.n === hit.part)?.bbox_mm;
    const region = regionOfPart(s, hit.part) ?? s.regions[0];
    if (pick && 'place' in pick) {
      if (!region) return;
      const a = newArea(s, pick.place, pick.role, region.id, { frame: frameAt(hit.point, hit.normal, pick.place, pick.role, box) });
      edit((x) => ({ ...x, areas: [...x.areas, a] }));
      setSel({ area: a.id });
    } else if (pick && 'move' in pick) {
      edit((x) => ({
        ...x,
        areas: x.areas.map((a) => (a.id === pick.move && a.frame ? { ...a, region: region?.id ?? a.region, frame: { ...frameAt(hit.point, hit.normal, a.kind, a.role, box), w: a.frame.w, h: a.frame.h } } : a)),
      }));
    } else if (pick && 'anchor' in pick) {
      const f = frameAt(hit.point, hit.normal, 'icon', 'icon', box);
      edit((x) => ({ ...x, slots: x.slots.map((y) => (y.id === pick.anchor ? { ...y, show: { effect: y.show?.effect ?? 'ring', anchor: { ...f, w: 12, h: 12 } } } : y)) }));
    } else {
      setSel({ part: hit.part });
      return;
    }
    setPick(null);
  }

  // ------------------------------------------------------------- steps
  const steps = stepsFor(photoOnly);
  const index = Math.max(0, steps.indexOf(step));
  const top = useRef<HTMLDivElement>(null);
  const go = useCallback((next: StepId) => {
    setPick(null);
    // Leaving the preview: the next visit prepares it again (and keeps the model on screen until then).
    if (next !== 'publish') setPrep('idle');
    setStep(next);
    top.current?.scrollIntoView({ block: 'start' });
  }, []);
  const bad = useMemo(() => new Set(issues.map((i) => stepOf(i.path, photoOnly))), [issues, photoOnly]);
  const mine = issues.filter((i) => stepOf(i.path, photoOnly) === step);

  // The preview: everything saved, then the look card captured from the model when the draft needs one.
  useEffect(() => {
    if (step !== 'publish') return;
    let alive = true;
    setMissing([]);
    setPrep('working');
    void (async () => {
      const ok = await flush();
      if (!alive) return;
      if (!ok) return setPrep('invalid');
      let s = stRef.current;
      if (!photoOnly && s.draft && s.warnings.includes('NEEDS_LOOK')) {
        const body = await stage.current?.capture(specRef.current);
        if (!alive) return;
        if (!body) return setPrep('failed');
        try {
          s = await blueprintApi.look(pid, body);
          adopt(s);
        } catch (e) {
          refuse(e);
          return alive && setPrep('failed');
        }
      }
      if (alive) setPrep('ready');
    })();
    return () => {
      alive = false;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function publish(r: number) {
    // The last edit first: a publish names the revision as it is stored.
    if (!(await flush())) return;
    try {
      adopt(await blueprintApi.publish(pid, r));
      toast.success(t.published);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BLUEPRINT_NOT_READY') setMissing(((e.details?.missing as string[]) ?? []).filter((x) => typeof x === 'string'));
      else if (e instanceof ApiError && Array.isArray(e.details?.errors)) setIssues(e.details!.errors as EngineIssue[]);
      else refuse(e);
    }
  }
  async function pause() {
    try {
      adopt(await blueprintApi.pause(pid));
      toast.success(t.pausedNow);
    } catch (e) {
      refuse(e);
    }
  }

  async function close() {
    await flush();
    onClose();
    if (productChanged.current) onReload();
  }

  const kit: Kit = {
    t, lang, spec, edit, st, adopt, product: detail, reloadProduct, kind, setKind: (k) => setKind(k), issues: mine, sel, setSel, pick, setPick,
    dirty, names, setNames: (add) => setNamesRaw((n) => ({ ...n, ...add })), refuse, go, dims: dims as [number, number, number] | null,
  };

  // In the preview the model stays until the look card is taken from it; the studio takes its place after.
  const modelStage = kind === 'model' && !!meshUrl && !(step === 'publish' && prep === 'ready');
  const onPhone = step === 'parts' || step === 'areas' || step === 'addons' || step === 'source' || step === 'publish';
  // A photo-only blueprint shows its photo beside every step from `lg` (on a phone only on «الكتابة»);
  // the corners move only there.
  const photoEdit = photoOnly && step === 'areas';
  const photoArea = photoEdit ? spec.areas.find((a) => a.id === sel.area) ?? spec.areas[0] : undefined;
  const photoId = photoArea?.photo_frame?.media_id ?? spec.photos[0]?.media_id;
  const photoUrl = photoOnly && step !== 'publish' ? detail.media.find((x) => x.id === photoId)?.url : undefined;
  // Nothing to show beside the step (no source yet, or a model that was refused): one column, centred.
  const side = modelStage || !!photoUrl;
  const live = st.live;
  const saveWord = status === 'saving' ? t.saving : status === 'saved' ? t.saved : status === 'invalid' || status === 'error' ? (issues.length ? fill(t.unsaved, { n: issues.length }) : t.saveFailed) : '';

  return (
    <Sheet
      open
      onClose={() => void close()}
      labelledBy={titleId}
      detents={['large']}
      dirty={status === 'invalid' || status === 'error'}
      panelClassName="w-full sm:h-[88vh] sm:max-w-5xl"
      header={
        <div className="px-4 pb-2 pt-1" data-blueprint-builder={step}>
          <div className="flex items-center gap-2">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-[16px] font-bold text-text-primary">{fill(t.title, { name: detail.name_ar && lang !== 'en' ? detail.name_ar : detail.name })}</h2>
            <span className="shrink-0 text-[12px] text-text-muted" role="status" data-save={status}>{saveWord}</span>
            <IconButton label={t.close} icon={<X className="h-4 w-4" />} onClick={() => void close()} variant="ghost" />
          </div>
          <nav className="-mx-4 mt-1 flex gap-1.5 overflow-x-auto px-4 pb-1 hide-scrollbar" aria-label={t.steps}>
            {steps.map((id, i) => (
              <button
                key={id}
                type="button"
                className="lv-choice shrink-0 px-3 text-[13px]"
                aria-pressed={id === step}
                aria-current={id === step ? 'step' : undefined}
                onClick={() => go(id)}
                data-step={id}
              >
                <span className="tabular-nums text-text-muted">{i + 1}</span> {t[STEP_WORD[id]]}
                {bad.has(id) && <span className="ms-1.5 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle" aria-hidden="true" />}
              </button>
            ))}
          </nav>
        </div>
      }
      footer={
        <div className="flex items-center gap-2 px-4 py-3">
          {index > 0 && (
            <Button variant="ghost" onClick={() => go(steps[index - 1])}>{t.back}</Button>
          )}
          <span className="flex-1" />
          {step !== 'publish' ? (
            <Button variant="primary" onClick={() => go(steps[index + 1])} data-blueprint-next>{t.next}</Button>
          ) : st.draft ? (
            <Button variant="primary" onClick={() => publish(st.draft!.rev)} disabled={prep !== 'ready'} data-blueprint-publish>{t.publish}</Button>
          ) : live ? (
            <>
              <StatusChip tone="success">{fill(t.liveRev, { rev: live.rev })}</StatusChip>
              <Button variant="ghost" onClick={pause} data-blueprint-pause>{t.pause}</Button>
            </>
          ) : st.retired[0] ? (
            <Button variant="primary" onClick={() => publish(st.retired[0].rev)} data-blueprint-publish>{t.republish}</Button>
          ) : null}
        </div>
      }
    >
      <div ref={top} className="h-0" aria-hidden="true" />
      <div className={step === 'publish' ? 'space-y-4 px-4 pb-6 pt-1' : side ? 'space-y-4 px-4 pb-6 pt-1 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0' : 'mx-auto max-w-2xl space-y-4 px-4 pb-6 pt-1'}>
        {(modelStage || photoUrl) && (
          <div className={`${onPhone && (!photoOnly || photoEdit) ? '' : 'hidden lg:block'} ${step === 'publish' ? 'mx-auto max-w-sm' : 'lg:sticky lg:top-6'}`}>
            {photoUrl ? (
              <PhotoStage
                url={photoUrl}
                label={t.stage}
                active={photoEdit ? photoArea?.id ?? null : null}
                quads={spec.areas.flatMap((a) => (a.photo_frame && a.photo_frame.media_id === photoId ? [{ id: a.id, quad: a.photo_frame.quad }] : []))}
                onQuad={(id, quad) => edit((x) => ({ ...x, areas: x.areas.map((a) => (a.id === id && a.photo_frame ? { ...a, photo_frame: { ...a.photo_frame, quad } } : a)) }))}
              />
            ) : meshFailed ? (
              <p className="rounded-2xl border border-border-subtle bg-surface-raised p-4 text-[13px] leading-relaxed text-text-muted" data-stage="failed">{t.noModelView}</p>
            ) : (
              <Stage
                ref={stage}
                mesh={mesh}
                spec={spec}
                mode={step === 'parts' || step === 'source' ? 'parts' : 'look'}
                chosen={step === 'parts' ? sel.part ?? null : null}
                areas={spec.areas}
                activeArea={step === 'areas' ? sel.area ?? null : null}
                slots={spec.slots}
                reduced={m.reduced}
                label={t.stage}
                loading={t.loadingModel}
                failedText={t.noModelView}
                onPick={onPick}
              />
            )}
          </div>
        )}
        <MotionFeatures>
          <Motion.div key={step} className="min-w-0 space-y-4" initial={{ opacity: 0, x: m.travel(m.inline(12)) }} animate={{ opacity: 1, x: 0 }} transition={m.spring('ui')}>
            {live && !st.draft && step !== 'publish' && <p className="rounded-xl border border-border-subtle px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary" data-next-draft>{fill(t.nextDraft, { rev: live.rev })}</p>}
            {!live && !st.draft && st.retired[0] && !start.saved && <p className="rounded-xl border border-border-subtle px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">{t.freshStart}</p>}
            {mine.length > 0 && (
              <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-[12.5px] leading-relaxed text-text-primary" data-issues={mine.length}>
                <p className="font-semibold">{t.toFix}</p>
                <ul className="mt-1 space-y-0.5">
                  {mine.slice(0, 6).map((i) => (
                    <li key={`${i.path}:${i.code}`}>
                      {whereOf(i.path, t)} · {t[`code_${i.code}` as keyof BuilderStrings] ?? t.code_INVALID}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {step === 'source' ? (
              <Source k={kit} />
            ) : step === 'parts' ? (
              <Parts k={kit} />
            ) : step === 'areas' ? (
              <Areas k={kit} />
            ) : step === 'sizes' ? (
              <Sizes k={kit} />
            ) : (
              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                {step === 'addons' ? (
                  <Addons k={kit} />
                ) : step === 'rules' ? (
                  <Rules k={kit} />
                ) : (
                  <Publish k={kit} prep={prep} missing={missing} mesh={mesh} others={issues.filter((i) => stepOf(i.path, photoOnly) !== 'publish')} />
                )}
              </Suspense>
            )}
          </Motion.div>
        </MotionFeatures>
      </div>
    </Sheet>
  );
}

