import { defineEvent, keysOf } from '../define';
import { obj, oneOf, nonEmptyStr } from '../common';
import { uuidV7 } from '../../schema';
import { serviceName } from '../../envelope';
import type { Infer } from '../../schema';

const shape = {
  event_id: uuidV7,
  consumer: serviceName,
  reason: oneOf('invalid', 'forged', 'pii_refused', 'unknown_type'),
  event_type: nonEmptyStr,
};
const check = obj(shape);
export type EventRejectedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — any consumer → Audit; a poison message never blocks the stream. */
export const EventRejectedV1 = defineEvent<EventRejectedV1>({
  type: 'EventRejected', aggregate_type: 'consumer', pii_class: 'none', pii: [], fields: keysOf(shape), check,
  doc: 'A consumer refused an envelope (schema-invalid, forged or above its PII class).',
});
