/**
 * THE HANDLE RULES, AS THE FORM SEES THEM.
 *
 * A DELIBERATE MIRROR of `worker/lib/usernames.ts`, not an import. `src/` does
 * not reach into `worker/` anywhere in this codebase, and the boundary checks
 * exist to keep it that way: the client bundle is served to everyone and the
 * Worker's modules are free to grow server-only dependencies without anyone
 * thinking about who else is compiling them.
 *
 * The cost of a mirror is drift, and `tests/usernameRuleParity.test.ts` is what
 * pays it: it imports BOTH and asserts they return the same verdict across the
 * shapes people actually type, so the two cannot disagree without a red test.
 *
 * WHY THIS EXISTS AT ALL. The form used to check `/^[a-zA-Z0-9._-]{3,30}$/`,
 * which accepts `_ali`, `ali.`, `ali__b` and `12345` — every one of which the
 * server refuses. Worse, that check GATED the live availability lookup, so a
 * person typing `ali__b` got no feedback at all while typing and a flat refusal
 * on submit. The reasons were already written and translated into all three
 * languages; nothing was reaching them.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

export type UsernameRejection =
  | 'too_short'
  | 'too_long'
  | 'bad_characters'
  | 'bad_edges'
  | 'repeated_punctuation'
  | 'reserved'
  | 'all_digits';

/**
 * Names the platform keeps for itself.
 *
 * Mirrors RESERVED_USERNAMES in worker/lib/usernames.ts. The server is still
 * the authority — it re-checks on register, and the live availability endpoint
 * answers `reserved` — so a name added there and forgotten here is refused a
 * moment later rather than let through. The parity test keeps the lists equal.
 */
const RESERVED = new Set([
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

const SHAPE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Trimmed and lowercased — handles are stored lowercase, so `Ali3D` is `ali3d`. */
export function canonicalUsername(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Why this handle cannot be used, or null when it can — the same ORDER as the
 * server's, which matters: `reserved` is tested before the length rules so
 * short reserved names (`me`, `id`) report what is actually wrong with them
 * instead of sending someone off to try `mee`.
 */
export function usernameRejection(raw: string): UsernameRejection | null {
  const s = canonicalUsername(raw);
  if (RESERVED.has(s)) return 'reserved';
  if (s.length < USERNAME_MIN) return 'too_short';
  if (s.length > USERNAME_MAX) return 'too_long';
  if (!/^[a-z0-9._-]+$/.test(s)) return 'bad_characters';
  if (!SHAPE.test(s)) return 'bad_edges';
  if (/[._-]{2,}/.test(s)) return 'repeated_punctuation';
  if (/^\d+$/.test(s)) return 'all_digits';
  return null;
}

/** The reserved list, for the parity test. Not for rendering. */
export const RESERVED_USERNAMES_MIRROR: ReadonlySet<string> = RESERVED;
