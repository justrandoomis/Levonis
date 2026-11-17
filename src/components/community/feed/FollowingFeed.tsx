/**
 * «أتابعهم» — the posts of the makers and stores the viewer follows (community
 * UI plan C2.1; moved here from hub/FollowingPanel.tsx with the section page).
 *
 * A guest is told to sign in (a real link that brings them back here); a
 * member whose whole feed is empty (they follow nobody yet, or nobody they
 * follow has published) is shown «لا تتابع أحدًا بعد» with the makers' and
 * the stores' rails; a segment («الصنّاع», «المتاجر») with no posts says so in
 * one compact line; everybody else gets the feed. The empty states are the
 * server's answer (an empty first page), not a guess from the session graph.
 *
 * A lazy chunk of the section page: the header and the segmented filter
 * paint first.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { EmptyState } from '../../ui/AsyncStates';
import type { FeedFrom } from '../../../../packages/contracts/src/communityFilters';
import { SectionHead } from '../kit/display';
import { CreatorRailSkeleton } from '../hub/parts';
import { CreatorsRail, StoresRail } from '../hub/rails';
import { useHubStrings } from '../hub/strings';
import { useHomeData } from '../hub/useHomeData';
import { useProjectStrings } from '../projects/strings';
import FeedList from './FeedList';

export default function FollowingFeed({ from, composerLink }: { from: FeedFrom; composerLink: { to: string; state?: unknown } }) {
  const s = useHubStrings();
  const ps = useProjectStrings();
  const { user, isAuthenticated } = useAuth();
  const { to } = useSignInPrompt();

  if (!isAuthenticated) {
    return (
      <div data-community-panel="following">
        <div role="status" className="lv-alert lv-alert-info flex flex-wrap items-center justify-between gap-3" data-community-following-guest>
          <p className="text-[13.5px] font-semibold text-text-primary">{s.signInToFollowMakers}</p>
          <Link to={to.pathname} state={to.state} className="lv-button lv-button-primary lv-button-sm">
            {s.signIn}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div data-community-panel="following" data-following-from={from}>
      {/* A reading column on a wide screen: a post is not a banner. */}
      <div className="lg:max-w-2xl">
        <FeedList
          scope="following"
          from={from}
          dock={composerLink}
          empty={from === 'all' ? <NobodyYet viewer={user?.id ?? 'guest'} /> : <EmptyState title={ps.nothingInSegment} compact />}
        />
      </div>
    </div>
  );
}

/** «لا تتابع أحدًا بعد» — and the people to start with. */
function NobodyYet({ viewer }: { viewer: string }) {
  const s = useHubStrings();
  const { data } = useHomeData(viewer);
  return (
    <div className="flex flex-col gap-8" data-community-following-empty>
      <EmptyState title={s.followNobody} description={s.startWithThese} compact />
      {!data && <CreatorRailSkeleton />}
      {data?.creators && data.creators.length > 0 && (
        <section aria-labelledby="community-f-creators">
          <SectionHead id="community-f-creators" title={s.featuredCreators} to="/community/makers" />
          <CreatorsRail creators={data.creators} />
        </section>
      )}
      {data?.merchants && data.merchants.length > 0 && (
        <section aria-labelledby="community-f-stores">
          <SectionHead id="community-f-stores" title={s.featuredStores} to="/community/stores" />
          <StoresRail stores={data.merchants} works={data.works} />
        </section>
      )}
    </div>
  );
}
