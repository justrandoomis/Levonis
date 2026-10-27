/**
 * EDIT OPERATIONS — the only way a document changes (spec §16, §28).
 *
 * People (through the editor's handles, panels and keyboard) and Claude
 * (through a validated patch) both change a document by applying a list of
 * these bounded operations. There is no "run this code", no free-form patch,
 * no HTML: an operation names a layer by its stable id and a value the
 * application checks before anything changes.
 *
 * `applyOps` is ALL OR NOTHING: if any operation is refused, nothing is
 * applied and every refusal is returned (spec §14: keep the previous state).
 * After the operations, only the changed layers' DEPENDENTS are re-laid
 * (layout.ts), and any conflict the result has is returned with its options
 * so the editor can show them before the owner commits.
 *
 * What Claude may never do, whatever the patch says: touch a locked layer,
 * write into a bound text (a price, an availability, a product name), write
 * price-like text or a link anywhere, use a colour outside the brand palette,
 * place a picture that is not one of the bound product's own pictures, lock,
 * delete, rotate or crop anything, or approve/publish/configure — those are
 * not operations at all.
 */
import { inPalette, type BrandKit } from './brand';
import {
  detectConflicts, relayoutDependents, scaleImageUniform, shadowGeometry, textFits, type LayoutConflict,
} from './layout';
import { normalizeDocument } from './normalize';
import {
  FONT_REGISTRY, ID_PATTERN, isHexColor, layerBox, withDescendants, MAX_ALT_CHARS, MAX_CAPTION_CHARS, MAX_TEXT_CHARS, VISUAL_PRIORITIES, formatOf,
  type AssetRef, type CreativeDocument, type DocFormat, type FormatId, type ImageLayer, type Layer, type TextAlign, type VisualPriority,
} from './schema';
import { isVariantId, type VariantId } from './templates';
import { cleanText, containsPriceLike, containsUrl, fitText, type TextMeasurer } from './text';

export type Anchor = 'center' | 'top' | 'bottom' | 'start' | 'end';

export type EditOp =
  | { op: 'set_text'; layer_id: string; value: string }
  | { op: 'move_layer'; layer_id: string; x: number; y: number }
  | { op: 'nudge_layer'; layer_id: string; dx: number; dy: number }
  | { op: 'scale_asset_uniform'; layer_id: string; factor: number; anchor: Anchor }
  | { op: 'set_alignment'; layer_id: string; align: TextAlign }
  | { op: 'set_font_size'; layer_id: string; size: number }
  | { op: 'set_color'; layer_id: string; color: string }
  | { op: 'set_spacing'; relation_id: string; gap: number }
  | { op: 'replace_asset'; layer_id: string; ref: string }
  | { op: 'apply_background_preset'; preset_id: string }
  | { op: 'set_visibility'; layer_id: string; visible: boolean }
  | { op: 'reorder_layer'; layer_id: string; to: 'front' | 'back' | 'forward' | 'backward' }
  | { op: 'set_priority'; priority: VisualPriority }
  | { op: 'switch_template_variant'; variant: VariantId }
  | { op: 'create_format_variant'; format: FormatId; width?: number; height?: number }
  | { op: 'set_caption'; value: string }
  | { op: 'set_alt_text'; value: string }
  // People only:
  | { op: 'set_lock'; layer_id: string; locked: boolean }
  | { op: 'rotate_layer'; layer_id: string; rotation: number }
  | { op: 'delete_layer'; layer_id: string }
  | { op: 'add_layer'; layer: unknown; index?: number }
  | { op: 'set_crop'; layer_id: string; crop: { x: number; y: number; width: number; height: number } | null }
  | { op: 'resize_box'; layer_id: string; width: number; height: number }
  | { op: 'rename_layer'; layer_id: string; name: string };

export type OpName = EditOp['op'];

export const AI_OPS: ReadonlySet<OpName> = new Set<OpName>([
  'set_text', 'move_layer', 'nudge_layer', 'scale_asset_uniform', 'set_alignment', 'set_font_size', 'set_color', 'set_spacing',
  'replace_asset', 'apply_background_preset', 'set_visibility', 'reorder_layer', 'set_priority', 'switch_template_variant',
  'create_format_variant', 'set_caption', 'set_alt_text',
]);
export const HUMAN_OPS: ReadonlySet<OpName> = new Set<OpName>([...AI_OPS, 'set_lock', 'rotate_layer', 'delete_layer', 'add_layer', 'set_crop', 'resize_box', 'rename_layer']);
/** Operations that re-lay the whole design from its template: the app performs them with `layout.rebuild`, alone in their patch. */
export const REBUILD_OPS: ReadonlySet<OpName> = new Set<OpName>(['set_priority', 'switch_template_variant', 'create_format_variant']);

export type RefusalCode =
  | 'unknown_op' | 'not_allowed_for_actor' | 'unknown_layer' | 'unknown_relation' | 'locked_layer' | 'wrong_layer_type'
  | 'bound_text' | 'price_like_text' | 'invented_link' | 'invalid_value' | 'below_min_size' | 'color_not_in_palette'
  | 'asset_not_allowed' | 'unknown_background' | 'product_rotation' | 'background_order' | 'duplicate_id' | 'invalid_layer'
  | 'rebuild_not_alone' | 'unknown_variant';

export interface OpRefusal {
  index: number;
  op: string;
  code: RefusalCode;
  layer_id?: string;
}

/** A design-wide change the app performs by rebuilding from the template. */
export type RebuildRequest =
  | { kind: 'variant'; variant: VariantId }
  | { kind: 'priority'; priority: VisualPriority }
  | { kind: 'format'; format: DocFormat };

export interface AllowedAssets {
  /** Per product binding slot: that product/variant's own same-origin pictures, with their natural sizes. */
  products: Readonly<Record<string, ReadonlyArray<{ url: string; width: number; height: number }>>>;
  /** Approved studio assets (backgrounds, extra product shots, icons) with natural sizes. */
  assets: ReadonlyArray<{ id: string; width: number; height: number; kind: string }>;
  /** Approved logos: `site` and any approved logo asset ids. */
  logos: ReadonlyArray<{ ref: string; width: number; height: number }>;
}

export interface OpsContext {
  actor: 'human' | 'ai';
  brand: BrandKit;
  allowed: AllowedAssets;
  /** With a measurer, an edited text is refit inside its box (down to its floor) and overflow is reported. */
  measure?: TextMeasurer;
}

export type ApplyResult =
  | { ok: true; doc: CreativeDocument; changed: string[]; moved: string[]; conflicts: LayoutConflict[]; rebuild: RebuildRequest | null }
  | { ok: false; refusals: OpRefusal[] };

const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const COORD = 20000;

function layerIdOf(op: EditOp): string | undefined {
  return 'layer_id' in op ? op.layer_id : undefined;
}

/** Shape-check one untrusted operation (from a patch or the editor). Returns null when it is not a well-formed operation. */
export function parseOp(raw: unknown): EditOp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = (k: string) => typeof o[k] === 'string' && ID_PATTERN.test(o[k] as string);
  switch (o.op) {
    case 'set_text': return id('layer_id') && typeof o.value === 'string' ? { op: 'set_text', layer_id: o.layer_id as string, value: o.value } : null;
    case 'move_layer': return id('layer_id') && isNum(o.x, -COORD, COORD) && isNum(o.y, -COORD, COORD) ? { op: 'move_layer', layer_id: o.layer_id as string, x: o.x, y: o.y } : null;
    case 'nudge_layer': return id('layer_id') && isNum(o.dx, -4000, 4000) && isNum(o.dy, -4000, 4000) ? { op: 'nudge_layer', layer_id: o.layer_id as string, dx: o.dx, dy: o.dy } : null;
    case 'scale_asset_uniform': return id('layer_id') && isNum(o.factor, 0.05, 20) && ['center', 'top', 'bottom', 'start', 'end'].includes(o.anchor as string)
      ? { op: 'scale_asset_uniform', layer_id: o.layer_id as string, factor: o.factor, anchor: o.anchor as Anchor } : null;
    case 'set_alignment': return id('layer_id') && ['start', 'center', 'end'].includes(o.align as string) ? { op: 'set_alignment', layer_id: o.layer_id as string, align: o.align as TextAlign } : null;
    case 'set_font_size': return id('layer_id') && isNum(o.size, 6, 400) ? { op: 'set_font_size', layer_id: o.layer_id as string, size: o.size } : null;
    case 'set_color': return id('layer_id') && isHexColor(o.color) ? { op: 'set_color', layer_id: o.layer_id as string, color: (o.color as string).toLowerCase() } : null;
    case 'set_spacing': return id('relation_id') && isNum(o.gap, 0, 2000) ? { op: 'set_spacing', relation_id: o.relation_id as string, gap: o.gap } : null;
    case 'replace_asset': return id('layer_id') && typeof o.ref === 'string' && o.ref.length <= 420 ? { op: 'replace_asset', layer_id: o.layer_id as string, ref: o.ref } : null;
    case 'apply_background_preset': return id('preset_id') ? { op: 'apply_background_preset', preset_id: o.preset_id as string } : null;
    case 'set_visibility': return id('layer_id') && typeof o.visible === 'boolean' ? { op: 'set_visibility', layer_id: o.layer_id as string, visible: o.visible } : null;
    case 'reorder_layer': return id('layer_id') && ['front', 'back', 'forward', 'backward'].includes(o.to as string) ? { op: 'reorder_layer', layer_id: o.layer_id as string, to: o.to as 'front' } : null;
    case 'set_priority': return (VISUAL_PRIORITIES as readonly string[]).includes(o.priority as string) ? { op: 'set_priority', priority: o.priority as VisualPriority } : null;
    case 'switch_template_variant': return isVariantId(o.variant) ? { op: 'switch_template_variant', variant: o.variant } : null;
    case 'create_format_variant': return ['square', 'portrait', 'story', 'custom'].includes(o.format as string)
      ? { op: 'create_format_variant', format: o.format as FormatId, ...(typeof o.width === 'number' ? { width: o.width } : {}), ...(typeof o.height === 'number' ? { height: o.height } : {}) } : null;
    case 'set_caption': return typeof o.value === 'string' ? { op: 'set_caption', value: o.value } : null;
    case 'set_alt_text': return typeof o.value === 'string' ? { op: 'set_alt_text', value: o.value } : null;
    case 'set_lock': return id('layer_id') && typeof o.locked === 'boolean' ? { op: 'set_lock', layer_id: o.layer_id as string, locked: o.locked } : null;
    case 'rotate_layer': return id('layer_id') && isNum(o.rotation, -360, 360) ? { op: 'rotate_layer', layer_id: o.layer_id as string, rotation: o.rotation } : null;
    case 'delete_layer': return id('layer_id') ? { op: 'delete_layer', layer_id: o.layer_id as string } : null;
    case 'add_layer': return o.layer && typeof o.layer === 'object' ? { op: 'add_layer', layer: o.layer, ...(Number.isInteger(o.index) ? { index: o.index as number } : {}) } : null;
    case 'set_crop': {
      if (!id('layer_id')) return null;
      if (o.crop === null) return { op: 'set_crop', layer_id: o.layer_id as string, crop: null };
      const c = o.crop as Record<string, unknown> | undefined;
      if (!c || ![c.x, c.y, c.width, c.height].every((v) => isNum(v, 0, 20000))) return null;
      return { op: 'set_crop', layer_id: o.layer_id as string, crop: { x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number } };
    }
    case 'resize_box': return id('layer_id') && isNum(o.width, 1, COORD) && isNum(o.height, 1, COORD) ? { op: 'resize_box', layer_id: o.layer_id as string, width: o.width, height: o.height } : null;
    case 'rename_layer': return id('layer_id') && typeof o.name === 'string' ? { op: 'rename_layer', layer_id: o.layer_id as string, name: o.name } : null;
    default: return null;
  }
}

function refitText(doc: CreativeDocument, id: string, measure: TextMeasurer | undefined): CreativeDocument {
  if (!measure) return doc;
  const l = doc.layers.find((x) => x.id === id);
  if (!l || l.type !== 'text') return doc;
  const r = fitText(l.text, { family: FONT_REGISTRY[l.font.family].family, weight: l.font.weight, lineHeight: l.font.lineHeight }, { width: l.width, maxHeight: l.height, maxLines: l.maxLines }, { max: l.font.size, min: l.minSize }, measure);
  return r.fits && r.size !== l.font.size ? { ...doc, layers: doc.layers.map((x) => (x.id === id ? { ...l, font: { ...l.font, size: r.size } } : x)) } : doc;
}

/**
 * Apply operations, all or nothing. `ctx.actor` decides which operations are
 * allowed and how strict the text rules are.
 */
export function applyOps(input: CreativeDocument, rawOps: readonly unknown[], ctx: OpsContext): ApplyResult {
  const refusals: OpRefusal[] = [];
  const ops: Array<EditOp | null> = rawOps.map(parseOp);
  ops.forEach((op, index) => {
    if (!op) refusals.push({ index, op: String((rawOps[index] as { op?: unknown } | null)?.op ?? 'unknown'), code: 'unknown_op' });
  });
  if (refusals.length) return { ok: false, refusals };
  const list = ops as EditOp[];
  const allowedSet = ctx.actor === 'ai' ? AI_OPS : HUMAN_OPS;
  const rebuildOps = list.filter((o) => REBUILD_OPS.has(o.op));
  if (rebuildOps.length && list.length > 1) {
    return { ok: false, refusals: list.map((o, index) => ({ index, op: o.op, code: 'rebuild_not_alone' as const })).filter((r) => REBUILD_OPS.has(list[r.index].op)) };
  }

  let doc: CreativeDocument = { ...input, layers: input.layers.slice(), relations: input.relations.slice() };
  const changed = new Set<string>();
  let rebuild: RebuildRequest | null = null;
  const get = (id: string) => doc.layers.find((l) => l.id === id);
  const put = (layer: Layer) => {
    doc = { ...doc, layers: doc.layers.map((l) => (l.id === layer.id ? layer : l)) };
    changed.add(layer.id);
  };

  list.forEach((op, index) => {
    const refuse = (code: RefusalCode, layer_id?: string) => refusals.push({ index, op: op.op, code, ...(layer_id ? { layer_id } : {}) });
    if (!allowedSet.has(op.op)) return refuse('not_allowed_for_actor');
    const lid = layerIdOf(op);
    const layer = lid ? get(lid) : undefined;
    if (lid && !layer) return refuse('unknown_layer', lid);
    // A locked layer only accepts being unlocked, and only by a person.
    if (layer && layer.locked && op.op !== 'set_lock') return refuse('locked_layer', lid);
    const aiText = (value: string): RefusalCode | null => {
      if (ctx.actor !== 'ai') return null;
      if (containsPriceLike(value)) return 'price_like_text';
      if (containsUrl(value)) return 'invented_link';
      return null;
    };

    switch (op.op) {
      case 'set_text': {
        if (layer!.type !== 'text') return refuse('wrong_layer_type', lid);
        if (layer!.source.kind !== 'free') return refuse('bound_text', lid);
        const value = cleanText(op.value, MAX_TEXT_CHARS, true).value;
        if (!value) return refuse('invalid_value', lid);
        const bad = aiText(value);
        if (bad) return refuse(bad, lid);
        put({ ...layer!, text: value });
        doc = refitText(doc, layer!.id, ctx.measure);
        return;
      }
      case 'move_layer':
      case 'nudge_layer': {
        if (layer!.role === 'background') return refuse('locked_layer', lid);
        const box = layerBox(layer!, doc.layers);
        if (!box) return refuse('wrong_layer_type', lid);
        const dx = op.op === 'move_layer' ? op.x - box.x : op.dx;
        const dy = op.op === 'move_layer' ? op.y - box.y : op.dy;
        const ids = new Set(withDescendants(doc.layers, layer!.id));
        doc = { ...doc, layers: doc.layers.map((l) => (ids.has(l.id) && l.type !== 'group' ? { ...l, x: l.x + dx, y: l.y + dy } : l)) };
        changed.add(layer!.id);
        return;
      }
      case 'scale_asset_uniform': {
        if (layer!.type !== 'image') return refuse('wrong_layer_type', lid);
        if (layer!.role === 'background') return refuse('locked_layer', lid);
        const next = scaleImageUniform(doc, layer!.id, op.factor, op.anchor, ctx.brand);
        if (!next) return refuse('invalid_value', lid);
        doc = next;
        changed.add(layer!.id);
        return;
      }
      case 'set_alignment':
        if (layer!.type !== 'text') return refuse('wrong_layer_type', lid);
        return put({ ...layer!, align: op.align });
      case 'set_font_size': {
        if (layer!.type !== 'text') return refuse('wrong_layer_type', lid);
        if (op.size < layer!.minSize) return refuse('below_min_size', lid);
        return put({ ...layer!, font: { ...layer!.font, size: op.size } });
      }
      case 'set_color': {
        if (!inPalette(ctx.brand, op.color)) return refuse('color_not_in_palette', lid);
        if (layer!.type === 'text') return put({ ...layer!, color: op.color });
        if (layer!.type === 'shape' && layer!.role !== 'product_shadow') return put({ ...layer!, fill: op.color });
        return refuse('wrong_layer_type', lid);
      }
      case 'set_spacing': {
        const rel = doc.relations.find((r) => r.id === op.relation_id);
        if (!rel || rel.kind === 'anchor' || rel.kind === 'shadow_of') return refuse('unknown_relation');
        const subjects = rel.kind === 'order' ? rel.members.slice(1) : [rel.subject];
        if (subjects.some((s) => get(s)?.locked)) return refuse('locked_layer', subjects.find((s) => get(s)?.locked));
        doc = { ...doc, relations: doc.relations.map((r) => (r.id === rel.id ? { ...rel, gap: op.gap } : r)) };
        // Re-lay from the relation's anchor end so its subject moves to the new gap.
        const from = rel.kind === 'order' ? rel.members[0] : rel.target;
        const res = relayoutDependents(doc, [from], ctx.brand);
        doc = res.doc;
        res.moved.forEach((m) => changed.add(m));
        return;
      }
      case 'replace_asset': {
        if (layer!.type !== 'image') return refuse('wrong_layer_type', lid);
        const img = layer as ImageLayer;
        let natural: { width: number; height: number } | null = null;
        let asset: AssetRef | null = null;
        if (img.asset.kind === 'product') {
          // A product picture can only become ANOTHER picture of the same product binding (spec §16, §21).
          const slot = img.asset.slot ?? 'main';
          const hit = (ctx.allowed.products[slot] ?? []).find((p) => p.url === op.ref);
          if (hit) { natural = { width: hit.width, height: hit.height }; asset = { kind: 'product', ref: hit.url, slot }; }
        } else if (img.asset.kind === 'logo') {
          const hit = ctx.allowed.logos.find((l) => l.ref === op.ref);
          if (hit) { natural = { width: hit.width, height: hit.height }; asset = { kind: 'logo', ref: hit.ref }; }
        } else {
          const hit = ctx.allowed.assets.find((a) => a.id === op.ref);
          if (hit) { natural = { width: hit.width, height: hit.height }; asset = { kind: 'asset', ref: hit.id }; }
        }
        if (!natural || !asset) return refuse('asset_not_allowed', lid);
        // Fit the new picture inside the old box, centred: one scale, never stretched.
        const old = layerBox(img)!;
        const scale = Math.min(old.width / natural.width, old.height / natural.height);
        const w = natural.width * scale;
        const h = natural.height * scale;
        put({ ...img, asset, natural, crop: null, fit: 'whole', scale, x: old.x + (old.width - w) / 2, y: old.y + (old.height - h) / 2 });
        return;
      }
      case 'apply_background_preset': {
        const preset = ctx.brand.backgrounds.find((b) => b.id === op.preset_id);
        if (!preset) return refuse('unknown_background');
        const bgIndex = doc.layers.findIndex((l) => l.role === 'background');
        const base = { id: 'background', name: 'Background', role: 'background' as const, parent: null, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: true };
        let bg: Layer;
        if (preset.kind === 'asset' && preset.asset_id) {
          const a = ctx.allowed.assets.find((x) => x.id === preset.asset_id);
          if (!a) return refuse('asset_not_allowed');
          const f = doc.format;
          const cover = Math.max(f.width / a.width, f.height / a.height);
          const cw = f.width / cover, ch = f.height / cover;
          bg = { ...base, type: 'image', asset: { kind: 'asset', ref: a.id }, natural: { width: a.width, height: a.height }, crop: { x: (a.width - cw) / 2, y: (a.height - ch) / 2, width: cw, height: ch }, scale: cover, fit: 'detail' };
        } else {
          bg = { ...base, type: 'shape', shape: 'rect', width: doc.format.width, height: doc.format.height, fill: preset.color, stroke: null, radius: 0, blur: 0 };
        }
        const layers = doc.layers.slice();
        if (bgIndex >= 0) {
          bg = { ...bg, id: layers[bgIndex].id };
          layers[bgIndex] = bg;
        } else layers.unshift(bg);
        doc = { ...doc, layers };
        changed.add(bg.id);
        return;
      }
      case 'set_visibility':
        if (layer!.type === 'group') {
          const ids = new Set(withDescendants(doc.layers, layer!.id));
          doc = { ...doc, layers: doc.layers.map((l) => (ids.has(l.id) ? { ...l, visible: op.visible } : l)) };
          changed.add(layer!.id);
          return;
        }
        return put({ ...layer!, visible: op.visible });
      case 'reorder_layer': {
        if (layer!.role === 'background') return refuse('background_order', lid);
        const layers = doc.layers.slice();
        const from = layers.findIndex((l) => l.id === layer!.id);
        const bottom = layers.findIndex((l) => l.role === 'background') + 1; // nothing goes under the background
        let to = op.to === 'front' ? layers.length - 1 : op.to === 'back' ? bottom : op.to === 'forward' ? from + 1 : from - 1;
        to = Math.max(bottom, Math.min(layers.length - 1, to));
        const [moved] = layers.splice(from, 1);
        layers.splice(to, 0, moved);
        doc = { ...doc, layers };
        changed.add(layer!.id);
        return;
      }
      case 'set_priority':
        rebuild = { kind: 'priority', priority: op.priority };
        return;
      case 'switch_template_variant':
        if (!doc.template) return refuse('unknown_variant');
        rebuild = { kind: 'variant', variant: op.variant };
        return;
      case 'create_format_variant': {
        const f = formatOf(op.format, op.width, op.height);
        if (!f) return refuse('invalid_value');
        rebuild = { kind: 'format', format: f };
        return;
      }
      case 'set_caption':
      case 'set_alt_text': {
        const max = op.op === 'set_caption' ? MAX_CAPTION_CHARS : MAX_ALT_CHARS;
        const value = cleanText(op.value, max, op.op === 'set_caption').value;
        const bad = aiText(value);
        if (bad) return refuse(bad);
        doc = op.op === 'set_caption' ? { ...doc, caption: value } : { ...doc, alt_text: value };
        return;
      }
      case 'set_lock':
        return put({ ...layer!, locked: op.locked });
      case 'rotate_layer':
        if (layer!.role === 'product' || layer!.role === 'background') return refuse('product_rotation', lid);
        if (layer!.type === 'group') return refuse('wrong_layer_type', lid);
        return put({ ...layer!, rotation: op.rotation });
      case 'delete_layer': {
        const ids = new Set(withDescendants(doc.layers, layer!.id));
        doc = {
          ...doc,
          layers: doc.layers.filter((l) => !ids.has(l.id)),
          relations: doc.relations.filter((r) => (r.kind === 'order' ? !r.members.some((m) => ids.has(m)) : r.kind === 'anchor' ? !ids.has(r.subject) : !ids.has(r.subject) && !ids.has(r.target))),
          annotations: doc.annotations.map((a) => ({ ...a, layer_ids: a.layer_ids.filter((x) => !ids.has(x)) })),
        };
        changed.add(layer!.id);
        return;
      }
      case 'add_layer': {
        const probe = normalizeDocument({ ...doc, layers: [...doc.layers, op.layer] });
        const added = probe.ok ? probe.doc.layers[probe.doc.layers.length - 1] : null;
        if (!added || probe.doc.layers.length !== doc.layers.length + 1) {
          const dup = typeof (op.layer as { id?: unknown }).id === 'string' && doc.layers.some((l) => l.id === (op.layer as { id: string }).id);
          return refuse(dup ? 'duplicate_id' : 'invalid_layer');
        }
        if (added.type === 'text' && added.source.kind === 'product' && added.source.field === 'price' && !doc.products.some((p) => p.slot === (added.source as { slot: string }).slot)) return refuse('invalid_layer');
        const layers = doc.layers.slice();
        const at = op.index === undefined ? layers.length : Math.max(layers.findIndex((l) => l.role === 'background') + 1, Math.min(layers.length, op.index));
        layers.splice(at, 0, added);
        doc = { ...doc, layers };
        changed.add(added.id);
        return;
      }
      case 'set_crop': {
        if (layer!.type !== 'image') return refuse('wrong_layer_type', lid);
        const img = layer as ImageLayer;
        if (op.crop) {
          const c = op.crop;
          if (c.width < 1 || c.height < 1 || c.x + c.width > img.natural.width + 0.5 || c.y + c.height > img.natural.height + 0.5) return refuse('invalid_value', lid);
        }
        // The box keeps its height; the new crop's own ratio decides the width — the picture is never stretched.
        const old = layerBox(img)!;
        const src = op.crop ?? img.natural;
        const scale = old.height / src.height;
        return put({ ...img, crop: op.crop, fit: op.crop ? 'detail' : 'whole', scale });
      }
      case 'resize_box': {
        if (layer!.type === 'image') return refuse('wrong_layer_type', lid); // pictures only scale uniformly
        if (layer!.type === 'group') return refuse('wrong_layer_type', lid);
        if (layer!.type === 'text') return put({ ...layer!, width: op.width, height: op.height });
        return put({ ...layer!, width: op.width, height: op.height });
      }
      case 'rename_layer':
        return put({ ...layer!, name: cleanText(op.name, 60).value || layer!.name });
    }
  });

  if (refusals.length) return { ok: false, refusals };

  // Only the dependents of what changed move (spec §14).
  doc = relayoutDependents(doc, [...changed], ctx.brand).doc;
  // A product picture's own contact shadow follows it even if the relation was removed by hand.
  for (const id of changed) {
    const l = doc.layers.find((x) => x.id === id);
    if (l?.type === 'image' && l.role === 'product') {
      const sh = doc.layers.find((x) => x.type === 'shape' && x.role === 'product_shadow' && doc.relations.some((r) => r.kind === 'shadow_of' && r.subject === x.id && r.target === id));
      if (sh && sh.type === 'shape') {
        const g = shadowGeometry(layerBox(l)!, ctx.brand);
        doc = { ...doc, layers: doc.layers.map((x) => (x.id === sh.id ? { ...sh, ...g } : x)) };
      }
    }
  }
  // The result must still pass the gate — an operation can never produce an invalid document.
  const check = normalizeDocument(doc);
  if (!check.ok) return { ok: false, refusals: [{ index: -1, op: 'result', code: 'invalid_value' }] };
  const conflicts = detectConflicts(check.doc, { measure: ctx.measure });
  // What else moved — compared with the input, so a dependent moved inside an operation is reported too (spec §16).
  const before = new Map(input.layers.map((l) => [l.id, l]));
  const moved = check.doc.layers.filter((l) => !changed.has(l.id) && before.has(l.id) && geometryChanged(before.get(l.id)!, l)).map((l) => l.id);
  return { ok: true, doc: check.doc, changed: [...changed], moved, conflicts, rebuild };
}

function geometryChanged(a: Layer, b: Layer): boolean {
  const ba = layerBox(a), bb = layerBox(b);
  if (!ba || !bb) return false;
  return Math.abs(ba.x - bb.x) > 0.01 || Math.abs(ba.y - bb.y) > 0.01 || Math.abs(ba.width - bb.width) > 0.01 || Math.abs(ba.height - bb.height) > 0.01;
}

/** Text that no longer fits after an edit (for the editor's inline warning). */
export function overflowingText(doc: CreativeDocument, measure: TextMeasurer): string[] {
  return doc.layers.filter((l) => l.type === 'text' && l.visible).filter((l) => !textFits(l as never, measure)).map((l) => l.id);
}
