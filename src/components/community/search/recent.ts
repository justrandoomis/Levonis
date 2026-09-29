/**
 * WHAT THIS BROWSER SEARCHED FOR — and nothing more than that.
 *
 * The community keeps no search log and tracks no query on the server
 * (docs/COMMUNITY_ECOSYSTEM.md §9.3: «no invasive tracking»). The overlay's
 * «عمليات بحث أخيرة» are the BROWSER's memory alone, on the pattern of
 * src/lib/recentlyViewed.ts: a versioned `localStorage` key, a short list,
 * never sent anywhere, cleared by a button.
 *
 * WHAT IS STORED IS ONLY THE TERM AND WHEN. No account id, no tab, no result
 * counts. A term that looks like an email address or a phone number is not
 * remembered at all — the box is also where a person types a friend's name
 * or their own number by mistake, and a shared device must not repeat it.
 */

export const RECENT_KEY = 'levonis.communityRecent.v1';
/** Enough to be useful, short enough to stay a hint rather than a record. */
export const RECENT_MAX = 10;
const TERM_MAX = 60;

export interface RecentTerm {
  term: string;
  /** When it was last searched, ms since the epoch — the list's order. */
  at: number;
}

const EMAIL = /@/;
/** Seven or more digits (Latin or Arabic-Indic) in a term: a phone, not a search. */
const PHONE = /(?:[0-9٠-٩۰-۹][\s\-().]*){7,}/;

/** True for a term the list may hold: 2–60 characters, no email, no phone. */
export function storableTerm(raw: string): string | null {
  const term = raw.trim().replace(/\s+/g, ' ').slice(0, TERM_MAX);
  if (term.length < 2) return null;
  if (EMAIL.test(term) || PHONE.test(term)) return null;
  return term;
}

/**
 * Every read and write is wrapped: `localStorage` throws in a private window
 * on some browsers, and in an iframe with third-party storage blocked. A box
 * that cannot remember must still open.
 */
export function readRecent(): RecentTerm[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentTerm[] = [];
    for (const v of parsed) {
      if (!v || typeof v !== 'object') continue;
      const term = storableTerm(String((v as RecentTerm).term ?? ''));
      const at = Number((v as RecentTerm).at);
      if (term && Number.isFinite(at) && !out.some((r) => r.term === term)) out.push({ term, at });
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function write(list: RecentTerm[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(RECENT_KEY);
    else localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX).map(({ term, at }) => ({ term, at }))));
  } catch {
    /* a browser that will not remember is not an error */
  }
}

/** Records a term, newest first, with no duplicates. Never throws. */
export function rememberRecent(raw: string, now = Date.now()): void {
  const term = storableTerm(raw);
  if (!term) return;
  write([{ term, at: now }, ...readRecent().filter((r) => r.term !== term)]);
}

/** Forgets one term. */
export function forgetRecent(term: string): void {
  write(readRecent().filter((r) => r.term !== term));
}

/** The button: forgets them all. */
export function clearRecent(): void {
  write([]);
}
