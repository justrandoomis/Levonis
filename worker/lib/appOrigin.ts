/**
 * The origin every absolute link is built from — password resets, email
 * verification, invoice links, Telegram deep links, the Studio handoff.
 *
 * ONE PLACE, because these links carry tokens. `APP_ORIGIN` is configuration
 * and is never derived from the request in a deployed environment: a spoofed
 * `Host` header must not be able to point a reset link at an attacker.
 *
 * WILDCARD SUBDOMAINS OPENED A DOOR IN THE FALLBACK THAT DID NOT EXIST WHEN
 * THAT RULE WAS WRITTEN.
 *
 * `auth.ts` and `studio.ts` each had their own copy of this, and both fell
 * back to `new URL(c.req.url).origin` when APP_ORIGIN was empty — "only for
 * local dev". That was true when every request arrived on one hostname. Now
 * a request can legitimately arrive on `ali3d.levonis-iq.com`, a host whose
 * *content is controlled by a merchant*. A password-reset link built from
 * that origin sends the customer's token to a page the merchant controls.
 *
 * No spoofing required. Just a customer who clicked "forgot password" while
 * browsing a shop.
 *
 * So the fallback is now bounded by the same host classification everything
 * else uses:
 *
 *   APP_ORIGIN set                  → use it. Always. This is the deployed case.
 *   unset, host is `main`           → the request origin (the apex; local dev)
 *   unset, host outside the root    → the request origin (localhost, workers.dev)
 *   unset, host is merchant/system  → the ROOT DOMAIN, never the request host
 *   unset and nothing else works    → the request origin, as the last resort
 *
 * The fourth line is the fix. The fifth exists because a link that goes
 * nowhere helps nobody, and by then the deployment is misconfigured in a way
 * the deploy workflow already warns about loudly.
 */
import type { Context } from 'hono';
import type { AppContext } from './types';
import { classifyHost, rootDomainFrom } from './hosts';

export function trustedOrigin(c: Context<AppContext>): string {
  const configured = (c.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const requestOrigin = new URL(c.req.url).origin;
  const root = rootDomainFrom(c.env);
  if (!root) return requestOrigin;

  const host = classifyHost(c.req.header('Host'), root);
  if (host.kind === 'main') return requestOrigin;
  // Outside the platform's domain entirely — localhost, a preview URL, a
  // workers.dev deployment. No merchant is served there.
  if (!host.underRoot) return requestOrigin;

  // A merchant or system host, with no configured origin. Anything token
  // -bearing must leave through the apex.
  return `https://${root}`;
}
