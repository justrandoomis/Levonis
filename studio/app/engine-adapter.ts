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

  private scanExistingRoots(scope: ParentNode): void {
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
