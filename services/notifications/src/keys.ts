/**
 * The verify keys this service trusts, and the ONE place they come from.
 *
 * Notifications binds no other Worker: it holds no `IDENTITY` service binding,
 * so — unlike Audit and Analytics — the only source is the bootstrap var
 * `ALLOWED_CALLER_KIDS` (`service:kid:publicKey,…`). That is deliberate and it
 * is what makes the HTTP surfaces fail CLOSED: while the var is empty the ring
 * is empty, every principal is `UNKNOWN_KID`, and `/api/notifications*`
 * answers 401 — which is exactly what the public router's header comment
 * promises until the gateway mints principals (`01-TARGET.md` §3.4, §4 item 2).
 *
 * The same ring verifies inbound hop envelopes (`guard.ts`), because a hop and
 * a principal are signed by the same registry of service keys.
 */
import { KeyRing } from '@levonis/platform-kit/keys';
import type { Env } from './env';

export const KEY_CACHE_MS = 5 * 60 * 1000;

interface Cached {
  ring: KeyRing;
  at: number;
}

const cache = new WeakMap<object, Cached>();

async function build(env: Env): Promise<KeyRing> {
  try {
    return await KeyRing.fromAllowlist(env.ALLOWED_CALLER_KIDS);
  } catch (e) {
    console.error('notifications: ALLOWED_CALLER_KIDS could not be parsed:', e instanceof Error ? e.message : String(e));
    return new KeyRing();
  }
}

/** The ring for this isolate, rebuilt at most every 5 minutes. */
export async function producerKeys(env: Env, nowMs = Date.now()): Promise<KeyRing> {
  const key = env as unknown as object;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < KEY_CACHE_MS) return hit.ring;
  const ring = await build(env);
  cache.set(key, { ring, at: nowMs });
  return ring;
}

/** Test seam: forget what this isolate cached. */
export function resetKeyCache(env: Env): void {
  cache.delete(env as unknown as object);
}
