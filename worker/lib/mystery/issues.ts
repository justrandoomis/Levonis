/**
 * THE MYSTERY ENGINE'S SENTENCES — docs/BUNDLES_MYSTERY.md §11.3 and §15.3.
 *
 * Two audiences, two shapes, and they are deliberately different.
 *
 * THE ADMIN gets `BundleIssue` records — the shape both existing decoders
 * survive: `refusalIssues` renders `${line}${key}${message}` (an entry without
 * `message` prints the literal string "undefined") and `strList` keeps only
 * strings on the success path. `ar`/`en`/`ckb` carry all three languages for
 * the panel's trilingual `Banner`. Nothing here is ever repaired silently: an
 * empty pool, a zero weight and a pool too small for `forbid` are all SAID.
 *
 * THE CUSTOMER gets an `HttpError` whose one sentence carries all three
 * languages, because `HttpError` has one message field and the cart renders it
 * verbatim (`src/pages/Cart.tsx`).
 *
 * AND THE CUSTOMER REFUSALS CARRY NO NUMBERS (§7.5, §15.1). Naming how many
 * distinct choices exist would let a buyer binary-search their own `qty`
 * against the refusal and read back the exact count of currently eligible,
 * in-stock, distinct pool entries — on demand, repeatedly, for free, with no
 * purchase. A deterministic seed plus any oracle is a grinder, so the absence
 * of the oracle is part of the guarantee. The count lives in the ADMIN preview
 * and in the save-time `POOL_TOO_SMALL_FOR_FORBID` warning only.
 */

import { badRequest, conflict, unavailable, type HttpError } from '../http';
import type { BundleIssue } from '../bundleComposition';

/** The admin sentences, verbatim, in all three languages. `{…}` placeholders
 *  are filled from server-computed values — never from anything a browser
 *  sent. */
const MYSTERY_ISSUE_TEXT: Record<string, { ar: string; en: string; ckb: string }> = {
  // ---- warnings -----------------------------------------------------------
  POOL_EMPTY: {
    ar: 'هذه المجموعة لا تحتوي على أي مُدخل مؤهَّل الآن',
    en: 'this pool has no eligible entry right now',
    ckb: 'ئەم کۆمەڵەیە ئێستا هیچ تۆمارێکی شیاوی تێدا نییە',
  },
  POOL_ZERO_WEIGHT: {
    ar: '{n} من مُدخلات المجموعة وزنها صفر ولن تُسحب أبدًا',
    en: '{n} pool entries have weight 0 and can never be drawn',
    ckb: '{n} تۆماری کۆمەڵەکە کێشیان سفرە و هەرگیز هەڵنابژێردرێن',
  },
  NO_ELIGIBLE_DIRECT_INVENTORY: {
    ar: 'لا يوجد مخزون بيع مباشر مؤهَّل في هذه المجموعة',
    en: 'no eligible direct-sale inventory in this pool',
    ckb: 'هیچ کۆگایەکی فرۆشتنی ڕاستەوخۆی شیاو لەم کۆمەڵەیەدا نییە',
  },
  POOL_TOO_SMALL_FOR_FORBID: {
    ar: 'التكرار ممنوع لكن لا يوجد سوى {distinct} خيارًا مختلفًا لـ {spools} بكرات',
    en: 'duplicates are forbidden but only {distinct} distinct choices exist for {spools} spools',
    ckb: 'دووبارەبوونەوە قەدەغەیە بەڵام تەنها {distinct} هەڵبژاردەی جیاواز بۆ {spools} بۆبین هەیە',
  },
  POOL_ENTRY_DEACTIVATED: {
    ar: '{n} مُدخلًا خرجت من المجموعة فعُطِّلت بدل حذفها، لأنها سُحبت من قبل',
    en: '{n} entries left the set and were deactivated rather than deleted, because they have been drawn before',
    ckb: '{n} تۆمار لە کۆمەڵەکە دەرچوون و ناچالاک کران لە جیاتی سڕینەوە، چونکە پێشتر هەڵبژێردراون',
  },
  MYSTERY_POOL_MISSING: {
    ar: 'الوضع «{mode}» مفعَّل بلا مجموعة سحب',
    en: 'the {mode} mode is enabled with no pool to draw from',
    ckb: 'دۆخی «{mode}» چالاکە بەبێ کۆمەڵەیەک بۆ هەڵبژاردن',
  },

  // ---- refusals -----------------------------------------------------------
  MYSTERY_POOL_KIND_MISMATCH: {
    ar: 'مجموعة «{kind}» فقط تصلح لهذا الوضع — المجموعتان منفصلتان ولا تُخلطان أبدًا',
    en: 'only a {kind} pool fits this mode — the two pools are separate and never mixed',
    ckb: 'تەنها کۆمەڵەی «{kind}» بۆ ئەم دۆخە دەگونجێت — دوو کۆمەڵەکە جیاوازن و هەرگیز تێکەڵ ناکرێن',
  },
  MYSTERY_NO_MODE_ENABLED: {
    ar: 'يجب تفعيل وضع بيع واحد على الأقل: مباشر أو طلب مسبق',
    en: 'at least one sale mode must be enabled: direct or pre-order',
    ckb: 'دەبێت لانیکەم یەک دۆخی فرۆشتن چالاک بێت: ڕاستەوخۆ یان پێشداواکاری',
  },
  MYSTERY_SPOOLS_TOO_LARGE: {
    ar: '{spools} بكرة × {qty} لكل طلب تنتج {lines} سطرًا، والحد {max}',
    en: '{spools} spools × {qty} per order would produce {lines} physical lines, and the ceiling is {max}',
    ckb: '{spools} بۆبین × {qty} بۆ هەر داواکارییەک {lines} هێڵ دروست دەکات، سنووریش {max}ە',
  },
  POOL_IN_USE: {
    ar: 'هذه المجموعة مستعملة في {offers} عرضًا و{allocations} سحبًا — عُطِّلت بدل حذفها',
    en: 'this pool is used by {offers} offers and {allocations} past draws — it was deactivated instead of deleted',
    ckb: 'ئەم کۆمەڵەیە لە {offers} ئۆفەر و {allocations} هەڵبژاردنی پێشوودا بەکارهاتووە — ناچالاک کرا لە جیاتی سڕینەوە',
  },
  POOL_ENTRY_INVALID: {
    ar: 'المُدخل يشير إلى «{what}» غير موجود أو غير مسموح',
    en: 'the entry names {what}, which does not exist or is not allowed here',
    ckb: 'تۆمارەکە ئاماژە بە «{what}» دەکات، کە بوونی نییە یان لێرە ڕێپێدراو نییە',
  },
};

/** Builds one admin issue in the shape both decoders understand. */
export function mysteryIssue(
  code: string,
  vars: Record<string, string | number> = {},
  extra: { key?: string; entry_id?: string } = {}
): BundleIssue & { entry_id?: string } {
  const t = MYSTERY_ISSUE_TEXT[code] ?? { ar: code, en: code, ckb: code };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
  const en = fill(t.en);
  // The admin shell runs in English today, so `message` is the English
  // sentence; it is what `refusalIssues` prints and what `strList` keeps.
  return { code, message: en, ar: fill(t.ar), en, ckb: fill(t.ckb), ...extra };
}

/** Every code this module can say, so a test can walk the table. */
export const MYSTERY_ISSUE_CODES = Object.keys(MYSTERY_ISSUE_TEXT);

// ------------------------------------------------------- customer refusals

/**
 * The customer sentences. All three languages in one string because
 * `HttpError` carries exactly one message and the cart renders it verbatim.
 * NOT ONE OF THEM CARRIES A COUNT.
 */
export const MYSTERY_REFUSALS = {
  MYSTERY_NO_ELIGIBLE_STOCK: {
    ar: 'لا يوجد مخزون مؤهَّل لهذا العرض الآن',
    en: 'this offer has no eligible stock right now',
    ckb: 'ئێستا هیچ کۆگایەکی شیاو بۆ ئەم ئۆفەرە نییە',
  },
  MYSTERY_NOT_ENOUGH_VARIETY: {
    ar: 'التكرار ممنوع في هذا العرض ولا يوجد تنوّع كافٍ لهذا العدد',
    en: 'duplicates are not allowed on this offer and there is not enough variety for this quantity',
    ckb: 'دووبارەبوونەوە لەم ئۆفەرەدا ڕێپێدراو نییە و جۆراوجۆری پێویست بۆ ئەم ژمارەیە نییە',
  },
  MYSTERY_MODE_NOT_AVAILABLE: {
    ar: 'طريقة الشراء المطلوبة غير متاحة لهذا العرض',
    en: 'the requested purchase mode is not available for this offer',
    ckb: 'شێوازی کڕینی داواکراو بۆ ئەم ئۆفەرە بەردەست نییە',
  },
  MYSTERY_NOT_REVEALED: {
    ar: 'لم يُكشف محتوى هذا العرض بعد',
    en: 'the contents of this offer have not been revealed yet',
    ckb: 'ناوەڕۆکی ئەم ئۆفەرە هێشتا ئاشکرا نەکراوە',
  },
  MYSTERY_REVEALED_NO_CANCEL: {
    ar: 'لا يمكن إلغاء طلب كُشف محتواه العشوائي — تواصل مع الدعم',
    en: 'an order whose mystery pick has been revealed cannot be self-cancelled — contact support',
    ckb: 'داواکارییەک کە هەڵبژاردنی نهێنییەکەی ئاشکرا کراوە ناتوانرێت لەلایەن خۆتەوە هەڵبوەشێتەوە — پەیوەندی بە پشتگیرییەوە بکە',
  },
} as const;

export type MysteryRefusalCode = keyof typeof MYSTERY_REFUSALS;

/**
 * ONE LANGUAGE, NOT THREE RUN TOGETHER (§15.3).
 *
 * `HttpError` carries a single untranslated sentence, and the client localises
 * by CODE through `src/lib/refusalStrings.ts`. Concatenating all three
 * languages into the message put
 * «لا يوجد مخزون مؤهَّل … / this offer has no eligible stock right now / ئێستا هیچ …»
 * on one line in front of the customer at the moment of refusal, in three
 * scripts and two directions, whichever language they had chosen. The English
 * sentence is the fallback for a client that does not know the code; the code
 * is what every client actually renders.
 */
const sentence = (code: MysteryRefusalCode) => MYSTERY_REFUSALS[code].en;

/**
 * The refusal a customer sees. 503 for "nothing to sell" — the honest
 * out-of-stock answer, never invented inventory and never a silent conversion
 * of a direct purchase into a pre-order — 400 for the rest.
 */
export function mysteryRefusal(code: MysteryRefusalCode): HttpError {
  if (code === 'MYSTERY_NO_ELIGIBLE_STOCK') return unavailable(sentence(code), code);
  return badRequest(sentence(code), code);
}

/** 409, echoing `current` — the idiom `worker/routes/adminProducts.ts` uses, so
 *  the second of two admins editing one pool cannot silently destroy the
 *  first's work. */
export const staleEdit = () => conflict('this pool was modified by someone else since you opened it', 'STALE_EDIT');
