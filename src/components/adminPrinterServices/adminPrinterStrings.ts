/**
 * The words of the printer's «خدمات الطابعة» panel (phase 4 redesign, DECISIONS row 355), in
 * Arabic, English and Sorani Kurdish. Imported only by the panel's own files, so they ride in the
 * lazy admin chunk with it.
 *
 * Rule of the redesign (owner, 2026-11-18): a printer's page never names another printer. The
 * delivery classes are therefore said by SIZE, not by the printers that happen to sit in them, and
 * anything the panel counts on other printers is counted, never listed.
 */
import { unitDiscount, type DeliveryClass, type PrinterDiscount, type WarrantyFamily } from '../../../packages/pricing/src/printerServices';

export type Loc = (ar: string, en: string, ckb: string) => string;
export type Tri = readonly [ar: string, en: string, ckb: string];
export const say = (loc: Loc, t: Tri) => loc(t[0], t[1], t[2]);

/** The warranty families keep their series names: they are what the owner prices by. */
export const FAMILY_LABEL: Record<WarrantyFamily, string> = { a1: 'A1', xpa2: 'X / P / A2', h2: 'H2', h3c: 'H3C' };

/** A delivery class by the size of the box — never by the printers in it. */
export const CLASS_LABEL: Record<DeliveryClass, Tri> = {
  d1: ['الفئة 1 · صندوق صغير', 'Class 1 · small box', 'پۆلی 1 · سندووقی بچووک'],
  d2: ['الفئة 2 · صندوق متوسط', 'Class 2 · medium box', 'پۆلی 2 · سندووقی مامناوەند'],
  d3: ['الفئة 3 · صندوق كبير', 'Class 3 · large box', 'پۆلی 3 · سندووقی گەورە'],
  d4: ['الفئة 4 · صندوق كبير جداً', 'Class 4 · very large box', 'پۆلی 4 · سندووقی زۆر گەورە'],
  d5: ['الفئة 5 · أكبر صندوق', 'Class 5 · largest box', 'پۆلی 5 · گەورەترین سندووق'],
};

export const S = {
  title: ['خدمات الطابعة («خصص طابعتك»)', 'Printer services («Customize your printer»)', 'خزمەتگوزارییەکانی پرینتەر («پرینتەرەکەت ڕێکبخە»)'],
  loading: ['جارٍ التحميل…', 'Loading…', 'باردەکرێت…'],
  choose: ['اختر…', 'Choose…', 'هەڵبژێرە…'],

  // tabs
  tabThis: ['هذه الطابعة', 'This printer', 'ئەم پرینتەرە'],
  tabOffers: ['الباقات والإضافات', 'Kits and add-ons', 'پاکێج و زیادکراوەکان'],
  tabShared: ['قائمة الأسعار المشتركة', 'Shared price list', 'لیستی نرخی هاوبەش'],
  tabsLabel: ['أقسام خدمات الطابعة', 'Printer services areas', 'بەشەکانی خزمەتگوزاری پرینتەر'],

  // status line
  stPublished: ['منشورة ويرى الزبون خدمات هذه الطابعة', 'Published — customers see this printer\'s services', 'بڵاوکراوەتەوە — کڕیار خزمەتگوزارییەکانی ئەم پرینتەرە دەبینێت'],
  stPublishedNotHere: ['القائمة منشورة، لكن هذه الطابعة لا تظهر لها الخدمات بعد', 'The list is published, but this printer shows no services yet', 'لیستەکە بڵاوکراوەتەوە، بەڵام ئەم پرینتەرە هێشتا هیچ خزمەتگوزارییەکی بۆ دەرناکەوێت'],
  stNotPublished: ['غير منشورة: الطابعات تُباع كما كانت', 'Not published: printers sell as before', 'بڵاونەکراوەتەوە: پرینتەرەکان وەک پێشوو دەفرۆشرێن'],
  stMissing: ['ينقص هذه الطابعة:', 'This printer still needs:', 'ئەم پرینتەرە هێشتا پێویستی بە:'],
  stUnsaved: ['تعديلات غير محفوظة', 'Unsaved changes', 'گۆڕانکاری پاشەکەوتنەکراو'],
  stBlockers: ['قبل النشر:', 'Before publishing:', 'پێش بڵاوکردنەوە:'],
  stReady: ['جاهزة للنشر', 'Ready to publish', 'ئامادەیە بۆ بڵاوکردنەوە'],
  stNotListed: ['ليست في قائمة الطابعات بعد', 'Not in the printer list yet', 'هێشتا لە لیستی پرینتەرەکاندا نییە'],

  // this printer
  famLabel: ['عائلة الضمان', 'Warranty family', 'خێزانی گەرەنتی'],
  famHint: ['تحدد سعر الضمان 12 و24 شهراً لهذه الطابعة.', 'Sets this printer\'s 12- and 24-month warranty prices.', 'نرخی گەرەنتی 12 و 24 مانگی ئەم پرینتەرە دیاری دەکات.'],
  clsLabel: ['فئة التوصيل', 'Delivery class', 'پۆلی گەیاندن'],
  clsHint: ['اختر الفئة التي تناسب حجم صندوق هذه الطابعة؛ تحدد سعر التوصيل الاقتصادي والشخصي.', 'Choose the class that fits this printer\'s box size; it sets the economy and personal delivery prices.', 'ئەو پۆلە هەڵبژێرە کە لەگەڵ قەبارەی سندووقی ئەم پرینتەرە دەگونجێت؛ نرخی گەیاندنی ئابووری و تایبەت دیاری دەکات.'],
  usedNote: ['مستعملة — تبقى بضمانها الخاص، بلا خدمات', 'Used — keeps its own warranty, no services', 'بەکارهاتوو — گەرەنتی خۆی دەمێنێتەوە، بێ خزمەتگوزاری'],
  versions: ['النسخ', 'Versions', 'وەشانەکان'],
  versionsHint: ['اترك النسخة على «مثل الطابعة» لتأخذ اختيار الطابعة نفسها.', 'Leave a version on «Same as the printer» to take the printer\'s own choice.', 'وەشانێک لەسەر «وەک پرینتەرەکە» بهێڵەوە بۆ ئەوەی هەڵبژاردنی پرینتەرەکە وەربگرێت.'],
  sameAsPrinter: ['مثل الطابعة', 'Same as the printer', 'وەک پرینتەرەکە'],
  version: ['النسخة', 'Version', 'وەشان'],
  preview: ['ما يراه الزبون', 'What the customer sees', 'ئەوەی کڕیار دەیبینێت'],
  previewOf: ['المعاينة لـ', 'Preview for', 'پێشبینین بۆ'],
  wholePrinter: ['الطابعة كلها', 'The whole printer', 'هەموو پرینتەرەکە'],
  notMapped: [
    'هذا المنتج ليس في قائمة الطابعات بعد: احفظه منشوراً تحت قسم طابعات ثم أعد فتح الصفحة لربطه بعائلة ضمان وفئة توصيل.',
    'This product is not in the printer list yet: save it under a printer section, then reopen this page to give it a warranty family and a delivery class.',
    'ئەم بەرهەمە هێشتا لە لیستی پرینتەرەکاندا نییە: لە بەشێکی پرینتەردا پاشەکەوتی بکە، پاشان ئەم پەڕەیە دووبارە بکەرەوە بۆ دانانی خێزانی گەرەنتی و پۆلی گەیاندن.',
  ],
  noOffer: ['بلا عائلة ضمان أو فئة توصيل — لن تُعرض الخدمات.', 'No warranty family or delivery class — no services will show.', 'بێ خێزانی گەرەنتی یان پۆلی گەیاندن — هیچ خزمەتگوزارییەک پیشان نادرێت.'],

  // shared tab
  sharedBanner: ['تؤثر على كل الطابعات المسجّلة', 'Affects every enrolled printer', 'کار لە هەموو پرینتەرە تۆمارکراوەکان دەکات'],
  sharedBannerHint: ['أي سعر تغيّره هنا يتغيّر لكل طابعة تحمل نفس العائلة أو الفئة، لا لهذه الطابعة وحدها.', 'Any price changed here changes for every printer with the same family or class, not for this printer alone.', 'هەر نرخێک لێرە بگۆڕیت بۆ هەموو ئەو پرینتەرانە دەگۆڕێت کە هەمان خێزان یان پۆلیان هەیە، نەک تەنها بۆ ئەم پرینتەرە.'],
  thisFamily: ['عائلة هذه الطابعة', 'This printer\'s family', 'خێزانی ئەم پرینتەرە'],
  thisClass: ['فئة هذه الطابعة', 'This printer\'s class', 'پۆلی ئەم پرینتەرە'],
  otherFamilies: ['العائلات الأخرى', 'Other families', 'خێزانەکانی تر'],
  otherClasses: ['الفئات الأخرى', 'Other classes', 'پۆلەکانی تر'],
  grpWarranty: ['أسعار الضمان الممدد', 'Extended warranty prices', 'نرخی گەرەنتی درێژکراوە'],
  grpServices: ['ليفو كير والتغليف والفحص والأكاديمية', 'Levo Care, packaging, inspection and academy', 'لیڤۆ کێر، پێچانەوە، پشکنین و ئەکادیمیا'],
  grpDelivery: ['أسعار التوصيل', 'Delivery prices', 'نرخی گەیاندن'],
  grpPackages: ['الباقتان الجاهزتان', 'The two ready packages', 'دوو پاکێجە ئامادەکراوەکە'],
  grpCare: ['شروط ليفو كير', 'Levo Care terms', 'مەرجەکانی لیڤۆ کێر'],
  grpMembership: ['العضوية مع الطابعة', 'Membership with the printer', 'ئەندامێتی لەگەڵ پرینتەر'],
  emptyNotOffered: ['دينار؛ الفراغ = غير متوفر', 'IQD; empty = not offered', 'دینار؛ بەتاڵ = بەردەست نییە'],

  // offers tab
  offersIntro: [
    'ما يُعرض مع هذه الطابعة فقط. باقة أو إضافة لكل الطابعات تحمل شارة «كل الطابعات».',
    'Only what is offered with this printer. A kit or add-on for every printer carries the «Every printer» badge.',
    'تەنها ئەوەی لەگەڵ ئەم پرینتەرە پێشکەش دەکرێت. پاکێج یان زیادکراوێک بۆ هەموو پرینتەرەکان نیشانەی «هەموو پرینتەرەکان»ی پێوەیە.',
  ],
  kits: ['باقات الفيلامنت', 'Filament kits', 'پاکێجەکانی فیلامێنت'],
  kitsHint: [
    'من منتجات حقيقية. السعر = مجموع الأسعار الحالية لمنتجاتها، ناقص خصم الباقة إن وُضع. الكمية لكل طابعة وتتبع عدد الطابعات.',
    'Made of real products. The price is the sum of the items\' live prices, less the kit discount if one is set. Quantities are per printer and follow the printer quantity.',
    'لە بەرهەمی ڕاستەقینە. نرخ = کۆی نرخی ئێستای بەرهەمەکانی، کەمکردنەوەی داشکاندنی پاکێج ئەگەر دانرابێت. بڕەکان بۆ هەر پرینتەرێکن و بە ژمارەی پرینتەرەکان دەچن.',
  ],
  noKitsHere: ['لا باقات مع هذه الطابعة بعد.', 'No kits with this printer yet.', 'هێشتا هیچ پاکێجێک لەگەڵ ئەم پرینتەرە نییە.'],
  addons: ['إضافات بسعر خاص', 'Add-ons at a special price', 'زیادکراو بە نرخی تایبەت'],
  addonsHint: [
    'منتج من المتجر (فوهة، لوح طباعة…) يُباع مع الطابعة بخصمك. الكمية لكل طابعة، والزبون يستطيع حذفه من السلة.',
    'A store product (a nozzle, a plate…) sold with the printer at your discount. The quantity is per printer; the customer may remove it from the cart.',
    'بەرهەمێکی فرۆشگا (نۆزڵ، پلێت…) لەگەڵ پرینتەرەکە بە داشکاندنی تۆ دەفرۆشرێت. بڕەکە بۆ هەر پرینتەرێکە؛ کڕیار دەتوانێت لە سەبەتەکە لایببات.',
  ],
  noAddonsHere: ['لا إضافات مع هذه الطابعة بعد.', 'No add-ons with this printer yet.', 'هێشتا هیچ زیادکراوێک لەگەڵ ئەم پرینتەرە نییە.'],
  newAddon: ['إضافة جديدة', 'New add-on', 'زیادکراوی نوێ'],
  bundles: ['عروض مجمّعة من المتجر', 'Store bundles', 'پاکێجە کۆکراوەکانی فرۆشگا'],
  bundlesHint: [
    'باقات المتجر الموجودة تُعرض مع هذه الطابعة بسعرها هي، بلا خصم إضافي. حتى 8، بالترتيب الذي تختاره.',
    'Existing store bundles shown with this printer at their own price, no extra discount. Up to 8, in your order.',
    'پاکێجەکانی فرۆشگا لەگەڵ ئەم پرینتەرە بە نرخی خۆیان پیشان دەدرێن، بێ داشکاندنی زیادە. تا 8، بەو ڕیزەی تۆ هەڵیدەبژێریت.',
  ],
  noBundlesHere: ['لا عروض مجمّعة مع هذه الطابعة.', 'No store bundles with this printer.', 'هیچ پاکێجێکی کۆکراوە لەگەڵ ئەم پرینتەرە نییە.'],
  addBundle: ['أضف عرضاً مجمّعاً', 'Add a store bundle', 'پاکێجێکی کۆکراوە زیاد بکە'],
  bundlesLoadFailed: ['تعذّر تحميل باقات المتجر.', 'The store bundles could not be loaded.', 'پاکێجەکانی فرۆشگا بار نەکران.'],
  bundleGone: ['لم تعد موجودة أو ليست عرضاً مجمّعاً', 'no longer exists or is not a store bundle', 'ئیتر بوونی نییە یان پاکێجی کۆکراوە نییە'],
  bundleHidden: ['مخفية — لن تظهر للزبون', 'hidden — customers will not see it', 'شاراوە — کڕیار نایبینێت'],
  bundleNeedsMapping: ['اختر عائلة الضمان وفئة التوصيل أولاً في «هذه الطابعة».', 'Choose the warranty family and delivery class first in «This printer».', 'سەرەتا لە «ئەم پرینتەرە» خێزانی گەرەنتی و پۆلی گەیاندن هەڵبژێرە.'],
  moveUp: ['تقديم', 'Move up', 'بۆ سەرەوە'],
  moveDown: ['تأخير', 'Move down', 'بۆ خوارەوە'],
  remove: ['حذف', 'Remove', 'لابردن'],
  others: ['باقات وإضافات طابعات أخرى', 'Kits and add-ons of other printers', 'پاکێج و زیادکراوەکانی پرینتەرەکانی تر'],
  othersHint: ['موجودة في القائمة لطابعات أخرى ولا تظهر مع هذه الطابعة.', 'In the list for other printers; not shown with this printer.', 'لە لیستەکەدان بۆ پرینتەرەکانی تر؛ لەگەڵ ئەم پرینتەرە پیشان نادرێن.'],
  addHere: ['أضِفها لهذه الطابعة', 'Add it to this printer', 'بۆ ئەم پرینتەرە زیادی بکە'],
  showsHere: ['يظهر مع هذه الطابعة', 'Shows with this printer', 'لەگەڵ ئەم پرینتەرە پیشان دەدرێت'],
  everyPrinter: ['كل الطابعات', 'Every printer', 'هەموو پرینتەرەکان'],
  everyPrinterOffNote: ['كانت لكل الطابعات: ستبقى مع باقي الطابعات المسجّلة وتُرفع عن هذه وحدها.', 'It was for every printer: it stays with the other enrolled printers and leaves this one only.', 'بۆ هەموو پرینتەرەکان بوو: لەگەڵ پرینتەرە تۆمارکراوەکانی تر دەمێنێتەوە و تەنها لەم پرینتەرە لادەبرێت.'],
  everyVersion: ['كل النسخ', 'Every version', 'هەموو وەشانەکان'],
  kitKind: ['باقة', 'Kit', 'پاکێج'],
  addonKind: ['إضافة', 'Add-on', 'زیادکراو'],

  // colour mode
  colourMode: ['لون المنتج', 'Product colour', 'ڕەنگی بەرهەم'],
  colourFixed: ['ثابت', 'Fixed', 'جێگیر'],
  colourCustomer: ['يختاره الزبون', 'Customer picks', 'کڕیار هەڵیدەبژێرێت'],
  colourCustomerHint: ['يختار الزبون أي لون متوفر، أو «لون عشوائي» يختاره النظام من المخزون.', 'The customer picks any in-stock colour, or «Random colour», which the system picks from stock.', 'کڕیار هەر ڕەنگێکی بەردەست هەڵدەبژێرێت، یان «ڕەنگی هەڕەمەکی» کە سیستەمەکە لە کۆگاوە هەڵیدەبژێرێت.'],
  colourNone: ['لا ألوان مفعّلة لهذا المنتج — لا يُنشر بلون يختاره الزبون.', 'No active colours on this product — it cannot publish with a customer-picked colour.', 'ئەم بەرهەمە هیچ ڕەنگێکی چالاکی نییە — بە ڕەنگی هەڵبژاردەی کڕیار بڵاو ناکرێتەوە.'],
  outOfStock: ['نفد', 'Out', 'نەماوە'],

  // discount
  discount: ['الخصم', 'Discount', 'داشکاندن'],
  discNone: ['بدون', 'None', 'هیچ'],
  discPercent: ['نسبة %', 'Percent %', 'ڕێژە %'],
  discFixed: ['مبلغ ثابت لكل طابعة', 'Fixed per printer', 'بڕی جێگیر بۆ هەر پرینتەرێک'],
  discValuePercent: ['النسبة (1–90)', 'Percent (1–90)', 'ڕێژە (1–90)'],
  discValueFixed: ['المبلغ بالدينار لكل طابعة', 'IQD per printer', 'دینار بۆ هەر پرینتەرێک'],
  before: ['قبل', 'Before', 'پێش'],
  after: ['بعد', 'After', 'دوای'],
  save: ['وفّر', 'save', 'پاشەکەوت'],
  estimateNote: ['تقديري من سعر المنتجات الآن؛ السعر الحقيقي يُحسب عند الشراء بسعر مستوى الزبون، والخصم لا يتجاوز 90%.', 'Estimated from the products\' prices now; the real price is worked out at purchase at the customer\'s tier price, and the discount never passes 90%.', 'خەمڵێنراوە لە نرخی ئێستای بەرهەمەکان؛ نرخی ڕاستەقینە لە کاتی کڕیندا بە نرخی ئاستی کڕیار هەژمار دەکرێت، و داشکاندن لە 90% تێناپەڕێت.'],
  priceUnknown: ['السعر غير معروف بعد', 'Price not known yet', 'نرخ هێشتا نەزانراوە'],
  belowCost: ['تحذير: السعر بعد الخصم أقل من الكلفة', 'Warning: the price after the discount is below cost', 'ئاگاداری: نرخ دوای داشکاندن لە تێچوو کەمترە'],
  perPrinter: ['لكل طابعة', 'per printer', 'بۆ هەر پرینتەرێک'],

  // add-on editor
  addonProduct: ['المنتج', 'Product', 'بەرهەم'],
  addonPick: ['ابحث عن منتج للإضافة', 'Find a product for the add-on', 'بەرهەمێک بۆ زیادکراوەکە بدۆزەوە'],
  addonNoPrinter: ['الطابعة لا تكون إضافة.', 'A printer cannot be an add-on.', 'پرینتەر نابێتە زیادکراو.'],
  addonQty: ['الكمية لكل طابعة', 'Qty per printer', 'بڕ بۆ هەر پرینتەرێک'],
  addonOwnName: ['اسم خاص بدل اسم المنتج', 'Own name instead of the product\'s', 'ناوی تایبەت لەبری ناوی بەرهەمەکە'],
  addonUsesProductName: ['يظهر باسم المنتج', 'Shows under the product\'s name', 'بە ناوی بەرهەمەکە پیشان دەدرێت'],
  addonRemove: ['حذف الإضافة', 'Remove the add-on', 'سڕینەوەی زیادکراو'],
  active: ['مفعّلة', 'Active', 'چالاک'],
  sort: ['الترتيب', 'Sort', 'ڕیزبەندی'],
  id: ['المعرّف', 'Id', 'ناسنامە'],
  idRule: ['المعرّف: حروف إنجليزية صغيرة وأرقام و _ أو -، حتى 32.', 'Id: lowercase letters, digits, _ or -, up to 32.', 'ناسنامە: پیتی بچووکی ئینگلیزی، ژمارە، _ یان -، تا 32.'],
  idDup: ['هذا المعرّف مستخدم لإضافة أخرى — اختر معرّفاً آخر.', 'This id is used by another add-on — choose another id.', 'ئەم ناسنامەیە بۆ زیادکراوێکی تر بەکارهاتووە — ناسنامەیەکی تر هەڵبژێرە.'],
  nameAr: ['الاسم بالعربية', 'Name in Arabic', 'ناو بە عەرەبی'],
  nameEn: ['الاسم بالإنجليزية', 'Name in English', 'ناو بە ئینگلیزی'],
  nameCkb: ['الاسم بالكردية', 'Name in Kurdish', 'ناو بە کوردی'],

  // section 4 of the product form
  s4Delivery: ['التوصيل', 'Delivery', 'گەیاندن'],
  s4Services: ['خدمات الطابعة', 'Printer services', 'خزمەتگوزارییەکانی پرینتەر'],
  s4LegacyWarranty: ['الضمان الممدد القديم', 'Old extended warranty', 'گەرەنتی درێژکراوەی کۆن'],
  s4LegacyNote: ['لا يظهر للزبون ما دامت خدمات الطابعة منشورة لهذه الطابعة.', 'Not shown to customers while printer services are published for this printer.', 'تا خزمەتگوزارییەکانی پرینتەر بۆ ئەم پرینتەرە بڵاوکراوە بن، بۆ کڕیار پیشان نادرێت.'],
  s4Condition: ['الحالة', 'Condition', 'دۆخ'],
  s4Dimensions: ['الأبعاد والوزن', 'Dimensions & weight', 'ڕووبەر و کێش'],
  s4Instalments: ['التقسيط (جني)', 'Instalments (Gini)', 'قیست (جینی)'],
} as const satisfies Record<string, Tri>;

/** The customer-facing discount on one printer's worth of a kit or add-on, from an estimated price. */
/** «مشتركة مع N طابعات أخرى»: a kit / add-on that a list of printers shares with this one — counted, never named. */
export function sharedWithOthers(n: number): Tri {
  const ar = n === 1 ? 'مشتركة مع طابعة أخرى' : n === 2 ? 'مشتركة مع طابعتين أخريين' : n <= 10 ? `مشتركة مع ${n} طابعات أخرى` : `مشتركة مع ${n} طابعة أخرى`;
  return [ar, n === 1 ? 'Shared with 1 other printer' : `Shared with ${n} other printers`, `هاوبەشە لەگەڵ ${n} پرینتەری تر`];
}

export function discountPreview(d: PrinterDiscount | null | undefined, beforeIqd: number | null): { before: number; after: number; pct: number } | null {
  if (!d || beforeIqd === null || beforeIqd <= 0) return null;
  // One printer's worth as one unit: the same rule (and the same 90% cap) the cart applies per unit.
  const off = unitDiscount(d, beforeIqd, 1);
  return { before: beforeIqd, after: beforeIqd - off, pct: Math.round((off * 100) / beforeIqd) };
}
