/**
 * EVERY CUSTOMER-FACING REFUSAL CODE, IN ALL THREE LANGUAGES
 * (docs/BUNDLES_MYSTERY.md §15.3).
 *
 * WHY THIS FILE EXISTS. `HttpError` carries ONE untranslated sentence
 * (`worker/lib/http.ts`), the cart renders `err.message` verbatim, and the
 * product page maps a code through `reasonText`, whose fallback is
 * `map[code] || code` — so a code nobody translated is printed to an Iraqi
 * customer as the literal string `BUNDLE_OPTIONAL_UNAVAILABLE`. That is not a
 * hypothetical: it is what the existing decoders do today with anything new.
 *
 * `tests/refusalStrings.test.ts` walks the contract's own table and fails if
 * any customer-facing code lacks an `ar`, an `en` AND a `ckb` string, so the
 * table in the contract and the strings in the app cannot drift apart.
 *
 * The sentences say what the customer can DO about it wherever there is
 * something to do — un-tick the optional part, choose again, come back when the
 * offer opens — because a refusal that only states a fact leaves them stuck on
 * the screen it appeared on.
 */
export interface RefusalStrings {
  ar: string;
  en: string;
  ckb: string;
}

export const REFUSAL_STRINGS: Record<string, RefusalStrings> = {
  // ---- eligibility and scheduling (§9) ------------------------------------
  MEMBERSHIP_REQUIRED: {
    ar: 'هذا العرض للأعضاء فقط. اشترك للوصول إليه.',
    en: 'This offer is for members only. Subscribe to unlock it.',
    ckb: 'ئەم ئۆفەرە تەنها بۆ ئەندامانە. بەشداری بکە بۆ کردنەوەی.',
  },
  OFFER_INACTIVE: {
    ar: 'هذا العرض غير متاح حاليًا.',
    en: 'This offer is not available right now.',
    ckb: 'ئەم ئۆفەرە ئێستا بەردەست نییە.',
  },
  OFFER_WINDOW_NOT_STARTED: {
    ar: 'لم يبدأ هذا العرض بعد.',
    en: 'This offer has not started yet.',
    ckb: 'ئەم ئۆفەرە هێشتا دەستی پێنەکردووە.',
  },
  OFFER_WINDOW_EXPIRED: {
    ar: 'انتهى هذا العرض.',
    en: 'This offer has ended.',
    ckb: 'ئەم ئۆفەرە کۆتایی هات.',
  },
  PER_USER_LIMIT_REACHED: {
    ar: 'لقد استخدمت هذا العرض بالحد الأقصى المسموح لك.',
    en: 'You have already used this offer the maximum number of times.',
    ckb: 'تۆ ئەم ئۆفەرەت بە زۆرترین ژمارەی ڕێپێدراو بەکارهێناوە.',
  },
  GLOBAL_LIMIT_REACHED: {
    ar: 'وصل هذا العرض إلى حده الأقصى.',
    en: 'This offer has reached its limit.',
    ckb: 'ئەم ئۆفەرە گەیشتە سنووری خۆی.',
  },

  // ---- composition (§15.3) -----------------------------------------------
  BUNDLE_QTY_LIMIT: {
    ar: 'تجاوزت الحد الأقصى لعدد هذه الحزمة في الطلب الواحد.',
    en: 'That is more of this bundle than one order may hold.',
    ckb: 'لە ژمارەی ڕێپێدراوی ئەم پاکێجە زیاترە بۆ یەک داواکاری.',
  },
  BUNDLE_CHOICE_INVALID: {
    ar: 'أحد اختياراتك لم يعد متاحًا — افتح الحزمة واختر من جديد.',
    en: 'One of your choices is no longer offered — reopen the bundle and choose again.',
    ckb: 'یەکێک لە هەڵبژاردەکانت چیتر بەردەست نییە — پاکێجەکە بکەرەوە و دیسان هەڵبژێرە.',
  },
  BUNDLE_CHOICE_NOT_ALLOWED: {
    ar: 'هذا الجزء محدَّد مسبقًا في الحزمة ولا يمكن تغييره.',
    en: 'That part is fixed by the bundle and cannot be changed.',
    ckb: 'ئەم بەشە لەلایەن پاکێجەکەوە دیاریکراوە و ناگۆڕدرێت.',
  },
  BUNDLE_COMPOSITION_CHANGED: {
    ar: 'تغيّرت محتويات هذه الحزمة — افتحها واختر من جديد.',
    en: 'This bundle’s contents changed — reopen it and choose again.',
    ckb: 'ناوەڕۆکی ئەم پاکێجە گۆڕا — بیکەرەوە و دیسان هەڵبژێرە.',
  },
  BUNDLE_OPTIONAL_UNAVAILABLE: {
    ar: 'القطعة الاختيارية التي أضفتها غير متوفرة — أزلها ثم أعد المحاولة.',
    en: 'The optional item you added is not available — remove it and try again.',
    ckb: 'ئەو پارچە ئارەزوومەندانەیەی زیادت کرد بەردەست نییە — لایبە و دووبارە هەوڵ بدە.',
  },
  BUNDLE_SHIPPING_MIXED: {
    ar: 'قطع هذه الحزمة لا تشترك في طريقة شحن واحدة.',
    en: 'The items in this bundle do not share one shipping method.',
    ckb: 'پارچەکانی ئەم پاکێجە یەک شێوازی گەیاندنیان نییە.',
  },
  // The checkout key. Globally unique before migration 0064, per-user after
  // it: a key another account had spent used to fail this account's checkout
  // with an untranslatable "please try again" it could never escape.
  IDEMPOTENCY_KEY_REUSED: {
    ar: 'انتهت صلاحية جلسة الدفع هذه. ارجع إلى السلة وابدأ الدفع من جديد.',
    en: 'This checkout session has expired. Go back to the cart and start the checkout again.',
    ckb: 'ئەم دانیشتنی پارەدانە بەسەرچووە. بگەڕێوە بۆ سەبەتەکە و پارەدان لە سەرەتاوە دەست پێ بکەوە.',
  },
  BUNDLE_PARTIAL_RETURN_NOT_ALLOWED: {
    ar: 'يمكن إرجاع الحزمة كاملة فقط، وليس قطعة منها.',
    en: 'A bundle can only be returned whole, not one part of it.',
    ckb: 'پاکێج تەنها بە تەواوی دەگەڕێتەوە، نەک یەک پارچەی.',
  },
  COMPOSITION_TOO_LARGE: {
    ar: 'هذا الطلب يحتوي على قطع أكثر مما يمكن معالجته — قسّمه إلى طلبين.',
    en: 'This order holds more individual items than one order may carry — please split it in two.',
    ckb: 'ئەم داواکارییە پارچەی زیاتری تێدایە لەوەی دەکرێت — تکایە بیکە بە دوو داواکاری.',
  },
  COMPOSITION_NOT_ELIGIBLE: {
    ar: 'الحزمة نفسها غير مشمولة بحماية السعر — قطعها مشمولة كلٌّ على حدة.',
    en: 'A bundle is not price-protected as a whole — its parts are covered individually.',
    ckb: 'پاکێج بە تەواوی پارێزراو نییە لە نرخدا — پارچەکانی بە جیا پارێزراون.',
  },

  // ---- the mystery offer (§15.3) -----------------------------------------
  MYSTERY_NO_ELIGIBLE_STOCK: {
    ar: 'لا يوجد مخزون متاح لهذا العرض الآن.',
    en: 'There is no eligible stock for this offer right now.',
    ckb: 'ئێستا هیچ کۆگایەکی گونجاو بۆ ئەم ئۆفەرە نییە.',
  },
  MYSTERY_NOT_ENOUGH_VARIETY: {
    ar: 'لا يمكن تجهيز هذا العدد بخيارات مختلفة الآن — جرّب عددًا أقل.',
    en: 'That many different choices cannot be filled right now — try a smaller quantity.',
    ckb: 'ئەو هەموو هەڵبژاردە جیاوازە ئێستا ناکرێت — ژمارەیەکی کەمتر تاقی بکەرەوە.',
  },
  MYSTERY_MODE_NOT_AVAILABLE: {
    ar: 'طريقة الشراء المطلوبة غير متاحة لهذا العرض.',
    en: 'That way of buying is not available for this offer.',
    ckb: 'ئەو شێوازی کڕینە بۆ ئەم ئۆفەرە بەردەست نییە.',
  },
  MYSTERY_NOT_REVEALED: {
    ar: 'لم يُكشف محتوى هذا العرض بعد.',
    en: 'What you received has not been revealed yet.',
    ckb: 'ئەوەی وەرتگرتووە هێشتا ئاشکرا نەکراوە.',
  },
  MYSTERY_REVEALED_NO_CANCEL: {
    ar: 'لا يمكن إلغاء طلب ظهر محتواه — تواصل مع الدعم.',
    en: 'An order whose contents have been revealed cannot be cancelled — contact support.',
    ckb: 'داواکارییەک کە ناوەڕۆکی ئاشکرا بووە هەڵناوەشێتەوە — پەیوەندی بە پشتگیری بکە.',
  },
};

export type Lang = 'ar' | 'en' | 'ckb';

/**
 * The customer's sentence for a refusal code, or the server's own message when
 * the code is one this table does not own (every reused code — `OUT_OF_STOCK`,
 * `CART_SHIPPING_CONFLICT`, … — already has a sentence elsewhere). Never the
 * bare identifier: that is the failure this table exists to prevent.
 */
export function refusalText(code: string | null | undefined, lang: Lang, fallback = ''): string {
  if (!code) return fallback;
  const entry = REFUSAL_STRINGS[code];
  if (!entry) return fallback;
  return entry[lang] || entry.en;
}

/**
 * THE SAME ANSWER, FOR ANY DOOR THAT CATCHES AN `ApiError`.
 *
 * `refusalText` was wired to exactly one call site, so every other customer
 * door rendered the server's raw sentence: an Arabic or Sorani customer at the
 * last screen before payment read English prose wrapped around an Arabic
 * product name, with the machine code in parentheses. This is the helper each
 * of those doors calls instead — the checkout, the cancel sheet, the returns
 * and price-protection screens, and the bundle page's add-to-cart.
 *
 * It duck-types the error rather than importing `ApiError`, so this module
 * stays dependency-free and cannot introduce an import cycle with `api.ts`.
 */
export function apiRefusal(err: unknown, lang: Lang, fallback = ''): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  const message = e && typeof e.message === 'string' && e.message ? e.message : fallback;
  return refusalText(code, lang, message || fallback);
}
