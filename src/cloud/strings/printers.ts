/**
 * The words of the printers pages (src/cloud/pages/Printers.tsx,
 * PrinterDetail.tsx): the workshop's real machines, their specifications and
 * what is free now — from the server, never a demo list.
 */
import type { Tri } from '../types';

export const printers = {
  title: { ar: 'الطابعات', en: 'Printers', ckb: 'چاپکەرەکان' },
  subtitle: {
    ar: 'آلات الورشة الحقيقية، وما هو متاح منها الآن.',
    en: "The workshop's real machines, and what is free right now.",
    ckb: 'ئامێرە ڕاستەقینەکانی کارگە، و ئەوەی ئێستا بەتاڵە.',
  },
  emptyTitle: { ar: 'لا توجد طابعات معروضة بعد', en: 'No printers are listed yet', ckb: 'هێشتا هیچ چاپکەرێک دانەنراوە' },
  emptyBody: {
    ar: 'ستظهر هنا آلات الورشة عند إضافتها.',
    en: 'The workshop machines will appear here once they are added.',
    ckb: 'ئامێرەکانی کارگە کاتێک زیاد دەکرێن لێرە دەردەکەون.',
  },
  hoursClass: { ar: 'فئة الساعات', en: 'Hours class', ckb: 'پۆلی کاتژمێر' },
  freeOfActive: { ar: '{idle} من {active} متاحة الآن', en: '{idle} of {active} free now', ckb: '{idle} لە {active} ئێستا بەتاڵن' },
  details: { ar: 'التفاصيل', en: 'Details', ckb: 'وردەکاری' },
  specs: { ar: 'المواصفات', en: 'Specifications', ckb: 'تایبەتمەندییەکان' },
  buildVolume: { ar: 'حجم الطباعة', en: 'Build volume', ckb: 'قەبارەی چاپ' },
  colours: { ar: 'الألوان', en: 'Colours', ckb: 'ڕەنگەکان' },
  // «عدد الألوان حتى …» agrees with any number, where «حتى {n} ألوان» is wrong from 11.
  upToColours: { ar: 'عدد الألوان حتى {n}', en: 'Up to {n} colours', ckb: 'تا {n} ڕەنگ' },
  oneColour: { ar: 'لون واحد', en: 'One colour', ckb: 'یەک ڕەنگ' },
  colourSystem: { ar: 'نظام الألوان', en: 'Colour system', ckb: 'سیستەمی ڕەنگ' },
  materials: { ar: 'المواد', en: 'Materials', ckb: 'کەرەستەکان' },
  nozzles: { ar: 'الفوهات', en: 'Nozzles', ckb: 'نۆزڵەکان' },
  extruder: { ar: 'رأس الطباعة', en: 'Extruder', ckb: 'سەری چاپ' },
  extruder_single: { ar: 'رأس واحد', en: 'Single', ckb: 'تاک' },
  extruder_dual: { ar: 'رأسان', en: 'Dual', ckb: 'دووانە' },
  extruder_idex: { ar: 'رأسان مستقلان', en: 'Independent dual', ckb: 'دووانەی سەربەخۆ' },
  extruder_toolchanger: { ar: 'مبدّل أدوات', en: 'Tool changer', ckb: 'گۆڕەری ئامراز' },
  enclosure: { ar: 'الحجرة', en: 'Enclosure', ckb: 'ژوورەی چاپ' },
  enclosed: { ar: 'مغلقة', en: 'Enclosed', ckb: 'داخراو' },
  openFrame: { ar: 'مفتوحة', en: 'Open frame', ckb: 'کراوە' },
  camera: { ar: 'كاميرا', en: 'Camera', ckb: 'کامێرا' },
  maxNozzleTemp: { ar: 'أقصى حرارة للفوهة', en: 'Max nozzle temperature', ckb: 'زۆرترین گەرمیی نۆزڵ' },
  maxBedTemp: { ar: 'أقصى حرارة للسرير', en: 'Max bed temperature', ckb: 'زۆرترین گەرمیی سەکۆ' },
  availability: { ar: 'التوفر الآن', en: 'Availability now', ckb: 'بەردەستبوون ئێستا' },
  machinesActive: { ar: 'آلات في الخدمة', en: 'Machines in service', ckb: 'ئامێری لە کاردا' },
  machinesIdle: { ar: 'متاحة الآن', en: 'Free now', ckb: 'ئێستا بەتاڵ' },
  machinesOffline: { ar: 'غير متصلة', en: 'Offline', ckb: 'پەیوەندی پچڕاوە' },
  machinesMaintenance: { ar: 'في الصيانة', en: 'In maintenance', ckb: 'لە چاککردنەوەدا' },
  jobsWaiting: { ar: 'طباعات تنتظر', en: 'Prints waiting', ckb: 'چاپی چاوەڕوان' },
  availabilityNote: {
    ar: '«متاحة» كما يعدّها المجدول: آلة متصلة وخاملة لا تطبع شيئًا آخر.',
    en: '“Free” is counted as the scheduler counts it: a connected, idle machine printing nothing else.',
    ckb: '«بەتاڵ» وەک خشتەدانەر دەیژمێرێت: ئامێرێکی پەیوەست و بێکار کە هیچی تر چاپ ناکات.',
  },
  packages: { ar: 'باقات الساعات لهذه الفئة', en: 'Hour packages for this class', ckb: 'پاکێجەکانی کاتژمێر بۆ ئەم پۆلە' },
  noPackages: { ar: 'لا توجد باقات لهذه الفئة الآن', en: 'No packages for this class right now', ckb: 'ئێستا هیچ پاکێجێک بۆ ئەم پۆلە نییە' },
  expiresAfter: { ar: 'تنتهي بعد {days} من الشراء', en: 'Expires {days} after purchase', ckb: '{days} دوای کڕین بەسەردەچێت' },
  neverExpires: { ar: 'لا تنتهي صلاحيتها', en: 'Never expires', ckb: 'بەسەرناچێت' },
  bundleIncluded: { ar: 'تشمل موادّ مع الساعات', en: 'Includes material with the hours', ckb: 'کەرەستەشی لەگەڵ کاتژمێرەکان تێدایە' },
  buyHoursForClass: { ar: 'شراء ساعات لهذه الفئة', en: 'Buy hours for this class', ckb: 'کڕینی کاتژمێر بۆ ئەم پۆلە' },
  hoursOnlyThisClass: {
    ar: 'ساعات هذه الفئة تشغّل طابعاتها فقط.',
    en: 'Hours of this class run only its printers.',
    ckb: 'کاتژمێرەکانی ئەم پۆلە تەنها چاپکەرەکانی خۆی کار پێدەکەن.',
  },
  notFoundTitle: { ar: 'هذه الطابعة غير موجودة', en: 'This printer does not exist', ckb: 'ئەم چاپکەرە بوونی نییە' },
} satisfies Record<string, Tri>;
