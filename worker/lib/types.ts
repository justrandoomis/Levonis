import type { HostInfo } from './hosts';
import { computeCompletion } from './profileCompletion';
import { maskPhone } from './phone';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  INITIAL_ADMIN_EMAIL: string;
  EXTRA_ALLOWED_ORIGINS: string;
  // Optional secrets — features stay honestly disabled until configured.
  GEMINI_API_KEY?: string;
  EMAIL_API_KEY?: string; // e.g. a Resend API key, enables password-reset email
  EMAIL_FROM?: string;
  TELEGRAM_BOT_TOKEN?: string; // admin notifications bot
  TELEGRAM_ADMIN_CHAT_ID?: string; // chat/channel the bot posts into
  /** Trusted absolute origin for links in emails (per environment). Never
   *  derive email links from the request Host header. */
  APP_ORIGIN?: string;
  /** The registrable domain merchant storefronts live under, e.g.
   *  "levonis-iq.com". Drives subdomain resolution and the shared session
   *  cookie. Derived from APP_ORIGIN when unset; when NEITHER is set no host
   *  is ever treated as a merchant, which is the safe direction — the
   *  platform refuses to guess which domain it is rather than believing the
   *  Host header. */
  STORE_ROOT_DOMAIN?: string;
  /** Staging safety: comma-separated allowlist; when set, outbound email is
   *  only sent to these addresses (other requests behave normally but skip
   *  the send). Leave unset in production. */
  EMAIL_ALLOWED_RECIPIENTS?: string;
  /** Secret compared against Telegram's X-Telegram-Bot-Api-Secret-Token
   *  webhook header; the webhook stays honestly disabled until set. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** KYC evidence encryption key, format "v1:<base64 32 bytes>" (see
   *  lib/sealbox.ts). KYC submission stays disabled until set. */
  KYC_ENC_KEY?: string;
  /** LEVO Studio sign-in handoff (routes/studio.ts). Shared secret the Studio
   *  worker presents on the server-to-server code exchange; handoff endpoints
   *  answer honest 503s until it is set per environment. Never logged. */
  STUDIO_HANDOFF_SECRET?: string;
  /** Comma-separated exact origins allowed as Studio handoff destinations,
   *  e.g. "https://studio.levonis-iq.com". Empty = handoff disabled. */
  STUDIO_ALLOWED_DESTINATIONS?: string;
  /** Al-Waseet Merchant API credentials. SECRETS, never settings rows and
   *  never serialized: the owner's rule is "لا تكشف بيانات الدخول أو الـtoken
   *  في Frontend", and a settings row is readable by every admin screen.
   *  Delivery integration stays honestly disabled until all three are set. */
  ALWASEET_BASE_URL?: string;
  ALWASEET_USERNAME?: string;
  ALWASEET_PASSWORD?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: 'customer' | 'merchant' | 'admin';
  is_investor: number;
  /** LEGACY cache (pre-0018). Its CHECK admits only free/plus/pro, so a PRIME
   *  member reads 'free' here. Never branch on it — use membership_tier. */
  subscription_plan: 'free' | 'plus' | 'pro';
  /** Effective tier cache written by getTierStatus from the memberships
   *  ledger. Unconstrained column, so it can carry 'prime'. */
  membership_tier: 'free' | 'plus' | 'pro' | 'prime';
  /** NULL/'full' = unrestricted admin; 'assistant' = no financial data
   *  anywhere (migration 0021, mandate §11). */
  admin_scope: string | null;
  subscription_expiry: number;
  subscription_cost_iqd: number;
  subscription_days: number;
  locale: 'en' | 'ar' | 'ku';
  avatar_key: string | null;
  bio: string;
  website: string;
  profile_json: string;
  /** Google account subject when this account has Google sign-in linked.
   *  NEVER leaves the server — publicUser exposes only whether it is set. */
  google_sub?: string | null;
  /** ISO 3166-1 alpha-2, or null when the person has not said (0033). */
  country: string | null;
  /** The account's own verified phone, E.164. NULL until Telegram proves it. */
  phone_e164: string | null;
  /** 'new' | 'existing' | 'skipped' | 'done' — the signup wizard, not the
   *  profile. A finished wizard with every optional step skipped is 'done'
   *  AND an incomplete profile; they are separate questions (0033). */
  onboarding_state: string | null;
  /** Earliest moment the completion prompt may appear again. Server-side on
   *  purpose: a dismissal in one browser is a dismissal everywhere (0033). */
  profile_prompt_at: string | null;
  profile_prompt_count: number;
  checkin_streak: number;
  last_checkin_day: string | null;
  created_at: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    user: SessionUser | null;
    sessionId: string | null;
    /** When the current session was created (ISO 8601), or null when signed out. */
    sessionCreatedAt: string | null;
    /** Set once per request by the host middleware in worker/index.ts.
     *  Every merchant-scoped route reads it instead of re-parsing the Host,
     *  so there is exactly one place where a hostname becomes a decision. */
    host: HostInfo;
  };
};

/** DB stores Iraqi Kurdish as 'ku'; the API speaks 'ckb' (Sorani). */
export function localeToApi(dbLocale: string): 'ar' | 'en' | 'ckb' {
  if (dbLocale === 'ku' || dbLocale === 'ckb') return 'ckb';
  return dbLocale === 'ar' ? 'ar' : 'en';
}
export function localeToDb(apiLocale: string): 'ar' | 'en' | 'ku' {
  if (apiLocale === 'ckb' || apiLocale === 'ku') return 'ku';
  return apiLocale === 'ar' ? 'ar' : 'en';
}

function completionSummary(u: SessionUser) {
  const c = computeCompletion(u as never);
  return { percent: c.percent, complete: c.complete, missing: c.missing };
}

/** Shape sent to the frontend — never includes password_hash or google_sub. */
export function publicUser(u: SessionUser) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role,
    isAdmin: u.role === 'admin',
    is_investor: !!u.is_investor,
    // Both are sent during the rollout: subscription_plan for any client build
    // still in the wild, membership_tier as the value every current surface
    // reads. A PRIME member is 'free' in the legacy field and 'prime' here.
    subscription_plan: u.subscription_plan,
    membership_tier: u.membership_tier ?? u.subscription_plan ?? 'free',
    // Sent so the admin UI can hide financial panels it would not be allowed
    // to fill anyway. The SERVER is what actually enforces the rule.
    admin_scope: u.role === 'admin' ? (u.admin_scope ?? 'full') : null,
    can_view_financials: u.role === 'admin' && u.admin_scope !== 'assistant',
    subscription_expiry: u.subscription_expiry,
    locale: localeToApi(u.locale),
    avatar_key: u.avatar_key,
    bio: u.bio,
    website: u.website,
    profile: safeParse(u.profile_json, {}),
    country: u.country ?? null,
    // WHETHER, never WHICH. The account page needs to show "Google —
    // connected"; the Google subject itself is an identifier for that person
    // at Google and has no business in a JSON response.
    has_google: !!u.google_sub,
    // The phone is the account's own verified identity — MASKED here, because
    // the frontend only ever needs to show "we have a number for you", and a
    // full number sitting in a JSON response is a number that ends up in a
    // log, a screenshot or a support ticket.
    phone: u.phone_e164 ? maskPhone(u.phone_e164) : null,
    has_phone: !!u.phone_e164,
    // Signup-wizard state and profile completion travel with the user object
    // so every surface reads the same answer. `completion` is derived from
    // the fields on every read, never stored (see lib/profileCompletion.ts).
    onboarding: (u.onboarding_state ?? 'new') as string,
    completion: completionSummary(u),
    checkin_streak: u.checkin_streak,
    last_checkin_day: u.last_checkin_day,
    created_at: u.created_at,
  };
}

export function safeParse<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
