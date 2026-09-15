/**
 * Byte-identical copies of the three edge middlewares of `worker/lib/http.ts`
 * (`originCheck`, `securityHeaders`, `requireMainHost`) — `tests/edgeParity.test.ts`
 * compares each function's source text with the core's until Phase 3.3 turns
 * the core's files into re-exports of this module. Only the imports differ.
 */
import type { Context, Next } from 'hono';
import { adminAllowedOn } from './hosts';
import { STATIC_SECURITY_HEADERS, STRICT_TRANSPORT_SECURITY, spaCsp } from './securityPolicy';
import type { AppContext } from './types';
import { forbidden } from '../errors';

/**
 * CSRF / origin protection for state-changing requests: browsers always send
 * Origin on cross-site POSTs; we reject any mutating request whose Origin is
 * present and not in the allowed set. Session cookies are additionally
 * SameSite=Lax.
 */
export function originCheck() {
  return async (c: Context<AppContext>, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = c.req.header('Origin');
      if (origin) {
        const self = new URL(c.req.url).origin;
        const extra = (c.env.EXTRA_ALLOWED_ORIGINS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (origin !== self && !extra.includes(origin)) {
          throw forbidden('Cross-origin request rejected');
        }
      }
    }
    await next();
  };
}

export function securityHeaders() {
  return async (c: Context<AppContext>, next: Next) => {
    await next();
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) c.header(name, value);
    c.header('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    // The SPA policy, unless the route already chose one: the print documents
    // (asDocument) and the R2 file sandbox set their own. See securityPolicy.ts
    // — and note the asset layer serves most of the pages themselves, from
    // dist/_headers. The product paths are the exception (run_worker_first, so
    // a shared link carries the product's own card); they arrive here already
    // carrying that file's policy, which is why this must not overwrite one.
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', spaCsp());
    }
  };
}

/**
 * Refuses a route on every host but the platform's own — the guard that makes
 * wildcard merchant subdomains survivable (hosts.ts §53). Used for global
 * administration and for changing a signed-in account's credentials: the
 * session cookie is scoped to the parent domain, so a page on a merchant host
 * carries the visitor's session, and nothing those pages do needs either.
 *
 * 404, not 403: a wrong-host caller learns the route does not exist here
 * rather than that it exists elsewhere.
 */
export async function requireMainHost(c: Context<AppContext>, next: Next) {
  if (!adminAllowedOn(c.get('host'))) return c.json({ success: false, error: 'Not found' }, 404);
  await next();
}
