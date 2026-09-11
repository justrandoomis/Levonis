/**
 * Terminology catalog for the LOCAL deterministic translator (mandate §3:
 * "استخدم نظام ترجمة محلي deterministic قائمًا على مكتبة المشروع، وtranslation
 * catalog/terminology dictionary وقواعد ثابتة"). No AI, no network, no
 * generative API — a fixed lookup table plus the rules in ./index.ts.
 *
 * HONESTY RULE, enforced by the shape of this file: `ar` and `ckb` are each
 * OPTIONAL. An entry with no `ckb` is not a gap to paper over — it means no
 * confident Sorani rendering is recorded, so any segment needing it is kept in
 * English and flagged `review_needed` for that language only. Never add a
 * guess here to make a test pass; the whole point of §3 is that the system
 * refuses to invent.
 *
 * Keys are matched case-insensitively on collapsed whitespace. Multi-word
 * entries are matched as whole phrases — the engine never composes a
 * translation out of separate words, because word-by-word assembly produces
 * grammatically wrong Arabic and Kurdish.
 */

export interface TermEntry {
  ar?: string;
  ckb?: string;
}

/** Terms whose correct rendering in every language is the English token
 *  itself: material codes, interfaces, file formats, standards. Translating
 *  these would be an error, so identity counts as a real translation. */
export const IDENTITY_TERMS: readonly string[] = [
  'pla', 'petg', 'abs', 'asa', 'tpu', 'pc', 'pa', 'pet', 'pps', 'pva', 'hips',
  'pla+', 'pla-cf', 'pa-cf', 'pet-cf', 'petg-cf', 'abs-gf', 'asa-cf',
  'fdm', 'fff', 'sla', 'msla', 'dlp', 'lcd', 'led', 'uv',
  'ams', 'usb', 'usb-c', 'wi-fi', 'wifi', 'bluetooth', 'ethernet', 'rj45',
  'sd', 'microsd', 'tf', 'hdmi', 'rgb', 'nfc', 'ble',
  'stl', 'obj', '3mf', 'gcode', 'g-code', 'step', 'stp', 'svg', 'dxf', 'ply',
  'ce', 'fcc', 'rohs', 'iso', 'ul', 'ip65',
  'ac', 'dc', 'rc', 'pid', 'cnc', 'diy', 'qr', 'ai',
];

/**
 * Units. `ar`/`ckb` hold the localized abbreviation. Kurdish shares the Arabic
 * script and, in Iraqi Kurdish technical writing, the same abbreviations are
 * used, so both are recorded where that is genuinely true.
 */
export const UNITS: Record<string, TermEntry> = {
  mm: { ar: 'مم', ckb: 'مم' },
  cm: { ar: 'سم', ckb: 'سم' },
  m: { ar: 'م', ckb: 'م' },
  km: { ar: 'كم', ckb: 'کم' },
  in: { ar: 'إنش', ckb: 'ئینچ' },
  inch: { ar: 'إنش', ckb: 'ئینچ' },
  inches: { ar: 'إنش', ckb: 'ئینچ' },
  µm: { ar: 'ميكرومتر', ckb: 'مایکرۆمەتر' },
  um: { ar: 'ميكرومتر', ckb: 'مایکرۆمەتر' },
  micron: { ar: 'ميكرون', ckb: 'مایکرۆن' },
  microns: { ar: 'ميكرون', ckb: 'مایکرۆن' },
  g: { ar: 'غم', ckb: 'گم' },
  kg: { ar: 'كغم', ckb: 'کگم' },
  mg: { ar: 'ملغم', ckb: 'ملگم' },
  l: { ar: 'لتر', ckb: 'لیتر' },
  ml: { ar: 'مل', ckb: 'مل' },
  w: { ar: 'واط', ckb: 'وات' },
  kw: { ar: 'كيلوواط', ckb: 'کیلۆوات' },
  v: { ar: 'فولت', ckb: 'ڤۆڵت' },
  a: { ar: 'أمبير', ckb: 'ئەمپێر' },
  hz: { ar: 'هرتز', ckb: 'هێرتز' },
  khz: { ar: 'كيلوهرتز', ckb: 'کیلۆهێرتز' },
  db: { ar: 'ديسيبل', ckb: 'دێسیبڵ' },
  '°c': { ar: '°م', ckb: '°س' },
  c: { ar: '°م', ckb: '°س' },
  'mm/s': { ar: 'مم/ث', ckb: 'مم/چ' },
  'mm/s²': { ar: 'مم/ث²', ckb: 'مم/چ²' },
  'mm³/s': { ar: 'مم³/ث', ckb: 'مم³/چ' },
  gb: { ar: 'غيغابايت', ckb: 'گیگابایت' },
  mb: { ar: 'ميغابايت', ckb: 'مێگابایت' },
  mah: { ar: 'ملي أمبير/ساعة', ckb: 'ملی ئەمپێر/کاتژمێر' },
  pcs: { ar: 'قطعة', ckb: 'دانە' },
  pc: { ar: 'قطعة', ckb: 'دانە' },
  pack: { ar: 'عبوة', ckb: 'پاکێت' },
  roll: { ar: 'بكرة', ckb: 'بۆبین' },
  rolls: { ar: 'بكرات', ckb: 'بۆبین' },
  spool: { ar: 'بكرة', ckb: 'بۆبین' },
  spools: { ar: 'بكرات', ckb: 'بۆبین' },
  set: { ar: 'طقم', ckb: 'سێت' },
  sets: { ar: 'أطقم', ckb: 'سێت' },
  hour: { ar: 'ساعة', ckb: 'کاتژمێر' },
  hours: { ar: 'ساعة', ckb: 'کاتژمێر' },
  month: { ar: 'شهر', ckb: 'مانگ' },
  months: { ar: 'شهر', ckb: 'مانگ' },
  year: { ar: 'سنة', ckb: 'ساڵ' },
  years: { ar: 'سنة', ckb: 'ساڵ' },
  day: { ar: 'يوم', ckb: 'ڕۆژ' },
  days: { ar: 'يوم', ckb: 'ڕۆژ' },
};

/**
 * Phrases. Entries are whole labels and whole short values as they actually
 * appear in a spec sheet — never fragments to be glued together.
 */
export const PHRASES: Record<string, TermEntry> = {
  // ---------------------------------------------------------- device specs
  'brand': { ar: 'العلامة التجارية', ckb: 'مارکە' },
  'model': { ar: 'الموديل', ckb: 'مۆدێل' },
  'technology': { ar: 'التقنية', ckb: 'تەکنەلۆژیا' },
  'printing technology': { ar: 'تقنية الطباعة', ckb: 'تەکنەلۆژیای چاپ' },
  'printer': { ar: 'طابعة', ckb: 'پرینتەر' },
  '3d printer': { ar: 'طابعة ثلاثية الأبعاد', ckb: 'پرینتەری سێ ڕەهەندی' },
  'resin printer': { ar: 'طابعة ريزن', ckb: 'پرینتەری ڕەزین' },
  'build volume': { ar: 'حجم الطباعة', ckb: 'قەبارەی چاپ' },
  'build size': { ar: 'حجم الطباعة', ckb: 'قەبارەی چاپ' },
  'build plate': { ar: 'منصة الطباعة', ckb: 'پلێتی چاپ' },
  'print speed': { ar: 'سرعة الطباعة', ckb: 'خێرایی چاپ' },
  'max speed': { ar: 'أقصى سرعة', ckb: 'بەرزترین خێرایی' },
  'maximum speed': { ar: 'أقصى سرعة', ckb: 'بەرزترین خێرایی' },
  'acceleration': { ar: 'التسارع' },
  'layer height': { ar: 'ارتفاع الطبقة', ckb: 'بەرزی چین' },
  'layer resolution': { ar: 'دقة الطبقة' },
  'resolution': { ar: 'الدقة', ckb: 'ڕوونی' },
  'accuracy': { ar: 'الدقة' },
  'nozzle': { ar: 'الفوهة', ckb: 'نۆزڵ' },
  'nozzle diameter': { ar: 'قطر الفوهة', ckb: 'تیرەی نۆزڵ' },
  'nozzle temperature': { ar: 'حرارة الفوهة', ckb: 'پلەی گەرمی نۆزڵ' },
  'bed temperature': { ar: 'حرارة السرير', ckb: 'پلەی گەرمی بێد' },
  'heated bed': { ar: 'سرير ساخن', ckb: 'بێدی گەرم' },
  'hotend': { ar: 'الرأس الساخن' },
  'extruder': { ar: 'الباثق' },
  'filament diameter': { ar: 'قطر الفلامنت', ckb: 'تیرەی فیلامێنت' },
  'filament': { ar: 'فلامنت', ckb: 'فیلامێنت' },
  'resin': { ar: 'ريزن', ckb: 'ڕەزین' },
  'supported materials': { ar: 'المواد المدعومة', ckb: 'کەرەستە پشتگیریکراوەکان' },
  'compatible materials': { ar: 'المواد المتوافقة', ckb: 'کەرەستە گونجاوەکان' },
  'compatibility': { ar: 'التوافق', ckb: 'گونجان' },
  'compatible with': { ar: 'متوافق مع', ckb: 'گونجاوە لەگەڵ' },
  'connectivity': { ar: 'الاتصال', ckb: 'پەیوەندی' },
  'power': { ar: 'الطاقة', ckb: 'وزە' },
  'power supply': { ar: 'مزود الطاقة', ckb: 'دابینکەری وزە' },
  'input voltage': { ar: 'جهد الدخل', ckb: 'ڤۆڵتاژی چوونەژوورەوە' },
  'rated power': { ar: 'القدرة المقننة' },
  'dimensions': { ar: 'الأبعاد', ckb: 'ڕەهەندەکان' },
  'product dimensions': { ar: 'أبعاد المنتج', ckb: 'ڕەهەندی بەرهەم' },
  'package dimensions': { ar: 'أبعاد العبوة', ckb: 'ڕەهەندی پاکێت' },
  'weight': { ar: 'الوزن', ckb: 'کێش' },
  'net weight': { ar: 'الوزن الصافي', ckb: 'کێشی ڕەها' },
  'gross weight': { ar: 'الوزن الإجمالي', ckb: 'کێشی گشتی' },
  'screen': { ar: 'الشاشة', ckb: 'شاشە' },
  'display': { ar: 'الشاشة', ckb: 'شاشە' },
  'touchscreen': { ar: 'شاشة لمس', ckb: 'شاشەی دەستلێدان' },
  'camera': { ar: 'كاميرا', ckb: 'کامێرا' },
  'noise level': { ar: 'مستوى الضوضاء' },
  'operating system': { ar: 'نظام التشغيل', ckb: 'سیستەمی کارپێکردن' },
  'software': { ar: 'البرنامج', ckb: 'نەرمەکاڵا' },
  'slicer': { ar: 'برنامج التقطيع' },
  'firmware': { ar: 'البرنامج الثابت' },
  'auto leveling': { ar: 'التسوية التلقائية' },
  'automatic leveling': { ar: 'التسوية التلقائية' },
  'filament runout sensor': { ar: 'حساس نفاد الفلامنت' },
  'enclosure': { ar: 'الهيكل المغلق' },
  'air filter': { ar: 'فلتر الهواء' },
  'multi-color': { ar: 'متعدد الألوان', ckb: 'فرەڕەنگ' },
  'multi color': { ar: 'متعدد الألوان', ckb: 'فرەڕەنگ' },
  'single color': { ar: 'لون واحد', ckb: 'یەک ڕەنگ' },

  // -------------------------------------------------------- material specs
  'material': { ar: 'المادة', ckb: 'کەرەستە' },
  'material type': { ar: 'نوع المادة', ckb: 'جۆری کەرەستە' },
  'diameter': { ar: 'القطر', ckb: 'تیرە' },
  'tolerance': { ar: 'التفاوت' },
  'color': { ar: 'اللون', ckb: 'ڕەنگ' },
  'colour': { ar: 'اللون', ckb: 'ڕەنگ' },
  'colors': { ar: 'الألوان', ckb: 'ڕەنگەکان' },
  'finish': { ar: 'التشطيب' },
  'density': { ar: 'الكثافة' },
  'hardness': { ar: 'الصلابة' },
  'drying': { ar: 'التجفيف' },
  'storage': { ar: 'التخزين', ckb: 'هەڵگرتن' },
  'shelf life': { ar: 'مدة الصلاحية', ckb: 'ماوەی بەکارهێنان' },
  'printing temperature': { ar: 'حرارة الطباعة', ckb: 'پلەی گەرمی چاپ' },
  'recommended settings': { ar: 'الإعدادات المقترحة' },
  'processing mode': { ar: 'نمط المعالجة' },
  'laser material': { ar: 'مادة ليزر' },
  'blade cutting material': { ar: 'مادة قص بشفرة' },
  'quantity': { ar: 'الكمية', ckb: 'بڕ' },
  'quantity per pack': { ar: 'الكمية في العبوة', ckb: 'بڕ لە پاکێتدا' },
  'contents': { ar: 'المحتويات', ckb: 'ناوەڕۆک' },
  'in the box': { ar: 'محتويات العلبة', ckb: 'ناوەڕۆکی سندوق' },
  "what's in the box": { ar: 'محتويات العلبة', ckb: 'ناوەڕۆکی سندوق' },
  'package contents': { ar: 'محتويات العبوة', ckb: 'ناوەڕۆکی پاکێت' },
  'thickness': { ar: 'السماكة', ckb: 'ئەستووری' },
  'length': { ar: 'الطول', ckb: 'درێژی' },
  'width': { ar: 'العرض', ckb: 'پانی' },
  'height': { ar: 'الارتفاع', ckb: 'بەرزی' },
  'depth': { ar: 'العمق' },
  'size': { ar: 'المقاس', ckb: 'قەبارە' },
  'capacity': { ar: 'السعة', ckb: 'توانا' },
  'volume': { ar: 'الحجم', ckb: 'قەبارە' },

  // ------------------------------------------------------------- commerce
  'warranty': { ar: 'الضمان', ckb: 'گەرەنتی' },
  'warranty period': { ar: 'مدة الضمان', ckb: 'ماوەی گەرەنتی' },
  'origin': { ar: 'بلد المنشأ', ckb: 'وڵاتی بەرهەمهێنان' },
  'made in': { ar: 'صنع في', ckb: 'دروستکراوە لە' },
  'sku': { ar: 'رمز المنتج', ckb: 'کۆدی بەرهەم' },
  'availability': { ar: 'التوفر', ckb: 'بەردەستی' },
  'in stock': { ar: 'متوفر', ckb: 'بەردەستە' },
  'out of stock': { ar: 'غير متوفر', ckb: 'نەماوە' },
  'pre-order': { ar: 'طلب مسبق', ckb: 'داواکاری پێشوەخت' },
  'preorder': { ar: 'طلب مسبق', ckb: 'داواکاری پێشوەخت' },
  'bundle': { ar: 'باقة', ckb: 'کۆمبۆ' },
  'new': { ar: 'جديد', ckb: 'نوێ' },
  'new arrival': { ar: 'وصل حديثًا', ckb: 'نوێ گەیشتوو' },
  'special offer': { ar: 'عرض خاص', ckb: 'ئۆفەری تایبەت' },
  'best seller': { ar: 'الأكثر مبيعًا', ckb: 'زۆرترین فرۆش' },
  'free shipping': { ar: 'توصيل مجاني', ckb: 'گەیاندنی بێبەرامبەر' },
  'accessories': { ar: 'الإكسسوارات', ckb: 'ئێکسسوار' },
  'spare parts': { ar: 'قطع غيار', ckb: 'پارچەی یەدەگ' },
  'tools': { ar: 'أدوات', ckb: 'ئامرازەکان' },
  'model kit': { ar: 'طقم مجسم', ckb: 'کیتی مۆدێل' },

  // ---------------------------------------------------------------- colors
  'black': { ar: 'أسود', ckb: 'ڕەش' },
  'white': { ar: 'أبيض', ckb: 'سپی' },
  'red': { ar: 'أحمر', ckb: 'سوور' },
  'blue': { ar: 'أزرق', ckb: 'شین' },
  'green': { ar: 'أخضر', ckb: 'سەوز' },
  'yellow': { ar: 'أصفر', ckb: 'زەرد' },
  'orange': { ar: 'برتقالي', ckb: 'پرتەقاڵی' },
  'purple': { ar: 'بنفسجي', ckb: 'مۆر' },
  'pink': { ar: 'وردي', ckb: 'پەمەیی' },
  'grey': { ar: 'رمادي', ckb: 'خۆڵەمێشی' },
  'gray': { ar: 'رمادي', ckb: 'خۆڵەمێشی' },
  'silver': { ar: 'فضي', ckb: 'زیوی' },
  'gold': { ar: 'ذهبي', ckb: 'زێڕین' },
  'brown': { ar: 'بني', ckb: 'قاوەیی' },
  'beige': { ar: 'بيج' },
  'transparent': { ar: 'شفاف', ckb: 'ڕوون' },
  'clear': { ar: 'شفاف', ckb: 'ڕوون' },
  'matte': { ar: 'مطفأ اللمعان' },
  'glossy': { ar: 'لامع' },
  'metallic': { ar: 'معدني' },
  'glow in the dark': { ar: 'يضيء في الظلام' },
  'wood': { ar: 'خشب', ckb: 'دار' },
  'bamboo': { ar: 'خيزران' },
  'acrylic': { ar: 'أكريليك', ckb: 'ئاکریلیک' },
  'metal': { ar: 'معدن', ckb: 'کانزا' },
  'paper': { ar: 'ورق', ckb: 'کاغەز' },
  'sticker': { ar: 'ملصق', ckb: 'ستیکەر' },
  'vinyl': { ar: 'فينيل', ckb: 'ڤاینل' },

  // --------------------------------------------------------- short values
  'yes': { ar: 'نعم', ckb: 'بەڵێ' },
  'no': { ar: 'لا', ckb: 'نەخێر' },
  'included': { ar: 'مشمول', ckb: 'لەخۆدەگرێت' },
  'not included': { ar: 'غير مشمول', ckb: 'لەخۆناگرێت' },
  'optional': { ar: 'اختياري', ckb: 'ئارەزوومەندانە' },
  'standard': { ar: 'قياسي', ckb: 'ستاندارد' },
  'supported': { ar: 'مدعوم', ckb: 'پشتگیریکراو' },
  'not supported': { ar: 'غير مدعوم', ckb: 'پشتگیری نەکراو' },
  'automatic': { ar: 'تلقائي', ckb: 'خۆکار' },
  'manual': { ar: 'يدوي', ckb: 'دەستی' },
  'small': { ar: 'صغير', ckb: 'بچووک' },
  'medium': { ar: 'متوسط', ckb: 'ناوەند' },
  'large': { ar: 'كبير', ckb: 'گەورە' },
  'left': { ar: 'يسار', ckb: 'چەپ' },
  'right': { ar: 'يمين', ckb: 'ڕاست' },
  'eu': { ar: 'الاتحاد الأوروبي', ckb: 'یەکێتی ئەوروپا' },
  'us': { ar: 'الولايات المتحدة', ckb: 'ئەمریکا' },
  'uk': { ar: 'المملكة المتحدة', ckb: 'بەریتانیا' },
};
