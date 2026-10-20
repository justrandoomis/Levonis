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
  phrases: ['ما تشتغل', 'ما يشتغل', 'لا تعمل', 'لا يعمل', 'not working', 'does not work', 'doesnt work', 'كار ناكات', 'کار ناکات'],
  stems: [
    'مشكل', 'مشاكل', 'عطل', 'خلل', 'خربان', 'خربانه', 'عاطل', 'problem', 'problems', 'issue', 'broken', 'fault',
    'کێشە', 'کێشەی', 'تێکچووە', 'خراپە',
  ],
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
    phrases: ['لوح طباعه', 'لوح الطباعه', 'سطح الطباعه', 'build plate', 'پلەیتی چاپ'],
    stems: ['بليت', 'بليتات', 'صفيحه', 'plate', 'plates', 'pei', 'پلەیت'],
  },
  cleaning: {
    phrases: ['ابره تنظيف', 'ابر تنظيف', 'cleaning needle', 'cleaning kit', 'ئامرازی پاککردنەوە'],
    stems: ['ابره', 'تنظيف', 'needle', 'needles', 'cleaning', 'پاککردنەوە', 'دەرزی'],
  },
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
    phrases: [
      'انسداد النوزل', 'النوزل مسدود', 'نوزل مسدود', 'ما يطلع فلامنت', 'ما يطلع خيط', 'ما ينزل فلامنت', 'nozzle clog',
      'no extrusion', 'not extruding', 'نۆزڵ گیراوە', 'نۆزڵەکە گیراوە',
    ],
    stems: ['كلوب', 'كلوك', 'انسداد', 'مسدود', 'clog', 'clogged', 'jam', 'jammed', 'گیراوە', 'گیراوه'],
  },
  adhesion: {
    phrases: [
      'ما يلزق', 'ما يلصق', 'ما يلتصق', 'عدم الالتصاق', 'الطبقه الاولى', 'not sticking', 'does not stick', 'first layer',
      'چینی یەکەم', 'نانووسێت',
    ],
    stems: ['التصاق', 'يلتصق', 'warping', 'adhesion', 'نانووسێت', 'نەنووسان'],
  },
  layer_shift: {
    phrases: ['ازاحه الطبقات', 'ازاحه طبقات', 'الطبقات مزاحه', 'layer shift', 'layer shifting', 'لادانی چین', 'لادانی چینەکان'],
    stems: ['ازاحه', 'مزاحه', 'layershift', 'لادان'],
  },
  stringing: {
    phrases: ['خيوط رفيعه', 'خيوط بين', 'stringing'],
    stems: ['stringing', 'شعيرات', 'دەزوو'],
  },
  ams: {
    phrases: ['مشكله ams', 'مشكلة ams', 'ams problem', 'ams error', 'کێشەی ams'],
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
