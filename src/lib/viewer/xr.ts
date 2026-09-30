/**
 * The WebXR immersive-ar path, moved verbatim out of src/pages/ModelViewer.tsx
 * (the one viewer core): the types, the session start, true scale and the floor
 * guess. The scene hands it the pieces it touches (`ArHost`), so the bodies of
 * `arFrame`, `endAr` and `startAr` are the page's own, line for line.
 */
import type { Camera, Mesh, OGLRenderingContext, Orbit, Renderer, Transform } from 'ogl';

/* --------------------------------------------------------------- WebXR types
 *
 * WebXR is absent from TypeScript's DOM lib, so this is the minimum surface the
 * AR path actually touches. Declared rather than reached for through `any` so a
 * typo in it fails the typecheck like any other call. */
export interface XrRigidTransform {
  readonly matrix: Float32Array;
  readonly inverse: XrRigidTransform;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}
export interface XrView {
  readonly projectionMatrix: Float32Array;
  readonly transform: XrRigidTransform;
}
export interface XrViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface XrViewerPose {
  readonly views: readonly XrView[];
}
export interface XrFrame {
  /** The reference space is an opaque handle we only ever hand back. */
  getViewerPose(space: unknown): XrViewerPose | null;
}
export interface XrWebGLLayer {
  readonly framebuffer: WebGLFramebuffer | null;
  getViewport(view: XrView): XrViewport | undefined;
}
export interface XrSession {
  requestReferenceSpace(type: string): Promise<unknown>;
  updateRenderState(state: { baseLayer: XrWebGLLayer }): void;
  requestAnimationFrame(callback: (time: number, frame: XrFrame) => void): number;
  addEventListener(type: 'end', listener: () => void): void;
  end(): Promise<void>;
}
export interface XrSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(
    mode: string,
    init?: { requiredFeatures?: string[]; optionalFeatures?: string[] }
  ): Promise<XrSession>;
}
export type XrWebGLLayerCtor = new (
  session: XrSession,
  gl: WebGLRenderingContext | WebGL2RenderingContext
) => XrWebGLLayer;

/**
 * BOTH halves or nothing. `navigator.xr` alone is not enough to draw anything —
 * without the XRWebGLLayer constructor there is no framebuffer to render into,
 * and an AR button that cannot render is worse than no button at all.
 */
export function xrParts(): { xr: XrSystem; Layer: XrWebGLLayerCtor } | null {
  const xr = (navigator as Navigator & { xr?: XrSystem }).xr;
  const Layer = (window as Window & { XRWebGLLayer?: XrWebGLLayerCtor }).XRWebGLLayer;
  return xr && Layer ? { xr, Layer } : null;
}

/** Millimetres → metres. In AR the part is shown at TRUE SIZE — that is the
 *  whole reason someone reaches for the button before paying to print it. */
export const AR_SCALE = 0.001;
/** Roughly a tabletop below, and an arm's length ahead of, where the session
 *  starts. Placed rather than hit-tested: no plane detection is requested, so
 *  guessing a surface would be a lie the renderer cannot back up. */
export const AR_FLOOR_Y = -0.45;
export const AR_FORWARD_Z = -0.7;

/** What the AR path touches of the scene (src/lib/viewer/scene.ts). */
export interface ArHost {
  gl: OGLRenderingContext;
  renderer: Renderer;
  camera: Camera;
  scene: Transform;
  model: Mesh;
  grid: Mesh;
  controls: Orbit;
  /** The model's normalising scale (1 / bounding radius). */
  fit: number;
  /** The mesh's lowest Z in millimetres — what stands on the imagined floor. */
  minZ: number;
  /** Whether the page wants its grid back when AR ends. */
  gridWanted(): boolean;
  resize(): void;
  place(): void;
  start(): void;
  stop(): void;
  onAr(active: boolean): void;
  onArError(): void;
}

export interface ArControl {
  start(): void;
  stop(): void;
  /** A session is running: the page loop must not start under it. */
  active(): boolean;
  /** Teardown: end any session and forget it. */
  end(): void;
}

export function createAr(host: ArHost): ArControl {
  const { gl, renderer, camera, scene, model, grid, controls, fit, resize, place, start, stop } = host;
  // ogl's context is a union of the WebGL 1 and 2 interfaces; the raw alias
  // exists so the handful of direct calls below resolve to one of them.
  const raw = gl as WebGLRenderingContext;
  let arSession: XrSession | null = null;
  let arLayer: XrWebGLLayer | null = null;
  let arSpace: unknown = null;
  let arStarting = false;

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
    grid.visible = host.gridWanted();
    renderer.bindFramebuffer();
    resize();
    place();
    controls.forcePosition();
    host.onAr(false);
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
        model.position.set(0, AR_FLOOR_Y - host.minZ * AR_SCALE, AR_FORWARD_Z);
        grid.visible = false;
        host.onAr(true);
        session.requestAnimationFrame(arFrame);
      })
      .catch(() => {
        arStarting = false;
        arSession = null;
        arLayer = null;
        host.onArError();
        if (document.visibilityState === 'visible') start();
      });
  };

  return {
    start: startAr,
    stop() {
      void arSession?.end();
    },
    active: () => arSession !== null,
    end() {
      void arSession?.end();
      arSession = null;
    },
  };
}
