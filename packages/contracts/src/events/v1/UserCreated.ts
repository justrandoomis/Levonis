import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, locale, oneOf, bool, at } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_id: id,
  /**
   * How the account came to exist. WIDENED, never re-meant: 'otp' joined the
   * list when a phone number became a way to SIGN UP and not only to sign in,
   * and every existing value still means exactly what it meant. A consumer
   * that switches on this field must therefore have a default branch — which
   * is the rule for every oneOf in a v1 event, and the reason widening is
   * additive rather than a v2.
   */
  method: oneOf('password', 'google', 'telegram', 'email_first', 'otp'),
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
  doc: 'A person signed up (password, Google, Telegram, email-first completion, or a code sent to their phone or mailbox).',
});
