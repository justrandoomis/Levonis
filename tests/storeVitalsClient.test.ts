/**
 * THE STORE PAGE'S SPEED REPORTER SENDS ONLY WHAT ITS BROWSER MEASURES
 * (src/lib/storeVitals.ts; review 2026-09-30). WebKit and Firefox ignore a
 * `layout-shift` observer silently, so a CLS that never moved from 0 used to
 * be sent as a perfect reading and counted «جيد». A vital whose entry type
 * the browser does not list in `PerformanceObserver.supportedEntryTypes` is
 * absent from the beacon — and the Worker adds an absent vital to no bucket.
 *
 * Run: node --import tsx --test tests/storeVitalsClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Listener = () => void;

/** A browser as far as the reporter can see one; `types` is what its PerformanceObserver supports. */
function browser(types: readonly string[], shifts: number[] = []) {
  const listeners = new Map<string, Listener>();
  const beacons: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.addEventListener = (t: string, f: Listener) => listeners.set(t, f);
  g.removeEventListener = () => {};
  g.innerWidth = 375;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { doNotTrack: '0', sendBeacon: (_path: string, body: string) => (beacons.push(body), true) },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  (performance as unknown as { getEntriesByType: (t: string) => unknown[] }).getEntriesByType = (t: string) => (t === 'navigation' ? [{ responseStart: 420 }] : []);
  class FakeObserver {
    static supportedEntryTypes = types;
    constructor(private readonly cb: (list: { getEntries: () => unknown[] }) => void) {}
    observe(o: { type: string }) {
      // A browser that does not know the type ignores it SILENTLY — no throw, no entries (WebKit, Firefox).
      if (!types.includes(o.type)) return;
      if (o.type === 'largest-contentful-paint') this.cb({ getEntries: () => [{ startTime: 1800 }] });
      if (o.type === 'layout-shift') this.cb({ getEntries: () => shifts.map((value, i) => ({ value, hadRecentInput: false, startTime: 100 + i * 10 })) });
    }
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  g.PerformanceObserver = FakeObserver;
  return { listeners, beacons };
}

test('a browser that cannot measure layout shifts sends no CLS — never a perfect 0 it did not measure', async () => {
  const b = browser(['largest-contentful-paint', 'event', 'first-input']);
  const { startStoreVitals } = await import(new URL('../src/lib/storeVitals.ts?webkit', import.meta.url).href);
  startStoreVitals('s1');
  b.listeners.get('pagehide')?.();
  const body = JSON.parse(b.beacons[0]) as Record<string, unknown>;
  assert.equal(body.cls_x1000, undefined, 'absent, so it adds to no bucket');
  assert.deepEqual([body.store, body.device, body.lcp_ms, body.ttfb_ms], ['s1', 'phone', 1800, 420]);
});

test('a browser that measures them sends the worst window, and a page with no shift is a measured 0', async () => {
  const b = browser(['largest-contentful-paint', 'layout-shift', 'event', 'first-input'], [0.05, 0.02]);
  const { startStoreVitals } = await import(new URL('../src/lib/storeVitals.ts?chromium', import.meta.url).href);
  startStoreVitals('s1');
  b.listeners.get('pagehide')?.();
  assert.equal((JSON.parse(b.beacons[0]) as Record<string, unknown>).cls_x1000, 70);
  const still = browser(['layout-shift']);
  const again = await import(new URL('../src/lib/storeVitals.ts?chromium-still', import.meta.url).href);
  again.startStoreVitals('s2');
  still.listeners.get('pagehide')?.();
  assert.equal((JSON.parse(still.beacons[0]) as Record<string, unknown>).cls_x1000, 0, 'measured, and nothing moved');
});

test('both store pages share ONE scheduler: Save-Data skips it, it waits for load and idle, a page gone before idle starts nothing', async () => {
  // Review 2026-09-30: the same effect was written into Storefront.tsx and StorefrontProduct.tsx (~270 B of the 47 KB budget, twice).
  const b = browser(['largest-contentful-paint', 'layout-shift']);
  const idle: Array<() => void> = [];
  const onWindow = new Map<string, Listener>();
  const g = globalThis as Record<string, unknown>;
  g.window = {
    requestIdleCallback: (f: () => void) => (idle.push(f), idle.length),
    addEventListener: (t: string, f: Listener) => onWindow.set(t, f),
    removeEventListener: (t: string) => onWindow.delete(t),
    matchMedia: () => ({ matches: false }),
  };
  const nav = navigator as unknown as Record<string, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  const { scheduleStoreVitals } = await import('../src/lib/storeBeacon');

  nav.connection = { saveData: true };
  doc.readyState = 'complete';
  scheduleStoreVitals('s1')();
  assert.equal(idle.length, 0, 'Save-Data: the reporter is never fetched');
  nav.connection = undefined;
  scheduleStoreVitals(null)();
  assert.equal(idle.length, 0, 'no store, nothing to measure');

  // Loaded already: straight to the idle callback. The page leaves before it fires — nothing starts.
  scheduleStoreVitals('s1')();
  assert.equal(idle.length, 1);
  idle[0]();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.listeners.has('pagehide'), false, 'a page gone before idle started the reporter');

  // Still loading: waits for `load`, then idle, then starts the reporter once.
  doc.readyState = 'loading';
  scheduleStoreVitals('s1');
  assert.equal(idle.length, 1, 'nothing before load');
  onWindow.get('load')?.();
  assert.equal(idle.length, 2);
  idle[1]();
  for (let i = 0; i < 50 && !b.listeners.has('pagehide'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.listeners.has('pagehide'), true, 'the reporter did not start after load + idle');
  delete g.window;
});
