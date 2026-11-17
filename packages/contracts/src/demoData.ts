/**
 * COMMUNITY DEMO DATA — the one mark every demo row carries.
 *
 * The owner seeds a closed Levo Community with realistic test content and
 * removes all of it in one action (worker/lib/communityDemo.ts, the admin
 * card «بيانات تجريبية»). Nothing marks a row as demo except its PRIMARY ID:
 * every demo row's id starts with `demo_`, followed by the same shape
 * `newId()` mints (`usr_`, `prj_`, `req_`… and twenty characters). No column,
 * no migration: an id is server-minted and immutable, so the mark cannot be
 * acquired or dropped by anything a user writes, and `newId()` never mints
 * an id that starts with `demo`.
 *
 * The server keys every exclusion and the removal off this prefix; the
 * community UI keys its «تجريبي» badge off it through `isDemoId`.
 */
export const DEMO_ID_PREFIX = 'demo_';

/** The reserved address domain of demo accounts. `.invalid` (RFC 2606) never resolves. */
export const DEMO_EMAIL_DOMAIN = 'demo.levonis.invalid';

/** Is this a demo row's id? Anything that is not a string is not. */
export function isDemoId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(DEMO_ID_PREFIX);
}

/** Is this the address of a demo account? */
export function isDemoEmail(email: unknown): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}
