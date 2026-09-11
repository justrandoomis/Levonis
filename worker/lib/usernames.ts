/**
 * What a customer may call themselves.
 *
 * A username is not a store slug. They look alike and they are deliberately
 * NOT the same identifier: a slug becomes a DNS label and a public hostname
 * (`ali3d.levonis-iq.com`), a username is a handle inside the platform and a
 * referral ref (`levonis-iq.com/?ref=ali3d`). Reserving `admin` as a hostname
 * and reserving `admin` as a handle protect against different things, so the
 * two lists live apart on purpose — `SYSTEM_SUBDOMAINS` in `hosts.ts` is
 * about who answers on a hostname; this list is about who a message appears
 * to be from.
 *
 * WHAT THIS LIST IS FOR. A username shows up next to content, in referral
 * links and in support conversations. A customer holding `levonis`,
 * `support`, `admin` or `official` can impersonate the platform to other
 * customers with nothing but their display name — no exploit required. Those
 * are refused. Ordinary names nobody could mistake for staff are not.
 */

/** Handles nobody but LEVONIS may hold. Lowercase, matched exactly. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // 1. THE PLATFORM ITSELF, and the near-spellings of it.
  'levonis', 'levonisiq', 'levonis_iq', 'levonis-iq', 'levo', 'levostudio',
  'levo_studio', 'levo-studio', 'official', 'officialy', 'levonisofficial',

  // 2. STAFF AND AUTHORITY. A message from `support` is read as a message
  //    from support.
  'admin', 'admins', 'administrator', 'moderator', 'mod', 'staff', 'team',
  'support', 'help', 'helpdesk', 'service', 'customerservice', 'security',
  'billing', 'payments', 'noreply', 'no-reply', 'postmaster', 'webmaster',
  'root', 'sysadmin', 'owner', 'ceo',

  // 3. PLATFORM SURFACES. A handle that reads like a section of the site.
  'levonisstore', 'store', 'shop', 'market', 'marketplace', 'community',
  'account', 'accounts', 'profile', 'settings', 'wallet', 'cart', 'checkout',
  'orders', 'order', 'invoice', 'invoices', 'studio', 'api', 'app', 'www',
  'auth', 'login', 'signin', 'signup', 'register', 'logout', 'verify',
  'reset', 'password', 'me', 'you', 'user', 'users', 'guest', 'anonymous',
  'null', 'undefined', 'system', 'bot', 'telegram', 'google',
]);

/** Syntax only — says nothing about whether the name is free or reserved. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
const SHAPE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type UsernameRejection =
  | 'too_short'
  | 'too_long'
  | 'bad_characters'
  | 'bad_edges'
  | 'repeated_punctuation'
  | 'reserved'
  | 'all_digits';

/**
 * The canonical form of what somebody typed: trimmed and lowercased.
 * Usernames are stored lowercase, so `Ali3D` and `ali3d` are one name and
 * cannot both be taken — the display form belongs to `users.name`.
 */
export function canonicalUsername(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Why a username cannot be used, or null when it can. Deliberately returns a
 * REASON rather than a boolean: "invalid" tells a person nothing, and the
 * three interesting cases (too short, wrong characters, reserved) each need
 * different words in three languages.
 */
export function usernameRejection(raw: string): UsernameRejection | null {
  const s = canonicalUsername(raw);
  // Reserved FIRST, and before the length rules on purpose. Some reserved
  // handles are shorter than the minimum (`me`, `id`), so a length check in
  // front of this one would report them as "too short" — a true statement
  // that sends somebody off to try `mee` when the real answer is that the
  // name belongs to the platform. It also keeps every entry in the list
  // meaningful instead of quietly unreachable.
  if (RESERVED_USERNAMES.has(s)) return 'reserved';
  if (s.length < USERNAME_MIN) return 'too_short';
  if (s.length > USERNAME_MAX) return 'too_long';
  if (!/^[a-z0-9._-]+$/.test(s)) return 'bad_characters';
  if (!SHAPE.test(s)) return 'bad_edges';
  // `a..b` and `a__b` are how one name is made to look like another.
  if (/[._-]{2,}/.test(s)) return 'repeated_punctuation';
  // An all-digit handle collides with the shape of an id in support threads.
  if (/^\d+$/.test(s)) return 'all_digits';
  return null;
}

export function isUsernameAvailableShape(raw: string): boolean {
  return usernameRejection(raw) === null;
}

/**
 * A first suggestion derived from an email address or a display name, for
 * the signup form to pre-fill. It is only ever a SUGGESTION: the caller still
 * has to check availability, and the person can always type their own.
 * Returns '' when nothing usable can be derived, rather than inventing one.
 */
export function suggestUsername(seed: string): string {
  const base = canonicalUsername(seed)
    .split('@')[0]
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, USERNAME_MAX);
  if (base.length < USERNAME_MIN) return '';
  if (usernameRejection(base) !== null) return '';
  return base;
}
