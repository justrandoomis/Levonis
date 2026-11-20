/**
 * THE WARRANTY DESK'S WORDS — phase 8 (owner 2026-11-21, DECISIONS row 364).
 *
 * One place for what staff read about a device and a claim, in ar / en / ckb, so the units table, the order
 * screen's warranty section, the serial page and the claims queue cannot tell four different stories:
 *   what the customer BOUGHT (no warranty / 12 / 24 months; Levo Care or not; the package),
 *   what is IN FORCE today and until when,
 *   which of the four situations a claim was filed in, and the next correct action.
 * A customer who bought no warranty never reads as «منتهي»: nothing ended, nothing was bought.
 *
 * The shapes are the server's (worker/lib/warrantyDesk.ts). Pure text and pure functions: no fetch, no state.
 */
export type DeskLang = 'ar' | 'en' | 'ckb';
export const deskLang = (lang: string): DeskLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');

/**
 * The owner's free-return promise for a printer bought WITH a warranty (phase 7). The storefront's number lives in
 * src/components/product/printerServicesStrings.ts (WARRANTY_FREE_RETURN_DAYS); it is repeated here so this admin
 * chunk does not pull the storefront's strings in, and tests/warrantyDeskPhase8.test.ts keeps the two equal.
 * INFORMATION ONLY: the returns desk enforces its own window and never reads the printer's services.
 */
export const FREE_RETURN_DAYS = 7;

export interface DeskServices {
  package: string | null;
  warranty_months: 0 | 12 | 24;
  care: boolean;
  care_total_months: number;
  inspection: 'none' | 'pending' | 'done';
  inspection_done_at: string | null;
  free_return: boolean;
  ack_no_warranty: boolean;
  order_id: string | null;
}
export interface DeskCare {
  state: 'none' | 'not_delivered' | 'active' | 'expired' | 'closed' | 'terms_missing';
  start_at: string | null;
  care_only_from: string | null;
  end_at: string | null;
  warranty_months: number;
  total_months: number;
  claims_left: number | null;
  benefit_left_iqd: number | null;
  discount_pct: number | null;
}
export interface DeskCover {
  now: 'warranty' | 'care' | 'none' | 'not_delivered' | 'closed' | 'needs_config';
  until: string | null;
  warranty: 'active' | 'ended' | 'none' | 'not_delivered' | 'closed' | 'needs_config';
  warranty_end_at: string | null;
  months: number | null;
  sold_months: number | null;
  goodwill: boolean;
  care_misuse: boolean;
}
export type CoverVerdict = 'warranty' | 'warranty_care' | 'care' | 'none' | 'unknown';
export interface ClaimCover {
  verdict: CoverVerdict;
  warranty: 'active' | 'ended' | 'none' | 'not_delivered' | 'closed' | 'needs_config' | 'unknown';
  warranty_end_at: string | null;
  care: DeskCare['state'] | null;
  care_only_from: string | null;
  care_end_at: string | null;
}
export interface DeskSummary {
  open_claims: { total: number; warranty: number; care: number; by_verdict: Record<CoverVerdict, number> };
  care: { holders: number; ending_30d: number } | null;
  inspections_pending: number | null;
  part_offers: { live: number; used: number; used_discount_iqd: number } | null;
}

const AR = {
  bought: 'اشترى الزبون',
  today: 'الساري اليوم',
  noWarranty: 'بدون ضمان',
  noWarrantyLong: 'بدون ضمان — لم يشترِ الزبون ضماناً',
  warrantyMonths: (n: number) => `ضمان ${n} شهراً`,
  withCare: (n: number) => `ليفو كير (${n} شهراً من التسليم)`,
  noCare: 'بدون ليفو كير',
  packages: { just: 'الطابعة فقط', smart: 'الاختيار الذكي', complete: 'التجربة الكاملة', custom: 'مخصص' } as Record<string, string>,
  beforeServices: 'بيعت قبل خدمات الطابعة',
  goodwill: (now: number, sold: number) => `منحة من المالك: الضمان الآن ${now} شهراً (المبيع ${sold === 0 ? 'بدون ضمان' : `${sold} شهراً`})`,
  nowWarranty: (date: string) => `الضمان ساري حتى ${date}`,
  nowCare: (date: string) => `ليفو كير فقط حتى ${date} — خصم على القطع، لا إصلاح مجاني`,
  nowNoneNever: 'لا تغطية — لم يُشترَ ضمان ولا ليفو كير',
  nowNoneEnded: (date: string) => `لا تغطية — انتهى الضمان في ${date}`,
  nowNoneCareEnded: (date: string) => `لا تغطية — انتهت ليفو كير في ${date}`,
  nowNotDelivered: 'لم يُسلَّم بعد — تبدأ التغطية من التسليم',
  nowClosed: 'أُغلقت التغطية (الجهاز أُرجع)',
  nowNeedsConfig: 'مدة الضمان غير مُعدّة لهذا المنتج',
  daysLeft: (n: number) => `باقي ${n} يوماً`,
  careMisuse: 'وليفو كير تغطي سوء الاستخدام خلال الضمان',
  careAfter: (from: string, to: string) => `ليفو كير وحدها من ${from} حتى ${to}`,
  careLeft: (claims: number | null, money: string | null) =>
    [claims !== null ? `باقي ${claims} مطالبة` : '', money ? `باقي ${money} من سقف الخصم` : ''].filter(Boolean).join(' · '),
  careTermsMissing: 'شروط ليفو كير لم تُنشر بعد',
  freeReturn: `إرجاع مجاني خلال ${FREE_RETURN_DAYS} أيام من التسليم (مع الضمان)`,
  noFreeReturn: 'الطابعة بدون ضمان: لا إرجاع مجاني',
  returnInfo: 'للعلم فقط — مكتب المرتجعات يطبّق قواعده.',
  inspectionDone: 'فُحصت قبل الشحن',
  inspectionPending: 'بانتظار الفحص قبل الشحن',
  chipWarranty: 'ضمان ساري',
  chipCare: 'ليفو كير فقط',
  chipNoWarranty: 'لم يُشترَ ضمان',
  chipEnded: 'انتهى الضمان',
  chipNotDelivered: 'غير مُسلَّم',
  chipClosed: 'التغطية مغلقة',
  chipNeedsConfig: 'بحاجة إعداد',
  coverHeader: 'التغطية',
  // The claim
  verdict: {
    warranty: 'ضمن الضمان',
    warranty_care: 'ضمن الضمان · ليفو كير لسوء الاستخدام',
    care: 'ليفو كير (الضمان غير ساري)',
    none: 'غير مغطّاة',
    unknown: 'لا جهاز مرتبط',
  } as Record<CoverVerdict, string>,
  verdictWhy: {
    warranty: (c: ClaimCover, d: (s: string | null) => string) => `قُدِّمت والضمان ساري${c.warranty_end_at ? ` (حتى ${d(c.warranty_end_at)})` : ''}.`,
    warranty_care: (c: ClaimCover, d: (s: string | null) => string) =>
      `قُدِّمت والضمان ساري${c.warranty_end_at ? ` (حتى ${d(c.warranty_end_at)})` : ''}، وعلى الجهاز ليفو كير${c.care_end_at ? ` حتى ${d(c.care_end_at)}` : ''}.`,
    care: (c: ClaimCover, d: (s: string | null) => string) =>
      `${c.warranty === 'none' ? 'لم يشترِ الزبون ضماناً' : 'انتهى الضمان قبل تقديمها'}، وليفو كير سارية${c.care_end_at ? ` حتى ${d(c.care_end_at)}` : ''}.`,
    none: (c: ClaimCover) =>
      `${c.warranty === 'none' ? 'لم يشترِ الزبون ضماناً' : c.warranty === 'closed' ? 'أُغلقت تغطية الجهاز (مُرجَع)' : 'انتهى الضمان قبل تقديمها'}، ${c.care === 'expired' ? 'وانتهت ليفو كير' : c.care === 'terms_missing' ? 'وشروط ليفو كير لم تُنشر' : 'ولا ليفو كير'}.`,
    unknown: () => 'المطالبة لا تسمّي جهازاً: اربطها بجهاز الزبون قبل القرار.',
  },
  next: {
    warranty: 'التالي: افحص العطل. عطل مصنعي ← اقبل المطالبة (إصلاح أو استبدال على حساب المتجر).',
    warranty_care: 'التالي: عطل مصنعي ← اقبلها ضماناً. سوء استخدام ← لا ترفض: اعرض خصم ليفو كير من «ليفو كير والتكاليف» وأشّر «سوء استخدام».',
    care: 'التالي: لا إصلاح مجاني. اكتب عرض ليفو كير أو أرسل قطعة بخصم من «ليفو كير والتكاليف».',
    none: 'التالي: إصلاح مدفوع بالسعر الكامل إن أراد الزبون، أو ارفض المطالبة مع السبب.',
    unknown: 'التالي: اطلب من الزبون رقم الجهاز التسلسلي.',
  } as Record<CoverVerdict, string>,
  nextAccepted: 'التالي: أصلِح الجهاز (أو سجّل البديل)، ثم انقل المطالبة إلى «منتهية».',
  nextCareQuoted: 'عرض ليفو كير أُرسل — بانتظار موافقة الزبون.',
  nextCareAccepted: 'وافق الزبون على العرض — بانتظار اعتماد المسؤول المالي.',
  nextCareApproved: 'ليفو كير معتمدة — أصلِح ثم استلم مساهمة الزبون.',
  quoteState: { quoted: 'عرض بانتظار الزبون', accepted: 'وافق الزبون — بانتظار الاعتماد', approved: 'معتمد', void: 'ملغى' } as Record<string, string>,
  // The move sheet
  misuseCareWarn: 'على هذا الجهاز ليفو كير سارية، وسوء الاستخدام هو ما تغطيه ليفو كير. الرفض يُلغي عرض ليفو كير وعروض القطع غير المستخدمة. الأصح: أغلق هذه النافذة وافتح «ليفو كير والتكاليف» واعرض الخصم.',
  misuseCareConfirm: 'أرفض المطالبة رغم ذلك، وأُلغي ليفو كير عنها',
  openCarePanel: 'افتح ليفو كير والتكاليف',
  // Filters, search, links
  tabClaims: 'مطالبات الضمان وليفو كير',
  searchClaims: 'ابحث برقم تسلسلي، زبون أو رقم طلب…',
  filterKind: 'النوع',
  filterCover: 'التغطية',
  any: 'الكل',
  kindWarranty: 'ضمان',
  kindCare: 'ليفو كير',
  openOrder: 'الطلب',
  openSerial: 'صفحة الجهاز',
  // The strip
  sumOpen: 'مطالبات مفتوحة',
  sumOpenSplit: (w: number, c: number) => `${w} ضمان · ${c} ليفو كير`,
  sumCare: 'أجهزة عليها ليفو كير',
  sumCareEnding: (n: number) => `${n} تنتهي خلال 30 يوماً`,
  sumInspect: 'طابعات بانتظار الفحص',
  sumOffers: 'عروض قطع سارية',
  sumOffersUsed: (n: number, m: string) => `${n} مستخدمة · خصم ${m}`,
  // The months form of a printer sold with the services
  svcWarrantyTitle: 'ضمان هذه الطابعة',
  svcWarrantyBody: 'الضمان هنا مدة كاملة اشتراها الزبون مع خدمات الطابعة، ولا تمديد فوقها. تغييرها منحة من المالك وحده، تُسجَّل باسمه وسببها، ولا تنزل عمّا اشتراه الزبون.',
  svcSold: 'ما اشتراه الزبون',
  svcNow: 'ضمان الجهاز الآن',
  svcNewTotal: 'المدة الكاملة الجديدة (شهر، من التسليم)',
  svcOwnerOnly: 'هذا التغيير للمالك وحده.',
  svcBelowSold: (n: number) => `لا تنزل المدة عن ${n} شهراً — هذا ما اشتراه الزبون.`,
  svcCareFollows: 'ليفو كير تتبع نهاية الضمان الجديدة: تبقى 12 شهراً بعده، ولا تقصر عمّا بيع.',
  svcSave: 'حفظ منحة المالك',
  svcOpen: 'منحة ضمان (المالك)',
  months: 'شهراً',
  // The receipt
  noReceipt: 'بدون ضمان — لم يشترِ الزبون ضماناً، فلا يصدر وصل ضمان لهذه الطابعة.',
  noReceiptOwner: 'إن أراد المالك منحها ضماناً فمن «منحة ضمان (المالك)» أولاً.',
  wrongReceipt: 'هذا الوصل صدر لطابعة اشتراها الزبون بدون ضمان، وهو لا يتحقق كساري على صفحة التحقق. ألغِه من «وصولات الضمان» مع السبب.',
  receiptMonthsFixed: 'مدة الوصل هي ما اشتراه الزبون',
  // Replacement
  replaceCareOnly: 'هذا الجهاز خارج الضمان وعليه ليفو كير فقط. ليفو كير خصم على القطع وليس استبدالاً مجانياً.',
  replaceCareOnlyConfirm: 'قرار المالك: استبدله رغم ذلك (اكتب السبب)',
  loadFailed: 'تعذّر التحميل — أعد المحاولة.',
  orderStatus: {
    pending: 'بانتظار التأكيد', confirmed: 'مؤكَّد', processing: 'قيد التجهيز', shipped: 'شُحن', delivered: 'مُسلَّم', cancelled: 'ملغى', returned: 'مُرجَع',
  } as Record<string, string>,
  notSerialized: 'لا يحتوي هذا الطلب على منتجات تُتابَع بأرقام تسلسلية (طابعات).',
  cover: 'التغطية',
};

type Strings = typeof AR;

const EN: Strings = {
  bought: 'Customer bought',
  today: 'In force today',
  noWarranty: 'No warranty',
  noWarrantyLong: 'No warranty — the customer bought none',
  warrantyMonths: (n) => `${n}-month warranty`,
  withCare: (n) => `Levo Care (${n} months from delivery)`,
  noCare: 'No Levo Care',
  packages: { just: 'Just Printer', smart: 'Smart Choice', complete: 'Complete', custom: 'Custom' },
  beforeServices: 'Sold before printer services',
  goodwill: (now, sold) => `Owner’s goodwill: the warranty is now ${now} months (sold: ${sold === 0 ? 'no warranty' : `${sold} months`})`,
  nowWarranty: (date) => `Warranty in force until ${date}`,
  nowCare: (date) => `Levo Care only until ${date} — a discount on parts, no free repair`,
  nowNoneNever: 'No cover — no warranty and no Levo Care were bought',
  nowNoneEnded: (date) => `No cover — the warranty ended on ${date}`,
  nowNoneCareEnded: (date) => `No cover — Levo Care ended on ${date}`,
  nowNotDelivered: 'Not delivered yet — cover starts at delivery',
  nowClosed: 'Cover closed (the device was returned)',
  nowNeedsConfig: 'No warranty length is set for this product',
  daysLeft: (n) => `${n} days left`,
  careMisuse: 'and Levo Care takes misuse during the warranty',
  careAfter: (from, to) => `Levo Care alone from ${from} to ${to}`,
  careLeft: (claims, money) => [claims !== null ? `${claims} claim(s) left` : '', money ? `${money} of the discount cap left` : ''].filter(Boolean).join(' · '),
  careTermsMissing: 'The Levo Care terms were never published',
  freeReturn: `Free return within ${FREE_RETURN_DAYS} days of delivery (with the warranty)`,
  noFreeReturn: 'Printer without a warranty: no free return',
  returnInfo: 'Information only — the returns desk applies its own rules.',
  inspectionDone: 'Inspected before dispatch',
  inspectionPending: 'Awaiting the pre-dispatch inspection',
  chipWarranty: 'Under warranty',
  chipCare: 'Levo Care only',
  chipNoWarranty: 'No warranty bought',
  chipEnded: 'Warranty ended',
  chipNotDelivered: 'Not delivered',
  chipClosed: 'Cover closed',
  chipNeedsConfig: 'Needs setup',
  coverHeader: 'Cover',
  verdict: {
    warranty: 'Under warranty',
    warranty_care: 'Under warranty · Levo Care for misuse',
    care: 'Levo Care (no warranty in force)',
    none: 'Not covered',
    unknown: 'No device linked',
  },
  verdictWhy: {
    warranty: (c, d) => `Filed while the warranty was in force${c.warranty_end_at ? ` (until ${d(c.warranty_end_at)})` : ''}.`,
    warranty_care: (c, d) =>
      `Filed while the warranty was in force${c.warranty_end_at ? ` (until ${d(c.warranty_end_at)})` : ''}, and the device holds Levo Care${c.care_end_at ? ` until ${d(c.care_end_at)}` : ''}.`,
    care: (c, d) =>
      `${c.warranty === 'none' ? 'The customer bought no warranty' : 'The warranty had ended when it was filed'}, and Levo Care was in force${c.care_end_at ? ` until ${d(c.care_end_at)}` : ''}.`,
    none: (c) =>
      `${c.warranty === 'none' ? 'The customer bought no warranty' : c.warranty === 'closed' ? 'The device’s cover was closed (returned)' : 'The warranty had ended when it was filed'}, ${c.care === 'expired' ? 'and Levo Care had ended' : c.care === 'terms_missing' ? 'and the Levo Care terms were never published' : 'and there is no Levo Care'}.`,
    unknown: () => 'The claim names no device: link it to the customer’s device before deciding.',
  },
  next: {
    warranty: 'Next: diagnose. A manufacturing fault → approve the claim (repair or replace at the shop’s cost).',
    warranty_care: 'Next: a manufacturing fault → approve it under warranty. Misuse → do not reject: offer the Levo Care discount from “Levo Care and costs” and tick “misuse”.',
    care: 'Next: no free repair. Write a Levo Care quote or send a discounted part from “Levo Care and costs”.',
    none: 'Next: a paid repair at full price if the customer wants it, or reject the claim with the reason.',
    unknown: 'Next: ask the customer for the device’s serial number.',
  },
  nextAccepted: 'Next: repair the device (or record the replacement), then move the claim to “Resolved”.',
  nextCareQuoted: 'Levo Care quote sent — waiting for the customer to accept.',
  nextCareAccepted: 'The customer accepted — waiting for a financial admin to approve.',
  nextCareApproved: 'Levo Care approved — repair, then collect the customer’s co-pay.',
  quoteState: { quoted: 'Quote waiting for the customer', accepted: 'Customer accepted — awaiting approval', approved: 'Approved', void: 'Void' },
  misuseCareWarn: 'Levo Care is in force on this device, and misuse is what Levo Care covers. Rejecting cancels the Levo Care quote and any unused part offers. Better: close this window, open “Levo Care and costs” and offer the discount.',
  misuseCareConfirm: 'Reject the claim anyway and cancel its Levo Care',
  openCarePanel: 'Open Levo Care and costs',
  tabClaims: 'Warranty & Levo Care claims',
  searchClaims: 'Search by serial, customer or order…',
  filterKind: 'Kind',
  filterCover: 'Cover',
  any: 'All',
  kindWarranty: 'Warranty',
  kindCare: 'Levo Care',
  openOrder: 'Order',
  openSerial: 'Device page',
  sumOpen: 'Open claims',
  sumOpenSplit: (w, c) => `${w} warranty · ${c} Levo Care`,
  sumCare: 'Devices with Levo Care',
  sumCareEnding: (n) => `${n} ending within 30 days`,
  sumInspect: 'Printers awaiting inspection',
  sumOffers: 'Live part offers',
  sumOffersUsed: (n, m) => `${n} used · ${m} discount`,
  svcWarrantyTitle: 'This printer’s warranty',
  svcWarrantyBody: 'The warranty here is one total the customer bought with the printer’s services; nothing is stacked on it. Changing it is the owner’s goodwill alone, recorded with their name and reason, and it never goes below what the customer bought.',
  svcSold: 'What the customer bought',
  svcNow: 'The device’s warranty now',
  svcNewTotal: 'New total (months, from delivery)',
  svcOwnerOnly: 'Only the owner can make this change.',
  svcBelowSold: (n) => `Not below ${n} months — that is what the customer bought.`,
  svcCareFollows: 'Levo Care follows the new warranty end: still 12 months after it, never shorter than what was sold.',
  svcSave: 'Save the owner’s goodwill',
  svcOpen: 'Goodwill warranty (owner)',
  months: 'months',
  noReceipt: 'No warranty — the customer bought none, so no warranty receipt is issued for this printer.',
  noReceiptOwner: 'If the owner wants to grant one, use “Goodwill warranty (owner)” first.',
  wrongReceipt: 'This receipt was issued for a printer the customer bought with no warranty; it does not verify as covered. Void it from “Warranty receipts” with the reason.',
  receiptMonthsFixed: 'The receipt’s length is what the customer bought',
  replaceCareOnly: 'This device is out of warranty and held by Levo Care only. Levo Care is a discount on parts, not a free replacement.',
  replaceCareOnlyConfirm: 'Owner’s decision: replace it anyway (write the reason)',
  loadFailed: 'Could not load — try again.',
  orderStatus: { pending: 'Awaiting confirmation', confirmed: 'Confirmed', processing: 'Being prepared', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned' },
  notSerialized: 'This order has no products followed by serial number (printers).',
  cover: 'Cover',
};

const CKB: Strings = {
  bought: 'کڕیار کڕیویەتی',
  today: 'ئەوەی ئەمڕۆ کارایە',
  noWarranty: 'بەبێ گەرەنتی',
  noWarrantyLong: 'بەبێ گەرەنتی — کڕیار گەرەنتی نەکڕیوە',
  warrantyMonths: (n) => `گەرەنتی ${n} مانگ`,
  withCare: (n) => `لیڤۆ کێر (${n} مانگ لە گەیاندنەوە)`,
  noCare: 'بەبێ لیڤۆ کێر',
  packages: { just: 'تەنها پرینتەر', smart: 'هەڵبژاردنی زیرەک', complete: 'ئەزموونی تەواو', custom: 'دڵخواز' },
  beforeServices: 'پێش خزمەتگوزارییەکانی چاپکەر فرۆشراوە',
  goodwill: (now, sold) => `بەخشینی خاوەن: گەرەنتی ئێستا ${now} مانگە (فرۆشراو: ${sold === 0 ? 'بەبێ گەرەنتی' : `${sold} مانگ`})`,
  nowWarranty: (date) => `گەرەنتی کارایە تا ${date}`,
  nowCare: (date) => `تەنها لیڤۆ کێر تا ${date} — داشکاندن لەسەر پارچەکان، چاککردنەوەی بەخۆڕایی نییە`,
  nowNoneNever: 'هیچ داپۆشینێک نییە — نە گەرەنتی و نە لیڤۆ کێر نەکڕدراوە',
  nowNoneEnded: (date) => `هیچ داپۆشینێک نییە — گەرەنتی لە ${date} کۆتایی هات`,
  nowNoneCareEnded: (date) => `هیچ داپۆشینێک نییە — لیڤۆ کێر لە ${date} کۆتایی هات`,
  nowNotDelivered: 'هێشتا نەگەیەنراوە — داپۆشین لە گەیاندنەوە دەست پێدەکات',
  nowClosed: 'داپۆشینەکە داخراوە (ئامێرەکە گەڕێنراوەتەوە)',
  nowNeedsConfig: 'ماوەی گەرەنتی بۆ ئەم بەرهەمە دیاری نەکراوە',
  daysLeft: (n) => `${n} ڕۆژ ماوە`,
  careMisuse: 'و لیڤۆ کێر لە ماوەی گەرەنتیدا خراپ بەکارهێنان دەگرێتەوە',
  careAfter: (from, to) => `تەنها لیڤۆ کێر لە ${from} تا ${to}`,
  careLeft: (claims, money) => [claims !== null ? `${claims} داواکاری ماوە` : '', money ? `${money} لە سەقفی داشکاندن ماوە` : ''].filter(Boolean).join(' · '),
  careTermsMissing: 'مەرجەکانی لیڤۆ کێر هێشتا بڵاونەکراونەتەوە',
  freeReturn: `گەڕاندنەوەی بەخۆڕایی لە ماوەی ${FREE_RETURN_DAYS} ڕۆژ لە گەیاندنەوە (لەگەڵ گەرەنتی)`,
  noFreeReturn: 'چاپکەری بەبێ گەرەنتی: گەڕاندنەوەی بەخۆڕایی نییە',
  returnInfo: 'تەنها بۆ زانیاری — مێزی گەڕاندنەوە یاساکانی خۆی جێبەجێ دەکات.',
  inspectionDone: 'پێش ناردن پشکنراوە',
  inspectionPending: 'چاوەڕێی پشکنینی پێش ناردنە',
  chipWarranty: 'گەرەنتی کارایە',
  chipCare: 'تەنها لیڤۆ کێر',
  chipNoWarranty: 'گەرەنتی نەکڕدراوە',
  chipEnded: 'گەرەنتی کۆتایی هاتووە',
  chipNotDelivered: 'نەگەیەنراوە',
  chipClosed: 'داپۆشین داخراوە',
  chipNeedsConfig: 'پێویستی بە ڕێکخستنە',
  coverHeader: 'داپۆشین',
  verdict: {
    warranty: 'لە ماوەی گەرەنتیدا',
    warranty_care: 'لە ماوەی گەرەنتیدا · لیڤۆ کێر بۆ خراپ بەکارهێنان',
    care: 'لیڤۆ کێر (گەرەنتی کارا نییە)',
    none: 'داپۆشراو نییە',
    unknown: 'هیچ ئامێرێک نەبەستراوە',
  },
  verdictWhy: {
    warranty: (c, d) => `کاتێک پێشکەشکرا گەرەنتی کارا بوو${c.warranty_end_at ? ` (تا ${d(c.warranty_end_at)})` : ''}.`,
    warranty_care: (c, d) =>
      `کاتێک پێشکەشکرا گەرەنتی کارا بوو${c.warranty_end_at ? ` (تا ${d(c.warranty_end_at)})` : ''}، و ئامێرەکە لیڤۆ کێری لەسەرە${c.care_end_at ? ` تا ${d(c.care_end_at)}` : ''}.`,
    care: (c, d) =>
      `${c.warranty === 'none' ? 'کڕیار گەرەنتی نەکڕیوە' : 'پێش پێشکەشکردنی گەرەنتی کۆتایی هاتبوو'}، و لیڤۆ کێر کارا بوو${c.care_end_at ? ` تا ${d(c.care_end_at)}` : ''}.`,
    none: (c) =>
      `${c.warranty === 'none' ? 'کڕیار گەرەنتی نەکڕیوە' : c.warranty === 'closed' ? 'داپۆشینی ئامێرەکە داخراوە (گەڕێنراوەتەوە)' : 'پێش پێشکەشکردنی گەرەنتی کۆتایی هاتبوو'}، ${c.care === 'expired' ? 'و لیڤۆ کێریش کۆتایی هاتبوو' : c.care === 'terms_missing' ? 'و مەرجەکانی لیڤۆ کێر بڵاونەکراونەتەوە' : 'و لیڤۆ کێریشی نییە'}.`,
    unknown: () => 'داواکارییەکە ناوی هیچ ئامێرێک ناهێنێت: پێش بڕیاردان بیبەستە بە ئامێری کڕیارەوە.',
  },
  next: {
    warranty: 'دواتر: کێشەکە بپشکنە. کێشەی کارگە ← داواکارییەکە پەسەند بکە (چاککردنەوە یان گۆڕین لەسەر حسابی فرۆشگا).',
    warranty_care: 'دواتر: کێشەی کارگە ← وەک گەرەنتی پەسەندی بکە. خراپ بەکارهێنان ← ڕەتی مەکەرەوە: لە «لیڤۆ کێر و تێچووەکان»ەوە داشکاندنی لیڤۆ کێر پێشکەش بکە و «خراپ بەکارهێنان» نیشان بکە.',
    care: 'دواتر: چاککردنەوەی بەخۆڕایی نییە. پێشنیاری لیڤۆ کێر بنووسە یان لە «لیڤۆ کێر و تێچووەکان»ەوە پارچەیەک بە داشکاندن بنێرە.',
    none: 'دواتر: ئەگەر کڕیار بیەوێت چاککردنەوە بە نرخی تەواو، یان داواکارییەکە لەگەڵ هۆکار ڕەت بکەرەوە.',
    unknown: 'دواتر: ژمارە زنجیرەیی ئامێرەکە لە کڕیار بخوازە.',
  },
  nextAccepted: 'دواتر: ئامێرەکە چاک بکەرەوە (یان جێگرەوەکە تۆمار بکە)، پاشان داواکارییەکە بگوازەوە بۆ «تەواوبووە».',
  nextCareQuoted: 'پێشنیاری لیڤۆ کێر نێردرا — چاوەڕێی قبوڵکردنی کڕیارە.',
  nextCareAccepted: 'کڕیار قبوڵی کرد — چاوەڕێی پەسەندکردنی بەرپرسی داراییە.',
  nextCareApproved: 'لیڤۆ کێر پەسەندکراوە — چاکی بکەرەوە، پاشان بەشداریی کڕیار وەربگرە.',
  quoteState: { quoted: 'پێشنیار چاوەڕێی کڕیارە', accepted: 'کڕیار قبوڵی کرد — چاوەڕێی پەسەندکردنە', approved: 'پەسەندکراوە', void: 'هەڵوەشێنراوەتەوە' },
  misuseCareWarn: 'لیڤۆ کێر لەسەر ئەم ئامێرە کارایە، و خراپ بەکارهێنان ئەوەیە کە لیڤۆ کێر دەیگرێتەوە. ڕەتکردنەوە پێشنیاری لیڤۆ کێر و پێشنیارە بەکارنەهاتووەکانی پارچە هەڵدەوەشێنێتەوە. باشتر: ئەم پەنجەرەیە دابخە، «لیڤۆ کێر و تێچووەکان» بکەرەوە و داشکاندنەکە پێشکەش بکە.',
  misuseCareConfirm: 'لەگەڵ ئەوەشدا داواکارییەکە ڕەت دەکەمەوە و لیڤۆ کێرەکەی هەڵدەوەشێنمەوە',
  openCarePanel: 'لیڤۆ کێر و تێچووەکان بکەرەوە',
  tabClaims: 'داواکارییەکانی گەرەنتی و لیڤۆ کێر',
  searchClaims: 'بە ژمارە زنجیرەیی، کڕیار یان ژمارەی داواکاری بگەڕێ…',
  filterKind: 'جۆر',
  filterCover: 'داپۆشین',
  any: 'هەموو',
  kindWarranty: 'گەرەنتی',
  kindCare: 'لیڤۆ کێر',
  openOrder: 'داواکاری',
  openSerial: 'لاپەڕەی ئامێر',
  sumOpen: 'داواکارییە کراوەکان',
  sumOpenSplit: (w, c) => `${w} گەرەنتی · ${c} لیڤۆ کێر`,
  sumCare: 'ئامێرەکانی خاوەن لیڤۆ کێر',
  sumCareEnding: (n) => `${n} لە ماوەی 30 ڕۆژدا کۆتایی دێت`,
  sumInspect: 'چاپکەرەکانی چاوەڕێی پشکنین',
  sumOffers: 'پێشنیارە کاراکانی پارچە',
  sumOffersUsed: (n, m) => `${n} بەکارهاتوو · داشکاندن ${m}`,
  svcWarrantyTitle: 'گەرەنتی ئەم چاپکەرە',
  svcWarrantyBody: 'گەرەنتی لێرە یەک ماوەی تەواوە کە کڕیار لەگەڵ خزمەتگوزارییەکانی چاپکەرەکە کڕیویەتی، و هیچ درێژکردنەوەیەکی ناخرێتە سەر. گۆڕینی تەنها بەخشینی خاوەنە، بە ناو و هۆکارەکەیەوە تۆمار دەکرێت، و هەرگیز لەوەی کڕیار کڕیویەتی کەمتر نابێت.',
  svcSold: 'ئەوەی کڕیار کڕیویەتی',
  svcNow: 'گەرەنتی ئامێرەکە ئێستا',
  svcNewTotal: 'ماوەی تەواوی نوێ (مانگ، لە گەیاندنەوە)',
  svcOwnerOnly: 'ئەم گۆڕانکارییە تەنها بۆ خاوەنە.',
  svcBelowSold: (n) => `لە ${n} مانگ کەمتر نابێت — ئەوە ئەوەیە کە کڕیار کڕیویەتی.`,
  svcCareFollows: 'لیڤۆ کێر شوێن کۆتایی نوێی گەرەنتی دەکەوێت: هەر 12 مانگ دوای ئەو دەمێنێت، و هەرگیز لەوەی فرۆشراوە کورتتر نابێت.',
  svcSave: 'پاشەکەوتکردنی بەخشینی خاوەن',
  svcOpen: 'بەخشینی گەرەنتی (خاوەن)',
  months: 'مانگ',
  noReceipt: 'بەبێ گەرەنتی — کڕیار گەرەنتی نەکڕیوە، بۆیە پسووڵەی گەرەنتی بۆ ئەم چاپکەرە دەرناچێت.',
  noReceiptOwner: 'ئەگەر خاوەن بیەوێت گەرەنتی پێ ببەخشێت، سەرەتا لە «بەخشینی گەرەنتی (خاوەن)»ەوە.',
  wrongReceipt: 'ئەم پسووڵەیە بۆ چاپکەرێک دەرچووە کە کڕیار بەبێ گەرەنتی کڕیویەتی؛ لە لاپەڕەی پشتڕاستکردنەوەدا وەک کارا دەرناکەوێت. لە «پسووڵەکانی گەرەنتی»ەوە لەگەڵ هۆکار هەڵیبوەشێنەوە.',
  receiptMonthsFixed: 'ماوەی پسووڵەکە ئەوەیە کە کڕیار کڕیویەتی',
  replaceCareOnly: 'ئەم ئامێرە لە دەرەوەی گەرەنتییە و تەنها لیڤۆ کێری لەسەرە. لیڤۆ کێر داشکاندنە لەسەر پارچەکان، نەک گۆڕینی بەخۆڕایی.',
  replaceCareOnlyConfirm: 'بڕیاری خاوەن: لەگەڵ ئەوەشدا بیگۆڕە (هۆکارەکە بنووسە)',
  loadFailed: 'بارنەکرا — دووبارە هەوڵ بدەوە.',
  orderStatus: { pending: 'چاوەڕێی پشتڕاستکردنەوە', confirmed: 'پشتڕاستکراوە', processing: 'لە ئامادەکردندایە', shipped: 'نێردراوە', delivered: 'گەیەنراوە', cancelled: 'هەڵوەشێنراوەتەوە', returned: 'گەڕێنراوەتەوە' },
  notSerialized: 'ئەم داواکارییە بەرهەمی شوێنکەوتوو بە ژمارە زنجیرەیی (چاپکەر) تێدا نییە.',
  cover: 'داپۆشین',
};

export const DESK: Record<DeskLang, Strings> = { ar: AR, en: EN, ckb: CKB };
export type DeskStrings = Strings;

/** «اشترى الزبون»: the package, the warranty and Levo Care as sold — or the device's own months for a printer sold before the services. */
export function boughtText(t: Strings, services: DeskServices | null, cover: DeskCover | null): string {
  if (!services) {
    const m = cover?.months;
    return m && m > 0 ? `${t.warrantyMonths(m)} · ${t.beforeServices}` : m === 0 ? t.noWarranty : t.beforeServices;
  }
  const pkg = services.package ? t.packages[services.package] ?? '' : '';
  return [
    pkg,
    services.warranty_months === 0 ? t.noWarranty : t.warrantyMonths(services.warranty_months),
    services.care ? t.withCare(services.care_total_months) : t.noCare,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** «الساري اليوم»: one sentence — what holds and until when. */
export function todayText(t: Strings, cover: DeskCover, care: DeskCare | null, date: (iso: string | null) => string): string {
  switch (cover.now) {
    case 'warranty':
      return `${t.nowWarranty(date(cover.until))}${cover.care_misuse ? ` — ${t.careMisuse}` : ''}`;
    case 'care':
      return t.nowCare(date(cover.until));
    case 'not_delivered':
      return t.nowNotDelivered;
    case 'closed':
      return t.nowClosed;
    case 'needs_config':
      return t.nowNeedsConfig;
    default:
      if (cover.warranty === 'ended') return t.nowNoneEnded(date(cover.warranty_end_at));
      if (care && care.state === 'expired' && care.end_at) return t.nowNoneCareEnded(date(care.end_at));
      return t.nowNoneNever;
  }
}

export type CoverTone = 'success' | 'info' | 'neutral' | 'warning' | 'danger';
/** The one chip of a device: its word and its tone. No warranty bought is NEUTRAL — nothing expired. */
export function coverChip(t: Strings, cover: DeskCover): { label: string; tone: CoverTone } {
  switch (cover.now) {
    case 'warranty':
      return { label: t.chipWarranty, tone: 'success' };
    case 'care':
      return { label: t.chipCare, tone: 'info' };
    case 'not_delivered':
      return { label: t.chipNotDelivered, tone: 'neutral' };
    case 'closed':
      return { label: t.chipClosed, tone: 'warning' };
    case 'needs_config':
      return { label: t.chipNeedsConfig, tone: 'warning' };
    default:
      return cover.warranty === 'ended' ? { label: t.chipEnded, tone: 'danger' } : { label: t.chipNoWarranty, tone: 'neutral' };
  }
}

export const TONE_CLASS: Record<CoverTone, string> = {
  success: 'lv-chip [--chip:var(--color-success)]',
  info: 'lv-chip [--chip:var(--color-info)]',
  warning: 'lv-chip [--chip:var(--color-warning)]',
  danger: 'lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]',
  neutral: 'bg-white/[0.06] text-text-secondary',
};

export function verdictTone(v: CoverVerdict): CoverTone {
  return v === 'warranty' || v === 'warranty_care' ? 'success' : v === 'care' ? 'info' : v === 'none' ? 'neutral' : 'warning';
}

/** The next correct action on a claim: the Care quote's own step when one is live, else the verdict's. */
export function nextActionText(t: Strings, cover: ClaimCover, careQuoteState: string | null | undefined, open: boolean, stage = 'received'): string | null {
  if (!open) return null;
  if (careQuoteState === 'quoted') return t.nextCareQuoted;
  if (careQuoteState === 'accepted') return t.nextCareAccepted;
  if (careQuoteState === 'approved') return t.nextCareApproved;
  if (stage === 'approved' || stage === 'repairing') return t.nextAccepted;
  return t.next[cover.verdict];
}
