/**
 * «منتجات المجتمع» — the home own list of community products
 * (`/community?list=products`, and the old `?tab=products`), searched on the
 * server by `?q=`. A chunk of its own: the home first chunk does not name it.
 */
import { Box } from 'lucide-react';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { ProductGridSkeleton } from '../../ui/Skeleton';
import LoadMore from '../../listing/LoadMore';
import ProductTile from './ProductTile';
import { NoResults, SearchLine } from './search';
import { useHubStrings } from './strings';
import { useCommunityFeed, type CommunityFeed } from './useCommunityFeed';
import type { CommunityProduct } from './api';

export const PRODUCT_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

/** How many «عرض المزيد» can honestly promise: the first page's total, less what is shown. */
function remaining(feed: CommunityFeed<{ id: string }>): number {
  if (!feed.hasMore || !feed.rows) return 0;
  return Math.max(1, (feed.total ?? 0) - feed.rows.length);
}

export default function ProductsPanel({ q, viewer, onClear }: { q: string; viewer: string; onClear: () => void }) {
  const s = useHubStrings();
  const feed = useCommunityFeed<CommunityProduct>('products', q, viewer);
  if (feed.error) return <ErrorState error={feed.error} onRetry={feed.reload} />;
  if (!feed.rows) return <ProductGridSkeleton count={8} className={PRODUCT_GRID} />;
  if (feed.rows.length === 0) {
    return q ? (
      <NoResults q={q} onClear={onClear} />
    ) : (
      <EmptyState icon={<Box aria-hidden="true" className="h-6 w-6" />} title={s.noProducts} description={s.noProductsHint} />
    );
  }
  return (
    <div data-community-panel="products">
      {!q && <h2 className="mb-3 text-[22px] font-black leading-tight text-text-primary">{s.communityProducts}</h2>}
      <SearchLine q={q} total={feed.total} />
      <div className={PRODUCT_GRID}>
        {feed.rows.map((p, i) => (
          <ProductTile key={p.id} product={p} eager={i < 4} />
        ))}
      </div>
      <LoadMore remaining={remaining(feed)} state={feed.more} onMore={feed.loadMore} />
    </div>
  );
}
