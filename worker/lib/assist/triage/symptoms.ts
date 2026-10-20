/**
 * THE CURATED FIRST STEPS, per symptom (assistant plan, push A §6).
 *
 * Conservative on purpose: each step is something any owner of a Bambu Lab
 * printer can check safely without tools, and anything deeper is a link to
 * the products that fix it and to the OFFICIAL guide for that symptom. No
 * temperature, no setting value and no part number is stated here, and no
 * claim about what an HMS code means (phase 4 reads those from reviewed data).
 *
 * Every wiki URL already appears in the reviewed corpus
 * (data/bambu-import/curated/*.json) and a test enforces it, so this file can
 * never introduce an address nobody checked. The step texts await the owner's
 * review, recorded in docs/DECISIONS.md when push A lands; until then they say
 * less, not more.
 *
 * The Arabic chip labels are the owner's own words.
 */
import type { L3, ModelToken, SymptomKey } from '../types';

export interface StepDef {
  key: string;
  text: L3;
  safety?: 'hot';
}

export interface SymptomDef {
  key: SymptomKey;
  label: L3;
  steps: readonly StepDef[];
  /** What to search for the fix, with the maintenance section when it applies. */
  fix: { terms: string; category?: 'cat_maint' } | null;
  wiki: { url?: string; byModel?: Partial<Record<ModelToken, string>> } | null;
}

const WIKI = 'https://wiki.bambulab.com/en';

export const SYMPTOMS: readonly SymptomDef[] = [
  {
    key: 'clog',
    label: { ar: 'انسداد النوزل', en: 'Nozzle clog', ckb: 'گیرانی نۆزڵ' },
    steps: [
      {
        key: 'cool_down',
        safety: 'hot',
        text: {
          ar: 'اترك النوزل يبرد قبل أن تلمسه، فقد يكون ساخناً لدرجة الحرق.',
          en: 'Let the nozzle cool down before you touch it: it can be hot enough to burn.',
          ckb: 'با نۆزڵەکە سارد ببێتەوە پێش ئەوەی دەستی لێ بدەیت، چونکە لەوانەیە ئەوەندە گەرم بێت کە بتسووتێنێت.',
        },
      },
      {
        key: 'unload_load',
        text: {
          ar: 'من شاشة الطابعة أخرج الفلامنت ثم أدخله من جديد، وراقب هل يخرج الفلامنت من النوزل.',
          en: 'From the printer screen, unload the filament and load it again, and watch whether filament comes out of the nozzle.',
          ckb: 'لە شاشەی پرینتەرەکەوە فیلامێنتەکە دەربهێنە و دووبارە بیخەرەوە، و سەیر بکە ئایا فیلامێنت لە نۆزڵەکەوە دێتە دەرەوە.',
        },
      },
      {
        key: 'spool_path',
        text: {
          ar: 'تأكد أن البكرة تدور بحرية وأن الفلامنت غير متشابك أو مكسور داخل الأنبوب.',
          en: 'Check that the spool turns freely and the filament is not tangled or broken inside the tube.',
          ckb: 'دڵنیابە کە قرقرەکە بە ئازادی دەسووڕێتەوە و فیلامێنتەکە لە ناو بۆرییەکەدا تێک نەئاڵاوە یان نەشکاوە.',
        },
      },
      {
        key: 'clean_or_replace',
        text: {
          ar: 'إذا لم يخرج شيء، نظّف النوزل كما يشرح الدليل الرسمي، أو استبدل الهوت إند (القطع المناسبة أدناه).',
          en: 'If nothing comes out, clean the nozzle as the official guide shows, or replace the hotend (matching parts are below).',
          ckb: 'ئەگەر هیچ نەهاتە دەرەوە، نۆزڵەکە پاک بکەرەوە وەک ڕێنمایی فەرمی پیشانی دەدات، یان هۆت ئێندەکە بگۆڕە (پارچە گونجاوەکان لە خوارەوەن).',
        },
      },
    ],
    fix: { terms: 'hotend nozzle cleaning needle', category: 'cat_maint' },
    wiki: { url: `${WIKI}/filament-acc/acc/nozzles` },
  },
  {
    key: 'adhesion',
    label: { ar: 'عدم الالتصاق', en: 'Not sticking to the plate', ckb: 'نەنووسانی چینی یەکەم' },
    steps: [
      {
        key: 'wash_plate',
        text: {
          ar: 'اغسل لوح الطباعة بماء دافئ وسائل صحون، جففه، ولا تلمس سطح الطباعة بأصابعك.',
          en: 'Wash the build plate with warm water and dish soap, dry it, and do not touch the print surface with your fingers.',
          ckb: 'پلەیتی چاپکردن بە ئاوی شلەتێن و شلەی قاپشۆردن بشۆ، وشکی بکەرەوە، و بە پەنجەکانت دەست لە ڕووی چاپکردن مەدە.',
        },
      },
      {
        key: 'plate_type',
        text: {
          ar: 'تأكد أن نوع اللوح المختار في برنامج التقطيع هو نفس اللوح المركّب على الطابعة.',
          en: 'Make sure the plate type chosen in the slicer is the plate actually on the printer.',
          ckb: 'دڵنیابە کە جۆری ئەو پلەیتەی لە سلایسەرەکەدا هەڵتبژاردووە هەمان ئەو پلەیتەیە کە لەسەر پرینتەرەکەیە.',
        },
      },
    ],
    fix: { terms: 'plate glue' },
    wiki: { url: `${WIKI}/filament-acc/acc/pei-plate-clean-guide` },
  },
  {
    key: 'layer_shift',
    label: { ar: 'إزاحة الطبقات', en: 'Layer shift', ckb: 'لادانی چینەکان' },
    steps: [
      {
        key: 'clear_path',
        text: {
          ar: 'تأكد أن لا شيء يعيق رأس الطباعة أو السرير، وأن الطابعة موضوعة على سطح ثابت ومستوٍ.',
          en: 'Check that nothing blocks the toolhead or the bed, and that the printer stands on a firm, level surface.',
          ckb: 'دڵنیابە کە هیچ شتێک ڕێگری لە سەری چاپکەر یان جێگاکە ناکات، و پرینتەرەکە لەسەر ڕووێکی جێگیر و تەخت دانراوە.',
        },
      },
      {
        key: 'cables',
        text: {
          ar: 'تأكد أن لا سلك ولا أنبوب فلامنت يشدّ رأس الطباعة أثناء حركته.',
          en: 'Make sure no cable or filament tube pulls on the toolhead while it moves.',
          ckb: 'دڵنیابە کە هیچ کێبڵێک یان بۆرییەکی فیلامێنت سەری چاپکەرەکە ناکێشێت لە کاتی جووڵەیدا.',
        },
      },
      {
        key: 'video',
        text: {
          ar: 'إذا تكررت، صوّر فيديو قصيراً للطباعة لترسله إلى الفريق.',
          en: 'If it happens again, record a short video of the print for the team.',
          ckb: 'ئەگەر دووبارە بووەوە، ڤیدیۆیەکی کورت لە چاپکردنەکە تۆمار بکە بۆ ئەوەی بۆ تیمەکەی بنێریت.',
        },
      },
    ],
    fix: null,
    wiki: { url: `${WIKI}/knowledge-sharing/common-print-quality-problem` },
  },
  {
    key: 'stringing',
    label: { ar: 'خيوط stringing', en: 'Stringing', ckb: 'دەزوو (stringing)' },
    steps: [
      {
        key: 'dry_filament',
        text: {
          ar: 'الفلامنت الذي امتص الرطوبة يصنع خيوطاً أكثر: جففه كما يشرح الدليل الرسمي.',
          en: 'Filament that has absorbed moisture strings more: dry it as the official guide shows.',
          ckb: 'ئەو فیلامێنتەی شێی هەڵمژیوە زیاتر دەزوو دروست دەکات: وشکی بکەرەوە وەک ڕێنمایی فەرمی پیشانی دەدات.',
        },
      },
      {
        key: 'profile',
        text: {
          ar: 'استخدم في برنامج التقطيع الإعداد الخاص بنوع الفلامنت الذي تطبع به.',
          en: 'Use the slicer profile made for the filament you are printing with.',
          ckb: 'لە سلایسەرەکەدا ئەو ڕێکخستنە بەکاربهێنە کە بۆ ئەو فیلامێنتە دانراوە کە چاپی پێ دەکەیت.',
        },
      },
    ],
    fix: { terms: 'dryer' },
    wiki: { url: `${WIKI}/filament-acc/filament/dry-filament` },
  },
  {
    key: 'ams',
    label: { ar: 'مشكلة AMS', en: 'AMS problem', ckb: 'کێشەی AMS' },
    steps: [
      {
        key: 'cut_end',
        text: {
          ar: 'اقطع طرف الفلامنت قطعاً نظيفاً وتأكد أن البكرة مركّبة في مكانها جيداً.',
          en: 'Cut the filament end cleanly and check that the spool is seated properly.',
          ckb: 'سەری فیلامێنتەکە بە پاکی ببڕە و دڵنیابە کە قرقرەکە بە باشی لە شوێنی خۆیدا دانراوە.',
        },
      },
      {
        key: 'ptfe',
        text: {
          ar: 'تأكد أن أنابيب PTFE مدفوعة بالكامل داخل وصلاتها.',
          en: 'Check that the PTFE tubes are pushed fully into their connectors.',
          ckb: 'دڵنیابە کە بۆرییەکانی PTFE بە تەواوی خراونەتە ناو بەستەرەکانیانەوە.',
        },
      },
      {
        key: 'type_code',
        text: {
          ar: 'إذا ظهر رمز خطأ على الشاشة، اكتبه هنا.',
          en: 'If the screen shows an error code, type it here.',
          ckb: 'ئەگەر کۆدێکی هەڵە لەسەر شاشەکە دەرکەوت، لێرە بینووسە.',
        },
      },
    ],
    fix: null,
    wiki: { byModel: { A1: `${WIKI}/ams-lite`, 'A1 mini': `${WIKI}/ams-lite` } },
  },
  {
    key: 'hms',
    label: { ar: 'رمز خطأ HMS', en: 'HMS error code', ckb: 'کۆدی هەڵەی HMS' },
    steps: [
      {
        key: 'type_code',
        text: {
          ar: 'اكتب الرمز كاملاً كما يظهر على الشاشة، مثلاً 0300-0100-0001-0003.',
          en: 'Type the full code as the screen shows it, for example 0300-0100-0001-0003.',
          ckb: 'کۆدەکە بە تەواوی بنووسە وەک لەسەر شاشەکە دەردەکەوێت، بۆ نموونە 0300-0100-0001-0003.',
        },
      },
      {
        key: 'photo',
        text: {
          ar: 'التقط صورة للشاشة ليرى الفريق الرسالة كاملة.',
          en: 'Take a photo of the screen so the team can see the full message.',
          ckb: 'وێنەیەک لە شاشەکە بگرە بۆ ئەوەی تیمەکە نامەکە بە تەواوی ببینێت.',
        },
      },
    ],
    fix: null,
    wiki: null,
  },
  {
    key: 'noise',
    label: { ar: 'صوت غريب', en: 'Strange noise', ckb: 'دەنگێکی نامۆ' },
    steps: [
      {
        key: 'video_sound',
        text: {
          ar: 'صوّر فيديو قصيراً مع الصوت يُسمع فيه الصوت الغريب.',
          en: 'Record a short video, with sound, in which the noise can be heard.',
          ckb: 'ڤیدیۆیەکی کورت لەگەڵ دەنگ تۆمار بکە کە دەنگە نامۆکەی تێدا ببیسترێت.',
        },
      },
      {
        key: 'when',
        text: {
          ar: 'لاحظ متى يحدث: أثناء المعايرة، أو أثناء الطباعة، أو عند تبديل الفلامنت في AMS.',
          en: 'Note when it happens: during calibration, while printing, or when the AMS changes filament.',
          ckb: 'تێبینی بکە کەی ڕوودەدات: لە کاتی ڕێکخستنی سەرەتایی (کالیبرەیشن)، لە کاتی چاپکردن، یان کاتێک AMS فیلامێنت دەگۆڕێت.',
        },
      },
    ],
    fix: null,
    wiki: null,
  },
  {
    key: 'other',
    label: { ar: 'أخرى', en: 'Something else', ckb: 'شتێکی تر' },
    steps: [
      {
        key: 'describe',
        text: {
          ar: 'صف ما يحدث بكلمات قليلة، وسيتابع الفريق معك.',
          en: 'Describe what happens in a few words; the team will follow up with you.',
          ckb: 'بە چەند وشەیەک باسی ئەوە بکە کە ڕوودەدات، تیمەکە بەدواداچوونی بۆ دەکات.',
        },
      },
    ],
    fix: null,
    wiki: null,
  },
];

export const SYMPTOM_BY_KEY: ReadonlyMap<SymptomKey, SymptomDef> = new Map(SYMPTOMS.map((s) => [s.key, s]));

export function symptomDef(key: SymptomKey): SymptomDef {
  return SYMPTOM_BY_KEY.get(key)!;
}

/** The wiki page for this symptom on this printer, or null. */
export function wikiFor(def: SymptomDef, model: ModelToken | 'other' | undefined): string | null {
  if (!def.wiki) return null;
  if (model && model !== 'other' && def.wiki.byModel?.[model]) return def.wiki.byModel[model]!;
  return def.wiki.url ?? null;
}
