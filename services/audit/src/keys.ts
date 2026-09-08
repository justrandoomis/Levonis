/**
 * Where a producer's public key comes from (`03-EVENTS.md` §1: `defineConsumer`
 * verifies `sig` against the producer's registered key, `service_keys`, cached
 * 5 min).
 *
 * Two sources, in this order:
 *  1. `ALLOWED_CALLER_KIDS` — the bootstrap var (`service:kid:publicKey,…`),
 *     the only source before Identity's registry exists (plan 1.6 `0058`);
 *  2. `IDENTITY.getPublicKeys()` over the service binding, when one is bound.
 *
 * Both are merged into one ring, refreshed at most every 5 minutes per isolate.
 * When neither yields a key the ring is empty and every signed envelope is
 * refused as `forged` — the correct answer for a log: an entry whose producer
 * cannot be established is not an entry.
 */
import { KeyRing } from '@levonis/platform-kit/keys';
import type { Env } from './env';

export const KEY_CACHE_MS = 5 * 60 * 1000;

interface Cached {
  ring: KeyRing;
  at: number;
  kids: number;
}

const cache = new WeakMap<object, Cached>();

async function build(env: Env, nowMs: number): Promise<Cached> {
  let ring: KeyRing;
  try {
    ring = await KeyRing.fromAllowlist(env.ALLOWED_CALLER_KIDS);
  } catch (e) {
    console.error('audit: ALLOWED_CALLER_KIDS could not be parsed:', e instanceof Error ? e.message : String(e));
    ring = new KeyRing();
  }
  if (env.IDENTITY?.getPublicKeys) {
    try {
      // No hop is signed for this call while `AUDIT_SIGNING_KEY` is absent; the
      // callee decides whether it accepts that (`hopMode` is `off` until any
      // caller key is registered). The registry is public by construction — it
      // is the set of PUBLIC keys — so a refused call costs freshness, nothing
      // else, and the allowlist ring still stands.
      const res = await env.IDENTITY.getPublicKeys(undefined as never);
      for (const k of res?.keys ?? []) {
        if (k?.public_key && k?.service) await ring.add(k.service, k.public_key);
      }
    } catch (e) {
      console.warn('audit: IDENTITY.getPublicKeys failed, using the bootstrap allowlist only:', e instanceof Error ? e.message : String(e));
    }
  }
  return { ring, at: nowMs, kids: ring.kids().length };
}

/** The producer key ring for this isolate, rebuilt at most every 5 minutes. */
export async function producerKeys(env: Env, nowMs = Date.now()): Promise<KeyRing> {
  const key = env as unknown as object;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < KEY_CACHE_MS) return hit.ring;
  const built = await build(env, nowMs);
  cache.set(key, built);
  return built.ring;
}

/** Test seam: forget what this isolate cached. */
export function resetKeyCache(env: Env): void {
  cache.delete(env as unknown as object);
}
