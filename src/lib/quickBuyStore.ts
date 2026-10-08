/**
 * THE QUICK BUY SESSION, ONE COPY FOR THE WHOLE APP (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * Three surfaces show the same open session: the product page's toast after an
 * add, the card at the top of «طلباتي», and the «⚡ mm:ss» chip on the account
 * tab of the bottom navigation. They must never disagree about how long is
 * left or what is in it, so they read one module store — the same shape as
 * src/lib/cartCount.ts, for the same reason: `useSyncExternalStore` subscribes
 * exactly the components that show it, and a write can publish here from a
 * plain function.
 *
 * NOT IN THE FIRST PAINT. Every importer is a lazy chunk (the navigation's
 * chip included, src/components/quickBuy/QuickBuyNavChip.tsx): the entry and
 * the store pages are at their byte budgets (tests/bundleBudget.test.ts), and
 * nothing here is needed before a signed-in customer has a session.
 *
 * KEYED BY ACCOUNT. A sign-out followed by another sign-in happens without a
 * reload, and the chip, the card and the product page may then mount before
 * the new account's answer arrives. Every snapshot names the account it
 * belongs to (`owner`), every reader passes the account it is showing, and a
 * reader whose account is not the owner reads the empty snapshot — another
 * account's items, holds and address are never on screen, not even for the
 * length of a round trip.
 *
 * WHEN IT IS REFRESHED, and nowhere else:
 *   · on mount of a surface that shows it (the chip, the orders page);
 *   · when the tab becomes visible again;
 *   · after every write — the write's own answer is published, no second GET;
 *   · once when the countdown reaches zero, so the server can finalise the
 *     session (D13: an expired open session is submitted lazily on the next
 *     Quick Buy request) and answer with the order it became.
 *
 * THE CLOCK IS THE SERVER'S. Remaining time is `expires_at` minus the server's
 * now, where the server's now is the device clock corrected by the offset the
 * last answer carried (`server_now`). Nothing counts down on its own: the
 * shared 1 Hz beat (src/lib/secondTicker.ts) only asks every clock to
 * recompute, so a phone whose clock is five minutes off, or a background tab
 * that skipped beats, still shows the server's figure.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { lastSecond, subscribeSecond } from './secondTicker';
import type { QuickBuyProfile, QuickBuyRecent, QuickBuySessionResponse, QuickBuySessionView } from './quickBuy';

export const QUICK_BUY_SESSION_PATH = '/api/quick-buy/session';

/**
 * A session the server could not turn into its order after every retry. The
 * system cancels it and releases its hold and units by itself (DECISIONS row
 * 188 — nobody at Levonis has to act), and «طلباتي» says so in one line.
 */
export const isQuickBuyNotSubmitted = (s: Pick<QuickBuySessionView, 'state' | 'cancel_reason'> | null | undefined): boolean =>
  s?.state === 'cancelled' && s.cancel_reason === 'not_submitted';

/** The signed-in account's id, as `useAuth().user?.id` gives it. */
export type QuickBuyOwner = string | null | undefined;

export interface QuickBuySnapshot {
  /** The account this snapshot belongs to. */
  owner: string | null;
  /** An answer for this account has arrived (GET /session or a write). */
  loaded: boolean;
  /** The session as the server last described it; null when none is open. */
  session: QuickBuySessionView | null;
  /** The last Quick Buy that ended (its order, or its not-submitted refund), while the server still mentions it. */
  recent: QuickBuyRecent | null;
  /** Server clock minus device clock, from that answer's `server_now`, in ms. */
  offsetMs: number;
  /** Device time at which that answer arrived — no clock may read earlier. */
  receivedAt: number;
}

const EMPTY: QuickBuySnapshot = Object.freeze({ owner: null, loaded: false, session: null, recent: null, offsetMs: 0, receivedAt: 0 });

let state: QuickBuySnapshot = EMPTY;
/**
 * Bumped by every publish and every reset. A GET that started before either
 * describes an older world than the one on screen and is dropped: a session
 * the add just created must not be wiped by a slower read that left before it.
 */
let generation = 0;
let inflight: { generation: number; promise: Promise<QuickBuySnapshot> } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot(): QuickBuySnapshot {
  return state;
}

export const quickBuyStore = { subscribe, snapshot };

/** The snapshot for `owner` — the empty one while the store holds another account's. */
export function quickBuySnapshotFor(owner: QuickBuyOwner): QuickBuySnapshot {
  return owner && state.owner === owner ? state : EMPTY;
}

/** The snapshot for the account on screen, re-rendering only the components that read it. */
export function useQuickBuySnapshot(owner: QuickBuyOwner): QuickBuySnapshot {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return owner && s.owner === owner ? s : EMPTY;
}

/** Forget everything and start over for `owner` (another account, or none). */
function reset(owner: string | null): void {
  generation += 1;
  inflight = null;
  disarmZero();
  if (owner !== profileCache?.owner) profileCache = null;
  state = owner ? { ...EMPTY, owner } : EMPTY;
  emit();
}

/** An older picture of the SAME session than the one held (a slower write's answer). */
function isOlder(next: QuickBuySessionView | null): boolean {
  const cur = state.session;
  return !!next && !!cur && next.id === cur.id && Number(next.rev) < Number(cur.rev);
}

function apply(session: QuickBuySessionView | null, recent: QuickBuyRecent | null | undefined, serverNow: string | null | undefined): void {
  const receivedAt = Date.now();
  const at = serverNow ? Date.parse(serverNow) : NaN;
  state = {
    owner: state.owner,
    loaded: true,
    session,
    recent: recent === undefined ? state.recent : recent,
    offsetMs: Number.isFinite(at) ? at - receivedAt : state.offsetMs,
    receivedAt,
  };
  emit();
  armZeroRefresh();
}

/**
 * A write answered for `owner`: publish what the server now holds. `session`
 * null means none is open any more (the last item was removed, or it was
 * cancelled).
 */
export function publishQuickBuySession(session: QuickBuySessionView | null, owner: QuickBuyOwner, serverNow?: string | null): void {
  if (!owner) return;
  if (state.owner !== owner) reset(owner);
  if (isOlder(session)) return;
  generation += 1;
  apply(session, undefined, serverNow ?? session?.server_now ?? null);
}

/**
 * Ask the server for `owner`'s open session. Concurrent askers share one
 * request — but only one that started in the CURRENT generation: a read that
 * left before a write or a reset will be dropped when it lands, so sharing it
 * would answer the new asker with nothing. A failure is silent (a missing
 * chip is merely absent, a wrong one is a lie) and keeps what is on screen —
 * except a 401, which means signed out.
 */
export function refreshQuickBuySession(owner: QuickBuyOwner): Promise<QuickBuySnapshot> {
  if (!owner) return Promise.resolve(EMPTY);
  if (state.owner !== owner) reset(owner);
  if (inflight && inflight.generation === generation) return inflight.promise;
  const started = generation;
  const promise = api
    .get<QuickBuySessionResponse>(QUICK_BUY_SESSION_PATH, { mascot: 'silent' })
    .then((r) => {
      if (generation === started && state.owner === owner) apply(r.session ?? null, r.recent ?? null, r.server_now);
      return quickBuySnapshotFor(owner);
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401 && generation === started) reset(null);
      return quickBuySnapshotFor(owner);
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { generation: started, promise };
  return promise;
}

// ------------------------------------------------- the profile, remembered

let profileCache: { owner: string; profile: QuickBuyProfile; at: number } | null = null;

/** Keep `owner`'s Quick Buy profile for the screens that ask again soon. */
export function rememberQuickBuyProfile(profile: QuickBuyProfile, owner: QuickBuyOwner): void {
  profileCache = owner ? { owner, profile, at: Date.now() } : null;
}

/** `owner`'s remembered profile, if it is younger than `maxAgeMs`. */
export function rememberedQuickBuyProfile(owner: QuickBuyOwner, maxAgeMs = 60_000): QuickBuyProfile | null {
  return owner && profileCache?.owner === owner && Date.now() - profileCache.at <= maxAgeMs ? profileCache.profile : null;
}

// ------------------------------------------------------------- the clock

/** Device time at which the open session ends, or null when none is open. */
export function quickBuyDeadline(s: QuickBuySnapshot): number | null {
  const at = s.session?.state === 'open' ? Date.parse(s.session.expires_at) : NaN;
  return Number.isFinite(at) ? at - s.offsetMs : null;
}

/**
 * Milliseconds left at device time `now`, never negative; null when no
 * session is open. `now` is floored at the moment the answer arrived: a clock
 * that has not beaten since then cannot claim more time than the server gave.
 */
export function quickBuyRemainingMs(s: QuickBuySnapshot, now: number): number | null {
  const end = quickBuyDeadline(s);
  return end === null ? null : Math.max(0, end - Math.max(now, s.receivedAt));
}

/**
 * «28:42» — minutes and seconds, two digits each, Latin digits, never
 * negative. Rounded UP, as a countdown is read: «00:00» appears at the very
 * moment the window closes and everything locks, never a second before it.
 */
export function formatQuickBuyClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

let beatNow = Date.now();
const readBeat = () => beatNow;
const noBeat = () => () => {};
function subscribeBeat(onChange: () => void): () => void {
  const off = subscribeSecond((t) => {
    beatNow = t;
    onChange();
  });
  // Resubscribing after a pause must not leave the first frame on an old time.
  beatNow = Math.max(beatNow, lastSecond());
  return off;
}

/**
 * The device time, re-read every second while `active` — and not at all
 * otherwise, so a screen with no open session never wakes up for it.
 */
export function useQuickBuyNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribeBeat : noBeat, readBeat, readBeat);
}

// ------------------------------------------------ the zero-time refresh

let zeroTimer: ReturnType<typeof setTimeout> | null = null;
let zeroFor = '';

function disarmZero(): void {
  if (zeroTimer !== null) clearTimeout(zeroTimer);
  zeroTimer = null;
  zeroFor = '';
}

/** Once per session deadline: a beat after it, ask the server what it became. */
function armZeroRefresh(): void {
  const s = state.session;
  const key = s && s.state === 'open' ? `${s.id}|${s.expires_at}` : '';
  if (key === zeroFor) return;
  disarmZero();
  zeroFor = key;
  const end = quickBuyDeadline(state);
  if (!key || end === null) return;
  const owner = state.owner;
  const wait = Math.min(Math.max(0, end - Date.now()), 2 ** 31 - 1) + 800;
  zeroTimer = setTimeout(() => {
    zeroTimer = null;
    void refreshQuickBuySession(owner);
  }, wait);
}

// ------------------------------------------------- the account's sync duty

/**
 * Mounted by the navigation's chip for a signed-in account: read the session
 * on mount and again whenever the tab comes back.
 */
export function useQuickBuySync(owner: QuickBuyOwner): void {
  useEffect(() => {
    if (!owner) return;
    void refreshQuickBuySession(owner);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshQuickBuySession(owner);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [owner]);
}
