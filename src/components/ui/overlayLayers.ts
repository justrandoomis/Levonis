/** One documented stacking contract for the app chrome and every floating UI. */
export const UI_LAYERS = Object.freeze({
  header: 100,
  bottomNav: 120,
  popover: 160,
  overlay: 200,
  /** Above every window a caller can open (legacy z values lift to 200–260),
   *  and below AppBusy's blocking layer at overlay + 100. `--z-toast` in CSS. */
  toast: 280,
});

/**
 * Old callers passed local z-values such as 50/60. Those values made sense
 * inside their page but sat below the global bottom navigation. Preserve their
 * relative ordering while lifting every real overlay above app chrome.
 */
export function overlayLayer(z: number): number {
  return z < UI_LAYERS.overlay ? UI_LAYERS.overlay + Math.max(0, z) : z;
}

