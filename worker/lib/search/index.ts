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
 *   (./translit.ts), so «بامبو» and "bambu" meet in one place. A Latin word's
 *   skeleton carries SKELETON_MARK (`~alaga` for "elegoo") so that only a
 *   query typed in Arabic letters ever looks it up — see `buildIndexRows`.
 *
 * THE QUERY, in one pass:
 *   normalise → tokenise → expand through synonyms and romanisation → look up
 *   a bounded candidate vocabulary by prefix → fuzzy-match within it → score
 *   products by the weights of the tokens they matched.
 */

import { isUsefulToken, normalizeText, tokenize } from './normalize';
import { bestMatches, candidatePrefix, prefixScore, SKELETON_MARK, type TokenMatch } from './match';

export { SKELETON_MARK };
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
        // The romanised skeleton, so a Latin query can reach an Arabic name
        // («بامبو» is stored as `bamba` beside itself, and "bambu" reaches it).
        // Stored at the same weight — it is the same word, not a weaker signal.
        //
        // ONLY FOR A WORD WRITTEN IN ARABIC SCRIPT. A Latin word's skeleton is
        // not a bridge to anything — it is the same word with its vowels
        // flattened, and flattening vowels is what makes different English
        // words collide: "heat" and "hot" are both `hat`, "plate" is `plata`
        // beside "pla". Those collisions put the Heatbed ABOVE the Hotend for
        // "hot", let the description word "how" (`ha`) answer "Ha" instead of
        // "Hardened", and counted "plate" twice against "pla". An Arabic
        // query still reaches a Latin name through its OWN skeleton (`bamba`
        // is one edit from "bambu"), which is where cross-script matching
        // actually happens.
        if (hasArabicScript(token)) {
          const skeleton = romanize(token);
          if (skeleton && skeleton !== token) add(skeleton, weight);
        } else {
          // …BUT AN ARABIC QUERY STILL NEEDS TO MEET IT. «اليجو» romanises to
          // `alaga`, and "elegoo" is `alaga` only once ITS vowels are flattened
          // too — as a bare word it is three edits away and no fuzzy budget
          // reaches it. So the Latin skeleton is stored under SKELETON_MARK,
          // `~alaga`: a key no Latin query can open (normalizeText turns `~`
          // into a space, and every range a Latin token opens stops below it),
          // and one `expandQuery` looks up ONLY for a word typed in Arabic
          // letters. Latin never meets Latin through it, which is the collision
          // above; Arabic reaches every brand, dictionary or not.
          const skeleton = romanize(token);
          if (/[a-z]/.test(skeleton) && isUsefulToken(skeleton)) add(SKELETON_MARK + skeleton, weight);
        }
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
  /**
   * Which typed word each lookup token SERVES — a literal serves itself, its
   * skeleton and its synonyms serve it. Coverage counts typed words, and a
   * synonym found beside its own literal is one word found twice, not two
   * words found: «طابعه» matching both «طابعه» and "printer" used to read as
   * full coverage of a two-word query.
   */
  origin: ReadonlyMap<string, string>;
  /**
   * The lookup tokens the shopper is STILL TYPING — the last word and its
   * skeleton, unless the query ends in a space. These are matched as prefixes
   * even when the vocabulary holds them exactly; see `bestMatches`.
   */
  completing: ReadonlySet<string>;
}

export interface ExpandOptions {
  /**
   * False when the raw query ended in whitespace: the shopper finished the
   * last word and said so, so nothing is being typed and nothing is completed.
   * The route passes this because its validator trims the parameter before
   * this function sees it. Defaults to "the last word is still being typed".
   */
  completeLast?: boolean;
}

/**
 * Turn what somebody typed into every token worth looking for.
 *
 * `synonyms` is the loaded dictionary, term → canonical. It is passed in
 * rather than read here so this stays pure and the caller can cache it.
 */
export function expandQuery(
  raw: string,
  synonyms: ReadonlyMap<string, string>,
  opts: ExpandOptions = {}
): ExpandedQuery {
  const normalized = normalizeText(raw);
  if (!normalized) return { literal: [], lookup: [], origin: new Map(), completing: new Set() };
  const literal = tokenize(normalized);
  const lookup = new Set<string>(literal);
  const origin = new Map<string, string>(literal.map((l) => [l, l]));
  /** Look `token` up on behalf of the typed word `from`. First claim wins. */
  const serve = (token: string, from: string) => {
    lookup.add(token);
    if (!origin.has(token)) origin.set(token, from);
  };

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
    serve(words[0], words[0]);
    // Only an ARABIC letter needs a skeleton to cross scripts. romanize() on a
    // Latin vowel flattens it — "e" becomes `a` — so a shopper typing «E»
    // would have been answered with the A shelf.
    if (hasArabicScript(words[0])) {
      const skeleton = romanize(words[0]);
      if (skeleton) serve(skeleton, words[0]);
    }
  }

  // A MULTI-WORD synonym has to be tried before the words are split up:
  // «بامبو لاب» and «قطع غيار» mean one thing each, and neither half means it.
  for (const [term, canonical] of synonyms) {
    if (term.includes(' ') && normalized.includes(term)) serve(canonical, term);
  }

  for (const token of literal) {
    const canonical = synonyms.get(token);
    if (canonical) for (const t of tokenize(canonical)) serve(t, token);
    // The skeleton is the bridge from ARABIC letters to a Latin name, and only
    // that — see `buildIndexRows` for what a Latin word's skeleton did instead.
    // Looked up twice: bare, against Arabic names' skeletons and within a typo
    // of a Latin word («بامبو» `bamba` → "bambu"), and marked, against Latin
    // words' own skeletons («اليجو» `alaga` → `~alaga` → "Elegoo").
    if (hasArabicScript(token)) {
      const skeleton = romanize(token);
      if (skeleton && isUsefulToken(skeleton)) {
        serve(skeleton, token);
        serve(SKELETON_MARK + skeleton, token);
      }
    }
  }

  // «اكس تو دي» → "x2d": Latin letters read aloud in Arabic, which no
  // romanisation can recover. Only attempted on an Arabic-script query.
  if (hasArabicScript(normalized)) {
    for (const collapsed of collapseSpelledLetters(literal)) {
      if (isUsefulToken(collapsed)) serve(collapsed, collapsed);
      const viaSynonym = synonyms.get(collapsed);
      if (viaSynonym) serve(viaSynonym, collapsed);
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
      if (letter) serve(letter, token);
    }
  }

  /**
   * THE WORD STILL BEING TYPED. «هنالك منتجات تبدأ بحرف H» — and "Hard",
   * "Hot" and "Heat" are the same complaint one keystroke later: each is an
   * exact word SOMEWHERE in the shop (a description that says "hard", "hot",
   * "heat"), and an exact hit used to end the search, so the Hardened nozzle,
   * the Hotend and the Heatbed were never looked at. The last word is marked
   * here so `bestMatches` keeps the exact hit AND its completions for it. The
   * words before it were finished — a space followed them — and keep the
   * exact-hit rule, which is what stops "pla basic" from wandering into
   * "plate".
   */
  const completing = new Set<string>();
  if (opts.completeLast !== false && !/\s$/u.test(raw)) {
    const last = words[words.length - 1];
    for (const token of tokenize(last)) {
      completing.add(token);
      if (hasArabicScript(token)) {
        const skeleton = romanize(token);
        if (skeleton && isUsefulToken(skeleton)) {
          completing.add(skeleton);
          completing.add(SKELETON_MARK + skeleton);
        }
      }
    }
  }

  return { literal, lookup: [...lookup], origin, completing };
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
 * one read. Each typed word contributes the BEST match the product has for it
 * (field weight × match quality), and then:
 *
 *   COVERAGE IS A MULTIPLIER, NOT A BONUS. A product matching two of the
 *   query's two words beats one matching one of them however heavily
 *   weighted — otherwise "bambu x2d" ranks every Bambu product above the X2D.
 *   That is the single most important line in this function.
 *
 * THE BEST MATCH PER WORD, NOT THE SUM. This summed every row a word reached,
 * so a product was rewarded for how many ways it could be reached rather than
 * how well: "plate" and its skeleton `plata` were both prefixes of "pl" and
 * together outscored "pla" itself, which put a PEI plate above every PLA
 * filament for «PL»; and a letter reaching "Hotend" and "Holder" in one name
 * counted twice. One word typed, one contribution.
 */
export function scoreProducts(
  expanded: ExpandedQuery,
  matchedTokens: ReadonlyMap<string, { score: number; from: string }>,
  rows: readonly IndexRow[]
): ScoredProduct[] {
  const byProduct = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const match = matchedTokens.get(row.token);
    if (!match) continue;
    const value = row.weight * match.score;
    if (!(value > 0)) continue;
    let perWord = byProduct.get(row.product_id);
    if (!perWord) {
      perWord = new Map();
      byProduct.set(row.product_id, perWord);
    }
    if (value > (perWord.get(match.from) ?? 0)) perWord.set(match.from, value);
  }

  const wanted = Math.max(1, expanded.literal.length);
  const out: ScoredProduct[] = [];
  for (const [product_id, perWord] of byProduct) {
    let score = 0;
    for (const v of perWord.values()) score += v;
    const coverage = Math.min(1, perWord.size / wanted);
    out.push({ product_id, score: score * (0.25 + 0.75 * coverage) * (coverage === 1 ? 1.6 : 1) });
  }
  out.sort((a, b) => b.score - a.score || a.product_id.localeCompare(b.product_id));
  return out;
}

/**
 * How many vocabulary tokens a ONE-CHARACTER term may resolve to when the
 * caller could not say how heavily each one is weighted (a unit test handing
 * `resolveTokens` a bare word list). With weights, see `LETTER_MIN_WEIGHT`.
 */
const ONE_CHAR_MATCHES = 40;

/**
 * WHICH WORDS A SINGLE LETTER MEANS: the ones the catalogue says out loud.
 *
 * «H» returned 115 products on a realistic catalogue and not one of the four
 * named Hardened, Heatbed, Hotend and Holder. The letter used to keep the
 * forty SHORTEST h-words, whatever field they came from, and a shop's
 * descriptions are full of short h-words — "how", "has", "hot", "hub" — so the
 * forty slots went to prose and the product names never made the cut. The
 * candidate read already arrives weight-first; this used to throw that order
 * away.
 *
 * So a letter matches the words that NAME things — a product name (10), a
 * brand (8), a model or colour (6), a hashtag (5) — and every one of them, not
 * the first forty: a letter names a shelf. Section names and descriptions are
 * words ABOUT a product, and a letter is too little to go on to reach one.
 * Only when no naming word starts with the letter at all do the rest get a
 * look, so a letter that exists only in prose still answers something.
 *
 * `LETTER_MAX` is a sanity bound, not a ranking decision: the candidate read
 * is capped at 2000 rows and the postings read at 4000.
 */
export const LETTER_MIN_WEIGHT = FIELD_WEIGHT.hashtag;
const LETTER_MAX = 400;

/**
 * Resolve each query token to the vocabulary tokens it should match.
 *
 * `vocabulary` is the bounded candidate set the prefix lookup returned, NOT
 * the whole index — that is what keeps the fuzzy pass affordable. `weights` is
 * the heaviest field weight each of those tokens carries anywhere in the
 * index, which the prefix read returns for free; it decides which completions
 * are worth keeping, so a word the shop NAMES outranks one it merely mentions.
 *
 * The result maps an index token to how good a match it is and WHICH typed
 * word it serves, because coverage counts distinct typed words, not hits.
 */
export function resolveTokens(
  expanded: ExpandedQuery,
  vocabulary: readonly string[],
  weights?: ReadonlyMap<string, number>
): Map<string, { score: number; from: string }> {
  const out = new Map<string, { score: number; from: string }>();
  for (const queryToken of expanded.lookup) {
    const from = expanded.origin.get(queryToken) ?? queryToken;
    const matches =
      [...queryToken].length === 1
        ? letterMatches(queryToken, vocabulary, weights)
        : bestMatches(queryToken, vocabulary, undefined, {
            complete: expanded.completing.has(queryToken),
            weights,
          });
    for (const match of matches) {
      const have = out.get(match.token);
      if (!have || match.score > have.score) out.set(match.token, { score: match.score, from });
    }
  }
  return out;
}

/** A one-character term as a prefix over the candidate vocabulary. */
function letterMatches(letter: string, vocabulary: readonly string[], weights?: ReadonlyMap<string, number>): TokenMatch[] {
  const ranked = (tokens: readonly string[]) =>
    tokens
      .map((token) => ({ token, score: prefixScore(letter, token) }))
      .sort(
        (a, b) =>
          (weights?.get(b.token) ?? 1) * b.score - (weights?.get(a.token) ?? 1) * a.score ||
          a.token.localeCompare(b.token)
      );
  const prefixed = vocabulary.filter((t) => t !== letter && t.startsWith(letter));
  if (!weights) return ranked(prefixed).slice(0, ONE_CHAR_MATCHES);
  const naming = prefixed.filter((t) => (weights.get(t) ?? 0) >= LETTER_MIN_WEIGHT);
  return naming.length > 0 ? ranked(naming).slice(0, LETTER_MAX) : ranked(prefixed).slice(0, ONE_CHAR_MATCHES);
}
