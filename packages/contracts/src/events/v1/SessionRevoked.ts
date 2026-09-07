import { defineEvent, keysOf } from '../define';
import { obj, id, hex64, oneOf } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_id: id,
  sid_hash: hex64,
  reason: oneOf('logout', 'password_change', 'admin', 'expired', 'role_change'),
};
const check = obj(shape);
export type SessionRevokedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Identity → Gateway cache eviction (Studio later). */
export const SessionRevokedV1 = defineEvent<SessionRevokedV1>({
  type: 'SessionRevoked', aggregate_type: 'session', pii_class: 'none', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A session stopped being valid.',
});
