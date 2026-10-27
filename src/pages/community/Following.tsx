/**
 * «أتابعهم» — /community/following (community UI plan C2.1; IMG_8486). The
 * posts of the makers and stores the viewer follows:
 *
 *   the section header «أتابعهم» over «مجتمع ليفو», with «الأقسام»
 *   the source filter «الكل / الصنّاع / المتاجر» (a radio group in the sand
 *     track, each with its glyph after the word), kept in `?from=` so Back,
 *     a reload and a shared link land on the same half
 *   the feed (feed/FollowingFeed.tsx, a lazy chunk): card v2, or the guest's
 *     sign-in alert, or «لا تتابع أحدًا بعد» with the rails
 *
 * A guest sees no filter: there is nothing of theirs to narrow.
 * Behind CommunityGate (src/App.tsx), as every community page (plan R1).
 */
import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Store, Users, UsersRound } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../components/community/kit/SectionPageHeader';
import { SegmentedTrack } from '../../components/community/kit/controls';
import FeedCardSkeleton from '../../components/community/feed/FeedCardSkeleton';
import { useHubStrings } from '../../components/community/hub/strings';
import { useProjectStrings } from '../../components/community/projects/strings';
import { FEED_FROM, type FeedFrom } from '../../../packages/contracts/src/communityFilters';

// The list arrives after the header and the filter: a lazy chunk, so the
// first paint of the section (and the entry that names it) stays small.
const FollowingFeed = lazy(() => import('../../components/community/feed/FollowingFeed'));

const NEW_PROJECT = '/community/projects/new';
const GLYPH = 'h-5 w-5';

export default function CommunityFollowing() {
  const s = useHubStrings();
  const ps = useProjectStrings();
  const { isAuthenticated } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = params.get('from') ?? '';
  const from: FeedFrom = (FEED_FROM as readonly string[]).includes(raw) ? (raw as FeedFrom) : 'all';
  // A guest goes through sign-in first and comes back to the composer.
  const composerLink = isAuthenticated ? { to: NEW_PROJECT } : { to: '/auth', state: { from: NEW_PROJECT } };

  const choose = (id: string) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (id === 'all') p.delete('from');
        else p.set('from', id);
        return p;
      },
      { replace: true }
    );

  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4" data-community-section="following">
        {/* «أتابعهم» over «مجتمع ليفو», as IMG_8486 draws the header. */}
        <SectionPageHeader title={s.tabs.following} kicker trailing={<SectionsButton />} />
        {isAuthenticated && (
          <SegmentedTrack
            group="following-from"
            label={ps.source}
            value={from}
            onChange={choose}
            dataAttr="data-following-from-option"
            className="lg:max-w-2xl"
            items={[
              { id: 'all', label: ps.from.all, badge: <UsersRound aria-hidden="true" className={GLYPH} strokeWidth={1.75} /> },
              { id: 'makers', label: ps.from.makers, badge: <Users aria-hidden="true" className={GLYPH} strokeWidth={1.75} /> },
              { id: 'stores', label: ps.from.stores, badge: <Store aria-hidden="true" className={GLYPH} strokeWidth={1.75} /> },
            ]}
          />
        )}
        <Suspense fallback={<FeedCardSkeleton />}>
          <FollowingFeed from={from} composerLink={composerLink} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
