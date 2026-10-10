/**
 * IS THIS PLATFORM PRODUCT LISTED TO CUSTOMERS? — the one predicate every
 * customer surface asks (owner brief 2026-10-10: «اخفاء كل المنتجات التي
 * تنقصها التكاليف والحقول الناقصه»).
 *
 * Until this file a customer saw a product exactly while `status = 'active'`,
 * repeated at some sixty sites. Now a product is listed while it is active
 * AND no `product_completeness` row holds it (`held = 1`, migration 0184).
 * `held` is 1 only while the owner's switch «إخفاء المنتجات الناقصة عن
 * الزبائن» is on and the product misses a required field
 * (worker/lib/productCompleteness.ts), so with the switch off every surface
 * answers exactly as before.
 *
 * A held product is indistinguishable from a hidden one to a customer: it is
 * absent from the listing, search, home, sections, compare and the sitemap,
 * its page and the public API answer the existing 404, and the cart and
 * checkout refuse it with the existing «unavailable» answers. Its status,
 * rows, stock, orders and gifts are untouched; every admin read sees it.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2). A database without 0184 has no such table;
 * the predicate is then today's `status = 'active'` exactly and `heldIds` is
 * empty. `listing(db)` asks once per database binding and remembers
 * "present" for good (a migration lands while the isolate lives and never
 * un-lands), the same shape as engineInstalled.ts; a failure to ask is
 * "absent". The first screen (home, its sections, the listing, the product
 * page) asks nothing first: `optimisticListed` + `runListed` below.
 *
 * tests/listingPredicateGuard.test.ts fails on a new raw `status = 'active'`
 * against `products` in a customer file: a new surface asks here.
 */

const PRESENT = new WeakMap<object, true>();
/** The probe in flight, shared by every caller of the same request (home asks from several shelves at once). */
const ASKING = new WeakMap<object, Promise<boolean>>();
/** A database that answered "no such table" lately: asked again after this long (a migration lands, never un-lands). */
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

const absentLately = (db: object) => (ABSENT_UNTIL.get(db) ?? 0) > Date.now();

/** Migration 0184's table is on this database. One statement per binding while unknown, none once present. */
export function completenessInstalled(db: D1Database): Promise<boolean> {
  if (PRESENT.has(db)) return Promise.resolve(true);
  if (absentLately(db)) return Promise.resolve(false);
  const asking = ASKING.get(db);
  if (asking) return asking;
  const probe = (async () => {
    try {
      await db.prepare('SELECT 1 AS x FROM product_completeness LIMIT 1').first<{ x: number }>();
      PRESENT.set(db, true);
      return true;
    } catch {
      return false;
    }
  })().finally(() => ASKING.delete(db));
  ASKING.set(db, probe);
  return probe;
}

/** "no such table: product_completeness" — the deploy-ahead answer, never a reason to open a held row. */
function isMissingTable(err: unknown): boolean {
  return /no such table:?\s*product_completeness/i.test(String((err as { message?: unknown })?.message ?? err));
}

/**
 * THE FIRST SCREEN ASKS NOTHING FIRST (tests/d1Waves.test.ts).
 *
 * The probe above is a round trip of its own the first time an isolate asks,
 * and on the home page, its sections, the listing and the product page the
 * listing SQL is the first thing that leaves — so the probe would be one more
 * wave on every cold isolate. Those reads go OPTIMISTIC instead, the shape
 * `catalogTreeWithCounts` and `openBoxShelf` already use for their newest
 * columns: the statement carries the held clause, and only if the database
 * refuses it for the missing table (a Worker ahead of its migrations) is it
 * run again without the clause — today's statement exactly. On a migrated
 * database the retry is never prepared, and the success itself proves the
 * table present, so the probe-based readers of the same isolate ask nothing.
 */
export function optimisticListed(db: D1Database, alias = 'products'): string {
  return listedSql(alias, !absentLately(db));
}

/** This database refused the held clause within the last minute (no 0184): build today's SQL. */
export function listedWithoutHeld(db: D1Database): boolean {
  return absentLately(db);
}

/** The held clause `listedSql` adds, for any alias. */
const HELD_CLAUSE = / AND NOT EXISTS \(SELECT 1 FROM product_completeness pch WHERE pch\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id AND pch\.held = 1\)/g;

/** `sql` without the held clause: what a database without 0184 runs. */
export function withoutHeld(sql: string): string {
  return sql.replace(HELD_CLAUSE, '');
}

/** Runs `sql` (built with `optimisticListed`) through `exec`; once more without the held clause if the table is missing. */
export async function runListed<T>(db: D1Database, sql: string, exec: (sql: string) => Promise<T>): Promise<T> {
  const plain = withoutHeld(sql);
  try {
    const out = await exec(sql);
    if (plain !== sql) PRESENT.set(db, true);
    return out;
  } catch (err) {
    if (plain === sql || !isMissingTable(err)) throw err;
    ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
    return exec(plain);
  }
}

/** One product row by its slug, listed to customers: the product page and its quote, one statement. */
export function listedProductBySlug(db: D1Database, slug: string): Promise<Record<string, unknown> | null> {
  return runListed(db, `SELECT * FROM products WHERE slug = ? AND ${optimisticListed(db)}`, (q) =>
    db.prepare(q).bind(slug).first<Record<string, unknown>>()
  );
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The SQL condition «listed to customers» for the `products` row named by
 * `alias` (the table name itself when the statement does not alias it).
 * `installed` false (no 0184) is today's condition, byte for byte.
 */
export function listedSql(alias: string, installed: boolean): string {
  if (!ALIAS.test(alias)) throw new Error(`LISTING_INVARIANT: bad alias ${JSON.stringify(alias)}`);
  const active = `${alias}.status = 'active'`;
  if (!installed) return active;
  return `${active} AND NOT EXISTS (SELECT 1 FROM product_completeness pch WHERE pch.product_id = ${alias}.id AND pch.held = 1)`;
}

export interface Listing {
  readonly installed: boolean;
  /** SQL: the `products` row `alias` is listed (see `listedSql`). */
  listed(alias?: string): string;
  /** The ids among `ids` a held row hides (empty without 0184). */
  heldIds(ids: readonly string[]): Promise<Set<string>>;
  /** A `products` row as read (status, id) is listed. Needs `held` from `heldIds`. */
  isListedRow(row: { id?: unknown; status?: unknown } | null | undefined, held: ReadonlySet<string>): boolean;
}

/** Ids at most per `json_each` probe; D1 binds one parameter whatever the count. */
const HELD_CHUNK = 200;

/** The listing predicate of this database. One probe the first time per binding, none after. */
export async function listing(db: D1Database): Promise<Listing> {
  const installed = await completenessInstalled(db);
  return {
    installed,
    listed: (alias = 'products') => listedSql(alias, installed),
    heldIds: (ids) => heldIdsOf(db, installed, ids),
    isListedRow: (row, held) => !!row && String(row.status ?? '') === 'active' && !held.has(String(row.id ?? '')),
  };
}

async function heldIdsOf(db: D1Database, installed: boolean, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!installed) return out;
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  for (let i = 0; i < unique.length; i += HELD_CHUNK) {
    const chunk = unique.slice(i, i + HELD_CHUNK);
    try {
      const { results } = await db
        .prepare('SELECT product_id FROM product_completeness WHERE held = 1 AND product_id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(chunk))
        .all<{ product_id: string }>();
      for (const r of results ?? []) out.add(String(r.product_id));
    } catch {
      // A failed read must not open a held product: fail closed for this chunk.
      for (const id of chunk) out.add(id);
    }
  }
  return out;
}

/** One product: is it held? (false without 0184). */
export async function isHeld(db: D1Database, productId: string): Promise<boolean> {
  const l = await listing(db);
  return (await l.heldIds([productId])).has(productId);
}
