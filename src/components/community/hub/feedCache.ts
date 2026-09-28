/**
 * THE COMMUNITY PAGE'S REMEMBERED PAGES (./useCommunityFeed.ts), apart from
 * the hook that fills them — so a page that only needs to FORGET them (a store
 * page after a follow, «متاجر أتابعها») does not carry the feed's loaders
 * into its own chunk (tests/bundleBudget.test.ts, the storefront's budget).
 */
import type { FeedKind } from './api';

export interface FeedEntry {
  rows: Array<{ id: string }>;
  next: string | null;
  total: number | null;
  at: number;
}

export const FRESH_MS = 2 * 60_000;
export const feedCache = new Map<string, FeedEntry>();

/** Forget one kind's pages (every term), e.g. after a follow changed what they say. */
export function forgetCommunityFeed(kind: FeedKind, exceptKey?: string) {
  for (const key of feedCache.keys()) {
    if (key !== exceptKey && key.split('|')[1] === kind) feedCache.delete(key);
  }
}
