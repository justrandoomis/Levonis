/**
 * How complete an account is — computed, never stored.
 *
 * THE FRAGILE VERSION THIS REPLACES would have been one boolean on the user
 * row, set by whichever code path happened to remember. Every later edit —
 * an avatar upload, a username change from the account page, a Telegram link
 * that fills in the phone — is a chance for the flag and the fields to
 * disagree, and when they disagree the person is shown "complete your
 * profile" over a profile that is complete. So completion is derived from the
 * fields themselves on every read. There is nothing to keep in sync.
 *
 * WHAT COUNTS, AND WHAT DOES NOT. Only things the platform genuinely uses:
 * a name to address them by, a handle for referrals and public content, an
 * avatar, a language, a country, and a phone. Birth date and gender are NOT
 * here — the platform does not need them, and putting them in the score
 * would turn "complete your profile" into pressure to hand over data for
 * nothing. Nothing in this list is required to browse, buy, or hold an
 * account.
 *
 * A NOTE ON THE PLACEHOLDER EMAIL. An account created through Telegram has
 * no real address — it carries the documented non-routable placeholder
 * `tg-<id>@telegram.local`. For those accounts "add an email" is a real,
 * useful step; for everybody else the email already exists and is not asked
 * for again.
 */

export const PROFILE_FIELDS = [
  'name',
  'username',
  'avatar',
  'locale',
  'country',
  'phone',
  'email',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** The subset of a user row completion actually reads. */
export interface ProfileInput {
  name?: string | null;
  username?: string | null;
  avatar_key?: string | null;
  locale?: string | null;
  country?: string | null;
  phone_e164?: string | null;
  email?: string | null;
  onboarding_state?: string | null;
  profile_prompt_at?: string | null;
  profile_prompt_count?: number | null;
}

export interface ProfileCompletion {
  /** 0–100, rounded. */
  percent: number;
  complete: boolean;
  /** Present fields, in PROFILE_FIELDS order. */
  have: ProfileField[];
  /** Missing fields, in the order worth asking for them. */
  missing: ProfileField[];
  onboarding: 'new' | 'existing' | 'skipped' | 'done';
}

/** A Telegram-signup placeholder is not an email anyone can be reached at. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith('@telegram.local');
}

function present(u: ProfileInput, field: ProfileField): boolean {
  switch (field) {
    case 'name':
      return typeof u.name === 'string' && u.name.trim().length >= 2;
    case 'username':
      return typeof u.username === 'string' && u.username.trim().length > 0;
    case 'avatar':
      return typeof u.avatar_key === 'string' && u.avatar_key.trim().length > 0;
    case 'locale':
      return typeof u.locale === 'string' && u.locale.trim().length > 0;
    case 'country':
      return typeof u.country === 'string' && /^[A-Za-z]{2}$/.test(u.country.trim());
    case 'phone':
      return typeof u.phone_e164 === 'string' && u.phone_e164.trim().length > 0;
    case 'email':
      return typeof u.email === 'string' && u.email.trim().length > 0 && !isPlaceholderEmail(u.email);
  }
}

/**
 * The order the missing pieces are worth asking for: the two that change what
 * other people see (`username`, `avatar`) come first, then the ones the
 * platform uses to serve them, then the phone — which is last because
 * supplying it means going through Telegram verification, and leading with
 * the longest task is how a prompt gets dismissed forever.
 */
const ASK_ORDER: ProfileField[] = ['username', 'avatar', 'name', 'country', 'email', 'locale', 'phone'];

export function computeCompletion(u: ProfileInput): ProfileCompletion {
  const have = PROFILE_FIELDS.filter((f) => present(u, f));
  const missing = ASK_ORDER.filter((f) => !present(u, f));
  const percent = Math.round((have.length / PROFILE_FIELDS.length) * 100);
  const raw = String(u.onboarding_state ?? 'new');
  const onboarding = (['new', 'existing', 'skipped', 'done'] as const).includes(raw as never)
    ? (raw as ProfileCompletion['onboarding'])
    : 'new';
  return { percent, complete: missing.length === 0, have, missing, onboarding };
}

/**
 * How long before the completion prompt may appear again, given how many
 * times it has already been dismissed. Widening rather than repeating: a
 * person who has said "later" four times has answered the question.
 * The last value repeats forever — the prompt never disappears entirely,
 * because the profile page is not somewhere people go unprompted, but at
 * ninety-day spacing it is a reminder rather than an obstacle.
 */
const REMIND_AFTER_DAYS = [3, 7, 30, 90];

export function nextPromptAt(dismissCount: number, now: Date): string {
  const idx = Math.min(Math.max(dismissCount, 0), REMIND_AFTER_DAYS.length - 1);
  const days = REMIND_AFTER_DAYS[idx];
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * Should the completion prompt be shown right now?
 *
 * Four things must all be true, and each rules out a way of being annoying:
 * there is something left to complete; the account is past onboarding (a
 * person still IN the signup wizard is already being asked); the cooling-off
 * period from the last dismissal has passed; and — the one that matters most
 * — this is decided from a server-side timestamp, so dismissing on a phone
 * also dismisses on a laptop, and clearing site data does not restart the
 * nagging.
 */
export function shouldPromptCompletion(u: ProfileInput, now: Date): boolean {
  const c = computeCompletion(u);
  if (c.complete) return false;
  if (c.onboarding === 'new') return false; // the wizard is asking already
  const at = u.profile_prompt_at;
  if (!at) return true; // never asked
  const t = Date.parse(at);
  return Number.isNaN(t) ? true : t <= now.getTime();
}
