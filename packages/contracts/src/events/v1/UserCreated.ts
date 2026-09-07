import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, locale, oneOf, bool, at } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_id: id,
  method: oneOf('password', 'google', 'telegram', 'email_first'),
  locale,
  referrer_code: idOrNull, // the code entered at signup; Referrals resolves it
  email_verified: bool,
  created_at: at,
};
const check = obj(shape);
export type UserCreatedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.1 — Identity, seq 1 of the user aggregate. No contact hash: no consent exists at signup. */
export const UserCreatedV1 = defineEvent<UserCreatedV1>({
  type: 'UserCreated', aggregate_type: 'user', pii_class: 'pseudonymous', pii: ['user_id'], fields: keysOf(shape), check,
  doc: 'A person signed up (password, Google, Telegram or email-first completion).',
});
