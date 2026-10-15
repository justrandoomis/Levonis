/**
 * OPTION GROUPS, VALUES AND ONLY THE REAL VARIANTS (spec §C.2, §C.3, §B.8).
 *
 *   - Groups in `position` order, values in array order; labels through the
 *     group registry (the original wording kept as the source label).
 *   - Every value carries an explicit `variant_key = 'bv-' + H(source value id)`
 *     and `variant_label` = its own text, so two values that differ only in
 *     case (H2D `Standard` / `standard`) stay distinct and pass the save
 *     path's legacyShapeErrors, which refuses two NEW values sharing a key.
 *   - One variant per source SKU; `combo_key` = sorted `o:<valueId>` joined
 *     by `|` (worker/lib/inventory.ts comboKey). Missing combinations are never
 *     created. A SKU naming a value its group does not list is
 *     IDENTITY_AMBIGUOUS.
 *   - Prices, stock and sold-out never reach a row: the sold-out count goes to
 *     the ledger only.
 */
import { H } from './hash';
import { cleanText, nfc } from './normalize';
import type { Extraction, SourceSku } from './extract';
import { classifyGroup, type GroupKind } from './registry/groups';
import { valueWord } from './registry/values';
import { colourCodeOf } from './registry/colours';

export interface ModelValue {
  id: string;
  sourceId: string;
  groupId: string;
  nameEn: string;
  nameAr: string;
  nameCkb: string;
  variantKey: string;
  variantLabel: string;
  sort: number;
  colorUrl: string;
  colourCode: string | null;
}

export interface ModelGroup {
  id: string;
  sourceId: string;
  position: number;
  nameEn: string;
  nameAr: string;
  nameCkb: string;
  kind: GroupKind;
  canonical: string | null;
  sourceLabel: string;
  defaultValueId: string;
  values: ModelValue[];
}

export interface ModelVariant {
  id: string;
  sourceId: string;
  comboKey: string;
  valueIds: string[];
  heroResourceFileId: string | null;
  heroUrl: string | null;
  note: string;
}

export interface OptionIssue {
  code: 'IDENTITY_AMBIGUOUS' | 'DUPLICATE_VALUE_TEXT' | 'DUPLICATE_VARIANT' | 'TRANSLATION_REVIEW' | 'ORDER_TYPE_WORD' | 'EMPTY_GROUP';
  detail: string;
}

export interface OptionModel {
  productId: string;
  inventoryMode: 'BASE' | 'VARIANT_COMBINATION';
  groups: ModelGroup[];
  variants: ModelVariant[];
  /** Hard problems: the item cannot be written as it is. */
  errors: OptionIssue[];
  /** Review notes (translation_review conflicts) and holds. */
  notes: OptionIssue[];
  /** `hold_code` of the manifest row when an order-type word is present (§B.5). */
  hold: '' | 'ORDER_TYPE_WORD';
  /** Variants the source shows as sold out: the ledger's source_sold_out_variants, never written to a product. */
  soldOutCount: number;
}

/** `p_` + H('bambu_us:product:' + source id) — the id of a product the import CREATES (§B.8). */
export function newProductId(sourceProductId: string): string {
  return `p_${H(`bambu_us:product:${sourceProductId}`)}`;
}
export const groupIdOf = (productId: string, propertyKeyId: string) => `og_${H(`${productId}:${propertyKeyId}`)}`;
export const valueIdOf = (productId: string, propertyKeyId: string, text: string) => `ov_${H(`${productId}:${propertyKeyId}:${nfc(text)}`)}`;
export const variantKeyOf = (sourceValueId: string) => `bv-${H(`bambu_us:value:${sourceValueId}`)}`;
export const variantIdOf = (productId: string, sourceVariantId: string) => `pv_${H(`${productId}:sku:${sourceVariantId}`)}`;

/**
 * The order-type reading of a name, exactly as the save path reads it
 * (packages/pricing/src/availability.ts availabilityFromName; this package may
 * not import another, so tests/bambuOptions.test.ts proves the two agree).
 */
export function orderTypeWord(name: string): 'pre_order' | 'direct_sale' | '' {
  if (/pre[\s-]?order|طلب\s*مسبق/i.test(name)) return 'pre_order';
  if (/(?<![a-z])direct(\s*sale)?(?![a-z])|بيع\s*مباشر/i.test(name)) return 'direct_sale';
  return '';
}

const MAX_GROUP_NAME = 80;

function comboKeyOf(valueIds: readonly string[]): string {
  return [...valueIds].sort().map((id) => `o:${id}`).join('|');
}

/** Builds the option model of one extracted product for a Levonis product id. */
export function buildOptions(x: Extraction, productId: string): OptionModel {
  const errors: OptionIssue[] = [];
  const notes: OptionIssue[] = [];
  const groups: ModelGroup[] = [];
  const sorted = [...x.groups].sort((a, b) => a.position - b.position);
  for (const g of sorted) {
    const cls = classifyGroup(g);
    const gid = groupIdOf(productId, g.propertyKeyId);
    const label = cleanText(g.propertyKey);
    const values: ModelValue[] = [];
    const seenText = new Set<string>();
    g.values.forEach((v, i) => {
      const text = cleanText(v.value);
      if (!text) return;
      if (seenText.has(nfc(text))) {
        errors.push({ code: 'DUPLICATE_VALUE_TEXT', detail: `${label}: "${text}" twice` });
        return;
      }
      seenText.add(nfc(text));
      const word = valueWord(text);
      values.push({
        id: valueIdOf(productId, g.propertyKeyId, text),
        sourceId: v.id,
        groupId: gid,
        nameEn: text,
        nameAr: word?.ar ?? '',
        nameCkb: word?.ckb ?? '',
        variantKey: variantKeyOf(v.id || `${g.propertyKeyId}:${text}`),
        variantLabel: text,
        sort: i,
        colorUrl: v.colorUrl,
        colourCode: cls.kind === 'color' ? colourCodeOf(text) : null,
      });
    });
    if (!values.length) notes.push({ code: 'EMPTY_GROUP', detail: label });
    const defaultSource = g.values.find((v) => v.selectedDefault);
    const defaultValue = defaultSource ? values.find((v) => v.sourceId === defaultSource.id) : undefined;
    if (!cls.group) notes.push({ code: 'TRANSLATION_REVIEW', detail: `group "${label}" is not in the registry` });
    groups.push({
      id: gid,
      sourceId: g.propertyKeyId,
      position: g.position,
      nameEn: cls.group ? cls.group.label.en : label.slice(0, MAX_GROUP_NAME),
      nameAr: cls.group?.label.ar ?? '',
      nameCkb: cls.group?.label.ckb ?? '',
      kind: cls.kind,
      canonical: cls.group?.canonical ?? null,
      sourceLabel: g.propertyKey,
      defaultValueId: defaultValue?.id ?? '',
      values,
    });
  }

  // Order-type words (§C.2, L-18): the product is held, never written with them.
  let hold: OptionModel['hold'] = '';
  for (const g of groups) {
    for (const v of g.values) {
      if (orderTypeWord(v.nameEn)) {
        hold = 'ORDER_TYPE_WORD';
        notes.push({ code: 'ORDER_TYPE_WORD', detail: `${g.sourceLabel}: "${v.nameEn}"` });
      }
    }
  }

  const byKeyId = new Map(groups.map((g) => [g.sourceId, g]));
  const variants: ModelVariant[] = [];
  const combos = new Set<string>();
  let soldOutCount = 0;
  for (const sku of x.skus) {
    if (sku.soldOut) soldOutCount++;
    const ids = variantValues(sku, byKeyId, errors);
    if (ids === null) continue;
    if (!ids.length && groups.length) {
      errors.push({ code: 'IDENTITY_AMBIGUOUS', detail: `variant ${sku.id} names no option value` });
      continue;
    }
    if (!groups.length) continue; // a simple product: no variant rows
    const comboKey = comboKeyOf(ids);
    if (combos.has(comboKey)) {
      errors.push({ code: 'DUPLICATE_VARIANT', detail: `variant ${sku.id} repeats ${comboKey}` });
      continue;
    }
    combos.add(comboKey);
    variants.push({
      id: variantIdOf(productId, sku.id),
      sourceId: sku.id,
      comboKey,
      valueIds: ids,
      heroResourceFileId: sku.hero?.resourceFileId || null,
      heroUrl: sku.hero?.url || null,
      note: sku.description,
    });
  }
  return {
    productId,
    inventoryMode: groups.length ? 'VARIANT_COMBINATION' : 'BASE',
    groups,
    variants,
    errors,
    notes,
    hold,
    soldOutCount,
  };
}

function variantValues(sku: SourceSku, byKeyId: ReadonlyMap<string, ModelGroup>, errors: OptionIssue[]): string[] | null {
  const ids: string[] = [];
  const usedGroups = new Set<string>();
  for (const p of sku.props) {
    const g = byKeyId.get(p.propertyKeyId);
    const text = cleanText(p.value);
    if (!g) {
      errors.push({ code: 'IDENTITY_AMBIGUOUS', detail: `variant ${sku.id}: group ${p.propertyKeyId} ("${p.propertyKey}") is not listed` });
      return null;
    }
    // Join by NFC text, EXACT case first (Standard / standard are two values).
    const v = g.values.find((x) => nfc(x.nameEn) === nfc(text));
    if (!v) {
      errors.push({ code: 'IDENTITY_AMBIGUOUS', detail: `variant ${sku.id}: "${text}" is not a value of "${g.sourceLabel}"` });
      return null;
    }
    if (usedGroups.has(g.id)) {
      errors.push({ code: 'IDENTITY_AMBIGUOUS', detail: `variant ${sku.id}: two values of "${g.sourceLabel}"` });
      return null;
    }
    usedGroups.add(g.id);
    ids.push(v.id);
  }
  return ids;
}

/** The variants that contain a value. */
export function variantsWithValue(model: OptionModel, valueId: string): ModelVariant[] {
  return model.variants.filter((v) => v.valueIds.includes(valueId));
}

/** The value ids of a variant keyed by group id. */
export function valueByGroup(model: OptionModel, variant: ModelVariant): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of variant.valueIds) {
    const g = model.groups.find((gr) => gr.values.some((v) => v.id === id));
    if (g) out.set(g.id, id);
  }
  return out;
}
