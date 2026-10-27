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
 * (worker/lib/hosts.ts) with it. Only lazy chunks need it: the sign-in page,
 * and the notification bell (a Print Cloud notice opens on cloud.<root>).
 */
export function storeReturnUrl(slug: unknown, mainSite: string, path: unknown): string | null {
  if (typeof slug !== 'string' || !isValidSlugSyntax(slug) || isSystemSlug(slug)) return null;
  const host = apexHost(mainSite);
  return host ? `https://${slug}.${host}${sanitizeNextPath(path)}` : null;
}

/**
 * The apex's bare host name from `mainSite` (the server's own answer), or null
 * when it is not a plain `https://<dns name>` — no credentials, no port, no
 * path tricks. The one place both returns below read it.
 */
function apexHost(mainSite: string): string | null {
  if (!mainSite) return null;
  let root: URL;
  try {
    root = new URL(mainSite);
  } catch {
    return null;
  }
  if (root.protocol !== 'https:' || root.username || root.password || root.port) return null;
  const host = root.hostname.toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/**
 * THE APPLICATIONS OF THE PLATFORM THAT SIGN IN ON THE APEX — an allowlist of
 * literal labels, each the system subdomain it lives on. Levonis Print Cloud
 * (`cloud.<root>`) cannot offer Google on its own host either, so it hands
 * sign-in to `https://<apex>/auth?next=<path>&app=cloud` (src/cloud/signInUrl.ts
 * `cloudHandoffUrl`). Nothing else may ever name a host to go back to.
 */
export const RETURN_APPS = ['cloud'] as const;
export type ReturnApp = (typeof RETURN_APPS)[number];

export function isReturnApp(app: unknown): app is ReturnApp {
  return typeof app === 'string' && (RETURN_APPS as readonly string[]).includes(app);
}

/**
 * THE WAY BACK TO A PLATFORM APPLICATION after signing in on the apex: only a
 * label of `RETURN_APPS` (a literal, compared exactly — never a host, never a
 * slug, never a URL), on the apex `mainSite` names, over https, with the path
 * through `sanitizeNextPath`. Anything else answers null and the caller stays
 * on the apex, so this can never become an open redirect either.
 */
export function appReturnUrl(app: unknown, mainSite: string, path: unknown): string | null {
  if (!isReturnApp(app)) return null;
  const host = apexHost(mainSite);
  return host ? `https://${app}.${host}${sanitizeNextPath(path)}` : null;
}
