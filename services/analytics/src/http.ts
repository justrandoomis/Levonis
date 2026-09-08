/**
 * `/api/v1/analytics/*` — the read surface (`01-TARGET.md` §9.2, §10 "API
 * versioning"). Response shapes are `packages/contracts/src/http/analytics.ts`
 * and nothing else.
 *
 * AUTHORISATION. Analytics is a leaf service: no cookie, no `sessions`, only a
 * principal signed by Identity (`01-TARGET.md` §3.4). The two `admin` routes
 * need `role:'admin'` on the apex; the merchant route needs a principal whose
 * `sub` owns the merchant — and since Analytics does not own the merchant
 * table, "owns" means what the platform can prove without asking: the
 * principal's own id, or a full-scope admin, who may read any. A merchant
 * dashboard served by Marketplace reaches the numbers over RPC instead, where
 * the hop allowlist applies.
 */
import { Hono } from 'hono';
import type {
  AnalyticsOverviewResponse,
  MerchantDailyResponse,
  PlatformDailyResponse,
} from '@levonis/contracts/http/analytics';
import type { ApiFailure } from '@levonis/contracts/http/common';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { verifyPrincipal, isAdmin, isFullAdmin } from '@levonis/platform-kit/principal';
import type { Principal } from '@levonis/contracts/rpc/common';
import { isKitError, forbidden, unauthorized, contractViolation } from '@levonis/platform-kit/errors';
import { healthReport, legacyHealthBody } from '@levonis/platform-kit/health';
import type { Logger } from '@levonis/platform-kit/log';
import { producerKeys } from './keys';
import { daily, merchantDaily, overview } from './read';
import { versionOf, type Env } from './env';

export const V1_PREFIX = '/api/v1/analytics';

/** Identity signs principals; until Phase 9 that is the core (`01-TARGET.md` §3.4). */
export const PRINCIPAL_ISSUERS = ['identity', 'core'];

export interface HttpDeps {
  log?: Logger;
}

const fail = (error: string, code: string): ApiFailure => ({ success: false, error, code });

async function principalOf(env: Env, headers: Headers, opts: { apexOnly: boolean }): Promise<Principal> {
  const header = headers.get(PRINCIPAL_HEADER);
  if (!header) throw unauthorized();
  const ring = await producerKeys(env);
  const v = await verifyPrincipal(header, ring, {
    nowSeconds: Math.floor(Date.now() / 1000),
    issuers: PRINCIPAL_ISSUERS,
    ...(opts.apexOnly ? { expectHostKind: 'main' as const } : {}),
  });
  if (!v.ok) throw unauthorized();
  return v.principal;
}

const errorResponse = (e: unknown) =>
  isKitError(e) ? { body: e.toBody(), status: e.status } : { body: fail('Authentication required', 'UNAUTHORIZED'), status: 401 };

const trimmed = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s ? s : undefined;
};

/** `YYYY-MM-DD` or nothing: a range is a filter, never free text reaching SQL. */
function day(v: string | undefined, label: string): string | undefined {
  const s = trimmed(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw contractViolation(`${label} must be YYYY-MM-DD`);
  return s;
}

export function createApp(deps: HttpDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  /**
   * `01-TARGET.md` §11.3's report — the same shape this service's `health()`
   * RPC returns — plus the legacy `{success, status, version}` fields, so
   * nothing that already reads them changes. `checks.db` is why: a `/health`
   * that never touches the database answers `ok` for a Worker whose tables are
   * all missing, and the dark twin's URL is the only probe plan 2.1 has.
   */
  app.get('/health', async (c) =>
    c.json({
      ...legacyHealthBody(versionOf(c.env)),
      ...(await healthReport({ svc: 'analytics', ver: versionOf(c.env), db: c.env.DB ?? null })),
    })
  );

  app.get(`${V1_PREFIX}/admin/overview`, async (c) => {
    try {
      const principal = await principalOf(c.env, c.req.raw.headers, { apexOnly: true });
      if (!isAdmin(principal)) throw forbidden('Administrator access required');
      const q = c.req.query();
      const range = { from: day(q.from, 'from'), to: day(q.to, 'to') };
      const body: AnalyticsOverviewResponse = { success: true, ...(await overview(c.env.DB, range)) };
      deps.log?.info('analytics.overview', { from: range.from ?? null, to: range.to ?? null });
      return c.json(body);
    } catch (e) {
      const { body, status } = errorResponse(e);
      return c.json(body, status as 400 | 401 | 403);
    }
  });

  app.get(`${V1_PREFIX}/admin/daily`, async (c) => {
    try {
      const principal = await principalOf(c.env, c.req.raw.headers, { apexOnly: true });
      if (!isAdmin(principal)) throw forbidden('Administrator access required');
      const q = c.req.query();
      const points = await daily(c.env.DB, { metric: trimmed(q.metric), from: day(q.from, 'from'), to: day(q.to, 'to') });
      const body: PlatformDailyResponse = { success: true, points };
      return c.json(body);
    } catch (e) {
      const { body, status } = errorResponse(e);
      return c.json(body, status as 400 | 401 | 403);
    }
  });

  app.get(`${V1_PREFIX}/merchant/daily`, async (c) => {
    try {
      // Not apex-only: a merchant reads its own numbers from its storefront
      // host, which is where the merchant dashboard lives
      // (`docs/SUBDOMAIN_ARCHITECTURE.md` §5).
      const principal = await principalOf(c.env, c.req.raw.headers, { apexOnly: false });
      const q = c.req.query();
      const merchantId = trimmed(q.merchant_id);
      if (!merchantId) throw contractViolation('merchant_id is required');
      // The only ownership Analytics can prove on its own is identity: the
      // principal's own id. Anything broader is a full-scope admin, or a
      // Marketplace RPC call where the hop allowlist is the check.
      if (!isFullAdmin(principal) && principal.sub !== merchantId) throw forbidden('Not allowed');
      const points = await merchantDaily(c.env.DB, merchantId, { metric: trimmed(q.metric), from: day(q.from, 'from'), to: day(q.to, 'to') });
      const body: MerchantDailyResponse = { success: true, merchant_id: merchantId, points };
      return c.json(body);
    } catch (e) {
      const { body, status } = errorResponse(e);
      return c.json(body, status as 400 | 401 | 403);
    }
  });

  app.all('*', (c) => c.json(fail('Not found', 'NOT_FOUND'), 404));
  return app;
}
