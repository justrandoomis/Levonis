/**
 * MEDIA AT FOUR LEVELS, ONE BINDING PER ROW, BINARY REUSE (spec §C.4).
 *
 * The brief's rule (§5, R6): for an explicit selection, show that selection's
 * images and the general ones, and never an image bound to another value of
 * a chosen group. Every image the source ties to a variant is bound, the
 * primary included. The runner computes this for /stage; the Worker
 * recomputes it at /write from the payload and its own ingested media, so the
 * content-duplicate step uses server-side object keys (`contentKey`).
 *
 * Swatches are never gallery rows: a 128-px colour sample can never become a
 * card or gallery image.
 */
import { H } from './hash';
import type { OptionModel, ModelVariant } from './options';
import type { SourceMedia } from './extract';
import { altText, type Tri } from './registry/labels';

export type BindingRule = 'general' | 'value' | 'value_set' | 'variant' | 'representative' | 'content_duplicate' | 'reviewed_override';

export type Binding = { kind: 'p' } | { kind: 'v'; valueId: string } | { kind: 'x'; variantId: string } | { kind: 'r'; valueId: string };

export interface ImageRow {
  /** `pi_` + H(product_id + ':' + resourceFileId + ':' + binding) (§B.8). */
  id: string;
  resourceFileId: string;
  /** The original source URL (owner-only provenance once ingested). */
  url: string;
  galleryIndex: number;
  binding: Binding;
  rule: BindingRule;
  optionValueId: string | null;
  variantId: string | null;
  isPrimary: boolean;
  sortOrder: number;
  alt: Tri;
}

export interface SwatchRow {
  valueId: string;
  /** source_media_id of catalog_import_media: 'swatch:' + the source value id. */
  sourceMediaId: string;
  url: string;
}

export interface MediaOverride {
  resourceFileId: string;
  valueIds?: readonly string[];
  variantIds?: readonly string[];
}

export interface MediaReport {
  /** Variants whose hero image is shared with siblings that differ in another group. */
  sharesImageWithSiblings: string[];
  /** Representative and content-duplicate bindings, with their rule. */
  derivedBindings: Array<{ rowId: string; rule: BindingRule; resourceFileId: string }>;
  /** Gallery entries collapsed into an earlier copy: [later resourceFileId, kept resourceFileId]. */
  collapsed: Array<[string, string]>;
  /** Same file name as a bound image but different content: never bound, listed for review (image_review). */
  reviewList: string[];
  /** Variant heroes that are not in the gallery at all (never seen in the sample; reported, not invented). */
  heroesNotInGallery: string[];
}

export interface MediaPlan {
  rows: ImageRow[];
  swatches: SwatchRow[];
  report: MediaReport;
}

export interface MediaInputs {
  productId: string;
  title: string;
  gallery: readonly SourceMedia[];
  model: OptionModel;
  /** The stored object key (or content hash) of a gallery entry, when ingested. */
  contentKey?: (resourceFileId: string) => string | undefined;
  /** Reviewed bindings for images the source does not tie to anything (data/bambu-import/media-overrides.json). */
  overrides?: readonly MediaOverride[];
}

export const bindingToken = (b: Binding): string =>
  b.kind === 'p' ? 'p' : b.kind === 'v' ? `v:${b.valueId}` : b.kind === 'x' ? `x:${b.variantId}` : `r:${b.valueId}`;

export const imageRowId = (productId: string, resourceFileId: string, b: Binding): string =>
  `pi_${H(`${productId}:${resourceFileId}:${bindingToken(b)}`)}`;

const fileName = (url: string) => (url.split('?')[0].split('/').pop() ?? '').toLowerCase();

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Builds the gallery rows, swatches and the binding report of one product. */
export function planMedia(inp: MediaInputs): MediaPlan {
  const { model, gallery, productId } = inp;
  const report: MediaReport = { sharesImageWithSiblings: [], derivedBindings: [], collapsed: [], reviewList: [], heroesNotInGallery: [] };
  const galleryIds = new Set(gallery.map((g) => g.resourceFileId));
  const galleryUrls = new Map(gallery.map((g) => [g.url, g.resourceFileId]));

  // Which variants name each gallery entry as their hero (by id, else by URL).
  const heroOf = new Map<string, Set<string>>();
  for (const v of model.variants) {
    let rid = v.heroResourceFileId ?? '';
    if (!galleryIds.has(rid) && v.heroUrl && galleryUrls.has(v.heroUrl)) rid = galleryUrls.get(v.heroUrl)!;
    if (!rid || !galleryIds.has(rid)) {
      if (v.heroResourceFileId || v.heroUrl) report.heroesNotInGallery.push(v.id);
      continue;
    }
    const set = heroOf.get(rid) ?? new Set<string>();
    set.add(v.id);
    heroOf.set(rid, set);
  }

  // 1. Content duplicates collapse into the earliest position.
  const canonicalOf = new Map<string, string>();
  const keyFirst = new Map<string, string>();
  if (inp.contentKey) {
    for (const g of gallery) {
      const key = inp.contentKey(g.resourceFileId);
      if (!key) continue;
      const first = keyFirst.get(key);
      if (first && first !== g.resourceFileId) {
        canonicalOf.set(g.resourceFileId, first);
        report.collapsed.push([g.resourceFileId, first]);
      } else if (!first) keyFirst.set(key, g.resourceFileId);
    }
  }
  const viaCopy = new Set<string>(); // canonical ids that received a binding from a later copy
  for (const [copy, canonical] of canonicalOf) {
    const fromCopy = heroOf.get(copy);
    if (!fromCopy?.size) continue;
    const set = heroOf.get(canonical) ?? new Set<string>();
    const before = set.size;
    for (const v of fromCopy) set.add(v);
    heroOf.set(canonical, set);
    if (set.size > before) viaCopy.add(canonical);
    heroOf.delete(copy);
  }
  // Same file name as a bound image, different content: review, never bound.
  if (inp.contentKey) {
    const boundNames = new Map<string, string>();
    for (const g of gallery) if (heroOf.get(g.resourceFileId)?.size) boundNames.set(fileName(g.url), inp.contentKey(g.resourceFileId) ?? '');
    for (const g of gallery) {
      if (canonicalOf.has(g.resourceFileId) || heroOf.get(g.resourceFileId)?.size) continue;
      const boundKey = boundNames.get(fileName(g.url));
      if (boundKey !== undefined && boundKey !== (inp.contentKey(g.resourceFileId) ?? '')) report.reviewList.push(g.resourceFileId);
    }
  }

  const variantsOfValue = new Map<string, Set<string>>();
  for (const g of model.groups) for (const val of g.values) variantsOfValue.set(val.id, new Set(model.variants.filter((v) => v.valueIds.includes(val.id)).map((v) => v.id)));
  const groupOfValue = new Map<string, string>();
  for (const g of model.groups) for (const val of g.values) groupOfValue.set(val.id, g.id);
  const variantById = new Map(model.variants.map((v) => [v.id, v]));

  const rows: ImageRow[] = [];
  const valuesWithRow = new Set<string>();
  const push = (g: SourceMedia, index: number, binding: Binding, rule: BindingRule, selection = '') => {
    const optionValueId = binding.kind === 'v' || binding.kind === 'r' ? binding.valueId : null;
    const variantId = binding.kind === 'x' ? binding.variantId : null;
    if (optionValueId && binding.kind === 'v') valuesWithRow.add(optionValueId);
    rows.push({
      id: imageRowId(productId, g.resourceFileId, binding),
      resourceFileId: g.resourceFileId,
      url: g.url,
      galleryIndex: index,
      binding,
      rule,
      optionValueId,
      variantId,
      isPrimary: false,
      sortOrder: 0,
      alt: altText(inp.title, selection),
    });
  };
  const valueLabel = (id: string) => model.groups.flatMap((g) => g.values).find((v) => v.id === id)?.nameEn ?? '';
  const variantLabel = (v: ModelVariant) => v.valueIds.map(valueLabel).join(' / ');

  // 2. Bind every remaining gallery image (index 0 included).
  gallery.forEach((g, index) => {
    if (canonicalOf.has(g.resourceFileId)) return;
    const V = heroOf.get(g.resourceFileId) ?? new Set<string>();
    const dupRule = (r: BindingRule): BindingRule => (viaCopy.has(g.resourceFileId) ? 'content_duplicate' : r);
    if (V.size === 0) {
      const ov = inp.overrides?.find((o) => o.resourceFileId === g.resourceFileId);
      if (ov && (ov.valueIds?.length || ov.variantIds?.length)) {
        for (const id of ov.valueIds ?? []) push(g, index, { kind: 'v', valueId: id }, 'reviewed_override', valueLabel(id));
        for (const id of ov.variantIds ?? []) {
          const v = variantById.get(id);
          push(g, index, { kind: 'x', variantId: id }, 'reviewed_override', v ? variantLabel(v) : '');
        }
      } else {
        push(g, index, { kind: 'p' }, 'general');
      }
      return;
    }
    if (V.size === 1) {
      const vid = [...V][0];
      push(g, index, { kind: 'x', variantId: vid }, dupRule('variant'), variantLabel(variantById.get(vid)!));
      return;
    }
    // One value whose variant set is exactly V: prefer a colour group, then the earlier group.
    const single: Array<{ valueId: string; kind: string; position: number }> = [];
    for (const grp of model.groups) {
      for (const val of grp.values) {
        if (sameSet(variantsOfValue.get(val.id)!, V)) single.push({ valueId: val.id, kind: grp.kind, position: grp.position });
      }
    }
    if (single.length) {
      single.sort((a, b) => (a.kind === 'color' ? 0 : 1) - (b.kind === 'color' ? 0 : 1) || a.position - b.position);
      const id = single[0].valueId;
      push(g, index, { kind: 'v', valueId: id }, dupRule('value'), valueLabel(id));
      return;
    }
    // The union of a set of values of ONE group.
    for (const grp of model.groups) {
      const S = grp.values.filter((val) => {
        const set = variantsOfValue.get(val.id)!;
        return set.size > 0 && [...set].every((x) => V.has(x));
      });
      const union = new Set(S.flatMap((val) => [...variantsOfValue.get(val.id)!]));
      if (S.length >= 2 && sameSet(union, V)) {
        for (const val of S) push(g, index, { kind: 'v', valueId: val.id }, dupRule('value_set'), val.nameEn);
        return;
      }
    }
    // Otherwise one row per variant, in SKU order.
    for (const v of model.variants) if (V.has(v.id)) push(g, index, { kind: 'x', variantId: v.id }, dupRule('variant'), variantLabel(v));
  });

  // 3. A representative image for every value of a group with ≥ 2 values that has no row of its own.
  const galleryById = new Map(gallery.map((g, i) => [g.resourceFileId, { g, i }]));
  const canonicalId = (rid: string) => canonicalOf.get(rid) ?? rid;
  for (const grp of model.groups) {
    if (grp.values.length < 2) continue;
    for (const val of grp.values) {
      if (valuesWithRow.has(val.id)) continue;
      const v = representativeVariant(model, val.id);
      if (!v) continue;
      let rid = v.heroResourceFileId ?? '';
      if (!galleryById.has(rid) && v.heroUrl && galleryUrls.has(v.heroUrl)) rid = galleryUrls.get(v.heroUrl)!;
      const hit = galleryById.get(canonicalId(rid));
      if (!hit) continue;
      push(hit.g, hit.i, { kind: 'r', valueId: val.id }, 'representative', val.nameEn);
    }
  }

  // 4. Order: gallery position, then the order rows were made; the primary is the first row of gallery index 0.
  rows.sort((a, b) => a.galleryIndex - b.galleryIndex);
  rows.forEach((r, i) => (r.sortOrder = i));
  const first = rows.find((r) => r.galleryIndex === 0) ?? rows[0];
  if (first) first.isPrimary = true;

  for (const r of rows) if (r.rule === 'representative' || r.rule === 'content_duplicate') report.derivedBindings.push({ rowId: r.id, rule: r.rule, resourceFileId: r.resourceFileId });

  // Report: variants sharing their hero with siblings that differ in another group.
  for (const [, V] of heroOf) {
    if (V.size < 2) continue;
    const vs = [...V].map((id) => variantById.get(id)!).filter(Boolean);
    for (const a of vs) {
      if (vs.some((b) => b !== a && differsOutside(a, b, groupOfValue))) report.sharesImageWithSiblings.push(a.id);
    }
  }
  report.sharesImageWithSiblings.sort();

  // Swatches: one per colour value with a published swatch.
  const swatches: SwatchRow[] = [];
  for (const grp of model.groups) {
    for (const val of grp.values) {
      if (!val.colorUrl) continue;
      swatches.push({ valueId: val.id, sourceMediaId: `swatch:${val.sourceId}`, url: val.colorUrl });
    }
  }
  return { rows, swatches, report };
}

/** Two variants of one shared image that are not the same selection: they differ in at least one group. */
function differsOutside(a: ModelVariant, b: ModelVariant, groupOfValue: ReadonlyMap<string, string>): boolean {
  const byGroup = (v: ModelVariant) => new Map(v.valueIds.map((id) => [groupOfValue.get(id), id]));
  const ga = byGroup(a);
  const gb = byGroup(b);
  for (const [g, id] of ga) if (gb.get(g) !== id) return true;
  return false;
}

/**
 * The variant reached by a value plus the `selectedDefault` of the other
 * groups; else the first variant containing the value, in SKU order.
 */
export function representativeVariant(model: OptionModel, valueId: string): ModelVariant | null {
  const group = model.groups.find((g) => g.values.some((v) => v.id === valueId));
  if (!group) return null;
  const want = [valueId, ...model.groups.filter((g) => g !== group && g.defaultValueId).map((g) => g.defaultValueId)].sort();
  const exact = model.variants.find((v) => v.valueIds.length === want.length && [...v.valueIds].sort().every((id, i) => id === want[i]));
  return exact ?? model.variants.find((v) => v.valueIds.includes(valueId)) ?? null;
}

// ---------------------------------------------------------------- the selection rule the client applies (§G.3)

/** A selection: at most one value per group. */
export type Selection = readonly string[];

/**
 * Whether an image row contradicts a selection (§G.3 step 1): it is bound to
 * a value of a group in which another value is selected; or to a variant
 * whose combination contains such a value; or to a value that forms no
 * variant at all with the selection (an impossible combination — the page
 * shows that value disabled, so its picture must not lead or linger).
 * Unbound rows never contradict.
 */
export function contradicts(row: Pick<ImageRow, 'optionValueId' | 'variantId'>, model: OptionModel, selection: Selection): boolean {
  if (!selection.length) return false;
  const groupOf = new Map<string, string>();
  for (const g of model.groups) for (const v of g.values) groupOf.set(v.id, g.id);
  const chosen = new Map<string, string>();
  for (const id of selection) {
    const g = groupOf.get(id);
    if (g) chosen.set(g, id);
  }
  const clash = (valueId: string) => {
    const g = groupOf.get(valueId);
    return !!g && chosen.has(g) && chosen.get(g) !== valueId;
  };
  if (row.variantId) {
    const v = model.variants.find((x) => x.id === row.variantId);
    return !!v && v.valueIds.some(clash);
  }
  if (row.optionValueId) {
    if (clash(row.optionValueId)) return true;
    const others = [...chosen.entries()].filter(([g]) => g !== groupOf.get(row.optionValueId!)).map(([, id]) => id);
    return !model.variants.some((v) => v.valueIds.includes(row.optionValueId!) && others.every((id) => v.valueIds.includes(id)));
  }
  return false;
}
