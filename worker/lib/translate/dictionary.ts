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
  // Firmware and hardware PRODUCT NAMES, plus the polymers and standards a
  // spec sheet quotes by name. An Iraqi buyer reads «Klipper» as Klipper; an
  // Arabic transliteration would be a word nobody searches for and nobody says.
  'klipper', 'marlin', 'reprapfirmware', 'bowden', 'bltouch',
  'hepa', 'pom', 'ptfe', 'dmd', 'corexy',
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
  // THE SPELLINGS PEOPLE ACTUALLY TYPE. A spec sheet pasted from a vendor page
  // carries `mm/s2` or `mm/s^2` far more often than the superscript, and a unit
  // this table does not recognise makes R3 decline — which used to hand the
  // segment to R6 and let it split a thousands separator. Recording the ASCII
  // forms is what stops that path from being reachable at all.
  'mm/s2': { ar: 'مم/ث²', ckb: 'مم/چ²' },
  'mm/s^2': { ar: 'مم/ث²', ckb: 'مم/چ²' },
  'mm/s²': { ar: 'مم/ث²', ckb: 'مم/چ²' },
  'mm3/s': { ar: 'مم³/ث', ckb: 'مم³/چ' },
  'mm^3/s': { ar: 'مم³/ث', ckb: 'مم³/چ' },
  'mm³/s': { ar: 'مم³/ث', ckb: 'مم³/چ' },
  'm/s2': { ar: 'م/ث²' },
  'm/s²': { ar: 'م/ث²' },
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
  // 0079. «مدة التجهيز» is written in weeks as often as in days, and without
  // these a lead time as ordinary as "3-4 weeks" came back untranslated.
  week: { ar: 'أسبوع', ckb: 'هەفتە' },
  weeks: { ar: 'أسبوع', ckb: 'هەفتە' },
  'business day': { ar: 'يوم عمل', ckb: 'ڕۆژی کار' },
  'business days': { ar: 'يوم عمل', ckb: 'ڕۆژی کار' },
  'working day': { ar: 'يوم عمل', ckb: 'ڕۆژی کار' },
  'working days': { ar: 'يوم عمل', ckb: 'ڕۆژی کار' },
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
  'noise level': { ar: 'مستوى الضوضاء', ckb: 'ئاستی دەنگ' },
  'operating system': { ar: 'نظام التشغيل', ckb: 'سیستەمی کارپێکردن' },
  'software': { ar: 'البرنامج', ckb: 'نەرمەکاڵا' },
  'slicer': { ar: 'برنامج التقطيع' },
  'firmware': { ar: 'البرنامج الثابت', ckb: 'فێرموێر' },
  'auto leveling': { ar: 'التسوية التلقائية', ckb: 'هاوسەنگکردنی خۆکار' },
  'automatic leveling': { ar: 'التسوية التلقائية' },
  'filament runout sensor': { ar: 'حساس نفاد الفلامنت' },
  'enclosure': { ar: 'الهيكل المغلق' },
  'air filter': { ar: 'فلتر الهواء' },
  'multi-color': { ar: 'متعدد الألوان', ckb: 'فرەڕەنگ' },
  'multi color': { ar: 'متعدد الألوان', ckb: 'فرەڕەنگ' },
  'single color': { ar: 'لون واحد', ckb: 'یەک ڕەنگ' },

  // --------------------------------------- template registry completeness
  // Fixed labels and select values emitted by the per-section import
  // templates. These are reviewed vocabulary, not arbitrary product prose;
  // keeping the registry complete prevents known template fields from being
  // reported as missing-dictionary sentences when a product is saved.
  'resin (msla)': { ar: 'ريزن (MSLA)', ckb: 'ڕەزین (MSLA)' },
  'other': { ar: 'أخرى', ckb: 'هی تر' },
  'camera frame rate': { ar: 'معدل إطارات الكاميرا', ckb: 'ڕێژەی چوارچێوەی کامێرا' },
  // NOT A VOCABULARY EXPANSION — six holes that were HIDDEN BY FABRICATED
  // OUTPUT, and that only became visible when the word-order repair stopped
  // fabricating (TRANSLATION_VERSION 3, tests/translateWordOrder.test.ts).
  //
  // Every one of them is a two-noun compound. Arabic joins those as an
  // «إضافة» — head + definite genitive, «دقة الكاميرا» — and the head loses
  // its own article in the process. The engine cannot derive that: it would
  // have to strip «ال» from «الدقة» and add one to «كاميرا», which is a rule
  // about Arabic morphology, and this project records pairs rather than
  // deriving them (see the ADJECTIVES note in grammar.ts). So it composed the
  // two stored forms in whatever order the rule reached them, and marked the
  // result finished:
  //
  //   "Camera resolution"  → «الدقة كاميرا»   (should be «دقة الكاميرا»)
  //   "Nozzle material"    → «المادة الفوهة»  (should be «مادة الفوهة»)
  //   "AMS compatibility"  → «التوافق AMS»    (should be «التوافق مع AMS»)
  //   "LCD size"           → «المقاس LCD»     (should be «مقاس شاشة LCD»)
  //   "LCD resolution"     → «الدقة LCD»      (should be «دقة شاشة LCD»)
  //   "UV power"           → «الطاقة UV»      (should be «قدرة UV»)
  //
  // These six are BUILT-IN TEMPLATE LABELS, so every product of that type
  // carried one. Recording the finished phrase is the only honest repair
  // available here — the alternative was six template labels flagged
  // review_needed on every save for ever. The Latin code stays inside the
  // Arabic exactly as «دقة XY» and «شاشة LCD (غير محددة)» above keep theirs.
  'camera resolution': { ar: 'دقة الكاميرا', ckb: 'ڕوونی کامێرا' },
  'nozzle material': { ar: 'مادة الفوهة', ckb: 'کەرەستەی نۆزڵ' },
  'ams compatibility': { ar: 'التوافق مع AMS', ckb: 'گونجان لەگەڵ AMS' },
  'lcd size': { ar: 'مقاس شاشة LCD', ckb: 'قەبارەی شاشەی LCD' },
  'lcd resolution': { ar: 'دقة شاشة LCD', ckb: 'ڕوونی شاشەی LCD' },
  'uv power': { ar: 'قدرة UV', ckb: 'وزەی UV' },
  'slicer software': { ar: 'برنامج التقطيع', ckb: 'نەرمەکاڵای سلایسەر' },
  'companion app': { ar: 'التطبيق المرافق', ckb: 'ئەپی هاوڕێ' },
  'assembly': { ar: 'التجميع', ckb: 'پێکەوەنان' },
  'pre-assembled': { ar: 'مجمّع مسبقًا', ckb: 'پێشتر پێکەوەنراو' },
  'partially assembled': { ar: 'مجمّع جزئيًا', ckb: 'بەشێکی پێکەوەنراو' },
  'kit': { ar: 'طقم', ckb: 'کیت' },
  'max nozzle temperature': { ar: 'أقصى حرارة للفوهة', ckb: 'بەرزترین پلەی گەرمی نۆزڵ' },
  'max bed temperature': { ar: 'أقصى حرارة لسرير الطباعة', ckb: 'بەرزترین پلەی گەرمی بێدی چاپ' },
  'extruders': { ar: 'عدد الباثقات', ckb: 'ژمارەی ئێکسترودەرەکان' },
  'enclosed': { ar: 'هيكل مغلق', ckb: 'داخراو' },
  'multi-colour support': { ar: 'دعم تعدد الألوان', ckb: 'پشتگیری فرەڕەنگ' },
  'motion system': { ar: 'نظام الحركة', ckb: 'سیستەمی جووڵە' },
  'max flow rate': { ar: 'أقصى معدل تدفق', ckb: 'بەرزترین ڕێژەی ڕەوتن' },
  'maximum acceleration': { ar: 'أقصى تسارع', ckb: 'بەرزترین خێراکردن' },
  'supported nozzle sizes': { ar: 'مقاسات الفوهة المدعومة', ckb: 'قەبارە پشتگیریکراوەکانی نۆزڵ' },
  'filament sensor': { ar: 'حساس الفلامنت', ckb: 'هەستەوەری فیلامێنت' },
  'power-loss recovery': { ar: 'الاستئناف بعد انقطاع الكهرباء', ckb: 'گەڕاندنەوە دوای بڕانی کارەبا' },
  'input shaping': { ar: 'Input shaping', ckb: 'Input shaping' },
  'supported filaments': { ar: 'الفلامنتات المدعومة', ckb: 'فیلامێنتە پشتگیریکراوەکان' },
  'xy resolution': { ar: 'دقة XY', ckb: 'وردی XY' },
  'layer height range': { ar: 'نطاق ارتفاع الطبقة', ckb: 'مەودای بەرزی چین' },
  'light source': { ar: 'مصدر الضوء', ckb: 'سەرچاوەی ڕووناکی' },
  'exposure time': { ar: 'زمن التعريض', ckb: 'ماوەی ڕووناکخستن' },
  'release film': { ar: 'غشاء الفصل', ckb: 'فیلمی جیاکردنەوە' },
  // ---------------------------------------------------------------- 0093
  // The vocabulary the EXPANDED printer template introduced. The owner asked
  // for «توسعة» so the comparison has real specs to draw on, and every label
  // and every select option it added has to be sayable in all three languages
  // — a spec the customer cannot read is not a spec they can compare.
  //
  // Where the correct rendering IS the English token (Klipper, Bowden,
  // BLTouch, HEPA, POM) the word is in IDENTITY_TERMS above rather than
  // transliterated here, which is the same call `input shaping` already makes.
  'release year': { ar: 'سنة الإصدار', ckb: 'ساڵی دەرچوون' },
  'required skill level': { ar: 'مستوى الخبرة المطلوب', ckb: 'ئاستی شارەزایی پێویست' },
  'beginner': { ar: 'مبتدئ', ckb: 'دەستپێکەر' },
  'intermediate': { ar: 'متوسط', ckb: 'ناوەندی' },
  'advanced': { ar: 'متقدم', ckb: 'پێشکەوتوو' },
  'professional': { ar: 'احترافي', ckb: 'پیشەیی' },

  'air filtration': { ar: 'تنقية الهواء', ckb: 'پاڵاوتنی هەوا' },
  'none': { ar: 'لا يوجد', ckb: 'نییە' },
  'activated carbon': { ar: 'كربون منشّط', ckb: 'کاربۆنی چالاککراو' },
  'hepa + activated carbon': { ar: 'HEPA + كربون منشّط', ckb: 'HEPA + کاربۆنی چالاککراو' },
  'external exhaust port': { ar: 'منفذ عادم خارجي', ckb: 'دەرگای دەرکردنی هەوا بۆ دەرەوە' },
  'optional add-on': { ar: 'إضافة اختيارية', ckb: 'زیادکراوی ئارەزوومەندانە' },
  'ambient operating temperature': { ar: 'حرارة الغرفة المناسبة للتشغيل', ckb: 'پلەی گەرمی ژوور بۆ کارکردن' },
  'max chamber temperature': { ar: 'أقصى حرارة للغرفة', ckb: 'بەرزترین پلەی گەرمی ژوورەکە' },
  'maximum colours': { ar: 'أقصى عدد ألوان', ckb: 'زۆرترین ژمارەی ڕەنگ' },
  'thermal runaway protection': { ar: 'الحماية من الانفلات الحراري', ckb: 'پاراستن لە دەرچوونی گەرمی' },

  'extruder drive type': { ar: 'نظام الإكسترودر', ckb: 'جۆری سیستەمی ئێکسترودەر' },
  'direct drive': { ar: 'دفع مباشر', ckb: 'ڕاستەوخۆ' },
  'hotend construction': { ar: 'تركيب الهوت إند', ckb: 'پێکهاتەی هۆت ئێند' },
  'all-metal': { ar: 'معدني بالكامل', ckb: 'تەواو مەعدەنی' },
  'ptfe-lined': { ar: 'مبطّن بـ PTFE', ckb: 'بە PTFE ڕووپۆشکراو' },
  'bi-metal heat break': { ar: 'فاصل حراري ثنائي المعدن', ckb: 'بڕەری گەرمی دوو مەعدەنی' },
  'brass': { ar: 'نحاس أصفر', ckb: 'برنج' },
  'hardened steel': { ar: 'فولاذ مقسّى', ckb: 'پۆڵای ڕەقکراو' },
  'stainless steel': { ar: 'فولاذ مقاوم للصدأ', ckb: 'پۆڵای زەنگ‌نەگر' },
  'tungsten carbide': { ar: 'كربيد التنغستن', ckb: 'کاربایدی تەنگستن' },
  'coated / other': { ar: 'مطلي / أخرى', ckb: 'ڕووپۆشکراو / هیتر' },
  'auxiliary part cooling': { ar: 'مروحة تبريد إضافية للقطعة', ckb: 'فێنککەرەوەی زیادەی پارچە' },

  'axis guidance': { ar: 'نظام توجيه المحاور', ckb: 'سیستەمی ڕێنمایی تەوەرەکان' },
  'linear rails (all axes)': { ar: 'قضبان خطية (كل المحاور)', ckb: 'ڕێڕەوی هێڵی (هەموو تەوەرەکان)' },
  'linear rails (x/y only)': { ar: 'قضبان خطية (X/Y فقط)', ckb: 'ڕێڕەوی هێڵی (تەنها X/Y)' },
  'linear rods + bearings': { ar: 'أعمدة خطية + رولمان', ckb: 'چەقی هێڵی + بەرینگ' },
  'pom wheels on extrusion': { ar: 'بكرات POM على قضبان الألمنيوم', ckb: 'چەرخی POM لەسەر ئەلەمنیۆم' },
  'mixed / other': { ar: 'مختلط / أخرى', ckb: 'تێکەڵ / هیتر' },
  'levelling sensor': { ar: 'نوع حساس التسوية', ckb: 'جۆری هەستەوەری هاوسەنگکردن' },
  'strain gauge / load cell': { ar: 'حساس ضغط (Load cell)', ckb: 'هەستەوەری فشار (Load cell)' },
  'inductive probe': { ar: 'مجس حثّي', ckb: 'هەستەوەری ئیندەکتیڤ' },
  'bltouch / touch probe': { ar: 'مجس لمسي BLTouch', ckb: 'هەستەوەری بەرکەوتەی BLTouch' },
  'eddy current': { ar: 'تيار دوّامي', ckb: 'جەریانی ئێدی' },
  'piezo': { ar: 'بيزو', ckb: 'پیزۆ' },
  'manual (no probe)': { ar: 'يدوي (بدون مجس)', ckb: 'دەستی (بێ هەستەوەر)' },
  'minimum layer height': { ar: 'أقل ارتفاع للطبقة', ckb: 'نزمترین بەرزی چین' },

  'proprietary': { ar: 'خاص بالشركة', ckb: 'تایبەت بە کۆمپانیا' },
  'print failure detection': { ar: 'كشف فشل الطباعة', ckb: 'دۆزینەوەی شکستی چاپ' },

  'screen type': { ar: 'نوع الشاشة', ckb: 'جۆری شاشە' },
  'monochrome lcd': { ar: 'شاشة أحادية اللون', ckb: 'شاشەی تاک‌ڕەنگ' },
  'colour lcd': { ar: 'شاشة ملوّنة', ckb: 'شاشەی ڕەنگاوڕەنگ' },
  'dlp (dmd)': { ar: 'DLP (DMD)', ckb: 'DLP (DMD)' },
  'lcd (unspecified)': { ar: 'شاشة LCD (غير محددة)', ckb: 'شاشەی LCD (دیارینەکراو)' },
  'screen rated life': { ar: 'العمر الافتراضي للشاشة', ckb: 'تەمەنی پێشبینیکراوی شاشە' },
  'z-axis accuracy': { ar: 'دقة محور Z', ckb: 'وردی تەوەری Z' },
  'max vertical print speed': { ar: 'أقصى سرعة طباعة عمودية', ckb: 'بەرزترین خێرایی چاپی ستوونی' },
  'layer release mechanism': { ar: 'آلية فصل الطبقة', ckb: 'میکانیزمی جیاکردنەوەی چین' },
  'tilt release': { ar: 'فصل بالإمالة', ckb: 'جیاکردنەوە بە لارکردن' },
  'standard lift-and-peel': { ar: 'رفع وفصل تقليدي', ckb: 'بەرزکردنەوە و جیاکردنەوەی ئاسایی' },
  'rotary / roller release': { ar: 'فصل دوّار', ckb: 'جیاکردنەوەی سووڕاوە' },
  'build plate levelling': { ar: 'تسوية منصة الطباعة', ckb: 'هاوسەنگکردنی پلێتی چاپ' },
  'levelling-free': { ar: 'بدون تسوية', ckb: 'بێ هاوسەنگکردن' },
  'auto levelling': { ar: 'تسوية تلقائية', ckb: 'هاوسەنگکردنی خۆکار' },
  // The other two options of the SAME select («تسوية منصة الطباعة»), recorded
  // for the same reason as the six above: they were being composed rather than
  // recorded, and what came out was «4-point يدوي» — an English fragment with
  // an Arabic adjective in front of it, shipped as a finished translation.
  // Once the code rule stopped moving an opaque token to the end of the line
  // these two had nothing left to compose from and would have been flagged on
  // every resin product for ever. Two of the four options of this field were
  // already recorded here; this completes the set rather than expanding it.
  'manual 4-point': { ar: 'تسوية يدوية بأربع نقاط', ckb: 'هاوسەنگکردنی دەستی بە چوار خاڵ' },
  'manual 2-point': { ar: 'تسوية يدوية بنقطتين', ckb: 'هاوسەنگکردنی دەستی بە دوو خاڵ' },

  'fits models': { ar: 'الموديلات المتوافقة', ckb: 'گونجاوە بۆ مۆدێلەکان' },
  'installation': { ar: 'التركيب', ckb: 'دامەزراندن' },
  'use case': { ar: 'حالة الاستخدام', ckb: 'شێوازی بەکارهێنان' },
  'voltage': { ar: 'الجهد الكهربائي', ckb: 'ڤۆڵتاژ' },
  'current': { ar: 'التيار الكهربائي', ckb: 'تێپەڕبوونی کارەبا' },
  'interface': { ar: 'الواجهة', ckb: 'ڕووکار' },
  'thread': { ar: 'سنّ اللولب', ckb: 'قەبارەی پێچ' },
  'colour hex': { ar: 'رمز اللون HEX', ckb: 'کۆدی HEXی ڕەنگ' },
  'certifications': { ar: 'الشهادات', ckb: 'بڕوانامەکان' },
  'not applicable': { ar: 'لا ينطبق', ckb: 'پەیوەندی نییە' },
  'operating temperature': { ar: 'درجة حرارة التشغيل', ckb: 'پلەی گەرمی کارکردن' },
  'spool type': { ar: 'نوع البكرة', ckb: 'جۆری بۆبین' },
  'with spool': { ar: 'مع بكرة', ckb: 'لەگەڵ بۆبین' },
  'refill': { ar: 'تعبئة', ckb: 'پڕکردنەوە' },
  'cardboard': { ar: 'كرتون', ckb: 'کارتۆن' },
  'wavelength': { ar: 'الطول الموجي', ckb: 'درێژی شەپۆل' },
  'pieces': { ar: 'قطع', ckb: 'دانەکان' },
  'assembly time': { ar: 'وقت التجميع', ckb: 'ماوەی پێکەوەنان' },
  'age rating': { ar: 'الفئة العمرية', ckb: 'پۆلێنی تەمەن' },
  'battery': { ar: 'البطارية', ckb: 'باتری' },
  'control range': { ar: 'نطاق التحكم', ckb: 'مەودای کۆنترۆڵ' },
  'channels': { ar: 'القنوات', ckb: 'کەناڵەکان' },

  // -------------------------------------------------------- material specs
  'material': { ar: 'المادة', ckb: 'کەرەستە' },
  'material type': { ar: 'نوع المادة', ckb: 'جۆری کەرەستە' },
  'diameter': { ar: 'القطر', ckb: 'تیرە' },
  'tolerance': { ar: 'التفاوت', ckb: 'تۆڵێرانس' },
  'color': { ar: 'اللون', ckb: 'ڕەنگ' },
  'colour': { ar: 'اللون', ckb: 'ڕەنگ' },
  'colors': { ar: 'الألوان', ckb: 'ڕەنگەکان' },
  'finish': { ar: 'التشطيب', ckb: 'کۆتایی ڕووکار' },
  'density': { ar: 'الكثافة', ckb: 'چڕی' },
  'hardness': { ar: 'الصلابة', ckb: 'ڕەقی' },
  'drying': { ar: 'التجفيف', ckb: 'وشککردنەوە' },
  'storage': { ar: 'التخزين', ckb: 'هەڵگرتن' },
  'shelf life': { ar: 'مدة الصلاحية', ckb: 'ماوەی بەکارهێنان' },
  'printing temperature': { ar: 'حرارة الطباعة', ckb: 'پلەی گەرمی چاپ' },
  'recommended settings': { ar: 'الإعدادات المقترحة' },
  'processing mode': { ar: 'نمط المعالجة', ckb: 'دۆخی پرۆسێسکردن' },
  'laser material': { ar: 'مادة ليزر', ckb: 'کەرەستەی لەیزەر' },
  'blade cutting material': { ar: 'مادة قص بشفرة', ckb: 'کەرەستەی بڕین بە تیغ' },
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
  // ---- 0079: how long the customer waits, and who is waiting for what ----
  // The one field on a pre-order that a formatter cannot derive from the day
  // numbers, so these are the LABELS an admin actually types beside it.
  'lead time': { ar: 'مدة التجهيز', ckb: 'ماوەی ئامادەکردن' },
  'preparation time': { ar: 'مدة التجهيز', ckb: 'ماوەی ئامادەکردن' },
  'processing time': { ar: 'مدة المعالجة', ckb: 'ماوەی پرۆسێسکردن' },
  'delivery time': { ar: 'مدة التوصيل', ckb: 'ماوەی گەیاندن' },
  'shipping time': { ar: 'مدة الشحن', ckb: 'ماوەی گواستنەوە' },
  'estimated delivery': { ar: 'التوصيل المتوقع', ckb: 'گەیاندنی چاوەڕوانکراو' },
  'estimated arrival': { ar: 'الوصول المتوقع', ckb: 'گەیشتنی چاوەڕوانکراو' },
  'ready to ship': { ar: 'جاهز للشحن', ckb: 'ئامادەیە بۆ ناردن' },
  'made to order': { ar: 'يُصنع عند الطلب', ckb: 'بە داواکاری دروست دەکرێت' },
  'ships worldwide': { ar: 'يُشحن إلى جميع الدول', ckb: 'بۆ هەموو جیهان دەنێردرێت' },
  'air freight': { ar: 'شحن جوي', ckb: 'گواستنەوەی ئاسمانی' },
  'sea freight': { ar: 'شحن بحري', ckb: 'گواستنەوەی دەریایی' },
  'land freight': { ar: 'شحن بري', ckb: 'گواستنەوەی وشکانی' },
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
