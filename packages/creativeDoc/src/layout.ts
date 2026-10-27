/**
 * THE LAYOUT ENGINE (spec §12, §14, §24).
 *
 * `buildFromTemplate` turns a template variant + the real copy + the real
 * product picture + a format into absolute layers. It measures the real text
 * with the browser's measurer (the Worker never lays out: it has no canvas),
 * gives the product what height is left inside its band, and, when the words
 * do not fit, shrinks LOWER-PRIORITY text toward its readable floor, then
 * drops optional blocks, and only then reports a conflict — it never
 * shrinks text below the brand floor and never overlaps silently.
 *
 * `relayoutDependents` is what keeps one edit local: after a layer changes,
 * only the layers whose relations point at it (transitively) move. A
 * headline edit never moves the product, the background or the price
 * (spec §16: «غيّر العنوان فقط»).
 *
 * `detectConflicts` + `resolveConflict` implement "show real options, keep
 * the previous state until one is chosen" (spec §14).
 *
 * `changeFormat` re-lays a document out for another size from the same
 * template, copy and bindings — it never scales a finished picture (spec §24).
 */
import { inPalette, kitScale, MIN_FONT_PX, safeAreaFor, scaledSpacing, scaledType, type BackgroundPreset, type BrandKit } from './brand';
import {
  findLayer, intersects, layerBox, lockedAbove, safeBox, SCHEMA_VERSION, touchesLock, unionBox, withDescendants, contains,
  type AdLocale, type Box, type Corner, type CreativeDocument, type Density, type DocFormat, type ImageLayer, type Layer,
  type LayerRole, type Objective, type Relation, type ShapeLayer, type TextLayer, type TextSource, BRAND_TEXT, type Gradient, type FontFamilyId, type FontWeight,
} from './schema';
import {
  localized, renderAvailability, renderPrice, type ProductSnapshot, type ServiceClaimText, type SnapshotImage,
} from './snapshot';
import {
  FAMILIES, GRID_PRODUCTS, TEMPLATES, defaultCta, type BuildEvidence, type FamilyId, type ProductBlock, type StackBlock, type TemplateId,
  type TextBlock, type VariantDef, type VariantId,
} from './templates';
import { detectDirection, fitText, groupInteger, toDigits, type TextMeasurer } from './text';
import { FONT_REGISTRY } from './schema';

// ---------------------------------------------------------------------------
// Bound text
// ---------------------------------------------------------------------------

export interface BindingContext {
  /** By product binding slot. */
  snapshots: Readonly<Record<string, Pick<ProductSnapshot, 'id' | 'data' | 'source'>>>;
  /** By claim id. */
  claims: Readonly<Record<string, ServiceClaimText>>;
  brand: Pick<BrandKit, 'digits' | 'currency_label'>;
  locale: AdLocale;
  slide: { index: number; count: number } | null;
}

/**
 * The words a bound text layer draws, from data — or null when the data is
 * missing (the quality check reports it; nothing is invented to fill it).
 */
export function renderSource(source: TextSource, ctx: BindingContext): string | null {
  switch (source.kind) {
    case 'free':
      return null;
    case 'brand':
      return BRAND_TEXT[source.field][ctx.locale];
    case 'slide_number':
      return ctx.slide ? toDigits(`${ctx.slide.index}/${ctx.slide.count}`, ctx.brand.digits) : null;
    case 'service': {
      const c = ctx.claims[source.claim_id];
      if (!c) return null;
      return localized(source.field === 'title' ? c.title : source.field === 'summary' ? c.summary : c.conditions, ctx.locale) || null;
    }
    case 'product': {
      const s = ctx.snapshots[source.slot];
      if (!s) return null;
      const opts = { locale: ctx.locale, digits: ctx.brand.digits, label: ctx.brand.currency_label };
      switch (source.field) {
        case 'name': return localized(s.data.name, ctx.locale) || null;
        case 'brand': return localized(s.data.brand, ctx.locale) || null;
        case 'variant': return localized(s.data.variant_label, ctx.locale) || null;
        case 'model': return modelName(s.data, ctx.locale);
        case 'price_amount': return priceAmount(s, ctx.brand.digits);
        case 'price': return renderPrice(s, opts).text;
        case 'price_note': return renderPrice(s, opts).was;
        case 'availability': return renderAvailability(s, ctx.locale);
      }
    }
  }
  return null;
}

/**
 * The model part of a product's name: the bound variant's own label when the
 * snapshot is of one option ("X2D Combo"), otherwise the name with its brand
 * prefix taken off ("Bambu Lab A1 Combo" → "A1 Combo"). Data only — null when
 * nothing is left, so the checks report it instead of inventing words.
 */
export function modelName(d: ProductSnapshot['data'], locale: AdLocale): string | null {
  const variant = localized(d.variant_label, locale).trim();
  if (variant) return variant;
  const name = localized(d.name, locale).trim();
  // The brand as any of its spellings ("Bambu Lab" inside an Arabic name too); a name that does not start with it has no model part.
  const spellings = d.brand ? [...new Set([d.brand.ar, d.brand.en, d.brand.ckb].map((b) => (b ?? '').trim()).filter(Boolean))] : [];
  const lead = spellings.find((b) => name.toLowerCase().startsWith(b.toLowerCase()));
  return lead ? name.slice(lead.length).trim() || null : null;
}

/** The plain amount of a priced product ("2,027,000") — only for a plain price: a "from" or offer line keeps its words. */
export function priceAmount(s: Pick<ProductSnapshot, 'data' | 'source'>, digits: BrandKit['digits']): string | null {
  const p = s.data.price;
  if (s.source === 'test' || p.status !== 'priced' || p.amount_iqd === null || p.from) return null;
  return groupInteger(p.amount_iqd, digits);
}

/**
 * Re-render every bound text layer from the binding context (on open, after
 * re-verification). The stored words are never kept as the value: when the
 * snapshot or claim is there but renders nothing (a "was" line without a live
 * offer, an unknown availability, a missing translation) the layer becomes
 * empty, so `bound_text_missing` fires instead of the old words being drawn.
 * Only data that is not loaded at all leaves the layer as it is (the checks
 * report the missing binding). Service text renders only from the claim
 * version the design is bound to: a newer approved version never rewrites a
 * design in the background (spec §19) — `claim_changed` asks for a person.
 */
export function refreshBoundText(doc: CreativeDocument, ctx: BindingContext): CreativeDocument {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.type !== 'text' || l.source.kind === 'free') return l;
      const src = l.source;
      if (src.kind === 'service') {
        const bound = doc.services.find((s) => s.claim_id === src.claim_id);
        const claim = ctx.claims[src.claim_id];
        if (!bound || !claim || claim.version !== bound.claim_version) return l;
      }
      const t = renderSource(src, ctx);
      if (t === null) {
        const loaded = src.kind === 'service' || (src.kind === 'product' && !!ctx.snapshots[src.slot]);
        return loaded && l.text ? { ...l, text: '' } : l;
      }
      return t === l.text ? l : { ...l, text: t };
    }),
  };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export type ConflictCode = 'content_too_long' | 'text_overflow' | 'outside_safe_area' | 'overlap' | 'product_too_small';
export type ConflictOption = 'shorten_text' | 'reduce_font' | 'grow_box' | 'shrink_product' | 'switch_density' | 'switch_variant' | 'split_carousel' | 'move_layer' | 'revert';

export interface LayoutConflict {
  code: ConflictCode;
  layer_ids: string[];
  options: ConflictOption[];
}

/** Roles whose box must stay inside the safe area. */
export const ESSENTIAL_ROLES: ReadonlySet<LayerRole> = new Set(['headline', 'product', 'product_name', 'price', 'cta', 'logo', 'availability', 'price_note']);
/** Roles that may sit under or behind others. */
const BACKDROP_ROLES: ReadonlySet<LayerRole> = new Set(['background', 'product_shadow', 'decor']);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildProduct {
  slot: string;
  snapshot: Pick<ProductSnapshot, 'id' | 'data' | 'source'>;
  /**
   * The chosen picture — it must belong to this product/variant and be same-origin. Null when a
   * person removed the picture from the design: the product's bound words are still drawn.
   */
  image: (Pick<SnapshotImage, 'url'> & { width: number; height: number; bounds?: Box | null }) | null;
}

export interface BuildCopy {
  headline: string;
  subhead?: string;
  body?: string;
  cta?: string;
  badge?: string;
  features?: string[];
}

export interface BuildInput {
  template: TemplateId;
  variant: VariantId;
  format: DocFormat;
  locale: AdLocale;
  objective: Objective;
  density: Density;
  brand: BrandKit;
  brandVersion: number | null;
  products: BuildProduct[];
  service: ServiceClaimText | null;
  copy: BuildCopy;
  evidence: BuildEvidence;
  family: FamilyId | null;
  /** The logo's natural size, or null for no logo layer. */
  logo: { width: number; height: number } | null;
  /** An asset background's natural size (solid presets need none). */
  backgroundNatural: { width: number; height: number } | null;
  /** Override the brand's default background. */
  background?: BackgroundPreset | null;
  /** Template blocks, by the layer id they would get, that a person removed: left out, never regenerated (a deleted CTA stays deleted). */
  omit?: readonly string[];
  slide: { index: number; count: number } | null;
  caption: string;
  alt_text: string;
  measure: TextMeasurer;
}

export interface BuildResult {
  doc: CreativeDocument;
  conflicts: LayoutConflict[];
  /** Optional blocks left out for lack of room (by id), so the UI can say so. */
  dropped: string[];
}

interface TextItem {
  kind: 'text';
  id: string;
  block: TextBlock;
  text: string;
  source: TextSource;
  family: TextLayer['font']['family'];
  weight: TextLayer['font']['weight'];
  lineHeight: number;
  maxSize: number;
  minSize: number;
  size: number;
  height: number;
  lineWidth: number;
  gapAfter: number;
  color: string;
  chip: { fill: string; padX: number; padY: number } | null;
  /** Box height including the chip padding. */
  outer: number;
}

interface ProductItem {
  kind: 'product';
  id: string;
  block: ProductBlock;
  product: BuildProduct;
  /** The picture drawn (a product item exists only when there is one). */
  image: NonNullable<BuildProduct['image']>;
  gapAfter: number;
  height: number;
  width: number;
  scale: number;
}

type Item = TextItem | ProductItem;

const suffix = (slot: string) => (slot === 'main' ? '' : `_${slot}`);

function textOf(block: TextBlock, input: BuildInput, bind: BindingContext, slotOverride?: string): { text: string; source: TextSource }[] {
  const t = block.text;
  const c = input.copy;
  switch (t.source) {
    case 'copy': {
      if (t.slot === 'features') return (c.features ?? []).map((f) => ({ text: f, source: { kind: 'free' } as TextSource }));
      if (t.slot === 'badge') {
        // A badge is a claim: the family's words, only with the family's evidence; otherwise only words a person wrote.
        const fam = input.family ? FAMILIES[input.family] : null;
        if (c.badge) return [{ text: c.badge, source: { kind: 'free' } }];
        if (fam?.badge && input.evidence[fam.badge.needs]) return [{ text: fam.badge.text[input.locale], source: { kind: 'free' } }];
        return [];
      }
      if (t.slot === 'cta') {
        const main = input.products[0]?.snapshot.data;
        const text = c.cta || defaultCta(main ? main.availability : null, main ? main.price.status : null, input.locale);
        return [{ text, source: { kind: 'free' } }];
      }
      const v = t.slot === 'headline' ? c.headline : t.slot === 'subhead' ? c.subhead : c.body;
      return v ? [{ text: v, source: { kind: 'free' } }] : [];
    }
    case 'product': {
      const slot = slotOverride ?? t.productSlot ?? 'main';
      const field = t.slot === 'product_name' ? 'name' : t.slot;
      const source: TextSource = { kind: 'product', slot, field };
      const text = renderSource(source, bind);
      return text ? [{ text, source }] : [];
    }
    case 'service': {
      if (!input.service) return [];
      const field = t.slot === 'service_title' ? 'title' : t.slot === 'service_summary' ? 'summary' : 'conditions';
      const source: TextSource = { kind: 'service', claim_id: input.service.id, field };
      const text = renderSource(source, bind);
      return text ? [{ text, source }] : [];
    }
    case 'slide': {
      const source: TextSource = { kind: 'slide_number' };
      const text = renderSource(source, bind);
      return text ? [{ text, source }] : [];
    }
  }
}

function baseIdOf(block: TextBlock): string {
  const s = block.text.slot;
  switch (s) {
    case 'features': return 'feature';
    case 'service_title': return 'service_title';
    case 'service_summary': return 'service_summary';
    case 'service_conditions': return 'service_conditions';
    default: return s;
  }
}

function colorFor(role: LayerRole, kit: BrandKit): string {
  switch (role) {
    case 'headline': case 'product_name': return kit.colors.text;
    case 'price': return kit.colors.price;
    case 'cta': return kit.colors.accent_text;
    case 'badge': return kit.colors.text;
    default: return kit.colors.text_muted;
  }
}

function makeTextItems(blocks: readonly StackBlock[], input: BuildInput, bind: BindingContext, slot: string | null, docWidth: number, colWidth: number, dropped: string[]): Item[] {
  const sp = scaledSpacing(input.brand, input.format.width, input.format.height);
  const gap = (g: 'small' | 'medium' | 'large') => (g === 'small' ? sp.small : g === 'medium' ? sp.medium : sp.large);
  const out: Item[] = [];
  for (const block of blocks) {
    if (block.kind === 'product') {
      const pslot = slot ?? block.productSlot;
      const product = input.products.find((p) => p.slot === pslot);
      const id = `product${suffix(pslot)}`;
      if (!product || !product.image || input.omit?.includes(id)) continue;
      out.push({ kind: 'product', id, block, product, image: product.image, gapAfter: gap(block.gapAfter), height: 0, width: 0, scale: 0 });
      continue;
    }
    if (block.detailedOnly && input.density === 'brief') continue;
    const entries = textOf(block, input, bind, block.text.source === 'product' ? (slot ?? undefined) : undefined);
    const style = scaledType(input.brand, block.type, input.format.width, input.format.height);
    const maxCount = block.text.slot === 'features' ? Math.min(input.brand.density.max_features, input.density === 'brief' ? 2 : input.brand.density.max_features) : 1;
    if (block.text.slot === 'features' && entries.length > maxCount) for (let i = maxCount; i < entries.length; i++) dropped.push(`feature_${i + 1}`);
    entries.slice(0, maxCount).forEach((e, i, arr) => {
      const base = baseIdOf(block);
      const id = block.text.slot === 'features' ? `feature_${i + 1}` : `${base}${block.text.source === 'product' && slot ? suffix(slot) : ''}`;
      if (input.omit?.includes(id)) return;
      const size = Math.max(MIN_FONT_PX, Math.round(style.size * block.boost));
      const chip = block.chip
        ? { fill: block.role === 'cta' ? input.brand.colors.accent : input.brand.colors.surface, padX: Math.round(size * 0.9), padY: Math.round(size * 0.42) }
        : null;
      const isLast = i === arr.length - 1;
      out.push({
        kind: 'text', id, block, text: e.text, source: e.source, family: style.family,
        weight: FONT_REGISTRY[style.family].weights.includes(style.weight) ? style.weight : FONT_REGISTRY[style.family].weights[FONT_REGISTRY[style.family].weights.length - 1],
        lineHeight: style.lineHeight, maxSize: size, minSize: Math.min(size, style.min), size, height: 0, lineWidth: 0,
        gapAfter: isLast ? gap(block.gapAfter) : sp.small, color: colorFor(block.role, input.brand), chip, outer: 0,
      });
    });
    void colWidth;
    void docWidth;
  }
  return out;
}

function fitItem(it: TextItem, colWidth: number, maxSize: number, measure: TextMeasurer): boolean {
  const avail = colWidth - (it.chip ? it.chip.padX * 2 : 0);
  const r = fitText(it.text, { family: FONT_REGISTRY[it.family].family, weight: it.weight, lineHeight: it.lineHeight }, { width: avail, maxHeight: it.block.maxLines * maxSize * it.lineHeight, maxLines: it.block.maxLines }, { max: maxSize, min: it.minSize }, measure);
  it.size = r.size;
  it.height = r.height;
  it.lineWidth = r.width;
  it.outer = r.height + (it.chip ? it.chip.padY * 2 : 0);
  return r.fits;
}

function stackHeight(items: readonly Item[]): number {
  let h = 0;
  items.forEach((it, i) => {
    h += it.kind === 'text' ? it.outer : it.height;
    if (i < items.length - 1) h += it.gapAfter;
  });
  return h;
}

/**
 * Lay one column out. Returns the items with sizes, the drawn product, the
 * blocks it had to drop, whether the content fit at all, and — when it did
 * not — whose fault it is: words that do not fit even at their floor
 * (`overflowIds`), or a product that cannot reach its share of the height
 * (`short`, its id).
 */
function solveColumn(items: Item[], area: Box, measure: TextMeasurer, dropped: string[]): { items: Item[]; fits: boolean; overflowIds: string[]; short: string | null } {
  const overflowIds: string[] = [];
  let live = items.slice();
  for (const it of live) if (it.kind === 'text' && !fitItem(it, area.width, it.maxSize, measure)) overflowIds.push(it.id);
  const product = live.find((i): i is ProductItem => i.kind === 'product');
  // The product's share of the height is capped by what its column WIDTH lets it reach: a wide
  // picture in a narrow column cannot use more height, so text never shrinks for room it would
  // not fill, and a width-bound picture is not a "content too long" conflict.
  const widthCap = product ? ((area.width * product.block.widthFrac) / product.image.width) * product.image.height : 0;
  const minProduct = product ? Math.min(product.block.minFrac * area.height, widthCap) : 0;

  const textAndGaps = () => stackHeight(live.filter((i) => i.kind === 'text')) + live.filter((i) => i.kind === 'product').reduce((a, i) => a + i.gapAfter, 0);
  // Crowding is solved in the brief's order (spec §8): first a gentle size step on the
  // lower-priority words (down to 85 %), then a change of COMPOSITION — optional blocks
  // leave, lowest priority first — and only then sizes go down to the readable floor.
  const byKeep = () => live.filter((i): i is TextItem => i.kind === 'text').sort((a, b) => a.block.keep - b.block.keep);
  const tight = () => area.height - textAndGaps() < minProduct;
  const shrinkTo = (floorOf: (i: TextItem) => number) => {
    let guard = 0;
    while (tight() && guard++ < 60) {
      const it = byKeep().find((i) => i.size > floorOf(i));
      if (!it) return;
      fitItem(it, area.width, Math.max(floorOf(it), Math.round(it.size * 0.92)), measure);
    }
  };
  const dropWhileTight = (maxKeep: number) => {
    while (tight()) {
      const droppable = byKeep().find((i) => i.block.optional && i.block.keep <= maxKeep);
      if (!droppable) return;
      dropped.push(droppable.id);
      live = live.filter((i) => i !== droppable);
    }
  };
  shrinkTo((i) => Math.max(i.minSize, Math.round(i.maxSize * 0.85)));
  // Low-priority extras leave first; a high-priority optional block (an evidence-backed badge)
  // leaves only after every size has reached its floor.
  dropWhileTight(6);
  shrinkTo((i) => i.minSize);
  dropWhileTight(Infinity);
  const remaining = area.height - textAndGaps();
  let fits = remaining >= minProduct - 0.5;
  let short: string | null = null;
  if (product) {
    const { width: nw, height: nh } = product.image;
    const maxH = Math.max(0, Math.min(product.block.maxFrac * area.height, remaining));
    const maxW = area.width * product.block.widthFrac;
    if (product.block.minFrac === 0 && maxH < area.height * 0.12) {
      // A supporting picture (a lesson slide) that has no room is left out, not squeezed.
      dropped.push(product.id);
      live = live.filter((i) => i !== product);
    } else {
      // Never a zero (or negative) scale, whatever is left: normalize's own floor is the least a picture is drawn at.
      const scale = Math.max(0.01, Math.min(maxW / nw, Math.max(maxH, area.height * 0.08) / nh, 2.5));
      product.scale = scale;
      product.width = nw * scale;
      product.height = nh * scale;
      if (product.height < minProduct - 0.5) {
        fits = false;
        short = product.id;
      }
    }
  }
  if (stackHeight(live) > area.height + 0.5) fits = false;
  return { items: live, fits, overflowIds, short };
}

interface Placement {
  item: Item;
  x: number;
  y: number;
  colX: number;
  colWidth: number;
  /**
   * The column it was laid out in: `main` for a one-column stack (and a split's words), a
   * product slot for a pair's product columns, `top`/`bottom` for a pair's full-width rows.
   * The relations chain the blocks of ONE column — a full-width headline is never tied to a
   * product's column just because the two start at the same x.
   */
  col: string;
}

function placeColumn(items: readonly Item[], area: Box, justify: VariantDef['justify'], col = 'main'): Placement[] {
  const used = stackHeight(items);
  const spare = Math.max(0, area.height - used);
  const gaps = Math.max(1, items.length - 1);
  let y = area.y + (justify === 'center' ? spare / 2 : 0);
  const out: Placement[] = [];
  items.forEach((item, i) => {
    const h = item.kind === 'text' ? item.outer : item.height;
    const x = item.kind === 'product' ? area.x + (area.width - item.width) / 2 : area.x;
    out.push({ item, x, y, colX: area.x, colWidth: area.width, col });
    y += h + (i < items.length - 1 ? item.gapAfter + (justify === 'spread' ? spare / gaps : 0) : 0);
  });
  return out;
}

function physicalStart(dir: 'rtl' | 'ltr'): 'left' | 'right' {
  return dir === 'rtl' ? 'right' : 'left';
}

function layersFromPlacements(placements: readonly Placement[], input: BuildInput, dir: 'rtl' | 'ltr'): { layers: Layer[]; relations: Relation[] } {
  const layers: Layer[] = [];
  const relations: Relation[] = [];
  const kit = input.brand;
  for (const p of placements) {
    const it = p.item;
    if (it.kind === 'product') {
      const img: ImageLayer = {
        id: it.id, name: it.id === 'product' ? 'Product' : `Product ${it.product.slot}`, role: 'product', parent: null,
        x: p.x, y: p.y, rotation: 0, opacity: 1, visible: true, locked: false, type: 'image',
        asset: { kind: 'product', ref: it.image.url, slot: it.product.slot },
        natural: { width: it.image.width, height: it.image.height }, crop: null, scale: it.scale, fit: 'whole',
      };
      if (it.block.shadow && kit.shadow.enabled) {
        const sh = shadowGeometry(layerBox(img)!, kit);
        layers.push({
          id: `product_shadow${suffix(it.product.slot)}`, name: 'Product shadow', role: 'product_shadow', parent: null,
          ...sh, rotation: 0, opacity: kit.shadow.opacity, visible: true, locked: false, type: 'shape', shape: 'ellipse',
          fill: '#000000', stroke: null, radius: 0, blur: kit.shadow.blur * kitScale(input.format.width, input.format.height),
        });
        relations.push({ id: `r_shadow${suffix(it.product.slot)}`, kind: 'shadow_of', subject: `product_shadow${suffix(it.product.slot)}`, target: it.id });
      }
      layers.push(img);
      continue;
    }
    const align = it.block.align;
    const text: TextLayer = {
      id: it.id, name: it.id, role: it.block.role, parent: null, x: p.colX, y: p.y, rotation: 0, opacity: 1, visible: true, locked: false,
      type: 'text', text: it.text, source: it.source, width: p.colWidth, height: Math.ceil(it.height),
      font: { family: it.family, weight: it.weight, size: it.size, lineHeight: it.lineHeight }, minSize: it.minSize, maxLines: it.block.maxLines,
      color: it.color, align, direction: 'auto',
    };
    if (it.chip) {
      const w = Math.min(p.colWidth, it.lineWidth + it.chip.padX * 2);
      const start = physicalStart(dir);
      const chipX = align === 'center' ? p.colX + (p.colWidth - w) / 2 : (align === 'start') === (start === 'right') ? p.colX + p.colWidth - w : p.colX;
      const group = `${it.id}_group`;
      layers.push({ id: group, name: `${it.id} group`, role: it.block.role, parent: null, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: false, type: 'group' });
      const chip: ShapeLayer = {
        id: `${it.id}_chip`, name: `${it.id} chip`, role: 'decor', parent: group, x: chipX, y: p.y, rotation: 0, opacity: 1, visible: true, locked: false,
        type: 'shape', shape: 'rect', width: w, height: it.outer, fill: it.chip.fill, stroke: null, radius: Math.round(it.outer / 2), blur: 0,
      };
      layers.push(chip);
      layers.push({ ...text, parent: group, x: chipX + it.chip.padX, y: p.y + it.chip.padY, width: w - it.chip.padX * 2, align: 'center' });
    } else {
      layers.push(text);
    }
  }
  return { layers, relations };
}

export function shadowGeometry(product: Box, kit: Pick<BrandKit, 'shadow'>): { x: number; y: number; width: number; height: number } {
  const width = product.width * kit.shadow.width_ratio;
  const height = Math.max(6, product.width * kit.shadow.height_ratio);
  return { x: product.x + (product.width - width) / 2, y: product.y + product.height - height / 2, width, height };
}

function cornerPosition(corner: Corner, safe: Box, box: { width: number; height: number }, margin: number, dir: 'rtl' | 'ltr'): { x: number; y: number } {
  const startIsRight = dir === 'rtl';
  const isStart = corner === 'top_start' || corner === 'bottom_start';
  const right = isStart === startIsRight;
  const top = corner === 'top_start' || corner === 'top_end';
  return {
    x: right ? safe.x + safe.width - box.width - margin : safe.x + margin,
    y: top ? safe.y + margin : safe.y + safe.height - box.height - margin,
  };
}

/**
 * A side-by-side split suits a square or a 4:5 post; on a tall story the two
 * columns would leave the product a strip of the screen. There the same blocks
 * STACK — words that lead, the product, then the bound facts — so a format
 * change re-distributes the design instead of shrinking it (spec §24). A split
 * whose picture a person removed stacks too: its words get the whole width
 * instead of half of it beside an empty column.
 */
function responsiveVariant(variant: VariantDef, fmt: DocFormat, pictureless = false): VariantDef {
  if (variant.layout !== 'split' || (fmt.height / fmt.width < 1.5 && !pictureless)) return variant;
  const product = variant.blocks.find((b): b is ProductBlock => b.kind === 'product');
  const texts = variant.blocks.filter((b): b is TextBlock => b.kind === 'text').map((b) => ({ ...b, align: 'center' as const }));
  const leads = (b: TextBlock) => b.text.source === 'copy' && (b.text.slot === 'badge' || b.text.slot === 'headline' || b.text.slot === 'subhead' || b.text.slot === 'features');
  const blocks: StackBlock[] = product
    ? [...texts.filter(leads), { ...product, minFrac: Math.max(0.36, product.minFrac * 0.8), maxFrac: Math.min(0.6, product.maxFrac), widthFrac: Math.min(0.9, product.widthFrac) }, ...texts.filter((b) => !leads(b))]
    : texts;
  return { ...variant, layout: 'stack', blocks };
}

/** Make a document from a template — the "three compositions" each come from here (spec §12). */
export function buildFromTemplate(input: BuildInput): BuildResult {
  const tpl = TEMPLATES[input.template];
  const fmt = input.format;
  const mainPicture = input.products.find((p) => p.slot === 'main');
  const pictureless = !!mainPicture && (!mainPicture.image || !!input.omit?.includes('product'));
  const variant = responsiveVariant(tpl.variants[input.variant] ?? Object.values(tpl.variants)[0]!, fmt, pictureless);
  if (variant.layout === 'house') return buildHouse(input, tpl.id, tpl.version, variant);
  const dir: 'rtl' | 'ltr' = input.locale === 'en' ? 'ltr' : 'rtl';
  const kit = input.brand;
  const safe_area = safeAreaFor(kit, fmt);
  const docShell = { format: fmt, safe_area };
  const safe = safeBox(docShell);
  const sp = scaledSpacing(kit, fmt.width, fmt.height);
  const dropped: string[] = [];
  const conflicts: LayoutConflict[] = [];
  const bind: BindingContext = {
    snapshots: Object.fromEntries(input.products.map((p) => [p.slot, p.snapshot])),
    claims: input.service ? { [input.service.id]: input.service } : {},
    brand: kit, locale: input.locale, slide: input.slide,
  };

  const layers: Layer[] = [];
  const relations: Relation[] = [];

  // Background — the approved preset, reused exactly (spec §5).
  const bg = input.background ?? kit.backgrounds.find((b) => b.id === kit.default_background) ?? kit.backgrounds[0];
  if (bg.kind === 'asset' && bg.asset_id && input.backgroundNatural) {
    const n = input.backgroundNatural;
    const cover = Math.max(fmt.width / n.width, fmt.height / n.height);
    const cw = fmt.width / cover;
    const ch = fmt.height / cover;
    layers.push({
      id: 'background', name: 'Background', role: 'background', parent: null, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: true,
      type: 'image', asset: { kind: 'asset', ref: bg.asset_id }, natural: { ...n }, crop: { x: (n.width - cw) / 2, y: (n.height - ch) / 2, width: cw, height: ch }, scale: cover, fit: 'detail',
    });
  } else {
    layers.push({
      id: 'background', name: 'Background', role: 'background', parent: null, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: true,
      type: 'shape', shape: 'rect', width: fmt.width, height: fmt.height, fill: bg.kind === 'solid' ? bg.color : kit.colors.background, stroke: null, radius: 0, blur: 0,
    });
  }

  // Logo — the approved asset only, pinned to its safe corner; its band is kept clear.
  let area: Box = { ...safe };
  let logoLayer: ImageLayer | null = null;
  if (input.logo && kit.logo.show_by_default) {
    const w = kit.logo.width * kitScale(fmt.width, fmt.height);
    const scale = w / input.logo.width;
    const h = input.logo.height * scale;
    const pos = cornerPosition(kit.logo.corner, safe, { width: w, height: h }, 0, dir);
    logoLayer = {
      id: 'logo', name: 'Logo', role: 'logo', parent: null, ...pos, rotation: 0, opacity: 1, visible: true, locked: false, type: 'image',
      asset: { kind: 'logo', ref: kit.logo.asset }, natural: { ...input.logo }, crop: null, scale, fit: 'whole',
    };
    relations.push({ id: 'r_logo', kind: 'anchor', subject: 'logo', corner: kit.logo.corner, margin: 0 });
    const band = h + sp.medium;
    area = kit.logo.corner.startsWith('top') ? { ...area, y: area.y + band, height: area.height - band } : { ...area, height: area.height - band };
  }

  const placements: Placement[] = [];
  const overflow: string[] = [];
  const short: string[] = [];
  let fitsAll = true;

  if (variant.layout === 'stack') {
    const items = makeTextItems(variant.blocks, input, bind, null, fmt.width, area.width, dropped);
    const r = solveColumn(items, area, input.measure, dropped);
    fitsAll = r.fits;
    overflow.push(...r.overflowIds);
    if (r.short) short.push(r.short);
    placements.push(...placeColumn(r.items, area, variant.justify));
  } else if (variant.layout === 'split') {
    const gutter = sp.medium;
    const textW = (area.width - gutter) * (variant.textColumn ?? 0.5);
    const prodW = area.width - gutter - textW;
    const startRight = dir === 'rtl';
    const textCol: Box = { x: startRight ? area.x + area.width - textW : area.x, y: area.y, width: textW, height: area.height };
    const prodCol: Box = { x: startRight ? area.x : area.x + textW + gutter, y: area.y, width: prodW, height: area.height };
    const textBlocks = variant.blocks.filter((b) => b.kind === 'text');
    const prodBlock = variant.blocks.find((b): b is ProductBlock => b.kind === 'product');
    const textItems = makeTextItems(textBlocks, input, bind, null, fmt.width, textW, dropped);
    const r = solveColumn(textItems, textCol, input.measure, dropped);
    fitsAll = r.fits;
    overflow.push(...r.overflowIds);
    placements.push(...placeColumn(r.items, textCol, variant.justify));
    if (prodBlock) {
      const prodItems = makeTextItems([prodBlock], input, bind, null, fmt.width, prodW, dropped);
      const pr = solveColumn(prodItems, prodCol, input.measure, dropped);
      if (!pr.fits) fitsAll = false;
      if (pr.short) short.push(pr.short);
      placements.push(...placeColumn(pr.items, prodCol, 'center', 'product'));
    }
  } else {
    // pair: headline across the top, two product columns, the CTA across the bottom.
    const top = variant.blocks.filter((b) => b.kind === 'text' && b.text.source !== 'product' && b.text.slot !== 'cta');
    const bottom = variant.blocks.filter((b) => b.kind === 'text' && b.text.slot === 'cta');
    const perProduct = variant.blocks.filter((b) => b.kind === 'product' || (b.kind === 'text' && b.text.source === 'product'));
    const topItems = makeTextItems(top, input, bind, null, fmt.width, area.width, dropped);
    const botItems = makeTextItems(bottom, input, bind, null, fmt.width, area.width, dropped);
    for (const it of [...topItems, ...botItems]) if (it.kind === 'text' && !fitItem(it, area.width, it.maxSize, input.measure)) overflow.push(it.id);
    const topH = stackHeight(topItems) + (topItems.length ? sp.large : 0);
    const botH = stackHeight(botItems) + (botItems.length ? sp.large : 0);
    placements.push(...placeColumn(topItems, { ...area, height: topH }, 'start', 'top'));
    placements.push(...placeColumn(botItems, { ...area, y: area.y + area.height - botH + (botItems.length ? sp.large : 0), height: botH }, 'start', 'bottom'));
    const mid: Box = { x: area.x, y: area.y + topH, width: area.width, height: area.height - topH - botH };
    // pair: the two comparison slots. grid: every bound product (2–4) — 2 or 3 side by side, 4 as two rows of two.
    const slots = variant.layout === 'pair' ? ['main', 'p2'] : input.products.map((p) => p.slot).slice(0, GRID_PRODUCTS.max);
    const cols = slots.length === 4 ? 2 : Math.max(1, slots.length);
    const rows = Math.ceil(slots.length / cols);
    const gutter = variant.layout === 'pair' ? sp.large : sp.medium;
    const colW = (mid.width - gutter * (cols - 1)) / cols;
    const rowH = (mid.height - gutter * (rows - 1)) / rows;
    const startRight = dir === 'rtl';
    slots.forEach((slot, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      // The first product sits on the reading side's start.
      const x = startRight ? mid.x + mid.width - colW - c * (colW + gutter) : mid.x + c * (colW + gutter);
      const col: Box = { x, y: mid.y + r * (rowH + gutter), width: colW, height: rowH };
      const items = makeTextItems(perProduct, input, bind, slot, fmt.width, colW, dropped);
      const res = solveColumn(items, col, input.measure, dropped);
      if (!res.fits) fitsAll = false;
      overflow.push(...res.overflowIds);
      if (res.short) short.push(res.short);
      placements.push(...placeColumn(res.items, col, 'center', slot));
    });
  }

  const built = layersFromPlacements(placements, input, dir);
  layers.push(...built.layers);
  relations.push(...built.relations);
  if (logoLayer) layers.push(logoLayer);

  // Relations that keep the stack together after edits.
  for (const slot of input.products.map((p) => p.slot)) {
    const pid = `product${suffix(slot)}`;
    if (!layers.some((l) => l.id === pid)) continue;
    const col = placements.find((q) => q.item.id === pid)?.col;
    const column = placements.filter((p) => p.col === col);
    const ordered = column.slice().sort((a, b) => a.y - b.y).map((p) => (p.item.kind === 'text' && p.item.chip ? `${p.item.id}_group` : p.item.id));
    const pIdx = ordered.indexOf(pid);
    if (pIdx >= 0 && variant.layout !== 'split') {
      const gapOf = (id: string) => column.find((p) => p.item.id === id || `${p.item.id}_group` === id)?.item.gapAfter ?? sp.small;
      for (let i = pIdx + 1; i < ordered.length; i++) relations.push({ id: `r_below_${ordered[i]}`, kind: 'below', subject: ordered[i], target: ordered[i - 1], gap: gapOf(ordered[i - 1]) });
      for (let i = 0; i < pIdx; i++) if (['headline', 'subhead', 'badge_group', 'badge'].includes(ordered[i])) relations.push({ id: `r_clear_${ordered[i]}`, kind: 'clear_of', subject: ordered[i], target: pid, gap: sp.small });
    }
  }
  if (variant.layout === 'split') {
    // The text column is one chain: a block that grows pushes the blocks under it, nothing else.
    const textCol = placements.filter((p) => p.item.kind === 'text').sort((a, b) => a.y - b.y);
    const idOf = (p: Placement) => (p.item.kind === 'text' && p.item.chip ? `${p.item.id}_group` : p.item.id);
    for (let i = 1; i < textCol.length; i++) relations.push({ id: `r_below_${idOf(textCol[i])}`, kind: 'below', subject: idOf(textCol[i]), target: idOf(textCol[i - 1]), gap: textCol[i - 1].item.gapAfter });
  }
  const featureIds = layers.filter((l) => l.role === 'feature' && l.type === 'text').map((l) => l.id);
  if (featureIds.length >= 2 && variant.layout !== 'split') relations.push({ id: 'r_features', kind: 'order', members: featureIds, gap: sp.small });

  const doc: CreativeDocument = {
    schema_version: SCHEMA_VERSION,
    format: { ...fmt },
    locale: input.locale,
    direction: dir,
    objective: input.objective,
    priority: variant.priority,
    density: input.density,
    template: { id: tpl.id, version: tpl.version, variant: variant.id },
    brand_version: input.brandVersion,
    safe_area,
    products: input.products.map((p) => ({ slot: p.slot, product_id: p.snapshot.data.product_id, variant_key: p.snapshot.data.variant_key, snapshot_id: p.snapshot.id })),
    services: input.service ? [{ claim_id: input.service.id, claim_version: input.service.version }] : [],
    layers,
    relations: relations.filter((r) => relRefsExist(r, layers)),
    annotations: [],
    caption: input.caption,
    alt_text: input.alt_text,
    slide: input.slide,
  };
  // A product that cannot reach its share is reported on the product — not as an over-long headline —
  // with what really gives it room: another composition, fewer words, or a carousel.
  if (short.length) conflicts.push({ code: 'product_too_small', layer_ids: short, options: ['switch_variant', 'switch_density', 'shorten_text', 'split_carousel'] });
  if (!fitsAll && (overflow.length || !short.length)) conflicts.push({ code: 'content_too_long', layer_ids: overflow.length ? overflow : ['headline'], options: ['shorten_text', 'switch_density', 'switch_variant', 'split_carousel'] });
  for (const c of detectConflicts(doc, { measure: input.measure })) if (!conflicts.some((x) => x.code === c.code && x.layer_ids.join() === c.layer_ids.join())) conflicts.push(c);
  return { doc, conflicts, dropped: [...new Set(dropped)] };
}

// ---------------------------------------------------------------------------
// The house look (levonis_gold): a drawn scene, not a stack
// ---------------------------------------------------------------------------

const GOLD: Gradient = { kind: 'linear', angle: 90, stops: [{ at: 0, color: '#fbe7ae', opacity: 1 }, { at: 0.5, color: '#e3b660', opacity: 1 }, { at: 1, color: '#b07f2c', opacity: 1 }] };
const GOLD_LINE = '#d9a64c';
/** Words with no Arabic letter: set in the house look's Latin face. */
const LATIN_ONLY = /^[ -\u024F\u2013\u2014\s]+$/;
/** The house look's default picture adjustment: a touch brighter and crisper, warmed toward the gold, with a gold rim light. */
export const HOUSE_ADJUST = Object.freeze({ brightness: 0.03, contrast: 0.08, warmth: 0.25, glow: 0.45 });

/**
 * The owner's reference post as a template: everything but the picture, the
 * product's name and its price is the house's own drawing (shapes with
 * gradients) or the brand's fixed words (`source: brand`) — nothing here is a
 * model's text. The product stands on the podium: its white backdrop is
 * knocked out by the renderer, and `image.bounds` (the content box the same
 * knockout found) is the crop, so its feet sit on the rim, not its padding.
 */
function buildHouse(input: BuildInput, templateId: TemplateId, templateVersion: number, variant: VariantDef): BuildResult {
  const fmt = input.format;
  const W = fmt.width;
  const H = fmt.height;
  const u = Math.min(W, H) / 1080;
  const kit = input.brand;
  const dir: 'rtl' | 'ltr' = input.locale === 'en' ? 'ltr' : 'rtl';
  const safe_area = safeAreaFor(kit, fmt);
  const safe = safeBox({ format: fmt, safe_area });
  const main = input.products.find((p) => p.slot === 'main') ?? null;
  const bind: BindingContext = { snapshots: main ? { main: main.snapshot } : {}, claims: {}, brand: kit, locale: input.locale, slide: input.slide };
  const layers: Layer[] = [];
  const relations: Relation[] = [];
  const conflicts: LayoutConflict[] = [];
  const dropped: string[] = [];
  const base = { parent: null, rotation: 0, opacity: 1, visible: true, locked: false } as const;
  const shape = (id: string, o: Partial<ShapeLayer> & Pick<ShapeLayer, 'x' | 'y' | 'width' | 'height'>): ShapeLayer => ({
    ...base, id, name: id, role: 'decor', type: 'shape', shape: 'ellipse', fill: null, stroke: null, radius: 0, blur: 0, locked: true, ...o,
  });
  /** Latin words (the brand, the model, the digits) are set in the geometric Latin face; anything else in Plex Arabic. */
  const familyFor = (t: string): FontFamilyId => (LATIN_ONLY.test(t) ? 'montserrat' : 'plex-arabic');
  const measureW = (t: string, size: number, weight: FontWeight, family: FontFamilyId) => input.measure(t, { family: FONT_REGISTRY[family].family, weight, size });
  const text = (id: string, role: LayerRole, t: string, source: TextSource, size: number, weight: FontWeight, family: FontFamilyId, x: number, y: number, width: number, o: Partial<TextLayer> = {}): TextLayer => ({
    ...base, id, name: id, role, type: 'text', text: t, source, x, y, width, height: Math.ceil(size * 1.3),
    font: { family, weight, size, lineHeight: 1.3 }, minSize: Math.min(size, Math.round(18 * u)), maxLines: 1,
    color: '#ffffff', align: 'center', direction: 'auto', ...o,
  });
  interface Part { id: string; role: LayerRole; text: string; source: TextSource; weight: FontWeight; scale?: number; o?: Partial<TextLayer> }
  /** Words on one line, each its own layer, centred together in reading order (`lineDir`), shrunk together to fit `maxW`. */
  const row = (parts: Part[], size: number, y: number, maxW: number, lineDir: 'rtl' | 'ltr') => {
    let sz = size;
    const fams = parts.map((p) => familyFor(p.text));
    const widths = () => parts.map((p, i) => measureW(p.text, Math.round(sz * (p.scale ?? 1)), p.weight, fams[i]));
    const gap = () => sz * 0.3;
    let ws = widths();
    const total = () => ws.reduce((a, b) => a + b, 0) + gap() * (parts.length - 1);
    while (total() > maxW && sz > 18 * u) {
      sz = Math.round(sz * 0.95);
      ws = widths();
    }
    let x = (W - total()) / 2;
    const order = lineDir === 'ltr' ? parts.map((_, i) => i) : parts.map((_, i) => parts.length - 1 - i);
    const pad = 4 * u;
    const out: TextLayer[] = [];
    for (const i of order) {
      const p = parts[i];
      const psz = Math.round(sz * (p.scale ?? 1));
      // Smaller words sit on the same baseline as the big ones.
      const dy = (sz - psz) * 1.3 * 0.78;
      out.push(text(p.id, p.role, p.text, p.source, psz, p.weight, fams[i], x - pad, y + dy, ws[i] + pad * 2, p.o));
      x += ws[i] + gap();
    }
    return { size: sz, layers: out };
  };
  const radial = (color: string, peak: number): Gradient => ({ kind: 'radial', angle: 0, stops: [{ at: 0, color, opacity: peak }, { at: 0.3, color, opacity: peak * 0.55 }, { at: 0.65, color, opacity: peak * 0.16 }, { at: 1, color, opacity: 0 }] });
  const glow = (id: string, cx: number, cy: number, r: number, color: string, peak: number) => shape(id, { x: cx - r, y: cy - r, width: r * 2, height: r * 2, gradient: radial(color, peak) });

  // THE STAGE — broad, soft light only: near-black, a wide gold haze top-left, a deep red haze top-right
  // fading to black, a warm pool behind the product and on the podium and floor. Every light is a radial
  // gradient that fades to nothing before its edge, or a heavily blurred shape: no line, no ring, no hard edge.
  layers.push(shape('background', {
    role: 'background', shape: 'rect', x: 0, y: 0, width: W, height: H, fill: '#070605',
    gradient: { kind: 'linear', angle: 90, stops: [{ at: 0, color: '#0c0a08', opacity: 1 }, { at: 0.55, color: '#080706', opacity: 1 }, { at: 1, color: '#030303', opacity: 1 }] },
  }));
  layers.push(glow('gold_glow', -60 * u, 120 * u, 760 * u, '#b8873a', 0.34));
  layers.push(glow('red_glow', W + 80 * u, -100 * u, 720 * u, '#7a0d14', 0.55));
  layers.push(glow('warm_light', W / 2, H * 0.56, Math.max(W, H) * 0.5, '#a87a34', 0.2));

  // THE WORDS — the wordmark and tagline (light, tracked), the brand in white and the model in gold, «بسعر»
  // and the price digits in gold, the currency — the product's words bound to the snapshot.
  let y = safe.y - 6 * u;
  const markSize = Math.round(44 * u);
  const wordmark = BRAND_TEXT.wordmark[input.locale];
  const wmW = measureW(wordmark, markSize, 500, 'montserrat');
  layers.push(text('wordmark', 'decor', wordmark, { kind: 'brand', field: 'wordmark' }, markSize, 500, 'montserrat', (W - wmW) / 2 - 4 * u, y, wmW + 8 * u, { color: '#f2eee6', direction: 'ltr' }));
  y += markSize * 1.3 - 4 * u;
  const tagSize = Math.round(20 * u);
  const tag = BRAND_TEXT.tagline[input.locale];
  const tagW = measureW(tag, tagSize, 500, 'montserrat');
  layers.push(text('tagline', 'decor', tag, { kind: 'brand', field: 'tagline' }, tagSize, 500, 'montserrat', (W - tagW) / 2 - 4 * u, y, tagW + 8 * u, { color: '#b9b0a0', direction: 'ltr' }));
  y += tagSize * 1.3 + 22 * u;

  const maxW = safe.width;
  const brandText = main ? renderSource({ kind: 'product', slot: 'main', field: 'brand' }, bind) : null;
  const modelText = main ? renderSource({ kind: 'product', slot: 'main', field: 'model' }, bind) : null;
  if (brandText && modelText) {
    const t = row([
      { id: 'product_brand', role: 'product_name', text: brandText, source: { kind: 'product', slot: 'main', field: 'brand' }, weight: 500 },
      { id: 'product_name', role: 'product_name', text: modelText, source: { kind: 'product', slot: 'main', field: 'model' }, weight: 700, o: { color: '#e3b660', gradient: GOLD } },
    ], Math.round(68 * u), y, maxW, detectDirection(`${brandText} ${modelText}`, dir));
    layers.push(...t.layers);
    y += t.size * 1.3 + 2 * u;
  } else if (main) {
    const name = renderSource({ kind: 'product', slot: 'main', field: 'name' }, bind) ?? '';
    const family = familyFor(name);
    const r = fitText(name, { family: FONT_REGISTRY[family].family, weight: 700, lineHeight: 1.3 }, { width: maxW, maxHeight: 2 * 70 * u * 1.3, maxLines: 2 }, { max: Math.round(64 * u), min: Math.round(28 * u) }, input.measure);
    layers.push({ ...text('product_name', 'product_name', name, { kind: 'product', slot: 'main', field: 'name' }, r.size, 700, family, safe.x, y, maxW, { color: '#e3b660', gradient: GOLD, maxLines: 2 }), height: Math.ceil(r.height) });
    y += r.height + 2 * u;
  }
  const amount = main ? renderSource({ kind: 'product', slot: 'main', field: 'price_amount' }, bind) : null;
  if (amount) {
    // «بسعر» · the digits (gold) · «د.ع», in the post's reading order.
    const t = row([
      { id: 'price_lead', role: 'price_note', text: BRAND_TEXT.price_lead[input.locale], source: { kind: 'brand', field: 'price_lead' }, weight: 600, scale: 0.86 },
      { id: 'price', role: 'price', text: amount, source: { kind: 'product', slot: 'main', field: 'price_amount' }, weight: 700, o: { color: '#e3b660', gradient: GOLD, direction: 'ltr' } },
      { id: 'price_currency', role: 'price_note', text: BRAND_TEXT.currency[input.locale], source: { kind: 'brand', field: 'currency' }, weight: 600, scale: 0.86, o: { color: '#e3b660', gradient: GOLD } },
    ], Math.round(62 * u), y, maxW, dir);
    layers.push(...t.layers);
    y += t.size * 1.3;
  } else if (main) {
    // A price that is not a plain number (from, on request): the bound line as it renders, in Plex.
    const priceText = renderSource({ kind: 'product', slot: 'main', field: 'price' }, bind) ?? '';
    const r = fitText(priceText, { family: FONT_REGISTRY['plex-arabic'].family, weight: 700, lineHeight: 1.3 }, { width: maxW, maxHeight: 62 * u * 1.3, maxLines: 1 }, { max: Math.round(60 * u), min: Math.round(26 * u) }, input.measure);
    layers.push(text('price', 'price', priceText, { kind: 'product', slot: 'main', field: 'price' }, r.size, 700, 'plex-arabic', safe.x, y, maxW, { color: '#e3b660', gradient: GOLD }));
    y += r.size * 1.3;
  }

  // THE PILL at the bottom; the podium stands above it and never overlaps it.
  const pillH = Math.round(84 * u);
  const orderSize = Math.round(22 * u);
  const siteSize = Math.round(30 * u);
  const orderText = BRAND_TEXT.order_on[input.locale];
  const siteText = BRAND_TEXT.site[input.locale];
  const pillW = Math.min(safe.width, Math.max(measureW(orderText, orderSize, 600, 'plex-arabic'), measureW(siteText, siteSize, 600, 'montserrat')) + 120 * u);
  const pillY = safe.y + safe.height - pillH;
  const pillX = (W - pillW) / 2;

  // THE PODIUM — a solid, thick, rounded cylinder (clay): a matte dark top face with a soft warm highlight,
  // a side band lit at its top edge and dark at the bottom, a soft shadow and a faint warm reflection below.
  const rx = Math.min(W * 0.4, 430 * u);
  const ry = 46 * u;
  const depth = 66 * u;
  const topY = pillY - 18 * u - ry - depth;
  const px0 = W / 2 - rx;
  const baseY = topY + depth;
  layers.push(shape('floor_light', { x: W / 2 - rx * 1.35, y: baseY - ry * 0.6, width: rx * 2.7, height: ry * 2.6, gradient: radial('#a37530', 0.22) }));
  layers.push(shape('podium_shadow', { x: px0 + 10 * u, y: baseY - ry * 0.5, width: rx * 2 - 20 * u, height: ry * 2.2, fill: '#000000', blur: 30 * u, opacity: 0.9 }));
  layers.push(shape('podium_base', { x: px0, y: baseY - ry, width: rx * 2, height: ry * 2, fill: '#070606' }));
  layers.push(shape('podium_side', {
    shape: 'rect', x: px0, y: topY, width: rx * 2, height: depth, fill: '#110e0b',
    gradient: { kind: 'linear', angle: 90, stops: [{ at: 0, color: '#54432f', opacity: 1 }, { at: 0.14, color: '#2e251b', opacity: 1 }, { at: 0.6, color: '#16120e', opacity: 1 }, { at: 1, color: '#080706', opacity: 1 }] },
  }));
  // The cylinder's roundness: its two flanks fall into shadow (a sideways gradient over the band).
  layers.push(shape('podium_shade', {
    shape: 'rect', x: px0, y: topY, width: rx * 2, height: depth,
    gradient: { kind: 'linear', angle: 0, stops: [{ at: 0, color: '#000000', opacity: 0.6 }, { at: 0.25, color: '#000000', opacity: 0.1 }, { at: 0.5, color: '#000000', opacity: 0 }, { at: 0.75, color: '#000000', opacity: 0.1 }, { at: 1, color: '#000000', opacity: 0.6 }] },
  }));
  // A soft lit lip where the top face meets the side (a lighter disc a hair lower, under the top face).
  layers.push(shape('podium_lip', { x: px0, y: topY - ry + 4 * u, width: rx * 2, height: ry * 2, fill: '#4a3b28', gradient: { kind: 'linear', angle: 0, stops: [{ at: 0, color: '#1b150f', opacity: 1 }, { at: 0.5, color: '#6a5232', opacity: 1 }, { at: 1, color: '#1b150f', opacity: 1 }] } }));
  layers.push(shape('podium_top', { x: px0, y: topY - ry, width: rx * 2, height: ry * 2, fill: '#15120f', gradient: { kind: 'radial', angle: 0, stops: [{ at: 0, color: '#3d3226', opacity: 1 }, { at: 0.6, color: '#221c15', opacity: 1 }, { at: 1, color: '#18140f', opacity: 1 }] } }));
  layers.push(shape('podium_light', { x: px0 + rx * 0.25, y: topY - ry * 0.75, width: rx * 1.5, height: ry * 1.5, fill: '#c39348', blur: 24 * u, opacity: 0.38 }));

  // THE PRODUCT — standing on the top face, centred, in the light: a warm back-glow, a soft dark contact shadow.
  const img = main?.image ?? null;
  if (img && main) {
    // Only a box inside the picture is a crop (normalize refuses any other).
    const b = img.bounds && img.bounds.width > 8 && img.bounds.height > 8 && img.bounds.x >= 0 && img.bounds.y >= 0 && img.bounds.x + img.bounds.width <= img.width && img.bounds.y + img.bounds.height <= img.height ? img.bounds : null;
    const crop = b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
    const src = crop ?? { width: img.width, height: img.height };
    const foot = topY + ry * 0.3;
    const top = y + 6 * u;
    const availH = Math.max(H * 0.12, foot - top);
    // One rule for every product: as large as the room allows, never wider than 84 % of the post.
    const scale = Math.max(0.01, Math.min((W * 0.84) / src.width, availH / src.height, 3));
    const w = src.width * scale;
    const h = src.height * scale;
    const box = { x: (W - w) / 2, y: foot - h, width: w, height: h };
    layers.push(glow('product_glow', W / 2, box.y + h * 0.55, Math.max(w, h) * 0.6, '#b98a40', 0.26));
    layers.push(shape('product_shadow', { role: 'product_shadow', x: box.x + w * 0.06, y: foot - 18 * u, width: w * 0.88, height: 36 * u, fill: '#000000', blur: 20 * u, opacity: 0.85, locked: false }));
    relations.push({ id: 'r_shadow', kind: 'shadow_of', subject: 'product_shadow', target: 'product' });
    layers.push({
      ...base, id: 'product', name: 'Product', role: 'product', type: 'image', x: box.x, y: box.y, asset: { kind: 'product', ref: img.url, slot: 'main' },
      natural: { width: img.width, height: img.height }, crop, scale, fit: crop ? 'detail' : 'whole', knockout: 'white', adjust: { ...HOUSE_ADJUST },
    });
  }

  const group = 'cta_group';
  layers.push({ ...base, id: group, name: 'cta group', role: 'cta', type: 'group', x: 0, y: 0 });
  layers.push(shape('cta_glow', { locked: false, parent: group, shape: 'rect', x: pillX + 10 * u, y: pillY + 6 * u, width: pillW - 20 * u, height: pillH - 12 * u, radius: pillH / 2, fill: '#b98a40', blur: 26 * u, opacity: 0.16 }));
  layers.push(shape('cta_chip', { locked: false, parent: group, shape: 'rect', x: pillX, y: pillY, width: pillW, height: pillH, radius: pillH / 2, fill: '#0b0a09', stroke: { color: GOLD_LINE, width: 1.4 * u }, opacity: 0.95 }));
  const orderH = orderSize * 1.3;
  const siteH = siteSize * 1.3;
  const ty = pillY + (pillH - (orderH + siteH)) / 2 + 2 * u;
  layers.push({ ...text('cta', 'cta', orderText, { kind: 'brand', field: 'order_on' }, orderSize, 600, 'plex-arabic', pillX, ty, pillW), parent: group, color: '#ecd6a8' });
  layers.push({ ...text('site', 'cta', siteText, { kind: 'brand', field: 'site' }, siteSize, 600, 'montserrat', pillX, ty + orderH, pillW), parent: group, direction: 'ltr' });

  const doc: CreativeDocument = {
    schema_version: SCHEMA_VERSION,
    format: { ...fmt },
    locale: input.locale,
    direction: dir,
    objective: input.objective,
    priority: variant.priority,
    density: input.density,
    template: { id: templateId, version: templateVersion, variant: variant.id },
    brand_version: input.brandVersion,
    safe_area,
    products: main ? [{ slot: 'main', product_id: main.snapshot.data.product_id, variant_key: main.snapshot.data.variant_key, snapshot_id: main.snapshot.id }] : [],
    services: [],
    layers,
    relations,
    annotations: [],
    caption: input.caption,
    alt_text: input.alt_text,
    slide: input.slide,
  };
  if (main && !img) dropped.push('product');
  for (const c of detectConflicts(doc, { measure: input.measure })) conflicts.push(c);
  return { doc, conflicts, dropped };
}

function relRefsExist(r: Relation, layers: readonly Layer[]): boolean {
  const ids = new Set(layers.map((l) => l.id));
  switch (r.kind) {
    case 'order': return r.members.every((m) => ids.has(m));
    case 'anchor': return ids.has(r.subject);
    default: return ids.has(r.subject) && ids.has(r.target);
  }
}

// ---------------------------------------------------------------------------
// Moving layers and propagating relations
// ---------------------------------------------------------------------------

/** Move a layer (and a group's children) by dx/dy. Returns a new layer list. */
export function moveBy(layers: readonly Layer[], id: string, dx: number, dy: number): Layer[] {
  if (!dx && !dy) return layers.slice();
  const ids = new Set(withDescendants(layers, id));
  return layers.map((l) => (ids.has(l.id) && l.type !== 'group' ? { ...l, x: l.x + dx, y: l.y + dy } : l));
}

/** The relations whose subject depends on `id`. */
function dependentsOf(relations: readonly Relation[], id: string): Relation[] {
  return relations.filter((r) => {
    switch (r.kind) {
      case 'below': case 'clear_of': case 'shadow_of': return r.target === id;
      case 'order': return r.members.slice(0, -1).includes(id);
      case 'anchor': return false;
    }
  });
}

/**
 * Recompute ONLY the layers that depend on `changed` (spec §14). Locks hold
 * through the tree: a dependent that is locked, sits inside a locked group or
 * holds a locked layer (a chip group whose words are locked) is never moved
 * or reshaped — it stays where it is, its own dependents are left alone, and
 * whatever that leaves (an overlap, a gap) is for `detectConflicts` to report.
 * Returns the new document and the ids that moved, so the editor can show
 * what else an edit touched (spec §16).
 */
export function relayoutDependents(doc: CreativeDocument, changed: readonly string[], kit?: Pick<BrandKit, 'shadow'>): { doc: CreativeDocument; moved: string[] } {
  let layers = doc.layers.slice();
  const moved: string[] = [];
  const queue = [...changed];
  const visits = new Map<string, number>();
  const boxOf = (id: string) => {
    const l = layers.find((x) => x.id === id);
    return l ? layerBox(l, layers) : null;
  };
  while (queue.length) {
    const id = queue.shift()!;
    const n = (visits.get(id) ?? 0) + 1;
    visits.set(id, n);
    if (n > 8) continue; // a relation cycle cannot loop forever
    for (const r of dependentsOf(doc.relations, id)) {
      const targets: Array<{ subject: string; dx: number; dy: number; reshape?: Partial<ShapeLayer> }> = [];
      if (r.kind === 'below') {
        const t = boxOf(r.target), s = boxOf(r.subject);
        if (t && s) targets.push({ subject: r.subject, dx: 0, dy: t.y + t.height + r.gap - s.y });
      } else if (r.kind === 'clear_of') {
        const t = boxOf(r.target), s = boxOf(r.subject);
        if (t && s && intersects(s, t, r.gap - 0.5)) {
          const above = s.y + s.height / 2 <= t.y + t.height / 2;
          targets.push({ subject: r.subject, dx: 0, dy: above ? t.y - r.gap - s.height - s.y : t.y + t.height + r.gap - s.y });
        }
      } else if (r.kind === 'shadow_of') {
        const t = boxOf(r.target);
        const sub = layers.find((x) => x.id === r.subject);
        if (t && sub && sub.type === 'shape' && kit) {
          const g = shadowGeometry(t, kit);
          if (Math.abs(g.x - sub.x) > 0.01 || Math.abs(g.y - sub.y) > 0.01 || Math.abs(g.width - sub.width) > 0.01 || Math.abs(g.height - sub.height) > 0.01) {
            targets.push({ subject: r.subject, dx: 0, dy: 0, reshape: g });
          }
        } else if (t && sub && sub.type === 'shape') {
          // Without the kit, keep the shadow's proportions to the product box.
          const prevW = sub.width;
          const ratio = prevW ? sub.height / prevW : 0.08;
          const w = t.width * 0.7;
          targets.push({ subject: r.subject, dx: 0, dy: 0, reshape: { x: t.x + (t.width - w) / 2, y: t.y + t.height - (w * ratio) / 2, width: w, height: w * ratio } });
        }
      } else if (r.kind === 'order') {
        const i = r.members.indexOf(id);
        const next = r.members[i + 1];
        const t = boxOf(id), s = boxOf(next);
        if (t && s) targets.push({ subject: next, dx: 0, dy: t.y + t.height + r.gap - s.y });
      }
      for (const m of targets) {
        const sub = layers.find((x) => x.id === m.subject);
        if (!sub || touchesLock(layers, sub.id)) continue;
        if (m.reshape) {
          layers = layers.map((l) => (l.id === m.subject && l.type === 'shape' ? { ...l, ...m.reshape } : l));
        } else if (Math.abs(m.dx) > 0.01 || Math.abs(m.dy) > 0.01) {
          layers = moveBy(layers, m.subject, m.dx, m.dy);
        } else continue;
        if (!moved.includes(m.subject)) moved.push(m.subject);
        queue.push(m.subject);
      }
    }
  }
  return { doc: { ...doc, layers }, moved };
}

/** Re-apply anchors (after a format or safe-area change). A locked layer, or one a lock protects, keeps its place. */
export function applyAnchors(doc: CreativeDocument): CreativeDocument {
  const safe = safeBox(doc);
  let layers = doc.layers.slice();
  for (const r of doc.relations) {
    if (r.kind !== 'anchor') continue;
    const l = layers.find((x) => x.id === r.subject);
    const b = l ? layerBox(l, layers) : null;
    if (!l || !b || touchesLock(layers, l.id)) continue;
    const pos = cornerPosition(r.corner, safe, b, r.margin, doc.direction);
    layers = moveBy(layers, l.id, pos.x - b.x, pos.y - b.y);
  }
  return { ...doc, layers };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export function detectConflicts(doc: CreativeDocument, opts: { measure?: TextMeasurer } = {}): LayoutConflict[] {
  const out: LayoutConflict[] = [];
  const safe = safeBox(doc);
  const visible = doc.layers.filter((l) => l.visible && l.type !== 'group');
  const outside = visible.filter((l) => ESSENTIAL_ROLES.has(l.role))
    .filter((l) => {
      const b = layerBox(l, doc.layers);
      return b && !contains(safe, b, 1);
    }).map((l) => l.id);
  if (outside.length) out.push({ code: 'outside_safe_area', layer_ids: outside, options: ['shrink_product', 'reduce_font', 'shorten_text', 'move_layer', 'revert'] });

  const solid = visible.filter((l) => !BACKDROP_ROLES.has(l.role) && (l.type === 'text' || l.type === 'image'));
  const pairs: string[] = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (a.parent && a.parent === b.parent) continue;
      const ba = layerBox(a, doc.layers), bb = layerBox(b, doc.layers);
      if (ba && bb && intersects(ba, bb, -1)) pairs.push(a.id, b.id);
    }
  }
  if (pairs.length) out.push({ code: 'overlap', layer_ids: [...new Set(pairs)], options: ['move_layer', 'shrink_product', 'reduce_font', 'revert'] });

  if (opts.measure) {
    const over = visible.filter((l): l is TextLayer => l.type === 'text').filter((l) => !textFits(l, opts.measure!)).map((l) => l.id);
    if (over.length) out.push({ code: 'text_overflow', layer_ids: over, options: ['shorten_text', 'reduce_font', 'grow_box', 'revert'] });
  }
  return out;
}

export function textFits(l: TextLayer, measure: TextMeasurer): boolean {
  const r = fitText(l.text, { family: FONT_REGISTRY[l.font.family].family, weight: l.font.weight, lineHeight: l.font.lineHeight }, { width: l.width, maxHeight: l.height, maxLines: l.maxLines }, { max: l.font.size, min: l.font.size }, measure);
  return r.fits;
}

/**
 * Apply one of a conflict's options deterministically. Returns null for an
 * option that needs a person or Claude (`shorten_text`, `switch_*`,
 * `split_carousel`, `move_layer`) or that cannot resolve this conflict.
 */
export function resolveConflict(doc: CreativeDocument, conflict: LayoutConflict, option: ConflictOption, ctx: { measure: TextMeasurer; brand: BrandKit }): CreativeDocument | null {
  // A lock holds here too: a locked text, or one inside a locked group, is never resized by a resolution.
  if (option === 'reduce_font') {
    let changed = false;
    const ids: string[] = [];
    const layers = doc.layers.map((l) => {
      if (l.type !== 'text' || !conflict.layer_ids.includes(l.id) || lockedAbove(doc.layers, l.id)) return l;
      const r = fitText(l.text, { family: FONT_REGISTRY[l.font.family].family, weight: l.font.weight, lineHeight: l.font.lineHeight }, { width: l.width, maxHeight: l.height, maxLines: l.maxLines }, { max: l.font.size, min: l.minSize }, ctx.measure);
      if (!r.fits || r.size === l.font.size) return l;
      changed = true;
      ids.push(l.id);
      return { ...l, font: { ...l.font, size: r.size } };
    });
    return changed ? relayoutDependents({ ...doc, layers }, ids, ctx.brand).doc : null;
  }
  if (option === 'grow_box') {
    const ids: string[] = [];
    const layers = doc.layers.map((l) => {
      if (l.type !== 'text' || !conflict.layer_ids.includes(l.id) || lockedAbove(doc.layers, l.id)) return l;
      const r = fitText(l.text, { family: FONT_REGISTRY[l.font.family].family, weight: l.font.weight, lineHeight: l.font.lineHeight }, { width: l.width, maxHeight: Infinity, maxLines: l.maxLines }, { max: l.font.size, min: l.font.size }, ctx.measure);
      if (r.lines.length > l.maxLines || r.overlongWord) return l;
      ids.push(l.id);
      return { ...l, height: Math.ceil(r.height) };
    });
    if (!ids.length) return null;
    const next = relayoutDependents({ ...doc, layers }, ids, ctx.brand).doc;
    return detectConflicts(next, { measure: ctx.measure }).some((c) => c.code === 'outside_safe_area') ? null : next;
  }
  if (option === 'shrink_product') {
    const product = doc.layers.find((l): l is ImageLayer => l.type === 'image' && l.role === 'product' && !touchesLock(doc.layers, l.id));
    if (!product) return null;
    const original = product.scale;
    let current = doc;
    for (let step = 0; step < 12; step++) {
      const p = current.layers.find((l) => l.id === product.id) as ImageLayer;
      const next = scaleImageUniform(current, p.id, 0.94, 'bottom', ctx.brand);
      if (!next) return null;
      current = next;
      const np = current.layers.find((l) => l.id === product.id) as ImageLayer;
      if (np.scale < original * 0.5) return null;
      const left = detectConflicts(current, { measure: ctx.measure }).filter((c) => c.code === 'outside_safe_area' || c.code === 'overlap');
      if (!left.length) return current;
    }
    return null;
  }
  return null;
}

/**
 * THE uniform scale (spec §13): both axes by `factor`, about an anchor of
 * the box, then dependents re-laid. Returns null for a non-image layer or a
 * non-positive factor.
 */
export function scaleImageUniform(doc: CreativeDocument, id: string, factor: number, anchor: 'center' | 'top' | 'bottom' | 'start' | 'end', kit?: Pick<BrandKit, 'shadow'>): CreativeDocument | null {
  const l = findLayer(doc, id);
  if (!l || l.type !== 'image' || !(factor > 0) || !Number.isFinite(factor)) return null;
  const before = layerBox(l)!;
  const scale = Math.min(40, Math.max(0.01, l.scale * factor));
  const after = layerBox({ ...l, scale })!;
  const startIsRight = doc.direction === 'rtl';
  let x = before.x + (before.width - after.width) / 2;
  let y = before.y + (before.height - after.height) / 2;
  if (anchor === 'top') y = before.y;
  if (anchor === 'bottom') y = before.y + before.height - after.height;
  if (anchor === 'start') x = startIsRight ? before.x + before.width - after.width : before.x;
  if (anchor === 'end') x = startIsRight ? before.x : before.x + before.width - after.width;
  const layers = doc.layers.map((x0) => (x0.id === id ? { ...l, scale, x, y } : x0));
  return relayoutDependents({ ...doc, layers }, [id], kit).doc;
}

// ---------------------------------------------------------------------------
// Re-using a design: its copy, another format, another variant
// ---------------------------------------------------------------------------

/** The person-written words of a template-built document, by slot. */
export function extractCopy(doc: CreativeDocument): BuildCopy {
  const free = (id: string) => {
    const l = doc.layers.find((x) => x.id === id);
    return l && l.type === 'text' && l.source.kind === 'free' && l.visible ? l.text : undefined;
  };
  const features = doc.layers
    .filter((l): l is TextLayer => l.type === 'text' && l.role === 'feature' && l.source.kind === 'free' && l.visible)
    .sort((a, b) => a.y - b.y)
    .map((l) => l.text);
  return { headline: free('headline') ?? '', subhead: free('subhead'), body: free('body'), cta: free('cta'), badge: free('badge'), features };
}

export interface RebuildContext {
  brand: BrandKit;
  brandVersion: number | null;
  snapshots: Readonly<Record<string, Pick<ProductSnapshot, 'id' | 'data' | 'source'>>>;
  claims: Readonly<Record<string, ServiceClaimText>>;
  evidence: BuildEvidence;
  family: FamilyId | null;
  logo: { width: number; height: number } | null;
  backgroundNatural: { width: number; height: number } | null;
  measure: TextMeasurer;
}

/**
 * The background a document shows now, as a preset a build can draw: the
 * kit's own preset when it is one, otherwise the same colour (or approved
 * asset) as it stands. Null when there is no background layer.
 */
function backgroundInUse(doc: CreativeDocument, kit: BrandKit): { preset: BackgroundPreset; natural: { width: number; height: number } | null } | null {
  const l = doc.layers.find((x) => x.role === 'background');
  if (l?.type === 'shape' && l.fill) {
    const fill = l.fill;
    const preset: BackgroundPreset = kit.backgrounds.find((b) => b.kind === 'solid' && b.color === fill) ?? { id: 'in_use', label: 'In use', kind: 'solid', color: fill, asset_id: null };
    return { preset, natural: null };
  }
  if (l?.type === 'image' && l.asset.kind === 'asset') {
    const ref = l.asset.ref;
    const preset: BackgroundPreset = kit.backgrounds.find((b) => b.kind === 'asset' && b.asset_id === ref) ?? { id: 'in_use', label: 'In use', kind: 'asset', color: kit.colors.background, asset_id: ref };
    return { preset, natural: { ...l.natural } };
  }
  return null;
}

/** Ids a template creates; anything else in a document was added by a person and is carried across a rebuild. */
/** The house look's own drawn layers (buildHouse): made again by a rebuild, never carried as a person's. */
const HOUSE_LAYERS = new Set(['red_glow', 'gold_glow', 'warm_light', 'wordmark', 'tagline', 'product_brand', 'price_lead', 'price_currency', 'floor_light', 'podium_shadow', 'podium_base', 'podium_side', 'podium_shade', 'podium_lip', 'podium_top', 'podium_light', 'product_glow', 'cta_glow', 'site']);

function isTemplateLayer(id: string): boolean {
  if (HOUSE_LAYERS.has(id)) return true;
  return /^(background|logo|product(_shadow)?(_[a-z0-9]+)?|headline|subhead|body|cta|badge|feature_\d+|product_name(_[a-z0-9]+)?|price(_[a-z0-9]+)?|price_note(_[a-z0-9]+)?|availability(_[a-z0-9]+)?|service_(title|summary|conditions)|slide_number)(_chip|_group)?$/.test(id);
}

/**
 * Rebuild a template-made document with a different format, variant or
 * density, keeping its words, bindings and chosen pictures (spec §24, §45-ي).
 * Layers a person added are carried over at the same relative position
 * inside the safe area, with ONE scale factor (never stretched).
 *
 * What the person chose and a re-layout can keep, it keeps: the background in
 * use (preset or colour), a CTA they deleted or hid stays out, a product
 * picture they deleted stays out while the product's bound words stay, a
 * colour they gave a text or a chip stays when the brand palette still has
 * it, and a lock stays set.
 *
 * Returns null — the callers' «re-layout unavailable» — rather than drop a
 * binding it cannot draw: a product whose snapshot is not loaded, a service
 * claim that is not in the approved list, or more than one service binding
 * (a template draws one). Dropping them would silently take the bound words
 * and the checks that guard them out of the design.
 */
export function rebuild(doc: CreativeDocument, change: { format?: DocFormat; variant?: VariantId; density?: Density }, ctx: RebuildContext): BuildResult | null {
  if (!doc.template || !(doc.template.id in TEMPLATES)) return null;
  const products: BuildProduct[] = [];
  for (const b of doc.products) {
    const snap = ctx.snapshots[b.slot];
    if (!snap) return null;
    const img = doc.layers.find((l): l is ImageLayer => l.type === 'image' && l.role === 'product' && (l.asset.slot ?? 'main') === b.slot && l.visible);
    // A knocked-out picture keeps its content box (its crop), so the house look stands it on the podium again.
    products.push({ slot: b.slot, snapshot: snap, image: img ? { url: img.asset.ref, width: img.natural.width, height: img.natural.height, bounds: img.knockout === 'white' ? img.crop : null } : null });
  }
  if (doc.services.length > 1) return null;
  const service = doc.services[0] ? ctx.claims[doc.services[0].claim_id] ?? null : null;
  if (doc.services.length && !service) return null;
  const bg = backgroundInUse(doc, ctx.brand);
  const format = change.format ?? doc.format;
  const result = buildFromTemplate({
    template: doc.template.id as TemplateId, variant: change.variant ?? (doc.template.variant as VariantId), format, locale: doc.locale,
    objective: doc.objective, density: change.density ?? doc.density, brand: ctx.brand, brandVersion: ctx.brandVersion,
    products, service, copy: extractCopy(doc), evidence: ctx.evidence, family: ctx.family, logo: doc.layers.some((l) => l.id === 'logo') ? ctx.logo : null,
    backgroundNatural: bg ? bg.natural : ctx.backgroundNatural, background: bg?.preset ?? null,
    omit: doc.layers.some((l) => l.type === 'text' && l.role === 'cta' && l.visible) ? [] : ['cta'],
    slide: doc.slide, caption: doc.caption, alt_text: doc.alt_text, measure: ctx.measure,
  });
  // The person's colours and locks, on the layers the template made again under the same id.
  const before = new Map(doc.layers.map((l) => [l.id, l]));
  result.doc.layers = result.doc.layers.map((l): Layer => {
    const old = before.get(l.id);
    if (!old || l.role === 'background') return l;
    let next: Layer = l;
    if (next.type === 'text' && old.type === 'text' && old.color !== next.color && inPalette(ctx.brand, old.color)) next = { ...next, color: old.color };
    // A person's picture adjustment stays with the picture.
    if (next.type === 'image' && old.type === 'image' && old.adjust !== undefined && old.asset.ref === next.asset.ref) next = { ...next, adjust: old.adjust };
    if (next.type === 'shape' && old.type === 'shape' && next.role !== 'product_shadow' && old.fill && old.fill !== next.fill && inPalette(ctx.brand, old.fill)) next = { ...next, fill: old.fill };
    return old.locked && !next.locked ? { ...next, locked: true } : next;
  });
  // Carry person-added layers.
  const oldSafe = safeBox(doc);
  const newSafe = safeBox(result.doc);
  const k = Math.min(newSafe.width / oldSafe.width, newSafe.height / oldSafe.height);
  const extras = doc.layers.filter((l) => !isTemplateLayer(l.id));
  const carried: Layer[] = extras.map((l) => {
    const b = layerBox(l, doc.layers);
    if (!b || l.type === 'group') return l;
    const cx = newSafe.x + ((b.x + b.width / 2 - oldSafe.x) / oldSafe.width) * newSafe.width;
    const cy = newSafe.y + ((b.y + b.height / 2 - oldSafe.y) / oldSafe.height) * newSafe.height;
    if (l.type === 'image') {
      const scale = l.scale * k;
      const nb = layerBox({ ...l, scale })!;
      return { ...l, scale, x: cx - nb.width / 2, y: cy - nb.height / 2 };
    }
    if (l.type === 'text') return { ...l, width: l.width * k, height: l.height * k, font: { ...l.font, size: Math.max(l.minSize, Math.round(l.font.size * k)) }, x: cx - (l.width * k) / 2, y: cy - (l.height * k) / 2 };
    return { ...l, width: l.width * k, height: l.height * k, x: cx - (l.width * k) / 2, y: cy - (l.height * k) / 2 };
  });
  result.doc.layers.push(...carried);
  result.doc.annotations = [];
  return result;
}

/** A document with no template (made by hand) moved to another size: ONE scale, centred in the new safe area. */
export function refitFreeDocument(doc: CreativeDocument, format: DocFormat, kit: BrandKit): CreativeDocument {
  const safe_area = safeAreaFor(kit, format);
  const oldSafe = safeBox(doc);
  const newSafe = safeBox({ format, safe_area });
  const k = Math.min(newSafe.width / oldSafe.width, newSafe.height / oldSafe.height);
  const ox = newSafe.x + (newSafe.width - oldSafe.width * k) / 2;
  const oy = newSafe.y + (newSafe.height - oldSafe.height * k) / 2;
  const layers = doc.layers.map((l): Layer => {
    if (l.role === 'background') {
      if (l.type === 'shape') return { ...l, x: 0, y: 0, width: format.width, height: format.height };
      if (l.type === 'image') {
        const cover = Math.max(format.width / l.natural.width, format.height / l.natural.height);
        const cw = format.width / cover, ch = format.height / cover;
        return { ...l, x: 0, y: 0, crop: { x: (l.natural.width - cw) / 2, y: (l.natural.height - ch) / 2, width: cw, height: ch }, scale: cover, fit: 'detail' };
      }
    }
    if (l.type === 'group') return l;
    const nx = ox + (l.x - oldSafe.x) * k;
    const ny = oy + (l.y - oldSafe.y) * k;
    if (l.type === 'image') return { ...l, x: nx, y: ny, scale: l.scale * k };
    if (l.type === 'text') return { ...l, x: nx, y: ny, width: l.width * k, height: l.height * k, font: { ...l.font, size: Math.max(l.minSize, Math.round(l.font.size * k)) } };
    return { ...l, x: nx, y: ny, width: l.width * k, height: l.height * k, radius: l.radius * k, blur: l.blur * k };
  });
  return applyAnchors({ ...doc, format: { ...format }, safe_area, layers, annotations: [] });
}

export { unionBox };
