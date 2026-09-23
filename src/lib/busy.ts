/**
 * THE ONE WAIT THAT TAKES THE SCREEN.
 *
 * WHAT WAS MISSING. «لا توجد شاشة تحميل مركزية في أي مكان تمنع الضغط المزدوج
 * أو الإرهاق» — nothing in this application was a full-screen busy state. The
 * inline spinner says so in its own header ("Never a full-page takeover"), the
 * skeletons are in-place placeholders, and `Overlay` is a dismissible window
 * whose scrim is a real `<button>`. So on every wait the customer actually
 * feels — placing an order, re-pricing a cart — the only protection was a
 * disabled button, and a disabled button protects exactly one rectangle. The
 * bottom navigation, the header, the browser's own back gesture and every
 * other control on the page stayed live underneath a request that had already
 * left for the server.
 *
 * WHY A REFCOUNTED STORE AND NOT A BOOLEAN. Two waits can overlap — a
 * re-quote that is still in flight when the customer presses Place order —
 * and the second one finishing must not lift a hold the first one still has.
 * The counter is the same shape as `beginCharacterRouteLoad()` in
 * `src/components/bloub/anchors.ts` and `mascot.begin()` in `src/lib/mascot.ts`
 * on purpose: this is the third instance of an idiom the codebase already
 * reads fluently, not a fourth way of doing the same thing.
 *
 * WHY THE RELEASE IS A LAYOUT EFFECT'S CLEANUP. `useBusy` hands the release to
 * React and keeps no copy of it. React runs a cleanup on unmount AND before
 * every re-run, so there is no path — not a thrown request, not a redirect to
 * /auth in the middle of a POST, not a page the customer navigated away from
 * — where the flag goes false or the screen goes away without the hold being
 * given back. A caller's `finally` only has to flip the boolean it already
 * owns. It cannot forget to release, because it never holds a release.
 *
 * WHAT THIS IS NOT. It is not the duplicate-order guard. That is the
 * idempotency key the checkout mints once per visit, and it stays
 * authoritative; so does `canCompleteOrder`. This store only makes an existing
 * refusal visible and stops the taps that would otherwise pile up behind it.
 * If it ever fails to mount, every order must still be placeable.
 */

import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * WHY THE REASONS ARE NAMED AND NOT FREE TEXT. The overlay has to say
 * something, and the only sentences it is allowed to say are ones a human
 * already wrote in all three languages. A closed set is what guarantees that:
 * a new reason cannot be added without someone writing — not generating — the
 * Arabic, the English and the Sorani for it.
 *
 * `payment` is a wallet deposit or withdrawal on its way to the server, and
 * `subscribe` is a membership purchase or a pay-later request/repayment. They
 * joined the set because the owner's report was about the whole site, not the
 * checkout: «هذه المشكلة عامة في الموقع». Like `order`, both commit money, so
 * both arm the leave prompt (see `COMMITS`).
 */
export type BusyReason = 'order' | 'payment' | 'subscribe' | 'quote' | 'route';

/**
 * Which wait speaks when two overlap. A request that commits money outranks
 * the re-quote it may have been waiting on, and everything outranks a route
 * chunk: the customer is owed the sentence about the largest thing currently
 * happening. The three commits never overlap in practice (each is one button
 * on one screen), so they share a rank and the first hold speaks.
 */
const RANK: Record<BusyReason, number> = { order: 30, payment: 30, subscribe: 30, quote: 20, route: 10 };

/**
 * THE WAITS WHERE LEAVING COSTS SOMETHING THE CUSTOMER CANNOT SEE. The request
 * is already with the server; a reload in the middle of it can land an order,
 * a deposit or a subscription without ever showing the customer that it did.
 * These, and only these, arm the browser's leave prompt.
 */
export const COMMITS: ReadonlySet<BusyReason> = new Set<BusyReason>(['order', 'payment', 'subscribe']);

export type BusySnapshot = Readonly<{
  /** The wait currently worth announcing, or null when the app is free. */
  reason: BusyReason | null;
  /**
   * Bumped once per busy SESSION — each transition from free to busy — and
   * never per hold. The overlay's show delay and its safety ceiling are timed
   * from this, so a second hold joining an existing wait does not restart
   * either clock and cannot make a ten-second wait immortal.
   */
  session: number;
  /**
   * The reason that OPENED the current session — fixed for its whole length.
   * The overlay's show delay is chosen from it (a route chunk waits longer
   * before it covers the page than an order does), and keying the delay on
   * `reason` instead would restart the clock every time a second hold with a
   * different rank joined the same wait.
   */
  opener: BusyReason | null;
  /**
   * The reason that was speaking when the LAST session ended, or null before
   * any has. The overlay reads it at the moment it goes away: an order that
   * just finished has replaced the page behind it with the confirmation, and
   * fading a scrim out over that page would be a second animation competing
   * with the one the customer is owed (see AppBusy's exit).
   */
  ended: BusyReason | null;
}>;

const IDLE: BusySnapshot = Object.freeze({ reason: null, session: 0, opener: null, ended: null });

const holds = new Map<symbol, BusyReason>();
const listeners = new Set<() => void>();
let snapshot: BusySnapshot = IDLE;
let session = 0;
let opener: BusyReason | null = null;
let ended: BusyReason | null = null;

function select(): BusyReason | null {
  let best: BusyReason | null = null;
  for (const reason of holds.values()) if (best === null || RANK[reason] > RANK[best]) best = reason;
  return best;
}

function publish(): void {
  const reason = select();
  if (reason === snapshot.reason) return;
  if (reason !== null && snapshot.reason === null) {
    session += 1;
    opener = reason;
  }
  if (reason === null) {
    ended = snapshot.reason;
    opener = null;
  }
  snapshot = Object.freeze({ reason, session, opener, ended });
  // A copy, because a listener is allowed to unsubscribe itself while it runs.
  for (const listener of [...listeners]) listener();
}

/**
 * Take a hold. The returned function gives it back and is idempotent — the
 * `Map.delete` answers false the second time, so a double release cannot
 * decrement someone else's hold.
 */
export function beginBusy(reason: BusyReason): () => void {
  const token = Symbol(reason);
  holds.set(token, reason);
  publish();
  return () => {
    if (holds.delete(token)) publish();
  };
}

export const busyStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  snapshot: () => snapshot,
  /** There is no server render in this app, and a busy screen is never the
   *  first thing a document should describe if there ever is one. */
  serverSnapshot: () => IDLE,
};

/**
 * Hold the screen for as long as `active` is true.
 *
 * `useLayoutEffect` rather than `useEffect`: the hold must exist in the same
 * commit that disabled the button, not a paint later, or there is a frame in
 * which the request has started and nothing is stopping a second tap.
 */
export function useBusy(active: boolean, reason: BusyReason): void {
  useLayoutEffect(() => {
    if (active) return beginBusy(reason);
  }, [active, reason]);
}

/**
 * WHO ASKED FOR THE NEXT WAIT.
 *
 * A re-quote is worth taking the whole screen for when the CUSTOMER caused it
 * — they flipped a switch and are waiting to see what it costs. It is not when
 * the page caused it: the checkout picks the wallet by itself once a quote
 * shows the balance covers the cart, and that second quote used to black out
 * the screen on page load with «جارٍ حساب التوصيل...» for something nobody had
 * touched.
 *
 * So the controls that re-price the cart MARK their change, and the request
 * that follows TAKES the mark. A take consumes it: the next quote, whoever
 * starts it, starts unmarked, so a mark can never leak onto a background
 * refresh that happens to come later.
 */
export function createIntentMark(): { mark: () => void; take: () => boolean } {
  let marked = false;
  return {
    mark() {
      marked = true;
    },
    take() {
      const was = marked;
      marked = false;
      return was;
    },
  };
}

export function useBusySnapshot(): BusySnapshot {
  return useSyncExternalStore(busyStore.subscribe, busyStore.snapshot, busyStore.serverSnapshot);
}

/**
 * Tests only. A leaked hold in one test would otherwise be indistinguishable
 * from a real one in the next, which is the same failure this module exists to
 * make impossible in the application.
 */
export function resetBusyForTests(): void {
  holds.clear();
  listeners.clear();
  snapshot = IDLE;
  session = 0;
  opener = null;
  ended = null;
}
