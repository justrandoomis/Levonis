/**
 * WHAT THE READINESS BANNER MAY SAY, DECIDED IN ONE PURE FUNCTION.
 *
 * The reference shows a green «جاهز للتقطيع» under every model. Shown
 * unconditionally that line would be a lie whenever the model does not fit
 * the printer, the result on screen is outdated, or the printer's presets are
 * missing from the engine (R9 in the plan, the README's honesty rule). So the
 * banner is derived from the real state, in this order:
 *
 *   hidden    nothing to judge yet: no model, a file still importing, the
 *             engine or the printer profile still loading, a slice running
 *             (the gold button shows its progress), or an engine error (the
 *             message row above the card says it);
 *   empty     the CURRENT plate has no visible model while another plate
 *             has one. The slice and the export act on the current plate
 *             only, and the engine refuses that slice («Plate 2 has no
 *             objects»), so «جاهز للتقطيع» there was a promise it could not
 *             keep — warning, saying to switch plates or add a model;
 *   blocked   runPreflight found a blocker, a model sits outside the bed
 *             (wholly or in part: the engine refuses that slice, so a
 *             success before it would be a promise it cannot keep), or the
 *             engine rejected the last result as over the bed — danger,
 *             never success. Its title names the real cause: «أكبر من حجم
 *             الطابعة» only when a model is too big, «خارج حدود سطح الطباعة»
 *             when the models fit and are only misplaced;
 *   stale     a result exists but the scene or the settings changed since —
 *             warning, and the G-code tile is disabled;
 *   fallback  the engine is missing a preset for this printer, so generic
 *             settings are in use — warning, naming the missing presets;
 *   sliced    a fresh result for the current plate — success;
 *   ready     none of the above — success, «جاهز للتقطيع».
 *
 * tests/studio-mode.test.mjs walks the whole table, including the cases where
 * a success would be easy to show by mistake.
 */

export type ReadinessKind = "ready" | "sliced" | "stale" | "blocked" | "fallback" | "empty";
export type ReadinessTone = "success" | "warning" | "danger";

export interface ReadinessInput {
  objectCount: number;
  importing: boolean;
  engineReady: boolean;
  profileLoading: boolean;
  /** False when the loader fell back to generic settings for a missing preset. */
  profileVerified: boolean;
  slicing: boolean;
  /** An engine or import error is showing in the message row. */
  errored: boolean;
  resultState: "none" | "fresh" | "stale" | "rejected-over-bed";
  /** runPreflight's verdict: false when it found a blocker. */
  preflightOk: boolean;
  /**
   * Models whose footprint leaves the bed of their plate (model-dimensions
   * objectsOffBed). Optional so that a caller written before the placement
   * check reads as "nothing known to be off the bed".
   */
  offBedCount?: number;
  /**
   * Visible models on the CURRENT plate, the one the slice acts on. Optional:
   * a caller that cannot place the models on plates (no scene snapshot yet)
   * leaves it out, and the plate is not judged empty.
   */
  plateObjectCount?: number;
}

export function readinessOf(input: ReadinessInput): ReadinessKind | null {
  if (input.objectCount <= 0) return null;
  if (input.importing || !input.engineReady || input.profileLoading || input.slicing || input.errored) return null;
  if (input.plateObjectCount !== undefined && input.plateObjectCount <= 0) return "empty";
  if (!input.preflightOk || (input.offBedCount ?? 0) > 0 || input.resultState === "rejected-over-bed") return "blocked";
  if (input.resultState === "stale") return "stale";
  if (!input.profileVerified) return "fallback";
  if (input.resultState === "fresh") return "sliced";
  return "ready";
}

export function toneOf(kind: ReadinessKind): ReadinessTone {
  if (kind === "blocked") return "danger";
  if (kind === "stale" || kind === "fallback" || kind === "empty") return "warning";
  return "success";
}

/**
 * The banner title, as a key of the Studio dictionary.
 *
 * A blocked state has two causes and they need different words. A model
 * larger than the printer gets «أكبر من حجم الطابعة» (tooBigTitle). Every
 * other block is about WHERE the models are: a model dragged off the bed,
 * or a result the engine rejected as over the bed when every model fits.
 * Calling an 8 mm tower «أكبر من حجم الطابعة» because it sits beside the
 * bed is a false claim about the model, so those get «خارج حدود سطح
 * الطباعة» (outsideBedTitle).
 */
export type ReadinessTitleKey = "readyToSlice" | "printReady" | "stale" | "presetFallbackTitle" | "emptyPlateTitle" | "tooBigTitle" | "outsideBedTitle";

export function readinessTitleKey(kind: ReadinessKind, oversizedCount: number): ReadinessTitleKey {
  if (kind === "ready") return "readyToSlice";
  if (kind === "sliced") return "printReady";
  if (kind === "stale") return "stale";
  if (kind === "fallback") return "presetFallbackTitle";
  if (kind === "empty") return "emptyPlateTitle";
  return oversizedCount > 0 ? "tooBigTitle" : "outsideBedTitle";
}
