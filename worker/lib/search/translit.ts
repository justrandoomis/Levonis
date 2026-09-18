/**
 * «بامبو» AND "bambu" ARE THE SAME WORD, AND NEITHER CONTAINS THE OTHER.
 *
 * This is the problem that no amount of `LIKE '%…%'` can touch. An Iraqi
 * shopper types a foreign brand name in Arabic letters — «بامبو لاب»، «كريالتي»،
 * «سناب ميكر» — and the catalogue holds "Bambu Lab", "Creality", "Snapmaker".
 * There is not a single character in common.
 *
 * THE FIX IS A COMMON SPACE. Both sides are romanised to a crude, consistent
 * skeleton, and the comparison happens there:
 *
 *     «بامبو»  →  b a m b w   →  "bambw"
 *     "bambu"  →              →  "bambu"      edit distance 1
 *     «كريالتي» →  k r y a l t y → "kryalty"
 *     "creality" →             → "creality"   after vowel folding, close
 *
 * IT IS DELIBERATELY CRUDE. A scholarly transliteration (ṯ, ḥ, ġ) would be
 * PRECISE and useless here, because the shopper is not transliterating — they
 * are writing what they hear. «بامبو» ends in و, which is w, u and o at once.
 * So long vowels collapse to one vowel class and the comparison is done with
 * bounded edit distance rather than equality, which absorbs the rest.
 *
 * WHAT THIS IS NOT FOR. «طابعة» romanises to "tab'h", which is nothing like
 * "printer" — because it is not a spelling of "printer", it is the Arabic WORD
 * for it. That is a dictionary problem and it lives in ./vocabulary.ts. Using
 * romanisation there would produce confident nonsense; keeping the two apart
 * is what makes each one trustworthy.
 */

/**
 * Arabic and Kurdish letters to their rough Latin sound.
 *
 * Applied AFTER `normalizeText`, so the folded forms (أإآ→ا, ة→ه, ى→ي, ک→ك,
 * ی→ي, ە→ه) are the only ones that arrive here.
 */
const AR_TO_LATIN: Record<string, string> = {
  'ا': 'a', // ا
  'ب': 'b', // ب
  'ت': 't', // ت
  'ث': 'th', // ث
  'ج': 'j', // ج
  'ح': 'h', // ح
  'خ': 'kh', // خ
  'د': 'd', // د
  'ذ': 'z', // ذ
  'ر': 'r', // ر
  'ز': 'z', // ز
  'س': 's', // س
  'ش': 'sh', // ش
  'ص': 's', // ص
  'ض': 'd', // ض
  'ط': 't', // ط
  'ظ': 'z', // ظ
  'ع': 'a', // ع — no Latin sound; a vowel is the closest a typist means
  'غ': 'gh', // غ
  'ف': 'f', // ف
  'ق': 'q', // ق
  'ك': 'k', // ك
  'ل': 'l', // ل
  'م': 'm', // م
  'ن': 'n', // ن
  'ه': 'h', // ه
  'و': 'w', // و — w/u/o, folded to one vowel class below
  'ي': 'y', // ي — y/i/ee, likewise
  'ء': '', // ء — carries no sound on its own
  // Kurdish-specific letters that are NOT folded in normalize.ts because they
  // are genuinely different sounds.
  'پ': 'p', // پ
  'چ': 'ch', // چ
  'ڤ': 'v', // ڤ
  'گ': 'g', // گ
  'ژ': 'zh', // ژ
  'ڕ': 'r', // ڕ
  'ڵ': 'l', // ڵ
  'ۆ': 'o', // ۆ
  'ھ': 'h', // ھ
};

/** True when the string contains at least one Arabic-script letter. */
export const hasArabicScript = (s: string): boolean => /[؀-ۿݐ-ݿ]/.test(s);

/**
 * The vowel classes. Latin and Arabic spellings of the same foreign word
 * disagree about vowels far more than about consonants — "bambu"/"bambo",
 * «سناب»/"snap" — so every vowel becomes one symbol before comparison. The
 * consonant skeleton is what actually identifies the word.
 */
const VOWELS = /[aeiouwy]+/g;

/**
 * A comparable Latin skeleton for any token, in either script.
 *
 * Doubled letters collapse ("bambuu" = "bambu"), vowels collapse to a single
 * `a`, and the result is what `./match.ts` compares with bounded edit
 * distance. Returns '' for a token with no usable letters, which the caller
 * treats as "no skeleton", never as "matches everything".
 */
export function romanize(token: string): string {
  let out = '';
  for (const ch of token) {
    const mapped = AR_TO_LATIN[ch];
    out += mapped === undefined ? ch : mapped;
  }
  // Digits survive untouched — "x2d" and "x1c" differ only by them.
  out = out.replace(VOWELS, 'a').replace(/(.)\1+/g, '$1');
  return out.replace(/[^a-z0-9]/g, '');
}

/**
 * How Arabic speakers SPELL OUT Latin letters, which romanisation cannot
 * guess.
 *
 * «اكس تو دي» is not a phonetic rendering of "x2d" — it is the three symbols
 * read aloud, "ex", "two", "dee", each written as an Arabic word. Romanising
 * gives "aks tw dy", which is nowhere near "x2d". Only a table knows.
 *
 * Kept HERE rather than in vocabulary.ts because it is script mechanics, not
 * shop vocabulary: it is true of every Latin model number in any catalogue,
 * and the owner should never have to maintain it.
 */
const SPELLED_LETTERS: Record<string, string> = {
  اي: 'a', بي: 'b', سي: 'c', دي: 'd', ئي: 'e', اف: 'f', جي: 'g',
  اتش: 'h', اج: 'h', اي_: 'i', جاي: 'j', كي: 'k', ال: 'l', ام: 'm',
  ان: 'n', او: 'o', بيي: 'p', كيو: 'q', ار: 'r', اس: 's', تي: 't',
  يو: 'u', في: 'v', دبليو: 'w', اكس: 'x', واي: 'y', زد: 'z', زي: 'z',
  // The digits, read aloud.
  زيرو: '0', صفر: '0', ون: '1', واحد: '1', تو: '2', اثنين: '2',
  ثري: '3', ثلاثه: '3', فور: '4', اربعه: '4', فايف: '5', خمسه: '5',
  سكس: '6', سته: '6', سفن: '7', سبعه: '7', ايت: '8', ثمانيه: '8',
  ناين: '9', تسعه: '9',
};

/**
 * The spelled letters that are SAFE TO READ AS A LETTER WHEN THEY STAND ALONE.
 *
 * Most of the table above is only safe inside a RUN, and that is not a detail:
 * «ال» is the Arabic definite article, «في» is "in", «او» is "or", «ان» is
 * "that", «ام» is "mother". Reading a lone «في» as the letter V would turn the
 * commonest word in the language into a wildcard, and «ال» would match every
 * product whose name contains an L.
 *
 * These are the ones that are not Arabic words at all — they exist only as
 * somebody saying a Latin letter out loud. The owner's own example «اكس» is
 * the reason this set exists: they type it alone and expect the X2D.
 */
const SAFE_ALONE = new Set(['اكس', 'دبليو', 'كيو', 'جاي', 'اتش', 'زد', 'بيي']);

/**
 * The single Latin letter this word spells, when the word can only be that —
 * or null. One character, deliberately: the caller uses it as a PREFIX, so
 * «اكس» reaches `x2d` and `x1c` without pretending to be a word of its own.
 */
export function loneSpelledLetter(token: string): string | null {
  if (!SAFE_ALONE.has(token)) return null;
  return SPELLED_LETTERS[token] ?? null;
}

/**
 * Collapse a run of spelled-out letters into the string they spell.
 *
 * «اكس تو دي» → "x2d". Only applied to a run of THREE OR MORE consecutive
 * spelled tokens, or a run that produces at least two characters next to a
 * digit: two isolated words like «في دي» ("in D") are ordinary Arabic far more
 * often than they are a model number, and collapsing them would corrupt a
 * perfectly good query.
 */
export function collapseSpelledLetters(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else if (run.length === 2 && /\d/.test(run.join(''))) out.push(run.join(''));
    run = [];
  };
  for (const token of tokens) {
    const letter = SPELLED_LETTERS[token];
    if (letter !== undefined) {
      run.push(letter);
      continue;
    }
    flush();
  }
  flush();
  return out;
}
