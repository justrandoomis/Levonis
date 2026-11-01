/**
 * A PRODUCT'S ESTIMATE TYPE — THE I/O HALF (docs/SMART_PRICING.md §3.8). The
 * pure precedence is packages/catalog/src/supplierPrices/classify.ts
 * (`classifyEstimateType`); this file reads what it decides from:
 *
 *   1. the owner's choice — `product_price_estimates.type_key` when its
 *      `type_source` is 'owner' (an enrolment, or a correction in Review);
 *   2. the category of the product's CONFIRMED Tmall match in the current
 *      complete snapshot (worker/lib/supplierPrices/store.ts
 *      `supplierCategories`) — how a spare part Tmall sells as an electronic
 *      part becomes EU-sourced;
 *   3. the import's type — `catalog_import_items.product_type` of the product's
 *      COMPLETE item (joined on `levonis_product_id`) — with the bundled
 *      reviewed manifest's `subtype` (worker/lib/catalogImport/bundle.ts,
 *      `manifest.bySourceId`): filament with subtype `pack` is
 *      `filament_pack`; a spare part whose English name names an electronic
 *      part is `electronics_part`, and an accessory (registry `tool` too)
 *      whose name does is `electronics_device` (the EU capture's rule);
 *   4. otherwise EST_TYPE_MISSING: no estimate.
 *
 * Only a key the type table holds is ever answered (its FK). Two statements a
 * page, whatever its size. A database without 0195 (no import items) answers
 * no import type; nothing here writes.
 */
import { classifyEstimateType, type ClassifyResult } from '@levonis/catalog/supplierPrices/classify';
import { supplierCategories } from '../../supplierPrices/store';
import { currentReviewedBundle } from '../../catalogImport/bundle';
import type { ProductEstimateRow } from './types';

export type { ClassifyResult };

export interface ClassifySubject {
  id: string;
  /** products.name (English). */
  name: string;
  /** The stored bookkeeping row, when the product has one. */
  estimate: ProductEstimateRow | null;
}

/** The import's type and source id of each product's COMPLETE item (the newest), or none on a database without 0195. */
async function importTypes(db: D1Database, ids: readonly string[]): Promise<Map<string, { type: string; source_product_id: string }>> {
  const out = new Map<string, { type: string; source_product_id: string }>();
  if (!ids.length) return out;
  let rows: Array<{ levonis_product_id: string; product_type: string; source_product_id: string }> = [];
  try {
    rows =
      (
        await db
          .prepare(
            `SELECT levonis_product_id, product_type, source_product_id FROM catalog_import_items
              WHERE levonis_product_id IN (SELECT value FROM json_each(?)) AND processing_state = 'COMPLETE'
              ORDER BY levonis_product_id, completed_at DESC, id`
          )
          .bind(JSON.stringify([...new Set(ids)]))
          .all<{ levonis_product_id: string; product_type: string; source_product_id: string }>()
      ).results ?? [];
  } catch (e) {
    if (!/no such table:?\s*(?:main\.)?catalog_import_items\b/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  for (const r of rows) {
    const id = String(r.levonis_product_id);
    if (!out.has(id)) out.set(id, { type: String(r.product_type ?? ''), source_product_id: String(r.source_product_id ?? '') });
  }
  return out;
}

/** The reviewed manifest's subtype of a source product, when the bundle is available. */
function manifestSubtype(sourceProductId: string): string | null {
  if (!sourceProductId) return null;
  const state = currentReviewedBundle();
  if (!state.ok) return null;
  const row = state.bundle.manifest.bySourceId.get(sourceProductId);
  const subtype = row?.subtype;
  return typeof subtype === 'string' && subtype ? subtype : null;
}

/**
 * Each product's estimate type (§3.8). `known` is the type table's keys. An ESTIMATED product whose
 * sources no longer answer keeps the type it was applied under (its row may not lose its type).
 */
export async function classifyProducts(db: D1Database, subjects: readonly ClassifySubject[], known: readonly string[]): Promise<Map<string, ClassifyResult>> {
  const ids = subjects.map((s) => s.id);
  const [categories, imports] = await Promise.all([supplierCategories(db, ids), importTypes(db, ids)]);
  const out = new Map<string, ClassifyResult>();
  for (const s of subjects) {
    const imported = imports.get(s.id) ?? null;
    const result = classifyEstimateType({
      owner_type: s.estimate?.type_source === 'owner' ? s.estimate.type_key : null,
      supplier_category: categories.get(s.id) ?? null,
      import_type: imported?.type ?? null,
      import_subtype: imported ? manifestSubtype(imported.source_product_id) : null,
      name_en: s.name,
      known_types: known,
    });
    const keep = s.estimate?.state === 'estimated' && !result.type_key && s.estimate.type_key && known.includes(s.estimate.type_key);
    out.set(s.id, keep ? { type_key: s.estimate!.type_key, type_source: s.estimate!.type_source || 'owner', flags: [] } : result);
  }
  return out;
}
