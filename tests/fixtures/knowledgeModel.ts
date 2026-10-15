/**
 * ONE ROW OF THE KNOWLEDGE MODEL (0194 `product_spec_values`), for tests.
 *
 * The defaults are a verified fact read off the store page, public, product
 * scope, region-free, with the registry's group, data type and unit for the
 * key. `over` replaces any column; the CHECKs of 0194 still decide what a
 * status may carry (a `not_found` row names its checked sources, a
 * `not_published` row is curated, a US row is never verified).
 */
import type { DatabaseSync } from 'node:sqlite';
import { specKey } from '../../packages/catalog/src/bambuImport/registry/specKeys';

export function insertSpecValue(raw: DatabaseSync, productId: string, key: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: `sv_${productId}_${key}_${String(over.scope_id ?? '')}_${String(over.region ?? '')}_${String(over.visibility ?? '')}`,
    product_id: productId,
    canonical_key: key,
    group_key: specKey(key)?.group ?? 'other',
    scope_kind: 'product',
    scope_id: '',
    region: '',
    data_type: specKey(key)?.type ?? 'string',
    original_label: '',
    original_value: '',
    value_text: '',
    value_num: null,
    value_num_max: null,
    value_bool: null,
    value_list: '[]',
    unit: specKey(key)?.unit ?? '',
    status: 'verified',
    confidence: 'official_page',
    source_kind: 'store_page',
    source_ref: 'https://us.store.bambulab.com/products/fixture',
    source_title: 'Store page',
    source_locator: 'Specifications › row 1',
    source_excerpt: '',
    test_method: '',
    test_condition: '',
    derived_from: '',
    missing_reason: '',
    checked_sources: '[]',
    visibility: 'public',
    conflict: '',
    sort: 0,
    ...over,
  };
  const cols = Object.keys(row);
  raw
    .prepare(`INSERT INTO product_spec_values (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...(cols.map((c) => row[c]) as never[]));
}

/** A `not_found` row: no value, the sources that were actually read. */
export const notFound = (sources: Array<{ kind: string; url: string; title: string }>): Record<string, unknown> => ({
  status: 'not_found',
  missing_reason: 'not_found_in_checked_sources',
  checked_sources: JSON.stringify(sources),
});

/** A `not_published` row: curated, the manufacturer does not say. */
export const notPublished = (): Record<string, unknown> => ({
  status: 'not_published',
  missing_reason: 'not_published_by_manufacturer',
  source_kind: 'curated',
  confidence: 'independent',
  source_ref: '',
  source_title: '',
});
