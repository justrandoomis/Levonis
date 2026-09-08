/**
 * The Hono app: the public inbox, the admin delivery history, the Telegram
 * webhook and `/health`.
 *
 * All of it is behind `gatewayOnly()` — including the webhook. That is not a
 * contradiction of "the one unauthenticated ingress": it is unauthenticated
 * from TELEGRAM's side (there is no user session), and it still arrives through
 * the gateway like everything else, which is what keeps this Worker reachable
 * by exactly one route.
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
import { publicRoutes } from './http/public';
import { webhookRoutes } from './http/webhook';
import { outboxLagSeconds } from './store';

export type AppEnv = { Bindings: Env; Variables: { host?: HostInfo; cid?: string; hopIss?: string | null } };

export interface AppOptions {
  /** the gateway's public keys; an empty ring is fine while `GATEWAY_ONLY` is `off` */
  ring?: KeyRing;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<AppEnv>();
  const ring = opts.ring ?? new KeyRing();

  /**
   * The cast is Hono's context generic being invariant in `Bindings`: this
   * service's `Env` extends the kit's `EdgeEnv`, so the value is compatible,
   * but `Context<AppEnv>` is not assignable to `Context<AppContext>` by
   * assignability alone. Nothing is asserted about the runtime shape that is
   * not already true of the type.
   */
  const hopCheck: MiddlewareHandler<AppEnv> = (c, next) =>
    gatewayOnly({ mode: c.env.GATEWAY_ONLY, ring, probeToken: c.env.HEALTH_PROBE_TOKEN })(c as unknown as Context<AppContext>, next);

  app.use('*', hopCheck);

  /** `01-TARGET.md` §11.3, plus the §11.4 golden signal for this service: outbox lag. */
  app.get('/health', async (c) =>
    c.json(
      await healthReport({
        svc: 'notifications',
        ver: versionOf(c.env),
        db: c.env.DB ?? null,
        outboxLagS: () => outboxLagSeconds(c.env.DB, new Date().toISOString()),
      })
    )
  );

  app.route('/api/notifications', publicRoutes());
  app.route('/api/v1/notifications/admin', adminRoutes());
  app.route('/api/telegram/webhook', webhookRoutes());

  app.notFound((c) => c.json({ success: false, error: 'Not found', code: 'NOT_FOUND' }, 404));
  return app;
}
