import { useEffect, useState } from 'react';
import { loadCapabilities, type AuthCapabilities } from '../lib/capabilities';

/**
 * The auth surface's view of what it may offer.
 *
 * `null` while the answer is in flight — callers render the methods they know
 * are safe (email/password) and let the rest appear when the answer lands,
 * rather than flashing a Google button that then disappears.
 */
export function useCapabilities(): AuthCapabilities | null {
  const [caps, setCaps] = useState<AuthCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    loadCapabilities().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  return caps;
}
