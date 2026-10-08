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
 *      not 'inherit' (migration 0178): 'required' → serialized, 'off' → not.
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
 * DEPLOY-AHEAD. The column arrives with migration 0178. Until it has applied,
 * every reader answers "no section policy", which is exactly HEAD behaviour.
 */
import { effectiveDevicePolicy, readOpsWarranty, type EffectiveDevicePolicy } from './warrantyPlans';
import { printerProductIds } from './printerIdentity';

export type CatalogSerialPolicy = 'required' | 'off';

const installed = new WeakMap<object, true>();

/**
 * Has migration 0178 applied? Cached per database binding ONLY when true
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
export function catalogSerialPolicySql(pid: string, parentOf = 'cur.parent_id'): string {
  return policyWalkSql(
    `c.id IN (SELECT pc.catalog_id FROM product_catalogs pc WHERE pc.product_id = ${pid})
          OR c.id = (SELECT sp.category_id FROM products sp WHERE sp.id = ${pid})
          OR c.id = (SELECT sp.sub_category_id FROM products sp WHERE sp.id = ${pid})`,
    parentOf
  );
}

/**
 * The branch walk itself, seeded by `seed` (a WHERE over `catalogs c`).
 * `parentOf` names the parent of the walk's current section (`cur`); only the
 * "what if this section moved" reader (`reparentSerialFlips`) passes another.
 */
function policyWalkSql(seed: string, parentOf = 'cur.parent_id'): string {
  return `(WITH RECURSIVE sp_walk(cid, pol, depth) AS (
      SELECT c.id, c.serial_policy, 0 FROM catalogs c
       WHERE ${seed}
      UNION ALL
      SELECT c2.id, c2.serial_policy, w.depth + 1
        FROM sp_walk w JOIN catalogs cur ON cur.id = w.cid JOIN catalogs c2 ON c2.id = ${parentOf}
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
 * §29 FOR A NON-OWNER'S PRODUCT WRITE — one rule for every door that stores a
 * product: the form (create and update), the ops-policy route, the import
 * sheet and the TXT template (serial review, S1 findings 1, 2 and 4).
 *
 * A non-owner never changes the product's own `serialized` word, and never
 * changes the EFFECTIVE answer (the word, else what the placement resolves
 * to) by another door. `requested` is the word the write would store (null =
 * silent); `placement` the filing it would store (undefined = an update that
 * keeps the stored filing). Refused when either
 *   - the answer as it would be written — the stored word kept — differs from
 *     the answer today ('placement': a re-filing into or out of a printer
 *     catalog or a 'required' / 'off' section), or
 *   - the answer as asked differs from it ('flag').
 * Otherwise `keep` is the stored word, and the caller writes it in place of
 * `requested`: an echo of an inherited answer is NOT written down as the
 * product's own, so the product keeps following its section when the owner
 * changes the section later. A create has no stored word; its baseline is
 * what its placement resolves to.
 */
export interface SerializedWrite {
  prev: { id: string; ops_policy: unknown } | null;
  requested: boolean | null;
  placement?: { catalogIds: readonly string[]; categoryIds: readonly (string | null | undefined)[] };
}

/**
 * Reads shared across many verdicts (an import sheet judges up to 500 rows in
 * one request): `ctx` must cover every `prev.id` judged with it, and a
 * placement is resolved once however many rows name it.
 */
export interface VerdictCache {
  ctx?: SerializationContext;
  placements: Map<string, Promise<boolean>>;
}

export async function serializedWriteVerdict(
  db: D1Database,
  w: SerializedWrite,
  cache?: VerdictCache
): Promise<{ refuse: 'flag' | 'placement' | null; keep: boolean | null }> {
  const stored = w.prev ? readOpsWarranty(w.prev.ops_policy).serialized : null;
  const silentNow = w.prev
    ? lineDevicePolicy('{}', w.prev.id, cache?.ctx ?? (await serializationContext(db, [w.prev.id]))).serialized
    : false;
  let silentAfter = silentNow;
  if (w.placement) {
    const { catalogIds, categoryIds } = w.placement;
    const key = JSON.stringify([[...catalogIds].sort(), [...categoryIds].map((x) => x ?? '').sort()]);
    let answer = cache?.placements.get(key);
    if (!answer) {
      answer = placementSerialized(db, catalogIds, categoryIds);
      cache?.placements.set(key, answer);
    }
    silentAfter = await answer;
  }
  const before = w.prev ? (stored ?? silentNow) : silentAfter;
  if ((stored ?? silentAfter) !== before) return { refuse: 'placement', keep: stored };
  if ((w.requested ?? silentAfter) !== before) return { refuse: 'flag', keep: stored };
  return { refuse: null, keep: stored };
}

/**
 * RE-PARENTING A SECTION is a §29 change too (regressions review #3): every
 * product filed under it whose own word is silent, and that is not a printer,
 * inherits through the new parent from then on. Returns how many of those
 * products would change their answer if `sectionId` moved under
 * `newParentId` — the same walk as `catalogSerialPolicySql`, evaluated with
 * that one parent link replaced. 0 on a shop with no section policy at all
 * (the printer flag is never inherited, so nothing can flip).
 */
export async function reparentSerialFlips(db: D1Database, sectionId: string, newParentId: string | null): Promise<number> {
  if (!(await anySectionSerialPolicy(db))) return 0;
  const { results } = await db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT ?1, 0
         UNION ALL
         SELECT c.id, s.depth + 1 FROM catalogs c JOIN sub s ON c.parent_id = s.id WHERE s.depth < 16)
       SELECT DISTINCT p.id AS pid, p.ops_policy FROM products p
        WHERE p.id IN (SELECT pc.product_id FROM product_catalogs pc WHERE pc.catalog_id IN (SELECT id FROM sub))
           OR p.category_id IN (SELECT id FROM sub)
           OR p.sub_category_id IN (SELECT id FROM sub)`
    )
    .bind(sectionId)
    .all<{ pid: string; ops_policy: string | null }>();
  const filed = (results ?? []).filter((r) => readOpsWarranty(r.ops_policy).serialized === null).map((r) => String(r.pid));
  if (!filed.length) return 0;
  const printers = await printerProductIds(db, filed);
  const silent = filed.filter((id) => !printers.has(id));
  let flips = 0;
  for (let i = 0; i < silent.length; i += 200) {
    const { results: rows } = await db
      .prepare(
        `SELECT ${catalogSerialPolicySql('j.value')} AS before,
                ${catalogSerialPolicySql('j.value', 'CASE WHEN cur.id = ?2 THEN ?3 ELSE cur.parent_id END')} AS after
           FROM json_each(?1) j`
      )
      .bind(JSON.stringify(silent.slice(i, i + 200)), sectionId, newParentId)
      .all<{ before: number | null; after: number | null }>();
    for (const r of rows ?? []) if ((Number(r.before) === 2) !== (Number(r.after) === 2)) flips++;
  }
  return flips;
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
 * false (migration 0178 not applied yet) it is HEAD's rule exactly.
 */
export function serializedProductSql(pid: string, ops: string, withCatalog: boolean): string {
  const ser = `(CASE WHEN json_valid(${ops}) THEN json_extract(${ops}, '$.serialized') END)`;
  const printer = `EXISTS (SELECT 1 FROM product_catalogs spc
                       JOIN catalogs spcc ON spcc.id = spc.catalog_id AND spcc.is_printer_catalog = 1
                      WHERE spc.product_id = ${pid})`;
  const required = withCatalog ? ` OR ${catalogSerialPolicySql(pid)} = 2` : '';
  return `(${ser} = 1 OR (${ser} IS NOT 0 AND (${printer}${required})))`;
}
