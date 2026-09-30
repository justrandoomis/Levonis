/**
 * «طلبات تناسبك» — THE WORKSHOP'S OWN BOARD, LEADING A MERCHANT'S HOME
 * (Phase 5d, docs/COMMUNITY_ECOSYSTEM.md §9.5: GET /api/community/requests
 * ?for=me). The open requests the eligibility engine marked eligible for THIS
 * workshop at their current revision — never the merchant's own — newest
 * first, as a rail of the very card the requests tab draws (./RequestCard),
 * with «الكل» to the whole board (which opens on «مناسب لي» for a workshop).
 *
 * Only for a signed-in merchant with a store (src/pages/Community.tsx mounts
 * it, and it hides itself the moment /api/merchant/me says there is no
 * workshop). An empty board says so in one sentence and offers the request
 * preferences; a read that failed hides the rail, as every section of the
 * issue does. The last answer is kept per viewer (./rails.tsx) so Back paints
 * it at once instead of pushing the issue down a moment later.
 *
 * A lazy chunk: a guest or a customer never downloads it.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MerchantMe } from '../../../lib/merchant';
import { merchantHref } from '../../../lib/merchantRoutes';
import { dropPageCache, writePageCache } from '../../../lib/pageCache';
import { ArrowGlyph } from '../../home/v2/SectionHead';
import { offersV2Api, type BoardForMeRow } from '../requests/api';
import RequestCard from './RequestCard';
import type { CommunityRequest } from './api';
import { Rail, Reveal } from './parts';
import { BOARD_RAIL_CACHE, BoardRailHead, BoardSkeleton, boardRailMemo, rememberWorkshop, type BoardRailMemo } from './rails';
import { useHubStrings } from './strings';

/** A rail, not a directory: the first page's newest few; «الكل» opens the whole board. */
export const BOARD_RAIL_SIZE = 6;
/** Where «الكل» goes: the board, which a workshop opens on «مناسب لي». */
export const BOARD_ALL_PATH = '/requests';
/** Where an empty board sends a workshop that expected work: its request preferences. */
export const BOARD_PREFS_PATH = `${merchantHref.printers()}#preferences`;

/** A `?for=me` row as the board's card reads it: the same public fields, `category` absent rather than null. */
export function boardCard(r: BoardForMeRow): CommunityRequest {
  return { ...r, category: r.category ?? undefined };
}

export default function BoardRail({ viewer, me }: { viewer: string; me: MerchantMe | null }) {
  const s = useHubStrings();
  const [memo, setMemo] = useState<BoardRailMemo<BoardForMeRow> | null>(() => boardRailMemo<BoardForMeRow>(viewer));
  const [failed, setFailed] = useState(false);
  const merchant = !!me?.store;
  const notWorkshop = !!me && !me.store;

  useEffect(() => {
    if (!merchant) return;
    let alive = true;
    offersV2Api
      .boardForMe('', BOARD_RAIL_SIZE)
      .then((d) => {
        if (!alive) return;
        const next: BoardRailMemo<BoardForMeRow> = { viewer, rows: Array.isArray(d.requests) ? d.requests : [], total: typeof d.total === 'number' ? d.total : null };
        writePageCache(BOARD_RAIL_CACHE, next);
        setMemo(next);
        setFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        dropPageCache(BOARD_RAIL_CACHE);
        setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [merchant, viewer]);

  // An account that turns out to run no workshop: nothing remembered here was theirs.
  useEffect(() => {
    if (notWorkshop) dropPageCache(BOARD_RAIL_CACHE);
    // The first-paint hint follows the answer (./rails.tsx `workshopHint`).
    if (me) rememberWorkshop(viewer, !!me.store);
  }, [notWorkshop, me, viewer]);

  if (notWorkshop || failed) return null;

  return (
    <Reveal labelledBy="community-s-board" data-community-board-rail="">
      <BoardRailHead
        all={
          <Link
            to={BOARD_ALL_PATH}
            data-community-board-all
            className="-me-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span>{s.all}</span>
            <ArrowGlyph />
          </Link>
        }
      />
      {memo === null ? (
        <BoardSkeleton />
      ) : memo.rows.length === 0 ? (
        <div className="rounded-2xl border border-border-subtle/60 bg-surface px-4 py-3" data-community-board-empty>
          <p className="text-[13px] leading-relaxed text-text-secondary">{s.board.empty}</p>
          <Link
            to={BOARD_PREFS_PATH}
            className="inline-flex min-h-11 items-center rounded-lg text-[12.5px] font-semibold text-sage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {s.board.prefs}
          </Link>
        </div>
      ) : (
        <Rail data-community-board-cards="">
          {memo.rows.map((r) => (
            // A grid cell, so the card's link fills the rail's height and every card ends on the same line —
            // and a positioned one: the card's screen-reader words (`sr-only`, absolutely placed) must be
            // clipped by the rail, not placed against the page, or a card far along the rail widens the page.
            <div key={r.id} className="relative grid w-72 shrink-0 snap-start">
              <RequestCard request={boardCard(r)} />
            </div>
          ))}
        </Rail>
      )}
    </Reveal>
  );
}
