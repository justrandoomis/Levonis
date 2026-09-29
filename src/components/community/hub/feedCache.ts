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

/**
 * THE ISSUE'S GENERATION (hub/useHomeData.ts memoises «لك»'s rails for two
 * minutes). Bumping it makes the next visit read again. It lives here, apart
 * from the hook, so a button in another chunk (a follow on a creator page)
 * can forget the home without carrying its loaders.
 */
let homeGen = 0;
export const homeGeneration = () => homeGen;
export function forgetHome() {
  homeGen += 1;
}

/** After a follow or an unfollow: «أتابعهم» and the makers' directory now say something else. */
export function forgetAfterFollow() {
  forgetCommunityFeed('feed:following');
  forgetCommunityFeed('creators');
}

/**
 * After a block or a mute: every list that might still carry the person —
 * both feeds, the directory and the issue's rails — is forgotten, so Back does
 * not bring them back for two minutes. The rows already on screen are hidden
 * by the lists themselves from the session graph (SocialContext).
 */
export function forgetAfterBlock() {
  forgetCommunityFeed('feed:foryou');
  forgetCommunityFeed('feed:following');
  forgetCommunityFeed('creators');
  forgetHome();
}
