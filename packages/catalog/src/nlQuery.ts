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
 *     words (الف، مليون، هەزار، ملیۆن، هزار, k, mil, "a thousand"), halves and
 *     quarters («مليون ونص», «نص مليون», «2 ونص مليون», "2 and a half million"),
 *     dinars, dollars, and «ورقة» (the Iraqi word for a hundred-dollar note)
 *     after a count or a price bound;
 *   - price bounds before the amount («اقل من», «under», «کەمتر لە», «بەلایەنی
 *     کەمەوە», "nothing over"), after it («فما دون», «وطالع», «ونازل», «or more»,
 *     «لە ... کەمتر», «لە ... زیاترە») and ranges («بين ... و ...», «250-400 الف»,
 *     «20الف-30الف», «between ... and ...», "from ... up to ...", «لە ...ەوە تا
 *     ...»);
 *   - colours, materials, the filament diameter (1.75 / 2.85), the sale mode,
 *     refill or with spool, and «رخيص» / «cheap» as the price order;
 *   - negation («بدون», «مو», «without», «بێ», «نە … نە», Iraqi «ما» before a
 *     known constraint, and the Sorani «… نەبێت» / «… نییە» after it): what it
 *     reaches becomes an exclusion or the opposite constraint («بدون بكرة» is a
 *     refill, «بەردەست نییە» a pre-order), never a search word. It reaches over
 *     a colour noun, the article written apart and "even" («بدون اللون الاسود»,
 *     «بدون الـ AMS», «ولا حتى ابيض»).
 *
 * WHAT IT CONSUMES. Price, sale, spool, colour, diameter and sort words and the
 * negations leave the search text: a word that became a filter is not also
 * ranked on («اقل», «من» and «30» would rank every description holding a 30).
 * Spool and refill words above all: the search dictionary maps «بكرة» and
 * "spool" onto filament (worker/lib/search/vocabulary.ts), so left in the text
 * they would rank every filament and filter nothing. A MATERIAL stays in the
 * text (it is in the names the search ranks) and is also a constraint. A bare
 * spool word or diameter becomes the facet only beside a filament or material
 * word («PLA بكرة», "filament 1.75"); alone it names a product («Bambu Reusable
 * Spool», "PTFE 1.75") and stays in the text.
 *
 * WHAT IT NEVER DOES. A number without a money word or a price bound is not a
 * price: X1C, A1 mini, 0.4, 6×2, 10101 and a resin printer «8K» are left to the
 * search and the identifier lane. Nor is a number with a measure or a count
 * after it («اقل من 1 كيلو», "under 300mm", «3 قطع», «300 پلەی سەدی», «3 ڕۆژدا»,
 * «30 سانتي»), or a model name ("Kobra 3
 * Max", "Kobra 2 Plus"). A price PER unit sold is a price («اقل من 25 للكيلو»,
 * "30 per kg", "25/kg", «بۆ هەر کیلۆیەک»); per a length, a temperature, a power
 * or a time it stays a measure («للسم», "per hour", "10 min", «30 چرکە»). «ولا»
 * and «والا» are "or", not a negation; right after one, "or" carries it on
 * («بدون AMS ولا كومبو», "without AMS or combo", «بێ AMS یان کۆمبۆ» leave out
 * both), to exclusions only: a price, the sale mode, the spool or the order in
 * the list is read as written and the list runs on past it («بدون اسود ولا اقل
 * من 30 ولا ابيض» leaves out white too). A bound word is never left out.
 * "direct drive" and "AMS ready" are features, not the sale mode. A word it
 * does not know stays in the text.
 *
 * A BARE NUMBER BESIDE A BOUND (no money word, no separator) is read by one
 * rule, for an upper and a lower bound alike: below 1,000 it counts thousands
 * (Iraqi shorthand: «اقل من 30» is 30,000, «اكثر من 500» 500,000, 999 is
 * 999,000); from 1,000 it is dinars as written («اقل من 30000» is 30,000,
 * «اكثر من 20000» 20,000, 1000 is 1,000, 1500 is 1,500). Grouped in threes
 * («30,000», «٣٠٬٠٠٠») it is written in full. A RANGE reads each end by the
 * same rule; when that inverts the order written («بين 500 و 1200», «بين 1500 و
 * 500»), its smaller end is read as written too (500 to 1,200; 500 to 1,500); a
 * range read ascending is never swapped. A bare end below 1,000 beside an end
 * with a money word shares that word («بين 2 و 3 مليون», «بين 3 و 5 ورقات»,
 * «over 100 and under 200 dollars»), the hundred with it («بين 2 و 3 مية الف» is
 * 200,000 to 300,000, «بين 3 و 5 مية» 300,000 to 500,000), unless the counts
 * are ten times apart («بين مليون و 500» is 500,000 to a million); a bare end
 * that would invert the order beside one takes thousands («بين 500 الف و 1200»
 * ends at 1,200,000).
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
 * ASCII, and the Arabic decimal and thousands separators as '.' and ','. The Arabic comma «،» (the comma key
 * of an Arabic keyboard) between two digits is a thousands separator too («٣٠،٠٠٠»); elsewhere it is a comma.
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
  return out.replace(/(\d)\u060c(?=\d)/g, '$1,');
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
/**
 * «اقل من 30 الف»: an upper bound before the amount. The longest bound phrase wins, an upper or a lower one:
 * «اقل شي 20 الف» (the least, 20,000) is a lower bound, «اقل من» an upper one.
 */
const MAX_PRE = phrases(
  'اقل من', 'اقل عن', 'اقل', 'ارخص من', 'تحت', 'دون', 'ما يتجاوز', 'ما يتعدى', 'ما يزيد عن', 'ما يزيد على',
  'يقل عن', 'يقل على', 'تقل عن',
  'الى', 'لحد', 'حد', 'حدود', 'بحدود', 'ميزانية', 'ميزانيتي', 'اقصى', 'كحد اقصى', 'بحد اقصى', 'حد اقصى', 'ماكس',
  'under', 'below', 'less than', 'lower than', 'cheaper than', 'up to', 'upto', 'at most', 'max', 'maximum', 'within',
  'budget', 'budget of', '<', '≤',
  'کەمتر لە', 'کەمتر', 'خوار', 'خوارتر لە', 'لە خوار', 'ژێر', 'لە ژێر', 'تا', 'هەتا', 'بودجە', 'بودجەی', 'زۆرترین',
  'هەرزانتر لە', 'نزمتر لە',
  // "nothing over 1 million" is at most a million; "less than or equal to", «اقل من او يساوي» an upper bound whole;
  // «زیاتر نەبێت لە 30 هەزار» (not more than, written before the amount).
  'nothing over', 'nothing above', 'nothing more than', 'nothing higher than', 'nothing pricier than', 'nothing dearer than',
  'less than or equal to', 'less than or equal', 'less or equal to', 'lower than or equal to', 'equal to or less than',
  'equal or less than', 'at or below', 'at or under',
  'اقل من او يساوي', 'اقل او يساوي', 'اقل من او تساوي', 'اقل او تساوي', 'يساوي او اقل من', 'اصغر من او يساوي',
  'زیاتر نەبێت لە', 'زیاتر نەبێ لە', 'زیاتر نییە لە', 'زیاتر نیە لە'
);
/** «اكثر من مليون»: a lower bound before the amount («لا يقل عن», «حد ادنى», «لانی کەم», «سەروو» too). */
const MIN_PRE = phrases(
  'اكثر من', 'اكثر', 'فوق', 'اعلى من', 'اغلى من', 'يبدا من', 'ابتداء من', 'على الاقل', 'يتجاوز', 'يتعدى', 'يزيد عن', 'يزيد على',
  'لا يقل عن', 'لا يقل على', 'لا تقل عن', 'ما يقل عن', 'ما يقل على', 'حد ادنى', 'كحد ادنى', 'ادنى', 'اقل شي', 'اقل شيء',
  'over', 'above', 'more than', 'at least', 'min', 'minimum', 'starting at', 'starting from', '>', '≥',
  'زیاتر لە', 'زیاتر', 'سەرووی', 'لە سەرووی', 'سەروو', 'لە سەروو', 'لانیکەم', 'لانی کەم', 'کەمترین', 'گرانتر لە',
  'بەرزتر لە',
  // «بەلایەنی کەمەوە» (at least); «کەمتر نەبێت لە 20 هەزار» (not less than, written before the amount).
  'بەلایەنی کەمەوە', 'بە لایەنی کەمەوە', 'لانی کەمەوە', 'لانیکەمەوە',
  'کەمتر نەبێت لە', 'کەمتر نەبێ لە', 'کەمتر نییە لە', 'کەمتر نیە لە',
  'nothing under', 'nothing below', 'nothing less than', 'nothing cheaper than',
  'more than or equal to', 'more than or equal', 'greater than or equal to', 'higher than or equal to', 'equal to or more than',
  'equal or more than', 'at or above', 'at or over',
  'اكثر من او يساوي', 'اكثر او يساوي', 'اكثر من او تساوي', 'اكبر من او يساوي', 'يساوي او اكثر من'
);
/**
 * «30 الف واقل»: an upper bound after the amount (Sorani puts it there: «لە 30 هەزار کەمتر»). The longest
 * phrase wins: «لە 30 هەزار زیاتر نەبێت» (not more than) is an upper bound, «کەمتر نەبێت» (not less) a lower one.
 */
const MAX_POST = phrases(
  'واقل', 'و اقل', 'او اقل', 'فما دون', 'وتحت', 'او تحت', 'كحد اقصى', 'حد اقصى',
  'or less', 'or below', 'or under', 'and under', 'and below',
  'یان کەمتر', 'و کەمتر', 'کەمتر', 'بۆ خوارەوە', 'خوارتر', 'زیاتر نەبێت', 'زیاتر نەبێ', 'زیاتر نەبێتن',
  // Iraqi «ونازل» (and down); "or lower"; the Sorani copula («لە 30 هەزار کەمترە», "is less than") and the post
  // forms of «هەرزانتر لە», «نزمتر لە» («لە 30 هەزار هەرزانتر», cheaper than 30,000); «زیاتر نییە» (is not more).
  'ونازل', 'و نازل', 'فنازل', 'فما نازل', 'وانت نازل', 'او انزل', 'وانزل',
  'or lower', 'or cheaper', 'and lower', 'and less', 'or lesser',
  'کەمترە', 'یان کەمترە', 'هەرزانتر', 'هەرزانترە', 'نزمتر', 'نزمترە', 'خوارترە', 'زیاتر نییە', 'زیاتر نیە'
);
/** «مليون وفوق»: a lower bound after the amount. */
const MIN_POST = phrases(
  'واكثر', 'و اكثر', 'او اكثر', 'فما فوق', 'وفوق', 'او فوق', 'كحد ادنى', 'حد ادنى', 'على الاقل',
  'or more', 'or above', 'and above', 'and up', 'at least',
  'یان زیاتر', 'و زیاتر', 'زیاتر', 'بۆ سەرەوە', 'کەمتر نەبێت', 'کەمتر نەبێ', 'کەمتر نەبێتن',
  // Iraqi «وطالع» (and up); "or higher"; the Sorani copula («لە 500 هەزار زیاترە», "is more than") and the post
  // forms of «گرانتر لە», «بەرزتر لە»; «کەمتر نییە» (is not less); «بەلایەنی کەمەوە» (at least) after the amount.
  'وطالع', 'و طالع', 'فطالع', 'فما طالع', 'وانت طالع', 'وصاعد', 'و صاعد', 'فما اعلى',
  'or higher', 'or greater', 'or over', 'and over', 'and higher', 'or up',
  'زیاترە', 'یان زیاترە', 'گرانتر', 'گرانترە', 'بەرزتر', 'بەرزترە', 'کەمتر نییە', 'کەمتر نیە',
  'بەلایەنی کەمەوە', 'بە لایەنی کەمەوە', 'لانی کەمەوە'
);
/**
 * One English word after the amount, a bound only after a money word or k: "30k max", "500 الف plus".
 * After a bare number it is a model name: "Kobra 3 Max", "Neptune 4 Max", "Kobra 2 Plus".
 */
const MAX_POST_UNIT = phrases('max');
const MIN_POST_UNIT = phrases('plus', '+', 'min');
/**
 * A measure or a count after a bare number: «اقل من 1 كيلو» is a weight, "under 300mm" a size,
 * «اقل من 3 قطع» a count, "up to 300°C" a temperature. Never a price, and the words stay in the search.
 */
const MEASURE_WORDS = new Set(
  [
    'kg', 'kgs', 'kilo', 'kilos', 'g', 'gr', 'gm', 'gram', 'grams', 'lb', 'lbs', 'oz',
    'mm', 'cm', 'mm/s', 'mms', 'um', 'micron', 'microns', 'nm', 'inch', 'inches', 'x', '×',
    'ml', 'liter', 'litre', 'liters', 'litres', '°c', '°', 'c', 'celsius', 'degree', 'degrees',
    'w', 'watt', 'watts', 'v', 'volt', 'volts', 'amp', 'amps', 'mah', 'hz', 'rpm', 'millimeter', 'millimetre',
    'meter', 'metre', 'meters', 'metres',
    'pcs', 'pc', 'piece', 'pieces', 'pack', 'packs', 'rolls', 'day', 'days', 'hour', 'hours', 'minute', 'minutes', 'year', 'years',
    'milliliter', 'millilitre', 'milliliters', 'millilitres',
    // Time, length and power in their short forms: "under 10 min", "2 hrs", "30 ft", "1kw" are never a price.
    'second', 'seconds', 'sec', 'secs', 'min', 'mins', 'hr', 'hrs', 'h', 'week', 'weeks', 'wk', 'wks', 'month', 'months',
    'ft', 'feet', 'foot', 'yard', 'yards', 'kw', 'kilowatt', 'kilowatts', 'kwh',
    // The spellings people type for a length: "30 centimeters", «30 سانتي», «7 انج», a 7" screen.
    'centimeter', 'centimetre', 'centimeters', 'centimetres', 'millimeters', 'millimetres', 'cms', 'km', 'kms', '"',
    'كيلو', 'كيلوغرام', 'كيلوجرام', 'كغم', 'كغ', 'غرام', 'جرام', 'غم', 'ملم', 'مم', 'ملي', 'مليمتر', 'ميليمتر',
    'سم', 'سنتي', 'سنتيمتر', 'مل', 'لتر', 'متر', 'امتار', 'درجة', 'درجات', 'واط', 'فولت', 'امبير', 'انش', 'بوصة',
    'قطع', 'قطعة', 'حبة', 'حبات', 'حبه', 'رول', 'رولات', 'يوم', 'ايام', 'ساعة', 'ساعات', 'دقيقة', 'دقائق', 'سنة', 'سنوات', 'شهر', 'اشهر',
    'مليلتر', 'ملليتر', 'ثانية', 'ثواني', 'ثوان', 'ثانيتين', 'دقايق', 'اسبوع', 'اسابيع', 'اسبوعين', 'شهور', 'شهرين', 'ساعتين',
    'قدم', 'اقدام', 'كيلوواط',
    'سانتي', 'سانتيم', 'سانتيمتر', 'سانتيمترات', 'سنتيم', 'سنتم', 'سنتيمترات', 'سانتيات', 'انج', 'انچ', 'انشات', 'بوصات',
    'مترين', 'كيلوات', 'كيلوين', 'كيلوهات', 'غرامات', 'لترات', 'لترين', 'ملمات',
    'کیلۆ', 'کیلۆگرام', 'گرام', 'ملیم', 'ملیمەتر', 'ملیمێتر', 'سانتیم', 'سانتیمەتر', 'سانتیمێتر', 'لیتر', 'ملیلیتر',
    'پلە', 'وات', 'ڤۆڵت', 'ئینج', 'پارچە', 'دانە', 'مەتر', 'مێتر', 'ڕۆژ', 'کاتژمێر', 'سەعات', 'خولەک', 'دەقیقە', 'ساڵ', 'مانگ',
    'چرکە', 'چرکەی', 'هەفتە', 'هەفتەی', 'حەفتە', 'کیلۆوات',
    // «2 کیلۆی PLA» is two kilos of PLA: after a number the Sorani «-ی» form is a quantity (before a price, SORANI_PER_LEAD).
    'کیلۆی', 'گرامی', 'دانەی', 'پارچەی', 'لیتری', 'مەتری',
  ].map(nlFold)
);
/**
 * Sorani endings on a measure word after a number: the ezafe «-ی» («300 پلەی سەدی» 300 °C, «3 ڕۆژی کار» three
 * working days, «6 مانگی» six months), the locative «-دا» («3 ڕۆژدا» in three days, «2 هەفتەدا»), the plural «-ان»
 * («3 ڕۆژان»), and the definite «-ەکە», «-ەکان». The measure is the word without it. Arabic-script words only.
 */
const MEASURE_ENDINGS = ['ی', 'دا', 'یدا', 'ان', 'ەکان', 'ەکە', 'ەدا'].map(nlFold);
const ARABIC_SCRIPT = /[\u0600-\u06ff]/u;
/** A measure or a count word, the Sorani indefinite («کاتژمێرێک» an hour, «پلەیەک» a degree) and the endings above too. */
function measureWord(v: string): boolean {
  if (MEASURE_WORDS.has(v)) return true;
  const u = soraniUnit(v);
  if (u !== null && MEASURE_WORDS.has(u)) return true;
  if (!ARABIC_SCRIPT.test(v)) return false;
  for (const e of MEASURE_ENDINGS) if (v.length - e.length >= 2 && v.endsWith(e) && MEASURE_WORDS.has(v.slice(0, -e.length))) return true;
  return false;
}
/**
 * The units things are SOLD by: weight, a piece, a roll or a spool, a volume, a length of tube or wire. After
 * «per» (PER_WORDS, a slash) or glued as «للكيلو», «لكيلو», «بالمتر» (PER_PREFIXES), a number before one is a
 * PRICE PER UNIT, not a quantity: «اقل من 25 للكيلو», "30 per kg", "25/kg", «لكل قطعة», «بۆ هەر کیلۆ»; the price
 * stands and the words go with it. A length, a temperature, a power or a time is not sold by: «اقل من 30 للسم»,
 * «بالدرجة», "per hour" stay measures, never a price.
 */
const SOLD_UNITS = new Set(
  [
    'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'g', 'gr', 'gm', 'gram', 'grams',
    'piece', 'pieces', 'pc', 'pcs', 'roll', 'rolls', 'spool', 'spools',
    'liter', 'litre', 'liters', 'litres', 'ml', 'milliliter', 'millilitre', 'meter', 'metre', 'meters', 'metres',
    'كيلو', 'كيلوغرام', 'كيلوجرام', 'كغم', 'كغ', 'غرام', 'جرام', 'غم', 'قطعة', 'حبة', 'دانة', 'رول', 'بكرة', 'سبول',
    'لتر', 'مل', 'متر', 'مليلتر', 'ملليتر',
    'کیلۆ', 'کیلۆگرام', 'گرام', 'دانە', 'پارچە', 'ڕۆڵ', 'ماسوورە', 'لیتر', 'ملیلیتر', 'مەتر', 'مێتر',
  ].map(nlFold)
);
/**
 * The Sorani indefinite «a …» («-ێک» after a consonant, «-یەک» after a vowel): «کیلۆیەک» a kilo, «ملیلیترێک» a
 * millilitre, «کاتژمێرێک» an hour, «پلەیەک» a degree. The unit is the word without it.
 */
const SORANI_A = ['یەک', 'ێک'].map(nlFold);
const soraniUnit = (v: string): string | null => {
  for (const s of SORANI_A) if (v.length > s.length + 1 && v.endsWith(s)) return v.slice(0, -s.length);
  return null;
};
/** Sorani «a kilo», «a piece», «a millilitre»: after an amount a price per unit by itself («25 هەزار کیلۆیەک»), and after «بۆ», «بۆ هەر». */
const soraniPerUnit = (v: string): boolean => {
  const u = soraniUnit(v);
  return u !== null && SOLD_UNITS.has(u);
};
/** Before a price, Sorani «of the kilo» or «a kilo»: «کیلۆی کەمتر لە 25 هەزار», «کیلۆی لە 25 هەزار کەمتر», «کیلۆی بە 25 هەزار». */
const SORANI_PER_LEAD = new Set(['کیلۆی', 'گرامی', 'دانەی', 'پارچەی', 'لیتری', 'مەتری'].map(nlFold));
const soraniPerLead = (v: string): boolean => SORANI_PER_LEAD.has(v) || soraniPerUnit(v);
const PER_WORDS = phrases('per', 'each', 'لكل', 'كل', 'بۆ هەر', 'هەر', 'بۆ');
const PER_PREFIXES = ['بال', 'لل', 'ل'];
/** Sorani «بە» ("at", "for") before an amount, like «ب»: «کیلۆی بە 25 هەزار». */
const SORANI_AT = nlFold('بە');
/** «بين 500 الف و مليون»: a range opener («من» and "from" alone are a lower bound). */
const RANGE_OPEN = phrases('بين', 'between', 'لە نێوان', 'من', 'from', 'لە');
const RANGE_MIN_ALONE = phrases('من', 'from');
/** Between the two ends of a range: "from 20k up to 30k", "till", «لغاية», «هەتاوەکو» too. */
const RANGE_SEP = phrases(
  'و', 'الى', 'حتى', 'لحد', 'ل', 'and', 'to', '-', '&', 'تا', 'بۆ', 'هەتا',
  'up to', 'upto', 'and up to', 'till', 'until', 'through', 'thru', 'لغاية', 'ولغاية', 'الى حد', 'وحتى', 'هەتاوەکو', 'تاوەکو'
);
/** Between two bare amounts («250-400 الف», «500 الف الى مليون»): never «و», which joins number words. */
const BARE_SEP = phrases('-', 'الى', 'to', 'تا', 'حتى', 'لحد');
/** A Sorani amount stands after «لە» when its bound comes last («لە 30 هەزار کەمتر»). */
const SORANI_FROM = nlFold('لە');
/**
 * The Sorani ablative «-ەوە» on an amount: «لە 20 هەزارەوە تا 30 هەزار» (from 20,000 to 30,000), «لە 500ەوە»,
 * «لە ملیۆنێکەوە». The lexer splits it off a number word; the amount reads it as its own end.
 */
const ABLATIVE = nlFold('ەوە');

/** Below this a bare number counts thousands; from it, dinars as written. */
const BARE_IN_FULL_FROM = 1000;
/**
 * A bare number beside a bound (no money word, no separator), in dinars, for an upper and a lower bound
 * alike. Below 1,000 it counts thousands (Iraqi shorthand: «اقل من 30» is 30,000, «اكثر من 500» 500,000,
 * 999 is 999,000); from 1,000 it is dinars as written («اقل من 30000» is 30,000, «اكثر من 20000» 20,000,
 * 1000 is 1,000). Grouped in threes («30,000») it never comes here: it is written in full.
 */
function bareDinars(n: number): number {
  return Math.round(n < BARE_IN_FULL_FROM ? n * 1000 : n);
}

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
/**
 * The thousand and million words. `k`, `m` and "mil" are WEAK: a price only beside a bound («under 30k», "under 2
 * mil»), never bare («8K» is a resin screen).
 */
const MULTS = wordMap<{ v: number; weak: boolean }>([
  [{ v: 1e3, weak: false }, 'الف الاف آلاف thousand thousands هەزار هزار'],
  [{ v: 1e6, weak: false }, 'مليون ملايين ميليون million millions ملیۆن'],
  [{ v: 1e3, weak: true }, 'k ك'],
  [{ v: 1e6, weak: true }, 'm mn mil'],
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
  'متوفر', 'متوفرة', 'متاح', 'متاحة', 'موجود', 'موجودة', 'جاهز', 'جاهزة', 'بالمخزن', 'بالمخزون',
  // A feature is named with "direct", "ready" and "available" ("direct drive", «دفع مباشر», "AMS
  // ready", "available colors"): alone they are search words, and only these phrases are the sale mode.
  'بيع مباشر', 'شراء مباشر',
  'in stock', 'instock', 'available now', 'now available', 'currently available', 'available in stock',
  'ready to ship', 'ready stock', 'direct sale', 'direct sales',
  'بەردەست', 'بەردەستە', 'ئامادە', 'ئامادەیە', 'لە کۆگا', 'لە کۆگادا', 'فرۆشتنی ڕاستەوخۆ'
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
/** «بكرة فارغة» is an empty spool, «حامل بكرة» a holder and "reusable spool" a spool: products, not the spool facet. */
const SPOOL_GUARD = new Set(
  (
    'فارغة فارغ فاضية فاضي empty بەتاڵ حامل holder هولدر stand ستاند حمالة ' +
    'reusable قابلة قابل adapter adaptor محول محولة ئەداپتەر buffer بفر'
  )
    .split(' ')
    .map(nlFold)
);
/**
 * A bare spool word or diameter is the facet only when the query is about filament: «PLA بكرة»,
 * "filament 1.75". Alone it is a product name («Bambu Reusable Spool», "PTFE 1.75", a spool adapter),
 * and the facet would hide every product without a spool type or a diameter.
 */
const FILAMENT_WORDS = new Set(
  'فلامنت فلمنت فيلمنت فيلامنت خيط خيوط filament filaments فیلامێنت فلامێنت'.split(' ').map(nlFold)
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
  'هەرزان', 'هەرزانتر', 'هەرزانترین'
);
const DEAR = phrases('غالي', 'غالية', 'اغلى', 'اغلى شي', 'expensive', 'most expensive', 'گران', 'گرانترین');

/** Negation: what follows is excluded, or the opposite constraint. */
const NEGATION = phrases(
  'بدون', 'بلا', 'بلاش', 'مو', 'مش', 'موب', 'غير', 'ليس', 'لا', 'دون', 'عدا', 'ماعدا', 'باستثناء', 'الا', 'من غير',
  'ما اريد', 'ما ابي', 'ما احتاج', 'ما بيه', 'مابيه', 'ما فيه', 'مافيه',
  'without', 'w/o', 'no', 'not', 'non', 'neither', 'except', 'excluding', 'exclude', 'dont want', 'do not want', 'no need for',
  'بێ', 'بەبێ', 'نەک', 'نا', 'بێجگە', 'بێجگە لە', 'جگە لە', 'بەدەر لە', 'نامەوێت',
  // «نە ڕەش نە سپی»: the Sorani "neither … nor", each «نە» a negation of its own.
  'نە'
);

/** Iraqi «ما» before a known constraint is "not" («ما متوفر», «PLA ما متوفر», «ما اسود»); before anything else, "what". */
const MA = nlFold('ما');
/**
 * Between a negation and what it negates: a colour noun before a colour («بدون اللون الاسود», «بدون لون اسود», «مو
 * باللون الاسود», «بێ ڕەنگی سپی», "without colour black"), the article written apart («بدون الـ AMS», «بدون ال
 * PLA», "without the black"), "in" ("not in black") or "even" («ولا حتى ابيض», "or even white», «یان تەنانەت
 * ڕەش»). The negation reaches over them to the item; they go with it and are never left out themselves.
 */
const COLOUR_NOUNS = new Set(['لون', 'اللون', 'الوان', 'colour', 'color', 'colours', 'colors', 'ڕەنگ', 'ڕەنگی', 'رەنگ', 'رەنگی'].map(nlFold));
const NEG_ARTICLES = new Set(['ال', 'the'].map(nlFold));
const NEG_FILLERS = new Set(['in', 'a', 'an', 'any'].map(nlFold));
const EVEN = new Set(['even', 'حتى', 'تەنانەت'].map(nlFold));
/** The list words of a Sorani post negation: «ڕەش و سپی نەبێت», «ڕەش یان سپی نەبێت». */
const POST_LIST = new Set(['و', 'یان', 'او', 'or', 'and'].map(nlFold));

/**
 * The Sorani verb negation written AFTER what it negates: «ڕەش نەبێت» (not black), «PLA نەبێت», «بەردەست نییە» (not
 * available), «کەمتر لە 20 هەزار نەبێت» (not less than 20,000).
 */
const NEG_POST = phrases('نەبێت', 'نەبێ', 'نەبێتن', 'نەبن', 'نییە', 'نیە', 'نابێت');

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

/**
 * Words a query is written with and not about: never an exclusion, and alone they are no search. The function
 * words "just", "only", "even", «بس», «فقط», «حتى», «لەگەڵ», «تەنها» among them: «بدون AMS او بس كومبو» leaves
 * out the AMS and never «بس».
 */
const FILLERS = new Set(
  [
    'i', 'a', 'an', 'the', 'want', 'need', 'show', 'me', 'please', 'any', 'some', 'for', 'with', 'of', 'in',
    'just', 'only', 'even', 'also',
    'اريد', 'ابي', 'ابغى', 'بدي', 'ريد', 'احتاج', 'اكو', 'عندكم', 'عدكم', 'شي', 'ممكن', 'رجاء', 'في', 'من', 'على', 'مع',
    'بس', 'فقط', 'حتى', 'ايضا', 'هم',
    'دەمەوێت', 'دەوێت', 'تکایە', 'هەیە', 'پێویستم', 'بۆ', 'لە', 'بە',
    'لەگەڵ', 'تەنها', 'تەنیا', 'بەس', 'تەنانەت', 'هەروەها', 'هەم',
  ].map(nlFold)
);
/** «ولا» and «والا» are the Iraqi "or" («PLA ولا PETG»): their «لا» and «الا» are not a negation. */
const CONJUNCTIONS = new Set(['و', 'او', 'and', 'or', 'nor', '&', '-', 'یان', 'ولا', 'والا'].map(nlFold));
/**
 * "Or" right after a negation carries it on to the next word, in every language: «بدون AMS ولا كومبو», «بدون
 * AMS والا كومبو», «بدون AMS او كومبو», "without AMS or combo", "without AMS nor combo", «بێ AMS یان کۆمبۆ»
 * leave out both. Anywhere else it is "or": "AMS or combo" lists both.
 */
const NEGATION_OR = new Set(['ولا', 'والا', 'او', 'or', 'nor', 'یان'].map(nlFold));

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
/** A slash opens a run of its own: «25k/kg» is 25, k and /kg. A dash too: «20الف-30الف», "20k-30k" are 20, الف, -, 30, الف. */
const RUNS = /[<>≤≥]|\$|\+|\d+(?:[.,]\d+)*|\/[^\d$<>≤≥+/]*|[-–—~]+|[^\d$<>≤≥+/\-–—~]+/g;
/** An inch mark on a number: «7"» is 7 and an inch. */
const INCH = /^(\d+(?:[.,]\d+)?)["”″′]+$/u;
const ARABIC_PREFIXES = ['وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل'];

/** A number or money word («هەزار», «ملیۆنێک», «دینار»): the Sorani ablative «-ەوە» comes off it. */
const amountWord = (w: string, min = 2): boolean => /^\d+(?:[.,]\d+)*$/.test(w) || (w.length >= min && classify(w) !== null);
/** «هەزارەوە» → «هەزار», «ەوە»; «500ەوە» → 500, «ەوە». Anything else as it is. */
function ablative(lx: string[]): string[] {
  return lx.flatMap((w) =>
    w.length > ABLATIVE.length && w.endsWith(ABLATIVE) && amountWord(w.slice(0, -ABLATIVE.length)) ? [w.slice(0, -ABLATIVE.length), ABLATIVE] : [w]
  );
}

/** One piece of the input → its lexemes: «30k» is 30 and k, «1.75mm» 1.75 and mm, «$500» $ and 500; «X1C» stays whole. */
function lexemesOf(piece: string): string[] {
  let f = nlFold(piece).replace(/['’`]/g, '');
  if (DASH.test(f)) return ['-'];
  f = f.replace(LEAD, '');
  const inch = INCH.exec(f);
  if (inch) return [inch[1], '"'];
  f = f.replace(TRAIL, '');
  if (!f) return [];
  if (NUMERIC_START.test(f)) return ablative(f.match(RUNS) ?? [f]);
  // «ب500», «و50», «ال30»: the preposition or the article is a lexeme of its own.
  const glued = /^(ال|[بول])(\d.*)$/u.exec(f);
  if (glued) return [glued[1], ...ablative(glued[2].match(RUNS) ?? [])];
  // «الف-30» («20 الف-30 الف»), "k-30k": a money word, a dash and the next amount.
  const dashed = /^(\p{L}+)[-–—~]+(\d.*)$/u.exec(f);
  if (dashed && amountWord(dashed[1], 1)) return [...ablative([dashed[1]]), '-', ...ablative(dashed[2].match(RUNS) ?? [])];
  // "non-combo", "non-black": a negation of a known term. "Non-Slip", "Non-Stick" are product words, kept whole.
  const non = /^non-(.+)$/.exec(f);
  if (non && (EXCLUDE_CANON.has(non[1]) || COLOURS.has(non[1]) || MATERIALS.has(non[1]))) return ['non', non[1]];
  return ablative([f]);
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
  /**
   * For each understood chip (`nlChipKey`), the input with that chip's words
   * taken out and every other word kept as typed: the text a removed chip
   * leaves in the search field (smart search 1.7). Read again, it gives the
   * same answer less that one constraint.
   */
  without: Record<string, string>;
}

/** One chip's identity, the key of `NlQuery.without`: «price», «color:black», «color!:black», «exclude:ams». */
export function nlChipKey(c: NlChip): string {
  if (c.kind === 'color' || c.kind === 'material') return `${c.kind}${c.not ? '!' : ''}:${c.value}`;
  if (c.kind === 'diameter' || c.kind === 'exclude') return `${c.kind}:${c.value}`;
  return c.kind;
}

// ------------------------------------------------------------------ the parser

interface Amount {
  value: number;
  end: number;
  /** strong: a thousand/million word or a currency; weak: k or m only; null: a bare number. */
  unit: 'strong' | 'weak' | null;
  /** Written with a thousands separator («30,000», «٣٠٬٠٠٠»): a number in full, never thousands. */
  grouped: boolean;
  maxMult: number;
  /**
   * The scale a bare count beside it shares in a range: what its one leading count is multiplied by («3 مية الف»
   * 100,000, «5 ورقات» 100, «30 الف» 1,000, «5 مية» 100), else its largest money word (`maxMult`); 0 for none.
   */
  share: number;
  cur: 'IQD' | 'USD' | null;
  /** Written with the Sorani ablative «-ەوە»: «لە 20 هەزارەوە» (from 20,000). */
  from: boolean;
}

/** «30,000», «1.500.000»: digits in groups of three, the way a price is written in full. */
const GROUPED = /^\d{1,3}(?:,\d{3})+$|^\d{1,3}(?:\.\d{3}){2,}$/;

function digitValue(f: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(f)) return null;
  let t: string;
  if (GROUPED.test(f)) t = f.replace(/[.,]/g, '');
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
  // The Sorani indefinite of a money word: «ملیۆنێک» a million, «هەزارێک» a thousand, «نیوێک» a half.
  const u = soraniUnit(f);
  if (u !== null) {
    const m = MULTS.get(u);
    if (m && !m.weak) return { k: 'mult', v: m.v, weak: false };
    const fr = FRACS.get(u);
    if (fr !== undefined) return { k: 'frac', v: fr };
    if (HUNDRED.has(u)) return { k: 'hundred' };
  }
  return null;
}

type Prev = 'digit' | 'word' | 'mult' | 'frac' | null;

/** The places a number word fills below a thousand: the hundreds, the tens, the units (a teen fills both). */
const UNITS = 1;
const TENS = 2;
const HUNDREDS = 4;
/** The place of a number word; a count right before «مية» / «سەد» («دوو سەد») is a hundreds term. */
function placeOf(c: NumClass, hundredAhead: boolean): number {
  if (c.k === 'hundred') return HUNDREDS;
  if (c.k !== 'n') return 0;
  if (c.v >= 100 || (c.v < 10 && hundredAhead)) return HUNDREDS;
  if (c.v >= 20) return TENS;
  return c.v >= 10 ? TENS | UNITS : UNITS;
}

/**
 * May «و» join this to the number so far? «خمسة وعشرين», «بیست و پێنج», «مية وخمسين», «مليون ونص», «مليون و 500
 * الف» — not two digit runs, which are a range, and never one place twice: «عشرين وثلاثين», «مية وميتين», «سەد و
 * دوو سەد» are two numbers (a range's two ends), never their sum. Hundreds come first («مية وخمسة»).
 */
function joins(prev: Prev, next: NumClass, range: boolean, places = 0, hundredAhead = false): boolean {
  if (next.k === 'frac') return prev === 'mult';
  if (next.k === 'n' || next.k === 'hundred') {
    if (!(prev === 'word' || (prev === 'mult' && !range))) return false;
    const place = placeOf(next, hundredAhead);
    return place === HUNDREDS ? places === 0 : (places & place) === 0;
  }
  if (next.k === 'digit') return prev === 'mult' && !range;
  return false;
}

/**
 * May a half or a quarter join the count before it («2 ونص مليون», «یەک و نیو ملیۆن», "2 and a half million")? Only
 * once, right after a count, and only before a thousand or million word (`scaled`) or as a range end («بين 2 ونص و
 * 3 مليون»): «اقل من 2 ونص» alone is left as it was.
 */
function countHalf(prev: Prev, halved: boolean, scaled: boolean): boolean {
  return !halved && (prev === 'digit' || prev === 'word') && scaled;
}

export function parseNlQuery(input: string): NlQuery {
  const pieces = String(input ?? '').split(/\s+/u).filter(Boolean);
  const L: Lex[] = [];
  pieces.forEach((p, piece) => {
    for (const f of lexemesOf(p)) L.push({ f, v: variantsOf(f), piece });
  });
  const used = new Array<boolean>(L.length).fill(false);
  /** The query is about filament: a filament or material word anywhere in it («PLA+» too). */
  const aboutFilament = L.some((l) => l.v.some((v) => FILAMENT_WORDS.has(v) || MATERIALS.has(v.replace(/\+$/, ''))));
  /** Which chip (`nlChipKey`) each lexeme went to: a removed chip takes exactly its own words out of the field. */
  const owner = new Array<string>(L.length).fill('');
  /** A second chip a lexeme also goes with: the list word between two items of a Sorani post negation. */
  const alsoOwner = new Array<string>(L.length).fill('');
  let who = '';
  const take = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      used[k] = true;
      owner[k] = who;
    }
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
    let grouped = false;
    /** The places filled since the last thousand or million word (`placeOf`). */
    let places = 0;
    /** The counts read (digits or number words), the first of them, and whether one came after a scale word. */
    let terms = 0;
    let lead = 0;
    let termAfterScale = false;
    let scaled = false;
    let halved = false;
    const classAt = (k: number): NumClass | null => (k < L.length && !used[k] ? classify(L[k].f) : null);
    const hundredAt = (k: number): boolean => classAt(k)?.k === 'hundred';
    /** A thousand or million word or a counted note at k: «2 ونص مليون», "2 and a half million". */
    const scaleAt = (k: number): boolean => {
      const c = classAt(k);
      return !!c && (c.k === 'mult' || (c.k === 'cur' && c.scale > 1));
    };
    // «ب 500 الف», «بە 25 هەزار»; after a bound the article too: «تحت ال 500», «اقل من ال30».
    if (j < L.length && !used[j] && (L[j].f === 'ب' || L[j].f === SORANI_AT || (o.bound && L[j].f === 'ال'))) j++;
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
        // "2 and a half million": the article before the half.
        const art = j + 2 < L.length && !used[j + 1] && (L[j + 1].f === 'a' || L[j + 1].f === 'an') && classAt(j + 2)?.k === 'frac' ? 1 : 0;
        const nx = classAt(j + 1 + art);
        const half = !!nx && nx.k === 'frac' && countHalf(prev, halved, scaleAt(j + 2 + art) || !!o.range);
        if (!have || !nx || !(half || joins(prev, nx, !!o.range, places, hundredAt(j + 2)))) break;
        joined = true;
        width = 2 + art;
        f = L[j + 1 + art].f;
      } else if (have && f.length > 1 && f.startsWith('و')) {
        const nx = classify(f.slice(1));
        const half = !!nx && nx.k === 'frac' && countHalf(prev, halved, scaleAt(j + 1) || !!o.range);
        if (nx && (half || joins(prev, nx, !!o.range, places, hundredAt(j + 1)))) {
          joined = true;
          f = f.slice(1);
        }
      }
      let c = classify(f);
      // "a thousand", "a hundred", "a million": the article is one of them.
      if (!c && !have && (f === 'a' || f === 'an')) {
        const nx = classAt(j + 1);
        if (nx && (nx.k === 'hundred' || (nx.k === 'mult' && !nx.weak) || (nx.k === 'cur' && nx.scale > 1))) c = { k: 'n', v: 1 };
      }
      // «بمليون», «وعشرين» at the start: the preposition glued to the first word.
      if (!c && !have && f.length > 2 && /^[بول]/u.test(f)) c = classify(f.slice(1));
      // «تحت المليون», «اقل من الالف»: after a bound, the article on the first word.
      if (!c && !have && o.bound && f.length > 3 && f.startsWith('ال')) c = classify(f.slice(2));
      if (!c) {
        if (prev === 'frac' && (f === 'a' || f === 'an')) {
          j++;
          continue;
        }
        break;
      }
      if (c.k === 'digit' || c.k === 'n') {
        if (prev === 'digit' || prev === 'frac' || (prev === 'word' && c.k === 'digit') || (prev === 'mult' && !joined)) break;
        if (prev === 'word' && !joined && (places & placeOf(c, false)) !== 0) break;
        if (halved) break;
        cur += c.v;
        if (c.k === 'digit' && GROUPED.test(f)) grouped = true;
        places |= placeOf(c, false);
        prev = c.k === 'digit' ? 'digit' : 'word';
        if (!terms) lead = c.v;
        terms++;
        if (scaled) termAfterScale = true;
      } else if (c.k === 'hundred') {
        if ((prev === 'mult' && !joined) || (places & HUNDREDS) || halved) break;
        cur = (cur || 1) * 100;
        places = HUNDREDS;
        prev = 'word';
        scaled = true;
      } else if (c.k === 'mult') {
        if (prev === 'mult' || (c.weak && prev !== 'digit')) break;
        // A bare «الف» is a letter or a word; a bare «مليون» is a price.
        if (!have && c.v < 1e6 && !o.bound) break;
        total += (cur || 1) * c.v;
        cur = 0;
        places = 0;
        halved = false;
        scaled = true;
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
        } else if (joined && countHalf(prev, halved, true)) {
          // «2 ونص مليون», «دوو و نیو ملیۆن», "2 and a half million": the half joins the count before the word.
          cur += c.v;
          halved = true;
        } else break;
      } else {
        // A currency word ends the amount. «ورقة» needs a count or a bound: alone it is a sheet of paper.
        if (currency && currency !== c.cur) break;
        if (c.scale > 1) {
          if (prev === 'mult' || prev === 'frac' || (!have && !o.bound)) break;
          total += (cur || 1) * c.scale * (c.dual ? 2 : 1);
          cur = 0;
          halved = false;
          scaled = true;
          // «بين 3 و 5 ورقات»: the note is the unit a bare end beside it shares (rangeEnds), like «الف».
          maxMult = Math.max(maxMult, c.scale);
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
    // «لە 20 هەزارەوە»: the ablative glued to the amount is read with it.
    let from = false;
    if (j < L.length && !used[j] && j > start && L[j].f === ABLATIVE && L[j].piece === L[j - 1].piece) {
      from = true;
      j++;
    }
    const perLead = terms === 1 && !termAfterScale && lead > 0 ? value / lead : 0;
    const share = perLead > 1 ? perLead : maxMult;
    return { value, end: j, unit, grouped, maxMult, share, cur: currency, from };
  };

  /** An amount as a price: dollars as typed; dinars; a bare number only beside a bound (Iraqi shorthand: «اقل من 30» is 30,000). */
  const priceOf = (a: Amount, bound: boolean): { v: number; cur: 'IQD' | 'USD' } | null => {
    if (a.cur === 'USD') return { v: Math.round(a.value), cur: 'USD' };
    if (a.unit === 'strong' || (a.unit === 'weak' && bound)) return { v: Math.round(a.value), cur: 'IQD' };
    if (!bound || a.unit === 'weak') return null;
    return { v: a.grouped ? Math.round(a.value) : bareDinars(a.value), cur: 'IQD' };
  };

  /** A measure or a count, the Sorani indefinite too («کاتژمێرێک» an hour, «پلەیەک» a degree, «واتێک» a watt). */
  const isMeasure = (k: number): boolean => k >= 0 && k < L.length && L[k].v.some(measureWord);
  const soldAt = (k: number): boolean => k >= 0 && k < L.length && !used[k] && L[k].v.some((v) => SOLD_UNITS.has(v) || soraniPerUnit(v));
  /** Lexeme k is a number: «2 کیلۆی» after it is a quantity, two kilos, not «of the kilo». */
  const numberAt = (k: number): boolean => {
    if (k < 0 || k >= L.length) return false;
    const c = classify(L[k].f);
    return c !== null && (c.k === 'digit' || c.k === 'n');
  };
  /** A slash stands right before lexeme k: "25/kg", "25k/kg", "25 /kg", "25/ kg", "25 / kg". */
  const afterSlash = (k: number): boolean => {
    if (L[k].f.startsWith('/')) return true;
    const prev = k > 0 ? L[k - 1].piece : -1;
    if (prev === L[k].piece) return false;
    if (pieces[L[k].piece].startsWith('/') || (prev >= 0 && pieces[prev].endsWith('/'))) return true;
    return pieces.slice(prev + 1, L[k].piece).some((p) => /^\/+$/.test(p));
  };
  /**
   * How many lexemes from k say "per unit sold" («للكيلو», "per kg", «لكل قطعة», "/kg", «بۆ هەر کیلۆیەک»,
   * «کیلۆیەک»): 0 when they do not, and 0 before a unit nothing is sold by («للسم», "per hour").
   */
  const perUnit = (k: number): number => {
    if (k >= L.length || used[k]) return 0;
    const f = L[k].f;
    if (soraniPerUnit(f)) return 1;
    if (soldAt(k) && (afterSlash(k) || PER_PREFIXES.some((p) => f.length > p.length && f.startsWith(p) && SOLD_UNITS.has(f.slice(p.length))))) return 1;
    const w = longest(k, PER_WORDS);
    return w && soldAt(k + w) ? w + 1 : 0;
  };
  /**
   * "Per unit" words BEFORE the price, from j: «کیلۆی کەمتر لە 25 هەزار», «بۆ هەر کیلۆیەک کەمتر لە 25 هەزار»,
   * "per kg under 25"; after a price word the unit alone («سعر الكيلو اقل من 25 الف», «نرخی کیلۆ»). Taken only
   * when a price follows.
   */
  const perLead = (j: number, afterPriceWord: boolean): number => {
    if (j >= L.length || used[j]) return 0;
    if ((soraniPerLead(L[j].f) && !numberAt(j - 1)) || (afterPriceWord && soldAt(j))) return 1;
    const w = longest(j, PER_WORDS);
    return w && soldAt(j + w) ? w + 1 : 0;
  };
  /**
   * A bare number with a measure or a count after it («1 كيلو», "300mm", «3 قطع»), or per a unit nothing is sold by
   * («30 للسم», "50 per hour", «لكل ساعة»): never a price. Per a unit sold («25 للكيلو») it is one.
   */
  const measured = (a: Amount): boolean =>
    a.unit === null && !perUnit(a.end) && (isMeasure(a.end) || isMeasure(a.end + longest(a.end, PER_WORDS)));
  /** Where a price read up to `end` stops: past the "per unit" words that qualify it. */
  const priceEnd = (end: number): number => end + perUnit(end);

  /**
   * The two ends of one range, `a` the end written first after the opener («بين», "between", «من», «لە
   * نێوان») and `b` the second, or with `bounds` the «more than» bound of two and the «less than» one, read
   * together (policy b). Returned as read, not yet in order.
   *   - Two bare ends: each by the rule («بين 5000 و 15000» is 5,000 to 15,000, «بين 500 و 900» 500,000 to
   *     900,000, «بين 5,000 و 15» 5,000 to 15,000). When that inverts the order written, the smaller end
   *     written is read as written too: «بين 500 و 1200» (would be 500,000 to 1,200) and «اكثر من 500 واقل من
   *     1500» are 500 to 1,200 and 500 to 1,500; written high-to-low, «بين 1500 و 500» (would be 1,500 to
   *     500,000) is 1,500 down to 500, the same answer as «بين 500 و 1500». A first end ten times the second or
   *     more is not one written high-to-low («بين 5,000 و 15» is 5,000 to 15,000). Two bounds say which end is
   *     the low one themselves.
   *   - A bare end below 1,000 beside an end with a money word («الف», «مليون», «ورقة») shares that word,
   *     whichever side the word is on («بين 2 و 3 مليون», «بين 25 و 50 الف», «بين 500 الف و 400», «بين 3 و 5
   *     ورقات»), and written high-to-low too: «بين 50 و 25 الف» is 50,000 down to 25,000, «بين 3 و 2 مليون» three
   *     million down to two. Counts ten times apart or more are not one money word shared: «بين 500 و 1 مليون»
   *     and «بين مليون و 500» are both 500,000 to a million (but «بين 1 و 500 مليون», written up to the word,
   *     is a million to 500 million).
   *   - Otherwise the rule, and the other reading only when the rule inverts the order («بين 500 الف و 1200»
   *     ends at 1,200,000, «بين 5 الف و 9000» at 9,000).
   */
  const rangeEnds = (a0: Amount, b0: Amount, cur: 'IQD' | 'USD', bounds = false): [number, number] => {
    // «بين 3 و 5 مية» is three to five hundred: a bare count near the count of «N مية» shares the hundred, before
    // the rule reads either end (300,000 to 500,000).
    const hundred = (x: Amount, y: Amount): Amount => {
      if (x.unit !== null || x.grouped || x.share !== 0 || y.unit !== null || y.share !== 100) return x;
      const count = y.value / 100;
      return Math.max(x.value, count) < Math.min(x.value, count) * 10 ? { ...x, value: x.value * 100, share: 100 } : x;
    };
    const [a, b] = [hundred(a0, b0), hundred(b0, a0)];
    if (a.unit === null && b.unit === null && cur === 'IQD') {
      const read = (x: Amount): number => (x.grouped ? x.value : bareDinars(x.value));
      const [lo, hi] = [read(a), read(b)];
      // Written ascending and read inverted: the smaller end as written too.
      if (lo > hi && a.value <= b.value) return [a.value, hi];
      // Written high-to-low and read ascending: the smaller end, the second, as written too.
      if (!bounds && lo < hi && a.value > b.value && a.value < b.value * 10) return [lo, b.value];
      return [lo, hi];
    }
    /** A bare end x beside the other end y: its readings in order; the first that keeps the order written wins. */
    const beside = (x: Amount, y: Amount, low: boolean): number => {
      if (x.unit !== null || x.grouped) return x.value;
      const keeps = (v: number): boolean => (low ? v <= y.value : v >= y.value);
      let shared: number | null = null;
      // «بين 2 و 3 مية الف» shares the hundred thousand (200,000 to 300,000), «بين 3 و 5 ورقات» the note.
      if (x.value < BARE_IN_FULL_FROM && y.share > 0 && x.value * y.share <= MAX_PRICE_IQD) {
        shared = x.value * y.share;
        // The counts as written, the low end's first: «50 و 25 الف» is 50 then 25, high to low.
        const count = y.value / y.share;
        const [first, second] = low ? [x.value, count] : [count, x.value];
        const near = Math.max(first, second) < Math.min(first, second) * 10;
        // Up to the word («بين 2 و 500 مليون») or near the other count; after it, near only («بين مليون و 500»).
        if ((low && keeps(shared)) || near) return shared;
      }
      // Dollars are as typed; dinars by the rule first, then the other reading.
      const ruled = x.value < BARE_IN_FULL_FROM ? [x.value * 1000, x.value] : [x.value, x.value * 1000];
      const ways = (cur === 'USD' ? [x.value] : ruled).filter((v) => v <= MAX_PRICE_IQD);
      // Two bounds name their low end themselves: «over 20 million and under 200» keeps 200 million rather than invert.
      const bound = bounds && shared !== null && keeps(shared) ? shared : undefined;
      return ways.find(keeps) ?? bound ?? ways[0] ?? x.value;
    };
    return [beside(a, b, true), beside(b, a, false)];
  };

  /** The amounts the two bounds were read from, while both stand: «اكثر من 500 واقل من 1500» is one range. */
  const ends: { min: Amount | null; max: Amount | null } = { min: null, max: null };
  /** An amount with no money word at all (not even k): it takes the currency of the range it stands in. */
  const plain = (a: Amount | null): boolean => !!a && a.unit === null && a.cur === null;
  const setBound = (dir: 'min' | 'max', p: { v: number; cur: 'IQD' | 'USD' }, a: Amount | null = null) => {
    const other = dir === 'min' ? 'max' : 'min';
    if (got.price && got.price.currency !== p.cur) {
      // The second of two bounds, one of them bare: one range in the money word of the other («over 100 and
      // under 200 dollars», «اقل من 200 دولار واكثر من 100», «اكثر من 3 واقل من 5 ورقات»), the values read
      // together below. Two different money words are two answers: the later one stands.
      const pair = got.price[dir] === null && got.price[other] !== null && !!ends[other] && !!a;
      if (pair && plain(a)) p = { v: p.v, cur: got.price.currency };
      else if (pair && plain(ends[other])) got.price.currency = p.cur;
    }
    if (!got.price || got.price.currency !== p.cur) {
      got.price = { min: null, max: null, currency: p.cur };
      ends.min = ends.max = null;
    }
    const price = got.price;
    price[dir] = p.v;
    ends[dir] = a;
    if (price.min === null || price.max === null) return;
    // Two bounds are a range written as two (policy b): read together, never inverted.
    if (ends.min && ends.max) {
      const [lo, hi] = rangeEnds(ends.min, ends.max, p.cur, true);
      if (lo >= 1 && hi >= 1 && lo <= MAX_PRICE_IQD && hi <= MAX_PRICE_IQD) [price.min, price.max] = [Math.round(lo), Math.round(hi)];
    }
    if (price.min > price.max) got.price = { min: price.max, max: price.min, currency: p.cur };
  };
  const flipDir = (dir: 'min' | 'max', flip: boolean): 'min' | 'max' => (flip ? (dir === 'min' ? 'max' : 'min') : dir);

  /**
   * A range from lexeme k: A sep B, the two ends read together (rangeEnds) and swapped only when written
   * descending («بين 50 و 25», «بين 50 و 25 الف»): a range read ascending is never swapped.
   */
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
    if (!b || measured(a) || measured(b)) return null;
    if (bare && a.unit !== 'strong' && b.unit !== 'strong') return null;
    const cur = a.cur ?? b.cur ?? 'IQD';
    if ((a.cur && b.cur && a.cur !== b.cur) || (b.cur && a.cur === null && a.unit === 'strong' && b.cur !== 'IQD')) return null;
    const [lo, hi] = rangeEnds(a, b, cur);
    if (!(lo >= 1) || !(hi >= 1) || lo > MAX_PRICE_IQD || hi > MAX_PRICE_IQD) return null;
    const [l, h] = lo <= hi ? [lo, hi] : [hi, lo];
    return { lo: { v: Math.round(l), cur }, hi: { v: Math.round(h), cur }, end: priceEnd(b.end) };
  };

  /**
   * Would a bound right before lexeme k take what is at k as its price? Not a measure or a count («2 كيلو», "1kg»),
   * and not a filament diameter written bare («1.75», «2.85»): after another amount's bound those are what the
   * query is about, not a second price.
   */
  const boundsPrice = (k: number): boolean => {
    const x = readAmount(k, { bound: true });
    if (!x || measured(x) || !priceOf(x, true)) return false;
    return !(x.unit === null && x.end === k + 1 && DIAMETERS.has(L[k].f));
  };

  /** A price constraint from lexeme i: «سعر» … a range, a bound and its amount, or an amount and its bound. */
  const tryPrice = (i: number, flip: boolean): number => {
    if (i >= L.length || used[i]) return 0;
    who = 'price';
    const named = longest(i, PRICE_WORDS);
    const j = i + named + perLead(i + named, named > 0);
    const open = longest(j, RANGE_OPEN);
    if (open) {
      const r = readRange(j + open, false);
      if (r) {
        setBound('min', r.lo);
        setBound('max', r.hi);
        take(i, r.end);
        return r.end - i;
      }
      // «من 30 الف», "from 20k", «لە 20 هەزارەوە»: from an amount on, a lower bound by itself.
      const a = readAmount(j + open, { bound: false });
      if (a && (longest(j, RANGE_MIN_ALONE) === open || (open === 1 && L[j].f === SORANI_FROM && a.from))) {
        // «من 30 الف ونازل», «لە 20 هەزارەوە بۆ سەرەوە»: a bound after the amount says which way; it is read below.
        const at = priceEnd(a.end);
        const post = Math.max(longest(at, MAX_POST), longest(at, MIN_POST));
        const p = a.unit === 'strong' ? priceOf(a, false) : null;
        if (!post && p) {
          setBound(flipDir('min', flip), p, a);
          take(i, a.end);
          return a.end - i;
        }
        if (post) return postBound(i, j + open, flip);
      }
    }
    // The longest bound phrase first: «اقل شي» (at least) before «اقل», «حد ادنى» before «حد».
    const pres = ([[MAX_PRE, 'max'], [MIN_PRE, 'min']] as const)
      .map(([list, dir]) => [longest(j, list), dir] as const)
      .sort((x, y) => y[0] - x[0]);
    for (const [c, dir] of pres) {
      if (!c) continue;
      const a = readAmount(j + c, { bound: true });
      const p = a && !measured(a) ? priceOf(a, true) : null;
      if (a && p) {
        let end = priceEnd(a.end);
        // «کەمتر لە 20 هەزار نەبێت»: the Sorani verb negation after the amount turns the bound («not less than»).
        const not = longest(end, NEG_POST);
        setBound(flipDir(dir, flip !== (not > 0)), p, a);
        end += not;
        take(i, end);
        return end - i;
      }
    }
    return postBound(i, j, flip);
  };

  /**
   * An amount at j and the bound written after it («30 الف واقل», «لە 30 هەزار کەمتر», «20k and above»), or a bare
   * range («250-400 الف»), or a strong amount alone (a ceiling); the words from i (a price word, an opener) go with it.
   */
  const postBound = (i: number, j: number, flip: boolean): number => {
    who = 'price';
    const a = readAmount(j, { bound: false });
    if (!a) return 0;
    const range = readRange(j, true);
    if (range) {
      setBound('min', range.lo);
      setBound('max', range.hi);
      take(i, range.end);
      return range.end - i;
    }
    const posts = [[MAX_POST, 'max'], [MIN_POST, 'min']] as Array<[readonly Phrase[], 'min' | 'max']>;
    if (a.unit !== null) posts.push([MAX_POST_UNIT, 'max'], [MIN_POST_UNIT, 'min']);
    // «25 للكيلو او اقل»: the per-unit words sit between the amount and its bound.
    const at = priceEnd(a.end);
    // «فیلامێنت 1.75 کەمتر لە 25»: «کەمتر لە» is the bound of the amount after it, not «1.75 or less».
    const pre = Math.max(longest(at, MAX_PRE), longest(at, MIN_PRE));
    const nextBound = pre > 0 && boundsPrice(at + pre);
    // «500k or under 30k», «500 هەزار یان زیاتر لە 600 هەزار»: a bound that starts inside the phrase with a price of
    // its own after it bounds that price, not this one. A diameter or a measure after it is no price: «500 الف فما
    // فوق 1.75», «20 الف او اكثر 2 كيلو», «30 هەزار یان کەمتر 1.75» are this amount's bound and then a diameter or a
    // quantity.
    const ownAmount = (c: number): boolean => {
      for (let q = at + 1; q < at + c; q++) {
        const pre = Math.max(longest(q, MAX_PRE), longest(q, MIN_PRE));
        if (pre > 0 && q + pre >= at + c && boundsPrice(q + pre)) return true;
      }
      return false;
    };
    // The longest bound phrase first: «زیاتر نەبێت» (not more than) before «زیاتر».
    const postHits = posts
      .map(([list, dir]) => {
        const c = nextBound ? 0 : longest(at, list);
        return [c && !ownAmount(c) ? c : 0, dir] as const;
      })
      .sort((x, y) => y[0] - x[0]);
    for (const [c, dir] of postHits) {
      const p = c ? priceOf(a, true) : null;
      if (c && p) {
        setBound(flipDir(dir, flip), p, a);
        // «25 الف او اقل للكيلو», «لە 25 هەزار کەمتر بۆ هەر کیلۆیەک»: per-unit words after the bound go with it too.
        const end = priceEnd(at + c);
        take(i, end);
        // «لە 30 هەزار کەمتر»: the «لە» before it belongs to the bound, and a «کیلۆی» before that to the price.
        let from = i;
        if (from > 0 && !used[from - 1] && L[from - 1].f === SORANI_FROM) take(--from, i);
        if (from > 0 && !used[from - 1] && soraniPerLead(L[from - 1].f) && !numberAt(from - 2)) take(--from, from + 1);
        // «نرخی لە 30 هەزار زیاتر نەبێت»: the price word before it too.
        for (const p of PRICE_WORDS) {
          if (from - p.length >= 0 && matchAt(from - p.length, p) === p.length) {
            take(from - p.length, from);
            break;
          }
        }
        return end - i;
      }
    }
    const p = priceOf(a, false);
    if (!p || a.unit !== 'strong') return 0;
    setBound(flipDir('max', flip), p, a);
    take(i, at);
    return at - i;
  };

  const trySale = (i: number, flip: boolean): number => {
    const d = longest(i, DIRECT);
    const p = d ? 0 : longest(i, PREORDER);
    if (!d && !p) return 0;
    const direct = !!d !== flip;
    got.sale = direct ? 'direct' : 'preorder';
    who = 'sale';
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
      who = 'spool';
      take(i, i + r);
      return r;
    }
    const w = longest(i, SPOOL_WITH);
    const s = longest(i + w, SPOOL);
    if (!s) return 0;
    let end = i + w + s;
    if (guarded(i - 1) || guarded(end)) return 0;
    const full = longest(end, SPOOL_FULL);
    // A bare spool word is the facet beside a filament or material word, or with «مع» / «كاملة».
    if (!flip && !w && !full && !aboutFilament) return 0;
    end += full;
    got.spool = flip ? 'refill' : 'spool';
    who = 'spool';
    take(i, end);
    return end - i;
  };

  const tryDiameter = (i: number): number => {
    if (!aboutFilament) return 0;
    const j = i + longest(i, DIAMETER_WORDS);
    const d = j < L.length && !used[j] ? DIAMETERS.get(L[j].f) : undefined;
    if (!d) return 0;
    const end = j + 1 + longest(j + 1, MM_WORDS);
    add(diameters, d);
    who = `diameter:${d}`;
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
    who = `color${flip ? '!' : ''}:${colour}`;
    take(i, i + len);
    return len;
  };

  const trySort = (i: number): number => {
    const a = longest(i, CHEAP);
    const d = a ? 0 : longest(i, DEAR);
    if (!a && !d) return 0;
    got.sort = a ? 'price_asc' : 'price_desc';
    who = 'sort';
    const end = i + (a || d);
    take(i, end);
    // «ارخص سعر» was read whole; «سعر» after «رخيص» goes with it.
    if (end < L.length && longest(end, PRICE_WORDS)) take(end, end + 1);
    return end - i;
  };

  /**
   * One negation and what it reaches: the negation words, then each item of its list with the list word («ولا»,
   * "or", «یان») that carried it there (-1 for the first). An item `asSaid` is a price, the sale mode, the spool, a
   * diameter or the order the list ran past, read as written (`key` '' when it stayed a word); the others are
   * the exclusions it negates. A removed chip keeps the negation for the exclusions left.
   */
  interface NegList {
    neg: number[];
    items: Array<{ key: string; sep: number; asSaid: boolean }>;
  }
  /** Bound words that also name products («Kobra 3 Max»): left out by a negation when no amount follows. */
  const PRODUCT_BOUNDS = new Set(['max', 'maximum', 'min', 'minimum', 'ماكس'].map(nlFold));
  /**
   * A bound or a range opener at k («اقل», "under", «کەمتر لە», "between»): never an exclusion (policy c), even
   * when what follows is a measure and not a price («بدون AMS ولا اقل من 30 سم», "without AMS or under 300mm").
   */
  const boundWordAt = (k: number): boolean => {
    const c = Math.max(longest(k, MAX_PRE), longest(k, MIN_PRE), longest(k, RANGE_OPEN));
    return c > 0 && (!L[k].v.some((v) => PRODUCT_BOUNDS.has(v)) || readAmount(k + c, { bound: true }) !== null);
  };
  const negLists: NegList[] = [];
  /** Where the last negation ended: "or" right there carries it on (NEGATION_OR), anywhere else it is "or". */
  let negatedTo = -1;
  const tryNegation = (i: number): number => {
    const carried = negatedTo === i && NEGATION_OR.has(L[i].f);
    if (CONJUNCTIONS.has(L[i].f) && !carried) return 0;
    let n = carried ? 1 : longest(i, NEGATION);
    // Iraqi «ما متوفر» (not available), «ما اسود»: a bare «ما» negates a known constraint only.
    const ma = !n && L[i].f === MA;
    if (ma) n = 1;
    if (!n) return 0;
    const j = i + n;
    if (j >= L.length || used[j]) return 0;
    // A lone "non" negates a known term ("non combo", "non black"); "non slip" is a product word.
    const loose = (n === 1 && L[i].f === 'non') || ma;
    /** A price at k, the Sorani «لە» of a bound written last included («یان لە 30 هەزار زیاتر نەبێت»). */
    const priceAt = (k: number, f: boolean): number => {
      const w = tryPrice(k, f);
      if (w || L[k].f !== SORANI_FROM || k + 1 >= L.length) return w;
      const after = tryPrice(k + 1, f);
      if (after && !used[k]) take(k, k + 1);
      return after ? after + 1 : 0;
    };
    const last = negLists[negLists.length - 1];
    // A diameter has no opposite to read («بدون 1.75»): the negation and the number stay words, and no facet.
    if (!carried && aboutFilament && DIAMETERS.has(L[j + longest(j, DIAMETER_WORDS)]?.f ?? '')) {
      const d = j + longest(j, DIAMETER_WORDS);
      return d + 1 + longest(d + 1, MM_WORDS) - i;
    }
    if (carried && last) {
      // Carried by a list word, a negation reaches exclusions only (policy c): a price bound, the sale mode, the
      // spool, a diameter or the order there is read as said («بدون AMS او اقل من 500 الف», "without AMS or in
      // stock", «بێ AMS یان ڕیفیل»), and a bare spool word stays a word. The list runs on past it to the next
      // exclusion: «بدون اسود ولا اقل من 30 ولا ابيض» leaves out white too, never wants it.
      const said = priceAt(j, false) || trySale(j, false) || trySpool(j, false) || tryDiameter(j) || trySort(j);
      if (said) {
        take(i, j); // the list word goes with the item it listed
        last.items.push({ key: who, sep: i, asSaid: true });
        negatedTo = j + said;
        return n + said;
      }
      const w = longest(j, SPOOL_WITH);
      const spoolWord = longest(j, REFILL) || (longest(j + w, SPOOL) ? w + longest(j + w, SPOOL) : 0);
      if (spoolWord) {
        last.items.push({ key: '', sep: i, asSaid: true });
        negatedTo = j + spoolWord;
        return 0;
      }
    }
    const material = (at: number): number => {
      const m = lookup(at, MATERIALS);
      if (!m) return 0;
      add(exclude.materials, m);
      who = `material!:${m}`;
      take(at, at + 1);
      return 1;
    };
    /** A word left out: a known term, or (`any`) a word that is no function word, bound or negation. */
    const word = (at: number, any: boolean): number => {
      if (at >= L.length || used[at]) return 0;
      const w = L[at].f;
      const canon = lookup(at, EXCLUDE_CANON);
      if (canon === undefined) {
        const excludable =
          /\p{L}/u.test(w) && w.length >= 2 && !NEG_ARTICLES.has(w) && !L[at].v.some((v) => FILLERS.has(v) || CONJUNCTIONS.has(v)) && !boundWordAt(at);
        if (!any || !excludable || longest(at, NEGATION)) return 0;
      }
      const out = canon ?? stripArticle(w);
      add(exclude.words, out);
      who = `exclude:${out}`;
      take(at, at + 1);
      return 1;
    };
    let k = carried || ma ? tryColour(j, true) : trySpool(j, true) || trySale(j, true) || priceAt(j, true) || tryColour(j, true);
    if (!k && ma) k = trySale(j, true) || trySpool(j, true);
    if (!k) k = material(j);
    if (!k) {
      // Over a colour noun, an article, "in" or "even" to the item after it (COLOUR_NOUNS).
      let s = j;
      let noun = false;
      let even = false;
      let article = true;
      for (; s < L.length && !used[s]; s++) {
        const v = L[s].v;
        if (v.some((x) => COLOUR_NOUNS.has(x))) noun = true;
        else if (v.some((x) => EVEN.has(x))) even = true;
        else if (NEG_FILLERS.has(L[s].f)) article = false;
        else if (!NEG_ARTICLES.has(L[s].f)) break;
      }
      if (s > j && s < L.length && !used[s]) {
        let got = !carried && !ma && !noun ? trySpool(s, true) || trySale(s, true) : 0;
        got ||= tryColour(s, true);
        if (!got && !noun) got = material(s);
        if (!got && !noun && carried && even && last) {
          // «ولا حتى كومبو», "or even combo": after "even" in a list, a word is searched as written (never wanted
          // as a filter), and the list runs on to the next item: «… ولا حتى كومبو ولا اسود» leaves out black.
          last.items.push({ key: '', sep: i, asSaid: true });
          negatedTo = s + 1;
          return 0;
        }
        if (!got && !noun) got = word(s, !ma && (article || even));
        if (got) {
          take(j, s);
          k = s - j + got;
        }
      }
    }
    if (!k) k = word(j, !loose);
    if (!k) return 0;
    take(i, j);
    if (carried && last) last.items.push({ key: who, sep: i, asSaid: false });
    else negLists.push({ neg: Array.from({ length: n }, (_, d) => i + d), items: [{ key: who, sep: -1, asSaid: false }] });
    negatedTo = j + k;
    return n + k;
  };

  /**
   * The Sorani negation written after a list of known items: «ڕەش نەبێت» (not black), «PLA نەبێت», «ڕەش و سپی
   * نەبێت» (neither black nor white), «بەردەست نییە» (not available: a pre-order), «ڕیفیل نەبێت» (with a spool). Each
   * item is left out (the sale mode and the spool turned); a removed item takes its list word along and the negation
   * stays for the rest.
   */
  const tryPostNegation = (i: number): number => {
    type Kind = 'colour' | 'material' | 'sale' | 'spool' | 'canon';
    const itemAt = (k: number): { at: number; len: number; kind: Kind } | null => {
      if (k >= L.length || used[k]) return null;
      let len = 0;
      for (const [p] of COLOUR_PHRASES) len = Math.max(len, matchAt(k, p));
      if (len || lookup(k, COLOURS)) return { at: k, len: len || 1, kind: 'colour' };
      if (lookup(k, MATERIALS)) return { at: k, len: 1, kind: 'material' };
      const sale = longest(k, DIRECT) || longest(k, PREORDER);
      if (sale) return { at: k, len: sale, kind: 'sale' };
      const w = longest(k, SPOOL_WITH);
      const spool = longest(k, REFILL) || (longest(k + w, SPOOL) ? w + longest(k + w, SPOOL) : 0);
      if (spool && !guarded(k - 1) && !guarded(k + spool)) return { at: k, len: spool, kind: 'spool' };
      return lookup(k, EXCLUDE_CANON) !== undefined ? { at: k, len: 1, kind: 'canon' } : null;
    };
    const items: Array<{ at: number; len: number; kind: Kind }> = [];
    const seps: number[] = [];
    let k = i;
    let neg = 0;
    for (;;) {
      const it = itemAt(k);
      if (!it) return 0;
      items.push(it);
      k += it.len;
      neg = longest(k, NEG_POST);
      if (neg) break;
      if (k < L.length && !used[k] && POST_LIST.has(L[k].f) && itemAt(k + 1)) {
        seps.push(k);
        k++;
      } else return 0;
    }
    const keys = items.map((it) => {
      if (it.kind === 'colour') tryColour(it.at, true);
      else if (it.kind === 'sale') trySale(it.at, true);
      else if (it.kind === 'spool') trySpool(it.at, true);
      else {
        const v = it.kind === 'material' ? lookup(it.at, MATERIALS)! : lookup(it.at, EXCLUDE_CANON)!;
        add(it.kind === 'material' ? exclude.materials : exclude.words, v);
        who = it.kind === 'material' ? `material!:${v}` : `exclude:${v}`;
        take(it.at, it.at + it.len);
      }
      return who;
    });
    // The list word before an item goes with it, and the one after the first with the first too.
    seps.forEach((sep, x) => {
      who = keys[x + 1];
      take(sep, sep + 1);
      if (x === 0) alsoOwner[sep] = keys[0];
    });
    who = items.length === 1 ? keys[0] : '';
    take(k, k + neg);
    return k + neg - i;
  };

  for (let i = 0; i < L.length; ) {
    if (used[i]) {
      i++;
      continue;
    }
    const k =
      tryPrice(i, false) || tryNegation(i) || tryPostNegation(i) || trySale(i, false) || trySpool(i, false) || tryDiameter(i) || tryColour(i, false) || trySort(i);
    if (k) {
      i += k;
      continue;
    }
    const m = lookup(i, MATERIALS);
    if (m) {
      add(materials, m);
      // Not consumed (a material stays in the search), but it is this chip's word.
      owner[i] = `material:${m}`;
    }
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

  // Each chip's words out, everything else as typed; a joining word left at either end goes too.
  const conj = (w: string) => {
    const lx = lexemesOf(w);
    return lx.length > 0 && lx.every((f) => CONJUNCTIONS.has(f));
  };
  // A negation list («بدون AMS ولا كومبو», «بدون اسود ولا اقل من 30 ولا ابيض») keeps its negation while an
  // exclusion after the first item stands. Removing the first item moves the negation words onto the list word
  // of the next exclusion, and the list words of the items read as written in between go with it («بدون كومبو»,
  // «اقل من 30 بدون ابيض»); with no exclusion after it, the negation and those list words go with it. A later
  // item takes its own list word along (`owner`).
  const firstOut = new Map<string, { gone: Set<number>; at: number; neg: string }>();
  for (const { neg, items } of negLists) {
    const first = items[0].key;
    if (items.length < 2 || !first || firstOut.has(first)) continue;
    const next = items.findIndex((it, x) => x > 0 && !it.asSaid && it.key !== first);
    const gone = new Set(neg);
    // The list word right after the first item goes with it; those between two items read as written stay
    // («اقل من 30 ولا مليون» never becomes «30 مليون»).
    if (items[1].asSaid) gone.add(items[1].sep);
    // The negation as typed: its whole pieces, or its own lexemes where a piece holds more («non-combo»).
    const negPieces = [...new Set(neg.map((k) => L[k].piece))];
    const text = negPieces
      .map((pc) => {
        const all = L.map((l, k) => ({ l, k })).filter(({ l }) => l.piece === pc);
        return all.every(({ k }) => gone.has(k)) ? pieces[pc] : all.filter(({ k }) => gone.has(k)).map(({ l }) => l.f).join('');
      })
      .join(' ');
    firstOut.set(first, { gone, at: next < 0 ? -1 : items[next].sep, neg: text });
  }
  const without: Record<string, string> = {};
  for (const chip of understood) {
    const key = nlChipKey(chip);
    const plan = firstOut.get(key);
    const goes = (k: number): boolean => owner[k] === key || alsoOwner[k] === key || (!!plan && (plan.gone.has(k) || plan.at === k));
    const out: string[] = [];
    let gap = false;
    pieces.forEach((raw, piece) => {
      const mine = L.map((l, k) => ({ l, k })).filter(({ l }) => l.piece === piece);
      const left = mine.filter(({ k }) => !goes(k));
      if (plan && mine.some(({ k }) => k === plan.at)) {
        out.push(plan.neg);
        if (left.length) out.push(left.map(({ l }) => l.f).join(''));
        gap = false;
        return;
      }
      if (!left.length) {
        if (mine.length) gap = true;
        return;
      }
      // «بدون AMS PLA والا PETG» less PLA: the free list word that joined it to the next goes with it, or it
      // would carry the negation on to PETG.
      const free = left.length === mine.length && mine.every(({ l, k }) => CONJUNCTIONS.has(l.f) && !owner[k]);
      const after = gap;
      gap = false;
      if (after && free) return;
      out.push(left.length === mine.length ? raw : left.map(({ l }) => l.f).join(''));
    });
    while (out.length && conj(out[out.length - 1])) out.pop();
    while (out.length && conj(out[0])) out.shift();
    without[key] = out.join(' ');
  }
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
    without,
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
