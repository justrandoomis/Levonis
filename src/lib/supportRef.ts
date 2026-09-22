/**
 * The browser-side pending support ref (integrated mandate §3.3).
 *
 * MOVED OUT OF `src/pages/Referrals.tsx`, VERBATIM, AND FOR ONE REASON: the
 * cart and the product page import these helpers, and a page that anything
 * eagerly imports cannot be code-split. Keeping them in the page file pinned
 * the whole /referrals screen — and everything it imports — into the entry
 * chunk, no matter how the route was declared (`tests/bundleBudget.test.ts`
 * caught exactly that).
 *
 * Nothing about the behaviour changes, and no import path breaks:
 * `src/pages/Referrals.tsx` re-exports every symbol below, so
 * `tests/supportCode.test.ts` and any other caller keep working unchanged.
 */

// ===========================================================================
// Browser-side pending support ref (§3.3)
// ===========================================================================
//
// WHY sessionStorage AND WHY IT EXPIRES: §3.2 requires the carry-over to be
// "limited in validity, announced and manageable — no unlimited retention or
// hidden tracking". sessionStorage dies with the tab, and every entry also
// carries its own capture time so a tab left open for days cannot silently
// attribute tomorrow's order to a link opened last week.
//
// WHY A DISMISSED LIST: §3.3 — "removing the support code is respected; do
// not re-add it from a cookie on every render. The user may add it again by
// their own decision." A removal is therefore recorded, and an automatic
// (link) capture never resurrects a ref the user removed. A MANUAL entry
// does, because that is the user's own decision.

export const SUPPORT_REF_KEY = 'levo_support_ref_v1';
/** Announced bound: a captured link stops applying after 12 hours. */
export const SUPPORT_REF_TTL_MS = 12 * 60 * 60 * 1000;
export const SUPPORT_REF_MAX = 60;

export type SupportRefSource = 'link' | 'manual';

export interface SupportRefEntry {
  ref: string;
  /** Capture instant (epoch ms) — the TTL is measured from here. */
  at: number;
  source: SupportRefSource;
  /** The product path the link came from, when it came from one. */
  product?: string;
}

export interface SupportRefState {
  /** The ref the cart will actually send at checkout (at most one). */
  current: SupportRefEntry | null;
  /**
   * A SECOND, different ref arrived while `current` stood. §3.3 forbids a
   * silent replacement: both are kept and the cart asks the user to choose.
   */
  conflict: SupportRefEntry | null;
  /** Refs the user removed — never auto-re-added. */
  dismissed: string[];
}

export interface RefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const EMPTY_STATE: SupportRefState = { current: null, conflict: null, dismissed: [] };

/**
 * Mirrors worker/lib/supportCode.ts normalizeSupportRef. The SERVER remains
 * the authority — the cart always resolves a ref through the API before it
 * shows a name — this only stops obviously unusable input from being stored.
 */
export function normalizeSupportRef(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const q = url.searchParams.get('ref');
      const seg = url.pathname.split('/').filter(Boolean).pop() ?? '';
      s = (q || seg || '').trim();
    } catch {
      return '';
    }
  }
  s = s.replace(/^@+/, '').trim();
  if (!s || s.length > SUPPORT_REF_MAX) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '';
  return s;
}

const sameRef = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** sessionStorage when it is usable (private mode / SSR / blocked → null). */
export function sessionStore(): RefStore | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function persist(state: SupportRefState, store: RefStore | null): SupportRefState {
  if (!store) return state;
  try {
    if (!state.current && !state.conflict && state.dismissed.length === 0) store.removeItem(SUPPORT_REF_KEY);
    else store.setItem(SUPPORT_REF_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked — the feature degrades to "no pending ref" */
  }
  return state;
}

function entryFrom(value: unknown, now: number): SupportRefEntry | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const ref = normalizeSupportRef(o.ref);
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  if (!ref || at <= 0) return null;
  if (now - at > SUPPORT_REF_TTL_MS) return null; // expiry-bounded, always
  return {
    ref,
    at,
    source: o.source === 'manual' ? 'manual' : 'link',
    ...(typeof o.product === 'string' && o.product ? { product: o.product } : {}),
  };
}

/** Reads the stored state, dropping anything expired or malformed. */
export function readSupportRefState(now: number = Date.now(), store: RefStore | null = sessionStore()): SupportRefState {
  if (!store) return { ...EMPTY_STATE };
  let raw: string | null = null;
  try {
    raw = store.getItem(SUPPORT_REF_KEY);
  } catch {
    return { ...EMPTY_STATE };
  }
  if (!raw) return { ...EMPTY_STATE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_STATE };
  }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const dismissed = Array.isArray(o.dismissed)
    ? o.dismissed.map((d) => normalizeSupportRef(d)).filter(Boolean).slice(0, 20)
    : [];
  return {
    current: entryFrom(o.current, now),
    conflict: entryFrom(o.conflict, now),
    dismissed,
  };
}

export interface CaptureOptions {
  source?: SupportRefSource;
  product?: string;
  now?: number;
  store?: RefStore | null;
}

/**
 * Record a support ref seen by the browser.
 *
 * - An automatic capture (a `?ref=` on a product link) NEVER overrides a ref
 *   the user already has, and never resurrects one they removed.
 * - A second, different automatic ref becomes a `conflict`: the cart asks
 *   which creator to support instead of swapping the beneficiary silently.
 * - A manual entry is the user's explicit decision, so it wins and clears
 *   both the conflict and any earlier removal of that same ref.
 */
export function captureSupportRef(rawRef: unknown, opts: CaptureOptions = {}): SupportRefState {
  const store = opts.store === undefined ? sessionStore() : opts.store;
  const now = opts.now ?? Date.now();
  const source: SupportRefSource = opts.source ?? 'link';
  const ref = normalizeSupportRef(rawRef);
  const state = readSupportRefState(now, store);
  if (!ref) return state;

  const entry: SupportRefEntry = {
    ref,
    at: now,
    source,
    ...(opts.product ? { product: opts.product } : {}),
  };

  if (source === 'manual') {
    const next: SupportRefState = {
      current: entry,
      conflict: null,
      dismissed: state.dismissed.filter((d) => !sameRef(d, ref)),
    };
    return persist(next, store);
  }

  if (state.dismissed.some((d) => sameRef(d, ref))) return state; // removal is respected
  if (!state.current) return persist({ ...state, current: entry, conflict: null }, store);
  if (sameRef(state.current.ref, ref)) {
    // Same creator, opened again: refresh the capture time, keep everything
    // else — this is not a new attribution.
    return persist({ ...state, current: { ...state.current, at: now, product: entry.product ?? state.current.product } }, store);
  }
  if (state.conflict && sameRef(state.conflict.ref, ref)) return state;
  return persist({ ...state, conflict: entry }, store);
}

/** Reads `?ref=` out of a location search string and captures it. */
export function captureSupportRefFromSearch(search: string, opts: CaptureOptions = {}): SupportRefState {
  let value = '';
  try {
    value = new URLSearchParams(search || '').get('ref') || '';
  } catch {
    value = '';
  }
  if (!value) return readSupportRefState(opts.now ?? Date.now(), opts.store === undefined ? sessionStore() : opts.store);
  return captureSupportRef(value, { ...opts, source: opts.source ?? 'link' });
}

/** Resolve a conflict by picking one of the two refs (§3.3: explicit choice). */
export function chooseSupportRef(rawRef: unknown, opts: CaptureOptions = {}): SupportRefState {
  const store = opts.store === undefined ? sessionStore() : opts.store;
  const now = opts.now ?? Date.now();
  const ref = normalizeSupportRef(rawRef);
  const state = readSupportRefState(now, store);
  if (!ref) return state;
  const picked =
    (state.current && sameRef(state.current.ref, ref) && state.current) ||
    (state.conflict && sameRef(state.conflict.ref, ref) && state.conflict) ||
    null;
  if (!picked) return state;
  return persist({ ...state, current: { ...picked, at: now }, conflict: null }, store);
}

/**
 * Remove the support code. The removal is REMEMBERED: the same ref arriving
 * again from a link is ignored, so no re-render, refresh or back-navigation
 * can push it back in.
 */
export function removeSupportRef(opts: { now?: number; store?: RefStore | null } = {}): SupportRefState {
  const store = opts.store === undefined ? sessionStore() : opts.store;
  const now = opts.now ?? Date.now();
  const state = readSupportRefState(now, store);
  const removed = [state.current?.ref, state.conflict?.ref].filter((r): r is string => !!r);
  const dismissed = [...state.dismissed];
  for (const r of removed) if (!dismissed.some((d) => sameRef(d, r))) dismissed.push(r);
  return persist({ current: null, conflict: null, dismissed: dismissed.slice(-20) }, store);
}

/**
 * Clear everything — including the dismissed list. For AFTER an order is
 * placed (the ref is frozen on the order server-side by then), never as a
 * way to get around a removal.
 */
export function clearSupportRef(opts: { store?: RefStore | null } = {}): void {
  const store = opts.store === undefined ? sessionStore() : opts.store;
  if (!store) return;
  try {
    store.removeItem(SUPPORT_REF_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * THE /auth URL TO SEND A VISITOR TO WITHOUT DROPPING THE REFERRAL.
 *
 * «الإحالة عند مشاركة المنتج مع مستخدم آخر لا تعمل». The share link is
 * correct (`productSupportPath` -> `/product/<slug>?ref=<handle>`) and the
 * product page captures the ref. What was lost was the trip through sign-in.
 *
 * A shared product page is opened by someone who usually does NOT have an
 * account — that is the point of sharing it. The first thing they do is tap
 * add-to-cart or the heart, and every one of those sent them to
 * `/auth?next=/product/<slug>`: no `ref`. §3 keeps two separate things here,
 * and that one URL broke both of them.
 *
 *   * THE SIGNUP INVITE (`referral_attributions`, bound exactly once at
 *     account creation) reads `?ref=` off /auth and nothing else. With the
 *     parameter gone, the account that the sharer brought in was recorded as
 *     having no inviter — permanently, because the binding happens once.
 *   * THE PURCHASE SUPPORT CODE survived only by luck: it lives in
 *     sessionStorage, which persists across a same-tab navigation. An
 *     email-first sign-up finishes in whatever tab the mail app opens, and
 *     there the storage — and the code — is gone.
 *
 * So the ref rides BOTH ways: as `?ref=` for the sign-up binding, and inside
 * `next` so the return trip re-captures it into a session that may be new.
 *
 * It is read from the CAPTURED state, never from the current URL: that state
 * is what already honours §3.3's rules — a removal is respected, and a
 * conflict is not silently resolved. A visitor who removed the code is sent
 * to a plain /auth, which is the whole point of having removed it.
 */
export function authPathWithSupportRef(
  next: string,
  opts: { store?: RefStore | null; now?: number } = {}
): string {
  const path = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const store = opts.store === undefined ? sessionStore() : opts.store;
  const state = readSupportRefState(opts.now ?? Date.now(), store);
  // Lowercased, like `productSupportPath` and `inviteLinkFor`: one canonical
  // spelling in URLs. The server resolves case-insensitively either way, and
  // /auth shows this value in an editable field, so it should read the same as
  // the link the sharer sent.
  const ref = (state.current?.ref ?? '').toLowerCase();
  if (!ref) return `/auth?next=${encodeURIComponent(path)}`;
  // `next` keeps its own query string: a product path may already carry one.
  const withRef = `${path}${path.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref)}`;
  return `/auth?next=${encodeURIComponent(withRef)}&ref=${encodeURIComponent(ref)}`;
}

/** The invite link for a handle. Origin is the live one, never hardcoded. */
export function inviteLinkFor(username: string, origin: string): string {
  const clean = normalizeSupportRef(username);
  if (!clean) return '';
  return `${origin.replace(/\/+$/, '')}/auth?ref=${encodeURIComponent(clean.toLowerCase())}`;
}

/** Appends the support ref to a REAL product path (never a guessed one). */
export function productShareLink(productPath: string, username: string, origin: string): string {
  const path = String(productPath || '').trim();
  if (!path.startsWith('/')) return '';
  const base = `${origin.replace(/\/+$/, '')}${path}`;
  const clean = normalizeSupportRef(username);
  if (!clean) return base;
  const [withoutHash, hash = ''] = base.split('#');
  const sep = withoutHash.includes('?') ? '&' : '?';
  return `${withoutHash}${sep}ref=${encodeURIComponent(clean.toLowerCase())}${hash ? `#${hash}` : ''}`;
}
