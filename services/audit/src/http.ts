/**
 * `/api/v1/audit/admin/*` — the read surface (`01-TARGET.md` row 20, §10 "API
 * versioning"). Two routes, both `admin:full`, whose response shapes are
 * `packages/contracts/src/http/audit.ts` and nothing else.
 *
 * AUTHORISATION. Audit is a leaf service: it owns no `sessions`, never sees a
 * cookie, and from its first request accepts only a principal signed by
 * Identity (`01-TARGET.md` §3.4, and the leaf rule at the end of that section).
 * No principal, an expired one, or one this service cannot verify → 401; a
 * principal that is not a full-scope admin → 403. The gateway enforces the same
 * thing one hop earlier; this check is the authority (§4 item 6).
 *
 * The response envelope is the platform's (`§3.10`): `{success:true, …}` or
 * `{success:false, error, code}`.
 */
import { Hono } from 'hono';
import type { AuditEventsResponse, AuditVerifyResponse } from '@levonis/contracts/http/audit';
import type { ApiFailure } from '@levonis/contracts/http/common';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { verifyPrincipal, isFullAdmin } from '@levonis/platform-kit/principal';
import { isKitError, forbidden, unauthorized } from '@levonis/platform-kit/errors';
import { healthReport, legacyHealthBody } from '@levonis/platform-kit/health';
import type { Logger } from '@levonis/platform-kit/log';
import { producerKeys } from './keys';
import { queryEntries, QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX } from './store';
import { verifyChain } from './seal';
import { versionOf, verifyPageSize, verifyMaxRows, type Env } from './env';

export const V1_PREFIX = '/api/v1/audit';

export interface HttpDeps {
  log?: Logger;
}

const fail = (error: string, code: string): ApiFailure => ({ success: false, error, code });

/**
 * The services whose keys may sign a principal: Identity, which is the core's
 * `IdentityEntrypoint` until Phase 9 (`01-TARGET.md` §3.4 "Strangler mode").
 */
export const PRINCIPAL_ISSUERS = ['identity', 'core'];

/**
 * Every admin route runs this first. Returns the verified principal or throws a
 * KitError. `expectHostKind: 'main'` is the service's own copy of the
 * apex-only rule for admin surfaces (§3.5): the gateway 404s these paths on a
 * merchant host, and a principal minted on one is refused here as well.
 */
async function requireFullAdmin(env: Env, headers: Headers) {
  const header = headers.get(PRINCIPAL_HEADER);
  if (!header) throw unauthorized();
  const ring = await producerKeys(env);
  const v = await verifyPrincipal(header, ring, {
    nowSeconds: Math.floor(Date.now() / 1000),
    issuers: PRINCIPAL_ISSUERS,
    expectHostKind: 'main',
  });
  if (!v.ok) throw unauthorized();
  if (!isFullAdmin(v.principal)) throw forbidden('Administrator access required');
  return v.principal;
}

const trimmed = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s ? s : undefined;
};

export function createApp(deps: HttpDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  /**
   * The dark twin's own health URL (plan 2.1's gate). Never authenticated: a
   * probe that cannot reach a broken Worker is not a probe.
   *
   * The body is `01-TARGET.md` §11.3's report — `{ok, svc, ver, checks}`, the
   * same shape this service's `health()` RPC returns — PLUS the legacy
   * `{success, status, version}` fields, so nothing that already reads them
   * changes. `checks.db` is the part that matters: `legacyHealthBody` alone
   * says `ok` on a Worker whose database is missing every table, which is the
   * exact failure `scripts/dev-stack.mjs` exists to stop hiding, and it is
   * what `scripts/probe-health.mjs` reports for the other consumers.
   */
  app.get('/health', async (c) =>
    c.json({
      ...legacyHealthBody(versionOf(c.env)),
      ...(await healthReport({ svc: 'audit', ver: versionOf(c.env), db: c.env.DB ?? null })),
    })
  );

  app.get(`${V1_PREFIX}/admin/events`, async (c) => {
    try {
      await requireFullAdmin(c.env, c.req.raw.headers);
    } catch (e) {
      return isKitError(e) ? c.json(e.toBody(), e.status as 401 | 403) : c.json(fail('Authentication required', 'UNAUTHORIZED'), 401);
    }
    const q = c.req.query();
    const limit = Number.parseInt(q.limit ?? '', 10);
    const cursor = Number.parseInt(q.cursor ?? '', 10);
    const { rows, next } = await queryEntries(c.env.DB, {
      actor_id: trimmed(q.actor_id),
      action: trimmed(q.action),
      target: trimmed(q.target),
      from: trimmed(q.from),
      to: trimmed(q.to),
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, QUERY_LIMIT_MAX) : QUERY_LIMIT_DEFAULT,
      cursor: Number.isFinite(cursor) && cursor > 0 ? cursor : null,
    });
    deps.log?.info('audit.query', { rows: rows.length });
    const body: AuditEventsResponse = { success: true, rows, next };
    return c.json(body);
  });

  app.get(`${V1_PREFIX}/admin/verify`, async (c) => {
    try {
      await requireFullAdmin(c.env, c.req.raw.headers);
    } catch (e) {
      return isKitError(e) ? c.json(e.toBody(), e.status as 401 | 403) : c.json(fail('Authentication required', 'UNAUTHORIZED'), 401);
    }
    const res = await verifyChain(c.env.DB, { chainKey: c.env.AUDIT_CHAIN_KEY, pageSize: verifyPageSize(c.env), maxRows: verifyMaxRows(c.env) });
    const body: AuditVerifyResponse = {
      success: true,
      ok: res.ok,
      checked: res.checked,
      head: res.head,
      anchored_head: res.anchored_head,
      ...(res.broken_at === undefined ? {} : { broken_at: res.broken_at }),
    };
    if (!res.ok) deps.log?.error('audit.chain_broken', { checked: res.checked, broken_at: res.broken_at ?? null });
    return c.json(body);
  });

  app.all('*', (c) => c.json(fail('Not found', 'NOT_FOUND'), 404));
  return app;
}
