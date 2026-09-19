/**
 * THE COMPOSITIONAL LAYER — how this engine translates a SENTENCE without
 * inventing one.
 *
 * WHAT THE OWNER ASKED FOR, and why it is not a contradiction of §3:
 *
 *   «أريد تطوير القاموس وتطوير الترجمة إلى أقصى حد بحيث يترجم الجمل ليس بحرف
 *    ولكن بدقة عالية وبمعنى كامل وليس ترجمة حرفية»
 *
 * — translate SENTENCES, at high accuracy, with the full meaning, and NOT
 * word-by-word. §3 forbids an AI or a generative API and forbids inventing a
 * translation. It does not forbid a bigger hand-authored grammar, and a bigger
 * hand-authored grammar is exactly what "not word-by-word" requires.
 *
 * WHY WORD-BY-WORD IS THE WRONG SHAPE FOR ARABIC. English stacks modifiers
 * BEFORE the head noun; Arabic puts the head noun first and its modifiers
 * after, and they must agree with it in gender and definiteness:
 *
 *   open-frame FDM 3D printer   →  طابعة ثلاثية الأبعاد FDM مفتوحة الهيكل
 *   [mod][mod][mod][HEAD]           [HEAD]  [mod]        [mod] [mod]
 *
 * Gluing four separately-translated words together yields «مفتوح الإطار FDM
 * ثلاثي الأبعاد طابعة» — which is not Arabic. So this module never composes a
 * noun phrase out of separate words. It stores WHOLE PHRASES already written
 * in correct Arabic, and composes only at the level where composition is
 * grammatical: joining a translated head to a translated measurement, or
 * dropping translated phrases into a sentence frame whose Arabic is fixed.
 *
 * THE THREE THINGS THIS FILE ADDS:
 *
 *   1. NOUN_PHRASES — several hundred whole phrases, each written as correct
 *      Arabic (and Sorani where a confident rendering exists), with a GENDER
 *      tag so the frames below can agree with them.
 *   2. `translateNoun` — resolves one noun phrase, handling the pieces that
 *      ARE mechanical and safe: English articles (Arabic has no indefinite
 *      article), a leading or trailing measurement, "up to N", and plurals.
 *   3. SENTENCE_FRAMES — fixed Arabic sentence skeletons with typed slots.
 *      Every slot must resolve through this same machinery or the whole frame
 *      is abandoned. There is no partial output and no fallback guess.
 *
 * FAIL-CLOSED IS THE WHOLE SAFETY PROPERTY. Every function here returns
 * `null` the moment one piece is unknown, and `index.ts` then keeps the
 * English and flags `review_needed`. A half-translated sentence would be worse
 * than an untranslated one, because nobody would know to check it.
 *
 * NO NETWORK, NO MODEL, NO RANDOMNESS. Same input, same output, for ever —
 * `tests/translate.test.ts` pins that, and pins that this directory mentions
 * no provider and no API key.
 */

import type { TermEntry } from './dictionary';

export type TargetLang = 'ar' | 'ckb';

/**
 * Arabic grammatical gender of the HEAD noun, so a frame can agree with it.
 *
 * `f` for طابعة/شاشة/وحدة, `m` for نظام/جهاز/حساس. Sorani has no grammatical
 * gender, so this is read only for `ar`. Where it is absent the frames that
 * need agreement refuse rather than guessing — an adjective in the wrong
 * gender is the single most obvious tell of machine-translated Arabic.
 */
export type Gender = 'm' | 'f';

export interface NounEntry extends TermEntry {
  /** Gender of the Arabic head noun. Required for any entry a frame may use. */
  g?: Gender;
  /** The Arabic plural, when a frame needs one ("two nozzles"). */
  arPl?: string;
}

// ---------------------------------------------------------------- the nouns

/**
 * WHOLE noun phrases, already in correct target word order.
 *
 * Read the Arabic side as finished text, not as a gloss: «طابعة ثلاثية الأبعاد
 * مفتوحة الهيكل» is what an Arabic spec sheet actually says, and it is stored
 * that way precisely so nothing has to reorder it at runtime.
 *
 * Sorani is present only where a confident Iraqi-Kurdish technical rendering
 * is known. An entry with no `ckb` is not a gap to fill with a guess — it
 * means that segment stays English for Kurdish and gets flagged. §3.
 */
export const NOUN_PHRASES: Record<string, NounEntry> = {
  // ------------------------------------------------------------- machines
  'printer': { ar: 'طابعة', g: 'f', ckb: 'پرینتەر' },
  '3d printer': { ar: 'طابعة ثلاثية الأبعاد', g: 'f', ckb: 'پرینتەری سێ ڕەهەندی' },
  'fdm 3d printer': { ar: 'طابعة ثلاثية الأبعاد بتقنية FDM', g: 'f', ckb: 'پرینتەری سێ ڕەهەندی FDM' },
  'fdm printer': { ar: 'طابعة FDM', g: 'f', ckb: 'پرینتەری FDM' },
  'resin 3d printer': { ar: 'طابعة ريزن ثلاثية الأبعاد', g: 'f', ckb: 'پرینتەری ڕەزینی سێ ڕەهەندی' },
  'resin printer': { ar: 'طابعة ريزن', g: 'f', ckb: 'پرینتەری ڕەزین' },
  'open-frame fdm 3d printer': { ar: 'طابعة ثلاثية الأبعاد FDM مفتوحة الهيكل', g: 'f' },
  'open-frame 3d printer': { ar: 'طابعة ثلاثية الأبعاد مفتوحة الهيكل', g: 'f' },
  'enclosed 3d printer': { ar: 'طابعة ثلاثية الأبعاد مغلقة الهيكل', g: 'f' },
  'corexy 3d printer': { ar: 'طابعة ثلاثية الأبعاد بنظام CoreXY', g: 'f' },
  'laser engraver': { ar: 'ناقشة ليزر', g: 'f' },
  'laser cutter': { ar: 'قاطعة ليزر', g: 'f' },
  'cutting machine': { ar: 'آلة قص', g: 'f' },
  'scanner': { ar: 'ماسح ضوئي', g: 'm' },
  '3d scanner': { ar: 'ماسح ثلاثي الأبعاد', g: 'm' },

  // ------------------------------------------------------- printer anatomy
  'build volume': { ar: 'حيّز طباعة', g: 'm', ckb: 'قەبارەی چاپ' },
  'build plate': { ar: 'منصة طباعة', g: 'f', ckb: 'پلێتی چاپ' },
  'heated build plate': { ar: 'منصة طباعة ساخنة', g: 'f' },
  'print bed': { ar: 'سرير طباعة', g: 'm' },
  'heated bed': { ar: 'سرير ساخن', g: 'm', ckb: 'بێدی گەرم' },
  'nozzle': { ar: 'فوهة', g: 'f', arPl: 'فوهات', ckb: 'نۆزڵ' },
  'hardened nozzle': { ar: 'فوهة مقوّاة', g: 'f' },
  'hardened steel nozzle': { ar: 'فوهة من الفولاذ المقوّى', g: 'f' },
  'quick-swap nozzle system': { ar: 'نظام فوهات سريع التبديل', g: 'm' },
  'quick swap nozzle system': { ar: 'نظام فوهات سريع التبديل', g: 'm' },
  'nozzle system': { ar: 'نظام فوهات', g: 'm' },
  'hotend': { ar: 'رأس ساخن', g: 'm' },
  'all-metal hotend': { ar: 'رأس ساخن معدني بالكامل', g: 'm' },
  'extruder': { ar: 'باثق', g: 'm' },
  'direct drive extruder': { ar: 'باثق بدفع مباشر', g: 'm' },
  'dual extruder': { ar: 'باثق مزدوج', g: 'm' },
  'toolhead': { ar: 'رأس طباعة', g: 'm' },
  'toolhead speed': { ar: 'سرعة رأس الطباعة', g: 'f' },
  'print speed': { ar: 'سرعة طباعة', g: 'f', ckb: 'خێرایی چاپ' },
  'travel speed': { ar: 'سرعة التنقّل', g: 'f' },
  'acceleration': { ar: 'تسارع', g: 'm' },
  'stepper motor': { ar: 'محرك خطوي', g: 'm' },
  'linear rail': { ar: 'سكة خطية', g: 'f' },
  'lead screw': { ar: 'لولب قيادة', g: 'm' },
  'belt': { ar: 'سير', g: 'm' },
  'chassis': { ar: 'الهيكل', g: 'm', ckb: 'چوارچێوە' },
  'frame': { ar: 'الإطار', g: 'm' },
  'enclosure': { ar: 'هيكل مغلق', g: 'm' },
  'chamber': { ar: 'حجرة', g: 'f' },
  'heated chamber': { ar: 'حجرة ساخنة', g: 'f' },
  'cooling fan': { ar: 'مروحة تبريد', g: 'f' },
  'part cooling fan': { ar: 'مروحة تبريد القطعة', g: 'f' },
  'air filter': { ar: 'فلتر هواء', g: 'm' },
  'carbon filter': { ar: 'فلتر كربوني', g: 'm' },
  'power supply': { ar: 'مزوّد طاقة', g: 'm', ckb: 'دابینکەری وزە' },
  'touchscreen': { ar: 'شاشة لمس', g: 'f', ckb: 'شاشەی دەستلێدان' },
  'display': { ar: 'شاشة', g: 'f', ckb: 'شاشە' },
  'screen': { ar: 'شاشة', g: 'f', ckb: 'شاشە' },
  'camera': { ar: 'كاميرا', g: 'f', ckb: 'کامێرا' },
  'lidar sensor': { ar: 'حساس ليدار', g: 'm' },
  'sensor': { ar: 'حساس', g: 'm', arPl: 'حساسات' },
  'filament runout sensor': { ar: 'حساس نفاد الفلامنت', g: 'm' },
  'filament sensor': { ar: 'حساس الفلامنت', g: 'm' },
  'spool holder': { ar: 'حامل بكرة', g: 'm' },
  'filament dryer': { ar: 'مجفّف فلامنت', g: 'm' },
  'material system': { ar: 'نظام مواد', g: 'm' },
  'multi-material system': { ar: 'نظام متعدد المواد', g: 'm' },
  'automatic material system': { ar: 'نظام تغذية تلقائي للمواد', g: 'm' },

  // ------------------------------------------------------------- features
  'calibration': { ar: 'معايرة', g: 'f' },
  'auto calibration': { ar: 'معايرة تلقائية', g: 'f' },
  'automatic calibration': { ar: 'معايرة تلقائية', g: 'f' },
  'full-auto calibration': { ar: 'معايرة تلقائية بالكامل', g: 'f' },
  'fully automatic calibration': { ar: 'معايرة تلقائية بالكامل', g: 'f' },
  'auto bed leveling': { ar: 'تسوية تلقائية للسرير', g: 'f' },
  'automatic bed leveling': { ar: 'تسوية تلقائية للسرير', g: 'f' },
  'bed leveling': { ar: 'تسوية السرير', g: 'f' },
  'flow-rate compensation': { ar: 'تعويض معدّل التدفق', g: 'm' },
  'flow rate compensation': { ar: 'تعويض معدّل التدفق', g: 'm' },
  'active flow-rate compensation': { ar: 'تعويض نشط لمعدّل التدفق', g: 'm' },
  'active flow rate compensation': { ar: 'تعويض نشط لمعدّل التدفق', g: 'm' },
  'vibration compensation': { ar: 'تعويض الاهتزاز', g: 'm' },
  'input shaping': { ar: 'تهذيب الاهتزاز', g: 'm' },
  'resonance compensation': { ar: 'تعويض الرنين', g: 'm' },
  'pressure advance': { ar: 'تعويض الضغط', g: 'm' },
  'power loss recovery': { ar: 'استئناف الطباعة بعد انقطاع الكهرباء', g: 'm' },
  'resume printing': { ar: 'استئناف الطباعة', g: 'm' },
  'remote monitoring': { ar: 'مراقبة عن بُعد', g: 'f' },
  'timelapse recording': { ar: 'تصوير الطباعة المتسارع', g: 'm' },
  'spaghetti detection': { ar: 'كشف فشل الطباعة', g: 'm' },
  'multi-colour printing': { ar: 'طباعة متعددة الألوان', g: 'f', ckb: 'چاپی فرەڕەنگ' },
  'multi-color printing': { ar: 'طباعة متعددة الألوان', g: 'f', ckb: 'چاپی فرەڕەنگ' },
  'multi-material printing': { ar: 'طباعة متعددة المواد', g: 'f' },
  'single-colour printing': { ar: 'طباعة بلون واحد', g: 'f' },
  'printing': { ar: 'الطباعة', g: 'f', ckb: 'چاپکردن' },
  'silent printing': { ar: 'طباعة صامتة', g: 'f' },
  'quiet operation': { ar: 'تشغيل هادئ', g: 'm' },

  // ------------------------------------------------------- measured things
  'layer height': { ar: 'ارتفاع الطبقة', g: 'm', ckb: 'بەرزی چین' },
  'layer resolution': { ar: 'دقة الطبقة', g: 'f' },
  'nozzle diameter': { ar: 'قطر الفوهة', g: 'm', ckb: 'تیرەی نۆزڵ' },
  'filament diameter': { ar: 'قطر الفلامنت', g: 'm', ckb: 'تیرەی فیلامێنت' },
  'nozzle temperature': { ar: 'حرارة الفوهة', g: 'f', ckb: 'پلەی گەرمی نۆزڵ' },
  'bed temperature': { ar: 'حرارة السرير', g: 'f', ckb: 'پلەی گەرمی بێد' },
  'chamber temperature': { ar: 'حرارة الحجرة', g: 'f' },
  'printing temperature': { ar: 'حرارة الطباعة', g: 'f', ckb: 'پلەی گەرمی چاپ' },
  'operating temperature': { ar: 'حرارة التشغيل', g: 'f' },
  'max temperature': { ar: 'أقصى حرارة', g: 'f' },
  'maximum temperature': { ar: 'أقصى حرارة', g: 'f' },
  'positioning accuracy': { ar: 'دقة التموضع', g: 'f' },
  'dimensional accuracy': { ar: 'الدقة الأبعادية', g: 'f' },
  'power consumption': { ar: 'استهلاك الطاقة', g: 'm' },
  'rated power': { ar: 'القدرة المقننة', g: 'f' },
  'input voltage': { ar: 'جهد الدخل', g: 'm', ckb: 'ڤۆڵتاژی چوونەژوورەوە' },
  'noise level': { ar: 'مستوى الضوضاء', g: 'm' },
  'machine dimensions': { ar: 'أبعاد الجهاز', g: 'f' },
  'product dimensions': { ar: 'أبعاد المنتج', g: 'f', ckb: 'ڕەهەندی بەرهەم' },
  'package dimensions': { ar: 'أبعاد العبوة', g: 'f', ckb: 'ڕەهەندی پاکێت' },
  'net weight': { ar: 'الوزن الصافي', g: 'm', ckb: 'کێشی ڕەها' },
  'gross weight': { ar: 'الوزن الإجمالي', g: 'm', ckb: 'کێشی گشتی' },

  // ------------------------------------------------------------ materials
  'filament': { ar: 'فلامنت', g: 'm', ckb: 'فیلامێنت' },
  'spool': { ar: 'بكرة', g: 'f', arPl: 'بكرات', ckb: 'بۆبین' },
  'resin': { ar: 'ريزن', g: 'm', ckb: 'ڕەزین' },
  'supported materials': { ar: 'المواد المدعومة', g: 'f', ckb: 'کەرەستە پشتگیریکراوەکان' },
  'compatible materials': { ar: 'المواد المتوافقة', g: 'f', ckb: 'کەرەستە گونجاوەکان' },
  'abrasive materials': { ar: 'المواد الكاشطة', g: 'f' },
  'engineering materials': { ar: 'المواد الهندسية', g: 'f' },
  'soluble support': { ar: 'دعامات قابلة للذوبان', g: 'f' },
  'support material': { ar: 'مادة الدعامات', g: 'f' },

  // ------------------------------------------------------ software / links
  'slicer': { ar: 'برنامج تقطيع', g: 'm' },
  'slicing software': { ar: 'برنامج التقطيع', g: 'm' },
  'firmware': { ar: 'برنامج ثابت', g: 'm' },
  'mobile app': { ar: 'تطبيق للهاتف', g: 'm' },
  'cloud service': { ar: 'خدمة سحابية', g: 'f' },
  'wi-fi connectivity': { ar: 'اتصال Wi-Fi', g: 'm' },
  'network connectivity': { ar: 'اتصال بالشبكة', g: 'm' },
  'usb-c port': { ar: 'منفذ USB-C', g: 'm' },
  'sd card slot': { ar: 'فتحة بطاقة SD', g: 'f' },
  'microsd card': { ar: 'بطاقة microSD', g: 'f' },

  // --------------------------------------------------------- the packaging
  'package': { ar: 'العبوة', g: 'f', ckb: 'پاکێت' },
  'box': { ar: 'العلبة', g: 'f' },
  'accessories': { ar: 'إكسسوارات', g: 'f', ckb: 'ئێکسسوار' },
  'spare parts': { ar: 'قطع غيار', g: 'f', ckb: 'پارچەی یەدەگ' },
  'tool kit': { ar: 'طقم أدوات', g: 'm' },
  'user manual': { ar: 'دليل المستخدم', g: 'm' },
  'quick start guide': { ar: 'دليل البدء السريع', g: 'm' },
  'power cable': { ar: 'كابل طاقة', g: 'm' },
  'usb cable': { ar: 'كابل USB', g: 'm' },

  // --------------------------------------------------- spec GROUP headings
  // The section titles a template family emits. They reach the translation
  // sheet as fields in their own right, which is why they are nouns here and
  // not sentences — and why "Chassis" alone must resolve.
  'engineering and sensor details': { ar: 'تفاصيل الهندسة والحساسات', g: 'f' },
  'additional engineering and sensor details': { ar: 'تفاصيل هندسية وحساسات إضافية', g: 'f' },
  'additional details': { ar: 'تفاصيل إضافية', g: 'f' },
  'technical details': { ar: 'التفاصيل التقنية', g: 'f' },
  'technical specifications': { ar: 'المواصفات التقنية', g: 'f' },
  'specifications': { ar: 'المواصفات', g: 'f' },
  'general specifications': { ar: 'المواصفات العامة', g: 'f' },
  'mechanical specifications': { ar: 'المواصفات الميكانيكية', g: 'f' },
  'electrical specifications': { ar: 'المواصفات الكهربائية', g: 'f' },
  'performance': { ar: 'الأداء', g: 'm' },
  'motion system': { ar: 'نظام الحركة', g: 'm' },
  'electronics': { ar: 'الإلكترونيات', g: 'f' },
  'connectivity': { ar: 'الاتصال', g: 'm', ckb: 'پەیوەندی' },
  'safety': { ar: 'السلامة', g: 'f' },
  'certifications': { ar: 'الشهادات', g: 'f' },
  'sensors': { ar: 'الحساسات', g: 'f' },
  'dimensions and weight': { ar: 'الأبعاد والوزن', g: 'f' },
  'box contents': { ar: 'محتويات العلبة', g: 'f' },
  'how to use': { ar: 'طريقة الاستخدام', g: 'f' },
  'setup guide': { ar: 'دليل التجهيز', g: 'm' },
  'usage steps': { ar: 'خطوات الاستخدام', g: 'f' },
  'maintenance': { ar: 'الصيانة', g: 'f' },
  'troubleshooting': { ar: 'حل المشكلات', g: 'm' },
  'system requirements': { ar: 'متطلبات النظام', g: 'f' },

  // ------------------------------------------------------------- commerce
  'warranty': { ar: 'ضمان', g: 'm', ckb: 'گەرەنتی' },
  'extended warranty': { ar: 'ضمان ممدد', g: 'm' },
  'free shipping': { ar: 'توصيل مجاني', g: 'm', ckb: 'گەیاندنی بێبەرامبەر' },
  'fast delivery': { ar: 'توصيل سريع', g: 'm' },
  'technical support': { ar: 'دعم فني', g: 'm' },
  'customer service': { ar: 'خدمة العملاء', g: 'f' },
};

// --------------------------------------------------------- adjectival tails

/**
 * Modifiers that may follow a head noun, in the Arabic form that agrees with
 * that head's gender.
 *
 * Kept SEPARATE from the phrase table because these genuinely do compose:
 * «طابعة … صامتة» and «نظام … صامت» differ only in the tail, and storing both
 * whole phrases for every head would be thousands of rows that drift apart.
 * Agreement is mechanical, so it is the one thing this file is willing to
 * compute — and it computes it from a recorded pair, never from a rule about
 * Arabic morphology.
 */
const ADJECTIVES: Record<string, { m: string; f: string; ckb?: string }> = {
  'open-frame': { m: 'مفتوح الهيكل', f: 'مفتوحة الهيكل' },
  'enclosed': { m: 'مغلق الهيكل', f: 'مغلقة الهيكل' },
  'compact': { m: 'مدمج', f: 'مدمجة' },
  'portable': { m: 'محمول', f: 'محمولة' },
  'silent': { m: 'صامت', f: 'صامتة' },
  'quiet': { m: 'هادئ', f: 'هادئة' },
  'fast': { m: 'سريع', f: 'سريعة' },
  'high-speed': { m: 'عالي السرعة', f: 'عالية السرعة' },
  'high-precision': { m: 'عالي الدقة', f: 'عالية الدقة' },
  'heavy-duty': { m: 'شاق التحمّل', f: 'شاقة التحمّل' },
  'professional': { m: 'احترافي', f: 'احترافية' },
  'entry-level': { m: 'للمبتدئين', f: 'للمبتدئين' },
  'desktop': { m: 'مكتبي', f: 'مكتبية' },
  'industrial': { m: 'صناعي', f: 'صناعية' },
  'wireless': { m: 'لاسلكي', f: 'لاسلكية' },
  'automatic': { m: 'تلقائي', f: 'تلقائية', ckb: 'خۆکار' },
  'manual': { m: 'يدوي', f: 'يدوية', ckb: 'دەستی' },
  'built-in': { m: 'مدمج', f: 'مدمجة' },
  'removable': { m: 'قابل للفك', f: 'قابلة للفك' },
  'magnetic': { m: 'مغناطيسي', f: 'مغناطيسية' },
  'flexible': { m: 'مرن', f: 'مرنة' },
  'durable': { m: 'متين', f: 'متينة' },
  'lightweight': { m: 'خفيف الوزن', f: 'خفيفة الوزن' },
};

// ------------------------------------------------------------- the plumbing

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    // An ampersand is the word "and" wearing a symbol. A spec sheet writes
    // "Engineering & sensor details" and a dictionary cannot hold both forms
    // of every entry, so the symbol is folded here instead.
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    // A typographic dash between words is the same phrase as a hyphen.
    .replace(/[‐-―]/g, '-');

/** English articles carry no meaning Arabic can keep: Arabic has no
 *  indefinite article, and its definite one is a prefix already baked into the
 *  stored phrase where it belongs. */
const ARTICLE_RE = /^(?:a|an|the)\s+/i;

const stripArticle = (s: string): string => s.replace(ARTICLE_RE, '');

/**
 * A bare count, for "up to N" and for NOTHING ELSE in this file.
 *
 * Deliberately not exposed through `GrammarContext`: a bare number is what let
 * rule 3 peel "389" off the front of "389 x 389 x 458 mm" and scramble the
 * rest. "up to" is the one context where a number with no unit is unambiguous
 * — it is a ceiling — so the reading is safe there and only there.
 */
const BARE_COUNT_RE = /^[±~]?\d+(?:[.,]\d+)?$/;

/** See the bound in `resolveNoun`: the most tokens the compositional rules
 *  will explore. A noun phrase is not thirteen words long. */
const MAX_COMPOSITION_TOKENS = 12;

/** Resolver for measurements and identity tokens, injected by index.ts so this
 *  module never duplicates R2/R3 and the two can never disagree. */
export interface AtomResolver {
  /** "0.4 mm", "256 × 256 × 256 mm", "PLA", "A1" → localized, or null. */
  (value: string, lang: TargetLang): string | null;
}

export interface GrammarContext {
  lang: TargetLang;
  /**
   * "Can this stand alone as a VALUE?" — R2 + R3 + R4 from index.ts, so a
   * dictionary phrase counts. "Black" is a complete value on a colour line.
   */
  atom: AtomResolver;
  /**
   * "Is this a FIGURE, of the kind Arabic moves behind its head noun?" — R3
   * and R3 ALONE: a number WITH a unit. NOT a dictionary phrase, NOT a bare
   * number, and — since the code rule below took it over — NOT an opaque code
   * either.
   *
   * This exists because rule 3 below used to ask `atom` while meaning this,
   * and `atom` says yes to "gross weight". The consequence was «13 كغم الوزن
   * الإجمالي» reported as a finished translation. Keep the two apart.
   */
  measure: AtomResolver;
  /**
   * "Is this an opaque CODE?" — a model number, a material name, a part
   * number: PLA, A1, X1C.
   *
   * SEPARATE FROM `measure`, AND THE SEPARATION IS A CORRECTION. A code used
   * to satisfy `measure`, so rule 3 — the rule that MOVES a figure to the end
   * of the line — moved codes too. On its own that read acceptably («فلامنت
   * PLA»), but once rule 3b started resolving "<head> <figure>" there was a
   * figure sitting between the code and its noun, and the output became
   * «فلامنت 1 كغم PLA», «فوهة 0.4 مم A1», «حرارة الفوهة 220 °م PLA» — the very
   * defect class this round was opened to close, shipped as `status:'machine'`
   * with no review flag. A code is not a figure: a figure is what the noun
   * MEASURES and goes after it, a code is what the noun IS and must stay
   * beside it.
   */
  code: AtomResolver;
  /** R4 from index.ts: the flat PHRASES table, for labels and short values. */
  phrase: (term: string, lang: TargetLang) => string | null;
}

interface Resolved {
  text: string;
  gender: Gender | undefined;
}

/**
 * ONE NOUN PHRASE, with the mechanical parts handled and nothing guessed.
 *
 * Handles, in this order, because a longer reading must win over a shorter one:
 *   "a quick-swap nozzle system"        → article dropped, whole-phrase hit
 *   "256 × 256 × 256 mm build volume"   → measurement moved AFTER the head
 *   "up to 500 mm/s toolhead speed"     → «سرعة رأس الطباعة تصل إلى 500 مم/ث»
 *   "silent 3D printer"                 → head + agreeing adjective
 *
 * Returns null — and therefore refuses the whole sentence — for anything else.
 */
function resolveNoun(raw: string, ctx: GrammarContext): Resolved | null {
  const input = stripArticle(raw.trim()).trim();
  if (!input) return null;
  const key = norm(input);

  // 1. The whole thing is a recorded phrase. Always tried first: a stored
  //    phrase is a human's finished Arabic and beats anything composed.
  const direct = NOUN_PHRASES[key];
  if (direct) {
    const out = ctx.lang === 'ar' ? direct.ar : direct.ckb;
    if (out) return { text: out, gender: direct.g };
    return null;
  }

  /**
   * A HARD BOUND ON COMPOSITION, and it is a safety property, not a tuning
   * knob. Rules 2, 3, 3b and 4 each try every split point and RECURSE on the
   * remainder, so their cost is exponential in the token count. That was
   * hidden until now by an accident: rule 3 used to accept the first head it
   * could resolve AT ALL, so on a run of measurements it returned on the
   * second iteration and never explored the tree. Requiring a real head noun
   * is what the correctness fix demanded, and it removed that accidental early
   * exit, so a pasted spec run such as
   *
   *   "256 x 256 x 256 mm 0.4 mm 0.4 mm 0.4 mm …"
   *
   * — every token a measurement, no token a noun — went from milliseconds to
   * not returning. This runs on the ADMIN SAVE PATH inside a Cloudflare
   * Worker, where a CPU-limit kill is a failed save, so the bound is not
   * optional.
   *
   * Twelve is chosen because a NOUN PHRASE is not thirteen words long. The
   * longest one this engine actually composes is "256 x 256 x 256 mm build
   * volume" at eight. Past the bound the compositional rules are skipped and
   * the input can still resolve as a whole recorded phrase (rule 1), a whole
   * measurement (rule 5) or a product name (rule 6) — or it is refused, kept
   * in English and flagged, which is the correct answer for a thirteen-word
   * run that no frame matched anyway.
   */
  const tokens = input.split(/\s+/);
  if (tokens.length > MAX_COMPOSITION_TOKENS) {
    const whole = ctx.atom(input, ctx.lang);
    if (whole) return { text: whole, gender: undefined };
    return null;
  }

  // 2. "up to <measurement> <head>" — the quantifier moves behind the head,
  //    which is where Arabic puts it.
  //
  //    EVERY split point is tried, longest measurement first. A single
  //    non-greedy regex match is not enough: on "up to 500 mm/s toolhead
  //    speed" it would take the measurement to be "500" — which parses,
  //    because a bare number is language-neutral — and then fail on the rest.
  //    The reading that consumes the most as a measurement is the right one.
  const upTo = input.match(/^up to\s+(.+)$/i);
  if (upTo) {
    const rest = upTo[1].split(/\s+/);
    for (let cut = rest.length - 1; cut >= 1; cut--) {
      const quantified = rest.slice(0, cut).join(' ');
      // `measure`, NOT `atom` — see the note on GrammarContext. A bare COUNT
      // is allowed here and nowhere else, because "up to" pins what the number
      // is: "up to 16 colours" is a quantity, and «الألوان تصل إلى 16» keeps
      // it a quantity. Longest reading first, so the unit is consumed as part
      // of the measurement before the bare-count fallback is ever reached.
      const measure =
        ctx.measure(quantified, ctx.lang) ?? (BARE_COUNT_RE.test(quantified) ? quantified : null);
      if (!measure) continue;
      const head = resolveNoun(rest.slice(cut).join(' '), ctx);
      if (!head) continue;
      return { text: `${head.text} ${reaches(head.gender, ctx.lang)} ${measure}`, gender: head.gender };
    }
    return null;
  }

  // 3. "<measurement> <head>" — English puts the figure first, Arabic after.
  //    Counting DOWN from the longest possible measurement, so
  //    "256 x 256 x 256 mm build volume" keeps the whole dimension together
  //    instead of stopping at the bare "256".
  //
  //    IT MUST BE `ctx.measure`, NOT `ctx.atom`. This one substitution is the
  //    whole word-order defect. `atom` consults the PHRASES dictionary first,
  //    so it answered "yes, that is a measurement" for "gross weight", for
  //    "product dimensions", for "automatic" — for any label at all. The rule
  //    then did exactly what it is built to do and moved that "measurement"
  //    behind the head, producing «13 كغم الوزن الإجمالي» and reporting
  //    `status: 'machine'` with no review flag.
  //
  //    `atom` also said yes to a BARE NUMBER, which is how the dimension tore
  //    itself apart: on "389 x 389 x 458 mm" every longer reading failed for
  //    want of a unit, the loop reached cut=1, took "389" as the measurement,
  //    and re-entered on "x 389 x 458 mm" — which parses as a measurement of
  //    its own. Out came «× 389 × 458 مم 389». `measure` requires a unit, so
  //    the loop now fails cleanly and step 5 reads the dimension whole.
  //
  //    THE HEAD MUST BE A RECORDED NOUN, which is what a recorded GENDER
  //    means here — only NOUN_PHRASES carries one. This rule MOVES text, and
  //    moving it is only right if the thing it moves behind is a noun the
  //    figure describes. Without the check the head could be any short value
  //    in the flat PHRASES table, and the A1's own nozzle line proves what
  //    that costs: "0.4 mm included" resolved `included` → «مشمول» and came
  //    out «مشمول 0.4 مم», which reads "included 0.4 mm". Arabic wants
  //    «0.4 مم مشمولة» — an agreement this engine has no recorded pair for —
  //    so the honest answer is to refuse and let a human write it.
  for (let cut = tokens.length - 1; cut >= 1; cut--) {
    const measure = ctx.measure(tokens.slice(0, cut).join(' '), ctx.lang);
    if (!measure) continue;
    const head = resolveNoun(tokens.slice(cut).join(' '), ctx);
    if (head?.gender) return { text: `${head.text} ${measure}`, gender: head.gender };
  }

  // 3b. "<head> <measurement>" — the order Arabic ALREADY wants, so nothing
  //     moves. A spec line writes it constantly: "Gross weight 13 kg",
  //     "Product dimensions 389 x 389 x 458 mm", "Print speed 500 mm/s".
  //     Arabic names the thing and then measures it — «الوزن الإجمالي 13 كغم»
  //     is an ordinary nominal sentence — so the English order is already the
  //     Arabic order and this rule only has to resolve the two halves.
  //
  //     It is a SEPARATE rule rather than a relaxation of rule 3 because the
  //     two are opposites and only one can be right for a given line. Rule 3
  //     runs first: with `measure` on both sides the prefix and the suffix can
  //     never both be figures, so there is nothing to disambiguate.
  //
  //     The measurement is matched from the LONGEST SUFFIX inwards, so a
  //     dimension is consumed in one piece and the head keeps every token in
  //     front of it. Cheap test first, recursion only once it passes.
  //
  //     No recorded-gender requirement here, unlike rule 3, and the asymmetry
  //     is the point: rule 3 REORDERS and may only reorder around a real head
  //     noun, while this rule moves nothing. "Warranty period 12 months" is a
  //     PHRASES label with no gender recorded, and «مدة الضمان 12 شهر» is the
  //     author's own order — there is nothing here to get wrong.
  for (let cut = 1; cut < tokens.length; cut++) {
    const measure = ctx.measure(tokens.slice(cut).join(' '), ctx.lang);
    if (!measure) continue;
    const head = resolveNoun(tokens.slice(0, cut).join(' '), ctx);
    if (head) return { text: `${head.text} ${measure}`, gender: head.gender };
  }

  /**
   * 3c. "<code> <head>" — the code follows the head and STAYS BESIDE IT.
   *
   *     English writes the code first ("PLA filament", "A1 nozzle"); Arabic
   *     names the thing and then qualifies it — «فلامنت PLA», «فوهة A1». The
   *     code is not a measurement of the noun, it is part of what the noun IS,
   *     so it must end up adjacent to the head and nowhere else.
   *
   *     AFTER 3b, AND THE ORDER IS THE ENTIRE FIX. This used to be folded into
   *     rule 3 by letting a code satisfy `ctx.measure`, which moved the code to
   *     the END of whatever rule 3 produced. Once 3b could resolve "<head>
   *     <figure>", the figure landed between the code and its noun:
   *
   *       "PLA filament 1 kg"  →  «فلامنت 1 كغم PLA»
   *       "A1 nozzle 0.4 mm"   →  «فوهة 0.4 مم A1»
   *
   *     Running 3b first makes the measurement the OUTER frame and hands the
   *     remainder — "PLA filament", "A1 nozzle" — back to this rule, which
   *     puts the code where it belongs: «فلامنت PLA 1 كغم», «فوهة A1 0.4 مم».
   *
   *     A RECORDED HEAD NOUN IS REQUIRED, for the same reason rule 3 requires
   *     one: this rule moves text, and text may only be moved behind a noun
   *     that is really a noun. Longest code first, so a two-token code is not
   *     torn in half.
   */
  for (let cut = tokens.length - 1; cut >= 1; cut--) {
    const code = ctx.code(tokens.slice(0, cut).join(' '), ctx.lang);
    if (!code) continue;
    const head = resolveNoun(tokens.slice(cut).join(' '), ctx);
    if (head?.gender) return { text: `${head.text} ${code}`, gender: head.gender };
  }

  // 4. "<adjective> <head>" — the adjective follows the head and agrees with
  //    it. Only for a recorded adjective and a head whose gender is recorded;
  //    an unrecorded gender refuses rather than picking one.
  for (let cut = 1; cut < tokens.length; cut++) {
    const adj = ADJECTIVES[norm(tokens.slice(0, cut).join(' '))];
    if (!adj) continue;
    const head = resolveNoun(tokens.slice(cut).join(' '), ctx);
    if (!head) continue;
    if (ctx.lang === 'ar') {
      if (!head.gender) continue;
      return { text: `${head.text} ${adj[head.gender]}`, gender: head.gender };
    }
    if (!adj.ckb) continue;
    return { text: `${head.text}ی ${adj.ckb}`, gender: head.gender };
  }

  // 5. A bare measurement or identity token standing on its own.
  const atom = ctx.atom(input, ctx.lang);
  if (atom) return { text: atom, gender: undefined };

  // 6. A PRODUCT-LINE NAME — "AMS lite", "X1 Carbon", "A1 Combo". §3 says a
  //    product name is never translated, so passing it through verbatim IS
  //    its translation. Deliberately narrow: an identity term or model code
  //    plus, at most, recorded product-line suffixes. That is what stops an
  //    ordinary English phrase from being waved through as a "name".
  if (isProperNounRun(input, ctx)) return { text: input, gender: undefined };

  return null;
}

/**
 * The suffixes a manufacturer appends to a product line. They are names, not
 * words: "lite" in "AMS lite" is not the English adjective, and translating it
 * would be an error in every language.
 */
const PRODUCT_SUFFIXES = new Set([
  'lite', 'pro', 'plus', 'max', 'mini', 'se', 'ultra', 'ultra+', 'combo', 'carbon',
  'edition', 'series', 'kit', 'v2', 'v3', 'gen2', 'gen3', 'ht', 'xl', 'xs',
]);

function isProperNounRun(input: string, ctx: GrammarContext): boolean {
  const tokens = input.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 4) return false;
  let anchored = false;
  for (const tok of tokens) {
    // An identity term or model code anchors the run as a real product name.
    if (ctx.atom(tok, ctx.lang) === tok) {
      anchored = true;
      continue;
    }
    if (PRODUCT_SUFFIXES.has(norm(tok))) continue;
    return false;
  }
  return anchored;
}

/** The public single-phrase entry point. */
export function translateNounPhrase(raw: string, ctx: GrammarContext): string | null {
  return resolveNoun(raw, ctx)?.text ?? null;
}

/**
 * A COORDINATED LIST — "A, B, C and D" — rendered with Arabic punctuation and
 * the wa- conjunction written attached, as Arabic writes it.
 *
 * Splitting is done on top-level separators only: a comma inside brackets
 * belongs to its member, not to the list.
 */
function splitList(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  const push = () => {
    const t = current.trim();
    if (t) parts.push(t);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    // A comma BETWEEN DIGITS is a thousands separator, not a list separator.
    // Without this, "up to 10,000 mm/s² acceleration" splits into "up to 10"
    // and "000 mm/s² acceleration" and the whole sentence is abandoned.
    const digitsAround = ch === ',' && /\d$/.test(current) && /^\s*\d/.test(text.slice(i + 1));
    if (depth === 0 && ch === ',' && !digitsAround) {
      push();
      continue;
    }
    current += ch;
  }
  push();

  // The final member may still carry "and …" / "or …".
  const last = parts.pop();
  if (last === undefined) return null;
  const tail = last.match(/^(.*?)\s+(?:and|or)\s+(.+)$/i);
  if (tail) {
    if (tail[1].trim()) parts.push(tail[1].trim());
    parts.push(tail[2].trim());
  } else {
    parts.push(last);
  }
  return parts.length >= 2 ? parts : null;
}

function joinList(items: string[], lang: TargetLang): string {
  if (items.length === 1) return items[0];
  const head = items.slice(0, -1).join('، ');
  /**
   * «و» IS A PREFIX IN ARABIC AND A FREE WORD IN SORANI.
   *
   * Both branches used to be the same character AND the same spacing, which
   * is correct for Arabic — «الوزن والأبعاد» is written joined — and wrong for
   * Kurdish, where «و نۆزڵ» takes a space. The live corpus showed it:
   * "Layer height 0.2 mm, nozzle 0.4 mm" came back as «... مم ونۆزڵ ...».
   * The ternary is kept, with a real difference in it, rather than removed —
   * the two languages genuinely differ here.
   */
  const and = lang === 'ar' ? 'و' : 'و ';
  return `${head} ${and}${items[items.length - 1]}`;
}

/** Every member of a list must resolve, or the list does not. */
export function translateNounList(text: string, ctx: GrammarContext): string | null {
  const parts = splitList(text);
  if (!parts) return translateNounPhrase(text, ctx);
  const out: string[] = [];
  for (const p of parts) {
    const t = translateNounPhrase(p, ctx);
    if (t === null) return null;
    out.push(t);
  }
  return joinList(out, ctx.lang);
}

// ------------------------------------------------------------- the frames

/**
 * A SENTENCE FRAME: a fixed Arabic skeleton with typed holes.
 *
 * The Arabic in `build` is written by hand and is not assembled from anything
 * — only the HOLES are filled, and only with text that resolved through the
 * tables above. That is what keeps "translate the sentence" from becoming
 * "invent the sentence".
 *
 * `subject` holes accept a product name or model code and are passed through
 * unchanged: §3 says the product NAME is never translated.
 */
interface Frame {
  id: string;
  re: RegExp;
  build: (m: RegExpMatchArray, ctx: GrammarContext) => string | null;
}

/** A subject that is a brand/model string: letters, digits, spaces, hyphens,
 *  slashes — and NOT a sentence. Kept verbatim (§3). */
const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-+/]{0,60}$/;

const subject = (s: string): string | null => {
  const t = s.trim();
  return SUBJECT_RE.test(t) ? t : null;
};

/**
 * "up to N" placed behind the head, agreeing with it.
 *
 * With no recorded gender it falls back to «حتى», which is idiomatic and
 * carries no agreement at all — better than picking a gender and being wrong
 * half the time.
 */
const reaches = (g: Gender | undefined, lang: TargetLang): string => {
  if (lang !== 'ar') return 'دەگاتە';
  if (!g) return 'حتى';
  return g === 'f' ? 'تصل إلى' : 'يصل إلى';
};

/** Gender-agreeing "equipped with". */
const equipped = (g: Gender | undefined, lang: TargetLang): string | null => {
  if (lang !== 'ar') return 'بە';
  if (!g) return null;
  return g === 'f' ? 'مزوّدة ب' : 'مزوّد ب';
};

/**
 * The bi- prefix is written ATTACHED to an Arabic word («بحيّز») but needs the
 * tatweel when the next word is Latin («بـPLA»), because a bare «ب» followed
 * by Latin letters renders as a stray floating letter in RTL text.
 */
const ARABIC_START_RE = /^[\u0600-\u06FF]/;
const attachBi = (prefix: string, rest: string): string =>
  ARABIC_START_RE.test(rest) ? `${prefix}${rest}` : `${prefix}ـ${rest}`;

const FRAMES: Frame[] = [
  /**
   * "X is a <NP> with <list>."
   * → «X هي <NP> مزوّدة بـ<list>.»   (gender from the NP's head)
   *
   * The single most common opening line of a product description, and the one
   * in the owner's screenshot.
   */
  {
    id: 'is-a-with',
    re: /^(.+?)\s+is\s+(?:an?|the)\s+(.+?)\s+with\s+(.+)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const np = resolveNoun(m[2], ctx);
      const list = translateNounList(m[3], ctx);
      if (!subj || !np || !list) return null;
      const w = equipped(np.gender, ctx.lang);
      if (!w) return null;
      if (ctx.lang !== 'ar') return `${subj} ${np.text}ە ${w} ${list}`;
      const is = np.gender === 'f' ? 'هي' : 'هو';
      return `${subj} ${is} ${np.text} ${attachBi(w, list)}`;
    },
  },

  /** "X is a <NP>." → «X هي <NP>.» */
  {
    id: 'is-a',
    re: /^(.+?)\s+is\s+(?:an?|the)\s+(.+)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const np = resolveNoun(m[2], ctx);
      if (!subj || !np) return null;
      if (ctx.lang !== 'ar') return `${subj} ${np.text}ە`;
      if (!np.gender) return null;
      return `${subj} ${np.gender === 'f' ? 'هي' : 'هو'} ${np.text}`;
    },
  },

  /** "X features <list>." / "X offers <list>." → «يوفّر X <list>.» */
  {
    id: 'features',
    re: /^(.+?)\s+(?:features|offers|provides|delivers)\s+(.+)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const list = translateNounList(m[2], ctx);
      if (!subj || !list) return null;
      return ctx.lang === 'ar' ? `يوفّر ${subj} ${list}` : `${subj} ${list} پێشکەش دەکات`;
    },
  },

  /** "X includes <list> in the package." → «تتضمّن عبوة X <list>.» */
  {
    id: 'includes-in-package',
    re: /^(?:the\s+)?(.+?)\s+includes\s+(.+?)\s+in\s+the\s+(?:package|box)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const list = translateNounList(m[2], ctx);
      if (!subj || !list) return null;
      return ctx.lang === 'ar' ? `تتضمّن عبوة ${subj} ${list}` : `پاکێتی ${subj} ${list} لەخۆدەگرێت`;
    },
  },

  /** "X includes <list>." → «يتضمّن X <list>.» */
  {
    id: 'includes',
    re: /^(.+?)\s+(?:includes|comes with|ships with)\s+(.+)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const list = translateNounList(m[2], ctx);
      if (!subj || !list) return null;
      return ctx.lang === 'ar' ? `يتضمّن ${subj} ${list}` : `${subj} ${list} لەخۆدەگرێت`;
    },
  },

  /** "<NP> is supported with <NP>." → «<NP> مدعومة عبر <NP>.» */
  {
    id: 'is-supported-with',
    re: /^(.+?)\s+is\s+supported\s+(?:with|via|through)\s+(.+)$/i,
    build: (m, ctx) => {
      const what = resolveNoun(m[1], ctx);
      const via = translateNounList(m[2], ctx) ?? subject(m[2]);
      if (!what || !via) return null;
      if (ctx.lang !== 'ar') return `${what.text} لە ڕێگەی ${via} پشتگیری دەکرێت`;
      if (!what.gender) return null;
      return `${what.text} ${what.gender === 'f' ? 'مدعومة' : 'مدعوم'} عبر ${via}`;
    },
  },

  /** "<NP> is supported." → «<NP> مدعومة.» */
  {
    id: 'is-supported',
    re: /^(.+?)\s+is\s+supported$/i,
    build: (m, ctx) => {
      const what = resolveNoun(m[1], ctx);
      if (!what) return null;
      if (ctx.lang !== 'ar') return `${what.text} پشتگیری دەکرێت`;
      if (!what.gender) return null;
      return `${what.text} ${what.gender === 'f' ? 'مدعومة' : 'مدعوم'}`;
    },
  },

  /** "X supports <list>." → «يدعم X <list>.» */
  {
    id: 'supports',
    re: /^(.+?)\s+supports\s+(.+)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const list = translateNounList(m[2], ctx);
      if (!subj || !list) return null;
      return ctx.lang === 'ar' ? `يدعم ${subj} ${list}` : `${subj} پشتگیری ${list} دەکات`;
    },
  },

  /** "X comes in <list>." → «يتوفّر X بـ<list>.» */
  {
    id: 'comes-in',
    re: /^(.+?)\s+(?:comes|is available)\s+in\s+(.+)$/i,
    build: (m, ctx) => {
      const subj = subject(m[1]);
      const list = translateNounList(m[2], ctx);
      if (!subj || !list) return null;
      return ctx.lang === 'ar' ? `يتوفّر ${subj} ${attachBi('ب', list)}` : `${subj} بە ${list} بەردەستە`;
    },
  },

  /**
   * "Compatible with <list>." — a very common standalone spec line, with no
   * subject at all.
   */
  {
    id: 'compatible-with',
    re: /^compatible\s+with\s+(.+)$/i,
    build: (m, ctx) => {
      const list = translateNounList(m[1], ctx);
      if (!list) return null;
      return ctx.lang === 'ar' ? `متوافق مع ${list}` : `گونجاوە لەگەڵ ${list}`;
    },
  },

  /** "Designed for <list>." → «مصمّم لـ<list>.» */
  {
    id: 'designed-for',
    re: /^(?:designed|built|made)\s+for\s+(.+)$/i,
    build: (m, ctx) => {
      const list = translateNounList(m[1], ctx);
      if (!list) return null;
      return ctx.lang === 'ar' ? `مصمّم ${attachBi('ل', list)}` : `بۆ ${list} دروستکراوە`;
    },
  },
];

/**
 * THE ENTRY POINT index.ts CALLS.
 *
 * Tries each frame in order and returns the first that resolves COMPLETELY.
 * A frame whose regex matches but whose holes do not resolve is abandoned and
 * the next frame is tried — a partial match must never leak a partial
 * translation.
 */
export function translateSentence(seg: string, ctx: GrammarContext): string | null {
  const body = seg.trim();
  if (!body) return null;
  // A sentence needs a verb or a recognised opening; a bare noun phrase is
  // R4's job and is handled before this rule is reached.
  for (const frame of FRAMES) {
    const m = body.match(frame.re);
    if (!m) continue;
    const out = frame.build(m, ctx);
    if (out !== null) return out;
  }
  // Not a frame, but possibly a coordinated noun phrase standing alone:
  // "Auto calibration, filament runout sensor and Wi-Fi connectivity".
  if (/[,&]|\s(?:and|or)\s/i.test(body)) {
    const list = translateNounList(body, ctx);
    if (list !== null) return list;
  }
  // Or a single noun phrase. SPEC FIELD NAMES are exactly this shape —
  // "Chassis", "Heated build plate", "Hardened steel nozzle" — and they are
  // most of what the admin's translation sheet actually contains. R4 only sees
  // the flat PHRASES table; this reaches the richer noun table too, with its
  // measurement and adjective composition.
  return translateNounPhrase(body, ctx);
}

/** Exposed for the dictionary-coverage test, which asserts every recorded
 *  adjective has both genders and every noun a frame can head has a gender. */
export const GRAMMAR_TABLES = { NOUN_PHRASES, ADJECTIVES } as const;
