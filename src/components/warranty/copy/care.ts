import type { Language } from '../../../translations';

/**
 * LEVO CARE ON THE WARRANTY PAGE (DECISIONS rows 347, 358 and 359): what it gives on
 * a device, what else it includes (the weekly coupons of the first year and the
 * monthly draw — a chance, never a promise), the quote on a claim, and the
 * discounted part the team sends in the conversation. Care is never a free replacement — every sentence here says
 * «خصم». A key missing from a language is a type error; the Sorani is Sorani.
 */
export interface CareStrings {
  title: string;
  state: Record<'not_delivered' | 'active' | 'expired' | 'closed' | 'terms_missing', string>;
  activeUntil: (date: string) => string;
  expiredOn: (date: string) => string;
  /** One sentence: what Care is, and that it is not a free replacement. */
  what: string;
  /** While the warranty still runs / once Care is the only cover. */
  duringWarranty: string;
  afterWarranty: string;
  discountUpTo: (pct: string) => string;
  claimsLeft: (n: number, formatted: string) => string;
  benefitLeft: (amount: string) => string;
  noMoneyCap: string;
  discount: (pct: string) => string;
  laborCovered: string;
  shippingCovered: string;
  parts: string;
  exclusions: string;
  showTerms: string;
  hideTerms: string;
  claimBadge: string;

  // the quote
  quoteTitle: string;
  quoteIntro: string;
  /** On a claim card: a quote waits for the customer's «أوافق». */
  quoteWaiting: string;
  labor: string;
  shipping: string;
  other: string;
  list: string;
  discountLine: (pct: string) => string;
  youPay: string;
  accept: string;
  accepting: string;
  accepted: string;
  approved: string;
  voided: string;
  copayPaid: string;
  changed: string;

  // the part offer (phase 5)
  offerTitle: string;
  offerPct: (pct: string) => string;
  offerUntil: (date: string) => string;
  offerState: Record<'live' | 'used' | 'revoked' | 'expired', string>;
  /** Outside the conversation: the device or the claim has an offer waiting. */
  offerWaiting: (n: number, formatted: string) => string;
  seeOffer: string;
  priceBefore: string;
  priceAfter: string;
  capNote: (amount: string) => string;
  addToCart: string;
  adding: string;
  added: string;
  goCart: string;
  chooseOptions: string;
  /** The discount applies by itself in the cart, once, on this account only. */
  autoNote: string;
  usedNote: (amount: string) => string;
  viewOrder: string;
  revokedNote: string;
  expiredNote: (date: string) => string;
  productGone: string;
  unavailable: string;
  addFailed: string;

  // what else Levo Care includes (phase 5b, DECISIONS row 359)
  includesTitle: string;
  perkParts: string;
  /** The weekly coupons of this device run until that day. */
  perkCouponsUntil: (date: string) => string;
  perkCouponsEnded: (date: string) => string;
  couponsLink: string;
  /** The monthly draw: entered automatically while Care runs. A chance, not a promise. */
  perkDraw: string;
  drawWon: (prize: string) => string;
  drawClaim: string;
}

const careAr: CareStrings = {
  title: 'ليفو كير',
  state: {
    not_delivered: 'يبدأ عند استلام الطابعة',
    active: 'ساري',
    expired: 'انتهى',
    closed: 'مُغلق — أُعيدت الطابعة',
    terms_missing: 'الشروط قيد الإعداد — تواصل معنا',
  },
  activeUntil: (d) => `ساري حتى ${d}`,
  expiredOn: (d) => `انتهى في ${d}`,
  what: 'خصم على القطعة التي تحتاجها — ليس استبدالًا مجانيًا.',
  duringWarranty: 'الآن: العيب المصنعي يغطيه الضمان مجانًا، وليفو كير لضرر الاستخدام.',
  afterWarranty: 'الضمان انتهى: اطلب الخصم وسنرسل لك القطعة بسعرها بعد الخصم.',
  discountUpTo: (p) => `خصم حتى ${p}% على القطع`,
  claimsLeft: (n, f) => (n === 0 ? 'لا طلبات متبقية' : n === 1 ? 'طلب واحد متبقٍ' : n === 2 ? 'طلبان متبقيان' : n <= 10 ? `${f} طلبات متبقية` : `${f} طلبًا متبقيًا`),
  benefitLeft: (a) => `رصيد الخصم المتبقي ${a}`,
  noMoneyCap: 'بلا سقف للخصم',
  discount: (p) => `خصم ${p}% على القطع المشمولة`,
  laborCovered: 'أجرة العمل مشمولة بالخصم',
  shippingCovered: 'الشحن مشمول بالخصم',
  parts: 'القطع المشمولة',
  exclusions: 'لا يشمل',
  showTerms: 'الشروط',
  hideTerms: 'إخفاء الشروط',
  claimBadge: 'ليفو كير',

  quoteTitle: 'عرض ليفو كير',
  quoteIntro: 'هذا ما سيكلفه الإصلاح بعد خصم ليفو كير. وافق عليه ليبدأ الفريق.',
  quoteWaiting: 'عرض سعر بانتظار موافقتك',
  labor: 'أجرة العمل',
  shipping: 'الشحن',
  other: 'أخرى',
  list: 'السعر الكامل',
  discountLine: (p) => `خصم ليفو كير (${p}%)`,
  youPay: 'تدفع',
  accept: 'أوافق على العرض',
  accepting: 'جارٍ الإرسال…',
  accepted: 'وافقت على العرض — بانتظار اعتماد الفريق.',
  approved: 'اعتُمد الخصم، والإصلاح جارٍ.',
  voided: 'أُلغي هذا العرض. سيكتب لك الفريق في المحادثة.',
  copayPaid: 'استُلم المبلغ. شكراً لك.',
  changed: 'تغيّر العرض منذ فتحته — هذا هو الجديد. راجعه ثم وافق.',

  offerTitle: 'قطعة بخصم ليفو كير',
  offerPct: (p) => `خصم ليفو كير ${p}%`,
  offerUntil: (d) => `العرض ساري حتى ${d}`,
  offerState: { live: 'ساري', used: 'استُخدم', revoked: 'أُلغي', expired: 'انتهى' },
  offerWaiting: (n, f) => (n <= 1 ? 'لديك عرض قطعة بخصم ليفو كير' : n === 2 ? 'لديك عرضا قطع بخصم ليفو كير' : `لديك ${f} عروض قطع بخصم ليفو كير`),
  seeOffer: 'اعرض العرض',
  priceBefore: 'السعر',
  priceAfter: 'بعد الخصم',
  capNote: (a) => `الخصم بحد أقصى ${a}`,
  addToCart: 'أضف إلى السلة',
  adding: 'جارٍ الإضافة…',
  added: 'أُضيفت إلى السلة',
  goCart: 'اذهب إلى السلة',
  chooseOptions: 'اختر الخيارات',
  autoNote: 'الخصم يُطبَّق تلقائيًا في السلة: مرة واحدة، على قطعة واحدة، ولهذا الحساب فقط.',
  usedNote: (a) => `استخدمت هذا العرض — خُصم ${a} من طلبك.`,
  viewOrder: 'عرض الطلب',
  revokedNote: 'ألغى الفريق هذا العرض.',
  expiredNote: (d) => `انتهى العرض في ${d}. اطلب من الفريق عرضًا جديدًا في المحادثة.`,
  productGone: 'هذه القطعة لم تعد في المتجر.',
  unavailable: 'القطعة غير متوفرة الآن.',
  addFailed: 'تعذّرت الإضافة إلى السلة. حاول مجددًا.',

  includesTitle: 'ما يشمله ليفو كير',
  perkParts: 'خصم على القطعة التي تحتاجها',
  perkCouponsUntil: (d) => `كوبونات أسبوعية حتى ${d}`,
  perkCouponsEnded: (d) => `انتهت الكوبونات الأسبوعية في ${d}`,
  couponsLink: 'كوبوناتي',
  perkDraw: 'السحب الشهري: تدخل تلقائيًا كل شهر ما دام ليفو كير ساريًا — فرصة للفوز لا وعد.',
  drawWon: (p) => `فزت بسحب هذا الشهر: ${p}`,
  drawClaim: 'استلم جائزتك من «هداياي»',
};

const careEn: CareStrings = {
  title: 'Levo Care',
  state: {
    not_delivered: 'Starts when the printer is delivered',
    active: 'Active',
    expired: 'Ended',
    closed: 'Closed — the printer was returned',
    terms_missing: 'Terms being prepared — contact us',
  },
  activeUntil: (d) => `Active until ${d}`,
  expiredOn: (d) => `Ended on ${d}`,
  what: 'A discount on the part you need — not a free replacement.',
  duringWarranty: 'For now: a factory defect is covered free by the warranty, and Levo Care is for damage from use.',
  afterWarranty: 'The warranty has ended: ask for the discount and we send you the part at its discounted price.',
  discountUpTo: (p) => `Up to ${p}% off parts`,
  claimsLeft: (n, f) => (n === 0 ? 'No requests left' : n === 1 ? '1 request left' : `${f} requests left`),
  benefitLeft: (a) => `${a} of discount left`,
  noMoneyCap: 'No discount cap',
  discount: (p) => `${p}% off covered parts`,
  laborCovered: 'Labour is discounted',
  shippingCovered: 'Shipping is discounted',
  parts: 'Covered parts',
  exclusions: 'Not covered',
  showTerms: 'Terms',
  hideTerms: 'Hide terms',
  claimBadge: 'Levo Care',

  quoteTitle: 'Levo Care quote',
  quoteIntro: 'This is what the repair costs after your Levo Care discount. Accept it so the team can start.',
  quoteWaiting: 'A quote is waiting for your approval',
  labor: 'Labour',
  shipping: 'Shipping',
  other: 'Other',
  list: 'Full price',
  discountLine: (p) => `Levo Care discount (${p}%)`,
  youPay: 'You pay',
  accept: 'Accept the quote',
  accepting: 'Sending…',
  accepted: 'You accepted the quote — waiting for the team to approve it.',
  approved: 'The discount is approved and the repair is under way.',
  voided: 'This quote was cancelled. The team will write to you in the conversation.',
  copayPaid: 'Payment received. Thank you.',
  changed: 'The quote changed since you opened it — this is the new one. Review it, then accept.',

  offerTitle: 'A part at a Levo Care discount',
  offerPct: (p) => `Levo Care discount ${p}%`,
  offerUntil: (d) => `Offer valid until ${d}`,
  offerState: { live: 'Live', used: 'Used', revoked: 'Cancelled', expired: 'Expired' },
  offerWaiting: (n, f) => (n <= 1 ? 'You have a part offer at a Levo Care discount' : `You have ${f} part offers at a Levo Care discount`),
  seeOffer: 'See the offer',
  priceBefore: 'Price',
  priceAfter: 'After the discount',
  capNote: (a) => `Discount capped at ${a}`,
  addToCart: 'Add to cart',
  adding: 'Adding…',
  added: 'Added to cart',
  goCart: 'Go to cart',
  chooseOptions: 'Choose options',
  autoNote: 'The discount applies by itself in the cart: once, on one unit, on this account only.',
  usedNote: (a) => `You used this offer — ${a} came off your order.`,
  viewOrder: 'View order',
  revokedNote: 'The team cancelled this offer.',
  expiredNote: (d) => `The offer expired on ${d}. Ask the team for a new one in the conversation.`,
  productGone: 'This part is no longer in the store.',
  unavailable: 'The part is not available right now.',
  addFailed: 'It could not be added to the cart. Try again.',

  includesTitle: 'What Levo Care includes',
  perkParts: 'A discount on the part you need',
  perkCouponsUntil: (d) => `Weekly coupons until ${d}`,
  perkCouponsEnded: (d) => `The weekly coupons ended on ${d}`,
  couponsLink: 'My coupons',
  perkDraw: 'The monthly draw: you are entered automatically every month while Levo Care is active — a chance to win, not a promise.',
  drawWon: (p) => `You won this month's draw: ${p}`,
  drawClaim: 'Claim your prize in "My gifts"',
};

const careCkb: CareStrings = {
  title: 'لیڤۆ کێر',
  state: {
    not_delivered: 'لە کاتی گەیاندنی پرینتەرەکەدا دەست پێدەکات',
    active: 'چالاکە',
    expired: 'کۆتایی هات',
    closed: 'داخراوە — پرینتەرەکە گەڕێنرایەوە',
    terms_missing: 'مەرجەکان ئامادە دەکرێن — پەیوەندیمان پێوە بکە',
  },
  activeUntil: (d) => `چالاکە تا ${d}`,
  expiredOn: (d) => `لە ${d} کۆتایی هات`,
  what: 'داشکاندن لەسەر ئەو پارچەیەی پێویستتە — گۆڕینی بەخۆڕایی نییە.',
  duringWarranty: 'ئێستا: کەموکوڕیی کارگە گەرەنتی بەخۆڕایی دەیگرێتەوە، و لیڤۆ کێر بۆ زیانی بەکارهێنانە.',
  afterWarranty: 'گەرەنتی تەواو بووە: داوای داشکاندن بکە و پارچەکە بە نرخی دوای داشکاندن بۆت دەنێرین.',
  discountUpTo: (p) => `داشکاندن تا ${p}% لەسەر پارچە`,
  claimsLeft: (n, f) => (n === 0 ? 'هیچ داواکارییەک نەماوە' : `${f} داواکاری ماوە`),
  benefitLeft: (a) => `${a} داشکاندن ماوە`,
  noMoneyCap: 'داشکاندن سنووری نییە',
  discount: (p) => `${p}% داشکاندن لەسەر پارچە گیراوەکان`,
  laborCovered: 'کرێی کار داشکاندنی دەگرێتەوە',
  shippingCovered: 'ناردن داشکاندنی دەگرێتەوە',
  parts: 'پارچە گیراوەکان',
  exclusions: 'ناگرێتەوە',
  showTerms: 'مەرجەکان',
  hideTerms: 'شاردنەوەی مەرجەکان',
  claimBadge: 'لیڤۆ کێر',

  quoteTitle: 'نرخنامەی لیڤۆ کێر',
  quoteIntro: 'ئەمە تێچووی چاککردنەوەکەیە دوای داشکاندنی لیڤۆ کێر. ڕازی بە تا تیمەکە دەست پێبکات.',
  quoteWaiting: 'نرخنامەیەک چاوەڕێی ڕازیبوونی تۆیە',
  labor: 'کرێی کار',
  shipping: 'ناردن',
  other: 'هی تر',
  list: 'نرخی تەواو',
  discountLine: (p) => `داشکاندنی لیڤۆ کێر (${p}%)`,
  youPay: 'تۆ دەیدەیت',
  accept: 'ڕازیم بە نرخنامەکە',
  accepting: 'دەنێردرێت…',
  accepted: 'ڕازی بوویت بە نرخنامەکە — چاوەڕێی پەسەندکردنی تیمەکەیە.',
  approved: 'داشکاندنەکە پەسەند کرا و چاککردنەوەکە بەڕێوەیە.',
  voided: 'ئەم نرخنامەیە هەڵوەشێنرایەوە. تیمەکە لە گفتوگۆکەدا بۆت دەنووسێت.',
  copayPaid: 'پارەکە وەرگیرا. سوپاس.',
  changed: 'نرخنامەکە لەو کاتەوەی کردتەوە گۆڕاوە — ئەمە نوێیەکەیە. پێیدا بچۆرەوە و پاشان ڕازی بە.',

  offerTitle: 'پارچەیەک بە داشکاندنی لیڤۆ کێر',
  offerPct: (p) => `داشکاندنی لیڤۆ کێر ${p}%`,
  offerUntil: (d) => `ئۆفەرەکە تا ${d} کارایە`,
  offerState: { live: 'کارایە', used: 'بەکارهات', revoked: 'هەڵوەشایەوە', expired: 'بەسەرچوو' },
  offerWaiting: (n, f) => (n <= 1 ? 'ئۆفەری پارچەیەکت هەیە بە داشکاندنی لیڤۆ کێر' : `${f} ئۆفەری پارچەت هەیە بە داشکاندنی لیڤۆ کێر`),
  seeOffer: 'ئۆفەرەکە ببینە',
  priceBefore: 'نرخ',
  priceAfter: 'دوای داشکاندن',
  capNote: (a) => `زۆرترین داشکاندن ${a}`,
  addToCart: 'زیادکردن بۆ سەبەتە',
  adding: 'زیاد دەکرێت…',
  added: 'خرایە سەبەتەوە',
  goCart: 'بڕۆ بۆ سەبەتە',
  chooseOptions: 'هەڵبژاردنەکان دیاری بکە',
  autoNote: 'داشکاندنەکە خۆکارانە لە سەبەتەدا جێبەجێ دەبێت: یەک جار، لەسەر یەک دانە، و تەنها بۆ ئەم هەژمارە.',
  usedNote: (a) => `ئەم ئۆفەرەت بەکارهێنا — ${a} لە داواکارییەکەت داشکێنرا.`,
  viewOrder: 'بینینی داواکاری',
  revokedNote: 'تیمەکە ئەم ئۆفەرەی هەڵوەشاندەوە.',
  expiredNote: (d) => `ئۆفەرەکە لە ${d} بەسەرچوو. لە گفتوگۆکەدا داوای ئۆفەرێکی نوێ لە تیمەکە بکە.`,
  productGone: 'ئەم پارچەیە چیتر لە فرۆشگاکەدا نییە.',
  unavailable: 'پارچەکە ئێستا بەردەست نییە.',
  addFailed: 'نەتوانرا بخرێتە سەبەتەوە. دووبارە هەوڵ بدەوە.',

  includesTitle: 'لیڤۆ کێر چی لەخۆدەگرێت',
  perkParts: 'داشکاندن لەسەر ئەو پارچەیەی پێویستتە',
  perkCouponsUntil: (d) => `کۆپۆنی هەفتانە تا ${d}`,
  perkCouponsEnded: (d) => `کۆپۆنە هەفتانەکان لە ${d} کۆتایییان هات`,
  couponsLink: 'کۆپۆنەکانم',
  perkDraw: 'تیروپشکی مانگانە: هەموو مانگێک خۆکارانە بەشدار دەبیت تا لیڤۆ کێرەکەت چالاک بێت — دەرفەتێکە بۆ بردنەوە، نەک بەڵێن.',
  drawWon: (p) => `براوەی تیروپشکی ئەم مانگەیت: ${p}`,
  drawClaim: 'خەڵاتەکەت لە «دیارییەکانم» وەربگرە',
};

export const CARE_STRINGS: Record<Language, CareStrings> = { ar: careAr, en: careEn, ckb: careCkb };
