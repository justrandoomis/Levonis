import { useSyncExternalStore } from 'react';
import { mascotMotionPreference } from '../../lib/mascotMotionPreference';

/** Both the measured travel layer and SVG react to OS changes while mounted. */
export function useMascotReducedMotion(): boolean {
  return useSyncExternalStore(
    mascotMotionPreference.subscribe,
    mascotMotionPreference.snapshot,
    mascotMotionPreference.serverSnapshot,
  );
}
