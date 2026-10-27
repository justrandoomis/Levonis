/**
 * SEARCHING A NAME IN THREE LANGUAGES (plan P1-06): the material and colour
 * pickers filter as the customer types, in Arabic, Sorani or English, with
 * whatever keyboard is on the phone.
 *
 * Both sides are folded the same way before they are compared: Latin case;
 * Arabic diacritics and the tatweel dropped; the hamza forms of alef (أ إ آ ٱ)
 * read as ا, ى as ي, ة as ه, ؤ as و, ئ as ي; and the letters the Arabic and
 * Sorani keyboards type differently for one sound read as one (ك and ک, ي
 * and ی, ه, ە and ھ). Arabic-Indic and Persian digits read as Western ones.
 * A query matches when every word of it is inside the folded name, so «pla»
 * finds «PLA كربون» and «مرن» finds «TPU مرن». Pure: no imports.
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

const LETTERS: Readonly<Record<string, string>> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  'ى': 'ي', 'ی': 'ي', 'ێ': 'ي', 'ئ': 'ي',
  'ة': 'ه', 'ە': 'ه', 'ھ': 'ه',
  'ؤ': 'و', 'ۆ': 'و',
  'ك': 'ک',
  'ڕ': 'ر', 'ڵ': 'ل',
};

const DIGITS = /[٠-٩۰-۹]/g;

/** A string folded for comparison (see the header). */
export function normaliseForSearch(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(DIACRITICS, '')
    .replace(DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/[\s‌‏‎]+/g, ' ')
    .split('')
    .map((ch) => LETTERS[ch] ?? ch)
    .join('')
    .trim();
}

/** Does every word of the query appear in one of the names? An empty query matches everything. */
export function matchesSearch(query: string, names: readonly string[]): boolean {
  const q = normaliseForSearch(query);
  if (!q) return true;
  const hay = names.map(normaliseForSearch).join(' | ');
  return q.split(' ').every((word) => hay.includes(word));
}
