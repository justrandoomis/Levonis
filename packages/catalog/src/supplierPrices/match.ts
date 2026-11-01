/**
 * The deterministic supplier matcher (docs/SMART_PRICING.md §3.5): one
 * Levonis product against the catalogue items its keys found, scored item by
 * item, every structurally sellable SKU mapped to exactly one catalogue SKU,
 * value by value. No AI, no I/O: the Worker's matcher (worker/lib/
 * supplierPrices/matcher.ts) loads the product and the candidates and writes
 * what this returns.
 *
 * Value by value:
 *   - a colour by its 5-digit code (a store's colour also by its label);
 *   - spool / refill, nozzle (diameter, material, flow), plate type and generation, and pack
 *     through the dictionary; a printer option by its model tokens;
 *   - every other group by its exact normalised English name (`options_en`).
 * If two Levonis SKUs land on one catalogue SKU, or one Levonis SKU on two, both stay
 * unmapped (AMBIGUOUS); the SKUs it could be are listed for the owner. Pack and weight must
 * agree: a 10件装 item against a single spool is refused (PACK_MISMATCH), and a pack price
 * is never divided here — only the owner divides one (units_per_offer).
 *
 * Confidence of an item:
 *   exact   stores: every SKU's bambu_variant_id equals the store variant id, or its
 *           bambu_sku_code the store SKU code. Tmall: a single-SKU product and a single-SKU
 *           item with an equal normalised part code.                    → confirmed ('auto')
 *   high    Tmall: code evidence (an equal part code, or colour codes covering ≥ 80 % of the
 *           product's colours with an equal material), every SKU mapped by code or dictionary,
 *           pack and weight equal. Stores: equal handle, every SKU mapped by equal English
 *           option labels.                                               → confirmed, listed for audit
 *   medium  name tokens Jaccard ≥ 0.6, model tokens equal, every SKU mapped → suggested
 *   low     anything weaker, or some SKU unmapped                        → suggested, SKU by SKU
 *
 * Refused items (no pairing at all): PACK_MISMATCH; TYPE_MISMATCH (the item's sourcing
 * contradicts a type the owner chose); LISTING_MISMATCH (a refurbished unit against a new
 * product, or the reverse; another plate: the item states a plate type or generation that differs
 * from the one the product's name states for each SKU, where no option value states one; or a
 * build plate by its name against an item the capture files under another category);
 * MODEL_MISMATCH (both name printers or AMS units, none in common: an A1 hotend is no X2D
 * hotend); PLACEHOLDER_LISTING (a listing that sells nothing). A promotion,
 * flash-sale, members-only or subsidy listing shows a price that is not the regular one: it
 * is never confirmed automatically (PROMO_LISTING, capped at low).
 *
 * Matching never publishes anything (§3.5): a confirmed match only feeds an estimate preview.
 */
import { PROMO_LISTING_FLAGS, SERIES_MEMBERS } from './dictionary';
import type { SourcingHint, SupplierSource } from './format';
import {
  bracketColourCode,
  colourCodesIn,
  isAddonSku,
  isPlaceholderSku,
  itemPartCodes,
  labelKeyOf,
  listingFlagsOf,
  materialTokensIn,
  modelTokensIn,
  nameJaccard,
  nameTokensOf,
  normalizePartCode,
  nozzleOf,
  packOf,
  partCodesIn,
  plateOf,
  skuCodeParts,
  skuColourCodes,
  skuPartCodes,
  spoolOf,
  spoolOfSkuCode,
  type NozzleFacts,
  type PartCode,
  type PlateFacts,
} from './keys';

// ---------------------------------------------------------------- inputs

/** product_option_groups.kind (0194's CHECK list). */
export type GroupKind = '' | 'color' | 'spool' | 'printer' | 'version' | 'size' | 'nozzle' | 'plate' | 'units' | 'pack' | 'item' | 'other';

export interface MatchGroup {
  id: string;
  kind: GroupKind | string;
  name_en?: string;
}

export interface MatchValue {
  id: string;
  group_id: string;
  /** The value's English name (the source label the import kept). */
  name_en: string;
  /** The option-value-scope `color_code` external id, when the import stored one. */
  color_code?: string | null;
}

/** A colour row of a product that keeps colours apart from its option groups. */
export interface MatchColor {
  id: string;
  name_en: string;
  color_code?: string | null;
}

/** One structurally sellable SKU (sellableSkus, worker/lib/pricingEngine/legacy.ts). */
export interface MatchSku {
  /** The canonical skuComboKey; '' is the product itself. */
  combo_key: string;
  value_ids: readonly string[];
  color_id?: string | null;
  /** Variant-scope `bambu_variant_id` external ids of the variant with this combo. */
  variant_ids?: readonly string[];
  /** Variant-scope `bambu_sku_code` external ids. */
  sku_codes?: readonly string[];
}

/** The Levonis side of a match: what worker/lib/supplierPrices/matcher.ts reads per product. */
export interface MatchIdentity {
  product_id: string;
  /** products.name (English). */
  name: string;
  /** product_source_refs.source_handle (the store handle the import came from), or null. */
  handle?: string | null;
  /** Product-scope `part_code` external ids. */
  part_codes?: readonly string[];
  /**
   * The sourcing of a type THE OWNER chose for this product (type_source 'owner'), or null. A
   * candidate whose sourcing hint contradicts it is refused; a type from the import refuses nothing.
   */
  owner_sourcing?: 'EU_STORE_EUR' | 'CHINA_CNY' | null;
  /** A refurbished unit (the import's `refurbished` subtype); read from the name and handle when absent. */
  refurbished?: boolean;
  groups: readonly MatchGroup[];
  values: readonly MatchValue[];
  colors?: readonly MatchColor[];
  skus: readonly MatchSku[];
}

/**
 * One catalogue SKU as stored (supplier_price_skus) or parsed. The stored pack_units and
 * net_weight_g are not read: the matcher re-reads the same texts with the same packOf, which
 * also knows whether a count was stated at all.
 */
export interface CatalogueSku {
  sku_key: string;
  options: Readonly<Record<string, string>>;
  options_en?: Readonly<Record<string, string>>;
  sku_code?: string;
  codes?: readonly string[];
  /** Decimal text in the snapshot's currency. */
  price: string;
  quantity?: number | null;
}

/** One catalogue item of one source's complete snapshot. */
export interface CatalogueItem {
  source: SupplierSource;
  item_key: string;
  title: string;
  name_en: string;
  category?: string;
  sourcing_hint?: SourcingHint | string;
  codes?: readonly string[];
  skus: readonly CatalogueSku[];
}

// ---------------------------------------------------------------- results

export type MatchConfidence = 'exact' | 'high' | 'medium' | 'low';
/** supplier_price_matches.method, less 'owner' (the owner's own decisions are not this module's). */
export type MatchMethod = 'variant_id' | 'sku_code' | 'part_code' | 'color_code' | 'handle' | 'name';

/** The codes stored in supplier_price_matches.reasons_json (codes only, never text). */
export const MATCH_REASONS = [
  'CODE_EQUAL',
  'REVISION_STRIPPED',
  'COLOUR_COVERAGE',
  'MATERIAL_EQUAL',
  'MODEL_EQUAL',
  'NAME_SIMILAR',
  'SPOOL_DICT',
  'NOZZLE_DICT',
  'PLATE_DICT',
  'PACK_EQUAL',
  'AMBIGUOUS',
  'PACK_MISMATCH',
  'TYPE_MISMATCH',
  'LISTING_MISMATCH',
  'MODEL_MISMATCH',
  'PLACEHOLDER_LISTING',
  'PROMO_LISTING',
] as const;
export type MatchReason = (typeof MATCH_REASONS)[number];

export type MatchRefusal = 'PACK_MISMATCH' | 'TYPE_MISMATCH' | 'LISTING_MISMATCH' | 'MODEL_MISMATCH' | 'PLACEHOLDER_LISTING';

const CONFIDENCE_RANK: Readonly<Record<MatchConfidence, number>> = { exact: 3, high: 2, medium: 1, low: 0 };

/** Confidences confirmed automatically (decided_by 'auto'); high ones are listed for the owner's audit. */
export const AUTO_CONFIRMED: ReadonlySet<MatchConfidence> = new Set<MatchConfidence>(['exact', 'high']);

export interface SkuMatch {
  combo_key: string;
  /** The one catalogue SKU this SKU maps to, or null. */
  sku_key: string | null;
  method: MatchMethod | null;
  reasons: MatchReason[];
  /** When unmapped: the catalogue SKUs it could be (at most 10), for the owner's review. */
  could_be: string[];
}

export interface ItemMatch {
  source: SupplierSource;
  item_key: string;
  refused: MatchRefusal | null;
  confidence: MatchConfidence;
  method: MatchMethod;
  reasons: MatchReason[];
  /** Token Jaccard of the names (0..1). */
  name_similarity: number;
  /** How many of the product's SKUs map to exactly one SKU of this item. */
  mapped: number;
  /** One entry per Levonis SKU, in the identity's order. */
  skus: SkuMatch[];
}

export interface SourceMatch {
  source: SupplierSource;
  /** The best item that is not refused, or null. */
  best: ItemMatch | null;
  /** Every candidate item of this source, best first, refused ones last. */
  items: ItemMatch[];
}

export interface ProductMatch {
  product_id: string;
  /** One entry per source among the candidates, in tmall_cn, bambu_eu, bambu_us order. */
  sources: SourceMatch[];
}

/** Whether a match is confirmed automatically (exact or high, not refused). */
export const isAutoConfirmed = (m: Pick<ItemMatch, 'refused' | 'confidence'> | null | undefined): boolean => !!m && !m.refused && AUTO_CONFIRMED.has(m.confidence);

// ---------------------------------------------------------------- facts

type Via = 'variant_id' | 'sku_code' | 'part_code' | 'color_code' | 'spool' | 'nozzle' | 'plate' | 'model' | 'pack' | 'label';

interface ValueFact {
  kind: string;
  label: string;
  colourCode: string | null;
  spool: 'spool' | 'refill' | null;
  nozzle: NozzleFacts | null;
  plate: PlateFacts | null;
  models: string[];
}

interface LevonisSkuFacts {
  combo_key: string;
  values: ValueFact[];
  variantIds: Set<string>;
  skuCodes: Set<string>;
  codeSets: Array<{ parts: PartCode[]; compound: boolean }>;
  units: number;
  unitsStated: boolean;
  weight: number | null;
  flow: 'high' | 'standard';
  /** The plate type and generation the product's name states, each only where no value of this SKU states one. */
  namePlate: PlateFacts;
}

interface CatalogueSkuFacts {
  sku: CatalogueSku;
  colourCodes: string[];
  partCodes: PartCode[];
  spool: 'spool' | 'refill' | null;
  nozzle: NozzleFacts;
  plate: PlateFacts;
  models: string[];
  labels: Set<string>;
  /** The option values as written, with their label keys and bracket colour codes (a store states every value it has). */
  own: Array<{ label: string; code: string | null; weight: number | null }>;
  units: number;
  unitsStated: boolean;
  weight: number | null;
}

const isStore = (s: SupplierSource) => s === 'bambu_eu' || s === 'bambu_us';
const SPOOL_KINDS = new Set(['spool']);
const PACK_KINDS = new Set(['pack', 'units']);

function valueFact(kind: string, name: string, code: string | null | undefined): ValueFact {
  const label = labelKeyOf(name);
  const colourCode = kind === 'color' ? (code && /^\d{5}$/.test(code) ? code : (bracketColourCode(name) ?? colourCodesIn(name)[0] ?? null)) : null;
  const nozzle = kind === 'nozzle' ? nozzleOf(name) : null;
  return {
    kind,
    label,
    colourCode,
    spool: SPOOL_KINDS.has(kind) ? spoolOf(name) : null,
    nozzle: nozzle && nozzle.diameter ? nozzle : null,
    plate: kind === 'plate' ? plateOf(name) : null,
    models: kind === 'printer' ? modelTokensIn(name) : [],
  };
}

interface ProductFacts {
  skus: LevonisSkuFacts[];
  refurbished: boolean;
  models: string[];
  materials: string[];
  /** The plate type and generation the product's name states ("Bambu Textured PEI Plate"): a stated type makes it a build plate. */
  plate: PlateFacts;
  nameTokens: string[];
  /** Codes the product's own ids give (part_code ids, bambu_sku_code parts): eligible for exact. */
  trustedCodes: Array<{ parts: PartCode[]; compound: boolean }>;
  /** Codes read from the product's name: evidence, never exact. */
  nameCodes: PartCode[];
  colourValues: Array<string | null>;
}

function productFacts(id: MatchIdentity): ProductFacts {
  const groups = new Map(id.groups.map((g) => [g.id, g] as const));
  const values = new Map(id.values.map((v) => [v.id, v] as const));
  const colours = new Map((id.colors ?? []).map((c) => [c.id, c] as const));
  const nameFlow = nozzleOf(id.name).flow;
  // What a plate's name states ("Bambu Textured PEI Plate"); another name states none ("Smooth Ball Spring Plunger").
  const namePlate: PlateFacts = /\bplates?\b/i.test(id.name) ? plateOf(id.name) : { type: null, generation: null };
  const skus = id.skus.map((s): LevonisSkuFacts => {
    const vals: ValueFact[] = [];
    const packTexts: string[] = [];
    let flow = nameFlow;
    for (const vid of s.value_ids) {
      const v = values.get(vid);
      if (!v) continue;
      const kind = String(groups.get(v.group_id)?.kind ?? '');
      vals.push(valueFact(kind, v.name_en, v.color_code));
      if (PACK_KINDS.has(kind)) packTexts.push(v.name_en);
      if (kind === 'nozzle' && nozzleOf(v.name_en).flow === 'high') flow = 'high';
    }
    if (s.color_id) {
      const c = colours.get(s.color_id);
      if (c) vals.push(valueFact('color', c.name_en, c.color_code));
    }
    const pack = packOf([...packTexts, id.name]);
    const codeSets = (s.sku_codes ?? []).map((c) => skuCodeParts(c)).filter((c) => c.parts.length > 0);
    return {
      combo_key: s.combo_key,
      values: vals,
      variantIds: new Set((s.variant_ids ?? []).map(String)),
      skuCodes: new Set((s.sku_codes ?? []).map((c) => String(c).toUpperCase())),
      codeSets,
      units: pack.pack_units,
      unitsStated: pack.units_stated,
      weight: pack.net_weight_g,
      flow,
      namePlate: {
        type: vals.some((v) => v.plate?.type) ? null : namePlate.type,
        generation: vals.some((v) => v.plate?.generation) ? null : namePlate.generation,
      },
    };
  });
  const trusted: Array<{ parts: PartCode[]; compound: boolean }> = [];
  for (const raw of id.part_codes ?? []) {
    const pc = normalizePartCode(raw);
    if (pc) trusted.push({ parts: [pc], compound: false });
  }
  for (const s of skus) trusted.push(...s.codeSets);
  const colourValues: Array<string | null> = [];
  for (const v of id.values) {
    if (String(groups.get(v.group_id)?.kind ?? '') === 'color') colourValues.push(valueFact('color', v.name_en, v.color_code).colourCode);
  }
  for (const c of id.colors ?? []) colourValues.push(valueFact('color', c.name_en, c.color_code).colourCode);
  const handle = String(id.handle ?? '');
  return {
    skus,
    refurbished: id.refurbished ?? (/\brefurbished\b/i.test(id.name) || /^refurbished-/.test(handle)),
    models: modelTokensIn(id.name),
    materials: materialTokensIn(id.name),
    plate: namePlate,
    nameTokens: nameTokensOf(id.name),
    trustedCodes: trusted,
    nameCodes: partCodesIn(id.name),
    colourValues,
  };
}

function optionTexts(sku: CatalogueSku): string[] {
  return Object.values(sku.options ?? {});
}

function catalogueSkuFacts(item: CatalogueItem, sku: CatalogueSku, single: boolean, titleColours: string[]): CatalogueSkuFacts {
  const texts = optionTexts(sku);
  const nozzle = nozzleOf(...texts);
  const fromTitle = nozzleOf(item.title);
  const plate = plateOf(...texts);
  const titlePlate = single ? plateOf(item.title) : { type: null, generation: null };
  const colours = skuColourCodes(item.source, sku);
  const pack = packOf([...texts, item.title]);
  const labels = new Set<string>();
  for (const v of texts) labels.add(labelKeyOf(v));
  for (const v of Object.values(sku.options_en ?? {})) labels.add(labelKeyOf(v));
  labels.delete('');
  const own = texts.map((t) => ({ label: labelKeyOf(t), code: bracketColourCode(t), weight: packOf([t]).net_weight_g })).filter((o) => o.label);
  return {
    sku,
    colourCodes: colours.length ? colours : titleColours,
    partCodes: skuPartCodes(sku),
    spool: spoolOf(...texts) ?? spoolOfSkuCode(sku.sku_code ?? '') ?? spoolOf(item.title),
    nozzle: {
      diameter: nozzle.diameter ?? (single ? fromTitle.diameter : null),
      material: nozzle.material ?? fromTitle.material,
      flow: nozzle.flow === 'high' || fromTitle.flow === 'high' ? 'high' : 'standard',
    },
    plate: { type: plate.type ?? titlePlate.type, generation: plate.generation ?? titlePlate.generation },
    models: modelTokensIn(...texts),
    labels,
    own,
    units: pack.pack_units,
    unitsStated: pack.units_stated,
    weight: pack.net_weight_g,
  };
}

/** Both state a plate type and they differ, or both a generation and they differ. */
const platesDiffer = (a: PlateFacts, b: PlateFacts): boolean => (!!a.type && !!b.type && a.type !== b.type) || (!!a.generation && !!b.generation && a.generation !== b.generation);

/** Model tokens with every series replaced by its members (A1 series → A1, A1 mini). */
function expandModels(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) for (const m of SERIES_MEMBERS[t] ?? [t]) out.add(m);
  return out;
}

/** Whether a model (or series) is covered by a set of tokens (a series token covers its members). */
function covered(model: string, tokens: readonly string[]): boolean {
  if (tokens.includes(model)) return true;
  if (tokens.some((t) => (SERIES_MEMBERS[t] ?? []).includes(model))) return true;
  const members = SERIES_MEMBERS[model];
  return !!members && members.some((m) => tokens.includes(m));
}

/**
 * A pairing: possible with the ways its values matched, or impossible (`pack` when only the
 * pack or weight disagreed). `packUnknown`: the Levonis SKU is a pack the offer does not count.
 */
type Outcome = { ok: true; vias: Via[]; packUnknown: boolean } | { ok: false; pack: boolean };

const NO: Outcome = { ok: false, pack: false };

interface PairContext {
  source: SupplierSource;
  titleModels: string[];
  /** The item has one real SKU: its title speaks for that SKU. */
  singleOffer: boolean;
  /** Part codes of the title and the item's own codes. */
  itemCodes: PartCode[];
  /** The plate type and generation the item's title (else its English name) states. */
  itemPlate: PlateFacts;
}

/**
 * The pack rule: a stated count against a different stated count is refused, and so is an
 * offer of several units against a product that states none (a single unit). Weights refuse
 * only when both are stated.
 */
function packAgrees(l: LevonisSkuFacts, c: CatalogueSkuFacts): { ok: boolean; equal: boolean; unknown: boolean } {
  if (l.unitsStated && c.unitsStated && l.units !== c.units) return { ok: false, equal: false, unknown: false };
  if (!l.unitsStated && c.unitsStated && c.units > 1) return { ok: false, equal: false, unknown: false };
  if (l.weight !== null && c.weight !== null && l.weight !== c.weight) return { ok: false, equal: false, unknown: false };
  const unknown = l.unitsStated && l.units > 1 && !c.unitsStated;
  const equal = (l.unitsStated && c.unitsStated && l.units > 1 && l.units === c.units) || (l.weight !== null && l.weight === c.weight);
  return { ok: true, equal, unknown };
}

/** One Levonis SKU against one catalogue SKU: every value matched or left unknown, none contradicted. */
function pair(l: LevonisSkuFacts, c: CatalogueSkuFacts, ctx: PairContext): Outcome {
  const vias: Via[] = [];
  const store = isStore(ctx.source);
  // Ids decide a variant outright.
  if (store && l.variantIds.has(c.sku.sku_key)) return { ok: true, vias: ['variant_id'], packUnknown: false };
  if (c.sku.sku_code && l.skuCodes.has(c.sku.sku_code.toUpperCase())) return { ok: true, vias: ['sku_code'], packUnknown: false };

  // Codes: a Levonis SKU code (every part of a kit) must be on the catalogue SKU when that SKU
  // carries codes; a silent SKU leaves it to the title, which must not name other codes only.
  if (l.codeSets.length) {
    const covers = (codes: readonly PartCode[]) => l.codeSets.some((set) => set.parts.every((p) => codes.some((x) => x.code === p.code)));
    if (c.partCodes.length) {
      if (!covers(c.partCodes)) return NO;
      vias.push('part_code');
    } else if (ctx.itemCodes.length) {
      if (!covers(ctx.itemCodes)) return NO;
      if (ctx.singleOffer) vias.push('part_code');
    }
  }

  // The plate the product's name states, where no value states one: neither the SKU nor the item may be another plate.
  if (platesDiffer(l.namePlate, c.plate) || platesDiffer(l.namePlate, ctx.itemPlate)) return NO;

  const matchedLabels = new Set<string>();
  const took = (v: ValueFact, via: Via) => {
    vias.push(via);
    if (v.label) matchedLabels.add(v.label);
  };
  /** Label equality: true, false (a store states its values, so a miss is a refusal) or null (Tmall: unknown). */
  const byLabel = (v: ValueFact): boolean | null => {
    if (v.label && c.labels.has(v.label)) {
      took(v, 'label');
      return true;
    }
    return store ? false : null;
  };
  for (const v of l.values) {
    if (v.kind === 'color') {
      if (v.colourCode) {
        if (!c.colourCodes.includes(v.colourCode)) return NO;
        took(v, 'color_code');
        continue;
      }
      const r = byLabel(v);
      if (r === false || (r === null && c.colourCodes.length)) return NO;
      continue;
    }
    if (v.spool) {
      if (c.spool === v.spool) took(v, 'spool');
      else if (c.spool || byLabel(v) === false) return NO;
      continue;
    }
    if (v.nozzle) {
      const n = c.nozzle;
      if (!n.diameter || n.diameter !== v.nozzle.diameter) return NO;
      if (n.material && v.nozzle.material && n.material !== v.nozzle.material) return NO;
      if (n.flow !== l.flow) return NO;
      took(v, 'nozzle');
      continue;
    }
    if (v.plate && v.plate.type) {
      const p = c.plate;
      if (!p.type || p.type !== v.plate.type) return NO;
      if (p.generation && v.plate.generation && p.generation !== v.plate.generation) return NO;
      took(v, 'plate');
      continue;
    }
    // A value that states only a generation ("1st Gen") refuses a SKU of another generation; its label does the rest.
    if (v.plate?.generation && c.plate.generation && c.plate.generation !== v.plate.generation) return NO;
    if (v.models.length) {
      if (c.models.length) {
        if (!v.models.every((m) => covered(m, c.models))) return NO;
        took(v, 'model');
        continue;
      }
      if (store) {
        if (byLabel(v) !== true) return NO;
        continue;
      }
      // The SKU names no printer: the item's title must cover this one (or name none).
      if (ctx.titleModels.length && !v.models.every((m) => covered(m, ctx.titleModels))) return NO;
      byLabel(v);
      continue;
    }
    if (PACK_KINDS.has(v.kind)) {
      // The count and weight are decided SKU against SKU below; a store also states the label.
      const sameWeight = l.weight !== null && c.weight === l.weight;
      if (byLabel(v) === false && !sameWeight) return NO;
      if (sameWeight && v.label) matchedLabels.add(v.label);
      continue;
    }
    if (byLabel(v) === false) return NO;
  }

  // A store SKU states every value it has: each must be one of the Levonis SKU's.
  if (store && !(l.values.length === 0 && ctx.singleOffer)) {
    const unmatched = c.own.filter(
      (o) => !matchedLabels.has(o.label) && !(o.code && l.values.some((v) => v.colourCode === o.code)) && !(o.weight !== null && o.weight === l.weight)
    );
    if (unmatched.length) return NO;
  }

  const pack = packAgrees(l, c);
  if (!pack.ok) return { ok: false, pack: true };
  if (pack.equal) vias.push('pack');
  return { ok: true, vias, packUnknown: pack.unknown };
}

// ---------------------------------------------------------------- one item

const VIA_STRONG_TMALL = new Set<Via>(['variant_id', 'sku_code', 'part_code', 'color_code', 'spool', 'nozzle', 'plate', 'model', 'pack']);
const VIA_REASON: Partial<Record<Via, MatchReason>> = { spool: 'SPOOL_DICT', nozzle: 'NOZZLE_DICT', plate: 'PLATE_DICT', pack: 'PACK_EQUAL' };

interface CodeEvidence {
  equal: boolean;
  trusted: boolean;
  revisionStripped: boolean;
  /** The product's trusted code set equals the item's code set. */
  setEqual: boolean;
}

function codeEvidence(p: ProductFacts, itemCodes: PartCode[]): CodeEvidence {
  const byCode = new Map<string, Set<string>>();
  for (const c of itemCodes) {
    if (!byCode.has(c.code)) byCode.set(c.code, new Set());
    byCode.get(c.code)!.add(c.revision);
  }
  let equal = false;
  let trusted = false;
  let stripped = false;
  const check = (set: { parts: PartCode[] }, isTrusted: boolean) => {
    if (!set.parts.length || !set.parts.every((x) => byCode.has(x.code))) return;
    equal = true;
    if (isTrusted) trusted = true;
    for (const x of set.parts) if (!byCode.get(x.code)!.has(x.revision)) stripped = true;
  };
  for (const set of p.trustedCodes) check(set, true);
  for (const pc of p.nameCodes) check({ parts: [pc] }, false);
  const own = new Set(p.trustedCodes.flatMap((s) => s.parts.map((x) => x.code)));
  const setEqual = own.size > 0 && own.size === byCode.size && [...own].every((c) => byCode.has(c));
  return { equal, trusted, revisionStripped: stripped, setEqual };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Per item object (items are read-only to the matcher). */
const ITEM_FACTS = new WeakMap<CatalogueItem, CatalogueSkuFacts[]>();

function scoreItem(id: MatchIdentity, p: ProductFacts, item: CatalogueItem): ItemMatch {
  const source = item.source;
  const flags = listingFlagsOf(item.title, item.name_en);
  const nameSimilarity = nameJaccard(p.nameTokens, nameTokensOf(item.name_en || item.title));
  const itemModels = modelTokensIn(item.title, item.name_en);
  const itemMaterials = materialTokensIn(item.title, item.name_en);
  const empty = (refused: MatchRefusal | null, reasons: MatchReason[]): ItemMatch => ({
    source,
    item_key: item.item_key,
    refused,
    confidence: 'low',
    method: 'name',
    reasons,
    name_similarity: nameSimilarity,
    mapped: 0,
    skus: id.skus.map((s) => ({ combo_key: s.combo_key, sku_key: null, method: null, reasons: refused ? [refused] : [], could_be: [] })),
  });

  const real = item.skus.filter((s) => !isPlaceholderSku(s.options) && !isAddonSku(s.options));
  if (flags.includes('placeholder') || !real.length) return empty('PLACEHOLDER_LISTING', ['PLACEHOLDER_LISTING']);
  if (p.refurbished !== flags.includes('refurbished')) return empty('LISTING_MISMATCH', ['LISTING_MISMATCH']);
  const hint = String(item.sourcing_hint ?? '');
  if (id.owner_sourcing && hint && hint !== id.owner_sourcing) return empty('TYPE_MISMATCH', ['TYPE_MISMATCH']);
  // Both name printers or AMS units and none in common: a part for other machines.
  const ownModels = expandModels(p.models);
  const theirModels = expandModels(itemModels);
  if (ownModels.size && theirModels.size && ![...ownModels].some((m) => theirModels.has(m))) return empty('MODEL_MISMATCH', ['MODEL_MISMATCH']);
  // Another plate (a SuperTack listing is no Textured PEI plate): the item contradicts what the name states for every SKU.
  const itemPlate = plateOf(item.title, item.name_en);
  if (p.skus.length > 0 && p.skus.every((l) => platesDiffer(l.namePlate, itemPlate))) return empty('LISTING_MISMATCH', ['LISTING_MISMATCH']);
  // A build plate is no item the capture files under another category ("Printer base plate — A1 mini" is a spare part).
  if (p.plate.type && item.category && item.category !== 'build_plate') return empty('LISTING_MISMATCH', ['LISTING_MISMATCH']);

  const single = real.length === 1;
  const titleColours = colourCodesIn(item.title);
  // An item's facts do not depend on the product: a page of products reads each item once.
  let cs = ITEM_FACTS.get(item);
  if (!cs) {
    cs = real.map((s) => catalogueSkuFacts(item, s, single, titleColours));
    ITEM_FACTS.set(item, cs);
  }
  const titleCodes = itemPartCodes(item);
  const ctx: PairContext = { source, titleModels: itemModels, singleOffer: single, itemCodes: titleCodes, itemPlate };

  // Every pairing.
  const possible: number[][] = p.skus.map(() => []);
  const outcomes = new Map<string, Outcome>();
  let packRefusals = 0;
  p.skus.forEach((l, li) => {
    cs.forEach((c, ci) => {
      const o = pair(l, c, ctx);
      outcomes.set(`${li}:${ci}`, o);
      if (o.ok) possible[li]!.push(ci);
      else if (o.pack) packRefusals++;
    });
  });
  const anyPossible = possible.some((x) => x.length > 0);
  if (!anyPossible && packRefusals > 0) return empty('PACK_MISMATCH', ['PACK_MISMATCH']);

  const reverse = new Map<number, number[]>();
  possible.forEach((list, li) => {
    for (const ci of list) {
      if (!reverse.has(ci)) reverse.set(ci, []);
      reverse.get(ci)!.push(li);
    }
  });

  // Item-level evidence.
  const itemCodes: PartCode[] = [...titleCodes];
  for (const c of cs) for (const pc of c.partCodes) if (!itemCodes.some((x) => x.code === pc.code && x.revision === pc.revision)) itemCodes.push(pc);
  const code = codeEvidence(p, itemCodes);
  const itemColours = new Set<string>(titleColours);
  for (const c of cs) for (const x of c.colourCodes) itemColours.add(x);
  const colourTotal = p.colourValues.length;
  const colourCovered = p.colourValues.filter((c) => c !== null && itemColours.has(c)).length;
  const colourCoverage = colourTotal > 0 && colourCovered / colourTotal >= 0.8;
  const materialEqual = p.materials.length > 0 && p.materials.every((m) => itemMaterials.includes(m));
  const modelEqual = sameSet([...ownModels], [...theirModels]);
  const nameSimilar = nameSimilarity >= 0.6;
  const handleEqual = isStore(source) && !!id.handle && id.handle === item.item_key;

  const reasons: MatchReason[] = [];
  const add = (r: MatchReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  if (code.equal) add('CODE_EQUAL');
  if (code.revisionStripped) add('REVISION_STRIPPED');
  if (colourCoverage) add('COLOUR_COVERAGE');
  if (materialEqual) add('MATERIAL_EQUAL');
  if (modelEqual && p.models.length) add('MODEL_EQUAL');
  if (nameSimilar) add('NAME_SIMILAR');

  // SKU by SKU.
  const itemMethod: MatchMethod = handleEqual ? 'handle' : code.equal ? 'part_code' : colourCoverage ? 'color_code' : 'name';
  // One SKU against one offer: the pairing is structural, the item-level evidence decides.
  const oneToOne = p.skus.length === 1 && single;
  let allStrongTmall = true;
  let allStrongStore = true;
  let allIds = true;
  let allVariantIds = true;
  let packUnknown = false;
  const skus: SkuMatch[] = p.skus.map((l, li) => {
    const list = possible[li]!;
    const ci = list.length === 1 ? list[0]! : -1;
    const unique = ci >= 0 && (reverse.get(ci) ?? []).length === 1;
    if (!unique) {
      allStrongTmall = allStrongStore = allIds = allVariantIds = false;
      const skuReasons: MatchReason[] = [];
      const couldBe = list.map((x) => cs[x]!.sku.sku_key).slice(0, 10);
      if (list.length > 1 || ci >= 0) {
        skuReasons.push('AMBIGUOUS');
        add('AMBIGUOUS');
      } else if (cs.some((_, x) => (outcomes.get(`${li}:${x}`) as { pack?: boolean }).pack)) skuReasons.push('PACK_MISMATCH');
      return { combo_key: l.combo_key, sku_key: null, method: null, reasons: skuReasons, could_be: couldBe };
    }
    const o = outcomes.get(`${li}:${ci}`) as Extract<Outcome, { ok: true }>;
    const vias = o.vias;
    if (o.packUnknown) packUnknown = true;
    const skuReasons: MatchReason[] = [];
    for (const v of vias) {
      const r = VIA_REASON[v];
      if (r && !skuReasons.includes(r)) {
        skuReasons.push(r);
        add(r);
      }
    }
    if (!oneToOne && !vias.some((v) => VIA_STRONG_TMALL.has(v))) allStrongTmall = false;
    if (!oneToOne && !vias.length) allStrongStore = false;
    if (!vias.includes('variant_id') && !vias.includes('sku_code')) allIds = false;
    if (!vias.includes('variant_id')) allVariantIds = false;
    const method: MatchMethod = vias.includes('variant_id')
      ? 'variant_id'
      : vias.includes('sku_code')
        ? 'sku_code'
        : vias.includes('part_code')
          ? 'part_code'
          : vias.includes('color_code')
            ? 'color_code'
            : itemMethod;
    return { combo_key: l.combo_key, sku_key: cs[ci]!.sku.sku_key, method, reasons: skuReasons, could_be: [] };
  });
  const mapped = skus.filter((s) => s.sku_key !== null).length;
  const allMapped = p.skus.length > 0 && mapped === p.skus.length;

  let confidence: MatchConfidence = 'low';
  let method: MatchMethod = itemMethod;
  if (isStore(source)) {
    if (allMapped && allIds) {
      confidence = 'exact';
      method = allVariantIds ? 'variant_id' : 'sku_code';
      add('CODE_EQUAL');
    } else if (allMapped && handleEqual && allStrongStore) confidence = 'high';
  } else {
    const tmallExact = allMapped && oneToOne && code.trusted && code.setEqual && !code.revisionStripped;
    if (tmallExact) confidence = 'exact';
    else if (allMapped && allStrongTmall && (code.equal || (colourCoverage && materialEqual))) confidence = 'high';
  }
  // A pack the offer does not count is no "pack and weight equal": never automatic.
  if (packUnknown && CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK.medium) confidence = 'medium';
  if (confidence === 'low' && allMapped && nameSimilar && modelEqual) confidence = 'medium';
  if (flags.some((f) => PROMO_LISTING_FLAGS.has(f))) {
    confidence = 'low';
    add('PROMO_LISTING');
  }
  return { source, item_key: item.item_key, refused: null, confidence, method, reasons, name_similarity: nameSimilarity, mapped, skus };
}

// ---------------------------------------------------------------- ranking

const EVIDENCE: readonly MatchReason[] = ['CODE_EQUAL', 'COLOUR_COVERAGE', 'MATERIAL_EQUAL', 'MODEL_EQUAL', 'NAME_SIMILAR'];

function compareItems(a: ItemMatch, b: ItemMatch): number {
  const keyOf = (m: ItemMatch) => [m.refused ? 0 : 1, CONFIDENCE_RANK[m.confidence], m.mapped, EVIDENCE.filter((r) => m.reasons.includes(r)).length, m.name_similarity];
  const ka = keyOf(a);
  const kb = keyOf(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
  return a.item_key < b.item_key ? -1 : a.item_key > b.item_key ? 1 : 0;
}

/** Equal decimal texts ("40" and "40.00"). */
function samePrice(a: string, b: string): boolean {
  const norm = (s: string) => {
    const [i = '', f = ''] = s.split('.');
    return `${i.replace(/^0+(?=\d)/, '')}.${f.replace(/0+$/, '')}`;
  };
  return norm(a) === norm(b);
}

/**
 * Items equally good for the same SKUs: the choice is the owner's unless they carry the same
 * price for every mapped SKU (a duplicate listing). Otherwise every tied item drops to low.
 */
function settleTie(items: ItemMatch[], bySku: Map<string, Map<string, CatalogueSku>>): void {
  const best = items[0];
  if (!best || best.refused || best.mapped === 0 || best.confidence === 'low') return;
  const tied = items.slice(1).filter((m) => !m.refused && m.confidence === best.confidence && m.mapped === best.mapped);
  if (!tied.length) return;
  const a = bySku.get(best.item_key)!;
  const differs = tied.some((next) => {
    const b = bySku.get(next.item_key)!;
    return !best.skus.every((s, i) => {
      const t = next.skus[i]!;
      if (s.sku_key === null || t.sku_key === null) return s.sku_key === t.sku_key;
      return samePrice(a.get(s.sku_key)!.price, b.get(t.sku_key)!.price);
    });
  });
  if (!differs) return;
  for (const m of [best, ...tied]) {
    m.confidence = 'low';
    if (!m.reasons.includes('AMBIGUOUS')) m.reasons.push('AMBIGUOUS');
  }
}

const SOURCE_ORDER: readonly SupplierSource[] = ['tmall_cn', 'bambu_eu', 'bambu_us'];

/**
 * Scores every candidate item of every source against the product and maps its SKUs.
 * Deterministic: the same identity and candidates give the same answer in any order.
 */
export function matchProduct(identity: MatchIdentity, candidates: readonly CatalogueItem[]): ProductMatch {
  const p = productFacts(identity);
  const sources: SourceMatch[] = [];
  for (const source of SOURCE_ORDER) {
    const own = candidates.filter((c) => c.source === source);
    if (!own.length) continue;
    const seen = new Set<string>();
    const unique = own.filter((c) => (seen.has(c.item_key) ? false : (seen.add(c.item_key), true)));
    const items = unique.map((c) => scoreItem(identity, p, c)).sort(compareItems);
    const bySku = new Map(unique.map((c) => [c.item_key, new Map(c.skus.map((s) => [s.sku_key, s] as const))] as const));
    settleTie(items, bySku);
    items.sort(compareItems);
    sources.push({ source, best: items.find((m) => !m.refused) ?? null, items });
  }
  return { product_id: identity.product_id, sources };
}

// ---------------------------------------------------------------- across captures

export interface ConfirmedRef {
  combo_key: string;
  source: SupplierSource;
  item_key: string;
  sku_key: string;
}

/**
 * A confirmed match is keyed by the supplier's own ids (Tmall item and sku ids, store handles
 * and variant ids), never by a snapshot: a new capture re-attaches it with the new price. A
 * key missing from the newest complete snapshot comes back with `sku: null`
 * (EST_SOURCE_ITEM_MISSING).
 */
export function carryConfirmed(refs: readonly ConfirmedRef[], items: readonly CatalogueItem[]): Array<{ ref: ConfirmedRef; sku: CatalogueSku | null }> {
  const index = new Map<string, CatalogueSku>();
  for (const it of items) for (const s of it.skus) index.set(`${it.source}\u0000${it.item_key}\u0000${s.sku_key}`, s);
  return refs.map((ref) => ({ ref, sku: index.get(`${ref.source}\u0000${ref.item_key}\u0000${ref.sku_key}`) ?? null }));
}

// ---------------------------------------------------------------- the product's lookup keys

/** The keys a product looks its candidates up by (ix_spk_lookup): strongest first. */
export function productKeysOf(identity: MatchIdentity): Array<{ key_type: 'variant_id' | 'sku_code' | 'part_code' | 'color_code' | 'handle' | 'model_token' | 'name_token'; key_value: string }> {
  const out: Array<{ key_type: 'variant_id' | 'sku_code' | 'part_code' | 'color_code' | 'handle' | 'model_token' | 'name_token'; key_value: string }> = [];
  const seen = new Set<string>();
  const add = (key_type: (typeof out)[number]['key_type'], value: string) => {
    const k = `${key_type}\u0000${value}`;
    if (value && value.length <= 120 && !seen.has(k)) {
      seen.add(k);
      out.push({ key_type, key_value: value });
    }
  };
  const p = productFacts(identity);
  for (const s of identity.skus) for (const v of s.variant_ids ?? []) add('variant_id', String(v));
  for (const s of identity.skus) for (const c of s.sku_codes ?? []) add('sku_code', String(c).toUpperCase());
  for (const set of p.trustedCodes) for (const x of set.parts) add('part_code', x.code);
  for (const x of p.nameCodes) add('part_code', x.code);
  for (const c of p.colourValues) if (c) add('color_code', c);
  if (identity.handle) add('handle', String(identity.handle));
  for (const m of p.models) add('model_token', m.toLowerCase());
  for (const m of p.materials) add('name_token', m.toLowerCase());
  for (const w of p.nameTokens) add('name_token', w);
  return out;
}
