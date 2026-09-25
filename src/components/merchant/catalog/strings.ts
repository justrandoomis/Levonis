/**
 * The catalogue editor's words, and the pure decisions about them.
 *
 * SORANI IS NEVER MACHINE-WRITTEN (docs/DECISIONS.md row 11). Where the old
 * products manager (the pre-W2-F src/components/merchant/dashboard/
 * ProductsManager.tsx) already carried a hand-written Sorani word for the SAME
 * thing, it is reused verbatim — «بەرهەمی نوێ», «ڕەشنووس», «شاراوە»,
 * «ئەرشیڤ», «کۆگا», «نرخ», «پاشەکەوت»… Everything else passes only Arabic
 * and English (`loc` falls back to the Arabic) and is marked
 * `// OWNER: Sorani to be written by hand.`
 */
import type { PublishState } from './catalogApi';

export type Loc = (ar: string, en: string, ckb?: string) => string;

export function catalogStrings(loc: Loc) {
  return {
    products: loc('المنتجات', 'Products', 'بەرهەمەکان'),
    newProduct: loc('منتج جديد', 'New product', 'بەرهەمی نوێ'),
    editProduct: loc('تعديل المنتج', 'Edit product', 'دەستکاری بەرهەم'),
    search: loc('بحث بالاسم أو رمز SKU…', 'Search by name or SKU…'), // OWNER: Sorani to be written by hand.
    importExport: loc('استيراد / تصدير', 'Import / export', 'هاوردە / هەناردە'),
    exportCsv: loc('تصدير المنتجات CSV', 'Export products CSV', 'هەناردەی CSV'),
    importCsv: loc('استيراد من CSV', 'Import from CSV', 'هاوردە لە CSV'),
    refresh: loc('تحديث البيانات', 'Refresh', 'نوێکردنەوە'),
    exportFailed: loc('تعذّر التصدير — حاول مجددًا.', 'Export failed — try again.', 'هەناردە سەرنەکەوت.'),
    exportTruncated: (n: string) => loc(`الملف يحمل أول 2000 منتج من أصل ${n}.`, `The file carries the first 2000 of ${n} products.`, `2000 لە ${n}`),
    cannotSell: loc(
      'لا يمكن نشر منتجات جديدة الآن. منتجاتك الحالية وسجلها محفوظة.',
      'New products cannot be published right now. Your existing products and their history are kept.',
      'ناتوانیت بەرهەمی نوێ بڵاو بکەیتەوە.'
    ),
    noProducts: loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە'),
    noProductsHint: loc('أضف منتجك الأول: الاسم والسعر والصورة تكفي للبدء.', 'Add your first product: a name, a price and a photo are enough to start.'), // OWNER: Sorani to be written by hand.
    noMatch: loc('لا نتائج مطابقة للتصفية', 'Nothing matches these filters', 'هیچ ئەنجامێک نییە'),
    loadMore: loc('عرض المزيد', 'Show more'), // OWNER: Sorani to be written by hand.
    shownOf: (a: number, b: number) => loc(`${a} من ${b}`, `${a} of ${b}`), // OWNER: Sorani to be written by hand.

    // columns
    product: loc('المنتج', 'Product', 'بەرهەم'),
    price: loc('السعر', 'Price', 'نرخ'),
    stock: loc('المخزون', 'Stock', 'کۆگا'),
    status: loc('الحالة', 'Status', 'دۆخ'),
    sales: loc('المبيعات', 'Sales', 'فرۆش'),
    views: loc('المشاهدات', 'Views', 'بینین'),

    // filters
    all: loc('الكل', 'All'), // OWNER: Sorani to be written by hand.
    stateFilter: loc('حالة النشر', 'Publish status', 'دۆخی بڵاوکردنەوە'),
    allStock: loc('كل المخزون', 'All stock', 'هەموو کۆگا'),
    inStock: loc('متوفر', 'In stock', 'بەردەست'),
    lowStock: loc('مخزون منخفض', 'Low stock'), // OWNER: Sorani to be written by hand.
    outOfStock: loc('نفد المخزون', 'Out of stock', 'تەواو بوو'),
    untracked: loc('غير متتبع', 'Untracked', 'بەدوادانەچوو'),
    sort: loc('الترتيب', 'Sort'), // OWNER: Sorani to be written by hand.
    sortNewest: loc('الأحدث', 'Newest', 'نوێترین'),
    sortOldest: loc('الأقدم', 'Oldest', 'کۆنترین'),
    sortUpdated: loc('آخر تحديث', 'Last updated', 'دوایین نوێکردنەوە'),
    sortPriceAsc: loc('السعر: من الأقل', 'Price: low→high', 'نرخ ↑'),
    sortPriceDesc: loc('السعر: من الأعلى', 'Price: high→low', 'نرخ ↓'),
    sortSales: loc('الأكثر مبيعًا', 'Best selling', 'زۆرترین فرۆش'),
    sortViews: loc('الأكثر مشاهدة', 'Most viewed', 'زۆرترین بینین'),
    sortStock: loc('المخزون الأقل', 'Lowest stock', 'کەمترین کۆگا'),
    collectionFilter: loc('المجموعة', 'Collection'), // OWNER: Sorani to be written by hand.
    allCollections: loc('كل المجموعات', 'All collections'), // OWNER: Sorani to be written by hand.
    noCollection: loc('بلا مجموعة', 'In no collection'), // OWNER: Sorani to be written by hand.

    // states
    state: (s: PublishState) =>
      s === 'published' ? loc('منشور', 'Published') // OWNER: Sorani to be written by hand.
        : s === 'draft' ? loc('مسودة', 'Draft', 'ڕەشنووس')
          : s === 'hidden' ? loc('مخفي', 'Hidden', 'شاراوە')
            : loc('مؤرشف', 'Archived', 'ئەرشیڤ'),
    stateHint: (s: PublishState) =>
      s === 'published' ? loc('ظاهر في متجرك ويمكن شراؤه.', 'On your storefront and buyable.') // OWNER: Sorani to be written by hand.
        : s === 'draft' ? loc('لا يراه أحد غيرك حتى تنشره.', 'Nobody but you sees it until you publish.') // OWNER: Sorani to be written by hand.
          : s === 'hidden' ? loc('أُخفي من المتجر؛ رابطه لا يعمل للزبائن.', 'Off the storefront; its link does not open for customers.') // OWNER: Sorani to be written by hand.
            : loc('خارج المتجر ومحفوظ لسجل الطلبات.', 'Off the storefront, kept for order history.'), // OWNER: Sorani to be written by hand.
    soldOut: loc('نفد', 'Sold out', 'تەواو بوو'),
    // Owner decision 2026-09-25: a published product at 0 IQD is not for sale.
    priceRequired: loc('بلا سعر — لا يُباع', 'No price — not for sale'), // OWNER: Sorani to be written by hand.
    priceRequiredHint: loc(
      'هذا المنتج منشور لكن سعره (أو سعر أحد أنواعه المفعّلة) صفر، فلا يمكن للزبائن شراؤه. اكتب سعرًا أكبر من صفر ثم احفظ.',
      'This product is published but its price (or an active variant’s) is 0, so customers cannot buy it. Enter a price above 0, then save.'
    ), // OWNER: Sorani to be written by hand.
    hiddenByAdmin: loc('أخفته Levonis', 'Hidden by Levonis'), // OWNER: Sorani to be written by hand.
    hiddenByAdminHint: (reason: string) =>
      loc(
        `أخفت Levonis هذا المنتج${reason ? `: «${reason}»` : ''}. لا يمكنك نشره حتى تُرفع المراجعة؛ يمكنك تعديله.`,
        `Levonis hid this product${reason ? `: “${reason}”` : ''}. You cannot publish it until the review is lifted; you can still edit it.`
      ), // OWNER: Sorani to be written by hand.
    variantsCount: (n: number) => loc(`${n} نوع`, n === 1 ? '1 variant' : `${n} variants`), // OWNER: Sorani to be written by hand.
    legacyChoices: loc('خيارات قديمة', 'Old-style options'), // OWNER: Sorani to be written by hand.

    // row actions
    edit: loc('تعديل', 'Edit', 'دەستکاری'),
    duplicate: loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە'),
    insights: loc('تحليلات', 'Insights', 'شیکاری'),
    openInStore: loc('فتح في المتجر', 'Open in storefront', 'کردنەوە لە فرۆشگا'),
    publish: loc('نشر في المتجر', 'Publish to store', 'بڵاوکردنەوە'),
    hide: loc('إخفاء من المتجر', 'Hide from store', 'شاردنەوە'),
    toDraft: loc('إرجاع إلى مسودة', 'Move to drafts'), // OWNER: Sorani to be written by hand.
    archive: loc('أرشفة', 'Archive'), // OWNER: Sorani to be written by hand.
    remove: loc('حذف', 'Delete', 'سڕینەوە'),
    feature: loc('تمييز المنتج', 'Feature product', 'تایبەتکردن'),
    unfeature: loc('إلغاء التمييز', 'Unfeature', 'لابردنی تایبەت'),
    duplicated: loc('نُسخ المنتج كمسودة.', 'Duplicated as a draft.'), // OWNER: Sorani to be written by hand.
    deleteTitle: (name: string) => loc(`حذف «${name}»؟`, `Delete “${name}”?`), // OWNER: Sorani to be written by hand.
    deleteConsequence: loc(
      'يُحذف نهائيًا إن لم يُطلب من قبل. إن كان في طلبات سابقة يُؤرشف بدل الحذف ويبقى سجل الطلبات كما هو.',
      'It is deleted for good if nobody ever ordered it. If it is in past orders it is archived instead, and the order history stays as it is.'
    ), // OWNER: Sorani to be written by hand.
    archivedInstead: loc(
      'تم أرشفة المنتج لأنه مرتبط بطلبات سابقة. لن يظهر في متجرك، وسجل الطلبات يبقى كما هو.',
      'The product was archived because it belongs to past orders. It is off your storefront and the order history is unchanged.',
      'بەرهەمەکە ئەرشیڤ کرا چونکە پەیوەندی بە داواکاری پێشووەکانەوە هەیە.'
    ),
    deleted: loc('حُذف المنتج.', 'Product deleted.'), // OWNER: Sorani to be written by hand.

    // bulk
    selected: (n: number) => loc(`${n} محدد`, `${n} selected`), // OWNER: Sorani to be written by hand.
    bulkMore: loc('إجراءات أخرى', 'More actions'), // OWNER: Sorani to be written by hand.
    setPrice: loc('تعيين السعر', 'Set price'), // OWNER: Sorani to be written by hand.
    setStock: loc('تعيين المخزون', 'Set stock'), // OWNER: Sorani to be written by hand.
    addToCollection: loc('إضافة إلى مجموعة', 'Add to collection'), // OWNER: Sorani to be written by hand.
    removeFromCollection: loc('إزالة من مجموعة', 'Remove from collection'), // OWNER: Sorani to be written by hand.
    bulkDeleteTitle: (n: number) => loc(`حذف ${n} منتج؟`, `Delete ${n} products?`), // OWNER: Sorani to be written by hand.
    bulkDeleteConsequence: loc(
      'يُحذف ما لم يُطلب قط. ما له طلبات سابقة لا يُحذف — أرشفه بدلًا من ذلك.',
      'Products nobody ever ordered are deleted. Products with past orders are not — archive those instead.'
    ), // OWNER: Sorani to be written by hand.
    bulkDone: (done: number, total: number) => loc(`تم على ${done} من ${total}.`, `Done for ${done} of ${total}.`), // OWNER: Sorani to be written by hand.
    apply: loc('تطبيق', 'Apply'), // OWNER: Sorani to be written by hand.
    cancel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
    chooseCollection: loc('اختر المجموعة', 'Choose a collection'), // OWNER: Sorani to be written by hand.

    // editor
    basics: loc('الأساسيات', 'Basics'), // OWNER: Sorani to be written by hand.
    name: loc('الاسم', 'Name', 'ناو'),
    priceIqd: loc('السعر (د.ع)', 'Price (IQD)', 'نرخ'),
    compareAt: loc('السعر قبل الخصم', 'Original price', 'نرخی پێشوو'),
    compareAtHint: loc('يظهر مشطوبًا كخصم', 'Shown struck-through as a deal', 'وەک داشکاندن'),
    trackStock: loc('تتبّع المخزون', 'Track stock'), // OWNER: Sorani to be written by hand.
    trackStockHint: loc('عند الصفر يظهر «نفد» ولا يمكن شراؤه.', 'At zero it shows as sold out and cannot be bought.'), // OWNER: Sorani to be written by hand.
    quantity: loc('الكمية المتوفرة', 'Quantity on hand'), // OWNER: Sorani to be written by hand.
    visibility: loc('الظهور', 'Visibility'), // OWNER: Sorani to be written by hand.
    save: loc('حفظ', 'Save', 'پاشەکەوت'),
    saveDraft: loc('حفظ كمسودة', 'Save as draft'), // OWNER: Sorani to be written by hand.
    saved: loc('حُفظ المنتج.', 'Product saved.'), // OWNER: Sorani to be written by hand.
    saveFailed: loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت'),
    fixErrors: (n: number) => loc(`راجع ${n} حقل قبل الحفظ.`, n === 1 ? 'Check 1 field before saving.' : `Check ${n} fields before saving.`), // OWNER: Sorani to be written by hand.
    loadFailed: loc('تعذّر التحميل', 'Could not load', 'بارنەبوو'),
    unsaved: loc('لديك تعديلات غير محفوظة.', 'You have unsaved changes.'), // OWNER: Sorani to be written by hand.

    sectionVariants: loc('الخيارات والأنواع', 'Options & variants'), // OWNER: Sorani to be written by hand.
    sectionVariantsHint: loc('مقاسات أو ألوان أو خامات، لكل نوع سعره ومخزونه.', 'Sizes, colours or materials — each variant with its own price and stock.'), // OWNER: Sorani to be written by hand.
    sectionPricing: loc('التسعير والمخزون', 'Pricing & inventory'), // OWNER: Sorani to be written by hand.
    sectionDetails: loc('الوصف والتصنيف', 'Description & category'), // OWNER: Sorani to be written by hand.
    sectionPrint: loc('تفاصيل الطباعة ثلاثية الأبعاد', '3D-printing details'), // OWNER: Sorani to be written by hand.
    sectionPrintHint: loc('الخامة والتقنية واللون والتشطيب والأبعاد والوزن.', 'Material, technology, colour, finish, size and weight.'), // OWNER: Sorani to be written by hand.
    sectionCollections: loc('المجموعات', 'Collections'), // OWNER: Sorani to be written by hand.
    sectionMedia: loc('الصور والفيديو', 'Photos & video'), // OWNER: Sorani to be written by hand.

    sku: loc('رمز المنتج (SKU)', 'SKU'), // OWNER: Sorani to be written by hand.
    lowStockAt: loc('نبّهني عندما يصل المخزون إلى', 'Alert me when stock reaches'), // OWNER: Sorani to be written by hand.
    lowStockAtHint: loc('تصلك رسالة مرة واحدة عند النزول تحت هذا الحد.', 'You get one notice when stock drops to this line.'), // OWNER: Sorani to be written by hand.
    description: loc('الوصف', 'Description', 'وەسف'),
    category: loc('الفئة', 'Category', 'پۆل'),
    condition: loc('الحالة', 'Condition', 'دۆخ'),
    condNew: loc('جديد', 'New', 'نوێ'),
    condUsed: loc('مستعمل', 'Used', 'بەکارهاتوو'),
    condRefurb: loc('مجدّد', 'Refurbished', 'نوێکراوە'),
    prepDays: loc('أيام التحضير', 'Prep days', 'ڕۆژی ئامادەکردن'),
    featured: loc('منتج مميّز — يتصدّر واجهة متجرك', 'Featured — pinned to the top of your shop', 'بەرهەمی تایبەت'),

    material: loc('الخامة', 'Material'), // OWNER: Sorani to be written by hand.
    technology: loc('تقنية الطباعة', 'Print technology'), // OWNER: Sorani to be written by hand.
    printColor: loc('لون الطباعة', 'Print colour'), // OWNER: Sorani to be written by hand.
    finish: loc('التشطيب', 'Finish'), // OWNER: Sorani to be written by hand.
    dimensions: loc('الأبعاد (مم)', 'Dimensions (mm)'), // OWNER: Sorani to be written by hand.
    width: loc('العرض', 'Width'), // OWNER: Sorani to be written by hand.
    depth: loc('العمق', 'Depth'), // OWNER: Sorani to be written by hand.
    height: loc('الارتفاع', 'Height'), // OWNER: Sorani to be written by hand.
    weight: loc('الوزن (غ)', 'Weight (g)'), // OWNER: Sorani to be written by hand.
    notStated: loc('غير محدد', 'Not stated'), // OWNER: Sorani to be written by hand.

    // media
    addPhoto: loc('إضافة صورة', 'Add photo'), // OWNER: Sorani to be written by hand.
    addVideo: loc('إضافة فيديو', 'Add video'), // OWNER: Sorani to be written by hand.
    uploading: loc('جارٍ الرفع…', 'Uploading…'), // OWNER: Sorani to be written by hand.
    mediaHint: loc('حتى 12 ملفًا، منها فيديوان (MP4 أو WebM حتى 40 ميغابايت). الأول هو صورة الغلاف.', 'Up to 12 files, 2 of them video (MP4 or WebM up to 40 MB). The first is the cover.'), // OWNER: Sorani to be written by hand.
    altText: loc('وصف للصورة (لقارئ الشاشة)', 'Description (for screen readers)'), // OWNER: Sorani to be written by hand.
    moveEarlier: loc('تقديم', 'Move earlier'), // OWNER: Sorani to be written by hand.
    moveLater: loc('تأخير', 'Move later'), // OWNER: Sorani to be written by hand.
    removeMedia: loc('إزالة', 'Remove'), // OWNER: Sorani to be written by hand.
    cover: loc('الغلاف', 'Cover'), // OWNER: Sorani to be written by hand.
    video: loc('فيديو', 'Video'), // OWNER: Sorani to be written by hand.
    imageTypeWrong: loc('اختر صورة JPEG أو PNG أو WebP أو GIF.', 'Choose a JPEG, PNG, WebP or GIF image.', 'وێنەیەکی JPEG یان PNG یان WebP یان GIF هەڵبژێرە.'),
    videoTypeWrong: loc('اختر فيديو MP4 أو WebM.', 'Choose an MP4 or WebM video.'), // OWNER: Sorani to be written by hand.
    videoTooBig: loc('الفيديو أكبر من 40 ميغابايت.', 'That video is larger than 40 MB.'), // OWNER: Sorani to be written by hand.
    uploadFailed: loc('تعذّر رفع الملف.', 'Could not upload the file.'), // OWNER: Sorani to be written by hand.

    // variants
    addOptionGroup: loc('إضافة خيار', 'Add an option'), // OWNER: Sorani to be written by hand.
    optionName: loc('اسم الخيار', 'Option name'), // OWNER: Sorani to be written by hand.
    optionNamePlaceholder: loc('مثل: المقاس', 'e.g. Size'), // OWNER: Sorani to be written by hand.
    optionIsColour: loc('خيار ألوان (يظهر كدوائر ملوّنة)', 'Colour option (shown as swatches)'), // OWNER: Sorani to be written by hand.
    values: loc('القيم', 'Values'), // OWNER: Sorani to be written by hand.
    addValue: loc('أضف قيمة ثم Enter', 'Add a value, then Enter'), // OWNER: Sorani to be written by hand.
    swatch: loc('لون الدائرة', 'Swatch'), // OWNER: Sorani to be written by hand.
    noSwatch: loc('بلا لون', 'No swatch'), // OWNER: Sorani to be written by hand.
    removeOption: loc('حذف الخيار', 'Remove option'), // OWNER: Sorani to be written by hand.
    removeValue: (v: string) => loc(`حذف «${v}»`, `Remove “${v}”`), // OWNER: Sorani to be written by hand.
    variantsTable: loc('الأنواع', 'Variants'), // OWNER: Sorani to be written by hand.
    variantsHint: loc('السعر الفارغ يعني سعر المنتج. أوقف نوعًا لا تبيعه.', 'An empty price means the product price. Switch off a combination you do not sell.'), // OWNER: Sorani to be written by hand.
    sellThis: (label: string) => loc(`بيع ${label}`, `Sell ${label}`), // OWNER: Sorani to be written by hand.
    setAllPrice: loc('سعر للكل', 'Price for all'), // OWNER: Sorani to be written by hand.
    setAllStock: loc('مخزون للكل', 'Stock for all'), // OWNER: Sorani to be written by hand.
    variantImage: loc('صورة النوع', 'Variant photo'), // OWNER: Sorani to be written by hand.
    productPrice: loc('سعر المنتج', 'Product price'), // OWNER: Sorani to be written by hand.
    stockFromVariants: loc('المخزون يُحسب من الأنواع.', 'Stock is the sum of the variants.'), // OWNER: Sorani to be written by hand.
    tooManyCombos: (n: number, max: number) =>
      loc(`${n} تركيبة — الحد ${max}. قلّل القيم.`, `${n} combinations — the limit is ${max}. Use fewer values.`), // OWNER: Sorani to be written by hand.
    maxGroups: loc('ثلاثة خيارات كحد أقصى.', 'Three options at most.'), // OWNER: Sorani to be written by hand.
    legacyTitle: loc('خيارات بالطريقة القديمة', 'Options in the old format'), // OWNER: Sorani to be written by hand.
    legacyBody: loc(
      'هذا المنتج ما زال يُباع بخياراته القديمة (بلا مخزون أو سعر لكل خيار). حوّله إلى أنواع لتحدد مخزون كل واحد منها.',
      'This product still sells with its old options (no stock or price per choice). Convert it to variants to set each one’s stock.'
    ), // OWNER: Sorani to be written by hand.
    legacyConvert: loc('تحويل إلى أنواع', 'Convert to variants'), // OWNER: Sorani to be written by hand.
    legacyConvertHint: loc('راجع مخزون كل نوع قبل الحفظ — لن نقسم مخزونك نيابةً عنك.', 'Check each variant’s stock before saving — we will not split your stock for you.'), // OWNER: Sorani to be written by hand.
    legacyUnreadable: loc('تعذّرت قراءة الخيارات القديمة. أنشئ الخيارات من جديد.', 'The old options could not be read. Create the options again.'), // OWNER: Sorani to be written by hand.

    // collections (editor + manager)
    noCollections: loc('لا توجد مجموعات بعد. أنشئها من تبويب «الأقسام».', 'No collections yet. Create them in the Sections tab.'), // OWNER: Sorani to be written by hand.

    // insights
    insightsTitle: (name: string) => loc(`تحليلات «${name}»`, `Insights — ${name}`), // OWNER: Sorani to be written by hand.
    unitsSold: loc('القطع المبيعة', 'Units sold', 'فرۆشراو'),
    revenue: loc('الإيراد (بدون الملغاة)', 'Revenue (non-cancelled)', 'داهات'),
    orders: loc('عدد الطلبات', 'Orders', 'داواکاری'),
    byVariant: loc('حسب النوع', 'By variant'), // OWNER: Sorani to be written by hand.
    last30: loc('آخر 30 يومًا', 'Last 30 days', '٣٠ ڕۆژ'),
    viewsCounter: loc('عدّاد المشاهدات منذ الإنشاء', 'View counter since creation'), // OWNER: Sorani to be written by hand.
    noSalesYet: loc('لا مبيعات بعد.', 'No sales yet.'), // OWNER: Sorani to be written by hand.

    // import
    importTitle: loc('استيراد منتجات من CSV', 'Import products from CSV', 'هاوردەکردن لە CSV'),
    importLead: loc(
      'نفحص الملف أولًا ولا نحفظ شيئًا حتى تؤكد. تُضاف المنتجات كمسودات؛ الصفوف التي تحمل نفس «handle» تصبح أنواع منتج واحد.',
      'We check the file first and save nothing until you confirm. Products arrive as drafts; rows sharing a “handle” become one product’s variants.'
    ), // OWNER: Sorani to be written by hand.
    chooseFile: loc('اختر ملف CSV', 'Choose CSV file', 'فایل هەڵبژێرە'),
    downloadTemplate: loc('تنزيل القالب', 'Download template', 'داگرتنی قاڵب'),
    check: loc('فحص الملف', 'Check the file'), // OWNER: Sorani to be written by hand.
    importN: (n: number) => loc(`استيراد ${n} منتج كمسودات`, n === 1 ? 'Import 1 product as a draft' : `Import ${n} products as drafts`), // OWNER: Sorani to be written by hand.
    importDone: (n: number) => loc(`أُضيف ${n} منتج كمسودات.`, `${n} products added as drafts.`), // OWNER: Sorani to be written by hand.
    importSummary: (valid: number, invalid: number) =>
      loc(`${valid} منتج جاهز · ${invalid} صف فيه خطأ`, `${valid} products ready · ${invalid} rows with errors`), // OWNER: Sorani to be written by hand.
    row: (n: number) => loc(`الصف ${n}`, `Row ${n}`), // OWNER: Sorani to be written by hand.
    importFailed: loc('تعذّر التنفيذ', 'Import failed', 'سەرنەکەوت'),
  };
}

export type CatalogStrings = ReturnType<typeof catalogStrings>;

/** The merchant's sentence for a field error code the server listed (PRODUCT_INVALID / CSV_*). */
export function fieldErrorText(code: string, loc: Loc): string {
  const c = code.replace(/^CSV_/, '');
  switch (c) {
    case 'NAME_INVALID': return loc('اكتب اسمًا من حرفين إلى 120 حرفًا.', 'Write a name of 2 to 120 characters.'); // OWNER: Sorani to be written by hand.
    case 'PRICE_INVALID':
    case 'VARIANT_PRICE_INVALID': return loc('السعر رقم صحيح بالدينار، صفر أو أكثر.', 'A price is a whole number of dinars, zero or more.'); // OWNER: Sorani to be written by hand.
    case 'STOCK_INVALID':
    case 'VARIANT_STOCK_INVALID': return loc('المخزون رقم صحيح، صفر أو أكثر.', 'Stock is a whole number, zero or more.'); // OWNER: Sorani to be written by hand.
    case 'STOCK_REQUIRED': return loc('حدد المخزون للمنتج بعد إزالة الأنواع.', 'Set the product’s stock now that it has no variants.'); // OWNER: Sorani to be written by hand.
    case 'ATTRIBUTE_INVALID': return loc('قيمة غير مقبولة.', 'This value is not accepted.'); // OWNER: Sorani to be written by hand.
    case 'MEDIA_NOT_OWNED':
    case 'MEDIA_INVALID': return loc('ملف لم يُرفع من حسابك. ارفعه من جديد.', 'A file that was not uploaded from your account. Upload it again.'); // OWNER: Sorani to be written by hand.
    case 'MEDIA_TOO_MANY': return loc('12 ملفًا كحد أقصى.', '12 files at most.'); // OWNER: Sorani to be written by hand.
    case 'MEDIA_TOO_MANY_VIDEOS': return loc('فيديوان كحد أقصى.', 'Two videos at most.'); // OWNER: Sorani to be written by hand.
    case 'MEDIA_DUPLICATE': return loc('الملف نفسه مرتين.', 'The same file twice.'); // OWNER: Sorani to be written by hand.
    case 'COLLECTION_INVALID':
    case 'COLLECTION_NOT_FOUND':
    case 'COLLECTION_UNKNOWN': return loc('مجموعة غير موجودة في متجرك.', 'A collection your store does not have.'); // OWNER: Sorani to be written by hand.
    case 'OPTION_NAME_INVALID': return loc('اكتب اسم الخيار.', 'Name the option.'); // OWNER: Sorani to be written by hand.
    case 'OPTION_NAME_DUPLICATE':
    case 'OPTION_NAME_MISMATCH': return loc('اسم خيار مكرر أو غير مطابق.', 'An option name repeated or not matching.'); // OWNER: Sorani to be written by hand.
    case 'OPTION_VALUES_EMPTY':
    case 'OPTION_VALUE_MISSING': return loc('أضف قيمة واحدة على الأقل.', 'Add at least one value.'); // OWNER: Sorani to be written by hand.
    case 'OPTION_VALUE_DUPLICATE': return loc('قيمة مكررة.', 'A repeated value.'); // OWNER: Sorani to be written by hand.
    case 'OPTION_VALUES_TOO_MANY': return loc('30 قيمة كحد أقصى.', '30 values at most.'); // OWNER: Sorani to be written by hand.
    case 'OPTION_GROUPS_TOO_MANY': return loc('ثلاثة خيارات كحد أقصى.', 'Three options at most.'); // OWNER: Sorani to be written by hand.
    case 'VARIANTS_EMPTY': return loc('فعّل نوعًا واحدًا على الأقل.', 'Switch on at least one variant.'); // OWNER: Sorani to be written by hand.
    case 'VARIANTS_TOO_MANY': return loc('100 نوع كحد أقصى.', '100 variants at most.'); // OWNER: Sorani to be written by hand.
    case 'VARIANT_DUPLICATE': return loc('نوع مكرر.', 'A repeated variant.'); // OWNER: Sorani to be written by hand.
    case 'VARIANT_SKU_INVALID': return loc('رمز SKU حتى 64 حرفًا.', 'An SKU of up to 64 characters.'); // OWNER: Sorani to be written by hand.
    case 'VARIANT_IMAGE_INVALID': return loc('صورة النوع يجب أن تكون من صور المنتج.', 'A variant photo must be one of the product’s photos.'); // OWNER: Sorani to be written by hand.
    case 'VARIANT_THRESHOLD_INVALID':
    case 'FIELD_INVALID': return loc('قيمة غير صحيحة.', 'This value is not valid.'); // OWNER: Sorani to be written by hand.
    case 'STATE_INVALID': return loc('حالة غير معروفة.', 'An unknown state.'); // OWNER: Sorani to be written by hand.
    case 'HANDLE_DUPLICATE': return loc('handle نفسه لمنتجين مختلفين.', 'The same handle on two different products.'); // OWNER: Sorani to be written by hand.
    case 'VALUES_INVALID':
    case 'VARIANT_VALUES_INVALID': return loc('نوع لا يطابق الخيارات.', 'A variant that does not match the options.'); // OWNER: Sorani to be written by hand.
    default: return loc('قيمة غير صحيحة.', 'This value is not valid.'); // OWNER: Sorani to be written by hand.
  }
}

/** The merchant's sentence for a whole-request refusal code on a catalogue action. */
export function catalogRefusalText(code: string | undefined, loc: Loc, fallback: string): string {
  switch (code) {
    case 'PRODUCT_HIDDEN_BY_ADMIN': return loc('أخفته Levonis؛ لا يمكن نشره حتى تُرفع المراجعة.', 'Hidden by Levonis — it cannot be published until the review is lifted.'); // OWNER: Sorani to be written by hand.
    case 'PRODUCT_NOT_PUBLISHABLE': return loc('لا يوجد نوع مفعّل للبيع؛ فعّل نوعًا ثم انشر.', 'No variant is switched on for sale — switch one on, then publish.'); // OWNER: Sorani to be written by hand.
    case 'PRODUCT_PRICE_REQUIRED': return loc('المنتج المنشور يحتاج سعرًا أكبر من صفر، وكذلك كل نوع مفعّل.', 'A published product needs a price above 0 — and so does every active variant.'); // OWNER: Sorani to be written by hand.
    case 'VARIANTS_HAVE_OWN_STOCK': return loc('له أنواع بمخزون خاص؛ عدّله من المنتج.', 'It has variants with their own stock — edit it in the product.'); // OWNER: Sorani to be written by hand.
    case 'PRODUCT_HAS_ORDERS': return loc('له طلبات سابقة؛ أرشفه بدل الحذف.', 'It has past orders — archive it instead.'); // OWNER: Sorani to be written by hand.
    case 'NOT_FOUND': return loc('لم يعد موجودًا.', 'It no longer exists.'); // OWNER: Sorani to be written by hand.
    case 'STORE_SUSPENDED':
    case 'SELLING_DISABLED': return loc('البيع موقوف في متجرك الآن.', 'Selling is paused in your store right now.'); // OWNER: Sorani to be written by hand.
    case 'CSV_HEADER': return loc('الملف يحتاج عمودي name و price_iqd على الأقل.', 'The file needs at least the name and price_iqd columns.'); // OWNER: Sorani to be written by hand.
    case 'CSV_TOO_BIG': return loc('200 منتج (1000 صف) في كل استيراد كحد أقصى.', 'Up to 200 products (1000 rows) per import.'); // OWNER: Sorani to be written by hand.
    case 'CSV_EMPTY': return loc('الملف بلا صفوف بيانات.', 'The file has no data rows.'); // OWNER: Sorani to be written by hand.
    case 'COLLECTION_KIND_EXISTS': return loc('هذه المجموعة التلقائية موجودة في متجرك.', 'Your store already has this automatic collection.'); // OWNER: Sorani to be written by hand.
    case 'COLLECTIONS_LIMIT': return loc('30 مجموعة كحد أقصى.', '30 collections at most.'); // OWNER: Sorani to be written by hand.
    case 'COLLECTION_NAME_INVALID': return loc('اكتب اسمًا بلا الرمز «|».', 'Write a name without the “|” character.'); // OWNER: Sorani to be written by hand.
    case 'COLLECTION_COMPUTED': return loc('هذه مجموعة تلقائية؛ منتجاتها تُحسب ولا تُرتب يدويًا.', 'This collection is automatic — its products are computed, not arranged.'); // OWNER: Sorani to be written by hand.
    case 'RATE_LIMITED': return loc('محاولات كثيرة؛ انتظر قليلًا ثم أعد.', 'Too many attempts — wait a moment, then try again.'); // OWNER: Sorani to be written by hand.
    default: return fallback;
  }
}

/** Tone of a state chip — one mapping, used by the list and the editor. */
export function stateTone(s: PublishState, hiddenByAdmin: boolean): 'success' | 'warning' | 'neutral' | 'danger' {
  if (hiddenByAdmin) return 'danger';
  return s === 'published' ? 'success' : s === 'draft' ? 'warning' : 'neutral';
}
