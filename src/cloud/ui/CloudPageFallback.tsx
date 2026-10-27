/**
 * WHILE A CLOUD SCREEN'S CODE IS ON ITS WAY — and the shape a screen shows
 * while its first answer is.
 *
 * `CloudPageFallback` is a lazy screen's Suspense fallback, with the contract
 * of the shop's own (src/App.tsx `RouteFallback`): it holds the `route` busy
 * wait, so the house overlay (src/components/ui/AppBusy.tsx) covers a wait
 * that lasts, and it tells the shell to reveal the screen the moment its code
 * lands (src/lib/routeReveal.ts) rather than after React's throttle.
 *
 * `CloudPageSkeleton` is only the drawing — a title and two cards in skeleton
 * bars, never a number — for a screen whose code is here and whose data is
 * not yet: no overlay over a page that is merely reading.
 */
import React from 'react';
import { Skeleton } from '../../components/ui/Skeleton';
import { useBusy } from '../../lib/busy';
import { routeReveal } from '../../lib/routeReveal';

export function CloudPageSkeleton({ className = '' }: { className?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className={`space-y-4 ${className}`}>
      <Skeleton className="h-7 w-48 rounded-md" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="h-32 rounded-xl" />
      <span className="sr-only">…</span>
    </div>
  );
}

export function CloudPageFallback() {
  useBusy(true, 'route');
  React.useLayoutEffect(() => routeReveal.hold(), []);
  return <CloudPageSkeleton />;
}
