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
 *   blocked   runPreflight found a blocker, or the engine rejected the last
 *             result as over the bed — danger, never success;
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

export type ReadinessKind = "ready" | "sliced" | "stale" | "blocked" | "fallback";
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
}

export function readinessOf(input: ReadinessInput): ReadinessKind | null {
  if (input.objectCount <= 0) return null;
  if (input.importing || !input.engineReady || input.profileLoading || input.slicing || input.errored) return null;
  if (!input.preflightOk || input.resultState === "rejected-over-bed") return "blocked";
  if (input.resultState === "stale") return "stale";
  if (!input.profileVerified) return "fallback";
  if (input.resultState === "fresh") return "sliced";
  return "ready";
}

export function toneOf(kind: ReadinessKind): ReadinessTone {
  if (kind === "blocked") return "danger";
  if (kind === "stale" || kind === "fallback") return "warning";
  return "success";
}
