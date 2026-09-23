import { useEffect, useRef } from 'react';

/**
 * THE THREAD ON SCREEN AND THE THREAD ON THE SERVER, KEPT AS ONE.
 *
 * A support conversation is now refreshed while it is open — the customer's
 * «تذاكري», the admin's ticket console and the complaint thread all poll
 * silently so a reply from the other side appears without anybody reopening
 * anything. That poll races the composer: the agent presses send, the bubble
 * goes up as PENDING, and a poll that left before the send committed comes
 * back with a thread that does not contain it. Replacing the list with that
 * answer would make the message vanish and reappear, and settling the send
 * after a poll that DID contain it would show it twice.
 *
 * These two functions are the whole rule, in one place for all three screens:
 *
 *   • `mergeThread` takes the server's list as the truth for everything it
 *     contains, and keeps what only this browser knows — pending bubbles, and
 *     rows newer than the newest one in the answer (a send that committed
 *     after the poll's read). An answer that changes nothing returns the SAME
 *     array, so React does not re-render and the list does not jump.
 *   • `settleThread` puts the server's row where the pending bubble was — or,
 *     when a poll already delivered that row, simply removes the bubble.
 */
export interface ThreadRow {
  id: string;
  created_at: string;
  pending?: boolean;
}

export function mergeThread<T extends ThreadRow>(current: T[], incoming: T[]): T[] {
  const incomingIds = new Set(incoming.map((m) => m.id));
  const newest = incoming.reduce((max, m) => (m.created_at > max ? m.created_at : max), '');
  const localOnly = current.filter((m) => !incomingIds.has(m.id) && (m.pending || m.created_at > newest));
  const next = [...incoming, ...localOnly];
  if (next.length === current.length && next.every((m, i) => m.id === current[i].id && !!m.pending === !!current[i].pending)) {
    return current;
  }
  return next;
}

export function settleThread<T extends ThreadRow>(current: T[], tempId: string, settled: T): T[] {
  if (current.some((m) => m.id === settled.id && m.id !== tempId)) return current.filter((m) => m.id !== tempId);
  return current.map((m) => (m.id === tempId ? settled : m));
}

/**
 * Every `ms` while `document` is visible, and once more the moment it becomes
 * visible again — a tablet left on the desk does not poll a hidden tab, and
 * picking it up shows what arrived. Returns the stop function for an effect.
 */
export function pollWhileVisible(run: () => void, ms: number): () => void {
  const tick = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') run();
  };
  const timer = setInterval(tick, ms);
  const onVisible = () => {
    if (document.visibilityState === 'visible') run();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * THE NEWEST MESSAGE STAYS IN VIEW — including after its photograph loads.
 *
 * Setting `scrollTop = scrollHeight` once, when the messages arrive, is not
 * enough: an image bubble has no height until its bytes do, so the list grows
 * AFTER it was scrolled and the thread opened a photo's height above the last
 * message (measured at 360px: the evidence photo pushed the newest bubble off
 * the screen). So the list is re-pinned whenever an image or a clip inside it
 * finishes loading — but only while the reader is AT the bottom; somebody who
 * scrolled up to read an older message is not dragged down by a picture.
 *
 * `scrollTop` on the list and never `scrollIntoView`, which walks every
 * scrollable ancestor and would move the page (or the admin panel) itself.
 * A new thread starts at its newest message, and so does the reader's own
 * send (`lastPending`), wherever they had scrolled.
 */
export function useThreadScroll(
  listRef: { current: HTMLElement | null },
  openKey: string,
  messageCount: number,
  lastPending: boolean
): void {
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [openKey]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
    };
    const onMedia = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // `load` and `loadedmetadata` do not bubble; the capture phase sees them.
    el.addEventListener('load', onMedia, true);
    el.addEventListener('loadedmetadata', onMedia, true);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onMedia, true);
      el.removeEventListener('loadedmetadata', onMedia, true);
    };
  }, [listRef, openKey]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stick.current || lastPending) {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
    }
  }, [listRef, openKey, messageCount, lastPending]);
}
