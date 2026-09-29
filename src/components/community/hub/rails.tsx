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
