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

/** Remove remnants of old versions even when the browser opens signed out.
 * Cleanup is best effort when browser storage is disabled. Never restore it. */
export function purgeLegacyPrivateDrafts(): void {
  try { localStorage.removeItem('levonis-purchase-draft-v2'); } catch { /* unavailable */ }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('wage-preview:')) sessionStorage.removeItem(key);
    }
  } catch { /* unavailable */ }
}
