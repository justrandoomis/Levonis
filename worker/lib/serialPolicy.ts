/**
 * WHICH PRODUCTS NEED A SERIAL — brief §29 «requires_serial_number», resolved
 * AT READ TIME, the way the printer flag is (worker/lib/printerIdentity.ts).
 *
 * ONE FLAG, NOT TWO. "Requires a serial at preparation" means exactly what the
 * effective `serialized` already means to delivery (deviceOps
 * `createUnitsOnDelivery`): a serial scanned at preparation has to land on a
 * warranty unit at delivery, so the two can never disagree. The resolution:
 *
 *   1. the product's own `ops_policy.serialized` (true / false) — the owner's
 *      explicit word about THIS product always wins;
 *   2. a printer (catalogs.is_printer_catalog) — serialized, the existing
 *      default; a section can never switch a printer off (a printer that sells
 *      an extended plan must record it on a unit);
 *   3. the nearest section on the product's branch whose `serial_policy` is
 *      not 'inherit' (migration 0177): 'required' → serialized, 'off' → not.
 *      Branches are walked leaf → root over every placement
 *      (`product_catalogs`) and the product's own classification
 *      (`category_id` / `sub_category_id`); across branches 'required' wins;
 *   4. otherwise not serialized (accessories).
 *
 * NOTHING IS WRITTEN ONTO PRODUCTS (critique-1 #22): a product re-filed
 * through the form, an import or a taxonomy edit reads the new answer at once
 * and can never drift. AMS products are not inferred from their names — the
 * owner sets 'required' on the section that holds them (owner default).
 *
 * DEPLOY-AHEAD. The column arrives with migration 0177. Until it has applied,
 * every reader answers "no section policy", which is exactly HEAD behaviour.
 */
import { effectiveDevicePolicy, readOpsWarranty, type EffectiveDevicePolicy } from './warrantyPlans';
import { printerProductIds } from './printerIdentity';

export type CatalogSerialPolicy = 'required' | 'off';

const installed = new WeakMap<object, true>();

/**
 * Has migration 0177 applied? Cached per database binding ONLY when true
 * (critique-1 #29): a cached `false` would keep answering 503 after the
 * migration landed under a live isolate.
 */
export async function serialAssignmentsInstalled(db: D1Database): Promise<boolean> {
  if (installed.has(db as object)) return true;
  try {
    const row = await db
      .prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='serial_assignments'")
      .first<{ yes: number }>();
    if (row) installed.set(db as object, true);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * The resolved section policy of ONE product as a SQL scalar: 2 = required,
 * 1 = off, NULL = no section says anything. `pid` is an SQL expression naming
 * the product id (a column, or `j.value` from json_each). THE ONE DEFINITION:
 * the batched reader below and the delivered-units sweep's SQL twin
 * (`serializedProductSql`) both splice this text, so they cannot disagree.
 */
export function catalogSerialPolicySql(pid: string): string {
  return policyWalkSql(
    `c.id IN (SELECT pc.catalog_id FROM product_catalogs pc WHERE pc.product_id = ${pid})
          OR c.id = (SELECT sp.category_id FROM products sp WHERE sp.id = ${pid})
          OR c.id = (SELECT sp.sub_category_id FROM products sp WHERE sp.id = ${pid})`
  );
}

/** The branch walk itself, seeded by `seed` (a WHERE over `catalogs c`). */
function policyWalkSql(seed: string): string {
  return `(WITH RECURSIVE sp_walk(cid, pol, depth) AS (
      SELECT c.id, c.serial_policy, 0 FROM catalogs c
       WHERE ${seed}
      UNION ALL
      SELECT c2.id, c2.serial_policy, w.depth + 1
        FROM sp_walk w JOIN catalogs cur ON cur.id = w.cid JOIN catalogs c2 ON c2.id = cur.parent_id
       WHERE w.pol = 'inherit' AND w.depth < 16)
    SELECT MAX(CASE pol WHEN 'required' THEN 2 WHEN 'off' THEN 1 END) FROM sp_walk WHERE pol <> 'inherit')`;
}

/**
 * What a product whose own `serialized` word is SILENT would resolve to if it
 * were filed under `catalogIds` (its `product_catalogs`) with `categoryIds`
 * (`category_id` / `sub_category_id`) — the same rule as `lineDevicePolicy`,
 * evaluated for a placement that is not stored yet. The product save and the
 * placement route use it so that re-filing a product into or out of a printer
 * catalog or a 'required' section — which changes whether its units need a
 * serial — is the owner's call like the flag itself (critique-1 #23).
 */
export async function placementSerialized(db: D1Database, catalogIds: readonly string[], categoryIds: readonly (string | null | undefined)[]): Promise<boolean> {
  // The classification IS a placement: the save folds category_id /
  // sub_category_id into product_catalogs (`withClassificationPlacements`),
  // and the printer rules read them too (`applyPrinterWarrantyRules`). So the
  // printer test runs over both (regressions review #3) — a non-owner filing a
  // filament under the printer section by its category alone is a change.
  const all = [
    ...new Set([
      ...catalogIds.filter((id) => typeof id === 'string' && id !== ''),
      ...categoryIds.filter((id): id is string => typeof id === 'string' && id !== ''),
    ]),
  ];
  if (!all.length) return false;
  const printer = await db
    .prepare('SELECT 1 AS x FROM catalogs WHERE is_printer_catalog = 1 AND id IN (SELECT value FROM json_each(?)) LIMIT 1')
    .bind(JSON.stringify(all))
    .first();
  if (printer) return true;
  if (!(await anySectionSerialPolicy(db))) return false;
  const row = await db
    .prepare(`SELECT ${policyWalkSql('c.id IN (SELECT value FROM json_each(?1))')} AS pol`)
    .bind(JSON.stringify(all))
    .first<{ pol: number | null }>();
  return Number(row?.pol) === 2;
}

/**
 * Does ANY section carry a serial policy? Until the owner sets one, every
 * reader skips the branch walk entirely — the per-line cost of this layer is
 * zero on a shop that does not use it (the delivered-units sweep runs every
 * cron tick over every delivered order).
 */
export async function anySectionSerialPolicy(db: D1Database): Promise<boolean> {
  if (!(await serialAssignmentsInstalled(db))) return false;
  try {
    return !!(await db.prepare("SELECT 1 AS x FROM catalogs WHERE serial_policy <> 'inherit' LIMIT 1").first());
  } catch {
    return false;
  }
}

/** The resolved section policy of every product in `productIds` that has one. */
export async function catalogSerialPolicies(db: D1Database, productIds: Iterable<string>): Promise<Map<string, CatalogSerialPolicy>> {
  const ids = [...new Set([...productIds].filter((id) => typeof id === 'string' && id !== ''))];
  const out = new Map<string, CatalogSerialPolicy>();
  if (!ids.length || !(await anySectionSerialPolicy(db))) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const { results } = await db
      .prepare(`SELECT j.value AS pid, ${catalogSerialPolicySql('j.value')} AS pol FROM json_each(?) j`)
      .bind(JSON.stringify(ids.slice(i, i + 200)))
      .all<{ pid: string; pol: number | null }>();
    for (const r of results ?? []) {
      if (Number(r.pol) === 2) out.set(String(r.pid), 'required');
      else if (Number(r.pol) === 1) out.set(String(r.pid), 'off');
    }
  }
  return out;
}

export interface SerializationContext {
  printers: Set<string>;
  catalog: Map<string, CatalogSerialPolicy>;
}

/** Everything the per-line rule needs for a set of products — two batched reads. */
export async function serializationContext(db: D1Database, productIds: Iterable<string>): Promise<SerializationContext> {
  const ids = [...productIds].filter((id) => typeof id === 'string' && id !== '');
  const [printers, catalog] = await Promise.all([printerProductIds(db, ids), catalogSerialPolicies(db, ids)]);
  return { printers, catalog };
}

/**
 * The effective device policy of one line's product under the context above:
 * `effectiveDevicePolicy` (packages/pricing, unchanged) plus the section
 * layer, which only ever decides a NON-printer whose own ops_policy is silent.
 */
export function lineDevicePolicy(opsPolicy: unknown, productId: string | null | undefined, ctx: SerializationContext): EffectiveDevicePolicy {
  const pid = productId ? String(productId) : '';
  const isPrinter = pid !== '' && ctx.printers.has(pid);
  const base = effectiveDevicePolicy(opsPolicy, isPrinter);
  if (isPrinter || !pid || readOpsWarranty(opsPolicy).serialized !== null) return base;
  return { ...base, serialized: ctx.catalog.get(pid) === 'required' };
}

/**
 * The SQL twin of `lineDevicePolicy(...).serialized`, for a WHERE clause.
 * `pid` names the product id, `ops` the ops_policy text. With `withCatalog`
 * false (migration 0177 not applied yet) it is HEAD's rule exactly.
 */
export function serializedProductSql(pid: string, ops: string, withCatalog: boolean): string {
  const ser = `(CASE WHEN json_valid(${ops}) THEN json_extract(${ops}, '$.serialized') END)`;
  const printer = `EXISTS (SELECT 1 FROM product_catalogs spc
                       JOIN catalogs spcc ON spcc.id = spc.catalog_id AND spcc.is_printer_catalog = 1
                      WHERE spc.product_id = ${pid})`;
  const required = withCatalog ? ` OR ${catalogSerialPolicySql(pid)} = 2` : '';
  return `(${ser} = 1 OR (${ser} IS NOT 0 AND (${printer}${required})))`;
}
