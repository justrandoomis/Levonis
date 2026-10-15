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
 *
 * CATALOG-ONLY (DECISIONS rows 239 (3) and 240). The one predicate is now TWO,
 * and every caller names which question it asks (tests/listingPredicateGuard
 * counts them per file):
 *
 *   VISIBLE  — a customer may SEE it: `status = 'active'` and not held by the
 *              owner's switch for a CATALOG-blocking gap (`CATALOG_BLOCKING_CODES`:
 *              no picture, no section). The listing, search, sections, the
 *              product page, the public API, the sitemap, compare, favourites…
 *   SELLABLE — a customer may BUY it: the old «listed» predicate byte for byte
 *              (active, not held for ANY gap, V2-published). Every purchase path.
 *
 * catalog-only = VISIBLE and not SELLABLE: derived, never stored. Such a
 * product is shown with no number at all («السعر غير متوفر حالياً»), its old
 * dinar prices stay in the archive, and every purchase door refuses it
 * (`PRICE_NOT_AVAILABLE`). A database without 0189 shows every active product
 * catalog-only and sells nothing (the V2 clause is `AND 0`).
 */
import { CATALOG_BLOCKING_CODES } from '@levonis/contracts/productCompleteness';
import { pricingV2Installed, rememberPricingV2Present } from './engineInstalled';
import { HttpError } from './http';
import { serverMessage } from '@levonis/contracts/costRefusals';


const PRESENT = new WeakMap<object, true>();
/** The probe in flight, shared by every caller of the same request (home asks from several shelves at once). */
const ASKING = new WeakMap<object, Promise<boolean>>();
/** A database that answered "no such table" lately: asked again after this long (a migration lands, never un-lands). */
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

const absentLately = (db: object) => (ABSENT_UNTIL.get(db) ?? 0) > Date.now();
/** A database that answered "no such table/column" for the V2 tables lately (no 0189): nothing is sellable there. */
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

/** A V2 table or column is not on this database (no 0189) — the deploy-ahead answer: sell nothing. */
function isMissingV2(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /no such (table|column)/i.test(msg) && /product_pricing_state|pricing_v2_sku_results|pricing_method/i.test(msg);
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const checkAlias = (alias: string): void => {
  if (!ALIAS.test(alias)) throw new Error(`LISTING_INVARIANT: bad alias ${JSON.stringify(alias)}`);
};

/** `'IMAGE','CATEGORY'` — a constant built from the contract list, never from input. */
const CATALOG_CODES_SQL = CATALOG_BLOCKING_CODES.map((c) => `'${c}'`).join(',');

/** The SALE hold: held by the owner's switch for ANY missing field (the old «listed» clause). Alias `pch`. */
const saleHeldClause = (alias: string) =>
  ` AND NOT EXISTS (SELECT 1 FROM product_completeness pch WHERE pch.product_id = ${alias}.id AND pch.held = 1)`;

/**
 * The CATALOG hold: held by the switch AND missing a catalog-blocking code. Alias `pcv` (never `pch`), so
 * the two regexes below can never match each other's clause. `json_each` runs only for a held row, through
 * the primary key.
 */
const catalogHeldClause = (alias: string) =>
  ` AND NOT EXISTS (SELECT 1 FROM product_completeness pcv WHERE pcv.product_id = ${alias}.id AND pcv.held = 1` +
  ` AND EXISTS (SELECT 1 FROM json_each(pcv.missing_json) jcv WHERE json_extract(jcv.value, '$.c') IN (${CATALOG_CODES_SQL})))`;

/** The sale-held clause `sellableSql` adds, for any alias. */
const SALE_HELD_CLAUSE = / AND NOT EXISTS \(SELECT 1 FROM product_completeness pch WHERE pch\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id AND pch\.held = 1\)/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The catalog-held clause `visibleSql` adds, for any alias. */
const CATALOG_HELD_CLAUSE = new RegExp(
  escapeRe(' AND NOT EXISTS (SELECT 1 FROM product_completeness pcv WHERE pcv.product_id = ') +
    '[A-Za-z_][A-Za-z0-9_]*' +
    escapeRe(`.id AND pcv.held = 1 AND EXISTS (SELECT 1 FROM json_each(pcv.missing_json) jcv WHERE json_extract(jcv.value, '$.c') IN (${CATALOG_CODES_SQL})))`),
  'g'
);

/** `sql` without either held clause: what a database without 0184 runs. */
export function withoutHeld(sql: string): string {
  return sql.replace(SALE_HELD_CLAUSE, '').replace(CATALOG_HELD_CLAUSE, '');
}

/**
 * The clean start's clause on the `products` row `alias` (spec addendum A.4.1): V2-published.
 * A constant string, never built from input; primary-key lookups only.
 */
const v2Clause = (alias: string) =>
  ` AND EXISTS (SELECT 1 FROM product_pricing_state pv2 WHERE pv2.product_id = ${alias}.id AND pv2.mode = 'engine' AND pv2.pricing_method IS NOT NULL AND EXISTS (SELECT 1 FROM pricing_v2_sku_results rv2 WHERE rv2.product_id = ${alias}.id))`;

/** The V2 clause `sellableSql` adds, for any alias (global: it also sits inside a `sellable_now` CASE). */
const V2_LISTED_CLAUSE = / AND EXISTS \(SELECT 1 FROM product_pricing_state pv2 WHERE pv2\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id AND pv2\.mode = 'engine' AND pv2\.pricing_method IS NOT NULL AND EXISTS \(SELECT 1 FROM pricing_v2_sku_results rv2 WHERE rv2\.product_id = [A-Za-z_][A-Za-z0-9_]*\.id\)\)/g;

/** `sql` with the V2 clause replaced by `AND 0`: what a database without 0189 runs — it sells nothing (fail closed). */
export function withoutV2(sql: string): string {
  return sql.replace(V2_LISTED_CLAUSE, ' AND 0');
}

/**
 * VISIBLE: the SQL condition «a customer may see it» for the `products` row
 * `alias`: active, and not held by the owner's switch for a catalog-blocking
 * gap (`installed`: 0184 is there). Never depends on a price.
 */
export function visibleSql(alias: string, installed: boolean): string {
  checkAlias(alias);
  return `${alias}.status = 'active'${installed ? catalogHeldClause(alias) : ''}`;
}

/**
 * SELLABLE: the SQL condition «a customer may buy it» — the old «listed»
 * predicate byte for byte: active, not held by the owner's switch for any gap
 * (`installed`: 0184), and V2-published (`v2`: 0189 is there; without it the
 * condition is `AND 0` — nothing is sellable, spec addendum A.4.1).
 */
export function sellableSql(alias: string, installed: boolean, v2 = true): string {
  checkAlias(alias);
  const active = `${alias}.status = 'active'`;
  const held = installed ? saleHeldClause(alias) : '';
  return `${active}${held}${v2 ? v2Clause(alias) : ' AND 0'}`;
}

/** SELLABLE as a SELECT-list expression: 1 or 0 (`… AS sellable_now`). */
export function sellableFlagSql(alias: string, installed: boolean, v2 = true): string {
  return `(CASE WHEN ${sellableSql(alias, installed, v2)} THEN 1 ELSE 0 END)`;
}

/**
 * THE FIRST SCREEN ASKS NOTHING FIRST (tests/d1Waves.test.ts).
 *
 * The probe above is a round trip of its own the first time an isolate asks,
 * and on the home page, its sections, the listing and the product page the
 * listing SQL is the first thing that leaves — so the probe would be one more
 * wave on every cold isolate. Those reads go OPTIMISTIC instead, the shape
 * `catalogTreeWithCounts` and `openBoxShelf` already use for their newest
 * columns: the statement carries the held clauses, and only if the database
 * refuses it for the missing table (a Worker ahead of its migrations) is it
 * run again without them — today's statement exactly. On a migrated database
 * the retry is never prepared, and the success itself proves the table
 * present, so the probe-based readers of the same isolate ask nothing.
 */
export function optimisticVisible(db: D1Database, alias = 'products'): string {
  return visibleSql(alias, !absentLately(db));
}

export function optimisticSellable(db: D1Database, alias = 'products'): string {
  return sellableSql(alias, !absentLately(db), !v2AbsentLately(db));
}

export function optimisticSellableFlag(db: D1Database, alias = 'products'): string {
  return sellableFlagSql(alias, !absentLately(db), !v2AbsentLately(db));
}

/** This database refused the held clauses within the last minute (no 0184): build today's SQL. */
export function completenessAbsentLately(db: D1Database): boolean {
  return absentLately(db);
}

/** This database refused the V2 clause within the last minute (no 0189): it sells nothing. */
export function pricingV2AbsentLately(db: D1Database): boolean {
  return v2AbsentLately(db);
}

/**
 * Runs `sql` (built with the optimistic builders) through `exec`. A database
 * without 0184 runs it once more without the held clauses; one without 0189
 * runs it with the V2 clause as `AND 0` — nothing sellable, never a legacy
 * price (fail closed).
 */
export async function runListed<T>(db: D1Database, sql: string, exec: (sql: string) => Promise<T>): Promise<T> {
  let current = sql;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await exec(current);
      if (withoutHeld(current) !== current) PRESENT.set(db, true);
      // The V2 clause ran: 0189 is there, and the probe-based readers of this isolate ask nothing.
      if (withoutV2(current) !== current) rememberPricingV2Present(db);
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

/**
 * One product row by its slug, VISIBLE to customers, with `sellable_now` (1/0)
 * — the product page and its quote, one statement. `sellable_now` is not a
 * `products` column: `parseProductRow` ignores it.
 */
export function visibleProductBySlug(
  db: D1Database,
  slug: string
): Promise<(Record<string, unknown> & { sellable_now: 0 | 1 }) | null> {
  return runListed(db, `SELECT *, ${optimisticSellableFlag(db)} AS sellable_now FROM products WHERE slug = ? AND ${optimisticVisible(db)}`, (q) =>
    db.prepare(q).bind(slug).first<Record<string, unknown>>()
  ).then((r) => (r ? Object.assign(r, { sellable_now: Number(r.sellable_now) === 1 ? (1 as const) : (0 as const) }) : null));
}

/** One product row by its slug, SELLABLE to customers (a purchase door), one statement. */
export function sellableProductBySlug(db: D1Database, slug: string): Promise<Record<string, unknown> | null> {
  return runListed(db, `SELECT * FROM products WHERE slug = ? AND ${optimisticSellable(db)}`, (q) =>
    db.prepare(q).bind(slug).first<Record<string, unknown>>()
  );
}

/** A product's state for a customer: not shown, shown without a price, or shown and sold. */
export type CommercialState = 'hidden' | 'catalog_only' | 'sellable';

export interface Listing {
  /** 0184's held table is on this database. */
  readonly installed: boolean;
  /** 0189's V2 tables are on this database (without them nothing is sellable). */
  readonly v2: boolean;
  /** SQL: the `products` row `alias` is VISIBLE (see `visibleSql`). */
  visible(alias?: string): string;
  /** SQL: the `products` row `alias` is SELLABLE (see `sellableSql`). */
  sellable(alias?: string): string;
  /** A SELECT-list expression: 1 when the row `alias` is SELLABLE, else 0. */
  sellableFlag(alias?: string): string;
  /** The ids among `ids` a customer may not SEE (inactive or catalog-held). A chunk whose read fails is invisible (fail closed). */
  invisibleIds(ids: readonly string[]): Promise<Set<string>>;
  /**
   * The ids among `ids` a customer may not BUY: held by the owner's switch, or
   * not V2-published (the clean start). Every id without 0189; a chunk whose
   * read fails is unsellable (fail closed). Status is the row check's.
   */
  unsellableIds(ids: readonly string[]): Promise<Set<string>>;
  /**
   * Each id's state in ONE statement per 200 ids; an unknown id or a failed chunk is 'hidden', and so is
   * a composition that is not sellable (default D6).
   */
  statesOf(ids: readonly string[]): Promise<Map<string, CommercialState>>;
  /**
   * THE PURCHASE DOORS' FORM of `statesOf` (tests/listingPredicateGuard.test.ts bans `statesOf` there): the
   * ids a customer may BUY, and apart from them the ids still SHOWN without a price — only ever the reason
   * a door names for its refusal (409 PRICE_NOT_AVAILABLE), never a way in. Same statement, same fail-closed.
   */
  sellableAndCatalogOnly(ids: readonly string[]): Promise<{ sellable: Set<string>; catalogOnly: Set<string> }>;
  /** A `products` row as read (status, id) is VISIBLE. Needs `invisible` from `invisibleIds`. */
  isVisibleRow(row: { id?: unknown; status?: unknown } | null | undefined, invisible: ReadonlySet<string>): boolean;
  /** A `products` row as read (status, id) is SELLABLE. Needs `unsellable` from `unsellableIds`. */
  isSellableRow(row: { id?: unknown; status?: unknown } | null | undefined, unsellable: ReadonlySet<string>): boolean;
}

/** Ids at most per `json_each` probe; D1 binds one parameter whatever the count. */
const ID_CHUNK = 200;

const activeRow = (row: { id?: unknown; status?: unknown } | null | undefined, out: ReadonlySet<string>): boolean =>
  !!row && String(row.status ?? '') === 'active' && !out.has(String(row.id ?? ''));

/** The listing predicates of this database. One probe the first time per binding, none after. */
export async function listing(db: D1Database): Promise<Listing> {
  // Both probes in one wave (each is asked once per binding, and not at all after an optimistic read).
  const [installed, v2] = await Promise.all([completenessInstalled(db), pricingV2Installed(db)]);
  return {
    installed,
    v2,
    visible: (alias = 'products') => visibleSql(alias, installed),
    sellable: (alias = 'products') => sellableSql(alias, installed, v2),
    sellableFlag: (alias = 'products') => sellableFlagSql(alias, installed, v2),
    invisibleIds: (ids) => invisibleIdsOf(db, installed, v2, ids),
    unsellableIds: (ids) => unsellableIdsOf(db, installed, v2, ids),
    statesOf: (ids) => statesOfIds(db, installed, v2, ids),
    sellableAndCatalogOnly: async (ids) => {
      const states = await statesOfIds(db, installed, v2, ids);
      const sellable = new Set<string>();
      const catalogOnly = new Set<string>();
      for (const [id, state] of states) {
        if (state === 'sellable') sellable.add(id);
        else if (state === 'catalog_only') catalogOnly.add(id);
      }
      return { sellable, catalogOnly };
    },
    isVisibleRow: activeRow,
    isSellableRow: activeRow,
  };
}

const uniqueIds = (ids: readonly string[]) => [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];

/**
 * A COMPOSITION (bundle, mystery box) is shown only while SELLABLE (DECISIONS row 240, default D6: its
 * content is its price), so the id-set readers below count a catalog-only composition as hidden.
 */
const compositionShownSql = (alias: string, installed: boolean, v2: boolean) =>
  `(COALESCE(${alias}.composition, '') = '' OR ${sellableSql(alias, installed, v2)})`;

async function invisibleIdsOf(db: D1Database, installed: boolean, v2: boolean, ids: readonly string[]): Promise<Set<string>> {
  const unique = uniqueIds(ids);
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    try {
      const { results } = await db
        .prepare(
          `SELECT p.id AS id FROM products p WHERE p.id IN (SELECT value FROM json_each(?)) AND NOT (${visibleSql('p', installed)} AND ${compositionShownSql('p', installed, v2)})`
        )
        .bind(JSON.stringify(chunk))
        .all<{ id: string }>();
      for (const r of results ?? []) out.add(String(r.id));
    } catch {
      // A failed read must not show a held product: fail closed for this chunk.
      for (const id of chunk) out.add(id);
    }
  }
  return out;
}

async function unsellableIdsOf(db: D1Database, installed: boolean, v2: boolean, ids: readonly string[]): Promise<Set<string>> {
  const unique = uniqueIds(ids);
  // Without 0189 no product is V2-published: every one is held back (fail closed).
  if (!v2) return new Set(unique);
  const out = new Set<string>();
  const heldArm = installed ? ' OR EXISTS (SELECT 1 FROM product_completeness pch WHERE pch.product_id = p.id AND pch.held = 1)' : '';
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
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

async function statesOfIds(db: D1Database, installed: boolean, v2: boolean, ids: readonly string[]): Promise<Map<string, CommercialState>> {
  const unique = uniqueIds(ids);
  const out = new Map<string, CommercialState>();
  for (const id of unique) out.set(id, 'hidden');
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    try {
      const { results } = await db
        .prepare(
          `SELECT p.id AS id, (CASE WHEN ${visibleSql('p', installed)} AND COALESCE(p.composition, '') = '' THEN 1 ELSE 0 END) AS v, ${sellableFlagSql('p', installed, v2)} AS s` +
            ' FROM products p WHERE p.id IN (SELECT value FROM json_each(?))'
        )
        .bind(JSON.stringify(chunk))
        .all<{ id: string; v: number; s: number }>();
      for (const r of results ?? []) {
        out.set(String(r.id), Number(r.s) === 1 ? 'sellable' : Number(r.v) === 1 ? 'catalog_only' : 'hidden');
      }
    } catch {
      // Fail closed: a chunk whose read failed stays 'hidden'.
    }
  }
  return out;
}

/** One product: may a customer NOT buy it (held, or not V2-published)? */
export async function isUnsellable(db: D1Database, productId: string): Promise<boolean> {
  const l = await listing(db);
  return (await l.unsellableIds([productId])).has(productId);
}

/** The 409 every purchase door answers for a product a customer can see but not buy (DECISIONS row 240). */
export const priceNotAvailable = (): HttpError =>
  new HttpError(409, serverMessage('PRICE_NOT_AVAILABLE'), 'PRICE_NOT_AVAILABLE', { price_status: 'unpriced' });

/**
 * THE VISIBLE-THEN-REFUSE LOOKUP of a purchase door that just found `productId`
 * unsellable: if a customer can still SEE it (catalog-only), throw 409
 * `PRICE_NOT_AVAILABLE`; otherwise return, and the door answers its own 404 as
 * before. One statement, on the refusal path only. The one VISIBLE question a
 * SELLABLE-only file may ask (tests/listingPredicateGuard.test.ts).
 */
export async function refuseIfOnlyCatalog(db: D1Database, productId: string): Promise<void> {
  if (!productId) return;
  const l = await listing(db);
  const state = (await l.statesOf([productId])).get(productId);
  if (state === 'catalog_only') throw priceNotAvailable();
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
