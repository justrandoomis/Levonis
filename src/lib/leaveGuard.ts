/**
 * LEAVING A SCREEN THAT HOLDS UNSAVED WORK ASKS FIRST — WHEREVER THE WAY OUT IS.
 *
 * The product form's own «رجوع» and the browser's unload already asked; the
 * dashboard's sidebar did not, so a click on «نظرة عامة» (or on «التسعير
 * والشحن», which the pricing panel itself points at) closed the form and the
 * owner's typed pricing with it, without a word (verifier F3, 2026-10-10).
 *
 * One screen at a time registers the question it must ask; the dashboard asks
 * it before switching tab. The guard returns true to let the owner go.
 * Module state, never storage: nothing here outlives the page.
 */
type LeaveGuard = () => boolean;

let current: LeaveGuard | null = null;

/** Registers the screen's question; the returned function takes it away (only if it is still the current one). */
export function setLeaveGuard(guard: LeaveGuard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

/** May the dashboard leave the current screen? Asks the registered question, if any. */
export function mayLeave(): boolean {
  if (!current) return true;
  try {
    return current();
  } catch {
    return true;
  }
}
