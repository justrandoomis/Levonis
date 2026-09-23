/**
 * THE GREY WORD IN THE SEARCH BOX — «اقتراحات بلون رصاصي في الشريط الكتابي
 * نفسه، عند الضغط على سبيس يملأ هذا الاقتراح».
 *
 * WHAT IT COMPLETES: THE WORD BEING TYPED, NOT THE WHOLE QUERY. Space is the
 * key the owner named, and Space is also how every shopper ends a word. A
 * suggestion that filled in a whole product name would turn "hot glue" into
 * "Hotend Assembly for P1S " the moment the shopper reached for the space bar.
 * Completing only the word under the caret — «طاب» → «طابعة», "hot" →
 * "Hotend" — is the most Space can take from somebody who meant something
 * else, and it is the same unit the index completes (`completing` in
 * ./index.ts), so the grey word always names something the results contain.
 *
 * WHERE THE WORD COMES FROM. The names of the products the search actually
 * ranked first, in the order it ranked them — never the index vocabulary. The
 * index stores FOLDED tokens («طابعه», "hotend"), and a completion has to be
 * shown the way the shop writes it: «طابعة», "Hotend".
 *
 * ONE MODULE ON BOTH SIDES. The Worker picks the word (`suggestCompletion`);
 * the storefront decides how much of it is still grey as the shopper keeps
 * typing (`completionSuffix`). Both have to agree on what "the same letters"
 * means — hamza, ta marbuta, ک/ك, case — and that is `normalizeText`, so the
 * browser imports this file rather than keeping a second copy of the fold
 * table (the precedent is src/lib/policyReader.ts). It imports nothing but
 * ./normalize, which imports nothing at all.
 */

import { normalizeText, stripArabicMarks } from './normalize';

/** Letters, digits and the combining marks that belong to them. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const WORD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;

/**
 * The word still being typed: the run of letters and digits the text ENDS in,
 * or '' when it ends in a space, a slash or nothing. "bambu la" → "la";
 * "bambu " → '' (the shopper has finished that word and said so).
 */
export function typingFragment(text: string): string {
  const chars = [...text];
  let start = chars.length;
  while (start > 0 && WORD_CHAR.test(chars[start - 1])) start -= 1;
  return chars.slice(start).join('');
}

/**
 * What is left of `word` once `fragment` has been typed — the grey part — or
 * null when `word` does not continue `fragment`, or has nothing left to add.
 *
 * The comparison is the index's own (`normalizeText`): «طابعة» continues
 * «طابعه», "Hotend" continues "HOT", «کۆ» and «كۆ» are one prefix. It walks
 * the word one character at a time rather than slicing at `fragment.length`,
 * because a folded character and a displayed one are not always the same
 * length — a harakah is one character on screen and none in the fold.
 */
export function completionSuffix(fragment: string, word: string): string | null {
  const want = normalizeText(fragment);
  if (!want || want.includes(' ')) return null;
  const chars = [...word];
  let seen = '';
  for (let i = 0; i < chars.length; i += 1) {
    seen += normalizeText(chars[i]);
    if (seen.length < want.length) {
      if (!want.startsWith(seen)) return null;
      continue;
    }
    if (seen !== want) return null;
    // Marks that sit on the last typed letter belong to it, not to the grey
    // tail — a tail that starts with a lone harakah renders as a dotted circle.
    let j = i + 1;
    while (j < chars.length && normalizeText(chars[j]) === '') j += 1;
    const rest = chars.slice(j).join('');
    return rest && normalizeText(rest) ? rest : null;
  }
  return null;
}

/**
 * The display word that completes the query's last word, taken from `texts` in
 * the order given — the product names of the results, best first — or null.
 *
 * A query that ends in whitespace has no word being typed, so it gets no
 * completion: the shopper has already told us that word is finished.
 *
 * NOR DOES A WORD THE RESULTS ALREADY SAY WHOLE. "PLA" is a finished word when
 * the first result is "PLA Basic Filament", and Space is how the shopper says
 * so; a grey "te" borrowed from the PEI Plate further down turned that Space
 * into «PLAte » and searched for the plate. So the texts are read in rank
 * order and the first one that settles the question wins: a text holding the
 * typed word exactly means "no suggestion", a text holding a longer word means
 * that word. A product ranked below the one that names the word whole cannot
 * lend it a longer one.
 */
export function suggestCompletion(rawQuery: string, texts: readonly unknown[]): string | null {
  if (typeof rawQuery !== 'string' || rawQuery === '' || /\s$/u.test(rawQuery)) return null;
  const fragment = typingFragment(rawQuery);
  if (!fragment) return null;
  const typed = normalizeText(fragment);
  if (!typed) return null;
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue;
    const words = text
      .split(WORD_SPLIT)
      .map((raw) => (raw ? stripArabicMarks(raw) : ''))
      .filter(Boolean);
    if (words.some((word) => normalizeText(word) === typed)) return null;
    for (const word of words) if (completionSuffix(fragment, word)) return word;
  }
  return null;
}
