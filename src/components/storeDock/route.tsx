/**
 * The store dock's two tiny pieces the app shell needs on every store visit,
 * kept out of the dock's own chunk so the main site's entry does not grow by
 * the dock (src/components/storeDock/StoreDock.tsx, loaded lazily there).
 */

/**
 * The store-host pages that wear the dock: the shop's own pages. A product page
 * (`/p/…`) draws its own, with the buy controls; the platform's pages (cart,
 * checkout, orders, sign-in, the workspace) keep the shell's top strip.
 */
export function storeDockRoute(pathname: string): boolean {
  const p = pathname.toLowerCase();
  if (p.startsWith('/p/')) return false;
  return !['/cart', '/checkout', '/store-checkout', '/orders', '/admin', '/auth', '/model-viewer'].some((x) => p === x || p.startsWith(`${x}/`));
}

/** The room a page leaves at its end so the dock never covers its last line. */
export function StoreDockSpacer() {
  return <div aria-hidden="true" data-store-dock-spacer className="shrink-0" style={{ height: 'calc(var(--lv-home-hit) + max(0.625rem, env(safe-area-inset-bottom)) + 24px)' }} />;
}

export const STORE_DOCK_MULTI_TAP_MS = 700;
export const STORE_DOCK_TAPS_FOR_REPORT = 3;

const tapRun = { count: 0, at: 0 };

/**
 * One tap in the run; true when this tap is the one that reports. Module state
 * on purpose: the first tap on a product page navigates to the store's home,
 * which mounts another dock, and the count must carry over to it.
 */
export function countDockTap(now: number, run = tapRun): boolean {
  run.count = now - run.at <= STORE_DOCK_MULTI_TAP_MS ? run.count + 1 : 1;
  run.at = now;
  if (run.count >= STORE_DOCK_TAPS_FOR_REPORT) {
    // The run ends here: a fourth tap starts a new one instead of re-opening the sheet.
    run.count = 0;
    run.at = 0;
    return true;
  }
  return false;
}

