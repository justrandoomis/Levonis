/**
 * THE REFUSALS OF THE COMPLETENESS AND HIDE-SWITCH ROUTES, by code, in the
 * three languages. Split from ./productCompleteness.ts (which re-exports them)
 * so the client's refusal table can import them without the completeness
 * list itself, whose private entries name the owner's pricing data
 * (DECISIONS row 220). Pure data: no imports.
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183).
 */
export interface CompletenessRefusalText {
  ar: string;
  en: string;
  ckb: string;
}

/** The refusals of the completeness and hide-switch routes (the client renders them by code). */
export const COMPLETENESS_REFUSALS = {
  COMPLETENESS_NOT_INSTALLED: {
    ar: 'فحص اكتمال المنتجات غير مثبّت على قاعدة البيانات بعد.',
    en: 'Product completeness is not installed on the database yet.',
    ckb: 'پشکنینی تەواوبوونی بەرهەم هێشتا لەسەر بنکەدراوە دانەمەزراوە.',
  },
  COMPLETENESS_NOT_READY: {
    ar: 'بعض المنتجات لم تُفحص بعد — حدّث العدّ ثم فعّل الإخفاء.',
    en: 'Some products are not checked yet — recount, then turn hiding on.',
    ckb: 'هەندێک بەرهەم هێشتا نەپشکنراون — دووبارە بژمێرە، پاشان شاردنەوە چالاک بکە.',
  },
  HIDE_COUNT_CHANGED: {
    ar: 'تغيّر عدد المنتجات الناقصة — راجع العدد الجديد ثم أكّد.',
    en: 'The number of incomplete products changed — review the new count, then confirm.',
    ckb: 'ژمارەی بەرهەمە ناتەواوەکان گۆڕا — ژمارە نوێیەکە ببینە، پاشان پشتڕاستی بکەرەوە.',
  },
  HIDE_SWITCH_ROUTE: {
    ar: 'مفتاح إخفاء المنتجات الناقصة يُغيَّر من صفحة المنتجات.',
    en: 'The hide-incomplete switch is changed from the products page.',
    ckb: 'کلیلی شاردنەوەی بەرهەمە ناتەواوەکان لە پەڕەی بەرهەمەکانەوە دەگۆڕدرێت.',
  },
} as const satisfies Record<string, CompletenessRefusalText>;

export type CompletenessRefusalCode = keyof typeof COMPLETENESS_REFUSALS;

export const isCompletenessRefusalCode = (code: string): code is CompletenessRefusalCode =>
  Object.prototype.hasOwnProperty.call(COMPLETENESS_REFUSALS, code);

/** The server's fallback sentence ("ar / en"); the client renders the viewer's language by code. */
export function completenessMessage(code: CompletenessRefusalCode): string {
  const t = COMPLETENESS_REFUSALS[code];
  return `${t.ar} / ${t.en}`;
}
