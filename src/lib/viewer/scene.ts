/**
 * THE VIEWER CORE'S SCENE — the renderer, camera, Orbit, ground grid,
 * normalisation, Z-up turn, frustum and lose-context-on-dispose logic of the
 * model viewer, moved out of src/pages/ModelViewer.tsx `mountViewer` with the
 * SAME behaviour for that page, plus the seams the studio builds on
 * (./studio.ts): its own program and attributes, render on demand, reduced
 * motion, a transparent canvas.
 *
 * Everything expensive happens in `mountScene` and only there: the geometry is
 * uploaded as one static buffer per attribute and never rebuilt, and a frame
 * does nothing but advance the orbit easing and draw. Throws when WebGL is
 * unavailable, which is the caller's cue to fall back (the numbers on the page,
 * the look card in the studio).
 */
import { Camera, Geometry, Mesh, Orbit, Program, Renderer, Transform } from 'ogl';
import type { OGLRenderingContext } from 'ogl';
import type { ParsedMesh } from './lvm';
import { GRID_FRAG, GRID_VERT, MODEL_FRAG, MODEL_VERT } from './shaders';
import { createAr } from './xr';

export interface SceneOptions {
  /** After the first frame is on screen (`data-viewer="ready"`, `data-studio="ready"`). */
  onReady(): void;
  onAr?(active: boolean): void;
  onArError?(): void;
  /** No Orbit easing and no inertia: the camera follows the finger and stops with it. */
  reducedMotion?: boolean;
  /** A transparent canvas, so the page's own ground (either theme) shows through. */
  alpha?: boolean;
  /** The model's program in place of the viewer's grey one (the studio's region shader). */
  program?: (gl: OGLRenderingContext) => Program;
  /** More per-vertex attributes beside position / normal / corner. */
  attributes?: Record<string, { size: number; data: Uint8Array | Float32Array; type?: number }>;
  /**
   * RENDER ON DEMAND. Without it the scene runs the page's loop, a frame per
   * display refresh while the tab is visible. With it, a frame is drawn only
   * when asked (`redraw()`: a resize, a change, a gesture) and the next one
   * only while `tick` — called before every draw — answers true.
   */
  tick?(now: number): boolean;
}

export interface Scene {
  readonly gl: OGLRenderingContext;
  readonly renderer: Renderer;
  readonly camera: Camera;
  /** The scene root; the model and the grid hang from it. */
  readonly root: Transform;
  /** The model: millimetres in, scaled by `fit`, turned Z-up → Y-up. */
  readonly model: Mesh;
  readonly grid: Mesh;
  readonly controls: Orbit;
  /** 1 / the bounding radius in millimetres. */
  readonly fit: number;
  /** The ground colour the canvas is cleared to (r, g, b, a). */
  readonly clear: readonly [number, number, number, number];
  /** Asks for a frame (render on demand); a no-op while a frame is pending or the page's loop runs. */
  redraw(): void;
  /** Back to the three-quarter view — a jump, never an animation. */
  resetCamera(): void;
  setGrid(on: boolean): void;
  setWire(on: boolean): void;
  startAr(): void;
  stopAr(): void;
  /** Stops everything and hands the WebGL context back (WEBGL_lose_context). */
  dispose(): void;
}

/** The distance at which a unit sphere fills a view of this field on its TIGHTEST axis. */
export function frameDistance(fovDeg: number, aspect: number): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (aspect || 1));
  return 1.18 / Math.sin(Math.min(vFov, hFov) / 2);
}

export function mountScene(canvas: HTMLCanvasElement, data: ParsedMesh, o: SceneOptions): Scene {
  const renderer = new Renderer({
    canvas,
    alpha: !!o.alpha,
    premultipliedAlpha: !!o.alpha,
    antialias: true,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  });
  const gl: OGLRenderingContext = renderer.gl;
  // ogl's context is a union of the WebGL 1 and 2 interfaces; the raw alias
  // exists so the handful of direct calls below resolve to one of them.
  const raw = gl as WebGLRenderingContext;
  // The page ground #050506 on the viewer; nothing at all on a transparent canvas.
  const clear: [number, number, number, number] = o.alpha ? [0, 0, 0, 0] : [0.0196, 0.0196, 0.0235, 1];
  raw.clearColor(...clear);

  const host = canvas.parentElement ?? canvas;
  const scene = new Transform();
  const camera = new Camera(gl, { fov: 35, near: 0.03, far: 200 });

  // ---- the model, normalised so the camera maths is size-independent
  const ex = data.max[0] - data.min[0];
  const ey = data.max[1] - data.min[1];
  const ez = data.max[2] - data.min[2];
  // Bounding-sphere radius of the box. Scaling by its inverse means the model
  // always has radius 1, so near/far and the framing distance are the same
  // numbers for a 5 mm bracket and a 400 mm helmet.
  const radius = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  const fit = 1 / radius;

  const geometry = new Geometry(gl, {
    position: { size: 3, data: data.position },
    normal: { size: 3, data: data.normal },
    corner: { size: 1, data: data.corner, type: raw.UNSIGNED_BYTE },
    ...o.attributes,
  });
  const program =
    o.program?.(gl) ??
    new Program(gl, {
      vertex: MODEL_VERT,
      fragment: MODEL_FRAG,
      // See the shader: winding is not trusted, so both faces are drawn.
      cullFace: false,
      uniforms: {
        uBase: { value: [0.70, 0.71, 0.74] },
        uAccent: { value: [0.729, 0.639, 0.412] }, // --color-gold #BAA369
        uWire: { value: 0 },
      },
    });
  // frustumCulled false skips ogl's bounds pass, which would otherwise walk all
  // 2.25M floats on first draw to compute a box we never test against — the
  // model is the only thing on screen and is always in view.
  const model = new Mesh(gl, { geometry, program, frustumCulled: false });
  model.scale.set(fit, fit, fit);
  // Print meshes are Z-up (Z is build height); the viewer is Y-up. One rotation
  // here is what makes the part stand on the grid instead of lying on its face.
  model.rotation.x = -Math.PI / 2;
  model.setParent(scene);

  // ---- the ground grid, sitting exactly under the part
  const floorY = data.min[2] * fit;
  const half = Math.max((Math.max(ex, ey) / 2) * fit * 1.7, 1.25);
  const divisions = 14;
  const step = (half * 2) / divisions;
  const lines: number[] = [];
  for (let i = 0; i <= divisions; i++) {
    const p = -half + i * step;
    lines.push(-half, 0, p, half, 0, p, p, 0, -half, p, 0, half);
  }
  const gridGeometry = new Geometry(gl, { position: { size: 3, data: new Float32Array(lines) } });
  const gridProgram = new Program(gl, {
    vertex: GRID_VERT,
    fragment: GRID_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: [0.45, 0.42, 0.33] }, uHalf: { value: half } },
  });
  const grid = new Mesh(gl, {
    geometry: gridGeometry,
    program: gridProgram,
    mode: raw.LINES,
    frustumCulled: false,
  });
  // A hair below the lowest facet so a flat-bottomed part does not z-fight.
  grid.position.y = floorY - 0.004;
  grid.setParent(scene);

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h);
    camera.perspective({ aspect: w / h });
  };
  resize();

  const place = () => {
    // Framed on the TIGHTEST axis — on a 390 px phone that is the horizontal
    // one, which is why the smaller of the two field angles wins.
    const d = frameDistance(camera.fov, camera.aspect);
    // Three-quarter view, slightly above: the angle that shows height, width
    // and depth at once instead of a flat elevation.
    const az = Math.PI * 0.3;
    const el = Math.PI * 0.17;
    camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    return d;
  };
  const initialDistance = place();

  const controls = new Orbit(camera, {
    element: canvas,
    // Panning would let the part drift off screen with no way back but Reset;
    // orbit + zoom is the whole vocabulary this view needs.
    enablePan: false,
    // Reduced motion: no easing and no inertia — the camera jumps with the finger.
    ease: o.reducedMotion ? 1 : 0.2,
    inertia: o.reducedMotion ? 0 : 0.72,
    rotateSpeed: 0.13,
    zoomSpeed: 1,
    minDistance: 0.55,
    maxDistance: initialDistance * 4,
  });

  let first = true;
  let running = false;
  let raf = 0;
  let gridWanted = true;
  // Set by dispose(). Ending an XR session fires its own 'end' event, which
  // would otherwise restart the frame loop on a scene that is already gone.
  let dead = false;

  const frame = (now: number) => {
    if (!running) return;
    raf = o.tick ? 0 : window.requestAnimationFrame(frame);
    controls.update();
    const more = o.tick?.(now);
    renderer.render({ scene, camera });
    if (first) {
      first = false;
      o.onReady();
    }
    if (more) raf = window.requestAnimationFrame(frame);
  };
  const start = () => {
    if (dead || running || ar.active()) return;
    running = true;
    raf = window.requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    window.cancelAnimationFrame(raf);
  };
  const redraw = () => {
    if (running && !raf) raf = window.requestAnimationFrame(frame);
  };

  const ar = createAr({
    gl,
    renderer,
    camera,
    scene,
    model,
    grid,
    controls,
    fit,
    minZ: data.min[2],
    gridWanted: () => gridWanted,
    resize,
    place,
    start,
    stop,
    onAr: (active) => o.onAr?.(active),
    onArError: () => o.onArError?.(),
  });

  // A hidden tab must not spin the GPU. The orbit easing is frame-based, so it
  // simply resumes from wherever it was left.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // A resize clears the canvas: on demand, that is a frame to draw.
  const observer = new ResizeObserver(() => {
    resize();
    redraw();
  });
  observer.observe(host);
  start();

  return {
    gl,
    renderer,
    camera,
    root: scene,
    model,
    grid,
    controls,
    fit,
    clear,
    redraw,
    resetCamera() {
      const d = place();
      controls.maxDistance = d * 4;
      controls.forcePosition();
      redraw();
    },
    setGrid(on: boolean) {
      gridWanted = on;
      if (!ar.active()) grid.visible = on;
      redraw();
    },
    setWire(on: boolean) {
      program.uniforms.uWire.value = on ? 1 : 0;
      redraw();
    },
    startAr: ar.start,
    stopAr: ar.stop,
    dispose() {
      dead = true;
      stop();
      ar.end();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      controls.remove();
      geometry.remove();
      gridGeometry.remove();
      program.remove();
      gridProgram.remove();
      // Hand the context back rather than waiting for GC: browsers cap live
      // contexts, and a viewer opened repeatedly would otherwise exhaust them.
      const lose = raw.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    },
  };
}
