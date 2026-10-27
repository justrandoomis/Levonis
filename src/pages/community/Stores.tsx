/**
 * «المتاجر» — /community/stores (community UI plan C5; IMG_8469). The section
 * page of the stores directory: the section header with its «الأقسام» door,
 * then the directory (directory/StoresDirectory.tsx): the scoped search, the
 * governorate sheet and the FDM, resin and design chips, all in the address,
 * and the store cards with their works. It asks for the viewer merchant
 * standing once, as the home does, so «متجرك» sits under the chips for a
 * merchant.
 *
 * Behind CommunityGate (src/App.tsx), as every community page (plan R1).
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useAuth } from '../../AuthContext';
import { merchantApi, type MerchantMe } from '../../lib/merchant';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../components/community/kit/SectionPageHeader';
import { useHubStrings } from '../../components/community/hub/strings';
import { StoreDirectorySkeleton } from '../../components/community/directory/Skeletons';

// The directory arrives after the header, its own chunk, so the first paint
// of the section (and the entry that names it) stays small.
const StoresDirectory = lazy(() => import('../../components/community/directory/StoresDirectory'));

export default function CommunityStores() {
  const s = useHubStrings();
  const { user } = useAuth();
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
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4" data-community-section="stores">
        <SectionPageHeader title={s.tabs.stores} trailing={<SectionsButton />} />
        <Suspense fallback={<StoreDirectorySkeleton />}>
          <StoresDirectory viewer={userId ?? 'guest'} me={me} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
