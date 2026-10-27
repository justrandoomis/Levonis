/**
 * «أتابعهم» — /community/following (community UI plan B4, §3). The section
 * page of the posts of the makers and stores the viewer follows: the section
 * header, then the list the home tab shows today (hub/FollowingPanel.tsx). C2
 * rebuilds the feed (IMG_8486); the address and the header land first, so
 * the sections menu and the home chips have somewhere real to go.
 *
 * Behind CommunityGate (src/App.tsx), as every community page (plan R1).
 */
import { Suspense, lazy } from 'react';
import { useAuth } from '../../AuthContext';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../components/community/kit/SectionPageHeader';
import { PostSkeleton } from '../../components/community/hub/parts';
import { useHubStrings } from '../../components/community/hub/strings';

// The list arrives after the header: a lazy chunk the home tab shares, so the
// first paint of the section (and the entry that names it) stays small.
const FollowingPanel = lazy(() => import('../../components/community/hub/FollowingPanel'));

const NEW_PROJECT = '/community/projects/new';

export default function CommunityFollowing() {
  const s = useHubStrings();
  const { user, isAuthenticated } = useAuth();
  // A guest goes through sign-in first and comes back to the composer.
  const composerLink = isAuthenticated ? { to: NEW_PROJECT } : { to: '/auth', state: { from: NEW_PROJECT } };
  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4" data-community-section="following">
        {/* «أتابعهم» over «مجتمع ليفو», as IMG_8486 draws the header. */}
        <SectionPageHeader title={s.tabs.following} kicker trailing={<SectionsButton />} />
        <Suspense fallback={<PostSkeleton />}>
          <FollowingPanel viewer={user?.id ?? 'guest'} composerLink={composerLink} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
