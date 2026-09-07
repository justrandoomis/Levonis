import { defineEvent, keysOf } from '../define';
import { obj, id, oneOf, nullable, bool } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_id: id,
  role: oneOf('customer', 'merchant', 'admin'),
  admin_scope: nullable(oneOf('full', 'assistant')),
  is_investor: bool,
  actor_id: id,
};
const check = obj(shape);
export type RoleChangedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Identity; personal: Audit and the gateway cache only, never Analytics. */
export const RoleChangedV1 = defineEvent<RoleChangedV1>({
  type: 'RoleChanged', aggregate_type: 'user', pii_class: 'personal', pii: ['user_id', 'actor_id'], fields: keysOf(shape), check,
  doc: 'A role, admin scope or investor flag changed.',
});
