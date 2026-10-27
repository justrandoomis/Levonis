/**
 * «المتاجر» — /community/stores (community UI plan B4, §3). The section page
 * of the stores directory: the section header, then the list the home tab
 * shows today (hub/StoresPanel.tsx, moved out of the home for this), searched
 * on the server by `?q=`. It asks for the viewer merchant standing once, as
 * the home does, so «متجرك» leads the list for a merchant. C5 rebuilds the
 * directory (IMG_8469).
 *
 * Behind CommunityGate (src/App.tsx), as every community page (plan R1).
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { merchantApi, type MerchantMe } from '../../lib/merchant';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../components/community/kit/SectionPageHeader';
import { useHubStrings } from '../../components/community/hub/strings';
import { StoreListSkeleton } from '../../components/community/hub/parts';

// The list arrives after the header: a lazy chunk the home tab shares, so the
// first paint of the section (and the entry that names it) stays small.
const StoresPanel = lazy(() => import('../../components/community/hub/StoresPanel'));

export default function CommunityStores() {
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
  // Which merchant this viewer is, for «متجرك»: asked only with a session, once per account.
  const userId = user?.id ?? null;
  const [me, setMe] = useState<MerchantMe | null>(null);
  useEffect(() => {
    if (!userId) {
      setMe(null);
      return;
    }
    let alive = true;
    merchantApi
      .me()
      .then((d) => alive && setMe(d))
      .catch(() => alive && setMe(null));
    return () => {
      alive = false;
    };
  }, [userId]);
  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4" data-community-section="stores">
        <SectionPageHeader title={s.tabs.stores} trailing={<SectionsButton />} />
        <Suspense fallback={<StoreListSkeleton />}>
          <StoresPanel q={q} viewer={userId ?? 'guest'} me={me} onClear={clear} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
