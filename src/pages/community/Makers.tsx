/**
 * «الصنّاع» — /community/makers (community UI plan B4, §3). The section page
 * of the makers directory: the section header, then the list the home tab
 * shows today (hub/CreatorsPanel.tsx), searched on the server by `?q=`. C5
 * rebuilds the directory (IMG_8476).
 *
 * Behind CommunityGate (src/App.tsx), as every community page (plan R1).
 */
import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../components/community/kit/SectionPageHeader';
import { useHubStrings } from '../../components/community/hub/strings';
import { StoreListSkeleton } from '../../components/community/hub/parts';

// The list arrives after the header: a lazy chunk the home tab shares, so the
// first paint of the section (and the entry that names it) stays small.
const CreatorsPanel = lazy(() => import('../../components/community/hub/CreatorsPanel'));

export default function CommunityMakers() {
  const s = useHubStrings();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  // The term a link hands over (`?q=`), as the home reads it; «مسح» drops it without a history entry.
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  const clear = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('q');
        return p;
      },
      { replace: true }
    );
  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4" data-community-section="makers">
        <SectionPageHeader title={s.tabs.creators} trailing={<SectionsButton />} />
        <Suspense fallback={<StoreListSkeleton />}>
          <CreatorsPanel q={q} viewer={user?.id ?? 'guest'} onClear={clear} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
