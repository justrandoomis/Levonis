/**
 * ONE WAY TO ASK THE VIEWPORT A QUESTION.
 *
 * The same `(max-width: 639px)` hook was written four times — NotificationBell,
 * PurchaseConfirm, farm/hooks/usePhone and DashboardLayout's 1024px copy — each
 * with its own `useState` + `useEffect` pair. That shape has a real defect as
 * well as a maintenance cost: it answers `false` (or whatever the initial state
 * guessed) for one render and corrects itself in an effect, so a phone can
 * paint the desktop branch for a frame before swapping to the sheet.
 *
 * `useSyncExternalStore` reads `matchMedia` DURING render, so the first paint
 * is already the right branch, and React re-renders exactly when the query
 * flips — no effect, no flash, no tearing between two components that ask the
 * same question. The MediaQueryList is cached per query string, so a list of
 * fifty rows asking "is this a phone?" creates one listener target, not fifty.
 *
 * Existing callers keep their own hooks for now (the brief for this wave says
 * not to rewrite them); new code uses these.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** Under Tailwind's `sm` — the width at which a panel becomes a bottom sheet. */
export const PHONE_QUERY = '(max-width: 639px)';
/** A mouse or a trackpad: hover exists, and a small target can be hit. */
export const POINTER_FINE_QUERY = '(pointer: fine)';

const lists = new Map<string, MediaQueryList>();

function list(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  let mq = lists.get(query);
  if (!mq) {
    mq = window.matchMedia(query);
    lists.set(query, mq);
  }
  return mq;
}

/** True while `query` matches. Server-safe: answers false where there is no window. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const mq = list(query);
      if (!mq) return () => {};
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => list(query)?.matches ?? false,
    () => false
  );
}

/** Phone width: panels become bottom sheets, lists become cards. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** A precise pointer: menus may anchor to their trigger and density may tighten. */
export function usePointerFine(): boolean {
  return useMediaQuery(POINTER_FINE_QUERY);
}
