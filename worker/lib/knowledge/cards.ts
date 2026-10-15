/**
 * THE CARD'S KNOWLEDGE LINE (the Bambu import spec §G.5 «Cards»; the brief's
 * §9: a card names its section and two to four real key properties).
 *
 *   section_name {ar, en, ckb}  the section the product is filed in
 *                               (`sub_category_id`, else `category_id`), from
 *                               the taxonomy the listing routes already hold
 *                               (worker/lib/catalogPresentation.ts
 *                               `catalogIndexFor`, memoised per isolate)
 *   key_specs    string[]       ≤ 4 values of ≤ 40 characters, read from the
 *                               row's `spec_fields` — the mirrors the import
 *                               writes — for the registry keys flagged
 *                               `cardKeyFor` the product's type
 *
 * NO NEW QUERY (tests/d1Waves.test.ts): `spec_fields` is on the row the card was
 * built from and the taxonomy is already in memory. Both are absent rather than
 * empty when there is nothing to say, so a card with neither is byte-identical
 * to before.
 *
 * Values are the shop's language-neutral spec text, read and formatted by the
 * compare engine's own parser (`readCompareValue`): «256 × 256 × 256 mm»,
 * «1.75 mm», «1,000 g». A value too long for a card line is left out, never cut
 * — a truncated fact is a different fact.
 */
import { SPEC_KEYS, type SpecKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import type { ProductType } from '@levonis/catalog/bambuImport/registry/types';
import { allTemplateGroups, type ProductTypeId, type TemplateField } from '../templateFamilies';
import { readCompareValue } from '../compareSpecs';
import { productTypeOf, type CatalogIndex } from '../catalogPresentation';
import type { Tri } from './labels';

export const KEY_SPECS_MAX = 4;
export const KEY_SPEC_MAX_CHARS = 40;

/**
 * The import's product types each storefront type covers. The storefront knows
 * a product's type from its section (worker/lib/templateFamilies.ts
 * PRODUCT_TYPES); the registry flags card keys by the import's finer types, so
 * a «ملحقات وقطع» card takes the hotend's and the plate's keys — each only when
 * the product actually carries the field.
 */
const IMPORT_TYPES: Readonly<Record<ProductTypeId, readonly ProductType[]>> = {
  printer: ['printer'],
  laser: ['laser_machine'],
  filament: ['filament'],
  laser_material: ['laser_material'],
  parts: ['hotend', 'plate', 'ams', 'part', 'tool', 'accessory'],
  accessory: ['accessory', 'tool', 'makers_supply', 'plate', 'hotend', 'part'],
};

const FIELDS: ReadonlyMap<string, TemplateField> = (() => {
  const out = new Map<string, TemplateField>();
  for (const g of allTemplateGroups()) for (const f of g.fields) if (!out.has(f.id)) out.set(f.id, f);
  return out;
})();

/** The registry's card keys for one storefront type, in registry order, one per mirrored field. */
export function cardKeysFor(type: ProductTypeId | null): SpecKey[] {
  if (!type) return [];
  const types = IMPORT_TYPES[type] ?? [];
  const seen = new Set<string>();
  const out: SpecKey[] = [];
  for (const k of SPEC_KEYS) {
    if (!k.templateField || !k.cardKeyFor?.some((t) => types.includes(t)) || seen.has(k.templateField)) continue;
    seen.add(k.templateField);
    out.push(k);
  }
  return out;
}

const fieldOf = (id: string): TemplateField => FIELDS.get(id) ?? { id, label_ar: id, label_en: id, type: 'text' };

/** The card's key values: ≤ 4, each ≤ 40 characters, in the registry's order. */
export function cardKeySpecs(specFields: Record<string, unknown> | null | undefined, type: ProductTypeId | null): string[] {
  if (!specFields || typeof specFields !== 'object') return [];
  const out: string[] = [];
  for (const k of cardKeysFor(type)) {
    const raw = specFields[k.templateField as string];
    if (raw === null || raw === undefined || typeof raw === 'object') continue;
    const shown = readCompareValue(fieldOf(k.templateField as string), String(raw).replace(/\s+/g, ' ').trim()).text.trim();
    if (!shown || shown.length > KEY_SPEC_MAX_CHARS || out.includes(shown)) continue;
    out.push(shown);
    if (out.length >= KEY_SPECS_MAX) break;
  }
  return out;
}

/** The section a product is filed in, in three languages; null when the taxonomy has no active node for it. */
export function sectionNameOf(row: { sub_category_id?: unknown; category_id?: unknown }, idx: CatalogIndex): Tri | null {
  const id = (typeof row.sub_category_id === 'string' && row.sub_category_id) || (typeof row.category_id === 'string' && row.category_id) || '';
  const node = id ? idx.byId.get(id) : undefined;
  if (!node || !node.active) return null;
  const ar = node.name_ar.trim();
  const en = node.name_en.trim();
  const ckb = node.name_ckb.trim();
  if (!ar && !en && !ckb) return null;
  // A Sorani slot never copies the Arabic (row 183): English stands in for a section nobody named in Sorani.
  return { ar: ar || en, en: en || ar, ckb: ckb || en };
}

function specFieldsOf(row: Record<string, unknown>): Record<string, unknown> {
  const v = row.spec_fields;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string' || v.trim() === '') return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Adds `section_name` and `key_specs` to an ORDINARY product's card, from its
 * row and the taxonomy (never to a composition card). `type` is the card's
 * `compare_type` when the caller already resolved it.
 */
export function withCardKnowledge(
  card: Record<string, unknown>,
  row: Record<string, unknown>,
  idx: CatalogIndex,
  type: ProductTypeId | string | null = productTypeOf(row, idx)
): Record<string, unknown> {
  const section = sectionNameOf(row, idx);
  if (section) card.section_name = section;
  const keys = cardKeySpecs(specFieldsOf(row), (type as ProductTypeId | null) ?? null);
  if (keys.length) card.key_specs = keys;
  return card;
}
