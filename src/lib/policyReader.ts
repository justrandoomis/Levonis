/**
 * THE READER'S HALF OF THE POLICY LIBRARY: addressing, outlining and search.
 *
 * Everything here is pure and free of React so that the three questions the
 * page cannot get wrong are answerable in a unit test:
 *
 *  1. WHICH TEXT IS THIS. A policy is quoted in arguments months after it is
 *     read, so a deep link must never quietly resolve to a different version
 *     than the one it names — see `parsePolicyVersion`.
 *  2. WHERE IS ARTICLE 4.2. «انظر المادة ٤٫٢» is useless if nobody can send
 *     it, so every article carries an anchor derived from its NUMBER rather
 *     than from its words — see `policyAnchor`.
 *  3. WHERE IS THE CLAUSE ABOUT THE CARTON. A corpus of eighteen documents and
 *     four thousand articles is only a library if it is searchable in the
 *     language it is written in — see `searchPolicyIndex`.
 *
 * THE FOLD TABLE IS NOT REWRITTEN HERE. Arabic orthography varies freely (أ إ آ
 * ا, ة/ه, ى/ي) and Sorani writes ک ی ە where Arabic writes ك ي ه; the shop
 * already decided exactly which of those to fold together, and which to leave
 * alone, in worker/lib/search/normalize.ts. A second copy of that table in the
 * front end would drift from it, and then the same word would find a product
 * and not find the clause that governs it. The same argument applies to typo
 * tolerance, so worker/lib/search/match.ts is imported rather than reinvented.
 * Both modules are pure string functions with no imports of their own, so this
 * pulls no worker runtime into the bundle — the precedent is
 * src/components/profile/qr.ts, which re-exports worker/lib/qr.ts for the same
 * reason.
 */

import { normalizeText } from '../../worker/lib/search/normalize';
import { boundedDistance, candidatePrefix, editBudget } from '../../worker/lib/search/match';

// ------------------------------------------------------------- addressing

/** A historical deep link must never silently fall back to today's policy. */
export function parsePolicyVersion(raw: string | null): { valid: boolean; version: number | null } {
  if (raw === null) return { valid: true, version: null };
  if (!/^\d+$/.test(raw)) return { valid: false, version: null };
  const version = Number(raw);
  return Number.isSafeInteger(version) && version >= 1 && version <= 1_000_000
    ? { valid: true, version }
    : { valid: false, version: null };
}

export function policyDocumentUrl(key: string, version: number | null, lang: string): string {
  const locale = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return `/api/policies/${encodeURIComponent(key)}?lang=${locale}${version === null ? '' : `&version=${version}`}`;
}

/**
 * The address of one article, as it is pasted into a chat.
 *
 * The anchor is NOT in the query string: a fragment is the one part of a URL
 * the browser restores on its own after a reload and the one part that never
 * reaches the server, which is what makes it the right place for a position
 * inside a document that is already being served whole.
 */
export function policyArticleHref(key: string, anchor: string, version?: number | null): string {
  const query = version ? `?version=${version}` : '';
  return `/policies/${encodeURIComponent(key)}${query}#${anchor}`;
}

/**
 * The stable id of a heading.
 *
 * DERIVED FROM THE NUMBER, NEVER FROM THE WORDS. The registry guarantees that
 * article 4.2 is 4.2 in Arabic, English and Sorani alike — a customer may
 * accept the terms in one language and argue about them in another — so an
 * anchor built from the number survives a language switch, and a link sent by
 * an Arabic-speaking customer opens the right clause for an English-speaking
 * courier. An anchor slugified from the heading TEXT would be a different
 * string in each language and would break on the first wording correction.
 *
 * The `line` fallback exists only for a heading with no number at all. It is
 * position-dependent and therefore not stable across an edit, which is why it
 * is a fallback and not the rule; every heading in the current corpus is
 * numbered, and a new unnumbered one is a drafting mistake this makes visible
 * rather than silently papers over.
 */
export function policyAnchor(level: 2 | 3, number: string | null, line: number): string {
  if (number) return `${level === 2 ? 'part' : 'art'}-${number.replace(/\./g, '-')}`;
  return `h-${line}`;
}

// --------------------------------------------------------------- outlining

export interface PolicyHeading {
  /** 2 = a numbered part (or the document's own title line), 3 = an article. */
  level: 2 | 3;
  /** "4.2", "1", or null for the unnumbered title line of a short document. */
  number: string | null;
  /** The heading without its number, which is rendered separately. */
  title: string;
  anchor: string;
  /** Index into the body's lines — how the renderer and the outline agree. */
  line: number;
}

const HEADING = /^(#{2,3})\s+(.*\S)\s*$/;
/** A leading "4.2 " or "1. " is the article number, not part of the title. */
const LEADING_NUMBER = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;

/**
 * One line of a policy body, classified.
 *
 * THE TABLE OF CONTENTS AND THE DOCUMENT MUST AGREE, or the outline links to
 * an anchor the prose never rendered and every entry is a dead link. They
 * agree because they are the same parse: the renderer does not re-implement
 * these two regexes, it calls this. The corpus contains nothing else —
 * `##` parts, `### 4.2` articles, `- ` bullets and paragraphs — so nothing
 * else is recognised, and a construct nobody writes cannot be mis-rendered.
 */
export type PolicyLine =
  | { kind: 'blank' }
  | { kind: 'heading'; level: 2 | 3; number: string | null; title: string; anchor: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'paragraph'; text: string };

export function parsePolicyLine(raw: string, line: number): PolicyLine {
  const text = raw.trim();
  if (!text) return { kind: 'blank' };
  const heading = HEADING.exec(text);
  if (heading) {
    const level: 2 | 3 = heading[1].length === 2 ? 2 : 3;
    const numbered = LEADING_NUMBER.exec(heading[2]);
    const number = numbered ? numbered[1] : null;
    const title = numbered ? numbered[2] : heading[2];
    return { kind: 'heading', level, number, title, anchor: policyAnchor(level, number, line) };
  }
  if (text.startsWith('- ')) return { kind: 'bullet', text: text.slice(2) };
  return { kind: 'paragraph', text };
}

/**
 * Every heading in a policy body, in reading order.
 *
 * The corpus uses two shapes and both are handled here without a flag: the
 * long documents open with a numbered part («## 1. التمهيد والتعريفات») and
 * hang articles under it, while the five that state a single owner clause open
 * with an unnumbered title line («## وثيقة الاسترجاع — المادة 4») and go
 * straight to articles. A parser that assumed either shape would produce an
 * empty table of contents for a third of the library.
 */
export function policyOutline(body: string): PolicyHeading[] {
  const out: PolicyHeading[] = [];
  const lines = body.split('\n');
  for (let line = 0; line < lines.length; line++) {
    const parsed = parsePolicyLine(lines[line], line);
    if (parsed.kind !== 'heading') continue;
    const { level, number, title, anchor } = parsed;
    out.push({ level, number, title, anchor, line });
  }
  return out;
}

// ------------------------------------------------------------------ search

/**
 * One searchable article: the unit a result links to.
 *
 * The index is built ONCE per document, when that document is first fetched,
 * and reused for every keystroke. Folding two thousand articles on each
 * keypress is the difference between a search that answers as you type and one
 * that stutters on the phone the owner actually uses.
 */
export interface PolicyArticle {
  key: string;
  /** The document's own title, for the result row. */
  docTitle: string;
  /** The numbered part this article sits under, when the document has parts. */
  part: string | null;
  number: string | null;
  heading: string;
  anchor: string;
  /** Body lines, kept raw so a snippet can be quoted as written. */
  lines: string[];
  /** Folded tokens of the heading alone — a title hit outranks a body hit. */
  headingTokens: Set<string>;
  /** Every folded token in the article, for the AND test. */
  tokens: Set<string>;
  /** The same tokens as a list, for the bounded fuzzy scan. */
  tokenList: string[];
  /** The heading's tokens as a list, so the scan does not rebuild it per token. */
  headingList: string[];
}

/** Letter/digit runs, which is what both the fold and the highlighter work on. */
const WORD_RUN = /[\p{L}\p{N}]+/gu;

/** Folded tokens of one line, using the shop's fold table and nothing else. */
function foldTokens(text: string, into: Set<string>): void {
  for (const run of text.match(WORD_RUN) ?? []) {
    const folded = normalizeText(run);
    if (folded.length >= 2) into.add(folded);
  }
}

/**
 * Split a document into articles for the index.
 *
 * Lines before the first article belong to the document's preamble, which is
 * indexed as an article of its own: the sentence that says the Arabic text
 * governs lives there, and a reader searching for it should find it.
 */
export function indexPolicyDocument(key: string, docTitle: string, body: string): PolicyArticle[] {
  const lines = body.split('\n');
  const out: PolicyArticle[] = [];
  let part: string | null = null;
  let current: PolicyArticle | null = null;

  const open = (heading: PolicyHeading | null, line: number): PolicyArticle => {
    const article: PolicyArticle = {
      key,
      docTitle,
      part,
      number: heading?.number ?? null,
      heading: heading ? heading.title : docTitle,
      anchor: heading ? heading.anchor : policyAnchor(3, null, line),
      lines: [],
      headingTokens: new Set<string>(),
      tokens: new Set<string>(),
      tokenList: [],
      headingList: [],
    };
    const headingText = heading ? `${heading.number ?? ''} ${heading.title}` : docTitle;
    foldTokens(headingText, article.headingTokens);
    for (const token of article.headingTokens) article.tokens.add(token);
    out.push(article);
    return article;
  };

  for (let line = 0; line < lines.length; line++) {
    const parsed = parsePolicyLine(lines[line], line);
    if (parsed.kind === 'blank') continue;
    if (parsed.kind === 'heading') {
      const { level, number, title, anchor } = parsed;
      if (level === 2) {
        // A part heading re-labels what follows; it does not itself hold text.
        part = number ? `${number}. ${title}` : title;
        current = null;
        continue;
      }
      current = open({ level, number, title, anchor, line }, line);
      continue;
    }
    // A bullet is searched as its text; the marker is presentation.
    const text = parsed.text;
    if (!current) current = open(null, line);
    current.lines.push(text);
    foldTokens(text, current.tokens);
  }

  for (const article of out) {
    article.tokenList = [...article.tokens];
    article.headingList = [...article.headingTokens];
  }
  return out;
}

/**
 * «المادة ٤٫٢» typed as a number, in either set of digits.
 *
 * Iraqi keyboards produce Arabic-Indic digits and the Arabic decimal separator
 * ٫ (U+066B), while the corpus numbers its articles in Latin digits. Somebody
 * quoting a clause back at the store types what their keyboard gives them, and
 * this is the one query where an exact answer exists and guessing is wrong.
 */
export function parseArticleRef(query: string): string | null {
  const latin = query
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫،]/g, '.')
    .trim();
  const bare = latin.replace(/^(?:م|المادة|article|art\.?|بڕگە)\s*/iu, '').trim();
  return /^\d+(?:\.\d+)+$/.test(bare) ? bare : null;
}

/** The folded tokens of what somebody typed, long enough to rank anything. */
export function policyQueryTokens(query: string): string[] {
  const out: string[] = [];
  for (const run of query.match(WORD_RUN) ?? []) {
    const folded = normalizeText(run);
    if (folded.length >= 2 && !out.includes(folded)) out.push(folded);
  }
  return out;
}

export interface PolicySearchHit {
  key: string;
  docTitle: string;
  part: string | null;
  number: string | null;
  heading: string;
  anchor: string;
  snippet: string;
  score: number;
}

/** An exact hit wins outright; a prefix is somebody still typing; then typos. */
const EXACT = 1;
const PREFIX = 0.62;
const FUZZY = 0.38;
/**
 * A word in the article's own HEADING says what the article is about, so it
 * outranks the same word buried in the body.
 *
 * 1.6 is not a taste: it is the largest multiplier that keeps the match
 * CLASSES in order. At 2.4 a fuzzy hit in a heading scored 0.912 against an
 * exact hit in a body at 1.0 and then beat it once the two were added
 * together, which is how a search for «الكرتون» put the article titled
 * «الكوبون» above the article that contains the actual word. Here the best of
 * the two placements is taken rather than their sum, and an exact body hit
 * (1.0) stays above a prefix or fuzzy heading hit (0.99, 0.61) while an exact
 * heading hit (1.6) stays above everything.
 */
const HEADING_WEIGHT = 1.6;

/**
 * How wrong a token is allowed to be.
 *
 * THE ARABIC DEFINITE ARTICLE IS NOT EVIDENCE. `editBudget` is length-based,
 * and «ال» adds two characters to a word without adding anything that
 * distinguishes it — so «الكرتون» came out at seven characters and earned two
 * edits, which is exactly enough to reach «الكوبون», a different word. Measure
 * the budget on the STEM and «كرتون» earns one edit, which still reaches
 * «الكارتون» — the reader's own spelling — and no longer reaches the coupon.
 * The distance itself is still measured on the whole token.
 */
function foldedEditBudget(token: string): number {
  const stem = token.startsWith('ال') && token.length >= 5 ? token.slice(2) : token;
  return editBudget(stem);
}

/** The best score one query token achieves against one set of folded tokens. */
function scoreToken(token: string, tokens: Set<string>, tokenList: readonly string[]): number {
  if (tokens.has(token)) return EXACT;
  for (const candidate of tokenList) if (candidate.startsWith(token)) return PREFIX;
  // Bounded, and only against tokens that share the query's opening letters —
  // the same narrowing the catalogue search uses, so the cost stays linear in
  // the handful of near-neighbours rather than in the whole article.
  const budget = foldedEditBudget(token);
  if (budget > 0) {
    const prefix = candidatePrefix(token);
    for (const candidate of tokenList) {
      if (!candidate.startsWith(prefix)) continue;
      if (boundedDistance(token, candidate, budget) <= budget) return FUZZY;
    }
  }
  return 0;
}

/** What one query token is worth in one article, counting its best placement. */
function articleTokenScore(token: string, article: PolicyArticle): number {
  const body = scoreToken(token, article.tokens, article.tokenList);
  if (body === 0) return 0;
  const heading = scoreToken(token, article.headingTokens, article.headingList);
  return Math.max(body, heading * HEADING_WEIGHT);
}

/** The line that best answers the query, quoted as it is written. */
function snippetFor(article: PolicyArticle, tokens: string[]): string {
  let best = '';
  let bestHits = 0;
  for (const line of article.lines) {
    const folded = new Set<string>();
    foldTokens(line, folded);
    const list = [...folded];
    let hits = 0;
    for (const token of tokens) if (scoreToken(token, folded, list) > 0) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = line;
    }
    if (bestHits === tokens.length) break;
  }
  return best || article.lines[0] || article.heading;
}

/**
 * Rank articles against what somebody typed.
 *
 * EVERY query token must appear somewhere in the article. Two words are a
 * narrowing, not a wish: a reader who types «ضمان الطابعة» is asking for the
 * articles about both, and an OR would bury them under every article that
 * merely says «ضمان». The exception is an article reference, which is an exact
 * address and returns exactly the article it names.
 */
export function searchPolicyIndex(
  articles: readonly PolicyArticle[],
  query: string,
  limit = 40
): PolicySearchHit[] {
  const ref = parseArticleRef(query);
  if (ref) {
    return articles
      .filter((a) => a.number === ref)
      .map((a) => ({ ...a, snippet: a.lines[0] ?? '', score: EXACT * HEADING_WEIGHT }))
      .slice(0, limit);
  }

  const tokens = policyQueryTokens(query);
  if (tokens.length === 0) return [];

  const hits: PolicySearchHit[] = [];
  for (const article of articles) {
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const value = articleTokenScore(token, article);
      if (value === 0) {
        matchedAll = false;
        break;
      }
      score += value;
    }
    if (!matchedAll) continue;
    hits.push({
      key: article.key,
      docTitle: article.docTitle,
      part: article.part,
      number: article.number,
      heading: article.heading,
      anchor: article.anchor,
      snippet: snippetFor(article, tokens),
      score,
    });
  }

  // Ties break on the article number so a document's clauses stay in order
  // rather than shuffling between keystrokes.
  hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key) || (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }));
  return hits.slice(0, limit);
}

/**
 * Split text so the matched words can be marked without touching the rest.
 *
 * Highlighting by character offset would need a map from the folded string
 * back to the original, and the fold is not length-preserving — NFD expands
 * accented Latin, diacritics and tatweel are dropped, punctuation runs
 * collapse. Marking whole words instead is exact, needs no such map, and is
 * the right granularity for prose anyway.
 */
export function policyHighlight(text: string, tokens: readonly string[]): Array<{ text: string; hit: boolean }> {
  if (tokens.length === 0) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  WORD_RUN.lastIndex = 0;
  for (let m = WORD_RUN.exec(text); m; m = WORD_RUN.exec(text)) {
    const folded = normalizeText(m[0]);
    const single = new Set([folded]);
    const isHit = folded.length >= 2 && tokens.some((t) => scoreToken(t, single, [folded]) > 0);
    if (!isHit) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

/**
 * The one line that says what a document governs, taken FROM THE DOCUMENT.
 *
 * Every document in the registry opens with a sentence naming its own scope —
 * «هذه الوثيقة تبيّن متى يُقبل إرجاع منتج اشتُري من ليفونيس…» — so the library
 * index quotes that instead of a description written for the card. A hand
 * written summary is a second, unversioned statement about what a policy says,
 * and the first time the policy is corrected and the card is not, the index is
 * lying about the document it links to.
 *
 * Only the FIRST sentence: the preamble's remaining sentences are usually the
 * standing note that the Arabic text governs, which the page states once for
 * the whole library rather than eighteen times.
 */
export function policySummary(body: string): string {
  const paragraph = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('- '));
  if (!paragraph) return '';
  // A full stop between digits is an article reference («المادة 4.2»), not the
  // end of a sentence — splitting there would cut the summary mid-citation.
  const end = /\.(?!\d)/.exec(paragraph);
  return end ? paragraph.slice(0, end.index + 1) : paragraph;
}
