/**
 * «المكافآت» — EVERY WORD OF THE REWARDS AREA (/rewards and its pages), in
 * Arabic, English and Sorani: rewards spec §8, adopted verbatim. DECISIONS
 * row 183: a Sorani slot is its own sentence, never the Arabic copied.
 * tests/rewardsCopy.test.ts holds that, the policy sentences it pins, and the
 * luck-word ban (DECISIONS row 25, policies 15.4 and 15.9: the Levonis team
 * chooses the winners; the one luck word anywhere is the 15.4 negation in
 * `facts.chosen`).
 *
 * `{name}` marks a value the screen fills in:
 * - `{points}` is `countText('points', n)`; the keys marked † below
 *   (`POINTS_OBJ_KEYS`) take `countText('pointsObj', n)`, the oblique Arabic
 *   dual «نقطتين» after a preposition or as an object;
 * - `{percent}` is `formatPercent(p, lang, 0)`; `{money}` is `useMoney().money(iqd)`;
 * - `{date}` is `nearDate` or `formatDate`; `{datetime}`, `{start}` and `{end}`
 *   are `formatDateTime`; `{place}` is `ordinal(place)`.
 * A date and a `formatFigure` number never share one text run (spec §3).
 * Strings marked ⓢ in the spec are the shipped sentences of the old hub.
 *
 * Pure data and string helpers: no React, so the strings test reads it as it
 * is. The Sorani was written for the spec; a native speaker reads it once.
 */
import type { Language } from '../../translations';
import { formatFigure } from '../../lib/localeNumber';

/** One string in [ar, en, ckb] order. */
export type CopyRow = readonly [ar: string, en: string, ckb: string];

export const COPY = {
  // ------------------------------------------------------------ §8.1 the frame, common words, setup
  back: ['رجوع', 'Back', 'گەڕانەوە'],
  'title.home': ['المكافآت', 'Rewards', 'خەڵاتەکان'],
  'title.coupons': ['كوبوناتي', 'My coupons', 'کۆپۆنەکانم'],
  'title.shop': ['استبدل نقاطك', 'Spend your points', 'خاڵەکانت خەرج بکە'],
  'title.rate': ['قيّم طابعتك', 'Rate your printer', 'چاپکەرەکەت هەڵبسەنگێنە'],
  'title.competitions': ['المسابقات', 'Competitions', 'پێشبڕکێکان'],
  'title.competition': ['المسابقة', 'Competition', 'پێشبڕکێ'],
  retry: ['إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە'],
  close: ['إغلاق', 'Close', 'داخستن'],
  cancel: ['إلغاء', 'Cancel', 'پاشگەزبوونەوە'],
  earn: ['اجمع النقاط', 'Earn points', 'خاڵ کۆبکەرەوە'],
  'help.choosePrinter': ['ساعدني أختار طابعة', 'Help me choose a printer', 'یارمەتیم بدە چاپکەرێک هەڵبژێرم'],
  'loading.area': ['جارٍ تحميل مكافآتك', 'Loading your rewards', 'خەڵاتەکانت بار دەکرێن'],
  'loading.list': ['جارٍ تحميل المسابقات', 'Loading the competitions', 'پێشبڕکێکان بار دەکرێن'],
  'loading.detail': ['جارٍ تحميل المسابقة', 'Loading the competition', 'پێشبڕکێکە بار دەکرێت'],
  stale: ['قد لا تكون هذه آخر البيانات.', 'This may not be the latest.', 'لەوانەیە ئەمە نوێترین زانیاری نەبێت.'],
  terms: ['شروط برنامج المكافآت', 'Rewards programme terms', 'مەرجەکانی بەرنامەی خەڵات'],
  tooMany: [
    'حاولت مرات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
    'Too many tries. Wait a moment and try again.',
    'زۆر جار هەوڵت دا. کەمێک چاوەڕێ بکە و دووبارە هەوڵ بدەرەوە.',
  ],
  'setup.title': ['برنامج المكافآت قيد التجهيز', 'The rewards programme is being set up', 'بەرنامەی خەڵات ئامادە دەکرێت'],
  'setup.body': [
    'نجهّز الكوبونات والمسابقات الآن. نقاطك ومهامك تعمل كالمعتاد.',
    'Coupons and competitions are being set up. Your points and missions work as usual.',
    'کۆپۆن و پێشبڕکێکان ئێستا ئامادە دەکرێن. خاڵ و ئەرکەکانت وەک هەمیشە کاردەکەن.',
  ],
  'setup.points': ['النقاط والمهام', 'Points & missions', 'خاڵ و ئەرکەکان'],
  'notFound.title': ['هذه الصفحة ليست في المكافآت', "This page isn't part of Rewards", 'ئەم پەڕەیە بەشێک نییە لە خەڵاتەکان'],
  'notFound.body': [
    'ربما تغيّر الرابط. كل مكافآتك في صفحة المكافآت.',
    'The link may have changed. All your rewards are on the Rewards page.',
    'لەوانەیە بەستەرەکە گۆڕابێت. هەموو خەڵاتەکانت لە پەڕەی خەڵاتەکاندان.',
  ],
  'more.title': ['المزيد في المكافآت', 'More in Rewards', 'زیاتر لە خەڵاتەکان'],
  'more.all': ['كل المكافآت', 'All rewards', 'هەموو خەڵاتەکان'],
  moreLoaded: ['حُمّلت نتائج أخرى', 'More results loaded', 'ئەنجامی زیاتر بار کران'],

  // ------------------------------------------------------------ §8.2 a guest
  'guest.hub.title': ['مكافآتك في Levonis', 'Your Levonis rewards', 'خەڵاتەکانت لە Levonis'],
  'guest.benefit.coupons': [
    'كوبونات مع كل طابعة تستلمها من Levonis.',
    'Coupons with every printer Levonis delivers to you.',
    'کۆپۆن لەگەڵ هەر چاپکەرێک کە Levonis بۆتی دەگەیەنێت.',
  ],
  'guest.benefit.rate': [
    'هدية من Levonis على مراجعتك المفيدة لطابعتك.',
    'A gift from Levonis for a helpful review of your printer.',
    'دیارییەک لە Levonis بۆ هەڵسەنگاندنێکی بەسوودی چاپکەرەکەت.',
  ],
  'guest.benefit.shop': [
    'استبدل نقاطك بكوبونات حين يعرضها المتجر.',
    'Swap your points for coupons when the shop offers them.',
    'خاڵەکانت بە کۆپۆن بگۆڕەوە کاتێک فرۆشگا دەیانخاتە ڕوو.',
  ],
  'guest.benefit.competitions': [
    'مسابقات يختار فريق Levonis فائزيها.',
    'Competitions whose winners the Levonis team chooses.',
    'پێشبڕکێ کە تیمی Levonis براوەکانیان هەڵدەبژێرێت.',
  ],
  'guest.signIn': ['سجّل الدخول لترى مكافآتك', 'Sign in to see your rewards', 'بچۆ ژوورەوە بۆ بینینی خەڵاتەکانت'],
  'guest.coupons.title': ['سجّل الدخول لترى كوبوناتك', 'Sign in to see your coupons', 'بچۆ ژوورەوە بۆ بینینی کۆپۆنەکانت'],
  'guest.coupons.body': [
    'كوبوناتك شخصية، ويظهر كل منها هنا مع موعد انتهائه.',
    'Your coupons are personal; each shows here with its end date.',
    'کۆپۆنەکانت تایبەتن بە خۆت؛ هەریەکەیان لێرە لەگەڵ کاتی کۆتاییهاتنی دەردەکەوێت.',
  ],
  'guest.shop.title': ['سجّل الدخول لتستبدل نقاطك', 'Sign in to spend your points', 'بچۆ ژوورەوە بۆ خەرجکردنی خاڵەکانت'],
  'guest.shop.body': [
    'تستبدل نقاطك هنا بكوبونات حين يعرضها المتجر.',
    'Swap your points here for coupons when the shop offers them.',
    'لێرە خاڵەکانت بە کۆپۆن دەگۆڕیتەوە کاتێک فرۆشگا دەیانخاتە ڕوو.',
  ],
  'guest.rate.title': ['سجّل الدخول لتقيّم طابعتك', 'Sign in to rate your printer', 'بچۆ ژوورەوە بۆ هەڵسەنگاندنی چاپکەرەکەت'],
  'guest.rate.body': [
    'تظهر هنا الطابعات التي استلمتها لتكتب مراجعتها.',
    'The printers you received appear here for you to review.',
    'ئەو چاپکەرانەی وەرتگرتوون لێرە دەردەکەون بۆ ئەوەی هەڵسەنگاندنیان بنووسیت.',
  ],
  'guest.competitions.title': [
    'سجّل الدخول لترى المسابقات وتشارك فيها',
    'Sign in to see the competitions and enter',
    'بچۆ ژوورەوە بۆ بینینی پێشبڕکێکان و بەشداریکردن تێیاندا',
  ],
  'guest.competitions.body': [
    'لكل حساب مشاركة واحدة في كل مسابقة، والفائزون يختارهم فريق Levonis.',
    'One entry per account in each competition; the Levonis team chooses the winners.',
    'بۆ هەر هەژمارێک یەک بەشداری لە هەر پێشبڕکێیەکدا، و براوەکان تیمی Levonis هەڵیاندەبژێرێت.',
  ],
  'guest.competition.title': ['سجّل الدخول لترى هذه المسابقة', 'Sign in to see this competition', 'بچۆ ژوورەوە بۆ بینینی ئەم پێشبڕکێیە'],
  'guest.competition.body': [
    'تفاصيل المسابقات والمشاركة فيها لأصحاب الحسابات.',
    'Competition details and entries are for account holders.',
    'وردەکاریی پێشبڕکێکان و بەشداریکردن تێیاندا بۆ خاوەن هەژمارەکانە.',
  ],

  // ------------------------------------------------------------ §8.3 the hub
  'hub.balance': ['رصيدك', 'Your balance', 'باڵانسەکەت'],
  'hub.pending': ['{points} في الطريق', '{points} on the way', '{points} لە ڕێگادان'],
  'hub.pointsDoor': ['النقاط والمهام', 'Points & missions', 'خاڵ و ئەرکەکان'],
  'hub.doors': ['أقسام المكافآت', 'Rewards sections', 'بەشەکانی خەڵات'],
  'hub.error': ['تعذّر تحميل مكافآتك.', "Your rewards couldn't be loaded.", 'خەڵاتەکانت بار نەکران.'],
  'now.couponEnding': ['كوبون ينتهي قريبًا', 'A coupon ends soon', 'کۆپۆنێک بەم زووانە کۆتایی دێت'],
  'now.couponActive': ['لديك كوبون لم تستخدمه', 'You have a coupon to use', 'کۆپۆنێکی بەکارنەهاتووت هەیە'],
  'now.gift': ['هديتك بانتظارك', 'Your gift is waiting', 'دیارییەکەت چاوەڕێتە'],
  'now.gift.body': [
    'قُبلت مراجعتك بالمستوى {level}. اختر هديتك من «هداياي».',
    'Your review was approved at level {level}. Choose your gift in «My gifts».',
    'هەڵسەنگاندنەکەت لە ئاستی {level} پەسەندکرا. دیارییەکەت لە «دیارییەکانم» هەڵبژێرە.',
  ],
  'now.competition': ['مسابقة مفتوحة لك', 'A competition open to you', 'پێشبڕکێیەکی کراوە بۆ تۆ'],
  'now.competition.cta': ['اعرض المسابقة', 'See the competition', 'پێشبڕکێکە ببینە'],
  'now.rate': ['قيّم طابعتك واربح هدية', 'Rate your printer, win a gift', 'چاپکەرەکەت هەڵبسەنگێنە و دیاری ببەرەوە'],
  'now.rate.body': [
    'وصلتك في {date}. مراجعة مفيدة قد تمنحك هدية.',
    'Delivered on {date}. A helpful review can earn you a gift.',
    'لە {date} پێت گەیشت. هەڵسەنگاندنێکی بەسوود دەتوانێت دیارییەکت بۆ بهێنێت.',
  ],
  'door.coupons.hours': ['أقرب كوبون ينتهي خلال ساعات', 'The next one ends within hours', 'نزیکترین کۆپۆن لە چەند کاتژمێرێکدا کۆتایی دێت'],
  'door.coupons.soonest': ['أقرب كوبون ينتهي في {date}', 'The next one ends on {date}', 'نزیکترین کۆپۆن لە {date} کۆتایی دێت'],
  'door.coupons.how': [
    'تصلك مع كل طابعة تستلمها من Levonis',
    'You get them with every printer Levonis delivers to you',
    'لەگەڵ هەر چاپکەرێک کە Levonis بۆتی دەگەیەنێت وەریاندەگریت',
  ],
  'door.coupons.howWeekly': [
    'تصلك كل أسبوع مع كل طابعة تستلمها من Levonis',
    'You get them every week with every printer Levonis delivers to you',
    'هەموو هەفتەیەک لەگەڵ هەر چاپکەرێک کە Levonis بۆتی دەگەیەنێت وەریاندەگریت',
  ],
  'door.shop.from': ['كوبونات تبدأ من {points}', 'Coupons from {points}', 'کۆپۆن لە {points}ەوە'], // † pointsObj
  'door.shop.checkout': [
    'استخدمها عند الدفع: كل نقطة بدينار',
    'Use them at checkout: 1 point = 1 IQD',
    'لە کاتی پارەداندا بەکاریان بهێنە: هەر خاڵێک بە یەک دینار',
  ],
  'door.rate.gift': ['هديتك بانتظارك في «هداياي»', 'Your gift is waiting in «My gifts»', 'دیارییەکەت لە «دیارییەکانم» چاوەڕێتە'],
  'door.rate.pending': ['مراجعتك بانتظار قرار الهدية', 'Your review awaits the gift decision', 'هەڵسەنگاندنەکەت چاوەڕێی بڕیاری دیارییە'],
  'door.rate.done': ['قيّمت كل طابعاتك', "You've reviewed all your printers", 'هەموو چاپکەرەکانت هەڵسەنگاندووە'],
  'door.rate.code': [
    'اعتُمدت مراجعتك — أدخل كود هديتك',
    'Your review was approved — enter your gift code',
    'هەڵسەنگاندنەکەت پەسەندکرا — کۆدی دیارییەکەت بنووسە',
  ],
  'door.rate.how': ['هدية مقابل مراجعة طابعتك', 'A gift for reviewing your printer', 'دیارییەک بۆ هەڵسەنگاندنی چاپکەرەکەت'],
  'door.competitions.won': ['فزت بالمركز {place}!', 'You won {place} place!', 'پلەی {place}ت بردەوە!'],
  'door.competitions.judging': ['مشاركتك بانتظار النتيجة', 'Your entry awaits the result', 'بەشدارییەکەت چاوەڕێی ئەنجامە'],
  'door.competitions.upcoming': ['تبدأ مسابقة جديدة في {date}', 'A new competition starts on {date}', 'پێشبڕکێیەکی نوێ لە {date} دەست پێدەکات'],
  'door.competitions.none': [
    'لا مسابقات الآن — نعلن كل جديدة هنا',
    'None right now — new ones are announced here',
    'ئێستا هیچ پێشبڕکێیەک نییە — هەر نوێیەک لێرە ڕادەگەیەنرێت',
  ],

  // ------------------------------------------------------------ §8.4 «كوبوناتي»
  'coupon.freeShipping': ['توصيل مجاني', 'Free delivery', 'گەیاندنی بەخۆڕایی'],
  'coupon.filament': ['خصم {percent} على الفلامنت', '{percent} off filament', '{percent} داشکاندن لەسەر فیلامێنت'],
  'coupon.shipDetail': ['رسوم التوصيل كاملة لطلب واحد', 'The full delivery fee on one order', 'هەموو کرێی گەیاندن بۆ یەک داواکاری'],
  'coupon.shipAmount': ['خصم {money} من رسوم التوصيل', '{money} off the delivery fee', '{money} لە کرێی گەیاندن کەم دەکاتەوە'],
  'coupon.shipMin': ['للطلبات فوق {money}', 'On orders over {money}', 'بۆ داواکارییەکانی سەرووی {money}'],
  'coupon.pieces': ['يشمل {pieces}', 'Covers {pieces}', '{pieces} دەگرێتەوە'],
  'coupon.capOn': ['حتى {money} على:', 'Up to {money} on:', 'تا {money} لەسەر:'],
  'coupon.on': ['على:', 'On:', 'لەسەر:'],
  'coupon.capSelected': ['حتى {money} على الفلامنت المختار', 'Up to {money} on selected filament', 'تا {money} لەسەر فیلامێنتی هەڵبژێردراو'],
  'coupon.selected': ['على الفلامنت المختار', 'On selected filament', 'لەسەر فیلامێنتی هەڵبژێردراو'],
  'coupon.noTargets': [
    'لا فلامنت متاح لهذا الكوبون الآن',
    'No filament this coupon covers is on sale now',
    'ئێستا هیچ فیلامێنتێک کە ئەم کۆپۆنە دەیگرێتەوە بەردەست نییە',
  ],
  'coupon.chip.noTargets': ['لا منتج متاح له الآن', 'Nothing to use it on now', 'ئێستا هیچ بەرهەمێکی بۆ نییە'],
  'coupon.validUntil': ['صالح حتى {date}', 'Valid until {date}', 'تا {date} بەکاردێت'],
  'coupon.endsOn': ['ينتهي في {date}', 'Ends on {date}', 'لە {date} کۆتایی دێت'],
  'coupon.ruleStack': ['تجتمع كوبوناتك كلها في طلب واحد', 'All your coupons can go on one order', 'هەموو کۆپۆنەکانت لە یەک داواکاریدا کۆدەبنەوە'],
  'coupon.ruleNoOffer': [
    'لا يشمل القطع التي عليها عرض أو خصم آخر',
    'Not on items with an offer or another discount',
    'ئەو پارچانە ناگرێتەوە کە ئۆفەر یان داشکاندنێکی تریان لەسەرە',
  ],
  'coupon.ruleShip': [
    'لا يُستهلك إن كان التوصيل مجانيًا أصلًا أو استلمت من المخزن',
    'Not used up when delivery is already free or you collect from the warehouse',
    'بەکارنایەت ئەگەر گەیاندن پێشتر بەخۆڕایی بێت یان لە کۆگا وەریبگریت',
  ],
  'coupon.copy': ['نسخ الكود', 'Copy the code', 'کۆدەکە کۆپی بکە'],
  'coupon.copied': ['نُسخ الكود', 'Code copied', 'کۆدەکە کۆپی کرا'],
  'coupon.copyFailed': [
    'تعذّر النسخ — الكود ظاهر لتكتبه بنفسك',
    "Couldn't copy — the code is shown so you can type it",
    'کۆپی نەکرا — کۆدەکە دیارە بۆ ئەوەی خۆت بینووسیت',
  ],
  'coupon.use': ['استخدمه الآن', 'Use it now', 'ئێستا بەکاری بهێنە'],
  'coupon.useShort': ['استخدمه', 'Use', 'بەکاری بهێنە'],
  'coupon.saved': [
    'حفظنا الكود — وعند الدفع نطبّق كل كوبوناتك المناسبة للطلب.',
    'We saved the code — at checkout we apply every coupon of yours the order can use.',
    'کۆدەکەمان هەڵگرت — لە کاتی پارەداندا هەموو کۆپۆنە گونجاوەکانت بۆ داواکارییەکە بەکاردەهێنین.',
  ],
  'coupon.fromPrinter': ['مكافأة شراء طابعة', 'Printer purchase reward', 'خەڵاتی کڕینی چاپکەر'],
  'coupon.fromShop': ['من متجر النقاط · {points}', 'From the points shop · {points}', 'لە فرۆشگای خاڵ · {points}'],
  'coupon.fromTeam': ['من فريق Levonis', 'From the Levonis team', 'لە تیمی Levonis'],
  'chip.used': ['استُخدم', 'Used', 'بەکارهات'],
  'chip.expired': ['انتهت صلاحيته', 'Expired', 'بەسەرچوو'],
  'chip.withdrawn': ['سُحب', 'Withdrawn', 'کشێنرایەوە'],
  'coupons.empty.title': ['لا كوبونات صالحة الآن', 'No coupons to use right now', 'ئێستا هیچ کۆپۆنێکی چالاکت نییە'],
  'coupons.empty.body': [
    'كل طابعة تستلمها من Levonis تمنحك {what}، ويصلح كل كوبون {days} من لحظة إصداره.',
    'Every printer Levonis delivers to you earns {what}; each coupon is valid for {days} from the moment it is issued.',
    'هەر چاپکەرێک کە Levonis بۆتی دەگەیەنێت {what}ت پێدەدات، و هەر کۆپۆنێک {days} لە کاتی دەرچوونییەوە بەکاردێت.',
  ],
  'coupons.empty.bodyWeekly': [
    'كل طابعة تستلمها من Levonis تمنحك كل أسبوع {what} طوال {months} من ضمانها، ويصلح كل كوبون {days} من لحظة إصداره.',
    'Every printer Levonis delivers to you earns {what} every week for {months} of its warranty; each coupon is valid for {days} from the moment it is issued.',
    'هەر چاپکەرێک کە Levonis بۆتی دەگەیەنێت هەموو هەفتەیەک {what}ت پێدەدات بۆ ماوەی {months} لە گەرەنتییەکەی، و هەر کۆپۆنێک {days} لە کاتی دەرچوونییەوە بەکاردێت.',
  ],
  'coupons.what.bothTerms': [
    'كوبون توصيل مجاني بقيمة {amount} للطلبات فوق {min}، وكوبون خصم {percent} على {pieces} من الفلامنت المختار',
    'a free-delivery coupon worth {amount} on orders over {min}, and a {percent} coupon on {pieces} of selected filament',
    'کۆپۆنێکی گەیاندنی بەخۆڕایی بە بەهای {amount} بۆ داواکارییەکانی سەرووی {min}، و کۆپۆنێکی {percent} داشکاندن لەسەر {pieces} لە فیلامێنتی هەڵبژێردراو',
  ],
  'coupons.what.bothAmount': [
    'كوبون توصيل مجاني بقيمة {amount}، وكوبون خصم {percent} على {pieces} من الفلامنت المختار',
    'a free-delivery coupon worth {amount}, and a {percent} coupon on {pieces} of selected filament',
    'کۆپۆنێکی گەیاندنی بەخۆڕایی بە بەهای {amount}، و کۆپۆنێکی {percent} داشکاندن لەسەر {pieces} لە فیلامێنتی هەڵبژێردراو',
  ],
  'coupons.what.shipTerms': [
    'كوبون توصيل مجاني بقيمة {amount} للطلبات فوق {min}',
    'a free-delivery coupon worth {amount} on orders over {min}',
    'کۆپۆنێکی گەیاندنی بەخۆڕایی بە بەهای {amount} بۆ داواکارییەکانی سەرووی {min}',
  ],
  'coupons.what.shipAmount': [
    'كوبون توصيل مجاني بقيمة {amount}',
    'a free-delivery coupon worth {amount}',
    'کۆپۆنێکی گەیاندنی بەخۆڕایی بە بەهای {amount}',
  ],
  'coupons.what.both': [
    'كوبون توصيل مجاني وكوبون خصم {percent} على الفلامنت المختار',
    'a free-delivery coupon and a {percent} coupon on selected filament',
    'کۆپۆنێکی گەیاندنی بەخۆڕایی و کۆپۆنێکی {percent} داشکاندن لەسەر فیلامێنتی هەڵبژێردراو',
  ],
  'coupons.what.ship': ['كوبون توصيل مجاني', 'a free-delivery coupon', 'کۆپۆنێکی گەیاندنی بەخۆڕایی'],
  'coupons.what.filament': [
    'كوبون خصم {percent} على الفلامنت المختار',
    'a {percent} coupon on selected filament',
    'کۆپۆنێکی {percent} داشکاندن لەسەر فیلامێنتی هەڵبژێردراو',
  ],
  'coupons.what.cap': ['(حتى {money})', '(up to {money})', '(تا {money})'],
  'coupons.empty.shop': ['استبدل نقاطك بكوبون', 'Swap your points for a coupon', 'خاڵەکانت بە کۆپۆنێک بگۆڕەوە'],
  'coupons.past': ['الكوبونات السابقة ({n})', 'Past coupons ({n})', 'کۆپۆنە پێشووەکان ({n})'],
  'coupons.capped': ['تُعرض أحدث {shown} من {total}', 'Showing the latest {shown} of {total}', 'نوێترین {shown} لە {total} پیشان دەدرێن'],
  'past.usedOn': ['استُخدم في طلب', 'Used on an order', 'لە داواکارییەکدا بەکارهات'],
  'past.viewOrder': ['عرض الطلب', 'View the order', 'داواکارییەکە ببینە'],
  'past.expiredOn': ['انتهت صلاحيته في {date}', 'Expired on {date}', 'لە {date} بەسەرچوو'],
  'past.withdrawnOrder': [
    'سُحب لأن طلب الطابعة أُلغي',
    'Withdrawn: the printer order was cancelled',
    'کشێنرایەوە چونکە داواکاریی چاپکەرەکە هەڵوەشایەوە',
  ],
  'past.withdrawnReturn': ['سُحب لأن الطابعة أُرجعت', 'Withdrawn: the printer was returned', 'کشێنرایەوە چونکە چاپکەرەکە گەڕێنرایەوە'],
  'past.withdrawnTeam': ['سحبه فريق Levonis', 'Withdrawn by the Levonis team', 'تیمی Levonis کشاندییەوە'],
  'targets.title': ['على أي فلامنت تستخدمه؟', 'Which filament will you use it on?', 'لەسەر کام فیلامێنت بەکاری دەهێنیت؟'],
  'targets.body': [
    'حفظنا الكود. اختر الفلامنت وأضفه إلى السلة.',
    'The code is saved. Pick the filament and add it to your cart.',
    'کۆدەکە هەڵگیراوە. فیلامێنتەکە هەڵبژێرە و بیخەرە ناو عەرەبانەکەوە.',
  ],

  // ------------------------------------------------------------ §8.5 «استبدل نقاطك»
  'shop.balance': ['رصيدك {points}', 'Your balance: {points}', 'باڵانسەکەت: {points}'],
  'shop.history': ['سجلّ النقاط', 'Points history', 'مێژووی خاڵەکان'],
  'shop.ship': ['كوبون توصيل مجاني', 'Free-delivery coupon', 'کۆپۆنی گەیاندنی بەخۆڕایی'],
  'shop.filament': ['كوبون خصم {percent} على الفلامنت', '{percent} filament coupon', 'کۆپۆنی {percent} داشکاندنی فیلامێنت'],
  'shop.valid': ['يصلح {days} لطلب واحد', 'Valid {days}, for one order', '{days} بۆ یەک داواکاری بەکاردێت'],
  'shop.cap': ['حتى {money}', 'Up to {money}', 'تا {money}'],
  'shop.swap': ['استبدل', 'Swap', 'بیگۆڕەوە'],
  'shop.holding': ['لديك هذا الكوبون ولم تستخدمه بعد', 'You already hold this one, unused', 'ئەم کۆپۆنەت هەیە و هێشتا بەکارت نەهێناوە'],
  'shop.show': ['اعرضه', 'Show it', 'پیشانی بدە'],
  'shop.confirm.title': ['استبدل {points} بهذا الكوبون؟', 'Swap {points} for this coupon?', '{points} بەم کۆپۆنە دەگۆڕیتەوە؟'], // † pointsObj
  'shop.confirm.body': [
    '{item}: تُخصم النقاط الآن، ويصلك الكوبون صالحًا {days} لطلب واحد. لا تعود النقاط إن انتهى الكوبون دون استخدام.',
    "{item}: the points come off now, and the coupon is yours for {days}, for one order. The points don't come back if it expires unused.",
    '{item}: خاڵەکان ئێستا کەم دەکرێنەوە، و کۆپۆنەکە {days} بۆ یەک داواکاری هی تۆیە. ئەگەر بەبێ بەکارهێنان بەسەربچێت خاڵەکان ناگەڕێنەوە.',
  ],
  'shop.done': [
    'أُضيف الكوبون إلى كوبوناتك، صالح حتى {date}.',
    'The coupon is in My coupons, valid until {date}.',
    'کۆپۆنەکە خرایە ناو کۆپۆنەکانت، تا {date} بەکاردێت.',
  ],
  'shop.err.points': ['نقاطك لا تكفي لهذه المكافأة.', 'You do not have enough points for this reward.', 'خاڵەکانت بەس نین بۆ ئەم خەڵاتە.'],
  'shop.err.holding': [
    'لديك هذا الكوبون ولم تستخدمه بعد — استخدمه أولًا.',
    'You already hold this coupon — use it first.',
    'ئەم کۆپۆنەت هەیە و هێشتا بەکارت نەهێناوە — سەرەتا بەکاری بهێنە.',
  ],
  'shop.err.unavailable': ['هذه المكافأة غير متاحة الآن.', 'This reward is not available right now.', 'ئەم خەڵاتە ئێستا بەردەست نییە.'],
  'shop.err.generic': ['تعذّر إتمام الاستبدال.', 'The swap did not go through.', 'گۆڕینەوەکە تەواو نەبوو.'],
  'shop.oneEach': [
    'تحمل كوبونًا واحدًا غير مستخدم من كل نوع تستبدله بالنقاط.',
    'You hold one unused coupon of each kind bought with points at a time.',
    'لە هەر جۆرێک کە بە خاڵ دەیکڕیت، لە یەک کاتدا تەنها یەک کۆپۆنی بەکارنەهاتووت دەبێت.',
  ],
  'shop.checkout.title': ['أو استخدم نقاطك عند الدفع', 'Or use your points at checkout', 'یان لە کاتی پارەداندا خاڵەکانت بەکاربهێنە'],
  'shop.checkout.body': [
    'فعّل «استخدام النقاط» في السلة، وكل نقطة تخصم دينارًا واحدًا من قيمة المنتجات.',
    'Switch on «Use points» in your cart, and each point takes 1 IQD off the products.',
    'لە عەرەبانەکەدا «بەکارهێنانی خاڵ» چالاک بکە، و هەر خاڵێک یەک دینار لە نرخی بەرهەمەکان کەم دەکاتەوە.',
  ],
  'shop.toCart': ['إلى السلة', 'Go to cart', 'بڕۆ بۆ عەرەبانە'],
  'shop.empty.title': ['لا عروض في متجر النقاط الآن', 'Nothing in the points shop right now', 'ئێستا هیچ شتێک لە فرۆشگای خاڵدا نییە'],
  'shop.empty.body': [
    'نعلن هنا كل كوبون وسعره بالنقاط حين يعرضه المتجر. وحتى ذلك الحين تُصرف نقاطك عند الدفع: فعّل «استخدام النقاط» في السلة.',
    'Each coupon and its price in points is announced here when the shop offers it. Until then, your points are spent at checkout: switch on «Use points» in your cart.',
    'هەر کۆپۆنێک و نرخەکەی بە خاڵ لێرە ڕادەگەیەنرێت کاتێک فرۆشگا دەیخاتە ڕوو. تا ئەو کاتە، خاڵەکانت لە کاتی پارەداندا خەرج دەکرێن: لە عەرەبانەکەدا «بەکارهێنانی خاڵ» چالاک بکە.',
  ],

  // ------------------------------------------------------------ §8.6 «قيّم طابعتك»
  'rate.lead': [
    'كل طابعة استلمتها من Levonis تستحق مراجعة، وكل مراجعة مفيدة قد تمنحك هدية.',
    'Every printer Levonis delivered to you can be reviewed, and a helpful review can earn a gift.',
    'هەر چاپکەرێک کە Levonis بۆتی گەیاندووە دەکرێت هەڵبسەنگێنرێت، و هەڵسەنگاندنێکی بەسوود دەتوانێت دیارییەکت بۆ بهێنێت.',
  ],
  'rate.printers': ['طابعاتك', 'Your printers', 'چاپکەرەکانت'],
  'rate.toRate': ['لم تقيّمها بعد', 'Not rated yet', 'هێشتا هەڵتنەسەنگاندووە'],
  'rate.pending': ['بانتظار قرار الهدية', 'Gift decision pending', 'چاوەڕێی بڕیاری دیاری'],
  'rate.approved': ['هديتك جاهزة — المستوى {level}', 'Your gift is ready — level {level}', 'دیارییەکەت ئامادەیە — ئاستی {level}'],
  'rate.rated': ['قيّمتها {stars}★', 'You rated it {stars}★', '{stars}★ هەڵتسەنگاند'],
  'rate.write': ['اكتب مراجعتك', 'Write a review', 'هەڵسەنگاندن بنووسە'],
  'rate.gifts': ['هداياي', 'My gifts', 'دیارییەکانم'],
  'rate.chooseGift': ['اختر هديتك', 'Choose your gift', 'دیارییەکەت هەڵبژێرە'],
  'rate.delivered': ['وصلت في {date}', 'Delivered on {date}', 'لە {date} گەیشت'],
  'rate.pendingNote': [
    'يقرأ فريق Levonis مراجعتك ويعتمد درجتها، ثم يعطيك كود هديتك.',
    'The Levonis team reads your review and confirms its score, then gives you your gift code.',
    'تیمی Levonis هەڵسەنگاندنەکەت دەخوێنێتەوە و نمرەکەی پەسەند دەکات، پاشان کۆدی دیارییەکەت پێدەدات.',
  ],
  'rate.noPage': ['صفحة هذه الطابعة غير متاحة الآن.', "This printer's page isn't available right now.", 'پەڕەی ئەم چاپکەرە ئێستا بەردەست نییە.'],
  'rate.capped': ['تُعرض أحدث {n} طابعة استلمتها', 'Showing the latest {n} printers you received', 'نوێترین {n} چاپکەری وەرگیراوت پیشان دەدرێن'],
  'rate.how': ['كيف تربح الهدية', 'How to earn the gift', 'چۆن دیارییەکە بەدەست دەهێنیت'],
  'rate.step1': [
    'بعد استلام طابعتك اكتب مراجعتك في صفحتها — أي تقييم من نجمة إلى خمس نجوم.',
    'Once your printer arrives, write your review on its page — any rating from one to five stars.',
    'دوای گەیشتنی چاپکەرەکەت، هەڵسەنگاندنەکەت لە پەڕەکەیدا بنووسە — هەر نمرەیەک لە یەک ئەستێرە تا پێنج.',
  ],
  'rate.step2': [
    'أضف صورًا واضحة. والفيديو وستوري إنستغرام يرفعان درجتك: انشر ستوري تشارك فيه تجربتك مع منشن \u2066@levonis_iq\u2069، ثم أرفق رابطه أو لقطة شاشة منه في خانة «دليل ستوري إنستغرام (خاص)» في نموذج المراجعة — لا يراه غير المتجر.',
    'Add clear photos. A video and an Instagram story raise your score: post a story about your experience mentioning @levonis_iq, then attach its link or a screenshot in the «Instagram story evidence (private)» field of the review form — only the shop sees it.',
    'وێنەی ڕوون زیاد بکە. ڤیدیۆ و ستۆری ئینستاگرام نمرەکەت بەرز دەکەنەوە: ستۆرییەک دەربارەی ئەزموونەکەت دابنێ و \u2066@levonis_iq\u2069 منشن بکە، پاشان بەستەرەکەی یان وێنەیەکی شاشەی لە خانەی «بەڵگەی ستۆری ئینستاگرام (تایبەت)» لە فۆرمی هەڵسەنگاندنەکەدا هاوپێچ بکە — تەنها فرۆشگا دەیبینێت.',
  ],
  'rate.step3': [
    'يقيّم النظام مراجعتك من {from} إلى {to} حسب فائدتها لا حسب عدد النجوم، ويعتمدها فريق Levonis ويعطيك كودًا. كل {every} درجة تفتح مستوى: تكتب الكود، وتختار هدية واحدة من مستوياتك، وتدفع أجرة التوصيل فقط.',
    'The system scores your review from {from} to {to} by how helpful it is — never by the stars. The Levonis team approves it and gives you a code. Every {every} points opens a level: write the code, choose one gift from your levels, and pay for delivery only.',
    'سیستەمەکە هەڵسەنگاندنەکەت لە {from} تا {to} دەنرخێنێت بەپێی سوودەکەی، نەک ژمارەی ئەستێرەکان. تیمی Levonis پەسەندی دەکات و کۆدێکت پێدەدات. هەر {every} نمرە ئاستێک دەکاتەوە: کۆدەکە بنووسە، یەک دیاری لە ئاستەکانت هەڵبژێرە، و تەنها کرێی گەیاندن بدە.',
  ],
  'rate.copyHandle': ['نسخ اسم الحساب', 'Copy the account name', 'ناوی هەژمارەکە کۆپی بکە'],
  'rate.handleCopied': ['نُسخ اسم الحساب', 'Account name copied', 'ناوی هەژمارەکە کۆپی کرا'],
  // Not in spec §8: the honest failure of «نسخ اسم الحساب» (an in-app browser
  // that refuses the clipboard). The handle stays on screen to type; never a
  // tick. `coupon.copyFailed` names «الكود», which this is not.
  'rate.copyFailed': [
    'تعذّر النسخ — اسم الحساب ظاهر لتكتبه بنفسك',
    "Couldn't copy — the account name is shown so you can type it",
    'کۆپی نەکرا — ناوی هەژمارەکە دیارە بۆ ئەوەی خۆت بینووسیت',
  ],
  'rate.levels': ['مستويات الهدايا', 'Gift levels', 'ئاستەکانی دیاری'],
  'rate.level': ['المستوى {n}', 'Level {n}', 'ئاستی {n}'],
  'rate.noLevel': [ // † pointsObj
    'ومراجعة أي منتج آخر تمنحك {points} على الأقل.',
    'A review of any other product earns at least {points}.',
    'هەڵسەنگاندنی هەر بەرهەمێکی تر لانیکەم {points}ت پێدەدات.',
  ],
  'rate.decision': [
    'الهدية قرار يتخذه فريق Levonis لكل مراجعة على حدة، وهي عينية لا تُبدَّل بمال.',
    'Each gift is a decision the Levonis team makes per review; it is in kind and never exchanged for money.',
    'دیاری بڕیارێکە تیمی Levonis بۆ هەر هەڵسەنگاندنێک بە جیا دەیدات؛ کاڵاییە و بە پارە ناگۆڕدرێتەوە.',
  ],
  'rate.empty.title': ['لا طابعات لتقييمها بعد', 'No printers to review yet', 'هێشتا هیچ چاپکەرێک نییە بۆ هەڵسەنگاندن'],
  'rate.empty.body': [
    'حين تستلم طابعة من Levonis تظهر هنا لتقيّمها.',
    'When a printer from Levonis reaches you, it appears here to rate.',
    'کاتێک چاپکەرێک لە Levonis پێت دەگات، لێرە دەردەکەوێت بۆ هەڵسەنگاندن.',
  ],

  // ------------------------------------------------------------ §8.7 the competitions list
  'tabs.label': ['قوائم المسابقات', 'Competition lists', 'لیستەکانی پێشبڕکێ'],
  'tab.current': ['الحالية', 'Current', 'ئێستا'],
  'tab.results': ['النتائج', 'Results', 'ئەنجامەکان'],
  'group.open': ['مفتوحة الآن', 'Open now', 'ئێستا کراوەن'],
  'group.upcoming': ['تبدأ قريبًا', 'Starting soon', 'بەم زووانە دەست پێدەکەن'],
  'group.closed': ['قيد التحكيم', 'Being judged', 'لە هەڵسەنگاندندان'],
  'chip.open': ['مفتوحة', 'Open', 'کراوەیە'],
  'chip.upcoming': ['قريبًا', 'Soon', 'بەم زووانە'],
  'chip.closed': ['قيد التحكيم', 'Being judged', 'لە هەڵسەنگاندندایە'],
  'chip.finished': ['انتهت', 'Finished', 'کۆتایی هات'],
  'chip.cancelled': ['أُلغيت', 'Cancelled', 'هەڵوەشێنرایەوە'],
  'chip.entered': ['أنت مشارك', 'You are in', 'تۆ بەشداریت کردووە'],
  'chip.awaiting': ['بانتظار النتيجة', 'Awaiting the result', 'چاوەڕێی ئەنجام'],
  'chip.won': ['فزت بالمركز {place}', 'You won {place} place', 'پلەی {place}ت بردەوە'],
  'chip.notWon': ['لم تفز هذه المرة', 'Not this time', 'ئەمجارە نەتبردەوە'],
  'chip.refunded': ['أُعيدت نقاطك', 'Points returned', 'خاڵەکانت گەڕێنرانەوە'],
  'chip.rejected': ['لم تُقبل مشاركتك', 'Your entry was not accepted', 'بەشدارییەکەت پەسەند نەکرا'],
  'chip.full': ['اكتمل العدد', 'Full', 'ژمارە تەواو بوو'],
  'chip.printerOwners': ['لمالكي طابعات Levonis', 'For Levonis printer owners', 'بۆ خاوەنانی چاپکەری Levonis'],
  'row.free': ['مجانية', 'Free', 'بەخۆڕایی'],
  'row.fee': ['بـ {points}', '{points} to enter', 'بە {points}'], // † pointsObj
  'row.closes': ['تُغلق في {date}', 'Closes {date}', 'لە {date} دادەخرێت'],
  'row.opens': ['تبدأ في {date}', 'Opens {date}', 'لە {date} دەست پێدەکات'],
  'row.closedOn': ['أُغلقت في {date}', 'Closed {date}', 'لە {date} داخرا'],
  'row.results': ['أُعلنت النتائج في {date}', 'Results announced {date}', 'ئەنجامەکان لە {date} ڕاگەیەنران'],
  'row.ended': ['انتهت في {date}', 'Ended {date}', 'لە {date} کۆتایی هات'],
  'row.winners': ['الفائزون: {names}', 'Winners: {names}', 'براوەکان: {names}'],
  'filter.mine': ['مشاركاتي فقط', 'Only my entries', 'تەنها بەشدارییەکانم'],
  'list.more': ['عرض المزيد', 'Show more', 'زیاتر پیشان بدە'],
  'list.end': ['هذه كل النتائج.', "That's all the results.", 'ئەمە هەموو ئەنجامەکانە.'],
  'list.moreError': ['تعذّر تحميل المزيد.', "Couldn't load more.", 'نەتوانرا زیاتر بار بکرێت.'],
  'list.capped': ['تظهر هنا أول {n} مسابقة.', 'The first {n} are shown here.', 'یەکەم {n} پێشبڕکێ لێرە پیشان دەدرێن.'],
  'list.chosenNote': [
    'فريق Levonis يختار الفائزين وفق شروط كل مسابقة.',
    "The Levonis team chooses the winners by each competition's rules.",
    'تیمی Levonis براوەکان بەپێی مەرجەکانی هەر پێشبڕکێیەک هەڵدەبژێرێت.',
  ],
  'list.empty.current.title': ['لا مسابقات الآن', 'No competitions right now', 'ئێستا هیچ پێشبڕکێیەک نییە'],
  'list.empty.current.body': ['نعلن كل مسابقة جديدة هنا.', 'Every new one is announced here.', 'هەر پێشبڕکێیەکی نوێ لێرە ڕادەگەیەنرێت.'],
  'list.empty.current.toResults': ['اعرض النتائج', 'See the results', 'ئەنجامەکان ببینە'],
  'list.empty.results.title': ['لا نتائج بعد', 'No results yet', 'هێشتا هیچ ئەنجامێک نییە'],
  'list.empty.results.body': [
    'تظهر هنا كل مسابقة انتهت مع فائزيها.',
    'Every finished competition appears here with its winners.',
    'هەر پێشبڕکێیەک کە کۆتایی هات لێرە لەگەڵ براوەکانی دەردەکەوێت.',
  ],
  'list.empty.mine.title': [
    'لم تشارك في مسابقة انتهت بعد',
    "You haven't entered a finished competition yet",
    'هێشتا بەشداریت لە هیچ پێشبڕکێیەکی کۆتاییهاتوو نەکردووە',
  ],
  'list.empty.mine.cta': ['اعرض كل النتائج', 'Show all results', 'هەموو ئەنجامەکان پیشان بدە'],

  // ------------------------------------------------------------ §8.8 one competition
  'status.opens': ['تبدأ في {datetime}', 'Opens {datetime}', 'لە {datetime} دەست پێدەکات'],
  'status.closes': ['تُغلق في {datetime}', 'Closes {datetime}', 'لە {datetime} دادەخرێت'],
  'status.closed': [
    'أُغلقت — يختار فريق Levonis الفائزين ويعلنهم هنا.',
    'Closed — the Levonis team is choosing the winners and will announce them here.',
    'داخرا — تیمی Levonis براوەکان هەڵدەبژێرێت و لێرە ڕایاندەگەیەنێت.',
  ],
  'status.cancelled': ['أُلغيت هذه المسابقة.', 'This competition was cancelled.', 'ئەم پێشبڕکێیە هەڵوەشێنرایەوە.'],
  'status.firstPrize': ['الجائزة الأولى: {points}', 'First prize: {points}', 'خەڵاتی یەکەم: {points}'],
  'status.full': ['اكتمل عدد المشاركين.', 'This competition is full.', 'ژمارەی بەشداربووان تەواو بوو.'],
  'mine.title': ['مشاركتك', 'Your entry', 'بەشدارییەکەت'],
  'mine.enteredOn': ['شاركت في {date}', 'You entered on {date}', 'لە {date} بەشداریت کرد'],
  'mine.open': [
    'تُعلن النتائج بعد إغلاق المسابقة.',
    'Results are announced after the competition closes.',
    'ئەنجامەکان دوای داخستنی پێشبڕکێکە ڕادەگەیەنرێن.',
  ],
  'mine.judging': [
    'مشاركتك بين ما يراجعه فريق Levonis الآن.',
    'Your entry is among those the Levonis team is reviewing now.',
    'بەشدارییەکەت لەناو ئەوانەدایە کە تیمی Levonis ئێستا هەڵیاندەسەنگێنێت.',
  ],
  'mine.wonPoints': ['أُضيفت {points} إلى رصيدك.', '{points} were added to your balance.', '{points} خرایە سەر باڵانسەکەت.'],
  'mine.wonKind': [
    'تُسلَّم الجوائز العينية كما يعلن المتجر.',
    'Prizes in kind are handed over as the shop announces.',
    'خەڵاتە کاڵاییەکان بەو شێوەیە دەدرێن کە فرۆشگا ڕایدەگەیەنێت.',
  ],
  'mine.notWon': ['لم تفز هذه المرة. شكرًا لمشاركتك!', 'Not this time. Thank you for taking part!', 'ئەمجارە نەتبردەوە. سوپاس بۆ بەشداریکردنت!'],
  'mine.refundCancel': [
    'أُعيدت إليك {points} دفعتها للمشاركة.',
    'The {points} you paid to enter are back in your balance.',
    'ئەو {points}ەی بۆ بەشداریکردن دابووت گەڕێنرایەوە.',
  ],
  'mine.cancelFree': [
    'كانت مشاركتك مجانية، فلا نقاط تُعاد.',
    'Your entry was free, so there are no points to return.',
    'بەشدارییەکەت بەخۆڕایی بوو، بۆیە هیچ خاڵێک ناگەڕێتەوە.',
  ],
  'mine.rejected': [
    'لم تُقبل مشاركتك لأنها خالفت شروط المسابقة.',
    "Your entry was not accepted: it broke the competition's conditions.",
    'بەشدارییەکەت پەسەند نەکرا چونکە پێچەوانەی مەرجەکانی پێشبڕکێکە بوو.',
  ],
  'mine.rejectedRefund': [
    'لم تُقبل مشاركتك، وأُعيدت إليك {points}.',
    'Your entry was not accepted, and your {points} were returned.',
    'بەشدارییەکەت پەسەند نەکرا، و {points}ەکەت گەڕێنرایەوە.',
  ],
  'mine.locked': ['لا تُعدَّل المشاركة بعد إرسالها.', "An entry can't be changed once sent.", 'بەشداری دوای ناردن ناگۆڕدرێت.'],
  'prizes.title': ['الجوائز', 'Prizes', 'خەڵاتی براوەکان'],
  'prizes.place': ['المركز {place}', '{place} place', 'پلەی {place}'],
  'terms.title': ['الوصف والشروط', 'Description and rules', 'وەسف و مەرجەکان'],
  'facts.title': ['تفاصيل الاشتراك', 'Entry details', 'وردەکاری بەشداریکردن'],
  'facts.entry': ['الاشتراك', 'Entry', 'بەشداریکردن'],
  'facts.free': ['مجاني', 'Free', 'بەخۆڕایی'],
  'facts.fee': [
    '{points}، تُخصم عند الإرسال وتُعاد كاملة إن أُلغيت المسابقة أو لم تُقبل مشاركتك',
    '{points}, taken when you send it and returned in full if the competition is cancelled or your entry is not accepted',
    '{points}، لە کاتی ناردندا کەم دەکرێتەوە و ئەگەر پێشبڕکێکە هەڵبوەشێتەوە یان بەشدارییەکەت پەسەند نەکرێت بە تەواوی دەگەڕێنرێتەوە',
  ],
  'facts.send': ['ما ترسله', 'What you send', 'چی دەنێریت'],
  'send.none': ['لا شيء — تكفي المشاركة', 'Nothing — entering is enough', 'هیچ — بەشداریکردن بەسە'],
  'send.text': ['إجابة مكتوبة', 'A written answer', 'وەڵامێکی نووسراو'],
  'send.photo': ['صورة', 'A photo', 'وێنەیەک'],
  'send.photoText': ['صورة وإجابة مكتوبة', 'A photo and a written answer', 'وێنەیەک و وەڵامێکی نووسراو'],
  'facts.who': ['من يشارك', 'Who can enter', 'کێ دەتوانێت بەشداری بکات'],
  'who.everyone': ['كل زبائن Levonis', 'Every Levonis customer', 'هەموو کڕیارانی Levonis'],
  'who.printerOwners': ['من استلم طابعة من Levonis', 'Customers who received a printer from Levonis', 'ئەوانەی چاپکەرێکیان لە Levonis وەرگرتووە'],
  'facts.window': ['المدة', 'Period', 'ماوە'],
  'window.range': ['من {start} إلى {end}', '{start} to {end}', 'لە {start} تا {end}'],
  'facts.entrants': ['المشاركون', 'Entrants', 'بەشداربووان'],
  'entrants.of': ['{n} من أصل {max}', '{n} of {max}', '{n} لە {max}'],
  'facts.once': ['مشاركة واحدة لكل حساب', 'One entry per account', 'هەر هەژمارێک یەک بەشداری'],
  'facts.chosen': [
    'الفائزون يختارهم فريق Levonis وفق المعايير المعلنة، ولا تُحدَّد النتيجة بالقرعة ولا بالحظ.',
    'Winners are chosen by the Levonis team by the announced criteria — never by lot or chance.',
    'براوەکان تیمی Levonis بەپێی پێوەرە ڕاگەیەنراوەکان هەڵیاندەبژێرێت، و ئەنجامەکە بە تیروپشک یان بەخت دیاری ناکرێت.',
  ],
  'how.title': ['كيف تشارك', 'How to enter', 'چۆن بەشداری دەکەیت'],
  'how.text': ['اكتب إجابتك (حتى 1000 حرف).', 'Write your answer (up to 1,000 characters).', 'وەڵامەکەت بنووسە (تا 1000 پیت).'],
  'how.photo': [
    'أضف صورة لشيء طبعته أو صوّرته بنفسك.',
    'Add a photo of something you printed or photographed yourself.',
    'وێنەی شتێک زیاد بکە کە خۆت چاپت کردووە یان وێنەت گرتووە.',
  ],
  'how.photoText': [
    'أضف صورة لشيء طبعته أو صوّرته بنفسك، واكتب إجابتك (حتى 1000 حرف).',
    'Add a photo of something you printed or photographed yourself, and write your answer (up to 1,000 characters).',
    'وێنەی شتێک زیاد بکە کە خۆت چاپت کردووە یان وێنەت گرتووە، و وەڵامەکەت بنووسە (تا 1000 پیت).',
  ],
  'how.none': ['لا يُطلب منك شيء: يكفي أن تشارك.', 'Nothing to send: entering is enough.', 'هیچ شتێک پێویست نییە: بەشداریکردن بەسە.'],
  'how.send': [
    'أرسل مشاركتك قبل {end}. يختار فريق Levonis الفائزين بعد الإغلاق ونعلنهم هنا.',
    'Send your entry before {end}. The Levonis team chooses the winners after it closes, and we announce them here.',
    'بەشدارییەکەت پێش {end} بنێرە. تیمی Levonis دوای داخستن براوەکان هەڵدەبژێرێت و لێرە ڕایاندەگەیەنین.',
  ],
  'winners.title': ['الفائزون', 'Winners', 'براوەکان'],
  'winners.photo': ['عرض الصورة', 'View the photo', 'وێنەکە ببینە'],
  'winners.photoAlt': ['صورة المشاركة الفائزة بالمركز {place}', 'Photo of the {place}-place winning entry', 'وێنەی بەشدارییە براوەکەی پلەی {place}'],
  'winners.readMore': ['اقرأ المزيد', 'Read more', 'زیاتر بخوێنەوە'],
  'winners.readLess': ['اقرأ أقل', 'Read less', 'کەمتر بخوێنەوە'],
  'winners.none': ['لم يُعلن فائزون في هذه المسابقة', 'No winners were named in this competition', 'لەم پێشبڕکێیەدا هیچ براوەیەک ڕانەگەیەنرا'],
  'cta.enter': ['شارك الآن', 'Enter now', 'ئێستا بەشداری بکە'],
  'cta.enterFee': ['شارك بـ {points}', 'Enter for {points}', 'بە {points} بەشداری بکە'], // † pointsObj
  'cta.notEligible': [
    'هذه المسابقة لمن استلم طابعة من Levonis.',
    'This competition is for customers who received a printer from Levonis.',
    'ئەم پێشبڕکێیە بۆ ئەوانەیە کە چاپکەرێکیان لە Levonis وەرگرتووە.',
  ],
  'detail.notFound.title': ['هذه المسابقة غير متاحة', "This competition isn't available", 'ئەم پێشبڕکێیە بەردەست نییە'],
  'detail.notFound.body': [
    'ربما أُلغيت أو لم تُنشر بعد.',
    'It may have been cancelled or not published yet.',
    'لەوانەیە هەڵوەشێنرابێتەوە یان هێشتا بڵاو نەکرابێتەوە.',
  ],
  'detail.all': ['كل المسابقات', 'All competitions', 'هەموو پێشبڕکێکان'],

  // ------------------------------------------------------------ §8.9 the entry sheet, the one-tap confirm, refusals
  'sheet.title': ['مشاركتك', 'Your entry', 'بەشدارییەکەت'],
  'sheet.rules': ['السؤال والشروط', 'The question and rules', 'پرسیار و مەرجەکان'],
  'sheet.photo': ['صورتك', 'Your photo', 'وێنەکەت'],
  'sheet.pick': ['اختر صورة', 'Choose a photo', 'وێنەیەک هەڵبژێرە'],
  'sheet.pickHint': ['صورة واحدة بصيغة JPEG أو PNG أو WebP.', 'One photo: JPEG, PNG or WebP.', 'یەک وێنە: JPEG یان PNG یان WebP.'],
  'sheet.uploading': ['جارٍ رفع الصورة…', 'Uploading the photo…', 'وێنەکە بار دەکرێت…'],
  'sheet.change': ['تغيير الصورة', 'Change the photo', 'گۆڕینی وێنەکە'],
  'sheet.remove': ['إزالة الصورة', 'Remove the photo', 'وێنەکە لابە'],
  'sheet.uploadFailed': [
    'تعذّر رفع الصورة. أعد المحاولة أو اختر صورة أخرى.',
    "The photo couldn't be uploaded. Try again or choose another.",
    'وێنەکە بار نەکرا. دووبارە هەوڵ بدەرەوە یان وێنەیەکی تر هەڵبژێرە.',
  ],
  'sheet.heic': [
    'حفظ الآيفون هذه الصورة بصيغة HEIC. اختر صورة JPEG أو PNG.',
    'Your iPhone saved this photo as HEIC. Choose a JPEG or PNG.',
    'ئایفۆن ئەم وێنەیەی بە شێوازی HEIC پاشەکەوت کردووە. وێنەیەکی JPEG یان PNG هەڵبژێرە.',
  ],
  'sheet.answer': ['إجابتك', 'Your answer', 'وەڵامەکەت'],
  'sheet.counter': ['{n} من {max} حرف', '{n} of {max} characters', '{n} لە {max} پیت'],
  'sheet.ownWork': [
    'يجب أن تكون المشاركة من عملك، والصورة لشيء طبعته أو صوّرته بنفسك.',
    'Your entry must be your own work, and the photo of something you printed or photographed yourself.',
    'بەشدارییەکەت دەبێت کاری خۆت بێت، و وێنەکە هی شتێک بێت کە خۆت چاپت کردووە یان وێنەت گرتووە.',
  ],
  'sheet.once': [
    'مشاركة واحدة لكل حساب، ولا تُعدَّل بعد الإرسال.',
    "One entry per account, and it can't be changed after you send it.",
    'هەر هەژمارێک یەک بەشداری، و دوای ناردن ناگۆڕدرێت.',
  ],
  'sheet.public': [
    'إن فزت، تُعرض مشاركتك — إجابتك وصورتك — مع اسمك المختصر في صفحة المسابقة.',
    "If you win, your entry — answer and photo — is shown with your shortened name on the competition's page.",
    'ئەگەر بیبەیتەوە، بەشدارییەکەت — وەڵام و وێنەکەت — لەگەڵ ناوە کورتکراوەکەت لە پەڕەی پێشبڕکێکەدا پیشان دەدرێت.',
  ],
  'sheet.fee': [
    'تُخصم {points} من رصيدك ({balance}) عند الإرسال، وتُعاد كاملة إن أُلغيت المسابقة أو لم تُقبل مشاركتك.',
    '{points} come off your balance ({balance}) when you send, and are returned in full if the competition is cancelled or your entry is not accepted.',
    '{points} لە کاتی ناردندا لە باڵانسەکەت ({balance}) کەم دەکرێتەوە، و ئەگەر پێشبڕکێکە هەڵبوەشێتەوە یان بەشدارییەکەت پەسەند نەکرێت بە تەواوی دەگەڕێنرێتەوە.',
  ],
  'sheet.send': ['أرسل مشاركتي', 'Send my entry', 'بەشدارییەکەم بنێرە'],
  'sheet.sendFee': ['أرسل وادفع {points}', 'Send and pay {points}', 'بینێرە و {points} بدە'], // † pointsObj
  'sheet.sending': ['جارٍ الإرسال…', 'Sending…', 'دەنێردرێت…'],
  'sheet.waitUpload': ['انتظر حتى يكتمل رفع الصورة', 'Wait for the photo to finish uploading', 'چاوەڕێ بکە تا بارکردنی وێنەکە تەواو دەبێت'],
  'sheet.needAnswer': ['اكتب إجابتك أولًا.', 'Write your answer first.', 'سەرەتا وەڵامەکەت بنووسە.'],
  'sheet.needPhoto': ['أضف صورتك أولًا.', 'Add your photo first.', 'سەرەتا وێنەکەت زیاد بکە.'],
  'sheet.done': [
    'سُجّلت مشاركتك. يختار فريق Levonis الفائزين بعد الإغلاق ونعلنهم هنا.',
    "You're in. The Levonis team chooses the winners after it closes, and we announce them here.",
    'بەشدارییەکەت تۆمار کرا. تیمی Levonis دوای داخستن براوەکان هەڵدەبژێرێت و لێرە ڕایاندەگەیەنین.',
  ],
  'sheet.notInstalled': [
    'المسابقات قيد التجهيز — حاول لاحقًا.',
    'Competitions are being set up — try again later.',
    'پێشبڕکێکان ئامادە دەکرێن — دواتر هەوڵ بدەرەوە.',
  ],
  'confirm.title': ['الاشتراك في «{title}»؟', 'Enter «{title}»?', 'بەشداری لە «{title}» دەکەیت؟'],
  'confirm.free': [
    'تُسجَّل مشاركتك الآن، ولكل حساب مشاركة واحدة.',
    'Your entry is recorded now; one entry per account.',
    'بەشدارییەکەت ئێستا تۆمار دەکرێت، و بۆ هەر هەژمارێک یەک بەشداری هەیە.',
  ],
  'confirm.fee': [
    'تُخصم {points} من رصيدك الآن، وتُعاد كاملة إن أُلغيت المسابقة أو لم تُقبل مشاركتك.',
    '{points} come off your balance now, and are returned in full if the competition is cancelled or your entry is not accepted.',
    '{points} ئێستا لە باڵانسەکەت کەم دەکرێتەوە، و ئەگەر پێشبڕکێکە هەڵبوەشێتەوە یان بەشدارییەکەت پەسەند نەکرێت بە تەواوی دەگەڕێنرێتەوە.',
  ],
  'confirm.go': ['شارك', 'Enter', 'بەشداری بکە'],
  'err.answerRequired': ['اكتب إجابتك أولًا.', 'Write your answer first.', 'سەرەتا وەڵامەکەت بنووسە.'],
  'err.photoInvalid': [
    'ارفع الصورة أولًا ثم أرسل المشاركة.',
    'Upload the photo first, then send the entry.',
    'سەرەتا وێنەکە باربکە، پاشان بەشدارییەکە بنێرە.',
  ],
  'err.alreadyEntered': ['شاركت في هذه المسابقة من قبل.', 'You have already entered this competition.', 'پێشتر بەشداری ئەم پێشبڕکێیەت کردووە.'],
  'err.points': ['نقاطك لا تكفي للاشتراك.', 'You do not have enough points to enter.', 'خاڵەکانت بەس نین بۆ بەشداریکردن.'],
  'err.full': ['اكتمل عدد المشاركين.', 'This competition is full.', 'ژمارەی بەشداربووان تەواو بوو.'],
  'err.notEligible': [
    'هذه المسابقة لمن استلم طابعة من Levonis.',
    'This competition is for customers who received a printer from Levonis.',
    'ئەم پێشبڕکێیە بۆ ئەوانەیە کە چاپکەرێکیان لە Levonis وەرگرتووە.',
  ],
  'err.notOpen': ['المسابقة ليست مفتوحة الآن.', 'The competition is not open now.', 'پێشبڕکێکە ئێستا کراوە نییە.'],
  'err.generic': ['تعذّر إرسال المشاركة.', 'The entry could not be sent.', 'بەشدارییەکە نەنێردرا.'],

  // ------------------------------------------------------------ the gift code and the analysis (DECISIONS row 301)
  'code.ask': ['عندك كود هدية؟', 'Have a gift code?', 'کۆدی دیاریت هەیە؟'],
  'code.label': ['كود الهدية', 'Gift code', 'کۆدی دیاری'],
  'code.confirm': ['تأكيد', 'Confirm', 'پشتڕاستی بکەرەوە'],
  'code.checking': ['جارٍ التحقق…', 'Checking…', 'دەپشکنرێت…'],
  'code.empty': ['اكتب الكود أولًا.', 'Type the code first.', 'سەرەتا کۆدەکە بنووسە.'],
  'code.err.invalid': [
    'هذا الكود غير صحيح. تأكد منه وأعد كتابته.',
    'This code is not valid. Check it and type it again.',
    'ئەم کۆدە دروست نییە. دڵنیا بەرەوە و دووبارە بینووسەوە.',
  ],
  // Said once the gift was delivered or the team cancelled it, so it promises no waiting gift.
  'code.err.used': [
    'استُخدم هذا الكود من قبل. تجد حالة هديتك في «هداياي».',
    "This code has already been used. You can see your gift's status in «My gifts».",
    'ئەم کۆدە پێشتر بەکارهاتووە. دۆخی دیارییەکەت لە «دیارییەکانم» دەبینیت.',
  ],
  'code.err.generic': ['تعذّر التحقق من الكود. أعد المحاولة.', "The code couldn't be checked. Try again.", 'کۆدەکە نەپشکنرا. دووبارە هەوڵ بدەرەوە.'],
  'rate.codeReady': ['اعتُمدت — أدخل الكود', 'Approved — enter your code', 'پەسەندکرا — کۆدەکە بنووسە'],
  'rate.codeReady.note': [
    'اعتُمدت مراجعتك. سيصلك كود هديتك من فريق Levonis، أدخله هنا.',
    'Your review was approved. Your gift code will reach you from the Levonis team; enter it here.',
    'هەڵسەنگاندنەکەت پەسەندکرا. کۆدی دیارییەکەت لە تیمی Levonis ـەوە پێت دەگات، لێرە بینووسە.',
  ],
  'rate.upTo': ['هديتك جاهزة — حتى المستوى {level}', 'Your gift is ready — up to level {level}', 'دیارییەکەت ئامادەیە — تا ئاستی {level}'],
  'rate.score': ['درجتك {score} من {max}', 'You scored {score} of {max}', '{score} لە {max} نمرەت هێنا'],
  'rate.inCart': ['هديتك في سلتك', 'Your gift is in your cart', 'دیارییەکەت لە سەبەتەکەتدایە'],
  'rate.giftOrdered': ['طلبت هديتك', 'You ordered your gift', 'دیارییەکەت داوا کرد'],
  'rate.watch': ['شاهد التحليل', 'Watch the analysis', 'شیکردنەوەکە ببینە'],
  'rate.openFailed': ['تعذّر فتح هديتك. تجدها في «هداياي».', "Your gift couldn't be opened. It is in «My gifts».", 'دیارییەکەت نەکرایەوە. لە «دیارییەکانم»دایە.'],
  'now.giftCode': ['كود هديتك', 'Your gift code', 'کۆدی دیارییەکەت'],
  'now.giftCode.body': [
    'اعتُمدت مراجعتك. حين يصلك الكود من فريق Levonis أدخله في «قيّم طابعتك».',
    'Your review was approved. When the code reaches you from the Levonis team, enter it in «Rate your printer».',
    'هەڵسەنگاندنەکەت پەسەندکرا. کاتێک کۆدەکە لە تیمی Levonis ـەوە پێت دەگات، لە «چاپکەرەکەت هەڵبسەنگێنە» بینووسە.',
  ],
  'now.giftCode.cta': ['أدخل الكود', 'Enter the code', 'کۆدەکە بنووسە'],
  'now.giftUpTo.body': [
    'فتحت مراجعتك المستويات حتى {level}. اختر هدية واحدة منها.',
    'Your review opened the levels up to {level}. Choose one gift from them.',
    'هەڵسەنگاندنەکەت ئاستەکانی تا {level} کردەوە. یەک دیاری لێیان هەڵبژێرە.',
  ],
  'reveal.title': ['تحليل مراجعتك', 'Your review analysis', 'شیکردنەوەی هەڵسەنگاندنەکەت'],
  'reveal.skip': ['تخطَّ', 'Skip', 'تێپەڕێنە'],
  'reveal.download': ['نُنزّل مراجعتك', 'Downloading your review', 'هەڵسەنگاندنەکەت دادەبەزێنین'],
  'reveal.analysing': ['نحلّل مراجعتك', 'Analysing your review', 'هەڵسەنگاندنەکەت شی دەکەینەوە'],
  'reveal.text': ['النص: {chars} · {words}', 'Text: {chars} · {words}', 'دەق: {chars} · {words}'],
  'reveal.images': ['الصور: {images}', 'Photos: {images}', 'وێنەکان: {images}'],
  'reveal.video.yes': ['الفيديو: فيديو واحد', 'Video: one video', 'ڤیدیۆ: یەک ڤیدیۆ'],
  'reveal.video.no': ['الفيديو: بلا فيديو', 'Video: none', 'ڤیدیۆ: بێ ڤیدیۆ'],
  'reveal.story.yes': ['ستوري إنستغرام: وصلنا', 'Instagram story: received', 'ستۆری ئینستاگرام: گەیشت'],
  'reveal.story.no': ['ستوري إنستغرام: لم يصل', 'Instagram story: not received', 'ستۆری ئینستاگرام: نەگەیشت'],
  'reveal.stars': ['التقييم بالنجوم: {stars}★', 'Star rating: {stars}★', 'هەڵسەنگاندن بە ئەستێرە: {stars}★'],
  'reveal.adjust': ['تعديل الجودة', 'Quality adjustment', 'ڕێکخستنی کوالیتی'],
  'reveal.total': ['درجة مراجعتك', 'Your review score', 'نمرەی هەڵسەنگاندنەکەت'],
  'reveal.of100': ['من {max}', 'of {max}', 'لە {max}'],
  'reveal.opensAt': ['يفتح عند {n}', 'Opens at {n}', 'لە {n} دەکرێتەوە'],
  'reveal.opened.one': ['فتحت المستوى {list}', 'You opened level {list}', 'ئاستی {list}ت کردەوە'],
  'reveal.opened.many': ['فتحت المستويات {list}', 'You opened levels {list}', 'ئاستەکانی {list}ت کردەوە'],
  'reveal.pick': ['اختر هدية واحدة', 'Choose one gift', 'یەک دیاری هەڵبژێرە'],
  'reveal.noGifts': [
    'لا هدايا متاحة في مستوياتك الآن. هديتك تنتظرك في «هداياي»، وتظهر حين تتوفر.',
    'No gifts are available on your levels right now. Your gift waits in «My gifts» and appears when they are.',
    'ئێستا هیچ دیارییەک لە ئاستەکانتدا بەردەست نییە. دیارییەکەت لە «دیارییەکانم» چاوەڕێتە و کاتێک هەبوو دەردەکەوێت.',
  ],
  'reveal.deliveryOnly': ['تدفع أجرة التوصيل فقط', 'You pay for delivery only', 'تەنها کرێی گەیاندن دەدەیت'],
  'reveal.confirm.title': ['هديتك النهائية؟', 'Your final gift?', 'دیارییە کۆتاییەکەت؟'],
  'reveal.confirm.body': [
    '{item}. لا يمكن تغييرها بعد التأكيد، وتدفع أجرة التوصيل فقط.',
    "{item}. It can't be changed after you confirm, and you pay for delivery only.",
    '{item}. دوای پشتڕاستکردنەوە ناگۆڕدرێت، و تەنها کرێی گەیاندن دەدەیت.',
  ],
  'reveal.confirm.go': ['تأكيد الهدية', 'Confirm the gift', 'دیارییەکە پشتڕاست بکەرەوە'],
  'reveal.addToCart': ['أضف إلى السلة', 'Add to cart', 'زیادی بکە بۆ سەبەتە'],
  'reveal.chosen': ['هديتك', 'Your gift', 'دیارییەکەت'],
  'reveal.done.body': [
    'أكمل طلبك من السلة: الهدية بسعر {zero} وتدفع أجرة التوصيل فقط.',
    'Complete your order from the cart: the gift costs {zero} and you pay for delivery only.',
    'داواکارییەکەت لە سەبەتەکەوە تەواو بکە: دیارییەکە بە {zero}ە و تەنها کرێی گەیاندن دەدەیت.',
  ],
  'reveal.checkout': ['إتمام الطلب', 'Complete the order', 'داواکارییەکە تەواو بکە'],
  'reveal.ordered': ['طلبت هذه الهدية. تابعها من صفحة الطلب.', 'You ordered this gift. Follow it from the order page.', 'ئەم دیارییەت داوا کرد. لە پەڕەی داواکارییەکەوە بەدوایدا بچۆ.'],
  'reveal.fulfilled': ['وصلتك هذه الهدية. نتمنى أن تعجبك!', 'This gift reached you. We hope you like it!', 'ئەم دیارییە پێت گەیشت. هیوادارین بەدڵت بێت!'],
  'reveal.cancelled': ['أُلغيت هذه الهدية. تواصل مع الدعم إن كان لديك سؤال.', 'This gift was cancelled. Contact support if you have a question.', 'ئەم دیارییە هەڵوەشێنرایەوە. ئەگەر پرسیارت هەیە پەیوەندی بە پشتگیرییەوە بکە.'],
  'reveal.err.generic': [
    'تعذّرت هذه الخطوة. هديتك محفوظة، أعد المحاولة.',
    "That step didn't go through. Your gift is safe; try again.",
    'ئەم هەنگاوە تەواو نەبوو. دیارییەکەت پارێزراوە، دووبارە هەوڵ بدەرەوە.',
  ],
  'reveal.sr.result': ['درجتك {score} من {max}. {opened}.', 'You scored {score} of {max}. {opened}.', '{score} لە {max} نمرەت هێنا. {opened}.'],
} as const satisfies Record<string, CopyRow>;

/**
 * THE SCORE'S SCALE, for the sentences that name it (packages/contracts GIFT_SCORE_MIN,
 * MAX and STEP; tests/giftRevealScript.test.ts holds them equal). Marks and not digits
 * in the strings: on a phone set to an Arabic locale «٢٦» must not sit beside «من 100».
 * The screen passes each through `formatFigure`, like the figure beside it. Written
 * here and not imported, so the customer's rewards chunk shares no module with the admin's.
 */
export const SCORE_SCALE = { from: 1, to: 100, every: 20 } as const;

export type CopyKey = keyof typeof COPY;
export type CopyVars = Record<string, string | number>;
export type CopyPart = { text: string } | { slot: string };

const SLOT: Record<Language, 0 | 1 | 2> = { ar: 0, en: 1, ckb: 2 };

/** One string in the reader's language, its `{name}` marks filled; a mark with no value stays visible. */
export function copyText(key: CopyKey, lang: Language, vars?: CopyVars): string {
  const raw: string = COPY[key][SLOT[lang] ?? 0];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (mark, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : mark));
}

/** The same string cut at its `{name}` marks, for a screen that puts an element (a figure, a clock) in one. */
export function copyParts(key: CopyKey, lang: Language): CopyPart[] {
  const raw: string = COPY[key][SLOT[lang] ?? 0];
  const out: CopyPart[] = [];
  let last = 0;
  for (const m of raw.matchAll(/\{(\w+)\}/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: raw.slice(last, at) });
    out.push({ slot: m[1] });
    last = at + m[0].length;
  }
  if (last < raw.length) out.push({ text: raw.slice(last) });
  return out;
}

/** The keys marked † in spec §8: their `{points}` is the oblique `pointsObj` form, never `points`. */
export const POINTS_OBJ_KEYS: ReadonlySet<CopyKey> = new Set<CopyKey>(['door.shop.from', 'shop.confirm.title', 'rate.noLevel', 'row.fee', 'cta.enterFee', 'sheet.sendFee']);

/** Which counted form fills `{points}` in `key`. */
export function pointsForm(key: CopyKey): 'points' | 'pointsObj' {
  return POINTS_OBJ_KEYS.has(key) ? 'pointsObj' : 'points';
}

/**
 * COUNTED SENTENCES (spec §8.10): the count decides the words. Arabic: none /
 * one / two / 3–10 / 11–99 / 100 and up, by the last two digits (the rule of
 * src/lib/catalog/copy.ts `countNoun`); English: none / one / other; Sorani
 * counts with the singular noun: none / other.
 */
export interface Counted {
  ar: { zero: string; one: string; two: string; few: string; many: string; hundred: string };
  en: { zero: string; one: string; other: string };
  ckb: { zero: string; other: string };
}

export const COUNTED = {
  points: {
    ar: { zero: '{n} نقطة', one: 'نقطة واحدة', two: 'نقطتان', few: '{n} نقاط', many: '{n} نقطة', hundred: '{n} نقطة' },
    en: { zero: '{n} points', one: '1 point', other: '{n} points' },
    ckb: { zero: '{n} خاڵ', other: '{n} خاڵ' },
  },
  pointsObj: {
    ar: { zero: '{n} نقطة', one: 'نقطة واحدة', two: 'نقطتين', few: '{n} نقاط', many: '{n} نقطة', hundred: '{n} نقطة' },
    en: { zero: '{n} points', one: '1 point', other: '{n} points' },
    ckb: { zero: '{n} خاڵ', other: '{n} خاڵ' },
  },
  days: {
    ar: { zero: 'أقل من يوم', one: 'يومًا واحدًا', two: 'يومين', few: '{n} أيام', many: '{n} يومًا', hundred: '{n} يوم' },
    en: { zero: 'less than a day', one: '1 day', other: '{n} days' },
    ckb: { zero: 'کەمتر لە ڕۆژێک', other: '{n} ڕۆژ' },
  },
  pieces: {
    ar: { zero: 'لا قطع', one: 'قطعة واحدة', two: 'قطعتين', few: '{n} قطع', many: '{n} قطعة', hundred: '{n} قطعة' },
    en: { zero: 'no pieces', one: '1 piece', other: '{n} pieces' },
    ckb: { zero: 'هیچ پارچەیەک', other: '{n} پارچە' },
  },
  months: {
    ar: { zero: 'أقل من شهر', one: 'شهرًا واحدًا', two: 'شهرين', few: '{n} أشهر', many: '{n} شهرًا', hundred: '{n} شهر' },
    en: { zero: 'less than a month', one: '1 month', other: '{n} months' },
    ckb: { zero: 'کەمتر لە مانگێک', other: '{n} مانگ' },
  },
  daysLeft: {
    ar: { zero: 'آخر يوم', one: 'يوم واحد متبقٍ', two: 'يومان متبقيان', few: '{n} أيام متبقية', many: '{n} يومًا متبقيًا', hundred: '{n} يوم متبقٍ' },
    en: { zero: 'Last day', one: '1 day left', other: '{n} days left' },
    ckb: { zero: 'دوایین ڕۆژ', other: '{n} ڕۆژ ماوە' },
  },
  couponsActive: {
    ar: {
      zero: 'لا كوبونات صالحة الآن',
      one: 'كوبون صالح واحد',
      two: 'كوبونان صالحان',
      few: '{n} كوبونات صالحة',
      many: '{n} كوبونًا صالحًا',
      hundred: '{n} كوبون صالح',
    },
    en: { zero: 'No coupons to use right now', one: '1 coupon to use', other: '{n} coupons to use' },
    ckb: { zero: 'ئێستا هیچ کۆپۆنێکی چالاکت نییە', other: '{n} کۆپۆنی چالاک' },
  },
  printersToRate: {
    ar: {
      zero: 'لا طابعات بانتظار مراجعتك',
      one: 'طابعة واحدة بانتظار مراجعتك',
      two: 'طابعتان بانتظار مراجعتك',
      few: '{n} طابعات بانتظار مراجعتك',
      many: '{n} طابعة بانتظار مراجعتك',
      hundred: '{n} طابعة بانتظار مراجعتك',
    },
    en: { zero: 'No printers to review', one: '1 printer to review', other: '{n} printers to review' },
    ckb: { zero: 'هیچ چاپکەرێک بۆ هەڵسەنگاندن نییە', other: '{n} چاپکەر بۆ هەڵسەنگاندن' },
  },
  competitionsToEnter: {
    ar: {
      zero: 'لا مسابقات تنتظر مشاركتك',
      one: 'مسابقة مفتوحة لم تشارك فيها',
      two: 'مسابقتان مفتوحتان لم تشارك فيهما',
      few: '{n} مسابقات مفتوحة لم تشارك فيها',
      many: '{n} مسابقة مفتوحة لم تشارك فيها',
      hundred: '{n} مسابقة مفتوحة لم تشارك فيها',
    },
    en: {
      zero: 'No open competition waiting for you',
      one: "1 open competition you haven't entered",
      other: "{n} open competitions you haven't entered",
    },
    ckb: { zero: 'هیچ پێشبڕکێیەک چاوەڕێی بەشداریت ناکات', other: '{n} پێشبڕکێی کراوە بۆ بەشداریکردنت' },
  },
  competitionsOpen: {
    ar: {
      zero: 'لا مسابقات مفتوحة الآن',
      one: 'مسابقة واحدة مفتوحة الآن',
      two: 'مسابقتان مفتوحتان الآن',
      few: '{n} مسابقات مفتوحة الآن',
      many: '{n} مسابقة مفتوحة الآن',
      hundred: '{n} مسابقة مفتوحة الآن',
    },
    en: { zero: 'None open right now', one: '1 open now', other: '{n} open now' },
    ckb: { zero: 'ئێستا هیچ پێشبڕکێیەکی کراوە نییە', other: '{n} پێشبڕکێی کراوە' },
  },
  entrants: {
    ar: { zero: 'لا مشاركين بعد', one: 'مشارك واحد', two: 'مشاركان', few: '{n} مشاركين', many: '{n} مشاركًا', hundred: '{n} مشارك' },
    en: { zero: 'No entrants yet', one: '1 entrant', other: '{n} entrants' },
    ckb: { zero: 'هێشتا هیچ بەشداربوویەک نییە', other: '{n} بەشداربوو' },
  },
  spotsLeft: {
    ar: { zero: 'لا أماكن متبقية', one: 'بقي مكان واحد', two: 'بقي مكانان', few: 'بقيت {n} أماكن', many: 'بقي {n} مكانًا', hundred: 'بقي {n} مكان' },
    en: { zero: 'No spots left', one: '1 spot left', other: '{n} spots left' },
    ckb: { zero: 'هیچ شوێنێک نەماوە', other: '{n} شوێن ماوە' },
  },
  pointsShort: {
    ar: {
      zero: 'لا تحتاج نقاطًا أخرى',
      one: 'تحتاج نقطة واحدة أخرى',
      two: 'تحتاج نقطتين أخريين',
      few: 'تحتاج {n} نقاط أخرى',
      many: 'تحتاج {n} نقطة أخرى',
      hundred: 'تحتاج {n} نقطة أخرى',
    },
    en: { zero: 'You need no more points', one: 'You need 1 more point', other: 'You need {n} more points' },
    ckb: { zero: 'هیچ خاڵێکی ترت پێویست نییە', other: '{n} خاڵی ترت پێویستە' },
  },
  pointsShortToEnter: {
    ar: {
      zero: 'نقاطك تكفي للاشتراك',
      one: 'تحتاج نقطة واحدة أخرى للاشتراك',
      two: 'تحتاج نقطتين أخريين للاشتراك',
      few: 'تحتاج {n} نقاط أخرى للاشتراك',
      many: 'تحتاج {n} نقطة أخرى للاشتراك',
      hundred: 'تحتاج {n} نقطة أخرى للاشتراك',
    },
    en: { zero: 'You have enough points to enter', one: 'You need 1 more point to enter', other: 'You need {n} more points to enter' },
    ckb: { zero: 'خاڵەکانت بەسن بۆ بەشداریکردن', other: '{n} خاڵی ترت پێویستە بۆ بەشداریکردن' },
  },
  moreProducts: {
    ar: {
      zero: 'بلا منتجات أخرى',
      one: 'ومنتج آخر',
      two: 'ومنتجان آخران',
      few: 'و{n} منتجات أخرى',
      many: 'و{n} منتجًا آخر',
      hundred: 'و{n} منتج آخر',
    },
    en: { zero: 'nothing else', one: 'and 1 more', other: 'and {n} more' },
    ckb: { zero: 'هیچی تر نییە', other: 'و {n}ی تر' },
  },
  targetsMore: {
    ar: {
      zero: 'لا منتجات أخرى',
      one: 'ويشمل الكوبون منتجًا آخر',
      two: 'ويشمل الكوبون منتجين آخرين',
      few: 'ويشمل الكوبون {n} منتجات أخرى',
      many: 'ويشمل الكوبون {n} منتجًا آخر',
      hundred: 'ويشمل الكوبون {n} منتج آخر',
    },
    en: { zero: 'Nothing else', one: 'The coupon covers 1 more', other: 'The coupon covers {n} more' },
    ckb: { zero: 'هیچی تر نییە', other: 'کۆپۆنەکە {n}ی تریش دەگرێتەوە' },
  },
  chars: {
    ar: { zero: 'بلا حروف', one: 'حرف واحد', two: 'حرفان', few: '{n} أحرف', many: '{n} حرفًا', hundred: '{n} حرف' },
    en: { zero: 'no characters', one: '1 character', other: '{n} characters' },
    ckb: { zero: 'هیچ پیتێک', other: '{n} پیت' },
  },
  words: {
    ar: { zero: 'بلا كلمات', one: 'كلمة واحدة', two: 'كلمتان', few: '{n} كلمات', many: '{n} كلمة', hundred: '{n} كلمة' },
    en: { zero: 'no words', one: '1 word', other: '{n} words' },
    ckb: { zero: 'هیچ وشەیەک', other: '{n} وشە' },
  },
  images: {
    ar: { zero: 'بلا صور', one: 'صورة واحدة', two: 'صورتان', few: '{n} صور', many: '{n} صورة', hundred: '{n} صورة' },
    en: { zero: 'none', one: '1 photo', other: '{n} photos' },
    ckb: { zero: 'بێ وێنە', other: '{n} وێنە' },
  },
  moreWinners: {
    ar: {
      zero: 'بلا فائزين آخرين',
      one: 'وفائز آخر',
      two: 'وفائزان آخران',
      few: 'و{n} فائزين آخرين',
      many: 'و{n} فائزًا آخر',
      hundred: 'و{n} فائز آخر',
    },
    en: { zero: 'no one else', one: 'and 1 more', other: 'and {n} more' },
    ckb: { zero: 'کەسی تر نییە', other: 'و {n} براوەی تر' },
  },
} as const satisfies Record<string, Counted>;

export type CountedKey = keyof typeof COUNTED;

/** The form a count takes in `lang`, still holding its `{n}` mark. */
export function countedForm(c: Counted, n: number, lang: Language): string {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (lang === 'en') return count === 0 ? c.en.zero : count === 1 ? c.en.one : c.en.other;
  if (lang === 'ckb') return count === 0 ? c.ckb.zero : c.ckb.other;
  if (count === 0) return c.ar.zero;
  if (count === 1) return c.ar.one;
  if (count === 2) return c.ar.two;
  const r = count % 100;
  if (r >= 3 && r <= 10) return c.ar.few;
  if (r >= 11 && r <= 99) return c.ar.many;
  return c.ar.hundred;
}

/**
 * A counted sentence, `{n}` filled in EVERY form (unlike the house
 * `countedText`, which leaves the Arabic zero, one and two forms unfilled) by
 * `shown`: the figure in the reader's digits.
 */
export function countText(key: CountedKey, n: number, lang: Language, shown: string = formatFigure(n, lang)): string {
  return countedForm(COUNTED[key], n, lang).replace(/\{n\}/g, () => shown);
}

/** A place in words, 1 to 10: the server names at most ten places (worker MAX_PRIZE_PLACES). */
export const ORDINAL = {
  ar: ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'],
  en: ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'],
  ckb: ['یەکەم', 'دووەم', 'سێیەم', 'چوارەم', 'پێنجەم', 'شەشەم', 'حەوتەم', 'هەشتەم', 'نۆیەم', 'دەیەم'],
} as const satisfies Record<Language, readonly string[]>;

const ENGLISH_SUFFIX = ['th', 'st', 'nd', 'rd'] as const;

/** «الثاني» / «2nd» / «دووەم». A place past the tenth reads as its figure (English adds its suffix). */
export function ordinal(place: number, lang: Language): string {
  const n = Math.floor(place);
  const words: readonly string[] = ORDINAL[lang] ?? ORDINAL.ar;
  if (n >= 1 && n <= words.length) return words[n - 1];
  const figure = formatFigure(n, lang);
  if (lang !== 'en') return figure;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${figure}${teen ? 'th' : (ENGLISH_SUFFIX[n % 10] ?? 'th')}`;
}
