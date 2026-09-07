import { defineEvent, keysOf } from '../define';
import { obj, idOrNull, nonEmptyStr, hex64, str } from '../common';
import { serviceName } from '../../envelope';
import type { Infer } from '../../schema';

const shape = {
  actor_id: idOrNull,
  action: nonEmptyStr,
  target: str,
  detail_hash: hex64, // sha256(canonical(detail))
  detail_ref: nonEmptyStr, // row id in the producer's <svc>_audit_details; the body never travels in the envelope
  source_service: serviceName,
};
const check = obj(shape);
export type AuditRecordedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — every service via the audit() facade; personal; Audit only. */
export const AuditRecordedV1 = defineEvent<AuditRecordedV1>({
  type: 'AuditRecorded', aggregate_type: 'audit', pii_class: 'personal', pii: ['actor_id'], fields: keysOf(shape), check,
  doc: 'A sensitive mutation was recorded for the hash chain.',
});
