/**
 * «ملف بيانات المنتج» — EVERY WORD OF THE SHEET, IN ARABIC, ENGLISH AND SORANI
 * (src/components/adminProducts/form/DataFileSheet.tsx; owner brief 2026-10-10).
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183); tests/productDataFileStrings.test.ts walks the
 * table. The refusals the server sends by code (`DATA_FILE_*`) are rendered
 * from packages/contracts/src/dataFileRefusals.ts, not from here.
 */
import { PRICING_FIELD_LABELS, PRICING_SCOPE_LABELS } from '../../../packages/contracts/src/pricingFieldLabels';

export type DataFileLang = 'ar' | 'en' | 'ckb';
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const DATA_FILE_STRINGS = {
  title: { ar: 'تحديث البيانات', en: 'Update data', ckb: 'نوێکردنەوەی زانیاری' },
  bulkTitle: { ar: 'ملف بيانات المنتجات', en: 'Products data file', ckb: 'فایلی زانیاریی بەرهەمەکان' },
  intro: {
    ar: 'نزّل ملف بيانات المنتج، عدّل ما تريد، ثم أرفقه: يُقارَن الملف بالمنتج حقلاً بحقل ويُطبَّق ما تغيّر فقط — ليس استيراداً من جديد.',
    en: 'Download the product data file, edit what you need, then attach it: it is compared with the product field by field and only what changed is applied — never a re-import.',
    ckb: 'فایلی زانیاریی بەرهەم دابگرە، ئەوەی دەتەوێت بیگۆڕە، پاشان هاوپێچی بکە: خانە بە خانە لەگەڵ بەرهەمەکە بەراورد دەکرێت و تەنها ئەوەی گۆڕاوە جێبەجێ دەکرێت — نەک هاوردەکردنی نوێ.',
  },
  stepDownload: { ar: '١. نزّل ملف بيانات المنتج', en: '1. Download the product data file', ckb: '١. فایلی زانیاریی بەرهەم دابگرە' },
  stepDownloadBulk: { ar: '١. نزّل ملف بيانات المنتجات (25 منتجاً في الملف)', en: '1. Download the products data file (25 products per file)', ckb: '١. فایلی زانیاریی بەرهەمەکان دابگرە (25 بەرهەم لە هەر فایلێک)' },
  stepUpload: { ar: '٢. أرفق الملف بعد التعديل', en: '2. Attach the edited file', ckb: '٢. فایلە دەستکاریکراوەکە هاوپێچ بکە' },
  stepChanges: { ar: '٣. التغييرات', en: '3. Changes', ckb: '٣. گۆڕانکارییەکان' },
  chunk: { ar: 'المنتجات {from}–{to}', en: 'Products {from}–{to}', ckb: 'بەرهەمەکانی {from}–{to}' },
  noProducts: { ar: 'لا توجد منتجات في الصفحة الحالية.', en: 'There are no products on the current page.', ckb: 'هیچ بەرهەمێک لە پەڕەی ئێستادا نییە.' },
  chooseFile: { ar: 'اختر الملف', en: 'Choose the file', ckb: 'فایلەکە هەڵبژێرە' },
  chooseOther: { ar: 'اختر ملفاً آخر', en: 'Choose another file', ckb: 'فایلێکی تر هەڵبژێرە' },
  comparing: { ar: 'جارٍ المقارنة…', en: 'Comparing…', ckb: 'بەراورد دەکرێت…' },
  compareAgain: { ar: 'أعد المقارنة', en: 'Compare again', ckb: 'دووبارە بەراورد بکەرەوە' },
  compareFailed: { ar: 'تعذّرت المقارنة — أعد المحاولة.', en: 'The comparison failed — try again.', ckb: 'بەراوردکردن سەرکەوتوو نەبوو — دووبارە هەوڵ بدەرەوە.' },
  downloadStarted: { ar: 'بدأ التنزيل: {name}', en: 'Download started: {name}', ckb: 'داگرتن دەستی پێکرد: {name}' },
  downloadFailed: { ar: 'تعذّر التنزيل', en: 'The download failed', ckb: 'داگرتن سەرکەوتوو نەبوو' },
  apply: { ar: 'تطبيق التغييرات', en: 'Apply changes', ckb: 'جێبەجێکردنی گۆڕانکارییەکان' },
  applying: { ar: 'جارٍ التطبيق…', en: 'Applying…', ckb: 'جێبەجێ دەکرێت…' },
  cancel: { ar: 'إلغاء', en: 'Cancel', ckb: 'هەڵوەشاندنەوە' },
  close: { ar: 'إغلاق', en: 'Close', ckb: 'دایبخە' },
  noChanges: { ar: 'لا تغيير — قيم الملف مطابقة لما هو محفوظ.', en: 'No change — the file matches what is saved.', ckb: 'هیچ گۆڕانکارییەک نییە — فایلەکە وەک ئەوەی پاشەکەوت کراوە.' },
  summary: { ar: 'سيُطبَّق {n} · رُفض {m}', en: '{n} to apply · {m} refused', ckb: '{n} جێبەجێ دەکرێت · {m} ڕەتکرایەوە' },
  before: { ar: 'قبل', en: 'Before', ckb: 'پێشتر' },
  after: { ar: 'بعد', en: 'After', ckb: 'دوای گۆڕان' },
  line: { ar: 'سطر', en: 'line', ckb: 'هێڵ' },
  derived: { ar: 'يتغيّر تبعاً لذلك ({n})', en: 'Changes as a result ({n})', ckb: 'بەهۆی ئەوەوە دەگۆڕێت ({n})' },
  stale: { ar: 'أقدم من المحفوظ — لن يُطبَّق ({n})', en: 'Older than what is saved — not applied ({n})', ckb: 'کۆنترە لەوەی پاشەکەوت کراوە — جێبەجێ ناکرێت ({n})' },
  gone: { ar: 'عناصر حُذفت من المنتج بعد التنزيل — تُجوهلت: {list}', en: 'Items removed from the product after the download — ignored: {list}', ckb: 'ئەو بڕگانەی دوای داگرتن لە بەرهەمەکە لابراون — فەرامۆش کران: {list}' },
  pricingAdopt: { ar: 'هذا الحفظ يُدخل المنتج التسعير الآلي ويكتب أسعاره.', en: 'This save enters the product into automatic pricing and writes its prices.', ckb: 'ئەم پاشەکەوتکردنە بەرهەمەکە دەخاتە نرخدانانی خۆکار و نرخەکانی دەنووسێت.' },
  pricingReprice: { ar: 'هذا الحفظ يعيد تسعير المنتج بالمحرك.', en: 'This save reprices the product through the engine.', ckb: 'ئەم پاشەکەوتکردنە بە بزوێنەرەکە نرخی بەرهەمەکە نوێ دەکاتەوە.' },
  pricingData: { ar: 'تُحفظ بيانات التسعير فقط، ولا يتغيّر أي سعر.', en: 'Only the pricing data is stored; no price changes.', ckb: 'تەنها زانیاریی نرخدانان پاشەکەوت دەکرێت؛ هیچ نرخێک ناگۆڕێت.' },
  pricingRow: { ar: '{channel}: {old} ← {new} د.ع', en: '{channel}: {old} → {new} IQD', ckb: '{channel}: {old} ← {new} دیناری عێراقی' },
  largeChange: { ar: 'أوافق على تغيير كبير في السعر (أكثر من 15٪)', en: 'I confirm a large price change (over 15%)', ckb: 'ڕەزامەندم لەسەر گۆڕانێکی گەورەی نرخ (زیاتر لە ١٥٪)' },
  applied: { ar: 'طُبّق {n} من الملف', en: '{n} applied from the file', ckb: '{n} لە فایلەکەوە جێبەجێ کرا' },
  alreadyApplied: { ar: 'طُبّق هذا الملف من قبل.', en: 'This file was already applied.', ckb: 'ئەم فایلە پێشتر جێبەجێ کراوە.' },
  applyFailed: { ar: 'تعذّر التطبيق — أعد المحاولة.', en: 'The apply failed — try again.', ckb: 'جێبەجێکردن سەرکەوتوو نەبوو — دووبارە هەوڵ بدەرەوە.' },
  notPersisted: { ar: 'لم تُحفظ هذه الحقول كما في الملف: {list}', en: 'These fields did not save as the file says: {list}', ckb: 'ئەم خانانە وەک ئەوەی لە فایلەکەدایە پاشەکەوت نەکران: {list}' },
  resultApplied: { ar: 'طُبّق', en: 'Applied', ckb: 'جێبەجێ کرا' },
  resultNothing: { ar: 'لا شيء للتطبيق', en: 'Nothing to apply', ckb: 'هیچ شتێک بۆ جێبەجێکردن نییە' },
  formDirty: { ar: 'تعديلاتك غير المحفوظة في النموذج تبقى كما هي.', en: 'Your unsaved edits in the form are kept.', ckb: 'دەستکارییە پاشەکەوتنەکراوەکانت لە فۆڕمەکەدا وەک خۆیان دەمێننەوە.' },
  staffFile: { ar: 'ملفك بلا تكلفة ولا تسعير خاص — هذه للمالك وحده.', en: 'Your file carries no cost or private pricing — those are the owner\'s alone.', ckb: 'فایلەکەت تێچوو و نرخدانانی تایبەتی تێدا نییە — ئەوانە تەنها بۆ خاوەنن.' },
  menuEntry: { ar: 'ملف بيانات المنتجات (تنزيل / إرفاق)', en: 'Products data file (download / attach)', ckb: 'فایلی زانیاریی بەرهەمەکان (داگرتن / هاوپێچ)' },
  updateDataTitle: { ar: 'تنزيل ملف بيانات المنتج وتطبيق ما تغيّر فيه', en: 'Download the product data file and apply what changed in it', ckb: 'فایلی زانیاریی بەرهەم دابگرە و ئەوەی تێیدا گۆڕاوە جێبەجێی بکە' },
  productError: { ar: 'لا يمكن مقارنة هذا المنتج', en: 'This product cannot be compared', ckb: 'ئەم بەرهەمە بەراورد ناکرێت' },
  // A bulk file is compared over several calls (each one invocation of D1's 1,000 queries, row 212).
  comparingProgress: { ar: 'جارٍ المقارنة… ({n} من {total})', en: 'Comparing… ({n} of {total})', ckb: 'بەراورد دەکرێت… ({n} لە {total})' },
  sizeNote: { ar: '({needed} عملية كتابة، والحد {allowance})', en: '({needed} writes; the limit is {allowance})', ckb: '({needed} کرداری نووسین؛ سنوورەکە {allowance})' },
} satisfies Record<string, Tri>;

/** Why a line is not applied — one sentence per status (the server's message follows for INVALID_VALUE). */
export const DATA_FILE_STATUS: Record<string, Tri> = {
  change: { ar: 'سيُطبَّق', en: 'Will apply', ckb: 'جێبەجێ دەکرێت' },
  STALE_IN_FILE: { ar: 'تغيّر بعد التنزيل ولم تعدّله في الملف — تبقى القيمة المحفوظة', en: 'Changed after the download and not edited in the file — the saved value stays', ckb: 'دوای داگرتن گۆڕاوە و لە فایلەکەدا دەستکاری نەکراوە — بەهای پاشەکەوتکراو دەمێنێتەوە' },
  UNKNOWN_FIELD: { ar: 'حقل غير معروف — تُجوهل', en: 'Unknown field — ignored', ckb: 'خانەیەکی نەناسراو — فەرامۆش کرا' },
  INVALID_VALUE: { ar: 'قيمة غير صالحة', en: 'Invalid value', ckb: 'بەهای نادروست' },
  READ_ONLY: { ar: 'للقراءة فقط — لا يُعدَّل من الملف', en: 'Read-only — not edited from the file', ckb: 'تەنها بۆ خوێندنەوە — لە فایلەوە ناگۆڕدرێت' },
  ENGINE_MANAGED: {
    ar: 'يحسبه محرك التسعير — غيّر بيانات التسعير (التكلفة، الشحن، الحد الأدنى للربح) بدلاً منه',
    en: 'Priced by the engine — change the pricing inputs (cost, shipping, minimum profit) instead',
    ckb: 'بزوێنەری نرخدانان دایدەنێت — لەبری ئەوە زانیارییەکانی نرخدانان بگۆڕە (تێچوو، ناردن، کەمترین قازانج)',
  },
  CONFLICT_SINCE_DOWNLOAD: { ar: 'تغيّر هذا القسم بعد تنزيل الملف — نزّل الملف من جديد وعدّل عليه', en: 'This section changed after the file was downloaded — download it again and edit that', ckb: 'ئەم بەشە دوای داگرتنی فایلەکە گۆڕاوە — دووبارە دایبگرە و ئەوە دەستکاری بکە' },
  COST_OWNER_ONLY: { ar: 'التكلفة والتسعير الخاص للمالك وحده — لا يُطبَّق', en: 'Cost and private pricing are the owner\'s alone — not applied', ckb: 'تێچوو و نرخدانانی تایبەت تەنها بۆ خاوەنن — جێبەجێ ناکرێت' },
  PRICING_SCOPE_UNKNOWN: { ar: 'نطاق تسعير غير موجود في المنتج — احفظ الموديل أولاً ثم أضف تسعيره', en: 'A pricing scope the product does not have — save the model first, then its pricing', ckb: 'بواری نرخدانانێک کە بەرهەمەکە نییەتی — سەرەتا مۆدێلەکە پاشەکەوت بکە، پاشان نرخدانانەکەی' },
  STRUCTURE_WITH_ADOPTION: { ar: 'يعيد تسعير المنتج — طبّق التغييرات الأخرى أولاً ثم أرفق الملف نفسه مرة ثانية', en: 'Reprices the product — apply the other changes first, then attach the same file again', ckb: 'نرخی بەرهەمەکە دەگۆڕێت — سەرەتا گۆڕانکارییەکانی تر جێبەجێ بکە، پاشان هەمان فایل دووبارە هاوپێچ بکە' },
  NEW_IMAGE: { ar: 'الصور تُضاف وتُستبدل من النموذج', en: 'Pictures are added and replaced in the form', ckb: 'وێنەکان لە فۆڕمەکەوە زیاد و گۆڕدرێن' },
};

/** The form sections a line belongs to (the server's `section`). */
export const DATA_FILE_SECTIONS: Record<string, Tri> = {
  identity: { ar: 'الهوية', en: 'Identity', ckb: 'ناسنامە' },
  description: { ar: 'الوصف', en: 'Description', ckb: 'وەسف' },
  pricing: { ar: 'الأسعار', en: 'Prices', ckb: 'نرخەکان' },
  classification: { ar: 'التصنيف', en: 'Classification', ckb: 'پۆلێنکردن' },
  selling: { ar: 'البيع والمخزون', en: 'Selling & stock', ckb: 'فرۆشتن و کۆگا' },
  delivery: { ar: 'خيارات التوصيل', en: 'Delivery options', ckb: 'بژاردەکانی گەیاندن' },
  transports: { ar: 'شحن الطلب المسبق', en: 'Pre-order transports', ckb: 'ناردنی داواکاریی پێشوەخت' },
  media: { ar: 'الصور', en: 'Pictures', ckb: 'وێنەکان' },
  options: { ar: 'الخيارات والتركيبات', en: 'Options & combinations', ckb: 'هەڵبژاردەکان و تێکەڵەکان' },
  colors: { ar: 'الألوان', en: 'Colours', ckb: 'ڕەنگەکان' },
  specs: { ar: 'المواصفات', en: 'Specifications', ckb: 'تایبەتمەندییەکان' },
  labels: { ar: 'الشارات', en: 'Labels', ckb: 'نیشانەکان' },
  warranty: { ar: 'الضمان', en: 'Warranty', ckb: 'گەرەنتی' },
  condition: { ar: 'الحالة', en: 'Condition', ckb: 'دۆخ' },
  dimensions: { ar: 'الأبعاد والوزن', en: 'Dimensions & weight', ckb: 'قەبارە و کێش' },
  content: { ar: 'كتل المحتوى', en: 'Content blocks', ckb: 'بلۆکەکانی ناوەڕۆک' },
  usage: { ar: 'دليل التركيب والاستخدام', en: 'Setup & usage guide', ckb: 'ڕێبەری دامەزراندن و بەکارهێنان' },
  membership: { ar: 'خصم العضوية', en: 'Membership discount', ckb: 'داشکاندنی ئەندامێتی' },
  pricing_usd: { ar: 'التسعير بالدولار (للمالك)', en: 'USD pricing (owner)', ckb: 'نرخدانان بە دۆلار (خاوەن)' },
};

/**
 * A line's own field, in the reader's words — every scalar and every generic
 * item leaf the data file writes (requirement 5 of row 212: no key falls back
 * to its raw name). A leaf whose meaning depends on its group is in
 * `DATA_FILE_GROUP_FIELDS`; an `_ar` / `_en` / `_ckb` leaf is its base's label
 * with the language (`fieldLabel`); the owner's pricing leaves are
 * packages/contracts/src/pricingFieldLabels.ts, one vocabulary across every
 * pricing screen.
 */
export const DATA_FILE_FIELDS: Record<string, Tri> = {
  name_ar: { ar: 'الاسم (عربي)', en: 'Name (Arabic)', ckb: 'ناو (عەرەبی)' },
  name_en: { ar: 'الاسم (إنجليزي)', en: 'Name (English)', ckb: 'ناو (ئینگلیزی)' },
  name_ckb: { ar: 'الاسم (كردي)', en: 'Name (Kurdish)', ckb: 'ناو (بە کوردی)' },
  description_ar: { ar: 'الوصف (عربي)', en: 'Description (Arabic)', ckb: 'وەسف (عەرەبی)' },
  description_en: { ar: 'الوصف (إنجليزي)', en: 'Description (English)', ckb: 'وەسف (ئینگلیزی)' },
  description_ckb: { ar: 'الوصف (كردي)', en: 'Description (Kurdish)', ckb: 'وەسف (کوردی)' },
  how_to_use: { ar: 'طريقة الاستخدام', en: 'How to use', ckb: 'ڕێگای بەکارهێنان' },
  status: { ar: 'الحالة', en: 'Status', ckb: 'دۆخ' },
  price_iqd: { ar: 'السعر', en: 'Price', ckb: 'نرخی فرۆشتن' },
  regular_price_iqd: { ar: 'السعر', en: 'Price', ckb: 'نرخی فرۆشتن' },
  regular_adjust_iqd: { ar: 'الزيادة فوق الأساسي', en: 'Increase over the base', ckb: 'زیادە لەسەر بنەڕەت' },
  pro_price_iqd: { ar: 'سعر عضو PRO', en: 'PRO member price', ckb: 'نرخی ئەندامی PRO' },
  prime_price_iqd: { ar: 'سعر عضو PRIME', en: 'PRIME member price', ckb: 'نرخی ئەندامی PRIME' },
  pro_adjust_iqd: { ar: 'زيادة سعر PRO', en: 'PRO price increase', ckb: 'زیادەی نرخی PRO' },
  prime_adjust_iqd: { ar: 'زيادة سعر PRIME', en: 'PRIME price increase', ckb: 'زیادەی نرخی PRIME' },
  original_price_iqd: { ar: 'السعر قبل الخصم', en: 'Compare-at price', ckb: 'نرخ پێش داشکاندن' },
  product_cost_iqd: { ar: 'الكلفة', en: 'Cost', ckb: 'تێچوو' },
  cost_iqd: { ar: 'الكلفة', en: 'Cost', ckb: 'تێچوو' },
  cost_adjust_iqd: { ar: 'زيادة الكلفة', en: 'Cost increase', ckb: 'زیادەی تێچوو' },
  stock: { ar: 'المخزون', en: 'Stock', ckb: 'کۆگا' },
  low_stock_threshold: { ar: 'حدّ التنبيه لانخفاض المخزون', en: 'Low-stock alert level', ckb: 'ئاستی ئاگادارکردنەوەی کەمیی کۆگا' },
  sku: { ar: 'رمز المنتج', en: 'SKU', ckb: 'کۆدی بەرهەم' },
  sku_part: { ar: 'جزء رمز المنتج', en: 'SKU part', ckb: 'بەشی کۆدی بەرهەم' },
  active: { ar: 'فعّال', en: 'Active', ckb: 'چالاک' },
  enabled: { ar: 'مفعّل', en: 'Enabled', ckb: 'چالاککراو' },
  hex: { ar: 'رمز اللون', en: 'Colour code', ckb: 'کۆدی ڕەنگ' },
  surcharge_iqd: { ar: 'الزيادة بالدينار', en: 'Surcharge (IQD)', ckb: 'زیادە (دینار)' },
  remove: { ar: 'حذف', en: 'Remove', ckb: 'لابردنی بڕگە' },
  // classification
  brand: { ar: 'العلامة التجارية', en: 'Brand', ckb: 'مارکە (براند)' },
  catalogs: { ar: 'الأقسام', en: 'Catalogues', ckb: 'بەشەکان' },
  fits_printers: { ar: 'يناسب الطابعات', en: 'Fits printers', ckb: 'گونجاوە بۆ چاپکەرەکان' },
  category: { ar: 'القسم', en: 'Category', ckb: 'بەش' },
  sub_category: { ar: 'القسم الفرعي', en: 'Subcategory', ckb: 'بەشی لاوەکی' },
  template_family: { ar: 'عائلة القالب', en: 'Template family', ckb: 'خێزانی قاڵب' },
  hashtags: { ar: 'الوسوم', en: 'Hashtags', ckb: 'هاشتاگەکان' },
  is_featured: { ar: 'منتج مميّز', en: 'Featured', ckb: 'بەرهەمی دیار' },
  display_order: { ar: 'ترتيب العرض', en: 'Display order', ckb: 'ڕیزبەندیی پیشاندان' },
  // selling and delivery
  selling_type: { ar: 'نوع البيع', en: 'Selling type', ckb: 'جۆری فرۆشتن' },
  inventory_mode: { ar: 'طريقة المخزون', en: 'Stock mode', ckb: 'شێوازی کۆگا' },
  payment_options: { ar: 'خيارات الدفع', en: 'Payment options', ckb: 'بژاردەکانی پارەدان' },
  standard_delivery_enabled: { ar: 'التوصيل العادي مفعّل', en: 'Standard delivery enabled', ckb: 'گەیاندنی ئاسایی چالاکە' },
  standard_delivery_quantity_step: { ar: 'خطوة الكمية للتوصيل العادي', en: 'Standard delivery quantity step', ckb: 'هەنگاوی بڕ بۆ گەیاندنی ئاسایی' },
  standard_delivery_fee_iqd: { ar: 'أجرة التوصيل العادي (د.ع)', en: 'Standard delivery fee (IQD)', ckb: 'کرێی گەیاندنی ئاسایی (دینار)' },
  personal_delivery_enabled: { ar: 'التوصيل الشخصي مفعّل', en: 'Personal delivery enabled', ckb: 'گەیاندنی کەسی چالاکە' },
  personal_delivery_quantity_step: { ar: 'خطوة الكمية للتوصيل الشخصي', en: 'Personal delivery quantity step', ckb: 'هەنگاوی بڕ بۆ گەیاندنی کەسی' },
  personal_delivery_fee_iqd: { ar: 'أجرة التوصيل الشخصي (د.ع)', en: 'Personal delivery fee (IQD)', ckb: 'کرێی گەیاندنی کەسی (دینار)' },
  // warranty and condition
  warranty_base_months: { ar: 'الضمان الأساسي (أشهر)', en: 'Base warranty (months)', ckb: 'گەرەنتیی بنەڕەتی (مانگ)' },
  serialized: { ar: 'يُسجَّل برقم تسلسلي', en: 'Serialized', ckb: 'بە ژمارەی زنجیرەیی تۆمار دەکرێت' },
  condition_kind: { ar: 'نوع الحالة', en: 'Condition type', ckb: 'جۆری دۆخ' },
  condition_grade: { ar: 'درجة الحالة', en: 'Condition grade', ckb: 'پلەی دۆخ' },
  condition_usage_hours: { ar: 'ساعات الاستخدام', en: 'Usage hours', ckb: 'کاتژمێرەکانی بەکارهێنان' },
  condition_warranty_months: { ar: 'ضمان الحالة (أشهر)', en: 'Condition warranty (months)', ckb: 'گەرەنتیی دۆخ (مانگ)' },
  condition_new_product_slug: { ar: 'رابط المنتج الجديد', en: 'New product link', ckb: 'بەستەری بەرهەمی نوێ' },
  condition_fault: { ar: 'وصف العطل', en: 'Fault', ckb: 'وەسفی کەموکوڕی' },
  condition_repair: { ar: 'الإصلاح', en: 'Repair', ckb: 'چاککردنەوە' },
  condition_notes: { ar: 'ملاحظات الحالة', en: 'Condition notes', ckb: 'تێبینییەکانی دۆخ' },
  // dimensions
  net_weight_g: { ar: 'الوزن الصافي (غ)', en: 'Net weight (g)', ckb: 'کێشی سافی (گ)' },
  width_mm: { ar: 'العرض (ملم)', en: 'Width (mm)', ckb: 'پانی (میلیمەتر)' },
  depth_mm: { ar: 'العمق (ملم)', en: 'Depth (mm)', ckb: 'قووڵی (میلیمەتر)' },
  height_mm: { ar: 'الارتفاع (ملم)', en: 'Height (mm)', ckb: 'بەرزی (میلیمەتر)' },
  package_weight_g: { ar: 'وزن الطرد (غ)', en: 'Package weight (g)', ckb: 'کێشی پاکێت (گ)' },
  package_width_mm: { ar: 'عرض الطرد (ملم)', en: 'Package width (mm)', ckb: 'پانیی پاکێت (میلیمەتر)' },
  package_depth_mm: { ar: 'عمق الطرد (ملم)', en: 'Package depth (mm)', ckb: 'قووڵیی پاکێت (میلیمەتر)' },
  package_height_mm: { ar: 'ارتفاع الطرد (ملم)', en: 'Package height (mm)', ckb: 'بەرزیی پاکێت (میلیمەتر)' },
  // usage and media
  usage_official_url: { ar: 'رابط الدليل الرسمي', en: 'Official guide link', ckb: 'بەستەری ڕێبەری فەرمی' },
  gini_url: { ar: 'رابط المنتج في تطبيق جني', en: 'Product link in the Gini app', ckb: 'بەستەری بەرهەم لە ئەپی جینی' },
  light_image: { ar: 'صورة الوضع الفاتح', en: 'Light-mode picture', ckb: 'وێنەی دۆخی ڕووناک' },
  // models, colours and combinations
  group: { ar: 'مجموعة الخيارات', en: 'Option group', ckb: 'گرووپی هەڵبژاردەکان' },
  availability_type: { ar: 'نوع التوفّر', en: 'Availability type', ckb: 'جۆری بەردەستبوون' },
  lead_time_text: { ar: 'مدة التوريد (نص)', en: 'Lead time (text)', ckb: 'ماوەی گەیاندن (دەق)' },
  lead_time_min_days: { ar: 'أقل مدة توريد (أيام)', en: 'Minimum lead time (days)', ckb: 'کەمترین ماوەی گەیاندن (ڕۆژ)' },
  lead_time_max_days: { ar: 'أقصى مدة توريد (أيام)', en: 'Maximum lead time (days)', ckb: 'زۆرترین ماوەی گەیاندن (ڕۆژ)' },
  variant_key: { ar: 'مفتاح الخيار', en: 'Variant key', ckb: 'کلیلی جۆر' },
  variant_label: { ar: 'اسم الخيار', en: 'Variant label', ckb: 'ناونیشانی جۆر' },
  option_id: { ar: 'الموديل المرتبط', en: 'Linked model', ckb: 'مۆدێلی پەیوەندیدار' },
  option_ids: { ar: 'الموديلات المرتبطة', en: 'Linked models', ckb: 'مۆدێلە پەیوەندیدارەکان' },
  option_value_id: { ar: 'الموديل', en: 'Model', ckb: 'مۆدێل' },
  option_value_ids: { ar: 'الموديلات', en: 'Models', ckb: 'مۆدێلەکان' },
  color_id: { ar: 'اللون', en: 'Colour', ckb: 'ڕەنگ' },
  variant_id: { ar: 'التركيبة', en: 'Combination', ckb: 'تێکەڵە' },
  id: { ar: 'المعرّف', en: 'ID', ckb: 'ناسنامە (ID)' },
  method: { ar: 'طريقة الشحن', en: 'Shipping method', ckb: 'ڕێگای ناردن' },
  commission_iqd: { ar: 'عمولة الطريق (د.ع)', en: 'Route commission (IQD)', ckb: 'کۆمیسیۆنی ڕێگا (دینار)' },
  // pictures, labels, plans, blocks, steps (the generic words; DATA_FILE_GROUP_FIELDS says which)
  primary: { ar: 'الصورة الرئيسية', en: 'Main picture', ckb: 'وێنەی سەرەکی' },
  url: { ar: 'الرابط', en: 'Link', ckb: 'بەستەر' },
  key: { ar: 'المفتاح', en: 'Key', ckb: 'کلیلی ناوخۆیی' },
  alt: { ar: 'النص البديل', en: 'Alt text', ckb: 'دەقی جێگرەوە' },
  source_url: { ar: 'رابط المصدر', en: 'Source link', ckb: 'بەستەری سەرچاوە' },
  width: { ar: 'العرض (بكسل)', en: 'Width (px)', ckb: 'پانی (پیکسڵ)' },
  height: { ar: 'الارتفاع (بكسل)', en: 'Height (px)', ckb: 'بەرزی (پیکسڵ)' },
  content_type: { ar: 'نوع الملف', en: 'File type', ckb: 'جۆری فایل' },
  bytes: { ar: 'حجم الملف (بايت)', en: 'File size (bytes)', ckb: 'قەبارەی فایل (بایت)' },
  title: { ar: 'العنوان', en: 'Title', ckb: 'سەردێڕ' },
  label: { ar: 'التسمية', en: 'Label', ckb: 'ناوی بڕگە' },
  value: { ar: 'القيمة', en: 'Value', ckb: 'بەها' },
  unit: { ar: 'الوحدة', en: 'Unit', ckb: 'یەکە' },
  text: { ar: 'النص', en: 'Text', ckb: 'دەق' },
  icon: { ar: 'الأيقونة', en: 'Icon', ckb: 'ئایکۆن' },
  visible: { ar: 'ظاهرة', en: 'Visible', ckb: 'دیارە' },
  terms: { ar: 'الشروط', en: 'Terms', ckb: 'مەرجەکان' },
  duration_months: { ar: 'المدة (أشهر)', en: 'Duration (months)', ckb: 'ماوە (مانگ)' },
  duration_kind: { ar: 'نوع المدة', en: 'Duration type', ckb: 'جۆری ماوە' },
  fee_percent: { ar: 'الرسوم (%)', en: 'Fee (%)', ckb: 'کرێ (%)' },
  fee_iqd: { ar: 'الرسوم (د.ع)', en: 'Fee (IQD)', ckb: 'کرێ (دینار)' },
  kind: { ar: 'النوع', en: 'Kind', ckb: 'جۆر' },
  body: { ar: 'النص', en: 'Body', ckb: 'دەق' },
  caption: { ar: 'التعليق', en: 'Caption', ckb: 'ڕوونکردنەوە' },
  media_key: { ar: 'مفتاح الوسائط', en: 'Media key', ckb: 'کلیلی وێنە/ڤیدیۆ' },
  images: { ar: 'الصور', en: 'Pictures', ckb: 'وێنەکان' },
  video_url: { ar: 'رابط الفيديو', en: 'Video link', ckb: 'بەستەری ڤیدیۆ' },
  link_url: { ar: 'الرابط', en: 'Link', ckb: 'بەستەر' },
};

/** The fields whose word depends on the group they sit in (a picture's key is not a badge's). Keyed by the key's family (indices stripped). */
export const DATA_FILE_GROUP_FIELDS: Record<string, Record<string, Tri>> = {
  images: {
    key: { ar: 'مفتاح التخزين', en: 'Storage key', ckb: 'کلیلی هەڵگرتن' },
    url: { ar: 'رابط الصورة', en: 'Picture link', ckb: 'بەستەری وێنە' },
    alt: { ar: 'النص البديل للصورة', en: 'Picture alt text', ckb: 'دەقی جێگرەوەی وێنە' },
    color_id: { ar: 'لون الصورة', en: 'Picture colour', ckb: 'ڕەنگی وێنە' },
    option_value_id: { ar: 'موديل الصورة', en: 'Picture model', ckb: 'مۆدێلی وێنە' },
    variant_id: { ar: 'تركيبة الصورة', en: 'Picture combination', ckb: 'تێکەڵەی وێنە' },
  },
  labels: {
    key: { ar: 'نوع الشارة', en: 'Badge type', ckb: 'جۆری نیشانە' },
    text: { ar: 'نص الشارة', en: 'Badge text', ckb: 'دەقی نیشانە' },
    icon: { ar: 'أيقونة الشارة', en: 'Badge icon', ckb: 'ئایکۆنی نیشانە' },
    visible: { ar: 'الشارة ظاهرة', en: 'Badge visible', ckb: 'نیشانەکە دیارە' },
  },
  spec_groups: {
    title: { ar: 'عنوان مجموعة المواصفات', en: 'Spec group title', ckb: 'ناونیشانی گرووپی تایبەتمەندی' },
  },
  'spec_groups.rows': {
    label: { ar: 'اسم البند', en: 'Row label', ckb: 'ناوی ڕیز' },
    value: { ar: 'قيمة البند', en: 'Row value', ckb: 'بەهای ڕیز' },
    unit: { ar: 'وحدة البند', en: 'Row unit', ckb: 'یەکەی ڕیز' },
  },
  warranty_plans: {
    title: { ar: 'اسم خطة الضمان', en: 'Warranty plan name', ckb: 'ناوی پلانی گەرەنتی' },
    terms: { ar: 'شروط الضمان', en: 'Warranty terms', ckb: 'مەرجەکانی گەرەنتی' },
    active: { ar: 'الخطة مفعّلة', en: 'Plan active', ckb: 'پلانەکە چالاکە' },
  },
  content_blocks: {
    kind: { ar: 'نوع الكتلة', en: 'Block kind', ckb: 'جۆری بلۆک' },
    body: { ar: 'نص الكتلة', en: 'Block text', ckb: 'دەقی بلۆک' },
    caption: { ar: 'تعليق الكتلة', en: 'Block caption', ckb: 'ڕوونکردنەوەی بلۆک' },
    alt: { ar: 'النص البديل لصورة الكتلة', en: 'Block picture alt text', ckb: 'دەقی جێگرەوەی وێنەی بلۆک' },
    url: { ar: 'رابط الكتلة', en: 'Block link', ckb: 'بەستەری بلۆک' },
  },
  usage_steps: {
    kind: { ar: 'نوع الخطوة', en: 'Step kind', ckb: 'جۆری هەنگاو' },
    title: { ar: 'عنوان الخطوة', en: 'Step title', ckb: 'ناونیشانی هەنگاو' },
    body: { ar: 'شرح الخطوة', en: 'Step text', ckb: 'دەقی هەنگاو' },
    images: { ar: 'صور الخطوة', en: 'Step pictures', ckb: 'وێنەکانی هەنگاو' },
  },
  transports: {
    active: { ar: 'الطريق مفعّل', en: 'Route active', ckb: 'ڕێگاکە چالاکە' },
  },
  'options.direct': {
    enabled: { ar: 'البيع المباشر مفعّل', en: 'Direct sale enabled', ckb: 'فرۆشتنی ڕاستەوخۆ چالاکە' },
    price_iqd: { ar: 'سعر البيع المباشر', en: 'Direct-sale price', ckb: 'نرخی فرۆشتنی ڕاستەوخۆ' },
    cost_iqd: { ar: 'كلفة البيع المباشر', en: 'Direct-sale cost', ckb: 'تێچووی فرۆشتنی ڕاستەوخۆ' },
    pro_price_iqd: { ar: 'سعر PRO للبيع المباشر', en: 'Direct-sale PRO price', ckb: 'نرخی PRO بۆ فرۆشتنی ڕاستەوخۆ' },
    prime_price_iqd: { ar: 'سعر PRIME للبيع المباشر', en: 'Direct-sale PRIME price', ckb: 'نرخی PRIME بۆ فرۆشتنی ڕاستەوخۆ' },
  },
  'options.preorder': {
    enabled: { ar: 'الطلب المسبق مفعّل', en: 'Pre-order enabled', ckb: 'پێشداواکاری چالاکە' },
    price_iqd: { ar: 'سعر الطلب المسبق', en: 'Pre-order price', ckb: 'نرخی پێشداواکاری' },
    cost_iqd: { ar: 'كلفة الطلب المسبق', en: 'Pre-order cost', ckb: 'تێچووی پێشداواکاری' },
    pro_price_iqd: { ar: 'سعر PRO للطلب المسبق', en: 'Pre-order PRO price', ckb: 'نرخی PRO بۆ پێشداواکاری' },
    prime_price_iqd: { ar: 'سعر PRIME للطلب المسبق', en: 'Pre-order PRIME price', ckb: 'نرخی PRIME بۆ پێشداواکاری' },
  },
  'options.preorder.transports': {
    enabled: { ar: 'الطريق مفعّل', en: 'Route enabled', ckb: 'ڕێگاکە چالاکە' },
    price_iqd: { ar: 'سعر طريق الشحن', en: 'Route price', ckb: 'نرخی ڕێگای ناردن' },
    cost_iqd: { ar: 'كلفة طريق الشحن', en: 'Route cost', ckb: 'تێچووی ڕێگای ناردن' },
    surcharge_iqd: { ar: 'زيادة طريق الشحن', en: 'Route surcharge', ckb: 'زیادەی ڕێگای ناردن' },
    pro_price_iqd: { ar: 'سعر PRO لطريق الشحن', en: 'Route PRO price', ckb: 'نرخی PRO بۆ ڕێگای ناردن' },
    prime_price_iqd: { ar: 'سعر PRIME لطريق الشحن', en: 'Route PRIME price', ckb: 'نرخی PRIME بۆ ڕێگای ناردن' },
  },
};

/** The membership discount's six fields (one block per tier). */
export const DATA_FILE_MEMBERSHIP_FIELDS: Record<string, Tri> = {
  discount_mode: { ar: 'نوع الخصم', en: 'Discount kind', ckb: 'جۆری داشکاندن' },
  percent: { ar: 'نسبة الخصم (%)', en: 'Discount percent', ckb: 'ڕێژەی داشکاندن (%)' },
  fixed_iqd: { ar: 'خصم ثابت (د.ع)', en: 'Fixed discount (IQD)', ckb: 'داشکاندنی جێگیر (دینار)' },
  max_discount_iqd: { ar: 'الحد الأقصى للخصم (د.ع)', en: 'Maximum discount (IQD)', ckb: 'زۆرترین داشکاندن (دینار)' },
  cap_scope: { ar: 'نطاق الحد', en: 'Cap applies to', ckb: 'مەودای سنوورەکە' },
  max_quantity: { ar: 'أقصى كمية بالخصم', en: 'Maximum discounted quantity', ckb: 'زۆرترین بڕی داشکێنراو' },
};

/** The owner's pricing leaves: the pricing screens' own words (pricingFieldLabels.ts); the minimum profit is the sheet's (in USD). */
export const DATA_FILE_PRICING_FIELDS: Record<string, Tri> = {
  supplier_cost_amount: PRICING_FIELD_LABELS.supplier_cost,
  supplier_cost_currency: PRICING_FIELD_LABELS.supplier_currency,
  supplier_cost_iqd: PRICING_FIELD_LABELS.supplier_cost_iqd,
  shipping_profile: PRICING_FIELD_LABELS.shipping_profile,
  shipping_weight_g: PRICING_FIELD_LABELS.shipping_weight_g,
  shipping_length_mm: PRICING_FIELD_LABELS.shipping_length_mm,
  shipping_width_mm: PRICING_FIELD_LABELS.shipping_width_mm,
  shipping_height_mm: PRICING_FIELD_LABELS.shipping_height_mm,
  manual_cbm: PRICING_FIELD_LABELS.manual_cbm,
  additional_cost_iqd: PRICING_FIELD_LABELS.additional_cost_iqd,
  minimum_target_profit_usd: { ar: 'الحد الأدنى للربح ($)', en: 'Minimum profit (USD)', ckb: 'کەمترین قازانج (دۆلار)' },
  direct_sale_extra_iqd: PRICING_FIELD_LABELS.direct_sale_extra_iqd,
};

/** The words for an item when the comparison carries no name for it (its group, then its number in the file). */
export const DATA_FILE_GROUP_WORDS: Record<string, Tri> = {
  options: { ar: 'الموديل', en: 'Model', ckb: 'مۆدێل' },
  colors: { ar: 'اللون', en: 'Colour', ckb: 'ڕەنگ' },
  variants: { ar: 'التركيبة', en: 'Combination', ckb: 'تێکەڵە' },
  images: { ar: 'الصورة', en: 'Picture', ckb: 'وێنە' },
  spec_groups: { ar: 'مجموعة المواصفات', en: 'Spec group', ckb: 'گرووپی تایبەتمەندی' },
  labels: { ar: 'الشارة', en: 'Badge', ckb: 'نیشانە' },
  warranty_plans: { ar: 'خطة الضمان', en: 'Warranty plan', ckb: 'پلانی گەرەنتی' },
  content_blocks: { ar: 'كتلة المحتوى', en: 'Content block', ckb: 'بلۆکی ناوەڕۆک' },
  usage_steps: { ar: 'خطوة الاستخدام', en: 'Usage step', ckb: 'هەنگاوی بەکارهێنان' },
  transports: { ar: 'طريق الشحن', en: 'Shipping route', ckb: 'ڕێگای ناردن' },
  /** A row of a spec group (`spec_groups.N.rows.M.*`), when the comparison sends no label for it. */
  spec_rows: { ar: 'البند', en: 'Row', ckb: 'ڕیز' },
  'pricing.options': PRICING_SCOPE_LABELS.option,
  'pricing.colors': PRICING_SCOPE_LABELS.color,
  'pricing.skus': PRICING_SCOPE_LABELS.sku,
  'pricing.base': PRICING_SCOPE_LABELS.base,
  spec: { ar: 'مواصفة', en: 'Specification', ckb: 'تایبەتمەندی' },
};

/** A shipping route by the method that names it (`transports[air]`): a model's pre-order route or the product's own. */
export const DATA_FILE_ROUTE_NAMES: Record<string, Tri> = {
  air: { ar: 'الطريق الجوي', en: 'Air route', ckb: 'ڕێگای ئاسمانی' },
  sea: { ar: 'الطريق البحري', en: 'Sea route', ckb: 'ڕێگای دەریایی' },
  land: { ar: 'الطريق البري', en: 'Land route', ckb: 'ڕێگای وشکانی' },
};

/** The language a `_ar` / `_en` / `_ckb` field is written in. */
export const DATA_FILE_LANG_TAGS: Record<'ar' | 'en' | 'ckb', Tri> = {
  ar: { ar: 'عربي', en: 'Arabic', ckb: 'عەرەبی' },
  en: { ar: 'إنجليزي', en: 'English', ckb: 'ئینگلیزی' },
  ckb: { ar: 'كردي', en: 'Kurdish', ckb: 'بە کوردی' },
};

/** The names the server sends with a comparison: each row's item (`group:id`), each spec field, each item inside an item. */
export interface DataFileLabels {
  items?: Record<string, Tri>;
  spec?: Record<string, Tri>;
  /** A spec group's row by its label: `spec_groups:<group id>/rows:<row id>`. */
  inner?: Record<string, Tri>;
}

/** `pricing.options.3.shipping_length_mm` → { family: 'pricing.options', leaf: 'shipping_length_mm', index: 3 } (indices stripped). */
export function keyShape(key: string): { family: string; leaf: string; index: number | null } {
  const parts = key.split('.');
  const leaf = parts[parts.length - 1] ?? key;
  let index: number | null = null;
  const family: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (/^\d+$/.test(p)) {
      if (index === null) index = Number(p);
    } else family.push(p);
  }
  return { family: family.join('.'), leaf, index };
}

const LANG_LEAF = /^(.+)_(ar|en|ckb)$/;
const withLang = (base: Tri, lang: 'ar' | 'en' | 'ckb'): Tri => ({
  ar: `${base.ar} (${DATA_FILE_LANG_TAGS[lang].ar})`,
  en: `${base.en} (${DATA_FILE_LANG_TAGS[lang].en})`,
  ckb: `${base.ckb} (${DATA_FILE_LANG_TAGS[lang].ckb})`,
});
/** A leaf in a table, or its `_ar` / `_en` / `_ckb` base there with the language. */
function inTable(table: Record<string, Tri> | undefined, leaf: string): Tri | null {
  if (!table) return null;
  if (table[leaf]) return table[leaf];
  const m = LANG_LEAF.exec(leaf);
  if (m && table[m[1]]) return withLang(table[m[1]], m[2] as 'ar' | 'en' | 'ckb');
  return null;
}

/**
 * The field a key names, in all three languages — never its raw leaf for a
 * key the data file writes (tests/productDataFileLabels.test.ts walks every
 * one): a spec field by the server's label, a pricing field by the pricing
 * screens' words, a membership field with its tier, a group's own leaf, then
 * the generic table.
 */
export function fieldLabel(key: string, labels?: DataFileLabels): Tri {
  const { family, leaf } = keyShape(key);
  if (family === 'spec') {
    const named = labels?.spec?.[leaf];
    if (named) return named;
    const w = DATA_FILE_GROUP_WORDS.spec;
    return { ar: `${w.ar} ${leaf}`, en: `${w.en} ${leaf}`, ckb: `${w.ckb} ${leaf}` };
  }
  if (family === 'pricing' || family.startsWith('pricing.')) {
    const p = DATA_FILE_PRICING_FIELDS[leaf];
    if (p) return p;
  }
  const tier = /^membership\.(pro|prime)$/.exec(family);
  if (tier) {
    const f = DATA_FILE_MEMBERSHIP_FIELDS[leaf];
    const t = tier[1].toUpperCase();
    if (f) return { ar: `${t} · ${f.ar}`, en: `${t} · ${f.en}`, ckb: `${t} · ${f.ckb}` };
  }
  return inTable(DATA_FILE_GROUP_FIELDS[family], leaf) ?? inTable(DATA_FILE_FIELDS, leaf) ?? { ar: leaf, en: leaf, ckb: leaf };
}

/** `nkey` → the item it names (`options[opt_x].name_en` → options / opt_x); null for a scalar. */
export function itemOfNkey(nkey: string): { group: string; id: string } | null {
  const m = /^((?:pricing\.)?[a-z_]+)\[([^\]]+)\]/.exec(nkey);
  return m ? { group: m[1], id: m[2] } : null;
}

/**
 * The item inside the row's item, when there is one — a model's pre-order
 * route (`options.N.preorder.transports.M.*`) or a spec group's row
 * (`spec_groups.N.rows.M.*`): two such lines of one item are two different
 * lines, and their titles say so. By the line's `nkey` when the sheet has it
 * (the route's method, the row's label the comparison sent), else by its
 * number in the file.
 */
function innerOf(key: string, nkey: string | undefined, item: { group: string; id: string }, labels: DataFileLabels | undefined, lang: string): string | null {
  const byKey = /\.(transports|rows)\.(\d+)\./.exec(key);
  const byNkey = nkey ? /\.(transports|rows)\[([^\]]+)\]/.exec(nkey) : null;
  const group = byNkey?.[1] ?? byKey?.[1];
  if (!group) return null;
  if (byNkey) {
    const id = byNkey[2];
    if (group === 'transports' && DATA_FILE_ROUTE_NAMES[id]) return pick(DATA_FILE_ROUTE_NAMES[id], lang);
    const named = labels?.inner?.[`${item.group}:${item.id}/${group}:${id}`];
    if (named && pick(named, lang)) return pick(named, lang);
  }
  const word = group === 'transports' ? DATA_FILE_GROUP_WORDS.transports : DATA_FILE_GROUP_WORDS.spec_rows;
  return byKey ? `${pick(word, lang)} ${byKey[2]}` : pick(word, lang);
}

/**
 * A row's title: «the item · the field» — the item by the name the
 * comparison sent (the model, the colour, the combination, the pricing scope),
 * else its group's word and its number in the file; an item inside it (a
 * pre-order route, a spec row) follows the item; the product's own pricing
 * block reads «the product · the field». `nkey` (the comparison's own key for
 * the line) names an inner item by its id; without it, by its number.
 */
export function rowTitle(key: string, item: { group: string; id: string } | null, labels: DataFileLabels | undefined, lang: string, nkey?: string): string {
  const field = pick(fieldLabel(key, labels), lang);
  const { family, index } = keyShape(key);
  if (family === 'pricing.base') return `${pick(DATA_FILE_GROUP_WORDS['pricing.base'], lang)} · ${field}`;
  if (!item) return field;
  const named = labels?.items?.[`${item.group}:${item.id}`];
  const word = DATA_FILE_GROUP_WORDS[item.group];
  const head =
    named && pick(named, lang)
      ? pick(named, lang)
      : item.group === 'transports' && DATA_FILE_ROUTE_NAMES[item.id]
        ? pick(DATA_FILE_ROUTE_NAMES[item.id], lang)
        : word
          ? `${pick(word, lang)}${index !== null ? ` ${index}` : ''}`
          : null;
  return [head, innerOf(key, nkey, item, labels, lang), field].filter(Boolean).join(' · ');
}

/** `{name}` placeholders, filled. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

export const pick = (t: Tri, lang: string): string => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);
