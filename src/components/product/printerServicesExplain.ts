/**
 * «ماذا يشمل؟» — what each service of «تخصيص بنفسي» gives (owner, 2026-11-19: «need hint that show
 * what is this service provide or include … extra protection and Levo Care the most important one
 * and warranty»; DECISIONS row 362).
 *
 * Imported ONLY by CustomizeSheet, so these words ride the sheet's own lazy chunk — never the
 * product page's opening, the cart or the checkout.
 *
 * EVERY SENTENCE IS A FACT THE SHOP ALREADY STATES, and nothing more:
 *  - Warranty: the published Warranty document (worker/lib/policies/warranty.ts 5.3–5.5: a part that
 *    failed from a manufacturing fault is repaired or replaced, the device is not swapped; misuse,
 *    accidents and consumables are outside it), the months count from delivery (extended_warranty.ts
 *    6.7), and claims are filed on /warranty.
 *  - Levo Care: src/components/warranty/copy/care.ts («خصم … ليس استبدالًا مجانيًا») and DECISIONS
 *    rows 347 / 359 — the discount ceiling is the offer's own `max_discount_pct`; the weekly coupons
 *    run 12 months from delivery; the monthly draw is A CHANCE, never a promise.
 *  - Packaging: the factory packaging is always included; the option is the warehouse's extra layer
 *    over it. It names no material and promises no outcome.
 *  - Inspection: the warehouse task that must be completed, with its note, before the printer is
 *    handed to the courier (DECISIONS row 339), and the offer's own lead days.
 *  - Academy: the recorded videos, or a live course by WhatsApp or in person, arranged after the order.
 * Each language is written in that language; the Sorani is Sorani, not the Arabic respelled.
 */
import type { PsLang } from './printerServicesStrings';

export interface ExplainStrings {
  /** The disclosure under a service's choices. */
  whatIncluded: string;
  /** The tag on Levo Care: the service the owner calls the most important. */
  mostImportant: string;
  /** One line under the row's title, always visible. */
  warrantySum: string;
  careSum: (pct: number) => string;
  packagingSum: string;
  inspectionSum: string;
  academySum: string;
  /** The bullets of «ماذا يشمل؟». */
  warranty: string[];
  care: (pct: number) => string[];
  packaging: string[];
  inspection: (lo: number, hi: number) => string[];
  academy: string[];
}

const AR: ExplainStrings = {
  whatIncluded: 'ماذا يشمل؟',
  mostImportant: 'الأهم',
  warrantySum: 'إصلاح أو استبدال القطعة التي فيها عيب مصنعي، مجاناً',
  careSum: (pct) => `12 شهراً بعد الضمان: خصم حتى ${pct}% على القطعة التي تحتاجها`,
  packagingSum: 'حماية إضافية فوق تغليف المصنع قبل الشحن',
  inspectionSum: 'نفحص طابعتك نفسها فحصاً كاملاً قبل إرسالها',
  academySum: 'فيديوهات مسجّلة، أو دورة مباشرة مع فريقنا',
  warranty: [
    'القطعة التي يثبت فيها عيب مصنعي تُصلَّح أو تُستبدل مجاناً.',
    'المدة كاملة تُحسب من تاريخ استلامك الطابعة.',
    'تقدّم المطالبة وتتابعها من صفحة «الضمان» في حسابك.',
    'لا يشمل: سوء الاستخدام والحوادث والسقوط، ولا القطع الاستهلاكية مثل الفوهة والسير وسطح الطباعة.',
    'هو إصلاح أو استبدال للقطعة المعيبة، وليس استبدالاً للطابعة كاملة.',
  ],
  care: (pct) => [
    'يستمر 12 شهراً إضافياً بعد انتهاء الضمان.',
    `خصم حتى ${pct}% على القطعة التي تحتاجها إذا انتهى الضمان أو كان الضرر من الاستخدام — وليس استبدالاً مجانياً.`,
    'كوبونات أسبوعية لمدة 12 شهراً من استلام الطابعة.',
    'دخول سحب شهري على فلمنت مجاني — فرصة للفوز، وليس وعداً.',
  ],
  packaging: [
    'تغليف المصنع الآمن مشمول دائماً مع كل طابعة، بلا رسوم.',
    'الحماية الإضافية طبقة يضيفها فريق المخزن فوق تغليف المصنع قبل الشحن.',
    'مناسبة إذا كانت الطابعة ستقطع مسافة طويلة أو تُنقل أكثر من مرة.',
  ],
  inspection: (lo, hi) => [
    'فريقنا يفحص طابعتك نفسها فحصاً كاملاً قبل الشحن.',
    'لا تُسلَّم للمندوب قبل اكتمال الفحص وتسجيل نتيجته.',
    `يضيف ${lo}–${hi} أيام عمل إلى تجهيز الطلب.`,
  ],
  academy: [
    'الفيديوهات المسجّلة تشاهدها متى شئت.',
    'الدورة المباشرة مع فريقنا: عبر واتساب أو حضورياً.',
    'نتواصل معك بعد الطلب لتحديد موعد الدورة.',
  ],
};

const EN: ExplainStrings = {
  whatIncluded: "What's included?",
  mostImportant: 'Most important',
  warrantySum: 'A part with a factory defect is repaired or replaced, free',
  careSum: (pct) => `12 months after the warranty: up to ${pct}% off the part you need`,
  packagingSum: 'Extra protection over the factory packaging before it ships',
  inspectionSum: 'A full check of your own printer before it is sent',
  academySum: 'Recorded videos, or a live course with our team',
  warranty: [
    'A part shown to have a factory defect is repaired or replaced free.',
    'All the months count from the day you receive the printer.',
    'You file and follow a claim on the Warranty page of your account.',
    'Not covered: misuse, accidents and drops, or consumables such as the nozzle, belts and build plate.',
    'It repairs or replaces the faulty part; it does not swap the whole printer.',
  ],
  care: (pct) => [
    'It runs for 12 more months after the warranty ends.',
    `Up to ${pct}% off the part you need when the warranty has ended or the damage came from use — not a free replacement.`,
    'Weekly coupons for 12 months from the day you receive the printer.',
    'Entry in a monthly draw for free filament — a chance to win, not a promise.',
  ],
  packaging: [
    'Safe factory packaging is always included with every printer, at no charge.',
    'Extra protection is a layer our warehouse team adds over the factory packaging before it ships.',
    'A good fit when the printer travels a long way or is moved more than once.',
  ],
  inspection: (lo, hi) => [
    'Our team gives your own printer a full check before it ships.',
    'It is not handed to the courier until the check is finished and its result is recorded.',
    `It adds ${lo}–${hi} business days to preparing the order.`,
  ],
  academy: [
    'Recorded videos you watch whenever you like.',
    'A live course with our team: over WhatsApp or in person.',
    'We contact you after the order to agree the time.',
  ],
};

const CKB: ExplainStrings = {
  whatIncluded: 'چی لەخۆدەگرێت؟',
  mostImportant: 'گرنگترین',
  warrantySum: 'ئەو پارچەیەی کەموکوڕیی کارگەی هەیە بەخۆڕایی چاک دەکرێتەوە یان دەگۆڕدرێت',
  careSum: (pct) => `12 مانگ دوای گەرەنتی: داشکاندن تا ${pct}% لەسەر ئەو پارچەیەی پێویستتە`,
  packagingSum: 'پاراستنی زیادە لەسەر پێچانەوەی کارگە پێش ناردن',
  inspectionSum: 'پشکنینی تەواوی پرینتەرەکەی خۆت پێش ناردنی',
  academySum: 'ڤیدیۆی تۆمارکراو، یان خولی ڕاستەوخۆ لەگەڵ تیمەکەمان',
  warranty: [
    'ئەو پارچەیەی کەموکوڕیی کارگەی تێدا دەسەلمێنرێت بەخۆڕایی چاک دەکرێتەوە یان دەگۆڕدرێت.',
    'هەموو مانگەکان لەو ڕۆژەوە دەژمێردرێن کە پرینتەرەکە وەردەگریت.',
    'داواکاریی گەرەنتی لە پەڕەی «گەرەنتی»ی هەژمارەکەتەوە پێشکەش دەکەیت و بەدوایدا دەچیت.',
    'نایگرێتەوە: خراپ بەکارهێنان، ڕووداو و کەوتن، هەروەها پارچە بەکاربراوەکان وەک نۆزڵ و قایش و ڕووی چاپکردن.',
    'چاککردنەوە یان گۆڕینی پارچە کەموکوڕەکەیە، نەک گۆڕینی هەموو پرینتەرەکە.',
  ],
  care: (pct) => [
    'دوای تەواوبوونی گەرەنتی 12 مانگی تر بەردەوام دەبێت.',
    `داشکاندن تا ${pct}% لەسەر ئەو پارچەیەی پێویستتە کاتێک گەرەنتی تەواو بووە یان زیانەکە لە بەکارهێنانەوەیە — گۆڕینی بەخۆڕایی نییە.`,
    'کۆپۆنی هەفتانە بۆ 12 مانگ لە ڕۆژی وەرگرتنی پرینتەرەکەوە.',
    'بەشداری لە تیروپشکی مانگانەی فیلامێنتی بەخۆڕایی — دەرفەتێکە بۆ بردنەوە، بەڵێن نییە.',
  ],
  packaging: [
    'پێچانەوەی سەلامەتی کارگە هەمیشە لەگەڵ هەموو پرینتەرێکدایە، بێ پارە.',
    'پاراستنی زیادە چینێکە تیمی کۆگا پێش ناردن لەسەر پێچانەوەی کارگە زیادی دەکات.',
    'گونجاوە کاتێک پرینتەرەکە ڕێگایەکی دوور دەبڕێت یان زیاتر لە جارێک دەگوازرێتەوە.',
  ],
  inspection: (lo, hi) => [
    'تیمەکەمان پرینتەرەکەی خۆت پێش ناردن بە تەواوی دەپشکنێت.',
    'تا پشکنینەکە تەواو نەبێت و ئەنجامەکەی تۆمار نەکرێت، نادرێتە دەست گەیەنەر.',
    `${lo}–${hi} ڕۆژی کار بۆ ئامادەکردنی داواکارییەکە زیاد دەکات.`,
  ],
  academy: [
    'ڤیدیۆی تۆمارکراو کە هەر کاتێک ویستت سەیری دەکەیت.',
    'خولی ڕاستەوخۆ لەگەڵ تیمەکەمان: لە ڕێگەی واتساپ یان بە ئامادەبوون.',
    'دوای داواکاری پەیوەندیت پێوە دەکەین بۆ دیاریکردنی کاتەکە.',
  ],
};

export const EXPLAIN: Record<PsLang, ExplainStrings> = { ar: AR, en: EN, ckb: CKB };
