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
  /** Staging safety: comma-separated allowlist; when set, outbound email is
   *  only sent to these addresses (other requests behave normally but skip
   *  the send). Leave unset in production. */
  EMAIL_ALLOWED_RECIPIENTS?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: 'customer' | 'merchant' | 'admin';
  is_investor: number;
  subscription_plan: 'free' | 'plus' | 'pro';
  subscription_expiry: number;
  subscription_cost_iqd: number;
  subscription_days: number;
  locale: 'en' | 'ar' | 'ku';
  avatar_key: string | null;
  bio: string;
  website: string;
  profile_json: string;
  checkin_streak: number;
  last_checkin_day: string | null;
  created_at: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    user: SessionUser | null;
    sessionId: string | null;
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
    subscription_plan: u.subscription_plan,
    subscription_expiry: u.subscription_expiry,
    locale: localeToApi(u.locale),
    avatar_key: u.avatar_key,
    bio: u.bio,
    website: u.website,
    profile: safeParse(u.profile_json, {}),
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
