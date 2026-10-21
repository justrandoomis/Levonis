/**
 * THE WORDS THE ASSISTANT READS, BY HAND (Iraqi Arabic, MSA, English, Sorani).
 *
 * Everything here is compiled with the same scorer the intent lexicon uses
 * (worker/lib/assistantNlu.ts), so an Arabic stem reaches its clitics on its
 * own («نوزل» reaches «بالنوزل» and «النوزل») and a Latin stem matches a whole
 * token or its prefix only. Nothing is generated; every entry was written for
 * a sentence a customer of a printer shop types.
 */
import type { LexEntry } from '../../assistantNlu';
import type { L3, PartKey, SymptomKey } from '../types';

/**
 * WORDS THAT NAME NOTHING. Dropped from the words left over for a search,
 * never from the evidence for what was asked. «مال» is "of / for» in Iraqi
 * («نوزل مال اي ون» is "a nozzle for the A1"), «اريده» is "I want it", «اكو»
 * is "is there", «هواية» is "a lot". The Sorani column: «بۆ» (for), «دەمەوێ»
 * (I want), «هەیە» (there is), «چی» / «چۆن» (what / how).
 */
export const FILLERS: readonly string[] = [
  // Iraqi and Gulf
  'مال', 'مالت', 'مالة', 'اريد', 'اريده', 'اريدها', 'ابغى', 'ابغي', 'ابي', 'اكو', 'ماكو', 'شنو', 'شلون', 'هواية', 'هوايه',
  'زين', 'كلش', 'عندي', 'عدي', 'صارت', 'صار', 'شكد', 'لو', 'سمحت', 'رجاء', 'ممكن', 'يعني', 'بس', 'هم', 'هسه', 'هسة',
  // MSA and shared
  'هل', 'كم', 'هذا', 'هذه', 'هاي', 'من', 'في', 'على', 'عن', 'الى', 'الي', 'ل', 'يا', 'حق', 'و', 'او', 'أو', 'مع', 'بين',
  'لي', 'لطابعتي', 'عندكم', 'عدكم', 'تبيعون', 'متوفر', 'موجود', 'بكم', 'سعر', 'السعر',
  // English
  'what', 'whats', 'is', 'the', 'a', 'an', 'of', 'for', 'me', 'my', 'i', 'you', 'please', 'do', 'does', 'can', 'much', 'how',
  'and', 'or', 'with', 'want', 'need', 'have', 'any', 'there', 'some', 'price', 'buy', 'search', 'find', 'product', 'products',
  // Sorani
  'بۆ', 'دەمەوێ', 'دەمەوێت', 'هەیە', 'نییە', 'چی', 'چۆن', 'زۆر', 'باشە', 'تکایە', 'لە', 'چەند', 'ئایا', 'من',
  // What Arabic glues to a word and a Latin name cut off it: «لل A1», «بال P1S».
  'ال', 'لل', 'بال', 'وال', 'فال', 'ب', 'ف',
  // «مالتي» (mine), «بيها» (in it), «دا» (Iraqi "is …-ing").
  'مالتي', 'مالي', 'مالته', 'مالها', 'بيها', 'بيه', 'فيها', 'دا', 'طابعتي',
  // «بكم الطابعة نفسها» (the printer itself), «نرخی پرینتەرەکە چەندە» (how much is the printer).
  'نفسها', 'نفسه', 'itself', 'چەندە', 'خۆی',
  // «نوزل اشتريته تو»: Iraqi «تو» / «توه» is "just now", and the purchase and the
  // delivery are the story, not the product («وصلني», «وصلتني» it reached me).
  'تو', 'توه', 'توا', 'اشتريت', 'اشتريته', 'اشتريتها', 'شريت', 'شريته', 'شريتها', 'وصلني', 'وصلتني', 'وصلتلي', 'وصلت',
  // «اي» / «ايه» ("yes", or "which"), «الها» / «اله» ("for it").
  'اي', 'ايه', 'الها', 'اله',
];

/**
 * A PURCHASE IN THE PAST is the story of a fault («اشتريت طابعة من عندكم وصار
 * بيها انسداد», I bought a printer from you and it clogged), never a question
 * about buying: these never count as the shopping cue. «من عندكم» is "from
 * you"; «عندكم» alone («عندكم نوزل؟») still asks.
 */
export const PAST_PURCHASE: readonly string[] = [
  'اشتريت', 'اشتريته', 'اشتريتها', 'اشتريتهم', 'اشترينا', 'اشتريناها', 'شريت', 'شريته', 'شريتها', 'شرينا',
  'من عندكم', 'من عدكم', 'منكم', 'bought', 'purchased', 'کڕیم', 'کڕیمە', 'لە ئێوە',
];

/**
 * «لا قصدي بي ون اس» — "no, I mean the P1S": the customer corrects the
 * printer of the question just answered. Also fillers: they name nothing.
 */
export const CORRECTION_WORDS: readonly string[] = ['لا', 'قصدي', 'اقصد', 'قصدت', 'مو', 'no', 'mean', 'meant', 'نەخێر', 'مەبەستم'];

/** «الاول بكم» — which of the products just shown. 0 is the first. */
export const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  'الاول': 0, 'اول': 0, 'الاولى': 0, 'اولى': 0, 'first': 0, 'یەکەم': 0, 'یەکەمیان': 0,
  'الثاني': 1, 'ثاني': 1, 'الثانيه': 1, 'second': 1, 'دووەم': 1, 'دووەمیان': 1,
  'الثالث': 2, 'ثالث': 2, 'الثالثه': 2, 'third': 2, 'سێیەم': 2, 'سێیەمیان': 2,
};

/** At the triage's «which printer?»: «طابعة أخرى», "another one", or a maker the shop does not list. */
export const OTHER_PRINTER: LexEntry = {
  phrases: ['طابعه اخرى', 'طابعه ثانيه', 'غير طابعه', 'other printer', 'another printer', 'پرینتەرێکی تر'],
  stems: ['اخرى', 'غيرها', 'other', 'another'],
};

/**
 * THE OUTCOME OF THE STEPS, TYPED («جربتها وما انحلّت», "still not fixed").
 * The not-fixed list is read first: it carries the negation of the fixed one.
 * Whole phrases between gaps, after `normalizeText` (so «انحلّت» is «انحلت»).
 */
export const OUTCOME_NOT_FIXED: readonly string[] = [
  'ما انحلت', 'ما انحل', 'ما انحلت المشكله', 'مانحلت', 'ما حلت', 'ما زبطت', 'ما زبط', 'ما نفعت', 'ما نفع', 'ما فادت', 'ما فاد',
  'ما اشتغلت', 'ما اشتغل', 'لم تنحل', 'لم تحل', 'نفس المشكله', 'نفس الشي', 'بعدها نفس', 'بعده نفس', 'بعدها مسدود', 'بعده مسدود',
  'not fixed', 'still not', 'still', 'didnt work', 'did not work', 'didnt help', 'did not help', 'same problem', 'no luck',
  'چارەسەر نەبوو', 'هێشتا', 'هەمان کێشە', 'سوودی نەبوو', 'کاری نەکرد',
];
export const OUTCOME_RESOLVED: readonly string[] = [
  'انحلت', 'انحل', 'انحلت المشكله', 'زبطت', 'زبط', 'اشتغلت', 'اشتغل', 'صارت زينه', 'صار زين', 'رجعت تشتغل', 'رجعت زينه',
  'fixed', 'solved', 'it works', 'works now', 'that fixed it', 'چارەسەر بوو', 'باش بوو', 'کاری کرد',
];

/** A shopping question, as opposed to a report of a fault. */
export const PRODUCT_CUE: LexEntry = {
  phrases: ['ابحث عن', 'دور على', 'اريد اشتري', 'do you have', 'i want to buy', 'گەڕان بۆ', 'دەمەوێ بیکڕم'],
  stems: [
    'بحث', 'ابحث', 'منتج', 'منتجات', 'اشتري', 'اشتريه', 'عندكم', 'عدكم', 'تبيعون', 'سعر', 'اسعار', 'بكم', 'متوفر', 'موجود',
    'search', 'buy', 'price', 'stock', 'available', 'گەڕان', 'بەرهەم', 'نرخ', 'بکڕم', 'بەردەست',
  ],
};

/** «مشكلة», «خلل», «عطل», «ما تشتغل» — something is wrong. */
export const PROBLEM_CUE: LexEntry = {
  phrases: [
    'ما تشتغل', 'ما يشتغل', 'لا تعمل', 'لا يعمل', 'not working', 'does not work', 'doesnt work', 'كار ناكات', 'کار ناکات',
    'ما يسحب', 'ما تسحب', 'not feeding', 'does not feed', 'doesnt feed',
  ],
  stems: [
    'مشكل', 'مشاكل', 'عطل', 'خلل', 'خربان', 'خربانه', 'عاطل', 'problem', 'problems', 'issue', 'broken', 'fault',
    'کێشە', 'کێشەی', 'تێکچووە', 'خراپە',
  ],
};

/**
 * A FAULT THE CURATED STEPS DO NOT COVER: a leak, a printer that does not heat.
 * It is a problem (the triage asks which printer), but it is not a clog, so
 * the part it names does not pick the clog steps for it: the customer picks
 * the symptom, or «أخرى», and the team gets the rest.
 */
export const FAULT_CUE: LexEntry = {
  phrases: ['ما تسخن', 'ما يسخن', 'لا تسخن', 'لا يسخن', 'not heating', 'does not heat', 'doesnt heat', 'گەرم نابێت', 'گەرم نابێتەوە'],
  stems: ['تسريب', 'يسرب', 'تسرب', 'يخر', 'leak', 'leaks', 'leaking', 'دزەدەکات', 'دزە'],
};

/** «الطابعة», «printer», «پرینتەر». A named model is a printer cue too. */
export const PRINTER_CUE: LexEntry = {
  stems: ['طابعه', 'طابعت', 'طابعات', 'مكينه', 'ماكينه', 'printer', 'printers', 'پرینتەر', 'پرینتەرەکەم', 'چاپکەر'],
};

/** «صيانة» — scopes a part question to the maintenance section. */
export const MAINTENANCE_CUE: LexEntry = {
  stems: ['صيانه', 'maintenance', 'چاککردنەوە', 'چاکردنەوە'],
};

/** The part families a customer names, and the catalogue words that find them. */
export const PART_LEXICON: Record<PartKey, LexEntry> = {
  nozzle_hotend: {
    phrases: ['هوت اند', 'هوت ايند', 'hot end', 'راس الطباعه', 'هۆت ئێند'],
    stems: ['نوزل', 'نوزلات', 'فوهه', 'فوهات', 'هوتند', 'هوتاند', 'nozzle', 'nozzles', 'hotend', 'hotends', 'نۆزڵ', 'نۆزل'],
  },
  plate: {
    phrases: ['لوح طباعه', 'لوح الطباعه', 'سطح الطباعه', 'build plate', 'پلەیتی چاپ', 'پلێتی چاپ'],
    // «پلێت» is the commoner Sorani spelling of the same loanword.
    stems: ['بليت', 'بليتات', 'صفيحه', 'plate', 'plates', 'pei', 'پلەیت', 'پلێت'],
  },
  cleaning: {
    phrases: ['ابره تنظيف', 'ابر تنظيف', 'cleaning needle', 'cleaning kit', 'ئامرازی پاککردنەوە'],
    stems: ['ابره', 'تنظيف', 'needle', 'needles', 'cleaning', 'پاککردنەوە', 'دەرزی'],
  },
};

/** The symptom a fault IN a part family is, when no other symptom is named: «مشكلة بالنوزل» is the clog path. */
export const PART_SYMPTOM: Readonly<Record<PartKey, SymptomKey>> = {
  nozzle_hotend: 'clog',
  plate: 'adhesion',
  cleaning: 'clog',
};

/** What each family is searched as: the catalogue's own (indexed) words. */
export const PART_TERMS: Readonly<Record<PartKey, string>> = {
  nozzle_hotend: 'hotend nozzle',
  plate: 'plate',
  cleaning: 'cleaning needle',
};

/** What fixes a fault in that family: the part and what cleans it. */
export const PART_FIX_TERMS: Readonly<Record<PartKey, string>> = {
  nozzle_hotend: 'hotend nozzle cleaning needle',
  plate: 'plate',
  cleaning: 'cleaning needle',
};

export const PART_LABELS: Readonly<Record<PartKey, L3>> = {
  nozzle_hotend: { ar: 'النوزل (الهوت إند)', en: 'nozzle / hotend', ckb: 'نۆزڵ / هۆت ئێند' },
  plate: { ar: 'لوح الطباعة', en: 'build plate', ckb: 'پلەیتی چاپکردن' },
  cleaning: { ar: 'أدوات تنظيف النوزل', en: 'nozzle cleaning tools', ckb: 'ئامرازی پاککردنەوەی نۆزڵ' },
};

/**
 * THE SYMPTOMS, matched like the intents. Two words are deliberately missing
 * from the always-on list:
 *
 *   - «خيوط» belongs to `materials_help` («خيوط PLA» is a question about
 *     filament). It counts as stringing only while the triage is asking for
 *     the symptom, or beside a problem word (`STRINGING_WEAK`).
 *   - «AMS» is also a product. It counts as an AMS fault only beside a
 *     problem word (`AMS_WEAK`).
 *
 * A bare «صوت» is not a symptom: «noise» is matched on phrases only.
 */
export const SYMPTOM_LEXICON: Record<Exclude<SymptomKey, 'other'>, LexEntry> = {
  clog: {
    // Either word order: «ما يطلع فلامنت» and «الفلامنت ما يطلع من النوزل». The
    // article on the first word comes off before matching (`bareProclitics`),
    // so «نوزل مسكر» also reads «النوزل مسكر». «مسكر» and «معلك» alone are not
    // here: «المحل مسكر» is a shop that is closed, «الطلب معلك» an order.
    phrases: [
      'انسداد النوزل', 'النوزل مسدود', 'نوزل مسدود', 'ما يطلع فلامنت', 'ما يطلع خيط', 'ما ينزل فلامنت', 'nozzle clog',
      'no extrusion', 'not extruding', 'نۆزڵ گیراوە', 'نۆزڵەکە گیراوە',
      'فلامنت ما يطلع', 'فلامنت ما ينزل', 'فلامنت ما يخرج', 'خيط ما يطلع', 'خيط ما ينزل', 'ما يطلع من النوزل', 'ما ينزل من النوزل',
      'ما يطلع شي من النوزل', 'ما يطلع من الفوهه', 'نوزل مسكر', 'نوزل مسكور', 'نوزل معلك', 'نوزل عالق', 'فلامنت معلك', 'فلامنت عالق',
      'خيط معلك', 'nozzle blocked', 'nozzle is blocked', 'nothing comes out', 'filament not coming out', 'filament stuck',
      'فیلامێنت نایەتە دەرەوە', 'نۆزڵ داخراوە', 'کلۆگ بووە', 'کلۆگی کردووە',
    ],
    // «کلۆگ» is the Sorani loanword, as «كلوب» is the Iraqi one.
    stems: ['كلوب', 'كلوك', 'انسداد', 'مسدود', 'clog', 'clogged', 'jam', 'jammed', 'گیراوە', 'گیراوه', 'کلۆگ'],
  },
  adhesion: {
    phrases: [
      'ما يلزق', 'ما يلصق', 'ما يلتصق', 'عدم الالتصاق', 'الطبقه الاولى', 'not sticking', 'does not stick', 'first layer',
      'چینی یەکەم', 'نانووسێت', 'ترتفع من الزوايا', 'ترتفع من الاطراف', 'زوايا ترتفع', 'تنشال من البليت', 'تنقلع من البليت',
      'corners lifting', 'lifting corners', 'گۆشەکان بەرز دەبنەوە',
    ],
    stems: ['التصاق', 'يلتصق', 'تقوس', 'تتقوس', 'تقوست', 'warping', 'warped', 'adhesion', 'نانووسێت', 'نەنووسان'],
  },
  layer_shift: {
    phrases: [
      'ازاحه الطبقات', 'ازاحه طبقات', 'الطبقات مزاحه', 'layer shift', 'layer shifting', 'لادانی چین', 'لادانی چینەکان',
      'طبقات تزحف', 'طبقات منحرفه', 'طبقات مايله', 'shifted layers', 'layers shifted', 'چینەکان لادەدەن',
    ],
    stems: ['ازاحه', 'مزاحه', 'تزحف', 'layershift', 'لادان'],
  },
  stringing: {
    phrases: ['خيوط رفيعه', 'خيوط بين', 'stringing', 'مثل شعر', 'مثل الشعر', 'بيها خيوط', 'فيها خيوط', 'like hair', 'وەک موو'],
    stems: ['stringing', 'stringy', 'شعيرات', 'دەزوو'],
  },
  ams: {
    phrases: [
      'مشكله ams', 'مشكلة ams', 'ams problem', 'ams error', 'کێشەی ams', 'ams ما يسحب', 'ams لا يسحب', 'ams not feeding',
      'ams is not feeding', 'ams doesnt feed', 'ams فیلامێنت ناکێشێت',
    ],
  },
  hms: {
    phrases: ['رمز خطا', 'رمز الخطا', 'كود خطا', 'كود الخطا', 'error code', 'hms error', 'hms code', 'کۆدی هەڵە'],
    stems: ['hms'],
  },
  noise: {
    phrases: [
      'صوت غريب', 'يطلع صوت', 'اصوات غريبه', 'صوت عالي', 'strange noise', 'weird noise', 'grinding noise', 'clicking noise',
      'دەنگی نامۆ', 'دەنگێکی نامۆ',
    ],
    stems: ['طقطقه', 'grinding', 'clicking'],
  },
};

/** Counted only while the triage asks for a symptom, or beside a problem word. */
export const STRINGING_WEAK: LexEntry = { stems: ['خيوط', 'خيط', 'strings'] };
/** Counted only beside a problem word. */
export const AMS_WEAK: LexEntry = { stems: ['ams'] };
