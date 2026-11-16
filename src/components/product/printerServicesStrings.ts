/**
 * «خصص طابعتك» — every word the package card and the «تخصيص بنفسي» sheet say,
 * in Arabic, English and Sorani (owner brief 2026-11-17; DECISIONS row 339).
 * Titles are GENERAL on purpose («الضمان», not «الضمان الممدد»).
 */
export type PsLang = 'ar' | 'en' | 'ckb';

export interface PsStrings {
  cardTitle: string;
  cardSub: string;
  recommended: string;
  just: string; justSub: string;
  smart: string; smartSub: string;
  complete: string; completeSub: string;
  customize: string; customizeSub: string;
  custom: string;
  free: string;
  chooseFirst: string;
  details: string; hideDetails: string;
  justWarning: string;
  justAck: string;
  delivery: string; deliveryEconomy: string; deliveryPersonal: string;
  deliveryEconomySub: string; deliveryPersonalSub: string;
  deliveryChoose: string;
  sheetTitle: string; sheetSub: string;
  printerOnly: string;
  warranty: string; warrantySub: string; none: string; months: (n: number) => string;
  warrantyNote: string;
  care: string; careSub: (pct: number) => string; careOption: string;
  packaging: string; packagingSub: string; packagingStandard: string; packagingExtra: string;
  inspection: string; inspectionSub: string; inspectionOption: string; inspectionLead: (lo: number, hi: number) => string;
  academy: string; academySub: string; academyRecorded: string; academyWhatsapp: string; academyInPerson: string;
  academyNote: string;
  apply: string; total: string; services: string; deliveryLine: string; close: string;
  terms: string;
  unavailable: string;
  includes: string;
  edit: string;
  noBuyNow: string;
  /** The server is pricing the choice on screen. */
  pending: string;
  /** The prices could not be read: nothing is added until they are. */
  quoteFailed: string;
  /** The Apply button while the cart saves the choice. */
  saving: string;
  /** Delivery is charged in the shipping total, not inside the line. */
  deliveryApart: string;
  /** The sheet's primary action: apply the choice, then the page's own add once the server priced it. */
  addToCart: string;
  /** While the page waits for the server's price of the applied choice before adding. */
  adding: string;
  /** Membership: information only — the server's membership_preview, never a service of the selection. */
  membership: string; membershipSub: string;
  memberPays: (tier: string) => string;
  membershipJoin: string; membershipUpgrade: (tier: string) => string;
  membershipApart: string;
  /** Filament: an ordinary product, bought through the normal cart — not a printer service. */
  filament: string; filamentSub: string; filamentNote: string; filamentShop: string;
}

const AR: PsStrings = {
  cardTitle: 'خصص طابعتك',
  cardSub: 'اختر الباقة التي تناسبك',
  recommended: 'الأكثر اختياراً',
  just: 'الطابعة فقط', justSub: 'بدون خدمات',
  smart: 'الاختيار الذكي', smartSub: 'ضمان سنة + Levo Care',
  complete: 'التجربة الكاملة', completeSub: 'ضمان سنتين + كل الخدمات',
  customize: 'تخصيص بنفسي', customizeSub: 'اختر كل خدمة كما تريد',
  custom: 'مخصص',
  free: 'مجاناً',
  chooseFirst: 'اختر باقتك وطريقة التوصيل أولاً',
  details: 'عرض التفاصيل', hideDetails: 'إخفاء التفاصيل',
  justWarning: 'ستشتري الطابعة بدون خدمات Levonis الاختيارية وبدون ضمان تجاري إضافي. حقوقك القانونية كمستهلك تبقى قائمة.',
  justAck: 'فهمت وأوافق',
  delivery: 'التوصيل', deliveryEconomy: 'اقتصادي', deliveryPersonal: 'شخصي (الوسيط)',
  deliveryEconomySub: 'توصيل عادي مع الشحنات', deliveryPersonalSub: 'مندوب خاص وعناية أكبر بالطابعة',
  deliveryChoose: 'اختر طريقة التوصيل',
  sheetTitle: 'تخصيص بنفسي', sheetSub: 'اختر الخدمات المناسبة لك',
  printerOnly: 'الطابعة فقط',
  warranty: 'الضمان', warrantySub: 'اختر مدة الضمان', none: 'بدون', months: (n) => `${n} شهر`,
  warrantyNote: 'المدة كاملة من تاريخ التسليم، تشمل العتاد والبرمجيات والإرجاع المجاني للعيب المؤكد وفق الشروط.',
  care: 'Levo Care', careSub: (pct) => `خصم حتى ${pct}% على قطع وإصلاحات سوء الاستخدام`, careOption: '12 شهر',
  packaging: 'التغليف', packagingSub: 'تغليف المصنع الآمن مشمول دائماً', packagingStandard: 'القياسي', packagingExtra: 'حماية إضافية',
  inspection: 'الفحص قبل الشحن', inspectionSub: 'فحص كامل للطابعة قبل إرسالها', inspectionOption: 'فحص كامل',
  inspectionLead: (lo, hi) => `يضيف ${lo}–${hi} أيام عمل للتجهيز`,
  academy: 'التعليم', academySub: 'فيديوهات مسجلة مجانية أو دورة مباشرة', academyRecorded: 'فيديوهات مسجلة',
  academyWhatsapp: 'دورة مباشرة — واتساب', academyInPerson: 'دورة مباشرة — حضورياً',
  academyNote: 'نتواصل معك لتحديد الموعد بعد الطلب.',
  apply: 'تطبيق التخصيص', total: 'الإجمالي الحالي', services: 'الخدمات', deliveryLine: 'التوصيل', close: 'إغلاق',
  terms: 'الشروط الكاملة',
  unavailable: 'غير متوفر حالياً',
  includes: 'تشمل',
  edit: 'تعديل',
  noBuyNow: 'الشراء السريع غير متاح لطابعة مع خدمات — أضفها إلى السلة.',
  pending: 'جارٍ التحقق من السعر…',
  quoteFailed: 'تعذّر تحميل أسعار الخدمات — حدّث الصفحة وحاول مجدداً.',
  saving: 'جارٍ الحفظ…',
  deliveryApart: 'يُضاف التوصيل إلى أجور الشحن عند الدفع.',
  addToCart: 'أضف إلى السلة',
  adding: 'جارٍ الإضافة…',
  membership: 'العضوية', membershipSub: 'سعر الأعضاء لهذه الطابعة',
  memberPays: (tier) => `أعضاء ${tier} يدفعون للطابعة`,
  membershipJoin: 'اشترك', membershipUpgrade: (tier) => `الترقية إلى ${tier}`,
  membershipApart: 'العضوية اشتراك مستقل ولا تُضاف إلى هذه الطابعة.',
  filament: 'الخيوط', filamentSub: 'تُشترى كمنتج مستقل', filamentNote: 'الخيوط ليست من خدمات الطابعة — أضفها إلى السلة من صفحتها.', filamentShop: 'تصفّح الخيوط',
};

const EN: PsStrings = {
  cardTitle: 'Customize your printer',
  cardSub: 'Pick what fits you',
  recommended: 'Most chosen',
  just: 'Just Printer', justSub: 'No services',
  smart: 'Smart Choice', smartSub: '1-year warranty + Levo Care',
  complete: 'Complete', completeSub: '2-year warranty + everything',
  customize: 'Customize myself', customizeSub: 'Pick each service yourself',
  custom: 'Custom',
  free: 'Free',
  chooseFirst: 'Choose your package and delivery first',
  details: 'View details', hideDetails: 'Hide details',
  justWarning: 'You are buying the printer without optional Levonis services or additional commercial warranty. Your statutory consumer rights still apply.',
  justAck: 'I understand and agree',
  delivery: 'Delivery', deliveryEconomy: 'Economy', deliveryPersonal: 'Personal (Al-Waseet)',
  deliveryEconomySub: 'Regular delivery with other parcels', deliveryPersonalSub: 'Dedicated courier, extra care',
  deliveryChoose: 'Choose a delivery option',
  sheetTitle: 'Customize myself', sheetSub: 'Choose the services you want',
  printerOnly: 'Printer only',
  warranty: 'Warranty', warrantySub: 'Choose how long', none: 'None', months: (n) => `${n} months`,
  warrantyNote: 'Total months from delivery: hardware, software and free return of a confirmed defect, under the terms.',
  care: 'Levo Care', careSub: (pct) => `Up to ${pct}% off misuse parts and repairs`, careOption: '12 months',
  packaging: 'Packaging', packagingSub: 'Safe factory packaging is always included', packagingStandard: 'Standard', packagingExtra: 'Extra protection',
  inspection: 'Pre-dispatch inspection', inspectionSub: 'A full check before it ships', inspectionOption: 'Full inspection',
  inspectionLead: (lo, hi) => `Adds ${lo}–${hi} business days to preparation`,
  academy: 'Academy', academySub: 'Free recorded videos or a live course', academyRecorded: 'Recorded videos',
  academyWhatsapp: 'Live course — WhatsApp', academyInPerson: 'Live course — in person',
  academyNote: 'We contact you after the order to agree a time.',
  apply: 'Apply', total: 'Current total', services: 'Services', deliveryLine: 'Delivery', close: 'Close',
  terms: 'Full terms',
  unavailable: 'Not available right now',
  includes: 'Includes',
  edit: 'Edit',
  noBuyNow: 'Buy now is not available for a printer with services — add it to the cart.',
  pending: 'Checking the price…',
  quoteFailed: 'The service prices could not be loaded — refresh the page and try again.',
  saving: 'Saving…',
  deliveryApart: 'Delivery is added to the shipping at checkout.',
  addToCart: 'Add to cart',
  adding: 'Adding…',
  membership: 'Membership', membershipSub: 'Member price for this printer',
  memberPays: (tier) => `${tier} members pay for the printer`,
  membershipJoin: 'Subscribe', membershipUpgrade: (tier) => `Upgrade to ${tier}`,
  membershipApart: 'Membership is a separate subscription and is not added to this printer.',
  filament: 'Filament', filamentSub: 'Bought as a separate product', filamentNote: 'Filament is not a printer service — add it to the cart from its own page.', filamentShop: 'Browse filament',
};

const CKB: PsStrings = {
  cardTitle: 'پرینتەرەکەت ڕێکبخە',
  cardSub: 'ئەو پاکێجە هەڵبژێرە کە گونجاوە بۆت',
  recommended: 'زۆرترین هەڵبژاردن',
  just: 'تەنها پرینتەر', justSub: 'بێ خزمەتگوزاری',
  smart: 'هەڵبژاردنی زیرەک', smartSub: 'گەرەنتی ساڵێک + Levo Care',
  complete: 'ئەزموونی تەواو', completeSub: 'گەرەنتی دوو ساڵ + هەموو خزمەتگوزارییەکان',
  customize: 'خۆم ڕێکی دەخەم', customizeSub: 'هەر خزمەتگوزارییەک خۆت هەڵبژێرە',
  custom: 'دڵخواز',
  free: 'بەخۆڕایی',
  chooseFirst: 'سەرەتا پاکێج و جۆری گەیاندن هەڵبژێرە',
  details: 'وردەکارییەکان', hideDetails: 'شاردنەوەی وردەکاری',
  justWarning: 'پرینتەرەکە بەبێ خزمەتگوزارییە ئارەزوومەندانەکانی Levonis و بەبێ گەرەنتی بازرگانی زیادە دەکڕیت. مافە یاساییەکانت وەک بەکاربەر هەر دەمێننەوە.',
  justAck: 'تێگەیشتم و ڕازیم',
  delivery: 'گەیاندن', deliveryEconomy: 'ئابووری', deliveryPersonal: 'تایبەت (الوسيط)',
  deliveryEconomySub: 'گەیاندنی ئاسایی لەگەڵ بارەکانی تر', deliveryPersonalSub: 'نێردەری تایبەت و چاودێری زیاتر',
  deliveryChoose: 'جۆری گەیاندن هەڵبژێرە',
  sheetTitle: 'خۆم ڕێکی دەخەم', sheetSub: 'ئەو خزمەتگوزارییانە هەڵبژێرە کە دەتەوێت',
  printerOnly: 'تەنها پرینتەر',
  warranty: 'گەرەنتی', warrantySub: 'ماوەی گەرەنتی هەڵبژێرە', none: 'هیچ', months: (n) => `${n} مانگ`,
  warrantyNote: 'هەموو ماوەکە لە ڕۆژی گەیاندنەوە: ڕەقەکاڵا، نەرمەکاڵا و گەڕاندنەوەی بەخۆڕایی بۆ کەموکوڕی سەلمێنراو، بەپێی مەرجەکان.',
  care: 'Levo Care', careSub: (pct) => `داشکاندن تا ${pct}% لەسەر پارچە و چاککردنەوەی خراپ بەکارهێنان`, careOption: '12 مانگ',
  packaging: 'پێچانەوە', packagingSub: 'پێچانەوەی سەلامەتی کارگە هەمیشە لەخۆدەگرێت', packagingStandard: 'ئاسایی', packagingExtra: 'پاراستنی زیادە',
  inspection: 'پشکنین پێش ناردن', inspectionSub: 'پشکنینی تەواوی پرینتەر پێش ناردن', inspectionOption: 'پشکنینی تەواو',
  inspectionLead: (lo, hi) => `${lo}–${hi} ڕۆژی کار بۆ ئامادەکردن زیاد دەکات`,
  academy: 'فێرکردن', academySub: 'ڤیدیۆی تۆمارکراوی بەخۆڕایی یان خولی ڕاستەوخۆ', academyRecorded: 'ڤیدیۆی تۆمارکراو',
  academyWhatsapp: 'خولی ڕاستەوخۆ — واتساپ', academyInPerson: 'خولی ڕاستەوخۆ — ئامادەبوون',
  academyNote: 'دوای داواکاری پەیوەندیت پێوە دەکەین بۆ دیاریکردنی کات.',
  apply: 'جێبەجێکردن', total: 'کۆی ئێستا', services: 'خزمەتگوزارییەکان', deliveryLine: 'گەیاندن', close: 'داخستن',
  terms: 'مەرجە تەواوەکان',
  unavailable: 'ئێستا بەردەست نییە',
  includes: 'لەخۆدەگرێت',
  edit: 'دەستکاری',
  noBuyNow: 'کڕینی خێرا بۆ پرینتەر لەگەڵ خزمەتگوزاری بەردەست نییە — بیخە ناو سەبەتە.',
  pending: 'نرخەکە دەپشکنرێت…',
  quoteFailed: 'نرخی خزمەتگوزارییەکان بار نەکران — پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  saving: 'پاشەکەوت دەکرێت…',
  deliveryApart: 'گەیاندن لە کاتی پارەدان دەخرێتە سەر کرێی ناردن.',
  addToCart: 'بیخە ناو سەبەتە',
  adding: 'زیاد دەکرێت…',
  membership: 'ئەندامێتی', membershipSub: 'نرخی ئەندامان بۆ ئەم پرینتەرە',
  memberPays: (tier) => `ئەندامانی ${tier} بۆ پرینتەرەکە دەدەن`,
  membershipJoin: 'بەشداربە', membershipUpgrade: (tier) => `بەرزکردنەوە بۆ ${tier}`,
  membershipApart: 'ئەندامێتی بەشداریکردنێکی جیایە و ناخرێتە سەر ئەم پرینتەرە.',
  filament: 'دەزوو', filamentSub: 'وەک بەرهەمێکی جیا دەکڕدرێت', filamentNote: 'دەزوو خزمەتگوزاری پرینتەر نییە — لە پەڕەی خۆیەوە بیخە ناو سەبەتە.', filamentShop: 'سەیری دەزووەکان بکە',
};

export const PS_STRINGS: Record<PsLang, PsStrings> = { ar: AR, en: EN, ckb: CKB };

/**
 * Every refusal the services can answer (packages/pricing/src/printerServices.ts
 * SERVICES_CODES, worker/routes/cart.ts, the checkout) in the reader's language,
 * each naming its fix. The server's own sentence is English or bilingual, never Sorani.
 */
export const SERVICES_ERRORS: Record<string, Record<PsLang, string>> = {
  SERVICES_REQUIRED: {
    ar: 'اختر باقة الطابعة وطريقة التوصيل قبل إضافتها إلى السلة.',
    en: 'Choose the printer package and delivery before adding it to the cart.',
    ckb: 'پێش خستنە ناو سەبەتە، پاکێجی پرینتەر و جۆری گەیاندن هەڵبژێرە.',
  },
  SERVICES_NOT_OFFERED: {
    ar: 'خدمات هذه الطابعة تغيّرت أو لم تعد متاحة — اختر من جديد.',
    en: 'The services for this printer have changed or are no longer offered — choose again.',
    ckb: 'خزمەتگوزارییەکانی ئەم پرینتەرە گۆڕاون یان چیتر پێشکەش ناکرێن — دووبارە هەڵبژێرە.',
  },
  SERVICES_WITH_LEGACY_WARRANTY: {
    ar: 'لا يُجمع بين باقة الطابعة والضمان الممدد القديم — اختر الباقة وحدها.',
    en: 'A printer package cannot be combined with the old extended warranty — choose the package alone.',
    ckb: 'پاکێجی پرینتەر لەگەڵ گەرەنتی درێژکراوەی کۆن کۆ ناکرێتەوە — تەنها پاکێجەکە هەڵبژێرە.',
  },
  SERVICES_NOT_CONFIRMED: {
    ar: 'اضغط على باقة لتأكيد اختيارك.',
    en: 'Tap a package to confirm your choice.',
    ckb: 'کرتە لە پاکێجێک بکە بۆ دڵنیاکردنەوەی هەڵبژاردنەکەت.',
  },
  SERVICES_NO_WARRANTY_ACK: {
    ar: 'أكّد أنك تشتري الطابعة بدون ضمان تجاري إضافي.',
    en: 'Confirm that you are buying the printer without an additional commercial warranty.',
    ckb: 'دڵنیای بکەرەوە کە پرینتەرەکە بەبێ گەرەنتی بازرگانی زیادە دەکڕیت.',
  },
  SERVICES_OPTION_UNAVAILABLE: {
    ar: 'أحد الخيارات التي اخترتها غير متوفر لهذه النسخة — غيّره.',
    en: 'One of the options you chose is not available for this version — change it.',
    ckb: 'یەکێک لەو بژاردانەی هەڵتبژاردووە بۆ ئەم وەشانە بەردەست نییە — بیگۆڕە.',
  },
  SERVICES_PACKAGE_MISMATCH: {
    ar: 'محتوى الباقة تغيّر — اختر الباقة من جديد.',
    en: 'What the package includes has changed — choose the package again.',
    ckb: 'ناوەڕۆکی پاکێجەکە گۆڕاوە — دووبارە پاکێجەکە هەڵبژێرە.',
  },
  SERVICES_PACKAGE_UNAVAILABLE: {
    ar: 'هذه الباقة غير متوفرة حالياً — اختر غيرها.',
    en: 'This package is not available right now — choose another.',
    ckb: 'ئەم پاکێجە ئێستا بەردەست نییە — یەکێکی تر هەڵبژێرە.',
  },
  SERVICES_INVALID: {
    ar: 'تعذّرت قراءة اختيار الخدمات — اختر من جديد.',
    en: 'Your services choice could not be read — choose again.',
    ckb: 'هەڵبژاردنی خزمەتگوزارییەکان نەخوێندرایەوە — دووبارە هەڵبژێرە.',
  },
  SERVICES_DELIVERY_REQUIRED: {
    ar: 'اختر التوصيل الاقتصادي أو الشخصي لكل طابعة.',
    en: 'Choose Economy or Personal delivery for each printer.',
    ckb: 'بۆ هەر پرینتەرێک گەیاندنی ئابووری یان تایبەت هەڵبژێرە.',
  },
  SERVICES_DELIVERY_METHOD: {
    ar: 'الطابعة مع خدماتها تُوصَّل بالتوصيل العادي (اقتصادي أو شخصي) أو تُستلم من المتجر — اختر أحدهما لإتمام الطلب.',
    en: 'A printer with its services goes by standard delivery (Economy or Personal) or store pickup — choose one of them to place the order.',
    ckb: 'پرینتەر لەگەڵ خزمەتگوزارییەکانی بە گەیاندنی ئاسایی (ئابووری یان تایبەت) دەنێردرێت یان لە فرۆشگا وەردەگیرێت — یەکێکیان هەڵبژێرە بۆ تەواوکردنی داواکاری.',
  },
  CART_SERVICES_CONFLICT: {
    ar: 'هذه الطابعة في سلتك بباقة مختلفة — غيّر الباقة من السلة.',
    en: 'This printer is already in your cart with a different package — change it from the cart.',
    ckb: 'ئەم پرینتەرە پێشتر بە پاکێجێکی جیاواز لە سەبەتەکەتدایە — لە سەبەتەوە بیگۆڕە.',
  },
};

/** The reader's sentence for a services refusal; '' when the code is not one of them. */
export function servicesErrorText(code: string | null | undefined, lang: string): string {
  const e = code ? SERVICES_ERRORS[code] : undefined;
  if (!e) return '';
  return e[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
}
