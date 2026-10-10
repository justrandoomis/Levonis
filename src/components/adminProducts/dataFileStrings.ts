/**
 * «ملف بيانات المنتج» — EVERY WORD OF THE SHEET, IN ARABIC, ENGLISH AND SORANI
 * (src/components/adminProducts/form/DataFileSheet.tsx; owner brief 2026-10-10).
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183); tests/productDataFileStrings.test.ts walks the
 * table. The refusals the server sends by code (`DATA_FILE_*`) are rendered
 * from packages/contracts/src/dataFileRefusals.ts, not from here.
 */
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

/** A line's own field, in the reader's words, for the fields an owner edits most. */
export const DATA_FILE_FIELDS: Record<string, Tri> = {
  name_ar: { ar: 'الاسم (عربي)', en: 'Name (Arabic)', ckb: 'ناو (عەرەبی)' },
  name_en: { ar: 'الاسم (إنجليزي)', en: 'Name (English)', ckb: 'ناو (ئینگلیزی)' },
  name_ckb: { ar: 'الاسم (كردي)', en: 'Name (Kurdish)', ckb: 'ناو (بە کوردی)' },
  description_ar: { ar: 'الوصف (عربي)', en: 'Description (Arabic)', ckb: 'وەسف (عەرەبی)' },
  description_en: { ar: 'الوصف (إنجليزي)', en: 'Description (English)', ckb: 'وەسف (ئینگلیزی)' },
  description_ckb: { ar: 'الوصف (كردي)', en: 'Description (Kurdish)', ckb: 'وەسف (کوردی)' },
  status: { ar: 'الحالة', en: 'Status', ckb: 'دۆخ' },
  price_iqd: { ar: 'السعر', en: 'Price', ckb: 'نرخی فرۆشتن' },
  regular_price_iqd: { ar: 'السعر', en: 'Price', ckb: 'نرخی فرۆشتن' },
  regular_adjust_iqd: { ar: 'الزيادة فوق الأساسي', en: 'Increase over the base', ckb: 'زیادە لەسەر بنەڕەت' },
  original_price_iqd: { ar: 'السعر قبل الخصم', en: 'Compare-at price', ckb: 'نرخ پێش داشکاندن' },
  product_cost_iqd: { ar: 'الكلفة', en: 'Cost', ckb: 'تێچوو' },
  cost_iqd: { ar: 'الكلفة', en: 'Cost', ckb: 'تێچوو' },
  stock: { ar: 'المخزون', en: 'Stock', ckb: 'کۆگا' },
  sku: { ar: 'رمز المنتج', en: 'SKU', ckb: 'کۆدی بەرهەم' },
  active: { ar: 'فعّال', en: 'Active', ckb: 'چالاک' },
  enabled: { ar: 'مفعّل', en: 'Enabled', ckb: 'چالاککراو' },
  hex: { ar: 'رمز اللون', en: 'Colour code', ckb: 'کۆدی ڕەنگ' },
  surcharge_iqd: { ar: 'الزيادة بالدينار', en: 'Surcharge (IQD)', ckb: 'زیادە (دینار)' },
  remove: { ar: 'حذف', en: 'Remove', ckb: 'لابردنی بڕگە' },
  package_weight_g: { ar: 'وزن الطرد (غ)', en: 'Package weight (g)', ckb: 'کێشی پاکێت (گ)' },
  supplier_cost_amount: { ar: 'كلفة المورّد', en: 'Supplier cost', ckb: 'تێچووی دابینکەر' },
  supplier_cost_currency: { ar: 'عملة المورّد', en: 'Supplier currency', ckb: 'دراوی دابینکەر' },
  supplier_cost_iqd: { ar: 'كلفة المورّد بالدينار', en: 'Supplier cost in IQD', ckb: 'تێچووی دابینکەر بە دینار' },
  shipping_profile: { ar: 'طريق الشحن', en: 'Shipping route', ckb: 'ڕێگای ناردن' },
  shipping_weight_g: { ar: 'وزن الشحن (غ)', en: 'Shipping weight (g)', ckb: 'کێشی ناردن (گ)' },
  additional_cost_iqd: { ar: 'كلفة إضافية للقطعة', en: 'Additional cost per piece', ckb: 'تێچووی زیادە بۆ هەر پارچەیەک' },
  minimum_target_profit_usd: { ar: 'الحد الأدنى للربح ($)', en: 'Minimum profit (USD)', ckb: 'کەمترین قازانج (دۆلار)' },
  direct_sale_extra_iqd: { ar: 'زيادة البيع المباشر', en: 'Direct Sale Extra', ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ' },
};

/** `{name}` placeholders, filled. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

export const pick = (t: Tri, lang: string): string => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);
