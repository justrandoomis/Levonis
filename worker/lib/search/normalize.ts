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

/** Latin letters that carry accents in brand names ("Créality" typed either way). */
const LATIN_FOLD = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * The comparable form of a string: lower case, no diacritics, folded letters,
 * punctuation reduced to single spaces.
 *
 * Digits are KEPT and never folded — "X2D" and "X1C" differ only by them, and
 * a printer model is mostly digits.
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

/** The longest token worth indexing. Longer strings are ids, not words. */
const MAX_TOKEN = 32;
/** Single characters match everything and rank nothing. */
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
  const norm = normalizeText(input);
  if (!norm) return [];
  const out = new Set<string>();
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
