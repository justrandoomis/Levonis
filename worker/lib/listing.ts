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
 *
 * THE CLEAN START (the owner's answer Q6, DECISIONS row 222; spec addendum
 * A.4): a platform product is listed only while it is also V2-PUBLISHED — its
 * pricing state is `mode = 'engine'` with a V2 method AND the results of a
 * complete V2 price write exist (`V2_LISTED_CLAUSE`). Every product that
 * exists when the release deploys has no method, so all of them are hidden
 * from every customer surface at once, with no row update and no manual step,
 * and each one reappears the instant its first complete V2 write commits (the
 * same batch inserts its results). Old dinar prices can therefore never be
 * shown or sold again: a legacy door that was missed still cannot publish
 * anything. This clause does NOT depend on the owner's «إخفاء المنتجات
 * الناقصة» switch (the held clause), which he may turn off. Merchants' own
 * listings are `community_products`, another table this never touches.
 *
 * Fail closed ahead of 0189 (CLAUDE.md rule 2): a database without the V2
 * tables lists NOTHING (the clause becomes `AND 0`) and `unlistedIds` holds
 * every id back — a Worker ahead of its migration never shows a legacy price.
 */
import { pricingV2Installed } from './engineInstalled';


const PRESENT = new WeakMap<object, true>();
/** The probe in flight, shared by every caller of the same request (home asks from several shelves at once). */
const ASKING = new WeakMap<object, Promise<boolean>>();
/** A database that answered "no such table" lately: asked again after this long (a migration lands, never un-lands). */
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

const absentLately = (db: object) => (ABSENT_UNTIL.get(db) ?? 0) > Date.now();
/** A database that answered "no such table/column" for the V2 tables lately (no 0189): nothing is listed there. */
const V2_ABSENT_UNTIL = new WeakMap<object, number>();
const v2AbsentLately = (db: object) => (V2_ABSENT_UNTIL.get(db) ?? 0) > Date.now();

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

/** A V2 table or column is not on this database (no 0189) — the deploy-ahead answer: list nothing. */
function isMissingV2(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /no such (table|column)/i.test(msg) && /product_pricing_state|pricing_v2_sku_results|pricing_method/i.test(msg);
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
  return listedSql(alias, !absentLately(db), !v2AbsentLately(db));
}

/** This database refused the held clause within the last minute (no 0184): build today's SQL. */
export function listedWithoutHeld(db: D1Database): boolean {
  return absentLately(db);
}

/** This database refused the V2 clause within the last minute (no 0189): it lists nothing. */
export function listedWithoutV2(db: D1Database): boolean {
  return v2AbsentLately(db);
}

/** The held clause `listedSql` adds, for any alias. */
const HELD_CLAUSE = / AND NOT EXISTS \(SELECT 1 FROM product_completeness pch WHERE pch\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id AND pch\.held = 1\)/g;

/** `sql` without the held clause: what a database without 0184 runs. */
export function withoutHeld(sql: string): string {
  return sql.replace(HELD_CLAUSE, '');
}

/**
 * The clean start's clause on the `products` row `alias` (spec addendum A.4.1): V2-published.
 * A constant string, never built from input; primary-key lookups only.
 */
const v2Clause = (alias: string) =>
  ` AND EXISTS (SELECT 1 FROM product_pricing_state pv2 WHERE pv2.product_id = ${alias}.id AND pv2.mode = 'engine' AND pv2.pricing_method IS NOT NULL AND EXISTS (SELECT 1 FROM pricing_v2_sku_results rv2 WHERE rv2.product_id = ${alias}.id))`;

/** The V2 clause `listedSql` adds, for any alias. */
const V2_LISTED_CLAUSE = / AND EXISTS \(SELECT 1 FROM product_pricing_state pv2 WHERE pv2\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id AND pv2\.mode = 'engine' AND pv2\.pricing_method IS NOT NULL AND EXISTS \(SELECT 1 FROM pricing_v2_sku_results rv2 WHERE rv2\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id\)\)/g;

/** `sql` with the V2 clause replaced by `AND 0`: what a database without 0189 runs — it lists nothing (fail closed). */
export function withoutV2(sql: string): string {
  return sql.replace(V2_LISTED_CLAUSE, ' AND 0');
}

/**
 * Runs `sql` (built with `optimisticListed`) through `exec`. A database without
 * 0184 runs it once more without the held clause; one without 0189 runs it with
 * the V2 clause as `AND 0` — nothing listed, never a legacy price (fail closed).
 */
export async function runListed<T>(db: D1Database, sql: string, exec: (sql: string) => Promise<T>): Promise<T> {
  let current = sql;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await exec(current);
      if (withoutHeld(current) !== current) PRESENT.set(db, true);
      return out;
    } catch (err) {
      if (attempt >= 2) throw err;
      if (isMissingTable(err) && withoutHeld(current) !== current) {
        ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
        current = withoutHeld(current);
        continue;
      }
      if (isMissingV2(err) && withoutV2(current) !== current) {
        V2_ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
        current = withoutV2(current);
        continue;
      }
      throw err;
    }
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
 * `alias` (the table name itself when the statement does not alias it):
 * active, not held by the owner's switch (`installed`: 0184 is there), and
 * V2-published (`v2`: 0189 is there; without it the condition is `AND 0` —
 * nothing is listed, spec addendum A.4.1).
 */
export function listedSql(alias: string, installed: boolean, v2 = true): string {
  if (!ALIAS.test(alias)) throw new Error(`LISTING_INVARIANT: bad alias ${JSON.stringify(alias)}`);
  const active = `${alias}.status = 'active'`;
  const held = installed ? ` AND NOT EXISTS (SELECT 1 FROM product_completeness pch WHERE pch.product_id = ${alias}.id AND pch.held = 1)` : '';
  return `${active}${held}${v2 ? v2Clause(alias) : ' AND 0'}`;
}

export interface Listing {
  /** 0184's held table is on this database. */
  readonly installed: boolean;
  /** 0189's V2 tables are on this database (without them nothing is listed). */
  readonly v2: boolean;
  /** SQL: the `products` row `alias` is listed (see `listedSql`). */
  listed(alias?: string): string;
  /**
   * The ids among `ids` a customer may not see or buy: held by the owner's switch,
   * or not V2-published (the clean start). Every id without 0189; a chunk whose
   * read fails is unlisted (fail closed).
   */
  unlistedIds(ids: readonly string[]): Promise<Set<string>>;
  /** The former name of `unlistedIds` (kept one release for the in-memory sites). */
  heldIds(ids: readonly string[]): Promise<Set<string>>;
  /** A `products` row as read (status, id) is listed. Needs `unlisted` from `unlistedIds`. */
  isListedRow(row: { id?: unknown; status?: unknown } | null | undefined, unlisted: ReadonlySet<string>): boolean;
}

/** Ids at most per `json_each` probe; D1 binds one parameter whatever the count. */
const HELD_CHUNK = 200;

/** The listing predicate of this database. One probe the first time per binding, none after. */
export async function listing(db: D1Database): Promise<Listing> {
  const installed = await completenessInstalled(db);
  const v2 = await pricingV2Installed(db);
  const unlisted = (ids: readonly string[]) => unlistedIdsOf(db, installed, v2, ids);
  return {
    installed,
    v2,
    listed: (alias = 'products') => listedSql(alias, installed, v2),
    unlistedIds: unlisted,
    heldIds: unlisted,
    isListedRow: (row, held) => !!row && String(row.status ?? '') === 'active' && !held.has(String(row.id ?? '')),
  };
}

async function unlistedIdsOf(db: D1Database, installed: boolean, v2: boolean, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  // Without 0189 no product is V2-published: every one is held back (fail closed).
  if (!v2) return new Set(unique);
  const out = new Set<string>();
  const heldArm = installed ? ' OR EXISTS (SELECT 1 FROM product_completeness pch WHERE pch.product_id = p.id AND pch.held = 1)' : '';
  for (let i = 0; i < unique.length; i += HELD_CHUNK) {
    const chunk = unique.slice(i, i + HELD_CHUNK);
    try {
      const { results } = await db
        .prepare(`SELECT p.id AS id FROM products p WHERE p.id IN (SELECT value FROM json_each(?)) AND (NOT (1${v2Clause('p')})${heldArm})`)
        .bind(JSON.stringify(chunk))
        .all<{ id: string }>();
      for (const r of results ?? []) out.add(String(r.id));
    } catch {
      // A failed read must not open a held or unpublished product: fail closed for this chunk.
      for (const id of chunk) out.add(id);
    }
  }
  return out;
}

/** One product: may a customer NOT see or buy it (held, or not V2-published)? */
export async function isHeld(db: D1Database, productId: string): Promise<boolean> {
  const l = await listing(db);
  return (await l.unlistedIds([productId])).has(productId);
}

/** One product: is it V2-published (the clean start's clause alone; false without 0189 or on a failed read)? */
export async function isV2Published(db: D1Database, productId: string): Promise<boolean> {
  if (!(await pricingV2Installed(db))) return false;
  try {
    const row = await db.prepare(`SELECT 1 AS x FROM products p WHERE p.id = ?${v2Clause('p')}`).bind(productId).first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}
