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
