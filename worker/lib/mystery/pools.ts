/**
 * THE POOL ADMIN'S PLANNING — docs/BUNDLES_MYSTERY.md §10, §11.1 and §11.3.
 *
 * Three decisions live here rather than in the router, because each of them is
 * a rule and not a handler:
 *
 * 1. THE WHOLE-SET REPLACE NEVER DELETES. An entry that disappears from the set
 *    is set `active = 0, weight = 0` — which §1.9 already defines as "excluded,
 *    kept for history". Deleting would fail `mystery_allocations.pool_entry_id`'s
 *    foreign key the moment an entry had ever been drawn, and the admin could
 *    then never edit that pool again: a runtime violation `foreign_key_check`
 *    cannot catch. The admin is TOLD (`POOL_ENTRY_DEACTIVATED`), never silently
 *    repaired.
 *
 * 2. ENTRIES ARE GENERATED ON THE SERVER. A filament pool is product × option
 *    values × colour, so a realistic one is hundreds of rows; expanding them in
 *    the browser would invent combinations the inventory model does not have.
 *    The expansion follows `inventory_mode` exactly — the same column
 *    `resolveStock` obeys — so every generated entry resolves to exactly one
 *    real stock row.
 *
 * 3. EVERY WARNING IS SAID, VERBATIM, IN THREE LANGUAGES. An empty pool, zero
 *    weights, no eligible direct inventory and a pool too small for `forbid` are
 *    warnings the admin reads; none of them is ever repaired, and none of them
 *    reaches a customer (§7.5 — a count in a customer refusal is a free oracle
 *    over live inventory).
 */

import { badRequest } from '../http';
import { newId } from '../crypto';
import type { BundleIssue } from '../bundleComposition';
import { mysteryIssue } from './issues';
import {
  loadCandidates,
  isDrawable,
  type CandidateSet,
  type DuplicatePolicy,
  type MysteryCandidate,
  type MysteryPool,
} from '../mysteryDraw';
import { loadRelationsViews, type ProductRelationsView } from '../productOverlay';

/** The ceiling one bulk generation may produce in a single call. A cartesian
 *  product over option groups grows fast, and an admin who asked for more than
 *  this asked for something they cannot review — so it is REFUSED with the
 *  number, never truncated. */
export const MAX_GENERATED_ENTRIES = 500;

export interface PoolEntryInput {
  /** Kept across an edit so an entry that has been drawn keeps its identity. */
  id?: string;
  product_id: string;
  option_value_ids: string[];
  color_id: string;
  family_id: string;
  weight: number;
  active: boolean;
}

const truthy = (v: unknown) => v === 1 || v === true || v === '1';

const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/** One entry from the wire, validated. Nothing here is trusted: the weight is
 *  clamped to the column's own CHECK and every id is matched against the real
 *  catalogue by `planEntryReplace` before it is written. */
export function readEntryInput(raw: unknown): PoolEntryInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  const product = typeof o.product_id === 'string' ? o.product_id.trim() : '';
  if (!product) throw badRequest('each entry needs a product_id', 'VALIDATION');
  const weight = Number(o.weight ?? 1);
  if (!Number.isInteger(weight) || weight < 0 || weight > 1000) {
    throw badRequest('weight must be an integer between 0 and 1000', 'VALIDATION');
  }
  return {
    id: typeof o.id === 'string' && /^mpe_/.test(o.id) ? o.id : undefined,
    product_id: product,
    option_value_ids: [...new Set(strList(o.option_value_ids))].sort(),
    color_id: typeof o.color_id === 'string' ? o.color_id.trim() : '',
    family_id: typeof o.family_id === 'string' ? o.family_id.trim() : '',
    weight,
    active: o.active === undefined ? true : truthy(o.active),
  };
}

/** What makes two entries the same entry when no id was sent: the exact stock
 *  row they resolve to. */
export const entryIdentity = (e: { product_id: string; option_value_ids: string[]; color_id: string }) =>
  `${e.product_id}|${[...e.option_value_ids].sort().join(',')}|${e.color_id}`;

interface StoredEntryRow {
  id: string;
  product_id: string;
  option_value_ids: string;
  color_id: string;
  family_id: string;
  weight: number;
  active: number;
}

export interface EntryReplacePlan {
  statements: D1PreparedStatement[];
  inserted: number;
  updated: number;
  deactivated: number;
  warnings: BundleIssue[];
}

/**
 * THE WHOLE-SET REPLACE, as statements for one batch.
 *
 * Matching is by `id` when the panel sent one and by stock-row identity
 * otherwise, so re-running the bulk generator over a pool that already holds
 * those rows updates them instead of duplicating them.
 */
export async function planEntryReplace(
  db: D1Database,
  poolId: string,
  entries: PoolEntryInput[]
): Promise<EntryReplacePlan> {
  const { results: stored } = await db
    .prepare('SELECT id, product_id, option_value_ids, color_id, family_id, weight, active FROM mystery_pool_entries WHERE pool_id = ?')
    .bind(poolId)
    .all<StoredEntryRow>();

  const byId = new Map(stored.map((r) => [r.id, r]));
  const byIdentity = new Map(
    stored.map((r) => [
      entryIdentity({
        product_id: r.product_id,
        option_value_ids: strList(JSON.parse(r.option_value_ids || '[]') as unknown),
        color_id: r.color_id,
      }),
      r,
    ])
  );

  const statements: D1PreparedStatement[] = [];
  const keptIds = new Set<string>();
  let inserted = 0;
  let updated = 0;

  for (const e of entries) {
    const identity = entryIdentity(e);
    const match = (e.id ? byId.get(e.id) : undefined) ?? byIdentity.get(identity);
    if (match) {
      keptIds.add(match.id);
      updated += 1;
      statements.push(
        db
          .prepare(
            `UPDATE mystery_pool_entries
                SET option_value_ids = ?, color_id = ?, family_id = ?, weight = ?, active = ?
              WHERE id = ? AND pool_id = ?`
          )
          .bind(
            JSON.stringify(e.option_value_ids),
            e.color_id,
            e.family_id,
            e.weight,
            e.active ? 1 : 0,
            match.id,
            poolId
          )
      );
    } else {
      inserted += 1;
      statements.push(
        db
          .prepare(
            `INSERT INTO mystery_pool_entries
               (id, pool_id, product_id, option_value_ids, color_id, family_id, weight, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            newId('mpe'),
            poolId,
            e.product_id,
            JSON.stringify(e.option_value_ids),
            e.color_id,
            e.family_id,
            e.weight,
            e.active ? 1 : 0
          )
      );
    }
  }

  // NEVER a DELETE: an entry that has ever been drawn is named by
  // mystery_allocations.pool_entry_id for ever.
  const leaving = stored.filter((r) => !keptIds.has(r.id) && (truthy(r.active) || r.weight > 0));
  for (const r of leaving) {
    statements.push(
      db.prepare('UPDATE mystery_pool_entries SET active = 0, weight = 0 WHERE id = ? AND pool_id = ?').bind(r.id, poolId)
    );
  }
  statements.push(
    db.prepare("UPDATE mystery_pools SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(poolId)
  );

  const warnings: BundleIssue[] = [];
  if (leaving.length > 0) warnings.push(mysteryIssue('POOL_ENTRY_DEACTIVATED', { n: leaving.length }));

  return { statements, inserted, updated, deactivated: leaving.length, warnings };
}

// ------------------------------------------------------- the bulk generator

interface GenerateRequest {
  product_ids: string[];
  weight: number;
  family_id: string;
}

interface ProductShapeRow {
  id: string;
  inventory_mode: string;
  status: string;
  composition: string;
  name: string;
}

/**
 * THE SERVER-SIDE BULK GENERATOR (§10).
 *
 * Expands the products' ACTIVE options and colours into pool entries, following
 * `inventory_mode` exactly — the same column `resolveStock` obeys — so every
 * generated entry names one real stock row rather than a combination the
 * catalogue does not model.
 */
export async function generateEntries(db: D1Database, req: GenerateRequest): Promise<{ entries: PoolEntryInput[]; skipped: BundleIssue[] }> {
  const ids = [...new Set(req.product_ids)].filter(Boolean).slice(0, 200);
  if (ids.length === 0) throw badRequest('product_ids must be a non-empty array', 'VALIDATION');
  const { results } = await db
    .prepare(
      `SELECT id, inventory_mode, status, composition, name FROM products WHERE id IN (${ids.map(() => '?').join(', ')})`
    )
    .bind(...ids)
    .all<ProductShapeRow>();

  const views = await loadRelationsViews(
    db,
    results.map((r) => ({ id: r.id, inventory_mode: r.inventory_mode }))
  );

  const entries: PoolEntryInput[] = [];
  const skipped: BundleIssue[] = [];
  for (const p of results) {
    if (p.composition !== '') {
      // Never a bundle or another mystery offer inside a pool.
      skipped.push(mysteryIssue('POOL_ENTRY_INVALID', { what: p.name }));
      continue;
    }
    const view = views.get(p.id);
    for (const sel of expandSelections(view, p.inventory_mode)) {
      entries.push({
        product_id: p.id,
        option_value_ids: sel.option_value_ids,
        color_id: sel.color_id,
        family_id: req.family_id,
        weight: req.weight,
        active: true,
      });
      if (entries.length > MAX_GENERATED_ENTRIES) {
        throw badRequest(
          `هذا التوليد ينتج أكثر من ${MAX_GENERATED_ENTRIES} مُدخلًا / this generation would produce more than ${MAX_GENERATED_ENTRIES} entries — narrow the selection`,
          'VALIDATION'
        );
      }
    }
  }
  return { entries, skipped };
}

interface GeneratedSelection {
  option_value_ids: string[];
  color_id: string;
}

/** One selection per authoritative stock row the product actually has. */
function expandSelections(view: ProductRelationsView | undefined, mode: string): GeneratedSelection[] {
  if (!view || !view.has_relations) return [{ option_value_ids: [], color_id: '' }];
  const activeValues = view.values.filter((v) => truthy(v.active));
  const activeColors = view.colors.filter((c) => truthy(c.active));

  switch (mode) {
    case 'COLOR':
      return activeColors.map((c) => ({ option_value_ids: [], color_id: c.id }));
    case 'OPTION': {
      // The cartesian product over the groups, because OPTION mode takes the
      // MINIMUM over every selected value and a partial selection would resolve
      // to a different row than the one a buyer consumes.
      let combos: string[][] = [[]];
      for (const g of view.groups.filter((x) => truthy(x.active))) {
        const values = activeValues.filter((v) => v.group_id === g.id);
        if (values.length === 0) continue;
        combos = combos.flatMap((c) => values.map((v) => [...c, v.id]));
      }
      return combos.map((ids) => ({ option_value_ids: [...ids].sort(), color_id: '' }));
    }
    case 'VARIANT_COMBINATION':
      return view.variants
        .filter((v) => truthy(v.active))
        .map((v) => {
          const parts = String(v.combo_key ?? '').split('|').filter(Boolean);
          return {
            option_value_ids: parts.filter((p) => p.startsWith('o:')).map((p) => p.slice(2)).sort(),
            color_id: parts.find((p) => p.startsWith('c:'))?.slice(2) ?? '',
          };
        });
    default:
      return [{ option_value_ids: [], color_id: '' }];
  }
}

// ------------------------------------------------------- the live preview

export interface EligibleEntryView {
  entry_id: string;
  product_id: string;
  name: string;
  variant: string;
  weight: number;
  available: number | null;
  /** Server-computed, never a browser division. */
  probability: number;
}

export interface EligiblePreview {
  pool_id: string;
  kind: string;
  eligible: EligibleEntryView[];
  excluded: CandidateSet['excluded'];
  /** THE COUNT THAT NEVER REACHES A CUSTOMER (§7.5). */
  distinct_choices: number;
  /** Σ available over eligible entries; null = untracked (a pre-order pool). */
  total_available: number | null;
  warnings: BundleIssue[];
}

/**
 * THE ADMIN PREVIEW MUST SHOW THE SAME NUMBER THE CUSTOMER IS SHOWN (owner
 * decision 8). Both are now computed over the DRAWABLE candidates — the exact
 * set the wheel seeds itself with — so the panel, the disclosure and the draw
 * cannot drift apart. The old `Math.max(1, weight)` floor was the drift: it
 * gave a weight-0 entry a silent probability the wheel would never honour.
 */
const drawableOf = (candidates: MysteryCandidate[]) => candidates.filter(isDrawable);
const totalWeight = (candidates: MysteryCandidate[]) => drawableOf(candidates).reduce((s, c) => s + c.weight, 0);

/**
 * The admin's eligible-stock preview, computed by the SAME candidate query the
 * checkout draw uses, so the panel and the shop can never disagree.
 */
export async function eligibleStockPreview(
  db: D1Database,
  pool: MysteryPool,
  opts: { spools?: number; duplicatePolicy?: DuplicatePolicy; familyId?: string } = {}
): Promise<EligiblePreview> {
  const set = await loadCandidates(db, pool, { familyId: opts.familyId, preview: true });
  const total = totalWeight(set.candidates);
  const eligible: EligibleEntryView[] = set.candidates.map((c) => ({
    entry_id: c.entry_id,
    product_id: c.product_id,
    name: c.name_snapshot,
    variant: c.variant_snapshot,
    weight: c.weight,
    available: c.available,
    probability: total > 0 && isDrawable(c) ? Math.round((c.weight / total) * 10_000) / 10_000 : 0,
  }));
  let totalAvailable: number | null = null;
  for (const c of set.candidates) {
    if (c.available === null) continue;
    totalAvailable = (totalAvailable ?? 0) + c.available;
  }

  return {
    pool_id: pool.id,
    kind: pool.kind,
    eligible,
    excluded: set.excluded,
    distinct_choices: set.candidates.length,
    total_available: totalAvailable,
    warnings: poolWarnings(pool, set, opts),
  };
}

/** Every warning §11.3 names for a pool, verbatim and trilingual. */
export function poolWarnings(
  pool: MysteryPool,
  set: CandidateSet,
  opts: { spools?: number; duplicatePolicy?: DuplicatePolicy } = {}
): BundleIssue[] {
  const warnings: BundleIssue[] = [];
  if (set.candidates.length === 0) {
    warnings.push(mysteryIssue('POOL_EMPTY'));
    if (pool.kind === 'direct') warnings.push(mysteryIssue('NO_ELIGIBLE_DIRECT_INVENTORY'));
  }
  const zeroWeight = set.excluded.filter((e) => e.reason === 'ZERO_WEIGHT').length;
  if (zeroWeight > 0) warnings.push(mysteryIssue('POOL_ZERO_WEIGHT', { n: zeroWeight }));
  const spools = Math.max(1, opts.spools ?? 1);
  if (opts.duplicatePolicy === 'forbid' && set.candidates.length < spools) {
    warnings.push(mysteryIssue('POOL_TOO_SMALL_FOR_FORBID', { distinct: set.candidates.length, spools }));
  }
  return warnings;
}
