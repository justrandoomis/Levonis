/**
 * THE EDITOR’S PURE HALF — history, selection, snapping, the mapping from a
 * pointer gesture to the bounded operations of packages/creativeDoc/src/ops.ts,
 * and where a text layer’s drawn lines sit. No DOM, no Konva, no React, so
 * every rule here is tested in node (tests/creativeStudioUiModel.test.ts).
 *
 * A gesture never writes a coordinate into the document directly: a drag
 * becomes `nudge_layer` operations, a corner drag on a picture becomes
 * `scale_asset_uniform` + `move_layer`, a side drag on a text becomes
 * `resize_box` + `move_layer`, and all of them go through `applyOps` with
 * `actor: 'human'` — the same rules a Claude patch meets, minus the ones only
 * Claude is held to.
 */
import { applyOps, type ApplyResult, type OpsContext } from '../../../packages/creativeDoc/src/ops';
import {
  FONT_REGISTRY, layerBox, safeBox, unionBox, withDescendants, type Box, type CreativeDocument, type Layer, type TextLayer,
} from '../../../packages/creativeDoc/src/schema';
import { canonicalJson } from '../../../packages/creativeDoc/src/snapshot';
import { TEMPLATES, variantsFor, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';
import type { PriceStatus } from '../../../packages/creativeDoc/src/snapshot';
import { physicalAlign, resolveDirection, wrapText, type TextMeasurer } from '../../../packages/creativeDoc/src/text';

// ---------------------------------------------------------------------------
// History — undo/redo of whole documents (documents are immutable values, so
// a snapshot is a reference, not a copy).
// ---------------------------------------------------------------------------

export const HISTORY_DEPTH = 60;

export interface History {
  past: CreativeDocument[];
  present: CreativeDocument;
  future: CreativeDocument[];
}

export function historyOf(doc: CreativeDocument): History {
  return { past: [], present: doc, future: [] };
}

/** A new present; the redo branch is dropped and the oldest step falls off past the depth. */
export function commit(h: History, doc: CreativeDocument): History {
  if (doc === h.present) return h;
  const past = [...h.past, h.present];
  return { past: past.length > HISTORY_DEPTH ? past.slice(past.length - HISTORY_DEPTH) : past, present: doc, future: [] };
}

export function undo(h: History): History {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

/** Replace the present without an undo step (the server’s own copy after a reload). */
export function reset(doc: CreativeDocument): History {
  return historyOf(doc);
}

/**
 * Take back the step that made `doc` the present, leaving no redo for it — an
 * AI answer whose job was cancelled while it was being saved must not stay on
 * screen (or come back with redo) to be saved later as a person's edit.
 * Anything committed since is left alone.
 */
export function dropStep(h: History, doc: CreativeDocument): History {
  if (h.present !== doc || !h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: h.future };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** What a click on a layer selects: its outermost group (a chip and its words move together). */
export function selectableId(doc: CreativeDocument, id: string): string {
  let cur = doc.layers.find((l) => l.id === id);
  const seen = new Set<string>();
  while (cur && cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    const parent = doc.layers.find((l) => l.id === cur!.parent);
    if (!parent) break;
    cur = parent;
  }
  return cur ? cur.id : id;
}

/**
 * Whether a lock holds this layer: its own, an ancestor's, or a descendant's.
 * A group moves, hides and deletes its children with it, so a group with one
 * locked word inside is as locked as the word.
 */
export function lockedAround(doc: CreativeDocument, id: string): boolean {
  const byId = new Map(doc.layers.map((l) => [l.id, l]));
  if (withDescendants(doc.layers, id).some((x) => byId.get(x)?.locked)) return true;
  let p = byId.get(id)?.parent ?? null;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    if (byId.get(p)?.locked) return true;
    seen.add(p);
    p = byId.get(p)?.parent ?? null;
  }
  return false;
}

/** Whether a layer (or the group it belongs to) may be selected and moved by a person: visible, not the background, no lock holding it. */
export function isInteractive(doc: CreativeDocument, id: string): boolean {
  const l = doc.layers.find((x) => x.id === id);
  if (!l || !l.visible || l.role === 'background') return false;
  return !lockedAround(doc, id);
}

/** Ids whose ancestor is also selected are dropped: moving the group moves them already. */
export function topLevel(doc: CreativeDocument, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = doc.layers.find((l) => l.id === id)?.parent ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (set.has(p)) return false;
      seen.add(p);
      p = doc.layers.find((l) => l.id === p)?.parent ?? null;
    }
    return true;
  });
}

/**
 * What a scoped Claude request may touch: the selection's top-level layers
 * and everything inside them. A chip's words live in a child of the group a
 * click selects, so «اختصر النص» on the CTA must be able to name them.
 */
export function chatScope(doc: CreativeDocument, selection: readonly string[]): string[] {
  const present = selection.filter((id) => doc.layers.some((l) => l.id === id));
  return [...new Set(topLevel(doc, present).flatMap((id) => withDescendants(doc.layers, id)))];
}

export function selectionBox(doc: CreativeDocument, ids: readonly string[]): Box | null {
  const boxes = ids.map((id) => doc.layers.find((l) => l.id === id)).filter((l): l is Layer => !!l).map((l) => layerBox(l, doc.layers)).filter((b): b is Box => !!b);
  return boxes.length ? unionBox(boxes) : null;
}

/** The layers a marquee touches (top-level, interactive only). */
export function marqueeHits(doc: CreativeDocument, marquee: Box): string[] {
  const out = new Set<string>();
  for (const l of doc.layers) {
    if (l.type === 'group') continue;
    const b = layerBox(l, doc.layers);
    if (!b) continue;
    const hit = b.x < marquee.x + marquee.width && marquee.x < b.x + b.width && b.y < marquee.y + marquee.height && marquee.y < b.y + b.height;
    if (!hit) continue;
    const id = selectableId(doc, l.id);
    if (isInteractive(doc, id)) out.add(id);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Snapping — safe-area edges, the canvas centre lines and other layers' edges
// ---------------------------------------------------------------------------

export interface Guide {
  axis: 'x' | 'y';
  /** Document coordinate of the line. */
  at: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** The lines a moving box may snap to, excluding the boxes being moved. */
export function snapTargets(doc: CreativeDocument, moving: readonly string[]): { xs: number[]; ys: number[] } {
  const safe = safeBox(doc);
  const W = doc.format.width;
  const H = doc.format.height;
  const xs = [safe.x, safe.x + safe.width, W / 2, 0, W];
  const ys = [safe.y, safe.y + safe.height, H / 2, 0, H];
  const skip = new Set(moving);
  for (const l of doc.layers) {
    if (l.type === 'group' || !l.visible || l.role === 'background' || skip.has(l.id) || skip.has(selectableId(doc, l.id))) continue;
    const b = layerBox(l, doc.layers);
    if (!b) continue;
    xs.push(b.x, b.x + b.width / 2, b.x + b.width);
    ys.push(b.y, b.y + b.height / 2, b.y + b.height);
  }
  return { xs, ys };
}

/**
 * Snap a box moved by (dx, dy): its start, centre and end on each axis are
 * compared with every target, and the nearest within `threshold` (document
 * px) wins. Returns the corrected move and the guide lines to draw.
 */
export function snapMove(box: Box, dx: number, dy: number, targets: { xs: number[]; ys: number[] }, threshold: number): SnapResult {
  const pick = (edges: number[], lines: number[]) => {
    let best: { delta: number; at: number } | null = null;
    for (const e of edges) for (const t of lines) {
      const d = t - e;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
    return best;
  };
  const x = box.x + dx;
  const y = box.y + dy;
  const sx = pick([x, x + box.width / 2, x + box.width], targets.xs);
  const sy = pick([y, y + box.height / 2, y + box.height], targets.ys);
  const guides: Guide[] = [];
  if (sx) guides.push({ axis: 'x', at: sx.at });
  if (sy) guides.push({ axis: 'y', at: sy.at });
  return { dx: dx + (sx?.delta ?? 0), dy: dy + (sy?.delta ?? 0), guides };
}

// ---------------------------------------------------------------------------
// Gestures → operations
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A drag of the selection by (dx, dy) document px. */
export function dragOps(doc: CreativeDocument, ids: readonly string[], dx: number, dy: number): unknown[] {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return [];
  return topLevel(doc, ids).map((id) => ({ op: 'nudge_layer', layer_id: id, dx: round2(dx), dy: round2(dy) }));
}

/** Arrow keys: 1 px, or 10 with Shift. */
export function nudgeOps(doc: CreativeDocument, ids: readonly string[], key: string, shift: boolean): unknown[] {
  const step = shift ? 10 : 1;
  const d = key === 'ArrowLeft' ? [-step, 0] : key === 'ArrowRight' ? [step, 0] : key === 'ArrowUp' ? [0, -step] : key === 'ArrowDown' ? [0, step] : null;
  if (!d) return [];
  return dragOps(doc, ids, d[0], d[1]);
}

/** Controls that handle these keys themselves; the editor's shortcuts never take them from a focused one. */
const CONTROL = 'button, a[href], [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="slider"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="checkbox"], [role="treeitem"]';

/**
 * True when a key belongs to the focused control, not to the editor: Enter
 * and Space activate a button, the arrows move inside a tab strip, a radio
 * group or a slider, and Backspace/Delete on a focused button must not delete
 * the selected layer behind it. The stage itself and the page body keep every
 * shortcut.
 */
export function keyBelongsToControl(key: string, target: { closest?: (selector: string) => unknown } | null, stage: unknown): boolean {
  if (!target || target === stage || typeof target.closest !== 'function') return false;
  if (!(key === 'Enter' || key === ' ' || key === 'Spacebar' || key.startsWith('Arrow') || key === 'Backspace' || key === 'Delete')) return false;
  return !!target.closest(CONTROL);
}

/** The box a transformer ended on, in document px (unrotated), plus its rotation. */
export interface TransformedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/**
 * A transformer gesture on ONE layer → operations. A picture can only scale
 * uniformly (the factor is the mean of both axes — the transformer keeps the
 * ratio, so they agree to rounding), then lands where the gesture left it. A
 * text or a shape gets a new box. A rotation is its own operation, refused
 * for products by applyOps itself.
 */
export function transformOps(layer: Layer, before: Box, after: TransformedBox): unknown[] {
  const ops: unknown[] = [];
  if (layer.type === 'image') {
    const fx = after.width / Math.max(0.0001, before.width);
    const fy = after.height / Math.max(0.0001, before.height);
    const factor = Math.min(20, Math.max(0.05, (fx + fy) / 2));
    if (Math.abs(factor - 1) > 0.0005) {
      ops.push({ op: 'scale_asset_uniform', layer_id: layer.id, factor: Math.round(factor * 10000) / 10000, anchor: 'center' });
      const w = before.width * factor;
      const h = before.height * factor;
      // The transformer moved the box’s centre too (a corner stays put); keep that, with the uniform size.
      const cx = after.x + after.width / 2;
      const cy = after.y + after.height / 2;
      ops.push({ op: 'move_layer', layer_id: layer.id, x: round2(cx - w / 2), y: round2(cy - h / 2) });
    } else if (Math.abs(after.x - before.x) > 0.01 || Math.abs(after.y - before.y) > 0.01) {
      ops.push({ op: 'move_layer', layer_id: layer.id, x: round2(after.x), y: round2(after.y) });
    }
  } else if (layer.type === 'text' || layer.type === 'shape') {
    const w = Math.max(8, round2(after.width));
    const h = Math.max(layer.type === 'shape' ? 1 : 8, round2(after.height));
    if (Math.abs(w - before.width) > 0.01 || Math.abs(h - before.height) > 0.01) ops.push({ op: 'resize_box', layer_id: layer.id, width: w, height: h });
    if (Math.abs(after.x - before.x) > 0.01 || Math.abs(after.y - before.y) > 0.01) ops.push({ op: 'move_layer', layer_id: layer.id, x: round2(after.x), y: round2(after.y) });
  }
  const rot = Math.round(after.rotation * 10) / 10;
  if (Math.abs(rot - layer.rotation) > 0.05 && layer.type !== 'group') ops.push({ op: 'rotate_layer', layer_id: layer.id, rotation: ((rot + 540) % 360) - 180 });
  return ops;
}

/** A decoded picture whose ratio is off the recorded one by more than this is drawn contained, not stretched. */
export const RATIO_TOLERANCE = 0.005;

/**
 * How a decoded picture fills its layer box. The crop (stored in the recorded
 * natural size) is scaled to the decoded pixels; when the decoded ratio is
 * not the recorded one, the whole picture is drawn contained and centred
 * (one scale), because the recorded crop and box no longer describe it.
 */
export function imageFit(
  natural: { width: number; height: number },
  crop: { x: number; y: number; width: number; height: number } | null,
  decoded: { width: number; height: number },
  box: { width: number; height: number },
): { x: number; y: number; width: number; height: number; crop?: { x: number; y: number; width: number; height: number } } {
  if (!(decoded.width > 0 && decoded.height > 0) || !(natural.width > 0 && natural.height > 0)) {
    return { x: 0, y: 0, width: box.width, height: box.height, ...(crop ? { crop: { ...crop } } : {}) };
  }
  const off = Math.abs((decoded.width / decoded.height) / (natural.width / natural.height) - 1) > RATIO_TOLERANCE;
  if (!off) {
    const kx = decoded.width / natural.width;
    const ky = decoded.height / natural.height;
    return { x: 0, y: 0, width: box.width, height: box.height, ...(crop ? { crop: { x: crop.x * kx, y: crop.y * ky, width: crop.width * kx, height: crop.height * ky } } : {}) };
  }
  const s = Math.min(box.width / decoded.width, box.height / decoded.height);
  const width = decoded.width * s;
  const height = decoded.height * s;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * The composition a variant or priority re-layout lands on, or null when the
 * design's template has none for it. `buildFromTemplate` would otherwise fall
 * back to the template's first variant and re-lay the design as something
 * nobody asked for (an AI «headline first» on a template without one).
 */
export function relayoutVariant(
  doc: Pick<CreativeDocument, 'template' | 'objective'>,
  change: { kind: 'variant'; variant: VariantId } | { kind: 'priority'; priority: CreativeDocument['priority'] },
  priceStatus: PriceStatus | null,
): VariantId | null {
  if (!doc.template || !(doc.template.id in TEMPLATES)) return null;
  const tpl = TEMPLATES[doc.template.id as TemplateId];
  if (change.kind === 'variant') return tpl.variants[change.variant] ? change.variant : null;
  return variantsFor(tpl.id, doc.objective, priceStatus).find((v) => tpl.variants[v]?.priority === change.priority)
    ?? (Object.keys(tpl.variants) as VariantId[]).find((v) => tpl.variants[v]?.priority === change.priority)
    ?? null;
}

/** Run operations as a person. One place, so the editor never forgets the actor. */
export function runHumanOps(doc: CreativeDocument, ops: readonly unknown[], ctx: Omit<OpsContext, 'actor'>): ApplyResult {
  return applyOps(doc, ops, { ...ctx, actor: 'human' });
}

// ---------------------------------------------------------------------------
// Where a text layer’s lines are drawn
// ---------------------------------------------------------------------------

export interface TextFrame {
  /** Our own wrapped lines — the renderer joins them with '\n' and never re-wraps. */
  lines: string[];
  /** The widest line, px. */
  widest: number;
  /** The base direction of the words. */
  direction: 'rtl' | 'ltr';
  /** The PHYSICAL alignment, from the DOCUMENT direction (an English name in an Arabic ad aligns to the ad’s start). */
  align: 'left' | 'center' | 'right';
  /** The node’s x and width: the box, widened only when a line overflows it (so the engine never cuts a word). */
  x: number;
  width: number;
}

/**
 * The frame the renderer draws a text layer in. The width handed to the
 * engine is at least the widest line: Konva breaks a fixed-width line that
 * does not fit even with wrapping off, which would cut an Arabic word in two;
 * an overflow stays visible instead and the quality check reports it.
 */
export function textFrame(layer: TextLayer, docDirection: 'rtl' | 'ltr', measure: TextMeasurer): TextFrame {
  const font = { family: FONT_REGISTRY[layer.font.family].family, weight: layer.font.weight, size: layer.font.size };
  const wrapped = wrapText(layer.text, layer.width, font, measure);
  const align = physicalAlign(layer.align, docDirection);
  const width = Math.max(layer.width, Math.ceil(wrapped.width) + 2);
  const extra = width - layer.width;
  const x = align === 'left' ? layer.x : align === 'right' ? layer.x - extra : layer.x - extra / 2;
  return { lines: wrapped.lines, widest: wrapped.width, direction: resolveDirection(layer.direction, layer.text, docDirection), align, x, width };
}

// ---------------------------------------------------------------------------
// Ids and names
// ---------------------------------------------------------------------------

/** A fresh id matching the document’s id pattern, unique in `taken`. */
export function freshId(prefix: string, taken: ReadonlySet<string>): string {
  const base = prefix.replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'l';
  for (let i = 0; i < 1000; i++) {
    const id = `${/^[a-z]/.test(base) ? base : `l${base}`}_${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 1296).toString(36)}`;
    if (!taken.has(id)) return id;
  }
  return `${base}_${taken.size + 1}`;
}

/** A new free text layer, centred in the safe area, in the brand’s body style. */
export function newTextLayer(doc: CreativeDocument, text: string, opts: { family: TextLayer['font']['family']; weight: TextLayer['font']['weight']; size: number; minSize: number; color: string }): TextLayer {
  const safe = safeBox(doc);
  const width = Math.round(safe.width * 0.7);
  const height = Math.round(opts.size * 1.5 * 2);
  return {
    id: freshId('text', new Set(doc.layers.map((l) => l.id))), name: text.slice(0, 40), role: 'body', parent: null,
    x: Math.round(safe.x + (safe.width - width) / 2), y: Math.round(safe.y + (safe.height - height) / 2), rotation: 0, opacity: 1, visible: true, locked: false,
    type: 'text', text, source: { kind: 'free' }, width, height,
    font: { family: opts.family, weight: opts.weight, size: opts.size, lineHeight: 1.5 }, minSize: Math.min(opts.size, opts.minSize), maxLines: 2,
    color: opts.color, align: 'start', direction: 'auto',
  };
}

// ---------------------------------------------------------------------------
// The local recovery draft — content, base version and time ONLY
// ---------------------------------------------------------------------------

export const RECOVERY_PREFIX = 'levonis.creativeStudio.draft.';

export interface RecoveryDraft {
  content: CreativeDocument;
  base_version: number;
  saved_at: string;
}

/** What is written to localStorage: exactly three fields, never a key, a token or anything about the account. */
export function serializeDraft(content: CreativeDocument, baseVersion: number, now: Date): string {
  const draft: RecoveryDraft = { content, base_version: baseVersion, saved_at: now.toISOString() };
  return JSON.stringify(draft);
}

export function parseDraft(raw: string | null): RecoveryDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RecoveryDraft>;
    if (!v || typeof v !== 'object' || !v.content || typeof v.base_version !== 'number' || typeof v.saved_at !== 'string') return null;
    return { content: v.content as CreativeDocument, base_version: v.base_version, saved_at: v.saved_at };
  } catch {
    return null;
  }
}

export type DraftOffer = 'restore' | 'conflict';

/**
 * What a recovery draft found on open is offered as. Never decided by
 * clocks: the device's and the server's need not agree, and a rename moves
 * `updated_at` without a new version.
 *  - nothing: no draft, or it says exactly what the server copy says;
 *  - `restore`: the draft was made on the very version the server still has,
 *    so laying it back on top overwrites nobody;
 *  - `conflict`: the server moved on since (someone else, another device, or
 *    a save whose answer was lost) — the draft can be kept as a NEW design or
 *    deleted, never laid over the newer version.
 */
export function draftOffer(draft: RecoveryDraft | null, server: { version: number; content: unknown }): DraftOffer | null {
  if (!draft) return null;
  if (canonicalJson(draft.content) === canonicalJson(server.content)) return null;
  return draft.base_version === server.version ? 'restore' : 'conflict';
}

// ---------------------------------------------------------------------------
// Export names
// ---------------------------------------------------------------------------

/** `levonis-<title>-v<version>[-draft].<ext>` — ASCII-safe, a draft always says so. */
export function exportFileName(title: string, version: number, ext: string, draft: boolean): string {
  const slug = title.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'design';
  return `levonis-${slug}-v${version}${draft ? '-draft' : ''}.${ext}`;
}
