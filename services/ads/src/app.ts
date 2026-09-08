/**
 * The Hono app: `/health` plus the admin surface, both behind `gatewayOnly()`.
 *
 * Kept out of `index.ts` so a test can drive it with an ordinary `Request` and
 * a plain object for `env`, without the Workers runtime.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { gatewayOnly } from '@levonis/platform-kit/edge/gatewayOnly';
import { healthReport } from '@levonis/platform-kit/health';
import { KeyRing } from '@levonis/platform-kit/keys';
import type { AppContext } from '@levonis/platform-kit/edge/types';
import type { HostInfo } from '@levonis/platform-kit/edge/hosts';
import type { Env } from './env';
import { versionOf } from './env';
import { adminRoutes } from './http/admin';
import type { ProviderRegistry } from './registry';

export type AppEnv = { Bindings: Env; Variables: { host?: HostInfo; cid?: string; hopIss?: string | null } };

export interface AppOptions {
  registry: ProviderRegistry;
  /** the gateway's public keys; an empty ring is fine while `GATEWAY_ONLY` is `off` */
  ring?: KeyRing;
}

export function createApp(opts: AppOptions) {
  const app = new Hono<AppEnv>();
  const ring = opts.ring ?? new KeyRing();

  /**
   * The inbound gateway-hop check (`01-TARGET.md` §4 item 1).
   *
   * The cast is Hono's context generic being invariant in `Bindings`: this
   * service's `Env` extends the kit's `EdgeEnv`, so the value is compatible,
   * but `Context<AppEnv>` is not assignable to `Context<AppContext>` by
   * assignability rules alone. Nothing is being asserted about the runtime
   * shape that is not already true of the type.
   */
  const hopCheck: MiddlewareHandler<AppEnv> = (c, next) =>
    gatewayOnly({ mode: c.env.GATEWAY_ONLY, ring, probeToken: c.env.HEALTH_PROBE_TOKEN })(c as unknown as Context<AppContext>, next);

  app.use('*', hopCheck);

  /**
   * `GET /health` — reachable on the dark URL; in production the Worker has no
   * URL and the probe arrives through the gateway's fan-out instead
   * (`01-TARGET.md` §11.3).
   */
  app.get('/health', async (c) =>
    c.json(
      await healthReport({
        svc: 'ads',
        ver: versionOf(c.env),
        db: c.env.DB ?? null,
      })
    )
  );

  app.route('/api/v1/ads/admin', adminRoutes(opts.registry));

  app.notFound((c) => c.json({ success: false, error: 'Not found', code: 'NOT_FOUND' }, 404));
  return app;
}
