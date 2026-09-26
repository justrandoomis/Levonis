import React, { Suspense, useState, useSyncExternalStore } from 'react';
import { compareTray } from '../../lib/compareTray';

/**
 * THE TRAY'S DOOR — the only compare code in the entry chunk besides the store.
 *
 * It renders nothing, and downloads nothing, until the tray first holds a
 * product (CATALOG_DISCOVERY §12: the tray is «lazy-mounted the first time it
 * becomes non-empty»). From then on it keeps the tray chunk mounted for the
 * visit, so the «تراجع» of a cleared tray, the «full» toast and the
 * type-conflict dialog always have somewhere to appear.
 *
 * A failed chunk (a deploy mid-visit, a dropped connection) renders nothing
 * rather than taking the page down: the tray is a convenience, never a gate.
 */
const CompareTray = React.lazy(() =>
  import('./CompareTray').catch(() => ({ default: () => null }))
);

export default function CompareTrayGate() {
  const count = useSyncExternalStore(
    compareTray.subscribe,
    () => compareTray.getSnapshot().items.length,
    () => 0
  );
  const [armed, setArmed] = useState(false);
  if (count > 0 && !armed) setArmed(true);
  if (!armed && count === 0) return null;
  return (
    <Suspense fallback={null}>
      <CompareTray />
    </Suspense>
  );
}
