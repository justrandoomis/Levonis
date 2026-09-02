import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

/**
 * Asks the server whether a username is free WHILE it is typed — the same
 * question the onboarding UsernameField asks, on the same endpoint
 * (GET /api/auth/username-available, 60 calls / 5 min), debounced 350ms
 * with late answers discarded so a slow reply for `ali` can never mark a
 * fast `ali3d` as taken.
 *
 * A dropped request goes quiet (`idle`) rather than blocking a valid name:
 * the server decides on register anyway. `reason` carries the server's
 * verdict (taken | reserved | too_short | …) for a precise message.
 */
export type UsernameAvailability = 'idle' | 'checking' | 'free' | 'unavailable';

export function useUsernameAvailability(value: string, enabled = true): { state: UsernameAvailability; reason: string | null } {
  const [state, setState] = useState<UsernameAvailability>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const trimmed = value.trim().toLowerCase();
    if (!enabled || !trimmed) {
      setState('idle');
      setReason(null);
      return;
    }
    setState('checking');
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      api
        .get<{ available: boolean; reason: string | null }>(`/api/auth/username-available?u=${encodeURIComponent(trimmed)}`)
        .then((r) => {
          if (ticket !== latest.current) return;
          setState(r.available ? 'free' : 'unavailable');
          setReason(r.reason);
        })
        .catch(() => {
          if (ticket !== latest.current) return;
          setState('idle');
          setReason(null);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [value, enabled]);

  return { state, reason };
}
