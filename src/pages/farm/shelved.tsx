/**
 * IS THE FARM OPEN? — the client half of the shelving switch.
 *
 * The server decides (worker/routes/farm.ts, "the shelving switch"): while
 * `admin_settings.printerFarmShelved` does not say `{"open": true}`, every
 * /api/farm route answers 503 FARM_SHELVED to a customer and lets a platform
 * admin through. GET /api/farm/status is the one route that always answers, so
 * the pages can ask the question instead of guessing — which is what lets the
 * owner lift the shelving with one settings write and no deploy.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY. A redirect is presentation: it keeps a
 * customer from being dropped into a page whose every call would be refused,
 * and it takes them to the hub, which says «قريبا — تحت التطوير» in their own
 * language. The refusal that actually protects the game engine is the server's.
 *
 * NO TEXT LIVES IN THIS FILE, deliberately. App.tsx imports the gate eagerly to
 * wrap the lazy game routes, so anything imported here lands in the first
 * bundle; a skeleton and a redirect cost nothing, the 65 KB trilingual string
 * table would not.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../lib/api';
import FarmSkeleton from './FarmSkeleton';

export interface FarmAccess {
  /** The server's switch: true while the game is closed to players. */
  shelved: boolean;
  /** True when the viewer is a platform admin — the door that stays open. */
  admin: boolean;
  /** True when this viewer may open the game at all: anyone while it is open, an admin always. */
  may_play: boolean;
}

/**
 * The three booleans, or null. A body missing any of them is NOT read as an
 * open game: an answer nobody can understand is not permission.
 */
export function farmAccessOf(body: unknown): FarmAccess | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.shelved !== 'boolean' || typeof b.may_play !== 'boolean') return null;
  return { shelved: b.shelved, admin: b.admin === true, may_play: b.may_play };
}

/** GET /api/farm/status — public, never cached, answers while the game is shelved. */
export async function fetchFarmAccess(): Promise<FarmAccess> {
  const access = farmAccessOf(await api.get<unknown>('/api/farm/status'));
  if (!access) throw new Error('farm status: unreadable body');
  return access;
}

/**
 * Reads the switch once per mount. `error` is kept rather than swallowed: a
 * page that could not ask must not claim the game is shelved, and must not
 * show itself either — the caller decides which of those two it is.
 */
export function useFarmAccess(): { access: FarmAccess | null; error: unknown; reload: () => void } {
  const [access, setAccess] = useState<FarmAccess | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setAccess(null);
    setError(null);
    setNonce((n) => n + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    fetchFarmAccess()
      .then((a) => {
        if (alive) setAccess(a);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [nonce]);
  return { access, error, reload };
}

/**
 * Wraps a game route. While the game is shelved a customer never sees the page
 * at all — not from the hub, not from a typed URL, not from a stale link or a
 * bookmark — they are replaced onto /games, where the «قريبا» card explains
 * why. `replace` is the point: the shelved page leaves no history entry, so
 * the back button cannot walk into it either.
 *
 * A status that could not be read is treated the same way. We do not know the
 * game is open, so we do not show it; the hub retries the question and reports
 * the failure honestly instead of inventing an answer here.
 */
export function FarmGate({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const { access, error } = useFarmAccess();
  if (error !== null) return <Navigate to="/games" replace />;
  if (!access) return <>{fallback ?? <FarmSkeleton />}</>;
  if (!access.may_play) return <Navigate to="/games" replace />;
  return <>{children}</>;
}
