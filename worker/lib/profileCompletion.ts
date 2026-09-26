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
 * Should the «أكمل ملفك الشخصي» sheet be shown right now?
 *
 * ONCE PER ACCOUNT, RIGHT AFTER IT IS CREATED. The owner: «اجعل اكمال الملف
 * الشخصي تظهر بعد انشاء الحساب لمره واحده (سواء كان عبر كوكل او رقم او تلي او
 * اي وسيله)». It used to be a reminder on a widening schedule (3, 7, 30, 90
 * days, forever) that skipped every account still in the signup wizard — and
 * only an email or on-the-signup-view Google signup ever reached the wizard,
 * so an account made by phone, Telegram, or Google from the sign-in view sat
 * at 'new' and was never asked at all. Now every signup path lands on the
 * same sheet, and the sheet asks once:
 *
 *  - `onboarding_state = 'new'`: the column's DEFAULT, so every INSERT into
 *    users — whichever route made it — starts here, and migration 0033 moved
 *    every account that existed then to 'existing'. Leaving 'new' (the sheet
 *    closed, the wizard finished or skipped) is forever.
 *  - `profile_prompt_at IS NULL`: stamped the moment the sheet is SHOWN
 *    (POST /completion/seen), so a sheet the person walked away from — the tab
 *    closed on it, «أكمل الآن» into a wizard they then abandoned — does not
 *    come back either. Server-side, so it holds on every device.
 *  - something is actually missing: a sheet reading 100% asks for nothing.
 */
export function shouldPromptCompletion(u: ProfileInput): boolean {
  const c = computeCompletion(u);
  if (c.complete) return false;
  if (c.onboarding !== 'new') return false; // answered, or an account from before the question existed
  return !u.profile_prompt_at;
}
