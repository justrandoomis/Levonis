/**
 * `levonis-gateway` — the Worker.
 *
 * Deliberately thin: the whole request path lives in `app.ts` + `pipeline.ts`,
 * which are plain modules a test can drive with an ordinary `Request`. This
 * file owns only what needs the Workers runtime — the `WorkerEntrypoint`, the
 * per-isolate state, the Cache API adapter and the two RPC methods.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createLogger } from '@levonis/platform-kit/log';
import { healthReport } from '@levonis/platform-kit/health';
import type { DeliverResult, HealthReport } from '@levonis/contracts/rpc/common';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { isAllowedProducer } from '@levonis/contracts/subscriptions';
import { verifyEnvelope } from '@levonis/platform-kit/eventSig';
import type { Env } from './env';
import { versionOf } from './env';
import { createApp } from './app';
import { GatewayState, type EdgeCache } from './pipeline';

/** One per isolate: the principal cache, Identity's public keys, the hop signer. */
const state = new GatewayState();

/** `caches.default` behind the pipeline's tiny interface; null where the runtime has no Cache API. */
function edgeCache(): EdgeCache | null {
  const store = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!store) return null;
  return {
    match: (key: string) => store.match(new Request(key)),
    put: (key: string, response: Response) => store.put(new Request(key), response),
  };
}

const log = createLogger({ svc: 'gateway', sampleRate: 0.1 });

const app = createApp({
  state,
  cache: edgeCache(),
  log,
});

export default class GatewayEntrypoint extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /** `01-TARGET.md` §11.3 — the gateway owns no database, so the report is bindings only. */
  health(): Promise<HealthReport> {
    return healthReport({ svc: 'gateway', ver: versionOf(this.env), db: null });
  }

  /**
   * `SessionRevoked` and `RoleChanged` (`01-TARGET.md` §3.4). Both mean "the
   * principal you cached is no longer true", and an eviction is idempotent —
   * so unlike every other consumer the gateway needs no `processed_events`
   * table, and therefore no database at all.
   *
   * THE SIGNATURE IS CHECKED FIRST. A service binding is account-level trust,
   * so without this any Worker on the account could hand this method a
   * `RoleChanged` envelope and drop the entire principal cache, forcing an
   * `IDENTITY.resolveSession` round trip per active session — an
   * unauthenticated lever on the core's D1 load. `03-EVENTS.md` §1 requires
   * both of these types to be signature-verified precisely because they are
   * privilege-affecting, and the gateway already holds Identity's key ring for
   * verifying principals.
   *
   * An envelope that cannot be verified is ACKED, not retried: the effect here
   * is only an eviction (fail-safe — it never grants anything), and a consumer
   * that will never act on an event must not hold the producer's outbox open.
   * Unknown types are acked for the same reason.
   */
  async deliver(batch: EventEnvelope[]): Promise<DeliverResult> {
    const results: DeliverResult['results'] = [];
    const acts = (batch ?? []).some((ev) => ev?.event_type === 'SessionRevoked' || ev?.event_type === 'RoleChanged');
    const ring = acts ? await state.keys.get(this.env.IDENTITY ?? { getPublicKeys: async () => ({ keys: [] }) }, this.env.ALLOWED_CALLER_KIDS) : null;
    for (const ev of batch ?? []) {
      const key = `${ev.event_type}.v${ev.version}`;
      const privileged = ev.event_type === 'SessionRevoked' || ev.event_type === 'RoleChanged';
      if (privileged && ring) {
        const allowed = isAllowedProducer(key, ev.source_service);
        const verified = allowed && (await verifyEnvelope(ev, ring, { eventKey: key, hopIss: null })).ok;
        if (!verified) {
          log.warn('gateway.deliver_refused', { event_id: ev.event_id, type: ev.event_type, source: ev.source_service });
          results.push({ event_id: ev.event_id, result: 'forged' });
          continue;
        }
        if (ev.event_type === 'SessionRevoked') {
          const sid = (ev.payload as { sid_hash?: string } | undefined)?.sid_hash;
          if (sid) state.principals.evictSession(sid);
          else state.principals.clear();
        } else {
          // The cache is keyed by session, not by user, so the subject's
          // entries cannot be found individually. Dropping the whole cache
          // costs one Identity round trip per active session.
          state.principals.clear();
        }
      }
      results.push({ event_id: ev.event_id, result: 'acked' });
    }
    return { results };
  }
}
