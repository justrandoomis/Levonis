import { isSystemSlug, isValidSlugSyntax } from '../../../worker/lib/hosts';
import { sanitizeNextPath } from './nextPath';

/**
 * THE WAY BACK TO A SHOP after signing in on the apex.
 *
 * A shop (`<slug>.levonis-iq.com`) never signs anyone in on its own host:
 * Google accepts only the apex as an origin, so the shop's /auth hands the
 * visitor to `https://<apex>/auth?next=<path>&store=<slug>` (src/App.tsx
 * `StoreHostAuthHandoff`). The session cookie is scoped to the parent domain,
 * so after signing in the visitor can go straight back, already signed in.
 *
 * `store` arrives in the query and is therefore attacker-influenceable. It is
 * never a URL — only a slug that passes the platform's own slug rule and is
 * not a system name — and the host is BUILT here, as `<slug>.<apex host>`,
 * from `mainSite` (the server's own answer, https only). The path goes
 * through `sanitizeNextPath`. Anything else answers null and the caller
 * stays on the apex, so this can never become an open redirect.
 *
 * Its own module, not nextPath.ts: src/App.tsx imports `sanitizeNextPath`
 * into the entry chunk, and this one would bring the platform's host table
 * (worker/lib/hosts.ts) with it. Only the lazy sign-in page needs it.
 */
export function storeReturnUrl(slug: unknown, mainSite: string, path: unknown): string | null {
  if (typeof slug !== 'string' || !isValidSlugSyntax(slug) || isSystemSlug(slug)) return null;
  if (!mainSite) return null;
  let root: URL;
  try {
    root = new URL(mainSite);
  } catch {
    return null;
  }
  if (root.protocol !== 'https:' || root.username || root.password || root.port) return null;
  const host = root.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
  return `https://${slug}.${host}${sanitizeNextPath(path)}`;
}
