/**
 * How an event schema is declared (`03-EVENTS.md` §1): the TypeScript type, a
 * hand-written `validate` (an allowlist — unknown keys are refused), the `pii`
 * list Analytics drops and Ads may only hash under consent, the aggregate, the
 * envelope `pii_class` and the `delivery` default.
 */
import type { Delivery, EventEnvelope, PiiClass } from '../envelope';
import { validator, type Check } from '../schema';

export interface EventSchema<T = unknown> {
  readonly type: string;
  readonly version: number;
  /** `'OrderCreated.v1'` */
  readonly key: string;
  readonly aggregate_type: string;
  readonly pii_class: PiiClass;
  readonly delivery: Delivery;
  /** payload fields Analytics drops at ingest and Ads may only hash under consent */
  readonly pii: readonly string[];
  /** every top-level payload field the allowlist knows */
  readonly fields: readonly string[];
  readonly doc: string;
  validate(payload: unknown): asserts payload is T;
  is(payload: unknown): payload is T;
  parse(payload: unknown): T;
  /** Fills the schema-fixed envelope fields; the producer supplies the rest. */
  envelope(input: EnvelopeInput<T>): Omit<EventEnvelope<T>, 'sig'>;
}

export interface EnvelopeInput<T> {
  event_id: string;
  created_at: string;
  source_service: string;
  correlation_id: string;
  causation_id: string | null;
  actor_id: string | null;
  aggregate_id: string;
  aggregate_seq: number;
  payload: T;
  /** override the default for this instance (e.g. a sampled best_effort emission of a transactional type is not allowed; kept for symmetry) */
  delivery?: Delivery;
}

export function defineEvent<T>(def: {
  type: string;
  version?: number;
  aggregate_type: string;
  pii_class: PiiClass;
  delivery?: Delivery;
  pii: readonly string[];
  fields: readonly string[];
  doc: string;
  check: Check<T>;
}): EventSchema<T> {
  const version = def.version ?? 1;
  const v = validator(def.check, '$.payload');
  for (const f of def.pii) {
    if (!def.fields.includes(f)) throw new Error(`${def.type}: pii field ${f} is not a payload field`);
  }
  const schema: EventSchema<T> = {
    type: def.type,
    version,
    key: `${def.type}.v${version}`,
    aggregate_type: def.aggregate_type,
    pii_class: def.pii_class,
    delivery: def.delivery ?? 'transactional',
    pii: def.pii,
    fields: def.fields,
    doc: def.doc,
    validate: v.validate,
    is: v.is,
    parse: v.parse,
    envelope(input) {
      const payload = v.parse(input.payload);
      return {
        event_id: input.event_id,
        event_type: def.type,
        version,
        created_at: input.created_at,
        source_service: input.source_service,
        correlation_id: input.correlation_id,
        causation_id: input.causation_id,
        actor_id: input.actor_id,
        aggregate_type: def.aggregate_type,
        aggregate_id: input.aggregate_id,
        aggregate_seq: input.aggregate_seq,
        pii_class: def.pii_class,
        delivery: input.delivery ?? def.delivery ?? 'transactional',
        payload,
      };
    },
  };
  return schema;
}

/** The keys of a strict object check, so `fields` never drifts from the shape. */
export function keysOf(shape: Record<string, unknown>): readonly string[] {
  return Object.freeze(Object.keys(shape));
}
