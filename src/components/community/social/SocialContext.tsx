/**
 * THE VIEWER'S OWN GRAPH, ONCE PER SESSION — who they follow, who they
 * blocked, who they muted — so a card drawn after a navigation shows the
 * right state without each card asking.
 *
 * `SocialProvider` sits around the customer shell's routes (src/App.tsx) and
 * costs nothing until a consumer asks: the first `useSocial()` under it, for a
 * signed-in person, fetches `GET /api/community/me/social` exactly once per
 * account (again after a sign-in or sign-out, never per page). A guest never
 * fetches. A failure (the community wall, a flaky network) leaves the sets
 * empty and the buttons fall back to what the server put on each card.
 *
 * Outside the provider (the browser fixtures, a shell that does not mount it)
 * `useSocial()` still answers, with empty sets and no fetch, so a component
 * can be used anywhere.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { socialApi, type SocialMe } from './api';

export interface SocialState {
  /** True once the graph has been fetched for the current account. */
  loaded: boolean;
  followingUsers: ReadonlySet<string>;
  followingStores: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  muted: ReadonlySet<string>;
  /** Fetch again (after a write elsewhere, or a retry). */
  refresh: () => void;
  setFollowing: (userId: string, on: boolean) => void;
  setFollowingStore: (storeId: string, on: boolean) => void;
  setBlocked: (userId: string, on: boolean) => void;
  setMuted: (userId: string, on: boolean) => void;
}

const EMPTY: ReadonlySet<string> = new Set();

const noop = () => {};

const DEFAULT: SocialState = {
  loaded: false,
  followingUsers: EMPTY,
  followingStores: EMPTY,
  blocked: EMPTY,
  muted: EMPTY,
  refresh: noop,
  setFollowing: noop,
  setFollowingStore: noop,
  setBlocked: noop,
  setMuted: noop,
};

interface Internal extends SocialState {
  /** A consumer mounted: fetch if nobody has yet. */
  touch: () => void;
}

const SocialCtx = createContext<Internal | null>(null);

type Sets = { followingUsers: Set<string>; followingStores: Set<string>; blocked: Set<string>; muted: Set<string> };

const fromMe = (me: SocialMe): Sets => ({
  followingUsers: new Set(me.following_users),
  followingStores: new Set(me.following_stores),
  blocked: new Set(me.blocked),
  muted: new Set(me.muted),
});

const emptySets = (): Sets => ({ followingUsers: new Set(), followingStores: new Set(), blocked: new Set(), muted: new Set() });

export function SocialProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [sets, setSets] = useState<Sets>(emptySets);
  const [loaded, setLoaded] = useState(false);
  // Which account the fetch in flight (or done) belongs to; null = nobody asked.
  const fetchedFor = useRef<string | null>(null);
  const wanted = useRef(false);
  // Presses made while an answer is on its way. The answer is a snapshot
  // taken before those writes landed, so it is replayed over them — never
  // the other way round, or a follow pressed during the fetch would revert.
  // `inFlight` names the NEWEST request (a token), so an older answer's
  // `finally` cannot declare the newer one finished and drop its presses.
  const inFlight = useRef(0);
  const pending = useRef<Array<{ key: keyof Sets; id: string; on: boolean }>>([]);
  const lastUser = useRef<string | null>(userId);

  const load = useCallback(
    (id: string) => {
      fetchedFor.current = id;
      const token = inFlight.current + 1;
      inFlight.current = token;
      socialApi
        .me()
        .then((me) => {
          if (fetchedFor.current !== id || inFlight.current !== token) return;
          const next = fromMe(me);
          for (const t of pending.current) {
            if (t.on) next[t.key].add(t.id);
            else next[t.key].delete(t.id);
          }
          setSets(next);
          setLoaded(true);
        })
        .catch(() => {
          // Leave the sets empty; the cards use the server's own flags.
          if (fetchedFor.current === id && inFlight.current === token) fetchedFor.current = null;
        })
        .finally(() => {
          if (inFlight.current === token) {
            inFlight.current = 0;
            pending.current = [];
          }
        });
    },
    []
  );

  // A sign-in or a sign-out changes whose graph this is. Only an ACTUAL change
  // of account resets: React runs a child's effects before the parent's, so a
  // consumer mounting in the same commit as this provider has already asked
  // (`touch`), and resetting here would discard that request and send a
  // second one whose `finally` then raced the first.
  useEffect(() => {
    if (lastUser.current === userId) return;
    lastUser.current = userId;
    setSets(emptySets());
    setLoaded(false);
    fetchedFor.current = null;
    inFlight.current = 0;
    pending.current = [];
    if (userId && wanted.current) load(userId);
  }, [userId, load]);

  const touch = useCallback(() => {
    wanted.current = true;
    if (userId && fetchedFor.current !== userId) load(userId);
  }, [userId, load]);

  const refresh = useCallback(() => {
    if (userId) load(userId);
  }, [userId, load]);

  const toggle = useCallback((key: keyof Sets, id: string, on: boolean) => {
    if (inFlight.current !== 0) pending.current.push({ key, id, on });
    setSets((prev) => {
      if (prev[key].has(id) === on) return prev;
      const next = new Set(prev[key]);
      if (on) next.add(id);
      else next.delete(id);
      return { ...prev, [key]: next };
    });
  }, []);

  const value = useMemo<Internal>(
    () => ({
      loaded,
      followingUsers: sets.followingUsers,
      followingStores: sets.followingStores,
      blocked: sets.blocked,
      muted: sets.muted,
      refresh,
      touch,
      setFollowing: (id, on) => toggle('followingUsers', id, on),
      setFollowingStore: (id, on) => toggle('followingStores', id, on),
      setBlocked: (id, on) => {
        toggle('blocked', id, on);
        // Blocking deletes the follows both ways on the server; mirror it.
        if (on) toggle('followingUsers', id, false);
      },
      setMuted: (id, on) => toggle('muted', id, on),
    }),
    [loaded, sets, refresh, touch, toggle]
  );

  return <SocialCtx.Provider value={value}>{children}</SocialCtx.Provider>;
}

/** The viewer's graph. Mounting a consumer is what triggers the one fetch. */
export function useSocial(): SocialState {
  const ctx = useContext(SocialCtx);
  const touch = ctx?.touch;
  useEffect(() => {
    touch?.();
  }, [touch]);
  return ctx ?? DEFAULT;
}
