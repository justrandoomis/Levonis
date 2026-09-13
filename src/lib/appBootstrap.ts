/**
 * Tiny external store for the one piece of page readiness the app shell
 * cannot know by itself: when Home's critical request has settled.  It is
 * module-scoped on purpose. SPA navigation does not reset it, while a hard
 * reload creates a fresh module and therefore a fresh bootstrap sequence.
 */
let homeCriticalReady = false;
const listeners = new Set<() => void>();

export const homeCriticalReadyStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot() {
    return homeCriticalReady;
  },
  serverSnapshot() {
    return false;
  },
};

export function markHomeCriticalReady(): void {
  if (homeCriticalReady) return;
  homeCriticalReady = true;
  for (const listener of listeners) listener();
}

