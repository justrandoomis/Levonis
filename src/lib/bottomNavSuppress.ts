/**
 * A FULL-SCREEN FLOW HIDES THE BOTTOM NAV WHILE IT IS OPEN.
 *
 * The floating nav is placed by ROUTE (src/components/BottomNav.tsx
 * `isBottomNavHidden`), and a flow that takes the whole screen without a
 * route of its own — the print-request wizard at /requests, with its own
 * action bar under the thumb — had the nav drawn over that bar on a phone
 * (review of Levo Community, 2026-09-28). A flow calls
 * `useSuppressBottomNav()` while it is mounted; the nav and the page's bottom
 * clearance read `useBottomNavSuppressed()`. A count, not a flag, so two
 * flows open at once both have to close.
 */
import { useEffect, useSyncExternalStore } from 'react';

let count = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Hide the nav until the returned function is called (once). */
export function suppressBottomNav(): () => void {
  count += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count = Math.max(0, count - 1);
    emit();
  };
}

/** Hide the nav while the calling component is mounted (and `active`). */
export function useSuppressBottomNav(active = true): void {
  useEffect(() => (active ? suppressBottomNav() : undefined), [active]);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function isBottomNavSuppressed(): boolean {
  return count > 0;
}

/** Whether some open flow asked for the nav to step aside. */
export function useBottomNavSuppressed(): boolean {
  return useSyncExternalStore(subscribe, isBottomNavSuppressed, () => false);
}
