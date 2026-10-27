/**
 * Where cloud.<root>'s /auth sends a visitor (src/cloud/auth.tsx): the apex's
 * /auth, carrying the sanitized destination, `app=cloud`, and a language only
 * when the reader CHOSE one (src/LanguageContext.tsx `chosenLang`) — a first
 * visit's default must not overwrite the apex's own stored choice. Everything
 * else the link carried (a referral code…) travels as it came; a `store` it
 * carried does not.
 *
 * On the apex, src/pages/Auth.tsx turns `app=cloud` back into
 * `https://cloud.<root><next>` through the allowlist of
 * src/components/auth/storeReturn.ts (`appReturnUrl`). Pure, no React: the
 * tests read it directly.
 */
import { sanitizeNextPath } from '../components/auth/nextPath';

/** The one application label this app signs in under (storeReturn.ts `RETURN_APPS`). */
export const CLOUD_APP_LABEL = 'cloud';

export function cloudHandoffUrl(mainSite: string, search: string, from: unknown, lang: string | null): string {
  const q = new URLSearchParams(search);
  q.set('next', sanitizeNextPath(from ?? q.get('next') ?? '/'));
  q.delete('store');
  q.set('app', CLOUD_APP_LABEL);
  q.delete('lang');
  if (lang === 'ar' || lang === 'en' || lang === 'ckb') q.set('lang', lang);
  return `${mainSite}/auth?${q.toString()}`;
}
