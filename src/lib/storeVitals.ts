/**
 * THE STORE PAGE'S SPEED REPORTER — «سرعة متجري» (merchant platform v2 §4.5
 * S1). About a kilobyte, loaded by the store pages with a dynamic import
 * after first paint, never in the storefront's static closure.
 *
 * WHAT IT MEASURES, with the browser's own PerformanceObserver: the Largest
 * Contentful Paint, the Cumulative Layout Shift (session windows: shifts less
 * than a second apart and within five seconds add up; the worst window
 * counts), the Interaction to Next Paint (the slowest interaction, each
 * interaction id once, events of 40 ms and over) and the Time to First Byte
 * of the navigation.
 *
 * WHAT LEAVES THE BROWSER: ONE beacon per page load, when the page is hidden
 * or left — `{ store, device, lcp_ms, cls_x1000, inp_ms, ttfb_ms }`, each
 * reading rounded and clamped, absent when not measured. No id, no path, no
 * referrer. With Do Not Track or Global Privacy Control on, nothing is
 * observed or sent (the same opt-out as src/lib/storeBeacon.ts). The Worker
 * (POST /api/storefront/events/vitals) keeps only a daily bucket per vital
 * and counts a visitor once per day per device; a failure is silent.
 */

export type VitalsDevice = 'phone' | 'desktop';

/** The ingest — on the beacon router, so it rides the beacon's gateway rule. */
export const VITALS_PATH = '/api/storefront/events/vitals';

const CLAMP = { lcp_ms: 60_000, cls_x1000: 5_000, inp_ms: 10_000, ttfb_ms: 30_000 } as const;

let started = false;

function optedOut(): boolean {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  return n.doNotTrack === '1' || n.globalPrivacyControl === true;
}

/**
 * Starts measuring for the page load that showed `store`; returns a stop
 * function. Runs once per page load (LCP and TTFB belong to the navigation,
 * so a later route change inside the shop keeps the first store): a second
 * call is a no-op.
 */
export function startStoreVitals(store: string | null | undefined): () => void {
  const noop = () => {};
  if (!store || started) return noop;
  try {
    if (optedOut() || typeof PerformanceObserver === 'undefined') return noop;
  } catch {
    return noop;
  }
  started = true;

  let lcp: number | undefined;
  let cls = 0;
  let win = 0;
  let winStart = 0;
  let winLast = 0;
  const interactions = new Map<number, number>();
  const observers: PerformanceObserver[] = [];

  /**
   * ONLY WHAT THIS BROWSER CAN MEASURE (review 2026-09-30). WebKit (every iOS
   * browser) and Firefox ignore `layout-shift` SILENTLY — no throw — so a
   * CLS that stayed at its initial 0 was sent as a perfect reading and pulled
   * the store's word towards «جيد». An entry type is observed, and its
   * vital sent, only when `supportedEntryTypes` names it; else the vital is
   * absent and adds to no bucket (the Worker's own rule for a missing one).
   */
  const supported = new Set<string>((PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes ?? []);
  const observe = (type: string, onEntries: (entries: PerformanceEntry[]) => void, extra?: Record<string, unknown>): boolean => {
    if (!supported.has(type)) return false;
    try {
      const po = new PerformanceObserver((list) => onEntries(list.getEntries()));
      po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(po);
      return true;
    } catch {
      /* the browser does not know this entry type */
      return false;
    }
  };
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });
  const measuresCls = observe('layout-shift', (entries) => {
    for (const e of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (e.hadRecentInput) continue;
      if (win && e.startTime - winLast < 1000 && e.startTime - winStart < 5000) win += e.value;
      else {
        win = e.value;
        winStart = e.startTime;
      }
      winLast = e.startTime;
      if (win > cls) cls = win;
    }
  });
  const onInteraction = (entries: PerformanceEntry[]) => {
    for (const e of entries as Array<PerformanceEntry & { interactionId?: number }>) {
      const id = e.interactionId;
      if (!id) continue;
      interactions.set(id, Math.max(interactions.get(id) ?? 0, e.duration));
    }
  };
  observe('event', onInteraction, { durationThreshold: 40 });
  observe('first-input', onInteraction);

  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    for (const po of observers) {
      try {
        po.takeRecords?.();
        po.disconnect();
      } catch {
        /* already gone */
      }
    }
    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const body: Record<string, unknown> = { store, device: innerWidth < 768 ? 'phone' : 'desktop' };
      let any = false;
      const put = (k: keyof typeof CLAMP, v: number | undefined) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return;
        body[k] = Math.min(Math.round(v), CLAMP[k]);
        any = true;
      };
      put('lcp_ms', lcp);
      put('cls_x1000', measuresCls ? cls * 1000 : undefined);
      put('inp_ms', interactions.size ? Math.max(...interactions.values()) : undefined);
      put('ttfb_ms', nav ? nav.responseStart : undefined);
      if (!any) return;
      const raw = JSON.stringify(body);
      // A string body is text/plain: no preflight, and the Worker parses it.
      if (navigator.sendBeacon?.(VITALS_PATH, raw)) return;
      void fetch(VITALS_PATH, { method: 'POST', body: raw, keepalive: true, credentials: 'same-origin' }).catch(() => {});
    } catch {
      /* never on the shopper's path */
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') send();
  };
  addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', send);
  return () => {
    removeEventListener('visibilitychange', onVisibility);
    removeEventListener('pagehide', send);
  };
}
