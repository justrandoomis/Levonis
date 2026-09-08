/**
 * The PII projection (`01-TARGET.md` §9.2: "every field annotated `pii` is
 * dropped at ingest"; `03-EVENTS.md` §5 rules 1–3).
 *
 * It is mechanical on purpose. The list of fields to drop is not written here —
 * it is `EVENT_SCHEMAS[key].pii`, the same annotation the catalogue publishes
 * and `tests/eventSchemas.test.ts` polices — so a new `pii` field added to a
 * schema is dropped by this service the moment the contract lands, with no
 * change and no release here. `test/projection.test.ts` asserts exactly that
 * over the whole subscribed catalogue.
 *
 * Two things beyond the annotation:
 *  - `actor_id` on the ENVELOPE is replaced by a daily-salted hash, so a
 *    person's actions cannot be joined across days from this store;
 *  - `merchant_id` is lifted out of the payload into its own column, because a
 *    merchant is a store rather than a person (`02-MIGRATION-PLAN.md` Phase-1
 *    note (a)) and `analytics_daily_merchant` is what the merchant panels read.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { eventKeyOf } from '@levonis/contracts/envelope';
import { EVENT_SCHEMAS } from '@levonis/contracts/events/index';
import { sha256Hex } from '@levonis/contracts/canonical';

/** UTC day of an ISO timestamp; the fallback keeps a malformed clock out of the index. */
export function dayOf(iso: string, fallback: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return fallback.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The pseudonym: `sha256(day : salt : actor)`. New every day, so two rows in
 * different days cannot be tied together; salted, so the mapping cannot be
 * re-derived from a list of user ids (`SECRETS.md`, `ANALYTICS_HASH_SALT`).
 */
export async function actorHash(actorId: string | null, day: string, salt: string | undefined): Promise<string | null> {
  if (!actorId) return null;
  return sha256Hex(`${day}:${salt ?? ''}:${actorId}`);
}

/**
 * Aggregates whose id IS a person: `user` (`UserCreated`, `UserUpdated`),
 * `wallet` and `membership` (`aggregate_id` = the user id, `03-EVENTS.md` §3.8
 * onward) and `cart`. The per-field `pii` annotation cannot cover these — the
 * id is on the ENVELOPE, not in the payload — so the projection hashes them
 * with the same daily salt. Without this, dropping `user_id` from an
 * `OrderCreated` payload would be theatre: the wallet events beside it carry
 * the same person as `aggregate_id`.
 */
export const PERSON_AGGREGATES = new Set(['user', 'wallet', 'membership', 'cart']);

/** The fields the schema says are personal, for one event key. */
export const piiFieldsOf = (key: string): readonly string[] => EVENT_SCHEMAS[key]?.pii ?? [];

/** Drops every annotated field from a payload. Unknown keys survive as they are — the schema already refused them at validation. */
export function dropPii(key: string, payload: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(piiFieldsOf(key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface Projection {
  event_id: string;
  event_type: string;
  version: number;
  day: string;
  occurred_at: string;
  source_service: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_seq: number;
  correlation_id: string;
  actor_hash: string | null;
  merchant_id: string | null;
  payload: Record<string, unknown>;
}

/** A merchant id, when the payload carries one that is a store rather than a person. */
export function merchantOf(payload: Record<string, unknown>): string | null {
  const value = payload.merchant_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The whole ingest projection for one envelope. */
export async function project(env: EventEnvelope, opts: { salt?: string; now: string }): Promise<Projection> {
  const key = eventKeyOf(env);
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const day = dayOf(env.created_at, opts.now);
  const person = PERSON_AGGREGATES.has(env.aggregate_type);
  return {
    event_id: env.event_id,
    event_type: env.event_type,
    version: env.version,
    day,
    occurred_at: env.created_at,
    source_service: env.source_service,
    aggregate_type: env.aggregate_type,
    aggregate_id: person ? ((await actorHash(env.aggregate_id, day, opts.salt)) ?? '') : env.aggregate_id,
    aggregate_seq: env.aggregate_seq,
    correlation_id: env.correlation_id,
    actor_hash: await actorHash(env.actor_id, day, opts.salt),
    merchant_id: merchantOf(payload),
    payload: dropPii(key, payload),
  };
}
