/**
 * Typed engine adapter (S4 editor-core).
 *
 * Owns every direct interaction with the three-slicer engine that the shell
 * previously scattered across slicer-client.tsx:
 *
 * - shadow-root discovery (event-driven via an `attachShadow` hook + a single
 *   container MutationObserver — NO 500 ms polling interval),
 * - theme CSS injection into every engine shadow root,
 * - `data-testid` clicks, synthetic keyboard shortcuts, and the hidden
 *   file-input dispatch,
 * - every `window.__vpApi` call, including scene snapshot capture/restore for
 *   undoable arrangement.
 *
 * The adapter is deliberately React-free so it can be driven from hooks,
 * components, or tests alike. All failures are reported through return values
 * or `EngineAdapterError` codes — the UI layer owns localization.
 *
 * CONTRACT: every test id and `__vpApi` member used here is listed in the
 * exported contract constants below, and tests/editor-capabilities.test.mjs
 * verifies each one against the installed `node_modules/three-slicer` build.
 * Do not add a lookup without extending the contract lists.
 */

import {
  PLATE_CAP,
  planGeneralArrangement,
  snapshotFootprint,
  type ArrangeCandidate,
  type ArrangePlan,
} from "./plate-packing";
import { planSeats, type SeatedFootprint, type SeatRequest } from "./spawn-seating";
import { autoOrient, lowestPoint } from "./auto-orient";
import { cutByPlane, extentAlong, type CutPlane } from "./plane-cut";

// ---------------------------------------------------------------------------
// Engine contract (verified by tests/editor-capabilities.test.mjs)
// ---------------------------------------------------------------------------

/** Static test ids rendered verbatim by the installed engine build. */
export const ENGINE_STATIC_TEST_IDS = [
  "stl-input",
  "plate-add",
  "plate-del",
  "plate-bar",
  "slice-btn",
  "slice-current",
  "slice-all",
  "mode-prepare",
  "mode-preview",
  "save-project",
  "export-all",
  "gcode-dl",
  "gizmo-move",
  "gizmo-rotate",
  "gizmo-scale",
  "gizmo-paint",
  "undo",
  "redo",
  "layer-range",
] as const;

/**
 * Toolbar action test ids the engine renders through its `tool-${action.id}`
 * template; the action ids (the part after "tool-") must exist in the engine's
 * action table.
 */
export const ENGINE_ACTION_TEST_IDS = [
  "tool-delete",
  "tool-delete-all",
  "tool-duplicate",
  "tool-split",
  "tool-onbed",
] as const;

/** `window.__vpApi` members this adapter calls. */
export const ENGINE_API_METHODS = [
  "sceneSnapshot",
  "restoreScene",
  "placeObjectOnPlate",
  "platePos",
  "frame",
  "suspendRendering",
  "selectedObjectId",
  "hasPaintImport",
] as const;

/**
 * Engine globals this adapter reaches for that are NOT part of `__vpApi`.
 *
 * `__vpReleaseWorker` is added by `patches/three-slicer+0.2.2.patch` — see
 * patches/README.md for why the shell cannot free the idle slice worker
 * without it. Listing it here means tests/editor-capabilities.test.mjs fails
 * loudly if the patch ever stops being applied, instead of Studio quietly
 * going back to holding a WASM heap and a pthread pool on phones.
 */
export const ENGINE_WINDOW_HOOKS = [
  "__vpApi",
  "__vpReleaseWorker",
] as const;

export type EngineStaticTestId = (typeof ENGINE_STATIC_TEST_IDS)[number];
export type EngineActionTestId = (typeof ENGINE_ACTION_TEST_IDS)[number];
export type EngineTestId = EngineStaticTestId | EngineActionTestId | `plate-${number}`;

// The ambient LevoViewportApi/LevoSceneSnapshot interfaces in
// types/three-slicer-globals.d.ts predate this adapter; merge in the members
// the installed 0.2.2 build actually exposes and that the adapter relies on.
declare global {
  interface LevoSceneSnapshot {
    extruder?: number;
    visible?: boolean;
  }
  interface LevoViewportApi {
    /** Restores a scene to the exact state a previous sceneSnapshot() captured. */
    restoreScene(entries: readonly LevoSceneSnapshot[]): void;
    /** three.js (x,z) world offset of plate `plateIndex`'s centre. */
    platePos(plateIndex: number): { x: number; z: number };
    /**
     * Stops the engine's render loop while something long and non-visual runs.
     * The engine's own doc comment: "on a large model each one is a main-thread
     * block that delays the very worker replies the export is waiting on."
     */
    suspendRendering(suspended: boolean): void;
    /** Id of the selected object, or null/0 when nothing is selected. */
    selectedObjectId(): number | null;
    /** True when an opened project carried painted facets the kernel holds. */
    hasPaintImport(): boolean;
  }
  interface Window {
    /**
     * Added by patches/three-slicer+0.2.2.patch. Terminates the idle slice
     * worker (and with it the pthread pool it owns) so the engine builds a
     * fresh one on the next slice. Returns false — changing nothing — while a
     * slice is pending. Absent when the patch is not applied.
     */
    __vpReleaseWorker?: () => boolean;
  }
}

export type EngineAdapterErrorCode =
  | "engine-unavailable"
  | "file-input-unavailable"
  | "file-dispatch-rejected";

export class EngineAdapterError extends Error {
  readonly code: EngineAdapterErrorCode;
  constructor(code: EngineAdapterErrorCode, message: string) {
    super(message);
    this.name = "EngineAdapterError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// attachShadow hook — event-driven shadow root discovery
// ---------------------------------------------------------------------------

type ShadowRootListener = (host: Element, root: ShadowRoot) => void;

interface ShadowHookState {
  listeners: Set<ShadowRootListener>;
  installed: boolean;
}

const SHADOW_HOOK_KEY = "__levoShadowRootHook";

function shadowHookState(): ShadowHookState {
  const holder = globalThis as unknown as Record<string, ShadowHookState | undefined>;
  let state = holder[SHADOW_HOOK_KEY];
  if (!state) {
    state = { listeners: new Set(), installed: false };
    holder[SHADOW_HOOK_KEY] = state;
  }
  return state;
}

/**
 * Patches Element.prototype.attachShadow once (idempotent, survives HMR) so
 * newly created shadow roots are announced synchronously. `attachShadow` is not
 * observable through MutationObserver, which is why the previous implementation
 * fell back to a 500 ms polling interval; this hook removes that poll entirely.
 */
export function installShadowRootHook(): void {
  if (typeof Element === "undefined") return;
  const state = shadowHookState();
  if (state.installed) return;
  state.installed = true;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function levoAttachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    for (const listener of [...state.listeners]) {
      try {
        listener(this, root);
      } catch {
        // A faulty listener must never break the engine's own attachShadow.
      }
    }
    return root;
  };
}

/** Subscribes to shadow-root creation. Returns an unsubscribe function. */
export function onShadowRootAttached(listener: ShadowRootListener): () => void {
  installShadowRootHook();
  const state = shadowHookState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Scene state capture (opaque, for undoable operations)
// ---------------------------------------------------------------------------

declare const engineSceneStateBrand: unique symbol;

/**
 * Opaque captured scene state. Internally this is the exact array
 * `__vpApi().sceneSnapshot()` returned — its entries carry live three.js
 * Vector3/Euler clones that `restoreScene` needs, so it must be passed back
 * unmodified and never serialized.
 */
export interface EngineSceneState {
  readonly [engineSceneStateBrand]: true;
}

interface CapturedSceneState {
  entries: LevoSceneSnapshot[];
  selectedPlate: number;
}

function asCaptured(state: EngineSceneState): CapturedSceneState {
  return state as unknown as CapturedSceneState;
}

function toOpaque(state: CapturedSceneState): EngineSceneState {
  return state as unknown as EngineSceneState;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface EngineAdapterOptions {
  /** Theme CSS injected into every engine shadow root. Can be replaced later. */
  themeCss?: string;
}

function nextFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** DOM events inside the engine that can conclude a scene edit gesture. */
const SCENE_EDIT_EVENTS = ["pointerup", "keyup", "change", "click"] as const;

export class EngineAdapter {
  private container: HTMLElement | null = null;
  private mainHost: HTMLElement | null = null;
  private themeCss: string;
  private readonly styledRoots = new Map<ShadowRoot, MutationObserver>();
  private readonly editListenedRoots = new Set<ShadowRoot>();
  private readonly pendingHosts = new Set<Element>();
  private containerObserver: MutationObserver | null = null;
  private unhookShadow: (() => void) | null = null;
  private readonly sceneEditListeners = new Set<() => void>();
  private sceneEditScheduled = false;
  private readonly hostAttributes = new Map<string, string>();
  private readonly onRootEditEvent = () => this.scheduleSceneEditNotification();

  constructor(options: EngineAdapterOptions = {}) {
    this.themeCss = options.themeCss ?? "";
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Starts watching `container` for the engine's shadow roots. Roots created
   * before or after attach are both handled; discovery is event-driven (the
   * attachShadow hook plus one childList observer on the container).
   */
  attach(container: HTMLElement): void {
    if (this.container === container) return;
    this.detach();
    this.container = container;

    this.unhookShadow = onShadowRootAttached((host) => {
      // The host is usually not connected yet when attachShadow runs; defer
      // containment checks to a microtask, and keep unresolved hosts pending
      // until a container mutation connects them.
      queueMicrotask(() => this.considerHost(host));
    });

    this.containerObserver = new MutationObserver(() => this.flushPendingHosts());
    this.containerObserver.observe(container, { childList: true, subtree: true });

    this.scanExistingRoots(container);
  }

  detach(): void {
    this.unhookShadow?.();
    this.unhookShadow = null;
    this.containerObserver?.disconnect();
    this.containerObserver = null;
    for (const [root, observer] of this.styledRoots) {
      observer.disconnect();
      this.removeEditListeners(root);
    }
    this.styledRoots.clear();
    this.editListenedRoots.clear();
    this.pendingHosts.clear();
    this.container = null;
    this.mainHost = null;
  }

  // -- shadow root / host access -------------------------------------------

  /** The engine's main shadow host (the root that renders `.app-shell`). */
  host(): HTMLElement | null {
    if (this.mainHost && this.mainHost.isConnected) return this.mainHost;
    this.mainHost = null;
    for (const root of this.styledRoots.keys()) {
      if (root.querySelector(".app-shell")) {
        const host = root.host as HTMLElement;
        if (host.isConnected) {
          this.mainHost = host;
          this.applyHostAttributes(host);
          return host;
        }
      }
    }
    return null;
  }

  /** The engine's main shadow root, or null before the engine has mounted. */
  root(): ShadowRoot | null {
    return this.host()?.shadowRoot ?? null;
  }

  /**
   * Sets an attribute on the engine's shadow host (e.g. `data-levo-sidebar`).
   * Remembered and re-applied if the host remounts.
   */
  setHostAttribute(name: string, value: string): void {
    this.hostAttributes.set(name, value);
    this.host()?.setAttribute(name, value);
  }

  // -- theme injection ------------------------------------------------------

  /** Replaces the injected theme CSS in every known engine shadow root. */
  setThemeCss(css: string): void {
    this.themeCss = css;
    for (const root of this.styledRoots.keys()) this.ensureStyle(root);
  }

  // -- controls -------------------------------------------------------------

  private queryControl(testId: string): HTMLElement | null {
    return this.root()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
  }

  /** True when the control exists and is not a disabled button. */
  isControlAvailable(testId: EngineTestId): boolean {
    const element = this.queryControl(testId);
    return Boolean(element) && !(element instanceof HTMLButtonElement && element.disabled);
  }

  /** Clicks an engine control by test id. Returns false when unavailable. */
  clickControl(testId: EngineTestId): boolean {
    const element = this.queryControl(testId);
    if (!element || (element instanceof HTMLButtonElement && element.disabled)) return false;
    element.click();
    return true;
  }

  /**
   * Clicks a prepare-mode control, switching the engine back to prepare mode
   * first when the control is hidden by preview mode.
   */
  async runPrepareAction(testId: EngineTestId): Promise<boolean> {
    if (this.clickControl(testId)) return true;
    if (!this.clickControl("mode-prepare")) return false;
    await nextFrame();
    return this.clickControl(testId);
  }

  /** Dispatches a synthetic keyboard shortcut to the engine's app shell. */
  sendShortcut(key: string): boolean {
    const shell = this.root()?.querySelector<HTMLElement>(".app-shell");
    if (!shell) return false;
    shell.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    return true;
  }

  /** Selects plate `index` through the engine's plate bar. */
  selectPlate(index: number): boolean {
    return this.clickControl(`plate-${index}` as EngineTestId);
  }

  /** Number of plate tabs currently rendered by the engine. */
  currentPlateCount(): number {
    const root = this.root();
    if (!root) return 0;
    return root.querySelectorAll('[data-testid^="plate-"]:not([data-testid="plate-add"]):not([data-testid="plate-del"]):not([data-testid="plate-bar"])').length;
  }

  /**
   * Clicks plate-add until at least `targetCount` plates exist (bounded by the
   * engine's own {@link PLATE_CAP}). Resolves with the plate count reached.
   */
  async ensurePlateCount(targetCount: number): Promise<number> {
    const target = Math.max(1, Math.min(PLATE_CAP, targetCount));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = this.currentPlateCount();
      if (current >= target) return current;
      const add = this.queryControl("plate-add");
      if (!(add instanceof HTMLElement) || (add instanceof HTMLButtonElement && add.disabled)) return current;
      add.click();
      await nextFrame();
      await nextFrame();
    }
    return this.currentPlateCount();
  }

  /**
   * Starts a slice through the engine's slice button. When a slice menu opens
   * (multi-plate projects), the requested scope is picked on the next frame.
   * Returns false when the slice button is unavailable.
   */
  triggerSlice(scope: "current" | "all"): boolean {
    if (!this.clickControl("slice-btn")) return false;
    window.requestAnimationFrame(() => {
      this.clickControl(scope === "all" ? "slice-all" : "slice-current");
    });
    return true;
  }

  // -- file dispatch --------------------------------------------------------

  /**
   * Hands files to the engine through its hidden `stl-input`, waiting up to
   * ~90 frames for the input to mount. Uses DataTransfer when the browser
   * supports it and a property-descriptor fallback otherwise.
   */
  async dispatchFiles(files: File[]): Promise<void> {
    let input: HTMLInputElement | null = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      input = this.root()?.querySelector<HTMLInputElement>('[data-testid="stl-input"]') ?? null;
      if (input) break;
      await nextFrame();
    }
    if (!input) throw new EngineAdapterError("file-input-unavailable", "The engine's file input is not available.");
    const engineInput = input;
    engineInput.value = "";
    const dispatchChange = () => engineInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    try {
      if (typeof DataTransfer !== "function") throw new Error("DataTransfer is unavailable");
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      engineInput.files = transfer.files;
      if (engineInput.files?.length !== files.length) {
        throw new EngineAdapterError("file-dispatch-rejected", "The browser rejected the transferred files.");
      }
      dispatchChange();
      return;
    } catch {
      const previousDescriptor = Object.getOwnPropertyDescriptor(engineInput, "files");
      try {
        Object.defineProperty(engineInput, "files", { configurable: true, value: files });
        dispatchChange();
      } finally {
        if (previousDescriptor) Object.defineProperty(engineInput, "files", previousDescriptor);
        else delete (engineInput as unknown as Record<string, unknown>).files;
      }
    }
  }

  // -- __vpApi --------------------------------------------------------------

  /** The engine's viewport API, or null before the viewport has mounted. */
  api(): LevoViewportApi | null {
    if (typeof window === "undefined") return null;
    return window.__vpApi?.() ?? null;
  }

  /** Current scene snapshots (empty when the engine is unavailable). */
  sceneSnapshot(): LevoSceneSnapshot[] {
    return this.api()?.sceneSnapshot() ?? [];
  }

  placeObjectOnPlate(id: number, plateIndex: number, offsetX: number, offsetY: number): boolean {
    const api = this.api();
    if (!api) return false;
    api.placeObjectOnPlate(id, plateIndex, offsetX, offsetY);
    return true;
  }

  /** Re-frames the camera on the scene. */
  frame(): boolean {
    const api = this.api();
    if (!api) return false;
    api.frame();
    return true;
  }

  /**
   * Stops (or resumes) the engine's render loop. The engine exposes this for
   * exactly the case the shell has: a long, non-visual main-thread job — a
   * full 3MF export for autosave, a G-code export, an import dispatch — where
   * every frame drawn in the meantime is an identical picture that delays the
   * job. Resuming redraws once, so nothing is left stale on screen.
   *
   * Always pair a `true` with a `false` in a `finally`. Returns false when the
   * engine has not mounted yet.
   */
  suspendRendering(suspended: boolean): boolean {
    const api = this.api();
    if (!api || typeof api.suspendRendering !== "function") return false;
    api.suspendRendering(suspended);
    return true;
  }

  /** Runs `work` with the engine's render loop suspended, restoring it after. */
  async withRenderingSuspended<T>(work: () => Promise<T>): Promise<T> {
    const suspended = this.suspendRendering(true);
    try {
      return await work();
    } finally {
      if (suspended) this.suspendRendering(false);
    }
  }

  /**
   * Releases the engine's idle slice worker, freeing its WASM heap and — on
   * the threaded kernel — the `navigator.hardwareConcurrency` pthread workers
   * it owns. The engine creates a fresh worker on the next slice.
   *
   * Returns false and changes nothing when a slice is running, or when the
   * hook is absent (see patches/README.md). It is NOT a cancel: it never
   * interrupts work, and callers must not use it as one.
   */
  releaseSlicerWorker(): boolean {
    if (typeof window === "undefined") return false;
    const release = window.__vpReleaseWorker;
    if (typeof release !== "function") return false;
    try {
      return release() === true;
    } catch {
      return false;
    }
  }

  /** True when the installed engine build carries the worker-release patch. */
  canReleaseSlicerWorker(): boolean {
    return typeof window !== "undefined" && typeof window.__vpReleaseWorker === "function";
  }

  /**
   * Nearest-plate classification of a snapshot from the engine's own plate
   * offsets (`platePos`). Plates are laid out further apart than a bed width,
   * so nearest-centre is exact for on-bed objects.
   */
  plateOfSnapshot(snapshot: LevoSceneSnapshot, plateCount: number): number {
    const api = this.api();
    if (!api || plateCount <= 1) return 0;
    let best = 0;
    let bestDistance = Infinity;
    for (let plate = 0; plate < plateCount; plate += 1) {
      const centre = api.platePos(plate);
      const dx = snapshot.pos.x - centre.x;
      const dz = snapshot.pos.z - centre.z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = plate;
      }
    }
    return best;
  }

  /** Captures the current scene for a later {@link restoreSceneState}. */
  captureSceneState(selectedPlate = 0): EngineSceneState | null {
    const api = this.api();
    if (!api) return null;
    return toOpaque({ entries: api.sceneSnapshot(), selectedPlate });
  }

  /**
   * Restores a captured scene state through the engine's `restoreScene`
   * (positions, rotations, scales, extruders, visibility, and object
   * existence). Notifies scene-edit listeners so stale-result tracking sees
   * the change. Plates added after the capture are not removed — only object
   * state is restored, which the engine's API supports.
   */
  restoreSceneState(state: EngineSceneState): boolean {
    const api = this.api();
    if (!api) return false;
    const captured = asCaptured(state);
    api.restoreScene(captured.entries);
    this.selectPlate(captured.selectedPlate);
    api.frame();
    this.scheduleSceneEditNotification();
    return true;
  }

  // -- scene edit signals ---------------------------------------------------

  /**
   * Subscribes to *candidate* scene-edit signals: gesture-ending DOM events
   * inside the engine (pointerup / keyup / change / click) plus adapter-driven
   * mutations (arrange, restore). Listeners should fingerprint the scene to
   * decide whether anything actually changed — the signal is event-driven and
   * intentionally over-approximate, never a poll.
   */
  onSceneEdit(listener: () => void): () => void {
    this.sceneEditListeners.add(listener);
    return () => {
      this.sceneEditListeners.delete(listener);
    };
  }

  /**
   * Cheap order-insensitive fingerprint of the scene's printable state
   * (ids, transforms, extruders, visibility). Used by stale-result tracking.
   */
  sceneFingerprint(): string {
    const parts = this.sceneSnapshot().map((snapshot) => [
      snapshot.id,
      snapshot.pos.x.toFixed(3), snapshot.pos.y.toFixed(3), snapshot.pos.z.toFixed(3),
      snapshot.rot.x.toFixed(4), snapshot.rot.y.toFixed(4), snapshot.rot.z.toFixed(4),
      snapshot.scale.x.toFixed(4), snapshot.scale.y.toFixed(4), snapshot.scale.z.toFixed(4),
      snapshot.extruder ?? 1,
      snapshot.visible === false ? 0 : 1,
    ].join(","));
    return parts.sort().join(";");
  }

  /**
   * Reports an adapter-external scene mutation (e.g. an orchestrated
   * arrangement) to the scene-edit listeners, so stale-result tracking sees
   * programmatic changes as well as user gestures.
   */
  notifySceneEdited(): void {
    this.scheduleSceneEditNotification();
  }

  private scheduleSceneEditNotification(): void {
    if (this.sceneEditScheduled) return;
    this.sceneEditScheduled = true;
    queueMicrotask(() => {
      this.sceneEditScheduled = false;
      for (const listener of [...this.sceneEditListeners]) {
        try {
          listener();
        } catch {
          // Listeners must not break the adapter.
        }
      }
    });
  }

  // -- internals ------------------------------------------------------------

  private scanExistingRoots(scope: HTMLElement | ShadowRoot): void {
    for (const element of scope.querySelectorAll<HTMLElement>("*")) {
      const root = element.shadowRoot;
      if (root) {
        this.adoptRoot(root);
        this.scanExistingRoots(root);
      }
    }
  }

  private considerHost(host: Element): void {
    const container = this.container;
    if (!container) return;
    const root = host.shadowRoot;
    if (!root) return;
    if (container.contains(host) || this.isInsideKnownRoot(host)) {
      this.adoptRoot(root);
      this.pendingHosts.delete(host);
    } else if (!host.isConnected) {
      this.pendingHosts.add(host);
    }
  }

  private isInsideKnownRoot(host: Element): boolean {
    const rootNode = host.getRootNode();
    return rootNode instanceof ShadowRoot && this.styledRoots.has(rootNode);
  }

  private flushPendingHosts(): void {
    if (!this.pendingHosts.size) return;
    for (const host of [...this.pendingHosts]) {
      if (host.isConnected) {
        this.pendingHosts.delete(host);
        this.considerHost(host);
      }
    }
  }

  private adoptRoot(root: ShadowRoot): void {
    if (this.styledRoots.has(root)) return;
    this.ensureStyle(root);
    // One light childList observer per root: re-asserts the theme style if the
    // engine replaces its children, and adopts nested hosts revealed by
    // re-renders. This observer reacts to events only — no timers.
    const observer = new MutationObserver(() => {
      this.ensureStyle(root);
      this.flushPendingHosts();
    });
    observer.observe(root, { childList: true });
    this.styledRoots.set(root, observer);
    this.addEditListeners(root);
    // A freshly adopted root may already contain nested shadow hosts.
    this.scanExistingRoots(root);
    // The main host may have just become identifiable.
    this.host();
  }

  private ensureStyle(root: ShadowRoot): void {
    let style = root.querySelector<HTMLStyleElement>("style[data-levo-theme]");
    if (!this.themeCss) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.dataset.levoTheme = "";
      root.append(style);
    }
    if (style.textContent !== this.themeCss) style.textContent = this.themeCss;
  }

  private addEditListeners(root: ShadowRoot): void {
    if (this.editListenedRoots.has(root)) return;
    this.editListenedRoots.add(root);
    for (const type of SCENE_EDIT_EVENTS) {
      root.addEventListener(type, this.onRootEditEvent, { capture: true, passive: true });
    }
  }

  private removeEditListeners(root: ShadowRoot): void {
    if (!this.editListenedRoots.has(root)) return;
    this.editListenedRoots.delete(root);
    for (const type of SCENE_EDIT_EVENTS) {
      root.removeEventListener(type, this.onRootEditEvent, { capture: true });
    }
  }

  private applyHostAttributes(host: HTMLElement): void {
    for (const [name, value] of this.hostAttributes) host.setAttribute(name, value);
  }
}

export function createEngineAdapter(options: EngineAdapterOptions = {}): EngineAdapter {
  return new EngineAdapter(options);
}

// ---------------------------------------------------------------------------
// General arrange (current objects, not ZIP-only)
// ---------------------------------------------------------------------------

export interface ArrangeAllOptions {
  bedWidth: number;
  bedDepth: number;
  /** Objects that must not be moved; their plates are excluded from packing. */
  lockedIds?: ReadonlySet<number>;
  /** Defaults to the engine's real {@link PLATE_CAP}. */
  plateCap?: number;
  /** Currently selected plate, restored by undo. */
  selectedPlate?: number;
}

export interface ArrangeAllResult {
  ok: boolean;
  reason?: "engine-unavailable" | "no-objects";
  arrangedCount: number;
  lockedCount: number;
  platesUsed: number;
  overflowCount: number;
  oversizedCount: number;
  targetPlates: number[];
  plan: ArrangePlan | null;
  /**
   * Restores the scene exactly as it was before the arrangement (engine
   * snapshot restore). Null when the arrangement did not run.
   */
  undo: (() => boolean) | null;
}

const EMPTY_ARRANGE: Omit<ArrangeAllResult, "ok" | "reason"> = {
  arrangedCount: 0,
  lockedCount: 0,
  platesUsed: 0,
  overflowCount: 0,
  oversizedCount: 0,
  targetPlates: [],
  plan: null,
  undo: null,
};

/**
 * Arranges ALL current objects across plates (honest limits: at most
 * {@link PLATE_CAP} plates, rectangular bed, locked objects respected by
 * excluding their plates). The scene is captured first, so the returned
 * `undo` restores positions, plates, and selection exactly.
 *
 * Objects that cannot fit are left untouched and reported in `overflowCount`;
 * nothing is scaled or rotated to force a fit.
 */
export async function arrangeCurrentObjects(
  adapter: EngineAdapter,
  options: ArrangeAllOptions,
): Promise<ArrangeAllResult> {
  const api = adapter.api();
  if (!api) return { ok: false, reason: "engine-unavailable", ...EMPTY_ARRANGE };
  const snapshots = api.sceneSnapshot();
  if (!snapshots.length) return { ok: false, reason: "no-objects", ...EMPTY_ARRANGE };

  const selectedPlate = options.selectedPlate ?? 0;
  const captured = adapter.captureSceneState(selectedPlate);
  const lockedIds = options.lockedIds ?? new Set<number>();
  const plateCount = Math.max(1, adapter.currentPlateCount());

  const buildPlan = (plateCap: number): ArrangePlan => {
    const candidates: ArrangeCandidate[] = snapshots.map((snapshot) => {
      const footprint = snapshotFootprint(snapshot);
      const locked = lockedIds.has(snapshot.id);
      return {
        ...footprint,
        locked,
        plate: locked ? adapter.plateOfSnapshot(snapshot, plateCount) : undefined,
      };
    });
    return planGeneralArrangement(candidates, {
      bedWidth: options.bedWidth,
      bedDepth: options.bedDepth,
      plateCap,
    });
  };

  let plan = buildPlan(options.plateCap ?? PLATE_CAP);
  const highestPlate = plan.placements.reduce((highest, placement) => Math.max(highest, placement.plate), -1);
  if (highestPlate >= 0) {
    const achieved = await adapter.ensurePlateCount(highestPlate + 1);
    if (achieved < highestPlate + 1) {
      // The engine would not add enough plates — re-plan honestly within what
      // exists instead of placing objects on plates that are not there.
      plan = buildPlan(Math.max(1, achieved));
    }
  }

  for (const placement of plan.placements) {
    api.placeObjectOnPlate(placement.id, placement.plate, placement.offsetX, placement.offsetY);
  }
  if (plan.targetPlates.length) adapter.selectPlate(plan.targetPlates[0]);
  api.frame();
  if (plan.placements.length) adapter.notifySceneEdited();

  const result: ArrangeAllResult = {
    ok: true,
    arrangedCount: plan.placements.length,
    lockedCount: plan.lockedCount,
    platesUsed: plan.platesUsed,
    overflowCount: plan.overflowCount,
    oversizedCount: plan.oversizedCount,
    targetPlates: plan.targetPlates,
    plan,
    undo: captured ? () => adapter.restoreSceneState(captured) : null,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Auto-orient (BambuStudio's scoring, applied through the engine's own scene API)
// ---------------------------------------------------------------------------

export interface AutoOrientSceneOptions {
  /** Restrict to these ids; empty/omitted means every object. */
  ids?: ReadonlySet<number>;
  /** Objects that must not be touched. */
  lockedIds?: ReadonlySet<number>;
  /** The process preset's support threshold, in degrees. */
  overhangAngleDeg?: number;
  selectedPlate?: number;
}

export interface AutoOrientSceneResult {
  ok: boolean;
  reason?: "engine-unavailable" | "no-objects";
  /** Objects whose orientation actually changed. */
  orientedCount: number;
  /** Objects already in their best orientation — counted, never "fixed". */
  alreadyBestCount: number;
  /** Objects too small or too degenerate to measure. Left untouched. */
  skippedCount: number;
  lockedCount: number;
  /** True when a hull had to be approximated; the UI says so rather than not. */
  approximated: boolean;
  undo: (() => boolean) | null;
}

const EMPTY_ORIENT: Omit<AutoOrientSceneResult, "ok" | "reason"> = {
  orientedCount: 0,
  alreadyBestCount: 0,
  skippedCount: 0,
  lockedCount: 0,
  approximated: false,
  undo: null,
};

/**
 * Orients objects the way BambuStudio would, without asking the engine for a
 * capability it does not have.
 *
 * HOW IT REACHES THE SCENE. `sceneSnapshot()` hands back each object's raw
 * local triangles (`localPos`) plus live `THREE.Euler`/`Vector3` clones, and
 * `restoreScene()` copies those straight back onto the meshes. So the whole
 * feature is: measure the local geometry, write a new rotation, restore. No
 * engine patch, no new global.
 *
 * WHY THE ROTATION IS REPLACED, NOT COMPOSED. The score is computed from the
 * LOCAL mesh, so the answer is a property of the shape itself. Composing it
 * with whatever the user had already rotated to would make "auto-orient" mean
 * something different depending on history — press it twice and get two
 * different results. Replacing is what makes it idempotent.
 *
 * WHY THE OBJECT DOES NOT SINK. Re-seating is done by DIFFERENCE: the object
 * moves by (old lowest point − new lowest point), so whatever rule the engine
 * used to sit it on the bed still holds afterwards, without this code having to
 * know what that rule is.
 */
export function autoOrientObjects(
  adapter: EngineAdapter,
  options: AutoOrientSceneOptions = {},
): AutoOrientSceneResult {
  const api = adapter.api();
  if (!api) return { ok: false, reason: "engine-unavailable", ...EMPTY_ORIENT };
  const snapshots = api.sceneSnapshot();
  if (!snapshots.length) return { ok: false, reason: "no-objects", ...EMPTY_ORIENT };

  const captured = adapter.captureSceneState(options.selectedPlate ?? 0);
  const locked = options.lockedIds ?? new Set<number>();
  const wanted = options.ids;

  let orientedCount = 0;
  let alreadyBestCount = 0;
  let skippedCount = 0;
  let lockedCount = 0;
  let approximated = false;

  for (const snapshot of snapshots) {
    if (wanted && !wanted.has(snapshot.id)) continue;
    if (locked.has(snapshot.id)) {
      lockedCount++;
      continue;
    }
    const positions = snapshot.localPos;
    if (!(positions instanceof Float32Array) || positions.length < 36) {
      skippedCount++;
      continue;
    }
    const result = autoOrient(positions, { overhangAngleDeg: options.overhangAngleDeg });
    if (!result) {
      skippedCount++;
      continue;
    }
    if (result.hullFaces === 0) approximated = true;
    if (!result.improved) {
      alreadyBestCount++;
      continue;
    }

    const scale = { x: snapshot.scale.x, y: snapshot.scale.y, z: snapshot.scale.z };
    const before = lowestPoint(positions, { x: snapshot.rot.x, y: snapshot.rot.y, z: snapshot.rot.z }, scale);
    const after = lowestPoint(positions, result.euler, scale);
    // Plain assignment, not `.set(...)`: the DECLARED type is the minimal
    // LevoVector3, while the runtime object is a real THREE.Euler whose x/y/z
    // are accessors writing `_x`/`_y`/`_z`. Assignment satisfies both, and the
    // engine's `restoreScene` does `rotation.copy(rot)` — which reads `_x`, so
    // handing it a hand-rolled plain object would silently produce NaN.
    // tests/auto-orient.test.mjs pins that the engine really clones an Euler.
    snapshot.rot.x = result.euler.x;
    snapshot.rot.y = result.euler.y;
    snapshot.rot.z = result.euler.z;
    snapshot.pos.y += before - after;
    orientedCount++;
  }

  if (orientedCount) {
    api.restoreScene(snapshots);
    api.frame();
    adapter.notifySceneEdited();
  }

  return {
    ok: true,
    orientedCount,
    alreadyBestCount,
    skippedCount,
    lockedCount,
    approximated,
    undo: captured && orientedCount ? () => adapter.restoreSceneState(captured) : null,
  };
}

// ---------------------------------------------------------------------------
// Plane cut
// ---------------------------------------------------------------------------

export type CutKeep = "both" | "upper" | "lower";

export interface CutSceneOptions {
  /** Object to cut. Defaults to the engine's current selection. */
  id?: number;
  /** Height along `normal`, in the object's LOCAL millimetres. */
  offset: number;
  /** Defaults to the bed normal — the "cut it so it fits" case. */
  normal?: { x: number; y: number; z: number };
  keep?: CutKeep;
  cap?: boolean;
  selectedPlate?: number;
}

export interface CutSceneResult {
  ok: boolean;
  reason?: "engine-unavailable" | "no-object" | "not-cuttable" | "plane-missed";
  upperTriangles: number;
  lowerTriangles: number;
  cappedLoops: number;
  /** Cross-sections that could not be closed — the mesh had holes there. */
  openChains: number;
  skippedLoops: number;
  /** Ids the cut produced (one or two). */
  pieceIds: number[];
  undo: (() => boolean) | null;
}

const EMPTY_CUT: Omit<CutSceneResult, "ok" | "reason"> = {
  upperTriangles: 0,
  lowerTriangles: 0,
  cappedLoops: 0,
  openChains: 0,
  skippedLoops: 0,
  pieceIds: [],
  undo: null,
};

/** The bed normal in the engine's frame. */
const BED_UP = { x: 0, y: 1, z: 0 };

/**
 * Cuts one object into two and puts both back on the bed.
 *
 * SAME MECHANISM AS AUTO-ORIENT, ONE STEP FURTHER. `restoreScene` does not only
 * re-apply transforms: it DELETES entries missing from the list and CREATES
 * entries whose id it has never seen, building them from `localPos`. So a cut
 * is expressible as a single restore — drop the original, add two objects with
 * new geometry — with no engine change and no new global.
 *
 * THE HEIGHT IS LOCAL. `offset` is measured in the object's own space along
 * `normal`, because that is the space `localPos` is in and the space the
 * cut-height control shows. Rotation and scale are carried to both pieces
 * unchanged, so a cut object stays where it was.
 */
export function cutObject(adapter: EngineAdapter, options: CutSceneOptions): CutSceneResult {
  const api = adapter.api();
  if (!api) return { ok: false, reason: "engine-unavailable", ...EMPTY_CUT };
  const snapshots = api.sceneSnapshot();
  if (!snapshots.length) return { ok: false, reason: "no-object", ...EMPTY_CUT };

  const wantedId = options.id ?? api.selectedObjectId() ?? snapshots[0].id;
  const target = snapshots.find((s) => s.id === wantedId);
  if (!target) return { ok: false, reason: "no-object", ...EMPTY_CUT };
  const positions = target.localPos;
  if (!(positions instanceof Float32Array) || positions.length < 36) {
    return { ok: false, reason: "not-cuttable", ...EMPTY_CUT };
  }

  const normal = options.normal ?? BED_UP;
  const plane: CutPlane = { normal, offset: options.offset };
  const result = cutByPlane(positions, plane, { cap: options.cap !== false });
  if (!result) return { ok: false, reason: "not-cuttable", ...EMPTY_CUT };
  if (!result.upperTriangles || !result.lowerTriangles) {
    // The plane missed the model. Saying so beats silently doing nothing, and
    // beats "cutting" it into one piece and an empty one.
    return { ok: false, reason: "plane-missed", ...EMPTY_CUT, ...{
      upperTriangles: result.upperTriangles,
      lowerTriangles: result.lowerTriangles,
    } };
  }

  const captured = adapter.captureSceneState(options.selectedPlate ?? 0);
  const keep = options.keep ?? "both";

  // Ids the engine has never issued, so `restoreScene` creates rather than
  // re-applies. Derived from the highest live id, not from a clock, so the
  // result is deterministic and a test can predict it.
  const highest = snapshots.reduce((max, s) => Math.max(max, s.id), 0);
  const pieces: Array<{ id: number; name: string; localPos: Float32Array }> = [];
  if (keep !== "upper") {
    pieces.push({ id: highest + 1, name: `${target.name} (A)`, localPos: result.lower });
  }
  if (keep !== "lower") {
    pieces.push({ id: highest + 2, name: `${target.name} (B)`, localPos: result.upper });
  }

  const scale = { x: target.scale.x, y: target.scale.y, z: target.scale.z };
  const baseLowest = lowestPoint(positions, { x: target.rot.x, y: target.rot.y, z: target.rot.z }, scale);

  const entries = snapshots.filter((s) => s.id !== target.id) as LevoSceneSnapshot[];
  for (const piece of pieces) {
    const pieceLowest = lowestPoint(piece.localPos, { x: target.rot.x, y: target.rot.y, z: target.rot.z }, scale);
    entries.push({
      ...target,
      id: piece.id,
      name: piece.name,
      localPos: piece.localPos,
      /*
       * Each piece keeps the original's placement, dropped by however much its
       * own lowest point differs — the same difference rule auto-orient uses,
       * so neither half sinks into the bed or floats above it.
       *
       * A PLAIN OBJECT IS CORRECT HERE, unlike `rot`. The engine does
       * `position.copy(pos)`, and Vector3.copy reads `.x/.y/.z`; Euler.copy
       * reads `_x/_y/_z`, which is why the rotation is shared from the
       * original rather than rebuilt. Both pieces need their OWN position, so
       * this cannot be shared.
       *
       * The two pieces start on top of each other. That is deliberate: the
       * shell's own `seatNewObjects` sees two ids it has not placed before and
       * seats them on the next scene event, which is the one code path that
       * knows the bed and the other objects on it.
       */
      pos: { x: target.pos.x, y: target.pos.y + (baseLowest - pieceLowest), z: target.pos.z },
    } as LevoSceneSnapshot);
  }

  api.restoreScene(entries);
  api.frame();
  adapter.notifySceneEdited();

  return {
    ok: true,
    upperTriangles: result.upperTriangles,
    lowerTriangles: result.lowerTriangles,
    cappedLoops: result.cappedLoops,
    openChains: result.openChains,
    skippedLoops: result.skippedLoops,
    pieceIds: pieces.map((p) => p.id),
    undo: captured ? () => adapter.restoreSceneState(captured) : null,
  };
}

/** Where a cut may sit: the object's own extent along `normal`, in local mm. */
export function cutRange(
  adapter: EngineAdapter,
  id?: number,
  normal: { x: number; y: number; z: number } = BED_UP,
): { min: number; max: number; id: number } | null {
  const api = adapter.api();
  if (!api) return null;
  const snapshots = api.sceneSnapshot();
  if (!snapshots.length) return null;
  const wantedId = id ?? api.selectedObjectId() ?? snapshots[0].id;
  const target = snapshots.find((s) => s.id === wantedId);
  if (!target || !(target.localPos instanceof Float32Array)) return null;
  return { ...extentAlong(target.localPos, normal), id: target.id };
}

// ---------------------------------------------------------------------------
// Seating newly spawned objects (duplicate / paste / canvas drop)
// ---------------------------------------------------------------------------

export interface SeatNewObjectsOptions {
  /** Ids that appeared in this transition — the objects to seat. */
  newIds: readonly number[];
  bedWidth: number;
  bedDepth: number;
  /** Plate tabs that currently exist. */
  plateCount: number;
  /** Plate the user is looking at; the preferred home for the new objects. */
  selectedPlate: number;
  /**
   * The object the copies came from. Defaults to the engine's current
   * selection, which duplicate/paste leave on the source. The nearest free
   * spot to this object wins, so a copy lands beside its original.
   */
  sourceId?: number | null;
}

export interface SeatNewObjectsResult {
  ok: boolean;
  reason?: "engine-unavailable" | "no-new-objects" | "restored-layout";
  /** Objects moved into free space. */
  seatedCount: number;
  /**
   * Objects that fit nowhere on any existing plate. They are LEFT where the
   * engine put them and reported — never scaled, rotated or stacked to fit.
   */
  unseatedCount: number;
}

const NOTHING_SEATED: Omit<SeatNewObjectsResult, "ok" | "reason"> = { seatedCount: 0, unseatedCount: 0 };

/**
 * Puts objects the engine has just spawned into real free space.
 *
 * The engine seats them from a cursor that only grows (see the header of
 * spawn-seating.ts for the verbatim code), so by the third or fourth copy the
 * new object is well past the edge of the bed while the space beside the
 * original is empty. This recomputes the position from the actual scene and
 * moves the copy there through the engine's own `placeObjectOnPlate`.
 *
 * Only the new objects move. Nothing that was already on the bed is touched —
 * this is not an arrange, and a user who has carefully positioned a plate does
 * not lose that layout because they pressed Duplicate.
 */
export function seatNewObjects(
  adapter: EngineAdapter,
  options: SeatNewObjectsOptions,
): SeatNewObjectsResult {
  const api = adapter.api();
  if (!api) return { ok: false, reason: "engine-unavailable", ...NOTHING_SEATED };
  const newIds = new Set(options.newIds);
  if (!newIds.size) return { ok: false, reason: "no-new-objects", ...NOTHING_SEATED };

  const snapshots = api.sceneSnapshot();
  if (!snapshots.length) return { ok: false, reason: "no-new-objects", ...NOTHING_SEATED };

  const plateCount = Math.max(1, Math.min(PLATE_CAP, options.plateCount || 1));
  const preferredPlate = Math.max(0, Math.min(plateCount - 1, options.selectedPlate || 0));

  // Plate-relative offsets, in the same convention placeObjectOnPlate takes:
  // model mm from the plate centre, +Y = depth (three -z).
  const relative = (snapshot: LevoSceneSnapshot, plate: number) => {
    const centre = api.platePos(plate);
    return { offsetX: snapshot.pos.x - centre.x, offsetY: -(snapshot.pos.z - centre.z) };
  };

  const occupied: SeatedFootprint[] = [];
  const requests: SeatRequest[] = [];
  let near: { x: number; y: number } | null = null;
  /**
   * True when every new object is still sitting where the engine's spawn
   * cursor put it. See the check below — this is what tells a spawn from a
   * restore no matter which route created the objects.
   */
  let allOnSpawnRow = true;

  let sourceId = options.sourceId ?? null;
  if (sourceId === null || sourceId === undefined) {
    try {
      sourceId = api.selectedObjectId?.() ?? null;
    } catch {
      sourceId = null;
    }
  }

  for (const snapshot of snapshots) {
    const footprint = snapshotFootprint(snapshot);
    if (newIds.has(snapshot.id)) {
      requests.push({ id: snapshot.id, width: footprint.width, depth: footprint.depth });
      // THE ROUTE-INDEPENDENT GUARD. The engine's spawn cursor always places a
      // new object at `platePos(plate).z` exactly — it only ever steps along X
      // (`_e.position.set(Mt.x + l.current + Ke / 2, 0, Mt.z)`). Anything
      // positioned deliberately — a project's own layout applied through
      // placeObjectOnPlate, an undo through restoreScene — generally is not on
      // that row.
      //
      // This matters because the shell is not the only way objects appear. The
      // engine renders its own `open-file`, `ctx-open` and `empty-pick`
      // controls straight into the same hidden file input, so a .3mf opened
      // through ANY of those never passes through the shell's import path and
      // cannot arm the shell's restore latch. Asking where the objects
      // actually are needs no such cooperation.
      //
      // One object off the row condemns the whole transition: a restore is
      // all-or-nothing, and seating half of a project's objects would be worse
      // than seating none.
      const plate = adapter.plateOfSnapshot(snapshot, plateCount);
      if (Math.abs(relative(snapshot, plate).offsetY) > 0.01) allOnSpawnRow = false;
      continue;
    }
    const plate = adapter.plateOfSnapshot(snapshot, plateCount);
    const { offsetX, offsetY } = relative(snapshot, plate);
    occupied.push({ id: snapshot.id, plate, offsetX, offsetY, width: footprint.width, depth: footprint.depth });
    if (sourceId !== null && snapshot.id === sourceId && plate === preferredPlate) {
      near = { x: offsetX, y: offsetY };
    }
  }

  if (!requests.length) return { ok: false, reason: "no-new-objects", ...NOTHING_SEATED };
  if (!allOnSpawnRow) return { ok: false, reason: "restored-layout", ...NOTHING_SEATED };

  const availablePlates: number[] = [];
  for (let plate = 0; plate < plateCount; plate += 1) availablePlates.push(plate);

  const plan = planSeats(requests, occupied, {
    bedWidth: options.bedWidth,
    bedDepth: options.bedDepth,
    preferredPlate,
    availablePlates,
    nearOffsetX: near?.x ?? 0,
    nearOffsetY: near?.y ?? 0,
  });

  for (const seat of plan.seats) {
    api.placeObjectOnPlate(seat.id, seat.plate, seat.offsetX, seat.offsetY);
  }
  if (plan.seats.length) adapter.notifySceneEdited();

  return { ok: true, seatedCount: plan.seats.length, unseatedCount: plan.unseated.length };
}
