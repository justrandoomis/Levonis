/**
 * The event envelope (`03-EVENTS.md` §1). Every event on the bus — outbox row,
 * RPC `deliver()` batch or queue message — is exactly this shape. `payload` is
 * validated separately against the schema registered for `(event_type, version)`
 * (`events/index.ts`); `sig` is verified by the platform kit against the
 * producer's registered public key.
 */
import { validator, obj, str, nonEmptyStr, int, nonNegInt, isoDate, uuidV7, nullable, oneOf, ContractViolation, type Check } from './schema';

export const PII_CLASSES = ['none', 'pseudonymous', 'personal'] as const;
export type PiiClass = (typeof PII_CLASSES)[number];
/** Ordered so a consumer's `piiMax` can be compared: none < pseudonymous < personal. */
export const PII_RANK: Record<PiiClass, number> = { none: 0, pseudonymous: 1, personal: 2 };

export const DELIVERY_CLASSES = ['transactional', 'best_effort'] as const;
export type Delivery = (typeof DELIVERY_CLASSES)[number];

export interface EventEnvelope<T = unknown> {
  event_id: string; // UUIDv7 — time-ordered, globally unique
  event_type: string; // 'OrderCreated'
  version: number; // payload schema version, starts at 1
  created_at: string; // ISO 8601, producer clock
  source_service: string; // 'commerce' | 'ledger' | … | 'core' while the monolith produces
  correlation_id: string; // x-correlation-id of the originating request, or the parent event's
  causation_id: string | null; // event_id (or request id) that caused this event
  actor_id: string | null; // principal.sub when a person acted; null for system/cron
  aggregate_type: string; // 'order' | 'user' | 'product' | 'wallet' | 'membership' | …
  aggregate_id: string;
  aggregate_seq: number; // monotonically increasing per (aggregate_type, aggregate_id)
  pii_class: PiiClass; // decides who may consume
  delivery: Delivery; // transactional: outbox row in the business batch; best_effort: fire-and-forget RPC
  payload: T; // validated against the schema; an allowlist, never a whole row
  sig: string; // <b64url(header{alg:'EdDSA',kid})>.<b64url(signature)> over canonical(envelope minus sig)
}

/** The envelope minus its signature — what the producer signs and the consumer verifies. */
export type UnsignedEnvelope<T = unknown> = Omit<EventEnvelope<T>, 'sig'>;

/** `sig` shape: two base64url segments joined by '.', the first a JSON header carrying the kid. */
export const SIG_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Marker used by committed fixtures, which are signed at test time with a throwaway key. */
export const FIXTURE_SIG = 'fixture';

/** Service names are lowercase kebab-case (`ledger`, `ledger-admin`, `core`). */
export const serviceName: Check<string> = (v, p) => {
  const s = nonEmptyStr(v, p);
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(s)) throw new ContractViolation(p, 'must be a lowercase service name');
  return s;
};

const envelopeShape = {
  event_id: uuidV7,
  event_type: ((v, p) => {
    const s = nonEmptyStr(v, p);
    if (!/^[A-Z][A-Za-z0-9]{2,60}$/.test(s)) throw new ContractViolation(p, 'event_type must be PascalCase');
    return s;
  }) as Check<string>,
  version: ((v, p) => {
    const n = int(v, p);
    if (n < 1) throw new ContractViolation(p, 'version starts at 1');
    return n;
  }) as Check<number>,
  created_at: isoDate,
  source_service: serviceName,
  correlation_id: nonEmptyStr,
  causation_id: nullable(nonEmptyStr),
  actor_id: nullable(nonEmptyStr),
  aggregate_type: nonEmptyStr,
  aggregate_id: nonEmptyStr,
  aggregate_seq: nonNegInt,
  pii_class: oneOf(...PII_CLASSES),
  delivery: oneOf(...DELIVERY_CLASSES),
  payload: ((v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ContractViolation(p, 'payload must be an object');
    return v;
  }) as Check<unknown>,
  sig: str,
};

const envelopeValidator = validator(obj(envelopeShape));

/**
 * Structural validation of an envelope. Throws `ContractViolation` on a bad
 * shape (a foreign key, a missing field, a malformed id). Does NOT check the
 * payload against its event schema (`events/index.ts` `schemaFor`) and does NOT
 * verify `sig` — the platform kit does both before any state is touched.
 */
export function validateEnvelope(value: unknown): asserts value is EventEnvelope {
  const env = envelopeValidator.parse(value) as EventEnvelope;
  if (env.sig !== FIXTURE_SIG && !SIG_FORMAT.test(env.sig)) throw new ContractViolation('$.sig', 'malformed signature');
}

export const isEnvelope = (value: unknown): value is EventEnvelope => {
  try {
    validateEnvelope(value);
    return true;
  } catch {
    return false;
  }
};

/** `'OrderCreated.v1'` — the key used by the subscriptions table and the schema registry. */
export function eventKey(type: string, version: number): string {
  return `${type}.v${version}`;
}

export function eventKeyOf(env: Pick<EventEnvelope, 'event_type' | 'version'>): string {
  return eventKey(env.event_type, env.version);
}

/** Strips `sig` so the remaining envelope can be canonicalised for signing/verifying. */
export function unsigned<T>(env: EventEnvelope<T>): UnsignedEnvelope<T> {
  const { sig: _sig, ...rest } = env;
  return rest;
}
