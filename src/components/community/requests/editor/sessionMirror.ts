/**
 * THE EDITOR’S TAB COPY (plan P1-06, row 268; design critique 1, 2, 4, 8).
 *
 * What the customer changed and the server does not have yet lives in this
 * tab’s sessionStorage, so a reload, a session that ran out, a lost
 * connection or a tap on Back loses nothing:
 *
 *   key   levonis.request-editor.<userId>.<requestId>   (`.new` before the
 *         draft exists — the first keystroke creates it, and the copy moves)
 *   body  { v, user, request, base, saved_at, state }
 *
 * `base` is what the copy was made on top of: the draft’s `updated_at`, or
 * for a published request `rev:<revision>` (an edit there has no autosave —
 * the whole state is kept until «احفظ التعديلات»). The copy is applied only
 * when its account AND its base are the ones the server answers now; a copy
 * made on an older version is dropped rather than laid over a newer one.
 *
 * On load the copies of any OTHER account in this tab are dropped
 * (`dropOtherAccounts`); the app shell forgets them all on a sign-out and
 * the other accounts’ when an account signs in (src/AuthContext.tsx). Every
 * storage access is guarded: a storage that refuses only costs the copy.
 */
import { REQUEST_EDITOR_COPIES, forgetTabEntries } from '../../../../lib/privateDrafts';
import { deserialise, serialise, type EditorState } from './state';

export type MirrorStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>;

export interface MirrorEntry {
  v: 1;
  user: string;
  request: string;
  base: string;
  saved_at: number;
  state: EditorState;
}

export function defaultMirrorStorage(): MirrorStorage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export const mirrorKey = (userId: string, requestId: string) => `${REQUEST_EDITOR_COPIES}${userId}.${requestId || 'new'}`;

/** What a copy is made on top of: the draft’s save stamp, or a published request’s revision. */
export function mirrorBase(s: Pick<EditorState, 'requestState' | 'updatedAt' | 'revision'>): string {
  return s.requestState === 'draft' || !s.requestState ? `at:${s.updatedAt}` : `rev:${s.revision}`;
}

export function writeMirror(storage: MirrorStorage | null, userId: string, s: EditorState): void {
  if (!storage || !userId) return;
  const entry: MirrorEntry = { v: 1, user: userId, request: s.requestId, base: mirrorBase(s), saved_at: Date.now(), state: s };
  try {
    storage.setItem(mirrorKey(userId, s.requestId), JSON.stringify({ ...entry, state: JSON.parse(serialise(s)) }));
  } catch {
    // a full or blocked storage only costs the copy
  }
}

/** The copy for this account and request, made on top of `base` — or null. */
export function readMirror(storage: MirrorStorage | null, userId: string, requestId: string, base: string | null): EditorState | null {
  if (!storage || !userId) return null;
  try {
    const raw = storage.getItem(mirrorKey(userId, requestId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<MirrorEntry> | null;
    if (!v || v.v !== 1 || v.user !== userId || v.request !== requestId) return null;
    if (base !== null && v.base !== base) return null;
    const state = deserialise(JSON.stringify(v.state));
    return state && state.requestId === requestId ? state : null;
  } catch {
    return null;
  }
}

export function clearMirror(storage: MirrorStorage | null, userId: string, requestId: string): void {
  if (!storage || !userId) return;
  try {
    storage.removeItem(mirrorKey(userId, requestId));
  } catch {
    // ignored: see writeMirror
  }
}

/** The copies of every other account in this tab go; this account’s stay. */
export function dropOtherAccounts(storage: MirrorStorage | null, userId: string): void {
  if (!userId || !storage) return;
  forgetTabEntries(REQUEST_EDITOR_COPIES, `${REQUEST_EDITOR_COPIES}${userId}.`, storage);
}

/** The `.new` copy becomes the draft’s own once the draft exists. */
export function moveNewMirror(storage: MirrorStorage | null, userId: string, s: EditorState): void {
  clearMirror(storage, userId, '');
  writeMirror(storage, userId, s);
}
