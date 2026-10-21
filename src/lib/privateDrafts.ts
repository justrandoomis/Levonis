/** Owner drafts live only in this tab's memory. Server-saved purchase drafts
 * remain durable; incomplete form edits must never leave supplier costs on a
 * shared device. AuthContext clears this store on every identity change and
 * whenever cost access is unavailable. */
const drafts = new Map<string, string>();
export const privateDrafts = {
  getItem: (key: string): string | null => drafts.get(key) ?? null,
  setItem: (key: string, value: string): void => { drafts.set(key, value); },
  removeItem: (key: string): void => { drafts.delete(key); },
  clear: (): void => drafts.clear(),
};

/** The request editor’s tab copies of unsaved text, in sessionStorage under
 * `<this><userId>.<requestId or new>` (requests/editor/sessionMirror.ts).
 * They belong to one account: AuthContext forgets them all on a sign-out and
 * every other account’s when an account signs in — never the copies of the
 * account a reload finds still signed in. */
export const REQUEST_EDITOR_COPIES = 'levonis.request-editor.';

/** Remove this tab’s sessionStorage entries whose key starts with `prefix`,
 * except those that start with `keep`. Best effort when storage is disabled. */
export function forgetTabEntries(prefix: string, keep?: string, storage?: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  try {
    const s = storage ?? sessionStorage;
    for (let i = s.length - 1; i >= 0; i--) {
      const key = s.key(i);
      if (key?.startsWith(prefix) && !(keep && key.startsWith(keep))) s.removeItem(key);
    }
  } catch { /* unavailable */ }
}

/** Remove remnants of old versions even when the browser opens signed out.
 * Cleanup is best effort when browser storage is disabled. Never restore it. */
export function purgeLegacyPrivateDrafts(): void {
  try { localStorage.removeItem('levonis-purchase-draft-v2'); } catch { /* unavailable */ }
  forgetTabEntries('wage-preview:');
}
