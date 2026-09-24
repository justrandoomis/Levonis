/**
 * THE ARITHMETIC OF MOVING THROUGH A LIST WITH A KEYBOARD — and of finding a
 * row by typing.
 *
 * Menus, tab strips, the command palette and any future listbox all answer
 * the same questions: which row does ArrowDown land on when the next one is
 * disabled, what does Home mean, and which row does typing «ط» jump to. Each
 * component that answered them privately answered them slightly differently,
 * which is how one menu wraps and the next one stops. They live here, pure,
 * so the rules are tested once (`tests/uiPrimitivesLogic.test.ts`).
 *
 * SEARCH TEXT IS NORMALISED FOR THE KEYBOARDS PEOPLE HERE ACTUALLY HAVE. An
 * Arabic keyboard types ك and ي where a Kurdish one types ک and ی; somebody
 * searching «اسعار» must find «أسعار»; a diacritic or a tatweel must not hide
 * a word; and «١٢» must find «12». None of that is translation — the letters
 * are folded to one spelling for COMPARISON only, and nothing folded is ever
 * displayed.
 */
import { toAsciiDigits } from './localeNumber';

/**
 * The index one step from `current`, skipping disabled rows, wrapping at the
 * ends. `current = -1` means "nothing active yet": a step forward lands on the
 * first enabled row, a step back on the last.
 */
export function stepIndex(
  current: number,
  delta: 1 | -1,
  count: number,
  disabled?: (index: number) => boolean
): number {
  if (count <= 0) return -1;
  let i = current < 0 ? (delta > 0 ? -1 : count) : current;
  for (let n = 0; n < count; n++) {
    i = (i + delta + count) % count;
    if (!disabled?.(i)) return i;
  }
  return current;
}

/** The first (or last) enabled index, or -1 when every row is disabled. */
export function edgeIndex(edge: 'first' | 'last', count: number, disabled?: (index: number) => boolean): number {
  return stepIndex(-1, edge === 'first' ? 1 : -1, count, disabled);
}

const MARKS = /[\u064B-\u065F\u0670\u0640\u200E\u200F]|\u200C|\u200D/g;

/** Folds a string for comparison: case, Arabic/Kurdish letter variants, marks, digits. */
export function normalizeSearchText(s: string): string {
  return toAsciiDigits(s)
    .toLowerCase()
    .replace(MARKS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىیئ]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[ةە]/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * TYPEAHEAD, the way native menus do it: typing jumps to the next row whose
 * label starts with what was typed. Pressing the SAME letter repeatedly
 * cycles through the rows that start with it («ط», «ط», «ط» walks every «ط…»
 * row) instead of searching for «طط». A single letter searches from the row
 * AFTER the active one, so a second press moves on; a longer query may stay
 * on the active row if it still matches. Returns -1 when nothing matches.
 */
export function typeaheadIndex(
  labels: readonly string[],
  current: number,
  query: string,
  disabled?: (index: number) => boolean
): number {
  const typed = normalizeSearchText(query);
  if (!typed || labels.length === 0) return -1;
  const repeated = typed.length > 1 && [...typed].every((c) => c === typed[0]);
  const needle = repeated ? typed[0] : typed;
  const skipCurrent = needle.length === 1;
  const start = current < 0 ? 0 : current;
  for (let n = 0; n < labels.length; n++) {
    const i = (start + n + (skipCurrent && current >= 0 ? 1 : 0)) % labels.length;
    if (disabled?.(i)) continue;
    if (normalizeSearchText(labels[i]).startsWith(needle)) return i;
  }
  return -1;
}

export interface Searchable {
  label: string;
  /** More words that should find it — synonyms in the other languages, a SKU. */
  keywords?: readonly string[];
  /** Secondary text shown beside it; searched last. */
  hint?: string;
}

/**
 * How well `item` answers `query`: 0 means it does not. Every word of the
 * query must be found somewhere; a label that STARTS with the query beats one
 * where a word starts with it, which beats a match inside a word, which beats
 * a match only in the keywords or the hint.
 */
export function matchScore(item: Searchable, query: string): number {
  const words = normalizeSearchText(query).split(' ').filter(Boolean);
  if (words.length === 0) return 1;
  const label = normalizeSearchText(item.label);
  const extra = [...(item.keywords ?? []), item.hint ?? ''].map(normalizeSearchText).filter(Boolean);
  let score = 0;
  for (const w of words) {
    if (label.startsWith(w)) score += 8;
    else if (label.includes(` ${w}`)) score += 6;
    else if (label.includes(w)) score += 4;
    else if (extra.some((k) => k.startsWith(w) || k.includes(` ${w}`))) score += 2;
    else if (extra.some((k) => k.includes(w))) score += 1;
    else return 0;
  }
  return score;
}

/** The items that answer `query`, best first; ties keep their given order. */
export function filterByQuery<T extends Searchable>(items: readonly T[], query: string): T[] {
  if (!normalizeSearchText(query)) return [...items];
  return items
    .map((item, index) => ({ item, index, score: matchScore(item, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
