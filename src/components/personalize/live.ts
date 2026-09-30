/**
 * THE LIVE MODEL — the studio's side of the viewer core (src/lib/viewer, lane
 * L7): the mesh is fetched and inflated, the studio scene mounted, and every
 * configuration change becomes a handful of uniform writes (docs/LEVO_PROJECT_
 * PROGRAMME.md §B.2 items 3–5). The viewer modules are imported only here and
 * only dynamically, so the look card paints before any of them arrive.
 *
 *   regions   part → region index (the blueprint's `regions` order); a part
 *             in no region, or on a piece the configuration leaves off (an
 *             optional piece switched off, a `shown_by` not met), is hidden
 *   colours   one uniform write per change (a 160 ms ease in the render
 *             loop; instant under reduced motion)
 *   finish    the chosen look's (classic, matte, shiny, silk, glow)
 *   decals    ≤ 4 areas, one atlas; each area's artwork (./art.ts) blitted in
 *   markers   SIMPLIFIED SLOT MARKERS where the merchant modelled no part:
 *             a glow for a light, a ring for a magnet, a badge for a motor or
 *             a module — shown only while the slot is filled
 *
 * A frame's `u` is its UP (BlueprintSpec v1); the viewer's decal frame reads
 * `u` as the WIDTH axis, so the studio hands it up × n (./lookcard.ts
 * `frameWidthAxis`) and «up» comes back as n × width.
 */
import type { Area, DesignConfig, Frame, LookKey, PaletteKey, PartKind, PublicBlueprint, PublicSlot, SlotEffect } from '../../../packages/catalog/src/personalize/types';
import { regionShown, slotChoice } from '../../../packages/catalog/src/personalize/price';
import type { DecalAtlas } from '../../lib/viewer/decals';
import type { Marker, Studio } from '../../lib/viewer/studio';
import { frameWidthAxis } from './lookcard';
import { lookOf } from './useStudio';

export type MarkerKind = Marker['kind'];

/** The simplified marker each slot effect draws (a slot `marker` is decided by its part kind). */
export const SLOT_MARKERS: Readonly<Partial<Record<SlotEffect, MarkerKind>>> = { glow: 'glow', ring: 'ring', badge: 'badge' };
const KIND_MARKERS: Readonly<Partial<Record<PartKind, MarkerKind>>> = { led: 'glow', magnet: 'ring', motor: 'badge', module: 'badge' };

/** The simplified marker a slot shows while filled, or null (none, or its own modelled part). */
export function markerFor(slot: Pick<PublicSlot, 'kind' | 'show'>): MarkerKind | null {
  const e = slot.show?.effect;
  if (!e || !slot.show?.anchor) return null;
  return SLOT_MARKERS[e] ?? (e === 'marker' ? KIND_MARKERS[slot.kind] ?? 'badge' : null);
}

/** The viewer's finish preset for a look. */
export const FINISH_OF: Readonly<Record<LookKey, 'classic' | 'matte' | 'shiny' | 'silk' | 'glow'>> = {
  classic: 'classic', matte: 'matte', shiny: 'shiny', silk: 'silk', wood: 'matte', marble: 'shiny', glow: 'glow', flexible: 'matte', translucent: 'silk', metallic: 'shiny',
};

/** An area frame as the viewer's decal reads it. */
export const decalFrame = (f: Frame) => ({ o: f.o, n: f.n, u: frameWidthAxis(f), w: f.w, h: f.h });

/** The areas the model paints (≤ 4, a frame each), in the atlas's slot order. */
export const decalAreas = (pub: PublicBlueprint): Area[] => pub.areas.filter((a) => a.frame).slice(0, 4);

export interface LiveView {
  /** 16 × rgb, 0–1. */
  colours: number[];
  finish: 'classic' | 'matte' | 'shiny' | 'silk' | 'glow';
  /** Per LVR1 part: shown. */
  visible: boolean[];
  markers: Marker[];
  /** Per decal area (`decalAreas` order): its artwork, or null for an empty area. */
  arts: Array<HTMLCanvasElement | null>;
}

export interface LiveScene {
  parts: number;
  apply(view: LiveView): void;
  /** CSS pixels on the canvas → the region index under them, or null. */
  pick(x: number, y: number): number | null;
  reset(): void;
  spin(on: boolean): void;
  dispose(): void;
}

export interface LiveOptions {
  reduced: boolean;
  partToRegion: number[];
  colours: number[];
  onReady(): void;
  onLost(): void;
  signal: AbortSignal;
}

/**
 * Loads the mesh and mounts the studio scene on `canvas`. 'unsupported' when
 * this browser cannot inflate the mesh (the look card stays); null when the
 * answer is not a mesh; throws without WebGL (the look card stays).
 */
export async function mountLive(canvas: HTMLCanvasElement, pub: PublicBlueprint, source: { url: string } | { bytes: ArrayBuffer }, o: LiveOptions): Promise<LiveScene | 'unsupported' | null> {
  const areas = decalAreas(pub);
  const [{ mountStudio, FINISHES }, { loadMesh }, decals] = await Promise.all([
    import('../../lib/viewer/studio'),
    import('../../lib/viewer/mesh'),
    areas.length ? import('../../lib/viewer/decals') : Promise.resolve(null),
  ]);
  const blob = 'bytes' in source ? URL.createObjectURL(new Blob([source.bytes])) : null;
  let loaded;
  try {
    loaded = await loadMesh(blob ?? ('url' in source ? source.url : ''), { signal: o.signal });
  } finally {
    if (blob) URL.revokeObjectURL(blob);
  }
  if (!loaded) return null;
  if ('unsupported' in loaded) return 'unsupported';
  if (o.signal.aborted) return null;

  const lost = (e: Event) => {
    e.preventDefault();
    o.onLost();
  };
  canvas.addEventListener('webglcontextlost', lost);
  let studio: Studio;
  try {
    studio = mountStudio(canvas, loaded, { onReady: o.onReady, reducedMotion: o.reduced, regions: { partToRegion: o.partToRegion, colours: o.colours } });
  } catch (e) {
    canvas.removeEventListener('webglcontextlost', lost);
    throw e;
  }
  const parts = loaded.ranges ? loaded.ranges.length / 2 : 1;
  let atlas: DecalAtlas | null = null;
  if (decals && areas.length) {
    atlas = decals.createAtlas(areas.map((a) => a.frame!.w / a.frame!.h));
    studio.setDecals(
      atlas,
      areas.map((a, slot) => ({ slot, region: Math.max(0, pub.regions.findIndex((r) => r.id === a.region)), frame: decalFrame(a.frame!) }))
    );
  }
  const drawn: Array<HTMLCanvasElement | null> = [];
  let shown: boolean[] = [];
  let markers = '';
  let finish = '';
  let first = true;
  return {
    parts,
    apply(v) {
      studio.setRegionColours(v.colours, !first);
      first = false;
      if (v.finish !== finish) studio.setFinish('all', FINISHES[(finish = v.finish)]);
      for (let p = 0; p < parts; p++) {
        const on = v.visible[p] !== false;
        if (shown[p] !== on) studio.setPartVisible(p, on);
      }
      shown = v.visible.slice(0, parts);
      const m = JSON.stringify(v.markers);
      if (m !== markers) studio.setMarkers(v.markers);
      markers = m;
      if (atlas && decals) {
        v.arts.forEach((art, k) => {
          if (drawn[k] === art) return;
          drawn[k] = art;
          if (art) decals.drawImageArea(atlas!, k, art, { fit: 'contain' });
          else decals.clearArea(atlas!, k);
        });
      }
    },
    pick(x, y) {
      const hit = studio.pick(x, y);
      return hit && hit.region < 16 ? hit.region : null;
    },
    reset: () => studio.resetCamera(),
    spin: (on) => studio.setSpin(on),
    dispose() {
      canvas.removeEventListener('webglcontextlost', lost);
      studio.dispose();
    },
  };
}

/**
 * The live model's view of a configuration: region colours (0–1), the finish
 * of the chosen look, which parts show (a part in no region hides; a
 * region's parts follow `regionShown`; a slot's own marker part shows while
 * the slot is filled), the simplified markers of the filled slots, and each
 * decal area's artwork (none on a piece that is not there).
 */
export function viewOf(pub: PublicBlueprint, made: DesignConfig, parts: number, rgb: (key: PaletteKey) => readonly number[], arts: Record<string, HTMLCanvasElement | null>): LiveView {
  const colours = Array.from({ length: 48 }, () => 0.7);
  pub.regions.slice(0, 16).forEach((r, i) => {
    const c = rgb(made.colors[r.id] ?? r.paint.default);
    colours.splice(i * 3, 3, c[0] / 255, c[1] / 255, c[2] / 255);
  });
  const visible = Array.from({ length: parts }, () => false);
  for (const r of pub.regions) {
    const on = regionShown(pub, made, r.id);
    for (const p of r.parts) if (p < parts) visible[p] = on;
  }
  const markers: Marker[] = [];
  for (const s of pub.slots) {
    const filled = slotChoice(s, made) !== null;
    if (s.show?.part !== undefined && s.show.part < parts) visible[s.show.part] = filled;
    const kind = markerFor(s);
    const a = s.show?.anchor;
    if (kind && a && filled) markers.push({ kind, at: a.o, n: a.n, size: Math.max(a.w, a.h) });
  }
  const look = lookOf(pub, made);
  return {
    colours,
    finish: look ? FINISH_OF[look] : 'classic',
    visible,
    markers,
    arts: decalAreas(pub).map((a) => (regionShown(pub, made, a.region) ? arts[a.id] ?? null : null)),
  };
}
