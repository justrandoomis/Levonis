/**
 * THE RENDERER — a CreativeDocument drawn with Konva 10.9.0
 * (docs/CREATIVE_STUDIO.md §2: the engine that drew connected Arabic and a
 * mixed Arabic/Latin line pixel-identical to the DOM, and held a picture’s
 * ratio under a skewed drag).
 *
 * RECONCILED BY ID. Each layer of the document is one Konva group keyed by
 * the layer’s stable id, with a signature of everything that affects how it
 * looks. A render compares signatures and touches only the groups whose
 * layer changed; a one-layer edit redraws one group, never the scene. Paint
 * order is array order. Group layers have no pixels of their own (their
 * children are layers too); a click on a child selects its outermost group.
 *
 * TEXT IS OURS. The renderer draws the lines `wrapText` produced with the
 * same measurer the layout engine and the quality check use (media.ts), as a
 * Konva.Text with wrapping off and the lines joined by '\n' — the engine never
 * re-wraps and never cuts a word. Direction comes from the words
 * (`resolveDirection`), alignment from the DOCUMENT’s direction, so an English
 * product name in an Arabic ad still sits on the ad’s start edge. There is no
 * letter spacing, ever (it breaks Arabic joining).
 *
 * A PICTURE IS NEVER STRETCHED. It is drawn into its box from the size it
 * really decoded at: a crop recorded in the stored natural size is scaled to
 * the decoded pixels, and a picture whose decoded RATIO is not the recorded
 * one (a file replaced in place, an EXIF-rotated photo) is drawn whole and
 * contained, centred in the box — never squashed to fit. Export draws these
 * same nodes, so it agrees.
 *
 * ONE GESTURE AT A TIME. A second finger never starts a second gesture: it
 * cancels the one in progress (the nodes go back where the document says, the
 * guides go away) and becomes a pinch, which zooms about the fingers' midpoint
 * and follows it, so two fingers also pan.
 *
 * WHAT IS NEVER EXPORTED lives on its own layers: the document frame and
 * safe-area guide, snap guides, the marquee and the transformer (overlay),
 * and the owner’s annotations (notes). Export renders the content layer
 * alone, at exactly the document’s size.
 */
import Konva from 'konva/lib/Core';
import { Text as KText } from 'konva/lib/shapes/Text';
import { Image as KImage } from 'konva/lib/shapes/Image';
import { Rect as KRect } from 'konva/lib/shapes/Rect';
import { Ellipse as KEllipse } from 'konva/lib/shapes/Ellipse';
import { Line as KLine } from 'konva/lib/shapes/Line';
import { Arrow as KArrow } from 'konva/lib/shapes/Arrow';
import { Transformer as KTransformer } from 'konva/lib/shapes/Transformer';
import type { Stage } from 'konva/lib/Stage';
import type { Layer as KLayer } from 'konva/lib/Layer';
import type { Group as KGroup } from 'konva/lib/Group';
import type { Node as KNode, KonvaEventObject } from 'konva/lib/Node';
import {
  FONT_REGISTRY, layerBox, safeBox, type Annotation, type AssetRef, type Box, type CreativeDocument, type Layer, type ViewTransform,
} from '../../../packages/creativeDoc/src/schema';
import type { TextMeasurer } from '../../../packages/creativeDoc/src/text';
import {
  dragOps, imageFit, isInteractive, marqueeHits, selectableId, selectionBox, snapMove, snapTargets, textFrame, topLevel, transformOps, type Guide,
} from './editorModel';

export type Tool = 'select' | 'pin' | 'box' | 'arrow';

export interface StageCallbacks {
  onSelect(ids: string[]): void;
  onCommitOps(ops: unknown[]): void;
  onEditText(id: string): void;
  onAnnotate(a: Omit<Annotation, 'id' | 'note'>): void;
  onViewChange(view: ViewTransform): void;
}

export interface StageDeps {
  measure(): TextMeasurer;
  image(ref: AssetRef): HTMLImageElement | null;
}

interface Entry {
  group: KGroup;
  type: Layer['type'];
  shape: string;
  sig: string;
}

/** The overlay ink: visible on the charcoal ad and on a light one. */
const GUIDE = '#3b82f6';
const SAFE = 'rgba(59,130,246,0.55)';
const NOTE = '#f59e0b';
/** Where a blurred shape is drawn so only its shadow lands in the picture (canvas shadows are the one blur that scales with Konva’s transform). */
const SHADOW_SHIFT = 20000;

export class StageView {
  readonly stage: Stage;
  private content: KLayer;
  private notes: KLayer;
  private overlay: KLayer;
  private frame: KRect;
  private safe: KRect;
  private guides: KGroup;
  private marquee: KRect;
  private transformer: KTransformer;
  private nodes = new Map<string, Entry>();
  private doc: CreativeDocument | null = null;
  private selection: string[] = [];
  private view: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  private tool: Tool = 'select';
  private epoch = 0;
  private gesture:
    | { kind: 'drag'; pointer: number; ids: string[]; start: { x: number; y: number }; box: Box; targets: { xs: number[]; ys: number[] }; base: Map<KNode, { x: number; y: number }>; dx: number; dy: number; moved: boolean }
    | { kind: 'marquee'; pointer: number; start: { x: number; y: number }; additive: boolean; moved: boolean }
    | { kind: 'note'; pointer: number; start: { x: number; y: number }; tool: Exclude<Tool, 'select'> }
    | null = null;
  /** A two-finger gesture: the spread and scale it began with, and the document point under the fingers' midpoint then. */
  private pinch: { dist: number; scale: number; anchor: { x: number; y: number } } | null = null;
  private removeNative: () => void;

  constructor(container: HTMLDivElement, private cb: StageCallbacks, private deps: StageDeps) {
    this.stage = new Konva.Stage({ container, width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight) });
    this.content = new Konva.Layer({ name: 'content' });
    this.notes = new Konva.Layer({ name: 'notes' });
    this.overlay = new Konva.Layer({ name: 'overlay' });
    this.stage.add(this.content, this.notes, this.overlay);
    this.frame = new KRect({ name: 'frame', stroke: 'rgba(127,127,127,0.6)', strokeWidth: 1, strokeScaleEnabled: false, listening: false });
    this.safe = new KRect({ name: 'safe', stroke: SAFE, strokeWidth: 1, dash: [6, 6], strokeScaleEnabled: false, listening: false });
    this.guides = new Konva.Group({ name: 'guides', listening: false });
    this.marquee = new KRect({ name: 'marquee', stroke: GUIDE, strokeWidth: 1, dash: [4, 4], fill: 'rgba(59,130,246,0.08)', strokeScaleEnabled: false, visible: false, listening: false });
    this.transformer = new KTransformer({
      name: 'transformer', flipEnabled: false, rotateEnabled: false, keepRatio: true, shiftBehavior: 'none', borderStroke: GUIDE, anchorStroke: GUIDE,
      anchorFill: '#ffffff', anchorSize: 12, anchorCornerRadius: 3, ignoreStroke: true, rotationSnaps: [0, 90, 180, 270],
      boundBoxFunc: (oldBox, newBox) => (Math.abs(newBox.width) < 8 || Math.abs(newBox.height) < 4 ? oldBox : newBox),
    });
    this.overlay.add(this.frame, this.safe, this.guides, this.marquee, this.transformer);
    this.transformer.on('transformend', () => this.endTransform());
    this.stage.on('pointerdown', (e) => this.onDown(e));
    this.stage.on('pointermove', () => this.onMove());
    this.stage.on('pointerup', () => this.onUp());
    // The browser took the pointer away: nothing the gesture did is committed.
    this.stage.on('pointercancel', () => this.cancelGesture());
    this.stage.on('dblclick dbltap', (e) => {
      const id = this.layerIdAt(e.target);
      if (id && this.doc && isInteractive(this.doc, id)) this.cb.onEditText(id);
    });
    this.stage.on('wheel', (e) => this.onWheel(e as KonvaEventObject<WheelEvent>));
    const touchMove = (ev: TouchEvent) => this.onTouchMove(ev);
    const touchEnd = () => { this.pinch = null; };
    container.addEventListener('touchmove', touchMove, { passive: false });
    container.addEventListener('touchend', touchEnd);
    this.removeNative = () => {
      container.removeEventListener('touchmove', touchMove);
      container.removeEventListener('touchend', touchEnd);
    };
  }

  destroy(): void {
    this.removeNative();
    this.stage.destroy();
    this.nodes.clear();
  }

  setSize(width: number, height: number): void {
    this.stage.size({ width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) });
  }

  setView(view: ViewTransform): void {
    this.view = view;
    this.stage.scale({ x: view.scale, y: view.scale });
    this.stage.position({ x: view.offsetX, y: view.offsetY });
    this.transformer.forceUpdate();
    this.stage.batchDraw();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.stage.container().style.cursor = tool === 'select' ? 'default' : 'crosshair';
  }

  /** Measurements changed (a font arrived): every text is laid out again on the next render. */
  invalidateText(): void {
    this.epoch++;
  }

  /** Forget a layer’s signature so the next render rewrites it from the document. */
  private invalidate(ids: Iterable<string>) {
    for (const id of ids) {
      const e = this.nodes.get(id);
      if (e) e.sig = '';
    }
  }

  render(doc: CreativeDocument, selection: readonly string[]): void {
    this.doc = doc;
    this.selection = selection.filter((id) => doc.layers.some((l) => l.id === id));
    const live = new Set<string>();
    const measure = this.deps.measure();
    for (const l of doc.layers) {
      if (l.type === 'group') continue;
      live.add(l.id);
      const img = l.type === 'image' ? this.deps.image(l.asset) : null;
      const sig = `${this.epoch}|${doc.direction}|${img ? 1 : 0}|${JSON.stringify(l)}`;
      const shape = l.type === 'shape' ? `${l.shape}|${l.blur > 0 && l.rotation === 0 ? 'soft' : 'crisp'}` : '';
      let e = this.nodes.get(l.id);
      if (e && (e.type !== l.type || e.shape !== shape)) {
        e.group.destroy();
        this.nodes.delete(l.id);
        e = undefined;
      }
      if (!e) {
        e = { group: new Konva.Group({ id: l.id, name: 'layer' }), type: l.type, shape, sig: '' };
        this.content.add(e.group);
        this.nodes.set(l.id, e);
      }
      if (e.sig !== sig) {
        this.paint(e.group, l, doc, measure, img);
        e.sig = sig;
      }
    }
    for (const [id, e] of this.nodes) {
      if (!live.has(id)) {
        e.group.destroy();
        this.nodes.delete(id);
      }
    }
    // Paint order is array order; move only what is out of place.
    let z = 0;
    for (const l of doc.layers) {
      if (l.type === 'group') continue;
      const e = this.nodes.get(l.id)!;
      if (e.group.zIndex() !== z) e.group.zIndex(z);
      z++;
    }
    this.frame.setAttrs({ x: 0, y: 0, width: doc.format.width, height: doc.format.height });
    const s = safeBox(doc);
    this.safe.setAttrs({ x: s.x, y: s.y, width: s.width, height: s.height });
    this.renderNotes(doc.annotations);
    this.renderSelection();
    this.content.batchDraw();
    this.overlay.batchDraw();
  }

  private paint(group: KGroup, l: Layer, doc: CreativeDocument, measure: TextMeasurer, img: HTMLImageElement | null) {
    const box = layerBox(l, doc.layers)!;
    group.destroyChildren();
    group.setAttrs({
      x: box.x + box.width / 2, y: box.y + box.height / 2, offsetX: box.width / 2, offsetY: box.height / 2,
      rotation: l.rotation, opacity: l.opacity, visible: l.visible, scaleX: 1, scaleY: 1,
      listening: l.visible && !l.locked && l.role !== 'background',
    });
    // A transparent hit box: the whole layer box takes the pointer, even where a glyph or a soft shape has no ink.
    group.add(new KRect({ name: 'hit', width: box.width, height: box.height, fill: 'rgba(0,0,0,0)' }));
    if (l.type === 'text') {
      const f = textFrame(l, doc.direction, measure);
      group.add(new KText({
        name: 'text', x: f.x - l.x, y: 0, width: f.width, text: f.lines.join('\n'), wrap: 'none', ellipsis: false,
        fontFamily: FONT_REGISTRY[l.font.family].family, fontStyle: String(l.font.weight), fontSize: l.font.size, lineHeight: l.font.lineHeight,
        fill: l.color, align: f.align, direction: f.direction, letterSpacing: 0, listening: false, perfectDrawEnabled: false,
      }));
    } else if (l.type === 'image') {
      if (img) {
        group.add(new KImage({ name: 'image', image: img, listening: false, ...imageFit(l.natural, l.crop, { width: img.naturalWidth, height: img.naturalHeight }, box) }));
      } else {
        // Not decoded (yet, or at all): an honest empty frame, never another picture.
        group.add(new KRect({ name: 'pending', width: box.width, height: box.height, stroke: 'rgba(160,160,160,0.7)', dash: [8, 6], strokeWidth: 2, strokeScaleEnabled: false, listening: false }));
      }
    } else if (l.type === 'shape') {
      const soft = l.blur > 0 && l.rotation === 0;
      const fill = l.fill ?? undefined;
      const common = {
        listening: false, fill, stroke: l.stroke?.color, strokeWidth: l.stroke?.width ?? 0, perfectDrawEnabled: false,
        ...(soft && fill ? { shadowColor: fill, shadowBlur: l.blur, shadowOffsetX: SHADOW_SHIFT, shadowOffsetY: 0, shadowOpacity: 1, shadowForStrokeEnabled: false } : {}),
      };
      const shift = soft && fill ? -SHADOW_SHIFT : 0;
      if (l.shape === 'rect') group.add(new KRect({ ...common, x: shift, width: box.width, height: box.height, cornerRadius: l.radius }));
      else if (l.shape === 'ellipse') group.add(new KEllipse({ ...common, x: box.width / 2 + shift, y: box.height / 2, radiusX: box.width / 2, radiusY: Math.max(0.5, box.height / 2) }));
      else group.add(new KLine({ ...common, fill: undefined, points: [0, 0, box.width, box.height], stroke: l.stroke?.color ?? fill, strokeWidth: l.stroke?.width ?? 2 }));
    }
  }

  private renderNotes(list: readonly Annotation[]) {
    this.notes.destroyChildren();
    list.forEach((a, i) => {
      const label = String(i + 1);
      const g = new Konva.Group({ listening: false });
      if (a.kind === 'pin') {
        g.add(new KEllipse({ x: a.x, y: a.y, radiusX: 18, radiusY: 18, fill: NOTE, stroke: '#111214', strokeWidth: 2, strokeScaleEnabled: false }));
      } else if (a.kind === 'box') {
        g.add(new KRect({ x: Math.min(a.x, a.x + a.width), y: Math.min(a.y, a.y + a.height), width: Math.abs(a.width), height: Math.abs(a.height), stroke: NOTE, strokeWidth: 3, dash: [10, 6], strokeScaleEnabled: false }));
      } else {
        g.add(new KArrow({ points: [a.x, a.y, a.x + a.width, a.y + a.height], stroke: NOTE, fill: NOTE, strokeWidth: 4, pointerLength: 18, pointerWidth: 16, strokeScaleEnabled: false }));
      }
      g.add(new KText({ x: a.x - 18, y: a.y - 10, width: 36, align: 'center', text: label, fontSize: 18, fontStyle: '700', fontFamily: 'IBM Plex Sans Arabic', fill: '#111214' }));
      this.notes.add(g);
    });
    this.notes.batchDraw();
  }

  private renderSelection() {
    const doc = this.doc;
    const ids = this.selection;
    const nodesOf = (id: string): KNode[] => {
      if (!doc) return [];
      const l = doc.layers.find((x) => x.id === id);
      if (!l) return [];
      if (l.type !== 'group') return this.nodes.get(id) ? [this.nodes.get(id)!.group] : [];
      return doc.layers.filter((x) => x.type !== 'group' && this.isInside(doc, x.id, id)).map((x) => this.nodes.get(x.id)?.group).filter((n): n is KGroup => !!n);
    };
    const attached = ids.flatMap(nodesOf);
    const single = doc && ids.length === 1 ? doc.layers.find((l) => l.id === ids[0]) ?? null : null;
    const interactive = !!doc && ids.every((id) => isInteractive(doc, id));
    if (!attached.length || !interactive) {
      this.transformer.nodes([]);
      return;
    }
    this.transformer.nodes(attached);
    if (single && single.type === 'image') {
      // A picture: one ratio, corners only; a product never rotates.
      this.transformer.setAttrs({ resizeEnabled: true, keepRatio: true, enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], rotateEnabled: single.role !== 'product' && single.role !== 'logo' });
    } else if (single && single.type === 'text') {
      this.transformer.setAttrs({ resizeEnabled: true, keepRatio: false, enabledAnchors: ['middle-left', 'middle-right', 'top-center', 'bottom-center'], rotateEnabled: true });
    } else if (single && single.type === 'shape') {
      this.transformer.setAttrs({ resizeEnabled: true, keepRatio: false, enabledAnchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'], rotateEnabled: single.role !== 'product_shadow' });
    } else {
      this.transformer.setAttrs({ resizeEnabled: false, rotateEnabled: false, enabledAnchors: [] });
    }
    this.transformer.forceUpdate();
  }

  private isInside(doc: CreativeDocument, id: string, ancestor: string): boolean {
    let p = doc.layers.find((l) => l.id === id)?.parent ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (p === ancestor) return true;
      seen.add(p);
      p = doc.layers.find((l) => l.id === p)?.parent ?? null;
    }
    return false;
  }

  // ---------------------------------------------------------------- pointer

  private layerIdAt(target: KNode | null): string | null {
    let n: KNode | null = target;
    while (n && n !== this.stage) {
      if (n.name() === 'layer' && n.id()) return selectableId(this.doc!, n.id());
      n = n.getParent() as KNode | null;
    }
    return null;
  }

  private pointerDoc(): { x: number; y: number } | null {
    const p = this.stage.getPointerPosition();
    if (!p) return null;
    return { x: (p.x - this.view.offsetX) / this.view.scale, y: (p.y - this.view.offsetY) / this.view.scale };
  }

  private onDown(e: KonvaEventObject<PointerEvent>) {
    const doc = this.doc;
    if (!doc || this.pinch) return;
    const pointer = e.evt.pointerId ?? 1;
    if (this.gesture) {
      // A second finger is the start of a pinch, never a second gesture; the same pointer again means its
      // release was missed (let go outside the window) — either way the old gesture is undone first.
      const second = this.gesture.pointer !== pointer;
      this.cancelGesture();
      if (second) return;
    }
    // The transformer’s own handles transform; they are not a click on the canvas.
    if ((e.target.getParent() as unknown) === this.transformer || (e.target as unknown) === this.transformer) return;
    const at = this.pointerDoc();
    if (!at) return;
    if (this.tool !== 'select') {
      this.gesture = { kind: 'note', pointer, start: at, tool: this.tool };
      return;
    }
    const id = this.layerIdAt(e.target);
    const additive = !!e.evt.shiftKey;
    if (!id || !isInteractive(doc, id)) {
      this.gesture = { kind: 'marquee', pointer, start: at, additive, moved: false };
      return;
    }
    if (additive) {
      this.cb.onSelect(this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id]);
      return;
    }
    const ids = this.selection.includes(id) ? this.selection.filter((x) => isInteractive(doc, x)) : [id];
    if (!this.selection.includes(id)) this.cb.onSelect([id]);
    const box = selectionBox(doc, ids);
    if (!box) return;
    const base = new Map<KNode, { x: number; y: number }>();
    for (const sid of topLevel(doc, ids)) {
      for (const l of doc.layers) {
        if (l.type === 'group') continue;
        if (l.id === sid || this.isInside(doc, l.id, sid)) {
          const g = this.nodes.get(l.id)?.group;
          if (g) base.set(g, { x: g.x(), y: g.y() });
        }
      }
    }
    this.gesture = { kind: 'drag', pointer, ids, start: at, box, targets: snapTargets(doc, ids), base, dx: 0, dy: 0, moved: false };
  }

  private onMove() {
    const g = this.gesture;
    if (!g) return;
    const at = this.pointerDoc();
    if (!at) return;
    if (g.kind === 'drag') {
      const rawDx = at.x - g.start.x;
      const rawDy = at.y - g.start.y;
      if (!g.moved && Math.hypot(rawDx, rawDy) * this.view.scale < 3) return;
      g.moved = true;
      const snapped = snapMove(g.box, rawDx, rawDy, g.targets, 6 / this.view.scale);
      g.dx = snapped.dx;
      g.dy = snapped.dy;
      for (const [node, p] of g.base) node.position({ x: p.x + g.dx, y: p.y + g.dy });
      this.drawGuides(snapped.guides);
      this.transformer.forceUpdate();
      this.content.batchDraw();
      this.overlay.batchDraw();
    } else if (g.kind === 'marquee') {
      const w = at.x - g.start.x;
      const h = at.y - g.start.y;
      if (!g.moved && Math.hypot(w, h) * this.view.scale < 3) return;
      g.moved = true;
      this.marquee.setAttrs({ visible: true, x: Math.min(g.start.x, at.x), y: Math.min(g.start.y, at.y), width: Math.abs(w), height: Math.abs(h) });
      this.overlay.batchDraw();
    }
  }

  private onUp() {
    const g = this.gesture;
    this.gesture = null;
    const doc = this.doc;
    if (!g || !doc) return;
    if (g.kind === 'drag') {
      this.drawGuides([]);
      if (!g.moved) return;
      const ops = dragOps(doc, g.ids, g.dx, g.dy);
      // Put the nodes back where the document says; the committed document (or a refusal) decides from here.
      this.invalidate([...g.base.keys()].map((n) => n.id()));
      this.render(doc, this.selection);
      if (ops.length) this.cb.onCommitOps(ops);
    } else if (g.kind === 'marquee') {
      this.marquee.visible(false);
      this.overlay.batchDraw();
      if (!g.moved) {
        if (!g.additive) this.cb.onSelect([]);
        return;
      }
      const box = { x: this.marquee.x(), y: this.marquee.y(), width: this.marquee.width(), height: this.marquee.height() };
      const hits = marqueeHits(doc, box);
      this.cb.onSelect(g.additive ? [...new Set([...this.selection, ...hits])] : hits);
    } else if (g.kind === 'note') {
      const at = this.pointerDoc() ?? g.start;
      const under = (p: { x: number; y: number }) => doc.layers.filter((l) => l.type !== 'group' && l.visible && l.role !== 'background').filter((l) => {
        const b = layerBox(l, doc.layers);
        return !!b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
      }).map((l) => selectableId(doc, l.id));
      if (g.tool === 'pin') {
        this.cb.onAnnotate({ kind: 'pin', x: Math.round(g.start.x), y: Math.round(g.start.y), width: 0, height: 0, layer_ids: [...new Set(under(g.start))] });
      } else if (g.tool === 'box') {
        const box = { x: Math.min(g.start.x, at.x), y: Math.min(g.start.y, at.y), width: Math.abs(at.x - g.start.x), height: Math.abs(at.y - g.start.y) };
        if (box.width < 4 || box.height < 4) return;
        this.cb.onAnnotate({ kind: 'box', x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), layer_ids: marqueeHitsAll(doc, box) });
      } else {
        if (Math.hypot(at.x - g.start.x, at.y - g.start.y) < 8) return;
        this.cb.onAnnotate({ kind: 'arrow', x: Math.round(g.start.x), y: Math.round(g.start.y), width: Math.round(at.x - g.start.x), height: Math.round(at.y - g.start.y), layer_ids: [...new Set([...under(g.start), ...under(at)])] });
      }
    }
  }

  /** Abandon the gesture in progress: dragged nodes go back to where the document puts them, guides and the marquee go away. */
  private cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.kind === 'drag') {
      for (const [node, p] of g.base) node.position(p);
      this.drawGuides([]);
      this.transformer.forceUpdate();
      this.content.batchDraw();
    } else if (g.kind === 'marquee') {
      this.marquee.visible(false);
    }
    this.overlay.batchDraw();
  }

  private endTransform() {
    const doc = this.doc;
    if (!doc || this.selection.length !== 1) return;
    const layer = doc.layers.find((l) => l.id === this.selection[0]);
    const entry = layer ? this.nodes.get(layer.id) : undefined;
    if (!layer || !entry) return;
    const before = layerBox(layer, doc.layers)!;
    const n = entry.group;
    const width = before.width * n.scaleX();
    const height = before.height * n.scaleY();
    const after = { x: n.x() - width / 2, y: n.y() - height / 2, width, height, rotation: n.rotation() };
    const ops = transformOps(layer, before, after);
    this.invalidate([layer.id]);
    this.render(doc, this.selection);
    if (ops.length) this.cb.onCommitOps(ops);
  }

  private drawGuides(list: readonly Guide[]) {
    this.guides.destroyChildren();
    const doc = this.doc;
    if (doc) {
      for (const g of list) {
        const pts = g.axis === 'x' ? [g.at, -10000, g.at, 10000] : [-10000, g.at, 10000, g.at];
        this.guides.add(new KLine({ points: pts, stroke: GUIDE, strokeWidth: 1, strokeScaleEnabled: false, dash: [4, 4] }));
      }
    }
    this.overlay.batchDraw();
  }

  // ---------------------------------------------------------------- zoom / pan

  private onWheel(e: KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const p = this.stage.getPointerPosition();
    if (!p) return;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const factor = Math.exp(-e.evt.deltaY * 0.0025);
      this.zoomAt(p, this.view.scale * factor);
    } else {
      this.cb.onViewChange({ ...this.view, offsetX: this.view.offsetX - e.evt.deltaX, offsetY: this.view.offsetY - e.evt.deltaY });
    }
  }

  zoomAt(p: { x: number; y: number }, nextScale: number): void {
    const scale = Math.min(4, Math.max(0.1, nextScale));
    const docX = (p.x - this.view.offsetX) / this.view.scale;
    const docY = (p.y - this.view.offsetY) / this.view.scale;
    this.cb.onViewChange({ scale, offsetX: p.x - docX * scale, offsetY: p.y - docY * scale });
  }

  private onTouchMove(ev: TouchEvent) {
    if (ev.touches.length !== 2) return;
    ev.preventDefault();
    const rect = this.stage.container().getBoundingClientRect();
    const [a, b] = [ev.touches[0], ev.touches[1]];
    const mid = { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top };
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!this.pinch) {
      // A one-finger drag or marquee that was under way is undone, not left half-applied on screen.
      this.cancelGesture();
      this.pinch = { dist, scale: this.view.scale, anchor: { x: (mid.x - this.view.offsetX) / this.view.scale, y: (mid.y - this.view.offsetY) / this.view.scale } };
      return;
    }
    // Zoom by the change in spread, and keep the document point that was under the midpoint under it now:
    // moving both fingers together pans.
    const scale = Math.min(4, Math.max(0.1, this.pinch.scale * (dist / Math.max(1, this.pinch.dist))));
    this.cb.onViewChange({ scale, offsetX: mid.x - this.pinch.anchor.x * scale, offsetY: mid.y - this.pinch.anchor.y * scale });
  }

  // ---------------------------------------------------------------- export

  /**
   * The design at exactly its document size (or `pixelRatio` times it): the
   * content layer alone, the view reset to 1:1 for the duration so no
   * rounding of the zoomed size can drop a pixel row. Guides, the selection
   * and the annotations are separate layers and are never in it.
   */
  exportCanvas(opts: { pixelRatio?: number; backgroundOnly?: boolean } = {}): HTMLCanvasElement {
    const doc = this.doc;
    if (!doc) throw new Error('no document');
    const hidden: KNode[] = [];
    if (opts.backgroundOnly) {
      for (const l of doc.layers) {
        if (l.role === 'background' || l.type === 'group') continue;
        const g = this.nodes.get(l.id)?.group;
        if (g && g.visible()) {
          g.visible(false);
          hidden.push(g);
        }
      }
    }
    const scale = this.stage.scale();
    const pos = this.stage.position();
    this.notes.visible(false);
    this.overlay.visible(false);
    this.stage.scale({ x: 1, y: 1 });
    this.stage.position({ x: 0, y: 0 });
    try {
      return this.stage.toCanvas({ x: 0, y: 0, width: doc.format.width, height: doc.format.height, pixelRatio: opts.pixelRatio ?? 1 });
    } finally {
      this.stage.scale(scale);
      this.stage.position(pos);
      this.notes.visible(true);
      this.overlay.visible(true);
      for (const g of hidden) g.visible(true);
      this.stage.batchDraw();
    }
  }

  /** Where a layer’s box is on screen (for the text overlay), in container px. */
  screenBox(id: string): Box | null {
    const doc = this.doc;
    const l = doc?.layers.find((x) => x.id === id);
    const b = l && doc ? layerBox(l, doc.layers) : null;
    if (!b) return null;
    return { x: b.x * this.view.scale + this.view.offsetX, y: b.y * this.view.scale + this.view.offsetY, width: b.width * this.view.scale, height: b.height * this.view.scale };
  }

  /** Hide one layer while its words are being typed in the overlay. */
  setEditing(id: string | null): void {
    for (const [lid, e] of this.nodes) {
      const text = e.group.findOne('.text');
      if (text) text.visible(lid !== id);
    }
    this.content.batchDraw();
  }
}

/** Every layer a box touches, interactive or not (a note may point at a locked layer). */
function marqueeHitsAll(doc: CreativeDocument, box: Box): string[] {
  const out = new Set<string>();
  for (const l of doc.layers) {
    if (l.type === 'group' || !l.visible || l.role === 'background') continue;
    const b = layerBox(l, doc.layers);
    if (b && b.x < box.x + box.width && box.x < b.x + b.width && b.y < box.y + box.height && box.y < b.y + b.height) out.add(selectableId(doc, l.id));
  }
  return [...out];
}
