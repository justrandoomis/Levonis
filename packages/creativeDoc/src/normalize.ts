/**
 * normalizeDocument — THE ONE GATE every creative document passes.
 *
 * It runs in the Worker on every write and every read, in the editor on load
 * and import (Project JSON), and on anything assembled from a model's
 * proposal. It never throws and always returns a complete, valid document:
 *
 *   - UNKNOWN is STRIPPED (keys, layer fields), with an issue. Nothing
 *     input-shaped is copied through, so `__proto__` and friends are just more
 *     unknown keys.
 *   - OUT OF BOUNDS is CLAMPED (numbers, text length, list length), with an issue.
 *   - DANGEROUS is REFUSED — the value is removed AND the issue is `fatal`,
 *     which the write paths turn into a refusal: a future schema, an oversize
 *     document, an image reference that is not a same-origin `/files/` path or
 *     a studio asset id (no URL a model or an import invented), a font not in
 *     the registry, duplicate or malformed ids, a cycle in the group tree, a
 *     stretched product (a crop/natural size that is not a positive box).
 *
 * Idempotent: normalising its own output changes nothing and reports nothing.
 */
import {
  CUSTOM_FORMAT_LIMITS, FONT_REGISTRY, ID_PATTERN, isFontFamily, isHexColor, LAYER_ROLES, MAX_ALT_CHARS, MAX_ANNOTATIONS,
  MAX_CAPTION_CHARS, MAX_DOCUMENT_BYTES, MAX_LAYERS, MAX_NAME_CHARS, MAX_RELATIONS, MAX_TEXT_CHARS, OBJECTIVES, SCHEMA_VERSION,
  VISUAL_PRIORITIES, formatOf, BRAND_TEXT_FIELDS, PRODUCT_TEXT_FIELDS, type Gradient,
  type Annotation, type AssetRef, type Corner, type CreativeDocument, type DocFormat, type FontWeight, type ImageLayer, type Layer,
  type LayerBase, type LayerRole, type ProductBinding, type Relation, type SafeArea, type ServiceBinding, type ShapeLayer,
  type TextLayer, type TextSource, type PictureAdjust,
} from './schema';
import { cleanText } from './text';

export type DocIssueCode =
  // fatal — refused on write
  | 'not_an_object' | 'unsupported_schema_version' | 'payload_too_large' | 'invalid_format' | 'invalid_id' | 'duplicate_id'
  | 'unknown_layer_type' | 'unsafe_asset_ref' | 'unknown_font' | 'invalid_image' | 'group_cycle'
  // cleaned — reported, never refused
  | 'unknown_key' | 'invalid_value' | 'clamped' | 'truncated' | 'dangling_parent' | 'dangling_relation' | 'too_many';

export interface DocIssue {
  path: string;
  code: DocIssueCode;
  fatal: boolean;
}

const FATAL: ReadonlySet<DocIssueCode> = new Set([
  'not_an_object', 'unsupported_schema_version', 'payload_too_large', 'invalid_format', 'invalid_id', 'duplicate_id',
  'unknown_layer_type', 'unsafe_asset_ref', 'unknown_font', 'invalid_image', 'group_cycle',
]);

/** A same-origin media path the exporter can draw without tainting the canvas. */
export const SAFE_FILES_PATH = /^\/files\/[A-Za-z0-9][A-Za-z0-9._~\-/]{0,400}(?:\?v=[A-Za-z0-9_-]{1,40})?$/;
/** A creative_assets id. */
export const ASSET_ID = /^[A-Za-z0-9_-]{6,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

class Ctx {
  issues: DocIssue[] = [];
  push(path: string, code: DocIssueCode) {
    this.issues.push({ path, code, fatal: FATAL.has(code) });
  }
  num(path: string, v: unknown, min: number, max: number, fallback: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (v !== undefined) this.push(path, 'invalid_value');
      return fallback;
    }
    if (v < min || v > max) {
      this.push(path, 'clamped');
      return Math.min(max, Math.max(min, v));
    }
    return v;
  }
  bool(path: string, v: unknown, fallback: boolean): boolean {
    if (typeof v === 'boolean') return v;
    if (v !== undefined) this.push(path, 'invalid_value');
    return fallback;
  }
  oneOf<T extends string>(path: string, v: unknown, allowed: readonly T[], fallback: T): T {
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    if (v !== undefined) this.push(path, 'invalid_value');
    return fallback;
  }
  text(path: string, v: unknown, max: number, multiline = false): string {
    const r = cleanText(v, max, multiline);
    if (r.truncated) this.push(path, 'truncated');
    return r.value;
  }
  color(path: string, v: unknown, fallback: string | null): string | null {
    if (v === null) return null;
    if (isHexColor(v)) return v.toLowerCase();
    if (v !== undefined) this.push(path, 'invalid_value');
    return fallback;
  }
  keys(path: string, src: Obj, known: readonly string[]) {
    for (const k of Object.keys(src)) if (!known.includes(k)) this.push(path ? `${path}.${k}` : k, 'unknown_key');
  }
}

const BASE_KEYS = ['id', 'type', 'name', 'role', 'parent', 'x', 'y', 'rotation', 'opacity', 'visible', 'locked'] as const;
const COORD = 20000;

function base(ctx: Ctx, path: string, src: Obj): LayerBase | null {
  if (typeof src.id !== 'string' || !ID_PATTERN.test(src.id)) {
    ctx.push(`${path}.id`, 'invalid_id');
    return null;
  }
  return {
    id: src.id,
    name: ctx.text(`${path}.name`, src.name, MAX_NAME_CHARS) || src.id,
    role: ctx.oneOf<LayerRole>(`${path}.role`, src.role, LAYER_ROLES, 'decor'),
    parent: typeof src.parent === 'string' && ID_PATTERN.test(src.parent) ? src.parent : null,
    x: ctx.num(`${path}.x`, src.x, -COORD, COORD, 0),
    y: ctx.num(`${path}.y`, src.y, -COORD, COORD, 0),
    rotation: ctx.num(`${path}.rotation`, src.rotation, -360, 360, 0),
    opacity: ctx.num(`${path}.opacity`, src.opacity, 0, 1, 1),
    visible: ctx.bool(`${path}.visible`, src.visible, true),
    locked: ctx.bool(`${path}.locked`, src.locked, false),
  };
}

function textSource(ctx: Ctx, path: string, v: unknown): TextSource {
  if (!isObj(v)) {
    if (v !== undefined) ctx.push(path, 'invalid_value');
    return { kind: 'free' };
  }
  switch (v.kind) {
    case 'free':
      return { kind: 'free' };
    case 'slide_number':
      return { kind: 'slide_number' };
    case 'product': {
      const slot = typeof v.slot === 'string' && ID_PATTERN.test(v.slot) ? v.slot : null;
      const field = ctx.oneOf(`${path}.field`, v.field, PRODUCT_TEXT_FIELDS, 'name');
      if (!slot) {
        ctx.push(`${path}.slot`, 'invalid_value');
        return { kind: 'free' };
      }
      return { kind: 'product', slot, field };
    }
    case 'brand':
      return { kind: 'brand', field: ctx.oneOf(`${path}.field`, v.field, BRAND_TEXT_FIELDS, 'site') };
    case 'service': {
      const claim = typeof v.claim_id === 'string' && ASSET_ID.test(v.claim_id) ? v.claim_id : null;
      if (!claim) {
        ctx.push(`${path}.claim_id`, 'invalid_value');
        return { kind: 'free' };
      }
      return { kind: 'service', claim_id: claim, field: ctx.oneOf(`${path}.field`, v.field, ['title', 'summary', 'conditions'] as const, 'summary') };
    }
    default:
      ctx.push(`${path}.kind`, 'invalid_value');
      return { kind: 'free' };
  }
}

/** An optional gradient: absent or null stays absent; a malformed one is dropped (reported), never half-kept. */
function gradientOf(ctx: Ctx, path: string, v: unknown): Gradient | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isObj(v) || !Array.isArray(v.stops) || v.stops.length < 2 || v.stops.length > 6) {
    ctx.push(path, 'invalid_value');
    return null;
  }
  const stops: Gradient['stops'] = [];
  for (const [i, raw] of (v.stops as unknown[]).entries()) {
    const st = isObj(raw) ? raw : {};
    const color = ctx.color(`${path}.stops.${i}.color`, st.color, null);
    if (!color) {
      ctx.push(`${path}.stops.${i}`, 'invalid_value');
      return null;
    }
    stops.push({ at: ctx.num(`${path}.stops.${i}.at`, st.at, 0, 1, i / (v.stops.length - 1)), color, opacity: ctx.num(`${path}.stops.${i}.opacity`, st.opacity, 0, 1, 1) });
  }
  stops.sort((a, b) => a.at - b.at);
  return { kind: ctx.oneOf(`${path}.kind`, v.kind, ['linear', 'radial'] as const, 'linear'), angle: ctx.num(`${path}.angle`, v.angle, -360, 360, 90), stops };
}

function textLayer(ctx: Ctx, path: string, src: Obj, b: LayerBase): TextLayer | null {
  ctx.keys(path, src, [...BASE_KEYS, 'text', 'source', 'width', 'height', 'font', 'minSize', 'maxLines', 'color', 'align', 'direction', 'gradient']);
  const f = isObj(src.font) ? src.font : {};
  if (!isFontFamily(f.family)) {
    ctx.push(`${path}.font.family`, 'unknown_font');
    return null;
  }
  const def = FONT_REGISTRY[f.family];
  const weight = (def.weights as readonly number[]).includes(f.weight as number) ? (f.weight as FontWeight) : def.weights.reduce((a, w) => (Math.abs(w - ((f.weight as number) || 400)) < Math.abs(a - ((f.weight as number) || 400)) ? w : a), def.weights[0]);
  if (weight !== f.weight) ctx.push(`${path}.font.weight`, 'invalid_value');
  const size = ctx.num(`${path}.font.size`, f.size, 8, 400, 40);
  return {
    ...b,
    type: 'text',
    text: ctx.text(`${path}.text`, src.text, MAX_TEXT_CHARS, true),
    source: textSource(ctx, `${path}.source`, src.source),
    width: ctx.num(`${path}.width`, src.width, 8, COORD, 400),
    height: ctx.num(`${path}.height`, src.height, 8, COORD, 80),
    font: { family: f.family, weight, size, lineHeight: ctx.num(`${path}.font.lineHeight`, f.lineHeight, 0.9, 2.5, 1.3) },
    minSize: ctx.num(`${path}.minSize`, src.minSize, 8, size, Math.min(size, 20)),
    maxLines: Math.round(ctx.num(`${path}.maxLines`, src.maxLines, 1, 20, 3)),
    color: ctx.color(`${path}.color`, src.color, '#f4f4f1') as string,
    align: ctx.oneOf(`${path}.align`, src.align, ['start', 'center', 'end'] as const, 'start'),
    direction: ctx.oneOf(`${path}.direction`, src.direction, ['rtl', 'ltr', 'auto'] as const, 'auto'),
    ...withGradient(ctx, path, src),
  };
}

function withGradient(ctx: Ctx, path: string, src: Obj): { gradient?: Gradient | null } {
  const g = gradientOf(ctx, `${path}.gradient`, src.gradient);
  return g === undefined ? {} : { gradient: g };
}

function assetRef(ctx: Ctx, path: string, v: unknown): AssetRef | null {
  if (!isObj(v)) {
    ctx.push(path, 'unsafe_asset_ref');
    return null;
  }
  const kind = v.kind;
  const ref = typeof v.ref === 'string' ? v.ref : '';
  const slot = typeof v.slot === 'string' && ID_PATTERN.test(v.slot) ? v.slot : undefined;
  if (kind === 'product') {
    if (!SAFE_FILES_PATH.test(ref) || ref.includes('..') || ref.includes('//', 1)) {
      ctx.push(`${path}.ref`, 'unsafe_asset_ref');
      return null;
    }
    return slot ? { kind, ref, slot } : { kind, ref };
  }
  if (kind === 'asset' && ASSET_ID.test(ref)) return { kind, ref };
  if (kind === 'logo' && (ref === 'site' || ASSET_ID.test(ref))) return { kind, ref };
  ctx.push(`${path}.ref`, 'unsafe_asset_ref');
  return null;
}

function imageLayer(ctx: Ctx, path: string, src: Obj, b: LayerBase): ImageLayer | null {
  ctx.keys(path, src, [...BASE_KEYS, 'asset', 'natural', 'crop', 'scale', 'fit', 'knockout', 'adjust']);
  const asset = assetRef(ctx, `${path}.asset`, src.asset);
  if (!asset) return null;
  const n = isObj(src.natural) ? src.natural : {};
  const nw = n.width;
  const nh = n.height;
  if (typeof nw !== 'number' || typeof nh !== 'number' || !(nw >= 1 && nw <= 20000 && nh >= 1 && nh <= 20000)) {
    ctx.push(`${path}.natural`, 'invalid_image');
    return null;
  }
  let crop: ImageLayer['crop'] = null;
  if (isObj(src.crop)) {
    const c = src.crop;
    const ok = [c.x, c.y, c.width, c.height].every((v) => typeof v === 'number' && Number.isFinite(v));
    const cx = c.x as number, cy = c.y as number, cw = c.width as number, ch = c.height as number;
    if (!ok || cw < 1 || ch < 1 || cx < 0 || cy < 0 || cx + cw > nw + 0.5 || cy + ch > nh + 0.5) {
      ctx.push(`${path}.crop`, 'invalid_image');
      return null;
    }
    crop = { x: cx, y: cy, width: cw, height: ch };
  } else if (src.crop !== undefined && src.crop !== null) {
    ctx.push(`${path}.crop`, 'invalid_value');
  }
  let fit = ctx.oneOf(`${path}.fit`, src.fit, ['whole', 'detail'] as const, crop ? 'detail' : 'whole');
  // A crop IS a detail shot, and a detail shot needs a crop: the two can never disagree in a stored document.
  if ((crop && fit !== 'detail') || (!crop && fit === 'detail')) {
    ctx.push(`${path}.fit`, 'invalid_value');
    fit = crop ? 'detail' : 'whole';
  }
  return {
    ...b,
    type: 'image',
    asset,
    natural: { width: nw, height: nh },
    crop,
    scale: ctx.num(`${path}.scale`, src.scale, 0.01, 40, 1),
    ...knockoutOf(ctx, path, src.knockout, asset),
    ...adjustOf(ctx, path, src.adjust, asset),
    fit,
  };
}

/** Colour adjustments of a product picture, clamped; anything else is dropped (reported). */
function adjustOf(ctx: Ctx, path: string, v: unknown, asset: AssetRef): { adjust?: PictureAdjust | null } {
  if (v === undefined) return {};
  if (v === null) return { adjust: null };
  if (!isObj(v) || asset.kind !== 'product') {
    ctx.push(`${path}.adjust`, 'invalid_value');
    return { adjust: null };
  }
  return {
    adjust: {
      brightness: ctx.num(`${path}.adjust.brightness`, v.brightness, -0.5, 0.5, 0),
      contrast: ctx.num(`${path}.adjust.contrast`, v.contrast, -0.5, 0.5, 0),
      warmth: ctx.num(`${path}.adjust.warmth`, v.warmth, 0, 1, 0),
      glow: ctx.num(`${path}.adjust.glow`, v.glow, 0, 1, 0),
    },
  };
}

/** Only a product picture may have its white backdrop knocked out; anything else is dropped (reported). */
function knockoutOf(ctx: Ctx, path: string, v: unknown, asset: AssetRef): { knockout?: 'white' | null } {
  if (v === undefined) return {};
  if (v === 'white' && asset.kind === 'product') return { knockout: 'white' };
  if (v !== null) ctx.push(`${path}.knockout`, 'invalid_value');
  return { knockout: null };
}

function shapeLayer(ctx: Ctx, path: string, src: Obj, b: LayerBase): ShapeLayer {
  ctx.keys(path, src, [...BASE_KEYS, 'shape', 'width', 'height', 'fill', 'stroke', 'radius', 'blur', 'gradient']);
  const st = isObj(src.stroke) ? src.stroke : null;
  const strokeColor = st ? ctx.color(`${path}.stroke.color`, st.color, null) : null;
  return {
    ...b,
    type: 'shape',
    shape: ctx.oneOf(`${path}.shape`, src.shape, ['rect', 'ellipse', 'line'] as const, 'rect'),
    width: ctx.num(`${path}.width`, src.width, 1, COORD, 100),
    height: ctx.num(`${path}.height`, src.height, 0, COORD, 100),
    fill: ctx.color(`${path}.fill`, src.fill, null),
    stroke: st && strokeColor ? { color: strokeColor, width: ctx.num(`${path}.stroke.width`, st.width, 0.5, 64, 2) } : null,
    radius: ctx.num(`${path}.radius`, src.radius, 0, 2000, 0),
    blur: ctx.num(`${path}.blur`, src.blur, 0, 200, 0),
    ...withGradient(ctx, path, src),
  };
}

function relation(ctx: Ctx, path: string, v: unknown): Relation | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID_PATTERN.test(v.id)) {
    ctx.push(path, 'invalid_id');
    return null;
  }
  const id = v.id;
  const ref = (k: string) => (typeof v[k] === 'string' && ID_PATTERN.test(v[k] as string) ? (v[k] as string) : null);
  const gap = v.kind === 'shadow_of' || v.kind === 'anchor' ? 0 : ctx.num(`${path}.gap`, v.gap, 0, 2000, 24);
  switch (v.kind) {
    case 'below':
    case 'clear_of': {
      const subject = ref('subject');
      const target = ref('target');
      if (!subject || !target || subject === target) {
        ctx.push(path, 'invalid_value');
        return null;
      }
      return { id, kind: v.kind, subject, target, gap };
    }
    case 'shadow_of': {
      const subject = ref('subject');
      const target = ref('target');
      if (!subject || !target || subject === target) {
        ctx.push(path, 'invalid_value');
        return null;
      }
      return { id, kind: 'shadow_of', subject, target };
    }
    case 'anchor': {
      const subject = ref('subject');
      if (!subject) {
        ctx.push(path, 'invalid_value');
        return null;
      }
      const corner = ctx.oneOf<Corner>(`${path}.corner`, v.corner, ['top_start', 'top_end', 'bottom_start', 'bottom_end'], 'top_end');
      return { id, kind: 'anchor', subject, corner, margin: ctx.num(`${path}.margin`, v.margin, 0, 2000, 0) };
    }
    case 'order': {
      const members = Array.isArray(v.members) ? v.members.filter((m): m is string => typeof m === 'string' && ID_PATTERN.test(m)) : [];
      const unique = [...new Set(members)].slice(0, 20);
      if (unique.length < 2) {
        ctx.push(path, 'invalid_value');
        return null;
      }
      return { id, kind: 'order', members: unique, gap };
    }
    default:
      ctx.push(`${path}.kind`, 'invalid_value');
      return null;
  }
}

function annotation(ctx: Ctx, path: string, v: unknown): Annotation | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID_PATTERN.test(v.id)) {
    ctx.push(path, 'invalid_id');
    return null;
  }
  return {
    id: v.id,
    kind: ctx.oneOf(`${path}.kind`, v.kind, ['pin', 'box', 'arrow'] as const, 'pin'),
    x: ctx.num(`${path}.x`, v.x, -COORD, COORD, 0),
    y: ctx.num(`${path}.y`, v.y, -COORD, COORD, 0),
    width: ctx.num(`${path}.width`, v.width, -COORD, COORD, 0),
    height: ctx.num(`${path}.height`, v.height, -COORD, COORD, 0),
    note: ctx.text(`${path}.note`, v.note, 300),
    layer_ids: Array.isArray(v.layer_ids) ? [...new Set(v.layer_ids.filter((x): x is string => typeof x === 'string' && ID_PATTERN.test(x)))].slice(0, 20) : [],
  };
}

function format(ctx: Ctx, v: unknown): DocFormat | null {
  if (!isObj(v)) {
    ctx.push('format', 'invalid_format');
    return null;
  }
  const id = v.id;
  if (id !== 'square' && id !== 'portrait' && id !== 'story' && id !== 'custom') {
    ctx.push('format.id', 'invalid_format');
    return null;
  }
  const f = formatOf(id, v.width as number, v.height as number);
  if (!f) {
    ctx.push('format', 'invalid_format');
    return null;
  }
  if (id !== 'custom' && (v.width !== f.width || v.height !== f.height) && (v.width !== undefined || v.height !== undefined)) ctx.push('format', 'invalid_value');
  return f;
}

/** Every layer id a relation names. */
export function relationRefs(r: Relation): string[] {
  switch (r.kind) {
    case 'order': return r.members;
    case 'anchor': return [r.subject];
    default: return [r.subject, r.target];
  }
}

/** The fallback document returned with a fatal issue — empty, valid, square. */
export function emptyDocument(): CreativeDocument {
  return {
    schema_version: SCHEMA_VERSION,
    format: { id: 'square', width: 1080, height: 1080 },
    locale: 'ar',
    direction: 'rtl',
    objective: 'sell',
    priority: 'product',
    density: 'brief',
    template: null,
    brand_version: null,
    safe_area: { top: 72, right: 72, bottom: 72, left: 72 },
    products: [],
    services: [],
    layers: [],
    relations: [],
    annotations: [],
    caption: '',
    alt_text: '',
    slide: null,
  };
}

export interface NormalizeResult {
  doc: CreativeDocument;
  issues: DocIssue[];
  /** False when any issue is fatal — a write path refuses the document. */
  ok: boolean;
}

export function normalizeDocument(input: unknown): NormalizeResult {
  const ctx = new Ctx();
  if (!isObj(input)) {
    ctx.push('', 'not_an_object');
    return { doc: emptyDocument(), issues: ctx.issues, ok: false };
  }
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    ctx.push('', 'not_an_object');
    return { doc: emptyDocument(), issues: ctx.issues, ok: false };
  }
  if (bytes > MAX_DOCUMENT_BYTES) {
    ctx.push('', 'payload_too_large');
    return { doc: emptyDocument(), issues: ctx.issues, ok: false };
  }
  if (input.schema_version !== SCHEMA_VERSION) {
    ctx.push('schema_version', 'unsupported_schema_version');
    return { doc: emptyDocument(), issues: ctx.issues, ok: false };
  }
  ctx.keys('', input, [
    'schema_version', 'format', 'locale', 'direction', 'objective', 'priority', 'density', 'template', 'brand_version', 'safe_area',
    'products', 'services', 'layers', 'relations', 'annotations', 'caption', 'alt_text', 'slide',
  ]);
  const fmt = format(ctx, input.format) ?? { id: 'square' as const, width: 1080, height: 1080 };
  const locale = ctx.oneOf('locale', input.locale, ['ar', 'en', 'ckb'] as const, 'ar');
  const direction = ctx.oneOf('direction', input.direction, ['rtl', 'ltr'] as const, locale === 'en' ? 'ltr' : 'rtl');

  const sa = isObj(input.safe_area) ? input.safe_area : {};
  const maxMargin = Math.min(fmt.width, fmt.height) / 3;
  const safe_area: SafeArea = {
    top: ctx.num('safe_area.top', sa.top, 0, maxMargin, 72),
    right: ctx.num('safe_area.right', sa.right, 0, maxMargin, 72),
    bottom: ctx.num('safe_area.bottom', sa.bottom, 0, maxMargin, 72),
    left: ctx.num('safe_area.left', sa.left, 0, maxMargin, 72),
  };

  let template: CreativeDocument['template'] = null;
  if (isObj(input.template)) {
    const t = input.template;
    if (typeof t.id === 'string' && ID_PATTERN.test(t.id) && typeof t.variant === 'string' && ID_PATTERN.test(t.variant) && Number.isInteger(t.version) && (t.version as number) >= 1) {
      template = { id: t.id, version: t.version as number, variant: t.variant };
    } else {
      ctx.push('template', 'invalid_value');
    }
  }
  const brand_version = Number.isInteger(input.brand_version) && (input.brand_version as number) >= 1 ? (input.brand_version as number) : null;
  if (input.brand_version !== undefined && input.brand_version !== null && brand_version === null) ctx.push('brand_version', 'invalid_value');

  const products: ProductBinding[] = [];
  for (const [i, p] of (Array.isArray(input.products) ? input.products : []).slice(0, 4).entries()) {
    if (!isObj(p)) { ctx.push(`products[${i}]`, 'invalid_value'); continue; }
    const slot = typeof p.slot === 'string' && ID_PATTERN.test(p.slot) ? p.slot : null;
    const pid = typeof p.product_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.product_id) ? p.product_id : null;
    const snap = typeof p.snapshot_id === 'string' && ASSET_ID.test(p.snapshot_id) ? p.snapshot_id : null;
    const vk = p.variant_key === null || p.variant_key === undefined ? null : typeof p.variant_key === 'string' && /^[A-Za-z0-9_:.,|-]{1,120}$/.test(p.variant_key) ? p.variant_key : undefined;
    if (!slot || !pid || !snap || vk === undefined || products.some((x) => x.slot === slot)) { ctx.push(`products[${i}]`, 'invalid_value'); continue; }
    products.push({ slot, product_id: pid, variant_key: vk, snapshot_id: snap });
  }
  const services: ServiceBinding[] = [];
  for (const [i, s] of (Array.isArray(input.services) ? input.services : []).slice(0, 6).entries()) {
    if (!isObj(s) || typeof s.claim_id !== 'string' || !ASSET_ID.test(s.claim_id) || !Number.isInteger(s.claim_version)) { ctx.push(`services[${i}]`, 'invalid_value'); continue; }
    if (!services.some((x) => x.claim_id === s.claim_id)) services.push({ claim_id: s.claim_id, claim_version: s.claim_version as number });
  }

  // Layers
  const rawLayers = Array.isArray(input.layers) ? input.layers : [];
  if (rawLayers.length > MAX_LAYERS) ctx.push('layers', 'too_many');
  const layers: Layer[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of rawLayers.slice(0, MAX_LAYERS).entries()) {
    const path = `layers[${i}]`;
    if (!isObj(raw)) { ctx.push(path, 'invalid_value'); continue; }
    const b = base(ctx, path, raw);
    if (!b) continue;
    if (seen.has(b.id)) { ctx.push(`${path}.id`, 'duplicate_id'); continue; }
    let layer: Layer | null = null;
    switch (raw.type) {
      case 'text': layer = textLayer(ctx, path, raw, b); break;
      case 'image': layer = imageLayer(ctx, path, raw, b); break;
      case 'shape': layer = shapeLayer(ctx, path, raw, b); break;
      case 'group': ctx.keys(path, raw, BASE_KEYS); layer = { ...b, type: 'group' }; break;
      default: ctx.push(`${path}.type`, 'unknown_layer_type');
    }
    if (!layer) continue;
    seen.add(layer.id);
    layers.push(layer);
  }
  // A product-bound text whose slot has no binding renders from nothing: it becomes free text, so its
  // words are checked like any typed words (a price in it is `unbound_price_text`), never drawn as bound data.
  const slots = new Set(products.map((p) => p.slot));
  for (const [i, l] of layers.entries()) {
    if (l.type === 'text' && l.source.kind === 'product' && !slots.has(l.source.slot)) {
      ctx.push(`layers.${l.id}.source`, 'invalid_value');
      layers[i] = { ...l, source: { kind: 'free' } };
    }
  }
  // Parents must be groups that exist; the tree must be acyclic.
  const groups = new Set(layers.filter((l) => l.type === 'group').map((l) => l.id));
  for (const l of layers) {
    if (l.parent !== null && (!groups.has(l.parent) || l.parent === l.id)) {
      ctx.push(`layers.${l.id}.parent`, 'dangling_parent');
      l.parent = null;
    }
  }
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (const l of layers) {
    const visited = new Set<string>([l.id]);
    let p = l.parent;
    while (p) {
      if (visited.has(p)) { ctx.push(`layers.${l.id}.parent`, 'group_cycle'); l.parent = null; break; }
      visited.add(p);
      p = byId.get(p)?.parent ?? null;
    }
  }

  const relations: Relation[] = [];
  const relIds = new Set<string>();
  const rawRel = Array.isArray(input.relations) ? input.relations : [];
  if (rawRel.length > MAX_RELATIONS) ctx.push('relations', 'too_many');
  for (const [i, raw] of rawRel.slice(0, MAX_RELATIONS).entries()) {
    const r = relation(ctx, `relations[${i}]`, raw);
    if (!r) continue;
    if (relIds.has(r.id)) { ctx.push(`relations[${i}].id`, 'duplicate_id'); continue; }
    const refs = relationRefs(r);
    if (refs.some((id) => !byId.has(id))) { ctx.push(`relations[${i}]`, 'dangling_relation'); continue; }
    relIds.add(r.id);
    relations.push(r);
  }

  const annotations: Annotation[] = [];
  const annIds = new Set<string>();
  for (const [i, raw] of (Array.isArray(input.annotations) ? input.annotations : []).slice(0, MAX_ANNOTATIONS).entries()) {
    const a = annotation(ctx, `annotations[${i}]`, raw);
    if (!a || annIds.has(a.id)) continue;
    a.layer_ids = a.layer_ids.filter((id) => byId.has(id));
    annIds.add(a.id);
    annotations.push(a);
  }

  let slide: CreativeDocument['slide'] = null;
  if (isObj(input.slide)) {
    const s = input.slide;
    if (Number.isInteger(s.index) && Number.isInteger(s.count) && (s.count as number) >= 1 && (s.count as number) <= 20 && (s.index as number) >= 1 && (s.index as number) <= (s.count as number)) {
      slide = { index: s.index as number, count: s.count as number };
    } else ctx.push('slide', 'invalid_value');
  }

  const doc: CreativeDocument = {
    schema_version: SCHEMA_VERSION,
    format: fmt,
    locale,
    direction,
    objective: ctx.oneOf('objective', input.objective, OBJECTIVES, 'sell'),
    priority: ctx.oneOf('priority', input.priority, VISUAL_PRIORITIES, 'product'),
    density: ctx.oneOf('density', input.density, ['brief', 'detailed'] as const, 'brief'),
    template,
    brand_version,
    safe_area,
    products,
    services,
    layers,
    relations,
    annotations,
    caption: ctx.text('caption', input.caption, MAX_CAPTION_CHARS, true),
    alt_text: ctx.text('alt_text', input.alt_text, MAX_ALT_CHARS),
    slide,
  };
  const ok = !ctx.issues.some((i) => i.fatal);
  return { doc: ok ? doc : emptyDocument(), issues: ctx.issues, ok };
}

/** The custom-size bounds, re-exported for the size picker. */
export { CUSTOM_FORMAT_LIMITS };
