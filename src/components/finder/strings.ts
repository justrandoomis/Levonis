/**
 * «مرشد الطابعات» — EVERY WORD THE FINDER SAYS, AND THE ONLY PLACE A REASON
 * CODE BECOMES A SENTENCE (docs/ux/CATALOG_DISCOVERY.md §8, §9.5).
 *
 * THE SERVER NEVER WRITES PROSE. `/api/printer-finder` returns codes plus the
 * compare engine's own reading of a spec field (`value_text`, e.g. «1,000
 * mm/s»), and the compare lenses do the same. This module turns those into
 * copy, and nothing else in the app does, so the finder's «سرعة طباعة حتى
 * 1,000 mm/s» and the compare page's «الأفضل لـ الأعمال» are one voice. A code
 * this table does not know renders NOTHING (never a guess): `reasonText`
 * returns null and the list skips it.
 *
 * Values stay the spec sheet's own. The admin types spec values in English by
 * house rule (templateFamilies), so a known closed vocabulary — Beginner, Pre-
 * assembled, Yes — is translated (a label, not a claim); anything else is shown
 * as written, inside an LTR isolate by the caller.
 *
 * PURE: no React, no context. Every function takes the language, so
 * tests/finderStrings.test.ts can prove every code has Arabic and English copy.
 *
 * OWNER: Sorani to be written by hand. Every string here is ar/en only; Sorani
 * readers see the Arabic (the same fallback `loc()` makes), per DECISIONS row 11.
 */
import type {
  FinderBudget,
  FinderLevel,
  FinderPriority,
  FinderSale,
  FinderTech,
  FinderUse,
} from '../../../packages/catalog/src/discovery';
import type { FinderCaveat, FinderCriterion, FinderReason, FinderRelaxation } from '../../../packages/catalog/src/discoveryTypes';

export type FinderLang = 'ar' | 'en' | 'ckb';

/** Arabic for ar and ckb (the `loc()` fallback), English for en. */
const pick = (lang: FinderLang, ar: string, en: string): string => (lang === 'en' ? en : ar);

// ------------------------------------------------------------------ counting

/** «طابعة واحدة / طابعتان / 3 طابعات / 11 طابعة» — Arabic counts properly. */
export function printersCount(n: number, lang: FinderLang): string {
  if (lang === 'en') return n === 1 ? '1 printer' : `${n} printers`;
  if (n === 0) return 'لا توجد طابعات';
  if (n === 1) return 'طابعة واحدة';
  if (n === 2) return 'طابعتان';
  if (n <= 10) return `${n} طابعات`;
  return `${n} طابعة`;
}

// ----------------------------------------------------------------- questions

export interface OptionCopy {
  title: string;
  sub: string;
}

export interface QuestionCopy {
  title: string;
  helper: string;
}

export const USE_COPY: Record<FinderUse, { ar: OptionCopy; en: OptionCopy }> = {
  hobby: {
    ar: { title: 'هواية واستخدام شخصي', sub: 'هدايا ومجسمات وأغراض للبيت' },
    en: { title: 'Hobby and personal use', sub: 'Gifts, models and things for home' },
  },
  business: {
    ar: { title: 'مشروع تجاري', sub: 'طباعة يومية ولساعات طويلة' },
    en: { title: 'A business', sub: 'Printing daily, for long hours' },
  },
  figures: {
    ar: { title: 'مجسمات وشخصيات', sub: 'تفاصيل دقيقة وأسطح ناعمة' },
    en: { title: 'Figures and miniatures', sub: 'Fine detail and smooth surfaces' },
  },
  functional: {
    ar: { title: 'قطع عملية وهندسية', sub: 'قطع متينة تتحمل الحرارة' },
    en: { title: 'Functional parts', sub: 'Strong parts that take the heat' },
  },
  sell: {
    ar: { title: 'منتجات للبيع', sub: 'كميات بجودة ثابتة' },
    en: { title: 'Products to sell', sub: 'Batches at a steady quality' },
  },
  multicolor: {
    ar: { title: 'طباعة متعددة الألوان', sub: 'أكثر من لون في القطعة نفسها' },
    en: { title: 'Multicolour printing', sub: 'Several colours in one part' },
  },
  unsure: {
    ar: { title: 'لا أعرف بعد', sub: 'سنقترح خيارات متوازنة تناسب أغلب الناس' },
    en: { title: 'Not sure yet', sub: 'We will suggest balanced picks that suit most people' },
  },
};

export const TECH_COPY: Record<FinderTech, { ar: OptionCopy; en: OptionCopy }> = {
  any: {
    ar: { title: 'لا أعرف', sub: 'سنقارن بين كل ما في المتجر' },
    en: { title: 'Not sure', sub: 'We will weigh everything in the shop' },
  },
  fdm: {
    ar: { title: 'Filament', sub: 'خيوط بلاستيك، الأكثر استعمالًا ومتانة' },
    en: { title: 'Filament', sub: 'Plastic filament: the most common and the toughest' },
  },
  resin: {
    ar: { title: 'Resin', sub: 'تفاصيل دقيقة جدًا للمجسمات الصغيرة' },
    en: { title: 'Resin', sub: 'Very fine detail for small models' },
  },
  laser: {
    ar: { title: 'Laser', sub: 'حفر وقص على الخشب والجلد' },
    en: { title: 'Laser', sub: 'Engraving and cutting wood and leather' },
  },
};

export const BUDGET_COPY: Record<FinderBudget, { ar: string; en: string }> = {
  '0-750000': { ar: 'أقل من 750 ألف', en: 'Under 750,000' },
  '750000-1250000': { ar: '750 ألف – 1.25 مليون', en: '750,000 – 1.25 million' },
  '1250000-2500000': { ar: '1.25 – 2.5 مليون', en: '1.25 – 2.5 million' },
  '2500000-': { ar: 'أكثر من 2.5 مليون', en: 'Over 2.5 million' },
  any: { ar: 'لا يهم', en: 'Any budget' },
};

export const SALE_COPY: Record<FinderSale, { ar: OptionCopy; en: OptionCopy }> = {
  direct: {
    ar: { title: 'أريدها الآن', sub: 'بيع مباشر فقط، من المتوفر حاليًا' },
    en: { title: 'I want it now', sub: 'Direct sale only, from stock on hand' },
  },
  any: {
    ar: { title: 'لا مانع من الطلب المسبق', sub: 'يوسّع الخيارات لتشمل غير المتوفر الآن' },
    en: { title: 'Pre-order is fine', sub: 'Widens the choice to what is not in stock now' },
  },
};

export const PRIORITY_COPY: Record<FinderPriority, { ar: OptionCopy; en: OptionCopy }> = {
  quality: {
    ar: { title: 'الجودة والدقة', sub: 'طبقات أنعم وتفاصيل أدق' },
    en: { title: 'Quality and precision', sub: 'Smoother layers, finer detail' },
  },
  speed: {
    ar: { title: 'السرعة', sub: 'إنجاز أكثر في وقت أقل' },
    en: { title: 'Speed', sub: 'More done in less time' },
  },
  quiet: {
    ar: { title: 'الهدوء', sub: 'للبيت أو المكتب' },
    en: { title: 'Quiet', sub: 'For a home or an office' },
  },
  colors: {
    ar: { title: 'تعدد الألوان', sub: 'أكثر من لون في الطبعة' },
    en: { title: 'Many colours', sub: 'More than one colour per print' },
  },
  ease: {
    ar: { title: 'سهولة الاستخدام', sub: 'تشغيل سريع وصيانة قليلة' },
    en: { title: 'Ease of use', sub: 'Quick to start, little upkeep' },
  },
  size: {
    ar: { title: 'حجم الطباعة', sub: 'قطع كبيرة دفعة واحدة' },
    en: { title: 'Print size', sub: 'Big parts in one go' },
  },
};

export const LEVEL_COPY: Record<FinderLevel, { ar: OptionCopy; en: OptionCopy }> = {
  beginner: {
    ar: { title: 'مبتدئ', sub: 'أول طابعة لي' },
    en: { title: 'Beginner', sub: 'My first printer' },
  },
  intermediate: {
    ar: { title: 'متوسط', sub: 'طبعت من قبل' },
    en: { title: 'Intermediate', sub: 'I have printed before' },
  },
  pro: {
    ar: { title: 'محترف', sub: 'أعرف الإعدادات جيدًا' },
    en: { title: 'Professional', sub: 'I know the settings well' },
  },
};

export type QuestionKey = 'use' | 'tech' | 'budget' | 'sale' | 'prio' | 'level';

const QUESTIONS: Record<QuestionKey, { ar: QuestionCopy; en: QuestionCopy }> = {
  use: {
    ar: { title: 'ماذا تريد أن تطبع؟', helper: 'اختر الأقرب لما تريده. يمكنك تغيير الإجابة في أي وقت.' },
    en: { title: 'What do you want to print?', helper: 'Pick the closest. You can change it at any time.' },
  },
  tech: {
    ar: { title: 'أي تقنية تفضّل؟', helper: 'إن لم تكن متأكدًا اختر «لا أعرف».' },
    en: { title: 'Which technology do you prefer?', helper: 'If you are not sure, choose «Not sure».' },
  },
  budget: {
    ar: { title: 'ما ميزانيتك؟', helper: 'الأسعار تبدأ من سعر النسخة الأساسية، بالدينار العراقي.' },
    en: { title: 'What is your budget?', helper: 'Prices start from the base version, in Iraqi dinars.' },
  },
  sale: {
    ar: { title: 'متى تريدها؟', helper: 'البيع المباشر من المتوفر الآن؛ الطلب المسبق يوسّع الخيارات.' },
    en: { title: 'When do you want it?', helper: 'Direct sale is what is in stock now; pre-order widens the choice.' },
  },
  prio: {
    ar: { title: 'ما الأهم لك؟', helper: 'اختر أمرين على الأكثر، بالترتيب. الأول يُحسب أكثر.' },
    en: { title: 'What matters most?', helper: 'Pick up to two, in order. The first counts more.' },
  },
  level: {
    ar: { title: 'ما خبرتك في الطباعة ثلاثية الأبعاد؟', helper: 'نرشّح ما يناسب خبرتك، ونقول إن كانت الطابعة للمحترفين.' },
    en: { title: 'How experienced are you with 3D printing?', helper: 'We match your experience, and say so when a printer is made for pros.' },
  },
};

export function question(key: QuestionKey, lang: FinderLang): QuestionCopy {
  return lang === 'en' ? QUESTIONS[key].en : QUESTIONS[key].ar;
}

export function optionCopy<K extends string>(table: Record<K, { ar: OptionCopy; en: OptionCopy }>, key: K, lang: FinderLang): OptionCopy {
  return lang === 'en' ? table[key].en : table[key].ar;
}

export function budgetLabel(b: FinderBudget, lang: FinderLang): string {
  return pick(lang, BUDGET_COPY[b].ar, BUDGET_COPY[b].en);
}

// ------------------------------------------------------------ chrome and steps

export interface FinderUi {
  pageTitle: string;
  stepOf: (n: number, total: number) => string;
  progressLabel: string;
  close: string;
  leaveTitle: string;
  leaveBody: string;
  leaveConfirm: string;
  stay: string;
  skip: (question: string) => string;
  skipShort: string;
  back: string;
  next: string;
  seeResults: string;
  answered: string;
  editAnswer: (label: string) => string;
  priorityRank: (label: string, rank: number) => string;
  priorityFull: string;
  priorityNone: string;
  priorityThen: (a: string, b: string) => string;
  techAny: string;
  budgetAny: string;
  unavailableTech: (name: string) => string;
  countsLoading: string;
}

const UI_AR: FinderUi = {
  pageTitle: 'مرشد الطابعات',
  stepOf: (n, total) => `السؤال ${n} من ${total}`,
  progressLabel: 'تقدّم المرشد',
  close: 'إغلاق المرشد',
  leaveTitle: 'الخروج من المرشد؟',
  leaveBody: 'ستعود إلى حيث كنت. إجاباتك تبقى في رابط هذه الصفحة إن رجعت إليها.',
  leaveConfirm: 'خروج',
  stay: 'متابعة الأسئلة',
  skip: (q) => `تخطَّ: ${q}`,
  skipShort: 'تخطَّ',
  back: 'رجوع',
  next: 'التالي',
  seeResults: 'اعرض النتائج',
  answered: 'إجاباتك',
  editAnswer: (label) => `تعديل: ${label}`,
  priorityRank: (label, rank) => `${label}، الأولوية ${rank}`,
  priorityFull: 'اخترت أمرين. ألغِ أحدهما لتختار غيره.',
  priorityNone: 'بلا أولوية',
  priorityThen: (a, b) => `${a}، ثم ${b}`,
  techAny: 'أي تقنية',
  budgetAny: 'أي ميزانية',
  unavailableTech: (name) => `لا توجد أجهزة ${name} في المتجر حاليًا — اسألنا عن الطلب المسبق`,
  countsLoading: 'نعدّ الطابعات…',
};

const UI_EN: FinderUi = {
  pageTitle: 'Printer finder',
  stepOf: (n, total) => `Question ${n} of ${total}`,
  progressLabel: 'Finder progress',
  close: 'Close the finder',
  leaveTitle: 'Leave the finder?',
  leaveBody: 'You will go back to where you were. Your answers stay in this page’s link if you return.',
  leaveConfirm: 'Leave',
  stay: 'Keep going',
  skip: (q) => `Skip: ${q}`,
  skipShort: 'Skip',
  back: 'Back',
  next: 'Next',
  seeResults: 'See results',
  answered: 'Your answers',
  editAnswer: (label) => `Change: ${label}`,
  priorityRank: (label, rank) => `${label}, priority ${rank}`,
  priorityFull: 'You picked two. Clear one to pick another.',
  priorityNone: 'No priority',
  priorityThen: (a, b) => `${a}, then ${b}`,
  techAny: 'Any technology',
  budgetAny: 'Any budget',
  unavailableTech: (name) => `No ${name} machines in the shop right now — ask us about a pre-order`,
  countsLoading: 'Counting printers…',
};

export function finderUi(lang: FinderLang): FinderUi {
  return lang === 'en' ? UI_EN : UI_AR;
}

// ------------------------------------------------------------------ results

export interface ResultsUi {
  label: string;
  title: (n: number) => string;
  honesty: string;
  edit: string;
  restart: string;
  bestBadge: string;
  rank: (n: number) => string;
  why: string;
  watch: string;
  viewProduct: string;
  compare: string;
  inCompare: string;
  compareAdd: (name: string) => string;
  compareRemove: (name: string) => string;
  save: (name: string) => string;
  unsave: (name: string) => string;
  saveFailed: string;
  compareAll: (n: number) => string;
  searching: (n: number | null) => string;
  noneTitle: string;
  noneBody: string;
  noneTechBody: (tech: string) => string;
  errorTitle: string;
  offline: string;
  retry: string;
  othersTitle: (n: number) => string;
  othersBudget: (n: number) => string;
  othersTech: (n: number) => string;
  othersSale: (n: number) => string;
  othersRanked: (n: number) => string;
  othersShow: string;
  othersHide: string;
  othersNamesLoading: string;
  helpTitle: string;
  helpBody: string;
  helpCta: string;
  coverage: (fieldLabel: string, known: number, total: number) => string;
}

const RESULTS_AR: ResultsUi = {
  label: 'النتائج',
  title: (n) => (n <= 1 ? 'أنسب طابعة لك' : n === 2 ? 'أفضل طابعتين لك' : `أفضل ${n} طابعات لك`),
  honesty: 'رتّبناها من ورقة مواصفات كل طابعة وسعرها الحالي وتوفرها، ولم نفترض أي رقم غير مكتوب.',
  edit: 'تعديل',
  restart: 'من جديد',
  bestBadge: 'الأنسب لك',
  rank: (n) => `المرتبة ${n}`,
  why: 'لماذا نرشّحها',
  watch: 'انتبه',
  viewProduct: 'عرض المنتج',
  compare: 'قارن',
  inCompare: 'في المقارنة',
  compareAdd: (name) => `أضف ${name} إلى المقارنة`,
  compareRemove: (name) => `أزل ${name} من المقارنة`,
  save: (name) => `احفظ ${name}`,
  unsave: (name) => `أزل ${name} من المحفوظات`,
  saveFailed: 'تعذّر الحفظ. حاول مرة أخرى.',
  compareAll: (n) => (n === 2 ? 'قارن الطابعتين' : n === 3 ? 'قارن الطابعات الثلاث' : n === 4 ? 'قارن الطابعات الأربع' : 'قارن الطابعات'),
  searching: (n) => (n ? `نبحث في ${printersCount(n, 'ar')}…` : 'نبحث في الطابعات…'),
  noneTitle: 'لا توجد طابعة تطابق إجاباتك في المتجر الآن',
  noneBody: 'أخبرنا بما تحتاجه ونبحث لك عن الأنسب، أو غيّر إجابة واحدة.',
  noneTechBody: (tech) => `لا نبيع أجهزة ${tech} حاليًا. أخبرنا بما تحتاجه ونبحث لك عن طلب مسبق.`,
  errorTitle: 'تعذّر جلب النتائج. إجاباتك محفوظة.',
  offline: 'النتائج تحتاج اتصالًا — إجاباتك محفوظة.',
  retry: 'حاول مرة أخرى',
  othersTitle: (n) => (n === 1 ? 'طابعة أخرى' : n === 2 ? 'طابعتان أخريان' : `${n} طابعات أخرى`),
  othersBudget: (n) => `${n} خارج ميزانيتك`,
  othersTech: (n) => `${n} بتقنية أخرى`,
  othersSale: (n) => `${n} غير متوفرة للبيع المباشر الآن`,
  othersRanked: (n) => `${n} أقل ملاءمة لإجاباتك`,
  othersShow: 'اعرض الأسماء',
  othersHide: 'إخفاء',
  othersNamesLoading: 'نحضر الأسماء…',
  helpTitle: 'هل تريد مساعدة بشرية؟',
  helpBody: 'نرسل إجاباتك لفريق Levonis ويكمل معك من حيث توقفت.',
  helpCta: 'تحدث معنا',
  coverage: (label, known, total) =>
    `${label} مذكور لـ ${known} من ${total} ${total >= 3 && total <= 10 ? 'طابعات' : 'طابعة'} فقط، والباقي لم يُحتسب فيه.`,
};

const RESULTS_EN: ResultsUi = {
  label: 'Results',
  title: (n) => (n <= 1 ? 'The printer for you' : `Your top ${n} printers`),
  honesty: 'Ranked from each printer’s spec sheet, current price and stock. No number was assumed that is not written down.',
  edit: 'Edit',
  restart: 'Start over',
  bestBadge: 'Best for you',
  rank: (n) => `Rank ${n}`,
  why: 'Why we suggest it',
  watch: 'Note',
  viewProduct: 'View product',
  compare: 'Compare',
  inCompare: 'In comparison',
  compareAdd: (name) => `Add ${name} to comparison`,
  compareRemove: (name) => `Remove ${name} from comparison`,
  save: (name) => `Save ${name}`,
  unsave: (name) => `Remove ${name} from saved`,
  saveFailed: 'Could not save. Try again.',
  compareAll: (n) => (n >= 2 ? `Compare the ${n} printers` : 'Compare printers'),
  searching: (n) => (n ? `Searching ${printersCount(n, 'en')}…` : 'Searching printers…'),
  noneTitle: 'No printer in the shop matches your answers right now',
  noneBody: 'Tell us what you need and we will look for the right one, or change one answer.',
  noneTechBody: (tech) => `We do not sell ${tech} machines right now. Tell us what you need and we will look into a pre-order.`,
  errorTitle: 'Could not load the results. Your answers are kept.',
  offline: 'Results need a connection — your answers are kept.',
  retry: 'Try again',
  othersTitle: (n) => (n === 1 ? '1 other printer' : `${n} other printers`),
  othersBudget: (n) => `${n} outside your budget`,
  othersTech: (n) => `${n} use another technology`,
  othersSale: (n) => `${n} not for direct sale right now`,
  othersRanked: (n) => `${n} fit your answers less well`,
  othersShow: 'Show names',
  othersHide: 'Hide',
  othersNamesLoading: 'Fetching names…',
  helpTitle: 'Want help from a person?',
  helpBody: 'We send your answers to the Levonis team, who pick up where you left off.',
  helpCta: 'Talk to us',
  coverage: (label, known, total) => `${label} is listed for only ${known} of ${total} printers; the rest were not scored on it.`,
};

export function resultsUi(lang: FinderLang): ResultsUi {
  return lang === 'en' ? RESULTS_EN : RESULTS_AR;
}

// ------------------------------------------------------ the spec vocabulary

/** The fields a reason, caveat or coverage note can name, as a noun. */
const FIELD_LABEL: Record<string, { ar: string; en: string }> = {
  print_speed: { ar: 'سرعة الطباعة', en: 'Print speed' },
  max_acceleration: { ar: 'التسارع', en: 'Acceleration' },
  max_colors: { ar: 'عدد الألوان', en: 'Number of colours' },
  extruders: { ar: 'عدد رؤوس الطباعة', en: 'Number of extruders' },
  min_layer_height: { ar: 'أقل ارتفاع طبقة', en: 'Minimum layer height' },
  xy_resolution: { ar: 'دقة XY', en: 'XY resolution' },
  z_accuracy: { ar: 'دقة المحور Z', en: 'Z accuracy' },
  noise_level: { ar: 'مستوى الضجيج', en: 'Noise level' },
  skill_level: { ar: 'مستوى الخبرة', en: 'Skill level' },
  assembly: { ar: 'الحالة عند التسليم', en: 'Assembly' },
  auto_leveling: { ar: 'المعايرة التلقائية', en: 'Auto levelling' },
  build_volume: { ar: 'حجم الطباعة', en: 'Build volume' },
  chamber_temp_max: { ar: 'حرارة الغرفة', en: 'Chamber temperature' },
  enclosed: { ar: 'الهيكل المغلق', en: 'Enclosure' },
  bed_temp_max: { ar: 'حرارة السرير', en: 'Bed temperature' },
  print_failure_detection: { ar: 'كشف أخطاء الطباعة', en: 'Failure detection' },
  warranty: { ar: 'الضمان', en: 'Warranty' },
  filament_sensor: { ar: 'حساس الخيط', en: 'Filament sensor' },
  use_cases: { ar: '«مناسبة لـ»', en: '«Suited to»' },
  price_iqd: { ar: 'السعر', en: 'Price' },
};

export function fieldLabel(fieldId: string, lang: FinderLang): string | null {
  const f = FIELD_LABEL[fieldId];
  return f ? pick(lang, f.ar, f.en) : null;
}

/** The known closed vocabularies of the spec sheet (templateFamilies options). */
const ENUM: Record<string, { ar: string; en: string }> = {
  beginner: { ar: 'مبتدئ', en: 'Beginner' },
  intermediate: { ar: 'متوسط', en: 'Intermediate' },
  advanced: { ar: 'متقدم', en: 'Advanced' },
  professional: { ar: 'محترف', en: 'Professional' },
  'pre-assembled': { ar: 'مجمّعة بالكامل', en: 'Pre-assembled' },
  'partially assembled': { ar: 'مجمّعة جزئيًا', en: 'Partially assembled' },
  kit: { ar: 'تُجمَّع بنفسك', en: 'Kit' },
  yes: { ar: 'نعم', en: 'Yes' },
  no: { ar: 'لا', en: 'No' },
};

/** A spec value as the reader should see it: a known option translated, anything else as typed. */
export function specValue(text: string, lang: FinderLang): string {
  const hit = ENUM[text.trim().toLowerCase()];
  return hit ? pick(lang, hit.ar, hit.en) : text;
}

const isYes = (text: string) => /^(yes|true|نعم)$/i.test(text.trim());

// ------------------------------------------------------------ reason copy

/**
 * A reason as copy. `v` is the value as it should be shown (the caller wraps
 * it in an LTR isolate). Returns null for a code/field pair it does not know —
 * the caller skips it; a sentence is never invented for an unknown code.
 */
export interface ReasonCopy {
  /** The sentence, with `{v}` where the value goes (or no `{v}`). */
  text: string;
  /** The value to put at `{v}`, already translated when it is a known option. */
  value: string | null;
  /** «— الأعلى بين الخيارات» when the server said `top`. */
  suffix: string | null;
}

const TOP = { ar: '— الأفضل بين الخيارات', en: '— the best of the options' };

type ReasonTable = Record<string, (value: string) => { ar: string; en: string; showValue: boolean } | null>;

/** criterion → field → copy. `{v}` marks the value. */
const REASONS: Record<string, ReasonTable> = {
  speed: {
    print_speed: () => ({ ar: 'سرعة طباعة حتى {v}', en: 'Prints at up to {v}', showValue: true }),
    max_acceleration: () => ({ ar: 'تسارع حتى {v}', en: 'Acceleration up to {v}', showValue: true }),
  },
  colors: {
    max_colors: (v) => {
      const n = Number.parseInt(v, 10);
      const ar = Number.isFinite(n) && n >= 3 && n <= 10 ? 'تطبع حتى {v} ألوان' : 'تطبع حتى {v} لونًا';
      return { ar, en: 'Prints up to {v} colours', showValue: true };
    },
  },
  quality: {
    min_layer_height: () => ({ ar: 'طبقات بسماكة {v}', en: 'Layers as fine as {v}', showValue: true }),
    xy_resolution: () => ({ ar: 'دقة XY تبلغ {v}', en: 'XY resolution of {v}', showValue: true }),
    z_accuracy: () => ({ ar: 'دقة في المحور Z تبلغ {v}', en: 'Z accuracy of {v}', showValue: true }),
  },
  quiet: {
    noise_level: () => ({ ar: 'مستوى ضجيج {v}', en: 'Noise level of {v}', showValue: true }),
  },
  ease: {
    skill_level: (v) => {
      const k = v.trim().toLowerCase();
      if (k === 'beginner') return { ar: 'مصنّفة مناسبة للمبتدئين', en: 'Rated for beginners', showValue: false };
      return { ar: 'مستوى الخبرة: {v}', en: 'Skill level: {v}', showValue: true };
    },
    assembly: (v) => {
      if (v.trim().toLowerCase() === 'pre-assembled') return { ar: 'تصل مجمّعة وجاهزة للتشغيل', en: 'Arrives assembled and ready', showValue: false };
      return { ar: 'الحالة عند التسليم: {v}', en: 'Assembly: {v}', showValue: true };
    },
    auto_leveling: (v) => (isYes(v) ? { ar: 'معايرة تلقائية للسطح', en: 'Automatic bed levelling', showValue: false } : null),
  },
  size: {
    build_volume: () => ({ ar: 'حجم طباعة {v}', en: 'Build volume of {v}', showValue: true }),
  },
  durable: {
    chamber_temp_max: () => ({ ar: 'حرارة غرفة حتى {v} للخامات الهندسية', en: 'Chamber up to {v} for engineering materials', showValue: true }),
    enclosed: (v) => (isYes(v) ? { ar: 'هيكل مغلق يحفظ الحرارة', en: 'Enclosed body that holds the heat', showValue: false } : null),
    bed_temp_max: () => ({ ar: 'حرارة سرير حتى {v}', en: 'Bed up to {v}', showValue: true }),
  },
  reliability: {
    print_failure_detection: (v) => (isYes(v) ? { ar: 'تكشف أخطاء الطباعة أثناء العمل', en: 'Detects print failures as it works', showValue: false } : null),
    warranty: () => ({ ar: 'ضمان {v}', en: 'Warranty of {v}', showValue: true }),
    filament_sensor: (v) => (isYes(v) ? { ar: 'حساس ينبّه عند نفاد الخيط', en: 'Sensor warns when filament runs out', showValue: false } : null),
    enclosed: (v) => (isYes(v) ? { ar: 'هيكل مغلق للتشغيل الطويل', en: 'Enclosed for long runs', showValue: false } : null),
  },
  use_fit: {
    use_cases: () => ({ ar: 'ترشّحها Levonis لهذا الاستخدام', en: 'Levonis recommends it for this use', showValue: false }),
  },
};

/**
 * The copy for a finder reason (or a compare lens reason, which speaks the
 * same vocabulary). `in_stock` and `in_budget` carry no field.
 */
export function reasonCopy(
  reason: { code: FinderReason['code'] | 'value' | (string & {}); field_id: string; value_text: string; top?: boolean; units?: number },
  lang: FinderLang
): ReasonCopy | null {
  if (reason.code === 'in_stock') {
    const n = typeof reason.units === 'number' && reason.units > 0 ? reason.units : null;
    // The runtime's digits, as the availability line beside it writes them.
    if (n !== null && n <= 2) return { text: pick(lang, `متوفرة الآن — بقي ${n.toLocaleString()}`, `In stock now — ${n} left`), value: null, suffix: null };
    return { text: pick(lang, 'متوفرة الآن للتسليم المباشر', 'In stock now for direct sale'), value: null, suffix: null };
  }
  if (reason.code === 'in_budget') return { text: pick(lang, 'ضمن ميزانيتك', 'Within your budget'), value: null, suffix: null };
  if (reason.code === 'value') return { text: pick(lang, 'أعلى نقاط المقارنة لكل دينار', 'The most comparison points per dinar'), value: null, suffix: null };
  const byField = REASONS[reason.code];
  if (!byField) return null;
  const build = byField[reason.field_id];
  const valueText = String(reason.value_text ?? '').trim();
  if (!build || !valueText) return null;
  const c = build(valueText);
  if (!c) return null;
  return {
    text: pick(lang, c.ar, c.en),
    value: c.showValue ? specValue(valueText, lang) : null,
    suffix: reason.top ? pick(lang, TOP.ar, TOP.en) : null,
  };
}

/** Every reason code the finder engine can send (worker/lib/printerFinder.ts). */
export const REASON_CODES: Array<FinderCriterion | 'in_stock' | 'in_budget'> = [
  'speed', 'colors', 'quality', 'quiet', 'ease', 'size', 'durable', 'reliability', 'use_fit', 'in_stock', 'in_budget',
];

/** The field each criterion's reason may be quoted from (REASON_FIELDS in the engine). */
export const REASON_FIELDS_BY_CODE: Record<FinderCriterion, string[]> = {
  speed: ['print_speed', 'max_acceleration'],
  colors: ['max_colors'],
  quality: ['min_layer_height', 'xy_resolution'],
  quiet: ['noise_level'],
  ease: ['skill_level', 'assembly', 'auto_leveling'],
  size: ['build_volume'],
  durable: ['chamber_temp_max', 'enclosed', 'bed_temp_max'],
  reliability: ['print_failure_detection', 'warranty', 'filament_sensor'],
  use_fit: ['use_cases'],
};

// ------------------------------------------------------------ caveat copy

const CRITERION_NOUN: Record<FinderCriterion, { ar: string; en: string }> = {
  speed: { ar: 'السرعة', en: 'Speed' },
  colors: { ar: 'عدد الألوان', en: 'Colours' },
  quality: { ar: 'الدقة', en: 'Precision' },
  quiet: { ar: 'الهدوء', en: 'Quiet' },
  ease: { ar: 'سهولة الاستخدام', en: 'Ease of use' },
  size: { ar: 'حجم الطباعة', en: 'Print size' },
  durable: { ar: 'تحمّل الخامات الهندسية', en: 'Engineering materials' },
  reliability: { ar: 'الاعتمادية', en: 'Reliability' },
  use_fit: { ar: 'ملاءمة الاستخدام', en: 'Fit for the use' },
};

const RELAXATION: Record<FinderRelaxation, { ar: string; en: string }> = {
  budget_plus_20: { ar: 'أعلى من ميزانيتك بقليل', en: 'A little above your budget' },
  allow_preorder: { ar: 'متوفرة بطلب مسبق', en: 'Available by pre-order' },
  any_tech: { ar: 'تقنية مختلفة عمّا اخترت', en: 'A different technology from your choice' },
};

export function relaxationLabel(r: FinderRelaxation, lang: FinderLang): string {
  return pick(lang, RELAXATION[r].ar, RELAXATION[r].en);
}

/** A caveat as copy, `{v}` marking a value to isolate. Null for an unknown code. */
export function caveatCopy(caveat: FinderCaveat, lang: FinderLang): { text: string; value: string | null } | null {
  switch (caveat.code) {
    case 'relaxed':
      return RELAXATION[caveat.relaxation] ? { text: relaxationLabel(caveat.relaxation, lang), value: null } : null;
    case 'professional':
      return { text: pick(lang, 'مصنّفة للمحترفين', 'Rated for professionals'), value: null };
    case 'missing': {
      const label = fieldLabel(caveat.field_id, lang) ?? (CRITERION_NOUN[caveat.criterion] ? pick(lang, CRITERION_NOUN[caveat.criterion].ar, CRITERION_NOUN[caveat.criterion].en) : null);
      if (!label) return null;
      return { text: pick(lang, `${label} غير مذكور لهذه الطابعة`, `${label} is not listed for this printer`), value: null };
    }
    case 'weak': {
      const noun = CRITERION_NOUN[caveat.criterion];
      const v = String(caveat.value_text ?? '').trim();
      if (!noun || !v) return null;
      return {
        text: pick(lang, `${noun.ar}: {v}، أقل من غيرها بين الخيارات`, `${noun.en}: {v}, behind the other options`),
        value: specValue(v, lang),
      };
    }
    default:
      return null;
  }
}

/** Priority → the noun for the coverage note. */
export function coverageLabel(fieldId: string, criterion: FinderPriority, lang: FinderLang): string {
  return fieldLabel(fieldId, lang) ?? optionCopy(PRIORITY_COPY, criterion, lang).title;
}

// ---------------------------------------------------------- answered chips

/** The short label of one answer, for the chips above a question and on the results. Null when unanswered. */
export function answerChipLabel(
  key: QuestionKey,
  a: { use: FinderUse | null; tech: FinderTech | null; budget: FinderBudget | null; sale: FinderSale | null; prio: FinderPriority[] | null; level: FinderLevel | null },
  lang: FinderLang
): string | null {
  const ui = finderUi(lang);
  switch (key) {
    case 'use':
      return a.use ? optionCopy(USE_COPY, a.use, lang).title : null;
    case 'tech':
      return a.tech ? (a.tech === 'any' ? ui.techAny : optionCopy(TECH_COPY, a.tech, lang).title) : null;
    case 'budget':
      return a.budget ? (a.budget === 'any' ? ui.budgetAny : budgetLabel(a.budget, lang)) : null;
    case 'sale':
      return a.sale ? optionCopy(SALE_COPY, a.sale, lang).title : null;
    case 'prio': {
      if (!a.prio) return null;
      if (a.prio.length === 0) return ui.priorityNone;
      const names = a.prio.map((p) => optionCopy(PRIORITY_COPY, p, lang).title);
      return names.length === 2 ? ui.priorityThen(names[0], names[1]) : names[0];
    }
    case 'level':
      return a.level ? optionCopy(LEVEL_COPY, a.level, lang).title : null;
    default:
      return null;
  }
}
