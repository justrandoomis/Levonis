/**
 * THE WORDS OF THE COMMUNITY DEMO SET (worker/lib/communityDemo.ts writes
 * them). Iraqi makers, workshops and customers in Arabic, English and Sorani
 * — each account writes in its own language — and the project ideas, comments
 * and print requests they are built from. Pure data: no id, no date and no
 * picture is decided here.
 */

export type DemoLang = 'ar' | 'en' | 'ku';
export type Tri = { ar: string; en: string; ku: string };

export interface DemoPerson {
  name: string;
  handle: string;
  locale: DemoLang;
  gov: string;
  bio: string;
}

/** 25 makers (the first 15 run a workshop each), then 15 customers. */
export const DEMO_PEOPLE: DemoPerson[] = [
  { name: 'نور الهدى', handle: 'noor_prints', locale: 'ar', gov: 'baghdad', bio: 'أطبع قطعًا عملية للبيت والسيارة من ورشتي في الكرادة.' },
  { name: 'Karwan Aziz', handle: 'karwan3d', locale: 'ku', gov: 'erbil', bio: 'دیزاینەر و چاپکەری سێ ڕەهەندی لە هەولێر. مۆدێلی بیناسازی و دیاری.' },
  { name: 'مصطفى الساعدي', handle: 'mustafa_basra', locale: 'ar', gov: 'basra', bio: 'قطع غيار ومستلزمات صيانة من البصرة. أحب المواد المقاومة للحرارة.' },
  { name: 'Yasir Al-Mosuli', handle: 'yasir_mosul', locale: 'en', gov: 'nineveh', bio: 'Rebuilding Mosul one part at a time — brackets, gears and replicas.' },
  { name: 'علي النجفي', handle: 'ali_najaf', locale: 'ar', gov: 'najaf', bio: 'مجسمات تراثية ونماذج تعليمية للمدارس.' },
  { name: 'حيدر الكربلائي', handle: 'haider_krb', locale: 'ar', gov: 'karbala', bio: 'لافتات وأحرف بارزة ومجسمات للمحلات.' },
  { name: 'هێڤی عومەر', handle: 'hevi_designs', locale: 'ku', gov: 'sulaymaniyah', bio: 'چاپی ڕێزن و پەیکەری بچووک لە سلێمانی.' },
  { name: 'Dilan Haji', handle: 'dilan_duhok', locale: 'ku', gov: 'duhok', bio: 'یاری و بووکەڵە و دیاری منداڵان، چاپکراو لە دهۆک.' },
  { name: 'Omar Kirkuki', handle: 'omar_kirkuk', locale: 'en', gov: 'kirkuk', bio: 'Industrial parts and jigs for workshops around Kirkuk.' },
  { name: 'زينب الحسيني', handle: 'zainab_studio', locale: 'ar', gov: 'baghdad', bio: 'ديكور منزلي ومزهريات وإضاءة بطابع عراقي.' },
  { name: 'Ahmed Faris', handle: 'ahmed_makes', locale: 'en', gov: 'baghdad', bio: 'Cosplay props, helmets and anything with LEDs.' },
  { name: 'ڕێبوار جەلال', handle: 'rebwar_3d', locale: 'ku', gov: 'erbil', bio: 'پارچەی ئۆتۆمبێل و ئامێری ناوماڵ بە PETG و ASA.' },
  { name: 'سجاد البصري', handle: 'sajjad_bsr', locale: 'ar', gov: 'basra', bio: 'نماذج سفن وقوارب ومجسمات لشط العرب.' },
  { name: 'Lana Kamal', handle: 'lana_suli', locale: 'en', gov: 'sulaymaniyah', bio: 'Jewellery, earrings and tiny resin things.' },
  { name: 'محمد الموصلي', handle: 'mohammed_mosul', locale: 'ar', gov: 'nineveh', bio: 'ترميم المجسمات الأثرية ونسخ القطع التراثية.' },
  { name: 'Sara Hameed', handle: 'sara_makes', locale: 'en', gov: 'baghdad', bio: 'Hobby maker. Lamps, desk things and the odd planter.' },
  { name: 'نەسرین ئەحمەد', handle: 'nasrin_prints', locale: 'ku', gov: 'erbil', bio: 'دیاری و ڕازاندنەوەی ماڵ بە PLA ی ئاوریشمی.' },
  { name: 'حسن العبيدي', handle: 'hasan_obaidi', locale: 'ar', gov: 'baghdad', bio: 'طالب هندسة، أطبع نماذج مشاريع التخرج.' },
  { name: 'Mina Yousif', handle: 'mina_y', locale: 'en', gov: 'basra', bio: 'Teacher printing classroom models and puzzles.' },
  { name: 'رسول كاظم', handle: 'rasool_k', locale: 'ar', gov: 'najaf', bio: 'هاوٍ للطباعة منذ ٢٠٢٢، أجرب كل خامة جديدة.' },
  { name: 'شیلان مەحمود', handle: 'shilan_m', locale: 'ku', gov: 'sulaymaniyah', bio: 'پەیکەری بچووک و ڕەنگکردنی دەستی.' },
  { name: 'Hussein Talib', handle: 'hussein_t', locale: 'en', gov: 'karbala', bio: 'Drones, RC cars and everything that moves.' },
  { name: 'فاطمة الزهراء', handle: 'fatima_z', locale: 'ar', gov: 'baghdad', bio: 'إكسسوارات مطبخ ومنظمات أدراج.' },
  { name: 'Aras Hawrami', handle: 'aras_h', locale: 'ku', gov: 'duhok', bio: 'Mountain-bike parts and outdoor gear.' },
  { name: 'كرار جاسم', handle: 'karrar_j', locale: 'ar', gov: 'kirkuk', bio: 'قطع ألعاب الفيديو وحوامل اليد.' },
  // ---- customers
  { name: 'زينب كريم', handle: 'zainab_k', locale: 'ar', gov: 'baghdad', bio: '' },
  { name: 'Ahmed Jabbar', handle: 'ahmed_j', locale: 'en', gov: 'basra', bio: '' },
  { name: 'ڕێژنە ئەحمەد', handle: 'rezhna_a', locale: 'ku', gov: 'erbil', bio: '' },
  { name: 'حسين علي', handle: 'hussein_ali', locale: 'ar', gov: 'karbala', bio: '' },
  { name: 'مريم عادل', handle: 'maryam_adel', locale: 'ar', gov: 'nineveh', bio: '' },
  { name: 'Bryar Salih', handle: 'bryar_s', locale: 'ku', gov: 'sulaymaniyah', bio: '' },
  { name: 'Noor Abbas', handle: 'noor_abbas', locale: 'en', gov: 'najaf', bio: '' },
  { name: 'عباس فاضل', handle: 'abbas_f', locale: 'ar', gov: 'basra', bio: '' },
  { name: 'هاوژین کەریم', handle: 'hawzhin_k', locale: 'ku', gov: 'duhok', bio: '' },
  { name: 'Layla Hassan', handle: 'layla_h', locale: 'en', gov: 'baghdad', bio: '' },
  { name: 'علي رضا', handle: 'ali_ridha', locale: 'ar', gov: 'kirkuk', bio: '' },
  { name: 'دانيا سمير', handle: 'dania_s', locale: 'ar', gov: 'baghdad', bio: '' },
  { name: 'Shvan Omer', handle: 'shvan_o', locale: 'ku', gov: 'erbil', bio: '' },
  { name: 'Yusuf Kareem', handle: 'yusuf_k', locale: 'en', gov: 'basra', bio: '' },
  { name: 'رقية مهدي', handle: 'ruqaya_m', locale: 'ar', gov: 'najaf', bio: '' },
];
export const DEMO_MAKER_COUNT = 25;

export interface DemoPrinter {
  brand: string;
  model: string;
  tech: 'fdm' | 'resin';
  x: number;
  y: number;
  z: number;
  materials: string[];
  enclosed: boolean;
}

export const DEMO_PRINTERS: DemoPrinter[] = [
  { brand: 'Bambu Lab', model: 'P1S', tech: 'fdm', x: 256, y: 256, z: 256, materials: ['pla', 'petg', 'abs'], enclosed: true },
  { brand: 'Bambu Lab', model: 'X1 Carbon', tech: 'fdm', x: 256, y: 256, z: 256, materials: ['pla', 'petg', 'abs', 'asa', 'pa_cf'], enclosed: true },
  { brand: 'Bambu Lab', model: 'A1', tech: 'fdm', x: 256, y: 256, z: 256, materials: ['pla', 'petg'], enclosed: false },
  { brand: 'Prusa', model: 'MK4', tech: 'fdm', x: 250, y: 210, z: 220, materials: ['pla', 'petg'], enclosed: false },
  { brand: 'Creality', model: 'K1 Max', tech: 'fdm', x: 300, y: 300, z: 300, materials: ['pla', 'petg', 'abs', 'asa'], enclosed: true },
  { brand: 'Creality', model: 'Ender 3 V3', tech: 'fdm', x: 220, y: 220, z: 250, materials: ['pla', 'petg', 'tpu'], enclosed: false },
  { brand: 'Elegoo', model: 'Saturn 3', tech: 'resin', x: 218, y: 123, z: 250, materials: ['resin'], enclosed: true },
  { brand: 'Anycubic', model: 'Kobra 2', tech: 'fdm', x: 250, y: 220, z: 220, materials: ['pla', 'petg'], enclosed: false },
  { brand: 'Anycubic', model: 'Photon Mono X', tech: 'resin', x: 192, y: 120, z: 245, materials: ['resin'], enclosed: true },
];

export interface DemoShop {
  /** Index into DEMO_PEOPLE (1-based) of the owner. */
  owner: number;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  gov: string;
  areas: string[];
  delivery: string[];
  turnaround: number;
  accent: 'default' | 'olive' | 'gold' | 'slate' | 'plum' | 'teal' | 'blue';
  categories: string[];
  printers: number[];
  facts: Array<{ icon: string; title: string; subtitle: string }>;
  rating: number;
  ratings: number;
  jobs: number;
  verified: boolean;
}

export const DEMO_SHOPS: DemoShop[] = [
  { owner: 1, name: 'ورشة نور للطباعة', slug: 'demo-noor-prints', gov: 'baghdad', areas: ['baghdad', 'babil'], delivery: ['delivery', 'pickup'], turnaround: 4, accent: 'gold', categories: ['home', 'car', 'gifts'], printers: [0, 1],
    tagline: 'طباعة ثلاثية الأبعاد عملية — الكرادة، بغداد', description: 'ورشة صغيرة في الكرادة. قطع للبيت والسيارة، نماذج تخرج، وطلبات خاصة بـ PLA وPETG.',
    facts: [{ icon: 'printer', title: 'طابعتان مغلقتان', subtitle: 'Bambu Lab P1S و X1C' }, { icon: 'truck', title: 'توصيل داخل بغداد', subtitle: 'خلال يومين من الانتهاء' }, { icon: 'clock', title: '٤ أيام', subtitle: 'متوسط مدة التنفيذ' }], rating: 485, ratings: 64, jobs: 212, verified: true },
  { owner: 2, name: 'کارگەی کاروان', slug: 'demo-karwan-3d', gov: 'erbil', areas: ['erbil', 'duhok'], delivery: ['pickup'], turnaround: 5, accent: 'slate', categories: ['architecture', 'gifts'], printers: [3],
    tagline: 'مۆدێلی بیناسازی و دیاری — هەولێر', description: 'مۆدێلی بیناسازی، دیاری و کلیلی ناو، چاپکراو لە هەولێر. وەرگرتن لە کارگە.',
    facts: [{ icon: 'layers', title: 'مۆدێلی گەورە', subtitle: 'تا ٣٦ سم' }, { icon: 'map-pin', title: 'وەرگرتن', subtitle: 'شەقامی ٦٠ مەتری' }, { icon: 'award', title: 'Prusa MK4', subtitle: 'وردی بەرز' }], rating: 470, ratings: 38, jobs: 140, verified: true },
  { owner: 3, name: 'بصرة ميكر', slug: 'demo-basra-maker', gov: 'basra', areas: ['basra', 'maysan', 'dhi_qar'], delivery: ['delivery', 'pickup'], turnaround: 3, accent: 'teal', categories: ['spare_parts', 'functional'], printers: [4],
    tagline: 'قطع غيار ومواد تتحمل حر البصرة', description: 'نطبع بـ ASA وPETG للقطع التي تعيش في الشمس والحرارة: مكيفات، أجهزة منزلية، سيارات.',
    facts: [{ icon: 'shield', title: 'ASA مقاوم للشمس', subtitle: 'للقطع الخارجية' }, { icon: 'truck', title: 'توصيل', subtitle: 'البصرة وميسان وذي قار' }, { icon: 'zap', title: '٣ أيام', subtitle: 'تنفيذ سريع' }], rating: 455, ratings: 51, jobs: 188, verified: false },
  { owner: 4, name: 'Mosul Rebuild Lab', slug: 'demo-mosul-lab', gov: 'nineveh', areas: ['nineveh', 'duhok'], delivery: ['delivery', 'pickup'], turnaround: 6, accent: 'olive', categories: ['functional', 'replicas'], printers: [1, 5],
    tagline: 'Parts, jigs and heritage replicas from Mosul', description: 'Functional parts for workshops and homes, and careful replicas of Mosul heritage pieces for schools and museums.',
    facts: [{ icon: 'hammer', title: 'Engineering parts', subtitle: 'PA-CF and PETG' }, { icon: 'award', title: 'Museum replicas', subtitle: 'Scanned originals' }, { icon: 'truck', title: 'Delivery', subtitle: 'Nineveh and Duhok' }], rating: 492, ratings: 27, jobs: 96, verified: true },
  { owner: 5, name: 'مجسمات النجف', slug: 'demo-najaf-models', gov: 'najaf', areas: ['najaf', 'karbala', 'babil'], delivery: ['delivery'], turnaround: 7, accent: 'plum', categories: ['education', 'heritage'], printers: [7, 8],
    tagline: 'نماذج تعليمية ومجسمات تراثية', description: 'نماذج للمدارس والجامعات: بوابة عشتار، الزقورة، المجموعة الشمسية، وأعضاء جسم الإنسان.',
    facts: [{ icon: 'layers', title: 'FDM وريزن', subtitle: 'حسب الدقة المطلوبة' }, { icon: 'star', title: 'خصم للمدارس', subtitle: 'على الطلبات الكبيرة' }, { icon: 'truck', title: 'توصيل', subtitle: 'النجف وكربلاء وبابل' }], rating: 478, ratings: 44, jobs: 130, verified: false },
  { owner: 6, name: 'حروف كربلاء', slug: 'demo-karbala-signs', gov: 'karbala', areas: ['karbala', 'najaf'], delivery: ['delivery', 'pickup'], turnaround: 5, accent: 'blue', categories: ['signage', 'business'], printers: [4, 2],
    tagline: 'لافتات وأحرف بارزة للمحلات', description: 'أحرف بارزة، لافتات مضيئة، وحوامل منيو للمطاعم والمقاهي بأي لون.',
    facts: [{ icon: 'zap', title: 'إضاءة LED', subtitle: 'مدمجة في الأحرف' }, { icon: 'package', title: 'تركيب', subtitle: 'داخل كربلاء' }, { icon: 'clock', title: '٥ أيام', subtitle: 'للافتة كاملة' }], rating: 461, ratings: 33, jobs: 87, verified: false },
  { owner: 7, name: 'ڕێزنی سلێمانی', slug: 'demo-suli-resin', gov: 'sulaymaniyah', areas: ['sulaymaniyah', 'kirkuk'], delivery: ['delivery', 'pickup'], turnaround: 4, accent: 'plum', categories: ['miniatures', 'jewellery'], printers: [6],
    tagline: 'پەیکەری بچووک و زێڕینگەری بە ڕێزن', description: 'پەیکەری بچووکی یاری، ئەڵقە و گوارە، و ڕەنگکردنی دەستی لە سلێمانی.',
    facts: [{ icon: 'star', title: 'وردی ٠.٠٥ ملم', subtitle: 'Elegoo Saturn 3' }, { icon: 'award', title: 'ڕەنگکردنی دەستی', subtitle: 'بە داواکاری' }, { icon: 'truck', title: 'گەیاندن', subtitle: 'سلێمانی و کەرکووک' }], rating: 496, ratings: 58, jobs: 175, verified: true },
  { owner: 8, name: 'یاری دهۆک', slug: 'demo-duhok-toys', gov: 'duhok', areas: ['duhok', 'erbil'], delivery: ['delivery'], turnaround: 3, accent: 'gold', categories: ['toys', 'education'], printers: [2, 5],
    tagline: 'یاری و بووکەڵەی منداڵان', description: 'یاری جوڵاو، مەتەڵ و بووکەڵەی چاپکراو بە PLA ی سەلامەت بۆ منداڵان.',
    facts: [{ icon: 'shield', title: 'PLA ی سەلامەت', subtitle: 'بۆ منداڵان' }, { icon: 'package', title: 'دیاری', subtitle: 'پێچانەوەی جوان' }, { icon: 'truck', title: 'گەیاندن', subtitle: 'دهۆک و هەولێر' }], rating: 474, ratings: 22, jobs: 64, verified: false },
  { owner: 9, name: 'Kirkuk Jigs & Parts', slug: 'demo-kirkuk-jigs', gov: 'kirkuk', areas: ['kirkuk', 'salahuddin'], delivery: ['delivery', 'pickup'], turnaround: 4, accent: 'slate', categories: ['industrial', 'spare_parts'], printers: [1, 4],
    tagline: 'Industrial jigs, fixtures and spare parts', description: 'Jigs and fixtures for oil-field workshops, replacement knobs and housings, printed in tough materials.',
    facts: [{ icon: 'hammer', title: 'Tough materials', subtitle: 'ASA, PA-CF, PETG' }, { icon: 'clock', title: '4 days', subtitle: 'Typical turnaround' }, { icon: 'truck', title: 'Delivery', subtitle: 'Kirkuk and Salah Al-Din' }], rating: 468, ratings: 19, jobs: 71, verified: false },
  { owner: 10, name: 'ستوديو زينب', slug: 'demo-zainab-studio', gov: 'baghdad', areas: ['baghdad'], delivery: ['delivery', 'pickup'], turnaround: 5, accent: 'olive', categories: ['decor', 'lighting'], printers: [2],
    tagline: 'ديكور منزلي بطابع عراقي', description: 'مزهريات، أباجورات، وزخارف إسلامية مطبوعة، تصميم خاص لكل بيت.',
    facts: [{ icon: 'star', title: 'تصاميم أصلية', subtitle: 'زخارف عراقية' }, { icon: 'zap', title: 'إضاءة', subtitle: 'أباجورات مطبوعة' }, { icon: 'map-pin', title: 'المنصور', subtitle: 'استلام من الاستوديو' }], rating: 488, ratings: 41, jobs: 122, verified: true },
  { owner: 11, name: 'Baghdad Prop Shop', slug: 'demo-baghdad-props', gov: 'baghdad', areas: ['baghdad', 'diyala'], delivery: ['delivery'], turnaround: 8, accent: 'blue', categories: ['cosplay', 'props'], printers: [4, 1],
    tagline: 'Cosplay, helmets and film props', description: 'Full-size helmets, armour and props, sanded and painted, with LED kits on request.',
    facts: [{ icon: 'zap', title: 'LED kits', subtitle: 'Wired and tested' }, { icon: 'award', title: 'Painted finish', subtitle: 'Primer to clear coat' }, { icon: 'clock', title: '8 days', subtitle: 'For a full helmet' }], rating: 481, ratings: 29, jobs: 58, verified: false },
  { owner: 12, name: 'پارچەی ڕێبوار', slug: 'demo-rebwar-parts', gov: 'erbil', areas: ['erbil', 'sulaymaniyah'], delivery: ['delivery', 'pickup'], turnaround: 3, accent: 'teal', categories: ['car', 'spare_parts'], printers: [0, 4],
    tagline: 'پارچەی ئۆتۆمبێل و ئامێری ناوماڵ', description: 'پارچەی ناوەوەی ئۆتۆمبێل، دوگمە و قاپاغ، بە PETG و ASA کە بەرگەی گەرما دەگرێت.',
    facts: [{ icon: 'shield', title: 'ASA', subtitle: 'بەرگەی خۆر دەگرێت' }, { icon: 'zap', title: '٣ ڕۆژ', subtitle: 'جێبەجێکردنی خێرا' }, { icon: 'truck', title: 'گەیاندن', subtitle: 'هەولێر و سلێمانی' }], rating: 459, ratings: 36, jobs: 109, verified: false },
  { owner: 13, name: 'سفن شط العرب', slug: 'demo-shatt-models', gov: 'basra', areas: ['basra'], delivery: ['pickup'], turnaround: 9, accent: 'default', categories: ['models', 'heritage'], printers: [3, 6],
    tagline: 'نماذج سفن ومشاحيف وقوارب', description: 'مجسمات دقيقة للمشحوف والبلم والسفن التاريخية، للهدايا والمتاحف.',
    facts: [{ icon: 'award', title: 'دقة عالية', subtitle: 'ريزن وPLA' }, { icon: 'map-pin', title: 'العشار', subtitle: 'استلام من الورشة' }, { icon: 'star', title: 'هدايا رسمية', subtitle: 'مع قاعدة خشبية' }], rating: 490, ratings: 17, jobs: 45, verified: false },
  { owner: 14, name: 'Lana Tiny Things', slug: 'demo-lana-tiny', gov: 'sulaymaniyah', areas: ['sulaymaniyah'], delivery: ['delivery'], turnaround: 4, accent: 'plum', categories: ['jewellery', 'gifts'], printers: [6],
    tagline: 'Resin jewellery and tiny gifts', description: 'Earrings, rings and pendants in tough resin, hand-finished and gift-wrapped in Sulaymaniyah.',
    facts: [{ icon: 'star', title: 'Hand-finished', subtitle: 'Every piece' }, { icon: 'package', title: 'Gift-wrapped', subtitle: 'Ready to give' }, { icon: 'truck', title: 'Delivery', subtitle: 'Across Sulaymaniyah' }], rating: 494, ratings: 48, jobs: 160, verified: true },
  { owner: 15, name: 'تراث الموصل', slug: 'demo-mosul-heritage', gov: 'nineveh', areas: ['nineveh'], delivery: ['delivery', 'pickup'], turnaround: 10, accent: 'gold', categories: ['heritage', 'replicas'], printers: [8, 3],
    tagline: 'نسخ مطبوعة من القطع الأثرية', description: 'نسخ دقيقة من الثور المجنح والمنارة الحدباء وقطع متحف الموصل، للمدارس والهدايا.',
    facts: [{ icon: 'award', title: 'مسح ثلاثي الأبعاد', subtitle: 'من القطع الأصلية' }, { icon: 'layers', title: 'ريزن وPLA', subtitle: 'حسب الحجم' }, { icon: 'map-pin', title: 'الموصل', subtitle: 'الجانب الأيسر' }], rating: 483, ratings: 24, jobs: 52, verified: false },
];

export type PostKindDemo = 'project' | 'post' | 'tutorial' | 'timelapse' | 'before_after';

export interface DemoIdea {
  kind: PostKindDemo;
  title: Tri;
  body: Tri;
  material: string;
  color: Tri;
  minutes: number | null;
  tags: string[];
  dims?: Record<string, number>;
}

const t = (ar: string, en: string, ku: string): Tri => ({ ar, en, ku });

export const DEMO_IDEAS: DemoIdea[] = [
  { kind: 'project', title: t('حامل هاتف للسيارة يتحمل حرارة الصيف', 'Car phone mount that survives the summer', 'هەڵگری مۆبایل بۆ ئۆتۆمبێل کە بەرگەی هاوین دەگرێت'), body: t('صممته بعد أن ذاب حامل PLA على الزجاج في تموز. PETG أسود، جدران 4، وحشوة 30٪.', 'Designed after a PLA mount melted on the windscreen in July. Black PETG, 4 walls, 30% infill.', 'دوای ئەوەی هەڵگرێکی PLA لە تەممووزدا توایەوە دیزاینم کرد. PETG ی ڕەش، ٤ دیوار.'), material: 'PETG', color: t('أسود', 'Black', 'ڕەش'), minutes: 95, tags: ['car', 'petg', 'functional'], dims: { x: 80, y: 60, z: 45 } },
  { kind: 'tutorial', title: t('كيف تمنع الالتواء في صيف بغداد', 'Stopping warping in a Baghdad summer', 'چۆن ڕێگری لە چەمانەوە بکەین لە هاویندا'), body: t('١) نظّف السطح بالكحول. ٢) أطفئ المروحة في أول طبقتين. ٣) استعمل حافة 5 ملم للقطع الطويلة.', '1) Clean the plate with alcohol. 2) Fan off for the first two layers. 3) A 5 mm brim on long parts.', '١) ڕووەکە بە ئەلکهول پاک بکەرەوە. ٢) پانکە بکوژێنەوە بۆ دوو چینی یەکەم. ٣) لێواری ٥ ملم.'), material: 'ABS', color: t('', '', ''), minutes: null, tags: ['tips', 'warping', 'abs'] },
  { kind: 'project', title: t('مجسم قلعة أربيل', 'A model of Erbil Citadel', 'مۆدێلی قەڵای هەولێر'), body: t('مجسم صغير لقلعة أربيل بـ PLA ذهبي حريري، طُبع في أربع قطع وجُمع.', 'A small Erbil Citadel in gold silk PLA, printed in four parts and glued.', 'مۆدێلێکی بچووکی قەڵای هەولێر بە PLA ی زێڕینی ئاوریشمی، لە چوار پارچە.'), material: 'PLA Silk', color: t('ذهبي', 'Gold', 'زێڕین'), minutes: 720, tags: ['erbil', 'architecture', 'pla'], dims: { x: 200, y: 200, z: 90 } },
  { kind: 'timelapse', title: t('تايم لابس: مزهرية 30 سم بوضع الفازة', 'Timelapse: a 30 cm vase in vase mode', 'تایملاپس: گوڵدانێکی ٣٠ سم'), body: t('جدار واحد، فوهة 0.6، PLA مطفي. سبع ساعات في ثلاثين ثانية.', 'Single wall, 0.6 mm nozzle, matte PLA. Seven hours in thirty seconds.', 'یەک دیوار، نۆزڵی ٠.٦، PLA ی ماتە. حەوت کاتژمێر لە سی چرکەدا.'), material: 'PLA Matte', color: t('تيراكوتا', 'Terracotta', 'تێراکۆتا'), minutes: 410, tags: ['vase', 'timelapse', 'pla'], dims: { x: 140, y: 140, z: 300 } },
  { kind: 'before_after', title: t('قبل وبعد: مقبض باب مكسور منذ سنتين', 'Before/after: a door handle broken for two years', 'پێش و دوای: دەسکی دەرگایەکی شکاو'), body: t('قست المقبض القديم بالكاليبر ورسمته من جديد. الجديد من PETG ويتحمل أكثر من الأصلي.', 'Measured the old handle with calipers and redrew it. The PETG one is stronger than the original.', 'دەسکە کۆنەکەم پێوا و دووبارە کێشامەوە. ئەوەی PETG بەهێزترە.'), material: 'PETG', color: t('رمادي', 'Grey', 'خۆڵەمێشی'), minutes: 60, tags: ['repair', 'petg', 'home'] },
  { kind: 'project', title: t('مروحة بديلة لمكيف سبليت', 'Replacement fan for a split AC', 'پانکەی جێگرەوە بۆ سپلیت'), body: t('المروحة الأصلية غير متوفرة في السوق. طبعتها بـ ASA ووازنتها قبل التركيب.', 'The original is not in the market. Printed in ASA and balanced before fitting.', 'ئەسڵەکەی لە بازاڕ نییە. بە ASA چاپم کرد و پێش دانان هاوسەنگم کرد.'), material: 'ASA', color: t('أبيض', 'White', 'سپی'), minutes: 180, tags: ['repair', 'asa', 'ac'], dims: { x: 160, y: 160, z: 40 } },
  { kind: 'project', title: t('فانوس رمضان بإضاءة LED', 'Ramadan fanous with an LED light', 'فانۆسی ڕەمەزان بە ڕووناکی LED'), body: t('الإطار PLA أبيض والألواح شفافة. شمعة LED بالبطارية تدخل في الوسط.', 'White PLA frame, translucent panels. A battery tea light fits inside.', 'چوارچێوەی PLA ی سپی و پانێڵی ڕوون. مۆمێکی LED لە ناوەڕاستدا.'), material: 'PLA', color: t('أبيض وشفاف', 'White + translucent', 'سپی و ڕوون'), minutes: 300, tags: ['ramadan', 'lamp', 'pla'], dims: { x: 120, y: 120, z: 220 } },
  { kind: 'tutorial', title: t('معايرة التدفق في عشر دقائق', 'Calibrating flow rate in ten minutes', 'ڕێکخستنی ڕێژەی ڕۆیشتن لە دە خولەکدا'), body: t('اطبع مكعبًا بجدار واحد، قس الجدار في أربعة أماكن، ثم التدفق = القديم × الهدف ÷ المقاس.', 'Print a single-wall cube, measure in four places, then flow = old × target / measured.', 'مکعەبێکی یەک دیوار چاپ بکە، لە چوار شوێن بیپێوە، پاشان ڕێژە = کۆن × ئامانج ÷ پێوراو.'), material: 'PLA', color: t('', '', ''), minutes: 15, tags: ['calibration', 'tips'] },
  { kind: 'project', title: t('ميدالية بنقشة كردية تقليدية', 'Keychain with a traditional Kurdish pattern', 'جاکلیتی کوردی بە نەخشی تەقلیدی'), body: t('نقشة الكلاو الكردي على ميدالية، ثلاثة ألوان بتبديل الخيط.', 'The Kurdish klaw pattern on a keychain, three colours by filament swap.', 'نەخشی کڵاوی کوردی لەسەر جاکلیت. سێ ڕەنگ بە گۆڕینی فیلامێنت.'), material: 'PLA', color: t('أحمر وأخضر', 'Red and green', 'سوور و سەوز'), minutes: 240, tags: ['kurdish', 'keychain', 'pla'] },
  { kind: 'timelapse', title: t('تايم لابس: تمثال صغير بالريزن', 'Timelapse: a small resin figure', 'تایملاپسی پەیکەرێکی بچووک بە ڕێزن'), body: t('تمثال 12 سم بطبقات 0.05 ملم. ست ساعات وعشرون دقيقة.', 'A 12 cm figure at 0.05 mm layers. Six hours twenty.', 'پەیکەری ١٢ سم، چینی ٠.٠٥ ملم. شەش کاتژمێر و بیست خولەک.'), material: 'Resin', color: t('رمادي', 'Grey', 'خۆڵەمێشی'), minutes: 380, tags: ['resin', 'miniature', 'timelapse'] },
  { kind: 'project', title: t('مجسم مصغر لبوابة عشتار', 'A miniature Ishtar Gate', 'مۆدێلی بچووکی دەروازەی ئیشتار'), body: t('نموذج تعليمي لمدرسة: البوابة بثلاث قطع والحيوانات مطبوعة بارزة.', 'A school model: the gate in three parts, the animals printed in relief.', 'مۆدێلی فێرکاری بۆ قوتابخانە: دەروازەکە لە سێ پارچە.'), material: 'PLA', color: t('أزرق', 'Blue', 'شین'), minutes: 900, tags: ['babylon', 'education', 'pla'], dims: { x: 250, y: 80, z: 180 } },
  { kind: 'before_after', title: t('قبل وبعد: صنفرة وتلوين تمثال ريزن', 'Before/after: sanding and painting a resin bust', 'پێش و دوای: ڕەنگکردنی پەیکەرێکی ڕێزن'), body: t('من الطابعة مباشرة، ثم برايمر وطبقتان وفرشاة جافة.', 'Straight off the printer, then primer, two coats and a dry brush.', 'ڕاستەوخۆ لە چاپکەرەوە، پاشان پرایمەر و دوو چین ڕەنگ.'), material: 'Resin', color: t('ملون', 'Painted', 'ڕەنگکراو'), minutes: 260, tags: ['resin', 'painting', 'bust'] },
  { kind: 'project', title: t('منظم أدوات مكتبي قابل للتركيب', 'A modular desk organiser', 'ڕێکخەری مێزی پارچە پارچە'), body: t('وحدات صغيرة تتعشق مع بعض. اطبع ما تحتاج فقط.', 'Small units that lock together. Print only what you need.', 'یەکەی بچووک کە بە یەکەوە دەلکێن. تەنها ئەوەی پێویستتە چاپی بکە.'), material: 'PLA', color: t('بيج', 'Beige', 'بێژ'), minutes: 150, tags: ['desk', 'organizer', 'pla'] },
  { kind: 'tutorial', title: t('تجفيف الخيوط في الشتاء', 'Drying filament in winter', 'چۆن فیلامێنت وشک بکەینەوە لە زستاندا'), body: t('PETG والنايلون يمتصان الرطوبة. 65 درجة لأربع ساعات، ثم علبة محكمة مع سيليكا.', 'PETG and nylon soak up moisture. 65 °C for four hours, then a sealed box with silica.', 'PETG و نایلۆن شێ هەڵدەمژن. ٦٥ پلە بۆ چوار کاتژمێر، پاشان قوتووی داخراو.'), material: 'PETG', color: t('', '', ''), minutes: null, tags: ['tips', 'filament', 'petg'] },
  { kind: 'project', title: t('ميداليات بأسماء لتخرج مدرسة', 'Name keychains for a school graduation', 'جاکلیتی ناو بۆ دەرچوونی قوتابخانە'), body: t('ستون ميدالية بلونين، كل واحدة باسم طالب. لوحان طوال الليل.', 'Sixty two-colour keychains, each with a student name. Two plates overnight.', 'شەست جاکلیتی دوو ڕەنگ، هەر یەکە بە ناوی قوتابییەک.'), material: 'PLA', color: t('أزرق وأبيض', 'Blue + white', 'شین و سپی'), minutes: 45, tags: ['keychain', 'graduation'] },
  { kind: 'project', title: t('أصيص نباتات بنقش زخرفي', 'A planter with a geometric pattern', 'گوڵدانی ڕووەک بە نەخشی هەندەسی'), body: t('أصيص بفتحة تصريف وصحن منفصل، بنقش مستوحى من الطابوق البغدادي.', 'Drainage hole and a separate saucer, patterned after Baghdadi brickwork.', 'کونی ئاو و دەفرێکی جیا، نەخشەکەی لە خشتی بەغدا وەرگیراوە.'), material: 'PETG', color: t('أخضر زيتوني', 'Olive', 'زەیتونی'), minutes: 330, tags: ['planter', 'home', 'petg'], dims: { x: 150, y: 150, z: 130 } },
  { kind: 'project', title: t('خوذة كوسبلاي كاملة', 'A full cosplay helmet', 'کڵاوی کۆسپلەی تەواو'), body: t('ست قطع، 40 ساعة طباعة، ثم معجون وصنفرة وتلوين بالبخاخ.', 'Six parts, 40 hours of printing, then filler, sanding and spray paint.', 'شەش پارچە، ٤٠ کاتژمێر چاپ، پاشان سمبادە و ڕەنگ.'), material: 'PLA+', color: t('فضي', 'Silver', 'زیوی'), minutes: 2400, tags: ['cosplay', 'helmet', 'props'], dims: { x: 260, y: 300, z: 280 } },
  { kind: 'post', title: t('أول طابعة لي وصلت اليوم!', 'My first printer arrived today!', 'یەکەم چاپکەرم ئەمڕۆ گەیشت!'), body: t('بدأت بالقارب التجريبي ونجح من أول مرة. أي نصائح للمبتدئين؟', 'Started with the test boat and it worked first time. Any tips for a beginner?', 'بە بەلەمی تاقیکردنەوە دەستم پێکرد و یەکەمجار سەرکەوتوو بوو. ئامۆژگاری؟'), material: 'PLA', color: t('برتقالي', 'Orange', 'پرتەقاڵی'), minutes: 35, tags: ['beginner', 'benchy'] },
  { kind: 'project', title: t('تنين مفصلي بلونين', 'A two-colour articulated dragon', 'ئەژدیهای جوڵاوی دوو ڕەنگ'), body: t('يُطبع قطعة واحدة بدون دعامات، 24 مفصلًا يتحرك.', 'Print-in-place, no supports, 24 moving joints.', 'یەک پارچە، بێ پشتگیر، ٢٤ جومگەی جوڵاو.'), material: 'PLA Silk', color: t('بنفسجي وذهبي', 'Purple and gold', 'مۆر و زێڕین'), minutes: 420, tags: ['dragon', 'toy', 'articulated'], dims: { x: 220, y: 120, z: 30 } },
  { kind: 'before_after', title: t('قبل وبعد: غطاء بطارية لجهاز التحكم', 'Before/after: a remote control battery cover', 'پێش و دوای: قاپاغی پاتری ڕیمۆت'), body: t('الغطاء ضاع، فرسمت واحدًا جديدًا في نصف ساعة.', 'The cover was lost; drew a new one in half an hour.', 'قاپاغەکە ون بوو، لە نیو کاتژمێردا یەکێکی نوێم کێشا.'), material: 'PLA', color: t('أسود', 'Black', 'ڕەش'), minutes: 20, tags: ['repair', 'remote'] },
  { kind: 'project', title: t('نموذج الزقورة لمشروع مدرسي', 'A ziggurat model for a school project', 'مۆدێلی زیگۆرات بۆ پڕۆژەی قوتابخانە'), body: t('زقورة أور بمقياس 1:500 مع الدرج الثلاثي.', 'The Ziggurat of Ur at 1:500 with its triple stair.', 'زیگۆراتی ئوور بە پێوانەی ١:٥٠٠.'), material: 'PLA', color: t('رملي', 'Sand', 'لمی'), minutes: 540, tags: ['education', 'ur', 'heritage'] },
  { kind: 'timelapse', title: t('تايم لابس: لوحة اسم بأحرف بارزة', 'Timelapse: a raised-letter name sign', 'تایملاپس: تابلۆی ناو بە پیتی بەرز'), body: t('أحرف عربية بارزة بطول 40 سم، تبديل اللون عند الطبقة 20.', '40 cm Arabic letters, colour change at layer 20.', 'پیتی عەرەبی ٤٠ سم، گۆڕینی ڕەنگ لە چینی ٢٠.'), material: 'PLA', color: t('ذهبي وأسود', 'Gold + black', 'زێڕین و ڕەش'), minutes: 260, tags: ['sign', 'timelapse'] },
  { kind: 'project', title: t('حامل سماعات مكتبي', 'A desk headphone stand', 'هەڵگری گوێگر بۆ مێز'), body: t('قاعدة ثقيلة بحشوة 40٪ وخطاف مطاطي TPU.', 'A heavy 40% infill base with a TPU hook.', 'بنکەیەکی قورس بە ٤٠٪ پڕکردنەوە و قولابی TPU.'), material: 'PETG + TPU', color: t('رمادي داكن', 'Charcoal', 'خۆڵەمێشی تاریک'), minutes: 210, tags: ['desk', 'headphones'] },
  { kind: 'project', title: t('ترس بديل لخلاط مطبخ', 'A replacement gear for a kitchen mixer', 'ددانەی جێگرەوە بۆ تێکەڵکەر'), body: t('الترس الأصلي تآكل. نايلون PA مع تجفيف قبل الطباعة.', 'The original wore out. Nylon PA, dried before printing.', 'ددانە ئەسڵییەکە ساوا. نایلۆنی PA، وشک کرایەوە پێش چاپ.'), material: 'PA', color: t('أبيض', 'White', 'سپی'), minutes: 75, tags: ['repair', 'gear', 'nylon'] },
  { kind: 'tutorial', title: t('طباعة TPU بدون مشاكل', 'Printing TPU without tears', 'چاپکردنی TPU بێ کێشە'), body: t('سرعة 25 ملم/ث، سحب صفر تقريبًا، ولا تشد الخيط من البكرة.', '25 mm/s, almost no retraction, and never let the spool pull.', 'خێرایی ٢٥ ملم/چ، کەمترین گەڕانەوە.'), material: 'TPU', color: t('', '', ''), minutes: null, tags: ['tpu', 'tips'] },
  { kind: 'project', title: t('ساعة حائط بأرقام عربية', 'A wall clock with Arabic numerals', 'کاتژمێری دیوار بە ژمارەی عەرەبی'), body: t('الوجه مطبوع بقطعتين، والآلة من السوق بخمسة آلاف.', 'The face is two prints; the movement cost five thousand at the market.', 'ڕووەکەی دوو پارچەیە، ئامێرەکەی لە بازاڕ.'), material: 'PLA', color: t('أسود وذهبي', 'Black + gold', 'ڕەش و زێڕین'), minutes: 480, tags: ['clock', 'home', 'decor'], dims: { x: 300, y: 300, z: 15 } },
  { kind: 'post', title: t('ما رأيكم بهذا اللون؟', 'What do you think of this colour?', 'ئەم ڕەنگە چۆنە؟'), body: t('خيط حريري جديد بثلاثة ألوان، جربته على مزهرية صغيرة.', 'A new tri-colour silk; tried it on a small vase.', 'فیلامێنتی ئاوریشمی سێ ڕەنگی نوێ، لەسەر گوڵدانێکی بچووک.'), material: 'PLA Silk', color: t('قوس قزح', 'Rainbow', 'کەسکەسۆڵ'), minutes: 120, tags: ['silk', 'color'] },
  { kind: 'project', title: t('مجسم المنارة الحدباء', 'Al-Hadba Minaret model', 'مۆدێلی منارەی حەدبا'), body: t('نسخة بارتفاع 35 سم من منارة الموصل الشهيرة بميلانها.', 'A 35 cm copy of Mosul\'s famous leaning minaret.', 'کۆپییەکی ٣٥ سم لە منارە بەناوبانگەکەی موسڵ.'), material: 'PLA', color: t('طابوقي', 'Brick', 'خشتی'), minutes: 660, tags: ['mosul', 'heritage', 'architecture'] },
  { kind: 'project', title: t('أقراط هندسية من الريزن', 'Geometric resin earrings', 'گوارەی هەندەسی بە ڕێزن'), body: t('زوج أقراط بتصميم هندسي، مطلي بطبقة لامعة.', 'A pair of geometric earrings with a gloss coat.', 'جووتێک گوارەی هەندەسی بە چینێکی بریقەدار.'), material: 'Resin', color: t('وردي', 'Rose', 'پەمەیی'), minutes: 90, tags: ['jewellery', 'resin'] },
  { kind: 'before_after', title: t('قبل وبعد: كرسي أطفال بساق مكسورة', 'Before/after: a child\'s chair with a broken leg', 'پێش و دوای: کورسی منداڵ بە قاچی شکاو'), body: t('طبعت كبسولة تقوية للساق بـ PETG بحشوة 100٪.', 'Printed a reinforcing sleeve for the leg in 100% PETG.', 'پاڵپشتێکم بۆ قاچەکە بە PETG ی ١٠٠٪ چاپ کرد.'), material: 'PETG', color: t('أبيض', 'White', 'سپی'), minutes: 110, tags: ['repair', 'furniture'] },
  { kind: 'project', title: t('لعبة ألغاز خشبية الشكل', 'A wood-look puzzle box', 'سندوقی مەتەڵ بە شێوەی دار'), body: t('خيط بلون الخشب، الصندوق يُفتح بترتيب سري.', 'Wood-fill filament; the box opens in a secret order.', 'فیلامێنتی دارین، سندوقەکە بە ڕیزبەندییەکی نهێنی دەکرێتەوە.'), material: 'PLA Wood', color: t('خشبي', 'Wood', 'دارین'), minutes: 380, tags: ['puzzle', 'toy', 'gift'] },
  { kind: 'timelapse', title: t('تايم لابس: هيكل درون 5 إنش', 'Timelapse: a 5-inch drone frame', 'تایملاپس: چوارچێوەی درۆنی ٥ ئینچ'), body: t('أذرع PA-CF بحشوة 60٪، تتحمل الاصطدامات.', 'PA-CF arms at 60% infill — they survive crashes.', 'قۆڵی PA-CF بە ٦٠٪ پڕکردنەوە.'), material: 'PA-CF', color: t('أسود', 'Black', 'ڕەش'), minutes: 310, tags: ['drone', 'pa-cf', 'fpv'] },
  { kind: 'project', title: t('حامل منيو لمطعم', 'A menu stand for a restaurant', 'هەڵگری مینیو بۆ چێشتخانە'), body: t('عشرون حاملًا بشعار المطعم، طُبعت على ثلاث دفعات.', 'Twenty stands with the restaurant logo, three batches.', 'بیست هەڵگر بە لۆگۆی چێشتخانەکە.'), material: 'PETG', color: t('أسود', 'Black', 'ڕەش'), minutes: 95, tags: ['business', 'restaurant'] },
  { kind: 'project', title: t('مجسم مشحوف من الأهوار', 'A mashoof boat from the marshes', 'بەلەمی مەشحووف لە ئەهوار'), body: t('مشحوف بطول 30 سم مع قصب مطبوع ورجل يجدف.', 'A 30 cm mashoof with printed reeds and a man rowing.', 'مەشحووفێکی ٣٠ سم لەگەڵ قامیش و پیاوێک کە سەوڵ لێدەدات.'), material: 'PLA', color: t('بني', 'Brown', 'قاوەیی'), minutes: 500, tags: ['basra', 'marshes', 'boat'] },
  { kind: 'tutorial', title: t('أفضل إعدادات للطباعة السريعة على P1S', 'Fast-print settings that work on a P1S', 'باشترین ڕێکخستن بۆ چاپی خێرا لە P1S'), body: t('طبقة 0.24، تسارع 10000، وجدران خارجية أبطأ للجودة.', '0.24 mm layers, 10k acceleration, slower outer walls for quality.', 'چینی ٠.٢٤، خێرابوونی ١٠٠٠٠، دیواری دەرەوە هێواشتر.'), material: 'PLA', color: t('', '', ''), minutes: null, tags: ['bambu', 'speed', 'tips'] },
  { kind: 'project', title: t('حامل جدار لدراجة هوائية', 'A wall hook for a mountain bike', 'هەڵواسەری دیوار بۆ پاسکیل'), body: t('يتحمل 15 كغم، طُبع بالعرض لقوة الطبقات.', 'Holds 15 kg; printed on its side for layer strength.', '١٥ کیلۆ هەڵدەگرێت؛ لەسەر لا چاپکراوە.'), material: 'PETG', color: t('برتقالي', 'Orange', 'پرتەقاڵی'), minutes: 140, tags: ['bike', 'petg', 'functional'] },
  { kind: 'project', title: t('مجموعة شطرنج بطابع بابلي', 'A Babylonian-style chess set', 'شەترەنجی بە شێوەی بابلی'), body: t('32 قطعة، الملك على شكل الثور المجنح.', '32 pieces; the king is a winged bull.', '٣٢ پارچە؛ شاکە گای باڵدارە.'), material: 'PLA Silk', color: t('ذهبي وفضي', 'Gold + silver', 'زێڕین و زیوی'), minutes: 1300, tags: ['chess', 'babylon', 'gift'] },
  { kind: 'post', title: t('ورشتي بعد الترتيب الجديد', 'My workshop after the reorganisation', 'کارگەکەم دوای ڕێکخستنی نوێ'), body: t('رفوف للبكرات وصندوق تجفيف وثلاث طابعات على طاولة واحدة.', 'Spool shelves, a dry box and three printers on one bench.', 'ڕەفی فیلامێنت، سندوقی وشککردنەوە و سێ چاپکەر.'), material: 'PLA', color: t('', '', ''), minutes: null, tags: ['workshop', 'setup'] },
  { kind: 'project', title: t('أباجورة ليثوفين بصورة عائلية', 'A lithophane lamp with a family photo', 'چرای لیتۆفەین بە وێنەی خێزانی'), body: t('الصورة تظهر فقط عند الإضاءة. PLA أبيض بطبقة 0.12.', 'The photo only appears when lit. White PLA, 0.12 mm layers.', 'وێنەکە تەنها کاتی ڕووناکی دەردەکەوێت.'), material: 'PLA', color: t('أبيض', 'White', 'سپی'), minutes: 360, tags: ['lithophane', 'lamp', 'gift'] },
  { kind: 'before_after', title: t('قبل وبعد: مقبض درج مطبخ', 'Before/after: a kitchen drawer pull', 'پێش و دوای: دەسکی چەکمەجەی چێشتخانە'), body: t('طبعت ثمانية مقابض متطابقة لتغيير شكل المطبخ كله.', 'Printed eight matching pulls to refresh the whole kitchen.', 'هەشت دەسکی وەک یەکم چاپ کرد.'), material: 'PETG', color: t('ذهبي مطفي', 'Matte gold', 'زێڕینی ماتە'), minutes: 160, tags: ['kitchen', 'home', 'repair'] },
  { kind: 'project', title: t('مجسم الثور المجنح', 'A winged bull (lamassu) replica', 'کۆپی گای باڵدار'), body: t('نسخة 25 سم من اللاماسو بالريزن، مطلية بلون الحجر.', 'A 25 cm resin lamassu painted to look like stone.', 'کۆپییەکی ٢٥ سم لە لاماسو بە ڕێزن.'), material: 'Resin', color: t('حجري', 'Stone', 'بەردین'), minutes: 820, tags: ['assyria', 'heritage', 'resin'] },
];

/** Comments in each language: a reaction, a question, a thank-you. */
export const DEMO_COMMENTS: Record<DemoLang, string[]> = {
  ar: ['شغل نظيف جدًا 👏', 'كم استغرقت الطباعة؟', 'أي خيط استخدمت بالضبط؟', 'رائع! أريد واحدة مثلها.', 'التفاصيل مذهلة.', 'هل تشاركون الملف؟', 'جربتها وطلعت ممتازة، شكرًا.', 'كم سعر هذه تقريبًا؟', 'اللون جميل جدًا.', 'نصيحة ممتازة، وفرت علي وقت كثير.', 'ما إعدادات الدعامات؟', 'تبارك الله، استمر.'],
  en: ['Really clean work 👏', 'How long did it take?', 'Which filament exactly?', 'Love it — I want one.', 'The detail is amazing.', 'Will you share the file?', 'Tried it, came out great. Thanks!', 'What would this cost roughly?', 'Beautiful colour.', 'Great tip, saved me hours.', 'What support settings?', 'Keep them coming!'],
  ku: ['کارێکی زۆر پاکە 👏', 'چەندی خایاند؟', 'کام فیلامێنتت بەکارهێنا؟', 'زۆر جوانە، یەکێکم دەوێت.', 'وردەکارییەکان سەرسوڕهێنەرن.', 'فایلەکە بڵاو دەکەیتەوە؟', 'تاقیم کردەوە، زۆر باش بوو. سوپاس!', 'نرخی نزیکەی چەندە؟', 'ڕەنگەکەی جوانە.', 'ئامۆژگارییەکی باشە.', 'ڕێکخستنی پشتگیر چییە؟', 'بەردەوام بە!'],
};
export const DEMO_REPLIES: Record<DemoLang, string[]> = {
  ar: ['شكرًا لك! حوالي ست ساعات.', 'PETG من النوع العادي، يعمل ممتاز.', 'أكيد، راسلني على الخاص.', 'تسلم، سعيد أنها أعجبتك.'],
  en: ['Thanks! About six hours.', 'Regular PETG, works great.', 'Sure — message me.', 'Glad you like it!'],
  ku: ['سوپاس! نزیکەی شەش کاتژمێر.', 'PETG ی ئاسایی، زۆر باشە.', 'بێگومان، نامەم بۆ بنێرە.', 'خۆشحاڵم کە پێت خۆش بوو.'],
};

export interface DemoRequestIdea {
  title: Tri;
  description: Tri;
  category: string;
  material: string;
  quantity: number;
  dimensions: string;
  budget: number | null;
}

export const DEMO_REQUESTS: DemoRequestIdea[] = [
  { title: t('مجسم معماري لمشروع تخرج بمقياس 1:200', 'Architecture model for a graduation project, 1:200', 'مۆدێلی بیناسازی بۆ پڕۆژەی دەرچوون، ١:٢٠٠'), description: t('عندي ملف STL لمبنى من ثلاثة طوابق، أريده أبيض ونظيفًا للعرض.', 'I have an STL of a three-storey building; white and clean for the jury.', 'فایلی STL ی بینایەکی سێ نهۆمم هەیە؛ سپی و پاک.'), category: 'architecture', material: 'PLA', quantity: 1, dimensions: '30 × 20 × 12 cm', budget: 150000 },
  { title: t('ترس بديل لغسالة دايو', 'Replacement gear for a Daewoo washing machine', 'ددانەی جێگرەوە بۆ جلشۆری دایوو'), description: t('الترس البلاستيكي تشقق. عندي القطعة المكسورة ويمكن قياسها.', 'The plastic drive gear cracked. I have the broken part for measuring.', 'ددانە پلاستیکییەکە درزی برد. پارچە شکاوەکەم هەیە.'), category: 'spare_parts', material: 'PETG', quantity: 2, dimensions: '6 cm', budget: 25000 },
  { title: t('100 ميدالية أسماء لحفل زفاف', '100 name keychains for a wedding', '١٠٠ کلیلەی ناو بۆ ئاهەنگی هاوسەرگیری'), description: t('اسم العروسين والتاريخ، لونان: أبيض وذهبي.', 'The couple\'s names and the date, white and gold.', 'ناوی بووک و زاوا و بەروار، سپی و زێڕین.'), category: 'gifts', material: 'PLA', quantity: 100, dimensions: '5 cm', budget: 200000 },
  { title: t('أحرف بارزة للافتة محل', 'Raised letters for a shop sign', 'پیتی بەرز بۆ تابلۆی دوکان'), description: t('اسم المحل بالعربي، طول 60 سم تقريبًا، لون ذهبي.', 'The shop name in Arabic, about 60 cm long, gold.', 'ناوی دوکانەکە بە عەرەبی، نزیکەی ٦٠ سم، زێڕین.'), category: 'signage', material: 'PLA', quantity: 1, dimensions: '60 × 15 cm', budget: 100000 },
  { title: t('غطاء عدسة لكاميرا قديمة', 'A lens cap for an old camera', 'قاپاغی لێنز بۆ کامێرایەکی کۆن'), description: t('كاميرا زينيت فقدت غطاء العدسة، القطر 52 ملم.', 'A Zenit camera lost its cap; 52 mm diameter.', 'کامێرای زێنیت قاپاغەکەی ون بووە؛ ٥٢ ملم.'), category: 'spare_parts', material: 'Resin', quantity: 1, dimensions: '52 mm', budget: null },
  { title: t('أذرع درون من نايلون الكربون', 'Drone arms in carbon-fibre nylon', 'قۆڵی درۆن بە نایلۆنی کاربۆن'), description: t('أربع أذرع لإطار 5 إنش، عندي ملف STEP.', 'Four arms for a 5-inch frame; I can share the STEP.', 'چوار قۆڵ بۆ چوارچێوەی ٥ ئینچ؛ فایلی STEP م هەیە.'), category: 'functional', material: 'PA-CF', quantity: 4, dimensions: '15 cm', budget: 60000 },
  { title: t('مجسم للمجموعة الشمسية لصف ابتدائي', 'A solar system model for a primary class', 'مۆدێلی کۆمەڵەی خۆر بۆ پۆلی سەرەتایی'), description: t('ثمانية كواكب بأحجام نسبية مع قاعدة.', 'Eight planets at relative sizes on a stand.', 'هەشت هەسارە بە قەبارەی ڕێژەیی.'), category: 'education', material: 'PLA', quantity: 1, dimensions: '50 cm', budget: 80000 },
  { title: t('قطع غيار لكرسي مكتب', 'Spare parts for an office chair', 'پارچەی یەدەگ بۆ کورسی ئۆفیس'), description: t('غطاء المسند البلاستيكي انكسر من الجانبين.', 'The plastic armrest cap broke on both sides.', 'قاپاغی دەستەکان لە هەردوو لا شکاوە.'), category: 'spare_parts', material: 'PETG', quantity: 2, dimensions: '25 cm', budget: 30000 },
  { title: t('مجسم الثور المجنح هدية رسمية', 'A winged bull as an official gift', 'گای باڵدار وەک دیارییەکی فەرمی'), description: t('ارتفاع 30 سم مع قاعدة ولوحة نحاسية.', '30 cm tall with a base and a brass plate.', '٣٠ سم بە بنکە و تابلۆیەکی مسین.'), category: 'heritage', material: 'Resin', quantity: 3, dimensions: '30 cm', budget: 450000 },
  { title: t('حوامل منيو لمقهى', 'Menu holders for a café', 'هەڵگری مینیو بۆ کافێ'), description: t('خمسة عشر حاملًا بشعار المقهى، لون أسود مطفي.', 'Fifteen holders with the café logo, matte black.', 'پانزە هەڵگر بە لۆگۆی کافێکە، ڕەشی ماتە.'), category: 'business', material: 'PLA', quantity: 15, dimensions: '10 × 15 cm', budget: 90000 },
  { title: t('خوذة كوسبلاي لشخصية أنمي', 'A cosplay helmet for an anime character', 'کڵاوی کۆسپلە بۆ کارەکتەرێکی ئەنیمی'), description: t('مقاس رأس 58 سم، أحتاجها مصنفرة وجاهزة للتلوين.', 'Head size 58 cm, sanded and ready for paint.', 'قەبارەی سەر ٥٨ سم، سمبادەکراو.'), category: 'cosplay', material: 'PLA+', quantity: 1, dimensions: '30 cm', budget: 175000 },
  { title: t('قطعة بديلة لمكنسة كهربائية', 'A replacement part for a vacuum cleaner', 'پارچەی جێگرەوە بۆ گەسکی کارەبایی'), description: t('مشبك الخرطوم انكسر، الموديل سامسونج.', 'The hose clip snapped; Samsung model.', 'قولابی لوولەکە شکا؛ مۆدێلی سامسۆنگ.'), category: 'spare_parts', material: 'PETG', quantity: 1, dimensions: '8 cm', budget: 15000 },
  { title: t('ألعاب تعليمية لروضة أطفال', 'Learning toys for a kindergarten', 'یاری فێرکاری بۆ باخچەی ساوایان'), description: t('حروف عربية بارزة وأشكال هندسية، ألوان زاهية وآمنة.', 'Raised Arabic letters and shapes, bright and safe.', 'پیتی عەرەبی بەرز و شێوەی هەندەسی، ڕەنگی گەش.'), category: 'education', material: 'PLA', quantity: 40, dimensions: '8 cm', budget: 120000 },
  { title: t('حامل جداري لتلفاز صغير', 'A wall bracket for a small TV', 'هەڵواسەری دیوار بۆ تەلەفیزیۆنێکی بچووک'), description: t('تلفاز 24 إنش، وزن 4 كغم.', 'A 24-inch TV, 4 kg.', 'تەلەفیزیۆنی ٢٤ ئینچ، ٤ کیلۆ.'), category: 'functional', material: 'PETG', quantity: 1, dimensions: '20 cm', budget: 40000 },
  { title: t('نموذج قلب تشريحي لكلية الطب', 'An anatomical heart model for a medical school', 'مۆدێلی دڵ بۆ کۆلێژی پزیشکی'), description: t('بالحجم الطبيعي، يُفتح من المنتصف.', 'Life size, opens in the middle.', 'بە قەبارەی سروشتی، لە ناوەڕاستەوە دەکرێتەوە.'), category: 'education', material: 'Resin', quantity: 2, dimensions: '12 cm', budget: 160000 },
];

/** What a workshop sells on its page — printed pieces, never a catalogue product. */
export interface DemoProductIdea {
  en: string;
  ar: string;
  descEn: string;
  descAr: string;
  price: number;
  category: string;
  material: string;
  tech: 'fdm' | 'resin';
  color: 'black' | 'white' | 'gray' | 'gold' | 'blue' | 'green' | 'red' | 'wood' | 'multi' | 'beige' | 'purple';
  finish: 'raw' | 'sanded' | 'painted' | 'polished';
}

export const DEMO_PRODUCTS: DemoProductIdea[] = [
  { en: 'Articulated dragon', ar: 'تنين مفصلي', descEn: 'Print-in-place dragon with moving joints, 22 cm.', descAr: 'تنين يتحرك بمفاصله، 22 سم، قطعة واحدة.', price: 18000, category: 'toys', material: 'PLA Silk', tech: 'fdm', color: 'purple', finish: 'raw' },
  { en: 'Spiral vase', ar: 'مزهرية حلزونية', descEn: 'Single-wall vase, 25 cm, watertight insert included.', descAr: 'مزهرية بجدار واحد، 25 سم، مع بطانة مانعة للتسرب.', price: 22000, category: 'decor', material: 'PLA Matte', tech: 'fdm', color: 'beige', finish: 'raw' },
  { en: 'Phone stand', ar: 'حامل هاتف', descEn: 'Foldable stand for phones and small tablets.', descAr: 'حامل قابل للطي للهواتف والأجهزة اللوحية الصغيرة.', price: 7000, category: 'desk', material: 'PETG', tech: 'fdm', color: 'black', finish: 'raw' },
  { en: 'Name keychain', ar: 'ميدالية باسمك', descEn: 'Two-colour keychain with any name in Arabic or English.', descAr: 'ميدالية بلونين بأي اسم بالعربي أو الإنكليزي.', price: 3000, category: 'gifts', material: 'PLA', tech: 'fdm', color: 'multi', finish: 'raw' },
  { en: 'Ishtar Gate model', ar: 'مجسم بوابة عشتار', descEn: 'Desk-size Ishtar Gate, hand-painted blue and gold.', descAr: 'بوابة عشتار بحجم المكتب، ملونة يدويًا بالأزرق والذهبي.', price: 45000, category: 'heritage', material: 'PLA', tech: 'fdm', color: 'blue', finish: 'painted' },
  { en: 'Lamassu replica', ar: 'نسخة الثور المجنح', descEn: 'Resin lamassu, 15 cm, stone finish.', descAr: 'ثور مجنح من الريزن، 15 سم، بلمسة حجرية.', price: 38000, category: 'heritage', material: 'Resin', tech: 'resin', color: 'gray', finish: 'painted' },
  { en: 'Desk organiser', ar: 'منظم مكتب', descEn: 'Modular organiser, three units that lock together.', descAr: 'منظم من ثلاث وحدات تتعشق مع بعض.', price: 12000, category: 'desk', material: 'PLA', tech: 'fdm', color: 'white', finish: 'raw' },
  { en: 'Lithophane lamp', ar: 'أباجورة ليثوفين', descEn: 'Your photo appears when the lamp is on.', descAr: 'صورتك تظهر عند تشغيل الأباجورة.', price: 35000, category: 'lighting', material: 'PLA', tech: 'fdm', color: 'white', finish: 'raw' },
  { en: 'Ramadan fanous', ar: 'فانوس رمضان', descEn: 'LED fanous with translucent panels.', descAr: 'فانوس بإضاءة LED وألواح شفافة.', price: 16000, category: 'decor', material: 'PLA', tech: 'fdm', color: 'gold', finish: 'raw' },
  { en: 'Resin earrings', ar: 'أقراط ريزن', descEn: 'Geometric earrings, gloss coat, hypoallergenic hooks.', descAr: 'أقراط هندسية بطبقة لامعة.', price: 9000, category: 'jewellery', material: 'Resin', tech: 'resin', color: 'red', finish: 'polished' },
  { en: 'Chess set (Babylonian)', ar: 'شطرنج بطابع بابلي', descEn: '32 pieces; the kings are winged bulls.', descAr: '32 قطعة، الملك على شكل الثور المجنح.', price: 65000, category: 'games', material: 'PLA Silk', tech: 'fdm', color: 'gold', finish: 'raw' },
  { en: 'Wall clock', ar: 'ساعة حائط', descEn: '30 cm face with Arabic numerals, silent movement.', descAr: 'ساعة 30 سم بأرقام عربية وآلة صامتة.', price: 28000, category: 'decor', material: 'PLA', tech: 'fdm', color: 'black', finish: 'raw' },
  { en: 'Planter with saucer', ar: 'أصيص مع صحن', descEn: 'Brick-pattern planter, drainage hole and saucer.', descAr: 'أصيص بنقش الطابوق مع فتحة تصريف وصحن.', price: 14000, category: 'home', material: 'PETG', tech: 'fdm', color: 'green', finish: 'raw' },
  { en: 'Mashoof boat model', ar: 'مجسم مشحوف', descEn: 'Marsh boat with reeds, 30 cm, on a wooden base.', descAr: 'مشحوف بالقصب، 30 سم، على قاعدة خشبية.', price: 42000, category: 'heritage', material: 'PLA Wood', tech: 'fdm', color: 'wood', finish: 'sanded' },
  { en: 'Painted miniature', ar: 'تمثال مصغر ملون', descEn: '32 mm tabletop figure, hand-painted.', descAr: 'تمثال 32 ملم ملون يدويًا.', price: 11000, category: 'miniatures', material: 'Resin', tech: 'resin', color: 'multi', finish: 'painted' },
  { en: 'Headphone stand', ar: 'حامل سماعات', descEn: 'Weighted base, soft TPU hook.', descAr: 'قاعدة ثقيلة وخطاف مطاطي.', price: 13000, category: 'desk', material: 'PETG', tech: 'fdm', color: 'gray', finish: 'raw' },
  { en: 'Raised-letter sign', ar: 'لافتة بأحرف بارزة', descEn: 'Your shop name in raised letters, up to 60 cm.', descAr: 'اسم محلك بأحرف بارزة حتى 60 سم.', price: 75000, category: 'signage', material: 'PLA', tech: 'fdm', color: 'gold', finish: 'sanded' },
  { en: 'Puzzle box', ar: 'صندوق ألغاز', descEn: 'Opens in a secret order. Wood-fill filament.', descAr: 'يُفتح بترتيب سري. خيط بلون الخشب.', price: 19000, category: 'games', material: 'PLA Wood', tech: 'fdm', color: 'wood', finish: 'raw' },
];
