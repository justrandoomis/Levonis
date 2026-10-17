/**
 * THE API CLIENT'S OWN SENTENCES, IN THE READER'S LANGUAGE (docs/DECISIONS.md
 * row 183: every user-facing string in Arabic, English and Sorani; a `ckb`
 * slot never carries the Arabic).
 *
 * `requestRaw` (src/lib/api.ts), the primed boot requests (bootFetch.ts) and
 * the upload sessions (uploadSession.ts) build an `ApiError` for the failures
 * the SERVER cannot word — no answer at all, an answer that is not JSON, a
 * status with no sentence, the client's own deadline — and every screen shows
 * `e.message` as it is. They were English only, so an Arabic or Kurdish owner
 * read «Network error — check your connection and try again» in the middle of
 * an Arabic form.
 *
 * THE DEADLINE IS NOT THE NETWORK. A request the client stopped waiting for is
 * not a request that failed: the server may still be finishing it. It has its
 * own code (`TIMEOUT`) and sentence, so a write's caller can find out what
 * happened before it says anything (src/components/adminProducts/saveOutcome.ts).
 *
 * The language is the one the app renders in: `LanguageProvider` writes it to
 * `<html lang>` on every switch (src/LanguageContext.tsx). This module imports
 * nothing, so the boot path stays as light as it was. Without a document (a
 * unit test, a server render) the sentences are English, as they always were.
 */

export type RequestLang = 'ar' | 'en' | 'ckb';

export type RequestErrorKey = 'network' | 'timeout' | 'invalid' | 'server' | 'cancelled';

export const REQUEST_ERROR_TEXT: Record<RequestErrorKey, Record<RequestLang, string>> = {
  network: {
    ar: 'تعذّر الاتصال بالخادم — تحقّق من اتصالك ثم أعد المحاولة.',
    en: 'Network error — check your connection and try again',
    ckb: 'پەیوەندی بە ڕاژەکارەوە نەکرا — هێڵی ئینتەرنێتەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
  },
  timeout: {
    ar: 'لم يصل ردّ الخادم في الوقت المحدد — تحقّق من اتصالك ثم أعد المحاولة.',
    en: 'The server did not answer in time — check your connection and try again.',
    ckb: 'وەڵامی ڕاژەکار لە کاتی خۆیدا نەگەیشت — هێڵی ئینتەرنێتەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
  },
  invalid: {
    ar: 'وصل من الخادم ردّ غير صالح.',
    en: 'Invalid server response',
    ckb: 'وەڵامێکی نادروست لە ڕاژەکارەوە گەیشت.',
  },
  server: {
    ar: 'خطأ في الخادم ({status}) — أعد المحاولة بعد قليل.',
    en: 'Server error ({status}) — try again in a moment.',
    ckb: 'هەڵەی ڕاژەکار ({status}) — کەمێکی تر دووبارە هەوڵ بدەرەوە.',
  },
  cancelled: {
    ar: 'أُلغي الطلب',
    en: 'Request cancelled',
    ckb: 'داواکارییەکە هەڵوەشێنرایەوە',
  },
};

/** The language the page renders in: `<html lang>`, kept by LanguageProvider; English without a document. */
export function requestLang(): RequestLang {
  try {
    if (typeof document === 'undefined') return 'en';
    const lang = document.documentElement?.lang ?? '';
    if (lang === 'en' || lang === 'ckb') return lang;
    if (lang === 'ku') return 'ckb';
    return 'ar';
  } catch {
    return 'en';
  }
}

/** The client's own sentence for `key`, in the reader's language (`status` fills «{status}»). */
export function requestErrorText(key: RequestErrorKey, status?: number, lang: RequestLang = requestLang()): string {
  const text = REQUEST_ERROR_TEXT[key][lang];
  return status === undefined ? text : text.replace('{status}', String(status));
}
