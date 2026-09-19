import type { CompareLang } from '../../lib/compare';

/**
 * EVERY WORD ON THE COMPARISON, IN ONE PLACE.
 *
 * The page and its six components share one dictionary rather than each
 * carrying a `STRINGS` block, because the same sentence appears in more than
 * one of them — «غير مذكور» is on a table cell, on a card row and in the
 * verdict's footnote, and three copies of it drift the first time one is
 * softened.
 *
 * ARABIC IS THE SOURCE. ckb is a real translation, not a fallback to Arabic,
 * except where the term is the same word in both scripts.
 */
export interface CompareStrings {
  pageTitle: string;
  back: string;

  // the verdict band
  verdictTitle: string;
  score: string;
  leads: string;
  tied: string;
  tiedNote: string;
  winsIn: string;
  losesIn: string;
  winsNone: string;
  losesNone: string;
  more: (n: number) => string;
  graded: string;

  // the basis line
  basisSameSection: (what: string) => string;
  basisSameType: (what: string) => string;
  basisMixed: string;
  basisWhyEmpty: string;

  // the chart
  chartTitle: string;
  chartLegend: string;
  chartNone: string;

  // price
  priceTitle: string;
  priceFrom: string;
  cheapest: string;
  moreThanCheapest: (iqd: string, percent: number) => string;
  priceNotScored: string;

  // the table
  specsTitle: string;
  sharedGroup: string;
  narrowGroup: string;
  narrowGroupNote: string;
  missing: string;
  notScored: string;
  tieRow: string;
  informational: string;
  best: string;
  diffOnly: string;
  diffOnlyNone: string;
  identicalRows: (n: number) => string;

  // slots and picking
  slotsTitle: string;
  addProduct: string;
  removeProduct: (name: string) => string;
  replaceProduct: (name: string) => string;
  moveStart: string;
  moveEnd: string;
  full: (max: number) => string;
  pickTitle: string;
  pickSearch: string;
  pickSearching: string;
  pickNone: string;
  pickNoneHint: string;
  pickLike: (name: string) => string;
  openProduct: string;

  // empty / error
  emptyTitle: string;
  emptyBody: string;
  emptyRecent: string;
  browse: string;
  onlyOneTitle: string;
  onlyOneBody: string;
  dropThis: string;
  startOver: string;
  loading: string;
}

const ar: CompareStrings = {
  pageTitle: 'المقارنة',
  back: 'رجوع',

  verdictTitle: 'الخلاصة',
  score: 'النتيجة',
  leads: 'الأفضل في أغلب المحاور',
  tied: 'متعادلان',
  tiedNote: 'ما في فرق محسوب بين المنتجات على المحاور المحتسبة.',
  winsIn: 'يتفوق في',
  losesIn: 'وهذه ما لا يتفوق فيه',
  winsNone: 'ما يتفوق في محور محتسب.',
  losesNone: 'ما يتأخر في أي محور محتسب.',
  more: (n) => `و${n} غيرها`,
  graded: 'وحدة مستعملة أو مفتوحة العلبة',

  basisSameSection: (what) => `مقارنة بين ${what}.`,
  basisSameType: (what) => `مقارنة بين ${what} بتقنيات مختلفة.`,
  basisMixed: 'مقارنة مختلطة: المنتجات مو من نوع واحد.',
  basisWhyEmpty:
    'لهذا بعض المجموعات تخص جهازاً دون غيره، والحقل اللي ما عنده قيمة يكتب «غير مذكور» وما يدخل بالحساب.',

  chartTitle: 'المحاور الحاسمة',
  chartLegend: 'الشريط الأطول أفضل — حتى في المحاور اللي الأقل فيها أحسن، معكوسة أصلاً من الخادم.',
  chartNone: 'ما في محاور حاسمة كافية لرسم مخطط: المنتجات متطابقة أو ناقصة القيم في المحاور المحتسبة.',

  priceTitle: 'السعر',
  priceFrom: 'السعر «يبدأ من»: الخيارات والألوان والتوصيل زيادة عليه.',
  cheapest: 'الأرخص',
  moreThanCheapest: (iqd, percent) => `أغلى بـ ${iqd} (+${percent}%)`,
  priceNotScored: 'السعر معروض ولا يدخل في النتيجة أعلاه — هو مفاضلة، مو تفوق.',

  specsTitle: 'المواصفات',
  sharedGroup: 'مشتركة',
  narrowGroup: 'ما تنطبق على الكل',
  narrowGroupNote: 'هذه المجموعة مسجلة لجهاز دون غيره، فما تُقرأ الفراغات فيها على أنها ضعف.',
  missing: 'غير مذكور',
  notScored: 'غير محتسب',
  tieRow: 'متعادل',
  informational: 'للعلم فقط',
  best: 'الأفضل',
  diffOnly: 'الفروقات فقط',
  diffOnlyNone: 'كل الصفوف المعروضة متطابقة — ما في فرق يُعرض.',
  identicalRows: (n) => `${n} صف متطابق مخفي`,

  slotsTitle: 'المنتجات المقارَنة',
  addProduct: 'أضف منتج',
  removeProduct: (name) => `شيل ${name} من المقارنة`,
  replaceProduct: (name) => `بدّل ${name}`,
  moveStart: 'حرّك للبداية',
  moveEnd: 'حرّك للنهاية',
  full: (max) => `أقصى شي ${max} منتجات بنفس الوكت.`,
  pickTitle: 'اختر منتج للمقارنة',
  pickSearch: 'دور بالاسم (اختياري)',
  pickSearching: 'يدور…',
  pickNone: 'ما لكينا منتج يصلح للمقارنة.',
  pickNoneHint: 'جرب تدور باسم ثاني، أو افتح المتجر واختار من هناك.',
  pickLike: (name) => `منتجات تشبه ${name}`,
  openProduct: 'افتح صفحة المنتج',

  emptyTitle: 'ابدأ المقارنة',
  emptyBody: 'اختر منتجين على الأقل. الرابط يحفظ اختيارك، فتكدر ترسله لأي أحد.',
  emptyRecent: 'من اللي شفته مؤخراً',
  browse: 'تصفح المتجر',
  onlyOneTitle: 'منتج واحد بس',
  onlyOneBody: 'أضف منتج ثاني حتى تصير مقارنة.',
  dropThis: 'شيله وكمّل',
  startOver: 'ابدأ من جديد',
  loading: 'يجهّز المقارنة…',
};

const en: CompareStrings = {
  pageTitle: 'Comparison',
  back: 'Back',

  verdictTitle: 'The answer',
  score: 'Score',
  leads: 'Ahead on most axes',
  tied: 'Level',
  tiedNote: 'There is no measured difference between these on the scored axes.',
  winsIn: 'Wins on',
  losesIn: 'And these it does not win',
  winsNone: 'Wins no scored axis.',
  losesNone: 'Behind on no scored axis.',
  more: (n) => `and ${n} more`,
  graded: 'Used or open-box unit',

  basisSameSection: (what) => `Comparing ${what}.`,
  basisSameType: (what) => `Comparing ${what} of different technologies.`,
  basisMixed: 'Mixed comparison: these are not the same kind of product.',
  basisWhyEmpty:
    'So some groups apply to one machine and not the other, and a field with no value reads “not stated” and is left out of the score.',

  chartTitle: 'The decisive axes',
  chartLegend: 'Longer is better — including on axes where lower wins, which the server has already inverted.',
  chartNone: 'Not enough decisive axes to draw a chart: the products match, or values are missing on the scored axes.',

  priceTitle: 'Price',
  priceFrom: 'Prices start from this figure: options, colours and delivery are added to it.',
  cheapest: 'Cheapest',
  moreThanCheapest: (iqd, percent) => `${iqd} more (+${percent}%)`,
  priceNotScored: 'Price is shown and is not part of the score above — it is a trade-off, not a win.',

  specsTitle: 'Specifications',
  sharedGroup: 'Shared',
  narrowGroup: 'Not applicable to all',
  narrowGroupNote: 'This group is recorded for one machine and not the other, so a blank here is not a weakness.',
  missing: 'Not stated',
  notScored: 'Not scored',
  tieRow: 'Level',
  informational: 'For information',
  best: 'Best',
  diffOnly: 'Differences only',
  diffOnlyNone: 'Every visible row is identical — there is no difference to show.',
  identicalRows: (n) => `${n} identical rows hidden`,

  slotsTitle: 'Products being compared',
  addProduct: 'Add a product',
  removeProduct: (name) => `Remove ${name} from the comparison`,
  replaceProduct: (name) => `Replace ${name}`,
  moveStart: 'Move to the start',
  moveEnd: 'Move to the end',
  full: (max) => `Up to ${max} products at a time.`,
  pickTitle: 'Choose a product to compare',
  pickSearch: 'Search by name (optional)',
  pickSearching: 'Searching…',
  pickNone: 'Nothing here can be compared.',
  pickNoneHint: 'Try another name, or open the shop and pick from there.',
  pickLike: (name) => `Products like ${name}`,
  openProduct: 'Open the product page',

  emptyTitle: 'Start a comparison',
  emptyBody: 'Choose at least two products. The link keeps your choice, so you can send it to anyone.',
  emptyRecent: 'From what you looked at recently',
  browse: 'Browse the shop',
  onlyOneTitle: 'Only one product',
  onlyOneBody: 'Add a second product to make this a comparison.',
  dropThis: 'Remove it and carry on',
  startOver: 'Start again',
  loading: 'Preparing the comparison…',
};

const ckb: CompareStrings = {
  pageTitle: 'بەراورد',
  back: 'گەڕانەوە',

  verdictTitle: 'کورتەی وەڵام',
  score: 'ئەنجام',
  leads: 'لە زۆربەی تەوەرەکاندا پێشترە',
  tied: 'یەکسانن',
  tiedNote: 'هیچ جیاوازییەکی پێوراو لە نێوانیاندا نییە لەسەر تەوەرە ژمێردراوەکان.',
  winsIn: 'سەردەکەوێت لە',
  losesIn: 'و لەمانەدا سەرناکەوێت',
  winsNone: 'لە هیچ تەوەرەیەکی ژمێردراودا سەرناکەوێت.',
  losesNone: 'لە هیچ تەوەرەیەکی ژمێردراودا دواکەوتوو نییە.',
  more: (n) => `و ${n}ی تر`,
  graded: 'یەکەی بەکارهێنراو یان قوتوو کراوە',

  basisSameSection: (what) => `بەراورد لە نێوان ${what}.`,
  basisSameType: (what) => `بەراورد لە نێوان ${what} بە تەکنەلۆژیای جیاواز.`,
  basisMixed: 'بەراوردێکی تێکەڵ: بەرهەمەکان لە یەک جۆر نین.',
  basisWhyEmpty:
    'بۆیە هەندێک کۆمەڵە تەنها بۆ ئامێرێکن، و ئەو خانەیەی بەهای نییە «نەوتراوە» دەنووسێت و لە ژمێرکاریدا ناهێنرێت.',

  chartTitle: 'تەوەرە بڕیاردەرەکان',
  chartLegend: 'درێژتر باشترە — تەنانەت لەو تەوەرانەشدا کە کەمتر باشترە، ڕاژە پێشتر پێچەوانەی کردوونەتەوە.',
  chartNone: 'تەوەرەی بڕیاردەری پێویست نییە بۆ کێشانی خشتە: بەرهەمەکان وەک یەکن یان بەهاکان کەمن.',

  priceTitle: 'نرخ',
  priceFrom: 'نرخ «دەست پێدەکات لە» ئەم ژمارەیە: هەڵبژاردە و ڕەنگ و گەیاندن لەسەری زیاد دەکرێن.',
  cheapest: 'هەرزانترین',
  moreThanCheapest: (iqd, percent) => `${iqd} گرانتر (+${percent}%)`,
  priceNotScored: 'نرخ پیشان دەدرێت و لە ئەنجامی سەرەوەدا ناژمێردرێت — ئەمە هەڵسەنگاندنە، نەک سەرکەوتن.',

  specsTitle: 'تایبەتمەندییەکان',
  sharedGroup: 'هاوبەش',
  narrowGroup: 'بۆ هەمووان نییە',
  narrowGroupNote: 'ئەم کۆمەڵەیە تەنها بۆ یەک ئامێر تۆمار کراوە، بۆیە خانەی بەتاڵ لێرەدا لاوازی نییە.',
  missing: 'نەوتراوە',
  notScored: 'ناژمێردرێت',
  tieRow: 'یەکسان',
  informational: 'تەنها بۆ زانیاری',
  best: 'باشترین',
  diffOnly: 'تەنها جیاوازییەکان',
  diffOnlyNone: 'هەموو ڕیزە پیشاندراوەکان وەک یەکن — هیچ جیاوازییەک نییە.',
  identicalRows: (n) => `${n} ڕیزی وەک یەک شاردراونەتەوە`,

  slotsTitle: 'ئەو بەرهەمانەی بەراورد دەکرێن',
  addProduct: 'بەرهەمێک زیاد بکە',
  removeProduct: (name) => `${name} لە بەراوردەکە لابە`,
  replaceProduct: (name) => `${name} بگۆڕە`,
  moveStart: 'بیبە بۆ سەرەتا',
  moveEnd: 'بیبە بۆ کۆتایی',
  full: (max) => `تا ${max} بەرهەم لە یەک کاتدا.`,
  pickTitle: 'بەرهەمێک هەڵبژێرە بۆ بەراورد',
  pickSearch: 'بە ناو بگەڕێ (هەڵبژاردەیی)',
  pickSearching: 'دەگەڕێت…',
  pickNone: 'هیچ شتێک نییە بەراورد بکرێت.',
  pickNoneHint: 'ناوێکی تر تاقی بکەرەوە، یان فرۆشگا بکەرەوە و لەوێ هەڵبژێرە.',
  pickLike: (name) => `بەرهەمی وەک ${name}`,
  openProduct: 'لاپەڕەی بەرهەم بکەرەوە',

  emptyTitle: 'بەراورد دەست پێ بکە',
  emptyBody: 'لانیکەم دوو بەرهەم هەڵبژێرە. بەستەرەکە هەڵبژاردنەکەت دەپارێزێت، بۆیە دەتوانیت بۆ هەر کەسێکی بنێریت.',
  emptyRecent: 'لەوەی بەم دواییە سەیرت کردووە',
  browse: 'فرۆشگا ببینە',
  onlyOneTitle: 'تەنها یەک بەرهەم',
  onlyOneBody: 'بەرهەمێکی دووەم زیاد بکە تا ببێتە بەراورد.',
  dropThis: 'لایبە و بەردەوام بە',
  startOver: 'لە سەرەتاوە دەست پێ بکە',
  loading: 'بەراوردەکە ئامادە دەکرێت…',
};

const DICTIONARIES: Record<CompareLang, CompareStrings> = { ar, en, ckb };

export function compareStrings(lang: string): CompareStrings {
  return DICTIONARIES[lang as CompareLang] ?? DICTIONARIES.ar;
}
