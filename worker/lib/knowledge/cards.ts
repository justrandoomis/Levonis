/**
 * THE CARD'S KNOWLEDGE LINE (the Bambu import spec §G.5 «Cards»; the brief's
 * §9: a card names its section and two to four real key properties).
 *
 *   section_name {ar, en, ckb}  the section the product is filed in
 *                               (`sub_category_id`, else `category_id`), from
 *                               the taxonomy the listing routes already hold
 *                               (worker/lib/catalogPresentation.ts
 *                               `catalogIndexFor`, memoised per isolate)
 *   key_specs    (string | Tri)[]  ≤ 4 values of ≤ 40 characters, read from the
 *                               row's `spec_fields` — the mirrors the import
 *                               writes — for the registry keys flagged
 *                               `cardKeyFor` the product's type, then the
 *                               shop's own fields §G.5 names that the registry
 *                               has no key for (`CARD_FIELDS`: a printer's
 *                               enclosure and colours, a plate's size and
 *                               surface). A value is the shop's language-neutral
 *                               text; a yes/no or a count is no value on its own,
 *                               so it is WORDED in three languages ({ar, en, ckb}:
 *                               «هيكل مغلق», «حتى 16 لونًا»).
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
import { readBoolean, readCompareValue, readNumber } from '../compareSpecs';
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

/** One key value: the shop's language-neutral text, or a fact worded in three languages. */
export type KeySpec = string | Tri;

/**
 * The shop's own fields §G.5 names for a card that the registry has no key for
 * (the Bambu store publishes no «Enclosure» row and states colours only in
 * prose): read after the registry's card keys, each only when the product
 * carries it.
 */
export const CARD_FIELDS: Readonly<Partial<Record<ProductTypeId, readonly string[]>>> = {
  printer: ['enclosed', 'max_colors'],
  parts: ['plate_size', 'plate_surface'],
  accessory: ['plate_size', 'plate_surface'],
};

const ENCLOSED: Tri = { ar: 'هيكل مغلق', en: 'Enclosed', ckb: 'لەشی داخراو' };
const OPEN_FRAME: Tri = { ar: 'هيكل مفتوح', en: 'Open frame', ckb: 'چوارچێوەی کراوە' };

/** `max_colors` is the ceiling with every AMS / expansion unit (worker/lib/multicolor.ts): «up to». */
function coloursUpTo(n: number): Tri {
  if (n === 1) return { ar: 'لون واحد', en: 'Single colour', ckb: 'یەک ڕەنگ' };
  const ar = n === 2 ? 'حتى لونين' : n % 100 >= 3 && n % 100 <= 10 ? `حتى ${n} ألوان` : `حتى ${n} لونًا`;
  return { ar, en: `Up to ${n} colours`, ckb: `تا ${n} ڕەنگ` };
}

/** A field whose bare value means nothing on a card, worded; undefined for every other field. */
function wordedKeySpec(field: string, raw: string): Tri | null | undefined {
  if (field === 'enclosed') {
    const b = readBoolean(raw);
    return b === 1 ? ENCLOSED : b === 0 ? OPEN_FRAME : null;
  }
  if (field === 'max_colors') {
    const n = readNumber(raw);
    return n !== null && Number.isInteger(n) && n >= 1 && n <= 999 ? coloursUpTo(n) : null;
  }
  return undefined;
}

const sameSpec = (a: KeySpec, b: KeySpec) => (typeof a === 'string' || typeof b === 'string' ? a === b : a.en === b.en);
const fits = (v: KeySpec) =>
  typeof v === 'string' ? v !== '' && v.length <= KEY_SPEC_MAX_CHARS : [v.ar, v.en, v.ckb].every((x) => x !== '' && x.length <= KEY_SPEC_MAX_CHARS);

/** The card's key values: ≤ 4, each ≤ 40 characters — the registry's card keys, then `CARD_FIELDS`. */
export function cardKeySpecs(specFields: Record<string, unknown> | null | undefined, type: ProductTypeId | null): KeySpec[] {
  if (!specFields || typeof specFields !== 'object') return [];
  const fields = [...cardKeysFor(type).map((k) => k.templateField as string), ...(type ? CARD_FIELDS[type] ?? [] : [])];
  const out: KeySpec[] = [];
  for (const field of [...new Set(fields)]) {
    const raw = specFields[field];
    if (raw === null || raw === undefined || typeof raw === 'object') continue;
    const text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const worded = wordedKeySpec(field, text);
    const shown: KeySpec | null = worded === undefined ? readCompareValue(fieldOf(field), text).text.trim() : worded;
    if (!shown || !fits(shown) || out.some((x) => sameSpec(x, shown))) continue;
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
