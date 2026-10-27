/**
 * «الصنّاع» — /community/makers (community UI plan C5; IMG_8476). The section
 * page of the makers directory: the section header with its «الأقسام» door,
 * then the directory (directory/MakersDirectory.tsx): the scoped search, the
 * filter sheet (order, has a store, approved provider), «صنّاع مميزون» and
 * the maker cards with their works.
 *
 * Behind CommunityGate (src/App.tsx), as every community page (plan R1).
 */
import { Suspense, lazy } from 'react';
import { useAuth } from '../../AuthContext';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../components/community/kit/SectionPageHeader';
import { useHubStrings } from '../../components/community/hub/strings';
import { MakerDirectorySkeleton } from '../../components/community/directory/Skeletons';

// The directory arrives after the header, its own chunk, so the first paint
// of the section (and the entry that names it) stays small.
const MakersDirectory = lazy(() => import('../../components/community/directory/MakersDirectory'));

export default function CommunityMakers() {
  const s = useHubStrings();
  const { user } = useAuth();
  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4" data-community-section="makers">
        <SectionPageHeader title={s.tabs.creators} trailing={<SectionsButton />} />
        <Suspense fallback={<MakerDirectorySkeleton />}>
          <MakersDirectory viewer={user?.id ?? 'guest'} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
