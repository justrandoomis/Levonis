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
import { selectionNamesFrom, toSearchDoc, variantNamesFrom } from './document';
import { aliasReadCount, loadSearchSources } from './aliases';
import { IDENTIFIER_STAMP, identifierRows, planSearchIdentifiers, searchIdentifiersInstalled, type IdentifierRow } from './identifiers';
import { catalogKnowledgeInstalled, catalogKnowledgeKnown } from '../catalogKnowledge';
import { candidatePrefix } from './match';
import {
  buildIndexRows,
  candidatePrefixes,
  expandQuery,
  resolveTokens,
  productsLackingMeasures,
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
 * rewrites them a budgeted pass at a time (up to 200 per quarter-hour) until the whole catalogue matches. Bump
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
export const INDEX_STAMP = '#doc:6';

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
 *   #doc:5 — the document started carrying external-id and model aliases
 *          (./aliases.ts, migration 0194; Bambu import spec §C.1): a colour
 *          code, a part code, a SKU code and the identity model and series of
 *          a product, read by one loader that both writers use. On a database
 *          without 0194 the rewritten rows are the #doc:4 rows exactly.
 *   #doc:6 — measures are tokens: «0.4», «1,75» and
 *          «Ø6×2» are written `0.4`, `1.75`, `6x2` (a three-part size with its
 *          footprint beside it), with the unit as its own word, and the
 *          Arabic-Indic and Eastern digits are folded to ASCII
 *          (./normalize.ts). Until a product is rewritten, a size is not
 *          required of it (./index.ts `ScoreOptions.measureExempt`). The Arabic and Sorani descriptions, the brand and
 *          section names in every language and the variant SKUs are indexed;
 *          prose and measures carry no skeleton. The rows are written 500 to a
 *          statement (`INDEX_ROWS_PER_STATEMENT`), so the backfill that
 *          rewrites the catalogue costs a few statements a product, not one a
 *          token. `GET /api/admin/search/index-status` reports how far it is.
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

/**
 * Same shape, for `IDENTIFIER_STAMP` (./identifiers.ts, migration 0206): a
 * product whose identifier rows were never written, or were wiped with its
 * tokens by a writer that does not build them (a hashtag rename). Selected by
 * the backfill only once the table exists.
 */
const SEARCH_IDENTIFIERS_STALE_SQL =
  'NOT EXISTS (SELECT 1 FROM search_tokens s WHERE s.product_id = p.id AND s.token = ?)';

/**
 * Whether migration 0206 is on this database, asked INSIDE the backfill's own
 * selection: the predicate above needs the answer before anything is
 * selected, and a probe of its own would be one more statement a budgeted
 * pass pays on every binding it has not seen. `sqlite_master` is how the
 * finance and operations modules ask the same question.
 */
const SEARCH_IDENTIFIERS_INSTALLED_SQL =
  "EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_identifiers')";

/** Same shape, for `INDEX_FAILED_MARK`: a product the backfill gave up on. */
const SEARCH_INDEX_FAILED_SQL =
  'NOT EXISTS (SELECT 1 FROM search_tokens f WHERE f.product_id = p.id AND f.token = ?)';

/**
 * INDEX ROWS PER STATEMENT. Each product's rows go in as one JSON array per
 * statement (`json_each`), not one statement per row.
 *
 * One statement a row made a product cost two statements plus one per token,
 * and D1 allows 1,000 statements per invocation: the quarter-hour catch-up
 * rewrote a handful of products a tick, and a product with a long description
 * in three languages could not fit one tick at all. A whole catalogue's
 * rewrite after an `INDEX_STAMP` bump took days. Now a product is its DELETE
 * and one INSERT per 500 rows (the stamp rides in the last one): two or three
 * statements, so a tick rewrites a couple of hundred products.
 *
 * Two bound parameters whatever the size — D1's 100-parameter refusal never
 * comes near — and 500 rows is a few tens of kilobytes of JSON, far under
 * D1's limits on a bound value.
 */
export const INDEX_ROWS_PER_STATEMENT = 500;

const INSERT_INDEX_ROWS_SQL = `INSERT OR REPLACE INTO search_tokens (product_id, token, weight)
  SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?2) j`;

/**
 * Replace a product's index rows with exactly these rows, and its stamp.
 *
 * Returns STATEMENTS rather than running them, so the caller can put them in
 * the same batch as the product write. A search index updated in a second
 * transaction is an index that disagrees with the catalogue whenever the
 * second one fails.
 *
 * `identifiers` (./identifiers.ts, migration 0206): the product's identifier
 * rows, when the caller built them — which it does only when the table is
 * there. They replace the product's stored ones, and `IDENTIFIER_STAMP` is
 * written beside `INDEX_STAMP`. Absent (`undefined`/null): the identifier rows
 * are not touched, and the stamp is gone with the rest of the product's
 * tokens, so the catch-up writes them again.
 */
export function planSearchIndexRows(
  db: D1Database,
  productId: string,
  rows: readonly IndexRow[],
  identifiers?: readonly IdentifierRow[] | null
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM search_tokens WHERE product_id = ?').bind(productId)];
  // And the stamp that says WHICH BUILDER wrote these rows (see INDEX_STAMP),
  // written by the same statement as the last of them.
  const pairs: [string, number][] = rows.map((r) => [r.token, r.weight]);
  pairs.push([INDEX_STAMP, 0]);
  if (identifiers) pairs.push([IDENTIFIER_STAMP, 0]);
  for (let i = 0; i < pairs.length; i += INDEX_ROWS_PER_STATEMENT) {
    stmts.push(db.prepare(INSERT_INDEX_ROWS_SQL).bind(productId, JSON.stringify(pairs.slice(i, i + INDEX_ROWS_PER_STATEMENT))));
  }
  if (identifiers) stmts.push(...planSearchIdentifiers(db, productId, identifiers));
  return stmts;
}

/**
 * A document, and the product's identifier rows when the builder made them
 * (`searchDocsForRows` with `identifiers: true` on a database with 0206).
 */
export type IndexedDoc = SearchDoc & { identifiers?: IdentifierRow[] | null };

/** `planSearchIndexRows` for a document: the rows `buildIndexRows` makes of it, and its identifier rows if it has them. */
export function planSearchIndex(db: D1Database, doc: IndexedDoc): D1PreparedStatement[] {
  return planSearchIndexRows(db, doc.productId, buildIndexRows(doc), doc.identifiers);
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
  'description_ar',
  'description_ku',
  'hashtags',
  'sku',
  'brand_id',
  'category_id',
  'sub_category_id',
  'options',
  'colors',
] as const;

/**
 * `SEARCH_DOC_COLUMNS` as a SELECT list, optionally under a table alias —
 * and the product's VARIANT SKUS beside them, as `variant_skus` (a JSON
 * array). A shopper holding a box types the code printed on it, and that code
 * is the variant's, in `product_variants`, which no index writer read. A
 * correlated subquery rather than a read of its own: the selection that
 * already pays for the rows brings them, so the budgeted backfill spends no
 * statement on them. `product_variants` is migration 0018's.
 */
export function searchDocColumns(alias = ''): string {
  const owner = alias || 'products';
  return [
    ...SEARCH_DOC_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)),
    `(SELECT json_group_array(v.sku) FROM product_variants v
       WHERE v.product_id = ${owner}.id AND v.active = 1 AND v.sku IS NOT NULL AND v.sku <> '') AS variant_skus`,
    // The same variants WITH THEIR IDS, `[[id, sku], …]`: an identifier row
    // (./identifiers.ts) names the variant a SKU belongs to.
    `(SELECT json_group_array(json_array(v.id, v.sku)) FROM product_variants v
       WHERE v.product_id = ${owner}.id AND v.active = 1 AND v.sku IS NOT NULL AND v.sku <> '') AS variant_refs`,
  ].join(', ');
}

/** `variant_refs` (`searchDocColumns`) read back: the active variants that carry a SKU. */
export function variantRefsOf(v: unknown): { id: string; sku: string }[] {
  if (typeof v !== 'string' || !v.startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((pair) =>
      Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' && pair[1].trim() !== '' ? [{ id: pair[0], sku: pair[1] }] : []
    );
  } catch {
    return [];
  }
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

/** The distinct brand and section ids `searchDocsForRows` resolves to names. */
function nameIdsOf(rows: Record<string, unknown>[]): { brands: string[]; catalogs: string[] } {
  const idsOf = (pick: (r: Record<string, unknown>) => unknown[]): string[] => [
    ...new Set(rows.flatMap(pick).filter((x): x is string => typeof x === 'string' && x !== '')),
  ];
  return { brands: idsOf((r) => [r.brand_id]), catalogs: idsOf((r) => [r.category_id, r.sub_category_id]) };
}

/**
 * The NAME reads `searchDocsForRows(db, rows)` executes, counted before it
 * runs: one read per `NAME_IN_CHUNK` slice of brand ids and of section ids.
 * A pass with a statement budget charges them before it sends them. The alias
 * reads beside them are counted by `aliasReadCount` (./aliases.ts): one per
 * 90 products once migration 0194 is known present, none without it.
 */
export function searchDocReadCount(rows: Record<string, unknown>[]): number {
  if (rows.length === 0) return 0;
  const ids = nameIdsOf(rows);
  return inChunks(ids.brands).length + inChunks(ids.catalogs).length;
}

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
  rows: Record<string, unknown>[],
  /**
   * `aliasesInstalled`: migration 0194's presence, when the caller already
   * asked (a budgeted pass charges the probe itself and passes the answer, so
   * nothing is sent that it did not pay for). Absent: the loader asks.
   */
  opts: {
    aliasesInstalled?: boolean;
    /**
     * Build each product's identifier rows too (./identifiers.ts) — the
     * catch-up does, on a database with migration 0206. They come from the
     * same reads: the alias statement brings the scoped external ids, the
     * selection brings `variant_refs`, and the names are on the row.
     */
    identifiers?: boolean;
  } = {}
): Promise<IndexedDoc[]> {
  if (rows.length === 0) return [];
  // EVERY LANGUAGE THE NAME IS WRITTEN IN (`#doc:6`). This read the English
  // name, or the Arabic when there was none — so «بامبو لاب» reached a Bambu
  // product only through the romanised bridge, and a Sorani section name never.
  const names = new Map<string, string[]>();
  const collect = async (table: 'brands' | 'catalogs', ids: string[]): Promise<void> => {
    for (const part of inChunks(ids)) {
      const ph = part.map(() => '?').join(',');
      const { results } = await db
        .prepare(`SELECT id, name_en, name_ar, name_ckb FROM ${table} WHERE id IN (${ph})`)
        .bind(...part)
        .all<{ id: string; name_en: string | null; name_ar: string | null; name_ckb: string | null }>();
      for (const r of results ?? []) names.set(String(r.id), namesOf(r.name_en, r.name_ar, r.name_ckb));
    }
  };
  const ids = nameIdsOf(rows);
  await collect('brands', ids.brands);
  await collect('catalogs', ids.catalogs);
  // THE SAME ALIASES THE SAVE PATH WRITES (./aliases.ts): a backfilled product
  // keeps its colour code, part code and model, exactly as its last save did.
  const sources = await loadSearchSources(
    db,
    rows.map((r) => String(r.id)),
    opts.aliasesInstalled === undefined ? {} : { installed: opts.aliasesInstalled }
  );
  const aliases = sources.aliases;
  const named = (id: unknown): string[] => names.get(String(id ?? '')) ?? [];
  return rows.map((r) => ({
    ...toSearchDoc({
      id: String(r.id),
      name: r.name,
      name_ar: r.name_ar,
      name_ku: r.name_ku,
      description: r.description,
      description_ar: r.description_ar,
      description_ku: r.description_ku,
      hashtags: r.hashtags,
      sku: r.sku,
      brandNames: named(r.brand_id),
      categoryNames: [...named(r.category_id), ...named(r.sub_category_id)],
      variantNames: variantNamesFrom(r.options, r.colors),
      variantSkus: jsonStrings(r.variant_skus),
      aliases: aliases.get(String(r.id)) ?? [],
    }),
    ...(opts.identifiers
      ? {
          identifiers: identifierRows({
            sku: r.sku,
            variants: variantRefsOf(r.variant_refs),
            externalIds: sources.externalIds.get(String(r.id)) ?? [],
            options: selectionNamesFrom(r.options),
            colors: selectionNamesFrom(r.colors),
          }),
        }
      : {}),
  }));
}

/** A name's distinct, non-empty spellings across the three languages. */
export function namesOf(...values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
}

/** A JSON array of strings (`json_group_array`), read defensively. */
export function jsonStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (typeof v !== 'string' || !v.startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
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

/** The dictionary, as a map. Small enough to read whole. */
export async function loadSynonyms(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT term, canonical FROM search_synonyms LIMIT 5000')
    .all<{ term: string; canonical: string }>();
  const out = new Map<string, string>();
  for (const r of results ?? []) out.set(normalizeText(r.term), normalizeText(r.canonical));
  return out;
}

/**
 * THE DICTIONARY, ONCE PER ISOLATE FOR HALF A MINUTE (speed audit 2026-10-16,
 * «live search: every keystroke runs 5 dependent D1 round trips»).
 *
 * Every search answer read the whole dictionary first, and nothing else could
 * start before it — the query's expansion and the vocabulary scan depend on
 * it — so each keystroke of the live search paid one more dependent round
 * trip to the primary (0.15–0.2 s from an Iraqi colo). The dictionary is the
 * owner's vocabulary: it changes when the owner edits it or an import adds to
 * it. Kept per D1 binding (one object for the life of an isolate; a fresh one
 * per test database) like `pricingInputsFor` (worker/lib/membershipBenefits.ts),
 * forgotten at once by the writes in this isolate (`forgetSearchSynonyms`), and
 * re-read after `SYNONYMS_TTL_MS` everywhere else. A failed read is not kept.
 */
export const SYNONYMS_TTL_MS = 30_000;
const synonymsMemo = new WeakMap<object, { at: number; map: Promise<Map<string, string>> }>();

/**
 * Products this isolate has seen carry `INDEX_STAMP`, per database binding.
 * The builder only ever writes the current stamp, so a product never leaves
 * the set; a size query asks the index-version read only about the others,
 * and once the catch-up is done it asks nothing. Bounded, because it is a
 * memo, not the truth: past the cap the read simply runs.
 */
const STAMPED_MEMO_CAP = 20_000;
const stampedMemo = new WeakMap<object, Set<string>>();
function stampedProductsFor(db: D1Database): Set<string> {
  let set = stampedMemo.get(db as object);
  if (!set) {
    set = new Set();
    stampedMemo.set(db as object, set);
  }
  return set;
}

export function synonymsFor(db: D1Database, nowMs = Date.now()): Promise<Map<string, string>> {
  const hit = synonymsMemo.get(db);
  if (hit && nowMs - hit.at < SYNONYMS_TTL_MS) return hit.map;
  const map = loadSynonyms(db);
  synonymsMemo.set(db, { at: nowMs, map });
  map.catch(() => synonymsMemo.delete(db));
  return map;
}

/** Called by every write to `search_synonyms`, in the isolate that made it. */
export function forgetSearchSynonyms(db: D1Database): void {
  synonymsMemo.delete(db);
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
/**
 * How many ranked candidates a search with a `visible` check looks at for each
 * id it returns. See `SearchOptions.visible`.
 */
export const VISIBILITY_OVERFETCH = 3;

export interface SearchOptions {
  limit?: number;
  synonyms?: ReadonlyMap<string, string>;
  completeLast?: boolean;
  /**
   * WHICH OF THESE IDS A SHOPPER MAY SEE (docs/SEARCH.md, «Hidden products
   * take no ranking slot»). The index holds every product, hidden and draft
   * ones included, and the caller filters what
   * it is handed — so a hidden product ranked in the top `limit` took a slot
   * and the visible product it pushed out was simply never returned: «H» or
   * "bambu" on a shop with hidden stock answered with fewer, and worse,
   * products than it had. With this, when more products match than `limit`,
   * the best `limit × VISIBILITY_OVERFETCH` are asked about and the list is
   * cut to `limit` AFTER the hidden ones are gone. One extra read, and only
   * on a search that ranks more than `limit` products; a failed read keeps
   * today's cut (the caller still filters).
   */
  visible?: (ids: string[]) => Promise<ReadonlySet<string>>;
}

export async function searchProducts(
  db: D1Database,
  rawQuery: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const limit = opts.limit ?? 50;
  const synonyms = opts.synonyms ?? (await synonymsFor(db));
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
  /**
   * A WORD WHOSE EVERY RANGE WAS CUT CANNOT BE FOUND, SO IT IS NOT COUNTED.
   * `MAX_PREFIXES` drops the ranges past the twelfth, and every typed word
   * still counted toward coverage — a long query ranked every product down
   * for words it had not even looked for. A word counts when at least one of
   * its lookups (itself, a synonym, a skeleton) is in a range that is read.
   */
  const read = new Set(prefixes);
  const servable = new Set<string>();
  for (const t of expanded.lookup) if (read.has(candidatePrefix(t))) servable.add(expanded.origin.get(t) ?? t);
  const counted = expanded.literal.filter((l) => servable.has(l));
  const scoring = counted.length === expanded.literal.length ? expanded : { ...expanded, literal: counted };
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

  /**
   * A SIZE IS REQUIRED ONLY OF A PRODUCT INDEXED WITH SIZES (`ScoreOptions.
   * measureExempt` in ./index.ts). The products that match the query's other
   * words but not its measure are asked whether they carry `INDEX_STAMP`; the
   * ones that do not are still on an older builder's rows — the catch-up has
   * not reached them — and rank after the products that carry the size
   * instead of vanishing. One read, only for a query with a size, and only
   * when somebody lacks it; it returns the stale ones alone, so once the
   * catch-up is done it returns nothing. A failed read keeps the size
   * required of everybody.
   */
  let measureExempt: Set<string> | undefined;
  const lacking = productsLackingMeasures(scoring, matched, postings ?? []);
  const stamped = stampedProductsFor(db);
  const unknown = lacking.filter((id) => !stamped.has(id));
  if (unknown.length > 0) {
    measureExempt = await db
      .prepare(
        `SELECT l.value AS product_id FROM json_each(?2) l
          WHERE NOT EXISTS (SELECT 1 FROM search_tokens t WHERE t.token = ?1 AND t.product_id = l.value)`
      )
      .bind(INDEX_STAMP, JSON.stringify(unknown))
      .all<{ product_id: string }>()
      .then(({ results }) => {
        const stale = new Set((results ?? []).map((r) => String(r.product_id)));
        if (stamped.size < STAMPED_MEMO_CAP) for (const id of unknown) if (!stale.has(id)) stamped.add(id);
        return stale;
      })
      .catch((e: unknown) => {
        console.warn('search: index-version read failed, a size stays required of every product:', e instanceof Error ? e.message : String(e));
        return undefined;
      });
  } else if (lacking.length > 0) {
    measureExempt = new Set();
  }
  const scored: ScoredProduct[] = scoreProducts(scoring, matched, postings ?? [], { measureExempt });
  let ids = scored.slice(0, limit).map((s) => s.product_id);
  if (opts.visible && scored.length > limit) {
    const pool = scored.slice(0, limit * VISIBILITY_OVERFETCH).map((s) => s.product_id);
    const shown = await opts.visible(pool).catch(() => null);
    if (shown) ids = pool.filter((id) => shown.has(id)).slice(0, limit);
  }
  return { ids, understood: tokens, indexReady: true };
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

/**
 * A statement budget as a budgeted pass spends it: the shape of
 * worker/lib/fx/budget.ts `StatementBudget`, which the quarter-hour cron
 * hands in. Named here rather than imported — the FX module is imported only
 * by the cron and the pricing doors (tests/pricingCurrencyRoles.test.ts).
 */
export interface PassBudget {
  readonly limit: number;
  readonly used: number;
  canSpend(n: number): boolean;
  spend(n: number): boolean;
}

/** What one backfill pass did. `failed` is reported, never thrown. */
export interface BackfillResult {
  indexed: number;
  failed: { id: string; error: string }[];
  /**
   * Products selected but left stale for a later pass because the pass's
   * statement budget could not cover them (always 0 without a budget). They
   * keep their old rows and are selected again, oldest id first.
   */
  deferred: number;
}

/**
 * How many products share one `db.batch`. Small on purpose: a batch is all or
 * nothing, and a product with a long description in three languages is
 * thousands of rows on its own. Ten keeps a healthy chunk cheap and a bad
 * one's blast radius at nine innocent products, which are then retried one by
 * one.
 */
const BACKFILL_GROUP = 10;

/**
 * INDEX THE PRODUCTS WHOSE ROWS ARE MISSING OR STALE, a bounded pass at a time.
 *
 * The cron runs it over the whole catalogue (up to 200 a budgeted pass, fifty without a budget); a brand or
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
 *
 * WITH A STATEMENT BUDGET (the quarter-hour cron, worker/index.ts): D1 allows
 * 1,000 statements per invocation and a product costs its DELETE and one
 * INSERT per `INDEX_ROWS_PER_STATEMENT` rows (one per row before `#doc:6`, when
 * fifty products could cost more than a whole tick). Every statement is
 * charged BEFORE it is sent — the selection, the name reads
 * (`searchDocReadCount`), the alias reads and their presence probe
 * (`aliasReadCount`, worker/lib/catalogKnowledge.ts), each group's batch,
 * each retry and each mark — and
 * a product whose rows the budget cannot cover is not sent: it keeps its old
 * rows and its stale stamp, so the next pass selects it again (`deferred`).
 * A batch is sent only when the budget also covers its failure (the retries
 * and the marks), so a failing product is still found and marked within the
 * pass. Nothing is lost and nothing is written twice: a product is either
 * written whole, with its stamp, in one batch, or left exactly as it was. A
 * product whose batch and mark are more than `ceiling` (the most any budget
 * handed to this pass can be) less the pass's own reads can never be written
 * by one — it is marked and reported like a write that failed, instead of
 * being selected first and skipped on every tick. Without a budget the pass
 * is exactly what it was.
 */
export async function backfillSearchIndex(
  db: D1Database,
  opts: { limit?: number; scope?: { sql: string; params: unknown[] }; budget?: PassBudget; ceiling?: number } = {}
): Promise<BackfillResult> {
  const limit = opts.limit ?? 50;
  const scope = opts.scope;
  const budget = opts.budget ?? null;
  const out: BackfillResult = { indexed: 0, failed: [], deferred: 0 };
  if (budget && !budget.spend(1)) return out;
  // THE IDENTIFIER ROWS (migration 0206, ./identifiers.ts): once the table
  // exists, a product is also stale while its identifier stamp is missing —
  // never written, or wiped by a token-only rewrite. The selection itself says
  // whether the table is there (`ids_installed`), so it costs no statement.
  const { results } = await db
    .prepare(
      `SELECT ${searchDocColumns('p')}, ${SEARCH_IDENTIFIERS_INSTALLED_SQL} AS ids_installed
         FROM products p
        WHERE p.status = 'active'
          AND (${SEARCH_INDEX_STALE_SQL} OR (${SEARCH_IDENTIFIERS_INSTALLED_SQL} AND ${SEARCH_IDENTIFIERS_STALE_SQL}))
          AND ${SEARCH_INDEX_FAILED_SQL}
          ${scope ? `AND (${scope.sql})` : ''}
        ORDER BY p.id
        LIMIT ?`
    )
    .bind(INDEX_STAMP, IDENTIFIER_STAMP, INDEX_FAILED_MARK, ...(scope?.params ?? []), limit)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  if (rows.length === 0) return out;
  const identifiers = Number(rows[0].ids_installed) === 1;
  // THE ALIAS READ (migration 0194, ./aliases.ts): its presence is asked once
  // per binding — charged when, and only when, the probe is sent — and then it
  // costs one statement per 90 products, none on a database without 0194.
  let aliasesInstalled = catalogKnowledgeKnown(db);
  if (aliasesInstalled === null) {
    if (budget && !budget.spend(1)) {
      out.deferred = rows.length;
      return out;
    }
    aliasesInstalled = await catalogKnowledgeInstalled(db);
  }
  const reads = searchDocReadCount(rows) + (aliasesInstalled ? aliasReadCount(rows.map((r) => r.id)) : 0);
  if (budget && !budget.spend(reads)) {
    out.deferred = rows.length;
    return out;
  }

  // THE SAME DOCUMENT THE SAVE PATH WRITES, from the same builder. The cron
  // once composed its own and dropped the option names; two writers of one
  // index must not be two documents.
  const docs = await searchDocsForRows(db, rows, { aliasesInstalled, identifiers });
  const spend = (n: number) => !budget || budget.spend(n);
  // WITH A BUDGET, A BATCH IS SENT ONLY WHEN ITS FAILURE IS PAID FOR TOO:
  // a group of k products and S statements may need S more to retry each
  // product alone, and k marks — so it reserves 2S + k. A lone product's retry
  // would be the same batch again, so it reserves its batch and one mark.
  // Without this a failing group near the end of the budget could not be
  // retried, and the next pass would build the same group again: the very
  // stall this function exists to prevent.
  const need = (count: number, statements: number) => (count === 1 ? statements + 1 : 2 * statements + count);
  const fits = (count: number, statements: number) => !budget || budget.canSpend(need(count, statements));
  const mark = async (doc: IndexedDoc, error: string) => {
    out.failed.push({ id: doc.productId, error });
    // No room to write the mark down: selected and reported again next pass.
    if (!spend(1)) return;
    try {
      await db
        .prepare('INSERT OR REPLACE INTO search_tokens (product_id, token, weight) VALUES (?, ?, 0)')
        .bind(doc.productId, INDEX_FAILED_MARK)
        .run();
    } catch {
      // Could not even mark it. It will be selected again next run, and
      // reported again — which is noisy, and still honest.
    }
  };
  const write = async (group: { doc: IndexedDoc; stmts: D1PreparedStatement[] }[]) => {
    const stmts = group.flatMap((p) => p.stmts);
    // Reserved as the group was built; never false here.
    if (!spend(stmts.length)) {
      out.deferred += group.length;
      return;
    }
    try {
      await db.batch(stmts);
      out.indexed += group.length;
      return;
    } catch (e) {
      if (budget && group.length === 1) {
        await mark(group[0].doc, e instanceof Error ? e.message : String(e));
        return;
      }
      // Fall through to one product at a time, to find the one that failed.
    }
    for (const { doc } of group) {
      const own = planSearchIndex(db, doc);
      if (!spend(own.length)) {
        out.deferred += 1;
        continue;
      }
      try {
        await db.batch(own);
        out.indexed += 1;
      } catch (e) {
        await mark(doc, e instanceof Error ? e.message : String(e));
      }
    }
  };

  // The most any budgeted pass could ever spend on one product: its batch and its mark.
  const largest = budget ? (opts.ceiling ?? budget.limit) - budget.used : Infinity;
  let group: { doc: IndexedDoc; stmts: D1PreparedStatement[] }[] = [];
  let size = 0;
  const flush = async () => {
    if (group.length > 0) await write(group);
    group = [];
    size = 0;
  };
  for (const doc of docs) {
    const stmts = planSearchIndex(db, doc);
    if (need(1, stmts.length) > largest) {
      // Never written by any budgeted pass: marked now (after what is already
      // grouped), so it is reported once and never selected again.
      await flush();
      await mark(doc, `needs ${stmts.length} statements, more than one budgeted pass may spend (${largest - 1})`);
      continue;
    }
    if (group.length > 0 && !fits(group.length + 1, size + stmts.length)) await flush();
    if (!fits(group.length + 1, size + stmts.length)) {
      out.deferred += 1;
      continue;
    }
    group.push({ doc, stmts });
    size += stmts.length;
    if (group.length === BACKFILL_GROUP) await flush();
  }
  await flush();
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

/**
 * PRODUCTS ONE BACKFILL PASS SELECTS. The quarter-hour catch-up runs with a
 * statement budget and takes up to 200 (docs/SEARCH.md §6): with the rows written
 * 500 to a statement a product costs two or three, so the budget — not this
 * number — is what paces a tick, and a stamp bump is repaired in a few ticks
 * instead of days. Every unbudgeted caller (a cron path that shares its
 * invocation with other jobs, a rename's immediate pass) keeps fifty.
 */
export const SEARCH_BACKFILL_BUDGETED_LIMIT = 200;
export const SEARCH_BACKFILL_LIMIT = 50;

/** How far the index is from describing the whole active catalogue with the current builder. */
export interface SearchIndexStatus {
  /** False on a database without migration 0089: nothing is indexed and nothing can be. */
  installed: boolean;
  /** The builder version the backfill writes (`INDEX_STAMP`). */
  stamp: string;
  /** Active products: what the backfill indexes. */
  active: number;
  /** Indexed by the current builder. */
  current: number;
  /** Still answering from an older builder's rows, waiting for the backfill. */
  older: number;
  /** No rows at all yet. */
  missing: number;
  /** Marked by the backfill as impossible to write with this builder (reported on the cron). */
  failed: number;
  /** `current / active` (1 for an empty catalogue). Coverage is complete at 1. */
  coverage: number;
  /**
   * AN UPPER BOUND ON THE PACE, not a measurement. A budgeted pass selects at
   * most `max_per_pass` products, one pass a quarter-hour; how many it really
   * writes is set by what the tick's other jobs leave of D1's 1,000
   * statements and by each product's size (its token and identifier
   * statements), so a busy tick writes fewer. `min_passes_left` is therefore
   * the FEWEST quarter-hours the rest can take; `coverage` is the exact count.
   */
  backfill: { max_per_pass: number; every_minutes: number; min_passes_left: number };
  /**
   * The identifier lane (migration 0206). While it is installed a product is
   * `current` only with its identifier rows written too (`IDENTIFIER_STAMP`).
   * `rows`: identifier rows stored, across the catalogue.
   */
  identifiers: { installed: boolean; stamp: string; rows: number };
}

/**
 * THE COVERAGE OF THE CURRENT BUILDER — `GET /api/admin/search/index-status`.
 *
 * A stamp bump (`#doc:6` here) is repaired by the cron, quietly, a pass at a
 * time; until it finishes, the products it has not reached still answer from
 * their old rows and lack whatever the new builder adds (a measure token, an
 * Arabic description). This is the number that says when the repair is done:
 * coverage 1 is every active product indexed by this builder. One statement,
 * a primary-key probe per product.
 */
export async function searchIndexStatus(db: D1Database): Promise<SearchIndexStatus> {
  const pace = (left: number) => ({
    max_per_pass: SEARCH_BACKFILL_BUDGETED_LIMIT,
    every_minutes: 15,
    min_passes_left: Math.ceil(left / SEARCH_BACKFILL_BUDGETED_LIMIT),
  });
  if (!(await searchIndexInstalled(db))) {
    return {
      installed: false,
      stamp: INDEX_STAMP,
      active: 0,
      current: 0,
      older: 0,
      missing: 0,
      failed: 0,
      coverage: 0,
      backfill: pace(0),
      identifiers: { installed: false, stamp: IDENTIFIER_STAMP, rows: 0 },
    };
  }
  const ids = await searchIdentifiersInstalled(db).catch(() => false);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS active,
              COALESCE(SUM(CASE WHEN cur THEN 1 ELSE 0 END ), 0) AS current,
              COALESCE(SUM(CASE WHEN NOT cur AND fail THEN 1 ELSE 0 END ), 0) AS failed,
              COALESCE(SUM(CASE WHEN NOT cur AND NOT fail AND old THEN 1 ELSE 0 END ), 0) AS older
         FROM (SELECT EXISTS (SELECT 1 FROM search_tokens t WHERE t.product_id = p.id AND t.token = ?1)
                      AND (?3 = 0 OR EXISTS (SELECT 1 FROM search_tokens i WHERE i.product_id = p.id AND i.token = ?4)) AS cur,
                      EXISTS (SELECT 1 FROM search_tokens f WHERE f.product_id = p.id AND f.token = ?2) AS fail,
                      EXISTS (SELECT 1 FROM search_tokens o WHERE o.product_id = p.id AND o.token >= '#doc:' AND o.token < '#doc;') AS old
                 FROM products p
                WHERE p.status = 'active')`
    )
    .bind(INDEX_STAMP, INDEX_FAILED_MARK, ids ? 1 : 0, IDENTIFIER_STAMP)
    .first<{ active: number; current: number; failed: number; older: number }>();
  const idRows = ids
    ? Number((await db.prepare('SELECT COUNT(*) AS n FROM search_identifiers').first<{ n: number }>().catch(() => null))?.n ?? 0)
    : 0;
  const active = Number(row?.active ?? 0);
  const current = Number(row?.current ?? 0);
  const failed = Number(row?.failed ?? 0);
  const older = Number(row?.older ?? 0);
  const missing = Math.max(0, active - current - failed - older);
  return {
    installed: true,
    stamp: INDEX_STAMP,
    active,
    current,
    older,
    missing,
    failed,
    coverage: active === 0 ? 1 : current / active,
    backfill: pace(older + missing),
    identifiers: { installed: ids, stamp: IDENTIFIER_STAMP, rows: idRows },
  };
}
