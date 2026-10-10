/**
 * «ملف بيانات المنتج» — THE ROUND TRIP'S REFUSALS (worker/routes/templateDataFile.ts),
 * in Arabic, English and Sorani. The server sends `dataFileMessage(code)`
 * ("ar / en") as the fallback sentence; the client renders the viewer's
 * language by CODE (`src/lib/refusalStrings.ts` spreads this table in).
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183). A refusal carries no value: a cost line a
 * non-owner wrote is refused by its name alone.
 *
 * Pure data: no imports, so the Worker, the client and the tests share it.
 */
export interface DataFileRefusal {
  ar: string;
  en: string;
  ckb: string;
}

export const DATA_FILE_REFUSALS = {
  DATA_FILE_PRODUCT_MISSING: {
    ar: 'المنتج المذكور في الملف غير موجود.',
    en: 'The product this file names does not exist.',
    ckb: 'ئەو بەرهەمەی لە فایلەکەدا ناوی هاتووە بوونی نییە.',
  },
  DATA_FILE_COMPOSITION: {
    ar: 'العروض المجمّعة والصناديق المفاجئة تُعدَّل من لوحتها، لا من ملف البيانات.',
    en: 'Bundles and mystery offers are edited in their own panel, not from a data file.',
    ckb: 'پاکێجەکان و سندوقە نادیارەکان لە پانێڵی خۆیانەوە دەگۆڕدرێن، نەک لە فایلی زانیاری.',
  },
  DATA_FILE_VERSION: {
    ar: 'هذا الملف من إصدار أحدث مما يفهمه الخادم — نزّل الملف من جديد.',
    en: 'This file is from a newer version than the server understands — download it again.',
    ckb: 'ئەم فایلە لە وەشانێکی نوێترە لەوەی ڕاژەکار تێی دەگات — دووبارە دایبگرە.',
  },
  DATA_FILE_NO_PRODUCT: {
    ar: 'لا يذكر الملف أي منتج — استعمل ملفاً نزّلته من «تحديث البيانات».',
    en: 'The file names no product — use a file downloaded from «Update data».',
    ckb: 'فایلەکە ناوی هیچ بەرهەمێک ناهێنێت — فایلێک بەکاربهێنە کە لە «نوێکردنەوەی زانیاری» داتگرتووە.',
  },
  DATA_FILE_MALFORMED: {
    ar: 'بنية الملف غير سليمة (سطر بداية أو نهاية منتج ناقص) — نزّل الملف من جديد.',
    en: 'The file is malformed (a product start or end line is missing) — download it again.',
    ckb: 'پێکهاتەی فایلەکە دروست نییە (هێڵی سەرەتا یان کۆتایی بەرهەمێک ونە) — دووبارە دایبگرە.',
  },
  DATA_FILE_TOO_MANY: {
    ar: 'الملف الواحد يحمل 25 منتجاً على الأكثر — قسّمه إلى ملفات.',
    en: 'One file holds at most 25 products — split it into several files.',
    ckb: 'هەر فایلێک زۆرترین 25 بەرهەم هەڵدەگرێت — بیکە بە چەند فایلێک.',
  },
  DATA_FILE_WRONG_PRODUCT: {
    ar: 'هذا الملف لمنتج آخر — أرفق ملف هذا المنتج.',
    en: 'This file is for another product — attach this product\'s file.',
    ckb: 'ئەم فایلە بۆ بەرهەمێکی ترە — فایلی ئەم بەرهەمە هاوپێچ بکە.',
  },
  DATA_FILE_NOTHING_TO_APPLY: {
    ar: 'لا يوجد تغيير يمكن تطبيقه في هذا الملف.',
    en: 'There is no change in this file that can be applied.',
    ckb: 'هیچ گۆڕانکارییەک لەم فایلەدا نییە کە جێبەجێ بکرێت.',
  },
  DATA_FILE_CHANGED: {
    ar: 'تغيّر المنتج بعد المقارنة — راجع المقارنة الجديدة ثم طبّق.',
    en: 'The product changed after the comparison — review the new comparison, then apply.',
    ckb: 'بەرهەمەکە دوای بەراوردکردن گۆڕا — بەراوردی نوێ ببینە و پاشان جێبەجێی بکە.',
  },
  DATA_FILE_TOO_LARGE: {
    ar: 'التعديلات أكبر من أن تُحفظ دفعة واحدة — قسّمها على ملفين.',
    en: 'The changes are too many to save in one go — split them across two files.',
    ckb: 'گۆڕانکارییەکان زۆرن بۆ ئەوەی بە یەکجار پاشەکەوت بکرێن — بیانکە بە دوو فایل.',
  },
  DATA_FILE_SIDE_EFFECT: {
    ar: 'الحفظ سيغيّر حقولاً أخرى لم تعدّلها — احفظ المنتج من النموذج مرة، ثم نزّل الملف من جديد',
    en: 'The save would change other fields you did not edit — save the product once in the form, then download the file again',
    ckb: 'پاشەکەوتکردن خانەی تر دەگۆڕێت کە دەستکاریت نەکردوون — جارێک بەرهەمەکە لە فۆڕمەکەوە پاشەکەوت بکە، پاشان فایلەکە دووبارە دابگرە',
  },
} as const satisfies Record<string, DataFileRefusal>;

export type DataFileRefusalCode = keyof typeof DATA_FILE_REFUSALS;

export const isDataFileRefusalCode = (code: string): code is DataFileRefusalCode => Object.prototype.hasOwnProperty.call(DATA_FILE_REFUSALS, code);

/** The server's fallback sentence ("ar / en"); the client renders the viewer's language by code. */
export function dataFileMessage(code: DataFileRefusalCode): string {
  const e: DataFileRefusal = DATA_FILE_REFUSALS[code];
  return `${e.ar} / ${e.en}`;
}
