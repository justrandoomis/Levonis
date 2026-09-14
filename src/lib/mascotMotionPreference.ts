/** External preference store shared by the persistent shell and its SVG.
 * React must subscribe to changes, not capture an initial media-query value.
 * This store has no animation timers and never replaces the mascot instance.
 */
export interface MotionPreferenceQuery {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

export function createMotionPreferenceStore(readQuery: () => MotionPreferenceQuery | null) {
  const listeners = new Set<() => void>();
  let query: MotionPreferenceQuery | null = null;
  let detach: (() => void) | null = null;
  const current = () => (query ??= readQuery());
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    snapshot: () => current()?.matches ?? false,
    serverSnapshot: () => false,
    subscribe(listener: () => void) {
      // Subscription identity stays independent, including repeated callbacks.
      const subscription = () => listener();
      listeners.add(subscription);
      const media = current();
      if (listeners.size === 1 && media) {
        if (media.addEventListener && media.removeEventListener) {
          media.addEventListener('change', notify);
          detach = () => media.removeEventListener?.('change', notify);
        } else if (media.addListener && media.removeListener) {
          media.addListener(notify);
          detach = () => media.removeListener?.(notify);
        }
      }
      return () => {
        if (!listeners.delete(subscription) || listeners.size) return;
        detach?.();
        detach = null;
        query = null;
      };
    },
  };
}

export const mascotMotionPreference = createMotionPreferenceStore(() =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null,
);
