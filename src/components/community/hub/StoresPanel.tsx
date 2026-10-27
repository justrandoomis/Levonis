/**
 * «المتاجر» — the stores directory, a page at a time from
 * /api/community/merchants, searched on the server by the page `q`. Moved
 * out of src/pages/Community.tsx (community UI plan B4). The home tab of
 * today renders it; the section page /community/stores renders the rebuilt
 * directory (directory/StoresDirectory.tsx, community UI plan C5), so this
 * file retires with the tab when the home lane (C1) sends `?tab=stores` to
 * that page.
 *
 * Above the list, the viewer own place in the directory (directory/YourStore)
 * and the works rail. «متابعة» answers at once and is put back if the server says
 * no; a guest is asked to sign in and brought back (DECISIONS row 89).
 */
import React, { useState } from 'react';
import { Store } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { ApiError } from '../../../lib/api';
import type { MerchantMe } from '../../../lib/merchant';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { toast } from '../../ui/Toast';
import LoadMore from '../../listing/LoadMore';
import YourStore from '../directory/YourStore';
import StoreCard from './StoreCard';
import WorksRail from './WorksRail';
import { StoreListSkeleton } from './parts';
import { NoResults, SearchLine } from './search';
import { useHubStrings } from './strings';
import { useCommunityFeed, type CommunityFeed } from './useCommunityFeed';
import { forgetHome } from './useHomeData';
import { communityHubApi, type CommunityStore } from './api';

/** How many «عرض المزيد» can honestly promise: the first page total, less what is shown. */
function remaining<T extends { id: string }>(feed: CommunityFeed<T>): number {
  if (!feed.hasMore || !feed.rows) return 0;
  return Math.max(1, (feed.total ?? 0) - feed.rows.length);
}

export default function StoresPanel({ q, viewer, me, onClear }: { q: string; viewer: string; me: MerchantMe | null; onClear: () => void }) {
  const s = useHubStrings();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const feed = useCommunityFeed<CommunityStore>('merchants', q, viewer);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * «متابعة» answers at once and is put back if the server says no. A guest is
   * asked to sign in and brought back here; a follow is never sent that is sure
   * to fail (docs/DECISIONS.md row 89).
   */
  const toggleFollow = async (m: CommunityStore) => {
    if (!isAuthenticated) {
      signIn();
      return;
    }
    if (busy) return;
    const was = !!m.following;
    const set = (following: boolean, followers: number) =>
      feed.patch((rows) => rows.map((r) => (r.id === m.id ? { ...r, following, followers } : r)));
    setBusy(m.id);
    set(!was, Math.max(0, (m.followers ?? 0) + (was ? -1 : 1)));
    try {
      await (was ? communityHubApi.unfollow(m.id) : communityHubApi.follow(m.id));
      feed.forgetOthers();
      forgetHome();
    } catch (e) {
      set(was, m.followers ?? 0);
      if (e instanceof ApiError && e.status === 401) signIn();
      else toast.error(s.followFailed);
    } finally {
      setBusy(null);
    }
  };

  let body: React.ReactNode;
  if (feed.error) body = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) body = <StoreListSkeleton />;
  else if (feed.rows.length === 0) {
    body = q ? <NoResults q={q} onClear={onClear} /> : <EmptyState icon={<Store aria-hidden="true" className="h-6 w-6" />} title={s.noStores} />;
  } else {
    body = (
      <>
        <SearchLine q={q} total={feed.total} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {feed.rows.map((m) => (
            <StoreCard key={m.id} store={m} canFollow={m.user_id !== user?.id} busy={busy === m.id} onToggleFollow={toggleFollow} />
          ))}
        </div>
        <LoadMore remaining={remaining(feed)} state={feed.more} onMore={feed.loadMore} />
      </>
    );
  }

  return (
    <div data-community-panel="merchants">
      {!q && <WorksRail />}
      {!q && <YourStore me={me} />}
      {body}
    </div>
  );
}
