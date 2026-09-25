/**
 * /model-viewer/:token — the standalone 3D preview of an uploaded print model.
 *
 * NO SITE CHROME, ON PURPOSE. The link is handed to whoever needs to LOOK at
 * the part — a merchant quoting it, a customer checking what they uploaded —
 * so the page is the model and nothing else. It is `fixed inset-0` rather than
 * an ordinary page body precisely so it stays a full viewport whichever layout
 * the router happens to wrap it in.
 *
 * THE BROWSER NEVER PARSES THE CUSTOMER'S FILE. The Worker already measured
 * the upload and cached a derived mesh (worker/lib/modelGeometry.ts →
 * `viewerMesh`); this page fetches THOSE bytes, never the STL/3MF/OBJ. That is
 * why there is a 32-byte header reader below instead of a model loader, and it
 * is what keeps the store bundle free of slicer payload (T1,
 * tests/store-isolation.test.ts). `ogl` is the only 3D library available here —
 * `three` is banned by that same test.
 *
 * TWO 404s, TWO MEANINGS. Metadata is fetched first: a 404 there means the
 * token is wrong, expired or revoked, and the Worker refuses to say which, so
 * this page says one thing and nothing technical. A 404 on the MESH *after*
 * metadata succeeded means the token is fine but the format has no preview —
 * a different, much softer failure, where the measurements panel still stands
 * on its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, Geometry, Mesh, Orbit, Program, Renderer, Transform } from 'ogl';
import type { OGLRenderingContext } from 'ogl';
import {
  Boxes,
  Component,
  Cuboid,
  Grid3x3,
  Link2Off,
  Loader2,
  RotateCcw,
  Rotate3d,
  Ruler,
  Smartphone,
  Triangle,
  TriangleAlert,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';

/**
 * No `name`: the server stopped sending the customer's own file name (audit 03
 * §10 F) — it reached anyone holding the link. The page says what it shows.
 */
interface ViewerMeta {
  format: string;
  dimensions_mm: { x: number; y: number; z: number } | null;
  volume_mm3: number | null;
  triangle_count: number | null;
  shell_count: number | null;
  expires_at: string;
  /** 'preview' = the coarse mesh a merchant quoting on the board is sent (worker/routes/printRequests.ts). */
  grant?: 'full' | 'preview';
}

/** The decoded LVM1 payload, already in the shape the GPU wants. */
interface ParsedMesh {
  triangles: number;
  position: Float32Array;
  normal: Float32Array;
  /** 0 / 1 / 2 per vertex — the corner index, used only for the wireframe. */
  corner: Uint8Array;
  min: [number, number, number];
  max: [number, number, number];
}

/* --------------------------------------------------------------- WebXR types
 *
 * WebXR is absent from TypeScript's DOM lib, so this is the minimum surface the
 * AR path actually touches. Declared rather than reached for through `any` so a
 * typo in it fails the typecheck like any other call. */
interface XrRigidTransform {
  readonly matrix: Float32Array;
  readonly inverse: XrRigidTransform;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}
interface XrView {
  readonly projectionMatrix: Float32Array;
  readonly transform: XrRigidTransform;
}
interface XrViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface XrViewerPose {
  readonly views: readonly XrView[];
}
interface XrFrame {
  /** The reference space is an opaque handle we only ever hand back. */
  getViewerPose(space: unknown): XrViewerPose | null;
}
interface XrWebGLLayer {
  readonly framebuffer: WebGLFramebuffer | null;
  getViewport(view: XrView): XrViewport | undefined;
}
interface XrSession {
  requestReferenceSpace(type: string): Promise<unknown>;
  updateRenderState(state: { baseLayer: XrWebGLLayer }): void;
  requestAnimationFrame(callback: (time: number, frame: XrFrame) => void): number;
  addEventListener(type: 'end', listener: () => void): void;
  end(): Promise<void>;
}
interface XrSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(
    mode: string,
    init?: { requiredFeatures?: string[]; optionalFeatures?: string[] }
  ): Promise<XrSession>;
}
type XrWebGLLayerCtor = new (
  session: XrSession,
  gl: WebGLRenderingContext | WebGL2RenderingContext
) => XrWebGLLayer;

/**
 * BOTH halves or nothing. `navigator.xr` alone is not enough to draw anything —
 * without the XRWebGLLayer constructor there is no framebuffer to render into,
 * and an AR button that cannot render is worse than no button at all.
 */
function xrParts(): { xr: XrSystem; Layer: XrWebGLLayerCtor } | null {
  const xr = (navigator as Navigator & { xr?: XrSystem }).xr;
  const Layer = (window as Window & { XRWebGLLayer?: XrWebGLLayerCtor }).XRWebGLLayer;
  return xr && Layer ? { xr, Layer } : null;
}

const STR = {
  ar: {
    loading: 'جارٍ تحميل المجسم',
    title: 'معاينة المجسم',
    simplified: 'معاينة مبسّطة',
    simplifiedHint: 'شكل مبسّط من المجسم للتسعير، والملف الأصلي أدق تفصيلًا.',
    gone: 'هذا الرابط لم يعد صالحًا',
    goneHint: 'اطلب رابط عرض جديدًا ممن أرسله إليك.',
    failed: 'تعذّر فتح العارض',
    failedHint: 'حدّث الصفحة بعد قليل.',
    noPreview: 'لا تتوفر معاينة ثلاثية الأبعاد لهذا الملف، والقياسات معروضة أدناه.',
    noWebgl: 'متصفحك لا يدعم العرض ثلاثي الأبعاد، لذلك تظهر القياسات وحدها.',
    dims: 'الأبعاد',
    volume: 'الحجم',
    triangles: 'المثلثات',
    parts: 'عدد القطع',
    format: 'الصيغة',
    reset: 'إعادة ضبط العرض',
    grid: 'الشبكة الأرضية',
    wireframe: 'الهيكل السلكي',
    ar: 'عرض بالواقع المعزز',
    arExit: 'إنهاء الواقع المعزز',
    arFailed: 'تعذّر تشغيل الواقع المعزز على هذا الجهاز.',
    hint: 'اسحب للتدوير · قرّب للتكبير',
    mm: 'ملم',
    cm3: 'سم³',
  },
  en: {
    loading: 'Loading the model',
    title: 'Model preview',
    simplified: 'Simplified preview',
    simplifiedHint: 'A simplified shape of the model for quoting; the original file is more detailed.',
    gone: 'This link is no longer valid',
    goneHint: 'Ask whoever sent it for a fresh viewing link.',
    failed: 'The viewer could not be opened',
    failedHint: 'Refresh the page shortly.',
    noPreview: 'No 3D preview is available for this file. The measurements are below.',
    noWebgl: 'Your browser cannot render 3D, so only the measurements are shown.',
    dims: 'Dimensions',
    volume: 'Volume',
    triangles: 'Triangles',
    parts: 'Parts',
    format: 'Format',
    reset: 'Reset view',
    grid: 'Ground grid',
    wireframe: 'Wireframe',
    ar: 'View in AR',
    arExit: 'Exit AR',
    arFailed: 'Augmented reality could not start on this device.',
    hint: 'Drag to rotate · pinch to zoom',
    mm: 'mm',
    cm3: 'cm³',
  },
};

/* Latin digits in both languages: these are measurements read off a caliper or
   a slicer, and every tool the reader will compare them against prints them
   this way. Grouping still comes from the locale-aware formatter. */
const int = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const dec = (n: number, d: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * LVM1 → GPU buffers.
 *
 * Layout: 'LVM1' | uint32 triangles | 6×float32 bbox | triangles×9 float32,
 * little-endian, millimetres, already centred on the origin. No indices and no
 * normals, so a flat normal is computed per triangle here and repeated across
 * its three vertices — flat shading is also the RIGHT look for a print preview,
 * where facets are what the machine will actually lay down.
 *
 * Positions are a VIEW over the response buffer rather than a copy: at the
 * 250k-triangle ceiling that is 9 MB saved per load, and WebGL requires
 * native-endian typed arrays anyway, so a Float32Array view is what the upload
 * path wants regardless.
 */
function parseLvm(buffer: ArrayBuffer): ParsedMesh | null {
  if (buffer.byteLength < 32) return null;
  const head = new DataView(buffer);
  if (head.getUint8(0) !== 0x4c || head.getUint8(1) !== 0x56) return null;
  if (head.getUint8(2) !== 0x4d || head.getUint8(3) !== 0x31) return null;

  const triangles = head.getUint32(4, true);
  const floats = triangles * 9;
  if (triangles === 0 || buffer.byteLength < 32 + floats * 4) return null;

  const min: [number, number, number] = [
    head.getFloat32(8, true),
    head.getFloat32(12, true),
    head.getFloat32(16, true),
  ];
  const max: [number, number, number] = [
    head.getFloat32(20, true),
    head.getFloat32(24, true),
    head.getFloat32(28, true),
  ];

  const position = new Float32Array(buffer, 32, floats);
  const normal = new Float32Array(floats);
  const corner = new Uint8Array(triangles * 3);

  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const ax = position[o], ay = position[o + 1], az = position[o + 2];
    const e1x = position[o + 3] - ax, e1y = position[o + 4] - ay, e1z = position[o + 5] - az;
    const e2x = position[o + 6] - ax, e2y = position[o + 7] - ay, e2z = position[o + 8] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    // A degenerate triangle has no direction to point in. Leaving it at zero
    // drops it to ambient rather than flashing a wrong-facing highlight.
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    for (let v = 0; v < 3; v++) {
      normal[o + v * 3] = nx;
      normal[o + v * 3 + 1] = ny;
      normal[o + v * 3 + 2] = nz;
      corner[t * 3 + v] = v;
    }
  }

  return { triangles, position, normal, corner, min, max };
}

const MODEL_VERT = `
attribute vec3 position;
attribute vec3 normal;
attribute float corner;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vNormal = normalMatrix * normal;
  // Barycentric weights unpacked from the corner index — three floats the
  // vertex stage makes up, so the wireframe costs one byte per vertex on the
  // bus instead of twelve.
  vBary = vec3(float(corner < 0.5), float(corner > 0.5 && corner < 1.5), float(corner > 1.5));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MODEL_FRAG = `
precision highp float;
uniform vec3 uBase;
uniform vec3 uAccent;
uniform float uWire;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  // Uploaded meshes have unreliable winding — a customer's export may hand us
  // inside-out triangles — so instead of culling, the normal is flipped toward
  // whichever side is being looked at. Nothing ever renders black.
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  // View space: the key light rides just over the viewer's shoulder, so the
  // form reads the same however the part is turned.
  float key = dot(n, normalize(vec3(0.42, 0.72, 0.55))) * 0.5 + 0.5;
  float fill = max(dot(n, normalize(vec3(-0.7, -0.25, 0.35))), 0.0);
  float rim = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 3.0);
  vec3 col = uBase * (0.17 + 0.85 * key * key + 0.16 * fill) + uAccent * rim * 0.5;

  if (uWire > 0.5) {
    float edge = min(min(vBary.x, vBary.y), vBary.z);
    // A fixed threshold rather than fwidth(): derivatives need an extension on
    // WebGL1, and this is a toggle, not the primary read of the model.
    float line = 1.0 - smoothstep(0.0, 0.04, edge);
    col = mix(col * 0.3, uAccent, line * 0.85);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const GRID_VERT = `
attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uHalf;
varying float vFade;
void main() {
  vFade = 1.0 - clamp(length(position.xz) / uHalf, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GRID_FRAG = `
precision mediump float;
uniform vec3 uColor;
varying float vFade;
void main() {
  // Squared falloff so the grid dissolves instead of ending on a hard square.
  gl_FragColor = vec4(uColor, vFade * vFade * 0.5);
}
`;

/** Millimetres → metres. In AR the part is shown at TRUE SIZE — that is the
 *  whole reason someone reaches for the button before paying to print it. */
const AR_SCALE = 0.001;
/** Roughly a tabletop below, and an arm's length ahead of, where the session
 *  starts. Placed rather than hit-tested: no plane detection is requested, so
 *  guessing a surface would be a lie the renderer cannot back up. */
const AR_FLOOR_Y = -0.45;
const AR_FORWARD_Z = -0.7;

interface Viewer {
  reset(): void;
  setGrid(on: boolean): void;
  setWire(on: boolean): void;
  startAr(): void;
  stopAr(): void;
  destroy(): void;
}

/**
 * Builds the whole GL scene once and hands back a small imperative handle.
 *
 * Everything expensive happens HERE and only here: the geometry is uploaded as
 * one static buffer per attribute and never rebuilt, and the frame loop does
 * nothing but advance the orbit easing and draw. Throws when WebGL is
 * unavailable, which is the caller's cue to fall back to the numbers.
 */
function mountViewer(
  canvas: HTMLCanvasElement,
  data: ParsedMesh,
  hooks: { onReady: () => void; onAr: (active: boolean) => void; onArError: () => void }
): Viewer {
  const renderer = new Renderer({
    canvas,
    alpha: false,
    antialias: true,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  });
  const gl: OGLRenderingContext = renderer.gl;
  // ogl's context is a union of the WebGL 1 and 2 interfaces; the raw alias
  // exists so the handful of direct calls below resolve to one of them.
  const raw = gl as WebGLRenderingContext;
  raw.clearColor(0.0196, 0.0196, 0.0235, 1); // matches the page ground #050506

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
  });
  const program = new Program(gl, {
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

  /** Distance at which a unit sphere fills the view on its TIGHTEST axis —
   *  on a 390 px phone that is the horizontal one, which is why the smaller of
   *  the two field angles wins. */
  const framingDistance = () => {
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
    return 1.18 / Math.sin(Math.min(vFov, hFov) / 2);
  };

  const place = () => {
    const d = framingDistance();
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
    ease: 0.2,
    inertia: 0.72,
    rotateSpeed: 0.13,
    zoomSpeed: 1,
    minDistance: 0.55,
    maxDistance: initialDistance * 4,
  });

  let first = true;
  let running = false;
  let raf = 0;
  let arSession: XrSession | null = null;
  let arLayer: XrWebGLLayer | null = null;
  let arSpace: unknown = null;
  let arStarting = false;
  let gridWanted = true;
  // Set by destroy(). Ending an XR session fires its own 'end' event, which
  // would otherwise restart the frame loop on a scene that is already gone.
  let dead = false;

  const frame = () => {
    if (!running) return;
    raf = window.requestAnimationFrame(frame);
    controls.update();
    renderer.render({ scene, camera });
    if (first) {
      first = false;
      hooks.onReady();
    }
  };
  const start = () => {
    if (dead || running || arSession) return;
    running = true;
    raf = window.requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    window.cancelAnimationFrame(raf);
  };

  // A hidden tab must not spin the GPU. The orbit easing is frame-based, so it
  // simply resumes from wherever it was left.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  start();

  // ------------------------------------------------------------------- AR
  const arFrame = (_time: number, xrFrame: XrFrame) => {
    if (!arSession || !arLayer) return;
    arSession.requestAnimationFrame(arFrame);
    const pose = xrFrame.getViewerPose(arSpace);
    if (!pose) return;

    renderer.bindFramebuffer({ buffer: arLayer.framebuffer });
    renderer.enable(raw.DEPTH_TEST);
    renderer.setDepthMask(true);
    // Transparent clear: everything not covered by the model is the camera feed.
    raw.clearColor(0, 0, 0, 0);
    raw.clear(raw.COLOR_BUFFER_BIT | raw.DEPTH_BUFFER_BIT);
    scene.updateMatrixWorld();

    for (const view of pose.views) {
      const viewport = arLayer.getViewport(view);
      if (!viewport) continue;
      renderer.setViewport(viewport.width, viewport.height, viewport.x, viewport.y);
      // The headset owns the projection and the pose, so ogl's own camera maths
      // is bypassed and the matrices are copied in per eye.
      camera.projectionMatrix.fromArray(view.projectionMatrix);
      camera.viewMatrix.fromArray(view.transform.inverse.matrix);
      const p = view.transform.position;
      camera.worldPosition.set(p.x, p.y, p.z);
      model.draw({ camera });
    }
  };

  const endAr = () => {
    arStarting = false;
    arSession = null;
    arLayer = null;
    arSpace = null;
    model.scale.set(fit, fit, fit);
    model.position.set(0, 0, 0);
    grid.visible = gridWanted;
    renderer.bindFramebuffer();
    resize();
    place();
    controls.forcePosition();
    hooks.onAr(false);
    if (document.visibilityState === 'visible') start();
  };

  const startAr = () => {
    const parts = xrParts();
    if (!parts || arSession || arStarting) return;
    // The session only exists after two awaits, so a second tap in that window
    // would open a second one. This flag is the door.
    arStarting = true;
    // requestSession FIRST: it needs the click's transient activation, and
    // makeXRCompatible can take long enough to spend it.
    parts.xr
      .requestSession('immersive-ar', { optionalFeatures: ['local-floor'] })
      .then(async (session) => {
        const compat = gl as unknown as { makeXRCompatible?: () => Promise<void> };
        if (compat.makeXRCompatible) await compat.makeXRCompatible();
        const layer = new parts.Layer(session, raw);
        session.updateRenderState({ baseLayer: layer });
        arSpace = await session.requestReferenceSpace('local');
        arSession = session;
        arLayer = layer;
        session.addEventListener('end', endAr);

        stop();
        // True size, standing on the imagined surface rather than centred on it.
        model.scale.set(AR_SCALE, AR_SCALE, AR_SCALE);
        model.position.set(0, AR_FLOOR_Y - data.min[2] * AR_SCALE, AR_FORWARD_Z);
        grid.visible = false;
        hooks.onAr(true);
        session.requestAnimationFrame(arFrame);
      })
      .catch(() => {
        arStarting = false;
        arSession = null;
        arLayer = null;
        hooks.onArError();
        if (document.visibilityState === 'visible') start();
      });
  };

  return {
    reset() {
      const d = place();
      controls.maxDistance = d * 4;
      controls.forcePosition();
    },
    setGrid(on: boolean) {
      gridWanted = on;
      if (!arSession) grid.visible = on;
    },
    setWire(on: boolean) {
      program.uniforms.uWire.value = on ? 1 : 0;
    },
    startAr,
    stopAr() {
      void arSession?.end();
    },
    destroy() {
      dead = true;
      stop();
      void arSession?.end();
      arSession = null;
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

export default function ModelViewer() {
  const { token } = useParams<{ token: string }>();
  const { lang, dir } = useLanguage();
  const t = lang === 'en' ? STR.en : STR.ar;

  const [meta, setMeta] = useState<ViewerMeta | null>(null);
  const [fatal, setFatal] = useState<'gone' | 'failed' | null>(null);
  const [mesh, setMesh] = useState<ParsedMesh | null>(null);
  const [noPreview, setNoPreview] = useState(false);
  const [noWebgl, setNoWebgl] = useState(false);
  const [ready, setReady] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [arSupported, setArSupported] = useState(false);
  const [arActive, setArActive] = useState(false);
  const [arError, setArError] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);

  // 1. Metadata. This is also the token check: a 404 here is the ONLY thing
  //    that means "the link is dead", and the panel it feeds is what the
  //    WebGL-less fallback falls back to.
  useEffect(() => {
    if (!token) {
      setFatal('gone');
      return;
    }
    let alive = true;
    api
      .get<ViewerMeta>(`/api/marketplace/print/viewer/${encodeURIComponent(token)}`)
      .then((res) => {
        if (alive) setMeta(res);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setFatal(e instanceof ApiError && e.status === 404 ? 'gone' : 'failed');
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // 2. The mesh. Raw fetch, not `api`, because the body is binary — the client
  //    would try to parse octet-stream as JSON and throw on the first byte.
  useEffect(() => {
    if (!token || !meta) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/marketplace/print/viewer/${encodeURIComponent(token)}/mesh`, {
          credentials: 'same-origin',
        });
        if (!alive) return;
        if (!res.ok) {
          // The token already proved good above, so this is a format with no
          // cached preview — not a dead link.
          setNoPreview(true);
          return;
        }
        const parsed = parseLvm(await res.arrayBuffer());
        if (!alive) return;
        if (parsed) setMesh(parsed);
        else setNoPreview(true);
      } catch {
        if (alive) setNoPreview(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, meta]);

  // 3. The scene. Built once per mesh and torn down on unmount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!mesh || !canvas) return;
    let viewer: Viewer;
    try {
      viewer = mountViewer(canvas, mesh, {
        onReady: () => setReady(true),
        onAr: setArActive,
        onArError: () => setArError(true),
      });
    } catch {
      setNoWebgl(true);
      return;
    }
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
      viewer.destroy();
    };
  }, [mesh]);

  // `ready` is in the deps so the toggles are applied to a scene that appears
  // after them, not just to one that was already up.
  useEffect(() => {
    viewerRef.current?.setGrid(showGrid);
  }, [showGrid, ready]);
  useEffect(() => {
    viewerRef.current?.setWire(wireframe);
  }, [wireframe, ready]);

  // AR is offered only where a session can actually be opened. No disabled
  // button, no "coming soon" — on every other device the control is absent.
  useEffect(() => {
    const parts = xrParts();
    if (!parts) return;
    let alive = true;
    parts.xr
      .isSessionSupported('immersive-ar')
      .then((ok) => {
        if (alive && ok) setArSupported(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onAr = useCallback(() => {
    setArError(false);
    if (arActive) viewerRef.current?.stopAr();
    else viewerRef.current?.startAr();
  }, [arActive]);

  const dims = meta?.dimensions_mm ??
    (mesh ? { x: mesh.max[0] - mesh.min[0], y: mesh.max[1] - mesh.min[1], z: mesh.max[2] - mesh.min[2] } : null);
  const triangles = meta?.triangle_count ?? mesh?.triangles ?? null;
  const showCanvas = !fatal && !noWebgl && !noPreview;
  const showLoader = !fatal && !ready && !noWebgl && !noPreview;

  const btn =
    'inline-flex items-center justify-center min-h-11 min-w-11 rounded-xl border border-white/10 ' +
    'bg-zinc-950/70 backdrop-blur-md text-zinc-300 hover:text-white hover:border-white/25 transition-colors';
  const btnOn = 'border-gold/50 bg-gold/15 text-gold hover:text-gold';

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-black text-white"
      dir={dir}
      data-page="model-viewer"
    >
      {showCanvas && (
        <div className="absolute inset-0" data-viewer={ready ? 'ready' : undefined}>
          {/* touch-none: the orbit owns the gesture, so the page must not try
              to scroll or double-tap-zoom underneath it. */}
          <canvas ref={canvasRef} data-viewer="canvas" className="absolute inset-0 block touch-none" />
        </div>
      )}

      {showLoader && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">
          <Loader2 className="h-7 w-7 animate-spin text-gold" aria-hidden />
          <p className="text-sm text-zinc-400">{t.loading}</p>
        </div>
      )}

      {fatal && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-center">
            {fatal === 'gone' ? (
              <Link2Off className="mx-auto mb-3 h-8 w-8 text-zinc-500" aria-hidden />
            ) : (
              <TriangleAlert className="mx-auto mb-3 h-8 w-8 text-zinc-500" aria-hidden />
            )}
            <p className="text-lg font-black leading-tight">{fatal === 'gone' ? t.gone : t.failed}</p>
            <p className="mt-2 text-sm text-zinc-400">{fatal === 'gone' ? t.goneHint : t.failedHint}</p>
          </div>
        </div>
      )}

      {!fatal && (
        <>
          {/* Top bar: what this is, and the controls. Both float over the
              canvas so the model keeps the whole viewport. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-3">
            <div className="pointer-events-auto min-w-0 flex-1 rounded-xl border border-white/10 bg-zinc-950/70 px-3 py-2 backdrop-blur-md">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-bold">{t.title}</p>
                {/* The board's merchant is sent a coarse mesh, never the file:
                    say so, or a rough shape reads as a rough print. */}
                {meta?.grant === 'preview' && (
                  <span
                    data-viewer="simplified"
                    title={t.simplifiedHint}
                    className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold text-amber-200"
                  >
                    {t.simplified}
                    <span className="sr-only"> — {t.simplifiedHint}</span>
                  </span>
                )}
              </div>
              {meta?.format && (
                <p
                  className="text-[11px] uppercase tracking-wide text-zinc-400"
                  dir="ltr"
                  aria-label={t.format}
                >
                  {meta.format}
                </p>
              )}
            </div>

            <div className="pointer-events-auto flex shrink-0 items-center gap-2">
              {arSupported && mesh && !noWebgl && (
                <button
                  type="button"
                  onClick={onAr}
                  data-viewer="ar"
                  aria-pressed={arActive}
                  title={arActive ? t.arExit : t.ar}
                  aria-label={arActive ? t.arExit : t.ar}
                  className={`${btn} gap-2 px-3 ${arActive ? btnOn : ''}`}
                >
                  <Smartphone className="h-4 w-4" aria-hidden />
                  <span className="hidden text-xs font-bold sm:inline">{arActive ? t.arExit : t.ar}</span>
                </button>
              )}
              {showCanvas && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowGrid((v) => !v)}
                    data-viewer="grid"
                    aria-pressed={showGrid}
                    title={t.grid}
                    aria-label={t.grid}
                    className={`${btn} ${showGrid ? btnOn : ''}`}
                  >
                    <Grid3x3 className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setWireframe((v) => !v)}
                    data-viewer="wireframe"
                    aria-pressed={wireframe}
                    title={t.wireframe}
                    aria-label={t.wireframe}
                    className={`${btn} ${wireframe ? btnOn : ''}`}
                  >
                    <Component className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => viewerRef.current?.reset()}
                    data-viewer="reset"
                    title={t.reset}
                    aria-label={t.reset}
                    className={btn}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Bottom: the measurements, and the gesture hint. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
            {(noPreview || noWebgl || arError) && (
              <p className="pointer-events-auto mx-auto mb-2 max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-[13px] text-amber-200">
                {arError ? t.arFailed : noWebgl ? t.noWebgl : t.noPreview}
              </p>
            )}

            <div className="flex items-end justify-between gap-3">
              <dl
                data-viewer="info"
                className="pointer-events-auto w-full max-w-[17rem] rounded-2xl border border-white/10 bg-zinc-950/70 p-3 text-[13px] backdrop-blur-md"
              >
                <div className="flex items-center gap-2 py-1">
                  <Ruler className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.dims}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="dimensions">
                    {dims ? `${dec(dims.x, 1)} × ${dec(dims.y, 1)} × ${dec(dims.z, 1)} ${t.mm}` : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <Cuboid className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.volume}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="volume">
                    {meta?.volume_mm3 != null ? `${dec(meta.volume_mm3 / 1000, 1)} ${t.cm3}` : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <Triangle className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.triangles}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="triangles">
                    {triangles != null ? int(triangles) : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.parts}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="parts">
                    {meta?.shell_count != null ? int(meta.shell_count) : '—'}
                  </dd>
                </div>
              </dl>

              {showCanvas && ready && !arActive && (
                <p className="hidden shrink-0 items-center gap-1.5 pb-1 text-[12px] text-zinc-500 sm:flex">
                  <Rotate3d className="h-3.5 w-3.5" aria-hidden />
                  {t.hint}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
