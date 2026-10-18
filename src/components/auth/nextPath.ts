/**
 * Post-auth return-destination sanitizer.
 *
 * Auth.tsx sends the user back to where they came from — either
 * `location.state.from` (set by a ProtectedRoute redirect) or a `?next=`
 * query param. Both are attacker-influenceable, so only same-origin
 * RELATIVE paths survive:
 *
 * - must be a string (or a {pathname, search, hash} location-like object)
 * - must start with exactly one "/" — "//host" is protocol-relative and
 *   would be an open redirect
 * - backslashes are rejected entirely (browsers normalize "\" to "/",
 *   so "/\evil.com" would become "//evil.com")
 * - control characters and absurd lengths are rejected
 * - "/auth" itself falls back to "/" so a bad link can never bounce the
 *   user straight back into the auth screen
 *
 * Anything that fails a check falls back to "/" — never throws.
 */

const MAX_LEN = 1024;

export function sanitizeNextPath(raw: unknown): string {
  let candidate = '';

  if (typeof raw === 'string') {
    candidate = raw;
  } else if (raw && typeof raw === 'object') {
    // Location-like object, e.g. react-router's location passed as state.from.
    const loc = raw as { pathname?: unknown; search?: unknown; hash?: unknown };
    if (typeof loc.pathname === 'string') {
      candidate =
        loc.pathname +
        (typeof loc.search === 'string' ? loc.search : '') +
        (typeof loc.hash === 'string' ? loc.hash : '');
    }
  }

  candidate = candidate.trim();
  if (!candidate || candidate.length > MAX_LEN) return '/';
  if (!candidate.startsWith('/')) return '/'; // also rejects "http(s)://", "javascript:", "mailto:", …
  if (candidate.startsWith('//')) return '/'; // protocol-relative URL
  if (candidate.includes('\\')) return '/'; // backslash normalization tricks
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '/';

  const pathOnly = candidate.split(/[?#]/, 1)[0];
  if (pathOnly === '/auth' || pathOnly.startsWith('/auth/')) return '/';

  return candidate;
}

/**
 * Where a shop's /auth sends the visitor: the apex's /auth (src/App.tsx
 * `StoreHostAuthHandoff`). Everything else the link carried (a referral code,
 * …) travels as it came; `next` is sanitized here, `store` is only ever the
 * slug the SERVER resolved for this host, and `lang` only a language the
 * reader CHOSE on the shop (src/LanguageContext.tsx `chosenLang`) — a first
 * visit's default must not overwrite the apex's own stored choice. Without a
 * `lang` the apex simply keeps what it has.
 */
export function storeHandoffUrl(
  mainSite: string,
  search: string,
  from: unknown,
  slug: string,
  chosenLang: string | null
): string {
  const q = new URLSearchParams(search);
  q.set('next', sanitizeNextPath(from ?? q.get('next') ?? '/'));
  q.delete('store');
  if (slug) q.set('store', slug);
  q.delete('lang');
  if (chosenLang === 'ar' || chosenLang === 'en' || chosenLang === 'ckb') q.set('lang', chosenLang);
  return `${mainSite}/auth?${q.toString()}`;
}
