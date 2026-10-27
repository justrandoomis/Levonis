/**
 * THE EDITOR — one design open: the Konva stage (stageView.ts), the panels,
 * history, autosave and the AI round trip.
 *
 * ONE PATH FOR EVERY CHANGE. A drag, a typed number, a panel button, the
 * keyboard and an accepted Claude answer all become operations run by
 * `applyOps` (actor `human` for people), or a re-layout the shared package
 * computes (`rebuild`). An edit that creates a NEW conflict opens the
 * conflicts dialog and the previous design stays until the owner chooses.
 *
 * SAVING IS HONEST. Autosave (~1.2 s after the last change) sends the version
 * the editor started from; «محفوظ» appears only after the server’s 200; a 409
 * stops and asks (open theirs / keep mine as a new design); offline keeps a
 * local recovery draft (content + base version + time, nothing else) that is
 * offered on the next open when it is newer than the server copy. Leaving the
 * page, hiding the tab or opening another design flushes first.
 *
 * FONTS BEFORE PIXELS. Nothing is measured or drawn until every face the
 * design uses has loaded (fonts.ts); a face that fails is a visible warning
 * and a quality blocker, never a silent substitute.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Layers as LayersIcon, Maximize, MessageSquare, Minus, MoreHorizontal, Plus, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { Input } from '../ui/Field';
import { Overlay } from '../ui/Overlay';
import { TabStrip } from '../ui/Tabs';
import { toast } from '../ui/Toast';
import { normalizeDocument } from '../../../packages/creativeDoc/src/normalize';
import { detectConflicts, rebuild, refreshBoundText, resolveConflict, type ConflictOption, type LayoutConflict } from '../../../packages/creativeDoc/src/layout';
import type { ApplyResult, OpRefusal, RebuildRequest } from '../../../packages/creativeDoc/src/ops';
import type { DocumentDto, VerifyDto } from '../../../packages/creativeDoc/src/api';
import type { Annotation, CreativeDocument, Density, ViewTransform } from '../../../packages/creativeDoc/src/schema';
import { TEMPLATES, variantsFor, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';
import { ai, assets as assetsApi, brand as brandApi, documents, store } from './client';
import { Autosave, type SaveState } from './autosave';
import ConflictsDialog, { type PendingConflict } from './ConflictsDialog';
import type { EditorApi } from './editorApi';
import { allowedAssets, bindingContext, rebuildContext, usesTestData, type EditorData } from './editorData';
import {
  RECOVERY_PREFIX, commit, draftWorthOffering, historyOf, nudgeOps, parseDraft, redo, reset, runHumanOps, serializeDraft, topLevel, undo, type History, type RecoveryDraft,
} from './editorModel';
import { ensureFonts, registerStudioFonts, type FontState } from './fonts';
import { canvasMeasurer, ImageStore } from './media';
import AssetsPanel from './panels/AssetsPanel';
import ChatPanel from './panels/ChatPanel';
import ExportPanel from './panels/ExportPanel';
import FormatsPanel from './panels/FormatsPanel';
import LayersPanel from './panels/LayersPanel';
import PhonePreview from './panels/PhonePreview';
import PropertiesPanel from './panels/PropertiesPanel';
import QaPanel from './panels/QaPanel';
import { StageView, type Tool } from './stageView';
import { FORMAT_TEXT, REFUSAL_TEXT, S, fill } from './strings';
import TextOverlay from './TextOverlay';
import { RemoteView, failText, shortTime, useMediaQuery, useRemote, useStudio, useText } from './shared';
import { canonicalJson, type ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';

type RightTab = 'chat' | 'assets' | 'qa' | 'phone' | 'export' | 'formats';

/** Loads the design and everything it binds to, then hands over to the editor proper. */
export default function Editor({ docId }: { docId: string }) {
  const studio = useStudio();
  const [remote, reload] = useRemote(async () => {
    const meta = await documents.get(docId);
    const [brandDto, claims, assetList, opportunities] = await Promise.all([
      studio.brand ? Promise.resolve(studio.brand) : brandApi.get(),
      brandApi.claims(),
      assetsApi.list(),
      ai.opportunities(),
    ]);
    const snapshots: Record<string, ProductSnapshot> = {};
    for (const b of meta.content.products ?? []) {
      // A snapshot that cannot be read stays missing: the checks report `snapshot_missing`; nothing is invented.
      try {
        snapshots[b.slot] = await store.getSnapshot(b.snapshot_id);
      } catch {
        /* reported by the quality check */
      }
    }
    const data: EditorData = { brand: brandDto, claims, assets: assetList, opportunities, snapshots };
    return { meta, data };
  }, [docId]);
  return (
    <RemoteView remote={remote} onRetry={reload}>
      {({ meta, data }) => <EditorReady key={`${meta.id}:${meta.version}`} meta={meta} data={data} />}
    </RemoteView>
  );
}

function sigOf(c: LayoutConflict): string {
  return `${c.code}:${[...c.layer_ids].sort().join(',')}`;
}

function refusalText(refusals: readonly OpRefusal[], w: (t: { ar: string; en: string; ckb: string }) => string): string {
  return [...new Set(refusals.map((r) => (r.code in REFUSAL_TEXT ? w(REFUSAL_TEXT[r.code]) : r.code)))].join('، ');
}

function fitView(box: { width: number; height: number }, doc: CreativeDocument): ViewTransform {
  const pad = box.width < 600 ? 12 : 32;
  const scale = Math.max(0.05, Math.min((box.width - pad * 2) / doc.format.width, (box.height - pad * 2) / doc.format.height, 2));
  return { scale, offsetX: (box.width - doc.format.width * scale) / 2, offsetY: (box.height - doc.format.height * scale) / 2 };
}

/** Exported for the static render test (tests/creativeStudioUiRender.test.ts). */
export function EditorReady({ meta, data }: { meta: DocumentDto; data: EditorData }) {
  const studio = useStudio();
  const { lang, dir, w } = useText();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const wide = useMediaQuery('(min-width: 1280px)');

  // ---- the document --------------------------------------------------------
  const start = useMemo(() => {
    const n = normalizeDocument(meta.content);
    if (!n.ok) return { ok: false as const, issues: n.issues };
    // Bound words are drawn from the snapshots on every open (spec §9).
    return { ok: true as const, doc: refreshBoundText(n.doc, bindingContext(n.doc, data)) };
  }, [meta, data]);

  if (start.ok === false) {
    return (
      <div className="p-8 text-center" role="alert">
        <p className="text-sm text-danger">{w(S.editorLoadFailed)}</p>
        <p className="mt-2 text-xs text-text-muted" dir="ltr">{start.issues.filter((i) => i.fatal).map((i) => `${i.path} ${i.code}`).join(', ')}</p>
      </div>
    );
  }
  return <EditorCore meta={meta} data={data} initial={start.doc} studio={studio} lang={lang} dir={dir} w={w} desktop={desktop} wide={wide} />;
}

interface CoreProps {
  meta: DocumentDto;
  data: EditorData;
  initial: CreativeDocument;
  studio: ReturnType<typeof useStudio>;
  lang: ReturnType<typeof useText>['lang'];
  dir: 'rtl' | 'ltr';
  w: ReturnType<typeof useText>['w'];
  desktop: boolean;
  wide: boolean;
}

function EditorCore({ meta, data, initial, studio, lang, dir, w, desktop, wide }: CoreProps) {
  const docId = meta.id;
  const { setLeaveGuard } = studio;
  const [history, setHistory] = useState<History>(() => historyOf(initial));
  const doc = history.present;
  const [selection, setSelectionState] = useState<string[]>([]);
  const [version, setVersion] = useState(meta.version);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [fonts, setFonts] = useState<FontState>({ loaded: new Set(), failed: [] });
  const [fontsReady, setFontsReady] = useState(false);
  const [measureEpoch, setMeasureEpoch] = useState(0);
  // A new measurer whenever a face arrives: the old one cached widths of the fallback font.
  const measure = useMemo(() => canvasMeasurer(), [measureEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const images = useMemo(() => new ImageStore(), []);
  const [imageTick, setImageTick] = useState(0);
  const [view, setView] = useState<ViewTransform>({ scale: 0.4, offsetX: 0, offsetY: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<Omit<Annotation, 'id' | 'note'> | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [conflictMsg, setConflictMsg] = useState('');
  const [verification, setVerification] = useState<Record<string, VerifyDto>>({});
  const [recovery, setRecovery] = useState<RecoveryDraft | null>(null);
  const [title, setTitle] = useState(meta.title);
  const [rightTab, setRightTab] = useState<RightTab>('chat');
  const [leftOpen, setLeftOpen] = useState(true);
  const [sheet, setSheet] = useState<null | 'layers' | 'props' | 'chat' | RightTab>(null);
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });

  const stageRef = useRef<StageView | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autosave = useRef<Autosave | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const versionRef = useRef(version);
  versionRef.current = version;
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const suppressSave = useRef<CreativeDocument | null>(null);
  const fitted = useRef(false);
  const draftKey = RECOVERY_PREFIX + docId;

  const allowed = useMemo(() => allowedAssets(doc, data), [doc.products, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const opsCtx = useCallback(() => ({ brand: data.brand.kit, allowed: allowedRef.current, measure: measureRef.current }), [data]);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const setSelection = useCallback((ids: string[]) => setSelectionState(ids), []);
  const commitDoc = useCallback((next: CreativeDocument) => setHistory((h) => commit(h, next)), []);

  // ---- autosave + recovery -------------------------------------------------
  useEffect(() => {
    const a = new Autosave(
      {
        save: (content, base, m) => documents.save(docId, { content, base_version: base, origin: m.origin, job_id: m.job_id }),
        onState: (s) => setSaveState(s),
        onSaved: (content, r) => {
          setVersion(r.version);
          versionRef.current = r.version;
          if (content === docRef.current) {
            try { localStorage.removeItem(draftKey); } catch { /* storage unavailable */ }
          }
        },
      },
      // The opened document is the saved baseline unless it REALLY differs from the server copy
      // (bound words re-drawn from a newer snapshot) — the normaliser’s key order is not a change.
      { content: canonicalJson(initial) === canonicalJson(meta.content) ? initial : meta.content, version: meta.version },
    );
    autosave.current = a;
    try {
      const draft = parseDraft(localStorage.getItem(draftKey));
      if (draftWorthOffering(draft, { version: meta.version, updated_at: meta.updated_at, content: meta.content })) setRecovery(draft);
    } catch { /* storage unavailable */ }
    const online = () => { if (a.current === 'offline') void a.retry(); };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      void a.flush();
      a.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (suppressSave.current === doc) {
      suppressSave.current = null;
      return;
    }
    autosave.current?.change(doc);
    const t = setTimeout(() => {
      if (!autosave.current?.hasUnsaved) return;
      try { localStorage.setItem(draftKey, serializeDraft(doc, versionRef.current, new Date())); } catch { /* storage full or blocked: the server copy stays the record */ }
    }, 400);
    return () => clearTimeout(t);
  }, [doc, draftKey]);

  // Flush when the tab is hidden; ask before leaving with unsaved work.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') void autosave.current?.flush(); };
    const unload = (e: BeforeUnloadEvent) => {
      if (autosave.current?.hasUnsaved) {
        void autosave.current.flush();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('beforeunload', unload);
    const off = setLeaveGuard(() => {
      if (!autosave.current?.hasUnsaved) return true;
      void autosave.current.flush();
      return window.confirm(w(S.leaveUnsaved));
    });
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('beforeunload', unload);
      off();
    };
  }, [w, setLeaveGuard]);

  // ---- fonts, pictures -----------------------------------------------------
  const fontKeySig = useMemo(() => doc.layers.filter((l) => l.type === 'text').map((l) => (l.type === 'text' ? `${l.font.family}|${l.font.weight}|${l.text}` : '')).join('\n'), [doc.layers]);
  useEffect(() => {
    registerStudioFonts();
    let alive = true;
    const t = setTimeout(() => {
      void ensureFonts(docRef.current, fonts).then((state) => {
        if (!alive) return;
        const changed = state.failed.join() !== fonts.failed.join() || [...state.loaded].join() !== [...fonts.loaded].join();
        if (changed || !fontsReady) {
          setFonts(state);
          setMeasureEpoch((e) => e + 1);
        }
        setFontsReady(true);
      });
    }, fontsReady ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [fontKeySig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => images.subscribe(() => setImageTick((n) => n + 1)), [images]);
  useEffect(() => {
    for (const l of doc.layers) if (l.type === 'image') void images.load(l.asset);
  }, [doc.layers, images]);

  // ---- the stage -----------------------------------------------------------
  const cb = useRef({
    onSelect: (_ids: string[]) => {},
    onCommitOps: (_ops: unknown[]) => {},
    onEditText: (_id: string) => {},
    onAnnotate: (_a: Omit<Annotation, 'id' | 'note'>) => {},
    onViewChange: (_v: ViewTransform) => {},
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sv = new StageView(el, {
      onSelect: (ids) => cb.current.onSelect(ids),
      onCommitOps: (ops) => cb.current.onCommitOps(ops),
      onEditText: (id) => cb.current.onEditText(id),
      onAnnotate: (a) => cb.current.onAnnotate(a),
      onViewChange: (v) => cb.current.onViewChange(v),
    }, { measure: () => measureRef.current, image: (ref) => images.get(ref) });
    stageRef.current = sv;
    const ro = new ResizeObserver(() => {
      sv.setSize(el.clientWidth, el.clientHeight);
      setBoxSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      sv.destroy();
      stageRef.current = null;
    };
  }, [images]);

  useEffect(() => {
    if (!boxSize.width || !boxSize.height) return;
    if (!fitted.current) {
      fitted.current = true;
      setView(fitView(boxSize, docRef.current));
    }
  }, [boxSize]);

  const lastMeasure = useRef(measure);
  useLayoutEffect(() => {
    const sv = stageRef.current;
    if (!sv || !fontsReady) return;
    if (lastMeasure.current !== measure) {
      lastMeasure.current = measure;
      sv.invalidateText();
    }
    sv.render(doc, selection);
  }, [doc, selection, fontsReady, measure, imageTick]);
  useLayoutEffect(() => { stageRef.current?.setView(view); }, [view]);
  useEffect(() => { stageRef.current?.setTool(tool); }, [tool]);
  useEffect(() => { stageRef.current?.setEditing(editing); }, [editing, doc, fontsReady]);

  // ---- applying changes ----------------------------------------------------
  const apply = useCallback((ops: unknown[]): boolean => {
    const before = docRef.current;
    const r = runHumanOps(before, ops, opsCtx());
    if (r.ok === false) {
      toast.error(`${w(S.refused)} ${refusalText(r.refusals, w)}`);
      return false;
    }
    if (r.rebuild) {
      void rebuildRef.current(r.rebuild);
      return true;
    }
    const had = new Set(detectConflicts(before, { measure: measureRef.current }).map(sigOf));
    const fresh = r.conflicts.filter((c) => !had.has(sigOf(c)));
    if (fresh.length) {
      setConflictMsg('');
      setPendingConflict({ candidate: r.doc, conflicts: fresh });
      return true;
    }
    commitDoc(r.doc);
    return true;
  }, [commitDoc, opsCtx, w]);

  const rebuildTo = useCallback(async (change: RebuildRequest | { kind: 'density'; density: Density }) => {
    const before = docRef.current;
    if (!before.template || !(before.template.id in TEMPLATES)) {
      toast.info(w(S.rebuildUnavailable));
      return;
    }
    // The same refusals as everywhere: the operation is checked before the package re-lays the design.
    if (change.kind !== 'density') {
      const op = change.kind === 'variant' ? { op: 'switch_template_variant', variant: change.variant }
        : change.kind === 'priority' ? { op: 'set_priority', priority: change.priority }
        : { op: 'create_format_variant', format: change.format.id, ...(change.format.id === 'custom' ? { width: change.format.width, height: change.format.height } : {}) };
      const check = runHumanOps(before, [op], opsCtx());
      if (check.ok === false) {
        toast.error(`${w(S.refused)} ${refusalText(check.refusals, w)}`);
        return;
      }
    }
    const tpl = TEMPLATES[before.template.id as TemplateId];
    let variant: VariantId | undefined;
    if (change.kind === 'variant') variant = change.variant;
    if (change.kind === 'priority') {
      const main = before.products[0];
      const status = main ? data.snapshots[main.slot]?.data.price.status ?? null : null;
      variant = variantsFor(tpl.id, before.objective, status).find((v) => tpl.variants[v]?.priority === change.priority)
        ?? (Object.keys(tpl.variants) as VariantId[]).find((v) => tpl.variants[v]?.priority === change.priority);
      if (!variant) {
        toast.info(w(S.rebuildUnavailable));
        return;
      }
    }
    const ctx = rebuildContext(before, data, measureRef.current);
    const result = rebuild(before, change.kind === 'format' ? { format: change.format } : change.kind === 'density' ? { density: change.density } : { variant }, ctx);
    if (!result) {
      toast.info(w(S.rebuildUnavailable));
      return;
    }
    if (change.kind === 'format') {
      try {
        await autosave.current?.flush();
        const label = change.format.id === 'custom' ? `${change.format.width}×${change.format.height}` : w(FORMAT_TEXT[change.format.id]);
        const created = await documents.create({ title: `${title} — ${label}`.slice(0, 120), content: result.doc, parent_id: docId, origin: 'relayout' });
        toast.success(w(S.formatsCreated));
        studio.openDocument(created.id);
      } catch (e) {
        toast.error(failText(e, lang));
      }
      return;
    }
    commitDoc(result.doc);
    toast.info(w(S.rebuildDone));
  }, [commitDoc, data, docId, lang, opsCtx, studio, title, w]);
  const rebuildRef = useRef(rebuildTo);
  rebuildRef.current = rebuildTo;

  const applyAi = useCallback(async (applied: Extract<ApplyResult, { ok: true }>, jobId: string): Promise<boolean> => {
    const a = autosave.current;
    if (!a) return false;
    if (applied.rebuild) {
      await rebuildRef.current(applied.rebuild);
      const after = docRef.current;
      suppressSave.current = after;
      const res = await a.saveAs(after, { origin: 'ai', job_id: jobId });
      if (!res) return false;
      await ai.applied(jobId, docId, res.version).catch((e: unknown) => toast.error(failText(e, lang)));
      return true;
    }
    suppressSave.current = applied.doc;
    setHistory((h) => commit(h, applied.doc));
    const res = await a.saveAs(applied.doc, { origin: 'ai', job_id: jobId });
    if (!res) return false;
    await ai.applied(jobId, docId, res.version).catch((e: unknown) => toast.error(failText(e, lang)));
    return true;
  }, [docId, lang]);

  const editText = useCallback((id: string) => {
    const d = docRef.current;
    let l = d.layers.find((x) => x.id === id);
    if (l && l.type === 'group') l = d.layers.find((x) => x.parent === l!.id && x.type === 'text');
    if (!l || l.type !== 'text') return;
    if (l.locked) {
      toast.info(w(S.propLockedNote));
      return;
    }
    if (l.source.kind !== 'free') {
      toast.info(w(S.textBoundRefused));
      return;
    }
    setEditing(l.id);
  }, [w]);

  cb.current = {
    onSelect: (ids) => setSelectionState(ids),
    onCommitOps: (ops) => { apply(ops); },
    onEditText: editText,
    onAnnotate: (a) => {
      setPendingNote(a);
      setTool('select');
      if (desktop) setRightTab('chat');
      else setSheet('chat');
    },
    onViewChange: (v) => setView(v),
  };

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('[data-overlay-panel]'))) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        setHistory(redo);
        return;
      }
      const ids = topLevel(docRef.current, selectionRef.current);
      if (e.key === 'Escape') {
        if (tool !== 'select') setTool('select');
        else setSelectionState([]);
        return;
      }
      if (!ids.length) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (apply(ids.map((id) => ({ op: 'delete_layer', layer_id: id })))) setSelectionState([]);
        return;
      }
      if (e.key === 'Enter' && ids.length === 1) {
        e.preventDefault();
        editText(ids[0]);
        return;
      }
      const ops = nudgeOps(docRef.current, ids, e.key, e.shiftKey);
      if (ops.length) {
        e.preventDefault();
        apply(ops);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [apply, editText, tool]);

  // ---- version conflict ----------------------------------------------------
  const reloadTheirs = async () => {
    try {
      const fresh = await documents.get(docId);
      const n = normalizeDocument(fresh.content);
      if (!n.ok) throw new Error(w(S.editorLoadFailed));
      const next = refreshBoundText(n.doc, bindingContext(n.doc, data));
      suppressSave.current = next;
      setHistory(reset(next));
      setVersion(fresh.version);
      autosave.current?.rebase(next, fresh.version);
    } catch (e) {
      toast.error(failText(e, lang));
    }
  };
  const keepMine = async () => {
    try {
      const created = await documents.create({ title: `${title} (2)`.slice(0, 120), content: docRef.current, parent_id: docId, origin: 'manual' });
      studio.openDocument(created.id);
    } catch (e) {
      toast.error(failText(e, lang));
    }
  };

  // ---- the panels' handle --------------------------------------------------
  const api: EditorApi = {
    docId, meta: { ...meta, title }, doc, version, saveState, selection, setSelection, apply,
    replaceDocument: commitDoc, data, allowed, measure, fonts, images, provider: studio.provider,
    stage: () => stageRef.current, tool, setTool,
    flush: async () => { await autosave.current?.flush(); },
    current: () => ({ doc: docRef.current, version: versionRef.current, saveState: autosave.current?.current ?? saveStateRef.current }),
    applyAi, rebuildTo, verification, setVerification, editText, openDocument: studio.openDocument, goSettings: () => studio.goTab('settings'),
  };

  const onConflictOption = (c: LayoutConflict, option: ConflictOption) => {
    if (!pendingConflict) return;
    if (option === 'switch_density' || option === 'switch_variant') {
      setPendingConflict(null);
      if (option === 'switch_density') void rebuildTo({ kind: 'density', density: docRef.current.density === 'brief' ? 'detailed' : 'brief' });
      else {
        const tpl = docRef.current.template ? TEMPLATES[docRef.current.template.id as TemplateId] : null;
        const next = tpl ? (Object.keys(tpl.variants) as VariantId[]).find((v) => v !== docRef.current.template!.variant) : undefined;
        if (next) void rebuildTo({ kind: 'variant', variant: next });
        else toast.info(w(S.rebuildUnavailable));
      }
      return;
    }
    const resolved = resolveConflict(pendingConflict.candidate, c, option, { measure: measureRef.current, brand: data.brand.kit });
    if (!resolved) {
      setConflictMsg(w(S.conflictsOptionFailed));
      return;
    }
    setPendingConflict(null);
    commitDoc(resolved);
  };

  // ---- view ----------------------------------------------------------------
  const zoom = (factor: number) => stageRef.current?.zoomAt({ x: boxSize.width / 2, y: boxSize.height / 2 }, view.scale * factor);
  const fit = () => setView(fitView(boxSize, doc));
  useEffect(() => {
    if (boxSize.width) setView(fitView(boxSize, docRef.current));
  }, [doc.format.width, doc.format.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const editingLayer = editing ? doc.layers.find((l) => l.id === editing) : undefined;
  const editingScreen = editing && stageRef.current ? stageRef.current.screenBox(editing) : null;
  const saveLabel = saveState === 'saving' ? S.saveSaving : saveState === 'saved' ? S.saveSaved : saveState === 'dirty' ? S.saveDirty : saveState === 'failed' ? S.saveFailed : saveState === 'offline' ? S.saveOffline : saveState === 'conflict' ? S.saveConflict : S.saveIdle;
  const saveTone = saveState === 'failed' || saveState === 'conflict' ? 'text-danger' : saveState === 'offline' ? 'text-warning' : saveState === 'saved' ? 'text-success' : 'text-text-muted';
  const testData = usesTestData(doc, data);

  const rightTabs: Array<{ id: RightTab; label: string }> = [
    { id: 'chat', label: w(S.panelChat) },
    { id: 'assets', label: w(S.panelAssets) },
    { id: 'qa', label: w(S.panelQa) },
    { id: 'phone', label: w(S.panelPhone) },
    { id: 'export', label: w(S.panelExport) },
    { id: 'formats', label: w(S.panelFormats) },
  ];
  const panelFor = (id: RightTab | 'layers' | 'props' | 'chat') => {
    switch (id) {
      case 'chat': return <ChatPanel api={api} pending={pendingNote} onPendingDone={() => setPendingNote(null)} />;
      case 'assets': return <AssetsPanel api={api} />;
      case 'qa': return <QaPanel api={api} />;
      case 'phone': return <PhonePreview api={api} />;
      case 'export': return <ExportPanel api={api} />;
      case 'formats': return <FormatsPanel api={api} />;
      case 'layers': return <LayersPanel api={api} />;
      case 'props': return <PropertiesPanel api={api} />;
    }
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-2 py-1.5" data-editor-header>
      <Input
        aria-label={w(S.editorTitle)}
        className="max-w-xs"
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title.trim() && title !== meta.title) void documents.rename(docId, title.trim()).catch((e: unknown) => toast.error(failText(e, lang))); }}
      />
      <span className={`text-sm ${saveTone}`} role="status" aria-live="polite" data-save-state={saveState}>
        {w(saveLabel)} · {fill(w(S.saveVersion), { n: version })}
      </span>
      {saveState === 'failed' || saveState === 'offline' ? <Button size="sm" variant="ghost" onClick={() => void autosave.current?.retry()}>{w(S.retry)}</Button> : null}
      <div className="ms-auto flex items-center">
        <IconButton label={w(S.undo)} icon={<Undo2 className="h-4 w-4" />} disabled={!history.past.length} onClick={() => setHistory(undo)} />
        <IconButton label={w(S.redo)} icon={<Redo2 className="h-4 w-4" />} disabled={!history.future.length} onClick={() => setHistory(redo)} />
        <IconButton label={w(S.zoomOut)} icon={<Minus className="h-4 w-4" />} onClick={() => zoom(1 / 1.2)} />
        <span className="w-12 text-center text-xs tabular-nums text-text-muted" dir="ltr">{Math.round(view.scale * 100)}%</span>
        <IconButton label={w(S.zoomIn)} icon={<Plus className="h-4 w-4" />} onClick={() => zoom(1.2)} />
        <IconButton label={w(S.zoomFit)} icon={<Maximize className="h-4 w-4" />} onClick={fit} />
      </div>
    </div>
  );

  const banners = (
    <>
      {testData ? <p className="bg-warning/10 px-3 py-1.5 text-sm text-warning" role="status" data-test-banner>{w(S.testDataBanner)}</p> : null}
      {fonts.failed.map((f) => <p key={f} className="bg-danger/10 px-3 py-1.5 text-sm text-danger" role="alert" data-font-failed>{fill(w(S.fontFailed), { name: f })}</p>)}
      {images.failedRefs().length ? <p className="bg-danger/10 px-3 py-1.5 text-sm text-danger" role="alert">{w(S.imageFailed)}</p> : null}
      {recovery ? (
        <div className="flex flex-wrap items-center gap-2 bg-surface px-3 py-2 text-sm" role="alert" data-recovery>
          <span className="font-semibold text-text-primary">{w(S.recoveryTitle)}</span>
          <span className="text-text-secondary">{fill(w(S.recoveryBody), { time: shortTime(recovery.saved_at, lang) })}</span>
          <Button size="sm" variant="primary" onClick={() => {
            const n = normalizeDocument(recovery.content);
            if (n.ok) commitDoc(n.doc);
            setRecovery(null);
          }}>{w(S.recoveryRestore)}</Button>
          <Button size="sm" variant="ghost" onClick={() => { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } setRecovery(null); }}>{w(S.recoveryDrop)}</Button>
        </div>
      ) : null}
      {saveState === 'conflict' ? (
        <div className="flex flex-wrap items-center gap-2 bg-danger/10 px-3 py-2 text-sm" role="alert" data-version-conflict>
          <span className="font-semibold text-text-primary">{w(S.conflictTitle)}</span>
          <span className="text-text-secondary">{w(S.conflictBody)}</span>
          <Button size="sm" onClick={reloadTheirs}>{w(S.conflictReload)}</Button>
          <Button size="sm" variant="primary" onClick={keepMine}>{w(S.conflictKeepMine)}</Button>
        </div>
      ) : null}
    </>
  );

  const stageBox = (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: 'repeating-conic-gradient(rgba(127,127,127,0.08) 0% 25%, transparent 0% 50%) 0 0 / 24px 24px' }}>
      <div ref={containerRef} className="absolute inset-0 touch-none" role="application" aria-label={w(S.canvasLabel)} data-stage tabIndex={0} />
      {!fontsReady ? <p className="absolute inset-x-0 top-2 text-center text-sm text-text-muted" role="status">{w(S.fontsLoading)}</p> : null}
      {editingLayer && editingLayer.type === 'text' && editingScreen ? (
        <TextOverlay
          key={editingLayer.id}
          layer={editingLayer}
          screen={editingScreen}
          scale={view.scale}
          docDirection={doc.direction}
          onCommit={(value) => { setEditing(null); apply([{ op: 'set_text', layer_id: editingLayer.id, value }]); }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );

  if (desktop) {
    return (
      <div className="flex h-full min-h-0 flex-col" dir={dir} data-editor data-doc-id={docId}>
        {header}
        {banners}
        <div className="flex min-h-0 flex-1">
          {leftOpen || wide ? (
            <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-e border-border-subtle p-3" aria-label={`${w(S.panelProperties)} / ${w(S.panelLayers)}`}>
              {!wide ? <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setLeftOpen(false)}>{fill(w(S.hidePanel), { name: w(S.panelLayers) })}</Button> : null}
              <section>
                <h2 className="mb-2 text-sm font-semibold text-text-secondary">{w(S.panelProperties)}</h2>
                <PropertiesPanel api={api} />
              </section>
              <section>
                <h2 className="mb-2 text-sm font-semibold text-text-secondary">{w(S.panelLayers)}</h2>
                <LayersPanel api={api} />
              </section>
            </aside>
          ) : (
            <div className="flex shrink-0 flex-col border-e border-border-subtle p-1">
              <IconButton label={fill(w(S.showPanel), { name: w(S.panelLayers) })} icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setLeftOpen(true)} />
            </div>
          )}
          {stageBox}
          <aside className="flex w-96 shrink-0 flex-col border-s border-border-subtle" aria-label={w(S.panelChat)}>
            <div className="overflow-x-auto px-2"><TabStrip group="editor-right" items={rightTabs} value={rightTab} onChange={(id) => setRightTab(id as RightTab)} /></div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3" data-right-panel={rightTab}>{panelFor(rightTab)}</div>
          </aside>
        </div>
        {pendingConflict ? <ConflictsDialog pending={pendingConflict} message={conflictMsg} onOption={onConflictOption} onKeep={() => { commitDoc(pendingConflict.candidate); setPendingConflict(null); }} onRevert={() => setPendingConflict(null)} /> : null}
      </div>
    );
  }

  // Phone: the preview owns the screen; everything else is a bottom sheet with 44 px targets.
  const phoneButtons: Array<{ id: 'layers' | 'props' | 'chat' | 'more'; label: string; icon: ReactNode }> = [
    { id: 'props', label: w(S.panelProperties), icon: <SlidersHorizontal className="h-5 w-5" /> },
    { id: 'layers', label: w(S.panelLayers), icon: <LayersIcon className="h-5 w-5" /> },
    { id: 'chat', label: w(S.panelChat), icon: <MessageSquare className="h-5 w-5" /> },
    { id: 'more', label: w(S.panelExport), icon: <MoreHorizontal className="h-5 w-5" /> },
  ];
  const sheetTitle = sheet === 'layers' ? w(S.panelLayers) : sheet === 'props' ? w(S.panelProperties) : sheet === 'chat' ? w(S.panelChat) : sheet ? rightTabs.find((t) => t.id === sheet)?.label ?? '' : '';
  return (
    <div className="flex h-full min-h-0 flex-col" dir={dir} data-editor data-doc-id={docId}>
      {header}
      {banners}
      {stageBox}
      {selection.length === 1 ? (
        <div className="flex gap-2 border-t border-border-subtle px-2 py-1">
          {(() => {
            const l = doc.layers.find((x) => x.id === selection[0]);
            const text = l && (l.type === 'text' || (l.type === 'group' && doc.layers.some((x) => x.parent === l.id && x.type === 'text')));
            return text ? <Button size="sm" onClick={() => editText(selection[0])}>{w(S.propEditText)}</Button> : null;
          })()}
        </div>
      ) : null}
      <nav className="grid grid-cols-4 border-t border-border-subtle" aria-label={w(S.studioShort)}>
        {phoneButtons.map((b) => (
          <button key={b.id} type="button" className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setSheet(b.id === 'more' ? 'export' : b.id)}>
            {b.icon}
            <span>{b.label}</span>
          </button>
        ))}
      </nav>
      {/* Mounted only while open: the sheet is built on demand, and a server render never meets a portal. */}
      {sheet ? <Overlay open onClose={() => setSheet(null)} placement="dock" label={sheetTitle} panelClassName="max-h-[80dvh] w-full overflow-y-auto">
        {() => (
          <div className="flex flex-col gap-3 p-4" dir={dir}>
            {sheet && sheet !== 'layers' && sheet !== 'props' && sheet !== 'chat' ? (
              <div className="overflow-x-auto"><TabStrip group="editor-sheet" items={rightTabs.filter((t) => t.id !== 'chat')} value={sheet} onChange={(id) => setSheet(id as RightTab)} /></div>
            ) : null}
            {sheet ? panelFor(sheet) : null}
            <Button size="sm" variant="ghost" icon={<ArrowRight className="h-4 w-4" />} onClick={() => setSheet(null)}>{w(S.close)}</Button>
          </div>
        )}
      </Overlay> : null}
      {pendingConflict ? <ConflictsDialog pending={pendingConflict} message={conflictMsg} onOption={onConflictOption} onKeep={() => { commitDoc(pendingConflict.candidate); setPendingConflict(null); }} onRevert={() => setPendingConflict(null)} /> : null}
    </div>
  );
}
