/**
 * TYPO TOLERANCE THAT A WORKER CAN AFFORD.
 *
 * «بمبو» is «بامبو» with a letter missing, and the shopper who typed it is
 * looking at a Bambu Lab printer right now. Finding it means edit distance,
 * and edit distance means comparing the query against a vocabulary — which is
 * the expensive part, not the algorithm.
 *
 * THE COST IS CONTROLLED BY WHAT IS COMPARED, NOT BY HOW. Running Levenshtein
 * over every token in the catalogue is what makes fuzzy search slow. So the
 * candidate set is cut first, in SQL, by a cheap index lookup — tokens sharing
 * the query token's first two characters — and only that handful reaches the
 * distance function. For a catalogue of any realistic size that is tens of
 * tokens, not thousands.
 *
 * AND THE DISTANCE IS BOUNDED. `boundedDistance` stops as soon as the best
 * possible remaining score exceeds the limit, so a comparison that cannot
 * match costs a row of the matrix rather than the whole thing. One edit for a
 * short word, two for a long one: three edits on a five-letter word is not a
 * typo, it is a different word, and accepting it is how a search engine starts
 * confidently returning the wrong thing.
 */

/**
 * Levenshtein distance between `a` and `b`, abandoned once it exceeds `max`.
 *
 * Returns `max + 1` for "further than you care about" rather than the true
 * distance — the caller only ever asks "is this within the limit", and
 * computing the exact answer for a pair that already failed is work nobody
 * reads. Two rolling rows rather than a full matrix: the memory is the length
 * of the shorter string, not their product.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowBest = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowBest) rowBest = curr[j];
    }
    // Nothing later can undo a row whose best cell already exceeds the budget.
    if (rowBest > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/**
 * How many edits a token of this length is allowed to be wrong by.
 *
 * Short tokens get none: "abs" and "ams" are one edit apart and are a plastic
 * and a filament changer. Allowing a typo there would make the two
 * indistinguishable, and being WRONG is worse than finding nothing — a shopper
 * who searches for ABS and is shown an AMS has been misled by the shop.
 */
export function editBudget(token: string): number {
  if (token.length <= 3) return 0;
  if (token.length <= 6) return 1;
  return 2;
}

/**
 * The SQL prefix a candidate lookup narrows on: the first two characters, or
 * one for a very short token.
 *
 * Two is the sweet spot. One character pulls in a tenth of the vocabulary;
 * three misses a typo in the second letter, which is where typos actually
 * happen. Two with an edit budget covers «بمبو»/«بامبو» (same first two) and
 * "creality"/"crealty", and it is an index range scan either way.
 */
export function candidatePrefix(token: string): string {
  // A skeleton-only key (`~` + skeleton, see SKELETON_MARK in ./index.ts)
  // narrows on the SKELETON's own prefix, with the mark kept in front: `~` on
  // its own would be a range over every Latin skeleton in the shop.
  if (token.startsWith(SKELETON_MARK)) return SKELETON_MARK + candidatePrefix(token.slice(SKELETON_MARK.length));
  return token.slice(0, token.length <= 3 ? 1 : 2);
}

/**
 * The mark in front of a Latin word's skeleton in the index. Defined here, not
 * in ./index.ts, because this module is the lower one: ./index.ts imports it.
 */
export const SKELETON_MARK = '~';

export interface TokenMatch {
  token: string;
  /** 1 for an exact hit, lower the further away. */
  score: number;
}

/**
 * How good a guess a completion is. Longer completions are weaker: "pla"
 * completing to "plas" is a better guess than "pla" completing to "plastic".
 */
export const prefixScore = (queryToken: string, candidate: string): number =>
  0.75 - Math.min(0.2, (candidate.length - queryToken.length) * 0.02);

export interface MatchOptions {
  /**
   * The shopper is still typing this token (it is the query's last word), so
   * an exact hit does not end the search: its completions are offered too.
   */
  complete?: boolean;
  /**
   * The heaviest field weight each candidate carries in the index. When
   * given, the candidates kept are the ones worth the most to a product's
   * score — weight × quality — rather than simply the closest strings.
   */
  weights?: ReadonlyMap<string, number>;
}

/**
 * Pick the vocabulary tokens a query token should be treated as.
 *
 * An EXACT hit wins outright and stops the search — for a FINISHED word. If
 * the shopper typed a word the shop uses and then moved on, they meant that
 * word, and offering its neighbours as well would dilute the ranking with
 * near-misses nobody asked for. An exact hit is never "corrected" into a
 * typo-neighbour either way.
 *
 * FOR THE WORD STILL BEING TYPED (`complete`) the exact hit is kept AND its
 * completions are offered beside it. "hard" is an exact word in some
 * description, and the shopper typing it is on their way to "Hardened"; the
 * exact-hit rule used to answer with the description and never look at the
 * nozzle. Ranking by `weights` is what then puts the NAMED completion first:
 * "hardened" in a name (10 × 0.71) outweighs "hard" in prose (1 × 1).
 *
 * A PREFIX hit — "bas" for "basic" — scores below exact and above fuzzy,
 * because a prefix is usually somebody still typing rather than somebody
 * making a mistake. That is what makes «pla bas» find "PLA Basic".
 */
export function bestMatches(
  queryToken: string,
  vocabulary: readonly string[],
  limit = 5,
  opts: MatchOptions = {}
): TokenMatch[] {
  const exact = vocabulary.includes(queryToken);
  if (exact && !opts.complete) return [{ token: queryToken, score: 1 }];

  // The mark on a skeleton key is not a letter anybody typed.
  const budget = editBudget(queryToken.startsWith(SKELETON_MARK) ? queryToken.slice(SKELETON_MARK.length) : queryToken);
  const out: TokenMatch[] = [];
  for (const candidate of vocabulary) {
    if (candidate === queryToken) continue;
    if (candidate.startsWith(queryToken)) {
      out.push({ token: candidate, score: prefixScore(queryToken, candidate) });
      continue;
    }
    if (exact || budget === 0) continue;
    const d = boundedDistance(queryToken, candidate, budget);
    if (d <= budget) out.push({ token: candidate, score: 0.55 - (d - 1) * 0.15 });
  }
  const worth = (m: TokenMatch) => (opts.weights?.get(m.token) ?? 1) * m.score;
  out.sort((a, b) => worth(b) - worth(a) || b.score - a.score || a.token.localeCompare(b.token));
  const picked = out.slice(0, limit);
  return exact ? [{ token: queryToken, score: 1 }, ...picked] : picked;
}
