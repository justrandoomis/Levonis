/**
 * `/api/v1/ads/admin/*` — the admin surface of `01-TARGET.md` §9.1 and
 * `packages/contracts/src/http/ads.ts`, which is the pin these handlers answer
 * to. Nothing here is public and nothing here carries a contact: a delivery row
 * names an `event_id` and a provider, never a person.
 *
 * Authorisation is layered, exactly as `01-TARGET.md` §4 item 2 requires, and
 * every layer answers a DIFFERENT question. The gateway decides who may reach
 * `/api/v1/ads/admin/*` at all. `gatewayOnly()` proves the request came
 * through the gateway — WHERE it came from, never WHO sent it. And this file
 * answers "who": a full-scope admin principal signed by Identity, verified
 * here against this Worker's own key ring, apex-only, exactly as Audit and
 * Analytics do it (§4 item 6 — the service's own check is the authority).
 *
 * That third layer is not redundant. `POST /flags` enables and disables
 * advertising providers and event mappings; a `workers_dev` twin, a forwarded
 * anonymous request, or a gateway whose capability table is not yet enforcing
 * would otherwise make it a mutation anyone can perform. No principal, one
 * this Worker cannot verify, or an assistant-scope admin → 401/403.
 */
import { Hono } from 'hono';
import type { AdsDeliveriesResponse, AdsDeliveryStatus, AdsEventMapResponse, AdsFlagResponse, AdsProviderName, AdsProvidersResponse } from '@levonis/contracts/http/ads';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { verifyPrincipal, isFullAdmin } from '@levonis/platform-kit/principal';
import { isKitError, forbidden, unauthorized } from '@levonis/platform-kit/errors';
import type { Env } from '../env';
import { producerKeys } from '../keys';
import { adsEnabled, DELIVERING_PROVIDERS, type ProviderRegistry } from '../registry';
import { allMappings, deadLetterCount, listDeliveries, providerSwitches, setEventEnabledStatement, setProviderEnabledStatement } from '../store';

const DELIVERY_STATUSES: readonly AdsDeliveryStatus[] = ['sent', 'sandbox', 'no_consent', 'rejected', 'failed', 'dead'];

/** Identity signs principals; until Phase 9 that is the core (`01-TARGET.md` §3.4). */
export const PRINCIPAL_ISSUERS = ['identity', 'core'];

/**
 * Every route below runs this first. `expectHostKind: 'main'` is this
 * service's own copy of the apex-only rule for admin surfaces (§3.5).
 */
export async function requireFullAdmin(env: Env, headers: Headers) {
  const header = headers.get(PRINCIPAL_HEADER);
  if (!header) throw unauthorized();
  const v = await verifyPrincipal(header, await producerKeys(env), {
    nowSeconds: Math.floor(Date.now() / 1000),
    issuers: PRINCIPAL_ISSUERS,
    expectHostKind: 'main',
  });
  if (!v.ok) throw unauthorized();
  if (!isFullAdmin(v.principal)) throw forbidden('Administrator access required');
  return v.principal;
}

const authFailure = (e: unknown) =>
  isKitError(e)
    ? { body: e.toBody(), status: e.status as 401 | 403 }
    : { body: { success: false as const, error: 'Authentication required', code: 'UNAUTHORIZED' }, status: 401 as const };

const isProviderName = (v: string): v is AdsProviderName => (DELIVERING_PROVIDERS as readonly string[]).includes(v) || v === 'noop';

export function adminRoutes(registry: ProviderRegistry) {
  const app = new Hono<{ Bindings: Env }>();

  /**
   * ONE middleware in front of every route in this router, rather than a line
   * repeated per handler: a route added later cannot forget it.
   */
  app.use('*', async (c, next) => {
    try {
      await requireFullAdmin(c.env, c.req.raw.headers);
    } catch (e) {
      const f = authFailure(e);
      return c.json(f.body, f.status);
    }
    await next();
  });

  /** `GET /providers` — configured, enabled and the breaker, per adapter. */
  app.get('/providers', async (c) => {
    const switches = await providerSwitches(c.env.DB);
    const providers = registry.names().map((name) => {
      const resolved = registry.resolve(name, c.env as unknown as Record<string, string | undefined>);
      const breaker = registry.breaker(name);
      return {
        name,
        configured: resolved?.configured ?? false,
        enabled: switches[name] ?? false,
        breaker: breaker.state,
        consecutive_failures: breaker.consecutiveFailures,
      };
    });
    const body: AdsProvidersResponse = { success: true, enabled: adsEnabled(c.env.ADS_ENABLED), providers };
    return c.json(body);
  });

  /** `GET /event-map` — the seeded mapping, with both kill switches folded in. */
  app.get('/event-map', async (c) => {
    const body: AdsEventMapResponse = { success: true, mappings: await allMappings(c.env.DB) };
    return c.json(body);
  });

  /** `GET /deliveries?provider=&status=&limit=&cursor=` */
  app.get('/deliveries', async (c) => {
    const provider = c.req.query('provider');
    const status = c.req.query('status');
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
    const rows = await listDeliveries(c.env.DB, {
      provider: provider && isProviderName(provider) ? provider : undefined,
      status: status && (DELIVERY_STATUSES as readonly string[]).includes(status) ? (status as AdsDeliveryStatus) : undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      cursor: c.req.query('cursor') || undefined,
    });
    const body: AdsDeliveriesResponse = {
      success: true,
      rows: rows.map((r) => ({
        id: r.id,
        event_id: r.event_id,
        event_type: r.event_type,
        provider: r.provider,
        status: r.status as AdsDeliveryStatus,
        attempts: r.attempts,
        error: r.error,
        created_at: r.created_at,
        delivered_at: r.delivered_at,
      })),
      next: rows.length ? rows[rows.length - 1].created_at : null,
      dead_letters: await deadLetterCount(c.env.DB),
    };
    return c.json(body);
  });

  /**
   * `POST /flags` — `{ name: 'ads.providers.meta_capi.enabled' | 'ads.events.<Type>.enabled', enabled }`.
   *
   * The GLOBAL switch is deliberately NOT settable here: `ads.enabled` is the
   * `ADS_ENABLED` var, so turning the whole service off is a workflow run with
   * a known propagation time rather than a row an admin session can flip
   * (`01-TARGET.md` §11.6). The emergency switch is smaller still — unset the
   * provider's secret and every delivery drops to `sandbox`.
   */
  app.post('/flags', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; enabled?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name : '';
    const enabled = body?.enabled === true;
    const provider = /^ads\.providers\.([a-z_]+)\.enabled$/.exec(name);
    const event = /^ads\.events\.([A-Za-z]+)\.enabled$/.exec(name);
    if (provider && isProviderName(provider[1])) {
      await setProviderEnabledStatement(c.env.DB, provider[1], enabled, new Date().toISOString()).run();
    } else if (event) {
      await setEventEnabledStatement(c.env.DB, event[1], enabled).run();
    } else {
      return c.json({ success: false, error: 'Unknown flag', code: 'NOT_FOUND' }, 404);
    }
    const out: AdsFlagResponse = { success: true, name, enabled, version: 1 };
    return c.json(out);
  });

  return app;
}
