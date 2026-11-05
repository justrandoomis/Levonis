/**
 * «التسعير التقديري» — EVERY WORD OF THE OWNER'S ESTIMATES WORKSPACE, ITS
 * SUPPLIER LINKS AND THE PRODUCT FORM'S BANNER (docs/SMART_PRICING.md §3.9,
 * §4.6, §7; DECISIONS rows 183, 278–282).
 *
 * Arabic, English and Sorani for every string. A Sorani slot is its own
 * Sorani — never the Arabic or the English pasted across (row 183) — written
 * with the codebase's own words: «خەمڵێنراو» (estimated), «پێشداواکاری»
 * (pre-order), «دابینکەر» (supplier), «بەستەر» (link), «بەرهەم» (product),
 * «نرخدانان و ناردنی بەرهەم» (the pricing tab). A native review is still
 * recommended (owner question 282(k)).
 *
 * The flag labels are the owner's words for the estimator's CODES (§4.6,
 * packages/contracts/src/priceEstimates.ts); a code without a label here
 * falls back to the pricing contract's own sentence (pricingIssues.ts) and
 * then to the code itself. No figure lives here: no price, rate, measure or
 * profit (invariant I8) — the figures on screen are the server's.
 */
import {
  ESTIMATE_BLOCKING_FLAGS,
  ESTIMATE_HARD_FLAGS,
  ESTIMATE_INFO_FLAGS,
  ESTIMATE_SOFT_FLAGS,
  ESTIMATE_STRINGS,
  estimateRefusalText,
  type EstimateFlag,
} from '../../../packages/contracts/src/priceEstimates';
import { isPricingIssueCode, pricingIssueLabel } from '../../../packages/contracts/src/pricingIssues';
import type { SupplierPriceFormatReason } from '../../../packages/catalog/src/supplierPrices/format';
import type { OwnerLinkError } from '../../../packages/catalog/src/supplierPrices/ownerLink';

export type UiLang = 'ar' | 'en' | 'ckb';

export interface Tri {
  readonly ar: string;
  readonly en: string;
  readonly ckb: string;
}

const t = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

/** The site's language as this table's key — Arabic unless English or Sorani. */
export const uiLang = (lang: string | null | undefined): UiLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');

/** One string in the reader's language, its `{slots}` filled. */
export function say(text: Tri, lang: UiLang, vars: Readonly<Record<string, string | number>> = {}): string {
  const s = text[lang] || text.ar;
  return s.replace(/\{(\w+)\}/g, (whole, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : whole));
}

// ---------------------------------------------------------------- the workspace

export const WORKSPACE = {
  title: t('التسعير التقديري', 'Estimated pricing', 'نرخدانانی خەمڵێنراو'),
  intro: t(
    'أسعار تقديرية للطلب المسبق من أسعار Bambu Lab الرسمية: التقط الأسعار، طابقها، راجعها، ثم طبّقها منتجًا منتجًا. لا يرى الزبون إلا السعر النهائي ووسم «سعر تقديري».',
    'Estimated pre-order prices from Bambu Lab’s official prices: capture the prices, match them, review them, then apply them product by product. Customers see only the final price and the “Estimated price” label.',
    'نرخی خەمڵێنراو بۆ پێشداواکاری لە نرخە فەرمییەکانی Bambu Lab: نرخەکان تۆمار بکە، بیانگونجێنە، پێیاندا بچۆرەوە، پاشان بەرهەم بە بەرهەم جێبەجێیان بکە. کڕیار تەنها نرخی کۆتایی و نیشانەی «نرخی خەمڵێنراو» دەبینێت.'
  ),
  back: t('رجوع إلى التسعير والشحن', 'Back to Pricing & shipping', 'گەڕانەوە بۆ نرخدانان و ناردنی بەرهەم'),
  tabsLabel: t('أقسام التسعير التقديري', 'Estimated pricing sections', 'بەشەکانی نرخدانانی خەمڵێنراو'),
  cardTitle: t('التسعير التقديري لمنتجات Bambu Lab', 'Estimated pricing for Bambu Lab products', 'نرخدانانی خەمڵێنراو بۆ بەرهەمەکانی Bambu Lab'),
  cardBody: t(
    'لقطات أسعار المورّد، المطابقة، روابط Tmall والمتجر الأوروبي لكل منتج، الأنواع والمفاتيح، ثم تطبيق الأسعار التقديرية وتأكيدها.',
    'Supplier price captures, matching, the Tmall and EU store links of every product, the types and switches, then applying and confirming estimated prices.',
    'تۆمارەکانی نرخی دابینکەر، گونجاندن، بەستەرەکانی Tmall و فرۆشگای ئەوروپا بۆ هەموو بەرهەمێک، جۆرەکان و کلیلەکان، پاشان جێبەجێکردن و پشتڕاستکردنەوەی نرخە خەمڵێنراوەکان.'
  ),
  open: t('افتح التسعير التقديري', 'Open estimated pricing', 'نرخدانانی خەمڵێنراو بکەرەوە'),
  loading: t('يُحمَّل…', 'Loading…', 'بار دەکرێت…'),
} as const;

export const TAB_LABELS = {
  links: t('روابط المورّد', 'Supplier links', 'بەستەرەکانی دابینکەر'),
  review: t('المراجعة', 'Review', 'پێداچوونەوە'),
  ready: t('جاهز للتطبيق', 'Ready', 'ئامادە بۆ جێبەجێکردن'),
  estimated: t('المنتجات التقديرية', 'Estimated', 'خەمڵێنراوەکان'),
  flags: t('الملاحظات', 'Flags', 'تێبینییەکان'),
  refresh: t('التحديث', 'Refresh', 'نوێکردنەوە'),
  snapshots: t('لقطات الأسعار', 'Price captures', 'تۆمارەکانی نرخ'),
  types: t('الأنواع والمفاتيح', 'Types & switches', 'جۆرەکان و کلیلەکان'),
} as const;

export const COMMON = {
  retry: t('أعد المحاولة', 'Retry', 'دووبارە هەوڵ بدەرەوە'),
  loadFailed: t('تعذّر التحميل.', 'Could not load.', 'بار نەکرا.'),
  actionFailed: t('لم يتم الإجراء.', 'The action did not go through.', 'کارەکە ئەنجام نەدرا.'),
  saved: t('تم الحفظ.', 'Saved.', 'پاشەکەوت کرا.'),
  save: t('احفظ', 'Save', 'پاشەکەوت بکە'),
  cancel: t('إلغاء', 'Cancel', 'پاشگەزبوونەوە'),
  close: t('إغلاق', 'Close', 'دایبخە'),
  empty: t('لا شيء هنا.', 'Nothing here.', 'هیچ شتێک لێرە نییە.'),
  nextPage: t('الصفحة التالية', 'Next page', 'پەڕەی دواتر'),
  prevPage: t('الصفحة السابقة', 'Previous page', 'پەڕەی پێشوو'),
  pageOf: t('الصفحة {n}', 'Page {n}', 'پەڕەی {n}'),
  openProduct: t('افتح المنتج', 'Open the product', 'بەرهەمەکە بکەرەوە'),
  wholeProduct: t('المنتج نفسه', 'The product itself', 'خودی بەرهەمەکە'),
  notInstalled: t(
    'التسعير التقديري غير متاح بعد على هذا الخادم؛ يظهر هنا حين يُفعَّل.',
    'Estimated pricing is not available on this server yet; it appears here once it is switched on.',
    'نرخدانانی خەمڵێنراو هێشتا لەم ڕاژەکارە بەردەست نییە؛ کاتێک چالاک کرا لێرە دەردەکەوێت.'
  ),
  changed: t(
    'تغيّر شيء منذ فتحت هذه الصفحة؛ أُعيد تحميلها — راجعها ثم أعد المحاولة.',
    'Something changed since you opened this; it was reloaded — review it, then try again.',
    'لەو کاتەوەی ئەمەت کردەوە شتێک گۆڕاوە؛ دووبارە بار کرایەوە — پێیدا بچۆرەوە و پاشان دووبارە هەوڵ بدەرەوە.'
  ),
  stop: t('أوقف', 'Stop', 'ڕایبگرە'),
  stopped: t('أُوقف.', 'Stopped.', 'ڕاگیرا.'),
  iqd: t('د.ع', 'IQD', 'دینار'),
  selectRow: t('حدّد {name}', 'Select {name}', '{name} دیاری بکە'),
  selectAll: t('حدّد الكل', 'Select all', 'هەموو دیاری بکە'),
  more: t('و{n} أخرى', 'and {n} more', 'و {n}ی تر'),
} as const;

// ---------------------------------------------------------------- «روابط المورّد» (§3.9)

export const LINKS = {
  intro: t(
    'كل منتج له مطابقة عند المورّد: رقم Tmall ورابط كل خيار، وروابط المتجر الأوروبي، والسعر الملتقط بعملته وتاريخه. اضغط الرابط لتطلب المنتج أو لتتحقق من سعره، أو حدّث السعر من هنا.',
    'Every product with a supplier match: the Tmall id and a link to each option, the EU store links, and the captured price with its currency and date. Tap a link to order the product or check its price, or update the price from here.',
    'هەموو بەرهەمێک کە لای دابینکەر هاوتای هەیە: ژمارەی Tmall و بەستەری هەر هەڵبژاردەیەک، بەستەرەکانی فرۆشگای ئەوروپا، و نرخی تۆمارکراو لەگەڵ دراو و بەروارەکەی. بەستەرەکە دابگرە بۆ داواکردنی بەرهەمەکە یان پشکنینی نرخەکەی، یان لێرەوە نرخەکە نوێ بکەرەوە.'
  ),
  search: t('ابحث', 'Search', 'بگەڕێ'),
  searchLabel: t('ابحث في الروابط', 'Search the links', 'لە بەستەرەکاندا بگەڕێ'),
  searchPlaceholder: t(
    'اسم المنتج، رابط Tmall أو رقمه، رابط المتجر أو اسمه فيه، رقم الخيار، رمز اللون أو القطعة',
    'Product name, Tmall link or id, store link or handle, option id, colour or part code',
    'ناوی بەرهەم، بەستەر یان ژمارەی Tmall، بەستەر یان ناوی فرۆشگا، ژمارەی هەڵبژاردە، کۆدی ڕەنگ یان پارچە'
  ),
  clear: t('امسح البحث', 'Clear the search', 'گەڕانەکە پاک بکەرەوە'),
  sourceFilter: t('المصدر', 'Source', 'سەرچاوە'),
  allSources: t('كل المصادر', 'All sources', 'هەموو سەرچاوەکان'),
  empty: t(
    'لا يوجد منتج بمطابقة عند المورّد بعد. ارفع لقطة أسعار وشغّل المطابقة من «لقطات الأسعار».',
    'No product has a supplier match yet. Upload a price capture and run matching from “Price captures”.',
    'هێشتا هیچ بەرهەمێک لای دابینکەر هاوتای نییە. تۆمارێکی نرخ بار بکە و لە «تۆمارەکانی نرخ» گونجاندن ئەنجام بدە.'
  ),
  emptySearch: t('لا نتائج لهذا البحث.', 'No results for this search.', 'ئەم گەڕانە هیچ ئەنجامێکی نییە.'),
  noLinkForSku: t('لا رابط لهذا الخيار بعد.', 'No link for this option yet.', 'هێشتا بۆ ئەم هەڵبژاردەیە بەستەر نییە.'),
  tmallId: t('رقم Tmall', 'Tmall id', 'ژمارەی Tmall'),
  storeHandle: t('الاسم في المتجر', 'Store handle', 'ناو لە فرۆشگادا'),
  skuId: t('رقم الخيار', 'Option id', 'ژمارەی هەڵبژاردە'),
  copy: t('نسخ', 'Copy', 'کۆپی بکە'),
  copyWhat: t('نسخ {what}', 'Copy {what}', 'کۆپیکردنی {what}'),
  copied: t('تم النسخ', 'Copied', 'کۆپی کرا'),
  copyFailed: t('تعذّر النسخ — حدّد الرقم وانسخه بنفسك.', 'Could not copy — select the id and copy it yourself.', 'کۆپی نەکرا — ژمارەکە دیاری بکە و خۆت کۆپی بکە.'),
  openTmall: t('افتح في Tmall', 'Open in Tmall', 'لە Tmall بیکەرەوە'),
  openEu: t('افتح في المتجر الأوروبي', 'Open in the EU store', 'لە فرۆشگای ئەوروپا بیکەرەوە'),
  openUs: t('افتح في المتجر الأمريكي', 'Open in the US store', 'لە فرۆشگای ئەمریکا بیکەرەوە'),
  openOption: t('افتح هذا الخيار', 'Open this option', 'ئەم هەڵبژاردەیە بکەرەوە'),
  newTab: t('(يفتح في لسان جديد)', '(opens in a new tab)', '(لە تابێکی نوێدا دەکرێتەوە)'),
  noLink: t('بلا رابط: الرقم لا يطابق صيغة المورّد.', 'No link: the id does not fit the supplier’s format.', 'بێ بەستەر: ژمارەکە لەگەڵ شێوازی دابینکەر ناگونجێت.'),
  supplierOption: t('الخيار عند المورّد', 'Supplier option', 'هەڵبژاردەی دابینکەر'),
  codes: t('الرموز', 'Codes', 'کۆدەکان'),
  captured: t('التُقط {date}', 'Captured {date}', 'تۆمارکراوە لە {date}'),
  entered: t('أُدخل {date}', 'Entered {date}', 'نووسراوە لە {date}'),
  missing: t(
    'لم يعد في آخر لقطة — افتح الرابط وتحقق من السعر.',
    'No longer in the latest capture — open the link and check the price.',
    'لە کۆتا تۆماردا نەماوە — بەستەرەکە بکەرەوە و نرخەکە بپشکنە.'
  ),
  outOfStock: t('نفد عند المورّد', 'Out of stock at the supplier', 'لای دابینکەر نەماوە'),
  unitsDivided: t('مقسوم على {n} قطع', 'Divided by {n} units', 'دابەشکراو بەسەر {n} یەکەدا'),
  confidence: t('الثقة: {level}', 'Confidence: {level}', 'متمانە: {level}'),
  note: t('ملاحظة: {note}', 'Note: {note}', 'تێبینی: {note}'),
  updatePrice: t('تحديث السعر', 'Update the price', 'نوێکردنەوەی نرخ'),
  productCount: t('{n} منتجًا في هذه الصفحة', '{n} products on this page', '{n} بەرهەم لەم پەڕەیەدا'),
} as const;

export const SOURCE_LABELS: Readonly<Record<'tmall_cn' | 'bambu_eu' | 'bambu_us' | 'typed' | 'store_page' | 'none', Tri>> = {
  tmall_cn: t('Tmall (الصين)', 'Tmall (China)', 'Tmall (چین)'),
  bambu_eu: t('المتجر الأوروبي', 'EU store', 'فرۆشگای ئەوروپا'),
  bambu_us: t('المتجر الأمريكي (مرجع)', 'US store (reference)', 'فرۆشگای ئەمریکا (سەرچاوەی بەراورد)'),
  typed: t('سعر كتبته', 'Your typed price', 'نرخی نووسراوی خۆت'),
  store_page: t('سعر من صفحة متجر', 'Price from a store page', 'نرخ لە پەڕەی فرۆشگاوە'),
  none: t('بلا سعر', 'No price', 'بێ نرخ'),
};

export const LINK_STATE_LABELS: Readonly<Record<'auto' | 'confirmed' | 'suggested' | 'rejected' | 'manual', Tri>> = {
  auto: t('مؤكَّد تلقائيًا', 'Auto-confirmed', 'بە خۆکاری پشتڕاستکراوە'),
  confirmed: t('مؤكَّد', 'Confirmed', 'پشتڕاستکراوە'),
  suggested: t('مقترح', 'Suggested', 'پێشنیارکراو'),
  rejected: t('مرفوض', 'Rejected', 'ڕەتکراوە'),
  manual: t('سعرك', 'Your price', 'نرخی خۆت'),
};

export const CONFIDENCE_LABELS: Readonly<Record<'exact' | 'high' | 'medium' | 'low', Tri>> = {
  exact: t('مطابق تمامًا', 'Exact', 'تەواو وەک یەک'),
  high: t('عالية', 'High', 'بەرز'),
  medium: t('متوسطة', 'Medium', 'مامناوەند'),
  low: t('منخفضة', 'Low', 'کەم'),
};

// ---------------------------------------------------------------- «تحديث السعر» (§3.6)

export const PRICE_SHEET = {
  title: t('تحديث السعر — {sku}', 'Update the price — {sku}', 'نوێکردنەوەی نرخ — {sku}'),
  intro: t(
    'اكتب السعر الذي رأيته عند المورّد، أو اقرأ صفحة المتجر. السعر الذي تكتبه يُقدَّم على كل لقطة حتى تحذفه.',
    'Type the price you saw at the supplier, or read the store page. A price you type comes before any capture until you remove it.',
    'ئەو نرخەی لای دابینکەر بینیت بنووسە، یان پەڕەی فرۆشگاکە بخوێنەوە. ئەو نرخەی دەینووسیت پێش هەموو تۆمارێک دێت تا لای دەبەیت.'
  ),
  tmallNote: t(
    'لا يقرأ الخادم صفحات Tmall: افتح الرابط (يفتح تطبيق Tmall على الهاتف)، اقرأ السعر واكتبه هنا.',
    'The server never reads Tmall pages: open the link (on a phone the Tmall app opens), read the price and type it here.',
    'ڕاژەکار هەرگیز پەڕەکانی Tmall ناخوێنێتەوە: بەستەرەکە بکەرەوە (لە مۆبایلدا ئەپی Tmall دەکرێتەوە)، نرخەکە بخوێنەوە و لێرە بینووسە.'
  ),
  manualTitle: t('سعر تكتبه', 'A price you type', 'نرخێک کە دەینووسیت'),
  amount: t('السعر', 'Price', 'نرخەکە'),
  currency: t('العملة', 'Currency', 'دراوەکە'),
  note: t('ملاحظة', 'Note', 'تێبینی'),
  save: t('احفظ السعر', 'Save the price', 'نرخەکە پاشەکەوت بکە'),
  saved: t('حُفظ سعرك: {price}', 'Your price is saved: {price}', 'نرخەکەت پاشەکەوت کرا: {price}'),
  remove: t('احذف سعري', 'Remove my price', 'نرخەکەم لاببە'),
  removed: t('حُذف سعرك؛ يعود التقدير إلى اللقطات.', 'Your price is removed; the estimate goes back to the captures.', 'نرخەکەت لابرا؛ خەمڵاندنەکە دەگەڕێتەوە سەر تۆمارەکان.'),
  current: t('سعرك الحالي: {price}', 'Your current price: {price}', 'نرخی ئێستای خۆت: {price}'),
  amountInvalid: t(
    'اكتب السعر أرقامًا، والفاصلة العشرية نقطة.',
    'Type the price in digits, with a point for decimals.',
    'نرخەکە بە ژمارە بنووسە، و بۆ کەرت خاڵ بەکاربهێنە.'
  ),
  amountRequired: t('اكتب السعر أولًا.', 'Type the price first.', 'سەرەتا نرخەکە بنووسە.'),
  noteInvalid: t('الملاحظة طويلة جدًا أو فيها رمز غير مقبول.', 'The note is too long or holds a character that is not accepted.', 'تێبینییەکە زۆر درێژە یان پیتێکی وەرنەگیراوی تێدایە.'),
  sameForAll: t('السعر نفسه لكل خيارات المنتج', 'The same price for every option of the product', 'هەمان نرخ بۆ هەموو هەڵبژاردەکانی بەرهەمەکە'),
  sameAsNote: t('مثل {sku}', 'Same as {sku}', 'وەک {sku}'),
  allSkus: t('كل الخيارات', 'Every option', 'هەموو هەڵبژاردەکان'),
  oneSku: t('هذا الخيار فقط', 'This option only', 'تەنها ئەم هەڵبژاردەیە'),
  storeTitle: t('اقرأ صفحة المتجر', 'Read the store page', 'پەڕەی فرۆشگاکە بخوێنەوە'),
  storeIntro: t(
    'قراءة واحدة لهذه الصفحة الآن، من المتجر الأوروبي أو الأمريكي فقط؛ يُحفظ سعر الخيار بعملة الصفحة نفسها.',
    'One read of this page now, from the EU or US store only; the option’s price is saved in the page’s own currency.',
    'یەک جار خوێندنەوەی ئەم پەڕەیە ئێستا، تەنها لە فرۆشگای ئەوروپا یان ئەمریکا؛ نرخی هەڵبژاردەکە بە دراوی خودی پەڕەکە پاشەکەوت دەکرێت.'
  ),
  storeUrl: t('رابط صفحة المتجر', 'Store page link', 'بەستەری پەڕەی فرۆشگا'),
  readAndSave: t('اقرأ واحفظ', 'Read and save', 'بیخوێنەوە و پاشەکەوتی بکە'),
  readOnly: t('اقرأ فقط', 'Read only', 'تەنها بیخوێنەوە'),
  storeSaved: t('حُفظ السعر {price} من {host}.', 'Saved {price} from {host}.', 'نرخی {price} لە {host}ەوە پاشەکەوت کرا.'),
  storeSavedSale: t(
    'الصفحة في تخفيض: حُفظ السعر العادي {price} من {host}، لا سعر التخفيض {sale} الذي ينتهي بانتهاء التخفيض.',
    'The page is on sale: the regular price {price} was saved from {host}, not the sale price {sale}, which ends with the sale.',
    'پەڕەکە داشکاندنی لەسەرە: نرخی ئاسایی {price} لە {host}ەوە پاشەکەوت کرا، نەک نرخی دوای داشکاندن {sale}، کە لەگەڵ داشکاندنەکە کۆتایی دێت.'
  ),
  // On sale, but the saved variant's sale price is not known (no variant in the link, and the options' sale prices differ).
  storeSavedRegular: t(
    'الصفحة في تخفيض: حُفظ السعر العادي {price} من {host}، لا سعر التخفيض الذي ينتهي بانتهاء التخفيض.',
    'The page is on sale: the regular price {price} was saved from {host}, not the sale price, which ends with the sale.',
    'پەڕەکە داشکاندنی لەسەرە: نرخی ئاسایی {price} لە {host}ەوە پاشەکەوت کرا، نەک نرخی دوای داشکاندن، کە لەگەڵ داشکاندنەکە کۆتایی دێت.'
  ),
  saleNote: t(
    'الصفحة في تخفيض. السعر الظاهر هنا لكل خيار هو سعره العادي (المشطوب في الصفحة)، وهو الذي يُحفظ؛ سعر التخفيض ينتهي بانتهاء التخفيض.',
    'The page is on sale. Each option’s price here is its regular price (struck through on the page), and that is the one saved: a sale price ends with the sale.',
    'پەڕەکە داشکاندنی لەسەرە. نرخی هەر هەڵبژاردەیەک لێرە نرخی ئاسایی خۆیەتی (ئەوەی لە پەڕەکەدا هێڵی بەسەردا هاتووە)، و ئەوە پاشەکەوت دەکرێت؛ نرخی دوای داشکاندن لەگەڵ داشکاندنەکە کۆتایی دێت.'
  ),
  salePrice: t('سعر التخفيض', 'Sale price', 'نرخی دوای داشکاندن'),
  storeRead: t('قُرئت الصفحة من {host}.', 'The page was read from {host}.', 'پەڕەکە لە {host}ەوە خوێندرایەوە.'),
  redirected: t(
    'أرسل المتجر القراءة إلى متجر آخر؛ السعر بعملة ذلك المتجر، لا باليورو.',
    'The store sent the read to another store; the price is in that store’s currency, not in euros.',
    'فرۆشگاکە خوێندنەوەکەی بۆ فرۆشگایەکی تر نارد؛ نرخەکە بە دراوی ئەو فرۆشگایەیە، نەک بە یۆرۆ.'
  ),
  offers: t('الخيارات في الصفحة', 'Options on the page', 'هەڵبژاردەکانی پەڕەکە'),
  chosen: t('هذا الخيار', 'This option', 'ئەم هەڵبژاردەیە'),
  noOffer: t(
    'لم تُسمِّ الصفحة هذا الخيار؛ افتح رابط الخيار نفسه أو اكتب السعر.',
    'The page does not name this option; open the option’s own link or type the price.',
    'پەڕەکە ناوی ئەم هەڵبژاردەیەی نەهێناوە؛ بەستەری خودی هەڵبژاردەکە بکەرەوە یان نرخەکە بنووسە.'
  ),
  // The option the link names is on the page with several prices (its JSON-LD copies disagree): none is saved.
  copiesDisagree: t(
    'تعرض الصفحة لهذا الخيار أكثر من سعر، فلا يمكن حفظ أيٍّ منها؛ اكتب السعر بنفسك.',
    'The page shows more than one price for this option, so none of them can be saved; type the price yourself.',
    'پەڕەکە زیاتر لە یەک نرخ بۆ ئەم هەڵبژاردەیە پیشان دەدات، بۆیە هیچیان پاشەکەوت ناکرێت؛ نرخەکە خۆت بنووسە.'
  ),
  inStock: t('متوفر', 'In stock', 'بەردەستە'),
  outOfStock: t('نفد', 'Sold out', 'نەماوە'),
  unknownStock: t('التوفر غير معروف', 'Availability unknown', 'بەردەستبوون نەزانراوە'),
  urlInvalid: t('هذا ليس رابط منتج في المتجر الأوروبي أو الأمريكي.', 'This is not a product link of the EU or US store.', 'ئەمە بەستەری بەرهەمێکی فرۆشگای ئەوروپا یان ئەمریکا نییە.'),
} as const;

/**
 * The owner-only refusals the estimate contract does not carry (their server
 * sentences are "ar / en"). PRICE_ESTIMATE_STORE_PAGE_UNREADABLE is the
 * contract's own (ESTIMATE_REFUSALS), so `refusalText` resolves it there.
 */
export const OWNER_REFUSALS: Readonly<Record<string, Tri>> = {
  // packages/catalog/src/supplierPrices/format.ts SUPPLIER_PRICE_FORMAT_MESSAGE, the same three sentences.
  SUPPLIER_PRICE_FORMAT_INVALID: t(
    'ملف أسعار المورّد غير صالح، فلم يُرفع منه شيء.',
    'The supplier price file is not valid, so nothing from it was uploaded.',
    'فایلی نرخەکانی دابینکەر دروست نییە، بۆیە هیچ شتێکی لێ بار نەکرا.'
  ),
};

// ---------------------------------------------------------------- «المراجعة» (§3.6, §7)

export const REVIEW = {
  intro: t(
    'المطابقات المقترحة والمؤكدة تلقائيًا، خيارًا بخيار. أكّد أو ارفض، ابحث في اللقطات، اقرأ صفحة متجر أو اكتب السعر بنفسك، واختر نوع المنتج ومساره.',
    'Suggested and auto-confirmed matches, option by option. Confirm or reject, search the captures, read a store page or type the price yourself, and choose the product’s type and route.',
    'هاوتا پێشنیارکراو و بە خۆکاری پشتڕاستکراوەکان، هەڵبژاردە بە هەڵبژاردە. پشتڕاستی بکەرەوە یان ڕەتی بکەرەوە، لە تۆمارەکاندا بگەڕێ، پەڕەی فرۆشگایەک بخوێنەوە یان نرخەکە خۆت بنووسە، و جۆر و ڕێگای بەرهەمەکە هەڵبژێرە.'
  ),
  filterLabel: t('أي المطابقات', 'Which matches', 'کام هاوتاکان'),
  filters: {
    suggested: t('مقترحة', 'Suggested', 'پێشنیارکراو'),
    auto: t('مؤكدة تلقائيًا', 'Auto-confirmed', 'بە خۆکاری پشتڕاستکراو'),
    rejected: t('مرفوضة', 'Rejected', 'ڕەتکراو'),
    missing: t('اختفت من آخر لقطة', 'Gone from the latest capture', 'لە کۆتا تۆماردا نەماون'),
  },
  focus: t('منتج واحد', 'One product', 'یەک بەرهەم'),
  showAll: t('اعرض كل المطابقات', 'Show every match', 'هەموو هاوتاکان پیشان بدە'),
  confirm: t('أكّد', 'Confirm', 'پشتڕاستی بکەرەوە'),
  reject: t('ارفض', 'Reject', 'ڕەتی بکەرەوە'),
  confirmed: t('أُكّدت المطابقة.', 'The match is confirmed.', 'هاوتاکە پشتڕاست کرایەوە.'),
  rejectedDone: t('رُفضت المطابقة.', 'The match is rejected.', 'هاوتاکە ڕەت کرایەوە.'),
  acceptAll: t('اقبل المقترحات العالية والمتوسطة ({n})', 'Accept the high and medium suggestions ({n})', 'پێشنیارە بەرز و مامناوەندەکان وەربگرە ({n})'),
  acceptedAll: t('قُبلت {n} مطابقات.', '{n} matches accepted.', '{n} هاوتا وەرگیران.'),
  units: t('القطع في العرض', 'Units in the offer', 'یەکەکانی ئۆفەرەکە'),
  unitsHint: t(
    'لعرض فيه عدة قطع فقط: يُقسم سعره عليها (تُذكر في الملاحظات).',
    'Only for an offer of several units: its price is divided by them (listed in the flags).',
    'تەنها بۆ ئۆفەرێک کە چەند یەکەیەکی تێدایە: نرخەکەی بەسەریاندا دابەش دەکرێت (لە تێبینییەکاندا دەنووسرێت).'
  ),
  unitsInvalid: t('عدد قطع صحيح من 1 إلى 1000.', 'A whole number of units from 1 to 1000.', 'ژمارەیەکی تەواوی یەکە لە 1 تا 1000.'),
  findInCatalogue: t('ابحث في اللقطات', 'Search the captures', 'لە تۆمارەکاندا بگەڕێ'),
  typePrice: t('اكتب السعر', 'Type the price', 'نرخەکە بنووسە'),
  readStore: t('اقرأ صفحة متجر', 'Read a store page', 'پەڕەی فرۆشگایەک بخوێنەوە'),
  settings: t('النوع والمسار', 'Type and route', 'جۆر و ڕێگا'),
  computeAgain: t('احسب من جديد', 'Compute again', 'دووبارە هەژمار بکەرەوە'),
  computed: t('حُسب التقدير.', 'The estimate is computed.', 'خەمڵاندنەکە هەژمار کرا.'),
  mapTo: t('اربط بخيار المنتج', 'Map to the product’s option', 'ببەستەوە بە هەڵبژاردەی بەرهەمەکە'),
  map: t('اربط', 'Map', 'ببەستەوە'),
  reasons: t('الأسباب', 'Reasons', 'هۆکارەکان'),
  noCandidates: t('لا مرشحين لهذا الخيار.', 'No candidates for this option.', 'هیچ پاڵێوراوێک بۆ ئەم هەڵبژاردەیە نییە.'),
  noLinksYet: t(
    'لا مطابقة ولا سعر لهذا المنتج عند المورّد بعد. طابِقه الآن، أو ابحث عنه في اللقطات.',
    'This product has no supplier match or price yet. Match it now, or search the captures for it.',
    'ئەم بەرهەمە هێشتا هیچ هاوتا یان نرخێکی لای دابینکەر نییە. ئێستا بیگونجێنە، یان لە تۆمارەکاندا بۆی بگەڕێ.'
  ),
  matchOne: t('طابِق هذا المنتج', 'Match this product', 'ئەم بەرهەمە بگونجێنە'),
  empty: t('لا شيء ينتظر المراجعة هنا.', 'Nothing awaits review here.', 'لێرە هیچ شتێک چاوەڕێی پێداچوونەوە نییە.'),
  type: t('النوع', 'Type', 'جۆر'),
  typeAuto: t('يُحدَّد تلقائيًا', 'Decided automatically', 'بە خۆکاری دیاری دەکرێت'),
  sourcing: t('مصدر الشراء', 'Sourcing', 'سەرچاوەی کڕین'),
  route: t('المسار', 'Route', 'ڕێگا'),
  asType: t('حسب النوع', 'As the type', 'بەپێی جۆرەکە'),
  settingsSaved: t('حُفظ النوع والمسار؛ احسب من جديد لترى أثرهما.', 'Type and route saved; compute again to see their effect.', 'جۆر و ڕێگا پاشەکەوت کران؛ دووبارە هەژمار بکەرەوە بۆ بینینی کاریگەرییان.'),
  settingsNeedType: t('اختر النوع أولًا: المصدر والمسار يتبعانه.', 'Choose the type first: the sourcing and route follow it.', 'سەرەتا جۆرەکە هەڵبژێرە: سەرچاوە و ڕێگا بەدوای ئەودا دێن.'),
} as const;

export const LOOKUP = {
  title: t('ابحث في لقطات الأسعار', 'Search the price captures', 'لە تۆمارەکانی نرخدا بگەڕێ'),
  placeholder: t(
    'رابط Tmall أو رقمه، رابط المتجر، رقم خيار، رمز لون أو قطعة، أو كلمات من الاسم',
    'A Tmall link or id, a store link, an option id, a colour or part code, or words of the name',
    'بەستەر یان ژمارەی Tmall، بەستەری فرۆشگا، ژمارەی هەڵبژاردە، کۆدی ڕەنگ یان پارچە، یان وشەکانی ناو'
  ),
  results: t('{n} نتيجة', '{n} results', '{n} ئەنجام'),
  none: t('لا شيء في اللقطات الحالية يطابق هذا البحث.', 'Nothing in the current captures fits this search.', 'هیچ شتێک لە تۆمارە ئێستاییەکاندا لەگەڵ ئەم گەڕانە ناگونجێت.'),
  matchedTo: t('مطابق مع: {names}', 'Matched to: {names}', 'هاوتایە لەگەڵ: {names}'),
  highlight: t('الخيار المطلوب', 'The option asked for', 'هەڵبژاردەی داواکراو'),
} as const;

// ---------------------------------------------------------------- «لقطات الأسعار» (§3.3, §3.4)

/**
 * Why the browser's strict parser refused a price file (packages/catalog/src/supplierPrices/format.ts
 * `SupplierPriceFormatReason`), in the owner's words — the phrase inside SNAPSHOTS.failures.format. Typed by
 * the parser's own union, so a new reason cannot ship without its three languages.
 */
export const FORMAT_REASON_LABELS: Readonly<Record<SupplierPriceFormatReason, Tri>> = {
  not_json: t('نص لا يُقرأ كـ JSON', 'text that does not read as JSON', 'دەقێک کە وەک JSON ناخوێندرێتەوە'),
  wrong_type: t('قيمة من نوع خاطئ', 'a value of the wrong type', 'بەهایەکی جۆری هەڵە'),
  unknown_key: t('حقل غير معروف', 'an unknown field', 'خانەیەکی نەناسراو'),
  missing_key: t('حقل مطلوب ناقص', 'a required field is missing', 'خانەیەکی پێویست دیار نییە'),
  not_allowed_value: t('قيمة غير مسموح بها', 'a value that is not allowed', 'بەهایەکی ڕێگەپێنەدراو'),
  currency_mismatch: t('عملة لا تناسب المصدر', 'a currency that does not fit the source', 'دراوێک کە لەگەڵ سەرچاوەکە ناگونجێت'),
  too_long: t('نص أطول من المسموح', 'a text longer than allowed', 'دەقێکی درێژتر لە ڕێگەپێدراو'),
  too_many: t('عناصر أكثر من المسموح', 'more entries than allowed', 'بڕگەی زیاتر لە ڕێگەپێدراو'),
  empty: t('قيمة فارغة', 'an empty value', 'بەهایەکی بەتاڵ'),
  duplicate: t('عنصر مكرر', 'a duplicate entry', 'بڕگەیەکی دووبارە'),
  bad_id: t('معرّف غير صالح', 'an invalid id', 'ناسنامەیەکی نادروست'),
  bad_url: t('رابط غير صالح', 'an invalid link', 'بەستەرێکی نادروست'),
  bad_host: t('رابط إلى موقع غير موقع المصدر', 'a link to a site other than the source’s', 'بەستەرێک بۆ ماڵپەڕێکی جگە لە ماڵپەڕی سەرچاوەکە'),
  bad_date: t('تاريخ غير صالح', 'an invalid date', 'بەروارێکی نادروست'),
  bad_price: t('سعر غير صالح', 'an invalid price', 'نرخێکی نادروست'),
  float_price: t('سعر بأكثر من منزلتين عشريتين', 'a price with more than two decimals', 'نرخێک بە زیاتر لە دوو ژمارە دوای خاڵ'),
  figure_in_label: t('رقم في نص السعر', 'a figure in the price label', 'ژمارەیەک لە نیشانەی نرخەکەدا'),
  control_character: t('حرف تحكم مخفي', 'a hidden control character', 'پیتێکی کۆنترۆڵی شاراوە'),
};

/** A parser refusal's reason in the owner's words; an unknown reason reads as itself. */
export const formatReasonText = (reason: string, lang: UiLang): string =>
  Object.prototype.hasOwnProperty.call(FORMAT_REASON_LABELS, reason) ? FORMAT_REASON_LABELS[reason as SupplierPriceFormatReason][lang] : reason;

export const SNAPSHOTS = {
  intro: t(
    'ارفع ملف أسعار (levonis.supplier-prices.v1): يُفحص ويُبصم في متصفحك ثم يُرسل على دفعات. اللقطة المكتملة تحل محل سابقتها من المصدر نفسه، والمطابقات المؤكدة تنتقل إليها.',
    'Upload a price file (levonis.supplier-prices.v1): it is checked and hashed in your browser, then sent in chunks. A complete capture replaces the previous one of the same source, and confirmed matches carry over to it.',
    'فایلێکی نرخ بار بکە (levonis.supplier-prices.v1): لە وێبگەڕەکەتدا دەپشکنرێت و پەنجەمۆری بۆ دەکرێت، پاشان بە بەش بەش دەنێردرێت. تۆمارێکی تەواو جێگەی تۆماری پێشووی هەمان سەرچاوە دەگرێتەوە، و هاوتا پشتڕاستکراوەکان دەگوازرێنەوە بۆی.'
  ),
  uploadTitle: t('ارفع لقطة', 'Upload a capture', 'تۆمارێک بار بکە'),
  chooseFile: t('اختر ملف الأسعار', 'Choose the price file', 'فایلی نرخەکان هەڵبژێرە'),
  reading: t('يُقرأ الملف ويُفحص…', 'Reading and checking the file…', 'فایلەکە دەخوێندرێتەوە و دەپشکنرێت…'),
  fileSummary: t(
    '{source} · {date} · {items} منتجًا · {skus} خيارًا',
    '{source} · {date} · {items} items · {skus} options',
    '{source} · {date} · {items} بڕگە · {skus} هەڵبژاردە'
  ),
  upload: t('ارفع', 'Upload', 'بار بکە'),
  uploading: t('يُرفع… {done} من {total} منتجًا', 'Uploading… {done} of {total} items', 'بار دەکرێت… {done} لە {total} بڕگە'),
  completing: t('تُكمَّل اللقطة…', 'Completing the capture…', 'تۆمارەکە تەواو دەکرێت…'),
  uploaded: t('اكتملت اللقطة وصارت الحالية لمصدرها.', 'The capture is complete and is now its source’s current one.', 'تۆمارەکە تەواو بوو و ئێستا تۆماری ئێستایی سەرچاوەکەیەتی.'),
  uploadFailed: t('توقف الرفع: {reason}', 'The upload stopped: {reason}', 'بارکردن ڕاگیرا: {reason}'),
  resume: t('تابع الرفع', 'Resume the upload', 'بارکردنەکە بەردەوام بکە'),
  discardPartial: t('احذف اللقطة غير المكتملة', 'Discard the incomplete capture', 'تۆمارە ناتەواوەکە فڕێ بدە'),
  failures: {
    too_big: t('الملف أكبر من أن يُقرأ في المتصفح.', 'The file is too large to read in the browser.', 'فایلەکە گەورەترە لەوەی لە وێبگەڕدا بخوێندرێتەوە.'),
    not_utf8: t('الملف ليس نصًا بترميز UTF-8.', 'The file is not UTF-8 text.', 'فایلەکە دەقی UTF-8 نییە.'),
    format: t('الملف غير صالح ({reason} في {path})؛ لم يُرسل منه شيء.', 'The file is not valid ({reason} at {path}); nothing from it was sent.', 'فایلەکە دروست نییە ({reason} لە {path})؛ هیچ شتێکی لێ نەنێردرا.'),
    item_too_large: t('المنتج رقم {index} في الملف أكبر من حدّ الدفعة؛ لم يُرسل شيء.', 'Item {index} of the file is larger than one chunk may be; nothing was sent.', 'بڕگەی ژمارە {index}ی فایلەکە لە سنووری یەک بەش گەورەترە؛ هیچ شتێک نەنێردرا.'),
    no_crypto: t('لا يستطيع هذا المتصفح حساب بصمة الملف؛ استعمل متصفحًا حديثًا.', 'This browser cannot hash the file; use an up-to-date browser.', 'ئەم وێبگەڕە ناتوانێت پەنجەمۆری فایلەکە هەژمار بکات؛ وێبگەڕێکی نوێ بەکاربهێنە.'),
  },
  listTitle: t('اللقطات', 'Captures', 'تۆمارەکان'),
  empty: t('لا لقطات بعد.', 'No captures yet.', 'هێشتا هیچ تۆمارێک نییە.'),
  counts: t(
    '{items} منتجًا · {skus} خيارًا · {matched} مطابقًا · {unmatched} غير مطابق',
    '{items} items · {skus} options · {matched} matched · {unmatched} unmatched',
    '{items} بڕگە · {skus} هەڵبژاردە · {matched} هاوتاکراو · {unmatched} هاوتانەکراو'
  ),
  loadingCounts: t('رُفع {items} من {total} منتجًا', '{items} of {total} items uploaded', '{items} لە {total} بڕگە بار کراون'),
  age: t('منذ {n} يومًا', '{n} days ago', '{n} ڕۆژ لەمەوبەر'),
  capturedBy: t('التقطها: {who}', 'Captured by: {who}', 'تۆمارکەر: {who}'),
  discard: t('تجاهل اللقطة', 'Discard the capture', 'تۆمارەکە فڕێ بدە'),
  discardConfirmTitle: t('تجاهل هذه اللقطة؟', 'Discard this capture?', 'ئەم تۆمارە فڕێ بدەیت؟'),
  discardConfirmBody: t(
    'تُحذف أسعار هذه اللقطة. تبقى المطابقات المؤكدة وتعود أسعارها مع اللقطة التالية.',
    'This capture’s prices are deleted. Confirmed matches stay and get their prices back with the next capture.',
    'نرخەکانی ئەم تۆمارە دەسڕدرێنەوە. هاوتا پشتڕاستکراوەکان دەمێننەوە و لەگەڵ تۆماری داهاتوو نرخەکانیان دەگەڕێتەوە.'
  ),
  discarded: t('تُجوهلت اللقطة.', 'The capture is discarded.', 'تۆمارەکە فڕێ درا.'),
  matchTitle: t('المطابقة', 'Matching', 'گونجاندن'),
  matchIntro: t(
    'تطابق المنتجات مع اللقطات الحالية، 25 منتجًا في كل خطوة، بلا أي ذكاء اصطناعي. الدقيقة والعالية تُؤكَّد تلقائيًا، والباقي ينتظر مراجعتك. المطابقة لا تنشر أي سعر.',
    'Matches the products against the current captures, 25 products a step, with no AI. Exact and high matches are confirmed automatically; the rest wait for your review. Matching publishes no price.',
    'بەرهەمەکان لەگەڵ تۆمارە ئێستاییەکاندا دەگونجێنێت، 25 بەرهەم لە هەر هەنگاوێکدا، بەبێ هیچ زیرەکیی دەستکرد. هاوتا تەواو و بەرزەکان بە خۆکاری پشتڕاست دەکرێنەوە؛ ئەوانی تر چاوەڕێی پێداچوونەوەی تۆن. گونجاندن هیچ نرخێک بڵاو ناکاتەوە.'
  ),
  match: t('طابِق', 'Match', 'بیگونجێنە'),
  matching: t('تجري المطابقة… {n} منتجًا حتى الآن', 'Matching… {n} products so far', 'گونجاندن دەکرێت… تا ئێستا {n} بەرهەم'),
  matchDone: t(
    'انتهت المطابقة: {products} منتجًا، {confirmed} مؤكدة تلقائيًا، {suggested} مقترحة، {missing} اختفت من اللقطة.',
    'Matching finished: {products} products, {confirmed} auto-confirmed, {suggested} suggested, {missing} gone from the capture.',
    'گونجاندن تەواو بوو: {products} بەرهەم، {confirmed} بە خۆکاری پشتڕاستکراو، {suggested} پێشنیارکراو، {missing} لە تۆمارەکەدا نەماون.'
  ),
} as const;

export const SNAPSHOT_STATE_LABELS: Readonly<Record<'loading' | 'complete' | 'superseded' | 'discarded', Tri>> = {
  loading: t('تُرفع', 'Uploading', 'بار دەکرێت'),
  complete: t('الحالية', 'Current', 'ئێستایی'),
  superseded: t('سابقة', 'Previous', 'پێشوو'),
  discarded: t('متجاهلة', 'Discarded', 'فڕێدراو'),
};

export const PRICE_BASIS_LABELS: Readonly<Record<'list' | 'net_of_vat', Tri>> = {
  list: t('كما في القائمة', 'As listed', 'وەک لە لیستەکەدا'),
  net_of_vat: t('دون الضريبة', 'Net of VAT', 'بێ باج'),
};

export const CAPTURE_LABELS: Readonly<Record<'browser_sweep' | 'store_script' | 'open_api', Tri>> = {
  browser_sweep: t('من المتصفح', 'Browser sweep', 'لە وێبگەڕەوە'),
  store_script: t('سكربت المتجر', 'Store script', 'سکریپتی فرۆشگا'),
  open_api: t('واجهة برمجية', 'Open API', 'ڕووکاری بەرنامەسازی'),
};

// ---------------------------------------------------------------- «الأنواع والمفاتيح» (§4.1, §7)

export const CONTROL = {
  title: t('المفتاحان', 'The two switches', 'دوو کلیلەکە'),
  apply: t('تطبيق الأسعار التقديرية', 'Applying estimated prices', 'جێبەجێکردنی نرخە خەمڵێنراوەکان'),
  applyDesc: t(
    'عند التشغيل تنشر الأسعار التقديرية من «جاهز للتطبيق»، منتجًا منتجًا بعد معاينته.',
    'When on, you publish estimated prices from “Ready”, product by product after its preview.',
    'کاتێک هەڵکراوە، نرخە خەمڵێنراوەکان لە «ئامادە بۆ جێبەجێکردن»ەوە بڵاو دەکەیتەوە، بەرهەم بە بەرهەم دوای پێشبینینەکەی.'
  ),
  policyMissing: t(
    'يبقى مطفأً حتى تُنشر سياسة الشراء التي تتضمن بند السعر التقديري.',
    'It stays off until the purchase policy with the estimated-price clause is published.',
    'کوژاوە دەمێنێتەوە تا ئەو سیاسەتی کڕینەی بەندی نرخی خەمڵێنراوی تێدایە بڵاو دەکرێتەوە.'
  ),
  ordering: t('الطلب بالسعر التقديري', 'Ordering at the estimated price', 'داواکردن بە نرخی خەمڵێنراو'),
  orderingDesc: t(
    'إيقافه يمنع الزبائن مؤقتًا من طلب المنتجات التقديرية (فرامل الطوارئ). الطلبات القائمة لا تتغير.',
    'Switching it off stops customers from ordering estimated products for now (the emergency brake). Placed orders do not change.',
    'کوژاندنەوەی بۆ ماوەیەک ڕێگە لە کڕیاران دەگرێت بەرهەمی خەمڵێنراو داوا بکەن (وەستێنەری فریاکەوتن). داواکارییە تۆمارکراوەکان ناگۆڕێن.'
  ),
} as const;

export const TYPES = {
  title: t('الأنواع', 'Types', 'جۆرەکان'),
  intro: t(
    'لكل نوع: المسار، الوزن والصندوق الافتراضيان (لمنتج بلا قياس)، التكلفة الإضافية والحد الأدنى للربح بالدولار. كل رقم فارغ حتى تكتبه، ولا يُقدَّر منتج نوعه ناقص.',
    'For each type: the route, the default weight and box (for a product with no measure), the extra cost and the minimum profit in dollars. Every figure is empty until you type it, and no product of an incomplete type is estimated.',
    'بۆ هەر جۆرێک: ڕێگا، کێش و سندوقی بنەڕەتی (بۆ بەرهەمێکی بێ پێوانە)، تێچووی زیادە و کەمترین قازانج بە دۆلار. هەموو ژمارەیەک بەتاڵە تا خۆت دەینووسیت، و هیچ بەرهەمێکی جۆرێکی ناتەواو خەمڵێنرێت نابێت.'
  ),
  sourcing: t('مصدر الشراء', 'Sourcing', 'سەرچاوەی کڕین'),
  route: t('المسار', 'Route', 'ڕێگا'),
  allowAir: t('يُسمح بالشحن الجوي', 'Air allowed', 'ڕێگای ئاسمانی ڕێگەپێدراوە'),
  usReference: t('يقبل سعر المتجر الأمريكي مرجعًا', 'Accepts the US store price as a reference', 'نرخی فرۆشگای ئەمریکا وەک سەرچاوەی بەراورد وەردەگرێت'),
  defaultWeight: t('الوزن الافتراضي (غرام)', 'Default weight (g)', 'کێشی بنەڕەتی (گرام)'),
  grams: t('{n} غرام', '{n} g', '{n} گرام'),
  defaultBox: t('الصندوق الافتراضي (مم)', 'Default box (mm)', 'سندوقی بنەڕەتی (ملم)'),
  length: t('الطول', 'Length', 'درێژی'),
  width: t('العرض', 'Width', 'پانی'),
  height: t('الارتفاع', 'Height', 'بەرزی'),
  defaultCbm: t('الحجم الافتراضي (م³) — بدل الصندوق', 'Default volume (m³) — instead of a box', 'قەبارەی بنەڕەتی (م³) — لە جیاتی سندوق'),
  additional: t('تكلفة إضافية (د.ع)', 'Extra cost (IQD)', 'تێچووی زیادە (دینار)'),
  minProfit: t('الحد الأدنى للربح (دولار)', 'Minimum profit (USD)', 'کەمترین قازانج (دۆلار)'),
  staleDays: t('تتقادم اللقطة بعد (أيام)', 'A capture goes stale after (days)', 'تۆمار دوای (ڕۆژ) کۆن دەبێت'),
  empty: t('فارغ', 'Empty', 'بەتاڵ'),
  incomplete: t('ناقص: لا يُقدَّر منتج من هذا النوع بعد.', 'Incomplete: no product of this type is estimated yet.', 'ناتەواوە: هێشتا هیچ بەرهەمێکی ئەم جۆرە ناخەمڵێنرێت.'),
  save: t('احفظ النوع', 'Save the type', 'جۆرەکە پاشەکەوت بکە'),
  edit: t('عدّل', 'Edit', 'دەستکاری بکە'),
  suggest: t('اقترح من الكتالوج', 'Suggest from the catalogue', 'لە کاتالۆگەوە پێشنیار بکە'),
  suggestion: t(
    'الوسيط من {n} منتجًا بقياس حقيقي: {weight} · {box} · {cbm}',
    'The median of {n} products with a real measure: {weight} · {box} · {cbm}',
    'ناوەندی {n} بەرهەم کە پێوانەی ڕاستەقینەیان هەیە: {weight} · {box} · {cbm}'
  ),
  useSuggestion: t('استعمل الاقتراح', 'Use the suggestion', 'پێشنیارەکە بەکاربهێنە'),
  noSuggestion: t('لا قياسات حقيقية لمنتجات هذا النوع بعد.', 'No product of this type has a real measure yet.', 'هێشتا هیچ بەرهەمێکی ئەم جۆرە پێوانەی ڕاستەقینەی نییە.'),
  suggestionNote: t('اقتراح فقط: لا يُحفظ حتى تحفظ النوع.', 'A suggestion only: nothing is saved until you save the type.', 'تەنها پێشنیارە: هیچ شتێک پاشەکەوت ناکرێت تا جۆرەکە پاشەکەوت دەکەیت.'),
  wholeInvalid: t('رقم صحيح فقط.', 'A whole number only.', 'تەنها ژمارەی تەواو.'),
  decimalInvalid: t('رقم موجب، والفاصلة العشرية نقطة.', 'A positive number, with a point for decimals.', 'ژمارەیەکی پۆزەتیڤ، و بۆ کەرت خاڵ.'),
  boxAll: t('اكتب الأبعاد الثلاثة أو اتركها كلها فارغة.', 'Fill all three dimensions or leave all three empty.', 'هەر سێ ڕەهەندەکە بنووسە یان هەر سێکیان بەتاڵ بهێڵەرەوە.'),
  newTitle: t('نوع جديد', 'A new type', 'جۆرێکی نوێ'),
  newKey: t('المفتاح (حروف لاتينية صغيرة و_)', 'Key (lower-case letters and _)', 'کلیل (پیتی بچووکی لاتینی و _)'),
  nameAr: t('الاسم بالعربية', 'Name in Arabic', 'ناو بە عەرەبی'),
  nameEn: t('الاسم بالإنجليزية', 'Name in English', 'ناو بە ئینگلیزی'),
  nameCkb: t('الاسم بالكردية السورانية', 'Name in Sorani Kurdish', 'ناو بە کوردیی سۆرانی'),
  nameCkbSame: t('اكتب الاسم الكردي بالسورانية، لا نسخة من العربي.', 'Write the Kurdish name in Sorani, not a copy of the Arabic.', 'ناوی کوردی بە سۆرانی بنووسە، نەک کۆپییەکی عەرەبییەکە.'),
  keyInvalid: t('المفتاح من حرفين إلى 40 حرفًا لاتينيًا صغيرًا أو _.', 'The key is 2 to 40 lower-case letters or _.', 'کلیلەکە لە 2 تا 40 پیتی بچووکی لاتینی یان _ پێکدێت.'),
  nameInvalid: t('اكتب الاسم بالأسماء الثلاثة (حتى 80 حرفًا).', 'Write all three names (up to 80 characters).', 'هەر سێ ناوەکە بنووسە (تا 80 پیت).'),
  create: t('أنشئ النوع', 'Create the type', 'جۆرەکە دروست بکە'),
  created: t('أُنشئ النوع؛ اكتب أرقامه الآن.', 'The type is created; type its figures now.', 'جۆرەکە دروست کرا؛ ئێستا ژمارەکانی بنووسە.'),
} as const;

export const TYPE_WARNINGS: Readonly<Record<string, Tri>> = {
  MIN_PROFIT_BELOW_ROUTE_FLOOR: t(
    'الحد الأدنى للربح أقل من خطوة تقريب واحدة بسعر الصرف الحالي، فيُغلق المسار. ارفعه.',
    'The minimum profit is below one rounding step at today’s rate, so the route closes. Raise it.',
    'کەمترین قازانج بە نرخی ئاڵوگۆڕی ئەمڕۆ لە یەک هەنگاوی خڕکردنەوە کەمترە، بۆیە ڕێگاکە دادەخرێت. بەرزی بکەرەوە.'
  ),
};

export const SOURCING_LABELS: Readonly<Record<'EU_STORE_EUR' | 'CHINA_CNY', Tri>> = {
  EU_STORE_EUR: t('المتجر الأوروبي، باليورو، برًّا', 'EU store, in EUR, by land', 'فرۆشگای ئەوروپا، بە یۆرۆ، بە ڕێگای وشکانی'),
  CHINA_CNY: t('الصين (Tmall)، باليوان', 'China (Tmall), in CNY', 'چین (Tmall)، بە یوان'),
};

export const ROUTE_LABELS: Readonly<Record<'land' | 'sea' | 'air', Tri>> = {
  land: t('برّي', 'Land', 'وشکانی'),
  sea: t('بحري', 'Sea', 'دەریایی'),
  air: t('جوي', 'Air', 'ئاسمانی'),
};

// ---------------------------------------------------------------- the lists (§7: Ready, Estimated, Flags, Refresh)

export const LISTS = {
  readyIntro: t(
    'منتجات بلا ملاحظة مانعة: المصدر وسعر المورّد، التكلفة R والسعر D. حدّد ثم طبّق؛ يُكتب كل منتج في دفعة واحدة مع وسمه، ويصير قابلًا للطلب المسبق.',
    'Products with no blocking flag: the source and supplier price, the cost R and the price D. Select, then apply; each product is written in one batch with its label and becomes orderable by pre-order.',
    'ئەو بەرهەمانەی هیچ تێبینییەکی ڕێگریان نییە: سەرچاوە و نرخی دابینکەر، تێچووی R و نرخی D. دیاری بکە پاشان جێبەجێی بکە؛ هەر بەرهەمێک لە یەک ناردندا لەگەڵ نیشانەکەی دەنووسرێت و بە پێشداواکاری دەکڕدرێت.'
  ),
  estimatedIntro: t(
    'كل المنتجات الموسومة «سعر تقديري». بعد التأكد من سعر المورّد، أكّد السعر ليُرفع الوسم عن المنتج كله أو عن خيارات محددة. أوقف التحديث لتثبيت التقدير كما هو.',
    'Every product labelled “Estimated price”. Once you have checked the supplier’s price, confirm it to remove the label from the whole product or from chosen options. Pause to hold the estimate as it is.',
    'هەموو ئەو بەرهەمانەی نیشانەی «نرخی خەمڵێنراو»یان هەیە. دوای دڵنیابوونەوە لە نرخی دابینکەر، پشتڕاستی بکەرەوە بۆ لابردنی نیشانەکە لە هەموو بەرهەمەکە یان لە هەڵبژاردەی دیاریکراو. بۆ هێشتنەوەی خەمڵاندنەکە وەک خۆی، ڕایبگرە.'
  ),
  flagsIntro: t(
    'منتجات موسومة لها ملاحظات مفتوحة: قياسات افتراضية، مرجع أمريكي، سعر مكتوب أو من صفحة، لقطة قديمة، عنصر اختفى، تعديلك، أو تغيّر كبير محتجز.',
    'Labelled products with open flags: default measures, a US reference, a typed or page price, a stale capture, a missing item, your edits, or a large change held.',
    'بەرهەمی نیشانەکراو کە تێبینیی کراوەیان هەیە: پێوانەی بنەڕەتی، سەرچاوەی بەراوردی ئەمریکا، نرخی نووسراو یان لە پەڕەوە، تۆماری کۆن، بڕگەی نەماو، دەستکارییەکانی تۆ، یان گۆڕانێکی گەورەی ڕاگیراو.'
  ),
  refreshIntro: t(
    'منتجات يختلف تقديرها المعاد حسابه عن المنشور: القديم ← الجديد والنسبة، أو يضع تطبيقها قياساتك الحقيقية مكان القياسات الافتراضية دون أن يتغيّر أي سعر. احسب أولًا لتظهر التغيّرات، والتغيّر الكبير يحتاج علامتك. تعديلاتك تبقى.',
    'Products whose recomputed estimate differs from the published one: old → new and the percentage — or whose apply puts your real measures in place of the default ones with no price changed. Compute first to bring the changes in; a large change needs your tick. Your edits stay.',
    'ئەو بەرهەمانەی خەمڵاندنە دووبارە هەژمارکراوەکەیان جیاوازە لە بڵاوکراوەکە: کۆن ← نوێ و ڕێژەکە، یان جێبەجێکردنیان پێوانە ڕاستەقینەکانت دەخاتە شوێنی پێوانە بنەڕەتییەکان بێ ئەوەی هیچ نرخێک بگۆڕێت. سەرەتا هەژمار بکە بۆ دەرکەوتنی گۆڕانکارییەکان؛ گۆڕانی گەورە پێویستی بە نیشانەی تۆیە. دەستکارییەکانت دەمێننەوە.'
  ),
  /** A refresh row whose every line keeps its published price: listed because its apply takes the real measures in (§4.9). */
  refreshMeasuresOnly: t(
    'لا يتغيّر أي سعر: تطبيق هذا التحديث يضع قياساتك الحقيقية مكان القياسات الافتراضية.',
    'No price changes: applying this refresh puts your real measures in place of the default ones.',
    'هیچ نرخێک ناگۆڕێت: جێبەجێکردنی ئەم نوێکردنەوەیە پێوانە ڕاستەقینەکانت دەخاتە شوێنی پێوانە بنەڕەتییەکان.'
  ),
  computeAll: t('احسب الكل', 'Compute everything', 'هەمووی هەژمار بکە'),
  computing: t('يُحسب… {n} منتجًا حتى الآن', 'Computing… {n} products so far', 'هەژمار دەکرێت… تا ئێستا {n} بەرهەم'),
  computeDone: t('انتهى الحساب: {n} منتجًا، {ready} جاهزًا.', 'Computing finished: {n} products, {ready} ready.', 'هەژمارکردن تەواو بوو: {n} بەرهەم، {ready} ئامادە.'),
  applySelected: t('طبّق المحدد ({n})', 'Apply the selected ({n})', 'دیاریکراوەکان جێبەجێ بکە ({n})'),
  applying: t('يُطبَّق… {done} من {total}', 'Applying… {done} of {total}', 'جێبەجێ دەکرێت… {done} لە {total}'),
  applyDone: t('طُبّق {applied} من {total}.', '{applied} of {total} applied.', '{applied} لە {total} جێبەجێ کران.'),
  source: t('المصدر', 'Source', 'سەرچاوە'),
  supplier: t('سعر المورّد', 'Supplier price', 'نرخی دابینکەر'),
  cost: t('التكلفة R', 'Cost R', 'تێچووی R'),
  price: t('السعر D', 'Price D', 'نرخی D'),
  published: t('المنشور الآن', 'Published now', 'ئێستا بڵاوکراوە'),
  change: t('التغيّر', 'Change', 'گۆڕان'),
  measure: t('القياس', 'Measure', 'پێوانە'),
  large: t('تغيّر كبير في السعر: يحتاج تأكيدك صراحةً.', 'A large price change: it needs your explicit confirmation.', 'گۆڕانێکی گەورە لە نرخدا: پێویستی بە پشتڕاستکردنەوەی ڕوونی تۆیە.'),
  confirmLarge: t('أؤكد هذا التغيّر الكبير', 'I confirm this large change', 'ئەم گۆڕانە گەورەیە پشتڕاست دەکەمەوە'),
  noFlags: t('بلا ملاحظات', 'No flags', 'بێ تێبینی'),
  computedAt: t('حُسب {date}', 'Computed {date}', 'هەژمار کراوە لە {date}'),
  type: t('النوع: {type}', 'Type: {type}', 'جۆر: {type}'),
  labelOn: t('يرى الزبون «سعر تقديري»', 'Customers see “Estimated price”', 'کڕیار «نرخی خەمڵێنراو» دەبینێت'),
  confirm: t('تأكيد السعر', 'Confirm the price', 'پشتڕاستکردنەوەی نرخ'),
  pause: t('أوقف التحديث', 'Pause', 'ڕایبگرە'),
  resume: t('استأنف', 'Resume', 'دەستپێبکەرەوە'),
  paused: t('أُوقف التحديث؛ يبقى الوسم.', 'Paused; the label stays.', 'ڕاگیرا؛ نیشانەکە دەمێنێتەوە.'),
  resumed: t('استُؤنف.', 'Resumed.', 'دەستی پێکردەوە.'),
  viewLabel: t('أيّها', 'Which', 'کامەیان'),
  views: {
    estimated: t('موسومة', 'Labelled', 'نیشانەکراو'),
    paused: t('موقوفة', 'Paused', 'ڕاگیراو'),
    confirmed: t('مؤكدة', 'Confirmed', 'پشتڕاستکراوە'),
  },
  review: t('راجعه', 'Review it', 'پێیدا بچۆرەوە'),
  lines: t('الخيارات', 'Options', 'هەڵبژاردەکان'),
} as const;

export const ESTIMATE_STATE_LABELS: Readonly<Record<'candidate' | 'estimated' | 'confirmed' | 'paused', Tri>> = {
  candidate: t('مرشح', 'Candidate', 'پاڵێوراو'),
  estimated: t('تقديري', 'Estimated', 'خەمڵێنراو'),
  confirmed: t('مؤكد', 'Confirmed', 'پشتڕاستکراوە'),
  paused: t('موقوف', 'Paused', 'ڕاگیراو'),
};

export const MEASURE_LABELS: Readonly<Record<'model' | 'colour' | 'product' | 'type_default' | 'owner' | 'none', Tri>> = {
  model: t('من الموديل', 'From the model', 'لە مۆدێلەکەوە'),
  colour: t('من اللون', 'From the colour', 'لە ڕەنگەکەوە'),
  product: t('من المنتج', 'From the product', 'لە بەرهەمەکەوە'),
  type_default: t('افتراضي النوع', 'Type default', 'بنەڕەتی جۆرەکە'),
  owner: t('منك', 'Yours', 'هی خۆت'),
  none: t('بلا قياس', 'No measure', 'بێ پێوانە'),
};

export const OUTCOMES = {
  applied: t('طُبّق', 'Applied', 'جێبەجێ کرا'),
  already: t('طُبّق من قبل', 'Already applied', 'پێشتر جێبەجێ کرابوو'),
  refused: t('لم يُطبَّق: {reason}', 'Not applied: {reason}', 'جێبەجێ نەکرا: {reason}'),
  deferred: t('أُجّل إلى الدفعة التالية', 'Moved to the next batch', 'بۆ ناردنی داهاتوو دواخرا'),
  stale: t(
    'تغيّر الحساب منذ المعاينة؛ هذه المعاينة الجديدة — راجعها ثم طبّق.',
    'The computation changed since the preview; this is the fresh preview — review it, then apply.',
    'هەژمارەکە لە دوای پێشبینینەکەوە گۆڕاوە؛ ئەمە پێشبینینە نوێیەکەیە — پێیدا بچۆرەوە، پاشان جێبەجێی بکە.'
  ),
  needsTick: t('تغيّر كبير: حدّد «أؤكد هذا التغيّر الكبير» ثم طبّق.', 'A large change: tick “I confirm this large change”, then apply.', 'گۆڕانێکی گەورە: «ئەم گۆڕانە گەورەیە پشتڕاست دەکەمەوە» دیاری بکە، پاشان جێبەجێی بکە.'),
  notEligible: t('لم يعد مؤهلًا: {flags}', 'No longer eligible: {flags}', 'ئیتر شیاو نییە: {flags}'),
} as const;

// ---------------------------------------------------------------- «تأكيد السعر» (§4.9)

export const CONFIRM = {
  title: t('تأكيد السعر — {name}', 'Confirm the price — {name}', 'پشتڕاستکردنەوەی نرخ — {name}'),
  intro: t(
    'التأكيد يرفع وسم «سعر تقديري» عن المنتج كله أو عن الخيارات التي تحددها. لا يُرفع ما دام خيار محسوبًا من وزن أو صندوق افتراضي.',
    'Confirming removes the “Estimated price” label from the whole product or from the options you choose. It is never removed while an option is priced from a default weight or box.',
    'پشتڕاستکردنەوە نیشانەی «نرخی خەمڵێنراو» لە هەموو بەرهەمەکە یان لەو هەڵبژاردانەی دیاری دەکەیت لادەبات. تا هەڵبژاردەیەک لە کێش یان سندوقی بنەڕەتییەوە نرخی بۆ دانرابێت، لانابرێت.'
  ),
  whole: t('المنتج كله', 'The whole product', 'هەموو بەرهەمەکە'),
  some: t('خيارات محددة', 'Chosen options', 'هەڵبژاردەی دیاریکراو'),
  scopeLabel: t('ماذا تؤكد', 'What you confirm', 'چی پشتڕاست دەکەیتەوە'),
  pickSkus: t('اختر خيارًا واحدًا على الأقل.', 'Choose at least one option.', 'لانیکەم یەک هەڵبژاردە هەڵبژێرە.'),
  acceptTitle: t('ملاحظات تحتاج قبولك صراحةً', 'Flags that need your explicit acceptance', 'ئەو تێبینییانەی پێویستیان بە پەسەندکردنی ڕوونی تۆیە'),
  accept: t('أقبل: {flag}', 'I accept: {flag}', 'پەسەندی دەکەم: {flag}'),
  acceptAllFirst: t('اقبل كل ملاحظة مفتوحة أولًا.', 'Accept every open flag first.', 'سەرەتا هەموو تێبینییەکی کراوە پەسەند بکە.'),
  /** The statement on offer (§4.9 step 0): the type's defaults price the options confirmed, shown below with the tick. */
  hardOpen: t(
    'قياسات افتراضية: السعر محسوب من قياسات النوع الافتراضية أدناه. أكّد أنها صحيحة لهذا المنتج، أو أدخل الحقيقية.',
    'Default measures: the price is computed from the type’s default measures below. Confirm they are correct for this product, or enter the real ones.',
    'پێوانەی بنەڕەتی: نرخەکە لە پێوانە بنەڕەتییەکانی جۆرەکەوە هەژمار کراوە (لە خوارەوە). پشتڕاستی بکەرەوە کە بۆ ئەم بەرهەمە دروستن، یان ڕاستەقینەکان بنووسە.'
  ),
  /** PRICE_ESTIMATE_DEFAULT_MEASURES with `waiting_on_apply`: the real measures are entered, the refresh's apply takes them in. */
  applyFirst: t(
    'قياساتك الحقيقية تنتظر تطبيق التحديث: طبّقه من «التحديث» أولًا، ثم أكّد السعر.',
    'Your real measures are waiting for the refresh to be applied: apply it in “Refresh” first, then confirm the price.',
    'پێوانە ڕاستەقینەکانت چاوەڕێی جێبەجێکردنی نوێکردنەوەکەن: سەرەتا لە «نوێکردنەوە» جێبەجێی بکە، پاشان نرخەکە پشتڕاست بکەرەوە.'
  ),
  submit: t('أكّد السعر', 'Confirm the price', 'نرخەکە پشتڕاست بکەرەوە'),
  doneWhole: t('رُفع الوسم عن المنتج.', 'The label is removed from the product.', 'نیشانەکە لە بەرهەمەکە لابرا.'),
  doneSkus: t('ثُبّت سعر {n} من الخيارات؛ يبقى الوسم للباقي.', '{n} options are now firm; the label stays for the others.', 'نرخی {n} هەڵبژاردە جێگیر کرا؛ نیشانەکە بۆ ئەوانی تر دەمێنێتەوە.'),
  // The owner's statement of real measures (§4.9 step 0; DECISIONS row 292).
  measuresTitle: t('القياسات التي يُحسب منها السعر الآن', 'The measures the price is computed from now', 'ئەو پێوانانەی ئێستا نرخەکەیان پێ هەژمار دەکرێت'),
  weight: t('الوزن', 'Weight', 'کێش'),
  box: t('الصندوق', 'Box', 'سندوقەکە'),
  kg: t('كغ', 'kg', 'کیلۆ'),
  cm: t('سم', 'cm', 'سانتیمەتر'),
  fromType: t(
    'هذه قياسات النوع الافتراضية، لا قياسات هذا المنتج.',
    'These are the type’s default measures, not this product’s own.',
    'ئەمانە پێوانە بنەڕەتییەکانی جۆرەکەن، نەک پێوانەکانی ئەم بەرهەمە خۆی.'
  ),
  attest: t('هذه القياسات صحيحة لهذا المنتج', 'These measures are correct for this product', 'ئەم پێوانانە بۆ ئەم بەرهەمە دروستن'),
  attestHint: t(
    'تُحفظ في «الأبعاد والوزن» قياساتٍ حقيقيةً للمنتج، ويراها الزبون تحت «العبوة». لا يتغيّر أي سعر.',
    'They are saved in “Dimensions & weight” as the product’s real measures, and customers see them under “Package”. No price changes.',
    'وەک پێوانە ڕاستەقینەکانی بەرهەمەکە لە «قەبارە و کێش» پاشەکەوت دەکرێن و کڕیار لە ژێر «پاکەت» دەیانبینێت. هیچ نرخێک ناگۆڕێت.'
  ),
  attestFirst: t(
    'حدّد «هذه القياسات صحيحة لهذا المنتج» أولًا، أو أدخل القياسات الحقيقية.',
    'Tick “These measures are correct for this product” first, or enter the real measures.',
    'سەرەتا «ئەم پێوانانە بۆ ئەم بەرهەمە دروستن» دیاری بکە، یان پێوانە ڕاستەقینەکان بنووسە.'
  ),
  notThese: t('ليست صحيحة؟ أدخل الحقيقية', 'Not correct? Enter the real ones', 'دروست نین؟ ڕاستەقینەکان بنووسە'),
  enterInCost: t(
    'اكتب الوزن والصندوق الحقيقيين في «التكلفة — للمالك فقط» واحفظ، ثم أكّد السعر.',
    'Type the real weight and box in “Cost — owner only” and save, then confirm the price.',
    'کێش و سندوقی ڕاستەقینە لە «تێچوو — تەنها بۆ خاوەن» بنووسە و پاشەکەوتی بکە، پاشان نرخەکە پشتڕاست بکەرەوە.'
  ),
  typeCbm: t(
    'يُسعَّر هذا المنتج بالحجم الافتراضي لنوعه، لا بصندوق: اكتب الصندوق الحقيقي في «الأبعاد والوزن»، ثم احسب من جديد وطبّق التحديث.',
    'This product is priced from its type’s default volume, not from a box: enter the real box in “Dimensions & weight”, then compute again and apply the refresh.',
    'ئەم بەرهەمە بە قەبارەی بنەڕەتی جۆرەکەی نرخی بۆ دانراوە، نەک بە سندوق: سندوقی ڕاستەقینە لە «قەبارە و کێش» بنووسە، پاشان دووبارە هەژمار بکەرەوە و نوێکردنەوەکە جێبەجێ بکە.'
  ),
  packageDiffers: t(
    'في «الأبعاد والوزن» قياسات غير التي يُحسب منها السعر: احسب من جديد وطبّق التحديث ليأخذها السعر، ثم أكّد.',
    '“Dimensions & weight” holds other measures than the ones the price is computed from: compute again and apply the refresh so the price takes them, then confirm.',
    'لە «قەبارە و کێش» پێوانەی جیاواز هەن لەوانەی نرخەکەیان پێ هەژمار دەکرێت: دووبارە هەژمار بکەرەوە و نوێکردنەوەکە جێبەجێ بکە تا نرخەکە وەریانبگرێت، پاشان پشتڕاستی بکەرەوە.'
  ),
  packagePartial: t(
    'صندوق «الأبعاد والوزن» ناقص: أكمل أبعاده الثلاثة أو امسحها واحفظ المنتج، ثم ارجع هنا.',
    'The box in “Dimensions & weight” is incomplete: fill in all three sides or clear them and save the product, then come back here.',
    'سندوقەکەی «قەبارە و کێش» ناتەواوە: هەر سێ لاکەی پڕ بکەرەوە یان بیانسڕەوە و بەرهەمەکە پاشەکەوت بکە، پاشان بگەڕێوە ئێرە.'
  ),
  /** The type's default weight is lighter than the product's own net weight: it cannot be stated real (§4.9 step 0). */
  belowNet: t(
    'وزن المنتج الصافي في «الأبعاد والوزن» أثقل من وزن النوع الافتراضي، فلا يصح هذا الوزن لهذا المنتج: اكتب الوزن الحقيقي مع التغليف في «التكلفة — للمالك فقط» واحفظ، أو صحّح الوزن الصافي.',
    'The product’s net weight in “Dimensions & weight” is heavier than the type’s default weight, so that weight cannot be this product’s: type the real packed weight in “Cost — owner only” and save, or correct the net weight.',
    'کێشی پوختی بەرهەمەکە لە «قەبارە و کێش» لە کێشی بنەڕەتیی جۆرەکە قورسترە، بۆیە ئەو کێشە بۆ ئەم بەرهەمە دروست نییە: کێشی ڕاستەقینە لەگەڵ پاکەت لە «تێچوو — تەنها بۆ خاوەن» بنووسە و پاشەکەوتی بکە، یان کێشی پوخت ڕاست بکەرەوە.'
  ),
  /** An older server, or a live read that failed: the hold is read from the latest lines, and the server judges the press. */
  hardLines: t(
    'حسب آخر حساب، السعر محسوب من وزن أو صندوق افتراضي. «أكّد السعر» يتحقق من القياسات الآن؛ وإن رُفض فأدخل الحقيقية في «التكلفة» أو «الأبعاد والوزن».',
    'By the latest compute, the price is computed from a default weight or box. “Confirm the price” checks the measures now; if it is refused, enter the real ones in “Cost” or “Dimensions & weight”.',
    'بەپێی کۆتا هەژمارکردن، نرخەکە لە کێش یان سندوقێکی بنەڕەتییەوە هەژمار کراوە. «نرخەکە پشتڕاست بکەرەوە» ئێستا پێوانەکان دەپشکنێت؛ ئەگەر ڕەت کرایەوە، ڕاستەقینەکان لە «تێچوو» یان «قەبارە و کێش» بنووسە.'
  ),
  skuDefault: t('قياسات افتراضية', 'Default measures', 'پێوانەی بنەڕەتی'),
  openDimensions: t('افتح «الأبعاد والوزن»', 'Open “Dimensions & weight”', '«قەبارە و کێش» بکەرەوە'),
  openCost: t('افتح «التكلفة»', 'Open “Cost”', '«تێچوو» بکەرەوە'),
  openRefresh: t('افتح «التحديث»', 'Open “Refresh”', '«نوێکردنەوە» بکەرەوە'),
  doneAttested: t(
    'حُفظت القياسات قياساتٍ حقيقية ورُفع الوسم عن المنتج.',
    'The measures are saved as real ones and the label is removed from the product.',
    'پێوانەکان وەک پێوانەی ڕاستەقینە پاشەکەوت کران و نیشانەکە لە بەرهەمەکە لابرا.'
  ),
  doneAttestedSkus: t(
    'حُفظت القياسات حقيقيةً وثُبّت سعر {n} من الخيارات؛ يبقى الوسم للباقي.',
    'The measures are saved as real ones and {n} options are now firm; the label stays for the others.',
    'پێوانەکان وەک ڕاستەقینە پاشەکەوت کران و نرخی {n} هەڵبژاردە جێگیر کرا؛ نیشانەکە بۆ ئەوانی تر دەمێنێتەوە.'
  ),
} as const;

// ---------------------------------------------------------------- the product form's banner (§7)

export const BANNER = {
  /** The storefront's own label (the contract's words, never a second spelling). */
  label: ESTIMATE_STRINGS.label as Tri,
  defaultWeight: t('وزن افتراضي', 'Default weight', 'کێشی بنەڕەتی'),
  defaultBox: t('صندوق افتراضي', 'Default box', 'سندوقی بنەڕەتی'),
  review: t('مراجعة', 'Review', 'پێداچوونەوە'),
  confirm: t('تأكيد', 'Confirm', 'پشتڕاستکردنەوە'),
  links: t('روابط المورّد ({n})', 'Supplier links ({n})', 'بەستەرەکانی دابینکەر ({n})'),
  allLinks: t('كل روابط المنتج', 'Every link of the product', 'هەموو بەستەرەکانی بەرهەمەکە'),
  none: t('لا رابط عند المورّد بعد.', 'No supplier link yet.', 'هێشتا هیچ بەستەرێکی دابینکەر نییە.'),
  find: t('ابحث عند المورّد', 'Find it at the supplier', 'لای دابینکەر بیدۆزەرەوە'),
  staffLabel: t(
    'يرى الزبون «سعر تقديري» على هذا المنتج حتى يؤكد المالك السعر مع المورّد.',
    'Customers see “Estimated price” on this product until the owner confirms the price with the supplier.',
    'کڕیار «نرخی خەمڵێنراو» لەسەر ئەم بەرهەمە دەبینێت تا خاوەن نرخەکە لەگەڵ دابینکەر پشتڕاست دەکاتەوە.'
  ),
  staffState: t('التسعير التقديري: {state} — يديره المالك.', 'Estimated pricing: {state} — managed by the owner.', 'نرخدانانی خەمڵێنراو: {state} — خاوەن بەڕێوەی دەبات.'),
  title: t('التسعير التقديري لهذا المنتج', 'This product’s estimated pricing', 'نرخدانانی خەمڵێنراوی ئەم بەرهەمە'),
} as const;

// ---------------------------------------------------------------- flags (§4.6) and match reasons (§3.5)

export const FLAG_LABELS: Readonly<Record<EstimateFlag, Tri>> = {
  EST_TYPE_MISSING: t('لم يُحدَّد نوع المنتج', 'No product type could be decided', 'جۆری بەرهەمەکە دیاری نەکرا'),
  EST_TYPE_INCOMPLETE: t(
    'النوع ناقص: الحد الأدنى للربح أو قياس افتراضي لازم غير مكتوب',
    'The type is incomplete: no minimum profit, or a needed default measure is missing',
    'جۆرەکە ناتەواوە: کەمترین قازانج یان پێوانەیەکی بنەڕەتیی پێویست نەنووسراوە'
  ),
  EST_NO_PRICE: t('خيار بلا سعر من المورّد', 'An option has no supplier price', 'هەڵبژاردەیەک نرخی دابینکەری نییە'),
  EST_MATCH_REVIEW: t('خيار مسعَّر من مطابقة مقترحة فقط — راجعها', 'An option is priced only by a suggested match — review it', 'هەڵبژاردەیەک تەنها لە هاوتایەکی پێشنیارکراوەوە نرخی هەیە — پێیدا بچۆرەوە'),
  EST_PACK_MISMATCH: t('عرض بعدة قطع لا يطابق قطعة واحدة', 'A multi-unit offer does not match a single unit', 'ئۆفەرێکی چەند یەکەیی لەگەڵ یەک یەکە ناگونجێت'),
  EST_TYPE_MISMATCH: t('مصدر المرشح يخالف النوع الذي اخترته', 'The candidate’s source contradicts the type you chose', 'سەرچاوەی پاڵێوراوەکە پێچەوانەی ئەو جۆرەیە کە هەڵتبژاردووە'),
  EST_STRUCTURE_OWNER: t(
    'بنية المنتج لك: لا يُحضَّر تلقائيًا للطلب المسبق على مسار واحد',
    'The product’s structure is yours: it is not prepared automatically for pre-order on one route',
    'پێکهاتەی بەرهەمەکە هی تۆیە: بە خۆکاری بۆ پێشداواکاری لەسەر یەک ڕێگا ئامادە ناکرێت'
  ),
  EST_FIRM_PRICE: t('له سعر منشور غير تقديري — لا يُمَس', 'It has a published, non-estimate price — never touched', 'نرخێکی بڵاوکراوەی نەخەمڵێنراوی هەیە — دەستی لێ نادرێت'),
  EST_METHOD_OWNER: t('يُسعَّر بالدولار يدويًا — لا يُمَس', 'Priced in dollars by hand — never touched', 'بە دەستی بە دۆلار نرخی بۆ دانراوە — دەستی لێ نادرێت'),
  EST_PURCHASE_REVIEW_PENDING: t('تكلفة شراء تنتظر مراجعتك', 'A purchase cost awaits your review', 'تێچووی کڕینێک چاوەڕێی پێداچوونەوەی تۆیە'),
  EST_TOO_MANY_SCOPES: t('مدخلات تسعير هذا المنتج أكثر من الحد', 'This product’s pricing entries exceed the limit', 'تۆمارەکانی نرخدانانی ئەم بەرهەمە لە سنوور زیاترن'),
  EST_IMPORT_RUNNING: t('استيراد الكتالوج يعمل الآن — أعد المحاولة بعده', 'A catalogue import is running — try again after it', 'هاوردەکردنی کاتالۆگ ئێستا کار دەکات — دوای ئەوە دووبارە هەوڵ بدەرەوە'),
  EST_DEFAULT_WEIGHT: t('مسعَّر بوزن افتراضي', 'Priced from a default weight', 'بە کێشی بنەڕەتی نرخی بۆ دانراوە'),
  EST_DEFAULT_BOX: t('مسعَّر بصندوق افتراضي', 'Priced from a default box', 'بە سندوقی بنەڕەتی نرخی بۆ دانراوە'),
  EST_US_REFERENCE: t('من سعر المتجر الأمريكي بالدولار (مرجع)', 'From the US store’s dollar price (a reference)', 'لە نرخی دۆلاری فرۆشگای ئەمریکاوە (سەرچاوەی بەراورد)'),
  EST_MANUAL_PRICE: t('سعر كتبته بنفسك', 'A price you typed', 'نرخێک کە خۆت نووسیوتە'),
  EST_STORE_PAGE_PRICE: t('سعر من قراءة صفحة متجر', 'A price from one store page read', 'نرخێک لە خوێندنەوەی پەڕەیەکی فرۆشگاوە'),
  EST_UNITS_DIVIDED: t('سعر عرض مقسوم على عدد قطعه', 'An offer price divided by its units', 'نرخی ئۆفەرێک دابەشکراو بەسەر یەکەکانیدا'),
  EST_SNAPSHOT_STALE: t('اللقطة أقدم مما يسمح به النوع', 'The capture is older than the type allows', 'تۆمارەکە لەوەی جۆرەکە ڕێگە دەدات کۆنترە'),
  EST_SOURCE_ITEM_MISSING: t('العنصر المطابق اختفى من آخر لقطة', 'The matched item is gone from the latest capture', 'بڕگە هاوتاکراوەکە لە کۆتا تۆماردا نەماوە'),
  EST_SUPPLIER_OUT_OF_STOCK: t('نفد عند المورّد', 'Out of stock at the supplier', 'لای دابینکەر نەماوە'),
  EST_OWNER_EDITED: t('عدّلتَ حقولًا كتبها التقدير — تبقى تعديلاتك', 'You edited fields the estimate wrote — your edits stay', 'ئەو خانانەت گۆڕی کە خەمڵاندنەکە نووسیبوونی — دەستکارییەکانت دەمێننەوە'),
  EST_LARGE_CHANGE_HELD: t('تغيّر كبير محتجز في إعادة التسعير التلقائية', 'A large change is held by automatic repricing', 'گۆڕانێکی گەورە لە نوێکردنەوەی خۆکاری نرخدا ڕاگیراوە'),
};

export const FLAG_CLASS_LABELS: Readonly<Record<'blocking' | 'hard' | 'soft' | 'info', Tri>> = {
  blocking: t('مانعة', 'Blocking', 'ڕێگر'),
  hard: t('لا تُرفع إلا بقياس حقيقي', 'Lifted only by a real measure', 'تەنها بە پێوانەی ڕاستەقینە لادەچێت'),
  soft: t('تحتاج قبولك', 'Needs your acceptance', 'پێویستی بە پەسەندکردنی تۆیە'),
  info: t('للعلم', 'For your information', 'بۆ زانیاری'),
};

export const FLAG_UNKNOWN = t('ملاحظة: {code}', 'Flag: {code}', 'تێبینی: {code}');
export const FLAG_SKUS = t('({n} خيارات)', '({n} options)', '({n} هەڵبژاردە)');

export const REASON_LABELS: Readonly<Record<string, Tri>> = {
  CODE_EQUAL: t('الرمز نفسه', 'Same code', 'هەمان کۆد'),
  REVISION_STRIPPED: t('الرمز نفسه بلا رقم الإصدار', 'Same code without its revision', 'هەمان کۆد بەبێ ژمارەی وەشان'),
  COLOUR_COVERAGE: t('رموز الألوان تتطابق', 'Colour codes agree', 'کۆدی ڕەنگەکان یەک دەگرنەوە'),
  MATERIAL_EQUAL: t('المادة نفسها', 'Same material', 'هەمان ماددە'),
  MODEL_EQUAL: t('الطراز نفسه', 'Same model', 'هەمان مۆدێل'),
  NAME_SIMILAR: t('اسم متشابه', 'Similar name', 'ناوی لێکچوو'),
  SPOOL_DICT: t('بكرة أو عبوة بديلة', 'Spool or refill', 'سپوڵ یان پڕکردنەوە'),
  NOZZLE_DICT: t('مقاس الفوهة', 'Nozzle size', 'قەبارەی نۆزڵ'),
  PLATE_DICT: t('نوع اللوح', 'Plate type', 'جۆری پلێت'),
  PACK_EQUAL: t('العبوة نفسها', 'Same pack', 'هەمان پاکێت'),
  AMBIGUOUS: t('ملتبس: أكثر من خيار', 'Ambiguous: more than one option', 'ناڕوون: زیاتر لە یەک هەڵبژاردە'),
  PACK_MISMATCH: t('العبوة لا تتطابق', 'The pack does not match', 'پاکێتەکە ناگونجێت'),
  TYPE_MISMATCH: t('النوع لا يتطابق', 'The type does not match', 'جۆرەکە ناگونجێت'),
  LISTING_MISMATCH: t('القائمة لا تتطابق', 'The listing does not match', 'لیستەکە ناگونجێت'),
  MODEL_MISMATCH: t('طراز مختلف', 'A different model', 'مۆدێلێکی جیاواز'),
  PLACEHOLDER_LISTING: t('قائمة مؤقتة', 'A placeholder listing', 'لیستێکی کاتی'),
  PROMO_LISTING: t('قائمة عرض ترويجي', 'A promotional listing', 'لیستێکی ڕیکلامی'),
};

// ---------------------------------------------------------------- lookups

const HARD = new Set<string>(ESTIMATE_HARD_FLAGS);
const SOFT = new Set<string>(ESTIMATE_SOFT_FLAGS);
const INFO = new Set<string>(ESTIMATE_INFO_FLAGS);

/** The flag codes the estimator itself names (§4.6), every one with a label above. */
export const ESTIMATOR_FLAG_CODES: readonly EstimateFlag[] = [...ESTIMATE_BLOCKING_FLAGS, ...ESTIMATE_HARD_FLAGS, ...ESTIMATE_SOFT_FLAGS, ...ESTIMATE_INFO_FLAGS];

/** The class of a flag code (§4.6): every code the estimator does not name itself is the evaluation's own — blocking. */
export function flagClass(code: string): 'blocking' | 'hard' | 'soft' | 'info' {
  if (HARD.has(code)) return 'hard';
  if (SOFT.has(code)) return 'soft';
  if (INFO.has(code)) return 'info';
  return 'blocking';
}

/** The owner's words for a flag CODE: ours, then the pricing contract's, then the estimate refusals', then the code itself. */
export function flagText(code: string, lang: UiLang): string {
  const own = (FLAG_LABELS as Readonly<Record<string, Tri>>)[code];
  if (own) return own[lang];
  if (isPricingIssueCode(code)) return pricingIssueLabel(code, lang);
  const refusal = estimateRefusalText(code, lang);
  if (refusal) return refusal;
  return say(FLAG_UNKNOWN, lang, { code });
}

/** A match reason CODE in the owner's words (the code itself when unknown). */
export const reasonText = (code: string, lang: UiLang): string => REASON_LABELS[code]?.[lang] ?? code;

// ---------------------------------------------------------------- «روابط المورّد» of one product: his own links (§3.10, row 293)

/**
 * The owner's own supplier links (src/components/adminEstimates/SupplierLinksPanel.tsx,
 * OwnerLinkSheet.tsx): in the product form, the purchase wizard and a pre-order line of an order.
 */
export const OWNER_LINKS = {
  title: t('روابط المورّد', 'Supplier links', 'بەستەرەکانی دابینکەر'),
  intro: t(
    'احفظ رابط هذا المنتج عند أي مورّد — للمنتج كله أو لموديل أو لون أو خيار محدد — لتتابع سعره، أو تطلبه لطلب مسبق، أو تشتريه مجددًا للمخزون. تراها أنت فقط، ولا يكتب الرابط سعرًا.',
    'Save this product’s link at any supplier — for the whole product, a model, a colour or one exact option — to follow its price, order it for a pre-order, or buy it again for stock. Only you see them, and a link writes no price.',
    'بەستەری ئەم بەرهەمە لای هەر دابینکەرێک پاشەکەوت بکە — بۆ هەموو بەرهەمەکە، مۆدێلێک، ڕەنگێک یان هەڵبژاردەیەکی دیاریکراو — بۆ بەدواداچوونی نرخەکەی، داواکردنی بۆ پێشداواکاری، یان دووبارە کڕینی بۆ کۆگا. تەنها خۆت دەیانبینیت، و بەستەر هیچ نرخێک نانووسێت.'
  ),
  yours: t('روابطك', 'Your links', 'بەستەرەکانی خۆت'),
  // The matched Tmall / EU / US facts and his own typed or store-page prices, as the Links tab lists them.
  matched: t('روابط المطابقة وأسعارك', 'Matched links and your prices', 'بەستەرە هاوتاکان و نرخەکانی خۆت'),
  none: t('لا روابط لهذا المنتج بعد.', 'No links for this product yet.', 'هێشتا هیچ بەستەرێک بۆ ئەم بەرهەمە نییە.'),
  add: t('أضف رابطًا', 'Add a link', 'بەستەرێک زیاد بکە'),
  addTitle: t('رابط مورّد جديد', 'A new supplier link', 'بەستەرێکی نوێی دابینکەر'),
  edit: t('عدّل', 'Edit', 'دەستکاری بکە'),
  // Each row's buttons are named by their link, so a screen reader tells one row's from the next; the visible word is kept in the name.
  editNamed: t('عدّل الرابط «{name}»', 'Edit the link “{name}”', 'بەستەری «{name}» دەستکاری بکە'),
  editTitle: t('عدّل رابط المورّد', 'Edit the supplier link', 'دەستکاریی بەستەری دابینکەر بکە'),
  remove: t('احذف', 'Remove', 'لاببە'),
  removeNamed: t('احذف الرابط «{name}»', 'Remove the link “{name}”', 'بەستەری «{name}» لاببە'),
  removeAsk: t('حذف هذا الرابط؟', 'Remove this link?', 'ئەم بەستەرە لاببرێت؟'),
  removeBody: t('يُحذف الرابط وحده؛ لا يتغير أي سعر أو طلب.', 'Only the link is removed; no price or order changes.', 'تەنها بەستەرەکە لادەبرێت؛ هیچ نرخ و داواکارییەک ناگۆڕێت.'),
  removed: t('حُذف الرابط.', 'The link is removed.', 'بەستەرەکە لابرا.'),
  saved: t('حُفظ الرابط.', 'The link is saved.', 'بەستەرەکە پاشەکەوت کرا.'),
  save: t('احفظ الرابط', 'Save the link', 'بەستەرەکە پاشەکەوت بکە'),
  url: t('الرابط', 'Link', 'بەستەر'),
  urlHint: t(
    'الصق الرابط كما نسخته؛ يُقبل https فقط، ولا يفتحه الخادم أبدًا.',
    'Paste the link as you copied it; only https is accepted, and the server never opens it.',
    'بەستەرەکە وەک کۆپیت کردووە دابنێ؛ تەنها https وەردەگیرێت، و ڕاژەکار هەرگیز نایکاتەوە.'
  ),
  urlSaved: t('سيُحفظ هكذا:', 'It will be saved as:', 'بەم شێوەیە پاشەکەوت دەکرێت:'),
  duplicate: t('هذا الرابط محفوظ مسبقًا لهذا الخيار.', 'This link is already saved for this option.', 'ئەم بەستەرە پێشتر بۆ ئەم هەڵبژاردەیە پاشەکەوت کراوە.'),
  limit: t(
    'بلغت الحد: {n} رابطًا لكل منتج. احذف رابطًا قديمًا أولًا.',
    'Limit reached: {n} links per product. Remove an old link first.',
    'گەیشتیتە سنوور: {n} بەستەر بۆ هەر بەرهەمێک. سەرەتا بەستەرێکی کۆن لاببە.'
  ),
  name: t('اسم الرابط', 'Link name', 'ناوی بەستەر'),
  namePlaceholder: t('مثال: متجر Bambu الرسمي على Tmall', 'e.g. Bambu’s official Tmall store', 'نموونە: فرۆشگای فەرمیی Bambu لە Tmall'),
  supplier: t('المورّد', 'Supplier', 'دابینکەر'),
  supplierName: t('المورّد: {name}', 'Supplier: {name}', 'دابینکەر: {name}'),
  note: t('ملاحظة', 'Note', 'تێبینی'),
  textInvalid: t('النص طويل جدًا أو فيه رمز غير مقبول.', 'The text is too long or holds a character that is not accepted.', 'دەقەکە زۆر درێژە یان پیتێکی وەرنەگیراوی تێدایە.'),
  appliesTo: t('لأيّ خيار؟', 'For which option?', 'بۆ کام هەڵبژاردە؟'),
  keyGone: t('هذا الخيار لم يعد في المنتج؛ اختر غيره.', 'This option is no longer in the product; choose another.', 'ئەم هەڵبژاردەیە چیتر لە بەرهەمەکەدا نییە؛ یەکێکی تر هەڵبژێرە.'),
  appliesLabel: t('لـ {name}', 'For {name}', 'بۆ {name}'),
  appliesWhole: t('للمنتج كله', 'For the whole product', 'بۆ هەموو بەرهەمەکە'),
  kindProduct: t('المنتج كله', 'The whole product', 'هەموو بەرهەمەکە'),
  kindOption: t('موديل أو خيار', 'A model or option', 'مۆدێل یان هەڵبژاردە'),
  kindColour: t('لون', 'A colour', 'ڕەنگ'),
  kindSku: t('خيار ولون محددان', 'One exact option and colour', 'هەڵبژاردە و ڕەنگێکی دیاریکراو'),
  added: t('أُضيف {date}', 'Added {date}', 'زیادکراوە لە {date}'),
  edited: t('عُدّل {date}', 'Edited {date}', 'دەستکاریکراوە لە {date}'),
  unsafe: t(
    'لا يُفتح: العنوان المحفوظ ليس رابط https صالحًا.',
    'Not opened: the saved address is not a valid https link.',
    'ناکرێتەوە: ناونیشانی پاشەکەوتکراو بەستەرێکی https ی دروست نییە.'
  ),
  notInstalled: t(
    'حفظ روابطك غير متاح بعد على هذا الخادم؛ يظهر هنا حين يُفعَّل.',
    'Saving your links is not available on this server yet; it appears here once switched on.',
    'پاشەکەوتکردنی بەستەرەکانی خۆت هێشتا لەم ڕاژەکارە بەردەست نییە؛ کاتێک چالاک کرا لێرە دەردەکەوێت.'
  ),
  orderFrom: t('اطلبها من المورّد', 'Order it from the supplier', 'لە دابینکەر داوای بکە'),
  buyAgain: t('اشترِ مجددًا من المورّد', 'Buy again from the supplier', 'دووبارە لە دابینکەر بیکڕە'),
  lastPrice: t('آخر سعر معروف عند المورّد', 'Last known supplier price', 'دوایین نرخی زانراوی دابینکەر'),
  showAll: t('كل الروابط ({n})', 'All links ({n})', 'هەموو بەستەرەکان ({n})'),
  showLess: t('أخفِ القائمة', 'Hide the list', 'لیستەکە بشارەوە'),
  // The sheet opens from the card and from a strip alike: it names the workspace section (TAB_LABELS.links), not this card.
  sheetNote: t(
    'الرابط لا يكتب سعرًا ولا يصير مطابقة مؤكدة؛ سجّل السعر من «تحديث السعر» في قسم «روابط المورّد» من التسعير التقديري.',
    'A link writes no price and never becomes a confirmed match; record a price with “Update the price” in the “Supplier links” section of estimated pricing.',
    'بەستەر هیچ نرخێک نانووسێت و نابێتە هاوتای پشتڕاستکراو؛ نرخ لە «نوێکردنەوەی نرخ» لە بەشی «بەستەرەکانی دابینکەر»ی نرخدانانی خەمڵێنراو تۆمار بکە.'
  ),
} as const;

/** Why the shared parser refused an address (packages/catalog/src/supplierPrices/ownerLink.ts), said beside the field. */
export const OWNER_LINK_ERROR_TEXT: Readonly<Record<OwnerLinkError, Tri>> = {
  empty: t('الصق الرابط أولًا.', 'Paste the link first.', 'سەرەتا بەستەرەکە دابنێ.'),
  not_url: t(
    'هذا ليس رابطًا صالحًا: لا مسافة فيه ولا رمز مخفي.',
    'This is not a valid link: no space and no hidden character.',
    'ئەمە بەستەرێکی دروست نییە: نابێت بۆشایی یان پیتی شاراوەی تێدا بێت.'
  ),
  not_https: t('يُقبل رابط https فقط.', 'Only an https link is accepted.', 'تەنها بەستەری https وەردەگیرێت.'),
  credentials: t(
    'لا يُقبل رابط يحمل اسم مستخدم أو كلمة مرور.',
    'A link carrying a user name or password is not accepted.',
    'بەستەرێک کە ناوی بەکارهێنەر یان وشەی نهێنی تێدایە وەرناگیرێت.'
  ),
  port: t('لا يُقبل رابط فيه رقم منفذ.', 'A link with a port number is not accepted.', 'بەستەرێک کە ژمارەی پۆرتی تێدایە وەرناگیرێت.'),
  host: t(
    'الموقع في الرابط غير مقبول: يلزم اسم موقع، لا عنوان IP ولا localhost.',
    'The site in the link is not accepted: it needs a site name, not an IP address or localhost.',
    'ماڵپەڕەکەی ناو بەستەرەکە وەرناگیرێت: ناوی ماڵپەڕ پێویستە، نەک ناونیشانی IP یان localhost.'
  ),
  too_long: t(
    'الرابط أطول من {n} حرف؛ احذف ما بعد علامة «?» ثم جرّبه.',
    'The link is longer than {n} characters; remove what follows the “?” and try it.',
    'بەستەرەکە لە {n} پیت درێژترە؛ ئەوەی دوای «?» لاببە و تاقیی بکەرەوە.'
  ),
};
