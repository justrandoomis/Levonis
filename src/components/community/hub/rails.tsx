/**
 * THE TWO PEOPLE RAILS — makers and stores — shared by «لك» (sections 3 and
 * 4) and by «أتابعهم»'s empty state («ابدأ بهؤلاء»). Each draws only when it
 * has rows: an empty rail is not a feature.
 */
import type { CreatorCard as CreatorCardData } from '../social/api';
import { useSocial } from '../social/SocialContext';
import type { CommunityStore, CommunityWork } from './api';
import CreatorCard from './CreatorCard';
import StoreCard from './StoreCard';
import { Rail } from './parts';
import { useStoreFollow } from './useStoreFollow';
import { readPageCache } from '../../../lib/pageCache';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { useHubStrings } from './strings';

export function CreatorsRail({ creators }: { creators: CreatorCardData[] }) {
  // The viewer's own block, made a moment ago, hides the person here too; the
  // server leaves them out of the next uncached read.
  const social = useSocial();
  return (
    <Rail data-community-creators-rail="">
      {creators.filter((c) => !social.blocked.has(c.id)).map((c) => (
        <CreatorCard key={c.id} creator={c} variant="rail" />
      ))}
    </Rail>
  );
}

/** Three of each shop's works, from the one /works read, by the store's slug or id. */
function worksOf(works: CommunityWork[] | null, m: CommunityStore): CommunityWork[] {
  if (!works) return [];
  return works.filter((w) => w.store && (w.store.id === m.id || (!!m.store_slug && w.store.slug === m.store_slug)));
}

export function StoresRail({ stores, works }: { stores: CommunityStore[]; works: CommunityWork[] | null }) {
  const follow = useStoreFollow();
  return (
    <Rail data-community-stores-rail="">
      {stores.map((raw) => {
        const m = follow.view(raw);
        return <StoreCard key={m.id} store={m} variant="rail" works={worksOf(works, m)} canFollow={follow.canFollow(m)} busy={follow.busy === m.id} onToggleFollow={follow.toggle} />;
      })}
    </Rail>
  );
}

// ----------------------------------------------- «طلبات تناسبك» (Phase 5d)

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
 * The rail's head — kicker, title, dek and «الكل» — ONE markup for the rail and
 * for the frame the page reserves before the rail's chunk arrives, so the
 * swap moves nothing. `all` is the link (the rail) or its inert twin (the frame).
 */
export function BoardRailHead({ all }: { all: React.ReactNode }) {
  const s = useHubStrings();
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
          <span aria-hidden="true" className="h-px w-4 bg-gold" />
          {s.board.kicker}
        </p>
        <h2 id="community-s-board" className="mt-1 text-[22px] font-black leading-tight text-text-primary">
          {s.requestsForYou}
        </h2>
        <p className="mt-0.5 text-[12.5px] text-text-muted">{s.board.dek}</p>
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
        <div key={i} aria-hidden="true" style={{ minHeight: 168 }} className="w-72 shrink-0 space-y-2.5 rounded-2xl border border-border-subtle/60 bg-surface p-4">
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
  const s = useHubStrings();
  return (
    <section aria-hidden="true" data-community-board-frame="">
      <BoardRailHead all={<span className="-me-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-text-secondary">{s.all}</span>} />
      <BoardSkeleton />
    </section>
  );
}
