/**
 * TURNING WHAT SOMEBODY TYPED INTO SOMETHING THAT CAN BE COMPARED.
 *
 * THE PROBLEM THIS SOLVES. The shop's search was
 * `name LIKE '%q%' OR name_ar LIKE '%q%' OR name_ku LIKE '%q%' OR description
 * LIKE '%q%'`. A customer looking for the Bambu Lab X2D Combo types «بامبو» or
 * «بمبو» or «اكس تو دي» or «طابعه» and gets nothing, because none of those is
 * a substring of "Bambu Lab X2D Combo". The owner's own words:
 * «مهما كتب يظهر الذي يريده».
 *
 * Four separate problems hide inside that one sentence, and each needs its own
 * tool. Confusing them is why naive search engines fail on Arabic:
 *
 *   1. ORTHOGRAPHY. «طابعة» and «طابعه» are the same word typed two ways, and
 *      so are أ إ آ ا. Arabic writers omit short vowels and vary hamza and ta
 *      marbuta freely. This file handles that, and only that.
 *   2. PHONETIC SPELLING ACROSS SCRIPTS. «بامبو» is "bambu" written in Arabic
 *      letters. That is a ROMANISATION problem — see ./translit.ts.
 *   3. VOCABULARY. «طابعة» means "printer" and «نوزل» means "nozzle". No
 *      amount of string processing discovers that; it is a dictionary, and it
 *      lives in ./vocabulary.ts where the owner can extend it.
 *   4. TYPOS. «بمبو» is «بامبو» with a letter missing. That is edit distance,
 *      applied to a bounded candidate set — see ./match.ts.
 *
 * KURDISH SHARES THE SCRIPT AND NOT THE LETTERS. Sorani (ckb) is written in a
 * modified Arabic script: ک (U+06A9) not ك, ی (U+06CC) not ي, ە (U+06D5) for
 * the vowel, plus ڕ ڵ ۆ وو گ چ پ ژ. A shopper switching keyboards types one
 * form and the catalogue holds the other, so the Kurdish letters are folded
 * onto their Arabic counterparts where they are genuinely the same sound, and
 * left alone where they are not (ڕ ڵ ۆ گ چ پ ژ are distinct sounds and folding
 * them would merge words that differ).
 */

/** Combining marks Arabic writers usually omit and search must always ignore. */
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
/** ـ ARABIC TATWEEL: pure decoration, stretched for justification. */
const TATWEEL = /ـ/g;

/**
 * One character in, one character out. Only folds that never merge two words
 * the shop actually sells.
 *
 * EXPORTED, AND THAT IS THE WHOLE REASON IT IS NOT PRIVATE ANY MORE.
 * `worker/lib/sqlFold.ts` generates BOTH a SQLite `REPLACE(...)` chain and its
 * TypeScript twin from this one object. Two hand-maintained copies of a
 * twenty-entry Arabic map will drift, and when they do the admin search does
 * not error: it silently returns nothing for every name containing the drifted
 * letter, which nobody notices until a customer calls. Behaviour here is
 * unchanged — this is the same table `normalizeText` has always used.
 */
export const FOLD: Record<string, string> = {
  // Alef, every hamza carrier and the superscript form.
  'أ': 'ا', // أ
  'إ': 'ا', // إ
  'آ': 'ا', // آ
  'ٱ': 'ا', // ٱ
  // Ta marbuta → ha. «طابعة» and «طابعه» are one word.
  'ة': 'ه', // ة
  // Alef maqsura → ya. «على» / «علي».
  'ى': 'ي', // ى
  // Hamza carriers that are typed for ئ/ؤ but often written bare.
  'ؤ': 'و', // ؤ
  'ئ': 'ي', // ئ
  // --- Kurdish (ckb) and Persian forms of letters Arabic writes differently.
  'ک': 'ك', // ک → ك  (same sound, different codepoint)
  'ی': 'ي', // ی → ي
  'ە': 'ه', // ە → ه  (Kurdish final vowel, typed for ه)
  'يّ': 'ي',
};

/**
 * A word as a person reads it, minus the marks search ignores: the harakat and
 * the tatweel. Nothing is folded and nothing is lower-cased — «طابعة» stays
 * «طابعة» — because this is for DISPLAYING a word (the grey completion in the
 * search box, ./complete.ts), not for comparing one.
 */
export const stripArabicMarks = (s: string): string => s.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');

/** Latin letters that carry accents in brand names ("Créality" typed either way). */
const LATIN_FOLD = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * The comparable form of a string: lower case, no diacritics, folded letters,
 * punctuation reduced to single spaces.
 *
 * Digits are KEPT and never folded — "X2D" and "X1C" differ only by them, and
 * a printer model is mostly digits.
 *
 * THE STOREFRONT SHIPS THIS FUNCTION in its entry chunk (the grey completion,
 * src/components/search/ghost.ts → ./complete.ts), which is why the search's
 * digit folding lives in `foldText` / `normalizeSearchText` below and not
 * here: the entry chunk is at its budget (tests/bundleBudget.test.ts), and no
 * caller outside the search engine compares digits typed on two keyboards.
 */
export function normalizeText(input: unknown): string {
  if (typeof input !== 'string' || input === '') return '';
  let s = LATIN_FOLD(input.toLowerCase());
  s = s.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');
  let out = '';
  for (const ch of s) out += FOLD[ch] ?? ch;
  // Everything that is not a letter or a digit is a separator. `\p{L}` keeps
  // Arabic, Kurdish and Latin alike without listing ranges.
  return out.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * THE DIGITS A SHOPPER'S KEYBOARD TYPES, AS THE CATALOGUE WRITES THEM.
 *
 * An Arabic keyboard types «٠.٤» (U+0660–U+0669, Arabic-Indic) and a Sorani or
 * Persian one «۰.۴» (U+06F0–U+06F9, Extended Arabic-Indic); the catalogue
 * writes 0.4. They are the same number, so the search makes them the same
 * characters before anything else looks at them, on the index side and the
 * query side alike (`tokenize`). The Arabic decimal separator «٫» (U+066B)
 * becomes the '.' a measure is written with (see `extractMeasures`).
 *
 * NOT IN `FOLD`, deliberately: worker/lib/sqlFold.ts generates the admin
 * order board's SQL fold from that table, character for character, and a
 * digit there is twenty more nested REPLACE calls on a column of names.
 */
const DIGIT_FOLD = /[٠-٩۰-۹٫]/g;
// Both digit blocks start on a multiple of 16 (U+0660, U+06F0): a digit's
// value is its code point's low four bits.
const foldDigit = (ch: string): string => (ch === '٫' ? '.' : String(ch.charCodeAt(0) & 15));

/**
 * The search's own fold: `normalizeText`'s letters, the digits folded to
 * ASCII — and the punctuation KEPT, because the measure pass
 * (`extractMeasures`) reads this form: the '.' in «0.4» and the '×' in «6×2»
 * are exactly what makes them measures.
 */
export function foldText(input: unknown): string {
  if (typeof input !== 'string' || input === '') return '';
  let s = LATIN_FOLD(input.toLowerCase());
  s = s.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');
  let out = '';
  for (const ch of s) out += FOLD[ch] ?? ch;
  return out.replace(DIGIT_FOLD, foldDigit);
}

/** Everything that is not a letter or a digit is a separator. */
const stripPunctuation = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** `normalizeText` with the digits folded (`foldText`): the form a query is compared in. */
export const normalizeSearchText = (input: unknown): string => stripPunctuation(foldText(input));

// =========================================================================
// MEASURES: «0.4», «1.75», «6×2»
// =========================================================================

/**
 * A NUMBER WITH A DOT IN IT IS ONE THING, NOT TWO.
 *
 * '.' and '×' were separators like any other punctuation, and a token needs
 * two characters, so «0.4» tokenised to NOTHING ('0' and '4' are one character
 * each), «0.4mm» to `4mm`, «1.75» to `75`, and «6×2» to nothing at all. The
 * live search for «0.2» answered with nothing, «nozzle 0.4» answered with
 * every nozzle and wiper, and the 6×2 magnet could not be told from the 6×3.
 *
 * So a pass over the folded text — before the punctuation goes — lifts the
 * measures out whole and writes each one canonically:
 *
 *   «0.4», «0.40», «.4», «٠٫٤»   → `0.4`
 *   «1.75mm»                      → `1.75`, and `mm` stays behind as a word
 *   «6×2», «6x2», «6*2», «6 x 2»  → `6x2`        «20×20×2» → `20x20x2`
 *   «0,4», «1,75mm», «٠،٤»        → `0.4`, `1.75`: a decimal COMMA, as half the
 *                                   world writes one (a comma before exactly
 *                                   three digits is a thousands separator, and
 *                                   a list «0.2,0.4» stays a list)
 *   «Ø6×2», «D6x2», «مغناطيس6×2»   → `6x2`: a diameter mark (Ø Φ ⌀, a lone D) or
 *                                   an Arabic-script word glued in front is not
 *                                   part of the size; a Latin word is («m3x8»
 *                                   is a screw, and stays the word it is)
 *   «2.0»                         → `2`, an ordinary number again
 *
 * The span is then removed from the text, so the fragments it used to leave
 * behind (`4mm`, `75`) are never written either: a 0.4mm nozzle is not a
 * "4mm" anything.
 *
 * A measure is matched EXACTLY on the query side (./match.ts `bestMatches`):
 * `6x2` is a prefix of `6x20` and one edit from `6x3`, and both are different
 * products. The one exception is the size still being typed, which nobody
 * carries whole yet («PLA 1.7» on its way to 1.75): see `Measures.last`.
 *
 * A THREE-PART SIZE ALSO GIVES ITS FOOTPRINT on the index side (`tokenize`):
 * a printer's «256×256×256 mm» build volume is what «256x256» asks about, and
 * a plate written «256x256» is not a printer — so the printer carries both,
 * the plate one, and the query «256x256x256» still requires all three parts.
 */
// Regex LITERALS, not `new RegExp(…)`: the storefront bundles this module for
// `normalizeText` (src/lib/policyReader.ts) and a literal is dropped with the
// rest of the measure pass when nothing there uses it.
/**
 * «6×2», «6 x 2», «6*2», «20x20x2». What may stand right in front of one:
 * nothing that is part of a word or a number, an Arabic-script letter
 * («مغناطيس6×2» — no Arabic word continues into a size), a diameter mark
 * («ø6×2», «φ6x2»; ⌀ is not a letter at all) or a D standing alone in front
 * («D6x2 mm», the live magnet's option names). A Latin word is the one thing
 * that may not: «m3x8» is an M3 screw and stays the word it is.
 */
const DIMENSION =
  /(?:(?<![\p{L}\p{N}.])|(?<=\p{Script=Arabic})(?<=\p{L})|(?<=[øφ])|(?<=(?<![\p{L}\p{N}.])d))\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?){1,2}(?![\p{N}])/gu;
/**
 * A decimal COMMA («0,4», «1,75mm», «٠،٤» once the digits are folded): one or
 * two digits after it, and no digit, dot or comma on either side — so
 * «27,000» stays a thousands separator and «0.2,0.4» stays a list.
 */
const DECIMAL_COMMA = /(?<![\p{N}.,،])(\d+)[,،](\d{1,2})(?![\p{N}.,،])/gu;
/** «0.4», «1.75», «PLA1.75», a version «1.5.2»; «.4» only where no word is glued to the dot. */
const DECIMAL = /(?:(?<![\p{N}.])\d+(?:\.\d+)+|(?<![\p{L}\p{N}.])\.\d+)(?![\p{N}])/gu;
/** A dimension's own parts, once the whole run has been matched. */
const DIMENSION_PART = /\d+(?:\.\d+)?/g;

/** One number, written the one way the index holds it: `0.40` → `0.4`, `.4` → `0.4`, `06` → `6`. */
function canonicalNumber(n: string): string {
  const parts = n.split('.');
  // A version or a code with two dots («1.5.2») is kept exactly as written.
  if (parts.length > 2) return parts.map((p) => p || '0').join('.');
  const int = (parts[0] ?? '').replace(/^0+(?=\d)/, '') || '0';
  const frac = (parts[1] ?? '').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * The words that only say WHICH UNIT a measure is in. Indexed like any word
 * (a shopper may type «mm» on its own), but on the query side a unit written
 * against a measure («0.4mm», «0.4 ملم») is already said by the measure, and
 * counting it as a second word would rank a product down for not repeating it.
 */
export const MEASURE_UNITS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  // Written already folded (lower case; no letter `foldText` would change).
  'mm', 'cm', 'ml', 'kg', 'gr', 'gram', 'grams', 'inch',
  'ملم', 'مم', 'ملي', 'ميلي', 'سم', 'سانتي', 'سانت', 'كغ', 'كيلو', 'غرام', 'غم',
]);

export interface Measures {
  /** The measures found, canonical (`0.4`, `6x2`), in the order they were written. */
  measures: string[];
  /** The folded text with every measure taken out, for the ordinary word pass. */
  rest: string;
  /** Unit words written right after a measure («0.4mm» → `mm`). */
  units: string[];
  /**
   * The measure that ENDS the text, nothing after it — on the query side, the
   * size the shopper may still be typing («PLA 1.7» on its way to 1.75; see
   * ./match.ts `bestMatches`). Null when the text ends in anything else,
   * a unit («0.4mm») or a space included.
   */
  last: string | null;
}

/** Lift the measures out of FOLDED text (`foldText`) — see the block above. */
export function extractMeasures(input: string): Measures {
  // One character for one character, so every offset below is an offset into `input` too.
  const folded = input.replace(DECIMAL_COMMA, '$1.$2');
  const measures: string[] = [];
  const units: string[] = [];
  let last: string | null = null;
  const unitAfter = (text: string, end: number) => {
    const m = /^\s*([\p{L}]+)/u.exec(text.slice(end));
    if (m && MEASURE_UNITS.has(m[1])) units.push(m[1]);
  };
  let rest = folded.replace(DIMENSION, (whole: string, offset: number) => {
    const parts = whole.match(DIMENSION_PART) ?? [];
    const canonical = parts.map(canonicalNumber).join('x');
    measures.push(canonical);
    if (offset + whole.length === folded.length) last = canonical;
    unitAfter(folded, offset + whole.length);
    return ' ';
  });
  const afterDims = rest;
  rest = afterDims.replace(DECIMAL, (whole: string, offset: number) => {
    const canonical = canonicalNumber(whole);
    // «2.0» is the number 2: back into the text as one, for the word pass.
    if (!canonical.includes('.')) return canonical;
    measures.push(canonical);
    if (offset + whole.length === afterDims.length) last = canonical;
    unitAfter(afterDims, offset + whole.length);
    return ' ';
  });
  return { measures, rest, units, last };
}

/** A three-part size's footprint, `256x256x256` → `256x256`; null for anything else. */
export function dimensionFootprint(measure: string): string | null {
  const parts = measure.split('x');
  return parts.length === 3 ? `${parts[0]}x${parts[1]}` : null;
}

/** The longest token worth indexing. Longer strings are ids, not words. */
const MAX_TOKEN = 32;
/**
 * Single characters match everything and rank nothing.
 *
 * THIS IS A FLOOR ON THE INDEX, AND ONLY ON THE INDEX. A "h" row on every
 * product whose name contains an H is a posting list the length of the
 * catalogue that separates none of it. But `tokenize` runs on both sides, and
 * for a while the same floor silently governed what a shopper TYPED — so a
 * single «H» expanded to nothing and the shop answered "no products" to
 * somebody one keystroke into the name of the printer on its front page. The
 * query side now keeps a lone character as a PREFIX; see `expandQuery` in
 * ./index.ts, which is where that exception belongs and where it is explained.
 */
const MIN_TOKEN = 2;

/**
 * Normalised text split into searchable tokens.
 *
 * "X2D" STAYS ONE TOKEN and also yields its letter/digit pieces. A model
 * number is typed as one word by somebody who knows it ("x2d") and as pieces
 * by somebody sounding it out ("x 2 d"), and both have to land on the same
 * product. The whole token keeps the higher weight — an exact "x2d" should
 * beat a product that merely contains a "2".
 */
export function tokenize(input: unknown): string[] {
  const folded = foldText(input);
  if (!folded) return [];
  // The measures first («0.4», «6×2»), lifted out whole before the
  // punctuation that makes them measures is turned into spaces.
  const { measures, rest } = extractMeasures(folded);
  const out = new Set<string>();
  for (const m of measures) {
    if (m.length < MIN_TOKEN || m.length > MAX_TOKEN) continue;
    out.add(m);
    // The footprint of a three-part size rides beside it (see the block above).
    const footprint = dimensionFootprint(m);
    if (footprint) out.add(footprint);
  }
  const norm = stripPunctuation(rest);
  if (!norm) return [...out];
  for (const word of norm.split(' ')) {
    if (word.length >= MIN_TOKEN && word.length <= MAX_TOKEN) out.add(word);
    // Split a mixed letter/digit run into its parts: "x2d" → x, 2, d → the
    // pieces long enough to be worth an index row.
    const parts = word.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length >= MIN_TOKEN && part.length <= MAX_TOKEN) out.add(part);
      }
    }
  }
  return [...out];
}

/** True when a token is worth storing or querying at all. */
export const isUsefulToken = (t: string): boolean => t.length >= MIN_TOKEN && t.length <= MAX_TOKEN;
