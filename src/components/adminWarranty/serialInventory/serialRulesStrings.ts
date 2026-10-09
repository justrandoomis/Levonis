/**
 * THE WORDS OF «صيغ الأرقام التسلسلية» — the owner's serial formats by brand
 * and product (owner decision 2, 2026-10-09; migration 0181;
 * ./SerialRulesTab.tsx). Its OWN table in Arabic, English and Sorani, unlike
 * the inventory panel beside it: every line here is new, and a `ckb` slot is
 * written in Sorani, never a copy of the Arabic (docs/DECISIONS.md row 183).
 * The refusals are not here (src/lib/refusalStrings.ts owns them by code),
 * nor the format notes (../../adminOrders/serials/strings.ts `formatNotes`,
 * shared with every serial screen).
 */
import type { Language } from '../../../translations';

type Fmt<A extends unknown[]> = (...args: A) => string;

export interface SerialRulesStrings {
  tabTitle: string;
  intro: string;
  notInstalled: string;
  readOnly: string;
  loading: string;
  loadFailed: string;
  retry: string;
  scopes: { brand: string; product: string };
  unbound: string;
  bind: string;
  chooseBrand: string;
  inactive: string;
  version: Fmt<[number]>;
  label: string;
  mode: string;
  modes: { off: string; warn: string; enforce: string };
  modeHints: { off: string; warn: string; enforce: string };
  charset: string;
  charsets: { ALNUM: string; DIGITS: string; HEX: string };
  minLen: string;
  maxLen: string;
  lengths: string;
  lengthsHint: string;
  prefixes: string;
  prefixCol: string;
  modelCol: string;
  aliasesCol: string;
  addPrefix: string;
  removePrefix: Fmt<[string]>;
  prefixPolicy: string;
  prefixPolicies: { hint: string; known_only: string };
  boxShape: string;
  boxShapes: { none: string; bambu: string };
  familyCheck: string;
  familyHint: string;
  positionsKept: Fmt<[number]>;
  sourceNote: string;
  save: string;
  saving: string;
  saved: string;
  deactivate: string;
  confirmDeactivate: string;
  deactivated: string;
  testTitle: string;
  testHint: string;
  verdicts: { ok: string; warn: string; refuse: string; notSerial: string };
  familyOf: Fmt<[string]>;
  impactTitle: string;
  impactRun: string;
  impactLine: Fmt<[number, number, number, number]>;
  impactCapped: string;
  impactNone: string;
  newRule: string;
  forBrand: string;
  forProduct: string;
  create: string;
  created: string;
  brandsTitle: string;
  brandLine: Fmt<[string, number]>;
  ruleOf: Fmt<[string]>;
  noRule: string;
  unbrandedTitle: string;
  unbrandedHint: string;
  unbrandedNone: string;
  openEditor: string;
  genericTitle: string;
  genericBody: string;
  /** The rule field a SERIAL_RULE_INVALID names (`details.field`), in the reader's words. */
  fields: Record<string, string>;
}

const ar: SerialRulesStrings = {
  tabTitle: 'صيغ الأرقام التسلسلية',
  intro:
    'يُحكم كل رقم تسلسلي بقاعدة منتجه، ثم بقاعدة علامته التجارية، ثم بالقاعدة العامة (أحرف وأرقام، 6–40). شكل رقم علبة Bambu Lab لا يرفض رقمًا إلا على منتجات Bambu Lab.',
  notInstalled: 'تعمل القواعد بعد تطبيق الترحيل 0181 على قاعدة البيانات؛ حتى ذلك الحين تبقى القاعدة الحالية لكل المنتجات.',
  readOnly: 'للعرض فقط — المالك وحده يعدّل القواعد.',
  loading: 'جارٍ تحميل القواعد…',
  loadFailed: 'تعذّر تحميل القواعد.',
  retry: 'أعد المحاولة',
  scopes: { brand: 'علامة تجارية', product: 'منتج' },
  unbound: 'غير مربوطة بعلامة تجارية بعد — لا تحكم أي منتج.',
  bind: 'اربطها بعلامة تجارية',
  chooseBrand: 'اختر العلامة التجارية',
  inactive: 'موقوفة',
  version: (v) => `الإصدار ${v}`,
  label: 'الاسم',
  mode: 'الوضع',
  modes: { off: 'إيقاف', warn: 'تنبيه', enforce: 'رفض' },
  modeHints: {
    off: 'لا فحص للصيغة بعد الفحوص الأساسية.',
    warn: 'يُقبل الرقم ويظهر تنبيه ويُسجَّل في السجل.',
    enforce: 'يُرفض الرقم الذي لا يطابق الصيغة.',
  },
  charset: 'نوع الخانات',
  charsets: { ALNUM: 'أحرف وأرقام', DIGITS: 'أرقام فقط', HEX: 'ست عشري (0–9 وA–F)' },
  minLen: 'أقصر طول',
  maxLen: 'أطول طول',
  lengths: 'أطوال محددة (مفصولة بفواصل)',
  lengthsHint: 'فارغ = أي طول بين الأقصر والأطول.',
  prefixes: 'البادئات المعروفة',
  prefixCol: 'البادئة',
  modelCol: 'الطراز',
  aliasesCol: 'أسماء أخرى (مفصولة بفواصل)',
  addPrefix: 'أضف بادئة',
  removePrefix: (p) => `احذف البادئة ${p}`,
  prefixPolicy: 'بادئة غير معروفة',
  prefixPolicies: { hint: 'تنبيه فقط', known_only: 'تُعدّ مخالفة للصيغة' },
  boxShape: 'رقم العلبة',
  boxShapes: { none: 'يُقبل بتنبيه', bambu: 'شكل علبة Bambu Lab يُرفض' },
  familyCheck: 'فحص الطراز من البادئة',
  familyHint: 'يُرفض رقم تسمّي بادئته طرازًا غير طراز المنتج، وللمالك أن يستثنيه.',
  positionsKept: (n) => `فحوص المواضع: ${n} (تبقى كما هي)`,
  sourceNote: 'المصدر',
  save: 'احفظ',
  saving: 'جارٍ الحفظ…',
  saved: 'حُفظت القاعدة.',
  deactivate: 'أوقف القاعدة',
  confirmDeactivate: 'إيقاف هذه القاعدة؟ ستُحكم منتجاتها بالقاعدة العامة.',
  deactivated: 'أُوقفت القاعدة — منتجاتها على القاعدة العامة الآن.',
  testTitle: 'جرّب أرقامًا',
  testHint: 'الصق رقمًا في كل سطر — يُحكم هنا بالقاعدة كما هي في النموذج، قبل الحفظ.',
  verdicts: { ok: 'مقبول', warn: 'مقبول مع تنبيه', refuse: 'مرفوض', notSerial: 'ليس رقمًا تسلسليًا' },
  familyOf: (m) => `الطراز: ${m}`,
  impactTitle: 'الأثر على المخزون',
  impactRun: 'احسب الأثر',
  impactLine: (checked, ok, warn, refuse) => `فُحص ${checked}: ${ok} مقبول، ${warn} بتنبيه، ${refuse} مرفوض.`,
  impactCapped: 'فُحصت أحدث 5000 رقم فقط.',
  impactNone: 'لا أرقام في المخزون لهذه العلامة بعد.',
  newRule: 'قاعدة جديدة',
  forBrand: 'لعلامة تجارية',
  forProduct: 'لمنتج',
  create: 'أنشئ القاعدة',
  created: 'أُنشئت القاعدة.',
  brandsTitle: 'العلامات التجارية',
  brandLine: (name, n) => `${name} — ${n} منتج يحتاج رقمًا تسلسليًا`,
  ruleOf: (label) => `القاعدة: ${label}`,
  noRule: 'بلا قاعدة — القاعدة العامة',
  unbrandedTitle: 'منتجات تحتاج رقمًا تسلسليًا بلا علامة تجارية',
  unbrandedHint: 'تُحكم بالقاعدة العامة، وهي تقبل رقم علبة Bambu Lab بتنبيه. حدّد علامتها التجارية في محرّر المنتج.',
  unbrandedNone: 'كل منتج يحتاج رقمًا تسلسليًا له علامة تجارية.',
  openEditor: 'افتح المحرّر',
  genericTitle: 'القاعدة العامة',
  genericBody: 'لكل منتج بلا قاعدة: أحرف وأرقام، 6–40؛ والرقم بشكل علبة Bambu Lab يُقبل بتنبيه.',
  fields: {
    '*': 'القاعدة كلها',
    scope: 'النطاق',
    brand_id: 'العلامة التجارية',
    product_id: 'المنتج',
    label: 'الاسم',
    mode: 'الوضع',
    charset: 'نوع الخانات',
    min_len: 'أقصر طول',
    max_len: 'أطول طول',
    lengths: 'الأطوال المحددة',
    prefixes: 'البادئات',
    prefix_policy: 'البادئة غير المعروفة',
    positions: 'فحوص المواضع',
    box_sn_shape: 'رقم العلبة',
    family_check: 'فحص الطراز',
    source_note: 'المصدر',
  },
};

const en: SerialRulesStrings = {
  tabTitle: 'Serial formats',
  intro:
    'Every serial is judged by its product’s rule, then its brand’s rule, then the generic rule (letters and digits, 6–40). The Bambu Lab box-number shape refuses a serial only on Bambu Lab products.',
  notInstalled: 'The rules start working once migration 0181 is applied to the database; until then every product keeps today’s rule.',
  readOnly: 'Read only — only the owner edits the rules.',
  loading: 'Loading the rules…',
  loadFailed: 'The rules could not be loaded.',
  retry: 'Try again',
  scopes: { brand: 'Brand', product: 'Product' },
  unbound: 'Not bound to a brand yet — it judges no product.',
  bind: 'Bind to a brand',
  chooseBrand: 'Choose the brand',
  inactive: 'Inactive',
  version: (v) => `Version ${v}`,
  label: 'Name',
  mode: 'Mode',
  modes: { off: 'Off', warn: 'Warn', enforce: 'Refuse' },
  modeHints: {
    off: 'No format check beyond the basic checks.',
    warn: 'The serial is accepted, a warning is shown and recorded.',
    enforce: 'A serial that does not match the format is refused.',
  },
  charset: 'Characters',
  charsets: { ALNUM: 'Letters and digits', DIGITS: 'Digits only', HEX: 'Hexadecimal (0–9, A–F)' },
  minLen: 'Shortest',
  maxLen: 'Longest',
  lengths: 'Exact lengths (comma-separated)',
  lengthsHint: 'Empty = any length between the shortest and the longest.',
  prefixes: 'Known prefixes',
  prefixCol: 'Prefix',
  modelCol: 'Model',
  aliasesCol: 'Other names (comma-separated)',
  addPrefix: 'Add a prefix',
  removePrefix: (p) => `Remove prefix ${p}`,
  prefixPolicy: 'Unknown prefix',
  prefixPolicies: { hint: 'Warn only', known_only: 'Counts as a mismatch' },
  boxShape: 'Box number',
  boxShapes: { none: 'Accepted with a warning', bambu: 'Bambu Lab box shape refused' },
  familyCheck: 'Model check from the prefix',
  familyHint: 'Refuses a serial whose prefix names another model than the product’s; the owner can make an exception.',
  positionsKept: (n) => `Position checks: ${n} (kept as they are)`,
  sourceNote: 'Source',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Rule saved.',
  deactivate: 'Deactivate the rule',
  confirmDeactivate: 'Deactivate this rule? Its products will be judged by the generic rule.',
  deactivated: 'Rule deactivated — its products use the generic rule now.',
  testTitle: 'Try serials',
  testHint: 'Paste one serial per line — judged here by the rule as it stands in the form, before saving.',
  verdicts: { ok: 'Accepted', warn: 'Accepted with a warning', refuse: 'Refused', notSerial: 'Not a serial' },
  familyOf: (m) => `Model: ${m}`,
  impactTitle: 'Impact on the inventory',
  impactRun: 'Check the impact',
  impactLine: (checked, ok, warn, refuse) => `${checked} checked: ${ok} accepted, ${warn} with a warning, ${refuse} refused.`,
  impactCapped: 'Only the newest 5000 serials were checked.',
  impactNone: 'No serials of this brand in the inventory yet.',
  newRule: 'New rule',
  forBrand: 'For a brand',
  forProduct: 'For a product',
  create: 'Create the rule',
  created: 'Rule created.',
  brandsTitle: 'Brands',
  brandLine: (name, n) => `${name} — ${n} product(s) need a serial`,
  ruleOf: (label) => `Rule: ${label}`,
  noRule: 'No rule — the generic rule',
  unbrandedTitle: 'Products that need a serial but have no brand',
  unbrandedHint: 'They are judged by the generic rule, which accepts a Bambu Lab box number with a warning. Set their brand in the product editor.',
  unbrandedNone: 'Every product that needs a serial has a brand.',
  openEditor: 'Open the editor',
  genericTitle: 'The generic rule',
  genericBody: 'For every product without a rule: letters and digits, 6–40; a value shaped like a Bambu Lab box number is accepted with a warning.',
  fields: {
    '*': 'the whole rule',
    scope: 'scope',
    brand_id: 'brand',
    product_id: 'product',
    label: 'name',
    mode: 'mode',
    charset: 'characters',
    min_len: 'shortest length',
    max_len: 'longest length',
    lengths: 'exact lengths',
    prefixes: 'prefixes',
    prefix_policy: 'unknown prefix',
    positions: 'position checks',
    box_sn_shape: 'box number',
    family_check: 'model check',
    source_note: 'source',
  },
};

const ckb: SerialRulesStrings = {
  tabTitle: 'شێوازەکانی ژمارەی زنجیرەیی',
  intro:
    'هەر ژمارەیەکی زنجیرەیی بە یاسای بەرهەمەکەی، پاشان بە یاسای براندەکەی، پاشان بە یاسای گشتی (پیت و ژمارە، 6–40) هەڵدەسەنگێنرێت. شێوەی ژمارەی سندووقی Bambu Lab تەنها لە بەرهەمەکانی Bambu Lab ژمارەیەک ڕەتدەکاتەوە.',
  notInstalled: 'یاساکان دوای جێبەجێکردنی کۆچی 0181 لەسەر بنکەدراوەکە کار دەکەن؛ تا ئەو کاتە هەموو بەرهەمێک یاسای ئێستای دەمێنێت.',
  readOnly: 'تەنها بۆ بینین — تەنها خاوەن یاساکان دەستکاری دەکات.',
  loading: 'یاساکان بار دەکرێن…',
  loadFailed: 'نەتوانرا یاساکان بار بکرێن.',
  retry: 'دووبارە هەوڵ بدەرەوە',
  scopes: { brand: 'براند', product: 'بەرهەم' },
  unbound: 'هێشتا بە هیچ براندێکەوە نەبەستراوەتەوە — هیچ بەرهەمێک هەڵناسەنگێنێت.',
  bind: 'بە براندێکەوە بیبەستەوە',
  chooseBrand: 'براندەکە هەڵبژێرە',
  inactive: 'ناچالاک',
  version: (v) => `وەشانی ${v}`,
  label: 'ناو',
  mode: 'دۆخ',
  modes: { off: 'ناچالاک', warn: 'ئاگادارکردنەوە', enforce: 'ڕەتکردنەوە' },
  modeHints: {
    off: 'جگە لە پشکنینە بنەڕەتییەکان، هیچ پشکنینێکی شێواز نییە.',
    warn: 'ژمارەکە وەردەگیرێت، ئاگادارکردنەوەیەک پیشان دەدرێت و تۆمار دەکرێت.',
    enforce: 'ئەو ژمارەیەی لەگەڵ شێوازەکە نەگونجێت ڕەتدەکرێتەوە.',
  },
  charset: 'جۆری پیتەکان',
  charsets: { ALNUM: 'پیت و ژمارە', DIGITS: 'تەنها ژمارە', HEX: 'شازدەیی (0–9 و A–F)' },
  minLen: 'کورتترین درێژی',
  maxLen: 'درێژترین درێژی',
  lengths: 'درێژییە دیاریکراوەکان (بە کۆما جیا بکرێنەوە)',
  lengthsHint: 'بەتاڵ = هەر درێژییەک لە نێوان کورتترین و درێژترین.',
  prefixes: 'سەرەتا ناسراوەکان',
  prefixCol: 'سەرەتا',
  modelCol: 'مۆدێل',
  aliasesCol: 'ناوی تر (بە کۆما جیا بکرێنەوە)',
  addPrefix: 'سەرەتایەک زیاد بکە',
  removePrefix: (p) => `سەرەتای ${p} لاببە`,
  prefixPolicy: 'سەرەتای نەناسراو',
  prefixPolicies: { hint: 'تەنها ئاگادارکردنەوە', known_only: 'وەک نەگونجان دادەنرێت' },
  boxShape: 'ژمارەی سندووق',
  boxShapes: { none: 'بە ئاگادارکردنەوە وەردەگیرێت', bambu: 'شێوەی سندووقی Bambu Lab ڕەتدەکرێتەوە' },
  familyCheck: 'پشکنینی مۆدێل لە سەرەتاوە',
  familyHint: 'ژمارەیەک ڕەتدەکاتەوە کە سەرەتاکەی ناوی مۆدێلێکی تر جگە لە مۆدێلی بەرهەمەکە دەبات؛ خاوەن دەتوانێت ڕێگەی پێ بدات.',
  positionsKept: (n) => `پشکنینی شوێنەکان: ${n} (وەک خۆیان دەمێننەوە)`,
  sourceNote: 'سەرچاوە',
  save: 'پاشەکەوت بکە',
  saving: 'پاشەکەوت دەکرێت…',
  saved: 'یاساکە پاشەکەوت کرا.',
  deactivate: 'یاساکە ناچالاک بکە',
  confirmDeactivate: 'ئەم یاسایە ناچالاک بکرێت؟ بەرهەمەکانی بە یاسای گشتی هەڵدەسەنگێنرێن.',
  deactivated: 'یاساکە ناچالاک کرا — بەرهەمەکانی ئێستا یاسای گشتی بەکار دەهێنن.',
  testTitle: 'ژمارە تاقی بکەرەوە',
  testHint: 'لە هەر هێڵێکدا ژمارەیەک دابنێ — لێرە بە یاساکە وەک لە فۆرمەکەدایە، پێش پاشەکەوتکردن، هەڵدەسەنگێنرێت.',
  verdicts: { ok: 'وەرگیرا', warn: 'بە ئاگادارکردنەوە وەرگیرا', refuse: 'ڕەتکرایەوە', notSerial: 'ژمارەی زنجیرەیی نییە' },
  familyOf: (m) => `مۆدێل: ${m}`,
  impactTitle: 'کاریگەری لەسەر کۆگا',
  impactRun: 'کاریگەرییەکە بپشکنە',
  impactLine: (checked, ok, warn, refuse) => `${checked} پشکنرا: ${ok} وەرگیرا، ${warn} بە ئاگادارکردنەوە، ${refuse} ڕەتکرایەوە.`,
  impactCapped: 'تەنها نوێترین 5000 ژمارە پشکنران.',
  impactNone: 'هێشتا هیچ ژمارەیەکی ئەم براندە لە کۆگادا نییە.',
  newRule: 'یاسای نوێ',
  forBrand: 'بۆ براندێک',
  forProduct: 'بۆ بەرهەمێک',
  create: 'یاساکە دروست بکە',
  created: 'یاساکە دروست کرا.',
  brandsTitle: 'براندەکان',
  brandLine: (name, n) => `${name} — ${n} بەرهەم ژمارەی زنجیرەییان پێویستە`,
  ruleOf: (label) => `یاسا: ${label}`,
  noRule: 'بێ یاسا — یاسای گشتی',
  unbrandedTitle: 'ئەو بەرهەمانەی ژمارەی زنجیرەییان پێویستە بەڵام براندیان نییە',
  unbrandedHint: 'بە یاسای گشتی هەڵدەسەنگێنرێن، کە ژمارەی سندووقی Bambu Lab بە ئاگادارکردنەوە وەردەگرێت. براندەکەیان لە دەستکاریکەری بەرهەمدا دیاری بکە.',
  unbrandedNone: 'هەموو بەرهەمێک کە ژمارەی زنجیرەیی پێویستە براندی هەیە.',
  openEditor: 'دەستکاریکەر بکەرەوە',
  genericTitle: 'یاسای گشتی',
  genericBody: 'بۆ هەموو بەرهەمێکی بێ یاسا: پیت و ژمارە، 6–40؛ بەهایەک بە شێوەی ژمارەی سندووقی Bambu Lab بە ئاگادارکردنەوە وەردەگیرێت.',
  fields: {
    '*': 'هەموو یاساکە',
    scope: 'بوار',
    brand_id: 'براند',
    product_id: 'بەرهەم',
    label: 'ناو',
    mode: 'دۆخ',
    charset: 'جۆری پیتەکان',
    min_len: 'کورتترین درێژی',
    max_len: 'درێژترین درێژی',
    lengths: 'درێژییە دیاریکراوەکان',
    prefixes: 'سەرەتاکان',
    prefix_policy: 'سەرەتای نەناسراو',
    positions: 'پشکنینی شوێنەکان',
    box_sn_shape: 'ژمارەی سندووق',
    family_check: 'پشکنینی مۆدێل',
    source_note: 'سەرچاوە',
  },
};

export const SERIAL_RULES_STRINGS: Record<Language, SerialRulesStrings> = { ar, en, ckb };

export function serialRulesStrings(lang: Language | string): SerialRulesStrings {
  return SERIAL_RULES_STRINGS[(lang === 'en' || lang === 'ckb' ? lang : 'ar') as Language];
}

/** `prefixes[3].p` → «البادئات (4)»: the field a refusal names, in the reader's words. */
export function ruleFieldName(path: string, s: SerialRulesStrings): string {
  const m = /^([a-z_*]+)(?:\[(\d+)\])?/.exec(String(path ?? ''));
  if (!m) return String(path ?? '');
  const base = s.fields[m[1]] ?? m[1];
  return m[2] !== undefined ? `${base} (${Number(m[2]) + 1})` : base;
}
