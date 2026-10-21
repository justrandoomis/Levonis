/**
 * SAVING THE DRAFT (plan P1-06, docs/DECISIONS.md row 268; design critiques
 * 1–4 and 8, 11 of the second).
 *
 * THE SERVER DRAFT IS THE RECORD; this tab’s copy (sessionMirror.ts) holds
 * what the server does not have yet.
 *
 *   AUTOSAVE (a draft only). After a change the form must be idle for 2 s,
 *   and an autosave never follows another within 30 s — the draft save
 *   allows 120 an hour (worker/routes/printRequests.ts). One save in flight
 *   at a time; what changes meanwhile goes in the next.
 *   FLUSH, the spacing waived: when focus leaves a section, before an upload
 *   starts, before the review opens, and on leaving — `visibilitychange` to
 *   hidden, `pagehide` and the editor unmounting (an in-app Back cannot be
 *   stopped in this app) send the body as a keepalive request with no
 *   `expected_updated_at`: a save of this same tab still in flight moves the
 *   stamp, and the last words must not be refused for it.
 *   A STALE TAB: every other save names the stamp it was made on, and a
 *   newer save from another window answers 409 DRAFT_CHANGED — the editor
 *   then offers «حمّل الأحدث» or «احفظ نسختي» (which says it overwrites).
 *   A SESSION THAT RAN OUT (401): the copy is written, the status says so and
 *   the sign-in comes back here, where the copy is applied again.
 *   NO CONNECTION: «لا اتصال», and the save is tried again when the browser
 *   says it is back online.
 *   A PUBLISHED REQUEST: no autosave at all — its changes are published by
 *   «احفظ التعديلات», which revises the job honestly; until then the whole
 *   state stays in the tab copy.
 *
 * Only a failure, the loss of the connection and a conflict are announced
 * to a screen reader; «يُحفظ…» and «محفوظ» are not, every few seconds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { editorApi, type DraftShape } from '../api';
import { adoptIds, bodyKey, editorBody, hydrate, isPublishedEdit, sentShape, type EditorState } from './state';
import { clearMirror, writeMirror, type MirrorStorage } from './sessionMirror';

export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'offline' | 'conflict' | 'signedOut';

export const AUTOSAVE_IDLE_MS = 2_000;
export const AUTOSAVE_SPACING_MS = 30_000;
const MIRROR_DELAY_MS = 300;

/** When the next autosave may run: idle for 2 s, and 30 s after the last one. */
export function autosaveDelay(now: number, lastAutosaveAt: number): number {
  return Math.max(AUTOSAVE_IDLE_MS, lastAutosaveAt + AUTOSAVE_SPACING_MS - now);
}

/** What a failed save means for the status. */
export function statusOfError(e: unknown, online: boolean): SaveStatus {
  if (e instanceof ApiError) {
    if (e.status === 409 && e.code === 'DRAFT_CHANGED') return 'conflict';
    if (e.status === 401) return 'signedOut';
    if (e.status === 0) return online ? 'failed' : 'offline';
  }
  return 'failed';
}

export interface Persistence {
  status: SaveStatus;
  /** The refusal of the last save, when it was one (a coded 4xx). */
  error: unknown;
  /** The draft another window saved, while `status` is 'conflict'. */
  latest: DraftShape | null;
  dirty: boolean;
  /** Save now (the explicit «احفظ», the retry). Resolves true when the server has everything. */
  saveNow: () => Promise<boolean>;
  /** Save now if anything is unsaved, the spacing waived. */
  flush: () => Promise<boolean>;
  /** A new baseline: the state as the server just answered it (a load, a publish). */
  reset: (s: EditorState) => void;
  /** «حمّل الأحدث». */
  takeLatest: () => void;
  /** «احفظ نسختي»: save over the other window’s save. */
  keepMine: () => Promise<boolean>;
}

export function useDraftPersistence(opts: {
  state: EditorState | null;
  setState: (updater: (s: EditorState | null) => EditorState | null) => void;
  userId: string;
  storage: MirrorStorage | null;
  /** False while nothing is loaded, or the request cannot be edited. */
  enabled: boolean;
}): Persistence {
  const { state, setState, userId, storage, enabled } = opts;
  const [status, setStatus] = useState<SaveStatus>('clean');
  const [error, setError] = useState<unknown>(null);
  const [latest, setLatest] = useState<DraftShape | null>(null);
  const stateRef = useRef<EditorState | null>(state);
  stateRef.current = state;
  const statusRef = useRef<SaveStatus>(status);
  statusRef.current = status;
  const baseline = useRef<string>('');
  const inFlight = useRef<Promise<boolean> | null>(null);
  const again = useRef(false);
  const lastAutosaveAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mirrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const key = state ? bodyKey(state) : '';
  const dirty = !!state && !!baseline.current && key !== baseline.current;
  const edit = !!state && isPublishedEdit(state);

  const reset = useCallback(
    (s: EditorState) => {
      baseline.current = bodyKey(s);
      setStatus('clean');
      setError(null);
      setLatest(null);
      clearMirror(storage, userId, s.requestId);
    },
    [storage, userId]
  );

  const save = useCallback(
    async (kind: 'auto' | 'flush' | 'explicit' | 'force'): Promise<boolean> => {
      const s = stateRef.current;
      if (!s || !s.requestId || isPublishedEdit(s)) return false;
      if (statusRef.current === 'signedOut' || (statusRef.current === 'conflict' && kind !== 'force')) return false;
      if (inFlight.current) {
        again.current = true;
        return inFlight.current;
      }
      if (kind !== 'force' && bodyKey(s) === baseline.current) {
        if (statusRef.current === 'dirty' || statusRef.current === 'failed' || statusRef.current === 'offline') setStatus('saved');
        return true;
      }
      if (kind === 'auto') lastAutosaveAt.current = Date.now();
      const body = editorBody(s);
      const sent = sentShape(s);
      setStatus('saving');
      const run = (async () => {
        try {
          const { draft } = await editorApi.save(s.requestId, body, kind === 'force' ? undefined : s.updatedAt || undefined);
          baseline.current = bodyKey(adoptIds(s, sent, draft));
          // Onto the CURRENT state: an edit made while the save was on its way stays.
          setState((cur) => (cur && cur.requestId === s.requestId ? adoptIds(cur, sent, draft) : cur));
          const now = stateRef.current;
          const clean = !now || bodyKey(adoptIds(now, sent, draft)) === baseline.current;
          setError(null);
          setLatest(null);
          setStatus(clean ? 'saved' : 'dirty');
          if (clean) clearMirror(storage, userId, s.requestId);
          return true;
        } catch (e) {
          const next = statusOfError(e, typeof navigator === 'undefined' || navigator.onLine !== false);
          if (next === 'conflict') {
            const d = (e as ApiError).details?.draft as DraftShape | undefined;
            setLatest(d ?? null);
          }
          if (next === 'signedOut' || next === 'conflict') {
            const cur = stateRef.current;
            if (cur) writeMirror(storage, userId, cur);
          }
          setError(next === 'failed' ? e : null);
          setStatus(next);
          return false;
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = run;
      const ok = await run;
      if (again.current) {
        again.current = false;
        if (ok) return save('flush');
      }
      return ok;
    },
    [setState, storage, userId]
  );

  // Every change: the tab copy (300 ms), the status, and the next autosave.
  useEffect(() => {
    if (!enabled || !state) return;
    if (!baseline.current) baseline.current = key;
    const changed = key !== baseline.current;
    if (mirrorTimer.current) clearTimeout(mirrorTimer.current);
    if (changed) {
      mirrorTimer.current = setTimeout(() => {
        const cur = stateRef.current;
        if (cur) writeMirror(storage, userId, cur);
      }, MIRROR_DELAY_MS);
    }
    if (!changed) {
      // Typed back to what was saved: nothing is unsaved.
      if (statusRef.current === 'dirty') setStatus(edit ? 'clean' : 'saved');
      return;
    }
    if (statusRef.current === 'saved' || statusRef.current === 'clean') setStatus('dirty');
    if (edit || !state.requestId) return;
    if (statusRef.current === 'conflict' || statusRef.current === 'signedOut') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save('auto'), autosaveDelay(Date.now(), lastAutosaveAt.current));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, enabled, edit, state, storage, userId, save]);

  // Back online: what could not be saved is saved now.
  useEffect(() => {
    const online = () => {
      if (statusRef.current === 'offline' || statusRef.current === 'failed') void save('flush');
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [save]);

  // Leaving: the last words go as a keepalive request (a draft only), and the copy stays.
  const leave = useCallback(() => {
    const s = stateRef.current;
    if (!s || !s.requestId) return;
    if (bodyKey(s) === baseline.current) return;
    writeMirror(storage, userId, s);
    if (isPublishedEdit(s) || statusRef.current === 'signedOut' || statusRef.current === 'conflict') return;
    editorApi.saveOnLeave(s.requestId, editorBody(s));
  }, [storage, userId]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      // The editor unmounting is a way out too (Back, a link, the sign-in).
      leave();
    };
  }, [leave]);

  const flush = useCallback(() => save('flush'), [save]);
  const saveNow = useCallback(() => save('explicit'), [save]);
  const keepMine = useCallback(async () => {
    setStatus('dirty');
    statusRef.current = 'dirty';
    return save('force');
  }, [save]);
  const takeLatest = useCallback(() => {
    const d = latest;
    if (!d) return;
    const fresh = hydrate(d);
    setState(() => fresh);
    reset(fresh);
  }, [latest, setState, reset]);

  return { status, error, latest, dirty, saveNow, flush, reset, takeLatest, keepMine };
}
