/**
 * PRO, PAUSED (migration 0145) — as the ADMIN screens need to know it.
 *
 * The storefront never asks: the server withholds every PRO price while the
 * tier is paused. The admin's product form, quick-price table and price
 * preview DO ask, because they are where PRO prices are typed: while PRO is
 * paused its fields are hidden («إخفاء سعر البرو تحت السعر»), and they come
 * back by themselves when the owner resumes it. PREMIUM's never come back —
 * it carries no discount since 2026-09-27.
 *
 * One request per page load, shared by every caller. Until it answers the
 * answer is "paused": the tier IS paused on the live store, so the fields do
 * not flash into view and out again.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

let cached: Promise<boolean> | null = null;

export function fetchProPaused(): Promise<boolean> {
  cached ??= api
    .get<{ pro_pause?: { paused: boolean } }>('/api/memberships/plans')
    .then((d) => !!d.pro_pause?.paused)
    .catch(() => {
      cached = null; // a failed read is retried by the next caller
      return true;
    });
  return cached;
}

/** True while PRO is paused (and while it is still being asked). */
export function useProPaused(): boolean {
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    let live = true;
    void fetchProPaused().then((v) => {
      if (live) setPaused(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return paused;
}
