/**
 * THE STUDIO'S SCENE — the viewer core's scene (./scene.ts) with what a
 * blueprint needs on top (docs/LEVO_PROJECT_PROGRAMME.md §B.2 items 3–5):
 * regions recoloured by one uniform write, finishes as parameters, decals from
 * one atlas (./decals.ts), accessory parts shown only while their slot is
 * filled, simplified slot markers where the merchant modelled none, our own
 * picking (./pick.ts), render on demand, reduced motion, and the builder's
 * look-card capture (a neutral render and a flat region-id pass).
 *
 * Its own module so the model viewer page never loads it: the pair budget
 * «ModelViewer + viewer-core ≤ 7.7 KB» holds, and this rides in its own lazy
 * chunk with the studio and the builder that mount it.
 *
 * Units: millimetres in the centred LVM1 frame (Z up) for every position the
 * caller hands in — area frames, marker anchors — the same numbers the
 * blueprint stores; colours are 0–1 floats.
 */
import { Geometry, Mesh, Program, Transform } from 'ogl';
import type { OGLRenderingContext } from 'ogl';
import type { DecalAtlas } from './decals';
import type { LoadedMesh } from './mesh';
import { partOfTriangle, pickTriangle, rayFromScreen, type Vec3 } from './pick';
import { frameDistance, mountScene, type Scene } from './scene';
import { MARKER_FRAG, MARKER_VERT, STUDIO_FRAG, STUDIO_VERT } from './studioShaders';

export type { Vec3 };
export type Rgb = readonly [number, number, number];

/** The vertex shader's colour array: at most this many regions a blueprint. */
export const MAX_REGIONS = 16;
/** One atlas, four areas — the WebGL1 varying budget. */
export const MAX_AREAS = 4;

/** Parameters, not names: the engine's finish keys map onto these. */
export interface Finish {
  /** A grazing glow, the silk look (0–1). */
  sheen?: number;
  /** Self-lit share, the glow look (0–1). */
  emissive?: number;
  /** 0 mirror-smooth … 1 matte. */
  roughness?: number;
}
export const FINISHES = {
  classic: { sheen: 0, emissive: 0, roughness: 0.6 },
  matte: { sheen: 0, emissive: 0, roughness: 1 },
  shiny: { sheen: 0.1, emissive: 0, roughness: 0.15 },
  silk: { sheen: 0.8, emissive: 0, roughness: 0.3 },
  glow: { sheen: 0, emissive: 0.55, roughness: 0.7 },
} as const satisfies Record<string, Required<Finish>>;

/** An area's frame on the model (BlueprintSpec v1 `areas[].frame`): origin, outward normal, width axis, size. */
export interface AreaFrame {
  o: Vec3 | readonly number[];
  n: Vec3 | readonly number[];
  u: Vec3 | readonly number[];
  w: number;
  h: number;
}
export interface DecalArea {
  /** Its slot in the atlas (0–3). */
  slot: number;
  /** Paints only on this region's triangles. */
  region: number;
  frame: AreaFrame;
  /** How far off the frame's plane the paint still lands, mm (default half the longer side). */
  depth?: number;
}

/** A simplified slot marker: a glow for an LED, a ring for a magnet, a badge for a motor or module. */
export interface Marker {
  kind: 'glow' | 'ring' | 'badge';
  /** The slot's declared anchor and the way it faces, mm. */
  at: Vec3 | readonly number[];
  n: Vec3 | readonly number[];
  /** Diameter, mm. */
  size: number;
  colour?: Rgb;
}
const MARKER_COLOUR: Record<Marker['kind'], Rgb> = {
  glow: [1, 0.86, 0.55],
  ring: [0.66, 0.68, 0.72],
  badge: [0.2, 0.22, 0.26],
};

export interface StudioOptions {
  /** After the first frame (`data-studio="ready"`). */
  onReady(): void;
  /** Part → region (≤ 16 regions), and 16 × rgb for the regions. */
  regions: { partToRegion: ArrayLike<number>; colours: ArrayLike<number> };
  /** No inertia, no easing, no turntable, no colour fades: everything jumps. */
  reducedMotion?: boolean;
  /** Transparent by default, so either theme's ground shows through. */
  alpha?: boolean;
  /** The ground grid; off by default (`setGrid` shows it). */
  grid?: boolean;
  markers?: readonly Marker[];
  onAr?(active: boolean): void;
  onArError?(): void;
}

export interface StudioHit {
  triangle: number;
  /** LVR1 part index (0 for a one-part mesh; -1 outside every range). */
  part: number;
  region: number;
  /** Millimetres, the mesh's own frame. */
  point: Vec3;
  distance: number;
}

export interface Studio {
  readonly scene: Scene;
  redraw(): void;
  resetCamera(): void;
  setGrid(on: boolean): void;
  startAr(): void;
  stopAr(): void;
  dispose(): void;
  /** 16 × rgb. `fade` eases over 160 ms (never under reduced motion): one uniform write a frame. */
  setRegionColours(rgb: ArrayLike<number>, fade?: boolean): void;
  /** A new part → region map (the builder assigning parts). */
  setRegions(partToRegion: ArrayLike<number>): void;
  /** An accessory part shows only while its slot is filled. */
  setPartVisible(part: number, visible: boolean): void;
  setFinish(region: number | 'all', finish: Finish): void;
  /** Wires the atlas to ≤ 4 areas; every later draw into the atlas redraws by itself. null clears. */
  setDecals(atlas: DecalAtlas | null, areas: readonly DecalArea[]): void;
  setMarkers(markers: readonly Marker[]): void;
  /** An idle turntable; ignored under reduced motion. */
  setSpin(on: boolean): void;
  /** CSS pixels from the canvas's top-left corner → what is under them, or null. */
  pick(x: number, y: number): StudioHit | null;
  /**
   * The look card's captures, `size`² RGBA rows top-down: 'neutral' = the grey
   * render (2× supersampled, straight alpha, transparent ground), 'ids' = red
   * holds region + 1 (0 = nothing), exact. The current view direction, framed
   * for a square; the canvas is left as it was.
   */
  capture(opts: { mode: 'neutral' | 'ids'; size?: number }): Uint8Array;
  /** clip = M · [x, y, z, 1] (mm, column-major) for the camera `capture` uses — the look card's `camera`. */
  lookMatrix(): number[];
}

const unit = (v: ArrayLike<number>): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A flat marker in the XY plane, diameter 1, facing +Z; colour and alpha per vertex. */
function markerGeometry(gl: OGLRenderingContext, kind: Marker['kind'], c: Rgb): Geometry {
  const position: number[] = [];
  const color: number[] = [];
  const v = (x: number, y: number, a: number) => {
    position.push(x, y, 0);
    color.push(c[0], c[1], c[2], a);
  };
  const n = kind === 'badge' ? 6 : 24;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const x0 = Math.cos(a0) / 2, y0 = Math.sin(a0) / 2, x1 = Math.cos(a1) / 2, y1 = Math.sin(a1) / 2;
    if (kind === 'ring') {
      v(x0, y0, 1); v(x1, y1, 1); v(x0 * 0.6, y0 * 0.6, 1);
      v(x1, y1, 1); v(x1 * 0.6, y1 * 0.6, 1); v(x0 * 0.6, y0 * 0.6, 1);
    } else {
      // A glow fades out to its rim; a badge is solid.
      const rim = kind === 'glow' ? 0 : 1;
      v(0, 0, 1); v(x0, y0, rim); v(x1, y1, rim);
    }
  }
  return new Geometry(gl, {
    position: { size: 3, data: new Float32Array(position) },
    color: { size: 4, data: new Float32Array(color) },
  });
}

export function mountStudio(canvas: HTMLCanvasElement, { mesh, ranges }: LoadedMesh, o: StudioOptions): Studio {
  const parts = ranges ? ranges.length / 2 : 1;
  // The per-vertex region index: 0–15, or 255 for a hidden part (collapsed in the shader).
  const region = new Uint8Array(mesh.triangles * 3);
  let map: ArrayLike<number> = o.regions.partToRegion;
  const hidden = new Set<number>();
  const paint = () => {
    for (let p = 0; p < parts; p++) {
      const start = ranges ? ranges[p * 2] : 0;
      const count = ranges ? ranges[p * 2 + 1] : mesh.triangles;
      region.fill(hidden.has(p) ? 255 : Math.min(map[p] ?? 0, MAX_REGIONS - 1), start * 3, (start + count) * 3);
    }
  };
  paint();

  const colours = Array.from({ length: MAX_REGIONS * 3 }, (_, i) => o.regions.colours[i] ?? 0.7);
  const target = colours.slice();
  const finish = Array.from({ length: MAX_REGIONS * 3 }, (_, i): number => (i % 3 === 2 ? 0.6 : 0));
  const zeros = (n: number) => new Array<number>(n).fill(0);
  const uniforms = {
    uRegion: { value: colours },
    uFinish: { value: finish },
    uMode: { value: 0 },
    // The page's wireframe switch has nothing to draw here; kept so the scene's setWire is harmless.
    uWire: { value: 0 },
    uAO: { value: zeros(12) },
    uAN: { value: zeros(12) },
    uAU: { value: zeros(12) },
    // (1/w, 1/h, region, depth); region −1 matches nothing: an empty slot.
    uAS: { value: [0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0] },
    uRect: { value: zeros(16) },
    uAtlas: { value: 0 as unknown },
  };
  let decals = false;
  const build = (gl: OGLRenderingContext) => {
    const head = decals ? '#define DECALS\n' : '';
    return new Program(gl, { vertex: head + STUDIO_VERT, fragment: head + STUDIO_FRAG, cullFace: false, uniforms });
  };

  // RENDER ON DEMAND: the scene draws a frame when asked and keeps going only
  // while this answers true — a colour fade, the turntable, a finger on the
  // canvas, or a camera still easing (Orbit converges without ever arriving:
  // a move below 1e-5 of the model's radius is invisible, so frames stop there).
  let from: number[] | null = null;
  let t0 = 0;
  let spin = false;
  let held = false;
  let before = 0;
  let spot = '';
  const tick = (now: number) => {
    let busy = held || spin;
    if (from) {
      const k = Math.min(1, (now - t0) / 160);
      const e = k * (2 - k);
      for (let i = 0; i < colours.length; i++) colours[i] = from[i] + (target[i] - from[i]) * e;
      if (k < 1) busy = true;
      else from = null;
    }
    if (spin) model.rotation.y += Math.min(now - before, 50) * 0.0004;
    before = now;
    const p = camera.position;
    const next = `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
    if (next !== spot) busy = true;
    spot = next;
    return busy;
  };

  const scene = mountScene(canvas, mesh, {
    onReady: o.onReady,
    onAr: o.onAr,
    onArError: o.onArError,
    reducedMotion: o.reducedMotion,
    alpha: o.alpha ?? true,
    program: build,
    attributes: { region: { size: 1, data: region, type: 5121 /* UNSIGNED_BYTE */ } },
    tick,
  });
  const { gl, renderer, camera, root, model, redraw } = scene;
  const raw = gl as WebGLRenderingContext;
  scene.setGrid(!!o.grid);
  // The gestures Orbit turns into camera moves: frames while a finger is down.
  const down = () => {
    held = true;
    redraw();
  };
  const up = () => {
    held = false;
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('wheel', redraw, { passive: true });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  const regionAttr = model.geometry.attributes.region;
  const scratch = new Transform().matrix;

  let markerProgram: Program | null = null;
  let markers: Mesh[] = [];
  const setMarkers = (list: readonly Marker[]) => {
    for (const m of markers) {
      m.setParent(null);
      m.geometry.remove();
    }
    if (!markerProgram && list.length) {
      markerProgram = new Program(gl, { vertex: MARKER_VERT, fragment: MARKER_FRAG, transparent: true, depthWrite: false, cullFace: false });
      markerProgram.setBlendFunc(raw.ONE, raw.ONE_MINUS_SRC_ALPHA);
    }
    markers = list.map((k) => {
      const m = new Mesh(gl, { geometry: markerGeometry(gl, k.kind, k.colour ?? MARKER_COLOUR[k.kind]), program: markerProgram!, frustumCulled: false });
      const n = unit(k.n);
      // Lifted a hair off the surface, turned to face out along the anchor's normal.
      m.position.set(k.at[0] + n[0] * 0.4, k.at[1] + n[1] * 0.4, k.at[2] + n[2] * 0.4);
      if (Math.abs(n[1]) > 0.9) m.up.set(0, 0, 1);
      m.lookAt([m.position.x + n[0], m.position.y + n[1], m.position.z + n[2]]);
      m.scale.set(k.size, k.size, k.size);
      m.setParent(model);
      return m;
    });
    redraw();
  };
  setMarkers(o.markers ?? []);

  /** The current view direction, at the distance that frames the model in a square. */
  const square = <T>(fn: () => T): T => {
    const { x, y, z } = camera.position;
    const aspect = camera.aspect;
    const k = frameDistance(camera.fov, 1) / (Math.hypot(x, y, z) || 1);
    camera.position.set(x * k, y * k, z * k);
    camera.perspective({ aspect: 1 });
    camera.lookAt([0, 0, 0]);
    root.updateMatrixWorld();
    camera.updateMatrixWorld();
    try {
      return fn();
    } finally {
      camera.position.set(x, y, z);
      camera.perspective({ aspect });
      camera.lookAt([0, 0, 0]);
      camera.updateMatrixWorld();
    }
  };

  return {
    scene,
    redraw,
    resetCamera() {
      model.rotation.y = 0;
      scene.resetCamera();
    },
    setGrid: scene.setGrid,
    startAr: scene.startAr,
    stopAr: scene.stopAr,
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('wheel', redraw);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setMarkers([]);
      markerProgram?.remove();
      model.program.remove();
      scene.dispose();
    },
    setRegionColours(rgb, fade) {
      for (let i = 0; i < target.length; i++) target[i] = rgb[i] ?? target[i];
      if (fade && !o.reducedMotion) {
        from = colours.slice();
        t0 = performance.now();
      } else {
        from = null;
        for (let i = 0; i < target.length; i++) colours[i] = target[i];
      }
      redraw();
    },
    setRegions(partToRegion) {
      map = partToRegion;
      paint();
      regionAttr.needsUpdate = true;
      redraw();
    },
    setPartVisible(part, visible) {
      if (visible) hidden.delete(part);
      else hidden.add(part);
      paint();
      regionAttr.needsUpdate = true;
      redraw();
    },
    setFinish(which, f) {
      const v = [f.sheen ?? 0, f.emissive ?? 0, f.roughness ?? 0.6];
      for (let r = 0; r < MAX_REGIONS; r++) if (which === 'all' || which === r) finish.splice(r * 3, 3, ...v);
      redraw();
    },
    setDecals(atlas, areas) {
      if (atlas && areas.length && !decals) {
        // The decal variant is compiled once, the first time there is something to paint.
        decals = true;
        const old = model.program;
        model.program = build(gl);
        old.remove();
      }
      const { uAO, uAN, uAU, uAS, uRect } = uniforms;
      for (let k = 0; k < MAX_AREAS; k++) {
        const a = atlas ? areas[k] : undefined;
        const rect = a && atlas?.rects[a.slot];
        if (!a || !rect) {
          uAS.value[k * 4 + 2] = -1;
          continue;
        }
        const n = unit(a.frame.n);
        // The width axis, made square to the normal (a merchant's frame is drawn by hand).
        const d = a.frame.u[0] * n[0] + a.frame.u[1] * n[1] + a.frame.u[2] * n[2];
        const u = unit([a.frame.u[0] - d * n[0], a.frame.u[1] - d * n[1], a.frame.u[2] - d * n[2]]);
        uAO.value.splice(k * 3, 3, a.frame.o[0], a.frame.o[1], a.frame.o[2]);
        uAN.value.splice(k * 3, 3, ...n);
        uAU.value.splice(k * 3, 3, ...u);
        uAS.value.splice(k * 4, 4, 1 / a.frame.w, 1 / a.frame.h, a.region, a.depth ?? Math.max(a.frame.w, a.frame.h) / 2);
        // The canvas is uploaded flipped (row 0 at the top becomes v = 1).
        const s = atlas!.canvas.width;
        uRect.value.splice(k * 4, 4, rect.x / s, 1 - (rect.y + rect.h) / s, rect.w / s, rect.h / s);
      }
      if (atlas) atlas.onchange = redraw;
      uniforms.uAtlas.value = atlas && areas.length ? atlas.bind(gl) : 0;
      redraw();
    },
    setMarkers,
    setSpin(on) {
      spin = on && !o.reducedMotion;
      redraw();
    },
    pick(x, y) {
      camera.updateMatrixWorld();
      root.updateMatrixWorld();
      scratch.inverse(model.worldMatrix);
      const ray = rayFromScreen(camera, x, y, canvas.clientWidth, canvas.clientHeight, scratch);
      const hit = pickTriangle(ray, mesh.position, { bbox: mesh, test: (t) => region[t * 3] < MAX_REGIONS });
      if (!hit) return null;
      return { ...hit, part: ranges ? partOfTriangle(ranges, hit.triangle) : 0, region: region[hit.triangle * 3] };
    },
    capture({ mode, size = 512 }) {
      const ids = mode === 'ids';
      // The neutral render is drawn at twice the size and box-filtered: no MSAA off screen.
      const n = ids ? size : size * 2;
      const state = renderer.state;
      const tex = raw.createTexture();
      raw.bindTexture(raw.TEXTURE_2D, tex);
      // ogl caches which texture each unit holds; this unit now holds ours.
      state.textureUnits[state.activeTextureUnit] = -1;
      raw.texImage2D(raw.TEXTURE_2D, 0, raw.RGBA, n, n, 0, raw.RGBA, raw.UNSIGNED_BYTE, null);
      const depth = raw.createRenderbuffer();
      raw.bindRenderbuffer(raw.RENDERBUFFER, depth);
      raw.renderbufferStorage(raw.RENDERBUFFER, raw.DEPTH_COMPONENT16, n, n);
      const buffer = raw.createFramebuffer();
      renderer.bindFramebuffer({ buffer });
      raw.framebufferTexture2D(raw.FRAMEBUFFER, raw.COLOR_ATTACHMENT0, raw.TEXTURE_2D, tex, 0);
      raw.framebufferRenderbuffer(raw.FRAMEBUFFER, raw.DEPTH_ATTACHMENT, raw.RENDERBUFFER, depth);

      const px = new Uint8Array(n * n * 4);
      const gridShown = scene.grid.visible;
      scene.grid.visible = false;
      for (const m of markers) m.visible = false;
      uniforms.uMode.value = ids ? 2 : 1;
      raw.clearColor(0, 0, 0, 0);
      square(() => {
        renderer.render({ scene: root, camera, target: { buffer, width: n, height: n, depth: true } as never });
        raw.readPixels(0, 0, n, n, raw.RGBA, raw.UNSIGNED_BYTE, px);
      });
      raw.clearColor(...scene.clear);
      uniforms.uMode.value = 0;
      scene.grid.visible = gridShown;
      for (const m of markers) m.visible = true;
      renderer.bindFramebuffer();
      raw.deleteFramebuffer(buffer);
      raw.deleteRenderbuffer(depth);
      raw.deleteTexture(tex);
      redraw();

      // Rows top-down (readPixels starts at the bottom); k×k boxes, straight alpha.
      const k = n / size;
      const out = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let j = 0; j < k; j++) {
            for (let i = 0; i < k; i++) {
              const q = ((n - 1 - (y * k + j)) * n + x * k + i) * 4;
              r += px[q];
              g += px[q + 1];
              b += px[q + 2];
              a += px[q + 3];
            }
          }
          const w = (y * size + x) * 4;
          if (a) {
            out[w] = Math.round((r * 255) / a);
            out[w + 1] = Math.round((g * 255) / a);
            out[w + 2] = Math.round((b * 255) / a);
            out[w + 3] = Math.round(a / (k * k));
          }
        }
      }
      return out;
    },
    lookMatrix() {
      return square(() => Array.from(scratch.multiply(camera.projectionViewMatrix, model.worldMatrix)));
    },
  };
}
