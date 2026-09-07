import { defineEvent, keysOf } from '../define';
import { obj, id, hex64, nullable, str, locale, oneOf } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_id: id,
  user_hash: hex64,
  username: nullable(str),
  name: nullable(str),
  avatar_key: nullable(str),
  locale,
  marketing_consent: oneOf('none', 'analytics', 'ads'),
  email_hash: nullable(hex64), // present only when marketing_consent changed to 'ads', computed by Identity in memory
  phone_hash: nullable(hex64),
};
const check = obj(shape);
export type UserUpdatedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Identity; Ads keeps the hashes only under 'ads' consent, Analytics drops user_id and hashes. */
export const UserUpdatedV1 = defineEvent<UserUpdatedV1>({
  type: 'UserUpdated', aggregate_type: 'user', pii_class: 'pseudonymous', pii: ['user_id', 'email_hash', 'phone_hash'], fields: keysOf(shape), check,
  doc: 'Profile or consent changed.',
});
