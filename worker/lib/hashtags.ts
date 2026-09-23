/**
 * Hashtags — the managed vocabulary (table `hashtags`, migration 0041) and
 * the free-form JSON array every product carries in `products.hashtags`.
 *
 * The product array is the truth about ONE product; the table is the list an
 * admin edits and the form / import template offer. This module keeps them in
 * step in both directions:
 *
 *   registerHashtags   a product save or import adds its tags to the table
 *                      (INSERT OR IGNORE — never a failure for the save)
 *   rewriteHashtag     a rename or removal in the admin rewrites every
 *                      product array that carries the tag — and reindexes
 *                      those products in the same batch, because hashtags are
 *                      weight 5 in the search index and a rewritten array the
 *                      index never heard about is a shop findable only under
 *                      a tag that no longer exists
 *   hashtagUsage       counts, so the admin sees what deleting would touch
 *
 * Tags keep the spelling they were typed with; equality is case-insensitive
 * ("PLA" and "pla" are one tag), which is what the UNIQUE NOCASE index on the
 * table enforces too.
 */

import { planSearchIndex, searchDocColumns, searchDocsForRows, searchIndexInstalled } from './search/store';

/**
 * `#My Tag ` -> `My-Tag`; the same rule the product form applies.
 *
 * `|` and `,` become `-` because they are the separators of the import
 * sheet's `hashtags` cell and of the form's own input: a tag allowed to
 * contain one would export as two tags and never survive a round-trip. A
 * leading `= + @` or tab goes for the same reason: `toCsv` prefixes such a
 * cell with a quote so a spreadsheet cannot execute it as a formula, and the
 * quote would come back as part of the tag.
 */
export function normalizeHashtag(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^[#\s=+@\t]+/, '')
    .replace(/[|,]+/g, '-')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** The comparison key: normalized and case-folded. */
export const hashtagKey = (tag: string): string => normalizeHashtag(tag).toLowerCase();

/** products.hashtags as stored (a JSON array, or nothing) -> clean strings. */
export function parseHashtagsCell(v: unknown): string[] {
  if (Array.isArray(v)) return dedupeHashtags(v.map(normalizeHashtag));
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? dedupeHashtags(parsed.map(normalizeHashtag)) : [];
  } catch {
    return [];
  }
}

/** Drops empties and case-insensitive duplicates, keeping the first spelling. */
export function dedupeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const tag = normalizeHashtag(t);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export interface HashtagUsage {
  /** The most common spelling on products. */
  spelling: string;
  count: number;
}

/** The products that carry at least one tag — the one query both readers use. */
const TAGGED_PRODUCTS = `SELECT id, hashtags FROM products
   WHERE hashtags IS NOT NULL AND hashtags <> '' AND hashtags <> '[]'`;

/** Every tag on every product, keyed by hashtagKey, with its product count. */
export async function hashtagUsage(db: D1Database): Promise<Map<string, HashtagUsage>> {
  const { results } = await db.prepare(TAGGED_PRODUCTS).all<{ hashtags: string }>();
  const out = new Map<string, HashtagUsage & { spellings: Map<string, number> }>();
  for (const row of results) {
    for (const tag of parseHashtagsCell(row.hashtags)) {
      const key = tag.toLowerCase();
      const entry = out.get(key) ?? { spelling: tag, count: 0, spellings: new Map<string, number>() };
      entry.count++;
      entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1);
      out.set(key, entry);
    }
  }
  const usage = new Map<string, HashtagUsage>();
  for (const [key, e] of out) {
    let best = e.spelling;
    let bestN = 0;
    for (const [s, n] of e.spellings) {
      if (n > bestN) {
        best = s;
        bestN = n;
      }
    }
    usage.set(key, { spelling: best, count: e.count });
  }
  return usage;
}

/**
 * Adds tags to the vocabulary when they are not there yet.
 *
 * THE EXISTING ROWS ARE READ AND FOLDED IN JS, and the unique index is only a
 * backstop. SQLite's NOCASE collation folds ASCII and nothing else: `Çap` and
 * `çap` do not collide in the index, so `INSERT OR IGNORE` alone would put
 * two rows in the table for what `hashtagKey` (and therefore every count,
 * lookup and rename) treats as one tag — a duplicate in the template, a
 * doubled product count, and a rename that strands the sibling. Folding here
 * makes the write path agree with the rest of the module for all of Unicode.
 *
 * Never throws: the product save this runs after must not fail because the
 * vocabulary table is missing on a database that has not run 0041 yet.
 */
export async function registerHashtags(
  db: D1Database,
  tags: string[],
  newId: (prefix: string) => string
): Promise<void> {
  const clean = dedupeHashtags(tags);
  if (clean.length === 0) return;
  try {
    const { results } = await db.prepare('SELECT tag FROM hashtags').all<{ tag: string }>();
    const known = new Set(results.map((r) => hashtagKey(r.tag)));
    const missing = clean.filter((tag) => !known.has(hashtagKey(tag)));
    if (missing.length === 0) return;
    await db.batch(
      missing.map((tag) => db.prepare('INSERT OR IGNORE INTO hashtags (id, tag) VALUES (?, ?)').bind(newId('tag'), tag))
    );
  } catch (e) {
    console.error('hashtag registration skipped', e instanceof Error ? e.message : String(e));
  }
}

/**
 * The vocabulary row a tag names, matched the way the rest of this module
 * matches — folded in JS, so a non-ASCII pair is one tag here too.
 */
export async function findHashtagRow<T extends { id: string; tag: string }>(
  db: D1Database,
  tag: string,
  exceptId = ''
): Promise<T | null> {
  const key = hashtagKey(tag);
  if (!key) return null;
  const { results } = await db.prepare('SELECT * FROM hashtags').all<T>();
  return results.find((r) => r.id !== exceptId && hashtagKey(r.tag) === key) ?? null;
}

/**
 * Rewrites every product that carries `from`: to `to` when renaming, or drops
 * it when `to` is null. Returns the number of products changed.
 *
 * The candidate rows are the SAME set `hashtagUsage` reads — every product
 * with a non-empty tag array — and the match itself is made in JS on the
 * parsed array. A `LIKE '%tag%'` pre-filter looks cheaper and is wrong three
 * ways: `_` and `%` inside a tag are wildcards, a tag with a quote or a
 * backslash is JSON-escaped in the stored cell and would not match, and a
 * substring hit ("pla" inside "plastic") has to be discarded afterwards
 * anyway. A rename that silently skips a product is worse than one scan.
 */
export async function rewriteHashtag(db: D1Database, from: string, to: string | null): Promise<number> {
  const fromKey = hashtagKey(from);
  if (!fromKey) return 0;
  const target = to === null ? null : normalizeHashtag(to);
  const { results } = await db.prepare(TAGGED_PRODUCTS).all<{ id: string; hashtags: string }>();
  const changed: Array<{ id: string; hashtags: string }> = [];
  for (const row of results) {
    const tags = parseHashtagsCell(row.hashtags);
    if (!tags.some((t) => t.toLowerCase() === fromKey)) continue;
    const next = dedupeHashtags(
      tags.flatMap((t) => (t.toLowerCase() === fromKey ? (target ? [target] : []) : [t]))
    );
    changed.push({ id: String(row.id), hashtags: JSON.stringify(next) });
  }
  if (changed.length === 0) return 0;

  /**
   * AND THE SEARCH INDEX, IN THE SAME BATCH AS THE UPDATE.
   *
   * A hashtag is weight 5 — the search index's own header calls this shop's
   * tags among the best signals it has, because the owner writes them by hand
   * as the exact words a customer would type. `UPDATE products SET hashtags`
   * alone left `search_tokens` holding the OLD tag for ever and never taught
   * it the new one: rename `#x2d-combo` and the shop stays findable only
   * under a tag that no longer exists anywhere the shopper can see, while the
   * one the admin just typed finds nothing. Deleting a tag was worse — the
   * word stayed in the index after it was gone from every product.
   *
   * The rows are read and the documents built with the NEW array already
   * substituted in, so what the index describes is the row that is landing
   * beside it rather than the one being replaced; and both statements go into
   * one `batch`, for the same reason the product save path does it — an index
   * written in a second transaction is an index that disagrees with the
   * catalogue every time the second one fails.
   *
   * ONLY WHEN THE TABLE IS THERE. A Worker reaches production without its
   * migrations on one of this shop's two deploy paths, and an admin who
   * cannot rename a tag because of a search index they never asked about is
   * the same failure the save path guards against. The backfill cron picks
   * the product up once the migration lands.
   */
  const reindex = await searchIndexInstalled(db);
  const nextById = new Map(changed.map((c) => [c.id, c.hashtags]));
  // Chunked by PRODUCT, not by statement: a product's UPDATE and its own index
  // rows have to be in one batch for either of them to mean anything.
  for (let i = 0; i < changed.length; i += 50) {
    const chunk = changed.slice(i, i + 50);
    const stmts = chunk.map((c) =>
      db.prepare('UPDATE products SET hashtags = ? WHERE id = ?').bind(c.hashtags, c.id)
    );
    if (reindex) {
      const ph = chunk.map(() => '?').join(',');
      const { results: rows } = await db
        .prepare(`SELECT ${searchDocColumns()} FROM products WHERE id IN (${ph})`)
        .bind(...chunk.map((c) => c.id))
        .all<Record<string, unknown>>();
      const docs = await searchDocsForRows(
        db,
        (rows ?? []).map((r) => ({ ...r, hashtags: nextById.get(String(r.id)) ?? r.hashtags }))
      );
      for (const doc of docs) stmts.push(...planSearchIndex(db, doc));
    }
    await db.batch(stmts);
  }
  return changed.length;
}
