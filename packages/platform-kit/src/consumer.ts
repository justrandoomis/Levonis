/**
 * `defineConsumer` (`03-EVENTS.md` §1, §2.3): the one `deliver()` a consumer
 * exposes over RPC and calls from `queue()`. Before any state is touched it
 * validates the envelope, checks the type is one this consumer accepts, checks
 * `source_service` (and the hop `iss` in rpc mode) against the producers
 * allowlist, verifies `sig`, refuses classes above `piiMax`, validates the
 * payload against its schema, and then runs the handler's statements in ONE
 * batch with the `processed_events` insert — a PK violation means replay.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { validateEnvelope, eventKeyOf, FIXTURE_SIG } from '@levonis/contracts/envelope';
import { PII_RANK, type PiiClass } from '@levonis/contracts/envelope';
import { isAllowedProducer } from '@levonis/contracts/subscriptions';
import { EVENT_SCHEMAS } from '@levonis/contracts/events/index';
import type { DeliverResult, DeliveryOutcome, HopEnvelope } from '@levonis/contracts/rpc/common';
import { DELIVER_MAX_EVENTS } from '@levonis/contracts/rpc/consumer';
import { verifyEnvelope } from './eventSig';
import type { KeyRing } from './keys';
import { isProcessed, isUniqueViolation, processedEventStatement } from './idempotency';
import type { Logger } from './log';

export interface HandlerContext {
  db: D1Database;
  /** the consumer's own prefix for platform tables */
  prefix: string;
  now: string;
  log?: Logger;
}

/**
 * A handler returns the statements of its side effect (batched with the
 * processed_events row), or `{ retry: true }` for a transient failure.
 * Remote-command effects (Referrals -> LEDGER.credit) run BEFORE returning and
 * derive their eventKey deterministically from the event, so a redelivery
 * hits the callee's idempotency.
 */
export type EventHandler<T = unknown> = (
  envelope: EventEnvelope<T>,
  ctx: HandlerContext
) => Promise<D1PreparedStatement[] | { retry: true; error?: string }>;

export interface ConsumerDefinition {
  name: string; // the service name — must match a subscriptions.ts consumer
  prefix?: string; // platform-table prefix (defaults to name)
  piiMax: PiiClass;
  handlers: Record<string, EventHandler>; // keyed 'OrderCreated.v1'
  keys: KeyRing; // producers' public keys
  /** dark/test only: accept the committed fixtures' `sig: 'fixture'` marker */
  acceptFixtureSig?: boolean;
  now?: () => string;
  log?: Logger;
  onRejected?: (envelope: EventEnvelope, reason: 'invalid' | 'forged' | 'pii_refused' | 'unknown_type') => void | Promise<void>;
}

export interface Consumer {
  readonly name: string;
  readonly accepts: readonly string[];
  deliver(db: D1Database, batch: EventEnvelope[], hop?: HopEnvelope | null): Promise<DeliverResult>;
}

export function defineConsumer(def: ConsumerDefinition): Consumer {
  const prefix = def.prefix ?? def.name;
  const now = def.now ?? (() => new Date().toISOString());
  const accepts = Object.keys(def.handlers);

  const one = async (db: D1Database, raw: unknown, hop?: HopEnvelope | null): Promise<{ event_id: string; result: DeliveryOutcome; error?: string }> => {
    let env: EventEnvelope;
    try {
      validateEnvelope(raw);
      env = raw;
    } catch (e) {
      const id = typeof raw === 'object' && raw && typeof (raw as { event_id?: unknown }).event_id === 'string' ? (raw as { event_id: string }).event_id : 'unknown';
      def.log?.warn('consumer.invalid_envelope', { event_id: id, error: (e as Error).message });
      return { event_id: id, result: 'invalid', error: (e as Error).message };
    }
    const key = eventKeyOf(env);
    const handler = def.handlers[key];
    if (!handler) {
      await def.onRejected?.(env, 'unknown_type');
      return { event_id: env.event_id, result: 'invalid', error: `unknown type ${key}` };
    }
    if (!isAllowedProducer(key, env.source_service) || (hop && hop.iss !== env.source_service && !isAllowedProducer(key, hop.iss))) {
      await def.onRejected?.(env, 'forged');
      return { event_id: env.event_id, result: 'forged', error: 'producer not allowed' };
    }
    if (env.sig === FIXTURE_SIG && def.acceptFixtureSig) {
      // signature check skipped for committed fixtures in dark/test runs
    } else {
      const v = await verifyEnvelope(env, def.keys, { eventKey: key, hopIss: hop?.iss ?? null });
      if (!v.ok) {
        await def.onRejected?.(env, 'forged');
        return { event_id: env.event_id, result: 'forged', error: v.reason };
      }
    }
    if (PII_RANK[env.pii_class] > PII_RANK[def.piiMax]) {
      await def.onRejected?.(env, 'pii_refused');
      return { event_id: env.event_id, result: 'pii_refused', error: `${env.pii_class} above ${def.piiMax}` };
    }
    const schema = EVENT_SCHEMAS[key];
    if (!schema) return { event_id: env.event_id, result: 'invalid', error: `no schema for ${key}` };
    try {
      schema.parse(env.payload);
    } catch (e) {
      await def.onRejected?.(env, 'invalid');
      return { event_id: env.event_id, result: 'invalid', error: (e as Error).message };
    }
    if (await isProcessed(db, prefix, env.event_id)) return { event_id: env.event_id, result: 'replayed' };
    const at = now();
    let effect: Awaited<ReturnType<EventHandler>>;
    try {
      effect = await handler(env, { db, prefix, now: at, log: def.log });
    } catch (e) {
      def.log?.error('consumer.handler_threw', { event_id: env.event_id, type: key, error: (e as Error).message });
      return { event_id: env.event_id, result: 'retry', error: (e as Error).message };
    }
    if (!Array.isArray(effect)) return { event_id: env.event_id, result: 'retry', error: effect.error };
    try {
      await db.batch([...effect, processedEventStatement(db, prefix, def.name, env.event_id, 'acked', at)]);
      return { event_id: env.event_id, result: 'acked' };
    } catch (e) {
      if (isUniqueViolation(e)) return { event_id: env.event_id, result: 'replayed' };
      def.log?.error('consumer.batch_failed', { event_id: env.event_id, type: key, error: (e as Error).message });
      return { event_id: env.event_id, result: 'retry', error: (e as Error).message };
    }
  };

  return {
    name: def.name,
    accepts,
    async deliver(db, batch, hop) {
      if (!Array.isArray(batch)) throw new TypeError('deliver: batch must be an array');
      if (batch.length > DELIVER_MAX_EVENTS) throw new RangeError(`deliver: batch of ${batch.length} exceeds ${DELIVER_MAX_EVENTS}`);
      const results = [];
      for (const raw of batch) results.push(await one(db, raw, hop));
      return { results };
    },
  };
}
