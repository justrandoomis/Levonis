/**
 * «أتابعهم» — the posts of the makers and stores the viewer follows.
 *
 * A guest is told to sign in (a real link that brings them back here);
 * a member whose feed is empty — they follow nobody yet, or nobody they
 * follow has published — is shown «ابدأ بهؤلاء» with the makers' and the
 * stores' rails; everybody else gets the feed. The empty state is the
 * server's answer (an empty first page), not a guess from the session graph.
 */
import React, { Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { EmptyState } from '../../ui/AsyncStates';
import type { DoorLink } from './QuickActions';
import { CreatorRailSkeleton, PostSkeleton, SectionHead } from './parts';
import { CreatorsRail, StoresRail } from './rails';
import { useHubStrings } from './strings';
import { useHomeData } from './useHomeData';

const FeedList = React.lazy(() => import('../feed/FeedList'));

export default function FollowingPanel({ viewer, composerLink }: { viewer: string; composerLink: DoorLink }) {
  const s = useHubStrings();
  const { isAuthenticated } = useAuth();
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
    <div data-community-panel="following">
      <Suspense fallback={<PostSkeleton />}>
        {/* A reading column on a wide screen: a post is not a banner. */}
        <div className="lg:max-w-2xl">
          <FeedList scope="following" dock={composerLink} empty={<NobodyYet viewer={viewer} />} />
        </div>
      </Suspense>
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
          <SectionHead index={1} id="community-f-creators" title={s.featuredCreators} to="/community?tab=creators" />
          <CreatorsRail creators={data.creators} />
        </section>
      )}
      {data?.merchants && data.merchants.length > 0 && (
        <section aria-labelledby="community-f-stores">
          <SectionHead index={2} id="community-f-stores" title={s.featuredStores} to="/community?tab=stores" />
          <StoresRail stores={data.merchants} works={data.works} />
        </section>
      )}
    </div>
  );
}
