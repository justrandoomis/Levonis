/**
 * DETERMINISTIC QUALITY CHECKS (spec §23, §44 layer 1).
 *
 * These are facts the app can prove: the picture belongs to the bound
 * product and variant, the price came from a verified source, the product is
 * not transformed, the fonts and pictures are really loaded, the text fits,
 * essentials are inside the safe area, nothing overlaps that should not.
 * Visual taste is NOT judged here (that is the optional model review, which
 * is advice only).
 *
 *   blocker   blocks approval and the final export (a draft or preview can
 *             still be exported, clearly marked)
 *   review    shown as needing a person's look
 *   optional  a suggestion
 *
 * The report lists which checks RAN and which were SKIPPED (no measurer, no
 * font list, no re-verification yet). "Passed" means exactly the checks that
 * ran — never a quality score (spec §44).
 */
import type { BrandKit } from './brand';
import { detectConflicts, renderSource, textFits } from './layout';
import { FONT_REGISTRY, layerBox, safeBox, type CreativeDocument, type ImageLayer, type TextLayer } from './schema';
import { blockingChanges, type ProductSnapshot, type ServiceClaimText, type SnapshotChange } from './snapshot';
import { TEMPLATES, type ProductBlock, type VariantId } from './templates';
import { claimsIn, containsPriceLike, unsupportedClaims, type ClaimEvidence, type TextMeasurer } from './text';

export type Severity = 'blocker' | 'review' | 'optional';

export type QualityCode =
  | 'snapshot_missing' | 'wrong_variant_image' | 'test_data' | 'price_unavailable' | 'unbound_price_text' | 'source_changed'
  | 'unverified_source' | 'product_transformed' | 'product_detail_crop' | 'low_resolution' | 'font_weight' | 'missing_glyph'
  | 'font_not_loaded' | 'text_overflow' | 'small_text' | 'outside_safe_area' | 'overlap' | 'off_canvas' | 'off_palette'
  | 'asset_missing' | 'dense' | 'claim_missing' | 'claim_changed' | 'conditions_missing' | 'alt_text_missing'
  | 'caption_missing' | 'not_sorani' | 'headline_missing' | 'bound_text_missing' | 'unsupported_claim_text'
  | 'product_too_small' | 'asset_ratio_mismatch';

export interface QualityIssue {
  code: QualityCode;
  severity: Severity;
  layer_ids: string[];
  detail?: string;
}

export type CheckName = 'data' | 'product' | 'fonts' | 'text_fit' | 'layout' | 'brand' | 'assets' | 'claims' | 'language' | 'meta';

export interface QualityReport {
  issues: QualityIssue[];
  blockers: number;
  ran: CheckName[];
  skipped: Array<{ check: CheckName; why: string }>;
}

export interface ClaimState extends ServiceClaimText {
  approved: boolean;
  valid_until: string | null;
}

export interface QualityContext {
  brand: BrandKit;
  /** Snapshots by product binding slot. */
  snapshots: Readonly<Record<string, Pick<ProductSnapshot, 'id' | 'data' | 'source'>>>;
  /** Claims by id, with their approval state. */
  claims: Readonly<Record<string, ClaimState>>;
  /** Re-verification result per slot (fresh vs bound snapshot); absent = not verified yet. */
  verification?: Readonly<Record<string, SnapshotChange[]>>;
  measure?: TextMeasurer;
  /** CSS family+weight keys ("IBM Plex Sans Arabic|700") the browser reports loaded. */
  fontsLoaded?: ReadonlySet<string>;
  /** Image refs that decoded successfully in the renderer. */
  assetsLoaded?: ReadonlySet<string>;
  /**
   * The size each image ref actually decoded at in the renderer (keyed like
   * `assetsLoaded`). A layer whose recorded size has another ratio is drawn
   * contained, never stretched — and the checks report it.
   */
  decodedSizes?: Readonly<Record<string, { width: number; height: number }>>;
  /**
   * Evidence only the catalogue watch has: a documented arrival or return to
   * stock for the bound product. Offer and service evidence are derived here
   * from the snapshots and claims. Absent = not reported: arrival and
   * back-in-stock words are then not judged, and the report says so.
   */
  claimEvidence?: Partial<ClaimEvidence>;
  /** `final`: approval or a final export — unverified data becomes a blocker. */
  final: boolean;
  /** "now" as an ISO string (passed in: the package has no clock). */
  now: string;
}

const ARABIC_ONLY = /[\u0629\u0649\u064A\u0643]/;

/** |a / b − 1|: how far one width/height ratio is from another. */
const ratioOff = (a: { width: number; height: number }, b: { width: number; height: number }) => Math.abs((a.width / a.height) / (b.width / b.height) - 1);

/** The template's product block for a slot, with the column it is laid out in (stack and split layouts only). */
function productBlockOf(doc: CreativeDocument, slot: string): { block: ProductBlock; column: number } | null {
  const t = doc.template ? TEMPLATES[doc.template.id as keyof typeof TEMPLATES] : undefined;
  const v = t?.variants[doc.template!.variant as VariantId];
  if (!v || v.layout === 'pair') return null;
  const block = v.blocks.find((b): b is ProductBlock => b.kind === 'product' && b.productSlot === slot);
  return block ? { block, column: v.layout === 'split' ? 1 - (v.textColumn ?? 0.5) : 1 } : null;
}

export function fontKey(family: string, weight: number): string {
  return `${family}|${weight}`;
}

export function qualityReport(doc: CreativeDocument, ctx: QualityContext): QualityReport {
  const issues: QualityIssue[] = [];
  const ran: CheckName[] = [];
  const skipped: QualityReport['skipped'] = [];
  const add = (code: QualityCode, severity: Severity, layer_ids: string[] = [], detail?: string) => issues.push({ code, severity, layer_ids, ...(detail ? { detail } : {}) });
  const visible = doc.layers.filter((l) => l.visible);
  const texts = visible.filter((l): l is TextLayer => l.type === 'text');
  const products = visible.filter((l): l is ImageLayer => l.type === 'image' && l.role === 'product');
  const showsPrice = texts.some((t) => t.source.kind === 'product' && t.source.field === 'price');
  const showsAvailability = texts.some((t) => t.source.kind === 'product' && t.source.field === 'availability');
  const priceAd = doc.objective === 'sell' || doc.priority === 'price';

  // DATA — every binding has its snapshot; prices and availability come from it.
  ran.push('data');
  for (const b of doc.products) {
    const snap = ctx.snapshots[b.slot];
    if (!snap || snap.id !== b.snapshot_id) { add('snapshot_missing', 'blocker', [], b.slot); continue; }
    if (snap.source === 'test') add('test_data', ctx.final ? 'blocker' : 'review', [], b.slot);
    const priceLayers = texts.filter((t) => t.source.kind === 'product' && t.source.slot === b.slot && t.source.field === 'price').map((t) => t.id);
    if (priceLayers.length && snap.data.price.status !== 'priced') add('price_unavailable', priceAd ? 'blocker' : 'review', priceLayers, snap.data.price.status);
    const v = ctx.verification?.[b.slot];
    if (v) {
      const blocking = blockingChanges(v, { price: showsPrice, availability: showsAvailability });
      if (blocking.length) add('source_changed', 'blocker', [], blocking.join(','));
      else if (v.length) add('source_changed', 'review', [], v.join(','));
    } else if (ctx.final && (showsPrice || showsAvailability)) {
      add('unverified_source', 'blocker', [], b.slot);
    }
  }
  // Bound text draws data or nothing: its binding must exist and render, or the stored words would be drawn as data.
  const bindCtx = { snapshots: ctx.snapshots, claims: ctx.claims, brand: ctx.brand, locale: doc.locale, slide: doc.slide };
  for (const t of texts) {
    const src = t.source;
    if (src.kind === 'free') {
      if (containsPriceLike(t.text)) add('unbound_price_text', 'blocker', [t.id]);
      continue;
    }
    const bound = src.kind === 'product' ? doc.products.some((b) => b.slot === src.slot) : src.kind === 'service' ? doc.services.some((s) => s.claim_id === src.claim_id) : doc.slide !== null;
    if (!bound) add('bound_text_missing', 'blocker', [t.id], 'no binding');
    else if (!t.text) add('bound_text_missing', 'blocker', [t.id]);
    else if (renderSource(src, bindCtx) === null) add('bound_text_missing', 'blocker', [t.id], 'renders nothing');
  }

  // PRODUCT — the right picture, untransformed.
  ran.push('product');
  for (const p of products) {
    const slot = p.asset.slot ?? 'main';
    const binding = doc.products.find((b) => b.slot === slot);
    const snap = ctx.snapshots[slot];
    const img = snap?.data.images.find((i) => i.url === p.asset.ref);
    if (!binding || !snap || !img) add('wrong_variant_image', 'blocker', [p.id], 'not a picture of the bound product');
    else if (img.variant_key !== null && binding.variant_key !== null && img.variant_key !== binding.variant_key) add('wrong_variant_image', 'blocker', [p.id], `picture of ${img.variant_key}, bound ${binding.variant_key}`);
    // The renderer draws the picture into natural × scale: a recorded size of another ratio stretches it (spec §13, §34-3).
    if (img && img.width && img.height && ratioOff(p.natural, { width: img.width, height: img.height }) > 0.01) add('product_transformed', 'blocker', [p.id], 'stretched');
    if (p.rotation !== 0) add('product_transformed', 'blocker', [p.id], 'rotated');
    if (p.fit === 'detail') add('product_detail_crop', 'review', [p.id]);
    if (p.scale > 1.6) add('low_resolution', 'review', [p.id], `drawn at ${p.scale.toFixed(2)}× its pixels`);
    // Size: a product reduced to a speck is no ad; one under its template's share needs a look (spec §12, §14).
    const box = layerBox(p)!;
    const shortSide = Math.min(doc.format.width, doc.format.height);
    if (Math.min(box.width, box.height) < shortSide * 0.05) { add('product_too_small', 'blocker', [p.id], `${Math.round(box.width)}×${Math.round(box.height)}`); continue; }
    const share = productBlockOf(doc, slot);
    if (share && share.block.minFrac > 0) {
      const safe = safeBox(doc);
      const src = p.crop ?? p.natural;
      const widthCap = ((safe.width * share.column * share.block.widthFrac) / src.width) * src.height;
      const want = Math.min(share.block.minFrac * safe.height, widthCap);
      if (box.height < want * 0.75) add('product_too_small', 'review', [p.id], `${Math.round(box.height)} < ${Math.round(want)}`);
    }
  }

  // FONTS — registered weight, glyph coverage, really loaded.
  ran.push('fonts');
  for (const t of texts) {
    const def = FONT_REGISTRY[t.font.family];
    if (!def.weights.includes(t.font.weight)) add('font_weight', 'blocker', [t.id]);
    if (def.missing && def.missing.test(t.text)) add('missing_glyph', 'review', [t.id], def.family);
  }
  if (ctx.fontsLoaded) {
    const missing = texts.filter((t) => !ctx.fontsLoaded!.has(fontKey(FONT_REGISTRY[t.font.family].family, t.font.weight))).map((t) => t.id);
    if (missing.length) add('font_not_loaded', 'blocker', missing);
  } else skipped.push({ check: 'fonts', why: 'font load state not reported' });

  // TEXT FIT — measured with the same measurer the renderer uses.
  if (ctx.measure) {
    ran.push('text_fit');
    const over = texts.filter((t) => !textFits(t, ctx.measure!)).map((t) => t.id);
    if (over.length) add('text_overflow', 'blocker', over);
    const floor = (20 * doc.format.width) / 1080;
    // Against the floor itself: normalize keeps minSize ≤ size, so a test against minSize could never fire.
    const small = texts.filter((t) => t.font.size < floor - 0.01).map((t) => t.id);
    if (small.length) add('small_text', 'review', small);
  } else skipped.push({ check: 'text_fit', why: 'no text measurer (the Worker cannot measure; the editor runs this check)' });

  // LAYOUT — safe area, overlap, off-canvas.
  ran.push('layout');
  for (const c of detectConflicts(doc)) {
    if (c.code === 'outside_safe_area') add('outside_safe_area', 'blocker', c.layer_ids);
    if (c.code === 'overlap') add('overlap', 'blocker', c.layer_ids);
  }
  const canvas = { x: 0, y: 0, width: doc.format.width, height: doc.format.height };
  const off = visible.filter((l) => l.type !== 'group' && l.role !== 'background').filter((l) => {
    const b = layerBox(l, doc.layers);
    return b && (b.x + b.width <= canvas.x || b.y + b.height <= canvas.y || b.x >= canvas.width || b.y >= canvas.height);
  }).map((l) => l.id);
  if (off.length) add('off_canvas', 'review', off);

  // BRAND — palette and density.
  ran.push('brand');
  const offPalette = visible.filter((l) => (l.type === 'text' && !ctx.brand.colors.palette.includes(l.color)) || (l.type === 'shape' && l.role !== 'product_shadow' && l.fill !== null && !ctx.brand.colors.palette.includes(l.fill) && l.role !== 'background')).map((l) => l.id);
  if (offPalette.length) add('off_palette', 'review', offPalette);
  if (texts.length > ctx.brand.density.max_text_layers) add('dense', 'review', texts.map((t) => t.id), `${texts.length} > ${ctx.brand.density.max_text_layers}`);
  if (!texts.some((t) => t.role === 'headline')) add('headline_missing', 'review');

  // ASSETS — every picture really decoded, at the ratio the document records.
  if (ctx.assetsLoaded || ctx.decodedSizes) {
    ran.push('assets');
    const images = visible.filter((l): l is ImageLayer => l.type === 'image');
    if (ctx.assetsLoaded) {
      const missing = images.filter((l) => !ctx.assetsLoaded!.has(l.asset.ref)).map((l) => l.id);
      if (missing.length) add('asset_missing', 'blocker', missing);
    }
    if (ctx.decodedSizes) {
      // A replaced logo or an EXIF-rotated upload decodes at another ratio than recorded (editor-8).
      const off = images.filter((l) => {
        const d = ctx.decodedSizes![l.asset.ref];
        return !!d && d.width > 0 && d.height > 0 && ratioOff(l.natural, d) > 0.005;
      }).map((l) => l.id);
      if (off.length) add('asset_ratio_mismatch', 'blocker', off);
    }
  } else skipped.push({ check: 'assets', why: 'asset load state not reported' });

  // CLAIMS — approved, current, conditions kept; free text claims nothing the evidence does not cover.
  ran.push('claims');
  const evidence: ClaimEvidence = {
    offer: doc.products.some((b) => { const s = ctx.snapshots[b.slot]; return !!s && s.id === b.snapshot_id && s.data.price.offer !== null; }),
    serviceClaim: doc.services.some((s) => { const c = ctx.claims[s.claim_id]; return !!c && c.approved && (c.valid_until === null || c.valid_until >= ctx.now); }),
    // Not reported = not judged (listed as skipped below), never silently passed as proven.
    arrival: ctx.claimEvidence ? ctx.claimEvidence.arrival === true : true,
    backInStock: ctx.claimEvidence ? ctx.claimEvidence.backInStock === true : true,
  };
  let unjudged = false;
  for (const t of texts) {
    if (t.source.kind !== 'free' || !t.text) continue;
    const bad = unsupportedClaims(t.text, evidence);
    if (bad.length) add('unsupported_claim_text', 'blocker', [t.id], bad.join(','));
    if (!ctx.claimEvidence && claimsIn(t.text).some((k) => k === 'arrival' || k === 'back_in_stock')) unjudged = true;
  }
  if (unjudged) skipped.push({ check: 'claims', why: 'arrival / back-in-stock evidence not reported' });
  for (const s of doc.services) {
    const c = ctx.claims[s.claim_id];
    if (!c || !c.approved || (c.valid_until !== null && c.valid_until < ctx.now)) { add('claim_missing', 'blocker', [], s.claim_id); continue; }
    if (c.version !== s.claim_version) add('claim_changed', ctx.final ? 'blocker' : 'review', [], `${s.claim_version} → ${c.version}`);
    const hasConditions = Object.values(c.conditions).some((x) => x.trim());
    const shown = texts.some((t) => t.source.kind === 'service' && t.source.claim_id === s.claim_id && t.source.field === 'conditions');
    if (hasConditions && !shown) add('conditions_missing', 'blocker', [], s.claim_id);
  }

  // LANGUAGE — a Sorani ad is not Arabic text in disguise (DECISIONS row 183).
  ran.push('language');
  if (doc.locale === 'ckb') {
    const arabic = texts.filter((t) => t.source.kind === 'free' && ARABIC_ONLY.test(t.text)).map((t) => t.id);
    if (arabic.length) add('not_sorani', 'review', arabic);
  }

  // META — words outside the picture.
  ran.push('meta');
  if (!doc.alt_text.trim()) add('alt_text_missing', 'optional');
  if (!doc.caption.trim()) add('caption_missing', 'optional');

  return { issues, blockers: issues.filter((i) => i.severity === 'blocker').length, ran, skipped };
}
