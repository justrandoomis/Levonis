/**
 * «خدمات الطابعة» ON AN ORDER (DECISIONS row 364) — the words for what was bought with a printer, as the
 * admin order window and the customer's order page say them. Arabic first; English; real Sorani.
 *
 * One table for both readers so the shop and the customer never name a package two ways; the few lines
 * that differ by reader (who packs vs who receives) are their own keys.
 */
export type Loc = (ar: string, en: string, ckb?: string) => string;

const n = (v: number) => v.toLocaleString('en-US');

export function orderServicesStrings(loc: Loc) {
  const months = (m: number) => loc(`${m} شهراً`, `${m} months`, `${m} مانگ`);
  return {
    title: loc('خدمات الطابعة', 'Printer services', 'خزمەتگوزارییەکانی پرینتەر'),
    perPrinter: (qty: number) => loc(`لكل طابعة من الـ${qty}`, `for each of the ${qty} printers`, `بۆ هەر یەک لە ${qty} پرینتەرەکە`),
    package: (id: string | undefined): string => {
      switch (id) {
        case 'just': return loc('الطابعة فقط', 'Just Printer', 'تەنها پرینتەر');
        case 'smart': return loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک');
        case 'complete': return loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو');
        case 'custom': return loc('مخصّص', 'Custom', 'دڵخواز');
        case 'mixed': return loc('باقات مختلفة', 'Different packages', 'پاکێجی جیاواز');
        default: return loc('خدمات طابعة', 'Printer services', 'خزمەتگوزاریی پرینتەر');
      }
    },
    packageLabel: loc('الباقة', 'Package', 'پاکێج'),
    // ---- the packer's part
    boxHeading: loc('لهذا الصندوق', 'For this box', 'بۆ ئەم سندووقە'),
    packaging: loc('التغليف', 'Packaging', 'پێچانەوە'),
    packagingExtra: loc('تغليف حماية إضافي فوق تغليف المصنع', 'Extra protective packaging over the factory box', 'پێچانەوەی پاراستنی زیادە لەسەر کارتۆنی کارگە'),
    packagingStandard: loc('تغليف المصنع فقط — بلا إضافي', 'Factory packaging only — nothing extra', 'تەنها پێچانەوەی کارگە — بێ زیادە'),
    inspection: loc('الفحص', 'Inspection', 'پشکنین'),
    inspectionFull: loc('فحص كامل قبل الإرسال', 'Full inspection before dispatch', 'پشکنینی تەواو پێش ناردن'),
    inspectionNone: loc('لم يُشترَ فحص — تُرسل كما هي', 'No inspection bought — ships as it is', 'پشکنین نەکڕدراوە — وەک خۆی دەنێردرێت'),
    inspectionLead: (lo: number, hi: number) => loc(`يضيف ${lo}–${hi} أيام عمل`, `adds ${lo}–${hi} business days`, `${lo}–${hi} ڕۆژی کار زیاد دەکات`),
    academy: loc('التعليم', 'Training', 'فێرکاری'),
    academyWhatsapp: loc('دورة مباشرة عبر واتساب — تُجدول مع الزبون', 'Live session over WhatsApp — to schedule with the customer', 'خولی ڕاستەوخۆ لە واتسئاپ — لەگەڵ کڕیار کاتی بۆ دادەنرێت'),
    academyInPerson: loc('دورة حضورية — تُجدول مع الزبون', 'In-person session — to schedule with the customer', 'خولی ڕووبەڕوو — لەگەڵ کڕیار کاتی بۆ دادەنرێت'),
    academyRecorded: loc('فيديوهات مسجلة فقط — لا شيء يُجدول', 'Recorded videos only — nothing to schedule', 'تەنها ڤیدیۆی تۆمارکراو — هیچ شتێک کاتی بۆ دانانرێت'),
    academyWhatsappMine: loc('دورة مباشرة عبر واتساب — نتواصل معك لتحديد الموعد', 'Live session over WhatsApp — we contact you to agree a time', 'خولی ڕاستەوخۆ لە واتسئاپ — پەیوەندیت پێوە دەکەین بۆ دیاریکردنی کات'),
    academyInPersonMine: loc('دورة حضورية — نتواصل معك لتحديد الموعد', 'In-person session — we contact you to agree a time', 'خولی ڕووبەڕوو — پەیوەندیت پێوە دەکەین بۆ دیاریکردنی کات'),
    academyRecordedMine: loc('فيديوهات تعليمية مسجلة', 'Recorded training videos', 'ڤیدیۆی فێرکاریی تۆمارکراو'),
    delivery: loc('التسليم', 'Hand-over', 'ڕادەستکردن'),
    deliveryEconomy: loc('توصيل إلى المنزل', 'Home delivery', 'گەیاندن بۆ ماڵەوە'),
    deliveryPersonal: loc('توصيل شخصي إلى المنزل', 'Personal home delivery', 'گەیاندنی تایبەت بۆ ماڵەوە'),
    deliveryPickup: loc('استلام من المخزن — لا تُسلَّم للمندوب', 'Collected from the store — do not hand to the courier', 'لە کۆگا وەردەگیرێت — مەیدە بە گەیەنەر'),
    deliveryPickupMine: loc('تستلمها من المخزن', 'You collect it from the store', 'خۆت لە کۆگا وەریدەگریت'),
    deliveryFee: (iqd: string) => loc(`${iqd} للطابعة`, `${iqd} per printer`, `${iqd} بۆ هەر پرینتەرێک`),
    // ---- what the customer holds
    coverHeading: loc('ما اشتراه الزبون من تغطية', 'Cover the customer bought', 'ئەو پاراستنەی کڕیار کڕیویەتی'),
    coverHeadingMine: loc('تغطيتك', 'Your cover', 'پاراستنەکەت'),
    warranty: loc('الضمان', 'Warranty', 'گەرەنتی'),
    warrantyMonths: months,
    until: (date: string) => loc(`حتى ${date}`, `until ${date}`, `تا ${date}`),
    fromDelivery: loc('تبدأ من يوم التسليم', 'counted from the delivery day', 'لە ڕۆژی ڕادەستکردنەوە دەژمێردرێت'),
    noWarranty: loc('بلا ضمان — لم يشترِ الزبون ضماناً', 'No warranty — the customer bought none', 'بێ گەرەنتی — کڕیار گەرەنتی نەکڕیوە'),
    noWarrantyMine: loc('بلا ضمان — لم تشترِ ضماناً مع هذه الطابعة', 'No warranty — you bought none with this printer', 'بێ گەرەنتی — لەگەڵ ئەم پرینتەرە گەرەنتیت نەکڕیوە'),
    ackRecorded: loc('موافقته على الشراء بلا ضمان مسجّلة', 'His agreement to buy without a warranty is recorded', 'ڕەزامەندیی لەسەر کڕین بەبێ گەرەنتی تۆمار کراوە'),
    ackRecordedMine: loc('وافقتَ على ذلك عند الشراء', 'You agreed to this when you bought it', 'لە کاتی کڕیندا ڕەزامەندیت لەسەر ئەمە دا'),
    care: loc('ليفو كير', 'Levo Care', 'لیڤۆ کێر'),
    /** The WHOLE Care cover from delivery: the warranty's months, then 12 more. */
    careMonths: (m: number) => months(m),
    careAfterWarranty: loc('من يوم التسليم: مدة الضمان ثم 12 شهراً بعدها', 'from the delivery day: the warranty period, then 12 months after it', 'لە ڕۆژی ڕادەستکردنەوە: ماوەی گەرەنتی، پاشان 12 مانگ دوای ئەوە'),
    careNone: loc('لم يُشترَ', 'Not bought', 'نەکڕدراوە'),
    // ---- the money
    feesHeading: loc('رسوم الخدمات — للطابعة الواحدة', 'Service fees — per printer', 'کرێی خزمەتگوزارییەکان — بۆ هەر پرینتەرێک'),
    service: (service: string, choice: string): string => {
      if (service === 'warranty') return loc(`ضمان ${choice === 'w24' ? 24 : 12} شهراً`, `${choice === 'w24' ? 24 : 12}-month warranty`, `گەرەنتی ${choice === 'w24' ? 24 : 12} مانگ`);
      if (service === 'care') return loc('ليفو كير', 'Levo Care', 'لیڤۆ کێر');
      if (service === 'packaging') return choice === 'extra' ? loc('تغليف حماية إضافي', 'Extra packaging', 'پێچانەوەی زیادە') : loc('تغليف المصنع', 'Factory packaging', 'پێچانەوەی کارگە');
      if (service === 'inspection') return loc('فحص قبل الإرسال', 'Pre-dispatch inspection', 'پشکنین پێش ناردن');
      if (service === 'academy') return choice === 'recorded' ? loc('فيديوهات مسجلة', 'Recorded videos', 'ڤیدیۆی تۆمارکراو') : loc('دورة تعليمية مباشرة', 'Live training session', 'خولی فێرکاریی ڕاستەوخۆ');
      return loc('خدمة', 'Service', 'خزمەتگوزاری');
    },
    included: loc('مشمول', 'included', 'لەخۆگیراوە'),
    proSaving: (iqd: string) => loc(`وفّر PRO ${iqd}`, `PRO saved ${iqd}`, `PRO ${iqd} پاشەکەوتی کرد`),
    feesTotal: loc('مجموع الخدمات', 'Services total', 'کۆی خزمەتگوزارییەکان'),
    anchorIncluded: (iqd: string) => loc(
      `سعر الطابعة يشمل باقة «الاختيار الذكي» (${iqd})`,
      `The printer's price already includes the Smart Choice package (${iqd})`,
      `نرخی پرینتەرەکە پاکێجی «هەڵبژاردنی زیرەک»ی تێدایە (${iqd})`
    ),
    chargedMore: loc('أُضيف إلى سعر الطابعة', 'Added to the printer price', 'بۆ نرخی پرینتەرەکە زیادکرا'),
    chargedLess: loc('خُصم من سعر الطابعة', 'Taken off the printer price', 'لە نرخی پرینتەرەکە کەمکرایەوە'),
    chargedSame: loc('لا فرق في السعر', 'No change to the price', 'هیچ گۆڕانێک لە نرخدا نییە'),
    // ---- task status (admin)
    todo: loc('لم يُنجز', 'To do', 'نەکراوە'),
    done: loc('أُنجز', 'Done', 'کراوە'),
    doneBy: (name: string, when: string) => loc(`${name} · ${when}`, `${name} · ${when}`, `${name} · ${when}`),
    // ---- attached lines
    packedWith: loc('يُغلَّف مع هذه الطابعة', 'Packed with this printer', 'لەگەڵ ئەم پرینتەرە دەپێچرێتەوە'),
    kit: loc('باقة الفيلامنت', 'Filament kit', 'پاکێجی فیلامێنت'),
    addons: loc('إضافات', 'Add-ons', 'زیادکراوەکان'),
    colourChosen: loc('لون اختاره الزبون', 'Colour chosen by the customer', 'ڕەنگێک کە کڕیار هەڵیبژاردووە'),
    colourRandom: loc('لون عشوائي — اختاره النظام', 'Random colour — picked by the system', 'ڕەنگی هەڕەمەکی — سیستەمەکە هەڵیبژاردووە'),
    beforeDiscountUnit: (iqd: string) => loc(`قبل الخصم ${iqd} للقطعة`, `${iqd} each before the discount`, `پێش داشکاندن ${iqd} بۆ هەر دانەیەک`),
    gift: loc('هدية — 0 د.ع', 'Gift — 0 IQD', 'دیاری — 0 د.ع'),
    drawPrize: loc('جائزة سحب ليفو كير — 0 د.ع', 'Levo Care draw prize — 0 IQD', 'خەڵاتی تیروپشکی لیڤۆ کێر — 0 د.ع'),
    giftShips: loc('تُغلَّف وتُرسل مع الطلب', 'Packed and shipped with the order', 'لەگەڵ داواکارییەکە دەپێچرێتەوە و دەنێردرێت'),
    membershipLine: loc('عضوية — ليست في الطرد', 'Membership — not in the parcel', 'ئەندامێتی — لەناو پاکەتەکەدا نییە'),
    careOfferLine: (iqd: string) => loc(`خصم ليفو كير على قطعة: − ${iqd}`, `Levo Care part discount: − ${iqd}`, `داشکاندنی لیڤۆ کێر لەسەر پارچە: − ${iqd}`),
    num: n,
  };
}

export type OrderServicesStrings = ReturnType<typeof orderServicesStrings>;
