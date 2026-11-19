/**
 * The words of the printer's «خدمات الطابعة» panel (phase 4 redesign, DECISIONS row 355; phase 5
 * redesign, row 358), in
 * Arabic, English and Sorani Kurdish. Imported only by the panel's own files, so they ride in the
 * lazy admin chunk with it.
 *
 * Rule of the redesign (owner, 2026-11-18): a printer's page never names another printer. The
 * delivery classes are therefore said by SIZE, not by the printers that happen to sit in them, and
 * anything the panel counts on other printers is counted, never listed.
 */
import { careTotalMonths, unitDiscount, type CareChoice, type DeliveryClass, type PrinterDiscount, type WarrantyChoice, type WarrantyFamily } from '../../../packages/pricing/src/printerServices';

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
  // Phase 6 (DECISIONS row 362): the owner named this class by its box himself («the size for A1 is large box»).
  d6: ['الفئة 6 · صندوق A1', 'Class 6 · A1 box', 'پۆلی 6 · سندوقی A1'],
};

export const S = {
  loading: ['جارٍ التحميل…', 'Loading…', 'باردەکرێت…'],
  choose: ['اختر…', 'Choose…', 'هەڵبژێرە…'],

  // the status header: what customers see NOW for this printer, then the one next step
  stPublished: ['الزبون يرى خدمات هذه الطابعة الآن', 'Customers see this printer\'s services now', 'کڕیار ئێستا خزمەتگوزارییەکانی ئەم پرینتەرە دەبینێت'],
  stPublishedOlder: ['يراها بآخر نسخة منشورة؛ ما حفظته بعدها لم يُنشر بعد.', 'They see the last published copy; what you saved since is not published yet.', 'بە دوایین وەشانی بڵاوکراوە دەیبینێت؛ ئەوەی دواتر پاشەکەوتت کردووە هێشتا بڵاونەکراوەتەوە.'],
  stPublishedNotHere: ['الخدمات منشورة، لكن الزبون لا يراها مع هذه الطابعة بعد', 'Services are published, but customers do not see them with this printer yet', 'خزمەتگوزارییەکان بڵاوکراونەتەوە، بەڵام کڕیار هێشتا لەگەڵ ئەم پرینتەرە نایانبینێت'],
  stNotPublished: ['الزبون لا يرى خدمات الطابعة بعد: لم تُنشر', 'Customers do not see printer services yet: not published', 'کڕیار هێشتا خزمەتگوزارییەکانی پرینتەر نابینێت: بڵاونەکراوەتەوە'],
  stNotListed: ['هذا المنتج لم يُحفظ تحت قسم طابعات بعد', 'This product is not saved under a printer section yet', 'ئەم بەرهەمە هێشتا لە ژێر بەشێکی پرینتەردا پاشەکەوت نەکراوە'],
  stUsed: ['طابعة مستعملة: تُباع بضمانها الخاص، بلا خدمات', 'A used printer: sold with its own warranty, no services', 'پرینتەری بەکارهاتوو: بە گەرەنتی خۆی دەفرۆشرێت، بێ خزمەتگوزاری'],
  stProductHidden: ['المنتج نفسه غير منشور في المتجر، فلا يراه الزبون أصلاً.', 'The product itself is not published in the store, so customers do not see it at all.', 'بەرهەمەکە خۆی لە فرۆشگا بڵاونەکراوەتەوە، بۆیە کڕیار هەر نایبینێت.'],
  stUnsaved: ['تعديلات غير محفوظة', 'Unsaved changes', 'گۆڕانکاری پاشەکەوتنەکراو'],
  stBlockers: ['ينقص قبل النشر:', 'Still needed before publishing:', 'پێش بڵاوکردنەوە ئەمانە ماون:'],
  stIssuesLive: ['محسوبة مما تراه على الشاشة الآن. فحص المنتجات (وجودها وألوانها) يُعاد بعد الحفظ.', 'Worked out from what is on screen now. The product checks (they exist, their colours) run again after you save.', 'لەوەی ئێستا لەسەر شاشەیە هەژمار کراوە. پشکنینی بەرهەمەکان (بوونیان و ڕەنگەکانیان) دوای پاشەکەوتکردن دووبارە دەکرێتەوە.'],
  next: ['الخطوة التالية', 'Next step', 'هەنگاوی داهاتوو'],
  nextSaveProduct: ['احفظ المنتج تحت قسم طابعات (زر «نشر» أو «مسودة» أسفل الصفحة)، ثم ارجع إلى هنا.', 'Save the product under a printer section (the «Publish» or «Draft» button at the bottom of the page), then come back here.', 'بەرهەمەکە لە ژێر بەشێکی پرینتەردا پاشەکەوت بکە (دوگمەی «بڵاوکردنەوە» یان «ڕەشنووس» لە خوارەوەی پەڕەکە)، پاشان بگەڕێوە ئێرە.'],
  nextMap: ['اختر عائلة الضمان وفئة التوصيل في الخطوة 1 بالأسفل.', 'Choose the warranty family and the delivery class in step 1 below.', 'لە هەنگاوی 1ی خوارەوە خێزانی گەرەنتی و پۆلی گەیاندن هەڵبژێرە.'],
  nextFixLocal: ['صحّح الملاحظات المعلَّمة في الباقات والإضافات (الخطوة 2).', 'Fix the notes marked in the kits and add-ons (step 2).', 'ئەو تێبینییانەی لە پاکێج و زیادکراوەکاندا نیشان کراون چاک بکە (هەنگاوی 2).'],
  nextSave: ['اضغط «حفظ الخدمات».', 'Press «Save services».', 'دوگمەی «پاشەکەوتی خزمەتگوزاری» دابگرە.'],
  nextFix: ['أكمل ما ينقص في القائمة أدناه، ثم احفظ.', 'Complete what the list below still needs, then save.', 'ئەوەی لە لیستی خوارەوەدا ماوە تەواوی بکە، پاشان پاشەکەوتی بکە.'],
  nextPublish: ['اضغط «نشر الخدمات» ليراها الزبون.', 'Press «Publish services» so customers see it.', 'دوگمەی «بڵاوکردنەوەی خزمەتگوزاری» دابگرە تا کڕیار بیبینێت.'],
  nextDone: ['لا شيء مطلوب: كل ما حفظته منشور للزبائن.', 'Nothing needed: everything you saved is published to customers.', 'هیچ پێویست نییە: هەموو ئەوەی پاشەکەوتت کردووە بۆ کڕیاران بڵاوکراوەتەوە.'],
  nextNone: ['لا شيء هنا: هذه الطابعة لا تُعرض معها الخدمات.', 'Nothing here: no services are offered with this printer.', 'هیچ لێرە نییە: خزمەتگوزاری لەگەڵ ئەم پرینتەرە پێشکەش ناکرێت.'],
  nextOwner: ['الحفظ والنشر للمالك وحده.', 'Saving and publishing are the owner\'s alone.', 'پاشەکەوتکردن و بڵاوکردنەوە تەنها هی خاوەنەکەیە.'],
  stepsLabel: ['مراحل تفعيل الخدمات', 'Steps to switch the services on', 'هەنگاوەکانی چالاککردنی خزمەتگوزارییەکان'],
  stepMap: ['الاختيار', 'Choose', 'هەڵبژاردن'],
  stepSave: ['الحفظ', 'Save', 'پاشەکەوت'],
  stepPublish: ['النشر', 'Publish', 'بڵاوکردنەوە'],
  stepDone: ['تمّ', 'done', 'تەواو'],

  // the action bar
  saveBtn: ['حفظ الخدمات', 'Save services', 'پاشەکەوتی خزمەتگوزاری'],
  publishBtn: ['نشر الخدمات', 'Publish services', 'بڵاوکردنەوەی خزمەتگوزاری'],
  barNote: ['هذان الزران لخدمات الطابعة فقط. زر «نشر» أسفل الصفحة يحفظ المنتج نفسه ولا ينشر الخدمات.', 'These two buttons are for the printer services only. The «Publish» button at the bottom of the page saves the product itself; it does not publish the services.', 'ئەم دوو دوگمەیە تەنها بۆ خزمەتگوزارییەکانی پرینتەرن. دوگمەی «بڵاوکردنەوە»ی خوارەوەی پەڕەکە بەرهەمەکە خۆی پاشەکەوت دەکات و خزمەتگوزارییەکان بڵاو ناکاتەوە.'],
  whySave: ['الحفظ:', 'Save:', 'پاشەکەوت:'],
  whyPublish: ['النشر:', 'Publish:', 'بڵاوکردنەوە:'],
  whyIdle: ['لا شيء للحفظ أو النشر الآن.', 'Nothing to save or publish right now.', 'ئێستا هیچ شتێک بۆ پاشەکەوتکردن یان بڵاوکردنەوە نییە.'],
  inStep1: ['الخطوة 1', 'step 1', 'هەنگاوی 1'],
  inStep2: ['الخطوة 2', 'step 2', 'هەنگاوی 2'],
  inStep3: ['الخطوة 3', 'step 3', 'هەنگاوی 3'],
  whyBusy: ['جارٍ التنفيذ…', 'working…', 'جێبەجێ دەکرێت…'],
  whyStale: ['اختر أولاً ما تفعله بالنسخة الأحدث في الأعلى.', 'first choose what to do with the newer copy above.', 'سەرەتا هەڵبژێرە چی لە وەشانە نوێترەکەی سەرەوە بکەیت.'],
  whyHeld: ['في الباقات أو الإضافات ملاحظة يجب تصحيحها (الخطوة 2).', 'a kit or an add-on has a note to fix (step 2).', 'لە پاکێج یان زیادکراوەکاندا تێبینییەک هەیە دەبێت چاک بکرێت (هەنگاوی 2).'],
  whyClean: ['لا تعديلات جديدة.', 'nothing new to save.', 'هیچ گۆڕانکارییەکی نوێ نییە.'],
  whyDirty: ['احفظ التعديلات أولاً.', 'save the changes first.', 'سەرەتا گۆڕانکارییەکان پاشەکەوت بکە.'],
  whyIssues: ['أكمل ما ينقص المذكور في الأعلى.', 'complete what the list above still needs.', 'ئەوەی لە لیستی سەرەوەدا ماوە تەواوی بکە.'],
  whyUpToDate: ['آخر نسخة محفوظة منشورة بالفعل.', 'the last saved copy is already published.', 'دوایین وەشانی پاشەکەوتکراو پێشتر بڵاوکراوەتەوە.'],
  switchOff: ['إيقاف الخدمات عن كل الطابعات', 'Switch the services off for every printer', 'ڕاگرتنی خزمەتگوزارییەکان لە هەموو پرینتەرەکان'],
  switchOffAsk: ['سيتوقف عرض الخدمات على كل الطابعات، لا على هذه وحدها. الطلبات السابقة لا تتأثر.', 'Services stop showing on every printer, not this one alone. Earlier orders are not affected.', 'خزمەتگوزارییەکان لە هەموو پرینتەرەکان نامێنن، نەک تەنها لەم پرینتەرە. داواکارییە پێشووەکان کاریان تێناکرێت.'],
  switchOffYes: ['نعم، أوقفها', 'Yes, switch off', 'بەڵێ، ڕایبگرە'],
  cancel: ['تراجع', 'Cancel', 'پاشگەزبوونەوە'],

  // step headings
  step1: ['ضمان وتوصيل هذه الطابعة', 'This printer\'s warranty and delivery', 'گەرەنتی و گەیاندنی ئەم پرینتەرە'],
  step1Hint: ['اختياران فقط: بهما تُعرف أسعار الضمان والتوصيل التي يراها الزبون.', 'Two choices only: they decide the warranty and delivery prices the customer sees.', 'تەنها دوو هەڵبژاردن: بەوان نرخی گەرەنتی و گەیاندن کە کڕیار دەیبینێت دیاری دەکرێت.'],
  step2: ['ما يُباع مع هذه الطابعة', 'What is sold with this printer', 'ئەوەی لەگەڵ ئەم پرینتەرە دەفرۆشرێت'],
  step2Hint: ['باقات الفيلامنت، إضافات بسعر خاص وعروض المتجر المجمّعة. اختياري.', 'Filament kits, add-ons at a special price and store bundles. Optional.', 'پاکێجی فیلامێنت، زیادکراو بە نرخی تایبەت و پاکێجە کۆکراوەکانی فرۆشگا. ئارەزوومەندانەیە.'],
  step3: ['الأسعار المشتركة لكل الطابعات', 'The prices every printer shares', 'ئەو نرخانەی هەموو پرینتەرەکان تێیاندا هاوبەشن'],
  step3Tail: ['الضمان والتوصيل وليفو كير — مقفلة حتى تفتحها', 'Warranty, delivery and Levo Care — locked until you unlock them', 'گەرەنتی، گەیاندن و لیڤۆ کێر — قوفڵکراون تا دەیانکەیتەوە'],
  step3Hint: ['أسعار الضمان والتوصيل وليفو كير والتغليف والفحص. تغييرها يغيّر كل الطابعات.', 'Warranty, delivery, Levo Care, packaging and inspection prices. Changing them changes every printer.', 'نرخی گەرەنتی، گەیاندن، لیڤۆ کێر، پێچانەوە و پشکنین. گۆڕینیان هەموو پرینتەرەکان دەگۆڕێت.'],

  // this printer
  famLabel: ['عائلة الضمان', 'Warranty family', 'خێزانی گەرەنتی'],
  famHint: ['تحدد سعر ضمان السنة وضمان السنتين لهذه الطابعة.', 'Sets this printer\'s 12- and 24-month warranty prices.', 'نرخی گەرەنتی یەک ساڵ و دوو ساڵی ئەم پرینتەرە دیاری دەکات.'],
  clsLabel: ['فئة التوصيل', 'Delivery class', 'پۆلی گەیاندن'],
  clsHint: ['اختر الفئة التي تناسب حجم صندوق هذه الطابعة؛ تحدد سعر التوصيل الاقتصادي والشخصي.', 'Choose the class that fits this printer\'s box size; it sets the economy and personal delivery prices.', 'ئەو پۆلە هەڵبژێرە کە لەگەڵ قەبارەی سندووقی ئەم پرینتەرە دەگونجێت؛ نرخی گەیاندنی ئابووری و تایبەت دیاری دەکات.'],
  usedNote: ['طابعة مستعملة أو مجدَّدة: تبقى بضمانها الخاص المكتوب في «الحالة»، ولا تُعرض معها الخدمات.', 'A used or refurbished printer: it keeps its own warranty written under «Condition», and no services are offered with it.', 'پرینتەری بەکارهاتوو یان نوێکراوە: گەرەنتی خۆی کە لە «دۆخ» نووسراوە دەمێنێتەوە، و خزمەتگوزاری لەگەڵیدا پێشکەش ناکرێت.'],
  versions: ['نسخة تختلف عن الطابعة؟', 'A version that differs from the printer?', 'وەشانێک لە پرینتەرەکە جیاوازە؟'],
  versionsHint: ['اترك النسخة على «مثل الطابعة» لتأخذ اختيار الطابعة نفسها. غيّرها فقط إذا كان صندوق النسخة أكبر أو عائلتها مختلفة.', 'Leave a version on «Same as the printer» to take the printer\'s own choice. Change it only when the version\'s box is larger or its family differs.', 'وەشانێک لەسەر «وەک پرینتەرەکە» بهێڵەوە بۆ ئەوەی هەڵبژاردنی پرینتەرەکە وەربگرێت. تەنها کاتێک بیگۆڕە کە سندووقی وەشانەکە گەورەترە یان خێزانەکەی جیاوازە.'],
  sameAsPrinter: ['مثل الطابعة', 'Same as the printer', 'وەک پرینتەرەکە'],
  version: ['النسخة', 'Version', 'وەشان'],
  wholePrinter: ['الطابعة كلها', 'The whole printer', 'هەموو پرینتەرەکە'],
  notMapped: [
    'لا تظهر خدمات الطابعة قبل حفظ المنتج تحت قسم طابعات. احفظه بزر «نشر» أو «مسودة» أسفل الصفحة، وستظهر هنا الاختيارات مباشرة.',
    'Printer services appear once the product is saved under a printer section. Save it with the «Publish» or «Draft» button at the bottom of the page and the choices show here right away.',
    'خزمەتگوزارییەکانی پرینتەر دوای پاشەکەوتکردنی بەرهەمەکە لە ژێر بەشێکی پرینتەردا دەردەکەون. بە دوگمەی «بڵاوکردنەوە» یان «ڕەشنووس»ی خوارەوەی پەڕەکە پاشەکەوتی بکە، هەڵبژاردنەکان یەکسەر لێرە دەردەکەون.',
  ],
  recheck: ['تحقّق الآن', 'Check now', 'ئێستا بپشکنە'],

  // «ما يراه الزبون»
  preview: ['ما يراه الزبون', 'What the customer sees', 'ئەوەی کڕیار دەیبینێت'],
  previewNote: ['من اختياراتك على الشاشة الآن. يصل إلى الزبون بعد الحفظ والنشر.', 'From your choices on screen now. It reaches customers after you save and publish.', 'لە هەڵبژاردنەکانی ئێستای سەر شاشە. دوای پاشەکەوتکردن و بڵاوکردنەوە دەگاتە کڕیار.'],
  previewOf: ['المعاينة لـ', 'Preview for', 'پێشبینین بۆ'],
  noOffer: ['اختر عائلة الضمان وفئة التوصيل في الخطوة 1 لترى ما سيُعرض على الزبون.', 'Choose the warranty family and delivery class in step 1 to see what the customer will be offered.', 'لە هەنگاوی 1 خێزانی گەرەنتی و پۆلی گەیاندن هەڵبژێرە تا ببینیت چی پێشکەشی کڕیار دەکرێت.'],
  pvWarranty: ['الضمان', 'Warranty', 'گەرەنتی'],
  pvNoWarranty: ['بلا ضمان', 'No warranty', 'بێ گەرەنتی'],
  pvMonths12: ['12 شهراً', '12 months', '12 مانگ'],
  pvMonths24: ['24 شهراً', '24 months', '24 مانگ'],
  pvCare: ['ليفو كير', 'Levo Care', 'لیڤۆ کێر'],
  pvCareHint: ['خصم على القطع بعد انتهاء الضمان أو عند سوء الاستخدام: 12 شهراً تُضاف بعد الضمان.', 'A discount on parts after the warranty ends, or for misuse: 12 months added after the warranty.', 'داشکاندن لەسەر پارچەکان دوای تەواوبوونی گەرەنتی یان لە کاتی خراپ بەکارهێنان: 12 مانگ دوای گەرەنتی زیاد دەکرێت.'],
  pvCareTotal: ['مدة التغطية الكلية من يوم التسليم', 'Total cover from the delivery day', 'کۆی ماوەی داپۆشین لە ڕۆژی گەیاندنەوە'],
  pvCarePrice: ['12 شهراً بعد الضمان', '12 months after the warranty', '12 مانگ دوای گەرەنتی'],
  pvWith12: ['مع ضمان 12 شهراً', 'with 12-month warranty', 'لەگەڵ گەرەنتی 12 مانگ'],
  pvWith24: ['مع ضمان 24 شهراً', 'with 24-month warranty', 'لەگەڵ گەرەنتی 24 مانگ'],
  pvMore: ['باقي الخدمات والباقات الجاهزة', 'Other services and ready packages', 'خزمەتگوزارییەکانی تر و پاکێجە ئامادەکراوەکان'],
  pvPackaging: ['التغليف', 'Packaging', 'پێچانەوە'],
  pvStandard: ['عادي', 'Standard', 'ئاسایی'],
  pvExtra: ['حماية إضافية', 'Extra protection', 'پاراستنی زیادە'],
  pvInspection: ['الفحص قبل الشحن', 'Pre-dispatch inspection', 'پشکنین پێش ناردن'],
  pvAcademy: ['الأكاديمية', 'Academy', 'ئەکادیمیا'],
  pvRecorded: ['فيديوهات مسجلة', 'Recorded videos', 'ڤیدیۆی تۆمارکراو'],
  pvLive: ['دورة مباشرة', 'Live course', 'خولی ڕاستەوخۆ'],
  pvDelivery: ['التوصيل', 'Delivery', 'گەیاندن'],
  pvEconomy: ['اقتصادي', 'Economy', 'ئابووری'],
  pvPersonal: ['شخصي', 'Personal', 'تایبەت'],
  pvPackages: ['الباقات الجاهزة', 'Ready packages', 'پاکێجە ئامادەکراوەکان'],
  pvJust: ['الطابعة فقط', 'Printer only', 'تەنها پرینتەر'],
  pvMembership: ['العضوية مع الطابعة', 'Membership with the printer', 'ئەندامێتی لەگەڵ پرینتەر'],
  pvKits: ['باقات الفيلامنت', 'Filament kits', 'پاکێجەکانی فیلامێنت'],
  pvAddons: ['إضافات بسعر خاص', 'Add-ons at a special price', 'زیادکراو بە نرخی تایبەت'],
  pvBundles: ['عروض مجمّعة', 'Store bundles', 'پاکێجە کۆکراوەکان'],
  pvNone: ['لا شيء', 'None', 'هیچ'],
  pvFree: ['مجاناً', 'Free', 'بەخۆڕایی'],
  pvNotOffered: ['غير معروض', 'Not offered', 'پێشکەش ناکرێت'],
  pvOff: ['موقوف', 'Switched off', 'ڕاگیراوە'],
  pvEstimate: ['تقديري', 'estimate', 'خەمڵێنراو'],
  // phase 6: the price anchor and the warehouse pickup, as the customer reads them
  pvIncluded: ['مشمول في السعر', 'Included in the price', 'لەناو نرخدایە'],
  pvPickup: ['استلام من المخزن', 'Pick up from the warehouse', 'وەرگرتن لە کۆگا'],
  pvAnchored: [
    'سعر الطابعة يتضمن «الاختيار الذكي»: كل اختيار أدناه يُعرض بفرقه عن السعر (− ينقص، + يزيد).',
    'The printer\'s price includes «Smart Choice»: every choice below shows its difference from the price (− lowers it, + raises it).',
    'نرخی پرینتەرەکە «هەڵبژاردنی زیرەک»ی تێدایە: هەر هەڵبژاردنێکی خوارەوە جیاوازییەکەی لە نرخەکە پیشان دەدات (− کەمی دەکاتەوە، + زیادی دەکات).',
  ],

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
  sharedLocked: ['الأسعار مقفلة للقراءة.', 'The prices are locked, read only.', 'نرخەکان قوفڵ کراون، تەنها بۆ خوێندنەوە.'],
  sharedUnlock: ['افتح الأسعار للتعديل', 'Unlock the prices to edit', 'نرخەکان بکەرەوە بۆ دەستکاری'],
  sharedUnlocked: ['الأسعار مفتوحة: كل تغيير هنا يصل إلى كل الطابعات بعد الحفظ والنشر.', 'The prices are unlocked: every change here reaches every printer after save and publish.', 'نرخەکان کراونەتەوە: هەر گۆڕانکارییەک لێرە دوای پاشەکەوتکردن و بڵاوکردنەوە دەگاتە هەموو پرینتەرەکان.'],
  sharedRelock: ['أقفلها', 'Lock again', 'دووبارە قوفڵی بکە'],
  pkgContains: ['تتضمن', 'Includes', 'ئەمانەی تێدایە'],
  emptyNotOffered: ['دينار؛ الفراغ = غير متوفر', 'IQD; empty = not offered', 'دینار؛ بەتاڵ = بەردەست نییە'],
  // phase 6: the price anchor
  grpAnchor: ['ماذا يتضمن سعر الطابعة', 'What the printer\'s price includes', 'نرخی پرینتەر چی تێدایە'],
  anchorSwitch: ['سعر الطابعة المعروض هو سعر الاختيار الذكي', 'The printer\'s shown price is the Smart Choice price', 'نرخی پیشاندراوی پرینتەر نرخی هەڵبژاردنی زیرەکە'],
  anchorOnSummary: ['مفعّل: السعر يتضمن الاختيار الذكي', 'On: the price includes Smart Choice', 'چالاکە: نرخەکە هەڵبژاردنی زیرەکی تێدایە'],
  anchorOffSummary: ['موقوف: كل خدمة تُضاف فوق السعر', 'Off: every service is added on top of the price', 'ڕاگیراوە: هەر خزمەتگوزارییەک دەخرێتە سەر نرخەکە'],
  anchorHintOn: [
    'عند التفعيل: سعر كل طابعة مسجّلة كما يظهر في المتجر هو سعرها مع باقة «الاختيار الذكي». من يختار «الطابعة فقط» يدفع أقل (يُطرح سعر الباقة)، ومن يختار «التجربة الكاملة» يدفع الفرق فقط. من يشتري بلا اختيار تُحسب وتُسجَّل له باقة الاختيار الذكي.',
    'When on: every enrolled printer\'s price as the store shows it is its price WITH the «Smart Choice» package. A customer who picks «Printer only» pays less (the package\'s price is taken off); one who picks «Complete» pays only the difference. A purchase with no choice is priced and recorded as Smart Choice.',
    'کاتێک چالاکە: نرخی هەر پرینتەرێکی تۆمارکراو وەک لە فرۆشگا دەردەکەوێت، نرخەکەیەتی لەگەڵ پاکێجی «هەڵبژاردنی زیرەک». ئەو کڕیارەی «تەنها پرینتەر» هەڵدەبژێرێت کەمتر دەدات (نرخی پاکێجەکە لێی دەردەکرێت)، و ئەوەی «ئەزموونی تەواو» هەڵدەبژێرێت تەنها جیاوازییەکە دەدات. کڕینێک بەبێ هەڵبژاردن وەک هەڵبژاردنی زیرەک هەژمار و تۆمار دەکرێت.',
  ],
  anchorHintOff: [
    'عند الإيقاف: السعر المعروض للطابعة وحدها، وكل خدمة يختارها الزبون تُضاف فوقه.',
    'When off: the shown price is for the printer alone, and every service the customer picks is added on top of it.',
    'کاتێک ڕاگیراوە: نرخی پیشاندراو تەنها بۆ پرینتەرەکەیە، و هەر خزمەتگوزارییەک کڕیار هەڵیبژێرێت دەخرێتە سەری.',
  ],
  anchorExample: ['مثال من هذه الطابعة', 'An example from this printer', 'نموونەیەک لەم پرینتەرە'],
  anchorPriceWord: ['السعر', 'Price', 'نرخ'],
  anchorNeedsSmart: [
    'يحتاج باقة «الاختيار الذكي» مفعّلة ومسعّرة لعائلة هذه الطابعة.',
    'It needs the «Smart Choice» package switched on and priced for this printer\'s family.',
    'پێویستی بە پاکێجی «هەڵبژاردنی زیرەک» هەیە کە چالاک بێت و بۆ خێزانی ئەم پرینتەرە نرخی هەبێت.',
  ],
  anchorBelow: [
    'سعر هذه الطابعة أقل من سعر باقة الاختيار الذكي، فلا يُطبَّق عليها هذا الخيار: تُباع بسعرها والخدمات تُضاف فوقه.',
    'This printer\'s price is below the Smart Choice package, so this switch does not apply to it: it sells at its price with the services added on top.',
    'نرخی ئەم پرینتەرە لە نرخی پاکێجی هەڵبژاردنی زیرەک کەمترە، بۆیە ئەم هەڵبژاردەیە بۆی جێبەجێ نابێت: بە نرخی خۆی دەفرۆشرێت و خزمەتگوزارییەکان دەخرێنە سەری.',
  ],
  // phase 6: the warehouse pickup
  pickupSwitch: ['استلام من المخزن — مجاناً', 'Pick up from the warehouse — free', 'وەرگرتن لە کۆگا — بەخۆڕایی'],
  pickupHint: [
    'خيار ثالث بجانب الاقتصادي والشخصي، بلا رسوم توصيل. يُكمَل الطلب بطريقة «الاستلام من المتجر» في صفحة الدفع.',
    'A third choice beside Economy and Personal, with no delivery fee. The order is completed with the «store pickup» method at checkout.',
    'هەڵبژاردەی سێیەم لە تەنیشت ئابووری و تایبەت، بەبێ کرێی گەیاندن. داواکارییەکە لە پەڕەی پارەدان بە شێوازی «وەرگرتن لە فرۆشگا» تەواو دەکرێت.',
  ],
  pickupNoteTitle: ['سطر العنوان وساعات الاستلام (يظهر للزبون تحت الخيار)', 'Address and pickup hours line (shown to the customer under the choice)', 'دێڕی ناونیشان و کاتەکانی وەرگرتن (لە ژێر هەڵبژاردەکە بۆ کڕیار پیشان دەدرێت)'],
  pickupNoteRule: ['اكتبه بالعربية والإنجليزية والكردية معاً، أو اتركه فارغاً.', 'Write it in Arabic, English and Kurdish together, or leave it empty.', 'بە عەرەبی و ئینگلیزی و کوردی پێکەوە بینووسە، یان بە بەتاڵی بیهێڵەوە.'],
  pickupOn: ['الاستلام من المخزن: متاح', 'Warehouse pickup: offered', 'وەرگرتن لە کۆگا: بەردەستە'],

  // offers tab
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
  bundleNeedsMapping: ['اختر عائلة الضمان وفئة التوصيل أولاً في الخطوة 1.', 'Choose the warranty family and delivery class first in step 1.', 'سەرەتا لە هەنگاوی 1 خێزانی گەرەنتی و پۆلی گەیاندن هەڵبژێرە.'],
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
  id: ['الرمز الداخلي', 'Internal code', 'کۆدی ناوخۆیی'],
  idRule: ['الرمز الداخلي: حروف إنجليزية صغيرة وأرقام و _ أو -، حتى 32.', 'Internal code: lowercase letters, digits, _ or -, up to 32.', 'کۆدی ناوخۆیی: پیتی بچووکی ئینگلیزی، ژمارە، _ یان -، تا 32.'],
  idDup: ['رمزها الداخلي مستخدم لإضافة أخرى — غيّره من «خيارات متقدمة».', 'Its internal code is used by another add-on — change it under «Advanced».', 'کۆدە ناوخۆییەکەی بۆ زیادکراوێکی تر بەکارهاتووە — لە «هەڵبژاردەی پێشکەوتوو» بیگۆڕە.'],
  nameAr: ['الاسم بالعربية', 'Name in Arabic', 'ناو بە عەرەبی'],
  nameEn: ['الاسم بالإنجليزية', 'Name in English', 'ناو بە ئینگلیزی'],
  nameCkb: ['الاسم بالكردية', 'Name in Kurdish', 'ناو بە کوردی'],

  advanced: ['خيارات متقدمة', 'Advanced', 'هەڵبژاردەی پێشکەوتوو'],
  advancedHint: ['الرمز الداخلي والترتيب: لا يراهما الزبون، واتركهما كما هما إن لم تحتج.', 'The internal code and the order: customers never see them; leave them as they are unless you need to.', 'کۆدی ناوخۆیی و ڕیزبەندی: کڕیار نایانبینێت؛ ئەگەر پێویستت نییە وەک خۆیان بیانهێڵەوە.'],
  kitIdDup: ['رمزها الداخلي مستخدم لباقة أخرى — غيّره من «خيارات متقدمة».', 'Its internal code is used by another kit — change it under «Advanced».', 'کۆدە ناوخۆییەکەی بۆ پاکێجێکی تر بەکارهاتووە — لە «هەڵبژاردەی پێشکەوتوو» بیگۆڕە.'],
} as const satisfies Record<string, Tri>;

/** «باقة واحدة · إضافتان · 3 عروض مجمّعة»: what is sold with this printer, counted in words (never «1 باقات»). */
export function countLine(loc: Loc, kits: number, addons: number, bundles: number): string {
  if (kits + addons + bundles === 0) return loc('لا شيء بعد — اختياري', 'Nothing yet — optional', 'هێشتا هیچ نییە — ئارەزوومەندانەیە');
  const ar = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);
  const en = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    kits ? loc(ar(kits, 'باقة واحدة', 'باقتان', 'باقات', 'باقة'), en(kits, 'kit', 'kits'), `${kits} پاکێج`) : '',
    addons ? loc(ar(addons, 'إضافة واحدة', 'إضافتان', 'إضافات', 'إضافة'), en(addons, 'add-on', 'add-ons'), `${addons} زیادکراو`) : '',
    bundles ? loc(ar(bundles, 'عرض مجمّع واحد', 'عرضان مجمّعان', 'عروض مجمّعة', 'عرضاً مجمّعاً'), en(bundles, 'store bundle', 'store bundles'), `${bundles} پاکێجی کۆکراوە`) : '',
  ].filter(Boolean).join(' · ');
}

/** The two ready packages by the names the customer reads. */
export const pkgName = (id: 'smart' | 'complete'): Tri => (id === 'smart'
  ? ['الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک']
  : ['التجربة الكاملة', 'Complete', 'ئەزموونی تەواو']);

/** What a ready package contains, in words — never the stored codes (w12, c12, extra, full). */
export function packageContents(p: { warranty: WarrantyChoice; care: CareChoice; packaging: string; inspection: string }, loc: Loc): string[] {
  const total = careTotalMonths(p.warranty, p.care);
  return [
    p.warranty === 'w24' ? loc('ضمان 24 شهراً', '24-month warranty', 'گەرەنتی 24 مانگ') : p.warranty === 'w12' ? loc('ضمان 12 شهراً', '12-month warranty', 'گەرەنتی 12 مانگ') : loc('بلا ضمان', 'no warranty', 'بێ گەرەنتی'),
    p.care === 'c12' ? loc(`ليفو كير (التغطية الكلية ${total} شهراً)`, `Levo Care (${total} months of cover in total)`, `لیڤۆ کێر (کۆی داپۆشین ${total} مانگ)`) : null,
    p.packaging === 'extra' ? loc('تغليف حماية إضافية', 'extra-protection packaging', 'پێچانەوەی پاراستنی زیادە') : loc('تغليف عادي', 'standard packaging', 'پێچانەوەی ئاسایی'),
    p.inspection === 'full' ? loc('فحص قبل الشحن', 'pre-dispatch inspection', 'پشکنین پێش ناردن') : null,
  ].filter((x): x is string => !!x);
}

/** «مشتركة مع N طابعات أخرى»: a kit / add-on that a list of printers shares with this one — counted, never named. */
export function sharedWithOthers(n: number): Tri {
  const ar = n === 1 ? 'مشتركة مع طابعة أخرى' : n === 2 ? 'مشتركة مع طابعتين أخريين' : n <= 10 ? `مشتركة مع ${n} طابعات أخرى` : `مشتركة مع ${n} طابعة أخرى`;
  return [ar, n === 1 ? 'Shared with 1 other printer' : `Shared with ${n} other printers`, `هاوبەشە لەگەڵ ${n} پرینتەری تر`];
}

/** The customer-facing discount on one printer's worth of a kit or add-on, from an estimated price. */
export function discountPreview(d: PrinterDiscount | null | undefined, beforeIqd: number | null): { before: number; after: number; pct: number } | null {
  if (!d || beforeIqd === null || beforeIqd <= 0) return null;
  // One printer's worth as one unit: the same rule (and the same 90% cap) the cart applies per unit.
  const off = unitDiscount(d, beforeIqd, 1);
  return { before: beforeIqd, after: beforeIqd - off, pct: Math.round((off * 100) / beforeIqd) };
}
