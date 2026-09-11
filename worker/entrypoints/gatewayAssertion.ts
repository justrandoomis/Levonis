/**
 * The inbound half of the gateway contract (`01-TARGET.md` §4 item 1): once
 * the gateway is the only way in, a request that arrives at the core WITHOUT
 * the gateway's signed hop did not come through the gateway, and the core says
 * so. Three modes, in the order they will be turned on: `off` (today), `log`
 * (count them for a week — the Phase 3.3 entry criterion is a week at zero)
 * and `on` (`403 NOT_VIA_GATEWAY`). A health probe carrying the constant-time
 * compared token passes in every mode, because a check that locks the prober
 * out cannot report that the lock is broken.
 *
 * The whole thing is one string comparison while `GATEWAY_ONLY` is unset: no
 * header is read, no key ring is built, no allocation is made.
 */
import type { Context, Next } from 'hono';
import { gatewayOnly, GATEWAY_ONLY_MODES } from '@levonis/platform-kit/edge/gatewayOnly';
import { modeVar } from '@levonis/platform-kit/config';
import { KeyRing } from '@levonis/platform-kit/keys';
import type { AppContext, Env } from '../lib/types';

const rings = new WeakMap<object, Promise<KeyRing>>();

/** One ring per environment object; the gateway's public key comes from `ALLOWED_CALLER_KIDS`. */
function ringFor(env: Env): Promise<KeyRing> {
  const cached = rings.get(env as unknown as object);
  if (cached) return cached;
  const built = KeyRing.fromAllowlist(env.ALLOWED_CALLER_KIDS).catch((e) => {
    console.error('ALLOWED_CALLER_KIDS could not be parsed:', e instanceof Error ? e.message : String(e));
    return new KeyRing();
  });
  rings.set(env as unknown as object, built);
  return built;
}

export async function gatewayAssertion(c: Context<AppContext>, next: Next): Promise<void | Response> {
  const mode = modeVar(c.env.GATEWAY_ONLY, GATEWAY_ONLY_MODES, 'off');
  if (mode === 'off') return next();
  const middleware = gatewayOnly({
    mode,
    ring: await ringFor(c.env),
    probeToken: c.env.HEALTH_PROBE_TOKEN,
    onNotViaGateway: (info) => console.warn('not via gateway', info.mode, info.reason, info.path),
  });
  return middleware(c as never, next);
}
