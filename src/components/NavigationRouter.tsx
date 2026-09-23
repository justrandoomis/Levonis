import React from 'react';
import { Router, UNSAFE_createBrowserHistory as createBrowserHistory } from 'react-router-dom';
import { useBusy } from '../lib/busy';

/**
 * THE BROWSER ROUTER, WITH ITS WAIT MADE VISIBLE.
 *
 * «عند تحميل الصفحة أو صفحة يجب أن ينتظر ... لا يوجد أنيميشن يظهر في المنتصف
 * أيقونة التحميل يمنع من الضغط المكرر أو الانتقال من صفحة أو الأخرى حتى لا يعمل
 * overload».
 *
 * WHY THE EXISTING FALLBACK NEVER SHOWED. `RouteFallback` holds the `route`
 * busy, and it is the fallback of every lazy route's Suspense boundary — but
 * react-router's `BrowserRouter` applies every location change inside
 * `React.startTransition`. A transition that suspends does NOT show the
 * fallback: React keeps the old page on screen, live and tappable, until the
 * new page's chunk has arrived. So on a slow connection a tap on a page not yet
 * downloaded did nothing visible for seconds, and the customer tapped again,
 * and again — the overload the owner describes. The fallback (and with it the
 * overlay) only ever appeared on a cold boot or a shell switch.
 *
 * WHY NOT SIMPLY TURN THE TRANSITIONS OFF. `useTransitions={false}` would make
 * every navigation urgent, and an urgent update that suspends DOES show the
 * fallback — for every first visit to a lazy page, including one whose chunk
 * was prefetched and is already in memory, because `React.lazy` suspends for
 * at least a microtask on its first render. That is a black flash on the most
 * ordinary tap in the app.
 *
 * SO THIS IS BrowserRouter's OWN SHAPE — the same history, the same listener,
 * the same `<Router>` — with one substitution: the transition is started with
 * `useTransition` instead of the bare `startTransition`, which is the only way
 * React will say whether one is still pending. The old page stays on screen
 * exactly as before; while the new one is not ready, the page is held as a
 * `route` wait, and the overlay covers it after its route delay
 * (`ROUTE_BUSY_DELAY_MS`) — long enough that a navigation that is merely a
 * render, not a download, finishes without ever being announced.
 *
 * `UNSAFE_createBrowserHistory` is the factory BrowserRouter itself calls; the
 * prefix is react-router's way of saying it is not a documented surface, and
 * tests/busyOverlay.test.ts pins that this component still matches the
 * library's own router so an upgrade that changes it is noticed.
 */
export default function NavigationRouter({ children }: { children: React.ReactNode }) {
  const [history] = React.useState(() => createBrowserHistory({ window, v5Compat: true }));
  const [state, setState] = React.useState(() => ({ action: history.action, location: history.location }));
  const [pending, startTransition] = React.useTransition();

  React.useLayoutEffect(
    () =>
      history.listen((update) => {
        startTransition(() => setState({ action: update.action, location: update.location }));
      }),
    [history]
  );

  useBusy(pending, 'route');

  return (
    <Router location={state.location} navigationType={state.action} navigator={history}>
      {children}
    </Router>
  );
}
