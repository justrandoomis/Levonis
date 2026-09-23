/**
 * THE GREY WORD'S RULES, apart from React so a unit test can hold them.
 *
 * «اقتراحات بلون رصاصي في الشريط الكتابي نفسه، عند الضغط على سبيس يملأ هذا
 * الاقتراح». The Worker picks the word (worker/lib/search/complete.ts, riding
 * on every search listing as `suggestion`); this decides how much of it is
 * still grey while the shopper types, and when a key takes it.
 *
 * SPACE TAKES IT ONLY WHEN IT IS SHOWING. Space is also how every word ends,
 * so a completion that Space accepted while nobody could see it would rewrite
 * words out from under the shopper. The ghost is visible only with the caret
 * at the end of the text and a word being typed there; anywhere else Space is
 * a space.
 *
 * DETECTED FROM THE EDIT, NOT THE KEY. Phone keyboards report most keys as
 * `Unidentified` (keyCode 229) and compose words before committing them, so a
 * keydown handler for ' ' never fires on the devices this shop is used from.
 * What every keyboard does agree on is the edit itself: the value grew by
 * exactly one trailing space. That is the one signal `acceptOnChange` reads.
 */

import { completionSuffix, typingFragment } from '../../../worker/lib/search/complete';

/** Hebrew, Arabic, Syriac, Thaana… and the Arabic presentation forms. */
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LETTER = /\p{L}/u;

/**
 * The direction of a piece of text: that of its first strong letter, or
 * `fallback` when it has none («123», empty). This is what `dir="auto"`
 * computes; it is done here because the grey tail is drawn by a SECOND element
 * that must be laid out in exactly the same direction as the input.
 */
export function textDirection(text: string, fallback: 'rtl' | 'ltr'): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LETTER.test(ch)) return 'ltr';
  }
  return fallback;
}

/**
 * The grey tail to draw after `value`, or '' for none.
 *
 * Also '' when the word being typed runs the OTHER way from the text around it
 * ("طابعة H2" → "D"): the tail belongs visually beside "H2", inside a
 * left-to-right run in a right-to-left line, and a second element drawn after
 * the whole line would put it somewhere else. Rare, and better absent than
 * misplaced.
 */
export function ghostFor(value: string, suggestion: string | null | undefined, direction: 'rtl' | 'ltr'): string {
  if (!suggestion || !value || /\s$/u.test(value)) return '';
  const fragment = typingFragment(value);
  if (!fragment || textDirection(fragment, direction) !== direction) return '';
  return completionSuffix(fragment, suggestion) ?? '';
}

/**
 * Arabic-script letters that never join to the letter AFTER them. After one of
 * these a word breaks visually anyway; after any other the typed letter and
 * the grey one belong to one joined word.
 */
const JOINS_BACKWARD_ONLY = new Set([...'ءآأؤإاةدذرزوٱۆڕژەۇۈۋۅۉ']);
const ARABIC_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06D5\u06FA-\u06FC\u06FF]/u;
const ZWJ = '\u200D';
const ZWNJ = '\u200C';

/**
 * The two pieces of the grey line as DRAWN, which for Arabic is not quite the
 * text as typed.
 *
 * Arabic is joined writing: «طاب» followed by «عة» is one word, «طابعة», and
 * the ع takes its connected form because a ب comes before it. The grey tail is
 * a separate piece of text, so on its own it is shaped as the start of a NEW
 * word — an isolated «عة» floating after «طاب». A zero-width JOINER in front of
 * the tail gives its first letter the connected shape it has in the real word.
 *
 * And a zero-width NON-joiner after the invisible copy of what was typed keeps
 * that copy shaped exactly like the input's own text, whose last letter has
 * nothing after it and so takes its final form. Without it the browser shapes
 * across the two spans, the invisible ب turns medial and narrower, and the
 * grey tail slides back over the letters it is meant to follow.
 *
 * Display only: the value a shopper accepts never contains either mark.
 */
export function ghostLayers(value: string, ghost: string): { typed: string; tail: string } {
  if (!ghost) return { typed: value, tail: '' };
  const last = [...value].pop() ?? '';
  const first = [...ghost][0] ?? '';
  if (ARABIC_LETTER.test(last) && ARABIC_LETTER.test(first) && !JOINS_BACKWARD_ONLY.has(last)) {
    return { typed: `${value}${ZWNJ}`, tail: `${ZWJ}${ghost}` };
  }
  return { typed: value, tail: ghost };
}

/**
 * `value` with its last word completed: the typed letters REPLACED by the
 * suggested word, not the grey tail glued onto them. The suggestion is chosen
 * ignoring case and hamza/ta-marbuta spelling, so the typed letters and the
 * word's own can differ — "HOT" + "end" read «HOTend», "PLA" + "te" «PLAte».
 * The shop's spelling of the word is what the shopper accepted. Falls back to
 * appending the tail when `suggestion` is not the word the tail came from.
 */
function completed(value: string, ghost: string, suggestion: string | null | undefined): string {
  const fragment = typingFragment(value);
  if (suggestion && fragment && value.endsWith(fragment) && completionSuffix(fragment, suggestion) === ghost) {
    return `${value.slice(0, value.length - fragment.length)}${suggestion}`;
  }
  return `${value}${ghost}`;
}

/**
 * The value after an edit that accepted the ghost with a space — or null when
 * the edit was anything else and should land as typed.
 */
export function acceptOnChange(
  previous: string,
  next: string,
  ghost: string,
  suggestion?: string | null
): string | null {
  if (!ghost || next !== `${previous} `) return null;
  return `${completed(previous, ghost, suggestion)} `;
}

/**
 * The value after a key that accepts the ghost on a keyboard — Tab, or the
 * arrow that points toward the END of the text (→ in English, ← in Arabic) —
 * or null when the key should do its usual job.
 */
export function acceptOnKey(
  key: string,
  value: string,
  ghost: string,
  direction: 'rtl' | 'ltr',
  caretAtEnd: boolean,
  suggestion?: string | null
): string | null {
  if (!ghost || !caretAtEnd) return null;
  if (key === 'Tab' || key === (direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight')) {
    return completed(value, ghost, suggestion);
  }
  return null;
}

/**
 * The highlighted row after ↑/↓, where -1 is "none — the text field". Moving
 * past either end comes back to the field, which is where Enter searches.
 */
export function stepActive(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  const next = current + delta;
  if (next >= count) return -1;
  if (next < -1) return count - 1;
  return next;
}

/**
 * The query a live search sends: leading space dropped, runs of space
 * collapsed — and a TRAILING space kept, because it tells the Worker the last
 * word is finished and must not be completed.
 */
export function liveQuery(value: string): string {
  return value.replace(/^\s+/u, '').replace(/\s+/gu, ' ');
}
