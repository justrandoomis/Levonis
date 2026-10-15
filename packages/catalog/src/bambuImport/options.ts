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
 *   - A reviewed value label (the manifest row's `value_labels`, owner-questions
 *     §E.1, P0-11) replaces a value's DISPLAY names after the ids, the
 *     variant_key and the SKU join are computed from the source text, and
 *     before media binding: names, variant label, source label and alt text
 *     all carry it. The source text stays on the value (`sourceText`) for
 *     matching only: the SKU join, in-the-box and composite-cell scoping, and
 *     the relation labels of compat-targets.json, which are keyed by it.
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
  /** The display names (the source text, or a reviewed label's). */
  nameEn: string;
  nameAr: string;
  nameCkb: string;
  variantKey: string;
  variantLabel: string;
  sort: number;
  colorUrl: string;
  colourCode: string | null;
  /**
   * The value's own text as the source wrote it (cleaned): what the SKU join
   * and every source-side match read. Absent on a model rebuilt from a
   * payload; `sourceTextOf` falls back to `nameEn` there.
   */
  sourceText?: string;
  /** True when a reviewed label (manifest `value_labels`) replaced the display names. */
  labelled?: boolean;
}

/** The text a value is matched by: the source's own words, never a reviewed display label. */
export const sourceTextOf = (v: Pick<ModelValue, 'nameEn' | 'sourceText'>): string => v.sourceText ?? v.nameEn;

/**
 * A reviewed display label of one source option value: a manifest row's
 * `value_labels[<source value id>]` (owner-questions §E.1, P0-11). The builder
 * reads only these four fields; the row's evidence, reason and refused class
 * are review data.
 */
export interface ReviewedValueLabel {
  /** The source group (`propertyKeyId`) the value belongs to; when given it must match. */
  group_source_id?: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
}

export type ReviewedValueLabels = Readonly<Record<string, ReviewedValueLabel>>;

export interface BuildOptionsExtras {
  /** The manifest row's reviewed value labels, by source value id. */
  valueLabels?: ReviewedValueLabels | null;
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
  code:
    | 'IDENTITY_AMBIGUOUS'
    | 'DUPLICATE_VALUE_TEXT'
    | 'DUPLICATE_VARIANT'
    | 'TRANSLATION_REVIEW'
    | 'ORDER_TYPE_WORD'
    | 'EMPTY_GROUP'
    /** A reviewed label that cannot be applied as written (an error: the item is not written with half a label). */
    | 'VALUE_LABEL_INVALID'
    /** A reviewed label whose value the page no longer lists (a note: nothing to apply). */
    | 'VALUE_LABEL_UNUSED';
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
export function buildOptions(x: Extraction, productId: string, extras: BuildOptionsExtras = {}): OptionModel {
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
        sourceText: text,
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

  // Variants: every SKU joined to its values by the SOURCE text (before any reviewed label).
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

  // Reviewed display labels (§E.1): ids, variant keys and the SKU join above are the source's; from here on every
  // derived customer string (names, variant label, source label, image alt text) carries the label.
  applyValueLabels(groups, extras.valueLabels, errors, notes);

  // Order-type words (§C.2, L-18), on the names the product will be written with: the product is held, never
  // written with them (legacyShapeErrors reads name_en).
  let hold: OptionModel['hold'] = '';
  for (const g of groups) {
    for (const v of g.values) {
      if (orderTypeWord(v.nameEn)) {
        hold = 'ORDER_TYPE_WORD';
        notes.push({ code: 'ORDER_TYPE_WORD', detail: `${g.sourceLabel}: "${v.nameEn}"` });
      }
    }
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

/** The length the payload allows a value name and variant label (payload.ts PAYLOAD_SCHEMA). */
const MAX_VALUE_NAME = 200;
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

/** Why a reviewed label cannot be applied to a value of group `groupSourceId`, or '' when it can. */
function labelProblem(raw: unknown, groupSourceId: string): { problem: string; en: string; ar: string; ckb: string } {
  const l = raw && typeof raw === 'object' ? (raw as Partial<ReviewedValueLabel>) : {};
  const en = cleanText(l.name_en);
  const ar = cleanText(l.name_ar);
  const ckb = cleanText(l.name_ckb);
  const problem =
    l.group_source_id && String(l.group_source_id) !== groupSourceId
      ? `labelled for group ${String(l.group_source_id)}, not ${groupSourceId}`
      : !en || !ar || !ckb
        ? 'a language is missing'
        : en.length > MAX_VALUE_NAME || ar.length > MAX_VALUE_NAME || ckb.length > MAX_VALUE_NAME
          ? `longer than ${MAX_VALUE_NAME} characters`
          : ARABIC_SCRIPT.test(en)
            ? 'name_en is not in Latin script'
            : !ARABIC_SCRIPT.test(ar) || !ARABIC_SCRIPT.test(ckb)
              ? 'name_ar and name_ckb must be in Arabic script'
              : ar === ckb
                ? 'name_ckb copies name_ar (DECISIONS row 183)'
                : '';
  return { problem, en, ar, ckb };
}

/**
 * Applies the manifest row's reviewed labels to the values they name (by
 * source value id). A label that cannot be applied as written is an error —
 * the product is never written with half a label or with two values showing
 * one name; a label whose value the page no longer lists is a note.
 */
function applyValueLabels(groups: ModelGroup[], labels: ReviewedValueLabels | null | undefined, errors: OptionIssue[], notes: OptionIssue[]): void {
  if (!labels) return;
  const found = new Set<string>();
  for (const g of groups) {
    const planned = new Map<ModelValue, { en: string; ar: string; ckb: string }>();
    for (const v of g.values) {
      if (!v.sourceId || !Object.prototype.hasOwnProperty.call(labels, v.sourceId)) continue;
      found.add(v.sourceId);
      const { problem, en, ar, ckb } = labelProblem(labels[v.sourceId], g.sourceId);
      if (problem) errors.push({ code: 'VALUE_LABEL_INVALID', detail: `value ${v.sourceId}: ${problem}` });
      else planned.set(v, { en, ar, ckb });
    }
    const shown = (v: ModelValue) => nfc(planned.get(v)?.en ?? v.nameEn);
    for (const [v, l] of [...planned]) {
      if (g.values.some((o) => o !== v && shown(o) === nfc(l.en))) {
        errors.push({ code: 'VALUE_LABEL_INVALID', detail: `value ${v.sourceId}: another value of "${g.sourceLabel}" shows the same name` });
        planned.delete(v);
      }
    }
    for (const [v, l] of planned) {
      v.nameEn = l.en;
      v.nameAr = l.ar;
      v.nameCkb = l.ckb;
      v.variantLabel = l.en;
      v.labelled = true;
    }
  }
  for (const id of Object.keys(labels)) if (!found.has(id)) notes.push({ code: 'VALUE_LABEL_UNUSED', detail: `value ${id}` });
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
    // Join by the NFC source text, EXACT case first (Standard / standard are two values).
    const v = g.values.find((x) => nfc(sourceTextOf(x)) === nfc(text));
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
