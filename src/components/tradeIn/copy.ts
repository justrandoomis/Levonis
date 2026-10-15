/**
 * «استبدل جهازك» — EVERY WORD OF THE CUSTOMER'S TRADE-IN SCREENS, in Arabic,
 * English and Sorani (Services S-P2 spec §11.1 and trade-in design B.11,
 * adopted verbatim; DECISIONS row 183: a Sorani slot is its own sentence,
 * never the Arabic copied — tests/sv2_p2_strings.test.ts holds that).
 *
 * `{name}` marks a value the screen fills in (a date, a figure, a count).
 * Pure data: no React, so the strings test reads it as it is.
 */
import type { Language } from '../../translations';

export type Tri = readonly [ar: string, en: string, ckb: string];

export const COPY = {
  // ------------------------------------------------------------ the page
  title: ['استبدل جهازك', 'Trade in your device', 'ئامێرەکەت بگۆڕەوە'],
  requestTitle: ['طلب الاستبدال', 'Trade-in request', 'داواکاریی گۆڕینەوە'],
  back: ['رجوع', 'Back', 'گەڕانەوە'],
  promise: ['بعرض واضح قبل الإرسال', 'With a clear offer before you send', 'بە پێشنیارێکی ڕوون پێش ناردن'],
  'intro.line': ['جهازك من LEVONIS يصبح رصيداً لجهاز جديد', 'Your LEVONIS device becomes credit for a new one', 'ئامێرەکەت لە LEVONIS دەبێتە باڵانس بۆ ئامێرێکی نوێ'],
  'intro.only': [
    'للطابعات وأجهزة الليزر ووحدات AMS المشتراة من LEVONIS فقط.',
    'For printers, lasers and AMS units bought from LEVONIS only.',
    'تەنها بۆ ئەو چاپکەر و ئامێری لەیزەر و یەکە AMS ـانەی لە LEVONIS کڕدراون.',
  ],
  signIn: ['سجّل الدخول للبدء', 'Sign in to start', 'بۆ دەستپێکردن بچۆ ژوورەوە'],
  retry: ['إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە'],
  close: ['إغلاق', 'Close', 'داخستن'],
  continue: ['متابعة', 'Continue', 'بەردەوام بە'],
  stepOf: ['الخطوة {n} من {total}', 'Step {n} of {total}', 'هەنگاوی {n} لە {total}'],
  genericError: ['حدث خطأ. حاول مرة أخرى.', 'Something went wrong. Try again.', 'هەڵەیەک ڕوویدا. دووبارە هەوڵ بدەرەوە.'],

  // ------------------------------------------------------------ how it works
  howItWorks: ['كيف يعمل؟', 'How it works', 'چۆن کاردەکات؟'],
  'how.title': ['كيف يعمل الاستبدال', 'How trade-in works', 'گۆڕینەوە چۆن کاردەکات'],
  'how.1': ['اختر جهازك', 'Pick your device', 'ئامێرەکەت هەڵبژێرە'],
  'how.1d': [
    'من طلباتك السابقة؛ نملأ التاريخ والضمان تلقائياً.',
    'From your past orders; we fill in the dates and the warranty.',
    'لە داواکارییەکانی پێشووت؛ بەروار و گەرەنتی خۆکارانە پڕ دەکەینەوە.',
  ],
  'how.2': ['صف حالته', 'Describe it', 'دۆخەکەی باس بکە'],
  'how.2d': [
    'الساعات والحالة والصور: صورة لشاشة الساعات وصورة لكل ضرر.',
    'Hours, condition and photos: one of the hours screen and one for each damage.',
    'کاتژمێر و دۆخ و وێنە: وێنەیەک بۆ شاشەی کاتژمێرەکان و یەکێک بۆ هەر زیانێک.',
  ],
  'how.3': ['اختر الجديد', 'Choose the new one', 'نوێیەکە هەڵبژێرە'],
  'how.3d': [
    'ترى عرضنا قبل الإرسال، وهو أعلى ما ندفعه.',
    'You see our offer before you send; it is the most we pay.',
    'پێش ناردن پێشنیارەکەمان دەبینیت؛ ئەوە زۆرترینە کە دەیدەین.',
  ],
  'how.4': ['سلّمه', 'Hand it in', 'ڕادەستی بکە'],
  'how.4d': [
    'في المتجر أو نستلمه منك، فنفحصه ونطابق رقمه التسلسلي.',
    'At the store, or we collect it; we inspect it and match its serial.',
    'لە فرۆشگا، یان دێین وەریدەگرین؛ دەیپشکنین و ژمارە زنجیرەییەکەی بەراورد دەکەین.',
  ],
  'how.5': ['اشترِ بالرصيد', 'Buy with the credit', 'بە باڵانسەکە بیکڕە'],
  'how.5d': [
    'رصيد لمدة محدودة يُخصم من الجهاز الجديد، ولا يُصرف نقداً.',
    'A credit for a limited time, taken off the new device, never paid in cash.',
    'باڵانسێک بۆ ماوەیەکی دیاریکراو، لە نرخی ئامێرە نوێیەکە کەم دەکرێتەوە و بە نەقد نادرێت.',
  ],

  // ------------------------------------------------------------ 1 «أجهزتك»
  'tab.devices': ['أجهزتي', 'My devices', 'ئامێرەکانم'],
  'tab.requests': ['طلباتي للاستبدال', 'My trade-ins', 'داواکارییەکانی گۆڕینەوەم'],
  search: ['ابحث باسم الجهاز أو رقم الطلب', 'Search devices or orders', 'بە ناوی ئامێر یان ژمارەی داواکاری بگەڕێ'],
  clearSearch: ['مسح البحث', 'Clear the search', 'سڕینەوەی گەڕان'],
  orderNo: ['طلب #{id}', 'Order #{id}', 'داواکاری #{id}'],
  delivered: ['استُلم {date}', 'Delivered {date}', 'لە {date} گەیەندرا'],
  warrantyLeft: ['الضمان المتبقي: {n}', 'Warranty left: {n}', 'گەرەنتیی ماوە: {n}'],
  warrantyOver: ['انتهى الضمان', 'Warranty ended', 'گەرەنتی کۆتایی هات'],
  empty: ['لا توجد طابعات أو أجهزة في طلباتك بعد', 'No printers or devices in your orders yet', 'هێشتا هیچ چاپکەر یان ئامێرێک لە داواکارییەکانتدا نییە'],
  emptyHint: [
    'الاستبدال للطابعات وأجهزة الليزر ووحدات AMS المشتراة من LEVONIS بعد استلامها.',
    'Trade-in is for printers, lasers and AMS units bought from LEVONIS, once delivered.',
    'گۆڕینەوە بۆ ئەو چاپکەر و ئامێری لەیزەر و یەکە AMS ـانەیە کە لە LEVONIS کڕدراون و گەیەندراون.',
  ],
  noResults: ['لا نتائج لـ «{q}»', 'No results for “{q}”', 'هیچ ئەنجامێک بۆ «{q}» نییە'],
  requestsEmpty: ['لا توجد طلبات استبدال بعد.', 'No trade-in requests yet.', 'هێشتا هیچ داواکارییەکی گۆڕینەوە نییە.'],
  loadError: ['تعذّر تحميل أجهزتك.', 'Could not load your devices.', 'ئامێرەکانت بار نەکران.'],
  'reason.claimedOpen': ['ضمن طلب استبدال قائم', 'In an open trade-in', 'لە داواکارییەکی کراوەی گۆڕینەوەدایە'],
  'reason.claimed': ['استُبدل سابقاً', 'Already traded in', 'پێشتر گۆڕدراوەتەوە'],
  'reason.return': ['عليه طلب إرجاع', 'Has a return case', 'داواکاریی گەڕاندنەوەی لەسەرە'],
  'reason.below': ['أقل من الحد الأدنى للاستبدال', 'Below the trade-in minimum', 'لە کەمترین سنووری گۆڕینەوە کەمترە'],
  'reason.notDelivered': ['لم يُستلم بعد', 'Not delivered yet', 'هێشتا نەگەیەندراوە'],
  'reason.gift': ['وصلك هدية — الاستبدال للأجهزة المشتراة', 'A gift — trade-in is for devices you bought', 'دیارییە — گۆڕینەوە بۆ ئامێرە کڕدراوەکانە'],
  'reason.linked': ['مربوط بحساب آخر — يُفكّ ربطه أولاً', 'Linked to another account — release it first', 'بە هەژمارێکی ترەوە بەستراوە — سەرەتا جیای بکەرەوە'],
  'reason.service': ['عليه طلب ضمان أو صيانة مفتوح', 'Has an open warranty or repair request', 'داواکاریی گەرەنتی یان چاککردنەوەی کراوەی لەسەرە'],
  'reason.protection': ['عليه مطالبة حماية سعر قيد المراجعة', 'Has a price-protection claim under review', 'داواکاریی پاراستنی نرخی لەسەرە کە لە پێداچوونەوەدایە'],
  'reason.inShop': ['الجهاز لدينا ضمن طلب استبدال', 'This device is with us for a trade-in', 'ئەم ئامێرە لای ئێمەیە بۆ گۆڕینەوە'],
  'reason.other': ['غير متاح للاستبدال', 'Not available for trade-in', 'بۆ گۆڕینەوە بەردەست نییە'],
  'reason.scope': ['غير متاح لهذا الجهاز', 'Not available for this device', 'بۆ ئەم ئامێرە بەردەست نییە'],

  // ------------------------------------------------------------ 2 «ماذا تستبدل؟»
  'scope.q': ['ماذا تستبدل؟', 'What are you trading in?', 'چی دەگۆڕیتەوە؟'],
  'scope.whole': ['الطابعة مع الـ AMS', 'Printer with AMS', 'چاپکەر لەگەڵ AMS'],
  'scope.printer': ['الطابعة فقط', 'Printer only', 'تەنها چاپکەر'],
  'scope.ams': ['الـ AMS فقط', 'AMS only', 'تەنها AMS'],
  'scope.wholeDevice': ['الجهاز كاملاً', 'The whole device', 'ئامێرەکە بە تەواوی'],
  'scope.wholeHint': ['الطابعة ووحدة AMS معاً', 'The printer and its AMS together', 'چاپکەرەکە و AMS ـەکەی پێکەوە'],
  'scope.printerHint': ['تحتفظ بوحدة AMS', 'You keep the AMS', 'AMS ـەکە لای خۆت دەمێنێتەوە'],
  'scope.amsHint': ['تحتفظ بالطابعة', 'You keep the printer', 'چاپکەرەکە لای خۆت دەمێنێتەوە'],

  // ------------------------------------------------------------ 3 «حالة الجهاز»
  'cond.title': ['حالة الجهاز', 'The device’s condition', 'دۆخی ئامێرەکە'],
  'part.device': ['الطابعة', 'Printer', 'چاپکەر'],
  'part.ams': ['الـ AMS', 'The AMS', 'AMS ـەکە'],
  'part.other': ['الجهاز', 'Device', 'ئامێر'],
  parts: ['أجزاء الجهاز', 'Parts of the device', 'بەشەکانی ئامێرەکە'],
  'hours.q': ['كم ساعة طُبعت عليها؟', 'How many hours has it printed?', 'چەند کاتژمێر چاپی پێکراوە؟'],
  'hours.qLaser': ['كم ساعة عمل عليها؟', 'How many hours has it worked?', 'چەند کاتژمێر کاری پێکراوە؟'],
  'hours.unit': ['ساعة', 'hours', 'کاتژمێر'],
  'hours.hint': ['تجدها في إعدادات الشاشة أو التطبيق («وقت الطباعة»).', 'In the screen settings or the app (“print time”).', 'لە ڕێکخستنەکانی شاشە یان ئەپەکەدا («کاتی چاپ»).'],
  'hours.photo': ['صوّر شاشة ساعات التشغيل', 'Photograph the hours screen', 'وێنەی شاشەی کاتژمێرەکانی کارکردن بگرە'],
  'photo.hoursBound': ['صورة الساعات مطلوبة مع الرقم', 'The hours photo is required with the number', 'وێنەی کاتژمێرەکان لەگەڵ ژمارەکە پێویستە'],
  'cond.q': ['الحالة العامة', 'Overall condition', 'دۆخی گشتی'],
  'cond.excellent': ['ممتازة', 'Excellent', 'نایاب'],
  'cond.good': ['جيدة', 'Good', 'باش'],
  'cond.care': ['تحتاج عناية', 'Needs care', 'پێویستی بە چاودێرییە'],
  'cond.excellentHint': ['نظيفة وبلا خدوش تُذكر', 'Clean, barely a scratch', 'پاک و بە زەحمەت ڕووشانێکی هەیە'],
  'cond.goodHint': ['آثار استخدام عادية', 'Normal signs of use', 'شوێنەواری ئاسایی بەکارهێنان'],
  'cond.careHint': ['خدوش أو اتساخ واضح', 'Visible scratches or dirt', 'ڕووشان یان پیسیی دیار'],
  'damage.q': ['هل فيها أي ضرر أو عطل؟', 'Any damage or fault?', 'هیچ زیان یان تێکچوونێکی هەیە؟'],
  'damage.none': ['لا يوجد ضرر', 'No damage', 'هیچ زیانێک نییە'],
  'damage.yes': ['نعم', 'Yes', 'بەڵێ'],
  'damage.pick': ['اختر ما ينطبق، وأضف صورة لكل واحد', 'Pick what applies, with a photo for each', 'ئەوەی دەگونجێت هەڵبژێرە، بە وێنەیەک بۆ هەر یەکێک'],
  'damage.photo': ['أضف صورة للضرر', 'Add a photo of the damage', 'وێنەیەکی زیانەکە زیاد بکە'],
  'photo.perDamage': ['أضف صورة لكل ضرر اخترته', 'Add a photo for each damage you ticked', 'بۆ هەر زیانێک کە هەڵتبژاردووە وێنەیەک زیاد بکە'],
  'replaced.q': ['هل استُبدلت قطع فيها؟', 'Were any parts replaced?', 'هیچ پارچەیەکی گۆڕدراوە؟'],
  'replaced.none': ['لا شيء', 'None', 'هیچ'],
  'acc.q': ['الملحقات الأصلية', 'Original accessories', 'پاشکۆ ڕەسەنەکان'],
  'acc.all': ['كاملة', 'All', 'هەموویان'],
  'acc.some': ['بعضها', 'Some', 'هەندێکیان'],
  'acc.none': ['لا يوجد', 'None', 'هیچیان'],
  'photos.title': ['صور الجهاز', 'Photos of the device', 'وێنەکانی ئامێرەکە'],
  'photos.private': [
    'الصور خاصة: تراها أنت وفريق الفحص فقط.',
    'Photos are private: only you and the inspection team see them.',
    'وێنەکان تایبەتن: تەنها تۆ و تیمی پشکنین دەیانبینن.',
  ],
  'photo.take': ['صوّر', 'Take a photo', 'وێنە بگرە'],
  'photo.retake': ['أضف أخرى', 'Add another', 'یەکێکی تر زیاد بکە'],
  'photo.remove': ['حذف الصورة', 'Remove the photo', 'سڕینەوەی وێنەکە'],
  'photo.uploading': ['يُرفع… {p}%', 'Uploading… {p}%', 'بار دەکرێت… {p}%'],
  'photo.failed': ['تعذّر رفع الصورة.', 'Could not upload the photo.', 'وێنەکە بار نەکرا.'],
  'photo.done': ['تمّت', 'Done', 'تەواو'],
  'notes.label': ['ملاحظات (اختياري)', 'Notes (optional)', 'تێبینی (ئارەزوومەندانە)'],
  'missing.title': ['قبل المتابعة:', 'Before you continue:', 'پێش بەردەوامبوون:'],
  'missing.condition': ['اختر الحالة العامة', 'Choose the overall condition', 'دۆخی گشتی هەڵبژێرە'],
  'missing.hours': ['اكتب عدد ساعات التشغيل', 'Type the hours it has run', 'ژمارەی کاتژمێرەکانی کارکردن بنووسە'],
  'missing.accessories': ['اختر حال الملحقات الأصلية', 'Choose what is left of the original accessories', 'دۆخی پاشکۆ ڕەسەنەکان هەڵبژێرە'],
  'missing.answer': ['أكمل: {x}', 'Complete: {x}', 'تەواوی بکە: {x}'],
  'missing.damagePick': ['اختر الضرر أو «لا يوجد ضرر»', 'Pick the damage, or “No damage”', 'زیانەکە هەڵبژێرە، یان «هیچ زیانێک نییە»'],
  'missing.damagePhoto': ['صورة لـ «{x}»', 'A photo of “{x}”', 'وێنەیەک بۆ «{x}»'],
  'missing.angle': ['صورة: {x}', 'Photo: {x}', 'وێنە: {x}'],
  'missing.otherPart': ['أكمل الجزء الآخر أيضاً', 'Complete the other part too', 'بەشەکەی تریش تەواو بکە'],
  'next.ams': ['التالي: حالة الـ AMS', 'Next: the AMS', 'دواتر: دۆخی AMS ـەکە'],
  saveError: ['تعذّر الحفظ. حاول مرة أخرى.', 'Could not save. Try again.', 'پاشەکەوت نەکرا. دووبارە هەوڵ بدەرەوە.'],

  // ------------------------------------------------------------ 4 «الجهاز الجديد»
  'target.q': ['اختر الجهاز الجديد', 'Choose your new device', 'ئامێرە نوێیەکەت هەڵبژێرە'],
  'target.search': ['ابحث عن الطابعة التي تريدها', 'Search for the printer you want', 'بەدوای ئەو چاپکەرەدا بگەڕێ کە دەتەوێت'],
  'target.only': ['أجهزة متوفرة للبيع المباشر فقط', 'Only devices in stock for direct sale', 'تەنها ئامێرە بەردەستەکان بۆ فرۆشتنی ڕاستەوخۆ'],
  'target.more': ['المزيد', 'More', 'زیاتر'],
  'target.from': ['يبدأ من {x}', 'From {x}', 'دەست پێدەکات لە {x}'],
  'target.model': ['الموديل', 'Model', 'مۆدێل'],
  'target.colour': ['اللون', 'Colour', 'ڕەنگ'],
  'target.price': ['سعر البيع المباشر', 'Direct-sale price', 'نرخی فرۆشتنی ڕاستەوخۆ'],
  'target.choose': ['اختر الخيارات', 'Choose the options', 'هەڵبژاردەکان دیاری بکە'],
  'target.confirm': ['اعتمد هذا الجهاز', 'Use this device', 'ئەم ئامێرە بەکاربهێنە'],
  'target.change': ['غيّر', 'Change', 'بیگۆڕە'],
  'target.none': ['لا أجهزة تطابق «{q}»', 'No devices match “{q}”', 'هیچ ئامێرێک لەگەڵ «{q}» ناگونجێت'],
  'target.featured': ['أجهزة مقترحة', 'Suggested devices', 'ئامێرە پێشنیارکراوەکان'],
  'target.results': ['النتائج: {n}', 'Results: {n}', 'ئەنجامەکان: {n}'],
  'target.loadError': ['تعذّر تحميل الأجهزة.', 'Could not load the devices.', 'ئامێرەکان بار نەکران.'],
  'target.empty': ['لم تختر جهازاً بعد', 'You have not chosen a device yet', 'هێشتا ئامێرێکت هەڵنەبژاردووە'],
  'target.allResults': ['كل النتائج', 'All results', 'هەموو ئەنجامەکان'],

  // ------------------------------------------------------------ 5 «عرضك»
  'offer.title': ['عرضنا لجهازك', 'Our offer for your device', 'پێشنیارەکەمان بۆ ئامێرەکەت'],
  'offer.upTo': ['حتى {x}', 'Up to {x}', 'تا {x}'],
  'offer.refresh': ['حدّث العرض', 'Refresh the offer', 'پێشنیارەکە نوێ بکەرەوە'],
  'offer.computing': ['نحسب عرضك…', 'Working out your offer…', 'پێشنیارەکەت حیساب دەکەین…'],
  'offer.limit': [
    'لا عروض متبقية لهذا الطلب؛ يُحسب العرض عند الإرسال ويظهر في صفحة الطلب.',
    'No offers left for this request; the offer is worked out when you send it and shows on the request page.',
    'هیچ پێشنیارێک بۆ ئەم داواکارییە نەماوە؛ پێشنیارەکە لە کاتی ناردندا حیساب دەکرێت و لە پەڕەی داواکارییەکەدا دەردەکەوێت.',
  ],
  'offer.noOffer': ['لا نستطيع تقديم عرض لهذا الجهاز حالياً.', 'We can’t make an offer for this device right now.', 'لە ئێستادا ناتوانین پێشنیار بۆ ئەم ئامێرە بکەین.'],
  'offer.noOfferHint': [
    'لا يُرسل طلب بلا عرض. جرّب لاحقاً أو تواصل معنا.',
    'A request is not sent without an offer. Try later, or contact us.',
    'داواکاری بێ پێشنیار نانێردرێت. دواتر هەوڵ بدەرەوە، یان پەیوەندیمان پێوە بکە.',
  ],
  'offer.contact': ['تواصل معنا', 'Contact us', 'پەیوەندیمان پێوە بکە'],
  'offer.credit': ['رصيد الاستبدال', 'Trade-in credit', 'باڵانسی گۆڕینەوە'],
  'offer.pay': ['تدفع للجهاز الجديد', 'You pay for the new device', 'بۆ ئامێرە نوێیەکە دەدەیت'],
  'offer.delivery': ['+ التوصيل', '+ delivery', '+ گەیاندن'],
  'offer.valid': ['العرض صالح حتى {date}', 'Offer valid until {date}', 'پێشنیارەکە تا {date} بەردەوامە'],
  'offer.final': [
    'القيمة النهائية بعد فحص الجهاز في المتجر، ولن تزيد على هذا العرض',
    'The final value follows our in-store inspection and will not exceed this offer',
    'بەهای کۆتایی دوای پشکنینی ئامێرەکە لە فرۆشگا دیاری دەکرێت و لەم پێشنیارە زیاتر نابێت',
  ],
  'credit.note': [
    'رصيد يُخصم من الجهاز الجديد فقط، ولا يُصرف نقداً',
    'Credit toward the new device only, never paid out in cash',
    'باڵانسێکە تەنها لە نرخی ئامێرە نوێیەکە کەم دەکرێتەوە و بە پارەی نەقد نادرێت',
  ],
  'offer.excess': [
    'قيمة جهازك أعلى من الجديد؛ الفرق لا يُدفع',
    'Your device is worth more than the new one; the difference is not paid out',
    'بەهای ئامێرەکەت لە نوێیەکە زیاترە؛ جیاوازییەکە نادرێت',
  ],
  'offer.fee': ['أجرة الاستلام', 'Collection fee', 'کرێی وەرگرتن'],
  'handover.title': ['كيف تسلّم جهازك؟', 'How will you hand in your device?', 'چۆن ئامێرەکەت ڕادەست دەکەیت؟'],
  'handover.store': ['سلّمه في المتجر', 'Hand it in at the store', 'لە فرۆشگا ڕادەستی بکە'],
  'handover.storeHint': ['بلا أجرة', 'No fee', 'بێ کرێ'],
  'handover.pickup': ['اطلب أن نستلمه منك', 'Ask us to collect it', 'داوا بکە بێین وەریبگرین'],
  'handover.fee': ['تُخصم أجرة الاستلام {fee} من الرصيد', 'A collection fee of {fee} comes off the credit', 'کرێی وەرگرتن {fee} لە باڵانسەکە کەم دەکرێتەوە'],
  'handover.contact': ['نتواصل معك لتحديد الموعد', 'We will contact you to set a time', 'پەیوەندیت پێوە دەکەین بۆ دیاریکردنی کات'],
  send: ['أرسل الطلب', 'Send request', 'داواکارییەکە بنێرە'],
  sendError: ['تعذّر الإرسال. حاول مرة أخرى.', 'Could not send. Try again.', 'نەنێردرا. دووبارە هەوڵ بدەرەوە.'],
  'offer.backToCondition': ['عُد إلى حالة الجهاز', 'Back to the condition', 'بگەڕێوە بۆ دۆخی ئامێرەکە'],

  // ------------------------------------------------------------ the request page
  'tl.title': ['مراحل الطلب', 'Where it stands', 'قۆناغەکانی داواکاری'],
  'st.sent': ['أُرسل الطلب', 'Request sent', 'داواکارییەکە نێردرا'],
  'st.awaitDevice': ['بانتظار جهازك', 'Waiting for your device', 'چاوەڕێی ئامێرەکەتین'],
  'st.received': ['استلمنا جهازك وفحصناه', 'We received and inspected your device', 'ئامێرەکەتمان وەرگرت و پشکنیمان'],
  'st.final': ['القيمة النهائية', 'Final value', 'بەهای کۆتایی'],
  'st.creditReady': ['رصيد الاستبدال جاهز حتى {date}', 'Your trade-in credit is ready until {date}', 'باڵانسی گۆڕینەوەکەت تا {date} ئامادەیە'],
  'st.creditReadyShort': ['رصيد الاستبدال جاهز', 'Your trade-in credit is ready', 'باڵانسی گۆڕینەوەکەت ئامادەیە'],
  'st.awaitNew': ['بانتظار وصول الجهاز الجديد', 'Waiting for your new device to arrive', 'چاوەڕێی گەیشتنی ئامێرە نوێیەکەین'],
  'st.completed': ['اكتمل الاستبدال', 'Trade-in complete', 'گۆڕینەوەکە تەواو بوو'],
  'st.reissued': ['عاد رصيد الاستبدال حتى {date}', 'Your trade-in credit is back until {date}', 'باڵانسی گۆڕینەوەکەت تا {date} گەڕایەوە'],
  'st.reissuedAny': [
    'يُصرف على أي جهاز متوفر للبيع المباشر، ولا يُصرف نقداً',
    'Usable on any device in stock for direct sale, never as cash',
    'بۆ هەر ئامێرێکی بەردەست بۆ فرۆشتنی ڕاستەوخۆ بەکاردێت، نەک وەک پارەی نەقد',
  ],
  'st.creditExpired': ['انتهت صلاحية رصيد الاستبدال', 'The trade-in credit expired', 'ماوەی باڵانسی گۆڕینەوەکە بەسەرچوو'],
  'st.expired': ['انتهت صلاحية العرض', 'The offer expired', 'ماوەی پێشنیارەکە بەسەرچوو'],
  'st.expiredHint': [
    'أنشئ طلباً جديداً لتحصل على عرض بأسعار اليوم.',
    'Open a new request for an offer at today’s prices.',
    'داواکارییەکی نوێ بکەرەوە بۆ پێشنیارێک بە نرخەکانی ئەمڕۆ.',
  ],
  'st.collect': ['جهازك جاهز للاستلام من المتجر', 'Your device is ready to collect from the store', 'ئامێرەکەت ئامادەیە بۆ وەرگرتنەوە لە فرۆشگا'],
  'st.cancelled': ['ملغى', 'Cancelled', 'هەڵوەشێنرایەوە'],
  'st.rejected': ['رفضت القيمة', 'You declined the value', 'بەهاکەت ڕەت کردەوە'],
  'tl.offer': ['عرضنا: حتى {x}', 'Our offer: up to {x}', 'پێشنیارەکەمان: تا {x}'],
  'tl.handIn': ['سلّم جهازك قبل {date}', 'Hand in your device by {date}', 'ئامێرەکەت پێش {date} ڕادەست بکە'],
  'tl.handover': ['سلّمه في المتجر أو اطلب أن نستلمه منك', 'Hand it over at the store or ask us to collect it', 'لە فرۆشگا ڕادەستی بکە یان داوا بکە بێین وەریبگرین'],
  'tl.serialOk': ['طابق رقمه التسلسلي الجهاز المباع', 'Its serial matches the device sold', 'ژمارە زنجیرەییەکەی لەگەڵ ئامێرە فرۆشراوەکە دەگونجێت'],
  'tl.newValue': ['قيمة جديدة لجهازك', 'A new value for your device', 'بەهایەکی نوێ بۆ ئامێرەکەت'],
  'tl.newValueHint': [
    'فحصنا جهازك والقيمة أقل من العرض. اقبلها لنكمل، أو ارفضها ونعيد لك جهازك.',
    'We inspected your device and the value is below the offer. Accept to continue, or decline and we hand your device back.',
    'ئامێرەکەتمان پشکنی و بەهاکە لە پێشنیارەکە کەمترە. قبووڵی بکە بۆ ئەوەی بەردەوام بین، یان ڕەتی بکەرەوە و ئامێرەکەت دەدەینەوە.',
  ],
  'tl.reason': ['السبب: {x}', 'Reason: {x}', 'هۆکار: {x}'],
  accept: ['أوافق على القيمة', 'Accept the value', 'بەهاکە قبووڵ دەکەم'],
  reject: ['أرفض', 'Decline', 'ڕەتی دەکەمەوە'],
  'reject.title': ['رفض القيمة الجديدة؟', 'Decline the new value?', 'بەها نوێیەکە ڕەت دەکەیتەوە؟'],
  'reject.body': [
    'يُغلق الطلب ونعيد لك جهازك من المتجر.',
    'The request closes and we hand your device back at the store.',
    'داواکارییەکە دادەخرێت و ئامێرەکەت لە فرۆشگا دەدەینەوە.',
  ],
  'act.buy': ['أكمل الشراء', 'Complete the purchase', 'کڕینەکە تەواو بکە'],
  'act.chooseDevice': ['اختر الجهاز الجديد', 'Choose the new device', 'ئامێرە نوێیەکە هەڵبژێرە'],
  'tl.yourOrder': ['طلب الشراء', 'Your order', 'داواکاریی کڕینەکەت'],
  'tl.credit': ['الرصيد', 'Credit', 'باڵانس'],
  cartConflict: [
    'في سلتك منتجات بنوع شحن آخر أو من متجر آخر، والجهاز الجديد بيع مباشر من LEVONIS.',
    'Your cart holds items shipped another way or from another store; the new device is a direct LEVONIS sale.',
    'سەبەتەکەت بەرهەمی تێدایە بە جۆرێکی تری ناردن یان لە فرۆشگایەکی ترەوە، و ئامێرە نوێیەکە فرۆشتنی ڕاستەوخۆی LEVONIS ـە.',
  ],
  emptyCart: ['أفرغ السلة وتابع', 'Empty the cart and continue', 'سەبەتەکە بەتاڵ بکە و بەردەوام بە'],
  'cancel.btn': ['إلغاء الطلب', 'Cancel the request', 'هەڵوەشاندنەوەی داواکاری'],
  'cancel.title': ['إلغاء طلب الاستبدال؟', 'Cancel this trade-in?', 'ئەم گۆڕینەوەیە هەڵدەوەشێنیتەوە؟'],
  'cancel.body': [
    'لن نكمل هذا الطلب، ويعود جهازك متاحاً لطلب جديد.',
    'We will not continue this request, and your device is free for a new one.',
    'ئەم داواکارییە تەواو ناکەین، و ئامێرەکەت بۆ داواکارییەکی نوێ ئامادە دەبێتەوە.',
  ],
  'cancel.bodyInShop': [
    'لن نكمل هذا الطلب، ونعيد لك جهازك من المتجر.',
    'We will not continue this request, and we hand your device back at the store.',
    'ئەم داواکارییە تەواو ناکەین، و ئامێرەکەت لە فرۆشگا دەدەینەوە.',
  ],
  'cancel.reason': ['سبب الإلغاء: {x}', 'Cancelled: {x}', 'هۆکاری هەڵوەشاندنەوە: {x}'],
  'draft.title': ['الطلب لم يُرسل بعد', 'Not sent yet', 'داواکارییەکە هێشتا نەنێردراوە'],
  'draft.continue': ['أكمل الطلب', 'Continue the request', 'داواکارییەکە تەواو بکە'],
  loadRequestError: ['تعذّر تحميل الطلب.', 'Could not load the request.', 'داواکارییەکە بار نەکرا.'],
  'tl.now': ['الآن', 'Now', 'ئێستا'],
  'tl.done': ['تمّ', 'Done', 'کرا'],
  'tl.next': ['لاحقاً', 'Later', 'دواتر'],
  thanks: ['شكراً لثقتك بـ LEVONIS.', 'Thank you for trusting LEVONIS.', 'سوپاس بۆ متمانەت بە LEVONIS.'],

  // ------------------------------------------------------------ entries
  'entry.title': ['لديك جهاز قديم؟ استبدله بهذا', 'Have an old device? Trade it in for this one', 'ئامێرێکی کۆنت هەیە؟ بیگۆڕەوە بەمە'],
  'entry.sub': ['ترى عرضنا قبل الإرسال', 'You see our offer before you send', 'پێش ناردن پێشنیارەکەمان دەبینیت'],
  'services.title': ['خدماتي', 'My services', 'خزمەتگوزارییەکانم'],
  'services.devices': ['أجهزتي والضمان', 'My devices and warranty', 'ئامێرەکانم و گەرەنتی'],
  'services.tradeIn': ['الاستبدال', 'Trade-in', 'گۆڕینەوە'],
  'services.noCases': ['لا طلبات مفتوحة', 'No open requests', 'هیچ داواکارییەکی کراوە نییە'],
  'services.nothing': ['استبدل جهازك القديم بجديد', 'Trade your old device for a new one', 'ئامێرە کۆنەکەت بە نوێ بگۆڕەوە'],
  'next.handIn': ['سلّم جهازك قبل {date}', 'Hand in your device by {date}', 'ئامێرەکەت پێش {date} ڕادەست بکە'],
  'next.handInNow': ['سلّم جهازك', 'Hand in your device', 'ئامێرەکەت ڕادەست بکە'],
  'next.decide': ['قرارك مطلوب', 'Your decision is needed', 'بڕیاری تۆ پێویستە'],
  'next.pay': ['رصيدك جاهز', 'Your credit is ready', 'باڵانسەکەت ئامادەیە'],
  'next.collect': ['استلم جهازك من المتجر', 'Collect your device from the store', 'ئامێرەکەت لە فرۆشگا وەربگرەوە'],
  'next.reissued': ['عاد رصيدك حتى {date}', 'Your credit is back until {date}', 'باڵانسەکەت تا {date} گەڕایەوە'],
} as const satisfies Record<string, Tri>;

/**
 * COUNTED SENTENCES (review F-26): the count decides the words. Arabic: none / one / two / 3–10
 * (plural) / 11–99 (singular, accusative) / 100+ (singular, genitive) — the rule of
 * src/lib/catalog/copy.ts countNoun; English: none / one / other; Sorani counts with the singular
 * noun: none / other.
 */
export interface Counted {
  ar: { zero: string; one: string; two: string; few: string; many: string; hundred: string };
  en: { zero: string; one: string; other: string };
  ckb: { zero: string; other: string };
}

export function countedText(c: Counted, n: number, lang: Language): string {
  const count = Math.max(0, Math.floor(n));
  const fill = (s: string) => s.replace(/\{n\}/g, String(count));
  if (lang === 'en') return fill(count === 0 ? c.en.zero : count === 1 ? c.en.one : c.en.other);
  if (lang === 'ckb') return fill(count === 0 ? c.ckb.zero : c.ckb.other);
  if (count === 0) return c.ar.zero;
  if (count === 1) return c.ar.one;
  if (count === 2) return c.ar.two;
  const r = count % 100;
  return fill(r >= 3 && r <= 10 ? c.ar.few : r >= 11 && r <= 99 ? c.ar.many : c.ar.hundred);
}

export const COUNTED = {
  'offer.left': {
    ar: {
      zero: 'لا عروض متبقية لهذا الطلب',
      one: 'بقي عرض واحد لهذا الطلب',
      two: 'بقي عرضان لهذا الطلب',
      few: 'بقيت {n} عروض لهذا الطلب',
      many: 'بقي {n} عرضاً لهذا الطلب',
      hundred: 'بقي {n} عرض لهذا الطلب',
    },
    en: { zero: 'No offers left for this request', one: '1 offer left for this request', other: '{n} offers left for this request' },
    ckb: { zero: 'هیچ پێشنیارێک بۆ ئەم داواکارییە نەماوە', other: '{n} پێشنیار بۆ ئەم داواکارییە ماوە' },
  },
  'services.openCases': {
    ar: {
      zero: 'لا طلبات مفتوحة',
      one: 'طلب مفتوح واحد',
      two: 'طلبان مفتوحان',
      few: '{n} طلبات مفتوحة',
      many: '{n} طلباً مفتوحاً',
      hundred: '{n} طلب مفتوح',
    },
    en: { zero: 'No open requests', one: '1 open request', other: '{n} open requests' },
    ckb: { zero: 'هیچ داواکارییەکی کراوە نییە', other: '{n} داواکاریی کراوە' },
  },
  'services.devicesCount': {
    ar: { zero: 'لا أجهزة', one: 'جهاز واحد', two: 'جهازان', few: '{n} أجهزة', many: '{n} جهازاً', hundred: '{n} جهاز' },
    en: { zero: 'No devices', one: '1 device', other: '{n} devices' },
    ckb: { zero: 'هیچ ئامێرێک نییە', other: '{n} ئامێر' },
  },
} as const satisfies Record<string, Counted>;
export type CountedKey = keyof typeof COUNTED;
export const countText = (key: CountedKey, n: number, lang: Language) => countedText(COUNTED[key], n, lang);

export type CopyKey = keyof typeof COPY;
export type CopyVars = Record<string, string | number>;

const SLOT: Record<Language, 0 | 1 | 2> = { ar: 0, en: 1, ckb: 2 };

/** One string in the reader's language, its `{name}` marks filled. */
export function copyText(key: CopyKey, lang: Language, vars?: CopyVars): string {
  const raw = COPY[key][SLOT[lang] ?? 0];
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : raw;
}

/** The same string cut at its `{name}` marks, for a screen that puts an element (a figure) in one. */
export function copyParts(key: CopyKey, lang: Language): Array<{ text: string } | { slot: string }> {
  const raw = COPY[key][SLOT[lang] ?? 0];
  const out: Array<{ text: string } | { slot: string }> = [];
  let last = 0;
  for (const m of raw.matchAll(/\{(\w+)\}/g)) {
    if (m.index! > last) out.push({ text: raw.slice(last, m.index) });
    out.push({ slot: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < raw.length) out.push({ text: raw.slice(last) });
  return out;
}
