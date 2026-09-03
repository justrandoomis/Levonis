/**
 * Re-read the server when the customer COMES BACK to a screen.
 *
 * WHY THIS EXISTS. A cart line stores no price: every read of /api/cart
 * re-prices it, so the number is correct the moment it is fetched. What is not
 * guaranteed is that it is ever fetched again. A React page fetches in a mount
 * effect, and on a phone a page can stay mounted for hours:
 *
 *   - the tab is left open while the customer does something else;
 *   - the browser is backgrounded and the app is switched away from;
 *   - `back` restores the page from the bfcache, which does NOT remount it and
 *     does NOT re-run any effect — the only signal is `pageshow` with
 *     `event.persisted`.
 *
 * In every one of those the old price stays on screen, and the customer sees a
 * total the shop no longer charges. This hook closes that: when the page
 * becomes visible again, it asks the server what the truth is now.
 *
 * It follows the wake pattern already in the codebase (TelegramAuth.tsx,
 * TelegramLink.tsx): listen on focus and visibilitychange, and act only while
 * the document is actually visible.
 *
 * THE GUARDS MATTER AS MUCH AS THE LISTENERS.
 *   - `minIntervalMs` stops a burst of focus/visibility events (they fire
 *     together on some browsers) from becoming a burst of requests.
 *   - an in-flight flag stops a slow response from being overtaken.
 *   - `enabled` lets a caller hold the refresh while the customer is mid-edit,
 *     so a reload never lands under a dialog they are typing in.
 */
import { useEffect, useRef } from 'react';

export interface FreshOnReturnOptions {
  /** Ignore a wake that arrives within this long of the last refresh. */
  minIntervalMs?: number;
  /**
   * Also refresh on a timer while the page is visible and in front, for the
   * customer who simply sits on the cart with it open. 0 disables it.
   */
  pollWhileVisibleMs?: number;
  /** false pauses everything — use it while a modal or a submit is open. */
  enabled?: boolean;
}

export function useFreshOnReturn(
  revalidate: () => void | Promise<void>,
  { minIntervalMs = 10_000, pollWhileVisibleMs = 0, enabled = true }: FreshOnReturnOptions = {}
): void {
  // The callback is read through a ref so a caller may pass an inline function
  // without re-subscribing the listeners on every render.
  const fnRef = useRef(revalidate);
  fnRef.current = revalidate;
  const lastRef = useRef(0);
  const inFlightRef = useRef(false);
  const enabledRef = useRef(enabled);
  const pendingRef = useRef(false);
  const runRef = useRef<(force: boolean) => void>(() => {});

  // A wake that lands while the caller is holding the refresh (a modal open, a
  // tap in flight) is REMEMBERED and replayed the moment the hold lifts.
  // Dropping it would swallow the one refresh the customer came back for.
  useEffect(() => {
    const was = enabledRef.current;
    enabledRef.current = enabled;
    if (!was && enabled && pendingRef.current) {
      pendingRef.current = false;
      runRef.current(true);
    }
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;

    const run = async (force: boolean) => {
      if (cancelled || inFlightRef.current) return;
      if (!enabledRef.current) {
        pendingRef.current = true;
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (!force && now - lastRef.current < minIntervalMs) return;
      inFlightRef.current = true;
      lastRef.current = now;
      try {
        await fnRef.current();
      } catch {
        // The caller owns its own error surface; a failed refresh must never
        // replace what is already on screen with an exception.
      } finally {
        inFlightRef.current = false;
      }
    };

    runRef.current = (force: boolean) => void run(force);
    const onWake = () => void run(false);
    // A bfcache restore is the one case worth forcing: the page may have been
    // frozen for days, and the interval guard would wave it through.
    const onPageShow = (e: Event) => {
      if ((e as PageTransitionEvent).persisted) void run(true);
      else void run(false);
    };

    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('pageshow', onPageShow);

    let timer: number | null = null;
    if (pollWhileVisibleMs > 0) {
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void run(false);
      }, pollWhileVisibleMs);
    }

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('pageshow', onPageShow);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [minIntervalMs, pollWhileVisibleMs]);
}

/**
 * Which lines changed price between two reads.
 *
 * Correcting the number in silence is right — the shop must charge today's
 * price — but a total that moves while the customer is looking at it, with no
 * word about why, is how a shop loses an argument it should have won. This
 * returns the ids whose unit price differs so the screen can say so.
 */
export function changedPrices<T extends { id: string; unit_price_iqd?: number | null }>(
  before: readonly T[],
  after: readonly T[]
): Map<string, { from: number; to: number }> {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const was = new Map(before.map((i) => [i.id, num(i.unit_price_iqd)]));
  const out = new Map<string, { from: number; to: number }>();
  for (const item of after) {
    const from = was.get(item.id);
    const to = num(item.unit_price_iqd);
    // A line the page has not seen before has nothing to compare against, and
    // reporting it as "changed" would be a lie on the customer's first look.
    // A line with no price on either side is not a change either: "it went up
    // from 0 IQD" is a sentence no shop should ever show.
    if (from === undefined || from === null || to === null || from === to) continue;
    out.set(item.id, { from, to });
  }
  return out;
}
