/**
 * ONE ORIGIN FOR THE APP — `https://`, and `www.` MOVES TO THE APEX.
 *
 * `www.levonis-iq.com` served the whole application (200, no redirect), while
 * Google's Authorized JavaScript origins name the apex: a sign-in begun on
 * `www` ended in Google's `origin_mismatch` — «The given origin is not allowed
 * for the given client ID», the button never usable (live diagnosis,
 * 2026-09-29; docs/GOOGLE_SIGNIN_FIX.md §8). Moving the visitor to the apex,
 * path, query and fragment kept, is the fix that needs no second origin in the
 * Google console, splits no search ranking between two hosts and keeps one
 * local storage per customer.
 *
 * PLAIN HTTP MOVES TO HTTPS TOO (sign-in fix, 2026-10-18). `http://` pages
 * were served as they came: Google refuses that origin, and the session
 * cookie is `Secure`, so a sign-in on http left the browser a guest on the
 * very next page. Every non-local `http:` page is moved to `https:` before
 * anything renders. Local development (localhost, `*.localhost`, `*.local`,
 * the reserved `*.test`, `*.example` and `*.invalid`, IP literals — the same
 * rule as worker/lib/hosts.ts `isLocalHostname`) is left on http.
 *
 * Only `www.` changes host: merchant subdomains are shops of their own and
 * never begin a sign-in — a shop's /auth hands the visitor to the apex's
 * /auth and comes back afterwards (src/App.tsx `StoreHostAuthHandoff`).
 *
 * The Worker answers the same question with a 301 for the documents it serves
 * first (worker/lib/hosts.ts `httpsUpgradeFor`, `apexRedirectFor`); this
 * covers every page the asset layer answers without the Worker, /auth among
 * them. Returns the address to move to, or null to stay.
 */
export function apexUrlFor(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let moved = false;
  if (/^www\./i.test(url.hostname) && url.hostname.length > 4) {
    url.hostname = url.hostname.slice(4);
    moved = true;
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    url.protocol = 'https:';
    moved = true;
  }
  return moved ? url.toString() : null;
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.test', '.example', '.invalid'];

/** Kept in step with worker/lib/hosts.ts `isLocalHostname` (tests/canonicalHost.test.ts
 *  compares them); not imported, so the entry carries none of the host table.
 *  The reserved names of RFC 2606/6761 (`.test`, `.example`, `.invalid`,
 *  `.localhost`) count too: the subdomain recipe runs on levonis.test:8787. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost') return true;
  if (LOCAL_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  if (h.startsWith('[')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);
}
