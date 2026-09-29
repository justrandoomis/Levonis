/**
 * ONE ORIGIN FOR THE APP — `www.` MOVES TO THE APEX.
 *
 * `www.levonis-iq.com` served the whole application (200, no redirect), while
 * Google's Authorized JavaScript origins name the apex. A sign-in begun on
 * `www` ended in Google's `origin_mismatch` — «The given origin is not allowed
 * for the given client ID», the button never usable (live diagnosis,
 * 2026-09-29; docs/GOOGLE_SIGNIN_FIX.md §8). Moving the visitor to the apex,
 * path, query and fragment kept, is the fix that needs no second origin in the
 * Google console, splits no search ranking between two hosts and keeps one
 * local storage per customer.
 *
 * Only `www.` is moved: merchant subdomains are shops of their own and never
 * begin a sign-in (they send the visitor to the apex's /auth).
 *
 * The Worker answers the same question with a 301 for the documents it serves
 * first (worker/lib/hosts.ts `apexRedirectFor`); this covers every page the
 * asset layer answers without the Worker, /auth among them.
 */
export function apexUrlFor(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/^www\./i.test(url.hostname) || url.hostname.length <= 4) return null;
  url.hostname = url.hostname.slice(4);
  return url.toString();
}
