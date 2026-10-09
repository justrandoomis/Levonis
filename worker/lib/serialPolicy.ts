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
import { effectiveDevicePolicy, mergeOpsPolicy, readOpsWarranty, type EffectiveDevicePolicy } from './warrantyPlans';
import { printerProductIds } from './printerIdentity';
import { fence } from './operations';

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
 * "what if this section moved" reader (`catalogSerialPolicies` with a `move`,
 * for `catalogEditSerialFlips`) passes another.
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
 * §29 FOR THE TWO COMPOSITION EDITORS (landing round 3, F7): the bundles
 * panel and the mystery-offer panel store a product row through
 * `validateProductDoc` / `planProductSave` like the form, and took
 * `serialized`, `ops_policy`, `catalog_ids` and `category_id` from any admin.
 * The same `serializedWriteVerdict`, judged on what the save will actually
 * write:
 *   - the word: a body that says nothing about `serialized` (the panels
 *     never send it) is no attempt — the stored word is kept, never wiped —
 *     and one that does is judged like the form's;
 *   - the filing: `catalog_ids` when this editor writes them
 *     (`writesCatalogs`), else the stored shelves, with the classification
 *     the document carries.
 * Returns the refusal (`flag` / `placement`) or null; on null the document
 * carries the word to store (the stored one for an echo, as on every door).
 */
export async function compositionSerializedVerdict(
  db: D1Database,
  doc: { serialized: boolean | null; ops_policy: Record<string, unknown>; category_id: string | null; sub_category_id: string | null },
  prev: { id: string; ops_policy: unknown; category_id: string | null; sub_category_id: string | null } | null,
  body: Record<string, unknown>,
  opts: { writesCatalogs: boolean }
): Promise<'flag' | 'placement' | null> {
  const bodyOps =
    body.ops_policy && typeof body.ops_policy === 'object' && !Array.isArray(body.ops_policy)
      ? (body.ops_policy as Record<string, unknown>)
      : null;
  const mentions = 'serialized' in body || (bodyOps !== null && 'serialized' in bodyOps);
  const stored = prev ? readOpsWarranty(prev.ops_policy).serialized : null;
  const requested = mentions ? readOpsWarranty(mergeOpsPolicy(doc.ops_policy ?? {}, { serialized: doc.serialized })).serialized : stored;
  const sent =
    opts.writesCatalogs && Array.isArray(body.catalog_ids)
      ? (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : null;
  const refiled = !prev || (doc.category_id ?? null) !== (prev.category_id ?? null) || (doc.sub_category_id ?? null) !== (prev.sub_category_id ?? null);
  let catalogIds = sent;
  if (!catalogIds && refiled && prev) {
    const { results } = await db
      .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ?')
      .bind(prev.id)
      .all<{ catalog_id: string }>();
    catalogIds = (results ?? []).map((r) => String(r.catalog_id));
  }
  const verdict = await serializedWriteVerdict(db, {
    prev: prev ? { id: prev.id, ops_policy: prev.ops_policy } : null,
    requested,
    placement: sent || refiled ? { catalogIds: catalogIds ?? [], categoryIds: [doc.category_id, doc.sub_category_id] } : undefined,
  });
  if (verdict.refuse) return verdict.refuse;
  doc.serialized = verdict.keep;
  const ops: Record<string, unknown> = { ...(doc.ops_policy ?? {}) };
  if (verdict.keep === null) delete ops.serialized;
  else ops.serialized = verdict.keep;
  doc.ops_policy = ops;
  return null;
}

/**
 * ONE CATALOG EDIT, AS THE TWO CATALOG EDITORS JUDGE IT (landing round 4,
 * R1): only the keys that CHANGE. `flag` is the new `is_printer_catalog`,
 * `parentId` the new parent (null = the root). A request that changes both is
 * ONE edit: judging each change against the current value of the other let a
 * non-owner switch a printer catalog off and move it out of a 'required'
 * branch in the same request — each half flipped nothing on its own.
 */
export interface CatalogEdit {
  flag?: boolean;
  parentId?: string | null;
}

export const isCatalogEdit = (edit: CatalogEdit): boolean => edit.flag !== undefined || edit.parentId !== undefined;

/**
 * The products filed under catalog `key` (an SQL expression), by placement
 * (`product_catalogs`) or by their own classification (`category_id` /
 * `sub_category_id`, which every save folds into its placements) — with
 * `subtree`, under any section below it as well. Spliced into a WHERE over
 * `products p`.
 */
function filedUnderSql(key: string, subtree: boolean): string {
  const under = subtree
    ? `(WITH RECURSIVE sub(id, depth) AS (
          SELECT ${key}, 0
          UNION ALL
          SELECT c.id, s.depth + 1 FROM catalogs c JOIN sub s ON c.parent_id = s.id WHERE s.depth < 16)
        SELECT id FROM sub)`
    : `(SELECT ${key})`;
  return `(p.id IN (SELECT pc.product_id FROM product_catalogs pc WHERE pc.catalog_id IN ${under})
           OR p.category_id IN ${under} OR p.sub_category_id IN ${under})`;
}

/** Among `ids`, the products that are printers through a printer catalog OTHER than `catalogId`. */
async function printersElsewhere(db: D1Database, catalogId: string, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT pc.product_id FROM product_catalogs pc
           JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
          WHERE pc.catalog_id <> ?1 AND pc.product_id IN (SELECT value FROM json_each(?2))`
      )
      .bind(catalogId, JSON.stringify(ids.slice(i, i + 200)))
      .all<{ product_id: string }>();
    for (const r of results ?? []) out.add(String(r.product_id));
  }
  return out;
}

/**
 * §29 FOR A CATALOG EDIT — how many products would change their EFFECTIVE
 * answer if `edit` were applied to `catalogId` as a whole (landing round 4,
 * R1; the one function both catalog editors call). Every affected product is
 * resolved twice by the one resolver, `lineDevicePolicy`: once under today's
 * context (`serializationContext`) and once under the same context with BOTH
 * changes applied together —
 *   - the printer flag: a product filed directly under the catalog (by
 *     placement or by its section) becomes a printer when the flag turns on,
 *     and stays one when it turns off only through ANOTHER printer catalog.
 *     The flag is not inherited down the tree, so only those are touched;
 *   - the parent: every product filed under the catalog or a section below it
 *     resolves its section policy through the new parent
 *     (`catalogSerialPolicies` with that one link replaced). A shop with no
 *     section policy at all cannot flip by a move.
 * A product with its own `serialized` word keeps it wherever it is filed and
 * is never counted. An edit of one key gives exactly what round 3 gave for it
 * (`printerFlagSerialFlips` / `reparentSerialFlips` below are those calls).
 */
export async function catalogEditSerialFlips(db: D1Database, catalogId: string, edit: CatalogEdit): Promise<number> {
  const flag = edit.flag !== undefined;
  const move = edit.parentId !== undefined && (await anySectionSerialPolicy(db));
  if (!flag && !move) return 0;
  const { results } = await db
    .prepare(
      `SELECT p.id AS pid, p.ops_policy, ${filedUnderSql('?1', false)} AS direct
         FROM products p WHERE ${filedUnderSql('?1', move)}`
    )
    .bind(catalogId)
    .all<{ pid: string; ops_policy: string | null; direct: number }>();
  const silent = (results ?? []).filter((r) => readOpsWarranty(r.ops_policy).serialized === null);
  if (!silent.length) return 0;
  const ids = silent.map((r) => String(r.pid));
  const before = await serializationContext(db, ids);
  const after: SerializationContext = { printers: new Set(before.printers), catalog: before.catalog };
  if (flag) {
    const direct = silent.filter((r) => Number(r.direct) === 1).map((r) => String(r.pid));
    const elsewhere = await printersElsewhere(db, catalogId, direct);
    for (const id of direct) {
      if (edit.flag || elsewhere.has(id)) after.printers.add(id);
      else after.printers.delete(id);
    }
  }
  if (move) after.catalog = await catalogSerialPolicies(db, ids, { sectionId: catalogId, parentId: edit.parentId ?? null });
  let flips = 0;
  for (const id of ids) {
    if (lineDevicePolicy('{}', id, before).serialized !== lineDevicePolicy('{}', id, after).serialized) flips++;
  }
  return flips;
}

/** The OWNER_ONLY details of a refused catalog edit: which keys, and how many products flip. */
export function catalogEditRefusal(edit: CatalogEdit, flips: number): Record<string, unknown> {
  if (edit.flag !== undefined && edit.parentId !== undefined) {
    return { field: 'is_printer_catalog', fields: ['is_printer_catalog', 'parent_id'], via: 'printer_flag_and_reparent', products: flips };
  }
  if (edit.flag !== undefined) return { field: 'is_printer_catalog', via: 'printer_flag', products: flips };
  return { field: 'parent_id', via: 'reparent', products: flips };
}

/**
 * RE-PARENTING A SECTION alone (regressions review #3): how many products
 * filed under it, or under a section below it, would change their answer if
 * `sectionId` moved under `newParentId`. 0 on a shop with no section policy
 * at all (the printer flag is never inherited, so nothing can flip).
 */
export function reparentSerialFlips(db: D1Database, sectionId: string, newParentId: string | null): Promise<number> {
  return catalogEditSerialFlips(db, sectionId, { parentId: newParentId });
}

/**
 * THE PRINTER FLAG alone (landing review round 3, F1): how many products filed
 * under `catalogId` would change their EFFECTIVE answer if its
 * `is_printer_catalog` became `nextFlag`. An empty catalog, or one whose
 * products all carry their own word, flips nothing (0). The caller compares
 * the flag first: an echo is not asked.
 */
export function printerFlagSerialFlips(db: D1Database, catalogId: string, nextFlag: boolean): Promise<number> {
  return catalogEditSerialFlips(db, catalogId, { flag: nextFlag });
}

/**
 * WHERE A WRITE CAN MOVE THE SERIAL ANSWER: one product (a product door
 * re-files it, or rewrites its ops_policy), or the products filed under a
 * catalog — under its whole subtree when the edit moves it (the printer flag
 * reaches only the catalog's own products).
 */
export type AnswerScope = { productId: string } | { catalogId: string; subtree: boolean };

export const catalogEditScope = (catalogId: string, edit: CatalogEdit): AnswerScope => ({
  catalogId,
  subtree: edit.parentId !== undefined,
});

export interface SerialAnswerFence {
  /** `stmts` with the fence in front of them and behind them, for ONE batch. */
  around(stmts: D1PreparedStatement[]): D1PreparedStatement[];
}

/**
 * THE ANSWER FENCE (landing round 4, R2) — a non-owner's write may never
 * change a product's effective answer, and the verdict that said so was
 * reached on reads that can be stale by the time the write lands: a placement
 * into an empty catalog and that catalog's printer flag, each judged before
 * the other committed, together flipped a product though each alone flipped
 * nothing. So a non-owner's write re-asserts the invariant INSIDE its own
 * batch.
 *
 * WHAT IS FENCED: the set of products in `scope` whose effective answer is
 * "needs a serial", resolved by the resolver's SQL twin
 * (`serializedProductSql`, the very predicate the delivered-units sweep runs).
 * It is read here, and the batch re-checks it twice — before the write's
 * statements and after them: the set must still be the one read (same size,
 * every member read still in it).
 *
 * WHY THAT IS SUFFICIENT, whatever ran in between: a D1 batch is one
 * transaction, so the two checks see the database just before and just after
 * this write and nothing else. The write does not change who is in scope (a
 * catalog edit moves no product; a product door's scope is that product), so
 * equal sets on both sides mean no product in scope changed its answer, and a
 * product outside it cannot: the printer flag reaches only the catalog's own
 * products, a move only the walks that start in its subtree, a placement only
 * its own product. It does not depend on which reads the verdict made, so no
 * input the verdict happened to read needs a fence of its own — a placement,
 * a flag, a section policy, a parent link or the owner's word changed in
 * between all show up as a different set. The verdict stays the early,
 * readable 403; the fence is the guarantee. A lost race aborts the whole
 * batch (`ops_guards.ok` is CHECK(ok = 1), `isLostRace`), and the door
 * answers 409 SERIAL_FILING_CHANGED.
 *
 * ONE EXCEPTION AFTER A PRODUCT WRITE: a product that leaves the write
 * carrying its OWN `serialized` word passes the second check. Its answer is
 * then that word, which no placement, flag, policy or parent can move; and the
 * word is one the write was allowed to store — the
 * stored word the verdict kept (unchanged since the read: the first check
 * holds the answer it gave), or the one pre-existing door that writes a word,
 * a used / open-box / refurbished grade on a PRINTER with none
 * (`printerWarrantyRules`, docs/SERIAL_SCAN.md §29) — a printer already
 * answers «needs a serial», so the word it writes changes no answer; since
 * owner decision 4 (2026-10-09) a graded non-printer gets no word at all. The word itself is NOT fenced: a door that copied
 * `ops_policy` from its first read can write the owner's previous word back
 * if the owner changes it in that same moment (docs/SERIAL_SCAN.md, Known
 * limits — same-moment saves).
 *
 * Non-owners only: the owner's writes carry no fence. Before migration 0178
 * the twin has no section layer to read (`withCatalog` false), exactly HEAD's
 * rule.
 */
export async function serialAnswerFence(db: D1Database, scope: AnswerScope): Promise<SerialAnswerFence> {
  const withCatalog = await serialAssignmentsInstalled(db);
  const key = 'productId' in scope ? scope.productId : scope.catalogId;
  const where = (k: string) => ('productId' in scope ? `p.id = ${k}` : filedUnderSql(k, scope.subtree));
  const answer = serializedProductSql('p.id', 'p.ops_policy', withCatalog);
  const { results } = await db
    .prepare(`SELECT p.id AS id FROM products p WHERE ${where('?1')} AND ${answer}`)
    .bind(key)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => String(r.id));
  // `fence` binds its guard id as ?1, so the condition's own arguments start at ?2.
  const count = (extra: string) => `(SELECT COUNT(*) FROM products p WHERE ${where('?2')} AND ${answer}${extra})`;
  const unchanged = `${count('')} = ?4 AND ${count(' AND p.id IN (SELECT value FROM json_each(?3))')} = ?4`;
  const after =
    'productId' in scope
      ? `(EXISTS (SELECT 1 FROM products p WHERE p.id = ?2 AND ${serializedWordSql('p.ops_policy')} IN (0, 1)) OR (${unchanged}))`
      : unchanged;
  const args = [key, JSON.stringify(ids), ids.length];
  return { around: (stmts) => [...fence(db, unchanged, args), ...stmts, ...fence(db, after, args)] };
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

/**
 * The resolved section policy of every product in `productIds` that has one.
 * `move` answers "what if `sectionId` hung under `parentId`" — the same walk
 * with that one parent link replaced (`catalogEditSerialFlips`).
 */
export async function catalogSerialPolicies(
  db: D1Database,
  productIds: Iterable<string>,
  move?: { sectionId: string; parentId: string | null }
): Promise<Map<string, CatalogSerialPolicy>> {
  const ids = [...new Set([...productIds].filter((id) => typeof id === 'string' && id !== ''))];
  const out = new Map<string, CatalogSerialPolicy>();
  if (!ids.length || !(await anySectionSerialPolicy(db))) return out;
  const parentOf = move ? 'CASE WHEN cur.id = ?2 THEN ?3 ELSE cur.parent_id END' : undefined;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = JSON.stringify(ids.slice(i, i + 200));
    const stmt = db.prepare(`SELECT j.value AS pid, ${catalogSerialPolicySql('j.value', parentOf)} AS pol FROM json_each(?1) j`);
    const { results } = await (move ? stmt.bind(chunk, move.sectionId, move.parentId) : stmt.bind(chunk)).all<{
      pid: string;
      pol: number | null;
    }>();
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

/** The product's own `serialized` word in SQL: 1, 0, or NULL (silent). */
const serializedWordSql = (ops: string) => `(CASE WHEN json_valid(${ops}) THEN json_extract(${ops}, '$.serialized') END)`;

/**
 * The SQL twin of `lineDevicePolicy(...).serialized`, for a WHERE clause.
 * `pid` names the product id, `ops` the ops_policy text. With `withCatalog`
 * false (migration 0178 not applied yet) it is HEAD's rule exactly.
 */
export function serializedProductSql(pid: string, ops: string, withCatalog: boolean): string {
  const ser = serializedWordSql(ops);
  const printer = `EXISTS (SELECT 1 FROM product_catalogs spc
                       JOIN catalogs spcc ON spcc.id = spc.catalog_id AND spcc.is_printer_catalog = 1
                      WHERE spc.product_id = ${pid})`;
  const required = withCatalog ? ` OR ${catalogSerialPolicySql(pid)} = 2` : '';
  return `(${ser} = 1 OR (${ser} IS NOT 0 AND (${printer}${required})))`;
}
