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
  details: string;
  justWarning: string;
  justAck: string;
  delivery: string; deliveryEconomy: string; deliveryPersonal: string;
  deliveryEconomySub: string; deliveryPersonalSub: string;
  deliveryChoose: string;
  sheetTitle: string; sheetSub: string;
  warranty: string; warrantySub: string; none: string; months: (n: number) => string;
  warrantyNote: string;
  /** Care = 12 months AFTER the warranty; `careOption` takes the total for the choice on screen (12 / 24 / 36). */
  care: string; careSub: (pct: number) => string; careOption: (total: number) => string;
  /** What Levo Care includes, one short line (DECISIONS row 359). The draw is a chance, never a promise. */
  careIncludes: (pct: number) => string;
  packaging: string; packagingSub: string; packagingStandard: string; packagingExtra: string;
  inspection: string; inspectionSub: string; inspectionOption: string; inspectionLead: (lo: number, hi: number) => string;
  academy: string; academySub: string; academyRecorded: string; academyWhatsapp: string; academyInPerson: string;
  academyNote: string;
  apply: string; total: string; services: string; deliveryLine: string; close: string;
  terms: string;
  unavailable: string;
  includes: string;
  edit: string;
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
  /**
   * Membership WITH the printer (phase 2, 0235): its own order line at the live plan price, starting
   * only when the order is delivered and paid, non-refundable once started. Figures: the server's.
   */
  membership: string; membershipSub: string;
  memberNone: string;
  memberStarts: string; memberFinal: string;
  memberCurrent: (tier: string, until: string) => string;
  memberPendingOrder: string;
  memberSignIn: string; signIn: string;
  memberNew: string; memberUpgrade: string;
  memberCredit: (amount: string) => string;
  /** An existing member: only a HIGHER tier is offered with a printer (owner ruling; no renewal here). */
  memberUpgradeOnly: string; memberNoUpgrade: string;
  memberLoading: string; memberFailed: string; retry: string;
  memberOff: string;
  /** Why one plan cannot be bought now (the server's option code). */
  memberBlocked: Record<string, string>;
  membershipTerms: string;
  /** The owner's filament kits (phase 2): one kit or skip; the sum of the items' live prices, no discount. */
  filament: string; filamentSub: string; kitSkip: string; kitNote: string; kitPerPrinter: string;
  kitItemOut: string; kitsLoading: string; kitsFailed: string;
  /** No kit for this printer: filament stays an ordinary product, bought through the normal cart. */
  filamentNote: string; filamentShop: string;
  /** The footer: the membership and the kit are their own lines, outside the printer's total. */
  extrasApart: string;
  /** The cart and the checkout: the membership line and the kit lines under their printer. */
  memberLine: (tier: string, months: string) => string;
  memberAtCheckout: string;
  removeMembership: string; removeKit: string; rechoose: string;
  kitFollows: string;
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
  details: 'عرض التفاصيل',
  justWarning: 'ستشتري الطابعة بدون خدمات Levonis الاختيارية وبدون ضمان تجاري إضافي. حقوقك القانونية كمستهلك تبقى قائمة.',
  justAck: 'فهمت وأوافق',
  delivery: 'التوصيل', deliveryEconomy: 'اقتصادي', deliveryPersonal: 'شخصي (الوسيط)',
  deliveryEconomySub: 'توصيل عادي مع الشحنات', deliveryPersonalSub: 'مندوب خاص وعناية أكبر بالطابعة',
  deliveryChoose: 'اختر طريقة التوصيل',
  sheetTitle: 'تخصيص بنفسي', sheetSub: 'اختر الخدمات المناسبة لك',
  warranty: 'الضمان', warrantySub: 'اختر مدة الضمان', none: 'بدون', months: (n) => `${n} شهر`,
  warrantyNote: 'المدة كاملة من تاريخ التسليم، تشمل العتاد والبرمجيات والإرجاع المجاني للعيب المؤكد وفق الشروط.',
  care: 'Levo Care', careSub: (pct) => `12 شهر بعد الضمان: خصم حتى ${pct}% على القطع، لا استبدال مجاني`, careOption: (n) => (n > 12 ? `+12 شهر · المجموع ${n} شهر` : '12 شهر'),
  careIncludes: (pct) => `يشمل: خصم على القطع حتى ${pct}% • كوبونات أسبوعية لمدة 12 شهراً من الاستلام • دخول سحب شهري على فلمنت مجاني (فرصة لا وعد)`,
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
  pending: 'جارٍ التحقق من السعر…',
  quoteFailed: 'تعذّر تحميل أسعار الخدمات — حدّث الصفحة وحاول مجدداً.',
  saving: 'جارٍ الحفظ…',
  deliveryApart: 'يُضاف التوصيل إلى أجور الشحن عند الدفع.',
  addToCart: 'أضف إلى السلة',
  adding: 'جارٍ الإضافة…',
  membership: 'العضوية', membershipSub: 'اشترك مع الطابعة — اختياري',
  memberNone: 'بدون عضوية',
  memberStarts: 'تبدأ عند تسليم الطلب ودفعه — لا تشمل مزاياها هذا الطلب.',
  memberFinal: 'لا تُسترد بعد بدئها. إن أُلغي الطلب قبل ذلك فلا تبدأ وتُرد مع الطلب.',
  memberCurrent: (tier, until) => `عضويتك الحالية: ${tier}${until ? ` حتى ${until}` : ''}`,
  memberPendingOrder: 'لديك عضوية مع طلب سابق تبدأ عند تسليمه ودفعه.',
  memberSignIn: 'سجّل الدخول لتختار عضوية مع الطابعة.', signIn: 'تسجيل الدخول',
  memberNew: 'اشتراك جديد', memberUpgrade: 'ترقية',
  memberCredit: (amount) => `رصيد الترقية −${amount}`,
  memberUpgradeOnly: 'مع الطابعة تُعرض الترقية إلى مستوى أعلى فقط، ويُخصم منها رصيد عضويتك الحالية. التجديد من صفحة العضوية.',
  memberNoUpgrade: 'لا يوجد مستوى أعلى من عضويتك للترقية إليه مع الطابعة.',
  memberLoading: 'جارٍ تحميل خيارات العضوية…', memberFailed: 'تعذّر تحميل خيارات العضوية.', retry: 'إعادة المحاولة',
  memberOff: 'العضوية غير متاحة مع الطابعة الآن.',
  memberBlocked: {
    DOWNGRADE_BLOCKED: 'أقل من عضويتك الحالية',
    ALREADY_PREPAID: 'محجوزة لك مسبقاً',
    PLAN_UNPRICED: 'لم يُحدَّد سعرها بعد',
    PRO_PAUSED: 'متوقفة مؤقتاً',
    MEMBERSHIP_ORDER_PENDING: 'بانتظار طلبك السابق',
    MEMBERSHIP_NOT_OFFERED: 'غير متاحة الآن',
  },
  membershipTerms: 'شروط العضوية',
  filament: 'باقة الفيلامنت', filamentSub: 'اختر باقة أو تخطَّ', kitSkip: 'تخطٍّ — بدون باقة',
  kitNote: 'باقات يعدّها فريق Levonis من منتجات المتجر. سعرها مجموع أسعار منتجاتها الحالية بلا خصم، وتُضاف كسطور تتبع الطابعة.',
  kitPerPrinter: 'لكل طابعة', kitItemOut: 'غير متوفر', kitsLoading: 'جارٍ تحميل الباقات…', kitsFailed: 'تعذّر تحميل باقات الفيلامنت.',
  filamentNote: 'لا توجد باقة فيلامنت لهذه الطابعة — أضف الخيوط إلى السلة من صفحتها.', filamentShop: 'تصفّح الخيوط',
  extrasApart: 'العضوية وباقة الفيلامنت سطور مستقلة في السلة، خارج هذا الإجمالي.',
  memberLine: (tier, months) => `عضوية ${tier} · ${months}`,
  memberAtCheckout: 'سطر مستقل يُضاف إلى إجمالي الطلب عند الدفع.',
  removeMembership: 'إزالة العضوية', removeKit: 'إزالة الباقة', rechoose: 'اختر من جديد',
  kitFollows: 'كميتها تتبع الطابعة، وتُزال مع الطابعة.',
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
  details: 'View details',
  justWarning: 'You are buying the printer without optional Levonis services or additional commercial warranty. Your statutory consumer rights still apply.',
  justAck: 'I understand and agree',
  delivery: 'Delivery', deliveryEconomy: 'Economy', deliveryPersonal: 'Personal (Al-Waseet)',
  deliveryEconomySub: 'Regular delivery with other parcels', deliveryPersonalSub: 'Dedicated courier, extra care',
  deliveryChoose: 'Choose a delivery option',
  sheetTitle: 'Customize myself', sheetSub: 'Choose the services you want',
  warranty: 'Warranty', warrantySub: 'Choose how long', none: 'None', months: (n) => `${n} months`,
  warrantyNote: 'Total months from delivery: hardware, software and free return of a confirmed defect, under the terms.',
  care: 'Levo Care', careSub: (pct) => `12 months after the warranty: up to ${pct}% off parts, not a free replacement`, careOption: (n) => (n > 12 ? `+12 months · ${n} in total` : '12 months'),
  careIncludes: (pct) => `Includes: up to ${pct}% off parts • weekly coupons for 12 months from delivery • entry in a monthly free-filament draw (a chance, not a promise)`,
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
  pending: 'Checking the price…',
  quoteFailed: 'The service prices could not be loaded — refresh the page and try again.',
  saving: 'Saving…',
  deliveryApart: 'Delivery is added to the shipping at checkout.',
  addToCart: 'Add to cart',
  adding: 'Adding…',
  membership: 'Membership', membershipSub: 'Subscribe with the printer — optional',
  memberNone: 'No membership',
  memberStarts: 'Starts when the order is delivered and paid — its benefits do not apply to this order.',
  memberFinal: 'Non-refundable once started. If the order is cancelled before then, it never starts and is refunded with the order.',
  memberCurrent: (tier, until) => `Your membership: ${tier}${until ? ` until ${until}` : ''}`,
  memberPendingOrder: 'You have a membership with an earlier order; it starts when that order is delivered and paid.',
  memberSignIn: 'Sign in to choose a membership with the printer.', signIn: 'Sign in',
  memberNew: 'New', memberUpgrade: 'Upgrade',
  memberCredit: (amount) => `Upgrade credit −${amount}`,
  memberUpgradeOnly: 'With a printer, only an upgrade to a higher tier is offered, less the credit of your current membership. Renew from the membership page.',
  memberNoUpgrade: 'There is no higher tier than yours to upgrade to with the printer.',
  memberLoading: 'Loading membership options…', memberFailed: 'The membership options could not be loaded.', retry: 'Try again',
  memberOff: 'Membership is not offered with the printer right now.',
  memberBlocked: {
    DOWNGRADE_BLOCKED: 'Lower than your membership',
    ALREADY_PREPAID: 'Already reserved for you',
    PLAN_UNPRICED: 'Not priced yet',
    PRO_PAUSED: 'Paused for now',
    MEMBERSHIP_ORDER_PENDING: 'Waiting on your earlier order',
    MEMBERSHIP_NOT_OFFERED: 'Not offered now',
  },
  membershipTerms: 'Membership terms',
  filament: 'Filament kit', filamentSub: 'Pick a kit or skip', kitSkip: 'Skip — no kit',
  kitNote: 'Kits put together by the Levonis team from shop products. The price is the sum of their current prices, no discount; they are added as lines that follow the printer.',
  kitPerPrinter: 'per printer', kitItemOut: 'Unavailable', kitsLoading: 'Loading kits…', kitsFailed: 'The filament kits could not be loaded.',
  filamentNote: 'No filament kit for this printer — add filament to the cart from its own page.', filamentShop: 'Browse filament',
  extrasApart: 'The membership and the filament kit are their own cart lines, outside this total.',
  memberLine: (tier, months) => `${tier} membership · ${months}`,
  memberAtCheckout: 'Its own line, added to the order total at checkout.',
  removeMembership: 'Remove membership', removeKit: 'Remove kit', rechoose: 'Choose again',
  kitFollows: 'Its quantity follows the printer, and it is removed with the printer.',
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
  details: 'وردەکارییەکان',
  justWarning: 'پرینتەرەکە بەبێ خزمەتگوزارییە ئارەزوومەندانەکانی Levonis و بەبێ گەرەنتی بازرگانی زیادە دەکڕیت. مافە یاساییەکانت وەک بەکاربەر هەر دەمێننەوە.',
  justAck: 'تێگەیشتم و ڕازیم',
  delivery: 'گەیاندن', deliveryEconomy: 'ئابووری', deliveryPersonal: 'تایبەت (الوسيط)',
  deliveryEconomySub: 'گەیاندنی ئاسایی لەگەڵ بارەکانی تر', deliveryPersonalSub: 'نێردەری تایبەت و چاودێری زیاتر',
  deliveryChoose: 'جۆری گەیاندن هەڵبژێرە',
  sheetTitle: 'خۆم ڕێکی دەخەم', sheetSub: 'ئەو خزمەتگوزارییانە هەڵبژێرە کە دەتەوێت',
  warranty: 'گەرەنتی', warrantySub: 'ماوەی گەرەنتی هەڵبژێرە', none: 'هیچ', months: (n) => `${n} مانگ`,
  warrantyNote: 'هەموو ماوەکە لە ڕۆژی گەیاندنەوە: ڕەقەکاڵا، نەرمەکاڵا و گەڕاندنەوەی بەخۆڕایی بۆ کەموکوڕی سەلمێنراو، بەپێی مەرجەکان.',
  care: 'Levo Care', careSub: (pct) => `12 مانگ دوای گەرەنتی: داشکاندن تا ${pct}% لەسەر پارچە، گۆڕینی بەخۆڕایی نییە`, careOption: (n) => (n > 12 ? `+12 مانگ · کۆی ${n} مانگ` : '12 مانگ'),
  careIncludes: (pct) => `لەخۆدەگرێت: داشکاندن تا ${pct}% لەسەر پارچە • کۆپۆنی هەفتانە بۆ 12 مانگ لە وەرگرتنەوە • بەشداری لە تیروپشکی مانگانەی فیلامێنتی بەخۆڕایی (دەرفەتە، بەڵێن نییە)`,
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
  pending: 'نرخەکە دەپشکنرێت…',
  quoteFailed: 'نرخی خزمەتگوزارییەکان بار نەکران — پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  saving: 'پاشەکەوت دەکرێت…',
  deliveryApart: 'گەیاندن لە کاتی پارەدان دەخرێتە سەر کرێی ناردن.',
  addToCart: 'بیخە ناو سەبەتە',
  adding: 'زیاد دەکرێت…',
  membership: 'ئەندامێتی', membershipSub: 'لەگەڵ پرینتەرەکە بەشداربە — ئارەزوومەندانە',
  memberNone: 'بێ ئەندامێتی',
  memberStarts: 'کاتێک داواکارییەکە گەیەندرا و پارەکەی درا دەست پێدەکات — سوودەکانی ئەم داواکارییە ناگرنەوە.',
  memberFinal: 'دوای دەستپێکردن پارەکەی نادرێتەوە. ئەگەر داواکارییەکە پێشتر هەڵوەشایەوە، دەست پێناکات و لەگەڵ داواکارییەکە پارەکەی دەدرێتەوە.',
  memberCurrent: (tier, until) => `ئەندامێتییەکەت: ${tier}${until ? ` تا ${until}` : ''}`,
  memberPendingOrder: 'ئەندامێتییەکت لەگەڵ داواکارییەکی پێشووتر هەیە؛ کاتێک ئەو داواکارییە گەیەندرا و پارەکەی درا دەست پێدەکات.',
  memberSignIn: 'بچۆ ژوورەوە بۆ هەڵبژاردنی ئەندامێتی لەگەڵ پرینتەرەکە.', signIn: 'چوونەژوورەوە',
  memberNew: 'نوێ', memberUpgrade: 'بەرزکردنەوە',
  memberCredit: (amount) => `بڕی بەرزکردنەوە −${amount}`,
  memberUpgradeOnly: 'لەگەڵ پرینتەر تەنها بەرزکردنەوە بۆ ئاستێکی بەرزتر پێشکەش دەکرێت، و بڕی ئەندامێتییە ئێستاکەتی لێ دەبڕدرێت. نوێکردنەوە لە پەڕەی ئەندامێتییەوە.',
  memberNoUpgrade: 'هیچ ئاستێک لە ئەندامێتییەکەت بەرزتر نییە بۆ بەرزکردنەوە لەگەڵ پرینتەرەکە.',
  memberLoading: 'بژاردەکانی ئەندامێتی بار دەکرێن…', memberFailed: 'بژاردەکانی ئەندامێتی بار نەکران.', retry: 'دووبارە هەوڵ بدەرەوە',
  memberOff: 'ئەندامێتی ئێستا لەگەڵ پرینتەرەکە پێشکەش ناکرێت.',
  memberBlocked: {
    DOWNGRADE_BLOCKED: 'لە ئەندامێتییەکەت نزمترە',
    ALREADY_PREPAID: 'پێشتر بۆت گیراوە',
    PLAN_UNPRICED: 'هێشتا نرخی دیاری نەکراوە',
    PRO_PAUSED: 'بۆ ماوەیەک ڕاگیراوە',
    MEMBERSHIP_ORDER_PENDING: 'چاوەڕێی داواکارییە پێشووەکەتە',
    MEMBERSHIP_NOT_OFFERED: 'ئێستا پێشکەش ناکرێت',
  },
  membershipTerms: 'مەرجەکانی ئەندامێتی',
  filament: 'پاکێجی فیلامێنت', filamentSub: 'پاکێجێک هەڵبژێرە یان تێیپەڕێنە', kitSkip: 'تێپەڕاندن — بێ پاکێج',
  kitNote: 'پاکێجەکان تیمی Levonis لە بەرهەمەکانی فرۆشگا ئامادەیان دەکات. نرخەکەی کۆی نرخە ئێستاکانی بەرهەمەکانیەتی بێ داشکاندن، و وەک دێڕگەلێک زیاد دەکرێن کە شوێن پرینتەرەکە دەکەون.',
  kitPerPrinter: 'بۆ هەر پرینتەرێک', kitItemOut: 'بەردەست نییە', kitsLoading: 'پاکێجەکان بار دەکرێن…', kitsFailed: 'پاکێجەکانی فیلامێنت بار نەکران.',
  filamentNote: 'هیچ پاکێجێکی فیلامێنت بۆ ئەم پرینتەرە نییە — لە پەڕەی خۆیەوە دەزوو بخە ناو سەبەتە.', filamentShop: 'سەیری دەزووەکان بکە',
  extrasApart: 'ئەندامێتی و پاکێجی فیلامێنت دێڕی جیان لە سەبەتەدا، دەرەوەی ئەم کۆیە.',
  memberLine: (tier, months) => `ئەندامێتی ${tier} · ${months}`,
  memberAtCheckout: 'دێڕێکی جیایە، لە کاتی پارەداندا دەخرێتە سەر کۆی داواکاری.',
  removeMembership: 'لابردنی ئەندامێتی', removeKit: 'لابردنی پاکێج', rechoose: 'دووبارە هەڵبژێرە',
  kitFollows: 'بڕەکەی شوێن پرینتەرەکە دەکەوێت، و لەگەڵ پرینتەرەکە لادەبرێت.',
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
  // Phase 2 (0235): what the sheet and the add can answer about the membership and the kit. The cart,
  // checkout, returns and admin codes are in src/lib/refusalStrings.ts only (the product page's budget).
  MEMBERSHIP_NOT_OFFERED: {
    ar: 'هذه العضوية غير متاحة مع الطابعة الآن — اختر غيرها أو تخطَّها.',
    en: 'This membership is not offered with the printer right now — choose another or skip it.',
    ckb: 'ئەم ئەندامێتییە ئێستا لەگەڵ پرینتەرەکە پێشکەش ناکرێت — یەکێکی تر هەڵبژێرە یان تێیپەڕێنە.',
  },
  MEMBERSHIP_ORDER_PENDING: {
    ar: 'لديك عضوية مشتراة مع طلب سابق تبدأ عند تسليمه ودفعه — لا تُشترى عضوية ثانية قبل ذلك.',
    en: 'A membership bought with an earlier order starts when that order is delivered and paid — a second one cannot be bought before then.',
    ckb: 'ئەندامێتییەک کە لەگەڵ داواکارییەکی پێشووتر کڕدراوە، کاتێک ئەو داواکارییە گەیەندرا و پارەکەی درا دەست پێدەکات — پێش ئەوە ئەندامێتییەکی دووەم ناکڕدرێت.',
  },
  CART_MEMBERSHIP_CONFLICT: {
    ar: 'العضوية مختارة مع طابعة أخرى في سلتك — غيّرها من هناك.',
    en: 'The membership is already chosen with another printer in your cart — change it there.',
    ckb: 'ئەندامێتییەکە پێشتر لەگەڵ پرینتەرێکی تر لە سەبەتەکەتدا هەڵبژێردراوە — لەوێ بیگۆڕە.',
  },
  KIT_NOT_OFFERED: {
    ar: 'باقة الفيلامنت هذه غير متاحة مع هذه الطابعة — اختر غيرها أو تخطَّها.',
    en: 'This filament kit is not offered with this printer — choose another or skip it.',
    ckb: 'ئەم پاکێجی فیلامێنتە لەگەڵ ئەم پرینتەرە پێشکەش ناکرێت — یەکێکی تر هەڵبژێرە یان تێیپەڕێنە.',
  },
  KIT_UNAVAILABLE: {
    ar: 'أحد منتجات باقة الفيلامنت غير متوفر الآن بهذه الكمية أو طريقة الشحن — اختر باقة أخرى أو تخطَّها.',
    en: 'An item of the filament kit is not available now in this quantity or shipping type — choose another kit or skip it.',
    ckb: 'یەکێک لە بەرهەمەکانی پاکێجی فیلامێنت ئێستا بەم بڕە یان بەم جۆری ناردنە بەردەست نییە — پاکێجێکی تر هەڵبژێرە یان تێیپەڕێنە.',
  },
  KIT_CHANGED: {
    ar: 'تغيّرت باقة الفيلامنت لهذه الطابعة — اخترها من جديد.',
    en: 'The filament kit for this printer has changed — choose it again.',
    ckb: 'پاکێجی فیلامێنتی ئەم پرینتەرە گۆڕاوە — دووبارە هەڵیبژێرە.',
  },
  // The order-options / quote codes a chosen plan can carry (the contract change of the phase 2 review):
  // the sheet, the add, the cart and the checkout all say them; the same words as src/lib/refusalStrings.ts.
  PLAN_UNPRICED: {
    ar: 'لم يُحدَّد سعر هذه العضوية بعد، فلا تُشترى الآن — أزلها أو اختر غيرها.',
    en: 'This membership has no price yet, so it cannot be bought now — remove it or choose another.',
    ckb: 'هێشتا نرخی ئەم ئەندامێتییە دیاری نەکراوە، بۆیە ئێستا ناکڕدرێت — لای ببە یان یەکێکی تر هەڵبژێرە.',
  },
  PRO_PAUSED: {
    ar: 'الاشتراك الجديد في هذه العضوية متوقف مؤقتاً — أزلها أو اختر غيرها.',
    en: 'New subscriptions to this membership are paused for now — remove it or choose another.',
    ckb: 'بەشداریکردنی نوێ لەم ئەندامێتییەدا بۆ ماوەیەک ڕاگیراوە — لای ببە یان یەکێکی تر هەڵبژێرە.',
  },
  DOWNGRADE_BLOCKED: {
    ar: 'هذه العضوية أدنى من عضويتك الحالية — مع الطابعة تُشترى الترقية إلى مستوى أعلى فقط. أزلها أو اختر مستوى أعلى.',
    en: 'This membership is lower than your current one — with a printer only an upgrade to a higher tier is bought. Remove it or choose a higher tier.',
    ckb: 'ئەم ئەندامێتییە لە ئەندامێتییە ئێستاکەت نزمترە — لەگەڵ پرینتەر تەنها بەرزکردنەوە بۆ ئاستێکی بەرزتر دەکڕدرێت. لای ببە یان ئاستێکی بەرزتر هەڵبژێرە.',
  },
  ALREADY_SUBSCRIBED: {
    ar: 'أنت مشترك في هذا المستوى بالفعل — مع الطابعة تُشترى الترقية فقط، والتجديد من صفحة العضوية. أزلها أو اختر مستوى أعلى.',
    en: 'You already hold this tier — with a printer only an upgrade is bought; renew from the membership page. Remove it or choose a higher tier.',
    ckb: 'پێشتر ئەم ئاستەت هەیە — لەگەڵ پرینتەر تەنها بەرزکردنەوە دەکڕدرێت، نوێکردنەوە لە پەڕەی ئەندامێتییەوەیە. لای ببە یان ئاستێکی بەرزتر هەڵبژێرە.',
  },
  ALREADY_PREPAID: {
    ar: 'لديك عضوية مدفوعة مسبقاً بانتظار التفعيل — لا تُشترى عضوية أخرى معها الآن. أزلها من الطابعة.',
    en: 'You hold a prepaid membership waiting to be activated — another one is not bought with it now. Remove it from the printer.',
    ckb: 'ئەندامێتییەکی پێشپارەدراوت هەیە کە چاوەڕێی چالاککردنە — ئێستا ئەندامێتییەکی تر لەگەڵیدا ناکڕدرێت. لە پرینتەرەکە لای ببە.',
  },
  MEMBERSHIP_NOT_WITH_BNPL: {
    ar: 'لا تُشترى العضوية مع الطابعة عند الدفع لاحقاً — أزل العضوية أو اختر طريقة دفع أخرى.',
    en: 'A membership is not bought with the printer when paying with Buy Now, Pay Later — remove the membership or choose another payment method.',
    ckb: 'کاتێک بە ئێستا بکڕە و دواتر بدە پارە دەدەیت، ئەندامێتی لەگەڵ پرینتەرەکە ناکڕدرێت — ئەندامێتییەکە لابە یان ڕێگایەکی تری پارەدان هەڵبژێرە.',
  },
  EXTRAS_NOT_PRINTER: {
    ar: 'العضوية وباقة الفيلامنت تُختاران مع طابعة مسجّلة وباقتها.',
    en: 'A membership and a filament kit are chosen with an enrolled printer and its package.',
    ckb: 'ئەندامێتی و پاکێجی فیلامێنت لەگەڵ پرینتەرێکی تۆمارکراو و پاکێجەکەی هەڵدەبژێردرێن.',
  },
};

/** The reader's sentence for a services refusal; '' when the code is not one of them. */
export function servicesErrorText(code: string | null | undefined, lang: string): string {
  const e = code ? SERVICES_ERRORS[code] : undefined;
  if (!e) return '';
  return e[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
}

/**
 * KIT_UNAVAILABLE with `details.reason:'KIT_QTY_LIMIT'` (review S14): the kit cannot follow this many
 * printers — its own sentence, with `details.max_printer_qty`. The same words as KIT_QTY_LIMIT_WORDS in
 * src/lib/refusalStrings.ts (copied, not imported: this file rides the product page's lazy chunk).
 */
export const KIT_QTY_LIMIT_WORDS: Record<'ar' | 'en' | 'ckb', string> = {
  ar: 'مع باقة الفيلامنت هذه تُطلب {n} طابعة على الأكثر — خفّض الكمية إلى {n} أو أزل الباقة.',
  en: 'With this filament kit at most {n} printers can be ordered — lower the quantity to {n} or remove the kit.',
  ckb: 'لەگەڵ ئەم پاکێجی فیلامێنتە زۆرترین {n} پرینتەر داوا دەکرێت — بڕەکە بۆ {n} کەم بکەرەوە یان پاکێجەکە لاببە.',
};

/** A services refusal from the server (`{code, details}`): the kit-quantity sentence first, else the code's words; '' when neither. */
export function servicesRefusalText(err: unknown, lang: string): string {
  const e = err as { code?: unknown; details?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  const d = e && typeof e.details === 'object' && e.details !== null ? (e.details as { reason?: unknown; max_printer_qty?: unknown }) : null;
  if (code === 'KIT_UNAVAILABLE' && d?.reason === 'KIT_QTY_LIMIT' && typeof d.max_printer_qty === 'number' && Number.isFinite(d.max_printer_qty) && d.max_printer_qty >= 1) {
    return KIT_QTY_LIMIT_WORDS[lang === 'en' || lang === 'ckb' ? lang : 'ar'].replace(/\{n\}/g, String(Math.trunc(d.max_printer_qty)));
  }
  return servicesErrorText(code, lang);
}
