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
  return token.slice(0, token.length <= 3 ? 1 : 2);
}

export interface TokenMatch {
  token: string;
  /** 1 for an exact hit, lower the further away. */
  score: number;
}

/**
 * Pick the vocabulary tokens a query token should be treated as.
 *
 * An EXACT hit wins outright and stops the search: if the shopper typed a word
 * the shop uses, they meant that word, and offering its neighbours as well
 * would dilute the ranking with near-misses nobody asked for.
 *
 * A PREFIX hit — "bas" for "basic" — scores below exact and above fuzzy,
 * because a prefix is usually somebody still typing rather than somebody
 * making a mistake. That is what makes «pla bas» find "PLA Basic".
 */
export function bestMatches(queryToken: string, vocabulary: readonly string[], limit = 5): TokenMatch[] {
  if (vocabulary.includes(queryToken)) return [{ token: queryToken, score: 1 }];

  const budget = editBudget(queryToken);
  const out: TokenMatch[] = [];
  for (const candidate of vocabulary) {
    if (candidate.startsWith(queryToken)) {
      // Longer completions are weaker: "pla" completing to "plate" is a worse
      // guess than "pla" completing to "plas".
      out.push({ token: candidate, score: 0.75 - Math.min(0.2, (candidate.length - queryToken.length) * 0.02) });
      continue;
    }
    if (budget === 0) continue;
    const d = boundedDistance(queryToken, candidate, budget);
    if (d <= budget) out.push({ token: candidate, score: 0.55 - (d - 1) * 0.15 });
  }
  out.sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
  return out.slice(0, limit);
}
