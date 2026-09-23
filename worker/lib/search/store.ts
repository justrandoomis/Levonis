/**
 * THE SEARCH INDEX AGAINST A REAL DATABASE — writing it, and reading it.
 *
 * The pure parts live beside this file: `./normalize.ts` folds a query into a
 * comparable form, `./translit.ts` gets «بامبو» and "bambu" into one space,
 * `./vocabulary.ts` knows that «طابعة» means "printer", `./match.ts` forgives a
 * typo, and `./index.ts` scores. This is the only part that touches D1, which
 * is why it is the only part with a cost worth arguing about.
 *
 * THE COST, AND WHERE IT IS CONTROLLED. A search is TWO reads, whatever the
 * query:
 *
 *   1. The candidate vocabulary — every indexed token whose first two
 *      characters match one of the query's. An index range scan per prefix,
 *      returning tens of tokens rather than the whole vocabulary. This is the
 *      read that makes typo tolerance affordable: the fuzzy pass runs over
 *      what comes back, in the Worker, not over the catalogue.
 *   2. The postings for the tokens that actually matched.
 *
 * Neither grows with the catalogue the way a `LIKE '%…%'` scan does.
 *
 * WHAT IS INDEXED. Everything a shopper might type at a product: its name in
 * three languages, its brand, the sections it is filed under, its hashtags —
 * which this shop's products carry richly (#x2d, #bambu-lab, #dual-nozzle,
 * #ams-2-pro, #fdm) and which are therefore among the best signals available —
 * its option and model names, and last and least its description.
 */

import { normalizeText } from './normalize';
import { toSearchDoc, variantNamesFrom } from './document';
import {
  buildIndexRows,
  candidatePrefixes,
  expandQuery,
  resolveTokens,
  scoreProducts,
  SKELETON_MARK,
  type IndexRow,
  type SearchDoc,
  type ScoredProduct,
} from './index';

/** Enough prefixes to serve a long query, few enough to stay two reads. */
const MAX_PREFIXES = 12;
/** Vocabulary rows one search may consider. Far above any real query's need. */
const MAX_VOCABULARY = 2000;
/** Postings one search may score. */
const MAX_POSTINGS = 4000;

/**
 * THE STAMP THAT MAKES A THIN INDEX REPAIRABLE.
 *
 * WHAT WENT WRONG WITHOUT IT. The cron backfill used to compose its own
 * document, and the copy it composed had no `variantNames` — so every product
 * the CRON indexed carried no option or colour names, and «كومبو» (an OPTION
 * name in this catalogue, never part of a product name) found only the
 * products the owner had happened to re-save by hand. Making both writers use
 * one builder fixes the NEXT product indexed. It repairs nothing already in
 * the table: the backfill's own predicate is "has no rows at all", and a
 * thinly-indexed product has rows. On a live shop that is every active
 * product, for ever, with no command the owner could run short of re-saving
 * the catalogue by hand in the admin form.
 *
 * SO THE INDEX CARRIES ITS OWN VERSION, one row per product, weight 0. The
 * backfill takes the products that do not carry the CURRENT stamp, which is
 * "never indexed" and "indexed by an older builder" in one predicate, and it
 * rewrites them fifty per cron run until the whole catalogue matches. Bump
 * `INDEX_STAMP` whenever the document builder starts reading a field it did
 * not read before, and the shop repairs itself over the next few hours of
 * cron without a migration, a deploy step or an admin button.
 *
 * NOT A NEW TABLE, DELIBERATELY. This shop has a deploy path that ships a
 * Worker WITHOUT applying migrations (the Cloudflare Git integration on the
 * default branch) — `searchIndexInstalled` above exists for exactly that
 * window. A repair that needed a new table would sit switched off on the one
 * database that needs it most, and nobody would know. A row in a table that
 * is already there works the moment the code lands.
 *
 * IT CAN NEVER BE SEARCHED FOR. `normalizeText` reduces everything that is
 * not `\p{L}` or `\p{N}` to a space (worker/lib/search/normalize.ts), so no
 * query token can begin with '#' and no prefix range scan
 * (`token >= p AND token < p+1`, built from those tokens) can reach it: '#'
 * sorts below every digit and letter a range could start from.
 * Weight 0 means it would score nothing even if one did. `DELETE FROM
 * search_tokens WHERE product_id = ?` above takes it with the rest of the
 * product's rows, so it is never stale.
 */
export const INDEX_STAMP = '#doc:4';

/*
 * THE STAMP'S HISTORY, because each bump rewrote the whole catalogue and the
 * reason is worth keeping:
 *
 *   doc:2  (U+0000-prefixed) — the document started carrying option and
 *          colour names (the «كومبو» repair above).
 *   #doc:3 — Latin words stopped being stored with a romanised skeleton beside
 *          them (./index.ts `buildIndexRows`: "hot" and "heat" were both `hat`).
 *          The prefix also changed from U+0000 to '#'. A NUL inside a bound
 *          string is handled by SQLite's length-aware binding and never ran
 *          against real D1 in a test; if anything on that path truncated at
 *          NUL, every product would look permanently stale and be rewritten on
 *          every cron run for ever. '#' is just as unreachable — it sorts below
 *          every letter and digit, so no prefix range built from a query can
 *          start at it — and it is an ordinary character everywhere. The old
 *          stamp rows go with the rest of each product's rows the first time
 *          the backfill rewrites it.
 *   #doc:4 — a Latin word's skeleton is back, under SKELETON_MARK (`~alaga`
 *          for "elegoo"), where only an Arabic-letter query looks: without it
 *          «اليجو», «سونلو» and every brand outside the synonym dictionary
 *          stopped reaching their Latin names.
 */

/**
 * THE MARK OF A PRODUCT THE BACKFILL COULD NOT INDEX, so the next run moves
 * past it instead of retrying it first, for ever, ahead of everything else.
 *
 * The backfill takes the stale products `ORDER BY id`. If one of them cannot
 * be written — a statement D1 refuses, a batch over some limit — it is the
 * FIRST row of the next run's selection too, and of the one after that: one
 * bad product would have kept every product after it unindexed for good. A
 * product carrying this mark (for the current `INDEX_STAMP` version) is left
 * out of the selection; its OLD rows, if it had any, stay in place and keep it
 * findable; the failure is reported on the cron report; and the next save of
 * that product — `planSearchIndex` deletes every row it owns — clears the mark.
 * Bumping `INDEX_STAMP` retries every marked product, because the mark names
 * the version it failed on.
 */
export const INDEX_FAILED_MARK = `#fail:${INDEX_STAMP.slice('#doc:'.length)}`;

/**
 * The `WHERE` fragment that selects products whose index is missing OR was
 * written by an older builder. One bound parameter: `INDEX_STAMP`.
 *
 * Named here rather than written out at the call site so the predicate and the
 * stamp can never describe different versions — the same reason
 * `SEARCH_DOC_COLUMNS` exists.
 */
export const SEARCH_INDEX_STALE_SQL =
  'NOT EXISTS (SELECT 1 FROM search_tokens t WHERE t.product_id = p.id AND t.token = ?)';

/** Same shape, for `INDEX_FAILED_MARK`: a product the backfill gave up on. */
const SEARCH_INDEX_FAILED_SQL =
  'NOT EXISTS (SELECT 1 FROM search_tokens f WHERE f.product_id = p.id AND f.token = ?)';

/**
 * Replace a product's index rows with exactly these.
 *
 * Returns STATEMENTS rather than running them, so the caller can put them in
 * the same batch as the product write. A search index updated in a second
 * transaction is an index that disagrees with the catalogue whenever the
 * second one fails.
 */
export function planSearchIndex(db: D1Database, doc: SearchDoc): D1PreparedStatement[] {
  const rows = buildIndexRows(doc);
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM search_tokens WHERE product_id = ?').bind(doc.productId),
  ];
  // One statement per row rather than a giant multi-VALUES insert: D1 batches
  // are cheap and a 900-parameter statement is where the binding limit bites.
  for (const row of rows) {
    stmts.push(
      db
        .prepare('INSERT OR REPLACE INTO search_tokens (product_id, token, weight) VALUES (?, ?, ?)')
        .bind(row.product_id, row.token, row.weight)
    );
  }
  // And the stamp that says WHICH BUILDER wrote these rows. See INDEX_STAMP.
  stmts.push(
    db
      .prepare('INSERT OR REPLACE INTO search_tokens (product_id, token, weight) VALUES (?, ?, 0)')
      .bind(doc.productId, INDEX_STAMP)
  );
  return stmts;
}

/**
 * THE COLUMNS A SEARCH DOCUMENT IS BUILT FROM — one list, named once.
 *
 * Every field `toSearchDoc` reads has to be in the SELECT that feeds it, and
 * a caller that forgets one does not fail: it quietly writes a thinner index
 * than the save path does, and the products it touched become unfindable by
 * whatever that column held. That is not hypothetical — the cron backfill
 * omitted `options`/`colors` and so indexed no option names at all, while the
 * save path indexed them, which meant «كومبو» found only the products the
 * owner happened to have re-saved. A shared list is what makes the two
 * writers the same writer.
 */
export const SEARCH_DOC_COLUMNS = [
  'id',
  'name',
  'name_ar',
  'name_ku',
  'description',
  'hashtags',
  'sku',
  'brand_id',
  'category_id',
  'sub_category_id',
  'options',
  'colors',
] as const;

/** `SEARCH_DOC_COLUMNS` as a SELECT list, optionally under a table alias. */
export function searchDocColumns(alias = ''): string {
  return SEARCH_DOC_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');
}

/**
 * D1 REFUSES A QUERY WITH MORE THAN 100 BOUND PARAMETERS, so every `IN (…)`
 * list in this codebase is cut at 90 — worker/lib/financeReport.ts §7 writes
 * the rule down and worker/lib/stockAlertResolve.ts, productPersistence.ts and
 * stockAlerts.ts all honour it. Named here because the name lookup below is on
 * the hashtag-rename path, where the chunk is fifty PRODUCTS and the ids read
 * off them are three per product.
 */
const NAME_IN_CHUNK = 90;

const inChunks = <T,>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += NAME_IN_CHUNK) out.push(xs.slice(i, i + NAME_IN_CHUNK));
  return out;
};

/**
 * `products` rows -> the documents to index them under.
 *
 * NOT A READ PER PRODUCT. The index holds NAMES, not ids — a shopper types
 * «الطابعات» and "Bambu Lab", never `cat_printers` — so the brand and the two
 * section names have to be resolved before the document is built. Doing that
 * per product would be fifty reads for a fifty-product chunk; one `IN` over
 * the distinct ids collects all of them at once.
 *
 * TWO STATEMENTS RATHER THAN ONE `UNION`, AND EACH ONE CHUNKED. This was a
 * single `SELECT … FROM brands WHERE id IN (…) UNION ALL SELECT … FROM
 * catalogs WHERE id IN (…)` binding the SAME id list twice — so a fifty-
 * product chunk with a brand and two sections each bound up to three hundred
 * parameters against a hard limit of a hundred. Every call site is a chunk of
 * fifty (the cron backfill and, since the tag rewrite started reindexing,
 * `rewriteHashtag`), and the tests cannot see it because node:sqlite allows
 * 32766 bound parameters while D1 refuses at 100. On a real catalogue the
 * rename threw halfway through, after the earlier chunks had already
 * committed their `UPDATE` — the half-applied rename the same-batch design
 * exists to prevent.
 *
 * Brand ids and catalog ids are therefore asked for SEPARATELY, each binding
 * its own list exactly once and in slices of `NAME_IN_CHUNK`. A fifty-product
 * chunk costs at most three reads instead of one, and it is three reads that
 * cannot be refused.
 *
 * The rows must come from `searchDocColumns()`. Pass them with a field
 * already overwritten when the batch is about to change it (a hashtag rename
 * does exactly that), so the index describes the row that is landing rather
 * than the one being replaced.
 */
export async function searchDocsForRows(
  db: D1Database,
  rows: Record<string, unknown>[]
): Promise<SearchDoc[]> {
  if (rows.length === 0) return [];
  const idsOf = (pick: (r: Record<string, unknown>) => unknown[]): string[] => [
    ...new Set(rows.flatMap(pick).filter((x): x is string => typeof x === 'string' && x !== '')),
  ];
  const names = new Map<string, string>();
  const collect = async (table: 'brands' | 'catalogs', ids: string[]): Promise<void> => {
    for (const part of inChunks(ids)) {
      const ph = part.map(() => '?').join(',');
      const { results } = await db
        .prepare(`SELECT id, COALESCE(NULLIF(name_en,''), name_ar) AS n FROM ${table} WHERE id IN (${ph})`)
        .bind(...part)
        .all<{ id: string; n: string }>();
      for (const r of results ?? []) names.set(String(r.id), String(r.n ?? ''));
    }
  };
  await collect('brands', idsOf((r) => [r.brand_id]));
  await collect('catalogs', idsOf((r) => [r.category_id, r.sub_category_id]));
  return rows.map((r) =>
    toSearchDoc({
      id: String(r.id),
      name: r.name,
      name_ar: r.name_ar,
      name_ku: r.name_ku,
      description: r.description,
      hashtags: r.hashtags,
      sku: r.sku,
      brandName: names.get(String(r.brand_id ?? '')) ?? null,
      categoryNames: [names.get(String(r.category_id ?? '')) ?? '', names.get(String(r.sub_category_id ?? '')) ?? ''].filter(
        Boolean
      ),
      variantNames: variantNamesFrom(r.options, r.colors),
    })
  );
}

/**
 * Is the index installed at all?
 *
 * Migration 0089 creates the two tables, and this shop has a deploy path that
 * ships a Worker WITHOUT applying migrations (the Cloudflare Git integration
 * on the default branch). So a Worker that knows about the index can be live
 * on a database that does not have it, and a product save that names a missing
 * table is a save that fails — the owner unable to change a price because the
 * search index they never asked about is one migration behind.
 *
 * `PRAGMA table_info` answers in a fraction of a read and never throws on a
 * table that is absent; it returns nothing. Callers on the WRITE path check
 * this before planning index rows. The read path does not need it: it already
 * distinguishes "no table" from "no match" through `indexReady`.
 */
export async function searchIndexInstalled(db: D1Database): Promise<boolean> {
  try {
    const rows = await db.prepare('PRAGMA table_info("search_tokens")').all<{ name: string }>();
    return (rows.results ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Does the index hold anything at all?
 *
 * One indexed probe — the smallest question that separates "nothing matched"
 * from "there is nothing to match against", which is the distinction
 * `SearchResult.indexReady` carries to the caller so it can fall back instead
 * of telling every shopper the shop is empty. Only ever run on a path that
 * already found nothing, so it costs nothing on a built index.
 */
async function indexHasRows(db: D1Database): Promise<boolean> {
  const any = await db.prepare('SELECT 1 AS n FROM search_tokens LIMIT 1').first<{ n: number }>();
  return !!any;
}

/** The dictionary, as a map. Small enough to read whole; cached per request. */
export async function loadSynonyms(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT term, canonical FROM search_synonyms LIMIT 5000')
    .all<{ term: string; canonical: string }>();
  const out = new Map<string, string>();
  for (const r of results ?? []) out.set(normalizeText(r.term), normalizeText(r.canonical));
  return out;
}

export interface SearchResult {
  /** Product ids, best first. */
  ids: string[];
  /** What the query was understood to mean — for diagnostics, never shown. */
  understood: string[];
  /**
   * False when the index holds NOTHING AT ALL, which is not the same answer as
   * "nothing matched".
   *
   * THE WINDOW THIS EXISTS FOR. Migration 0089 creates the tables; the rows are
   * written by the cron backfill, fifty products at a time, because indexing
   * needs the tokeniser and the brand and section names. Between the deploy and
   * the backfill catching up, the index is empty — and a search engine that
   * answers "no results" for EVERY query on a live shop is far worse than the
   * substring scan it replaces. The caller falls back while this is false.
   *
   * Costs nothing once the index exists: the probe only runs when a query found
   * no candidate tokens, which on a built index is the rare case.
   */
  indexReady: boolean;
}

/**
 * Run a search. Returns ranked product ids and nothing else.
 *
 * IDS ONLY, deliberately: the caller resolves them into cards through the same
 * pricing path every other listing uses, so a search result can never quote a
 * price the product page does not.
 *
 * AN EMPTY ANSWER IS AN ANSWER. When nothing matches, this returns no ids
 * rather than falling back to a substring scan. A fallback that returns
 * "something" is how a search engine starts showing people things they did not
 * ask for, and the caller's own empty state is honest about it.
 */
export async function searchProducts(
  db: D1Database,
  rawQuery: string,
  opts: { limit?: number; synonyms?: ReadonlyMap<string, string>; completeLast?: boolean } = {}
): Promise<SearchResult> {
  const limit = opts.limit ?? 50;
  const synonyms = opts.synonyms ?? (await loadSynonyms(db));
  const expanded = expandQuery(rawQuery, synonyms, { completeLast: opts.completeLast });
  /**
   * Nothing to look up — punctuation, or two bare letters with no word between
   * them. `indexReady` was hard-coded TRUE here, which told the caller "the
   * index answered, and the answer is nothing" about a query the index was
   * never asked. On a shop mid-backfill that is the difference between the
   * substring fallback and an empty grid, so it is probed like every other
   * empty answer in this function.
   */
  if (expanded.lookup.length === 0) {
    return { ids: [], understood: [], indexReady: await indexHasRows(db) };
  }

  // 1. The candidate vocabulary, by prefix. `>= p AND < p+1` is a range scan
  //    on idx_search_tokens_token; `LIKE 'p%'` would be too, but only when the
  //    pattern has no leading wildcard, and the range form cannot be broken by
  //    a stray `%` or `_` in a shopper's query.
  const prefixes = candidatePrefixes(expanded.lookup).slice(0, MAX_PREFIXES);
  const ranges = prefixes.map(() => '(token >= ? AND token < ?)').join(' OR ');
  const rangeParams: string[] = [];
  for (const p of prefixes) {
    rangeParams.push(p, p.slice(0, -1) + String.fromCodePoint((p.codePointAt(p.length - 1) ?? 0) + 1));
  }
  /**
   * WHAT THE CAP CUTS OFF MATTERS ONCE A PREFIX IS ONE CHARACTER LONG.
   *
   * `SELECT DISTINCT token … LIMIT 2000` has no ORDER BY, so SQLite serves it
   * in the range scan's own order — alphabetical. For a two-character prefix
   * that is harmless: the range is tens of tokens and the cap never bites. A
   * ONE-character prefix is roughly a tenth of the vocabulary, and on a real
   * catalogue «ا» or `h` would be truncated at the two-thousandth token
   * ALPHABETICALLY, which is to say the second half of the shelf is simply not
   * considered. One-character prefixes are not exotic — `candidatePrefix`
   * returns one for every token of three characters or fewer, so «اكس تو دي»
   * has had three of them since the day it was written.
   *
   * So when the prefix set contains one, the same covering index is read
   * weight-first instead: the tokens that survive the cap are the ones the
   * catalogue says loudest, not the ones that sort earliest. Under the cap the
   * two queries return the SAME SET — `bestMatches` sorts its own output, so
   * the order the rows arrive in cannot change an answer — and the aggregate
   * only costs a sort when a one-character range is in play, which is why the
   * cheaper form is kept for everything else.
   */
  const wideScan = prefixes.some((p) => [...p.replace(SKELETON_MARK, '')].length === 1);
  /**
   * EVERY CANDIDATE COMES BACK WITH ITS WEIGHT — the heaviest field it appears
   * in anywhere in the index. The wide scan always computed it and then threw
   * it away; `resolveTokens` now needs it, because which completions of "hot"
   * are worth keeping depends on whether "hotend" is a product NAME or a word
   * in somebody's description. `GROUP BY token` walks the covering index in
   * token order, so the narrow form pays nothing for it.
   */
  const vocabSql = wideScan
    ? `SELECT token, MAX(weight) AS w FROM search_tokens WHERE ${ranges}
        GROUP BY token ORDER BY w DESC, LENGTH(token) ASC, token ASC LIMIT ${MAX_VOCABULARY}`
    : `SELECT token, MAX(weight) AS w FROM search_tokens WHERE ${ranges} GROUP BY token LIMIT ${MAX_VOCABULARY}`;
  const { results: vocabRows } = await db
    .prepare(vocabSql)
    .bind(...rangeParams)
    .all<{ token: string; w: number }>();
  const weights = new Map<string, number>();
  for (const r of vocabRows ?? []) weights.set(String(r.token), Number(r.w) || 0);
  const vocabulary = [...weights.keys()];
  if (vocabulary.length === 0) {
    // No candidates. Is the index empty, or does this query simply match
    // nothing? One indexed probe tells the caller which, and it only runs here.
    return { ids: [], understood: expanded.lookup, indexReady: await indexHasRows(db) };
  }

  // 2. Which vocabulary tokens the query actually means — exact, prefix, then
  //    a bounded edit distance over this handful only.
  const matched = resolveTokens(expanded, vocabulary, weights);
  if (matched.size === 0) return { ids: [], understood: expanded.lookup, indexReady: true };

  /**
   * ONE BOUND PARAMETER, HOWEVER MANY TOKENS MATCHED.
   *
   * This was `token IN (?, ?, …)` with a placeholder per matched token. D1
   * refuses a statement with more than 100 bound parameters (the rule
   * worker/lib/financeReport.ts §7 writes down), and a single letter now
   * resolves to every naming word it starts — far more than a hundred on a
   * real catalogue. `json_each` turns one JSON array into the same `IN` list,
   * and SQLite still answers `token IN (subquery)` from the covering index.
   *
   * HEAVIEST FIRST, so that when the cap bites it drops description rows, not
   * the product names the letter was typed for.
   */
  const tokens = [...matched.keys()];
  const { results: postings } = await db
    .prepare(
      `SELECT product_id, token, weight FROM search_tokens
        WHERE token IN (SELECT value FROM json_each(?))
        ORDER BY weight DESC LIMIT ${MAX_POSTINGS}`
    )
    .bind(JSON.stringify(tokens))
    .all<IndexRow>();

  const scored: ScoredProduct[] = scoreProducts(expanded, matched, postings ?? []);
  return { ids: scored.slice(0, limit).map((s) => s.product_id), understood: tokens, indexReady: true };
}

/**
 * Rebuild the whole index from the catalogue.
 *
 * For the backfill and for an owner who has changed the vocabulary and wants
 * it applied to what is already there. Chunked, because a shop with thousands
 * of products cannot be re-indexed inside one Worker invocation and pretending
 * otherwise would mean a job that silently stops halfway.
 */
export async function reindexChunk(
  db: D1Database,
  docsFor: (rows: Record<string, unknown>[]) => SearchDoc[],
  opts: { afterId?: string; size?: number } = {}
): Promise<{ indexed: number; lastId: string | null }> {
  const size = opts.size ?? 50;
  const { results } = await db
    .prepare(
      `SELECT * FROM products
        WHERE status = 'active' AND id > ?
        ORDER BY id
        LIMIT ?`
    )
    .bind(opts.afterId ?? '', size)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  if (rows.length === 0) return { indexed: 0, lastId: null };

  const stmts: D1PreparedStatement[] = [];
  for (const doc of docsFor(rows)) stmts.push(...planSearchIndex(db, doc));
  if (stmts.length > 0) await db.batch(stmts);
  return { indexed: rows.length, lastId: String(rows[rows.length - 1].id) };
}

/** What one backfill pass did. `failed` is reported, never thrown. */
export interface BackfillResult {
  indexed: number;
  failed: { id: string; error: string }[];
}

/**
 * How many products share one `db.batch`. Small on purpose: a batch is all or
 * nothing, and a product with a long description is a couple of thousand
 * statements on its own. Ten keeps a healthy chunk cheap and a bad one's blast
 * radius at nine innocent products, which are then retried one by one.
 */
const BACKFILL_GROUP = 10;

/**
 * INDEX THE PRODUCTS WHOSE ROWS ARE MISSING OR STALE, a bounded pass at a time.
 *
 * The cron runs it over the whole catalogue (fifty per run); a brand or
 * section rename runs it over the products that carry that name (`scope`), so
 * the new name is findable the moment the rename returns rather than at the
 * next cron tick.
 *
 * ONE FAILURE CANNOT STALL THE REST. This used to be a single all-or-nothing
 * `db.batch` over fifty products, taken `ORDER BY id` — so one product that
 * could not be written failed the whole batch, the next run selected the same
 * fifty, and every product after them was never indexed. Now the products go
 * in groups of `BACKFILL_GROUP`; a group that throws is retried product by
 * product; and a product that still throws is marked with `INDEX_FAILED_MARK`
 * so the next selection moves past it, and returned in `failed` for the cron
 * report. Its old rows, if it had any, are untouched — a batch is atomic — so
 * it stays findable by whatever it was findable by before.
 */
export async function backfillSearchIndex(
  db: D1Database,
  opts: { limit?: number; scope?: { sql: string; params: unknown[] } } = {}
): Promise<BackfillResult> {
  const limit = opts.limit ?? 50;
  const scope = opts.scope;
  const { results } = await db
    .prepare(
      `SELECT ${searchDocColumns('p')}
         FROM products p
        WHERE p.status = 'active'
          AND ${SEARCH_INDEX_STALE_SQL}
          AND ${SEARCH_INDEX_FAILED_SQL}
          ${scope ? `AND (${scope.sql})` : ''}
        ORDER BY p.id
        LIMIT ?`
    )
    .bind(INDEX_STAMP, INDEX_FAILED_MARK, ...(scope?.params ?? []), limit)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const out: BackfillResult = { indexed: 0, failed: [] };
  if (rows.length === 0) return out;

  // THE SAME DOCUMENT THE SAVE PATH WRITES, from the same builder. The cron
  // once composed its own and dropped the option names; two writers of one
  // index must not be two documents.
  const docs = await searchDocsForRows(db, rows);
  for (let i = 0; i < docs.length; i += BACKFILL_GROUP) {
    const group = docs.slice(i, i + BACKFILL_GROUP);
    try {
      await db.batch(group.flatMap((doc) => planSearchIndex(db, doc)));
      out.indexed += group.length;
      continue;
    } catch {
      // Fall through to one product at a time, to find the one that failed.
    }
    for (const doc of group) {
      try {
        await db.batch(planSearchIndex(db, doc));
        out.indexed += 1;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        out.failed.push({ id: doc.productId, error });
        try {
          await db
            .prepare('INSERT OR REPLACE INTO search_tokens (product_id, token, weight) VALUES (?, ?, 0)')
            .bind(doc.productId, INDEX_FAILED_MARK)
            .run();
        } catch {
          // Could not even mark it. It will be selected again next run, and
          // reported again — which is noisy, and still honest.
        }
      }
    }
  }
  return out;
}

/**
 * THE STATEMENT THAT MAKES A RENAME REACH THE INDEX.
 *
 * The index stores brand and section NAMES on each product (./document.ts),
 * because a shopper types «بامبو لاب», never `brd_1c09…`. So renaming a brand
 * changed nothing a search could see: its products kept the current stamp, the
 * backfill never selected them, the old name kept matching and the new one
 * found nothing until each product was re-saved by hand.
 *
 * This deletes the STAMP of every product `scope` selects (`p` is `products`),
 * which is exactly "indexed by an older document" — the backfill's own
 * predicate. Put it in the same batch as the rename, so the two cannot
 * disagree, then run `backfillSearchIndex` with the same scope to rewrite them
 * straight away; anything that pass does not reach, the cron does.
 */
export function planSearchRestamp(db: D1Database, scope: { sql: string; params: unknown[] }): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM search_tokens
        WHERE token = ?
          AND product_id IN (SELECT p.id FROM products p WHERE ${scope.sql})`
    )
    .bind(INDEX_STAMP, ...scope.params);
}
