/**
 * THE SHOPPER'S OWN LAST SEARCHES, ON THIS DEVICE ONLY (smart search, owner
 * 2026-11-18). Focusing the empty field lists them (./LiveSearch.tsx), so
 * «A1 nozzle» typed yesterday is one tap today. They never leave the browser:
 * no request carries them, and the trends table counts chosen PRODUCTS, never
 * typed text (worker/routes/searchTrending.ts). Storage that throws (a private
 * window, blocked site data) just means no list.
 */
const KEY = 'lv-recent-searches';
export const RECENT_MAX = 6;

export function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function addRecent(text: string): void {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (t.length < 2) return;
  try {
    const next = [t, ...readRecent().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* no storage, no list */
  }
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
