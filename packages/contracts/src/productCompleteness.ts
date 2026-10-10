/**
 * THE ONE LIST OF FIELDS A PRODUCT NEEDS BEFORE CUSTOMERS SEE IT (owner brief
 * 2026-10-10: «اخفاء كل المنتجات التي تنقصها التكاليف والحقول الناقصه مع اعلام
 * احمر للحقل الناقص»).
 *
 * The server decides (worker/lib/productCompleteness.ts evaluates every
 * ordinary product against this list and stores CODES only, migration 0184);
 * the product form, the products list and the data-file preview render the
 * codes in the viewer's language from this table. Pure data: no imports, so
 * the Worker, the client and the tests share it.
 *
 * PRIVATE CODES. `COST` and `ENGINE_INPUTS` name the owner's private pricing
 * data. The server projects them away for every viewer but the verified owner,
 * who alone learns WHICH private field is missing; any other admin reads the
 * single `OWNER_DATA` item instead (the disclosure rule of brief 1 §38 that
 * `pricingUnavailable` follows), and a customer learns nothing at all — a held
 * product simply is not there.
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183).
 */
export interface CompletenessText {
  ar: string;
  en: string;
  ckb: string;
}

export type CompletenessLang = keyof CompletenessText;

/** Bumped whenever an entry is added, removed or its rule changes: every stored verdict is then stale. */
export const COMPLETENESS_LIST_VERSION = 1;

export const COMPLETENESS_CODES = ['NAME_AR', 'PRICE', 'COST', 'ENGINE_INPUTS', 'IMAGE', 'CATEGORY', 'PACKAGE_WEIGHT', 'PACKAGE_BOX'] as const;
export type CompletenessCode = (typeof COMPLETENESS_CODES)[number];

/** What a non-owner admin reads in place of every private code. */
export const OWNER_DATA_CODE = 'OWNER_DATA' as const;
export type CompletenessItemCode = CompletenessCode | typeof OWNER_DATA_CODE;

export interface CompletenessEntry {
  code: CompletenessItemCode;
  /** Cost or private pricing data: the verified owner alone sees it by name. */
  private: boolean;
  /** The product form's section (ProductForm.tsx `SectionCard n`). */
  section: number;
  /** The data-file key that fills it (owner keys are in the owner's file only). */
  txt_key: string;
  label: CompletenessText;
  hint: CompletenessText;
}

export const COMPLETENESS_ENTRIES: Readonly<Record<CompletenessItemCode, CompletenessEntry>> = {
  NAME_AR: {
    code: 'NAME_AR',
    private: false,
    section: 2,
    txt_key: 'name_ar',
    label: { ar: 'الاسم بالعربية', en: 'Arabic name', ckb: 'ناوی بەرهەم بە عەرەبی' },
    hint: { ar: 'اكتب اسم المنتج بالعربية.', en: 'Write the product name in Arabic.', ckb: 'ناوی بەرهەمەکە بە عەرەبی بنووسە.' },
  },
  PRICE: {
    code: 'PRICE',
    private: false,
    section: 3,
    txt_key: 'price_iqd',
    label: { ar: 'سعر البيع', en: 'Selling price', ckb: 'نرخی فرۆشتن' },
    hint: {
      ar: 'أدخل سعراً أكبر من صفر، أو أكمل التسعير بالدولار واحفظ.',
      en: 'Enter a price above zero, or complete the USD pricing and save.',
      ckb: 'نرخێک لە سفر زیاتر بنووسە، یان نرخدانان بە دۆلار تەواو بکە و پاشەکەوتی بکە.',
    },
  },
  COST: {
    code: 'COST',
    private: true,
    section: 3,
    txt_key: 'product_cost_iqd',
    label: { ar: 'التكلفة', en: 'Cost', ckb: 'تێچوو' },
    hint: {
      ar: 'أدخل تكلفة المنتج، أو تكلفة المورد لكل موديل.',
      en: 'Enter the product cost, or the supplier cost of every model.',
      ckb: 'تێچووی بەرهەم، یان تێچووی دابینکەر بۆ هەموو مۆدێلێک بنووسە.',
    },
  },
  ENGINE_INPUTS: {
    code: 'ENGINE_INPUTS',
    private: true,
    section: 3,
    txt_key: 'pricing.rules.minimum_target_profit_usd',
    label: { ar: 'بيانات التسعير بالدولار', en: 'USD pricing data', ckb: 'زانیاری نرخدانان بە دۆلار' },
    hint: {
      ar: 'أكمل الحد الأدنى للربح وبيانات الشحن في «التسعير بالدولار».',
      en: 'Complete the minimum profit and the shipping data in «USD pricing».',
      ckb: 'کەمترین قازانج و زانیاری ناردن لە «نرخدانان بە دۆلار» تەواو بکە.',
    },
  },
  IMAGE: {
    code: 'IMAGE',
    private: false,
    section: 6,
    txt_key: 'images.1.url',
    label: { ar: 'صورة المنتج', en: 'Product image', ckb: 'وێنەی بەرهەم' },
    hint: { ar: 'أضف صورة واحدة على الأقل.', en: 'Add at least one image.', ckb: 'لانیکەم یەک وێنە زیاد بکە.' },
  },
  CATEGORY: {
    code: 'CATEGORY',
    private: false,
    section: 1,
    txt_key: 'category',
    label: { ar: 'القسم الرئيسي', en: 'Main section', ckb: 'بەشی سەرەکی' },
    hint: { ar: 'اختر القسم الرئيسي.', en: 'Choose the main section.', ckb: 'بەشی سەرەکی هەڵبژێرە.' },
  },
  PACKAGE_WEIGHT: {
    code: 'PACKAGE_WEIGHT',
    private: false,
    section: 4,
    txt_key: 'package_weight_g',
    label: { ar: 'الوزن مع التغليف', en: 'Packaged weight', ckb: 'کێش لەگەڵ بەستەبەندی' },
    hint: {
      ar: 'أدخل الوزن مع التغليف (أكبر من صفر).',
      en: 'Enter the packaged weight (above zero).',
      ckb: 'کێش لەگەڵ بەستەبەندی بنووسە (لە سفر زیاتر).',
    },
  },
  PACKAGE_BOX: {
    code: 'PACKAGE_BOX',
    private: false,
    section: 4,
    txt_key: 'package_width_mm',
    label: { ar: 'أبعاد الصندوق', en: 'Box size', ckb: 'قەبارەی سندوق' },
    hint: {
      ar: 'أدخل طول الصندوق وعرضه وارتفاعه.',
      en: 'Enter the box length, width and height.',
      ckb: 'درێژی و پانی و بەرزی سندوقەکە بنووسە.',
    },
  },
  OWNER_DATA: {
    code: 'OWNER_DATA',
    private: false,
    section: 3,
    txt_key: '',
    label: {
      ar: 'بيانات التكلفة الخاصة ناقصة — يكملها المالك',
      en: 'Private cost data is missing — the owner completes it',
      ckb: 'زانیاری تایبەتی تێچوو ناتەواوە — خاوەن تەواوی دەکات',
    },
    hint: {
      ar: 'لا يراها إلا المالك.',
      en: 'Only the owner sees it.',
      ckb: 'تەنها خاوەن دەیبینێت.',
    },
  },
};

export const isCompletenessCode = (v: unknown): v is CompletenessCode =>
  typeof v === 'string' && (COMPLETENESS_CODES as readonly string[]).includes(v);

export const isPrivateCompletenessCode = (code: CompletenessCode): boolean => COMPLETENESS_ENTRIES[code].private;

/** One missing field as it travels: the code, and the model (option value id) it is missing on ('' = the product). */
export interface CompletenessItem {
  code: CompletenessItemCode;
  option_id: string;
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
} as const satisfies Record<string, CompletenessText>;

export type CompletenessRefusalCode = keyof typeof COMPLETENESS_REFUSALS;

export const isCompletenessRefusalCode = (code: string): code is CompletenessRefusalCode =>
  Object.prototype.hasOwnProperty.call(COMPLETENESS_REFUSALS, code);

/** The server's fallback sentence ("ar / en"); the client renders the viewer's language by code. */
export function completenessMessage(code: CompletenessRefusalCode): string {
  const t = COMPLETENESS_REFUSALS[code];
  return `${t.ar} / ${t.en}`;
}
