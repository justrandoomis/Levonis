/**
 * THE REWARDS AREA'S THREE READS (rewards spec §2.3).
 *
 * - `useRewardsHub(enabled)`: GET /api/rewards/program, which feeds the hub,
 *   «كوبوناتي», «استبدل نقاطك» and «قيّم طابعتك».
 * - `useCompetitionsList(enabled, view, mine)`: GET
 *   /api/rewards/program/competitions, one cache per view (`current`,
 *   `results`, `results:mine`), paged by `next_cursor` («عرض المزيد»).
 * - `useCompetition(id, enabled, seed)`: GET
 *   /api/rewards/program/competitions/:id, one cache per id, drawn at once
 *   from the row the customer tapped (the seed) and then read again.
 *
 * WHEN A READ RUNS. On its first enable; on an enable after `invalidate()`;
 * when the tab comes back to the front and the last read settled over 60 s
 * ago; and on `reload()`. A read that failed before it ever had data runs
 * again on its next enable. The frame (src/pages/RewardsArea.tsx) enables a
 * read only for a signed-in customer on its own section, so a guest's device
 * asks for nothing personal, and nothing here is ever written to a cache that
 * outlives the page.
 *
 * HOW. Each read is a small store of slots, one per key. A request carries an
 * AbortController: a new key (another view, another id) or leaving the page
 * cancels it, and a cancelled request is never shown as an error. A slot is
 * KEPT while its read is disabled, so Back from a competition finds the list
 * exactly as it was. The stores belong to one account: a different signed-in
 * user gets new, empty stores.
 *
 * WHAT A SCREEN SEES (`Read<T>`). `status` is 'ready' once data arrived and
 * stays 'ready' through quiet re-reads; a re-read that fails over data sets
 * `stale` (the frame draws its StaleLine) and keeps the data. `skewMs` is the
 * server's clock minus the device's at the last answer, for
 * `toDeviceTarget(iso, read.skewMs)`.
 *
 * The stores are plain classes, exported so tests/rewardsArea.test.ts can
 * drive them against a fake `fetch`; the hooks below are their only callers
 * in the app.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAuth } from '../../AuthContext';
import { api, ApiError, isAborted } from '../../lib/api';
import type { CompetitionsView } from './model';
import type { Competition, CompetitionDetailResponse, CompetitionsPage, RewardsHubData } from './types';

// ------------------------------------------------------------ the shapes a screen reads

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Read<T> {
  /** 'idle' before the first request; 'loading' while the first has no answer; 'ready' once data arrived (and through quiet re-reads); 'error' when a read failed with no data to show. */
  status: LoadStatus;
  data: T | null;
  /** The last failure; null after a success. */
  error: unknown;
  /** A re-read failed while older data is shown. */
  stale: boolean;
  /** Date.parse(server_time) − Date.now(), taken at each answer; 0 before any. */
  skewMs: number;
  /** Read again now (quietly when there is data). Resolves once the answer, or the failure, is in. While the read is disabled it only marks the read for its next enable. */
  reload(): Promise<void>;
  /** Read again quietly the next time the read is enabled (at once if it is enabled now). Every key of the read. */
  invalidate(): void;
}

/** «عرض المزيد»: a next page to ask for, one on its way, the last one failed, or nothing more. */
export type MoreState = 'idle' | 'loading' | 'error' | 'end';

export interface CompetitionsListRead extends Read<CompetitionsPage> {
  /** Every competition loaded for this view, page after page, each id once (the first copy wins). */
  items: Competition[];
  /** 'end' too while there is no data. */
  more: MoreState;
  /** Load the page after the last one (`?cursor=next_cursor`). A 400 BAD_CURSOR reads page 1 again. Never rejects. */
  loadMore(): Promise<void>;
  /**
   * `counts` are global (the same in both views), so this is the freshest
   * copy of any view read so far: the tabs keep their figures while a view
   * they have not shown yet is loading. Undefined before any answer.
   */
  counts: CompetitionsPage['counts'] | undefined;
  /** How many «عرض المزيد» pages have arrived in this read's life; the frame announces «حُمّلت نتائج أخرى» when it grows. */
  moreLoaded: number;
}

export interface CompetitionRead extends Read<CompetitionDetailResponse> {
  /** The server answered 404 for this id (unknown, a draft, cancelled and not entered, before 0220), even over a seed. */
  notFound: boolean;
}

/**
 * What the detail is drawn from before its own answer arrives: the row from
 * the list (or the hub's preview), with the clock and balance of the answer
 * it came in, so a seeded page still dates by the server's clock.
 */
export interface CompetitionSeed {
  competition: Competition;
  server_time: string;
  point_balance: number;
  skewMs: number;
}

// ------------------------------------------------------------ addresses and rules

export const HUB_PATH = '/api/rewards/program';
export const COMPETITIONS_PATH = '/api/rewards/program/competitions';
/** A tab coming back to the front reads again when the last read settled longer ago than this. */
export const STALE_AFTER_MS = 60_000;
/** `reloadSoon()`: a countdown reaching zero reads the visible screen again this long after (crossings close together share one read). */
export const RELOAD_SOON_MS = 1_500;

/** The list's cache key, `${view}${mine ? ':mine' : ''}`; «مشاركاتي فقط» exists only with the results. */
export function listKey(view: CompetitionsView, mine: boolean): string {
  return view === 'results' ? (mine ? 'results:mine' : 'results') : 'current';
}

/** The first page of a list key. */
export function listPath(key: string): string {
  if (key === 'results:mine') return `${COMPETITIONS_PATH}?view=results&mine=1`;
  if (key === 'results') return `${COMPETITIONS_PATH}?view=results`;
  return `${COMPETITIONS_PATH}?view=current`;
}

export function detailPath(id: string): string {
  return `${COMPETITIONS_PATH}/${encodeURIComponent(id)}`;
}

/** The server's clock minus the device's; 0 when the answer carries no readable time. */
export function skewOf(serverTime: unknown, now: number = Date.now()): number {
  const at = typeof serverTime === 'string' ? Date.parse(serverTime) : NaN;
  return Number.isFinite(at) ? at - now : 0;
}

/** The pages in order, each competition once: the first copy wins, so a row never moves when a later page repeats it. */
export function dedupeById(pages: ReadonlyArray<ReadonlyArray<Competition>>): Competition[] {
  const seen = new Set<string>();
  const out: Competition[] = [];
  for (const page of pages) {
    for (const c of page) {
      if (!c || typeof c.id !== 'string' || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

// ------------------------------------------------------------ the stores

type Stamped = { server_time?: string };

/** One key's state. `x` is what a read keeps beside the answer (the list's pages, the detail's 404). */
export interface Slot<T, X> {
  status: LoadStatus;
  data: T | null;
  error: unknown;
  stale: boolean;
  skewMs: number;
  /** Date.now() when the last request for this key settled, answer or failure; 0 before any. */
  settledAt: number;
  /** invalidate() since the last request began: read again on the next enable. */
  invalid: boolean;
  x: X;
}

export interface ReadSpec<T, X> {
  /** The address of a key (the first page, for the list). */
  path(key: string): string;
  /** What `x` starts as. */
  initial: X;
  /** `x` after an answer; `reset` is a BAD_CURSOR restart, which drops the later pages. */
  onData?(prev: Slot<T, X>, data: T, reset: boolean): X;
  /** `x` after a failure. */
  onFail?(prev: Slot<T, X>, error: unknown): X;
}

export class ReadStore<T extends Stamped, X> {
  protected readonly slots = new Map<string, Slot<T, X>>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly empty: Slot<T, X>;
  private version = 0;
  private live = true;

  constructor(
    protected readonly spec: ReadSpec<T, X>,
    /** The account these slots belong to (the hooks make a new store for another). */
    readonly owner: string | null = null
  ) {
    this.empty = { status: 'idle', data: null, error: null, stale: false, skewMs: 0, settledAt: 0, invalid: false, x: spec.initial };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  slot(key: string | null): Slot<T, X> {
    return (key !== null ? this.slots.get(key) : undefined) ?? this.empty;
  }

  busy(key: string): boolean {
    return this.inflight.has(key);
  }

  patch(key: string, change: (slot: Slot<T, X>) => Slot<T, X>): void {
    this.slots.set(key, change(this.slot(key)));
    this.emit();
  }

  /** Mark every key (or the one given) to be read again on its next enable. */
  invalidate(key?: string): void {
    const keys = key === undefined ? [...this.slots.keys()] : [key];
    for (const k of keys) this.slots.set(k, { ...this.slot(k), invalid: true });
    this.emit();
  }

  /** Cancel what is in flight for a key the screen has left (another view, another id). */
  cancel(key: string): void {
    this.inflight.get(key)?.abort();
    this.inflight.delete(key);
  }

  start(): void {
    this.live = true;
  }

  /** The page left: cancel everything (a slot left 'loading' is read again on its next enable). */
  stop(): void {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.live = false;
  }

  /** Read a key now, replacing a read already in flight for it. */
  async fetch(key: string, reset = false): Promise<void> {
    this.cancel(key);
    const ac = new AbortController();
    this.inflight.set(key, ac);
    const quiet = this.slot(key).data !== null;
    this.patch(key, (s) => ({ ...s, status: s.data !== null ? 'ready' : 'loading', invalid: false }));
    try {
      const data = await api.get<T>(this.spec.path(key), { signal: ac.signal, mascot: quiet ? 'silent' : 'auto' });
      if (ac.signal.aborted) return;
      this.patch(key, (s) => ({
        status: 'ready',
        data,
        error: null,
        stale: false,
        skewMs: skewOf(data?.server_time),
        settledAt: Date.now(),
        // An invalidate() that landed while this was in flight (with the read
        // disabled) still stands: this answer may predate what it was for.
        invalid: s.invalid,
        x: this.spec.onData ? this.spec.onData(s, data, reset) : s.x,
      }));
    } catch (error) {
      if (ac.signal.aborted) return;
      if (isAborted(error)) {
        // Cancelled by the session (a sign-in or sign-out elsewhere), not by
        // us: leave the key as it was, so its next enable reads it again.
        this.patch(key, (s) => ({ ...s, status: s.data !== null ? 'ready' : 'idle' }));
        return;
      }
      this.patch(key, (s) => {
        const x = this.spec.onFail ? this.spec.onFail(s, error) : s.x;
        const settledAt = Date.now();
        return s.data !== null
          ? { ...s, error, stale: true, settledAt, x }
          : { ...s, status: 'error', error, stale: false, settledAt, x };
      });
    } finally {
      if (this.inflight.get(key) === ac) this.inflight.delete(key);
    }
  }

  protected emit(): void {
    this.version += 1;
    if (!this.live) return;
    for (const listener of this.listeners) listener();
  }
}

// The hub: one key.
export const HUB_KEY = 'hub';
export const HUB_SPEC: ReadSpec<RewardsHubData, null> = { path: () => HUB_PATH, initial: null };

// A competition: one key per id, and whether the server said 404.
export interface DetailExtra {
  notFound: boolean;
}

export const DETAIL_SPEC: ReadSpec<CompetitionDetailResponse, DetailExtra> = {
  path: detailPath,
  initial: { notFound: false },
  onData: () => ({ notFound: false }),
  onFail: (prev, error) => ({ notFound: error instanceof ApiError && error.status === 404 ? true : prev.x.notFound }),
};

// The list: one key per view, its pages and the cursor after the last one.
export interface ListExtra {
  pages: Competition[][];
  cursor: string | null;
  more: MoreState;
}

const pageItems = (page: CompetitionsPage): Competition[] => (Array.isArray(page?.competitions) ? page.competitions : []);

export const LIST_SPEC: ReadSpec<CompetitionsPage, ListExtra> = {
  path: listPath,
  initial: { pages: [], cursor: null, more: 'end' },
  // A quiet re-read replaces page 1 and keeps the pages loaded after it (and
  // the cursor after the last of them), so reading again never shortens the
  // list under the customer's thumb. A BAD_CURSOR restart starts over.
  onData(prev, page, reset) {
    const later = reset ? [] : prev.x.pages.slice(1);
    const cursor = later.length > 0 ? prev.x.cursor : page?.next_cursor ?? null;
    const more: MoreState = prev.x.more === 'loading' ? 'loading' : cursor ? 'idle' : 'end';
    return { pages: [pageItems(page), ...later], cursor, more };
  },
};

export class ListStore extends ReadStore<CompetitionsPage, ListExtra> {
  private readonly moreInflight = new Map<string, AbortController>();
  /** Pages «عرض المزيد» has added, over this store's life. */
  moreLoaded = 0;

  override cancel(key: string): void {
    super.cancel(key);
    this.cancelMore(key);
  }

  override stop(): void {
    for (const key of [...this.moreInflight.keys()]) this.cancelMore(key);
    super.stop();
  }

  /** The global counts: the given key's, else the freshest any view answered with. */
  counts(key: string | null): CompetitionsPage['counts'] | undefined {
    const own = this.slot(key).data?.counts;
    if (own) return own;
    let best: Slot<CompetitionsPage, ListExtra> | undefined;
    for (const s of this.slots.values()) if (s.data?.counts && (!best || s.settledAt > best.settledAt)) best = s;
    return best?.data?.counts;
  }

  /** The page after the last one; true when it arrived. */
  async loadMore(key: string): Promise<boolean> {
    const s = this.slot(key);
    const cursor = s.x.cursor;
    if (s.data === null || !cursor || this.moreInflight.has(key)) return false;
    const ac = new AbortController();
    this.moreInflight.set(key, ac);
    this.patch(key, (p) => ({ ...p, x: { ...p.x, more: 'loading' } }));
    try {
      const page = await api.get<CompetitionsPage>(`${this.spec.path(key)}&cursor=${encodeURIComponent(cursor)}`, { signal: ac.signal });
      if (ac.signal.aborted) return false;
      const next = page?.next_cursor ?? null;
      this.moreLoaded += 1;
      this.patch(key, (p) => ({
        ...p,
        skewMs: skewOf(page?.server_time),
        x: { pages: [...p.x.pages, pageItems(page)], cursor: next, more: next ? 'idle' : 'end' },
      }));
      return true;
    } catch (error) {
      if (ac.signal.aborted) return false;
      if (error instanceof ApiError && error.status === 400 && error.code === 'BAD_CURSOR') {
        // The cursor no longer reads (a results page that moved under it):
        // start the list again from page 1.
        this.moreInflight.delete(key);
        this.patch(key, (p) => ({ ...p, x: { ...p.x, more: 'idle' } }));
        await this.fetch(key, true);
        return false;
      }
      this.patch(key, (p) => ({ ...p, x: { ...p.x, more: isAborted(error) ? (p.x.cursor ? 'idle' : 'end') : 'error' } }));
      return false;
    } finally {
      if (this.moreInflight.get(key) === ac) this.moreInflight.delete(key);
    }
  }

  private cancelMore(key: string): void {
    const ac = this.moreInflight.get(key);
    if (!ac) return;
    ac.abort();
    this.moreInflight.delete(key);
    this.patch(key, (p) => (p.x.more === 'loading' ? { ...p, x: { ...p.x, more: p.x.cursor ? 'idle' : 'end' } } : p));
  }
}

// ------------------------------------------------------------ the hooks

/** The signed-in account the stores belong to. */
function useOwner(): string | null {
  const { user } = useAuth();
  return user?.id ?? null;
}

/** Subscribe to a store and run its reads by the rules above. */
function useDriven<T extends Stamped, X>(store: ReadStore<T, X>, key: string | null, enabled: boolean) {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const slot = store.slot(key);
  const idle = slot.status === 'idle';
  const invalid = slot.invalid;

  // The first enable, an enable after invalidate(), a retry after a read that
  // never had data, and a key whose first read was cancelled.
  useEffect(() => {
    if (!enabled || key === null || store.busy(key)) return;
    const s = store.slot(key);
    if (s.status === 'ready' && !s.invalid) return;
    void store.fetch(key);
  }, [store, key, enabled, idle, invalid]);

  // A parameter change cancels the request it left behind; the slot is kept.
  const lastKey = useRef(key);
  useEffect(() => {
    const was = lastKey.current;
    lastKey.current = key;
    if (was !== null && was !== key) store.cancel(was);
  }, [store, key]);

  // Back to the tab a minute later: read it again, quietly.
  useEffect(() => {
    if (!enabled || key === null || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || store.busy(key)) return;
      const s = store.slot(key);
      if (s.settledAt > 0 && Date.now() - s.settledAt > STALE_AFTER_MS) void store.fetch(key);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [store, key, enabled]);

  const reload = useCallback(async () => {
    if (key === null) return;
    if (!enabled) {
      store.invalidate(key);
      return;
    }
    await store.fetch(key);
  }, [store, key, enabled]);

  const invalidate = useCallback(() => {
    store.invalidate();
    if (enabled && key !== null) void store.fetch(key);
  }, [store, key, enabled]);

  return { slot, reload, invalidate };
}

/** GET /api/rewards/program. Enabled for a signed-in customer on the hub, «كوبوناتي», «استبدل نقاطك» and «قيّم طابعتك». */
export function useRewardsHub(enabled: boolean): Read<RewardsHubData> {
  const owner = useOwner();
  const store = useMemo(() => new ReadStore(HUB_SPEC, owner), [owner]);
  const { slot, reload, invalidate } = useDriven(store, HUB_KEY, enabled);
  return useMemo<Read<RewardsHubData>>(
    () => ({ status: slot.status, data: slot.data, error: slot.error, stale: slot.stale, skewMs: slot.skewMs, reload, invalidate }),
    [slot, reload, invalidate]
  );
}

/** GET /api/rewards/program/competitions?view=…[&mine=1]. Enabled for a signed-in customer on «المسابقات». */
export function useCompetitionsList(enabled: boolean, view: CompetitionsView, mine: boolean): CompetitionsListRead {
  const owner = useOwner();
  const store = useMemo(() => new ListStore(LIST_SPEC, owner), [owner]);
  const key = listKey(view, mine);
  const { slot, reload, invalidate } = useDriven(store, key, enabled);
  const pages = slot.x.pages;
  const items = useMemo(() => dedupeById(pages), [pages]);
  const loadMore = useCallback(async () => {
    if (!enabled) return;
    await store.loadMore(key);
  }, [store, key, enabled]);
  const counts = store.counts(key);
  const moreLoaded = store.moreLoaded;
  return useMemo<CompetitionsListRead>(
    () => ({
      status: slot.status,
      data: slot.data,
      error: slot.error,
      stale: slot.stale,
      skewMs: slot.skewMs,
      reload,
      invalidate,
      items,
      more: slot.data === null ? 'end' : slot.x.more,
      loadMore,
      counts,
      moreLoaded,
    }),
    [slot, reload, invalidate, items, loadMore, counts, moreLoaded]
  );
}

/**
 * GET /api/rewards/program/competitions/:id. Enabled for a signed-in customer
 * on a competition's page with a valid id. With a seed and no answer of its
 * own yet, the read is 'ready' at once with the seed (`stale` if its own read
 * then fails); a 404 sets `notFound` even over the seed.
 */
export function useCompetition(id: string | undefined, enabled: boolean, seed: CompetitionSeed | null): CompetitionRead {
  const owner = useOwner();
  const store = useMemo(() => new ReadStore(DETAIL_SPEC, owner), [owner]);
  const key = id ?? null;
  const { slot, reload, invalidate } = useDriven(store, key, enabled);
  const seeded = useMemo(() => seededDetail(seed, id), [seed, id]);
  return useMemo<CompetitionRead>(() => ({ ...detailState(slot, key, seeded), reload, invalidate }), [key, slot, seeded, reload, invalidate]);
}

/** A seed as the detail's own answer would read, or null when it is for another id. */
export interface SeededDetail {
  data: CompetitionDetailResponse;
  skewMs: number;
}

export function seededDetail(seed: CompetitionSeed | null, id: string | undefined): SeededDetail | null {
  if (!seed || id === undefined || seed.competition?.id !== id) return null;
  return {
    data: { success: true, server_time: seed.server_time, point_balance: seed.point_balance, competition: seed.competition },
    skewMs: seed.skewMs,
  };
}

/** What the detail shows for a slot: its own answer when it has one, else the seed (stale if its own read failed); a 404 wins over the seed. */
export function detailState(
  slot: Slot<CompetitionDetailResponse, DetailExtra>,
  key: string | null,
  seeded: SeededDetail | null
): Omit<CompetitionRead, 'reload' | 'invalidate'> {
  const notFound = key !== null && slot.x.notFound;
  if (slot.data === null && seeded && !notFound) {
    return { status: 'ready', data: seeded.data, error: slot.error, stale: slot.status === 'error', skewMs: seeded.skewMs, notFound };
  }
  return { status: slot.status, data: slot.data, error: slot.error, stale: slot.stale, skewMs: slot.skewMs, notFound };
}

/**
 * `reloadSoon()` for Countdown.onZero: runs the LATEST `reload` given (the
 * visible screen's) 1.5 s after the first call; calls before it fires join
 * it, so fifty rows crossing zero together read once.
 */
export function useReloadSoon(reload: () => unknown, ms: number = RELOAD_SOON_MS): () => void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    []
  );
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void latest.current();
    }, ms);
  }, [ms]);
}
