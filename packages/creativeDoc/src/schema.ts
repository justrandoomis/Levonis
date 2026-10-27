/**
 * THE CREATIVE DOCUMENT — one schema for the editor, the exporter, the Worker
 * and Claude (Creative Studio spec §15).
 *
 * A document is a scene graph: an ordered list of layers (array order is
 * paint order, first = bottom), each with a STABLE id that survives every
 * edit, save, reopen and format change. Nothing in it is a screen
 * coordinate: x/y/width/height are DOCUMENT pixels at 1× export size, origin
 * top-left, y down, whatever the text direction. The editor scales the whole
 * document to fit its viewport and the exporter renders it at an integer
 * pixel ratio; both go through `docToView` / `viewToDoc` (below), so a point
 * the owner taps on a zoomed phone preview lands on the same document pixel
 * as a click on a desktop.
 *
 * What is deliberately NOT expressible here:
 *   - a stretched product: an image layer has ONE `scale`; its box is derived
 *     from the image's natural size, so scaleX ≠ scaleY cannot be stored
 *     (spec §13);
 *   - a price typed as free text: a price is a BINDING to a store snapshot,
 *     rendered by the app from the snapshot, never written by a person or a
 *     model (spec §9, §15, DECISIONS row 262);
 *   - letter spacing: it breaks Arabic joining (spec §8), so there is no
 *     field for it;
 *   - flip, skew, perspective: no field (spec §13).
 *
 * The approval state, the version counter and who changed what live in the
 * Worker's tables, not in the document JSON: a document cannot approve itself.
 */

export const SCHEMA_VERSION = 1 as const;

/** Hard caps — `normalizeDocument` clamps or refuses past these. */
export const MAX_LAYERS = 80;
export const MAX_RELATIONS = 120;
export const MAX_ANNOTATIONS = 60;
export const MAX_TEXT_CHARS = 600;
export const MAX_CAPTION_CHARS = 2200;
export const MAX_ALT_CHARS = 420;
export const MAX_NAME_CHARS = 60;
/** A serialised document above this is refused (the D1 row and the AI context both stay small). */
export const MAX_DOCUMENT_BYTES = 192 * 1024;

/** A layer, relation or annotation id: stable, short, never a user-visible label. */
export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export type FormatId = 'square' | 'portrait' | 'story' | 'custom';

export interface DocFormat {
  id: FormatId;
  width: number;
  height: number;
}

export const FORMATS: Readonly<Record<Exclude<FormatId, 'custom'>, DocFormat>> = Object.freeze({
  square: { id: 'square', width: 1080, height: 1080 },
  portrait: { id: 'portrait', width: 1080, height: 1350 },
  story: { id: 'story', width: 1080, height: 1920 },
});

/** The declared bounds of a custom size (spec §24: «مقاس مخصص ضمن حدود معلنة»). */
export const CUSTOM_FORMAT_LIMITS = Object.freeze({ min: 320, max: 4096, maxPixels: 4096 * 4096, maxAspect: 4 });

export function formatOf(id: FormatId, width?: number, height?: number): DocFormat | null {
  if (id !== 'custom') return { ...FORMATS[id] };
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  const w = width as number;
  const h = height as number;
  const L = CUSTOM_FORMAT_LIMITS;
  if (w < L.min || h < L.min || w > L.max || h > L.max) return null;
  if (w * h > L.maxPixels || Math.max(w / h, h / w) > L.maxAspect) return null;
  return { id: 'custom', width: w, height: h };
}

// ---------------------------------------------------------------------------
// Fonts — a closed registry. A document can only name a family listed here,
// so a model cannot invent a font URL (spec §15) and the exporter knows every
// face it must wait for (spec §8 «انتظر اكتمال تحميل الخطوط»).
// ---------------------------------------------------------------------------

export type FontFamilyId = 'plex-arabic' | 'cairo';
export type FontWeight = 400 | 500 | 600 | 700 | 800;

export interface FontDef {
  id: FontFamilyId;
  /** The CSS family name the renderer asks the browser for. */
  family: string;
  weights: readonly FontWeight[];
  /** Characters this family has no glyph for (a quality check flags them; nothing is substituted silently). */
  missing: RegExp | null;
  license: string;
}

export const FONT_REGISTRY: Readonly<Record<FontFamilyId, FontDef>> = Object.freeze({
  // IBM Plex Sans Arabic, complete build (Arabic + Latin + every Sorani letter,
  // checked glyph by glyph). Self-hosted under public/fonts/ibm-plex-sans-arabic.
  'plex-arabic': {
    id: 'plex-arabic', family: 'IBM Plex Sans Arabic', weights: [400, 600, 700], missing: null, license: 'OFL-1.1',
  },
  // Cairo, the site font. Its Arabic subset has no glyph for the five Sorani
  // letters below; the site covers them with a patch face declared as
  // "Cairo", which the studio loads too — the check still warns, because a
  // canvas that drew before the patch arrived would show a fallback glyph.
  cairo: {
    id: 'cairo', family: 'Cairo', weights: [400, 500, 600, 700, 800], missing: /[\u06D5\u06CE\u06C6\u0695\u06B5]/, license: 'OFL-1.1',
  },
});

export function isFontFamily(v: unknown): v is FontFamilyId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FONT_REGISTRY, v);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type Direction = 'rtl' | 'ltr' | 'auto';
/** Logical alignment: `start` is the right edge in an RTL line. */
export type TextAlign = 'start' | 'center' | 'end';

/** What a layer IS in the ad, independent of how it looks — templates, relations, checks and Claude all speak in roles. */
export type LayerRole =
  | 'background' | 'product' | 'product_shadow' | 'logo' | 'headline' | 'subhead' | 'body' | 'feature'
  | 'product_name' | 'price' | 'price_note' | 'availability' | 'cta' | 'badge' | 'decor' | 'icon' | 'slide_number';

export const LAYER_ROLES: readonly LayerRole[] = [
  'background', 'product', 'product_shadow', 'logo', 'headline', 'subhead', 'body', 'feature',
  'product_name', 'price', 'price_note', 'availability', 'cta', 'badge', 'decor', 'icon', 'slide_number',
];

export interface LayerBase {
  id: string;
  name: string;
  role: LayerRole;
  /** A group layer's id, or null at the top level. */
  parent: string | null;
  x: number;
  y: number;
  /** Degrees, clockwise, about the box centre. Product images stay at 0 unless the brand kit allows otherwise. */
  rotation: number;
  opacity: number;
  visible: boolean;
  /**
   * A locked layer is never changed by Claude, and the editor refuses to move it until it is unlocked by a person.
   * The lock holds through the tree: everything inside a locked group is locked too (`lockedAbove`).
   */
  locked: boolean;
}

/**
 * Where a text layer's words come from. `free` is typed by a person (or
 * proposed by Claude and accepted by one). Every other source is RENDERED by
 * the app from data — the document stores the binding, never the number.
 */
export type TextSource =
  | { kind: 'free' }
  | { kind: 'product'; slot: string; field: ProductTextField }
  | { kind: 'service'; claim_id: string; field: 'title' | 'summary' | 'conditions' }
  | { kind: 'slide_number' };

export type ProductTextField = 'name' | 'brand' | 'price' | 'price_note' | 'availability' | 'variant';

export interface TextLayer extends LayerBase {
  type: 'text';
  /** The words for a `free` source; for a bound source, the last rendering (for search and diffs only — never trusted as the value). */
  text: string;
  source: TextSource;
  width: number;
  /** The box height the template reserved; the measured text must fit inside it (a quality check). */
  height: number;
  font: { family: FontFamilyId; weight: FontWeight; size: number; lineHeight: number };
  /** The smallest size the layout may shrink to — the brand kit's floor for this role (spec §8: never unreadably small). */
  minSize: number;
  maxLines: number;
  color: string;
  align: TextAlign;
  direction: Direction;
}

export type AssetKind = 'product' | 'asset' | 'logo';

/**
 * A reference to an image the app already knows: a product picture by its
 * catalogue url (product media are same-origin `/files/products/...`, which
 * keeps the export canvas untainted), a studio asset by id, or the site logo.
 * Never a URL a model wrote.
 */
export interface AssetRef {
  kind: AssetKind;
  /** product: the product_images url (`/files/...`); asset: a creative_assets id; logo: `site` or a creative_assets id. */
  ref: string;
  /** For a product picture: which product binding slot it belongs to (so a swap stays inside that product's own pictures). */
  slot?: string;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  asset: AssetRef;
  /** The source's natural size in pixels, recorded when the asset was placed. */
  natural: { width: number; height: number };
  /**
   * Non-destructive crop in SOURCE pixels. Absent = the whole picture. A crop
   * of a product is a deliberate detail shot (`fit: 'detail'`), never a way to
   * stretch: the drawn box always keeps the crop's own aspect ratio.
   */
  crop: { x: number; y: number; width: number; height: number } | null;
  /** THE one scale. Drawn size = (crop ?? natural) × scale on both axes. */
  scale: number;
  fit: 'whole' | 'detail';
}

export type ShapeKind = 'rect' | 'ellipse' | 'line';

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: ShapeKind;
  width: number;
  height: number;
  fill: string | null;
  stroke: { color: string; width: number } | null;
  radius: number;
  /** Gaussian softness in document px (soft contact shadows, clay depth). 0 = crisp. */
  blur: number;
}

/** A logical container: it has no geometry of its own; moving it moves its children. */
export interface GroupLayer extends LayerBase {
  type: 'group';
}

export type Layer = TextLayer | ImageLayer | ShapeLayer | GroupLayer;
export type LayerType = Layer['type'];

// ---------------------------------------------------------------------------
// Relations — the rules that decide which layers follow when one changes
// (spec §14). Only a layer's DEPENDENTS are recomputed after an edit.
// ---------------------------------------------------------------------------

export type Relation =
  /** `subject` sits `gap` px below `target` (price under the product name). */
  | { id: string; kind: 'below'; subject: string; target: string; gap: number }
  /** `subject` keeps at least `gap` px of clear space from `target` (headline clear of the product). */
  | { id: string; kind: 'clear_of'; subject: string; target: string; gap: number }
  /** `subject` is pinned to a corner of the safe area with `margin` px inside it (the logo). */
  | { id: string; kind: 'anchor'; subject: string; corner: Corner; margin: number }
  /** The listed layers keep this top-to-bottom order (feature bullets). */
  | { id: string; kind: 'order'; members: string[]; gap: number }
  /** `subject` (a soft ellipse) is the contact shadow of `target` and is redrawn from the target's box whenever it changes. */
  | { id: string; kind: 'shadow_of'; subject: string; target: string };

export type Corner = 'top_start' | 'top_end' | 'bottom_start' | 'bottom_end';
export type RelationKind = Relation['kind'];

// ---------------------------------------------------------------------------
// Bindings — the store data a document is built from (spec §9, §19).
// ---------------------------------------------------------------------------

export interface ProductBinding {
  /** `main`, or `p2`, `p3` for comparisons. */
  slot: string;
  product_id: string;
  /** The option/variant the picture, price and availability all belong to (null = the product as a whole). */
  variant_key: string | null;
  /** The marketing snapshot the rendered name/price/availability came from. */
  snapshot_id: string;
}

export interface ServiceBinding {
  claim_id: string;
  /** The claim version the text was rendered from; a newer version makes the document need review. */
  claim_version: number;
}

// ---------------------------------------------------------------------------
// Annotations — the owner's pins, boxes and arrows on the preview (spec §17).
// Stored with the document so a later edit can be pointed at them; NEVER
// rendered by the exporter.
// ---------------------------------------------------------------------------

export interface Annotation {
  id: string;
  kind: 'pin' | 'box' | 'arrow';
  /** Document coordinates. A pin uses x/y; a box uses all four; an arrow goes from (x,y) to (x+width, y+height). */
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
  /** The layers under the mark when it was drawn — the precise target, not a description of a picture. */
  layer_ids: string[];
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export type Objective = 'sell' | 'arrival' | 'back_in_stock' | 'feature' | 'comparison' | 'education' | 'service_trust';
export const OBJECTIVES: readonly Objective[] = ['sell', 'arrival', 'back_in_stock', 'feature', 'comparison', 'education', 'service_trust'];

export type VisualPriority = 'product' | 'price' | 'headline' | 'feature';
export const VISUAL_PRIORITIES: readonly VisualPriority[] = ['product', 'price', 'headline', 'feature'];

export type Density = 'brief' | 'detailed';
export type AdLocale = 'ar' | 'en' | 'ckb';

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CreativeDocument {
  schema_version: typeof SCHEMA_VERSION;
  format: DocFormat;
  locale: AdLocale;
  /** The ad's base direction (rtl for ar/ckb). Each text layer still carries its own. */
  direction: 'rtl' | 'ltr';
  objective: Objective;
  priority: VisualPriority;
  density: Density;
  template: { id: string; version: number; variant: string } | null;
  brand_version: number | null;
  safe_area: SafeArea;
  products: ProductBinding[];
  services: ServiceBinding[];
  layers: Layer[];
  relations: Relation[];
  annotations: Annotation[];
  /** The post's words outside the picture (spec §20: hashtags and long text do not go inside the image). */
  caption: string;
  alt_text: string;
  /** A carousel slide's position, when the document is one slide of a set. */
  slide: { index: number; count: number } | null;
}

// ---------------------------------------------------------------------------
// Geometry helpers shared by the editor, the exporter, the layout and checks
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A layer's unrotated box in document pixels. Groups: the union of their children (null when empty). */
export function layerBox(layer: Layer, all?: readonly Layer[]): Box | null {
  switch (layer.type) {
    case 'text':
    case 'shape':
      return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    case 'image': {
      const src = layer.crop ?? { width: layer.natural.width, height: layer.natural.height };
      return { x: layer.x, y: layer.y, width: src.width * layer.scale, height: src.height * layer.scale };
    }
    case 'group': {
      if (!all) return null;
      const boxes = all.filter((l) => l.parent === layer.id).map((l) => layerBox(l, all)).filter((b): b is Box => !!b);
      return boxes.length ? unionBox(boxes) : null;
    }
  }
}

export function unionBox(boxes: readonly Box[]): Box {
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.width));
  const y2 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function intersects(a: Box, b: Box, pad = 0): boolean {
  return a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;
}

export function contains(outer: Box, inner: Box, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance && inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** The safe area as a box. */
export function safeBox(doc: Pick<CreativeDocument, 'format' | 'safe_area'>): Box {
  const s = doc.safe_area;
  return { x: s.left, y: s.top, width: doc.format.width - s.left - s.right, height: doc.format.height - s.top - s.bottom };
}

/**
 * The editor's view transform: the document is drawn at `scale` and shifted
 * by `offset` (pan) inside the viewport. These two functions are the only
 * place screen and document coordinates meet (spec §15, §17).
 */
export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function viewToDoc(t: ViewTransform, px: number, py: number): { x: number; y: number } {
  return { x: (px - t.offsetX) / t.scale, y: (py - t.offsetY) / t.scale };
}

export function docToView(t: ViewTransform, x: number, y: number): { x: number; y: number } {
  return { x: x * t.scale + t.offsetX, y: y * t.scale + t.offsetY };
}

/** The aspect ratio of what an image layer draws (crop or whole). */
export function drawnRatio(layer: ImageLayer): number {
  const src = layer.crop ?? layer.natural;
  return src.width / src.height;
}

export function findLayer(doc: Pick<CreativeDocument, 'layers'>, id: string): Layer | undefined {
  return doc.layers.find((l) => l.id === id);
}

/** A layer plus every descendant (a group's children, recursively). */
export function withDescendants(layers: readonly Layer[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const l of layers) if (l.parent === out[i]) out.push(l.id);
  return out;
}

/**
 * LOCKS HOLD THROUGH THE TREE (spec §23, §34-7). A lock protects the layer
 * that carries it and everything inside it: a child of a locked group is as
 * locked as the group. These three answers are the one definition the ops,
 * the relation propagation and the editor all use.
 */

/** The locked layer protecting `id`: itself or the nearest locked group above it, or null. */
export function lockedAbove(layers: readonly Layer[], id: string): string | null {
  const seen = new Set<string>();
  for (let l = layers.find((x) => x.id === id); l && !seen.has(l.id); l = l.parent ? layers.find((x) => x.id === l!.parent) : undefined) {
    if (l.locked) return l.id;
    seen.add(l.id);
  }
  return null;
}

/** A locked layer among `id` and its descendants, or null — acting on a whole group would carry it along. */
export function lockedWithin(layers: readonly Layer[], id: string): string | null {
  const inside = new Set(withDescendants(layers, id));
  return layers.find((l) => inside.has(l.id) && l.locked)?.id ?? null;
}

/** True when moving, hiding, deleting or reordering `id` would change a locked layer (it, a group above it, or one inside it). */
export function touchesLock(layers: readonly Layer[], id: string): boolean {
  return lockedAbove(layers, id) !== null || lockedWithin(layers, id) !== null;
}

/** True when a colour is a literal `#RRGGBB` (the only form a document stores). */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}
