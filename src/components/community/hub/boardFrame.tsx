/**
 * «طلبات تناسبك» BEFORE ITS CHUNK (Phase 5d; community UI plan C1): what the
 * page needs of the workshop board without downloading it, its last answer
 * per viewer, the first-paint hint, and the frame it reserves (the own head
 * and skeleton of the board, inert). The rails of makers and stores are
 * ./rails.tsx; the page does not name those in its first chunk.
 */
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { readPageCache } from '../../../lib/pageCache';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { useHubStrings } from './strings';

/**
 * THE WORKSHOP BOARD'S LAST ANSWER, per viewer (hub/BoardRail.tsx). The home
 * paints from its page cache on Back (hub/useHomeData.ts); the rail that leads
 * a merchant's home must too, or it would arrive a moment later and push the
 * issue down. So the rail keeps its last rows in the same module cache, and
 * the page (src/pages/Community.tsx) asks `boardRailRemembered` — without
 * downloading the rail's chunk — whether to mount it before `/api/merchant/me`
 * has answered. Nothing personal outlives the tab: the cache is a Map in
 * module scope (src/lib/pageCache.ts).
 */
export const BOARD_RAIL_CACHE = 'community:board-for-me';

export interface BoardRailMemo<Row> {
  viewer: string;
  rows: Row[];
  total: number | null;
}

export function boardRailMemo<Row>(viewer: string): BoardRailMemo<Row> | null {
  const hit = readPageCache<BoardRailMemo<Row>>(BOARD_RAIL_CACHE);
  return hit && hit.viewer === viewer ? hit : null;
}

/** This viewer's home led with the workshop board a moment ago — mount it again at once. */
export function boardRailRemembered(viewer: string): boolean {
  return boardRailMemo(viewer) !== null;
}

/**
 * DECIDED AT FIRST PAINT (review 2026-09-30). The rail used to mount only once
 * `/api/merchant/me` answered, and its header and skeleton then landed ABOVE
 * an issue already on screen — a layout shift of ~0.2 on every workshop's
 * first view. The device therefore remembers that its signed-in viewer runs
 * a workshop, as a flag under a key derived from the viewer (never the id
 * itself, never anything about the workshop), and the page reserves the
 * rail's frame from the first paint. `me` still decides: an account that
 * turns out to run none clears the flag, and the rail hides itself.
 */
function workshopKey(viewer: string): string {
  let h = 5381;
  for (let i = 0; i < viewer.length; i++) h = ((h << 5) + h + viewer.charCodeAt(i)) | 0;
  return `lv_ws_${(h >>> 0).toString(36)}`;
}

export function workshopHint(viewer: string): boolean {
  if (!viewer) return false;
  try {
    return window.localStorage.getItem(workshopKey(viewer)) === '1';
  } catch {
    return false;
  }
}

export function rememberWorkshop(viewer: string, runsOne: boolean): void {
  if (!viewer) return;
  try {
    if (runsOne) window.localStorage.setItem(workshopKey(viewer), '1');
    else window.localStorage.removeItem(workshopKey(viewer));
  } catch {
    /* no storage: the rail is decided by `me`, as before */
  }
}

/**
 * The head of the rail — the title, its line and «عرض الكل ‹» in gold, as every
 * section of the home heads itself (community UI plan C1) — ONE markup for the
 * rail and for the frame the page reserves before the chunk of the rail arrives,
 * so the swap moves nothing. `all` is the link (the rail) or its inert twin
 * (the frame).
 */
export function BoardRailHead({ all }: { all: React.ReactNode }) {
  const s = useHubStrings();
  return (
    <div className="mb-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id="community-s-board" className="text-ui-lg font-bold text-text-primary">
          {s.requestsForYou}
        </h2>
        <p className="mt-0.5 text-[13px] text-text-muted">{s.board.dek}</p>
      </div>
      {all}
    </div>
  );
}

/** Mirrors two cards of the rail, at a card's own height (the rows replace it without a jump). */
export function BoardSkeleton() {
  return (
    <SkeletonGroup className="-mx-4 flex gap-3 overflow-hidden px-4 pb-1">
      {[0, 1].map((i) => (
        // The rail card's own height (hub/RequestCard.tsx in the rail), inline: no new utility in the shared stylesheet.
        <div key={i} aria-hidden="true" style={{ minHeight: 168 }} className="w-72 shrink-0 space-y-2.5 rounded-xl border border-border-subtle/60 bg-surface p-4">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-14 rounded-full" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** What the page holds for the rail while its chunk loads: the rail's own head and skeleton, inert. */
export function BoardRailFrame() {
  const { t, dir } = useLanguage();
  const Onward = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <section aria-hidden="true" data-community-board-frame="">
      <BoardRailHead
        all={
          <span className="-me-1 inline-flex min-h-11 shrink-0 items-center gap-1 px-1 text-[13px] font-semibold text-gold">
            <span>{t('seeAll')}</span>
            <Onward aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
          </span>
        }
      />
      <BoardSkeleton />
    </section>
  );
}
