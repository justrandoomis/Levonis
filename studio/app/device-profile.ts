/**
 * Which browser this Studio session is running in, and what that costs.
 *
 * WHY THIS EXISTS — the measurement, not a guess.
 *
 * three-slicer's threaded kernel is not "a bit heavier". Read the glue it
 * ships (node_modules/three-slicer/engine/src/slicer_core.mt.js):
 *
 *     var INITIAL_MEMORY = 16777216
 *     wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true })
 *
 *     var pthreadPoolSize = navigator.hardwareConcurrency || 4
 *     while (pthreadPoolSize--) PThread.allocateUnusedWorker()
 *     addOnPreRun(async () => { … await PThread.loadWasmModuleToAllWorkers() … })
 *
 * `maximum: 65536` pages is a 4 GiB SHARED reservation, and the pool spawns
 * one extra Worker per logical core and instantiates the 5 MB module in every
 * one of them BEFORE the kernel reports ready. On a phone that is the whole
 * budget, spent before a single triangle is on the bed.
 *
 * Two of those three costs are now paid somewhere else, and this comment is
 * the map: the pool size is capped at two by
 * `patches/three-slicer+0.2.2.patch`, and the 4 GiB reservation is cut to
 * 1 GiB on handhelds by the `singleKernel` transform in `vite.config.ts` —
 * which also stops the build emitting the 6.24 MB kernel twice. What is left
 * for this module is the third: whether the kernel is compiled at all before
 * the user asks for a slice.
 *
 * And the viewer asks for exactly that at MOUNT:
 *
 *     De(() => { if (q !== !1) try { D().postMessage({ cmd: "warmup", … }) } catch {} }, [])
 *
 * (`q` is `features.warmup`, verified in viewer/dist/Viewport.js.) The engine's
 * own worker comment says the same: "Warmup: only load the kernel (+ spawn the
 * mt pthread pool) ahead of time".
 *
 * That is the crash the owner photographed — "Worker terminated (likely out of
 * memory): worker error" on a project with NOTHING loaded. Nothing was loaded
 * because loading was never what cost the memory; opening the page was.
 *
 * So this module decides one thing: whether this device should pay the kernel
 * up front. It does not disable slicing, threads, or any feature — a
 * constrained device still loads the exact same kernel, the moment it actually
 * slices, and `features.warmup` is the engine's own documented opt-out
 * ("Off, nothing is downloaded or compiled until something actually slices").
 *
 * `classifyDevice` is pure and takes explicit signals so tests/device-profile
 * .test.mjs can pin every rule; `readDeviceSignals` is the only browser part.
 */

export interface DeviceSignals {
  userAgent: string;
  /** navigator.deviceMemory in GiB (Chromium only), or null where unavailable. */
  deviceMemoryGb: number | null;
  /** navigator.hardwareConcurrency, or null where unavailable. */
  hardwareConcurrency: number | null;
  /** True when the device has a coarse pointer and no fine one (touch-only). */
  coarsePointerOnly: boolean;
  /** Shorter screen side in CSS pixels, or null when unknown. */
  screenShortSideCss: number | null;
}

/** Why a device was classified as constrained. Diagnostics only — never invented. */
export type DeviceConstraintReason =
  | "ios"
  | "apple-webkit"
  | "android-phone"
  | "low-device-memory"
  | "touch-only-small-screen";

export interface DeviceProfile {
  /**
   * True when the engine's WASM kernel must NOT be loaded until a slice is
   * actually requested, and the slice worker should be released once idle.
   */
  memoryConstrained: boolean;
  reasons: DeviceConstraintReason[];
  /** Autosave debounce for this device (ms). See the comment on the constants. */
  autosaveDebounceMs: number;
  /** How long the slice worker may sit idle before it is released (ms). */
  idleWorkerReleaseMs: number | null;
}

/**
 * A constrained device saves less often, because a save is not cheap: it is a
 * full engine 3MF export plus a canvas read-back plus a SHA-256 over the whole
 * file. 2.5 s is right on a desktop and is a stutter every few seconds on a
 * phone holding a 20 MB model.
 */
const DESKTOP_AUTOSAVE_DEBOUNCE_MS = 2_500;
const CONSTRAINED_AUTOSAVE_DEBOUNCE_MS = 9_000;

/**
 * Long enough that the normal slice → look at preview → slice again loop keeps
 * its warm kernel, short enough that a tab left open on a phone is not holding
 * a pthread pool and a grown WASM heap while the user is in another app.
 */
const IDLE_WORKER_RELEASE_MS = 45_000;

/** Below this many GiB of reported RAM, the threaded kernel's reservation dominates. */
const LOW_DEVICE_MEMORY_GB = 4;

/**
 * Touch-only devices at or below this shorter-side CSS width are phones and
 * small tablets. A desktop with a touchscreen also reports a coarse pointer,
 * which is why the size test is ANDed with it and not used alone.
 */
const SMALL_SCREEN_SHORT_SIDE_CSS = 820;

/**
 * iOS and iPadOS, including iPadOS Safari's desktop-class user agent, which
 * claims Macintosh. This mirrors worker/platform.ts#isMemoryConstrainedApple
 * deliberately — that one decides a RESPONSE HEADER from a UA string and
 * nothing else, this one decides a client-side behaviour and has richer
 * signals available. They are kept as two functions, in two layers, rather
 * than one shared predicate that would have to pretend the two jobs are the
 * same. tests/platform.test.mjs pins that one; tests/device-profile.test.mjs
 * pins this one, including the case where the two disagree.
 */
function appleReason(userAgent: string): DeviceConstraintReason | null {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (
    /Macintosh/i.test(userAgent)
    && /Version\/\d+.*Safari/i.test(userAgent)
    && !/Chrome|Chromium|Firefox/i.test(userAgent)
  ) {
    // A real Mac on Safari is indistinguishable from a desktop-mode iPad here.
    // On a Mac this costs one deferred kernel load before the first slice; on
    // an iPad, guessing the other way costs the session.
    return "apple-webkit";
  }
  return null;
}

export function classifyDevice(signals: DeviceSignals): DeviceProfile {
  const reasons: DeviceConstraintReason[] = [];
  const userAgent = signals.userAgent || "";

  const apple = appleReason(userAgent);
  if (apple) reasons.push(apple);

  // An Android PHONE. Android tablets and Chromebooks omit the `Mobile` token
  // and keep the eager kernel: they generally have the headroom, and taking it
  // away from them would cost load-time responsiveness for nothing.
  if (/Android/i.test(userAgent) && /Mobile/i.test(userAgent)) reasons.push("android-phone");

  if (typeof signals.deviceMemoryGb === "number" && signals.deviceMemoryGb <= LOW_DEVICE_MEMORY_GB) {
    reasons.push("low-device-memory");
  }

  if (
    signals.coarsePointerOnly
    && typeof signals.screenShortSideCss === "number"
    && signals.screenShortSideCss <= SMALL_SCREEN_SHORT_SIDE_CSS
  ) {
    reasons.push("touch-only-small-screen");
  }

  const memoryConstrained = reasons.length > 0;
  return {
    memoryConstrained,
    reasons,
    autosaveDebounceMs: memoryConstrained ? CONSTRAINED_AUTOSAVE_DEBOUNCE_MS : DESKTOP_AUTOSAVE_DEBOUNCE_MS,
    idleWorkerReleaseMs: memoryConstrained ? IDLE_WORKER_RELEASE_MS : null,
  };
}

/** Reads the live browser signals. Returns neutral values off the browser. */
export function readDeviceSignals(): DeviceSignals {
  if (typeof navigator === "undefined") {
    return {
      userAgent: "",
      deviceMemoryGb: null,
      hardwareConcurrency: null,
      coarsePointerOnly: false,
      screenShortSideCss: null,
    };
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const deviceMemory = typeof nav.deviceMemory === "number" && Number.isFinite(nav.deviceMemory)
    ? nav.deviceMemory
    : null;
  const cores = typeof nav.hardwareConcurrency === "number" && Number.isFinite(nav.hardwareConcurrency)
    ? nav.hardwareConcurrency
    : null;

  let coarsePointerOnly = false;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      coarsePointerOnly = window.matchMedia("(pointer: coarse)").matches
        && !window.matchMedia("(any-pointer: fine)").matches;
    } catch {
      coarsePointerOnly = false;
    }
  }

  let screenShortSideCss: number | null = null;
  if (typeof window !== "undefined" && window.screen) {
    const width = Number(window.screen.width);
    const height = Number(window.screen.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      screenShortSideCss = Math.min(width, height);
    }
  }

  return {
    userAgent: nav.userAgent || "",
    deviceMemoryGb: deviceMemory,
    hardwareConcurrency: cores,
    coarsePointerOnly,
    screenShortSideCss,
  };
}

/** The live device profile. Cheap; the shell reads it once per mount. */
export function currentDeviceProfile(): DeviceProfile {
  return classifyDevice(readDeviceSignals());
}
