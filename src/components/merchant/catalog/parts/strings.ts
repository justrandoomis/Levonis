/**
 * PARTS AS STORE PRODUCTS — THE MERCHANT'S WORDS IN ARABIC, ENGLISH AND
 * SORANI (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3).
 *
 * One table per surface, so each chunk carries only its own words: the
 * catalogue list's filter and chip (in CatalogManager's chunk), the door in
 * the product editor, the part's facts, and the «من ليفونيس» sheet. The
 * Sorani is written, never the Arabic standing in (docs/DECISIONS.md rows
 * 166–168). The kinds and shapes themselves are the engine's words
 * (`partKindWord` / `partShapeWord`, packages/catalog/src/personalize/parts.ts),
 * so a kind is named the same on the merchant's form and in the part's line.
 *
 * `{placeholders}` are filled at render time and appear in all three languages.
 */
export type PartsLang = 'ar' | 'en' | 'ckb';

const pick = <T extends Record<PartsLang, object>>(table: T, lang: string): T['ar'] =>
  table[lang === 'en' || lang === 'ckb' ? lang : 'ar'] as T['ar'];

/** Fill `{name}` placeholders. */
export const fill = (text: string, values: Record<string, string>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

// -------------------------------------------------- the catalogue list (CatalogManager)

const LIST = {
  ar: { kind: 'النوع', all: 'الكل', products: 'منتجات', parts: 'قطع', chip: 'قطعة', fromLevonis: 'من ليفونيس' },
  en: { kind: 'Kind', all: 'All', products: 'Products', parts: 'Parts', chip: 'Part', fromLevonis: 'From Levonis' },
  ckb: { kind: 'جۆر', all: 'هەموو', products: 'بەرهەمەکان', parts: 'پارچەکان', chip: 'پارچە', fromLevonis: 'لە لیڤۆنیسەوە' },
} as const;
export const partListStrings = (lang: string) => pick(LIST, lang);

// -------------------------------------------------- the door (ProductEditorSheet)

const DOOR = {
  ar: {
    use: 'يُستخدم داخل منتجات مطبوعة',
    useHint: 'قطعة تضعها داخل ما تطبعه — مغناطيس، إضاءة، مفتاح، برغي…',
    inside: 'مخفي عن المتجر — داخل المنتجات فقط',
    insideHint: 'لا يظهر في متجرك ولا في البحث؛ يُباع داخل منتجاتك المطبوعة فقط.',
  },
  en: {
    use: 'Can be used inside printed products',
    useHint: 'A part you build into what you print — a magnet, a light, a switch, a screw…',
    inside: 'Hidden from the store — inside products only',
    insideHint: 'It does not appear in your store or in search; it is sold only inside your printed products.',
  },
  ckb: {
    use: 'بەکاردێت لەناو بەرهەمە چاپکراوەکان',
    useHint: 'پارچەیەک کە دەیخەیتە ناو ئەوەی چاپی دەکەیت — موگناتیس، ڕووناکی، سویچ، بورغی…',
    inside: 'لە فرۆشگاکە شاراوەیە — تەنها لەناو بەرهەمەکاندا',
    insideHint: 'لە فرۆشگاکەت و گەڕاندا دەرناکەوێت؛ تەنها لەناو بەرهەمە چاپکراوەکانتدا دەفرۆشرێت.',
  },
} as const;
export const partDoorStrings = (lang: string) => pick(DOOR, lang);

// -------------------------------------------------- the facts (PartFields)

const FIELDS = {
  ar: {
    facts: 'مواصفات القطعة',
    kind: 'نوع القطعة',
    shape: 'الشكل',
    notStated: 'غير محدد',
    diameter: 'القطر',
    length: 'الطول',
    width: 'العرض',
    height: 'الارتفاع',
    voltage: 'الجهد',
    power: 'القدرة',
    install: 'طريقة التركيب',
    installPlaceholder: 'مثال: ضغط، لصق، برغي',
    minutes: 'دقائق التركيب',
    fits: 'يناسب',
    fitsHint: 'عائلات منتجات تفصلها فاصلة — مثال: مصباح، ميدالية',
    uses: 'الاستخدام داخل المنتج',
    usesHint: 'مثال: القاعدة، الغطاء',
    perOption: 'يختلف حسب الخيار',
    perOptionHint: 'القطر والارتفاع لكل خيار؛ الفارغ يأخذ قيمة القطعة.',
    newValuesLater: 'الخيارات الجديدة تظهر هنا بعد الحفظ.',
    preview: 'تُعرض هكذا',
    mm: 'مم',
    volt: 'فولت',
    watt: 'واط',
    min: 'دقيقة',
    fromLevonis: 'من ليفونيس',
    refresh: 'حدّث من ليفونيس',
    refreshHint: 'يعيد قراءة المواصفات والصور — سعرك يبقى كما هو.',
    saveFirst: 'احفظ تعديلاتك أولًا ثم حدّث.',
    refreshed: 'حُدّثت القطعة من ليفونيس',
    levonisPrice: 'سعر ليفونيس الآن {price} — سعرك {yours} كما هو.',
    refreshFailed: 'تعذّر التحديث من ليفونيس.',
  },
  en: {
    facts: 'Part details',
    kind: 'Part kind',
    shape: 'Shape',
    notStated: 'Not stated',
    diameter: 'Diameter',
    length: 'Length',
    width: 'Width',
    height: 'Height',
    voltage: 'Voltage',
    power: 'Power',
    install: 'How it is fitted',
    installPlaceholder: 'e.g. press fit, glue, screw',
    minutes: 'Fitting minutes',
    fits: 'Fits',
    fitsHint: 'Product families, comma-separated — e.g. lamp, keychain',
    uses: 'Used as',
    usesHint: 'e.g. base, lid',
    perOption: 'Differs by option',
    perOptionHint: 'Diameter and height per option; a blank one takes the part’s.',
    newValuesLater: 'New options show here after you save.',
    preview: 'Shown as',
    mm: 'mm',
    volt: 'V',
    watt: 'W',
    min: 'min',
    fromLevonis: 'From Levonis',
    refresh: 'Refresh from Levonis',
    refreshHint: 'Re-reads the details and pictures — your price stays yours.',
    saveFirst: 'Save your changes first, then refresh.',
    refreshed: 'Part refreshed from Levonis',
    levonisPrice: 'Levonis price now {price} — yours stays {yours}.',
    refreshFailed: 'Could not refresh from Levonis.',
  },
  ckb: {
    facts: 'زانیارییەکانی پارچە',
    kind: 'جۆری پارچە',
    shape: 'شێوە',
    notStated: 'دیاری نەکراوە',
    diameter: 'تیرە',
    length: 'درێژی',
    width: 'پانی',
    height: 'بەرزی',
    voltage: 'ڤۆڵتیە',
    power: 'توانا',
    install: 'شێوازی دانان',
    installPlaceholder: 'بۆ نموونە: پەستان، چەسپاندن، بورغی',
    minutes: 'خولەکەکانی دانان',
    fits: 'دەگونجێت بۆ',
    fitsHint: 'خێزانە بەرهەمەکان، بە فاریزە جیا بکەرەوە — بۆ نموونە: گڵۆپ، کلیلدان',
    uses: 'بەکارهێنان لەناو بەرهەم',
    usesHint: 'بۆ نموونە: بنکە، سەرپۆش',
    perOption: 'بەپێی هەڵبژاردە دەگۆڕێت',
    perOptionHint: 'تیرە و بەرزی بۆ هەر هەڵبژاردەیەک؛ ئەوەی بەتاڵ بێت هی پارچەکە وەردەگرێت.',
    newValuesLater: 'هەڵبژاردە نوێیەکان دوای پاشەکەوتکردن لێرە دەردەکەون.',
    preview: 'بەم شێوەیە پیشان دەدرێت',
    mm: 'ملم',
    volt: 'ڤۆڵت',
    watt: 'وات',
    min: 'خولەک',
    fromLevonis: 'لە لیڤۆنیسەوە',
    refresh: 'لە لیڤۆنیسەوە نوێی بکەرەوە',
    refreshHint: 'زانیاری و وێنەکان دووبارە دەخوێنێتەوە — نرخەکەت وەک خۆی دەمێنێتەوە.',
    saveFirst: 'سەرەتا گۆڕانکارییەکانت پاشەکەوت بکە، پاشان نوێی بکەرەوە.',
    refreshed: 'پارچەکە لە لیڤۆنیسەوە نوێکرایەوە',
    levonisPrice: 'نرخی لیڤۆنیس ئێستا {price}ـە — نرخەکەی تۆ {yours} وەک خۆی دەمێنێتەوە.',
    refreshFailed: 'نوێکردنەوە لە لیڤۆنیسەوە سەرکەوتوو نەبوو.',
  },
} as const;
export const partFieldStrings = (lang: string) => pick(FIELDS, lang);

// -------------------------------------------------- «من ليفونيس» (FromLevonisSheet)

const FROM = {
  ar: {
    title: 'قطع من ليفونيس',
    lead: 'اختر قطعة من متجر ليفونيس لتصبح قطعة مخفية في متجرك — بمخزونك وسعرك.',
    search: 'ابحث في القطع',
    kind: 'النوع',
    all: 'الكل',
    empty: 'لا قطع بهذا الوصف.',
    loadFailed: 'تعذّر تحميل القطع.',
    more: 'عرض المزيد',
    inStock: 'متوفر في ليفونيس',
    outOfStock: 'غير متوفر في ليفونيس',
    pick: 'اختر قطعة من القائمة لترى خياراتها.',
    which: 'ما الذي تضيفه',
    allOptions: 'كل الخيارات — كأنواع',
    levonisPrice: 'سعر ليفونيس',
    priceNote: 'يبدأ السعر بسعر ليفونيس وتعدّله أنت؛ يبدأ المخزون من صفر.',
    add: 'أضف إلى قطعي',
    added: 'أُضيفت القطعة — مخفية، لتضعها داخل منتجاتك',
    open: 'افتحها',
    back: 'القائمة',
    addFailed: 'تعذّرت إضافة القطعة.',
  },
  en: {
    title: 'Parts from Levonis',
    lead: 'Pick a part from the Levonis store to make it a hidden part in yours — your stock, your price.',
    search: 'Search parts',
    kind: 'Kind',
    all: 'All',
    empty: 'No parts match.',
    loadFailed: 'Could not load the parts.',
    more: 'Show more',
    inStock: 'In stock at Levonis',
    outOfStock: 'Out of stock at Levonis',
    pick: 'Pick a part from the list to see its options.',
    which: 'What to add',
    allOptions: 'Every option — as variants',
    levonisPrice: 'Levonis price',
    priceNote: 'The price starts at the Levonis price and you change it; stock starts at zero.',
    add: 'Add to my parts',
    added: 'Part added — hidden, for inside your products',
    open: 'Open it',
    back: 'List',
    addFailed: 'Could not add the part.',
  },
  ckb: {
    title: 'پارچەکان لە لیڤۆنیسەوە',
    lead: 'پارچەیەک لە فرۆشگای لیڤۆنیس هەڵبژێرە تا ببێتە پارچەیەکی شاراوە لە فرۆشگاکەت — بە کۆگا و نرخی خۆت.',
    search: 'لە پارچەکاندا بگەڕێ',
    kind: 'جۆر',
    all: 'هەموو',
    empty: 'هیچ پارچەیەک ناگونجێت.',
    loadFailed: 'بارکردنی پارچەکان سەرکەوتوو نەبوو.',
    more: 'زیاتر پیشان بدە',
    inStock: 'لە لیڤۆنیس بەردەستە',
    outOfStock: 'لە لیڤۆنیس بەردەست نییە',
    pick: 'پارچەیەک لە لیستەکە هەڵبژێرە بۆ بینینی هەڵبژاردەکانی.',
    which: 'چی زیاد دەکەیت',
    allOptions: 'هەموو هەڵبژاردەکان — وەک جۆر',
    levonisPrice: 'نرخی لیڤۆنیس',
    priceNote: 'نرخەکە بە نرخی لیڤۆنیس دەست پێدەکات و تۆ دەیگۆڕیت؛ کۆگا لە سفرەوە دەست پێدەکات.',
    add: 'زیادی بکە بۆ پارچەکانم',
    added: 'پارچەکە زیاد کرا — شاراوەیە، بۆ ئەوەی بیخەیتە ناو بەرهەمەکانت',
    open: 'بیکەرەوە',
    back: 'لیست',
    addFailed: 'زیادکردنی پارچەکە سەرکەوتوو نەبوو.',
  },
} as const;
export const fromLevonisStrings = (lang: string) => pick(FROM, lang);
