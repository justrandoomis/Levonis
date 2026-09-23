/**
 * THE SEARCH INDEX, AND THE QUERY THAT READS IT.
 *
 * WHAT WAS THERE BEFORE. One statement:
 *
 *     name LIKE '%q%' OR name_ar LIKE '%q%' OR name_ku LIKE '%q%' OR description LIKE '%q%'
 *
 * Four unindexed substring scans, no tokenisation, no ranking, and no way for
 * «بامبو» to find "Bambu Lab X2D Combo" — which is the shop's flagship
 * product. The owner's brief was «مهما كتب يظهر الذي يريده».
 *
 * WHY NOT FTS5. SQLite's full-text extension would give tokenisation and
 * ranking for free, and would not touch the actual problem: its tokenizers do
 * no Arabic normalisation, no romanisation and no typo tolerance, so every
 * hard part of this would still have to be built beside it. Set against that,
 * a virtual table is a hard dependency on an extension being present in D1 at
 * migration time — and a migration that cannot apply is a deploy that fails
 * on a live shop. Ordinary tables and one index do the job with nothing to
 * find out the hard way.
 *
 * THE SHAPE.
 *
 *   `search_tokens(product_id, token, weight)` — one row per distinct token
 *   per product, with the weight of the best field it appeared in. Written
 *   when a product is saved, from everything a shopper might type: the name in
 *   three languages, the brand, the sections it is filed under, its hashtags,
 *   its model/option names, and the description.
 *
 *   `search_synonyms(term, canonical)` — the dictionary (./vocabulary.ts),
 *   editable by the owner, that turns «طابعة» into "printer".
 *
 *   Every token is stored TWICE: as itself, and as its romanised skeleton
 *   (./translit.ts), so «بامبو» and "bambu" meet in one place.
 *
 * THE QUERY, in one pass:
 *   normalise → tokenise → expand through synonyms and romanisation → look up
 *   a bounded candidate vocabulary by prefix → fuzzy-match within it → score
 *   products by the weights of the tokens they matched.
 */

import { isUsefulToken, normalizeText, tokenize } from './normalize';
import { bestMatches, candidatePrefix } from './match';
import { collapseSpelledLetters, hasArabicScript, loneSpelledLetter, romanize } from './translit';

/**
 * How much a token is worth, by where it was found.
 *
 * A name match is the shopper naming the product. A description match is the
 * product happening to mention the word — "compatible with Bambu Lab" is in
 * half the accessory catalogue, and letting it rank equally would bury the
 * Bambu printer under everything that mentions one.
 */
export const FIELD_WEIGHT = {
  name: 10,
  brand: 8,
  model: 6,
  hashtag: 5,
  category: 4,
  description: 1,
} as const;

export type SearchField = keyof typeof FIELD_WEIGHT;

/** One product's indexable text, field by field. */
export interface SearchDoc {
  productId: string;
  fields: Partial<Record<SearchField, string[]>>;
}

export interface IndexRow {
  product_id: string;
  token: string;
  weight: number;
}

/**
 * The rows a product contributes to the index.
 *
 * A token found in two fields keeps the HIGHER weight rather than both rows:
 * the index answers "how strongly does this product mean this word", and a
 * word in the name is not made stronger by also being in the description.
 */
export function buildIndexRows(doc: SearchDoc): IndexRow[] {
  const best = new Map<string, number>();
  const add = (token: string, weight: number) => {
    if (!isUsefulToken(token)) return;
    const have = best.get(token);
    if (have === undefined || weight > have) best.set(token, weight);
  };
  for (const [field, values] of Object.entries(doc.fields) as [SearchField, string[] | undefined][]) {
    const weight = FIELD_WEIGHT[field] ?? 1;
    for (const value of values ?? []) {
      for (const token of tokenize(value)) {
        add(token, weight);
        // The romanised skeleton, so an Arabic query can reach a Latin name
        // and the other way round. Stored at the same weight — it is the same
        // word, not a weaker signal.
        const skeleton = romanize(token);
        if (skeleton && skeleton !== token) add(skeleton, weight);
      }
    }
  }
  return [...best.entries()].map(([token, weight]) => ({ product_id: doc.productId, token, weight }));
}

// =========================================================================
// THE QUERY SIDE
// =========================================================================

/** What one typed query expands into, before it touches the index. */
export interface ExpandedQuery {
  /** Tokens exactly as typed, normalised. */
  literal: string[];
  /** Everything worth looking up: literals, synonyms, skeletons, collapses. */
  lookup: string[];
}

/**
 * Turn what somebody typed into every token worth looking for.
 *
 * `synonyms` is the loaded dictionary, term → canonical. It is passed in
 * rather than read here so this stays pure and the caller can cache it.
 */
export function expandQuery(raw: string, synonyms: ReadonlyMap<string, string>): ExpandedQuery {
  const normalized = normalizeText(raw);
  if (!normalized) return { literal: [], lookup: [] };
  const literal = tokenize(normalized);
  const lookup = new Set<string>(literal);

  /**
   * A ONE-LETTER QUERY IS A QUERY, NOT DEBRIS — and this is the one place the
   * distinction has to be made.
   *
   * `MIN_TOKEN = 2` in ./normalize.ts is right about the INDEX: a row for "h"
   * on every product whose name contains an H matches everything and ranks
   * nothing, and tests/search.test.ts pins that single characters never become
   * index rows. But `tokenize` is used on BOTH sides, so the same floor was
   * silently applied to what a shopper TYPES: «H» tokenised to nothing,
   * `lookup` came back empty, `searchProducts` took its empty-lookup exit, and
   * the shop answered «لا توجد منتجات» to somebody one keystroke into the name
   * of the printer on the front page. That is the whole of the owner's report.
   *
   * The engine already knows what to do with a one-character term — it has
   * since «اكس» (see the lone-spelled-letter block below, and its test):
   * `candidatePrefix` turns it into a one-character index range and
   * `bestMatches` treats it as a PREFIX, so `h` reaches `h2d` the same way
   * `x` reaches `x2d`. So the letter is added to `lookup` and deliberately NOT
   * to `literal`: it is something to look for, not a word the query is made of.
   *
   * ONLY WHEN IT IS THE WHOLE QUERY, and that limit is not timidity. Coverage
   * is a multiplier in `scoreProducts`, and a bare `1` inside "pla 1" would
   * count as a second covered word while matching a tenth of the vocabulary —
   * which is exactly the dilution that makes "bambu x2d" stop putting the X2D
   * first. A lone letter has nothing to dilute: there is no other word.
   *
   * The romanised skeleton goes in beside it so a shop whose catalogue is
   * written in Latin still answers an Arabic keyboard: «ب» → `b` → "Bambu".
   */
  const words = normalized.split(' ');
  if (words.length === 1 && [...words[0]].length === 1) {
    lookup.add(words[0]);
    const skeleton = romanize(words[0]);
    if (skeleton) lookup.add(skeleton);
  }

  // A MULTI-WORD synonym has to be tried before the words are split up:
  // «بامبو لاب» and «قطع غيار» mean one thing each, and neither half means it.
  for (const [term, canonical] of synonyms) {
    if (term.includes(' ') && normalized.includes(term)) lookup.add(canonical);
  }

  for (const token of literal) {
    const canonical = synonyms.get(token);
    if (canonical) for (const t of tokenize(canonical)) lookup.add(t);
    const skeleton = romanize(token);
    if (skeleton && isUsefulToken(skeleton)) lookup.add(skeleton);
  }

  // «اكس تو دي» → "x2d": Latin letters read aloud in Arabic, which no
  // romanisation can recover. Only attempted on an Arabic-script query.
  if (hasArabicScript(normalized)) {
    for (const collapsed of collapseSpelledLetters(literal)) {
      if (isUsefulToken(collapsed)) lookup.add(collapsed);
      const viaSynonym = synonyms.get(collapsed);
      if (viaSynonym) lookup.add(viaSynonym);
    }
    /**
     * A SINGLE spelled-out letter, which a run of three never sees. The owner
     * types «اكس» on its own and means the X2D, and neither romanisation
     * («اكس» → `aks`) nor the run collapser can reach it.
     *
     * The letter is added as a ONE-CHARACTER term on purpose, and it is the
     * only place `isUsefulToken` is bypassed: `candidatePrefix` turns it into a
     * one-character index range and `bestMatches` treats it as a prefix, so
     * «اكس» lands on `x2d` and `x1c` — which is exactly what somebody saying
     * "X" at a printer shop means. Only the letters that are not also Arabic
     * words are allowed through; see `loneSpelledLetter`.
     */
    for (const token of literal) {
      const letter = loneSpelledLetter(token);
      if (letter) lookup.add(letter);
    }
  }

  return { literal, lookup: [...lookup] };
}

/** The distinct prefixes a candidate-vocabulary lookup needs. */
export function candidatePrefixes(lookup: readonly string[]): string[] {
  return [...new Set(lookup.map(candidatePrefix).filter(Boolean))];
}

export interface ScoredProduct {
  product_id: string;
  score: number;
}

/**
 * Score every product against the expanded query.
 *
 * `rows` is the index slice for the matched tokens — the caller fetched it in
 * one read. The score is the summed field weight of the tokens a product
 * matched, times how good each match was, and then:
 *
 *   COVERAGE IS A MULTIPLIER, NOT A BONUS. A product matching two of the
 *   query's two words beats one matching one of them however heavily
 *   weighted — otherwise "bambu x2d" ranks every Bambu product above the X2D.
 *   That is the single most important line in this function.
 */
export function scoreProducts(
  expanded: ExpandedQuery,
  matchedTokens: ReadonlyMap<string, { score: number; from: string }>,
  rows: readonly IndexRow[]
): ScoredProduct[] {
  const byProduct = new Map<string, { score: number; covered: Set<string> }>();
  for (const row of rows) {
    const match = matchedTokens.get(row.token);
    if (!match) continue;
    let entry = byProduct.get(row.product_id);
    if (!entry) {
      entry = { score: 0, covered: new Set() };
      byProduct.set(row.product_id, entry);
    }
    entry.score += row.weight * match.score;
    entry.covered.add(match.from);
  }

  const wanted = Math.max(1, expanded.literal.length);
  const out: ScoredProduct[] = [];
  for (const [product_id, entry] of byProduct) {
    const coverage = Math.min(1, entry.covered.size / wanted);
    out.push({ product_id, score: entry.score * (0.25 + 0.75 * coverage) * (coverage === 1 ? 1.6 : 1) });
  }
  out.sort((a, b) => b.score - a.score || a.product_id.localeCompare(b.product_id));
  return out;
}

/**
 * How many vocabulary tokens a ONE-CHARACTER term may resolve to.
 *
 * `bestMatches` defaults to five, which is right for a word: five completions
 * of "pla" is already more guessing than a shopper wants. A single letter is
 * not a word — it names a whole shelf, and five tokens is at most five
 * products, so «H» would answer with a handful of the catalogue's H-words
 * chosen by nothing the shopper can see. Forty is still a bounded set the
 * fuzzy pass runs over in the Worker, and it is scored and ranked like any
 * other; the `LIMIT` on the postings read is what actually caps the cost.
 */
const ONE_CHAR_MATCHES = 40;

/**
 * Resolve each query token to the vocabulary tokens it should match.
 *
 * `vocabulary` is the bounded candidate set the prefix lookup returned, NOT
 * the whole index — that is what keeps the fuzzy pass affordable. The result
 * maps an index token to how good a match it is and WHICH query token it came
 * from, because coverage above counts distinct query words, not hits.
 */
export function resolveTokens(
  expanded: ExpandedQuery,
  vocabulary: readonly string[]
): Map<string, { score: number; from: string }> {
  const out = new Map<string, { score: number; from: string }>();
  for (const queryToken of expanded.lookup) {
    // Which ORIGINAL word this expansion serves, so a synonym and its literal
    // do not count as two covered words.
    const from = expanded.literal.find((l) => l === queryToken || romanize(l) === queryToken) ?? queryToken;
    for (const match of bestMatches(queryToken, vocabulary, queryToken.length === 1 ? ONE_CHAR_MATCHES : undefined)) {
      const have = out.get(match.token);
      if (!have || match.score > have.score) out.set(match.token, { score: match.score, from });
    }
  }
  return out;
}
