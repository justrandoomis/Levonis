/**
 * THE STORE BUILDER'S STATE — the layout being edited (with undo), the gate's
 * verdict on it, the autosaved draft, the published page and its history,
 * and the rows the preview shows.
 *
 * Built on worker/routes/storeLayout.ts exactly as it is: GET / for the
 * draft, PUT /draft (autosave, fenced on the version), POST /publish,
 * POST /restore/:rev, GET /preview for the rows, GET /media for the picker.
 * Nothing here reaches the server except through `DraftSaver`, which sends
 * only `normalizeLayout`'s output (./autosave.ts, ./editorModel.ts).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { ApiError } from '../../../lib/api';
import { merchantApi, storefrontApi } from '../../../lib/merchant';
import type { StorefrontStore } from '../../storefront/types';
import { emptyBlockData, type BlockData } from '../../../../packages/storeLayout/src/data';
import { defaultLayoutFromStore } from '../../../../packages/storeLayout/src/defaults';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { DraftSaver, type SaverState } from './autosave';
import { commit, dataKey, redo, reset, summarizeChanges, undo, validateLayout, type History, type Validation } from './editorModel';
import { storeLayoutApi, type LayoutRevision, type LayoutState } from './storeLayoutApi';

type Action =
  | { t: 'commit'; layout: StoreLayout; key?: string | null }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'reset'; layout: StoreLayout }
  /** The server cleaned what was saved (a removed product, a deleted file): take its version in place. */
  | { t: 'server'; sentJson: string; layout: StoreLayout; owner: string };

function reducer(h: History | null, a: Action): History | null {
  if (a.t === 'reset') return reset(a.layout);
  if (!h) return h;
  switch (a.t) {
    case 'commit':
      return commit(h, a.layout, a.key ?? null);
    case 'undo':
      return undo(h);
    case 'redo':
      return redo(h);
    case 'server': {
      // Only when the editor still holds what was sent — never over newer typing.
      const now = JSON.stringify(validateLayout(h.present, a.owner).result.layout);
      if (now !== a.sentJson || JSON.stringify(a.layout) === a.sentJson) return h;
      return { ...h, present: a.layout, lastKey: null };
    }
  }
}

export interface PreviewState {
  /** Which layout the canvas shows: the editor's, or a published version being looked at. */
  source: 'draft' | { revision: number };
  data: BlockData;
  layout?: StoreLayout;
}

export function useLayoutEditor() {
  const { user } = useAuth();
  const owner = user?.id ?? '';
  const [server, setServer] = useState<LayoutState | null>(null);
  const [store, setStore] = useState<StorefrontStore | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [history, dispatch] = useReducer(reducer, null);
  const [saver, setSaverState] = useState<SaverState | null>(null);
  const [data, setData] = useState<BlockData>(emptyBlockData);
  const [viewing, setViewing] = useState<{ revision: number; layout: StoreLayout; data: BlockData } | null>(null);
  const saverRef = useRef<DraftSaver | null>(null);
  const dataNeeds = useRef('');

  const present = history?.present ?? null;
  const validation: Validation | null = useMemo(() => (present && owner ? validateLayout(present, owner) : null), [present, owner]);

  /** The rows the preview shows, re-read only when what the page needs changed. */
  const refreshData = useCallback(async (layout: StoreLayout, force = false) => {
    const needs = dataKey(layout);
    if (!force && needs === dataNeeds.current) return;
    dataNeeds.current = needs;
    try {
      const p = await storeLayoutApi.preview();
      setData(p.blocks_data);
    } catch {
      /* the preview keeps the rows it had; blocks load what they miss */
    }
  }, []);

  const makeSaver = useCallback(
    (version: number, layout: StoreLayout) => {
      saverRef.current?.dispose();
      const s = new DraftSaver(
        {
          save: async (l, v) => {
            const r = await storeLayoutApi.saveDraft(l, v);
            return { version: r.draft.version, layout: r.draft.layout, issues: r.issues ?? [] };
          },
          onState: setSaverState,
          onSaved: (answer, sentJson) => {
            dispatch({ t: 'server', sentJson, layout: answer.layout, owner });
            setServer((prev) => (prev ? { ...prev, draft: { ...prev.draft, exists: true, version: answer.version, layout: answer.layout } } : prev));
            void refreshData(answer.layout);
          },
        },
        { version, layout }
      );
      saverRef.current = s;
      setSaverState(s.snapshot);
      return s;
    },
    [owner, refreshData]
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, me] = await Promise.all([storeLayoutApi.get(), merchantApi.me()]);
      if (me.store) {
        // The public profile (stats included) is what the page renders around
        // the layout; a store the public cannot see falls back to the owner's.
        const pub = await storefrontApi
          .store(me.store.slug)
          .then((d) => d.store as StorefrontStore)
          .catch(() => me.store as StorefrontStore);
        setStore(pub);
      }
      setServer(s);
      const initial = s.draft.layout;
      dispatch({ t: 'reset', layout: initial });
      makeSaver(s.draft.version, validateLayout(initial, owner || '\u0000').result.layout);
      setViewing(null);
      await refreshData(initial, true);
    } catch (e) {
      setLoadError(e);
    }
  }, [makeSaver, owner, refreshData]);

  useEffect(() => {
    if (owner) void load();
  }, [load, owner]);

  // Every change: the gate's verdict goes to the saver.
  useEffect(() => {
    if (validation) saverRef.current?.update(validation.result.layout, validation.fatal);
  }, [validation]);

  // Leaving with unsaved work: save it now, and ask the browser to hold the tab.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = saverRef.current;
      if (s && (s.unsaved || s.snapshot.status === 'saving')) {
        void s.flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      const s = saverRef.current;
      if (s?.unsaved) void s.flush();
      s?.dispose();
    };
  }, []);

  const change = useCallback((layout: StoreLayout, key: string | null = null) => dispatch({ t: 'commit', layout, key }), []);

  /** What visitors see now: the published layout, or the classic page a store without one shows. */
  const live = useMemo(() => server?.published?.layout ?? defaultLayoutFromStore(null), [server]);
  const changes = useMemo(() => (validation ? summarizeChanges(live, validation.result.layout) : null), [live, validation]);

  const reloadDraft = useCallback(async () => {
    const s = await storeLayoutApi.get();
    setServer(s);
    dispatch({ t: 'reset', layout: s.draft.layout });
    saverRef.current?.adopt(s.draft.version, validateLayout(s.draft.layout, owner).result.layout);
    await refreshData(s.draft.layout, true);
  }, [owner, refreshData]);

  const keepMine = useCallback(async () => {
    const s = await storeLayoutApi.get();
    setServer(s);
    return saverRef.current?.keepMine(s.draft.version) ?? false;
  }, []);

  const flush = useCallback(() => saverRef.current?.flush() ?? Promise.resolve(false), []);

  const publish = useCallback(
    async (note: string) => {
      const saved = await flush();
      if (!saved) throw new ApiError(409, 'not saved', saverRef.current?.snapshot.status === 'conflict' ? 'DRAFT_CHANGED' : 'DRAFT_UNSAVED');
      let version = saverRef.current?.snapshot.version ?? 0;
      if (version === 0 && present) {
        // Nothing was ever saved: the draft is what the editor shows; save it first.
        const r = await storeLayoutApi.saveDraft(validateLayout(present, owner).result.layout, 0);
        version = r.draft.version;
      }
      const r = await storeLayoutApi.publish(version, note.trim());
      const s = await storeLayoutApi.get();
      setServer(s);
      saverRef.current?.adopt(s.draft.version, validateLayout(s.draft.layout, owner).result.layout);
      return r.published;
    },
    [flush, owner, present]
  );

  const restore = useCallback(
    async (revision: number, andPublish: boolean) => {
      await flush();
      const version = saverRef.current?.snapshot.version ?? 0;
      const r = await storeLayoutApi.restore(revision, version, andPublish);
      const s = await storeLayoutApi.get();
      setServer(s);
      // A restore replaces the draft wholesale: it is the new starting point.
      dispatch({ t: 'reset', layout: r.draft.layout });
      saverRef.current?.adopt(s.draft.version, validateLayout(r.draft.layout, owner).result.layout);
      setViewing(null);
      await refreshData(r.draft.layout, true);
      return r;
    },
    [flush, owner, refreshData]
  );

  const viewRevision = useCallback(async (revision: number | null) => {
    if (revision === null) {
      setViewing(null);
      return;
    }
    const p = await storeLayoutApi.preview(revision);
    setViewing({ revision, layout: p.layout, data: p.blocks_data });
  }, []);

  const loadMoreRevisions = useCallback(async (cursor: number) => {
    const r = await storeLayoutApi.revisions(cursor);
    setServer((prev) => (prev ? { ...prev, revisions: [...prev.revisions, ...r.revisions.filter((x) => !prev.revisions.some((y) => y.id === x.id))] } : prev));
    return r.next_cursor;
  }, []);

  return {
    owner,
    store,
    server,
    loadError,
    reload: load,
    layout: present,
    validation,
    change,
    undo: useCallback(() => dispatch({ t: 'undo' }), []),
    redo: useCallback(() => dispatch({ t: 'redo' }), []),
    canUndo: !!history?.past.length,
    canRedo: !!history?.future.length,
    save: saver,
    flush,
    reloadDraft,
    keepMine,
    live,
    changes,
    publish,
    restore,
    data,
    viewing,
    viewRevision,
    loadMoreRevisions,
  };
}

export type LayoutEditor = ReturnType<typeof useLayoutEditor>;
export type { LayoutRevision };
