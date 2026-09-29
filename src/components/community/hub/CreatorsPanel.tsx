/**
 * «الصنّاع» — the makers' directory: accounts with a public page, newest
 * published project first, searched on the server by the home's `q`
 * (/api/community/creators). Rows in StoreCard's rhythm, each with
 * «متابعة». A lazy tab.
 */
import { Users } from 'lucide-react';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import LoadMore from '../../listing/LoadMore';
import type { CreatorCard as CreatorCardData } from '../social/api';
import { useSocial } from '../social/SocialContext';
import CreatorCard from './CreatorCard';
import { StoreListSkeleton } from './parts';
import { NoResults, SearchLine } from './search';
import { useHubStrings } from './strings';
import { useCommunityFeed } from './useCommunityFeed';

export default function CreatorsPanel({ q, viewer, onClear }: { q: string; viewer: string; onClear: () => void }) {
  const s = useHubStrings();
  const feed = useCommunityFeed<CreatorCardData>('creators', q, viewer);
  const social = useSocial();

  if (feed.error) return <ErrorState error={feed.error} onRetry={feed.reload} />;
  if (!feed.rows) return <StoreListSkeleton />;
  // A maker the viewer blocked a moment ago leaves the list at once.
  const rows = feed.rows.filter((c) => !social.blocked.has(c.id));
  if (rows.length === 0) {
    return q ? <NoResults q={q} onClear={onClear} /> : <EmptyState icon={<Users aria-hidden="true" className="h-6 w-6" />} title={s.noCreators} />;
  }
  const remaining = feed.hasMore ? Math.max(1, (feed.total ?? 0) - feed.rows.length) : 0;
  return (
    <div data-community-panel="creators">
      <SearchLine q={q} total={feed.total} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rows.map((c) => (
          <CreatorCard key={c.id} creator={c} />
        ))}
      </div>
      <LoadMore remaining={remaining} state={feed.more} onMore={feed.loadMore} />
    </div>
  );
}
