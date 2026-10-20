/**
 * FREE TEXT INTO THE LISTING GRAMMAR (smart search 1.6; the assistant plan §6,
 * acceptance rows 9 to 12).
 *
 *   «فلامنت اسود اقل من 30 الف»  → search «فلامنت», colour black, price ≤ 30,000 IQD
 *   «طابعة بدون AMS»             → search «طابعة», nothing that is an AMS or a combo
 *   «ريفل» / «بكرة كاملة»        → the refill / with-spool facet
 *   «متوفر هسه» / «حجز»          → sale=direct / sale=preorder
 *
 * THE PRECISION RULE (lead decision; docs/SEARCH.md §4e). A constraint is applied only when it is
 * unambiguous; anything else stays plain search text and never hides a product. When nothing applies,
 * the search is exactly the search without `nl`.
 *
 * PRICE. Applied only when the amount carries a money marker of its own AND a clear comparator or a
 * range opener stands with it in the same clause:
 *   - money markers: the thousand and million words (الف، هزار، هەزار، thousand, k; مليون، ملیۆن, million,
 *     m, mil), dinars (دينار، IQD، د.ع), dollars ($، دولار، USD) and «ورقة» (a hundred-dollar note), or
 *     digits grouped in threes («30,000», «٣٠٬٠٠٠», «1.500.000»);
 *   - comparators before the amount («اقل من», «تحت», «دون», «بحدود», "under", "below", "max", «کەمتر
 *     لە», «خوار»; «اكثر من», «فوق», "over", "at least", «زیاتر لە») or after it («واقل», «فما دون»,
 *     «ونازل», "or less", «لە … کەمتر»; «وطالع», "and up", "+", «لە … زیاتر»);
 *   - range openers («بين … و», «من … الى», "between … and", "from … to", «لە نێوان … و», «لە … تا»).
 * A BARE NUMBER (30, 30000, 1500, a number word without a money word) is never a price: it may be a
 * model, a size or a code, and it stays in the search. «نص مليون», «ب 500 الف» and «250-400 الف» have no
 * comparator or opener: no price either. A range applies only when both ends carry a marker; written
 * high-to-low it is sorted only when both ends carry the same one («بين 50 الف و 25 الف»), else it is not
 * applied. Two separate bounds apply only when both qualify («اكثر من 10 واقل من 30 الف» applies
 * neither). A negated comparator is read as its positive meaning only in its fixed forms («لا يزيد عن»,
 * «لا يقل عن», «مو اكثر من», «مو اقل من», "no more than", "no less than", "not over", "not under", «زیاتر
 * نەبێت لە», «کەمتر نەبێت لە» and the Sorani «لە … زیاتر نەبێت», «لە … کەمتر نەبێت»); any other negation
 * around a price («بدون اقل من 30 الف», «ما يزيد عن مليون», "nothing over 1m", «کەمتر لە 20 هەزار نەبێت»)
 * leaves it unapplied. A measure or a count after the amount is not a price («اقل من 1 كيلو», "under
 * 300mm"); a price PER unit sold is one («اقل من 25 الف للكيلو», "25k per kg", «بۆ هەر کیلۆیەک»).
 *
 * EXCLUSIONS. Only for a negation word («بدون», «بلا», «مو», "without", "no", "non-", «بێ» …) directly
 * before a known term: AMS, combo, a colour or a material (over an article, a colour noun, "in" or
 * "even"). A list after it («بدون AMS ولا كومبو», "without AMS or combo", «بێ AMS یان کۆمبۆ») leaves out
 * each known term of the list; an unknown word in the list stays searched and the list runs on to its
 * next list word. A carried negation never touches a price, the sale mode, the spool or the order: they
 * are read as written. The Sorani negation after a known term («ڕەش نەبێت», «PLA نەبێت») is the same.
 * «ولا» and «والا» are "or", not a negation.
 *
 * THE REST. Colours and materials anywhere (a material stays in the search text too); the diameter
 * (1.75 / 2.85) only in a query about filament (a filament or material word), with «قطر» or mm beside it
 * or not; the sale mode only for its fixed phrases («متوفر», "in stock", «بەردەستە»; «حجز», "pre-order",
 * «پێشوەختە»); refill or with spool for the refill words and the spool phrases («مع بكرة», «بكرة كاملة»),
 * a bare spool word only in a query about filament; «رخيص» / "cheap" as the price order. A word that
 * became a constraint leaves the search text; a word it does not know stays in it.
 *
 * THE CHIP DROP CONTRACT. For each chip, `without` is the input with the words of that chip taken out; read
 * again it gives the same answer less exactly that chip.
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
 * «اقل شي 20 الف» (the least, 20,000) is a lower bound, «اقل من» an upper one. A negation is part of a bound
 * only in the FIXED FORMS written here («لا يزيد عن», «مو اكثر من», "no more than", "not over", «زیاتر نەبێت
 * لە»): «ما يزيد عن» (MSA "what exceeds", Iraqi "not more than"), "nothing over" and any other negation
 * around a price leave it unapplied (`negatedBefore`).
 */
const MAX_PRE = phrases(
  'اقل من', 'اقل عن', 'اقل', 'ارخص من', 'تحت', 'دون',
  'يقل عن', 'يقل على', 'تقل عن',
  'لا يزيد عن', 'لا يزيد على', 'مو اكثر من', 'no more than', 'not over',
  'الى', 'لحد', 'حد', 'حدود', 'بحدود', 'ميزانية', 'ميزانيتي', 'اقصى', 'كحد اقصى', 'بحد اقصى', 'حد اقصى', 'ماكس',
  'under', 'below', 'less than', 'lower than', 'cheaper than', 'up to', 'upto', 'at most', 'max', 'maximum', 'within',
  'budget', 'budget of', '<', '≤',
  'کەمتر لە', 'کەمتر', 'خوار', 'خوارتر لە', 'لە خوار', 'ژێر', 'لە ژێر', 'تا', 'هەتا', 'بودجە', 'بودجەی', 'زۆرترین',
  'هەرزانتر لە', 'نزمتر لە',
  // "less than or equal to", «اقل من او يساوي» an upper bound whole; «زیاتر نەبێت لە 30 هەزار» (not more than, a
  // fixed form written before the amount).
  'less than or equal to', 'less than or equal', 'less or equal to', 'lower than or equal to', 'equal to or less than',
  'equal or less than', 'at or below', 'at or under',
  'اقل من او يساوي', 'اقل او يساوي', 'اقل من او تساوي', 'اقل او تساوي', 'يساوي او اقل من', 'اصغر من او يساوي',
  'زیاتر نەبێت لە', 'زیاتر نەبێ لە'
);
/** «اكثر من مليون»: a lower bound before the amount («حد ادنى», «لانی کەم», «سەروو» too; the fixed forms «لا يقل عن», «مو اقل من»). */
const MIN_PRE = phrases(
  'اكثر من', 'اكثر', 'فوق', 'اعلى من', 'اغلى من', 'يبدا من', 'ابتداء من', 'على الاقل', 'يتجاوز', 'يتعدى', 'يزيد عن', 'يزيد على',
  'لا يقل عن', 'لا يقل على', 'مو اقل من', 'حد ادنى', 'كحد ادنى', 'ادنى', 'اقل شي', 'اقل شيء',
  'over', 'above', 'more than', 'at least', 'min', 'minimum', 'starting at', 'starting from', '>', '≥', 'no less than', 'not under',
  'زیاتر لە', 'زیاتر', 'سەرووی', 'لە سەرووی', 'سەروو', 'لە سەروو', 'لانیکەم', 'لانی کەم', 'کەمترین', 'گرانتر لە',
  'بەرزتر لە',
  // «بەلایەنی کەمەوە» (at least); «کەمتر نەبێت لە 20 هەزار» (not less than, a fixed form written before the amount).
  'بەلایەنی کەمەوە', 'بە لایەنی کەمەوە', 'لانی کەمەوە', 'لانیکەمەوە',
  'کەمتر نەبێت لە', 'کەمتر نەبێ لە',
  'more than or equal to', 'more than or equal', 'greater than or equal to', 'higher than or equal to', 'equal to or more than',
  'equal or more than', 'at or above', 'at or over',
  'اكثر من او يساوي', 'اكثر او يساوي', 'اكثر من او تساوي', 'اكبر من او يساوي', 'يساوي او اكثر من'
);
/**
 * «30 الف واقل»: an upper bound after the amount (Sorani puts it there: «لە 30 هەزار کەمتر»). The longest
 * phrase wins: «لە 30 هەزار زیاتر نەبێت» (not more than, the fixed form) is an upper bound, «کەمتر نەبێت» (not
 * less) a lower one. Any other negation after it («زیاتر نییە») leaves the price unapplied.
 */
const MAX_POST = phrases(
  'واقل', 'و اقل', 'او اقل', 'فما دون', 'وتحت', 'او تحت', 'كحد اقصى', 'حد اقصى',
  'or less', 'or below', 'or under', 'and under', 'and below',
  'یان کەمتر', 'و کەمتر', 'کەمتر', 'بۆ خوارەوە', 'خوارتر', 'زیاتر نەبێت', 'زیاتر نەبێ',
  // Iraqi «ونازل» (and down); "or lower"; the Sorani copula («لە 30 هەزار کەمترە», "is less than") and the post
  // forms of «هەرزانتر لە», «نزمتر لە» («لە 30 هەزار هەرزانتر», cheaper than 30,000).
  'ونازل', 'و نازل', 'فنازل', 'فما نازل', 'وانت نازل', 'او انزل', 'وانزل',
  'or lower', 'or cheaper', 'and lower', 'and less', 'or lesser',
  'کەمترە', 'یان کەمترە', 'هەرزانتر', 'هەرزانترە', 'نزمتر', 'نزمترە', 'خوارترە'
);
/** «مليون وفوق»: a lower bound after the amount. */
const MIN_POST = phrases(
  'واكثر', 'و اكثر', 'او اكثر', 'فما فوق', 'وفوق', 'او فوق', 'كحد ادنى', 'حد ادنى', 'على الاقل',
  'or more', 'or above', 'and above', 'and up', 'at least',
  'یان زیاتر', 'و زیاتر', 'زیاتر', 'بۆ سەرەوە', 'کەمتر نەبێت', 'کەمتر نەبێ',
  // Iraqi «وطالع» (and up); "or higher"; the Sorani copula («لە 500 هەزار زیاترە», "is more than") and the post
  // forms of «گرانتر لە», «بەرزتر لە»; «بەلایەنی کەمەوە» (at least) after the amount.
  'وطالع', 'و طالع', 'فطالع', 'فما طالع', 'وانت طالع', 'وصاعد', 'و صاعد', 'فما اعلى',
  'or higher', 'or greater', 'or over', 'and over', 'and higher', 'or up',
  'زیاترە', 'یان زیاترە', 'گرانتر', 'گرانترە', 'بەرزتر', 'بەرزترە',
  'بەلایەنی کەمەوە', 'بە لایەنی کەمەوە', 'لانی کەمەوە'
);
/**
 * One English word after the amount, a bound only after a money word or k: "30k max", "500 الف plus".
 * After a bare number it is a model name and no price attempt at all: "Kobra 3 Max", "Kobra 2 Plus".
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
/** «بين 500 الف و مليون», «ما بين …»: a range opener. «من», "from" and «لە» need the second end or a bound after the first. */
const RANGE_OPEN = phrases('بين', 'ما بين', 'between', 'لە نێوان', 'من', 'from', 'لە');
/** «من 30 الف ونازل», «لە 20 هەزارەوە بۆ سەرەوە»: "from" before an amount with its bound written after it. */
const RANGE_FROM = phrases('من', 'from', 'لە');
/** Between the two ends of a range: "from 20k up to 30k", "till", «لغاية», «هەتاوەکو» too. */
const RANGE_SEP = phrases(
  'و', 'الى', 'حتى', 'لحد', 'ل', 'and', 'to', '-', '&', 'تا', 'بۆ', 'هەتا',
  'up to', 'upto', 'and up to', 'till', 'until', 'through', 'thru', 'لغاية', 'ولغاية', 'الى حد', 'وحتى', 'هەتاوەکو', 'تاوەکو'
);
/** A Sorani amount stands after «لە» when its bound comes last («لە 30 هەزار کەمتر»). */
const SORANI_FROM = nlFold('لە');
/**
 * The Sorani ablative «-ەوە» on an amount: «لە 20 هەزارەوە تا 30 هەزار» (from 20,000 to 30,000), «لە 500ەوە»,
 * «لە ملیۆنێکەوە». The lexer splits it off a number word; the amount reads it as its own end.
 */
const ABLATIVE = nlFold('ەوە');

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
  /** strong: a thousand/million word or a currency; weak: k or m only; null: a bare number (never a price). */
  unit: 'strong' | 'weak' | null;
  /** Written with a thousands separator («30,000», «٣٠٬٠٠٠»): a money marker of its own. */
  grouped: boolean;
  /** Its largest money word (1,000 for «الف» or k, 1,000,000 for «مليون», 100 for «ورقة»); 0 for none. */
  maxMult: number;
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

/**
 * The words of `input` as constraints (see the header). A price attempt that does not qualify leaves every
 * price unapplied: two bounds apply only when both qualify, so the query is read again without prices.
 */
export function parseNlQuery(input: string): NlQuery {
  const first = parse(input, true);
  return first.failed && first.nl.price ? parse(input, false).nl : first.nl;
}

function parse(input: string, prices: boolean): { nl: NlQuery; failed: boolean } {
  const pieces = String(input ?? '').split(/\s+/u).filter(Boolean);
  const L: Lex[] = [];
  pieces.forEach((p, piece) => {
    for (const f of lexemesOf(p)) L.push({ f, v: variantsOf(f), piece });
  });
  const used = new Array<boolean>(L.length).fill(false);
  /**
   * The words of a price attempt that did not qualify («اقل من 30», «بين 20 و 30 الف», «اقل من 25 للبكرة»): no
   * other reader takes them («للبكرة» is not the spool facet there) and the search keeps them as typed.
   */
  const held = new Array<boolean>(L.length).fill(false);
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
  /** A price attempt did not qualify (a bare amount, a negation around it, two currencies, an inverted range). */
  let failed = false;
  const diameters: string[] = [];
  const colours: BaseColour[] = [];
  const materials: string[] = [];
  const exclude = { colours: [] as BaseColour[], materials: [] as string[], words: [] as string[] };
  const add = <T>(list: T[], v: T) => {
    if (!list.includes(v)) list.push(v);
  };

  const matchAt = (i: number, p: Phrase): number => {
    if (i < 0 || i + p.length > L.length) return 0;
    for (let k = 0; k < p.length; k++) if (used[i + k] || held[i + k] || !L[i + k].v.includes(p[k])) return 0;
    return p.length;
  };
  const longest = (i: number, list: readonly Phrase[]): number => {
    let best = 0;
    for (const p of list) best = Math.max(best, matchAt(i, p));
    return best;
  };
  const lookup = <T>(i: number, map: ReadonlyMap<string, T>): T | undefined => {
    if (i < 0 || i >= L.length || used[i] || held[i]) return undefined;
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
      } else if (c.k === 'hundred') {
        if ((prev === 'mult' && !joined) || (places & HUNDREDS) || halved) break;
        cur = (cur || 1) * 100;
        places = HUNDREDS;
        prev = 'word';
      } else if (c.k === 'mult') {
        if (prev === 'mult' || (c.weak && prev !== 'digit')) break;
        // A bare «الف» is a letter or a word; a bare «مليون» is a price.
        if (!have && c.v < 1e6 && !o.bound) break;
        total += (cur || 1) * c.v;
        cur = 0;
        places = 0;
        halved = false;
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
    return { value, end: j, unit, grouped, maxMult, cur: currency, from };
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
  /** Lexeme k begins a bound written after an amount («واقل», "or less", «کەمتر», "max", "+"). */
  const postAt = (k: number): boolean => [MAX_POST, MIN_POST, MAX_POST_UNIT, MIN_POST_UNIT].some((list) => longest(k, list) > 0);
  /**
   * An amount with a measure or a count after it («1 كيلو», "300mm", «3 قطع», «الف غرام»), or per a unit nothing is
   * sold by («30 للسم», "50 per hour", «لكل ساعة»): never a price, and no price attempt. Per a unit sold («25 الف
   * للكيلو») it is one; "30k min" is a bound, not minutes.
   */
  const measured = (a: Amount): boolean =>
    !perUnit(a.end) && (isMeasure(a.end) || isMeasure(a.end + longest(a.end, PER_WORDS))) && (a.unit === null || !postAt(a.end));
  /** Where a price read up to `end` stops: past the "per unit" words that qualify it. */
  const priceEnd = (end: number): number => end + perUnit(end);

  /** A money marker of its own: a thousand or million word (k and m too), a money word or sign, or digits grouped in threes. */
  const marked = (a: Amount): boolean => a.unit !== null || a.cur !== null || a.grouped;
  /** Two ends written with the same money marker: the same scale word, digits grouped or not alike, no two currencies. */
  const sameMark = (a: Amount, b: Amount): boolean =>
    a.maxMult === b.maxMult && a.grouped === b.grouped && (a.cur === null || b.cur === null || a.cur === b.cur);

  /**
   * One price attempt: a comparator or a range opener with its amounts, the words around it included (a price
   * word, «من», «لە», per-unit words). Read whether or not it qualifies; `tryPrice` decides.
   */
  interface PriceRead {
    from: number;
    to: number;
    bound?: { dir: 'min' | 'max'; a: Amount };
    range?: [Amount, Amount];
  }

  /** «20 الف و 30 الف», «500k-1m», «لە 20 هەزارەوە تا 30 هەزار»: the two ends of a range after its opener. */
  const readRange = (k: number): { a: Amount; b: Amount; end: number } | null => {
    const a = readAmount(k, { bound: true, range: true });
    if (!a) return null;
    const sep = longest(a.end, RANGE_SEP);
    let b: Amount | null = null;
    if (sep) b = readAmount(a.end + sep, { bound: true });
    else if (a.end < L.length && /^[ول]./u.test(L[a.end].f)) {
      // «و50 الف»: the separator glued to the second end.
      const saved = L[a.end];
      L[a.end] = { ...saved, f: saved.f.slice(1), v: variantsOf(saved.f.slice(1)) };
      b = readAmount(a.end, { bound: true });
      L[a.end] = saved;
    }
    if (!b || measured(a) || measured(b)) return null;
    return { a, b, end: priceEnd(b.end) };
  };

  /**
   * Would a bound at k take the amount at k? Not a measure or a count («2 كيلو», "1kg"), and not a diameter
   * written bare («1.75», «2.85»): after another amount and its bound those are what the query is about.
   */
  const takesAmount = (k: number): boolean => {
    const x = readAmount(k, { bound: true });
    return !!x && !measured(x) && !(x.unit === null && x.end === k + 1 && DIAMETERS.has(L[k].f));
  };

  /**
   * An amount at j and the comparator written after it («30 الف واقل», «لە 30 هەزار کەمتر», "20k and above"),
   * per-unit words around it included. Reached at the amount itself (i === j), the Sorani «لە» before it, a
   * «کیلۆی» before that and a price word go with it.
   */
  const readPost = (i: number, j: number): PriceRead | null => {
    const a = readAmount(j, { bound: false });
    if (!a) return null;
    const lists: Array<[readonly Phrase[], 'min' | 'max']> = [[MAX_POST, 'max'], [MIN_POST, 'min']];
    // "Kobra 3 Max", "Kobra 2 Plus": after a bare number the word is a model name, no bound at all.
    if (a.unit !== null) lists.push([MAX_POST_UNIT, 'max'], [MIN_POST_UNIT, 'min']);
    // «25 للكيلو او اقل»: the per-unit words sit between the amount and its bound.
    const at = priceEnd(a.end);
    // «فیلامێنت 1.75 کەمتر لە 25 هەزار»: «کەمتر لە» is the comparator of the amount after it, not «1.75 or less».
    const pre = Math.max(longest(at, MAX_PRE), longest(at, MIN_PRE));
    if (pre > 0 && takesAmount(at + pre)) return null;
    // «500 هەزار یان زیاتر لە 600 هەزار»: a comparator that starts inside the phrase with an amount of its own after
    // it belongs to that amount. A diameter or a measure after it is not one: «500 الف فما فوق 1.75» is "and up", then 1.75.
    const ownAmount = (c: number): boolean => {
      for (let q = at + 1; q < at + c; q++) {
        const p = Math.max(longest(q, MAX_PRE), longest(q, MIN_PRE));
        if (p > 0 && q + p >= at + c && takesAmount(q + p)) return true;
      }
      return false;
    };
    // The longest bound phrase first: «زیاتر نەبێت» (not more than) before «زیاتر».
    let best: [number, 'min' | 'max'] = [0, 'max'];
    for (const [list, dir] of lists) {
      const c = longest(at, list);
      if (c > best[0] && !ownAmount(c)) best = [c, dir];
    }
    if (!best[0]) return null;
    let from = i;
    if (i === j) {
      // «لە 30 هەزار کەمتر»: the «لە» before it belongs to the bound, a «کیلۆی» before that to the price, and the price word too.
      if (from > 0 && !used[from - 1] && L[from - 1].f === SORANI_FROM) from--;
      if (from > 0 && !used[from - 1] && soraniPerLead(L[from - 1].f) && !numberAt(from - 2)) from--;
      for (const p of PRICE_WORDS) {
        if (from - p.length >= 0 && matchAt(from - p.length, p) === p.length) {
          from -= p.length;
          break;
        }
      }
    }
    return { from, to: priceEnd(at + best[0]), bound: { dir: best[1], a } };
  };

  /** Lexeme k is a negation word by itself: «بدون» never reads as the bound «دون» it ends with. */
  const negationWord = (k: number): boolean => NEGATION.some((p) => p.length === 1 && p[0] === L[k].f);
  /** A price attempt from lexeme i: «سعر» … a range, a comparator and its amount, or an amount and its comparator. */
  const readPrice = (i: number): PriceRead | null => {
    if (i >= L.length || used[i] || held[i]) return null;
    const named = longest(i, PRICE_WORDS);
    const j = i + named + perLead(i + named, named > 0);
    if (j >= L.length || used[j] || held[j]) return null;
    const open = longest(j, RANGE_OPEN);
    if (open) {
      const r = readRange(j + open);
      if (r) return { from: i, to: r.end, range: [r.a, r.b] };
      // «من 30 الف ونازل», «لە 30 هەزار کەمتر», «لە 20 هەزارەوە بۆ سەرەوە»: the bound comes after the amount.
      if (longest(j, RANGE_FROM) === open) {
        const post = readPost(i, j + open);
        if (post) return post;
      }
    }
    // The longest comparator first: «اقل شي» (at least) before «اقل», «حد ادنى» before «حد».
    const exact = negationWord(j);
    const pres: Array<[number, 'min' | 'max']> = [];
    for (const [list, dir] of [[MAX_PRE, 'max'], [MIN_PRE, 'min']] as const) {
      for (const p of list) if ((!exact || p[0] === L[j].f) && matchAt(j, p)) pres.push([p.length, dir]);
    }
    pres.sort((x, y) => y[0] - x[0]);
    for (const [c, dir] of pres) {
      const a = readAmount(j + c, { bound: true });
      if (a && !measured(a)) return { from: i, to: priceEnd(a.end), bound: { dir, a } };
    }
    return readPost(i, j);
  };

  /** Words that negate what follows, beside NEGATION and Iraqi «ما»: "nothing over 1m" is no bound to apply. */
  const PRICE_NEGATION = new Set(['nothing', 'never', 'none'].map(nlFold));
  /** The forms a negation word is read in: as typed, and without a glued «و» («ومو», «وبدون»). */
  const negForms = (k: number): string[] => {
    const f = L[k].f;
    return f.length > 2 && f.startsWith('و') ? [f, f.slice(1)] : [f];
  };
  const negationEndsAt = (q: number): boolean => {
    if (negForms(q).some((f) => f === MA || PRICE_NEGATION.has(f))) return true;
    return NEGATION.some((p) => {
      const s = q - p.length + 1;
      return s >= 0 && p.every((w, d) => (d === 0 ? negForms(s) : [L[s + d].f]).includes(w));
    });
  };
  /** «, ؛ ; . ! ?» at the end of a piece closes a clause: a comparator and its amount stand in one clause. */
  const CLAUSE_END = /[,،;؛:!?؟.…]$/u;
  /** A clause ends right after lexeme k. */
  const clauseEndsAt = (k: number): boolean => k + 1 < L.length && L[k + 1].piece !== L[k].piece && CLAUSE_END.test(pieces[L[k].piece]);
  const brokenClause = (from: number, to: number): boolean => {
    for (let k = from; k < to - 1; k++) if (clauseEndsAt(k)) return true;
    return false;
  };
  /**
   * A negation stands before lexeme k in its clause, over fillers only («بدون اقل من…», «ما اريد اكثر من…»,
   * "nothing over…"): the price is not applied. A list word («ولا», "or", «یان») is "or" and ends the look: a
   * carried negation never touches a price, it is read as written. «لا، اريد اقل من 30 الف» ("no, I want…") is a
   * clause of its own.
   */
  const negatedBefore = (k: number): boolean => {
    for (let q = k - 1; q >= 0; q--) {
      if (clauseEndsAt(q) || CONJUNCTIONS.has(L[q].f)) return false;
      if (negationEndsAt(q)) return true;
      if (!L[q].v.some((v) => FILLERS.has(v))) return false;
    }
    return false;
  };

  /**
   * One bound into the price; false when it contradicts what stands: another currency, another value for the same
   * side, or two bounds that leave nothing between them («اكثر من مليون واقل من 500 الف»), which are never swapped.
   */
  const setBound = (dir: 'min' | 'max', v: number, cur: 'IQD' | 'USD'): boolean => {
    const price = got.price ?? { min: null, max: null, currency: cur };
    if (price.currency !== cur || (price[dir] !== null && price[dir] !== v)) return false;
    const next: NlPrice = { ...price, [dir]: v };
    if (next.min !== null && next.max !== null && next.min > next.max) return false;
    got.price = next;
    return true;
  };
  /** A qualified attempt into the price: a range sorted only when both ends carry the same marker. */
  const applyPrice = (r: PriceRead): boolean => {
    if (r.bound) return setBound(r.bound.dir, Math.round(r.bound.a.value), r.bound.a.cur ?? 'IQD');
    const [a, b] = r.range!;
    // «بين 500 الف و 200 دولار»: two currencies are two answers.
    if ((a.cur && b.cur && a.cur !== b.cur) || (b.cur && a.cur === null && a.unit === 'strong' && b.cur !== 'IQD')) return false;
    const cur = a.cur ?? b.cur ?? 'IQD';
    // «بين 50 الف و 25 الف»: written high-to-low, sorted only when both ends carry the same money marker.
    if (a.value > b.value && !sameMark(a, b)) return false;
    const [lo, hi] = a.value <= b.value ? [a.value, b.value] : [b.value, a.value];
    return setBound('min', Math.round(lo), cur) && setBound('max', Math.round(hi), cur);
  };

  /**
   * A price from lexeme i, applied only when it qualifies: every amount money marked, no negation around it
   * (except the fixed forms in the lexicon), in one clause. An attempt that does not qualify is remembered
   * (`failed`): beside it no other bound applies («اكثر من 10 واقل من 30 الف» applies neither).
   */
  const tryPrice = (i: number): number => {
    const r = readPrice(i);
    if (!r) return 0;
    const amounts = r.range ?? [r.bound!.a];
    const ok =
      prices &&
      amounts.every(marked) &&
      !negatedBefore(r.from) &&
      !longest(r.to, NEG_POST) &&
      !brokenClause(r.from, r.to) &&
      applyPrice(r);
    if (!ok) {
      failed = true;
      for (let k = r.from; k < r.to; k++) if (!used[k]) held[k] = true;
      return 0;
    }
    who = 'price';
    take(r.from, r.to);
    return r.to - i;
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
   * diameter or the order the list ran past, read as written, or an unknown word it ran past (`key` '' when it
   * stayed a word); the others are the exclusions it negates. A removed chip keeps the negation for the
   * exclusions left.
   */
  interface NegList {
    neg: number[];
    items: Array<{ key: string; sep: number; asSaid: boolean }>;
  }
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
    const last = negLists[negLists.length - 1];
    // A diameter has no opposite to read («بدون 1.75»): the negation and the number stay words, and no facet.
    if (!carried && aboutFilament && DIAMETERS.has(L[j + longest(j, DIAMETER_WORDS)]?.f ?? '')) {
      const d = j + longest(j, DIAMETER_WORDS);
      return d + 1 + longest(d + 1, MM_WORDS) - i;
    }
    if (carried && last) {
      // Carried by a list word, a negation reaches exclusions only: a price, the sale mode, the spool, a diameter
      // or the order there is read as said («بدون AMS او اقل من 500 الف», "without AMS or in stock", «بێ AMS یان
      // ڕیفیل»), and a bare spool word stays a word. The list runs on past it to the next exclusion: «بدون اسود
      // ولا اقل من 30 الف ولا ابيض» leaves out white too, never wants it.
      const said = tryPrice(j) || trySale(j, false) || trySpool(j, false) || tryDiameter(j) || trySort(j);
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
    /** A known term left out: AMS or a combo. Any other word is never excluded: it stays searched. */
    const word = (at: number): number => {
      if (at >= L.length || used[at]) return 0;
      const canon = lookup(at, EXCLUDE_CANON);
      if (canon === undefined) return 0;
      add(exclude.words, canon);
      who = `exclude:${canon}`;
      take(at, at + 1);
      return 1;
    };
    // A price right after a negation is never turned («بدون اقل من 30 الف»): it stays words (`negatedBefore`).
    let k = carried || ma ? tryColour(j, true) : trySpool(j, true) || trySale(j, true) || tryColour(j, true);
    if (!k && ma) k = trySale(j, true) || trySpool(j, true);
    if (!k) k = material(j);
    if (!k) {
      // Over a colour noun, an article, "in" or "even" to the item after it (COLOUR_NOUNS).
      let s = j;
      let noun = false;
      let even = false;
      for (; s < L.length && !used[s]; s++) {
        const v = L[s].v;
        if (v.some((x) => COLOUR_NOUNS.has(x))) noun = true;
        else if (v.some((x) => EVEN.has(x))) even = true;
        else if (!NEG_FILLERS.has(L[s].f) && !NEG_ARTICLES.has(L[s].f)) break;
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
        if (!got && !noun) got = word(s);
        if (got) {
          take(j, s);
          k = s - j + got;
        }
      }
    }
    if (!k) k = word(j);
    if (!k && carried && last) {
      // An unknown word in the list stays searched, and the list runs on to its next list word: «بدون AMS ولا P1S
      // ولا كومبو», "without AMS or X1C or combo" leave out the combo too.
      let m = j;
      while (m < L.length && !used[m] && !NEGATION_OR.has(L[m].f)) m++;
      if (m < L.length && !used[m] && m > j) {
        last.items.push({ key: '', sep: i, asSaid: true });
        negatedTo = m;
      }
      return 0;
    }
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
    if (used[i] || held[i]) {
      i++;
      continue;
    }
    const k =
      tryPrice(i) || tryNegation(i) || tryPostNegation(i) || trySale(i, false) || trySpool(i, false) || tryDiameter(i) || tryColour(i, false) || trySort(i);
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

  /**
   * A piece inside the words of a price attempt that did not qualify: its joining word («و», "and") or a lone «/»
   * between two held words stays, so «بين 20 و 30 الف» is searched as typed.
   */
  const inHeld = (piece: number): boolean => {
    let before = -1;
    let after = -1;
    L.forEach((l, k) => {
      if (l.piece < piece) before = k;
      else if (l.piece > piece && after < 0) after = k;
    });
    return before >= 0 && after >= 0 && held[before] && held[after];
  };
  // The search text: every piece with a word left in it, less the joining words between constraints. When nothing
  // was understood it is the input as typed: the search is exactly the search without `nl`.
  const kept: string[] = [];
  const keptPieces = new Set<number>();
  pieces.forEach((raw, piece) => {
    const mine = L.map((l, k) => ({ l, k })).filter(({ l }) => l.piece === piece);
    const left = mine.filter(({ k }) => !used[k]);
    const plain = !understood.length || (!mine.length && inHeld(piece));
    if (!left.length && !plain) return;
    if (left.length && left.every(({ l }) => CONJUNCTIONS.has(l.f)) && !plain && !inHeld(piece)) return;
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
      if (!mine.length) {
        if (inHeld(piece)) out.push(raw);
        return;
      }
      if (!left.length) {
        gap = true;
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
    nl: {
      text,
      tailConsumed: understood.length > 0 && lastPiece >= 0 && (onlyFillers || !keptPieces.has(lastPiece)),
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
    },
    failed,
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
