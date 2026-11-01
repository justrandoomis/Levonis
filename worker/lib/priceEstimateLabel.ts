/**
 * THE ESTIMATE LABEL, AS EVERY READER NEEDS IT (docs/SMART_PRICING.md §2.4,
 * §5.2; migration 0218).
 *
 * `products.price_estimate` is 1 while a product's published price is an
 * estimate the owner has not confirmed against the supplier. It is set only in
 * the batch that first prices the product (trigger T1) and cleared only by the
 * owner's confirmation (T2). It is read from the very row the price is read
 * with — the existing `SELECT *` of every listing, detail, cart and checkout
 * row — so asking costs no statement.
 *
 * A leaf module — no imports — so the overlay, the purchase doors, the print
 * calculator, the gift / bundle / mystery candidates and the sweeps can ask
 * without pulling the estimator into their dependency graph.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2). A database without 0218 has no such column
 * and none of its tables. That database holds no labelled product — the
 * column's own default — so:
 *   - a row without the key is not labelled (`isEstimateRow`): substitution,
 *     not degradation;
 *   - a statement carrying `estimateClause` that the database refuses with
 *     "no such column: price_estimate" (or a statement reading one of 0218's
 *     tables, "no such table: …") is run again without it — today's statement
 *     exactly (`withoutEstimateClause`, modelled on listing.ts `withoutV2`) —
 *     and the binding remembers the absence for a minute, as listing.ts
 *     `absentLately` does: a migration lands, it never un-lands;
 *   - the owner's routes ask `priceEstimatesInstalled` once per binding and
 *     answer 503 PRICE_ESTIMATES_NOT_INSTALLED until it says yes.
 * Any other error is not ours to hide and is thrown.
 */

/**
 * Is this product row — or the product document built from it — labelled an
 * estimate? `1` on a raw row, `true` on a parsed document; an absent key (a
 * database without 0218, or any unlabelled product) is not.
 */
export function isEstimateRow(row: Record<string, unknown> | null | undefined): boolean {
  const v = row?.price_estimate;
  return v === 1 || v === true || v === '1';
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The SQL condition «the `products` row `alias` is NOT labelled», with its
 * leading ` AND `: the exclusion the doors that freeze or derive a value from
 * a price add (print materials, mystery entries, bundle members, gift and
 * trade-in candidates). A constant built from a checked alias, never from input.
 */
export function estimateClause(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`PRICE_ESTIMATE_INVARIANT: bad alias ${JSON.stringify(alias)}`);
  return ` AND COALESCE(${alias}.price_estimate, 0) = 0`;
}

/** Every clause `estimateClause` builds, for any alias. */
const ESTIMATE_CLAUSE = / AND COALESCE\([A-Za-z_][A-Za-z0-9_]*\.price_estimate, 0\) = 0/g;

/** `sql` without any `estimateClause`: what a database without 0218 runs (it holds no labelled product). */
export function withoutEstimateClause(sql: string): string {
  return sql.replace(ESTIMATE_CLAUSE, '');
}

/**
 * Did the database refuse a statement because 0218 is not on it? The column
 * (`no such column: price_estimate`, aliased or not) or one of its tables
 * (`no such table: price_estimate_firm_skus`, `order_price_estimates`,
 * `product_price_estimates`, `price_estimate_*`, `supplier_price_*`).
 */
export function isMissingEstimateSchema(e: unknown): boolean {
  const msg = String((e as { message?: unknown } | null)?.message ?? e);
  return /no such (?:table|column):?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:price_estimate\w*|product_price_estimates|order_price_estimates|supplier_price_\w+)\b/i.test(
    msg
  );
}

const INSTALLED = new WeakSet<object>();

/**
 * Is migration 0218 on this database? The owner's estimate and supplier-price
 * routes answer 503 PRICE_ESTIMATES_NOT_INSTALLED while it is not (§2.4). One
 * statement per binding until it answers yes, none after (a migration lands,
 * it never un-lands — the shape of engineInstalled.ts); a "no", or a failed
 * read, is asked again on the next call. It reads the owner's control row,
 * which the migration seeds with its table.
 */
export async function priceEstimatesInstalled(db: Pick<D1Database, 'prepare'>): Promise<boolean> {
  if (INSTALLED.has(db)) return true;
  try {
    const row = await db.prepare('SELECT id FROM price_estimate_control WHERE id = 1').first<{ id: number }>();
    if (!row) return false;
    INSTALLED.add(db);
    return true;
  } catch {
    return false;
  }
}

/** How long a binding that answered "absent" is believed: then asked again (the migration may have landed). */
export const ESTIMATE_ABSENT_RECHECK_MS = 60_000;

const ABSENT_UNTIL = new WeakMap<object, number>();

/** This database refused 0218's column or tables within the last minute: build today's SQL. */
export function estimateAbsentLately(db: object): boolean {
  return (ABSENT_UNTIL.get(db) ?? 0) > Date.now();
}

/** Remember, for this binding, that 0218 is not on it (after `isMissingEstimateSchema`). */
export function rememberEstimateAbsent(db: object): void {
  if (db !== null && typeof db === 'object') ABSENT_UNTIL.set(db, Date.now() + ESTIMATE_ABSENT_RECHECK_MS);
}

/** `estimateClause(alias)`, or '' while this binding answered "absent" lately (asks nothing first). */
export function estimateClauseFor(db: object, alias: string): string {
  const clause = estimateClause(alias);
  return estimateAbsentLately(db) ? '' : clause;
}

/**
 * Runs `sql` (built with `estimateClause`) through `exec`. While the binding
 * is known to lack 0218 the clause is left out up front; otherwise a refusal
 * for the missing column or table runs the statement once more without it and
 * remembers the absence. A statement without the clause is run as given, and
 * every other error is thrown.
 */
export async function runWithEstimateClause<T>(db: object, sql: string, exec: (sql: string) => Promise<T>): Promise<T> {
  const bare = withoutEstimateClause(sql);
  if (bare !== sql && estimateAbsentLately(db)) return exec(bare);
  try {
    return await exec(sql);
  } catch (err) {
    if (bare === sql || !isMissingEstimateSchema(err)) throw err;
    rememberEstimateAbsent(db);
    return exec(bare);
  }
}
