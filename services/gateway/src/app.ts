/**
 * The Hono app, separated from the Worker entrypoint so the whole edge stack
 * — the core's `securityHeaders()`, the core's `originCheck()`, the host
 * classification, and the pipeline behind them — can be driven by a test with
 * an ordinary `Request` and no Workers runtime. `index.ts` adds only the
 * `cloudflare:workers` entrypoint, the Cache API adapter and the RPC methods;
 * everything a request passes through is here, in one order, once.
 *
 * The middleware order is `worker/index.ts`'s, deliberately: security headers
 * outermost (so they are set even on a refusal thrown further in), then the
 * origin check, then one host classification per request that every later step
 * reads instead of re-parsing the Host header.
 */
import { Hono } from 'hono';
import type { HostInfo } from '@levonis/platform-kit/edge/hosts';
import { classifyHost, rootDomainFrom } from '@levonis/platform-kit/edge/hosts';
import { originCheck, securityHeaders } from '@levonis/platform-kit/edge/middleware';
import { isKitError } from '@levonis/platform-kit/errors';
import type { Env } from './env';
import { GatewayState, handle, type GatewayContext, type PipelineDeps } from './pipeline';

export type AppEnv = { Bindings: Env; Variables: { host: HostInfo; cid?: string; hopIss?: string | null } };

export type AppOptions = Omit<PipelineDeps, 'state' | 'waitUntil'> & { state?: GatewayState };

export function createApp(options: AppOptions = {}) {
  const state = options.state ?? new GatewayState();
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders());
  app.use('*', originCheck());
  app.use('*', async (c, next) => {
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
    await next();
  });

  app.all('*', (c) =>
    handle(c as unknown as GatewayContext, {
      ...options,
      state,
      waitUntil: (p) => {
        // `executionCtx` throws outside a Worker; awaiting inline is the
        // correct fallback for a test and for `wrangler dev --test-scheduled`.
        try {
          c.executionCtx.waitUntil(p);
        } catch {
          void p;
        }
      },
    })
  );

  app.onError((err, c) => {
    if (isKitError(err)) return c.json(err.toBody(), err.status as 400);
    console.error(JSON.stringify({ level: 'error', svc: 'gateway', msg: 'unhandled', path: c.req.path, error: (err as Error).message }));
    return c.json({ success: false, error: 'Something went wrong. Please try again.' }, 500);
  });

  return app;
}
