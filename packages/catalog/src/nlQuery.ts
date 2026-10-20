/**
 * FREE TEXT INTO THE LISTING GRAMMAR (smart search 1.6; the assistant plan §6,
 * acceptance rows 9 to 12).
 *
 *   «فلامنت اسود اقل من 30 الف»  → search «فلامنت», colour black, price ≤ 30,000 IQD
 *   «طابعة بدون AMS»             → search «طابعة», nothing that is an AMS or a combo
 *   «ريفل» / «بكرة كاملة»        → the refill / with-spool facet
 *   «متوفر هسه» / «حجز»          → sale=direct / sale=preorder
 *
 * WHAT IT READS, in Arabic (with the Iraqi forms people type), English and
 * Sorani:
 *   - amounts: digits from any keyboard, number words, the thousand and million
 *     words (الف، مليون، هەزار، ملیۆن، هزار, k), halves and quarters («مليون
 *     ونص», «نص مليون»), dinars, dollars, and «ورقة» (the Iraqi word for a
 *     hundred-dollar note) after a count or a price bound;
 *   - price bounds before the amount («اقل من», «under», «کەمتر لە»), after it
 *     («فما دون», «or more», «لە ... کەمتر») and ranges («بين ... و ...»,
 *     «250-400 الف», «between ... and ...»);
 *   - colours, materials, the filament diameter (1.75 / 2.85), the sale mode,
 *     refill or with spool, and «رخيص» / «cheap» as the price order;
 *   - negation («بدون», «مو», «without», «بێ»): what follows becomes an
 *     exclusion or the opposite constraint («بدون بكرة» is a refill), never a
 *     search word.
 *
 * WHAT IT CONSUMES. Price, sale, spool, colour, diameter and sort words and the
 * negations leave the search text: a word that became a filter is not also
 * ranked on («اقل», «من» and «30» would rank every description holding a 30).
 * Spool and refill words above all: the search dictionary maps «بكرة» and
 * "spool" onto filament (worker/lib/search/vocabulary.ts), so left in the text
 * they would rank every filament and filter nothing. A MATERIAL stays in the
 * text (it is in the names the search ranks) and is also a constraint.
 *
 * WHAT IT NEVER DOES. A number without a money word or a price bound is not a
 * price: X1C, A1 mini, 0.4, 6×2, 10101 and a resin printer «8K» are left to the
 * search and the identifier lane. A word it does not know stays in the text.
 *
 * Pure and deterministic: no model, no network, no I/O (the owner rule for the
 * core search: it works without any paid AI). Every lexicon word is written as
 * people type it and folded once at load, by the same fold the input gets.
 */
import type { BaseColour } from './bambuImport/registry/colours';
import { MAX_PRICE_IQD, type ListingSort, type ListingState, type SaleFilter, type SpoolFacet } from './discovery';

// ------------------------------------------------------------------ the fold

/**
 * Arabic combining marks, Latin accents, and the tatweel and zero-width joiners a Sorani keyboard
 * types: three classes, so no combining mark follows a base character inside one class.
 */
const MARKS = /[\u064b-\u065f\u0670\u06d6-\u06ed]/g;
const LATIN_MARKS = /[\u0300-\u036f]/g;
const FORMAT = /[\u0640\u200b-\u200f]/g;

/** The letters worker/lib/search/normalize.ts folds (its FOLD), for the same reasons. */
const LETTERS: Readonly<Record<string, string>> = {
  'أ': 'ا', // hamza on alif
  'إ': 'ا', // hamza under alif
  'آ': 'ا', // madda
  'ٱ': 'ا', // wasla
  'ة': 'ه', // ta marbuta
  'ى': 'ي', // alif maqsura
  'ؤ': 'و', // hamza on waw
  'ئ': 'ي', // hamza on ya
  'ک': 'ك', // Sorani kaf
  'ی': 'ي', // Sorani ya
  'ە': 'ه', // Sorani ae
};

/**
 * The comparable form of a word: lower case, no marks, the Arabic and Sorani
 * letter variants folded, Arabic-Indic and Extended Arabic-Indic digits as
 * ASCII, and the Arabic decimal and thousands separators as '.' and ','.
 * Punctuation is kept: the lexer reads «1.75», «30,000» and «$500» from it.
 */
export function nlFold(raw: string): string {
  const s = raw.normalize('NFKD').toLowerCase().replace(MARKS, '').replace(LATIN_MARKS, '').replace(FORMAT, '');
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9)) out += String(c & 15);
    else if (c === 0x66b) out += '.';
    else if (c === 0x66c) out += ',';
    else out += LETTERS[ch] ?? ch;
  }
  return out;
}

type Phrase = readonly string[];
/** Space-separated phrases, each folded word by word. */
const phrases = (...list: string[]): Phrase[] => list.map((s) => s.split(' ').map(nlFold));
/** One table row: every word of `words` (space-separated) means `value`. */
function wordMap<T>(rows: ReadonlyArray<readonly [T, string]>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [value, words] of rows) for (const w of words.split(' ')) out.set(nlFold(w), value);
  return out;
}

// ------------------------------------------------------------------ lexicons

/** Prices: what may stand before the bound («سعر», "price", «نرخ») and is consumed with it. */
const PRICE_WORDS = phrases('سعر', 'سعره', 'price', 'priced', 'cost', 'costs', 'نرخ', 'نرخی');
/** «اقل من 30 الف»: an upper bound before the amount. */
const MAX_PRE = phrases(
  'اقل من', 'اقل عن', 'اقل', 'ارخص من', 'تحت', 'دون', 'ما يتجاوز', 'ما يتعدى', 'ما يزيد عن', 'ما يزيد على',
  'الى', 'لحد', 'حد', 'حدود', 'بحدود', 'ميزانية', 'ميزانيتي', 'اقصى', 'كحد اقصى', 'بحد اقصى', 'حد اقصى', 'ماكس',
  'under', 'below', 'less than', 'lower than', 'cheaper than', 'up to', 'upto', 'at most', 'max', 'maximum', 'within',
  'budget', 'budget of', '<', '≤',
  'کەمتر لە', 'کەمتر', 'خوار', 'خوارتر لە', 'لە خوار', 'ژێر', 'لە ژێر', 'تا', 'هەتا', 'بودجە', 'بودجەی', 'زۆرترین'
);
/** «اكثر من مليون»: a lower bound before the amount. */
const MIN_PRE = phrases(
  'اكثر من', 'اكثر', 'فوق', 'اعلى من', 'اغلى من', 'يبدا من', 'ابتداء من', 'على الاقل', 'يتجاوز', 'يتعدى', 'يزيد عن', 'يزيد على',
  'over', 'above', 'more than', 'at least', 'min', 'minimum', 'starting at', 'starting from', '>', '≥',
  'زیاتر لە', 'زیاتر', 'سەرووی', 'لە سەرووی', 'لانیکەم'
);
/** «30 الف واقل»: an upper bound after the amount (Sorani puts it there: «لە 30 هەزار کەمتر»). */
const MAX_POST = phrases(
  'واقل', 'و اقل', 'او اقل', 'فما دون', 'وتحت', 'او تحت', 'كحد اقصى', 'حد اقصى',
  'or less', 'or below', 'or under', 'and under', 'and below', 'max',
  'یان کەمتر', 'و کەمتر', 'کەمتر', 'بۆ خوارەوە', 'خوارتر'
);
/** «مليون وفوق»: a lower bound after the amount. */
const MIN_POST = phrases(
  'واكثر', 'و اكثر', 'او اكثر', 'فما فوق', 'وفوق', 'او فوق',
  'or more', 'or above', 'and above', 'and up', 'plus', '+', 'min',
  'یان زیاتر', 'و زیاتر', 'زیاتر', 'بۆ سەرەوە'
);
/** «بين 500 الف و مليون»: a range opener («من» and "from" alone are a lower bound). */
const RANGE_OPEN = phrases('بين', 'between', 'لە نێوان', 'من', 'from', 'لە');
const RANGE_MIN_ALONE = phrases('من', 'from');
/** Between the two ends of a range. */
const RANGE_SEP = phrases('و', 'الى', 'حتى', 'لحد', 'ل', 'and', 'to', '-', '&', 'تا', 'بۆ', 'هەتا');
/** Between two bare amounts («250-400 الف», «500 الف الى مليون»): never «و», which joins number words. */
const BARE_SEP = phrases('-', 'الى', 'to', 'تا', 'حتى', 'لحد');
/** A Sorani amount stands after «لە» when its bound comes last («لە 30 هەزار کەمتر»). */
const SORANI_FROM = nlFold('لە');

type NumClass =
  | { k: 'digit'; v: number }
  | { k: 'n'; v: number }
  | { k: 'hundred' }
  | { k: 'mult'; v: number; weak: boolean }
  | { k: 'dual'; v: number }
  | { k: 'frac'; v: number }
  | { k: 'cur'; cur: 'IQD' | 'USD'; scale: number; dual: boolean };

const COUNT_WORDS = wordMap<number>([
  [1, 'واحد واحدة one یەک'],
  [2, 'اثنين اثنان اثنتين ثنين two دوو'],
  [3, 'ثلاث ثلاثة تلاث تلاثة three سێ'],
  [4, 'اربع اربعة four چوار'],
  [5, 'خمس خمسة five پێنج'],
  [6, 'ست ستة six شەش'],
  [7, 'سبع سبعة seven حەوت'],
  [8, 'ثمان ثماني ثمانية ثمنية eight هەشت'],
  [9, 'تسع تسعة nine نۆ'],
  [10, 'عشر عشرة ten دە'],
  [11, 'احدعش احدعشر eleven یازدە'],
  [12, 'اثنعش اثناعشر twelve دوازدە'],
  [13, 'ثلطعش تلطعش thirteen سێزدە'],
  [14, 'اربعطعش fourteen چواردە'],
  [15, 'خمسطعش fifteen پازدە'],
  [16, 'ستطعش sixteen شازدە'],
  [17, 'سبعطعش seventeen حەڤدە'],
  [18, 'ثمنطعش eighteen هەژدە'],
  [19, 'تسعطعش nineteen نۆزدە'],
  [20, 'عشرين twenty بیست'],
  [30, 'ثلاثين تلاثين thirty سی'],
  [40, 'اربعين forty چل'],
  [50, 'خمسين fifty پەنجا'],
  [60, 'ستين sixty شەست'],
  [70, 'سبعين seventy حەفتا'],
  [80, 'ثمانين ثمنين eighty هەشتا'],
  [90, 'تسعين ninety نەوەد'],
  [200, 'ميتين مئتين مائتين مئتان دووسەد'],
  [300, 'ثلاثمية تلثمية ثلثمية ثلاثمائة سێسەد'],
  [400, 'اربعمية اربعمائة چوارسەد'],
  [500, 'خمسمية خمسمائة پێنجسەد'],
  [600, 'ستمية ستمائة شەشسەد'],
  [700, 'سبعمية سبعمائة حەوتسەد'],
  [800, 'ثمنمية ثمانمية ثمانمائة هەشتسەد'],
  [900, 'تسعمية تسعمائة نۆسەد'],
]);
const HUNDRED = new Set('مية مئة مائة hundred سەد'.split(' ').map(nlFold));
/** The thousand and million words. `k` and `m` are WEAK: a price only beside a bound («under 30k»), never bare («8K» is a resin screen). */
const MULTS = wordMap<{ v: number; weak: boolean }>([
  [{ v: 1e3, weak: false }, 'الف الاف آلاف thousand thousands هەزار هزار'],
  [{ v: 1e6, weak: false }, 'مليون ملايين ميليون million millions ملیۆن'],
  [{ v: 1e3, weak: true }, 'k ك'],
  [{ v: 1e6, weak: true }, 'm mn'],
]);
const DUALS = wordMap<number>([
  [2e3, 'الفين الفان'],
  [2e6, 'مليونين مليونان'],
]);
const FRACS = wordMap<number>([
  [0.5, 'نص نصف half نیو'],
  [0.25, 'ربع quarter چارەک'],
]);
/** Money words. «ورقة» is a hundred dollars and «دفتر» ten thousand, counted («5 ورقات») or bound («اقل من ورقة»). */
const CURRENCIES = wordMap<{ cur: 'IQD' | 'USD'; scale: number; dual: boolean }>([
  [{ cur: 'IQD', scale: 1, dual: false }, 'دينار دنانير iqd دع dinar dinars دینار'],
  [{ cur: 'USD', scale: 1, dual: false }, 'دولار دولارات $ usd dollar dollars دۆلار'],
  [{ cur: 'USD', scale: 100, dual: false }, 'ورقة ورقات اوراق وەرەقە'],
  [{ cur: 'USD', scale: 100, dual: true }, 'ورقتين'],
  [{ cur: 'USD', scale: 10_000, dual: false }, 'دفتر دفاتر دەفتەر'],
]);

/** The sale mode. Time words («هسه», "now") count only beside an availability word. */
const DIRECT = phrases(
  'متوفر', 'متوفرة', 'متاح', 'متاحة', 'موجود', 'موجودة', 'جاهز', 'جاهزة', 'بالمخزن', 'بالمخزون', 'مباشر',
  'in stock', 'instock', 'available', 'ready', 'ready to ship', 'direct',
  'بەردەست', 'بەردەستە', 'ئامادە', 'ئامادەیە', 'لە کۆگا', 'لە کۆگادا'
);
const NOW = new Set('هسه هسة هسا هسع الان حاليا now ئێستا'.split(' ').map(nlFold));
const PREORDER = phrases(
  'حجز', 'احجز', 'حجز مسبق', 'طلب مسبق', 'مسبق', 'بالحجز', 'بالطلب',
  'preorder', 'pre order', 'backorder', 'advance order',
  'پێشوەخت', 'پێشوەختە', 'داواکاریی پێشوەخت', 'داواکاری پێشوەخت', 'پێشداواکاری'
);

/** Refill or with spool (`spool_type`, §G.5). */
const REFILL = phrases(
  'ريفل', 'ريفيل', 'ريفلات', 'ريفيلات', 'refill', 'refills', 'spoolless',
  'عبوة بدون بكرة', 'عبوة بلا بكرة', 'ڕیفیل', 'ڕیفڵ', 'ریفیل', 'پڕکردنەوە'
);
const SPOOL = phrases('بكرة', 'بكرات', 'سبول', 'spool', 'spools', 'ماسوورە', 'ماسوورەی', 'ماسۆرە');
const SPOOL_WITH = phrases('مع', 'with', 'full', 'a full', 'لەگەڵ');
const SPOOL_FULL = phrases('كاملة', 'كامل', 'full', 'تەواو', 'کامڵ');
/** «بكرة فارغة» is an empty spool and «حامل بكرة» a holder: products, not the spool facet. */
const SPOOL_GUARD = new Set(
  'فارغة فارغ فاضية فاضي empty بەتاڵ حامل holder هولدر stand ستاند حمالة'.split(' ').map(nlFold)
);

/** The filament diameter and the words around it. */
const DIAMETERS = new Map<string, string>([['1.75', '1.75'], ['1,75', '1.75'], ['2.85', '2.85'], ['2,85', '2.85']]);
const DIAMETER_WORDS = phrases('قطر', 'diameter', 'dia', 'تیرە');
const MM_WORDS = phrases('mm', 'مم', 'ملم', 'ملي', 'مليمتر', 'ميليمتر', 'millimeter', 'millimetre', 'ملیم');

/** The base colours (bambuImport/registry/colours.ts) in the words people type for them. */
const COLOUR_WORDS: ReadonlyArray<readonly [BaseColour, string]> = [
  ['black', 'black اسود سودا سوداء سودة بلاك ڕەش'],
  ['white', 'white ابيض بيضا بيضاء بيضة وايت حليبي سپی'],
  ['grey', 'grey gray رمادي رمادية رصاصي رصاصية خۆڵەمێشی'],
  ['red', 'red احمر حمرا حمراء عنابي سوور'],
  ['orange', 'orange برتقالي برتقالية پرتەقاڵی'],
  ['yellow', 'yellow اصفر صفرا صفراء زەرد'],
  ['green', 'green اخضر خضرا خضراء زيتوني سەوز'],
  ['blue', 'blue navy ازرق زرقا زرقاء كحلي لبني سمائي نيلي شین'],
  ['purple', 'purple violet بنفسجي بنفسجية موف مۆر'],
  ['pink', 'pink وردي وردية زهري پەمەیی'],
  ['brown', 'brown wood بني بنية قهوائي جوزي خشبي قاوەیی'],
  ['beige', 'beige cream بيج كريمي بێژ'],
  ['gold', 'gold golden ذهبي ذهبية زێڕین ئاڵتوونی'],
  ['silver', 'silver فضي فضية سلفر زیوی'],
  ['transparent', 'transparent clear translucent شفاف شفافة ڕوون شەفاف'],
  ['multicolour', 'multicolor multicolour rainbow marble رخامي فرەڕەنگ'],
];
const COLOURS = wordMap(COLOUR_WORDS);
const COLOUR_PHRASES: ReadonlyArray<readonly [Phrase, BaseColour]> = phrases(
  'متعدد الالوان', 'متعدد الوان', 'multi color', 'multi colour', 'فرە ڕەنگ'
).map((p) => [p, 'multicolour'] as const);
/** Every folded word of one base colour (the product side reads them too). */
const COLOUR_SET: ReadonlyMap<BaseColour, ReadonlySet<string>> = new Map(
  COLOUR_WORDS.map(([c, words]) => [c, new Set([c, ...words.split(' ').map(nlFold)])] as const)
);

/**
 * Materials: canonical token → the words that name it. Matched as WHOLE words,
 * so `pet` is never PETG and `pa` never "pack".
 */
const MATERIAL_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['pla', 'pla'],
  ['petg', 'petg بيتجي'],
  ['pet', 'pet'],
  ['abs', 'abs'],
  ['asa', 'asa'],
  ['tpu', 'tpu tpu95a tpu90a tpu85a tpu64d'],
  ['pa', 'pa pa6 pa11 pa12 pa612 paht nylon نايلون نايلن'],
  ['pc', 'pc polycarbonate'],
  ['pva', 'pva'],
  ['hips', 'hips'],
  ['pps', 'pps'],
  ['ppa', 'ppa'],
  ['resin', 'resin ريزن رزن ڕێزن'],
];
const MATERIALS = wordMap(MATERIAL_WORDS);
const MATERIAL_SET: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  MATERIAL_WORDS.map(([m, words]) => [m, new Set(words.split(' ').map(nlFold))] as const)
);

/** «رخيص» was the search token `cheap` (vocabulary.ts); here it is the price order. */
const CHEAP = phrases(
  'رخيص', 'رخيصة', 'ارخص', 'ارخص شي', 'اقل سعر', 'ارخص سعر', 'cheap', 'cheapest', 'cheaper', 'lowest price',
  'هەرزان', 'هەرزانترین'
);
const DEAR = phrases('غالي', 'غالية', 'اغلى', 'اغلى شي', 'expensive', 'most expensive', 'گران', 'گرانترین');

/** Negation: what follows is excluded, or the opposite constraint. */
const NEGATION = phrases(
  'بدون', 'بلا', 'بلاش', 'مو', 'مش', 'موب', 'غير', 'ليس', 'لا', 'دون', 'عدا', 'ماعدا', 'باستثناء', 'الا', 'من غير',
  'ما اريد', 'ما ابي', 'ما احتاج', 'ما بيه', 'مابيه', 'ما فيه', 'مافيه',
  'without', 'w/o', 'no', 'not', 'non', 'except', 'excluding', 'exclude', 'dont want', 'do not want', 'no need for',
  'بێ', 'بەبێ', 'نەک', 'نا', 'بێجگە', 'بێجگە لە', 'جگە لە', 'بەدەر لە', 'نامەوێت'
);

/**
 * Exclusions that name one thing in several words. An AMS printer bundle is a
 * «Combo»: «بدون AMS» and «مو كومبو» both leave out the AMS units and the
 * combos (acceptance row 10).
 */
const EXCLUDE_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['ams', 'ams امس'],
  ['combo', 'combo كومبو كمبو کۆمبۆ'],
];
const EXCLUDE_CANON = wordMap(EXCLUDE_GROUPS);
const AMS_TERMS = new Set(EXCLUDE_GROUPS.flatMap(([, words]) => words.split(' ').map(nlFold)));
const EXCLUDE_TERMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['ams', AMS_TERMS],
  ['combo', AMS_TERMS],
]);

/** Words a query is written with and not about: never an exclusion, and alone they are no search. */
const FILLERS = new Set(
  [
    'i', 'a', 'an', 'the', 'want', 'need', 'show', 'me', 'please', 'any', 'some', 'for', 'with', 'of', 'in',
    'اريد', 'ابي', 'ابغى', 'بدي', 'ريد', 'احتاج', 'اكو', 'عندكم', 'عدكم', 'شي', 'ممكن', 'رجاء', 'في', 'من', 'على', 'مع',
    'دەمەوێت', 'دەوێت', 'تکایە', 'هەیە', 'پێویستم', 'بۆ', 'لە', 'بە',
  ].map(nlFold)
);
const CONJUNCTIONS = new Set(['و', 'او', 'and', 'or', '&', '-', 'یان', 'ولا'].map(nlFold));

// ------------------------------------------------------------------ the lexer

interface Lex {
  /** The folded lexeme. */
  f: string;
  /** Its lookup forms: itself, without inner punctuation, and without an Arabic prefix (و ب ل ال). */
  v: string[];
  /** The whitespace-separated piece of the input it came from. */
  piece: number;
}

const DASH = /^[-–—~]+$/;
const LEAD = /^[^\p{L}\p{N}$<>≤≥]+/u;
const TRAIL = /[^\p{L}\p{N}$+]+$/u;
const NUMERIC_START = /^[\d$<>≤≥]/;
const RUNS = /[<>≤≥]|\$|\+|\d+(?:[.,]\d+)*|[^\d$<>≤≥+]+/g;
const ARABIC_PREFIXES = ['وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل'];

/** One piece of the input → its lexemes: «30k» is 30 and k, «1.75mm» 1.75 and mm, «$500» $ and 500; «X1C» stays whole. */
function lexemesOf(piece: string): string[] {
  let f = nlFold(piece).replace(/['’`]/g, '');
  if (DASH.test(f)) return ['-'];
  f = f.replace(LEAD, '').replace(TRAIL, '');
  if (!f) return [];
  if (NUMERIC_START.test(f)) return f.match(RUNS) ?? [f];
  // «ب500», «و50»: the preposition is a lexeme of its own.
  const glued = /^([بول])(\d.*)$/u.exec(f);
  if (glued) return [glued[1], ...(glued[2].match(RUNS) ?? [])];
  const non = /^non-(.+)$/.exec(f);
  if (non) return ['non', non[1]];
  return [f];
}

function variantsOf(f: string): string[] {
  const out = [f];
  const bare = f.replace(/[.\-_/]/g, '');
  if (bare && bare !== f) out.push(bare);
  for (const p of ARABIC_PREFIXES) if (f.startsWith(p) && f.length - p.length >= 2) out.push(f.slice(p.length));
  return out;
}

/** «الكومبو» → «كومبو»: the article off, when a word is left. */
const stripArticle = (w: string): string => (w.startsWith('ال') && w.length > 3 ? w.slice(2) : w);

// ------------------------------------------------------------------ the result

export interface NlPrice {
  min: number | null;
  max: number | null;
  /** What the shopper typed in: dinars, or dollars («ورقة», "$") the route converts at the shop rate. */
  currency: 'IQD' | 'USD';
}

/** One understood constraint, for the search chips (smart search 1.7). Data, never wording. */
export type NlChip =
  | { kind: 'price'; min: number | null; max: number | null; currency: 'IQD' | 'USD'; iqd?: { min: number | null; max: number | null } }
  | { kind: 'sale'; value: SaleFilter }
  | { kind: 'spool'; value: SpoolFacet }
  | { kind: 'diameter'; value: string }
  | { kind: 'color'; value: BaseColour; not?: true }
  | { kind: 'material'; value: string; not?: true }
  | { kind: 'sort'; value: ListingSort }
  | { kind: 'exclude'; value: string };

export interface NlQuery {
  /** The words left for the ranked search ('' when every word became a constraint). */
  text: string;
  /** The last word typed became a constraint: the search must not complete it. */
  tailConsumed: boolean;
  price: NlPrice | null;
  sale: SaleFilter | null;
  spool: SpoolFacet | null;
  diameters: string[];
  colours: BaseColour[];
  /** Materials named. They stay in `text` as well. */
  materials: string[];
  sort: ListingSort | null;
  exclude: { colours: BaseColour[]; materials: string[]; words: string[] };
  /** Everything above, in one list, in a fixed order. */
  understood: NlChip[];
}

// ------------------------------------------------------------------ the parser

interface Amount {
  value: number;
  end: number;
  /** strong: a thousand/million word or a currency; weak: k or m only; null: a bare number. */
  unit: 'strong' | 'weak' | null;
  maxMult: number;
  cur: 'IQD' | 'USD' | null;
}

function digitValue(f: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(f)) return null;
  let t: string;
  if (/^\d{1,3}(?:,\d{3})+$/.test(f) || /^\d{1,3}(?:\.\d{3}){2,}$/.test(f)) t = f.replace(/[.,]/g, '');
  else if (/^\d+(?:[.,]\d+)?$/.test(f)) t = f.replace(',', '.');
  else return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function classify(f: string): NumClass | null {
  const d = digitValue(f);
  if (d !== null) return { k: 'digit', v: d };
  for (const w of f.includes('.') ? [f, f.replace(/\./g, '')] : [f]) {
    const n = COUNT_WORDS.get(w);
    if (n !== undefined) return { k: 'n', v: n };
    if (HUNDRED.has(w)) return { k: 'hundred' };
    const m = MULTS.get(w);
    if (m) return { k: 'mult', v: m.v, weak: m.weak };
    const dual = DUALS.get(w);
    if (dual !== undefined) return { k: 'dual', v: dual };
    const fr = FRACS.get(w);
    if (fr !== undefined) return { k: 'frac', v: fr };
    const c = CURRENCIES.get(w);
    if (c) return { k: 'cur', ...c };
  }
  return null;
}

type Prev = 'digit' | 'word' | 'mult' | 'frac' | null;

/** May «و» join this to the number so far? «خمسة وعشرين», «مليون ونص», «مليون و 500 الف» — not two digit runs, which are a range. */
function joins(prev: Prev, next: NumClass, range: boolean): boolean {
  if (next.k === 'frac') return prev === 'mult';
  if (next.k === 'n' || next.k === 'hundred') return prev === 'word' || (prev === 'mult' && !range);
  if (next.k === 'digit') return prev === 'mult' && !range;
  return false;
}

export function parseNlQuery(input: string): NlQuery {
  const pieces = String(input ?? '').split(/\s+/u).filter(Boolean);
  const L: Lex[] = [];
  pieces.forEach((p, piece) => {
    for (const f of lexemesOf(p)) L.push({ f, v: variantsOf(f), piece });
  });
  const used = new Array<boolean>(L.length).fill(false);
  const take = (from: number, to: number) => {
    for (let k = from; k < to; k++) used[k] = true;
  };

  // One object, not four lets: the readers below assign them from closures.
  const got = { price: null as NlPrice | null, sale: null as SaleFilter | null, spool: null as SpoolFacet | null, sort: null as ListingSort | null };
  const diameters: string[] = [];
  const colours: BaseColour[] = [];
  const materials: string[] = [];
  const exclude = { colours: [] as BaseColour[], materials: [] as string[], words: [] as string[] };
  const add = <T>(list: T[], v: T) => {
    if (!list.includes(v)) list.push(v);
  };

  const matchAt = (i: number, p: Phrase): number => {
    if (i < 0 || i + p.length > L.length) return 0;
    for (let k = 0; k < p.length; k++) if (used[i + k] || !L[i + k].v.includes(p[k])) return 0;
    return p.length;
  };
  const longest = (i: number, list: readonly Phrase[]): number => {
    let best = 0;
    for (const p of list) best = Math.max(best, matchAt(i, p));
    return best;
  };
  const lookup = <T>(i: number, map: ReadonlyMap<string, T>): T | undefined => {
    if (i < 0 || i >= L.length || used[i]) return undefined;
    for (const v of L[i].v) {
      const hit = map.get(v);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  /** An amount from lexeme i: «30 الف», «مليون ونص», «خمسة وعشرين الف», «5 ورقات», «$500». */
  const readAmount = (start: number, o: { bound: boolean; range?: boolean }): Amount | null => {
    let j = start;
    let total = 0;
    let cur = 0;
    let lastMult = 0;
    let maxMult = 0;
    let have = false;
    let unit: Amount['unit'] = null;
    let currency: Amount['cur'] = null;
    let prev: Prev = null;
    if (j < L.length && !used[j] && L[j].f === 'ب') j++; // «ب 500 الف»
    if (j < L.length && !used[j] && L[j].f === '$') {
      currency = 'USD';
      unit = 'strong';
      j++;
    }
    while (j < L.length && !used[j]) {
      let f = L[j].f;
      let joined = false;
      let width = 1;
      if (f === 'و' || f === 'and') {
        const nx = j + 1 < L.length && !used[j + 1] ? classify(L[j + 1].f) : null;
        if (!have || !nx || !joins(prev, nx, !!o.range)) break;
        joined = true;
        width = 2;
        f = L[j + 1].f;
      } else if (have && f.length > 1 && f.startsWith('و')) {
        const nx = classify(f.slice(1));
        if (nx && joins(prev, nx, !!o.range)) {
          joined = true;
          f = f.slice(1);
        }
      }
      let c = classify(f);
      // «بمليون», «وعشرين» at the start: the preposition glued to the first word.
      if (!c && !have && f.length > 2 && /^[بول]/u.test(f)) c = classify(f.slice(1));
      if (!c) {
        if (prev === 'frac' && (f === 'a' || f === 'an')) {
          j++;
          continue;
        }
        break;
      }
      if (c.k === 'digit' || c.k === 'n') {
        if (prev === 'digit' || prev === 'frac' || (prev === 'word' && c.k === 'digit') || (prev === 'mult' && !joined)) break;
        cur += c.v;
        prev = c.k === 'digit' ? 'digit' : 'word';
      } else if (c.k === 'hundred') {
        if (prev === 'mult' && !joined) break;
        cur = (cur || 1) * 100;
        prev = 'word';
      } else if (c.k === 'mult') {
        if (prev === 'mult' || (c.weak && prev !== 'digit')) break;
        // A bare «الف» is a letter or a word; a bare «مليون» is a price.
        if (!have && c.v < 1e6 && !o.bound) break;
        total += (cur || 1) * c.v;
        cur = 0;
        lastMult = c.v;
        maxMult = Math.max(maxMult, c.v);
        unit = c.weak ? (unit ?? 'weak') : 'strong';
        prev = 'mult';
      } else if (c.k === 'dual') {
        if (have || (c.v < 2e6 && !o.bound)) break;
        total += c.v;
        lastMult = c.v / 2;
        maxMult = Math.max(maxMult, lastMult);
        unit = 'strong';
        prev = 'mult';
      } else if (c.k === 'frac') {
        if (prev === 'mult' && joined) {
          total += lastMult * c.v;
          prev = 'frac';
        } else if (!have) {
          cur = c.v;
          prev = 'frac';
        } else break;
      } else {
        // A currency word ends the amount. «ورقة» needs a count or a bound: alone it is a sheet of paper.
        if (currency && currency !== c.cur) break;
        if (c.scale > 1) {
          if (prev === 'mult' || prev === 'frac' || (!have && !o.bound)) break;
          total += (cur || 1) * c.scale * (c.dual ? 2 : 1);
          cur = 0;
          have = true;
        }
        if (!have) break;
        currency = c.cur;
        unit = 'strong';
        j += width;
        break;
      }
      have = true;
      j += width;
    }
    // «مليون و 250» is 1,250,000 in a shop that prices in thousands.
    if (lastMult >= 1e6 && cur > 0 && cur < 1000) cur *= 1000;
    const value = total + cur;
    if (!have || !Number.isFinite(value) || value < 1 || value > MAX_PRICE_IQD) return null;
    return { value, end: j, unit, maxMult, cur: currency };
  };

  /** An amount as a price: dollars as typed; dinars; a bare number only beside a bound (Iraqi shorthand: «اقل من 30» is 30,000). */
  const priceOf = (a: Amount, bound: boolean): { v: number; cur: 'IQD' | 'USD' } | null => {
    if (a.cur === 'USD') return { v: Math.round(a.value), cur: 'USD' };
    if (a.unit === 'strong' || (a.unit === 'weak' && bound)) return { v: Math.round(a.value), cur: 'IQD' };
    if (!bound || a.unit === 'weak') return null;
    return { v: Math.round(a.value < 1000 ? a.value * 1000 : a.value), cur: 'IQD' };
  };

  const setBound = (dir: 'min' | 'max', p: { v: number; cur: 'IQD' | 'USD' }) => {
    if (!got.price || got.price.currency !== p.cur) got.price = { min: null, max: null, currency: p.cur };
    const price = got.price;
    price[dir] = p.v;
    if (price.min !== null && price.max !== null && price.min > price.max) got.price = { min: price.max, max: price.min, currency: p.cur };
  };
  const flipDir = (dir: 'min' | 'max', flip: boolean): 'min' | 'max' => (flip ? (dir === 'min' ? 'max' : 'min') : dir);

  /** A range from lexeme k: A sep B. The bare end borrows the other end's thousand or million («بين 25 و 50 الف»). */
  const readRange = (k: number, bare: boolean): { lo: { v: number; cur: 'IQD' | 'USD' }; hi: { v: number; cur: 'IQD' | 'USD' }; end: number } | null => {
    const a = readAmount(k, { bound: true, range: true });
    if (!a) return null;
    const sep = longest(a.end, bare ? BARE_SEP : RANGE_SEP);
    let b: Amount | null = null;
    if (sep) b = readAmount(a.end + sep, { bound: true });
    else if (!bare && a.end < L.length && /^[ول]./u.test(L[a.end].f)) {
      // «و50 الف»: the separator glued to the second end.
      const saved = L[a.end];
      L[a.end] = { ...saved, f: saved.f.slice(1), v: variantsOf(saved.f.slice(1)) };
      b = readAmount(a.end, { bound: true });
      L[a.end] = saved;
    }
    if (!b) return null;
    if (bare && a.unit !== 'strong' && b.unit !== 'strong') return null;
    let av = a.value;
    if (a.unit === null && b.maxMult > 0 && av < 1000) av *= b.maxMult;
    const cur = a.cur ?? b.cur ?? 'IQD';
    if ((a.cur && b.cur && a.cur !== b.cur) || (b.cur && a.cur === null && a.unit === 'strong' && b.cur !== 'IQD')) return null;
    const lo = priceOf({ ...a, value: av, cur, unit: a.unit ?? (b.unit ?? null) }, true);
    const hi = priceOf({ ...b, cur }, true);
    if (!lo || !hi) return null;
    return lo.v <= hi.v ? { lo, hi, end: b.end } : { lo: hi, hi: lo, end: b.end };
  };

  /** A price constraint from lexeme i: «سعر» … a range, a bound and its amount, or an amount and its bound. */
  const tryPrice = (i: number, flip: boolean): number => {
    if (i >= L.length || used[i]) return 0;
    const j = i + longest(i, PRICE_WORDS);
    const open = longest(j, RANGE_OPEN);
    if (open) {
      const r = readRange(j + open, false);
      if (r) {
        setBound('min', r.lo);
        setBound('max', r.hi);
        take(i, r.end);
        return r.end - i;
      }
      if (longest(j, RANGE_MIN_ALONE) === open) {
        const a = readAmount(j + open, { bound: false });
        const p = a && a.unit === 'strong' ? priceOf(a, false) : null;
        if (a && p) {
          setBound(flipDir('min', flip), p);
          take(i, a.end);
          return a.end - i;
        }
      }
    }
    for (const [list, dir] of [[MAX_PRE, 'max'], [MIN_PRE, 'min']] as const) {
      const c = longest(j, list);
      if (!c) continue;
      const a = readAmount(j + c, { bound: true });
      const p = a ? priceOf(a, true) : null;
      if (a && p) {
        setBound(flipDir(dir, flip), p);
        take(i, a.end);
        return a.end - i;
      }
    }
    const a = readAmount(j, { bound: false });
    if (!a) return 0;
    const range = readRange(j, true);
    if (range) {
      setBound('min', range.lo);
      setBound('max', range.hi);
      take(i, range.end);
      return range.end - i;
    }
    for (const [list, dir] of [[MAX_POST, 'max'], [MIN_POST, 'min']] as const) {
      const c = longest(a.end, list);
      const p = c ? priceOf(a, true) : null;
      if (c && p) {
        setBound(flipDir(dir, flip), p);
        take(i, a.end + c);
        // «لە 30 هەزار کەمتر»: the «لە» before it belongs to the bound.
        if (i > 0 && !used[i - 1] && L[i - 1].f === SORANI_FROM) take(i - 1, i);
        return a.end + c - i;
      }
    }
    const p = priceOf(a, false);
    if (!p || a.unit !== 'strong') return 0;
    setBound(flipDir('max', flip), p);
    take(i, a.end);
    return a.end - i;
  };

  const trySale = (i: number, flip: boolean): number => {
    const d = longest(i, DIRECT);
    const p = d ? 0 : longest(i, PREORDER);
    if (!d && !p) return 0;
    const direct = !!d !== flip;
    got.sale = direct ? 'direct' : 'preorder';
    let end = i + (d || p);
    take(i, end);
    if (d) {
      // «متوفر هسه», «هسه متوفر», "available now".
      if (end < L.length && !used[end] && L[end].v.some((v) => NOW.has(v))) take(end, ++end);
      if (i > 0 && !used[i - 1] && L[i - 1].v.some((v) => NOW.has(v))) take(i - 1, i);
    }
    return end - i;
  };

  const guarded = (k: number) => k >= 0 && k < L.length && L[k].v.some((v) => SPOOL_GUARD.has(v));
  const trySpool = (i: number, flip: boolean): number => {
    const r = longest(i, REFILL);
    if (r) {
      if (guarded(i - 1) || guarded(i + r)) return 0;
      got.spool = flip ? 'spool' : 'refill';
      take(i, i + r);
      return r;
    }
    const w = longest(i, SPOOL_WITH);
    const s = longest(i + w, SPOOL);
    if (!s) return 0;
    let end = i + w + s;
    if (guarded(i - 1) || guarded(end)) return 0;
    end += longest(end, SPOOL_FULL);
    got.spool = flip ? 'refill' : 'spool';
    take(i, end);
    return end - i;
  };

  const tryDiameter = (i: number): number => {
    const j = i + longest(i, DIAMETER_WORDS);
    const d = j < L.length && !used[j] ? DIAMETERS.get(L[j].f) : undefined;
    if (!d) return 0;
    const end = j + 1 + longest(j + 1, MM_WORDS);
    add(diameters, d);
    take(i, end);
    return end - i;
  };

  const tryColour = (i: number, flip: boolean): number => {
    let len = 0;
    let colour: BaseColour | undefined;
    for (const [p, c] of COLOUR_PHRASES) {
      const n = matchAt(i, p);
      if (n > len) [len, colour] = [n, c];
    }
    if (!len) {
      colour = lookup(i, COLOURS);
      len = colour ? 1 : 0;
    }
    if (!colour) return 0;
    add(flip ? exclude.colours : colours, colour);
    take(i, i + len);
    return len;
  };

  const trySort = (i: number): number => {
    const a = longest(i, CHEAP);
    const d = a ? 0 : longest(i, DEAR);
    if (!a && !d) return 0;
    got.sort = a ? 'price_asc' : 'price_desc';
    const end = i + (a || d);
    take(i, end);
    // «ارخص سعر» was read whole; «سعر» after «رخيص» goes with it.
    if (end < L.length && longest(end, PRICE_WORDS)) take(end, end + 1);
    return end - i;
  };

  const tryNegation = (i: number): number => {
    const n = longest(i, NEGATION);
    if (!n) return 0;
    const j = i + n;
    if (j >= L.length || used[j]) return 0;
    let k = trySpool(j, true) || trySale(j, true) || tryPrice(j, true) || tryColour(j, true);
    if (!k) {
      const m = lookup(j, MATERIALS);
      if (m) {
        add(exclude.materials, m);
        take(j, j + 1);
        k = 1;
      }
    }
    if (!k) {
      const w = L[j].f;
      const excludable = /\p{L}/u.test(w) && w.length >= 2 && !L[j].v.some((v) => FILLERS.has(v) || CONJUNCTIONS.has(v));
      if (!excludable || longest(j, NEGATION)) return 0;
      add(exclude.words, lookup(j, EXCLUDE_CANON) ?? stripArticle(w));
      take(j, j + 1);
      k = 1;
    }
    take(i, j);
    return n + k;
  };

  for (let i = 0; i < L.length; ) {
    if (used[i]) {
      i++;
      continue;
    }
    const k = tryPrice(i, false) || tryNegation(i) || trySale(i, false) || trySpool(i, false) || tryDiameter(i) || tryColour(i, false) || trySort(i);
    if (k) {
      i += k;
      continue;
    }
    const m = lookup(i, MATERIALS);
    if (m) add(materials, m);
    i++;
  }

  const { price, sale, spool, sort } = got;
  const understood: NlChip[] = [];
  if (price) understood.push({ kind: 'price', min: price.min, max: price.max, currency: price.currency });
  if (sale) understood.push({ kind: 'sale', value: sale });
  if (spool) understood.push({ kind: 'spool', value: spool });
  for (const d of diameters) understood.push({ kind: 'diameter', value: d });
  for (const c of colours) understood.push({ kind: 'color', value: c });
  for (const m of materials) understood.push({ kind: 'material', value: m });
  if (sort) understood.push({ kind: 'sort', value: sort });
  for (const c of exclude.colours) understood.push({ kind: 'color', value: c, not: true });
  for (const m of exclude.materials) understood.push({ kind: 'material', value: m, not: true });
  for (const w of exclude.words) understood.push({ kind: 'exclude', value: w });

  // The search text: every piece with a word left in it, less the joining words between constraints.
  const kept: string[] = [];
  const keptPieces = new Set<number>();
  pieces.forEach((raw, piece) => {
    const mine = L.map((l, k) => ({ l, k })).filter(({ l }) => l.piece === piece);
    const left = mine.filter(({ k }) => !used[k]);
    if (!left.length) return;
    if (left.every(({ l }) => CONJUNCTIONS.has(l.f)) && understood.length) return;
    kept.push(left.length === mine.length ? raw : left.map(({ l }) => l.f).join(''));
    keptPieces.add(piece);
  });
  // Something was understood and only «اريد» / "please" is left: nothing to search.
  const onlyFillers = understood.length > 0 && kept.every((w) => lexemesOf(w).every((f) => FILLERS.has(f)));
  const text = onlyFillers ? '' : kept.join(' ');
  const lastPiece = pieces.length - 1;
  return {
    text,
    tailConsumed: lastPiece >= 0 && (onlyFillers || !keptPieces.has(lastPiece)),
    price,
    sale,
    spool,
    diameters,
    colours,
    materials,
    sort,
    exclude,
    understood,
  };
}

// ------------------------------------------------------------------ applying it

/**
 * The parse onto a listing state the URL already holds. What the URL says
 * explicitly wins (a chip the shopper set by hand is not overridden by words),
 * and a chip whose constraint was not applied is not reported: the list of
 * understood chips is exactly what narrowed the answer. A dollar bound needs
 * the shop rate (`usdIqd`, whole dinars per dollar); without one it is not
 * applied and not reported.
 */
export function nlApply(
  state: ListingState,
  nl: NlQuery,
  opts: { usdIqd?: number | null } = {}
): { state: ListingState; understood: NlChip[] } {
  const next: ListingState = { ...state, q: nl.text, specs: { ...state.specs } };
  const understood: NlChip[] = [];
  for (const chip of nl.understood) {
    switch (chip.kind) {
      case 'price': {
        if (state.price) break;
        const rate = chip.currency === 'USD' ? opts.usdIqd ?? null : 1;
        if (!rate || !Number.isFinite(rate) || rate <= 0) break;
        const conv = (v: number | null) => (v === null ? null : Math.min(MAX_PRICE_IQD, Math.round(v * rate)));
        next.price = { min: conv(chip.min), max: conv(chip.max) };
        understood.push(chip.currency === 'USD' ? { ...chip, iqd: { ...next.price } } : chip);
        break;
      }
      case 'sale':
        if (state.sale) break;
        next.sale = chip.value;
        understood.push(chip);
        break;
      case 'spool':
        if (state.specs.spool_type?.length) break;
        next.specs.spool_type = [chip.value];
        understood.push(chip);
        break;
      case 'diameter':
        if (state.specs.diameter?.length) break;
        next.specs.diameter = [...(next.specs.diameter ?? []), chip.value];
        understood.push(chip);
        break;
      case 'sort':
        if (state.sort !== 'relevance') break;
        next.sort = chip.value;
        understood.push(chip);
        break;
      default:
        // Colours, materials and exclusions are judged per product (`nlKeeps`).
        understood.push(chip);
    }
  }
  if (next.specs.diameter) next.specs.diameter = [...new Set(next.specs.diameter)].sort();
  return { state: next, understood };
}

/** What `nlKeeps` reads of one product. */
export interface NlProduct {
  /** Its names, every language. */
  names: ReadonlyArray<unknown>;
  /** The spec mirror (`products.spec_fields`): `color_name`, `material_type`, `product_family`. */
  specs: Record<string, unknown>;
  /** The names of the colours and option values it is sold in. */
  colours?: ReadonlyArray<unknown>;
}

/** Whether any constraint must be judged per product (colours, materials, exclusions). */
export function nlJudgesProducts(nl: NlQuery): boolean {
  return nl.colours.length + nl.materials.length + nl.exclude.colours.length + nl.exclude.materials.length + nl.exclude.words.length > 0;
}

const specString = (specs: Record<string, unknown>, id: string): string => {
  const v = specs[id];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
};

function wordsOf(texts: ReadonlyArray<unknown>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    if (typeof t !== 'string' || !t) continue;
    for (const w of nlFold(t).split(/[^\p{L}\p{N}]+/u)) {
      if (!w) continue;
      out.add(w);
      out.add(stripArticle(w));
    }
  }
  return out;
}
const meets = (have: ReadonlySet<string>, want: ReadonlySet<string> | undefined): boolean => {
  if (!want) return false;
  for (const w of want) if (have.has(w)) return true;
  return false;
};

/**
 * Does this product stay in an answer to `nl`?
 *
 *   - an exclusion word leaves out a product whose NAME (any language) or
 *     family carries it — never its description, where «compatible with AMS»
 *     is written on printers sold without one;
 *   - a colour keeps a product whose colour facet, name, colours or option
 *     values name it — and nothing without that evidence (a colour asked for
 *     is not guessed); a colour excluded leaves out a product named in it, or
 *     sold in that colour alone;
 *   - a material judges only what IS a material (a `material_type` is
 *     written): its type or name must name it. A nozzle searched with «PLA»
 *     has no material and stays.
 */
export function nlKeeps(nl: NlQuery, p: NlProduct): boolean {
  const names = wordsOf(p.names);
  if (nl.exclude.words.length) {
    const family = wordsOf([specString(p.specs, 'product_family').replace(/_/g, ' ')]);
    for (const w of nl.exclude.words) {
      const terms = EXCLUDE_TERMS.get(w) ?? new Set([w]);
      if (meets(names, terms) || meets(family, terms)) return false;
    }
  }
  if (nl.colours.length || nl.exclude.colours.length) {
    const facetPieces = specString(p.specs, 'color_name')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    const facet = wordsOf(facetPieces);
    const carried = new Set([...facet, ...names, ...wordsOf(p.colours ?? [])]);
    if (nl.colours.length && !nl.colours.some((c) => meets(carried, COLOUR_SET.get(c)))) return false;
    for (const c of nl.exclude.colours) {
      const set = COLOUR_SET.get(c);
      if (meets(names, set)) return false;
      if (facetPieces.length && facetPieces.every((piece) => meets(wordsOf([piece]), set))) return false;
    }
  }
  if (nl.materials.length || nl.exclude.materials.length) {
    const type = specString(p.specs, 'material_type');
    const words = new Set([...wordsOf([type]), ...names]);
    if (nl.exclude.materials.some((m) => meets(words, MATERIAL_SET.get(m)))) return false;
    if (type.trim() && nl.materials.length && !nl.materials.some((m) => meets(words, MATERIAL_SET.get(m)))) return false;
  }
  return true;
}
