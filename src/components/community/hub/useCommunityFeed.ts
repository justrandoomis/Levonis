/**
 * ONE LIST OF THE COMMUNITY PAGE — products, stores or requests — a page at a
 * time, for one search term.
 *
 * THE PAGES ARE REMEMBERED FOR TWO MINUTES, per viewer, kind and term. The
 * page is a place people leave and come back to: a card opens a store or a
 * product, and Back used to land on a spinner and the first twenty rows again,
 * with whatever «عرض المزيد» had loaded gone. A short memory brings back the
 * list they left. It is keyed by the viewer because a list carries per-viewer
 * facts (`following`), and a guest's answer must not survive into a session.
 *
 * A response for a key that is no longer the one on screen is dropped — a fast
 * typist's first search must not overwrite their last.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityHubApi, type FeedKind, type Page } from './api';

interface Entry {
  rows: Array<{ id: string }>;
  next: string | null;
  total: number | null;
  at: number;
}

const FRESH_MS = 2 * 60_000;
const cache = new Map<string, Entry>();

const LOADERS: Record<FeedKind, (q: string, cursor: string | null) => Promise<Page<{ id: string }>>> = {
  products: communityHubApi.products,
  merchants: communityHubApi.merchants,
  requests: communityHubApi.requests,
};

function fresh(key: string): Entry | null {
  const e = cache.get(key);
  return e && Date.now() - e.at < FRESH_MS ? e : null;
}

/** Forget one kind's pages (every term), e.g. after a follow changed what they say. */
export function forgetCommunityFeed(kind: FeedKind, exceptKey?: string) {
  for (const key of cache.keys()) {
    if (key !== exceptKey && key.split('|')[1] === kind) cache.delete(key);
  }
}

export interface CommunityFeed<T> {
  /** Null while the first page is on its way. */
  rows: T[] | null;
  error: unknown;
  /** The whole list's size, from the first page. */
  total: number | null;
  hasMore: boolean;
  more: 'idle' | 'loading' | 'error';
  loadMore: () => void;
  reload: () => void;
  /** Change rows in place (a follow toggled) — the memory follows. */
  patch: (fn: (rows: T[]) => T[]) => void;
  /** Drop this kind's remembered pages for every OTHER term — they now say something stale. */
  forgetOthers: () => void;
}

export function useCommunityFeed<T extends { id: string }>(kind: FeedKind, q: string, viewer: string): CommunityFeed<T> {
  const key = `${viewer}|${kind}|${q}`;
  const [slot, setSlot] = useState<{ key: string; entry: Entry | null }>(() => ({ key, entry: fresh(key) }));
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [nonce, setNonce] = useState(0);
  const current = useRef(key);

  // A new key shows its own remembered pages, or nothing, from the very first
  // render — never one frame of the previous search's rows.
  const entry = slot.key === key ? slot.entry : fresh(key);

  useEffect(() => {
    current.current = key;
    setError(null);
    setMore('idle');
    const hit = fresh(key);
    if (hit) {
      setSlot({ key, entry: hit });
      return;
    }
    setSlot({ key, entry: null });
    let alive = true;
    LOADERS[kind](q, null)
      .then((p) => {
        if (!alive) return;
        const e: Entry = { rows: p.rows, next: p.next, total: p.total, at: Date.now() };
        cache.set(key, e);
        setSlot({ key, entry: e });
      })
      .catch((err: unknown) => {
        if (alive) setError(err);
      });
    return () => {
      alive = false;
    };
  }, [key, kind, q, nonce]);

  const loadMore = useCallback(() => {
    const e = entry;
    if (!e || !e.next || more === 'loading') return;
    const k = key;
    setMore('loading');
    LOADERS[kind](q, e.next)
      .then((p) => {
        if (current.current !== k) return;
        const seen = new Set(e.rows.map((r) => r.id));
        const merged: Entry = {
          rows: [...e.rows, ...p.rows.filter((r) => !seen.has(r.id))],
          next: p.next,
          total: e.total ?? p.total,
          at: Date.now(),
        };
        cache.set(k, merged);
        setSlot({ key: k, entry: merged });
        setMore('idle');
      })
      .catch(() => {
        if (current.current === k) setMore('error');
      });
  }, [entry, more, key, kind, q]);

  const reload = useCallback(() => {
    cache.delete(key);
    setNonce((n) => n + 1);
  }, [key]);

  const patch = useCallback(
    (fn: (rows: T[]) => T[]) => {
      setSlot((s) => {
        if (s.key !== key || !s.entry) return s;
        const next: Entry = { ...s.entry, rows: fn(s.entry.rows as T[]) };
        cache.set(key, next);
        return { key, entry: next };
      });
    },
    [key]
  );

  const forgetOthers = useCallback(() => forgetCommunityFeed(kind, key), [kind, key]);

  return {
    rows: entry ? (entry.rows as T[]) : null,
    error,
    total: entry?.total ?? null,
    hasMore: !!entry?.next,
    more,
    loadMore,
    reload,
    patch,
    forgetOthers,
  };
}

/** The workshops' recent work — one small list, remembered the same way. */
let worksMemo: { at: number; promise: Promise<Awaited<ReturnType<typeof communityHubApi.works>>> } | null = null;

export function loadCommunityWorks() {
  if (worksMemo && Date.now() - worksMemo.at < FRESH_MS) return worksMemo.promise;
  const promise = communityHubApi.works().catch((e: unknown) => {
    worksMemo = null;
    throw e;
  });
  worksMemo = { at: Date.now(), promise };
  return promise;
}
