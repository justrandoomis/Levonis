import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../../lib/api';

/**
 * HOW MANY PEOPLE ARE WAITING, IN THE THREE PLACES THE CONSOLE SAYS SO.
 *
 * The sidebar badge (src/pages/Admin.tsx), the console's three tabs and the
 * dashboard tile all show the same three numbers. Two components asking the
 * server on their own timers would be two polls and, between them, two
 * answers — a badge reading 3 beside a tab reading 2. So there is ONE store:
 * every mounted reader subscribes, one timer refreshes it while anyone is
 * listening and the tab is visible, and an action that changes a count (a
 * reply, a state change) asks for a refresh instead of guessing the new
 * number.
 *
 * `/api/admin/chats/summary` computes all three with the server's own rules
 * (worker/routes/adminChats.ts `supportInboxCounts`); nothing is counted here.
 */
export interface SupportCounts {
  tickets_waiting: number;
  chats_unread: number;
  complaints_open: number;
}

const POLL_MS = 45_000;

let snapshot: SupportCounts | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function emit() {
  for (const l of listeners) l();
}

export function refreshSupportCounts(): Promise<void> {
  if (inflight) return inflight;
  inflight = api
    .get<SupportCounts>('/api/admin/chats/summary', { mascot: 'silent' })
    .then((d) => {
      snapshot = {
        tickets_waiting: Number(d.tickets_waiting) || 0,
        chats_unread: Number(d.chats_unread) || 0,
        complaints_open: Number(d.complaints_open) || 0,
      };
      emit();
    })
    // A missed poll keeps the last known numbers: a badge that blinks to zero
    // on one dropped request would tell staff nobody is waiting.
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function onVisible() {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refreshSupportCounts();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void refreshSupportCounts();
    }, POLL_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/** The three counts, or null until the first answer arrives. */
export function useSupportCounts(enabled = true): SupportCounts | null {
  const value = useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    () => (enabled ? snapshot : null),
    () => null
  );
  useEffect(() => {
    if (enabled) void refreshSupportCounts();
  }, [enabled]);
  return value;
}

function noopSubscribe() {
  return () => undefined;
}

export function supportTotal(c: SupportCounts | null): number {
  return c ? c.tickets_waiting + c.chats_unread + c.complaints_open : 0;
}
