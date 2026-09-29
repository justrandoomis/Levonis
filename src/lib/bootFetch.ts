/**
 * THE TWO ANSWERS EVERY FIRST PAINT WAITS FOR, STARTED BEFORE REACT EXISTS.
 *
 * Measured in the lab (docs/PERFORMANCE_LOG.md «P2b»): the app rendered
 * nothing but the route fallback until `GET /api/storefront/resolve` came
 * back, and that request left only after every chunk was parsed, React had
 * mounted and `StoreProvider`'s effect had run — ≈2.0 s into a Slow-4G visit,
 * one whole round trip after the code was already in the browser. `/api/home`
 * left later still, from `Home`'s own effect. Neither depends on anything
 * React computes, so both can leave the moment this module evaluates, and
 * overlap the parse and the mount instead of following them.
 *
 * TWO SOURCES, IN ORDER OF COST:
 *
 *   1. THE DOCUMENT ITSELF. For the pages the Worker already rewrites for a
 *      share card (a store's home, a product page — worker/index.ts
 *      `assetWithPreview`), the server puts the resolve answer INTO the
 *      document as `<script type="application/json" id="lv-resolve">`. It is
 *      the anonymous answer — the same bytes `/api/storefront/resolve` gives a
 *      visitor with no session — so it can be read synchronously by anyone
 *      and no request is made at all. A data block of that type is never
 *      executed, so the CSP's script allowance is untouched.
 *   2. A REQUEST STARTED HERE, at module evaluation, when the document
 *      carries no answer: `/api/storefront/resolve` always, and `/api/home`
 *      on `/` unless the document says this host is a store (a store's `/`
 *      is its own home and never reads `/api/home`).
 *
 * The consumers (`src/StoreContext.tsx`, `src/pages/Home.tsx`) take the
 * primed response ONCE with `takePrimed` and settle it through `settleJson`,
 * which mirrors `src/lib/api.ts` exactly: the same deadline, the same
 * `ApiError` shape (status, code, details, the whole body) for every refusal
 * the callers already branch on (`STORE_MOVED`, `STORE_UNAVAILABLE`, a 404),
 * the same mascot feedback. A retry, or any later call, goes through `api.get`
 * as before — nothing here caches an answer; a primed request is a request
 * that simply started earlier.
 *
 * NOTHING HERE MAY BREAK A PAGE LOAD: a malformed data block reads as absent,
 * a failed primed request rejects only in the hands of the consumer that took
 * it (the promise is settled quietly otherwise), and without a `window` (the
 * unit tests, a server render) the module does nothing.
 */
import { ApiError, DEFAULT_TIMEOUT_MS } from './api';
import { beginRequestFeedback } from './mascotRequest';

export const RESOLVE_PATH = '/api/storefront/resolve';
export const HOME_PATH = '/api/home';
/** The id of the data block `worker/index.ts` writes into a rewritten document. */
export const INLINE_RESOLVE_ID = 'lv-resolve';

const primed = new Map<string, Promise<Response>>();

/** The JSON of a `<script type="application/json" id=…>` data block, or null when absent or unreadable. */
export function readInlineJson<T>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(id);
  if (!el || el.tagName !== 'SCRIPT' || (el as HTMLScriptElement).type !== 'application/json') return null;
  try {
    const text = (el.textContent || '').trim();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Start a GET now, once per path, with the API client's own deadline. */
export function primeGet(path: string): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function' || primed.has(path)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const started = fetch(path, { credentials: 'same-origin', signal: controller.signal }).finally(() => clearTimeout(timer));
  // A primed request nobody takes must not surface as an unhandled rejection.
  started.catch(() => undefined);
  primed.set(path, started);
}

/** The primed response for `path`, handed out once; null when none was started (or it was already taken). */
export function takePrimed(path: string): Promise<Response> | null {
  const started = primed.get(path) ?? null;
  primed.delete(path);
  return started;
}

/**
 * Settle a primed response the way `api.get` would have: JSON in, `ApiError`
 * out for every non-2xx or `success:false` body, a network failure for an
 * aborted or unreachable request, and the mascot's request feedback around it.
 */
export async function settleJson<T>(path: string, response: Promise<Response>): Promise<T> {
  const feedback = beginRequestFeedback('GET', path);
  try {
    let res: Response;
    try {
      res = await response;
    } catch {
      throw new ApiError(0, 'Network error — check your connection and try again');
    }
    let data: { success?: boolean; error?: string; code?: string; details?: Record<string, unknown> } & T;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(res.status, res.ok ? 'Invalid server response' : `Server error (${res.status})`);
    }
    if (!res.ok || data.success === false) {
      throw new ApiError(
        res.status,
        data.error || `Server error (${res.status})`,
        data.code,
        data.details,
        data as unknown as Record<string, unknown>
      );
    }
    feedback.finish();
    return data;
  } catch (error) {
    feedback.finish(error instanceof ApiError ? error : { status: 0 });
    throw error;
  }
}

/**
 * What to start for this page: the resolve answer unless the document carries
 * it, and `/api/home` for the platform's own front page. Exported for the
 * tests; called once below when a window exists.
 */
export function bootRequests(
  pathname: string,
  inline: { kind?: unknown } | null,
  start: (path: string) => void = primeGet
): string[] {
  const started: string[] = [];
  if (!inline) started.push(RESOLVE_PATH);
  if (pathname === '/' && (!inline || inline.kind !== 'merchant')) started.push(HOME_PATH);
  for (const path of started) start(path);
  return started;
}

if (typeof window !== 'undefined') {
  try {
    bootRequests(window.location.pathname, readInlineJson<{ kind?: unknown }>(INLINE_RESOLVE_ID));
  } catch {
    // Nothing here may break a page load.
  }
}
