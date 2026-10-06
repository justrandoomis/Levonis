/**
 * THE SENTENCE FOR A FAILED ADMIN ACTION, in the admin's language.
 *
 * Admin-only codes come from this section's own table (strings.ts). A
 * customer-facing code an admin door can also answer with (GIFT_ALREADY_ORDERED,
 * GIFT_SALE_TYPE_UNAVAILABLE, OUT_OF_STOCK…) is read from the shared
 * src/lib/refusalStrings.ts, loaded only on that first failure so the panel
 * never carries the whole refusal table up front. No answer at all means the
 * outcome is unknown — the sentence says a retry is safe, because every issue
 * retry carries the same requestId.
 */
import { errorFacts } from './model';
import { adminRefusal, adminStrings } from './strings';

export async function errorText(e: unknown, lang: string): Promise<string> {
  const S = adminStrings(lang);
  const { status, code, message } = errorFacts(e);
  const admin = adminRefusal(code, lang);
  if (admin) return admin;
  if (code === 'RATE_LIMITED' || status === 429) return S.errors.rateLimited;
  if (status === 0) return S.errors.network;
  if (code) {
    try {
      const mod = await import('../../lib/refusalStrings');
      const shared = mod.refusalText(code, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar', '');
      if (shared) return shared;
    } catch {
      /* the table did not load; fall through to the generic sentence */
    }
  }
  if (status === 409) return S.errors.conflict;
  if (lang === 'en' && message) return message;
  return S.errors.generic;
}
